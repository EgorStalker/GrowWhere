"""Read-only connectivity probes; never substitute fabricated data on failure."""
import concurrent.futures
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
QUERY = """SELECT TOP 1 m.mukey, m.muname, c.cokey, c.comppct_r, c.slope_r,
h.ph1to1h2o_r, h.claytotal_r, h.sandtotal_r, h.om_r, h.awc_r
FROM mapunit m JOIN component c ON c.mukey=m.mukey
LEFT JOIN chorizon h ON h.cokey=c.cokey AND h.hzdept_r=0
WHERE m.mukey IN (SELECT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('POINT(-97.5 38.5)'))
ORDER BY c.comppct_r DESC"""
PROBES = {
    'nasa-power': ('https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M,T2M_MAX,T2M_MIN,PRECTOTCORR,ALLSKY_SFC_SW_DWN,RH2M,GWETROOT&community=AG&longitude=-97.5&latitude=38.5&start=20250401&end=20250930&format=JSON', None),
    'usda-sda': ('https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest', {'query': QUERY, 'format':'JSON+COLUMNNAME'}),
    'leaflet': ('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', None),
}
def probe(item):
    name,(url,body)=item
    started=time.monotonic()
    try:
        req=urllib.request.Request(url,data=json.dumps(body).encode() if body else None,headers={'User-Agent':'GrowWhere/0.2 research prototype','Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=40) as response:
            raw=response.read()
        if name!='leaflet':
            data=json.loads(raw)
            folder=ROOT/'data/raw/connectivity'
            folder.mkdir(parents=True,exist_ok=True)
            (folder/f'{name}.json').write_bytes(raw)
            summary = data.get('Table') if name=='usda-sda' else {'parameters':list(data.get('properties',{}).get('parameter',{})), 'header':data.get('header'), 'geometry':data.get('geometry')}
        else:
            summary={'bytes':len(raw)}
        return {'source':name,'ok':True,'seconds':round(time.monotonic()-started,1),'summary':summary}
    except Exception as exc:
        return {'source':name,'ok':False,'seconds':round(time.monotonic()-started,1),'error':str(exc)}
if __name__=='__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for result in pool.map(probe,PROBES.items()):
            print(json.dumps(result,ensure_ascii=False))
