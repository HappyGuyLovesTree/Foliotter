#!/usr/bin/env python3
"""Audit the public file allowlist, Git refs/history, or a code-only ZIP.

Reports locations and finding categories, never matched credentials or passages.
The checks are release guards, not a guarantee of ownership or a secret detector
for every possible credential format. Review changes before expanding the list.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import zipfile

from package_reader import ROOT, code_paths

BINARY_FILES = frozenset(('packaging/redbook.png', 'packaging/RedBook.icns'))
# The only shipped images are reviewed original geometric icons. Replacing an
# approved filename with a book scan must not bypass the public file allowlist.
ORIGINAL_ICON_SHA256 = {
    'app/redbook.svg': '6082e047508a200104ef3b69853bca9e022c3288c9ac660b30b6aff1eb796ed3',
    'packaging/redbook.svg': '6082e047508a200104ef3b69853bca9e022c3288c9ac660b30b6aff1eb796ed3',
    'packaging/redbook.png': '2bf58c6860e57943c3d75b475f9427b943a1d646d99e41356270f9166f05b7fd',
    'packaging/RedBook.icns': 'b17cd1efaaa0f203fceb0610fbb4095914d8f067354dc20a0c7be548326bd882',
}
MAX_PUBLIC_FILE_BYTES = 2 * 1024 * 1024
MAX_ZIP_BYTES = 16 * 1024 * 1024
# Previous public releases used localized launcher names. Only their already
# reviewed bytes remain allowed in history; new packages use English filenames.
HISTORICAL_LAUNCHER_SHA256 = {
    '\u542f\u52a8\u9605\u8bfb.command': {
        '0508a5776bd0f7eb46ab9e1a036ab1068e3b696521e9ceeb8e9e2165bb068b43',
        '5a71eaa291b57f39e95f5034148c6afba9ebebd836c1bac88b3931e140e20b5c',
    },
    '\u5b89\u88c5\u684c\u9762\u5165\u53e3.command': {
        '5b444b979a7be22193e205743ca2ffbe7a7aa03ac673594514db4c66d1d4942d',
        'c2d401d4da986991a488c95de7b21830c8a27009fd9f457c953b8c1f1c86c257',
    },
}
CJK_TEXT = re.compile(r'[\u3400-\u9fff]')
# Construct synthetic test values from parts so tests do not look like secrets.
PATTERNS = (
    ('credential', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{25,}|AKIA[0-9A-Z]{16})\b')),
    ('private-key', re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----')),
    ('private-path', re.compile(r'/(?:Users|Volumes|home)/[^\s\x27\x22`<>]+')),
    ('credential-assignment', re.compile(r'''(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*["']([A-Za-z0-9/+_.=-]{24,})["']''')),
)


def issue(scope, path, code, line=None, object_id=None):
    finding = {'scope': scope, 'path': path, 'code': code}
    if line is not None:
        finding['line'] = line
    if object_id:
        finding['object'] = object_id
    return finding


def allowed_path(name):
    path = PurePosixPath(name)
    return (not path.is_absolute() and '..' not in path.parts and '\\' not in name
            and name in code_paths(ROOT))


def scan_file(name, raw, scope, object_id=None):
    """Check exact candidate bytes without printing their contents."""
    findings = []
    reviewed_history = scope == 'git-history' and hashlib.sha256(raw).hexdigest() in HISTORICAL_LAUNCHER_SHA256.get(name, ())
    if not allowed_path(name) and not reviewed_history:
        findings.append(issue(scope, name, 'not-public-allowlist', object_id=object_id))
    if scope != 'git-history' and not name.isascii():
        findings.append(issue(scope, name, 'non-english-public-filename', object_id=object_id))
    if len(raw) > MAX_PUBLIC_FILE_BYTES:
        findings.append(issue(scope, name, 'oversized-public-file', object_id=object_id))
    if name in ORIGINAL_ICON_SHA256 and hashlib.sha256(raw).hexdigest() != ORIGINAL_ICON_SHA256[name]:
        findings.append(issue(scope, name, 'unreviewed-icon-content', object_id=object_id))
    if name in BINARY_FILES:
        signature = b'\x89PNG\r\n\x1a\n' if name.endswith('.png') else b'icns'
        if not raw.startswith(signature):
            findings.append(issue(scope, name, 'invalid-icon-format', object_id=object_id))
        return findings
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        findings.append(issue(scope, name, 'unexpected-binary-content', object_id=object_id))
        return findings
    for number, line in enumerate(text.splitlines(), 1):
        if scope != 'git-history' and name.endswith('.md') and CJK_TEXT.search(line):
            findings.append(issue(scope, name, 'non-english-public-documentation', number, object_id))
        for code, pattern in PATTERNS:
            if pattern.search(line):
                findings.append(issue(scope, name, code, number, object_id))
    return findings


def audit_worktree(root):
    findings = []
    for name in code_paths(root):
        path = root / name
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            findings.append(issue('package', name, 'missing-or-unsafe-file'))
            continue
        findings.extend(scan_file(name, path.read_bytes(), 'package'))
    return findings


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)


def audit_git(root):
    """Scan index contents and all trees reachable from any ref, including trees.

    A deleted private document still blocks publishing existing history. A fresh
    repository exported from the reviewed code-only package can pass separately.
    """
    findings = []
    try:
        git(root, 'rev-parse', '--git-dir')
    except subprocess.CalledProcessError:
        return [issue('git', '.git', 'not-a-git-repository')], {'refs': 0, 'trees': 0, 'blobs': 0}
    entries = []
    for entry in git(root, 'ls-files', '--stage', '-z').split(b'\0'):
        if entry:
            meta, path = entry.split(b'\t', 1)
            mode, oid, stage = meta.decode().split()
            name = path.decode('utf-8', errors='replace')
            if stage != '0':
                findings.append(issue('git-index', name, 'unmerged-index'))
            entries.append(('git-index', name, mode, oid))
    refs = git(root, 'for-each-ref', '--format=%(refname)').decode().splitlines()
    revisions = set(git(root, 'rev-list', '--all').decode().splitlines())
    revisions.update(refs)
    trees = set()
    for revision in sorted(revisions):
        try:
            tree = git(root, 'rev-parse', revision + '^{tree}').decode().strip()
        except subprocess.CalledProcessError:
            # Unusual blob/tag refs are still audited rather than silently skipped.
            oid = git(root, 'rev-parse', revision + '^{}').decode().strip()
            kind = git(root, 'cat-file', '-t', oid).decode().strip()
            if kind == 'blob':
                entries.append(('git-history', '(unnamed ref blob)', '100644', oid))
            continue
        if tree in trees:
            continue
        trees.add(tree)
        for entry in git(root, 'ls-tree', '-r', '-z', tree).split(b'\0'):
            if entry:
                meta, path = entry.split(b'\t', 1)
                mode, kind, oid = meta.decode().split()
                entries.append(('git-history', path.decode('utf-8', errors='replace'), mode, oid))
    contents = {}
    seen = set()
    for scope, name, mode, oid in entries:
        identity = scope, name, mode, oid
        if identity in seen:
            continue
        seen.add(identity)
        if mode not in ('100644', '100755'):
            findings.append(issue(scope, name, 'symlink-or-submodule', object_id=oid))
            continue
        if oid not in contents:
            contents[oid] = git(root, 'cat-file', 'blob', oid)
        findings.extend(scan_file(name, contents[oid], scope, oid))
    return findings, {'refs': len(refs), 'trees': len(trees), 'blobs': len(contents)}


def audit_zip(path):
    findings = []
    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            if sum(member.file_size for member in members) > MAX_ZIP_BYTES:
                return [issue('zip', path.name, 'archive-too-large')]
            names = [member.filename for member in members]
            if len(names) != len(set(names)):
                findings.append(issue('zip', path.name, 'duplicate-members'))
            roots = {name.split('/', 1)[0] for name in names}
            if len(roots) != 1 or not all('/' in name for name in names):
                return findings + [issue('zip', path.name, 'invalid-root-directory')]
            prefix = next(iter(roots)) + '/'
            if prefix.startswith(('/', '../')) or '\\' in prefix:
                return findings + [issue('zip', path.name, 'invalid-root-directory')]
            expected = set(code_paths(ROOT))
            actual = {name[len(prefix):] for name in names}
            if actual != expected | {'package-manifest.json'}:
                for name in sorted(actual - expected - {'package-manifest.json'}):
                    findings.append(issue('zip', name, 'unexpected-package-member'))
                for name in sorted(expected - actual):
                    findings.append(issue('zip', name, 'missing-package-member'))
            for member in members:
                name = member.filename[len(prefix):]
                if stat.S_ISLNK(member.external_attr >> 16):
                    findings.append(issue('zip', name, 'symlink-member'))
                if name != 'package-manifest.json':
                    findings.extend(scan_file(name, archive.read(member), 'zip'))
            manifest = json.loads(archive.read(prefix + 'package-manifest.json'))
            if not isinstance(manifest, dict):
                return findings + [issue('zip', 'package-manifest.json', 'invalid-manifest')]
            if set(manifest) != {'schemaVersion', 'kind', 'version', 'files'}:
                findings.append(issue('zip', 'package-manifest.json', 'unexpected-manifest-fields'))
            if manifest.get('schemaVersion') != 1 or manifest.get('kind') != 'code-only':
                findings.append(issue('zip', 'package-manifest.json', 'not-code-only-manifest'))
            if manifest.get('version') != archive.read(prefix + 'VERSION').decode('utf-8').strip():
                findings.append(issue('zip', 'package-manifest.json', 'version-mismatch'))
            files = manifest.get('files')
            if not isinstance(files, dict) or set(files) != expected:
                findings.append(issue('zip', 'package-manifest.json', 'manifest-file-list-mismatch'))
            else:
                for name, digest in files.items():
                    if name in actual and hashlib.sha256(archive.read(prefix + name)).hexdigest() != digest:
                        findings.append(issue('zip', name, 'checksum-mismatch'))
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, RuntimeError):
        findings.append(issue('zip', path.name, 'invalid-or-unreadable-archive'))
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--package-only', action='store_true', help='Audit only the explicit public candidates, excluding Git history')
    parser.add_argument('--zip', type=Path, help='Audit a code ZIP instead of the working tree and Git')
    args = parser.parse_args()
    stats = {}
    if args.zip:
        findings = audit_zip(args.zip)
        scope = 'zip'
    else:
        findings = audit_worktree(args.root)
        scope = 'package-candidates' if args.package_only else 'package-candidates-and-all-git-refs'
        if not args.package_only:
            history, stats = audit_git(args.root)
            findings.extend(history)
    result = {'ok': not findings, 'scope': scope, 'publicFiles': len(code_paths(args.root)),
              'git': stats, 'findings': findings,
              'limitations': 'Explicit allowlist and known credential/path patterns; human copyright and provenance review still required.'}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
