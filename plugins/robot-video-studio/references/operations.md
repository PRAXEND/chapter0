# 本地命令与运行记录

所有示例的 `PYTHON`、`PLUGIN`、`RUN` 都由当前环境解析；执行命令时正确引用含空格路径。脚本不直接调用 ChatCut，不保存 OAuth，不模拟远端状态。

## 安装检查与配置

```sh
"$PYTHON" "$PLUGIN/scripts/studio.py" doctor
"$PYTHON" "$PLUGIN/scripts/studio.py" bootstrap
"$PYTHON" "$PLUGIN/scripts/studio.py" profile
"$PYTHON" "$PLUGIN/scripts/studio.py" profile --merge-file /absolute/path/preferences.json
```

默认状态目录 `~/Library/Application Support/Robot Video Studio`，可用 `ROBOT_VIDEO_STUDIO_HOME` 指定测试目录。生成物默认 `~/Movies/Robot Video Studio`。`doctor` 非零退出可表示依赖尚未安装；`chatcut: requires_live_mcp_probe` 必须由宿主执行 `list_projects` 补充验证。不要将本地结果伪装成远端连通测试。

配置 patch 示例：

```json
{"target_seconds":90,"output_root":"/absolute/output/directory","voice":{"name":"实际选择的音色名","provider":"从实时目录返回","voiceId":"从实时目录返回","selected_by_user":true}}
```

`voiceRef` 应在每次调用时由实时目录获取；不要求用户填写内部 provider/voiceId。

## 新建与记录

```sh
"$PYTHON" "$PLUGIN/scripts/studio.py" new --title '机器人样片'
"$PYTHON" "$PLUGIN/scripts/studio.py" status --run "$RUN"
"$PYTHON" "$PLUGIN/scripts/studio.py" record --run "$RUN" --kind selection --file /absolute/selection.json
```

`record --kind` 接受单个 JSON 对象；同 id 来源/分镜为替换，不是追加。编辑后增加 revision 并使旧验收失效。不要在最终验收后无故修改来源或分镜。

selection：`{"topic":"用户选定的标题","confirmed_by_user":true,"mode":"single"}`。只有真实用户选择才能写 true。

project：`{"projectId":"工具返回","timelineId":"工具返回","editorUrl":"工具返回"}`。

有 BGM 时另写 `music_tracks:["实际配乐轨道别名或ID"]`，可写 `evidence_directory:"保存最新证据的目录"`；该目录必须包含 `live-evidence.json`，相对路径按 run 目录解析。证据内也要明确 music_tracks/narration_tracks，并保存完整时间线与源 ASR。不能依靠轨道名字猜哪些是配乐，结构见 [停顿处配乐检查](music-pauses.md)。在最终审阅前完成这些记录。

source：

```json
{"id":"s1","kind":"video","title":"原始标题","url":"https://example.org/actual-video","author":"原作者","event_date":"YYYY-MM-DD","published_at":"来源实际日期","retrieved_at":"ISO时间","rights":"unknown","claims":["这个来源能支持的事实"],"notes":"遥操作/仿真/历史画面等限制"}
```

beat（最终阶段必须填写真实时长、帧位置及配音 asset）：

```json
{"id":"b1","narration":"最终旁白","source_ids":["s1"],"visual_anchor":"说到抓握时，画面展示夹住物体的接触点","source_ranges":[{"source_id":"s1","start":12,"end":25}],"claim_type":"observed_or_attributed","audio_asset_id":"工具返回","audio_duration_seconds":12.4,"from_frame":0,"to_frame":372}
```

同段可包含多个画面，但时间范围覆盖其完整旁白。声音生成前允许 draft beat 缺少实际时序；验收时不允许估算值冒充实测。压缩停顿后，`audio_duration_seconds` 记录最终时间线该段的实际占用时长；原始源文件时长另存 `original_audio_duration_seconds`，并在 `audio_items` 保留每个片段 ID、源窗口和帧位置，不能把原始源文件长度继续当作成片段长。

## 有界下载

