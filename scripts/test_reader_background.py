#!/usr/bin/env python3
"""Isolated supervisor integration checks; never use 8787 or user storage."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.request import ProxyHandler, build_opener


ROOT = Path(__file__).resolve().parents[1]
SUPERVISOR = ROOT / 'scripts/reader_background.py'
HTTP = build_opener(ProxyHandler({}))
FAKE_SERVER = '''import argparse,json,os
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  body=json.dumps({'status':'ok','appId':'red-book-local-reader','pid':os.getpid()}).encode()
  self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def log_message(self,*args): pass
p=argparse.ArgumentParser();p.add_argument('--port',type=int);args=p.parse_args()
ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
'''


def fresh_port():
    while True:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        if port != 8787:
            return port


def process_exists(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def health(port):
    with HTTP.open(f'http://127.0.0.1:{port}/api/health', timeout=.5) as response:
        return json.load(response)


class Session:
    def __init__(self, directory, port):
        self.root = Path(directory) / 'external disk' / '荣格红书'
        self.runtime = Path(directory) / 'runtime'
        self.runtime.mkdir()
        self.port = port
        self.process = None
        self.owned = set()
        self.config = self.runtime / 'config.json'
        self.config.write_text(json.dumps({'project': str(self.root), 'port': port,
            'python': sys.executable, 'label': 'test.redbook.never-installed'}))

    def populate(self):
        for name, text in {'VERSION': '0.0.1\n', 'scripts/serve.py': FAKE_SERVER,
                           'app/index.html': '<title>Fixture</title>',
                           'app/data/reading.json': '{"fixture":true}'}.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)

    def start(self):
        assert self.port != 8787
        self.process = subprocess.Popen([sys.executable, '-B', str(SUPERVISOR), 'run',
            '--config', str(self.config), '--interval', '.1'],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def status(self):
        try:
            result = json.loads((self.runtime / 'status.json').read_text())
            if result.get('serverPid'):
                self.owned.add(result['serverPid'])
            return result
        except (OSError, ValueError):
            return {}

    def wait(self, predicate, description, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = self.status()
            if predicate(value):
                return value
            if self.process.poll() is not None:
                output = self.process.communicate()
                raise AssertionError(f'Supervisor exited while waiting for {description}: {output}')
            time.sleep(.03)
        log = self.runtime / 'service.log'
        raise AssertionError(f'Timeout: {description}; status={self.status()}; log={log.read_text() if log.exists() else "none"}')

    def running(self, different_from=None):
        result = self.wait(lambda row: row.get('state') == 'running' and row.get('serverPid') != different_from,
            'healthy managed child')
        self.assert_owned(result['serverPid'])
        return result['serverPid']

    def assert_owned(self, pid):
        assert pid in self.owned
        command = subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'args='], text=True)
        assert str(self.root / 'scripts/serve.py') in command, command
        assert health(self.port)['pid'] == pid

    def close(self):
        self.status()
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        if self.process:
            self.process.communicate()
        # Cleanup is limited to PIDs emitted by this isolated supervisor, and
        # only if their command still names this session's temporary server.
        for pid in self.owned:
            if not process_exists(pid):
                continue
            result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'args='], capture_output=True, text=True)
            if str(self.root / 'scripts/serve.py') in result.stdout:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


@contextmanager
def session(port=None):
    with tempfile.TemporaryDirectory(prefix='redbook-supervisor-', dir='/private/tmp') as directory:
        value = Session(directory, port or fresh_port())
        try:
            yield value
        finally:
            value.close()


class SupervisorIntegration(unittest.TestCase):
    def test_missing_disk_waits_then_starts_and_recovers_after_content_returns(self):
        with session() as value:
            value.start()
            waiting = value.wait(lambda row: row.get('state') == 'waiting_for_project', 'missing project wait')
            self.assertIsNone(waiting['serverPid'])
            value.populate()
            first = value.running()
            index = value.root / 'app/index.html'
            index.unlink()
            value.wait(lambda row: row.get('state') == 'waiting_for_project', 'removed source wait')
            self.assertFalse(process_exists(first))
            index.write_text('<title>Fixture restored</title>')
            second = value.running(different_from=first)
            self.assertNotEqual(first, second)

    def test_child_crash_and_in_place_version_update_restart_only_owned_server(self):
        with session() as value:
            value.populate();value.start()
            first = value.running()
            value.assert_owned(first)
            os.kill(first, signal.SIGKILL)
            second = value.running(different_from=first)
            version = value.root / 'VERSION'
            old = version.stat()
            # Keep the inode and byte length unchanged: mtime must detect this.
            with version.open('r+') as target:
                target.write('0.0.2\n');target.truncate()
            os.utime(version, ns=(old.st_atime_ns, old.st_mtime_ns + 2_000_000_000))
            self.assertEqual(version.stat().st_ino, old.st_ino)
            third = value.running(different_from=second)
            self.assertNotEqual(second, third)
            self.assertFalse(process_exists(second))

    def test_foreign_listener_survives_dict_and_non_object_json_health(self):
        for response in ({'status': 'ok', 'appId': 'unrelated-app'}, ['another application']):
            with self.subTest(response=response):
                class ForeignHandler(BaseHTTPRequestHandler):
                    def do_GET(self):
                        body = json.dumps(response).encode()
                        self.send_response(200);self.send_header('Content-Length', str(len(body)))
                        self.end_headers();self.wfile.write(body)
                    def log_message(self, *_):
                        pass
                server = ThreadingHTTPServer(('127.0.0.1', 0), ForeignHandler)
                self.assertNotEqual(server.server_port, 8787)
                thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.02), daemon=True)
                thread.start()
                try:
                    with session(server.server_port) as value:
                        value.populate();value.start()
                        status = value.wait(lambda row: row.get('state') == 'port_in_use', 'unrelated listener wait')
                        self.assertIsNone(status['serverPid'])
                        time.sleep(.35)
                        self.assertIsNone(value.process.poll())
                        self.assertTrue(thread.is_alive())
                        self.assertEqual(health(server.server_port), response)
                        self.assertEqual(value.owned, set())
                        server.shutdown();server.server_close();thread.join(timeout=2)
                        value.running()
                finally:
                    server.shutdown();server.server_close();thread.join(timeout=2)

    def test_sigterm_reaps_owned_child_in_default_process_group(self):
        with session() as value:
            value.populate();value.start()
            child = value.running()
            self.assertEqual(os.getpgid(child), os.getpgid(value.process.pid))
            value.process.terminate()
            value.process.wait(timeout=8)
            self.assertEqual(value.process.returncode, 0)
            self.assertFalse(process_exists(child))
            self.assertEqual(value.status()['state'], 'stopped')
            self.assertIsNone(value.status()['serverPid'])

    def test_code_only_installation_starts_without_any_book(self):
        with session() as value:
            value.populate()
            (value.root / 'app/data/reading.json').unlink()
            value.start()
            value.running()
            self.assertFalse((value.root / 'app/data/reading.json').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
