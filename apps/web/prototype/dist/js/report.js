import {copy,tr,fmt,dateTime,forecastOverview,agronomicRuleOverview} from './live-i18n.js';

export const METHOD_VERSION = 'growwhere-screening-0.2';

export const CROP_PROFILES = {
  wheat: {name: 'Яра пшениця', stages: [20, 25, 60, 30], kc: [0.3, 1.15, 0.3], temperature: [0, 12, 24, 36], ph: [4.5, 5.5, 7, 8.5], frost: -3, heat: 35, default_planting: '03-15'},
  soy: {name: 'Соя', stages: [20, 35, 60, 25], kc: [0.4, 1.15, 0.5], temperature: [8, 20, 30, 40], ph: [4.5, 6, 7, 8.5], frost: 0, heat: 36, default_planting: '05-01'},
  corn: {name: 'Кукурудза', stages: [30, 40, 50, 30], kc: [0.3, 1.2, 0.35], temperature: [8, 18, 30, 42], ph: [4.5, 6, 7, 8.5], frost: 0, heat: 36, default_planting: '05-01'},
  sorghum: {name: 'Сорго', stages: [20, 35, 45, 30], kc: [0.3, 1.05, 0.55], temperature: [10, 20, 32, 43], ph: [5.0, 5.8, 7.5, 8.5], frost: 0, heat: 39, default_planting: '05-15'},
  barley: {name: 'Ярий ячмінь', stages: [20, 25, 50, 30], kc: [0.3, 1.15, 0.25], temperature: [0, 11, 23, 36], ph: [5.0, 6.0, 7.8, 8.5], frost: -3, heat: 35, default_planting: '03-15'},
  oats: {name: 'Овес', stages: [20, 30, 50, 30], kc: [0.3, 1.15, 0.25], temperature: [0, 10, 22, 35], ph: [4.5, 5.5, 7.2, 8.2], frost: -3, heat: 34, default_planting: '03-15'},
  cotton: {name: 'Бавовник', stages: [30, 50, 55, 45], kc: [0.35, 1.18, 0.6], temperature: [12, 22, 33, 44], ph: [5.0, 5.8, 7.8, 8.5], frost: 0, heat: 39, default_planting: '04-20'}
};

export const FACTOR_WEIGHTS = {
  water: 0.30,
  temperature: 0.20,
  ph: 0.15,
  awc: 0.10,
  drainage: 0.10,
  slope: 0.10,
  texture: 0.05
};

export const DRAINAGE_SCORES = {
  'Excessively drained': 0.65,
  'Somewhat excessively drained': 0.80,
  'Well drained': 1.00,
  'Moderately well drained': 0.85,
  'Somewhat poorly drained': 0.55,
  'Poorly drained': 0.25,
  'Very poorly drained': 0.00
};

