# 工作台失败恢复与交付链路加固

发行归属更新（2026-11-16）：累计修复纳入 web.39；发行验证与升级见 [VALIDATION](../../VALIDATION.md) 和 [UPGRADE](../../UPGRADE.md)，固定标签 `v0.3.0-web.39`。以下记录保留各阶段当时的状态，不以历史“未发布”描述覆盖本次发行归属。

状态：实现、回归、同伴复核及本机安装通过；未提交、未合并、未发布，未代替客户视频验收。负责人：主 Agent。日期：2026-11-15。

## 目标与基线

用户在音色目录兼容和候选记录误报连续阻塞后，要求系统排查其他潜在问题并改善恢复体验。沿用 codex/web38-voice-compat 工作树，保留前两任务全部未提交工作；发布基线 c057229。真实项目已恢复候选登记，目前空闲、等待独立验收。本轮不派发该项目的制作或模型验收，不生成媒体、不改方案/音色/成品。

补充验收要求：尽量一键完成，可恢复的临时技术故障先由工作台自动恢复，不能把点击“继续”、重建会话或重新制作作为正常流程。用户主动停止、真正需要授权/内容决策、永久环境故障，以及既有“独立验收不通过即暂停”仍保留；不通过自动重投付费制作来掩盖技术错误。

检查范围为准备→制作结果登记→独立验收→临时/正式交付→中断重启与项目切换。采用真实函数状态故障注入、文件系统验证、HTTP 协议替身和同伴独立只读复核；不把测试当成客户视频质量验收。

## 已确认问题与修复

1. 临时 ZIP 保存失败时，补证候选尚未落盘，或失败验收尚未设置 terminal，普通继续会误走制作/重复验收。改为先持久保存候选、pendingExport、质量失败状态，再尝试打包；保存异常单独记录，提供只做本地文件工作的重试按钮。
2. 手动模式已有通过报告、仅交付复制失败时，会重新启动验收 Agent。与自动模式共用 resumeDelivery，重新核对真实文件、报告、批准和工程后直接保存交付，不新增模型任务。
3. finishJob 在最终写入前释放 active，项目切换可能将旧 followup 派给新项目。保持所有者锁直到收尾持久化完成，异步接续明确绑定原 projectId，错误处理也不能写到其他项目。
4. 用户直接继续时，入队前错误仅出现在一次 HTTP 响应中，刷新后为空。技术错误按 project/request/input/plan/automatic/producer/video hash 保存，刷新和重启可见，成功开始或恢复时清除；不作为创意修改建议。
5. 最终状态写入失败可能留下 active=null/automatic=running，页面一直显示执行中。失败时在内存保留候选并切 blocked，尽力保存具体原因，禁止继续派发，始终释放运行所有者；无法持久写入时不声称磁盘已保存。
6. 多个合法 qa 附件映射到同一交付文件名，验收通过后仍永远复制失败。保留实际扩展名并为后续报告编号，验证复制后 SHA。
7. 独立逐项检查已登记、仅最终报告保存中断时，恢复入口原来只接受已登记失败项，已通过结果反而再启动验收。改为重新运行真实 review-audit，核对当前媒体/字幕、方案/输入、工程、revision、全部 probe 证据及原独立 job/thread 后才复用；仍经过交付包检查和正式交付守卫。
8. 新任务保留旧 qualityCycle 时，临时交付重试和错误作用域可能取到旧候选。currentCandidate 统一要求当前批准、方案、输入和非 stale 状态，否则选择有效 pendingEvidence；重试不借用旧验收报告。
9. 入队写入失败或写入期间取消时，原流程可能留下 controller=null 的 active，或取消后仍派发模型。包住发布但尚未派发阶段；写入完成后再次校验取消，失败/取消设置终态并释放本任务所有者，同步 runner 抛错也不重投。最终收尾写入和已排队接续也携带 cancelGeneration，手动模式在这两个窗口停止后不会再派发验收。
10. 新要求的自动恢复：沿用 server 内部小型 retryLocal，无新模块/依赖；只读运行环境预检、派发前持久化、候选/验收关键持久化、本地临时/正式交付对明确暂时性错误最多尝试三次（含首次，退避 300/900ms）。每次检查原 projectId/cancelGeneration，候选操作还检查当前绑定；权限/容量/哈希/批准/未知错误不盲试。runner 和付费工具永远不在重试包装内，deliver 成功后的持久化不重新复制或再验收。耗尽显示自动恢复次数和具体原因。临时交付失败仍不阻断可继续的验收路径。

