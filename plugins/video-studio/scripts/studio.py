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

import styles
import style_plan
import production_plan
import style_media
import check_connection

ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = {
    "schema_version": 2, "language": None, "timezone": None,
    "width": None, "height": None, "fps": None, "target_seconds": None,
    "min_seconds": None, "max_seconds": None,
    "max_video_sources": 6, "max_download_seconds": 300,
    "voice": None, "default_style": None,
    "narration": None, "captions": None, "audio_required": None,
    "production_preferences": {}, "portrait_bottom_inset": .18, "replay_authorization": None,
}
REVIEW_METHODS = {"material_continuity": "source_windows_and_playback",
                  "portrait_layout": "composited_sequence_inspection", "visuals": "continuous_playback", "audio_listening": "full_mix_listening",
                  "caption_sync": "word_alignment_and_frames", "facts": "source_review",
                  "style_match": "reference_comparison",
                  "av_sync": "timeline_alignment_and_playback",
                  "occlusion": "composited_sequence_inspection",
                  "music_fit": "full_mix_and_context_review",
                  "transitions": "boundary_sequence_playback",
                  "caption_flow": "caption_boundary_sequence_playback",
                  "flicker": "frame_scan_and_sequence_playback",
                  "output_details": "export_and_boundary_inspection"}
REVIEW_KEYS = set(REVIEW_METHODS)


class StudioError(Exception):
    pass


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def home():
    return Path(os.environ.get("VIDEO_STUDIO_HOME", str(Path.home() / "Library/Application Support/Video Studio"))).expanduser().resolve()


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
    explicit = os.environ.get("VIDEO_STUDIO_FFMPEG_DIR")
    candidate = (Path(explicit).expanduser() if explicit else home() / "native-bin") / name
    if candidate.is_file():
        return str(candidate.resolve())
    if explicit:
        raise StudioError(f"{name} is missing from VIDEO_STUDIO_FFMPEG_DIR.")
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
    result = {**DEFAULTS, "output_root": str(Path.home() / "Movies/Video Studio")}
    if path.exists():
        result.update(read(path))
    return result


def validate_settings(result, complete=False):
    production_plan.layout(result)
    if result.get("replay_authorization") is not None and not production_plan.text(result["replay_authorization"]):
        raise StudioError("Replay exception needs the actual user request")
    if not isinstance(result.get("production_preferences", {}), dict):
        raise StudioError("production_preferences must be an object of explicit user preferences")
    for key in ("width", "height", "fps", "target_seconds", "min_seconds", "max_seconds",
                "max_video_sources", "max_download_seconds"):
        if result.get(key) is not None:
            number(result[key], key, .01)
    for key in ("width", "height", "max_video_sources"):
        if result.get(key) is not None and type(result[key]) is not int:
            raise StudioError(f"{key} must be an integer")
    for key in ("width", "height"):
        if result.get(key) and result[key] % 2:
            raise StudioError("Use even dimensions for H.264 export")
    for key in ("narration", "captions", "audio_required"):
        if result.get(key) is not None and type(result[key]) is not bool:
            raise StudioError(f"{key} must be boolean")
    if result.get("narration") and result.get("audio_required") is False:
        raise StudioError("Narration requires audio")
    lo, hi = result.get("min_seconds"), result.get("max_seconds")
    if lo and hi and lo > hi:
        raise StudioError("min_seconds must not exceed max_seconds")
    if result.get("schema_version") != 2:
        raise StudioError("Use v0.2 settings; legacy creative defaults are not migrated")
    voice = result.get("voice")
    if voice is not None and (not isinstance(voice, dict) or not all(voice.get(k) for k in ("name", "provider", "voiceId")) or voice.get("selected_by_user") is not True):
        raise StudioError("Voice needs an explicitly selected live catalog entry")
    if complete and any(result.get(k) is None for k in ("width", "height", "fps", "narration", "captions", "audio_required")):
        raise StudioError("Record output dimensions, FPS, narration, captions and audio_required in the brief")
    return result


