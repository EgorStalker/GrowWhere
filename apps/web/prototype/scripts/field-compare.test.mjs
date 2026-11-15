import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFieldSnapshot,
  compareTwoFields,
  renderFieldCompareDialogHtml
} from '../dist/js/field-compare.js';

test('compareTwoFields scores clear winner across suitability, deficit, climate stability, and rotation', () => {
  const fieldA = createFieldSnapshot({
    label: 'Поле Північне',
    crop: 'corn',
    cropName: 'Кукурудза',
    year: 2024,
    areaHa: 45,
    coordinates: [-97.5, 38.5],
    status: 'good',
    score: 82.5,
    factors: {water: 0.82, temperature: 0.91, ph: 1, awc: 0.95, drainage: 1, slope: 0.95, texture: 1},
    limitingFactor: 'water',
    waterBalance: {effective_rain_mm: 320, irrigation_mm: 120, demand_mm: 520},
    soil: {ph: 6.5},
    landcoverHistory: {years_requested: 5, unique_crops: 3, monoculture_alert: false},
    climateRisk: {summary: {good_count: 4, conditional_count: 1, years_scored: 5, heat_stress_years: 0}}
  });

  const fieldB = createFieldSnapshot({
    label: 'Поле Південне <script>',
    crop: 'corn',
    cropName: 'Кукурудза',
    year: 2024,
    areaHa: 42,
    coordinates: [-98.2, 38.1],
    status: 'conditional',
    score: 58.0,
    factors: {water: 0.48, temperature: 0.85, ph: 0.72, awc: 0.75, drainage: 0.8, slope: 0.85, texture: 0.9},
    limitingFactor: 'water',
    waterBalance: {effective_rain_mm: 210, irrigation_mm: 120, demand_mm: 560},
    soil: {ph: 5.1},
    landcoverHistory: {years_requested: 5, unique_crops: 1, monoculture_alert: true, monoculture_crop: 'Кукурудза', monoculture_streak: 4},
    climateRisk: {summary: {good_count: 1, conditional_count: 2, years_scored: 5, heat_stress_years: 3}}
  });

  const cmp = compareTwoFields(fieldA, fieldB);
  assert.equal(cmp.overallWinner, 'A');
  assert.ok(cmp.winsA >= 7);
  assert.equal(cmp.winsB, 0);
  assert.equal(cmp.scopeWarning, null);

  const html = renderFieldCompareDialogHtml(cmp);
  assert.ok(html.includes('Кращий баланс'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('compareTwoFields warns when crops or years differ', () => {
  const a = createFieldSnapshot({label: 'A', crop: 'corn', year: 2024, status: 'good', score: 75});
  const b = createFieldSnapshot({label: 'B', crop: 'wheat', year: 2023, status: 'good', score: 74});
  const cmp = compareTwoFields(a, b);
  assert.ok(cmp.scopeWarning && cmp.scopeWarning.includes('різних параметрів'));
});
