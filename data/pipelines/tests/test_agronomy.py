"""Safety regressions for incomplete agronomic evidence; no network requests."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from growwhere import agronomy


class AgronomyEvidenceTests(unittest.TestCase):
    def test_all_current_crops_keep_future_advice_null(self):
        for crop in ['corn', 'soy', 'sorghum', 'cotton', 'wheat', 'barley', 'oats']:
            with self.subTest(crop=crop):
                result = agronomy.assess_agronomic_readiness(crop)
                self.assertFalse(result['recommendation_supported'])
                self.assertTrue(result['blockers'])
                self.assertIsNone(result['recommended_sowing_date'])
                self.assertIsNone(result['recommended_irrigation_mm'])

    def test_minimum_and_optimum_temperature_remain_distinct(self):
        rule = agronomy.get_agronomic_rule('corn')
        self.assertEqual(rule['threshold_temperature_C'], 10)
        self.assertGreater(rule['optimum_start_rule']['threshold_temperature_C'], 12)

    def test_published_ranges_do_not_become_scalar_thresholds(self):
        for crop in ['soy', 'sorghum', 'cotton']:
            with self.subTest(crop=crop):
                result = agronomy.assess_agronomic_readiness(crop)
                self.assertIsNone(result['rule']['threshold_temperature_C'])
                self.assertIn('local_temperature_threshold_selection_required', result['blockers'])

    def test_unassigned_planting_zone_blocks_corn_window(self):
        result = agronomy.assess_agronomic_readiness('corn')
        self.assertIn('missing_planting_zone_geometry', result['blockers'])

    def test_spring_wheat_is_not_substituted_with_winter_wheat(self):
        result = agronomy.assess_agronomic_readiness('wheat')
        self.assertEqual(result['status'], 'unsupported')
        self.assertEqual(result['rule']['crop_type'], 'spring wheat')
        self.assertIn('crop_not_recommended_by_local_guide', result['blockers'])

    def test_kansas_rule_cannot_be_reused_for_another_state(self):
        result = agronomy.assess_agronomic_readiness('corn', region='US-IA')
        self.assertEqual(result['status'], 'unsupported')
        self.assertIn('agronomic_region_unsupported', result['blockers'])

    def test_unknown_crop_fails_closed(self):
        self.assertIsNone(agronomy.get_agronomic_rule('unknown'))
        self.assertEqual(agronomy.assess_agronomic_readiness('unknown')['blockers'], ['agronomic_crop_rule_missing'])

    def test_returned_rule_mutation_does_not_change_registry(self):
        first = agronomy.get_agronomic_rule('corn')
        first['threshold_temperature_C'] = -50
        self.assertEqual(agronomy.get_agronomic_rule('corn')['threshold_temperature_C'], 10)

    def test_missing_or_invalid_registry_fails_closed(self):
        with patch.object(agronomy, 'REGISTRY_PATH') as path:
            for content in [None, '{', '[]', json.dumps({'schema_version': 'unexpected', 'rules': []}),
                            json.dumps({'schema_version': '1.0', 'rules': [{'crop_id': 'corn'}, {'crop_id': 'corn'}]})]:
                path.read_text.side_effect = FileNotFoundError() if content is None else None
                path.read_text.return_value = content
                self.assertIsNone(agronomy.get_agronomic_rule('corn'))
                result = agronomy.assess_agronomic_readiness('corn')
                self.assertEqual(result['blockers'], ['agronomic_registry_unavailable'])
                self.assertIsNone(result['recommended_sowing_date'])


if __name__ == '__main__':
    unittest.main()
