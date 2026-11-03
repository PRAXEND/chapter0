# 从风格到分镜和成片

选定风格后，在选材与分镜前读取 run 中的 SKILL.md、style.json、storyboard_contract（若有）及有关复现配方。对照有辨识度的开头、中段与收束节点，记下实际观察与本期如何替换。配方、代码和参数能证明设计方法，不能冒充已观看参考；无法读取媒体时保留这一限制。无需把大型附件全部展开，只读取所选方法的配方及代表节点。

## 写方案

先把风格的核心表达落实到叙事节点，再决定具体手法。storyboard_contract.core_rule_ids 必须有镜头承载，visual_rule_ids 另需具体画面设计。conditional_rules 只有满足 when 条件才用；不适用要解释本期为什么不成立。其他规则继续执行。没有 contract 的旧风格仍逐条安排，不自动推导特效配额。纯脚本风格或无风格作品不强制加动效。

分镜使用网页计划格式：title、summary、script、shots、stylePlan、gaps、limitations、notes。shots 每项包含 id、from/to（预计秒）、sourceIds、narration、visual、screenText、transition，以及 design 数组。无需单独动画的镜头可用空数组。每个设计包含：

- id：全片唯一，后续剪辑与复查沿用。
- ruleIds：实际风格规则 id；无风格时可为空。
- purpose：具体解释、情绪或注意力作用，不能只写“增强风格”。
- trigger：实际台词/动作；配音前用语义锚点，配音后解析为真实帧号。
- phases：进入、作用/状态变化、退出，以及要让观众看懂的内容；“加 MG”不够。
- durationSeconds：位于本镜头内的预计占用秒数；跨切点效果以所在镜头记录，并说明源余量。
- placement：随时间变化的主体/手/物体/路径保护与文字位置，不把保护主体简化为永远固定上下分区。
- sound：声音及冲击落点；有意无声音也写原因。
- implementation：可编辑组件/现有工具能力、素材及跟踪/蒙版等前提；此阶段只读查能力，不正式制作。
- fallback：实现受限时保留同一表达目的的替代。若还缺真实输入，列入 gaps；不能把删掉核心表达写成降级完成。

stylePlan 未选风格时为 null；选择后为：

```json
{
  "selector": "实际id@版本",
  "rules": [{"ruleId":"实际规则", "disposition":"planned", "shotIds":["镜头id"], "treatment":"本题具体处理及验收关注点"}],
  "referenceChecks": [{"referenceId":"实际参考id", "location":"实际节点或配方字段", "observation":"实际看到或读到什么，注明方式与限制", "adaptation":"本题保留什么、怎样替换"}],
  "contrastReview": "全片核心表达覆盖、节点之间的变化、重复模板及已修正的简化"
}
```

rules 覆盖快照全部规则；planned 至少关联一个镜头。只有 contract 声明的条件手法能记 not_applicable，shotIds 留空，treatment 说明原因；只有 brief.style_overrides 中的真实用户覆盖能记 overridden。不需要每镜重复所有规则，同一个设计可落实多个有关规则。contrastReview 是实施前的方案检查，不代表成片通过。关注不同节点是否有不同信息/运动机制，不用改颜色、换文案或堆组件数冒充变化。

终端/对话流程用 `studio.py record --kind style_plan --file <完整方案JSON> --run <目录>` 保存；网页 save-plan 自动执行同样的快照校验，并展示设计与参考对照。它不创建额外人工确认阶段，仍沿用一次文案分镜确认；未改变主要含义的实现与时序调整无需重新审稿。已有旧确认方案可按原路径恢复；重新保存的方案采用新结构。

## 制作与核验

确认后先在实际素材上实现一个覆盖主要风险的代表段，检查合成运动、字号、保护区和声音；修正后再扩展全片。它属于已授权制作，不另向用户索要批准。预检能力不足时采用已设计的等效替代；需要改变核心表达、事实或用户要求时说明真实差异。

按最终音频重新定位设计。每个实际 beat 增加 shot_id 对应计划镜头，design_results 记录该镜头设计的真实实现；普通镜头也要有 shot_id，同一计划镜头可拆成多个实际 beat。设计 id 全片只登记一次，实际实现区间应由承载它的 beat 覆盖：

```json
{
  "design_id":"方案中的id", "status":"implemented",
  "item_ids":["实际时间线对象ID"], "from_frame":120, "to_frame":165,
  "observations":"真实读回与合成序列观察，不能照抄预期",
  "evidence_files":[{"path":"实际读回或检查证据文件", "sha256":"实际SHA-256"}]
}
```

实现变化用 substituted，增加 substitution_reason，解释新机制怎样保留原目的；未完成用 missing。源数据读回、合成动态、全混音与参考比较各自记录，存在对象不等于效果通过。audit 会发现遗漏设计、未知镜头、无效帧区间、缺失/变化的证据；它不会自动判断好不好看。

style_match 继续逐条审阅，另附 run.style_plan.sha256 为 style_plan_sha256，绑定当前方案、revision 和最终 MP4。条件手法未采用的规则结果为 not_applicable，必须与已校验的计划一致；用户覆盖用 overridden；其余逐条 pass/fail/unverified。核心表达弱化、动效未实现时记 fail；无法连续观看/听审记 unverified。即使文件可解码、字幕正常、组件齐全，也不能代替风格匹配结论。
