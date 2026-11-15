#!/usr/bin/env python3
"""Match actual TTS source waveforms against the final mix; not speech recognition.

Uses gain-invariant correlations, source trims and actual playback rates. Weak or
ambiguous matches remain unverified; unrelated BGM cannot establish narration.
"""
import array
import math
from operator import mul
from pathlib import Path
import subprocess
import sys
import tempfile

import studio
import review_sync

RATE = 2000


def decode(file, target, filters=None, stream=None):
    media = studio.probe_media(file)
    streams = [s for s in media["streams"] if s.get("codec_type") == "audio"]
    selected = next((s for s in streams if s.get("disposition", {}).get("default")), streams[0] if streams else None)
    if selected is None: raise ValueError("No audio in referenced media")
    if stream is not None: selected = next(s for s in streams if s["index"] == stream)
    channels = int(selected.get("channels") or 1)
    if not 0 < channels <= 32: raise ValueError("Unsupported audio channels")
    command = [studio.native_tool("ffmpeg"), "-v", "error", "-y", "-i", str(file), "-map", "0:" + str(selected["index"]), "-vn"]
    # Honor encoded timestamps, including AAC gaps/initial silence; raw PCM alone
    # would concatenate packets and falsely move a delayed narration to time zero.
    command += ["-af", ",".join(filter(None, [filters, "aresample=%d:async=1:first_pts=0" % RATE]))]
    command += ["-ar", str(RATE), "-c:a", "pcm_f32le", "-f", "f32le", str(target)]
    process = subprocess.run(command, capture_output=True, text=True, timeout=900)
    if process.returncode: raise ValueError("Audio reference decode failed: " + process.stderr[-500:])
    values = array.array("f"); values.frombytes(target.read_bytes())
    if sys.byteorder != "little": values.byteswap()
    if len(values) % channels or any(not math.isfinite(v) for v in values): raise ValueError("Invalid reference PCM")
    return [values[c::channels] for c in range(channels)]


def tempo_filters(rate):
    if not math.isfinite(rate) or not .125 <= rate <= 8: raise ValueError("Unsupported narration playback rate")
    filters = []
    while rate > 2: filters.append("atempo=2"); rate /= 2
    while rate < .5: filters.append("atempo=0.5"); rate /= .5
    if abs(rate - 1) > 1e-7: filters.append("atempo=%.12g" % rate)
    return filters


def envelope(values, hop=10):
    return [math.sqrt(sum(v * v for v in values[i:i + hop]) / len(values[i:i + hop])) for i in range(0, len(values), hop)]


def correlation(reference, candidate):
    if len(reference) != len(candidate) or not reference: return 0.0
    avg = sum(reference) / len(reference)
    centered = [v - avg for v in reference]
    power = sum(v * v for v in centered)
    other_sum = sum(candidate)
    other_power = sum(v * v for v in candidate) - other_sum * other_sum / len(candidate)
    denominator = math.sqrt(max(0, power * other_power))
    return sum(a * b for a, b in zip(centered, candidate)) / denominator if denominator > 1e-14 else 0.0


def match_window(reference, channels, envelopes, expected, max_shift=.3):
    """Search every sample in the permitted range, including competing peaks.

    Envelope peaks are not sound-wave peaks: flat energy or a music bed can
    hide either the true match or an equally good, ambiguous second match.
    """
    size = len(reference)
    if not size: return {"correlation": 0.0, "offset_ms": None, "ambiguous": True, "channel": None}
    mean = sum(reference) / size
    centered = [v - mean for v in reference]
    power = sum(v * v for v in centered)
    radius = math.ceil(max_shift * RATE)
    candidates = []
    for channel, values in enumerate(channels):
        start, end = max(0, expected - radius), min(len(values) - size, expected + radius)
        if start > end: continue
        total = sum(values[start:start + size]); squares = sum(v * v for v in values[start:start + size])
        for first in range(start, end + 1):
            denominator = math.sqrt(max(0, power * (squares - total * total / size)))
            score = abs(sum(map(mul, centered, values[first:first + size]))) / denominator if denominator > 1e-14 else 0.0
            candidates.append((score, first, channel))
            if first < end:
                old, new = values[first], values[first + size]
                total += new - old; squares += new * new - old * old
    if not candidates: return {"correlation": 0.0, "offset_ms": None, "ambiguous": True, "channel": None}
    best = max(candidates)
    alternative = max((score for score, position, _ in candidates if abs(position - best[1]) > RATE * .04), default=0)
    return {"correlation": round(best[0], 5), "offset_ms": round((best[1] - expected) / RATE * 1000, 3),
            "channel": best[2], "ambiguous": best[0] >= .55 and alternative >= best[0] - .015,
            "alternative_correlation": round(alternative, 5)}


def source_word_activity(evidence, clip, samples, fps):
    """Measure the actual source at exact projected ASR bounds; never alter ASR."""
    try:
        row = next(r for r in evidence['voice_sources'] if r['assetId'] == clip['asset']['id'])
        transcript = next(v['transcript'] for v in row['data'] if 'transcript' in v)
        if transcript.get('status') != 'available' or transcript.get('truncated') or any(r.get('truncated') for r in transcript['ranges']): return []
        words, issues = review_sync.project_words([clip], {row['assetId']: [w for r in transcript['ranges'] for w in r['segments']]}, fps)
        if issues: return []
        left = clip['timelineRange']['fromFrame'] / fps
        result = []
        for word in words:
            first, last = round((word['start'] - left) * RATE), round((word['end'] - left) * RATE)
            if not 0 <= first < last <= len(samples): continue
            # A whole-word average dilutes short consonants in broad ASR bounds.
            # Use 20 ms peak windows, finer than the mix detector's 100 ms bins.
            windows = [samples[i:min(i + round(.02 * RATE), last)] for i in range(first, last, round(.02 * RATE))]
            rms = max(math.sqrt(sum(v * v for v in window) / len(window)) for window in windows)
            result.append({'item_id': clip['id'], 'text': word['text'], 'from': word['start'], 'to': word['end'],
                           'rms_dbfs': 20 * math.log10(max(rms, 1e-12)), 'measurement':'peak_20ms_source_rms'})
        return result
    except (KeyError, TypeError, ValueError, StopIteration): return []


