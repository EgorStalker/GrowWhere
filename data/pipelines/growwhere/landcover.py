"""Exact-year USDA CDL point samples from CroplandCROS, without API keys.

Point samples are not polygon-wide fractions or a land-conversion permission.
"""
from __future__ import annotations

import concurrent.futures
import json
import math
import threading
import time
from urllib.parse import urlencode

_POINT_CACHE_LOCK = threading.Lock()
_POINT_CACHE_BY_YEAR = {}

SERVICE_URL = 'https://pdi.scinet.usda.gov/image/rest/services/CDL_WM/ImageServer'
METADATA_URL = 'https://www.nass.usda.gov/Research_and_Science/Cropland/metadata/metadata_CDL25_FGDC-STD-001-1998.htm'
SOURCE_ID = 'usda-cdl'
TTL_SECONDS = 86400
BATCH_SIZE = 40
EXCLUDED = {
    'water': {83, 111},
    'urban': {82, 121, 122, 123, 124},
    'forest': {63, 141, 142, 143},
    'wetland': {87, 190, 195},
    'snow': {112},
}
PASTURE_CODES = {62, 176}
NODATA_CODES = {0, 81, 255}
# Only recognized, nonempty labels in the fetched USDA legend are eligible.
CROPLAND_CODES = (set(range(1, 62)) | set(range(66, 81)) | set(range(204, 251)) | {254})


def _number(value):
    try:
        if value is None or str(value).strip() == '': return None
        number = float(value)
    except (TypeError, ValueError): return None
    return number if math.isfinite(number) else None


def category_for(code, label):
    """Unknown codes stay unknown; pasture is context, not automatic suitability."""
    if code in NODATA_CODES or not label:
        return 'unknown', None
    for category, codes in EXCLUDED.items():
        if code in codes: return category, False
    if code in PASTURE_CODES: return 'pasture', True
    if code in CROPLAND_CODES: return 'cropland', True
    return ('barren', None) if code in {65, 131} else ('other', None)


def _unknown(year, reason, lon=None, lat=None):
    return {'code':None, 'category':'unknown', 'allow_analysis':None, 'label':None,
            'source_category':None, 'year':year, 'source_url':SERVICE_URL,
            'reason':reason, 'sample_lon':lon, 'sample_lat':lat,
            'sample_only':True, 'resolution_m':None}


def _normalize_centers(centers):
    normalized=[]
    seen=set()
    for item in centers:
        if isinstance(item, dict):
            identifier=str(item['id']);lon=_number(item.get('lon'));lat=_number(item.get('lat'))
        else:
            identifier=str(item[0]);lon=_number(item[1]);lat=_number(item[2])
        if identifier in seen: raise ValueError('Duplicate sample ID')
        seen.add(identifier)
        if lon is None or lat is None or not -180<=lon<=180 or not -90<=lat<=90:
            raise ValueError('Invalid point coordinates')
        normalized.append({'id':identifier,'lon':lon,'lat':lat})
    return normalized


def _url(operation, **parameters):
    return SERVICE_URL + '/' + operation + '?' + urlencode({'f':'json', **parameters})


def _legend(response):
    result={}
    for feature in response.get('features',[]):
        attrs=feature.get('attributes',{})
        code=_number(attrs.get('Value'));label=attrs.get('Class_Names')
        if code is not None and code.is_integer() and isinstance(label,str) and label.strip():
            result[int(code)]=label.strip()
    return result


def _interpret_samples(response, centers, year, legend, source_url):
    output={point['id']:_unknown(year,'sample_not_returned',point['lon'],point['lat']) for point in centers}
    records={}
    for sample in response.get('samples',[]):
        location=sample.get('location',{})
        # The request's geometry is EPSG:4326; reject a changed response CRS.
        sr=location.get('spatialReference',{})
        if sr and sr.get('latestWkid',sr.get('wkid'))!=4326: continue
        x=_number(location.get('x'));y=_number(location.get('y'))
        index=_number(sample.get('locationId'))
        if x is None or y is None: continue
        if index is not None and index.is_integer() and 0<=index<len(centers):
            candidates=[centers[int(index)]]
        else:
            candidates=[point for point in centers if abs(point['lon']-x)<1e-7 and abs(point['lat']-y)<1e-7]
        for point in candidates:
            if abs(point['lon']-x)>1e-6 or abs(point['lat']-y)>1e-6: continue
            attrs=sample.get('attributes',{})
            actual_year=_number(attrs.get('Year'))
            if actual_year!=year:
                records.setdefault(point['id'],[]).append(_unknown(year,'year_mismatch',x,y));continue
            value=_number(sample.get('value'))
            code=int(value) if value is not None and value.is_integer() else None
            label=legend.get(code)
            category,allow=category_for(code,label)
            resolution=_number(sample.get('resolution'))
            records.setdefault(point['id'],[]).append({
                'code':code,'category':category,'allow_analysis':allow,'label':label,
                'source_category':label,'year':int(actual_year),'source_url':source_url,
                'reason':'pasture_is_not_cropland' if category=='pasture' else 'unknown_code' if allow is None else None,
                'sample_lon':x,'sample_lat':y,'sample_only':True,
                'resolution_m':resolution if resolution is not None and resolution>0 else None,
                'raster_id':sample.get('rasterId'),'raster_name':attrs.get('Name'),
            })
    for identifier, values in records.items():
        # Don't silently pick a raster if a supposedly exact-year query is ambiguous.
        identities={(r.get('code'),r.get('year'),r.get('category')) for r in values}
        if len(identities)==1:
            output[identifier]=values[0]
        else:
            point=next(p for p in centers if p['id']==identifier)
            output[identifier]=_unknown(year,'ambiguous_samples',point['lon'],point['lat'])
    return output


