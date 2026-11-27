# 把 Mac 分支交给另一位开发者

<!-- task-metadata -->
```json
{
  "id": "T-001-bootstrap",
  "owner": "本分支维护者",
  "branch": "codex/standalone-mac-studio",
  "goal": "建立共享项目上下文并完成 Agent 接手核实",
  "non_goals": "本轮仅整理团队开发与接手方式，保留已有视频任务及用户改动。",
  "acceptance": [
    "规范、任务、检查及 CI 适配文件可用",
    "目标来自启动输入，实际链路由 Agent 核实",
    "明确下一步与未完成验收"
  ],
  "status": "in_progress",
  "updated": "2026-11-28T00:31:43+08:00",
  "modules": [
    "development-context"
  ],
  "dependencies": [],
  "handoff": {
    "next": "在独立检出按 RUNBOOK 复核入口和快测，然后将下一项体验验证交给产品负责人。",
    "blockers": "协作资料可本地验证。共享远端与人员审批另按实际进展登记。",
    "failed_attempts": "用户指向的技能目录缺少 Python 实现与模板，已核对并使用同版的本机完整安装。"
  },
  "validation": {
    "claim": "unverified",
    "records": []
  },
  "doc_impact": {
    "standards": {
      "action": "updated",
      "reason": "接入本项目的协作规则、任务、配置与 PR 流程。",
      "paths": [
        ".agent-context/docs/DEVELOPMENT.md",
        ".agent-context/docs/PROJECT.md"
      ]
    },
    "runtime": {
      "action": "updated",
      "reason": "package.json 增加离线快测别名，运行手册给出节点版本、命令和媒体依赖。",
      "paths": [
        ".agent-context/docs/RUNBOOK.md"
      ]
    }
  }
}
```

从 41e7e6f 开始。此前根 README 同时描述独立工作台和前代插件，当前协作入口已置顶。现有业务证据继续在原目录。此次建立的是本地开发分支的团队工作方式，收到交接文件的成员可以在自己的检出运行验证。

技术方案由独立工作目录的同伴复核。其建议涉及真实模块匹配、增量代码包与 LFS 的区别，以及 GitHub PR 和本地快测的验证范围。产生冲突时以干净检出实测为准。回退可在贡献分支撤回本轮协作提交，保留初始化前的工程历史和工作区内容。

[本轮验证与交接记录](../evidence/bootstrap.md) · [后续业务任务](T-002-first-edit.md)
