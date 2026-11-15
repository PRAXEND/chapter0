# 待验收文件误报与继续流程修复

发行归属更新（2026-11-16）：累计修复纳入 web.39；发行验证与升级见 [VALIDATION](../../VALIDATION.md) 和 [UPGRADE](../../UPGRADE.md)，固定标签 `v0.3.0-web.39`。以下记录保留各阶段当时的状态，不以历史“未发布”描述覆盖本次发行归属。

状态：实现、验证、独立复核及本机候选恢复完成，未提交或发布；现有成片仍待独立验收。负责人：主 Agent。日期：2026-11-15。

## 目标与原因

用户反馈“待验收文件已变化，需要重新登记导出”，普通继续被阻塞且意见栏为空。继承 codex/web38-voice-compat 工作树，保留前一任务未提交的音色修复；发布基线仍为 c057229。

真实项目已导出，独立验收尚未启动。逐项 SHA-256 核对：MP4、SRT、两张封面、发布文案、技术记录、run.json 和方案都匹配，只有 material-selection.json 变化。startJob → ensureRun → saveMaterialSelection 会更新该记录的 updated_at；bindCandidate 却把可变记录当成永久不变的候选附件。后续 record-review 更新 run.json 也会造成同类误拒。意见自动建议来自实际验收报告或制片修改提案；此时 report=null，因此没有质量意见。

## 实现边界

沿用现有绑定和验证入口：成品角色继续绑定原路径与 SHA；其他附件在登记时复制到 run 内独立目录，核对源/副本同 hash 后绑定副本。所有快照继续参与验证，不忽略哈希，也不改变实时批准、输入、方案、revision 或独立验收身份校验。补证重试保留原附件快照，新增证据可另外登记；成品不允许静默替换。

意见区将技术阻塞单独显示为“验收准备受阻”，说明为什么没有质量建议；不填入创意修订框，不清除批准，不自动重制。错误提示具体指出变化文件。

当前旧候选若找不到原素材选择记录的完整字节，不伪造旧 hash、不把临时交付中的重建来源摘要当原件；应在核实成品完全不变、当前批准/工程/素材选择一致后重新登记附件，并保留旧候选记录。此次恢复不通过验收、不生成旁白/配乐/视频，也不派发制作任务。

## 验证与交接

新增快照稳定性、篡改拒绝、补证续接、真实 record-review 更新以及技术提示测试；HTTP 自动流程替身现在返回 run.json 和 material-selection.json，覆盖制作→验收→交付、验收失败和补证恢复路径。首轮一个断言误用 macOS /var 与 /private/var 别名，改为比较已规范化路径，未修改业务行为。

主 Agent 47/47 针对回归通过，无跳过（105.4 秒），包括 HTTP 自动流程九个情景：正常交付、质量拒绝、补证重启、制作检查点恢复、交付失败恢复和手动验收继续等。review 更新 run.json、ensureRun 更新时间戳之后均可继续，所有成品与快照篡改仍被拒绝。同伴 voice_compat_review 最终独立 49/49 测试通过并核对 HTTP 日志，无剩余阻断。审查曾发现技术错误可能串到同 plan/input 的旧候选，已通过当前 requestHash、review 阶段、producer 顺序和 automaticId 共同限定，补回归并复核通过。

可复现命令（与音色任务相同的有效 Python/native-bin/Node 环境）：

```sh
node --test plugins/video-studio/workbench/test/quality.test.mjs plugins/video-studio/workbench/test/revisions.test.mjs plugins/video-studio/workbench/test/provisional.test.mjs plugins/video-studio/workbench/test/automatic.test.mjs plugins/video-studio/workbench/test/automatic-api.test.mjs
git diff --check
```

本地恢复已完成：确认实际安装服务空闲，备份原候选、项目/运行状态和四个代码文件，逐一校验 5 份真实源文件，以及全部候选文件。唯一失配仍是 material-selection.json；忽略时间戳后的结构与当前选择严格一致，原批准通过 check-approval。由原 producer/job/thread 重新执行 bindCandidate，生成 4 份附件快照。5 类成品 path/hash 均与原登记完全一致，其余原本匹配的附件字节一致。旧候选完整保留，未冒充恢复旧素材选择记录的哈希。

仅同步 quality.mjs、revisions.mjs、revision-ui.js、studio-server.mjs 到本机已安装 web.38 并重启；前一音色修复保留。重新登记写入原工程和当前候选，保留 plan/input/voice、report=null 和原制作身份，清除已解决的当前报错并留下恢复事件。启动后 verifyCandidate 和 check-approval 再次通过，activeJobId=null、busy=false；未派发 review 或任何生成任务，未重新导出或消费 ChatCut 生成费用。根目录官网与已发布版本不变。

脱敏执行回执：validation/candidate-recovery.json；综合测试日志：validation/candidate-snapshot-tests.log；原候选与私有备份：validation/candidate-recovery-backup。均为忽略目录，不纳入公开发布。脚本只适用于已检查的这一旧候选，不作为通用批量迁移命令重复执行。

下一步：刷新工作台，在原项目点击继续，复用现有 69 秒候选进入独立验收。若真实验收未通过，再由报告提供修改建议；本次技术恢复不等于质量通过。发布前需另行提交、合并、升级版本与构建安装包。
