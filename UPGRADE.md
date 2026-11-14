# 升级到 Video Studio 0.3.0-web.38

适用：macOS，已有 web.35 / web.36 / web.37。发布日期：2026-11-15。发布分支：`video-generation-workbench`；固定标签：`v0.3.0-web.38`。

下载：[web.38 发行页](https://github.com/PRAXEND/chapter0/releases/tag/v0.3.0-web.38)。首次安装请按 [INSTALL.md](INSTALL.md) 配置自己的 Codex、ChatCut、浏览器权限及本地依赖。

## 本次更新

- 新竖版默认采用已确认排版：素材居中完整显示，白黄标题与白色字幕贴近素材，标题与两张封面一致，花字在素材内，密铺淡灰动态背景，1.2 秒渐隐及 0.6 秒黑屏。
- 修复旧任务遗留会话锁、轮次分页和派发警告，新增“查看会话运行状态”“核对并恢复”。已核实结束的旧任务可释放占用；不会强行取消仍在运行的任务或重复派发制作。
- 补音频原件后继续保留原批准和候选；修复手动克隆后正式配音、低音量配乐误判、关闭配乐漏检、历史素材预览及原声/配乐提示冲突。

升级保留个人配置、音色、旧项目、素材和交付文件。旧项目仍可预览/下载；新建项目使用新版规则。已有验收失败记录不会因升级变成通过，旧竖版方案也不会直接套用新排版。

## 1. 先结束在制任务并备份

在原工作台等待当前任务完成，或点击停止并确认桌面轮次确已结束。若仍在等待工具返回，先保留原运行环境。不要删除运行锁或结束所有 Node/Codex 进程。

备份以下目录到自己选择的位置；使用自定义数据/输出目录时，备份实际目录。停止写入后再复制。

```text
~/Library/Application Support/Video Studio/   # 音色偏好、风格、项目、会话和缓存
~/Movies/Video Studio/                       # 默认成片与临时交付
```

保留原 checkout 和 `.runtime/plugin-install.json`，不上传这些个人数据。无需删除 ChatCut 工程、账号认证或既有项目。

## 2. 获取发布分支及完整媒体

进入原 Video Studio checkout；有个人代码改动或分叉时，先保存或另建目录，不强制重置。

```sh
cd /你的路径/chapter0-video-workbench
git status --short
git fetch origin
git switch video-generation-workbench
git pull --ff-only origin video-generation-workbench
git lfs install --local
git lfs pull --include='user-packs/henry-video-styles/media/**' --exclude=''
python3 tools/verify_checkout.py --strict-tree
```

校验应显示 `version: 0.3.0-web.38`、42 个媒体文件，无缺件或哈希错误。媒体本次未变，完整的旧媒体会复用。源文件校验失败时先解决下载/本地改动，不继续安装。

## 3. 更新 Codex 中的插件副本

仅更新 Git 不会替换已经安装的插件缓存。终端沿用 [INSTALL.md 第 2 节](INSTALL.md#2-安装本机依赖与-codex) 的完整 Python、Node、FFmpeg 和 CLI 设置；已有 CLI 支持下列子命令后再执行。

```sh
export VS_CODEX="/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
# 若应用路径不同，使用自己已安装并验证的 codex CLI 路径。
"$VS_CODEX" plugin marketplace list
```

确认名为 `video-studio` 的来源指向第 2 步的 checkout。没有该来源时运行：

```sh
"$VS_CODEX" plugin marketplace add "$PWD" --json
```

如果同名来源仍指向旧目录或另一个来源，在确认任务已停止后，仅替换这个 marketplace；其他插件来源保持原样：

```sh
"$VS_CODEX" plugin marketplace remove video-studio
"$VS_CODEX" plugin marketplace add "$PWD" --json
```

从正确来源重新安装，并在验证新版本后才替换启动器使用的安装记录：

```sh
mkdir -p .runtime
"$VS_CODEX" plugin add video-studio@video-studio --json > .runtime/plugin-install.next.json && python3 - <<'PY'
import json
import os
from pathlib import Path

pending = Path('.runtime/plugin-install.next.json')
record = json.loads(pending.read_text())
installed = Path(record['installedPath']).expanduser()
plugin = json.loads((installed / 'plugin.json').read_text())
if (plugin.get('name'), plugin.get('version')) != ('video-studio', '0.3.0-web.38'):
    raise SystemExit('仍是旧插件；未替换原安装记录。请核对 marketplace 来源。')
os.replace(pending, '.runtime/plugin-install.json')
print('已安装 Video Studio', plugin['version'])
PY
python3 tools/run_workbench.py --check
```

若 `plugin add` 仍返回旧版，确认来源正确后可执行 `"$VS_CODEX" plugin remove video-studio@video-studio`，再重跑上面的安装和校验块。此操作仅卸载 Video Studio 插件缓存；不要删除个人 Video Studio 数据目录，也不要移除 ChatCut。如果当前 CLI 不支持这些子命令，按安装说明升级客户端，不能把失败输出当成安装成功。

来源登记、安装副本与重新加载的关系见 [OpenAI 官方插件说明](https://developers.openai.com/plugins/build/plugins)。上述 `plugin add/remove --json` 语法另外核对了发行时实际 CLI 的帮助信息。

## 4. 重启空闲工作台，确认运行版本

刷新/重启 Codex 桌面应用，在新聊天验证新版技能已经加载。制作会话仍需启用 Video Studio、ChatCut 和电脑控制；本次不需要重新登录已有正常工作的 ChatCut 账号。

原工作台服务必须已空闲：可以查看页面任务状态，或只读检查（自定义端口需替换 4317）：

```sh
curl -fsS http://127.0.0.1:4317/api/state | python3 -c 'import json,sys; s=json.load(sys.stdin); print({"busy": s["busy"], "hasActiveJob": s["activeJobId"] is not None})'
lsof -nP -iTCP:4317 -sTCP:LISTEN
```

确认 `busy=false`、`hasActiveJob=false`，并核对监听 PID 的命令确是旧 Video Studio 工作台。前台启动的服务在对应终端按 Ctrl+C；后台服务仅结束已核对的那个 PID。可请 Codex 完成这一步：“核对 4317 端口和任务空闲状态，只停止旧 Video Studio 工作台，保留所有项目数据。”不要使用 `killall node`、`pkill codex` 或删除锁来跳过核验。

在原 checkout 重新启动：

```sh
python3 tools/run_workbench.py
curl -fsS http://127.0.0.1:4317/api/health | python3 -c 'import json,sys; s=json.load(sys.stdin); print({"version":s["version"],"pluginRoot":s["runtimeIdentity"]["pluginRoot"]})'
```

刷新浏览器。源码校验、安装结果和页面/health **三处均应为 `0.3.0-web.38`**；`pluginRoot` 应是这次实际安装副本。版本不符时不要提交新制作，按来源、安装、旧进程三处逐一核对。启动器会拒绝复用版本或目录不一致的旧服务。

## 5. 升级后检查与会话恢复

1. “我的项目”中能看到原有项目，原素材和交付文件仍能预览、下载；已保存音色仍可选择。
2. 展开“桌面执行会话”，点击“查看会话运行状态”。若有已结束任务的遗留占用，点击“核对并恢复”；活跃或无法核实的任务仍保持占用，并给出原因。
3. 制作新视频点击“新的视频项目”。可复用空闲且已加载所需插件的专用桌面会话，不必因另一项目验收失败而每次另建会话。
4. 本版项目若只缺音频原件，补齐后按原流程继续即可；若是验收/创意问题，仍需确认修订。不要为了补文件重新创建 ChatCut 工程。

代码和安装检查不等于客户成片验收。首次实际试片仍执行完整独立验收，失败保留试片和报告，不绕过门槛。

## ZIP 用户与回退

| 下载文件 | 用途 |
|---|---|
| `Frame-Video-Studio-0.3.0-web.38.zip` | 含插件、工作台启动入口、INSTALL 与 UPGRADE；解压到新目录，保留旧目录 |
| `video-studio-plugin-0.3.0-web.38.zip` | 插件根目录包；供已有本地 marketplace/插件导入流程使用 |
| `video-studio-0.3.0-web.38.zip` | 按白名单构建的源码包，供开发或排查；不是含完整媒体的 Git checkout |
| `SHA256SUMS.txt` | 对应下载文件的 SHA-256；下载后在同目录运行 `shasum -a 256 -c SHA256SUMS.txt`，只下载部分文件时仅检查对应行 |

这些 ZIP 和 GitHub 自动生成的源码包均不承诺携带完整 LFS 媒体。升级可继续使用自己原有的完整媒体登记；更换媒体目录时按 INSTALL 第 4 节重新 `styles link-pack`。首次用户推荐 Git + LFS 安装。插件单包应放到自己的 marketplace 指向的目录，再重新安装，不把 ZIP 覆盖到正在使用的缓存目录。

### 便携工作台 ZIP 的独立升级路径

便携 ZIP 不含 Git 元数据和 `tools/`，因此**跳过上文 Git、verify_checkout 和 run_workbench.py 命令**。按第 1 节备份，解压到新目录，保留完整的旧风格媒体目录和个人数据，然后在已配置完整 Python、Node、FFmpeg 的终端执行：

```sh
cd /你的路径/Frame-Video-Studio-0.3.0-web.38
export VS_CODEX="/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
shasum -a 256 -c SHA256SUMS.txt
"$VS_CODEX" plugin marketplace list
```

若已有名为 `video-studio` 的来源，确认这是原 Video Studio 来源后先运行 `"$VS_CODEX" plugin marketplace remove video-studio`，再登记本便携目录并安装。其他插件来源保持原样。

```sh
"$VS_CODEX" plugin marketplace add "$PWD" --json
mkdir -p .runtime
"$VS_CODEX" plugin add video-studio@video-studio --json > .runtime/plugin-install.next.json && python3 - <<'PY'
import json
import os
from pathlib import Path

pending = Path('.runtime/plugin-install.next.json')
record = json.loads(pending.read_text())
plugin = json.loads((Path(record['installedPath']).expanduser() / 'plugin.json').read_text())
if (plugin.get('name'), plugin.get('version')) != ('video-studio', '0.3.0-web.38'):
    raise SystemExit('插件副本版本不正确；保留原安装记录，请核对来源。')
os.replace(pending, '.runtime/plugin-install.json')
print('Codex 插件副本已更新至', plugin['version'])
PY
```

按第 4 节核对并停止旧空闲服务，刷新/重启 Codex 以加载新版技能。随后在便携包目录运行：

```sh
export VIDEO_STUDIO_PLUGIN_ROOT="$PWD/plugins/video-studio"
export VIDEO_STUDIO_PYTHON="$(command -v python3)"
export VIDEO_STUDIO_FFMPEG_DIR="$(dirname "$(command -v ffmpeg)")"
export VIDEO_DEMO_CODEX_BIN="$VS_CODEX"
node start.mjs
```

该终端保持运行；在另一个终端用第 4 节的 health 命令检查。便携启动的 `pluginRoot` 应为**本便携目录下的 `plugins/video-studio`**，版本为 `0.3.0-web.38`；Codex 使用的插件缓存副本已在上一步单独校验，两者位置不同是正常的。显式设置 pluginRoot 可避免继承旧启动环境的插件路径。保留自己已有的数据目录和媒体路径设置，不套用别人的路径。

### 回退

需要回退时，先停止新版任务和服务；使用保留的旧 checkout/安装包重新安装旧插件。web.35 发布基线是 `76aac51`，可在另一个 checkout 查看该提交，勿强制重置有个人改动的工作区。保留新版全部数据，用**新的隔离目录**启动旧版并新建测试项目：

```sh
export VIDEO_STUDIO_HOME="/你的路径/video-studio-web35-rollback/profile"
export VIDEO_STUDIO_WEB_DATA="/你的路径/video-studio-web35-rollback/workbench"
# 在旧 checkout 中按旧版安装说明启动；新项目也选择单独的输出目录。
```

两个变量都要设置，单改 `VIDEO_STUDIO_HOME` 不会迁走工作台项目。备份和原交付文件可只读查阅；复制的项目 JSON 含 run/source 的绝对路径，不能当作已经迁移、可直接续做的项目，否则仍可能访问原目录。恢复旧项目继续制作需要另外核对并迁移路径，本升级流程不执行该操作。旧版不包含本次会话恢复与配乐修复。
