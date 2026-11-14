import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crops,zones,suitability,budgetStatus,regions} from '../dist/js/model.js';
import {t} from '../dist/js/i18n.js';

test('missing zone measurements stay unknown for every crop and irrigation choice',()=>{
  for(const crop of crops) for(const water of ['yes','no','unknown']) assert.equal(suitability(crop.id,'south',water),'unknown');
});
test('irrigation changes a water-limited example but an unknown answer never assumes irrigation',()=>{
  assert.equal(suitability('wheat','northwest','no'),'conditional');
  assert.equal(suitability('wheat','northwest','yes'),'good');
  assert.equal(suitability('wheat','northwest','unknown'),'conditional');
});
test('unknown budget is different from zero or a known cost comparison',()=>{
  for(const value of ['',null,'abc',0,-1]) assert.equal(budgetStatus(920,value),null);
  assert.equal(budgetStatus(920,920),'fit');
  assert.equal(budgetStatus(920,800),'over');
});
test('all supported crops and zones have Ukrainian names; only one of eight regions is active',()=>{
  assert.equal(regions.length,8);assert.equal(regions.filter(r=>r.active).length,1);
  for(const crop of crops) assert.notEqual(t('cropNames.'+crop.id),'cropNames.'+crop.id);
  assert.equal(t('zoneNames').length,zones.length);
  for(const crop of crops) for(const zone of zones) assert.ok(['good','conditional','poor','unknown'].includes(suitability(crop.id,zone.id)));
});
