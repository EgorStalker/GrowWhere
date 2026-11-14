"""USDA SDA point sampling and real SSURGO polygon geometries, EPSG:4326."""
import concurrent.futures
import json
import re
import threading
import time
from .sources import CACHE,CACHE_DIR,UpstreamError,atomic_json
from .analysis import number

URL='https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest'
POINT_BATCH_SIZE=40
_POINT_CACHE_LOCK=threading.Lock()
_POINT_CACHE=None
_POINT_CACHE_FILE=CACHE_DIR/'ssurgo-points.json'
_POLYGON_CACHE=[]
_POLYGON_CACHE_LOCK=threading.Lock()

def _load_point_cache():
    global _POINT_CACHE
    if _POINT_CACHE is not None: return _POINT_CACHE
    if _POINT_CACHE_FILE.exists():
        try: _POINT_CACHE=json.loads(_POINT_CACHE_FILE.read_text(encoding='utf-8'))
        except (OSError,ValueError): _POINT_CACHE={}
    else: _POINT_CACHE={}
    return _POINT_CACHE
ATTRIBUTES='c.compname,c.comppct_r,c.drainagecl,c.slope_r,h.ph,h.awc,h.clay,h.sand,h.om,h.depth_ph,h.depth_awc,h.depth_clay,h.depth_sand'
HORIZON="""OUTER APPLY (
SELECT SUM(ph1to1h2o_r * thickness)/NULLIF(SUM(CASE WHEN ph1to1h2o_r IS NOT NULL THEN thickness END),0) ph,
SUM(awc_r * thickness)/NULLIF(SUM(CASE WHEN awc_r IS NOT NULL THEN thickness END),0) awc,
SUM(claytotal_r * thickness)/NULLIF(SUM(CASE WHEN claytotal_r IS NOT NULL THEN thickness END),0) clay,
SUM(sandtotal_r * thickness)/NULLIF(SUM(CASE WHEN sandtotal_r IS NOT NULL THEN thickness END),0) sand,
SUM(om_r * thickness)/NULLIF(SUM(CASE WHEN om_r IS NOT NULL THEN thickness END),0) om,
SUM(CASE WHEN ph1to1h2o_r IS NOT NULL THEN thickness END) depth_ph,
SUM(CASE WHEN awc_r IS NOT NULL THEN thickness END) depth_awc,
SUM(CASE WHEN claytotal_r IS NOT NULL THEN thickness END) depth_clay,
SUM(CASE WHEN sandtotal_r IS NOT NULL THEN thickness END) depth_sand
FROM (SELECT ph1to1h2o_r,awc_r,claytotal_r,sandtotal_r,om_r,
(CASE WHEN hzdepb_r>30 THEN 30 ELSE hzdepb_r END)-(CASE WHEN hzdept_r<0 THEN 0 ELSE hzdept_r END) thickness
FROM chorizon WHERE cokey=c.cokey AND hzdept_r<30 AND hzdepb_r>0) z
) h"""

def table_rows(data):
    if not isinstance(data,dict) or 'Table' not in data: raise UpstreamError('USDA SDA did not return a result table: '+str(data)[:200])
    table=data.get('Table',[])
    if not table: return []
    return [dict(zip(table[0],row)) for row in table[1:]]

def normalize(row):
    if not row or not row.get('mukey'): return None
    coverage=[number(row.get(key),0,100) for key in ['depth_ph','depth_awc','depth_clay','depth_sand']]
    return {'mukey':str(row['mukey']),'muname':row.get('muname'),'soil_name':row.get('muname'),'component':row.get('compname'),
        'component_percent':number(row.get('comppct_r'),0,100),'drainage':row.get('drainagecl'),'slope':number(row.get('slope_r'),0,100),
        'ph':number(row.get('ph'),0,14),'awc':number(row.get('awc'),0,.8),'clay':number(row.get('clay'),0,100),'sand':number(row.get('sand'),0,100),'organic_matter':number(row.get('om'),0,100),
        'depth_coverage_cm':min(coverage) if all(value is not None for value in coverage) else None,
        'depth_interval_cm':[0,30], 'representation':'dominant_component_depth_weighted_0_30cm'}

