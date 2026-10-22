"""Local multi-format import. GPL converters are separate executable programs."""
import base64
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import unicodedata
from urllib.parse import unquote, urlsplit

from epub_import import (ASSET_RE, BLOCK_TAGS, EpubParser, IMPORT_LOCK, ImportFailure,
                         MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_EPUB_BYTES,
                         MAX_EXPANDED_BYTES, MAX_TEXT_CHARS, MAX_UNITS,
                         SKIP_TAGS, clean, fail, read_book, safe_library, safe_xml, tag)

FORMATS = {
    'epub': 'application/epub+zip', 'pdf': 'application/pdf', 'txt': 'text/plain',
    'mobi': 'application/x-mobipocket-ebook', 'azw3': 'application/vnd.amazon.ebook',
    'fb2': 'application/x-fictionbook+xml',
}
CONVERSION_TIMEOUT = 60
MAX_PDF_PAGES = 3000
MAX_WORKER_RSS_KIB = 768 * 1024
SETUP_COMMAND = 'python3 scripts/setup_importers.py --ensure'


def mobi_executable():
    name = 'mobiunpack.exe' if os.name == 'nt' else 'mobiunpack'
    candidate = Path(sys.executable).parent / name
    return str(candidate) if candidate.is_file() else None


def capabilities():
    pdf = importlib.util.find_spec('pypdf') is not None
    mobi = mobi_executable() is not None
    return {'maxBytes': MAX_EPUB_BYTES, 'setupCommand': SETUP_COMMAND, 'formats': [
        {'extension': extension, 'label': extension.upper(), 'mimeType': mime,
         'available': pdf if extension == 'pdf' else mobi if extension in ('mobi', 'azw3') else True}
        for extension, mime in FORMATS.items()]}


def source_name(filename):
    name = str(filename or '').replace('\\', '/').split('/')[-1]
    return ''.join(c for c in name if unicodedata.category(c)[0] != 'C')[:500]


def input_format(raw, filename='', content_type='application/epub+zip'):
    name = source_name(filename)
    extension = Path(name).suffix.lower().lstrip('.')
    if not extension and content_type.split(';', 1)[0].strip().lower() == FORMATS['epub']:
        extension = 'epub'  # Compatibility with the original raw EPUB endpoint.
    if extension not in FORMATS:
        fail('unsupported_format', '支持 EPUB、PDF、TXT、MOBI、AZW3 和 FB2；不支持 KFX、AZW、DOCX 或受 DRM 保护的书籍。', 415)
    if extension == 'epub' and not raw.startswith(b'PK'):
        fail('invalid_epub', '这不是有效的 EPUB 文件。')
    if extension == 'pdf' and b'%PDF-' not in raw[:1024]:
        fail('format_mismatch', '文件内容与扩展名不符，请选择原始电子书文件。')
    if extension in ('mobi', 'azw3'):
        validate_mobi(raw)
    if extension == 'txt' and (raw.startswith((b'PK', b'%PDF-', b'\x89PNG')) or raw[60:68] == b'BOOKMOBI'):
        fail('format_mismatch', '文件内容与扩展名不符，请选择原始电子书文件。')
    return extension


def validate_mobi(raw):
    # Validate the Palm database boundary and the encryption flag before an
    # external converter sees the file; no DRM removal is attempted.
    if len(raw) < 96 or raw[60:68] != b'BOOKMOBI':
        fail('invalid_mobi', '文件不是支持的 MOBI/AZW3 电子书。')
    count = struct.unpack_from('>H', raw, 76)[0]
    if count < 2 or count > MAX_ENTRIES or 78 + count * 8 > len(raw):
        fail('invalid_mobi', 'MOBI/AZW3 的记录表损坏或超过安全限制。')
    offsets = [struct.unpack_from('>I', raw, 78 + index * 8)[0] for index in range(count)]
    if offsets != sorted(set(offsets)) or offsets[0] < 78 + count * 8 or offsets[-1] >= len(raw):
        fail('invalid_mobi', 'MOBI/AZW3 的文件边界无效。')
    first = offsets[0]
    if first + 40 > len(raw) or raw[first + 16:first + 20] != b'MOBI':
        fail('invalid_mobi', 'MOBI/AZW3 缺少有效的内容头。')
    for offset in offsets:
        # A joint MOBI7/KF8 book may carry a second encrypted MOBI header.
        if raw[offset + 16:offset + 20] == b'MOBI' and len(raw) >= offset + 14 and struct.unpack_from('>H', raw, offset)[0] in (1, 2, 0x4448):
            if struct.unpack_from('>H', raw, offset + 12)[0]:
                fail('encrypted_mobi', '不支持 DRM 或加密 MOBI/AZW3，请提供有权使用的未加密版本。')


