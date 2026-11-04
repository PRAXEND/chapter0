# 验收记录与执行方法
新制作的自动授权、音色前置、独立验收及用户确认修订遵循 [共用制片约定](production-policy.md)。新策略 sampled-objective-v1 允许有证据的抽帧视觉与客观音频验收，采用下文当前方法；不得将无法听审当作免检音量、峰值或字幕同步的理由。


所有新制作方案还遵循 [通用素材连续性与竖版构图](common-production.md)：独立于风格的 productionPlan、sourceUses/layout、production_plan 记录与最终 material_continuity / portrait_layout 验收。历史已确认记录可继续恢复，新生成/保存的方案采用新校验。

## 新项目的逐项方法

`production-context` 返回当前 run 的真实 `review_methods`。新策略采用下表，不把抽帧或音量分析描述为完整播放、听审。`coverage_frames=[0,总帧数]` 表示覆盖全片的采样和客观检测范围，实际采样点另见 probe manifest。

| check | method |
|---|---|
| visuals / occlusion / portrait_layout | sampled_composited_frames |
| material_continuity | sampled_source_windows |
| transitions / caption_flow / flicker | boundary_frames_and_signal_scan |
| audio_listening | objective_audio_metrics |
| av_sync | timeline_words_and_audio_metrics |
| music_fit | objective_mix_and_context |
| caption_sync | word_alignment_and_frames |
| output_details | export_and_boundary_inspection |
| facts | source_review |
| style_match | reference_comparison |

使用 `prepare-review` 产生全片证据，再由独立 Agent 实际读取全部联系表及必要的原尺寸帧，逐项判断。必须检查最终混音的全长指标，并用真实 TTS 源文件、源窗口和播放速率核对混音中的旁白位置；仅 BGM、缺少旁白文件或不确定相关性不能通过音画同步。字幕 Card、生成语音词时间、最终 SRT 与合成画面共同核对。核心风格规则不因技术检测通过而自动通过。

记录真实 reviewer、reviewer_job_id、producer_job_id、当前 probe/成片/字幕/方案哈希和实际 observed_sheets；不同制作和验收任务的旧结论不能混合拼成一次通过。发音、音色自然度、主观听感和未采样瞬时缺陷明确列为能力限制。其余内容检查、问题格式和闭环按下文执行。

历史候选采用旧方法时才读取 [历史策略](legacy-review-policy.md)。当前策略不加载历史方法。

所有视觉核心项都必查；音轨、字幕、事实、风格按真实项目适用。音画字幕必须全量核对词时间、轨道和最终文件；画面按当前策略抽帧检查。没有BGM的 music_fit 可用 result:not_applicable，仍需要真实方法、证据文件、全片范围和 not_applicable_reason；其他必需项不能这样跳过。没有口型的片子仍检查动作/解说/音乐与画面的同步关系。

单条 `record --kind review` 字段见 operations。除 facts 外 coverage_frames 必须是 [0,总帧数]；这表示实际完成的全范围检查，不是允许填写的模板值。pass 与 not_applicable 需要 evidence_files 实际文件与哈希、reviewer、observations、method。有未解决问题不能 pass。

## 边界与问题清单

在本期运行目录保存 review-boundaries.json，绑定最终 MP4 哈希、timeline/字幕版本、fps，列出实际需要检查的帧、类型、itemId/trackId、前后检查区间和观察结果。所有层的时间线边界取并集，同时补充源片内部切点、字幕和音频关键点；若拿不到原片信息就在未知范围中说明。

字幕边界同时检查相邻 Card 的重叠、短卡和空隙；尤其在多段旁白拼接处检查 1–2 帧空隙是否产生闪空。按原生帧率检查边界帧序列，静帧可以确认空白与持续帧数，感知顺滑保留能力限制；不能因工具无法修改跨片段边界就把现象自动标为 intended 或 pass。保存实际 Card id、帧范围、字幕版本与工具限制，供后续修复。

字幕文字还需逐条与最终源转录核对；有已采用的生成旁白稿时可辅助检查漏字、专名和标点，实际发音无法听辨时保留为限制，不能以 ASR 正常宣称发音无误。极短/重叠 token 可能在分页时被省略，单凭时序连续、无溢出或转录完整不能证明 Card 完整。修复后分别读回 Card、外置字幕并检查实际烧录画面。

外置 SRT 不一定沿用编辑器的自动分页。须分别比较每条文字、条数和实际起止时间；总文字相同不等于分句合理。源标点缺失时先核对稿件与句意，修正真实文本标点后刷新和重新导出，不用伪造词时间迫使分页。若源修改只涉及隐藏的弱标点，记录修改前后可见 Card 文字和帧范围是否完全一致；有任何可见/时序变化都重导视频。毫秒舍入或一帧级导出差异保留在检查记录里。

淡化转场需检查旧层消失与新层出现之间是否有短暂空底。使用交叠淡化时，记录前后层真实重叠区、淡化长度及媒体与图形的同步变化；只加新层淡入不能证明衔接连续。交叠中的短暂叠像与无意遮挡应按本期转场设计区分，需要检查完整交叠区的帧序列，不凭单张截图判断。

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

报告区分“检测未发现候选”“按当前抽帧/客观音频方法通过”“未验证”，不声称没有任何未发现的缺陷。验收固定的是覆盖面和证据方式；对于节奏、构图、声音的审美判断依本次要求和所选风格。

## 工作台紧凑报告

宿主提供 `context.reviewPacket`，包含当前导出全部联系表、客观指标、固定检查项及上一轮差异。先读这个包，不重复编写整理报告或测量同一文件的临时脚本。独立模型按输出 schema 返回 root `observedSheets` / `observedReferenceSheets`（确实查看过的完整列表）、一次性的 `issues`，每项检查返回观察、`issueIds`、`evidencePaths`，风格项保留规则结论与三段实际帧对照。宿主统一哈希、绑定和登记，原覆盖率与全部门槛不变。明确缺证据应记 unverified/fail，不能为节省时间少看联系表。

补充原片或原尺寸证据可调用 `web_bridge.py review-frames --file <请求.json>`，请求为 `{run,file,jobDirectory,frames:[实际解码帧号],native:true}`。连续帧号用于原生帧率边界序列；`native:false` 只返回带帧号联系表。程序返回哈希、准确帧号及原尺寸 PNG，写入独立任务目录；不得把生成证据误写成已经观看。

无论视觉或客观项失败，都保存完整临时交付并暂停，由用户确认具体修订或停止；仅正式交付仍要求全部验收通过。
