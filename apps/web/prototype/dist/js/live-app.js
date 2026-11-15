import {copy,tr,fmt,dateTime,historicalScenarioDate,irrigationInputState,forecastOverview,agronomicRuleOverview} from './live-i18n.js';
import {initMap,getView,setAnalysis,clearAnalysis,selectFeature,clearSelectedFeature,featureName,focusKansas,focusDetail,showWorld,resizeMap,startAreaSelection,undoLastPolygonPoint,finishPolygonSelection,cancelAreaSelection,clearCustomArea,setCustomArea,selectCurrentViewArea,setAreaDisplayMode,fitCustomArea,setBaseLayer,setOverlayOpacity,setSignalLayer,STATUS_COLORS} from './live-map.js';
import {aggregateTerritory,recommendedZoomForArea,geodesicAreaHa} from './area-selection.js';

import {flowStepNames,validateTerritory,validateConditions,canEnterStep,planningContext} from './user-flow.js';
import {fetchCropOptions,parcelReferencePoint} from './crop-options.js';
import {buildCalculationReport,renderReportDialogHtml} from './report.js';
import {createFieldSnapshot,compareTwoFields,renderFieldCompareDialogHtml} from './field-compare.js';

const CROP_IDS=['wheat','soy','corn','sorghum','barley','oats','cotton'];
const CROP_CODES={wheat:'ПШ',soy:'СО',corn:'КУ',sorghum:'СР',barley:'ЯЧ',oats:'ОВ',cotton:'БВ'};
const WATER_PRESETS=[150,300,450];
const KANSAS_BBOX=[-102.1,36.9,-94.5,40.1];
const currentYear=new Date().getUTCFullYear();
const defaultYear=currentYear-1;

const state={
  step:1,
  conditionsInputInvalid:false,
  maxStep:1,
  mode:null,
  ownArea:null,
  searchRegion:null,
  scaleHa:'',
  searchScaleHa:'',
  targetYear:'',
  territoryError:null,
  cropOptions:null,
  cropOptionsLoading:false,
  cropOptionsError:null,
  crop:null,
  year:defaultYear,
  planting:`${defaultYear}-05-01`,
  plantingManual:false,
  irrigation:null,
  water:'',
  irrigationSystem:null,
  cropGrowthStage:null,
  cropVariety:null,
  budget:'',
  large:false,
  drawerOpen:false,
  mapReady:false,
  loading:false,
  collection:null,
  selected:null,
  customArea:null,
  areaSummary:null,
  drawMode:null,
  drawPointsCount:0,
  areaDisplay:'solid',
  baseMap:'satellite',
  signalLayer:'index',
  drawerTab:'overview',
  overlayOpacity:0.42,
  insights:{},
  insightsLoading:false,
  insightsError:null,
  economics:{},
  economicsErrors:{},
  sources:null,
  error:null,
  validationError:null,
  tileError:false,
  meta:null,
  cacheHit:false,
};

const analysisCache=new Map();
const insightsCache=new Map();
const planningCache=new Map();
let planningLoadingKey=null,planningErrorKey=null,planningController=null,planningRequestId=0;
const root=document.getElementById('app');
const dialog=document.getElementById('dialog');
let controller=null,insightsController=null,requestId=0,insightsReqId=0,moveTimer=null,dialogTrigger=null,lastReport=null,compareFieldA=null,compareFieldB=null,awaitingCompareB=false,compareOriginArea=null,restoreOriginAfterCompare=false;

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cropName=id=>tr(`cropNames.${id}`,id);
const cropCode=id=>CROP_CODES[id]||'КЛ';
const icon=(name)=>`<span aria-hidden="true" class="plain-icon">${{arrow:'→',back:'←',pin:'⌖',help:'?',refresh:'↻',check:'✓'}[name]||'•'}</span>`;
const announce=message=>{const el=document.getElementById('announcement');if(el)el.textContent=message;};
const validNumber=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
const economyKey=(crop,year=state.year)=>`${crop}:${year}`;
const economy=crop=>state.economics[economyKey(crop)]||null;
const sourceReceived=id=>state.selected?.properties?.source_meta?.find(meta=>meta.source_id===id)?.retrieved_at;
const unit=(value,label,digits=0)=>validNumber(value)?`${fmt(value,digits)} <small>${label}</small>`:'Без даних';
const waterScenarioLabel=()=>{
  const water=irrigationInputState(state.irrigation,state.water);
  return state.irrigation==='yes'?(water.known?`ваш сценарій: ${fmt(water.amountMm)} мм`:'кількість поливу не визначено'):tr(`irrigationNames.${state.irrigation}`,'Полив не визначено');
};

function formatArea(ha) {
  if(!validNumber(ha)||Number(ha)<=0)return '—';
  if(ha>=100)return `${fmt(ha/100,1)} км² (${fmt(ha,0)} га)`;
  if(ha>=1)return `${fmt(ha,1)} га`;
  return `${fmt(ha*10000,0)} м²`;
}

function formatRange(range,suffix='',digits=1) {
  if(!range)return 'Без даних';
  const [min,max]=range;
  if(Math.abs(max-min)<Math.pow(10,-digits)/2)return `${fmt(min,digits)}${suffix}`;
  return `${fmt(min,digits)} – ${fmt(max,digits)}${suffix}`;
}

function safeUrl(value) {
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:null;}
  catch{return null;}
}
function sourceLink(url,label='Відкрити джерело') {
  const safe=safeUrl(url);
  return safe?`<a class="live-source-link" href="${escape(safe)}" target="_blank" rel="noopener noreferrer">${escape(label)} ↗</a>`:'';
}
function statusPill(status='unknown') {
  return `<span class="status-pill ${escape(status)}">${status==='good'?'✓':status==='unknown'?'?':status==='excluded'?'–':'!'} ${tr(`statuses.${status}`,'Без даних')}</span>`;
}
function button(label,action,kind='secondary',disabled=false) {
  return `<button type="button" class="${kind}" data-action="${action}" ${disabled?'disabled':''}><span>${label}</span>${kind==='primary'?icon('arrow'):''}</button>`;
}

function zoomTier(zoom) {
  if(zoom<5)return 'world';
  if(zoom<=6)return 'z6';
  if(zoom<=8)return 'z8';
  if(zoom<=11)return 'z11';
  return 'soil';
}

function geometryBbox(geom) {
  let w=180,s=90,e=-180,n=-90;
  const walk=coords=>{
    if(typeof coords[0]==='number'){
      if(coords[0]<w)w=coords[0];if(coords[0]>e)e=coords[0];
      if(coords[1]<s)s=coords[1];if(coords[1]>n)n=coords[1];
      return;
    }
    for(const item of coords)walk(item);
  };
  if(geom?.coordinates)walk(geom.coordinates);
  return [w,s,e,n];
}

function bboxIntersects(a,b) {
  return !(a[2]<b[0]||a[0]>b[2]||a[3]<b[1]||a[1]>b[3]);
}

function clipBboxToCoverage(bbox) {
  const w=Math.max(bbox[0],KANSAS_BBOX[0]),s=Math.max(bbox[1],KANSAS_BBOX[1]);
  const e=Math.min(bbox[2],KANSAS_BBOX[2]),n=Math.min(bbox[3],KANSAS_BBOX[3]);
  return w<e&&s<n?[w,s,e,n]:null;
}

function cacheBucketKey(cond,tier) {
  return `${cond.crop}|${cond.year}|${cond.planting}|${cond.irrigation_mm}|${cond.irrigation_known}|${tier}`;
}

function findCachedAnalysis(cond,bbox,zoom) {
  const tier=zoomTier(zoom);
  const key=cacheBucketKey(cond,tier);
  const list=analysisCache.get(key);
  if(!list?.length)return null;
  const clipped=clipBboxToCoverage(bbox)||bbox;
  const eps=1e-4;
  for(let i=list.length-1;i>=0;i--){
    const entry=list[i];
    if(Date.now()-entry.ts>15*60*1000)continue;
    if(entry.data.meta?.truncated)continue;
    const eb=entry.bbox;
    if(eb[0]<=clipped[0]+eps&&eb[1]<=clipped[1]+eps&&eb[2]>=clipped[2]-eps&&eb[3]>=clipped[3]-eps){
      const filteredFeatures=(entry.data.features||[]).filter(f=>bboxIntersects(geometryBbox(f.geometry),clipped));
      return {
        ...entry.data,
        features:filteredFeatures,
        meta:{...entry.data.meta,client_cached:true},
      };
    }
  }
  return null;
}

function storeCachedAnalysis(cond,bbox,zoom,data) {
  const tier=zoomTier(zoom);
  const key=cacheBucketKey(cond,tier);
  const clipped=clipBboxToCoverage(bbox)||bbox;
  const list=analysisCache.get(key)||[];
  list.push({bbox:clipped,data,ts:Date.now()});
  if(list.length>16)list.splice(0,list.length-16);
  analysisCache.set(key,list);
}

function buildShell() {
  root.innerHTML=`
    <header class="site-header">
      <button class="brand" data-action="home" aria-label="GrowWhere — головна">
        <img src="assets/logo.png" alt="" width="44" height="44">
        <div>
          <div class="brand-name">GrowWhere</div>
          <div class="brand-tag">${copy.brandTag}</div>
        </div>
      </button>
      <nav id="live-progress" class="tab-nav" aria-label="Етапи роботи"></nav>
      <div class="header-actions">
        <button id="text-size" class="header-button text-button" data-action="text-size" aria-label="Збільшити текст" aria-pressed="false">A+</button>
        <button class="header-button help-button" data-action="help" aria-label="Довідка">${icon('help')}<span>Довідка</span></button>
      </div>
    </header>
    <main id="main" class="live-shell">
      <div id="flow-stage"></div>
      <section class="map-workspace" id="map-workspace" hidden aria-label="Робоча карта">
        <div id="result-context"></div><div class="map-topbar" id="map-topbar"></div>
        <div id="draw-bar" class="live-draw-bar" hidden></div>
        <div id="area-banner" class="live-area-banner" hidden></div>
        <div class="map-canvas-wrap">
          <div id="live-map" class="live-map" tabindex="0"></div>
          <div id="map-status" class="live-map-status" role="status" hidden>Завантажуємо дані…</div>
          <div class="map-legend-float" aria-label="Кольори придатності">
            ${['good','conditional','poor','unknown','excluded'].map(status=>`<span><i class="${status}" aria-hidden="true"></i>${tr(`statuses.${status}`)}</span>`).join('')}
          </div>
          <aside id="map-drawer" class="map-drawer" aria-label="Результати вибраної ділянки" hidden></aside>
        </div><div id="territory-footer" hidden></div>
      </section>
    </main>
    <footer class="live-footer" id="live-footer">
      <div><strong>GrowWhere</strong> · RightVersion · Field Shift (NASA Space Apps)</div>
      <span>Скринінговий індекс придатності; не є агрономічною гарантією врожайності.</span>
    </footer>
  `;
  renderView();
}

function renderProgress() {
  const nav=document.getElementById('live-progress');
  if(!nav)return;
  nav.innerHTML=flowStepNames.map((label,index)=>{
    const n=index+1;
    const isCurrent=state.step===n;
    const locked=!canEnterStep(state,n);
    return `<button type="button" class="tab-pill ${isCurrent?'current':''} ${locked?'locked':''}" data-action="step" data-step="${n}" ${locked?'disabled aria-disabled="true" title="Спочатку завершіть попередні етапи"':''} ${isCurrent?'aria-current="page"':''}><span>${n}. ${label}</span></button>`;
  }).join('');
}

