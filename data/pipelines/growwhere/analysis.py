"""FAO-56 ET0 plus an explicitly uncalibrated multi-criteria screening index.

No fake observations, zero-filling or renormalization around missing factors.
"""
import datetime as dt
import math

METHOD_VERSION = 'growwhere-screening-0.2'
# Kc values/stage lengths: FAO-56 tables 11/12. Temperature envelopes, weights,
# slope and texture responses are exposed working assumptions, not FAO ratings.
PROFILES = {
    'wheat': {'name':'Spring wheat','stages':[20,25,60,30], 'kc':[0.3,1.15,0.3], 'temperature':[0,12,24,36], 'ph':[4.5,5.5,7,8.5], 'frost':-3,'heat':35, 'default_planting':'03-15'},
    'soy': {'name':'Soybeans','stages':[20,35,60,25], 'kc':[0.4,1.15,0.5], 'temperature':[8,20,30,40], 'ph':[4.5,6,7,8.5], 'frost':0,'heat':36, 'default_planting':'05-01'},
    'corn': {'name':'Corn','stages':[30,40,50,30], 'kc':[0.3,1.2,0.35], 'temperature':[8,18,30,42], 'ph':[4.5,6,7,8.5], 'frost':0,'heat':36, 'default_planting':'05-01'},
    'sorghum': {'name':'Sorghum','stages':[20,35,45,30], 'kc':[0.3,1.05,0.55], 'temperature':[10,20,32,43], 'ph':[5.0,5.8,7.5,8.5], 'frost':0,'heat':39, 'default_planting':'05-15'},
    'barley': {'name':'Spring barley','stages':[20,25,50,30], 'kc':[0.3,1.15,0.25], 'temperature':[0,11,23,36], 'ph':[5.0,6.0,7.8,8.5], 'frost':-3,'heat':35, 'default_planting':'03-15'},
    'oats': {'name':'Oats','stages':[20,30,50,30], 'kc':[0.3,1.15,0.25], 'temperature':[0,10,22,35], 'ph':[4.5,5.5,7.2,8.2], 'frost':-3,'heat':34, 'default_planting':'03-15'},
    'cotton': {'name':'Cotton','stages':[30,50,55,45], 'kc':[0.35,1.18,0.6], 'temperature':[12,22,33,44], 'ph':[5.0,5.8,7.8,8.5], 'frost':0,'heat':39, 'default_planting':'04-20'},
}
WEIGHTS = {'temperature':.20,'water':.30,'ph':.15,'awc':.10,'drainage':.10,'slope':.10,'texture':.05}
DRAINAGE = {'Excessively drained':.65,'Somewhat excessively drained':.8,'Well drained':1.,'Moderately well drained':.85,'Somewhat poorly drained':.55,'Poorly drained':.25,'Very poorly drained':0.}

def number(value, low=None, high=None):
    try: value=float(value)
    except (TypeError,ValueError): return None
    if not math.isfinite(value) or value<=-900: return None
    if low is not None and value<low or high is not None and value>high: return None
    return value

def clamp(value, lo=0., hi=1.): return max(lo,min(hi,value))

def trapezoid(value, limits):
    if value is None: return None
    a,b,c,d=limits
    if value<=a or value>=d: return 0.
    if b<=value<=c: return 1.
    return (value-a)/(b-a) if value<b else (d-value)/(d-c)

def reference_et0(day, latitude, elevation, tmean, tmin, tmax, humidity, wind, solar_kwh):
    """Daily FAO-56 eq. 6; mean RH approximation eq. 19, G=0.

    Radiation NASA kWh/m²/day -> MJ/m²/day; wind is at 2 m.
    """
    values=[number(tmean,-80,65),number(tmin,-80,65),number(tmax,-80,65),number(humidity,0,100),number(wind,0,100),number(solar_kwh,0,25),number(elevation,-450,9000)]
    latitude=number(latitude,-90,90)
    if any(v is None for v in values) or latitude is None: return None
    tmean,tmin,tmax,humidity,wind,solar_kwh,elevation=values
    if tmax<tmin: return None
    svp=lambda temp:.6108*math.exp(17.27*temp/(temp+237.3))
    es=(svp(tmin)+svp(tmax))/2
    ea=es*humidity/100
    delta=4098*svp(tmean)/(tmean+237.3)**2
    pressure=101.3*((293-.0065*elevation)/293)**5.26
    gamma=.000665*pressure
    j=day.timetuple().tm_yday
    phi=math.radians(latitude)
    solar_decl=.409*math.sin(2*math.pi*j/365-1.39)
    sunset=math.acos(clamp(-math.tan(phi)*math.tan(solar_decl),-1,1))
    ra=24*60/math.pi*.0820*(1+.033*math.cos(2*math.pi*j/365))*(sunset*math.sin(phi)*math.sin(solar_decl)+math.cos(phi)*math.cos(solar_decl)*math.sin(sunset))
    if ra<=0: return None
    rs=solar_kwh*3.6
    rso=(.75+2e-5*elevation)*ra
    rnl=4.903e-9*((tmax+273.16)**4+(tmin+273.16)**4)/2*(.34-.14*math.sqrt(ea))*(1.35*clamp(rs/rso,.3,1)-.35)
    rn=.77*rs-rnl
    et=(.408*delta*rn+gamma*900/(tmean+273)*wind*(es-ea))/(delta+gamma*(1+.34*wind))
    return max(0.,et)

