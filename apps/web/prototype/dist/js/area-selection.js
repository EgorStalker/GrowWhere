const EARTH_RADIUS_M = 6371008.8;
const DEG_TO_RAD = Math.PI / 180;

export function polygonBounds(ring) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}

export function boundsAreaSqDeg(bbox) {
  if (!bbox || bbox.length !== 4) return 0;
  return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}

export function recommendedZoomForArea(bbox, currentZoom = 7) {
  const area = boundsAreaSqDeg(bbox);
  if (area <= 0.15) return Math.max(Math.round(currentZoom), 12);
  if (area <= 0.8) return Math.min(Math.max(Math.round(currentZoom), 9), 11);
  return Math.min(Math.round(currentZoom), 11);
}

export function ringAreaSqMeters(ring) {
  if (!ring || ring.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % ring.length];
    total += (lon2 - lon1) * DEG_TO_RAD * (2 + Math.sin(lat1 * DEG_TO_RAD) + Math.sin(lat2 * DEG_TO_RAD));
  }
  return Math.abs(total * EARTH_RADIUS_M * EARTH_RADIUS_M / 2);
}

export function geodesicAreaHa(ring) {
  return ringAreaSqMeters(ring) / 10000;
}

export function geometryAreaSqMeters(geometry) {
  if (!geometry) return 0;
  if (geometry.type === 'Polygon') {
    const outer = ringAreaSqMeters(geometry.coordinates[0]);
    const holes = geometry.coordinates.slice(1).reduce((sum, hole) => sum + ringAreaSqMeters(hole), 0);
    return Math.max(0, outer - holes);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.reduce((sum, poly) => sum + geometryAreaSqMeters({type: 'Polygon', coordinates: poly}), 0);
  }
  return 0;
}

export function ringContainsPoint(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

export function polygonContainsPoint(polygon, x, y) {
  return ringContainsPoint(polygon[0], x, y) && !polygon.slice(1).some(hole => ringContainsPoint(hole, x, y));
}

export function geometryContainsPoint(geometry, x, y) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return polygonContainsPoint(geometry.coordinates, x, y);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some(poly => polygonContainsPoint(poly, x, y));
  return false;
}

function orientation(ax, ay, bx, by, cx, cy) {
  const val = (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
  if (Math.abs(val) < 1e-12) return 0;
  return val > 0 ? 1 : 2;
}

function onSegment(ax, ay, bx, by, cx, cy) {
  return bx <= Math.max(ax, cx) + 1e-12 && bx >= Math.min(ax, cx) - 1e-12 &&
         by <= Math.max(ay, cy) + 1e-12 && by >= Math.min(ay, cy) - 1e-12;
}

function segmentsIntersect(a1, a2, b1, b2) {
  const [ax1, ay1] = a1, [ax2, ay2] = a2, [bx1, by1] = b1, [bx2, by2] = b2;
  const o1 = orientation(ax1, ay1, ax2, ay2, bx1, by1);
  const o2 = orientation(ax1, ay1, ax2, ay2, bx2, by2);
  const o3 = orientation(bx1, by1, bx2, by2, ax1, ay1);
  const o4 = orientation(bx1, by1, bx2, by2, ax2, ay2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(ax1, ay1, bx1, by1, ax2, ay2)) return true;
  if (o2 === 0 && onSegment(ax1, ay1, bx2, by2, ax2, ay2)) return true;
  if (o3 === 0 && onSegment(bx1, by1, ax1, ay1, bx2, by2)) return true;
  if (o4 === 0 && onSegment(bx1, by1, ax2, ay2, bx2, by2)) return true;
  return false;
}

function ringIntersectsRing(ringA, ringB) {
  const bA = polygonBounds(ringA);
  const bB = polygonBounds(ringB);
  if (bA[2] < bB[0] || bA[0] > bB[2] || bA[3] < bB[1] || bA[1] > bB[3]) return false;
  if (ringA.some(([x, y]) => ringContainsPoint(ringB, x, y))) return true;
  if (ringB.some(([x, y]) => ringContainsPoint(ringA, x, y))) return true;
  for (let i = 0; i < ringA.length; i++) {
    const a2 = ringA[(i + 1) % ringA.length];
    for (let j = 0; j < ringB.length; j++) {
      const b2 = ringB[(j + 1) % ringB.length];
      if (segmentsIntersect(ringA[i], a2, ringB[j], b2)) return true;
    }
  }
  return false;
}

export function geometryIntersectsRing(geometry, areaRing) {
  if (!geometry || !areaRing?.length) return false;
  if (geometry.type === 'Polygon') {
    if (!ringIntersectsRing(geometry.coordinates[0], areaRing)) return false;
    // If all vertices of areaRing sit inside a hole, there is no actual overlap.
    const holes = geometry.coordinates.slice(1);
    if (holes.length && areaRing.every(([x, y]) => holes.some(h => ringContainsPoint(h, x, y))) &&
        !geometry.coordinates[0].some(([x, y]) => ringContainsPoint(areaRing, x, y))) {
      return false;
    }
    return true;
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some(poly => geometryIntersectsRing({type: 'Polygon', coordinates: poly}, areaRing));
  }
  return false;
}

function numericRange(values) {
  const valid = values.filter(v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))).map(Number);
  if (!valid.length) return null;
  return [Math.min(...valid), Math.max(...valid)];
}