def classify_points(centers, year, refresh=False, cache=None):
    """Classify up to 600 points in bounded 40-point requests, 3 concurrent.

    Input: [{'id': str, 'lon': float, 'lat': float}] or (id, lon, lat).
    Missing year/point/code/response => allow_analysis=None; no year fallback.
    """
    if isinstance(year,bool) or not str(year).isdigit() or not 1997<=int(year)<=2100:
        raise ValueError('Invalid CDL year')
    year=int(year)
    centers=_normalize_centers(centers)
    if len(centers)>600: raise ValueError('Too many CDL samples in one analysis')
    result={'by_id':{p['id']:_unknown(year,'not_requested',p['lon'],p['lat']) for p in centers},
            'meta':[],'errors':[],'year':year,'source_url':SERVICE_URL,
            'spatial_support':'point_samples_not_polygon_fractions','ttl_seconds':TTL_SECONDS}
    if not centers: return result
    use_point_cache = cache is None
    if cache is None:
        from .sources import CACHE, CACHE_DIR, atomic_json
        cache=CACHE
    if use_point_cache and not refresh:
        now = time.time()
        with _POINT_CACHE_LOCK:
            year_cache = _POINT_CACHE_BY_YEAR.get(year)
            if year_cache is None:
                path = CACHE_DIR / f'cdl-points-{year}.json'
                if path.exists():
                    try: year_cache = json.loads(path.read_text(encoding='utf-8'))
                    except (OSError, ValueError): year_cache = {}
                else:
                    year_cache = {}
                _POINT_CACHE_BY_YEAR[year] = year_cache
            remaining = []
            seen_meta_ids = set()
            for p in centers:
                pkey = f"{p['lon']:.5f},{p['lat']:.5f}"
                entry = year_cache.get(pkey)
                if entry and (now - entry.get('epoch', 0)) < TTL_SECONDS:
                    result['by_id'][p['id']] = entry['value']
                    m = entry.get('meta')
                    if m and m.get('id') not in seen_meta_ids:
                        seen_meta_ids.add(m.get('id'))
                        result['meta'].append(m)
                else:
                    remaining.append(p)
        if not remaining:
            return result
    else:
        remaining = centers
    try:
        catalog,meta=cache.fetch(SOURCE_ID,_url('query',where=f'Year={year}',outFields='OBJECTID,Name,Year',returnGeometry='false'),ttl=TTL_SECONDS,refresh=refresh)
        result['meta'].append(meta)
        if catalog.get('error'): raise ValueError('USDA CDL catalog returned an error')
        raster_ids=[]
        for feature in catalog.get('features',[]):
            attrs=feature.get('attributes',{})
            if _number(attrs.get('Year'))==year and _number(attrs.get('OBJECTID')) is not None:
                raster_ids.append(int(attrs['OBJECTID']))
        if not raster_ids:
            result['by_id']={p['id']:_unknown(year,'year_not_available',p['lon'],p['lat']) for p in centers}
            return result
        legend_response,meta=cache.fetch(SOURCE_ID,_url('rasterAttributeTable'),ttl=TTL_SECONDS,refresh=refresh)
        result['meta'].append(meta)
        legend=_legend(legend_response)
        if not legend: raise ValueError('USDA CDL legend is missing')
    except Exception as exc:
        for p in remaining:
            result['by_id'][p['id']]=_unknown(year,'source_unavailable',p['lon'],p['lat'])
        result['errors'].append(f'USDA CDL unavailable: {type(exc).__name__}: {str(exc)[:200]}')
        return result

    def batch(points):
        url=_url('getSamples',
                 geometry=json.dumps({'points':[[p['lon'],p['lat']] for p in points],'spatialReference':{'wkid':4326}},separators=(',',':')),
                 geometryType='esriGeometryMultipoint',
                 mosaicRule=json.dumps({'mosaicMethod':'esriMosaicLockRaster','lockRasterIds':raster_ids,'where':f'Year={year}','mosaicOperation':'MT_FIRST'},separators=(',',':')),
                 returnFirstValueOnly='true',outFields='Year,Name')
        try:
            response,meta=cache.fetch(SOURCE_ID,url,ttl=TTL_SECONDS,refresh=refresh)
            if response.get('error'): raise ValueError('USDA CDL sample query returned an error')
            values=_interpret_samples(response,points,year,legend,url)
            return values,meta,None
        except Exception as exc:
            return {p['id']:_unknown(year,'source_unavailable',p['lon'],p['lat']) for p in points},None,f'USDA CDL samples unavailable: {type(exc).__name__}: {str(exc)[:200]}'

    chunks=[remaining[index:index+BATCH_SIZE] for index in range(0,len(remaining),BATCH_SIZE)]
    newly_cached = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for values,meta,error in pool.map(batch,chunks):
            result['by_id'].update(values)
            if meta:
                result['meta'].append(meta)
                if use_point_cache:
                    for pid, val in values.items():
                        if val.get('allow_analysis') is not None or val.get('reason') == 'unknown_code':
                            newly_cached.append((val.get('sample_lon'), val.get('sample_lat'), val, meta))
            if error: result['errors'].append(error)
    if use_point_cache and newly_cached:
        now = time.time()
        with _POINT_CACHE_LOCK:
            year_cache = _POINT_CACHE_BY_YEAR.setdefault(year, {})
            for lon, lat, val, meta in newly_cached:
                if lon is not None and lat is not None:
                    year_cache[f'{lon:.5f},{lat:.5f}'] = {'epoch': now, 'value': val, 'meta': meta}
            from .sources import CACHE_DIR, atomic_json
            atomic_json(CACHE_DIR / f'cdl-points-{year}.json', year_cache)
    return result