def language_for(text, declared=''):
    declared = clean(declared).replace('_', '-')[:80]
    if declared and re.fullmatch(r'[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*', declared):
        return declared
    letters = [c for c in text[:20000] if c.isalpha()]
    cjk = sum('\u4e00' <= c <= '\u9fff' for c in letters)
    kana = any('\u3040' <= c <= '\u30ff' for c in letters)
    if kana:
        return 'ja'
    if letters and cjk / len(letters) > .25:
        return 'zh'
    return 'und'  # A Latin script is not evidence that the source is English.


def decode_text(raw):
    even_nulls, odd_nulls = raw[0::2].count(0), raw[1::2].count(0)
    if raw.startswith((b'\xff\xfe\x00\x00', b'\x00\x00\xfe\xff')):
        fail('invalid_text_encoding', 'TXT 支持 UTF-8、UTF-16 和 GB18030，请将原文另存为 UTF-8 后重试。')
    if raw.startswith((b'\xff\xfe', b'\xfe\xff')):
        encodings = ['utf-16']
    elif raw.startswith(b'\xef\xbb\xbf'):
        encodings = ['utf-8-sig']
    elif len(raw) > 4 and odd_nulls >= 2 and odd_nulls > even_nulls * 4:
        encodings = ['utf-16-le']
    elif len(raw) > 4 and even_nulls >= 2 and even_nulls > odd_nulls * 4:
        encodings = ['utf-16-be']
    else:
        encodings = ['utf-8', 'gb18030']
    for encoding in encodings:
        if encoding == 'gb18030' and len(raw) % 2 == 0 and any(value >= 128 for value in raw):
            # Unmarked UTF-16 Chinese can also be valid GB18030. If both byte
            # interpretations look like Chinese text, do not silently pick one.
            for candidate_encoding in ('utf-16-le', 'utf-16-be'):
                try:
                    candidate = raw.decode(candidate_encoding, errors='strict')
                except UnicodeError:
                    continue
                if any(unicodedata.category(c) in ('Cs', 'Co', 'Cc') and c not in '\n\r\t\f' for c in candidate):
                    continue
                letters = [c for c in candidate if c.isalpha()]
                if letters and sum('\u3400' <= c <= '\u9fff' for c in letters) / len(letters) >= .7:
                    fail('invalid_text_encoding', '无 BOM 的 UTF-16 与 GB18030 编码存在歧义。请另存为 UTF-8 或带 BOM 的 UTF-16 后重试。')
        try:
            text = raw.decode(encoding, errors='strict')
        except UnicodeError:
            continue
        if '\ufffd' in text or any(unicodedata.category(c) in ('Cs', 'Co') or (unicodedata.category(c) == 'Cc' and c not in '\n\r\t\f') for c in text):
            fail('binary_text', '文件含二进制数据或无效文字字符，不能按 TXT 导入。')
        if encoding == 'gb18030' and not any('\u4e00' <= c <= '\u9fff' for c in text):
            continue
        return text.replace('\r\n', '\n').replace('\r', '\n'), encoding
    fail('invalid_text_encoding', '无法可靠识别文字编码。支持 UTF-8、UTF-16 和 GB18030，请将原文另存为 UTF-8 后重试。')


def text_blocks(text):
    """Keep paragraph order, splitting only exceptionally long unbroken blocks."""
    for paragraph in re.split(r'\n\s*\n', text):
        value = clean(paragraph)
        while len(value) > 5000:
            end = max(value.rfind(' ', 1500, 4000), value.rfind('。', 1500, 4000), value.rfind('；', 1500, 4000))
            if end < 0:
                end = 4000
            else:
                end += 1
            yield value[:end].strip()
            value = value[end:].strip()
        if value:
            yield value


