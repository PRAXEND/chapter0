# Video Studio for Mac · 项目首页

2026-11-28 核对。产品负责人和业务验收人为本项目发起人。工程工作按任务指定一位结果负责人。

## 目标与交付

面向制作中文短片的创作者。用户在一个 Mac 窗口给出选题、脚本与素材，或一段访谈原片。Codex 在工程内选材、剪辑、回看，用户可以继续对话或直接改时间线。交付 MP4、SRT 和可重新打开的工程，发布包可另附封面与文案。[用户已给出的目标和验收条件](../brief.json)

## 从什么基线接手

| 范围 | 已有证据 | 接手时怎么判断 |
|---|---|---|
| 独立工作台 | 本次协作资料从开发分支 `codex/standalone-mac-studio` 的 `41e7e6f` 建立。2026-11-27 的 Mac 质量验证版已安装，记录有 196 项自动回归、十组原生界面操作和两次一致的有声短片导出。 | 这是指定设备上的历史验证。当前检出先运行离线快测，需要验证画面或声音时使用实体媒体和原生测试。[安装版证据](../../docs/tasks/T-20261127-workbench-usability.md) |
| 两套风格 | 热点资讯型 v8 与技术科普型 v8 分别有 7 个和 6 个原版动效。工作台用指纹锁定配方与媒体，正式默认音色是 Dylan。 | 能选中风格、资源校验通过以及创作者认可成片是三个分别记录的结果。[风格与制作流程验证](../../docs/tasks/T-20261126-v8-parity.md) |
| 旧插件 | `video-generation-workbench` 的发布标签为 `v0.3.0-web.39`。该发行文档保留了 ChatCut 桌面制片与升级路径。 | 维护旧插件时查[发行说明](../../UPGRADE.md)。开发此 Mac 工作台从[独立应用说明](../../apps/studio/README.md)进入。 |

共享开发分支为 [PRAXEND/chapter0 · codex/standalone-mac-studio](https://github.com/PRAXEND/chapter0/tree/codex/standalone-mac-studio)。成员从该分支领取任务，提交 PR 时也选它作为目标。公开分发 Mac 应用、GitHub 分支保护和真实创作者验收分别需要对应的交付记录。

## 正在进行与下一项

| 任务 | 结果负责人 | 状态与依赖 |
|---|---|---|
| [T-001-bootstrap · 把本分支交给另一位开发者](tasks/T-001-bootstrap.md) | 本分支维护者 | 本地实现通过，已由另一位 Agent 从独立检出复核。 |
| [T-002-first-edit · 新用户从空工程到一次局部改稿](tasks/T-002-first-edit.md) | 项目发起人负责体验验收 | 已登记，待领取执行。使用隔离工程和已获授权的素材，由创作者审看首版与改稿。 |

从[任务索引](tasks/README.md)进入同一份记录。既有的 Mac 与插件研发证据继续维护在[历史任务目录](../../docs/tasks/README.md)。新开并行任务时登记结果、分支和涉及模块，仅凭本机保留的旧 worktree 无法推断谁在工作。

## 开发入口

[仓库协作规则](../AGENTS.md) · [架构与编辑链路](ARCHITECTURE.md) · [从取得分支到跑通验证](RUNBOOK.md) · [任务、PR 与交接](DEVELOPMENT.md)