function renderMapTopbar() {
  const bar=document.getElementById('map-topbar');
  if(!bar)return;
  if(state.step===2){
    bar.innerHTML=`<div class="territory-tools">${button('Намалювати межу по точках','draw-area','primary')}${button('Виділити прямокутник','draw-rect')}${button('Наблизити Канзас','kansas')}${state.customArea?button('Очистити контур','clear-area'):''}</div>`;
    return;
  }
  const irrYes=state.irrigation==='yes';
  bar.innerHTML=`
    <div class="topbar-group">
      <label for="quick-crop">Культура</label>
      <select id="quick-crop">
        ${CROP_IDS.map(id=>`<option value="${id}" ${id===state.crop?'selected':''}>${cropName(id)}</option>`).join('')}
      </select>
    </div>
    <div class="topbar-group">
      <label for="year-select">Рік історичних даних</label>
      <select id="year-select">${[0,1,2,3,4,5].map(i=>currentYear-i).map(year=>`<option value="${year}" ${year===state.year?'selected':''}>${year}</option>`).join('')}</select>
    </div>
    <div class="topbar-group">
      <label for="planting-date">Початок історичного розрахунку</label>
      <input type="date" id="planting-date" min="${state.year}-01-01" max="${state.year}-12-31" value="${state.planting}">
    </div>
    <div class="topbar-group topbar-water">
      <span>Полив</span>
      <div class="inline-seg" role="group" aria-label="Режим поливу">
        <button type="button" class="${state.irrigation==='no'?'active':''}" id="water-no" data-action="water" data-value="no">Без</button>
        <button type="button" class="${irrYes?'active':''}" id="water-yes" data-action="water" data-value="yes">Є полив</button>
        <button type="button" class="${state.irrigation==='unknown'?'active':''}" id="water-unknown" data-action="water" data-value="unknown">Невідомо</button>
      </div>
      <div id="topbar-mm-wrap" class="topbar-mm-wrap" ${irrYes?'':'hidden'}>
        <input id="irrigation-mm" name="irrigation_mm" type="number" min="0" max="5000" step="25" inputmode="decimal" value="${escape(state.water)}" placeholder="Не визначено" aria-label="Ваш сценарій поливу у мм">
        <span class="mm-unit">мм</span>
        <button type="button" class="mini-preset ${Number(state.water)===200?'active':''}" data-action="water-preset" data-mm="200" title="Приклад сценарію, не рекомендація">200</button>
        <button type="button" class="mini-preset ${Number(state.water)===400?'active':''}" data-action="water-preset" data-mm="400" title="Приклад сценарію, не рекомендація">400</button>
      </div>
    </div>
    <div class="topbar-actions">
      <div class="inline-seg" role="group" aria-label="Тип карти">
        <button type="button" class="${state.baseMap==='satellite'?'active':''}" id="basemap-satellite" data-action="basemap" data-mode="satellite">Супутник</button>
        <button type="button" class="${state.baseMap==='osm'?'active':''}" id="basemap-osm" data-action="basemap" data-mode="osm">Схема</button>
      </div>
      <div class="inline-seg" role="group" aria-label="Шар спостережень NASA">
        <button type="button" class="${state.signalLayer==='index'?'active':''}" id="signal-index" data-action="signal-layer" data-mode="index">Індекс</button>
        <button type="button" class="${state.signalLayer==='ndvi'?'active':''}" id="signal-ndvi" data-action="signal-layer" data-mode="ndvi" title="Рослинність NASA MODIS Terra NDVI 8-Day">NDVI</button>
        <button type="button" class="${state.signalLayer==='smap'?'active':''}" id="signal-smap" data-action="signal-layer" data-mode="smap" title="Вологість кореневої зони NASA SMAP L4">SMAP</button>
      </div>
      <button type="button" id="opacity-button" data-action="cycle-opacity" title="Прозорість кольорового шару">Шар: ${Math.round(state.overlayOpacity*100)}%</button>
      <button type="button" id="draw-area-button" class="primary-compact ${state.drawMode||state.customArea?'active':''}" data-action="draw-area" aria-pressed="${!!state.drawMode}">${state.drawMode?'Малюємо…':state.customArea?'Змінити контур':'Виділити по точках'}</button>
      <button type="button" data-action="kansas">Канзас</button>
      <button type="button" data-action="refresh" id="refresh-button" title="Оновити з джерел">${icon('refresh')}</button>
      <button type="button" data-action="sources" title="Джерела та формула">Джерела</button>
    </div>
  `;
}

function planningReadinessHtml() {
  return `<aside class="planning-readiness" aria-label="Готовність рекомендацій"><strong>${copy.planningReadiness.title}</strong><ul><li>${copy.planningReadiness.sowing}</li><li>${copy.planningReadiness.irrigation}</li></ul><p>${copy.planningReadiness.reason}</p></aside>`;
}

function irrigationFields() {
  return `
    <div class="live-field">
      <fieldset>
        <legend>Полив ділянки</legend>
        <div class="segmented">
          ${Object.entries(copy.irrigationNames).map(([id,name])=>`<button type="button" class="segment ${state.irrigation===id?'active':''}" id="water-${id}" data-action="water" data-value="${id}" aria-pressed="${state.irrigation===id}">${name}</button>`).join('')}
        </div>
      </fieldset>
      ${state.irrigation==='yes'?`
        <div class="water-controls">
          <label for="irrigation-mm">Ваш сценарій додаткового поливу, мм (необов’язково)</label>
          <small>Приклади обсягів для порівняння — не рекомендація поливу:</small>
          <div class="water-presets" role="group" aria-label="Приклади обсягів для порівняння, не рекомендація">
            ${WATER_PRESETS.map(mm=>`<button type="button" class="preset-chip ${Number(state.water)===mm?'active':''}" data-action="water-preset" data-mm="${mm}">${mm} мм</button>`).join('')}
          </div>
          <input id="irrigation-mm" name="irrigation_mm" type="number" min="0" max="5000" step="10" inputmode="decimal" value="${escape(state.water)}" placeholder="Ще не визначено" aria-invalid="${!!state.validationError}" aria-describedby="water-hint water-validation">
          <small id="water-hint">1 мм = 10 м³/га. Це заданий вами сценарій, а не рекомендований полив. Без кількості показуємо історичну оцінку без підтвердженої додаткової води.</small>
          <p id="water-validation" class="live-input-error" role="alert" ${state.validationError?'':'hidden'}>${escape(state.validationError||'')}</p>
        </div>
      `:`<small>${state.irrigation==='unknown'?'Поки полив не підтверджено, у розрахунку враховуються лише природні опади.':state.irrigation==='no'?'Розрахунок враховує лише 80% сезонних опадів.':'Оберіть один із трьох варіантів, щоб модель точно знала умови зрошення.'}</small>`}
    </div>
  `;
}

function cropCard(crop) {
  const data=economy(crop);
  const meta=copy.cropNotes[crop]||{};
  return `
    <button type="button" id="crop-${crop}" class="live-crop ${state.crop===crop?'active':''}" data-action="crop" data-crop="${crop}" aria-pressed="${state.crop===crop}" aria-label="Обрати: ${cropName(crop)}">
      <div class="crop-row">
        <span class="crop-monogram" aria-hidden="true">${cropCode(crop)}</span>
        <div>
          <h2>${cropName(crop)}</h2>
          <p class="crop-meta-line">${escape(meta.season||'')} · опт. ${escape(meta.temp||'')}</p>
        </div>
        <span class="check-square">${state.crop===crop?'✓':''}</span>
      </div>
      <p class="crop-note">${escape(meta.note||'')}</p>
      <div class="mini-economy">
        <div><span>Витрати</span><b>${unit(data?.cost_per_ha,'$/га')}</b></div>
        <div><span>Ціна продажу</span><b>${unit(data?.price_per_tonne,'$/т')}</b></div>
      </div>
      <p class="econ-period">${data?`${escape(data.region||'USDA ERS')} · ${data.year||state.year}`:'Отримуємо дані USDA ERS…'}</p>
    </button>
  `;
}

function welcomeScreen() {
  return `<section class="welcome-stage" aria-labelledby="page-title"><div class="welcome-hero welcome-compact"><div class="welcome-copy"><p class="eyebrow">GrowWhere · RIGHTVERSION</p><h1 class="live-step-heading" id="page-title" tabindex="-1">Що вирощувати і де?</h1></div></div><div class="mode-options"><button type="button" class="mode-card" data-action="choose-mode" data-mode="own_land"><span class="step-num">01</span><h2>У мене є ділянка</h2><p>Позначте межі на карті, оберіть культуру та перевірте умови для цієї території.</p><b>Обрати мою ділянку →</b></button><button type="button" class="mode-card" data-action="choose-mode" data-mode="find_land"><span class="step-num">02</span><h2>Знайти придатні території</h2><p>Оберіть культуру й умови. Карта покаже історичну придатність зон.</p><b>Почати пошук →</b></button></div></section>`;
}
function territoryFooterHtml() {
  const validation=validateTerritory(state);
  return `<div class="wizard-footer-bar territory-footer"><p role="status">${validation.valid?(state.mode==='own_land'?`Контур: ${formatArea(validation.areaHa)}. Повністю в пілотному покритті.`:'Регіон обрано. Можна обрати культуру.'):escape(validation.error||'Позначте свою ділянку.')}</p>${button('Далі: культура','go-crops','primary',!validation.valid)}</div>`;
}
function territoryScreen() {
  const own=state.mode==='own_land';
  return `<section class="wizard-stage territory-stage" aria-labelledby="page-title"><button type="button" class="link-button" data-action="home">← Змінити спосіб пошуку</button><p class="eyebrow">КРОК 2 · ТЕРИТОРІЯ</p><h1 class="live-step-heading" id="page-title" tabindex="-1">${own?'Позначте свою ділянку':'У якому регіоні шукати?'}</h1><p class="lead">${own?'Наблизьте карту й намалюйте межі точками або рамкою всередині пілотного покриття. Оцінки з’являться після вибору культури й умов.':'Пошук доступний у пілотній області Канзасу. Це оцінка придатності, а не перелік вільних земель чи оголошень про продаж.'}</p>${own?'':`<button type="button" class="region-choice ${state.searchRegion==='kansas'?'active':''}" data-action="choose-region" aria-pressed="${state.searchRegion==='kansas'}"><strong>Канзас, США</strong><span>Пілотне покриття: 36,9–40,1° пн. ш.; 102,1–94,5° зх. д.</span><span>${state.searchRegion==='kansas'?'✓ Обрано':'Обрати цей регіон'}</span></button>${territoryFooterHtml()}`}</section>`;
}

function cropOptionsHtml() {
  if(state.mode!=='own_land')return '<p class="drawer-note">Пошук зараз показує одну активну культуру на карті. Культуру можна змінити й порівняти результат.</p>';
  const data=state.cropOptions;
  const ptLabel=data?.samplePoint?` (${fmt(data.samplePoint.lat,4)}°, ${fmt(data.samplePoint.lon,4)}°)`:'';
  return `<section class="crop-help"><h2>Ще не визначилися з культурою?</h2><p>Можемо порівняти культури в орній точці всередині вашого контуру: історичний сезон ${state.year}, природні опади. Це попереднє порівняння, а не рекомендація майбутньої посадки.</p>${button(state.cropOptionsLoading?'Отримуємо дані…':'Допомогти обрати','crop-help','secondary',state.cropOptionsLoading)}${state.cropOptionsError?`<p role="status">${escape(state.cropOptionsError)}</p>`:''}${data?`${data.options.some(option=>option.eligible)?'':'<p>За наявними даними не вдалося знайти підтверджено придатні орні варіанти в опорних точках цього контуру.</p>'}<p>${escape(data.scopeLabel)}${ptLabel} · ${escape(String(data.period))}</p><div class="crop-option-list">${data.options.map(option=>`<button type="button" data-action="crop" data-crop="${escape(option.crop)}" class="crop-option"><b>${cropName(option.crop)}</b><span>${validNumber(option.score)?`${fmt(option.score)} / 100`:'Без даних'} · ${tr('statuses.'+option.status,'Без даних')}</span><small>${escape(option.sourceLabel||'NASA POWER · USDA SSURGO/CDL')} · історична оцінка</small><small>Витрати: ${unit(option.costPerHa,'$/га')} · ціна: ${unit(option.pricePerTonne,'$/т')} · ${escape(option.economicRegion||'регіон не визначено')} ${escape(option.economicYear||'рік не визначено')}</small>${option.localWarning?`<small class="local-crop-warning">${escape(option.localWarning)}</small>`:''}</button>`).join('')}</div><ul>${data.limitations.map(note=>`<li>${escape(note)}</li>`).join('')}</ul>${data.sourceUrls.map(url=>sourceLink(url,'Першоджерело')).join(' ')}`:''}</section>`;
}

async function loadCropOptions() {
  if(state.step!==3||state.mode!=='own_land'||!validateTerritory(state).valid)return;
  const target=parcelReferencePoint(state.customArea);
  if(!target)return;
  const identity=JSON.stringify([state.customArea.ring,state.year]);
  state.cropOptionsLoading=true;state.cropOptionsError=null;stageRenderPreservingScroll();
  try{
    const result=await fetchCropOptions({area:state.customArea,...target,year:state.year});
    if(identity!==JSON.stringify([state.customArea?.ring,state.year]))return;
    state.cropOptions=result;
  }catch(error){state.cropOptionsError=error.message||'Не вдалося отримати порівняння. Можна обрати культуру зі списку нижче.';}
  finally{state.cropOptionsLoading=false;if(state.step===3)stageRenderPreservingScroll();}
}

function cropScreen() {
  return `
    <section class="wizard-stage" aria-labelledby="page-title">
      <div class="wizard-head">
        <div>
          <button type="button" class="link-button" data-action="go-territory">← Змінити територію</button>
          <p class="eyebrow">КРОК 3 · ВИБІР КУЛЬТУРИ</p>
          <h1 class="live-step-heading" id="page-title" tabindex="-1">Яку культуру ви плануєте вирощувати?</h1>
          <p class="lead">Оберіть одну з ${CROP_IDS.length} культур для порівняння історичних умов. Теплові пороги та потреба у воді належать до дослідницької моделі.</p>
        </div>
        <div class="wizard-head-actions">
          <button type="button" class="secondary" data-action="compare">Порівняти економіку</button>
        </div>
      </div>
      ${planningReadinessHtml()}
      ${cropOptionsHtml()}
      <div class="wizard-crop-grid">${CROP_IDS.map(crop=>cropCard(crop)).join('')}</div>
      <div class="wizard-footer-bar">
        <div class="wizard-chosen">${state.crop?`Обрано: <strong>${cropName(state.crop)}</strong>`:'Оберіть одну культуру зі списку вище, щоб перейти до налаштування поливу.'}</div>
        <button type="button" class="primary wizard-next" data-action="go-conditions" ${state.crop?'':'disabled'}><span>Далі: полив та умови</span>${icon('arrow')}</button>
      </div>
    </section>
  `;
}

