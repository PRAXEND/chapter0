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
GUIDE = f'''# Video Studio 网页制作工作台 {VERSION}

先完整解压，再在目标电脑启动。目前以 macOS 为支持平台，Windows/Linux 启动器未在对应系统实测。

1. 安装 Node.js 20+、Python 3.10+、FFmpeg/ffprobe，以及 Codex CLI，并登录自己的 Codex 账号。
2. 在 Codex 中安装并连接 hosted ChatCut 插件。该工作台依赖真实 ChatCut 工程和导出服务。
3. 在解压目录的终端安装随包 Video Studio 插件：

   ```sh
   codex plugin marketplace add .
   codex plugin add video-studio@video-studio
   python3 -m pip install -r plugins/video-studio/requirements-runtime.txt
   ```

4. 双击本目录的 start-macos.command，或运行 `node start.mjs`。
5. 打开 http://127.0.0.1:4317，点击「检查 ChatCut 实际连接」。

网页流程：填写主题 → 选择真实风格 → 按插件搜索素材 → 查看推荐/备选 → 点击单条采集并预览 →
勾选素材 → 生成、修改文案和分镜 → 点击确认 → 调用插件制作 → 指定文件夹交付。

搜索明确调用 Video Studio 的素材采集 skill 及适用来源规则，按题材和风格形成推荐。
采集后可查看本地路径、打开所在文件夹及下载。搜索过的候选记录和采集/导入的文件都进入持久素材库，新项目也可看到。
打开即可筛选「未采集 / 已下载」，点击需要的候选才下载；本地文件可直接预览、检索和复用，无需重复下载。
用户明确选用后才用于本期制作；便携包不携带缓存和账号状态。
可以点击「更新仓库候选」读取每日仓库完整目录（需要目标电脑已连接 GitHub CLI），按原帖发布日期筛选近 3 / 7 / 30 天；只更新文字元数据，点击单条后再采集。
可以直接上传本地媒体，也可填写本机文件路径。输出位置可在制作要求中修改。
顶部可选择日间、夜间或跟随系统外观，浏览器会记住选择；外观设置独立于视频风格和制作参数。
插件已内含网页代码，可用 $open-video-workbench 打开，或双击启动器。每次调用是独立 Codex 会话，项目资料和审批记录由本地工作台持续保存。
右侧 Agent 面板展示本次任务及项目累计 Token，支持展开历史明细，包含失败与重试；任务结束后采用实际用量，不把未上报当成零。缓存和推理不重复计入总量。
顶部「我的项目」可查找、切换旧项目；新建前完整保存当前内容，不再覆盖旧项目。
正式制作保留可编辑 ChatCut 工程，实际 MP4 和制作记录写入指定文件夹的新子目录。
需要在浏览器完成某一步时，网页会展示真实工程链接和具体提示，随后可继续原任务。
使用的 AI 配音/配乐会消耗目标电脑账号对应服务的额度；未启用的媒体不会额外生成。

本包不含账号、密钥、登录状态、个人风格库、素材或示例成片。首次打开为空白项目。
风格规则和案例从目标电脑真实的个人库或仓库可选包读取；若要迁移自己的风格，需要另外复制自己的风格包并在网页显式导入。
它是本机服务；其他电脑需要各自解压启动。关闭启动终端或按 Ctrl+C 停止。
本地项目保存在用户应用数据目录 Video Studio/workbench，macOS 默认为 ~/Library/Application Support/Video Studio/workbench；请自行备份。不能直接双击 public/index.html。

不需要 npm install。`VIDEO_DEMO_CODEX_BIN` 可指定原生 Codex 可执行文件；
`VIDEO_STUDIO_PYTHON` 可指定 Python 路径。Windows 仅有 .cmd 包装器时需原生 codex.exe 或 WSL。
详细功能、恢复策略与技术验证见 plugins/video-studio/workbench/README.md。
SHA256SUMS.txt 可核对解压文件，ZIP 旁的 .sha256 可核对整个安装包。
'''


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
        (target / 'README.md').write_text(GUIDE, encoding='utf-8')
        (target / '先读我.txt').write_text(GUIDE, encoding='utf-8')
        (target / 'start.mjs').write_text("import './plugins/video-studio/workbench/start.mjs';\n")
        (target / 'start-macos.command').write_text('#!/bin/zsh\ncd -- "$(dirname -- "$0")" || exit 1\nexec ./plugins/video-studio/workbench/start-macos.command\n')
        (target / 'start.sh').write_text('#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\nexec sh ./plugins/video-studio/workbench/start.sh\n')
        (target / 'start-windows.bat').write_bytes(b'@echo off\r\ncd /d "%~dp0"\r\ncall sites\\video-agent-demo\\start-windows.bat\r\n')
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
