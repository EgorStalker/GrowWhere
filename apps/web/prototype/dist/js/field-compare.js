import {tr,fmt} from './live-i18n.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const num = value => (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) ? Number(value) : null;
const fNum = (value, digits = 1) => {
  const n = num(value);
  return n === null ? '—' : fmt(n, digits);
};

export function createFieldSnapshot({
  label,
  crop,
  cropName,
  year,
  planting,
  irrigationLabel,
  areaHa,
  coordinates,
  status,
  score,
  factors,
  limitingFactor,
  waterBalance,
  soil,
  coveragePct = 100,
  soilPhRange = null,
  tempRange = null,
  landcoverHistory = null,
  climateRisk = null,
  capturedAt = new Date().toISOString()
} = {}) {
  const wb = waterBalance && num(waterBalance.demand_mm) !== null
    ? {
        effectiveRainMm: Number(waterBalance.effective_rain_mm || 0),
        irrigationMm: Number(waterBalance.irrigation_mm || 0),
        demandMm: Number(waterBalance.demand_mm),
        deficitMm: Math.max(0, Number(waterBalance.demand_mm) - (Number(waterBalance.effective_rain_mm || 0) + Number(waterBalance.irrigation_mm || 0)))
      }
    : null;

  return {
    id: `${coordinates ? `${Number(coordinates[0]).toFixed(4)},${Number(coordinates[1]).toFixed(4)}` : 'area'}|${crop || ''}|${year || ''}`,
    label: label || 'Ділянка',
    crop,
    cropName: cropName || tr(`cropNames.${crop}`, crop || '—'),
    year,
    planting,
    irrigationLabel: irrigationLabel || '—',
    areaHa: num(areaHa),
    coordinates: Array.isArray(coordinates) && coordinates.length >= 2 ? [Number(coordinates[0]), Number(coordinates[1])] : null,
    status: status || 'unknown',
    statusLabel: tr(`statuses.${status || 'unknown'}`, 'Без даних'),
    score: num(score),
    factors: factors ? {...factors} : {},
    limitingFactor: limitingFactor || null,
    waterBalance: wb,
    soil: soil ? {...soil} : null,
    coveragePct: num(coveragePct) ?? 100,
    soilPhRange,
    tempRange,
    landcoverHistory,
    climateRisk,
    capturedAt
  };
}

function decideWinner(valA, valB, prefer = 'higher', eps = 0.01) {
  const a = num(valA);
  const b = num(valB);
  if (a === null || b === null) return null;
  if (Math.abs(a - b) <= eps) return 'tie';
  if (prefer === 'higher') return a > b ? 'A' : 'B';
  return a < b ? 'A' : 'B';
}