function planningUserFieldsHtml() {
  const sysOptions=[['drip','Крапельний (90%)'],['sprinkler','Дощування (80%)'],['furrow','Борозенний (60%)']];
  const stageOptions=Object.entries(copy.cropGrowthStages||{});
  const varietyOptions=Object.entries(copy.cropVarieties||{}).filter(([id])=>!['winter','spring'].includes(id)||['wheat','barley'].includes(state.crop));
  return `
    <div class="planning-user-fields">
      <div class="live-field">
        <strong>Параметри господарства для 7-денного орієнтира (необов’язково)</strong>
        <small>Допомагає розрахувати тижневий водний орієнтир на основі прогнозу ET0 й зменшити кількість невідомих параметрів.</small>
      </div>
      ${state.irrigation==='yes'?`
        <div class="live-field">
          <label>Тип системи поливу</label>
          <div class="water-presets" role="group" aria-label="Тип системи поливу">
            ${sysOptions.map(([id,label])=>`<button type="button" class="preset-chip ${state.irrigationSystem===id?'active':''}" data-action="irrigation-system" data-value="${id}" aria-pressed="${state.irrigationSystem===id}">${label}</button>`).join('')}
          </div>
        </div>`:''}
      <div class="live-field">
        <label>Поточна фаза культури</label>
        <div class="water-presets" role="group" aria-label="Поточна фаза культури">
          ${stageOptions.map(([id,label])=>`<button type="button" class="preset-chip ${state.cropGrowthStage===id?'active':''}" data-action="growth-stage" data-value="${id}" aria-pressed="${state.cropGrowthStage===id}">${label}</button>`).join('')}
        </div>
      </div>
      <div class="live-field">
        <label>Форма / група стиглості</label>
        <div class="water-presets" role="group" aria-label="Форма або група стиглості">
          ${varietyOptions.map(([id,label])=>`<button type="button" class="preset-chip ${state.cropVariety===id?'active':''}" data-action="crop-variety" data-value="${id}" aria-pressed="${state.cropVariety===id}">${label}</button>`).join('')}
        </div>
      </div>
    </div>
  `;
}

function irrigationScreen() {
  state.conditionsInputInvalid=false;
  const validation=validateConditions(state);
  const ready=validateTerritory(state).valid&&validation.valid&&!state.validationError;
  return `
    <section class="wizard-stage narrow" aria-labelledby="page-title">
      <button type="button" class="link-button" data-action="go-crops">← Змінити культуру (${cropName(state.crop)})</button>
      <p class="eyebrow">КРОК 4 · МАСШТАБИ ТА УМОВИ</p>
      <h1 class="live-step-heading" id="page-title" tabindex="-1">Які умови вирощування?</h1>
      <p class="lead">Оберіть режим поливу та період спостережень. Ці налаштування допомагають повторити історичний розрахунок і сформувати 7-денний орієнтир.</p>
      ${planningReadinessHtml()}
      <div class="wizard-card">
        <div class="live-form">
          <div class="live-field"><label for="scale-ha">Площа вирощування, га</label>${state.mode==='own_land'?`<p class="area-value">${formatArea(geodesicAreaHa(state.customArea?.ring))} · за вашим контуром</p>`:`<input id="scale-ha" type="number" inputmode="decimal" min="0.01" step="any" value="${escape(state.scaleHa)}" placeholder="Наприклад, 25" required><small>Бажана площа для пошуку; не підтверджує наявність вільної ділянки такого розміру.</small>`}</div>
          ${irrigationFields()}
          ${planningUserFieldsHtml()}
          <div class="live-field"><label for="target-year">Майбутній сезон для перевірки даних (необов’язково)</label><input id="target-year" type="number" min="${currentYear}" max="2100" step="1" value="${escape(state.targetYear)}" placeholder="Рік, наприклад ${currentYear+1}"><small>Окремий параметр перевірки горизонту даних на етапі результатів.</small></div>
          <details class="historical-settings"><summary>Історичний період для карти · ${state.year}</summary><p>Карта порівнює минулі умови. Параметри нижче не визначають майбутньої сівби.</p>
          <div class="live-inline-fields">
            <div class="live-field">
              <label for="year-select">Рік спостережень</label>
              <select id="year-select">${[0,1,2,3,4,5].map(i=>currentYear-i).map(year=>`<option value="${year}" ${year===state.year?'selected':''}>${year}${year===currentYear?' · неповний рік':''}</option>`).join('')}</select>
            </div>
          </div>
          <div class="live-field">
            <label for="planting-date">Період історичного розрахунку — початок</label>
            <input type="date" id="planting-date" min="${state.year}-01-01" max="${state.year}-12-31" value="${state.planting}">
            <small>Це параметр моделі для обраного року, а не рекомендація майбутньої сівби. Актуальної дати посадки сервіс поки не визначає.</small>
          </div>
          </details>
          <p class="live-input-error" id="conditions-validation" role="status">${!validation.valid?escape(validation.error||'Перевірте заповнені умови.'):''}</p>
        </div>
        <div class="wizard-footer-bar">
          <div class="wizard-chosen">${state.irrigation?`${cropName(state.crop)} · історичні дані ${state.year} · ${waterScenarioLabel()}`:'Спочатку оберіть режим поливу вище («Без поливу», «Полив доступний» або «Ще не знаю»).'}</div>
          <button type="button" class="primary wizard-next" data-action="go-map" ${ready?'':'disabled'}><span>Показати оцінку на карті</span>${icon('arrow')}</button>
        </div>
      </div>
    </section>
  `;
}

function factorBarsHtml(factors,limiting) {
  if(!factors||!Object.keys(factors).length)return '';
  const entries=Object.entries(factors).filter(([,v])=>validNumber(v));
  if(!entries.length)return '';
  return `
    <div class="factor-bars">
      <div class="factor-bars-head"><span>7 чинників придатності</span>${limiting?`<small>Обмежує: ${escape(tr(`factorNames.${limiting}`,limiting))}</small>`:''}</div>
      ${entries.map(([key,val])=>{
        const pct=Math.round(Number(val)*100);
        const tier=pct>=70?'good':pct>=40?'conditional':'poor';
        return `<div class="factor-bar-row"><span class="factor-label">${escape(tr(`factorNames.${key}`,key))}</span><div class="factor-track"><span class="factor-fill ${tier}" style="width:${pct}%"></span></div><span class="factor-val">${pct}%</span></div>`;
      }).join('')}
    </div>
  `;
}

function waterBalanceHtml(wb) {
  if(!wb||!validNumber(wb.demand_mm))return '';
  const supply=(wb.effective_rain_mm||0)+(wb.irrigation_mm||0);
  const gap=Math.max(0,wb.demand_mm-supply);
  return `
    <div class="water-balance-box">
      <div><span>Опади (×0.8)</span><b>${fmt(wb.effective_rain_mm,0)} мм</b></div>
      <div><span>Полив у сценарії</span><b>${irrigationInputState(state.irrigation,state.water).known?`+${fmt(wb.irrigation_mm,0)} мм`:'Не визначено'}</b></div>
      <div><span>Потреба ETc</span><b>${fmt(wb.demand_mm,0)} мм</b></div>
      <div><span>${gap>0?'Дефіцит':'Запас'}</span><b>${gap>0?`-${fmt(gap,0)} мм`:`+${fmt(supply-wb.demand_mm,0)} мм`}</b></div>
    </div>
  `;
}

function areaBreakdownHtml(summary) {
  if(!summary)return '';
  const items=[['good','Підходить'],['conditional','Є обмеження'],['poor','Не підходить'],['unknown','Без даних'],['excluded','Поза аналізом']]
    .filter(([key])=>(summary.counts?.[key]||0)>0);
  if(!items.length)return '';
  const cov=validNumber(summary.coveragePct)&&summary.coveragePct<100&&summary.score!==null
    ?`<p class="drawer-note" style="margin:6px 0 0">Покриття: оцінено <b>${fmt(summary.coveragePct)}%</b> площі контуру; зони без повного профілю не обнуляють оцінку решти поля.</p>`:'';
  return `<div class="live-area-breakdown">${items.map(([key,label])=>`<span class="live-breakdown-chip"><i style="background:${STATUS_COLORS[key]}" aria-hidden="true"></i>${label}: <b>${fmt(summary.counts[key])}</b></span>`).join('')}</div>${cov}`;
}

function activeInsightTarget() {
  if(state.selected){
    const c=state.selected.properties?.center;
    if(c?.length>=2)return {lon:Number(c[0]),lat:Number(c[1])};
  }
  if(state.customArea)return parcelReferencePoint(state.customArea);
  return null;
}

function insightKey(target) {
  if(!target)return '';
  const cond=conditions();
  return `${target.lon.toFixed(4)},${target.lat.toFixed(4)}|${cond.crop}|${cond.year}|${cond.planting}|${cond.irrigation_mm}|${cond.irrigation_known}`;
}

function planningKey(target) {
  const ctx=planningContext(state);
  return target?`${Number(target.lon).toFixed(5)},${Number(target.lat).toFixed(5)}|${state.crop}|${state.mode}|${state.targetYear}|${state.scaleHa}|${ctx.irrigationSystem||''}|${ctx.cropGrowthStage||''}|${ctx.cropVariety||''}`:'';
}

async function loadPlanningReadiness(refresh=false) {
  const target=activeInsightTarget();
  if(state.step!==5||!target||!state.crop)return;
  const key=planningKey(target);
  const cached=planningCache.get(key);
  if(!refresh&&cached&&Date.now()-cached.fetchedAt<10*60*1000)return;
  if(!refresh&&planningLoadingKey===key)return;
  planningController?.abort();
  planningController=new AbortController();
  const identity=++planningRequestId;
  planningLoadingKey=key;planningErrorKey=null;
  renderDrawer();
  const ctx=planningContext(state);
  const params=new URLSearchParams({mode:state.mode,crop:state.crop,lon:String(target.lon),lat:String(target.lat),refresh:refresh?'1':'0',scale_ha:String(ctx.scaleHa)});
  if(state.targetYear)params.set('target_year',String(state.targetYear));
  if(ctx.irrigationSystem)params.set('irrigation_system',ctx.irrigationSystem);
  if(ctx.cropGrowthStage)params.set('crop_growth_stage',ctx.cropGrowthStage);
  if(ctx.cropVariety)params.set('crop_variety',ctx.cropVariety);
  try{
    const response=await fetch(`/api/planning-readiness?${params}`,{signal:planningController.signal});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);
    if(identity!==planningRequestId)return;
    planningCache.set(key,{data,fetchedAt:Date.now()});
    planningLoadingKey=null;
  }catch(error){
    if(error.name==='AbortError'||identity!==planningRequestId)return;
    planningLoadingKey=null;planningErrorKey=key;
  }
  if(state.step===5&&state.drawerOpen)renderDrawer();
}

function soilForecastHtml(data) {
  const sf=data?.soil_forecast;
  const guide=data?.indicative_guidance;
  if(!sf)return '';
  if(!sf.available||!sf.data)return `<span>Модельний прогноз ґрунту (Open-Meteo): ${escape(sf.reason||'недоступно.')}</span>`;
  const d=sf.data;
  const moistPct=v=>validNumber(v)?`${fmt(v*100,0)}%`:'—';
  const soilCheck=guide?.sowing_soil_check?.summary?`<span>${escape(guide.sowing_soil_check.summary)}</span>`:'';
  const irr=guide?.irrigation_7d_guidance;
  const irrHtml=irr?(
    irr.status==='calculated_with_user_params'
      ? `<span><b>7-денний орієнтир поливу (за вашою фазою й системою)</b><br>ET0 7 дн.: ${fmt(irr.et0_7d_mm,1)} мм · культура ETc (Kc=${fmt(irr.kc_used,2)}): ${fmt(irr.crop_etc_7d_mm,1)} мм · еф. опади: ${fmt(irr.effective_rain_7d_mm,1)} мм<br>Чистий дефіцит: <b>${fmt(irr.net_deficit_7d_mm,1)} мм</b>${validNumber(irr.gross_irrigation_7d_mm)?` · рекомендовано подати (ККД ${fmt(irr.system_efficiency*100,0)}%): <b>${fmt(irr.gross_irrigation_7d_mm,1)} мм</b>`:' (режим без поливу)'}</span>`
      : `<span><b>7-денний водний баланс ET0 (Open-Meteo)</b><br>Сумарне ET0: ${fmt(irr.et0_7d_mm,1)} мм · опади: ${fmt(irr.precipitation_7d_mm,1)} мм · орієнтовний дефіцит (Kc=${fmt(irr.kc_used,2)}): <b>${fmt(irr.net_deficit_7d_mm,1)} мм</b>.<br><small>Вкажіть фазу культури та тип поливу на Кроці 4 для точнішого перерахунку з урахуванням ККД.</small></span>`
  ):'';
  return `
    <span><b>Стан ґрунту · Open-Meteo (модельна сітка ~9–11 км, 7 дн.)</b><br>
    Темп. ґрунту зараз: 6 см <b>${validNumber(d.current_soil_temp_6cm_c)?`${fmt(d.current_soil_temp_6cm_c,1)} °C`:'—'}</b> · поверхня ${validNumber(d.current_soil_temp_0cm_c)?`${fmt(d.current_soil_temp_0cm_c,1)} °C`:'—'}<br>
    Діапазон 6 см (3 дн. мін / 7 дн. макс): ${validNumber(d.soil_temp_6cm_next_3d_min_c)?`${fmt(d.soil_temp_6cm_next_3d_min_c,1)}`:'—'} … ${validNumber(d.soil_temp_6cm_7d_max_c)?`${fmt(d.soil_temp_6cm_7d_max_c,1)}`:'—'} °C<br>
    Вологість (об’ємна): 0–1 см ${moistPct(d.current_soil_moisture_0_1_m3m3)} · 3–9 см ${moistPct(d.current_soil_moisture_3_9_m3m3)} · 9–27 см ${moistPct(d.current_soil_moisture_9_27_m3m3)}</span>
    ${soilCheck}
    ${irrHtml}
    ${(sf.provenance||[]).map(meta=>sourceLink(meta.source_url,'Джерело Open-Meteo')).join(' ')}
  `;
}