def save_profile(patch):
    unknown = set(patch) - set(profile())
    if unknown:
        raise StudioError(f"Unknown configuration keys: {sorted(unknown)}")
    with locked(home()):
        result = validate_settings({**profile(), **patch})
        if result.get("default_style"):
            result["default_style"] = styles.resolve(result["default_style"])["selector"]
        result["output_root"] = str(Path(result["output_root"]).expanduser().resolve())
        write(home() / "profile.json", result)
    return result


def apply_brief(data, payload, directory):
    if not isinstance(payload, dict) or not payload.get("topic"):
        raise StudioError("Brief needs the current topic")
    patch = payload.get("requirements", {})
    if not isinstance(patch, dict) or set(patch) - set(DEFAULTS):
        raise StudioError("Unknown brief requirements")
    settings = validate_settings({**data["settings"], **patch}, complete=True)
    selector = payload.get("style", settings.get("default_style"))
    selected = styles.resolve(selector) if selector else None
    overrides = payload.get("style_overrides", {})
    if not isinstance(overrides, dict) or any(not isinstance(v, str) or not v.strip() for v in overrides.values()):
        raise StudioError("Style overrides need rule ids and the user's actual replacement directions")
    rules = {r["id"] for r in selected["spec"]["rules"]} if selected else set()
    if set(overrides) - rules:
        raise StudioError("Override references an unknown style rule")
    # Resolve once, then pin this exact version even if another version is saved.
    data["style_snapshot"] = styles.snapshot(selected["selector"], directory) if selected else None
    if data.get("brief") != payload:
        data["material_plan"] = None
    if data.get("selection") and data["selection"]["topic"] != payload["topic"]:
        data["selection"] = None
    data["brief"] = {**payload, "style": selected["selector"] if selected else None}
    data["settings"] = settings
    data["status"] = "planning"


def new_run(title, output_root=None, brief=None):
    settings = profile()
    slug = re.sub(r"[^\w-]+", "-", title, flags=re.UNICODE).strip("-")[:45] or "video"
    identifier = f"{dt.datetime.now(dt.timezone.utc):%Y%m%dT%H%M%SZ}-{slug}-{uuid.uuid4().hex[:6]}"
    directory = Path(output_root or settings["output_root"]).expanduser().resolve() / identifier
    directory.mkdir(parents=True, exist_ok=False)
    manifest = {
        "schema_version": 2, "id": identifier, "title": title, "created_at": now(),
        "status": "awaiting_brief", "settings": settings, "selection": None,
        "project": {}, "sources": [], "beats": [], "downloads": {},
        "operations": {}, "reviews": {}, "revision": 0, "history": [],
        "brief": None, "style_snapshot": None, "material_plan": None,
        "production_policy_version": 1, "production_plan": None,
    }
    if brief is not None:
        apply_brief(manifest, brief, directory)
    write(directory / "run.json", manifest)
    return {"run": str(directory), "manifest": manifest}


