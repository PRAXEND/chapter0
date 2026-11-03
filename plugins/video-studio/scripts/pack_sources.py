"""Discover optional style packs in source checkouts and installed plugins."""
import json
import os
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]


def bundled_root():
    return PLUGIN / 'style-packs'


def is_bundled(root):
    return bundled_root().resolve() in Path(root).resolve().parents


def manifests():
    """Explicit overrides are exclusive; linked/source packs precede bundled copies."""
    import style_media
    found, errors, seen = [], [], set()

    def error(name, message):
        errors.append({'source': 'pack-location', 'name': str(name), 'error': message})

    def add(base, origin, required=False, pack_id=None):
        base = Path(base).expanduser().absolute()
        if not base.is_dir():
            if required:
                error(base, '风格包目录不存在；请修正 VIDEO_STUDIO_PACK_ROOT 或用 styles link-pack 重新登记。')
            return
        candidates = [base / 'manifest.json'] if (base / 'manifest.json').exists() else sorted(base.glob('*/manifest.json'))
        if not candidates and required:
            error(base, '未发现 manifest.json；可指定单个风格包目录或包含风格包的 user-packs 目录。')
        for manifest in candidates:
            canonical = str(manifest.resolve())
            if canonical not in seen:
                seen.add(canonical)
                found.append({'manifest': manifest, 'origin': origin, 'expected_id': pack_id})

    override = os.environ.get('VIDEO_STUDIO_PACK_ROOT')
    if override:
        add(override, 'configured', required=True)
        return found, errors
    registry = style_media.locations_file()
    if registry.exists():
        try:
            saved = json.loads(registry.read_text(encoding='utf-8'))
            if not isinstance(saved, dict) or saved.get('schema_version') != 1 or not isinstance(saved.get('packs'), dict):
                raise ValueError('风格包位置记录格式无效')
            for pack_id, location in saved['packs'].items():
                if not isinstance(location, str) or not Path(location).is_absolute():
                    error(pack_id, '风格包位置需要绝对路径；请用 styles link-pack 重新登记。')
                    continue
                add(location, 'linked', required=True, pack_id=pack_id)
        except (OSError, ValueError) as exc:
            error(registry, str(exc))
    add(PLUGIN.parents[1] / 'user-packs', 'repository')
    add(bundled_root(), 'bundled')
    if not found:
        error('style-packs', '未找到可导入风格包；请更新完整插件，或用 styles link-pack 登记源码中的风格包。')
    return found, errors
