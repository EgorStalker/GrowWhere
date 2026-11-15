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
from growwhere.soil_forecast import openmeteo_soil_forecast,indicative_guidance
from growwhere.agronomy import assess_agronomic_readiness
from growwhere.sources import utcnow

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
            if parsed.path=='/api/planning-readiness':
                bbox=get('bbox')
                irrigation_system=get('irrigation_system')
                crop_growth_stage=get('crop_growth_stage')
                crop_variety=get('crop_variety')
                value=planning_readiness(mode=get('mode','own_land'),crop=get('crop'),
                    lon=get('lon'),lat=get('lat'),
                    bbox=[float(v) for v in bbox.split(',')] if bbox is not None else None,
                    target_year=get('target_year'),scale_ha=get('scale_ha'),
                    irrigation_system=irrigation_system,crop_growth_stage=crop_growth_stage,crop_variety=crop_variety)
                agronomic_rules=assess_agronomic_readiness(get('crop')) if get('crop') else None
                if value['coverage']['status']=='supported' and get('lon') is not None:
                    refresh_flag=get('refresh','0')=='1'
                    forecast=nws_forecast(get('lon'),get('lat'),refresh=refresh_flag)
                    soil_fc=openmeteo_soil_forecast(get('lon'),get('lat'),refresh=refresh_flag)
                    value=planning_readiness(mode=get('mode','own_land'),crop=get('crop'),
                        lon=get('lon'),lat=get('lat'),target_year=get('target_year'),scale_ha=get('scale_ha'),
                        irrigation_system=irrigation_system,crop_growth_stage=crop_growth_stage,crop_variety=crop_variety,
                        evidence={'validated_weather_forecast':forecast_evidence(forecast,get('target_year'))})
                    value['forecast']=forecast
                    value['soil_forecast']=soil_fc
                    value['indicative_guidance']=indicative_guidance(get('crop'),soil_fc,agronomic_rules,
                        irrigation_system=irrigation_system,crop_growth_stage=crop_growth_stage,crop_variety=crop_variety)
                else:
                    value['forecast']={'available':False,'data':None,'status':'point_required' if value['coverage']['status']=='supported' else 'outside_or_missing_coverage',
                        'reason':'Для погодного прогнозу оберіть точку в пілотній області Канзасу.','provenance':[]}
                    value['soil_forecast']={'available':False,'data':None,'status':'point_required' if value['coverage']['status']=='supported' else 'outside_or_missing_coverage',
                        'reason':'Для модельного прогнозу ґрунту оберіть точку в пілотній області Канзасу.','provenance':[]}
                    value['indicative_guidance']=None
                value['agronomic_rules']=agronomic_rules
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
                'This version supports seasons within one calendar year':'Оберіть ранішу дату сівби: ця версія оцінює сезон у межах одного календарного року.',
                'Planting date must belong to the selected year':'Дата сівби має належати обраному року.',
                'Invalid irrigation amount':'Кількість води має бути числом від 0 до 5000 мм.',
                'Year is outside the available historical window':'Обраний рік ще не підтримується.',
                'Invalid WGS84 bbox':'Ця область карти не підтримується. Поверніться до Канзасу.',
                'Unsupported crop':'Ця культура ще не підтримується.'}
            return self.json(400,{'error':messages.get(str(exc),'Перевірте обрані параметри: '+str(exc)),'status':'invalid_request'})
        except Exception as exc: return self.json(502,{'error':str(exc)[:400],'status':'source_unavailable'})
    def do_POST(self):
        parsed=urlsplit(self.path)
        if parsed.path!='/api/report-pdf': return self.json(404,{'error':'Unknown API endpoint'})
        try:
            length=int(self.headers.get('Content-Length','0') or 0)
            if length<=0 or length>2*1024*1024:
                return self.json(400,{'error':'Некоректний розмір даних звіту.'})
            raw=self.rfile.read(length)
            payload=json.loads(raw.decode('utf-8'))
            from growwhere.report_pdf import generate_report_pdf
            pdf_bytes=generate_report_pdf(payload)
            crop=str((payload.get('header') or {}).get('crop') or 'field')
            year=str((payload.get('header') or {}).get('year') or '')
            safe_name=f'growwhere-report-{crop}-{year}.pdf'.replace('"','')
            self.send_response(200)
            self.send_header('Content-Type','application/pdf')
            self.send_header('Content-Disposition',f'attachment; filename="{safe_name}"')
            self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Length',str(len(pdf_bytes)))
            self.end_headers()
            try: self.wfile.write(pdf_bytes)
            except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError): pass
        except ValueError as exc:
            return self.json(400,{'error':f'Помилка формування PDF: {exc}'})
        except Exception as exc:
            return self.json(500,{'error':f'Не вдалося згенерувати PDF: {str(exc)[:300]}'})
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
