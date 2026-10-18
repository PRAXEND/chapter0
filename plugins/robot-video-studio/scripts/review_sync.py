#!/usr/bin/env python3
"""Read-only sync diagnostics from final ChatCut evidence. Never certifies listening."""
import argparse
import difflib
import json
from pathlib import Path
import re

from studio import parse_srt


def normalized(text):
    return ''.join(c.lower() for c in text if c.isalnum())


def spoken(word):
    return bool(normalized(word['text'])) and not re.fullmatch(
        r'\[.*(?:silent|silence).*\]', word['text'].strip(), re.I)


def project_words(clips, sources, fps=30):
    """Source windows are microseconds; ASR is milliseconds; timeline is frames.

    Map every intersecting word, including tiny overlaps: silently discarding a
    6 ms fragment would conceal the duplicate-token bug this check must detect.
    """
    projected, issues = [], []
    for clip in sorted(clips, key=lambda c: c['timelineRange']['fromFrame']):
        aid = clip['asset']['id']
        first, last = (clip['sourceRange'][k] / 1000 for k in ('start', 'end'))
        left, right = (clip['timelineRange'][k] / fps for k in ('fromFrame', 'toFrame'))
        if last <= first or right <= left:
            raise ValueError('Invalid source/timeline range')
        rate = (last - first) / 1000 / (right - left)
        for index, word in enumerate(sources[aid]):
            if not spoken(word):
                continue
            a, b = word['startMs'], word['endMs']
            overlap = min(b, last) - max(a, first)
            if overlap <= .001:
                continue
            if a < first - 1 or b > last + 1:
                issues.append({'kind': 'partial_word', 'item_id': clip['id'],
                               'text': word['text'], 'overlap_ms': round(overlap, 3)})
            projected.append({'text': word['text'], 'asset_id': aid, 'word_index': index,
                              'item_id': clip['id'], 'rate': rate,
                              'start': left + (max(a, first) - first) / 1000 / rate,
                              'end': left + (min(b, last) - first) / 1000 / rate})
    seen = set()
    for word in projected:
        key = (word['asset_id'], word['word_index'])
        if key in seen:
            issues.append({'kind': 'repeated_source_word', 'text': word['text'],
                           'item_id': word['item_id']})
        seen.add(key)
    return projected, issues


def check_captions(cues, words, tolerance_ms=200, fps=30):
    letters = [(char, word) for word in words for char in normalized(word['text'])]
    source_text = ''.join(char for char, _ in letters)
    cue_text = ''.join(normalized(''.join(c['lines'])) for c in cues)
    if cue_text != source_text:
        edits = [{'kind': tag, 'source': source_text[i:j], 'subtitles': cue_text[a:b]}
                 for tag, i, j, a, b in difflib.SequenceMatcher(
                     None, source_text, cue_text, autojunk=False).get_opcodes() if tag != 'equal']
        return {'coverage_complete': False, 'text_differences': edits, 'cues': [],
                'note': 'Timing withheld: text differs; reconcile ASR/captions before comparing.'}
    offset, checks = 0, []
    for index, cue in enumerate(cues):
        length = len(normalized(''.join(cue['lines'])))
        if not length:
            raise ValueError('Empty spoken caption')
        first, last = letters[offset][1], letters[offset + length - 1][1]
        delta = (cue['start'] - first['start']) * 1000
        tail = (cue['end'] - last['end']) * 1000
        checks.append({'cue': index + 1, 'start_delta_ms': round(delta, 3),
                       'tail_ms': round(tail, 3), 'within_target':
                       abs(delta) <= tolerance_ms + .5 and abs(tail) <= tolerance_ms + .5,
                       'within_half_frame_tolerance': max(abs(delta), abs(tail)) <= tolerance_ms + 500 / fps})
        offset += length
    return {'coverage_complete': True, 'text_differences': [], 'cues': checks,
            'max_start_offset_ms': max((abs(c['start_delta_ms']) for c in checks), default=0),
            'max_tail_ms': max((c['tail_ms'] for c in checks), default=0),
            'outside_target': [c['cue'] for c in checks if not c['within_target']],
            'frame_rounding_allowance_ms': round(500 / fps, 3),
            'outside_frame_tolerance': [c['cue'] for c in checks if not c['within_half_frame_tolerance']]}


