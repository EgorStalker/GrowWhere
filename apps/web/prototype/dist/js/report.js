// Adapted from GitHub 5d4681c report.js. Recorded map values remain authoritative.
import {tr} from './live-i18n.js';
import {geometryAreaSqMeters} from './area-selection.js';

export const METHOD_VERSION='growwhere-screening-0.2';
export const FACTOR_WEIGHTS={temperature:.20,water:.30,ph:.15,awc:.10,drainage:.10,slope:.10,texture:.05};
export const CROP_PROFILES={
  wheat:{stages:[20,25,60,30],kc:[.3,1.15,.3],temperature:[0,12,24,36],ph:[4.5,5.5,7,8.5],frost:-3,heat:35},
  soy:{stages:[20,35,60,25],kc:[.4,1.15,.5],temperature:[8,20,30,40],ph:[4.5,6,7,8.5],frost:0,heat:36},
  corn:{stages:[30,40,50,30],kc:[.3,1.2,.35],temperature:[8,18,30,42],ph:[4.5,6,7,8.5],frost:0,heat:36},
  sorghum:{stages:[20,35,45,30],kc:[.3,1.05,.55],temperature:[10,20,32,43],ph:[5,5.8,7.5,8.5],frost:0,heat:39},
  barley:{stages:[20,25,50,30],kc:[.3,1.15,.25],temperature:[0,11,23,36],ph:[5,6,7.8,8.5],frost:-3,heat:35},
  oats:{stages:[20,30,50,30],kc:[.3,1.15,.25],temperature:[0,10,22,35],ph:[4.5,5.5,7.2,8.2],frost:-3,heat:34},
  cotton:{stages:[30,50,55,45],kc:[.35,1.18,.6],temperature:[12,22,33,44],ph:[5,5.8,7.8,8.5],frost:0,heat:39}
};
export const DRAINAGE_SCORES={'Excessively drained':.65,'Somewhat excessively drained':.8,'Well drained':1,'Moderately well drained':.85,'Somewhat poorly drained':.55,'Poorly drained':.25,'Very poorly drained':0};
export const FACTOR_FORMULAS={
  temperature:'f_temperature = trap(T_mean; a,b,c,d) * clamp(1-H/(D*0.6)) * clamp(1-F/(D*0.15))',
  water:'f_water = clamp((0.8 * P_mm + I_mm) / ETc_mm)',
  ph:'f_ph = trap(pH; a,b,c,d)',awc:'f_awc = clamp(AWC / 0.15)',
  drainage:'f_drainage = drainage_table[drainage_class]',
  slope:'f_slope = 1 if slope_pct <= 2; otherwise clamp((20-slope_pct)/18)',
  texture:'f_texture = min(1, clamp((95-sand_pct)/20), clamp((75-clay_pct)/25))'
};
export const number=value=>typeof value==='boolean'||value===null||value===undefined||value===''||!Number.isFinite(Number(value))?null:Number(value);
export const display=(value,digits=3)=>number(value)===null?'No data':Number(value).toLocaleString('en-US',{maximumFractionDigits:digits});
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp=x=>Math.max(0,Math.min(1,x));
export function trapezoidScore(value,[a,b,c,d]){
  const x=number(value);if(x===null)return null;
  return x<=a||x>=d?0:x>=b&&x<=c?1:x<b?(x-a)/(b-a):(d-x)/(d-c);
}
function factorStep(key,recorded,soil,climate,profile,water,aggregate){
  const f=number(recorded);let computed=null,inputsText='',substituted='Input values are not available in this snapshot.';
  const D=number(climate?.expected_days),T=number(climate?.mean_temperature),H=number(climate?.heat_days),F=number(climate?.frost_days);
  if(key==='water'){
    const P=number(climate?.precipitation_mm),ETc=number(climate?.crop_water_demand_mm);
    inputsText=`P=${display(P,1)} mm; I=${display(water.amount,1)} mm (${water.known?'user scenario':'unconfirmed; lower-bound scenario'}); ETc=${display(ETc,1)} mm`;
    if(P!==null&&ETc>0)computed=clamp((.8*P+water.amount)/ETc);
  }else if(key==='temperature'){
    inputsText=`T=${display(T,2)} C; H=${display(H,0)}; F=${display(F,0)}; D=${display(D,0)}; bounds=${profile.temperature.join(', ')}`;
    if(T!==null&&H!==null&&F!==null&&D>0)computed=trapezoidScore(T,profile.temperature)*clamp(1-H/(D*.6))*clamp(1-F/(D*.15));
  }else if(key==='ph'){
    inputsText=`pH=${display(soil?.ph)}; bounds=${profile.ph.join(', ')}`;
    computed=trapezoidScore(soil?.ph,profile.ph);
  }else if(key==='awc'){
    inputsText=`AWC=${display(soil?.awc)} cm/cm`;if(number(soil?.awc)!==null)computed=clamp(Number(soil.awc)/.15);
  }else if(key==='drainage'){
    inputsText=`Drainage class: ${soil?.drainage||'No data'}`;computed=number(DRAINAGE_SCORES[soil?.drainage]);
  }else if(key==='slope'){
    inputsText=`Slope=${display(soil?.slope)}%`;if(number(soil?.slope)!==null)computed=soil.slope<=2?1:clamp((20-soil.slope)/18);
  }else{
    inputsText=`Sand=${display(soil?.sand)}%; clay=${display(soil?.clay)}%`;
    if(number(soil?.sand)!==null&&number(soil?.clay)!==null)computed=Math.min(1,clamp((95-soil.sand)/20),clamp((75-soil.clay)/25));
  }
  if(aggregate){
    computed=null;inputsText='Aggregated observations: a single averaged input cannot reproduce the original nonlinear point calculations.';
    substituted=`Stored aggregate f_${key} = ${display(f)}. Individual sample inputs are not retained in this product.`;
  }else if(computed!==null)substituted=`${inputsText}; reconstructed f_${key} = ${display(computed,6)}; stored f_${key} = ${display(f)}.`;
  const weight=FACTOR_WEIGHTS[key];
  return {key,label:tr(`factorNames.${key}`,key),weight,weightPct:weight*100,score:f,computed,
    formulaTemplate:FACTOR_FORMULAS[key],inputsText,substituted,
    weightedLog:!aggregate&&f>0?weight*Math.log(f):null,
    logText:aggregate?'Not reconstructed for aggregate data':f===null?'No contribution available':f===0?'Known zero: score is 0; ln(0) is not evaluated':`${weight} * ln(${display(f)}) = ${display(weight*Math.log(f),6)}`};
}
function waterBalance(wb,known){
  if(!wb)return null;
  const R=number(wb.effective_rain_mm),I=number(wb.irrigation_mm),E=number(wb.demand_mm);
  if(R===null||I===null||E===null)return null;
  return {effectiveRainMm:R,irrigationMm:I,irrigationKnown:known,demandMm:E,totalSupplyMm:R+I,
    balanceMm:R+I-E,deficitMm:Math.max(0,E-R-I),
    formulaText:`Balance = (0.8*P + I) - ETc = (${display(R,1)} + ${display(I,1)}) - ${display(E,1)} = ${display(R+I-E,1)} mm. Deficit = max(0, -Balance).`};
}
export function buildCalculationReport(context={}){
  const {crop,year,planting,selected,areaSummary,meta={},insights,planning,economics}=context;
  const profile=CROP_PROFILES[crop];if(!profile)throw Error('Select a supported crop before creating a report.');
  const p=selected?.properties||{},result=p.result||{},isAreaAggregate=!selected&&!!areaSummary;
  const isGridAggregate=!isAreaAggregate&&Number(result.uncertainty?.sample_count)>1;
  const factors=isAreaAggregate?areaSummary.avgFactors||{}:result.factors||{};
  const missingList=[...new Set(isAreaAggregate?areaSummary.missingKeys||[]:result.missing||[])];
  let status=(isAreaAggregate?areaSummary.status:result.status)||'unknown';
  let reportedScore=number(isAreaAggregate?areaSummary.score:result.score);
  if(isAreaAggregate&&areaSummary.counts?.unknown>0)status='unknown';
  if(!['good','conditional','poor'].includes(status)||missingList.length)reportedScore=null;
  const water={amount:context.irrigationKnown?(number(context.irrigationMm)??0):0,known:context.irrigationKnown===true};
  const steps=Object.keys(FACTOR_WEIGHTS).map(key=>factorStep(key,factors[key],p.soil,p.climate,profile,water,isAreaAggregate||isGridAggregate));
  const all=steps.every(s=>s.score!==null),zero=steps.some(s=>s.score===0);
  const sum=all&&!zero?steps.reduce((s,f)=>s+f.weightedLog,0):null;
  const G=all?(zero?0:100*Math.exp(sum)):null;
  const min=all?Math.min(...steps.map(s=>s.score)):null;
  const native=!isAreaAggregate&&!isGridAggregate;
  const sourceFeatures=selected?[selected]:areaSummary?.intersectingFeatures||[];
  const zoneTrace=sourceFeatures.map(f=>({id:String(f.properties?.id??f.id??''),score:number(f.properties?.result?.score),
    status:f.properties?.result?.status||'unknown',areaWeight:Math.max(1,geometryAreaSqMeters(f.geometry)),
    factors:f.properties?.result?.factors||{},uncertainty:f.properties?.result?.uncertainty||null,missing:f.properties?.result?.missing||[]}));
  const sources=meta.source_snapshots||sourceFeatures.flatMap(f=>f.properties?.source_meta||[]);
  const sourceSnapshots=[...new Map(sources.map(s=>[`${s.id}|${s.sha256}`,s])).values()];
  const aggregationMode=isAreaAggregate?'area_weighted':isGridAggregate?'sample_mean':'point';
  const limitation='Research screening without field calibration. Climate resolution is about 55 km. Polygon detail does not improve observation resolution. No sowing-date or irrigation recommendation.';
  return {schemaVersion:'growwhere-report-1',header:{title:'GrowWhere calculation report',generatedAt:context.generatedAt||new Date().toISOString(),
    methodVersion:meta.method||METHOD_VERSION,crop,cropName:context.cropName||tr(`cropNames.${crop}`,crop),year,planting,
    irrigationMode:context.irrigationMode,irrigationMm:water.amount,irrigationKnown:water.known,targetYear:context.targetYear||null,
    mode:context.mode||'own_land',scopeType:selected?'zone':'area',
    scopeLabel:selected?(p.ui_label||String(p.id||'Selected map zone')):`Selected boundary (${display(areaSummary?.areaHa,1)} ha)`,
    coordinates:p.center||context.coordinates||null,scaleHa:number(context.scaleHa)},profile,status,statusLabel:tr(`statuses.${status}`,status),
    reportedScore,isAreaAggregate,isGridAggregate,factorSteps:steps,
    aggregation:{mode:aggregationMode,allSevenScored:all,hasZeroFactor:zero,sumWeightedLog:native?sum:null,
      geometricMean:native?G:null,minFactorValue:native?min:null,criticalCeilingApplied:native&&min!==null&&min<.1,
      ceilingValue:native&&min!==null&&min<.1?100*Math.sqrt(min):null,
      computedFinalScore:native&&G!==null?(min<.1?Math.min(G,100*Math.sqrt(min)):G):null,
      formulaGeometric:'G = 100 * exp(sum(w_i * ln(f_i)))',
      formulaCeiling:'If min(f_i) < 0.10: S = min(G, 100 * sqrt(min(f_i))); otherwise S = G. Known zero -> S = 0.',
      formulaApplied:isAreaAggregate?'S_area = round(sum(S_j * A_j) / sum(A_j)); A_j = max(1 m2, full area of intersecting scored zone j). Any unknown zone -> No data.':
        isGridAggregate?'S_cell = round(mean(S_k), 1) over scored samples; any unknown sample -> No data. Mean factors do not reproduce this nonlinear result.':'The seven-factor formula is applied at this observation point.'},
    historicalWater:waterBalance(isAreaAggregate?areaSummary.avgWaterBalance:result.water_balance,water.known),
    areaBreakdown:isAreaAggregate?{areaHa:areaSummary.areaHa,totalCount:areaSummary.totalCount,scoredCount:areaSummary.scoredCount,
      counts:areaSummary.counts,coveragePct:null,coverageNote:'Geometric coverage percentage is not calculated. Whole intersecting zones supply approximate weights; zones are not clipped to the field boundary.'}:null,
    zoneTrace,landcover:p.landcover||null,soil:p.soil||null,climate:p.climate||null,
    provenance:{productId:meta.product_id||null,versionKey:meta.version_key||null,sourceSnapshot:meta.source_snapshot||null,
      publishedAt:meta.published_at||null,expiresAt:meta.expires_at||null,stale:meta.stale===true,nativeZoom:meta.native_zoom??null,sourceSnapshots},
    economics:economics||null,planning:{criticalGaps:planning?.critical_gaps||[]},
    fiveYear:{landcoverHistory:insights?.landcover_history||null,climateRisk:insights?.climate_risk||null},
    missingList,limitations:[limitation,'Prepared numerical coverage is currently limited to the Kansas pilot.',
      'Daily ET0 inputs and individual grid sample inputs are not all present in the prepared snapshot. Equations are documented without fabricated substitutions.',
      'Rounded stored factors may cause small differences in a reconstructed point score.'],
    verdictText:reportedScore===null?'No numerical suitability conclusion is available for this selection.':`Historical suitability: ${display(reportedScore,1)} / 100 (${tr(`statuses.${status}`,status)}). This is a screening estimate.`};
}
export function renderReportDialogHtml(report){
  const e=escapeHtml,h=report.header;
  return `<div class="report-doc"><div class="report-toolbar"><button type="button" class="primary" data-action="download-report-pdf">Download PDF</button><span id="report-download-status" role="status"></span></div>
    <p>${e(h.cropName)} · ${e(h.year)} historical season · ${e(h.scopeLabel)}</p>
    <p class="report-verdict">${e(report.verdictText)}</p>
    <p class="report-note">The PDF includes every calculation equation, crop parameters, source versions and available numerical substitutions.</p>
    <div class="formula-math">${e(report.aggregation.formulaApplied)}</div>
    <details><summary>Seven suitability factors</summary><div class="report-table-wrap"><table class="formula-table"><thead><tr><th>Factor</th><th>Weight</th><th>Stored value</th><th>Formula</th></tr></thead><tbody>${report.factorSteps.map(s=>`<tr><td>${e(s.label)}</td><td>${s.weightPct}%</td><td>${display(s.score)}</td><td>${e(s.formulaTemplate)}</td></tr>`).join('')}</tbody></table></div></details>
    <details><summary>Data and calculation limits</summary>${report.limitations.map(s=>`<p class="report-note">${e(s)}</p>`).join('')}${report.provenance.stale?'<p class="report-warning">This saved map is awaiting a refresh.</p>':''}</details></div>`;
}
export function renderStandaloneReportDocument(report){
  return `<!DOCTYPE html><html lang="en"><meta charset="utf-8"><title>GrowWhere report</title><body><h1>GrowWhere calculation report</h1>${renderReportDialogHtml(report)}</body></html>`;
}
