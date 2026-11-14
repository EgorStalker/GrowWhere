"""Planning capabilities fail closed; no external APIs are called."""
import datetime as dt
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from growwhere.analysis import PROFILES
from growwhere.planning import planning_readiness, SOWING_MISSING, IRRIGATION_MISSING


class PlanningReadinessTests(unittest.TestCase):
    def ready_scope(self, **overrides):
        params = {'mode': 'own_land', 'crop': 'cotton', 'lon': -97.5,
                  'lat': 38.5, 'target_year': 2027,
                  'today': dt.date(2026, 11, 14)}
        params.update(overrides)
        return planning_readiness(**params)

    def test_historical_reference_never_becomes_a_recommended_full_date(self):
        for crop in PROFILES:
            for year in [2025, 2026, 2027]:
                with self.subTest(crop=crop, year=year):
                    result = self.ready_scope(crop=crop, target_year=year)
                    self.assertIsNone(result['future_sowing_date']['value'])
                    self.assertFalse(result['future_sowing_date']['available'])
                    self.assertEqual(result['scenario_metadata']['reference_month_day'], PROFILES[crop]['default_planting'])
                    self.assertEqual(result['scenario_metadata']['purpose'], 'historical_analysis_only')
                    self.assertFalse(result['scenario_metadata']['is_agronomic_recommendation'])

    def test_past_target_year_is_reported_before_advice(self):
        result = self.ready_scope(target_year=2025)
        self.assertEqual(result['target_year_status'], 'past')
        self.assertIn('past_target_year', result['future_sowing_date']['missing'])
        self.assertFalse(result['ready_for_recommendations'])

    def test_irrigation_is_null_without_forecast_full_root_profile_and_efficiency(self):
        result = self.ready_scope(scale_ha=25)
        irrigation = result['irrigation_recommendation']
        self.assertFalse(irrigation['available'])
        self.assertIsNone(irrigation['value'])
        self.assertEqual(irrigation['unit'], 'mm')
        for key in ['validated_weather_forecast', 'current_root_zone_water_storage',
                    'verified_root_depth_and_soil_profile', 'irrigation_system_efficiency']:
            self.assertIn(key, irrigation['missing'])

    def test_historical_capability_is_not_a_per_cell_data_guarantee(self):
        result = self.ready_scope()
        historical = result['historical_suitability']
        self.assertTrue(historical['available'])
        self.assertIsNone(historical['data_complete'])
        self.assertTrue(historical['requires_complete_per_cell'])
        self.assertFalse(historical['scientifically_validated'])

    def test_outside_and_partial_coverage_are_not_called_ready(self):
        outside = self.ready_scope(lon=30, lat=50)
        self.assertFalse(outside['historical_suitability']['available'])
        self.assertIn('unsupported_coverage', outside['historical_suitability']['missing'])
        partial = self.ready_scope(lon=None, lat=None, bbox=[-103, 37, -100, 39])
        self.assertEqual(partial['coverage']['status'], 'partial')
        self.assertTrue(partial['coverage']['supported_subset'])
        self.assertFalse(partial['historical_suitability']['available'])
        self.assertIn('partial_coverage', partial['historical_suitability']['missing'])

    def test_find_land_uses_region_bounds_without_requiring_an_owned_parcel(self):
        result = self.ready_scope(mode='find_land', lon=None, lat=None,
                                  bbox=[-100, 37.5, -97, 39])
        self.assertTrue(result['historical_suitability']['available'])
        self.assertEqual(result['mode'], 'find_land')

    def test_area_and_crop_must_be_selected_before_historical_analysis(self):
        result = planning_readiness(today=dt.date(2026, 11, 14))
        self.assertFalse(result['historical_suitability']['available'])
        self.assertEqual(result['historical_suitability']['missing'], ['selected_crop', 'selected_area'])

    def test_scale_units_are_explicit_and_invalid_numeric_values_are_rejected(self):
        result = self.ready_scope(scale_ha='12.5')
        self.assertEqual(result['scale'], {'value': 12.5, 'unit': 'ha'})
        for value in [-1, 0, True, float('nan'), float('inf'), '25 acres']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.ready_scope(scale_ha=value)

    def test_invalid_scope_inputs_are_not_silently_corrected(self):
        for overrides in [{'lat': None}, {'lon': True}, {'lat': 91},
                          {'bbox': [-100, 37, -99, 38]}, {'crop': 'unknown'},
                          {'mode': 'unknown'}, {'target_year': True},
                          {'target_year': '2025-04-20'}]:
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                self.ready_scope(**overrides)

    def test_readiness_reporting_never_downloads_missing_data_or_invents_it(self):
        with patch('growwhere.sources.CACHE.fetch', side_effect=AssertionError('No downloads allowed')):
            result = self.ready_scope()
        self.assertFalse(result['future_sowing_date']['available'])
        self.assertFalse(result['irrigation_recommendation']['available'])
        self.assertTrue(result['critical_gaps'])

    def test_future_verified_adapters_enable_calculation_without_inventing_advice(self):
        evidence = {key: {'status': 'available', 'verified': True,
                          'supports_selected_scope': True,
                          'source_ref': 'test-only validated adapter assessment'}
                    for key in set(SOWING_MISSING + IRRIGATION_MISSING)}
        result = self.ready_scope(evidence=evidence)
        self.assertTrue(result['ready_for_calculation'])
        self.assertEqual(result['critical_gaps'], [])
        self.assertTrue(result['future_sowing_date']['available'])
        self.assertEqual(result['future_sowing_date']['status'], 'ready_for_calculation')
        self.assertIsNone(result['future_sowing_date']['value'])
        self.assertIsNone(result['irrigation_recommendation']['value'])
        self.assertFalse(result['recommendations_generated'])

    def test_downloaded_or_wrong_scope_forecast_alone_does_not_pass_the_gate(self):
        for forecast in [True, {'status': 'available'},
                         {'status': 'available', 'verified': True,
                          'supports_selected_scope': False, 'source_ref': 'fixture'}]:
            if forecast is True:
                with self.assertRaises(ValueError):
                    self.ready_scope(evidence={'validated_weather_forecast': forecast})
            else:
                result = self.ready_scope(evidence={'validated_weather_forecast': forecast})
                self.assertFalse(result['future_sowing_date']['available'])
                self.assertIn('validated_weather_forecast', result['future_sowing_date']['missing'])
                self.assertFalse(result['irrigation_recommendation']['available'])

    def test_unsupported_area_blocks_even_otherwise_verified_adapters(self):
        evidence = {key: {'status': 'available', 'verified': True,
                          'supports_selected_scope': True, 'source_ref': 'fixture'}
                    for key in set(SOWING_MISSING + IRRIGATION_MISSING)}
        result = self.ready_scope(lon=30, lat=50, evidence=evidence)
        self.assertFalse(result['ready_for_calculation'])
        self.assertIn('unsupported_coverage', result['future_sowing_date']['missing'])

    def test_connected_forecast_can_report_a_target_horizon_gap(self):
        reason = 'Forecast connected but target season is outside its verified horizon'
        result = self.ready_scope(evidence={'validated_weather_forecast': {
            'status':'missing','verified':False,'supports_selected_scope':False,
            'source_url':'https://api.weather.gov','reason':reason}})
        gap = next(row for row in result['critical_gaps'] if row['id']=='validated_weather_forecast')
        self.assertEqual(gap['message'],reason)


if __name__ == '__main__':
    unittest.main()
