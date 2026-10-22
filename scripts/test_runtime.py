"""Environment selection does not overwrite or install into unrelated folders."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from runtime import project_python, prefer_project_python
from setup_importers import required_versions, setup


class RuntimeTests(unittest.TestCase):
    def test_selection_requires_an_existing_venv(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual('fallback-python', project_python(root, 'fallback-python'))
            binary = root / '.venv/bin/python'
            binary.parent.mkdir(parents=True)
            binary.touch()
            self.assertEqual('fallback-python', project_python(root, 'fallback-python'))
            (root / '.venv/pyvenv.cfg').write_text('home = fixture\n')
            self.assertEqual(str(binary), project_python(root, 'fallback-python'))

    def test_reexec_keeps_arguments_and_does_not_loop(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / '.venv/bin/python'
            binary.parent.mkdir(parents=True)
            binary.touch()
            (root / '.venv/pyvenv.cfg').write_text('home = fixture\n')
            with patch('runtime.sys.argv', ['serve.py', '--port', '8788']), patch('runtime.os.execv') as execute:
                prefer_project_python(root)
                execute.assert_called_once_with(str(binary), [str(binary), '-B', 'serve.py', '--port', '8788'])
            with patch('runtime.sys.prefix', str(root / '.venv')), patch('runtime.os.execv') as execute:
                prefer_project_python(root)
                execute.assert_not_called()

    def test_setup_check_does_not_create_environment_or_install(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'requirements-import.txt').write_text('example-package==1.2.3\n')
            with patch('setup_importers.subprocess.run') as run:
                self.assertFalse(setup(root, check=True)['ready'])
                self.assertFalse((root / '.venv').exists())
                run.assert_not_called()

    def test_setup_rejects_unrelated_folder_and_unpinned_requirements(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            requirements = root / 'requirements-import.txt'
            requirements.write_text('example-package==1.2.3\n')
            (root / '.venv').mkdir()
            with self.assertRaisesRegex(RuntimeError, 'not a Python environment'):
                setup(root, check=True)
            requirements.write_text('example-package>=1.2\n')
            with self.assertRaisesRegex(ValueError, 'exact'):
                required_versions(requirements)


if __name__ == '__main__':
    unittest.main()
