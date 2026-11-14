# web.35 遗留问题与桌面会话阻塞复核

状态：web.38 实现与独立复核通过，已按用户指令合入发布分支；本次发行与升级记录见文末。历史阶段结论保留，不等于客户成片验收。负责人：当前主 Agent。日期：2026-11-15。

## 目标与边界

复核「优化剪辑流程与视频质量」对话末尾的 7 项问题，并分析客户截图中桌面会话等待领取 120 秒后失败的现象。基线为功能分支 `video-generation-workbench-feature` 的 `4722b78`（web.37），对照发布基线 `76aac51`（web.35）。开始时工作树干净。

本轮仅审查、隔离复现和记录。不修改插件实现、已制作视频、验收标准、用户项目、会话配置或运行锁；不发送真实制作任务、不调用付费生成、不重装或推送。测试使用真实模块、模拟桌面读接口和临时目录，不能作为真实客户机器故障复现或成片验收。

## 结论

原 7 项不能视为全部解决：6 项关键路径仍保留；配乐识别有 web.37 改进，但原 5 秒连续旁白复现仍失败。

| 问题 | 当前结果与证据 | 实现位置 |
| --- | --- | --- |
| 补齐原件后继续被当作创意修订 | 状态函数复现：`pendingExport + questions` 进入修订反馈；确认后清空当前 approval，使原候选失去当前批准绑定 | `studio-server.mjs:383`、`revisions.mjs:18,42` |
| 低音量配乐误拒 | 重跑原审查者的精确窗口：Atlas 旁白 4–9 秒、Wallpaper 16–21 秒，单声道 2 kHz，RMS 配比 −18 dB 返回 None；−14 dB 匹配 4 窗口。web.37 的真实无旁白窗口优先策略能改善有足够停顿的音频，但未覆盖该连续旁白窗口 | `scripts/review_music.py:184` |
| 关闭配乐却放过实际 BGM | 复现保留本项目已完成音乐操作、未静音轨和音乐资产，仅清空 music_tracks 就返回无错误 | `scripts/delivery_requirements.py:157` |
| 手动模式新克隆音色无法直接配音 | 静态复核：`/api/narration` 仍只从任务启动时的 select/savedVoice 取身份；录音分支没有将本轮克隆返回的稳定音色身份写入该请求的路径。已有手动录音测试在正式 TTS 前停止，不能覆盖此问题 | `studio-server.mjs:619` |
| 旧会话锁阻断新项目 | 模块复现：旧桌面轮次已 completed、旧 owner 锁仍在时，两次新任务均在 mkdir 锁处失败，未派发消息。启动恢复仍跳过历史项目，运行锁也没有独立于历史项目内容的核验/清理入口 | `desktop-agent.mjs:110`、`studio-server.mjs:737` |
| 历史素材预览/下载入口禁用 | 静态复核：只读模式禁用全部 stage-content 按钮（open-output 除外），包括预览按钮；后端 GET 媒体仍允许 | `public/app.js:181` |
| 保留原声并生成配乐的提示冲突 | 实际生成 produce 提示词同时出现 source means existing source audio only 和 generate_music=true 时必须生成纯音乐的要求 | `studio-workflow.mjs:143,151` |

## 客户截图与会话阻塞

截图事件为 queued → 120 秒无领取回执 → failed，ChatCut 调用为 0。它对应 `desktop-agent.mjs:74` 的未领取超时分支，而不是 EEXIST 旧锁分支。代码必须已取得本次运行锁才会显示 queued。因此不能把截图直接归因为旧锁，更不能认定是独立验收失败导致全局锁定。

对照测试确认：

- 普通未领取超时会撤销票据、释放锁；迟到的 claim 被拒绝，不会自动重复制作。
- 正常桌面制作完成时，先释放锁，再调用宿主 onFinish；独立 review 使用另一执行路径。质量失败暂停的是当前候选/项目，不是所有新项目。
- 旧锁确有永久保留路径，见上表；换桌面会话使用另一锁名，可以绕过这种状态，但不能修复原来的锁。
- **另一个已复现的阻塞点**：轮次查询只取最近 30 条，不跟随 nextCursor。已 claim 的任务若不在这页中，即使真实生命周期已完成，也不会读取其终态；超时和 cancel 都继续占用。复现保留了完成事件，观察器仍无限等待。应按绑定轮次查找/分页核验，不能仅凭超时强制释放可能仍在执行的任务。
- **派发诊断不足**：本机 `codex queue --help` 明确说明 `--resume` 失败仅警告、命令仍可能成功。工作台只保存 queueWarning 布尔值，不展示成功返回中的 stderr；异常也统一替换成笼统提示。模拟 resume 失败确认：用户仅见等待领取和超时，具体原因丢失。需记录脱敏后的实际警告，并区分已入队、已唤起、已领取和已执行。

