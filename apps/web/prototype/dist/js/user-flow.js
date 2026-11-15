import {geodesicAreaHa,polygonBounds} from './area-selection.js';

export const FLOW_STEPS=Object.freeze({WELCOME:1,TERRITORY:2,CROP:3,CONDITIONS:4,RESULTS:5});
export const flowStepNames=Object.freeze(['Початок','Територія','Культура','Умови','Результати']);
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
    if(state.searchRegion!=='kansas')return fail('search_region_required','Оберіть Канзас як область пошуку. Для інших територій поки немає даних.');
    return ok({bbox:[...KANSAS_BBOX],ring:null,areaHa:null});
  }
  if(state.mode!=='own_land')return fail('mode_required','Оберіть: аналізувати свою ділянку чи знайти місця для вирощування.');
  const ring=state.customArea?.ring;
  if(!Array.isArray(ring)||ring.length<4)return fail('parcel_required','Позначте ділянку на карті та замкніть її контур.');
  if(ring.some(point=>!Array.isArray(point)||point.length!==2||point.some(value=>typeof value!=='number'||!Number.isFinite(value))||Math.abs(point[0])>180||Math.abs(point[1])>90))return fail('invalid_coordinates','Координати контуру мають бути коректними числами довготи й широти.');
  if(!samePoint(ring[0],ring.at(-1)))return fail('open_ring','Замкніть контур ділянки: остання точка має збігатися з першою.');
  const vertices=ring.slice(0,-1);
  if(new Set(vertices.map(point=>point.join(','))).size!==vertices.length||vertices.length<3)return fail('degenerate_ring','Контур має містити щонайменше три різні вершини без повторів.');
  const bbox=polygonBounds(ring);
  const [west,south,east,north]=KANSAS_BBOX;
  if(bbox[0]<west||bbox[1]<south||bbox[2]>east||bbox[3]>north)return fail('outside_coverage','Ділянка має повністю лежати в пілотній області Канзасу. За її межами немає аналітичного покриття.');
  if(state.customArea.bbox!==undefined&&(!Array.isArray(state.customArea.bbox)||state.customArea.bbox.length!==4||state.customArea.bbox.some((value,i)=>typeof value!=='number'||!Number.isFinite(value)||Math.abs(value-bbox[i])>1e-8)))return fail('bbox_mismatch','Межі ділянки не збігаються з контуром. Позначте її ще раз.');
  for(let i=0;i<vertices.length;i++)for(let j=i+1;j<vertices.length;j++){
    if(j===i+1||i===0&&j===vertices.length-1)continue;
    if(intersects(vertices[i],ring[i+1],vertices[j],ring[j+1]))return fail('self_intersection','Лінії контуру перетинаються. Намалюйте ділянку без перетинів.');
  }
  // Translate before area calculation to avoid cancellation at longitudes ~100°.
  const [x,y]=vertices[0];
  const twiceArea=vertices.reduce((sum,p,i)=>{const q=vertices[(i+1)%vertices.length];return sum+(p[0]-x)*(q[1]-y)-(q[0]-x)*(p[1]-y);},0);
  const areaHa=geodesicAreaHa(ring);
  if(Math.abs(twiceArea)<1e-14||!Number.isFinite(areaHa)||areaHa<=0)return fail('degenerate_ring','Контур не утворює ділянку з площею. Позначте її ще раз.');
  return ok({ring:ring.map(point=>[...point]),bbox,areaHa});
}

/** Search scale is desired hectares, not a claim that cadastral land is available. */
export function validateScale(value){
  const areaHa=numeric(value);
  return areaHa!==null&&areaHa>0?ok({areaHa}):fail('scale_required','Вкажіть бажану площу вирощування у гектарах — число більше нуля.');
}

/** Historical scenario and future target season are deliberately separate. */
export function validateConditions(state,now=new Date()){
  if(state.conditionsInputInvalid===true)return fail('invalid_numeric_input','Завершіть введення числа або очистьте необов’язкове поле.');
  const territory=validateTerritory(state);
  if(!territory.valid)return territory;
  if(!CROPS.has(state.crop))return fail('crop_required','Оберіть культуру зі списку.');
  const scale=state.mode==='own_land'?ok({areaHa:territory.areaHa}):validateScale(state.scaleHa);
  if(!scale.valid)return scale;
  if(!['yes','no','unknown'].includes(state.irrigation))return fail('water_mode_required','Оберіть, чи плануєте додатковий полив.');
  const supplied=!blank(state.water)&&String(state.water).trim()!=='';
  const amount=state.irrigation==='yes'&&supplied?numeric(state.water):0;
  if(state.irrigation==='yes'&&supplied&&(amount===null||amount<0||amount>5000))return fail('invalid_water','Кількість поливу у вашому сценарії має бути числом від 0 до 5000 мм.');
  const currentYear=now.getUTCFullYear();
  let targetYear=null;
  if(!blank(state.targetYear)){
    if(!/^\d{4}$/.test(String(state.targetYear)))return fail('invalid_target_year','Вкажіть цільовий рік чотирма цифрами або залиште поле порожнім.');
    targetYear=Number(state.targetYear);
    if(targetYear<currentYear||targetYear>2100)return fail('invalid_target_year','Цільовий рік має бути поточним або майбутнім, до 2100 року.');
  }
  if(!/^\d{4}$/.test(String(state.year))||Number(state.year)<1984||Number(state.year)>currentYear)return fail('invalid_historical_year','Оберіть доступний рік історичного аналізу — від 1984 до поточного року.');
  const historicalYear=Number(state.year);
  if(typeof state.planting!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(state.planting))return fail('invalid_historical_date','Вкажіть опорну дату історичного сценарію у форматі РРРР-ММ-ДД.');
  const date=new Date(`${state.planting}T00:00:00Z`);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==state.planting||date.getUTCFullYear()!==historicalYear)return fail('invalid_historical_date','Опорна дата має існувати й належати обраному історичному року. Це не рекомендована дата сівби.');
  if(date.getTime()>now.getTime())return fail('future_historical_date','Дата історичного сценарію ще не настала. Оберіть минулу дату.');
  const end=new Date(date.getTime()+(SCENARIO_DAYS[state.crop]-1)*86400000);
  if(end.getUTCFullYear()!==historicalYear)return fail('cross_year_scenario','Поточна модель підтримує лише історичний сезон у межах одного календарного року. Оберіть ранішу опорну дату.');
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
