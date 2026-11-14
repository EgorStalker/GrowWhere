import {copy,tr,fmt,dateTime,historicalScenarioDate,irrigationInputState,forecastOverview,agronomicRuleOverview} from './live-i18n.js';
import {initMap,getView,setAnalysis,clearAnalysis,selectFeature,clearSelectedFeature,featureName,focusKansas,focusDetail,showWorld,resizeMap,startAreaSelection,undoLastPolygonPoint,finishPolygonSelection,cancelAreaSelection,clearCustomArea,selectCurrentViewArea,setAreaDisplayMode,fitCustomArea,setBaseLayer,setOverlayOpacity,setSignalLayer,STATUS_COLORS} from './live-map.js';
import {aggregateTerritory,recommendedZoomForArea} from './area-selection.js';

const CROP_IDS=['wheat','soy','corn','sorghum','barley','oats','cotton'];
const CROP_CODES={wheat:'ПШ',soy:'СО',corn:'КУ',sorghum:'СР',barley:'ЯЧ',oats:'ОВ',cotton:'БВ'};
const WATER_PRESETS=[150,300,450];
const KANSAS_BBOX=[-102.1,36.9,-94.5,40.1];
const currentYear=new Date().getUTCFullYear();
const defaultYear=currentYear-1;

const state={
  step:1,
  maxStep:1,
  crop:null,
  year:defaultYear,
  planting:`${defaultYear}-05-01`,
  plantingManual:false,
  irrigation:null,
  water:'',
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
let controller=null,insightsController=null,requestId=0,insightsReqId=0,moveTimer=null,dialogTrigger=null;

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
        <div class="map-topbar" id="map-topbar"></div>
        <div id="draw-bar" class="live-draw-bar" hidden></div>
        <div id="area-banner" class="live-area-banner" hidden></div>
        <div class="map-canvas-wrap">
          <div id="live-map" class="live-map" tabindex="0"></div>
          <div id="map-status" class="live-map-status" role="status" hidden>Завантажуємо дані…</div>
          <div class="map-legend-float" aria-label="Кольори придатності">
            ${['good','conditional','poor','unknown','excluded'].map(status=>`<span><i class="${status}" aria-hidden="true"></i>${tr(`statuses.${status}`)}</span>`).join('')}
          </div>
          <aside id="map-drawer" class="map-drawer" aria-label="Результати вибраної ділянки" hidden></aside>
        </div>
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
  nav.innerHTML=copy.stepNames.map((label,index)=>{
    const n=index+1;
    const isCurrent=state.step===n;
    const locked=n>state.maxStep;
    return `<button type="button" class="tab-pill ${isCurrent?'current':''} ${locked?'locked':''}" data-action="step" data-step="${n}" ${locked?'disabled aria-disabled="true" title="Спочатку завершіть попередні етапи"':''} ${isCurrent?'aria-current="page"':''}><span>${n}. ${label}</span></button>`;
  }).join('');
}

function renderMapTopbar() {
  const bar=document.getElementById('map-topbar');
  if(!bar)return;
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
      <select id="year-select">${[currentYear,currentYear-1,currentYear-2,currentYear-3].map(year=>`<option value="${year}" ${year===state.year?'selected':''}>${year}</option>`).join('')}</select>
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
  return `
    <section class="welcome-stage" aria-labelledby="page-title">
      <div class="welcome-hero">
        <div class="welcome-copy">
          <p class="eyebrow">RIGHTVERSION · NASA SPACE APPS</p>
          <h1 class="live-step-heading" id="page-title" tabindex="-1">Оцінка земель за даними NASA й USDA</h1>
          <p class="welcome-lead">GrowWhere допомагає перевірити, чи підходить земельна ділянка для обраної культури за кліматом, ґрунтами, водозабезпеченням і землекористуванням.</p>
          <div class="welcome-cta-row">
            <button type="button" class="primary welcome-cta" data-action="go-crops"><span>Перейти до вибору культури</span>${icon('arrow')}</button>
            <button type="button" class="secondary welcome-sec" data-action="sources">Джерела та формула</button>
          </div>
        </div>
        <aside class="welcome-spec" aria-label="Коротка довідка">
          <div class="spec-row"><span>Пілотний регіон</span><strong>Канзас, США</strong></div>
          <div class="spec-row"><span>Погода й радіація</span><strong>NASA POWER (FAO-56)</strong></div>
          <div class="spec-row"><span>Ґрунти й покрив</span><strong>USDA SSURGO + CDL 30 м</strong></div>
          <div class="spec-row"><span>Економіка</span><strong>USDA ERS (${CROP_IDS.length} культур)</strong></div>
        </aside>
      </div>
      <div class="welcome-steps-grid">
        <article class="step-preview">
          <span class="step-num">01</span>
          <h2>Оберіть культуру</h2>
          <p>7 культур зі своїми температурними порогами, коефіцієнтами Kc FAO-56 та регіональною економікою USDA ERS.</p>
        </article>
        <article class="step-preview">
          <span class="step-num">02</span>
          <h2>Порівняйте історичні умови</h2>
          <p>Оберіть минулий сезон і власний сценарій поливу. Дата майбутньої посадки та норма поливу поки недоступні.</p>
        </article>
        <article class="step-preview">
          <span class="step-num">03</span>
          <h2>Виділіть ділянку на карті</h2>
          <p>Повноекранна карта з виділенням контуру по точках, загальним кольором території та розбором 7 чинників.</p>
        </article>
      </div>
    </section>
  `;
}

