# ChatCut 连接检测与断点续做

本次已要求完整制片时，在开展依赖 ChatCut 的制作前，确认当前 Codex 聊天能调用 ChatCut。仅做资料研究、源码维护或保存风格规则无需连接制片服务。
编辑器能打开、CLI 已注册、CLI 登录成功，都不等于这条聊天能操作工程。

## 检测

1. 查看当前可调用工具清单，必要时用宿主的工具发现能力。只有真实清单中有 ChatCut 工具才写 `tools_available:true`。
2. 有工具时调用一次 `list_projects` 或当前项目的只读工具。只有实际成功才写 `live_probe:success`；401/明确认证要求写 `auth_required`，其他失败写 `failed`。不要因为缺工具就写认证失败。
3. `studio.py connection --file /absolute/observations.json [--run /absolute/existing-run]` 自动只读检查现有 `codex mcp get chatcut --json` 注册，输出分层报告。工具观察 JSON 由执行任务的宿主保存，不要求用户填写。

观察示例（必须替换为本次真实结果）：

```json
{"tools_available": false, "live_probe": "not_run", "auth": "unknown", "startup": "unknown"}
```

`auth` 可为 unknown/login_succeeded/required；`startup` 可为 unknown/ready/failed/issuer_missing/timeout。
旧日志不代表当前故障；只采用当前宿主、当前连接最后一次启动结果。宿主能可靠提供会话标识时可加 `session_id`；未知就省略，不自造标识。
不要写入原始日志、URL、OAuth 响应、cookie、token 或请求头。报告只保存枚举、操作键及工程/运行定位。

## 按状态恢复

- `connected`：当前只读调用成功，继续已有制作。
- `probe_required`：先执行只读调用，不能把工具存在当作认证成功。
- `registration_missing/disabled`：按当前已安装 ChatCut 基础技能检查注册/设置；不创建重复服务，不安装 Desktop 替代。
- `auth_required`：只有明确需要认证时完成一次登录，随后重新做实际调用。
- `host_auth_metadata_error`：当前宿主明确报告 issuer 元数据缺失，在报错的 Codex 应用连接中重新授权；不要复制/修改 OAuth 存储，或声称 CLI 登录一定修复了应用。
- `startup_failed/connection_failed`：保留错误类别，检查实际连接失败原因，不一概重装或登录。
- `tools_not_loaded`：已有注册，但当前聊天无工具。明确告诉用户是 **Codex 侧栏“新建聊天”**，不是 ChatCut 新建聊天/工程；插件不能自行给旧会话补载工具。新聊天也要先检查实际调用，不能保证一定恢复。
- `unverified`：证据不足；检查注册及宿主错误，不猜根因。

非 connected 返回退出码 2，是有待处理项，不是让调用者循环重跑。观察未变化时报告 `unchanged_since_previous_check:true`；给出一次具体下一步，停止同样的登录/安装/新建聊天建议循环。如果新聊天依然失败，转查该新会话的启动错误，而不是再次让用户盲开聊天。

## 保存与恢复制作

传 `--run` 时写入 `connection-check.json`，给出已有工程 ID、下载哈希校验结果、须处理的缺失/改动文件，以及须核对的 reserved/submitted 操作。此操作不改 `run.json`、revision、质量计划、媒体或任务状态，不调用生成服务。

在新聊天续做提示里写明：绝对运行目录、已有脚本/来源文件、输出及音色/配乐偏好、目标 Git 分支。不要只让用户复制一句“继续”。没有实际新建的工程不要编造链接。

恢复时读 `run.json` 和本期额外脚本，校验完成下载的文件存在与哈希，读取已记录工程及任务的真实状态。reserved/submitted 结果未知，先核对服务端，不重新生成。工具仍缺失时只保存诊断和提示词；不要重复搜索、批量下载、切换产品或本地合成冒充完成。
