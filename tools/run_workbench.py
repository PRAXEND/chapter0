#!/usr/bin/env python3
"""Launch the installed plugin with this checkout's verified media and a complete Python."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

def launch_settings(root=ROOT, environ=None):
    root = Path(root).resolve()
    env = dict(os.environ if environ is None else environ)
    marker = root / '.runtime/plugin-install.json'
    if not marker.is_file():
        raise ValueError('请按 INSTALL.md 安装插件，将安装 JSON 保存到 .runtime/plugin-install.json。')
    installed = Path(json.loads(marker.read_text())['installedPath']).expanduser().resolve(strict=True)
    actual = json.loads((installed / 'plugin.json').read_text())
    expected = json.loads((root / 'plugins/video-studio/plugin.json').read_text())
    if (actual['name'], actual['version']) != (expected['name'], expected['version']):
        raise ValueError('已安装插件与本次源码版本不同，请按 INSTALL.md 更新安装。')
    node = shutil.which('node', path=env.get('PATH'))
    if not node:
        raise ValueError('缺少 Node.js 20+，请按 INSTALL.md 配置 PATH。')
    env.setdefault('VIDEO_STUDIO_MEDIA_ROOT', str(root / 'user-packs/henry-video-styles'))
    env.setdefault('VIDEO_STUDIO_PYTHON', sys.executable)
    env['VIDEO_STUDIO_PLUGIN_ROOT'] = str(installed)
    return [node, str(installed / 'scripts/open-workbench.mjs')], env

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Print resolved paths without starting a service')
    args = parser.parse_args()
    try:
        command, env = launch_settings()
        if args.check:
            print(json.dumps({'command': command, 'python': env['VIDEO_STUDIO_PYTHON'], 'mediaRoot': env['VIDEO_STUDIO_MEDIA_ROOT'], 'packRoot': env.get('VIDEO_STUDIO_PACK_ROOT'), 'model_calls': 0}, ensure_ascii=False, indent=2))
        else:
            subprocess.run(command, cwd=ROOT, env=env, check=True)
    except (KeyError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