def shot_fragments(clip, cuts, fps=30, minimum_seconds=.8):
    """Flag internal montage shots AND the truncated first/last shot in a clip."""
    first, last = (clip['sourceRange'][k] / 1e6 for k in ('start', 'end'))
    left, right = (clip['timelineRange'][k] / fps for k in ('fromFrame', 'toFrame'))
    rate = (last - first) / (right - left)
    points = [first] + sorted(set(c for c in cuts if first < c < last)) + [last]
    return [{'source_start': a, 'source_end': b,
             'timeline_start': left + (a - first) / rate,
             'duration_seconds': (b - a) / rate,
             'short_candidate': (b - a) / rate < minimum_seconds - 1e-6}
            for a, b in zip(points, points[1:])]


def semantic_anchors(words, entries, anchors, fps=30):
    """Check declared visual coverage of whole spoken clauses, not their meaning.

    The editor selects these item IDs after looking at the actual action. A
    successful interval check cannot establish that an unrelated shot is proof.
    """
    letters = [(char, word) for word in words for char in normalized(word['text'])]
    text = ''.join(char for char, _ in letters)
    items = {e['id']: e for e in entries if e.get('kind') == 'item'}
    checks, issues = [], []
    for anchor in anchors:
        phrase = normalized(anchor['phrase'])
        if not phrase or not anchor.get('visual_item_ids') or not anchor.get('visual_basis'):
            raise ValueError('Semantic anchor needs phrase, visual_item_ids and visual_basis')
        matches, pos = [], 0
        while (pos := text.find(phrase, pos)) >= 0:
            matches.append(pos)
            pos += len(phrase)
        occurrence = anchor.get('occurrence')
        if not matches or (occurrence is None and len(matches) != 1):
            issues.append({'kind': 'unresolved_phrase', 'phrase': anchor['phrase'],
                           'matches': len(matches)})
            continue
        occurrence = 1 if occurrence is None else occurrence
        if not isinstance(occurrence, int) or not 1 <= occurrence <= len(matches):
            raise ValueError('Anchor occurrence is outside phrase matches')
        offset = matches[occurrence - 1]
        start, end = letters[offset][1]['start'], letters[offset + len(phrase) - 1][1]['end']
        hold = anchor.get('hold_ms', 100) / 1000
        if hold < 0:
            raise ValueError('Anchor hold must be nonnegative')
        intervals = []
        for item_id in anchor['visual_item_ids']:
            item = items.get(item_id)
            if item is None or item.get('itemType') not in ('video', 'image', 'motion-graphic'):
                raise ValueError('Anchor refers to missing/nonvisual item: ' + item_id)
            intervals.append(tuple(item['timelineRange'][k] / fps for k in ('fromFrame', 'toFrame')))
        cursor, gaps = start, []
        for left, right in sorted(intervals):
            if right <= cursor or left >= end + hold:
                continue
            if left > cursor + .001:
                gaps.append([cursor, min(left, end + hold)])
            cursor = max(cursor, right)
        if cursor < end + hold - .001:
            gaps.append([cursor, end + hold])
        check = {'phrase': anchor['phrase'], 'speech_start': round(start, 3),
                 'speech_end': round(end, 3), 'required_hold_ms': hold * 1000,
                 'timing_covered': not gaps, 'uncovered_seconds': gaps,
                 'visual_item_ids': anchor['visual_item_ids'], 'visual_basis': anchor['visual_basis']}
        checks.append(check)
        if gaps:
            issues.append({'kind': 'visual_leaves_clause', **check})
    return {'status': 'checked' if anchors else 'unverified', 'checks': checks, 'issues': issues,
            'note': 'Checks editor-declared shot intervals only; pixels must establish semantic relevance.'}