function pointPlanningHtml() {
  const key=planningKey(activeInsightTarget());
  if(!key)return '';
  const data=planningCache.get(key)?.data;
  if(!data)return `<section class="drawer-sub planning-point"><strong>Актуальні умови для планування</strong><span>${planningLoadingKey===key?'Отримуємо прогноз повітря NWS, ґрунт Open-Meteo та правила…':planningErrorKey===key?'Прогноз і правила зараз недоступні.':'Очікуємо оновлення даних…'}</span>${planningErrorKey===key?button('Оновити прогноз','reload-planning'):''}</section>`;
  const forecast=forecastOverview(data.forecast);
  const forecastSources=(data.forecast?.provenance||[]).map(meta=>sourceLink(meta.source_url,'Джерело NOAA/NWS')).join(' ');
  const forecastHtml=forecast?`<span><b>NOAA/NWS · повітря, найближчі 24 години</b><br>Температура повітря: ${formatRange(forecast.temperatureRangeC,' °C',1)}<br>Найбільша погодинна ймовірність опадів: ${forecast.maxRainProbabilityPct===null?'Без даних':`${fmt(forecast.maxRainProbabilityPct)}%`}<br>Випущено: ${dateTime(forecast.issuedAt)} · діє до ${dateTime(forecast.validTo)}</span>${forecastSources}`:`<span>Прогноз повітря NWS: ${escape(data.forecast?.reason||'Без даних для цієї точки.')}</span>`;
  const rule=agronomicRuleOverview(data.agronomic_rules);
  const ruleHtml=rule?`<span><b>Місцеві правила · ${cropName(state.crop)}</b><br>${rule.localGuideDiscouragesCrop?'Місцевий посібник застерігає щодо ярої форми цієї культури для Канзасу.<br>':''}${rule.temperatureRangeC?`Опублікований мінімум температури ґрунту: ${formatRange(rule.temperatureRangeC,' °C',1)}${rule.depthCm===null?'':` на глибині ${fmt(rule.depthCm,2)} см`}.`:'Перевіреного температурного порогу для автоматичної оцінки немає.'}${rule.verifiedAt?`<br>Джерело перевірено: ${escape(rule.verifiedAt)}`:''}</span>${sourceLink(rule.sourceUrl,'Правила K-State')}`:'<span>Місцеві агрономічні правила: без даних.</span>';
  return `<section class="drawer-sub planning-point"><strong>Актуальні умови й 7-денний орієнтир</strong><span>${state.selected?'Дані для центра вибраної зони.':'Дані для опорної точки контуру.'} Модельна сітка — орієнтир, а не датчик на полі.</span>${forecastHtml}${soilForecastHtml(data)}${ruleHtml}${data.critical_gaps?.length?`<details><summary>Чого ще бракує для повної польової автоматизації (${data.critical_gaps.length})</summary><ul class="live-missing-list">${data.critical_gaps.map(gap=>`<li>${escape(gap.message)}</li>`).join('')}</ul></details>`:''}${button('Оновити перевірку','reload-planning')}</section>`;
}

async function loadPointInsights(refresh=false) {
  const target=activeInsightTarget();
  if(state.step!==5||!target)return;
  const key=insightKey(target);
  if(!refresh&&insightsCache.has(key)){
    state.insightsLoading=false;state.insightsError=null;
    if(state.step===5&&state.drawerOpen)renderDrawer();
    return;
  }
  insightsController?.abort();
  insightsController=new AbortController();
  const reqId=++insightsReqId;
  state.insightsLoading=true;state.insightsError=null;
  renderDrawer();
  const cond=conditions();
  const params=new URLSearchParams({
    ...cond,
    lon:String(target.lon.toFixed(5)),
    lat:String(target.lat.toFixed(5)),
    years_back:'5',
    refresh:refresh?'1':'0'
  });
  try {
    const response=await fetch(`/api/insights?${params}`,{signal:insightsController.signal});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);
    if(reqId!==insightsReqId)return;
    insightsCache.set(key,data);
    state.insightsLoading=false;state.insightsError=null;
    if(state.step===5&&state.drawerOpen)renderDrawer();
  }catch(error){
    if(error.name==='AbortError'||reqId!==insightsReqId)return;
    state.insightsLoading=false;state.insightsError=error.message;
    if(state.step===5&&state.drawerOpen)renderDrawer();
  }
}

function drawerTabsHtml() {
  const tabs=[['overview','Огляд'],['compare','7 культур'],['risk','5 років'],['rotation','Сівозміна']];
  return `<div class="drawer-tabs" role="tablist" aria-label="Деталізація ділянки">${tabs.map(([id,label])=>`<button type="button" role="tab" aria-selected="${state.drawerTab===id}" class="drawer-tab ${state.drawerTab===id?'active':''}" data-action="drawer-tab" data-tab="${id}">${label}</button>`).join('')}</div>`;
}

function uncertaintyBoxHtml(uncertainty) {
  if(!uncertainty)return '';
  const range=uncertainty.score_range?`${fmt(uncertainty.score_range[0],0)}–${fmt(uncertainty.score_range[1],0)}`:'—';
  const agPct=validNumber(uncertainty.ag_share)?`${Math.round(uncertainty.ag_share*100)}%`:'—';
  const covPct=validNumber(uncertainty.coverage_ratio)?` · покриття: <b>${Math.round(uncertainty.coverage_ratio*100)}%</b>`:'';
  return `<div class="drawer-sub uncertainty-box"><strong>Невизначеність оглядової сітки (${fmt(uncertainty.sample_count)} точок)</strong><span>Розкид балів: <b>${range}</b> · с/г покрив (CDL): <b>${agPct}</b>${covPct} (${fmt(uncertainty.scored_samples)} оцінено, ${fmt(uncertainty.excluded_samples)} поза аналізом, ${fmt(uncertainty.unknown_samples)} без даних)</span></div>`;
}

function scalesContextHtml() {
  return `<div class="drawer-sub scale-box"><strong>Різні масштаби спостережень (NASA · USDA)</strong><span>POWER ~55 км · SMAP ~9 км · MODIS NDVI 250–500 м · SSURGO контур · CDL 10–30 м залежно від року</span></div>`;
}

function compareTabHtml(data) {
  const rows=data.crop_comparison||[];
  const t=data.tradeoffs||{};
  const coveredNote=data.landcover?.allow_analysis===false?`<p class="drawer-note" style="color:#784a19">У точці перевірки CDL визначено «${escape(data.landcover.label||data.landcover.category)}» — показано потенційні оцінки за ґрунтом і кліматом для порівняння.</p>`:'';
  return `
    ${coveredNote}
    <div class="tradeoffs-strip">
      ${t.best_suitability?`<div><span>Найвищий бал</span><b>${escape(t.best_suitability.name)} (${fmt(t.best_suitability.score,0)})</b></div>`:''}
      ${t.lowest_water_need?`<div><span>Мінімум води</span><b>${escape(t.lowest_water_need.name)} (${fmt(t.lowest_water_need.demand_mm,0)} мм)</b></div>`:''}
      ${t.lowest_cost?`<div><span>Мін. витрати</span><b>${escape(t.lowest_cost.name)} ($${fmt(t.lowest_cost.cost_per_ha,0)}/га)</b></div>`:''}
    </div>
    <div class="insights-list">
      ${rows.map(row=>{
        const s=row.score??row.potential_score;
        const st=row.score!==null?row.status:row.potential_status;
        const pct=validNumber(s)?Math.max(4,Math.round(s)):0;
        const cost=validNumber(row.economics?.cost_per_ha)?`$${fmt(row.economics.cost_per_ha,0)}/га`:'—';
        const price=validNumber(row.economics?.price_per_tonne)?`$${fmt(row.economics.price_per_tonne,0)}/т`:'—';
        const def=validNumber(row.deficit_mm)?(row.deficit_mm>0?`-${fmt(row.deficit_mm,0)} мм`:'0 мм'):'—';
        const lim=row.limiting_factor?tr(`factorNames.${row.limiting_factor}`,row.limiting_factor):'—';
        const active=row.crop===state.crop;
        return `
          <article class="insight-crop-card ${active?'current':''}">
            <div class="insight-crop-top">
              <strong>${escape(row.name)} ${active?'· обрано':''}</strong>
              <span class="status-pill ${escape(st||'unknown')}">${validNumber(s)?`${fmt(s,1)} / 100`:'—'}</span>
            </div>
            <div class="factor-track"><span class="factor-fill ${escape(st==='good'||st==='conditional'||st==='poor'?st:'unknown')}" style="width:${pct}%"></span></div>
            <div class="insight-crop-meta">
              <span>Дефіцит: <b>${def}</b></span>
              <span>Фактор: <b>${escape(lim)}</b></span>
              <span>Витрати: <b>${cost}</b></span>
              <span>Ціна: <b>${price}</b></span>
            </div>
            ${!active?`<button type="button" class="mini-switch-btn" data-action="use-insight-crop" data-crop="${escape(row.crop)}">Показати на карті</button>`:''}
          </article>
        `;
      }).join('')}
    </div>
  `;
}

function riskTabHtml(data) {
  const risk=data.climate_risk;
  const hist=data.landcover_history;
  if(!risk&&!hist)return '<p class="drawer-note">Немає даних для 5-річного перегляду поля.</p>';
  const histSection=hist?`
    <div class="drawer-sub">
      <strong>5-річна історія культур поля (USDA CDL, 10–30 м)</strong>
      <div class="history-5y-strip">
        ${(hist.years||[]).map(item=>{
          const label=item.crop_name||item.label||'Без даних';
          const isActive=Number(item.year)===Number(state.year);
          return `<div class="history-year-chip ${item.category==='cropland'?'cropland':''} ${isActive?'active':''}"><b>${item.year}</b><span>${escape(label)}</span><button type="button" class="mini-year-btn" data-action="inspect-history-year" data-year="${item.year}">${isActive?'Поточний рік':'На карту →'}</button></div>`;
        }).join('')}
      </div>
      <div class="monoculture-banner ${hist.monoculture_alert?'alert':'ok'}">${escape(hist.diagnosis||'')}</div>
      <small class="drawer-note">${escape(hist.note||'')}</small>
    </div>
  `:'';
  if(!risk)return histSection;
  const sum=risk.summary||{};
  const rainText=(validNumber(sum.rain_min_mm)&&validNumber(sum.rain_max_mm))?`${fmt(sum.rain_min_mm,0)}–${fmt(sum.rain_max_mm,0)} мм`:'—';
  const scoreText=(validNumber(sum.score_min)&&validNumber(sum.score_max))?`${fmt(sum.score_min,0)}–${fmt(sum.score_max,0)}`:'—';
  return `
    ${histSection}
    <div class="tradeoffs-strip">
      <div><span>Добрих / Умовних</span><b>${fmt(sum.good_count)} + ${fmt(sum.conditional_count)} із ${fmt(sum.years_scored)}</b></div>
      <div><span>Розмах балу</span><b>${scoreText}</b></div>
      <div><span>Опади за сезон</span><b>${rainText}</b></div>
    </div>
    <p class="drawer-note">${sum.heat_stress_years>0?`Дні зі спекою понад поріг фіксувались у ${fmt(sum.heat_stress_years)} з ${fmt(sum.years_scored)} сезонів.`:'Спекових перевищень понад поріг за цей період не зафіксовано.'}</p>
    <div class="insights-list">
      ${(risk.years||[]).map(y=>{
        const st=y.status||'unknown';
        const pct=validNumber(y.score)?Math.max(4,Math.round(y.score)):0;
        const wet=validNumber(y.root_zone_wetness)?`волог. корінь ${Math.round(y.root_zone_wetness*100)}%`:'';
        const cdlYear=(hist?.years||[]).find(h=>h.year===y.year);
        const cdlText=cdlYear?(cdlYear.crop_name||cdlYear.label):'';
        const isCurrent=Number(y.year)===Number(state.year);
        return `
          <div class="risk-year-row ${isCurrent?'current':''}">
            <div class="risk-year-head">
              <strong>${y.year}${cdlText?` · ${escape(cdlText)}`:''}</strong>
              <span>${validNumber(y.precipitation_mm)?`${fmt(y.precipitation_mm,0)} мм опадів`:'Неповний сезон'}${y.heat_days>0?` · спека ${y.heat_days} дн.`:''}${wet?` · ${wet}`:''}</span>
              <b>${validNumber(y.score)?`${fmt(y.score,0)}/100`:'—'}</b>
            </div>
            <div class="factor-track"><span class="factor-fill ${escape(st)}" style="width:${pct}%"></span></div>
            <button type="button" class="mini-switch-btn" data-action="inspect-history-year" data-year="${y.year}">${isCurrent?'Обраний рік на карті':`Переглянути ${y.year} на карті`}</button>
          </div>
        `;
      }).join('')}
    </div>
    <p class="drawer-note">${escape(risk.note||'')}</p>
  `;
}

function rotationTabHtml(data) {
  const rot=data.rotation_advice;
  if(!rot)return '<p class="drawer-note">Немає даних для підказки сівозміни.</p>';
  const anchorText=rot.anchor_source==='usda_cdl'
    ? `Базова культура за фактичним покривом USDA CDL (${escape(rot.cdl_label)}): <strong>${escape(rot.anchor_name)}</strong>`
    : `Сівозміна від вибраної культури: <strong>${escape(rot.anchor_name)}</strong>`;
  return `
    <p class="drawer-note">${anchorText}</p>
    <div class="insights-list">
      ${(rot.plans||[]).map(plan=>`
        <article class="insight-crop-card">
          <strong style="font-size:13px;color:var(--brand-ink)">${escape(plan.title)}</strong>
          <p class="drawer-note" style="margin:2px 0 6px">${escape(plan.focus)}</p>
          <div class="rotation-chain">
            ${(plan.steps||[]).map((st,i)=>`
              <div class="rotation-step">
                <span class="rot-season">${i===0?'Зараз':`Сезон +${i}`}</span>
                <div>
                  <b>${escape(st.name)}</b> <small>(${validNumber(st.score)?`${fmt(st.score,0)}/100`:'—'}${validNumber(st.deficit_mm)?` · дефіцит ${fmt(st.deficit_mm,0)} мм`:''})</small>
                  <span>${escape(st.role)}</span>
                </div>
              </div>
            `).join('')}
          </div>
        </article>
      `).join('')}
    </div>
    <p class="drawer-note">${escape(rot.caveat||'')}</p>
  `;
}

