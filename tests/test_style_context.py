import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugins/video-studio/scripts'))
import studio
import style_context
import quality_probe


class StyleContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.run = self.root / 'run'; self.folder = self.run / 'style'; self.folder.mkdir(parents=True)
        self.spec = {'id': 'sample', 'version': 1, 'rules': [{'id': 'visual', 'instruction': 'real rule'}],
                     'references': [], 'material_requirements': [{'role': 'action'}],
                     'storyboard_contract': {'core_rule_ids': ['visual']},
                     'reproduction_bundle': {'documents': {'recipe': 'relevant recipe'},
                                            'motion_graphics': {'huge_source': 'code' * 10000}}}
        (self.folder / 'SKILL.md').write_text('Actual style')
        self.snapshot()

    def snapshot(self):
        studio.write(self.folder / 'style.json', self.spec)
        self.saved = {'selector': 'sample@1', 'skill_path': str(self.folder / 'SKILL.md'),
                      'files': {n: studio.file_hash(self.folder / n) for n in ('SKILL.md', 'style.json')}}

    def tearDown(self):
        self.temp.cleanup()

    def test_compact_guide_preserves_every_rule_and_loads_code_only_on_demand(self):
        result = style_context.prepare(self.run, self.saved)
        guide = studio.read(result['guide'])
        self.assertEqual(guide['rules'], self.spec['rules'])
        self.assertEqual(guide['storyboard_contract'], self.spec['storyboard_contract'])
        self.assertNotIn('huge_source', Path(result['guide']).read_text())
        self.assertLess(Path(result['guide']).stat().st_size, 2000)
        (self.folder / 'style.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'changed'):
            style_context.prepare(self.run, self.saved)

    def test_real_reference_probe_is_cached_and_damaged_evidence_is_rebuilt(self):
        ffmpeg = studio.native_tool('ffmpeg')
        if not ffmpeg: self.skipTest('ffmpeg unavailable')
        pack = self.root / 'pack'; (pack / 'media').mkdir(parents=True)
        video = pack / 'media' / 'benchmark.mp4'
        subprocess.run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24',
                        '-t', '65', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(video)], check=True)
        self.spec['reproduction_bundle']['baseline'] = {'path': 'resource:media/benchmark.mp4', 'sha256': studio.file_hash(video)}
        self.snapshot()
        data = {'style_snapshot': self.saved}
        with patch.object(studio, 'load_run', return_value=data), patch.object(style_context.style_media, 'locate_pack', return_value=pack):
            first = style_context.reference_probe(self.run)
            self.assertEqual(first['frames'], 1560); self.assertEqual(first['fps'], 24)
            self.assertEqual([f for s in first['contact_sheets'] for f in s['frames']], [*range(0, 1560, 12), 1559])
            with patch.object(quality_probe, 'contact_sheets', side_effect=AssertionError('must reuse')):
                self.assertEqual(style_context.reference_probe(self.run)['sha256'], first['sha256'])
            Path(first['contact_sheets'][0]['path']).unlink()
            rebuilt = style_context.reference_probe(self.run)
            self.assertTrue(Path(rebuilt['contact_sheets'][0]['path']).is_file())
            video.write_bytes(b'changed source')
            with self.assertRaisesRegex(ValueError, 'changed'):
                style_context.reference_probe(self.run)

    def test_script_only_style_has_no_invented_visual_benchmark(self):
        with patch.object(studio, 'load_run', return_value={'style_snapshot': self.saved}):
            self.assertIsNone(style_context.reference_probe(self.run))
