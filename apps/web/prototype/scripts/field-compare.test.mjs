import test from 'node:test';
import assert from 'node:assert/strict';
import {createFieldSnapshot,compareTwoFields,renderFieldCompareDialogHtml} from '../dist/js/field-compare.js';
const field=(extra={})=>createFieldSnapshot({label:'Synthetic test field',geometryId:'test-a',crop:'corn',cropName:'Corn',year:2025,
  planting:'2025-05-01',irrigationMm:150,irrigationKnown:true,status:'good',score:80,factors:{water:.8,temperature:.9},...extra});
test('ported comparison selects the higher recorded score within a common scenario',()=>{
  const c=compareTwoFields(field(),field({geometryId:'test-b',score:60,status:'conditional',factors:{water:.5}}));
  assert.equal(c.overallWinner,'A');assert.equal(c.scoreDelta,-20);assert.equal(c.scopeWarning,null);
});
test('missing factors and missing water values never become zero advantages',()=>{
  const c=compareTwoFields(field(),field({score:null,status:'unknown',factors:{water:null}}));
  assert.equal(c.overallWinner,null);
  const water=c.rows.find(r=>r.key==='water');assert.equal(water.valueB,'No data');assert.equal(water.winner,null);
  const drainage=c.rows.find(r=>r.key==='drainage');assert.equal(drainage.winner,null);
});
test('different crop, season, date, water amount, known status or method prevents an overall preference',()=>{
  for(const change of [{crop:'soy'},{year:2024},{planting:'2025-06-01'},{irrigationMm:300},{irrigationKnown:false},{method:'different'}]){
    const c=compareTwoFields(field(),field(change));assert.equal(c.overallWinner,null);assert.ok(c.scopeWarning);
  }
});
test('field snapshots preserve nested values after the active field changes',()=>{
  const factors={water:.8},area={ring:[[0,0],[1,0],[1,1],[0,0]]};
  const a=field({factors,area});factors.water=.1;area.ring[0][0]=9;
  assert.equal(a.factors.water,.8);assert.equal(a.area.ring[0][0],0);
  assert.throws(()=>{a.factors.water=.2;},TypeError);
});
test('distinct boundaries at one reference point retain distinct field identities',()=>{
  const a=field({geometryId:'ring-a',coordinates:[-98,38]}),b=field({geometryId:'ring-b',coordinates:[-98,38]});
  assert.notEqual(a.id,b.id);
});
test('close scores produce no artificial preference; the comparison escapes labels',()=>{
  const c=compareTwoFields(field({label:'<script>alert(1)</script>'}),field({score:80.4}));
  assert.equal(c.overallWinner,'tie');const html=renderFieldCompareDialogHtml(c);
  assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
  assert.match(html,/download-comparison-pdf/);
});
