# 共用自动制片与独立验收约定

工作台和聊天共用本文件、实际 run 风格快照和 `web_bridge.py production-context --file <包含 run 的 JSON>` 返回的上下文。不要把独立工作台会话降为简化提示；模型及推理配置沿实际用户配置，保存真实值，不自行换模型。

## 五项输入与授权

新制作默认自动模式，收齐主题方向、时长范围（可设下限）、横/竖版、指定风格和具体音色后持续完成。用户明确要求审稿/逐步制作时采用手动模式；仅分析、打开工作台、浏览风格不启动制片。已有五项输入直接采用，只补缺项。风格必须读取固定版本的 SKILL.md、精简 style.guide 中的全部规则、相关复现配方和代表参考；原 style.json 的组件源码按需读取；不自动替换风格。无旁白的明确要求免除音色输入。

自动模式将用户制作请求原话/实际一键点击、五项输入和时间保存为本期授权。复用旧工作台项目开始新制作时，显式同步本期 review_policy 与已选 voice 到 run；旧成片及验收结论不追认。AI 自主选题、选材，并对每份实际文案分镜完成审阅后，按 delegated_review 保存版本/内容和输入哈希；不把其记成用户审过具体方案。手动模式保留原来的选材和方案确认。权限审查、登录及音色克隆授权仍按实际要求处理。

工作台配置阶段只做本地操作，不启动 Codex：提供官方、已有克隆、新建克隆；已保存的具体音色直接选用，录音和明确授权先保存本机。只有点击一键生成后才调用后台 Codex 查询账号目录、检查创建资格或执行克隆；录音在资格通过后才上传。音色在正式制作前解决，查询失败不是没有音色。名称/10–180 秒录音/试听文本和授权完整后，自动克隆、查询到就绪、提供试听并保存稳定身份供以后复用，不额外要求确认试听。保留源录音和操作 ID，续做先查询。用户选择具体官方/克隆音色即保存复用；不保存易失 voiceRef。共用 `save-voice` adapter，输入真实 provider/voiceId/name/voiceType/selected_by_user。

自动链路：准备音色 → 同一主制片会话内选材、写稿、设计与剪辑 → 实际导出候选 → 独立验收 → 必要的一轮局部修复与复验 → 交付。按 [连续制作](continuous-production.md) 执行。自动模式取消候选数量目标、强制补搜轮数和独立的文案/分镜/审稿会话；事实核实、当前方案检查点、实际声画与风格验收保留。各项记录随制作产生，不为记录另起模型会话。

## 制作质量与证据

所有核心风格规则映射到具体镜头设计，包含用途、触发、入场/变化/退出、时长、主体避让、声音和替代；先用真实素材验证复杂节点再扩展。不能把风格统一简化成标题入场。按实测音频和词时间排镜，保持来源独立资产及可编辑轨道。读取完整时间线全部页。

新项目在 brief.requirements 保存 `review_policy: sampled-objective-v1`。导出后把真实时间线、voice_sources、captions_text、narration_tracks、music_tracks、semantic_anchors 和 voice_files:[{assetId,path,sha256}]（下载到 run 的实际 TTS 源音频） 保存为 run/review-evidence.json；schema 遵循 [diagnostics.md](diagnostics.md) 的 review_sync/review_music；源片内部剪点保存为 source-cuts.json。必须是真实词时间、实际源窗口、完整分页、实际静音状态。登记每个 beat 的真实范围、source_uses/layout_result/design_results。

制作 Agent 的候选文件、自评和工具成功不构成交付许可。候选包含实际 MP4、字幕启用时的 SRT、两张封面与发布文案；封面可用本期画面设计，事实及标题与最终成片一致。所有文件放在 run 中供验收，未通过不复制到最终交付目录。

## 独立验收执行

工作台由宿主启动独立 review 会话；聊天必须使用专职验收子 Agent，传入实际 run、候选文件、上下文、固定风格、参考、诊断证据和本文件。验收 Agent 仅检查，不编辑生产工程、不调用生成/导出工具。宿主/主 Agent 记录真实 reviewer ID 和制作任务身份；不能让制作 Agent 伪造另一个 reviewer 字符串。聊天缺少子 Agent 能力时保留候选并说明阻塞，不能自评放行。

先调用 `web_bridge.py prepare-review`，payload 为 run、file、可选 subtitles 和 run 内独立 directory。它全片解码、每秒 2 帧抽样、事件边界加密、动效段 8fps，输出 manifest/metrics/联系表及证据哈希。读取全部联系表，记录实际 observed_sheets；重点文字用原尺寸帧复核，高风险边界按原生帧率检查局部序列。复核源窗口、重复动作、遮挡、竖版安全区和风格参考。提供 referenceProbe 时必须查看真实试片联系表，分别对照成片开头、中段、收束，记录实际帧号及主体大小、文字层级、动作连贯和动效表达的差异。参考和成片画幅不同时比较表达效果，不照抄坐标；不能因规则字段齐全就放行明显退化的画面。联系表不能辨认时必须追加高分辨率证据。

