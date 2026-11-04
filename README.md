# Video Studio · Video Generation Workbench

**0.3.0-web.34 · macOS · 分支 `video-generation-workbench`**

输入主题方向、时长范围、横/竖画幅、风格和音色，由同一主会话完成选材、文案、动效与可编辑剪辑；独立验收通过后正式交付。工作台使用专用 Codex 桌面会话控制 hosted ChatCut 网页工程。

完整安装与使用流程见 **[INSTALL.md：从 git pull 到交付视频](INSTALL.md)**，包括首次下载、依赖、Git LFS、插件安装、账户连接、完全访问与浏览器授权、制作、修订确认、验收、文件下载及更新。

```sh
git fetch origin
git switch video-generation-workbench
git pull --ff-only origin video-generation-workbench
git lfs install --local
git lfs pull --include='user-packs/henry-video-styles/media/**' --exclude=''
python3 tools/verify_checkout.py
```

首次使用请按 INSTALL.md 完成环境与插件安装后启动；上面的校验只证明发行文件完整，不证明账号连接或制作权限已配置。

## 本分支范围

| 内容 | 位置 |
|---|---|
| 插件 marketplace | `.agents/plugins/marketplace.json` |
| 当前插件、技能、网页、制片与验收工具 | `plugins/video-studio/` |
| 风格规范、参考试片、复现素材、MG、字幕、来源与校验 | `user-packs/`，其中 Henry 包含 42 个 LFS 音视频文件 |
| 完整教程与发行范围 | [INSTALL.md](INSTALL.md)、[RELEASE_SCOPE.md](RELEASE_SCOPE.md) |
| 发行文件哈希 | `release-manifest.json`、`tools/verify_checkout.py` |
| 安装后启动助手 | `tools/run_workbench.py` |
| 开发验证与构建 | `tests/`、`plugins/video-studio/workbench/test/`、`tools/` |
| 旧启动路径的薄兼容入口 | `sites/video-agent-demo/`，仅 4 个文本文件，无网站成品或运行数据 |

不包含私人项目、克隆参考录音、登录凭据、账号配置、桌面会话 ID、素材缓存、私人交付视频、验证日志、旧安装包或官网代码。本分支从远端 `video-generation` 建立，按文件范围迁入当前实现，没有合并开发分支中的私人项目提交。

## 制作与交付

- 默认 60–70 秒、开启字幕；按风格决定配乐，手动覆盖优先。
- 配置与已保存音色选择不启动模型，点击一键才开始；克隆需要自己的授权录音。
- 风格下拉框展示可用风格；完整媒体下载后可使用 `henry-hot-news@8` 和 `henry-technical-explainer@8`。
- 主体裁切、遮挡与字幕时序在制作阶段检查。验收保留全片抽帧、加密边界、原尺寸疑点、试片对照和客观音频标准；固定程序整理证据与报告。
- “修订与补充反馈”预填 AI 建议，可编辑、保存或确认替换后继续，沿用原工程；保存反馈不调用模型。
- 验收失败暂停并保留实际临时文件和 ZIP，由用户确认修订或停止。缺项明确显示，不能冒充完整或合格。
- 正式交付包括 MP4、3:4 竖版封面、4:3 横版封面和发布文案 TXT，启用字幕时包含 SRT；不自动发布。

新电脑需要自己的 Codex、ChatCut、浏览器授权与额度。仓库不分发系统程序、商业字体或账号状态；字体和编辑器效果由目标环境提供，详情见 INSTALL.md。风格媒体来源与署名保留在包内。

具体制片规则见[连续制作](plugins/video-studio/references/continuous-production.md)、[制片与验收约定](plugins/video-studio/references/production-policy.md)和[验收方法](plugins/video-studio/references/quality-review.md)。发行验证范围见 [VALIDATION.md](VALIDATION.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。