class BookBuilder:
    def __init__(self, book_id, format_name, title, author='', language='und'):
        self.book_id, self.format = book_id, format_name
        self.title, self.author = clean(title)[:500] or 'Untitled book', clean(author)[:1000] or ''
        self.language = language
        self.slot = 'zh' if language.lower().startswith(('zh', 'cmn')) else 'en'
        self.units, self.sections, self.images, self.assets = [], [], {}, {}
        self.characters, self.image_occurrences = 0, 0
        self.details = {}

    def section(self, title, kind='main'):
        number = len(self.sections) + 1
        section = {'id': f's-{number}', 'parentId': None, 'order': number - 1,
                   'title': {'zh': title, 'en': title}, 'kind': kind,
                   'readingOrder': {'zh': [], 'en': []}, 'sourceRanges': {},
                   'noteIds': {'zh': [], 'en': []}, 'imageIds': [],
                   'chapterMatch': {'status': 'monolingual'}}
        self.sections.append(section)
        return section

    def paragraph(self, text, kind='prose', image_id=None):
        text = clean(text)
        if not text and not image_id:
            return
        if len(self.units) >= MAX_UNITS:
            fail('too_many_units', '书籍超过 30000 个阅读单元限制。')
        self.characters += len(text)
        if self.characters > MAX_TEXT_CHARS:
            fail('too_much_text', '书籍超过 1200 万字符限制。')
        if not self.sections:
            self.section(self.title)
        section = self.sections[-1]
        index = len(self.units) + 1
        identity = hashlib.sha256(f'{self.book_id}:{index}'.encode()).hexdigest()[:24]
        block, unit_id = 'b-' + identity, 'u-' + identity
        segments = [{'type': 'text', 'text': text}] if text else []
        if image_id:
            segments.append({'type': 'image', 'imageId': image_id, 'alt': text})
        paragraph = {'id': block, 'language': self.language, 'text': text, 'segments': segments,
                     'source': {'bookId': self.book_id, 'file': self.format, 'page': self.details.get('page')},
                     'normalizations': ['whitespace-collapsed']}
        unit = {'id': unit_id, 'order': index, 'sectionId': section['id'], 'chapter': dict(section['title']),
                'kind': kind if text else 'image', 'contentType': 'prose', 'authorship': 'source',
                'zh': [], 'en': [], 'originalLanguage': [], 'notes': [], 'chapterNotes': [],
                'noteIds': [], 'chapterNoteIds': [], 'imageIds': [image_id] if image_id else [],
                'sourceBlockIds': {'zh': [], 'en': [], 'original': []}, 'structure': None,
                'randomEligible': bool(text) and kind != 'heading', 'randomReason': 'Imported source text',
                'alignment': {'status': 'monolingual', 'relation': 'none', 'evidence': []}}
        unit[self.slot] = [paragraph]
        unit['sourceBlockIds'][self.slot] = [block]
        self.units.append(unit)
        section['readingOrder'][self.slot].append(unit_id)
        if image_id:
            self.images[image_id]['occurrences'].append({'blockId': block, 'sectionId': section['id']})
            if image_id not in section['imageIds']:
                section['imageIds'].append(image_id)

    def image(self, raw, mime, filename):
        if len(raw) > MAX_ENTRY_BYTES:
            fail('resource_limit', '单张图片超过本地资源大小限制。')
        ext = None
        if mime == 'image/png' and raw.startswith(b'\x89PNG\r\n\x1a\n'):
            ext = 'png'
        elif mime == 'image/jpeg' and raw.startswith(b'\xff\xd8\xff'):
            ext = 'jpg'
        elif mime == 'image/gif' and raw.startswith((b'GIF87a', b'GIF89a')):
            ext = 'gif'
        elif mime == 'image/webp' and raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
            ext = 'webp'
        if ext is None:
            return None
        sha = hashlib.sha256(raw).hexdigest()
        identity = 'i-' + sha
        asset = sha + '.' + ext
        self.assets[asset] = raw
        self.images.setdefault(identity, {'id': identity, 'bookId': self.book_id, 'file': source_name(filename),
            'sha256': sha, 'mediaType': mime, 'localUrl': f'/api/library/{self.book_id}/assets/{asset}',
            'occurrences': [], 'captionBlockIds': []})
        return identity

    def finish(self, extra=None):
        if not self.characters:
            fail('no_text', '未找到可阅读文字；不支持纯扫描图片或无正文书籍。')
        sections = [section for section in self.sections if section['readingOrder'][self.slot]]
        book = {'id': self.book_id, 'format': self.format, 'title': self.title, 'author': self.author,
                'language': self.language, 'unitCount': len(self.units), 'chapterCount': len(sections),
                'importedAt': datetime.now(timezone.utc).isoformat(timespec='seconds')}
        sha = self.book_id.rsplit('-', 1)[-1]
        metadata = {**book, 'bookId': self.book_id, 'datasetId': sha, 'datasetVersion': 'local-import-2',
                    'schemaVersion': 2, 'imported': True, 'primaryLanguage': self.slot,
                    'sources': [{'language': self.slot, 'originalLanguage': self.language, 'sha256': sha, 'title': self.title}],
                    'sourceFiles': [], 'importMethod': 'Local isolated parsing; no network; no translation',
                    'networkUsedForImport': False, 'sourceFilesCopiedToWebRoot': False,
                    'limitations': [], **(extra or {})}
        data = {'schemaVersion': 2, 'metadata': metadata, 'units': self.units, 'sections': sections,
                'imagesById': self.images, 'notesById': {}, 'legacy': {'unitAliases': {}, 'blockAliases': {}}}
        return book, data, self.assets


