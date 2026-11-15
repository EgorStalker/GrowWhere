"""Immutable precomputed map products. Read paths never call source adapters."""
import copy
from contextlib import contextmanager
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import uuid

DEFAULT_PATH=Path(__file__).resolve().parents[2]/'processed'/'map-products.sqlite3'
STORE_VERSION='growwhere-map-store-0.1'
PUBLIC_SOURCE_FIELDS=('id','source_id','source_url','retrieved_at','upstream_modified','sha256','kind')


def _json(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _now():
    return dt.datetime.now(dt.timezone.utc)


def _date(value):
    parsed=dt.datetime.fromisoformat(value.replace('Z','+00:00'))
    if parsed.tzinfo is None: raise ValueError('Timestamp must include timezone')
    return parsed.astimezone(dt.timezone.utc)


def validate_bbox(value):
    if not isinstance(value,(list,tuple)) or len(value)!=4 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in value):
        raise ValueError('bbox must contain four finite WGS84 numbers')
    w,s,e,n=map(float,value)
    if not -180<=w<e<=180 or not -90<=s<n<=90: raise ValueError('Invalid WGS84 bbox')
    return [w,s,e,n]


def _scenario(value):
    result={key:value[key] for key in ('crop','year','planting','irrigation_mm','irrigation_known','method')}
    if not isinstance(result['crop'],str) or not result['crop'] or not isinstance(result['method'],str) or not result['method']:
        raise ValueError('crop and method are required')
    if isinstance(result['year'],bool) or not isinstance(result['year'],int): raise ValueError('year must be an integer')
    planting=dt.date.fromisoformat(result['planting'])
    if planting.year!=result['year']: raise ValueError('Planting date must belong to the selected year')
    water=result['irrigation_mm']
    if isinstance(water,bool) or not isinstance(water,(int,float)) or not math.isfinite(water) or not 0<=water<=5000:
        raise ValueError('Invalid irrigation amount')
    if type(result['irrigation_known']) is not bool: raise ValueError('irrigation_known must be boolean')
    result['irrigation_mm']=float(water)
    return result


def _geometry_bbox(geometry):
    if not isinstance(geometry,dict) or geometry.get('type') not in ('Polygon','MultiPolygon'): raise ValueError('Map cells must be polygons')
    points=[]
    polygons=[geometry['coordinates']] if geometry['type']=='Polygon' else geometry['coordinates']
    if not polygons: raise ValueError('Empty geometry')
    for polygon in polygons:
        if not polygon: raise ValueError('Empty polygon')
        for ring in polygon:
            if len(ring)<4 or ring[0]!=ring[-1]: raise ValueError('Map cell rings must be closed')
            for point in ring:
                if len(point)!=2 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in point): raise ValueError('Invalid geometry coordinates')
                if not -180<=point[0]<=180 or not -90<=point[1]<=90: raise ValueError('Invalid WGS84 coordinate')
                points.append(point)
    return validate_bbox([min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)])


def _union(boxes):
    return [min(b[0] for b in boxes),min(b[1] for b in boxes),max(b[2] for b in boxes),max(b[3] for b in boxes)] if boxes else None


def _unknown(bbox,reason='not_precomputed'):
    w,s,e,n=bbox
    return {'type':'Feature','id':'nodata-background','geometry':{'type':'Polygon','coordinates':[[[w,s],[e,s],[e,n],[w,n],[w,s]]]},
            'properties':{'id':'nodata-background','render_only':True,'representation':'explicit_no_data',
                          'result':{'score':None,'status':'unknown','missing':[reason]}}}


