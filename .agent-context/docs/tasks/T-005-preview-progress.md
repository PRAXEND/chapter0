# 工程预览与进度列表

<!-- task-metadata -->
```json
{
  "id": "T-005-preview-progress",
  "owner": "Mac 工作台维护者",
  "branch": "codex/preview-size-progress-scroll",
  "goal": "预览屏自动跟随工程画幅，支持放大连续播放。阅读进度记录时保持当前行。",
  "non_goals": "改动范围为剪辑台、内置帮助和原生界面测试。",
  "acceptance": [
    "三种工程画幅的预览可随修订自动变化，放大、定位、播放、还原后沿用同一播放头。",
    "进度连续轮询、收到新消息、旧消息淘汰及任务转为完成时，保留仍可阅读的历史行。停在底部时跟随最新进度。"
  ],
  "status": "implemented",
  "updated": "2026-11-28T04:18:53+08:00",
  "modules": [
    "editor-preview",
    "job-progress"
  ],
  "dependencies": [
    "T-004-live-edit-review"
  ],
  "handoff": {
    "next": "审阅任务分支，在质量验证版的实际工程中体验放大预览和滚动阅读进度。",
    "blockers": "无实现阻塞，待合入共享分支及创作者体验验收。",
    "failed_attempts": "旧版竖屏被置于横向屏幕，进度轮询使阅读位置从 97 回到 0。安装包复验时，后台原生测试窗口未收到鼠标事件，将测试点击直接投递到测试 WebView 后，受信任点击与连续播放均通过。"
  },
  "validation": {
    "claim": "passed",
    "records": [
      {
        "command": "node scripts/verify-control-states.mjs",
        "environment": "签名重启后的安装版服务、Mac 系统 WKWebView、临时工程和真实 4 秒有声素材。14 组检查通过，包含三个画幅、真实播放和 120 条滚动进度。",
        "result": "passed",
        "evidence": ".agent-context/docs/tasks/T-005-preview-progress.md",
        "at": "2026-11-28T04:18:53+08:00"
      },
      {
        "command": "node scripts/test-webview.mjs",
        "environment": "Mac 系统 WKWebView。创建、剪辑、拖动、修剪、撤销、定位与分割通过。",
        "result": "passed",
        "evidence": ".agent-context/docs/tasks/T-005-preview-progress.md",
        "at": "2026-11-28T04:18:53+08:00"
      },
      {
        "command": "node --test --test-concurrency=3 test/*.test.mjs",
        "environment": "Node 24，发行版组件和 Codex 本地集成测试。202 项通过，无跳过。",
        "result": "passed",
        "evidence": ".agent-context/docs/tasks/T-005-preview-progress.md",
        "at": "2026-11-28T04:18:53+08:00"
      }
    ]
  },
  "doc_impact": {
    "code": {
      "action": "updated",
      "reason": "更新剪辑台监视器和作业进度的显示与交互。",
      "paths": [
        ".agent-context/docs/ARCHITECTURE.md"
      ]
    }
  }
}
```

## 复现与交接

基线是 `abe8ac2`。在 800 × 540 的 WKWebView 中打开 1080 × 1920 空工程，旧版预览屏为 633 × 195。通过服务端存储真实的 running 任务和 30 条测试消息，滚动列表至 97 像素，读数在下一次轮询回到 0。安装版修复后，竖屏为 151.875 × 270，显示全部 30 条消息，在相同位置等待刷新仍为 97 像素。

分别以 16:9、1:1、9:16 修改同一个空工程，检查正常与放大模式的画面矩形。使用真实视频在放大监视器定位第 17 帧，由原生鼠标事件播放，播放中还原时帧号继续前进。进度专项使用可控的 120 条测试事件，检查阅读位置和行内偏移、服务端滚动淘汰、新消息跟随与终态切换。测试命令从 apps/studio 执行，所用资料库均位于临时目录。[原生回归](../../../apps/studio/test/control-states-webkit.js) · [工作台内置图示](../../../apps/studio/www/guide/edit.jpg)

本机质量验证版签名验证通过并正常重启，升级前后工程与任务内容指纹一致。可用上一份签名应用恢复原界面。功能合入与创作者验收分别登记。
