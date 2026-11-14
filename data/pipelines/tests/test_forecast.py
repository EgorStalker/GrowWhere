import datetime as dt
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from growwhere.forecast import nws_forecast, forecast_evidence, TTL_SECONDS
from growwhere.sources import UpstreamError

NOW = dt.datetime(2026, 11, 14, 12, tzinfo=dt.timezone.utc)
URL = 'https://api.weather.gov/gridpoints/TOP/31,80/forecast/hourly'


def payload():
    periods = []
    for i in range(48):
        start = NOW + dt.timedelta(hours=i)
        periods.append({'startTime': start.isoformat(), 'endTime': (start + dt.timedelta(hours=1)).isoformat(),
                        'temperature': 50, 'temperatureUnit': 'F',
                        'probabilityOfPrecipitation': {'unitCode': 'wmoUnit:percent', 'value': 30},
                        'shortForecast': 'Mostly Sunny'})
    return {'properties': {'updateTime': (NOW - dt.timedelta(hours=1)).isoformat(), 'periods': periods}}


class ForecastTests(unittest.TestCase):
    def run_forecast(self, data=None):
        data = payload() if data is None else data
        with patch('growwhere.forecast.CACHE.fetch', side_effect=[
            ({'properties': {'forecastHourly': URL}}, {'source_url': 'https://api.weather.gov/points/38.5000,-97.5000'}),
            (data, {'source_url': URL, 'sha256': 'upstream-sha', 'retrieved_at': NOW.isoformat(),
                    'path':'private/raw/path','request':{'body':'private'}})
        ]) as fetch:
            result = nws_forecast(-97.5, 38.5, now=NOW)
            return result, fetch

    def test_actual_hourly_fields_units_freshness_and_provenance(self):
        result, fetch = self.run_forecast()
        self.assertTrue(result['available'])
        self.assertEqual(result['data']['period_count'], 48)
        self.assertEqual(result['data']['periods'][0]['air_temperature_c'], 10)
        self.assertEqual(result['data']['periods'][0]['precipitation_probability_pct'], 30)
        self.assertEqual(result['freshness']['issue_age_hours'], 1)
        self.assertEqual(len(result['provenance']), 2)
        self.assertNotIn('path',result['provenance'][-1])
        self.assertNotIn('request',result['provenance'][-1])
        for call in fetch.call_args_list:
            self.assertLessEqual(call.kwargs['ttl'], 3600)
            self.assertEqual(call.kwargs['kind'], 'forecast')
            self.assertEqual(call.kwargs['timeout'], 10)
        self.assertEqual(TTL_SECONDS, 3600)
        self.assertTrue(forecast_evidence(result, 2026)['verified'])
        self.assertFalse(forecast_evidence(result, 2027)['verified'])

    def test_failure_and_stale_data_are_null(self):
        with patch('growwhere.forecast.CACHE.fetch', side_effect=UpstreamError('unavailable')):
            result = nws_forecast(-97.5, 38.5, now=NOW)
            self.assertIsNone(result['data'])
            self.assertFalse(result['available'])
        for issued in (NOW - dt.timedelta(days=2), NOW + dt.timedelta(hours=1)):
            data = payload()
            data['properties']['updateTime'] = issued.isoformat()
            result, _ = self.run_forecast(data)
            self.assertEqual(result['status'], 'stale')
            self.assertIsNone(result['data'])

    def test_short_horizon_not_a_valid_planning_forecast(self):
        data = payload()
        data['properties']['periods'] = data['properties']['periods'][:6]
        result, _ = self.run_forecast(data)
        self.assertEqual(result['status'], 'insufficient_horizon')
        self.assertIsNone(result['data'])

    def test_invalid_units_numbers_and_gaps_do_not_generate_data(self):
        for field, value in [('temperatureUnit', 'K'), ('temperature', None), ('temperature', True), ('temperature', float('nan'))]:
            data = payload()
            data['properties']['periods'][0][field] = value
            result, _ = self.run_forecast(data)
            self.assertFalse(result['available'])
            self.assertIsNone(result['data'])
        data = payload()
        del data['properties']['periods'][2]
        result, _ = self.run_forecast(data)
        self.assertFalse(result['available'])

    def test_precipitation_probability_null_is_not_zero_or_water_amount(self):
        data = payload()
        data['properties']['periods'][0]['probabilityOfPrecipitation']['value'] = None
        result, _ = self.run_forecast(data)
        self.assertTrue(result['available'])
        period = result['data']['periods'][0]
        self.assertIsNone(period['precipitation_probability_pct'])
        self.assertNotIn('rainfall_mm', period)
        self.assertNotIn('irrigation_mm', period)

    def test_outside_pilot_never_fetches(self):
        with patch('growwhere.forecast.CACHE.fetch') as fetch:
            result = nws_forecast(30, 50, now=NOW)
            fetch.assert_not_called()
            self.assertEqual(result['status'], 'outside_pilot_coverage')
            self.assertIsNone(result['data'])

    def test_untrusted_discovery_url_never_fetched(self):
        with patch('growwhere.forecast.CACHE.fetch', return_value=(
            {'properties': {'forecastHourly': 'https://untrusted.example/forecast/hourly'}}, {'source_url': 'point'})) as fetch:
            result = nws_forecast(-97.5, 38.5, now=NOW)
            self.assertEqual(fetch.call_count, 1)
            self.assertFalse(result['available'])

    def test_coordinates_require_finite_numbers(self):
        for lon, lat in [(True,38), (float('nan'),38), (-97,91), ('x',38)]:
            with self.assertRaises(ValueError):
                nws_forecast(lon,lat,now=NOW)


if __name__ == '__main__':
    unittest.main()
