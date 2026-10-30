import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugins/video-studio/scripts'))
import styles
import studio
import web_styles


class WebStyleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'VIDEO_STUDIO_HOME': str(self.root / 'user'),
                                          'VIDEO_STUDIO_PACK_ROOT': str(self.root / 'packs')})
        self.env.start()
        self.pack = self.root / 'packs' / 'test-pack'
        (self.pack / 'evidence').mkdir(parents=True)
        (self.pack / 'styles').mkdir()
        self.evidence = {'records': [{'id': 'v1', 'title': 'Test-only reference', 'speaking': 'fixture analysis'}]}
        (self.pack / 'evidence' / 'analysis.json').write_text(json.dumps(self.evidence))
        self.spec = {'schema_version': 1, 'id': 'test-style', 'version': 1, 'name': 'Test-only style',
                     'description': 'Fixture; never shown in the real workbench', 'adaptation': 'Use actual topic evidence',
                     'references': [{'id': 'analysis', 'kind': 'script', 'locator': 'pack:evidence/analysis.json'},
                                    {'id': 'v1', 'kind': 'video', 'locator': 'https://example.com/reference', 'limitations': 'sample only'}],
                     'rules': [{'id': 'structure', 'dimension': 'narrative', 'instruction': 'Actual fixture instruction',
                                'check': 'Actual fixture check', 'basis': 'inferred',
                                'evidence': [{'reference_id': 'v1', 'location': '0–2 seconds'}]}],
                     'unknown_dimensions': sorted(styles.DIMENSIONS - {'narrative'}), 'material_requirements': []}
        (self.pack / 'styles' / 'one.json').write_text(json.dumps(self.spec))
        (self.pack / 'manifest.json').write_text(json.dumps({'schema_version': 1, 'id': 'test-pack', 'version': 1,
                                                            'styles': ['styles/one.json'], 'profile_patch': {'max_seconds': 60}}))

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_browse_reads_rules_cases_and_original_evidence_without_install(self):
        entry = web_styles.catalog()['entries'][0]
        detail = web_styles.details(entry['key'])
        self.assertEqual(detail['rules'], self.spec['rules'])
        self.assertEqual(detail['references'][1]['analysis']['speaking'], 'fixture analysis')
        self.assertEqual(detail['references'][1]['limitations'], 'sample only')
        self.assertEqual(json.loads(web_styles.reference(entry['key'], 'analysis')['text']), self.evidence)
        self.assertEqual(styles.catalog(), [])
        self.assertEqual(detail['validation_status'], 'unverified')

    def test_explicit_use_imports_evidence_without_preferences_and_pins_real_style(self):
        key = web_styles.catalog()['entries'][0]['key']
        before = studio.profile()
        selected = web_styles.select(key)
        self.assertEqual(selected['selector'], 'test-style@1')
        self.assertEqual(studio.profile(), before)
        detail = web_styles.details(selected['key'])
        self.assertEqual(detail['origin'], 'library')
        self.assertIn('Actual fixture instruction', detail['skill'])
        self.assertEqual(json.loads(web_styles.reference(selected['key'], 'analysis')['text']), self.evidence)
        run = studio.new_run('Pinned style', str(self.root / 'runs'), {'topic': 'actual topic', 'style': 'test-style@1',
                           'requirements': {'width': 1080, 'height': 1920, 'fps': 30, 'narration': False, 'captions': False, 'audio_required': False}})
        actual = studio.load_run(run['run'])
        self.assertEqual(actual['style_snapshot']['selector'], 'test-style@1')
        self.assertEqual(json.loads((Path(actual['style_snapshot']['skill_path']).parent / 'style.json').read_text())['rules'], self.spec['rules'])

    def test_versions_stay_distinct_and_only_older_is_historical(self):
        two = {**self.spec, 'version': 2}
        (self.pack / 'styles' / 'two.json').write_text(json.dumps(two))
        manifest = self.pack / 'manifest.json'
        value = json.loads(manifest.read_text()); value['styles'].append('styles/two.json'); manifest.write_text(json.dumps(value))
        entries = web_styles.catalog()['entries']
        self.assertEqual([e['historical'] for e in entries], [True, False])

    def test_unlisted_references_traversal_and_changed_library_are_rejected(self):
        key = web_styles.catalog()['entries'][0]['key']
        with self.assertRaises(ValueError):
            web_styles.reference(key, '../anything')
        with self.assertRaises(ValueError):
            web_styles.details('../../auth.json')
        self.spec['references'][0]['locator'] = 'pack:../outside.txt'
        (self.pack / 'styles' / 'one.json').write_text(json.dumps(self.spec))
        with self.assertRaises(ValueError):
            web_styles.reference(key, 'analysis')
        self.spec['references'][0]['locator'] = 'pack:evidence/analysis.json'
        (self.pack / 'styles' / 'one.json').write_text(json.dumps(self.spec))
        selected = web_styles.select(key)
        entry = styles.resolve(selected['selector'])
        Path(entry['skill_path']).write_text('tampered')
        self.assertEqual(web_styles.catalog()['entries'], [])
        self.assertTrue(web_styles.catalog()['errors'])


if __name__ == '__main__':
    unittest.main()
