# 选择个人风格

用户想比较或选择风格时，读取 `studio.py styles choices`，与网页共用个人库、已登记目录、源码包及插件附带文本包。完整展示 options 中的当前风格，注明 origin=library 为“已导入”、origin=pack 为“可导入”；不要只列已导入条目，也不任意截取前三种。historical_options 单列历史版本，不重复计入风格种类。errors 非空时说明具体缺项，不把读取失败当作全部目录。选项说明叙事推进、镜头组织和解释方式；保留 selector 与未验证维度，续做优先已有快照。

浏览详情用 `styles details --selector <id@version>`，不会导入。用户选中后调用 `styles select --selector <id@version>`；需要时导入该包的文本规则与证据，不改偏好。随后 `styles show --selector <id@version>` 读取保存的 SKILL.md。只检查个人库时使用 `styles list --installed` 或 `styles choices --installed`。不得用已导入列表代替可选目录。

使用当前宿主的可点击单选卡片/按钮：在 Codex 加载 ChatCut `widget-forms`，按实时 `ask_followup_questions` schema 组合一个单选字段。option id 使用完整 selector，label 用风格名，description 用真实说明；不预选，不绑定自动剪辑或生成动作。没有真实图像预览时使用文字卡片，不伪造 preview URL。补充“本次自定义或不使用已存风格”的路径；其结果不得当作库内 selector。

表单工具不可用时，用宿主支持的单选表单或同编号文字选择。只在实际调用后声称已展示按钮；仅生成 choices JSON 不等于已弹出界面。用户已点名风格时直接解析，无需重复问卷。没有条目时接受自由描述或参考，不自动导入别人的风格包。

选中风格只决定本次表现形式，不自行设置全局默认、不自动授权付费生成。已有制作授权继续执行；仅要求风格比较则展示差异与试片入口。未提交、旧组件状态或来自 MCP 的未确认数据，不能当作新的制作指令。

可选用户包也可通过 `studio.py styles import --file /实际路径/manifest.json` 导入。只有明确迁移偏好时加 `--apply-preferences`；默认仅保存风格。包内 pack: 文本证据复制到用户状态目录，引用固定到该版本。重复导入同版本可复用，内容变化或冲突必须新建版本。插件携带仓库已公开风格的文本副本，不携带原片、音色录音或本机账号数据；媒体仍从原素材包定位。VIDEO_STUDIO_PACK_ROOT 可指定单个包或 user-packs 集合目录；显式指定后仅查该位置。未指定时合并 styles link-pack 登记的位置、源码和随插件文本包，按 selector 去重。
