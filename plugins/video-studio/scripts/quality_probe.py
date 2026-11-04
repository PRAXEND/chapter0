#!/usr/bin/env python3
"""Create hashed visual samples and full-output objective audio evidence.

This produces diagnostics, never a model's visual review or a listening claim.
"""
import argparse
import array
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile

import studio
import review_sync
import review_music
import review_audio_alignment
from quality_policy import POLICY


def run_media(args, timeout=900, diagnostic_log=None):
    binary = studio.native_tool(args[0])
    if not binary:
        raise ValueError("Missing media tool: " + args[0])
    try:
        process = subprocess.run([binary, *map(str, args[1:])], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        if diagnostic_log is None:
            raise
        stderr = error.stderr or ""
        if isinstance(stderr, bytes): stderr = stderr.decode("utf-8", errors="replace")
        Path(diagnostic_log).write_text(f"Timed out after {timeout} seconds\n{stderr}", encoding="utf-8")
        raise ValueError("视频画面抽取超时，已保留项目和诊断日志。") from error
    if process.returncode:
        if diagnostic_log is not None:
            Path(diagnostic_log).write_text(process.stderr, encoding="utf-8")
            raise ValueError("视频画面抽取失败，详细原因已保存到当前项目的诊断日志。")
        raise ValueError("Media diagnostic failed: " + process.stderr[-1500:])
    return process


def frame_schedule(data, frames, fps, captions=()):
    """Actual export frame indices; every boundary gets native-rate context."""
    if frames < 1 or not math.isfinite(fps) or fps <= 0:
        raise ValueError("Invalid export duration or fps")
    chosen = {min(frames - 1, round(t * fps / 2)) for t in range(math.ceil(frames / fps * 2))}
    chosen.update((0, frames - 1))
    boundaries = {0, frames - 1}
    motion = []
    for beat in data.get("beats", []):
        for name in ("from_frame", "to_frame"):
            if type(beat.get(name)) is int:
                boundaries.add(beat[name])
        for design in beat.get("design_results", []):
            first, last = design.get("from_frame"), design.get("to_frame")
            if type(first) is int and type(last) is int and 0 <= first < last <= frames:
                motion.append((first, last)); boundaries.update((first, last))
                chosen.update(min(last - 1, first + round(t * fps / 8)) for t in range(math.ceil((last - first) / fps * 8)))
    for cue in captions:
        boundaries.update((round(cue["start"] * fps), round(cue["end"] * fps)))
    # Include all actual timeline item/transition boundaries, not just storyboard cuts.
    for entry in data.get("_timeline_entries", []):
        interval = entry.get("timelineRange", {})
        for key in ("fromFrame", "toFrame"):
            if type(interval.get(key)) is int:
                boundaries.add(interval[key])
    radius = max(2, math.ceil(fps * .25))
    windows = []
    for boundary in sorted(boundaries):
        if not 0 <= boundary <= frames:
            raise ValueError("Recorded boundary exceeds the final export")
        first, last = max(0, boundary - radius), min(frames - 1, boundary + radius)
        chosen.update(range(first, last + 1)); windows.append({"boundary": boundary, "from_frame": first, "to_frame": last})
    return {"sample_frames": sorted(chosen), "boundary_windows": windows,
            "motion_windows": [{"from_frame": a, "to_frame": b} for a, b in motion],
            "base_fps": 2, "motion_fps": 8}


def sample_selector(frames):
    if not frames or any(type(n) is not int or n < 0 for n in frames) or frames != sorted(set(frames)):
        raise ValueError("Sample frames must be nonempty, sorted, unique nonnegative integers")
    intervals = []
    for n in frames:
        if intervals and n == intervals[-1][1] + 1: intervals[-1][1] = n
        else: intervals.append([n, n])
    terms = ["eq(n,%d)" % a if a == b else "between(n,%d,%d)" % (a, b) for a, b in intervals]
    # FFmpeg's expression parser has bounded recursion. A linear addition chain
    # fails at ordinary video lengths; balance the tree without losing samples.
    def combine(first, last):
        if last - first == 1:
            return terms[first]
        middle = (first + last) // 2
        return "(" + combine(first, middle) + "+" + combine(middle, last) + ")"
    return combine(0, len(terms))


def contact_sheets(video, directory, schedule):
    filter_file = directory / "samples.filter"
    selector = sample_selector(schedule["sample_frames"])
    # Draw original decoded frame numbers before select; no inferred numbering.
    graph = ("scale=320:320:force_original_aspect_ratio=decrease,pad=320:350:(ow-iw)/2:0:black,"
             "drawtext=text='frame %{n}':fontcolor=white:fontsize=18:x=8:y=328,"
             "select='" + selector + "',tile=6x4:nb_frames=24:padding=2:margin=2")
    filter_file.write_text(graph, encoding="utf-8")
    run_media(["ffmpeg", "-hide_banner", "-v", "error", "-y", "-i", video,
               "-an", "-vf", graph, "-fps_mode", "vfr", "-q:v", "2", directory / "sheet-%04d.jpg"],
              diagnostic_log=directory / "media-diagnostic-error.log")
    sheets = []
    for i in range(math.ceil(len(schedule["sample_frames"]) / 24)):
        file = directory / ("sheet-%04d.jpg" % (i + 1))
        if not file.is_file() or not file.stat().st_size:
            raise ValueError("Missing sampled contact sheet")
        sheets.append({"id": "sheet-%04d" % (i + 1), "path": str(file), "sha256": studio.file_hash(file),
                       "frames": schedule["sample_frames"][i * 24:(i + 1) * 24]})
    return sheets


def db(value):
    return round(20 * math.log10(max(value, 1e-9)), 3)


def waveform(raw, channels, rate=24000):
    """Float PCM preserves overload; per-channel energy avoids phase cancellation."""
    windows, total, clipped, global_peak = [], 0, 0, 0.0
    size = round(rate * .1) * channels
    with Path(raw).open("rb") as stream:
        while block := stream.read(size * 4):
            values = array.array("f"); values.frombytes(block)
            if sys.byteorder != "little": values.byteswap()
            if len(values) % channels or any(not math.isfinite(x) for x in values):
                raise ValueError("Invalid decoded audio samples")
            count = len(values) // channels
            ch = []
            for c in range(channels):
                samples = values[c::channels]
                peak = max(map(abs, samples), default=0.0)
                rms = math.sqrt(sum(x * x for x in samples) / max(1, len(samples)))
                ch.append({"peak_dbfs": db(peak), "rms_dbfs": db(rms),
                           "min": round(min(samples, default=0), 6), "max": round(max(samples, default=0), 6)})
                global_peak = max(global_peak, peak)
                clipped += sum(abs(x) >= 1 for x in samples)
            windows.append({"from": round(total / rate, 6), "to": round((total + count) / rate, 6), "channels": ch})
            total += count
    candidates = []
    for previous, current in zip(windows, windows[1:]):
        before = max(c["rms_dbfs"] for c in previous["channels"])
        after = max(c["rms_dbfs"] for c in current["channels"])
        if abs(after - before) >= 12 and max(before, after) > -45:
            candidates.append({"kind": "level_jump", "from": previous["from"], "to": current["to"], "delta_db": round(after - before, 3)})
    return {"duration": total / rate, "channels": channels, "sample_rate": rate, "window_seconds": .1,
            "sample_peak_dbfs": db(global_peak), "overload_samples": clipped, "windows": windows, "candidates": candidates}


def audio_metrics(video, stream, duration, directory, required):
    if stream is None:
        return {"status": "missing" if required else "not_applicable", "track_required": bool(required),
                "hard_failures": ["missing_audio_stream"] if required else [], "candidates": []}
    channels = int(stream.get("channels") or 1)
    if channels < 1 or channels > 32:
        raise ValueError("Unsupported audio channel count")
    with tempfile.TemporaryDirectory(prefix="audio-probe-", dir=directory) as temp:
        raw = Path(temp) / "mix.f32"
        run_media(["ffmpeg", "-v", "error", "-y", "-i", video, "-map", "0:" + str(stream["index"]),
                   "-vn", "-af", "aresample=24000:async=1:first_pts=0", "-ar", "24000", "-c:a", "pcm_f32le", "-f", "f32le", raw])
        result = waveform(raw, channels)
    output = run_media(["ffmpeg", "-hide_banner", "-nostats", "-i", video, "-map", "0:" + str(stream["index"]),
                        "-vn", "-af", "loudnorm=print_format=json,silencedetect=noise=-50dB:d=0.2", "-f", "null", "-"]).stderr
    # loudnorm reports INPUT loudness/true peak, independent of its discarded output.
    matches = re.findall(r'\{\s*"input_i".*?\}', output, re.S)
    if not matches:
        raise ValueError("Loudness measurement not returned")
    loudness = json.loads(matches[-1])
    for key in ("input_i", "input_tp", "input_lra", "input_thresh"):
        number = float(loudness[key])
        result[key] = number if math.isfinite(number) else None
    hard = []
    if result["duration"] < duration - .1: hard.append("audio_does_not_cover_export")
    if required and result["sample_peak_dbfs"] <= -60: hard.append("silent_or_inaudible_audio")
    if result.get("input_tp") is not None and result["input_tp"] > 0: hard.append("true_peak_overload")
    if result["overload_samples"]: hard.append("decoded_audio_overload")
    # Silence candidates come from the original waveform, never normalized audio.
    silent_start = None
    for window in result["windows"]:
        silent = max(c["rms_dbfs"] for c in window["channels"]) <= -50
        if silent and silent_start is None: silent_start = window["from"]
        if not silent and silent_start is not None:
            if window["from"] - silent_start >= .2:
                result["candidates"].append({"kind": "silence", "from": silent_start, "to": window["from"]})
            silent_start = None
    if silent_start is not None and result["duration"] - silent_start >= .2:
        result["candidates"].append({"kind": "silence", "from": silent_start, "to": result["duration"]})
    result.update(status="checked", track_required=bool(required), hard_failures=hard, measurement="full_export_default_audio_stream")
    return result


def speech_activity(evidence, audio, fps):
    """Verify expected spoken intervals are not silent in the exported mix.

    BGM can mask missing narration; this check does not identify speakers or words.
    """
    try:
        timeline = evidence["timeline"]["timeline"]
        entries, tracks = timeline["entries"], timeline["tracks"]
        if timeline.get("totalEntries") != len(entries): raise ValueError("Incomplete timeline")
        requested = set(evidence["narration_tracks"])
        selected = [t for t in tracks if requested.intersection((t["id"], t.get("alias")))]
        resolved = {v for t in selected for v in (t["id"], t.get("alias")) if v in requested}
        if not selected or requested != resolved or any(t.get("muted") for t in selected): raise ValueError("Missing or muted narration track")
        ids = {t["id"] for t in selected}
        clips = [c for c in entries if c.get("kind") == "item" and c.get("trackId") in ids]
        sources = {}
        for source in evidence["voice_sources"]:
            transcript = next(v["transcript"] for v in source["data"] if "transcript" in v)
            if transcript.get("status") != "available" or transcript.get("truncated") or any(r.get("truncated") for r in transcript["ranges"]):
                raise ValueError("Incomplete narration transcript")
            sources[source["assetId"]] = [w for r in transcript["ranges"] for w in r["segments"]]
        words, issues = review_sync.project_words(clips, sources, fps)
        if not words or issues: raise ValueError("Missing, repeated or clipped narration words")
        missing = []
        for word in words:
            overlapping = [w for w in audio.get("windows", []) if w["from"] < word["end"] and w["to"] > word["start"]]
            if not overlapping or max(c["rms_dbfs"] for w in overlapping for c in w["channels"]) <= -50:
                missing.append({"text": word["text"], "from": word["start"], "to": word["end"]})
        return {"status": "checked", "word_count": len(words), "silent_words": missing,
                "hard_failures": ["speech_interval_silent_in_mix"] if missing else [],
                "limitations": ["Mix energy cannot establish pronunciation or isolate speech from background music."]}
    except (KeyError, TypeError, ValueError, StopIteration) as exc:
        return {"status": "unverified", "reason": str(exc), "hard_failures": []}


def prepare(run, file, subtitles=None, directory=None):
    root = Path(run).resolve(strict=True); video = Path(file).resolve(strict=True)
    if not video.is_relative_to(root): raise ValueError("Review video must be inside the current run")
    if subtitles and not Path(subtitles).resolve(strict=True).is_relative_to(root): raise ValueError("Subtitles must be inside current run")
    data = studio.load_run(root)
    original_hash = studio.file_hash(video)
    subtitle_hash = studio.file_hash(subtitles) if subtitles else None
    target = Path(directory).resolve() if directory else root / "review-probes" / (original_hash[:16] + "-r" + str(data["revision"]))
    if not target.is_relative_to(root) or target == root: raise ValueError("Review directory must be a subdirectory of run")
    target.mkdir(parents=True, exist_ok=True)
    media = studio.probe_media(video)
    stream = next(s for s in media["streams"] if s["codec_type"] == "video")
    fps = float(__import__("fractions").Fraction(stream["avg_frame_rate"]))
    duration = float(stream.get("duration") or media["format"]["duration"])
    frames = round(fps * duration)
    if not math.isfinite(duration) or not 0 < duration <= 1200.2: raise ValueError("Invalid or unsupported review duration")
    decoded = run_media(["ffmpeg", "-hide_banner", "-nostats", "-v", "info", "-xerror", "-i", video,
                         "-vf", "blackdetect=d=0.02:pix_th=0.02,freezedetect=n=-60dB:d=0.25,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-an", "-f", "null", "-"])
    signal_file = target / "visual-scan.log"; signal_file.write_text(decoded.stderr, encoding="utf-8")
    evidence = None
    evidence_file = root / "review-evidence.json"
    input_hashes = {}
    if evidence_file.is_file(): input_hashes[evidence_file] = studio.file_hash(evidence_file)
    if evidence_file.is_file(): evidence = studio.read(evidence_file)
    for reference in (evidence or {}).get("voice_files", []):
        file = Path(reference["path"]).resolve(strict=True)
        if not file.is_relative_to(root) or studio.file_hash(file) != reference["sha256"]:
            raise ValueError("Actual narration source file is missing, outside run, or changed")
        input_hashes[file] = reference["sha256"]
    if evidence:
        data["_timeline_entries"] = evidence.get("timeline", {}).get("timeline", {}).get("entries", [])
    timeline = (evidence or {}).get("timeline", {}).get("timeline", {})
    timeline_complete = bool(timeline) and timeline.get("totalEntries") == len(timeline.get("entries", []))
    cues = studio.parse_srt(subtitles) if subtitles else []
    schedule = frame_schedule(data, frames, fps, cues)
    sheets = contact_sheets(video, target, schedule)
    audio_streams = [s for s in media["streams"] if s["codec_type"] == "audio"]
    audio_stream = next((s for s in audio_streams if s.get("disposition", {}).get("default")), audio_streams[0] if audio_streams else None)
    # A recorded required music/narration track cannot be silently disabled by a
    # stale audio_required flag. This also covers evidence from chat production.
    track_required = bool(data["settings"].get("audio_required") or data["settings"].get("narration")
                          or studio.music_expected(data) or data.get("project", {}).get("narration_tracks")
                          or (evidence or {}).get("music_tracks") or (evidence or {}).get("narration_tracks"))
    audio = audio_metrics(video, audio_stream, duration, target, track_required)
    sync = {"status": "unverified", "reason": "No final timeline/transcript/caption evidence"}
    cuts_file = root / "source-cuts.json"
    if cuts_file.is_file(): input_hashes[cuts_file] = studio.file_hash(cuts_file)
    if evidence and cues and cuts_file.is_file():
        try: sync = {"status": "checked", "report": review_sync.review(evidence, cues, studio.read(cuts_file), fps)}
        except (ValueError, KeyError, TypeError, StopIteration) as exc: sync = {"status": "unverified", "reason": str(exc)}
    activity = speech_activity(evidence, audio, fps) if evidence and data["settings"].get("narration") else {"status": "unverified" if data["settings"].get("narration") else "not_applicable"}
    alignment = review_audio_alignment.check(video, evidence, root, fps) if data["settings"].get("narration") else {"status": "not_applicable"}
    music = review_music.check_file(video, evidence, required=studio.music_expected(data)) if studio.music_expected(data) else {"status": "not_applicable"}
    common = {"schema": 1, "policy": POLICY, "artifact_sha256": original_hash,
              "subtitle_sha256": subtitle_hash,
              "revision": data["revision"], "frames": frames, "fps": fps, "duration": duration}
    limitations = ["Visual review uses sampled final composite frames; it is not continuous playback.",
                   "Audio checks measure the full exported mix; pronunciation, timbre and subjective listening remain unverified.",
                   "Signal detectors produce candidates, not a guarantee that every transient defect is detected."]
    manifest = {**common, **schedule, "contact_sheets": sheets, "timeline_complete": timeline_complete, "limitations": limitations}
    visual_candidates = [line.strip() for line in decoded.stderr.splitlines() if any(key in line for key in ("black_start:", "freeze_start:", "freeze_end:"))]
    metrics = {**common, "full_decode": True, "audio": audio, "sync": sync, "speech_activity": activity, "narration_alignment": alignment,
               "music": music, "visual_scan": {"path": str(signal_file), "sha256": studio.file_hash(signal_file), "candidates": visual_candidates}, "limitations": limitations}
    mf, af = target / "manifest.json", target / "metrics.json"
    studio.write(mf, manifest); studio.write(af, metrics)
    files = [mf, af, signal_file, target / "samples.filter"]
    if evidence_file.is_file(): files.append(evidence_file)
    if cuts_file.is_file(): files.append(cuts_file)
    files.extend(p for p in input_hashes if p not in files)
    result = {**common, "manifest": str(mf), "metrics": str(af), "evidence_files": [{"path": str(p), "sha256": studio.file_hash(p)} for p in files], "limitations": limitations}
    if studio.load_run(root)["revision"] != data["revision"]: raise ValueError("Run changed during review preparation")
    if studio.file_hash(video) != original_hash or (subtitles and studio.file_hash(subtitles) != subtitle_hash) or any(studio.file_hash(p) != sha for p, sha in input_hashes.items()):
        raise ValueError("Media or timeline evidence changed during review preparation")
    studio.write(root / "quality-probe.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True); parser.add_argument("--file", required=True)
    parser.add_argument("--subtitles"); parser.add_argument("--directory")
    args = parser.parse_args(); print(json.dumps(prepare(args.run, args.file, args.subtitles, args.directory), ensure_ascii=False))


if __name__ == "__main__": main()
