// Historical candidates at one reference point. Never a field-wide agronomic
// recommendation: do not fall back to scores calculated before land-cover QA.
const CROP_IDS=['wheat','soy','corn','sorghum','barley','oats','cotton'];
const KANSAS=[-102.1,36.9,-94.5,40.1];
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const nonnegative=value=>finite(value)&&value>=0?value:null;
// A bounding-box midpoint can lie outside a concave field. Choose the middle
// of its widest interior interval at mid-latitude instead (single-ring parcels).
export function parcelReferencePoint(area) {
  const ring=area?.ring;
  if(!Array.isArray(ring)||ring.length<4||ring.some(p=>!Array.isArray(p)||!finite(p[0])||!finite(p[1])))return null;
  const lat=(Math.min(...ring.map(p=>p[1]))+Math.max(...ring.map(p=>p[1])))/2;
  const crossings=[];
  for(let i=0;i<ring.length-1;i++){
    const [x,y]=ring[i],[nextX,nextY]=ring[i+1];
    if((y>lat)!==(nextY>lat))crossings.push(x+(lat-y)*(nextX-x)/(nextY-y));
  }
  crossings.sort((a,b)=>a-b);
  let best=null;
  for(let i=0;i+1<crossings.length;i+=2){
    const width=crossings[i+1]-crossings[i];
    if(width>0&&(!best||width>best.width))best={lon:(crossings[i]+crossings[i+1])/2,lat,width};
  }
  return best?{lon:best.lon,lat:best.lat}:null;
}
export function normalizeCropOptions(payload,year) {
  if(payload?.query?.year!==year||!Array.isArray(payload?.crop_comparison))throw new Error('Отримано дані іншого періоду. Спробуйте ще раз.');
  const options=CROP_IDS.map(crop=>{
    const row=payload.crop_comparison.find(item=>item.crop===crop)||{};
    const qualityPassed=['good','conditional','poor'].includes(row.status)&&Array.isArray(row.missing)&&row.missing.length===0;
    const localWarning=crop==='wheat'?'Місцевий посібник має застереження щодо ярої пшениці; до автоматичного добору її не включено.':
      crop==='barley'?'Для ярого ячменю є локальні обмеження; перевірте застосовність у своїй зоні.':null;
    const score=qualityPassed&&crop!=='wheat'&&finite(row.score)&&row.score>=0&&row.score<=100?row.score:null;
    const economics=row.economics||{};
    return {crop,score,status:score===null?'unknown':row.status,
      costPerHa:nonnegative(economics.cost_per_ha),pricePerTonne:nonnegative(economics.price_per_tonne),
      economicYear:Number.isInteger(economics.actual_year)?economics.actual_year:null,
      economicRegion:typeof economics.region==='string'?economics.region:null,
      sourceLabel:'NASA POWER · USDA SSURGO/CDL · USDA ERS',localWarning,
      eligible:score!==null&&row.status!=='poor'};
  });
  options.sort((a,b)=>(b.eligible-a.eligible)||((b.score??-1)-(a.score??-1)));
  return {options,period:year,scopeLabel:'Історичне порівняння в опорній точці контуру',
    limitations:[
      'Попереднє порівняння лише за природними опадами, без підтвердженого додаткового поливу.',
      'Бали стосуються однієї точки та опорних календарів дослідницької моделі; це не рекомендація для всього поля або нового сезону.',
      'Регіональні витрати й ціни — історичні; поточний попит на ринку невідомий.',
      'Яру пшеницю не включаємо до автоматичного добору через застереження місцевого посібника.'
    ],sourceUrls:[
      'https://power.larc.nasa.gov/docs/services/api/temporal/daily/',
      'https://sdmdataaccess.nrcs.usda.gov/WebServiceHelp.aspx',
      'https://www.ers.usda.gov/data-products/commodity-costs-and-returns',
      'https://bookstore.ksre.ksu.edu/pubs/kansas-crop-planting-guide_L818.pdf'
    ]};
}

export async function fetchCropOptions({lon,lat,year,signal}) {
  const [w,s,e,n]=KANSAS;
  if(!finite(lon)||!finite(lat)||lon<w||lon>e||lat<s||lat>n)throw new Error('Для порівняння потрібна точка в пілотній області Канзасу.');
  if(!Number.isInteger(year)||year<1984||year>=new Date().getUTCFullYear())throw new Error('Оберіть завершений історичний рік.');
  const params=new URLSearchParams({lon:String(lon),lat:String(lat),crop:'corn',year:String(year),planting:`${year}-05-01`,irrigation_mm:'0',irrigation_known:'false',years_back:'1'});
  const response=await fetch(`/api/insights?${params}`,{signal});
  const value=await response.json();
  if(!response.ok)throw new Error(value.error||'Не вдалося отримати порівняння культур.');
  return normalizeCropOptions(value,year);
}
