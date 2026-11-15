"""Encoded synthetic narration/music verify diagnostic behavior, not listening."""
import array
import math
import os
from pathlib import Path
import random
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins/video-studio/scripts"))
import studio
import quality_probe as qp
import review_audio_alignment as alignment


class CompleteSearchTests(unittest.TestCase):
    def test_flat_energy_match_and_competing_channel_peak(self):
        rng = random.Random(876)
        reference = [.5 if rng.random() > .5 else -.5 for _ in range(1500)]
        delayed = [0.] * 88 + reference + [0.] * 600
        report = alignment.match_window(reference, [delayed], [], 0)
        self.assertEqual(report['offset_ms'], 44)
        self.assertGreater(report['correlation'], .99)
        self.assertFalse(report['ambiguous'])
        other = [0.] * 288 + reference + [0.] * 400
        self.assertTrue(alignment.match_window(reference, [delayed, other], [], 0)['ambiguous'])

    def test_search_boundary_and_periodic_ambiguity(self):
        rng = random.Random(33); reference = [rng.uniform(-1, 1) for _ in range(500)]
        report = alignment.match_window(reference, [[0.] * 600 + reference], [], 0)
        self.assertEqual(report['offset_ms'], 300)
        report = alignment.match_window(reference, [[0.] * 601 + reference], [], 0)
        self.assertLess(report['correlation'], .55)
        periodic = [math.sin(i * math.pi / 20) for i in range(1500)]
        self.assertTrue(alignment.match_window(periodic[:500], [periodic], [], 300)['ambiguous'])

    def test_source_silence_is_distinguished_from_a_real_short_drop(self):
        clip = {'id':'clip','asset':{'id':'voice'},'sourceRange':{'start':0,'end':1000000},'timelineRange':{'fromFrame':0,'toFrame':30},'kind':'item','itemType':'audio','trackId':'A1'}
        evidence = {'narration_tracks':['A1'],'timeline':{'timeline':{'totalEntries':1,'entries':[clip],'tracks':[{'id':'A1'}]}},
          'voice_sources':[{'assetId':'voice','data':[{'transcript':{'status':'available','ranges':[{'segments':[{'text':'再','startMs':100,'endMs':160}]}]}}]}]}
        audio = {'windows':[{'from':0,'to':1,'channels':[{'rms_dbfs':-70}]}]}
        quiet = [0.] * 2000
        source = alignment.source_word_activity(evidence,clip,quiet,30)
        result = qp.speech_activity(evidence,audio,30,{'source_word_activity':source})
        self.assertEqual(result['status'],'checked');self.assertFalse(result['hard_failures'])
        self.assertEqual(len(result['source_silent_asr_intervals']),1)
        loud = quiet[:];loud[200:320] = [.1] * 120
        source = alignment.source_word_activity(evidence,clip,loud,30)
        result = qp.speech_activity(evidence,audio,30,{'status':'checked','source_word_activity':source})
        self.assertEqual(result['hard_failures'],['speech_interval_silent_in_mix'])
        self.assertEqual(qp.speech_activity(evidence,audio,30,{})['status'],'unverified')
        # A short sound inside a broad ASR interval must not be averaged away.
        evidence['voice_sources'][0]['data'][0]['transcript']['ranges'][0]['segments'][0]['endMs']=500
        brief = quiet[:];brief[200:240]=[.01]*40
        source = alignment.source_word_activity(evidence,clip,brief,30)
        self.assertGreater(source[0]['rms_dbfs'],-50)
        self.assertEqual(qp.speech_activity(evidence,audio,30,{'source_word_activity':source})['hard_failures'],['speech_interval_silent_in_mix'])
        evidence['voice_sources'][0]['data'][0]['transcript']['ranges'][0]['segments'][0]['endMs']=160
        # Nonzero source trim and playback rate use the same exact projection.
        clip['sourceRange']={'start':100000,'end':600000};clip['timelineRange']={'fromFrame':30,'toFrame':60}
        source = alignment.source_word_activity(evidence,clip,[.1]*2000,30)
        self.assertAlmostEqual(source[0]['from'],1);self.assertAlmostEqual(source[0]['to'],1.12)


