"""Read real installed styles and optional repository packs for the local workbench."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

import styles
import user_packs

PLUGIN = Path(__file__).resolve().parents[1]


def pack_root():
    value = os.environ.get('VIDEO_STUDIO_PACK_ROOT')
    return Path(value).expanduser().resolve() if value else PLUGIN.parents[1] / 'user-packs'


def public_url(value):
    try:
        parts = urlsplit(value)
        if parts.scheme in ('https', 'http') and parts.hostname and not parts.username and not parts.password:
            return value
    except ValueError:
        pass
    return None


def entries():
    found, errors = [], []
    library = styles.catalog()
    for item in library:
        if item.get('error'):
            errors.append({'source': 'library', 'selector': f"{item['id']}@{item['version']}", 'error': item['error']})
            continue
        value = styles.resolve(item['selector'])
        found.append({'key': 'library:' + value['selector'], 'selector': value['selector'], 'spec': value['spec'],
                      'origin': 'library', 'validation_status': value['validation_status'], 'skill_path': value['skill_path']})
    installed = {f"{e['id']}@{e['version']}" for e in library}
    root = pack_root()
    for manifest in sorted(root.glob('*/manifest.json')):
        try:
            if manifest.is_symlink() or manifest.parent.is_symlink():
                raise ValueError('Pack must not be a symlink')
            data = json.loads(user_packs._file(root, manifest.relative_to(root)).read_text())
            if data.get('schema_version') != 1 or not isinstance(data.get('styles'), list):
                raise ValueError('Invalid style pack manifest')
            pack = f"{data['id']}@{data['version']}"
            for relative in data['styles']:
                spec = styles.validate(json.loads(user_packs._file(manifest.parent, relative).read_text()))
                selector = f"{spec['id']}@{spec['version']}"
                if selector in installed:
                    continue
                found.append({'key': f'pack:{pack}:{selector}', 'selector': selector, 'spec': spec,
                              'origin': 'pack', 'pack': pack, 'manifest': str(manifest), 'pack_root': str(manifest.parent),
                              'validation_status': 'unverified'})
        except (ValueError, KeyError, OSError) as error:
            errors.append({'source': 'pack', 'name': manifest.parent.name, 'error': str(error)})
    latest = {}
    for entry in found:
        spec = entry['spec']
        latest[spec['id']] = max(latest.get(spec['id'], 0), spec['version'])
    for entry in found:
        entry['historical'] = entry['spec']['version'] < latest[entry['spec']['id']]
    return found, errors


def summary(entry):
    spec = entry['spec']
    return {k: entry[k] for k in ('key', 'selector', 'origin', 'validation_status', 'historical')} | {
        'name': spec['name'], 'description': spec['description'], 'version': spec['version'],
        'pack': entry.get('pack'), 'ruleCount': len(spec['rules']), 'referenceCount': len(spec['references']),
        'dimensions': sorted({r['dimension'] for r in spec['rules']}), 'unknown_dimensions': spec['unknown_dimensions']}


def catalog():
    values, errors = entries()
    return {'entries': [summary(e) for e in values], 'errors': errors}


def resolve(key):
    value = next((e for e in entries()[0] if e['key'] == key), None)
    if value is None:
        raise ValueError('风格不存在或版本已变化，请刷新真实风格库。')
    return value


def evidence_file(entry, reference):
    locator = reference['locator']
    if locator.startswith('pack:') and entry['origin'] == 'pack':
        return user_packs._file(Path(entry['pack_root']), locator[5:])
    if entry['origin'] == 'library' and not public_url(locator):
        from studio import home
        file = Path(locator).expanduser().resolve()
        root = (home() / 'user-packs').resolve()
        if root in file.parents:
            return user_packs._file(root, file.relative_to(root))
    raise ValueError('参考原文件未包含在可读取的风格证据中；请查看来源位置。')


def details(key):
    entry = resolve(key)
    spec = entry['spec']
    analyses = {}
    for ref in spec['references']:
        try:
            file = evidence_file(entry, ref)
            if file.suffix == '.json':
                data = json.loads(file.read_text())
                if isinstance(data, dict) and isinstance(data.get('records'), list):
                    analyses.update({r['id']: r for r in data['records'] if isinstance(r, dict) and isinstance(r.get('id'), str)})
        except (ValueError, OSError, KeyError):
            pass
    references = []
    for ref in spec['references']:
        value = dict(ref)
        value['url'] = public_url(ref['locator'])
        value['readable'] = False
        try:
            file = evidence_file(entry, ref)
            value['readable'] = True
            value['file_name'] = file.name
        except (ValueError, OSError):
            pass
        if ref['id'] in analyses:
            value['analysis'] = analyses[ref['id']]
        references.append(value)
    skill = Path(entry['skill_path']).read_text() if entry['origin'] == 'library' else styles.render(spec)
    return {**summary(entry), 'adaptation': spec['adaptation'], 'rules': spec['rules'], 'references': references,
            'material_requirements': spec.get('material_requirements', []), 'skill': skill,
            'content_hashes': styles.resolve(entry['selector'])['files'] if entry['origin'] == 'library' else {}}


def reference(key, reference_id):
    from studio import file_hash
    entry = resolve(key)
    ref = next((r for r in entry['spec']['references'] if r['id'] == reference_id), None)
    if ref is None:
        raise ValueError('参考不存在。')
    file = evidence_file(entry, ref)
    return {'name': file.name, 'text': file.read_text(encoding='utf-8'), 'sha256': file_hash(file)}


def select(key):
    entry = resolve(key)
    imported = None
    if entry['origin'] == 'pack':
        imported = user_packs.install(entry['manifest'], apply_preferences=False)['pack']
    resolved = styles.resolve(entry['selector'])
    return {'selector': resolved['selector'], 'key': 'library:' + resolved['selector'], 'importedPack': imported,
            'preferencesApplied': False}
