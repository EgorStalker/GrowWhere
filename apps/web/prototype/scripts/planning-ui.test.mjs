import assert from 'node:assert/strict';
import test from 'node:test';
import {historicalScenarioDate,irrigationInputState,forecastOverview,agronomicRuleOverview} from '../dist/js/live-i18n.js';

test('historical crop dates retain their analysis year without becoming a future recommendation',()=>{
  assert.equal(historicalScenarioDate('cotton',2025,2026),'2025-04-20');
  assert.equal(historicalScenarioDate('corn','2024',2026),'2024-05-01');
  for(const year of [2027,1983,NaN,Infinity,true,'',null]){
    assert.equal(historicalScenarioDate('cotton',year,2026),null);
  }
  assert.equal(historicalScenarioDate('unknown',2025,2026),null);
});

test('available irrigation without an amount does not confirm or invent additional water',()=>{
  for(const value of ['',null,undefined,'  ']){
    assert.deepEqual(irrigationInputState('yes',value),{
      valid:true,amountMm:0,known:false,source:'unknown'
    });
  }
});

test('explicit amounts including zero retain the user scenario exactly',()=>{
  for(const amount of [0,150,300,450,5000]){
    assert.deepEqual(irrigationInputState('yes',String(amount)),{
      valid:true,amountMm:amount,known:true,source:'user'
    });
  }
});

test('rainfed and unknown modes ignore leftover irrigation amounts',()=>{
  assert.deepEqual(irrigationInputState('no','250'),{
    valid:true,amountMm:0,known:true,source:'rainfed'
  });
  for(const mode of ['unknown',null,undefined]){
    assert.deepEqual(irrigationInputState(mode,'250'),{
      valid:true,amountMm:0,known:false,source:'unknown'
    });
  }
});

test('invalid irrigation values never become confirmed water',()=>{
  for(const value of ['-1','5001','abc','Infinity',NaN]){
    assert.deepEqual(irrigationInputState('yes',value),{
      valid:false,amountMm:0,known:false,source:'unknown'
    });
  }
});

test('forecast overview only summarizes unexpired periods in the next 24 hours',()=>{
  const now=Date.parse('2026-11-14T12:00:00Z');
  const forecast={available:true,data:{issued_at:'2026-11-14T11:00:00Z',valid_to:'2026-11-21T12:00:00Z',periods:[
    {start:'2026-11-14T10:00:00Z',end:'2026-11-14T11:00:00Z',air_temperature_c:-30,precipitation_probability_pct:100},
    {start:'2026-11-14T12:00:00Z',end:'2026-11-14T13:00:00Z',air_temperature_c:0,precipitation_probability_pct:0},
    {start:'2026-11-14T13:00:00Z',end:'2026-11-14T14:00:00Z',air_temperature_c:10,precipitation_probability_pct:null},
    {start:'2026-11-16T12:00:00Z',end:'2026-11-16T13:00:00Z',air_temperature_c:40,precipitation_probability_pct:100}
  ]}};
  assert.deepEqual(forecastOverview(forecast,now),{
    periodCount:2,temperatureRangeC:[0,10],maxRainProbabilityPct:0,
    issuedAt:'2026-11-14T11:00:00Z',validTo:'2026-11-21T12:00:00Z'
  });
  assert.equal(forecastOverview({...forecast,available:false},now),null);
  assert.equal(forecastOverview(forecast,Date.parse('2026-11-22')),null);
});

test('missing precipitation probability is not displayed as zero chance of rain',()=>{
  const summary=forecastOverview({available:true,data:{periods:[{
    start:'2026-11-14T12:00:00Z',end:'2026-11-14T13:00:00Z',air_temperature_c:null,precipitation_probability_pct:null
  }]}},Date.parse('2026-11-14T12:00:00Z'));
  assert.equal(summary.maxRainProbabilityPct,null);
  assert.equal(summary.temperatureRangeC,null);
});

test('published ranges remain ranges and a local warning is preserved',()=>{
  const summary=agronomicRuleOverview({blockers:['crop_not_recommended_by_local_guide'],rule:{
    threshold_temperature_C:null,threshold_temperature_range_C:[12.77,15.55],measurement_depth_cm:5.08,
    source_url:'https://www.riley.k-state.edu/',verified_at:'2026-11-14'
  }});
  assert.deepEqual(summary.temperatureRangeC,[12.77,15.55]);
  assert.equal(summary.localGuideDiscouragesCrop,true);
  assert.equal(summary.depthCm,5.08);
  const missing=agronomicRuleOverview({rule:{threshold_temperature_C:null,measurement_depth_cm:null}});
  assert.equal(missing.temperatureRangeC,null);
  assert.equal(missing.depthCm,null);
  assert.equal(agronomicRuleOverview({rule:null}),null);
});
