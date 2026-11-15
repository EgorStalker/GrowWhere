"""Tests for Open-Meteo 7-day soil forecast adapter and user planning inputs."""
import datetime as dt
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from growwhere import planning, service
from growwhere.soil_forecast import indicative_guidance, openmeteo_soil_forecast
from growwhere.sources import UpstreamError

NOW = dt.datetime(2026, 11, 15, 12, tzinfo=dt.timezone.utc)


def openmeteo_payload():
    times = [(NOW + dt.timedelta(hours=h)).strftime('%Y-%m-%dT%H:00') for h in range(168)]
    days = [(NOW + dt.timedelta(days=d)).strftime('%Y-%m-%d') for d in range(7)]
    return {
        'hourly': {
            'time': times,
            'soil_temperature_0cm': [11.5] * 168,
            'soil_temperature_6cm': [11.2] * 168,
            'soil_moisture_0_to_1cm': [0.22] * 168,
            'soil_moisture_3_to_9cm': [0.25] * 168,
            'soil_moisture_9_to_27cm': [0.28] * 168,
        },
        'daily': {
            'time': days,
            'et0_fao_evapotranspiration': [3.0] * 7,
            'precipitation_sum': [1.0] * 7,
        },
    }


class SoilForecastTests(unittest.TestCase):
    def test_openmeteo_forecast_and_indicative_guidance(self):
        meta = {'source_id': 'open-meteo', 'source_url': 'https://api.open-meteo.com/v1/forecast', 'retrieved_at': NOW.isoformat(), 'kind': 'model_forecast'}
        with patch('growwhere.soil_forecast.CACHE.fetch', return_value=(openmeteo_payload(), meta)):
            sf = openmeteo_soil_forecast(-97.5, 38.5, now=NOW)
        self.assertTrue(sf['available'])
        self.assertEqual(sf['data']['current_soil_temp_6cm_c'], 11.2)
        self.assertEqual(sf['data']['et0_7d_mm'], 21.0)
        self.assertEqual(sf['data']['precipitation_7d_mm'], 7.0)
        guide = indicative_guidance(
            'corn', sf,
            agronomic_rules={'rule': {'threshold_temperature_C': 10.0}},
            irrigation_system='sprinkler', crop_growth_stage='reproductive', crop_variety='standard',
        )
        self.assertTrue(guide['is_model_indicative_only'])
        self.assertEqual(guide['sowing_soil_check']['status'], 'meets_threshold_3d')
        irr = guide['irrigation_7d_guidance']
        self.assertEqual(irr['status'], 'calculated_with_user_params')
        self.assertEqual(irr['kc_used'], 1.2)
        self.assertEqual(irr['crop_etc_7d_mm'], 25.2)
        self.assertEqual(irr['net_deficit_7d_mm'], 19.6)
        self.assertEqual(irr['gross_irrigation_7d_mm'], 24.5)

    def test_upstream_failure_and_outside_pilot(self):
        with patch('growwhere.soil_forecast.CACHE.fetch') as fetch:
            outside = openmeteo_soil_forecast(30, 50, now=NOW)
            fetch.assert_not_called()
            self.assertEqual(outside['status'], 'outside_pilot_coverage')
        with patch('growwhere.soil_forecast.CACHE.fetch', side_effect=UpstreamError('down')):
            failed = openmeteo_soil_forecast(-97.5, 38.5, now=NOW)
            self.assertFalse(failed['available'])
            self.assertIsNone(failed['data'])

    def test_user_params_close_corresponding_planning_evidence_checks(self):
        res = planning.planning_readiness(
            mode='own_land', crop='corn', lon=-97.5, lat=38.5, target_year=2027,
            today=dt.date(2026, 11, 15),
            irrigation_system='drip', crop_growth_stage='vegetative', crop_variety='standard',
        )
        self.assertTrue(res['evidence_checks']['irrigation_system_efficiency']['verified'])
        self.assertTrue(res['evidence_checks']['crop_growth_stage']['verified'])
        self.assertTrue(res['evidence_checks']['crop_variety_and_target_season']['verified'])
        self.assertIsNone(res['irrigation_recommendation']['value'])


if __name__ == '__main__':
    unittest.main()
