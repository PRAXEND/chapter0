# 客户竖版统一排版

<!-- task-metadata -->
```json
{
  "id": "T-20261114-portrait-layout",
  "owner": "Codex（主实现；用户负责最终验收）",
  "branch": "video-generation-workbench-feature",
  "goal": "以客户新排版替代整体上移，聊天与网页所有竖版风格使用相同布局及验收契约",
  "non_goals": "修改个人风格库、原参考视频、旧项目文件、安装插件、收费制片、发布或合并",
  "acceptance": [
    "素材框固定居中并等比完整适配",
    "顶部由 Agent 生成一至两行标题，文字与两张封面一致",
    "普通白色字幕固定在素材下方，单/双行字顶稳定并贴近素材",
    "花字全动画位于实际素材内并避让主体与动作",
    "移除旧留量控件、提示及执行规则",
    "横版方形不套用；旧竖版批准不能绕过新布局",
    "相关回归、接口路径、分发验证及同伴审查",
    "标题白黄强调与两封面同字同重点",
    "120条全幅低对比动态灰线与1.2秒渐隐、0.6秒黑屏默认为所有竖版",
    "聊天和工作台共用可编辑配方、实际读回预检与独立观察门槛"
  ],
  "status": "implemented",
  "updated": "2026-11-15T00:56:46+08:00",
  "modules": [
    "production-plan",
    "workbench",
    "production-skills"
  ],
  "dependencies": [],
  "handoff": {
    "next": "从本地开发版工作台新建后续竖版项目；按customer-portrait-v3制作和独立验收。已把空闲的4317服务切到本开发目录，既有数据保留。尚未安装到插件缓存、推送或发布。",
    "blockers": "无产品需求阻塞；本轮没有重新制作完整ChatCut视频，不能将配方组件/协议验证写成新成片一次验收通过。",
    "failed_attempts": "默认 Homebrew Python 标准库不完整；首轮全量 Python 中7项媒体测试调用损坏的 PATH ffmpeg 失败。指定插件 Python 3.12.14、native-bin及正确 PATH 后全量215项通过。浏览器初次发现旧主题覆盖示意文字颜色，修正后复查通过。 标题增量首轮发现无方案记录处理、临时路径别名及交付变量引用错误，修复后全量通过；同伴发现并修复v1横方重复同步/恢复指纹及末次标题trim不一致。 web.37首轮回归发现未配置画幅None比较、旧audit误用新旁白占用、UI富文本断言和方形自动模式fixture问题，已修；review_sync新hook先读voice_sources导致旧错误顺序变化，修复。原环境缺PyYAML，只在ignored validation/skill-deps安装用于技能校验。"
  },
  "validation": {
    "claim": "implementation_passed",
    "records": [
      {
        "command": "Python unittest discover -s tests -v",
        "environment": "Python 3.12.14; native FFmpeg/ffprobe; isolated temporary runs",
        "result": "215 passed",
        "evidence": "validation/python-final.log",
        "at": "2026-11-14T15:14:08+08:00"
      },
      {
        "command": "node --test test/*.test.mjs",
        "environment": "Node 24.14.0; VIDEO_STUDIO_PYTHON/VIDEO_STUDIO_FFMPEG_DIR and native-bin PATH",
        "result": "179 passed; includes real HTTP save/approve/reject and bridge records",
        "evidence": "validation/node-final.log",
        "at": "2026-11-14T15:14:08+08:00"
      },
      {
        "command": "independent peer review, v2 diff",
        "environment": "separate detached worktree",
        "result": "21 Python + 32 Node passed; no remaining blockers",
        "evidence": "Peer review summary below",
        "at": "2026-11-14T15:14:08+08:00"
      },
      {
        "command": "Python unittest discover -s tests -v",
        "result": "218 passed",
        "evidence": "validation/title-python-final.log",
        "at": "2026-11-14T15:29:22+08:00"
      },
      {
        "command": "node --test test/*.test.mjs; final projects/quality tests",
        "result": "183 passed in full suite; final focused 21 passed (includes added recovery test)",
        "evidence": "validation/title-node-final.log; validation/title-recovery.log",
        "at": "2026-11-14T15:29:22+08:00"
      },
      {
        "command": "Python unittest discover -s tests -v",
        "result": "271 passed; no skips",
        "evidence": "validation/v3-python-final.log",
        "at": "2026-11-15T00:56:46+08:00"
      },
      {
        "command": "node --test test/*.test.mjs; final review-packet tests",
        "result": "186 passed full suite; final prompt change 4 passed; no skips",
        "evidence": "validation/v3-node-final.log; validation/v3-node-review-final.log",
        "at": "2026-11-15T00:56:46+08:00"
      },
      {
        "command": "Independent layout and narration hook review",
        "result": "layout 41 Python + 40 Node; audio hooks 56 Python; no remaining blockers",
        "evidence": "Peer review results below",
        "at": "2026-11-15T00:56:46+08:00"
      }
    ]
  },
  "doc_impact": {
    "production": {
      "action": "updated",
      "reason": "布局契约与迁移说明变化",
      "paths": [
        "plugins/video-studio/references/common-production.md",
        "README.md",
        "CHANGELOG.md"
      ]
    }
  }
}
```

