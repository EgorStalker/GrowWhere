"""Read verified agronomy evidence without turning partial rules into advice.

No dates, irrigation amounts, weather downloads or planting-zone guesses are
computed here. Readiness describes the rule evidence, not a field assessment.
"""
import copy
import json
from pathlib import Path


REGISTRY_PATH = Path(__file__).resolve().parents[2] / 'catalog' / 'agronomic-rules.json'


def _load_registry():
    registry = json.loads(REGISTRY_PATH.read_text(encoding='utf-8'))
    if not isinstance(registry, dict) or registry.get('schema_version') != '1.0' or not isinstance(registry.get('rules'), list):
        raise ValueError('Unsupported agronomic rule registry')
    rows = registry['rules']
    ids = [row.get('crop_id') for row in rows if isinstance(row, dict)]
    if len(ids) != len(rows) or any(not isinstance(cid, str) or not cid for cid in ids) or len(ids) != len(set(ids)):
        raise ValueError('Invalid or duplicate agronomic crop rule')
    for row in rows:
        if not isinstance(row.get('status', ''), str) or not isinstance(row.get('blockers', []), list):
            raise ValueError('Invalid agronomic rule status or blockers')
    return registry


def get_agronomic_rule(crop_id):
    """Return isolated evidence for a crop; missing/broken evidence returns None."""
    try:
        registry = _load_registry()
    except (OSError, ValueError, TypeError):
        return None
    row = next((row for row in registry['rules'] if row['crop_id'] == crop_id), None)
    return copy.deepcopy(row) if row else None


def assess_agronomic_readiness(crop_id, region='US-KS'):
    """Fail closed on missing local rules; never calculate a sowing date.

    Callers must separately check current field/forecast inputs. Even a future
    validated rule registry cannot make a site-specific recommendation here.
    """
    result = {'crop_id': crop_id, 'region': region, 'status': 'blocked',
              'recommendation_supported': False, 'blockers': [], 'rule': None,
              'recommended_sowing_date': None, 'recommended_irrigation_mm': None}
    try:
        registry = _load_registry()
    except (OSError, ValueError, TypeError):
        result['blockers'] = ['agronomic_registry_unavailable']
        return result
    row = next((row for row in registry['rules'] if row['crop_id'] == crop_id), None)
    if row is None:
        result['blockers'] = ['agronomic_crop_rule_missing']
        return result
    result['rule'] = copy.deepcopy(row)
    result['verified_at'] = row.get('verified_at')
    blockers = list(row.get('blockers') or [])
    if row.get('region') != region:
        blockers.append('agronomic_region_unsupported')
        result['status'] = 'unsupported'
    if row.get('status', '').startswith('not_recommended'):
        blockers.append('crop_not_recommended_by_local_guide')
        result['status'] = 'unsupported'
    if row.get('validated_for_automated_advice') is not True:
        blockers.append('agronomic_rule_not_validated_for_automated_advice')
    if row.get('threshold_temperature_C') is None:
        if row.get('threshold_temperature_range_C'):
            blockers.append('local_temperature_threshold_selection_required')
        else:
            blockers.append('soil_temperature_rule_missing')
    if row.get('measurement_depth_cm') is None:
        blockers.append('soil_temperature_measurement_depth_missing')
    window = row.get('seasonal_window')
    if not window:
        blockers.append('local_seasonal_window_missing')
    elif window.get('zone_assignment_required'):
        source = registry.get('sources', {}).get(window.get('source_id'), {})
        if source.get('zone_geometry_available') is not True:
            blockers.append('missing_planting_zone_geometry')
    if not (row.get('frost_restrictions') or {}).get('rule'):
        blockers.append('local_frost_rule_missing')
    if (row.get('soil_workability_rule') or {}).get('availability') != 'verified':
        blockers.append('soil_workability_rule_missing')
    result['blockers'] = list(dict.fromkeys(blockers))
    # This reader intentionally never returns a field-level "ready" decision.
    if not result['blockers']:
        result['blockers'] = ['current_field_and_forecast_validation_required']
    return result
