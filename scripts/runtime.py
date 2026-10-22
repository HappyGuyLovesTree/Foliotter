"""Select the optional project-local importer environment without installing it."""
import os
from pathlib import Path
import sys


def project_python(root, fallback=None):
    root = Path(root)
    environment = root / '.venv'
    executable = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if (environment / 'pyvenv.cfg').is_file() and executable.is_file():
        return str(executable.absolute())
    return str(fallback or sys.executable)


def prefer_project_python(root):
    """Call from a CLI entry point only, before loading importer dependencies."""
    environment = (Path(root) / '.venv').resolve()
    if Path(sys.prefix).resolve() == environment:
        return
    selected = project_python(root)
    if selected == sys.executable:
        return
    os.execv(selected, [selected, '-B', *sys.argv])
