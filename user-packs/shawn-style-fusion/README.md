# Shawn七种视频风格

从17条原片的脚本与画面抽样、BOTPIE57条卡片和两条既有试片形成的可选个人库。不是通用预置。完整观察及边界见evidence/reference-analysis.json。

## 可直接指定的风格

| 名称 | 当前版本 | 核心讲法 |
|---|---|---|
| [能力快报型](styles/shawn-capability-brief.json) | shawn-capability-brief@1 | 高光→新事件→亮点→用途与边界 |
| [反差故事型](styles/shawn-contrast-story.json) | shawn-contrast-story@2 | 预期→真实转折→经历证据→回扣 |
| [动作拆解型](styles/shawn-action-breakdown.json) | shawn-action-breakdown@2 | 动作问题→空间与反馈→带观察点回看 |
| [类比科普型](styles/shawn-analogy-explainer.json) | shawn-analogy-explainer@1 | 生活问题→一个类比→机制→边界 |
| [案例归纳型](styles/shawn-case-synthesis.json) | shawn-case-synthesis@1 | 共同问题→同维度案例→共性或取舍 |
| [产业脉络型](styles/shawn-industry-context.json) | shawn-industry-context@1 | 现象→瓶颈/阶段→工程取舍→商业含义 |
| [观点论证型](styles/shawn-evidence-commentary.json) | shawn-evidence-commentary@1 | 判断→证据→反例→检验标准 |

用户可直接说：“用动作拆解型，讲机器人为什么容易抓不稳杯子。”每份规格均含脚本规则、镜头与节奏、素材要求和一分钟改写骨架；调用时结合本期真实素材，不复用参考片的事实和原台词。

后续制作先按用户指定风格读取个人库的实际SKILL.md，固定版本到本期工程，再按主题核实来源并制作。沿用本项目≤60秒、1080×1920、大壹自然有活力且语速紧凑、轻科技纯器乐清晰可听的约定；当次新要求优先。交付独立MP4、SRT和可编辑工程链接。

完整逐片报告见 [风格整合与17条逐片分析](../../../output/video-style-fusion-20261026/风格整合与17条逐片分析.md)。项目记忆见 [机器人视频制作记忆](../../../memory/robot-video-studio.md)。

## 导入与版本

用团队CLI导入：

```sh
python3 plugins/video-studio/scripts/studio.py styles import --file user-packs/shawn-style-fusion/manifest.json
```

此包没有profile_patch；原大壹、BGM及画幅偏好保留原用户配置。原两种风格升级v2，旧v1保留；其他五种为v1。不设置默认、不自动启动制作。原shawn-robotics包仍保留。保存状态unverified；有来源的规则不等于已做风格复现验收。
