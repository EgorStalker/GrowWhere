"""Open-Meteo 7-day gridded soil temperature, soil moisture, and FAO-56 ET0 forecast.

Gridded NWP/model output (~9-11 km), explicitly separated from field sensor measurements.
"""
import datetime as dt
import math

from .analysis import PROFILES
from .service import public_meta
from .sources import CACHE, UpstreamError

TTL_SECONDS = 3600
KANSAS_BBOX = (-102.1, 36.9, -94.5, 40.1)
IRRIGATION_EFFICIENCIES = {
    'drip': 0.90,
    'sprinkler': 0.80,
    'furrow': 0.60,
    'none': None,
}
STAGE_KEYS = {'pre_planting', 'emergence', 'vegetative', 'reproductive', 'maturity'}


def _finite(value, low=None, high=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    if low is not None and value < low:
        return None
    if high is not None and value > high:
        return None
    return float(value)


def _stage_kc(crop, stage):
    profile = PROFILES.get(crop)
    if not profile or stage not in STAGE_KEYS:
        return None
    k0, km, ke = profile['kc']
    if stage == 'pre_planting':
        return 0.35
    if stage == 'emergence':
        return k0
    if stage == 'vegetative':
        return round((k0 + km) / 2.0, 2)
    if stage == 'reproductive':
        return km
    return ke


def openmeteo_soil_forecast(lon, lat, refresh=False, now=None):
    """Fetch 7-day hourly soil temperature (0/6 cm), soil moisture (0-27 cm), and daily ET0."""
    now = now or dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None:
        raise ValueError('now must include a timezone')
    now = now.astimezone(dt.timezone.utc)
    result = {
        'available': False,
        'status': 'unavailable',
        'data': None,
        'source_id': 'open-meteo',
        'kind': 'model_forecast',
        'provenance': [],
        'reason': None,
        'limitations': [
            'Модельна сітка Open-Meteo (GFS/ECMWF ~9–11 км), а не датчик у ґрунті вашого поля на глибині 5,08 см.',
            'Вологість наведено у м³/м³ для верхніх 0–27 см; для глибшої кореневої зони потрібні локальні заміри.',
        ],
    }
    if isinstance(lon, bool) or isinstance(lat, bool):
        raise ValueError('Invalid forecast coordinates')
    try:
        lon, lat = float(lon), float(lat)
    except (TypeError, ValueError) as exc:
        raise ValueError('Invalid forecast coordinates') from exc
    if not math.isfinite(lon) or not math.isfinite(lat) or not -180 <= lon <= 180 or not -90 <= lat <= 90:
        raise ValueError('Invalid forecast coordinates')
    west, south, east, north = KANSAS_BBOX
    if not west <= lon <= east or not south <= lat <= north:
        result.update(status='outside_pilot_coverage', reason='Модельний прогноз ґрунту у цій версії підключено лише для області Канзасу.')
        return result

    url = (
        f'https://api.open-meteo.com/v1/forecast?latitude={lat:.4f}&longitude={lon:.4f}'
        '&hourly=soil_temperature_0cm,soil_temperature_6cm,soil_moisture_0_to_1cm,soil_moisture_3_to_9cm,soil_moisture_9_to_27cm'
        '&daily=et0_fao_evapotranspiration,precipitation_sum&forecast_days=7&timezone=UTC'
    )
    try:
        payload, meta = CACHE.fetch('open-meteo', url, ttl=TTL_SECONDS, refresh=refresh, kind='model_forecast', timeout=10)
        result['provenance'].append(public_meta(meta))
        hourly = payload.get('hourly') or {}
        daily = payload.get('daily') or {}
        times = hourly.get('time') or []
        t0 = hourly.get('soil_temperature_0cm') or []
        t6 = hourly.get('soil_temperature_6cm') or []
        m01 = hourly.get('soil_moisture_0_to_1cm') or []
        m39 = hourly.get('soil_moisture_3_to_9cm') or []
        m927 = hourly.get('soil_moisture_9_to_27cm') or []
        dates = daily.get('time') or []
        et0_list = daily.get('et0_fao_evapotranspiration') or []
        precip_list = daily.get('precipitation_sum') or []
        if not times or not t6 or not dates:
            result.update(status='invalid', reason='Відповідь Open-Meteo не містить очікуваних ґрунтових рядів.')
            return result

        future_idx = []
        current_idx = None
        for idx, raw_t in enumerate(times):
            try:
                parsed = dt.datetime.fromisoformat(raw_t).replace(tzinfo=dt.timezone.utc)
            except ValueError:
                continue
            if parsed >= now - dt.timedelta(hours=1):
                if current_idx is None:
                    current_idx = idx
                future_idx.append(idx)
        if not future_idx:
            future_idx = list(range(len(times)))
            current_idx = 0

        next_3d_idx = future_idx[:72]
        t6_7d = [_finite(t6[i], -60, 70) for i in future_idx if i < len(t6)]
        t6_7d = [v for v in t6_7d if v is not None]
        t6_3d = [_finite(t6[i], -60, 70) for i in next_3d_idx if i < len(t6)]
        t6_3d = [v for v in t6_3d if v is not None]

        m_01 = _finite(m01[current_idx], 0, 1) if current_idx < len(m01) else None
        m_39 = _finite(m39[current_idx], 0, 1) if current_idx < len(m39) else None
        m_927 = _finite(m927[current_idx], 0, 1) if current_idx < len(m927) else None
        m_vals = [v for v in (m_01, m_39, m_927) if v is not None]

        et0_vals = [_finite(v, 0, 30) for v in et0_list if _finite(v, 0, 30) is not None]
        precip_vals = [_finite(v, 0, 500) for v in precip_list if _finite(v, 0, 500) is not None]
        et0_7d = round(sum(et0_vals), 1) if et0_vals else None
        precip_7d = round(sum(precip_vals), 1) if precip_vals else None

        days = []
        for d_idx, day_str in enumerate(dates):
            day_t6 = [
                _finite(t6[i], -60, 70)
                for i in range(len(times))
                if str(times[i]).startswith(str(day_str)) and i < len(t6)
            ]
            day_t6 = [v for v in day_t6 if v is not None]
            days.append({
                'date': day_str,
                'soil_temp_6cm_min_c': round(min(day_t6), 1) if day_t6 else None,
                'soil_temp_6cm_max_c': round(max(day_t6), 1) if day_t6 else None,
                'et0_mm': round(et0_list[d_idx], 1) if d_idx < len(et0_list) and _finite(et0_list[d_idx], 0, 30) is not None else None,
                'precip_mm': round(precip_list[d_idx], 1) if d_idx < len(precip_list) and _finite(precip_list[d_idx], 0, 500) is not None else None,
            })

        result.update(
            available=True,
            status='available',
            reason='Модельний 7-денний прогноз ґрунту та ET0 Open-Meteo.',
            data={
                'current_soil_temp_0cm_c': round(_finite(t0[current_idx], -60, 70), 1) if current_idx < len(t0) and _finite(t0[current_idx], -60, 70) is not None else None,
                'current_soil_temp_6cm_c': round(_finite(t6[current_idx], -60, 70), 1) if current_idx < len(t6) and _finite(t6[current_idx], -60, 70) is not None else None,
                'soil_temp_6cm_next_3d_min_c': round(min(t6_3d), 1) if t6_3d else None,
                'soil_temp_6cm_next_3d_max_c': round(max(t6_3d), 1) if t6_3d else None,
                'soil_temp_6cm_7d_min_c': round(min(t6_7d), 1) if t6_7d else None,
                'soil_temp_6cm_7d_max_c': round(max(t6_7d), 1) if t6_7d else None,
                'current_soil_moisture_0_1_m3m3': round(m_01, 3) if m_01 is not None else None,
                'current_soil_moisture_3_9_m3m3': round(m_39, 3) if m_39 is not None else None,
                'current_soil_moisture_9_27_m3m3': round(m_927, 3) if m_927 is not None else None,
                'root_zone_moisture_mean_m3m3': round(sum(m_vals) / len(m_vals), 3) if m_vals else None,
                'et0_7d_mm': et0_7d,
                'precipitation_7d_mm': precip_7d,
                'net_ref_balance_7d_mm': round(max(0.0, et0_7d - 0.8 * precip_7d), 1) if et0_7d is not None and precip_7d is not None else None,
                'days': days,
            },
        )
        return result
    except (UpstreamError, ValueError, TypeError, KeyError) as exc:
        result.update(status='unavailable', reason=f'Не вдалося отримати модельні ґрунтові дані Open-Meteo: {exc}')
        return result


def indicative_guidance(crop, soil_forecast, agronomic_rules=None, irrigation_system=None, crop_growth_stage=None, crop_variety=None):
    """Build transparent model-based 7-day sowing temperature and irrigation guidance.

    Never returns certified sensor-based recommendations; marks itself clearly as model guidance.
    """
    out = {
        'is_model_indicative_only': True,
        'sowing_soil_check': None,
        'irrigation_7d_guidance': None,
    }
    if not soil_forecast or not soil_forecast.get('available') or not soil_forecast.get('data'):
        return out
    data = soil_forecast['data']
    rule = (agronomic_rules or {}).get('rule') or {}
    t_3d_min = data.get('soil_temp_6cm_next_3d_min_c')
    t_7d_max = data.get('soil_temp_6cm_7d_max_c')
    threshold_c = rule.get('threshold_temperature_C')
    range_c = rule.get('threshold_temperature_range_C')

    if isinstance(threshold_c, (int, float)) and t_3d_min is not None:
        meets = t_3d_min >= threshold_c
        out['sowing_soil_check'] = {
            'status': 'meets_threshold_3d' if meets else 'below_threshold_3d',
            'threshold_c': round(float(threshold_c), 1),
            'model_next_3d_min_c': t_3d_min,
            'model_7d_max_c': t_7d_max,
            'crop_variety': crop_variety,
            'summary': (
                f'За модельною сіткою (6 см) мінімум найближчих 3 днів {t_3d_min} °C ≥ опублікованого порогу {round(float(threshold_c), 1)} °C — теплові умови верхнього шару сприятливі (підтвердьте термометром на 5 см).'
                if meets
                else f'За модельною сіткою (6 см) мінімум найближчих 3 днів {t_3d_min} °C нижчий за поріг {round(float(threshold_c), 1)} °C (макс. за 7 днів {t_7d_max} °C) — ґрунт ще прохолодний для сівби.'
            ),
        }
    elif isinstance(range_c, list) and len(range_c) == 2 and t_3d_min is not None:
        lo, hi = float(range_c[0]), float(range_c[1])
        status = 'above_range' if t_3d_min >= hi else 'within_range' if t_3d_min >= lo else 'below_range'
        out['sowing_soil_check'] = {
            'status': status,
            'threshold_range_c': [round(lo, 1), round(hi, 1)],
            'model_next_3d_min_c': t_3d_min,
            'model_7d_max_c': t_7d_max,
            'crop_variety': crop_variety,
            'summary': (
                f'Модельна температура 6 см ({t_3d_min} °C) вища за діапазон {round(lo, 1)}–{round(hi, 1)} °C.'
                if status == 'above_range'
                else f'Модельна температура 6 см ({t_3d_min} °C) у межах довідкового діапазону {round(lo, 1)}–{round(hi, 1)} °C.'
                if status == 'within_range'
                else f'Модельна температура 6 см ({t_3d_min} °C) нижча за поріг {round(lo, 1)}–{round(hi, 1)} °C — сівба передчасна без локального потепління.'
            ),
        }

    et0_7d = data.get('et0_7d_mm')
    precip_7d = data.get('precipitation_7d_mm')
    kc = _stage_kc(crop, crop_growth_stage)
    eff = IRRIGATION_EFFICIENCIES.get(irrigation_system)
    if et0_7d is not None and precip_7d is not None:
        active_kc = kc if kc is not None else 0.85
        crop_etc = round(et0_7d * active_kc, 1)
        eff_rain = round(0.8 * precip_7d, 1)
        net_deficit = round(max(0.0, crop_etc - eff_rain), 1)
        gross_mm = round(net_deficit / eff, 1) if eff and net_deficit > 0 else (0.0 if eff else None)
        out['irrigation_7d_guidance'] = {
            'status': 'calculated_with_user_params' if (kc is not None and irrigation_system in IRRIGATION_EFFICIENCIES) else 'reference_et0_only',
            'crop_growth_stage': crop_growth_stage,
            'kc_used': active_kc,
            'kc_source': 'user_stage' if kc is not None else 'mid_season_reference',
            'irrigation_system': irrigation_system,
            'system_efficiency': eff,
            'et0_7d_mm': et0_7d,
            'crop_etc_7d_mm': crop_etc,
            'precipitation_7d_mm': precip_7d,
            'effective_rain_7d_mm': eff_rain,
            'net_deficit_7d_mm': net_deficit,
            'gross_irrigation_7d_mm': gross_mm,
        }
    return out
