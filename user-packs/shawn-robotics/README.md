# Shawn 机器人科普个人包

以团队 Video Studio 0.2.1 为基础保存本项目的两种风格、BOTPIE有限样本分析与试片复盘。用户明确要求保留这些经验；通用安装不会自动启用，也不把此包放入通用ZIP。

从仓库根目录用完整Python运行：

```sh
python3 plugins/video-studio/scripts/studio.py styles import --file user-packs/shawn-robotics/manifest.json
```

明确迁移本人的制作偏好时加 `--apply-preferences`。导入后 `styles list`、`styles show --selector shawn-contrast-story@1` 和 `styles choices` 可查询真实条目。没有选定默认风格；两者均可选择。

证据文本会复制到用户状态目录，原片和音色录音不随包复制。包内pack:引用由导入命令解析，不直接用styles add登记这些源JSON。版本1不可覆盖，修改另建版本。

两种方法来自有限账号参考与本项目试片，不能称为复刻BOTPIE。两片得到总体正面反馈，逐项风格复现和完整声画验收仍未验证。详见 [经验与边界](evidence/project-lessons.md)。
