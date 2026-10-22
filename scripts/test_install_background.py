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

    def homebrew_python(self, formula='python@3.14'):
        prefix = self.root.parent / 'custom brew prefix'
        keg = prefix / 'Cellar' / formula / '3.14.6'
        python = keg / 'Frameworks/Python.framework/Versions/3.14/bin/python3.14'
        python.parent.mkdir(parents=True)
        python.write_text('# synthetic interpreter')
        (keg / 'bin').mkdir()
        (keg / 'bin/python3.14').symlink_to(python)
        (prefix / 'opt').mkdir()
        (prefix / 'opt' / formula).symlink_to(keg, target_is_directory=True)
        return python, prefix / 'opt' / formula / 'bin/python3.14'

    def test_venv_base_interpreter_installs_matching_stable_homebrew_path_everywhere(self):
        python, stable = self.homebrew_python()
        with patch.object(installer.sys, '_base_executable', str(python)):
            result = installer.install()
        self.assertEqual(result['python'], str(stable))
        config = json.loads((Path(result['runtime']) / 'config.json').read_text())
        agent = plistlib.loads(Path(result['launchAgent']).read_bytes())
        launcher = (Path(result['desktopShortcut']) / 'Contents/MacOS/open-reader').read_text()
        self.assertEqual(config['python'], str(stable))
        self.assertEqual(agent['ProgramArguments'][0], str(stable))
        self.assertIn(installer.shlex.quote(str(stable)), launcher)
        self.assertNotIn('/Cellar/', launcher)

    def test_missing_or_unrelated_opt_interpreter_does_not_replace_base(self):
        python, stable = self.homebrew_python()
        stable.unlink()
        self.assertEqual(installer.stable_python_path(python), python)
        unrelated = self.root.parent / 'unrelated-python'
        unrelated.write_text('# different interpreter')
        stable.symlink_to(unrelated)
        self.assertEqual(installer.stable_python_path(python), python)

    def test_non_homebrew_path_and_non_python_formula_keep_original_path(self):
        python = self.root.parent / 'standalone/python3'
        python.parent.mkdir()
        python.write_text('# standalone interpreter')
        link = self.root.parent / 'python-link'
        link.symlink_to(python)
        self.assertEqual(installer.stable_python_path(link), link)
        other, _ = self.homebrew_python('unrelated-tool')
        self.assertEqual(installer.stable_python_path(other), other)

    def test_existing_homebrew_opt_path_remains_stable(self):
        _, stable = self.homebrew_python('python')
        self.assertEqual(installer.stable_python_path(stable), stable)


if __name__ == '__main__':
    unittest.main()
