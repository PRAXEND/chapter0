---
name: setup-video-studio
description: 检查 Video Studio 的本地依赖与 ChatCut 连接，保存用户明确的输出、音色与默认风格偏好。用于配置、诊断及旧版偏好迁移。
---

# 配置工具

插件根目录为本技能上两级。运行 `scripts/studio.py doctor`，只在需要下载功能时安装下载器：`bootstrap` 使用独立虚拟环境。系统 Python 损坏时用宿主可用的完整 Python 3.10+；不把开发机路径写入技能。macOS 为当前支持平台。

加载本机已安装 ChatCut 的 `chatcut-plugin-basics`，调用实际只读工具检查认证；本地 doctor 成功不能证明远端可用。声明依赖不等于连接成功。不重复建立另一个 ChatCut MCP。

`profile` 返回用户配置；`profile --merge-file <json>` 只更新指定字段。新安装没有默认题材或创作风格，不默认男声、语言、比例或目标时长。当前项目规格放在 brief；用户明确要求记住的偏好才存 profile。首次实际需要 TTS 时沿 ChatCut voice 技能试听具体音色，筛选条件来自用户。

风格库由 `styles list/show/add` 管理。用户要求设置默认风格时保存 `default_style:"id@version"`；清除用 null。个人库位于 Video Studio 状态目录，升级代码不覆盖。

旧版 Robot Video Studio 配置不自动导入：其 style/creative 和默认输出可能是旧模板而非用户决定。仅在迁移任务中读旧配置，将用户实际确认的 voice、输出目录等按当前要求逐项写入新 profile。旧 run 使用原版继续；不要将 schema_version 改数字冒充迁移。

环境变量：`VIDEO_STUDIO_HOME` 修改状态根；`VIDEO_STUDIO_FFMPEG_DIR` 指定 FFmpeg 目录。说明实际完成的检查和缺项；若已要求制片，继续 video-project。
