#!/usr/bin/env python3
"""Build the real web workbench plus plugin from explicit allowlists; no user state."""
from pathlib import Path
import hashlib
import json
import shutil
import tempfile
import zipfile
from package import FILES

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'deliverables'
VERSION = json.loads((ROOT / 'plugins/video-studio/plugin.json').read_text())['version']
NAME = f'Frame-Video-Studio-{VERSION}'
GUIDE = f"""# Video Studio 网页工作台 {VERSION}

安装与完整使用说明见随包 INSTALL.md。推荐从 video-generation-workbench Git 分支配合 Git LFS 安装；本便携 ZIP 只含插件代码、风格文本与启动入口，不含 42 个大型参考/复现音视频。

本机支持范围为 macOS。需完整 Python 3.10+、Node.js 20+、FFmpeg/ffprobe、支持桌面 queue 的 Codex，以及已连接的 hosted ChatCut。配置自己的专用桌面会话和浏览器授权后，点击一键才启动制作。验收失败暂停并提供临时包，确认修订才继续；正式交付必须通过独立验收。

ZIP 不包含账号、私人成片、克隆录音或桌面会话配置。完整 Git 安装路径与排障步骤见 INSTALL.md。
"""


def build():
    DEST.mkdir(exist_ok=True)
    archive = DEST / f'{NAME}.zip'
    with tempfile.TemporaryDirectory(prefix='frame-package-') as temp:
        target = Path(temp) / NAME
        target.mkdir()
        allowlist = [p for p in FILES if p.startswith('plugins/') or p == '.agents/plugins/marketplace.json']
        for item in allowlist:
            source, destination = ROOT / item, target / item
            if source.is_symlink() or not source.is_file():
                raise ValueError(f'Missing or unsafe package file: {item}')
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        shutil.copy2(ROOT / 'INSTALL.md', target / 'INSTALL.md')
        (target / 'README.md').write_text(GUIDE, encoding='utf-8')
        (target / '先读我.txt').write_text(GUIDE, encoding='utf-8')
        (target / 'start.mjs').write_text("import './plugins/video-studio/workbench/start.mjs';\n")
        (target / 'start-macos.command').write_text('#!/bin/zsh\ncd -- "$(dirname -- "$0")" || exit 1\nexec ./plugins/video-studio/workbench/start-macos.command\n')
        (target / 'start.sh').write_text('#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\nexec sh ./plugins/video-studio/workbench/start.sh\n')
        (target / 'start-windows.bat').write_bytes(b'@echo off\r\ncd /d "%~dp0"\r\ncall plugins\\video-studio\\workbench\\start-windows.bat\r\n')
        for file in target.rglob('*'):
            if file.suffix in {'.command', '.sh'}:
                file.chmod(0o755)
        checks = [hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(target).as_posix()
                  for p in sorted(target.rglob('*')) if p.is_file()]
        (target / 'SHA256SUMS.txt').write_text('\n'.join(checks)+'\n')
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
            for p in sorted(target.rglob('*')):
                if p.is_file():
                    z.write(p, p.relative_to(Path(temp)).as_posix())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n')
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        for info in z.infolist():
            parts = Path(info.filename).parts
            assert not any(p in {'.data', '.git', 'node_modules', '__pycache__'} for p in parts)
            assert info.filename.endswith('/') or Path(info.filename).name not in {'auth.json', 'config.toml'}
            if info.filename.endswith(('.mjs','.js','.json','.md','.txt','.html','.py')):
                assert '/Users/guochenghui' not in z.read(info).decode('utf-8'), info.filename
    print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'sha256':digest},ensure_ascii=False))


if __name__ == '__main__':
    build()
