#!/usr/bin/env python3
"""Match actual TTS source waveforms against the final mix; not speech recognition.

Uses gain-invariant correlations, source trims and actual playback rates. Weak or
ambiguous matches remain unverified; unrelated BGM cannot establish narration.
"""
import array
import math
from pathlib import Path
import subprocess
import sys
import tempfile

import studio

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
    """Envelope search narrows the acoustic sample-level search without new deps."""
    hop = 10
    coarse_ref = envelope(reference, hop)
    coarse_position = round(expected / hop)
    coarse_radius = math.ceil(max_shift * RATE / hop)
    candidates = []
    for channel, env in enumerate(envelopes):
        rows = []
        for offset in range(-coarse_radius, coarse_radius + 1):
            first = coarse_position + offset
            if first < 0 or first + len(coarse_ref) > len(env): continue
            score = correlation(coarse_ref, env[first:first + len(coarse_ref)])
            rows.append((score, first * hop))
        peaks = []
        for score, position in sorted(rows, reverse=True):
            if all(abs(position - old) > 3 * hop for old in peaks): peaks.append(position)
            if len(peaks) >= 3: break
        # Always inspect the expected location, including low-envelope dynamics.
        peaks.append(expected)
        visited = set()
        for peak in peaks:
            for first in range(max(0, peak - hop), peak + hop + 1):
                if first in visited or first + len(reference) > len(channels[channel]): continue
                visited.add(first)
                score = abs(correlation(reference, channels[channel][first:first + len(reference)]))
                candidates.append((score, first, channel))
    if not candidates: return {"correlation": 0.0, "offset_ms": None, "ambiguous": True, "channel": None}
    best = max(candidates)
    alternative = max((score for score, position, _ in candidates if abs(position - best[1]) > RATE * .04), default=0)
    return {"correlation": round(best[0], 5), "offset_ms": round((best[1] - expected) / RATE * 1000, 3),
            "channel": best[2], "ambiguous": best[0] >= .55 and alternative >= best[0] - .015,
            "alternative_correlation": round(alternative, 5)}


def check(video, evidence, run, fps):
    root = Path(run).resolve()
    result = {"schema": 1, "status": "unverified", "method": "source_waveform_to_final_mix", "windows": [], "hard_failures": [],
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
