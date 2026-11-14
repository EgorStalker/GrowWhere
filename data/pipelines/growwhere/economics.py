"""USDA ERS regional annual costs and harvest prices, with explicit gaps.

This adapter does not provide live sale quotes, demand estimates, or a farm-level
budget. It never substitutes a different year or merges two regions.
"""
from __future__ import annotations

import csv
import html
import io
import math
import re
from urllib.parse import urljoin, urlparse

PAGE_URL = 'https://www.ers.usda.gov/data-products/commodity-costs-and-returns'
DOCUMENTATION_URL = PAGE_URL + '/documentation'
CONVERSION_SOURCE = 'https://www.ams.usda.gov/sites/default/files/media/Book2.pdf'
SOURCE_ID = 'usda-ers-costs'
ACRES_PER_HECTARE = 2.47105381467165
KILOGRAMS_PER_POUND = 0.45359237
CROPS = {
    'corn': {'file':'corn.csv', 'commodity':'Corn', 'pounds_per_bushel':56},
    'soy': {'file':'soybeans.csv', 'commodity':'Soybean', 'pounds_per_bushel':60},
    'wheat': {'file':'wheat.csv', 'commodity':'Wheat', 'pounds_per_bushel':60},
    'sorghum': {'file':'sorghum.csv', 'commodity':'Sorghum', 'pounds_per_bushel':56},
    'barley': {'file':'barley.csv', 'commodity':'Barley', 'pounds_per_bushel':48},
    'oats': {'file':'oats.csv', 'commodity':'Oats', 'pounds_per_bushel':32},
    'cotton': {'file':'cotton.csv', 'commodity':'Cotton', 'pounds_per_unit':1, 'price_unit':'dollars per pound'},
}
PREFERRED_REGION = 'Prairie Gateway'
FALLBACK_REGION = 'U.S. total'
COST_UNIT = 'dollars per planted acre'
PRICE_UNIT = 'dollars per bushel at harvest'
TTL_SECONDS = 86400


def finite_nonnegative(value):
    """Preserve genuine zero, reject blanks, markers, NaN and sentinel values."""
    try:
        if value is None or str(value).strip() == '':
            return None
        result = float(str(value).strip().replace(',', ''))
    except (ValueError, TypeError):
        return None
    return result if math.isfinite(result) and result >= 0 else None


def discover_csv(page, crop):
    """Use the current official page's link, including its revision query string."""
    if crop not in CROPS:
        raise ValueError('Unsupported crop')
    expected = CROPS[crop]['file']
    for href in re.findall(r'href\s*=\s*[\"\']([^\"\']+)[\"\']', page, re.I):
        url = urljoin(PAGE_URL, html.unescape(href))
        parsed = urlparse(url)
        if (parsed.scheme == 'https' and parsed.hostname in {'www.ers.usda.gov', 'ers.usda.gov'}
                and parsed.path.rsplit('/', 1)[-1].lower() == expected):
            return url
    return None


def parse_csv(text):
    reader = csv.DictReader(io.StringIO(text.lstrip('\ufeff')))
    required = {'Commodity', 'Item', 'Units', 'Size', 'Region', 'Country', 'Year', 'Value'}
    if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
        raise ValueError('USDA ERS CSV schema is not recognized')
    return list(reader)


def _selected_value(rows, item, expected_unit):
    matching = [row for row in rows if row.get('Item', '').strip() == item]
    valid = [row for row in matching if row.get('Units', '').strip() == expected_unit]
    # Conflicting duplicate observations must not be resolved by source order.
    values = {finite_nonnegative(row.get('Value')) for row in valid}
    values.discard(None)
    if len(values) != 1:
        return None, 'ambiguous_value' if len(values) > 1 else 'missing_value'
    if any(finite_nonnegative(row.get('Value')) is None for row in valid):
        return None, 'ambiguous_missing_value'
    return next(iter(values)), None


