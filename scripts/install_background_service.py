#!/usr/bin/env python3
"""Install/update only this reader's per-user service and desktop shortcut."""
import json
from pathlib import Path
import plistlib
import re
import sys
import shlex
import argparse
import subprocess


def stable_python_path(executable):
    """Prefer the matching Homebrew opt link without selecting another Python."""
    python = Path(executable).absolute()
    try:
        resolved = python.resolve()
        for cellar in resolved.parents:
            if cellar.name != 'Cellar':
                continue
            parts = resolved.relative_to(cellar).parts
            if len(parts) < 4 or not re.fullmatch(r'python(?:3|@\d+(?:\.\d+)*)?', parts[0]):
                continue
            candidate = cellar.parent / 'opt' / parts[0] / 'bin' / python.name
            if candidate.is_file() and candidate.resolve() == resolved:
                return candidate
    except (OSError, RuntimeError):
        # A missing, changed or broken opt link must not redirect this install.
        pass
    return python


def install():
    root = Path(__file__).resolve().parents[1]
    home = Path.home()
    runtime = home / 'Library/Application Support/Foliotter'
    label = 'org.foliotter.reader'
    shortcut = home / 'Desktop/Foliotter.app'
    # Existing users retain their service, shortcut and browser origin.
    legacy = home / 'Library/Application Support/RedBookLocal'
    if (legacy / 'config.json').is_file():
        legacy_config = json.loads((legacy / 'config.json').read_text())
        if legacy_config.get('project') != str(root):
            raise RuntimeError('Another reader installation uses port 8787. Use the terminal with a different --port to try this copy.')
        runtime = legacy
        label = 'com.zhuanz.redbook'
        shortcut = home / 'Desktop/红书.app'
    agent = home / 'Library/LaunchAgents' / (label + '.plist')
    # Keep a stable interpreter symlink (e.g. Homebrew opt), not a versioned keg.
    # Keep the supervisor available while an external project disk is absent.
    # It selects the project's .venv only for the actual reader subprocess.
    python = stable_python_path(getattr(sys, '_base_executable', None) or sys.executable)
    if not python.is_file():
        raise RuntimeError('Missing configured Python: ' + str(python))
    if sys.version_info < (3, 10):
        raise RuntimeError('Python 3.10 or later required')
    if not (root / 'app/index.html').is_file() or not (root / 'app/library.html').is_file():
        raise RuntimeError('Application files missing; see README.md')
    version = (root / 'VERSION').read_text().strip().removeprefix('v')
    icon = root / 'packaging/RedBook.icns'
    if not icon.is_file():
        raise RuntimeError('Missing desktop icon: ' + str(icon))
    if runtime.exists():
        config = json.loads((runtime / 'config.json').read_text())
        if config.get('label') != label or config.get('project') != str(root):
            raise RuntimeError('Refusing to replace an unrelated runtime')
    if agent.exists() and plistlib.loads(agent.read_bytes()).get('Label') != label:
        raise RuntimeError('Refusing to replace an unrelated LaunchAgent')
    if shortcut.exists():
        info = plistlib.loads((shortcut / 'Contents/Info.plist').read_bytes())
        if info.get('CFBundleIdentifier') != label + '.launcher':
            raise RuntimeError('Refusing to replace an unrelated desktop app')

    def write(path, data, mode=0o600):
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + '.new')
        temp.write_bytes(data)
        temp.chmod(mode)
        temp.replace(path)

    config = {'project': str(root), 'python': str(python), 'port': 8787, 'label': label}
    write(runtime / 'config.json', (json.dumps(config, ensure_ascii=False, indent=2) + '\n').encode())
    write(runtime / 'reader_background.py', (root / 'scripts/reader_background.py').read_bytes())
    plist = {'Label': label, 'ProgramArguments': [str(python), '-B', str(runtime / 'reader_background.py'), 'run'], 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10, 'ExitTimeOut': 12, 'WorkingDirectory': str(runtime), 'ProcessType': 'Background', 'StandardOutPath': str(runtime / 'launchd.log'), 'StandardErrorPath': str(runtime / 'launchd.log')}
    write(agent, plistlib.dumps(plist), 0o644)
    info = {'CFBundleName': 'Foliotter', 'CFBundleDisplayName': 'Foliotter · 书獭', 'CFBundleIdentifier': label + '.launcher', 'CFBundleExecutable': 'open-reader', 'CFBundlePackageType': 'APPL', 'CFBundleVersion': version, 'CFBundleShortVersionString': version, 'CFBundleIconFile': 'RedBook.icns', 'LSUIElement': True}
    write(shortcut / 'Contents/Info.plist', plistlib.dumps(info), 0o644)
    write(shortcut / 'Contents/Resources/RedBook.icns', icon.read_bytes(), 0o644)
    launcher = '#!/bin/zsh\nexec ' + shlex.quote(str(python)) + ' -B ' + shlex.quote(str(runtime / 'reader_background.py')) + ' open\n'
    write(shortcut / 'Contents/MacOS/open-reader', launcher.encode(), 0o755)
    runtime.chmod(0o700)
    return {'runtime': str(runtime), 'launchAgent': str(agent), 'desktopShortcut': str(shortcut), 'project': str(root), 'label': label, 'python': str(python)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--open', action='store_true', help='Start the installed local reader')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('Desktop installation requires macOS. Run python3 scripts/serve.py --open instead.')
    result = install()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.open:
        sys.exit(subprocess.run([result['python'], '-B', str(Path(result['runtime']) / 'reader_background.py'), 'open']).returncode)