def parse_txt(raw, book_id, filename):
    text, encoding = decode_text(raw)
    builder = BookBuilder(book_id, 'txt', Path(source_name(filename)).stem, language=language_for(text))
    lines = text.split('\n')
    heading = re.compile(r'^(?:(?:chapter|part|book|section)\s+(?:\d+|[ivxlcdm]+)\b|第.{1,15}[章节卷篇部]).{0,100}$', re.I)
    pending = []
    def flush():
        for block in text_blocks('\n'.join(pending)):
            builder.paragraph(block)
        pending.clear()
    for line in lines:
        if heading.fullmatch(line.strip()):
            flush()
            builder.section(line.strip())
            builder.paragraph(line.strip(), 'heading')
        else:
            pending.append(line)
    flush()
    return builder.finish({'sourceEncoding': encoding, 'languageDetection': 'script heuristic; undeclared Latin text remains und'})


def parse_pdf(raw, book_id, filename):
    try:
        import pypdf
    except ImportError:
        fail('missing_pdf_dependency', 'PDF 导入需要本地依赖，请运行：' + SETUP_COMMAND, 503)
    if hasattr(pypdf, 'overwrite_configuration'):
        pypdf.overwrite_configuration(zlib_maximum_output_length=32 * 1024 * 1024,
                                     lzw_maximum_output_length=32 * 1024 * 1024,
                                     run_length_maximum_output_length=32 * 1024 * 1024,
                                     maximum_declared_stream_length=32 * 1024 * 1024)
    else:  # Older optional installations; the worker still has hard limits.
        from pypdf import filters
        filters.ZLIB_MAX_OUTPUT_LENGTH = 32 * 1024 * 1024
    try:
        reader = pypdf.PdfReader(io.BytesIO(raw), strict=False)
        if reader.is_encrypted:
            fail('encrypted_pdf', '不支持加密或密码保护的 PDF，请提供有权使用的未加密版本。')
        if len(reader.pages) > MAX_PDF_PAGES:
            fail('pdf_page_limit', 'PDF 超过 3000 页限制。')
        metadata = reader.metadata or {}
        declared = str(reader.trailer['/Root'].get('/Lang', ''))
        pages, chars = [], 0
        for page in reader.pages:
            text = page.extract_text() or ''
            chars += len(text)
            if chars > MAX_TEXT_CHARS:
                fail('too_much_text', 'PDF 文字超过 1200 万字符限制。')
            pages.append(text)
        if not any(clean(text) for text in pages):
            fail('pdf_no_text', '此 PDF 没有可提取的文字层；扫描 PDF 需要 OCR，当前版本不包含 OCR。')
        builder = BookBuilder(book_id, 'pdf', str(metadata.get('/Title') or Path(source_name(filename)).stem),
                              str(metadata.get('/Author') or ''), language_for(''.join(pages)[:20000], declared))
        for number, text in enumerate(pages, 1):
            if not clean(text):
                continue
            builder.section(f'Page {number}')
            builder.details['page'] = number
            for block in text_blocks(text):
                builder.paragraph(block)
        return builder.finish({'pageCount': len(pages), 'pagesWithoutText': sum(not clean(page) for page in pages),
            'limitations': ['PDF text is grouped by source page. Columns, formulas and layout may differ.', 'Images and OCR are not included; source text is not translated.']})
    except ImportFailure:
        raise
    except Exception:
        fail('invalid_pdf', 'PDF 文件损坏，或本地解析器无法读取此 PDF。')


