import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class StyleDistributionTests(unittest.TestCase):
    def test_bundled_text_matches_published_sources_and_contains_no_media(self):
        spec = importlib.util.spec_from_file_location('bundle_style_packs', ROOT / 'tools/bundle_style_packs.py')
        module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        result = module.bundle(check=True)
        self.assertGreater(result['files'], 9)
        for path in (ROOT / 'plugins/video-studio/style-packs').rglob('*'):
            if path.is_file(): self.assertIn(path.suffix, {'.json', '.md', '.txt'})

    def test_installed_plugin_exposes_all_styles_without_source_checkout_or_import(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            plugin = temp / 'cache' / 'market' / 'plugin' / 'version'
            shutil.copytree(ROOT / 'plugins/video-studio', plugin, ignore=shutil.ignore_patterns('__pycache__'))
            env = {**os.environ, 'VIDEO_STUDIO_HOME': str(temp / 'user')}
            env.pop('VIDEO_STUDIO_PACK_ROOT', None)
            command = [sys.executable, str(plugin / 'scripts/studio.py'), 'styles']
            def cli(*args):
                return json.loads(subprocess.run(command + list(args), env=env, capture_output=True, text=True, check=True).stdout)
            choices = cli('choices')
            self.assertEqual(len(choices['options']), 9)
            self.assertEqual(len(choices['historical_options']), 2)
            self.assertFalse(choices['errors'])
            self.assertTrue(all(e['requires_import'] for e in choices['options']))
            self.assertEqual(cli('list', '--installed'), [])
            self.assertEqual(len([e for e in cli('list') if not e['historical']]), 9)
            detail = cli('details', '--selector', 'shawn-capability-brief@1')
            self.assertTrue(detail['rules']);self.assertTrue(any(r['readable'] for r in detail['references']))
            cli('select', '--selector', 'shawn-capability-brief@1')
            self.assertEqual(len(cli('list', '--installed')), 7)
            self.assertEqual(len(cli('choices')['options']), 9)
            self.assertFalse((temp / 'user/profile.json').exists())
            self.assertFalse((temp / 'user/user-packs/locations.json').exists())
            # Selecting a text-only bundled pack must not replace a complete media location.
            registry = temp / 'user/user-packs/locations.json'
            registry.write_text(json.dumps({'schema_version': 1, 'packs': {'henry-video-styles': str(temp / 'original-media')}}))
            before = registry.read_bytes()
            cli('select', '--selector', 'henry-hot-news@8')
            self.assertEqual(registry.read_bytes(), before)
            self.assertEqual(len(cli('list', '--installed')), 9)


if __name__ == '__main__': unittest.main()
