"""Multi-crop trade-offs, multi-year climate risk and crop rotation insights."""
from __future__ import annotations

import concurrent.futures
import datetime as dt
import re

from .analysis import PROFILES, climate_metrics, evaluate, number
from .economics import economics
from .service import COVERAGE, apply_landcover, power_key
from .sources import power_point, utcnow
from . import landcover, soil

ROTATION_META = {
    'soy': {'group': 'legume', 'group_label': 'Legume (nitrogen fixer)', 'benefit': 'Can contribute nitrogen and interrupt cereal disease cycles.'},
    'wheat': {'group': 'cereal_cool', 'group_label': 'Cool-season cereal', 'benefit': 'Provides soil cover and uses spring moisture.'},
    'barley': {'group': 'cereal_cool', 'group_label': 'Cool-season cereal', 'benefit': 'A shorter season can free the field earlier; performance depends on local conditions.'},
    'oats': {'group': 'cereal_cool', 'group_label': 'Cool-season cereal', 'benefit': 'Crop diversity may help interrupt soil-borne disease cycles.'},
    'corn': {'group': 'cereal_warm', 'group_label': 'Warm-season cereal', 'benefit': 'Can use available water and nutrients intensively, with substantial water and nitrogen demand.'},
    'sorghum': {'group': 'drought_cereal', 'group_label': 'Drought-tolerant row crop', 'benefit': 'A deep root system can support performance in hot, dry conditions.'},
    'cotton': {'group': 'fiber_warm', 'group_label': 'Warm-season industrial crop', 'benefit': 'Requires a long warm season; water needs depend on local conditions.'},
}


def detect_cdl_crop(cover):
    """Identify a supported GrowWhere crop from a USDA CDL label without guessing."""
    label = (cover or {}).get('label') or ''
    if not label:
        return None
    low = label.lower()
    patterns = [
        ('corn', r'\bcorn\b'),
        ('soy', r'\bsoybean'),
        ('sorghum', r'\bsorghum\b'),
        ('wheat', r'\bwheat\b'),
        ('barley', r'\bbarley\b'),
        ('oats', r'\boats\b'),
        ('cotton', r'\bcotton\b'),
    ]
    for cid, pat in patterns:
        if re.search(pat, low):
            return cid
    return None


def _deficit_mm(wb):
    if not wb or wb.get('demand_mm') is None:
        return None
    supply = (wb.get('effective_rain_mm') or 0.0) + (wb.get('irrigation_mm') or 0.0)
    return max(0.0, round(wb['demand_mm'] - supply, 1))


def _evaluate_all_crops(raw_year, pt_soil, pt_cover, year, crop, planting, irrigation_mm, irrigation_known, econ_by_crop):
    rows = []
    for cid, prof in PROFILES.items():
        p_date = planting if cid == crop else f"{year}-{prof['default_planting']}"
        start = dt.date.fromisoformat(p_date)
        season_end = start + dt.timedelta(days=sum(prof['stages']) - 1)
        if season_end.year != year or not raw_year:
            clim = None
            raw_res = {'score': None, 'status': 'unknown', 'missing': ['complete_season']}
            res = raw_res
        else:
            clim = climate_metrics(raw_year, cid, p_date)
            raw_res = evaluate(clim, pt_soil, cid, irrigation_mm, irrigation_known)
            res = apply_landcover(raw_res, pt_cover)
        wb = res.get('water_balance') or raw_res.get('water_balance')
        econ = econ_by_crop.get(cid) or {}
        rows.append({
            'crop': cid,
            'name': prof['name'],
            'planting': p_date,
            'score': res.get('score'),
            'status': res.get('status', 'unknown'),
            'potential_score': raw_res.get('score'),
            'potential_status': raw_res.get('status', 'unknown'),
            'limiting_factor': raw_res.get('limiting_factor'),
            'factors': raw_res.get('factors', {}),
            'water_balance': wb,
            'deficit_mm': _deficit_mm(wb),
            'mean_temperature': round(clim['mean_temperature'], 1) if clim and clim.get('mean_temperature') is not None else None,
            'precipitation_mm': round(clim['precipitation_mm'], 1) if clim and clim.get('precipitation_mm') is not None else None,
            'heat_days': clim.get('heat_days') if clim else None,
            'frost_days': clim.get('frost_days') if clim else None,
            'root_zone_wetness': clim.get('root_zone_wetness') if clim else None,
            'surface_wetness': clim.get('surface_wetness') if clim else None,
            'missing': res.get('missing', []),
            'economics': {
                'cost_per_ha': econ.get('cost_per_ha'),
                'price_per_tonne': econ.get('price_per_tonne'),
                'region': econ.get('region'),
                'actual_year': econ.get('actual_year'),
                'missing': econ.get('missing', []),
            },
        })
    rows.sort(key=lambda r: (
        r['score'] is not None,
        r['score'] if r['score'] is not None else (r['potential_score'] if r['potential_score'] is not None else -1.0),
        -(r['deficit_mm'] if r['deficit_mm'] is not None else 9999.0),
    ), reverse=True)
    return rows


