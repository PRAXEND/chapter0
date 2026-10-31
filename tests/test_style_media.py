import copy
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugins/video-studio/scripts'))
import studio
import style_media
import web_bridge


class StyleMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='style-pack path ')
        self.root = Path(self.temp.name)
        self.pack = self.root / 'user-packs' / 'henry-video-styles'
        self.pack.mkdir(parents=True)
        self.env = patch.dict(os.environ, {'VIDEO_STUDIO_HOME': str(self.root/'user'), 'VIDEO_STUDIO_PACK_ROOT': str(self.pack.parent)})
        self.env.start()
        self.files = {}; rows = []
        for slug in ('hot-news', 'technical-explainer'):
            spec = 'styles/henry-' + slug + '-v8.json'
            self.put(spec, json.dumps({'id': 'henry-' + slug, 'version': 8}).encode())
            for name in (f'media/{slug}/clip.mp4', f'media/references/{slug}.mp4', f'media/benchmarks/{slug}.mp4'):
                payload = ('synthetic fixture '+name).encode(); self.put(name, payload)
                rows.append({'path': name, 'style': slug, 'sha256': self.files[name], 'bytes': len(payload)})
            self.put(f'reproduction/{slug}/motion.jsx', b'synthetic source, never executed')
        self.put('manifest.json', json.dumps({'schema_version': 1, 'id': 'henry-video-styles', 'version': 2,
                 'styles': ['styles/henry-hot-news-v8.json', 'styles/henry-technical-explainer-v8.json']}).encode())
        self.put('resources.json', json.dumps({'schema_version': 1, 'files': rows}).encode())
        self.index()

    def tearDown(self): self.env.stop(); self.temp.cleanup()
    def put(self, name, content):
        file = self.pack/name; file.parent.mkdir(exist_ok=True, parents=True); file.write_bytes(content)
        self.files[name] = hashlib.sha256(content).hexdigest()
    def index(self): (self.pack/'checksums.json').write_text(json.dumps({'algorithm': 'sha256', 'files': self.files}))
    def checks(self, style='henry-hot-news@8'):
        return {r['id']: r for r in style_media.check_media(style)}
    def hot(self): return self.checks()['style_media_hot_news']

    def test_full_pack_checks_real_bytes_without_executing_pack_scripts(self):
        (self.pack/'verify.py').write_text("raise RuntimeError('must never execute')")
        rows = self.checks()
        self.assertTrue(all(row['ok'] for row in rows.values()))
        self.assertTrue(rows['style_media_hot_news']['required'])
        self.assertFalse(rows['style_media_technical_explainer']['required'])
        self.assertEqual(self.hot()['verifiedFiles'], 5)

    def test_missing_pointer_same_size_corruption_and_size_change_are_distinct(self):
        file = self.pack/'media/hot-news/clip.mp4'; original = file.read_bytes()
        file.unlink(); self.assertEqual(self.hot()['issues'][0]['status'], 'missing')
        file.write_bytes(style_media.POINTER+b'\noid sha256:'+b'a'*64+b'\nsize 123\n')
        self.assertEqual(self.hot()['issues'][0]['status'], 'lfs_pointer')
        file.write_bytes(b'x'*len(original)); self.assertEqual(self.hot()['issues'][0]['status'], 'hash_mismatch')
        file.write_bytes(b'short'); self.assertEqual(self.hot()['issues'][0]['status'], 'hash_mismatch')
        file.write_bytes(original); self.assertTrue(self.hot()['ok'])

    def test_other_style_failure_does_not_block_selected_style_and_no_style_is_optional(self):
        (self.pack/'media/technical-explainer/clip.mp4').unlink()
        rows = self.checks()
        self.assertTrue(rows['style_media_hot_news']['ok'])
        self.assertFalse(rows['style_media_technical_explainer']['ok'])
        self.assertTrue(all(row['ok'] or not row['required'] for row in rows.values()))
        self.assertTrue(all(not row['required'] for row in self.checks(None).values()))
        self.assertTrue(all(not row['required'] for row in self.checks('another@1').values()))

    def test_original_reference_and_reproduction_source_are_required(self):
        for name in ('media/references/hot-news.mp4','media/benchmarks/hot-news.mp4','reproduction/hot-news/motion.jsx','styles/henry-hot-news-v8.json'):
            file=self.pack/name; content=file.read_bytes();file.unlink()
            self.assertTrue(any(row['path']==name for row in self.hot()['issues']))
            file.write_bytes(content)

    def test_bad_indexes_and_incomplete_media_coverage_fail_closed(self):
        original=(self.pack/'checksums.json').read_bytes()
        for bad in ({'algorithm':'sha256','files':{}},{'algorithm':'md5','files':self.files},{'algorithm':'sha256','files':{'../outside':'a'*64}}):
            (self.pack/'checksums.json').write_text(json.dumps(bad));self.assertFalse(self.hot()['ok'])
        (self.pack/'checksums.json').write_bytes(original)
        resources=json.loads((self.pack/'resources.json').read_text());resources['files'].pop()
        self.put('resources.json',json.dumps(resources).encode());self.index()
        self.assertFalse(self.hot()['ok'])

    def test_changed_metadata_and_symlink_media_cannot_pass(self):
        file=self.pack/'media/hot-news/clip.mp4';outside=self.root/'external.mp4';outside.write_bytes(file.read_bytes())
        file.unlink();file.symlink_to(outside);self.assertFalse(self.hot()['ok'])
        file.unlink();file.write_bytes(outside.read_bytes())
        (self.pack/'resources.json').write_text('{}');self.assertFalse(self.hot()['ok'])

    def test_missing_pack_has_actionable_location_and_download_guidance(self):
        with patch.dict(os.environ, {'VIDEO_STUDIO_PACK_ROOT':str(self.root/'absent')}):
            row=self.hot()
        self.assertFalse(row['ok']);self.assertIn('link-pack',row['remedy']);self.assertIn('git lfs pull',row['remedy'])
        self.assertTrue(row['issues'])

    def test_saved_location_survives_plugin_cache_and_can_be_relinked_after_move(self):
        before = studio.profile()
        linked=style_media.link_pack(self.pack/'manifest.json')
        self.assertFalse(linked['styles_modified']);self.assertEqual(studio.profile(),before)
        self.assertFalse((self.root/'user'/'styles').exists())
        with patch.dict(os.environ,{'VIDEO_STUDIO_PACK_ROOT':''}),patch.object(style_media,'PLUGIN',self.root/'cache'/'plugin'):
            self.assertTrue(self.hot()['ok'])
            moved=self.root/'moved-pack';self.pack.rename(moved)
            self.assertFalse(self.hot()['ok'])
            style_media.link_pack(moved/'manifest.json');self.assertTrue(self.hot()['ok'])

    def test_explicit_location_does_not_silently_use_a_different_registered_pack(self):
        style_media.link_pack(self.pack/'manifest.json')
        with patch.dict(os.environ,{'VIDEO_STUDIO_PACK_ROOT':str(self.root/'wrong')}):
            self.assertFalse(self.hot()['ok'])

    def test_pull_hint_quotes_repository_paths_and_never_overwrites_local_changes(self):
        (self.root/'.git').mkdir();(self.pack/'media/hot-news/clip.mp4').unlink()
        row=self.hot()
        self.assertEqual(shlex.split(row['commands'][1]),['git','-C',str(self.root),'lfs','pull','--include=user-packs/henry-video-styles/media/**'])
        (self.pack/'media/hot-news/clip.mp4').write_bytes(b'edited')
        self.assertIn('先备份',self.hot()['remedy'])

    def test_git_lfs_missing_broken_timeout_and_available(self):
        with patch.object(style_media.shutil,'which',return_value=None): self.assertFalse(style_media.git_lfs_check()['ok'])
        for outcome in (subprocess.CompletedProcess([],1,'',''),subprocess.TimeoutExpired('git',8),subprocess.CompletedProcess([],0,'unexpected output','')):
            with patch.object(style_media.shutil,'which',return_value='/git'),patch.object(style_media.subprocess,'run',**({'side_effect':outcome} if isinstance(outcome,Exception) else {'return_value':outcome})):
                row=style_media.git_lfs_check();self.assertFalse(row['ok']);self.assertFalse(row['required']);self.assertIn('remedy',row)
        with patch.object(style_media.shutil,'which',return_value='/git'),patch.object(style_media.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'git-lfs/3.8.1 (GitHub; darwin arm64)','')):
            self.assertEqual(style_media.git_lfs_check()['version'],'3.8.1')

    def test_cli_bridge_preflight_gates_only_selected_style_and_existing_media_needs_no_lfs(self):
        # Isolate dependency detection; real file verification remains active.
        doctor={'stdlib':{},'executable_checks':{'ffmpeg':{'ok':True},'ffprobe':{'ok':True},'yt-dlp':{'ok':False},'node':{'ok':False},'deno':{'ok':False}},
                'diagnostic_filters_available':True,'python_version':'3.12','python':sys.executable,'programs':{}}
        with patch.object(studio,'doctor',return_value=doctor),patch.object(style_media,'git_lfs_check',return_value={'id':'git_lfs','ok':False,'required':False}):
            req={'capabilities':['media'],'styleSelector':'henry-hot-news@8','packRoot':str(self.pack)}
            self.assertTrue(web_bridge.ACTIONS['preflight'](req)['ready'])
            (self.pack/'media/hot-news/clip.mp4').unlink()
            self.assertFalse(web_bridge.ACTIONS['preflight'](req)['ready'])
            self.assertTrue(web_bridge.ACTIONS['preflight']({**req,'styleSelector':None})['ready'])
            self.assertTrue(web_bridge.ACTIONS['preflight']({**req,'styleSelector':'henry-technical-explainer@8'})['ready'])
