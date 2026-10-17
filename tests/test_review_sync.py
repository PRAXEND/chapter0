from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugins/robot-video-studio/scripts'))
import review_sync as r


def clip(first, last, start=0, end=30, id='clip'):
    return {'id': id, 'asset': {'id': 'voice'}, 'sourceRange': {'start': first, 'end': last},
            'timelineRange': {'fromFrame': start, 'toFrame': end}}


class SyncTests(unittest.TestCase):
    def test_projects_offset_and_rate_ignores_silence(self):
        sources = {'voice': [{'startMs': 1100, 'endMs': 1500, 'text': '机器人'},
                             {'startMs': 1500, 'endMs': 2000, 'text': '[0.50 seconds silent]'}]}
        words, issues = r.project_words([clip(1000000, 3000000, 60, 90)], sources)
        self.assertEqual([], issues)
        self.assertEqual(1, len(words))
        self.assertAlmostEqual(2.05, words[0]['start'])
        self.assertAlmostEqual(2.25, words[0]['end'])

    def test_subframe_word_leak_is_not_hidden(self):
        sources = {'voice': [{'startMs': 5340, 'endMs': 5500, 'text': '训'}]}
        words, issues = r.project_words([clip(4179999, 5346667, 0, 35), clip(5340000, 6506667, 35, 70, 'next')], sources)
        self.assertEqual(2, len(words))
        self.assertIn('partial_word', [x['kind'] for x in issues])
        self.assertIn('repeated_source_word', [x['kind'] for x in issues])

    def test_cut_at_word_boundary_does_not_duplicate(self):
        words, issues = r.project_words([clip(0, 1000000), clip(1000000, 2000000, 30, 60)],
            {'voice': [{'startMs': 0, 'endMs': 1000, 'text': '一'}, {'startMs': 1000, 'endMs': 2000, 'text': '二'}]})
        self.assertEqual('一二', ''.join(w['text'] for w in words))
        self.assertEqual([], issues)

    def test_tail_and_early_exit_fail(self):
        for end in (1.5, .5):
            result = r.check_captions([{'start': 0, 'end': end, 'lines': ['一']}], [{'start': 0, 'end': 1, 'text': '一'}])
            self.assertEqual([1], result['outside_target'])

    def test_frame_rounding_is_reported_without_hiding_strict_excess(self):
        result = r.check_captions([{'start': 0, 'end': 1.203, 'lines': ['一']}], [{'start': 0, 'end': 1, 'text': '一'}])
        self.assertEqual([1], result['outside_target'])
        self.assertEqual([], result['outside_frame_tolerance'])
        self.assertEqual(203, result['max_tail_ms'])

    def test_text_mismatch_withholds_timing(self):
        result = r.check_captions([{'start': 0, 'end': 1, 'lines': ['工人']}], [{'start': 0, 'end': 1, 'text': '工件'}])
        self.assertFalse(result['coverage_complete'])
        self.assertEqual([], result['cues'])

    def test_punctuation_and_wrapping_do_not_change_coverage(self):
        result = r.check_captions([{'start': 0, 'end': 1.2, 'lines': ['NEURA，', '机器人。']}],
            [{'start': .1, 'end': .5, 'text': 'NEURA'}, {'start': .5, 'end': 1, 'text': '机器人'}])
        self.assertTrue(result['coverage_complete'])
        self.assertEqual([], result['outside_target'])

    def test_clipped_edge_flash_detected(self):
        shots = r.shot_fragments(clip(9800000, 15000000, 0, 156), [10, 13])
        self.assertEqual([True, False, False], [s['short_candidate'] for s in shots])
        self.assertAlmostEqual(.2, shots[0]['duration_seconds'])

    def test_internal_montage_and_playback_rate(self):
        shots = r.shot_fragments(clip(0, 4000000, 0, 60), [2, 2.5])
        self.assertEqual([False, True, True], [s['short_candidate'] for s in shots])

    def test_exact_threshold_is_not_float_rounding_flash(self):
        shot = r.shot_fragments(clip(50880000, 51680000, 1499, 1523), [])[0]
        self.assertFalse(shot['short_candidate'])
        shorter = r.shot_fragments(clip(50880000, 51646667, 1499, 1522), [])[0]
        self.assertTrue(shorter['short_candidate'])

    def test_card_export_discrepancy_detected(self):
        cards = r.parse_cards('[C0] id=abc frame=3-33 text="机器人" layoutLines=["机器人"]')
        self.assertTrue(r.compare_cards([{'start': .1, 'end': 1.1, 'lines': ['机器人']}], cards)['matches'])
        self.assertFalse(r.compare_cards([{'start': .1, 'end': 1.5, 'lines': ['机器人']}], cards)['matches'])

    def test_transition_reads_prior_shot_outside_visible_range(self):
        item = dict(clip(10000000, 12000000, 60, 120), itemType='video', kind='item')
        transition = {'id': 't', 'kind': 'transition', 'incomingItemId': 'clip',
                      'timelineRange': {'fromFrame': 54, 'toFrame': 66}}
        issues = r.transition_handles([item, transition], {'voice': [10]})
        self.assertEqual('head', issues[0]['side'])
        item['sourceRange'] = {'start': 10200000, 'end': 12200000}
        self.assertEqual([], r.transition_handles([item, transition], {'voice': [10]}))

    def test_transition_reads_next_shot_after_visible_range(self):
        item = dict(clip(10000000, 11900000, 0, 57), itemType='video', kind='item')
        transition = {'id': 't', 'kind': 'transition', 'outgoingItemId': 'clip',
                      'timelineRange': {'fromFrame': 51, 'toFrame': 63}}
        issues = r.transition_handles([item, transition], {'voice': [12]})
        self.assertEqual('tail', issues[0]['side'])
        item['sourceRange'] = {'start': 9800000, 'end': 11700000}
        self.assertEqual([], r.transition_handles([item, transition], {'voice': [12]}))

    def test_partial_timeline_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'all timeline pages'):
            r.review({'timeline': {'timeline': {'entries': [], 'totalEntries': 60}}}, [], {})

    def test_visual_must_survive_whole_clause_and_hold(self):
        words = [{'text': '有没有', 'start': 6, 'end': 7}, {'text': '接牢', 'start': 7, 'end': 8.8}]
        item = {'kind': 'item', 'itemType': 'video', 'id': 'shot',
                'timelineRange': {'fromFrame': 60, 'toFrame': 243}}
        anchor = {'phrase': '有没有接牢', 'visual_item_ids': ['shot'], 'hold_ms': 100,
                  'visual_basis': 'Inspected connector joining action'}
        result = r.semantic_anchors(words, [item], [anchor])
        self.assertFalse(result['checks'][0]['timing_covered'])
        item['timelineRange']['toFrame'] = 286
        self.assertTrue(r.semantic_anchors(words, [item], [anchor])['checks'][0]['timing_covered'])

    def test_multiple_angles_may_cover_action_but_gap_fails(self):
        words = [{'text': '接牢', 'start': 1, 'end': 3}]
        items = [{'kind': 'item', 'itemType': 'video', 'id': str(i),
                  'timelineRange': {'fromFrame': a, 'toFrame': b}} for i, (a, b) in enumerate([(0,60),(60,100)])]
        anchor = {'phrase': '接牢', 'visual_item_ids': ['0','1'], 'visual_basis': 'Same action, two angles'}
        self.assertEqual([], r.semantic_anchors(words, items, [anchor])['issues'])
        items[1]['timelineRange']['fromFrame'] = 61
        self.assertTrue(r.semantic_anchors(words, items, [anchor])['issues'])

    def test_repeated_phrase_requires_occurrence(self):
        words = [{'text': '接牢', 'start': 1, 'end': 2}, {'text': '接牢', 'start': 3, 'end': 4}]
        item = {'kind': 'item', 'itemType': 'video', 'id': 'shot', 'timelineRange': {'fromFrame': 0, 'toFrame': 150}}
        anchor = {'phrase': '接牢', 'visual_item_ids': ['shot'], 'visual_basis': 'Connector'}
        self.assertEqual('unresolved_phrase', r.semantic_anchors(words, [item], [anchor])['issues'][0]['kind'])
        anchor['occurrence'] = 2
        self.assertEqual(3, r.semantic_anchors(words, [item], [anchor])['checks'][0]['speech_start'])

    def test_missing_semantic_evidence_is_not_a_pass(self):
        self.assertEqual('unverified', r.semantic_anchors([], [], [])['status'])
        with self.assertRaises(ValueError):
            r.semantic_anchors([], [], [{'phrase': '接牢', 'visual_item_ids': ['unknown']}])

    def test_voice_direction_drift_even_with_same_voice(self):
        sources = [{'assetId': str(i), 'data': [{'asset': {'generationRecord': {'params': {
            'voiceId': 'chosen', 'speedRatio': speed, 'performancePrompt': prompt}}}}]}
            for i, (speed, prompt) in enumerate([(.8, 'natural'), (1, 'animated')])]
        result = r.voice_controls(sources)
        self.assertFalse(result['recorded_controls_match'])
        self.assertEqual({'speedRatio', 'performancePrompt'}, set(result['differences'][0]['changes']))

    def test_voice_text_and_job_nonce_are_not_voice_settings(self):
        sources = [{'assetId': str(i), 'data': [{'asset': {'generationRecord': {'params': {
            'voiceId': 'chosen', 'speedRatio': .8, 'text': str(i), 'creditReservationId': str(i)}}}}]}
            for i in range(2)]
        self.assertTrue(r.voice_controls(sources)['recorded_controls_match'])
        sources.append({'assetId': 'missing', 'data': []})
        self.assertFalse(r.voice_controls(sources)['recorded_controls_match'])


if __name__ == '__main__':
    unittest.main()
