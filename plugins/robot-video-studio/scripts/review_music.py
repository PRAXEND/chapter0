#!/usr/bin/env python3
"""Read-only pause-level diagnostics on the exported mix; never certifies listening."""
import argparse
import array
import json
import math
from pathlib import Path
import statistics
import sys
import tempfile
import wave

from review_sync import project_words, spoken
from studio import StudioError, execute, file_hash, read, write

DEFAULTS = {'min_pause_seconds': .20, 'guard_seconds': .04,
            'window_seconds': .10, 'step_seconds': .05,
            'rise_db': 6.0, 'audible_floor_dbfs': -40.0}


def merge(intervals):
    result = []
    for a, b in sorted(intervals):
        if not all(math.isfinite(x) for x in (a, b)) or a < 0 or b <= a:
            raise ValueError('Invalid interval')
        if result and a <= result[-1][1] + 1e-6:
            result[-1][1] = max(b, result[-1][1])
        else:
            result.append([a, b])
    return result


def selectors(value, name):
    if not isinstance(value, list) or not value or any(not isinstance(x, str) or not x for x in value):
        raise ValueError(name + ' must contain explicit track aliases or IDs')
    return set(value)


def context(evidence):
    """Reuse measured ASR projection, including pauses inside an uncut voice clip."""
    state = evidence['timeline']['state']
    fps, frames = state['fps'], state['durationFrames']
    if not isinstance(fps, (int, float)) or not math.isfinite(fps) or fps <= 0:
        raise ValueError('Invalid FPS')
    if not isinstance(frames, int) or frames <= 0:
        raise ValueError('Invalid durationFrames')
    timeline = evidence['timeline']['timeline']
    entries = timeline['entries']
    if timeline.get('totalEntries') != len(entries):
        raise ValueError('Need complete timeline pages')
    music = selectors(evidence.get('music_tracks'), 'music_tracks')
    narration = selectors(evidence.get('narration_tracks', ['A1']), 'narration_tracks')
    tracks = timeline['tracks']
    def selected(group):
        matching = [t for t in tracks if group.intersection((t['id'], t['alias']))]
        resolved = {s for s in group if any(s in (t['id'], t['alias']) for t in matching)}
        if resolved != group:
            raise ValueError('Track selector does not resolve')
        return {t['id'] for t in matching if not t.get('muted')}
    music_ids, narration_ids = selected(music), selected(narration)
    if music_ids & narration_ids:
        raise ValueError('Music and narration must be separate tracks')
    bed = [(x['timelineRange']['fromFrame']/fps, x['timelineRange']['toFrame']/fps)
           for x in entries if x.get('kind') == 'item' and x.get('itemType') == 'audio' and x['trackId'] in music_ids]
    clips = [x for x in entries if x.get('kind') == 'item' and x.get('itemType') in ('audio', 'video') and x['trackId'] in narration_ids]
    if not clips:
        raise ValueError('No audible narration clips')
    sources = {}
    for source in evidence.get('voice_sources', []):
        transcript = next((v['transcript'] for v in source['data'] if 'transcript' in v), {})
        ranges = transcript.get('ranges', [])
        if transcript.get('status') != 'available' or transcript.get('truncated') or not ranges or any(r.get('truncated') for r in ranges):
            raise ValueError('Need complete measured narration transcripts')
        words = [w for r in ranges for w in r['segments']]
        for w in words:
            if spoken(w) and (not all(isinstance(w[k], (int, float)) and math.isfinite(w[k]) for k in ('startMs', 'endMs')) or not 0 <= w['startMs'] < w['endMs']):
                raise ValueError('Invalid measured word time')
        sources[source['assetId']] = words
    words, issues = project_words(clips, sources, fps)
    if issues or not words:
        raise ValueError('Resolve partial/repeated/missing narration words first')
    voice = merge((w['start'], w['end']) for w in words)
    duration = frames / fps
    if voice[-1][1] > duration + .001 or any(b > duration + .001 for _, b in bed):
        raise ValueError('Intervals exceed timeline duration')
    return voice, merge(bed), duration


def decode(video):
    # Stereo sample energy, not a mono sum: opposite-phase music must not vanish.
    with tempfile.TemporaryDirectory(prefix='rvs-music-check-') as tmp:
        dest = Path(tmp)/'mix.wav'
        execute(['ffmpeg', '-v', 'error', '-i', Path(video).resolve(), '-vn', '-ac', '2', '-ar', '24000',
                 '-t', '121', '-c:a', 'pcm_s16le', '-f', 'wav', dest], timeout=180)
        with wave.open(str(dest)) as audio:
            rate, channels = audio.getframerate(), audio.getnchannels()
            if audio.getsampwidth() != 2:
                raise ValueError('Expected 16-bit PCM')
            samples = array.array('h', audio.readframes(audio.getnframes()))
    if sys.byteorder != 'little':
        samples.byteswap()
    return samples, rate, channels


