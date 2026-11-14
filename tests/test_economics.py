"""Deterministic contract checks; fixtures are not shipped as observations."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'data' / 'pipelines'))
from growwhere.economics import (ACRES_PER_HECTARE, discover_csv, economics,
                                finite_nonnegative, parse_csv, select_observations)


def row(item, value, unit, year='2025', region='Prairie Gateway', commodity='Corn'):
    return {'Commodity': commodity, 'Item': item, 'Value': value, 'Units': unit,
            'Year': year, 'Region': region, 'Country': 'United States',
            'Size': 'No specific size', 'Survey base year': 'Base survey of 2021'}


class EconomicAdapterTests(unittest.TestCase):
    def test_conversion_uses_crop_bushel_weight_and_preserves_basis(self):
        rows = [row('Total, costs listed', '100', 'dollars per planted acre'),
                row('Price', '4', 'dollars per bushel at harvest')]
        result = select_observations(rows, 'corn', 2025)
        self.assertEqual(result['cost_per_ha'], round(100 * ACRES_PER_HECTARE, 2))
        self.assertEqual(result['price_per_tonne'], 157.47)
        self.assertEqual(result['region'], 'Prairie Gateway')
        self.assertIsNone(result['market'])

    def test_missing_year_never_silently_uses_latest_available(self):
        result = select_observations([row('Price', '4', 'dollars per bushel at harvest')], 'corn', 2024)
        self.assertIsNone(result['actual_year'])
        self.assertIsNone(result['price_per_tonne'])
        self.assertIn('region_year', result['missing'])

    def test_does_not_fill_regional_gap_with_national_or_wrong_unit(self):
        rows = [row('Total, costs listed', '100', 'dollars per planted acre'),
                row('Price', '4', 'dollars per bushel at harvest', region='U.S. total'),
                row('Price', '100', 'dollars per metric ton')]
        result = select_observations(rows, 'corn', 2025)
        self.assertIsNotNone(result['cost_per_ha'])
        self.assertIsNone(result['price_per_tonne'])

    def test_national_fallback_is_explicit_and_duplicates_are_not_guessed(self):
        rows = [row('Price', '4', 'dollars per bushel at harvest', region='U.S. total')]
        self.assertTrue(select_observations(rows, 'corn', 2025)['region_is_fallback'])
        rows += [row('Price', '5', 'dollars per bushel at harvest', region='U.S. total')]
        self.assertIsNone(select_observations(rows, 'corn', 2025)['price_per_tonne'])

    def test_markers_are_missing_and_genuine_zero_is_preserved(self):
        for invalid in ['', None, '-999', 'NaN', 'Infinity', '(D)', '(Z)']:
            self.assertIsNone(finite_nonnegative(invalid))
        self.assertEqual(finite_nonnegative('0'), 0)

    def test_csv_discovery_retains_revision_and_rejects_other_domains(self):
        page = '<a href="https://example.test/wheat.csv">x</a><a href="/media/4978/wheat.csv?v=19709&amp;x=1">CSV</a>'
        self.assertEqual(discover_csv(page, 'wheat'), 'https://www.ers.usda.gov/media/4978/wheat.csv?v=19709&x=1')
        self.assertIsNone(discover_csv(page, 'corn'))
        with self.assertRaises(ValueError): parse_csv('wrong,headers\n1,2')

    def test_retrieval_failure_returns_no_data_without_old_synthetic_values(self):
        class FailedCache:
            def fetch(self, *args, **kwargs): raise TimeoutError('test timeout')
        result = economics('soy', 2025, cache=FailedCache())
        self.assertEqual(result['status'], 'no_data')
        self.assertIsNone(result['cost_per_ha'])
        self.assertIsNone(result['price_per_tonne'])
        self.assertTrue(result['errors'])

    def test_cotton_and_extended_crops_convert_units(self):
        cotton_rows = [
            row('Total, costs listed', '500', 'dollars per planted acre', commodity='Cotton'),
            row('Price', '0.75', 'dollars per pound', commodity='Cotton'),
        ]
        cotton = select_observations(cotton_rows, 'cotton', 2025)
        self.assertEqual(cotton['cost_per_ha'], round(500 * ACRES_PER_HECTARE, 2))
        self.assertEqual(cotton['price_per_tonne'], round(0.75 * 2204.62262, 2))
        for crop, commodity, bu_lb in [('sorghum', 'Sorghum', 56), ('barley', 'Barley', 48), ('oats', 'Oats', 32)]:
            r = [row('Price', '5', 'dollars per bushel at harvest', commodity=commodity)]
            res = select_observations(r, crop, 2025)
            self.assertEqual(res['price_per_tonne'], round(5 * (2204.62262 / bu_lb), 2))


if __name__ == '__main__':
    unittest.main()
