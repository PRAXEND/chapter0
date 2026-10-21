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
