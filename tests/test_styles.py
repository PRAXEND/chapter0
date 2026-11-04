import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "plugins/video-studio/scripts"))
import studio
import styles

class StyleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = mock.patch.dict(os.environ, {"VIDEO_STUDIO_HOME": str(self.root / "state")})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def spec(self, version=1):
        return {"schema_version":1,"id":"sample","version":version,"name":"解释型参考",
            "description":"脚本结构","adaptation":"以新题材替换对象与事实",
            "references":[{"id":"r1","kind":"script","locator":"user-script.txt"}],
            "rules":[{"id":"structure","dimension":"narrative","instruction":"问题与回答逐步推进",
                "check":"回答对应开头问题","basis":"observed",
                "evidence":[{"reference_id":"r1","location":"paragraphs 1–3"}]}],
            "unknown_dimensions":sorted(styles.DIMENSIONS-{"narrative"}),"material_requirements":[]}

    def brief(self, **extra):
        return {"topic":"咖啡","style":None,"requirements":{"width":1920,"height":1080,"fps":25,
            "target_seconds":180,"narration":False,"captions":False,"audio_required":False},**extra}

    def fixture(self, style=None):
        run=Path(studio.new_run("coffee",self.root/"runs",self.brief(style=style))["run"])
        # Original fixtures model pre-common-policy runs; new policy is tested separately.
        legacy = studio.load_run(run); legacy.pop("production_policy_version", None)
        studio.write(run/"run.json", legacy)
        studio.record(run,"selection",{"topic":"咖啡","confirmed_by_user":True})
        studio.record(run,"project",{"projectId":"p","timelineId":"t"})
        studio.record(run,"beat",{"id":"b","visual_anchor":"完整过程","from_frame":0,"to_frame":4500})
        media={"format":{"duration":"180"},"streams":[{"codec_type":"video","codec_name":"h264",
            "width":1920,"height":1080,"avg_frame_rate":"25/1"}]}
        return run,media

    def test_empty_install_has_no_preset(self):
        self.assertEqual([],styles.catalog())
        for k in ("language","width","height","fps","voice","default_style","target_seconds"):
            self.assertIsNone(studio.profile()[k])

    def test_saved_skill_discovered_in_new_process(self):
        v=styles.register(self.spec())
        self.assertIn("name: style-sample",Path(v["skill_path"]).read_text())
        self.assertEqual(v["validation_status"],"unverified")
        r=subprocess.run([sys.executable,str(ROOT/"plugins/video-studio/scripts/studio.py"),"styles","list"],
                         capture_output=True,text=True,check=True)
        self.assertEqual(json.loads(r.stdout)[0]["selector"],"sample@1")

    def test_versions_and_snapshot_are_immutable(self):
        styles.register(self.spec())
        run,_=self.fixture("sample")
        snapshot=studio.load_run(run)["style_snapshot"]
        before=Path(snapshot["skill_path"]).read_bytes()
        with self.assertRaises(ValueError): styles.register(self.spec())
        v=self.spec(2);v["rules"][0]["instruction"]="新版规则";styles.register(v)
        self.assertEqual(styles.resolve("sample")["version"],2)
        self.assertEqual(studio.load_run(run)["style_snapshot"]["version"],1)
        import shutil
        shutil.rmtree(styles.root())
        self.assertEqual(before,Path(snapshot["skill_path"]).read_bytes())

    def test_script_cannot_establish_audiovisual_style(self):
        for d in styles.DIMENSIONS-styles.TEXT_DIMENSIONS:
            v=self.spec();v["rules"][0]["dimension"]=d;v["unknown_dimensions"]=sorted(styles.DIMENSIONS-{d})
            with self.assertRaisesRegex(ValueError,"Script-only"): styles.register(v)
        self.assertEqual([],styles.catalog())

    def test_rule_evidence_and_checks_are_required(self):
        for change in ({"evidence":[]},{"check":""},{"basis":"guess"}):
            v=self.spec();v["rules"][0].update(change)
            with self.assertRaises(ValueError): styles.register(v)

    def test_unknown_dimensions_and_path_traversal(self):
        v=self.spec();v["unknown_dimensions"]=[]
        with self.assertRaises(ValueError): styles.register(v)
        for slug in ("../../x","a/b","/tmp/evil","A"):
            v=self.spec();v["id"]=slug
            with self.assertRaises(ValueError): styles.register(v)
        for sel in ("../sample","sample@0","sample@2"):
            with self.assertRaises(ValueError): styles.resolve(sel)

    def test_tampered_library_is_rejected(self):
        v=styles.register(self.spec());Path(v["skill_path"]).write_text("tampered")
        with self.assertRaises(ValueError): styles.resolve("sample")
        self.assertIn("error",styles.catalog()[0])

    def test_user_override_is_project_local(self):
        styles.register(self.spec())
        run=Path(studio.new_run("coffee",self.root/"runs",self.brief(style="sample@1",
            style_overrides={"structure":"本期先给答案"}))["run"])
        self.assertEqual(styles.resolve("sample")["spec"]["rules"][0]["instruction"],"问题与回答逐步推进")
        with self.assertRaises(studio.StudioError):
            studio.record(run,"brief",self.brief(style="sample",style_overrides={"absent":"x"}))

    def test_landscape_long_silent_movie_needs_no_narration(self):
        run,media=self.fixture()
        r=studio.audit_data(studio.load_run(run),media,[],"a"*64)
        self.assertTrue(r["technical_pass"],r["failures"])
        self.assertNotIn("audio_listening",r["review_pending"])
        self.assertNotIn("caption_sync",r["review_pending"])
        self.assertNotIn("style_match",r["review_pending"])

    def test_material_plan_matches_topic_and_style(self):
        styles.register(self.spec());run,_=self.fixture("sample")
        need={"id":"n1","purpose":"冲煮过程","query":"coffee brewing complete process","acceptance":"完整操作"}
        for topic,style in (("汽车","sample@1"),("咖啡",None)):
            with self.assertRaises(studio.StudioError):
                studio.record(run,"material_plan",{"topic":topic,"style":style,"needs":[need]})
        studio.record(run,"material_plan",{"topic":"咖啡","style":"sample@1","needs":[need]})

    def test_settings_and_budget_are_configurable(self):
        studio.save_profile({"width":1280,"height":720,"fps":24,"target_seconds":240,
            "max_video_sources":9,"max_download_seconds":900})
        self.assertEqual(studio.profile()["max_download_seconds"],900)
        with self.assertRaises(studio.StudioError): studio.save_profile({"width":1279})

    def test_old_run_is_not_silently_migrated(self):
        run=self.root/"legacy";run.mkdir();studio.write(run/"run.json",{"schema_version":1})
        before=(run/"run.json").read_bytes()
        with self.assertRaises(studio.StudioError): studio.load_run(run)
        self.assertEqual(before,(run/"run.json").read_bytes())

    def test_explicit_no_style_overrides_a_missing_saved_default(self):
        styles.register(self.spec())
        studio.save_profile({"default_style":"sample"})
        self.assertEqual(studio.profile()["default_style"],"sample@1")
        import shutil
        shutil.rmtree(styles.root())
        run,media=self.fixture()
        self.assertIsNone(studio.load_run(run)["style_snapshot"])
        self.assertTrue(studio.audit_data(studio.load_run(run),media,[],"a"*64)["technical_pass"])

    def test_video_reference_and_material_requirements_are_saved(self):
        value=self.spec()
        value["references"].append({"id":"video1","kind":"video","locator":"user-video.mp4"})
        value["rules"].append({"id":"shot-rule","dimension":"shots","instruction":"保留完整操作",
            "check":"操作起止可见","basis":"observed",
            "evidence":[{"reference_id":"video1","location":"00:10–00:25"}]})
        value["unknown_dimensions"].remove("shots")
        value["material_requirements"]=[{"role":"操作镜头","search_hint":"{topic} complete process",
            "acceptance":"起止清楚","rule_id":"shot-rule"}]
        saved=styles.register(value)
        self.assertEqual(saved["spec"]["material_requirements"][0]["rule_id"],"shot-rule")

if __name__=="__main__":
    unittest.main()
