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
  "status": "implemented",
  "updated": "2026-11-28T00:36:10+08:00",
  "modules": [
    "development-context"
  ],
  "dependencies": [],
  "handoff": {
    "next": "领取 T-002-first-edit，使用隔离工程验证新用户从首版到局部改稿与交付的体验。共享远端采用此分支时再运行 PR 检查。",
    "blockers": "本地技术交接已复核。人类代码审阅、远端 CI 执行和产品体验验收分别待相应成员开展。",
    "failed_attempts": "初始技能副本缺实现，改用相同版本完整安装。本机 npm 损坏，改用 Node 内置 runner。首次无媒体检出快测为 12/13，已修正视觉夹具并独立复测 13/13。"
  },
  "validation": {
    "claim": "passed",
    "records": [
      {
        "command": "python3 -m unittest discover -s .agent-context/tests -p test_context*.py -v",
        "environment": "Python 3.11，独立临时 Git 仓库，34 项",
        "result": "passed",
        "evidence": ".agent-context/docs/evidence/bootstrap.md",
        "at": "2026-11-28T00:36:10+08:00"
      },
      {
        "command": "cd apps/studio && node --run test:quick",
        "environment": "Node 24，独立检出与 42 个 LFS 指针，13 项",
        "result": "passed",
        "evidence": ".agent-context/docs/evidence/bootstrap.md",
        "at": "2026-11-28T00:36:10+08:00"
      },
      {
        "command": "node apps/studio/scripts/verify-control-states.mjs",
        "environment": "Apple Silicon，实体 v8，WKWebView 与隔离 SQLite，十组",
        "result": "passed",
        "evidence": ".agent-context/docs/evidence/bootstrap.md",
        "at": "2026-11-28T00:36:10+08:00"
      },
      {
        "command": "python3 .agent-context/tools/check_context.py --config .agent-context/config.json --base 41e7e6fb640b5661fa9c2f67ba6cee627c036905 --task T-001-bootstrap",
        "environment": "manifest 初始化基准；本地资料、链接和影响范围",
        "result": "passed",
        "evidence": ".agent-context/docs/evidence/bootstrap.md",
        "at": "2026-11-28T00:36:10+08:00"
      },
      {
        "command": "STUDIO_DATA_ROOT=\"$studio_data\" node apps/studio/src/server.mjs",
        "environment": "同伴独立检出，空资料库、系统帮助页和本机会话入口",
        "result": "passed",
        "evidence": ".agent-context/docs/evidence/bootstrap.md",
        "at": "2026-11-28T00:36:10+08:00"
      }
    ]
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
    },
    "code": {
      "action": "none",
      "reason": "视觉分割夹具显式关闭其可选音效，快测可在只有 LFS 指针的环境运行。生产编辑、视觉断言及专门的音效回归保持原有行为。"
    }
  }
}
```

从 41e7e6f 开始。此前根 README 同时描述独立工作台和前代插件，当前协作入口已置顶。现有业务证据继续在原目录。此次建立的是本地开发分支的团队工作方式，收到交接文件的成员可以在自己的检出运行验证。

技术方案由独立工作目录的同伴复核。其建议涉及真实模块匹配、增量代码包与 LFS 的区别，以及 GitHub PR 和本地快测的验证范围。产生冲突时以干净检出实测为准。回退可在贡献分支撤回本轮协作提交，保留初始化前的工程历史和工作区内容。

[本轮验证与交接记录](../evidence/bootstrap.md) · [后续业务任务](T-002-first-edit.md)
