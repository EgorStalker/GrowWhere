"""Public-source requests, immutable raw downloads, TTL cache and provenance."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import urllib.error
import urllib.request

ROOT=Path(__file__).resolve().parents[3]
RAW=ROOT/'data/raw/live'
CACHE_DIR=ROOT/'data/processed/live-cache'
CATALOG=ROOT/'data/catalog/datasets.json'

def utcnow(): return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')

def atomic_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_name(path.name+f'.{threading.get_ident()}.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    os.replace(temporary,path)

class UpstreamError(Exception): pass

class SourceCache:
    def __init__(self):
        self._locks={};self._guard=threading.Lock();self._catalog_lock=threading.Lock()
        self._power_slots=threading.Semaphore(3)
        self._memory={}

    def fetch(self,source_id,url,body=None,ttl=86400,refresh=False,kind='model_estimate',format='json',timeout=45):
        canonical=json.dumps({'url':url,'body':body},sort_keys=True,separators=(',',':'))
        key=hashlib.sha256(canonical.encode()).hexdigest()[:24]
        with self._guard: lock=self._locks.setdefault(key,threading.Lock())
        with lock:
            mem=self._memory.get(key)
            if mem:
                mem_age=time.time()-mem['epoch']
                if mem_age<(60 if refresh else ttl):
                    return mem['value'],{**mem['meta'],'cache_status':'cached','age_seconds':round(mem_age)}
            index=CACHE_DIR/f'{key}.json';cached=None
            if index.exists():
                try: cached=json.loads(index.read_text(encoding='utf-8'))
                except (OSError,ValueError): cached=None
            age=time.time()-cached['epoch'] if cached else float('inf')
            # Explicit refresh still has a 60s floor to respect upstream services.
            if cached and age<(60 if refresh else ttl):
                target=ROOT/cached['meta']['path']
                if target.is_file():
                    raw=target.read_bytes()
                    value=json.loads(raw) if format=='json' else raw.decode('utf-8-sig')
                    self._remember(key,cached['epoch'],value,cached['meta'])
                    return value,{**cached['meta'],'cache_status':'cached','age_seconds':round(age)}
            request=urllib.request.Request(url,data=json.dumps(body).encode() if body is not None else None,
                headers={'User-Agent':'GrowWhere/0.2 (public agricultural research prototype)','Accept':'application/json,text/csv,text/html;q=0.8','Content-Type':'application/json'})
            slot=self._power_slots if source_id=='nasa-power' else threading.Semaphore(100)
            try:
                with slot:
                    with urllib.request.urlopen(request,timeout=timeout) as response:
                        raw=response.read(24_000_001)
                        upstream_modified=response.headers.get('Last-Modified')
                if len(raw)>24_000_000: raise UpstreamError('Source response exceeds safe request size')
                value=json.loads(raw) if format=='json' else raw.decode('utf-8-sig')
                if format=='json' and isinstance(value,dict) and value.get('messages') and not value.get('properties') and not value.get('Table'):
                    raise UpstreamError(str(value['messages'])[:250])
                if format=='json' and source_id=='ssurgo-statsgo2' and (not isinstance(value,dict) or 'Table' not in value):
                    raise UpstreamError('USDA SDA did not return a result table')
            except (urllib.error.URLError,TimeoutError,ValueError,OSError) as exc:
                raise UpstreamError(f'{source_id}: {str(exc)[:220]}') from exc
            timestamp=utcnow();stamp=timestamp.replace(':','').replace('+','_')
            extension='json' if format=='json' else 'txt'
            digest=hashlib.sha256(raw).hexdigest()
            target=RAW/source_id/f'{key}-{stamp}-{digest[:12]}.{extension}'
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
            meta={'id':f'{source_id}-{key}','source_id':source_id,'source_url':url,'retrieved_at':timestamp,'upstream_modified':upstream_modified,
                'sha256':digest,'path':target.relative_to(ROOT).as_posix(),'cache_status':'fetched','age_seconds':0,'ttl_seconds':ttl,
                'request':{'url':url,'body':body},'kind':kind}
            now_epoch=time.time()
            atomic_json(index,{'epoch':now_epoch,'meta':meta})
            self._remember(key,now_epoch,value,meta)
            self.register(meta,value)
            return value,meta

    def _remember(self,key,epoch,value,meta):
        if len(self._memory)>=256:
            oldest=next(iter(self._memory))
            self._memory.pop(oldest,None)
        self._memory[key]={'epoch':epoch,'value':value,'meta':meta}

    def register(self,meta,value):
        source=meta['source_id']
        is_power=source=='nasa-power'
        variables=[]
        if is_power and isinstance(value,dict):
            variables=[{'name':key,'definition':item.get('longname'),'unit':item.get('units'),'nodata':value.get('header',{}).get('fill_value',-999)} for key,item in value.get('parameters',{}).items()]
        elif source=='ssurgo-statsgo2':
            variables=[{'name':name,'definition':definition,'unit':unit,'nodata':None} for name,definition,unit in [('ph','Depth-weighted pH of dominant component, 0–30 cm','pH'),('awc','Available water capacity, 0–30 cm','cm/cm'),('sand','Sand content','%'),('clay','Clay content','%'),('slope_r','Representative slope','%'),('drainagecl','Drainage class','categorical')]]
        elif source=='usda-cdl':
            variables=[{'name':'value','definition':'USDA CDL classification code; consult fetched official legend','unit':'categorical','nodata':[0,81,255]}]
        elif source=='usda-ers-costs':
            variables=[{'name':'Value','definition':'Per-record economic estimate; exact Year, Region, Item and Units must be selected together','unit':'See each CSV row Units; not uniform across the file','nodata':None}]
        entry={'id':meta['id'],'title':{'nasa-power':'NASA POWER daily point response','ssurgo-statsgo2':'USDA SDA SSURGO query response','usda-cdl':'USDA Cropland Data Layer point samples/catalog/legend','usda-ers-costs':'USDA ERS costs and returns source'}.get(source,source),
            'source_ids':[source],'kind':meta['kind'],'is_demo':False,'layer':'raw','path':meta['path'],'local_available':True,
            'product':value.get('header',{}).get('title') if is_power else source,'version':value.get('header',{}).get('api',{}).get('version') if is_power else None,
            'source_url':meta['source_url'],'retrieved_at':meta['retrieved_at'],'verified_at':meta['retrieved_at'],
            'license':None,'license_url':None,'redistribution_allowed':None,'citation':{'nasa-power':'NASA POWER Project, NASA Langley Research Center','ssurgo-statsgo2':'USDA NRCS Soil Data Access / SSURGO','usda-cdl':'USDA NASS Cropland Data Layer / CroplandCROS','usda-ers-costs':'USDA Economic Research Service, Commodity Costs and Returns'}.get(source,source),
            'spatial':{'crs':'EPSG:4326' if source!='usda-ers-costs' else None,'coverage':'Request-specific; see request parameters','resolution':'Meteorology native ~0.5° × 0.625°; solar ~1° (not field measurements)' if is_power else 'Native soil survey mapping units' if source=='ssurgo-statsgo2' else 'CDL native raster resolution returned in each point sample; not polygon-wide coverage' if source=='usda-cdl' else 'Production region; not a parcel'},
            'temporal':{'start':value.get('header',{}).get('start') if is_power else None,'end':value.get('header',{}).get('end') if is_power else None,'step':'daily' if is_power else None,'timezone':value.get('header',{}).get('time_standard') if is_power else None},
            'variables':variables,'quality_notes':'Immutable upstream response. Derived outputs must validate completeness, units and spatial support. Unverified redistribution terms are null, not a permission.',
            'sha256':meta['sha256'],'request':meta['request']}
        if source == 'noaa-nws':
            properties = value.get('properties', {}) if isinstance(value, dict) else {}
            periods = properties.get('periods', [])
            entry.update({
                'title': 'NOAA NWS point metadata / short-range weather forecast',
                'citation': 'NOAA National Weather Service, api.weather.gov',
                'license': 'Public domain NWS content unless otherwise noted; attribution and no implied endorsement',
                'license_url': 'https://www.weather.gov/disclaimer',
                'redistribution_allowed': True,
                'spatial': {'crs': 'EPSG:4326',
                            'coverage': 'Requested NWS forecast grid; see point metadata',
                            'resolution': 'NWS forecast grid ~2.5 km; not a parcel measurement'},
                'temporal': {'start': periods[0].get('startTime') if periods else None,
                             'end': periods[-1].get('endTime') if periods else None,
                             'step': 'See startTime/endTime per forecast period',
                             'timezone': 'ISO 8601 offset in each forecast period',
                             'issued_at': properties.get('updateTime')},
                'variables': [{'name': 'temperature', 'definition': 'Forecast air temperature; not soil temperature',
                               'unit': 'temperatureUnit per period', 'nodata': None},
                              {'name': 'probabilityOfPrecipitation', 'definition': 'Precipitation probability; not rainfall amount',
                               'unit': '%', 'nodata': None}],
                'quality_notes': 'Short-range forecast, not observation or historical reanalysis. '
                                 'Validate issue time and remaining horizon before use. Point metadata has no forecast values.',
            })
        with self._catalog_lock:
            catalog=json.loads(CATALOG.read_text(encoding='utf-8')) if CATALOG.exists() else {'schema_version':'1.0','datasets':[]}
            catalog['datasets']=[old for old in catalog['datasets'] if old['id']!=entry['id']]+[entry]
            atomic_json(CATALOG,catalog)

CACHE=SourceCache()

POWER_PARAMETERS='T2M,T2M_MAX,T2M_MIN,PRECTOTCORR,ALLSKY_SFC_SW_DWN,RH2M,WS2M,GWETROOT,GWETTOP'
def power_point(lon,lat,year,refresh=False):
    from urllib.parse import urlencode
    today=dt.datetime.now(dt.timezone.utc).date()
    end=min(dt.date(year,12,31),today-dt.timedelta(days=7))
    if end<dt.date(year,1,1): raise UpstreamError('Selected season is not yet available')
    query=urlencode({'parameters':POWER_PARAMETERS,'community':'AG','longitude':round(lon,4),'latitude':round(lat,4),'start':f'{year}0101','end':end.strftime('%Y%m%d'),'format':'JSON','time-standard':'LST'})
    return CACHE.fetch('nasa-power','https://power.larc.nasa.gov/api/temporal/daily/point?'+query,ttl=86400,refresh=refresh,kind='reanalysis')
