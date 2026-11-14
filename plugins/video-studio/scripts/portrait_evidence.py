"""Bind portrait layer declarations to raw ChatCut asset and item readbacks.

This verifies the supplied tool records, not pixels or the provenance of a tool
call. Independent review of the final composite remains mandatory.
"""
import hashlib
import json
import math
from pathlib import Path
import re


def _identity(value):
    if not isinstance(value, str):
        raise ValueError('Missing tool object identity')
    compact = value.replace('-', '').lower()
    if not re.fullmatch(r'[0-9a-f]{10,32}', compact):
        raise ValueError('Expected a complete UUID or a readable tool UUID prefix')
    return compact


def _same_id(first, second):
    a, b = _identity(first), _identity(second)
    return a.startswith(b) or b.startswith(a)


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _same_value(a, b):
    if _number(a) and _number(b):
        return abs(a - b) <= 1e-8
    return type(a) is type(b) and a == b


def _code(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Asset readback is missing includeCode source')
    return value.replace('\r\n', '\n').strip()


def _assets(value):
    """Accept inspect_asset JSON or its unchanged MCP text-content envelope."""
    if not isinstance(value, dict):
        return []
    found = [value['asset']] if isinstance(value.get('asset'), dict) else []
    for content in value.get('content', []):
        if isinstance(content, dict) and content.get('type') == 'text':
            try:
                found.extend(_assets(json.loads(content['text'])))
            except (KeyError, TypeError, ValueError):
                pass
    return found


def _properties(block, heading, separator, effective=False):
    match = re.search(r'^' + re.escape(heading) + r':\s*\n((?:[ \t]+[^\n]*\n?)*)', block, re.M)
    if not match:
        raise ValueError('Item readback is missing ' + heading)
    values = {}
    for line in match.group(1).splitlines():
        field = re.fullmatch(r'\s+([A-Za-z][A-Za-z0-9_]*)\s*' + re.escape(separator) + r'\s*(.*?)\s*', line)
        if not field:
            continue
        key, raw = field.groups()
        if key in values:
            raise ValueError('Duplicate item property: ' + key)
        if effective:
            raw = re.sub(r'\s+\((?:default|override|overridden)\)$', '', raw)
        try:
            values[key] = json.loads(raw)
        except ValueError as exc:
            raise ValueError('Unparseable raw item property: ' + key) from exc
    return values


def _items(text, wanted_id=None):
    """Read the actual inspect_item text format; JSON declarations are insufficient."""
    result = []
    for block in re.split(r'\n\s*---\s*\n', text):
        identity = re.search(r'^Item:\s*([0-9a-fA-F-]+)\s*$', block, re.M)
        if not identity:
            continue
        if wanted_id is not None and not _same_id(identity.group(1), wanted_id):
            continue
        if not re.search(r'^Type:\s*motion-graphic\s*\|', block, re.M):
            continue
        timeline = re.search(r'^Timeline:.*\[([0-9a-fA-F-]+)\]\s*$', block, re.M)
        asset = re.search(r'^Asset:\s*\[([0-9a-fA-F-]+)\]', block, re.M)
        placed = re.search(r'^Type:\s*motion-graphic\s*\|\s*Track:.*\[([0-9a-fA-F-]+)\]\s*\|\s*from=(\d+)\s+durationInFrames=(\d+)\s+endExclusive=(\d+)\b', block, re.M)
        if not timeline or not asset or not placed:
            raise ValueError('Incomplete raw motion-graphic item readback')
        track, first, duration, last = placed.groups()
        first, duration, last = int(first), int(duration), int(last)
        if first + duration != last:
            raise ValueError('Inconsistent raw item frame range')
        result.append(dict(id=identity.group(1), timeline_id=timeline.group(1),
                           asset_id=asset.group(1), track_id=track, first=first, last=last,
                           properties=_properties(block, 'Properties', ':'),
                           effective=_properties(block, 'Motion Graphic Effective Props', '=', True)))
    return result


def check(data, evidence, root, frames, fps):
    """Return requirement errors plus verified raw evidence for probe hash binding."""
    policy = (data.get('production_plan') or {}).get('plan', {}).get('productionPlan', {})
    if policy.get('layout', {}).get('mode') != 'portrait-centered' or policy['layout'].get('version') != 3:
        return dict(errors={}, evidence_files=[])
    # Imported only during validation: portrait_design also imports production_plan.
    from portrait_design import BACKGROUND, ENDING
    root = Path(root).resolve()
    errors, verified = {}, {}
    for role, check_name, code in [('background', 'portrait_layout', BACKGROUND), ('ending', 'transitions', ENDING)]:
        try:
            record = evidence['presentation'][role]
            entries = evidence['timeline']['timeline']['entries']
            matches = [item for item in entries if item.get('kind') == 'item' and _same_id(item.get('id'), record['item_id'])]
            if len(matches) != 1:
                raise ValueError('Layer does not identify one actual timeline item')
            item = matches[0]
            if item.get('itemType') != 'motion-graphic' or not _same_id(item['asset']['id'], record['asset_id']):
                raise ValueError('Layer asset does not match the actual timeline item')
            timeline_id = evidence.get('timeline_id') or (data.get('project') or {}).get('timelineId')
            _identity(timeline_id)
            refs = record['readback_files']
            if not isinstance(refs, list) or not refs:
                raise ValueError('Raw asset and item readback files are required')
            assets, items, proofs = [], [], []
            for ref in refs:
                file = Path(ref['path']).resolve(strict=True)
                if not file.is_relative_to(root) or not file.is_file():
                    raise ValueError('Readback must be a file inside this run')
                raw = file.read_bytes()
                digest = hashlib.sha256(raw).hexdigest()
                if not re.fullmatch(r'[a-f0-9]{64}', ref['sha256']) or digest != ref['sha256']:
                    raise ValueError('Readback hash does not match')
                text = raw.decode('utf-8')
                try:
                    assets.extend(_assets(json.loads(text)))
                except ValueError:
                    items.extend(_items(text, item['id']))
                proofs.append(dict(path=str(file), sha256=digest))
            # Some MCP responses include the same asset object twice.
            assets = list({json.dumps(a, sort_keys=True): a for a in assets}.values())
            assets = [a for a in assets if _same_id(a.get('id'), item['asset']['id'])]
            items = [i for i in items if _same_id(i['id'], item['id'])]
            if len(assets) != 1 or len(items) != 1:
                raise ValueError('Need one matching raw inspect_asset JSON and inspect_item text')
            asset, placed = assets[0], items[0]
            if (asset.get('type') != 'motion-graphic' or asset.get('revision') != record.get('asset_revision')
                    or not re.fullmatch(r'sha256:[a-f0-9]{64}', str(asset.get('revision', '')))
                    or _code(asset.get('code')) != _code(code)):
                raise ValueError('Asset revision/source differs from the current portrait recipe')
            interval = item['timelineRange']
            first = 0 if role == 'background' else frames - round(.6 * fps) - round(1.2 * fps)
            if (not _same_id(placed['timeline_id'], timeline_id) or not _same_id(placed['track_id'], item['trackId'])
                    or not _same_id(placed['asset_id'], item['asset']['id'])
                    or (placed['first'], placed['last']) != (first, frames)
                    or interval != dict(fromFrame=first, toFrame=frames)):
                raise ValueError('Raw item identity/range differs from this timeline and ending')
            actual, raw_props = item['properties'], placed['properties']
            geometry = dict(left=0, top=0, width=data['settings']['width'], height=data['settings']['height'])
            for key, expected in geometry.items():
                if not all(_number(v) and abs(v - expected) <= 1 for v in (actual.get(key), raw_props.get(key))):
                    raise ValueError('Raw item geometry differs: ' + key)
            for key, expected in dict(opacity=1, rotation=0, fadeIn=0, fadeOut=0, from_=first, durationInFrames=frames-first).items():
                key = 'from' if key == 'from_' else key
                if not _same_value(raw_props.get(key), expected) or not _same_value(actual.get(key), expected):
                    raise ValueError('Raw item placement/fades differ: ' + key)
            motion = policy['layout']['backgroundMotion']
            expected = ({k: motion[k] for k in ('lineCount', 'strength', 'speed', 'lineColor')}
                        | dict(bgColor=policy['layout']['background'], transparentBackground=False)) if role == 'background' else dict(fadeFrames=round(1.2*fps), color='#000000')
            for key, value in expected.items():
                if not _same_value(placed['effective'].get(key), value) or not _same_value(record['effective_properties'].get(key), placed['effective'].get(key)):
                    raise ValueError('Raw effective property differs: ' + key)
            verified.update({proof['path']: proof for proof in proofs})
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            errors[check_name] = role + ' 原始读回证据无效：' + str(exc)
    return dict(errors=errors, evidence_files=list(verified.values()))
