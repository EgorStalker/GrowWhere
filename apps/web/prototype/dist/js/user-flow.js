import {NORTH_AMERICA_BBOX} from './prepared-maps.js';
import {geodesicAreaHa,polygonBounds} from './area-selection.js';

export const FLOW_STEPS=Object.freeze({WELCOME:1,TERRITORY:2,CROP:3,CONDITIONS:4,RESULTS:5});
export const flowStepNames=Object.freeze(['Start','Area','Crop','Conditions','Results']);
export const KANSAS_BBOX=Object.freeze([-102.1,36.9,-94.5,40.1]);
const CROPS=new Set(['wheat','soy','corn','sorghum','barley','oats','cotton']);
// Request compatibility with analysis.py PROFILES; these are model durations, not advice.
const SCENARIO_DAYS={wheat:135,soy:140,corn:150,sorghum:130,barley:125,oats:130,cotton:180};
const fail=(code,error)=>({valid:false,code,error});
const ok=fields=>({valid:true,code:null,error:null,...fields});
const samePoint=(a,b)=>a[0]===b[0]&&a[1]===b[1];
const numeric=value=>{
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value!=='string'||!/^\d+(?:[.,]\d+)?$/.test(value.trim()))return null;
  return Number(value.trim().replace(',','.'));
};
const blank=value=>value===null||value===undefined||value==='';
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const onSegment=(a,b,p)=>Math.abs(cross(a,b,p))<1e-12&&p[0]>=Math.min(a[0],b[0])-1e-12&&p[0]<=Math.max(a[0],b[0])+1e-12&&p[1]>=Math.min(a[1],b[1])-1e-12&&p[1]<=Math.max(a[1],b[1])+1e-12;
function intersects(a,b,c,d){
  const abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b);
  return ((abC>0&&abD<0||abC<0&&abD>0)&&(cdA>0&&cdB<0||cdA<0&&cdB>0))||onSegment(a,b,c)||onSegment(a,b,d)||onSegment(c,d,a)||onSegment(c,d,b);
}

/** WGS84 coordinates are [longitude,latitude]. A bbox cannot replace a parcel. */
export function validateTerritory(state){
  if(state.mode==='find_land'){
    if(!['north-america','kansas'].includes(state.searchRegion))return fail('search_region_required','Select North America as the search region. Unprepared areas show No data.');
    return ok({bbox:[...NORTH_AMERICA_BBOX],ring:null,areaHa:null});
  }
  if(state.mode!=='own_land')return fail('mode_required','Choose whether to analyze your own field or search for growing areas.');
  const ring=state.customArea?.ring;
  if(!Array.isArray(ring)||ring.length<4)return fail('parcel_required','Mark your field on the map and close its boundary.');
  if(ring.some(point=>!Array.isArray(point)||point.length!==2||point.some(value=>typeof value!=='number'||!Number.isFinite(value))||Math.abs(point[0])>180||Math.abs(point[1])>90))return fail('invalid_coordinates','Boundary coordinates must be valid longitude and latitude numbers.');
  if(!samePoint(ring[0],ring.at(-1)))return fail('open_ring','Close the boundary: the final point must match the first.');
  const vertices=ring.slice(0,-1);
  if(new Set(vertices.map(point=>point.join(','))).size!==vertices.length||vertices.length<3)return fail('degenerate_ring','Use at least three distinct vertices without repeated points.');
  const bbox=polygonBounds(ring);
  const [west,south,east,north]=NORTH_AMERICA_BBOX;
  if(bbox[0]<west||bbox[1]<south||bbox[2]>east||bbox[3]>north)return fail('outside_coverage','The entire field must be inside the North America map area. Prepared data availability is checked separately.');
  if(state.customArea.bbox!==undefined&&(!Array.isArray(state.customArea.bbox)||state.customArea.bbox.length!==4||state.customArea.bbox.some((value,i)=>typeof value!=='number'||!Number.isFinite(value)||Math.abs(value-bbox[i])>1e-8)))return fail('bbox_mismatch','The stored bounds do not match the outline. Draw the field again.');
  for(let i=0;i<vertices.length;i++)for(let j=i+1;j<vertices.length;j++){
    if(j===i+1||i===0&&j===vertices.length-1)continue;
    if(intersects(vertices[i],ring[i+1],vertices[j],ring[j+1]))return fail('self_intersection','Boundary lines cross. Draw an outline without intersections.');
  }
  // Translate before area calculation to avoid cancellation at longitudes ~100°.
  const [x,y]=vertices[0];
  const twiceArea=vertices.reduce((sum,p,i)=>{const q=vertices[(i+1)%vertices.length];return sum+(p[0]-x)*(q[1]-y)-(q[0]-x)*(p[1]-y);},0);
  const areaHa=geodesicAreaHa(ring);
  if(Math.abs(twiceArea)<1e-14||!Number.isFinite(areaHa)||areaHa<=0)return fail('degenerate_ring','The outline has no usable area. Draw it again.');
  return ok({ring:ring.map(point=>[...point]),bbox,areaHa});
}

