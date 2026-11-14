"""Raw tool readbacks must describe the exact recipe and placed instances."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugins/video-studio/scripts'))
import portrait_design
import portrait_evidence


class PortraitEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.ids = {name: value for name, value in zip(
            ['timeline', 'background', 'ending', 'bg_asset', 'end_asset', 'bg_track', 'end_track'],
            ['12345678-1234-1234-1234-123456789abc', '22345678-1234-1234-1234-123456789abc',
             '32345678-1234-1234-1234-123456789abc', '42345678-1234-1234-1234-123456789abc',
             '52345678-1234-1234-1234-123456789abc', '62345678-1234-1234-1234-123456789abc',
             '72345678-1234-1234-1234-123456789abc'])}
        settings = dict(width=1080, height=1920, fps=30, captions=True)
        recipe = portrait_design.build(settings, 300, 'Robot learns', 'learns')
        self.data = dict(settings=settings, project=dict(timelineId=self.ids['timeline']),
                         production_plan=dict(plan=dict(productionPlan=dict(layout=recipe['layout']))))
        self.evidence = dict(timeline_id=self.ids['timeline'], presentation={},
                             timeline=dict(timeline=dict(entries=[], totalEntries=2)))
        self.assets, self.item_text = {}, {}
        for role, index, aid, track, first in [('background', 0, 'bg_asset', 'bg_track', 0), ('ending', 2, 'end_asset', 'end_track', 246)]:
            asset = dict(id=self.short(aid), type='motion-graphic', revision='sha256:' + str(index + 1) * 64,
                         code=recipe['assets'][index]['code'])
            props = dict(left=0, top=0, width=1080, height=1920, opacity=1, rotation=0,
                         fadeIn=0, fadeOut=0, durationInFrames=300-first, **{'from': first})
            effective = {p['key']: p['defaultValue'] for p in recipe['assets'][index]['properties']}
            self.evidence['timeline']['timeline']['entries'].append(dict(kind='item', itemType='motion-graphic',
                id=self.ids[role], trackId=self.ids[track], asset=dict(id=self.ids[aid]),
                timelineRange=dict(fromFrame=first, toFrame=300), properties=props))
            self.item_text[role] = '\n'.join([
                'Timeline: Accepted draft [' + self.short('timeline') + ']', 'Item: ' + self.short(role),
                f'Type: motion-graphic | Track: V1 [{self.short(track)}] | from={first} durationInFrames={300-first} endExclusive=300 visibleFrames={first}..299',
                'Asset: [' + self.short(aid) + '] Actual generated asset', '', 'Motion Graphic Effective Props:',
                *['  ' + k + '=' + json.dumps(v) + ' (default)' for k, v in effective.items()], '',
                'Properties:', *['  ' + k + ': ' + json.dumps(v) for k, v in props.items()], ''])
            self.assets[role] = dict(asset=asset)
            self.evidence['presentation'][role] = dict(item_id=self.ids[role], asset_id=self.ids[aid],
                asset_revision=asset['revision'], effective_properties=effective, readback_files=[])
        self.write_files()

    def tearDown(self):
        self.temp.cleanup()

    def short(self, key):
        return self.ids[key].replace('-', '')[:10]

    def proof(self, path):
        return dict(path=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest())

    def write_files(self):
        for role in ['background', 'ending']:
            asset_file, item_file = self.root / (role + '-asset.json'), self.root / (role + '-item.txt')
            asset_file.write_text(json.dumps(self.assets[role]))
            item_file.write_text(self.item_text[role])
            self.evidence['presentation'][role]['readback_files'] = [self.proof(asset_file), self.proof(item_file)]

    def check(self):
        return portrait_evidence.check(self.data, self.evidence, self.root, 300, 30)

    def test_real_tool_shape_binds_raw_files_and_compact_uuid(self):
        result = self.check()
        self.assertEqual(result['errors'], {})
        self.assertEqual(len(result['evidence_files']), 4)
        for role in ['background', 'ending']:
            self.evidence['presentation'][role]['item_id'] = self.ids[role].replace('-', '')
        self.assertEqual(self.check()['errors'], {})

    def test_mcp_asset_envelope_and_mixed_item_batch_are_supported(self):
        asset = self.assets['background']
        self.assets['background'] = dict(content=[dict(type='text', text=json.dumps(asset)), dict(type='text', text=json.dumps(asset))])
        self.item_text['background'] += '\n---\nTimeline: Same [1234567812]\nItem: 8234567812\nType: audio | Track: A1 [9234567812]\n'
        self.write_files()
        self.assertEqual(self.check()['errors'], {})

    def test_declared_metadata_cannot_replace_raw_item_text_or_code(self):
        for replacement in ['unrelated file', json.dumps(self.evidence['timeline']['timeline']['entries'][0])]:
            with self.subTest(replacement=replacement[:20]):
                old = self.item_text['background']
                self.item_text['background'] = replacement; self.write_files()
                self.assertIn('portrait_layout', self.check()['errors'])
                self.item_text['background'] = old
        for field in ['code', 'revision']:
            old = self.assets['background']['asset'].pop(field)
            self.write_files(); self.assertIn('portrait_layout', self.check()['errors'])
            self.assets['background']['asset'][field] = old
        self.assets['background']['asset']['code'] = 'const Component = () => <div/>;'
        self.write_files(); self.assertIn('portrait_layout', self.check()['errors'])

    def test_raw_properties_and_identity_are_not_taken_from_declarations(self):
        changes = [('speed=1', 'speed=0.65'), ('left: 0', 'left: 30'), ('opacity: 1', 'opacity: 0'),
                   ('rotation: 0', 'rotation: 20'), ('fadeOut: 0', 'fadeOut: 5'),
                   ('from=0 durationInFrames=300', 'from=1 durationInFrames=299'),
                   (self.short('timeline'), 'abcdefab12'), (self.short('bg_asset'), 'bcdefabc12'),
                   (self.short('bg_track'), 'cdefabcd12')]
        old = self.item_text['background']
        for a, b in changes:
            with self.subTest(change=b):
                self.item_text['background'] = old.replace(a, b)
                self.write_files(); self.assertIn('portrait_layout', self.check()['errors'])
        self.item_text['background'] = old
        self.item_text['ending'] = self.item_text['ending'].replace('fadeFrames=36', 'fadeFrames=1')
        self.write_files(); self.assertIn('transitions', self.check()['errors'])

    def test_current_timeline_declarations_must_match_raw_item(self):
        item = self.evidence['timeline']['timeline']['entries'][0]
        item['properties']['width'] = 1200
        self.assertIn('portrait_layout', self.check()['errors'])
        item['properties']['width'] = 1080
        self.evidence['presentation']['background']['asset_revision'] = 'sha256:' + 'f' * 64
        self.assertIn('portrait_layout', self.check()['errors'])

    def test_changed_and_outside_files_cannot_bind_evidence(self):
        file = self.root / 'background-item.txt'
        file.write_text(file.read_text() + '\nchanged')
        self.assertIn('portrait_layout', self.check()['errors'])
        self.write_files()
        with tempfile.TemporaryDirectory() as outside:
            target = Path(outside) / 'outside.txt'; target.write_text(self.item_text['background'])
            link = self.root / 'linked.txt'; link.symlink_to(target)
            self.evidence['presentation']['background']['readback_files'][1] = self.proof(link)
            self.assertIn('portrait_layout', self.check()['errors'])

    def test_missing_malformed_evidence_fails_without_crashing(self):
        for value in [None, {}, {'presentation': {'background': None}}, {'presentation': []}]:
            with self.subTest(value=value):
                result = portrait_evidence.check(self.data, value, self.root, 300, 30)
                self.assertEqual(set(result['errors']), {'portrait_layout', 'transitions'})
        self.data['production_plan']['plan']['productionPlan']['layout'] = dict(mode='unchanged')
        self.assertEqual(portrait_evidence.check(self.data, None, self.root, 300, 30), dict(errors={}, evidence_files=[]))


if __name__ == '__main__':
    unittest.main()
