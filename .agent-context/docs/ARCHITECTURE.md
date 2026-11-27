# 工作台架构与编辑链路

最常用的一条链路是「选中片段 → 提交修改 → 看当前版本 → 导出」。界面、后台导演和渲染器围绕同一份按帧计时的工程工作。

| 从哪里开始 | 请求怎样向下走 | 维护时应验证什么 |
|---|---|---|
| 打开 Mac 应用 | Tauri 启动随包 Node 服务，通过标准输出读取一次性本机入口，在系统 WebView 打开。Node 只监听回环地址，校验来源和会话。 | 壳、Node 资源路径、首次打开与关闭重启。入口 URL 含本机临时令牌，交接时仅记录响应状态。[原生壳](../../apps/studio/src-tauri/src/main.rs) · [HTTP 服务](../../apps/studio/src/server.mjs) |
| 用户拖拽或输入修改 | 页面读取工程和选区，控件状态管理草稿与并发请求。时间线手势或检查器提交带起始修订号的编辑命令。 | 切工程时的慢响应、锁项、撤销、源片入点与曲线。过期版本会得到 409，应先重读工程并保留本地草稿。[页面](../../apps/studio/www/app.js) · [时间线](../../apps/studio/www/timeline.js) · [控件状态](../../apps/studio/www/control-state.js) |
| 保存工程 | HTTP 路由与导演工具将命令送进工程存储。SQLite 保存工程修订、历史和任务，素材和输出由工程目录保存。剪切与变速按同一源片时钟处理。 | 并发写、重试、锁、撤销和便携工程重新导入。[工程存储](../../apps/studio/src/project.mjs) · [片段编辑](../../apps/studio/src/clip-edit.mjs) · [源片时钟](../../apps/studio/www/clip-automation.js) |
| Codex 制作及续作 | 工程任务入队，导演经 App Server 建立或恢复工程会话，调用受范围限制的编辑和观察工具。账号连接、工程媒体和后台会话目录分别管理。 | 锁与版本也约束导演。转录和帧由工程分别授权，付费请求回执未知时先核对。涉及真实模型、第三方或原媒体的测试注明环境与费用。[制作队列](../../apps/studio/src/jobs.mjs) · [导演](../../apps/studio/src/production.mjs) · [会话](../../apps/studio/src/codex.mjs) · [配乐回执](../../apps/studio/src/music.mjs) |
| 选择风格与合成 | 正式选项来自双 v8 目录。风格读取器校验规格与素材，JSX 动效经本机 WebKit 渲染，音视频在本机组合。 | 改风格同时检查选项、指纹、原版组件、基准片与原配乐。动效须看真实画面及落点。[风格目录](../../apps/studio/src/style-catalog.mjs) · [风格读取](../../apps/studio/src/style.mjs) · [媒体实现与验证](../../apps/studio/MEDIA.md) |
| 预览、导出、复核 | 播放器按修订取得对应的冻结文件、帧或播放窗口。导出任务绑定快照并记录视频、字幕与工程。独立验收依据冻结版本回看。 | 比对同一修订和帧号，核对 MP4、SRT、可编辑工程。听感与风格是否适用需要看片人确认。[播放](../../apps/studio/src/timeline-playback.mjs) · [渲染](../../apps/studio/src/media.mjs) · [验收](../../apps/studio/src/review.mjs) · [独立复核](../../apps/studio/src/independent-review.mjs) |

GitHub 素材库的目录、LFS 媒体与发行下载仅对列出的公开主机启用代理。每跳先校验 HTTPS、端口与 DNS 公网地址，再依次处理环境例外、显式 HTTPS 代理和 macOS 系统路由。系统指定直连时，Node 固定已校验的地址；系统代理请求由随包 URLSession 工具执行，重定向交回同一入口复查。所有成功下载仍需通过流大小、清单指纹和本地媒体探测才能写入工程。[下载入口](../../apps/studio/src/sources.mjs) · [系统代理选择](../../apps/studio/src/github-media.mjs)

素材导入和受控文件流仍复用同一仓库的 [workbench 媒体模块](../../plugins/video-studio/workbench/media.mjs)。单独复制 apps/studio 会遗漏该相对依赖。个人工程库、账号凭据、原始参考录音和本地输出存放在仓库外，任务里只保留必要的脱敏证据。

## 剪辑提交、文字合成与审片授权

已打开的剪辑台订阅同源、已认证的 `GET /api/projects/:id/revisions`。连接和重连先返回当前修订号，后续 SQLite 事务成功提交才发送新修订号。界面按需读取最新工程，拖动或本机保存期间延后应用。分镜整批提交时作为一个版本显示。编辑器保留播放头与手动草稿，冲突处理仍按起始修订和字段执行。[订阅入口](../../apps/studio/src/server.mjs) · [工程事务](../../apps/studio/src/project.mjs) · [剪辑台](../../apps/studio/www/app.js)

带文字字段的 JSX 组件默认 `motion.lockAspect=true`。尺寸在实际内容区里按原稿像素比例换算，中心保持原位。只改高度时由高度推导宽度，同时指定两者时以宽度为准，动作线等纯图形保留各自的尺寸。分镜、Codex 局部编辑、检查器、帧预览、正式渲染与成片抽样采用同一换算。旧成片文件仍由交付页保存。存在拉伸的历史导出不能充当当前时间线的合成预览。[尺寸换算](../../apps/studio/www/motion-clock.js) · [成片匹配](../../apps/studio/src/timeline-playback.mjs)

创建表单用同一函数生成审片说明与工程设置。帧分享默认关闭。启用分享后可开启导演回看，再授权一次独立终审。工作台对两套 v8 的可播放回看候选按冻结版本执行终审，并在交付记录中保存实际结果。[创建页](../../apps/studio/www/app.js) · [终审条件](../../apps/studio/src/independent-review.mjs)

工程预览的屏幕和正常模式外框依据 `profile.width / profile.height` 排布。放大、拖帧、还原及后台修订都使用同一台时间线播放器。任务轮询单独更新进度列表，保留服务端当前提供的事件历史。列表停在底部时跟随新消息，阅读历史时按首个可见事件及行内偏移恢复位置。仅当所读事件已经超出服务端保留范围，才定位至最早仍可阅读的事件。[编辑器](../../apps/studio/www/app.js) · [原生界面回归](../../apps/studio/test/control-states-webkit.js)