function insightsBodyHtml() {
  const target=activeInsightTarget();
  const key=insightKey(target);
  const data=key?insightsCache.get(key):null;
  if(state.insightsLoading&&!data)return '<div class="drawer-sub"><span class="live-loading-indicator" aria-hidden="true"></span> Рахуємо 7 культур, 5-річний ризик NASA POWER та сівозміну…</div>';
  if(state.insightsError&&!data)return `<p class="drawer-note" style="color:#8e301c">Не вдалося завантажити аналіз: ${escape(state.insightsError)}</p>${button('Спробувати знову','reload-insights')}`;
  if(!data)return '';
  if(state.drawerTab==='compare')return compareTabHtml(data);
  if(state.drawerTab==='risk')return riskTabHtml(data);
  if(state.drawerTab==='rotation')return rotationTabHtml(data);
  return '';
}

function renderDrawer() {
  const drawer=document.getElementById('map-drawer');
  if(!drawer)return;
  const feature=state.selected;
  const hasArea=!!state.customArea;
  const shouldShow=state.step===5&&state.drawerOpen&&(feature||hasArea);
  if(!shouldShow){
    drawer.hidden=true;
    drawer.innerHTML='';
    return;
  }
  drawer.hidden=false;
  if(state.drawerTab!=='overview'){
    const title=feature?featureName(feature):'Виділена територія';
    const sub=feature?cropName(state.crop):`≈ ${formatArea(state.areaSummary?.areaHa||0)}`;
    drawer.innerHTML=`
      <div class="drawer-head">
        <div>
          <span class="drawer-kicker">${escape(sub)} · ${state.year}</span>
          <h2>${escape(title)}</h2>
        </div>
        <button type="button" class="drawer-close" data-action="close-drawer" aria-label="Сховати панель">×</button>
      </div>
      ${drawerTabsHtml()}
      ${insightsBodyHtml()}
    `;
    return;
  }
  if(feature){
    const p=feature.properties,result=p?.result,status=result?.status||'unknown';
    drawer.innerHTML=`
      <div class="drawer-head">
        <div>
          <span class="drawer-kicker">${cropName(state.crop)} · ${waterScenarioLabel()}</span>
          <h2>${escape(featureName(feature))}</h2>
        </div>
        <button type="button" class="drawer-close" data-action="close-drawer" aria-label="Сховати панель">×</button>
      </div>
      ${hasArea?`<button type="button" class="link-button" data-action="back-to-area">← До загального кольору контуру</button>`:''}
      ${drawerTabsHtml()}
      <div class="live-status-row">${statusPill(status)}<span class="live-score">${validNumber(result?.score)?`${fmt(result.score)} <small>/ 100</small>`:''}</span></div>
      <p class="drawer-note">${tr(`statusInfo.${status}`)}</p>
      ${compareFieldsDrawerHtml()}
      ${pointPlanningHtml()}
      ${uncertaintyBoxHtml(result?.uncertainty)}
      ${factorBarsHtml(result?.factors,result?.limiting_factor)}
      ${waterBalanceHtml(result?.water_balance)}
      ${result?.missing?.length?`<ul class="live-missing-list">${result.missing.map(key=>`<li>${escape(tr(`missingNames.${key}`,key))}</li>`).join('')}</ul>`:''}
      ${landcoverCard(p.landcover)}
      ${soilCard(p.soil)}
      ${climateCard(p.climate)}
      ${scalesContextHtml()}
      ${economyCard()}
      <div class="live-toolbar">${button('Детальний звіт і формули','open-report','primary')}${button('Ближче до ґрунтів','detail')}${button('Формула','formula')}</div>
    `;
    return;
  }
  const summary=state.areaSummary;
  if(state.loading||!summary){
    drawer.innerHTML=`<div class="drawer-head"><div><h2>Рахуємо колір контуру…</h2></div><button type="button" class="drawer-close" data-action="close-drawer" aria-label="Сховати панель">×</button></div><p class="drawer-note">Отримуємо дані NASA й USDA для ${formatArea(summary?.areaHa||0)}.</p>`;
    return;
  }
  const status=summary.status||'unknown';
  const color=STATUS_COLORS[status]||STATUS_COLORS.unknown;
  drawer.innerHTML=`
    <div class="drawer-head">
      <div>
        <span class="drawer-kicker">${cropName(state.crop)} · ${waterScenarioLabel()}</span>
        <h2>Виділена територія</h2>
      </div>
      <button type="button" class="drawer-close" data-action="close-drawer" aria-label="Сховати панель">×</button>
    </div>
    ${drawerTabsHtml()}
    <div class="live-status-row">
      <span class="live-area-title-wrap"><span class="live-area-swatch" style="background:${color}" aria-hidden="true"></span>${statusPill(status)}</span>
      <span class="live-score">${validNumber(summary.score)?`${fmt(summary.score)} <small>/ 100</small>`:''}</span>
    </div>
    ${areaBreakdownHtml(summary)}
    ${compareFieldsDrawerHtml()}
    ${pointPlanningHtml()}
    ${factorBarsHtml(summary.avgFactors)}
    ${waterBalanceHtml(summary.avgWaterBalance)}
    <dl class="live-facts">
      <div><dt>Площа</dt><dd>${formatArea(summary.areaHa)}</dd></div>
      <div><dt>Зон у контурі</dt><dd>${fmt(summary.totalCount)} (${fmt(summary.scoredCount)} оцінено)</dd></div>
      <div><dt>pH ґрунту</dt><dd>${formatRange(summary.soilPhRange,'',1)}</dd></div>
      <div><dt>Температура</dt><dd>${formatRange(summary.tempRange,' °C',1)}</dd></div>
    </dl>
    ${scalesContextHtml()}
    <div class="live-toolbar">
      ${button('Детальний звіт і формули','open-report','primary')}
      ${button(state.areaDisplay==='solid'?'Зони всередині':'Суцільний колір','toggle-area-display')}
      ${button('Наблизити','detail')}
      ${button('Очистити','clear-area')}
    </div>
    ${economyCard()}
  `;
}

function landcoverCard(landcover) {
  if(!landcover)return '';
  const category=tr(`landcoverCategories.${landcover.category}`,landcover.label||'Без даних');
  return `<div class="drawer-sub"><strong>Вегетація й покрив (USDA CDL ${escape(landcover.year??'')}, 30 м)</strong><span>${escape(landcover.label||category)} · код ${fmt(landcover.code)}</span></div>`;
}

function soilCard(soil) {
  if(!soil)return '';
  return `<div class="drawer-sub"><strong>Ґрунт (SSURGO 0–30 см)</strong><span>pH ${fmt(soil.ph,1)} · схил ${fmt(soil.slope,1)}% · AWC ${fmt(soil.awc,2)}</span></div>`;
}

function climateCard(climate) {
  if(!climate)return '';
  const topWet=validNumber(climate.surface_wetness)?`${Math.round(climate.surface_wetness*100)}%`:'—';
  const rootWet=validNumber(climate.root_zone_wetness)?`${Math.round(climate.root_zone_wetness*100)}%`:'—';
  const dryDays=validNumber(climate.dry_root_days)?` · сухих днів: ${fmt(climate.dry_root_days)}`:'';
  return `
    <div class="drawer-sub"><strong>Погода (NASA POWER, ~55 км)</strong><span>${fmt(climate.mean_temperature,1)} °C · опади ${fmt(climate.precipitation_mm,0)} мм · ETc ${fmt(climate.crop_water_demand_mm,0)} мм</span></div>
    <div class="drawer-sub"><strong>Вологість ґрунту (POWER MERRA-2)</strong><span>Поверхня 0–5 см: <b>${topWet}</b> · корінь 0–100 см: <b>${rootWet}</b>${dryDays}</span></div>
  `;
}

function economyCard() {
  const data=economy(state.crop);
  return `<div class="drawer-sub"><strong>Економіка (USDA ERS ${data?.year||state.year})</strong><span>Витрати: ${unit(data?.cost_per_ha,'$/га')} · Ціна: ${unit(data?.price_per_tonne,'$/т')}</span></div>`;
}

function renderDrawBar() {
  const bar=document.getElementById('draw-bar');
  if(!bar)return;
  if(!state.drawMode){bar.hidden=true;bar.innerHTML='';return;}
  bar.hidden=false;
  const isPoly=state.drawMode==='polygon';
  const comparePrefix=awaitingCompareB&&compareFieldA
    ? `Поле А («${escape(compareFieldA.label)}») зафіксовано. Тепер окресліть 2-й контур (Поле Б): `
    : '';
  const hint=!isPoly
    ?'проведіть рамку по карті, щоб виділити область.'
    :state.drawPointsCount<3
    ?`клікайте по карті для точок межі (поставлено ${state.drawPointsCount}, потрібно щонайменше 3).`
    :`поставлено точок: ${state.drawPointsCount}. Натисніть зелену першу точку, двічі клікніть або «Завершити контур».`;
  bar.innerHTML=`<div class="live-draw-controls"><div class="live-draw-modes" role="group" aria-label="Режим виділення"><button type="button" class="${isPoly?'active':''}" data-action="draw-mode" data-mode="polygon">По точках</button><button type="button" class="${!isPoly?'active':''}" data-action="draw-mode" data-mode="rect">Рамка</button></div><div class="live-draw-buttons">${isPoly?`<button type="button" data-action="undo-point" ${state.drawPointsCount<1?'disabled':''}>Скасувати точку</button><button type="button" class="accent" data-action="finish-draw" ${state.drawPointsCount<3?'disabled':''}>Завершити контур</button>`:''}<button type="button" data-action="select-view">Усе вікно</button><button type="button" data-action="cancel-draw">Скасувати</button></div></div><p class="live-draw-hint">${comparePrefix}${comparePrefix?hint:hint.charAt(0).toUpperCase()+hint.slice(1)}</p>`;
}

function renderAreaBanner() {
  const banner=document.getElementById('area-banner');
  if(!banner)return;
  if(!state.customArea||state.drawMode){banner.hidden=true;banner.innerHTML='';return;}
  banner.hidden=false;
  const summary=state.areaSummary;
  if(state.loading||!summary){
    banner.innerHTML=`<div class="live-area-banner-main"><span class="live-loading-indicator" aria-hidden="true"></span><div><strong>Виділена територія</strong><span>Обчислюємо підсумковий колір…</span></div></div><div class="live-area-banner-actions"><button type="button" data-action="clear-area">Очистити</button></div>`;
    return;
  }
  const status=summary.status||'unknown';
  const color=STATUS_COLORS[status]||STATUS_COLORS.unknown;
  const scoreText=validNumber(summary.score)?` · ${fmt(summary.score)} / 100`:'';
  banner.innerHTML=`<div class="live-area-banner-main"><span class="live-area-swatch" style="background:${color}" aria-hidden="true"></span><div><strong>${tr(`statuses.${status}`)}${scoreText}</strong><span>≈ ${formatArea(summary.areaHa)} · ${fmt(summary.totalCount)} зон</span></div></div><div class="live-area-banner-actions"><button type="button" data-action="toggle-drawer">${state.drawerOpen?'Сховати деталі':'Показати деталі'}</button><button type="button" data-action="toggle-area-display">${state.areaDisplay==='solid'?'Зони всередині':'Суцільний колір'}</button><button type="button" data-action="clear-area">Очистити</button></div>`;
}

function updateMapText() {
  if(state.step===2){renderDrawBar();return;}
  if(state.step!==5)return;
  const drawBtn=document.getElementById('draw-area-button');
  if(drawBtn){
    drawBtn.textContent=state.drawMode?'Малюємо…':state.customArea?'Змінити контур':'Виділити по точках';
    drawBtn.classList.toggle('active',!!state.drawMode||!!state.customArea);
    drawBtn.setAttribute('aria-pressed',String(!!state.drawMode));
  }
  renderDrawBar();
  renderAreaBanner();
  renderDrawer();
  const status=document.getElementById('map-status');
  const visibleFeatures=state.customArea&&state.areaSummary?state.areaSummary.intersectingFeatures:(state.collection?.features||[]);
  const activeCount=visibleFeatures.length;
  const meta=state.meta;
  if(status){
    const signalText=state.signalLayer==='ndvi'
      ? `Шар NASA MODIS Terra NDVI 8-Day (250–500 м · ${state.year})`
      : state.signalLayer==='smap'
      ? `Шар NASA SMAP L4 вологість кореневої зони (~9 км · ${state.year})`
      : '';
    status.classList.toggle('error',!!state.error||!!state.validationError||!!meta?.truncated||(!state.loading&&!activeCount));
    status.hidden=!state.loading&&!state.error&&!state.validationError&&!meta?.truncated&&activeCount>0&&!signalText;
    if(state.validationError)status.textContent=state.validationError;
    else if(state.loading)status.innerHTML='<span class="live-loading-indicator" aria-hidden="true"></span> Отримуємо дані NASA POWER та USDA…';
    else if(state.error)status.textContent=`Помилка: ${state.error}`;
    else if(meta?.truncated)status.textContent=meta?.mode==='grid'?'Показано частину оглядової сітки. Наблизьте карту або виділіть ділянку.':'Показано перші 400 полігонів. Наблизьте карту або виділіть меншу ділянку.';
    else if(!activeCount)status.textContent=state.customArea?'Для виділеної області немає даних (перевірте, що контур у Канзасі).':'Перейдіть до Канзасу або наблизьте карту.';
    else if(signalText)status.textContent=signalText;
  }
  const refBtn=document.getElementById('refresh-button');
  if(refBtn)refBtn.disabled=state.loading||!!state.validationError;
}

