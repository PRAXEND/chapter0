import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugins/robot-video-studio/scripts'))
import review_quality as q
import studio


def entry(ident, kind, a, b, track='V2'):
    return {'id':ident, 'kind':'item', 'itemType':kind, 'trackAlias':track,
            'timelineRange':{'fromFrame':a,'toFrame':b}, 'asset':{'id':ident}}


class QualityTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.base=Path(self.tmp.name)
        # These are schema test files, not assertions of real media inspection.
        (self.base/'proof.txt').write_text('Synthetic review evidence for unit tests only.')
        self.ref={'path':'proof.txt','sha256':q.file_hash(self.base/'proof.txt')}
        self.plan={'schema_version':1,'requirements':q.DEFAULT_CREATIVE.copy(),
                   'chapters':[{'id':'c1','from_frame':0,'to_frame':90,'transition':'opening'},
                               {'id':'c2','from_frame':90,'to_frame':180,'transition':'designed'}],
                   'motion_beats':['b1'], 'script_review':[{'beat_id':'b1','text_sha256':q.text_hash('Concrete narration.'),'decision':'keep','observation':'Describes visible action.','reason':'No generic wrapper.'}]}
        self.run={'revision':4,'settings':{'creative':q.DEFAULT_CREATIVE.copy()},'quality_plan':self.plan,
                  'beats':[{'id':'b1','narration':'Concrete narration.','from_frame':0,'to_frame':180}], 'reviews':{}}
        self.entries=[entry('diagram','motion-graphic',0,90),entry('shot','video',90,180),entry('wipe','motion-graphic',80,100,'V3')]
        self.creative={'artifact_sha256':'a'*64,'run_revision':4,'plan_sha256':q.digest(self.plan),
                      'items':{'diagram':{'role':'explanation','visible_height_fraction':.7,'measurement':self.ref,
                                         'samples':self.samples([0,45,89]),'core_motion_ranges':[[0,90]],'beat_ids':['b1'],
                                         'stages':[{'range':[0,45],'meaning':'Show starting value'},{'range':[45,90],'meaning':'Reveal comparison'}]},
                               'shot':{'role':'footage','visible_height_fraction':.8,'measurement':self.ref,'samples':self.samples([120])},
                               'wipe':{'role':'transition'}},
                      'transitions':[{'chapter_id':'c2','kind':'overlay','item_ids':['wipe'],'from_frame':80,'to_frame':100,'samples':self.samples([80,90,99])}]}
        self.proof={'visual_tracks':['V2'], 'timeline':{'state':{'durationFrames':180,'fps':30}, 'timeline':{'entries':self.entries,'totalEntries':3}}, 'creative':self.creative}

    def tearDown(self): self.tmp.cleanup()
    def samples(self, frames): return [dict(self.ref,frame=f) for f in frames]
    def check(self): return q.check(self.run,self.proof,'a'*64,self.base)
    def test_complete_bound_evidence_can_pass_structure(self):
        self.assertEqual('pass',self.check()['status'])
    def test_real_timeline_gap_entries_do_not_need_object_ids(self):
        self.entries.append({'kind':'gap','trackAlias':'A1','timelineRange':{'fromFrame':40,'toFrame':45}})
        self.proof['timeline']['timeline']['totalEntries']=4
        self.assertEqual('pass',self.check()['status'])
    def test_missing_plan_never_inherits_legacy_pass(self):
        self.run.pop('quality_plan'); self.assertEqual('unverified',self.check()['status'])
    def test_preferences_are_validated_and_not_global_personal_defaults(self):
        self.assertEqual('purposeful',q.preferences({})['transitions'])
        for patch in ({'transition':'designed'},{'music':'vocal'},{'layout':True}):
            with self.assertRaises((ValueError,TypeError)): q.preferences(patch)
    def test_requested_overlay_needs_real_video_covering_the_diagram(self):
        self.plan['requirements']['diagram_mode']='footage_overlay'
        self.run['settings']['creative']['diagram_mode']='footage_overlay'
        self.creative['plan_sha256']=q.digest(self.plan)
        self.assertIn('diagram_without_relevant_footage:diagram',self.check()['pending'])
        underlay=entry('underlay','video',0,90,'V1');self.entries.append(underlay)
        self.proof['timeline']['timeline']['totalEntries']=4
        self.creative['items']['underlay']={'role':'footage'}
        self.creative['items']['diagram'].update(underlay_item_ids=['underlay'],underlay_relevance='The diagram marks the contact points visible in this same action.')
        self.assertNotIn('diagram_without_relevant_footage:diagram',self.check()['pending'])
        underlay['timelineRange']['toFrame']=60
        self.assertIn('diagram_without_relevant_footage:diagram',self.check()['pending'])
    def test_long_composed_still_cannot_be_waived_with_keep_reason(self):
        self.plan['requirements']['still_policy']='no_extended_static'
        self.run['settings']['creative']['still_policy']='no_extended_static'
        self.creative['items']['diagram']['static_ranges']=[[0,90]]
        self.creative['items']['shot']['static_ranges']=[]
        self.creative['resolutions']={'extended_composed_static:0:90':{'decision':'keep','reason':'Long hold','observation':'Intended','evidence_files':[self.ref],'samples':self.samples([30])}}
        self.assertIn('extended_composed_static:0:90',self.check()['pending'])
    def test_overlay_diagrams_are_checked_outside_primary_track(self):
        self.entries[0]['trackAlias']='V3'
        self.creative['items']['diagram'].pop('core_motion_ranges')
        self.assertIn('core_motion_unmeasured:diagram',self.check()['pending'])
    def test_unmeasured_stillness_cannot_pass_strict_preference(self):
        self.plan['requirements']['still_policy']='no_extended_static'
        self.assertIn('composed_stillness_unmeasured:shot',self.check()['pending'])
    def test_changed_script_requires_another_readthrough(self):
        self.run['beats'][0]['narration']='Changed after the review.'
        self.assertIn('script_readthrough:b1',self.check()['pending'])
    def test_wrong_or_missing_transition_cannot_be_counted(self):
        self.creative['transitions'][0]['item_ids']=['shot']
        self.assertIn('designed_transition_missing_or_unreviewed:c2',self.check()['pending'])
        self.creative['transitions'][0]['item_ids']=['missing']
        self.assertIn('designed_transition_missing_or_unreviewed:c2',self.check()['pending'])
    def test_header_entrance_does_not_count_as_transition(self):
        self.creative['items']['wipe']['role']='header'
        self.assertIn('designed_transition_missing_or_unreviewed:c2',self.check()['pending'])
    def test_adjacent_frames_cannot_prove_transition_sequence(self):
        self.creative['transitions'][0]['samples']=self.samples([80,81,82])
        self.assertIn('designed_transition_missing_or_unreviewed:c2',self.check()['pending'])
    def test_deleted_or_changed_sample_file_requires_review(self):
        (self.base/'proof.txt').write_text('changed')
        self.assertIn('visual_evidence:shot',self.check()['pending'])
    def test_semantic_motion_stages_must_match_spoken_beat(self):
        self.run['beats'][0].update(from_frame=90,to_frame=180)
        self.assertIn('semantic_motion_missing_or_unreviewed:b1',self.check()['pending'])
    def test_incomplete_timeline_and_wrong_primary_track_rejected(self):
        self.proof['timeline']['timeline']['totalEntries']=4
        self.assertEqual('unverified',self.check()['status'])
        self.proof['timeline']['timeline']['totalEntries']=3; self.proof['visual_tracks']=['V1']
        self.assertEqual('unverified',self.check()['status'])
    def test_uniuni_pattern_detected_without_private_assets(self):
        # Measured case: two diagrams 376–991; path motion 758–873;
        # UI 991–1273 consumes 3.76s source (0.4x), 608px of a 1920px frame.
        self.plan['chapters']=[{'id':'c1','from_frame':0,'to_frame':376,'transition':'opening'},
                               {'id':'c2','from_frame':376,'to_frame':2100,'transition':'designed'}]
        self.entries[:]=[entry('intro','video',0,376),entry('tracks','motion-graphic',376,603),entry('path','motion-graphic',603,991),entry('ui','video',991,1273),entry('outro','video',1273,2100)]
        self.entries[3]['sourceRange']={'start':0,'end':3760000}
        self.proof['timeline']['state']['durationFrames']=2100
        self.proof['timeline']['timeline']['totalEntries']=5
        self.creative['items']={e['id']:{'role': 'explanation' if e['itemType']=='motion-graphic' else 'footage','measurement':self.ref,'visible_height_fraction':608/1920,'samples':self.samples([e['timelineRange']['fromFrame']])} for e in self.entries}
        self.creative['items']['tracks']['core_motion_ranges']=[[376,581]]
        self.creative['items']['path']['core_motion_ranges']=[[758,873]]
        self.creative['items']['ui']['role']='interface'; self.creative['transitions']=[]
        report=self.check(); rows={r['id']:r for r in report['candidates']}
        self.assertAlmostEqual(20.5,rows['diagram_run:tracks']['seconds'])
        self.assertAlmostEqual(9.1,rows['static_core:path']['stationary_seconds'])
        self.assertAlmostEqual(.4,rows['slow_ui:ui']['rate'])
        self.assertIn('small:ui',rows)
        self.assertIn('designed_transition_missing_or_unreviewed:c2',report['pending'])
    def test_reason_only_cannot_close_candidate_but_documented_exception_can(self):
        self.creative['items']['shot']['visible_height_fraction']=.3
        self.creative['resolutions']={'small:shot':{'decision':'keep','reason':'Complete action needs a wide view.'}}
        self.assertIn('candidate:small:shot',self.check()['pending'])
        self.creative['resolutions']['small:shot'].update(observation='The hands stay in view.',evidence_files=[self.ref],samples=self.samples([120]))
        self.assertNotIn('candidate:small:shot',self.check()['pending'])
    def test_bad_motion_intervals_fail_closed(self):
        self.creative['items']['diagram']['core_motion_ranges']=[[0,50],[40,90]]
        self.assertEqual('unverified',self.check()['status'])
    def review(self,key):
        return {'result':'pass','artifact_sha256':'a'*64,'subtitle_sha256':'b'*64,'revision':4,'plan_sha256':q.digest(self.plan),
                'evidence_sha256':q.digest(self.proof),'method':next(iter(q.METHODS[key])),'reviewer':'unit-test fixture','observations':['Synthetic observation'],
                'evidence':'Synthetic only','evidence_files':[self.ref],'coverage_frames':[[0,90],[90,180]],
                'script_sha256':q.digest({'b1':q.text_hash('Concrete narration.')})}
    def issues(self,key,r): return q.review_issues(key,r,self.run,'a'*64,'b'*64,180,self.base,self.proof)
    def test_sampling_pass_cannot_certify_continuous_or_audio_review(self):
        for key in ['composed_visuals','audio_listening','editorial_rhythm']:
            r=self.review(key);r['method']='frame_inspection'
            self.assertIn('missing_or_incompatible_method',self.issues(key,r))
    def test_full_review_requires_gapless_coverage(self):
        r=self.review('audio_listening');r['coverage_frames']=[[0,80],[90,180]]
        self.assertIn('incomplete_full_length_review',self.issues('audio_listening',r))
    def test_review_contradicting_evidence_is_pending(self):
        self.proof['verification']={'continuous_playback_review':False,'audio_listening':'unverified'}
        self.assertIn('contradicts_sampling_only_evidence',self.issues('composed_visuals',self.review('composed_visuals')))
        self.assertIn('contradicts_unverified_audio',self.issues('audio_listening',self.review('audio_listening')))
    def test_changed_hash_or_revision_or_plan_invalidates_review(self):
        for field,value,issue in [('artifact_sha256','c'*64,'stale_export_or_revision'),('revision',3,'stale_export_or_revision'),('plan_sha256','d'*64,'stale_quality_plan')]:
            r=self.review('facts');r[field]=value
            self.assertIn(issue,self.issues('facts',r))
    def test_legacy_bare_review_is_unverified(self):
        self.assertTrue(self.issues('composed_visuals',{'result':'pass','artifact_sha256':'a'*64,'revision':4}))
    def test_valid_reviews_and_bound_quality_gate_allow_completion(self):
        # 90-second technical fixture; no media perception is claimed by this test.
        run=copy.deepcopy(self.run)
        run.update(selection={'topic':'test'},project={'projectId':'p','timelineId':'t'},sources=[{'id':'s1'}],operations={})
        run['beats'][0].update(to_frame=2700,audio_duration_seconds=90,source_ids=['s1'],audio_asset_id='a1',visual_anchor='action')
        run['reviews']={key:{**self.review(key),'coverage_frames':[[0,2700]]} for key in studio.REVIEW_KEYS}
        media={'format':{'duration':'90'},'streams':[{'codec_type':'video','codec_name':'h264','width':1080,'height':1920,'avg_frame_rate':'30/1'},{'codec_type':'audio'}]}
        gate={'status':'pass','artifact_sha256':'a'*64,'run_revision':4,'plan_sha256':q.digest(self.plan)}
        args=(run,media,[{'start':0,'end':3,'lines':['test']}],'a'*64,'b'*64)
        self.assertTrue(studio.audit_data(*args,quality_check=gate,review_base=self.base,evidence=self.proof)['completed'])
        gate['run_revision']=3
        self.assertFalse(studio.audit_data(*args,quality_check=gate,review_base=self.base,evidence=self.proof)['completed'])
    def test_quality_plan_change_invalidates_reviews_and_same_plan_reuses(self):
        with mock.patch.dict('os.environ',{'ROBOT_VIDEO_STUDIO_HOME':str(self.base/'home')}):
            directory=studio.new_run('test',self.base)['run']
            studio.record(directory,'quality_plan',self.plan)
            state=studio.load_run(directory);before=state['revision']; state['reviews']={'facts':{'result':'pass'}}
            studio.write(Path(directory)/'run.json',state)
            studio.record(directory,'quality_plan',self.plan)
            self.assertEqual(before,studio.load_run(directory)['revision'])
            changed=copy.deepcopy(self.plan);changed['script_review'][0]['reason']='Updated reasoning'
            studio.record(directory,'quality_plan',changed)
            self.assertEqual({},studio.load_run(directory)['reviews'])
    def test_profile_preferences_snapshot_and_partial_update(self):
        with mock.patch.dict('os.environ',{'ROBOT_VIDEO_STUDIO_HOME':str(self.base/'home')}):
            studio.save_profile({'creative':{'transitions':'designed','music':'instrumental'}})
            directory=studio.new_run('test',self.base)['run']
            studio.save_profile({'creative':{'motion':'enhanced'}})
            self.assertEqual('instrumental',studio.profile()['creative']['music'])
            self.assertEqual('semantic',studio.load_run(directory)['settings']['creative']['motion'])
    def test_freeze_detector_checks_tail_and_cannot_be_overridden_by_empty_manual_ranges(self):
        self.plan['requirements']['still_policy']='no_extended_static'
        report={'status':'pass','pending':[]}
        q.apply_freeze_check(report,self.run,'lavfi.freezedetect.freeze_start: 2\nlavfi.freezedetect.freeze_end: 6\nlavfi.freezedetect.freeze_start: 8',12)
        self.assertEqual([[60,180],[240,360]],report['freeze_detection']['ranges'])
        self.assertEqual('needs_review',report['status'])
        self.assertIn('detected_composed_freeze:240:360',report['pending'])
    def test_empty_freeze_scan_does_not_claim_motion_perception(self):
        report={'status':'unverified','pending':['missing_review']}
        q.apply_freeze_check(report,self.run,'',6)
        self.assertEqual('unverified',report['status'])
        self.assertEqual([],report['freeze_detection']['ranges'])
    def test_record_rejects_metadata_only_pass(self):
        with mock.patch.dict('os.environ',{'ROBOT_VIDEO_STUDIO_HOME':str(self.base/'home')}):
            directory=studio.new_run('test',self.base)['run']
            with self.assertRaises(studio.StudioError):
                studio.record(directory,'review',{'check':'facts','result':'pass','artifact_sha256':'a'*64,'evidence':'Looks good'})


if __name__=='__main__': unittest.main()