def load_run(directory):
    value = read(Path(directory) / "run.json")
    if value.get("schema_version") != 2:
        raise StudioError("Legacy or unsupported run: continue with its original plugin; do not overwrite it.")
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
            if not payload.get("topic") or not (payload.get("confirmed_by_user") is True or (payload.get("selection_basis") == "delegated" and payload.get("authorized_by_user") is True)):
                raise StudioError("Record the actual user-selected topic, not the recommended default.")
            if data.get("brief") and data["brief"]["topic"] != payload["topic"]:
                raise StudioError("Selected topic differs from the brief; update the brief first")
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
                if payload.get("local_path"):
                    path = Path(payload["local_path"]).expanduser().resolve()
                    if not path.is_file():
                        raise StudioError("Local source file does not exist")
                    payload["local_path"] = str(path)
                else:
                    public_url(payload.get("url", ""))
                if not payload.get("title") or payload.get("kind") not in {"video", "article", "paper", "image", "audio", "script"}:
                    raise StudioError("Source needs title and kind (video/article/paper/image/audio/script).")
                payload.setdefault("rights", "unknown")
            collection = data["sources" if kind == "source" else "beats"]
            old = next((x for x in collection if x["id"] == payload["id"]), None)
            if old == payload:
                return data
            if old:
                if kind == "source" and any(x["source_id"] == payload["id"] for x in data["downloads"].values()) and old.get("url") != payload.get("url"):
                    raise StudioError("A downloaded source URL is immutable; create a new source id.")
                collection[collection.index(old)] = payload
            else:
                collection.append(payload)
            if sum(x["kind"] == "video" for x in data["sources"]) > data["settings"]["max_video_sources"]:
                raise StudioError("Run video-source budget exceeded.")
        elif kind == "brief":
            if data.get("brief") == payload:
                return data
            apply_brief(data, payload, directory)
        elif kind == "material_plan":
            if not data.get("brief") or payload.get("topic") != data["brief"]["topic"]:
                raise StudioError("Material plan must match the current brief topic")
            expected = data["style_snapshot"]["selector"] if data.get("style_snapshot") else None
            if payload.get("style") != expected or not payload.get("needs"):
                raise StudioError("Material plan needs the selected style version and shot needs")
            for need in payload["needs"]:
                if not all(need.get(k) for k in ("id", "purpose", "query", "acceptance")):
                    raise StudioError("Material need requires id, purpose, topic/style-aware query and acceptance")
            data["material_plan"] = payload
        elif kind == "production_plan":
            production_plan.validate(payload, data)
            used = {u["sourceId"] for s in payload["shots"] for u in s["sourceUses"]}
            stored = {"plan": payload, "sha256": digest(payload),
                      "source_hashes": {s["id"]: s.get("sha256") for s in data["sources"] if s["id"] in used},
                      "source_signatures": {s["id"]: digest(production_plan.source_identity(s)) for s in data["sources"] if s["id"] in used}}
            if data.get("production_plan") == stored:
                return data
            data["production_policy_version"] = 1
            data["production_plan"] = stored
        elif kind == "style_plan":
            style_plan.validate(payload, data)
            stored = {"plan": payload, "sha256": digest(payload)}
            if data.get("style_plan") == stored:
                return data
            data["style_plan"] = stored
        elif kind == "review":
            key = payload.get("check")
            if key not in REVIEW_KEYS or payload.get("result") not in {"pass", "fail", "unverified", "not_applicable"}:
                raise StudioError("Unknown review check or result")
            if not payload.get("evidence") or not re.fullmatch(r"[0-9a-f]{64}", payload.get("artifact_sha256", "")):
                raise StudioError("Review needs observations and the actual export hash")
            if payload["result"] == "not_applicable" and (key != "music_fit" or not payload.get("not_applicable_reason")):
                raise StudioError("Only music_fit without BGM can be not_applicable; record actual evidence")
            if payload["result"] in {"pass", "not_applicable"}:
                if payload.get("method") != REVIEW_METHODS[key] or not payload.get("reviewer") or not payload.get("observations"):
                    raise StudioError("Pass needs the appropriate method, reviewer and observations")
                if not payload.get("evidence_files") or not all(file_proof(ref, directory) for ref in payload["evidence_files"]):
                    raise StudioError("Pass needs existing SHA-256-bound evidence files")
                if any(issue.get("status") not in {"resolved", "intended"} for issue in payload.get("issues", [])):
                    raise StudioError("Unresolved issues cannot receive pass or not_applicable")
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
        if not data.get("selection") or not data.get("brief"):
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
    if end <= start:
        raise StudioError("A source range must be positive.")
    with locked(directory):
        data = load_run(directory)
        if not data.get("selection") or not data.get("brief"):
            raise StudioError("Select a topic before downloading production media.")
        source = next((x for x in data["sources"] if x["id"] == source_id and x["kind"] == "video"), None)
        if not source:
            raise StudioError("Register a video source first.")
        if not source.get("url"):
            raise StudioError("Local sources are imported directly; no download needed")
        key = digest([source["url"], start, end])[:24]
        old = data["downloads"].get(key)
        folder = Path(directory).resolve() / "media"
        folder.mkdir(exist_ok=True)
        path = folder / f"{source_id}-{key}.mp4"
        if old and old["status"] == "completed":
            if not path.is_file() or old.get("sha256") != file_hash(path):
                raise StudioError("Completed download is missing or its hash changed; inspect and explicitly repair this source before reuse.")
            return {**old, "reused": True}
        total = sum(x["end"] - x["start"] for k, x in data["downloads"].items() if k != key)
        if total + end - start > data["settings"]["max_download_seconds"]:
            raise StudioError("This run would exceed its configured acquisition budget.")
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
            args = downloader_args() + ["--download-sections", f"*{start}-{end}", "--force-keyframes-at-cuts", "--max-filesize", "1G", "-f", f"bv*[height<=?{max(data['settings'].get('width') or 1080, data['settings'].get('height') or 1080)}]+ba/b", "--merge-output-format", "mp4", "--remux-video", "mp4", "-o", str(folder / f"{source_id}-{key}.%(ext)s"), source["url"]]
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