function syncTopbarControls() {
  const qc=document.getElementById('quick-crop');
  if(qc)qc.value=state.crop;
  const ys=document.getElementById('year-select');
  if(ys)ys.value=String(state.year);
  const pd=document.getElementById('planting-date');
  if(pd){pd.min=`${state.year}-01-01`;pd.max=`${state.year}-12-31`;pd.value=state.planting;}
  ['no','yes','unknown'].forEach(mode=>{
    const btn=document.getElementById(`water-${mode}`);
    if(btn)btn.classList.toggle('active',state.irrigation===mode);
  });
  const mmWrap=document.getElementById('topbar-mm-wrap');
  if(mmWrap)mmWrap.hidden=state.irrigation!=='yes';
  const mmInput=document.getElementById('irrigation-mm');
  if(mmInput&&document.activeElement!==mmInput)mmInput.value=state.water;
  document.querySelectorAll('.mini-preset').forEach(btn=>{
    btn.classList.toggle('active',Number(state.water)===Number(btn.dataset.mm));
  });
}

function resultContextHtml() {
  return `<section class="result-context" aria-label="Умови поточного аналізу"><div><strong>${state.mode==='own_land'?'Моя ділянка':'Пошук придатних територій'} · ${cropName(state.crop)}</strong><p>${state.mode==='own_land'?`Контур ${formatArea(geodesicAreaHa(state.customArea?.ring))}`:`Канзас · бажана площа ${formatArea(Number(state.scaleHa))}`} · ${waterScenarioLabel()} · історичний сезон ${state.year}${state.targetYear?` · цільовий сезон ${escape(state.targetYear)}`:''}</p>${state.mode==='find_land'?'<small>Колір не підтверджує власність, доступність або цілісність ділянки бажаної площі.</small>':''}</div><div class="context-actions">${button('Змінити територію','go-territory')}${button('Змінити культуру','go-crops')}${button('Змінити умови','go-conditions')}</div></section>`;
}

function invalidateAnalysis() {
  clearTimeout(moveTimer);controller?.abort();requestId+=1;
  insightsController?.abort();insightsReqId+=1;
  planningController?.abort();planningRequestId+=1;planningLoadingKey=null;
  state.collection=null;state.areaSummary=null;state.selected=null;state.meta=null;
  state.loading=false;state.error=null;state.validationError=null;state.drawerOpen=false;
  if(state.mapReady){clearAnalysis();clearSelectedFeature();setSignalLayer('index',state.year);}
}

function renderView({focusId}={}) {
  renderProgress();
  const stage=document.getElementById('flow-stage');
  const mapWorkspace=document.getElementById('map-workspace');
  const results=state.step===5;
  const territoryMap=state.step===2&&state.mode==='own_land';
  const onMap=results||territoryMap;
  document.body.classList.toggle('on-map-stage',results);
  document.body.classList.toggle('on-territory-stage',territoryMap);
  const territoryFooter=document.getElementById('territory-footer');
  territoryFooter.hidden=!territoryMap;territoryFooter.innerHTML=territoryMap?territoryFooterHtml():'';
  stage.hidden=results;
  mapWorkspace.hidden=!onMap;
  document.querySelector('.map-legend-float').hidden=!results;
  document.getElementById('result-context').innerHTML=results?resultContextHtml():'';
  if(state.step===1)stage.innerHTML=welcomeScreen();
  else if(state.step===2)stage.innerHTML=territoryScreen();
  else if(state.step===3)stage.innerHTML=cropScreen();
  else if(state.step===4)stage.innerHTML=irrigationScreen();
  else stage.innerHTML='';
  if(onMap){
    renderMapTopbar();ensureMapReady();resizeMap();
    if(territoryMap){
      clearAnalysis();setSignalLayer('index',state.year);
      document.getElementById('map-status').hidden=true;
      document.getElementById('map-drawer').hidden=true;
      document.getElementById('area-banner').hidden=true;
      renderDrawBar();
    }else updateMapText();
  }
  if(focusId)document.getElementById(focusId)?.focus({preventScroll:true});
}

function syncNumericValidity() {
  const inputs=[...document.querySelectorAll('#scale-ha,#target-year,#irrigation-mm')];
  if(inputs.length)state.conditionsInputInvalid=inputs.some(input=>input.validity.badInput);
}
function validateWater() {
  syncNumericValidity();
  const input=document.getElementById('irrigation-mm');
  const invalid=state.irrigation==='yes'&&(input?.validity?.badInput||(state.water!==''&&(!validNumber(state.water)||Number(state.water)<0||Number(state.water)>5000)));
  state.validationError=invalid?'Вкажіть кількість води від 0 до 5000 мм.':null;
  input?.setAttribute('aria-invalid',String(invalid));
  const message=document.getElementById('water-validation');
  if(message){message.textContent=state.validationError||'';message.hidden=!invalid;}
  if(invalid&&state.step===5){
    clearTimeout(moveTimer);controller?.abort();requestId+=1;
    state.loading=false;state.error=null;state.collection=null;state.selected=null;
    clearAnalysis();updateMapText();announce(state.validationError);
  }
  return !invalid;
}

function conditions() {
  const water=irrigationInputState(state.irrigation,state.water);
  return {
    crop:state.crop,
    year:String(state.year),
    planting:state.planting,
    irrigation_mm:String(water.amountMm),
    irrigation_known:String(water.known)
  };
}

function applyAnalysisData(data) {
  const selectedId=state.selected?.properties?.id??state.selected?.id;
  data.features.forEach((feature,index)=>{feature.properties.ui_label=`Зона №${index+1}`;});
  state.collection=data;
  state.meta=data.meta||{};
  state.loading=false;
  state.areaSummary=state.customArea?aggregateTerritory(data.features,state.customArea.ring):null;
  setAnalysis(data,state.areaSummary);
  if(selectedId){
    const match=data.features.find(f=>String(f.properties?.id??f.id)===String(selectedId));
    state.selected=match||null;
    if(match&&(!state.areaSummary||state.areaSummary.intersectingIds.has(String(selectedId))))selectFeature(String(selectedId));
  }
  updateMapText();
  if(state.drawerOpen)loadPlanningReadiness(false);
  if(state.drawerOpen&&state.drawerTab!=='overview')loadPointInsights(false);
  if(awaitingCompareB&&compareFieldA&&state.areaSummary){
    awaitingCompareB=false;
    restoreOriginAfterCompare=!!compareOriginArea;
    openCompareFieldsModal();
  }
}

async function loadAnalysis(refresh=false) {
  if(state.step!==5||!state.mapReady||state.validationError||!canEnterStep(state,5))return;
  document.getElementById('result-context').innerHTML=resultContextHtml();
  const view=getView();
  const queryBbox=state.customArea?state.customArea.bbox:view.bbox;
  const queryZoom=state.customArea?recommendedZoomForArea(state.customArea.bbox,view.zoom):view.zoom;
  const cond=conditions();
  clearTimeout(moveTimer);controller?.abort();
  const identity=++requestId;

  if(!refresh){
    const cached=findCachedAnalysis(cond,queryBbox,queryZoom);
    if(cached){
      state.cacheHit=true;
      state.error=null;
      applyAnalysisData(cached);
      return;
    }
  }
  state.cacheHit=false;
  clearAnalysis();state.collection=null;state.areaSummary=null;state.meta=null;
  controller=new AbortController();
  state.loading=true;state.error=null;
  updateMapText();
  const params=new URLSearchParams({...cond,bbox:queryBbox.map(v=>v.toFixed(6)).join(','),zoom:String(queryZoom),refresh:refresh?'1':'0'});
  try {
    const response=await fetch(`/api/analysis?${params}`,{signal:controller.signal});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);
    if(data.type!=='FeatureCollection'||!Array.isArray(data.features))throw new Error('Невідомий формат відповіді сервера');
    if(identity!==requestId)return;
    storeCachedAnalysis(cond,queryBbox,queryZoom,data);
    applyAnalysisData(data);
    loadSources();
    announce(`Карту оновлено. ${cropName(state.crop)}.`);
  }catch(error){
    if(error.name==='AbortError'||identity!==requestId)return;
    state.loading=false;state.error=error.message;state.meta=null;state.selected=null;state.collection=null;state.areaSummary=null;
    clearAnalysis();updateMapText();announce('Не вдалося отримати дані.');
  }
}

function scheduleAnalysis(delay=500) {
  if(state.step!==5)return;
  clearTimeout(moveTimer);
  moveTimer=setTimeout(()=>loadAnalysis(false),delay);
}

async function loadEconomics(refresh=false,check=false) {
  const year=state.year;
  await Promise.allSettled(CROP_IDS.map(async crop=>{
    const key=economyKey(crop,year);
    if(state.economics[key]&&!refresh&&!check)return;
    try {
      const response=await fetch(`/api/economics?${new URLSearchParams({crop,year:String(year),refresh:refresh?'1':'0'})}`);
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);
      state.economics[key]=data;delete state.economicsErrors[key];
    }catch(error){
      state.economics[key]={crop,year,cost_per_ha:null,price_per_tonne:null,missing:['economics']};
      state.economicsErrors[key]=error.message;
    }
    if(state.year===year){
      if(state.step===3){
        // Keep the focused crop and Next buttons stable while independent
        // provider requests finish; replacing the stage can swallow a click.
        const card=document.getElementById(`crop-${crop}`);
        const data=economy(crop);
        const values=card?.querySelector('.mini-economy');
        const period=card?.querySelector('.econ-period');
        if(values)values.innerHTML=`<div><span>Витрати</span><b>${unit(data?.cost_per_ha,'$/га')}</b></div><div><span>Ціна продажу</span><b>${unit(data?.price_per_tonne,'$/т')}</b></div>`;
        if(period)period.textContent=`${data?.region||'USDA ERS'} · ${data?.year||state.year}`;
      }
      else if(state.step===5)renderDrawer();
      if(dialog.open&&dialog.dataset.type==='compare')renderDialog('compare',false);
    }
  }));
}

function stageRenderPreservingScroll() {
  if(state.step===3){
    const y=window.scrollY;
    renderProgress();
    document.getElementById('flow-stage').innerHTML=cropScreen();
    window.scrollTo({top:y});
  }
}

async function loadSources() {
  try{const response=await fetch('/api/sources');if(!response.ok)throw new Error();state.sources=await response.json();}
  catch{state.sources={sources:[],error:'Не вдалося отримати статус джерел.'};}
}

function ensureMapReady() {
  if(state.mapReady)return;
  try {
    initMap({
      move:()=>{if(state.step===5&&!state.customArea)scheduleAnalysis(450);},
      select:selectZone,
      areaChange:handleAreaChange,
      drawProgress:count=>{if(state.drawMode==='polygon'){state.drawPointsCount=count;renderDrawBar();}},
      tileError:()=>{if(!state.tileError){state.tileError=true;updateMapText();}}
    });
    state.mapReady=true;
  }catch(error){
    state.loading=false;state.error=error.message;
    updateMapText();
  }
}

function setStep(step) {
  if(state.step===4||state.step===5)syncNumericValidity();
  if(!canEnterStep(state,step))return;
  const previousStep=state.step;
  if(step!==state.step&&state.drawMode)exitDrawMode();
  if(step!==5)invalidateAnalysis();
  state.step=step;
  state.maxStep=Math.max(state.maxStep,step);
  renderView({focusId:'page-title'});
  if(step===2&&state.mode==='own_land')requestAnimationFrame(()=>{resizeMap();if(state.customArea)fitCustomArea();else focusKansas();});
  if(step===3)loadEconomics();
  if(step===5){
    requestAnimationFrame(()=>{
      resizeMap();
      if(previousStep!==5){if(state.mode==='own_land')fitCustomArea();else focusKansas();}
      loadAnalysis(false);
    });
  }
  if(window.innerWidth<=820)window.scrollTo({top:0,behavior:'smooth'});
  announce(`Етап ${step}: ${flowStepNames[step-1]}`);
}

function selectZone(feature) {
  state.selected=feature;
  state.drawerOpen=true;
  if(state.step!==5)return;
  updateMapText();
  loadPlanningReadiness(false);
  if(state.drawerTab!=='overview')loadPointInsights(false);
  announce(`${featureName(feature)}. ${tr('statuses.'+(feature.properties?.result?.status||'unknown'))}`);
}

function cloneArea(area) {
  if(!area?.ring)return null;
  return {
    kind:area.kind==='rect'?'rect':'polygon',
    ring:area.ring.map(p=>[...p]),
    bbox:area.bbox?[...area.bbox]:undefined
  };
}

function restoreOriginalFieldAfterCompare() {
  const origin=cloneArea(compareOriginArea);
  compareOriginArea=null;
  restoreOriginAfterCompare=false;
  compareFieldA=null;
  compareFieldB=null;
  awaitingCompareB=false;
  if(!origin||state.step!==5)return;
  invalidateAnalysis();
  state.customArea=origin;
  if(state.mode==='own_land')state.ownArea=origin;
  state.scaleHa=String(geodesicAreaHa(origin.ring));
  state.drawerOpen=true;
  if(state.mapReady){
    setCustomArea(origin);
    fitCustomArea();
  }
  updateMapText();
  loadAnalysis(false);
  announce('Повернуто до вашої початкової ділянки.');
}

