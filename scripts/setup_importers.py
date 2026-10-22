#!/usr/bin/env python3
"""Install the pinned local ebook import tools into this project's .venv."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import venv

from runtime import project_python


def required_versions(path):
    versions = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.split('#', 1)[0].strip()
        if not line:
            continue
        match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)', line)
        if not match:
            raise ValueError('Import requirements must use exact package==version pins.')
        versions[match[1]] = match[2]
    if not versions:
        raise ValueError('No importer packages are configured.')
    return versions


def installed_versions(python, names):
    code = ('import importlib.metadata as m,json,sys\n'
            'found={}\n'
            'for name in json.loads(sys.argv[1]):\n'
            ' try: found[name]=m.version(name)\n'
            ' except m.PackageNotFoundError: pass\n'
            'print(json.dumps(found))\n')
    result = subprocess.run([str(python), '-B', '-c', code, json.dumps(list(names))],
                            capture_output=True, text=True, check=True, timeout=20)
    return json.loads(result.stdout)


def setup(root, ensure=False, check=False):
    root = Path(root).resolve()
    requirements = root / 'requirements-import.txt'
    expected = required_versions(requirements)
    environment = root / '.venv'
    if environment.exists() and not (environment / 'pyvenv.cfg').is_file():
        raise RuntimeError('.venv already exists but is not a Python environment. Move it aside before setup.')
    if not environment.exists():
        if check:
            return {'ready': False, 'environment': str(environment), 'required': expected}
        print('Creating a local Python environment for ebook import tools.', flush=True)
        venv.EnvBuilder(with_pip=True).create(environment)
    python = project_python(root)
    actual = installed_versions(python, expected)
    ready = all(actual.get(name) == version for name, version in expected.items())
    if check or (ensure and ready):
        return {'ready': ready, 'environment': str(environment), 'installed': actual, 'required': expected}
    print('Installing the pinned ebook import tools. This downloads software only, not books.', flush=True)
    subprocess.run([python, '-B', '-m', 'pip', 'install', '--disable-pip-version-check',
                    '--requirement', str(requirements)], check=True)
    actual = installed_versions(python, expected)
    if not all(actual.get(name) == version for name, version in expected.items()):
        raise RuntimeError('Importer version check failed. Run setup again to repair the environment.')
    return {'ready': True, 'environment': str(environment), 'installed': actual}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ensure', action='store_true', help='Skip installation when all pinned versions are present')
    parser.add_argument('--check', action='store_true', help='Check installed versions without changing files or downloading')
    args = parser.parse_args()
    if sys.version_info < (3, 10):
        parser.error('Python 3.10 or later is required.')
    try:
        result = setup(Path(__file__).resolve().parents[1], ensure=args.ensure, check=args.check)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print('Importer setup did not complete: ' + str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0 if result['ready'] else 1


if __name__ == '__main__':
    sys.exit(main())
