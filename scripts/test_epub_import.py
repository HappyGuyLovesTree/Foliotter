"""Original, generated fixtures only; no copyrighted book data is needed."""
import base64
import hashlib
import http.client
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

from epub_import import (EpubParser, ImportFailure, MAX_EPUB_BYTES, import_epub,
                         library_file, list_books, safe_xml)
import serve


PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=')


def make_epub(*, language='en', extra=None, body=None, fixed=False, nav=True):
    """A small original two-chapter book with a generated one-pixel image."""
    meta = '<meta property="rendition:layout">pre-paginated</meta>' if fixed else ''
    entries = {
        'mimetype': b'application/epub+zip',
        'META-INF/container.xml': b'<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        'OEBPS/book.opf': f'''<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Paper Moon Test Book</dc:title><dc:creator>Original Test Author</dc:creator><dc:language>{language}</dc:language>{meta}</metadata><manifest><item id="two" href="text/two.xhtml" media-type="application/xhtml+xml"/><item id="one" href="text/one.xhtml" media-type="application/xhtml+xml"/><item id="picture" href="images/dot.png" media-type="image/png"/>{'<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>' if nav else ''}</manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>'''.encode(),
        'OEBPS/text/one.xhtml': (body or '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>First window</h1><p>The paper moon rose above the desk.</p><p>An <em>original</em> small story.<img src="../images/dot.png" alt="A dot"/></p><script>DO_NOT_IMPORT_SCRIPT</script><p>Last line in chapter one.</p></body></html>').encode(),
        'OEBPS/text/two.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><h2>Second window</h2><p>Morning folded the moon into a bookmark.</p></body></html>'.encode(),
        'OEBPS/images/dot.png': PNG,
    }
    if nav:
        entries['OEBPS/nav.xhtml'] = b'<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol><li><a href="text/one.xhtml#start">Moonrise</a></li><li><a href="text/two.xhtml">Morning</a></li></ol></nav></body></html>'
    entries.update(extra or {})
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, raw in entries.items():
            archive.writestr(name, raw)
    return out.getvalue()


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve() / 'user-library'

    def tearDown(self):
        self.temporary.cleanup()

    def imported(self, raw=None):
        book = import_epub(raw or make_epub(), self.root)
        data = json.loads(library_file(self.root, book['id'], 'reading.json').read_text())
        return book, data

    def reject(self, raw, reason):
        with self.assertRaises(ImportFailure) as raised:
            import_epub(raw, self.root)
        self.assertEqual(reason, raised.exception.reason)
        self.assertEqual([], list_books(self.root))
        if self.root.exists():
            self.assertEqual([], list(self.root.iterdir()))

    def test_spine_order_text_images_and_nav(self):
        book, data = self.imported()
        self.assertEqual('Paper Moon Test Book', book['title'])
        self.assertEqual('Original Test Author', book['author'])
        self.assertEqual(2, book['chapterCount'])
        self.assertEqual(['Moonrise', 'Morning'], [s['title']['en'] for s in data['sections']])
        texts = [p['text'] for u in data['units'] for p in u['en']]
        self.assertEqual(['First window', 'The paper moon rose above the desk.', 'An original small story.', 'Last line in chapter one.', 'Second window', 'Morning folded the moon into a bookmark.'], texts)
        self.assertFalse(any(u['zh'] for u in data['units']))
        self.assertEqual('monolingual', data['units'][0]['alignment']['status'])
        image = next(iter(data['imagesById'].values()))
        self.assertEqual(PNG, library_file(self.root, book['id'], 'assets/' + image['localUrl'].split('/')[-1]).read_bytes())
        self.assertEqual(1, len(image['occurrences']))
        serialized = json.dumps(data)
        self.assertNotIn('DO_NOT_IMPORT_SCRIPT', serialized)
        self.assertNotIn('<script', serialized)
        self.assertFalse(list(self.root.rglob('*.epub')))

    def test_identical_import_deduplicates_without_rewriting(self):
        raw = make_epub()
        first = import_epub(raw, self.root)
        files = {p.relative_to(self.root): (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.rglob('*') if p.is_file()}
        second = import_epub(raw, self.root)
        self.assertEqual(first, second)
        self.assertEqual(files, {p.relative_to(self.root): (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.rglob('*') if p.is_file()})
        self.assertEqual(1, len(list_books(self.root)))

    def test_other_book_is_separate(self):
        one, _ = self.imported()
        two, _ = self.imported(make_epub(language='zh-CN'))
        self.assertNotEqual(one['id'], two['id'])
        self.assertEqual(2, len(list_books(self.root)))

    def test_chinese_and_other_language_metadata(self):
        for language, slot in [('zh-CN', 'zh'), ('fr', 'en'), ('und', 'en')]:
            book, data = self.imported(make_epub(language=language))
            self.assertEqual(language, book['language'])
            self.assertEqual(slot, data['metadata']['primaryLanguage'])
            self.assertEqual(language, data['units'][0][slot][0]['language'])

    def test_existing_invalid_directory_is_preserved(self):
        raw = make_epub()
        destination = self.root / ('epub-' + hashlib.sha256(raw).hexdigest())
        destination.mkdir(parents=True)
        (destination / 'keep.txt').write_text('keep original')
        with self.assertRaises(ImportFailure):
            import_epub(raw, self.root)
        self.assertEqual('keep original', (destination / 'keep.txt').read_text())
        self.assertEqual(['keep.txt'], [p.name for p in destination.iterdir()])

    def test_invalid_archive_empty_file_size_and_mimetype(self):
        self.reject(b'invalid', 'invalid_epub')
        self.reject(b'', 'empty_file')
        with patch('epub_import.MAX_EPUB_BYTES', 10):
            self.reject(b'0' * 11, 'file_too_large')
        self.reject(make_epub(extra={'mimetype': b'application/zip'}), 'invalid_epub')

    def test_drm_fixed_layout_and_no_text(self):
        self.reject(make_epub(extra={'META-INF/encryption.xml': b'<encryption/>'}), 'encrypted_epub')
        self.reject(make_epub(fixed=True), 'fixed_layout')
        self.reject(make_epub(body='<html><body><script>hidden</script></body></html>', extra={'OEBPS/text/two.xhtml': b'<html><body/></html>'}), 'no_text')

    def test_path_traversal_absolute_backslash_and_duplicate_entries(self):
        for name in ['../escape', '/escape', 'OEBPS/../../escape', 'OEBPS\\escape', 'a//b']:
            self.reject(make_epub(extra={name: b'bad'}), 'unsafe_archive_path')
        out = io.BytesIO(make_epub())
        with zipfile.ZipFile(out, 'a') as archive:
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                archive.writestr('mimetype', b'application/epub+zip')
        self.reject(out.getvalue(), 'duplicate_entry')

    def test_archive_symlink_rejected(self):
        out = io.BytesIO(make_epub())
        with zipfile.ZipFile(out, 'a') as archive:
            info = zipfile.ZipInfo('OEBPS/linked')
            info.create_system = 3
            info.external_attr = 0o120777 << 16
            archive.writestr(info, '/tmp/secret')
        self.reject(out.getvalue(), 'unsafe_archive_type')

    def test_zip_bomb_entry_count_units_and_xml_depth_limits(self):
        self.reject(make_epub(extra={'huge.txt': b'a' * (2 * 1024 * 1024)}), 'archive_limit')
        with patch('epub_import.MAX_ENTRIES', 2):
            self.reject(make_epub(), 'too_many_files')
        with patch('epub_import.MAX_UNITS', 1):
            self.reject(make_epub(), 'too_many_units')
        self.reject(make_epub(body='<html><body>' + '<div>' * 101 + 'deep' + '</div>' * 101 + '</body></html>'), 'xml_complexity')

    def test_entity_declarations_rejected_in_utf8_and_utf16(self):
        text = '<!DOCTYPE html [<!ENTITY stolen SYSTEM "file:///etc/passwd">]><html><body><p>&stolen;</p></body></html>'
        for encoding in ['utf-8', 'utf-16', 'utf-32']:
            self.reject(make_epub(extra={'OEBPS/text/one.xhtml': text.encode(encoding)}), 'unsafe_xml')
        self.assertEqual('html', safe_xml(b'<!DOCTYPE html><html/>').tag)

    def test_epub2_external_doctype_is_ignored_without_network(self):
        source = b'<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "https://example.invalid/external.dtd"><html><body><p>A&nbsp;paper &mdash; moon.</p></body></html>'
        _, data = self.imported(make_epub(extra={'OEBPS/text/one.xhtml': source}))
        self.assertEqual('A paper \u2014 moon.', data['units'][0]['en'][0]['text'])

    def test_remote_script_and_svg_are_never_embedded(self):
        body = '<html><body><p>Safe text <img src="https://example.invalid/secret.png" alt="remote"/></p><iframe src="https://example.invalid"/><svg><script>bad</script></svg><p>End.</p></body></html>'
        _, data = self.imported(make_epub(body=body))
        self.assertEqual({}, data['imagesById'])
        self.assertNotIn('https://', json.dumps(data))
        self.assertEqual(1, data['metadata']['skippedImageCount'])

    def test_image_mime_mismatch_is_not_published(self):
        _, data = self.imported(make_epub(extra={'OEBPS/images/dot.png': b'<svg onload="bad"/>'}))
        self.assertEqual({}, data['imagesById'])
        self.assertFalse(list(self.root.rglob('*.png')))

    def test_repeated_images_and_navigation_are_read_once(self):
        body = '<html><body><p>Original text</p>' + '<p><img src="../images/dot.png"/></p>' * 20 + '</body></html>'
        raw = make_epub(body=body)
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            opf = archive.read('OEBPS/book.opf').decode().replace('</manifest>', ''.join(f'<item id="nav{i}" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>' for i in range(20)) + '</manifest>')
        raw = make_epub(body=body, extra={'OEBPS/book.opf': opf.encode()})
        parser = EpubParser(raw, 'epub-' + hashlib.sha256(raw).hexdigest())
        with patch.object(parser, 'read', wraps=parser.read) as read:
            _, data, assets = parser.parse()
        self.assertEqual(1, sum(call.args[0] == 'OEBPS/images/dot.png' for call in read.call_args_list))
        self.assertEqual(1, sum(call.args[0] == 'OEBPS/nav.xhtml' for call in read.call_args_list))
        self.assertEqual(1, len(assets))
        self.assertEqual(20, len(next(iter(data['imagesById'].values()))['occurrences']))
        parser.zip.close()

    def test_library_symlink_boundaries(self):
        real = self.root.parent / 'real'
        real.mkdir()
        self.root.symlink_to(real, target_is_directory=True)
        with self.assertRaises(ImportFailure):
            import_epub(make_epub(), self.root)
        self.assertEqual([], list(real.iterdir()))
        self.root.unlink()
        book, _ = self.imported()
        reading = self.root / book['id'] / 'reading.json'
        reading.unlink()
        reading.symlink_to(real / 'secret')
        (real / 'secret').write_text('private')
        with self.assertRaises(ImportFailure):
            library_file(self.root, book['id'], 'reading.json')
        self.assertEqual([], list_books(self.root))

    def test_ncx_title_fallback(self):
        raw = make_epub(nav=False)
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            opf = archive.read('OEBPS/book.opf').decode().replace('</manifest>', '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>').replace('<spine>', '<spine toc="ncx">')
        ncx = b'<ncx><navMap><navPoint><navLabel><text>From NCX</text></navLabel><content src="text/one.xhtml"/></navPoint></navMap></ncx>'
        _, data = self.imported(make_epub(nav=False, extra={'OEBPS/book.opf': opf.encode(), 'OEBPS/toc.ncx': ncx}))
        self.assertEqual('From NCX', data['sections'][0]['title']['en'])

    def test_nonlinear_spine_text_is_kept_as_support(self):
        raw = make_epub()
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            opf = archive.read('OEBPS/book.opf').decode().replace('<itemref idref="two"/>', '<itemref idref="two" linear="no"/>')
        _, data = self.imported(make_epub(extra={'OEBPS/book.opf': opf.encode()}))
        self.assertEqual(['main', 'support'], [section['kind'] for section in data['sections']])
        self.assertIn('Morning folded the moon', data['units'][-1]['en'][0]['text'])

    def test_malformed_remote_image_url_is_skipped(self):
        _, data = self.imported(make_epub(body='<html><body><p>Original prose<img src="http://["/></p></body></html>'))
        self.assertEqual({}, data['imagesById'])
        self.assertEqual(1, data['metadata']['skippedImageCount'])


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name).resolve()
        self.app = root / 'app'
        self.app.mkdir()
        (self.app / 'index.html').write_text('<h1>Original test reader</h1>')
        (root / 'secret.txt').write_text('must stay private')
        self.patches = [patch.object(serve, 'APP', self.app), patch.object(serve, 'LIBRARY', root / 'user-library')]
        for p in self.patches:
            p.start()
        class QuietHandler(serve.ReaderHandler):
            def log_message(self, *args):
                pass
        self.server = serve.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host = f'127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        for p in reversed(self.patches):
            p.stop()
        self.temporary.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        status, content = response.status, response.read()
        connection.close()
        return status, content

    def import_headers(self):
        return {'Content-Type': 'application/epub+zip', 'Origin': 'http://' + self.host, 'X-Reader-Request': 'local-import'}

    def test_import_list_read_image_deduplicate_and_head(self):
        status, payload = self.request('GET', '/api/library')
        self.assertEqual(200, status)
        self.assertEqual({'books': [], 'legacyAvailable': False}, json.loads(payload))
        raw = make_epub()
        status, payload = self.request('POST', '/api/library/import', raw, self.import_headers())
        self.assertEqual(201, status)
        result = json.loads(payload)
        self.assertEqual('/?book=' + result['book']['id'], result['url'])
        url = '/api/library/' + result['book']['id'] + '/reading.json'
        status, payload = self.request('GET', url)
        self.assertEqual(200, status)
        image = next(iter(json.loads(payload)['imagesById'].values()))
        self.assertEqual((200, PNG), self.request('GET', image['localUrl']))
        self.assertEqual((200, b''), self.request('HEAD', url))
        status, payload = self.request('POST', '/api/library/import', raw, self.import_headers())
        self.assertEqual(result, json.loads(payload))
        self.assertEqual(1, len(json.loads(self.request('GET', '/api/library')[1])['books']))

    def test_origin_host_header_and_size_guards(self):
        headers = self.import_headers()
        variants = [{**headers, 'Origin': 'https://evil.example'}, {**headers, 'Origin': 'null'}, {**headers, 'Host': 'evil.example'}, {k: v for k, v in headers.items() if k != 'Origin'}, {k: v for k, v in headers.items() if k != 'X-Reader-Request'}, {**headers, 'Sec-Fetch-Site': 'cross-site'}]
        for variant in variants:
            self.assertEqual(403, self.request('POST', '/api/library/import', make_epub(), variant)[0])
        self.assertEqual(403, self.request('GET', '/', headers={'Host': 'evil.example'})[0])
        self.assertEqual(403, self.request('HEAD', '/', headers={'Host': 'evil.example'})[0])
        self.assertEqual(413, self.request('POST', '/api/library/import', b'', {**headers, 'Content-Length': str(MAX_EPUB_BYTES + 1)})[0])
        self.assertEqual(415, self.request('POST', '/api/library/import', b'bad', {**headers, 'Content-Type': 'text/plain'})[0])

    def test_static_root_and_symlink_not_exposed(self):
        (self.app / 'linked.txt').symlink_to(self.app.parent / 'secret.txt')
        for path in ['/../secret.txt', '/%2e%2e/secret.txt', '/linked.txt', '/user-library/', '/api/library/no-book/reading.json', '/api/library/' + 'epub-' + '0' * 64 + '/../../secret.txt']:
            status, payload = self.request('GET', path)
            self.assertIn(status, (403, 404))
            self.assertNotIn(b'must stay private', payload)

    def test_malformed_epub_error_is_json_and_does_not_add_book(self):
        status, payload = self.request('POST', '/api/library/import', b'bad', self.import_headers())
        self.assertEqual(400, status)
        self.assertEqual('invalid_epub', json.loads(payload)['reason'])
        self.assertEqual([], json.loads(self.request('GET', '/api/library')[1])['books'])


if __name__ == '__main__':
    unittest.main()