def points(samples,refresh=False):
    if not samples: return {},None
    now=time.time()
    out={};missing=[];last_meta=None
    with _POINT_CACHE_LOCK:
        cache_data=_load_point_cache()
        for sample in samples:
            lon,lat=sample['center'];sid=re.sub('[^a-zA-Z0-9_.-]','',sample['id'])
            pkey=f'{lon:.5f},{lat:.5f}'
            entry=None if refresh else cache_data.get(pkey)
            if entry and (now-entry.get('epoch',0))<86400:
                out[sid]=entry.get('soil')
                if not last_meta: last_meta=entry.get('meta')
            else:
                missing.append((sample,sid,pkey))
    if not missing:
        return out,last_meta
    def fetch_batch(batch):
        statements=[]
        for sample,sid,_ in batch:
            lon,lat=sample['center']
            wkt=f'POINT({lon:.6f} {lat:.6f})'
            statements.append(f"""SELECT '{sid}' sample,c.mukey,c.muname,{ATTRIBUTES}
FROM (SELECT TOP 1 m.mukey,m.muname,c.* FROM mapunit m JOIN component c ON c.mukey=m.mukey
WHERE m.mukey IN (SELECT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('{wkt}'))
ORDER BY c.comppct_r DESC,c.cokey) c {HORIZON}""")
        # c.* already contains mukey; avoid duplicate named columns in SQL subquery.
        query=' UNION ALL '.join(statements).replace('SELECT TOP 1 m.mukey,m.muname,c.*','SELECT TOP 1 m.muname,c.*')
        raw,meta=CACHE.fetch('ssurgo-statsgo2',URL,{'query':query,'format':'JSON+COLUMNNAME'},ttl=86400,refresh=refresh,kind='model_estimate')
        if not isinstance(raw,dict): raise UpstreamError('SDA did not return a JSON table')
        return {row['sample']:normalize(row) for row in table_rows(raw)},meta
    batches=[missing[i:i+POINT_BATCH_SIZE] for i in range(0,len(missing),POINT_BATCH_SIZE)]
    fetched={};meta=last_meta
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for part,batch_meta in pool.map(fetch_batch,batches):
            fetched.update(part);meta=batch_meta or meta
    with _POINT_CACHE_LOCK:
        cache_data=_load_point_cache()
        for _,sid,pkey in missing:
            soil_val=fetched.get(sid)
            out[sid]=soil_val
            if soil_val is not None:
                cache_data[pkey]={'epoch':now,'soil':soil_val,'meta':meta}
        atomic_json(_POINT_CACHE_FILE,cache_data)
    return out,meta

def wkt_geometry(wkt):
    """Parse only numeric POLYGON/MULTIPOLYGON WKT; never evaluate source text."""
    if not isinstance(wkt,str): return None
    match=re.match(r'^(MULTIPOLYGON|POLYGON)\s*\(',wkt)
    if not match: return None
    text=wkt[match.end()-1:]
    pattern=r'[()]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?|,'
    if re.sub(pattern,'',text).strip(): return None
    tokens=re.findall(pattern,text)
    index=0
    def group():
        nonlocal index
        if tokens[index]!='(': raise ValueError('WKT group expected')
        index+=1;items=[]
        while index<len(tokens) and tokens[index]!=')':
            if tokens[index]=='(': items.append(group())
            elif tokens[index]==',': index+=1
            else:
                lon=float(tokens[index]);lat=float(tokens[index+1]);index+=2
                if not (-180<=lon<=180 and -90<=lat<=90): raise ValueError('Invalid WGS84 coordinate')
                items.append([lon,lat])
        if index>=len(tokens): raise ValueError('Unclosed WKT')
        index+=1;return items
    try:
        coordinates=group()
        if index!=len(tokens): return None
        polygons=[coordinates] if match.group(1)=='POLYGON' else coordinates
        if not polygons: return None
        for polygon in polygons:
            if not polygon: return None
            for ring in polygon:
                if not isinstance(ring,list) or len(ring)<4 or ring[0]!=ring[-1]: return None
                if any(not isinstance(point,list) or len(point)!=2 or any(not isinstance(v,(int,float)) for v in point) for point in ring): return None
                if len({tuple(point) for point in ring})<3: return None
        return {'type':match.group(1).title().replace('Multipolygon','MultiPolygon'),'coordinates':coordinates}
    except (ValueError,IndexError): return None