def parse_fb2(raw, book_id, filename):
    root = safe_xml(raw)
    if tag(root) != 'fictionbook':
        fail('invalid_fb2', '这不是支持的 FictionBook 2 XML 文件。')
    info = next((element for element in root.iter() if tag(element) == 'title-info'), None)
    def value(name):
        return next((clean(''.join(element.itertext())) for element in (info if info is not None else []) if tag(element) == name), '')
    author = ''
    if info is not None:
        author = ', '.join(clean(' '.join(''.join(part.itertext()) for part in element if tag(part) in ('first-name', 'middle-name', 'last-name', 'nickname'))) for element in info if tag(element) == 'author')
    bodies = [element for element in root if tag(element) == 'body']
    text = ' '.join(''.join(body.itertext()) for body in bodies)
    builder = BookBuilder(book_id, 'fb2', value('book-title') or Path(source_name(filename)).stem,
                          author, language_for(text, value('lang')))
    binaries = {element.get('id'): element for element in root if tag(element) == 'binary' and element.get('id')}
    image_cache = {}
    def walk(element):
        name = tag(element)
        if name in SKIP_TAGS:
            return
        if name == 'section':
            title_element = next((child for child in element if tag(child) == 'title'), None)
            title = clean(''.join(title_element.itertext())) if title_element is not None else f'Section {len(builder.sections) + 1}'
            builder.section(title)
        if name in ('p', 'v', 'subtitle', 'text-author'):
            builder.paragraph(''.join(element.itertext()), 'heading' if name == 'subtitle' else 'prose')
            return
        if name == 'title':
            builder.paragraph(''.join(element.itertext()), 'heading')
            return
        if name == 'image':
            ref = element.get('{http://www.w3.org/1999/xlink}href', element.get('href', ''))
            if ref.startswith('#') and ref[1:] in binaries:
                if ref not in image_cache:
                    binary = binaries[ref[1:]]
                    try:
                        image_bytes = base64.b64decode(re.sub(r'\s+', '', binary.text or ''), validate=True)
                    except ValueError:
                        image_bytes = b''
                    image_cache[ref] = builder.image(image_bytes, binary.get('content-type'), ref[1:])
                if image_cache[ref]:
                    builder.paragraph('', image_id=image_cache[ref])
            return
        for child in element:
            walk(child)
    for body in bodies:
        walk(body)
    return builder.finish({'limitations': ['FB2 text and safe raster images are imported; original layout and note links are not preserved.']})


class PlainHtml(HTMLParser):
    """Read converter output as text; never insert its HTML into the reader."""
    def __init__(self, builder, base, boundary, body_required=False):
        super().__init__(convert_charrefs=True)
        self.builder, self.base, self.boundary = builder, base, boundary
        self.parts, self.skip, self.kind, self.images = [], [], 'prose', {}
        self.in_body = not body_required

    def flush(self):
        text = clean(''.join(self.parts))
        self.parts.clear()
        if self.kind == 'heading' and text:
            self.builder.section(text)
        if text:
            self.builder.paragraph(text, self.kind)

    def handle_starttag(self, name, attributes):
        if name == 'body':
            self.in_body = True
            return
        if not self.in_body:
            return
        if self.skip:
            if name in SKIP_TAGS or name in ('head', 'title'):
                self.skip.append(name)
            return
        if name in SKIP_TAGS or name in ('head', 'title'):
            if name not in ('input', 'embed'):
                self.skip.append(name)
            return
        if name in BLOCK_TAGS:
            self.flush()
            self.kind = 'heading' if name in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6') else 'prose'
        if name == 'br':
            self.parts.append('\n')
        if name == 'img':
            self.flush()
            attrs = dict(attributes)
            href = attrs.get('src', '')
            if href not in self.images:
                self.images[href] = None
                try:
                    url = urlsplit(href)
                    target = (self.base / unquote(url.path)).resolve()
                    if not url.scheme and not url.netloc and '\\' not in href and target.is_relative_to(self.boundary) and target.is_file() and target.stat().st_size <= MAX_ENTRY_BYTES:
                        mime = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'}.get(target.suffix.lower())
                        self.images[href] = self.builder.image(target.read_bytes(), mime, target.name)
                except (ValueError, OSError):
                    pass
            if self.images[href]:
                self.builder.paragraph('', image_id=self.images[href])

    def handle_endtag(self, name):
        if name == 'body':
            self.flush()
            self.in_body = False
            return
        if not self.in_body:
            return
        if self.skip:
            if name == self.skip[-1]:
                self.skip.pop()
            return
        if name in BLOCK_TAGS:
            self.flush()
            self.kind = 'prose'

    def handle_data(self, data):
        if self.in_body and not self.skip:
            self.parts.append(data)


