#!/usr/bin/env python3
"""Verify the published checkout, including actual Git LFS bytes, without network or models."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

def digest(file):
    result = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()

def verify(root=ROOT, strict_tree=False):
    root = Path(root).resolve()
    manifest = json.loads((root / 'release-manifest.json').read_text())
    errors = []
    for name, expected in manifest['files'].items():
        relative = Path(name)
        file = root / relative
        if relative.is_absolute() or '..' in relative.parts or file.is_symlink() or not file.is_file() or root not in file.resolve().parents:
            errors.append('Missing/unsafe: ' + name)
            continue
        with file.open('rb') as stream:
            pointer = stream.read(128).startswith(b'version https://git-lfs.github.com/spec/v1')
        if pointer:
            errors.append('LFS pointer, run git lfs pull: ' + name)
        elif file.stat().st_size != expected['bytes'] or digest(file) != expected['sha256']:
            errors.append('Changed bytes: ' + name)
    if strict_tree:
        tracked = set(subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().rstrip('\0').split('\0'))
        expected = set(manifest['files']) | {'release-manifest.json'}
        if tracked != expected:
            errors.append('Tracked scope differs: ' + repr(sorted(tracked ^ expected)))
    if errors:
        raise ValueError('\n'.join(errors))
    spec = importlib.util.spec_from_file_location('pack_verifier', root / 'user-packs/henry-video-styles/verify.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    pack = module.verify(root / 'user-packs/henry-video-styles')
    return {'version': manifest['version'], 'verified_files': len(manifest['files']), 'media_files': manifest['media_files'], 'media_bytes': manifest['media_bytes'], 'style_pack_verified_files': pack['verified_files'], 'network_calls': 0, 'model_calls': 0}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--strict-tree', action='store_true', help='Also verify the tracked publication scope')
    args = parser.parse_args()
    try:
        print(json.dumps(verify(strict_tree=args.strict_tree), ensure_ascii=False, indent=2))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