def file_proof(ref, base):
    try:
        path = Path(ref["path"]).expanduser()
        if not path.is_absolute():
            path = Path(base) / path
        return path.is_file() and file_hash(path) == ref["sha256"]
    except (OSError, KeyError, TypeError):
        return False


def audit_data(data, media, captions, artifact_hash, subtitle_hash=None, review_base=None):
    failures, warnings, pending = [], [], []
    settings = data["settings"]
    try:
        validate_settings(settings, complete=True)
    except (StudioError, ValueError) as exc:
        failures.append("output_requirements_missing_or_invalid:" + str(exc))
    streams = media.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    # AAC encoder padding can extend the container beyond the last video frame.
    # Visual coverage and timeline bounds must follow the video stream itself.
    try:
        duration = float(video.get("duration", media.get("format", {}).get("duration", 0)))
    except (TypeError, ValueError):
        duration = 0
    if not math.isfinite(duration) or duration <= 0:
        failures.append("invalid_duration")
        duration = 0
    if settings.get("min_seconds") and duration < settings["min_seconds"]:
        failures.append("duration_below_requested_minimum")
    if settings.get("max_seconds") and duration > settings["max_seconds"] + .1:
        failures.append("duration_above_requested_maximum")
    if (video.get("width"), video.get("height"), video.get("codec_name")) != (settings["width"], settings["height"], "h264"):
        failures.append("video_format_differs_from_brief")
    try:
        num, den = map(float, video.get("avg_frame_rate", "0/1").split("/"))
        fps = num / den
    except (ValueError, ZeroDivisionError):
        fps = 0
    if not math.isfinite(fps) or not settings.get("fps") or abs(fps - settings["fps"]) > .01:
        failures.append("fps_differs_from_brief")
    fps = settings.get("fps") or 1
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    if settings.get("audio_required") and not has_audio:
        failures.append("missing_audio_stream")
    if not data.get("brief") or not data.get("selection") or not all(data.get("project", {}).get(k) for k in ("projectId", "timelineId")):
        failures.append("missing_brief_selection_or_editable_project")
    if settings.get("captions") and not captions:
        failures.append("empty_subtitles")
    previous = 0
    for i, card in enumerate(captions):
        if card["end"] <= card["start"] or card["start"] < previous - 1 / fps or card["end"] > duration + .2:
            failures.append(f"caption_{i + 1}_timing_invalid")
        if not card["lines"]:
            failures.append(f"caption_{i + 1}_empty")
        previous = card["end"]
    sources = {s["id"]: s for s in data["sources"]}
    if not data["beats"]:
        failures.append("missing_storyboard")
    for beat in data["beats"]:
        label = beat["id"]
        if any(ref not in sources for ref in beat.get("source_ids", [])):
            failures.append(f"{label}:unknown_source")
        if beat.get("claims") and not beat.get("source_ids"):
            failures.append(f"{label}:missing_fact_sources")
        if not beat.get("visual_anchor"):
            failures.append(f"{label}:missing_visual_intent")
        try:
            first, last = beat["from_frame"], beat["to_frame"]
            if type(first) is not int or type(last) is not int or not 0 <= first < last <= round(duration * fps) + 1:
                raise ValueError("Invalid frame interval")
            if beat.get("narration"):
                audio = number(beat.get("audio_duration_seconds"), "audio_duration_seconds", .01)
                if not beat.get("audio_asset_id") or abs((last - first) / fps - audio) > .2:
                    failures.append(f"{label}:audio_fit_outside_200ms")
        except (StudioError, KeyError, ValueError, TypeError):
            failures.append(f"{label}:missing_actual_timing")
    for source in sources.values():
        if source.get("rights", "unknown") == "unknown":
            warnings.append(f"{source['id']}:rights_unknown")
    for key, entry in data.get("operations", {}).items():
        if entry["status"] in {"reserved", "submitted"}:
            failures.append(f"{key}:unresolved_remote_operation")
    required = {"visuals", "occlusion", "transitions", "flicker", "output_details"}
    if has_audio: required.update({"audio_listening", "av_sync", "music_fit"})
    if settings.get("captions"): required.update({"caption_sync", "caption_flow"})
    if any(b.get("claims") for b in data["beats"]): required.add("facts")
    snapshot = data.get("style_snapshot")
    style_rules = []
    if snapshot:
        required.add("style_match")
        try:
            folder = Path(snapshot["skill_path"]).parent
            if any(file_hash(folder / n) != h for n, h in snapshot["files"].items()):
                raise ValueError("Changed style snapshot")
            style_rules = styles.validate(read(folder / "style.json"))["rules"]
        except (OSError, ValueError, KeyError):
            failures.append("style_snapshot_missing_or_changed")
    frames = round(duration * fps)
    style_implementation = []
    if snapshot or data.get("style_plan"):
        try:
            style_implementation = style_plan.implementation_errors(data, review_base, frames)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            style_implementation = ["style_plan_invalid:" + str(exc)]
        failures.extend(style_implementation)
    common_implementation = []
    if data.get("production_policy_version") == 1 or data.get("production_plan"):
        required.add("material_continuity")
        try:
            if production_plan.layout(settings)["mode"] == "portrait-safe":
                required.add("portrait_layout")
            common_implementation = production_plan.implementation_errors(data, review_base, frames)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            common_implementation = ["production_plan_invalid:" + str(exc)]
        failures.extend(common_implementation)
    check_results = {key: {"status": "not_applicable"} for key in REVIEW_KEYS - required}
    for key in sorted(required):
        review = data["reviews"].get(key, {})
        outcome_ok = review.get("result") == "pass" or (key == "music_fit" and
            review.get("result") == "not_applicable" and review.get("not_applicable_reason") and not music_expected(data))
        valid = (outcome_ok and review.get("artifact_sha256") == artifact_hash
                 and review.get("revision") == data["revision"] and review.get("method") == REVIEW_METHODS[key]
                 and review.get("reviewer") and review.get("observations") and review.get("evidence_files")
                 and all(file_proof(ref, review_base) for ref in review["evidence_files"]))
        valid = valid and all(issue.get("status") in {"resolved", "intended"} for issue in review.get("issues", []))
        if key != "facts":
            valid = valid and review.get("coverage_frames") == [0, frames]
        if key in {"caption_sync", "caption_flow"}:
            valid = valid and review.get("subtitle_sha256") == subtitle_hash
        if key in {"material_continuity", "portrait_layout"}:
            valid = valid and not common_implementation and review.get("production_plan_sha256") == data.get("production_plan", {}).get("sha256")
        if key == "style_match":
            rows = review.get("rules", {})
            valid = valid and review.get("style") == snapshot["selector"] and set(rows) == {r["id"] for r in style_rules}
            overrides = data["brief"].get("style_overrides", {})
            planned = data.get("style_plan")
            decisions = {r["ruleId"]: r for r in planned["plan"]["stylePlan"]["rules"]} if planned and planned["plan"].get("stylePlan") else {}
            def rule_passes(rid, row):
                if not isinstance(row, dict) or not row.get("observations"):
                    return False
                state = decisions.get(rid, {}).get("disposition")
                if rid in overrides:
                    return row.get("result") == "overridden"
                if state == "not_applicable":
                    return row.get("result") == "not_applicable"
                return row.get("result") == "pass"
            valid = valid and all(rule_passes(k, v) for k, v in rows.items())
            if planned:
                valid = valid and review.get("style_plan_sha256") == planned["sha256"]
            valid = valid and not style_implementation
        if not valid:
            pending.append(key)
        check_results[key] = {"status": review.get("result") if valid else
                             ("fail" if review.get("result") == "fail" else "unverified"),
                             "method": REVIEW_METHODS[key], "observations": review.get("observations"),
                             "issues": review.get("issues", []),
                             "evidence_current": bool(valid)}
    return {"technical_pass": not failures, "failures": failures, "warnings": warnings,
            "review_pending": pending, "completed": not failures and not pending,
            "checks": check_results,
            "artifact_sha256": artifact_hash, "subtitle_sha256": subtitle_hash, "checked_at": now(),
            "note": "Technical checks do not establish visual, listening or style quality."}