def parse_mobi(input_path, book_id, format_name, filename, work):
    executable = mobi_executable()
    if not executable:
        fail('missing_mobi_dependency', 'MOBI/AZW3 导入需要本地依赖，请运行：' + SETUP_COMMAND, 503)
    output = work / 'unpacked'
    # The GPL program stays a separate executable; no GPL implementation is
    # imported or copied into this MIT application.
    with (work / 'converter.log').open('wb') as log:
        result = subprocess.run([executable, str(input_path), str(output)], stdin=subprocess.DEVNULL,
                                stdout=log, stderr=log, cwd=work, timeout=CONVERSION_TIMEOUT - 5)
    if result.returncode:
        fail('conversion_failed', '本地转换器无法读取这本电子书，文件可能损坏或使用暂不支持的变体。')
    epubs = sorted(output.rglob('*.epub'))
    if epubs:
        parser = EpubParser(epubs[0].read_bytes(), book_id)
        try:
            book, data, assets = parser.parse()
        finally:
            parser.zip.close()
        book['format'] = data['metadata']['format'] = format_name
        return book, data, assets
    htmls = sorted(output.rglob('*.html'))
    if not htmls:
        fail('conversion_failed', '本地转换器没有生成可阅读文字；不支持此 Kindle 文件变体。')
    title, author, declared = Path(source_name(filename)).stem, '', ''
    opfs = sorted(output.rglob('*.opf'))
    if opfs:
        opf = safe_xml(opfs[0].read_bytes())
        title = next((clean(''.join(e.itertext())) for e in opf.iter() if tag(e) == 'title'), title)
        author = ', '.join(clean(''.join(e.itertext())) for e in opf.iter() if tag(e) == 'creator')
        declared = next((clean(''.join(e.itertext())) for e in opf.iter() if tag(e) == 'language'), '')
    with input_path.open('rb') as source:
        source.seek(78)
        first_record = struct.unpack('>I', source.read(4))[0]
        source.seek(first_record + 28)
        codepage = struct.unpack('>I', source.read(4))[0]
    html_encoding = 'cp1252' if codepage == 1252 else 'utf-8'
    html_texts = [path.read_text(encoding=html_encoding, errors='strict') for path in htmls]
    builder = BookBuilder(book_id, format_name, title, author, language_for(''.join(html_texts)[:20000], declared))
    for path, text in zip(htmls, html_texts):
        parser = PlainHtml(builder, path.parent, output.resolve(), body_required=bool(re.search(r'<body\b', text, re.I)))
        parser.feed(text)
        parser.close()
        parser.flush()
    return builder.finish({'limitations': ['Converted locally with the standalone KindleUnpack CLI; original layout and note links may differ.']})


def check_output_limits(work):
    total = count = 0
    for path in work.rglob('*'):
        if path.is_symlink():
            fail('conversion_limit', '转换输出含不安全的符号链接。')
        if path.is_file():
            count += 1
            try:
                total += path.stat().st_size
            except FileNotFoundError:  # Converter may finish/rename a file mid-scan.
                continue
            if count > MAX_ENTRIES or total > MAX_EXPANDED_BYTES + MAX_EPUB_BYTES:
                fail('conversion_limit', '本地转换超过文件数量或解压大小限制。')


def check_process_memory(group_id):
    """Bound aggregate worker/converter RSS on macOS and other POSIX hosts."""
    if sys.platform != 'darwin' and not sys.platform.startswith('linux'):
        return
    if not Path('/bin/ps').is_file():
        return
    try:
        selector = '-g' if sys.platform == 'darwin' else '--sid'
        sample = subprocess.run(['/bin/ps', selector, str(group_id), '-o', 'pgid=,rss='], capture_output=True,
                                timeout=2, check=True, text=True).stdout
        rss = 0
        for line in sample.splitlines():
            values = line.split()
            if len(values) == 2 and values[0].isdigit() and values[1].isdigit() and int(values[0]) == group_id:
                rss += int(values[1])
        if rss > MAX_WORKER_RSS_KIB:
            fail('conversion_limit', '转换进程内存超过 768 MiB 安全限制。')
    except (OSError, subprocess.SubprocessError):
        # CPU, output, elapsed-time and (on Linux) address-space limits remain.
        pass


