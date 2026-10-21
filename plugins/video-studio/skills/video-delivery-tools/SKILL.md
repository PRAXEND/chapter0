---
name: video-delivery-tools
description: 导出和交付 Video Studio 的 ChatCut 项目、MP4、字幕及制作记录，查询导出任务状态并绑定最终文件。完整声画验收使用 video-quality-review。
---

# 导出与交付工具

加载当前 ChatCut export 技能，读取实际项目、素材 readiness 和导出能力。输出规格来自本期 brief；调用 submit_export 保存真实 renderId，查询 track_export 直到完成。排队不等于交付。云端回退等路径遵守已有授权和费用约定。

获取实际 MP4 和本期需要的 SRT，记录文件位置与 SHA-256，保留可编辑项目链接。完整质量验收调用独立 video-quality-review；以最终导出为对象，不能仅看编辑器预览。

运行 `studio.py audit --run <run> --video <mp4> [--subtitles <srt>]` 做文件/规格校验并汇总各项有效审核；退出2表示待复核，不应无限重试。脚本、格式与恢复见 [运行记录](../../references/operations.md)。

交付成片、需要的字幕、工程链接、脚本/分镜、来源清单和验收报告。缺少观看/听审等能力时仍可交付已完成文件，但明确未验证项，不把已导出等同于验收通过。修改后导出与重新验收都绑定新文件。