## 当前增量：已确认视觉效果固化（web.37，2026-11-15）

本次开发基线 `151a6f0`。用户已认可机器人试片 v3 的视觉效果，要求同步为本地开发插件的所有竖版默认；这不是授权把旧技术未验证项追认为通过。以下 v1/v2 章节保留历史，当前布局以 customer-portrait-v3 及 [唯一配方说明](../../plugins/video-studio/references/portrait-presentation.md) 为准。

- 1080×1920：素材 y=656/h=608，标题 y=422/h=222（白#FFFFFF、重点#F0FF00），字幕 top=1281，单行68/双行135。标题底对齐7.8px内边距保留已确认双行位置，单行字底也不漂移；宽度缩放与中心定位适用于其他竖版。
- 底层为#030405上120条淡灰线，6组、强度.12、速度1、四边220px绘制余量。原版旋转中心保持，其他尺寸由外层缩放。末尾1.2秒全层渐隐、0.6秒全黑；配乐在黑屏前结束且淡出1.4秒，旁白先结束。
- 新 `portrait_design.py` 返回确定性的可编辑 ChatCut inline payload，所有竖版方案/实际记录增加titleEmphasis/titleStyle。自动、手动工作台和聊天技能共用；横方提示、身份指纹、恢复不套用。旧竖版须按新契约重规划，历史文件保留。
- 预检检查背景/结尾实际实例、完整时间线、轨道ID/别名、静音、图层顺序、时间和参数；`portrait_evidence`读取原始asset JSON与item文本，对照源码、revision和当前时间线。独立验收另要求间距、标题配色、背景运动、渐隐中段/黑屏/最后帧的实际观察和三文件标题重点，不把元数据当画面。
- 修正旁白audio_fit为实际与镜头相交语音片段的并集占用，片段间留白不算发声；保留原同步容差。配乐检测优先真实无旁白区间，仍要求原相关度/RMS/偏移阈值及多个一致窗口。可选最终速度WAV路径通过源→派生PCM重放校验、真实新ASR和rate=1剪辑避免渲染器变速波形差异，不给导入资产伪造音色记录。
- 影响链路仍为 brief/inputHash/requestHash → 方案 → checkpoint/save/approve → 制作配方和实际读回 → prepare-review → 独立record-review/audit → delivery。没有新框架、远端权限或依赖服务；只在既有扩展点增加配方和证据验证。没有修改官网、个人风格、已确认试片/既有项目或旧审核。

验证证据：

