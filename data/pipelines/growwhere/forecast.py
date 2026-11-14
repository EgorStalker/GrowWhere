"""NOAA NWS short-range point forecast, never soil temperature or sowing advice."""
import datetime as dt
import math
from urllib.parse import urlsplit

from .sources import CACHE, UpstreamError
from .service import public_meta

TTL_SECONDS = 3600
MAX_ISSUE_AGE_HOURS = 24  # Conservative local freshness gate, not an NWS guarantee.
MIN_HORIZON_HOURS = 24
KANSAS_BBOX = (-102.1, 36.9, -94.5, 40.1)


def _instant(value):
    result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Forecast timestamps must include a timezone')
    return result.astimezone(dt.timezone.utc)


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('Invalid forecast numeric value')
    return value


def _hourly_url(value):
    if not isinstance(value, str):
        raise ValueError('Missing hourly forecast endpoint')
    url = urlsplit(value)
    if url.scheme != 'https' or url.netloc != 'api.weather.gov' or not url.path.startswith('/gridpoints/') or not url.path.endswith('/forecast/hourly') or url.query or url.fragment:
        raise ValueError('Unexpected hourly forecast endpoint')
    return value


def nws_forecast(lon, lat, refresh=False, now=None):
    """Return fresh hourly air forecasts for a Kansas point, or explicit no data.

    SourceCache archives unmodified responses with SHA-256 and fetch provenance.
    A forecast is usable here only with >=24h remaining and issue age <=24h.
    Precipitation probability is not precipitation amount or irrigation demand.
    """
    now = now or dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None:
        raise ValueError('now must include a timezone')
    now = now.astimezone(dt.timezone.utc)
    result = {
        'available': False, 'status': 'unavailable', 'data': None,
        'source_id': 'noaa-nws', 'kind': 'forecast', 'provenance': [],
        'reason': None,
        'freshness': {'cache_ttl_seconds': TTL_SECONDS,
                      'max_issue_age_hours': MAX_ISSUE_AGE_HOURS,
                      'minimum_remaining_horizon_hours': MIN_HORIZON_HOURS,
                      'checked_at': now.isoformat(), 'issue_age_hours': None},
        'limitations': [
            'Короткий прогноз повітря на сітці NWS близько 2,5 км; це не вимірювання ґрунту на полі.',
            'Імовірність опадів не є кількістю опадів або нормою поливу.',
            'Прогноз не визначає самостійно дату сівби та не покриває весь майбутній сезон.',
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
        result.update(status='outside_pilot_coverage', reason='Прогноз у цій версії підключено лише для пілотної області Канзасу.')
        return result
    result['point'] = {'lon': lon, 'lat': lat}
    try:
        point, meta = CACHE.fetch('noaa-nws', f'https://api.weather.gov/points/{lat:.4f},{lon:.4f}',
                                  ttl=TTL_SECONDS, refresh=refresh, kind='forecast', timeout=10)
        result['provenance'].append(public_meta(meta))
        url = _hourly_url(point['properties'].get('forecastHourly'))
        payload, meta = CACHE.fetch('noaa-nws', url, ttl=TTL_SECONDS, refresh=refresh, kind='forecast', timeout=10)
        result['provenance'].append(public_meta(meta))
        properties = payload['properties']
        issued = _instant(properties['updateTime'])
        age = (now - issued).total_seconds() / 3600
        result['freshness']['issue_age_hours'] = round(age, 2)
        if age < -0.25 or age > MAX_ISSUE_AGE_HOURS:
            result.update(status='stale', reason='Випуск прогнозу застарілий або має непідтверджений час.')
            return result
        periods = []
        previous_end = None
        for raw in properties['periods']:
            start, end = _instant(raw['startTime']), _instant(raw['endTime'])
            if end <= start:
                raise ValueError('Invalid forecast interval')
            if end <= now or start >= now + dt.timedelta(days=7):
                continue
            temperature = _number(raw['temperature'])
            if raw['temperatureUnit'] == 'F':
                temperature = (temperature - 32) * 5 / 9
            elif raw['temperatureUnit'] != 'C':
                raise ValueError('Unknown forecast temperature unit')
            if not -100 <= temperature <= 70:
                raise ValueError('Implausible forecast air temperature')
            probability = raw.get('probabilityOfPrecipitation') or {}
            pop = probability.get('value')
            if pop is not None:
                pop = _number(pop)
                if probability.get('unitCode') != 'wmoUnit:percent' or not 0 <= pop <= 100:
                    raise ValueError('Invalid precipitation probability unit/value')
            if previous_end is not None and start != previous_end:
                raise ValueError('Forecast periods are not contiguous')
            previous_end = end
            periods.append({'start': start.isoformat(), 'end': end.isoformat(),
                            'air_temperature_c': round(temperature, 2),
                            'precipitation_probability_pct': pop,
                            'short_forecast': raw.get('shortForecast')})
        if not periods or _instant(periods[0]['start']) > now + dt.timedelta(hours=2) or (_instant(periods[-1]['end']) - now).total_seconds() < MIN_HORIZON_HOURS * 3600:
            result.update(status='insufficient_horizon', reason='Прогноз не має достатнього актуального погодинного горизонту.')
            return result
        result.update(available=True, status='available', reason='Актуальний короткий прогноз NOAA NWS.',
                      data={'issued_at': issued.isoformat(), 'valid_from': periods[0]['start'],
                            'valid_to': periods[-1]['end'], 'period_count': len(periods), 'periods': periods})
    except (UpstreamError, KeyError, TypeError, ValueError, AttributeError) as exc:
        result.update(status='source_unavailable_or_invalid', reason='Не вдалося отримати або перевірити актуальний прогноз NOAA NWS.',
                      error=str(exc)[:220])
    return result


def forecast_evidence(forecast, target_year=None):
    """Trusted adapter evidence only; public query parameters cannot assert it."""
    year = _instant(forecast['freshness']['checked_at']).year
    usable = forecast['available'] and (target_year is None or int(target_year) == year)
    return {'status': 'available' if usable else 'missing', 'verified': bool(usable),
            'supports_selected_scope': bool(usable),
            'source_url': forecast['provenance'][-1]['source_url'] if forecast['provenance'] else None,
            'checked_at': forecast['freshness']['checked_at'],
            'reason': ('Прогноз NOAA NWS доступний лише для поточного короткого горизонту; для обраного року його недостатньо.'
                       if forecast['available'] and not usable else forecast['reason'])}
