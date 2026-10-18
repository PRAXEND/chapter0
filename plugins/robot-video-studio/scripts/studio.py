#!/usr/bin/env python3
"""Local diagnostics, bounded source acquisition and durable production records.

No ChatCut authentication or RPC is implemented here: Codex invokes the connected
MCP tools and records their actual results. Python 3.10+, macOS; stdlib only.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
import uuid

import review_quality as quality

ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = {
    "schema_version": 1, "language": "zh-CN", "timezone": "Asia/Shanghai",
    "width": 1080, "height": 1920, "fps": 30, "target_seconds": 90,
    "min_seconds": 60, "max_seconds": 120,
    "max_video_sources": 6, "max_download_seconds": 300,
    "creative": quality.DEFAULT_CREATIVE,
    "voice": None, "style": "有趣但克制，真实演示优先，少量解释性动画",
    "confirmation": "topic_then_finish", "generate_video": False,
    "generate_music": False, "publish": False,
}
REVIEW_KEYS = set(quality.METHODS)


class StudioError(Exception):
    pass


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def home():
    return Path(os.environ.get("ROBOT_VIDEO_STUDIO_HOME", str(Path.home() / "Library/Application Support/Robot Video Studio"))).expanduser().resolve()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, value):
    """Atomic, private files; never truncate a production record in place."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".studio-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


