import concurrent.futures,json,urllib.request
PROBES={
'soil-polygons':('https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest',{'query':"SELECT TOP 3 mupolygonkey, mukey, mupolygongeo.STAsText() AS wkt FROM mupolygon WHERE mupolygonkey IN (SELECT mupolygonkey FROM SDA_Get_Mupolygonkey_from_intersection_with_WktWgs84('POLYGON((-97.52 38.48,-97.48 38.48,-97.48 38.52,-97.52 38.52,-97.52 38.48))'))",'format':'JSON+COLUMNNAME'}),
'power-wind':('https://power.larc.nasa.gov/api/temporal/daily/point?parameters=WS2M&community=AG&longitude=-97.5&latitude=38.5&start=20250401&end=20250403&format=JSON',None),
'ers-page':('https://www.ers.usda.gov/data-products/commodity-costs-and-returns',None)
}
def run(item):
    name,(url,body)=item
    try:
        req=urllib.request.Request(url,data=json.dumps(body).encode() if body else None,headers={'Content-Type':'application/json','User-Agent':'GrowWhere research prototype'})
        with urllib.request.urlopen(req,timeout=35) as r: raw=r.read()
        if name=='ers-page':
            import re
            return name,re.findall(r'href="([^"]+\.csv[^"]*)"',raw.decode())[:8]
        result=json.loads(raw)
        if name=='soil-polygons':
            table=result.get('Table',[])
            return name,{'header':table[:1],'rows':[[*r[:2],r[2][:100]] for r in table[1:]],'keys':list(result)}
        return name,result.get('properties',result)
    except Exception as e: return name,str(e)
if __name__=='__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for name,result in pool.map(run,PROBES.items()): print(json.dumps({'name':name,'result':result}))
