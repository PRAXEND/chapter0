# 创作要求与证据审查（0.1.7）

本检查把用户要求、制作计划、实际时间线和审阅证据连起来。它能发现遗漏、范围错误和过期证据，不能自动评判审美或证明审阅者真的看过、听过。自动通过不等于高质量保证。

## 先确定要求，再生成

读取 profile.creative，并将本期要求写入 quality_plan。通用默认是 natural 解说、semantic 动效、purposeful 转场、adaptive 布局、ask 配乐。用户已确认增强动效、章节转场或纯器乐时，分别保存 enhanced、designed、instrumental；后续自动沿用，不反复询问。可另保存 diagram_mode=footage_overlay、still_policy=no_extended_static、broll=fetch_related；通用默认分别为 contextual、review、source_first。不要把某个人的偏好写成所有安装者的默认值。music=instrumental 表示用户已要求加入纯器乐，仍需遵循其素材和付费授权。

制作前做三件事：

1. 整稿口语审查。逐段记录具体观察和保留/修改决定：这一句说了什么可见的事、是否自然承接上一句、是否有信息增量。去掉空的串场和结论包装，但不把短语黑名单当作“活人感”检测。能用动作说明的，就不先说“这条新闻的看点是”。“也要把话说清楚”这类话若仅承担提醒功能，应直接讲具体限制。示例不是强制句式。
2. 做章节/动效表。标明哪些话题边界需要设计转场、哪些保留硬切及原因；标出需要分阶段讲解的指标或原理。增强动效要改变信息状态，例如读数出现→比例建立→对比揭示，不能把反复淡入的标题算成完成要求。没有适合动画的内容时写明例外，别为数量添加无关动画。
3. 选一个关键镜头、一个图解和一个章节转场试做并看合成序列，再铺全片。研究不同动画机制的实际序列或源码，记录参考、取舍和采用机制；静态封面只能证明样式，不能证明节奏。按需读 ChatCut MG/shader 技能或 Remotion 技能。不要在只看过静态预览时声称看过动态参考。

TTS 前先完成逐段文案审查。实际语音和 ASR 就绪后，更新分镜与章节帧位置，再保存最终计划；每次改稿、调时序或更换动效后刷新计划和证据。局部调整优先，不为补记录重新付费生成。

## 实拍优先与图解叠加

尽量用相关 B-Roll 完成解释。必须画图时，优先把同一对象/过程的视频适度压暗，图解叠加其上并分阶段展开；实拍、压暗层、图解、字幕保持可编辑。压暗程度以动作和读数均可辨为准，不指定万能透明度。避免长时间独占画面的纯图、无关循环背景或用光晕运动掩饰信息停滞。

footage_overlay 要求图解声明 underlay_item_ids 和 underlay_relevance。底层必须是真实 video item，时间范围完整覆盖图解，并解释为何与当前内容相关；actual pixels 再确认没有被全屏不透明图形遮住。核心图解暂时不动、但实拍动作持续展开，仍需检查其信息价值，而不是一概判为静帧。

no_extended_static 要求每个主画面 item 提供 static_ranges：最终合成确实基本不动的绝对帧区间，检查后没有则为 []，没检查就省略并保持待审。以完整序列/连续抽帧与测量依据核实；只查源视频或容器帧率不能判断。脚本合并跨 item 的相邻区间，≥3秒保留待修订，不能用 keep 理由放行；3秒是当前复核触发值，不是故意做2.9秒静帧的目标。

broll=fetch_related 时素材不足就主动搜集同事件、同机器人或相关原理的短片。事实来源与画面用途分别记录，旧演示/其他型号必须标明，不能冒充现场。沿用最多6个视频源、片段合计300秒边界；有缺口就缩短表达或说明，不堆满90秒。

## 每期计划

`studio.py record --run "$RUN" --kind quality_plan --file /absolute/plan.json`。