@contextlib.contextmanager
def locked(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".studio.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise StudioError("Another operation owns this run; inspect it before retrying.") from exc
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def file_hash(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def number(value, name, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum:
        raise StudioError(f"{name} must be a finite number >= {minimum}")
    return value


def public_url(value):
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise StudioError("Use a public HTTP(S) URL without embedded credentials.")
    return value


def native_tool(name):
    explicit = os.environ.get("ROBOT_VIDEO_FFMPEG_DIR")
    candidate = (Path(explicit).expanduser() if explicit else home() / "native-bin") / name
    if candidate.is_file():
        return str(candidate.resolve())
    if explicit:
        raise StudioError(f"{name} is missing from ROBOT_VIDEO_FFMPEG_DIR.")
    return shutil.which(name)


def execute(argv, timeout=120):
    argv = list(argv)
    if argv[0] in {"ffmpeg", "ffprobe"}:
        resolved = native_tool(argv[0])
        if not resolved:
            raise StudioError(f"Missing executable: {argv[0]}")
        argv[0] = resolved
    try:
        return subprocess.run([str(x) for x in argv], capture_output=True, text=True, timeout=timeout, check=True)
    except FileNotFoundError as exc:
        raise StudioError(f"Missing executable: {argv[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise StudioError("Operation timed out. Check existing files/jobs before retrying.") from exc
    except subprocess.CalledProcessError as exc:
        # URLs may contain temporary signatures. Report category, not credential-bearing output.
        raise StudioError(f"{Path(str(argv[0])).name} failed (exit {exc.returncode}); check availability, authentication and dependencies.") from exc


def downloader():
    local = home() / "runtime/bin/yt-dlp"
    resolved = str(local) if local.is_file() else shutil.which("yt-dlp")
    if not resolved:
        raise StudioError("yt-dlp is missing; run studio.py bootstrap.")
    return resolved


def downloader_args():
    args = [downloader(), "--ignore-config", "--no-plugin-dirs", "--no-playlist", "--no-progress", "--socket-timeout", "20", "--retries", "2", "--fragment-retries", "2"]
    runtime = shutil.which("deno") or shutil.which("node")
    if runtime:
        args += ["--js-runtimes", f"{'deno' if Path(runtime).name == 'deno' else 'node'}:{runtime}"]
    ffmpeg = native_tool("ffmpeg")
    if ffmpeg:
        args += ["--ffmpeg-location", str(Path(ffmpeg).parent)]
    return args


def profile():
    path = home() / "profile.json"
    result = {**DEFAULTS, "output_root": str(Path.home() / "Movies/Robot Video Studio")}
    if path.exists():
        result.update(read(path))
    result["creative"] = quality.preferences(result.get("creative", {}))
    return result


def save_profile(patch):
    unknown = set(patch) - set(profile())
    if unknown:
        raise StudioError(f"Unknown configuration keys: {sorted(unknown)}")
    with locked(home()):
        result = {**profile(), **patch}
        if (result["width"], result["height"], result["fps"]) != (1080, 1920, 30):
            raise StudioError("v0.1 supports 1080×1920 at 30 fps.")
        if not 60 <= number(result["target_seconds"], "target_seconds") <= 120:
            raise StudioError("target_seconds must be 60–120.")
        for key in ("min_seconds", "max_seconds", "max_video_sources", "max_download_seconds", "confirmation", "generate_video", "generate_music", "publish", "schema_version"):
            if result[key] != DEFAULTS[key]:
                raise StudioError(f"{key} is a fixed v0.1 boundary; override the workflow explicitly instead.")
        result["creative"] = quality.preferences({**profile()["creative"], **patch.get("creative", {})})
        voice = result["voice"]
        if voice is not None and (not isinstance(voice, dict) or not all(voice.get(k) for k in ("name", "provider", "voiceId")) or voice.get("selected_by_user") is not True):
            raise StudioError("Voice needs an explicitly selected live catalog entry.")
        result["output_root"] = str(Path(result["output_root"]).expanduser().resolve())
        write(home() / "profile.json", result)
    return result


def new_run(title, output_root=None):
    settings = profile()
    slug = re.sub(r"[^\w-]+", "-", title, flags=re.UNICODE).strip("-")[:45] or "video"
    identifier = f"{dt.datetime.now(dt.timezone.utc):%Y%m%dT%H%M%SZ}-{slug}-{uuid.uuid4().hex[:6]}"
    directory = Path(output_root or settings["output_root"]).expanduser().resolve() / identifier
    directory.mkdir(parents=True, exist_ok=False)
    manifest = {
        "schema_version": 1, "id": identifier, "title": title, "created_at": now(),
        "status": "awaiting_topic", "settings": settings, "selection": None,
        "project": {}, "sources": [], "beats": [], "downloads": {},
        "operations": {}, "reviews": {}, "revision": 0, "history": [],
        "quality_plan": None,
    }
    write(directory / "run.json", manifest)
    return {"run": str(directory), "manifest": manifest}


def load_run(directory):
    value = read(Path(directory) / "run.json")
    if value.get("schema_version") != 1:
        raise StudioError("Unsupported run schema; do not overwrite it.")
    return value


def save_run(directory, data, event):
    data["history"].append({"at": now(), "event": event})
    data["updated_at"] = now()
    write(Path(directory) / "run.json", data)


def invalidate(data):
    data["revision"] += 1
    data["reviews"] = {}
    data.pop("last_audit", None)
    if data["status"] in {"completed", "review_pending"}:
        data["status"] = "editing"


def record(directory, kind, payload):
    with locked(directory):
        data = load_run(directory)
        if kind == "selection":
            if not payload.get("topic") or payload.get("confirmed_by_user") is not True:
                raise StudioError("Record the actual user-selected topic, not the recommended default.")
            data["selection"] = payload
            data["status"] = "research"
        elif kind == "project":
            if not payload.get("projectId"):
                raise StudioError("projectId must come from ChatCut.")
            data["project"].update(payload)
        elif kind in {"source", "beat"}:
            if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", payload.get("id", "")):
                raise StudioError("Use a short stable ASCII id.")
            if kind == "source":
                public_url(payload.get("url", ""))
                if not payload.get("title") or payload.get("kind") not in {"video", "article", "paper", "image"}:
                    raise StudioError("Source needs title and kind (video/article/paper/image).")
                payload.setdefault("rights", "unknown")
            collection = data["sources" if kind == "source" else "beats"]
            old = next((x for x in collection if x["id"] == payload["id"]), None)
            if old == payload:
                return data
            if old:
                if kind == "source" and any(x["source_id"] == payload["id"] for x in data["downloads"].values()) and old["url"] != payload["url"]:
                    raise StudioError("A downloaded source URL is immutable; create a new source id.")
                collection[collection.index(old)] = payload
            else:
                collection.append(payload)
            if sum(x["kind"] == "video" for x in data["sources"]) > 6:
                raise StudioError("At most six video sources per run.")
        elif kind == "quality_plan":
            quality.validate_plan(payload)
            if data.get("quality_plan") == payload:
                return data
            data["quality_plan"] = payload
        elif kind == "review":
            key = payload.get("check")
            if key not in REVIEW_KEYS or payload.get("result") not in {"pass", "fail", "unverified"}:
                raise StudioError("Unknown review check or result.")
            if not payload.get("evidence"):
                raise StudioError("A review requires concrete evidence, even when unverified.")
            if not re.fullmatch(r"[0-9a-f]{64}", payload.get("artifact_sha256", "")):
                raise StudioError("Bind the review to the actual exported MP4 SHA-256.")
            if payload["result"] == "pass":
                if payload.get("method") not in quality.METHODS[key] or not payload.get("reviewer") or not payload.get("observations"):
                    raise StudioError("A pass needs the appropriate review method, reviewer and observations.")
                if not payload.get("evidence_files") or not all(quality.file_proof(ref, directory) for ref in payload["evidence_files"]):
                    raise StudioError("A pass needs existing SHA-256-bound evidence files.")
                if payload.get("plan_sha256") != digest(data.get("quality_plan")) or not data.get("quality_plan"):
                    raise StudioError("Bind the review to the current quality plan.")
            data["reviews"][key] = {**payload, "revision": data["revision"], "at": now()}
        else:
            raise StudioError("Unsupported record kind.")
        if kind != "review":
            invalidate(data)
        save_run(directory, data, f"record:{kind}")
        return data


def operation(directory, action, key, payload, state=None):
    with locked(directory):
        data = load_run(directory)
        if not data.get("selection"):
            raise StudioError("Confirm the topic before reserving production work.")
        entry = data["operations"].get(key)
        if action == "reserve":
            fingerprint = digest(payload)
            if entry:
                if entry["input_sha256"] != fingerprint:
                    raise StudioError("Intent key already has different input; reconcile or use a new revision key.")
                return {"should_submit": False, "operation": entry}
            entry = {"input_sha256": fingerprint, "input": payload, "status": "reserved", "at": now()}
            data["operations"][key] = entry
            invalidate(data)
            save_run(directory, data, f"reserve:{key}")
            return {"should_submit": True, "operation": entry}
        if not entry:
            raise StudioError("Reserve an operation before recording its result.")
        if state not in {"submitted", "completed", "failed"}:
            raise StudioError("Result state must be submitted/completed/failed.")
        if not payload or not any(payload.get(k) for k in ("jobId", "assetId", "renderId", "projectId", "itemIds", "observed_failure")):
            raise StudioError("Record an actual remote identifier or observed_failure evidence.")
        if entry["status"] in {"completed", "failed"}:
            if entry["status"] == state and entry.get("result") == payload:
                return entry
            raise StudioError("Terminal result is immutable; create a new intent key for an authorized retry.")
        entry.update(status=state, result=payload, updated_at=now())
        save_run(directory, data, f"resolve:{key}:{state}")
        return entry


def probe_media(path):
    return json.loads(execute(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", Path(path).resolve()]).stdout)


def probe_url(url):
    raw = json.loads(execute(downloader_args() + ["--skip-download", "--dump-single-json", public_url(url)], timeout=180).stdout)
    if raw.get("_type") in {"playlist", "multi_video"} or raw.get("is_live"):
        raise StudioError("Select a single non-live video.")
    keys = ("id", "title", "uploader", "channel", "upload_date", "timestamp", "duration", "webpage_url", "license", "availability", "extractor_key")
    result = {key: raw.get(key) for key in keys}
    if result["duration"] is None and Path(urlsplit(url).path).suffix.lower() in {".mp4", ".webm", ".mov"}:
        # Generic direct-file extractors often omit duration. Read the media header
        # without downloading the whole source or inventing a duration.
        media = json.loads(execute(["ffprobe", "-v", "error", "-rw_timeout", "20000000", "-show_format", "-show_streams", "-of", "json", url], timeout=60).stdout)
        result["duration"] = float(media["format"]["duration"])
        result["duration_evidence"] = "ffprobe_remote_header"
    return result


def fetch(directory, source_id, start, end):
    number(start, "start")
    number(end, "end")
    if end <= start or end - start > 300:
        raise StudioError("A source range must be positive and no longer than 300 seconds.")
    with locked(directory):
        data = load_run(directory)
        if not data.get("selection"):
            raise StudioError("Select a topic before downloading production media.")
        source = next((x for x in data["sources"] if x["id"] == source_id and x["kind"] == "video"), None)
        if not source:
            raise StudioError("Register a video source first.")
        key = digest([source["url"], start, end])[:24]
        old = data["downloads"].get(key)
        folder = Path(directory).resolve() / "media"
        folder.mkdir(exist_ok=True)
        path = folder / f"{source_id}-{key}.mp4"
        if old and old["status"] == "completed" and path.is_file() and old.get("sha256") == file_hash(path):
            return {**old, "reused": True}
        total = sum(x["end"] - x["start"] for k, x in data["downloads"].items() if k != key)
        if total + end - start > 300:
            raise StudioError("This run already reserves its 300-second acquisition budget.")
        entry = {"source_id": source_id, "start": start, "end": end, "path": str(path), "status": "reserved"}
        data["downloads"][key] = entry
        save_run(directory, data, f"fetch-reserve:{key}")
        if path.exists():
            # A process may have completed between download and checkpoint. Validate, don't resubmit.
            measured = probe_media(path)
        else:
            metadata = probe_url(source["url"])
            if not isinstance(metadata.get("duration"), (int, float)) or end > metadata["duration"] + 0.25:
                raise StudioError("Requested range exceeds known source duration or duration is unknown.")
            args = downloader_args() + ["--download-sections", f"*{start}-{end}", "--force-keyframes-at-cuts", "--max-filesize", "1G", "-f", "bv*[height<=?1080]+ba/b[height<=?1080]", "--merge-output-format", "mp4", "--remux-video", "mp4", "-o", str(folder / f"{source_id}-{key}.%(ext)s"), source["url"]]
            execute(args, timeout=900)
            if not path.is_file():
                raise StudioError("Downloader returned without the expected MP4; inspect partial files.")
            measured = probe_media(path)
            entry["metadata"] = metadata
        duration = float(measured["format"]["duration"])
        if not math.isfinite(duration) or abs(duration - (end - start)) > 1.0:
            raise StudioError("Downloaded section duration differs by over 1 second; inspect boundaries before importing.")
        if not any(x.get("codec_type") == "video" for x in measured["streams"]):
            raise StudioError("Downloaded file has no video stream.")
        entry.update(status="completed", actual_seconds=duration, sha256=file_hash(path))
        invalidate(data)
        save_run(directory, data, f"fetch-complete:{key}")
        return entry


def parse_srt(path):
    text = Path(path).read_text(encoding="utf-8-sig").strip()
    cards = []
    stamp = r"(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})"
    for block in re.split(r"\r?\n\s*\r?\n", text):
        lines = block.splitlines()
        if not lines:
            continue
        index = 1 if lines[0].strip().isdigit() else 0
        match = re.fullmatch(stamp + r"\s*-->\s*" + stamp, lines[index].strip())
        if not match:
            raise StudioError("Malformed SRT timestamp.")
        nums = list(map(int, match.groups()))
        if any(nums[i] >= 60 for i in (1, 2, 5, 6)):
            raise StudioError("Invalid SRT minutes/seconds.")
        seconds = lambda v: v[0] * 3600 + v[1] * 60 + v[2] + v[3] / 1000
        cards.append({"start": seconds(nums[:4]), "end": seconds(nums[4:]), "lines": lines[index + 1:]})
    return cards


def music_expected(data):
    project = data.get('project', {})
    return bool(project.get('music_asset_id') or project.get('music_tracks') or project.get('music_enabled'))


def audit_data(data, media, captions, artifact_hash, subtitle_hash, music_check=None, edit_check=None, quality_check=None, review_base=None, evidence=None):
    failures, warnings = [], []
    streams = media.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    duration = float(media.get("format", {}).get("duration", 0))
    if not math.isfinite(duration) or not 60 <= duration <= 120.1:
        failures.append("duration_outside_60_120_seconds")
    if (video.get("width"), video.get("height"), video.get("codec_name")) != (1080, 1920, "h264"):
        failures.append("video_must_be_1080x1920_h264")
    try:
        num, den = map(float, video.get("avg_frame_rate", "0/1").split("/"))
        fps = num / den
    except (ValueError, ZeroDivisionError):
        fps = 0
    if abs(fps - 30) > 0.01:
        failures.append("fps_must_be_30")
    if not any(s.get("codec_type") == "audio" for s in streams):
        failures.append("missing_audio_stream")
    if not data.get("selection") or not data.get("project", {}).get("projectId") or not data.get("project", {}).get("timelineId"):
        failures.append("missing_selected_topic_or_editable_project")
    if not captions:
        failures.append("empty_subtitles")
    previous = 0
    for i, card in enumerate(captions):
        if card["end"] <= card["start"] or card["start"] < previous - .04 or card["end"] > duration + .2:
            failures.append(f"caption_{i + 1}_timing_invalid")
        if not card["lines"] or len(card["lines"]) > 2:
            failures.append(f"caption_{i + 1}_layout_invalid")
        previous = card["end"]
    sources = {s["id"]: s for s in data["sources"]}
    if not data["beats"]:
        failures.append("missing_storyboard")
    previous_beat_end = -1
    for beat in data["beats"]:
        label = beat["id"]
        refs = beat.get("source_ids", [])
        if not refs or any(s not in sources for s in refs):
            failures.append(f"{label}:missing_evidence_sources")
        if not beat.get("narration") or not beat.get("visual_anchor") or not beat.get("audio_asset_id"):
            failures.append(f"{label}:incomplete_sync_map")
        try:
            first = number(beat.get("from_frame"), "from_frame")
            last = number(beat.get("to_frame"), "to_frame")
            audio = number(beat.get("audio_duration_seconds"), "audio_duration_seconds", .01)
            if first < previous_beat_end:
                failures.append(f"{label}:overlapping_or_unsorted_narration")
            previous_beat_end = last
            if not isinstance(first, int) or not isinstance(last, int) or last <= first or last > round(duration * 30) + 1 or abs((last - first) / 30 - audio) > .2:
                failures.append(f"{label}:audio_fit_outside_200ms")
        except StudioError:
            failures.append(f"{label}:missing_actual_audio_timing")
    for source in sources.values():
        if source.get("rights", "unknown") == "unknown":
            warnings.append(f"{source['id']}:rights_unknown")
    for key, entry in data.get("operations", {}).items():
        if entry["status"] in {"reserved", "submitted"}:
            failures.append(f"{key}:unresolved_remote_operation")
    pending, review_details = [], {}
    frames = round(duration*30) if math.isfinite(duration) and duration > 0 else 0
    for key in sorted(REVIEW_KEYS):
        issues = quality.review_issues(key, data["reviews"].get(key, {}), data,
                                       artifact_hash, subtitle_hash, frames, review_base, evidence)
        review_details[key] = issues
        if issues:
            pending.append(key)
    if not quality_check or quality_check.get('status') != 'pass' or quality_check.get('artifact_sha256') != artifact_hash or quality_check.get('run_revision') != data['revision'] or quality_check.get('plan_sha256') != digest(data.get('quality_plan')):
        pending.append('creative_quality')
    music_required = music_expected(data) or bool(music_check and music_check.get('status') != 'not_applicable')
    if music_required and (not music_check or music_check.get('status') != 'pass' or
                           music_check.get('artifact_sha256') != artifact_hash or
                           music_check.get('run_revision') != data['revision']):
        pending.append('music_pause_levels')
    if edit_check is not None and (edit_check.get('status') != 'pass' or
            edit_check.get('artifact_sha256') != artifact_hash or
            edit_check.get('run_revision') != data['revision']):
        pending.append('editorial_structure')
    return {"technical_pass": not failures, "failures": failures, "warnings": warnings,
            "editorial_check": edit_check or {"status": "unverified"},
            "creative_quality": quality_check or {"status": "unverified"}, "review_details": review_details,
            "review_pending": pending, "completed": not failures and not pending,
            "music_pause_check": music_check or {"status": "unverified" if music_required else "not_applicable"},
            "artifact_sha256": artifact_hash, "subtitle_sha256": subtitle_hash, "checked_at": now(),
            "note": "File checks do not establish visual, listening, semantic or copyright approval."}


def audit(directory, video, subtitles, evidence=None):
    from review_music import check_file
    from review_edit import check as check_edit
    snapshot = load_run(directory)
    evidence_path = Path(evidence).expanduser() if evidence else None
    if evidence_path is None and snapshot['project'].get('evidence_directory'):
        evidence_path = Path(snapshot['project']['evidence_directory']) / 'live-evidence.json'
        if not evidence_path.is_absolute():
            evidence_path = Path(directory) / evidence_path
    proof, proof_error = None, None
    if evidence_path:
        try:
            proof = read(evidence_path)
        except (OSError, ValueError) as exc:
            proof_error = str(exc)
    music_check = check_file(video, proof, required=music_expected(snapshot))
    music_check['run_revision'] = snapshot['revision']
    if proof is not None:
        music_check['evidence_sha256'] = file_hash(evidence_path)
    if proof_error:
        music_check.update(status='unverified', reason='Cannot read final evidence: ' + proof_error)
    edit_check = check_edit(proof)
    edit_check.update(artifact_sha256=file_hash(video), run_revision=snapshot['revision'])
    if proof is not None:
        edit_check['evidence_sha256'] = file_hash(evidence_path)
    quality_check = quality.check(snapshot, proof, file_hash(video),
                                  evidence_path.parent if evidence_path else directory, edit_check)
    if proof is not None:
        quality_check['evidence_sha256'] = file_hash(evidence_path)
    media = probe_media(video)
    # Decode the whole export. Detection results need human/model inspection;
    # a dark robotics shot is not automatically an unintended black screen.
    result = execute(["ffmpeg", "-hide_banner", "-nostats", "-v", "info", "-i", Path(video).resolve(), "-vf", "blackdetect=d=0.15:pix_th=0.05,freezedetect=n=-50dB:d=3", "-af", "silencedetect=noise=-45dB:d=0.6", "-f", "null", "-"], timeout=600)
    quality.apply_freeze_check(quality_check, snapshot, result.stderr, float(media["format"]["duration"]))
    with locked(directory):
        data = load_run(directory)
        report = audit_data(data, media, parse_srt(subtitles), file_hash(video), file_hash(subtitles), music_check, edit_check, quality_check, directory, proof)
        report["decode_pass"] = True
        report["detector_notes"] = [line.strip() for line in result.stderr.splitlines() if "black_start:" in line or "silence_start:" in line or "silence_end:" in line or "freezedetect.freeze_" in line]
        data["last_audit"] = report
        data["status"] = "completed" if report["completed"] else "review_pending"
        write(Path(directory) / 'music-pause-check.json', music_check)
        write(Path(directory) / 'editorial-check.json', edit_check)
        write(Path(directory) / 'creative-quality-report.json', quality_check)
        write(Path(directory) / "qa-report.json", report)
        save_run(directory, data, "audit")
        return report


def doctor():
    programs = {name: shutil.which(name) for name in ("ffmpeg", "ffprobe", "node", "deno")}
    for name in ("ffmpeg", "ffprobe"):
        programs[name] = native_tool(name)
    try:
        programs["yt-dlp"] = downloader()
    except StudioError:
        programs["yt-dlp"] = None
    modules = {}
    for name in ("venv", "ssl", "email.encoders", "urllib.request"):
        try:
            importlib.import_module(name)
            modules[name] = True
        except ImportError:
            modules[name] = False
    executable_checks = {}
    for name, path in programs.items():
        if not path:
            executable_checks[name] = {"ok": False, "reason": "missing"}
            continue
        try:
            result = execute([path, "-version" if name in {"ffmpeg", "ffprobe"} else "--version"], timeout=10)
            executable_checks[name] = {"ok": True, "version": (result.stdout or result.stderr).splitlines()[0]}
        except StudioError as exc:
            executable_checks[name] = {"ok": False, "reason": str(exc)}
    filters_ok = False
    if executable_checks["ffmpeg"]["ok"]:
        try:
            filters = execute([programs["ffmpeg"], "-hide_banner", "-filters"], timeout=10).stdout
            filters_ok = all(name in filters for name in ("blackdetect", "silencedetect", "freezedetect"))
        except StudioError:
            pass
    ready = sys.version_info >= (3, 10) and all(modules.values()) and all(executable_checks[k]["ok"] for k in ("ffmpeg", "ffprobe", "yt-dlp")) and any(executable_checks[k]["ok"] for k in ("node", "deno")) and filters_ok
    return {"local_ready": bool(ready), "python": sys.executable, "python_version": sys.version.split()[0], "stdlib": modules,
            "programs": programs, "executable_checks": executable_checks, "diagnostic_filters_available": filters_ok,
            "chatcut": "requires_live_mcp_probe", "state_directory": str(home())}


def bootstrap():
    import venv
    with locked(home()):
        runtime = home() / "runtime"
        if not (runtime / "bin/python").exists():
            venv.EnvBuilder(with_pip=True).create(runtime)
        execute([runtime / "bin/python", "-m", "pip", "install", "--disable-pip-version-check", "-r", ROOT / "requirements-runtime.txt"], timeout=600)
        installed = execute([runtime / "bin/python", "-m", "pip", "freeze"]).stdout.splitlines()
        write(home() / "runtime-versions.json", {"installed_at": now(), "packages": installed})
    return doctor()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    subs.add_parser("doctor")
    subs.add_parser("bootstrap")
    p = subs.add_parser("profile"); p.add_argument("--merge-file")
    p = subs.add_parser("new"); p.add_argument("--title", required=True); p.add_argument("--output-root")
    p = subs.add_parser("status"); p.add_argument("--run", required=True)
    p = subs.add_parser("record"); p.add_argument("--run", required=True); p.add_argument("--kind", choices=["source", "beat", "selection", "project", "quality_plan", "review"], required=True); p.add_argument("--file", required=True)
    p = subs.add_parser("operation"); p.add_argument("action", choices=["reserve", "resolve"]); p.add_argument("--run", required=True); p.add_argument("--key", required=True); p.add_argument("--file", required=True); p.add_argument("--state", choices=["submitted", "completed", "failed"])
    p = subs.add_parser("probe"); p.add_argument("--url", required=True)
    p = subs.add_parser("fetch"); p.add_argument("--run", required=True); p.add_argument("--source", required=True); p.add_argument("--start", type=float, required=True); p.add_argument("--end", type=float, required=True)
    p = subs.add_parser("audit"); p.add_argument("--run", required=True); p.add_argument("--video", required=True); p.add_argument("--subtitles", required=True); p.add_argument("--evidence")
    args = parser.parse_args(argv)
    try:
        command = args.command
        if command == "doctor": result = doctor()
        elif command == "bootstrap": result = bootstrap()
        elif command == "profile": result = save_profile(read(args.merge_file)) if args.merge_file else profile()
        elif command == "new": result = new_run(args.title, args.output_root)
        elif command == "status": result = load_run(args.run)
        elif command == "record": result = record(args.run, args.kind, read(args.file))
        elif command == "operation": result = operation(args.run, args.action, args.key, read(args.file), args.state)
        elif command == "probe": result = probe_url(args.url)
        elif command == "fetch": result = fetch(args.run, args.source, args.start, args.end)
        elif command == "audit": result = audit(args.run, args.video, args.subtitles, args.evidence)
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
        if command in {"doctor", "bootstrap"} and not result["local_ready"]: return 2
        if command == "audit" and not result["completed"]: return 2
        return 0
    except (StudioError, OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
