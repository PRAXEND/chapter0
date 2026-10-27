# Video Studio

按用户选择的题材和风格制作视频，并把参考脚本、视频提炼成下次可调用的风格技能。

**Video Studio 0.2.4 · macOS / Codex · 依赖已安装且登录的 ChatCut**

## 组成

| 层 | 作用 |
|---|---|
| 本次制作要求 | 题材、目的、受众、语言、时长、画幅、声音、字幕 |
| 可选个人风格技能 | 从用户参考提炼的叙事、镜头、节奏、文字、图形与声音规则 |
| 通用工具技能 | 素材采集、ChatCut 编辑、声音字幕、完整验收与交付 |

通用层不预置机器人主题、男声、科技风、竖屏、90秒、快切或MG模板。个人风格库初始为空。选择风格后，素材采集同时考虑“内容相关”和“表现形式合适”；未指定风格时按本次需求创作，不自动保存为默认风格。

## 技能

- `video-project`：解析本期要求，选择并加载实际风格 SKILL.md，组织工具。
- `setup-video-studio`：检查本地依赖，发现并引导安装 ChatCut 等所需插件，验证连接并保存明确偏好。
- `video-source-tools`：按题材与风格形成采集计划，核实和获取素材。
- `chatcut-edit-tools`：项目、导入、时间线、MG、转场的工具用法。
- `video-audio-tools`：配音、音乐、字幕与真实时序同步。
- `learn-video-style`：参考分析、风格技能保存、版本更新与复用。
- `video-quality-review`：独立完整验收与问题修复复查。
- `video-delivery-tools`：导出任务、文件与可编辑工程交付。

## 使用方式

首次配置或缺少插件时：

> 使用 $setup-video-studio 检查环境，缺少 ChatCut 等依赖插件时引导我安装并验证连接。

技能会检查已有工具并搜索真实插件来源，提供安装或登录入口。搜索无结果时会请你提供发布者安装链接，不会猜测 ChatCut 地址。安装状态与连接状态分别报告；需要时新建聊天重新验证。本地依赖检查通过不等于完整制片环境就绪。

> 用 Video Studio 做一个咖啡制作视频，横屏、三分钟，先让我选择表现风格。

> 把这个脚本和参考视频的风格保存为“我的过程解说”。下次我选择这个风格时，结合新的题材找素材和剪辑。

> 用“我的过程解说”做一期旅行视频，本期不要配音，保留现场声。

> 使用 $video-quality-review 完整验收这条视频，列出问题时间点；修复后再完整复查。

已给题材直接采用；未给题材询问或按明确委托选题。仅提供脚本时提炼叙事/语言，无法观察的画面、节奏、动画、声音维度保持未知。提供视频时分析连续片段与实际声音。规则保存有证据位置、检验方法和跨题材适配说明；工具不会把“保存成功”冒充“风格复现已通过”。

风格文件位于 `~/Library/Application Support/Video Studio/styles/<id>/<version>/`，含真正的 SKILL.md、style.json 和校验清单。由插件主动发现读取，下一次聊天可选择；不是自动注册到全局技能列表。升级插件不会覆盖个人库，发行包不包含用户参考和个人风格。每期固定风格版本及内容快照，本期覆盖不会修改库。

需要可点击选择时，`styles choices` 返回真实名称、版本、维度和验证状态，由宿主按[风格选择流程](plugins/video-studio/references/style-selection.md)显示单选卡片。选择风格不自动提交生成任务。

本分支保留团队八技能架构。源码中的可选 `user-packs/shawn-robotics/` 保存本项目“反差故事型”“动作拆解型”、BOTPIE有限样本分析与制作经验，不随通用ZIP分发、不作为他人默认。明确导入本人的风格与偏好：

```sh
python3 plugins/video-studio/scripts/studio.py styles import \
  --file user-packs/shawn-robotics/manifest.json --apply-preferences
```

去掉 `--apply-preferences` 只导入风格。两种风格均保持 unverified；总体试片好评不等于逐项风格验收。原始录音、视频、账号状态与会话连接编号不进用户包。

后续整合17条用户参考的七类个人风格位于源码仓库的 `user-packs/shawn-style-fusion/README.md`：能力快报、反差故事、动作拆解、类比科普、案例归纳、产业脉络、观点论证。导入该包后，原两类使用v2，原v1保留；新五类为v1。该包不改偏好和默认，不进入通用ZIP；仅下载通用ZIP时，需要另从源码仓库获取可选个人包。证据为全长机器转录、分布抽帧和代表区间连续抽帧，未完成所有原片的完整实时播放与听审，保存状态仍为unverified。

## 默认交付物

每期完整制片交付到 `~/Movies/Video Studio/YYYY-MM-DD_选题/`（可由本期输出目录或已保存偏好覆盖），默认包含四个文件：

```text
2026-10-27_本期选题/
├── 完整视频.mp4
├── 封面_竖版_3x4.png
├── 封面_横版_4x3.png
└── 发布文案.txt
```

