# 机器人热点资讯：YouTube 素材采集

适用于用户要求近期机器人、具身智能热点的候选视频或素材采集。它规定来源路径，不规定视频表现风格；继续读取本期 brief 与风格快照。仅要求候选时止于清单，要求下载或制作时继续授权范围内的获取。

## 1. 时间窗口与采集计划

按用户时区把“最近一周”等要求转换为明确起止日期，记录日期窗口口径；默认最近一周为含今天的七个自然日，不固定为某个历史日期。分别记录事件发生时间、官方公告时间和视频上传时间。旧视频可标为背景素材，不混入本周新发布清单。

在已有 run 中先保存 `material_plan`，按具体事件/型号列出 needs、query、purpose、acceptance；没有 run 时按运行记录规范建立采集记录。单纯采集测试所需的尺寸等必填参数应注明为测试假设，不冒充用户已确定的成片规格。已有本地/项目素材先查缺口。

## 2. 搜索入口和顺序

使用宿主实际可用的联网搜索工具。此插件没有独立 YouTube 搜索 API；不要声称 `studio.py` 本身能按关键词搜索视频。

1. 优先搜索官方消息及其原始视频，例如组合 `site:youtube.com/watch 公司名 型号 事件关键词`，并使用搜索工具的日期过滤或 `after:YYYY-MM-DD before:YYYY-MM-DD` 提示。搜索日期过滤只是发现线索，最终仍需核对上传日期。
2. 初始关注入口可用：宇树 `https://www.unitree.com/news/`、Boston Dynamics `https://bostondynamics.com/videos/`、Figure `https://www.figure.ai/news`、Agility `https://www.agilityrobotics.com/latest-press`、Google DeepMind `https://deepmind.google/research/`。按本期事件扩展 NVIDIA、其他企业及研究团队，入口失效时重新发现，不猜频道 ID。
3. 严格日期查询无结果时，改用近期事件名称或公司公告检索。行业媒体、新闻聚合页可帮助发现事件及嵌入的 YouTube 链接；回到原始视频和官方公告核对，不将聚合页的日期、播放量或“官方”标签当成已确认事实。
4. 从实际发现的 `youtube.com/embed/<id>` 或 `youtu.be/<id>` 链接提取视频 ID，可规范化为 `https://www.youtube.com/watch?v=<id>`；不得编造 ID。优先单个视频，不把播放列表或直播作为下载输入。

## 3. 核实原始来源与媒体信息

官方身份优先由公司官网指向的频道/视频链接，或官方公告与视频之间的关联确认。频道显示名称和头像不足以单独证明身份；证据不足就标记“官方身份待核实”。新闻事实回溯公告、论文或原始演示，保留来源，不能把宣传片中的能力表述当独立测试结论。

对入选链接运行（`PLUGIN` 为本次实际插件根目录）：

```sh
python3 "$PLUGIN/scripts/studio.py" probe --url 'https://www.youtube.com/watch?v=<已发现的视频ID>'
```

读取实际返回的 title、uploader/channel、upload_date、timestamp、duration、availability、license。只有日期且无时区时保留日期原值；边界不确定就注明，不能精确化为虚构的本地发布时间。网页读取限流时，可以继续尝试一次正常的 `probe`；网页失败不等于媒体不可获取。

登记 `source`：稳定 id、video 类型、原始 URL、标题、作者、上传/事件日期、核实依据、need_ids、topic_fit、style_fit 和 rights。`license:null` 或没有明确再使用说明时，rights 保留 `unknown`；公开视频、官方发布、下载成功均不代表转载授权。

候选清单至少显示标题/链接、频道、日期、时长、新闻用途和核实/授权状态。没有播放时明确“元数据初筛，未验画面”，不编造动作描述、精确可用片段或同期声质量。

## 4. 下载选定区间

确保 run 已保存 brief、真实 topic selection 和 video source，再调用：

```sh
python3 "$PLUGIN/scripts/studio.py" fetch --run "$RUN" --source '<已登记source-id>' --start 5 --end 10
```

5–10 秒仅是小样测试示例，正式选材应根据实际观看确定源区间，且不得超出 `probe` 返回的时长。由 `fetch` 调用现有 yt-dlp 和 FFmpeg 下载片段、生成 MP4、检查时长并记录哈希；无需另写一套下载器。测试下载与正式发布授权分别记录。

失败时保存原始错误和阶段，检查是否已有文件/下载记录，避免重复获取。登录、地区或平台限制不通过读取浏览器 cookies、绕过访问限制或循环重试解决；选择其他可用官方候选或报告具体阻塞。没有成功文件就不报告下载完成。

## 5. 检查与交付

检查 `fetch` 返回的真实路径、actual_seconds、sha256，并用 ffprobe 读取实际编码、尺寸、帧率和音轨。对短测试片段可用 FFmpeg 完整解码检查；抽帧核对可见主体，选作正式素材时还需连续观看并按需听审。解码成功不等于声画质量或内容事实已经验收。

记录原片 start/end 与本地 0 秒的对应关系、检查结果及未验证项。交付候选清单、可打开的本地片段和采集记录。仅完成搜索/下载，不宣称 ChatCut 导入、剪辑、导出也已验证。

2026-10-25 的实测已跑通宿主搜索 → 原始 YouTube 链接 → `probe` → `fetch` → 完整解码及代表帧检查；一个 5 秒片段返回 1080p/50fps、H.264/AAC。该记录证明当次路径可用，不保证所有视频持续可下载，也不证明所有候选频道身份或再使用许可已核实。
