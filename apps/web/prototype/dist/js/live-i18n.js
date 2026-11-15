// Ukrainian first. A later English dictionary can use these same keys.
export const locale = 'en-US';
export const copy = {
  brandTag:'Your land. A clearer choice.', title:'What to grow. Where to grow it.',
  stepNames:['Start','Area','Crop','Conditions','Results'],
  cropNames:{wheat:'Spring wheat',soy:'Soybeans',corn:'Corn',sorghum:'Sorghum',barley:'Spring barley',oats:'Oats',cotton:'Cotton'},
  cropDefaults:{wheat:'03-15',soy:'05-01',corn:'05-01',sorghum:'05-15',barley:'03-15',oats:'03-15',cotton:'04-20'},
  planningReadiness:{
    title:'Historical screening, not a future farming plan',
    sowing:'Future sowing date: insufficient data.',
    irrigation:'Recommended irrigation: insufficient data.',
    reason:'Advice requires complete verified inputs: forecast, current soil temperature and moisture, and local agronomic rules. The historical calendar is not advice for a new season.'
  },
  cropNotes:{
    wheat:{season:'135 days',temp:'12–24 °C',note:'Early-season crop; sensitive to prolonged heat > 35 °C.'},
    soy:{season:'140 days',temp:'20–30 °C',note:'Warm-season oilseed and legume.'},
    corn:{season:'150 days',temp:'18–30 °C',note:'High water demand; can respond strongly to irrigation in dry areas.'},
    sorghum:{season:'130 days',temp:'20–32 °C',note:'Drought- and heat-tolerant grain crop (model heat threshold: 39 °C).'},
    barley:{season:'125 days',temp:'11–23 °C',note:'Early-maturing spring cereal; heat exposure depends on local conditions.'},
    oats:{season:'130 days',temp:'10–22 °C',note:'Prefers a cooler start and moderate moisture.'},
    cotton:{season:'180 days',temp:'22–33 °C',note:'Requires a long warm season; USDA ERS reports cotton prices per pound.'}
  },
  statuses:{good:'Suitable',conditional:'Limited',poor:'Unsuitable',unknown:'No data',excluded:'Outside analysis'},
  statusInfo:{
    good:'Available data and the selected scenario indicate favorable conditions.',
    conditional:'The model indicates constraints. Check which factors limit this result.',
    poor:'One or more factors substantially limit suitability under the selected scenario.',
    unknown:'Required inputs are missing. This does not mean the land is unsuitable.',
    excluded:'USDA CDL identifies excluded cover at the sample point, such as water, built-up land, forest, wetland or snow. Suitability analysis is paused for this zone.'
  },
  factorNames:{temperature:'Temperature conditions',water:'Water availability',ph:'Soil acidity',awc:'Soil water storage',drainage:'Drainage',slope:'Slope',texture:'Soil texture'},
  missingNames:{climate:'NASA weather',climate_coordinates:'Climate sample coordinates',complete_season:'Complete weather season',soil:'USDA soil data',soil_0_30cm:'Complete 0–30 cm soil profile',temperature:'Temperature conditions',water:'Water balance',ph:'Soil acidity',awc:'Soil water retention',drainage:'Drainage',slope:'Slope',texture:'Soil texture',landcover:'USDA CDL land cover'},
  landcoverCategories:{cropland:'Cropland',pasture:'Pasture and grassland',water:'Water',urban:'Built-up land',forest:'Forest',wetland:'Wetland',snow:'Snow or ice',other:'Other cover',unknown:'No data'},
  irrigationNames:{no:'No irrigation',yes:'Irrigation available',unknown:'Not sure yet'},
  drainageNames:{'Excessively drained':'Excessively drained','Somewhat excessively drained':'Somewhat excessively drained','Well drained':'Well drained','Moderately well drained':'Moderately well drained','Somewhat poorly drained':'Somewhat poorly drained','Poorly drained':'Poorly drained','Very poorly drained':'Very poorly drained'}
};
export const tr = (key, fallback='') => key.split('.').reduce((value,part)=>value?.[part],copy) ?? fallback;
export const fmt = (number,digits=0) => Number.isFinite(Number(number)) && number!==null && number!=='' ? new Intl.NumberFormat(locale,{maximumFractionDigits:digits}).format(Number(number)) : 'No data';
export function dateTime(value) {
  if(!value || Number.isNaN(Date.parse(value))) return 'Not yet retrieved';
  return new Intl.DateTimeFormat(locale,{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
}

// Presentation guards shared with the form. These preserve the distinction
// between a historical scenario and an evidence-backed future recommendation.
export function historicalScenarioDate(crop, year, asOfYear=new Date().getUTCFullYear()) {
  const numericYear=Number(year);
  if(typeof year==='boolean'||!Number.isInteger(numericYear)||numericYear<1984||numericYear>asOfYear||!copy.cropDefaults[crop])return null;
  return `${numericYear}-${copy.cropDefaults[crop]}`;
}

export function irrigationInputState(mode, value) {
  const supplied=value!==null&&value!==undefined&&String(value).trim()!=='';
  const amount=Number(value);
  const valid=mode!=='yes'||!supplied||(Number.isFinite(amount)&&amount>=0&&amount<=5000);
  return {
    valid,
    amountMm:valid&&mode==='yes'&&supplied?amount:0,
    known:valid&&(mode==='no'||(mode==='yes'&&supplied)),
    source:mode==='no'?'rainfed':mode==='yes'&&supplied&&valid?'user':'unknown'
  };
}

export function forecastOverview(forecast, now=Date.now()) {
  if(forecast?.available!==true||!forecast.data)return null;
  const periods=(forecast.data.periods||[]).filter(period=>
    Number.isFinite(Date.parse(period.start))&&Number.isFinite(Date.parse(period.end))&&
    Date.parse(period.end)>now&&Date.parse(period.start)<now+24*60*60*1000
  );
  if(!periods.length)return null;
  const temperatures=periods.map(period=>period.air_temperature_c).filter(value=>typeof value==='number'&&Number.isFinite(value));
  const rainProbabilities=periods.map(period=>period.precipitation_probability_pct).filter(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100);
  return {
    periodCount:periods.length,
    temperatureRangeC:temperatures.length?[Math.min(...temperatures),Math.max(...temperatures)]:null,
    maxRainProbabilityPct:rainProbabilities.length?Math.max(...rainProbabilities):null,
    issuedAt:forecast.data.issued_at,
    validTo:forecast.data.valid_to
  };
}

export function agronomicRuleOverview(registry) {
  const rule=registry?.rule;
  if(!rule)return null;
  const numeric=value=>typeof value==='number'&&Number.isFinite(value);
  const range=rule.threshold_temperature_range_C;
  const temperatureRangeC=Array.isArray(range)&&range.length===2&&range.every(numeric)&&range[0]<=range[1]
    ?range:numeric(rule.threshold_temperature_C)?[rule.threshold_temperature_C,rule.threshold_temperature_C]:null;
  return {
    temperatureRangeC,
    depthCm:numeric(rule.measurement_depth_cm)?rule.measurement_depth_cm:null,
    localGuideDiscouragesCrop:registry.blockers?.includes('crop_not_recommended_by_local_guide')||false,
    sourceUrl:rule.source_url,
    verifiedAt:registry.verified_at||rule.verified_at||null
  };
}