def transition_handles(entries, cuts_by_asset, fps=30):
    """Flag source cuts pulled into a transition from outside visible clip bounds."""
    items = {e['id']: e for e in entries if e.get('itemType') == 'video'}
    issues = []
    for transition in entries:
        if transition.get('kind') != 'transition':
            continue
        for side, key in [('head', 'incomingItemId'), ('tail', 'outgoingItemId')]:
            item = items.get(transition.get(key))
            if not item:
                continue
            first, last = (item['sourceRange'][k] / 1e6 for k in ('start', 'end'))
            left, right = (item['timelineRange'][k] for k in ('fromFrame', 'toFrame'))
            rate = (last - first) / ((right - left) / fps)
            if side == 'head':
                handle = max(0, left - transition['timelineRange']['fromFrame']) / fps * rate
                crossed = [c for c in cuts_by_asset[item['asset']['id']]
                           if first - handle + 1e-6 < c <= first + 1e-6]
            else:
                handle = max(0, transition['timelineRange']['toFrame'] - right) / fps * rate
                crossed = [c for c in cuts_by_asset[item['asset']['id']]
                           if last - 1e-6 <= c < last + handle - 1e-6]
            if handle > 0 and crossed:
                issues.append({'transition_id': transition['id'], 'item_id': item['id'],
                               'side': side, 'handle_seconds': handle, 'source_cuts': crossed})
    return issues


def voice_controls(sources):
    """Detect control drift, deliberately excluding text, job and billing fields."""
    fields = ('provider', 'voiceId', 'modelId', 'speedRatio', 'speed', 'pitch',
              'loudnessRatio', 'explicitLanguage', 'performancePrompt', 'emotion',
              'emotionScale', 'stability')
    rows, missing = [], []
    for source in sources:
        asset = next((v['asset'] for v in source['data'] if 'asset' in v), {})
        params = asset.get('generationRecord', {}).get('params', {})
        if not params.get('voiceId'):
            missing.append(source['assetId'])
            continue
        rows.append({'asset_id': source['assetId'],
                     'controls': {k: params[k] for k in fields if k in params}})
    differences = []
    if rows:
        baseline = rows[0]
        for row in rows[1:]:
            keys = set(baseline['controls']) | set(row['controls'])
            changed = {k: {'reference': baseline['controls'].get(k), 'actual': row['controls'].get(k)}
                       for k in sorted(keys) if baseline['controls'].get(k) != row['controls'].get(k)}
            if changed:
                differences.append({'asset_id': row['asset_id'], 'changes': changed})
    return {'reference_asset_id': rows[0]['asset_id'] if rows else None,
            'recorded_controls_match': bool(rows) and not missing and not differences,
            'missing_records': missing, 'differences': differences,
            'note': 'Matching generation controls does not certify matching timbre or a natural performance.'}


def parse_cards(text):
    cards = []
    for line in text.splitlines():
        match = re.match(r'^\[C(\d+)\].*? frame=(\d+)-(\d+) text=("(?:[^"\\]|\\.)*")', line)
        if match:
            _, start, end, raw = match.groups()
            layout = re.search(r' layoutLines=(\[.*\])$', line)
            cards.append({'start_frame': int(start), 'end_frame': int(end),
                          'lines': json.loads(layout.group(1)) if layout else json.loads(raw).split(' / ')})
    if not cards:
        raise ValueError('No ChatCut cards found; inspect current response schema')
    return cards


def compare_cards(cues, cards, fps=30):
    if len(cues) != len(cards):
        return {'matches': False, 'reason': 'Different cue/card counts'}
    mismatches = []
    for i, (cue, card) in enumerate(zip(cues, cards)):
        if (normalized(''.join(cue['lines'])) != normalized(''.join(card['lines'])) or
            abs(cue['start'] - card['start_frame'] / fps) > .001 or
            abs(cue['end'] - card['end_frame'] / fps) > .001):
            mismatches.append(i + 1)
    return {'matches': not mismatches, 'mismatched_cues': mismatches}


