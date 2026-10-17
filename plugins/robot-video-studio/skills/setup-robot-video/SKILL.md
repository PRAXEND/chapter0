---
name: setup-robot-video
description: 配置 Robot Video Studio 机器人短视频工作流，检查 macOS 本地依赖与 ChatCut 连接，试听并保存中文音色和制作偏好。用于首次安装、环境诊断、修改默认音色或视频规格。
---

# 配置 Robot Video Studio

插件根目录是本技能目录的上两级；辅助命令为 `<plugin-root>/scripts/studio.py`。使用完整可用的 Python 3.10+，优先 Codex 捆绑运行时；不要将开发者电脑上的绝对路径写进配置或技能。

1. 读取已安装 ChatCut 的 `chatcut-plugin-basics` 技能，通过其 `list_projects` 验证连接。工具存在不等于已认证。不复制 OAuth，不重注册已有服务，不另启一个 ChatCut MCP。缺失时沿该技能的连接指引处理。
2. 执行 `studio.py doctor`。它只验证本地依赖，输出 `chatcut: requires_live_mcp_probe` 不代表连接失败。首次配置时执行 `studio.py bootstrap`，将固定版本下载器及其依赖装入用户独立虚拟环境。FFmpeg/ffprobe 或 JavaScript 运行时缺失时报告明确安装步骤，不静默修改系统。默认 Python 标准库损坏时切换 Codex 捆绑 Python。
3. 执行 `studio.py profile` 获取配置。已有确认音色时，从 ChatCut 实时目录重新解析，不重复要求选音色；失效的音色才重新选择。新用户读取 ChatCut `voice` 和 `widget-forms` 技能，调用 `manage_voice action=list voiceType=all language=zh locale=zh gender=male`，提供 2–4 个自然、明亮的男声音色试听。保留用户可用的已保存音色；遵循当前 ChatCut 试听表单约定。只保存实际提交的选择，不将默认选中或描述性偏好当作选择。
4. 用 JSON 文件作为 `studio.py profile --merge-file <path>` 的输入，保存 `voice`（`name`、`voiceId`、`provider`、`selected_by_user:true`；这些身份字段只用于内部工具调用）、风格和输出目录。运行时新查 `voiceRef`，不要持久化或分发临时引用。用户界面只显示音色名与声音特点。
5. 默认 1080×1920、30fps、目标 90 秒、60–120 秒；中文、明亮男声、有趣但克制；选题确认后完成整条流程。视觉参考由制作技能按素材选择并保存，不要求每期重选。

用户已经授权安装和配置时可直接执行；不要因重复读取下游技能而再次请求同一授权。配置完成后说明验证过的依赖和待处理事项；若还要制作视频，继续 `produce-robot-video`。