def select_observations(rows, crop, year):
    """Choose one exact year/region/size before selecting any measure."""
    if crop not in CROPS:
        raise ValueError('Unsupported crop')
    expected = CROPS[crop]['commodity']
    candidates = [row for row in rows
                  if row.get('Commodity', '').strip() == expected
                  and row.get('Country', '').strip() == 'United States'
                  and row.get('Size', '').strip() == 'No specific size'
                  and row.get('Year', '').strip() == str(year)]
    available_regions = {row.get('Region', '').strip() for row in candidates}
    region = PREFERRED_REGION if PREFERRED_REGION in available_regions else (
        FALLBACK_REGION if FALLBACK_REGION in available_regions else None)
    selected = [row for row in candidates if row.get('Region', '').strip() == region] if region else []
    crop_info = CROPS[crop]
    price_unit = crop_info.get('price_unit', PRICE_UNIT)
    pounds_per_unit = crop_info.get('pounds_per_unit', crop_info.get('pounds_per_bushel'))
    cost, cost_error = _selected_value(selected, 'Total, costs listed', COST_UNIT)
    price, price_error = _selected_value(selected, 'Price', price_unit)
    missing = ['market']
    errors = {}
    if region is None:
        missing.append('region_year')
    if cost is None:
        missing.append('cost_per_ha')
        errors['cost_per_ha'] = cost_error
    if price is None:
        missing.append('price_per_tonne')
        errors['price_per_tonne'] = price_error
    factor = 1000 / (pounds_per_unit * KILOGRAMS_PER_POUND)
    return {
        'crop': crop,
        'commodity_scope': 'Wheat, all reported types; not a spring-wheat-only series' if crop=='wheat' else crop_info['commodity'],
        'year': int(year),
        'actual_year': int(year) if selected else None,
        'region': region,
        'region_is_fallback': region == FALLBACK_REGION,
        'cost_per_ha': round(cost * ACRES_PER_HECTARE, 2) if cost is not None else None,
        'price_per_tonne': round(price * factor, 2) if price is not None else None,
        'cost_original': cost,
        'cost_original_unit': COST_UNIT if cost is not None else None,
        'price_original': price,
        'price_original_unit': price_unit if price is not None else None,
        'currency': 'USD',
        'cost_basis': 'Total costs listed, including allocated overhead; per planted area',
        'price_basis': 'Annual regional harvest price; not a current market quote',
        'market': None,
        'market_reason': 'USDA ERS annual costs and returns do not establish current demand',
        'missing': missing,
        'field_errors': errors,
        'survey_base_years': sorted({row.get('Survey base year', '').strip() for row in selected
                                     if row.get('Item', '').strip() in {'Price', 'Total, costs listed'}
                                     and row.get('Survey base year', '').strip()}),
        'conversion': {
            'acres_per_hectare': ACRES_PER_HECTARE,
            'pounds_per_bushel': crop_info.get('pounds_per_bushel'),
            'pounds_per_unit': pounds_per_unit,
            'kilograms_per_pound': KILOGRAMS_PER_POUND,
            'bushels_per_metric_tonne': factor if 'pounds_per_bushel' in crop_info else None,
            'units_per_metric_tonne': factor,
            'source_url': CONVERSION_SOURCE,
        },
    }


def economics(crop, year, refresh=False, cache=None):
    """Return real observations or explicit missing fields; no synthetic fallback."""
    if crop not in CROPS:
        raise ValueError('Unsupported crop')
    if isinstance(year, bool) or not str(year).isdigit() or not 1900 <= int(year) <= 2100:
        raise ValueError('Invalid year')
    year = int(year)
    if cache is None:
        from .sources import CACHE
        cache = CACHE
    try:
        page, page_meta = cache.fetch(SOURCE_ID, PAGE_URL, ttl=TTL_SECONDS,
                                      refresh=refresh, kind='model_estimate', format='text')
        csv_url = discover_csv(page, crop)
        if not csv_url:
            raise ValueError('Current official CSV link was not found')
        text, meta = cache.fetch(SOURCE_ID, csv_url, ttl=TTL_SECONDS,
                                refresh=refresh, kind='model_estimate', format='text')
        result = select_observations(parse_csv(text), crop, year)
        result.update({
            'source_url': csv_url,
            'source_page': PAGE_URL,
            'documentation_url': DOCUMENTATION_URL,
            'retrieved_at': meta.get('retrieved_at'),
            'source_meta': [page_meta, meta],
            'is_demo': False,
            'status': 'available' if result['cost_per_ha'] is not None or result['price_per_tonne'] is not None else 'no_data',
            'errors': [],
        })
        return result
    except Exception as exc:
        # The error is visible; failed refreshes cannot masquerade as new data.
        return {
            'crop': crop, 'year': year, 'actual_year': None, 'region': None,
            'region_is_fallback': False, 'cost_per_ha': None, 'price_per_tonne': None,
            'market': None, 'source_url': PAGE_URL, 'retrieved_at': None,
            'source_meta': [], 'is_demo': False, 'status': 'no_data',
            'price_basis': 'Annual regional harvest price; not a current market quote',
            'missing': ['cost_per_ha', 'price_per_tonne', 'market'],
            'errors': [f'USDA ERS unavailable: {type(exc).__name__}: {str(exc)[:250]}'],
        }