def speech_rates(words):
    """Do not count intervening chapters as speech when one asset is reordered."""
    rows = []
    for aid in dict.fromkeys(w['asset_id'] for w in words):
        selected = [w for w in words if w['asset_id'] == aid]
        span = max(w['end'] for w in selected) - min(w['start'] for w in selected)
        groups = {}
        for word in selected:
            groups.setdefault(word['item_id'], []).append(word)
        active = sum(max(w['end'] for w in group) - min(w['start'] for w in group)
                     for group in groups.values())
        rows.append({'asset_id': aid, 'timeline_span_seconds': round(span, 3),
                     'spoken_span_seconds': round(active, 3),
                     'characters_per_second': round(sum(len(normalized(w['text'])) for w in selected) / active, 3),
                     'note': 'Sums measured speech spans within placed clips; not a timbre/listening judgment.'})
    return rows


def review(evidence, cues, cuts_by_asset, fps=30):
    state = evidence['timeline'].get('state', {})
    if state.get('fps', fps) != fps:
        raise ValueError('Timeline fps differs from diagnostic fps')
    timeline = evidence['timeline']['timeline']
    if timeline.get('totalEntries', len(timeline['entries'])) != len(timeline['entries']):
        raise ValueError('Need all timeline pages, not a partial entry list')
    sources = {}
    for source in evidence['voice_sources']:
        transcript = next(v['transcript'] for v in source['data'] if 'transcript' in v)
        if transcript.get('status') != 'available' or transcript.get('truncated'):
            raise ValueError('Need complete, ready source transcripts')
        ranges = transcript['ranges']
        if any(r.get('truncated') for r in ranges):
            raise ValueError('Truncated transcript range')
        sources[source['assetId']] = [w for r in ranges for w in r['segments']]
    entries = timeline['entries']
    clips = [c for c in entries if c.get('kind') == 'item' and c.get('trackAlias') == 'A1']
    if not clips or not cues:
        raise ValueError('Need final A1 narration and exported subtitles')
    words, issues = project_words(clips, sources, fps)
    shots = []
    for clip in entries:
        if clip.get('kind') != 'item' or clip.get('itemType') != 'video':
            continue
        aid = clip['asset']['id']
        if aid not in cuts_by_asset:
            raise ValueError('Missing source cut evidence for ' + aid)
        shots.extend(dict(s, item_id=clip['id']) for s in shot_fragments(clip, cuts_by_asset[aid], fps))
    rates = speech_rates(words)
    return {'caption_sync': check_captions(cues, words, fps=fps), 'source_window_issues': issues,
            'transition_handle_candidates': transition_handles(entries, cuts_by_asset, fps),
            'semantic_anchors': semantic_anchors(words, entries, evidence.get('semantic_anchors', []), fps),
            'voice_controls': voice_controls(evidence['voice_sources']),
            'export_matches_cards': compare_cards(cues, parse_cards(evidence['captions_text']), fps),
            'retained_shots': shots, 'short_shot_candidates': [s for s in shots if s['short_candidate']],
            'speech_rates': rates, 'audio_listening': 'unverified',
            'note': 'ASR timestamps and scene cuts are diagnostic evidence, not an auditory or continuous visual review.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--srt', required=True)
    parser.add_argument('--cuts', required=True, help='JSON object mapping video asset ID to source cut seconds')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    report = review(json.loads(Path(args.evidence).read_text()), parse_srt(args.srt),
                    json.loads(Path(args.cuts).read_text()))
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'retained_shots'}, ensure_ascii=False, indent=2))
    sync = report['caption_sync']
    return 0 if (sync['coverage_complete'] and not sync['outside_frame_tolerance'] and
                 not report['source_window_issues'] and report['export_matches_cards']['matches'] and
                 not report['semantic_anchors']['issues'] and
                 not report['transition_handle_candidates'] and
                 not report['short_shot_candidates']) else 2


if __name__ == '__main__':
    raise SystemExit(main())