export function aggregateTerritory(features, areaRing) {
  const list = Array.isArray(features) ? features : [];
  const intersecting = areaRing?.length
    ? list.filter(feature => geometryIntersectsRing(feature.geometry, areaRing))
    : list;

  const counts = {good: 0, conditional: 0, poor: 0, unknown: 0, excluded: 0};
  const missingSet = new Set();
  const factorSums = {};
  const factorWeights = {};
  let weightedScoreSum = 0;
  let weightSum = 0;
  let scoredCount = 0;
  let wbRain = 0, wbIrr = 0, wbDemand = 0, wbCount = 0;

  for (const feature of intersecting) {
    const result = feature.properties?.result;
    const status = result?.status || 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    for (const key of (result?.missing || [])) missingSet.add(key);
    const score = result?.score;
    const areaWeight = Math.max(1, geometryAreaSqMeters(feature.geometry));
    if (score !== null && score !== undefined && Number.isFinite(Number(score))) {
      weightedScoreSum += Number(score) * areaWeight;
      weightSum += areaWeight;
      scoredCount += 1;
      for (const [fk, fv] of Object.entries(result?.factors || {})) {
        if (fv !== null && fv !== undefined && Number.isFinite(Number(fv))) {
          factorSums[fk] = (factorSums[fk] ?? 0) + Number(fv) * areaWeight;
          factorWeights[fk] = (factorWeights[fk] ?? 0) + areaWeight;
        }
      }
      const wb = result?.water_balance;
      if (wb && Number.isFinite(Number(wb.demand_mm))) {
        wbRain += Number(wb.effective_rain_mm || 0);
        wbIrr += Number(wb.irrigation_mm || 0);
        wbDemand += Number(wb.demand_mm || 0);
        wbCount += 1;
      }
    }
  }

  const avgFactors = {};
  for (const [fk, fsum] of Object.entries(factorSums)) {
    if (factorWeights[fk] > 0) avgFactors[fk] = Math.round((fsum / factorWeights[fk]) * 1000) / 1000;
  }
  const avgWaterBalance = wbCount > 0 ? {
    effective_rain_mm: Math.round((wbRain / wbCount) * 10) / 10,
    irrigation_mm: Math.round((wbIrr / wbCount) * 10) / 10,
    demand_mm: Math.round((wbDemand / wbCount) * 10) / 10,
  } : null;

  const totalCount = intersecting.length;
  let status = 'unknown';
  let score = null;
  let reason = null;

  if (totalCount === 0) {
    status = 'unknown';
    reason = 'no_features';
  } else if (counts.excluded === totalCount) {
    status = 'excluded';
    reason = 'all_excluded';
  } else if (counts.unknown > 0) {
    status = 'unknown';
    reason = 'partial_unknown';
  } else if (scoredCount === 0) {
    status = 'unknown';
    reason = 'no_scored';
  } else {
    score = Math.round(weightedScoreSum / weightSum);
    status = score >= 70 ? 'good' : score >= 40 ? 'conditional' : 'poor';
    reason = 'scored';
  }

  return {
    status,
    score,
    counts,
    totalCount,
    scoredCount,
    intersectingFeatures: intersecting,
    intersectingIds: new Set(intersecting.map(f => String(f.properties?.id ?? f.id))),
    areaHa: areaRing?.length ? geodesicAreaHa(areaRing) : 0,
    soilPhRange: numericRange(intersecting.map(f => f.properties?.soil?.ph)),
    tempRange: numericRange(intersecting.map(f => f.properties?.climate?.mean_temperature)),
    precipRange: numericRange(intersecting.map(f => f.properties?.climate?.precipitation_mm)),
    waterDemandRange: numericRange(intersecting.map(f => f.properties?.climate?.crop_water_demand_mm)),
    avgFactors,
    avgWaterBalance,
    missingKeys: Array.from(missingSet),
    reason,
  };
}