def audit(directory, video, subtitles=None, evidence=None):
    snapshot = load_run(directory)
    media = probe_media(video)
    # Decode every frame. Creative choices such as silence or long shots have no fixed thresholds.
    execute(["ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-i", Path(video).resolve(), "-f", "null", "-"], timeout=600)
    with locked(directory):
        data = load_run(directory)
        if data["revision"] != snapshot["revision"]:
            raise StudioError("Run changed during audit; inspect current revision before retrying")
        report = audit_data(data, media, parse_srt(subtitles) if subtitles else [], file_hash(video),
                            file_hash(subtitles) if subtitles else None, directory)
        report["decode_pass"] = True
        data["last_audit"] = report
        data["status"] = "completed" if report["completed"] else "review_pending"
        write(Path(directory) / "qa-report.json", report)
        save_run(directory, data, "audit")
        return report


def doctor():
    programs = {name: shutil.which(name) for name in ("ffmpeg", "ffprobe", "node", "deno")}
    for name in ("ffmpeg", "ffprobe"):
        try:
            programs[name] = native_tool(name)
        except StudioError:
            programs[name] = None
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


def preflight(capabilities=None, style_selector=None, pack_root=None):
    """Check only the capabilities needed for the next operation; never install or download."""
    requested = list(capabilities) if isinstance(capabilities, list) else capabilities
    if requested is None:
        requested = ["python", "media", "repository", "downloader", "repository_media", "git_lfs", *style_media.CHECKS.values()]
    allowed = {"python", "media", "repository", "downloader", "repository_media", "git_lfs", *style_media.CHECKS.values()}
    if not isinstance(requested, list) or any(item not in allowed for item in requested):
        raise StudioError("Unknown preflight capability.")
    if style_selector is not None and not isinstance(style_selector, str):
        raise StudioError("Style selector must be text")
    style_check = style_media.CHECKS.get((style_selector or '').split('@')[0])
    if style_check:
        requested.extend(["git_lfs", style_check])
    report = doctor()
    checks = report["executable_checks"]
    ca_ready = False
    try:
        import ssl
        ca_ready = ssl.create_default_context().cert_store_stats().get("x509_ca", 0) > 0
    except (ImportError, OSError, ValueError):
        pass
    python_ok = sys.version_info >= (3, 10) and all(report["stdlib"].values()) and ca_ready
    media_ok = all(checks[name]["ok"] for name in ("ffmpeg", "ffprobe")) and report["diagnostic_filters_available"]
    yt_version = re.search(r"(\d{4})\.(\d+)\.(\d+)", checks["yt-dlp"].get("version", ""))
    pinned_version = re.search(r"==(\d{4})\.(\d+)\.(\d+)", (ROOT / "requirements-runtime.txt").read_text())
    yt_ready = checks["yt-dlp"]["ok"] and bool(yt_version and pinned_version and tuple(map(int, yt_version.groups())) >= tuple(map(int, pinned_version.groups())))
    node_version = re.search(r"v?(\d+)\.", checks["node"].get("version", ""))
    js_ready = checks["deno"]["ok"] or bool(checks["node"]["ok"] and node_version and int(node_version[1]) >= 20)
    downloader_ok = yt_ready and js_ready
    gh = shutil.which("gh")
    repository_ok = False
    if "repository" in requested and gh:
        try:
            execute([gh, "--version"], timeout=10)
            execute([gh, "auth", "status"], timeout=10)
            repository_ok = True
        except StudioError:
            pass
    curl = shutil.which("curl")
    curl_ok = False
    if "repository_media" in requested and curl:
        try:
            execute([curl, "--version"], timeout=5)
            curl_ok = True
        except StudioError:
            pass
    results = {
        "repository_media": {"id": "repository_media", "label": "仓库媒体下载", "ok": curl_ok,
                             "message": "curl 可用，沿用现有代理设置" if curl_ok else "curl 缺失或无法运行",
                             "remedy": "安装可用的 curl 并重新检测；固定版本公开媒体直采不需要调用 Agent 或登录 GitHub。"},
        "python": {"id": "python", "label": "Python 与 HTTPS", "ok": bool(python_ok),
                   "message": f"Python {report['python_version']} · HTTPS 证书{'可用' if ca_ready else '不可用'}",
                   "remedy": "使用完整的 Python 3.10+，确保 venv、ssl、email.encoders、urllib.request 及 CA 证书可用；修复后重新检测。"},
        "media": {"id": "media", "label": "媒体探测与校验", "ok": bool(media_ok),
                  "message": "FFmpeg、ffprobe 与诊断滤镜可用" if media_ok else "FFmpeg、ffprobe 或 blackdetect/silencedetect/freezedetect 滤镜缺失或无法运行",
                  "remedy": "安装完整 FFmpeg（macOS 可用 brew install ffmpeg），或将 VIDEO_STUDIO_FFMPEG_DIR 指向包含 ffmpeg 和 ffprobe 的目录，再重新检测。"},
        "repository": {"id": "repository", "label": "GitHub 仓库访问", "ok": repository_ok,
                       "message": "GitHub CLI 已安装且已登录" if repository_ok else "GitHub CLI 缺失、无法运行或尚未登录",
                       "remedy": "安装 GitHub CLI（macOS 可用 brew install gh），完成 gh auth login 后重新检测。仓库访问权限仍以实际读取响应为准。"},
        "downloader": {"id": "downloader", "label": "网页视频下载", "ok": bool(downloader_ok),
                       "message": "yt-dlp 与 JavaScript 运行时可用" if downloader_ok else "yt-dlp / JavaScript 运行时缺失、版本过旧或无法运行",
                       "remedy": "点击补齐下载依赖，在插件独立虚拟环境安装固定版本 yt-dlp；同时确保 Node.js 20+ 或 Deno 可用。",
                       "canPrepare": not yt_ready and bool(python_ok)},
    }
    if "git_lfs" in requested:
        results["git_lfs"] = style_media.git_lfs_check()
    if any(key in requested for key in style_media.CHECKS.values()):
        results.update({row["id"]: row for row in style_media.check_media(style_selector, pack_root)})
    selected = [results[item] for item in dict.fromkeys(requested)]
    return {"styleSelector": style_selector, "ready": all(item["ok"] or item.get("required") is False for item in selected), "checkedAt": now(), "checks": selected,
            "python": report["python"], "programs": {**report["programs"], "gh": gh, "curl": curl}, "chatcut": "requires_live_mcp_probe"}


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


