import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

class ReleaseTests(unittest.TestCase):
    def test_verifier_rejects_lfs_pointers_missing_files_and_changed_content(self):
        check = module('verify_checkout')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            file = root / 'media.mp4'
            file.write_bytes(b'actual fixture')
            (root / 'release-manifest.json').write_text(json.dumps({'files': {'media.mp4': {'bytes': file.stat().st_size, 'sha256': check.digest(file)}}}))
            for content, message in [(b'version https://git-lfs.github.com/spec/v1\n', 'LFS pointer'), (b'changed', 'Changed bytes')]:
                file.write_bytes(content)
                with self.assertRaisesRegex(ValueError, message):check.verify(root)
            file.unlink()
            with self.assertRaisesRegex(ValueError, 'Missing/unsafe'):check.verify(root)

    def test_launcher_resolves_installed_copy_and_retains_explicit_dependency_paths(self):
        launch = module('run_workbench')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'plugins/video-studio'
            installed = root / 'installed plugin'
            source.mkdir(parents=True);installed.mkdir();(root / '.runtime').mkdir()
            for folder in [source, installed]:(folder / 'plugin.json').write_text(json.dumps({'name':'video-studio','version':'test'}))
            (root / '.runtime/plugin-install.json').write_text(json.dumps({'installedPath':str(installed)}))
            env={'PATH':'/test/bin','VIDEO_STUDIO_PYTHON':'/complete/python','VIDEO_DEMO_CODEX_BIN':'/selected/codex'}
            with patch.object(launch.shutil, 'which', return_value='/test/node'):
                command, actual=launch.launch_settings(root, env)
                self.assertEqual(command[1],str(installed.resolve() / 'scripts/open-workbench.mjs'))
                self.assertEqual(actual['VIDEO_STUDIO_PYTHON'],env['VIDEO_STUDIO_PYTHON'])
                self.assertEqual(actual['VIDEO_DEMO_CODEX_BIN'],env['VIDEO_DEMO_CODEX_BIN'])
                self.assertEqual(actual['VIDEO_STUDIO_PACK_ROOT'],str(root.resolve() / 'user-packs/henry-video-styles'))
                (installed / 'plugin.json').write_text(json.dumps({'name':'video-studio','version':'old'}))
                with self.assertRaisesRegex(ValueError, '版本不同'):launch.launch_settings(root, env)
