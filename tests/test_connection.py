import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "plugins/video-studio/scripts"))
import check_connection as connection
import studio


class ConnectionTests(unittest.TestCase):
    def test_cli_login_and_browser_editor_never_establish_live_access(self):
        result = connection.diagnose({"tools_available": False, "auth": "login_succeeded"}, "enabled")
        self.assertEqual(result["state"], "tools_not_loaded")
        self.assertEqual(result["next_action"], "reload_session")
        self.assertFalse(result["ready"])
        self.assertFalse(result["automatic_login"])

    def test_missing_tools_with_unknown_registration_does_not_trigger_install(self):
        self.assertEqual(connection.diagnose({"tools_available": False})["state"], "unverified")

    def test_explicit_probe_outweighs_stale_auth_and_cli_state(self):
        result = connection.diagnose({"tools_available": True, "live_probe": "success", "auth": "required", "startup": "issuer_missing"}, "missing")
        self.assertTrue(result["ready"])

    def test_recovery_routes_are_distinct(self):
        cases = [
            ({"tools_available": False}, "missing", "registration_missing"),
            ({"tools_available": False}, "disabled", "registration_disabled"),
            ({"tools_available": True}, "enabled", "probe_required"),
            ({"tools_available": True, "live_probe": "auth_required"}, "enabled", "auth_required"),
            ({"tools_available": True, "live_probe": "failed"}, "enabled", "connection_failed"),
            ({"tools_available": False, "startup": "issuer_missing", "auth": "login_succeeded"}, "enabled", "host_auth_metadata_error"),
            ({"tools_available": False, "startup": "timeout"}, "enabled", "startup_failed"),
        ]
        for observation, registered, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(connection.diagnose(observation, registered)["state"], expected)

    def test_unchanged_evidence_does_not_prompt_another_repair_loop(self):
        obs = {"tools_available": False, "auth": "login_succeeded", "session_id": "session-1"}
        first = connection.diagnose(obs, "enabled")
        self.assertTrue(connection.diagnose(obs, "enabled", first)["unchanged_since_previous_check"])
        changed = {**obs, "session_id": "session-2"}
        self.assertFalse(connection.diagnose(changed, "enabled", first)["unchanged_since_previous_check"])

    def test_secrets_raw_logs_and_contradictory_observations_are_rejected(self):
        for obs in [{"token": "secret"}, {"error": "https://host/?code=secret"},
                    {"tools_available": "false"}, {"session_id": "https://host/?code=secret"},
                    {"tools_available": False, "live_probe": "success"}]:
            with self.subTest(obs=obs), self.assertRaises(ValueError):
                connection.diagnose(obs)

    def test_registration_discards_sensitive_configuration(self):
        payload = {"enabled": True, "transport": {"url": "https://host/?secret=private", "http_headers": {"Authorization": "Bearer private"}}}
        with mock.patch.object(connection.shutil, "which", return_value="codex"), mock.patch.object(connection.subprocess, "run", return_value=mock.Mock(returncode=0, stdout=json.dumps(payload))):
            self.assertEqual(connection.registration(), "enabled")

    def test_cli_failures_do_not_imply_missing_registration(self):
        with mock.patch.object(connection.shutil, "which", return_value="codex"), mock.patch.object(connection.subprocess, "run", return_value=mock.Mock(returncode=1, stderr="network unavailable")):
            self.assertEqual(connection.registration(), "unknown")

    def test_preflight_preserves_run_revision_jobs_and_assets(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.dict(studio.os.environ, {"VIDEO_STUDIO_HOME": str(Path(temp) / "state")}):
            run = Path(studio.new_run("resume", Path(temp) / "runs", {"topic":"resume","style":None,"requirements":{"width":1080,"height":1920,"fps":30,"narration":False,"captions":False,"audio_required":False}})["run"])
            studio.record(run, "selection", {"topic": "resume", "confirmed_by_user": True})
            studio.operation(run, "reserve", "voice:b1", {"text": "keep"})
            studio.operation(run, "reserve", "music:b1", {"prompt": "keep"})
            studio.operation(run, "resolve", "music:b1", {"jobId": "existing-job"}, "submitted")
            data = studio.load_run(run)
            data["downloads"] = {"source": {"status": "completed", "path": "existing.mp4"}}
            studio.write(run / "run.json", data)
            before = (run / "run.json").read_bytes()
            with mock.patch.object(connection, "registration", return_value="enabled"):
                report = studio.connection({"tools_available": False}, run)
            self.assertEqual((run / "run.json").read_bytes(), before)
            self.assertEqual(report["resume"]["operations_to_reconcile"], ["voice:b1", "music:b1"])
            self.assertEqual(report["resume"]["completed_downloads"], 1)
            self.assertTrue((run / "connection-check.json").exists())

    def test_resume_checks_existing_media_without_rewriting_checkpoint(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.dict(studio.os.environ, {"VIDEO_STUDIO_HOME": str(Path(temp) / "state")}):
            run = Path(studio.new_run("resume", Path(temp) / "runs", {"topic":"resume","style":None,"requirements":{"width":1080,"height":1920,"fps":30,"narration":False,"captions":False,"audio_required":False}})["run"])
            media = run / "clip.mp4"
            media.write_bytes(b"original")
            original_hash = studio.file_hash(media)
            data = studio.load_run(run)
            data["downloads"] = {
                "valid": {"status": "completed", "path": "clip.mp4", "sha256": original_hash},
                "changed": {"status": "completed", "path": "clip.mp4", "sha256": "0" * 64},
                "absent": {"status": "completed", "path": "absent.mp4", "sha256": original_hash},
            }
            studio.write(run / "run.json", data)
            before = (run / "run.json").read_bytes()
            with mock.patch.object(connection, "registration", return_value="enabled"):
                report = studio.connection({"tools_available": False}, run)
            self.assertEqual(report["resume"]["download_integrity"], {"valid": "verified", "changed": "hash_mismatch", "absent": "missing"})
            self.assertEqual((run / "run.json").read_bytes(), before)

    def test_changed_completed_download_never_becomes_accepted_by_duration(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.dict(studio.os.environ, {"VIDEO_STUDIO_HOME": str(Path(temp) / "state")}):
            run = Path(studio.new_run("resume", Path(temp) / "runs", {"topic":"resume","style":None,"requirements":{"width":1080,"height":1920,"fps":30,"narration":False,"captions":False,"audio_required":False}})["run"])
            studio.record(run, "selection", {"topic": "resume", "confirmed_by_user": True})
            data = studio.load_run(run)
            url = "https://example.com/clip.mp4"
            data["sources"] = [{"id": "s1", "url": url, "kind": "video"}]
            key = studio.digest([url, 0, 10])[:24]
            folder = run / "media"
            folder.mkdir()
            media = folder / f"s1-{key}.mp4"
            media.write_bytes(b"changed")
            data["downloads"][key] = {"status": "completed", "path": str(media), "sha256": "0" * 64}
            studio.write(run / "run.json", data)
            before = (run / "run.json").read_bytes()
            with mock.patch.object(studio, "execute") as network, mock.patch.object(studio, "probe_media") as probe:
                with self.assertRaises(studio.StudioError):
                    studio.fetch(run, "s1", 0, 10)
                network.assert_not_called()
                probe.assert_not_called()
            self.assertEqual((run / "run.json").read_bytes(), before)

    def test_cli_returns_blocked_exit_code_without_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "observed.json"
            path.write_text('{"tools_available":false}')
            with mock.patch.object(connection, "registration", return_value="enabled"), mock.patch("builtins.print"):
                self.assertEqual(studio.main(["connection", "--file", str(path)]), 2)


if __name__ == "__main__":
    unittest.main()
