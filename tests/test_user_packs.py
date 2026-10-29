import copy
import json
from pathlib import Path
import shutil
import unittest
from unittest import mock

import test_styles as fixtures
import studio
import styles
import user_packs


class UserPackTests(unittest.TestCase):
    setUp = fixtures.StyleTests.setUp
    tearDown = fixtures.StyleTests.tearDown
    spec = fixtures.StyleTests.spec

    def pack(self):
        folder = self.root / "pack"
        folder.mkdir()
        (folder / "evidence.md").write_text("Real location in synthetic fixture, not a media review.")
        spec = self.spec()
        spec["references"][0]["locator"] = "pack:evidence.md"
        studio.write(folder / "style.json", spec)
        studio.write(folder / "manifest.json", {"schema_version": 1, "id": "example", "version": 1,
            "styles": ["style.json"], "profile_patch": {"max_seconds": 60,
                "production_preferences": {"notes_file": "pack:evidence.md"}}})
        return folder

    def test_import_is_explicit_and_does_not_set_default_or_preferences(self):
        folder = self.pack()
        result = user_packs.install(folder / "manifest.json")
        self.assertFalse(result["preferences_applied"])
        self.assertIsNone(studio.profile()["max_seconds"])
        self.assertIsNone(studio.profile()["default_style"])
        self.assertEqual(styles.catalog()[0]["validation_status"], "unverified")

    def test_evidence_survives_source_removal_and_reimport_is_idempotent(self):
        folder = self.pack()
        result = user_packs.install(folder / "manifest.json", True)
        self.assertEqual(result, user_packs.install(folder / "manifest.json", True))
        evidence = Path(styles.resolve("sample@1")["spec"]["references"][0]["locator"])
        self.assertTrue(evidence.is_file())
        self.assertEqual(studio.profile()["max_seconds"], 60)
        self.assertEqual(studio.profile()["production_preferences"]["notes_file"], str(evidence))
        shutil.rmtree(folder)
        self.assertTrue(evidence.is_file())
        self.assertEqual(len(styles.catalog()), 1)

    def test_all_style_conflicts_are_detected_before_new_entries_are_installed(self):
        folder = self.pack()
        existing = self.spec()
        styles.register(existing)
        new = self.spec(); new["id"] = "new-entry"
        studio.write(folder / "new.json", new)
        manifest = studio.read(folder / "manifest.json")
        manifest["styles"] = ["new.json", "style.json"]
        studio.write(folder / "manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "conflict"):
            user_packs.install(folder / "manifest.json")
        self.assertEqual([x["id"] for x in styles.catalog()], ["sample"])
        self.assertFalse((studio.home() / "user-packs/example/1").exists())

    def test_changed_imported_evidence_is_not_silently_repaired(self):
        folder = self.pack()
        result = user_packs.install(folder / "manifest.json")
        (Path(result["path"]) / "evidence.md").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "changed"):
            user_packs.install(folder / "manifest.json")

    def test_pack_paths_cannot_escape_or_point_to_media(self):
        folder = self.pack()
        for locator in ("pack:../outside.md", "pack:/tmp/outside.md", "pack:clip.mp4"):
            spec = self.spec(); spec["references"][0]["locator"] = locator
            studio.write(folder / "style.json", spec)
            (folder / "clip.mp4").write_bytes(b"not a text reference")
            with self.assertRaises(ValueError):
                user_packs.install(folder / "manifest.json")
        self.assertEqual(styles.catalog(), [])

    def test_choice_ids_pin_versions_and_never_start_production(self):
        styles.register(self.spec()); styles.register(self.spec(2))
        result = styles.choices()
        self.assertEqual([x["id"] for x in result["options"]], ["sample@1", "sample@2"])
        self.assertFalse(result["selection_sets_default"])
        self.assertFalse(result["selection_starts_production"])
        Path(styles.resolve("sample@1")["skill_path"]).write_text("tampered")
        result = styles.choices()
        self.assertEqual([x["id"] for x in result["options"]], ["sample@2"])
        self.assertEqual(len(result["errors"]), 1)

    def test_duration_limit_preserves_one_tenth_second_tolerance(self):
        run, media = fixtures.StyleTests.fixture(self)
        data = studio.load_run(run)
        data["settings"]["max_seconds"] = 180
        # Fixtures without a stream duration retain the container fallback.
        for duration in ("180", "180.05", "180.1", "180.1001"):
            with self.subTest(duration=duration):
                media["format"]["duration"] = duration
                result = studio.audit_data(data, media, [], "a" * 64)
                self.assertEqual("duration_above_requested_maximum" in result["failures"],
                                 float(duration) > 180.1)

    def test_video_duration_controls_limit_even_with_audio_padding(self):
        run, media = fixtures.StyleTests.fixture(self)
        data = studio.load_run(run)
        data["settings"]["max_seconds"] = 180
        video = next(s for s in media["streams"] if s["codec_type"] == "video")
        media["format"]["duration"] = "180.18"
        video["duration"] = "180.1"
        self.assertTrue(studio.audit_data(data, media, [], "a" * 64)["technical_pass"])
        video["duration"] = "180.1001"
        self.assertIn("duration_above_requested_maximum",
                      studio.audit_data(data, media, [], "a" * 64)["failures"])

    def brief(self, **extra):
        return fixtures.StyleTests.brief(self, **extra)


if __name__ == "__main__":
    unittest.main()
