"""Viewport queries: center-sampled overview grid -> native soil polygons."""
import concurrent.futures
import datetime as dt
import math
import threading
from .analysis import PROFILES,WEIGHTS,METHOD_VERSION,climate_metrics,evaluate,number
from .sources import CACHE_DIR,utcnow,power_point
from . import soil,landcover

COVERAGE=[-102.1,36.9,-94.5,40.1]  # Kansas pilot bounding extent; no invented data outside.
NATIVE_RESOLUTION='NASA POWER: meteorology ~0.5° × 0.625°, solar radiation ~1°; USDA: soil survey mapping units.'
REFRESH_POLICY='Checked every 5 minutes in an open tab; sources refreshed after 24 hours or manually, with at least 60 seconds between identical requests.'
_request_slots=threading.Semaphore(3)

def clip_bbox(bbox):
    if len(bbox)!=4 or any(number(v) is None for v in bbox): raise ValueError('Invalid bbox')
    west,south,east,north=map(float,bbox)
    if not (-180<=west<east<=180 and -85<=south<north<=85): raise ValueError('Invalid WGS84 bbox')
    out=[max(west,COVERAGE[0]),max(south,COVERAGE[1]),min(east,COVERAGE[2]),min(north,COVERAGE[3])]
    return out if out[0]<out[2] and out[1]<out[3] else None

def grid(bbox,zoom):
    dx,dy=(2.5,2) if zoom<=6 else (1.25,1) if zoom<=8 else (.625,.5)
    west,south,east,north=bbox;features=[]
    for row in range(math.floor(south/dy),math.ceil(north/dy)):
        for col in range(math.floor(west/dx),math.ceil(east/dx)):
            left,bottom,right,top=max(col*dx,COVERAGE[0]),max(row*dy,COVERAGE[1]),min((col+1)*dx,COVERAGE[2]),min((row+1)*dy,COVERAGE[3])
            if left>=right or bottom>=top: continue
            features.append({'id':f'grid-{dx}-{col}-{row}','center':[(left+right)/2,(bottom+top)/2],
                'geometry':{'type':'Polygon','coordinates':[[[left,bottom],[right,bottom],[right,top],[left,top],[left,bottom]]]}})
    return features, f'{dy}° × {dx}° · center and 4 internal samples, not a continuous raster'

def _grid_sample_points(feature):
    ring=feature['geometry']['coordinates'][0]
    lons=[p[0] for p in ring];lats=[p[1] for p in ring]
    left,right,bottom,top=min(lons),max(lons),min(lats),max(lats)
    fid=feature['id']
    offsets=[(0.5,0.5),(0.25,0.25),(0.75,0.25),(0.25,0.75),(0.75,0.75)]
    return [{'id':f'{fid}__s{i}','parent_id':fid,'center':[round(left+(right-left)*fx,6),round(bottom+(top-bottom)*fy,6)]} for i,(fx,fy) in enumerate(offsets)]

def _avg_nums(values, digits=2):
    valid=[v for v in values if v is not None]
    return round(sum(valid)/len(valid),digits) if valid else None

