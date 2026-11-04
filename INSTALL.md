# Video Studio 工作台安装与完整使用说明

适用版本：`0.3.0-web.34`；Git 分支：`video-generation-workbench`；支持平台：macOS。仓库：https://github.com/PRAXEND/chapter0 。本说明核对日期：2026-11-05。

这份仓库提供插件、网页工作台、公开风格规则、参考试片、复现媒体和校验工具。Codex、ChatCut 账号、电脑/浏览器授权和服务额度需要使用者自行配置。不能只下载 `plugins/video-studio` 文件夹：风格媒体位于仓库根目录 `user-packs/henry-video-styles`，通过 Git LFS 下载。

## 1. 从 git pull 获取本分支

已经有仓库时，先进入自己的 checkout。工作区有未提交改动时先保存，或者使用下方“首次下载”建立独立目录，不在官网等其他工作区强行切分支。

```sh
cd /你的路径/chapter0
git status --short
git fetch origin
git switch video-generation-workbench
git pull --ff-only origin video-generation-workbench
```

首次切换时，Git 通常会自动建立远端跟踪；若没有，执行 `git switch --track origin/video-generation-workbench`。若分支已发生本地分叉，`--ff-only` 会拒绝：保留修改并另建干净 checkout，不执行强制重置。

首次下载：

```sh
git clone --single-branch --branch video-generation-workbench \
  https://github.com/PRAXEND/chapter0.git chapter0-video-workbench
cd chapter0-video-workbench
git pull --ff-only origin video-generation-workbench
```

Git 尚未安装时先安装 macOS Command Line Tools：`xcode-select --install`。Git LFS 尚未安装时按下一节安装，再完成第 3 节；普通 clone/pull 成功不代表大媒体已经下载。

## 2. 安装本机依赖与 Codex

| 依赖 | 要求 / 用途 |
|---|---|
| Node.js | 20+，运行工作台；无须 `npm install` 安装工作台依赖 |
| Python | 完整 3.10+，推荐 3.12；需要 venv、ssl、json、email、urllib 标准库 |
| FFmpeg / ffprobe | 实际可运行，含 drawtext、loudnorm 等插件前检要求的过滤器 |
| Git LFS | 下载 42 个风格音视频文件，合计约 473 MB（452 MiB） |
| Codex 桌面端与 CLI | 默认桌面制作要求 `queue --thread --message --resume`；独立验收要求 `exec --ephemeral --json --output-schema --add-dir --approve-for-me` |
| ChatCut hosted 插件 | 同一用户账号的工程、可编辑剪辑、音色、生成与导出 |
| 浏览器 | 当前 Codex 会话可以控制的浏览器，登录 ChatCut，导出期间保持编辑器打开 |

已安装 Homebrew 的 Mac 可以运行：

```sh
brew install node python@3.12 ffmpeg git-lfs
export PATH="$(brew --prefix python@3.12)/libexec/bin:$(brew --prefix)/bin:$PATH"
python3 --version
python3 -c 'import json, ssl, venv, email.encoders, urllib.request; print("Python OK")'
node --version
ffmpeg -version
ffprobe -version
git lfs version
```

若某个命令报告动态库或 Python 标准库缺失，先修复安装或选择可用的完整程序；不要继续使用报错的同名命令。本仓库不依赖原作者电脑上的 Python/FFmpeg 路径。

