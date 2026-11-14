"""Behavioral regression tests; synthetic fixtures are confined to tests.

Run: python -m unittest discover -s data/pipelines/tests -p test_analysis.py -v
"""
import copy
import datetime as dt
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from growwhere.analysis import (PROFILES, WEIGHTS, climate_metrics, evaluate,
                               number, reference_et0)


def soil_fixture():
    return {'ph': 6.5, 'awc': .15, 'slope': 1., 'sand': 35., 'clay': 25.,
            'drainage': 'Well drained', 'depth_coverage_cm': 30.}


def climate_fixture():
    return {'complete': True, 'missing': [], 'mean_temperature': 24.,
            'precipitation_mm': 100., 'crop_water_demand_mm': 500.,
            'frost_days': 0, 'heat_days': 0, 'expected_days': 150}


def daily_fixture(crop='corn', planting='2025-05-01'):
    """Complete constant-weather test input, not a scientific observation."""
    start = dt.date.fromisoformat(planting)
    values = {'T2M': 24., 'T2M_MIN': 18., 'T2M_MAX': 30., 'RH2M': 60.,
              'WS2M': 2., 'ALLSKY_SFC_SW_DWN': 18., 'PRECTOTCORR': .5,
              'GWETROOT': .4}
    parameters = {key: {} for key in values}
    for index in range(sum(PROFILES[crop]['stages'])):
        key = (start + dt.timedelta(days=index)).strftime('%Y%m%d')
        for name, value in values.items():
            parameters[name][key] = value
    units = {'T2M': 'C', 'T2M_MIN': 'C', 'T2M_MAX': 'C', 'RH2M': '%',
             'WS2M': 'm/s', 'ALLSKY_SFC_SW_DWN': 'MJ/m^2/day',
             'PRECTOTCORR': 'mm/day', 'GWETROOT': '1'}
    return {'geometry': {'coordinates': [-97.5, 38.5, 429.]},
            'parameters': {key: {'units': value} for key, value in units.items()},
            'properties': {'parameter': parameters}}


class ReferenceETTests(unittest.TestCase):
    def test_fao56_daily_example_18_uccle(self):
        # FAO-56 chapter 4, Example 18, 6 July (non-leap J=187).
        # https://www.fao.org/4/x0490e/x0490e08.htm
        # Convert that example's RHmin/RHmax into the RHmean-equivalent ea
        # accepted by our interface, preserving the example's vapour pressure.
        svp = lambda temp: .6108 * math.exp(17.27 * temp / (temp + 237.3))
        es = (svp(12.3) + svp(21.5)) / 2
        ea = (svp(12.3) * .84 + svp(21.5) * .63) / 2
        result = reference_et0(dt.date(2001, 7, 6), 50.8, 100, 16.9,
                               12.3, 21.5, 100 * ea / es, 2.078, 22.07 / 3.6)
        self.assertAlmostEqual(result, 3.88, delta=.02)

    def test_numeric_source_strings_are_normalized_before_comparison(self):
        args = (dt.date(2025, 7, 1), 38.5, 400, 8, 5, 12, 60, 2, 5)
        expected = reference_et0(*args)
        actual = reference_et0(args[0], *map(str, args[1:]))
        self.assertIsNotNone(actual)
        self.assertAlmostEqual(actual, expected, places=8)

    def test_invalid_meteorology_is_not_zero_filled(self):
        valid = [dt.date(2025, 7, 1), 38.5, 400, 24, 18, 30, 60, 2, 5]
        for index, value in [(3, None), (4, -999), (5, -9999),
                             (6, 101), (7, -1), (8, float('nan'))]:
            with self.subTest(index=index, value=value):
                args = valid.copy(); args[index] = value
                self.assertIsNone(reference_et0(*args))

    def test_latitude_must_be_finite_and_in_geographic_range(self):
        for latitude in [None, 'bad', float('nan'), 95, -91]:
            with self.subTest(latitude=latitude):
                self.assertIsNone(reference_et0(dt.date(2025, 7, 1), latitude,
                                               400, 24, 18, 30, 60, 2, 5))


