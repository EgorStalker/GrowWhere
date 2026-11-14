import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  polygonBounds,
  boundsAreaSqDeg,
  recommendedZoomForArea,
  geodesicAreaHa,
  geometryIntersectsRing,
  aggregateTerritory,
} from '../dist/js/area-selection.js';

function rectFeature(id, w, s, e, n, status, score, extraProps = {}) {
  return {
    type: 'Feature',
    id,
    geometry: {
      type: 'Polygon',
      coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
    },
    properties: {
      id,
      result: {status, score, missing: status === 'unknown' ? ['soil'] : []},
      ...extraProps,
    },
  };
}

test('polygonBounds and boundsAreaSqDeg compute bounding box accurately', () => {
  const ring = [[-98.5, 38.0], [-98.2, 38.0], [-98.2, 38.3], [-98.5, 38.3], [-98.5, 38.0]];
  const bbox = polygonBounds(ring);
  assert.deepEqual(bbox, [-98.5, 38.0, -98.2, 38.3]);
  assert.ok(Math.abs(boundsAreaSqDeg(bbox) - 0.09) < 1e-9);
});

test('recommendedZoomForArea selects soil polygon zoom for small areas and grid zoom for large areas', () => {
  assert.equal(recommendedZoomForArea([-98.2, 38.0, -98.0, 38.2], 7), 12);
  assert.equal(recommendedZoomForArea([-98.2, 38.0, -98.0, 38.2], 14), 14);
  assert.equal(recommendedZoomForArea([-99.5, 37.5, -97.5, 39.5], 13), 11);
  assert.equal(recommendedZoomForArea([-99.5, 37.5, -97.5, 39.5], 7), 7);
});

test('geodesicAreaHa gives realistic positive area in Kansas', () => {
  // ~0.01 deg x 0.01 deg at 38N is roughly 1.11 km x 0.87 km ≈ 97 ha
  const ring = [[-98.01, 38.0], [-98.0, 38.0], [-98.0, 38.01], [-98.01, 38.01], [-98.01, 38.0]];
  const ha = geodesicAreaHa(ring);
  assert.ok(ha > 85 && ha < 110, `expected ~97 ha, got ${ha}`);
});

test('geometryIntersectsRing handles overlapping, contained, and disjoint polygons', () => {
  const areaRing = [[-98.2, 38.1], [-98.1, 38.1], [-98.1, 38.2], [-98.2, 38.2], [-98.2, 38.1]];
  const inside = rectFeature('in', -98.18, 38.12, -98.12, 38.18, 'good', 82).geometry;
  const enclosing = rectFeature('big', -99.0, 37.5, -97.5, 39.0, 'conditional', 55).geometry;
  const edgeCross = rectFeature('cross', -98.15, 38.05, -98.05, 38.15, 'poor', 30).geometry;
  const disjoint = rectFeature('out', -97.5, 38.1, -97.4, 38.2, 'good', 90).geometry;

  assert.equal(geometryIntersectsRing(inside, areaRing), true);
  assert.equal(geometryIntersectsRing(enclosing, areaRing), true);
  assert.equal(geometryIntersectsRing(edgeCross, areaRing), true);
  assert.equal(geometryIntersectsRing(disjoint, areaRing), false);
});

test('aggregateTerritory computes area-weighted score and status while preserving breakdown', () => {
  const areaRing = [[-98.2, 38.0], [-98.0, 38.0], [-98.0, 38.2], [-98.2, 38.2], [-98.2, 38.0]];
  const features = [
    rectFeature('f1', -98.2, 38.0, -98.1, 38.2, 'good', 84, {soil: {ph: 6.5}, climate: {mean_temperature: 20, precipitation_mm: 400, crop_water_demand_mm: 450}, result: {status: 'good', score: 84, missing: [], factors: {water: 0.9, temperature: 1.0}, water_balance: {effective_rain_mm: 320, irrigation_mm: 100, demand_mm: 450}}}),
    rectFeature('f2', -98.1, 38.0, -98.0, 38.1, 'conditional', 60, {soil: {ph: 7.1}, climate: {mean_temperature: 21, precipitation_mm: 390, crop_water_demand_mm: 460}, result: {status: 'conditional', score: 60, missing: [], factors: {water: 0.6, temperature: 0.7}, water_balance: {effective_rain_mm: 300, irrigation_mm: 100, demand_mm: 460}}}),
    rectFeature('f3', -98.1, 38.1, -98.0, 38.2, 'unknown', null),
    rectFeature('outside', -97.0, 38.0, -96.9, 38.1, 'poor', 10),
  ];

  const summary = aggregateTerritory(features, areaRing);
  assert.equal(summary.totalCount, 3);
  assert.equal(summary.scoredCount, 2);
  assert.deepEqual(summary.counts, {good: 1, conditional: 1, poor: 0, unknown: 1, excluded: 0});
  // f1 has 2x the area of f2 -> (84*2 + 60*1)/3 = 76 -> 'good'
  assert.equal(summary.score, null);
  assert.equal(summary.status, 'unknown');
  assert.equal(summary.reason, 'partial_unknown');
  assert.deepEqual(summary.soilPhRange, [6.5, 7.1]);
  assert.deepEqual(summary.missingKeys, ['soil']);
  assert.equal(summary.avgFactors.water, 0.8);
  assert.equal(summary.avgFactors.temperature, 0.9);
  assert.equal(summary.avgWaterBalance.irrigation_mm, 100);

  // The intersecting units retain their weighted score when none are unknown.
  const completeSummary = aggregateTerritory(features.filter(f=>f.id!=='f3'), areaRing);
  assert.equal(completeSummary.score, 76);
  assert.equal(completeSummary.status, 'good');
});

test('aggregateTerritory returns excluded when all intersecting zones are excluded and unknown when empty', () => {
  const areaRing = [[-98.2, 38.0], [-98.0, 38.0], [-98.0, 38.2], [-98.2, 38.2], [-98.2, 38.0]];
  const excludedOnly = [rectFeature('ex', -98.15, 38.05, -98.05, 38.15, 'excluded', null)];

  const excludedSummary = aggregateTerritory(excludedOnly, areaRing);
  assert.equal(excludedSummary.status, 'excluded');
  assert.equal(excludedSummary.score, null);
  assert.equal(excludedSummary.reason, 'all_excluded');

  const emptySummary = aggregateTerritory([], areaRing);
  assert.equal(emptySummary.status, 'unknown');
  assert.equal(emptySummary.score, null);
  assert.equal(emptySummary.reason, 'no_features');
});