def crop_coefficient(index, profile):
    initial,development,middle,late=profile['stages']
    k0,km,ke=profile['kc']
    if index<initial: return k0
    if index<initial+development: return k0+(km-k0)*(index-initial)/development
    if index<initial+development+middle: return km
    return km+(ke-km)*min(1,(index-initial-development-middle)/late)

def climate_metrics(raw, crop_id, planting):
    profile=PROFILES[crop_id]
    start=dt.date.fromisoformat(planting)
    length=sum(profile['stages'])
    params=raw.get('properties',{}).get('parameter',{})
    coordinates=raw.get('geometry',{}).get('coordinates',[])
    if len(coordinates)<3: return {'complete':False,'missing':['climate_coordinates']}
    lon,lat,elevation=coordinates[:3]
    temperature=[];rain=[];et=[];mins=[];maxs=[];wetness=[];surface_wet=[];valid_days=0;latest=None
    required=['T2M','T2M_MIN','T2M_MAX','PRECTOTCORR','RH2M','WS2M','ALLSKY_SFC_SW_DWN']
    units={key:raw.get('parameters',{}).get(key,{}).get('units') for key in required}
    accepted={'T2M':{'C','degC'},'T2M_MIN':{'C','degC'},'T2M_MAX':{'C','degC'},'PRECTOTCORR':{'mm/day'},'RH2M':{'%'},'WS2M':{'m/s'},'ALLSKY_SFC_SW_DWN':{'MJ/m^2/day','kW-hr/m^2/day','kWh/m^2/day'}}
    invalid_units=[key for key in required if units[key] not in accepted[key]]
    if invalid_units: return {'complete':False,'missing':['units:'+key for key in invalid_units],'source_units':units,'start':start.isoformat(),'end':(start+dt.timedelta(days=length-1)).isoformat()}
    for index in range(length):
        day=start+dt.timedelta(days=index);key=day.strftime('%Y%m%d')
        data={name:number(params.get(name,{}).get(key)) for name in required}
        if any(value is None for value in data.values()): continue
        solar_kwh=data['ALLSKY_SFC_SW_DWN']/(3.6 if units['ALLSKY_SFC_SW_DWN']=='MJ/m^2/day' else 1)
        e=reference_et0(day,lat,elevation,data['T2M'],data['T2M_MIN'],data['T2M_MAX'],data['RH2M'],data['WS2M'],solar_kwh)
        if e is None or data['PRECTOTCORR']<0: continue
        valid_days+=1;latest=day.isoformat()
        temperature.append(data['T2M']);mins.append(data['T2M_MIN']);maxs.append(data['T2M_MAX'])
        rain.append(data['PRECTOTCORR']);et.append(e*crop_coefficient(index,profile))
        value=number(params.get('GWETROOT',{}).get(key),0,1)
        if value is not None: wetness.append(value)
        top_value=number(params.get('GWETTOP',{}).get(key),0,1)
        if top_value is not None: surface_wet.append(top_value)
    coverage=valid_days/length
    # Strict complete season: no extrapolation of a partially returned season.
    complete=valid_days==length
    return {'complete':complete,'missing':[] if complete else ['complete_season'], 'valid_days':valid_days,'expected_days':length,'coverage':round(coverage,3),'start':start.isoformat(),'end':(start+dt.timedelta(days=length-1)).isoformat(),'latest_observation':latest,
        'mean_temperature':sum(temperature)/len(temperature) if temperature else None,
        'precipitation_mm':sum(rain) if rain else None,'crop_water_demand_mm':sum(et) if et else None,
        'frost_days':sum(v<profile['frost'] for v in mins),'heat_days':sum(v>profile['heat'] for v in maxs),
        'root_zone_wetness':round(sum(wetness)/len(wetness),3) if wetness else None,
        'surface_wetness':round(sum(surface_wet)/len(surface_wet),3) if surface_wet else None,
        'dry_root_days':sum(v<0.35 for v in wetness) if wetness else None,
        'climate_sample':[lon,lat], 'elevation_m':elevation,'source_units':units}