沿用现有 server/revisions/交付入口，无新框架或运行依赖；增加小型、按当前工程作用域保存的 workflowErrors，旧记录无此字段时行为兼容。临时交付失败不会解除质量暂停或启动重制，创意修订仍须先保留候选。成品/快照 hash、原批准、独立身份和验收标准不降低。

## 验证与接手

同伴 voice_compat_review 独立复现前 4 项并异步复核。新增 recovery-boundaries 纯 VM 测试覆盖持久化顺序、打包失败、跨项目接续、准备错误、手动仅交付、最终写入失败和清除错误；使用真实函数，仅替换外部/磁盘故障。自动 HTTP 集成扩为 10 个情景，含手动交付失败重启（任务数不增加）、篡改候选导致准备失败/重启仍显示原因、恢复原件后补证续作。

增加自动恢复的预算、永久错误、退避期间取消/项目变化、runner 同步抛错只派发一次、交付成功后持久化失败不复制第二次等测试。87 项目标回归通过；第一阶段同伴独立复核 66/66 通过。新增自动恢复与最后取消边界完成后，同伴独立再跑恢复边界、automatic/revisions/delivery 共 51/51 通过并确认方案与交付；两组有重叠，不累加宣称覆盖量。

最终全量 **237/237 通过，无跳过**，包括真实本地 HTTP 链路的十种制作/暂停/重启/交付恢复场景；`git diff --check` 通过。完整日志位于本机忽略目录 `validation/recovery-final-verified.log`。

失败尝试：早期 VM 测试缺少新增只读 helper 依赖、跨 realm 数组断言，以及 plan-repair fixture 缺少 retryLocal/cancelGeneration，均修正测试搭建，未放宽业务断言。一次全量 228 通过/1 失败来自既有 desktop mutex 测试的临时目录清理 ENOTEMPTY（行为断言未报错）；该文件独立及最终全量通过，未修改其测试或生产实现。

复现命令（仓库根目录）：

```sh
export PATH="$HOME/Library/Application Support/Video Studio/runtime/bin:$HOME/Library/Application Support/Video Studio/native-bin:$PATH"
export VIDEO_STUDIO_PYTHON="$HOME/Library/Application Support/Video Studio/runtime/bin/python3"
export VIDEO_STUDIO_FFMPEG_DIR="$HOME/Library/Application Support/Video Studio/native-bin"
node --test plugins/video-studio/workbench/test/*.test.mjs
git diff --check
```

HTTP 测试全部使用临时用户目录、合成媒体及 CLI/ChatCut 协议替身，不向实际服务提交配音、音乐或剪辑；仅检验工作台状态、文件与调用边界，不能代替真实视频的独立声画验收。真实本期候选 9 个文件已用新 currentCandidate + verifyCandidate 只读核对通过，报告仍未登记，没有启动任何真实制作或验收任务。

## 本机交付与下一步

已备份并同步本机 `~/.codex/plugins/cache/video-studio/video-studio/0.3.0-web.38` 的 6 个 runtime 文件：evidence-resume、revisions、quality、studio-server、public/app、public/revision-ui。既有 narration 音色修复仍与源码一致。只停止已确认空闲且命令路径匹配的工作台 PID，再通过发布工作树的既有 tools/run_workbench.py 启动；http://127.0.0.1:4317 健康检查通过，busy=false、activeJobId=null。页面脚本 HTTP 返回内容与安装文件逐字节一致，no-store 生效，浏览器刷新后加载新前端。

