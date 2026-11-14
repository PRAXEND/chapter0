"""Bridge/policy integration with synthetic tool/probe records; no pixel approval."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugins/video-studio/scripts'))
import quality_policy
import studio
import web_bridge
import test_portrait_evidence as fixtures


class PortraitReviewPathTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PortraitEvidenceTests(); self.fixture.setUp()
        self.root, self.data, self.evidence = self.fixture.root, self.fixture.data, self.fixture.evidence
        self.data.update(schema_version=2, creation_rules=2, revision=7, reviews={}, history=[], beats=[],
                         brief=dict(requirements=dict(review_policy=quality_policy.POLICY)))
        self.data['settings'].update(narration=False, captions=False)
        self.evidence['timeline']['state'] = dict(fps=30, durationFrames=300)
        self.evidence['timeline']['timeline']['tracks'] = [
            dict(id=self.fixture.ids['bg_track'], type='video', order=0, muted=False),
            dict(id=self.fixture.ids['end_track'], type='video', order=1, muted=False)]
        studio.write(self.root / 'run.json', self.data)
        studio.write(self.root / 'review-evidence.json', self.evidence)
        self.artifact = 'a' * 64
        sheet = self.root / 'synthetic-contact-sheet.txt'; sheet.write_text('Protocol fixture, not pixels')
        common = dict(policy=quality_policy.POLICY, artifact_sha256=self.artifact, revision=7)
        manifest = dict(common, timeline_complete=True, contact_sheets=[dict(id='all', **self.fixture.proof(sheet))])
        self.manifest = self.root / 'manifest.json'; studio.write(self.manifest, manifest)
        self.metrics = self.root / 'metrics.json'; studio.write(self.metrics, dict(common, requirement_errors={}))
        self.probe = dict(artifact_sha256=self.artifact, subtitle_sha256=None, revision=7, frames=300,
                         manifest=str(self.manifest), metrics=str(self.metrics),
                         evidence_files=[self.fixture.proof(self.manifest), self.fixture.proof(self.metrics),
                                         self.fixture.proof(self.root / 'review-evidence.json')])
        self.probe['evidence_files'] += self.fixture.check()['evidence_files']
        studio.write(self.root / 'quality-probe.json', self.probe)

    def tearDown(self):
        self.fixture.tearDown()

    def review(self, check):
        rows = ([dict(feature=x, frames=[0, 150], observations='Synthetic protocol only')
                 for x in ['spacing', 'title_color', 'background']] if check == 'portrait_layout'
                else [dict(feature='ending', frames=[264, 282, 299], observations='Synthetic fade/hold protocol')])
        return dict(check=check, result='pass', method=quality_policy.METHODS[check],
                    reviewer='independent-thread', reviewer_job_id='review-job', producer_job_id='producer-job',
                    evidence='Protocol fixture', observations='Protocol fixture', artifact_sha256=self.artifact,
                    subtitle_sha256=None, coverage_frames=[0, 300], observed_sheets=['all'], issues=[],
                    probe_sha256=studio.file_hash(self.manifest), evidence_files=self.probe['evidence_files'],
                    presentation_observations=rows)

    def record(self, review):
        return web_bridge.ACTIONS['record-review'](dict(run=str(self.root), review=review))

    def test_valid_preflight_and_both_review_checks_pass_recording(self):
        self.assertTrue(web_bridge.check_presentation(dict(run=str(self.root)))['checked'])
        for check in ['portrait_layout', 'transitions']:
            result = self.record(self.review(check))
            self.assertEqual(result['reviews'][check]['result'], 'pass')

    def test_missing_observations_and_no_fade_frames_cannot_be_recorded_pass(self):
        layout = self.review('portrait_layout'); layout['presentation_observations'].pop()
        with self.assertRaisesRegex(studio.StudioError, 'portrait_background_observations_missing'):
            self.record(layout)
        ending = self.review('transitions'); ending['presentation_observations'][0]['frames'] = [0, 299]
        with self.assertRaisesRegex(studio.StudioError, 'portrait_ending_frame_evidence_invalid'):
            self.record(ending)

    def test_changed_raw_readback_invalidates_the_probe_and_preflight(self):
        file = self.root / 'background-item.txt'; file.write_text('replacement readback')
        self.assertFalse(web_bridge.check_presentation(dict(run=str(self.root)))['checked'])
        with self.assertRaisesRegex(studio.StudioError, 'Pass needs|quality_probe_missing_or_stale'):
            self.record(self.review('portrait_layout'))

    def test_objective_presentation_error_cannot_be_overridden_by_pass_claim(self):
        metrics = studio.read(self.metrics); metrics['requirement_errors'] = dict(portrait_layout='Invalid actual background')
        studio.write(self.metrics, metrics)
        self.probe['evidence_files'] = [self.fixture.proof(Path(x['path'])) for x in self.probe['evidence_files']]
        studio.write(self.root / 'quality-probe.json', self.probe)
        with self.assertRaisesRegex(studio.StudioError, 'Invalid actual background'):
            self.record(self.review('portrait_layout'))

    def test_horizontal_preflight_does_not_require_portrait_evidence(self):
        self.data['settings'].update(width=1920, height=1080)
        studio.write(self.root / 'run.json', self.data)
        (self.root / 'review-evidence.json').unlink()
        self.assertEqual(web_bridge.check_presentation(dict(run=str(self.root)))['status'], 'not_applicable')


if __name__ == '__main__':
    unittest.main()
