# 可选只读诊断

工具针对同步与混音问题，输出候选而非审美评分，不自动改变时间线。按真实需求调用，不强制所有题材运行。

## 同步

`review_sync.py --evidence <json> --srt <srt> --cuts <json> --output <json>`。

evidence 来自实际 ChatCut：timeline.state 含 fps/durationFrames；timeline.timeline 含 entries/totalEntries（全部页）；voice_sources 为 [{assetId,data:[{transcript:{status:"available",truncated:false,ranges:[{segments:[完整词时间]}]}}]}]；captions_text 为实际字幕读取返回文本；narration_tracks 为真实轨道 aliases/IDs。可含 semantic_anchors。保持工具原始字段，不凭空构造 ASR。

cuts JSON 为 assetId 到原始源秒数剪切点数组；缺少原片检测时不要填空数组冒充已检测。检查裁切/变速后的词时间投影、字幕差异、源窗口残留、转场读取额外帧。0.8秒等检测阈值只定位候选，是否需要修改按当前风格与真实画面判断。

## 配乐停顿

`review_music.py --video <mp4> --evidence <json> --output <json>`。

沿用上面的完整 timeline/voice_sources，明确 narration_tracks、music_tracks，不能按轨道名猜测。默认扫描与配乐相交的至少200ms停顿，两端保护40ms、窗口100ms、步长50ms；回升至少6dB且达到−40dBFS为候选。指标是检测参数，不是所有风格的音量要求。

短停顿、片头片尾、缓慢变化不由该指标认证。确认是不需要的 ducking 释放后才调整 follower/音量，再对新导出复测。保留用户要求的呼吸、静默、音乐起伏或长镜头；整片听审单独记录。


## 可选风格包：Git LFS 与素材完整性

`preflight` 默认展示 Git LFS、热点资讯与技术科普的素材状态；项目使用哪一套，就阻止该套缺失的素材进入搜索、分镜和制片。未选用的风格显示可选状态，不阻止其他题材、风格或本地素材导入。Git LFS 只用于获取/更新媒体：即使工具缺失，已经下载完整并通过哈希校验的文件仍可使用。

```sh
python3 <插件目录>/scripts/studio.py preflight --capability python --capability media --style henry-hot-news@8
python3 <插件目录>/scripts/studio.py preflight --capability python --capability media --style henry-technical-explainer@8
```

不运行包内 verify.py 或其他代码。内置检查器读取 manifest.json、resources.json 和 checksums.json，校验真实媒体及相应风格的规则、参考、试片和复现代码；区分目录/文件缺失、LFS 指针、大小/哈希变化、损坏索引和不安全路径。检查是只读操作，不自动安装、下载、导入、改写校验值或覆盖用户文件。哈希通过只证明与包索引一致，不等于已完成声画或审美验收。

风格包不会打入通用插件 ZIP。新导入会保存其源位置；已有个人风格可单独登记素材位置，不重导风格、不改默认偏好：

```sh
python3 <插件目录>/scripts/studio.py styles link-pack --file /实际源码目录/user-packs/henry-video-styles/manifest.json
```

位置保存在 Video Studio 用户状态目录的 user-packs/locations.json，插件缓存换版本仍可定位。移动仓库后重新 link-pack。临时检查可用 `preflight --pack-root /实际源码目录/user-packs`，或明确设置 VIDEO_STUDIO_PACK_ROOT；显式位置错误不会悄悄退回另一份素材。

缺少 Git LFS 时，macOS 可用 `brew install git-lfs`，或按 Git LFS 官方安装方式补齐。对缺失媒体/LFS 指针，在对应源码仓库执行前检返回的 `git -C <实际仓库> lfs install --local` 和 `git -C <实际仓库> lfs pull --include='user-packs/henry-video-styles/media/**'`，然后重新检测；这两条命令由用户/已获授权的任务执行，不属于只读前检。已损坏或修改的实体文件先备份，在干净的新 checkout 获取完整包再 link-pack；普通 pull 不保证替换本地改动。索引缺失/损坏先恢复完整包，不通过重算索引掩盖错误。