安装核验：本期工作目录 **219 个文件全部字节相同**，包括原视频、字幕、封面、文案和候选附件；任务 ID、方案、批准、工程和音色未变。状态差异仅项目 updatedAt 与素材库五条本期已有候选的 lastSeenAt（既有启动刷新行为），已对照原来源核实。没有新增制作/模型验收任务或付费调用。

本机回执 `validation/recovery-hardening-install.json`；备份 `validation/recovery-hardening-backup`，两者均在忽略目录，未提交客户数据。一次性安装脚本的 Python 环境键拼写错误在文件复制后中断了启动，随后已修正并使用同一既有 launcher 启动成功；只读验证脚本重新完成代码、状态、媒体和静态资源核验，没有重新修改项目或候选。

后续如需向客户分发，须将当前累计修复审阅后提交、按发布流程合并并重建安装包；本次仅本机热修复，公开 web.38 与远端仓库未变。真正外部服务不可用、权限/容量问题、原始成片或授权被改变仍可能阻塞；不能宣称零故障，也不通过重复付费提交或跳过质量验收兜底。

## 追加排查：验收失败后只补证并复用原导出（2026-11-15）

用户请求查看当前工作台报错原因。本节仅记录只读诊断，以下新缺口尚未修复，不能以此前 237 项通过宣称已覆盖。

实际链路：21:08 的客观预检拒绝 speech_activity（speech_interval_silent_in_mix）与 narration_alignment（缺完整旁白/混音对齐证据），未启动独立模型裁定。用户确认反馈后走通用修订入口，原候选移入 revisionHistory，批准重新登记到 v2；新 create 任务只补音频/字幕证据，返回 status=exported、qaStatus=failed，并明确复用原视频、未重新导出。当前任务的工程 ID、时间线和制作会话都存在，但本任务 toolCalls 无 submit_export/track_export；真实导出调用仍在原制作任务中。

直接阻断点为 workbench/quality.mjs:15：bindCandidate 无条件要求“当前 job”有导出调用。该轮没有 pendingExport，不能进入既有补证恢复分支；即使之前保存了原候选，也没有将历史导出来源作为严格核验后的复用结果登记。已用安装版 bindCandidate 对实际 result 做守卫前置复现，准确得到同一错误且未进入任何文件写入。当前 activeJobId=null、busy=false，因此并非会话锁。手机通道有零星流取消日志，但不是这次宿主登记错误的触发源。

原 MP4、SRT、两张封面和发布文案五个文件均存在，SHA 与历史候选一致。补充证据中 Agent 主张波形匹配完整；本轮没有独立裁定其足以推翻原客观失败，不标记通过。意见栏无新增建议是因为登记已失败，新 qualityCycle 尚未建立，尚未进入本轮验收。

后续修复边界：增加已验证历史导出的显式复用路径，核验原真实导出调用、工程/时间线、交付哈希及当前批准的适用性，再携补充证据进入独立复核；不得伪造导出调用、简单删除防伪守卫、强制重复渲染，或直接把旧质量失败改成通过。补“质量失败→确认补证→原文件不变→无需新导出”的集成回归。此次未更改代码、项目状态、音色或成片，未启动制作/模型验收。


## 追加修复：补证登记与音频检测（2026-11-15）

用户随后要求修复并排查潜在问题，本节替代上节“尚未修复”的当前状态，保留上节诊断历史。仍为 c057229 上未提交的本地修复，不改发布版本，也不把软件回归当作视频质量通过。

