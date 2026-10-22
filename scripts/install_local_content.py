#!/usr/bin/env python3
"""Restore local data from an extracted personal package, never from the network."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tempfile
from package_reader import ROOT, DATA_FILES, DATA_TREES


def allowed(name):
    p = PurePosixPath(name)
    return not p.is_absolute() and '..' not in p.parts and (name in DATA_FILES or any(name.startswith(tree + '/') for tree in DATA_TREES))


def restore(source, target):
    source = source.resolve()
    manifest = json.loads((source / 'package-manifest.json').read_text())
    if manifest.get('kind') != 'personal-offline' or manifest.get('schemaVersion') != 1:
        raise ValueError('A verified personal offline package is required')
    files = {n: h for n, h in manifest['files'].items() if allowed(n)}
    if not all(n in files for n in DATA_FILES + ['app/data/reading.json']):
        raise ValueError('Package lacks required local content')
    for name, expected in files.items():
        p = source / name
        if p.is_symlink() or not p.resolve().is_relative_to(source) or hashlib.sha256(p.read_bytes()).hexdigest() != expected:
            raise ValueError('Content fingerprint mismatch: ' + name)
        if (target / name).exists():
            raise ValueError('Content already exists; restore into a clean code checkout: ' + name)
        parent = (target / name).parent
        while parent != target.parent:
            if parent.is_symlink():
                raise ValueError('Symlink in restore destination')
            if parent == target:
                break
            parent = parent.parent
    # Verify every byte before making any destination changes.
    with tempfile.TemporaryDirectory(prefix='redbook-content-') as temp:
        staging = Path(temp)
        for name in files:
            p = staging / name
            p.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, p)
            if hashlib.sha256(p.read_bytes()).hexdigest() != files[name]:
                raise ValueError('Source changed during restore: ' + name)
        for name in files:
            p = target / name
            p.parent.mkdir(parents=True, exist_ok=True)
            with p.open('xb') as dest:
                dest.write((staging / name).read_bytes())
    return {'restoredFiles': len(files), 'destination': str(target.resolve()), 'networkUsed': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from', dest='source', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(restore(args.source, ROOT), ensure_ascii=False, indent=2))
