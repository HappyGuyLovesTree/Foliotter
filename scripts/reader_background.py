#!/usr/bin/env python3
"""User-level launchd supervisor; the book and application stay on the external disk."""
import argparse
import html
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time
from urllib.request import ProxyHandler, build_opener


HTTP = build_opener(ProxyHandler({}))
APP_ID = 'red-book-local-reader'


def files_ready(root):
    try:
        for name in ('VERSION', 'scripts/serve.py', 'app/index.html'):
            with (root / name).open('rb') as source:
                if not source.read(1):
                    return False
        return True
    except OSError:
        return False


def signature(root):
    result = []
    for name in ('VERSION', 'scripts/serve.py', 'scripts/epub_import.py', 'scripts/book_import.py', 'scripts/import_worker.py', 'scripts/import_messages.py', 'scripts/runtime.py', '.venv/pyvenv.cfg', 'scripts/interpretations.py', 'scripts/interpretation_model.py'):
        path = root / name
        try:
            info = path.stat()
            result.append((name, info.st_ino, info.st_size, info.st_mtime_ns))
        except OSError:
            result.append((name, None))
    return tuple(result)


def healthy(port):
    try:
        with HTTP.open(f'http://127.0.0.1:{port}/api/health', timeout=2) as response:
            data = json.load(response)
        return isinstance(data, dict) and data.get('appId') == APP_ID and data.get('status') == 'ok'
    except (OSError, ValueError):
        return False


def port_busy(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=.5):
            return True
    except OSError:
        return False


def stop_child(child):
    if child is None:
        return
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)


def supervise(config, runtime, interval=3):
    root = Path(config['project'])
    port = config['port']
    stop = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    logger = logging.getLogger('redbook')
    logger.setLevel(logging.INFO)
    handler = RotatingFileHandler(runtime / 'service.log', maxBytes=1024 * 1024, backupCount=2, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
    logger.addHandler(handler)
    child = None
    state = None
    pending = None
    active_signature = None
    failures = 0

    def status(value):
        nonlocal state
        identity = (value, child.pid if child and child.poll() is None else None)
        if identity == state:
            return
        state = identity
        logger.info('%s; child=%s', *identity)
        target = runtime / 'status.json'
        temporary = target.with_suffix('.tmp')
        temporary.write_text(json.dumps({'state': value, 'supervisorPid': os.getpid(), 'serverPid': identity[1], 'project': str(root), 'port': port}, ensure_ascii=False) + '\n')
        temporary.replace(target)

    def collect_output(process):
        with process.stdout:
            for line in process.stdout:
                if 'GET /api/health ' not in line:
                    logger.info('server: %s', line.rstrip())

    try:
        while not stop.is_set():
            if not files_ready(root):
                stop_child(child)
                child = None
                status('waiting_for_project')
            elif child and child.poll() is not None:
                logger.warning('Server exited: %s', child.returncode)
                child = None
                status('restarting')
            elif child:
                current_signature = signature(root)
                if current_signature != active_signature:
                    if pending == current_signature:
                        stop_child(child)
                        child = None
                        status('app_updated')
                    else:
                        pending = current_signature
                else:
                    pending = None
                    failures = 0 if healthy(port) else failures + 1
                    if failures >= 3:
                        stop_child(child)
                        child = None
                        status('health_check_failed')
                    elif failures == 0:
                        status('running')
            elif port_busy(port):
                # Never terminate a process merely because it occupies our port.
                status('existing_reader' if healthy(port) else 'port_in_use')
            else:
                try:
                    active_signature = signature(root)
                    # The copied supervisor must also work when the external disk
                    # is absent. Select its project environment only after files_ready.
                    project_interpreter = root / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
                    python = str(project_interpreter) if (root / '.venv/pyvenv.cfg').is_file() and project_interpreter.is_file() else config['python']
                    child = subprocess.Popen([python, '-B', str(root / 'scripts/serve.py'), '--port', str(port)], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', env={**os.environ, 'PYTHONUNBUFFERED': '1'})
                    threading.Thread(target=collect_output, args=(child,), daemon=True).start()
                    failures = 0
                    pending = None
                    status('starting')
                except OSError as error:
                    logger.error('Cannot start reader: %s', error)
                    child = None
                    status('start_failed')
            stop.wait(interval)
    finally:
        stop_child(child)
        child = None
        status('stopped')
        handler.close()


def open_reader(config, runtime):
    target = f"gui/{os.getuid()}/{config['label']}"
    plist = Path.home() / 'Library/LaunchAgents' / (config['label'] + '.plist')
    if subprocess.run(['/bin/launchctl', 'print', target], capture_output=True).returncode:
        subprocess.run(['/bin/launchctl', 'enable', target], capture_output=True)
        subprocess.run(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], capture_output=True)
    subprocess.run(['/bin/launchctl', 'kickstart', target], capture_output=True)
    url = f"http://127.0.0.1:{config['port']}/"
    for _ in range(30):
        if files_ready(Path(config['project'])) and healthy(config['port']):
            return subprocess.run(['/usr/bin/open', url]).returncode
        time.sleep(.4)
    missing = not files_ready(Path(config['project']))
    message = 'The application folder is unavailable. Connect its disk and open Foliotter again.' if missing else 'The local reader is not ready yet. Try opening Foliotter again shortly. If this continues, check the local service log.'
    page = runtime / 'open-foliotter.html'
    page.write_text('<!doctype html><html lang="en"><meta charset="utf-8"><title>Foliotter</title><style>body{background:#f5efe3;color:#25221e;font:20px/1.8 system-ui;max-width:38em;margin:12vh auto;padding:24px}a{color:#a32b22}</style><h1>Foliotter</h1><p>' + html.escape(message) + '</p><p><a href="' + url + '">Open the reader again</a></p>', encoding='utf-8')
    subprocess.run(['/usr/bin/open', str(page)])
    return 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('run', 'open'))
    parser.add_argument('--config', type=Path, default=Path(__file__).with_name('config.json'))
    parser.add_argument('--interval', type=float, default=3)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    runtime = args.config.parent
    if args.action == 'open':
        return open_reader(config, runtime)
    supervise(config, runtime, max(.1, args.interval))
    return 0


if __name__ == '__main__':
    sys.exit(main())
