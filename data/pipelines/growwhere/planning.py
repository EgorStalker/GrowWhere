"""Capability gates for planning; historical scenarios never become advice.

This module describes the implemented integrations, not a prediction that an
upstream service has complete measurements for a particular parcel. It performs
no downloads and never rolls a historical planting date into the next season.
"""
import datetime as dt
import math

from .analysis import PROFILES
from .service import COVERAGE

READINESS_VERSION = 'growwhere-planning-readiness-0.1'
MODES = {'own_land', 'find_land'}
MODE_ALIASES = {'ownland': 'own_land', 'search': 'find_land',
                'search_land': 'find_land', 'find_optimal': 'find_land'}
SOWING_MISSING = ['validated_weather_forecast', 'current_soil_temperature',
                  'validated_local_sowing_rules', 'crop_variety_and_target_season']
IRRIGATION_MISSING = ['validated_weather_forecast', 'current_root_zone_water_storage',
                      'verified_root_depth_and_soil_profile',
                      'irrigation_system_efficiency', 'crop_growth_stage']
GAP_LABELS = {
    'validated_weather_forecast': 'No forecast with a verified horizon for the selected planning period.',
    'current_soil_temperature': 'No verified current soil temperature.',
    'validated_local_sowing_rules': 'Local rules are not yet validated for automated sowing-date selection.',
    'crop_variety_and_target_season': 'Crop variety and the target season are required.',
    'current_root_zone_water_storage': 'No verified current available water storage in the root zone.',
    'verified_root_depth_and_soil_profile': 'Root depth and a soil profile covering the full root zone are required.',
    'irrigation_system_efficiency': 'Irrigation system efficiency is unspecified.',
    'crop_growth_stage': 'Crop growth stage is unspecified.',
    'selected_crop': 'Select a crop first.',
    'selected_area': 'Select a field or a search region first.',
    'unsupported_coverage': 'This version has no analytical coverage for this area.',
    'partial_coverage': 'Part of the selected area is outside analytical coverage.',
    'past_target_year': 'The target year is in the past and cannot be presented as a future plan.',
    'target_season': 'Specify the target planning season.',
}


def _finite(value, label):
    if isinstance(value, bool):
        raise ValueError(f'{label} must be a finite number')
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f'{label} must be a finite number') from exc
    if not math.isfinite(result):
        raise ValueError(f'{label} must be a finite number')
    return result


def _coverage(lon, lat, bbox):
    if (lon is None) != (lat is None):
        raise ValueError('Both longitude and latitude are required for a point')
    if lon is not None and bbox is not None:
        raise ValueError('Provide a point or a bbox, not both')
    west, south, east, north = COVERAGE
    if lon is not None:
        lon, lat = _finite(lon, 'longitude'), _finite(lat, 'latitude')
        if not -180 <= lon <= 180 or not -90 <= lat <= 90:
            raise ValueError('Point is outside WGS84 bounds')
        supported = west <= lon <= east and south <= lat <= north
        return {'status': 'supported' if supported else 'unsupported',
                'supported': supported, 'point': [lon, lat], 'bbox': None,
                'supported_bbox': list(COVERAGE)}
    if bbox is not None:
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            raise ValueError('bbox must contain west,south,east,north')
        left, bottom, right, top = [_finite(value, 'bbox coordinate') for value in bbox]
        if not -180 <= left < right <= 180 or not -85 <= bottom < top <= 85:
            raise ValueError('Invalid WGS84 bbox')
        intersects = max(left, west) < min(right, east) and max(bottom, south) < min(top, north)
        contained = west <= left and right <= east and south <= bottom and top <= north
        return {'status': 'supported' if contained else 'partial' if intersects else 'unsupported',
                'supported': contained, 'supported_subset': intersects,
                'point': None, 'bbox': [left, bottom, right, top],
                'supported_bbox': list(COVERAGE)}
    return {'status': 'not_selected', 'supported': False, 'point': None,
            'bbox': None, 'supported_bbox': list(COVERAGE)}


def _evidence_checks(evidence):
    """Normalize trusted adapter assessments, not raw client claims.

    A future adapter supplies one check for each requirement after checking
    units, freshness, scope and agronomic applicability. Merely downloading a
    forecast does not verify a sowing rule or the entire root-zone profile.
    This argument is intentionally not exposed as a public HTTP parameter.
    """
    if evidence is None:
        evidence = {}
    if not isinstance(evidence, dict):
        raise ValueError('evidence must be a mapping of trusted adapter checks')
    checks = {}
    for key in dict.fromkeys(SOWING_MISSING + IRRIGATION_MISSING):
        item = evidence.get(key, {})
        if not isinstance(item, dict):
            raise ValueError('Each evidence check must be a mapping')
        source_ref = item.get('source_url') or item.get('source_ref')
        ready = (item.get('status') == 'available' and item.get('verified') is True
                 and item.get('supports_selected_scope') is True
                 and isinstance(source_ref, str) and bool(source_ref.strip()))
        checks[key] = {
            'status': 'available' if ready else 'missing_or_unverified',
            'verified': ready,
            'supports_selected_scope': item.get('supports_selected_scope') is True,
            'source_ref': source_ref if isinstance(source_ref, str) else None,
            'checked_at': item.get('checked_at'),
            'reason': item.get('reason') if isinstance(item.get('reason'), str) else GAP_LABELS[key],
        }
    return checks


