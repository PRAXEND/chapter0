"""Synthetic records exercise enforcement, never claim a real video review."""
import copy
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugins/video-studio/scripts'))
import production_plan as common
import studio
import web_bridge


def proposed(width=1080, height=1920, captions=True):
    settings = dict(width=width, height=height, captions=captions, portrait_bottom_inset=.18)
    source = dict(id='a', kind='video', duration=10, sha256='a'*64, url='https://example.org/a', start=100)
    use = dict(id='u1', sourceId='a', inSeconds=1, outSeconds=3, actionGroup='capture-a-01',
               role='primary', purpose='实际动作', compatibility='对应旁白且无冲突文字')
    shot = dict(id='s1', sourceIds=['a'], sourceUses=[use],
                layout=dict(composition='完整动作上移且背景铺满', contentBottom=.78, captionBottom=.80 if captions else None),
                **{'from': 0, 'to': 2}, narration='', visual='实际画面', screenText='', transition='硬切')
    plan = dict(title='Synthetic', script='test', shots=[shot],
                productionPlan=dict(version=1, materialReview='synthetic observations', layout=common.layout(settings)))
    return plan, dict(settings=settings, sources=[source])


class PlanRulesTests(unittest.TestCase):
    def test_no_style_and_each_style_get_the_same_rules(self):
        for style in (None, 'henry-hot-news@8', 'henry-technical-explainer@8'):
            p, d = proposed(); d['style_snapshot'] = style
            common.validate(p, d)
            p['shots'][0]['layout']['captionBottom'] = .9
            with self.assertRaisesRegex(ValueError, '避让区'): common.validate(p, d)

    def test_portrait_dimensions_not_style_or_resolution_control_layout(self):
        for w, h in ((1080, 1920), (720, 1280), (900, 1200)):
            p, d = proposed(w, h, False); common.validate(p, d)
            p['shots'][0]['layout']['contentBottom'] = .85
            with self.assertRaises(ValueError): common.validate(p, d)
        for w, h in ((1920, 1080), (1080, 1080)):
            p, d = proposed(w, h)
            p['shots'][0]['layout'].update(contentBottom=None, captionBottom=.98)
            self.assertEqual(p['productionPlan']['layout'], dict(mode='unchanged', bottomInset=0))
            common.validate(p, d)

    def test_portrait_override_and_optional_captions(self):
        p, d = proposed(captions=False)
        common.validate(p, d)
        d['settings']['portrait_bottom_inset'] = .25
        with self.assertRaises(ValueError): common.validate(p, d)
        p['productionPlan']['layout'] = common.layout(d['settings'])
        p['shots'][0]['layout']['contentBottom'] = .75
        common.validate(p, d)
        for value in (True, float('nan'), -.1, .41, '18'):
            with self.assertRaises(ValueError): common.layout(dict(portrait_bottom_inset=value))

    def test_known_repeats_overlap_and_same_bytes_are_rejected(self):
        for mode in ('same-source', 'same-bytes', 'same-file', 'source-loop', 'repost-group', 'url-offset'):
            with self.subTest(mode=mode):
                p, d = proposed(); a = p['shots'][0]['sourceUses'][0]
                b = {**a, 'id': 'u2', 'actionGroup': 'distinct'}
                if mode in ('same-bytes', 'same-file', 'repost-group', 'url-offset'):
                    other = {**d['sources'][0], 'id': 'b', 'url': 'https://example.org/b', 'sha256': 'b'*64}
                    if mode == 'same-bytes': other['sha256'] = 'a'*64
                    if mode == 'same-file':
                        d['sources'][0]['local_path'] = other['local_path'] = '/same/clip.mp4'
                    if mode == 'url-offset': other.update(url=d['sources'][0]['url'], start=101); b.update(inSeconds=0, outSeconds=2)
                    if mode == 'repost-group': b['actionGroup'] = a['actionGroup']
                    d['sources'].append(other); b['sourceId'] = 'b'; p['shots'][0]['sourceIds'].append('b')
                if mode == 'source-loop': b.update(inSeconds=6, outSeconds=8, actionGroup=a['actionGroup'])
                p['shots'][0]['sourceUses'].append(b)
                with self.assertRaisesRegex(ValueError, '重复动作'): common.validate(p, d)

    def test_adjacent_distinct_segments_and_different_robots_are_allowed(self):
        p, d = proposed(); first = p['shots'][0]['sourceUses'][0]
        p['shots'][0]['sourceUses'].append({**first, 'id': 'u2', 'inSeconds': 3, 'outSeconds': 6, 'actionGroup': 'capture-a-02'})
        d['sources'].append({**d['sources'][0], 'id': 'b', 'sha256': 'b'*64, 'url': 'https://example.org/b'})
        p['shots'][0]['sourceIds'].append('b')
        p['shots'][0]['sourceUses'].append({**first, 'id': 'u3', 'sourceId': 'b', 'role': 'supplemental', 'actionGroup': 'different-robot-kick'})
        common.validate(p, d)

    def test_same_url_nonoverlapping_original_offsets_are_allowed(self):
        p, d = proposed(); d['sources'].append({**d['sources'][0], 'id': 'b', 'sha256': 'b'*64, 'start': 110})
        p['shots'][0]['sourceIds'].append('b')
        p['shots'][0]['sourceUses'].append({**p['shots'][0]['sourceUses'][0], 'id': 'u2', 'sourceId': 'b', 'actionGroup': 'next-capture'})
        common.validate(p, d)

    def test_explicit_replay_exception_does_not_bypass_source_bounds(self):
        p, d = proposed(); p['shots'][0]['sourceUses'].append({**p['shots'][0]['sourceUses'][0], 'id': 'u2'})
        d['settings']['replay_authorization'] = '请回放一次，便于对照'
        common.validate(p, d)
        p['shots'][0]['sourceUses'][1]['outSeconds'] = 11
        with self.assertRaises(ValueError): common.validate(p, d)

    def test_images_graphics_and_invalid_data(self):
        p, d = proposed(); d['sources'][0]['kind'] = 'image'
        use = p['shots'][0]['sourceUses'][0]
        with self.assertRaises(ValueError): common.validate(p, d)
        use.update(inSeconds=None, outSeconds=None, actionGroup='')
        common.validate(p, d)
        p['shots'][0].update(sourceIds=[], sourceUses=[]); common.validate(p, d)
        for field, value in [('sourceIds', ['missing']), ('sourceUses', [None]), ('layout', None)]:
            changed = copy.deepcopy(p); changed['shots'][0][field] = value
            with self.assertRaises(ValueError): common.validate(changed, d)


class ProductionAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'VIDEO_STUDIO_HOME': str(self.root/'user')}); self.env.start()
        self.plan, data = proposed(160, 90, False)
        brief = dict(topic='Test', style=None, requirements={**data['settings'], 'fps': 25, 'target_seconds': 2,
                     'max_seconds': 2, 'narration': False, 'audio_required': False})
        self.run = Path(studio.new_run('Test', self.root/'runs', brief)['run'])
        self.source = self.run/'source.mp4'; self.source.write_bytes(b'synthetic fixture, not a media file')
        studio.record(self.run, 'source', {**data['sources'][0], 'title': 'Fixture', 'local_path': str(self.source), 'sha256': studio.file_hash(self.source)})
        studio.record(self.run, 'selection', dict(topic='Test', confirmed_by_user=True))
        studio.record(self.run, 'project', dict(projectId='synthetic-project', timelineId='synthetic-timeline'))
        self.evidence = self.run/'evidence.txt'; self.evidence.write_text('Synthetic timeline readback only')
        self.proof = dict(item_ids=['synthetic-item'], observations='synthetic', evidence_files=[dict(path=str(self.evidence), sha256=studio.file_hash(self.evidence))])
        self.beat = dict(id='b1', shot_id='s1', from_frame=0, to_frame=50, source_ids=['a'], visual_anchor='Test',
                         source_uses=[{**self.plan['shots'][0]['sourceUses'][0], **self.proof, 'from_frame': 0, 'to_frame': 50}])
        studio.record(self.run, 'beat', self.beat)
        self.media = dict(format=dict(duration='2'), streams=[dict(codec_type='video', codec_name='h264', width=160, height=90, avg_frame_rate='25/1')])

    def tearDown(self): self.env.stop(); self.temp.cleanup()

    def errors(self): return common.implementation_errors(studio.load_run(self.run), self.run, 50)
    def report(self): return studio.audit_data(studio.load_run(self.run), self.media, [], 'a'*64, review_base=self.run)
    def save(self): studio.record(self.run, 'production_plan', self.plan)

    def test_new_run_requires_common_plan_and_legacy_run_keeps_recovery(self):
        self.assertIn('production_plan_missing', self.report()['failures'])
        data = studio.load_run(self.run); data.pop('production_policy_version'); studio.write(self.run/'run.json', data)
        self.assertNotIn('production_plan_missing', self.report()['failures'])
        self.save(); self.assertEqual(self.errors(), [])
        self.assertIn('material_continuity', self.report()['review_pending'])
        self.assertNotIn('portrait_layout', self.report()['review_pending'])

    def test_actual_uses_and_evidence_are_required(self):
        self.save(); self.assertEqual(self.errors(), [])
        for change in ({'source_uses': []}, {'source_ids': []}, {'shot_id': 'unknown'},
                       {'source_uses': [{**self.beat['source_uses'][0], 'outSeconds': 4}]},
                       {'source_uses': [{**self.beat['source_uses'][0], 'to_frame': 100}]},
                       {'source_uses': [{**self.beat['source_uses'][0], 'item_ids': 'not-a-list'}]}):
            studio.record(self.run, 'beat', {**self.beat, **change}); self.assertTrue(self.errors())
        studio.record(self.run, 'beat', self.beat); self.evidence.write_text('changed')
        self.assertTrue(self.errors())

    def test_hash_offset_and_local_bytes_changes_invalidate_source_binding(self):
        self.save()
        data = studio.load_run(self.run); data['sources'][0]['source_start_seconds'] = 200
        self.assertIn('production_source_changed', common.implementation_errors(data, self.run, 50))
        self.source.write_bytes(b'changed')
        self.assertIn('production_source_file_changed', self.errors())

    def test_review_requires_current_plan_hash_and_final_export(self):
        self.save()
        for key in self.report()['review_pending']:
            studio.record(self.run, 'review', dict(check=key, result='pass', artifact_sha256='a'*64,
                method=studio.REVIEW_METHODS[key], reviewer='synthetic test', observations='synthetic', evidence='test',
                coverage_frames=[0, 50], evidence_files=self.proof['evidence_files']))
        self.assertEqual(self.report()['review_pending'], ['material_continuity'])
        data = studio.load_run(self.run); review = data['reviews']['material_continuity']
        review['production_plan_sha256'] = data['production_plan']['sha256']; studio.record(self.run, 'review', review)
        self.assertTrue(self.report()['completed'])
        self.plan['productionPlan']['materialReview'] = 'changed plan'; self.save()
        self.assertFalse(self.report()['completed'])

    def test_portrait_requires_actual_placement_and_caption_bounds(self):
        data = studio.load_run(self.run); data['settings'].update(width=90, height=160, captions=True)
        studio.write(self.run/'run.json', data)
        self.plan['productionPlan']['layout'] = common.layout(data['settings']); self.plan['shots'][0]['layout']['captionBottom'] = .80
        self.save(); self.assertTrue(self.errors())
        self.beat['layout_result'] = {**self.plan['shots'][0]['layout'], **self.proof}
        studio.record(self.run, 'beat', self.beat); self.assertEqual(self.errors(), [])
        self.beat['layout_result']['contentBottom'] = .95
        studio.record(self.run, 'beat', self.beat); self.assertTrue(self.errors())

    def test_web_approval_binds_common_plan_without_a_style(self):
        payload = dict(run=str(self.run), plan=self.plan, inputHash='a'*64)
        saved = web_bridge.save_plan(payload)
        request = dict(run=str(self.run), planHash=saved['file_sha256'], inputHash='a'*64)
        web_bridge.approve(request); self.assertEqual(web_bridge.check_approval(request)['status'], 'confirmed')
        self.plan['shots'][0]['sourceUses'][0]['purpose'] = 'changed purpose'
        changed = web_bridge.save_plan(payload)
        self.assertEqual(changed['status'], 'awaiting_confirmation')
        with self.assertRaises(ValueError): web_bridge.check_approval(request)

    def test_resaving_changed_source_metadata_rebinds_and_revokes_approval(self):
        payload = dict(run=str(self.run), plan=self.plan, inputHash='a'*64)
        saved = web_bridge.save_plan(payload)
        request = dict(run=str(self.run), planHash=saved['file_sha256'], inputHash='a'*64)
        web_bridge.approve(request)
        source = studio.load_run(self.run)['sources'][0]
        studio.record(self.run, 'source', {**source, 'source_start_seconds': 200})
        changed = web_bridge.save_plan(payload)
        self.assertEqual(changed['version'], saved['version'] + 1)
        self.assertEqual(changed['status'], 'awaiting_confirmation')
        with self.assertRaises(ValueError): web_bridge.check_approval(request)
        self.assertEqual(self.errors(), [])
