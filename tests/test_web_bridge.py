import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'plugins/video-studio/scripts'
sys.path.insert(0, str(SCRIPTS))
import web_bridge


class WebBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'VIDEO_STUDIO_HOME': str(self.root / 'user')})
        self.env.start()
        brief = {'topic': '适配器测试', 'style': None, 'style_overrides': {},
                 'requirements': {'width': 160, 'height': 90, 'fps': 25, 'target_seconds': 2,
                                  'max_seconds': 2, 'narration': False, 'captions': False, 'audio_required': False}}
        self.run = Path(web_bridge.create({'title': '适配器测试', 'outputRoot': str(self.root / 'runs'), 'brief': brief})['run'])
        self.plan = {'productionPlan': {'version': 1, 'materialReview': 'Synthetic observations', 'layout': {'mode': 'unchanged', 'bottomInset': 0}}, 'title': '已审阅方案', 'summary': '测试', 'script': '用户文案', 'shots': [
            {'id': '1', 'from': 0, 'to': 2, 'sourceIds': [], 'sourceUses': [], 'layout': {'composition': 'Full frame graphics', 'contentBottom': None, 'captionBottom': None}, 'narration': '', 'visual': '素材画面', 'screenText': '文字', 'transition': '直接剪接'}]}

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_approval_pins_file_and_inputs(self):
        saved = web_bridge.save_plan({'run': str(self.run), 'plan': self.plan, 'inputHash': 'a' * 64})
        request = {'run': str(self.run), 'planHash': saved['file_sha256'], 'inputHash': 'a' * 64}
        with self.assertRaises(ValueError):
            web_bridge.check_approval(request)
        web_bridge.approve(request)
        self.assertEqual(web_bridge.check_approval(request)['status'], 'confirmed')
        with self.assertRaises(ValueError):
            web_bridge.check_approval({**request, 'inputHash': 'b' * 64})
        Path(saved['file']).write_text('发生改变的方案')
        with self.assertRaises(ValueError):
            web_bridge.check_approval(request)

    def test_delegated_review_retains_user_request_without_claiming_a_human_click(self):
        saved = web_bridge.save_plan({'run': str(self.run), 'plan': self.plan, 'inputHash': 'a' * 64})
        request = {'run': str(self.run), 'planHash': saved['file_sha256'], 'inputHash': 'a' * 64}
        with self.assertRaises(ValueError):
            web_bridge.approve({**request, 'authority': {'kind': 'delegated_review', 'authorizedByUser': True}})
        authority = {'kind': 'delegated_review', 'authorizedByUser': True, 'userRequest': '请审阅并实际完成全流程测试，发现问题后修复'}
        approved = web_bridge.approve({**request, 'authority': authority})
        self.assertEqual(approved['authority'], authority)
        self.assertIn(authority['userRequest'], approved['user_response'])
        self.assertNotIn('用户在 Video Studio 网页点击', approved['user_response'])
        self.assertEqual(web_bridge.check_approval(request)['status'], 'confirmed')

    def test_plan_changes_keep_versions_and_revoke_approval(self):
        first = web_bridge.save_plan({'run': str(self.run), 'plan': self.plan, 'inputHash': 'a' * 64})
        web_bridge.approve({'run': str(self.run), 'planHash': first['file_sha256'], 'inputHash': 'a' * 64})
        second = web_bridge.save_plan({'run': str(self.run), 'plan': {**self.plan, 'script': '新文案'}, 'inputHash': 'a' * 64})
        self.assertEqual(second['version'], 2)
        self.assertEqual(second['status'], 'awaiting_confirmation')
        self.assertTrue(Path(first['file']).is_file())

    def test_known_limitations_are_saved_and_bound_to_confirmation(self):
        payload = {'run': str(self.run), 'plan': self.plan, 'inputHash': 'a' * 64}
        first = web_bridge.save_plan(payload)
        web_bridge.approve({'run': str(self.run), 'planHash': first['file_sha256'], 'inputHash': 'a' * 64})
        same = web_bridge.save_plan({**payload, 'plan': {**self.plan, 'limitations': []}})
        self.assertEqual(same['status'], 'confirmed')
        self.assertEqual(same['file_sha256'], first['file_sha256'])
        changed = web_bridge.save_plan({**payload, 'plan': {**self.plan, 'limitations': ['仅描述可见动作，缺少完整工序证据']}})
        self.assertNotEqual(changed['file_sha256'], first['file_sha256'])
        self.assertEqual(changed['status'], 'awaiting_confirmation')
        self.assertIn('仅描述可见动作', Path(changed['file']).read_text())

    def test_user_message_confirmation_preserves_words_without_claiming_a_new_human_click(self):
        saved = web_bridge.save_plan({'run': str(self.run), 'plan': self.plan, 'inputHash': 'a' * 64})
        payload = {'run': str(self.run), 'planHash': saved['file_sha256'], 'inputHash': 'a' * 64}
        with self.assertRaises(ValueError):
            web_bridge.approve({**payload, 'authority': {'kind': 'user_message'}})
        authority = {'kind': 'user_message', 'userRequest': '我点击了确认怎么无法进入到下一步？', 'priorReviewedPlanHash': 'b' * 64}
        saved = web_bridge.approve({**payload, 'authority': authority})
        self.assertEqual(saved['authority'], authority)
        self.assertIn(authority['userRequest'], saved['user_response'])
        self.assertNotIn('用户在 Video Studio 网页点击', saved['user_response'])

    def test_review_notes_and_gaps_are_bound_to_approval(self):
        payload = {'run': str(self.run), 'plan': self.plan, 'inputHash': 'a' * 64}
        first = web_bridge.save_plan(payload)
        web_bridge.approve({'run': str(self.run), 'planHash': first['file_sha256'], 'inputHash': 'a' * 64})
        second = web_bridge.save_plan({**payload, 'plan': {**self.plan, 'notes': ['已确认的制作说明'], 'gaps': ['实际缺口']}})
        self.assertNotEqual(second['file_sha256'], first['file_sha256'])
        self.assertEqual(second['status'], 'awaiting_confirmation')
        self.assertIn('实际缺口', Path(second['file']).read_text())

    def test_navigation_does_not_reset_approved_identical_plan(self):
        payload = {'run': str(self.run), 'plan': self.plan, 'inputHash': 'a' * 64}
        first = web_bridge.save_plan(payload)
        web_bridge.approve({'run': str(self.run), 'planHash': first['file_sha256'], 'inputHash': 'a' * 64})
        self.assertEqual(web_bridge.save_plan(payload)['status'], 'confirmed')

    def test_web_sync_preserves_skill_specific_source_evidence(self):
        current = web_bridge.studio.load_run(self.run)
        source = {'id': 'actual-source', 'kind': 'article', 'title': 'Source metadata',
                  'url': 'https://example.org/source', 'rights': 'unknown',
                  'repository': {'commit': 'a' * 40, 'path': 'batch/item/meta.json'},
                  'acquisition_report': {'expected_sha256': 'b' * 64, 'decode': 'unverified'}}
        web_bridge.studio.record(self.run, 'source', source)
        web_bridge.sync({'run': str(self.run), 'brief': current['brief'],
                         'sources': [{'id': source['id'], 'title': 'Reviewed source'}]})
        saved = web_bridge.studio.load_run(self.run)['sources'][0]
        self.assertEqual(saved['repository'], source['repository'])
        self.assertEqual(saved['acquisition_report'], source['acquisition_report'])
        self.assertEqual(saved['title'], 'Reviewed source')

    def test_direct_acquisition_preserves_existing_plan_and_records_missing_need(self):
        payload = {'run': str(self.run), 'source': {'title': '用户点击的原片'}}
        plan = web_bridge.prepare_collection(payload)
        self.assertEqual(plan['scope'], 'user_clicked_acquisition')
        self.assertEqual(plan['topic'], '适配器测试')
        self.assertIn('未审阅', plan['needs'][0]['acceptance'])
        self.assertEqual(web_bridge.prepare_collection(payload), plan)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'media diagnostics not installed')
    def test_audible_default_track_required_not_just_an_audio_stream(self):
        requirements = {'width': 160, 'height': 90, 'fps': 25, 'max_seconds': 2, 'audio_required': True}
        # Real encoded diagnostics: silence, inaudible audio and audible signal.
        # These fixtures test the gate, not the quality of a real production mix.
        for name, signal, gain, passes in [('silent', 'anullsrc=r=48000:cl=stereo', '1', False),
                                           ('quiet', 'sine=frequency=440:sample_rate=48000', '0.00001', False),
                                           ('audible', 'sine=frequency=440:sample_rate=48000', '1', True)]:
            with self.subTest(name=name):
                file = self.root / (name + '.mp4')
                subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=160x90:r=25',
                                '-f', 'lavfi', '-i', signal, '-t', '2', '-af', 'volume=' + gain,
                                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(file)], check=True)
                request = {'file': str(file), 'requirements': requirements}
                self.assertTrue(web_bridge.inspect_media(request)['hasAudio'])
                if passes:
                    result = web_bridge.verify_video(request)
                    self.assertTrue(result['audibleAudioVerified'])
                    self.assertGreater(result['audioPeakDbfs'], -60)
                else:
                    with self.assertRaisesRegex(ValueError, '静音或音量极低'):
                        web_bridge.verify_video(request)
                # An explicitly silent brief must remain supported.
                self.assertTrue(web_bridge.verify_video({**request, 'requirements': {**requirements, 'audio_required': False}})['decodeVerified'])

        # A silent default track cannot be masked by a second audible track.
        file = self.root / 'default-silent.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(self.root / 'audible.mp4'),
                        '-i', str(self.root / 'silent.mp4'), '-map', '0:v', '-map', '0:a', '-map', '1:a',
                        '-c', 'copy', '-disposition:a:0', '0', '-disposition:a:1', 'default', str(file)], check=True)
        with self.assertRaisesRegex(ValueError, '静音或音量极低'):
            web_bridge.verify_video({'file': str(file), 'requirements': requirements})

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'media diagnostics not installed')
    def test_video_duration_tolerance_and_audio_padding(self):
        file = self.root / 'audio-padding.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=160x90:r=25:d=2',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.2',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(file)], check=True)
        request = {'file': str(file), 'requirements': {'width': 160, 'height': 90, 'audio_required': True, 'max_seconds': 1.9}}
        self.assertEqual(web_bridge.verify_video(request)['duration'], 2)
        with self.assertRaisesRegex(ValueError, '时长上限'):
            web_bridge.verify_video({**request, 'requirements': {**request['requirements'], 'max_seconds': 1.89}})

    def test_invalid_video_duration_is_not_accepted(self):
        info = {'hasVideo': True, 'hasAudio': False, 'duration': float('nan')}
        with patch.object(web_bridge, 'inspect_media', return_value=info):
            with self.assertRaisesRegex(ValueError, '视频流'):
                web_bridge.verify_video({'file': 'unused', 'requirements': {}})

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'media diagnostics not installed')
    def test_actual_file_required_and_video_spec_checked(self):
        # A synthetic fixture only for testing diagnostics, never delivered as a production result.
        file = self.root / 'fixture.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=25', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(file)], check=True)
        request = {'file': str(file), 'requirements': {'width': 160, 'height': 90, 'max_seconds': 2, 'audio_required': False}}
        self.assertTrue(web_bridge.verify_video(request)['decodeVerified'])
        with self.assertRaises(ValueError):
            web_bridge.verify_video({**request, 'requirements': {**request['requirements'], 'max_seconds': 1}})
        with self.assertRaises(ValueError):
            web_bridge.verify_video({**request, 'requirements': {**request['requirements'], 'audio_required': True}})
        with self.assertRaises(ValueError):
            web_bridge.verify_video({**request, 'file': str(self.root / 'missing.mp4')})


if __name__ == '__main__':
    unittest.main()
