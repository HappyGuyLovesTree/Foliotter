#!/usr/bin/env python3
"""Build code-only or personal offline ZIPs from an explicit file allowlist."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CODE_NAMES = ['README.md', 'NOTICE.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
              'SECURITY.md', 'CONTRIBUTING.md', 'VERSION', '.gitignore',
              'Install Foliotter.command', 'Start Foliotter.command', 'requirements-import.txt']
APP_NAMES = ['index.html', 'redbook.svg', 'artwork-guides.js', 'encounter-core.js',
             'encounter-fixture.js', 'encounter-qa.js', 'encounter.js', 'reader.js',
             'reading-aids.css', 'reading-aids.js', 'reading-alignment.js',
             'reading-context.js', 'reading-dictionary-core.js',
             'reading-dictionary.css', 'reading-dictionary.js', 'reading-pages.css',
             'reading-pages.js', 'records-lock-qa.js', 'records-qa-fixture.js',
             'records.js', 'styles.css', 'library.html', 'library.js', 'library.css', 'i18n.js',
             'reading-language.js', 'reader-notices.js']
SCRIPT_NAMES = ['serve.py', 'interpretations.py', 'interpretation_model.py',
                'reader_background.py', 'install_background_service.py',
                'package_reader.py', 'install_local_content.py', 'build_icon.cjs',
                'test_reading_pages.cjs', 'test_reader_background.py', 'test_packaging.py',
                'epub_import.py', 'test_epub_import.py',
                'audit_release.py', 'test_audit_release.py', 'test_install_background.py',
                'test_reader_import.cjs', 'runtime.py', 'setup_importers.py', 'test_runtime.py',
                'book_import.py', 'import_worker.py', 'import_messages.py', 'test_book_import.py',
                'test_i18n.cjs', 'test_reading_language.cjs', 'test_record_notices.cjs']
PACKAGING_NAMES = ['redbook.svg', 'redbook.png', 'RedBook.icns']
# This is deliberately a fixed list: a new JS, CSS or image may contain private
# content. Adding a distributable file requires an explicit review here and in
# .gitignore; never discover public files with a glob.
PACKAGE_DIRECTORY = 'Foliotter'
DATA_FILES = ['data/interpretation_targets.json', 'data/verified_interpretations.json',
              'data/source_discovery_hints.json', 'data/fullbook-candidate/reading.json']
DATA_TREES = ['app/data', 'data/fullbook-candidate/assets']


def code_paths(root):
    names = CODE_NAMES + ['scripts/' + name for name in SCRIPT_NAMES]
    names += ['app/' + name for name in APP_NAMES]
    names += ['packaging/' + name for name in PACKAGING_NAMES]
    return sorted(set(names))


def content_paths(root):
    names = list(DATA_FILES)
    for directory in DATA_TREES:
        names += [p.relative_to(root).as_posix() for p in sorted((root / directory).rglob('*')) if p.is_file()]
    return sorted(set(names))


def checked(root, names):
    files = {}
    for name in names:
        p = root / name
        if p.is_symlink() or not p.is_file() or not p.resolve().is_relative_to(root.resolve()):
            raise ValueError('Missing or unsafe package member: ' + name)
        files[name] = p.read_bytes()
    return files


def build(root, destination, personal=False, replace=False):
    files = checked(root, code_paths(root) + (content_paths(root) if personal else []))
    # Apply the same content checks to the exact bytes going into a public ZIP.
    # Imported libraries are intentionally absent even from the legacy personal
    # package; users must back up their library explicitly.
    if not personal:
        from audit_release import scan_file
        findings = [finding for name, raw in files.items()
                    for finding in scan_file(name, raw, 'package')]
        if findings:
            locations = ', '.join(f"{f['path']}:{f.get('line', 0)} ({f['code']})" for f in findings)
            raise ValueError('Public package audit failed: ' + locations)
    manifest = {'schemaVersion': 1, 'kind': 'personal-offline' if personal else 'code-only',
                'version': (root / 'VERSION').read_text().strip(),
                'files': {name: hashlib.sha256(raw).hexdigest() for name, raw in sorted(files.items())}}
    if destination.exists() and not replace:
        raise ValueError('Refusing to overwrite an existing package: ' + str(destination))
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + '.tmp')
    try:
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, raw in sorted(files.items()):
                info = zipfile.ZipInfo(PACKAGE_DIRECTORY + '/' + name, (2026, 10, 22, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                mode = 0o755 if name.endswith('.command') else 0o644
                info.external_attr = (0o100000 | mode) << 16
                archive.writestr(info, raw)
            archive.writestr(PACKAGE_DIRECTORY + '/package-manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip():
                raise ValueError('ZIP verification failed')
            for name, expected in manifest['files'].items():
                if hashlib.sha256(archive.read(PACKAGE_DIRECTORY + '/' + name)).hexdigest() != expected:
                    raise ValueError('Packaged bytes differ: ' + name)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return {'path': str(destination.resolve()), 'kind': manifest['kind'], 'files': len(files),
            'bytes': destination.stat().st_size, 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--personal', action='store_true', help='Includes local copyrighted reading data; never upload')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--replace', action='store_true', help='Atomically replace a previously generated package')
    args = parser.parse_args()
    print(json.dumps(build(ROOT, args.output, args.personal, args.replace), ensure_ascii=False, indent=2))
