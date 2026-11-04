"""Real diagnostic media plus synthetic review records; no production claims."""
import array
import copy
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins/video-studio/scripts"))
import studio
import quality_probe as qp
import quality_policy as policy
import review_music
import web_bridge


class SamplingTests(unittest.TestCase):
    def test_long_sparse_selection_keeps_exact_frames_with_bounded_parser_depth(self):
        if not studio.native_tool('ffmpeg'): self.skipTest('FFmpeg unavailable')
        expected = sorted({*range(0, 4500, 15), *range(1000, 1020), 4499})
        selector = qp.sample_selector(expected)
        output = qp.run_media(['ffmpeg', '-hide_banner', '-v', 'info', '-f', 'lavfi', '-i',
                               'testsrc2=s=16x16:r=30:d=150', '-vf', "select='" + selector + "',showinfo",
                               '-fps_mode', 'vfr', '-f', 'null', '-'])
        self.assertEqual([int(n) for n in re.findall(r'\bn:\s*\d+\s+pts:\s*(\d+)', output.stderr)], expected)
        # Also parse the full 20-minute base-sampling budget on a short source.
        qp.run_media(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=16x16:r=30:d=1',
                      '-vf', "select='" + qp.sample_selector(list(range(0, 36000, 15))) + "'", '-f', 'null', '-'])

    def test_extraction_error_is_readable_and_preserves_full_diagnostics(self):
        with tempfile.TemporaryDirectory() as temp:
            log = Path(temp) / 'error.log'
            cause = 'Error while parsing expression ' + 'eq(n,15)+' * 300
            with patch.object(studio, 'native_tool', return_value='ffmpeg'), patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', cause)):
                with self.assertRaisesRegex(ValueError, '视频画面抽取失败') as caught:
                    qp.run_media(['ffmpeg'], diagnostic_log=log)
            self.assertNotIn('eq(n,', str(caught.exception))
            self.assertEqual(log.read_text(), cause)
            with patch.object(studio, 'native_tool', return_value='ffmpeg'), patch.object(subprocess, 'run', side_effect=subprocess.TimeoutExpired(['ffmpeg', cause], 1, stderr=b'last diagnostic')):
                with self.assertRaisesRegex(ValueError, '视频画面抽取超时') as timed_out:
                    qp.run_media(['ffmpeg', cause], timeout=1, diagnostic_log=log)
            self.assertNotIn('eq(n,', str(timed_out.exception))
            self.assertIn('last diagnostic', log.read_text())

    def test_real_frame_bounds_and_dense_motion_and_boundary_windows(self):
        data = {"beats": [{"from_frame": 0, "to_frame": 100,
                 "design_results": [{"from_frame": 40, "to_frame": 70}]}],
                "_timeline_entries": [{"timelineRange": {"fromFrame": 21, "toFrame": 33}}]}
        schedule = qp.frame_schedule(data, 100, 25, [{"start": .6, "end": 2.6}])
        frames = schedule["sample_frames"]
        self.assertEqual(frames, sorted(set(frames)))
        self.assertEqual((frames[0], frames[-1]), (0, 99))
        self.assertTrue(set(range(14, 29)).issubset(frames))
        self.assertTrue(all(any(abs(n - target) <= 1 for n in frames) for target in range(40, 70, 3)))
        self.assertTrue(set(range(8, 23)).issubset(frames))

    def test_pcm_keeps_phase_channels_and_reports_rises(self):
        with tempfile.TemporaryDirectory() as temp:
            raw = Path(temp) / "signal.f32"
            values = array.array("f", [x for i in range(24000) for x in ((.01 if i < 12000 else .5), (-.01 if i < 12000 else -.5))])
            if sys.byteorder != "little": values.byteswap()
            raw.write_bytes(values.tobytes())
            measured = qp.waveform(raw, 2)
            self.assertAlmostEqual(measured["duration"], 1)
            self.assertAlmostEqual(measured["sample_peak_dbfs"], -6.021, places=3)
            self.assertTrue(measured["candidates"])
            self.assertEqual(measured["windows"][0]["channels"][0]["rms_dbfs"], measured["windows"][0]["channels"][1]["rms_dbfs"])


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {"VIDEO_STUDIO_HOME": str(self.root / "profile")}); self.env.start()
        self.brief = {"topic": "Synthetic", "style": None, "requirements": {
            "width": 160, "height": 90, "fps": 25, "max_seconds": 2, "target_seconds": 2,
            "narration": False, "captions": False, "audio_required": False, "review_policy": policy.POLICY}}
        self.run = Path(studio.new_run("Synthetic", self.root / "runs", self.brief)["run"])
        data = studio.load_run(self.run); data.pop("production_policy_version", None); studio.write(self.run / "run.json", data)
        studio.record(self.run, "selection", {"topic": "Synthetic", "confirmed_by_user": True})
        studio.record(self.run, "project", {"projectId": "test-project", "timelineId": "test-timeline"})
        studio.record(self.run, "beat", {"id": "b1", "from_frame": 0, "to_frame": 50, "visual_anchor": "synthetic"})
        studio.write(self.run / "review-evidence.json", {"timeline": {"timeline": {"entries": [], "totalEntries": 0}}})

    def tearDown(self): self.env.stop(); self.tmp.cleanup()

    def movie(self, name="synthetic.mp4", signal=None):
        file = self.run / name
        args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=25"]
        if signal: args += ["-f", "lavfi", "-i", signal]
        args += ["-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]
        if signal: args += ["-c:a", "aac"]
        qp.run_media([*args, file]); return file

    def review_payload(self, probe, check, **extra):
        sheets = [s["id"] for s in studio.read(probe["manifest"])["contact_sheets"]]
        return {"check": check, "result": "pass", "artifact_sha256": probe["artifact_sha256"],
                "reviewer": "synthetic-independent-thread", "reviewer_job_id": "synthetic-review-job",
                "producer_job_id": "synthetic-production-job", "method": policy.METHODS[check],
                "evidence": "synthetic test only", "observations": "synthetic", "coverage_frames": [0, 50],
                "evidence_files": probe["evidence_files"], "probe_sha256": studio.file_hash(probe["manifest"]),
                "observed_sheets": sheets, "issues": [], **extra}

    def reviews(self, probe):
        data = studio.load_run(self.run)
        media = {"streams": [{"codec_type": "video", "codec_name": "h264", "width": 160, "height": 90,
                              "duration": "2", "avg_frame_rate": "25/1"}], "format": {"duration": "2"}}
        report = studio.audit_data(data, media, [], probe["artifact_sha256"], review_base=self.run)
        for check in report["review_pending"]:
            studio.record(self.run, "review", self.review_payload(probe, check))
        return studio.audit_data(studio.load_run(self.run), media, [], probe["artifact_sha256"], review_base=self.run)

    def test_real_probe_and_policy_bound_reviews(self):
        if not studio.native_tool("ffmpeg"): self.skipTest("FFmpeg unavailable")
        video = self.movie(); probe = qp.prepare(self.run, video)
        self.assertEqual(probe["frames"], 50)
        self.assertTrue(studio.read(probe["metrics"])["full_decode"])
        sheets = studio.read(probe["manifest"])["contact_sheets"]
        self.assertTrue(sheets)
        self.assertTrue(self.reviews(probe)["completed"])
        Path(sheets[0]["path"]).write_bytes(b"changed sheet")
        data = studio.load_run(self.run)
        review = next(iter(data["reviews"].values()))
        self.assertTrue(policy.review_errors(data, review, self.run, studio.read, studio.file_hash))

    def test_unreviewed_sheets_and_legacy_method_cannot_pass(self):
        if not studio.native_tool("ffmpeg"): self.skipTest("FFmpeg unavailable")
        probe = qp.prepare(self.run, self.movie()); self.reviews(probe)
        review = studio.load_run(self.run)["reviews"]["visuals"]
        with self.assertRaisesRegex(studio.StudioError, "Sampled review"):
            studio.record(self.run, "review", {**review, "observed_sheets": []})
        with self.assertRaisesRegex(studio.StudioError, "appropriate method"):
            studio.record(self.run, "review", {**review, "method": "continuous_playback"})
        studio.record(self.run, "project", {"projectId": "changed"})
        with self.assertRaisesRegex(studio.StudioError, "Sampled review"):
            studio.record(self.run, "review", review)

    def test_sampled_pass_requires_distinct_host_producer_and_reviewer_ids(self):
        if not studio.native_tool("ffmpeg"): self.skipTest("FFmpeg unavailable")
        video = self.movie(); probe = qp.prepare(self.run, video)
        self.assertTrue(self.reviews(probe)['completed'])
        data = studio.load_run(self.run)
        for check in ('visuals', 'music_fit'):
            original = self.review_payload(probe, check)
            if check == 'music_fit':
                original.update(result='not_applicable', not_applicable_reason='Actual synthetic fixture has no music')
            # Both successful and not-applicable conclusions need provenance.
            for patch in ({'reviewer_job_id': None}, {'producer_job_id': ''}, {'reviewer': '   '},
                          {'reviewer_job_id': []}, {'producer_job_id': 'contains\nnewline'},
                          {'reviewer_job_id': original['producer_job_id']}):
                with self.subTest(check=check, patch=patch):
                    with self.assertRaisesRegex(studio.StudioError, 'Pass needs|Sampled review'):
                        studio.record(self.run, 'review', {**original, **patch})
        # Even an old/externally persisted pass cannot evade the audit gate.
        data['reviews']['visuals']['reviewer_job_id'] = data['reviews']['visuals']['producer_job_id']
        report = studio.audit_data(data, studio.probe_media(video), [], probe['artifact_sha256'], review_base=self.run)
        self.assertFalse(report['completed'])
        self.assertIn('visuals', report['review_pending'])

    def test_registered_bgm_requires_audible_export_even_with_stale_optional_audio_flag(self):
        if not studio.native_tool("ffmpeg"): self.skipTest("FFmpeg unavailable")
        studio.record(self.run, 'project', {'projectId': 'test-project', 'music_enabled': True})
        self.assertFalse(studio.load_run(self.run)['settings']['audio_required'])
        for name, signal, failure in (('no-audio.mp4', None, 'missing_audio_stream'),
                                      ('silent-bgm.mp4', 'anullsrc=r=48000:cl=stereo', 'silent_or_inaudible_audio')):
            with self.subTest(file=name):
                video = self.movie(name, signal)
                probe = qp.prepare(self.run, video)
                audio = studio.read(probe['metrics'])['audio']
                self.assertTrue(audio['track_required'])
                self.assertIn(failure, audio['hard_failures'])
                with self.assertRaisesRegex(studio.StudioError, failure):
                    studio.record(self.run, 'review', self.review_payload(probe, 'output_details'))
                if signal is None:
                    report = studio.audit_data(studio.load_run(self.run), studio.probe_media(video), [],
                                               probe['artifact_sha256'], review_base=self.run)
                    self.assertIn('missing_audio_stream', report['failures'])

    def test_explicit_music_evidence_also_requires_audible_audio(self):
        if not studio.native_tool("ffmpeg"): self.skipTest("FFmpeg unavailable")
        evidence = studio.read(self.run / 'review-evidence.json')
        evidence['music_tracks'] = ['actual-music-track']
        studio.write(self.run / 'review-evidence.json', evidence)
        probe = qp.prepare(self.run, self.movie(signal='anullsrc=r=48000:cl=stereo'))
        audio = studio.read(probe['metrics'])['audio']
        self.assertTrue(audio['track_required'])
        self.assertIn('silent_or_inaudible_audio', audio['hard_failures'])

    def test_no_music_not_applicable_cannot_override_objective_audio_failure(self):
        if not studio.native_tool("ffmpeg"): self.skipTest("FFmpeg unavailable")
        for amplitude, should_pass in ((.1, True), (1.2, False)):
            video = self.movie(name='music-na-%s.mp4' % amplitude,
                               signal='aevalsrc=%s*sin(2*PI*440*t):s=48000' % amplitude)
            probe = qp.prepare(self.run, video)
            payload = self.review_payload(probe, 'music_fit', result='not_applicable',
                                          not_applicable_reason='The signal is synthetic source sound, no BGM')
            if should_pass:
                studio.record(self.run, 'review', payload)
            else:
                with self.assertRaisesRegex(studio.StudioError, 'overload'):
                    studio.record(self.run, 'review', payload)

    def test_silent_required_audio_and_full_duration_metrics(self):
        if not studio.native_tool("ffmpeg"): self.skipTest("FFmpeg unavailable")
        video = self.movie(signal="anullsrc=r=48000:cl=stereo")
        data = studio.load_run(self.run); data["settings"]["audio_required"] = True; studio.write(self.run / "run.json", data)
        probe = qp.prepare(self.run, video); audio = studio.read(probe["metrics"])["audio"]
        self.assertIn("silent_or_inaudible_audio", audio["hard_failures"])
        self.assertGreaterEqual(audio["duration"], 2)
        self.assertEqual(audio["channels"], 2)

    def test_true_peak_overload_is_a_hard_failure_and_normal_signal_is_allowed(self):
        if not studio.native_tool("ffmpeg"): self.skipTest("FFmpeg unavailable")
        for amplitude, overload in ((.1, False), (1.2, True)):
            video = self.movie(name="signal-%s.mp4" % amplitude,
                               signal="aevalsrc=%s*sin(2*PI*440*t):s=48000" % amplitude)
            stream = next(s for s in studio.probe_media(video)["streams"] if s["codec_type"] == "audio")
            result = qp.audio_metrics(video, stream, 2, self.run, True)
            self.assertEqual("true_peak_overload" in result["hard_failures"], overload)
            self.assertIsNotNone(result["input_i"])
            self.assertTrue(result["windows"])

    def test_music_decoder_covers_more_than_two_minutes(self):
        if not studio.native_tool("ffmpeg"): self.skipTest("FFmpeg unavailable")
        audio = self.run / "long.wav"
        qp.run_media(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000",
                      "-t", "122", "-c:a", "pcm_s16le", audio])
        samples, rate, channels = review_music.decode(audio)
        self.assertGreaterEqual(len(samples) / rate / channels, 122)

    def test_external_video_and_directory_rejected(self):
        file = self.root / "outside.mp4"; file.write_bytes(b"fixture")
        with self.assertRaisesRegex(ValueError, "inside"):
            qp.prepare(self.run, file)
        file = self.run / "file.mp4"; file.write_bytes(b"fixture")
        with self.assertRaisesRegex(ValueError, "subdirectory"):
            qp.prepare(self.run, file, directory=self.root)

    def test_context_and_review_audit_preserve_old_policy(self):
        context = web_bridge.production_context({"run": str(self.run)})
        self.assertEqual(context["review_policy"], policy.POLICY)
        self.assertEqual(context["review_methods"], policy.METHODS)
        data = studio.load_run(self.run); data["brief"]["requirements"].pop("review_policy")
        studio.write(self.run / "run.json", data)
        self.assertEqual(web_bridge.production_context({"run": str(self.run)})["review_methods"], studio.REVIEW_METHODS)

    def test_voice_directory_deduplicates_stable_ids_and_strips_ephemeral_data(self):
        voice = {"name": "My voice", "provider": "provider", "voiceId": "stable", "voiceType": "custom",
                 "selected_by_user": True, "voiceRef": "ephemeral", "token": "must-not-persist"}
        first = web_bridge.save_voice({"voice": voice})
        self.assertEqual(len(first["savedVoices"]), 1)
        self.assertNotIn("voiceRef", first["voice"])
        self.assertNotIn("token", studio.profile()["voice"])
        second = web_bridge.save_voice({"voice": {**voice, "name": "Renamed"}})
        self.assertEqual(len(second["savedVoices"]), 1)
        self.assertEqual(studio.profile()["voice"]["name"], "Renamed")
        with self.assertRaises(ValueError): web_bridge.save_voice({"voice": {**voice, "selected_by_user": False}})


if __name__ == "__main__": unittest.main()
