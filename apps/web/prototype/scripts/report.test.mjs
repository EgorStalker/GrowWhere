import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCalculationReport,
  renderReportDialogHtml,
  renderStandaloneReportDocument,
  trapezoidScore
} from '../dist/js/report.js';

function sampleZone() {
  return {
    type: 'Feature',
    properties: {
      id: 'zone-42',
      ui_label: 'Зона №42',
      center: [-97.5, 38.5],
      landcover: {year: 2024, code: 1, label: 'Corn', category: 'cropland', allow_analysis: true},
      soil: {ph: 6.4, awc: 0.16, slope: 3.8, sand: 30, clay: 25, drainage: 'Well drained'},
      climate: {
        mean_temperature: 23.5,
        precipitation_mm: 350,
        crop_water_demand_mm: 600,
        heat_days: 6,
        frost_days: 0,
        surface_wetness: 0.52,
        root_zone_wetness: 0.58,
        dry_root_days: 12
      },
      result: {
        status: 'good',
        score: 79.4,
        limiting_factor: 'water',
        factors: {
          water: 0.717,
          temperature: 0.933,
          ph: 1,
          awc: 1,
          drainage: 1,
          slope: 0.9,
          texture: 1
        },
        water_balance: {
          effective_rain_mm: 280,
          irrigation_mm: 150,
          demand_mm: 600
        },
        missing: []
      }
    }
  };
}

test('trapezoidScore matches piecewise linear suitability curve', () => {
  assert.equal(trapezoidScore(5, [8, 18, 30, 42]), 0);
  assert.equal(trapezoidScore(24, [8, 18, 30, 42]), 1);
  assert.ok(Math.abs(trapezoidScore(13, [8, 18, 30, 42]) - 0.5) < 1e-9);
  assert.ok(Math.abs(trapezoidScore(36, [8, 18, 30, 42]) - 0.5) < 1e-9);
});

test('buildCalculationReport reconstructs 7 factors, substituted formulas, and weighted geometric mean', () => {
  const report = buildCalculationReport({
    crop: 'corn',
    cropName: 'Кукурудза',
    year: 2024,
    planting: '2024-05-01',
    irrigationMode: 'yes',
    irrigationMm: 150,
    irrigationKnown: true,
    mode: 'own_land',
    selected: sampleZone(),
    insights: {
      landcover_history: {
        years_requested: 5,
        years: [
          {year: 2020, category: 'cropland', label: 'Soybeans', crop_name: 'Соя'},
          {year: 2021, category: 'cropland', label: 'Corn', crop_name: 'Кукурудза'},
          {year: 2022, category: 'cropland', label: 'Winter Wheat', crop_name: 'Яра пшениця'},
          {year: 2023, category: 'cropland', label: 'Soybeans', crop_name: 'Соя'},
          {year: 2024, category: 'cropland', label: 'Corn', crop_name: 'Кукурудза'}
        ],
        monoculture_alert: false,
        diagnosis: 'Збалансована сівозміна.'
      },
      climate_risk: {
        years_scored: 5,
        years: [{year: 2024, score: 79.4, status: 'good', precipitation_mm: 350, heat_days: 6}],
        summary: {good_count: 3, conditional_count: 2, years_scored: 5}
      },
      crop_comparison: [
        {crop: 'corn', name: 'Кукурудза', score: 79.4, deficit_mm: 170, limiting_factor: 'water', economics: {cost_per_ha: 900, price_per_tonne: 185}}
      ]
    },
    planning: {
      soil_forecast: {available: true, data: {current_soil_temp_6cm_c: 19.2}},
      indicative_guidance: {
        sowing_soil_check: {summary: 'Температура ґрунту достатня.'},
        irrigation_7d_guidance: {
          status: 'calculated_with_user_params',
          et0_7d_mm: 35,
          kc_used: 1.2,
          crop_etc_7d_mm: 42,
          precipitation_7d_mm: 10,
          effective_rain_7d_mm: 8,
          net_deficit_7d_mm: 34,
          system_efficiency: 0.9,
          gross_irrigation_7d_mm: 37.8
        }
      },
      critical_gaps: []
    },
    generatedAt: '2026-11-15T18:00:00Z'
  });

  assert.equal(report.factorSteps.length, 7);
  const waterStep = report.factorSteps.find(s => s.key === 'water');
  assert.equal(waterStep.computed, 0.717);
  assert.ok(waterStep.substituted.includes('0.8 × 350 + 150'));
  assert.equal(waterStep.isLimiting, true);

  const tempStep = report.factorSteps.find(s => s.key === 'temperature');
  assert.equal(tempStep.computed, 0.933);

  const slopeStep = report.factorSteps.find(s => s.key === 'slope');
  assert.equal(slopeStep.computed, 0.9);

  assert.equal(report.aggregation.allSevenScored, true);
  assert.equal(report.aggregation.criticalCeilingApplied, false);
  assert.ok(Math.abs(report.aggregation.geometricMean - 88.2) < 1.5);
  assert.equal(report.historicalWater.deficitMm, 170);
  assert.ok(report.planning.sevenDayFormula.equationText.includes('35 × 1,2 = 42 мм'));
  assert.equal(report.fiveYear.landcoverHistory.years.length, 5);
});

