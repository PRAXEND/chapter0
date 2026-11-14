import array
import math
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest
import wave

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'plugins/video-studio/scripts'))
import review_music as music
import studio


class ResidualMusicTests(unittest.TestCase):
    def wav(self,path,values):
        with wave.open(str(path),'wb') as f:
            f.setnchannels(1);f.setsampwidth(2);f.setframerate(2000)
            f.writeframes(array.array('h',[round(max(-.99,min(.99,v))*32767) for v in values]).tobytes())

    def evidence(self,root,voice,bed):
        clips=[{'kind':'item','itemType':'audio','id':name,'trackId':name,'asset':{'id':name},
                'sourceRange':{'start':0,'end':5000000},'timelineRange':{'fromFrame':0,'toFrame':150}} for name in ('voice','bed')]
        return {'narration_tracks':['voice'],'music_tracks':['bed'],
                'timeline':{'timeline':{'totalEntries':2,'tracks':[{'id':'voice'},{'id':'bed'}],'entries':clips}},
                'voice_files':[{'assetId':'voice','path':str(voice),'sha256':studio.file_hash(voice)}],
                'music_files':[{'assetId':'bed','path':str(bed),'sha256':studio.file_hash(bed)}]}

    def test_actual_original_window_and_negative_controls(self):
        ff=studio.native_tool('ffmpeg')
        self.assertTrue(ff,'packaged FFmpeg required for original regression')
        base=ROOT/'user-packs/henry-video-styles/media/technical-explainer'
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);voice=root/'voice.wav';bed=root/'bed.wav';mixed=root/'mix.wav'
            def extract(name,start,target):
                subprocess.run([ff,'-v','error','-ss',str(start),'-i',str(base/name),'-t','5','-ac','1','-ar','2000',str(target)],check=True)
                with wave.open(str(target),'rb') as f:
                    a=array.array('h');a.frombytes(f.readframes(f.getnframes()));return [v/32768 for v in a]
            v=extract('Atlas搬冰箱｜基准旁白.mp3',4,voice);b=extract('Wallpaper.mp3',16,bed)
            rms=lambda x:math.sqrt(sum(a*a for a in x)/len(x))
            gain=rms(v)/rms(b)*10**(-18/20)
            self.wav(mixed,[a+gain*z for a,z in zip(v,b)])
            ev=self.evidence(root,voice,bed)
            self.assertIsNone(music.match_music(b,[[a+gain*z for a,z in zip(v,b)]],0,2000))
            result=music.generated_bed(mixed,ev,root,30)
            self.assertEqual(result['status'],'checked',result)
            self.assertEqual(result['clips'][0]['method'],'verified_narration_residual')
            self.assertGreaterEqual(result['clips'][0]['matched_samples'],2)
            # No music, wrong music, wrong voice, and inaudible bed must not pass.
            for variant in ('absent','wrong_music','wrong_voice','inaudible','late_voice','collinear','scaled_voice'):
                self.wav(voice,v);self.wav(bed,b)
                rng=random.Random(744)
                if variant=='wrong_music':self.wav(bed,[rng.uniform(-.15,.15) for _ in b])
                if variant=='wrong_voice':self.wav(voice,[rng.uniform(-.15,.15) for _ in v])
                if variant=='late_voice':self.wav(voice,[0.0]*500+v[:-500])
                if variant=='collinear':self.wav(bed,v)
                if variant=='scaled_voice':self.wav(bed,[a*.4 for a in v])
                actual=[a+(0 if variant in ('absent','collinear','scaled_voice') else 1e-5 if variant=='inaudible' else gain)*z for a,z in zip(v,b)]
                self.wav(mixed,actual)
                report=music.generated_bed(mixed,self.evidence(root,voice,bed),root,30)
                self.assertEqual(report['status'],'unverified',(variant,report))
            for duration in (.4,.8,1.0):
                self.wav(voice,v);self.wav(bed,[a*.4 for a in v]);self.wav(mixed,v)
                short=self.evidence(root,voice,bed)
                for clip in short['timeline']['timeline']['entries']:
                    clip['sourceRange']['end']=round(duration*1e6);clip['timelineRange']['toFrame']=round(duration*30)
                self.assertEqual('unverified',music.generated_bed(mixed,short,root,30)['status'],duration)

    def test_missing_or_changed_voice_is_not_invented_silence(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);voice=root/'voice.wav';bed=root/'bed.wav';mix=root/'mix.wav'
            rng=random.Random(4);v=[rng.uniform(-.3,.3) for _ in range(10000)];b=[rng.uniform(-.3,.3) for _ in v]
            self.wav(voice,v);self.wav(bed,b);self.wav(mix,[a+.08*z for a,z in zip(v,b)])
            ev=self.evidence(root,voice,bed);ev['voice_files'][0]['sha256']='wrong'
            self.assertEqual('unverified',music.generated_bed(mix,ev,root,30)['status'])
            del ev['voice_files']
            self.assertEqual('unverified',music.generated_bed(mix,ev,root,30)['status'])

    def test_narration_copy_with_silent_boundaries_is_not_music(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);voice=root/'voice.wav';bed=root/'bed.wav';mix=root/'mix.wav'
            rng=random.Random(7)
            v=[0.0]*1000+[rng.uniform(-.3,.3) for _ in range(8000)]+[0.0]*1000
            self.wav(voice,v);self.wav(bed,[.5*a for a in v]);self.wav(mix,v)
            result=music.generated_bed(mix,self.evidence(root,voice,bed),root,30)
            self.assertEqual('unverified',result['status'],result)
            self.assertIn('高度相关',result['reason'])
