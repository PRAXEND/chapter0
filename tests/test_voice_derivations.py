"""Real PCM transforms with synthetic tool/ASR fixtures; no listening claim."""
import array
from copy import deepcopy
import json
import math
import os
from pathlib import Path
import random
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, os.environ.get('VIDEO_STUDIO_TEST_SCRIPTS', str(Path(__file__).resolve().parents[1] / 'plugins/video-studio/scripts')))
import delivery_requirements as requirements
import prepare_narration as preparation
import review_audio_alignment as alignment
import studio
import voice_derivations as derivations


class VoiceDerivations(unittest.TestCase):
    def setUp(self):
        if not studio.native_tool('ffmpeg'):
            self.skipTest('Real FFmpeg required')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'generated.wav'
        rng, previous = random.Random(228), 0
        values = array.array('h')
        for n in range(24000 * 6):
            previous = .9 * previous + .1 * rng.uniform(-1, 1)
            values.append(round(previous * (.5 + .4 * math.sin(n / 24000 * 11)) * 18000))
        with wave.open(str(self.source), 'wb') as audio:
            audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(24000)
            audio.writeframes(values.tobytes())
        self.output, self.receipt = self.root / 'final-speed.wav', self.root / 'preparation.json'
        self.record = preparation.prepare(self.source, self.output, 1.2, 'generated', self.receipt)
        self.wanted = {'provider': 'test', 'voiceId': 'mine', 'selected_by_user': True}
        self.active = {'assetId': 'derived', 'data': [
            {'asset': {'id': 'derived', 'type': 'audio', 'transcript': {'state': 'complete', 'readyForEditing': True}}},
            {'transcript': {'status': 'available', 'truncated': False, 'ranges': [{'truncated': False,
                'range': {'startMs': 0, 'endMs': self.record['output']['frames'] / 48},
                'segments': [{'text': '测试', 'startMs': 100, 'endMs': 400}, {'text': '语音', 'startMs': 1300, 'endMs': 1700}]}]}}]}
        self.readback = self.root / 'imported-asset-readback.json'
        self.readback.write_text(json.dumps(self.active))
        self.evidence = {'voice_sources': [self.active], 'voice_derivation_sources': [{'assetId': 'generated', 'data': [
            {'asset': {'id': 'generated', 'generationRecord': {'record': 'available', 'params': self.wanted.copy()}}}]}],
            'voice_files': [self.file_ref(self.source, 'generated'), self.file_ref(self.output, 'derived')],
            'voice_derivations': [{'assetId': 'derived', 'receipt': self.file_ref(self.receipt), 'transcript': self.file_ref(self.readback)}],
            'narration_tracks': ['A1'], 'timeline': {'state': {'fps': 25}, 'timeline': {'totalEntries': 1,
                'tracks': [{'id': 'track', 'alias': 'A1'}], 'entries': [{'kind': 'item', 'itemType': 'audio',
                    'id': 'clip', 'asset': {'id': 'derived'}, 'trackId': 'track', 'playbackRate': 1,
                    'properties': {'playbackRate': 1}, 'sourceRange': {'start': 0, 'end': 2000000},
                    'timelineRange': {'fromFrame': 0, 'toFrame': 50}}]}}}

    def use_uuid_ids(self):
        original, derived = '9523dd48-7c2b-492b-ae2e-73f38e4b2f40', 'aabbccdd-ee00-4000-8000-000000000001'
        self.active['assetId'] = derived
        self.active['data'][0]['asset']['id'] = derived.replace('-', '')[:10]
        source = self.evidence['voice_derivation_sources'][0]
        source['assetId'] = original
        source['data'][0]['asset']['id'] = original.replace('-', '')[:10]
        self.evidence['voice_files'][0]['assetId'] = original
        self.evidence['voice_files'][1]['assetId'] = derived
        self.evidence['voice_derivations'][0]['assetId'] = derived
        self.record['source']['assetId'] = original
        self.evidence['timeline']['timeline']['entries'][0]['asset']['id'] = derived
        self.update_receipt(); self.update_readback()
        return original, derived

    def test_compact_uuid_ids_bind_uniquely_without_rewriting_tool_readback(self):
        original, derived = self.use_uuid_ids()
        before = self.readback.read_bytes()
        self.assertEqual(self.check()['assets'][derived]['root_asset_id'], original)
        requirements.selected_voice(self.evidence, self.wanted, self.root, 25)
        self.assertEqual(self.readback.read_bytes(), before)
        self.assertEqual(self.active['data'][0]['asset']['id'], 'aabbccddee')

    def test_compact_id_collision_wrong_prefix_and_too_short_prefix_rejected(self):
        self.use_uuid_ids()
        asset = self.active['data'][0]['asset']
        for wrong in ('aabbccdd', 'ffffffffee'):
            asset['id'] = wrong; self.update_readback()
            with self.subTest(id=wrong), self.assertRaisesRegex(ValueError, 'mismatched, shortened or ambiguous'):
                self.check()
        asset['id'] = 'aabbccddee'; self.update_readback()
        timeline = self.evidence['timeline']['timeline']
        timeline['entries'].append({'kind': 'item', 'itemType': 'video', 'trackId': 'visual',
                                    'asset': {'id': 'aabbccdd-ee99-4000-8000-000000000002'}})
        timeline['totalEntries'] = 2
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            self.check()

    def test_raw_hosted_word_rows_can_be_compared_without_changing_word_times(self):
        self.use_uuid_ids()
        raw = deepcopy(self.active)
        transcript = raw['data'][1]['transcript']
        transcript['columns'] = ['startMs', 'endMs', 'text']
        interval = transcript['ranges'][0]
        interval['words'] = [[w['startMs'], w['endMs'], w['text']] for w in interval.pop('segments')]
        self.readback.write_text(json.dumps(raw))
        self.evidence['voice_derivations'][0]['transcript'] = self.file_ref(self.readback)
        self.assertEqual(derivations.canonical_source(raw), self.active)
        self.check()
        # Copying another asset's readback remains invalid even for the same text.
        raw['assetId'] = '9523dd48-7c2b-492b-ae2e-73f38e4b2f40'
        self.readback.write_text(json.dumps(raw))
        self.evidence['voice_derivations'][0]['transcript'] = self.file_ref(self.readback)
        with self.assertRaisesRegex(ValueError, 'actual imported-asset'):
            self.check()

    def test_partial_request_is_not_full_asr_even_when_available_and_not_truncated(self):
        self.active['data'][1]['transcript']['ranges'][0]['range']['endMs'] = 1000
        self.update_readback()
        with self.assertRaisesRegex(ValueError, 'full derived-asset transcript'):
            self.check()

    def file_ref(self, path, asset_id=None):
        row = {'path': str(path), 'sha256': studio.file_hash(path)}
        if asset_id:
            row['assetId'] = asset_id
        return row

    def check(self):
        return derivations.verify(self.evidence, self.root, 25)

    def update_receipt(self):
        self.receipt.write_text(json.dumps(self.record))
        self.evidence['voice_derivations'][0]['receipt'] = self.file_ref(self.receipt)

    def update_readback(self):
        self.readback.write_text(json.dumps(self.active))
        self.evidence['voice_derivations'][0]['transcript'] = self.file_ref(self.readback)

    def test_replay_identity_and_every_evidence_file_bound(self):
        result = self.check()
        self.assertEqual(result['status'], 'checked')
        self.assertEqual(result['assets']['derived']['root_asset_id'], 'generated')
        self.assertEqual({r['path'] for r in result['evidence_files']},
                         {str(p.resolve()) for p in (self.source, self.output, self.receipt, self.readback)})
        self.assertEqual(result['root_sources'][0]['assetId'], 'generated')
        requirements.selected_voice(self.evidence, self.wanted, self.root, 25)
        self.assertNotIn('generationRecord', self.active['data'][0]['asset'])

    def test_preparation_never_overwrites_original_or_existing_receipt(self):
        original = studio.file_hash(self.source)
        for output, receipt in ((self.source, self.root/'new.json'), (self.output, self.root/'new.json'),
                                (self.root/'new.wav', self.receipt), (self.root/'new.wav', self.root/'new.wav')):
            with self.assertRaises(ValueError):
                preparation.prepare(self.source, output, 1.2, 'generated', receipt)
        self.assertEqual(studio.file_hash(self.source), original)
        self.assertNotIn('segments', self.record)
        self.assertEqual(self.record['output']['sample_rate'], 48000)

    def test_invalid_speed_and_out_of_range_transform_rejected(self):
        for rate in (True, 0, -.5, float('nan'), float('inf'), 9, '1.2'):
            with self.subTest(rate=rate), self.assertRaises(ValueError):
                preparation.filters(rate)

    def test_wrong_selected_voice_or_unknown_source_rejected(self):
        with self.assertRaises(ValueError):
            requirements.selected_voice(self.evidence, dict(self.wanted, voiceId='other'), self.root, 25)
        self.record['source']['assetId'] = 'unknown'
        self.update_receipt()
        with self.assertRaisesRegex(ValueError, 'Unknown generated'):
            self.check()

    def test_wrong_source_bytes_cannot_pass_with_updated_receipt_hashes(self):
        other = self.root / 'unrelated.wav'
        studio.execute(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=410:duration=6', other])
        self.evidence['voice_files'][0] = self.file_ref(other, 'generated')
        self.record['source'] = self.file_ref(other, 'generated')
        self.update_receipt()
        with self.assertRaisesRegex(ValueError, 'not a reproducible transform'):
            self.check()

    def test_wrong_output_bytes_cannot_pass_even_if_all_recorded_hashes_changed(self):
        other = self.root / 'unrelated.wav'
        studio.execute(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=410:duration=5',
                        '-ar', '48000', '-c:a', 'pcm_s16le', other])
        self.output.write_bytes(other.read_bytes())
        self.record['output'].update(self.file_ref(self.output), **preparation.pcm_info(self.output))
        self.evidence['voice_files'][1] = self.file_ref(self.output, 'derived')
        self.update_receipt()
        with self.assertRaisesRegex(ValueError, 'not a reproducible transform'):
            self.check()

    def test_wrong_transform_rate_rejected_by_pcm_replay(self):
        self.record.update(rate=1.25, filters=preparation.filters(1.25))
        self.update_receipt()
        with self.assertRaisesRegex(ValueError, 'not a reproducible transform'):
            self.check()

    def test_unrelated_nondefault_audio_stream_cannot_inherit_voice_identity(self):
        multiple, other = self.root/'multiple.mka', self.root/'other-stream.wav'
        studio.execute(['ffmpeg', '-v', 'error', '-i', self.source, '-f', 'lavfi', '-i',
                        'sine=frequency=410:duration=6', '-map', '0:a', '-map', '1:a',
                        '-disposition:a:0', 'default', '-disposition:a:1', '0', '-c:a', 'pcm_s16le', multiple])
        preparation.render(multiple, other, 1.2, 1)
        self.record['source'] = self.file_ref(multiple, 'generated')
        self.record['audio_stream_index'] = 1
        self.record['output'] = {**self.file_ref(other), **preparation.pcm_info(other)}
        self.evidence['voice_files'] = [self.file_ref(multiple, 'generated'), self.file_ref(other, 'derived')]
        self.update_receipt()
        with self.assertRaisesRegex(ValueError, 'default source audio stream'):
            self.check()

    def test_retimed_timeline_or_false_unit_rate_rejected(self):
        clip = self.evidence['timeline']['timeline']['entries'][0]
        for rate in (None, True, 1.2):
            clip['playbackRate'] = rate
            clip['properties']['playbackRate'] = rate
            with self.subTest(rate=rate), self.assertRaisesRegex(ValueError, 'rate=1'):
                self.check()
        clip['playbackRate'] = clip['properties']['playbackRate'] = 1
        clip['sourceRange']['end'] = 2400000
        with self.assertRaisesRegex(ValueError, 'rate=1 PCM'):
            self.check()

    def test_missing_or_transplanted_transcript_cannot_pass(self):
        edge = self.evidence['voice_derivations'][0]
        actual = edge.pop('transcript')
        with self.assertRaisesRegex(ValueError, 'actual imported-asset'):
            self.check()
        edge['transcript'] = actual
        foreign = deepcopy(self.active)
        foreign['assetId'] = 'generated'
        self.readback.write_text(json.dumps(foreign))
        edge['transcript'] = self.file_ref(self.readback)
        with self.assertRaisesRegex(ValueError, 'actual imported-asset'):
            self.check()
        self.active['data'] = self.active['data'][:1]
        self.update_readback()
        with self.assertRaisesRegex(ValueError, 'own real transcript'):
            self.check()

    def test_incomplete_or_out_of_duration_asr_cannot_pass(self):
        transcript = self.active['data'][1]['transcript']
        transcript['truncated'] = True
        self.update_readback()
        with self.assertRaisesRegex(ValueError, 'not complete'):
            self.check()
        transcript['truncated'] = False
        transcript['ranges'][0]['segments'][-1]['endMs'] = 6000
        self.update_readback()
        with self.assertRaisesRegex(ValueError, 'ASR timestamps'):
            self.check()

    def test_duplicate_assets_and_cyclic_lineage_rejected(self):
        self.evidence['voice_derivations'].append(deepcopy(self.evidence['voice_derivations'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            self.check()
        self.evidence['voice_derivations'].pop()
        self.record['source']['assetId'] = 'derived'
        self.update_receipt()
        with self.assertRaisesRegex(ValueError, 'Cyclic'):
            self.check()

    def test_missing_changed_or_external_files_cannot_pass(self):
        with self.assertRaisesRegex(ValueError, 'run directory'):
            derivations.verify(self.evidence, None, 25)
        self.evidence['voice_files'][1]['sha256'] = '0' * 64
        with self.assertRaises(ValueError):
            self.check()
        self.evidence['voice_files'][1] = self.file_ref(self.output, 'derived')
        with tempfile.TemporaryDirectory() as external:
            other = Path(external) / 'source.wav'; other.write_bytes(self.source.read_bytes())
            self.record['source'] = self.file_ref(other, 'generated'); self.update_receipt()
            with self.assertRaisesRegex(ValueError, 'outside this run'):
                self.check()

    def test_preexport_reports_unverified_lineage_and_requires_actual_generation_record(self):
        data = {'settings': {'narration': True, 'captions': False, 'voice': self.wanted},
                'brief': {'workbench_rules': 2, 'generate_music': False}, 'project': {}}
        self.assertEqual(requirements.check(data, self.evidence, [], 25, root=self.root), {})
        self.assertIn('av_sync', requirements.check(data, self.evidence, [], 25))
        asset = self.evidence['voice_derivation_sources'][0]['data'][0]['asset']
        asset['generationRecord']['record'] = 'unavailable'
        self.assertIn('av_sync', requirements.check(data, self.evidence, [], 25, root=self.root))

    def test_conflicting_original_readbacks_or_fps_are_rejected(self):
        self.evidence['timeline']['state']['fps'] = 30
        with self.assertRaisesRegex(ValueError, 'FPS'):
            self.check()
        self.evidence['timeline']['state']['fps'] = 25
        original = deepcopy(self.evidence['voice_derivation_sources'][0])
        original['data'][0]['asset']['generationRecord']['params']['voiceId'] = 'different'
        self.evidence['voice_sources'].append(original)
        with self.assertRaisesRegex(ValueError, 'Conflicting inspected'):
            self.check()

    def test_channels_are_preserved_and_actual_frames_are_recorded(self):
        stereo = self.root/'stereo.wav'
        studio.execute(['ffmpeg', '-v', 'error', '-i', self.source, '-ac', '2', stereo])
        record = preparation.prepare(stereo, self.root/'stereo-derived.wav', 1.2, 'stereo', self.root/'stereo.json')
        self.assertEqual(record['output']['channels'], 2)
        self.assertEqual(record['output']['frames'], preparation.pcm_info(self.root/'stereo-derived.wav')['frames'])

    def test_multistep_lineage_ends_at_actual_original_voice(self):
        output, receipt = self.root/'second.wav', self.root/'second.json'
        record = preparation.prepare(self.output, output, 1.1, 'derived', receipt)
        self.evidence['voice_files'].append(self.file_ref(output, 'second'))
        self.evidence['voice_derivations'].append({'assetId': 'second', 'receipt': self.file_ref(receipt),
                                                   'transcript': self.file_ref(self.readback)})
        self.active['assetId'] = self.active['data'][0]['asset']['id'] = 'second'
        self.active['data'][1]['transcript']['ranges'][0]['range']['endMs'] = record['output']['frames'] / 48
        self.readback.write_text(json.dumps(self.active))
        self.evidence['voice_derivations'][1]['transcript'] = self.file_ref(self.readback)
        self.evidence['timeline']['timeline']['entries'][0]['asset']['id'] = 'second'
        result = self.check()
        self.assertEqual(result['assets']['second']['root_asset_id'], 'generated')
        requirements.selected_voice(self.evidence, self.wanted, self.root, 25)

    def test_baked_speed_still_meets_existing_strict_waveform_match(self):
        mix = self.root / 'mix.m4a'
        studio.execute(['ffmpeg', '-v', 'error', '-i', self.output, '-f', 'lavfi', '-i',
                        'sine=frequency=280:sample_rate=48000', '-filter_complex',
                        '[0:a]volume=0.7[v];[1:a]volume=0.05[m];[v][m]amix=inputs=2:normalize=0',
                        '-t', '2.2', '-c:a', 'aac', mix])
        requirements.selected_voice(self.evidence, self.wanted, self.root, 25)
        result = alignment.check(mix, self.evidence, self.root, 25)
        self.assertEqual(result['status'], 'checked', result)
        self.assertTrue(all(w['correlation'] > .55 for w in result['windows']))

    def test_no_derivation_preserves_existing_direct_generation_path(self):
        self.assertEqual(derivations.verify({}, None, None)['status'], 'not_applicable')


if __name__ == '__main__':
    unittest.main()
