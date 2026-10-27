# Henry 视频风格与复现素材包

版本 `henry-video-styles@1`，收录本地无变体风格的最新 v7：热点资讯型 `henry-hot-news@7`（34 条规则）、技术科普型 `henry-technical-explainer@7`（32 条规则）。发布时保留原规则；增加命名空间，避免与已有本地 v7 的路径内容冲突。原个人库不迁移、不覆盖。

## 获取与导入

在本仓库根目录执行，需 Python 3.10+ 和 Git LFS：

```sh
git lfs install
git lfs pull --include='user-packs/henry-video-styles/media/**'
python3 user-packs/henry-video-styles/verify.py
python3 plugins/video-studio/scripts/studio.py styles import \
  --file user-packs/henry-video-styles/manifest.json
```

导入是主动操作，不设默认风格，不修改全局 profile。再次导入相同版本是幂等的。通用插件 ZIP 不包含此包；只下载通用 ZIP 无法获取这些风格和素材。GitHub 的源码 ZIP 可能只有 LFS 指针，优先使用 Git clone 和上述 `git lfs pull`，以校验脚本结果为准。

导入器把风格规则和 `pack:` 文本证据复制到个人库，媒体仍保留在本仓库。风格中的 `resource:` 定位符以本包目录为根，例如 `resource:media/references/ref-01.mp4`。复现时同时提供本包路径；移动文件夹后按新根目录解析，不依赖原作者电脑路径。

## 内容

- `styles/`：两份 v7 规格，包含依据、未知项、素材要求，以及原有完整复现配方。
- `media/references/`：实际分析的 10 条参考视频，保留来源 URL 和分析范围。
- `media/hot-news/`：家务试片使用的 22 个视频、分段旁白、配乐和音效。视频与本地原文件哈希一致。
- `media/technical-explainer/`：Atlas 试片使用的 8 个媒体文件。训练视频是实际使用的 3 个原片区间，原片偏移记录在 `resources.json`，不是重新下载的不同版本；另含制造资料、旁白、Wallpaper 配乐和两种音效。
- `media/benchmarks/`：两条最终试片 MP4，供复现后对照。
- `reproduction/`：两份 XML、13 个 MG 组件的完整代码及属性；技术科普的完整时间线、65 个对象参数和 52 张字幕卡片。热点资讯的原生对象、字幕、配方和组件关联保存在风格 JSON 的 `reproduction_bundle`。
- `resources.json`：资源路径、字节数、SHA-256、来源、原片偏移和资产别名；`checksums.json` 覆盖整个包。

## 复现步骤

1. 运行校验脚本，确认媒体不是 Git LFS 指针且所有文件哈希正确。
2. 显式选择所需 v7 风格。复刻基准试片时使用其原始 1920×1080、30fps；热点资讯 v7 的新片默认是 9:16，不能把旧横版试片误认成新片默认。
3. 在新工程中导入 `media/<style>/`。按 `resources.json` 的 `asset_aliases` 建立新资产 ID 映射。`ref-*` 仅是本包关联键，不是可以调用的云端工程 ID。
4. 按原生记录恢复源窗口、播放速率、图层、裁切、音量、字幕和转场；用 `motion-graphics.json` 的代码、schema 和 defaults 创建 MG，再恢复每个实例的参数。
5. XML 仅用于普通剪辑软件的基础剪辑结构。XML 会遗漏 MG、字幕、部分效果及转场，不能独立代表完整工程；媒体链接以 XML 所在目录为起点指向 `../../media/<style>/`，剪辑软件必要时可重链接该目录。
6. 导出后与 `media/benchmarks/` 对照，执行完整声画验收。技术科普原片时间 = 包内片段时间 + `source_window_seconds[0]`，不要重复加偏移。

## 依赖与已知边界

热点资讯使用 Xinqingnian Ti，技术科普使用 Noto Sans SC。字体文件未随包分发，需在目标 ChatCut 运行环境中可用；字体替换会改变字宽和版式。MG 依赖 ChatCut 运行环境及内置效果，运行版本未独立锁定，因此保存素材和代码不等于已验证逐像素复刻。两份风格保留 `unverified`，既有记录明确标记未完成的完整实时观看、全混音听审及保音高听感核验。

归档内使用的制造资料保存了实际源文件；其上游完整视频可能还有未使用部分。本包以复现已用片段为范围。旧工程其他未用时间线的离线素材不属于这两条基准试片。

## 来源与署名

参考视频及官方演示的来源见 `resources.json` 和风格 `references`，原作者权利不因纳入本包而改变。本包不对第三方素材授予额外使用许可。

“Wallpaper” — Kevin MacLeod ([incompetech](https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100843))，许可 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。试片使用区间 16–107.5 秒并调整增益；沿用该音乐的发布物须保留署名。