def _aggregate_grid_cell(feature, points, soil_samples, cover_by_id, power, crop, irrigation_mm, irrigation_known):
    sub_results=[];sub_soils=[];sub_covers=[];sub_climates=[];cover_urls=[]
    counts={'good':0,'conditional':0,'poor':0,'excluded':0,'unknown':0}
    missing_union=[]
    for pt in points:
        pid=pt['id']
        s=soil_samples.get(pid)
        c=cover_by_id.get(pid)
        clim,_=power.get(power_key(pt['center']),(None,None))
        res=apply_landcover(evaluate(clim,s,crop,irrigation_mm,irrigation_known),c)
        counts[res['status']]=counts.get(res['status'],0)+1
        for m in res.get('missing',[]):
            if m not in missing_union: missing_union.append(m)
        sub_soils.append(s);sub_covers.append(c);sub_climates.append(clim);sub_results.append(res)
        if c and c.get('source_url'): cover_urls.append(c['source_url'])
    scored=[r for r in sub_results if r.get('score') is not None]
    ag_soils=[s for s,r in zip(sub_soils,sub_results) if s and r.get('status')!='excluded'] or [s for s in sub_soils if s]
    agg_soil=None
    if ag_soils:
        base=dict(ag_soils[0])
        for k,d in [('ph',2),('awc',3),('slope',1),('clay',1),('sand',1),('organic_matter',2),('depth_coverage_cm',1)]:
            base[k]=_avg_nums([s.get(k) for s in ag_soils],d)
        base['representation']='5_point_cell_average_0_30cm'
        agg_soil=base
    valid_covers=[c for c in sub_covers if c]
    cropland_cover=next((c for c in valid_covers if c.get('allow_analysis') is True),valid_covers[0] if valid_covers else None)
    clim=next((c for c in sub_climates if c and c.get('complete')),sub_climates[0] if sub_climates else None)
    uncertainty={'sample_count':len(points),'scored_samples':len(scored),'excluded_samples':counts['excluded'],
        'unknown_samples':counts['unknown'],'ag_share':round(sum(c.get('allow_analysis') is True for c in sub_covers if c)/len(points),2),'counts':counts}
    # A valid subset cannot conceal critical gaps in the remaining samples.
    # Excluded land cover is a known class, whereas unknown is missing evidence.
    if counts['unknown'] > 0 or not scored:
        if counts['excluded']>0 and counts['unknown']==0:
            result={'score':None,'status':'excluded','missing':[],'exclusion':'landcover_not_agricultural','landcover_gate':'sample_excluded','uncertainty':uncertainty}
        else:
            result={'score':None,'status':'unknown','factors':{},'missing':missing_union or ['unknown'],'method':METHOD_VERSION,'uncertainty':uncertainty}
        return agg_soil,clim,cropland_cover,result,cover_urls
    scores=[r['score'] for r in scored]
    mean_score=round(sum(scores)/len(scores),1)
    factors={}
    for key in WEIGHTS:
        vals=[r['factors'].get(key) for r in scored if (r.get('factors') or {}).get(key) is not None]
        if vals: factors[key]=round(sum(vals)/len(vals),3)
    limiting=min(factors,key=factors.get) if factors else scored[0].get('limiting_factor')
    wbs=[r['water_balance'] for r in scored if r.get('water_balance')]
    wb={'effective_rain_mm':_avg_nums([w['effective_rain_mm'] for w in wbs],1),'irrigation_mm':_avg_nums([w['irrigation_mm'] for w in wbs],1),'demand_mm':_avg_nums([w['demand_mm'] for w in wbs],1)} if wbs else None
    uncertainty['score_range']=[round(min(scores),1),round(max(scores),1)]
    uncertainty['score_spread']=round(max(scores)-min(scores),1)
    result={'score':mean_score,'status':'good' if mean_score>=70 else 'conditional' if mean_score>=40 else 'poor',
        'factors':factors,'limiting_factor':limiting,'water_balance':wb,'missing':[],'method':METHOD_VERSION,
        'irrigation_assumption':scored[0].get('irrigation_assumption'),'uncertainty':uncertainty}
    return agg_soil,clim,cropland_cover,result,cover_urls

def power_key(center):
    lon,lat=center
    return (round((math.floor(lon/.625)+.5)*.625,4),round((math.floor(lat/.5)+.5)*.5,4))

def public_meta(meta):
    return {key:meta.get(key) for key in ['id','source_id','source_url','retrieved_at','upstream_modified','sha256','cache_status','age_seconds','ttl_seconds','kind']}

def apply_landcover(result,cover):
    """Eligibility at the sampled pixel; never pretend this clips the whole polygon."""
    allowed=(cover or {}).get('allow_analysis')
    if allowed is True: return result
    if allowed is False:
        return {**result,'score':None,'status':'excluded','missing':[],'exclusion':'landcover_not_agricultural','landcover_gate':'sample_excluded'}
    return {**result,'score':None,'status':'unknown','missing':list(dict.fromkeys(result.get('missing',[])+['landcover'])),'landcover_gate':'sample_missing'}

