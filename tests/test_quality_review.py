import copy
from pathlib import Path
import unittest
import test_styles as fixtures
import studio
import styles

class QualityTests(unittest.TestCase):
    setUp = fixtures.StyleTests.setUp
    tearDown = fixtures.StyleTests.tearDown
    brief = fixtures.StyleTests.brief
    fixture = fixtures.StyleTests.fixture
    spec = fixtures.StyleTests.spec

    def record_pass(self, run, key, **extra):
        evidence=run/"inspection.txt"
        evidence.write_text("Synthetic test evidence. Not a real video review.")
        payload={"check":key,"result":"pass","artifact_sha256":"a"*64,
                 "reviewer":"unit fixture","method":studio.REVIEW_METHODS[key],
                 "observations":"synthetic observation","evidence":"unit fixture",
                 "coverage_frames":[0,4500],"evidence_files":[{"path":str(evidence),"sha256":studio.file_hash(evidence)}],
                 "issues":[],**extra}
        studio.record(run,"review",payload)

    def report(self, run, media, captions=None, sha="a"*64, subtitle_hash=None):
        return studio.audit_data(studio.load_run(run),media,captions or [],sha,subtitle_hash,run)

    def test_every_visual_check_is_required_and_no_automatic_pass(self):
        run,media=self.fixture()
        r=self.report(run,media)
        self.assertEqual(set(r["review_pending"]),{"visuals","occlusion","transitions","flicker","output_details"})
        for key in list(r["review_pending"])[:-1]: self.record_pass(run,key)
        self.assertFalse(self.report(run,media)["completed"])
        for key in self.report(run,media)["review_pending"]: self.record_pass(run,key)
        self.assertTrue(self.report(run,media)["completed"])
        self.assertFalse(self.report(run,media,sha="b"*64)["completed"])

    def test_audio_requires_sync_listening_and_music_context(self):
        run,media=self.fixture();media["streams"].append({"codec_type":"audio"})
        pending=self.report(run,media)["review_pending"]
        self.assertTrue({"av_sync","audio_listening","music_fit"}.issubset(pending))
        for key in pending:
            if key=="music_fit":
                self.record_pass(run,key,result="not_applicable",not_applicable_reason="Actual fixture has no BGM")
            else: self.record_pass(run,key)
        self.assertTrue(self.report(run,media)["completed"])
        studio.record(run,"project",{"projectId":"p","music_tracks":["music"]})
        self.record_pass(run,"music_fit",result="not_applicable",not_applicable_reason="contradictory declaration")
        self.assertIn("music_fit",self.report(run,media)["review_pending"])

    def test_audio_padding_does_not_extend_visual_coverage(self):
        run,media=self.fixture()
        video=next(s for s in media["streams"] if s["codec_type"]=="video")
        video["duration"]="180.000000"
        media["format"]["duration"]="180.068000"
        media["streams"].append({"codec_type":"audio","duration":"180.068000"})
        for key in self.report(run,media)["review_pending"]:
            self.record_pass(run,key)
        report=self.report(run,media)
        self.assertTrue(report["completed"],report)
        self.record_pass(run,"flicker",coverage_frames=[0,4502])
        self.assertIn("flicker",self.report(run,media)["review_pending"])

    def test_invalid_video_duration_does_not_use_longer_container(self):
        run,media=self.fixture()
        video=next(s for s in media["streams"] if s["codec_type"]=="video")
        for duration in ("N/A", "nan", None):
            with self.subTest(duration=duration):
                video["duration"]=duration
                self.assertIn("invalid_duration",self.report(run,media)["failures"])

    def test_caption_entry_and_exit_are_separate_from_word_sync(self):
        run,media=self.fixture()
        data=studio.load_run(run);data["settings"]["captions"]=True;studio.write(run/"run.json",data)
        caps=[{"start":0,"end":3,"lines":["fixture"]}]
        pending=self.report(run,media,caps,subtitle_hash="s"*64)["review_pending"]
        self.assertTrue({"caption_sync","caption_flow"}.issubset(pending))
        for key in pending: self.record_pass(run,key,subtitle_sha256="s"*64)
        self.assertTrue(self.report(run,media,caps,subtitle_hash="s"*64)["completed"])
        changed=self.report(run,media,caps,subtitle_hash="t"*64)
        self.assertTrue({"caption_sync","caption_flow"}.issubset(changed["review_pending"]))

    def test_open_issue_cannot_receive_pass(self):
        run,_=self.fixture()
        with self.assertRaisesRegex(studio.StudioError,"Unresolved"):
            self.record_pass(run,"flicker",issues=[{"id":"q1","status":"open","from_frame":300,"to_frame":301}])
        self.record_pass(run,"flicker",result="fail",issues=[{"id":"q1","status":"open"}])
        self.assertEqual(studio.load_run(run)["reviews"]["flicker"]["result"],"fail")

    def test_core_checks_cannot_be_skipped_and_samples_do_not_certify_playback(self):
        run,media=self.fixture()
        with self.assertRaises(studio.StudioError):
            self.record_pass(run,"occlusion",result="not_applicable",not_applicable_reason="guess")
        with self.assertRaises(studio.StudioError):
            self.record_pass(run,"visuals",method="frame_inspection")
        self.record_pass(run,"flicker",coverage_frames=[0,100])
        self.assertIn("flicker",self.report(run,media)["review_pending"])

    def test_evidence_changes_invalidate_reviews(self):
        run,media=self.fixture()
        for key in self.report(run,media)["review_pending"]: self.record_pass(run,key)
        (run/"inspection.txt").write_text("changed")
        self.assertFalse(self.report(run,media)["completed"])

    def test_selected_style_requires_per_rule_observations(self):
        styles.register(self.spec());run,media=self.fixture("sample")
        for key in self.report(run,media)["review_pending"]:
            self.record_pass(run,key,style="sample@1",rules={})
        self.assertIn("style_match",self.report(run,media)["review_pending"])
        self.record_pass(run,"style_match",style="sample@1",
                         rules={"structure":{"result":"pass","observations":"fixture comparison"}})
        self.assertTrue(self.report(run,media)["completed"])
        Path(studio.load_run(run)["style_snapshot"]["skill_path"]).write_text("tampered")
        self.assertFalse(self.report(run,media)["completed"])

    def test_topic_change_invalidates_selection_and_material_plan(self):
        run,_=self.fixture()
        studio.record(run,"material_plan",{"topic":"咖啡","style":None,"needs":[
            {"id":"n","purpose":"过程","query":"coffee brewing","acceptance":"actual process"}]})
        studio.record(run,"brief",self.brief(topic="旅行"))
        data=studio.load_run(run)
        self.assertIsNone(data["selection"])
        self.assertIsNone(data["material_plan"])
        with self.assertRaises(studio.StudioError):
            studio.operation(run,"reserve","voice:1",{"text":"changed topic"})


if __name__=="__main__":
    unittest.main()
