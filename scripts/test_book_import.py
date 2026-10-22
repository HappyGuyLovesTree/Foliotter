"""Original synthetic fixtures for every supported input format."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import quote
import zlib

import book_import
from book_import import capabilities, decode_text, import_book, mobi_executable, parse_pdf
from epub_import import ImportFailure, library_file, list_books
import test_epub_import
from test_epub_import import PNG, make_epub


def make_pdf(scan=False):
    """A standards-shaped PDF with original text, or one small raster image."""
    if scan:
        stream = b'q 50 0 0 50 72 700 cm /Im0 Do Q'
        resource = b'/XObject << /Im0 5 0 R >>'
        pixels = zlib.compress(b'\x7f')
        asset = b'<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ' + str(len(pixels)).encode() + b' >>\nstream\n' + pixels + b'\nendstream'
    else:
        stream = b'BT /F1 18 Tf 72 720 Td (The Paper Harbor) Tj 0 -30 Td /F1 12 Tf (An otter made a boat from a letter and watched it sail.) Tj ET'
        resource = b'/Font << /F1 5 0 R >>'
        asset = b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    objects = [b'<< /Type /Catalog /Pages 2 0 R /Lang (en) >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << ' + resource + b' >> /Contents 4 0 R >>',
               b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream', asset,
               b'<< /Title (Paper Harbor) /Author (Original Test Author) >>']
    result = b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
    offsets = [0]
    for number, value in enumerate(objects, 1):
        offsets.append(len(result))
        result += f'{number} 0 obj\n'.encode() + value + b'\nendobj\n'
    start = len(result)
    result += f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode()
    result += b''.join(f'{offset:010} 00000 n \n'.encode() for offset in offsets[1:])
    return result + f'trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n{start}\n%%EOF\n'.encode()


def make_mobi(version=6, compression=1, encrypted=False, codepage=65001):
    """Original PalmDB/MOBI6 or KF8 fixture; no third-party book bytes/code.

    Fixed headers declare one uncompressed ASCII text record. KF8 adds a
    one-entry skeleton index containing a complete XHTML document, no fragments.
    PalmDOC compression mode 2 represents ASCII printable bytes literally.
    """
    raw = b'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Paper Otter</title></head><body><h1>Chapter 1</h1><p>An otter folded a paper boat under the moon.</p><p>It carried a tiny lantern toward a quiet shore.</p></body></html>'
    if codepage == 1252:
        raw = raw.replace(b'a quiet shore', 'a quiet café'.encode('cp1252'))
    def u32(buffer, offset, value):
        struct.pack_into('>I', buffer, offset, value)
    def variable(value):
        values = [value & 127]
        value >>= 7
        while value:
            values.insert(0, value & 127)
            value >>= 7
        values[-1] |= 128
        return bytes(values)
    header = bytearray(280)
    struct.pack_into('>HHIHHHH', header, 0, compression, 0, len(raw), 1, 4096, int(encrypted), 0)
    header[16:20] = b'MOBI'
    for offset, value in {20: 264, 24: 2, 28: codepage, 32: 17, 36: version,
            80: 2, 84: 280, 88: 11, 92: 9, 104: version, 108: 4 if version == 8 else 2,
            192: 0xffffffff, 196: 1, 248: 0xffffffff, 252: 2 if version == 8 else 0xffffffff,
            260: 0xffffffff}.items():
        u32(header, offset, value)
    for offset in [*range(40, 80, 4), 244]:
        u32(header, offset, 0xffffffff)
    records = [bytes(header) + b'Paper Otter', raw]
    if version == 8:
        index = bytearray(192)
        index[:4] = b'INDX'
        for offset, value in {4: 192, 24: 1, 28: 65001}.items():
            u32(index, offset, value)
        index += b'TAGX' + struct.pack('>II', 24, 1) + bytes([1, 1, 1, 0, 6, 2, 2, 0, 0, 0, 0, 1])
        entry = b'\x04skel\x03' + variable(0) + variable(0) + variable(len(raw))
        entries = bytearray(192)
        entries[:4] = b'INDX'
        for offset, value in {4: 192, 20: 192 + len(entry), 24: 1, 28: 65001}.items():
            u32(entries, offset, value)
        entries += entry + b'IDXT' + struct.pack('>H', 192)
        records.extend([bytes(index), bytes(entries)])
    palm = bytearray(78)
    palm[:11] = b'Paper Otter'
    palm[60:68] = b'BOOKMOBI'
    struct.pack_into('>H', palm, 76, len(records))
    offset = 78 + 8 * len(records) + 2
    for index, record in enumerate(records):
        palm += struct.pack('>II', offset, index * 2)
        offset += len(record)
    return bytes(palm) + b'\0\0' + b''.join(records)


def make_fb2():
    image = base64.b64encode(PNG).decode()
    return f'''<?xml version="1.0" encoding="UTF-8"?>
    <FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
      <description><title-info><book-title>Lantern Bay</book-title><author><first-name>Original</first-name><last-name>Author</last-name></author><lang>en</lang></title-info></description>
      <body><section><title><p>A floating light</p></title><p>A lantern drifted across the bay.</p><image l:href="#dot"/><p>The otter watched from a warm rock.</p></section></body>
      <binary id="dot" content-type="image/png">{image}</binary>
    </FictionBook>'''.encode()


def fixtures():
    return {'Moonrise.epub': make_epub(), 'Paper Harbor.pdf': make_pdf(),
            'Small Lantern.txt': '第一章 纸灯\n\n小水獭把一张纸折成小船，轻轻放进河里。\n\n第二章 归岸\n\n纸灯照着水面，它想起了家里的窗户。'.encode(),
            'Paper Otter.mobi': make_mobi(), 'Quiet Shore.azw3': make_mobi(8), 'Lantern Bay.fb2': make_fb2()}


class FormatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve() / 'library'

    def tearDown(self):
        self.temp.cleanup()

    def read(self, book):
        return json.loads(library_file(self.root, book['id'], 'reading.json').read_text())

    def test_txt_utf8_utf16_gb18030_and_chapters(self):
        text = '第一章 纸灯\n\n小水獭把纸船放进河里。\n\n第二章 归岸\n\n纸灯照着水面。'
        for encoding in ['utf-8', 'utf-16', 'utf-16-le', 'utf-16-be', 'gb18030']:
            encoded = text.encode(encoding)
            if encoding in ('utf-16-le', 'utf-16-be'):
                encoded = ('A title\n\n' + text).encode(encoding)
            book = import_book(encoded, self.root, 'Paper.txt', 'application/octet-stream')
            data = self.read(book)
            self.assertEqual('zh', book['language'])
            self.assertGreaterEqual(book['chapterCount'], 2)
            self.assertFalse(any(unit['en'] for unit in data['units']))
            self.assertIn('小水獭', json.dumps(data, ensure_ascii=False))
            self.assertNotIn('\ufffd', json.dumps(data, ensure_ascii=False))

    def test_text_rejects_invalid_encoding_binary_and_disguised_formats(self):
        for raw in [b'\xef\xbb\xbf\xff', b'\xff\xfeA', b'\x80\x81\xff', b'\x00\x01\x02binary']:
            with self.assertRaises(ImportFailure):
                import_book(raw, self.root, 'Bad.txt', 'application/octet-stream')
        with self.assertRaises(ImportFailure) as error:
            import_book(make_pdf(), self.root, 'Disguised.txt', 'text/plain')
        self.assertEqual('format_mismatch', error.exception.reason)
        self.assertEqual([], list_books(self.root))

    def test_unmarked_utf16_chinese_is_not_silently_misread_as_gb18030(self):
        for text in ['这是中文内容', '中国故事']:
            with self.assertRaises(ImportFailure) as error:
                import_book(text.encode('utf-16-le'), self.root, 'Ambiguous.txt', 'text/plain')
            self.assertEqual('invalid_text_encoding', error.exception.reason)
            self.assertEqual(text, decode_text(text.encode('utf-16'))[0])
        self.assertEqual([], list_books(self.root))

    def test_fb2_text_and_image_are_sanitized(self):
        book = import_book(make_fb2(), self.root, 'Book.fb2', 'application/octet-stream')
        data = self.read(book)
        self.assertEqual('Lantern Bay', book['title'])
        self.assertEqual('en', book['language'])
        self.assertEqual('Original Author', book['author'])
        self.assertEqual(1, len(data['imagesById']))
        self.assertIn('The otter watched', json.dumps(data))
        self.assertNotIn('FictionBook', json.dumps(data))
        for raw in [b'<html/>', b'<!DOCTYPE a [<!ENTITY b "x">]><FictionBook/>']:
            with self.assertRaises(ImportFailure):
                import_book(raw, self.root, 'Bad.fb2', 'application/octet-stream')

    @unittest.skipUnless(importlib.util.find_spec('pypdf'), 'optional pypdf dependency is not installed')
    def test_pdf_text_scan_encryption_and_page_limit(self):
        book = import_book(make_pdf(), self.root, 'Story.pdf', 'application/pdf')
        self.assertEqual('Paper Harbor', book['title'])
        data = self.read(book)
        self.assertEqual('en', book['language'])
        self.assertIn('An otter made a boat', json.dumps(data))
        with self.assertRaises(ImportFailure) as error:
            import_book(make_pdf(scan=True), self.root, 'Scan.pdf', 'application/pdf')
        self.assertEqual('pdf_no_text', error.exception.reason)
        import pypdf
        writer = pypdf.PdfWriter()
        writer.append(pypdf.PdfReader(io.BytesIO(make_pdf())))
        writer.encrypt('original-test-password')
        output = io.BytesIO()
        writer.write(output)
        with self.assertRaises(ImportFailure) as error:
            import_book(output.getvalue(), self.root, 'Locked.pdf', 'application/pdf')
        self.assertEqual('encrypted_pdf', error.exception.reason)
        with patch('book_import.MAX_PDF_PAGES', 0), self.assertRaises(ImportFailure) as error:
            parse_pdf(make_pdf(), 'pdf-' + '0' * 64, 'Small.pdf')
        self.assertEqual('pdf_page_limit', error.exception.reason)

    @unittest.skipUnless(mobi_executable(), 'optional standalone mobiunpack is not installed')
    def test_mobi_palmdoc_and_kf8_use_real_external_converter(self):
        for version, compression, name in [(6, 1, 'Book.mobi'), (6, 2, 'Compressed.mobi'), (8, 1, 'Book.azw3')]:
            book = import_book(make_mobi(version, compression), self.root, name, 'application/octet-stream')
            data = self.read(book)
            self.assertEqual(Path(name).suffix[1:], book['format'])
            self.assertIn('An otter folded a paper boat', json.dumps(data))
            self.assertFalse(any(unit['zh'] for unit in data['units']))
            self.assertEqual(['Chapter 1', 'An otter folded a paper boat under the moon.',
                              'It carried a tiny lantern toward a quiet shore.'],
                             [paragraph['text'] for unit in data['units'] for paragraph in unit['en']])
        self.assertNotIn('mobi', sys.modules, 'GPL code must stay in the external program')
        one = import_book(make_mobi(8), self.root, 'Same.mobi', 'application/octet-stream')
        two = import_book(make_mobi(8), self.root, 'Same.azw3', 'application/octet-stream')
        self.assertNotEqual(self.read(one)['metadata']['datasetId'], self.read(two)['metadata']['datasetId'])
        legacy = import_book(make_mobi(codepage=1252), self.root, 'Legacy.mobi', 'application/octet-stream')
        self.assertIn('café', json.dumps(self.read(legacy), ensure_ascii=False))

    def test_mobi_encryption_and_corrupt_record_boundaries_rejected(self):
        for raw in [make_mobi(encrypted=True), b'garbage', make_mobi(8, encrypted=True)]:
            with self.assertRaises(ImportFailure):
                import_book(raw, self.root, 'Bad.mobi', 'application/octet-stream')
        raw = bytearray(make_mobi())
        struct.pack_into('>I', raw, 78, 0xffffffff)
        with self.assertRaises(ImportFailure) as error:
            import_book(bytes(raw), self.root, 'Bad.azw3', 'application/octet-stream')
        self.assertEqual('invalid_mobi', error.exception.reason)

    def test_deduplication_ids_original_filename_not_used_as_path(self):
        raw = b'An original line about a quiet paper boat.'
        one = import_book(raw, self.root, '../../private/Story.txt', 'text/plain')
        files = {p.relative_to(self.root): (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.rglob('*') if p.is_file()}
        two = import_book(raw, self.root, 'Different Name.txt', 'text/plain')
        self.assertEqual(one, two)
        self.assertEqual('Story', one['title'])
        self.assertEqual(files, {p.relative_to(self.root): (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.rglob('*') if p.is_file()})
        self.assertEqual(['txt-' + hashlib.sha256(raw).hexdigest()], [p.name for p in self.root.iterdir()])
        epub = make_epub()
        book = import_book(epub, self.root)
        self.assertEqual('epub-' + hashlib.sha256(epub).hexdigest(), book['id'])

    def test_capability_and_missing_dependency_failures(self):
        with patch('book_import.mobi_executable', return_value=None):
            self.assertFalse(next(item for item in capabilities()['formats'] if item['extension'] == 'azw3')['available'])
            with self.assertRaises(ImportFailure) as error:
                import_book(make_mobi(), self.root, 'Story.mobi', 'application/octet-stream')
            self.assertEqual('missing_mobi_dependency', error.exception.reason)
        with patch('book_import.importlib.util.find_spec', return_value=None):
            with self.assertRaises(ImportFailure) as error:
                import_book(make_pdf(), self.root, 'Story.pdf', 'application/pdf')
            self.assertEqual('missing_pdf_dependency', error.exception.reason)

    def test_timeout_cleans_temporary_files_and_preserves_existing_book(self):
        original = import_book(b'A short original paragraph.', self.root, 'Original.txt', 'text/plain')
        with patch('book_import.CONVERSION_TIMEOUT', 0), self.assertRaises(ImportFailure) as error:
            import_book(b'Another original paragraph.', self.root, 'New.txt', 'text/plain')
        self.assertEqual('conversion_timeout', error.exception.reason)
        self.assertEqual([original], list_books(self.root))
        self.assertEqual([original['id']], [p.name for p in self.root.iterdir()])

    def test_output_and_aggregate_memory_limits(self):
        self.root.mkdir()
        (self.root / 'out').write_bytes(b'original')
        with patch('book_import.MAX_EXPANDED_BYTES', 1), patch('book_import.MAX_EPUB_BYTES', 1), self.assertRaises(ImportFailure):
            book_import.check_output_limits(self.root)
        if os.name == 'posix' and Path('/bin/ps').is_file():
            sample = type('Sample', (), {'stdout': '123 500000\n123 500000\n456 1\n'})()
            with patch('book_import.subprocess.run', return_value=sample), self.assertRaises(ImportFailure) as error:
                book_import.check_process_memory(123)
            self.assertEqual('conversion_limit', error.exception.reason)


class MultiFormatHttpTests(test_epub_import.HttpTests):
    def test_http_capabilities_and_six_formats(self):
        status, payload = self.request('GET', '/api/library/capabilities')
        self.assertEqual(200, status)
        available = {item['extension']: item['available'] for item in json.loads(payload)['formats']}
        for filename, raw in fixtures().items():
            extension = Path(filename).suffix[1:]
            if not available[extension]:
                continue
            headers = {**self.import_headers(), 'Content-Type': 'application/octet-stream', 'X-File-Name': quote(filename), 'X-UI-Language': 'en'}
            status, payload = self.request('POST', '/api/library/import', raw, headers)
            self.assertEqual(201, status, (filename, payload))
            book = json.loads(payload)['book']
            self.assertTrue(book['id'].startswith(extension + '-'))
            self.assertEqual(extension, book['format'])
            status, data = self.request('GET', '/api/library/' + book['id'] + '/reading.json')
            self.assertEqual(200, status)
            self.assertGreater(len(json.loads(data)['units']), 0)
            self.assertEqual((200, b''), self.request('HEAD', '/api/library/' + book['id'] + '/reading.json'))

    def test_error_notice_follows_ui_language(self):
        headers = {**self.import_headers(), 'Content-Type': 'application/octet-stream', 'X-File-Name': quote('Scan.pdf')}
        if importlib.util.find_spec('pypdf'):
            status, payload = self.request('POST', '/api/library/import', make_pdf(scan=True), headers)
            self.assertEqual(400, status)
            self.assertIn('OCR', json.loads(payload)['notice'])
            self.assertIn('text layer', json.loads(payload)['notice'])
            status, payload = self.request('POST', '/api/library/import', make_pdf(scan=True), {**headers, 'X-UI-Language': 'zh'})
            self.assertIn('文字层', json.loads(payload)['notice'])
        status, payload = self.request('POST', '/api/library/import', b'bad', {**headers, 'X-File-Name': 'Book.kfx'})
        self.assertEqual(415, status)
        self.assertIn('Supported formats', json.loads(payload)['notice'])
        self.assertEqual(400, self.request('POST', '/api/library/import', b'text', {**headers, 'X-File-Name': '%ZZ.txt'})[0])


if __name__ == '__main__':
    unittest.main()