def _summarize_tradeoffs(rows):
    scored = [r for r in rows if r['score'] is not None]
    best = scored[0] if scored else next((r for r in rows if r.get('potential_score') is not None), None)
    water_rows = [r for r in rows if (r.get('water_balance') or {}).get('demand_mm') is not None]
    cost_rows = [r for r in rows if (r.get('economics') or {}).get('cost_per_ha') is not None]
    low_water = min(water_rows, key=lambda r: (r['deficit_mm'] if r['deficit_mm'] is not None else 9999.0, r['water_balance']['demand_mm'])) if water_rows else None
    low_cost = min(cost_rows, key=lambda r: r['economics']['cost_per_ha']) if cost_rows else None
    return {
        'best_suitability': {'crop': best['crop'], 'name': best['name'], 'score': best['score'] if best['score'] is not None else best.get('potential_score'), 'potential': best['score'] is None} if best else None,
        'lowest_water_need': {'crop': low_water['crop'], 'name': low_water['name'], 'demand_mm': low_water['water_balance']['demand_mm'], 'deficit_mm': low_water['deficit_mm']} if low_water else None,
        'lowest_cost': {'crop': low_cost['crop'], 'name': low_cost['name'], 'cost_per_ha': low_cost['economics']['cost_per_ha']} if low_cost else None,
    }


def _multi_year_risk(support_key, pt_soil, crop, year, planting_mm_dd, irrigation_mm, irrigation_known, years_back=5, refresh=False):
    today = dt.datetime.now(dt.timezone.utc).date()
    years_back = max(1, min(10, int(years_back)))
    candidate_years = list(range(max(1984, year - years_back + 1), year + 1))
    season_len = sum(PROFILES[crop]['stages'])

    def check_year(y):
        y_planting = f'{y}-{planting_mm_dd}'
        start = dt.date.fromisoformat(y_planting)
        end = start + dt.timedelta(days=season_len - 1)
        if end.year != y or end > today - dt.timedelta(days=7):
            return {'year': y, 'score': None, 'status': 'unknown', 'reason': 'incomplete_season'}
        try:
            raw_y, _ = power_point(*support_key, y, refresh)
            clim = climate_metrics(raw_y, crop, y_planting)
            res = evaluate(clim, pt_soil, crop, irrigation_mm, irrigation_known)
            wb = res.get('water_balance')
            return {
                'year': y,
                'score': res.get('score'),
                'status': res.get('status', 'unknown'),
                'mean_temperature': round(clim['mean_temperature'], 1) if clim.get('mean_temperature') is not None else None,
                'precipitation_mm': round(clim['precipitation_mm'], 1) if clim.get('precipitation_mm') is not None else None,
                'demand_mm': wb.get('demand_mm') if wb else None,
                'deficit_mm': _deficit_mm(wb),
                'heat_days': clim.get('heat_days'),
                'frost_days': clim.get('frost_days'),
                'root_zone_wetness': clim.get('root_zone_wetness'),
                'surface_wetness': clim.get('surface_wetness'),
                'missing': res.get('missing', []),
            }
        except Exception as exc:
            return {'year': y, 'score': None, 'status': 'unknown', 'error': str(exc)[:180]}

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        yearly = list(pool.map(check_year, candidate_years))
    scored = [row for row in yearly if row.get('score') is not None]
    scores = [row['score'] for row in scored]
    rains = [row['precipitation_mm'] for row in scored if row.get('precipitation_mm') is not None]
    return {
        'crop': crop,
        'years_requested': len(candidate_years),
        'years': yearly,
        'summary': {
            'years_scored': len(scored),
            'good_count': sum(r['status'] == 'good' for r in scored),
            'conditional_count': sum(r['status'] == 'conditional' for r in scored),
            'poor_count': sum(r['status'] == 'poor' for r in scored),
            'heat_stress_years': sum((r.get('heat_days') or 0) > 0 for r in scored),
            'water_deficit_years': sum((r.get('deficit_mm') or 0) > 50 for r in scored),
            'score_min': round(min(scores), 1) if scores else None,
            'score_mean': round(sum(scores) / len(scores), 1) if scores else None,
            'score_max': round(max(scores), 1) if scores else None,
            'rain_min_mm': round(min(rains), 0) if rains else None,
            'rain_max_mm': round(max(rains), 0) if rains else None,
        },
        'note': 'Historical risk from NASA POWER under the selected irrigation scenario; not a yield forecast.',
    }