class AlignmentTests(unittest.TestCase):
    def setUp(self):
        if not studio.native_tool("ffmpeg"): self.skipTest("FFmpeg unavailable")
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        rng = random.Random(876)
        # Nonperiodic, amplitude-modulated signal avoids artificial sine ambiguity.
        values = array.array("h")
        previous = 0
        for n in range(24000 * 3):
            previous = .9 * previous + .1 * rng.uniform(-1, 1)
            envelope = .5 + .4 * math.sin(n / 24000 * 11)
            values.append(round(previous * envelope * 18000))
        self.source = self.root / "tts.wav"
        with wave.open(str(self.source), "wb") as f:
            f.setnchannels(1); f.setsampwidth(2); f.setframerate(24000); f.writeframes(values.tobytes())

    def tearDown(self): self.tmp.cleanup()

    def evidence(self, rate=1):
        return {"narration_tracks": ["A1"], "voice_files": [{"assetId": "voice", "path": str(self.source), "sha256": studio.file_hash(self.source)}],
                "timeline": {"state": {"fps": 25}, "timeline": {"totalEntries": 1, "tracks": [{"id": "track", "alias": "A1"}], "entries": [
                    {"kind": "item", "itemType": "audio", "id": "voice-clip", "asset": {"id": "voice"}, "trackId": "track",
                     "sourceRange": {"start": 0, "end": 3000000}, "timelineRange": {"fromFrame": 0, "toFrame": round(75 / rate)}}]}}}

    def mix(self, name, voice=True, delay=0, gain=.7, rate=1):
        file = self.root / (name + ".m4a")
        filters = ",".join([*alignment.tempo_filters(rate), "volume=" + str(gain), "adelay=" + str(delay) + ":all=1"])
        if voice:
            qp.run_media(["ffmpeg", "-v", "error", "-y", "-i", self.source, "-f", "lavfi", "-i", "sine=frequency=280:sample_rate=24000",
                          "-filter_complex", "[0:a]" + filters + "[voice];[1:a]volume=0.05[music];[voice][music]amix=inputs=2:normalize=0",
                          "-t", str(3 / rate + delay / 1000 + .1), "-c:a", "aac", file])
        else:
            qp.run_media(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=280:sample_rate=24000", "-t", "3", "-c:a", "aac", file])
        return file

    def test_narration_survives_gain_and_background_music(self):
        report = alignment.check(self.mix("good"), self.evidence(), self.root, 25)
        self.assertEqual(report["status"], "checked", report)
        self.assertTrue(all(w["correlation"] > .55 for w in report["windows"]))

    def test_music_without_narration_cannot_pass(self):
        report = alignment.check(self.mix("music-only", voice=False), self.evidence(), self.root, 25)
        self.assertEqual(report["status"], "unverified", report)

    def test_actual_mix_offset_is_detected(self):
        report = alignment.check(self.mix("shifted", delay=240), self.evidence(), self.root, 25)
        self.assertEqual(report["status"], "fail", report)
        self.assertIn("narration_waveform_offset_exceeds_tolerance", report["hard_failures"])

    def test_playback_rate_is_mapped_to_real_source(self):
        report = alignment.check(self.mix("retimed", rate=1.25), self.evidence(rate=1.25), self.root, 25)
        self.assertEqual(report["status"], "checked", report)

    def test_nonzero_source_trim_and_timeline_position(self):
        file = self.root / "trimmed.m4a"
        qp.run_media(["ffmpeg", "-v", "error", "-y", "-i", self.source, "-af", "atrim=start=0.4:end=2.4,asetpts=PTS-STARTPTS,adelay=600:all=1",
                      "-t", "2.8", "-c:a", "aac", file])
        evidence = self.evidence(); clip = evidence["timeline"]["timeline"]["entries"][0]
        clip["sourceRange"] = {"start": 400000, "end": 2400000}
        clip["timelineRange"] = {"fromFrame": 15, "toFrame": 65}
        report = alignment.check(file, evidence, self.root, 25)
        self.assertEqual(report["status"], "checked", report)

    def test_missing_changed_and_short_sources_remain_unverified(self):
        good = self.mix("good")
        evidence = self.evidence(); evidence["voice_files"][0]["sha256"] = "f" * 64
        self.assertEqual(alignment.check(good, evidence, self.root, 25)["status"], "unverified")
        self.assertEqual(alignment.check(good, {}, self.root, 25)["status"], "unverified")
        evidence = self.evidence(); clip = evidence["timeline"]["timeline"]["entries"][0]
        clip["sourceRange"]["end"] = 120000; clip["timelineRange"]["toFrame"] = 3
        self.assertEqual(alignment.check(good, evidence, self.root, 25)["status"], "unverified")
        evidence = self.evidence(); clip = evidence["timeline"]["timeline"]["entries"][0]
        clip["sourceRange"]["end"] = 4000000; clip["timelineRange"]["toFrame"] = 100
        self.assertEqual(alignment.check(good, evidence, self.root, 25)["status"], "unverified")


if __name__ == "__main__": unittest.main()