- 当前结果先保存不可替换的结果/恢复上下文与成品字节快照。登记失败后，继续优先恢复同一结果；核对 request/input/plan/job/thread/run、结果及成品 SHA，不再次派发制作或重新获取音色。登记成功之后才完成检查点；本地恢复的后续验收在 HTTP 修改锁释放后排队，保留原项目及取消代次检查。界面说明这是待登记结果，无需填写创意意见。
- 历史复用只找当前用户 revision 对应的历史候选，核验原真实 ChatCut 导出、工程/时间线、全部成品哈希、原输入及当前方案。制作说明默认参与方案比较；本次仅允许宿主和同伴逐字确认的诊断 note 例外，绑定 revisionId、两个方案哈希和完整前后 notes，其他字段不得改变。候选保留原导出者和 exportOrigin，补证者单独登记，独立验收排除两者。跨方案候选继续补证也用原 exportOrigin 验证来源。
- 制作方遗留疑点移入送审包，不再直接当作宿主客观失败。独立验收必须逐项返回 resolved/unresolved、观察与实际证据，登记和交付恢复再次核查；任何客观硬失败仍阻断，旧失败报告保留。
- 音频相关性不再只精查三个包络峰，而完整扫描原 ±300ms 的每个采样偏移；相关性 .55、竞争峰差 .015、40ms 歧义间距以及 80ms+一帧容差不变。真实 ASR 区间的源静音以源文件哈希、实际源窗口/速率及 20ms 子窗最大 RMS 证明；源有声且混音无声仍报掉音，源文件不明仍未验证。不能用整词平均值稀释短促语音。
- 更新发布文件白名单以包含新增任务说明及回归测试；不生成或上传发行包。

同伴 voice_compat_review 独立复现并要求修复四个实现边界：跨方案补证失去来源、登记期间媒体替换、短声被整词均值稀释、HTTP 锁内接续丢失。四项均修正后，独立 53 项 Node/9 项音频 Python 通过，再次 28 项登记与恢复子集通过，确认方案与交付。主 Agent 的 12 个真实本地 HTTP 场景通过，覆盖登记失败→重启→并发继续→只登记并审片、质量失败→同方案补证且无新 export 调用→独立验收、以及原十个恢复场景。模型/ChatCut 使用显式协议替身，不提交真实付费制作。

主 Agent 全量 Python **277/277** 通过。首次全量发现包白名单未包含此前三份新增任务文档，已补齐并重新全量通过。早期 VM fixture 缺新增依赖、同一无 revision 补证路径的 null.id、HTTP 重复请求应为 409 的断言，以及局部恢复锁测试初始化问题均记录并修正；没有放宽质量阈值。首次高并发 Node 全量中 voice API 的短轮询超时，后续全量采用 test-concurrency=4；最终结果见下节。

真实项目只读复算：83 个窗口全部在原容差内匹配，原被报静音的 ASR 词区间在源文件本身也是静音；这证明该两项宿主误报已定位，不证明最终视频通过全部视觉/风格验收。原 MP4、SRT、两张封面与文案尚未改动。证据仅保存在忽略的 validation 目录，不把客户素材或原始日志加入版本库。

复现新增检查：`node --test --test-concurrency=4 plugins/video-studio/workbench/test/*.test.mjs`；沿用上述 Python/native 环境后运行 `python3 -m unittest discover -s tests -v`。同伴复现与主测试日志分别留存，重叠测试不累加为覆盖量。


### 最终回归与本机恢复

最终 Node **244/244** 通过（含上述 12 场景 HTTP 集成，约 156 秒），Python **277/277** 通过，均无跳过；`git diff --check` 通过。最终日志为 `validation/registration-final-node.log` 和 `validation/registration-final-python.log`。所有先前累计修复保留，未提交/合并/发布。

已确认工作台空闲，备份状态、受影响代码与工程记录后更新本机 web.38 缓存，再用原 launcher 启动。原工程 **290 个已有文件逐字节未变**，其他项目及 profile/voice 文件不变。旧失败任务通过原桌面 ticket/ack/result 的 job/request/thread 一致性、终态 code=0 和原输出 schema 校验，建立本机恢复检查点；精确 notes-only 例外经同伴逐字确认，不修改原方案、批准、素材或检测记录。安装回执 `validation/registration-install.json`，备份 `validation/registration-install-backup`。

随后仅调用一次现有 auto 入口：原制作任务完成本地登记，保留原 producerJobId 和本次 registeredByJobId，未新增制作/配音/导出任务；自动接入一个新的独立验收任务。真实客观预检全部通过，83 个音频窗最低相关 .75611、最大偏移 44ms；原 ASR 静音窗口的源 20ms 峰值为 -57.05dBFS，原 -50 阈值未变。三个制作方疑点完整送入独立验收，尚不据此声称声画验收通过。独立验收最终状态继续记录在本节。


