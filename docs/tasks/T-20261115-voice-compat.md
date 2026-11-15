# 工作台配音目录兼容修复

发行归属更新（2026-11-16）：累计修复纳入 web.39；发行验证与升级见 [VALIDATION](../../VALIDATION.md) 和 [UPGRADE](../../UPGRADE.md)，固定标签 `v0.3.0-web.39`。以下记录保留各阶段当时的状态，不以历史“未发布”描述覆盖本次发行归属。

状态：本地实现、独立复核及本机插件修复完成；尚未提交、合并或发布。负责人：当前主 Agent。日期：2026-11-15。

## 目标与边界

用户反馈 web.38 制作在正式配音前受阻。基线为已发布 c057229，隔离工作树 video-studio-voice-compat，分支 codex/web38-voice-compat。发布及功能工作树均保留原状态。本任务仅修复音色目录到正式配音的适配，不修改配方、验收标准、文案/方案、用户音色或已生成素材，不生成收费音频，不重新派发制作，不自动发布。

## 原因与实现

当前 ChatCut 自定义音色目录含 type/customVoiceId/voiceRef，而 narrationArguments 只用 provider/voiceId 匹配。真实目录只读核实已选音色 ready、available、支持 tts，正式配音尚未提交。

保持现有稳定音色结构不变：已选 custom/fish-audio 的 voiceId 必须与本次目录 customVoiceId 完全相等，拒绝类型/身份冲突和歧义。优先原样传本次 voiceRef，不持久化或解码；只有目录明确返回已选旧 pair 时回退。保留可用性、用途、控制项、宿主工程绑定和提交前 assertCurrent。调用失败不增加自动重试，也不重新选音色。

现有 narration.mjs 是唯一正式付费入口适配点，足以完成修复，无需新框架或数据迁移。同伴 voice_compat_review 已异步确认方案并完成最终只读审查，无阻断；独立重跑参数/RPC 测试 10/10，通过 git diff --check，并核对主 Agent 的 HTTP 回归结果。

## 验证与交接

验证完成：22 项针对回归全部通过，无跳过，包含参数正反例、RPC 协议替身和真实 HTTP /api/narration 新旧目录集成；末次增加 type/voiceType 互相冲突负例后 10 项参数/RPC 再次通过。HTTP 集成保留方案批准、录音隔离及稳定选择，断言仅一次提交且最终字段精确一致。只在临时目录生成测试音频，远端配音由明确替身接收，不调用真实付费工具。

真实账号通过与工作台相同的 AppServerConnection 查询目录、执行正式入口解析；在 assertCurrent 主动中断，开发版与安装副本均成功识别原已选音色，submit_voice 没有被调用。测试和提交前预检不等于真实配音或成片验收。

可复现命令（使用 Video Studio runtime/bin、native-bin 和 Node v24.14.0 的 PATH）：

```sh
node --test plugins/video-studio/workbench/test/narration.test.mjs plugins/video-studio/workbench/test/production-rules.test.mjs plugins/video-studio/workbench/test/voice-api.test.mjs plugins/video-studio/workbench/test/voices.test.mjs
git diff --check
```

本机修复：确认 4317 服务确为已安装 web.38 且空闲，备份后仅替换插件中的 narration.mjs 和 voice-selection.md，重启该服务，未修改版本号或远端发行内容。实际安装路径为 `~/.codex/plugins/cache/video-studio/video-studio/0.3.0-web.38`。原 run 的 76 个文件全部逐字节一致，音色与方案不变。首次严格状态字节比较发现 3 份索引/项目元数据变化，经逐字段核实为未改动的 startup 逻辑补登记 5 个已有来源：cacheStatus=saved、updatedAt 和素材库新增项；原素材库项保持不变。其余 83 份受保护文件逐字节一致，没有回写旧备份覆盖正常缓存登记。

证据仅保存在忽略目录：validation/voice-compat-tests.log、live-voice-preflight.json、local-fix-install.json 和私有 local-fix-backup。任务文档不含客户原始素材、音色 ID、访问令牌或私密日志。安装脚本在严格比较处停止的尝试已完成上述独立核验，不可直接重复运行覆盖备份。

恢复制作应复用原工程、已通过检查的文案分镜、5 个素材、粗剪和现有配乐；不重建项目、不重新生成配乐。工作台继续时使用新任务的正式 narrationEndpoint，不能重放已经结束任务的 token。受阻任务没有成片，未发生独立成片验收。

下一步：用户在原工作台项目点击“继续一键制作/继续一键生成”后，沿原授权恢复制作。当前修复仅在独立开发分支和本机安装副本；重新安装公开 web.38 会覆盖本机修复。对客户分发前应另行合并、更新发行版本和清单、构建安装包并发布，不能宣称既有 web.38 下载包已包含此修复。