function handleAreaChange(area) {
  const validationCandidate={...state,customArea:area};
  const validation=validateTerritory(validationCandidate);
  if(state.step===5&&awaitingCompareB&&!validation.valid&&compareOriginArea){
    restoreOriginalFieldAfterCompare();
    state.error=validation.error||'2-й контур поза межами пілотної області Канзасу.';
    updateMapText();
    announce(state.error);
    return;
  }
  state.customArea=area;
  if(state.mode==='own_land')state.ownArea=area;
  state.drawMode=null;state.drawPointsCount=0;
  state.cropOptions=null;state.cropOptionsError=null;
  invalidateAnalysis();
  state.territoryError=validation.valid?null:validation.error;
  if(validation.areaHa)state.scaleHa=String(validation.areaHa);
  setAreaDisplayMode('solid');
  if(state.step===2){renderView();fitCustomArea();}
  else if(state.step===5){
    if(!validation.valid){state.step=2;renderView({focusId:'page-title'});}
    else{state.drawerOpen=true;updateMapText();loadAnalysis(false);}
  }
  announce(validation.valid?'Контур обрано. Перейдіть до вибору культури.':validation.error||'Перевірте межі контуру.');
}

function enterDrawMode(mode='polygon') {
  state.drawMode=mode==='rect'?'rect':'polygon';
  state.drawPointsCount=0;
  startAreaSelection(state.drawMode);
  updateMapText();
  document.getElementById('live-map')?.scrollIntoView({block:'center',behavior:'smooth'});
}

function exitDrawMode() {
  const wasCompare=awaitingCompareB;
  awaitingCompareB=false;
  if(wasCompare){compareOriginArea=null;restoreOriginAfterCompare=false;}
  state.drawMode=null;
  state.drawPointsCount=0;
  if(wasCompare&&state.step===5&&(state.customArea||state.selected))state.drawerOpen=true;
  cancelAreaSelection();
  updateMapText();
}

function removeCustomArea() {
  invalidateAnalysis();
  state.customArea=null;
  if(state.mode==='own_land'){state.ownArea=null;state.scaleHa='';}
  state.cropOptions=null;state.cropOptionsError=null;
  clearCustomArea();
  if(state.mode==='own_land')setStep(2);
  else{renderView();loadAnalysis(false);}
  announce('Виділення очищено.');
}

function setCrop(newCrop) {
  if(!CROP_IDS.includes(newCrop))return;
  invalidateAnalysis();
  state.crop=newCrop;
  if(!state.plantingManual&&historicalScenarioDate(newCrop,state.year)){
    state.planting=historicalScenarioDate(newCrop,state.year);
  }
}

function dialogHeader(title) {
  return `<div class="dialog-header"><h2 id="dialog-title" tabindex="-1">${title}</h2><button type="button" class="close-dialog" data-action="close-dialog" aria-label="Закрити">×</button></div>`;
}

function captureCurrentFieldSnapshot() {
  const target=activeInsightTarget();
  const iKey=insightKey(target);
  const ins=iKey?insightsCache.get(iKey):null;
  if(state.selected){
    const p=state.selected.properties||{};
    const r=p.result||{};
    return createFieldSnapshot({
      label:featureName(state.selected),
      crop:state.crop,
      cropName:cropName(state.crop),
      year:state.year,
      planting:state.planting,
      irrigationLabel:waterScenarioLabel(),
      areaHa:null,
      coordinates:p.center||(target?[target.lon,target.lat]:null),
      status:r.status,
      score:r.score,
      factors:r.factors,
      limitingFactor:r.limiting_factor,
      waterBalance:r.water_balance,
      soil:p.soil||ins?.soil||null,
      landcoverHistory:ins?.landcover_history||null,
      climateRisk:ins?.climate_risk||null
    });
  }
  if(state.areaSummary){
    const s=state.areaSummary;
    const minF=Object.entries(s.avgFactors||{}).sort((a,b)=>a[1]-b[1])[0]?.[0]||null;
    return createFieldSnapshot({
      label:`Контур (${formatArea(s.areaHa)})`,
      crop:state.crop,
      cropName:cropName(state.crop),
      year:state.year,
      planting:state.planting,
      irrigationLabel:waterScenarioLabel(),
      areaHa:s.areaHa,
      coordinates:target?[target.lon,target.lat]:null,
      status:s.status,
      score:s.score,
      factors:s.avgFactors,
      limitingFactor:minF,
      waterBalance:s.avgWaterBalance,
      soil:ins?.soil||null,
      coveragePct:s.coveragePct,
      soilPhRange:s.soilPhRange,
      tempRange:s.tempRange,
      landcoverHistory:ins?.landcover_history||null,
      climateRisk:ins?.climate_risk||null
    });
  }
  return null;
}

async function ensureSnapshotInsights(snapshot) {
  if(!snapshot||!snapshot.coordinates||(snapshot.landcoverHistory&&snapshot.climateRisk))return;
  const [lon,lat]=snapshot.coordinates;
  const cond=conditions();
  const params=new URLSearchParams({
    crop:snapshot.crop||cond.crop,
    year:String(snapshot.year||cond.year),
    planting:snapshot.planting||cond.planting,
    irrigation_mm:cond.irrigation_mm,
    irrigation_known:cond.irrigation_known,
    lon:String(Number(lon).toFixed(5)),
    lat:String(Number(lat).toFixed(5)),
    years_back:'5',
    refresh:'0'
  });
  try{
    const resp=await fetch(`/api/insights?${params}`);
    if(!resp.ok)return;
    const data=await resp.json();
    snapshot.landcoverHistory=data.landcover_history||null;
    snapshot.climateRisk=data.climate_risk||null;
    if(!snapshot.soil&&data.soil)snapshot.soil=data.soil;
  }catch{}
}

function compareFieldsDrawerHtml() {
  const cur=captureCurrentFieldSnapshot();
  if(!cur)return '';
  if(!compareFieldA){
    return `<div class="compare-2-box"><div><strong>Порівняння 2 полів поруч</strong><span>Зафіксуйте цю ділянку як Поле А та одразу окресліть 2-й контур для порівняння.</span></div><button type="button" class="secondary" data-action="pin-compare-a">Порівняти з іншою ділянкою</button></div>`;
  }
  const same=compareFieldA.id===cur.id;
  return `<div class="compare-2-box active"><div><strong>Поле А: ${escape(compareFieldA.label)}</strong><span>${escape(compareFieldA.cropName)} · ${compareFieldA.score!==null?`${fmt(compareFieldA.score,1)}/100`:escape(compareFieldA.statusLabel)}</span></div><div class="compare-2-actions">${!same?`<button type="button" class="primary" data-action="compare-with-a">Порівняти з Полем А</button>`:''}<button type="button" class="secondary" data-action="draw-compare-b">Намалювати 2-й контур</button><button type="button" class="secondary" data-action="clear-compare-fields">Скинути</button></div></div>`;
}

async function openCompareFieldsModal() {
  if(!compareFieldA)return;
  compareFieldB=captureCurrentFieldSnapshot();
  if(!compareFieldB)return;
  renderDialog('compare-fields',true);
  await Promise.allSettled([ensureSnapshotInsights(compareFieldA),ensureSnapshotInsights(compareFieldB)]);
  if(dialog.open&&dialog.dataset.type==='compare-fields')renderDialog('compare-fields',false);
}

function buildCurrentReport() {
  const target=activeInsightTarget();
  const iKey=insightKey(target);
  const pKey=planningKey(target);
  const water=irrigationInputState(state.irrigation,state.water);
  return buildCalculationReport({
    crop:state.crop,
    cropName:cropName(state.crop),
    year:state.year,
    planting:state.planting,
    irrigationMode:state.irrigation,
    irrigationMm:water.amountMm,
    irrigationKnown:water.known,
    targetYear:state.targetYear,
    scaleHa:state.scaleHa,
    mode:state.mode,
    selected:state.selected,
    areaSummary:state.areaSummary,
    insights:iKey?insightsCache.get(iKey):null,
    planning:pKey?planningCache.get(pKey)?.data:null,
    economics:economy(state.crop),
    sources:state.sources,
    meta:state.meta
  });
}

async function openReportModal() {
  lastReport=buildCurrentReport();
  renderDialog('report',true);
  const target=activeInsightTarget();
  const pending=[];
  if(!state.sources)pending.push(loadSources());
  if(target){
    const iKey=insightKey(target);
    const pKey=planningKey(target);
    if(iKey&&!insightsCache.has(iKey))pending.push(loadPointInsights(false));
    if(pKey&&!planningCache.has(pKey))pending.push(loadPlanningReadiness(false));
  }
  if(pending.length){
    await Promise.allSettled(pending);
    if(dialog.open&&dialog.dataset.type==='report'){
      lastReport=buildCurrentReport();
      renderDialog('report',false);
    }
  }
}

function renderDialog(type,show=true) {
  if(show)dialogTrigger=document.activeElement;
  dialog.dataset.type=type;
  dialog.className=type==='compare'?'compare-dialog':(type==='report'||type==='compare-fields')?'compare-dialog report-dialog':'';
  let title='',content='';
  if(type==='report'){
    title='Детальний звіт обчислень та формул';
    lastReport=lastReport||buildCurrentReport();
    content=renderReportDialogHtml(lastReport);
  }else if(type==='compare-fields'){
    title='Порівняння двох полів (Поле А vs Поле Б)';
    content=(compareFieldA&&compareFieldB)?renderFieldCompareDialogHtml(compareTwoFields(compareFieldA,compareFieldB)):'<p class="live-dialog-text">Спочатку зафіксуйте Поле А та оберіть друге поле для порівняння.</p>';
  }else if(type==='help') {
    title='Як працює GrowWhere';
    content=`<p class="live-dialog-text">Послідовність роботи:</p><div class="help-list">${[['1. Спосіб пошуку','Оберіть свою ділянку або пошук придатних територій.'],['2. Територія','Позначте замкнений контур у пілотній області Канзасу або оберіть Канзас як область пошуку.'],['3. Культура',`Оберіть одну з ${CROP_IDS.length} культур. Для своєї ділянки доступне попереднє історичне порівняння в центральній точці.`],['4. Умови','Вкажіть масштаби та доступність поливу. Історичний сезон і майбутній цільовий рік — окремі параметри.'],['5. Карта результатів','Перевірте колір, джерела й прогалини. Дата майбутньої посадки й рекомендована кількість поливу ще недоступні.']].map(([head,text],i)=>`<div class="help-item"><span class="step-num">${String(i+1).padStart(2,'0')}</span><div><h3>${head}</h3><p>${text}</p></div></div>`).join('')}</div>${button('Зрозуміло','close-dialog','primary')}`;
  }else if(type==='compare') {
    title='Порівняння культур (USDA ERS)';
    content=`<p class="live-dialog-text">Регіональні витрати та ціни за ${state.year} рік.</p><div class="live-compare-grid">${CROP_IDS.map(crop=>{const data=economy(crop);return `<article class="live-compare-item"><h3>${cropName(crop)}</h3><dl><div><dt>Витрати</dt><dd>${unit(data?.cost_per_ha,'$/га')}</dd></div><div><dt>Ціна</dt><dd>${unit(data?.price_per_tonne,'$/т')}</dd></div><div><dt>Опт. температура</dt><dd>${escape(copy.cropNotes[crop]?.temp||'')}</dd></div></dl><button type="button" class="secondary" data-action="compare-crop" data-crop="${crop}">Обрати ${cropName(crop)}</button></article>`;}).join('')}</div>`;
  }else {
    title=type==='formula'?'Формула придатності та дані':'Джерела, кешування й обмеження';
    const sourceRows=state.sources?.sources||[];
    const weights=state.meta?.weights||{water:.3,temperature:.2,ph:.15,awc:.1,drainage:.1,slope:.1,texture:.05};
    content=`<p class="live-dialog-text">Розрахунок поєднує клімат <strong>NASA POWER</strong>, ґрунти <strong>USDA SSURGO</strong>, покрив <strong>USDA CDL</strong> та економіку <strong>USDA ERS</strong>.</p><div class="live-dialog-formula">f_water = clamp((0.8 × P_mm + irrigation_mm) / ETc_mm)<br>G = 100 × exp(Σ wᵢ × ln(fᵢ))<br>Якщо min(fᵢ) &lt; 0.10 → S = min(G, 100 × √min(fᵢ))</div><p class="live-dialog-text">Потреба у воді ETc рахується щодня за FAO-56 Penman–Monteith. Жорстка стеля діє лише при критичному обмеженні (&lt; 0.10), щоб полив чітко впливав на придатність.</p><div class="live-factor-list">${Object.entries(weights).map(([k,v])=>`<div class="live-factor"><span>${escape(tr(`factorNames.${k}`,k))}</span><b>${fmt(v*100)}%</b></div>`).join('')}</div><h3 style="margin:20px 0 10px">Підключені джерела</h3><div class="live-sources-list">${sourceRows.length?sourceRows.map(source=>`<article><h3>${escape(source.name||source.id)}</h3><p><strong>${source.status==='connected'?'Підключено':'Не підключено'}</strong> · ${escape(source.role||'')}</p>${sourceLink(source.url||source.source_url,'Офіційне джерело')}</article>`).join(''):'<p class="live-dialog-text">Статус джерел завантажиться після першого запиту до сервера.</p>'}</div><div style="margin-top:20px">${button('Закрити','close-dialog','primary')}</div>`;
  }
  dialog.innerHTML=`<div class="dialog-body">${dialogHeader(title)}${content}</div>`;
  if(show){dialog.showModal();dialog.querySelector('h2').focus();}
}