封面分别排版，建议 1440×1920 与 1920×1440；3:4、4:3 仅指封面比例，视频规格仍由本期要求决定。TXT 使用 UTF-8，含定稿发布标题、正文和可复制的话题标签。正文从真实反差、具体问题或观点切入，补足背景和观看理由，吸引观看与讨论。日期按用户本地时区，重名及改版目录保留后缀以避免覆盖。工程链接、字幕、脚本、来源及验收记录保存在工作 run，用户要求时再额外交付。准备发布包不执行发布。

源码还提供可选个人包 `user-packs/henry-video-styles/README.md`，包含热点资讯型与技术科普型各自最新的 v7 规则，无变体。风格 ID 为 `henry-hot-news@7`、`henry-technical-explainer@7`，需显式导入，不改全局偏好或默认风格，不随通用 ZIP 分发。

该可选包附实际参考原片、两条试片与源媒体、MG 源码及时间线记录，媒体约 473 MB，通过 Git LFS 获取。在源码仓库执行 `git lfs pull --include='user-packs/henry-video-styles/media/**'`，再运行 `python3 user-packs/henry-video-styles/verify.py`；完整导入与复现步骤见包内 README。

## 独立完整验收

检查整片与全部事件边界，并记录时间/帧号、实际证据、严重程度、修复与复查：

- 音画、对白/动作/拟音、解说与动画同步，以及累计漂移。
- 不同素材、字幕、MG、遮罩和运动主体之间的意外遮挡。
- 背景音乐的情绪节奏、音量、可懂度、ducking、循环接缝与淡入淡出。
- 所有硬切和转场的源余量、残帧、跳位、黑边及连续性。
- 字幕时间与进出动画、换句换行、闪现、拖尾、抖动和可读性。
- 闪帧、黑白帧、重复/丢帧、异常冻结、亮度跳变、图层开关及运动断点。
- 比例、尺寸、fps、清晰度、文字数字、裁切安全区、音质、首尾及最终文件完整性。

[完整验收技能](plugins/video-studio/skills/video-quality-review/SKILL.md)与[记录规范](plugins/video-studio/references/quality-review.md)区分自动检测线索、实际观看/听审通过和未验证。没有感知证据不能填通过，旧导出审核不能替代新导出审核；有意的风格效果按当前要求判断。

## 安装与验证

安装包：`dist/video-studio-0.2.4.zip`，校验文件同目录。解压后的根目录包含 marketplace 和 plugins：

```sh
shasum -a 256 -c video-studio-0.2.4.zip.sha256
unzip video-studio-0.2.4.zip
codex plugin marketplace add ./video-studio-0.2.4
```

在插件目录选择 Video Studio 本地来源安装，并在新聊天验证技能。安装缓存与市场源不是同一份文件；不要手工改缓存。插件目录与本地市场机制见 [OpenAI 官方文档](https://developers.openai.com/plugins/build/plugins)。

ChatCut 必须单独安装并认证。制作由 Codex 调用 ChatCut；本地脚本不自行联网调用生成服务。系统依赖为完整 Python 3.10+、FFmpeg/ffprobe，以及下载时需要的 Node 或 Deno 与 yt-dlp。`bootstrap` 仅安装独立 Python 下载依赖。

从源码根运行：

```sh
python3 plugins/video-studio/scripts/studio.py doctor
python3 plugins/video-studio/scripts/studio.py styles list
python3 -m unittest discover -s tests -v
python3 tools/package.py
```

doctor 本地成功不表示 ChatCut 已连接。使用宿主完整 Python；损坏的系统 Python 不用于验证。

保留0.1.8的只读 `connection` 命令，区分注册、工具加载、认证与实时调用结果，续做时检查已下载素材哈希和未知任务。缺失/变更的已完成下载不会因时长接近而自动重新登记或下载。`max_seconds` 按视频流时长检查并保留 0.1 秒容差；缺少视频流时长字段时回退到容器时长。音频编码尾部补齐不扩大画面验收范围。

## 数据与兼容

运行目录默认 ~/Movies/Video Studio；VIDEO_STUDIO_HOME 可指定状态根，VIDEO_STUDIO_FFMPEG_DIR 指定二进制目录。规格来自本期 brief；宽高为偶数正整数，fps/时长可配置，实际输出仍以 ChatCut 能力为准。默认6视频源/300秒是可调整的下载预算，不是风格。

0.1.x 的旧 creative/style 和固定规格不自动导入。旧 run 的 schema 1 留给原插件继续，新版 schema 2 不覆盖旧项目。用户明确的音色等偏好可按需迁移。本包不包含发布、定时监控或后台制片服务。

[命令与记录](plugins/video-studio/references/operations.md) · [风格规格](plugins/video-studio/references/style-format.md) · [可选诊断](plugins/video-studio/references/diagnostics.md) · [验证范围](VALIDATION.md)
