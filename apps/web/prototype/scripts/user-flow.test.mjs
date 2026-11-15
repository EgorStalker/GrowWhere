import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTerritory,validateConditions,validateScale,canEnterStep,canAdvance,planningContext} from '../dist/js/user-flow.js';

const ring=[[-98,38],[-97.99,38],[-97.99,38.01],[-98,38.01],[-98,38]];
const own=()=>({step:2,mode:'own_land',customArea:{ring:structuredClone(ring)},crop:'corn',irrigation:'unknown',water:'',year:2025,planting:'2025-05-01',targetYear:'',scaleHa:'999999'});
const search=()=>({...own(),mode:'find_land',customArea:null,searchRegion:'kansas',scaleHa:'25'});

test('land-first gates block stale progress and require explicit mode selection',()=>{
  const state={...own(),mode:null,customArea:null,maxStep:5};
  assert.equal(canEnterStep(state,1),true);
  for(const step of [2,3,4,5])assert.equal(canEnterStep(state,step),false);
  state.mode='own_land';
  assert.equal(canEnterStep(state,2),true);
  assert.equal(canEnterStep(state,3),false);
  state.customArea=own().customArea;
  assert.equal(canAdvance(state),true);
  state.crop=null;
  assert.equal(canEnterStep(state,3),true);
  assert.equal(canEnterStep(state,4),false);
  assert.equal(canEnterStep(state,5),false);
  for(const step of [0,6,3.5,'5'])assert.equal(canEnterStep(state,step),false);
});

test('own-land hectares come from contour, independent of typed scale or fake bbox area',()=>{
  const state=own(),result=validateTerritory(state);
  assert.equal(result.valid,true);
  assert.ok(result.areaHa>90&&result.areaHa<110);
  const context=planningContext(state);
  assert.equal(context.scaleHa,result.areaHa);
  assert.equal(context.areaSource,'geometry');
  assert.notEqual(context.scaleHa,999999);
  assert.deepEqual(context.bbox,[-98,38,-97.99,38.01]);
  context.ring[0][0]=1;
  assert.equal(state.customArea.ring[0][0],-98);
});

test('empty, open, repeated, collinear, self-crossing and malformed rings block crop',()=>{
  const invalid=[null,[],ring.slice(0,-1),[[-98,38],[-98,38],[-97,39],[-98,38]],
    [[-98,38],[-97.9,38],[-97.8,38],[-98,38]],
    [[-98,38],[-97.9,38.1],[-98,38.1],[-97.9,38],[-98,38]],
    [[-98,38],[-97.9,38],[-97.9,NaN],[-98,38]],
    [[-98,38],[-97.9,38],['-97.9',38.1],[-98,38]]];
  for(const candidate of invalid){
    const state={...own(),customArea:{ring:candidate}};
    assert.equal(validateTerritory(state).valid,false);
    assert.equal(canEnterStep(state,3),false);
  }
  assert.equal(validateTerritory({...own(),customArea:{bbox:[-98,38,-97,39]}}).valid,false);
});

test('every polygon vertex must lie in the North America map domain; misleading bbox cannot hide outside geometry',()=>{
  const state=own();
  state.customArea.ring[2]=[0,38.01];
  state.customArea.bbox=[-98,38,-97.99,38.01];
  assert.equal(validateTerritory(state).code,'outside_coverage');
  state.customArea=own().customArea;
  state.customArea.bbox=[-99,38,-97,39];
  assert.equal(validateTerritory(state).code,'bbox_mismatch');
  state.customArea.bbox=[-98,38,-97.99,38.01];
  assert.equal(validateTerritory(state).valid,true);
});

test('find-land starts with explicit North America selection and required desired scale in hectares',()=>{
  const state=search();
  state.searchRegion=null;
  assert.equal(canEnterStep(state,3),false);
  state.searchRegion='ukraine';
  assert.equal(canEnterStep(state,3),false);
  state.searchRegion='north-america';
  assert.equal(canEnterStep(state,3),true);
  state.scaleHa='';
  assert.equal(canEnterStep(state,4),true);
  assert.equal(canEnterStep(state,5),false);
  state.scaleHa='12,5';
  const context=planningContext(state);
  assert.equal(context.valid,true);
  assert.equal(context.scaleHa,12.5);
  assert.equal(context.areaSource,'user_desired_scale');
  assert.equal(context.ring,null);
  assert.deepEqual(context.bbox,[-180,5,-10,84]);
  assert.equal('availableLandHa' in context,false);
});

test('scales reject blanks, boolean coercion, infinity, negative and ambiguous units',()=>{
  for(const value of ['',null,undefined,true,false,0,-1,NaN,Infinity,'NaN','25 acres','1 000','1.2.3'])assert.equal(validateScale(value).valid,false,String(value));
  for(const value of [0.25,'25','25.5','25,5'])assert.equal(validateScale(value).valid,true);
});

test('water input gates known, unknown and explicitly rainfed scenarios without invented doses',()=>{
  const state=own();
  state.irrigation=null;
  assert.equal(canEnterStep(state,5),false);
  for(const mode of ['unknown','no','yes']){
    state.irrigation=mode;
    assert.equal(canEnterStep(state,5),true);
    assert.equal(planningContext(state).irrigationKnown,mode==='no');
  }
  state.water='125,5';
  assert.equal(planningContext(state).irrigationMm,125.5);
  assert.equal(planningContext(state).irrigationKnown,true);
  for(const value of [-1,5001,true,'abc',Infinity]){
    state.water=value;
    assert.equal(canEnterStep(state,5),false);
  }
});

test('browser badInput blocks progress even when an optional numeric field becomes an empty value',()=>{
  const state={...own(),targetYear:'',water:'',conditionsInputInvalid:true,maxStep:5};
  assert.equal(validateConditions(state).code,'invalid_numeric_input');
  assert.equal(canEnterStep(state,4),true);
  assert.equal(canEnterStep(state,5),false);
  assert.equal(planningContext(state).valid,false);
  state.conditionsInputInvalid=false;
  assert.equal(canEnterStep(state,5),true);
});

test('historical year/date are validated separately from optional future target year',()=>{
  const now=new Date('2026-11-14T00:00:00Z');
  const state=own();
  assert.equal(validateConditions(state,now).targetYear,null);
  state.targetYear='2027';
  assert.equal(validateConditions(state,now).targetYear,2027);
  assert.equal(validateConditions(state,now).historicalYear,2025);
  for(const year of ['2025','2027x',true,2101]){
    state.targetYear=year;
    assert.equal(validateConditions(state,now).valid,false);
  }
  state.targetYear='';
  for(const date of ['2025-02-30','2024-05-01','not-a-date','2025-12-01']){
    state.planting=date;
    assert.equal(validateConditions(state,now).valid,false);
  }
  state.year=2026;state.planting='2026-12-01';
  assert.equal(validateConditions(state,now).code,'future_historical_date');
});

test('edits recompute gates and planning context while preserving shared inputs',()=>{
  const state=own(),original=structuredClone(state);
  const first=planningContext(state);
  assert.equal(canEnterStep(state,5),true);
  state.crop='soy';
  assert.notDeepEqual(planningContext(state),first);
  state.customArea=null;
  assert.equal(canEnterStep(state,3),false);
  assert.equal(canEnterStep(state,5),false);
  assert.equal(state.crop,'soy');
  assert.equal(state.irrigation,original.irrigation);
  state.mode='find_land';state.searchRegion='north-america';state.scaleHa='10';
  assert.equal(canEnterStep(state,5),true);
  assert.equal(planningContext(state).mode,'find_land');
  assert.equal(original.customArea.ring.length,5);
});
