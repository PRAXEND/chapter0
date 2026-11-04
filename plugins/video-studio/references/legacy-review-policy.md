# 历史验收策略（仅旧候选恢复）

仅当 production-context.review_policy 不是 sampled-objective-v1 时读取。它用于准确解释旧记录，不能作为新制作的任务要求；无法完成原方法就保持未验证，不追认通过。

## 历史项目的逐项方法

下面的连续播放/听审策略仅适用于未采用 `sampled-objective-v1` 的已有项目。没有实际完成该方法就保留 unverified，不能改方法名称来追认通过。

| check | method | 覆盖范围 |
|---|---|---|
| visuals | continuous_playback | 整片原速观看 |
| av_sync | timeline_alignment_and_playback | 有声音时全片音画同步，所有声画锚点 |
| occlusion | composited_sequence_inspection | 所有合成层与运动重叠区 |
| audio_listening | full_mix_listening | 有音轨时完整混音 |
| music_fit | full_mix_and_context_review | 有音轨时检查BGM；确实无BGM可有证据地不适用 |
| transitions | boundary_sequence_playback | 全部剪切、转场、变速及源片内部切点 |
| caption_sync | word_alignment_and_frames | 字幕与真实语音/歌词时间对齐 |
| caption_flow | caption_boundary_sequence_playback | 每条字幕进出、换句及换行 |
| flicker | frame_scan_and_sequence_playback | 整片逐帧扫描加连续播放核实 |
| output_details | export_and_boundary_inspection | 输出规格、清晰度、文本、画面与声音首尾 |
| facts | source_review | 事实主张与来源 |
| style_match | reference_comparison | 选定风格全部规则 |

