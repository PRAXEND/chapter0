#!/usr/bin/env python3
"""Copy only published pack specs and referenced text into the plugin distribution."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'plugins/video-studio/scripts'))
import user_packs

PACKS = ('shawn-robotics', 'shawn-style-fusion', 'henry-video-styles')


def expected(root=ROOT):
    files = {}
    for pack in PACKS:
        source = root / 'user-packs' / pack
        manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
        pending = ['manifest.json', *manifest['styles']]
        visited = set()

        def references(value):
            if isinstance(value, str) and value.startswith('pack:'):
                pending.append(value[5:])
            elif isinstance(value, list):
                for item in value: references(item)
            elif isinstance(value, dict):
                for item in value.values(): references(item)

        while pending:
            name = pending.pop()
            if name in visited: continue
            visited.add(name)
            path = user_packs._file(source, name)
            files[pack + '/' + name] = path.read_bytes()
            if name == 'manifest.json' or name in manifest['styles']:
                references(json.loads(files[pack + '/' + name]))
    return files


def bundle(check=False, root=ROOT):
    files = expected(root)
    files['files.json'] = (json.dumps(sorted(files), indent=2) + '\n').encode()
    destination = root / 'plugins/video-studio/style-packs'
    actual = {p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file()}
    if actual - files.keys(): raise ValueError('Unexpected files in generated style-packs: ' + str(sorted(actual - files.keys())))
    for name, content in files.items():
        path = destination / name
        if check:
            if not path.is_file() or path.read_bytes() != content:
                raise ValueError('Style catalog differs from published source: ' + name)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    return {'files': len(files), 'bytes': sum(map(len, files.values())), 'mediaIncluded': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--check', action='store_true')
    print(json.dumps(bundle(parser.parse_args().check)))