function cropScreen() {
  return `
    <section class="wizard-stage" aria-labelledby="page-title">
      <div class="wizard-head">
        <div>
          <button type="button" class="link-button" data-action="home">← Назад до вітання</button>
          <p class="eyebrow">КРОК 2 · ВИБІР КУЛЬТУРИ</p>
          <h1 class="live-step-heading" id="page-title" tabindex="-1">Яку культуру ви плануєте вирощувати?</h1>
          <p class="lead">Оберіть одну з ${CROP_IDS.length} культур для порівняння історичних умов. Теплові пороги та потреба у воді належать до дослідницької моделі.</p>
        </div>
        <div class="wizard-head-actions">
          <button type="button" class="secondary" data-action="compare">Порівняти економіку</button>
        </div>
      </div>
      ${planningReadinessHtml()}
      <div class="wizard-crop-grid">${CROP_IDS.map(crop=>cropCard(crop)).join('')}</div>
      <div class="wizard-footer-bar">
        <div class="wizard-chosen">${state.crop?`Обрано: <strong>${cropName(state.crop)}</strong>`:'Оберіть одну культуру зі списку вище, щоб перейти до налаштування поливу.'}</div>
        <button type="button" class="primary wizard-next" data-action="go-conditions" ${state.crop?'':'disabled'}><span>Далі: полив та умови</span>${icon('arrow')}</button>
      </div>
    </section>
  `;
}

