#!/usr/bin/env python3
"""Verify this optional pack and detect missing Git LFS media without network calls."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent


def verify(root=ROOT):
    root = Path(root).resolve()
    expected = json.loads((root / 'checksums.json').read_text())['files']
    errors = []
    for name, checksum in expected.items():
        path = root / name
        if path.is_symlink() or root not in path.resolve().parents or not path.is_file():
            errors.append(f'Missing or unsafe file: {name}')
            continue
        with path.open('rb') as stream:
            prefix = stream.read(128)
            if prefix.startswith(b'version https://git-lfs.github.com/spec/v1'):
                errors.append(f'Git LFS pointer, run git lfs pull: {name}')
                continue
            digest = hashlib.sha256(prefix)
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest() != checksum:
            errors.append(f'SHA-256 mismatch: {name}')
    if errors:
        raise ValueError('\n'.join(errors))
    return {'verified_files': len(expected), 'network_calls': 0}


if __name__ == '__main__':
    try:
        print(json.dumps(verify(), ensure_ascii=False))
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