class MapStore:
    def __init__(self,path=DEFAULT_PATH):
        self.path=Path(path)

    @contextmanager
    def _connect(self,write=False):
        if write:
            self.path.parent.mkdir(parents=True,exist_ok=True)
            db=sqlite3.connect(self.path,timeout=20)
            db.executescript('''
              PRAGMA foreign_keys=ON;
              CREATE TABLE IF NOT EXISTS products(
                product_id TEXT PRIMARY KEY,status TEXT NOT NULL,created_at TEXT NOT NULL,
                crop TEXT NOT NULL,year INTEGER NOT NULL,planting TEXT NOT NULL,
                irrigation_mm REAL NOT NULL,irrigation_known INTEGER NOT NULL,method TEXT NOT NULL,
                scenario_key TEXT NOT NULL,source_snapshot TEXT,version_key TEXT,manifest TEXT NOT NULL);
              CREATE INDEX IF NOT EXISTS product_scenario ON products(crop,year,planting,irrigation_mm,irrigation_known,method,status);
              CREATE INDEX IF NOT EXISTS product_version ON products(scenario_key,source_snapshot,version_key);
              CREATE VIRTUAL TABLE IF NOT EXISTS product_bounds USING rtree(id,west,east,south,north);
              CREATE TABLE IF NOT EXISTS cells(id INTEGER PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(product_id),feature TEXT NOT NULL);
              CREATE INDEX IF NOT EXISTS cells_product ON cells(product_id);
              CREATE VIRTUAL TABLE IF NOT EXISTS cell_bounds USING rtree(id,west,east,south,north);
            ''')
        else:
            db=sqlite3.connect(self.path.resolve().as_uri()+'?mode=ro',uri=True,timeout=10)
        db.row_factory=sqlite3.Row
        try:
            with db: yield db
        finally:
            db.close()

    def begin(self,scenario,enabled_bbox,native_zoom=6):
        scenario=_scenario(scenario);bounds=validate_bbox(enabled_bbox)
        if isinstance(native_zoom,bool) or not isinstance(native_zoom,(int,float)) or not 0<=native_zoom<=20: raise ValueError('Invalid native zoom')
        identity=uuid.uuid4().hex
        manifest={'product_id':identity,'status':'pending','store_version':STORE_VERSION,
                  'scenario':scenario,'scenario_key':_hash(scenario),'enabled_bbox':bounds,
                  'actual_data_bbox':None,'native_zoom':native_zoom,'rendering':'native_unsmoothed',
                  'created_at':_now().isoformat(),'published_at':None,'expires_at':None,
                  'source_snapshot':None,'source_snapshots':[],'version_key':None,
                  'data_status':'not_precomputed','status_counts':{},'feature_count':0,
                  'data_coverage_definition':'actual_data_bbox is an extent of scored stored cells, not a guarantee of complete data inside that extent.',
                  'is_live_forecast':False,'resolution_policy':'Zoom changes display scale, not analytical resolution.'}
        with self._connect(write=True) as db:
            cursor=db.execute('INSERT INTO products VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (identity,'pending',manifest['created_at'],scenario['crop'],scenario['year'],scenario['planting'],scenario['irrigation_mm'],int(scenario['irrigation_known']),scenario['method'],manifest['scenario_key'],None,None,_json(manifest)))
            db.execute('INSERT INTO product_bounds VALUES(?,?,?,?,?)',(cursor.lastrowid,bounds[0],bounds[2],bounds[1],bounds[3]))
        return manifest

    def publish(self,product_id,collection,source_snapshots=None,ttl_seconds=86400):
        """Validate before writing; cells and ready manifest become visible together."""
        if collection.get('type')!='FeatureCollection' or not isinstance(collection.get('features'),list): raise ValueError('Expected FeatureCollection')
        if isinstance(ttl_seconds,bool) or not isinstance(ttl_seconds,(int,float)) or not math.isfinite(ttl_seconds) or ttl_seconds<=0: raise ValueError('Invalid expiry duration')
        cells=[];counts={};scored=[];sources={}
        for source in source_snapshots or []:
            item={key:source.get(key) for key in PUBLIC_SOURCE_FIELDS}
            sources[_json(item)]=item
        for original in collection['features']:
            feature=copy.deepcopy(original)
            bbox=_geometry_bbox(feature.get('geometry'))
            properties=feature.setdefault('properties',{});result=properties.setdefault('result',{})
            status=result.get('status','unknown')
            if status not in ('good','conditional','poor','unknown','excluded'): raise ValueError('Invalid cell status')
            if result.get('missing') and status!='excluded':
                status='unknown';result['status']='unknown'
            score=result.get('score')
            if status in ('unknown','excluded'):
                result['score']=None
            elif isinstance(score,bool) or not isinstance(score,(int,float)) or not math.isfinite(score) or not 0<=score<=100:
                raise ValueError('Scored cells need a finite validated score')
            else: scored.append(bbox)
            counts[status]=counts.get(status,0)+1
            public=[]
            for source in properties.get('source_meta',[]):
                item={key:source.get(key) for key in PUBLIC_SOURCE_FIELDS}
                sources[_json(item)]=item;public.append(item)
            properties['source_meta']=public
            cells.append((bbox,_json(feature)))
        source_list=sorted(sources.values(),key=_json)
        now=_now()
        with self._connect(write=True) as db:
            row=db.execute('SELECT manifest,status FROM products WHERE product_id=?',(product_id,)).fetchone()
            if row is None: raise ValueError('Unknown map product')
            if row['status']!='pending': raise ValueError('Published or failed products are immutable')
            manifest=json.loads(row['manifest'])
            manifest.update(status='ready',published_at=now.isoformat(),expires_at=(now+dt.timedelta(seconds=ttl_seconds)).isoformat(),
                            actual_data_bbox=_union(scored),source_snapshots=source_list,source_snapshot=_hash(source_list),
                            feature_count=len(cells),status_counts=counts,
                            data_status='no_data' if not scored else 'partial' if counts.get('unknown') or collection.get('meta',{}).get('truncated') or collection.get('meta',{}).get('errors') else 'available',
                            analysis_metadata=collection.get('meta',{}))
            manifest['version_key']=_hash({'scenario':manifest['scenario'],'enabled_bbox':manifest['enabled_bbox'],
                'native_zoom':manifest['native_zoom'],'sources':source_list,'features':[json.loads(cell[1]) for cell in cells],'store':STORE_VERSION})
            for bbox,feature in cells:
                cursor=db.execute('INSERT INTO cells(product_id,feature) VALUES(?,?)',(product_id,feature))
                db.execute('INSERT INTO cell_bounds VALUES(?,?,?,?,?)',(cursor.lastrowid,bbox[0],bbox[2],bbox[1],bbox[3]))
            cursor=db.execute('UPDATE products SET status=?,source_snapshot=?,version_key=?,manifest=? WHERE product_id=? AND status=?',
                ('ready',manifest['source_snapshot'],manifest['version_key'],_json(manifest),product_id,'pending'))
            if cursor.rowcount!=1: raise ValueError('Product changed during publication')
        return self._freshness(manifest)

    def fail(self,product_id,reason):
        with self._connect(write=True) as db:
            row=db.execute('SELECT manifest,status FROM products WHERE product_id=?',(product_id,)).fetchone()
            if row is None or row['status']!='pending': raise ValueError('Only pending products can fail')
            manifest=json.loads(row['manifest']);manifest.update(status='failed',failure_reason=str(reason)[:400])
            db.execute('UPDATE products SET status=?,manifest=? WHERE product_id=?',('failed',_json(manifest),product_id))
        return manifest

    @staticmethod
    def _freshness(manifest):
        manifest=copy.deepcopy(manifest)
        stale=bool(manifest.get('expires_at') and _date(manifest['expires_at'])<=_now())
        manifest.update(stale=stale,freshness='stale' if stale else 'snapshot' if manifest['status']=='ready' else 'not_ready')
        return manifest

    def list_products(self,crop=None,year=None,planting=None,irrigation_mm=None,irrigation_known=None,method=None,source_snapshot=None,bbox=None,include_unready=False):
        if not self.path.is_file(): return []
        filters=[];values=[]
        if not include_unready: filters.append("status='ready'")
        for key,value in [('crop',crop),('year',year),('planting',planting),('irrigation_mm',irrigation_mm),('irrigation_known',int(irrigation_known) if irrigation_known is not None else None),('method',method),('source_snapshot',source_snapshot)]:
            if value is not None: filters.append(key+'=?');values.append(value)
        tables='products'
        if bbox is not None:
            bbox=validate_bbox(bbox)
            tables+=' JOIN product_bounds b ON b.id=products.rowid'
            filters.extend(['b.west<?','b.east>?','b.south<?','b.north>?'])
            values.extend([bbox[2],bbox[0],bbox[3],bbox[1]])
        with self._connect() as db:
            rows=db.execute('SELECT manifest FROM '+tables+(' WHERE '+' AND '.join(filters) if filters else '')+' ORDER BY created_at DESC LIMIT 100',values).fetchall()
        manifests=[self._freshness(json.loads(row['manifest'])) for row in rows]
        return manifests

    def tiles(self,product_id,bbox,zoom):
        bbox=validate_bbox(bbox)
        if isinstance(zoom,bool) or not isinstance(zoom,(int,float)) or not math.isfinite(zoom) or not 0<=zoom<=20: raise ValueError('Invalid map zoom')
        manifest=None;features=[]
        if self.path.is_file():
            with self._connect() as db:
                row=db.execute('SELECT manifest,status FROM products WHERE product_id=?',(product_id,)).fetchone()
                if row:
                    manifest=self._freshness(json.loads(row['manifest']))
                    if row['status']=='ready' and _intersects(manifest['enabled_bbox'],bbox):
                        rows=db.execute('SELECT c.feature FROM cell_bounds b JOIN cells c ON c.id=b.id WHERE c.product_id=? AND b.west<? AND b.east>? AND b.south<? AND b.north>? ORDER BY c.id',
                            (product_id,bbox[2],bbox[0],bbox[3],bbox[1])).fetchall()
                        features=[json.loads(row['feature']) for row in rows]
        status=manifest['status'] if manifest else 'not_precomputed'
        meta={**(manifest or {}).get('analysis_metadata',{}),**(manifest or {}),'product_id':product_id,'status':status,'query_bbox':bbox,'zoom':zoom,
              'read_only':True,'upstream_requests':0,'nodata_background':_unknown(bbox),
              'nodata_reason':None if features else 'not_precomputed','lod':'native_unsmoothed'}
        return {'type':'FeatureCollection','features':features,'meta':meta}


def _intersects(a,b):
    return a[0]<b[2] and a[2]>b[0] and a[1]<b[3] and a[3]>b[1]


STORE=MapStore()