### 真实验收收尾及证据格式兼容

本次真实独立验收实际检查了全部 46 张候选联系表、6 张参考联系表及补充原尺寸连续帧，排除了旧音频疑点，但发现 7 个真实问题：2 处解说/统计条件与画面语义锚点错位、4 处字幕 1–2 帧闪空、1 处代词错字。按既定要求保留成片并暂停；未擅自进入下一轮内容修改。

真实报告又暴露两处登记格式误报，已修复：

1. observed_sheets 包含全部 46 个必看 ID 和额外 14 个已观察补充画面时，原严格集合相等检查反而拒绝。改为必看 ID 的完整子集检查；必须为字符串数组、必看集合非空，额外条目不能补偿缺失 ID。
2. 视频标题观察引用了实际原生 PNG，而宿主只接受 MP4 路径。新增受限解析：仅本 review job 下的 native PNG；相邻 frames.json 必须绑定当前 MP4 file/sha，帧列表为非空、无重复、范围内整数数组，native path/frame 映射唯一，图像签名及哈希一致。登记仍规范绑定 MP4，并保存 observed_path/frame 及 PNG/manifest 哈希；封面路径、文字、行数、配色、独立身份及疑点裁定守卫均不变。

原始 review-response.json 已在首次登记前保存，因此直接用同一个原始独立结果重新执行全部 register-review/audit 守卫，不改写模型观察、不启动第二个模型验收。额外登记误报消失，音频、布局、遮挡、素材连续、画面和输出检查通过；7 个真实问题的 ID 与原始报告逐一相同，整体仍 quality_failed。旧报告/临时交付保留，新建包含准确报告的完整临时交付 ZIP。

新增交付复核由同一 voice_compat_review 完成：确认子集语义和帧证据规则，并复现 frames 字符串隐式 includes 漏洞；已改为严格数组校验。最终全量 Node **245/245**、Python **277/277** 通过；最后格式守卫改动后目标 Node **30/30** 再通过，同伴独立 Node **30/30** 与 Python 覆盖测试 **16/16** 通过，`git diff --check` 通过。日志 `validation/registration-final-v2-node.log`、`validation/registration-final-v2-python.log`、`validation/registration-coverage-node.log`。

已再次同步本机 quality_policy/quality 及测试/说明，空闲重启后校验：busy=false、activeJobId=null、technical_pass=true、technicalBlocker=null，工作台修订建议非空，完整临时包哈希校验通过。相对修复前仅新增一个 review job，原制作任务所有工具调用不变；原方案、批准、音色、其他项目及 profile 不变，80 个受保护媒体文件 SHA 全部不变。最终回执 `validation/registration-final-state.json`，报告重登记回执 `validation/review-replay.json`，第二次备份 `validation/registration-format-backup`。没有重新配音、渲染或发布。

任务的软件修复和本机交付已完成；本期视频质量未通过，等待用户对上述真实内容问题的修改意见。不要以继续 auto 绕过质量暂停；也不要把这次暂停解释为会话锁或再次登记失败。后续发布仍须提交、合并、重建安装包，本轮未执行这些操作。

### 2026-11-16：后台唤起缺口仍未修复

用户新建的另一制作任务在 00:27:38 入队，00:28:37 开始执行；用户明确确认是手动点开目标对话后才开始，不能把后续领取回执当作自动唤起成功。当前制作已运行，本次调查未重启工作台、重新派发消息或改动运行状态。

只读核实：`codex queue --help` 与官方命令文档均明确，`--resume` 需要可连接的本地 daemon 或指定 `--remote`；恢复失败只输出警告，命令仍成功。实际 `codex app-server daemon version` 返回本地 control socket 不存在。工作台 `desktop-agent.mjs` 仍仅调用 `queue --resume`，未指定远端；`DesktopReader` 的私有 stdio app-server 仅用于读历史，不能替代该恢复连接。因而此次入队成功、后台恢复失败与手动打开后开始相符，与独立验收未通过或历史运行锁无关。

