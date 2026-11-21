# 任务记录

- [独立 Mac 自动剪辑工作台](T-20261122-standalone-mac.md)

web.39（2026-11-16）汇总以下三项累计修复及后台唤起改进，基线为已发布 web.38 `c057229`。发行范围与升级以 [RELEASE_SCOPE](../../RELEASE_SCOPE.md)、[VALIDATION](../../VALIDATION.md)、[UPGRADE](../../UPGRADE.md) 为准；固定标签 `v0.3.0-web.39`。任务正文保留历史阶段的当时状态。

- [T-20261115-recovery-hardening](T-20261115-recovery-hardening.md)：连续恢复、候选登记、验收证据/音频误报和桌面自动唤起；本机修复与真实工作台入口验证通过，纳入 web.39。既有成片的真实质量暂停状态保留。
- [T-20261115-candidate-snapshot](T-20261115-candidate-snapshot.md)：冻结候选附件，修复正常工作记录变化阻断验收；纳入 web.39。
- [T-20261115-voice-compat](T-20261115-voice-compat.md)：当前 ChatCut 音色目录与正式配音兼容，保留原音色稳定身份；纳入 web.39。

- [T-20261115-web35-session-audit](T-20261115-web35-session-audit.md)：web.35 遗留 7 项问题与客户桌面会话阻塞复核；6 项仍在、配乐检测部分改进但原例仍失败，另复现轮次分页遗漏导致持续占用。已完成 web.38 修复与独立复审，并按用户指令合入发布分支；发行与客户升级入口见任务文末和 UPGRADE.md。历史项目与竖版视觉保留，客户成片验收未代替执行。
- [T-20261114-portrait-layout](T-20261114-portrait-layout.md)：基于76aac51的竖版排版功能分支；客户确认的v3视觉已固化为web.37默认，插件/工作台实现验证通过，当前本地工作台已加载。已随 web.38 纳入发布分支，发行记录见上项；本轮未重做完整成片验收。