- 全量271项Python、186项Node通过，无跳过；末次验收提示变更4项Node再次通过。五份受影响技能通过skill-creator校验。新增真实FFmpeg派生/波形测试与原始工具协议fixture明确区分，不冒充真实成片审阅。
- 工作台实际HTTP/Python bridge保存/批准保持，通过跨语言布局、旧横方v1/v2冻结指纹、连续恢复测试。新预检→record-review→quality_policy的正反路径拒绝缺观察、缺渐隐过程、客观错误和被改动的原始证据。
- 版式同伴在独立worktree最终41项Python、40项Node通过；音频同伴56项Python的生成源/导入ID/真实词表、完整请求范围、变速派生链、CLI fps与三个宿主hook测试通过；无剩余阻断。Agent代码审查不代替人的成片验收。
- 本地React渲染配方与真实原版背景在0/900/1700帧的SVG及所有组变换完全相同；浏览器查看了单/双行标题、字幕、背景、渐隐和最终黑屏，单/双行标题底一致。截图validation/v3-recipe-preview.png是占位素材的组件验证，不是ChatCut成片。
- 隔离web.37工作台实际打开，竖版说明可见，切到横版隐藏。随后发现常用4317仍为web.35且无活动任务，按已授权更新与open-video-workbench技能重启到本开发源码。五份现有项目/会话状态文件JSON逐字段完全一致、没有新任务；备份仅在ignored validation中，未复制到分发包。插件缓存仍未替换。
- 音频组件以已冻结源文件在隔离临时目录作1.2倍派生、重放PCM完全一致，诊断AAC混音14个窗口通过原严格匹配阈值。没有对原试片补填ASR、重制或改写旧验收；新导入资产的真实ChatCut转录和新整片制作本轮未执行。
- 本轮分发包/清单验证见VALIDATION.md。现有42个原音视频不变。没有推送、合并或发布。

复现仍使用下方完整Python/Node环境命令；新增覆盖为test_portrait_design、test_portrait_evidence、test_portrait_review_path、test_voice_derivations、test_voice_derivation_integration。原始测试日志、项目状态备份和截图不分发。

## 现状与方案

基线为已发布提交 `76aac5109d95e70f80d517ae04aaf99126783969`（web.35）。独立 worktree，不编辑其他旧开发区。原版仅约束下缘，不能实现客户要求的固定三分区、顶部标题和字幕/花字分离。沿用现有 Python 与浏览器共享校验入口，未引入新框架。

入口：聊天 brief → studio.py → production_plan.py；网页设置 → brief/inputHash → 自动任务 requestHash → 方案 schema → Python bridge 保存/批准 → ChatCut 制作提示 → beat.layout_result → 独立验收。变化包括布局数据与批准兼容，不改变远端权限或账号。

采用 customer-portrait-v2；归一化标题框 (.05,.04,.95,.28)、素材框 (0,.32,1,.68)、字幕框 (.05,.72,.95,.88)。坐标及字幕字号是实施默认，客户未指定这些数值。素材框中心为 (.5,.5)，contain 缩放；花字按实际影像边界额外校验，不能用框内黑边。用户补充明确顶部标题由 Agent 生成，与两张封面的标题文字一致。使用 productionPlan.coverTitle 统一文案，每镜 titleText 最多两行；关闭普通字幕时仍显示标题。该要求替代首版 v1 的顶部留空，历史验证记录保留。横方版不套用。

旧 inset 字段只在输入清理/历史兼容中识别，没有执行规则。历史文件不迁移覆写，旧竖版批准缺少绑定或布局不符时要求重新生成并审阅。原参考继续用于表达对照，客户黑底留白不得误判为风格失败。后续如需修改坐标，应更改布局版本、重新绑定方案与证据。

## 首版进展与证据（2b648d8，v1）

- 基线相关验证：15 项 Python、23 项 Node 通过。
- 完整回归：Python 215 项、Node 179 项通过，无跳过。末次局部修正后的布局回归再次通过（Python 21 项、Node 12 项）。
- 新增/扩展覆盖：无风格与多风格、不同分辨率、长短字幕固定位置、字幕下缘可超过旧 82%、花字动画/素材黑边越界、空白标题、字幕关闭、横方版兼容、多镜最短时长、实际坐标每轴 1px 舍入、旧批准缺失绑定、跨语言接受/拒绝一致。
- 真实隔离 HTTP 路径验证：竖版保存方案、确认方案、拒绝无效版式且不覆盖原确认、Python run 记录一致；自动制作与远端工具使用显式协议替身，无付费生成。
- 使用未经修改的 web.35 模块计算冻结输入指纹，确认旧横版/方形 hash 保持；旧横版已验收候选恢复直接 delivery，不重开制片。旧竖版 hash 变化并要求重新规划。
- 浏览器核验：独立临时数据工作台可打开 web.36；旧控件不存在，客户说明在竖版可见、横版隐藏；实际 renderProductionPlan 组件示意截图可读，无控制台错误。图片在 validation/layout-preview.png 与 validation/workbench-portrait-settings.png，仅为软件界面，不是成片。
- 同伴审阅：layout_peer_review 在独立 detached worktree 初审并复审；提出的旧横版交付误重制 P1 已修复。复审独立跑 21 Python + 32 Node，通过，无剩余阻断。Agent 审查不代表人的确认。
- 原媒体与个人风格未修改；LFS 只从本地缓存还原，42 个文件 472,504,793 字节。发行清单与 ZIP 校验见 VALIDATION.md。
- 本独立 Video Studio 仓库没有官网的 tools/check_context.py；采用本仓库业务、HTTP、分发检查，不以官网检查器冒充本仓库校验。