从 [OpenAI 桌面应用说明](https://learn.chatgpt.com/docs/app) 安装支持 Codex 桌面会话的当前应用并登录自己的账号；CLI 安装方法见 [Codex CLI 官方说明](https://learn.chatgpt.com/docs/codex/cli)。已有 `/Applications/Codex.app` 时，可选用其自带 CLI：

```sh
export VS_CODEX="/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
# 若此文件不存在，请使用已安装且通过下列检查的 CLI：
# export VS_CODEX="$(command -v codex)"
"$VS_CODEX" --version
"$VS_CODEX" plugin add --help
"$VS_CODEX" queue --help
"$VS_CODEX" exec --help
"$VS_CODEX" login status
export VIDEO_DEMO_CODEX_BIN="$VS_CODEX"
```

本次发行实测 CLI 为 `0.166.0-alpha.5.1`，以所需命令实际存在和工作台“重新检测”通过为准；只满足版本号不代表模型或桌面队列兼容。缺少 `queue` 或 `--approve-for-me` 时升级实际选用的应用/CLI，不静默切到其他模型。未登录时执行 `"$VS_CODEX" login` 并完成自己的登录。

`VS_CODEX`、PATH 等 export 只对当前终端有效；重新打开终端时重新设置。后面命令默认仍在仓库根目录。

## 3. 下载并核验全部风格媒体

```sh
git lfs install --local
git lfs pull --include='user-packs/henry-video-styles/media/**' --exclude=''
python3 tools/verify_checkout.py
```

校验器逐项检查发行清单的文件大小和 SHA-256，同时检测 LFS 指针，并验证 Henry 包全部 75 个登记文件。输出中的 `media_files` 应为 `42`，不得出现 Missing、Changed bytes 或 LFS pointer。GitHub 的 Download ZIP 和 `git archive` 不能替代这一步。

内容包括两条基准试片、10 条参考视频、实际复现用视频/旁白/配乐/音效、MG 代码、时间线、字幕卡和来源清单。参考媒体用于观察风格和复现，不会自动成为每个新视频的素材。新题材仍需获取相应真实画面。

ChatCut 运行环境提供字体和编辑器效果；字体文件不在此仓库。Henry 参考使用 Xinqingnian Ti / Noto Sans SC，制作前须核对字体实际可用性；替换字体需要重新检查排版。素材来源和 Wallpaper 配乐署名见 `user-packs/henry-video-styles/README.md`，媒体齐全不额外授予第三方素材版权。

## 4. 安装插件、下载工具并登记媒体位置

先核验依赖，再安装下载器。`bootstrap` 在个人 Video Studio 状态目录创建独立 Python 环境，不要求全局 pip 安装：

```sh
export VIDEO_STUDIO_PYTHON="$(command -v python3)"
export VIDEO_STUDIO_FFMPEG_DIR="$(dirname "$(command -v ffmpeg)")"
python3 plugins/video-studio/scripts/studio.py bootstrap
python3 plugins/video-studio/scripts/studio.py doctor
```

`doctor` 必须显示本地工具就绪；这不表示 ChatCut 已认证。`yt-dlp` 版本固定在 `requirements-runtime.txt`；下载器需要 Node 或 Deno 作为实际脚本运行环境。

登记完整媒体包，并显式导入两种 Henry 风格：

```sh
python3 plugins/video-studio/scripts/studio.py styles link-pack \
  --file "$PWD/user-packs/henry-video-styles/manifest.json"
python3 plugins/video-studio/scripts/studio.py styles import \
  --file "$PWD/user-packs/henry-video-styles/manifest.json"
python3 plugins/video-studio/scripts/studio.py preflight \
  --capability python --capability media --style henry-hot-news@8
python3 plugins/video-studio/scripts/studio.py preflight \
  --capability python --capability media --style henry-technical-explainer@8
```

这不会导入原作者音色或设置全局默认风格。不要加 `--apply-preferences`。导入后保留 checkout：媒体仍在该目录；移动目录后重新运行 `styles link-pack`。工作台还可浏览另外七种已公开的文本风格；这些风格没有随包承诺参考试片，不应把外部参考链接冒充本地媒体。

安装本地 marketplace，保存 CLI 返回的实际安装目录：

```sh
mkdir -p .runtime
"$VS_CODEX" plugin marketplace add "$PWD" --json
"$VS_CODEX" plugin add video-studio@video-studio --json > .runtime/plugin-install.json
```

插件安装到 Codex 缓存，仓库与安装目录不是同一位置；启动工具会读取 `.runtime/plugin-install.json`，不硬编码用户名。marketplace 操作依据 [OpenAI 插件打包与安装说明](https://developers.openai.com/plugins/build/plugins)；这里的 `plugin add` 参数另以发行时本机 CLI `--help` 核对。

如提示同名来源已存在，先用 `"$VS_CODEX" plugin marketplace list` 核对来源。确实是要替换的旧 Video Studio 来源时，等待制作停止后执行 `plugin marketplace remove video-studio`，再执行上面的 add；不要移除 ChatCut 或其他插件。刷新/重启桌面应用并新建制作会话，使新插件技能加载。

## 5. 配置 ChatCut 与浏览器

在 Codex 插件目录搜索并安装发布者提供的 ChatCut hosted 插件，登录自己的账号。Video Studio 的 `chatcut-edit-tools` 是操作说明，不能代替 ChatCut 连接。

在新会话发送：

> 请使用 Video Studio 的 setup-video-studio 和已安装的 ChatCut 基础技能检查 hosted 连接，只做只读检查，不创建视频、不生成声音。确认工具可调用后告诉我。

若没有注册 hosted MCP，由 ChatCut 当前基础技能引导注册；已存在时复用。需要登录时按该技能执行 `codex mcp login chatcut`，在浏览器完成认证后回到同一会话。不要复制别人的 config.toml、auth.json、令牌或账号状态；不要反复创建重复连接。实际 `list_projects` 成功（空列表也算）才是工具连接通过。

在将用于制作的浏览器登录同一个 ChatCut 账号。通过该 Codex 会话检查浏览器打开页面、点击和读取是否可用；按界面完成必要的操作系统/浏览器授权。模型生成和导出可能消耗自己的服务额度。

本流程使用 **Codex 桌面会话控制 ChatCut 网页版**。电脑上安装 ChatCut Desktop 不能替代此 hosted 链路；不要因 hosted 暂时失联切换到另一个产品。

## 6. 启动工作台并选择桌面制作会话

在上述终端运行：

```sh
python3 tools/run_workbench.py --check
python3 tools/run_workbench.py
```

正常返回 `ok:true`、`version:0.3.0-web.34` 和 `http://127.0.0.1:4317`。浏览器打开该地址即可。服务在后台运行，日志在个人应用数据目录。启动工具会携带当前完整 Python、实际安装目录和此 checkout 的媒体路径；不用双击 HTML，不用安装网站开发依赖。

首次使用在页面的“桌面执行会话”区域完成：

1. 在 Codex 桌面端建立专用制作会话，开启“完全访问”，发送一条简短消息并等待完成。
2. 确认该会话已加载 Video Studio、ChatCut 和电脑控制，并能操作目标浏览器。
3. 工作台点击“读取桌面会话”，选择这个会话，再点“检查权限并保存”。这两个按钮只读取本机状态，不启动制作。
4. 保持桌面应用可用，制作时不要在同一个会话插入其他任务；保持 ChatCut 编辑器标签页打开，特别是导出阶段。

“完全访问”不代替 macOS、浏览器、网站或宿主单独的授权。若出现实际授权提示，须由账号持有人完成；插件不能保证所有电脑都不会再弹窗。

主制作、音色和素材任务进入选定桌面会话；正式质量检查仍使用独立验收会话，避免制作方自评。不要设置 `VIDEO_STUDIO_AGENT_MODE=cli`，除非明确选择兼容执行模式。

如果 4317 已有旧服务，启动器会报告身份不同并拒绝冒用。先在旧工作台停止/等待任务结束，再请 Codex 仅停止占用此端口的旧 Video Studio 服务，随后重新运行启动命令。不要无差别结束所有 Node/Codex 进程。

## 7. 一键生成视频

点击“我的项目”新建项目，填写：

| 配置 | 操作 |
|---|---|
| 主题方向 | 例如“最近机器人落地应用的真实进展，面向普通观众” |
| 时长 | 新项目默认 60–70 秒，可以修改上下限 |
| 画幅 | 竖版 9:16 或横版 16:9 |
| 视频风格 | 一键按钮上方的下拉框选择，Henry 热点/科普为 v8 |
| 配音音色 | 使用已保存音色、官方音色、已有克隆，或上传录音创建克隆 |
| 高级设置 | 默认开启字幕；配乐未明确覆盖时按风格决定；可设置本地输出目录 |

已有可用音色可以直接选择。查询账号音色目录或创建克隆在点击一键后执行；若所选克隆不存在，会在工作台提示上传录音并确认本人声音或已获授权。成功后保存到自己的配置，之后复用。不要上传参考片中的他人声音来冒充授权录音。

**点击“一键生成视频”才提交本轮后台制作。** AI 在同一主会话核实选题、选素材、写稿、搭分镜与动效并剪辑；按实际素材和声音推进，不需要人工逐个审查中间表格。具体方案通过宿主检查点保存，生成任务 ID 和原工程会保留。

右侧查看当前阶段、真实工具记录和 Token 用量。等待导出下载时保持浏览器和编辑器打开，使用已有 render ID，不重新点一键提交第二份制作。没有固定完成时长承诺：取材、生成服务、下载和模型负载都会影响速度。

需要自己逐步审阅时，可切换手动模式：采集并选择素材 → 审阅文案与分镜 → 确认方案 → 制作 → 独立验收。已有待验收候选应选择继续验收，不重新制作。

## 8. 替换批准、补充反馈和停止

一键按钮下方常驻“修订与补充反馈”：

- AI 提议替换时，显示具体新旧素材、源片段、文案变化和原因；AI 修订建议会预填输入框。
- 可直接点“批准替换 / 修订并继续制作”，也可先编辑要求再确认。确认后沿用原工程局部修改，并重新保存对应方案批准。
- “保存反馈”只保存文字，不调用模型；运行期间也可先保存，当前任务结束或停止后再确认执行。
- “停止制作，保留现有文件”会请求停止。正在执行的工具可能尚未返回，等待状态变为已停止；必要时在选定桌面会话停止该轮。

普通“继续一键生成”不能代替尚未确认的替换批准。旧页面的建议令牌与当前项目不一致会被拒绝，刷新确认最新建议，不重复点击。

## 9. 验收与最终交付

候选落盘后先保存临时文件。程序检查完整媒体、真实音频/词时间、字幕和交付包，已知硬性问题不再启动重复模型审阅。客观预检通过后，由独立 Agent 检查全部原定联系表和加密边界、原尺寸疑点帧、试片风格对照。声音以响度、峰值、波形、实际旁白对齐及字幕时序检查；不会声称完成了实际听审。

通过全部要求才显示正式合格交付，默认目录：

```text
~/Movies/Video Studio/YYYY-MM-DD_选题/
  完整视频.mp4
  封面_竖版_3x4.png
  封面_横版_4x3.png
  发布文案.txt
  字幕.srt                 # 开启字幕时
  其他工程/来源/验收文件   # 以本次实际文件列表为准
```

封面比例与视频横/竖画幅是分别控制的。发布文案包括标题、正文和 #话题。可以打开本地文件夹、预览视频、下载文件，也可回到 ChatCut 可编辑工程。准备交付不会自动发布到任何平台。

**验收失败即暂停，不自动追加下一轮制作。** “成片与交付”中提供标明“尚未通过验收”的临时包，包括实际 MP4、启用时的 SRT、两版封面、发布文案、工程方案、来源和失败报告；支持完整 ZIP 下载。文件缺项会明确列出，不能当成完整合格包。你可看完后确认修订继续，或停止并保留结果；新导出必须重新验收，旧通过结果不能套用。

## 10. 更新、备份与常见问题

后续更新顺序：停止或等待当前任务完成 → `git pull --ff-only origin video-generation-workbench` → `git lfs pull --include='user-packs/henry-video-styles/media/**' --exclude=''` → `python3 tools/verify_checkout.py` → 按第 4 节刷新本地来源并重新 `plugin add` 保存安装 JSON → 重启空闲工作台 → 刷新页面。若 CLI 报告已安装而版本未更新，核对来源和安装返回值，必要时仅移除并重装 Video Studio 插件，保留用户数据目录。

个人数据默认保存在：

```text
~/Library/Application Support/Video Studio/
  profile.json、styles/、user-packs/     # 个人配置与风格登记
  runtime/                             # 独立 Python 下载环境
  workbench/                           # 项目、素材缓存、任务及桌面会话设置
~/Movies/Video Studio/                  # 默认成片与临时交付
```

备份这些目录时先停止正在进行的写入；这些数据不提交到 Git。`.runtime/plugin-install.json` 也是本机安装元数据，不随分支上传。

| 现象 | 处理 |
|---|---|
| 媒体只有几行文字 / 预检缺素材 | 执行 Git LFS pull，再运行 verify_checkout；确认登记的是仓库完整媒体包 |
| 风格文件哈希不一致 | 保留自己的修改，另建干净 checkout；不修改校验值跳过检查 |
| 无法读取已选桌面会话 | 保持桌面应用打开；新会话先发送一条消息再读取；重新检查权限并保存 |
| Chrome 权限被拒绝 | 在实际制作会话和系统/宿主设置检查授权；“完全访问”不能代替独立浏览器许可 |
| ChatCut 未连接 | 按当前 ChatCut 基础技能区分注册、认证和工具加载失败；复用现有连接，不循环重装 |
| FFmpeg / Python 报错 | 运行 doctor，修复实际执行路径或完整依赖；设置 VIDEO_STUDIO_PYTHON / VIDEO_STUDIO_FFMPEG_DIR 后重启空闲服务 |
| 端口版本不匹配 | 等旧任务结束，只停止旧工作台服务，再启动此次安装目录 |
| 验收失败 | 下载临时包，阅读具体问题，在修订入口确认后继续；不要重新创建整个工程 |
| 手机打不开 localhost | 127.0.0.1 仅指当前电脑；本分支不附作者的临时隧道。远程访问需另外配置带访问控制的通道 |

## 11. 可选的开发验证

以下使用隔离协议替身与诊断媒体，不生成收费视频：

```sh
python3 -m unittest discover -s tests
node --test plugins/video-studio/workbench/test/*.test.mjs
python3 tools/bundle_style_packs.py --check
python3 tools/package.py
```

`dist/` 的通用插件 ZIP 不包含大型媒体；完整 Git 分支加 LFS 才是本说明保证的代码与媒体来源。每个新使用者仍须验证自己的 Codex/ChatCut 连接和浏览器能力，发行测试不代表替别人完成了账号登录或实际成片验收。
