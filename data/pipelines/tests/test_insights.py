"""Offline regression tests for multi-crop insights, risk, rotations, wetness and 5-pt overview."""
import datetime as dt
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from growwhere import analysis, insights, service


def daily_power_fixture(year, tmean=22.0, tmax=28.0, rain=2.2, gwettop=0.52, gwetroot=0.48):
    start = dt.date(year, 1, 1)
    end = dt.date(year, 12, 31)
    days = (end - start).days + 1
    dates = [(start + dt.timedelta(days=i)).strftime('%Y%m%d') for i in range(days)]
    return {
        'geometry': {'coordinates': [-97.5, 38.5, 420.0]},
        'parameters': {
            'T2M': {'units': 'C'},
            'T2M_MIN': {'units': 'C'},
            'T2M_MAX': {'units': 'C'},
            'PRECTOTCORR': {'units': 'mm/day'},
            'RH2M': {'units': '%'},
            'WS2M': {'units': 'm/s'},
            'ALLSKY_SFC_SW_DWN': {'units': 'MJ/m^2/day'},
            'GWETTOP': {'units': 'dimensionless'},
            'GWETROOT': {'units': 'dimensionless'},
        },
        'properties': {
            'parameter': {
                'T2M': {d: tmean for d in dates},
                'T2M_MIN': {d: tmean - 6.0 for d in dates},
                'T2M_MAX': {d: tmax for d in dates},
                'PRECTOTCORR': {d: rain for d in dates},
                'RH2M': {d: 58.0 for d in dates},
                'WS2M': {d: 3.1 for d in dates},
                'ALLSKY_SFC_SW_DWN': {d: 21.0 for d in dates},
                'GWETTOP': {d: gwettop for d in dates},
                'GWETROOT': {d: gwetroot for d in dates},
            }
        },
    }


def soil_sample():
    return {'mukey': 's1', 'ph': 6.6, 'awc': 0.16, 'slope': 2.0, 'sand': 30.0, 'clay': 24.0, 'drainage': 'Well drained', 'depth_coverage_cm': 30.0}


