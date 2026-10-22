"""Release guards use synthetic files only; no local book data is read."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

from audit_release import ORIGINAL_ICON_SHA256, audit_git, audit_worktree, audit_zip, scan_file
from package_reader import build, code_paths


def candidate_tree(root):
    for name in code_paths(root):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        content = b'Original synthetic fixture.\n'
        if name in ORIGINAL_ICON_SHA256:
            content = (Path(__file__).resolve().parents[1] / name).read_bytes()
        path.write_bytes(content)
    (root / 'VERSION').write_text('test-version\n')


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)


class ReleaseAuditTests(unittest.TestCase):
    def test_gitignore_matches_the_public_allowlist_and_hides_imports(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            git(root, 'init', '-q')
            (root / '.gitignore').write_bytes((Path(__file__).resolve().parents[1] / '.gitignore').read_bytes())
            private = ['user-library/book/reading.json', 'app/data/reading.json', 'data/notes.json',
                       'app/new-private.js', 'app/new-private.css', 'docs/private.md',
                       'source.epub', '.env', 'cache/log.json', 'dist/personal.zip']
            names = code_paths(root) + private
            ignored = subprocess.check_output(['git', '-C', str(root), 'check-ignore', '--no-index', '--stdin'],
                                              input=('\n'.join(names) + '\n').encode()).decode().splitlines()
            self.assertEqual(set(private), set(ignored))

    def test_original_icon_cannot_be_replaced_with_unreviewed_image(self):
        findings = scan_file('packaging/redbook.png', b'\x89PNG\r\n\x1a\nsynthetic image swap', 'package')
        self.assertEqual(['unreviewed-icon-content'], [item['code'] for item in findings])

    def test_candidate_scans_never_include_new_scripts_or_imported_books(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate_tree(root)
            for name in ('app/book-excerpt.js', 'app/hidden-book.css', 'user-library/book/reading.json',
                         'data/notes.json', 'app/data/source.epub', 'docs/private-receipt.md'):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('private synthetic content')
            result = build(root, root / 'public.zip')
            self.assertEqual('code-only', result['kind'])
            self.assertEqual([], audit_worktree(root))
            self.assertEqual([], audit_zip(root / 'public.zip'))
            with zipfile.ZipFile(root / 'public.zip') as archive:
                self.assertFalse(any('private' in name or 'book-excerpt' in name or
                                     'user-library' in name or '/data/' in name for name in archive.namelist()))

    def test_credential_findings_never_echo_the_value(self):
        secret = 'gh' + 'p_' + 'a' * 36
        findings = scan_file('README.md', ('token: ' + secret).encode(), 'package')
        self.assertEqual(['credential'], [item['code'] for item in findings])
        self.assertEqual(1, findings[0]['line'])
        self.assertNotIn(secret, json.dumps(findings))
        path = '/' + 'Users/' + 'example-person/private'
        self.assertEqual('private-path', scan_file('README.md', path.encode(), 'package')[0]['code'])

    def test_public_package_refuses_leaked_credential_without_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate_tree(root)
            secret = 'sk' + '-' + 'a' * 40
            (root / 'README.md').write_text(secret)
            destination = root / 'unsafe.zip'
            with self.assertRaises(ValueError) as error:
                build(root, destination)
            self.assertNotIn(secret, str(error.exception))
            self.assertFalse(destination.exists())

    def test_history_finds_removed_private_material_across_archive_refs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            git(root, 'init', '-q')
            git(root, 'config', 'user.name', 'Synthetic Test')
            git(root, 'config', 'user.email', 'test@example.invalid')
            (root / 'README.md').write_text('Original synthetic fixture.')
            git(root, 'add', 'README.md')
            git(root, 'commit', '-qm', 'Original code')
            clean_commit = git(root, 'rev-parse', 'HEAD').decode().strip()
            (root / 'private.epub').write_bytes(b'PK synthetic local ebook')
            git(root, 'add', 'private.epub')
            git(root, 'commit', '-qm', 'Private test content')
            git(root, 'update-ref', 'refs/archive/private-test', 'HEAD')
            git(root, 'reset', '--hard', clean_commit)
            findings, stats = audit_git(root)
            self.assertTrue(any(item['scope'] == 'git-history' and item['path'] == 'private.epub' for item in findings))
            self.assertGreaterEqual(stats['refs'], 2)
            self.assertFalse(any(item['scope'] == 'git-index' for item in findings))

    def test_index_scans_staged_bytes_not_only_current_working_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            git(root, 'init', '-q')
            secret = 'gh' + 'p_' + 'b' * 36
            (root / 'README.md').write_text(secret)
            git(root, 'add', 'README.md')
            (root / 'README.md').write_text('Clean working copy does not clean index.')
            findings, _ = audit_git(root)
            self.assertTrue(any(item['scope'] == 'git-index' and item['code'] == 'credential' for item in findings))

    def test_zip_rejects_added_private_member_and_checksum_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate_tree(root)
            build(root, root / 'clean.zip')
            with zipfile.ZipFile(root / 'clean.zip') as archive:
                members = {info.filename: archive.read(info) for info in archive.infolist()}
            prefix = next(iter(members)).split('/')[0] + '/'
            members[prefix + 'README.md'] = b'Modified after packaging'
            members[prefix + 'user-library/local.epub'] = b'Private synthetic bytes'
            manifest = json.loads(members[prefix + 'package-manifest.json'])
            manifest['private_notes'] = 'Synthetic private note.'
            members[prefix + 'package-manifest.json'] = json.dumps(manifest).encode()
            with zipfile.ZipFile(root / 'tampered.zip', 'w') as archive:
                for name, raw in members.items():
                    archive.writestr(name, raw)
            codes = {item['code'] for item in audit_zip(root / 'tampered.zip')}
            self.assertIn('unexpected-package-member', codes)
            self.assertIn('checksum-mismatch', codes)
            self.assertIn('unexpected-manifest-fields', codes)

    def test_symlink_candidates_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate_tree(root)
            (root / 'README.md').unlink()
            (root / 'README.md').symlink_to(root / 'NOTICE.md')
            self.assertTrue(any(item['code'] == 'missing-or-unsafe-file' for item in audit_worktree(root)))
            with self.assertRaises(ValueError):
                build(root, root / 'public.zip')


if __name__ == '__main__':
    unittest.main()