版本比较：web.34、web.35、web.38 的上述派发参数一致；web.38 只是开始展示实际 stderr。11 月 4 日历史任务也保存过 queueWarning=true，但未保存具体警告，不能认定和本次原因完全相同；其中数次在入队后约 3–5 秒开始。旧任务 CLI 为 0.166.0-alpha.5.1，当前为 0.167.0-alpha.3.2，目前不足以证明升级导致回归，也无法从已有日志确认当时会话是否已经加载。

结论与后续：此前恢复/验收修复不包含可靠后台唤起；该问题仍开放。后续需核实并实现保留桌面插件和 Computer Use 能力的唤起路径，以“未手动打开目标会话时，从工作台提交即可实际领取”为端到端验收条件。不能仅检查 queue 退出码，也不能盲目另起 daemon 后宣称桌面能力等价。官方依据：https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-queue 。本次只做诊断和交接记录，无运行代码修改。

### 2026-11-16：自动唤起修复、本机安装与真实入口验证

用户随后明确要求修复并由 Agent 自行验证。沿用本任务、分支和累计改动；不更换模型、不启动通用 daemon、不调整桌面权限，不修改历史质量结论。

实现：桌面派发只执行一次 `codex queue`，移除会尝试进入通用 daemon 的 `--resume`。尚无匹配执行轮次/领取时，通过官方支持的 `codex://threads/<UUID>` 与 macOS `/usr/bin/open -g` 自动唤起原桌面宿主（可能切换 Codex 内显示的会话）。专用 `desktop-wake.mjs` 封装系统调用，参数使用 execFile，无任务正文或 shell 拼接。最多两次唤起，尝试次数先写入 ticket，恢复不会重发消息。系统调用返回仍不算开始/成功，真实轮次、claim、结构化结果及实际终态守卫保留。

同伴 voice_compat_review 确认方案，并独立复现末端竞态：异步历史读取期间出现 claim 或 owner 替换，旧检查会多请求一次导航。已增加 beginDesktopWake：在同一个桌面 mutex 内重读当前 ticket、owner、ack，检查撤销、有效期及本地取消后同步发起 OS 请求；将 Promise 包装返回并在锁外等待，避免导航与 worker claim 死锁。四个新增竞态回归涵盖 claim、owner 替换、撤销和过期。最终同伴独立 **32/32** 通过并确认交付。

验证与限制：

- 主 Agent 最终 Node **258/258** 全量通过（`--test-concurrency=2`，约 154 秒）；Python release **2/2**、packaging **3/3** 通过；`git diff --check` 通过。没有修改音视频分析算法，本轮未重复全量 Python。日志 `validation/wake-final-node.log`、`wake-release-python.log`、`wake-packaging-python.log`。
- 早期 HTTP 子集未带完整 Python 环境导致 catalog 失败，改用既有 runtime/native PATH 后 47 项通过。一次高并发全量发生既有 voice API 短轮询时间窗超时，最终使用并发 2 通过，未放宽业务断言。新增 detach 测试暴露临时目录清理与在途原子写的 ENOTEMPTY，fixture 使用有界文件系统清理重试；行为断言不变。
- 真实验证全部使用隔离的工作台数据目录和原已授权制作会话，无人工打开目标对话。首次 15 秒延迟对照中，会话已经驻留并自行开始，没有实际调用 OS 唤起；该对照只证明队列/桌面工具可用，不能称为未加载会话冷启动。首次尝试较旧会话时权限记录文件已不存在，在任何派发前终止，未降级权限校验。
- 随后在真实 Chrome 工作台页面点击“检查 ChatCut 实际连接”：单次自动 OS 唤起、queueWarning=false，实际匹配 turn/ack、hosted `list_projects` 成功，连接任务 completed。首次协议验证还实际调用了电脑控制只读清单，桌面工具可用；没有使用被拒绝的 Codex UI 自动化接口或私有 IPC。
- 再在隔离项目真实点击“一键生成视频”：01:52:38 入队并自动唤起一次，01:52:41 匹配执行开始，01:52:46 确认领取。测试请求明确只验证协议、禁止采集和媒体制作；控制器发现匹配 ack 后自动取消，01:53:03 实际轮次结束并释放占用，新增素材 0、媒体修改/生成工具调用 0。`validation/wake-e2e/summary.json`、`auto-result.json` 和 `http-connect-result.json` 保存原始证据，均在忽略目录，未收入发行包。
- 上述证明 Codex 运行时，无需用户点开目标对话即可经真实工作台入口自动唤起并开始；没有退出/重启整个 Codex 应用，也没有把已驻留对照称为冷启动验证。本轮未生成新视频或替代完整成片验收。

