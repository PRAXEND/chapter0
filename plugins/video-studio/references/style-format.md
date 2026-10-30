# 个人风格格式

`styles list` 列出所有实际版本；`styles show --selector <id[@version]>` 校验并返回完整规格与 SKILL.md 路径；`styles add --file <json>` 原子创建新版本，不覆盖已有文件。省略 version 的选择只在选择时取最新版本，保存 run 后固定。

个人风格库在 VIDEO_STUDIO_HOME/styles（默认 Application Support/Video Studio/styles），由插件主动发现和读取。它属于用户的 Video Studio 数据，不写入可被升级替换的插件缓存，不自动出现在全局技能发现列表，也不随通用 ZIP 分发。分享风格需要用户另行指定。

每份 spec 有如下字段：

- schema_version:1，id:最多48字符的小写连字符标识，version:从1开始的正整数。
- name、description：可识别的名称与使用范围。
- adaptation：怎样用新题材替换示例对象，哪些规律可迁移、哪些不确定。
- references：唯一 id、kind(script/video/user_direction)、locator(实际文件路径/URL/记录位置)；可增加 sha256、title、analyzed_ranges。原始素材不拷贝到库。
- rules：唯一 id、dimension、instruction、check、basis、evidence。
- dimension 为 narrative/language/shots/pacing/graphics/captions/audio/transitions。
- basis 为 observed/inferred/user_direction；evidence 为 [{reference_id,location}]，location 指真实段落、行号或时间范围。
- unknown_dimensions：恰好列出无规则的维度。
- material_requirements：[{role,search_hint,acceptance,rule_id}]；search_hint 使用可替换的题材角色，不固定原视频事件。
- storyboard_contract（可选）：core_rule_ids 为核心规则 id 数组；visual_rule_ids 为其中需要具体画面设计的子集；conditional_rules 为 [{rule_id,when}]，与核心规则不重叠。planning_guidance 和 reference_guidance 分别说明本风格怎样落实与对照。未列为条件手法的规则继续执行；保存时检查所有关联 id。对应方案与验收见 [风格分镜](style-storyboard.md)。旧风格格式继续可读。

仅为 schema 演示的脚本风格（不是发行预置）：

```json
{
  "schema_version": 1,
  "id": "user-explanation",
  "version": 1,
  "name": "用户的解释型脚本",
  "description": "复用已分析脚本的叙事与语言",
  "adaptation": "替换原对象和事实，保留提问与回答之间的递进关系。",
  "references": [
    {"id":"r1","kind":"script","locator":"/实际用户文件/示例.txt"}
  ],
  "rules": [
    {"id":"r1-structure","dimension":"narrative",
     "instruction":"先提出受众的具体疑问，再逐步回答；结尾回扣疑问。",
     "check":"比较开头问题与结尾回答是否对应。",
     "basis":"observed",
     "evidence":[{"reference_id":"r1","location":"实际观察到的段落位置"}]}
  ],
  "unknown_dimensions":["language","shots","pacing","graphics","captions","audio","transitions"],
  "material_requirements":[]
}
```

实际登记时必须用真实分析与证据替换演示内容。脚本证据只能建立 narrative/language；明确的用户视听要求可作为 user_direction 引用。无法查看视频时保持视听未知，不能根据转录猜镜头节奏。

命令生成的 SKILL.md 有有效 frontmatter，逐条携带操作规则、检验方法和出处；style.json 保存机器可读原始规格，manifest.json 保存内容哈希。修改需另建版本。validation_status 固定为 unverified；真实复现结论在项目 style_match 中记录，避免把一次保存或试片泛化为保证。