export function compareTwoFields(fieldA, fieldB) {
  if (!fieldA || !fieldB) {
    throw new Error('Для порівняння потрібні два зафіксовані поля');
  }

  const limA = fieldA.limitingFactor ? tr(`factorNames.${fieldA.limitingFactor}`, fieldA.limitingFactor) : '—';
  const limB = fieldB.limitingFactor ? tr(`factorNames.${fieldB.limitingFactor}`, fieldB.limitingFactor) : '—';

  const goodShare = f => {
    const s = f.climateRisk?.summary;
    if (!s || !num(s.years_scored) || Number(s.years_scored) <= 0) return null;
    return ((Number(s.good_count || 0) + Number(s.conditional_count || 0)) / Number(s.years_scored)) * 100;
  };
  const goodShareA = goodShare(fieldA);
  const goodShareB = goodShare(fieldB);

  const histSummary = f => {
    const h = f.landcoverHistory;
    if (!h) return 'Не завантажено (очікує CDL)';
    if (h.monoculture_alert) return `Ризик монокультури (${h.monoculture_crop || 'культура'}, ${h.monoculture_streak} р. поспіль)`;
    if (h.unique_crops >= 2) return `Сівозміна: ${h.unique_crops} різних культур за ${h.years_requested || 5} р.`;
    return h.diagnosis || 'Недостатньо орних знімків';
  };
  const monoRank = f => {
    const h = f.landcoverHistory;
    if (!h) return null;
    if (h.monoculture_alert) return -Number(h.monoculture_streak || 2);
    return Number(h.unique_crops || 0);
  };

  const phText = f => f.soil?.ph !== undefined && f.soil?.ph !== null
    ? fNum(f.soil.ph, 2)
    : f.soilPhRange ? `${fNum(f.soilPhRange[0], 1)}–${fNum(f.soilPhRange[1], 1)}` : '—';

  const rows = [
    {
      key: 'score',
      label: 'Індекс придатності (0–100)',
      valueA: fieldA.score !== null ? `${fNum(fieldA.score, 1)} (${fieldA.statusLabel})` : fieldA.statusLabel,
      valueB: fieldB.score !== null ? `${fNum(fieldB.score, 1)} (${fieldB.statusLabel})` : fieldB.statusLabel,
      winner: decideWinner(fieldA.score, fieldB.score, 'higher', 0.5)
    },
    {
      key: 'water_factor',
      label: 'Фактор води (вага 30%)',
      valueA: fieldA.factors?.water !== undefined ? `${Math.round(Number(fieldA.factors.water) * 100)}%` : '—',
      valueB: fieldB.factors?.water !== undefined ? `${Math.round(Number(fieldB.factors.water) * 100)}%` : '—',
      winner: decideWinner(fieldA.factors?.water, fieldB.factors?.water, 'higher', 0.01)
    },
    {
      key: 'deficit_mm',
      label: 'Сезонний дефіцит вологи (ETc)',
      valueA: fieldA.waterBalance ? `${fNum(fieldA.waterBalance.deficitMm, 0)} мм` : '—',
      valueB: fieldB.waterBalance ? `${fNum(fieldB.waterBalance.deficitMm, 0)} мм` : '—',
      winner: decideWinner(fieldA.waterBalance?.deficitMm, fieldB.waterBalance?.deficitMm, 'lower', 5)
    },
    {
      key: 'temp_factor',
      label: 'Температурний фактор (вага 20%)',
      valueA: fieldA.factors?.temperature !== undefined ? `${Math.round(Number(fieldA.factors.temperature) * 100)}%` : '—',
      valueB: fieldB.factors?.temperature !== undefined ? `${Math.round(Number(fieldB.factors.temperature) * 100)}%` : '—',
      winner: decideWinner(fieldA.factors?.temperature, fieldB.factors?.temperature, 'higher', 0.01)
    },
    {
      key: 'ph_factor',
      label: 'Кислотність ґрунту pH / фактор',
      valueA: `${phText(fieldA)}${fieldA.factors?.ph !== undefined ? ` (${Math.round(Number(fieldA.factors.ph) * 100)}%)` : ''}`,
      valueB: `${phText(fieldB)}${fieldB.factors?.ph !== undefined ? ` (${Math.round(Number(fieldB.factors.ph) * 100)}%)` : ''}`,
      winner: decideWinner(fieldA.factors?.ph, fieldB.factors?.ph, 'higher', 0.01)
    },
    {
      key: 'awc_factor',
      label: 'Вологоємність ґрунту AWC (10%)',
      valueA: fieldA.factors?.awc !== undefined ? `${Math.round(Number(fieldA.factors.awc) * 100)}%` : '—',
      valueB: fieldB.factors?.awc !== undefined ? `${Math.round(Number(fieldB.factors.awc) * 100)}%` : '—',
      winner: decideWinner(fieldA.factors?.awc, fieldB.factors?.awc, 'higher', 0.01)
    },
    {
      key: 'drainage_slope',
      label: 'Дренаж (10%) / Схил (10%)',
      valueA: `${fieldA.factors?.drainage !== undefined ? `${Math.round(Number(fieldA.factors.drainage) * 100)}%` : '—'} / ${fieldA.factors?.slope !== undefined ? `${Math.round(Number(fieldA.factors.slope) * 100)}%` : '—'}`,
      valueB: `${fieldB.factors?.drainage !== undefined ? `${Math.round(Number(fieldB.factors.drainage) * 100)}%` : '—'} / ${fieldB.factors?.slope !== undefined ? `${Math.round(Number(fieldB.factors.slope) * 100)}%` : '—'}`,
      winner: decideWinner(
        (num(fieldA.factors?.drainage) ?? 0) + (num(fieldA.factors?.slope) ?? 0),
        (num(fieldB.factors?.drainage) ?? 0) + (num(fieldB.factors?.slope) ?? 0),
        'higher',
        0.02
      )
    },
    {
      key: 'climate_5y',
      label: '5-річна стабільність NASA POWER',
      valueA: goodShareA !== null ? `${Math.round(goodShareA)}% сприятл./умов. (${fNum(fieldA.climateRisk.summary.heat_stress_years, 0)} р. спеки)` : 'Не завантажено',
      valueB: goodShareB !== null ? `${Math.round(goodShareB)}% сприятл./умов. (${fNum(fieldB.climateRisk.summary.heat_stress_years, 0)} р. спеки)` : 'Не завантажено',
      winner: decideWinner(goodShareA, goodShareB, 'higher', 1)
    },
    {
      key: 'rotation_5y',
      label: '5-річна історія посівів (USDA CDL)',
      valueA: histSummary(fieldA),
      valueB: histSummary(fieldB),
      winner: decideWinner(monoRank(fieldA), monoRank(fieldB), 'higher', 0)
    },
    {
      key: 'limiting',
      label: 'Головний обмежувальний чинник',
      valueA: limA,
      valueB: limB,
      winner: null
    }
  ];

  let winsA = 0;
  let winsB = 0;
  let ties = 0;
  for (const r of rows) {
    if (r.winner === 'A') winsA += 1;
    else if (r.winner === 'B') winsB += 1;
    else if (r.winner === 'tie') ties += 1;
  }

  let overallWinner = 'tie';
  if (winsA > winsB) overallWinner = 'A';
  else if (winsB > winsA) overallWinner = 'B';
  else if (num(fieldA.score) !== null && num(fieldB.score) !== null) {
    if (fieldA.score > fieldB.score + 0.5) overallWinner = 'A';
    else if (fieldB.score > fieldA.score + 0.5) overallWinner = 'B';
  }

  const differentScope = fieldA.crop !== fieldB.crop || Number(fieldA.year) !== Number(fieldB.year);
  const scopeWarning = differentScope
    ? `Увага: поля оцінено за різних параметрів («${fieldA.cropName}» ${fieldA.year} vs «${fieldB.cropName}» ${fieldB.year}). Для чесного вибору ділянки встановіть однакову культуру й рік.`
    : null;

  let verdict = '';
  if (overallWinner === 'A') {
    verdict = `За наявними даними Поле А (${fieldA.label}) випереджає Поле Б за ${winsA} з ${winsA + winsB + ties} порівняних критеріїв.`;
  } else if (overallWinner === 'B') {
    verdict = `За наявними даними Поле Б (${fieldB.label}) випереджає Поле А за ${winsB} з ${winsA + winsB + ties} порівняних критеріїв.`;
  } else {
    verdict = `Обидва поля показують близькі результати (${winsA}:${winsB}, нічия за ${ties} критеріями). Оцініть 5-річну історію сівозміни та витрати на полив.`;
  }

  return {
    fieldA,
    fieldB,
    rows,
    winsA,
    winsB,
    ties,
    overallWinner,
    scopeWarning,
    verdict
  };
}

