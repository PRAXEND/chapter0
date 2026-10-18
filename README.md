# Robot Video Studio

把机器人资讯制作成 **60–120 秒、中文配音、可编辑的竖屏短视频**。

从选题和来源核实开始，收集少量相关实拍素材，编写口语化脚本，通过已连接的 ChatCut 制作配音、B-Roll、动态文字、字幕及配乐，检查后交付 MP4、SRT 和编辑工程。

**版本：0.1.7 · 平台：macOS 上本地执行的 Codex · 分支：`video-generation`**

[下载安装包](https://github.com/PRAXEND/chapter0/raw/refs/heads/video-generation/dist/robot-video-studio-0.1.7.zip) · [SHA-256](https://github.com/PRAXEND/chapter0/raw/refs/heads/video-generation/dist/robot-video-studio-0.1.7.zip.sha256) · [验证记录](VALIDATION.md) · [更新记录](CHANGELOG.md)

## 1. 工作方式

这是由 Codex 执行的插件工作流，配有本地辅助脚本。制作期间需要 Codex、网络和已登录的 ChatCut；本地脚本本身不会独立调用 ChatCut 完成剪辑。

| 组成 | 负责的工作 |
| --- | --- |
| Codex | 联网选题、事实核查、脚本创作、素材取舍、调用 ChatCut、画面判断和修订 |
| 本地 Python 工具 | 环境检查、有限区间下载、制作状态与操作记录、字幕和音量客观诊断 |
| ChatCut Hosted 插件 | 可编辑时间线、配音及音色、动画、转场、字幕、音乐与成片导出 |
| 使用者 | 选题、首次音色确认、必要的账户授权、最终声画审阅 |

插件只制作和交付，不自行发布视频或创建定时任务。ChatCut 需要单独安装和登录；本包不包含其服务、账户、积分或代码。

## 2. 能力和默认规格

| 项目 | 当前行为 |
| --- | --- |
| 内容形态 | 单个热点深入解释，或最多三个热点组成速递 |
| 选题窗口 | 默认最近72小时，不足时扩展至7天；区分事件发生时间和上传时间 |
| 来源 | X、YouTube、机器人厂商、研究机构及科技媒体；事实尽量追溯原始来源 |
| 素材数量 | 通常2–5个视频源，最多6个；下载片段合计不超过300秒 |
| 输出 | 9:16、1080×1920、30fps、H.264 MP4；默认目标90秒，支持60–120秒 |
| 解说 | 中文、自然有活力但克制；首次确认具体音色，后续复用可用音色 |
| 画面 | 实拍 B-Roll、完整机器人动作、横屏素材竖屏编排、短时动态强调、适量转场 |
| 字幕 | 依据最终旁白词时间制作，校正专名和数字，两行以内，目标边界偏差约200ms |
| 配乐 | 在用户明确要求后加入；有唱／纯器乐选择沿用已确认偏好 |
| 修改 | 继续中断制作，局部修改旁白、字幕、镜头或混音，复验受影响部分 |
| 交付 | MP4、SRT、可编辑 ChatCut 项目链接、脚本、来源清单和验收记录 |

声音克隆由 ChatCut 提供，需要本人或已获授权的录音。插件可复用账号中实际可用的已确认音色；安装包不携带录音或音色资产。动态文字和转场通过 ChatCut 制作，包内没有独立 Remotion 工程。

v0.1的配置与验收固定为1080×1920、30fps；修改配置文件并不能自动获得横屏、4K或其他帧率的完整支持。

## 3. 安装前准备

| 依赖 | 用途与要求 |
| --- | --- |
| macOS | 首版环境；脚本使用 Unix 文件锁，未提供 Windows 支持 |
| Codex | 本地执行、插件加载及联网能力；终端安装示例要求 `codex` 命令可用 |
| ChatCut Hosted 插件 | 单独安装并登录，具备相应服务权限及所需积分 |
| Python 3.10+ | 完整标准库，包括 venv、ssl、email、urllib；可由 Codex 使用其完整捆绑运行时 |
| FFmpeg / ffprobe | 片段下载所需处理、媒体探测、完整解码及诊断；二进制不随包分发 |
| Node 或 Deno | 下载器使用的 JavaScript 运行环境，二选一 |
| yt-dlp | `bootstrap` 在独立虚拟环境安装；固定版本见 requirements-runtime.txt |

`bootstrap` 只安装 Python 下载依赖，不安装系统 Python、FFmpeg 或 Node，也不登录 ChatCut。系统依赖缺失时，让 Codex 运行配置技能并按诊断结果处理。

## 4. 安装

### 方式 A：克隆分支后安装

```sh
git clone --branch video-generation --single-branch https://github.com/PRAXEND/chapter0.git
cd chapter0
codex plugin marketplace add "$PWD"
codex plugin add robot-video-studio@robot-video-studio
```

私有仓库需要你自己的 GitHub 权限和本机 Git 认证。若 `codex` 不在 PATH，使用应用提供的 CLI 配置方式；也可让 Codex 按本仓库的 marketplace 安装，不需要把凭据写进仓库。

支持 Git marketplace 的 CLI 也可直接添加本分支：

```sh
codex plugin marketplace add PRAXEND/chapter0 --ref video-generation
codex plugin add robot-video-studio@robot-video-studio
```

Git来源及 `--ref` 语法见 [OpenAI 官方插件文档](https://developers.openai.com/plugins/build/plugins)。本项目已实测本地 marketplace 安装；远端方式还取决于本机 Git 的仓库权限。

### 方式 B：下载安装包

下载页面顶部的 ZIP 和同名 `.zip.sha256`，放在同一目录：

```sh
shasum -a 256 -c robot-video-studio-0.1.7.zip.sha256
unzip robot-video-studio-0.1.7.zip
cd robot-video-studio-0.1.7
codex plugin marketplace add "$PWD"
codex plugin add robot-video-studio@robot-video-studio
```

两种方式二选一。marketplace 根目录同时包含 `.agents/` 和 `plugins/`；不要只把 `plugins/robot-video-studio/` 注册成 marketplace。

安装后在新聊天加载 Robot Video Studio。若列表未刷新，重新打开聊天或应用；不要手工修改插件缓存。

### 首次配置

对 Codex 说：

> 使用 $setup-robot-video 检查 ChatCut 和本地依赖，提供中文男声试听，保存我选定的音色与输出目录。

Codex 会检查 ChatCut 实际连接、本地工具和已有偏好。已有可用、已确认的音色时不重复要求选择。你仍需亲自完成账户登录和试听选择。

希望先自行检查本地环境，可在仓库／解压根目录运行：

```sh
python3 plugins/robot-video-studio/scripts/studio.py bootstrap
python3 plugins/robot-video-studio/scripts/studio.py doctor
```

这里的 `python3` 必须是完整的 Python 3.10+。`local_ready: true` 只代表本地依赖可运行；`chatcut: requires_live_mcp_probe` 表示 ChatCut 还需由 Codex 调用实际工具检查，不代表连接失败。

## 5. 使用示例

**先选题：**

> 使用 $produce-robot-video，给我三个最近72小时的机器人选题。选定后制作约90秒的中文竖屏视频，使用已确认的音色，加无演唱的轻快科技感配乐。

**已有题目或素材：**

> 使用 $produce-robot-video，围绕下面的机器人演示做一期单题解读。链接是……。解释它做到了什么、依赖什么条件，还有哪些限制。目标75秒。

**继续制作：**

> 使用 $produce-robot-video，继续这期制作。运行目录是……，请先核对已有任务和导出状态。

**局部修改：**

> 把第二段解说改短，沿用相邻段落的音色和表达参数，按新的真实词时间调整相关镜头与字幕，重新导出。

> 检查31秒附近旁白停顿时的配乐回弹。确认声源后修正音量，保留画面和字幕时点，再导出复测。

换聊天继续时，请提供原运行目录或 ChatCut 项目链接；插件不会仅凭相近标题猜测修改哪个工程。

## 6. 流程与人工参与点

| 阶段 | Codex / 工具执行 | 使用者参与 |
| --- | --- | --- |
| 配置 | 检查依赖、连接和已有偏好 | 首次登录、授权、试听选音色 |
| 选题 | 给出2–3个候选，附事实、时间、来源及可用画面 | 选题；明确给定题目时跳过候选选择 |
| 素材 | 核实、下载必要片段，记录出处和许可状态 | 访问受限时，可能需提供文件或替代来源 |
| 脚本 | 写口语化解说，建立逐句事实和画面对应关系 | 可指定角度或语气，正常不需逐段批准 |
| 配音 | 按语意段生成，等待实际时长和转录，再排镜 | 首次音色确认；克隆时提供本人或已授权录音 |
| 剪辑 | 在 ChatCut 制作独立素材、音频、字幕和动画轨 | 通常无需手工拖动时间线 |
| 检查 | 客观诊断、合成画面核验、局部修复及重导出 | 确认听感和需要主观判断的候选问题 |
| 交付 | 保存 MP4、SRT、工程链接及制作记录 | 完整审看、听审；按需处理浏览器授权或下载提示 |

选题确定后，默认继续已经授权的制作与导出，不在每步重复要求批准。真实的权限、额度或素材缺口仍可能需要处理。自动化依赖正在执行任务的 Codex，不是关闭应用后仍自主运行的后台服务。

## 7. 质量检查

### 创作要求与分层审查（0.1.7）

- 持久化个人创作偏好，每期保存要求和章节/动效计划；本期覆盖偏好要记录真实理由。
- 全稿逐段口语审查并绑定最终文字；检查实际动效阶段和章节转场，标题淡入不算完成转场要求。
- 支持实拍上叠加图解的偏好：相关素材适度压暗承载动画，素材不足主动补找；严格模式对≥3秒最终合成静止保留待修订。
- 扫描长图解、核心变化停滞、小画面、慢放界面，以及既有长停顿和重复镜头；保留例外需可读取的画面证据和具体观察。
- 分开记录抽帧、运动序列、整片画面和最终混音听审。摘要、版本、审阅范围或证据不符时不能标 completed。

新增 `quality_plan`、`creative-quality-report.json` 和九项审阅方法。旧项目可继续读取，但裸 pass 不自动升级为新标准通过。[字段与操作方法](plugins/robot-video-studio/references/creative-quality.md)。脚本检查证据一致性，不能代替真实观看、听审或自动保证审美质量。

### 文件、字幕与镜头

- 完整解码、输出规格、音轨存在、SRT顺序与两行限制。
- 将最终源 ASR 按裁切区间、播放速率和帧位置投影到时间线，逐条对照字幕。
- 报告入点偏差、尾部保留、严格200ms超标及半帧量化容差，不隐藏差异。
- 检查部分字、重复源字、旁白参数漂移、原片内部短镜头残片和转场读取的额外源帧。
- 检查关键动作句的整句画面覆盖；时间覆盖不能证明画面相关，仍需查看实际合成像素。

### 自然解说与动效（0.1.6）

整稿检查套话、句间关系和动作描述时点；数据展示比较多种形式后按旁白设计变化。章节转场先查源镜头余量，必要时用独立遮罩层保护原片动作。保持已确认的克隆音色及配乐，实际听感仍需听审。

详见 [自然解说与动效](plugins/robot-video-studio/references/narration-motion.md)。

### 开场、布局与节奏（0.1.5）

- 开头尽早展示具体动作或数字，随画面保留厂商宣称等必要限定；不以长铺垫消耗前几秒。
- 每个镜头选择适合的主体放大、完整全景或同步细节窗，避免全片缩成中间窄条，也不裁掉关键动作。
- 自动定位 ≥1.5 秒内部旁白停顿、>8 秒连续主镜头和明显重复原片；这些是复核线索，不自动切掉完整动作。
- 每个保留候选要有具体像素依据；开头和布局另有证据记录。没有依据时保持待复核。
- 不用空档、重复蒙太奇或长卡片凑满90秒；重排旁白后重新检查字幕及停顿处配乐。
- 对照最终 SRT、当前 Caption Cards 和实际烧录画面，差异要留证；只有核实真实边界后才重建外置字幕。

详见 [开场、布局与节奏复核](plugins/robot-video-studio/references/editing-rhythm.md)。

### 配乐停顿检查

有 BGM 时，最终验收根据真实词时间扫描旁白内部停顿，检测短时音量回升并保存精确区间，包括同一个旁白片段内部的停顿。

默认对与配乐相交的≥200ms停顿分析：两端留40ms保护，100ms窗口、50ms步长；相对开始处基线回升≥6dB且达到−40dBFS时列为候选。短到无法容纳足够窗口的停顿会明确标注。细节见 [配乐停顿检查](plugins/robot-video-studio/references/music-pauses.md)。

确认是自动压低释放造成的不需要的回弹后，可将原先有人说话时的音乐电平改为稳定低音量，同时取消 follower，保留淡入淡出，再导出复测。案例参数不作为全片通用预设。

### 自动检查的边界

报告不能认证音色自然、发音准确、音乐好听、语义相关或素材许可。黑场、短镜头或音乐重拍可能是有意设计，不自动删除。

真实样片的完整音频听审未完成。后续宿主若不能实际理解音频，必须保留 `audio_listening=unverified` 并由使用者听审。配乐候选或证据缺失也保留待处理状态，不能手写“通过”覆盖检测结果。导出排队不等于交付完成。

## 8. 文件、配置和恢复

默认位置：

```text
~/Library/Application Support/Robot Video Studio/
├── profile.json             # 个人音色、风格及输出偏好
├── runtime/                 # 独立下载器虚拟环境
├── runtime-versions.json    # 实际安装的依赖版本
└── native-bin/              # 可选的 ffmpeg / ffprobe 目录

~/Movies/Robot Video Studio/<run-id>/
├── run.json                 # 来源、分镜、项目/素材/任务ID及审核状态
├── final.mp4                # 文件名示意，实际以该期交付为准
├── final.srt
├── qa-report.json
├── music-pause-check.json
└── editorial-check.json
```

脚本、来源清单和证据也存放在该期运行目录，具体文件名由制作记录确定。不要将这些个人文件提交到本仓库。

中断后，Codex 核对本地操作记录及 ChatCut 服务端状态。结果未知的生成、导入或导出先查询再决定后续操作，避免盲目重复付费；这不是网络请求绝对只执行一次的保证。

修改增加运行 revision 并使旧审核失效。检查绑定导出文件哈希，新版本须重新检查。`ROBOT_VIDEO_STUDIO_HOME` 可改变配置和运行时目录；`ROBOT_VIDEO_FFMPEG_DIR` 可指向含 ffmpeg、ffprobe 的目录；输出目录通过个人配置修改。

## 9. 目录与维护命令

```text
.agents/plugins/marketplace.json          # marketplace 入口
plugins/robot-video-studio/
├── plugin.json                          # portable manifest
├── .codex-plugin/plugin.json            # Codex 兼容清单
├── skills/
│   ├── setup-robot-video/                # 配置入口
│   └── produce-robot-video/              # 制作/继续/修改入口
├── scripts/
│   ├── studio.py                        # 环境、获取、状态、验收
│   ├── review_sync.py                   # 字幕/动作/短镜头诊断
│   ├── review_edit.py                   # 长停顿、长镜头、重复区间与编辑判断
│   ├── review_quality.py                # 要求/实际动效/证据与审阅范围
│   └── review_music.py                  # 停顿处音量回升诊断
├── references/                          # 采编、操作、验收与修复规范
└── requirements-runtime.txt
tests/                                   # 67项离线单元测试
tools/package.py                         # 白名单、可复现ZIP构建
dist/                                    # 当前ZIP及SHA-256
CHANGELOG.md
VALIDATION.md
```

在仓库／解压根目录运行，替换示例中的绝对路径：

```sh
python3 plugins/robot-video-studio/scripts/studio.py profile
python3 plugins/robot-video-studio/scripts/studio.py status --run '/absolute/path/to/run'
python3 plugins/robot-video-studio/scripts/studio.py audit \
  --run '/absolute/path/to/run' \
  --video '/absolute/path/to/final.mp4' \
  --subtitles '/absolute/path/to/final.srt' \
  --evidence '/absolute/path/to/final-evidence.json'
```

证据必须包含当前完整时间线、源 ASR 及真实配乐轨道；运行记录中也需保存配乐标识。只有媒体文件没有证据不能认证同步。完整接口见 [运行记录](plugins/robot-video-studio/references/operations.md)。

| 退出码 | 含义 |
| --- | --- |
| `0` | 命令成功；audit 的全部技术及必要审核已满足 |
| `2` | doctor/bootstrap 缺依赖，或 audit/诊断存在候选和待审核项；不应无限重试 |
| `1` | studio.py 输入、文件或运行错误，应按错误内容处理 |

四个 review 脚本只读诊断，不替代 ChatCut 编辑。最终剪辑、字幕、混音和主成片导出仍在 ChatCut 完成。

## 10. 更新、开发与打包

本地克隆方式：在没有未提交改动的来源目录更新分支，重新安装，再在新聊天加载：

```sh
git pull --ff-only origin video-generation
codex plugin add robot-video-studio@robot-video-studio
```

Git marketplace 方式先运行 `codex plugin marketplace upgrade robot-video-studio`，再重新安装。ZIP方式下载新版本、校验、解压，再注册新目录。已有同名 marketplace 时，用 `codex plugin marketplace list` 核对实际来源，避免更新错目录。

```sh
python3 -m unittest discover -s tests -v
python3 tools/package.py
```

67项单元测试可离线运行，不生成视频或扣除 ChatCut 积分。完整制作验证另需真实 ChatCut 会话；离线通过不等于所有远端功能通过。

构建输出 `dist/robot-video-studio-<version>.zip` 和 `.zip.sha256`。明确白名单排除凭据、配置、素材、运行记录、缓存和二进制工具，固定ZIP条目时间使重复构建可复现。

发布新版本时同步更新两个manifest、README版本及下载链接、更新记录和验证记录；重建ZIP、检查独立解压测试及校验和。0.1.7 新增要求与实际实现核对、素材叠加图解偏好和分层审阅关卡；当前版本的真实回归及未验证项见 VALIDATION.md。

## 11. 常见问题

**能在另一台 Mac 安装吗？** 可以。另行连接对方自己的 ChatCut 并配置依赖和音色；原机器的账户、音色和素材不会随包转移。

**需要额外的模型 API key 吗？** 本插件没有额外模型 API key 配置。Codex 和 ChatCut 使用各自账号能力，配音、音乐及云端渲染的权限和费用取决于实际服务和任务。

**已安装却找不到 ChatCut？** 依赖声明不等于已安装并认证。完成 ChatCut Hosted 连接，再运行配置入口验证真实工具。

**下载失败怎么办？** 来源可能下架、地区受限、需登录或下载器不支持。先找同事件替代来源，也可提供有权使用的本地文件；插件不自动提取浏览器 cookies 或绕过访问限制。

**doctor 为什么返回2？** 查看缺失或无法启动的工具；Deno缺失但Node正常可以通过。系统Python或FFmpeg损坏时使用完整运行时／可信二进制，不反复安装Python包来修补系统动态库问题。

**视频能播放，audit 为什么仍返回2？** 缺少听审、同步证据或存在配乐候选时仍为 review_pending；查看报告中的具体项。

**音乐检测通过就保证没有突起吗？** 不能。过短停顿、片头片尾、缓慢变化、停顿一开始就已完成的抬升不由本规则认证；报告保留可测范围，仍需完整听审。

**可以自动发布吗？** 当前只制作和交付，不包含发布、定时任务及全自动后台监控。

**公开素材或非商用就能直接使用吗？** 不自动等于获得再使用许可。插件保存出处及可见使用条件，未知状态保持未知；需许可时另行确认。本仓库不分发第三方原片或样片媒体。

## 12. 深入阅读

- [采编规范](plugins/robot-video-studio/references/editorial.md)：来源、时效、事实与脚本。
- [运行记录](plugins/robot-video-studio/references/operations.md)：状态、下载、恢复和验收命令。
- [剪辑节奏](plugins/robot-video-studio/references/editing-rhythm.md)：开头、版式、长停顿、重复镜头与导出复核。
- [质量标准](plugins/robot-video-studio/references/quality.md)：文件、画面、声音和内容验收。
- [修复经验](plugins/robot-video-studio/references/repairs.md)：语速、字幕停留、瞬切、动作、动画和转场。
- [配乐停顿检查](plugins/robot-video-studio/references/music-pauses.md)：证据、规则、局限与修复。
- [验证记录](VALIDATION.md)：测试范围、真实回归结果及未验证项。
