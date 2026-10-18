#!/usr/bin/env python3
"""Find pacing/reuse candidates; pixel-based editorial decisions remain explicit."""
import argparse
import json
import math
from pathlib import Path

from review_sync import project_words, shot_fragments


def candidates(words, entries, fps=30, visual_tracks=('V1',), cuts=None):
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError('Invalid FPS')
    merged = []
    for word in sorted(words, key=lambda w: w['start']):
        a, b = word['start'], word['end']
        if not all(math.isfinite(v) for v in (a, b)) or a < 0 or b <= a:
            raise ValueError('Invalid projected word interval')
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(b, merged[-1][1])
        else:
            merged.append([a, b])
    result = []
    for before, after in zip(merged, merged[1:]):
        if after[0] - before[1] >= 1.5:
            result.append({'id': f'pause:{before[1]:.3f}:{after[0]:.3f}',
                           'kind': 'long_narration_pause', 'from': before[1],
                           'to': after[0], 'seconds': after[0] - before[1]})
    visuals = [e for e in entries if e.get('kind') == 'item' and
               e.get('itemType') in ('video', 'image', 'motion-graphic') and
               (e.get('trackAlias') in visual_tracks or e.get('trackId') in visual_tracks)]
    for item in visuals:
        span = (item['timelineRange']['toFrame'] - item['timelineRange']['fromFrame']) / fps
        aid = item.get('asset', {}).get('id')
        if item['itemType'] == 'video' and cuts is not None and aid in cuts:
            span = max(s['duration_seconds'] for s in shot_fragments(item, cuts[aid], fps))
        if span > 8:
            result.append({'id': 'hold:' + item['id'], 'kind': 'long_visual_hold',
                           'item_id': item['id'], 'seconds': span,
                           'note': 'May be a necessary complete action; inspect before trimming.'})
    videos = [e for e in visuals if e['itemType'] == 'video']
    for i, left in enumerate(videos):
        for right in videos[i+1:]:
            if left['asset']['id'] != right['asset']['id']:
                continue
            a, b = left['timelineRange'], right['timelineRange']
            # A simultaneous detail inset is not a later replay.
            if max(a['fromFrame'], b['fromFrame']) < min(a['toFrame'], b['toFrame']):
                continue
            x, y = left['sourceRange'], right['sourceRange']
            overlap = max(0, min(x['end'], y['end']) - max(x['start'], y['start'])) / 1e6
            smaller = min(x['end']-x['start'], y['end']-y['start']) / 1e6
            if smaller <= 0:
                raise ValueError('Invalid source interval')
            if overlap >= 1.5 and overlap / smaller >= .5:
                ids = sorted([left['id'], right['id']])
                result.append({'id': 'repeat:' + ':'.join(ids), 'kind': 'reused_source_window',
                               'item_ids': ids, 'source_overlap_seconds': overlap,
                               'note': 'A replay needs a new explanatory purpose; a replay label alone is insufficient.'})
    return result


def check(evidence):
    try:
        if not isinstance(evidence, dict):
            raise ValueError('No final timeline/ASR evidence')
        state = evidence['timeline']['state']
        timeline = evidence['timeline']['timeline']
        entries, fps = timeline['entries'], state['fps']
        if timeline.get('totalEntries') != len(entries):
            raise ValueError('Need all timeline pages')
        selected = evidence.get('narration_tracks', ['A1'])
        clips = [e for e in entries if e.get('kind') == 'item' and
                 (e.get('trackAlias') in selected or e.get('trackId') in selected) and
                 e.get('itemType') in ('audio', 'video')]
        sources = {}
        for source in evidence['voice_sources']:
            t = next(v['transcript'] for v in source['data'] if 'transcript' in v)
            if t.get('status') != 'available' or t.get('truncated') or not t.get('ranges') or any(r.get('truncated') for r in t['ranges']):
                raise ValueError('Need complete measured narration transcripts')
            sources[source['assetId']] = [w for r in t['ranges'] for w in r['segments']]
        words, issues = project_words(clips, sources, fps)
        if issues or not words:
            raise ValueError('Resolve missing/partial/repeated narration words')
        rows = candidates(words, entries, fps, evidence.get('visual_tracks', ['V1']), evidence.get('source_cuts'))
        review = evidence.get('editorial_review', {})
        resolutions = review.get('resolutions', {})
        for row in rows:
            decision = resolutions.get(row['id'], {})
            valid = decision.get('decision') == 'keep' and bool(decision.get('basis')) and bool(decision.get('frames'))
            row['review'] = decision if valid else {'decision': 'pending'}
        pending = [r['id'] for r in rows if r['review']['decision'] == 'pending']
        # Automation cannot infer whether a hook is specific or a crop is appropriate.
        for key in ('opening', 'layout'):
            decision = review.get(key, {})
            if not decision.get('basis') or not decision.get('frames'):
                pending.append(key + '_pixel_review')
        return {'check': 'editorial_structure', 'status': 'needs_review' if pending else 'pass',
                'candidates': rows, 'pending': pending, 'manual_evidence': review,
                'longest_internal_pause_seconds': max((b['start']-a['end'] for a,b in zip(words, words[1:])), default=0),
                'note': 'Thresholds locate candidates, not automatic cuts or a quality score. Pixel evidence and listening remain separate.'}
    except (KeyError, ValueError, TypeError, StopIteration, ZeroDivisionError) as exc:
        return {'check': 'editorial_structure', 'status': 'unverified', 'reason': str(exc)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--evidence', required=True)
    p.add_argument('--output', required=True)
    args = p.parse_args()
    result = check(json.loads(Path(args.evidence).read_text()))
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['status'] == 'pass' else 2


if __name__ == '__main__':
    raise SystemExit(main())
