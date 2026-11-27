# 任务标题

<!-- task-metadata -->
```json
{
  "id": "<任务ID>",
  "owner": "<一位负责人>",
  "branch": "<任务分支>",
  "goal": "<可验收目标>",
  "non_goals": "<明确非目标>",
  "acceptance": ["<可验证条件>"],
  "status": "planned",
  "updated": "<带时区的ISO时间>",
  "modules": ["<稳定模块名>"],
  "dependencies": [],
  "handoff": {
    "next": "<下一步和具体入口>",
    "blockers": "<当前阻塞或明确无>",
    "failed_attempts": "<失败尝试/证据或明确无>"
  },
  "validation": {"claim": "unverified", "records": []},
  "doc_impact": {}
}
```

## 现状与方案

真实基线提交、已有实现为何不足、影响入口/上下游/权限/数据/并行任务、兼容/迁移与回退。
关联 PR/MR、提交、决定、方案确认和审阅记录；没有则明确尚未发生，不填写虚假批准。

## 进展与证据

已完成什么、哪些尚未验证，证据以链接引用。validation.records 每项包含 command/environment/result/evidence/at。
doc_impact 以配置规则 ID 为键，值为 action（updated/none）、reason；updated 必须列 paths（仓库根相对 Markdown 路径）。
历史失败留在 handoff.failed_attempts/证据中；尚未完成的验收不能隐藏。

## 交接与交付

更新同一任务。下一位从哪里开始、已知阻塞、待决定问题、实现/合并/发布/验收分别说明并附证据。
