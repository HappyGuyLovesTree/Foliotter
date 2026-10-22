#!/usr/bin/env python3
"""Disposable local parser process. Parent enforces timeout and disk limits."""
import json
import os
from pathlib import Path
import sys


def resource_limits():
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (45, 45))
        resource.setrlimit(resource.RLIMIT_FSIZE, (180 * 1024 * 1024, 180 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
        # macOS maps its shared system cache into each process; RLIMIT_AS there
        # is not a reliable resident-memory cap. Linux can enforce this bound.
        if sys.platform.startswith('linux'):
            resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
    except (ImportError, ValueError, OSError):
        pass


def main():
    resource_limits()
    # Our parser has no network use. Deny accidental socket activity from a
    # Python dependency as well. The external converter only reads local files.
    def audit(event, args):
        if event in ('socket.connect', 'socket.connect_ex', 'socket.getaddrinfo', 'socket.sendto'):
            raise RuntimeError('Network access is disabled during ebook import')
    sys.addaudithook(audit)
    from book_import import EpubParser, ImportFailure, parse_fb2, parse_mobi, parse_pdf, parse_txt
    work = Path(sys.argv[1]).resolve()
    request = json.loads((work / 'request.json').read_text(encoding='utf-8'))
    format_name, book_id = request['format'], request['bookId']
    source = work / ('source.' + format_name)
    try:
        if format_name == 'epub':
            parser = EpubParser(source.read_bytes(), book_id)
            try:
                book, data, assets = parser.parse()
            finally:
                parser.zip.close()
        elif format_name in ('mobi', 'azw3'):
            book, data, assets = parse_mobi(source, book_id, format_name, request['filename'], work)
        else:
            parser = {'txt': parse_txt, 'pdf': parse_pdf, 'fb2': parse_fb2}[format_name]
            book, data, assets = parser(source.read_bytes(), book_id, request['filename'])
        (work / 'assets').mkdir()
        for filename, raw in assets.items():
            (work / 'assets' / filename).write_bytes(raw)
        result = {'book': book, 'data': data}
    except ImportFailure as error:
        result = {'error': {'reason': error.reason, 'notice': error.notice, 'status': error.status}}
    except Exception:
        result = {'error': {'reason': 'conversion_failed', 'notice': '本地解析或转换失败；文件可能损坏或使用不支持的变体。', 'status': 400}}
    (work / 'result.json').write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


if __name__ == '__main__':
    main()
