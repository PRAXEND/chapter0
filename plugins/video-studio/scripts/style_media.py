"""Read-only checks for optional style-pack media; never execute pack scripts."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess

PLUGIN = Path(__file__).resolve().parents[1]
PACK_ID = 'henry-video-styles'
STYLES = {'henry-hot-news': ('hot-news', '热点资讯风格素材'),
          'henry-technical-explainer': ('technical-explainer', '技术科普风格素材')}
CHECKS = {key: 'style_media_' + slug.replace('-', '_') for key, (slug, _) in STYLES.items()}
POINTER = b'version https://git-lfs.github.com/spec/v1'


def locations_file():
    from studio import home
    return home() / 'user-packs' / 'locations.json'


def safe_file(root, name):
    relative = Path(name)
    if not isinstance(name, str) or not name or relative.is_absolute() or '..' in relative.parts:
        raise ValueError('包内路径必须是安全的相对路径')
    target = root / relative
    parts = [root]
    for part in relative.parts:
        parts.append(parts[-1] / part)
    if any(part.is_symlink() for part in parts):
        raise ValueError('不读取符号链接中的风格包文件')
    if root.resolve() not in target.resolve().parents:
        raise ValueError('风格包文件越出目录')
    return target


def read_json(root, name):
    path = safe_file(root, name)
    if path.stat().st_size > 5_000_000:
        raise ValueError('风格包索引过大')
    return json.loads(path.read_text(encoding='utf-8'))


def link_pack(manifest_file):
    """Explicitly remember a pack location, without importing styles or media."""
    from studio import write, locked
    path = Path(manifest_file).expanduser().absolute()
    root = path.parent
    if path.name != 'manifest.json':
        raise ValueError('请选择风格包的 manifest.json')
    data = read_json(root, path.name)
    if data.get('schema_version') != 1 or not re.fullmatch(r'[a-z][a-z0-9-]{0,47}', data.get('id', '')) or type(data.get('version')) is not int or data['version'] < 1:
        raise ValueError('风格包身份无效')
    if not isinstance(data.get('styles'), list) or not data['styles']:
        raise ValueError('风格包没有样式清单')
    for name in data['styles']:
        if not safe_file(root, name).is_file():
            raise ValueError('风格规格文件缺失：' + name)
    file = locations_file()
    with locked(file.parent):
        saved = json.loads(file.read_text()) if file.exists() else {'schema_version': 1, 'packs': {}}
        if saved.get('schema_version') != 1 or not isinstance(saved.get('packs'), dict):
            raise ValueError('风格包位置记录损坏，请先保留并修复 locations.json')
        saved['packs'][data['id']] = str(root.resolve())
        write(file, saved)
    return {'pack': f"{data['id']}@{data['version']}", 'path': str(root.resolve()), 'styles_modified': False}


def locate_pack(explicit=None):
    value = explicit or os.environ.get('VIDEO_STUDIO_PACK_ROOT')
    if value:
        base = Path(value).expanduser().absolute()
        return base if (base / 'manifest.json').exists() or base.name == PACK_ID else base / PACK_ID
    file = locations_file()
    if file.exists():
        saved = json.loads(file.read_text())
        if saved.get('schema_version') != 1 or not isinstance(saved.get('packs'), dict):
            raise ValueError('风格包位置记录损坏')
        value = saved['packs'].get(PACK_ID)
        if value:
            if not isinstance(value, str) or not Path(value).is_absolute():
                raise ValueError('风格包位置需要绝对路径')
            return Path(value)
    return PLUGIN.parents[1] / 'user-packs' / PACK_ID


def git_lfs_check(required=False):
    git = shutil.which('git')
    row = {'id': 'git_lfs', 'label': 'Git LFS（获取风格素材）', 'required': required, 'ok': False,
           'status': 'missing', 'message': 'Git 或 Git LFS 未安装；已完整下载的素材仍可使用。',
           'remedy': 'macOS 可用 brew install git-lfs 安装；再到风格包所在源码仓库执行 git lfs install --local，然后按素材检查中的命令下载。'}
    if git:
        try:
            result = subprocess.run([git, 'lfs', 'version'], capture_output=True, text=True, timeout=8, check=False)
            version = re.search(r'git-lfs/([0-9]+\.[0-9]+\.[0-9]+)', result.stdout)
            if result.returncode == 0 and version:
                row.update(ok=True, status='ready', version=version[1], message='Git LFS ' + version[1] + ' 可用')
            else:
                row.update(status='unavailable', message='Git LFS 未安装或无法正常运行；已有完整素材可继续使用。')
        except (OSError, subprocess.TimeoutExpired):
            row.update(status='unavailable', message='Git LFS 检测失败或超时；请修复工具后重新检测。')
    return row


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def repair_hint(root, issues):
    link = shlex.join(['python3', str(PLUGIN / 'scripts/studio.py'), 'styles', 'link-pack', '--file', str(root / 'manifest.json')])
    repo = next((p for p in [root, *root.parents] if (p / '.git').exists()), None)
    commands = []
    if repo:
        include = (root.relative_to(repo) / 'media').as_posix() + '/**'
        commands = [shlex.join(['git', '-C', str(repo), 'lfs', 'install', '--local']),
                    shlex.join(['git', '-C', str(repo), 'lfs', 'pull', '--include=' + include])]
    kinds = {issue['status'] for issue in issues}
    if kinds & {'hash_mismatch', 'unsafe', 'invalid_index', 'unreadable'}:
        commands = []
        remedy = '文件或索引已变化：先备份本地改动，在干净的新源码 checkout 中获取完整风格包并执行 git lfs pull；不要用修改校验值来跳过检查。'
    elif repo:
        remedy = '在源码仓库补齐实际媒体：' + '；'.join(commands) + '。'
    else:
        remedy = '获取包含 user-packs/henry-video-styles 的源码仓库，安装 Git LFS，在仓库根执行 git lfs install --local 和 git lfs pull --include=\'user-packs/henry-video-styles/media/**\'。完整离线副本也可使用。'
    return remedy + ' 若素材已存在其他目录，用以下命令登记真实位置（替换 manifest 路径）：' + link + '。随后重新检测。', commands


def check_media(selector=None, explicit=None):
    """Hash actual files, scope failures to their style, and report all failures."""
    selected_id = (selector or '').split('@')[0]
    try:
        root = locate_pack(explicit)
        locate_error = None
    except (OSError, ValueError, TypeError) as error:
        root = PLUGIN.parents[1] / 'user-packs' / PACK_ID
        locate_error = str(error)
    shared, by_style, checked = [], {key: [] for key in STYLES}, {}
    paths = {key: set() for key in STYLES}
    def problem(name, status, detail=''):
        return {'path': name, 'status': status, **({'detail': detail} if detail else {})}
    def inspect(name, expected, size=None):
        if name in checked:
            return checked[name]
        try:
            path = safe_file(root, name)
            if not path.is_file(): result = problem(name, 'missing')
            else:
                with path.open('rb') as stream: prefix = stream.read(128)
                if prefix.startswith(POINTER): result = problem(name, 'lfs_pointer')
                elif size is not None and path.stat().st_size != size: result = problem(name, 'hash_mismatch', '文件大小与索引不符')
                elif digest(path) != expected: result = problem(name, 'hash_mismatch', 'SHA-256 与索引不符')
                else: result = None
        except ValueError as error: result = problem(name, 'unsafe', str(error))
        except OSError as error: result = problem(name, 'unreadable', str(error))
        checked[name] = result
        return result
    try:
        if locate_error: raise ValueError(locate_error)
        manifest = read_json(root, 'manifest.json')
        index = read_json(root, 'checksums.json')
        if manifest.get('id') != PACK_ID or manifest.get('schema_version') != 1:
            raise ValueError('风格包身份不匹配')
        hashes = index.get('files')
        if index.get('algorithm') != 'sha256' or not isinstance(hashes, dict) or not hashes or len(hashes) > 2000:
            raise ValueError('缺少有效的 SHA-256 文件清单')
        for name, sha in hashes.items():
            safe_file(root, name)
            if not isinstance(sha, str) or not re.fullmatch('[a-f0-9]{64}', sha): raise ValueError('文件哈希格式无效')
        for name in ('manifest.json', 'resources.json'):
            if name not in hashes: raise ValueError('校验清单缺少 ' + name)
            issue = inspect(name, hashes[name])
            if issue: shared.append(issue)
        if shared: raise ValueError('风格包元数据未通过校验')
        resources = read_json(root, 'resources.json')
        rows = resources.get('files')
        if not isinstance(rows, list) or not rows: raise ValueError('资源索引为空')
        sizes = {}
        for row in rows:
            name, slug = row['path'], row['style']
            if row.get('sha256') != hashes.get(name) or name in sizes or type(row.get('bytes')) is not int or row['bytes'] <= 0:
                raise ValueError('资源索引与校验清单不一致：' + str(name))
            sizes[name] = row['bytes']
            for key, (known_slug, _) in STYLES.items():
                if slug == known_slug: paths[key].add(name)
        if {name for name in hashes if name.startswith('media/')} != {name for name in sizes if name.startswith('media/')}:
            raise ValueError('媒体清单覆盖不完整')
        for key, (slug, _) in STYLES.items():
            if not any(name.startswith('media/' + slug + '/') for name in paths[key]): raise ValueError('风格媒体清单为空：' + slug)
            paths[key].update(name for name in hashes if name.startswith(('reproduction/' + slug + '/', 'evidence/' + slug + '/', 'styles/' + key)))
            specs = [name for name in paths[key] if name.startswith('styles/')]
            if not specs: raise ValueError('缺少风格规格：' + key)
            for name in sorted(paths[key]):
                issue = inspect(name, hashes[name], sizes.get(name))
                if issue: by_style[key].append(issue)
    except FileNotFoundError as error:
        shared.append(problem(str(error.filename or 'manifest.json'), 'missing'))
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        shared.append(problem('metadata', 'invalid_index', str(error)))
    result = []
    for key, (_, label) in STYLES.items():
        issues = shared + by_style[key]
        ok = not issues
        remedy, commands = repair_hint(root, issues) if issues else ('', [])
        counts = {status: sum(row['status'] == status for row in issues) for status in {row['status'] for row in issues}}
        summary = '；'.join(f'{label} {counts[status]} 项' for status, label in [('missing', '缺失'), ('lfs_pointer', '未下载，仅有 LFS 指针'), ('hash_mismatch', '内容变化'), ('unsafe', '不安全路径'), ('invalid_index', '索引异常'), ('unreadable', '无法读取')] if counts.get(status))
        result.append({'id': CHECKS[key], 'label': label, 'required': selected_id == key,
                       'ok': ok, 'status': 'ready' if ok else 'incomplete', 'packRoot': str(root),
                       'message': f'{len(paths[key])} 个参考素材及复现文件校验通过' if ok else summary,
                       'verifiedFiles': sum(name in checked and checked[name] is None for name in paths[key]),
                       'issues': issues, 'remedy': remedy, 'commands': commands})
    return result