def _rotation_advice(crop, pt_cover, pt_soil, crop_rows):
    by_crop = {r['crop']: r for r in crop_rows}
    detected = detect_cdl_crop(pt_cover)
    anchor = detected or crop
    anchor_group = ROTATION_META[anchor]['group']

    def pick_best(predicate, exclude):
        candidates = [r for r in crop_rows if r['crop'] not in exclude and predicate(r)]
        return candidates[0] if candidates else None

    # Plan 1: Soil health & nitrogen balance (rotate away from anchor group via legume -> cool cereal or cereal -> legume).
    step1_health = by_crop['soy'] if anchor != 'soy' else pick_best(lambda r: ROTATION_META[r['crop']]['group'] in {'cereal_cool', 'drought_cereal'}, {anchor})
    step2_health = pick_best(lambda r: ROTATION_META[r['crop']]['group'] != ROTATION_META[step1_health['crop']]['group'], {anchor, step1_health['crop']}) if step1_health else None

    # Plan 2: Water-saving / heat resilience (prioritize minimal water deficit from different group).
    water_candidates = sorted(
        [r for r in crop_rows if r['crop'] != anchor and ROTATION_META[r['crop']]['group'] != anchor_group],
        key=lambda r: (r['deficit_mm'] is None, r['deficit_mm'] if r['deficit_mm'] is not None else 9999.0, -(r['score'] or 0.0))
    )
    step1_water = water_candidates[0] if water_candidates else None
    step2_water = next((r for r in water_candidates[1:] if step1_water and ROTATION_META[r['crop']]['group'] != ROTATION_META[step1_water['crop']]['group']), water_candidates[1] if len(water_candidates) > 1 else None)

    # Plan 3: Diversified high suitability (highest evaluated local scores across distinct functional groups).
    step1_score = pick_best(lambda r: ROTATION_META[r['crop']]['group'] != anchor_group, {anchor})
    step2_score = pick_best(lambda r: step1_score and ROTATION_META[r['crop']]['group'] != ROTATION_META[step1_score['crop']]['group'], {anchor, step1_score['crop']}) if step1_score else None

    def make_plan(pid, title, focus, seq):
        steps = []
        for idx, row in enumerate([by_crop[anchor]] + [s for s in seq if s]):
            meta = ROTATION_META[row['crop']]
            steps.append({
                'season': idx + 1,
                'crop': row['crop'],
                'name': row['name'],
                'group_label': meta['group_label'],
                'role': 'Current / previous land cover' if idx == 0 else meta['benefit'],
                'score': row['score'] if row['score'] is not None else row.get('potential_score'),
                'status': row['status'] if row['score'] is not None else row.get('potential_status', row['status']),
                'potential': row['score'] is None and row.get('potential_score') is not None,
                'deficit_mm': row['deficit_mm'],
            })
        return {'id': pid, 'title': title, 'focus': focus, 'steps': steps}

    slope_note = ' Higher slope: consider soil-cover and erosion-control requirements.' if pt_soil and (pt_soil.get('slope') or 0) >= 5 else ''
    return {
        'anchor_crop': anchor,
        'anchor_name': PROFILES[anchor]['name'],
        'anchor_source': 'usda_cdl' if detected else 'selected_crop',
        'cdl_label': (pt_cover or {}).get('label'),
        'plans': [
            make_plan('soil_health', 'Nitrogen and soil health', 'Alternating cereals with legumes can diversify pest cycles and nitrogen management.' + slope_note, [step1_health, step2_health]),
            make_plan('water_smart', 'Water use and heat tolerance', 'Compare crops with lower modeled water deficits using NASA POWER data.', [step1_water, step2_water]),
            make_plan('score_mix', 'Highest local model score', 'Compare crops with higher research suitability scores under this soil and irrigation scenario.', [step1_score, step2_score]),
        ],
        'caveat': 'General rotation principles using local soil and climate data; not a field prescription or a substitute for soil testing.',
    }