def isolated_result(raw, book_id, format_name, filename, root):
    with tempfile.TemporaryDirectory(prefix='.convert-', dir=root) as directory:
        work = Path(directory)
        input_path = work / ('source.' + format_name)
        input_path.write_bytes(raw)
        request = {'bookId': book_id, 'format': format_name, 'filename': source_name(filename)}
        (work / 'request.json').write_text(json.dumps(request), encoding='utf-8')
        worker = Path(__file__).with_name('import_worker.py')
        environment = {**os.environ, 'TMPDIR': str(work), 'TEMP': str(work), 'TMP': str(work), 'PYTHONDONTWRITEBYTECODE': '1'}
        with (work / 'worker.log').open('wb') as log:
            process = subprocess.Popen([sys.executable, '-B', str(worker), str(work)], stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=log, cwd=work, env=environment, start_new_session=True)
            deadline = time.monotonic() + CONVERSION_TIMEOUT
            next_memory_check = 0
            try:
                while process.poll() is None:
                    if time.monotonic() >= deadline:
                        fail('conversion_timeout', '转换超过 60 秒限制，请尝试更小或结构更简单的书籍。')
                    check_output_limits(work)
                    if time.monotonic() >= next_memory_check:
                        check_process_memory(process.pid)
                        next_memory_check = time.monotonic() + .2
                    time.sleep(.05)
                check_output_limits(work)
            finally:
                if os.name == 'posix':
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                elif process.poll() is None:
                    process.kill()
                if process.poll() is None:
                    process.wait()
        response = work / 'result.json'
        if not response.is_file():
            fail('conversion_limit' if process.returncode and process.returncode < 0 else 'conversion_failed', '转换失败或超过安全资源限制；已有书籍已保留。')
        result = json.loads(response.read_text(encoding='utf-8'))
        if 'error' in result:
            error = result['error']
            fail(error['reason'], error['notice'], error.get('status', 400))
        assets = {}
        for path in (work / 'assets').glob('*'):
            if not ASSET_RE.fullmatch(path.name) or path.is_symlink():
                fail('conversion_limit', '转换器生成了不安全的图片资源路径。')
            assets[path.name] = path.read_bytes()
        return result['book'], result['data'], assets


def import_book(raw, root, filename='', content_type='application/epub+zip'):
    if not isinstance(raw, bytes) or not raw:
        fail('empty_file', '请选择非空的电子书文件。')
    if len(raw) > MAX_EPUB_BYTES:
        fail('file_too_large', '电子书文件不能超过 60 MiB。', 413)
    format_name = input_format(raw, filename, content_type)
    book_id = format_name + '-' + hashlib.sha256(raw).hexdigest()
    with IMPORT_LOCK:
        root = safe_library(root, create=True)
        destination = root / book_id
        if destination.exists() or destination.is_symlink():
            return read_book(root, book_id)
        if format_name == 'pdf' and importlib.util.find_spec('pypdf') is None:
            fail('missing_pdf_dependency', 'PDF 导入需要本地依赖，请运行：' + SETUP_COMMAND, 503)
        if format_name in ('mobi', 'azw3') and not mobi_executable():
            fail('missing_mobi_dependency', 'MOBI/AZW3 导入需要本地依赖，请运行：' + SETUP_COMMAND, 503)
        book, data, assets = isolated_result(raw, book_id, format_name, filename, root)
        if format_name != 'epub':
            # MOBI7/KF8 may use identical bytes with different valid extensions.
            # Reader record locks use datasetId, so include format identity.
            data['metadata']['datasetId'] = hashlib.sha256(book_id.encode()).hexdigest()
        temporary = Path(tempfile.mkdtemp(prefix='.import-', dir=root))
        try:
            (temporary / 'assets').mkdir(mode=0o700)
            for name, payload in assets.items():
                (temporary / 'assets' / name).write_bytes(payload)
            (temporary / 'reading.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            (temporary / 'book.json').write_text(json.dumps(book, ensure_ascii=False), encoding='utf-8')
            if destination.exists() or destination.is_symlink():
                return read_book(root, book_id)
            os.rename(temporary, destination)
            return book
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
