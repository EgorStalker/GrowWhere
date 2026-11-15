import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildCalculationReport,trapezoidScore,renderReportDialogHtml,FACTOR_WEIGHTS,CROP_PROFILES} from '../dist/js/report.js';
// Synthetic fixtures exercise reporting, not claims about an actual farm.
const zone=()=>({type:'Feature',geometry:{type:'Polygon',coordinates:[[[-98,38],[-97,38],[-97,39],[-98,39],[-98,38]]]},properties:{
  id:'synthetic-test-zone',center:[-97.5,38.5],soil:{ph:6.4,awc:.16,slope:3.8,sand:30,clay:25,drainage:'Well drained'},
  climate:{mean_temperature:23.5,precipitation_mm:350,crop_water_demand_mm:600,expected_days:150,heat_days:6,frost_days:0},
  result:{status:'good',score:88.2,factors:{water:.717,temperature:.933,ph:1,awc:1,drainage:1,slope:.9,texture:1},
    water_balance:{effective_rain_mm:280,irrigation_mm:150,demand_mm:600},missing:[]}}});
const context=()=>({crop:'corn',year:2025,planting:'2025-05-01',irrigationKnown:true,irrigationMm:150,selected:zone()});
test('ported trapezoid preserves zeros, shoulders and missing values',()=>{
  assert.equal(trapezoidScore(24,[8,18,30,42]),1);
  assert.equal(trapezoidScore(13,[8,18,30,42]),.5);
  assert.equal(trapezoidScore(36,[8,18,30,42]),.5);
  assert.equal(trapezoidScore(8,[8,18,30,42]),0);
  assert.equal(trapezoidScore(null,[8,18,30,42]),null);
  assert.equal(trapezoidScore(false,[8,18,30,42]),null);
});
test('point report preserves the recorded score and reconstructs all available factors',()=>{
  const r=buildCalculationReport(context());
  assert.equal(r.factorSteps.length,7);assert.equal(r.reportedScore,88.2);
  assert.ok(Math.abs(r.factorSteps.find(s=>s.key==='water').computed-430/600)<1e-9);
  assert.ok(Math.abs(r.factorSteps.find(s=>s.key==='temperature').computed-(1-6/90))<1e-9);
  assert.equal(r.historicalWater.deficitMm,170);
  assert.equal(r.aggregation.mode,'point');assert.ok(r.aggregation.geometricMean>88&&r.aggregation.geometricMean<89);
  assert.equal(Object.values(FACTOR_WEIGHTS).reduce((a,b)=>a+b,0),1);
});
test('five-point cell average is never replaced by a nonlinear score from average factors',()=>{
  const c=context();c.selected.properties.result.score=79.4;c.selected.properties.result.uncertainty={sample_count:5,scored_samples:5};
  const r=buildCalculationReport(c);assert.equal(r.reportedScore,79.4);assert.equal(r.isGridAggregate,true);
  assert.equal(r.aggregation.mode,'sample_mean');assert.equal(r.aggregation.geometricMean,null);
  assert.ok(r.factorSteps.every(s=>s.computed===null));assert.match(r.factorSteps[0].substituted,/not retained/);
});
test('field aggregation retains stored zone weights and unknown zones block the report score',()=>{
  const c=context();c.selected=null;c.areaSummary={status:'good',score:88,areaHa:10,totalCount:2,scoredCount:1,
    counts:{good:1,unknown:1},avgFactors:zone().properties.result.factors,intersectingFeatures:[zone()],missingKeys:['soil']};
  const r=buildCalculationReport(c);assert.equal(r.reportedScore,null);assert.equal(r.status,'unknown');
  assert.equal(r.areaBreakdown.coveragePct,null);assert.equal(r.zoneTrace.length,1);
  assert.ok(r.zoneTrace[0].areaWeight>0);assert.equal(r.aggregation.computedFinalScore,null);
});
test('unknown irrigation reconstructs the explicit lower bound and missing days are not invented',()=>{
  const c=context();c.irrigationKnown=false;c.irrigationMm=450;delete c.selected.properties.climate.heat_days;
  const r=buildCalculationReport(c);assert.equal(r.header.irrigationMm,0);
  assert.ok(Math.abs(r.factorSteps.find(s=>s.key==='water').computed-280/600)<1e-9);
  assert.equal(r.factorSteps.find(s=>s.key==='temperature').computed,null);
});
test('zero factor is serializable and activates the zero-score rule without ln(0)',()=>{
  const c=context();c.selected.properties.result.factors.ph=0;c.selected.properties.result.status='poor';c.selected.properties.result.score=0;
  const r=buildCalculationReport(c);assert.equal(r.reportedScore,0);assert.equal(r.aggregation.computedFinalScore,0);
  assert.ok(r.aggregation.hasZeroFactor);assert.doesNotThrow(()=>JSON.stringify(r));
});
test('report HTML escapes user labels and retains stale source warnings',()=>{
  const c=context();c.cropName='<img src=x onerror=alert(1)>';c.meta={stale:true,product_id:'p1',version_key:'version'};
  const r=buildCalculationReport(c),html=renderReportDialogHtml(r);
  assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img src=x'));
  assert.match(html,/awaiting a refresh/);assert.equal(r.provenance.productId,'p1');
  assert.match(html,/data-action="download-report-pdf"/);
});
test('profile schema includes every selectable crop and is data for the current method',()=>{
  assert.deepEqual(Object.keys(CROP_PROFILES),['wheat','soy','corn','sorghum','barley','oats','cotton']);
});
test('report crop parameters match the numerical engine rather than a separate method',()=>{
  const source=fs.readFileSync(new URL('../../../../data/pipelines/growwhere/analysis.py',import.meta.url),'utf8');
  const literal=source.match(/^PROFILES = (\{[\s\S]*?^\})/m)[1];
  const profiles=JSON.parse(literal.replaceAll("'",'"').replace(/,\s*([}\]])/g,'$1'));
  for(const [crop,profile] of Object.entries(CROP_PROFILES))for(const [key,value] of Object.entries(profile)){
    assert.deepEqual(value,profiles[crop][key],`${crop}.${key}`);
  }
});
