// Adapted from GitHub 5d4681c. Missing values never become numerical advantages.
import {tr} from './live-i18n.js';
import {number,display,escapeHtml,FACTOR_WEIGHTS,METHOD_VERSION} from './report.js';
const clone=value=>JSON.parse(JSON.stringify(value));
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export function createFieldSnapshot(input={}){
  const report=input.report||null,header=report?.header||{};
  const status=input.status||report?.status||'unknown';
  const score=['good','conditional','poor'].includes(status)?number(input.score??report?.reportedScore):null;
  const wb=input.waterBalance||null;
  const R=number(wb?.effective_rain_mm),I=number(wb?.irrigation_mm),E=number(wb?.demand_mm);
  const geometryId=input.geometryId||JSON.stringify(input.area?.ring||input.coordinates||header.coordinates||null);
  return freeze(clone({id:geometryId,label:input.label||header.scopeLabel||'Selected field',crop:input.crop||header.crop,
    cropName:input.cropName||header.cropName||input.crop,year:input.year??header.year,planting:input.planting??header.planting??null,
    irrigationMm:number(input.irrigationMm??header.irrigationMm),irrigationKnown:input.irrigationKnown??header.irrigationKnown??null,
    irrigationLabel:input.irrigationLabel||'Irrigation unspecified',method:input.method||header.methodVersion||METHOD_VERSION,
    areaHa:number(input.areaHa),coordinates:input.coordinates||header.coordinates||null,status,statusLabel:tr(`statuses.${status}`,status),
    score,factors:input.factors||Object.fromEntries((report?.factorSteps||[]).map(s=>[s.key,s.score])),
    waterBalance:R!==null&&I!==null&&E!==null?{effectiveRainMm:R,irrigationMm:I,demandMm:E,deficitMm:Math.max(0,E-R-I)}:null,
    capturedAt:input.capturedAt||new Date().toISOString(),area:input.area||null,report}));
}
const advantage=(a,b,lower=false,epsilon=.01)=>a===null||b===null?null:Math.abs(a-b)<=epsilon?'tie':((a>b)!==lower?'A':'B');
export function compareTwoFields(fieldA,fieldB){
  if(!fieldA||!fieldB)throw Error('Select two fields to compare.');
  const scenarioKeys=['crop','year','planting','irrigationMm','irrigationKnown','method'];
  const different=scenarioKeys.filter(k=>String(fieldA[k])!==String(fieldB[k]));
  const scopeWarning=different.length?`Different scenarios (${different.join(', ')}). Use the same crop, season, reference date, irrigation and method for a direct comparison.`:null;
  const rows=[{key:'score',label:'Suitability index / 100',valueA:fieldA.score,valueB:fieldB.score,unit:'',epsilon:.5},
    ...Object.keys(FACTOR_WEIGHTS).map(key=>({key,label:`${tr(`factorNames.${key}`,key)} (${FACTOR_WEIGHTS[key]*100}%)`,valueA:number(fieldA.factors[key]),valueB:number(fieldB.factors[key]),unit:'factor'})),
    {key:'deficit',label:'Seasonal water deficit',valueA:number(fieldA.waterBalance?.deficitMm),valueB:number(fieldB.waterBalance?.deficitMm),unit:'mm',lower:true,epsilon:5}]
    .map(row=>({...row,winner:advantage(number(row.valueA),number(row.valueB),row.lower,row.epsilon),
      valueA:number(row.valueA)===null?'No data':row.unit==='factor'?`${display(row.valueA*100,1)}%`:`${display(row.valueA,1)} ${row.unit}`.trim(),
      valueB:number(row.valueB)===null?'No data':row.unit==='factor'?`${display(row.valueB*100,1)}%`:`${display(row.valueB,1)} ${row.unit}`.trim()}));
  const overallWinner=scopeWarning?null:advantage(fieldA.score,fieldB.score,false,.5);
  const verdict=scopeWarning?'The fields describe different scenarios; no overall preference is assigned.':
    overallWinner===null?'A complete score is missing for at least one field; no overall preference is available.':
    overallWinner==='tie'?'The recorded scores are close (difference at most 0.5 points).':
    `Field ${overallWinner} has the higher recorded suitability score for the same scenario. This is not a yield or profit prediction.`;
  return {fieldA,fieldB,rows,scopeWarning,overallWinner,verdict,scoreDelta:fieldA.score!==null&&fieldB.score!==null?fieldB.score-fieldA.score:null,
    winsA:rows.filter(r=>r.winner==='A').length,winsB:rows.filter(r=>r.winner==='B').length,ties:rows.filter(r=>r.winner==='tie').length};
}
export function renderFieldCompareDialogHtml(cmp){
  const e=escapeHtml;
  const card=(f,tag)=>`<article class="compare-field-card"><span class="compare-tag">Field ${tag}</span><h3>${e(f.label)}</h3><p>${e(f.cropName)} · ${e(f.year)} · ${e(f.irrigationLabel)}</p><strong>${display(f.score,1)}${f.score!==null?' / 100':''}</strong><p>${e(f.statusLabel)}${f.areaHa!==null?` · ${display(f.areaHa,1)} ha`:''}</p></article>`;
  return `<div class="report-doc"><div class="compare-fields-top">${card(cmp.fieldA,'A')}${card(cmp.fieldB,'B')}</div>
    ${cmp.scopeWarning?`<p class="report-warning">${e(cmp.scopeWarning)}</p>`:''}<p class="report-verdict">${e(cmp.verdict)}</p>
    <div class="report-table-wrap"><table class="formula-table"><thead><tr><th>Measure</th><th>Field A</th><th>Field B</th><th>Row advantage</th></tr></thead><tbody>${cmp.rows.map(r=>`<tr><td>${e(r.label)}</td><td>${e(r.valueA)}</td><td>${e(r.valueB)}</td><td>${r.winner===null?'No data':r.winner==='tie'?'Close':`Field ${r.winner}`}</td></tr>`).join('')}</tbody></table></div>
    <p class="report-note">Factors overlap in meaning; row advantages are not independent votes for an optimal field. Both fields inherit the scale and limits of the source data.</p>
    <div class="report-toolbar"><button type="button" class="primary" data-action="download-comparison-pdf">Download comparison PDF</button><button type="button" class="secondary" data-action="swap-compare-fields">Swap A / B</button><button type="button" class="secondary" data-action="close-dialog">Close</button><span id="report-download-status" role="status"></span></div></div>`;
}
