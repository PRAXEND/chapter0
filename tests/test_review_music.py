import array
import random
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'plugins/video-studio/scripts'))
import review_music as music


class MusicPauseTests(unittest.TestCase):
    def waveform(self, change=None, amplitude=1000, stereo=False):
        values = array.array('h')
        for i in range(3000):
            value = amplitude if change is None or i < 1500 else change
            values.extend((value, -value) if stereo else (value,))
        return values

    def check(self, samples, **kwargs):
        return music.scan(samples, 1000, kwargs.pop('channels', 1),
                          kwargs.pop('voice', [(0,1),(2,3)]), kwargs.pop('bed', [(0,3)]), 3, **kwargs)

    def test_release_inside_narration_gap_is_flagged(self):
        result = self.check(self.waveform(change=10000))
        self.assertEqual('needs_review', result['status'])
        self.assertGreater(result['candidates'][0]['rise_db'], 19)
        self.assertGreaterEqual(result['candidates'][0]['peak_from'], 1.4)

    def test_constant_bed_passes_without_claiming_listening(self):
        result = self.check(self.waveform())
        self.assertEqual('pass', result['status'])
        self.assertEqual([], result['candidates'])
        self.assertEqual('unverified', result['audio_listening'])

    def test_inaudible_noise_rise_is_not_promoted_to_music_spike(self):
        result = self.check(self.waveform(amplitude=1, change=20))
        self.assertEqual('pass', result['status'])
        self.assertGreater(result['pauses'][0]['rise_db'], 20)

    def test_stereo_phase_cancellation_does_not_hide_rise(self):
        result = self.check(self.waveform(change=10000, stereo=True), channels=2)
        self.assertEqual('needs_review', result['status'])

    def test_intro_outro_or_gap_without_music_not_flagged(self):
        self.assertEqual([], self.check(self.waveform(change=20000), voice=[(.5,2)])['pauses'])
        self.assertEqual([], self.check(self.waveform(change=20000), bed=[(0,1),(2,3)])['pauses'])

    def test_short_pause_discloses_measurement_limit(self):
        result = self.check(self.waveform(), voice=[(0,1),(1.24,3)])
        self.assertEqual('too_short_to_measure_rise', result['pauses'][0]['status'])
        self.assertEqual(0, result['measured_pauses'])

    def test_incomplete_decode_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'whole timeline'):
            self.check(self.waveform()[:2000])

    def evidence(self):
        return {'music_tracks':['A2'], 'narration_tracks':['A1'], 'timeline':{
            'state':{'fps':24, 'durationFrames':72},
            'timeline':{'totalEntries':2, 'tracks':[{'id':'voice','alias':'A1'}, {'id':'music','alias':'A2'}],
                'entries':[
                    {'kind':'item','itemType':'audio','id':'clip','trackId':'voice','asset':{'id':'vo'},
                     'timelineRange':{'fromFrame':0,'toFrame':72}, 'sourceRange':{'start':0,'end':3000000}},
                    {'kind':'item','itemType':'audio','id':'bed','trackId':'music','asset':{'id':'bgm'},
                     'timelineRange':{'fromFrame':0,'toFrame':72}, 'sourceRange':{'start':0,'end':3000000}}]}},
            'voice_sources':[{'assetId':'vo','data':[{'transcript':{'status':'available','ranges':[
                {'segments':[{'text':'前句','startMs':0,'endMs':1000},{'text':'后句','startMs':2000,'endMs':3000}]}]}}]}]}

    def test_pause_inside_one_clip_uses_actual_asr_and_timeline_fps(self):
        voice, bed, duration = music.context(self.evidence())
        self.assertEqual([[0,1],[2,3]], voice)
        self.assertEqual([[0,3]], bed)
        self.assertEqual(3, duration)

    def test_partial_transcript_or_partial_timeline_not_a_pass(self):
        for kind in ['timeline','transcript']:
            ev=self.evidence()
            if kind=='timeline': ev['timeline']['timeline']['totalEntries']=3
            else: ev['voice_sources'][0]['data'][0]['transcript']['truncated']=True
            with self.assertRaises(ValueError): music.context(ev)

    def test_muted_voice_wrong_selector_and_shared_track_rejected(self):
        variants=[self.evidence() for _ in range(3)]
        variants[0]['timeline']['timeline']['tracks'][0]['muted']=True
        variants[1]['music_tracks']=['missing']
        variants[2]['music_tracks']=['A1']
        for ev in variants:
            with self.assertRaises(ValueError): music.context(ev)

    def test_required_evidence_missing_or_decode_failure_is_unverified(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'export.mp4';file.write_bytes(b'fixture')
            self.assertEqual('unverified', music.check_file(file,None)['status'])
            self.assertEqual('not_applicable', music.check_file(file,None,required=False)['status'])
            self.assertEqual('unverified', music.check_file(file,[])['status'])
            with mock.patch.object(music,'decode',side_effect=ValueError('decode failed')):
                self.assertEqual('unverified',music.check_file(file,self.evidence())['status'])


class MusicPresenceWindowTests(unittest.TestCase):
    def signals(self, continuous=False, missing_music=False, delay=0):
        rate = 1000
        rng = random.Random(731)
        source = [rng.uniform(-.8, .8) for _ in range(14 * rate)]
        rng = random.Random(913)
        voice = [(0, 14)] if continuous else [(0, 4.4), (6, 10.5), (12, 14)]
        mix = [0.0] * (len(source) + delay)
        for i, value in enumerate(source):
            speaking = any(a <= i / rate < b for a, b in voice)
            mix[i + delay] = (0 if missing_music else value * .025) + (rng.uniform(-.8, .8) if speaking else 0)
        return source, [mix], voice, rate

    def test_masked_percentile_probes_use_two_measured_speech_free_windows(self):
        source, mix, voice, rate = self.signals(delay=69)
        self.assertIsNone(music.match_music(source, mix, 0, rate))
        report = music.match_music(source, mix, 0, rate, voice)
        self.assertEqual('speech_free', report['window_selection'])
        self.assertEqual(69, report['offset_ms'])
        self.assertGreaterEqual(report['matched_samples'], 2)
        for window in report['matched_windows']:
            self.assertGreater(window['correlation'], .99)
            self.assertFalse(any(window['from'] < b and window['to'] > a for a, b in voice))

    def test_continuous_masking_does_not_manufacture_a_pass(self):
        source, mix, voice, rate = self.signals(continuous=True)
        self.assertIsNone(music.match_music(source, mix, 0, rate, voice))

    def test_continuous_voice_keeps_existing_distributed_fallback(self):
        source, _, voice, rate = self.signals(continuous=True)
        report = music.match_music(source, [[x * .5 for x in source]], 0, rate, voice)
        self.assertEqual('distributed_fallback', report['window_selection'])
        self.assertGreaterEqual(report['matched_samples'], 2)

    def test_silence_in_pauses_is_not_music_presence(self):
        source, mix, voice, rate = self.signals(missing_music=True)
        self.assertIsNone(music.match_music(source, mix, 0, rate, voice))

    def test_strongest_consistent_delay_wins_over_broad_near_zero_peak(self):
        rng = random.Random(124)
        source, value = [], 0
        for _ in range(8000):
            value = .995 * value + rng.uniform(-.02, .02)
            source.append(value)
        report = music.match_music(source, [[0.0] * 69 + source], 0, 1000)
        self.assertEqual(69, report['offset_ms'])
        self.assertTrue(all(w['correlation'] > .99 for w in report['matched_windows']))

    def test_single_short_gap_and_nonzero_clip_position_preserve_bounds(self):
        source, _, _, rate = self.signals()
        self.assertEqual([], music.speech_free_music_offsets(len(source), 5000, rate, 750, [(0, 10), (10.5, 20)]))
        offsets = music.speech_free_music_offsets(3000, 5000, rate, 750, [(0, 5.5), (7.8, 20)])
        self.assertGreaterEqual(len(offsets), 2)
        self.assertTrue(all(640 <= x and x + 750 <= 2660 for x in offsets))
        self.assertTrue(all(b - a >= 750 for a, b in zip(offsets, offsets[1:])))


if __name__=='__main__': unittest.main()
