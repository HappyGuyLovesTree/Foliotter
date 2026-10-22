#!/usr/bin/env python3
"""Local-only reader with per-unit verified bilingual interpretations."""
import argparse
import json
import re
import socket
from pathlib import Path
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse, unquote

ROOT = Path(__file__).resolve().parents[1]
if __name__ == '__main__':
    from runtime import prefer_project_python
    prefer_project_python(ROOT)
APP = ROOT / 'app'
CANDIDATE = ROOT / 'data/fullbook-candidate'
VERSION = (ROOT / 'VERSION').read_text(encoding='utf-8').strip()
if not VERSION:
    raise ValueError('VERSION must not be empty')
BUILD = '2026-10-22.english-public-1'
LIBRARY = ROOT / 'user-library'
DATA_LOCK = threading.RLock()
DATA_CACHE = {}
from interpretations import snapshot as interpretation_snapshot, stamp
from epub_import import list_books, library_file, ImportFailure, MAX_EPUB_BYTES
from book_import import FORMATS, capabilities, import_book
from import_messages import EN, notice


def reading_data(dataset):
    path = APP / 'data/reading.json' if dataset == 'active' else CANDIDATE / 'reading.json'
    stat = path.stat()
    signature = (str(path), stat.st_ino, stat.st_mtime_ns, stat.st_size)
    with DATA_LOCK:
        previous = DATA_CACHE.get(dataset)
        if previous and previous[0] == signature:
            return previous[1:]
        data = json.loads(path.read_text())
        if data.get('schemaVersion', 1) not in (1, 2):
            raise ValueError('Unsupported reading schema')
        units = {u['id']: u for u in data['units']}
        if len(units) != len(data['units']):
            raise ValueError('Duplicate unit identities')
        DATA_CACHE[dataset] = (signature, data, units)
        return data, units


class ReaderHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP), **kwargs)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        super().end_headers()

    def local_request(self, mutation=False):
        hosts = self.headers.get_all('Host', [])
        allowed = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        if self.server.server_port == 80:
            allowed.update({'127.0.0.1', 'localhost'})
        if len(hosts) != 1 or hosts[0] not in allowed:
            self.json_response({'status': 'error', 'reason': 'invalid_host', 'notice': '仅允许通过本机 localhost 或 127.0.0.1 访问。'}, 403)
            return False
        origins = self.headers.get_all('Origin', [])
        if len(origins) > 1 or (origins and origins[0] != 'http://' + hosts[0]) or self.headers.get('Sec-Fetch-Site') == 'cross-site':
            self.json_response({'status': 'error', 'reason': 'invalid_origin', 'notice': '仅允许本机阅读页面同源访问。'}, 403)
            return False
        if mutation and (origins != ['http://' + hosts[0]] or self.headers.get_all('X-Reader-Request', []) != ['local-import']):
            self.json_response({'status': 'error', 'reason': 'import_origin', 'notice': '请从本机书架页面选择电子书导入。'}, 403)
            return False
        return True

    def import_error(self, error):
        return self.json_response({'status': 'error', 'reason': error.reason, 'notice': error.notice}, error.status)

    def do_POST(self):
        self.close_connection = True
        if not self.local_request(mutation=True):
            return
        if urlparse(self.path).path != '/api/library/import':
            return self.json_response({'status': 'error', 'reason': 'not_found', 'notice': '没有此接口。'}, 404)
        content_types = self.headers.get_all('Content-Type', [])
        content_type = content_types[0].split(';', 1)[0].strip().lower() if len(content_types) == 1 else ''
        if self.headers.get('Transfer-Encoding') or content_type not in {*FORMATS.values(), 'application/octet-stream', 'application/fb2+xml'}:
            return self.json_response({'status': 'error', 'reason': 'invalid_content_type', 'notice': '请选择 EPUB、PDF、TXT、MOBI、AZW3 或 FB2 文件。'}, 415)
        filenames = self.headers.get_all('X-File-Name', [])
        if len(filenames) > 1 or (filenames and (len(filenames[0]) > 4096 or re.search(r'%(?![0-9A-Fa-f]{2})', filenames[0]))):
            return self.json_response({'status': 'error', 'reason': 'invalid_filename', 'notice': '文件名无效，请重新选择电子书。'}, 400)
        try:
            filename = unquote(filenames[0], encoding='utf-8', errors='strict') if filenames else ''
        except UnicodeError:
            return self.json_response({'status': 'error', 'reason': 'invalid_filename', 'notice': '文件名无效，请重新选择电子书。'}, 400)
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,12}', lengths[0]):
            return self.json_response({'status': 'error', 'reason': 'invalid_length', 'notice': '缺少有效的文件长度。'}, 400)
        length = int(lengths[0])
        if length <= 0 or length > MAX_EPUB_BYTES:
            return self.json_response({'status': 'error', 'reason': 'file_too_large', 'notice': '请选择非空且不超过 60 MiB 的电子书。'}, 413)
        try:
            self.connection.settimeout(30)
            raw = self.rfile.read(length)
            if len(raw) != length:
                return self.json_response({'status': 'error', 'reason': 'incomplete_upload', 'notice': '文件传输不完整，请重新选择。'}, 400)
            book = import_book(raw, LIBRARY, filename, content_type)
            return self.json_response({'book': book, 'url': '/?book=' + book['id']}, 201)
        except ImportFailure as error:
            return self.import_error(error)
        except (socket.timeout, TimeoutError):
            return self.json_response({'status': 'error', 'reason': 'upload_timeout', 'notice': '本机文件传输超时，请重试。'}, 408)
        except (OSError, ValueError):
            return self.json_response({'status': 'error', 'reason': 'import_failed', 'notice': '导入未完成；请检查电子书格式和本地磁盘空间。已有书籍已保留。'}, 500)

    def json_response(self, data, status=200):
        if isinstance(data, dict) and data.get('reason') in EN and 'notice' in data:
            language = 'zh' if self.headers.get('X-UI-Language') == 'zh' else 'en'
            data = {**data, 'notice': notice(data['reason'], data['notice'], language)}
        body = json.dumps(data, ensure_ascii=False).encode()
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if not self.local_request():
            return
        parsed = urlparse(self.path)
        if parsed.path.startswith('/api/') and self.headers.get('Sec-Fetch-Site') == 'cross-site':
            return self.json_response({'status': 'error', 'reason': 'invalid_origin', 'notice': '仅供本机阅读界面调用。'}, 403)
        if parsed.path == '/api/health':
            return self.json_response({'status': 'ok', 'appId': 'red-book-local-reader', 'mode': 'local-only', 'interpretationSchema': 'interpretations-3', 'version': VERSION, 'build': BUILD, 'time': stamp()})
        if parsed.path == '/api/library':
            try:
                return self.json_response({'books': list_books(LIBRARY), 'legacyAvailable': (APP / 'data/reading.json').is_file()})
            except ImportFailure as error:
                return self.import_error(error)
            except OSError:
                return self.json_response({'status': 'error', 'reason': 'library_unavailable', 'notice': '无法读取本地书架，请检查磁盘是否可用。'}, 503)
        if parsed.path == '/api/library/capabilities':
            return self.json_response(capabilities())
        if parsed.path.startswith('/api/library/'):
            stream = self.library_stream()
            if stream:
                try:
                    self.copyfile(stream, self.wfile)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    stream.close()
            return
        if parsed.path == '/api/related':
            qs = parse_qs(parsed.query, keep_blank_values=True)
            dataset_values = qs.get('dataset', ['active'])
            if len(dataset_values) != 1 or dataset_values[0] not in ('active', 'candidate'):
                return self.json_response({'status': 'error', 'reason': 'invalid_dataset', 'results': []}, 400)
            dataset = dataset_values[0]
            try:
                data, units = reading_data(dataset)
            except (OSError, ValueError, KeyError, TypeError):
                return self.json_response({'dataset': dataset, 'status': 'unavailable', 'reason': 'source_missing', 'notice': '阅读数据暂不可用，未启动联网。', 'results': [], 'research': {'running': False, 'phase': 'not_configured'}}, 503)
            unit = units.get(qs.get('unit', [''])[0])
            if unit is None:
                return self.json_response({'dataset': dataset, 'status': 'error', 'reason': 'unit_not_found', 'notice': '未找到这一阅读单元。', 'results': []}, 404)
            try:
                answer = interpretation_snapshot(unit, data.get('metadata', {}), qs.get('refresh') == ['1'], qs.get('poll') == ['1'], dataset=dataset)
            except ValueError:
                return self.json_response({'dataset': dataset, 'datasetId': data.get('metadata', {}).get('datasetId'), 'unitId': unit['id'], 'status': 'error', 'reason': 'fingerprint_mismatch', 'notice': '正文版本或单元指纹变化，解读映射需要重新核对。', 'results': [], 'research': {'running': False, 'phase': 'failed'}}, 409)
            return self.json_response(answer)
        if parsed.path.startswith('/api/'):
            return self.json_response({'status': 'error'}, 404)
        return super().do_GET()

    def library_stream(self):
        path = unquote(urlparse(self.path).path)
        match = re.fullmatch(r'/api/library/((?:epub|pdf|txt|mobi|azw3|fb2)-[0-9a-f]{64})/(reading\.json|assets/[0-9a-f]{64}\.(?:png|jpg|gif|webp))', path)
        if not match:
            self.json_response({'status': 'error', 'reason': 'not_found', 'notice': '未找到这项书籍资源。'}, 404)
            return None
        try:
            target = library_file(LIBRARY, match[1], match[2])
            stream = target.open('rb')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8' if match[2] == 'reading.json' else self.guess_type(str(target)))
            self.send_header('Content-Length', str(target.stat().st_size))
            self.end_headers()
            return stream
        except ImportFailure as error:
            self.import_error(error)
        except OSError:
            self.json_response({'status': 'error', 'reason': 'not_found', 'notice': '未找到这项书籍资源。'}, 404)
        return None

    def do_HEAD(self):
        if not self.local_request():
            return
        if urlparse(self.path).path.startswith('/api/library/'):
            stream = self.library_stream()
            if stream:
                stream.close()
            return
        return super().do_HEAD()

    def send_head(self):
        # Shared by GET and HEAD: neither method can bypass the path boundary.
        decoded = unquote(urlparse(self.path).path)
        if '\\' in decoded or '\x00' in decoded or any(x in ('.', '..') for x in decoded.split('/')):
            self.send_error(403)
            return None
        if decoded.startswith('/candidate/'):
            relative = decoded.removeprefix('/candidate/')
            target = (CANDIDATE / relative).resolve()
            allowed = (relative == 'reading.json' and target == CANDIDATE.resolve() / 'reading.json')
            if relative.startswith('assets/') and target.is_relative_to((CANDIDATE / 'assets').resolve()):
                try:
                    data, _ = reading_data('candidate')
                    allowed = relative in {i.get('candidatePath') for i in data.get('imagesById', {}).values()}
                except (OSError, ValueError, KeyError, TypeError):
                    allowed = False
            if not target.is_relative_to(CANDIDATE.resolve()) or not allowed:
                self.send_error(403)
                return None
            try:
                stream = target.open('rb')
            except OSError:
                self.send_error(404)
                return None
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(str(target)))
            self.send_header('Content-Length', str(target.stat().st_size))
            self.end_headers()
            return stream
        target = Path(self.translate_path(urlparse(self.path).path)).resolve()
        if not target.is_relative_to(APP.resolve()) or target.suffix.lower() == '.epub':
            self.send_error(403)
            return None
        if target.is_dir():
            index = (target / 'index.html').resolve()
            if not index.is_relative_to(APP.resolve()):
                self.send_error(403)
                return None
            if not index.is_file():
                self.send_error(404)
                return None
        return super().send_head()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--open', action='store_true', help='Open the local reader in the default browser')
    args = parser.parse_args()
    print(f'Foliotter: http://127.0.0.1:{args.port}', flush=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), ReaderHandler)
    if args.open:
        webbrowser.open(f'http://127.0.0.1:{args.port}')
    server.serve_forever()