export function renderFieldCompareDialogHtml(cmp) {
  const {fieldA, fieldB, rows, winsA, winsB, overallWinner, scopeWarning, verdict} = cmp;
  const card = (tag, f, isWinner) => `
    <article class="compare-field-card ${isWinner ? 'winner' : ''}">
      <div class="compare-field-head">
        <span class="compare-tag">Поле ${tag}</span>
        ${isWinner ? '<span class="winner-badge">Кращий баланс</span>' : ''}
      </div>
      <h3>${escapeHtml(f.label)}</h3>
      <p>${escapeHtml(f.cropName)} · ${escapeHtml(f.year)} · ${escapeHtml(f.irrigationLabel)}${f.areaHa ? ` · ${fNum(f.areaHa, 1)} га` : ''}</p>
      <div class="compare-score-line">
        <span class="status-pill ${escapeHtml(f.status)}">${escapeHtml(f.statusLabel)}</span>
        <strong>${f.score !== null ? `${fNum(f.score, 1)} / 100` : '—'}</strong>
      </div>
    </article>
  `;

  return `
    <div class="report-doc">
      <div class="compare-fields-top">
        ${card('А', fieldA, overallWinner === 'A')}
        ${card('Б', fieldB, overallWinner === 'B')}
      </div>
      ${scopeWarning ? `<div class="monoculture-banner alert">${escapeHtml(scopeWarning)}</div>` : ''}
      <section class="report-section report-verdict">
        <h3>Підсумок порівняння (${winsA} : ${winsB})</h3>
        <p>${escapeHtml(verdict)}</p>
      </section>
      <div class="report-table-wrap">
        <table class="formula-table compare-2-table">
          <thead><tr><th>Критерій</th><th>Поле А (${escapeHtml(fieldA.label)})</th><th>Поле Б (${escapeHtml(fieldB.label)})</th><th>Перевага</th></tr></thead>
          <tbody>
            ${rows.map(r => {
              const badge = r.winner === 'A'
                ? '<span class="cmp-win a">Поле А</span>'
                : r.winner === 'B'
                  ? '<span class="cmp-win b">Поле Б</span>'
                  : r.winner === 'tie'
                    ? '<span class="cmp-tie">Рівно</span>'
                    : '—';
              return `
                <tr>
                  <td><strong>${escapeHtml(r.label)}</strong></td>
                  <td class="${r.winner === 'A' ? 'cmp-cell-win' : ''}">${escapeHtml(r.valueA)}</td>
                  <td class="${r.winner === 'B' ? 'cmp-cell-win' : ''}">${escapeHtml(r.valueB)}</td>
                  <td>${badge}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="report-toolbar">
        <button type="button" class="secondary" data-action="swap-compare-fields">Поміняти А ↔ Б місцями</button>
        <button type="button" class="secondary" data-action="clear-compare-fields">Скинути Поле А</button>
        <button type="button" class="primary" data-action="close-dialog">Закрити</button>
      </div>
    </div>
  `;
}
