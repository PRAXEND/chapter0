# video-generation-workbench 发布范围

本分支发行 Video Studio `0.3.0-web.34`。基于远端 `video-generation`，按清单迁入当前实现，不携带开发分支的私人项目提交。原开发工作区保留，不合并官网或其他项目。

包含当前插件完整代码、marketplace、技能、公开风格文本包、源码风格包、42 个 Git LFS 媒体、参考试片、复现代码/时间线/字幕、校验清单、安装教程、测试和构建工具。`sites/video-agent-demo` 只保留兼容已有启动入口的 4 个文本文件。

不包含 `.video-studio*` 项目记录、`validation/` 本机日志、`.runtime/` 安装状态、`.data/` 缓存、`deliverables/` 私人成片、环境变量文件、账号/密钥、克隆参考录音、下载缓存、作者的系统依赖或临时手机隧道。旧版 dist ZIP 已从此分支工作树移除；历史已公开版本不改写。

`release-manifest.json` 列出本次发行的文件、大小和实际内容 SHA-256（媒体是 LFS 下载后的内容哈希），不包含清单自身。`tools/verify_checkout.py --strict-tree` 校验文件内容、媒体完整性和 Git 跟踪范围。

媒体范围为风格包资源清单中的真实参考/复现文件，不包含用户私人项目素材或每个新选题尚未采集的画面。七种其他公开文本风格没有在本分支声称提供本地参考片。系统程序、账户服务、字体许可和编辑器内置资源按 INSTALL.md 配置。