def planning_readiness(mode='own_land', crop=None, lon=None, lat=None, bbox=None,
                       target_year=None, scale_ha=None, today=None, evidence=None):
    """Return explicit blockers before any sowing or irrigation recommendation.

    `historical_suitability.available` means that the implemented research mode
    can be requested for this scope; it never guarantees per-cell completeness.
    `scale_ha` is an optional, positive, finite area explicitly expressed in ha.
    Optional `evidence` is server-generated assessment of new adapters. Ready
    checks enable calculation; this report itself never generates advice values.
    """
    mode = MODE_ALIASES.get(mode, mode)
    if mode not in MODES:
        raise ValueError('Unsupported planning mode')
    if crop is not None and crop not in PROFILES:
        raise ValueError('Unsupported crop')
    if today is None:
        today = dt.datetime.now(dt.timezone.utc).date()
    if isinstance(today, dt.datetime):
        today = today.date()
    if not isinstance(today, dt.date):
        raise ValueError('today must be a date')
    if target_year is not None:
        if isinstance(target_year, bool) or not str(target_year).isdigit() or not 1900 <= int(target_year) <= 2100:
            raise ValueError('Invalid target year')
        target_year = int(target_year)
    if scale_ha is not None:
        scale_ha = _finite(scale_ha, 'scale_ha')
        if scale_ha <= 0:
            raise ValueError('scale_ha must be positive and expressed in hectares')
    coverage = _coverage(lon, lat, bbox)
    scope_missing = []
    if crop is None:
        scope_missing.append('selected_crop')
    if coverage['status'] == 'not_selected':
        scope_missing.append('selected_area')
    elif coverage['status'] == 'unsupported':
        scope_missing.append('unsupported_coverage')
    elif coverage['status'] == 'partial':
        scope_missing.append('partial_coverage')
    past_target = target_year is not None and target_year < today.year
    target_status = ('unspecified' if target_year is None else 'past' if past_target
                     else 'current' if target_year == today.year else 'future')
    checks = _evidence_checks(evidence)
    target_missing = ['target_season'] if target_year is None else []
    sowing_missing = list(dict.fromkeys(scope_missing + target_missing + [key for key in SOWING_MISSING if not checks[key]['verified']]))
    irrigation_missing = list(dict.fromkeys(scope_missing + target_missing + [key for key in IRRIGATION_MISSING if not checks[key]['verified']]))
    if past_target:
        sowing_missing.append('past_target_year')
        irrigation_missing.append('past_target_year')
    critical = list(dict.fromkeys(sowing_missing + irrigation_missing))
    sowing_ready = not sowing_missing
    irrigation_ready = not irrigation_missing
    all_ready = sowing_ready and irrigation_ready
    profile = PROFILES.get(crop, {})
    return {
        'version': READINESS_VERSION,
        'mode': mode,
        'crop': crop,
        'target_year': target_year,
        'target_year_status': target_status,
        'scale': {'value': scale_ha, 'unit': 'ha'},
        'coverage': coverage,
        'ready_for_recommendations': all_ready,
        'ready_for_calculation': all_ready,
        'recommendations_generated': False,
        'status': 'ready_for_calculation' if all_ready else 'blocked_by_critical_data',
        'evidence_checks': checks,
        'critical_gaps': [{'id': key, 'message': checks[key]['reason'] if key in checks else GAP_LABELS[key]} for key in critical],
        'future_sowing_date': {
            'available': sowing_ready, 'value': None, 'status': 'ready_for_calculation' if sowing_ready else 'insufficient_data',
            'missing': sowing_missing,
            'reason': 'Input checks passed; a separate planning module must calculate the date.' if sowing_ready else 'Critical inputs for a current sowing-date recommendation are missing.',
        },
        'irrigation_recommendation': {
            'available': irrigation_ready, 'value': None, 'unit': 'mm', 'status': 'ready_for_calculation' if irrigation_ready else 'insufficient_data',
            'missing': irrigation_missing,
            'reason': 'Input checks passed; a separate planning module must calculate irrigation.' if irrigation_ready else 'Critical inputs for an irrigation recommendation are missing.',
        },
        'historical_suitability': {
            'available': not scope_missing,
            'status': 'available_with_per_cell_checks' if not scope_missing else 'scope_not_ready',
            'missing': scope_missing,
            'data_complete': None,
            'requires_complete_per_cell': True,
            'scientifically_validated': False,
            'source_integrations': ['nasa-power', 'ssurgo-statsgo2', 'usda-cdl'],
            'reason': 'Only research screening of the selected historical season is available. Completeness is checked separately for each area.',
        },
        'scenario_metadata': {
            'reference_month_day': profile.get('default_planting'),
            'purpose': 'historical_analysis_only',
            'label': 'Research-model historical reference calendar',
            'is_agronomic_recommendation': False,
        },
        'assessment_policy': {
            'missing_critical_data': 'announce_before_dependent_implementation',
            'missing_recommendation_value': None,
            'historical_dates_are_future_advice': False,
            'index_resolution_can_exceed_source_resolution': False,
        },
    }