复现验证（在本仓库根目录，先让 VIDEO_STUDIO_PYTHON 指向完整 Python，VIDEO_STUDIO_FFMPEG_DIR 指向可用 FFmpeg，并将二者所在目录加入 PATH）：

```sh
"$VIDEO_STUDIO_PYTHON" -m unittest discover -s tests -v
(cd plugins/video-studio/workbench && node --test test/*.test.mjs)
"$VIDEO_STUDIO_PYTHON" tools/package.py
"$VIDEO_STUDIO_PYTHON" tools/package_video_demo.py
"$VIDEO_STUDIO_PYTHON" tools/verify_checkout.py --strict-tree
git diff --check
```

## 用户补充：Agent 顶部标题与封面一致（v2）

用户明确“顶部标题也是 Agent 生成的，内容跟封面的标题一致”，替代文档原来的留空要求。本次沿原分支继续开发，未安装或发布。

- 唯一文案为 productionPlan.coverTitle；每镜及实际 layout_result 记录 titleText/titleBox。顶部全片显示一至两行，换行之外逐字一致；关闭普通字幕仍保留标题。生产计划布局版本升为2，旧v1竖版须重规划；素材、字幕、花字区域不变。
- 制作提示要求两张封面复用 coverTitle。验收包包含预期标题与两封面路径/哈希；独立 output_details 逐字读取视频顶部和两封面，绑定三文件及当前方案。拒绝空/错标题、实际顶部超过两行、伪封面、缺失观察及错误绑定。换封面路径或字节后旧结论失效。发布文案标题独立。
- 旧横方v1保留输入/自动任务指纹；连续同步不增加revision或清空reviews；从历史任务恢复保留布局版本。采用未改v1代码生成的冻结指纹核对，不使用实现自身计算预期值。
- Python全量218项、Node全量183项通过；末次恢复/空白规范修正相关21项Node再次通过，包含新增恢复用例。同伴在独立worktree复审通过：23 Python、49 Node、连续sync及末次21 Node。首轮失败与修复见元数据。
- 浏览器实际renderProductionPlan组件示意经截图核验，顶部显示两行例文；validation/title-layout-preview.png是软件界面，不是ChatCut成片。开发包重建、哈希和发行清单复核见VALIDATION.md。

## 交接与交付

本地实现及相关验证通过，尚未合并、推送、发布、安装或获客户验收。提交保存在本任务分支，回退可从基线另建分支或撤销功能提交，无需触碰其他工作区。未修改个人风格、原媒体、运行项目或默认偏好。

结构化坐标和证据哈希只验证声明与绑定，不证明实际视频等比、无遮挡、字幕易读或动效审美。真实 ChatCut 试片及客户验收尚未执行，后续仍需按客户版式查看实际合成帧；软件示意和协议测试不能替代成片验收。


## 随 web.38 纳入发布（2026-11-15）

用户授权后，本功能及后续修复随 a4e3118 快进合入 video-generation-workbench。发行包、标签、验证及客户升级统一记录于 [web.38 发行任务](T-20261115-web35-session-audit.md#第三轮web38-发布与客户升级2026-11-15)及 [UPGRADE.md](../../UPGRADE.md)，不改写以上各开发阶段证据。独立审查通过，不代表额外完成客户成片验收。
