"""Versioned sampled/objective review gate; legacy reviews keep their methods."""
from pathlib import Path

POLICY = "sampled-objective-v1"
METHODS = {
    "visuals": "sampled_composited_frames", "occlusion": "sampled_composited_frames",
    "portrait_layout": "sampled_composited_frames", "material_continuity": "sampled_source_windows",
    "transitions": "boundary_frames_and_signal_scan", "caption_flow": "boundary_frames_and_signal_scan",
    "flicker": "boundary_frames_and_signal_scan", "audio_listening": "objective_audio_metrics",
    "av_sync": "timeline_words_and_audio_metrics", "music_fit": "objective_mix_and_context",
    "caption_sync": "word_alignment_and_frames", "output_details": "export_and_boundary_inspection",
    "facts": "source_review", "style_match": "reference_comparison",
}
VISUAL = {"visuals", "occlusion", "portrait_layout", "material_continuity", "transitions",
          "caption_flow", "flicker", "style_match", "output_details", "av_sync", "caption_sync"}


def enabled(data):
    return (data.get("brief") or {}).get("requirements", {}).get("review_policy") == POLICY


def methods(data, legacy):
    return METHODS if enabled(data) else legacy


def valid_identity(value):
    return isinstance(value, str) and 0 < len(value) <= 512 and not any(c.isspace() or ord(c) < 32 for c in value)


def provenance_errors(review):
    # These are host/parent-agent IDs, not names supplied by the reviewing model.
    # The host still has to bind them to real worker lifecycle/tool records.
    errors = []
    for key in ("reviewer", "reviewer_job_id", "producer_job_id"):
        if not valid_identity(review.get(key)):
            errors.append(key + "_identity_missing_or_invalid")
    if (valid_identity(review.get("reviewer_job_id")) and valid_identity(review.get("producer_job_id"))
            and review["reviewer_job_id"] == review["producer_job_id"]):
        errors.append("reviewer_job_must_differ_from_producer_job")
    return errors


def probe(data, base, artifact, subtitle, read, file_hash):
    """Only accept a probe linked to this revision and all unchanged files."""
    root = Path(base).resolve()
    value = read(root / "quality-probe.json")
    if value.get("artifact_sha256") != artifact or value.get("subtitle_sha256") != subtitle or value.get("revision") != data["revision"]:
        raise ValueError("quality_probe_stale")
    for ref in value["evidence_files"]:
        file = Path(ref["path"]).resolve()
        if not file.is_relative_to(root) or file_hash(file) != ref["sha256"]:
            raise ValueError("quality_probe_evidence_changed")
    manifest, metrics = read(value["manifest"]), read(value["metrics"])
    for record in (manifest, metrics):
        if record.get("artifact_sha256") != artifact or record.get("revision") != data["revision"] or record.get("policy") != POLICY:
            raise ValueError("quality_probe_record_mismatch")
    for ref in manifest["contact_sheets"]:
        file = Path(ref["path"]).resolve()
        if not file.is_relative_to(root) or file_hash(file) != ref["sha256"]:
            raise ValueError("quality_probe_sheet_changed")
    return value, manifest, metrics


def review_errors(data, review, base, read, file_hash):
    if not enabled(data):
        return []
    errors = provenance_errors(review)
    try:
        value, manifest, metrics = probe(data, base, review.get("artifact_sha256"), review.get("subtitle_sha256"), read, file_hash)
        # Non-caption checks also bind the actual subtitle version via the probe.
    except (OSError, ValueError, TypeError, KeyError):
        try:
            value = read(Path(base) / "quality-probe.json")
            if review["check"] in {"caption_sync", "caption_flow"}:
                raise ValueError("subtitles differ")
            value, manifest, metrics = probe(data, base, review.get("artifact_sha256"), value.get("subtitle_sha256"), read, file_hash)
        except (OSError, ValueError, TypeError, KeyError):
            return errors + ["quality_probe_missing_or_stale"]
    if review.get("probe_sha256") != file_hash(value["manifest"]):
        errors.append("review_not_bound_to_probe")
    if review["check"] in VISUAL:
        if not manifest.get("timeline_complete"):
            errors.append("complete_timeline_boundaries_missing")
        actual = review.get("observed_sheets", [])
        expected = [s["id"] for s in manifest["contact_sheets"]]
        if not expected or not isinstance(actual, list) or set(actual) != set(expected):
            errors.append("sampled_sheets_not_fully_reviewed")
    check = review["check"]
    # Output checks must also reject missing expected audio, because a video with
    # no audio stream would otherwise have no applicable audio review checks.
    # not_applicable music_fit remains subject to these same objective failures.
    if check in {"audio_listening", "av_sync", "music_fit", "output_details"}:
        errors.extend(metrics.get("audio", {}).get("hard_failures", []))
    if check == "music_fit" and data.get("settings", {}).get("narration"):
        project = data.get("project", {})
        if (project.get("music_asset_id") or project.get("music_tracks") or project.get("music_enabled")) and metrics.get("music", {}).get("status") not in {"pass", "needs_review"}:
            errors.append("music_mix_evidence_missing")
    if check in {"caption_sync", "caption_flow"}:
        sync = metrics.get("sync", {})
        if sync.get("status") != "checked":
            errors.append("actual_caption_alignment_evidence_missing")
        else:
            report = sync["report"]
            if (not report["caption_sync"].get("coverage_complete") or report["caption_sync"].get("outside_frame_tolerance")
                    or report.get("source_window_issues") or not report["export_matches_cards"].get("matches")):
                errors.append("caption_alignment_failed")
    if check == "av_sync" and data.get("settings", {}).get("narration"):
        if metrics.get("speech_activity", {}).get("status") != "checked":
            errors.append("final_mix_speech_activity_missing")
        errors.extend(metrics.get("speech_activity", {}).get("hard_failures", []))
        if metrics.get("narration_alignment", {}).get("status") != "checked":
            errors.append("final_mix_narration_waveform_alignment_unverified")
        errors.extend(metrics.get("narration_alignment", {}).get("hard_failures", []))
    return errors
