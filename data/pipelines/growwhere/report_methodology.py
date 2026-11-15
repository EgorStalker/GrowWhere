"""Canonical equations for the current implementation, independent of client text."""
from .analysis import PROFILES,WEIGHTS,DRAINAGE,METHOD_VERSION


def methodology_sections(crop):
    if crop not in PROFILES:
        raise ValueError('Unsupported report crop')
    p=PROFILES[crop]
    return [
        ('Method, parameters and units',
         f"Method: {METHOD_VERSION}. Crop: {p['name']}. Stages [initial, development, middle, late] = {p['stages']} days; D = {sum(p['stages'])} days. "
         f"Kc [initial, middle, end] = {p['kc']}; temperature bounds = {p['temperature']} C; pH bounds = {p['ph']}; heat if Tmax > {p['heat']} C; frost if Tmin < {p['frost']} C. "
         'Weights: '+', '.join(f'{k}={v:g}' for k,v in WEIGHTS.items())+'. All seven factors are required.'),
        ('Clamp and trapezoid',
         'clamp(x) = max(0, min(1, x)). trap(x; a,b,c,d) = 0 if x<=a or x>=d; 1 if b<=x<=c; (x-a)/(b-a) if a<x<b; (d-x)/(d-c) if c<x<d.'),
        ('Seven suitability factors',
         'f_temperature = trap(T_mean; a,b,c,d) * clamp(1-H/(D*0.6)) * clamp(1-F/(D*0.15)). H and F are counts of heat and frost days.\n'
         'f_water = clamp((0.8*P + I)/ETc), ETc>0. P and I are seasonal mm; unconfirmed irrigation contributes I=0 as an explicit lower-bound scenario.\n'
         'f_ph = trap(pH; a,b,c,d). f_awc = clamp(AWC/0.15), AWC in cm/cm.\n'
         'f_slope = 1 if slope<=2%; otherwise clamp((20-slope)/18).\n'
         'f_texture = min(1, clamp((95-sand_pct)/20), clamp((75-clay_pct)/25)).\n'
         'f_drainage = table[class]: '+ '; '.join(f'{k}: {v:g}' for k,v in DRAINAGE.items())),
        ('Point score, ceiling and classification',
         'G = 100*exp(sum_i(w_i*ln(f_i))). If any known f_i=0, S=0 without evaluating ln(0). '
         'If min_i(f_i)<0.10, S=min(G,100*sqrt(min_i(f_i))); otherwise S=G. Stored point score = round(S,1). '
         'Classification uses the unrounded point S: good if S>=70, conditional if 40<=S<70, poor if S<40. '
         'Any missing required factor, incomplete season or unrecognized land cover -> score=null, unknown. Known excluded land cover -> score=null, excluded. No weight renormalization.'),
        ('Daily FAO-56 Penman-Monteith ET0',
         'ET0 = max(0, [0.408*Delta*(Rn-Gsoil) + gamma*900/(Tmean+273)*u2*(es-ea)] / [Delta + gamma*(1+0.34*u2)]), Gsoil=0 for a daily time step. '
         'ET0 is mm/day; temperatures C; pressure kPa; radiation MJ/m2/day; wind u2 m/s at 2 m. '
         'The implementation returns missing for invalid inputs, Tmax<Tmin or nonpositive extraterrestrial radiation.'),
        ('Vapour pressure and psychrometric terms',
         'e0(T) = 0.6108*exp(17.27*T/(T+237.3)). es = [e0(Tmin)+e0(Tmax)]/2. ea = es*RHmean/100.\n'
         'Delta = 4098*e0(Tmean)/(Tmean+237.3)^2. Patm = 101.3*((293-0.0065*z)/293)^5.26. gamma = 0.000665*Patm. '
         'z is elevation in m. Mean RH is an approximation, not separate RHmin/RHmax observations.'),
        ('Solar geometry and extraterrestrial radiation',
         'J = day of year; phi = latitude*pi/180. dr = 1+0.033*cos(2*pi*J/365). delta_s = 0.409*sin(2*pi*J/365-1.39).\n'
         'omega_s = acos(clamp(-tan(phi)*tan(delta_s), -1, 1)).\n'
         'Ra = (24*60/pi)*0.0820*dr*[omega_s*sin(phi)*sin(delta_s) + cos(phi)*cos(delta_s)*sin(omega_s)]. '
         'This clamp uses bounds -1 and 1, unlike suitability clamp.'),
        ('Net radiation and unit normalization',
         'Rs = solar_kWh*3.6. POWER radiation already in MJ/m2/day is first divided by 3.6; values supplied in kWh/m2/day remain unchanged.\n'
         'Rso = (0.75+2e-5*z)*Ra. Rnl = 4.903e-9*[(Tmax+273.16)^4+(Tmin+273.16)^4]/2 * (0.34-0.14*sqrt(ea)) * (1.35*clamp(Rs/Rso,0.3,1)-0.35).\n'
         'Rn = 0.77*Rs-Rnl. All radiation terms are MJ/m2/day. The Rs/Rso clamp uses 0.3 and 1.'),
        ('Crop coefficient and seasonal climate',
         'Let [L0,L1,L2,L3] be the stage lengths; [K0,Km,Ke] the crop coefficients; t the zero-based day since the historical reference date.\n'
         'Kc(t)=K0 if t<L0; K0+(Km-K0)*(t-L0)/L1 during development; Km during the middle stage; Km+(Ke-Km)*min(1,(t-L0-L1-L2)/L3) during the late stage.\n'
         'ETc = sum_t(Kc(t)*ET0(t)); P = sum_t(P_t); T_mean = sum_t(T_t)/D. H = count(Tmax_t>heat); F = count(Tmin_t<frost). '
         'A season is complete only when valid_days=D. No extrapolation of missing days.'),
        ('Water balance and displayed moisture',
         'Effective rain = 0.8*P. Supply = 0.8*P+I. Balance = Supply-ETc. Deficit = max(0, ETc-Supply). '
         '1 mm = 10 m3/ha; total volume for a supplied area is mm*ha*10 m3. The factor 0.8 is an uncalibrated screening assumption, not a universal FAO rule.\n'
         'Reported root/surface wetness = mean(valid daily values); dry_root_days = count(valid root wetness < 0.35). Wetness is ancillary context and is not an eighth weighted factor.'),
        ('SSURGO depth and overview sampling',
         'For each required soil property: thickness_h = min(bottom_h,30)-max(top_h,0) over horizons intersecting 0-30 cm. Property = sum(value_h*thickness_h)/sum(thickness_h for horizons with that property). '
         'Coverage is tracked per property; less than 29.9 cm complete coverage prevents a full score. The dominant soil component is selected by representative component share.\n'
         'Overview cell samples: centre and four inner quarters. S_cell = round(sum(S_k)/n_scored,1), provided no sample is unknown and n_scored>0. All excluded samples -> excluded. '
         'Cell factors and water-balance values are arithmetic means of scored samples; score range=[min(S_k),max(S_k)], spread=max(S_k)-min(S_k). '
         'The nonlinear index must not be applied to averaged factors to reconstruct the cell score.'),
        ('Field aggregation and geometry',
         'S_area = round(sum_j(S_j*A_j)/sum_j(A_j)), A_j=max(1 m2, area of the full intersecting scored zone). Unknown intersecting zones block the score. '
         'Field factors use the same scored-zone weights and are rounded to 0.001. The displayed field water balance is an unweighted arithmetic mean of available scored-zone balances. '
         'This implementation does not clip zone areas to the field outline; geometric coverage percentage is unavailable.\n'
         'Ring area = abs((R^2/2)*sum_i[(lon_(i+1)-lon_i)*(pi/180)*(2+sin(lat_i*pi/180)+sin(lat_(i+1)*pi/180))]), R=6371008.8 m. '
         'Polygon area = max(0, outer ring area-sum(hole areas)); MultiPolygon area = sum(polygon areas); hectares = m2/10000. '
         'Closing the ring is implicit for area measurement; drawing validation remains separate.'),
        ('Comparison and economic context',
         'Score difference = S_B-S_A. A higher score is preferred only for the same crop, year, reference date, irrigation amount/known status and method. '
         'abs(S_B-S_A)<=0.5 is labelled close. Missing scores produce no overall preference. Row factor advantages are descriptive, not independent optimization votes.\n'
         'USDA ERS conversions: USD/ha = USD/acre * 2.4710538147; USD/t = USD/bushel * 1000 / bushel_kg; for cotton USD/t = USD/lb * 2204.62262185. '
         'Historical costs and harvest prices do not establish current market demand, available land, yield or profit.'),
        ('Numerical availability and source limits',
         'The equations above describe the current source code. Prepared map snapshots contain rounded seasonal and sample aggregates; daily ET0 inputs and individual sample factors are not all retained. '
         'An equation without complete inputs is documented without a fabricated numeric substitution. Data coverage remains limited to prepared Kansas products. '
         'NASA/USDA source data do not constitute endorsement or field validation of this index. No sowing date or recommended irrigation amount is calculated.'),
        ('References',
         'FAO-56 equation 6 and calculation procedures: https://www.fao.org/4/x0490e/x0490e06.htm ; https://www.fao.org/4/x0490e/x0490e08.htm . '
         'Crop coefficients: https://www.fao.org/4/x0490e/x0490e0b.htm . '
         'NASA POWER: https://power.larc.nasa.gov/ . USDA SSURGO: https://sdmdataaccess.nrcs.usda.gov/ . '
         'USDA CDL: https://croplandcros.scinet.usda.gov/ . USDA ERS: https://www.ers.usda.gov/data-products/commodity-costs-and-returns . '
         'Implementation: data/pipelines/growwhere/analysis.py, service.py, soil.py, economics.py; apps/web/prototype/dist/js/area-selection.js and field-compare.js.')
    ]
