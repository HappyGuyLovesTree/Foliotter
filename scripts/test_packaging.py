import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from install_local_content import allowed, restore
from package_reader import code_paths


class PackagingTests(unittest.TestCase):
    def test_allowlist_excludes_books_and_records(self):
        root = Path(__file__).resolve().parents[1]
        for name in code_paths(root):
            self.assertFalse(name.startswith(('data/', 'sources/', 'cache/', 'backups/', 'evidence/', 'DD/', 'app/data/')))
            self.assertNotIn('record-exports', name)
        self.assertFalse(allowed('../secrets'))
        self.assertFalse(allowed('/app/data/reading.json'))
        self.assertFalse(allowed('app/data/../../secret'))

    def test_bad_checksum_and_existing_content_leave_destination_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = root/'source'; target = root/'target'
            source.mkdir();target.mkdir()
            names = ['data/interpretation_targets.json', 'data/verified_interpretations.json',
                     'data/source_discovery_hints.json', 'data/fullbook-candidate/reading.json', 'app/data/reading.json']
            files = {}
            for name in names:
                p=source/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'fixture')
                files[name]=hashlib.sha256(b'fixture').hexdigest()
            manifest={'schemaVersion':1,'kind':'personal-offline','files':files}
            (source/'package-manifest.json').write_text(json.dumps(manifest))
            (source/names[-1]).write_bytes(b'damaged')
            with self.assertRaises(ValueError):restore(source,target)
            self.assertEqual([],list(target.iterdir()))
            (source/names[-1]).write_bytes(b'fixture')
            self.assertEqual(5,restore(source,target)['restoredFiles'])
            with self.assertRaises(ValueError):restore(source,target)
            self.assertEqual(b'fixture',(target/names[-1]).read_bytes())


if __name__ == '__main__':unittest.main()
