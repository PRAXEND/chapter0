# 开发流程 · 1.0.0

新会话先读规则、PROJECT 和当前任务，确认 Git 现场；按范围读架构/运行/决定，不必每次通读全部。
登记一位负责人、目标/非目标、验收、分支、模块和依赖；关键变更由另一位成员确认方案，完成后审阅证据。Agent 不代替人的批准。
开发按事件更新受影响资料，暂停/换人更新同一任务；轮值集成人维护全局合并/发布摘要。使用独立 worktree/克隆。

## 从领取任务到交接

1. 从[任务索引](tasks/README.md)选择一项可验收的结果，由一位负责人认领。复制[任务模板](../templates/TASK.md)，登记任务 ID、实际分支、模块、基线、验收条件和当前依赖。历史视频任务的证据可以直接引用。
2. 从当前集成分支建立独立 worktree。并行成员在各自目录提交。涉及同一工程数据、接口或发行资源时，先在任务里约定接入点和集成顺序。
3. 修改业务规则前对照[架构入口](ARCHITECTURE.md)。影响共享契约时，记录数据如何兼容或回退，请另一位成员核对方案。按本次影响选用[运行手册](RUNBOOK.md)中的验证。
4. PR 指向团队已提供的 Mac 集成分支，附同一份任务记录、验证命令、结果与限制。暂停时写明当前提交、待补证据和下一步。接手人在自己的检出重跑。负责人按实际状态更新项目首页。

## 检查

Python 3.11+，标准库，无 pip 依赖。

```sh
python3 .agent-context/tools/check_context.py --config .agent-context/config.json --base <基准SHA> --task <ID>
python3 -m unittest discover -s .agent-context/tests -p 'test_context*.py' -v
```

先获取目标分支，用 `git merge-base HEAD <目标分支>` 确定基准，不能以 HEAD 漏掉已提交的任务改动。
检查包含提交、暂存、未暂存、删除/重命名及 managed_paths 中未跟踪文件；不自动 fetch，不修改文件。
--task 可重复；省略时选择此次变动的任务。--json 给机器报告；错误退出 1，提醒退出 0。
配置按仓库根相对路径匹配，覆盖桌面服务、工程数据、Codex 接口、原生壳、打包与风格资源。Git 已跟踪文件都参与差异；managed_paths 只约束未跟踪文件，其中不含 / 的模式只匹配根目录，避免旁边本地项目混入。

纯文字小修可用 --exempt-reason 和 --exempt-validation 提供说明，无需任务。纯代码格式小修另加 --format-only，只是作者声明，仍需核对 diff；关键路径不能因此跳过任务及同伴审阅。
CI 自动读取唯一一份本次变化的 .agent-context/docs/changes/*.md 中 `<!-- change-note -->` 后的 JSON 块：包含 reason、validation、format_only（布尔值）。

## 任务格式

task-metadata 标记后的 JSON：id 与文件名一致；owner 是一位人类负责人；branch 真实；goal/non_goals/acceptance 清晰；updated 为含时区 ISO 时间。
status：planned/in_progress/blocked/implemented/merged/released/accepted。modules、dependencies、acceptance 为数组；handoff 的 next/blockers/failed_attempts 必填。
validation.claim 为 unverified/failed/passed；records 为当前验收范围的最近验证，每条 command、environment、result（passed/failed/not_run）、evidence（根相对文件或 URL）、at。
implemented 及之后阶段必须验证通过；历史失败留在 failed_attempts/证据中；必需验收未运行时不得通过。合并、发布、客户验收需额外真实证据，不能只改状态。
doc_impact 按配置 rule ID 写 action=updated/none、reason；updated 的 paths 必须是本次修改且存在的 Markdown。

## CI 与直接推送

本仓库的 GitHub 工作流和 PR 模板放在根目录。PR 比较目标分支与提交的分叉点。CI 依次运行检查器回归、资料检查和 Mac 工作台的离线 Node 快测。原生 WebKit、风格媒体和实片验证由具备相应环境的成员按运行手册完成。[工作流](../../.github/workflows/agent-project-context.yml) · [PR 模板](../../.github/pull_request_template.md)

管理员在远端启用 required check、审批、禁止自行批准等保护；本地文件不能替代远端配置，也不能证明 CI 已运行。
直接推送前运行相同命令；关键变更先审阅分支，经另一成员针对明确提交批准后进入共享分支。
可选 .agent-context/tools/hooks/pre-push 读取 CONTEXT_BASE/CONTEXT_TASK；人工合入已有 hook，不能覆盖原配置。Hook 可跳过。

## 限制与试点

检查器不运行业务测试、不验证远端链接或 Markdown 锚点、不证明理由成立或人的批准；代码块中的示例不检查。模块冲突只按任务显式模块名提醒，不自动知道其他分支/成员空闲。
在独立工作目录，用没有原聊天的成员和 Agent，只给仓库与任务 ID，约 30 分钟检验能否解释全局、找到入口/上下游、区分基线与分支、运行验证、说出下一步和失败尝试。
逐一测试 Codex/Claude Code/Cursor 实际读取入口，记录版本、路径与结果。未执行必须写待执行。
试行两周，每周约十分钟回顾缺口/多余步骤；连续遗漏再升级检查。版本升级通过普通审阅进入仓库。
