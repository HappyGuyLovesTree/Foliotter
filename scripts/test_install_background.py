"""Installer checks use only a temporary home; they never invoke launchctl."""
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

import install_background_service as installer


class DesktopInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.root = (base / 'Foliotter').resolve()
        self.home = (base / 'home').resolve()
        for name, text in {
            'VERSION': '0.7.0', 'app/index.html': 'Reader',
            'app/library.html': 'Library', 'packaging/RedBook.icns': 'synthetic icon',
            'scripts/reader_background.py': '# synthetic supervisor',
        }.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
        self.home.mkdir()
        self.addCleanup(patch.stopall)
        patch.object(installer, '__file__', str(self.root / 'scripts/install_background_service.py')).start()
        patch.object(Path, 'home', return_value=self.home).start()

    def test_fresh_code_only_install_needs_no_book_and_uses_new_name(self):
        result = installer.install()
        self.assertEqual(result['label'], 'org.foliotter.reader')
        info = plistlib.loads((Path(result['desktopShortcut']) / 'Contents/Info.plist').read_bytes())
        self.assertEqual(info['CFBundleName'], 'Foliotter')
        self.assertFalse((self.root / 'app/data').exists())
        self.assertEqual(installer.install()['runtime'], result['runtime'])

    def test_legacy_install_keeps_existing_service_and_entry(self):
        legacy = self.home / 'Library/Application Support/RedBookLocal'
        legacy.mkdir(parents=True)
        (legacy / 'config.json').write_text(json.dumps({'project': str(self.root), 'label': 'com.zhuanz.redbook'}))
        result = installer.install()
        self.assertEqual(result['runtime'], str(legacy))
        self.assertEqual(result['label'], 'com.zhuanz.redbook')
        self.assertTrue(result['desktopShortcut'].endswith('/红书.app'))

    def test_unrelated_runtime_is_not_overwritten(self):
        runtime = self.home / 'Library/Application Support/Foliotter'
        runtime.mkdir(parents=True)
        original = json.dumps({'project': 'another installation', 'label': 'other'})
        (runtime / 'config.json').write_text(original)
        with self.assertRaisesRegex(RuntimeError, 'unrelated runtime'):
            installer.install()
        self.assertEqual((runtime / 'config.json').read_text(), original)


if __name__ == '__main__':
    unittest.main()
