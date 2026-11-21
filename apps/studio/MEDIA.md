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

## 可复现的成片检查

`scripts/media-proof.mjs` 使用 Blender Foundation 的《Big Buck Bunny》原片、macOS 合成的中文参考录音、Qwen 本地克隆及工作台自主生成的配乐。脚本读取原片，提取六个片段，并保存可编辑时间线、配音、MP4、SRT、封面与实测记录。原作署名写入时间线和工程元数据。[原片下载](https://download.blender.org/peach/bigbuckbunny_movies/) · [原作署名和许可](https://peach.blender.org/about/)

```sh
node scripts/media-proof.mjs "$HOME/Movies/Video Studio/本地样片-森林的节奏" "/path/to/big_buck_bunny_1080p_h264.mov"
```

2026-11-22 用 M1、8 GB 统一内存实测首轮生成 1920×1080、30 fps、2700 帧的 H.264/AAC 成片。六段中文克隆耗时各 14–30 秒，MLX 报告的峰值为 5.77 GiB。独立进程运行的完整渲染耗时 68.61 秒，含克隆、转录和渲染的本次总耗时为 203.38 秒。成片完整解码通过，实际预览帧可见中文标题和字幕。内存数字为 MLX 分配峰值；个人音色偏好、听感与盲评由人工记录。