def analyze(bbox,zoom,crop,year,planting,irrigation_mm=0,irrigation_known=True,refresh=False):
    if crop not in PROFILES: raise ValueError('Unsupported crop')
    year=int(year)
    current=dt.datetime.now(dt.timezone.utc).year
    if not 1984<=year<=current: raise ValueError('Year is outside the available historical window')
    start=dt.date.fromisoformat(planting)
    if start.year!=year: raise ValueError('Planting date must belong to the selected year')
    if (start+dt.timedelta(days=sum(PROFILES[crop]['stages'])-1)).year!=year: raise ValueError('This version supports seasons within one calendar year')
    irrigation_mm=number(irrigation_mm,0,5000)
    if irrigation_mm is None: raise ValueError('Invalid irrigation amount')
    zoom=number(zoom,0,20)
    if zoom is None: raise ValueError('Invalid zoom')
    bounds=clip_bbox(bbox)
    meta={'query':{'bbox':bbox,'zoom':zoom,'crop':crop,'year':year,'planting':planting,'irrigation_mm':irrigation_mm,'irrigation_known':irrigation_known},
        'mode':'soil_polygons' if zoom>=12 else 'grid','resolution':None,'coverage_bbox':COVERAGE,'updated_at':None,'completed_at':utcnow(),
        'errors':[],'truncated':False,'method':METHOD_VERSION,'weights':WEIGHTS,'native_resolution':NATIVE_RESOLUTION,'cache_ttl_hours':24,'refresh_policy':REFRESH_POLICY,
        'caveat':'Experimental index without field calibration. Smaller soil polygons do not improve climate resolution.'}
    if bounds is None or zoom<5:
        meta['resolution']='Zoom to Kansas, USA, to calculate suitability.' if zoom<5 else 'No data outside the available coverage.'
        return {'type':'FeatureCollection','features':[],'meta':meta}
    with _request_slots:
        source_meta=[];soil_meta=None
        grid_points_map={}
        if zoom>=12:
            # Do not claim a complete native polygon layer if a request is too broad.
            if (bounds[2]-bounds[0])*(bounds[3]-bounds[1])>.16:
                meta['truncated']=True;meta['resolution']='Zoom in further: detailed soil polygons require a smaller area.'
                return {'type':'FeatureCollection','features':[],'meta':meta}
            try:
                features,soil_meta,truncated=soil.polygons(bounds,refresh)
                source_meta.append(soil_meta);meta['truncated']=truncated
            except Exception as exc:
                meta['errors'].append({'source':'USDA SSURGO','message':str(exc)[:280]});features=[]
            meta['resolution']='Actual USDA soil survey polygons, not property boundaries. Climate data remains coarse.'
            sample_inputs=features
            cover_inputs=[{'id':f['id'],'lon':f['center'][0],'lat':f['center'][1]} for f in features]
        else:
            features,meta['resolution']=grid(bounds,zoom)
            if len(features)>48:
                features=features[:48];meta['truncated']=True
            all_grid_pts=[]
            for feature in features:
                pts=_grid_sample_points(feature)
                grid_points_map[feature['id']]=pts
                all_grid_pts.extend(pts)
            try:
                soil_samples,soil_meta=soil.points(all_grid_pts,refresh)
                if soil_meta: source_meta.append(soil_meta)
            except Exception as exc:
                soil_samples={};meta['errors'].append({'source':'USDA SSURGO','message':str(exc)[:280]})
            sample_inputs=all_grid_pts
            cover_inputs=[{'id':pt['id'],'lon':pt['center'][0],'lat':pt['center'][1]} for pt in all_grid_pts]
        cover=landcover.classify_points(cover_inputs,year,refresh=refresh)
        source_meta.extend(cover.get('meta',[]))
        if cover.get('errors'): meta['errors'].append({'source':'USDA CDL','message':'; '.join(cover['errors'])[:600]})
        cover_by_id=cover.get('by_id',{})
        # One source request per native climate support cell/year, reused across polygons & sub-samples.
        keys={power_key(pt['center']) for pt in sample_inputs if (cover_by_id.get(pt['id']) or {}).get('allow_analysis') is not False}
        power={};errors=[]
        def fetch(key):
            try:
                raw,provenance=power_point(*key,year,refresh)
                return key,climate_metrics(raw,crop,planting),provenance,None
            except Exception as exc: return key,None,None,str(exc)[:250]
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            for key,climate,provenance,error in pool.map(fetch,keys):
                power[key]=(climate,provenance)
                if error: errors.append(error)
                if provenance: source_meta.append(provenance)
        if errors: meta['errors'].append({'source':'NASA POWER','message':'; '.join(dict.fromkeys(errors))[:600]})
        output=[]
        for feature in features:
            if zoom>=12:
                lc=cover_by_id.get(feature['id'])
                climate,provenance=power.get(power_key(feature['center']),(None,None))
                result=apply_landcover(evaluate(climate,feature.get('soil'),crop,irrigation_mm,irrigation_known),lc)
                feat_soil=feature.get('soil')
                cover_meta=next((m for m in cover.get('meta',[]) if m.get('source_url')==(lc or {}).get('source_url')),None)
            else:
                pts=grid_points_map[feature['id']]
                feat_soil,climate,lc,result,cover_urls=_aggregate_grid_cell(feature,pts,soil_samples,cover_by_id,power,crop,irrigation_mm,irrigation_known)
                _,provenance=power.get(power_key(feature['center']),(None,None))
                cover_meta=next((m for m in cover.get('meta',[]) if m.get('source_url') in cover_urls),None)
            output.append({'type':'Feature','id':feature['id'],'geometry':feature['geometry'],'properties':{
                'id':feature['id'],'center':feature['center'],'soil':feat_soil,'climate':climate,'landcover':lc,'result':result,
                'representation':'soil_mapping_unit_dominant_component' if zoom>=12 else 'multi_point_overview_5pt',
                'source_meta':[public_meta(m) for m in [soil_meta,provenance,cover_meta] if m]}})
        dates=[m['retrieved_at'] for m in source_meta if m]
        meta['updated_at']=max(dates) if dates else None
        meta['feature_count']=len(output);meta['scored_count']=sum(f['properties']['result']['score'] is not None for f in output)
        meta['excluded_count']=sum(f['properties']['result']['status']=='excluded' for f in output)
        meta['source_download_count']=len({m['id'] for m in source_meta if m});meta['completed_at']=utcnow()
        return {'type':'FeatureCollection','features':output,'meta':meta}