```sh
"$PYTHON" "$PLUGIN/scripts/studio.py" probe --url 'https://actual-source-url'
"$PYTHON" "$PLUGIN/scripts/studio.py" fetch --run "$RUN" --source s1 --start 12 --end 25
```

脚本会锁定 run，保存 URL 与区间摘要、预留时长后调用下载器。相同输入与校验一致的文件复用；崩溃后发现已完成文件则先探测。失败也保留已预留时长与状态，避免重复尝试扩大预算。不同区间总量最多 300 秒。若是废弃来源，需要人工核实后修改该 run 的预算记录；不要偷偷清空预算继续抓取。

脚本不会导入 ChatCut。取得独立源片段后，加载已安装的 `asset-import`，调用其 loopback/import helper，并保存真实 assetId。片段内 0 秒对应原片 start；这个偏移必须保存在分镜中。

## 外部副作用的恢复

每次导入、TTS、时间线批量改动和导出前，创建一个稳定 intent key，如 `voice:b1:r1`，输入 JSON 包含最终文本、已选音色和语速，不能包含 OAuth/token。

```sh
"$PYTHON" "$PLUGIN/scripts/studio.py" operation reserve --run "$RUN" --key voice:b1:r1 --file /absolute/intent.json
```

仅当结果 `should_submit:true` 才新提交一次。已有任何状态都返回 false：reserved 表示结果未知，submitted 表示正在处理，completed 复用，failed 需先诊断再明确创建新尝试 key。该机制是宿主配合的防重复协议，不能保证网络远端 exactly-once。

调用 ChatCut 得到 ID 后立即写入：

```sh
"$PYTHON" "$PLUGIN/scripts/studio.py" operation resolve --run "$RUN" --key voice:b1:r1 --state submitted --file /absolute/result.json
```

result 示例：`{"jobId":"返回的jobId","assetId":"返回的assetId"}`。完成后用 `--state completed` 再保存终态。外部调用超时且 ID 丢失时，先 browse_assets/track_progress/track_export 核实，按名称、内容、创建时间匹配；不凭“未看到返回”判定失败。确认失败用 `observed_failure` 保存事实。完成/失败终态不可覆写。

## 检查与完成

`audit --run "$RUN" --video /absolute/final.mp4 --subtitles /absolute/final.srt --evidence /absolute/final-evidence.json` 完整解码并验证规格、SRT、分镜和审核状态，生成 qa-report.json。有配乐时自动扫描旁白停顿，另保存 music-pause-check.json；省略 --evidence 时读取 project.evidence_directory/live-evidence.json。首次缺少人工/模型审核或有配乐候选时退出 2 正常，不能当工具故障反复重跑。

自动音乐检查绑定视频哈希、证据哈希与 run revision；发现候选或缺少证据会添加 music_pause_levels 待复核项，不允许通过手写 review 覆盖。该项不属于下方人工/模型 review 的五个 key，执行 audit 重新测量即可更新。修改旁白停顿、配乐、混音或任何成片字节后，用新导出和最新证据重新检查；自动检查通过也不代表 audio_listening 通过。

局部字幕/音频/短镜头诊断另用 `review_sync.py`，证据格式与完整流程见 [修复方法](repairs.md)。原片场景检测和全音轨响度扫描是只读检查，不是本地替代 ChatCut 剪辑。保留原始导出 SRT；若独立 SRT 断行把“机器人”拆开而画面正常，可仅调整换行并验证所有时间戳与去换行后的原文字节不变，再重新绑定字幕文件哈希。不得借排版名义改字幕时间。

审阅实际文件后，逐项 `record --kind review --file ...`：

```json
{"check":"caption_sync","result":"pass","artifact_sha256":"audit返回的64位值","subtitle_sha256":"audit返回的64位值","evidence":"检查了全部字幕边界；b1第一个词与字幕起点相差0.10秒，最大观察偏差0.17秒"}
```

check 取 facts/composed_visuals/audio_listening/caption_sync/semantic_sync。result 取 pass/fail/unverified；证据必须为真实检查，不复制上方示例。不支持试听时填 unverified。检查内容或文件变化后重新检查。最后再运行一次 audit；只有全部有证据的审核有效且技术检查通过，status 才为 completed。
