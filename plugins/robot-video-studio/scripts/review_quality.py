#!/usr/bin/env python3
"""Evidence-bound creative review. Checks consistency, never claims to perceive media."""
import hashlib
import json
import math
import re
from pathlib import Path

DEFAULT_CREATIVE = {
    'narration': 'natural', 'motion': 'semantic',
    'transitions': 'purposeful', 'layout': 'adaptive', 'music': 'ask',
    'diagram_mode': 'contextual', 'still_policy': 'review', 'broll': 'source_first',
}
CHOICES = {
    'narration': {'natural'}, 'motion': {'semantic', 'enhanced'},
    'transitions': {'purposeful', 'designed'}, 'layout': {'adaptive'},
    'music': {'ask', 'instrumental', 'none'},
    'diagram_mode': {'contextual', 'footage_overlay'},
    'still_policy': {'review', 'no_extended_static'}, 'broll': {'source_first', 'fetch_related'},
}
METHODS = {
    'facts': {'source_review'}, 'script_naturalness': {'script_readthrough'},
    'visual_samples': {'frame_inspection'}, 'motion_review': {'sequence_playback'},
    'composed_visuals': {'continuous_playback'}, 'audio_listening': {'full_mix_listening'},
    'caption_sync': {'word_alignment_and_frames'}, 'semantic_sync': {'anchor_sequence_playback'},
    'editorial_rhythm': {'continuous_playback'},
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def text_hash(text):
    return hashlib.sha256(text.encode()).hexdigest()


def file_hash(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def preferences(value):
    if not isinstance(value, dict) or set(value) - set(CHOICES):
        raise ValueError('Unknown creative preference')
    result = {**DEFAULT_CREATIVE, **value}
    if any(result[k] not in choices for k, choices in CHOICES.items()):
        raise ValueError('Invalid creative preference value')
    return result


def interval(value, limit):
    if not isinstance(value, list) or len(value) != 2 or any(type(v) is not int for v in value):
        raise ValueError('Frame interval needs two integers')
    if not 0 <= value[0] < value[1] <= limit:
        raise ValueError('Frame interval outside timeline')
    return value


def validate_plan(plan):
    if plan.get('schema_version') != 1:
        raise ValueError('quality_plan schema_version must be 1')
    preferences(plan.get('requirements'))
    chapters = plan.get('chapters', [])
    if not chapters or len({c['id'] for c in chapters}) != len(chapters):
        raise ValueError('Need unique chapters')
    last = 0
    for c in chapters:
        a, b = interval([c['from_frame'], c['to_frame']], 3603)
        if a != last or c.get('transition') not in {'designed', 'cut', 'opening'}:
            raise ValueError('Chapters must cover a contiguous final timeline')
        if (a == 0) != (c['transition'] == 'opening'):
            raise ValueError('Only first chapter uses opening')
        if c['transition'] == 'cut' and not c.get('reason'):
            raise ValueError('Explain intentional chapter hard cuts')
        last = b
    if not isinstance(plan.get('motion_beats'), list) or not isinstance(plan.get('script_review'), list):
        raise ValueError('Need motion_beats and script_review arrays')
    return plan


def file_proof(ref, base):
    if not isinstance(ref, dict) or not ref.get('path') or not ref.get('sha256') or base is None:
        return False
    path = Path(ref['path']).expanduser()
    if not path.is_absolute():
        path = Path(base) / path
    try:
        return path.is_file() and file_hash(path) == ref['sha256']
    except OSError:
        return False


def samples_ok(samples, a, b, base, three=False):
    if not isinstance(samples, list) or not samples:
        return False
    if any(type(s.get('frame')) is not int or not a <= s['frame'] < b or not file_proof(s, base) for s in samples):
        return False
    if three:
        frames = sorted({s['frame'] for s in samples})
        # Early/middle/late samples; three adjacent stills do not establish a sequence.
        span = b - a
        return len(frames) >= 3 and frames[0] <= a + span / 3 and frames[-1] >= b - 1 - span / 3 and any(a + span/3 <= f <= a + 2*span/3 for f in frames)
    return True


def covered(ranges, duration):
    try:
        end = 0
        for a, b in sorted(interval(r, duration) for r in ranges):
            if a > end:
                return False
            end = max(end, b)
        return end == duration
    except (ValueError, TypeError):
        return False


def review_issues(key, review, run, artifact_hash, subtitle_hash, duration, base, proof=None):
    """A signed/logged assertion is not proof that a person actually listened."""
    issues = []
    if review.get('result') != 'pass':
        return ['not_passed']
    if review.get('artifact_sha256') != artifact_hash or review.get('revision') != run['revision']:
        issues.append('stale_export_or_revision')
    if review.get('method') not in METHODS[key]:
        issues.append('missing_or_incompatible_method')
    if not review.get('reviewer') or not review.get('observations') or not review.get('evidence'):
        issues.append('missing_review_observations')
    refs = review.get('evidence_files', [])
    if not refs or not all(file_proof(ref, base) for ref in refs):
        issues.append('missing_or_changed_evidence_file')
    if review.get('plan_sha256') != digest(run.get('quality_plan')):
        issues.append('stale_quality_plan')
    if key in {'composed_visuals', 'audio_listening', 'editorial_rhythm'}:
        if not covered(review.get('coverage_frames', []), duration):
            issues.append('incomplete_full_length_review')
    if key == 'caption_sync' and review.get('subtitle_sha256') != subtitle_hash:
        issues.append('stale_subtitles')
    if not isinstance(proof, dict) or review.get('evidence_sha256') != digest(proof):
        issues.append('missing_or_changed_final_evidence')
    verification = (proof or {}).get('verification', {})
    if key in {'composed_visuals', 'editorial_rhythm'} and verification.get('continuous_playback_review') is False:
        issues.append('contradicts_sampling_only_evidence')
    if key == 'audio_listening' and verification.get('audio_listening') in {'unverified', False}:
        issues.append('contradicts_unverified_audio')
    if key == 'motion_review' and isinstance(proof, dict):
        creative = proof.get('creative', {})
        scopes = [[t.get('from_frame'), t.get('to_frame')] for t in creative.get('transitions', []) if t.get('kind') != 'cut']
        by_id = {e['id']: e for e in proof.get('timeline', {}).get('timeline', {}).get('entries', []) if e.get('id')}
        for ident, info in creative.get('items', {}).items():
            if info.get('role') == 'explanation' and ident in by_id:
                r = by_id[ident]['timelineRange']; scopes.append([r['fromFrame'], r['toFrame']])
        try:
            ranges = [interval(r, duration) for r in review.get('coverage_frames', [])]
            for a, b in scopes:
                cropped = [[max(a,x)-a, min(b,y)-a] for x,y in ranges if max(a,x) < min(b,y)]
                if not covered(cropped, b-a):
                    issues.append('incomplete_motion_sequence_review'); break
        except (TypeError, ValueError):
            issues.append('incomplete_motion_sequence_review')
    if key == 'script_naturalness':
        expected = {b['id']: text_hash(b['narration']) for b in run['beats']}
        if review.get('script_sha256') != digest(expected):
            issues.append('stale_script')
    return issues


def check(run, evidence, artifact_hash, base=None, editorial=None):
    result = {'check': 'creative_quality', 'artifact_sha256': artifact_hash,
              'run_revision': run['revision'], 'status': 'unverified', 'pending': [], 'candidates': [],
              'note': 'Structural checks and evidence consistency cannot establish taste, actual playback or listening.'}
    pending, candidates = result['pending'], result['candidates']
    try:
        plan = validate_plan(run.get('quality_plan') or {})
        result['plan_sha256'] = digest(plan)
        req = preferences(plan['requirements'])
        if req != preferences(run['settings'].get('creative', {})) and not plan.get('override_reason'):
            pending.append('requirements_differ_without_explicit_override')
        state, timeline = evidence['timeline']['state'], evidence['timeline']['timeline']
        duration, fps = state['durationFrames'], state['fps']
        if type(duration) is not int or duration <= 0 or not isinstance(fps, (float, int)) or not math.isfinite(fps) or fps <= 0:
            raise ValueError('Invalid timeline duration/FPS')
        if run.get('project', {}).get('timelineId') and state.get('id') != run['project']['timelineId']:
            raise ValueError('Evidence timeline does not match this run')
        objects = [e for e in timeline['entries'] if e.get('kind') != 'gap']
        entries = {e['id']: e for e in objects}
        if timeline.get('totalEntries') != len(timeline['entries']) or len(entries) != len(objects):
            raise ValueError('Need complete unique timeline entries')
        if plan['chapters'][-1]['to_frame'] != duration:
            pending.append('chapter_plan_outdated')
        creative = evidence.get('creative', {})
        if creative.get('artifact_sha256') != artifact_hash or creative.get('run_revision') != run['revision'] or creative.get('plan_sha256') != digest(plan):
            pending.append('creative_evidence_missing_or_stale')
        beats = {b['id']: b for b in run['beats']}
        reviews = {r['beat_id']: r for r in plan['script_review']}
        for bid, beat in beats.items():
            r = reviews.get(bid, {})
            if r.get('text_sha256') != text_hash(beat['narration']) or r.get('decision') != 'keep' or not r.get('observation') or not r.get('reason'):
                pending.append('script_readthrough:' + bid)
        if not beats:
            pending.append('missing_script')
        tracks = evidence.get('visual_tracks')
        if not tracks:
            raise ValueError('Declare actual primary visual tracks; do not assume V1')
        primary = sorted([e for e in entries.values() if e.get('kind') == 'item' and e.get('itemType') in {'video', 'image', 'motion-graphic'} and (e.get('trackAlias') in tracks or e.get('trackId') in tracks)], key=lambda e: e['timelineRange']['fromFrame'])
        if not primary:
            raise ValueError('No primary visuals on declared tracks')
        details = creative.get('items', {})
        explanations, stills = [], []
        primary_ids = {e['id'] for e in primary}
        overlays = [entries[i] for i,info in details.items() if info.get('role') == 'explanation' and i in entries and i not in primary_ids]
        for item in primary + overlays:
            ident = item['id']; info = details.get(ident, {})
            a, b = interval([item['timelineRange']['fromFrame'], item['timelineRange']['toFrame']], duration)
            if info.get('role') not in {'footage', 'interface', 'explanation'} or not samples_ok(info.get('samples'), a, b, base):
                pending.append('visual_evidence:' + ident)
            if not file_proof(info.get('measurement'), base):
                pending.append('visual_measurement:' + ident)
            height = info.get('visible_height_fraction')
            if not isinstance(height, (int, float)) or isinstance(height, bool) or not math.isfinite(height) or not 0 < height <= 1:
                pending.append('visible_height:' + ident)
            elif height < .4 and b-a >= fps*3:
                candidates.append({'id': 'small:' + ident, 'kind': 'small_primary_visual', 'range': [a,b], 'height_fraction': height})
            if info.get('role') == 'interface' and item.get('sourceRange'):
                source = item['sourceRange']
                rate = (source['end']-source['start'])/1e6/((b-a)/fps)
                if rate < .75:
                    candidates.append({'id': 'slow_ui:' + ident, 'kind': 'slowed_interface', 'range': [a,b], 'rate': rate})
            if ident in primary_ids and req['still_policy'] == 'no_extended_static':
                static = info.get('static_ranges')
                if not isinstance(static, list):
                    pending.append('composed_stillness_unmeasured:'+ident)
                else:
                    for span in static:
                        x,y = interval(span, duration)
                        if x < a or y > b:
                            raise ValueError('Static interval outside its primary item')
                        stills.append([x,y])
            if info.get('role') == 'explanation':
                if req['diagram_mode'] == 'footage_overlay':
                    underlays = []
                    for uid in info.get('underlay_item_ids', []):
                        source = entries.get(uid, {})
                        if source.get('itemType') == 'video' and details.get(uid, {}).get('role') in {'footage','interface'}:
                            r = source['timelineRange']; x,y=max(a,r['fromFrame']),min(b,r['toFrame'])
                            if x < y:
                                underlays.append([x-a,y-a])
                    if not covered(underlays,b-a) or not info.get('underlay_relevance'):
                        pending.append('diagram_without_relevant_footage:'+ident)
                if item['itemType'] != 'motion-graphic':
                    pending.append('explanation_type:' + ident)
                explanations.append([a,b,ident])
                motion = info.get('core_motion_ranges')
                if not isinstance(motion, list):
                    pending.append('core_motion_unmeasured:' + ident); continue
                end, moving = a, 0
                for span in sorted(interval(r, duration) for r in motion):
                    if span[0] < a or span[1] > b or span[0] < end:
                        raise ValueError('Invalid/overlapping core motion ranges')
                    moving += span[1]-span[0]; end = span[1]
                stationary = b-a-moving
                if stationary >= fps*3 and stationary/(b-a) > .5:
                    candidates.append({'id':'static_core:'+ident,'kind':'mostly_stationary_explanation','range':[a,b], 'stationary_seconds':stationary/fps})
        merged_stills = []
        for a,b in sorted(stills):
            if merged_stills and a <= merged_stills[-1][1]:
                merged_stills[-1][1] = max(b, merged_stills[-1][1])
            else:
                merged_stills.append([a,b])
        for a,b in merged_stills:
            if b-a >= 3*fps:
                pending.append(f'extended_composed_static:{a}:{b}')
        groups = []
        for a,b,ident in sorted(explanations):
            if groups and a <= groups[-1][1]:
                groups[-1][1] = max(b, groups[-1][1]); groups[-1][2].append(ident)
            else:
                groups.append([a,b,[ident]])
        for a,b,ids in groups:
            if b-a > fps*12:
                candidates.append({'id':'diagram_run:'+ids[0], 'kind':'consecutive_explanations','range':[a,b], 'seconds':(b-a)/fps})
        transitions = {t['chapter_id']: t for t in creative.get('transitions', [])}
        designed = 0
        for chapter in plan['chapters'][1:]:
            ident, cut = chapter['id'], chapter['from_frame']
            t = transitions.get(ident, {})
            if chapter['transition'] == 'cut':
                if t.get('kind') != 'cut' or not t.get('observation') or not samples_ok(t.get('samples'), max(0,cut-15), min(duration,cut+15), base, True):
                    pending.append('chapter_cut_review:'+ident)
                continue
            ids = t.get('item_ids', [])
            valid = bool(ids) and all(i in entries for i in ids) and t.get('kind') in {'native','overlay'}
            a, b = t.get('from_frame', -1), t.get('to_frame', -1)
            valid = valid and type(a) is int and type(b) is int and 0 <= a < cut < b <= duration
            for item_id in ids:
                entry = entries.get(item_id, {})
                actual = entry.get('timelineRange', {})
                if t.get('kind') == 'native':
                    valid = valid and (entry.get('kind') == 'transition' or entry.get('itemType') == 'transition')
                else:
                    valid = valid and entry.get('itemType') == 'motion-graphic' and details.get(item_id, {}).get('role') == 'transition'
                valid = valid and actual.get('fromFrame', duration) <= a and actual.get('toFrame', -1) >= b
            if not valid or not samples_ok(t.get('samples'), a, b, base, True):
                pending.append('designed_transition_missing_or_unreviewed:'+ident)
            else:
                designed += 1
        if req['transitions'] == 'designed' and len(plan['chapters']) > 1 and not designed:
            candidates.append({'id':'no_designed_transitions','kind':'requested_transitions_absent','range':[0,duration]})
        for bid in plan['motion_beats']:
            matched = [(ident,info) for ident,info in details.items() if bid in info.get('beat_ids', []) and info.get('role') == 'explanation' and ident in entries]
            valid = bid in beats and bool(matched)
            for ident, info in matched:
                stages = info.get('stages', [])
                r = entries[ident]['timelineRange']; a,b=r['fromFrame'],r['toFrame']
                stage_end = a
                if len(stages) < 2:
                    valid = False
                for stage in stages:
                    x,y = interval(stage['range'], duration)
                    if not stage.get('meaning') or x < stage_end or x < a or y > b or x >= beats[bid]['to_frame'] or y <= beats[bid]['from_frame']:
                        valid = False
                    stage_end = y
                valid = valid and samples_ok(info.get('samples'), a, b, base, True)
            if not valid:
                pending.append('semantic_motion_missing_or_unreviewed:'+bid)
        if req['motion'] == 'enhanced' and not plan['motion_beats']:
            candidates.append({'id':'no_semantic_motion','kind':'requested_motion_unplanned','range':[0,duration]})
        # Old candidate resolutions using only prose/frame numbers cannot bypass this gate.
        for row in (editorial or {}).get('candidates', []):
            related = [entries[i]['timelineRange'] for i in row.get('item_ids', [row.get('item_id')]) if i in entries]
            scope = [min(r['fromFrame'] for r in related), max(r['toFrame'] for r in related)] if related else [max(0,round(row.get('from',0)*fps)), min(duration,round(row.get('to',duration/fps)*fps))]
            candidates.append({**row, 'range': scope})
        for row in candidates:
            resolution = creative.get('resolutions', {}).get(row['id'], {})
            refs = resolution.get('evidence_files', [])
            ok = resolution.get('decision') == 'keep' and resolution.get('reason') and resolution.get('observation') and refs and all(file_proof(ref, base) for ref in refs)
            if not ok or not samples_ok(resolution.get('samples'), *row['range'], base):
                pending.append('candidate:'+row['id'])
        if req['music'] == 'instrumental' and (not evidence.get('music_tracks') or not any(e.get('itemType') in {'audio','video'} and (e.get('trackAlias') in evidence['music_tracks'] or e.get('trackId') in evidence['music_tracks']) for e in entries.values())):
            pending.append('requested_music_missing')
        result['status'] = 'needs_review' if pending else 'pass'
    except (KeyError, ValueError, TypeError, AttributeError) as exc:
        pending.append('incomplete_quality_evidence:'+str(exc))
    return result


def apply_freeze_check(report, run, log, duration_seconds, fps=30):
    """FFmpeg full-frame detector, complementary to ROI/motion sequence inspection."""
    ranges, start = [], None
    for kind, value in re.findall(r'freeze_(start|end):\s*([0-9.eE+-]+)', log):
        seconds = float(value)
        if not math.isfinite(seconds):
            raise ValueError('Nonfinite freeze timestamp')
        if kind == 'start':
            start = max(0, seconds)
        elif start is not None:
            ranges.append([start, min(seconds, duration_seconds)]); start = None
    if start is not None:
        ranges.append([start, duration_seconds])
    ranges = [[round(a*fps), round(b*fps)] for a,b in ranges if b-a >= 3-1/fps]
    report['freeze_detection'] = {'threshold_db':-50, 'minimum_seconds':3, 'ranges':ranges,
        'scope':'Final full-frame pixel change; moving captions/background can hide a static subject. Sequence review still required.'}
    req = (run.get('quality_plan') or {}).get('requirements', run['settings'].get('creative', {}))
    if req.get('still_policy') == 'no_extended_static':
        for a,b in ranges:
            report['pending'].append(f'detected_composed_freeze:{a}:{b}')
        if ranges and report['status'] == 'pass':
            report['status'] = 'needs_review'
    return report