客户机器没有提供对应 owner/ticket、队列 stderr 或桌面轮次记录，本轮没有读取该机器。新会话能跑只说明故障与原会话状态有关，不能在上述原因中唯一定位。建议修复时提供只读诊断摘要与安全恢复操作：先核实原任务终态、撤销旧票据，再清理运行锁；保留历史项目和远端任务信息，避免重复生成。

本机只读快照：4317 工作台为 web.37，activeJobId=null、busy=false、无 desktop-lock 目录，当前历史项目为 quality_failed；4318 未运行。已安装插件缓存仍为 web.35。当前本机不存在截图所示的活动阻塞状态。

## 验证与交接

本轮使用仓库现有模块，没有实现变更，未触发关键接口变更的同伴批准流程。

可复现证据位于忽略目录 `validation/web35-session-audit/`，无客户素材或私密日志：

- `repro.test.mjs` / `repro.log`：6 个针对性案例，含正常超时释放锁、旧锁、正常完成释放锁、分页遗漏后的占用、补证误入修订、提示词冲突。测试通过表示成功复现预期的现有行为，不表示缺陷已修复。
- `music-repro.py` / `music-repro.log`：原始音频窗口正反对照及关闭配乐漏报复现。全长混音的 −18 dB 可匹配 2 个窗口，原 5 秒窗口仍失败，证明结果依赖窗口，不能以全长成功代替原例回归。
- `baseline-node.log`：desktop / automatic / revisions 现有 34 项通过。
- `baseline-music.log`：现有配乐测试 17 项通过；包括无音乐不能通过和连续遮蔽保持未验证。

命令（在本仓库根目录运行；使用已验证的 Video Studio Python 和原生媒体工具）：

```sh
export PATH="/Users/chenjinghan/Library/Application Support/Video Studio/runtime/bin:/Users/chenjinghan/Library/Application Support/Video Studio/native-bin:/Users/chenjinghan/.nvm/versions/node/v24.14.0/bin:/usr/bin:/bin"
export VIDEO_STUDIO_PYTHON="/Users/chenjinghan/Library/Application Support/Video Studio/runtime/bin/python3"
export VIDEO_STUDIO_FFMPEG_DIR="/Users/chenjinghan/Library/Application Support/Video Studio/native-bin"
node --test validation/web35-session-audit/repro.test.mjs
python3 -B validation/web35-session-audit/music-repro.py
node --test plugins/video-studio/workbench/test/desktop.test.mjs plugins/video-studio/workbench/test/automatic.test.mjs plugins/video-studio/workbench/test/revisions.test.mjs
python3 -B -m unittest discover -s tests -p 'test_review_music.py' -v
```

下一步：以本报告作为修复范围，优先处理会话运行锁的终态核验和恢复、完整轮次定位及派发诊断，其次修复原清单其余问题。保留旧项目只读、现有竖版视觉与验收标准。状态/协议改动须经隔离同伴审查；修复后再做旧版退出升级、新项目启动、补原件继续及音频正反例回归。本轮未验证安装/升级、真实派发或完整成片交付。


## 第二轮：修复实施（用户已授权）

沿用本任务，开发基线 4722b78；开始时保留第一轮的两份未提交任务文档。现有扩展点足够，未更换制片框架。锁处理新增小型 Python 标准库 OS 互斥助手，因为文件所有者比较和 rm 本身无法跨进程原子化；其余沿用原任务、票据、音色回答和验收入口。

已实现全部 7 项及分页/派发诊断修复，保留 customer-portrait-v3 和原音频/独立验收阈值。关键路径采用隔离同伴审查。首轮审查发现并修复：领取先于撤销的竞态、不同编码/增益的共线旁白假 BGM、新修订被更早补证隐藏、缺轨定义绕过关闭配乐。手动音色准备的降级选择也保持原 plan/input 绑定。

当前验证：原 5 秒 −18 dB BGM 回归及错源/缺失/静音电平/错位/共线负例通过；真实 HTTP 桥接覆盖补证后重启继续（原批准和文件哈希不变）、手动克隆后宿主正式配音入口，以及旧历史项目只读与新项目自动恢复旧会话锁。后两项中的 Codex/ChatCut 为明确的协议替身，无真实生成费用。全量273项Python和199项Node已通过，无跳过；最后音频边界补充3项Python通过，派发脱敏增量1项Node通过。