class InsightsTests(unittest.TestCase):
    def setUp(self):
        blocker = patch('growwhere.sources.CACHE.fetch', side_effect=AssertionError('Network is forbidden in unit tests'))
        blocker.start()
        self.addCleanup(blocker.stop)

    def test_climate_metrics_extracts_surface_and_root_wetness(self):
        raw = daily_power_fixture(2024, gwettop=0.61, gwetroot=0.31)
        clim = analysis.climate_metrics(raw, 'wheat', '2024-03-15')
        self.assertTrue(clim['complete'])
        self.assertAlmostEqual(clim['surface_wetness'], 0.61, places=3)
        self.assertAlmostEqual(clim['root_zone_wetness'], 0.31, places=3)
        self.assertEqual(clim['dry_root_days'], clim['expected_days'])

    def test_overview_grid_aggregates_five_points_with_uncertainty(self):
        def fake_soil(features, refresh=False):
            out = {}
            for pt in features:
                s = dict(soil_sample())
                if pt['id'].endswith('__s1'):
                    s['slope'] = 18.0
                out[pt['id']] = s
            return out, {'id': 'soil-m', 'source_id': 'ssurgo-statsgo2', 'retrieved_at': '2026-11-14T00:00:00+00:00', 'sha256': 'a' * 64}

        def fake_cdl(centers, year, refresh=False):
            by_id = {}
            for pt in centers:
                if pt['id'].endswith('__s2'):
                    by_id[pt['id']] = {'allow_analysis': False, 'category': 'forest', 'label': 'Deciduous Forest', 'year': year, 'sample_only': True}
                else:
                    by_id[pt['id']] = {'allow_analysis': True, 'category': 'cropland', 'label': 'Winter Wheat', 'year': year, 'sample_only': True}
            return {'by_id': by_id, 'meta': [], 'errors': []}

        with patch.object(service.soil, 'points', side_effect=fake_soil), \
             patch.object(service.landcover, 'classify_points', side_effect=fake_cdl), \
             patch.object(service, 'power_point', return_value=(daily_power_fixture(2024), {'id': 'p-m', 'source_id': 'nasa-power', 'retrieved_at': '2026-11-14T00:00:00+00:00', 'sha256': 'b' * 64})):
            fc = service.analyze([-98.0, 38.0, -97.0, 39.0], 8, 'wheat', 2024, '2024-03-15', 0, True)

        self.assertGreater(len(fc['features']), 0)
        props = fc['features'][0]['properties']
        self.assertEqual(props['representation'], 'multi_point_overview_5pt')
        unc = props['result']['uncertainty']
        self.assertEqual(unc['sample_count'], 5)
        self.assertEqual(unc['scored_samples'], 4)
        self.assertEqual(unc['excluded_samples'], 1)
        self.assertGreater(unc['score_spread'], 0)
        self.assertIsNotNone(props['result']['score'])

    def test_unknown_grid_sample_exposes_coverage_and_blocks_when_majority_missing(self):
        feature = service.grid([-98, 38, -97, 39], 8)[0][0]
        points = service._grid_sample_points(feature)
        soils = {pt['id']: soil_sample() for pt in points}
        soils.pop(points[-1]['id'])
        covers = {pt['id']: {'allow_analysis': True} for pt in points}
        climate = analysis.climate_metrics(daily_power_fixture(2024), 'wheat', '2024-03-15')
        power = {service.power_key(pt['center']): (climate, None) for pt in points}
        result = service._aggregate_grid_cell(feature, points, soils, covers, power, 'wheat', 0, True)[3]
        self.assertNotEqual(result['status'], 'unknown')
        self.assertIsNotNone(result['score'])
        self.assertEqual(result['uncertainty']['scored_samples'], 4)
        self.assertEqual(result['uncertainty']['unknown_samples'], 1)
        self.assertEqual(result['uncertainty']['coverage_ratio'], 0.8)
        self.assertTrue(result['uncertainty']['partial_unknown'])
        self.assertTrue(result['missing'])

        soils.pop(points[0]['id'])
        soils.pop(points[1]['id'])
        majority_missing = service._aggregate_grid_cell(feature, points, soils, covers, power, 'wheat', 0, True)[3]
        self.assertEqual(majority_missing['status'], 'unknown')
        self.assertIsNone(majority_missing['score'])
        self.assertEqual(majority_missing['uncertainty']['unknown_samples'], 3)

    def test_analyze_point_insights_returns_7_crops_risk_and_rotations(self):
        def fake_soil(features, refresh=False):
            return {f['id']: soil_sample() for f in features}, None

        def fake_cdl(centers, year, refresh=False):
            return {'by_id': {c['id']: {'allow_analysis': True, 'category': 'cropland', 'label': 'Winter Wheat', 'year': year} for c in centers}, 'meta': [], 'errors': []}

        def fake_power(lon, lat, year, refresh=False):
            rain = 0.7 if year == 2022 else 2.6
            tmax = 38.0 if year == 2022 else 28.0
            return daily_power_fixture(year, tmax=tmax, rain=rain), None

        def fake_econ(crop, year, refresh=False):
            return {'crop': crop, 'year': year, 'actual_year': year, 'region': 'Prairie Gateway', 'cost_per_ha': 600.0 + len(crop) * 20, 'price_per_tonne': 210.0, 'missing': []}

        with patch.object(insights.soil, 'points', side_effect=fake_soil), \
             patch.object(insights.landcover, 'classify_points', side_effect=fake_cdl), \
             patch.object(insights, 'power_point', side_effect=fake_power), \
             patch.object(insights, 'economics', side_effect=fake_econ):
            res = insights.analyze_point_insights(-97.5, 38.5, 'wheat', 2024, '2024-03-15', 0, True, years_back=5)

        self.assertEqual(len(res['crop_comparison']), 7)
        self.assertIsNotNone(res['tradeoffs']['best_suitability'])
        self.assertIsNotNone(res['tradeoffs']['lowest_water_need'])
        self.assertIsNotNone(res['tradeoffs']['lowest_cost'])
        self.assertEqual(res['climate_risk']['years_requested'], 5)
        self.assertGreater(res['climate_risk']['summary']['heat_stress_years'], 0)
        self.assertEqual(res['rotation_advice']['anchor_crop'], 'wheat')
        self.assertEqual(res['rotation_advice']['anchor_source'], 'usda_cdl')
        self.assertEqual(len(res['rotation_advice']['plans']), 3)
        self.assertAlmostEqual(res['moisture_and_cover']['surface_wetness'], 0.52, places=3)
        self.assertEqual(res['landcover_history']['years_requested'], 5)
        self.assertTrue(res['landcover_history']['monoculture_alert'])
        self.assertEqual(res['landcover_history']['monoculture_streak'], 5)

    def test_landcover_history_mixed_rotation_no_monoculture_alert(self):
        labels = {2020: 'Corn', 2021: 'Soybeans', 2022: 'Winter Wheat', 2023: 'Sorghum', 2024: 'Corn'}

        def fake_soil(features, refresh=False):
            return {f['id']: soil_sample() for f in features}, None

        def fake_cdl(centers, year, refresh=False):
            return {'by_id': {c['id']: {'allow_analysis': True, 'category': 'cropland', 'label': labels.get(year, 'Corn'), 'year': year} for c in centers}, 'meta': [], 'errors': []}

        with patch.object(insights.soil, 'points', side_effect=fake_soil), \
             patch.object(insights.landcover, 'classify_points', side_effect=fake_cdl), \
             patch.object(insights, 'power_point', side_effect=lambda lon, lat, year, refresh=False: (daily_power_fixture(year), None)), \
             patch.object(insights, 'economics', return_value={'missing': ['economics']}):
            res = insights.analyze_point_insights(-97.5, 38.5, 'corn', 2024, '2024-05-01', 150, True, years_back=5)

        hist = res['landcover_history']
        self.assertEqual(hist['years_requested'], 5)
        self.assertEqual(len(hist['years']), 5)
        self.assertFalse(hist['monoculture_alert'])
        self.assertEqual(hist['monoculture_streak'], 1)
        self.assertEqual(hist['rotation_changes'], 4)
        self.assertEqual(hist['unique_crops'], 4)

    def test_excluded_cdl_point_preserves_potential_score_for_comparison(self):
        def fake_soil(features, refresh=False):
            return {f['id']: soil_sample() for f in features}, None

        def fake_cdl(centers, year, refresh=False):
            return {'by_id': {c['id']: {'allow_analysis': False, 'category': 'urban', 'label': 'Developed/Open Space', 'year': year} for c in centers}, 'meta': [], 'errors': []}

        with patch.object(insights.soil, 'points', side_effect=fake_soil), \
             patch.object(insights.landcover, 'classify_points', side_effect=fake_cdl), \
             patch.object(insights, 'power_point', return_value=(daily_power_fixture(2024), None)), \
             patch.object(insights, 'economics', return_value={'missing': ['economics']}):
            res = insights.analyze_point_insights(-97.5, 38.5, 'corn', 2024, '2024-05-01', 150, True, years_back=2)

        first = res['crop_comparison'][0]
        self.assertIsNone(first['score'])
        self.assertEqual(first['status'], 'excluded')
        self.assertIsNotNone(first['potential_score'])
        self.assertIsNotNone(res['tradeoffs']['best_suitability'])
        self.assertTrue(res['tradeoffs']['best_suitability']['potential'])


if __name__ == '__main__':
    unittest.main()