```json
{
  "schema_version": 1,
  "requirements": {"narration":"natural","motion":"enhanced","transitions":"designed","layout":"adaptive","music":"instrumental","diagram_mode":"footage_overlay","still_policy":"no_extended_static","broll":"fetch_related"},
  "chapters": [
    {"id":"hook","from_frame":0,"to_frame":120,"transition":"opening"},
    {"id":"explain","from_frame":120,"to_frame":2700,"transition":"designed"}
  ],
  "motion_beats": ["b2"],
  "script_review": [
    {"beat_id":"b1","text_sha256":"最终 narration 原文 UTF-8 SHA-256","decision":"keep","observation":"实际逐段观察","reason":"保留的具体理由"}
  ]
}
```

示例只展示结构，不能原样用作审核。所有 beat 都必须有当前文本哈希及观察。章节连续覆盖整个最终时间线；只有开头是 opening，后续是 designed 或 cut。硬切需 reason，用户要求设计转场但全是硬切会列为待审。单期明确覆盖已保存偏好时填 override_reason，写下真实用户要求；不能用此字段默默降低要求。相同计划重复保存不增加 revision，计划变化会使旧审阅失效。

摘要算法：对象用 `review_quality.digest(value)`（排序键、保留中文的 JSON SHA-256），旁白用 `review_quality.text_hash(text)`，文件用 `file_hash(path)`。不同算法不可混用。

## 最终证据 creative

在原有完整 timeline、voice_sources、music_tracks、source_cuts 等证据上补 creative；visual_tracks 必须指向实际主画面轨道，不能默认 V1。证据必须对应已导出的实际状态。

```json
{
  "creative": {
    "artifact_sha256":"最终 MP4 文件哈希",
    "run_revision":42,
    "plan_sha256":"quality_plan 的对象摘要",
    "items": {
      "真实图解itemId": {
        "role":"explanation", "visible_height_fraction":0.65,
        "measurement":{"path":"geometry-and-motion.txt","sha256":"文件哈希"},
        "samples":[{"frame":300,"path":"frames/300.png","sha256":"文件哈希"}],
        "core_motion_ranges":[[310,360],[380,430]],
        "beat_ids":["b2"],
        "underlay_item_ids":["对应实拍itemId"],"underlay_relevance":"与当前说明的对象和动作的真实联系",
        "stages":[{"range":[300,370],"meaning":"出现第一项读数"},{"range":[370,450],"meaning":"建立比较关系"}]
      },
      "真实转场itemId":{"role":"transition"}
    },
    "transitions":[{
      "chapter_id":"explain","kind":"overlay","item_ids":["真实转场itemId"],
      "from_frame":110,"to_frame":130,
      "samples":[{"frame":110,"path":"frames/110.png","sha256":"文件哈希"},{"frame":120,"path":"frames/120.png","sha256":"文件哈希"},{"frame":129,"path":"frames/129.png","sha256":"文件哈希"}]
    }],
    "resolutions":{}
  }
}
```

- 主画面每个 item 都要记录 role=footage/interface/explanation、可见主体区高度比例、测量依据和已查看的导出帧。高度是主视频/界面占画布高度的比例，不是人物检测。保留全景可以合理，不能通过拉伸来消除提示。measurement 文件记录实际 item transform/合成帧或 MG 源码版本与测量方法。
- core_motion_ranges 是最终时间线上的核心信息变化区间，不能将背景呼吸、光晕和标题入场当作核心运动；以实际代码、合成序列核实。脚本核对区间合法性并统计，**不会自动从像素识别运动**。没有测量就不填写估计值。
- 图解 stages 至少两个非重叠阶段，说明信息变化，并与所标 beat 的真实发声区间相交。必须查看进入、中段、离场样本；一个静态卡加淡入不构成解释过程。阶段时序合格仍需语义审阅。
- native 转场需绑定真实 transition entry；overlay 必须是真实 MG item、角色为 transition，且时间范围跨过章节切点。普通标题不能充数。某宿主读回形状缺少必要范围时保留未验证，按实际 API 完善适配，不能编造条目。
- designed 的 samples 要覆盖转场前段/中段/后段，图解也同样要求；三个相邻帧不能代表全过程。cut 的 samples 在切点前后半秒内，附 observation 解释衔接。还需动态 sequence_playback；帧样本不替代运动检查。
- 所有 samples 帧号是 30fps 最终 MP4 的实际帧。文件相对路径以 evidence JSON 所在目录解析；review.evidence_files 相对路径以 run 目录解析。路径和哈希必须可读且一致。不把其他版本的图冒充本版，measurement 中保留提取命令与成片哈希。

