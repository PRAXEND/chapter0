# GitHub 视频导入与成片问题定位

<!-- task-metadata -->
```json
{
  "id": "T-003-github-media",
  "owner": "Mac 工作台维护者",
  "branch": "codex/github-media-proxy",
  "goal": "通过用户配置的代理从 GitHub 导入先前超时的原片，查清最近工程的终审、时间线和排版现象。",
  "non_goals": "本期保留原工程，诊断展示与画质问题，单独验证素材导入。",
  "acceptance": [
    "通过工作台搜索和选择接口在空工程获取两条实际视频，核对时长、大小和 SHA-256。",
    "复核代理例外、逐跳路由和无环境配置的系统代理路径。",
    "以工程历史、审片回执和 MP4 抽帧核对制作现象。"
  ],
  "status": "merged",
  "updated": "2026-11-28T02:34:31+08:00",
  "modules": [
    "media-import"
  ],
  "dependencies": [],
  "handoff": {
    "next": "创作者可使用质量验证版导入素材。后续时间线与动效修复见 T-004。",
    "blockers": "企业 PAC 和独立 SOCKS 网络未实测。",
    "failed_attempts": "修复前同一工程的两条 GitHub 视频共三次超时。技术复核时发现 NO_PROXY 大小写与通配边界，已更正并复测。"
  },
  "validation": {
    "claim": "passed",
    "records": [
      {
        "command": "node --test apps/studio/test/github-media.test.mjs apps/studio/test/sources.test.mjs",
        "environment": "Node 24；9 项，包含本机临时 HTTP 代理的实际 CONNECT。",
        "result": "passed",
        "evidence": ".agent-context/docs/tasks/T-003-github-media.md",
        "at": "2026-11-28T02:06:33+08:00"
      },
      {
        "command": "(cd apps/studio && node --run test:quick)",
        "environment": "Node 24；工作台 13 项快测。",
        "result": "passed",
        "evidence": ".agent-context/docs/tasks/T-003-github-media.md",
        "at": "2026-11-28T02:06:33+08:00"
      },
      {
        "command": "POST /api/projects → /source-options/find → /source-options/pick → GET 工程并计算磁盘文件 SHA-256",
        "environment": "已安装质量版，Mac 8 GB，真实文件；另在无环境代理的空工程通过系统代理复验。",
        "result": "passed",
        "evidence": ".agent-context/docs/tasks/T-003-github-media.md",
        "at": "2026-11-28T02:06:33+08:00"
      },
      {
        "command": "gh pr view 8 --repo PRAXEND/chapter0 --json state,mergeCommit,mergedAt",
        "environment": "GitHub 远端共享开发分支",
        "result": "passed",
        "evidence": "https://github.com/PRAXEND/chapter0/pull/8",
        "at": "2026-11-28T02:34:31+08:00"
      }
    ]
  },
  "doc_impact": {
    "code": {
      "action": "updated",
      "reason": "公开素材导入增加代理选择。",
      "paths": [
        ".agent-context/docs/ARCHITECTURE.md"
      ]
    },
    "runtime": {
      "action": "updated",
      "reason": "macOS 安装版随附用于系统代理的原生组件。",
      "paths": [
        ".agent-context/docs/RUNBOOK.md"
      ]
    },
    "contracts": {
      "action": "updated",
      "reason": "每次跳转都重新校验公开目标并选择路由。",
      "paths": [
        ".agent-context/docs/ARCHITECTURE.md"
      ]
    }
  }
}
```

## 验证

代码基准为 `1a350cd`。在两个全新工程中通过素材库接口搜索「机器人 Yuni 冰场 Walker S3 绳降」，逐条选择对应视频并读取工程。耗时从提交单条导入开始计，含下载、校验、探测及写入，不含搜索。以下是本机当次观测。

| 素材 | 文件字节 | 时长与尺寸 | 安装版显式环境代理 | 仅 macOS 系统代理 |
|---|---:|---|---:|---:|
| Yuni 冰舞 | 17,218,625 | 98.00 秒，1080 × 604 | 2.44 秒 | 2.87 秒 |
| Walker S3 | 12,723,861 | 56.92 秒，1080 × 608 | 1.95 秒 | 2.88 秒 |

落盘文件分别匹配原片 SHA-256 `55f3cecc5ee57d8966309b4e27f5883e6eae2dab79b5a3c5f3760ea9908eb1c9` 与 `e8014565e271c61bf75d07c54c6b817c9bce2ad1605a6b4ba331493d33854b46`。质量版经过签名验证、重启和独立技术复核。对原制作工程及其任务记录做更新前后指纹比对，结果一致。回退可恢复此前的签名版本，应用资料库格式相同。

## 最近一个竖屏工程的诊断

- 终审回执为 `skipped / frames-disabled`。创建时帧分享、自动回看均关闭，独立审片预算为 0，结果为「待复核」。[终审条件](../../../apps/studio/src/independent-review.mjs)
- 工程历史在第 5 版有 8 个片段，第 26 版增至 53 个。分镜编排期间先发逐段进度，整批成功才提交。前台的任务轮询在任务运行时只更新消息，到终态才重新读取工程，因此即使持久化的修改也不会在当前时间线上自动出现。[分镜编排](../../../apps/studio/src/storyboard.mjs) · [编辑器轮询](../../../apps/studio/www/app.js)
- 两条新闻视频超时后，导演改用另一题材。最终七镜中前六镜的底片是照片，共 1301 帧，末镜使用 720 帧档案视频。成片共 2021 帧，30 fps。
- 抽查 MP4 时，竖版标题和普通字幕可读，素材上的来源标和强调字异常扁小。MP4 是 1080 × 1920、像素比例 1:1。来源标组件原稿 560 × 52，在 1080 × 608 的内容区内显式指定了 0.39 × 0.025 的尺寸，合成为 421 × 15。FFmpeg 将整个栅格独立缩到指定宽高，横纵缩放失配。改动重点应放在组件比例、内容区坐标及实际合成回看。[竖版内容区](../../../apps/studio/www/motion-clock.js) · [动效合成](../../../apps/studio/src/motion-render.mjs)

已合入 `codex/standalone-mac-studio`，合并提交为 `b40f984`。[PR #8](https://github.com/PRAXEND/chapter0/pull/8)
