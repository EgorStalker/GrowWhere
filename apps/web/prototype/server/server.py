"""Local same-origin API and static file host; public upstreams are fixed adapters."""
import datetime as dt
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit,parse_qs

PROJECT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(PROJECT/'data/pipelines'))
from growwhere.service import analyze,source_status
from growwhere.insights import analyze_point_insights
from growwhere.planning import planning_readiness
from growwhere.forecast import nws_forecast,forecast_evidence
from growwhere.agronomy import assess_agronomic_readiness
from growwhere.sources import utcnow
from growwhere.map_store import STORE as MAP_STORE

STATIC=Path(__file__).resolve().parents[1]/'dist'
class LocalServer(ThreadingHTTPServer):
    def handle_error(self,request,client_address):
        # Browser navigation/AbortController may close an obsolete response.
        if isinstance(sys.exception(),(BrokenPipeError,ConnectionResetError,ConnectionAbortedError)): return
        super().handle_error(request,client_address)

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(STATIC),**kwargs)
    def end_headers(self):
        path = urlsplit(getattr(self, 'path', '')).path
        if not path.startswith('/api/') and not path.startswith('/vendor/'):
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()
    def json(self,status,value):
        raw=json.dumps(value,ensure_ascii=False,allow_nan=False).encode()
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Content-Length',str(len(raw)));self.end_headers()
        try: self.wfile.write(raw)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError): pass
    def do_GET(self):
        parsed=urlsplit(self.path)
        if not parsed.path.startswith('/api/'): return super().do_GET()
        params=parse_qs(parsed.query)
        get=lambda name,default=None:params.get(name,[default])[0]
        try:
            if parsed.path=='/api/health': return self.json(200,{'status':'ok','time':utcnow()})
            if parsed.path=='/api/sources': return self.json(200,source_status())
            if parsed.path=='/api/map-products':
                bbox=get('bbox')
                known=get('irrigation_known')
                if known is not None and known not in ('true','false'): raise ValueError('irrigation_known must be true or false')
                products=MAP_STORE.list_products(crop=get('crop'),year=int(get('year')) if get('year') is not None else None,
                    planting=get('planting'),irrigation_mm=float(get('irrigation_mm')) if get('irrigation_mm') is not None else None,
                    irrigation_known=known=='true' if known is not None else None,method=get('method'),source_snapshot=get('source_snapshot'),
                    bbox=[float(v) for v in bbox.split(',')] if bbox else None,include_unready=get('include_unready','0')=='1')
                return self.json(200,{'products':products,'read_only':True,'upstream_requests':0})
            if parsed.path=='/api/map-products/tiles':
                if not get('product_id') or not get('bbox') or get('zoom') is None: raise ValueError('product_id, bbox and zoom are required')
                return self.json(200,MAP_STORE.tiles(get('product_id'),[float(v) for v in get('bbox').split(',')],float(get('zoom'))))
            if parsed.path=='/api/planning-readiness':
                bbox=get('bbox')
                value=planning_readiness(mode=get('mode','own_land'),crop=get('crop'),
                    lon=get('lon'),lat=get('lat'),
                    bbox=[float(v) for v in bbox.split(',')] if bbox is not None else None,
                    target_year=get('target_year'),scale_ha=get('scale_ha'))
                if value['coverage']['status']=='supported' and get('lon') is not None:
                    forecast=nws_forecast(get('lon'),get('lat'),refresh=get('refresh','0')=='1')
                    value=planning_readiness(mode=get('mode','own_land'),crop=get('crop'),
                        lon=get('lon'),lat=get('lat'),target_year=get('target_year'),scale_ha=get('scale_ha'),
                        evidence={'validated_weather_forecast':forecast_evidence(forecast,get('target_year'))})
                    value['forecast']=forecast
                else:
                    value['forecast']={'available':False,'data':None,'status':'point_required' if value['coverage']['status']=='supported' else 'outside_or_missing_coverage',
                        'reason':'Select a point in the Kansas pilot area to retrieve a forecast.','provenance':[]}
                value['agronomic_rules']=assess_agronomic_readiness(get('crop')) if get('crop') else None
                return self.json(200,value)
            if parsed.path=='/api/analysis':
                value=analyze([float(v) for v in get('bbox','-99,38,-97,39').split(',')],float(get('zoom','7')),get('crop','wheat'),int(get('year',str(dt.datetime.now().year-1))),get('planting','2025-05-01'),float(get('irrigation_mm','0')),get('irrigation_known','true')=='true',get('refresh','0')=='1')
                return self.json(200,value)
            if parsed.path=='/api/insights':
                value=analyze_point_insights(float(get('lon','-97.5')),float(get('lat','38.5')),get('crop','wheat'),int(get('year',str(dt.datetime.now().year-1))),get('planting','2025-05-01'),float(get('irrigation_mm','0')),get('irrigation_known','true')=='true',int(get('years_back','5')),get('refresh','0')=='1')
                return self.json(200,value)
            if parsed.path=='/api/economics':
                from growwhere.economics import economics
                return self.json(200,economics(get('crop','wheat'),int(get('year','2025')),get('refresh','0')=='1'))
            return self.json(404,{'error':'Unknown API endpoint'})
        except ValueError as exc:
            messages={
                'This version supports seasons within one calendar year':'Choose an earlier reference date: this version evaluates seasons within one calendar year.',
                'Planting date must belong to the selected year':'The scenario date must belong to the selected year.',
                'Invalid irrigation amount':'The water amount must be between 0 and 5000 mm.',
                'Year is outside the available historical window':'The selected year is not supported yet.',
                'Invalid WGS84 bbox':'This map area has no analytical coverage. Return to Kansas.',
                'Unsupported crop':'This crop is not supported yet.'}
            return self.json(400,{'error':messages.get(str(exc),'Check your parameters: '+str(exc)),'status':'invalid_request'})
        except Exception as exc: return self.json(502,{'error':str(exc)[:400],'status':'source_unavailable'})
    def log_message(self,fmt,*args):
        # Do not log user coordinates or budgets from request URLs.
        if args and isinstance(args[0],str) and '/api/' in args[0]: return
        super().log_message(fmt,*args)

if __name__=='__main__':
    port=int(os.environ.get('PORT','4173'))
    server=LocalServer(('127.0.0.1',port),Handler)
    print(f'Local: http://127.0.0.1:{port}',flush=True)
    if '--open-browser' in sys.argv:
        import webbrowser
        webbrowser.open(f'http://127.0.0.1:{port}')
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