test('critical factor < 0.10 triggers ceiling cap formula', () => {
  const zone = sampleZone();
  zone.properties.soil.ph = 4.55;
  zone.properties.result.factors.ph = 0.033;
  zone.properties.result.score = 18.2;
  zone.properties.result.status = 'poor';
  zone.properties.result.limiting_factor = 'ph';

  const report = buildCalculationReport({
    crop: 'corn',
    year: 2024,
    planting: '2024-05-01',
    irrigationKnown: true,
    irrigationMm: 150,
    selected: zone
  });

  assert.equal(report.aggregation.criticalCeilingApplied, true);
  assert.equal(report.aggregation.minFactorKey, 'ph');
  assert.ok(report.aggregation.ceilingValue <= 18.5 && report.aggregation.ceilingValue >= 18.0);
  assert.ok(report.verdictText.includes('стеля критичного мінімуму'));
});

test('area aggregate mode and standalone HTML export render cleanly and escape unsafe text', () => {
  const report = buildCalculationReport({
    crop: 'wheat',
    year: 2023,
    planting: '2023-03-15',
    irrigationKnown: false,
    areaSummary: {
      status: 'conditional',
      score: 64,
      areaHa: 120.5,
      totalCount: 6,
      scoredCount: 5,
      coveragePct: 85,
      counts: {good: 2, conditional: 3, poor: 0, unknown: 1, excluded: 0},
      soilPhRange: [6.1, 6.9],
      tempRange: [15.2, 16.4],
      avgFactors: {water: 0.55, temperature: 0.88, ph: 0.95, awc: 0.9, drainage: 0.85, slope: 1, texture: 1},
      avgWaterBalance: {effective_rain_mm: 180, irrigation_mm: 0, demand_mm: 410},
      missingKeys: ['irrigation']
    },
    insights: {
      landcover_history: {
        years: [{year: 2023, category: 'cropland', label: '<script>alert(1)</script>'}],
        diagnosis: 'Тест <img onerror=x>'
      }
    }
  });

  assert.equal(report.isAreaAggregate, true);
  assert.equal(report.areaBreakdown.areaHa, 120.5);
  const dialogHtml = renderReportDialogHtml(report);
  const standalone = renderStandaloneReportDocument(report);
  assert.ok(dialogHtml.includes('data-action="download-report-pdf"'));
  assert.ok(!dialogHtml.includes('print-report'));
  assert.ok(!dialogHtml.includes('data-action="download-report"'));
  assert.ok(standalone.startsWith('<!DOCTYPE html>'));
  assert.ok(!standalone.includes('<script>alert(1)</script>'));
  assert.ok(!standalone.includes('<img onerror=x>'));
  assert.ok(standalone.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});