document.addEventListener('click',event=>{
  const target=event.target.closest('[data-action]');
  if(!target||target.disabled)return;
  const action=target.dataset.action;
  if(action==='home')setStep(1);
  else if(action==='choose-mode'){
    const mode=target.dataset.mode;
    if(!['own_land','find_land'].includes(mode))return;
    if(state.mode==='own_land')state.ownArea=state.customArea;
    if(state.mode==='find_land')state.searchScaleHa=state.scaleHa;
    invalidateAnalysis();state.mode=mode;
    state.customArea=mode==='own_land'?state.ownArea:null;
    state.scaleHa=mode==='own_land'?(state.customArea?String(geodesicAreaHa(state.customArea.ring)):''):state.searchScaleHa;
    if(state.mapReady)setCustomArea(state.customArea);
    setStep(2);
  }
  else if(action==='go-territory')setStep(2);
  else if(action==='choose-region'){state.searchRegion='kansas';renderView();}
  else if(action==='go-crops')setStep(3);
  else if(action==='crop-help')loadCropOptions();
  else if(action==='go-conditions')setStep(4);
  else if(action==='go-map'){
    if(!validateWater()||!validateConditions(state).valid||['scale-ha','target-year','planting-date'].some(id=>document.getElementById(id)?.validity?.badInput))return;
    setStep(5);
  }
  else if(action==='step')setStep(Number(target.dataset.step));
  else if(action==='crop'){
    setCrop(target.dataset.crop);
    if(state.step===3){stageRenderPreservingScroll();document.getElementById(`crop-${state.crop}`)?.focus({preventScroll:true});}
    else{syncTopbarControls();loadAnalysis();}
  }else if(action==='water'){
    invalidateAnalysis();
    state.irrigation=target.dataset.value;
    state.validationError=null;
    if(state.step===4){renderProgress();document.getElementById('flow-stage').innerHTML=irrigationScreen();document.getElementById(`water-${state.irrigation}`)?.focus({preventScroll:true});}
    else if(state.step===5){syncTopbarControls();if(validateWater())loadAnalysis();}
  }else if(action==='water-preset'){
    invalidateAnalysis();
    state.irrigation='yes';
    state.water=String(target.dataset.mm);
    state.validationError=null;
    if(state.step===4){renderProgress();document.getElementById('flow-stage').innerHTML=irrigationScreen();}
    else if(state.step===5){syncTopbarControls();loadAnalysis();}
  }else if(action==='irrigation-system'){
    const val=target.dataset.value;
    state.irrigationSystem=state.irrigationSystem===val?null:val;
    planningCache.clear();
    if(state.step===4)stageRenderPreservingScroll();
    else if(state.step===5)loadPlanningReadiness(false);
  }else if(action==='growth-stage'){
    const val=target.dataset.value;
    state.cropGrowthStage=state.cropGrowthStage===val?null:val;
    planningCache.clear();
    if(state.step===4)stageRenderPreservingScroll();
    else if(state.step===5)loadPlanningReadiness(false);
  }else if(action==='crop-variety'){
    const val=target.dataset.value;
    state.cropVariety=state.cropVariety===val?null:val;
    planningCache.clear();
    if(state.step===4)stageRenderPreservingScroll();
    else if(state.step===5)loadPlanningReadiness(false);
  }else if(action==='basemap'){
    state.baseMap=target.dataset.mode==='osm'?'osm':'satellite';
    setBaseLayer(state.baseMap);
    document.getElementById('basemap-satellite')?.classList.toggle('active',state.baseMap==='satellite');
    document.getElementById('basemap-osm')?.classList.toggle('active',state.baseMap==='osm');
  }else if(action==='signal-layer'){
    state.signalLayer=['ndvi','smap'].includes(target.dataset.mode)?target.dataset.mode:'index';
    setSignalLayer(state.signalLayer,state.year);
    ['index','ndvi','smap'].forEach(mode=>document.getElementById(`signal-${mode}`)?.classList.toggle('active',state.signalLayer===mode));
    updateMapText();
  }else if(action==='drawer-tab'){
    const tab=target.dataset.tab||'overview';
    state.drawerTab=tab;
    renderDrawer();
    if(tab!=='overview')loadPointInsights(false);
  }else if(action==='use-insight-crop'){
    const newCrop=target.dataset.crop;
    if(newCrop&&CROP_IDS.includes(newCrop)){
      setCrop(newCrop);
      syncTopbarControls();
      loadAnalysis();
    }
  }else if(action==='reload-insights'){
    loadPointInsights(true);
  }else if(action==='reload-planning'){
    loadPlanningReadiness(true);
  }else if(action==='cycle-opacity'){
    const steps=[0.42,0.72,0];
    const idx=steps.findIndex(v=>Math.abs(v-state.overlayOpacity)<0.05);
    state.overlayOpacity=steps[(idx+1)%steps.length];
    setOverlayOpacity(state.overlayOpacity);
    const opBtn=document.getElementById('opacity-button');
    if(opBtn)opBtn.textContent=`Шар: ${Math.round(state.overlayOpacity*100)}%`;
  }else if(action==='kansas')focusKansas();
  else if(action==='detail')focusDetail();
  else if(action==='draw-area'){if(state.drawMode)exitDrawMode();else enterDrawMode('polygon');}
  else if(action==='draw-rect')enterDrawMode('rect');
  else if(action==='draw-mode'){enterDrawMode(target.dataset.mode||'polygon');}
  else if(action==='undo-point'){state.drawPointsCount=undoLastPolygonPoint();renderDrawBar();}
  else if(action==='finish-draw'){finishPolygonSelection();}
  else if(action==='cancel-draw'){exitDrawMode();}
  else if(action==='select-view'){selectCurrentViewArea();}
  else if(action==='clear-area'){removeCustomArea();}
  else if(action==='back-to-area'){state.selected=null;state.drawerOpen=true;clearSelectedFeature();updateMapText();}
  else if(action==='close-drawer'){state.drawerOpen=false;state.selected=null;clearSelectedFeature();renderDrawer();renderAreaBanner();}
  else if(action==='toggle-drawer'){state.drawerOpen=!state.drawerOpen;renderDrawer();renderAreaBanner();}
  else if(action==='toggle-area-display'){state.areaDisplay=state.areaDisplay==='solid'?'zones':'solid';setAreaDisplayMode(state.areaDisplay);renderAreaBanner();renderDrawer();}
  else if(action==='refresh'){analysisCache.clear();insightsCache.clear();planningCache.clear();loadAnalysis(true);loadEconomics(true);loadSources();if(state.drawerOpen){loadPlanningReadiness(true);if(state.drawerTab!=='overview')loadPointInsights(true);}}
  else if(action==='text-size'){state.large=!state.large;document.body.classList.toggle('large-text',state.large);target.setAttribute('aria-pressed',String(state.large));resizeMap();}
  else if(['help','compare','formula','sources'].includes(action)){
    if(action==='sources'&&!state.sources)loadSources().then(()=>renderDialog('sources'));
    else renderDialog(action);
  }else if(action==='open-report'){
    openReportModal();
  }else if(action==='download-report-pdf'){
    lastReport=lastReport||buildCurrentReport();
    target.disabled=true;
    const origText=target.textContent;
    target.textContent='Формуємо PDF…';
    fetch('/api/report-pdf',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(lastReport)
    }).then(async resp=>{
      if(!resp.ok){
        const err=await resp.json().catch(()=>({}));
        throw new Error(err.error||`HTTP ${resp.status}`);
      }
      return resp.blob();
    }).then(blob=>{
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;
      a.download=`growwhere-report-${state.crop||'field'}-${state.year}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1500);
    }).catch(err=>{
      announce(`Не вдалося зберегти PDF: ${err.message}`);
    }).finally(()=>{
      target.disabled=false;
      target.textContent=origText;
    });
  }else if(action==='pin-compare-a'){
    const snap=captureCurrentFieldSnapshot();
    if(snap){
      if(!compareOriginArea&&state.customArea)compareOriginArea=cloneArea(state.customArea);
      compareFieldA=snap;
      ensureSnapshotInsights(compareFieldA);
      awaitingCompareB=true;
      state.drawerOpen=false;
      enterDrawMode('polygon');
      announce(`Поле А зафіксовано: ${snap.label}. Тепер намалюйте 2-й контур для порівняння.`);
    }
  }else if(action==='draw-compare-b'){
    if(compareFieldA){
      if(!compareOriginArea&&state.customArea)compareOriginArea=cloneArea(state.customArea);
      awaitingCompareB=true;
      state.drawerOpen=false;
      enterDrawMode('polygon');
      announce('Намалюйте 2-й контур на карті для порівняння з Полем А.');
    }
  }else if(action==='compare-with-a'){
    openCompareFieldsModal();
  }else if(action==='swap-compare-fields'){
    if(compareFieldA&&compareFieldB){
      const tmp=compareFieldA;compareFieldA=compareFieldB;compareFieldB=tmp;
      renderDialog('compare-fields',false);
    }
  }else if(action==='clear-compare-fields'){
    const shouldRestore=restoreOriginAfterCompare||!!compareOriginArea;
    if(dialog.open&&dialog.dataset.type==='compare-fields'){
      dialog.close();
      if(shouldRestore&&compareOriginArea)restoreOriginalFieldAfterCompare();
    }else if(shouldRestore){
      restoreOriginalFieldAfterCompare();
    }else{
      compareFieldA=null;compareFieldB=null;awaitingCompareB=false;
      renderDrawer();
    }
  }else if(action==='inspect-history-year'){
    const y=Number(target.dataset.year);
    if(Number.isInteger(y)&&y>=1984&&y<=currentYear){
      invalidateAnalysis();
      state.year=y;
      state.planting=`${y}-${state.planting.slice(5)}`;
      syncTopbarControls();
      setSignalLayer(state.signalLayer,state.year);
      loadAnalysis(false);
      loadEconomics();
    }
  }else if(action==='compare-crop'){
    setCrop(target.dataset.crop);
    dialog.close();
    if(state.step===5){syncTopbarControls();loadAnalysis();}
    else setStep(4);
  }else if(action==='close-dialog')dialog.close();
});

document.addEventListener('change',event=>{
  const {id,value}=event.target;
  if(id==='quick-crop'){
    setCrop(value);
    syncTopbarControls();
    loadAnalysis();
  }else if(id==='year-select'){
    invalidateAnalysis();state.cropOptions=null;
    state.year=Number(value);
    state.planting=`${value}-${state.planting.slice(5)}`;
    setSignalLayer(state.signalLayer,state.year);
    if(state.step===4){renderProgress();document.getElementById('flow-stage').innerHTML=irrigationScreen();}
    else if(state.step===5){syncTopbarControls();loadAnalysis();}
    loadEconomics();
  }else if(id==='planting-date'){
    invalidateAnalysis();
    state.planting=value;
    state.plantingManual=true;
    if(state.step===4){renderProgress();document.getElementById('flow-stage').innerHTML=irrigationScreen();}
    if(state.step===5){if(canEnterStep(state,5))loadAnalysis();else{state.validationError=validateConditions(state).error;updateMapText();}}
  }
});

document.addEventListener('input',event=>{
  const {id,value}=event.target;
  if(id==='scale-ha'||id==='target-year'){
    invalidateAnalysis();
    if(id==='scale-ha'){state.scaleHa=value;state.searchScaleHa=value;}else state.targetYear=value;
    syncNumericValidity();
    const validation=validateConditions(state);
    const nextBtn=document.querySelector('[data-action="go-map"]');if(nextBtn)nextBtn.disabled=!validation.valid||event.target.validity.badInput;
    const message=document.getElementById('conditions-validation');if(message)message.textContent=event.target.validity.badInput?'Вкажіть коректне число.':validation.error||'';
    renderProgress();
  }else if(id==='irrigation-mm'){
    invalidateAnalysis();
    state.water=value;
    document.querySelectorAll('.mini-preset,.preset-chip').forEach(btn=>btn.classList.toggle('active',Number(value)===Number(btn.dataset.mm)));
    syncNumericValidity();
    const valid=validateWater();
    if(state.step===4){
      const nextBtn=document.querySelector('[data-action="go-map"]');
      if(nextBtn)nextBtn.disabled=!(valid&&validateConditions(state).valid);
      renderProgress();
      const validationMessage=document.getElementById('conditions-validation');if(validationMessage)validationMessage.textContent=validateConditions(state).error||'';
      const chosen=document.querySelector('.wizard-chosen');
      if(chosen&&state.crop)chosen.textContent=`${cropName(state.crop)} · історичні дані ${state.year} · ${value===''?'кількість поливу не визначено':`ваш сценарій: ${fmt(value)} мм`}`;
    }else if(valid&&state.step===5)scheduleAnalysis(450);
  }
});

dialog.addEventListener('close',()=>{
  if(dialogTrigger?.isConnected)dialogTrigger.focus({preventScroll:true});
  if(dialog.dataset.type==='compare-fields'&&restoreOriginAfterCompare&&compareOriginArea){
    restoreOriginalFieldAfterCompare();
  }
});
dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});

document.addEventListener('keydown',event=>{
  if(!state.drawMode)return;
  if(event.key==='Escape')exitDrawMode();
  else if(state.drawMode==='polygon'&&(event.key==='Backspace'||(event.ctrlKey&&event.key.toLowerCase()==='z'))&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){
    event.preventDefault();
    state.drawPointsCount=undoLastPolygonPoint();
    renderDrawBar();
  }else if(state.drawMode==='polygon'&&event.key==='Enter'&&state.drawPointsCount>=3&&!['BUTTON','INPUT','SELECT','A'].includes(document.activeElement?.tagName)){
    event.preventDefault();
    finishPolygonSelection();
  }
});

document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.step===5&&!state.collection)loadAnalysis(false);});
window.setInterval(()=>{if(!document.hidden&&state.step===5){loadAnalysis(true);loadEconomics(false,true);loadSources();}},5*60*1000);

buildShell();