### 最终交付验证与接手

- 隔离同伴（`layout_peer_review`）完成方案与最终交付复核：54项Node、9项Python独立通过，无剩余阻断；包含3项真实HTTP集成。额外5组共线素材复现（0.4/0.8/1/5秒，以及首尾各0.5秒静音）均拒绝假BGM，原−18dB正例仍通过。首轮发现的领取竞态和最终静音边界均补入回归。
- 插件ZIP和便携工作台ZIP均经逐文件SHA-256、空白私有状态、真实HTTP启动、版本/风格发现及请求保护验证。三类分发包已重建；未混入用户状态、私有备份或日志。发布清单覆盖全部跟踪文件，42个原音视频保持原字节。
- 确认4317原服务空闲且来自此功能分支后，从web.37重启到web.38。3个项目保留，项目/会话共5份JSON逐字节一致；`activeJobId=null`、`busy=false`。备份仅在忽略目录；已安装插件缓存仍是web.35，未替换。
- 真实Chrome复查：显示web.38，历史项目的“查看会话运行状态”返回“没有遗留的工作台运行锁”；旧素材预览可打开，视频实际加载至960×540、readyState=4、无媒体错误，下载与打开文件夹入口可用；写操作仍禁用，无浏览器控制台错误。未点击恢复或派发制作，未改历史验收结果。
- 本次不合并或推送。若要给客户使用，需要后续发布/安装web.38；客户仍运行web.35时不会自动获得这些修复。远端协议使用明确替身，本轮没有付费模型/ChatCut制作、真实客户机器复现或完整成片验收。

复现命令（沿用上文环境变量）：

```sh
python3 -B -m unittest discover -s tests -p 'test_*.py' -v
node --test plugins/video-studio/workbench/test/*.test.mjs
python3 -B -m unittest discover -s tests -p 'test_music_residual.py' -v
node --test --test-name-pattern='resume failure warning' plugins/video-studio/workbench/test/desktop.test.mjs
python3 -B tools/package.py
python3 -B tools/package_video_demo.py
# 解压对应ZIP到独立目录后，分别核验插件根目录和便携包根目录
node tools/verify_video_demo.mjs <解压目录>
python3 -B tools/verify_checkout.py --strict-tree
```

证据：`validation/web38-python.log`、`web38-node.log`、`web38-music-final.log`、`web38-plugin-verify.log`、`web38-portable-verify.log`、`web38-runtime-verify.json`及包清单。首轮测试中的VM依赖注入、重复测试变量和临时目录创建竞态已修正；未放宽断言。根目录企渡官网的上下文检查器不适用于本独立视频仓库，也未修改官网代码。


## 第三轮：web.38 发布与客户升级（2026-11-15）

用户明确授权合并发布分支、推送远端并更新安装包和升级说明。先核实远端 `video-generation-workbench` 为 `76aac51`，发布工作区干净；本地通过 `git merge --ff-only a4e3118` 保留全部已审查提交，再更新发行资料。未改仓库默认分支、官网代码、客户数据或本机插件缓存。

发布目标为 `PRAXEND/chapter0` 的 `video-generation-workbench` 分支和 `v0.3.0-web.38` 标签；标签指向包含发行资料与严格清单的最终发行提交，不只指向实现提交。公开交付入口为 [web.38 Release](https://github.com/PRAXEND/chapter0/releases/tag/v0.3.0-web.38)，以远端分支、标签和 Release 状态共同确认发布成功。附件为源码/插件/便携工作台三个 ZIP、INSTALL.md、UPGRADE.md 和统一 SHA256SUMS.txt；媒体仍通过完整 Git + LFS 获取，42个媒体字节不变。

客户入口：[UPGRADE.md](../../UPGRADE.md)。明确 Git 源码、Codex 安装副本、运行服务三个版本分别核对；便携 ZIP 有独立步骤，不执行缺失的 tools 脚本，并显式绑定包内 pluginRoot。回退使用隔离配置/工作台/输出目录，新建测试项目；备份中绝对路径不视为自动迁移。旧项目、音色和交付保留，旧验收结论不改变。

发行同伴在隔离工作树只读复核升级与打包增量，无阻断；便携入口与回退路径的两条意见已修复。主实现另经针对 a4e3118 的独立只读审查，无可确认的新缺陷。发布工作区274项Python、199项Node完整回归通过，无跳过；插件和便携包逐文件哈希及空白HTTP启动通过。最终包和远端下载校验结果保存在发布工作区忽略目录 validation/web38-release-*。发布检查不代替客户机器的账号连接或真实成片验收。
