# 实时剪辑、文字动效比例与开剪前审片

<!-- task-metadata -->
```json
{
  "id": "T-004-live-edit-review",
  "owner": "Mac 工作台维护者",
  "branch": "codex/live-timeline-type-review",
  "goal": "后台提交及时显示，预览与导出的文字动效默认等比，新工程开剪前显示独立终审授权。",
  "non_goals": "保留用户工程、候选文件及原分镜事务边界。本次验证使用临时工程和本地渲染。",
  "acceptance": [
    "后台任务运行期间，通用剪辑及整批分镜两类提交更新轨道，触及同一字段时保护本地草稿。",
    "竖版来源角标在静帧、播放与 MP4 中的实际字形尺寸匹配原稿等比对照，支持手动解锁。",
    "三个新建入口都直接展示审片设置，显示状态与工程实际保存的权限、回合预算一致。"
  ],
  "status": "merged",
  "updated": "2026-11-28T02:34:51+08:00",
  "modules": [
    "timeline",
    "motion-composition",
    "project-creation"
  ],
  "dependencies": [
    "T-003-github-media"
  ],
  "handoff": {
    "next": "创作者可在本机质量验证版检查真实项目。",
    "blockers": "技术合入已完成。创作者的实际体验验收待进行。",
    "failed_attempts": "基线的轨道直到任务终止才更新，角标字形仅 6 像素高。技术复核另发现刷新会打断时间码输入，已修复并单独复测。"
  },
  "validation": {
    "claim": "passed",
    "records": [
      {
        "command": "node --test --test-concurrency=3 test/*.test.mjs",
        "environment": "apps/studio，Node 24，启用发行包 Codex 的本地集成测试。202 项通过，无跳过。",
        "result": "passed",
        "evidence": ".agent-context/docs/tasks/T-004-live-edit-review.md",
        "at": "2026-11-28T02:30:32+08:00"
      },
      {
        "command": "node scripts/verify-control-states.mjs",
        "environment": "签名校验和重启后的安装版服务、WKWebView 与随包 FFmpeg。11 组界面检查通过。",
        "result": "passed",
        "evidence": ".agent-context/docs/tasks/T-004-live-edit-review.md",
        "at": "2026-11-28T02:30:32+08:00"
      },
      {
        "command": "在独立副本执行 WKWebView 连续提交及热点 v8 来源角标三种成像路径探针",
        "environment": "Apple Silicon，临时工程，独立复核对照修复前后的实际画面。",
        "result": "passed",
        "evidence": ".agent-context/docs/tasks/T-004-live-edit-review.md",
        "at": "2026-11-28T02:30:32+08:00"
      },
      {
        "command": "gh pr view 9 --repo PRAXEND/chapter0 --json state,mergeCommit,mergedAt",
        "environment": "GitHub 远端共享开发分支",
        "result": "passed",
        "evidence": "https://github.com/PRAXEND/chapter0/pull/9",
        "at": "2026-11-28T02:34:51+08:00"
      }
    ]
  },
  "doc_impact": {
    "code": {
      "action": "updated",
      "reason": "工作台、检查器与预览更新。",
      "paths": [
        ".agent-context/docs/ARCHITECTURE.md"
      ]
    },
    "contracts": {
      "action": "updated",
      "reason": "修订事件、画面几何和授权依赖更新。",
      "paths": [
        ".agent-context/docs/ARCHITECTURE.md"
      ]
    }
  }
}
```

## 工程与验证

基线 `7b37087` 保留已安装的 GitHub 代理修复。过去运行中的轮询只更新进度文字。独立 Mac WebKit 复核中，旧版两次提交各等待 6.2 秒仍未显示轨道变化。修复后，同一任务保持 running 时就能看到通用编辑和原子分镜事务。连续 12 次后台提交均显示，播放头保持第 17 帧。正在输入的时间码、光标和选区在提交和任务结束后均可保留。再打开项目可追到最新版本。仓库自带的原生回归亦包含未完成时间码的断言。[WebKit 实测](../../../apps/studio/test/control-states-webkit.js) · [事务与重连回归](../../../apps/studio/test/timeline-playback.test.mjs)

竖版热点 v8 的内容区为 1080 × 608。以原稿 560 × 52 的来源角标复现，宽 0.39、高 0.025 的旧矩形为 421 × 15 像素。默认锁定后为 421 × 39 像素。独立复核以同一文案和位置对比真实像素，拖帧、播放窗口与正式 MP4 的白字从 6 像素高恢复为 17 像素，匹配按原稿等比合成的对照。手动解锁可重新指定两个尺寸。[编辑回归](../../../apps/studio/test/project.test.mjs)

三个入口实际创建四份临时工程，对照初始、仅分享画面、导演回看及独立终审的有效授权。初始终审预算为 0，三项开启时为 1。修改只切换新建界面的显示与已有权限设置，实际终审结果仍见候选交付记录。本次测试使用隔离资料库，没有启动真实选题制作。安装前后比对用户资料库，四份工程与四条任务记录的内容指纹一致。

## 接手

仓库根目录按 [Mac 工作台说明](../../../apps/studio/README.md) 准备两套风格资料。在 apps/studio 运行上表命令。完整离线集成测试通过 `VIDEO_STUDIO_RESOURCE_DIR` 指向已安装应用的 Contents/Resources，通过 `VIDEO_STUDIO_TEST_CODEX` 指向其中 codex-executable.txt 对应的随包程序。独立技术复核使用单独的检出和资料库，人工验收与共享合并单独记录。

已合入 `codex/standalone-mac-studio`，合并提交为 `62aca9d`。[PR #9](https://github.com/PRAXEND/chapter0/pull/9)
