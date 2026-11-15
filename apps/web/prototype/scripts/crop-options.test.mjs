import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCropOptions,fetchCropOptions,parcelReferencePoint} from '../dist/js/crop-options.js';
import {geometryContainsPoint} from '../dist/js/area-selection.js';
const fixture=rows=>({query:{year:2025},crop_comparison:rows});
const row=(crop,score=75,extra={})=>({crop,score,status:'good',missing:[],...extra});

test('a concave parcel uses a point inside its outline rather than the bbox gap',()=>{
  const ring=[[-99,38],[-97,38],[-97,38.3],[-98.7,38.3],[-98.7,39.7],[-97,39.7],[-97,40],[-99,40],[-99,38]];
  const geometry={type:'Polygon',coordinates:[ring]};
  assert.equal(geometryContainsPoint(geometry,-98,39),false);
  const point=parcelReferencePoint({ring});
  assert.equal(geometryContainsPoint(geometry,point.lon,point.lat),true);
  assert.equal(parcelReferencePoint(null),null);
});

test('land-cover exclusions, critical gaps and potential scores never become candidates',()=>{
  const data=normalizeCropOptions(fixture([
    row('corn',null,{status:'excluded',potential_score:99}),
    row('soy',90,{missing:['soil']}),row('oats',0,{status:'poor'}),
    row('sorghum',60,{status:'conditional'})
  ]),2025);
  assert.equal(data.options[0].crop,'sorghum');
  assert.equal(data.options[0].eligible,true);
  assert.equal(data.options.find(r=>r.crop==='corn').score,null);
  assert.equal(data.options.find(r=>r.crop==='soy').score,null);
  assert.equal(data.options.find(r=>r.crop==='oats').score,0);
  assert.equal(data.options.find(r=>r.crop==='oats').eligible,false);
});

test('local warning prevents spring wheat being promoted on a high model score',()=>{
  const data=normalizeCropOptions(fixture([row('wheat',99),row('corn',70)]),2025);
  assert.equal(data.options[0].crop,'corn');
  const wheat=data.options.find(r=>r.crop==='wheat');
  assert.equal(wheat.score,null);
  assert.equal(wheat.eligible,false);
  assert.ok(wheat.localWarning);
});

test('unknown economics and genuine zero costs remain distinct with their own year',()=>{
  const data=normalizeCropOptions(fixture([row('corn',70,{economics:{cost_per_ha:0,price_per_tonne:null,actual_year:2024,region:'Prairie Gateway'}})]),2025);
  assert.equal(data.options[0].costPerHa,0);
  assert.equal(data.options[0].pricePerTonne,null);
  assert.equal(data.options[0].economicYear,2024);
  assert.equal(data.options[0].economicRegion,'Prairie Gateway');
  assert.equal(data.options.find(r=>r.crop==='soy').costPerHa,null);
  assert.throws(()=>normalizeCropOptions(fixture([]),2024),/іншого періоду/);
});

test('comparison request uses an explicit historical rainfed preview without mutating a crop choice',async()=>{
  const original=globalThis.fetch;
  let called;
  try{
    globalThis.fetch=async(url,options)=>{called={url,options};return {ok:true,json:async()=>fixture([row('soy')])};};
    const controller=new AbortController();
    await fetchCropOptions({lon:-97.5,lat:38.5,year:2025,signal:controller.signal});
    const query=new URL(called.url,'http://localhost').searchParams;
    assert.equal(query.get('irrigation_known'),'false');
    assert.equal(query.get('irrigation_mm'),'0');
    assert.equal(query.get('years_back'),'1');
    assert.equal(query.get('planting'),'2025-05-01');
    assert.equal(called.options.signal,controller.signal);
    called=null;
    await assert.rejects(fetchCropOptions({lon:0,lat:0,year:2025}),/Канзасу/);
    assert.equal(called,null);
  }finally{globalThis.fetch=original;}
});