def scan(samples, rate, channels, voice, bed, duration, config=None):
    cfg = {**DEFAULTS, **(config or {})}
    if set(cfg) != set(DEFAULTS) or not all(isinstance(x, (int, float)) and math.isfinite(x) for x in cfg.values()):
        raise ValueError('Invalid detector configuration')
    if any(cfg[x] <= 0 for x in ('min_pause_seconds', 'window_seconds', 'step_seconds', 'rise_db')) or cfg['guard_seconds'] < 0:
        raise ValueError('Invalid detector window/threshold')
    if rate <= 0 or channels <= 0 or len(samples) % channels or len(samples)/channels/rate < duration - .04:
        raise ValueError('Decoded audio does not cover the whole timeline')
    def level(a, b):
        block = samples[round(a*rate)*channels:round(b*rate)*channels]
        if not block:
            raise ValueError('Empty audio measurement')
        power = sum(int(x)*int(x) for x in block) / len(block) / 32768**2
        return 10 * math.log10(max(power, 1e-12))
    speech, music = merge(voice), merge(bed)
    pauses = []
    # Only internal gaps: deliberate intro/outro ramps are a separate editorial check.
    for before, after in zip(speech, speech[1:]):
        left, right = before[1], after[0]
        if right-left < cfg['min_pause_seconds']-1e-6:
            continue
        if not any(a < right and b > left for a, b in music):
            continue
        row = {'from': round(left, 6), 'to': round(right, 6), 'windows': []}
        start, end = left+cfg['guard_seconds'], right-cfg['guard_seconds']
        n = 0
        while start+n*cfg['step_seconds']+cfg['window_seconds'] <= end+1e-7:
            a = start+n*cfg['step_seconds']; b = a+cfg['window_seconds']
            row['windows'].append({'from': round(a, 6), 'to': round(b, 6), 'rms_dbfs': round(level(a, b), 3)})
            n += 1
        windows = row['windows']
        if len(windows) < 3:
            row['status'] = 'too_short_to_measure_rise'
        else:
            baseline = statistics.median(w['rms_dbfs'] for w in windows[:2])
            peak = max(windows[2:], key=lambda w: w['rms_dbfs'])
            rise = peak['rms_dbfs']-baseline
            row.update(baseline_dbfs=round(baseline, 3), peak_dbfs=peak['rms_dbfs'],
                       rise_db=round(rise, 3), peak_from=peak['from'])
            row['status'] = 'candidate' if rise >= cfg['rise_db'] and peak['rms_dbfs'] >= cfg['audible_floor_dbfs'] else 'no_rise_candidate'
        pauses.append(row)
    candidates = [p for p in pauses if p['status'] == 'candidate']
    return {'schema_version': 1, 'check': 'music_pause_levels', 'status': 'needs_review' if candidates else 'pass',
            'config': cfg, 'pauses': pauses, 'candidates': candidates,
            'measured_pauses': sum(p['status'] != 'too_short_to_measure_rise' for p in pauses),
            'audio_listening': 'unverified',
            'note': 'Measures short-term mixed-audio rises inside ASR pauses, not isolated music or listening quality. Short gaps and intro/outro are not certified.'}


def check_file(video, evidence, required=True):
    result = {'schema_version': 1, 'check': 'music_pause_levels', 'artifact_sha256': file_hash(video), 'audio_listening': 'unverified'}
    if evidence is None:
        return {**result, 'status': 'unverified' if required else 'not_applicable', 'reason': 'No final timeline/ASR evidence'}
    if not isinstance(evidence, dict):
        return {**result, 'status': 'unverified', 'reason': 'Evidence must be a JSON object'}
    if not evidence.get('music_tracks'):
        return {**result, 'status': 'unverified' if required else 'not_applicable', 'reason': 'No explicit music_tracks'}
    try:
        voice, bed, duration = context(evidence)
        if duration > 120.1:
            raise ValueError('Timeline exceeds the supported 120-second video')
        if not bed:
            return {**result, 'status': 'unverified' if required else 'not_applicable', 'reason': 'Selected music tracks have no audible audio items'}
        samples, rate, channels = decode(video)
        return {**scan(samples, rate, channels, voice, bed, duration), **result}
    except (StudioError, OSError, ValueError, KeyError, TypeError, AttributeError, StopIteration) as exc:
        return {**result, 'status': 'unverified', 'reason': str(exc)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--video', required=True)
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = check_file(args.video, read(args.evidence))
    result['evidence_sha256'] = file_hash(args.evidence)
    write(args.output, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['status'] == 'pass' else 2


if __name__ == '__main__':
    sys.exit(main())