完整 audit 在最终 MP4 解码时自动执行 FFmpeg freezedetect（-50dB、至少3秒），保存 freeze_detection；严格模式的命中保持待修订，手填空 static_ranges 不能覆盖。它是全帧变化检测，字幕变化、局部噪声或运动背景可能掩盖主体不动，因此必须同时看核心运动与实际序列。检测器不具备动作语义理解。

## 候选如何处理

自动列出：核心变化停止超过片段一半且累计≥3秒；连续图解>12秒；主画面高度<40%且持续≥3秒；界面<0.75倍慢放；要求设计转场却未完成；原有长停顿、长镜头和重复源区间。阈值用于定位复核，不是镜头时长配额或审美评分。

优先改进具体问题：长卡片换回有关实拍；界面放大关键操作而非仅慢放；回看提供新观察点；转场配合动作方向/语义转换而非每刀一个花样。关键动作不应被强行切碎。

修复后读回新时间线、重新导出并测量，候选消失即可。确实需要保留时在 creative.resolutions 用报告中的候选 id 填 `decision:"keep"`、具体 observation、reason、evidence_files（path/sha256）和该范围内的 samples。原有只含理由和帧号的 editorial_review 不足以通过新关卡。缺少工具能力则标待审，不能以例外为自己背书。证据门槛不能防止审阅者编造内容，仍必须如实记录。

## 九项独立审阅

| check | method | 必须实际完成 |
| --- | --- | --- |
| facts | source_review | 每项关键论断对照来源 |
| script_naturalness | script_readthrough | 全稿及每段上下文口语审查 |
| visual_samples | frame_inspection | 实际合成抽帧；只能声明采样范围 |
| motion_review | sequence_playback | 所有图解与设计转场的完整运动序列 |
| composed_visuals | continuous_playback | 整片连续画面回看，可分段但须无缺口 |
| audio_listening | full_mix_listening | 整片最终混音真实听审 |
| caption_sync | word_alignment_and_frames | 逐条 ASR 对齐及烧录字幕检查 |
| semantic_sync | anchor_sequence_playback | 关键动作句与画面序列同步 |
| editorial_rhythm | continuous_playback | 整片节奏、开头、布局与重复镜头判断 |

pass 除原来的 artifact_sha256/evidence 外，还需 method、reviewer、observations、evidence_files、plan_sha256 和 evidence_sha256（整个最终证据对象摘要）。composed_visuals/audio_listening/editorial_rhythm 的 coverage_frames 必须无缺口覆盖成片；motion_review 要覆盖所有图解和设计转场。script_naturalness 另需 script_sha256，即 `{beat_id: text_hash(narration)}` 的对象摘要；caption_sync 另需 subtitle_sha256。reviewer 写实际审阅者及可用能力，不能填写不存在的人工审批。

只有真正听过才能写 full_mix_listening。工具当前只提供画面或统计时，保留 audio_listening=unverified。证据注明 continuous_playback_review=false 或 audio_listening=unverified 时，与之矛盾的 pass 会被拒绝认证。文件/计划/证据改变后旧审查失效；不要直接编辑 run 的 pass 字段。

`audit --evidence` 自动写 creative-quality-report.json 和 qa-report.json，列出具体 pending 与 review_details。旧 run 可继续读取，但要补计划和证据，历史裸 pass 不自动迁移为新标准通过。只完成技术检查时允许交付审稿版，不能标 completed 或声称已完整看过、听过。