def check(video, evidence, run, fps):
    root = Path(run).resolve()
    result = {"schema": 2, "status": "unverified", "method": "source_waveform_to_final_mix", "search": "exhaustive_sample_offsets", "windows": [], "source_word_activity": [], "hard_failures": [],
              "limitations": ["Waveform matching verifies presence/timing of supplied TTS audio, not pronunciation or subjective listening quality.",
                              "Weak or multi-peak matches and very short clips require further evidence; they are not accepted automatically."]}
    try:
        if not isinstance(evidence, dict) or not evidence.get("voice_files"): raise ValueError("Actual TTS voice_files are missing")
        timeline = evidence["timeline"]["timeline"]
        entries = timeline["entries"]
        if timeline.get("totalEntries") != len(entries): raise ValueError("Incomplete actual timeline")
        wanted = set(evidence["narration_tracks"])
        tracks = [t for t in timeline["tracks"] if wanted.intersection((t["id"], t.get("alias")))]
        resolved = {x for t in tracks for x in (t["id"], t.get("alias")) if x in wanted}
        if not wanted or resolved != wanted or any(t.get("muted") for t in tracks): raise ValueError("Missing/muted narration track")
        track_ids = {t["id"] for t in tracks}
        clips = [c for c in entries if c.get("kind") == "item" and c.get("trackId") in track_ids and c.get("itemType") in {"audio", "video"}]
        if not clips: raise ValueError("No actual narration clips")
        references = {}
        for row in evidence["voice_files"]:
            file = Path(row["path"]).resolve(strict=True)
            if not file.is_relative_to(root) or studio.file_hash(file) != row["sha256"]: raise ValueError("TTS file missing, outside run, or changed")
            if row["assetId"] in references: raise ValueError("Duplicate voice file asset identity")
            references[row["assetId"]] = file
        missing = [c["asset"]["id"] for c in clips if c["asset"]["id"] not in references]
        if missing: raise ValueError("Missing actual TTS files for " + ", ".join(missing))
        with tempfile.TemporaryDirectory(prefix="narration-alignment-") as temp:
            temp = Path(temp)
            mix = decode(video, temp / "mix.raw")
            envs = [envelope(c) for c in mix]
            for index, clip in enumerate(clips):
                first, last = (clip["sourceRange"][k] / 1e6 for k in ("start", "end"))
                left, right = (clip["timelineRange"][k] / fps for k in ("fromFrame", "toFrame"))
                if not 0 <= first < last or not 0 <= left < right: raise ValueError("Invalid actual source/timeline window")
                rate = (last - first) / (right - left)
                chain = ["atrim=start=%.12g:end=%.12g" % (first, last), "asetpts=PTS-STARTPTS", *tempo_filters(rate)]
                decoded = decode(references[clip["asset"]["id"]], temp / (str(index) + ".raw"), ",".join(chain))
                source = max(decoded, key=lambda c: sum(v * v for v in c))
                if abs(len(source) / RATE - (right - left)) > .1 + 1 / fps:
                    raise ValueError("Decoded TTS reference does not cover its actual timeline window")
                result['source_word_activity'].extend(source_word_activity(evidence, clip, source, fps))
                usable = min(len(source), round((right - left) * RATE))
                if usable < RATE * .25:
                    result["windows"].append({"item_id": clip["id"], "from": left, "to": right, "status": "unverified", "reason": "Source window shorter than 250 ms"})
                    continue
                measured = 0
                size = min(round(.75 * RATE), usable)
                starts = sorted(set([*range(0, max(1, usable - size + 1), round(.6 * RATE)), usable - size]))
                for offset in starts:
                    reference = source[offset:offset + size]
                    rms = math.sqrt(sum(v * v for v in reference) / len(reference))
                    if rms < .00001: continue  # Digital silence cannot establish a speech match; gain is otherwise irrelevant.
                    expected = round(left * RATE) + offset
                    match = match_window(reference, mix, envs, expected)
                    tolerance = 80 + 1000 / fps
                    if match["correlation"] >= .55 and not match["ambiguous"]:
                        status = "pass" if abs(match["offset_ms"]) <= tolerance else "fail"
                    else: status = "unverified"
                    row = {"item_id": clip["id"], "asset_id": clip["asset"]["id"], "from": expected / RATE,
                           "to": (expected + size) / RATE, "playback_rate": rate, "tolerance_ms": tolerance, **match, "status": status}
                    result["windows"].append(row); measured += 1
                if not measured:
                    result["windows"].append({"item_id": clip["id"], "from": left, "to": right, "status": "unverified", "reason": "No sufficiently audible reference window"})
        if any(w["status"] == "fail" for w in result["windows"]): result["hard_failures"].append("narration_waveform_offset_exceeds_tolerance")
        result["status"] = "checked" if result["windows"] and all(w["status"] == "pass" for w in result["windows"]) else "fail" if result["hard_failures"] else "unverified"
        if result["status"] == "unverified": result["reason"] = "Narration presence/alignment is not established for every audible reference window"
        return result
    except (OSError, KeyError, ValueError, TypeError, StopIteration, subprocess.SubprocessError) as exc:
        return {**result, "status": "unverified", "reason": str(exc)}
