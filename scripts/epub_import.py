"""Offline EPUB -> reader schema 2. No extraction, HTML execution or networking."""
from datetime import datetime, timezone
import hashlib
from html.entities import name2codepoint
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import stat
import tempfile
import threading
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET
import zipfile
import zlib

MAX_EPUB_BYTES = 60 * 1024 * 1024
MAX_EXPANDED_BYTES = 180 * 1024 * 1024
MAX_ENTRY_BYTES = 24 * 1024 * 1024
MAX_XML_BYTES = 8 * 1024 * 1024
MAX_ENTRIES = 6000
MAX_UNITS = 30000
MAX_TEXT_CHARS = 12000000
BOOK_ID_RE = re.compile(r'epub-[0-9a-f]{64}\Z')
ASSET_RE = re.compile(r'[0-9a-f]{64}\.(?:png|jpg|gif|webp)\Z')
IMPORT_LOCK = threading.RLock()
SKIP_TAGS = {'script', 'style', 'iframe', 'object', 'embed', 'audio', 'video', 'svg', 'math', 'form', 'button', 'input', 'select', 'textarea'}
BLOCK_TAGS = {'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'blockquote', 'pre', 'li', 'dt', 'dd', 'figure', 'figcaption', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}


class ImportFailure(ValueError):
    def __init__(self, reason, notice, status=400):
        super().__init__(notice)
        self.reason, self.notice, self.status = reason, notice, status


def fail(reason, notice, status=400):
    raise ImportFailure(reason, notice, status)


def tag(element):
    return element.tag.rsplit('}', 1)[-1].lower() if isinstance(element.tag, str) else ''


def clean(value):
    return re.sub(r'\s+', ' ', value or '').strip()


def safe_xml(raw):
    if len(raw) > MAX_XML_BYTES:
        fail('xml_too_large', '电子书的单个 XML 文档超过 8 MiB 限制。')
    try:
        if raw.startswith((b'\xff\xfe\x00\x00', b'\x00\x00\xfe\xff')):
            encoding = 'utf-32'
        elif raw.startswith((b'\xff\xfe', b'\xfe\xff')):
            encoding = 'utf-16'
        elif raw.startswith(b'\x00<\x00?'):
            encoding = 'utf-16-be'
        elif raw.startswith(b'<\x00?\x00'):
            encoding = 'utf-16-le'
        else:
            declaration = re.search(br'<\?xml[^>]*encoding=[\'\"]([^\'\"]+)', raw[:300], re.I)
            encoding = declaration.group(1).decode('ascii') if declaration else 'utf-8-sig'
        if encoding.lower().replace('_', '-') not in {'utf-8', 'utf-8-sig', 'utf-16', 'utf-16-le', 'utf-16-be', 'utf-32', 'ascii', 'us-ascii', 'iso-8859-1', 'windows-1252'}:
            fail('xml_encoding', '电子书 XML 使用了暂不支持的字符编码，请转换为 UTF-8 EPUB。')
        text = raw.decode(encoding)
        # Ignore plain/external DOCTYPE declarations (common in EPUB 2). Never
        # resolve their DTD URLs. Internal subsets and custom entities fail shut.
        doctype = r'''<!DOCTYPE\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s+(?:SYSTEM\s+(?:"[^"\[\]]*"|'[^'\[\]]*')|PUBLIC\s+(?:"[^"\[\]]*"|'[^'\[\]]*')\s+(?:"[^"\[\]]*"|'[^'\[\]]*')))?\s*>'''
        text = re.sub(doctype, '', text, flags=re.I)
        if re.search(r'<!\s*(?:DOCTYPE|ENTITY)', text, re.I):
            fail('unsafe_xml', '电子书含 DTD 或实体声明，无法安全导入。')
        # XHTML's built-in character names need no external DTD. Convert only
        # this fixed stdlib table; never expand definitions supplied by a book.
        text = re.sub(r'&([A-Za-z][A-Za-z0-9]+);', lambda match: f'&#{name2codepoint[match[1]]};' if match[1] in name2codepoint and match[1] not in {'amp', 'lt', 'gt', 'quot'} else match[0], text)
        parser = ET.XMLPullParser(events=('start', 'end'))
        depth = count = 0
        root = None
        for position in range(0, len(text), 16384):
            parser.feed(text[position:position + 16384])
            for event, element in parser.read_events():
                if event == 'start':
                    depth += 1
                    count += 1
                    if root is None:
                        root = element
                    if depth > 101 or count > 150000:
                        fail('xml_complexity', '电子书的文档结构过于复杂。')
                else:
                    depth -= 1
        parser.close()
    except (UnicodeError, LookupError, ET.ParseError) as exc:
        fail('invalid_xml', '电子书的 XML/XHTML 文档损坏或格式不受支持。')
    return root


def archive_path(base, href):
    """Resolve a local manifest/content URL without allowing root escape."""
    if not href or len(href) > 4096 or '\\' in href or '\x00' in href:
        return None
    try:
        parsed = urlsplit(href)
    except ValueError:
        return None
    if parsed.scheme or parsed.netloc or parsed.query:
        return None
    part = unquote(parsed.path)
    if '\\' in part or '\x00' in part or part.startswith('/') or ':' in part:
        return None
    path = posixpath.normpath(posixpath.join(posixpath.dirname(base), part))
    if path in ('', '.', '..') or path.startswith('../'):
        return None
    return path


def safe_library(root, create=False):
    root = Path(root).absolute()
    # Reject symlink components, including a symlink substituted for the library.
    if any(p.is_symlink() for p in [root, *root.parents]):
        fail('unsafe_library', '本地书架路径含符号链接，已停止访问。', 409)
    if create:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.exists() and not root.is_dir():
        fail('unsafe_library', '本地书架路径不是目录。', 409)
    return root


def library_file(root, book_id, relative):
    root = safe_library(root)
    if not BOOK_ID_RE.fullmatch(book_id):
        fail('not_found', '未找到这本书。', 404)
    if relative not in ('reading.json', 'book.json') and not (relative.startswith('assets/') and ASSET_RE.fullmatch(relative[7:])):
        fail('not_found', '未找到这项书籍资源。', 404)
    target = root / book_id / relative
    cursor = target
    while cursor != root:
        if cursor.is_symlink():
            fail('unsafe_library', '书籍资源路径含符号链接，已停止访问。', 403)
        cursor = cursor.parent
    if not target.is_file() or not target.resolve().is_relative_to(root.resolve()):
        fail('not_found', '未找到这项书籍资源。', 404)
    return target


def read_book(root, book_id):
    path = library_file(root, book_id, 'book.json')
    if path.stat().st_size > 65536:
        fail('invalid_library', '本地书籍索引损坏，请保留目录并重新检查。', 409)
    try:
        book = json.loads(path.read_text(encoding='utf-8'))
        if book['id'] != book_id or not all(key in book for key in ('title', 'author', 'language', 'unitCount', 'chapterCount', 'importedAt')):
            raise ValueError()
        library_file(root, book_id, 'reading.json')
        return book
    except (ValueError, KeyError, TypeError):
        fail('invalid_library', '本地书籍索引损坏，原目录已保留。', 409)


def list_books(root):
    root = safe_library(root)
    if not root.exists():
        return []
    books = []
    for child in root.iterdir():
        if BOOK_ID_RE.fullmatch(child.name):
            try:
                books.append(read_book(root, child.name))
            except (ImportFailure, OSError):
                continue
    return sorted(books, key=lambda item: item['importedAt'], reverse=True)


class EpubParser:
    def __init__(self, raw, book_id):
        self.book_id = book_id
        try:
            self.zip = zipfile.ZipFile(io.BytesIO(raw))
        except (zipfile.BadZipFile, ValueError):
            fail('invalid_epub', '这不是有效的 EPUB ZIP 文件。请选择未加密的 EPUB。')
        self.entries = {}
        infos = self.zip.infolist()
        if len(infos) > MAX_ENTRIES:
            fail('too_many_files', '电子书内文件数量超过 6000 个限制。')
        total = 0
        for entry in infos:
            name = entry.filename
            components = name.rstrip('/').split('/')
            if entry.orig_filename != name or len(name) > 1024 or '\\' in name or '\x00' in name or ':' in name or name.startswith('/') or any(x in ('', '.', '..') for x in components):
                fail('unsafe_archive_path', '电子书含不安全的 ZIP 文件路径。')
            if name in self.entries:
                fail('duplicate_entry', '电子书含重复 ZIP 文件名，无法确定正文。')
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                fail('unsafe_archive_type', '电子书含符号链接或特殊文件。')
            if entry.flag_bits & 1:
                fail('encrypted_epub', '不支持加密或 DRM 电子书，请提供有权使用的未加密 EPUB。')
            if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                fail('unsupported_compression', '电子书使用了不支持的 ZIP 压缩格式。')
            total += entry.file_size
            if entry.file_size > MAX_ENTRY_BYTES or total > MAX_EXPANDED_BYTES or (entry.file_size > 1024 * 1024 and entry.file_size > max(1, entry.compress_size) * 250):
                fail('archive_limit', '电子书解压大小或压缩比例超过安全限制。')
            self.entries[name] = entry
        if 'META-INF/encryption.xml' in self.entries:
            fail('encrypted_epub', '检测到 encryption.xml：暂不支持 DRM 或字体混淆 EPUB，请提供未加密版本。')
        if self.read('mimetype', 100).strip() != b'application/epub+zip':
            fail('invalid_epub', '文件缺少有效的 EPUB mimetype 标识。')
        self.assets = {}
        self.images = {}
        self.image_cache = {}
        self.text_count = 0
        self.unsupported_images = 0

    def read(self, name, limit=MAX_ENTRY_BYTES):
        entry = self.entries.get(name)
        if entry is None or entry.is_dir():
            fail('missing_resource', '电子书缺少必需的本地文件。')
        if entry.file_size > limit:
            fail('resource_limit', '电子书内资源超过大小限制。')
        try:
            with self.zip.open(entry) as stream:
                raw = stream.read(limit + 1)
            if len(raw) > limit:
                fail('resource_limit', '电子书内资源超过大小限制。')
            return raw
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError, EOFError, zlib.error):
            fail('invalid_epub', '电子书 ZIP 数据损坏。')

    def xml(self, name):
        return safe_xml(self.read(name, MAX_XML_BYTES))

    def image(self, base, href):
        path = archive_path(base, href)
        if not path or path not in self.entries:
            self.unsupported_images += 1
            return None
        if path in self.image_cache:
            if self.image_cache[path] is None:
                self.unsupported_images += 1
            return self.image_cache[path]
        mime = self.media.get(path)
        if mime not in {'image/jpeg', 'image/png', 'image/gif', 'image/webp'}:
            self.image_cache[path] = None
            self.unsupported_images += 1
            return None
        raw = self.read(path)
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
            self.image_cache[path] = None
            self.unsupported_images += 1
            return None
        sha = hashlib.sha256(raw).hexdigest()
        image_id = 'i-' + sha
        filename = sha + '.' + ext
        self.assets[filename] = raw
        self.images.setdefault(image_id, {'id': image_id, 'bookId': self.book_id, 'file': path, 'sha256': sha, 'mediaType': mime, 'localUrl': f'/api/library/{self.book_id}/assets/{filename}', 'occurrences': [], 'captionBlockIds': []})
        self.image_cache[path] = image_id
        return image_id

    def parse(self):
        container = self.xml('META-INF/container.xml')
        rootfiles = [e for e in container.iter() if tag(e) == 'rootfile' and e.get('media-type') == 'application/oebps-package+xml']
        if not rootfiles:
            fail('missing_package', '电子书未提供 OPF 内容清单。')
        opf_path = archive_path('', rootfiles[0].get('full-path'))
        if not opf_path:
            fail('unsafe_archive_path', '电子书 OPF 路径不安全。')
        opf = self.xml(opf_path)
        if tag(opf) != 'package':
            fail('invalid_package', '电子书 OPF 格式不正确。')
        metadata = next((e for e in opf if tag(e) == 'metadata'), None)
        def fields(name):
            return [clean(''.join(e.itertext())) for e in (metadata if metadata is not None else []) if tag(e) == name and clean(''.join(e.itertext()))]
        self.title = (fields('title') or ['未命名电子书'])[0][:500]
        self.author = ', '.join(fields('creator'))[:1000] or '作者未注明'
        self.language = (fields('language') or ['und'])[0][:80]
        self.slot = 'zh' if self.language.lower().startswith(('zh', 'cmn')) else 'en'
        for e in opf.iter():
            if tag(e) == 'meta' and ((e.get('property') == 'rendition:layout' and clean(e.text) == 'pre-paginated') or (e.get('name') == 'fixed-layout' and e.get('content', '').lower() == 'true')):
                fail('fixed_layout', '暂不支持固定版式 EPUB，请使用可重排文字版 EPUB。')
            if 'rendition:layout-pre-paginated' in e.get('properties', '').split():
                fail('fixed_layout', '暂不支持固定版式 EPUB，请使用可重排文字版 EPUB。')
        manifest = next((e for e in opf if tag(e) == 'manifest'), None)
        spine = next((e for e in opf if tag(e) == 'spine'), None)
        if manifest is None or spine is None:
            fail('missing_spine', '电子书缺少正文清单或阅读顺序。')
        items, self.media = {}, {}
        for element in manifest:
            if tag(element) != 'item':
                continue
            identity = element.get('id')
            if not identity or identity in items:
                fail('invalid_manifest', '电子书内容清单的标识缺失或重复。')
            path = archive_path(opf_path, element.get('href'))
            items[identity] = {'path': path, 'media': element.get('media-type'), 'properties': element.get('properties', '').split()}
            if path:
                self.media[path] = element.get('media-type')
        toc, seen_nav = {}, set()
        for item in items.values():
            if 'nav' in item['properties'] and item['path'] and item['path'] not in seen_nav:
                seen_nav.add(item['path'])
                nav = self.xml(item['path'])
                toc_navs = [element for element in nav.iter() if tag(element) == 'nav' and 'toc' in element.get('{http://www.idpf.org/2007/ops}type', '').split()]
                elements = (element for subtree in (toc_navs or [nav]) for element in subtree.iter())
                for element in elements:
                    if tag(element) == 'a':
                        path = archive_path(item['path'], element.get('href'))
                        label = clean(''.join(element.itertext()))
                        if path and label:
                            toc.setdefault(path, label[:500])
        ncx = items.get(spine.get('toc'))
        if ncx and ncx['path']:
            for point in self.xml(ncx['path']).iter():
                if tag(point) != 'navpoint':
                    continue
                content = next((e for e in point if tag(e) == 'content'), None)
                label = next((e for e in point if tag(e) == 'navlabel'), None)
                if content is not None and label is not None:
                    path = archive_path(ncx['path'], content.get('src'))
                    if path:
                        toc.setdefault(path, clean(''.join(label.itertext()))[:500])
        self.units, self.sections = [], []
        seen = set()
        for ref in spine:
            if tag(ref) != 'itemref':
                continue
            item = items.get(ref.get('idref'))
            if not item or not item['path'] or item['media'] != 'application/xhtml+xml':
                fail('unsupported_spine', '正文包含缺失、远程或非 XHTML 内容，暂不能完整导入。')
            path = item['path']
            if path in seen:
                fail('duplicate_spine', '电子书阅读顺序中有重复正文文件。')
            seen.add(path)
            document = self.xml(path)
            body = next((e for e in document.iter() if tag(e) == 'body'), None)
            if body is None:
                continue
            heading = next((clean(''.join(e.itertext())) for e in body.iter() if tag(e) in {'h1', 'h2', 'h3'} and clean(''.join(e.itertext()))), None)
            title = toc.get(path) or heading or f'章节 {len(self.sections) + 1}'
            section_id = 's-' + hashlib.sha256(path.encode()).hexdigest()[:24]
            section = {'id': section_id, 'parentId': None, 'order': len(self.sections), 'title': {'zh': title, 'en': title}, 'kind': 'support' if ref.get('linear') == 'no' else 'main', 'readingOrder': {'zh': [], 'en': []}, 'sourceRanges': {}, 'noteIds': {'zh': [], 'en': []}, 'imageIds': [], 'chapterMatch': {'status': 'monolingual'}}
            self.sections.append(section)
            pending = []
            def flush(kind='prose'):
                nonlocal pending
                segments = []
                for segment in pending:
                    if segment['type'] == 'text':
                        value = re.sub(r'\s+', ' ', segment['text'])
                        if segments and segments[-1]['type'] == 'text':
                            segments[-1]['text'] += value
                        else:
                            segments.append({'type': 'text', 'text': value})
                    else:
                        segments.append(segment)
                pending = []
                text = clean(''.join(s.get('text', '') for s in segments))
                image_ids = list(dict.fromkeys(s['imageId'] for s in segments if s['type'] == 'image'))
                if not text and not image_ids:
                    return
                if len(self.units) >= MAX_UNITS:
                    fail('too_many_units', '电子书超过 30000 个阅读单元限制。')
                self.text_count += len(text)
                if self.text_count > MAX_TEXT_CHARS:
                    fail('too_much_text', '电子书正文超过 1200 万字符限制。')
                index = len(self.units) + 1
                identity = hashlib.sha256(f'{self.book_id}:{index}'.encode()).hexdigest()[:24]
                block_id, unit_id = 'b-' + identity, 'u-' + identity
                paragraph = {'id': block_id, 'language': self.language, 'text': text, 'segments': segments, 'source': {'bookId': self.book_id, 'file': path}, 'normalizations': ['whitespace-collapsed']}
                unit = {'id': unit_id, 'order': index, 'sectionId': section_id, 'chapter': dict(section['title']), 'kind': kind if text else 'image', 'contentType': 'prose', 'authorship': 'source', 'zh': [], 'en': [], 'originalLanguage': [], 'notes': [], 'chapterNotes': [], 'noteIds': [], 'chapterNoteIds': [], 'imageIds': image_ids, 'sourceBlockIds': {'zh': [], 'en': [], 'original': []}, 'randomEligible': kind != 'heading' and bool(text), 'randomReason': 'Imported source text', 'structure': None, 'alignment': {'status': 'monolingual', 'relation': 'none', 'evidence': []}}
                unit[self.slot] = [paragraph]
                unit['sourceBlockIds'][self.slot] = [block_id]
                self.units.append(unit)
                section['readingOrder'][self.slot].append(unit_id)
                for image_id in image_ids:
                    self.images[image_id]['occurrences'].append({'blockId': block_id, 'sectionId': section_id})
                    if image_id not in section['imageIds']:
                        section['imageIds'].append(image_id)
            def walk(element, parent_kind='prose'):
                name = tag(element)
                if name in SKIP_TAGS or element.get('hidden') is not None:
                    return
                is_block = name in BLOCK_TAGS
                kind = 'heading' if name in {'h1', 'h2', 'h3', 'h4', 'h5', 'h6'} else parent_kind
                if is_block:
                    flush(parent_kind)
                if name == 'img':
                    image_id = self.image(path, element.get('src'))
                    if image_id:
                        pending.append({'type': 'image', 'imageId': image_id, 'alt': clean(element.get('alt'))[:1000]})
                    elif element.get('alt'):
                        pending.append({'type': 'text', 'text': f" [图片：{clean(element.get('alt'))}] "})
                elif name == 'br':
                    pending.append({'type': 'text', 'text': '\n'})
                else:
                    if element.text:
                        pending.append({'type': 'text', 'text': element.text})
                    for child in element:
                        walk(child, kind)
                        if child.tail:
                            pending.append({'type': 'text', 'text': child.tail})
                if is_block:
                    flush(kind)
            walk(body)
            flush()
            if not section['readingOrder'][self.slot]:
                self.sections.pop()
        if not self.units or not self.text_count:
            fail('no_text', '未找到可阅读文字；暂不支持纯扫描图片或无正文 EPUB。')
        now = datetime.now(timezone.utc).isoformat(timespec='seconds')
        book = {'id': self.book_id, 'title': self.title, 'author': self.author, 'language': self.language, 'unitCount': len(self.units), 'chapterCount': len(self.sections), 'importedAt': now}
        sha = self.book_id[5:]
        data = {'schemaVersion': 2, 'metadata': {**book, 'bookId': self.book_id, 'datasetId': sha, 'datasetVersion': 'epub-import-1', 'schemaVersion': 2, 'imported': True, 'primaryLanguage': self.slot, 'sources': [{'language': self.slot, 'originalLanguage': self.language, 'sha256': sha, 'title': self.title}], 'sourceFiles': [], 'importMethod': 'Local stdlib ZIP/XML; plain text and allowlisted raster images; no network', 'networkUsedForImport': False, 'sourceFilesCopiedToWebRoot': False, 'limitations': ['仅按 EPUB spine 文件划分章节；章节内文字按原序保留。', '不保留原版式、链接、交互、媒体、脚注跳转或自动双语配对。', 'SVG 和无法验证的图片会跳过。'], 'skippedImageCount': self.unsupported_images}, 'units': self.units, 'sections': self.sections, 'imagesById': self.images, 'notesById': {}, 'legacy': {'unitAliases': {}, 'blockAliases': {}}}
        return book, data, self.assets


def import_epub(raw, root):
    if not isinstance(raw, bytes) or not raw:
        fail('empty_file', '请选择未加密的 EPUB 文件。')
    if len(raw) > MAX_EPUB_BYTES:
        fail('file_too_large', 'EPUB 文件不能超过 60 MiB。', 413)
    book_id = 'epub-' + hashlib.sha256(raw).hexdigest()
    with IMPORT_LOCK:
        root = safe_library(root, create=True)
        destination = root / book_id
        if destination.exists() or destination.is_symlink():
            return read_book(root, book_id)
        parser = EpubParser(raw, book_id)
        try:
            book, data, assets = parser.parse()
        finally:
            parser.zip.close()
        temporary = Path(tempfile.mkdtemp(prefix='.import-', dir=root))
        try:
            (temporary / 'assets').mkdir(mode=0o700)
            for filename, payload in assets.items():
                (temporary / 'assets' / filename).write_bytes(payload)
            (temporary / 'reading.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            (temporary / 'book.json').write_text(json.dumps(book, ensure_ascii=False), encoding='utf-8')
            # Directory publication is atomic. Never merge into existing content.
            if destination.exists() or destination.is_symlink():
                return read_book(root, book_id)
            os.rename(temporary, destination)
            return book
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
