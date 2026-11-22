# 本地媒体运行时

在 Apple Silicon Mac 上，从本目录运行准备命令。安装器通过 HTTPS 下载软件和模型，写入 `~/Library/Caches/Video Studio/standalone-media`。独立桌面包可将 `whisper-cli`、`ffmpeg` 和 `ffprobe` 随 `resources/bin` 一起分发，并设置 `VIDEO_STUDIO_RESOURCE_DIR`。源码安装在缺少转录程序时使用 Apple Command Line Tools 编译 whisper.cpp。

```sh
node scripts/prepare-media.mjs render
node scripts/prepare-media.mjs speech
node scripts/prepare-media.mjs clone
node --test test/media.test.mjs
```

- `render` 准备 MLT 和带 libass 的 FFmpeg。官方 Shotcut 26.11.15 签名磁盘映像提供命令行 `melt`。FFmpeg 9.1 的两个下载包固定 SHA-256。现有适用的二进制可直接复用。[Shotcut](https://github.com/mltframework/shotcut/releases/tag/v26.11.15) · [FFmpeg 构建](https://ffmpeg.martin-riedl.de/)
- `speech` 使用 whisper.cpp 1.9.5 和多语言 base 权重。输入在本机转换为单声道 16 kHz，输出片段以实际录音秒数计时。[whisper.cpp](https://github.com/ggml-org/whisper.cpp/tree/v1.9.5) · [权重版本](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1)
- `clone` 在独立 Python 环境中安装 MLX，校验 4 位权重和语音编码器。生成阶段使用离线模式。应用需提供已登记的授权语音、参考原文和新的配音稿。产物记录原录音哈希、模型标识和实际时长。[Qwen3-TTS](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base) · [固定的 MLX 转换](https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit/tree/0d6bb6fe33f92d47a507e23b9148940e8366ab5b)

`VIDEO_STUDIO_MEDIA_HOME` 可指定缓存目录。`VIDEO_STUDIO_FFMPEG`、`VIDEO_STUDIO_FFPROBE`、`VIDEO_STUDIO_MELT`、`VIDEO_STUDIO_WHISPER_CLI`、`VIDEO_STUDIO_WHISPER_MODEL`、`VIDEO_STUDIO_MLX_PYTHON` 和 `VIDEO_STUDIO_QWEN_MODEL` 可指向其他本机安装。`VIDEO_STUDIO_RENDER_ENGINE=ffmpeg` 选择 FFmpeg 拼接同一组已剪片段，可用于复核后备引擎。

`renderProject(project, {directory, output, window: {fromFrame, toFrame}})` 可导出工程中的任意非空帧区间，包含起始帧，截止帧不计入片段。导出的 MP4 和 SRT 都从零计时。转场和花字使用工程原时钟，音乐混音保留片段开头之前的压低状态。需要保存风格修改前后样片时，可对两个工程快照分别传入各自的区间。

## 可复现的成片检查

`scripts/media-proof.mjs` 使用 Blender Foundation 的《Big Buck Bunny》原片、macOS 合成的中文参考录音、Qwen 本地克隆及工作台自主生成的配乐。脚本读取原片，提取六个片段，并保存可编辑时间线、配音、MP4、SRT、封面与实测记录。原作署名写入时间线和工程元数据。[原片下载](https://download.blender.org/peach/bigbuckbunny_movies/) · [原作署名和许可](https://peach.blender.org/about/)

```sh
node scripts/media-proof.mjs "$HOME/Movies/Video Studio/本地样片-森林的节奏" "/path/to/big_buck_bunny_1080p_h264.mov"
```

2026-11-22 用 M1、8 GB 统一内存实测首轮生成 1920×1080、30 fps、2700 帧的 H.264/AAC 成片。六段中文克隆耗时各 14–30 秒，MLX 报告的峰值为 5.77 GiB。独立进程运行的完整渲染耗时 68.61 秒，含克隆、转录和渲染的本次总耗时为 203.38 秒。成片完整解码通过，实际预览帧可见中文标题和字幕。内存数字为 MLX 分配峰值；个人音色偏好、听感与盲评由人工记录。

## 长访谈与横竖混剪

以下命令对研究库的公开 NASA 原片做只读校验，在指定输出目录中建立独立 SQLite 资料库。首次运行请选择空目录。相同目录可继续已有检查。访谈使用当前 Codex 账号和官方 App Server，仅分享已授权的公开转录文本。横竖混剪使用本地导演、普通话系统配音与本地曲库。

```sh
node scripts/field-trials.mjs "$HOME/Movies/Video Studio/盲评工作台/research-sources" "$HOME/Library/Caches/VideoStudioBuild/field-trials"
```

2026-11-22 在 8 GB M1 上，whisper.cpp 从空工程缓存用 42.24 秒转录 Jeanette Epps 的 19 分 25.67 秒访谈，得到 204 段。Codex 用 41.87 秒选出 10 段洞穴训练原声，初剪为 52.72 秒、1318 帧。删除其中 104 帧后，成片独立转录中原句的连续三个词组合匹配率从 100% 降至 0%。点击恢复两次，时间线只增加一次。恢复版与初剪版 MP4 的 SHA-256 一致，29 个有效音频检查窗口全部匹配原片。[NASA 访谈](https://images.nasa.gov/details/iss061m2627771232_Live_Interviews_Jeanette_Epps_191004)

横版（1280×720）与竖版（720×1280）均含三段中文旁白、字幕、音乐及有关键帧的标题，每版 25 fps、332 帧。源镜头包括 NASA 的履带运输、夜间发射、海上溅落，以及由发射母片生成的 9:16 短片。横版另外验证了保留竖镜头后切回发射母片同一时刻，以保留底部亮光。竖版验证了把海面镜头调整为满屏。两种画幅的初剪和修改版均完整解码、可重新导入继续编辑。输入素材是 320×180 的研究代理文件，样片用于检查时序、声音和构图。

输出目录下的 `interview.json`、`横版.json`、`竖版.json` 保存时长、素材来源、原句恢复及修改前后的证据。各版本另存 MP4、SRT、可携带工程和 `review.json`。完整的源时码转录保存在 `interview-transcript.json`。

## 公开实拍素材

`searchSources(query,{kind})` 接受 `video`、`image` 或 `any`。混合检索先给独立录像，同时保留可用于特写的照片。NASA 视频从官方媒体清单读取，Commons 视频调用 videoinfo，Openverse 提供静态图候选。文件导入后按实际媒体流复核类型，项目保存出处页、许可、署名和实际下载版本。目录描述仍需通过原片观察确认。[NASA API](https://api.nasa.gov/) · [Commons 视频清单](https://www.mediawiki.org/wiki/Extension:TimedMediaHandler/API) · [Openverse](https://openverse.org/about)

若已有出版社或档案馆页面和媒体直链，可在工程的 `settings.sourceUrls` 提供 `{url,downloadUrl,kind,title,credit,license,licenseUrl,statement}`。其中 `url` 为出处页。视频可读取 MP4、MOV、WebM、OGV 和 MPEG，单个可下载版本上限 256 MiB。服务报告限流时应用保留 HTTP 状态及重试时间。

2026-11-23 的在线复核使用公开资料和独立缓存。检索 “Apollo 11 bootprint” 后，工作台导入 NASA 的 116.67 秒 KSC 影像。73–79 秒能看到宇航员从梯架边向右移动，52–56 秒使用了靴印照片。另一段专门记录靴印实验的官方 16 毫米影片为 81,633,284 字节；直接导入后在 12–28 秒可见人员在旗帜右侧站定、改变姿势、移动。细部靴纹可用同期静照，形成机制须回查科学出处。另一题 “Artemis Orion splash down” 导入了 122.10 秒、1280×674 的原片，80–96 秒可见伞组移动并开始塌落。[KSC 回顾片](https://images.nasa.gov/details/ksc_080504_apollo) · [Apollo 实验与使用许可](https://www.nasa.gov/wp-content/uploads/static/history/alsj/a11/video11.html) · [Orion 溅落原片](https://images.nasa.gov/details/KSC-20221211-MH-AMD01-0001-Artemis_1_Orion_Splash_Down-3312491)

工作台也可从发行者维护的影片目录发现馆藏。来源配置在 `src/publisher-catalogs.mjs`，登记公开总目录、适用主题、馆藏链接的识别方式、媒体专属授权文字和署名。默认联查 NASA 官网页面指向的 Apollo Lunar Surface Journal。总索引实时列出六次登月任务；指定任务时只查询对应集合。按紧邻链接的单条说明匹配搜索词，整页标题不能单独命中。版权例外、多种影片共用一个难以归属的说明、缺专属许可、没有可导入媒体的条目都跳过。目录当前支持“影片链接段落后跟 blockquote”和“figure 内附 figcaption 与影片链接”两种布局。最多读八个集合，每页 3 MiB，进程内缓存一小时。搜索候选只具备目录证据，导演仍需对原片取帧并关联实际可见的时间。存在节目页和具体片段锚点时保留两者。[NASA 对期刊来源的说明](https://www.nasa.gov/history/alsj-and-afj/) · [发行者总索引](https://apollojournals.org/alsj/alsj-video.html)

2026-11-23 从独立空库实测正式 `searchSources` 和 `importSource`。检索 `Apollo 11 bootprint experiment` 返回 2 条，首条为馆藏的靴印实验，实下 MPEG 81,633,284 字节、640×480、152.085 秒，SHA-256 为 `e064dde2d5283fda9c268072f2827ebbe90d8bb0f208c1c8bcfe1bd0986be531`。许可页声明视频公有领域，登记 NASA / Apollo Lunar Surface Journal / Ken Glover。12–28 秒远景可见人员活动；月壤细部仍应查验同期近照和科学出处。检索 `Apollo 15 hammer feather gravity` 返回 3 条，首条指向另一任务的 320×240 现场片，实下 MOV 783,232 字节、50.733 秒，SHA-256 为 `fd94c945f6040dd542ab346d6cc0088824ae4e0eb2e5fb3ae18a9082ef488e75`，登记 NASA / Apollo Lunar Surface Journal / Peter Dayton。[Apollo 11 条目原始时间码](https://apollojournals.org/alsj/a11/a11.mobility.html#1102525) · [Apollo 11 视频许可](https://apollojournals.org/alsj/a11/video11.html) · [Apollo 15 条目原始时间码](https://apollojournals.org/alsj/a15/a15.clsout3.html#1672206) · [Apollo 15 视频许可](https://apollojournals.org/alsj/a15/video15.html)

## 本地预置普通话试听

在工作台明确选择准备“预置音色”，或执行 `node apps/studio/scripts/prepare-media.mjs preset`。Qwen3-TTS CustomVoice 与克隆共用 Apple Silicon 的 MLX 运行时，预置模型单独准备并核对 12 个文件的 SHA-256，包括语言模型和音频编码器。全新下载约 1.69 GB，已有同版模型或克隆编码器时优先复用已验证的文件。语音在本机生成，预置流程只向进程提供文字、语言和 `dylan`；生成记录包括模型发行版本、权重指纹、输出时长与 WAV 指纹。Dylan 是模型提供的北京青年男声。[模型与许可](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice) · [实际使用的 MLX 权重](https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit/tree/08c72cad5e2fd0f41730c8bd1f28149585e46361)

`VIDEO_STUDIO_QWEN_PRESET_MODEL` 可以指定完整的相同版本模型目录；工作台在准备或试音时校验。若已有离线副本，准备时可设置 `VIDEO_STUDIO_QWEN_PRESET_SOURCE`，通过校验的文件将复制到自己的模型缓存。普通应用启动、读取能力和试音不会下载预置权重。

2026-11-23 在 8 GB M1 上用显式准备操作复制既有模型，禁用外部网络代理后再次准备，返回预置音色可用。通过正式 HTTP 的新建脚本工程、音色试听和工程素材下载接口输入“这是一段全新的科普解说。先看画面，再听声音。”实际得到 24 kHz 单声道、5.55 秒、266,444 字节的 WAV，SHA-256 为 `09a9d55465fe6e08a253df6680de22b82228fb2f5b40b0193f7d676019b136d4`。下载字节与工程素材指纹相同，来源登记了预置标识、模型版本及权重指纹。本机无提示 whisper 转写与这条原稿逐字一致。
