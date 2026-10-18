from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugins/robot-video-studio/scripts'))
import review_edit as r


def video(id, start, end, source_start, source_end, track='V1'):
    return {'kind':'item','itemType':'video','id':id,'trackAlias':track,'asset':{'id':'footage'},
            'timelineRange':{'fromFrame':start,'toFrame':end},
            'sourceRange':{'start':source_start*1e6,'end':source_end*1e6}}


class EditReviewTests(unittest.TestCase):
    def test_long_pause_inside_one_voice_clip(self):
        rows=r.candidates([{'start':0,'end':2},{'start':8.56,'end':10}],[])
        self.assertEqual('long_narration_pause',rows[0]['kind'])
        self.assertAlmostEqual(6.56,rows[0]['seconds'])

    def test_short_breath_and_overlapping_words_do_not_create_pause(self):
        self.assertEqual([],r.candidates([{'start':0,'end':2},{'start':1,'end':3},{'start':3.3,'end':4}],[]))

    def test_long_action_is_candidate_not_automatic_deletion(self):
        rows=r.candidates([], [video('action',0,450,0,15)])
        self.assertEqual('long_visual_hold',rows[0]['kind'])

    def test_internal_cuts_and_watermark_do_not_become_long_static_card(self):
        self.assertEqual([],r.candidates([], [video('montage',0,450,0,15),video('logo',0,2700,0,90,'V3')],cuts={'footage':[4,8,12]}))

    def test_later_reused_montage_is_detected(self):
        rows=r.candidates([], [video('first',0,180,10,16),video('last',900,1080,10,16)])
        self.assertEqual(['reused_source_window'],[x['kind'] for x in rows])

    def test_continuous_adjacent_windows_not_repeat(self):
        self.assertEqual([],r.candidates([], [video('first',0,180,10,16),video('next',180,360,16,22)]))

    def test_simultaneous_detail_inset_not_replay(self):
        self.assertEqual([],r.candidates([], [video('wide',0,180,10,16),video('inset',60,180,12,16,'V2')],visual_tracks=['V1','V2']))

    def evidence(self):
        clip={'kind':'item','itemType':'audio','id':'speech','trackAlias':'A1','asset':{'id':'voice'},
              'sourceRange':{'start':0,'end':10000000},'timelineRange':{'fromFrame':0,'toFrame':300}}
        return {'timeline':{'state':{'fps':30,'durationFrames':300},'timeline':{'entries':[clip],'totalEntries':1}},
                'voice_sources':[{'assetId':'voice','data':[{'transcript':{'status':'available','ranges':[{'segments':[{'startMs':0,'endMs':2000,'text':'一句'},{'startMs':8000,'endMs':10000,'text':'下一句'}]}]}}]}]}

    def test_incomplete_evidence_cannot_pass(self):
        e=self.evidence();e['timeline']['timeline']['totalEntries']=2
        self.assertEqual('unverified',r.check(e)['status'])
        self.assertEqual('unverified',r.check(None)['status'])

    def test_pause_exception_needs_specific_pixel_basis(self):
        e=self.evidence();report=r.check(e);key=report['candidates'][0]['id']
        e['editorial_review']={'opening':{'basis':'Visible action','frames':[0]},'layout':{'basis':'Hands and box visible','frames':[60]},'resolutions':{key:{'decision':'keep','basis':'The box is released during this pause'}}}
        self.assertEqual('needs_review',r.check(e)['status'])
        e['editorial_review']['resolutions'][key]['frames']=[60,240]
        self.assertEqual('pass',r.check(e)['status'])
        self.assertEqual(1,len(r.check(e)['candidates']))

    def test_missing_opening_layout_not_certified_by_no_candidates(self):
        e=self.evidence();e['voice_sources'][0]['data'][0]['transcript']['ranges'][0]['segments'][1]['startMs']=2200
        report=r.check(e)
        self.assertEqual([],report['candidates'])
        self.assertIn('opening_pixel_review',report['pending'])
        self.assertIn('layout_pixel_review',report['pending'])


if __name__=='__main__': unittest.main()
