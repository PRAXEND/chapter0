# 接手与自检

以下命令从视频仓库根目录运行。先确认 `git rev-parse --show-toplevel`、`git status --short --branch` 和 `git log -1 --oneline`。开发目标为 `codex/standalone-mac-studio`。如果显示的是企渡官网的分支，请回到独立视频仓库。

## 取得分支并分开工作

已经有集成分支的成员可以直接建立自己的工作目录。

```sh
GIT_LFS_SKIP_SMUDGE=1 git worktree add -b codex/my-studio-task ../studio-my-task codex/standalone-mac-studio
cd ../studio-my-task
(cd apps/studio && node --run test:quick)
```

收到维护者提供的增量 Git bundle 时，先在包含 web.39 基准的仓库执行以下步骤。新机器可先取得公开插件仓库与标签，跳过媒体下载以运行快测。命令中的 bundle 路径换成实际位置。

```sh
GIT_LFS_SKIP_SMUDGE=1 git clone --single-branch --branch video-generation-workbench https://github.com/PRAXEND/chapter0.git video-studio
cd video-studio
git fetch origin tag v0.3.0-web.39
git bundle verify /path/to/video-studio-mac.bundle
git fetch /path/to/video-studio-mac.bundle refs/heads/codex/standalone-mac-studio:refs/remotes/handoff/standalone-mac-studio
GIT_LFS_SKIP_SMUDGE=1 git worktree add -b codex/my-studio-task ../studio-my-task refs/remotes/handoff/standalone-mac-studio
cd ../studio-my-task
```

维护者可从本分支重新生成交接文件。Git bundle 收录已提交的代码、协作文档和 LFS 指针，实体风格媒体另取。团队有共享远端分支时可直接取该分支，无须重复传送 bundle。

```sh
git bundle create ../video-studio-mac.bundle refs/heads/codex/standalone-mac-studio ^v0.3.0-web.39
```

## 十分钟内完成第一次检查

需要 Node 24 和完整的 Python 3.11+ 标准库。从项目根运行以下命令，快测使用临时工程，覆盖工程版本、锁、控件和时间线。无需 npm 安装依赖、下载风格媒体或连接模型账号。

```sh
node --version
python3 -c 'import sys,json,subprocess,unittest; assert sys.version_info >= (3,11)'
(cd apps/studio && node --run test:quick)
python3 -m unittest discover -s .agent-context/tests -p 'test_context*.py' -v
base=$(python3 -c 'import json; print(json.load(open(".agent-context/manifest.json"))["base"])')
python3 .agent-context/tools/check_context.py --config .agent-context/config.json --base "$base" --task T-001-bootstrap
```

若 Python 自检提示标准库模块缺失，可将下面及后续的 python3 换成自检通过的 python3.11 或 python3.12，再运行同一组命令。

上述基准用于复验初始化。开发新任务时以实际目标分支的分叉点运行，例如 `git merge-base HEAD refs/remotes/handoff/standalone-mac-studio`，再传入自己的任务 ID。看到 HUMAN_REVIEW 时到任务记录核对同伴确认。

## 在隔离资料库打开源码界面

```sh
studio_data=$(mktemp -d)
STUDIO_DATA_ROOT="$studio_data" node apps/studio/src/server.mjs
```

打开终端打印的一次性本机 URL，查看「新建工程」或「使用帮助」。Ctrl+C 结束本次服务。首次访问后复用已认证窗口。重新启服务可取得新入口。工程库占用时，先确认使用该库的服务，再为自己的任务换用独立目录。

## 实体媒体、实机测试与构建

- 完整风格验证需要 42 个实体音视频（约 473 MB）。克隆自公开发行库且 origin 指向该仓库时，可取回已发布媒体，再按当前检出校验。只有指针时媒体校验会明确报错。如果 origin 是本地 bundle，可先用 `git remote add release-media https://github.com/PRAXEND/chapter0.git` 登记发行源，取得 web.39 标签后把以下 LFS 命令的 origin 换成 release-media，或由同伴提供已物化、同指纹的风格包。
- Git LFS 的 checkout 不会覆盖本地已修改文件。应在干净的个人工作目录运行。发行构建还支持 `STUDIO_PACK_CHECKOUT`，其值是包含 user-packs 的已物化资源根目录。[打包实现](../../apps/studio/scripts/bundle-styles.mjs)

```sh
git lfs fetch --include='user-packs/henry-video-styles/media/**' --exclude='' origin v0.3.0-web.39
git lfs checkout 'user-packs/henry-video-styles/media/**'
python3 user-packs/henry-video-styles/verify.py
```

| 修改范围 | 从哪里验证 |
|---|---|
| 创建、手工编辑、页面状态 | 先跑快测。Apple Silicon 上用 `node apps/studio/scripts/verify-control-states.mjs` 操作真实 WKWebView 和临时 SQLite，`node apps/studio/scripts/test-webview.mjs /tmp/studio-smoke.png` 覆盖帮助、时间线和动效。原生路径需要 Xcode Command Line Tools 和就绪的媒体环境。 |
| 剪切、蒙版、变速、声音、风格资源 | 校验实体风格包，按 [MEDIA](../../apps/studio/MEDIA.md) 运行定向测试与真实小片。全量命令为 `(cd apps/studio && node --run test)`。源树须物化测试直接引用的资源，原生渲染须有 FFmpeg 等依赖。离线 Codex 进程测试用 `VIDEO_STUDIO_TEST_CODEX` 指向可执行文件，另核对结果里的跳过数。 |
| 原生启动、发行和安装 | 按 [Mac 工作台构建说明](../../apps/studio/README.md)准备 Rust、命令行工具与媒体。使用 `STUDIO_BUILD_CHANNEL=quality` 和独立 `STUDIO_DIST` 构建，核对质量通道标识、签名和包内资源。打包、安装、对外发布与真实用户验收分别登记。 |

参考帧、转录和第三方服务的授权随工程保存。快测和本机帮助操作无需启动制作。排查风格、导出或渲染问题时，记录工程修订、帧号、素材指纹、命令与结果，个人账号、临时入口和原始媒体留在本机。
