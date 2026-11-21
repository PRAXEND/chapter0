# 独立工作台的风格与验收

分支基线为 `video-generation-workbench@b6a41ee`。这里的运行证据来自 Apple Silicon 开发机。真实看片意见由创作者与第二位审片人分别登记。

## 风格与成片检查

- `createStyleLibrary` 读取私有风格、旧版 `reproduction_bundle`、`reproduction_blueprint` 与参考清单。按工程保存的 `id/version` 读取规则。`getReference` 校验 SHA-256；已登记旧包中的 Git LFS 占位文件可从已核验的本地对象恢复。科学与资讯两例均已测到真实基准片，旧脚本分别提供 8 张和 6 张参考拼图。
- `compileScene` 将已观察的素材动作帧、主体位置、文字、前后承接与阅读时长转成可编辑图层。`savePreference` 从明确的用户修改派生新版本；原版继续可读。
- `capturePreference(styles,store,input)` 读取明确版本的时间线。跨时移动的镜头各取当时的位置；删除时按下一镜或上一镜找到新版接缝。将两段正常速度的片段及各自的工程、版本、帧范围和指纹一并写入新版风格。空时间线与单纯文字偏好保留真实状态。`renderTimelineWindow(project,{directory,output,fromFrame,toFrame,signal})` 可用于制作中的草稿预览，结束帧不含在内。
- 只导入视频也可建立风格。`learn` 对用户选择的音视频在本机测量，按时间定位并保存可重看的代表帧、画幅、局部大幅画面变化和音量电平。规则附原文件指纹，未观察的叙事和主观听感继续标作未知。在 135.333 秒真实 NASA 素材中已测到开头 45 秒的画面变化，并独立核对三张代表帧的源时间及指纹。
- 可携带工程调用 `styles.exportPortable({id,version},工程目录)`，返回工程绑定 `id/version/sha256/manifest`。原始 JSON、私有参考和指纹保存在 `style/`；发行包里已有的原件只登记指纹。`styles.restorePortable(绑定,工程目录)` 在新资料库核验全部内容之后登记风格，拒绝同编号与版本的不同规则以及被改写的参考。旧包安装时展开的本机路径可还原为同一套发行包坐标，原始 JSON 另有独立指纹。
- `reviewProject(project,{videoPath,srtPath,resolveTool})` 校验成片、字幕与源音轨的实际证据，独立保存听感、语义、技术证据及播放区间。`classifyLegacyReview` 只读归并旧审片记录。已解决的配乐注记会重查时间线；现有旁白、选定音色和有实际凭据的原创配乐分别核对。
- 2026-11-14 旧记录归并为一处需改动作、六处建议。2026-11-15 旧记录归并为两项待核身份/来源。历史文件需以报告的 SHA-256 对上工程保存的候选，无法匹配则不登记。

## 看片研究

通过独立评测库的 `打开盲评工作台.command` 打开 `/blind`。审批者各用独立名字，视频使用匿名代号，每位审片人的顺序和 A/B 方位各自随机。管理员可在工作台登记渲染任务，或选择已导入工程的外部真实前台成片。登记会冻结成片和指纹。每位审片人需完成全部看片才可查看汇总。

开发机器已经冻结五组。历史校准有两条。留出验收有 18 条，三种入口各含四个原样短片和两个注入实质问题的短片。程序对本批输出判定为 12 条可交付、6 条需修复。风格辨认含三个新题材、两种风格、两次独立 App Server 创作，共 12 条。配对研究有两对；桌面会话与 App Server 使用相同原片、三帧参考、提示词、模型、推理档、配音和渲染器，各自决定镜头内的文字与承接。此组测量局部创作决定。另已冻结一组 54 秒 Artemis I 整片初版配对，前台和工作台各自选择 6 个源镜头并写完整旁白，均导出 MP4、SRT 与可携带工程。五组均等待真实人评。

## 复现

在 `apps/studio` 完整集成工作区下，从仓库根目录执行。下载会验证固定的 NASA 源文件指纹，脚本会将片源、出处、处理记录和可编辑工程写入指定评测目录。`review-treatments` 需要已连接的 Codex 账号。

```sh
node --test apps/studio/test/style.test.mjs apps/studio/test/portable-style.test.mjs apps/studio/test/style-preference.test.mjs apps/studio/test/review.test.mjs apps/studio/test/blind-review.test.mjs
python3 -m unittest discover -s tests -p 'test_style_context.py' -v
node apps/studio/scripts/build-review-library.mjs "$EVALUATION_DIR" sources
node apps/studio/scripts/review-treatments.mjs "$EVALUATION_DIR"
node apps/studio/scripts/build-review-library.mjs "$EVALUATION_DIR" gate
node apps/studio/scripts/build-review-library.mjs "$EVALUATION_DIR" style
node apps/studio/scripts/register-historical-calibration.mjs "$EVALUATION_DIR" "$LEGACY_WORKBENCH" "$REPORT_1" "$REPORT_2"
```

配对研究需先使用真实前台会话读取相同三帧和提示，将独立决定登记到评测库 `research-plan/foreground.json`，再执行 `build-review-library.mjs "$EVALUATION_DIR" pair`。评测管理者可在新建研究中登记其他真实成片，同步登记模型与输入条件。参与者在每一对成片上独立评价事实、镜头、声画和返工。准备工具与留出样本均不写入旧工程。