def analyze_point_insights(lon, lat, crop, year, planting, irrigation_mm=0, irrigation_known=True, years_back=5, refresh=False):
    lon = number(lon, -180, 180)
    lat = number(lat, -90, 90)
    if lon is None or lat is None:
        raise ValueError('Invalid point coordinates')
    if not (COVERAGE[0] <= lon <= COVERAGE[2] and COVERAGE[1] <= lat <= COVERAGE[3]):
        raise ValueError('Invalid WGS84 bbox')
    if crop not in PROFILES:
        raise ValueError('Unsupported crop')
    year = int(year)
    current = dt.datetime.now(dt.timezone.utc).year
    if not 1984 <= year <= current:
        raise ValueError('Year is outside the available historical window')
    start = dt.date.fromisoformat(planting)
    if start.year != year:
        raise ValueError('Planting date must belong to the selected year')
    irrigation_mm = number(irrigation_mm, 0, 5000)
    if irrigation_mm is None:
        raise ValueError('Invalid irrigation amount')

    sid = 'insight-pt'
    support = power_key([lon, lat])
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        f_soil = pool.submit(soil.points, [{'id': sid, 'center': [lon, lat]}], refresh)
        f_cover = pool.submit(landcover.classify_points, [{'id': sid, 'lon': lon, 'lat': lat}], year, refresh)
        f_power = pool.submit(power_point, *support, year, refresh)
        f_econs = {cid: pool.submit(economics, cid, year, refresh) for cid in PROFILES}

        pt_soil = None
        try:
            soil_map, _ = f_soil.result()
            pt_soil = soil_map.get(sid)
        except Exception:
            pt_soil = None

        pt_cover = None
        try:
            cov_res = f_cover.result()
            pt_cover = (cov_res.get('by_id') or {}).get(sid)
        except Exception:
            pt_cover = None

        raw_year = None
        try:
            raw_year, _ = f_power.result()
        except Exception:
            raw_year = None

        econ_by_crop = {}
        for cid, fut in f_econs.items():
            try:
                econ_by_crop[cid] = fut.result()
            except Exception:
                econ_by_crop[cid] = {'cost_per_ha': None, 'price_per_tonne': None, 'missing': ['economics']}

    crop_rows = _evaluate_all_crops(raw_year, pt_soil, pt_cover, year, crop, planting, irrigation_mm, irrigation_known, econ_by_crop)
    tradeoffs = _summarize_tradeoffs(crop_rows)
    planting_mm_dd = planting[5:]
    risk = _multi_year_risk(support, pt_soil, crop, year, planting_mm_dd, irrigation_mm, irrigation_known, years_back=years_back, refresh=refresh)
    rotation = _rotation_advice(crop, pt_cover, pt_soil, crop_rows)
    active_row = next((r for r in crop_rows if r['crop'] == crop), crop_rows[0] if crop_rows else None)

    return {
        'location': {'lon': round(lon, 5), 'lat': round(lat, 5), 'power_cell': list(support)},
        'query': {'crop': crop, 'year': year, 'planting': planting, 'irrigation_mm': irrigation_mm, 'irrigation_known': irrigation_known},
        'soil': pt_soil,
        'landcover': pt_cover,
        'moisture_and_cover': {
            'root_zone_wetness': active_row.get('root_zone_wetness') if active_row else None,
            'surface_wetness': active_row.get('surface_wetness') if active_row else None,
            'cdl_label': (pt_cover or {}).get('label'),
            'cdl_category': (pt_cover or {}).get('category'),
            'scales': [
                {'layer': 'NASA POWER (weather, ET0, GWETTOP/GWETROOT)', 'scale': '~0.5° × 0.625° (~55 km)'},
                {'layer': 'NASA SMAP L4 (map overlay)', 'scale': '~9 km'},
                {'layer': 'NASA MODIS Terra NDVI (map overlay)', 'scale': '250–500 m (8 days)'},
                {'layer': 'USDA SSURGO (soil, 0–30 cm)', 'scale': 'Soil survey mapping units'},
                {'layer': 'USDA CDL (land cover)', 'scale': 'Product resolution depends on year (2025: 10 m)'},
            ],
        },
        'crop_comparison': crop_rows,
        'tradeoffs': tradeoffs,
        'climate_risk': risk,
        'rotation_advice': rotation,
        'completed_at': utcnow(),
    }