def connection(observation, directory=None):
    """Report a live host observation without mutating the production checkpoint."""
    previous = None
    if directory:
        directory = Path(directory).expanduser().resolve()
        data = load_run(directory)
        report_path = directory / "connection-check.json"
        if report_path.exists():
            previous = read(report_path)
    report = check_connection.diagnose(observation, check_connection.registration(), previous)
    if directory:
        integrity = {}
        for key, item in data.get("downloads", {}).items():
            if item.get("status") != "completed":
                continue
            path = Path(item.get("path") or "__missing_download_path__")
            if not path.is_absolute():
                path = directory / path
            try:
                if not path.is_file():
                    result = "missing"
                elif not item.get("sha256"):
                    result = "unverified"
                else:
                    result = "verified" if file_hash(path) == item["sha256"] else "hash_mismatch"
            except OSError:
                result = "unreadable"
            integrity[key] = result
        report["resume"] = {
            "run": str(directory), "run_status": data.get("status"),
            "project": {k: data.get("project", {}).get(k) for k in ("projectId", "timelineId")},
            "completed_downloads": len(integrity), "download_integrity": integrity,
            "downloads_to_review": [k for k, v in integrity.items() if v != "verified"],
            "operations_to_reconcile": [k for k, v in data.get("operations", {}).items()
                                        if v.get("status") in {"reserved", "submitted"}],
            "instruction": "先核对现有任务和素材；不重新生成结果未知的操作。",
        }
        with locked(directory):
            write(report_path, report)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    subs.add_parser("doctor")
    p = subs.add_parser("preflight"); p.add_argument("--capability", action="append", choices=["python", "media", "repository", "downloader", "repository_media", "git_lfs", *style_media.CHECKS.values()]); p.add_argument("--style"); p.add_argument("--pack-root")
    subs.add_parser("bootstrap")
    p = subs.add_parser("connection"); p.add_argument("--file", required=True); p.add_argument("--run")
    p = subs.add_parser("profile"); p.add_argument("--merge-file")
    p = subs.add_parser("new"); p.add_argument("--title", required=True); p.add_argument("--output-root"); p.add_argument("--brief")
    p = subs.add_parser("status"); p.add_argument("--run", required=True)
    p = subs.add_parser("record"); p.add_argument("--run", required=True); p.add_argument("--kind", choices=["source", "beat", "selection", "project", "brief", "material_plan", "production_plan", "style_plan", "review"], required=True); p.add_argument("--file", required=True)
    p = subs.add_parser("operation"); p.add_argument("action", choices=["reserve", "resolve"]); p.add_argument("--run", required=True); p.add_argument("--key", required=True); p.add_argument("--file", required=True); p.add_argument("--state", choices=["submitted", "completed", "failed"])
    p = subs.add_parser("probe"); p.add_argument("--url", required=True)
    p = subs.add_parser("fetch"); p.add_argument("--run", required=True); p.add_argument("--source", required=True); p.add_argument("--start", type=float, required=True); p.add_argument("--end", type=float, required=True)
    p = subs.add_parser("audit"); p.add_argument("--run", required=True); p.add_argument("--video", required=True); p.add_argument("--subtitles"); p.add_argument("--evidence")
    p = subs.add_parser("styles"); p.add_argument("action", choices=["list", "show", "add", "choices", "import", "link-pack"]); p.add_argument("--selector"); p.add_argument("--file"); p.add_argument("--apply-preferences", action="store_true")
    args = parser.parse_args(argv)
    try:
        command = args.command
        if command == "doctor": result = doctor()
        elif command == "preflight": result = preflight(args.capability, args.style, args.pack_root)
        elif command == "bootstrap": result = bootstrap()
        elif command == "connection": result = connection(read(args.file), args.run)
        elif command == "profile": result = save_profile(read(args.merge_file)) if args.merge_file else profile()
        elif command == "new": result = new_run(args.title, args.output_root, read(args.brief) if args.brief else None)
        elif command == "styles":
            if args.action == "list": result = styles.catalog()
            elif args.action == "show": result = styles.resolve(args.selector)
            elif args.action == "choices": result = styles.choices()
            elif args.action == "link-pack": result = style_media.link_pack(args.file)
            elif args.action == "import":
                import user_packs
                result = user_packs.install(args.file, args.apply_preferences)
            else: result = styles.register(read(args.file))
        elif command == "status": result = load_run(args.run)
        elif command == "record": result = record(args.run, args.kind, read(args.file))
        elif command == "operation": result = operation(args.run, args.action, args.key, read(args.file), args.state)
        elif command == "probe": result = probe_url(args.url)
        elif command == "fetch": result = fetch(args.run, args.source, args.start, args.end)
        elif command == "audit": result = audit(args.run, args.video, args.subtitles, args.evidence)
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
        if command in {"doctor", "bootstrap"} and not result["local_ready"]: return 2
        if command == "preflight" and not result["ready"]: return 2
        if command == "connection" and not result["ready"]: return 2
        if command == "audit" and not result["completed"]: return 2
        return 0
    except (StudioError, OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
