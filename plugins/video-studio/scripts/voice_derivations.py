"""Verify explicit narration asset lineage by replaying PCM, without ASR repair."""
import json
import math
from pathlib import Path
import re
from copy import deepcopy
import tempfile
import wave

import prepare_narration as preparation
import studio


def indexed(rows, label):
    result = {}
    for row in rows:
        ident = row['assetId']
        if not isinstance(ident, str) or not ident or ident in result:
            raise ValueError('Missing/duplicate ' + label + ' asset ID')
        result[ident] = row
    return result


def known_asset_ids(evidence):
    """Full identities from all declared sources/files and the complete timeline."""
    identities = {row['assetId'] for field in ('voice_sources', 'voice_derivation_sources', 'voice_files', 'voice_derivations')
                  for row in evidence.get(field, [])}
    identities.update(item['asset']['id'] for item in evidence.get('timeline', {}).get('timeline', {}).get('entries', [])
                      if item.get('asset', {}).get('id'))
    return identities


def inspected(row, known_ids=()):
    assets = [item['asset'] for item in row['data'] if 'asset' in item]
    if len(assets) != 1:
        raise ValueError('Inspected asset does not match narration identity')
    actual, expected = assets[0].get('id'), row['assetId']
    if actual == expected and not re.fullmatch(r'[0-9a-fA-F]{10}', actual or ''):
        return assets[0]
    # Hosted inspect_asset emits a 10-digit compact UUID, while its request and
    # the timeline retain full UUIDs. Never use an arbitrary startswith match.
    def compact(value):
        return value.replace('-', '').lower() if isinstance(value, str) and re.fullmatch(
            r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', value) else None
    target = compact(expected)
    if target and compact(actual) == target:
        return assets[0]
    if isinstance(actual, str) and re.fullmatch(r'[0-9a-fA-F]{10}', actual) and target:
        matches = {compact(ident) for ident in known_ids if compact(ident) and compact(ident).startswith(actual.lower())}
        if matches == {target}:
            return assets[0]
    raise ValueError('Inspected asset ID is mismatched, shortened or ambiguous')


def canonical_source(row):
    """Losslessly map hosted word columns to internal segments; preserve IDs/times.

    Keep the actual tool readback file unchanged. Producers may use this copy in
    voice_sources so existing word projection receives named segment fields.
    """
    result = deepcopy(row)
    for item in result['data']:
        if 'transcript' not in item:
            continue
        transcript = item['transcript']
        columns = transcript.get('columns')
        if columns is not None and columns != ['startMs', 'endMs', 'text']:
            raise ValueError('Unsupported transcript word columns')
        for interval in transcript.get('ranges', []):
            if 'words' not in interval:
                continue
            if columns is None or 'segments' in interval:
                raise ValueError('Ambiguous transcript word representation')
            if any(not isinstance(word, list) or len(word) != 3 for word in interval['words']):
                raise ValueError('Invalid transcript word row')
            interval['segments'] = [dict(zip(columns, word)) for word in interval.pop('words')]
        transcript.pop('columns', None)
    return result


def verify(evidence, root, fps):
    try:
        return _verify(evidence, root, fps)
    except (OSError, studio.StudioError, wave.Error, EOFError, KeyError, TypeError, AttributeError, IndexError) as exc:
        raise ValueError('Incomplete narration derivation evidence: ' + str(exc)) from exc


def _verify(evidence, root, fps):
    """Return verified lineage + all bound files; raise on any incomplete derivative.

    `voice_sources` holds current imported-asset readbacks and real ASR. Original
    generated-asset readbacks live separately in `voice_derivation_sources`.
    Every edge has an immutable preparation receipt and every active derivative
    has a hash-bound raw inspect_asset/transcript readback. Tool readbacks remain
    provenance evidence, not cryptographic attestations from the TTS provider.
    """
    edges = indexed(evidence.get('voice_derivations') or [], 'derivation')
    if not edges:
        return {'status': 'not_applicable', 'assets': {}, 'evidence_files': [],
                'root_sources': evidence.get('voice_sources') or []}
    if root is None:
        raise ValueError('Derived narration verification requires the run directory')
    root = Path(root).resolve(strict=True)
    if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not math.isfinite(fps) or fps <= 0:
        raise ValueError('Invalid narration FPS')
    files = indexed(evidence.get('voice_files') or [], 'voice file')
    active_sources = indexed(evidence.get('voice_sources') or [], 'current voice source')
    originals = indexed(evidence.get('voice_derivation_sources') or [], 'original voice source')
    known_ids = known_asset_ids(evidence)
    if set(originals) & set(edges):
        raise ValueError('Derived assets cannot impersonate original generated assets')
    for ident in set(originals) & set(active_sources):
        first, second = inspected(originals[ident], known_ids), inspected(active_sources[ident], known_ids)
        if dict(first, id=ident) != dict(second, id=ident):
            raise ValueError('Conflicting inspected generation records for the same original asset')
    bindings = {}

    def bound(ref):
        path = Path(ref['path']).expanduser().resolve(strict=True)
        if not path.is_file() or not path.is_relative_to(root) or studio.file_hash(path) != ref['sha256']:
            raise ValueError('Narration evidence file is outside this run or its SHA-256 changed')
        if str(path) in bindings and bindings[str(path)] != ref['sha256']:
            raise ValueError('Conflicting narration evidence hashes')
        bindings[str(path)] = ref['sha256']
        return path

    receipts = {}
    for ident, edge in edges.items():
        receipt = json.loads(bound(edge['receipt']).read_text(encoding='utf-8'))
        if (receipt.get('schema') != 1 or receipt.get('method') != preparation.METHOD
                or receipt.get('transcript_policy') != 'transcribe_imported_output'
                or receipt.get('filters') != preparation.filters(receipt['rate'])):
            raise ValueError('Unknown or inconsistent narration transform recipe')
        receipts[ident] = receipt
    visiting, verified = set(), {}

    def resolve(ident):
        if ident in verified:
            return verified[ident]['root_asset_id']
        if ident in visiting:
            raise ValueError('Cyclic narration derivation')
        if ident not in edges:
            if ident not in originals:
                raise ValueError('Unknown generated narration source: ' + ident)
            asset = inspected(originals[ident], known_ids)
            generation = asset.get('generationRecord') or {}
            if generation.get('record') != 'available' or not (generation.get('params') or {}).get('voiceId'):
                raise ValueError('Original narration lacks an actual available generation record')
            if ident not in files:
                raise ValueError('Missing original narration bytes')
            bound(files[ident])
            return ident
        visiting.add(ident)
        receipt = receipts[ident]
        source_id = receipt['source']['assetId']
        original = resolve(source_id)
        if ident not in files or source_id not in files:
            raise ValueError('Missing source or derived voice file')
        source, output = bound(receipt['source']), bound(receipt['output'])
        if receipt['audio_stream_index'] != preparation.audio_stream(source)['index']:
            raise ValueError('Narration derivation must use the actual default source audio stream')
        # The actual imported/downloaded file must have exactly the prepared bytes.
        if (receipt['source']['sha256'] != files[source_id]['sha256']
                or receipt['output']['sha256'] != files[ident]['sha256']):
            raise ValueError('Receipt bytes do not match the referenced source/imported asset')
        bound(files[source_id]); bound(files[ident])
        actual = preparation.pcm_info(output)
        if any(receipt['output'].get(key) != value for key, value in actual.items()):
            raise ValueError('Recorded derived PCM does not match the file')
        with tempfile.TemporaryDirectory(prefix='narration-lineage-') as temp:
            replay = Path(temp) / 'replayed.wav'
            preparation.render(source, replay, receipt['rate'], receipt['audio_stream_index'])
            if preparation.pcm_info(replay) != actual:
                raise ValueError('Derived narration PCM is not a reproducible transform of the declared source')
        visiting.remove(ident)
        verified[ident] = {'root_asset_id': original, 'source_asset_id': source_id,
                           'rate': receipt['rate'], 'pcm_sha256': actual['pcm_sha256'],
                           'duration_seconds': actual['frames'] / actual['sample_rate']}
        return original

    # Validate every declared chain, including orphaned/cyclic evidence.
    for ident in edges:
        resolve(ident)
    from delivery_requirements import track_assets
    used = track_assets(evidence, 'narration_tracks')
    timeline = evidence['timeline']['timeline']
    if evidence['timeline']['state']['fps'] != fps:
        raise ValueError('Narration evidence FPS does not match the timeline')
    selected = set(evidence['narration_tracks'])
    tracks = {t['id'] for t in timeline['tracks'] if selected.intersection((t['id'], t.get('alias')))}
    for clip in timeline['entries']:
        ident = (clip.get('asset') or {}).get('id')
        if clip.get('kind') != 'item' or clip.get('trackId') not in tracks or ident not in edges:
            continue
        rates = [clip.get('playbackRate'), (clip.get('properties') or {}).get('playbackRate')]
        if all(rate is None for rate in rates) or any(rate is not None and (isinstance(rate, bool) or rate != 1) for rate in rates):
            raise ValueError('Imported final-speed narration must explicitly play at rate=1')
        start, end = (clip['sourceRange'][k] for k in ('start', 'end'))
        left, right = (clip['timelineRange'][k] for k in ('fromFrame', 'toFrame'))
        if (not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (start, end, left, right))
                or start < 0 or end <= start or left < 0 or right <= left
                or abs((end-start) - (right-left)/fps*1e6) > 1.000001
                or end/1e6 > verified[ident]['duration_seconds'] + .000001):
            raise ValueError('Derived narration source/timeline ranges do not represent rate=1 PCM')
    root_sources = {}
    for ident in sorted(used):
        if ident not in edges:
            root_sources[ident] = active_sources[ident]
            continue
        row = canonical_source(active_sources[ident])
        asset = inspected(row, known_ids)
        transcript_ref = edges[ident].get('transcript')
        if not transcript_ref or canonical_source(json.loads(bound(transcript_ref).read_text(encoding='utf-8'))) != row:
            raise ValueError('Need the actual imported-asset inspect_asset/ASR readback, bound by hash')
        transcripts = [v['transcript'] for v in row['data'] if 'transcript' in v]
        if len(transcripts) != 1:
            raise ValueError('Derived narration needs its own real transcript')
        transcript = transcripts[0]
        ranges = transcript.get('ranges') or []
        summary = asset.get('transcript') or {}
        if (transcript.get('status') != 'available' or transcript.get('truncated') is not False
                or not ranges or any(r.get('truncated') is not False for r in ranges)
                or summary.get('state') != 'complete' or summary.get('readyForEditing') is not True):
            raise ValueError('Derived narration transcript is not complete and ready')
        duration_ms = verified[ident]['duration_seconds'] * 1000
        coverage = []
        for interval in ranges:
            a, b = (interval['range'][key] for key in ('startMs', 'endMs'))
            if (not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (a, b))
                    or not 0 <= a < b <= duration_ms + 1):
                raise ValueError('Invalid actual transcript request range')
            coverage.append((a, b))
        cursor = 0
        for a, b in sorted(coverage):
            if a > cursor + 1:
                raise ValueError('Need full derived-asset transcript request coverage')
            cursor = max(cursor, b)
        if cursor < duration_ms - 1:
            raise ValueError('Need full derived-asset transcript request coverage')
        words = [w for r in ranges for w in r['segments']]
        if not words or not any(any(c.isalnum() for c in w['text']) and not w['text'].startswith('[') for w in words):
            raise ValueError('Derived narration has no measured spoken words')
        for word in words:
            a, b = word['startMs'], word['endMs']
            if (not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (a, b))
                    or not 0 <= a < b <= verified[ident]['duration_seconds'] * 1000 + 1):
                raise ValueError('Invalid derived narration ASR timestamps')
        original = verified[ident]['root_asset_id']
        root_sources[original] = originals[original]
    # Detect changes during the replay and readback checks, before returning bindings.
    for path, digest in bindings.items():
        if studio.file_hash(path) != digest:
            raise ValueError('Narration evidence changed during verification')
    return {'status': 'checked', 'assets': verified,
            'evidence_files': [{'path': p, 'sha256': h} for p, h in sorted(bindings.items())],
            'root_sources': list(root_sources.values())}
