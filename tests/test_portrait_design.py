"""Accepted geometry and actual layer/timing contract; no claimed visual approval."""
import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'plugins/video-studio/scripts'))
import portrait_design as recipe
import production_plan as policy


def fixture():
    settings=dict(width=1080,height=1920,fps=30,captions=True)
    payload=recipe.build(settings,1788,'机器人看人做，\n也能学会？','也能学会？')
    data=dict(settings=settings,production_plan=dict(plan=dict(productionPlan=dict(layout=payload['layout'],coverTitle='机器人看人做，也能学会？',titleEmphasis='也能学会？'))))
    def item(ident,track,first,last,typ='motion-graphic',**extra):
        return dict(kind='item',id=ident,trackId=track,itemType=typ,asset=dict(id=ident+'-asset'),timelineRange=dict(fromFrame=first,toFrame=last),properties=dict(left=0,top=0,width=1080,height=1920,opacity=1,**extra))
    entries=[item('background','bottom',0,1788),item('ending','top',1734,1788),item('music','music',0,1770,'audio',audioFadeOut=1.4)]
    evidence=dict(timeline=dict(state=dict(durationFrames=1788,fps=30),timeline=dict(entries=entries,totalEntries=3,tracks=[dict(id='bottom',type='video',order=0,muted=False),dict(id='captions',type='caption',order=1,muted=False),dict(id='top',type='video',order=2,muted=False),dict(id='music',alias='A2',type='audio',order=3,muted=False)])),music_tracks=['music'],presentation={})
    for role,index in [('background',0),('ending',2)]:
        evidence['presentation'][role]=dict(item_id=role,asset_id=role+'-asset',asset_revision='actual-inspect-revision',effective_properties={p['key']:p['defaultValue'] for p in payload['assets'][index]['properties']},readback_files=[dict(path='readback.json',sha256='a'*64)])
    return data,evidence,payload


class PortraitRecipeTests(unittest.TestCase):
    def test_accepted_pixels_and_exact_ending_are_reproduced(self):
        _,_,p=fixture()
        self.assertEqual(p['placements'][1]['top'],422)
        self.assertEqual(p['captionLayouts']['1'],dict(left=54,top=1281,width=972,height=68))
        self.assertEqual(p['captionLayouts']['2']['height'],135)
        self.assertEqual(p['endingTimeline'],dict(fadeStartFrame=1734,blackStartFrame=1770,endFrame=1788,musicEndFrame=1770,musicFadeOutSeconds=1.4))
        self.assertEqual(p['assets'][0]['durationInFrames'],1788)
        self.assertEqual(p['assets'][2]['durationInFrames'],54)

    def test_width_scaled_geometry_keeps_gap_and_center_on_other_portraits(self):
        for w,h in [(720,1280),(900,1200),(1080,1081)]:
            p=recipe.build(dict(width=w,height=h,fps=25,captions=False),250,'Robot learns','learns')
            box=p['layout']['mediaBox'];s=w/1080
            self.assertAlmostEqual((box['top']+box['bottom'])*h/2,h/2)
            self.assertAlmostEqual((box['bottom']-box['top'])*h,608*s)
            self.assertGreaterEqual(p['placements'][1]['top'],0)
            self.assertIsNone(p['shotLayout']['captionBox'])
            self.assertEqual(p['endingTimeline']['blackStartFrame'],235)
            self.assertEqual(p['endingTimeline']['fadeStartFrame'],205)

    def test_title_emphasis_is_real_text_not_an_all_white_color_hint(self):
        settings=dict(width=1080,height=1920,fps=30,captions=True)
        for emphasis in ['', 'Missing', 'Robot learns', ' learns ']:
            with self.assertRaises(ValueError):recipe.build(settings,300,'Robot learns',emphasis)
        with self.assertRaises(ValueError):recipe.build(settings,300,'Robot\nlearns\nagain','learns')
        with self.assertRaises(ValueError):recipe.build(settings,54,'Robot learns','learns')

    def test_real_layers_and_audio_ending_are_required_before_review(self):
        d,e,_=fixture();self.assertEqual(policy.presentation_errors(d,e,1788,30),{})
        e['music_tracks']=['A2'];self.assertEqual(policy.presentation_errors(d,e,1788,30),{})
        for mutate,key in [
            (lambda x:x['presentation'].pop('background'),'portrait_layout'),
            (lambda x:x.update(music_tracks=['missing']),'transitions'),
            (lambda x:x['timeline']['timeline']['tracks'][3].update(muted=True),'transitions'),
            (lambda x:x['presentation']['background']['effective_properties'].update(lineCount=30),'portrait_layout'),
            (lambda x:x['presentation']['background']['effective_properties'].update(speed=.65),'portrait_layout'),
            (lambda x:x['timeline']['timeline']['tracks'][0].update(order=3),'portrait_layout'),
            (lambda x:x['timeline']['timeline']['entries'][1]['timelineRange'].update(fromFrame=1750),'transitions'),
            (lambda x:x['timeline']['timeline']['entries'][2]['properties'].update(audioFadeOut=0),'transitions')]:
            changed=copy.deepcopy(e);mutate(changed)
            self.assertIn(key,policy.presentation_errors(d,changed,1788,30))

    def test_visual_metadata_never_substitutes_for_required_observations(self):
        d,_,_=fixture()
        review=dict(check='portrait_layout',presentation_observations=[])
        self.assertEqual(len(policy.presentation_review_errors(d,review,1788)),3)
        review['presentation_observations']=[dict(feature=f,frames=[39,800],observations='Actual sampled frames') for f in ['spacing','title_color','background']]
        self.assertEqual(policy.presentation_review_errors(d,review,1788),[])
        review=dict(check='transitions',presentation_observations=[dict(feature='ending',frames=[1734,1770],observations='Actual fade')])
        self.assertTrue(policy.presentation_review_errors(d,review,1788))
        review['presentation_observations'][0]['frames'].extend([1752,1787])
        self.assertEqual(policy.presentation_review_errors(d,review,1788),[])

    def test_narration_occupancy_handles_gaps_cross_shot_clips_and_overlap(self):
        def clip(ident,a,b):return dict(kind='item',id=ident,trackId='voice',asset=dict(id='source'),timelineRange=dict(fromFrame=a,toFrame=b),sourceRange=dict(start=0,end=(b-a)/30*1.2*1e6),playbackRate=1.2)
        e=dict(narration_tracks=['voice'],timeline=dict(timeline=dict(entries=[clip('a',0,45),clip('b',75,135)],totalEntries=2,tracks=[dict(id='voice',alias='A1',muted=False)])))
        beat=dict(from_frame=30,to_frame=120,narration_item_ids=['a','b'],audio_asset_id='source')
        self.assertEqual(policy.narration_occupancy(beat,e,30),2)
        e['narration_tracks']=['A1'];self.assertEqual(policy.narration_occupancy(beat,e,30),2)
        bad=copy.deepcopy(beat);bad['narration_item_ids']=['a']
        with self.assertRaises(ValueError):policy.narration_occupancy(bad,e,30)
        bad=copy.deepcopy(e);bad['timeline']['timeline']['entries'][1]['sourceRange']['end']=1
        with self.assertRaises(ValueError):policy.narration_occupancy(beat,bad,30)
        e['timeline']['timeline']['entries'][1]=clip('b',40,135)
        self.assertEqual(policy.narration_occupancy(beat,e,30),3)


if __name__=='__main__':unittest.main()
