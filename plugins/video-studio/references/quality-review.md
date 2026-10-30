# 验收记录与执行方法

所有新制作方案还遵循 [通用素材连续性与竖版构图](common-production.md)：独立于风格的 productionPlan、sourceUses/layout、production_plan 记录与最终 material_continuity / portrait_layout 验收。历史已确认记录可继续恢复，新生成/保存的方案采用新校验。

## 逐项方法

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

所有视觉核心项都必查；音轨、字幕、事实、风格按真实项目适用。音画字幕检查不能只靠抽样。没有BGM的 music_fit 可用 result:not_applicable，仍需要真实方法、证据文件、全片范围和 not_applicable_reason；其他必需项不能这样跳过。没有口型的片子仍检查动作/解说/音乐与画面的同步关系。

单条 `record --kind review` 字段见 operations。除 facts 外 coverage_frames 必须是 [0,总帧数]；这表示实际完成的全范围检查，不是允许填写的模板值。pass 与 not_applicable 需要 evidence_files 实际文件与哈希、reviewer、observations、method。有未解决问题不能 pass。

## 边界与问题清单

在本期运行目录保存 review-boundaries.json，绑定最终 MP4 哈希、timeline/字幕版本、fps，列出实际需要检查的帧、类型、itemId/trackId、前后检查区间和观察结果。所有层的时间线边界取并集，同时补充源片内部切点、字幕和音频关键点；若拿不到原片信息就在未知范围中说明。

字幕边界同时检查相邻 Card 的重叠、短卡和空隙；尤其在多段旁白拼接处检查 1–2 帧空隙是否产生闪空。静帧能确认空白存在，正常速度连续播放才能判断感知效果；不能因工具无法修改跨片段边界就把现象自动标为 intended 或 pass。保存实际 Card id、帧范围、字幕版本与工具限制，供后续修复。

字幕文字还需逐条与最终源转录核对；有已采用的生成旁白稿时可辅助检查漏字、专名和标点，但实际发音仍须听审。极短/重叠 token 可能在分页时被省略，单凭时序连续、无溢出或转录完整不能证明 Card 完整。修复后分别读回 Card、外置字幕并检查实际烧录画面。

外置 SRT 不一定沿用编辑器的自动分页。须分别比较每条文字、条数和实际起止时间；总文字相同不等于分句合理。源标点缺失时先核对稿件与句意，修正真实文本标点后刷新和重新导出，不用伪造词时间迫使分页。若源修改只涉及隐藏的弱标点，记录修改前后可见 Card 文字和帧范围是否完全一致；有任何可见/时序变化都重导视频。毫秒舍入或一帧级导出差异保留在检查记录里。

淡化转场需检查旧层消失与新层出现之间是否有短暂空底。使用交叠淡化时，记录前后层真实重叠区、淡化长度及媒体与图形的同步变化；只加新层淡入不能证明衔接连续。交叠中的短暂叠像与无意遮挡应按本期转场设计区分，仍需上下文播放确认观感。

问题记录保存为 quality-issues.json，供 review 的 evidence_files 引用：

```json
{
  "artifact_sha256": "实际成片哈希",
  "issues": [
    {
      "id": "q1",
      "check": "occlusion",
      "severity": "major",
      "from_frame": 240,
      "to_frame": 258,
      "item_ids": ["实际ID"],
      "symptom": "具体观察到的现象",
      "cause_hypothesis": "可留空，不能把猜测写成事实",
      "evidence_files": [{"path":"实际证据路径","sha256":"实际哈希"}],
      "suggested_fix": "针对性修复",
      "status": "open"
    }
  ]
}
```

以上只是格式；不得照填示例当已发现问题。severity 为 blocker/major/minor；即使 minor 未处理也应如实列出。风格选择可能保留的现象标 intended 并记依据，不能为了通过而消音问题。修复标 resolved，另记录新成片哈希、复查区间和观察。每条 review 的 issues 数组保存对应问题摘要；open 项会使审核无法通过。

报告区分“检测未发现候选”“实际观看/听审通过”“未验证”，不声称没有任何未发现的缺陷。验收固定的是覆盖面和证据方式；对于节奏、构图、声音的审美判断依本次要求和所选风格。