const FACTOR_ORDER = ['water', 'temperature', 'ph', 'awc', 'drainage', 'slope', 'texture'];

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const num = value => (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) ? Number(value) : null;
const clamp = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));
const roundTo = (value, digits = 3) => {
  const n = num(value);
  if (n === null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
const fNum = (value, digits = 2) => {
  const n = num(value);
  return n === null ? '—' : new Intl.NumberFormat('uk-UA', {maximumFractionDigits: digits}).format(n);
};

export function trapezoidScore(value, [a, b, c, d]) {
  const x = num(value);
  if (x === null) return null;
  if (x <= a || x >= d) return 0;
  if (b <= x && x <= c) return 1;
  if (x < b) return b > a ? clamp((x - a) / (b - a)) : 0;
  return d > c ? clamp((d - x) / (d - c)) : 0;
}

function buildFactorStep({key, weight, recordedValue, soil, climate, profile, irrigationMm, irrigationKnown, limitingFactor, isAreaAggregate}) {
  const label = tr(`factorNames.${key}`, key);
  const weightPct = Math.round(weight * 100);
  const reported = num(recordedValue);
  let formulaTemplate = '';
  let substituted = '';
  let computed = null;
  let inputsText = '';

  if (key === 'water') {
    const P = num(climate?.precipitation_mm);
    const ETc = num(climate?.crop_water_demand_mm);
    const I = irrigationKnown ? (num(irrigationMm) ?? 0) : null;
    formulaTemplate = 'f_water = clamp((0.8 × P_mm + I_mm) / ETc_mm, 0, 1)';
    if (isAreaAggregate) {
      const effP = num(climate?.effective_rain_mm);
      const avgI = num(climate?.irrigation_mm);
      const avgD = num(climate?.demand_mm);
      if (effP !== null && avgD !== null && avgD > 0) {
        inputsText = `Середній баланс: 0.8×P ≈ ${fNum(effP, 1)} мм, полив = ${irrigationKnown ? fNum(avgI, 1) : 'не задано'} мм, ETc ≈ ${fNum(avgD, 1)} мм`;
        substituted = `Середньозважено по ${key}: f_water ≈ ${fNum(reported, 3)} (приблизний баланс (${fNum(effP, 1)} + ${fNum(avgI ?? 0, 1)}) / ${fNum(avgD, 1)})`;
      } else {
        inputsText = 'Опади, сценарій поливу та ETc для зон контуру';
        substituted = reported !== null ? `f_water (середньозважений по площах зон) = ${fNum(reported, 3)}` : 'Недостатньо даних';
      }
    } else if (P !== null && ETc !== null && ETc > 0 && I !== null) {
      const effP = 0.8 * P;
      const ratio = (effP + I) / ETc;
      computed = roundTo(clamp(ratio), 3);
      inputsText = `P_mm = ${fNum(P, 1)} мм, I_mm = ${fNum(I, 1)} мм, ETc_mm = ${fNum(ETc, 1)} мм`;
      substituted = `clamp((0.8 × ${fNum(P, 1)} + ${fNum(I, 1)}) / ${fNum(ETc, 1)}) = clamp(${fNum(effP + I, 1)} / ${fNum(ETc, 1)}) = ${fNum(ratio, 3)} → ${fNum(computed, 3)}`;
    } else if (!irrigationKnown) {
      inputsText = `P_mm = ${P !== null ? `${fNum(P, 1)} мм` : '—'}, I_mm = не визначено, ETc_mm = ${ETc !== null ? `${fNum(ETc, 1)} мм` : '—'}`;
      substituted = 'Полив позначено як «Ще не знаю» — фактор води не зафіксовано (required: irrigation_known).';
    } else {
      inputsText = `P_mm = ${fNum(P, 1)}, ETc_mm = ${fNum(ETc, 1)}`;
      substituted = 'Бракує повного сезону опадів або ET0 NASA POWER.';
    }
  } else if (key === 'temperature') {
    const T = num(climate?.mean_temperature);
    const H = num(climate?.heat_days) ?? 0;
    const F = num(climate?.frost_days) ?? 0;
    const expectedDays = profile ? profile.stages.reduce((a, b) => a + b, 0) : null;
    const bounds = profile?.temperature;
    formulaTemplate = 'f_temp = trapezoid(T_mean, [a,b,c,d]) × clamp(1 − H/(D×0.6)) × clamp(1 − F/(D×0.15))';
    if (isAreaAggregate) {
      inputsText = `Температурний профіль [${bounds?.join(', ') ?? '—'}] °C, поріг спеки > ${profile?.heat ?? '—'} °C, заморозки < ${profile?.frost ?? '—'} °C`;
      substituted = reported !== null ? `f_temp (середньозважений по контуру) = ${fNum(reported, 3)}` : 'Недостатньо даних';
    } else if (T !== null && bounds && expectedDays) {
      const base = trapezoidScore(T, bounds);
      const heatStress = clamp(1 - H / (expectedDays * 0.6));
      const frostStress = clamp(1 - F / (expectedDays * 0.15));
      computed = roundTo(base * heatStress * frostStress, 3);
      inputsText = `T_mean = ${fNum(T, 1)} °C (оптимум ${bounds[1]}–${bounds[2]} °C), дні спеки H = ${fNum(H, 0)}, заморозків F = ${fNum(F, 0)}, тривалість D = ${expectedDays} дн.`;
      substituted = `trapezoid(${fNum(T, 1)}, [${bounds.join(', ')}]) = ${fNum(base, 3)}; тепло-штраф = ${fNum(heatStress, 3)}; холод-штраф = ${fNum(frostStress, 3)} → ${fNum(base, 3)} × ${fNum(heatStress * frostStress, 3)} = ${fNum(computed, 3)}`;
    } else {
      inputsText = `T_mean = ${fNum(T, 1)} °C`;
      substituted = 'Бракує добових температур сезону NASA POWER.';
    }
  } else if (key === 'ph') {
    const ph = num(soil?.ph);
    const bounds = profile?.ph;
    formulaTemplate = 'f_ph = trapezoid(pH, [a, b, c, d])';
    if (isAreaAggregate) {
      inputsText = bounds ? `Профіль pH культури: [${bounds.join(', ')}]` : 'USDA SSURGO pH';
      substituted = reported !== null ? `f_ph (середньозважений по контуру) = ${fNum(reported, 3)}` : 'Недостатньо даних';
    } else if (ph !== null && bounds) {
      computed = roundTo(trapezoidScore(ph, bounds), 3);
      inputsText = `SSURGO pH (0–30 см) = ${fNum(ph, 2)}, діапазон [${bounds.join(', ')}]`;
      substituted = `trapezoid(${fNum(ph, 2)}, [${bounds.join(', ')}]) = ${fNum(computed, 3)}`;
    } else {
      inputsText = 'SSURGO pH (0–30 см)';
      substituted = 'Бракує pH у USDA SSURGO.';
    }
  } else if (key === 'awc') {
    const awc = num(soil?.awc);
    formulaTemplate = 'f_awc = clamp(AWC / 0.15, 0, 1)';
    if (isAreaAggregate) {
      inputsText = 'USDA SSURGO AWC (доступна вологоємність)';
      substituted = reported !== null ? `f_awc (середньозважений по контуру) = ${fNum(reported, 3)}` : 'Недостатньо даних';
    } else if (awc !== null) {
      computed = roundTo(clamp(awc / 0.15), 3);
      inputsText = `AWC = ${fNum(awc, 3)} см/см (еталон ≥ 0.15)`;
      substituted = `clamp(${fNum(awc, 3)} / 0.15) = ${fNum(computed, 3)}`;
    } else {
      inputsText = 'SSURGO AWC';
      substituted = 'Бракує даних AWC у USDA SSURGO.';
    }
  } else if (key === 'drainage') {
    const dr = soil?.drainage;
    formulaTemplate = 'f_drainage = lookup_table(drainage_class)';
    if (isAreaAggregate) {
      inputsText = 'Класифікація дренованості USDA SSURGO';
      substituted = reported !== null ? `f_drainage (середньозважений по контуру) = ${fNum(reported, 3)}` : 'Недостатньо даних';
    } else if (dr && dr in DRAINAGE_SCORES) {
      computed = DRAINAGE_SCORES[dr];
      const ukLabel = tr(`drainageNames.${dr}`, dr);
      inputsText = `Клас дренажу: ${ukLabel} (${dr})`;
      substituted = `table["${dr}"] = ${fNum(computed, 2)}`;
    } else {
      inputsText = `Клас дренажу: ${dr || '—'}`;
      substituted = 'Немає класу дренажу в USDA SSURGO.';
    }
  } else if (key === 'slope') {
    const slope = num(soil?.slope);
    formulaTemplate = 'f_slope = 1 (при slope ≤ 2%), інакше clamp((20 − slope%) / 18, 0, 1)';
    if (isAreaAggregate) {
      inputsText = 'Похил поверхні USDA SSURGO (%)';
      substituted = reported !== null ? `f_slope (середньозважений по контуру) = ${fNum(reported, 3)}` : 'Недостатньо даних';
    } else if (slope !== null) {
      computed = roundTo(slope <= 2 ? 1 : clamp((20 - slope) / 18), 3);
      inputsText = `Похил = ${fNum(slope, 1)}%`;
      substituted = slope <= 2
        ? `${fNum(slope, 1)}% ≤ 2% → 1.000`
        : `clamp((20 − ${fNum(slope, 1)}) / 18) = clamp(${fNum(20 - slope, 1)} / 18) = ${fNum(computed, 3)}`;
    } else {
      inputsText = 'Похил SSURGO';
      substituted = 'Бракує даних нахилу у USDA SSURGO.';
    }
  } else if (key === 'texture') {
    const sand = num(soil?.sand);
    const clay = num(soil?.clay);
    formulaTemplate = 'f_texture = min(1, clamp((95 − sand%) / 20), clamp((75 − clay%) / 25))';
    if (isAreaAggregate) {
      inputsText = 'Гранулометричний склад пісок/глина USDA SSURGO (%)';
      substituted = reported !== null ? `f_texture (середньозважений по контуру) = ${fNum(reported, 3)}` : 'Недостатньо даних';
    } else if (sand !== null && clay !== null) {
      const sPart = clamp((95 - sand) / 20);
      const cPart = clamp((75 - clay) / 25);
      computed = roundTo(Math.min(1, sPart, cPart), 3);
      inputsText = `Пісок = ${fNum(sand, 1)}%, глина = ${fNum(clay, 1)}%`;
      substituted = `min(1, clamp((95 − ${fNum(sand, 1)})/20) = ${fNum(sPart, 3)}, clamp((75 − ${fNum(clay, 1)})/25) = ${fNum(cPart, 3)}) = ${fNum(computed, 3)}`;
    } else {
      inputsText = 'Пісок / глина SSURGO';
      substituted = 'Бракує даних гранулометрії у USDA SSURGO.';
    }
  }

  const effectiveScore = reported ?? computed;
  let weightedLog = null;
  let logText = '—';
  if (effectiveScore !== null) {
    if (effectiveScore <= 0) {
      weightedLog = -Infinity;
      logText = `${fNum(weight, 2)} × ln(0) → -∞ (критичне обнулення)`;
    } else {
      weightedLog = weight * Math.log(effectiveScore);
      logText = `${fNum(weight, 2)} × ln(${fNum(effectiveScore, 3)}) = ${fNum(weightedLog, 4)}`;
    }
  }

  return {
    key,
    label,
    weight,
    weightPct,
    score: effectiveScore,
    computed,
    formulaTemplate,
    inputsText,
    substituted,
    weightedLog,
    logText,
    isLimiting: key === limitingFactor
  };
}

export function buildCalculationReport({
  crop,
  cropName,
  year,
  planting,
  irrigationMode,
  irrigationMm,
  irrigationKnown,
  targetYear,
  scaleHa,
  mode,
  selected,
  areaSummary,
  insights,
  planning,
  economics,
  sources,
  meta,
  generatedAt = new Date().toISOString()
} = {}) {
  const profile = CROP_PROFILES[crop] || null;
  const resolvedCropName = cropName || profile?.name || crop || 'Культура не вказана';
  const weights = meta?.weights || FACTOR_WEIGHTS;
  const isAreaAggregate = !selected && !!areaSummary;
  const activeInsightRow = (insights?.crop_comparison || []).find(r => r.crop === crop) || null;

  const pProps = selected?.properties || {};
  const result = pProps.result || null;
  const soil = pProps.soil || insights?.soil || null;
  const landcover = pProps.landcover || insights?.landcover || null;
  const climate = pProps.climate || (activeInsightRow ? {
    mean_temperature: insights?.climate_risk?.years?.find(y => y.year === Number(year))?.mean_temperature,
    precipitation_mm: activeInsightRow.precipitation_mm,
    crop_water_demand_mm: activeInsightRow.demand_mm,
    surface_wetness: activeInsightRow.surface_wetness,
    root_zone_wetness: activeInsightRow.root_zone_wetness
  } : null);

  const recordedFactors = result?.factors || (isAreaAggregate ? areaSummary?.avgFactors : null) || {};
  const recordedStatus = result?.status || (isAreaAggregate ? areaSummary?.status : activeInsightRow?.status) || 'unknown';
  const reportedScore = num(result?.score) ?? (isAreaAggregate ? num(areaSummary?.score) : num(activeInsightRow?.score));
  const limitingFactor = result?.limiting_factor || activeInsightRow?.limiting_factor || null;
  const missingList = result?.missing || (isAreaAggregate ? areaSummary?.missingKeys : []) || [];

  const waterClimate = isAreaAggregate ? areaSummary?.avgWaterBalance : climate;
  const factorSteps = FACTOR_ORDER.map(key => buildFactorStep({
    key,
    weight: Number(weights[key] ?? FACTOR_WEIGHTS[key]),
    recordedValue: recordedFactors[key],
    soil,
    climate: key === 'water' ? waterClimate : climate,
    profile,
    irrigationMm,
    irrigationKnown,
    limitingFactor,
    isAreaAggregate
  }));

  const scoredFactors = factorSteps.filter(step => step.score !== null);
  const allSevenScored = scoredFactors.length === FACTOR_ORDER.length;
  const hasZeroFactor = scoredFactors.some(step => step.score <= 0);
  let sumWeightedLog = null;
  let geometricMean = null;
  if (allSevenScored && !hasZeroFactor) {
    sumWeightedLog = factorSteps.reduce((acc, s) => acc + s.weightedLog, 0);
    geometricMean = roundTo(100 * Math.exp(sumWeightedLog), 1);
  } else if (hasZeroFactor && allSevenScored) {
    sumWeightedLog = -Infinity;
    geometricMean = 0;
  }

  let minFactorStep = null;
  for (const step of scoredFactors) {
    if (!minFactorStep || step.score < minFactorStep.score) minFactorStep = step;
  }
  const criticalCeilingApplied = minFactorStep !== null && minFactorStep.score < 0.1;
  const ceilingValue = criticalCeilingApplied ? roundTo(100 * Math.sqrt(Math.max(0, minFactorStep.score)), 1) : null;
  const computedFinalScore = geometricMean === null ? null : (criticalCeilingApplied ? roundTo(Math.min(geometricMean, ceilingValue), 1) : geometricMean);

  const center = pProps.center || (insights?.location ? [insights.location.lon, insights.location.lat] : null);
  const scopeLabel = selected
    ? (pProps.ui_label ? `${pProps.ui_label}${pProps.id ? ` (${pProps.id})` : ''}` : (pProps.id || 'Вибрана зона / комірка'))
    : areaSummary
      ? `Виділений контур (${fNum(areaSummary.areaHa, 1)} га)`
      : 'Пілотна область Канзасу';

  // Water balance historical + 7-day forecast formulas
  const wb = result?.water_balance || (isAreaAggregate ? areaSummary?.avgWaterBalance : null) || (activeInsightRow ? {
    effective_rain_mm: num(activeInsightRow.precipitation_mm) !== null ? 0.8 * Number(activeInsightRow.precipitation_mm) : null,
    irrigation_mm: irrigationKnown ? (num(irrigationMm) ?? 0) : null,
    demand_mm: num(activeInsightRow.demand_mm)
  } : null);

  let historicalWater = null;
  if (wb && num(wb.demand_mm) !== null) {
    const effRain = num(wb.effective_rain_mm) ?? 0;
    const irr = irrigationKnown ? (num(wb.irrigation_mm) ?? 0) : 0;
    const demand = num(wb.demand_mm);
    const totalSupply = effRain + irr;
    const balance = roundTo(totalSupply - demand, 1);
    historicalWater = {
      effectiveRainMm: roundTo(effRain, 1),
      irrigationMm: irrigationKnown ? roundTo(irr, 1) : null,
      demandMm: roundTo(demand, 1),
      totalSupplyMm: roundTo(totalSupply, 1),
      balanceMm: balance,
      deficitMm: roundTo(Math.max(0, demand - totalSupply), 1),
      formulaText: `Баланс = (0.8 × P_mm + I_mm) − ETc_mm = (${fNum(effRain, 1)} + ${irrigationKnown ? fNum(irr, 1) : '0'}) − ${fNum(demand, 1)} = ${balance >= 0 ? `+${fNum(balance, 1)}` : fNum(balance, 1)} мм`
    };
  }

  const sf = planning?.soil_forecast;
  const irr7d = planning?.indicative_guidance?.irrigation_7d_guidance;
  const sowCheck = planning?.indicative_guidance?.sowing_soil_check;
  const forecast24h = forecastOverview(planning?.forecast);
  const kStateRule = agronomicRuleOverview(planning?.agronomic_rules);

  let sevenDayFormula = null;
  if (irr7d && num(irr7d.et0_7d_mm) !== null) {
    const et0 = num(irr7d.et0_7d_mm);
    const kc = num(irr7d.kc_used);
    const etc7d = num(irr7d.crop_etc_7d_mm);
    const effRain7d = num(irr7d.effective_rain_7d_mm);
    const netDef = num(irr7d.net_deficit_7d_mm);
    const eff = num(irr7d.system_efficiency);
    const gross = num(irr7d.gross_irrigation_7d_mm);
    sevenDayFormula = {
      status: irr7d.status,
      et0,
      kc,
      etc7d,
      rain7d: num(irr7d.precipitation_7d_mm),
      effRain7d,
      netDef,
      eff,
      gross,
      equationText: `ETc_7d = ET0_7d × Kc = ${fNum(et0, 1)} × ${fNum(kc, 2)} = ${fNum(etc7d, 1)} мм; Чистий дефіцит = max(0, ${fNum(etc7d, 1)} − ${fNum(effRain7d, 1)}) = ${fNum(netDef, 1)} мм` +
        (gross !== null && eff ? `; Брутто подача = ${fNum(netDef, 1)} / ${fNum(eff, 2)} = ${fNum(gross, 1)} мм` : '')
    };
  }

  // Final verdict & limiting summary
  const limStep = factorSteps.find(s => s.key === limitingFactor) || minFactorStep;
  let verdictText = '';
  if (recordedStatus === 'excluded') {
    verdictText = `У точці перевірки за USDA CDL (${landcover?.label || landcover?.category || 'неорний покрив'}) територію виключено з оцінки придатності орних культур.`;
  } else if (recordedStatus === 'unknown' || reportedScore === null) {
    verdictText = 'Оцінку придатності не завершено («Без даних»), оскільки бракує критичних вхідних параметрів (див. перелік прогалин нижче).';
  } else {
    const statusLabel = tr(`statuses.${recordedStatus}`, recordedStatus);
    const scorePart = `Підсумковий індекс придатності для культури «${resolvedCropName}» у сезоні ${year} становить ${fNum(reportedScore, 1)} / 100 (${statusLabel}).`;
    const limPart = limStep && limStep.score !== null
      ? ` Головний обмежувальний чинник — «${limStep.label}» (індекс фактора ${fNum(limStep.score, 3)}, вага ${limStep.weightPct}%).`
      : '';
    const waterPart = historicalWater && historicalWater.deficitMm > 0
      ? ` Зафіксовано сезонний дефіцит вологи ${fNum(historicalWater.deficitMm, 0)} мм відносно розрахункового ETc (${fNum(historicalWater.demandMm, 0)} мм).`
      : '';
    const ceilPart = criticalCeilingApplied
      ? ` Спрацювала жорстка стеля критичного мінімуму: min(fᵢ) = ${fNum(minFactorStep.score, 3)} < 0.10 обмежив індекс значенням ≤ 100 × √min(fᵢ) = ${fNum(ceilingValue, 1)}.`
      : '';
    verdictText = scorePart + limPart + waterPart + ceilPart;
  }

  return {
    header: {
      title: 'Детальний звіт обчислень та формул GrowWhere',
      generatedAt,
      methodVersion: meta?.method_version || METHOD_VERSION,
      mode: mode || 'own_land',
      scopeType: selected ? 'zone' : areaSummary ? 'area' : 'region',
      scopeLabel,
      coordinates: center && center.length >= 2 ? [roundTo(center[0], 5), roundTo(center[1], 5)] : null,
      crop,
      cropName: resolvedCropName,
      year,
      planting,
      irrigationMode,
      irrigationMm: num(irrigationMm) ?? 0,
      irrigationKnown: !!irrigationKnown,
      targetYear: targetYear || null,
      scaleHa: num(scaleHa)
    },
    profile,
    status: recordedStatus,
    statusLabel: tr(`statuses.${recordedStatus}`, recordedStatus),
    reportedScore,
    isAreaAggregate,
    areaBreakdown: areaSummary ? {
      areaHa: roundTo(areaSummary.areaHa, 1),
      totalCount: areaSummary.totalCount,
      scoredCount: areaSummary.scoredCount,
      coveragePct: areaSummary.coveragePct,
      counts: areaSummary.counts,
      soilPhRange: areaSummary.soilPhRange,
      tempRange: areaSummary.tempRange,
      precipRange: areaSummary.precipRange,
      waterDemandRange: areaSummary.waterDemandRange
    } : null,
    landcover: landcover || null,
    soil: soil || null,
    climate: climate || null,
    factorSteps,
    aggregation: {
      allSevenScored,
      hasZeroFactor,
      sumWeightedLog: sumWeightedLog !== null && Number.isFinite(sumWeightedLog) ? roundTo(sumWeightedLog, 4) : sumWeightedLog,
      geometricMean,
      minFactorKey: minFactorStep?.key || null,
      minFactorLabel: minFactorStep?.label || null,
      minFactorValue: minFactorStep?.score ?? null,
      criticalCeilingApplied,
      ceilingValue,
      computedFinalScore,
      reportedScore,
      formulaGeometric: 'G = 100 × exp(Σᵢ wᵢ × ln(fᵢ))',
      formulaCeiling: 'Якщо min(fᵢ) < 0.10 → S = min(G, 100 × √min(fᵢ)), інакше S = G',
      thresholds: 'S ≥ 70 → Підходить · 40 ≤ S < 70 → Є обмеження · S < 40 → Не підходить'
    },
    historicalWater,
    planning: {
      soilForecast: sf?.available && sf?.data ? sf.data : null,
      soilForecastReason: sf?.reason || null,
      sowingSoilCheck: sowCheck || null,
      sevenDayFormula,
      forecast24h,
      kStateRule,
      criticalGaps: planning?.critical_gaps || []
    },
    fiveYear: {
      landcoverHistory: insights?.landcover_history || null,
      climateRisk: insights?.climate_risk || null
    },
    cropComparison: insights?.crop_comparison || [],
    tradeoffs: insights?.tradeoffs || null,
    economics: economics || activeInsightRow?.economics || null,
    missingList,
    verdictText,
    sources: sources?.sources || []
  };
}

export function renderReportBodyHtml(report) {
  const h = report.header;
  const irrDesc = h.irrigationKnown ? `${fNum(h.irrigationMm, 0)} мм (задано користувачем)` : 'не визначено («Ще не знаю»)';
  const coordsText = h.coordinates ? `${fNum(h.coordinates[1], 5)}° N, ${fNum(Math.abs(h.coordinates[0]), 5)}° W` : 'по області перегляду';

  const statusClass = ['good', 'conditional', 'poor', 'excluded'].includes(report.status) ? report.status : 'unknown';

  const areaBlock = report.areaBreakdown ? `
    <section class="report-section">
      <h3>2. Агрегація по виділеній ділянці (зважування за площею зон)</h3>
      <div class="formula-math">S_area = Σ(Sⱼ × Aⱼ) / Σ(Aⱼ) &nbsp;·&nbsp; покриття = (A_total − A_unknown) / A_total</div>
      <div class="report-kpi-grid">
        <div><span>Загальна площа</span><b>${fNum(report.areaBreakdown.areaHa, 1)} га</b></div>
        <div><span>Зон у контурі</span><b>${fNum(report.areaBreakdown.scoredCount, 0)} оцінено з ${fNum(report.areaBreakdown.totalCount, 0)}</b></div>
        <div><span>Покриття даними</span><b>${fNum(report.areaBreakdown.coveragePct, 0)}%</b></div>
        <div><span>Діапазон pH / T</span><b>pH ${report.areaBreakdown.soilPhRange ? `${fNum(report.areaBreakdown.soilPhRange[0], 1)}–${fNum(report.areaBreakdown.soilPhRange[1], 1)}` : '—'} · ${report.areaBreakdown.tempRange ? `${fNum(report.areaBreakdown.tempRange[0], 1)}–${fNum(report.areaBreakdown.tempRange[1], 1)} °C` : '—'}</b></div>
      </div>
      <p class="report-note">Для контуру в таблиці нижче наведено середньозважені за площею значення 7 факторів, а підсумковий бал S_area обчислено як зважене середнє балів окремих оцінених зон.</p>
    </section>
  ` : '';

  const landcoverInputs = report.landcover
    ? `Покрив USDA CDL (${escapeHtml(report.landcover.year ?? h.year)}): <b>${escapeHtml(report.landcover.label || report.landcover.category || '—')}</b> (код ${escapeHtml(report.landcover.code ?? '—')}, ${report.landcover.allow_analysis ? 'дозволено аналіз' : 'виключено з орних оцінок'}).`
    : 'Покрив USDA CDL не передано для цієї агрегованої області або ще завантажується.';

  const cropParamsHtml = report.profile ? `
    <p class="report-note">Параметри культури «${escapeHtml(report.profile.name)}» у моделі <code>${escapeHtml(h.methodVersion)}</code>:
    стадії (дн.) [${report.profile.stages.join(', ')}] = <b>${report.profile.stages.reduce((a, b) => a + b, 0)} дн.</b>;
    FAO-56 Kc [init, mid, end] = [${report.profile.kc.join(', ')}];
    температурна трапеція [min, opt₁, opt₂, max] = [${report.profile.temperature.join(', ')}] °C;
    заморозки &lt; ${report.profile.frost} °C, спека &gt; ${report.profile.heat} °C;
    діапазон pH [${report.profile.ph.join(', ')}].</p>
  ` : '';

  const factorRowsHtml = report.factorSteps.map(step => `
    <tr class="${step.isLimiting ? 'limiting-row' : ''}">
      <td><strong>${escapeHtml(step.label)}</strong>${step.isLimiting ? ' <span class="badge-limit">обмежувач</span>' : ''}<br><small>${escapeHtml(step.formulaTemplate)}</small></td>
      <td><b>${step.weightPct}%</b><br><small>(${fNum(step.weight, 2)})</small></td>
      <td><div class="sub-inputs">${escapeHtml(step.inputsText)}</div><code class="sub-formula">${escapeHtml(step.substituted)}</code></td>
      <td><b>${step.score !== null ? fNum(step.score, 3) : '—'}</b><br><small>${escapeHtml(step.logText)}</small></td>
    </tr>
  `).join('');

  const agg = report.aggregation;
  const aggMathHtml = agg.allSevenScored && !agg.hasZeroFactor
    ? `
      <div class="formula-math">
        Σᵢ wᵢ × ln(fᵢ) = ${fNum(agg.sumWeightedLog, 4)}<br>
        G = 100 × exp(${fNum(agg.sumWeightedLog, 4)}) = <b>${fNum(agg.geometricMean, 1)}</b><br>
        min(fᵢ) = ${fNum(agg.minFactorValue, 3)} (${escapeHtml(agg.minFactorLabel || '—')}) ${agg.criticalCeilingApplied ? `&lt; 0.10 → діє стеля 100 × √${fNum(agg.minFactorValue, 3)} = ${fNum(agg.ceilingValue, 1)} → <b>S = ${fNum(agg.computedFinalScore, 1)}</b>` : `≥ 0.10 → стеля не застосовується → <b>S = ${fNum(agg.computedFinalScore, 1)}</b>`}
        ${report.isAreaAggregate && report.reportedScore !== null ? `<br>Зважений бал по зонах контуру: <b>S_area = ${fNum(report.reportedScore, 1)} / 100</b>` : ''}
      </div>
    `
    : agg.hasZeroFactor
      ? `<div class="formula-math">Один або більше факторів дорівнюють 0 (min(fᵢ) = 0) → критичне обмеження: S = 0 / 100.</div>`
      : `<div class="formula-math">Не всі 7 факторів мають числове значення — геометричне середнє не може бути обчислене (${escapeHtml(report.statusLabel)}).</div>`;

  const waterBalanceHtml = report.historicalWater ? `
    <div class="formula-math">${escapeHtml(report.historicalWater.formulaText)}</div>
    <p class="report-note">Ефективні опади = <b>${fNum(report.historicalWater.effectiveRainMm, 1)} мм</b> · Полив у сценарії = <b>${report.historicalWater.irrigationMm !== null ? `${fNum(report.historicalWater.irrigationMm, 1)} мм` : 'не визначено'}</b> · Потреба культури ETc (FAO-56) = <b>${fNum(report.historicalWater.demandMm, 1)} мм</b> · Дефіцит = <b>${fNum(report.historicalWater.deficitMm, 1)} мм</b>.</p>
  ` : '<p class="report-note">Сезонний водний баланс ETc недоступний без повних погодних даних NASA POWER.</p>';

  const forecast7dHtml = report.planning.sevenDayFormula ? `
    <div class="formula-math">${escapeHtml(report.planning.sevenDayFormula.equationText)}</div>
    <p class="report-note">Open-Meteo 7 днів (модельна сітка ~9–11 км): ET0 = ${fNum(report.planning.sevenDayFormula.et0, 1)} мм, опади = ${fNum(report.planning.sevenDayFormula.rain7d, 1)} мм, фазовий коефіцієнт Kc = ${fNum(report.planning.sevenDayFormula.kc, 2)}.${report.planning.sowingSoilCheck?.summary ? ` Перевірка температури ґрунту на 6 см: ${escapeHtml(report.planning.sowingSoilCheck.summary)}` : ''}</p>
  ` : `<p class="report-note">7-денний водний орієнтир Open-Meteo: ${escapeHtml(report.planning.soilForecastReason || 'дані завантажуються після відкриття панелі зони/контуру або зараз недоступні.')}</p>`;

  const lcHist = report.fiveYear.landcoverHistory;
  const risk5y = report.fiveYear.climateRisk;
  const historyTableHtml = lcHist?.years?.length ? `
    <table class="formula-table">
      <thead><tr><th>Рік</th><th>Покрив USDA CDL (10–30 м)</th><th>Категорія</th><th>Ризик-оцінка NASA POWER (${escapeHtml(h.cropName)})</th></tr></thead>
      <tbody>
        ${lcHist.years.map(y => {
          const rYear = (risk5y?.years || []).find(ry => ry.year === y.year);
          const riskCell = rYear
            ? `${rYear.score !== null ? `<b>${fNum(rYear.score, 0)}/100</b>` : '—'} · ${rYear.precipitation_mm !== null ? `${fNum(rYear.precipitation_mm, 0)} мм опадів` : 'неповний сезон'}${rYear.heat_days > 0 ? ` · спека ${rYear.heat_days} дн.` : ''}`
            : 'Немає запису';
          return `<tr><td><b>${y.year}</b></td><td>${escapeHtml(y.crop_name || y.label || 'Без даних')}</td><td>${escapeHtml(tr(`landcoverCategories.${y.category}`, y.category))}</td><td>${riskCell}</td></tr>`;
        }).join('')}
      </tbody>
    </table>
    <p class="report-note"><strong>Діагноз 5-річної історії поля:</strong> ${escapeHtml(lcHist.diagnosis || '')}</p>
  ` : '<p class="report-note">5-річна історія CDL та кліматичний ризик завантажуються при відкритті деталізації ділянки або недоступні.</p>';

  const compTableHtml = report.cropComparison?.length ? `
    <table class="formula-table">
      <thead><tr><th>Культура</th><th>Бал / 100</th><th>Дефіцит води</th><th>Обмежувач</th><th>Витрати USDA ERS</th><th>Ціна</th></tr></thead>
      <tbody>
        ${report.cropComparison.map(row => {
          const s = row.score ?? row.potential_score;
          const lim = row.limiting_factor ? tr(`factorNames.${row.limiting_factor}`, row.limiting_factor) : '—';
          return `<tr class="${row.crop === h.crop ? 'active-crop-row' : ''}">
            <td><strong>${escapeHtml(row.name)}</strong>${row.crop === h.crop ? ' (обрано)' : ''}</td>
            <td>${s !== null ? fNum(s, 1) : '—'}${row.score === null && row.potential_score !== null ? ' <small>(потенц.)</small>' : ''}</td>
            <td>${num(row.deficit_mm) !== null ? `${fNum(row.deficit_mm, 0)} мм` : '—'}</td>
            <td>${escapeHtml(lim)}</td>
            <td>${num(row.economics?.cost_per_ha) !== null ? `$${fNum(row.economics.cost_per_ha, 0)}/га` : '—'}</td>
            <td>${num(row.economics?.price_per_tonne) !== null ? `$${fNum(row.economics.price_per_tonne, 0)}/т` : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  ` : '<p class="report-note">Порівняння 7 культур зʼявляється після вибору зони або контуру на карті.</p>';

  const gapsHtml = (report.missingList.length || report.planning.criticalGaps.length) ? `
    <ul class="report-gaps">
      ${report.missingList.map(m => `<li>Відсутній вхід: ${escapeHtml(tr(`missingNames.${m}`, m))}</li>`).join('')}
      ${report.planning.criticalGaps.map(g => `<li>${escapeHtml(g.message)}</li>`).join('')}
    </ul>
  ` : '<p class="report-note">Усі базові входи для історичного скринінгу цієї області наявні.</p>';

  return `
    <article class="report-doc" lang="uk">
      <header class="report-hero">
        <div>
          <span class="report-kicker">GrowWhere · ${escapeHtml(h.methodVersion)} · ${escapeHtml(dateTime(h.generatedAt))}</span>
          <h3>${escapeHtml(h.scopeLabel)} — ${escapeHtml(h.cropName)} (${escapeHtml(h.year)})</h3>
          <p class="report-note">Координати: ${escapeHtml(coordsText)} · Сівба сценарію: ${escapeHtml(h.planting)} · Полив: ${escapeHtml(irrDesc)}${h.targetYear ? ` · Цільовий рік: ${escapeHtml(h.targetYear)}` : ''}${h.scaleHa ? ` · Площа: ${fNum(h.scaleHa, 1)} га` : ''}</p>
        </div>
        <div class="report-score-badge ${statusClass}">
          <strong>${report.reportedScore !== null ? fNum(report.reportedScore, 1) : '—'}</strong>
          <span>${escapeHtml(report.statusLabel)}</span>
        </div>
      </header>

      <section class="report-section report-verdict">
        <h3>Підсумковий висновок</h3>
        <p>${escapeHtml(report.verdictText)}</p>
      </section>

      <section class="report-section">
        <h3>1. Вхідні дані спостережень</h3>
        <p class="report-note">${landcoverInputs}</p>
        ${cropParamsHtml}
      </section>

      ${areaBlock}

      <section class="report-section">
        <h3>3. Покроковий розрахунок 7 факторів та підстановка чисел</h3>
        <div class="report-table-wrap">
          <table class="formula-table">
            <thead><tr><th>Фактор і формула</th><th>Вага wᵢ</th><th>Вхідні дані та підстановка чисел</th><th>Результат fᵢ та внесок wᵢ×ln(fᵢ)</th></tr></thead>
            <tbody>${factorRowsHtml}</tbody>
          </table>
        </div>
      </section>

      <section class="report-section">
        <h3>4. Фінальне згортання індексу (зважене геометричне середнє й стеля)</h3>
        <p class="report-note">${escapeHtml(agg.formulaGeometric)} · ${escapeHtml(agg.formulaCeiling)}</p>
        ${aggMathHtml}
        <p class="report-note">Шкала інтерпретації: ${escapeHtml(agg.thresholds)}.</p>
      </section>

      <section class="report-section">
        <h3>5. Сезонний водний баланс (FAO-56) та 7-денний прогноз</h3>
        ${waterBalanceHtml}
        ${forecast7dHtml}
        ${report.planning.forecast24h ? `<p class="report-note">NOAA/NWS (найближчі 24 год): температура повітря ${fNum(report.planning.forecast24h.temperatureRangeC?.[0], 1)}–${fNum(report.planning.forecast24h.temperatureRangeC?.[1], 1)} °C, макс. імовірність опадів ${report.planning.forecast24h.maxRainProbabilityPct ?? '—'}%.</p>` : ''}
      </section>

      <section class="report-section">
        <h3>6. Поле за 5 років (USDA CDL сівозміна + NASA POWER клімат)</h3>
        ${historyTableHtml}
      </section>

      <section class="report-section">
        <h3>7. Порівняння 7 культур та економіка USDA ERS</h3>
        ${compTableHtml}
      </section>

      <section class="report-section">
        <h3>8. Прогалини даних та наукові обмеження моделі</h3>
        ${gapsHtml}
        <p class="report-note"><strong>Важливе застереження:</strong> модель <code>${escapeHtml(h.methodVersion)}</code> є некаліброваним інструментом попереднього скринінгу придатності за історичною погодою NASA POWER (~55 км), ґрунтами USDA SSURGO (0–30 см) і покривом USDA CDL (10–30 м). Це не прогноз урожайності, не гарантія прибутковості й не заміна польового агрохімічного обстеження. NASA не схвалює та не сертифікує RightVersion.</p>
      </section>
    </article>
  `;
}

export function renderReportDialogHtml(report) {
  return `
    <div class="report-toolbar">
      <button type="button" class="primary" data-action="download-report-pdf">Завантажити PDF</button>
      <button type="button" class="secondary" data-action="close-dialog">Закрити</button>
    </div>
    ${renderReportBodyHtml(report)}
  `;
}

export function renderStandaloneReportDocument(report) {
  const title = `${report.header.title} — ${report.header.cropName} (${report.header.year})`;
  return `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#11231b;background:#ffffff}
  body{margin:0;padding:24px;line-height:1.5;max-width:980px;margin-inline:auto}
  .report-doc{display:grid;gap:18px}
  .report-hero{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:16px 20px;border:2px solid #0e5a3f;border-radius:10px;background:#f4faf7}
  .report-kicker{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#285f49;font-weight:700}
  h3{margin:6px 0 8px;color:#0e3d2b;font-size:17px}
  .report-score-badge{min-width:120px;text-align:center;padding:10px 14px;border-radius:8px;border:1px solid #9ab4a6;background:#fff}
  .report-score-badge strong{display:block;font-size:28px;line-height:1.1}
  .report-score-badge.good{background:#e7f7ee;border-color:#157f4b;color:#0e5733}
  .report-score-badge.conditional{background:#fff6dc;border-color:#c98a12;color:#6d4702}
  .report-score-badge.poor{background:#fdebe8;border-color:#c43e2b;color:#7a1f13}
  .report-section{padding:14px 18px;border:1px solid #cfd9d2;border-radius:8px;background:#fff;break-inside:avoid}
  .report-verdict{background:#f7fbf8;border-left:5px solid #0e5a3f}
  .report-note{margin:6px 0;font-size:14px;color:#2c4237}
  .formula-math{padding:10px 12px;background:#f1f6f3;border:1px solid #c9d8cf;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;overflow-x:auto;margin:8px 0}
  .report-kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:10px 0}
  .report-kpi-grid>div{padding:8px 10px;background:#f7faf8;border:1px solid #dbe5df;border-radius:6px}
  .report-kpi-grid span{display:block;font-size:12px;color:#476356}
  .report-table-wrap{overflow-x:auto}
  .formula-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
  .formula-table th,.formula-table td{padding:8px 10px;border:1px solid #d5e0d9;text-align:left;vertical-align:top}
  .formula-table th{background:#eef5f0;color:#113929;font-weight:700}
  .limiting-row{background:#fff8ea}
  .active-crop-row{background:#eef8f2}
  .badge-limit{display:inline-block;padding:1px 6px;border-radius:999px;background:#f6d488;color:#5a3c00;font-size:11px;font-weight:700}
  .sub-inputs{font-size:12px;color:#395246;margin-bottom:4px}
  .sub-formula{display:inline-block;font-size:12px;background:#f5f8f6;padding:3px 6px;border-radius:4px;border:1px solid #dde6e0}
  .report-gaps{margin:6px 0 6px 18px;font-size:14px}
  @media print{body{padding:0} .report-section{border-color:#bbb}}
</style>
</head>
<body>
${renderReportBodyHtml(report)}
</body>
</html>`;
}
