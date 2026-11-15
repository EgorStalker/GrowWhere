import assert from 'node:assert/strict';
import test from 'node:test';
import {buildPresentationZones} from '../dist/js/map-presentation.js';
import {geometryContainsPoint} from '../dist/js/area-selection.js';

const cell=(w,s,e,n,status='good',id=`${w},${s}`)=>({type:'Feature',id,properties:{id,result:{status,score:status==='unknown'?null:73},representation:'multi_point_overview_5pt'},geometry:{type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}});
const collection=features=>({type:'FeatureCollection',features,meta:{mode:'grid'}});
const statusAt=(zones,x,y)=>zones.features.filter(feature=>geometryContainsPoint(feature.geometry,x,y)).map(feature=>feature.properties.result.status).sort();
const signedArea=ring=>ring.slice(0,-1).reduce((sum,p,i)=>sum+p[0]*ring[i+1][1]-ring[i+1][0]*p[1],0)/2;
const planarArea=zones=>zones.features.reduce((total,feature)=>total+feature.geometry.coordinates.reduce((sum,rings)=>sum+rings.reduce((a,ring)=>a+signedArea(ring),0),0),0);

test('adjacent same-class cells lose artificial seams while source cells remain unchanged',()=>{
  const source=collection([cell(0,0,1,1),cell(1,0,2,1),cell(2,0,3,1)]);
  const before=structuredClone(source),zones=buildPresentationZones(source);
  assert.equal(zones.meta.dissolved,true);
  assert.equal(zones.features.length,1);
  assert.equal(zones.features[0].geometry.coordinates.length,1);
  assert.equal(zones.features[0].geometry.coordinates[0][0].length,5);
  assert.equal(planarArea(zones),3);
  assert.equal(zones.features[0].properties.result.score,null);
  assert.deepEqual(source,before);
});

test('unknown and excluded cells remain holes in neighboring suitability classes',()=>{
  for(const middle of ['unknown','excluded']){
    const cells=[];
    for(let x=0;x<3;x++)for(let y=0;y<3;y++)cells.push(cell(x,y,x+1,y+1,x===1&&y===1?middle:'good'));
    const zones=buildPresentationZones(collection(cells));
    const good=zones.features.find(feature=>feature.properties.result.status==='good');
    assert.equal(good.geometry.coordinates[0].length,2);
    assert.deepEqual(statusAt(zones,1.5,1.5),[middle]);
    assert.deepEqual(statusAt(zones,.5,.5),['good']);
    assert.equal(planarArea(zones),9);
  }
});

test('unobserved gaps stay empty instead of being filled by a merged exterior',()=>{
  const cells=[];
  for(let x=0;x<3;x++)for(let y=0;y<3;y++)if(x!==1||y!==1)cells.push(cell(x,y,x+1,y+1));
  const zones=buildPresentationZones(collection(cells));
  assert.deepEqual(statusAt(zones,1.5,1.5),[]);
  assert.equal(planarArea(zones),8);
});

test('corner-touching cells stay separate and mixed classes never bleed across boundaries',()=>{
  const diagonal=buildPresentationZones(collection([cell(0,0,1,1),cell(1,1,2,2)]));
  assert.equal(diagonal.features[0].geometry.coordinates.length,2);
  const zones=buildPresentationZones(collection([cell(0,0,1,1,'good'),cell(1,0,2,1,'conditional'),cell(2,0,3,1,'poor')]));
  assert.deepEqual(statusAt(zones,.999,.5),['good']);
  assert.deepEqual(statusAt(zones,1.001,.5),['conditional']);
  assert.deepEqual(statusAt(zones,2.001,.5),['poor']);
  assert.deepEqual(statusAt(zones,3.001,.5),[]);
});

test('partial shared edges cancel at T-junctions without seams or overlaps',()=>{
  const zones=buildPresentationZones(collection([cell(0,0,1,2),cell(1,0,2,1),cell(1,1,2,2)]));
  assert.equal(zones.features[0].geometry.coordinates[0][0].length,5);
  assert.equal(planarArea(zones),4);
  for(const [x,y] of [[.5,.5],[1.5,.5],[.5,1.5],[1.5,1.5]])assert.deepEqual(statusAt(zones,x,y),['good']);
});

test('area-display partitions remain separate without changing source classification',()=>{
  const zones=buildPresentationZones(collection([cell(0,0,1,1,'good','inside'),cell(1,0,2,1,'good','outside')]),{partition:feature=>feature.id});
  assert.equal(zones.features.length,2);
  assert.deepEqual(zones.features.map(feature=>feature.properties.presentation_partition).sort(),['inside','outside']);
  assert.equal(planarArea(zones),2);
});

test('native soil shapes and overlapping/invalid grids fail closed to original geometry',()=>{
  const native=collection([cell(0,0,1,1)]);native.meta.mode='soil_polygons';delete native.features[0].properties.representation;
  assert.deepEqual(buildPresentationZones(native).features,native.features);
  for(const source of [collection([cell(0,0,2,2),cell(1,1,3,3)]),collection([{...cell(0,0,1,1),geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[.5,1],[0,0]]]}}])]){
    const before=structuredClone(source),zones=buildPresentationZones(source);
    assert.equal(zones.meta.dissolved,false);
    assert.deepEqual(zones.features,source.features);
    assert.deepEqual(source,before);
  }
});

test('floating-point copies of a shared edge reconcile far below a display pixel',()=>{
  const zones=buildPresentationZones(collection([cell(0,0,1,1),cell(1+1e-12,0,2,1)]),{zoom:7});
  assert.equal(zones.features[0].geometry.coordinates.length,1);
  assert.equal(zones.features[0].geometry.coordinates[0][0].length,5);
  assert.equal(planarArea(zones),2);
});

test('deterministic mixed grids preserve classification at every cell center',()=>{
  let seed=23;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let run=0;run<30;run++){
    const expected=new Map(),features=[];
    for(let x=0;x<10;x++)for(let y=0;y<10;y++){
      const status=['good','conditional','poor','unknown','excluded',null][Math.floor(random()*6)];
      if(status){expected.set(`${x},${y}`,status);features.push(cell(x,y,x+1,y+1,status));}
    }
    const zones=buildPresentationZones(collection(features));
    assert.equal(zones.meta.dissolved,true);
    for(let x=0;x<10;x++)for(let y=0;y<10;y++){
      const status=expected.get(`${x},${y}`);
      assert.deepEqual(statusAt(zones,x+.5,y+.5),status?[status]:[]);
    }
  }
});
