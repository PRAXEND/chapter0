# 本地记录与命令

使用当前完整 Python 3.10+；PLUGIN 是本次安装根目录，RUN 是实际 run 目录。命令参数使用路径字符串；JSON 从文件读取，不通过 shell 拼接用户文本。

## 配置和制作要求

`studio.py profile` 只读；`profile --merge-file <json>` 局部更新。默认状态为 ~/Library/Application Support/Video Studio；输出为 ~/Movies/Video Studio。VIDEO_STUDIO_HOME / VIDEO_STUDIO_FFMPEG_DIR 可覆盖路径。没有默认题材、语言、风格或视频输出比例。

本期 brief 示例仅说明数据格式，不是默认风格：

```json
{
  "topic": "用户本次的题材",
  "purpose": "本次目的与受众",
  "style": null,
  "style_overrides": {},
  "requirements": {
    "language": "zh-CN",
    "width": 1920, "height": 1080, "fps": 25,
    "target_seconds": 180, "min_seconds": 160, "max_seconds": 200,
    "narration": true, "captions": true, "audio_required": true,
    "max_video_sources": 8, "max_download_seconds": 600
  }
}
```

`new --title <标题> --brief <json> [--output-root <目录>]` 建立 run；`status --run <目录>` 读取。已建项目用 `record --kind brief --file <json> --run <目录>` 修改本期要求。未确定的 target/min/max 可为 null；尺寸/fps 和三个音频字幕布尔值在 brief 中必须确定。配置能力不代表 ChatCut 一定支持，创建时间线与导出时核对实时能力。

style 是 id@version 或 null；省略时使用用户保存的 default_style。覆盖规则用 rule id 到实际用户要求的映射。每次应用风格把 SKILL.md/style.json 与哈希固定到 run/style/id@version/，后续版本不会替换快照。

`production_preferences` 是可选对象，存放用户明确确认的讲述、配乐、交付和协作偏好；初始为空，不替代本期 brief。风格按钮与可选包导入见 [风格选择](style-selection.md)。`connection --file <本次观察json> [--run <已有schema2工程>]` 只写诊断附属文件，旧 schema1 继续使用原插件。

max_seconds 按视频流时长检查，保留 0.1 秒容差；视频流没有 duration 字段时才回退到容器时长。无效的视频流时长会报错。画面验收范围按同一视频时长计算，避免 AAC 音频尾部补齐扩大画面范围；配置一分钟不要求填满一分钟。

选择记录：`record --kind selection` 写入 {"topic":"与brief一致","confirmed_by_user":true}。用户明确委托选题时可用 {"topic":"选定题目","selection_basis":"delegated","authorized_by_user":true}，不要伪装成用户亲自挑选。

## 来源和分镜

所有 record 命令同样需要 --run、--kind、--file。

- project：实际 projectId、timelineId、editorUrl；可附 music_tracks、narration_tracks。
- material_plan：{"topic":"本期题材","style":null或"id@version","needs":[{"id":"n1","purpose":"画面用途","query":"题材词＋所需镜头","acceptance":"实际采用标准"}]}。
- source：id（ASCII短标识）、kind（video/image/audio/article/paper/script）、title、url 或 local_path、author、事件/发布日期、rights、claims、need_ids、topic_fit、style_fit。没有可靠许可信息保留 unknown。本地文件直接导入；fetch 只支持 URL 视频。
- beat：id、visual_anchor、source_ids、from_frame、to_frame；有事实用 claims；有旁白用 narration、audio_asset_id、audio_duration_seconds。音频时长是该段在最终时间线真实占用时长，不是未经剪切的原始长度。

同 id 替换会增加 revision 并使旧审核失效。下载来源的 URL 不可替换，应新建 source id。修改 brief 后重新评估素材计划。

## 下载和恢复

`probe --url <url>` 只读；`fetch --run <run> --source <id> --start <秒> --end <秒>` 有界下载。默认6源/300秒，可在 requirements 调整预算。预留和失败片段都计入预算，相同输入及哈希一致的完成文件可复用，不自动清空预算。

外部副作用前：`operation reserve --run <run> --key <稳定意图键> --file <输入json>`。仅 should_submit:true 新提交；reserved 是结果未知，先查询真实远端状态。返回 ID 后 `operation resolve --run ... --key ... --state submitted|completed|failed --file <结果json>`，结果需要实际 jobId/assetId/renderId/projectId/itemIds 或 observed_failure。终态不覆盖；这是宿主配合的去重协议，不是远端 exactly-once 保证。

## 本地交付目录

工作 run 继续保存制作数据；最终交付包由 Codex 按 [交付技能](../skills/video-delivery-tools/SKILL.md) 整理到本期输出根目录下的 `YYYY-MM-DD_选题/`，默认含完整 MP4、3:4 与 4:3 两张 PNG 封面、含发布标题/正文/话题标签的 TXT。`new` 不创建最终交付包，`audit` 不检查封面或 TXT。交付清单及文件哈希保存在工作 run 的 `delivery.json`；日期按用户本地时区确定，封面比例独立于视频规格。

## 验收

`audit --run <run> --video <mp4> [--subtitles <srt>]` 完整解码和规格校验；退出0全部满足，2待复核，1输入/工具错误。结果是 qa-report.json；不能把退出2当临时错误无限重试。

审阅用 record kind=review。字段：check、result(pass/fail/unverified；仅确实无BGM的music_fit可有证据地not_applicable)、evidence、artifact_sha256、reviewer、method、observations、evidence_files:[{path,sha256}]。pass 的证据文件必须存在且哈希一致。真实未听过/看过不能填写 pass。

完整检查项与方法见 [独立验收规范](quality-review.md)。画面、遮挡、剪切/转场、闪动及输出细节为所有作品必查；声音、字幕、事实和风格按实际适用。

除 facts 外，coverage_frames=[0,成片总帧数]。style_match 另需 style:"id@version"、rules:{规则id:{result:"pass"或"overridden",observations:"具体观察"}}；必须覆盖所有规则，overridden 必须对应 brief 的真实覆盖。审阅绑定 revision 和最终 MP4；改变内容、字幕或证据后重新核验。脚本检查记录一致性，不能认证感知能力或审美。

旧版 schema 1 不自动迁移；保留原插件与原工程继续，避免套用新规则覆盖旧数据。