已备份并同步 6 个工作台代码/说明/测试文件至本机 web.38 插件缓存，空闲重启正式 4317 服务，当前项目一致且 busy=false。10 个保护文件中，8 个逐字节未变；当前项目的两份状态副本只产生启动保存时间和素材 cacheStatus 补记，去掉这两类派生字段后内容完全一致。当前项目两个有登记 SHA 的本地源文件实测哈希匹配；原项目、音色、成片与报告保留。回执 `validation/wake-install.json`，备份 `validation/wake-install-backup`。工作台页面和安装说明已同步无需手动点开会话及系统可能切换会话的行为。

状态：本轮后台唤起实现、同伴复核与本机入口验证通过；未提交、未合并、未发布远端。原客户视频仍保留原质量暂停状态。本次软件验收不代表新成片通过客户验收。


## web.39 累计发行交接 · 2026-11-16

用户已明确授权将本次和此前尚未发布的修复合并、推送和更新客户安装包。本次发行基线 `c057229`，开发分支 `codex/web38-voice-compat`，目标发布分支 `video-generation-workbench`，固定版本/标签 `0.3.0-web.39` / `v0.3.0-web.39`。纳入 voice-compat、candidate-snapshot 及本任务全部累计修复；不纳入官网、私人成片、会话、手机隧道或本机依赖。先快进合并，再推送分支与固定标签，Release 使用显式白名单三包和安装/升级文档。

发行前验证：完整 Node 258/258、Python 277/277 通过；两种安装包实际解压后逐文件 SHA-256 和隔离 HTTP 启动通过。初审确认 42 个参考/复现媒体与 web.38 完全相同，472,504,793 字节（40 个唯一 LFS 对象）；本次媒体无需更换，显式推送检查远端对象。版本、升级保留路径及便携包不含大媒体已写入 INSTALL、UPGRADE、README、CHANGELOG、RELEASE_SCOPE。曾误用主机损坏的 Python 3.14 导致打包时 json.decoder 缺失，未产生可交付包；切换已验证的独立 Python 3.12 运行环境后重新构建通过，没有修改产品依赖或降低检查。

可复现命令（先按 INSTALL 配置完整 Python、Node、FFmpeg 的 PATH）：

```sh
node --test --test-concurrency=2 plugins/video-studio/workbench/test/*.test.mjs
python3 -B -m unittest discover -s tests -v
python3 tools/verify_checkout.py --strict-tree
python3 tools/package.py
python3 tools/package_video_demo.py
# 分别解压插件 ZIP 与便携 ZIP，对实际解压目录执行：
node tools/verify_video_demo.mjs /实际解压目录
# 从 Release 下载全部附件后，在下载目录执行：
shasum -a 256 -c SHA256SUMS.txt
```

本机证据位于忽略目录 `validation/web39-release/`：node.log、python.log、lfs-push.log、checkout.json、三包构建记录和 artifact-*.log；最终发布回读及附件下载回执也保留在该目录，不随包公开。外部完成状态以固定 Release 和标签为准，不用任务文档中的发布计划替代远端证据。原客户工程继续保留原有质量暂停状态，本次发行不登记新的成片验收通过。