/** Search scale is desired hectares, not a claim that cadastral land is available. */
export function validateScale(value){
  const areaHa=numeric(value);
  return areaHa!==null&&areaHa>0?ok({areaHa}):fail('scale_required','Enter the desired growing area in hectares, greater than zero.');
}

/** Historical scenario and future target season are deliberately separate. */
export function validateConditions(state,now=new Date()){
  if(state.conditionsInputInvalid===true)return fail('invalid_numeric_input','Finish entering the number or clear the optional field.');
  const territory=validateTerritory(state);
  if(!territory.valid)return territory;
  if(!CROPS.has(state.crop))return fail('crop_required','Select a crop from the list.');
  const scale=state.mode==='own_land'?ok({areaHa:territory.areaHa}):validateScale(state.scaleHa);
  if(!scale.valid)return scale;
  if(!['yes','no','unknown'].includes(state.irrigation))return fail('water_mode_required','Choose whether you plan additional irrigation.');
  const supplied=!blank(state.water)&&String(state.water).trim()!=='';
  const amount=state.irrigation==='yes'&&supplied?numeric(state.water):0;
  if(state.irrigation==='yes'&&supplied&&(amount===null||amount<0||amount>5000))return fail('invalid_water','Scenario irrigation must be between 0 and 5000 mm.');
  const currentYear=now.getUTCFullYear();
  let targetYear=null;
  if(!blank(state.targetYear)){
    if(!/^\d{4}$/.test(String(state.targetYear)))return fail('invalid_target_year','Enter a four-digit target year or leave it blank.');
    targetYear=Number(state.targetYear);
    if(targetYear<currentYear||targetYear>2100)return fail('invalid_target_year','The target year must be current or future, up to 2100.');
  }
  if(!/^\d{4}$/.test(String(state.year))||Number(state.year)<1984||Number(state.year)>currentYear)return fail('invalid_historical_year','Choose a historical year between 1984 and the current year.');
  const historicalYear=Number(state.year);
  if(typeof state.planting!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(state.planting))return fail('invalid_historical_date','Enter the historical scenario date as YYYY-MM-DD.');
  const date=new Date(`${state.planting}T00:00:00Z`);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==state.planting||date.getUTCFullYear()!==historicalYear)return fail('invalid_historical_date','The reference date must exist and belong to the selected historical year. It is not a sowing recommendation.');
  if(date.getTime()>now.getTime())return fail('future_historical_date','The historical scenario date has not occurred yet. Choose a past date.');
  const end=new Date(date.getTime()+(SCENARIO_DAYS[state.crop]-1)*86400000);
  if(end.getUTCFullYear()!==historicalYear)return fail('cross_year_scenario','The current model supports a historical season within one calendar year. Choose an earlier reference date.');
  return ok({scaleHa:scale.areaHa,targetYear,historicalYear,planting:state.planting,
    water:{amountMm:amount,known:state.irrigation==='no'||state.irrigation==='yes'&&supplied,
      source:state.irrigation==='no'?'rainfed':state.irrigation==='yes'&&supplied?'user':'unknown'}});
}

/** Gates are recomputed from inputs; an old maxStep never bypasses them. */
export function canEnterStep(state,step){
  if(!Number.isInteger(step)||step<1||step>5)return false;
  if(step===1)return true;
  if(!['own_land','find_land'].includes(state.mode))return false;
  if(step===2)return true;
  if(!validateTerritory(state).valid)return false;
  if(step===3)return true;
  if(!CROPS.has(state.crop))return false;
  return step===4||validateConditions(state).valid;
}
export const canVisitStep=canEnterStep;
export const canAdvance=state=>canEnterStep(state,state.step+1);

export function planningContext(state){
  const territory=validateTerritory(state),conditions=validateConditions(state);
  return {valid:territory.valid&&conditions.valid,
    errors:[...new Set([territory.error,conditions.error].filter(Boolean))],
    mode:state.mode,crop:CROPS.has(state.crop)?state.crop:null,
    bbox:territory.bbox??null,ring:territory.ring??null,
    scaleHa:conditions.scaleHa??null,
    areaSource:state.mode==='own_land'?'geometry':'user_desired_scale',
    targetYear:conditions.targetYear??null,historicalYear:conditions.historicalYear??null,
    planting:conditions.planting??null,
    irrigationMm:conditions.water?.amountMm??null,irrigationKnown:conditions.water?.known??false};
}