class SeasonTests(unittest.TestCase):
    def test_mj_and_kwh_solar_units_produce_identical_water_demand(self):
        mj = daily_fixture()
        expected = climate_metrics(mj, 'corn', '2025-05-01')
        self.assertTrue(expected['complete'])
        for unit in ['kW-hr/m^2/day', 'kWh/m^2/day']:
            with self.subTest(unit=unit):
                kwh = copy.deepcopy(mj)
                kwh['parameters']['ALLSKY_SFC_SW_DWN']['units'] = unit
                for key, value in kwh['properties']['parameter']['ALLSKY_SFC_SW_DWN'].items():
                    kwh['properties']['parameter']['ALLSKY_SFC_SW_DWN'][key] = value / 3.6
                actual = climate_metrics(kwh, 'corn', '2025-05-01')
                self.assertTrue(actual['complete'])
                self.assertAlmostEqual(actual['crop_water_demand_mm'],
                                       expected['crop_water_demand_mm'], places=8)

    def test_unknown_or_missing_required_units_make_season_unusable(self):
        for name in ['T2M', 'T2M_MIN', 'T2M_MAX', 'RH2M', 'WS2M',
                     'ALLSKY_SFC_SW_DWN', 'PRECTOTCORR']:
            for unit in [None, 'unknown unit']:
                with self.subTest(name=name, unit=unit):
                    raw = daily_fixture()
                    if unit is None:
                        del raw['parameters'][name]
                    else:
                        raw['parameters'][name]['units'] = unit
                    climate = climate_metrics(raw, 'corn', '2025-05-01')
                    self.assertFalse(climate['complete'])
                    result = evaluate(climate, soil_fixture(), 'corn')
                    self.assertEqual(result['status'], 'unknown')
                    self.assertIsNone(result['score'])

    def test_absent_parameter_metadata_is_not_assumed_to_be_kwh(self):
        raw = daily_fixture()
        del raw['parameters']
        climate = climate_metrics(raw, 'corn', '2025-05-01')
        self.assertFalse(climate['complete'])
        self.assertEqual(evaluate(climate, soil_fixture(), 'corn')['status'], 'unknown')

    def test_full_season_has_exact_day_count_and_precipitation_units(self):
        for crop, profile in PROFILES.items():
            with self.subTest(crop=crop):
                result = climate_metrics(daily_fixture(crop), crop, '2025-05-01')
                length = sum(profile['stages'])
                self.assertTrue(result['complete'])
                self.assertEqual(result['valid_days'], length)
                self.assertEqual(result['expected_days'], length)
                self.assertAlmostEqual(result['precipitation_mm'], .5 * length)
                self.assertGreater(result['crop_water_demand_mm'], 0)
                self.assertLess(result['crop_water_demand_mm'], 2000)

    def test_one_missing_day_prevents_full_suitability(self):
        raw = daily_fixture()
        del raw['properties']['parameter']['RH2M']['20250603']
        climate = climate_metrics(raw, 'corn', '2025-05-01')
        self.assertFalse(climate['complete'])
        self.assertEqual(climate['valid_days'], 149)
        result = evaluate(climate, soil_fixture(), 'corn')
        self.assertEqual(result['status'], 'unknown')
        self.assertIsNone(result['score'])
        self.assertIn('complete_season', result['missing'])

    def test_fill_value_is_missing_but_measured_zero_rain_is_valid(self):
        raw = daily_fixture()
        raw['properties']['parameter']['PRECTOTCORR']['20250603'] = 0
        self.assertTrue(climate_metrics(raw, 'corn', '2025-05-01')['complete'])
        raw['properties']['parameter']['PRECTOTCORR']['20250603'] = -999
        self.assertFalse(climate_metrics(raw, 'corn', '2025-05-01')['complete'])

    def test_absent_optional_root_wetness_does_not_invent_values(self):
        raw = daily_fixture()
        del raw['properties']['parameter']['GWETROOT']
        result = climate_metrics(raw, 'corn', '2025-05-01')
        self.assertTrue(result['complete'])
        self.assertIsNone(result['root_zone_wetness'])

    def test_absent_coordinates_make_climate_unusable(self):
        raw = daily_fixture(); raw['geometry']['coordinates'] = []
        result = climate_metrics(raw, 'corn', '2025-05-01')
        self.assertFalse(result['complete'])
        self.assertIn('climate_coordinates', result['missing'])