不能连续播放和实际听审是允许的能力限制。新策略允许有证据的抽帧/客观音频通过，不得伪称完整观看或听审。保留发音、音色自然度、音乐主观适配和未采样瞬时缺陷的局限。必须覆盖全片音量、短窗 RMS 包络、峰值/真峰值、静音、声道和拼接；异常需复核，静音或削波等 hard_failures 不能用说明覆盖。逐条对齐生成语音实测词时间、时间线、Cards 和最终 SRT，并结合最终混音检测；原始音频的 ASR 不能证明导出有声。

逐项输出 pass/fail/unverified 及证据路径/哈希、时间码、问题和修复建议；style_match 包含每条固定风格规则，核心规则全部有实际实现观察，不能用总分或特效数替代。宿主绑定当前文件哈希、revision、style_plan/production_plan 和真实独立任务；每项引用当前 probe_sha256，视觉项记录实际观测联系表全集。旧文件证据不适用于新导出。无法完成必须的客观检查记 unverified。

通过 `record-review` 保存逐项结果，再执行 `review-audit`。`completed=true` 才能正式交付；技术解码成功不充分。验收失败即暂停：保留实际 MP4、启用时的 SRT、3:4 和 4:3 PNG 封面、发布文案 TXT、工程/方案、来源、问题报告和 ZIP 临时包，明确标注尚未通过验收。用户可查看下载、确认预填的具体修订建议或停止保留文件；确认修订后才启动下一轮，沿用原工程和未受影响资产。旧批准只对原文件有效，新方案通过宿主检查点重新绑定；未通过的临时文件不得登记成正式合格交付。已有旧周期的返工计数与报告保留，不因重启清除。

## 交付

两端采用 [video-delivery-tools](../skills/video-delivery-tools/SKILL.md) 默认包：完整 MP4、3:4 与 4:3 PNG 封面、UTF-8 发布文案 TXT；启用字幕附实际 SRT。验证四项实际文件及字幕，记录报告和限制。按本地首次交付日期建立 `YYYY-MM-DD_选题`，同名加后缀。未通过验收的候选只作为诊断文件，不在成片页展示为完成。完成不包含发布或定时任务。

## 新项目的声音与字幕

新工作台项目从 brief 读取 generate_music、requirements.captions 和具体音色。本期选择优先于任何风格包、参考片、旧操作或全局偏好。默认生成本期纯音乐，只有明确选择不生成才省略；保留素材原声也需要独立配乐。完成时在本项目 operations 登记 status=completed、input.arguments.generationType=instrumental 和 result 的 projectId、timelineId、jobId、assetId。记录真实音乐任务及生成资产，续做核对后复用。新生成的旁白必须通过工作台派发的 narrationEndpoint 提交。将最终采用的每个旁白资产的真实 inspect_asset 返回的 asset.generation 与 generationRecord.params（voiceId 在 params，provider 可能在 generation 标头）与转录一起放入 review-evidence.json 的 voice_sources。修订与复用也需逐段匹配。手动选择音色时可使用本期确认的回答。

若同一候选 MP4 已导出但音频证据仍需用户操作，在 needs_input 的 files 中列出真实视频、字幕、两张封面及文案，返回本次 projectId/timelineId。工作台先保留临时交付，补齐证据后继续验收同一候选。原件取回优先使用已登录的同一浏览器，在当前工程媒体池对本期音乐、旁白选择「更多操作 → 导出源文件」。核对素材名称、ID 与下载文件，复用已取得的音频，不重复生成。导出前，将完整时间线、旁白与配乐轨记录到 run/review-evidence.json。music_files 每项包含实际生成资产的 assetId、generationTaskId、下载到 run 内的 path 和 sha256。字幕开启时启用全局 CC，绑定实际发声轨。分页读回所有当前原生字幕卡及有效可见性；evidence.timeline_id 写本次时间线 ID，caption_state 记录 {timelineId,enabled,tracks:[{id,visible}],cards:[{id,trackId,hidden,start_frame,end_frame,lines:[文字]}]}。由实时返回归一化，保留原始读回，不得推测缺失状态。把完整未筛选的原始 read_captions 返回（单页对象或按顺序的全部分页数组）保存到 run/caption-readback.json。在 ChatCut SRT 为空时直接使用 web_bridge.py recover-subtitles --file <含 run 的 JSON> 返回的同期 SRT，不要重复付费生成或重排字幕。导出 SRT 后用 web_bridge.py check-media-requirements --file <含 run、subtitles 的 JSON> 检查；手动模式中若选声发生在批准后，附 selectedVoice（当前选择）。开头、中段、末尾各选一条实际字幕，在对应中点查看编辑器合成帧，确认文字可见后才导出完整 MP4。独立验收使用成片的相同抽帧，在 caption_flow.captionObservations 中逐帧写 {frame,text}，其余检查填空数组。没有看到的字不得照抄 SRT。
