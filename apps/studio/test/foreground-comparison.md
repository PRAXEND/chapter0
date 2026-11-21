# 比较工作台与实际 Codex 桌面聊天的成片

每组对照使用同一份书面需求、原始媒体、音色、风格版本和剪辑规格。在两边制作前，登记输入文件 SHA-256、素材许可、模型、推理档、分辨率、帧率及声音设置。在任务结束后再随机分配播放顺序。

1. 从工作台的工程包取得原始素材和参考片。保留工程版本、选区及素材清单。口播配对使用同一份授权录音，混剪配对使用同一组素材和脚本，选题配对固定核实过的来源与截止日期。
2. 在通常用来剪视频的 Codex Desktop 聊天窗口提交同一份需求和附件，指定已登记的模型与推理档。保留实际的桌面导出 MP4 和聊天链接。记录中途人工提示、补充素材、权限、手动操作和返工次数，并注明制作引擎。如两边使用不同的渲染器，这组测的是完整工作流差异。
3. 在独立工作台创建对应工程，从“一键制作”获得原始 MP4。保存工程快照、运行记录及导出文件的 SHA-256。这一份的执行来源登记为 Codex App Server。仅比较短场景导演文案时标明样本是短场景，并另存实际生成的两份短片。
4. 在工作台导入桌面聊天交付的原始 MP4 为本地视频素材。盲评页新建“前台与工作台配对”，将工作台输出任务与这份原始素材配对。API 可用 `primary: "workbench"`、`projectId/jobId` 和 `comparisonProjectId/comparisonAssetId`。用 `conditions` 记下 `model`、`effort`、`promptHash`、`imageHash`、`inputHash`、`notes`。原文件可直接核验 SHA-256。
5. 请两位实际审片人分别按正常速度带声音播放。记录愿意直接采用哪一版、时间点、事实表达、镜头选择、声画落点，以及需要怎样的小修或重剪；交卷后再揭盲。两份结果、机器自动检查和技术来源分别保留。

可复用的两镜头协议样例使用纯蓝和纯黄色卡，中文旁白为“先看蓝色卡片。然后切换到黄色卡片。”，640 × 360、24 fps。第一遍验证实际剪切、录音、字幕和正常速度播放。第二遍锁定第一条画面，再要求“只改第一条字幕为‘请先看蓝色。’，保留旁白和画面”。这组测持久会话和局部改稿。首发创作质量评估另外使用选题、脚本和访谈的真实素材。

## 54 秒 Artemis I 整片首版

两位导演分别从三条真实 NASA 原片的十个窗口里选六个，自己决定顺序、切点、逐段中文旁白、重点字和落帧。两端读完全相同的任务书和 30 帧源片拼图。任务书、源哈希、像素、时钟、转录以外的声音设置与模型推理档均已登记。六段合计 54 秒，第一次满足协议的完整输出即封存。主持人事先固定素材选题、事实范围、macOS Tingting 音色与本地渲染器。

在应用根目录执行下列命令。prepare 会复用已下载的三条原片，缺少时从固定的 NASA 媒体直链取得，并逐一核对 SHA-256。先由实际前台 Codex 接收 `research-plan/full-cut/packet/brief.txt` 和同目录的 `source-sheet.jpg`，将它独立返回的原始 JSON 存为 `research-plan/full-cut/foreground-first.json`。另一端通过真实 App Server 打开同一份附图。两端看片取舍均封存后，其余步骤只执行机械编排、合成与入库。

```sh
node scripts/build-full-cut-pair.mjs "$STUDY_LIBRARY" prepare
node scripts/build-full-cut-pair.mjs "$STUDY_LIBRARY" background
node scripts/build-full-cut-pair.mjs "$STUDY_LIBRARY" render-foreground
node scripts/build-full-cut-pair.mjs "$STUDY_LIBRARY" render-workbench
node scripts/build-full-cut-pair.mjs "$STUDY_LIBRARY" register
```

每端保留首版原文、MP4、SRT、便携工程、机器检查、原始输入与成片 SHA-256。分数与返工量由真实审片人在配对页面独立给出。这一组衡量相同制作条件下的整片导演决定；从搜索选题开始的端到端耗时应另行实测。
