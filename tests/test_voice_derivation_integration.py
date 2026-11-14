"""Real media and synthetic hosted readbacks exercise the optional lineage hooks."""
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(os.environ.get('VIDEO_STUDIO_TEST_SCRIPTS', Path(__file__).resolve().parents[1] / 'plugins/video-studio/scripts'))
sys.path.insert(0, str(SCRIPTS))
import studio
import quality_probe
import quality_policy
import review_sync
import web_bridge
import voice_derivations
import test_voice_derivations as fixtures


class DerivationIntegration(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.VoiceDerivations()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.original_id, self.derived_id = f.use_uuid_ids()
        self.root = f.root.resolve()
        self.evidence = f.evidence
        # Preserve the actual hosted columns/words representation in the raw file.
        raw = deepcopy(f.active)
        transcript = raw['data'][1]['transcript']
        transcript['columns'] = ['startMs', 'endMs', 'text']
        for interval in transcript['ranges']:
            interval['words'] = [[w['startMs'], w['endMs'], w['text']] for w in interval.pop('segments')]
        f.readback.write_text(json.dumps(raw))
        self.evidence['voice_derivations'][0]['transcript'] = f.file_ref(f.readback)
        self.evidence['voice_sources'] = [voice_derivations.canonical_source(raw)]
        self.evidence['timeline_id'] = 'synthetic-timeline'
        self.evidence['timeline']['state']['durationFrames'] = 50
        self.evidence['timeline']['timeline']['entries'][0]['trackAlias'] = 'A1'
        self.cards = [{'id': 'c1', 'trackId': 'captions', 'hidden': False, 'start_frame': 2, 'end_frame': 10, 'lines': ['测试']},
                      {'id': 'c2', 'trackId': 'captions', 'hidden': False, 'start_frame': 32, 'end_frame': 43, 'lines': ['语音']}]
        self.evidence['caption_state'] = {'enabled': True, 'timelineId': 'synthetic-timeline',
                                         'tracks': [{'id': 'captions', 'visible': True}], 'cards': self.cards}
        self.data = {'schema_version': 2, 'creation_rules': 2, 'revision': 7, 'beats': [], 'operations': {},
                     'settings': {'narration': True, 'captions': True, 'voice': f.wanted, 'fps': 25,
                                  'width': 160, 'height': 90, 'audio_required': True},
                     'brief': {'workbench_rules': 2, 'generate_music': False,
                               'requirements': {'review_policy': quality_policy.POLICY}},
                     'project': {'projectId': 'synthetic-project', 'timelineId': 'synthetic-timeline'}}
        studio.write(self.root/'run.json', self.data)
        self.persist()
        studio.write(self.root/'source-cuts.json', {})
        from delivery_requirements import subtitles_text
        self.srt = self.root/'captions.srt'
        self.srt.write_text(subtitles_text(self.cards, 25))
        self.cues = studio.parse_srt(self.srt)

    def persist(self):
        studio.write(self.root/'review-evidence.json', self.evidence)

    def movie(self):
        video = self.root/'synthetic.mp4'
        studio.execute(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25',
                        '-i', self.fixture.output, '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video])
        return video

    def test_preexport_bridge_accepts_bound_lineage_and_rejects_missing_transcript(self):
        args = {'run': str(self.root), 'subtitles': str(self.srt)}
        self.assertEqual(web_bridge.check_media_requirements(args), {'ok': True})
        del self.evidence['voice_derivations'][0]['transcript']
        self.persist()
        with self.assertRaisesRegex(ValueError, 'actual imported-asset'):
            web_bridge.check_media_requirements(args)

    def test_sync_uses_root_generation_controls_but_derived_word_times(self):
        report = review_sync.review(self.evidence, self.cues, {}, 25, root=self.root)
        self.assertTrue(report['voice_controls']['recorded_controls_match'])
        self.assertEqual(report['voice_controls']['reference_asset_id'], self.original_id)
        self.assertEqual(report['speech_rates'][0]['asset_id'], self.derived_id)
        self.assertEqual(report['caption_sync']['cues'][0]['start_delta_ms'], -20)
        self.assertTrue(report['export_matches_cards']['matches'])
        with self.assertRaisesRegex(ValueError, 'run directory'):
            review_sync.review(self.evidence, self.cues, {}, 25)

    def test_sync_cli_uses_actual_fps_and_run_directory(self):
        output = self.root/'sync.json'
        result = subprocess.run([sys.executable, str(SCRIPTS/'review_sync.py'), '--evidence', str(self.root/'review-evidence.json'),
                                 '--srt', str(self.srt), '--cuts', str(self.root/'source-cuts.json'), '--output', str(output)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        report = studio.read(output)
        self.assertTrue(report['voice_controls']['recorded_controls_match'])
        self.assertFalse(report['caption_sync']['outside_frame_tolerance'])

    def test_probe_binds_all_lineage_files_and_rejects_later_changes(self):
        probe = quality_probe.prepare(self.root, self.movie(), self.srt)
        metrics = studio.read(probe['metrics'])
        self.assertNotIn('av_sync', metrics['requirement_errors'])
        self.assertEqual(metrics['narration_alignment']['status'], 'checked')
        self.assertTrue(metrics['sync']['report']['voice_controls']['recorded_controls_match'])
        bound = {Path(row['path']) for row in probe['evidence_files']}
        f = self.fixture
        for file in (f.source, f.output, f.receipt, f.readback):
            self.assertIn(file.resolve(), bound)
            before = file.read_bytes()
            file.write_bytes(before + b' ')
            with self.subTest(file=file.name), self.assertRaisesRegex(ValueError, 'evidence_changed'):
                quality_policy.probe(self.data, self.root, probe['artifact_sha256'], probe['subtitle_sha256'], studio.read, studio.file_hash)
            file.write_bytes(before)

    def test_probe_does_not_confuse_waveform_match_with_valid_lineage(self):
        f = self.fixture
        f.record['source']['assetId'] = 'unknown-origin'
        f.update_receipt(); self.persist()
        probe = quality_probe.prepare(self.root, self.movie(), self.srt)
        metrics = studio.read(probe['metrics'])
        self.assertEqual(metrics['narration_alignment']['status'], 'checked')
        self.assertEqual(metrics['sync']['status'], 'unverified')
        self.assertIn('Narration lineage', metrics['requirement_errors']['av_sync'])

    def test_probe_detects_lineage_file_change_after_verification(self):
        video = self.movie()
        original_write = studio.write
        def changed(path, value):
            result = original_write(path, value)
            if Path(path).name == 'metrics.json':
                self.fixture.readback.write_bytes(self.fixture.readback.read_bytes() + b' ')
            return result
        with patch.object(studio, 'write', side_effect=changed):
            with self.assertRaisesRegex(ValueError, 'changed during review preparation'):
                quality_probe.prepare(self.root, video, self.srt)


if __name__ == '__main__':
    unittest.main()