def source_status():
    import csv,json
    from .sources import ROOT
    statuses=[];dates={}
    if CACHE_DIR.exists():
        for path in CACHE_DIR.glob('*.json'):
            try:
                meta=json.loads(path.read_text(encoding='utf-8'))['meta'];sid=meta['source_id']
                dates[sid]=max(dates.get(sid,''),meta['retrieved_at'])
            except (OSError,ValueError,KeyError): pass
    connected={'nasa-power':'Weather, rainfall, FAO-56 ET0; surface (0–5 cm) and root-zone (0–100 cm) wetness','ssurgo-statsgo2':'Soil, 0–30 cm, and USDA soil survey polygons','usda-cdl':'Land cover at the sample point for the exact year; product resolution depends on year','usda-ers-costs':'Regional costs and historical harvest prices; not current demand','smap':'SMAP L4 root-zone moisture overlay (NASA GIBS WMTS, ~9 km)','landsat-modis-viirs':'MODIS Terra NDVI 8-Day overlay (NASA GIBS WMTS, 250–500 m)'}
    urls={'nasa-power':'https://power.larc.nasa.gov/docs/services/api/temporal/daily/','ssurgo-statsgo2':'https://sdmdataaccess.nrcs.usda.gov/WebServiceHelp.aspx','usda-cdl':landcover.SERVICE_URL,'usda-ers-costs':'https://www.ers.usda.gov/data-products/commodity-costs-and-returns'}
    connected['usda-cdl']='Land cover at the point for the exact year; native product resolution (2025: 10 m)'
    connected['noaa-nws']='Short-range hourly point forecast; air, not soil temperature; separate from the historical index'
    urls['noaa-nws']='https://www.weather.gov/documentation/services-web-api'
    for filename in ['sources.csv','additional-sources.csv']:
        path=ROOT/'data/catalog'/filename
        if not path.exists(): continue
        with path.open(encoding='utf-8',newline='') as stream:
            for row in csv.DictReader(stream):
                sid=row['id'];statuses.append({'id':sid,'name':row['name'],'status':'connected' if sid in connected else row.get('status','not_connected') if sid in {'kstate-extension','kansas-mesonet'} else 'not_connected','role':connected.get(sid,row.get('role','Not connected to the current method; values are not fabricated.')),'updated_at':dates.get(sid),'source_url':urls.get(sid,row.get('source_url'))})
    return {'sources':statuses,'refresh_policy':REFRESH_POLICY,'method':METHOD_VERSION,'weights':WEIGHTS,'native_resolution':NATIVE_RESOLUTION}
