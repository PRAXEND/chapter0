# Video Studio for Mac

本地视频工作台提供选题成片、脚本混剪、原声访谈精剪三个入口。项目中的对话、手工时间线、风格样板与审片共用帧时钟和版本记录。选题可填写出处网页和媒体直链。正常渲染直接写出 MP4、SRT 和便携工程，启用发布包可附两种封面及文案。

## 使用

在 Apple Silicon Mac 打开 Video Studio.app。首次用“本机与账号”连接自己的 Codex 账号。“新建工程”可以直接开始制作，也可先导入文件。模型准备与生成进度显示在工作台。首次使用转录或克隆时会下载对应本机组件。点击“本地粗剪”可从已有素材生成草稿。互联网选材使用登记的公开媒体接口或用户选择的直链。

- 在素材预览中登记动作发生的原片帧。时间线上点片段可改起点、原片窗口、内容、速率、音量和锁定。渲染后可以在播放头处分割画面。精剪原片支持按句试听及按原片顺序恢复。选中镜头可直接回看原素材区间。制作中可看当前版本的六秒草稿，也可发新指令给进行中的 Codex 回合。
- 工程设置可选同期声、系统声音、已录旁白或克隆。在本机登记已获授权的参考录音、准确原文并试听。原声、参考音频和媒体文件保存在本机。选择“允许分享参考帧”可让 Codex 读取受控抽帧。关闭转录分享时，本机识别的画面文字也不会传入模型。
- 风格库可播放经过指纹核验的参考片。单个参考视频可在本机分析并抽取带源时间码的代表帧。保存个人改稿偏好会生成新版，附改动前后两段可播放样例。已固定版本的工程可继续打开。历史入口支持按原指纹导入原素材或旧成片，以及打开已登记的旧编辑工程。
- 等待中或运行中的任务可暂停。恢复后重用冻结版本或同一个 Codex 回合。中断时无法核实回执的第三方付费请求会在项目内保留，由用户核对后继续。关闭窗口可继续后台工作，用应用菜单退出会保存任务进度。
- 在“交付”播放带问题时间点的原速片段。机器验收支持可交付、可交付有建议、待复核和需修复。正式成片默认保存到“影片/Video Studio/交付”。“可编辑工程”文件夹内含 project.vstudio.json 和媒体。复制整个文件夹后，可在“新建工程 → 打开工程文件夹”恢复。
- 点击“看片盲评”可直接打开已准备的本机研究，或从当前工程创建校准、留出、风格及成对研究。审片人各用自己的代号、看片后独立作答。真实人审计数和机器判定分别展示。

## 开发与构建

需要 Node 24 和 Apple Silicon macOS。构建还需要 Xcode Command Line Tools、Git LFS 与 Rust。基本程序的 macOS 二进制最低版本为 13.5，Apple Silicon 本地克隆需要 macOS 14 或更新版本。实机验证平台是 8 GB M1、macOS 26.5.2。

```sh
cd apps/studio
node src/server.mjs
node --test test/*.test.mjs
node scripts/test-webview.mjs /tmp/video-studio-webview.png
node scripts/prepare-media.mjs all
node scripts/build-mac.mjs
```

Node 服务只监听环回地址。命令行启动时会显示一次性本地入口。Tauri 内置 Node、Codex、FFmpeg/ffprobe、可用的 whisper-cli 与公开风格包；已发布的风格媒体按 Git LFS SHA-256 和大小物化。构建从官方 npm 包取得固定版 Codex 并验证 SHA-512。本地包采用 ad-hoc 签名。对外分发需要发行方自己的 Developer ID 签名与 Apple 公证。

默认资料库位于 ~/Library/Application Support/Video Studio/standalone。STUDIO_DATA_ROOT 可以选择独立资料库，STUDIO_DELIVERY_ROOT 可选择导出目录。模型缓存由 VIDEO_STUDIO_MEDIA_HOME 指定。STUDIO_START_VIEW=blind 可直接打开盲评室，STUDIO_REVIEW_ROOT 可指定另一套研究库。prepare-media 的 render、speech、clone 子命令可分开运行。

## 工程与恢复

SQLite 保存当前工程、不可变编辑版本和任务。素材按 SHA-256 导入工程目录。用户与 Codex 共用带 baseRevision 的原子剪辑命令。每个任务冻结创作证据和时间线，渲染时发生的新修改属于下一版。临时输出与正式交付分开保存；审片证据关联实际 MP4/SRT 指纹。新资料库通过 OS 支持的数据库锁协调单写入服务。项目设置和密钥各自管理，ElevenLabs 密钥仅用于当前进程。

媒体适配器和模型准备见 scripts/prepare-media.mjs。已授权的公开技术样片可用 scripts/media-proof.mjs 复做，scripts/open-proof-project.mjs 可将该样片导入独立工程、以真实 Codex 重写一处字幕并校验其余编辑对象。研究使用的前台配对条件见 test/foreground-comparison.md。