def evaluate(climate, soil, crop_id, irrigation_mm=0, irrigation_known=True):
    if crop_id not in PROFILES: raise ValueError('Unsupported crop')
    irrigation_mm=number(irrigation_mm,0,5000)
    if irrigation_mm is None: raise ValueError('Irrigation must be finite and between 0 and 5000 mm')
    if not irrigation_known: irrigation_mm=0
    missing=[]
    if not climate or not climate.get('complete'): missing.extend((climate or {}).get('missing') or ['climate'])
    if not soil: missing.append('soil')
    profile=PROFILES[crop_id]
    factors={key:None for key in WEIGHTS}
    if soil:
        ph=number(soil.get('ph'),0,14);awc=number(soil.get('awc'),0,.8)
        slope=number(soil.get('slope'),0,100);sand=number(soil.get('sand'),0,100);clay=number(soil.get('clay'),0,100)
        if ph is not None: factors['ph']=trapezoid(ph,profile['ph'])
        if awc is not None: factors['awc']=clamp(awc/.15)
        if slope is not None: factors['slope']=1 if slope<=2 else clamp((20-slope)/18)
        if sand is not None and clay is not None: factors['texture']=min(1,clamp((95-sand)/20),clamp((75-clay)/25))
        factors['drainage']=DRAINAGE.get(soil.get('drainage'))
        depth=number(soil.get('depth_coverage_cm'))
        if depth is None or depth<29.9: missing.append('soil_0_30cm')
    climate_fields={key:number((climate or {}).get(key)) for key in ['mean_temperature','expected_days','heat_days','frost_days','precipitation_mm','crop_water_demand_mm']}
    climate_valid=all(value is not None for value in climate_fields.values()) and climate_fields['expected_days']>0 and all(climate_fields[key]>=0 for key in ['heat_days','frost_days','precipitation_mm','crop_water_demand_mm'])
    if climate and climate.get('complete') and climate_valid:
        temperature=trapezoid(climate_fields['mean_temperature'],profile['temperature'])
        stress=clamp(1-climate_fields['heat_days']/(climate_fields['expected_days']*.6))*clamp(1-climate_fields['frost_days']/(climate_fields['expected_days']*.15))
        factors['temperature']=temperature*stress
        demand=climate_fields['crop_water_demand_mm']
        if demand is not None and demand>0:
            # 80% effective seasonal rainfall is an exposed screening assumption.
            factors['water']=clamp((.8*climate_fields['precipitation_mm']+irrigation_mm)/demand)
    missing.extend(key for key,value in factors.items() if value is None)
    missing=list(dict.fromkeys(missing))
    if missing: return {'score':None,'status':'unknown','factors':factors,'missing':missing,'method':METHOD_VERSION}
    score=0 if any(value==0 for value in factors.values()) else 100*math.exp(sum(WEIGHTS[key]*math.log(value) for key,value in factors.items()))
    min_factor=min(factors.values())
    # Apply hard ceiling only for genuinely severe limitations (<0.10) so moderate
    # constraints in one factor do not mask irrigation or soil differences.
    if min_factor<0.1:
        score=min(score,100*min_factor**.5)
    limiting=min(factors,key=factors.get)
    return {'score':round(score,1),'status':'good' if score>=70 else 'conditional' if score>=40 else 'poor',
        'factors':{key:round(value,3) for key,value in factors.items()},'limiting_factor':limiting,
        'water_balance':{'effective_rain_mm':round(.8*climate_fields['precipitation_mm'],1),'irrigation_mm':round(irrigation_mm,1),'demand_mm':round(climate_fields['crop_water_demand_mm'],1)},
        'missing':[],'method':METHOD_VERSION,'irrigation_assumption':None if irrigation_known else 'rainfed_unconfirmed'}
