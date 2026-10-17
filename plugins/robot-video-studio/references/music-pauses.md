# 旁白停顿处的配乐回弹

用于有 BGM 的新片及任何旁白、配乐、音量或时序修订。仅音量问题不需重新生成音乐，也不需花费生成积分。先加载 ChatCut 的基础、声音、验收与导出技能，修改参数以当前工具 schema 为准。

## 为什么整片响度合格仍会出问题

配乐处于 follower 自动压低模式时，旁白结束会释放压低量。短停顿内 BGM 可能突然变响，下一句开始又降回去；整片 LUFS、峰值和无削波不能排除这种局部回弹。不要通过删除有意义的旁白停顿或移动镜头来掩盖混音问题。

先区分自动压低释放、原音乐重拍、现场声/转场音效、片段增益跳变。检查真实轨道角色、音量、淡入淡出、旁白词时间和最终导出。检测器只定位候选，不能凭混音波形断言是哪一个声源。

## 每次导出自动检查

有配乐时，将真实 BGM 轨道别名或 ID 写入 `run.json` 的 project.music_tracks；不要把独立 SFX 轨误标成配乐。用 `studio.py record --kind project` 保存，放在最终审阅之前；这会使旧审阅失效。保留当前导出对应的完整证据：

```json
{
  "music_tracks": ["A2"],
  "narration_tracks": ["A1"],
  "timeline": {
    "state": {"fps": 30, "durationFrames": 2700},
    "timeline": {"totalEntries": 0, "tracks": [], "entries": []}
  },
  "voice_sources": []
}
```

这是字段结构示例，不是有效检查证据。`state`、`tracks`、`entries` 保存 ChatCut 最新时间线读取结果，合并所有分页；`totalEntries` 必须等于实际条目数。track 含 id/alias/muted；音频 item 含 trackId、asset.id、sourceRange（微秒）、timelineRange（帧）。`voice_sources` 使用 [同步检查](repairs.md) 中的完整源 ASR 结构：真实 startMs/endMs/text、status=available、无 truncated；先解决缺失、部分字或重复源字。旁白速率及裁切通过源窗口与时间线实际长度投影，不直接拿原始 ASR 时间当成片时间。A1/A2 只是示例，必须读取实际轨道。

```sh
"$PYTHON" "$PLUGIN/scripts/studio.py" audit --run "$RUN" --video "$RUN/final.mp4" --subtitles "$RUN/final.srt" --evidence "$RUN/final-evidence.json"
```

`audit` 自动调用 `review_music.py`，保存 `music-pause-check.json`，并纳入 `qa-report.json`。也可将 project.evidence_directory 指向包含 `live-evidence.json` 的目录，省略命令的 --evidence。证据和 MP4 必须属于同次导出；修改后重新读取证据并导出，不能用旧结果证明新片。

检查从最终词时间找出所有内部停顿，包括同一音频 item 内的停顿；仅扫描与配乐相交的 ≥200ms 停顿。两端各留 40ms 保护，使用 100ms RMS 窗、50ms 步长；相对最初两窗中位数，上升 ≥6dB 且达到 −40dBFS 的窗口列为候选。立体声按样本能量计算，避免反相声音混为单声道后抵消。阈值是定位规则，不是通用混音标准。

候选给出精确区间、峰值时间、基线、涨幅及所有窗口；status=needs_review。证据缺失、不完整或解码失败为 unverified；已记录配乐时二者都阻止 completed，不能用手写 review=pass 覆盖。报告绑定最终视频 SHA-256、证据 SHA-256 和 run revision。没有配乐时为 not_applicable。

少于三个测量窗的短停顿会逐项标为 too_short_to_measure_rise；片头片尾、停顿一开始就已完全抬升的情况、缓慢变化，以及 ASR 边界之外不由本检查认证。pass 只表示在可测窗口中没有候选，不等于整片混音通过；最终仍需听审所有短停顿、章节切换及完整成片。只有音量分析能力时保留 audio_listening=unverified。

独立诊断（只读，不改变 run 或编辑工程）：

```sh
"$PYTHON" "$PLUGIN/scripts/review_music.py" --video "$RUN/final.mp4" --evidence "$RUN/final-evidence.json" --output "$RUN/music-diagnostic.json"
```

退出 2 表示有候选或缺少证据；不要当成命令故障反复重跑。确认有意的重拍或转场声可保留并写依据，但机器候选仍保持 needs_review，不篡改报告或上调阈值来通过。

## 确认为不需要的自动压低回弹后

1. 保存当前音轨角色、clip gain、duckDepthDb、淡入淡出、素材/时间线 ID 和导出版本。先核对该 follower 是否还包含别的需自动压低的声音；混用时将 BGM 分到独立轨，避免连带修改。
2. 对持续解说下的音乐床，可改为稳定低音量：以原 clip gain 加实际生效的负 duckDepthDb 估算原先“有人说话时”的增益。通过当前 ChatCut 支持的工具把该值写到配乐片段，同时清除其 follower 角色，避免稳定增益与自动压低叠加。检查轨道总增益，值不能凭空假设；有多个片段时分别保留原本的相对音量。
3. 若当前接口支持可验证的音量包络或更长 hold/release，也可在短停顿持续压低；不臆造参数。固定低音量是本次已验证的修复路径，不能说成已实测过所有方案。
4. 保留配乐入出淡化、时长，以及旁白、字幕、画面和动作时点。修后读取实际项目状态并重新导出；用同一组最终旁白时间复测候选及全片响度/真峰值。音量修改应只改变音轨；必要时比较导出视频逐帧哈希，验证没有误动画面。
5. 实际听目标区间前后和整片。仍有候选时查来源；一轮自动修复与导出后若问题未明，报告证据和待复核项，不循环付费导出或把所有声音一起压低。字幕或时序也有修改则重新执行受影响的同步验收。

## 已验证案例（2026-10-17）

v5 的约31秒处，配乐 gain=0dB、follower 实际 duckDepthDb=−16.5dB。改为 gain=−16.5dB 并取消 follower，保留0.6秒淡入和1.8秒淡出；这是此素材的参数，不是默认预设。31.5–31.7秒单声道测量从 −16.78 降至 −31.69dBFS，修后整片 −17.0LUFS、真峰值 −2.6dBTP；2024个视频帧哈希相同，旁白及字幕时点未改。

新检测器使用立体声滑窗回归：旧版在31.13–31.81秒停顿检出约14.06dB回升，修复版此处不再触发。两版约9.9秒仍有较小候选，修复版约6.38dB，保留待复核，不能据此宣称全片配乐听审通过。两种测量的声道和窗口不同，不混用其绝对RMS值。以上均为客观测量，未代替真实听审。
