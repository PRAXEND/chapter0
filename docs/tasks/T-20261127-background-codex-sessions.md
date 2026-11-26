# 工作台后台会话与 Codex 桌面侧栏

基线为独立 Mac 视频工作台 `30939fc`。验收场景覆盖新片主导演、复剪、独立终审、旧项目续作和中断后的重复提交。接口和凭据策略已与集成负责人异步核对，安装分发由集成负责人记录。

## 原因与修复

- 旧版 Node 服务创建持久的 App Server thread 时继承了启动进程的 Codex 会话目录、SQLite 根与桌面 originator。本机一个在工程库明确登记的旧制作会话实际返回 `source=vscode` 和 `originator=Codex Desktop`。
- 所有独立工作台入口经 `CodexClient` 启动。私有 CODEX_HOME 和 SQLite 根位于工作台持久目录，屏蔽外层桌面起源、工具管道及会话环境变量，并隔离 XDG 状态。工作台公开自己的最小权限组，拒绝能发现外部工具的制作客户端。普通模型和推理档偏好可随官方 OpenAI 配置沿用，工程选择优先。导演与终审各存其会话归属。一次中断的创作只能连接已登记的回合或前一回合后可唯一核实的继任回合。
- 仅当官方配置确认文件存储时，工作台链接本机既有 `auth.json` 和 `auth.lock`。文件由官方运行时读取及刷新。工作台“连接账号”不会用新账号覆盖已共享的桌面登录。独立登录使用自己的凭据目录。已存在的独立凭据保留。导出的可编辑项目和重新导入的便携文件均移除机器专属的线程标识。
- 对早期工作台，官方只读线程接入按当前工程保存的 ID、工作台专用临时目录、源目录及文件名核对归属。只复制相应的 rollout，在工作台目录用官方 thread/resume 按原 ID 恢复。取不到历史时可从现有工程开始独立的新任务。尚无结算回执的原任务会提示核对。桌面里已存在的记录由用户保留。
- 独立应用、终审、首版对照与风格研究脚本使用同一个工作台客户端。旧版插件另有 `codex exec --ephemeral` 和临时文案线程。它的桌面桥保留用户明确绑定的原聊天的只读入口。

实现参考官方 [Codex 本机目录](https://developers.openai.com/codex/config-advanced/)、[凭据存储](https://developers.openai.com/codex/auth/) 和 [App Server 会话协议](https://developers.openai.com/codex/app-server/)。

## 复核方式与边界

```sh
node --test apps/studio/test/{codex-profile,codex-transport,director,director-contracts,independent-review,project}.test.mjs
VIDEO_STUDIO_TEST_CODEX="$HOME/Applications/Video Studio.app/Contents/Resources/codex-runtime/bin/codex" node --test apps/studio/test/codex-sidebar-integration.test.mjs
```

- 65 项相关回归通过，涵盖凭据后端、原/私目录与身份、并发迁入、外部 MCP 拒绝、回执与账单状态、便携工程及终审。
- 安装包所带官方 0.167.0-alpha.3.2 的两项集成测试通过。合成账号与两个独立本机目录，Responses 流来自本机环回测试服务器。正常桌面线程列表包含两项桌面对照，看不到工作台新增的两个 ID，按 ID 也读不到。在工作台均可关进程后继续。迁入的旧工作台线程可以在工作台接续另一轮，同一桌面原件的指纹和轮次保持不变。普通桌面聊天和回执不符的旧任务无法冒充可迁移线程。没有调用线上模型。
- 对本机实际 ChatGPT 账号执行只读 account/read，已连接。将一个真实、由本机工作台工程库登记的旧会话复制到临时工作台目录，核对原 ID、最新回合 ID、原件 SHA-256 不变，并验证官方恢复路径在临时目录内。没有记录聊天正文、账号标识、凭据或原片，没有调用模型。未对用户已有侧栏记录执行归档或删除。
- 此处证据验证 Codex 桌面查询的底层线程接口、工作台落盘及恢复。安装/签名、桌面实际窗口观感与使用者验收由对应交付记录说明。
