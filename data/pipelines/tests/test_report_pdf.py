import unittest

from growwhere.report_pdf import generate_report_pdf


class ReportPdfTests(unittest.TestCase):
    def test_generate_report_pdf_returns_valid_pdf_bytes_with_ukrainian_payload(self):
        payload = {
            'header': {
                'title': 'Детальний звіт обчислень та формул GrowWhere',
                'generatedAt': '2026-11-15T20:15:00Z',
                'methodVersion': 'growwhere-screening-0.2',
                'scopeLabel': 'Зона №12',
                'coordinates': [-97.5, 38.5],
                'crop': 'corn',
                'cropName': 'Кукурудза',
                'year': 2024,
                'planting': '2024-05-01',
                'irrigationMm': 150,
                'irrigationKnown': True,
                'scaleHa': 45.2,
            },
            'status': 'good',
            'statusLabel': 'Підходить',
            'reportedScore': 79.4,
            'verdictText': 'Підсумковий індекс придатності становить 79.4 / 100. Обмежувач — доступність води.',
            'profile': {
                'name': 'Кукурудза',
                'stages': [30, 40, 50, 30],
                'kc': [0.3, 1.2, 0.35],
                'temperature': [8, 18, 30, 42],
                'ph': [4.5, 6, 7, 8.5],
                'frost': 0,
                'heat': 36,
            },
            'landcover': {'year': 2024, 'code': 1, 'label': 'Corn', 'allow_analysis': True},
            'factorSteps': [
                {'key': 'water', 'label': 'Доступність води', 'weightPct': 30, 'score': 0.717, 'formulaTemplate': 'clamp((0.8*P+I)/ETc)', 'inputsText': 'P=350, I=150, ETc=600', 'substituted': '0.717', 'logText': '-0.0998', 'isLimiting': True},
                {'key': 'temperature', 'label': 'Температура', 'weightPct': 20, 'score': 0.933, 'formulaTemplate': 'trapezoid(T)', 'inputsText': 'T=23.5 C', 'substituted': '0.933', 'logText': '-0.0139', 'isLimiting': False},
                {'key': 'ph', 'label': 'Кислотність pH', 'weightPct': 15, 'score': 1.0, 'formulaTemplate': 'trapezoid(pH)', 'inputsText': 'pH=6.4', 'substituted': '1.000', 'logText': '0', 'isLimiting': False},
                {'key': 'awc', 'label': 'AWC', 'weightPct': 10, 'score': 1.0, 'formulaTemplate': 'clamp(AWC/0.15)', 'inputsText': 'AWC=0.16', 'substituted': '1.000', 'logText': '0', 'isLimiting': False},
                {'key': 'drainage', 'label': 'Дренаж', 'weightPct': 10, 'score': 1.0, 'formulaTemplate': 'table', 'inputsText': 'Well drained', 'substituted': '1.00', 'logText': '0', 'isLimiting': False},
                {'key': 'slope', 'label': 'Нахил', 'weightPct': 10, 'score': 0.9, 'formulaTemplate': 'clamp((20-s)/18)', 'inputsText': 'slope=3.8%', 'substituted': '0.900', 'logText': '-0.0105', 'isLimiting': False},
                {'key': 'texture', 'label': 'Склад ґрунту', 'weightPct': 5, 'score': 1.0, 'formulaTemplate': 'min(...)', 'inputsText': 'sand=30, clay=25', 'substituted': '1.000', 'logText': '0', 'isLimiting': False},
            ],
            'aggregation': {
                'allSevenScored': True,
                'hasZeroFactor': False,
                'sumWeightedLog': -0.1242,
                'geometricMean': 88.3,
                'minFactorValue': 0.717,
                'criticalCeilingApplied': False,
                'computedFinalScore': 88.3,
                'formulaGeometric': 'G = 100 * exp(sum(w_i * ln(f_i)))',
                'formulaCeiling': 'min(f_i) < 0.10',
            },
            'historicalWater': {
                'effectiveRainMm': 280.0,
                'irrigationMm': 150.0,
                'demandMm': 600.0,
                'deficitMm': 170.0,
                'formulaText': 'Баланс = (280 + 150) - 600 = -170 мм',
            },
            'planning': {
                'sevenDayFormula': {'equationText': 'ETc_7d = 42 мм'},
                'sowingSoilCheck': {'summary': 'Ґрунт достатньо прогрітий.'},
                'criticalGaps': [],
            },
            'fiveYear': {
                'landcoverHistory': {
                    'years': [{'year': 2024, 'crop_name': 'Кукурудза', 'category': 'cropland'}],
                    'monoculture_alert': False,
                    'diagnosis': 'Збалансована сівозміна.',
                },
                'climateRisk': {
                    'years': [{'year': 2024, 'score': 79.4, 'precipitation_mm': 350, 'heat_days': 6}],
                },
            },
            'cropComparison': [
                {'crop': 'corn', 'name': 'Кукурудза', 'score': 79.4, 'deficit_mm': 170, 'limiting_factor': 'water', 'economics': {'cost_per_ha': 900, 'price_per_tonne': 185}},
            ],
            'missingList': [],
        }
        pdf_bytes = generate_report_pdf(payload)
        self.assertIsInstance(pdf_bytes, bytes)
        self.assertTrue(pdf_bytes.startswith(b'%PDF-1.'))
        self.assertGreater(len(pdf_bytes), 5000)

    def test_generate_report_pdf_rejects_non_dict(self):
        with self.assertRaises(ValueError):
            generate_report_pdf(['invalid'])


if __name__ == '__main__':
    unittest.main()
