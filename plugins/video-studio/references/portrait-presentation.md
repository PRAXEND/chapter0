# 已确认的竖版效果：customer-portrait-v3

2026-11-15 用户确认 v3 试片的视觉效果，要求成为聊天与工作台所有竖版的默认。此要求不改个人风格、横版、方形或历史项目。旧版批准与审核保留，继续制作须按新契约重新绑定。视觉认可不追认旧音频/字幕未验证项。

唯一参数来自 `production-context.layout_contract`，Python `production_plan.layout` 与网页 `productionLayout` 使用同一契约。按 `s=画宽/1080` 缩放、以画布垂直中心 `c=画高/2` 定位：

| 部分 | 实施规则 |
|---|---|
| 素材 | x=0，y=c−304s，宽=画宽，高=608s，contain 完整居中；异比例源内黑边允许，不裁动作 |
| 标题 | x=54s，y=c−538s，宽972s、高222s；Noto Sans SC、92s、900、行高1.1、行间4s；底对齐并保留7.8s底内边距，单行不向上漂 |
| 配色 | 白色#FFFFFF，重点#F0FF00；`productionPlan.titleEmphasis` 必须是 `coverTitle` 的非空真子串；两封面同字同重点 |
| 字幕 | 普通白字54s/600/1.25，x=54s、top=c+321s、宽972s；单行容器高68s、双行135s |
| 背景 | #030405底，#9CA5AD灰线；6组120条、strength=.12、speed=1、四边220s绘制余量；全片最底层连续运动 |
| 结尾 | 最后1.8秒内，1.2秒全画面smoothstep渐隐，再0.6秒全黑；配乐在黑屏前结束并淡出1.4秒；旁白先结束 |

标题和字幕锚定固定素材容器，不能逐镜追随不同源比例而跳位。1080×1920的原生实测参考为标题字底至画面约22px、字幕字顶至画面约27–28px；这是字形观察，不是把字形框误当编辑器容器。native字幕实际垂直居中，必须按行数切换68/135容器高度，保持相同top；不要把双行高容器用于单行，或只写`verticalAlign=top`就声称已实现。关闭字幕只省字幕，不移其他层。

## 制作时使用确定性配方

读取当前 ChatCut MG 技能和实时schema，确认字体可用。单/双行标题字底保持一致；每行禁止自动二次折行。过长时在方案阶段精简或明确换行，不能暗中缩字号。计划先确定 `coverTitle`、`titleEmphasis`、每镜 `titleText`（一至两行、仅换行可异）和 `titleStyle`。调用：

```sh
python3 scripts/portrait_design.py --plan <已确认方案.json> --width 1080 --height 1920 --fps 30 --frames <最终总帧数> --captions on
```

返回三组 **inline tool payload**、相应放置参数、单/双行字幕布局及准确收尾帧号。通过正式 `create_motion_graphic_from_code` 提交，不本地渲染主片、不把JSON当已建好的资产。使用真实返回的assetId再放置；背景在最底层，收尾遮罩必须高于字幕和所有画面。保留文本、颜色、密度与速度可编辑。SVG形状不随帧改写，只让组的CSS变换随frame/fps变化；不要替换成静态纹理或每镜重启动效。

结尾预算在选材/分镜阶段预留，不能使总片长超出用户范围，不能冻尾/循环/造空白凑时长。素材在渐隐期间仍是连续真实动作。标题全程显示的唯一默认例外是已规定的统一渐隐及黑屏。音乐关闭时不创建音乐淡出；有配乐则使用真实末段音轨。

## 导出前检查与证据

1. 用当前编辑器合成帧检查开头、中段、末段；有单/双行字幕时分别看字顶；检查背景覆盖四边且连续移动、低对比、不遮挡；检查渐隐前、中、全黑及最后一帧。参数正确不代表画面正确。
2. 全量读回时间线和字幕卡。`review-evidence.json.presentation` 保存 `background`、`ending` 两项，每项为 `{item_id,asset_id,asset_revision,effective_properties,readback_files:[{path,sha256}]}`，记录的item_id/asset_id使用完整时间线中的完整UUID；原始读回内工具短ID保留。由实际 `inspect_asset(includeCode:true)` JSON与 `inspect_item` 原始文本返回归一化。检查器核对真实源码、revision、实例ID/几何/时间及有效参数，不接受无关文件配上手填声明。effective_properties包括背景bgColor/lineColor/lineCount/strength/speed/transparentBackground，或结尾fadeFrames/color。原始读回文件保留在本run；asset JSON只保留未改写的 `{asset:...}`，剔除临时handoff、令牌或编辑器跳转信息。
3. 每个有旁白的beat保存 `narration_item_ids`（包括跨该镜边界的所有实际语音片段）、`audio_asset_id` 或 `audio_asset_ids`，`audio_duration_seconds` 为这些片段与本镜交集的并集时长。动作留白不是发声，不能用镜头时长伪填。源窗口/速率/最终混音仍独立核对。若需调整整体语速，先按 [最终速度旁白](final-speed-narration.md) 准备可复验新音频与真实新转录，以rate=1剪辑，避免渲染器实时变速导致波形身份无法验证。
4. 通过 `web_bridge.py check-presentation --file <含run的请求.json>` 检查布局图层/收尾/语音占用，再运行原 `review_sync.py` 检查真实词时间、Cards和SRT；200ms同步容差不变。出现ASR与正确字幕差异时保留原ASR，不用伪造词时间或默许差异过审；先核实实际声音并按当前工具修正真实源转录，重新读回。字幕尾部按实际词尾结束，不用卡片默认长度拖尾。
5. 修复这些制作阶段问题后，才提交完整候选到已有独立验收。客观检测和源码哈希不能替代审阅；仍不通过时按原规则保留临时包并暂停，不自动继续改片。

## 独立验收

必须查看本候选全部联系表与必要原尺寸帧。`portrait_layout.presentationObservations` 分别返回spacing、title_color、background；`transitions`返回ending。每项 `{feature,frames,observations}` 记录实际帧号与观察。背景至少比较两个时点；结尾须含渐隐中段、黑屏保留段和最后一帧；预检会把这些位置加入抽帧。`output_details.titleObservations` 在原有role/path/text外增加实际黄色重点`emphasisText`，三文件均逐字查看。缺少任一必要观察或真实证据时，不得登记通过。

这套配方与前置检查减少可避免的返工，不承诺任意事实、素材、语音或外部工具结果必然一次验收通过。
