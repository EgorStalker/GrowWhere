import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPreparedMap,clearPreparedCatalog} from '../dist/js/prepared-maps.js';
const query={crop:'corn',year:'2025',planting:'2025-05-01',irrigation_mm:'0',irrigation_known:'true'};
const bbox=[-99,38,-97,39];
const product=(id,stale=false)=>({product_id:id,status:'ready',enabled_bbox:[-102,37,-94,40],actual_data_bbox:[-102,37,-94,40],stale});

test('an unprepared scenario stays No data and never falls back to live analysis',async()=>{
  clearPreparedCatalog();const original=globalThis.fetch,calls=[];
  try{
    globalThis.fetch=async url=>{calls.push(url);return {ok:true,json:async()=>({products:[]})};};
    const data=await loadPreparedMap(query,bbox,8);
    assert.equal(data.meta.status,'not_precomputed');assert.deepEqual(data.features,[]);
    assert.equal(calls.length,1);assert.match(calls[0],/^\/api\/map-products\?/);
    assert.equal(data.meta.upstream_requests,0);
  }finally{globalThis.fetch=original;}
});

test('native saved cells and missing values survive read-only delivery unchanged',async()=>{
  clearPreparedCatalog();const original=globalThis.fetch,calls=[];
  const feature={type:'Feature',properties:{result:{status:'unknown',score:null,missing:['soil']}}};
  try{
    globalThis.fetch=async url=>{calls.push(url);return {ok:true,json:async()=>url.includes('/tiles?')?{type:'FeatureCollection',features:[feature],meta:{upstream_requests:0}}:{products:[product('saved')]}};};
    const data=await loadPreparedMap(query,bbox,13);
    assert.deepEqual(data.features,[feature]);assert.equal(data.meta.prepared,true);
    assert.equal(calls.length,2);assert.match(calls[1],/product_id=saved/);
    assert.equal(calls.some(url=>url.includes('/api/analysis')),false);
  }finally{globalThis.fetch=original;}
});

test('fresh versions take priority and manual refresh discovers a newly published version',async()=>{
  clearPreparedCatalog();const original=globalThis.fetch;let revision=1;const tiles=[];
  try{
    globalThis.fetch=async url=>({ok:true,json:async()=>{
      if(url.includes('/tiles?')){tiles.push(url);return {type:'FeatureCollection',features:[],meta:{}};}
      return {products:revision===1?[product('old',true),product('fresh')]:[product('new')]};
    }});
    await loadPreparedMap(query,bbox,8);
    assert.match(tiles.at(-1),/product_id=fresh/);
    revision=2;await loadPreparedMap(query,bbox,8,{refresh:true});
    assert.match(tiles.at(-1),/product_id=new/);
  }finally{globalThis.fetch=original;}
});

test('unknown irrigation is queried separately from a confirmed rainfed scenario',async()=>{
  clearPreparedCatalog();const original=globalThis.fetch;let url;
  try{
    globalThis.fetch=async value=>{url=value;return {ok:true,json:async()=>({products:[]})};};
    await loadPreparedMap({...query,irrigation_known:'false'},bbox,8);
    assert.equal(new URL(url,'http://localhost').searchParams.get('irrigation_known'),'false');
  }finally{globalThis.fetch=original;}
});
