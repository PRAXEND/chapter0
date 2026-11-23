# 技术科普 v8 的原版组件与本地合成

2026-11-24。独立 Mac 工作台本地分支 codex/standalone-mac-studio，起点 4598e2e。旧版的机智号工程包含两套相反旋转的多边形关键帧，成片中两片白桨的长轴几乎不动。同一起点复跑对照工程，改第二句和改入点产生相同预览，六个 JSX 层出现白色矩形，双源只显示一个全屏源。

## 编辑契约

- 六个 Henry JSX 源以 SHA-256 固定。编译构件和 WebKit 程序随 Mac 应用分发。工程以 motion.componentId、version、props、片段相对 cueFrames 和几何尺寸描述动效。静态参考图、既有样片 MP4、任意外部 JSX 均不能充当本地可执行组件。
- 用户和 Codex 在同一版本化时间线上编辑。studio_context 提供原版组件目录，studio_sequence 按当前素材与旁白创建图层，studio_component 支持按镜头偏移放置和局部修改。cueSource 允许初剪使用分镜动作或实际字幕入点。字幕对齐继承既有估算标记。三阶段路径使用三块独立文字和本镜动作帧，保持证据框与音效。
- 视频 viewport 使用左上角归一化的画布矩形，每路保留自己的 sourceIn、speed、fit、framing 和音量。图形 rotation 以几何中心为轴，正数顺时针，可跨多圈。拆分常规图形保留切点时的角度和位置。原版 JSX 用完整片段时钟，可直接移动组件、调整持续时间或单句入点。
- 工作台草稿、Codex 合成帧、正式 MP4 使用同一帧时钟。正式审片针对有组件、画面窗口或旋转的工程抽检最多 12 个图层时点，报告 revision、clipId、工程帧及局部误差。检查旋转轮廓时在已转动的形状内采样。两份有损视频的一致性仅覆盖对应像素区域。源帧、文字、方向和动效真实发生另有独立的成片回归。

## 复现

从独立视频仓库运行以下命令。两段输入分别是已有 Atlas 样片和 NASA 机智号实拍，输出使用新目录。脚本经工作台 HTTP 入口创建、导入、编辑、生成草稿、正式导出和解码检查，并保存可编辑工程及样本来源指纹。

```sh
node --test --test-concurrency=2 apps/studio/test/*.test.mjs
node apps/studio/scripts/test-webview.mjs /tmp/vstudio-motion-controls.png
node apps/studio/scripts/verify-motion-composition.mjs --atlas "$ATLAS_REFERENCE" --flight "$NASA_FLIGHT" --out "$NEW_PROOF_DIRECTORY"
```

## 实机记录

- 系统 WebView 已实际点击插入“三步跟随”、改第二句、拖动落点滑块和保存。独立读回工程确认变更。
- 真实 Codex 用独立四秒标尺工程将“读取刻度”改为“读出毫米值”，把第二句从 24 帧移到 40 帧。首尾落点为 0、60，底片锁定。回合完成并导出第 4 版，草稿和导出在 5、45、65 帧的组件区域均通过抽检。
- 旧机智号原工程重新导出第 655–913 帧，连续 259 帧。白桨从最终 MP4 测得上桨净转约 −244°、下桨净转约 +184°。沿用原工程的画面与音轨。
- 19 秒双视频验收片同时使用 Atlas 基准和 NASA 机智号录像，含六种 JSX。通过 13 项独立检查。第二句改字与单独后移分两次提交，第三句出场时刻保留。样片为静音技术演示，风格相似度和完整首剪的可发布程度仍需单独看片评价。

六个 JSX 均指定 Noto Sans SC。本机 CoreText 没有该字族。最终包内附上固定指纹的官方可变字体和 OFL 许可证，由 WebKit 内容进程直接装载。使用同一串中英文字符实测，原字体 400、900 字重、系统苹方与系统衬线的笔画指纹各不相同。已确认预览和导出的栅格缓存随字体版本失效。