class SuitabilityTests(unittest.TestCase):
    def test_weights_define_one_fixed_index(self):
        self.assertAlmostEqual(sum(WEIGHTS.values()), 1.)

    def test_missing_required_soil_factor_is_not_renormalized_away(self):
        for field in ['ph', 'awc', 'slope', 'sand', 'clay', 'drainage']:
            with self.subTest(field=field):
                soil = soil_fixture(); soil[field] = None
                result = evaluate(climate_fixture(), soil, 'corn')
                self.assertEqual(result['status'], 'unknown')
                self.assertIsNone(result['score'])

    def test_shallow_soil_coverage_is_unknown_not_neutral(self):
        soil = soil_fixture(); soil['depth_coverage_cm'] = 20
        result = evaluate(climate_fixture(), soil, 'corn')
        self.assertEqual(result['status'], 'unknown')
        self.assertIn('soil_0_30cm', result['missing'])

    def test_zero_limiting_factor_is_known_poor_not_missing_or_log_error(self):
        soil = soil_fixture(); soil['drainage'] = 'Very poorly drained'
        result = evaluate(climate_fixture(), soil, 'corn')
        self.assertEqual(result['score'], 0)
        self.assertEqual(result['status'], 'poor')
        self.assertEqual(result['missing'], [])

    def test_severe_limitation_cannot_be_hidden_by_other_good_factors(self):
        climate = climate_fixture(); climate['precipitation_mm'] = 1000
        soil = soil_fixture(); soil['slope'] = 19
        result = evaluate(climate, soil, 'corn')
        self.assertLessEqual(result['score'], round(100 * math.sqrt(1/18), 1))
        self.assertEqual(result['status'], 'poor')

    def test_irrigation_changes_water_without_changing_soil_factors(self):
        rainfed = evaluate(climate_fixture(), soil_fixture(), 'corn', 0)
        irrigated = evaluate(climate_fixture(), soil_fixture(), 'corn', 300)
        self.assertGreater(irrigated['factors']['water'], rainfed['factors']['water'])
        self.assertGreater(irrigated['score'], rainfed['score'])
        for key in ['ph', 'awc', 'drainage', 'slope', 'texture', 'temperature']:
            self.assertEqual(irrigated['factors'][key], rainfed['factors'][key])

    def test_unknown_irrigation_never_grants_unconfirmed_water(self):
        baseline = evaluate(climate_fixture(), soil_fixture(), 'corn', 0, True)
        unknown = evaluate(climate_fixture(), soil_fixture(), 'corn', 300, False)
        self.assertEqual(unknown['factors']['water'], baseline['factors']['water'])
        self.assertEqual(unknown['irrigation_assumption'], 'rainfed_unconfirmed')

    def test_numeric_depth_strings_can_be_used_without_type_error(self):
        soil = soil_fixture(); soil['depth_coverage_cm'] = '30'
        self.assertNotEqual(evaluate(climate_fixture(), soil, 'corn')['status'], 'unknown')

    def test_missing_climate_measurement_is_unknown_even_if_flag_is_wrong(self):
        for key in ['mean_temperature', 'precipitation_mm', 'crop_water_demand_mm',
                    'expected_days', 'frost_days', 'heat_days']:
            with self.subTest(key=key):
                climate = climate_fixture(); climate[key] = None
                result = evaluate(climate, soil_fixture(), 'corn')
                self.assertEqual(result['status'], 'unknown')
                self.assertIsNone(result['score'])

    def test_nonpositive_season_length_is_unknown(self):
        climate = climate_fixture(); climate['expected_days'] = 0
        result = evaluate(climate, soil_fixture(), 'corn')
        self.assertEqual(result['status'], 'unknown')

    def test_invalid_irrigation_rejected(self):
        for irrigation in [-1, float('nan'), float('inf'), 'bad']:
            with self.subTest(irrigation=irrigation):
                with self.assertRaises(ValueError):
                    evaluate(climate_fixture(), soil_fixture(), 'corn', irrigation)

    def test_unsupported_crop_rejected(self):
        with self.assertRaises(ValueError):
            evaluate(climate_fixture(), soil_fixture(), 'unsupported')

    def test_invalid_numeric_values_are_missing(self):
        for value in [None, -999, -9999, float('inf'), float('nan'), 'bad']:
            self.assertIsNone(number(value))
        self.assertEqual(number(0), 0)

    def test_moderate_limitation_does_not_mask_irrigation(self):
        # A moderately warm season (28 C for soy -> f_temperature > 0.2) must still show irrigation gain.
        climate = climate_fixture()
        climate['mean_temperature'] = 28.0
        climate['precipitation_mm'] = 120.0
        climate['crop_water_demand_mm'] = 520.0
        rainfed = evaluate(climate, soil_fixture(), 'soy', 0, True)
        irrigated = evaluate(climate, soil_fixture(), 'soy', 350, True)
        self.assertGreater(irrigated['factors']['temperature'], 0.2)
        self.assertGreater(irrigated['factors']['water'], rainfed['factors']['water'])
        self.assertGreater(irrigated['score'], rainfed['score'])
        self.assertIn('water_balance', irrigated)

    def test_all_supported_crops_evaluate(self):
        for crop in ['wheat', 'soy', 'corn', 'sorghum', 'barley', 'oats', 'cotton']:
            with self.subTest(crop=crop):
                result = evaluate(climate_fixture(), soil_fixture(), crop, 150, True)
                self.assertIn(result['status'], {'good', 'conditional', 'poor'})
                self.assertIn(result['limiting_factor'], result['factors'])


if __name__ == '__main__':
    unittest.main()
