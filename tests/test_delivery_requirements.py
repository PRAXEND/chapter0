import subprocess
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'plugins/video-studio/scripts'))
import delivery_requirements as req
import studio
import styles
import user_packs
import review_music


class DeliveryRequirements(unittest.TestCase):
    def setUp(self):
        self.data = {'settings':{'narration':True,'captions':True,'voice':{'provider':'test','voiceId':'xiaotian','selected_by_user':True}},
                     'brief':{'workbench_rules':2,'generate_music':True}, 'project':{'projectId':'p','timelineId':'t'},'operations':{'music':{
                     'status':'completed','input':{'arguments':{'generationType':'instrumental'}},
                     'result':{'projectId':'p','timelineId':'t','assetId':'A2','jobId':'m'}}}}
        self.cues = [{'start':0,'end':1,'lines':['测试']}]
        tracks = [{'id':s,'alias':s} for s in ['A1','A2']]
        items = [{'asset':{'id':s},'trackId':s,'kind':'item','itemType':'audio'} for s in ['A1','A2']]
        self.e = {'timeline_id':'t','timeline':{'timeline':{'totalEntries':2,'entries':items,'tracks':tracks}},
                  'narration_tracks':['A1'],'music_tracks':['A2'],'music_files':[{'assetId':'A2','generationTaskId':'m','sha256':'hash'}],
                  'voice_sources':[{'assetId':'A1','data':[{'asset':{'id':'A1','generationRecord':{'params':self.data['settings']['voice'].copy()}}}]}],
                  'caption_state':{'enabled':True,'timelineId':'t','tracks':[{'id':'c','visible':True}],
                                   'cards':[{'id':'card','trackId':'c','hidden':False,'start_frame':0,'end_frame':30,'lines':['测试']}]}}
    def check(self):
        return req.check(self.data,self.e,self.cues,30)
    def test_each_used_asset_must_match_and_each_requested_track_must_be_visible(self):
        self.assertEqual({},self.check())
        self.e['voice_sources'][0]['data'][0]['asset']['generationRecord']['params']['voiceId']='dayi'
        self.e['caption_state']['cards'][0]['hidden']=True
        self.e['timeline']['timeline']['tracks'][1]['muted']=True
        self.assertEqual(set(self.check()),{'caption_flow','music_fit','av_sync'})
    def test_hosted_voice_header_and_music_receipt(self):
        asset = self.e['voice_sources'][0]['data'][0]['asset']
        del asset['generationRecord']['params']['provider']
        asset['generation'] = 'Generated: test voice | model test | job 123 | voiceId xiaotian'
        self.assertEqual({}, self.check())
        asset['generation'] = 'Generated: other voice | model test'
        self.e['music_files'][0]['generationTaskId'] = 'unrelated-job'
        self.assertEqual({'av_sync','music_fit'},set(self.check()))

    def test_native_caption_pagination_cannot_hide_missing_or_changed_cards(self):
        from copy import deepcopy
        first = {'topologyVersion':2, 'revision':'r', 'timelineId':'t', 'projectId':'p', 'settings':{'enabled':True},
                 'tracks':[{'id':'c','hidden':False}], 'page':{'offset':0,'returned':1,'total':2},
                 'nextOffset':1,'hasMore':True, 'items':[{'id':'a','trackId':'c','from':30,'durationInFrames':30,
                                                         'data':{'hidden':False,'lines':[{'text':'甲'}]}}]}
        second = deepcopy(first)
        second.update(hasMore=False,nextOffset=None,page={'offset':1,'returned':1,'total':2})
        second['items'][0].update(id='b', **{'from':60})
        cards = req.visible_cards({'caption_pages':[first,second],'timeline_id':'t'})
        self.assertIn('00:00:01,000 --> 00:00:02,000',req.subtitles_text(cards,30))
        with self.assertRaises(ValueError): req.native_caption_state([first],'t','p')
        second['revision']='other'
        with self.assertRaises(ValueError): req.native_caption_state([first,second],'t','p')
        second['revision']='r'
        for p in (first,second): p['tracks'][0]['hidden']=True
        with self.assertRaises(ValueError): req.visible_cards({'caption_pages':[first,second],'timeline_id':'t'})

    def test_caption_observations_and_music_opt_out(self):
        samples=req.sample_captions(self.cues,30,30)
        self.assertTrue(req.observed_captions_match(samples,[{'frame':15,'text':'测试。'}]))
        self.assertFalse(req.observed_captions_match(samples,[{'frame':15,'text':'无字幕'}]))
        self.assertFalse(req.observed_captions_match(samples,[]))
        self.data['brief']['generate_music']=False
        self.assertIn('music_fit',self.check())
        self.e['music_tracks']=[]
        self.assertEqual({},self.check())
    def test_old_import_kept_intact_while_all_active_shawn_snapshots_omit_fixed_speaker(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'VIDEO_STUDIO_HOME':tmp}):
            user_packs.install(ROOT/'user-packs/shawn-style-fusion/manifest.json')
            for item in styles.catalog():
                source=Path(item['skill_path'])
                before=source.read_bytes()
                self.assertIn('大壹',before.decode())
                snapshot=styles.snapshot(item['selector'],Path(tmp)/'new-run',current_rules=True)
                rule=Path(snapshot['skill_path']).read_text()
                self.assertNotIn('大壹',rule)
                self.assertIn('本期选定音色',rule)
                self.assertEqual(source.read_bytes(),before)

    def test_actual_music_in_mix_is_distinguished_from_other_audio(self):
        binary = studio.native_tool('ffmpeg')
        if not binary:
            self.skipTest('local FFmpeg required')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); bed=root/'music.wav'; other=root/'voice.wav'; mix=root/'mix.m4a'
            for file,seed in [(bed,12),(other,77)]:
                subprocess.run([binary,'-loglevel','error','-f','lavfi','-i',f'anoisesrc=color=pink:duration=3:seed={seed}',str(file)],check=True)
            subprocess.run([binary,'-loglevel','error','-i',str(bed),'-i',str(other),'-filter_complex',
                            '[0:a]volume=0.45[m];[m][1:a]amix=inputs=2','-c:a','aac',str(mix)],check=True)
            clip=self.e['timeline']['timeline']['entries'][1]
            clip.update(id='clip_music',sourceRange={'start':0,'end':3000000},timelineRange={'fromFrame':0,'toFrame':90})
            self.e['music_files'][0].update(path=str(bed),sha256=studio.file_hash(bed))
            self.assertEqual('checked',review_music.generated_bed(mix,self.e,root,30)['status'])
            self.assertEqual('unverified',review_music.generated_bed(other,self.e,root,30)['status'])
            delayed=root/'browser-mix.m4a'
            subprocess.run([binary,'-loglevel','error','-i',str(mix),'-af','adelay=69:all=true',str(delayed)],check=True)
            measured=review_music.generated_bed(delayed,self.e,root,30)
            self.assertEqual('checked',measured['status'])
            self.assertAlmostEqual(69,measured['clips'][0]['offset_ms'],delta=4)