function irrigationScreen() {
  const ready=!!(state.crop&&state.irrigation&&!state.validationError&&irrigationInputState(state.irrigation,state.water).valid);
  return `
    <section class="wizard-stage narrow" aria-labelledby="page-title">
      <button type="button" class="link-button" data-action="go-crops">← Змінити культуру (${cropName(state.crop)})</button>
      <p class="eyebrow">КРОК 3 · ПОЛИВ ТА СЕЗОН</p>
      <h1 class="live-step-heading" id="page-title" tabindex="-1">Умови історичного порівняння</h1>
      <p class="lead">Оберіть режим поливу та період спостережень. Ці налаштування допомагають повторити історичний розрахунок і не є планом посадки.</p>
      ${planningReadinessHtml()}
      <div class="wizard-card">
        <div class="live-form">
          <div class="live-inline-fields">
            <div class="live-field">
              <label for="region-select">Регіон аналізу</label>
              <select id="region-select"><option value="kansas">Канзас, США</option><option disabled>Інші регіони — у розвитку</option></select>
            </div>
            <div class="live-field">
              <label for="year-select">Рік спостережень</label>
              <select id="year-select">${[currentYear,currentYear-1,currentYear-2,currentYear-3].map(year=>`<option value="${year}" ${year===state.year?'selected':''}>${year}${year===currentYear?' · неповний рік':''}</option>`).join('')}</select>
            </div>
          </div>
          <div class="live-field">
            <label for="planting-date">Період історичного розрахунку — початок</label>
            <input type="date" id="planting-date" min="${state.year}-01-01" max="${state.year}-12-31" value="${state.planting}">
            <small>Це параметр моделі для обраного року, а не рекомендація майбутньої сівби. Актуальної дати посадки сервіс поки не визначає.</small>
          </div>
          ${irrigationFields()}
        </div>
        <div class="wizard-footer-bar">
          <div class="wizard-chosen">${state.irrigation?`${cropName(state.crop)} · історичні дані ${state.year} · ${waterScenarioLabel()}`:'Спочатку оберіть режим поливу вище («Без поливу», «Полив доступний» або «Ще не знаю»).'}</div>
          <button type="button" class="primary wizard-next" data-action="go-map" ${ready?'':'disabled'}><span>Відкрити карту</span>${icon('arrow')}</button>
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
  return `<div class="live-area-breakdown">${items.map(([key,label])=>`<span class="live-breakdown-chip"><i style="background:${STATUS_COLORS[key]}" aria-hidden="true"></i>${label}: <b>${fmt(summary.counts[key])}</b></span>`).join('')}</div>`;
}

function activeInsightTarget() {
  if(state.selected){
    const c=state.selected.properties?.center;
    if(c?.length>=2)return {lon:Number(c[0]),lat:Number(c[1])};
  }
  if(state.customArea?.bbox?.length===4){
    const [w,s,e,n]=state.customArea.bbox;
    return {lon:(w+e)/2,lat:(s+n)/2};
  }
  return null;
}

function insightKey(target) {
  if(!target)return '';
  const cond=conditions();
  return `${target.lon.toFixed(4)},${target.lat.toFixed(4)}|${cond.crop}|${cond.year}|${cond.planting}|${cond.irrigation_mm}|${cond.irrigation_known}`;
}

function planningKey(target) {
  return target?`${Number(target.lon).toFixed(5)},${Number(target.lat).toFixed(5)}|${state.crop}`:'';
}

async function loadPlanningReadiness(refresh=false) {
  const target=activeInsightTarget();
  if(!target||!state.crop)return;
  const key=planningKey(target);
  const cached=planningCache.get(key);
  if(!refresh&&cached&&Date.now()-cached.fetchedAt<10*60*1000)return;
  if(!refresh&&planningLoadingKey===key)return;
  planningController?.abort();
  planningController=new AbortController();
  const identity=++planningRequestId;
  planningLoadingKey=key;planningErrorKey=null;
  renderDrawer();
  const params=new URLSearchParams({mode:'own_land',crop:state.crop,lon:String(target.lon),lat:String(target.lat),refresh:refresh?'1':'0'});
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
  if(state.step===4&&state.drawerOpen)renderDrawer();
}

function pointPlanningHtml() {
  const key=planningKey(activeInsightTarget());
  if(!key)return '';
  const data=planningCache.get(key)?.data;
  if(!data)return `<section class="drawer-sub planning-point"><strong>Актуальні умови для планування</strong><span>${planningLoadingKey===key?'Отримуємо прогноз і перевіряємо наявність правил…':planningErrorKey===key?'Прогноз і правила зараз недоступні. Дату посадки й норму поливу не визначено.':'Дату посадки й норму поливу поки не визначено.'}</span>${planningErrorKey===key?button('Оновити прогноз','reload-planning'):''}</section>`;
  const forecast=forecastOverview(data.forecast);
  const forecastSources=(data.forecast?.provenance||[]).map(meta=>sourceLink(meta.source_url,'Джерело NOAA/NWS')).join(' ');
  const forecastHtml=forecast?`<span><b>NOAA/NWS · найближчі 24 години</b><br>Температура повітря: ${formatRange(forecast.temperatureRangeC,' °C',1)}<br>Найбільша погодинна ймовірність опадів: ${forecast.maxRainProbabilityPct===null?'Без даних':`${fmt(forecast.maxRainProbabilityPct)}%`}<br>Випущено: ${dateTime(forecast.issuedAt)}<br>Прогноз діє до: ${dateTime(forecast.validTo)}<br>Дати й час показано в часовому поясі вашого пристрою.</span>${forecastSources}`:`<span>Актуальний прогноз: ${escape(data.forecast?.reason||'Без даних для цієї точки.')}</span>`;
  const rule=agronomicRuleOverview(data.agronomic_rules);
  const ruleHtml=rule?`<span><b>Місцеві правила · ${cropName(state.crop)}</b><br>${rule.localGuideDiscouragesCrop?'Місцевий посібник не рекомендує цей тип культури для регіону.<br>':''}${rule.temperatureRangeC?`Опублікований мінімум температури ґрунту: ${formatRange(rule.temperatureRangeC,' °C',1)}${rule.depthCm===null?'':` на глибині ${fmt(rule.depthCm,2)} см`}. Це довідковий поріг, а не вимірювання поточного стану ґрунту.`:'Перевіреного температурного порогу для автоматичної оцінки немає.'}${rule.verifiedAt?`<br>Джерело перевірено: ${escape(rule.verifiedAt)}`:''}</span>${sourceLink(rule.sourceUrl,'Правила K-State')}`:'<span>Місцеві агрономічні правила: без даних.</span>';
  return `<section class="drawer-sub planning-point"><strong>Актуальні умови для планування</strong><span>${state.selected?'Прогноз для центра вибраної зони.':'Прогноз лише для центральної точки контуру.'} Це оцінка погодної сітки, а не вимірювання на полі.</span>${forecastHtml}${ruleHtml}<span>Дата посадки та норма поливу поки не визначені. Прогноз і правила самі по собі не є порадою для цього поля.</span>${data.critical_gaps?.length?`<details><summary>Чого ще бракує (${data.critical_gaps.length})</summary><ul class="live-missing-list">${data.critical_gaps.map(gap=>`<li>${escape(gap.message)}</li>`).join('')}</ul></details>`:''}${button('Оновити перевірку','reload-planning')}</section>`;
}

async function loadPointInsights(refresh=false) {
  const target=activeInsightTarget();
  if(!target)return;
  const key=insightKey(target);
  if(!refresh&&insightsCache.has(key)){
    state.insightsLoading=false;state.insightsError=null;
    if(state.step===4&&state.drawerOpen)renderDrawer();
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
    if(state.step===4&&state.drawerOpen)renderDrawer();
  }catch(error){
    if(error.name==='AbortError'||reqId!==insightsReqId)return;
    state.insightsLoading=false;state.insightsError=error.message;
    if(state.step===4&&state.drawerOpen)renderDrawer();
  }
}

function drawerTabsHtml() {
  const tabs=[['overview','Огляд'],['compare','7 культур'],['risk','Ризик (5р)'],['rotation','Сівозміна']];
  return `<div class="drawer-tabs" role="tablist" aria-label="Деталізація ділянки">${tabs.map(([id,label])=>`<button type="button" role="tab" aria-selected="${state.drawerTab===id}" class="drawer-tab ${state.drawerTab===id?'active':''}" data-action="drawer-tab" data-tab="${id}">${label}</button>`).join('')}</div>`;
}

function uncertaintyBoxHtml(uncertainty) {
  if(!uncertainty)return '';
  const range=uncertainty.score_range?`${fmt(uncertainty.score_range[0],0)}–${fmt(uncertainty.score_range[1],0)}`:'—';
  const agPct=validNumber(uncertainty.ag_share)?`${Math.round(uncertainty.ag_share*100)}%`:'—';
  return `<div class="drawer-sub uncertainty-box"><strong>Невизначеність оглядової сітки (${fmt(uncertainty.sample_count)} точок)</strong><span>Розкид балів: <b>${range}</b> · с/г покрив у вибірці (CDL): <b>${agPct}</b> (${fmt(uncertainty.scored_samples)} оцінено, ${fmt(uncertainty.excluded_samples)} поза аналізом, ${fmt(uncertainty.unknown_samples)} без даних)</span></div>`;
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
  if(!risk)return '<p class="drawer-note">Немає даних для оцінки ризику.</p>';
  const sum=risk.summary||{};
  const rainText=(validNumber(sum.rain_min_mm)&&validNumber(sum.rain_max_mm))?`${fmt(sum.rain_min_mm,0)}–${fmt(sum.rain_max_mm,0)} мм`:'—';
  const scoreText=(validNumber(sum.score_min)&&validNumber(sum.score_max))?`${fmt(sum.score_min,0)}–${fmt(sum.score_max,0)}`:'—';
  return `
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
        return `
          <div class="risk-year-row">
            <div class="risk-year-head">
              <strong>${y.year}</strong>
              <span>${validNumber(y.precipitation_mm)?`${fmt(y.precipitation_mm,0)} мм опадів`:'Неповний сезон'}${y.heat_days>0?` · спека ${y.heat_days} дн.`:''}${wet?` · ${wet}`:''}</span>
              <b>${validNumber(y.score)?`${fmt(y.score,0)}/100`:'—'}</b>
            </div>
            <div class="factor-track"><span class="factor-fill ${escape(st)}" style="width:${pct}%"></span></div>
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
  const shouldShow=state.step===4&&state.drawerOpen&&(feature||hasArea);
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
      <div class="live-toolbar">${button('Ближче до ґрунтів','detail')}${button('Формула','formula')}</div>
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
  const hint=!isPoly
    ?'Проведіть рамку по карті, щоб виділити область.'
    :state.drawPointsCount<3
    ?`Клікайте по карті для точок межі (поставлено ${state.drawPointsCount}, потрібно щонайменше 3).`
    :`Поставлено точок: ${state.drawPointsCount}. Натисніть зелену першу точку, двічі клікніть або «Завершити контур».`;
  bar.innerHTML=`<div class="live-draw-controls"><div class="live-draw-modes" role="group" aria-label="Режим виділення"><button type="button" class="${isPoly?'active':''}" data-action="draw-mode" data-mode="polygon">По точках</button><button type="button" class="${!isPoly?'active':''}" data-action="draw-mode" data-mode="rect">Рамка</button></div><div class="live-draw-buttons">${isPoly?`<button type="button" data-action="undo-point" ${state.drawPointsCount<1?'disabled':''}>Скасувати точку</button><button type="button" class="accent" data-action="finish-draw" ${state.drawPointsCount<3?'disabled':''}>Завершити контур</button>`:''}<button type="button" data-action="select-view">Усе вікно</button><button type="button" data-action="cancel-draw">Скасувати</button></div></div><p class="live-draw-hint">${hint}</p>`;
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
  if(state.step!==4)return;
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

function renderView({focusId}={}) {
  renderProgress();
  const stage=document.getElementById('flow-stage');
  const mapWorkspace=document.getElementById('map-workspace');
  const onMap=state.step===4;
  document.body.classList.toggle('on-map-stage',onMap);
  stage.hidden=onMap;
  mapWorkspace.hidden=!onMap;
  if(state.step===1){
    stage.innerHTML=welcomeScreen();
  }else if(state.step===2){
    stage.innerHTML=cropScreen();
  }else if(state.step===3){
    stage.innerHTML=irrigationScreen();
  }else{
    stage.innerHTML='';
    renderMapTopbar();
    ensureMapReady();
    resizeMap();
    updateMapText();
  }
  if(focusId)document.getElementById(focusId)?.focus({preventScroll:true});
}

function validateWater() {
  const input=document.getElementById('irrigation-mm');
  const invalid=state.irrigation==='yes'&&(input?.validity?.badInput||(state.water!==''&&(!validNumber(state.water)||Number(state.water)<0||Number(state.water)>5000)));
  state.validationError=invalid?'Вкажіть кількість води від 0 до 5000 мм.':null;
  input?.setAttribute('aria-invalid',String(invalid));
  const message=document.getElementById('water-validation');
  if(message){message.textContent=state.validationError||'';message.hidden=!invalid;}
  if(invalid&&state.step===4){
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
}

async function loadAnalysis(refresh=false) {
  if(state.step!==4||!state.mapReady||state.validationError)return;
  const view=getView();
  const queryBbox=state.customArea?state.customArea.bbox:view.bbox;
  const queryZoom=state.customArea?recommendedZoomForArea(state.customArea.bbox,view.zoom):view.zoom;
  const cond=conditions();

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
  clearTimeout(moveTimer);controller?.abort();controller=new AbortController();
  const identity=++requestId;
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
  if(state.step!==4)return;
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
      if(state.step===2)stageRenderPreservingScroll();
      else if(state.step===4)renderDrawer();
      if(dialog.open&&dialog.dataset.type==='compare')renderDialog('compare',false);
    }
  }));
}

function stageRenderPreservingScroll() {
  if(state.step===2){
    const y=window.scrollY;
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
      move:()=>{if(state.step===4&&!state.customArea)scheduleAnalysis(450);},
      select:selectZone,
      areaChange:handleAreaChange,
      drawProgress:count=>{if(state.drawMode==='polygon'){state.drawPointsCount=count;renderDrawBar();}},
      tileError:()=>{if(!state.tileError){state.tileError=true;updateMapText();}}
    });
    state.mapReady=true;
    loadSources();
  }catch(error){
    state.loading=false;state.error=error.message;
    updateMapText();
  }
}

function setStep(step) {
  if(step<1||step>4||step>state.maxStep)return;
  if(step!==4&&state.drawMode)exitDrawMode();
  state.step=step;
  renderView({focusId:'page-title'});
  if(step===4){
    requestAnimationFrame(()=>{
      resizeMap();
      loadAnalysis(false);
    });
  }
  if(window.innerWidth<=820)window.scrollTo({top:0,behavior:'smooth'});
  announce(`Етап ${step}: ${copy.stepNames[step-1]}`);
}

function selectZone(feature) {
  state.selected=feature;
  state.drawerOpen=true;
  if(state.step!==4)setStep(4);else updateMapText();
  loadPlanningReadiness(false);
  if(state.drawerTab!=='overview')loadPointInsights(false);
  announce(`${featureName(feature)}. ${tr('statuses.'+(feature.properties?.result?.status||'unknown'))}`);
}

function handleAreaChange(area) {
  state.customArea=area;
  state.drawMode=null;
  state.drawPointsCount=0;
  state.selected=null;
  state.drawerOpen=true;
  state.areaDisplay='solid';
  setAreaDisplayMode('solid');
  clearSelectedFeature();
  fitCustomArea();
  if(state.step!==4)setStep(4);else updateMapText();
  loadAnalysis(false);
  if(state.drawerTab!=='overview')loadPointInsights(false);
  announce('Територію виділено. Обчислюємо колір придатності.');
}

function enterDrawMode(mode='polygon') {
  state.drawMode=mode==='rect'?'rect':'polygon';
  state.drawPointsCount=0;
  startAreaSelection(state.drawMode);
  updateMapText();
}

function exitDrawMode() {
  state.drawMode=null;
  state.drawPointsCount=0;
  cancelAreaSelection();
  updateMapText();
}

function removeCustomArea() {
  state.customArea=null;
  state.areaSummary=null;
  state.drawMode=null;
  state.drawPointsCount=0;
  state.selected=null;
  state.drawerOpen=false;
  clearCustomArea();
  clearSelectedFeature();
  loadAnalysis(false);
  announce('Виділення очищено.');
}

function setCrop(newCrop) {
  state.crop=newCrop;
  if(!state.plantingManual&&historicalScenarioDate(newCrop,state.year)){
    state.planting=historicalScenarioDate(newCrop,state.year);
  }
}

function dialogHeader(title) {
  return `<div class="dialog-header"><h2 id="dialog-title" tabindex="-1">${title}</h2><button type="button" class="close-dialog" data-action="close-dialog" aria-label="Закрити">×</button></div>`;
}

function renderDialog(type,show=true) {
  if(show)dialogTrigger=document.activeElement;
  dialog.dataset.type=type;
  dialog.className=type==='compare'?'compare-dialog':'';
  let title='',content='';
  if(type==='help') {
    title='Як працює GrowWhere';
    content=`<p class="live-dialog-text">Послідовність роботи:</p><div class="help-list">${[['1. Культура',`Оберіть одну з ${CROP_IDS.length} культур.`],['2. Історичний сценарій','Оберіть рік спостережень, початок історичного розрахунку та власний сценарій поливу. Актуальні дата посадки й норма поливу поки недоступні.'],['3. Повноекранна карта','Натисніть «Виділити по точках», поставте точки межі поля й замкніть контур — уся територія покаже свій колір.']].map(([head,text],i)=>`<div class="help-item"><span class="step-num">${String(i+1).padStart(2,'0')}</span><div><h3>${head}</h3><p>${text}</p></div></div>`).join('')}</div>${button('Зрозуміло','close-dialog','primary')}`;
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
  else if(action==='go-crops'){state.maxStep=Math.max(state.maxStep,2);setStep(2);}
  else if(action==='go-conditions'){if(!state.crop)return;state.maxStep=Math.max(state.maxStep,3);setStep(3);}
  else if(action==='go-map'){
    if(!state.crop||!state.irrigation||!validateWater())return;
    state.maxStep=Math.max(state.maxStep,4);
    setStep(4);
  }
  else if(action==='step'){
    const targetStep=Number(target.dataset.step);
    if(targetStep<=state.maxStep)setStep(targetStep);
  }
  else if(action==='crop'){
    setCrop(target.dataset.crop);
    if(state.step===2){stageRenderPreservingScroll();document.getElementById(`crop-${state.crop}`)?.focus({preventScroll:true});}
    else{syncTopbarControls();loadAnalysis();}
  }else if(action==='water'){
    state.irrigation=target.dataset.value;
    state.validationError=null;
    if(state.step===3){document.getElementById('flow-stage').innerHTML=irrigationScreen();document.getElementById(`water-${state.irrigation}`)?.focus({preventScroll:true});}
    else if(state.step===4){syncTopbarControls();if(validateWater())loadAnalysis();}
  }else if(action==='water-preset'){
    state.irrigation='yes';
    state.water=String(target.dataset.mm);
    state.validationError=null;
    if(state.step===3){document.getElementById('flow-stage').innerHTML=irrigationScreen();}
    else if(state.step===4){syncTopbarControls();loadAnalysis();}
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
  else if(action==='refresh'){analysisCache.clear();insightsCache.clear();loadAnalysis(true);loadEconomics(true);loadSources();if(state.drawerOpen&&state.drawerTab!=='overview')loadPointInsights(true);}
  else if(action==='text-size'){state.large=!state.large;document.body.classList.toggle('large-text',state.large);target.setAttribute('aria-pressed',String(state.large));resizeMap();}
  else if(['help','compare','formula','sources'].includes(action)){
    if(action==='sources'&&!state.sources)loadSources().then(()=>renderDialog('sources'));
    else renderDialog(action);
  }else if(action==='compare-crop'){
    setCrop(target.dataset.crop);
    dialog.close();
    if(state.step===4){syncTopbarControls();loadAnalysis();}
    else{state.maxStep=Math.max(state.maxStep,3);setStep(3);}
  }else if(action==='close-dialog')dialog.close();
});

document.addEventListener('change',event=>{
  const {id,value}=event.target;
  if(id==='quick-crop'){
    setCrop(value);
    syncTopbarControls();
    loadAnalysis();
  }else if(id==='year-select'){
    state.year=Number(value);
    state.planting=`${value}-${state.planting.slice(5)}`;
    setSignalLayer(state.signalLayer,state.year);
    if(state.step===3)document.getElementById('flow-stage').innerHTML=irrigationScreen();
    else if(state.step===4){syncTopbarControls();loadAnalysis();}
    loadEconomics();
  }else if(id==='planting-date'&&event.target.validity.valid&&value){
    state.planting=value;
    state.plantingManual=true;
    if(state.step===4)loadAnalysis();
  }
});

document.addEventListener('input',event=>{
  const {id,value}=event.target;
  if(id==='irrigation-mm'){
    state.water=value;
    document.querySelectorAll('.mini-preset,.preset-chip').forEach(btn=>btn.classList.toggle('active',Number(value)===Number(btn.dataset.mm)));
    const valid=validateWater();
    if(state.step===3){
      const nextBtn=document.querySelector('[data-action="go-map"]');
      if(nextBtn)nextBtn.disabled=!(valid&&irrigationInputState(state.irrigation,value).valid);
      const chosen=document.querySelector('.wizard-chosen');
      if(chosen&&state.crop)chosen.textContent=`${cropName(state.crop)} · історичні дані ${state.year} · ${value===''?'кількість поливу не визначено':`ваш сценарій: ${fmt(value)} мм`}`;
    }else if(valid&&state.step===4)scheduleAnalysis(450);
  }
});

dialog.addEventListener('close',()=>{if(dialogTrigger?.isConnected)dialogTrigger.focus({preventScroll:true});});
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

document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.step===4&&!state.collection)loadAnalysis(false);});
window.setInterval(()=>{if(!document.hidden&&state.step===4){loadAnalysis(true);loadEconomics(false,true);loadSources();}},5*60*1000);

buildShell();
loadEconomics();
loadSources();
