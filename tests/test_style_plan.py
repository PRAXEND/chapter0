import copy
import json
from pathlib import Path
import unittest

import test_styles as fixtures
import test_quality_review as quality
import studio
import styles
import style_plan
import web_bridge

ROOT = Path(__file__).resolve().parents[1]


class StylePlanTests(unittest.TestCase):
    setUp = fixtures.StyleTests.setUp
    tearDown = fixtures.StyleTests.tearDown
    brief = fixtures.StyleTests.brief
    fixture = fixtures.StyleTests.fixture
    record_pass = quality.QualityTests.record_pass
    report = quality.QualityTests.report

    def planned(self, kind="hot-news"):
        spec = json.loads((ROOT / f"user-packs/henry-video-styles/styles/henry-{kind}-v8.json").read_text())
        styles.register(spec)
        selector = f"{spec['id']}@8"
        run, media = self.fixture(selector)
        conditional = {r['rule_id'] for r in spec['storyboard_contract']['conditional_rules']}
        plan = {"productionPlan": {"version": 1, "materialReview": "Synthetic observations", "layout": {"mode": "unchanged", "bottomInset": 0}}, "title": "测试方案", "summary": "合成测试记录，不是制作或验收结论", "script": "fixture",
                "shots": [{"id": "s1", "from": 0, "to": 180, "sourceIds": [], "sourceUses": [], "layout": {"composition": "Full frame graphics", "contentBottom": None, "captionBottom": None}, "narration": "", "visual": "测试真实动作指示",
                           "screenText": "", "transition": "硬切", "design": []}], "gaps": [], "notes": [], "limitations": [],
                "stylePlan": {"selector": selector, "rules": [
                    {"ruleId": r['id'], "disposition": "not_applicable" if r['id'] in conditional else "planned",
                     "shotIds": [] if r['id'] in conditional else ['s1'],
                     "treatment": "测试没有此条件" if r['id'] in conditional else "测试方案里的处理"} for r in spec['rules']],
                    "referenceChecks": [{"referenceId": spec['references'][0]['id'], "location": "test fixture",
                                         "observation": "仅测试格式，未实际播放", "adaptation": "测试设计"}],
                    "contrastReview": "合成测试，不作审美结论"}}
        for i, rid in enumerate(spec['storyboard_contract']['visual_rule_ids']):
            plan['shots'][0]['design'].append({"id": f"d{i}", "ruleIds": [rid], "purpose": "测试语义推进",
                "trigger": "动作开始", "phases": "入场后切换重点并退出", "durationSeconds": 3,
                "placement": "主体旁，动作结束前退场", "sound": "轻提示音", "implementation": "可编辑文字",
                "fallback": "同一语义的指示线"})
        return spec, run, media, plan

    def implement(self, run, plan):
        evidence = run / 'timeline-readback.txt'
        evidence.write_text('Synthetic timeline evidence; not real media.')
        beat = studio.load_run(run)['beats'][0]
        beat.update(shot_id='s1', design_results=[{
            'design_id': d['id'], 'status': 'implemented', 'item_ids': [f"item-{d['id']}"],
            'from_frame': i * 90, 'to_frame': i * 90 + 75, 'observations': 'synthetic implementation',
            'evidence_files': [{'path': str(evidence), 'sha256': studio.file_hash(evidence)}]
        } for i, d in enumerate(plan['shots'][0]['design'])])
        studio.record(run, 'beat', beat)
        return beat

    def review_all(self, run, media, plan):
        for key in self.report(run, media)['review_pending']:
            self.record_pass(run, key, style=plan['stylePlan']['selector'],
                             style_plan_sha256=studio.load_run(run)['style_plan']['sha256'],
                             rules={r['ruleId']: {'result': 'not_applicable' if r['disposition']=='not_applicable' else 'pass',
                                                  'observations': 'synthetic comparison'} for r in plan['stylePlan']['rules']})

    def test_both_styles_need_core_motion_but_not_every_conditional_technique(self):
        for kind in ('hot-news', 'technical-explainer'):
            with self.subTest(style=kind):
                spec, run, media, plan = self.planned(kind)
                missing = copy.deepcopy(plan); missing['shots'][0]['design'] = []
                with self.assertRaisesRegex(ValueError, '核心视觉'):
                    studio.record(run, 'style_plan', missing)
                studio.record(run, 'style_plan', plan)
                self.implement(run, plan)
                self.review_all(run, media, plan)
                self.assertTrue(self.report(run, media)['completed'])

    def test_no_design_record_cannot_pass_even_with_rule_checkmarks(self):
        _, run, media, plan = self.planned()
        studio.record(run, 'style_plan', plan)
        self.review_all(run, media, plan)
        result = self.report(run, media)
        self.assertFalse(result['completed'])
        self.assertIn('style_match', result['review_pending'])
        self.assertTrue(any('style_design_missing' in e for e in result['failures']))

    def test_v8_requires_a_plan_even_in_terminal_workflow(self):
        _, run, media, _ = self.planned()
        self.assertIn('style_plan_missing', self.report(run, media)['failures'])

    def test_rule_omission_wrong_version_unknown_shot_and_core_skip_rejected(self):
        spec, run, _, plan = self.planned()
        changes = []
        p = copy.deepcopy(plan); p['stylePlan']['rules'].pop(); changes.append(p)
        p = copy.deepcopy(plan); p['stylePlan']['selector'] = 'henry-hot-news@7'; changes.append(p)
        p = copy.deepcopy(plan); p['stylePlan']['rules'][0]['shotIds'] = ['not-a-shot']; changes.append(p)
        p = copy.deepcopy(plan)
        row = next(r for r in p['stylePlan']['rules'] if r['ruleId']==spec['storyboard_contract']['core_rule_ids'][0])
        row.update(disposition='not_applicable', shotIds=[]); changes.append(p)
        p = copy.deepcopy(plan); p['stylePlan']['rules'][0]['disposition'] = 'overridden'; changes.append(p)
        for changed in changes:
            with self.assertRaises(ValueError): studio.record(run, 'style_plan', changed)

    def test_duplicate_design_out_of_range_and_changed_evidence_are_not_completion(self):
        _, run, media, plan = self.planned()
        studio.record(run, 'style_plan', plan)
        beat = self.implement(run, plan)
        original = copy.deepcopy(beat)
        beat['design_results'][0]['to_frame'] = 4501
        studio.record(run, 'beat', beat)
        self.assertTrue(any('style_design_unverified' in e for e in self.report(run, media)['failures']))
        beat = copy.deepcopy(original); beat['design_results'].append(copy.deepcopy(beat['design_results'][0]))
        studio.record(run, 'beat', beat)
        self.assertTrue(any('duplicate_design' in e for e in self.report(run, media)['failures']))
        studio.record(run, 'beat', original)
        (run/'timeline-readback.txt').write_text('changed')
        self.assertTrue(any('style_design_unverified' in e for e in self.report(run, media)['failures']))

    def test_substitution_requires_reason_and_current_plan_hash(self):
        _, run, media, plan = self.planned()
        studio.record(run, 'style_plan', plan)
        beat = self.implement(run, plan)
        beat['design_results'][0]['status'] = 'substituted'
        studio.record(run, 'beat', beat)
        self.assertFalse(self.report(run, media)['technical_pass'])
        beat['design_results'][0]['substitution_reason'] = '测试等效替代，保留状态变化'
        studio.record(run, 'beat', beat)
        self.review_all(run, media, plan)
        self.assertTrue(self.report(run, media)['completed'])
        data = studio.load_run(run); data['reviews']['style_match']['style_plan_sha256'] = 'f'*64
        studio.write(run/'run.json', data)
        self.assertIn('style_match', self.report(run, media)['review_pending'])

    def test_approval_binds_readable_design_and_structured_plan(self):
        _, run, _, plan = self.planned()
        payload = {'run':str(run), 'plan':plan, 'inputHash':'a'*64}
        saved = web_bridge.save_plan(payload)
        approval = {'run':str(run), 'planHash':saved['file_sha256'], 'inputHash':'a'*64}
        web_bridge.approve(approval)
        self.assertIn('进入 / 变化 / 退出', Path(saved['file']).read_text())
        self.assertEqual(web_bridge.check_approval(approval)['status'], 'confirmed')
        plan['shots'][0]['design'][0]['sound'] = '改变音效落点'
        changed = web_bridge.save_plan(payload)
        self.assertNotEqual(saved['file_sha256'], changed['file_sha256'])
        self.assertEqual(changed['status'], 'awaiting_confirmation')
        approval['planHash'] = changed['file_sha256']
        web_bridge.approve(approval)
        raw = studio.read(run/'workbench-plan.json'); raw['shots'][0]['design'] = []
        studio.write(run/'workbench-plan.json', raw)
        with self.assertRaisesRegex(ValueError, '结构化方案'): web_bridge.check_approval(approval)

    def test_narrative_only_and_unstyled_plans_do_not_require_effects(self):
        spec = fixtures.StyleTests.spec(self)
        styles.register(spec)
        run, _ = self.fixture('sample@1')
        plan = {'shots':[{'id':'s1','from':0,'to':180,'design':[]}], 'stylePlan':{
            'selector':'sample@1','rules':[{'ruleId':'structure','disposition':'planned','shotIds':['s1'],'treatment':'提出问题后回答'}],
            'referenceChecks':[{'referenceId':'r1','location':'paragraph 1','observation':'读取脚本','adaptation':'替换本题问题'}],
            'contrastReview':'以因果推进，不添加动效'}}
        studio.record(run, 'style_plan', plan)
        unstyled, _ = self.fixture()
        plan['stylePlan'] = None
        style_plan.validate(plan, studio.load_run(unstyled))

    def test_contract_ids_cannot_turn_core_rules_into_optional_techniques(self):
        spec, _, _, _ = self.planned()
        spec['storyboard_contract']['conditional_rules'].append({'rule_id':'rich-edit-design','when':'skip'})
        with self.assertRaisesRegex(ValueError,'Core rules'): styles.validate(spec)


if __name__ == '__main__':
    unittest.main()