def _geom_intersects_bbox(geometry,bbox):
    west,south,east,north=bbox
    polys=geometry['coordinates'] if geometry['type']=='MultiPolygon' else [geometry['coordinates']]
    g_west,g_south,g_east,g_north=180.0,90.0,-180.0,-90.0
    for poly in polys:
        for ring in poly:
            for lon,lat in ring:
                if lon<g_west: g_west=lon
                if lon>g_east: g_east=lon
                if lat<g_south: g_south=lat
                if lat>g_north: g_north=lat
    return not (g_east<west or g_west>east or g_north<south or g_south>north)

def polygons(bbox,refresh=False,limit=400):
    west,south,east,north=bbox
    now=time.time()
    if not refresh:
        with _POLYGON_CACHE_LOCK:
            for entry in reversed(_POLYGON_CACHE):
                ew,es,ee,en=entry['bbox']
                if now-entry['ts']<86400 and entry['limit']>=limit and not entry['truncated'] and ew<=west and es<=south and ee>=east and en>=north:
                    subset=[f for f in entry['features'] if _geom_intersects_bbox(f['geometry'],bbox)][:limit]
                    meta=dict(entry['meta']); meta['cached']=True; meta['spatial_cache']=True
                    return subset,meta,False
    wkt=f'POLYGON(({west} {south},{east} {south},{east} {north},{west} {north},{west} {south}))'
    query=f"""SELECT TOP {limit+1} p.mupolygonkey,p.mukey,m.muname,{ATTRIBUTES},
p.mupolygongeo.STIntersection(geometry::STGeomFromText('{wkt}',4326)).Reduce(0.00001).STAsText() wkt,
p.mupolygongeo.STIntersection(geometry::STGeomFromText('{wkt}',4326)).STPointOnSurface().STX lon,
p.mupolygongeo.STIntersection(geometry::STGeomFromText('{wkt}',4326)).STPointOnSurface().STY lat
FROM mupolygon p JOIN mapunit m ON m.mukey=p.mukey
OUTER APPLY (SELECT TOP 1 * FROM component WHERE mukey=p.mukey ORDER BY comppct_r DESC,cokey) c
{HORIZON}
WHERE p.mupolygonkey IN (SELECT mupolygonkey FROM SDA_Get_Mupolygonkey_from_intersection_with_WktWgs84('{wkt}'))
ORDER BY p.mupolygonkey"""
    raw,meta=CACHE.fetch('ssurgo-statsgo2',URL,{'query':query,'format':'JSON+COLUMNNAME'},ttl=86400,refresh=refresh,kind='model_estimate')
    rows=table_rows(raw);truncated=len(rows)>limit;features=[]
    for row in rows[:limit]:
        geom=wkt_geometry(row.get('wkt'))
        lon=number(row.get('lon'),-180,180);lat=number(row.get('lat'),-90,90)
        if not geom or lon is None or lat is None: continue
        features.append({'id':'soil-'+row['mupolygonkey'],'geometry':geom,'center':[lon,lat],'soil':normalize(row)})
    if not truncated:
        with _POLYGON_CACHE_LOCK:
            _POLYGON_CACHE.append({'bbox':list(bbox),'limit':limit,'truncated':truncated,'features':features,'meta':dict(meta),'ts':now})
            if len(_POLYGON_CACHE)>32: del _POLYGON_CACHE[:len(_POLYGON_CACHE)-32]
    return features,meta,truncated
