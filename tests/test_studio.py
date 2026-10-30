import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "plugins/video-studio/scripts"))
spec = importlib.util.spec_from_file_location("studio", ROOT / "plugins/video-studio/scripts/studio.py")
studio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(studio)
pack_spec = importlib.util.spec_from_file_location("package", ROOT / "tools/package.py")
package = importlib.util.module_from_spec(pack_spec)
pack_spec.loader.exec_module(package)


class StudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = mock.patch.dict(os.environ, {"VIDEO_STUDIO_HOME": str(self.root / "state")})
        self.env.start()
        self.brief = {"topic":"Test topic", "style":None, "requirements":{"width":1080,"height":1920,"fps":30,"narration":True,"captions":True,"audio_required":True}}
        self.run = Path(studio.new_run("测试", self.root / "runs", self.brief)["run"])

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def select(self):
        studio.record(self.run, "selection", {"topic": "Test topic", "confirmed_by_user": True})

    def source(self, id="s1", url="https://example.org/video"):
        studio.record(self.run, "source", {"id": id, "kind": "video", "title": "Source", "url": url})

    def test_topic_selection_is_required_before_side_effects(self):
        with self.assertRaises(studio.StudioError):
            studio.operation(self.run, "reserve", "tts:b1", {"text": "hello"})
        with self.assertRaises(studio.StudioError):
            studio.record(self.run, "selection", {"topic": "Default", "confirmed_by_user": False})

    def test_resume_does_not_resubmit_reserved_submitted_or_completed_job(self):
        self.select()
        payload = {"text": "hello", "voiceId": "from-live-catalog"}
        self.assertTrue(studio.operation(self.run, "reserve", "tts:b1", payload)["should_submit"])
        self.assertFalse(studio.operation(self.run, "reserve", "tts:b1", payload)["should_submit"])
        studio.operation(self.run, "resolve", "tts:b1", {"jobId": "actual-job"}, "submitted")
        self.assertFalse(studio.operation(self.run, "reserve", "tts:b1", payload)["should_submit"])
        studio.operation(self.run, "resolve", "tts:b1", {"assetId": "actual-asset"}, "completed")
        self.assertFalse(studio.operation(self.run, "reserve", "tts:b1", payload)["should_submit"])
        with self.assertRaises(studio.StudioError):
            studio.operation(self.run, "reserve", "tts:b1", {"text": "changed"})

    def test_terminal_job_result_cannot_be_overwritten(self):
        self.select()
        studio.operation(self.run, "reserve", "import:s1", {"source": "s1"})
        studio.operation(self.run, "resolve", "import:s1", {"assetId": "asset-1"}, "completed")
        with self.assertRaises(studio.StudioError):
            studio.operation(self.run, "resolve", "import:s1", {"assetId": "asset-2"}, "completed")

    def test_failed_attempt_remains_reserved_for_deduplication(self):
        self.select()
        payload = {"source": "s1"}
        studio.operation(self.run, "reserve", "import:s1", payload)
        studio.operation(self.run, "resolve", "import:s1", {"observed_failure": "remote rejected unsupported media"}, "failed")
        self.assertFalse(studio.operation(self.run, "reserve", "import:s1", payload)["should_submit"])

    def test_source_limit_is_atomic(self):
        for i in range(6): self.source(f"s{i}", f"https://example.org/{i}")
        before = (self.run / "run.json").read_bytes()
        with self.assertRaises(studio.StudioError): self.source("s7")
        self.assertEqual(before, (self.run / "run.json").read_bytes())

    def test_same_run_cannot_be_mutated_concurrently(self):
        with studio.locked(self.run):
            with self.assertRaises(studio.StudioError): self.source()

    def test_direct_media_without_extractor_duration_uses_probe(self):
        with mock.patch.object(studio, "downloader_args", return_value=["yt-dlp"]), mock.patch.object(studio, "execute", side_effect=[mock.Mock(stdout='{"title":"direct","duration":null}'), mock.Mock(stdout='{"format":{"duration":"10.5"}}')]):
            result = studio.probe_url("https://example.org/source.mp4")
            self.assertEqual(result["duration"], 10.5)
            self.assertEqual(result["duration_evidence"], "ffprobe_remote_header")

    def test_download_budget_checked_before_network(self):
        self.select(); self.source()
        data = studio.load_run(self.run)
        data["downloads"]["existing"] = {"source_id": "s1", "start": 0, "end": 290, "status": "reserved"}
        studio.write(self.run / "run.json", data)
        with mock.patch.object(studio, "execute") as network:
            with self.assertRaises(studio.StudioError): studio.fetch(self.run, "s1", 300, 320)
            network.assert_not_called()

    def test_unavailable_source_preserves_recoverable_state_without_import(self):
        self.select(); self.source()
        with mock.patch.object(studio, "probe_url", side_effect=studio.StudioError("Source unavailable")), mock.patch.object(studio, "execute") as download:
            with self.assertRaisesRegex(studio.StudioError, "unavailable"):
                studio.fetch(self.run, "s1", 0, 10)
            download.assert_not_called()
        state = studio.load_run(self.run)
        self.assertEqual(len(state["downloads"]), 1)
        self.assertEqual(next(iter(state["downloads"].values()))["status"], "reserved")
        self.assertFalse(state["operations"])
        # A distinct replacement can be registered without overwriting provenance.
        self.source("s2", "https://example.org/replacement")
        self.assertEqual(len(studio.load_run(self.run)["sources"]), 2)

    def test_corrupt_or_nonfinite_ranges_are_rejected(self):
        self.select(); self.source()
        for start, end in [(0, float("nan")), (-1, 1), (2, 1), (0, float("inf"))]:
            with self.assertRaises(studio.StudioError): studio.fetch(self.run, "s1", start, end)

    def test_completed_download_reused_without_subprocess(self):
        self.select(); self.source()
        key = studio.digest(["https://example.org/video", 0, 10])[:24]
        media = self.run / "media"; media.mkdir()
        path = media / f"s1-{key}.mp4"; path.write_bytes(b"fixture")
        data = studio.load_run(self.run)
        data["downloads"][key] = {"source_id": "s1", "start": 0, "end": 10, "status": "completed", "path": str(path), "sha256": studio.file_hash(path)}
        studio.write(self.run / "run.json", data)
        with mock.patch.object(studio, "execute") as network:
            self.assertTrue(studio.fetch(self.run, "s1", 0, 10)["reused"])
            network.assert_not_called()

    def test_url_passed_as_argument_not_shell_code(self):
        url = "https://example.org/watch?v=a&x=$(echo-danger)"
        with mock.patch.object(studio, "downloader_args", return_value=["yt-dlp"]), mock.patch.object(studio, "execute", return_value=mock.Mock(stdout='{"duration":20}')) as call:
            studio.probe_url(url)
            self.assertEqual(call.call_args.args[0][-1], url)
        for url in ("file:///etc/passwd", "https://name:password@example.org/x"):
            with self.assertRaises(studio.StudioError): studio.public_url(url)

    def test_source_change_invalidates_reviews(self):
        self.source()
        studio.record(self.run, "review", {"check": "facts", "result": "unverified", "artifact_sha256": "a" * 64, "evidence": "reviewed fixture"})
        self.source("s2", "https://example.org/other")
        self.assertEqual(studio.load_run(self.run)["reviews"], {})

    def test_unconfirmed_voice_and_unknown_settings_rejected(self):
        with self.assertRaises(studio.StudioError): studio.save_profile({"voice": {"name": "Guess", "provider": "p", "voiceId": "id"}})
        with self.assertRaises(studio.StudioError): studio.save_profile({"publsih": True})

    def fixture(self):
        data = studio.load_run(self.run)
        data.pop("production_policy_version", None)  # Legacy audit recovery fixture.
        data.update(selection={"topic": "fixture", "confirmed_by_user": True}, project={"projectId": "p", "timelineId": "t"}, sources=[{"id": "s1", "rights": "unknown"}], beats=[{"id": "b1", "narration": "fixture", "visual_anchor": "fixture", "source_ids": ["s1"], "audio_asset_id": "a1", "audio_duration_seconds": 90, "from_frame": 0, "to_frame": 2700}])
        media = {"format": {"duration": "90"}, "streams": [{"codec_type": "video", "codec_name": "h264", "width": 1080, "height": 1920, "avg_frame_rate": "30/1"}, {"codec_type": "audio"}]}
        cards = [{"start": 0, "end": 3, "lines": ["fixture"]}]
        return data, media, cards

    def test_valid_file_checks_never_invent_listening_or_visual_review(self):
        data, media, cards = self.fixture()
        report = studio.audit_data(data, media, cards, "a" * 64, "b" * 64)
        self.assertTrue(report["technical_pass"])
        self.assertFalse(report["completed"])
        self.assertIn("audio_listening", report["review_pending"])

    def test_changed_export_or_subtitles_require_fresh_review(self):
        data, media, cards = self.fixture()
        data["reviews"] = {k: {"result": "pass", "artifact_sha256": "a" * 64, "subtitle_sha256": "b" * 64, "revision": data["revision"]} for k in studio.REVIEW_KEYS}
        self.assertFalse(studio.audit_data(data, media, cards, "a" * 64, "b" * 64)["completed"])
        self.assertFalse(studio.audit_data(data, media, cards, "c" * 64, "b" * 64)["completed"])
        self.assertIn("caption_sync", studio.audit_data(data, media, cards, "a" * 64, "c" * 64)["review_pending"])

    def test_bad_timing_and_unresolved_remote_jobs_fail_audit(self):
        data, media, cards = self.fixture()
        data["beats"][0]["audio_duration_seconds"] = 95
        data["operations"] = {"export:1": {"status": "reserved"}}
        cards.append({"start": 2, "end": 91, "lines": ["a", "b", "c"]})
        report = studio.audit_data(data, media, cards, "a" * 64, "b" * 64)
        self.assertFalse(report["technical_pass"])
        self.assertIn("b1:audio_fit_outside_200ms", report["failures"])
        self.assertIn("export:1:unresolved_remote_operation", report["failures"])



    def test_srt_unicode_crlf_and_malformed_timestamp(self):
        path = self.root / "test.srt"
        path.write_bytes("\ufeff1\r\n00:00:00,100 --> 00:00:02,000\r\n机器人\r\n第二行\r\n".encode("utf-8"))
        self.assertEqual(studio.parse_srt(path)[0]["lines"], ["机器人", "第二行"])
        path.write_text("1\n00:99:00,000 --> 00:00:01,000\nwrong\n")
        with self.assertRaises(studio.StudioError): studio.parse_srt(path)



    def test_missing_dependencies_do_not_report_ready(self):
        with mock.patch.object(studio.shutil, "which", return_value=None), mock.patch.object(studio, "downloader", side_effect=studio.StudioError("missing")):
            self.assertFalse(studio.doctor()["local_ready"])

    def test_broken_binary_on_path_does_not_report_ready(self):
        with mock.patch.object(studio.shutil, "which", return_value="/broken/tool"), mock.patch.object(studio, "downloader", return_value="/broken/yt-dlp"), mock.patch.object(studio, "execute", side_effect=studio.StudioError("dynamic library missing")):
            report = studio.doctor()
            self.assertFalse(report["local_ready"])
            self.assertFalse(report["executable_checks"]["ffmpeg"]["ok"])

    def test_preflight_blocks_missing_downloader_only_for_operations_that_need_it(self):
        report = {"python": "/test/python", "python_version": "3.11.0", "stdlib": {"ssl": True},
                  "programs": {}, "diagnostic_filters_available": True,
                  "executable_checks": {"ffmpeg": {"ok": True}, "ffprobe": {"ok": True},
                                        "node": {"ok": True, "version": "v20.0.0"}, "deno": {"ok": False}, "yt-dlp": {"ok": False}}}
        with mock.patch.object(studio, "doctor", return_value=report):
            self.assertTrue(studio.preflight(["media"])["ready"])
            missing = studio.preflight(["downloader"])
            self.assertFalse(missing["ready"])
            self.assertTrue(missing["checks"][0]["canPrepare"])
            report["executable_checks"]["yt-dlp"] = {"ok": True, "version": "2026.08.19"}
            self.assertTrue(studio.preflight(["downloader"])["ready"])
            report["executable_checks"]["node"]["version"] = "v18.0.0"
            self.assertFalse(studio.preflight(["downloader"])["ready"])
            report["executable_checks"]["node"]["version"] = "v20.0.0"
            report["executable_checks"]["yt-dlp"]["version"] = "2025.01.01"
            self.assertFalse(studio.preflight(["downloader"])["ready"])

    def test_preflight_rejects_invalid_capabilities_and_broken_https_certificates(self):
        import ssl
        with self.assertRaises(studio.StudioError):
            studio.preflight(["run-arbitrary-command"])
        with mock.patch.object(ssl, "create_default_context", side_effect=OSError("certificate store unavailable")):
            self.assertFalse(studio.preflight(["python"])["ready"])

    def test_package_excludes_private_state_and_is_reproducible(self):
        for relative in package.FILES:
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((ROOT / relative).read_bytes())
        (self.root / "profile.json").write_text('{"token":"secret"}')
        (self.root / "private.mp4").write_bytes(b"private")
        first = package.build(self.root)
        second = package.build(self.root)
        self.assertEqual(first["sha256"], second["sha256"])
        with zipfile.ZipFile(first["archive"]) as archive:
            self.assertFalse(any(name.endswith(("profile.json", "private.mp4")) for name in archive.namelist()))
            self.assertTrue(any(name.endswith(".agents/plugins/marketplace.json") for name in archive.namelist()))


if __name__ == "__main__":
    unittest.main()
