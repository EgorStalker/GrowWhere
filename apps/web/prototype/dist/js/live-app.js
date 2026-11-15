import {loadPreparedMap,clearPreparedCatalog,NORTH_AMERICA_BBOX} from './prepared-maps.js';
import {copy,tr,fmt,dateTime,historicalScenarioDate,irrigationInputState,forecastOverview,agronomicRuleOverview} from './live-i18n.js';
import {initMap,getView,setAnalysis,clearAnalysis,selectFeature,clearSelectedFeature,featureName,focusKansas,focusDetail,showWorld,resizeMap,startAreaSelection,undoLastPolygonPoint,finishPolygonSelection,cancelAreaSelection,clearCustomArea,setCustomArea,selectCurrentViewArea,setAreaDisplayMode,fitCustomArea,setBaseLayer,setOverlayOpacity,setSignalLayer,STATUS_COLORS} from './live-map.js';
import {aggregateTerritory,recommendedZoomForArea,geodesicAreaHa} from './area-selection.js';

import {flowStepNames,validateTerritory,validateConditions,canEnterStep,planningContext} from './user-flow.js';
import {fetchCropOptions,parcelReferencePoint} from './crop-options.js';
import {buildCalculationReport,renderReportDialogHtml} from './report.js';
import {createFieldSnapshot,compareTwoFields,renderFieldCompareDialogHtml} from './field-compare.js';

const CROP_IDS=['wheat','soy','corn','sorghum','barley','oats','cotton'];
const CROP_CODES={wheat:'SW',soy:'SY',corn:'CO',sorghum:'SG',barley:'BA',oats:'OA',cotton:'CT'};
const WATER_PRESETS=[150,300,450];
const KANSAS_BBOX=NORTH_AMERICA_BBOX;
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
  baseMap:'osm',
  signalLayer:'index',
  drawerTab:'overview',
  overlayOpacity:0.58,
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
let lastReport=null,compareFieldA=null,compareFieldB=null,awaitingCompareB=false,downloadBusy=false;

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cropName=id=>tr(`cropNames.${id}`,id);
const cropCode=id=>CROP_CODES[id]||'CR';
const icon=(name)=>`<span aria-hidden="true" class="plain-icon">${{arrow:'→',back:'←',pin:'⌖',help:'?',refresh:'↻',check:'✓'}[name]||'•'}</span>`;
const announce=message=>{const el=document.getElementById('announcement');if(el)el.textContent=message;};
const validNumber=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
const economyKey=(crop,year=state.year)=>`${crop}:${year}`;
const economy=crop=>state.economics[economyKey(crop)]||null;
const sourceReceived=id=>state.selected?.properties?.source_meta?.find(meta=>meta.source_id===id)?.retrieved_at;
const unit=(value,label,digits=0)=>validNumber(value)?`${fmt(value,digits)} <small>${label}</small>`:'No data';
const waterScenarioLabel=()=>{
  const water=irrigationInputState(state.irrigation,state.water);
  return state.irrigation==='yes'?(water.known?`your scenario: ${fmt(water.amountMm)} mm`:'irrigation amount not specified'):tr(`irrigationNames.${state.irrigation}`,'Irrigation not specified');
};

function formatArea(ha) {
  if(!validNumber(ha)||Number(ha)<=0)return '—';
  if(ha>=100)return `${fmt(ha/100,1)} km² (${fmt(ha,0)} ha)`;
  if(ha>=1)return `${fmt(ha,1)} ha`;
  return `${fmt(ha*10000,0)} m²`;
}

function formatRange(range,suffix='',digits=1) {
  if(!range)return 'No data';
  const [min,max]=range;
  if(Math.abs(max-min)<Math.pow(10,-digits)/2)return `${fmt(min,digits)}${suffix}`;
  return `${fmt(min,digits)} – ${fmt(max,digits)}${suffix}`;
}

function safeUrl(value) {
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:null;}
  catch{return null;}
}
function sourceLink(url,label='View source') {
  const safe=safeUrl(url);
  return safe?`<a class="live-source-link" href="${escape(safe)}" target="_blank" rel="noopener noreferrer">${escape(label)} ↗</a>`:'';
}
function statusPill(status='unknown') {
  return `<span class="status-pill ${escape(status)}">${status==='good'?'✓':status==='unknown'?'?':status==='excluded'?'–':'!'} ${tr(`statuses.${status}`,'No data')}</span>`;
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
      <button class="brand" data-action="home" aria-label="GrowWhere — home">
        <img src="assets/logo.png" alt="" width="44" height="44">
        <div>
          <div class="brand-name">GrowWhere</div>

        </div>
      </button>
      <nav id="live-progress" class="tab-nav" aria-label="Workflow steps"></nav>
      <div class="header-actions">
        <button id="text-size" class="header-button text-button" data-action="text-size" aria-label="Larger text" title="Toggle larger text" aria-pressed="false">A+</button>
        <button class="header-button help-button" data-action="help" aria-label="Help">${icon('help')}<span>Help</span></button>
      </div>
    </header>
    <main id="main" class="live-shell">
      <div id="flow-stage"></div>
      <section class="map-workspace" id="map-workspace" hidden aria-label="Map workspace">
        <div id="result-context"></div><div class="map-topbar" id="map-topbar"></div>
        <div id="draw-bar" class="live-draw-bar" hidden></div>
        <div id="area-banner" class="live-area-banner" hidden></div>
        <div class="map-canvas-wrap">
          <div id="live-map" class="live-map" tabindex="0"></div>
          <div id="map-status" class="live-map-status" role="status" hidden>Loading data…</div>
          <div class="map-legend-float" aria-label="Suitability legend">
            ${['good','conditional','poor','unknown','excluded'].map(status=>`<span><i class="${status}" aria-hidden="true"></i>${{good:'Suitable · 70–100',conditional:'Limited · 40–69',poor:'Unsuitable · 0–39',unknown:'No data',excluded:'Excluded'}[status]}</span>`).join('')}
          </div>
          <aside id="map-drawer" class="map-drawer" aria-label="Selected area results" hidden></aside>
        </div><div id="territory-footer" hidden></div>
      </section>
    </main>
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
    return `<button type="button" class="tab-pill ${isCurrent?'current':''} ${locked?'locked':''}" data-action="step" data-step="${n}" ${locked?'disabled aria-disabled="true" title="Complete the previous steps first"':''} ${isCurrent?'aria-current="page"':''}><span>${n}. ${label}</span></button>`;
  }).join('');
}

function renderMapTopbar() {
  const bar=document.getElementById('map-topbar');
  if(!bar)return;
  if(state.step===2){
    bar.innerHTML=`<div class="territory-tools">${button('Draw a boundary with points','draw-area','primary')}${button('Select a rectangle','draw-rect')}${button('Available data','kansas')}${state.customArea?button('Clear boundary','clear-area'):''}</div>`;
    return;
  }
  const irrYes=state.irrigation==='yes';
  bar.innerHTML=`
    <div class="topbar-group">
      <label for="quick-crop">Crop</label>
      <select id="quick-crop">
        ${CROP_IDS.map(id=>`<option value="${id}" ${id===state.crop?'selected':''}>${cropName(id)}</option>`).join('')}
      </select>
    </div>

    <span class="map-period">${state.year} historical data</span>
    <button type="button" class="map-select-button" data-action="draw-area">${state.customArea?'Edit boundary':'Select area'}</button>
    <button type="button" class="map-coverage-button" data-action="kansas">Available data</button>
    <details class="map-settings"><summary>Layers & settings</summary><div class="map-settings-body">    <div class="topbar-group">
      <label for="year-select">Historical data year</label>
      <select id="year-select">${[currentYear,currentYear-1,currentYear-2,currentYear-3].map(year=>`<option value="${year}" ${year===state.year?'selected':''}>${year}</option>`).join('')}</select>
    </div>
    <div class="topbar-group">
      <label for="planting-date">Historical scenario start</label>
      <input type="date" id="planting-date" min="${state.year}-01-01" max="${state.year}-12-31" value="${state.planting}">
    </div>
    <div class="topbar-group topbar-water">
      <span>Irrigation</span>
      <div class="inline-seg" role="group" aria-label="Irrigation mode">
        <button type="button" class="${state.irrigation==='no'?'active':''}" id="water-no" data-action="water" data-value="no">None</button>
        <button type="button" class="${irrYes?'active':''}" id="water-yes" data-action="water" data-value="yes">Irrigation available</button>
        <button type="button" class="${state.irrigation==='unknown'?'active':''}" id="water-unknown" data-action="water" data-value="unknown">Unknown</button>
      </div>
      <div id="topbar-mm-wrap" class="topbar-mm-wrap" ${irrYes?'':'hidden'}>
        <input id="irrigation-mm" name="irrigation_mm" type="number" min="0" max="5000" step="25" inputmode="decimal" value="${escape(state.water)}" placeholder="Not specified" aria-label="Your irrigation scenario in mm">
        <span class="mm-unit">mm</span>
        ${[150,300,450].map(mm=>`<button type="button" class="mini-preset ${Number(state.water)===mm?'active':''}" data-action="water-preset" data-mm="${mm}" title="Scenario example, not a recommendation">${mm}</button>`).join('')}
      </div>
    </div>
    <div class="topbar-actions">
      <div class="inline-seg" role="group" aria-label="Base map">
        <button type="button" class="${state.baseMap==='satellite'?'active':''}" id="basemap-satellite" data-action="basemap" data-mode="satellite">Satellite</button>
        <button type="button" class="${state.baseMap==='osm'?'active':''}" id="basemap-osm" data-action="basemap" data-mode="osm">Street map</button>
      </div>
      <div class="inline-seg" role="group" aria-label="NASA observation layer">
        <button type="button" class="${state.signalLayer==='index'?'active':''}" id="signal-index" data-action="signal-layer" data-mode="index">Index</button>
        <button type="button" class="${state.signalLayer==='ndvi'?'active':''}" id="signal-ndvi" data-action="signal-layer" data-mode="ndvi" title="NASA MODIS Terra NDVI 8-Day vegetation">NDVI</button>
        <button type="button" class="${state.signalLayer==='smap'?'active':''}" id="signal-smap" data-action="signal-layer" data-mode="smap" title="NASA SMAP L4 root-zone moisture">SMAP</button>
      </div>
      <button type="button" id="opacity-button" data-action="cycle-opacity" title="Suitability layer opacity">Layer: ${Math.round(state.overlayOpacity*100)}%</button>
      <button type="button" id="draw-area-button" class="primary-compact ${state.drawMode||state.customArea?'active':''}" data-action="draw-area" aria-pressed="${!!state.drawMode}">${state.drawMode?'Drawing…':state.customArea?'Edit boundary':'Draw with points'}</button>

      <button type="button" data-action="refresh" id="refresh-button" title="Reload prepared map">${icon('refresh')}</button>
      <button type="button" data-action="sources" title="Sources and method">Sources</button>
    </div></div></details>
  `;
}

function planningReadinessHtml() {
  return `<details class="planning-readiness compact-notice"><summary>Sowing and irrigation advice: not yet available</summary><p>${copy.planningReadiness.reason}</p></details>`;
}

function irrigationFields() {
  return `
    <div class="live-field">
      <fieldset>
        <legend>Field irrigation</legend>
        <div class="segmented">
          ${Object.entries(copy.irrigationNames).map(([id,name])=>`<button type="button" class="segment ${state.irrigation===id?'active':''}" id="water-${id}" data-action="water" data-value="${id}" aria-pressed="${state.irrigation===id}">${name}</button>`).join('')}
        </div>
      </fieldset>
      ${state.irrigation==='yes'?`
        <div class="water-controls">
          <label for="irrigation-mm">Your additional irrigation scenario, mm (optional)</label>
          <small>Example amounts for comparison — not irrigation advice:</small>
          <div class="water-presets" role="group" aria-label="Example comparison amounts, not recommendations">
            ${WATER_PRESETS.map(mm=>`<button type="button" class="preset-chip ${Number(state.water)===mm?'active':''}" data-action="water-preset" data-mm="${mm}">${mm} mm</button>`).join('')}
          </div>
          <input id="irrigation-mm" name="irrigation_mm" type="number" min="0" max="5000" step="10" inputmode="decimal" value="${escape(state.water)}" placeholder="Not yet specified" aria-invalid="${!!state.validationError}" aria-describedby="water-hint water-validation">
          <small id="water-hint">1 mm = 10 m³/ha. This is your scenario, not recommended irrigation. Without an amount, the historical estimate assumes no confirmed additional water.</small>
          <p id="water-validation" class="live-input-error" role="alert" ${state.validationError?'':'hidden'}>${escape(state.validationError||'')}</p>
        </div>
      `:`<small>${state.irrigation==='unknown'?'Until irrigation is confirmed, the model uses natural rainfall only.':state.irrigation==='no'?'The calculation uses 80% of seasonal rainfall.':'Choose one of the three options to describe your irrigation conditions.'}</small>`}
    </div>
  `;
}

function cropCard(crop) {
  const data=economy(crop);
  const meta=copy.cropNotes[crop]||{};
  return `
    <button type="button" id="crop-${crop}" class="live-crop ${state.crop===crop?'active':''}" data-action="crop" data-crop="${crop}" aria-pressed="${state.crop===crop}" aria-label="Select: ${cropName(crop)}">
      <div class="crop-row">
        <span class="crop-monogram" aria-hidden="true">${cropCode(crop)}</span>
        <div>
          <h2>${cropName(crop)}</h2>
          <p class="crop-meta-line">${escape(meta.season||'')} · model optimum ${escape(meta.temp||'')}</p>
        </div>
        <span class="check-square">${state.crop===crop?'✓':''}</span>
      </div>
      <p class="crop-note">${escape(meta.note||'')}</p>
      <div class="mini-economy">
        <div><span>Costs</span><b>${unit(data?.cost_per_ha,'$/ha')}</b></div>
        <div><span>Harvest price</span><b>${unit(data?.price_per_tonne,'$/t')}</b></div>
      </div>
      <p class="econ-period">${data?`${escape(data.region||'USDA ERS')} · ${data.year||state.year}`:'Loading USDA ERS data…'}</p>
    </button>
  `;
}

function welcomeScreen() {
  return `<section class="welcome-stage" aria-labelledby="page-title"><div class="welcome-hero welcome-compact"><div class="welcome-copy"><h1 class="live-step-heading" id="page-title" tabindex="-1">What to grow, and where?</h1><p class="welcome-lead">Choose your path. Compare soil and historical climate on a map of North America.</p></div></div><div class="mode-options"><button type="button" class="mode-card" data-action="choose-mode" data-mode="own_land"><span class="step-num">01</span><h2>I have a field</h2><p>Draw its boundary, choose a crop and explore conditions for this area.</p><b>Select my field →</b></button><button type="button" class="mode-card" data-action="choose-mode" data-mode="find_land"><span class="step-num">02</span><h2>Find suitable areas</h2><p>Choose a crop and conditions. The map will show historical suitability.</p><b>Start searching →</b></button></div><p class="quiet-note">Historical suitability screening. Missing data is shown explicitly.</p></section>`;
}
function territoryFooterHtml() {
  const validation=validateTerritory(state);
  return `<div class="wizard-footer-bar territory-footer"><p role="status">${validation.valid?(state.mode==='own_land'?`Boundary: ${formatArea(validation.areaHa)}. Data availability is checked after crop selection.`:'Region selected. You can choose a crop.'):escape(validation.error||'Mark your field.')}</p>${button('Next: crop','go-crops','primary',!validation.valid)}</div>`;
}
function territoryScreen() {
  const own=state.mode==='own_land';
  return `<section class="wizard-stage territory-stage" aria-labelledby="page-title"><button type="button" class="link-button" data-action="home">← Change your path</button><h1 class="live-step-heading" id="page-title" tabindex="-1">${own?'Mark your field':'Which region should we search?'}</h1><p class="lead">${own?'Zoom in and draw a boundary with points or a rectangle inside the pilot coverage. Suitability appears after you select a crop and conditions.':'Search covers the North America map area. It screens suitability, not land availability or property listings.'}</p>${own?'':`<button type="button" class="region-choice ${state.searchRegion==='north-america'?'active':''}" data-action="choose-region" aria-pressed="${state.searchRegion==='north-america'}"><strong>North America</strong><span>Available scores: verified prepared areas; other locations show No data</span><span>${state.searchRegion==='north-america'?'✓ Selected':'Select this region'}</span></button>${territoryFooterHtml()}`}</section>`;
}

function cropOptionsHtml() {
  if(state.mode!=='own_land')return '<p class="drawer-note">The map shows one active crop at a time. Switch crops to compare results.</p>';
  const data=state.cropOptions;
  return `<section class="crop-help"><h2>Not sure which crop to choose?</h2><p>We can compare crops at a reference point inside your boundary: historical season ${state.year}, natural rainfall, no confirmed additional irrigation. This is a preliminary comparison, not future planting advice.</p>${button(state.cropOptionsLoading?'Loading data…':'Help me choose','crop-help','secondary',state.cropOptionsLoading)}${state.cropOptionsError?`<p role="status">${escape(state.cropOptionsError)}</p>`:''}${data?`${data.options.some(option=>option.eligible)?'':'<p>The available data does not establish suitable options for this point.</p>'}<p>${escape(data.scopeLabel)} · ${escape(String(data.period))}</p><div class="crop-option-list">${data.options.map(option=>`<button type="button" data-action="crop" data-crop="${escape(option.crop)}" class="crop-option"><b>${cropName(option.crop)}</b><span>${validNumber(option.score)?`${fmt(option.score)} / 100`:'No data'} · ${tr('statuses.'+option.status,'No data')}</span><small>${escape(option.sourceLabel||'NASA POWER · USDA SSURGO/CDL')} · historical estimate</small><small>Costs: ${unit(option.costPerHa,'$/ha')} · price: ${unit(option.pricePerTonne,'$/t')} · ${escape(option.economicRegion||'region unspecified')} ${escape(option.economicYear||'year unspecified')}</small>${option.localWarning?`<small class="local-crop-warning">${escape(option.localWarning)}</small>`:''}</button>`).join('')}</div><ul>${data.limitations.map(note=>`<li>${escape(note)}</li>`).join('')}</ul>${data.sourceUrls.map(url=>sourceLink(url,'Primary source')).join(' ')}`:''}</section>`;
}

async function loadCropOptions() {
  if(state.step!==3||state.mode!=='own_land'||!validateTerritory(state).valid)return;
  const target=parcelReferencePoint(state.customArea);
  if(!target)return;
  const identity=JSON.stringify([state.customArea.ring,state.year]);
  state.cropOptionsLoading=true;state.cropOptionsError=null;stageRenderPreservingScroll();
  try{
    const result=await fetchCropOptions({...target,year:state.year});
    if(identity!==JSON.stringify([state.customArea?.ring,state.year]))return;
    state.cropOptions=result;
  }catch(error){state.cropOptionsError=error.message||'Could not load the comparison. You can still choose a crop below.';}
  finally{state.cropOptionsLoading=false;if(state.step===3)stageRenderPreservingScroll();}
}

function cropScreen() {
  return `
    <section class="wizard-stage" aria-labelledby="page-title">
      <div class="wizard-head">
        <div>
          <button type="button" class="link-button" data-action="go-territory">← Change area</button>

          <h1 class="live-step-heading" id="page-title" tabindex="-1">Which crop do you plan to grow?</h1>
          <p class="lead">Choose a crop, or compare options for your selected area.</p>
        </div>
        <div class="wizard-head-actions">
          <button type="button" class="secondary" data-action="compare">Compare economics</button>
        </div>
      </div>
      ${planningReadinessHtml()}
      ${cropOptionsHtml()}
      <div class="wizard-crop-grid">${CROP_IDS.map(crop=>cropCard(crop)).join('')}</div>
      <div class="wizard-footer-bar">
        <div class="wizard-chosen">${state.crop?`Selected: <strong>${cropName(state.crop)}</strong>`:'Choose a crop above to continue to irrigation settings.'}</div>
        <button type="button" class="primary wizard-next" data-action="go-conditions" ${state.crop?'':'disabled'}><span>Next: irrigation and conditions</span>${icon('arrow')}</button>
      </div>
    </section>
  `;
}

function irrigationScreen() {
  state.conditionsInputInvalid=false;
  const validation=validateConditions(state);
  const ready=validateTerritory(state).valid&&validation.valid&&!state.validationError;
  return `
    <section class="wizard-stage narrow" aria-labelledby="page-title">
      <button type="button" class="link-button" data-action="go-crops">← Change crop (${cropName(state.crop)})</button>

      <h1 class="live-step-heading" id="page-title" tabindex="-1">What are your growing conditions?</h1>
      <p class="lead">Set your area and irrigation scenario.</p>
      ${planningReadinessHtml()}
      <div class="wizard-card">
        <div class="live-form">
          <div class="live-field"><label for="scale-ha">Growing area, ha</label>${state.mode==='own_land'?`<p class="area-value">${formatArea(geodesicAreaHa(state.customArea?.ring))} · from your boundary</p>`:`<input id="scale-ha" type="number" inputmode="decimal" min="0.01" step="any" value="${escape(state.scaleHa)}" placeholder="For example, 25" required><small>Desired area for search; it does not confirm that a vacant field of this size exists.</small>`}</div>
          ${irrigationFields()}
          <div class="live-field"><label for="target-year">Target year for the readiness check (optional)</label><input id="target-year" type="number" min="${currentYear}" max="2100" step="1" value="${escape(state.targetYear)}" placeholder="Year, for example ${currentYear+1}"><small>This is a separate readiness parameter. The forecast covers the next few days; sowing dates and irrigation advice remain unavailable.</small></div>
          <details class="historical-settings"><summary>Historical map period · ${state.year}</summary><p>The map compares past conditions. These parameters do not determine future sowing.</p>
          <div class="live-inline-fields">
            <div class="live-field">
              <label for="year-select">Observation year</label>
              <select id="year-select">${[currentYear,currentYear-1,currentYear-2,currentYear-3].map(year=>`<option value="${year}" ${year===state.year?'selected':''}>${year}${year===currentYear?' · incomplete year':''}</option>`).join('')}</select>
            </div>
          </div>
          <div class="live-field">
            <label for="planting-date">Historical calculation period — start</label>
            <input type="date" id="planting-date" min="${state.year}-01-01" max="${state.year}-12-31" value="${state.planting}">
            <small>This is a model parameter for the selected year, not a future sowing recommendation. The service does not yet determine a planting date.</small>
          </div>
          </details>
          <p class="live-input-error" id="conditions-validation" role="status">${!validation.valid?escape(validation.error||'Check the conditions you entered.'):''}</p>
        </div>
        <div class="wizard-footer-bar">
          <div class="wizard-chosen">${state.irrigation?`${cropName(state.crop)} · historical data ${state.year} · ${waterScenarioLabel()}`:'First choose an irrigation mode above: no irrigation, available, or not sure.'}</div>
          <button type="button" class="primary wizard-next" data-action="go-map" ${ready?'':'disabled'}><span>Show suitability on the map</span>${icon('arrow')}</button>
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
      <div class="factor-bars-head"><span>7 suitability factors</span>${limiting?`<small>Limiting factor: ${escape(tr(`factorNames.${limiting}`,limiting))}</small>`:''}</div>
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
      <div><span>Rainfall (×0.8)</span><b>${fmt(wb.effective_rain_mm,0)} mm</b></div>
      <div><span>Scenario irrigation</span><b>${irrigationInputState(state.irrigation,state.water).known?`+${fmt(wb.irrigation_mm,0)} mm`:'Not specified'}</b></div>
      <div><span>ETc demand</span><b>${fmt(wb.demand_mm,0)} mm</b></div>
      <div><span>${gap>0?'Deficit':'Surplus'}</span><b>${gap>0?`-${fmt(gap,0)} mm`:`+${fmt(supply-wb.demand_mm,0)} mm`}</b></div>
    </div>
  `;
}

function areaBreakdownHtml(summary) {
  if(!summary)return '';
  const items=[['good','Suitable'],['conditional','Limited'],['poor','Unsuitable'],['unknown','No data'],['excluded','Outside analysis']]
    .filter(([key])=>(summary.counts?.[key]||0)>0);
  if(!items.length)return '';
  return `<div class="live-area-breakdown">${items.map(([key,label])=>`<span class="live-breakdown-chip"><i style="background:${STATUS_COLORS[key]}" aria-hidden="true"></i>${label}: <b>${fmt(summary.counts[key])}</b></span>`).join('')}</div>`;
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
  return target?`${Number(target.lon).toFixed(5)},${Number(target.lat).toFixed(5)}|${state.crop}|${state.mode}|${state.targetYear}|${state.scaleHa}`:'';
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
  const params=new URLSearchParams({mode:state.mode,crop:state.crop,lon:String(target.lon),lat:String(target.lat),refresh:refresh?'1':'0',scale_ha:String(planningContext(state).scaleHa)});
  if(state.targetYear)params.set('target_year',String(state.targetYear));
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

function pointPlanningHtml() {
  const key=planningKey(activeInsightTarget());
  if(!key)return '';
  const data=planningCache.get(key)?.data;
  if(!data)return `<section class="drawer-sub planning-point"><strong>Current conditions for planning</strong><span>${planningLoadingKey===key?'Loading the forecast and checking rule availability…':planningErrorKey===key?'Forecast and rules are currently unavailable. No planting date or irrigation amount has been determined.':'A planting date and irrigation amount have not been determined.'}</span>${planningErrorKey===key?button('Refresh forecast','reload-planning'):''}</section>`;
  const forecast=forecastOverview(data.forecast);
  const forecastSources=(data.forecast?.provenance||[]).map(meta=>sourceLink(meta.source_url,'NOAA/NWS source')).join(' ');
  const forecastHtml=forecast?`<span><b>NOAA/NWS · next 24 hours</b><br>Air temperature: ${formatRange(forecast.temperatureRangeC,' °C',1)}<br>Highest hourly precipitation probability: ${forecast.maxRainProbabilityPct===null?'No data':`${fmt(forecast.maxRainProbabilityPct)}%`}<br>Issued: ${dateTime(forecast.issuedAt)}<br>Forecast valid until: ${dateTime(forecast.validTo)}<br>Dates and times use your device time zone.</span>${forecastSources}`:`<span>Current forecast: ${escape(data.forecast?.reason||'No data for this point.')}</span>`;
  const rule=agronomicRuleOverview(data.agronomic_rules);
  const ruleHtml=rule?`<span><b>Local rules · ${cropName(state.crop)}</b><br>${rule.localGuideDiscouragesCrop?'The local guide discourages this crop type in the region.<br>':''}${rule.temperatureRangeC?`Published minimum soil temperature: ${formatRange(rule.temperatureRangeC,' °C',1)}${rule.depthCm===null?'':` at a depth of ${fmt(rule.depthCm,2)} cm`}. This is a reference threshold, not a measurement of current soil conditions.`:'No verified temperature threshold is available for automated assessment.'}${rule.verifiedAt?`<br>Source checked: ${escape(rule.verifiedAt)}`:''}</span>${sourceLink(rule.sourceUrl,'K-State guidance')}`:'<span>Local agronomic rules: no data.</span>';
  return `<section class="drawer-sub planning-point"><strong>Current conditions for planning</strong><span>${state.selected?'Forecast for the selected zone\u0027s reference point.':'Forecast only for a reference point inside the boundary.'} This is a weather-grid estimate, not a field measurement.</span>${forecastHtml}${ruleHtml}<span>A planting date and irrigation amount are not yet available. Forecasts and rules alone do not establish advice for this field.</span>${data.critical_gaps?.length?`<details><summary>What is still missing (${data.critical_gaps.length})</summary><ul class="live-missing-list">${data.critical_gaps.map(gap=>`<li>${escape(gap.message)}</li>`).join('')}</ul></details>`:''}${button('Refresh readiness check','reload-planning')}</section>`;
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
  const tabs=[['overview','Overview'],['compare','7 crops'],['risk','Risk (5 yr)'],['rotation','Rotation']];
  return `<div class="drawer-tabs" role="tablist" aria-label="Field details">${tabs.map(([id,label])=>`<button type="button" role="tab" aria-selected="${state.drawerTab===id}" class="drawer-tab ${state.drawerTab===id?'active':''}" data-action="drawer-tab" data-tab="${id}">${label}</button>`).join('')}</div>`;
}

function uncertaintyBoxHtml(uncertainty) {
  if(!uncertainty)return '';
  const range=uncertainty.score_range?`${fmt(uncertainty.score_range[0],0)}–${fmt(uncertainty.score_range[1],0)}`:'—';
  const agPct=validNumber(uncertainty.ag_share)?`${Math.round(uncertainty.ag_share*100)}%`:'—';
  return `<div class="drawer-sub uncertainty-box"><strong>Overview grid uncertainty (${fmt(uncertainty.sample_count)} samples)</strong><span>Score range: <b>${range}</b> · agricultural cover in the sample (CDL): <b>${agPct}</b> (${fmt(uncertainty.scored_samples)} scored, ${fmt(uncertainty.excluded_samples)} excluded, ${fmt(uncertainty.unknown_samples)} without data)</span></div>`;
}

function scalesContextHtml() {
  return `<div class="drawer-sub scale-box"><strong>Different observation scales (NASA · USDA)</strong><span>POWER ~55 km · SMAP ~9 km · MODIS NDVI 250–500 m · SSURGO survey units · CDL 10–30 m depending on year</span></div>`;
}

function compareTabHtml(data) {
  const rows=data.crop_comparison||[];
  const t=data.tradeoffs||{};
  const coveredNote=data.landcover?.allow_analysis===false?`<p class="drawer-note" style="color:#784a19">CDL identified “${escape(data.landcover.label||data.landcover.category)}” at the sample point. Potential soil-and-climate estimates are shown for comparison.</p>`:'';
  return `
    ${coveredNote}
    <div class="tradeoffs-strip">
      ${t.best_suitability?`<div><span>Highest score</span><b>${escape(t.best_suitability.name)} (${fmt(t.best_suitability.score,0)})</b></div>`:''}
      ${t.lowest_water_need?`<div><span>Lowest water demand</span><b>${escape(t.lowest_water_need.name)} (${fmt(t.lowest_water_need.demand_mm,0)} mm)</b></div>`:''}
      ${t.lowest_cost?`<div><span>Lowest cost</span><b>${escape(t.lowest_cost.name)} ($${fmt(t.lowest_cost.cost_per_ha,0)}/ha)</b></div>`:''}
    </div>
    <div class="insights-list">
      ${rows.map(row=>{
        const s=row.score??row.potential_score;
        const st=row.score!==null?row.status:row.potential_status;
        const pct=validNumber(s)?Math.max(4,Math.round(s)):0;
        const cost=validNumber(row.economics?.cost_per_ha)?`$${fmt(row.economics.cost_per_ha,0)}/ha`:'—';
        const price=validNumber(row.economics?.price_per_tonne)?`$${fmt(row.economics.price_per_tonne,0)}/t`:'—';
        const def=validNumber(row.deficit_mm)?(row.deficit_mm>0?`-${fmt(row.deficit_mm,0)} mm`:'0 mm'):'—';
        const lim=row.limiting_factor?tr(`factorNames.${row.limiting_factor}`,row.limiting_factor):'—';
        const active=row.crop===state.crop;
        return `
          <article class="insight-crop-card ${active?'current':''}">
            <div class="insight-crop-top">
              <strong>${escape(row.name)} ${active?'· selected':''}</strong>
              <span class="status-pill ${escape(st||'unknown')}">${validNumber(s)?`${fmt(s,1)} / 100`:'—'}</span>
            </div>
            <div class="factor-track"><span class="factor-fill ${escape(st==='good'||st==='conditional'||st==='poor'?st:'unknown')}" style="width:${pct}%"></span></div>
            <div class="insight-crop-meta">
              <span>Deficit: <b>${def}</b></span>
              <span>Factor: <b>${escape(lim)}</b></span>
              <span>Costs: <b>${cost}</b></span>
              <span>Price: <b>${price}</b></span>
            </div>
            ${!active?`<button type="button" class="mini-switch-btn" data-action="use-insight-crop" data-crop="${escape(row.crop)}">Show on map</button>`:''}
          </article>
        `;
      }).join('')}
    </div>
  `;
}

function riskTabHtml(data) {
  const risk=data.climate_risk;
  if(!risk)return '<p class="drawer-note">No data for risk assessment.</p>';
  const sum=risk.summary||{};
  const rainText=(validNumber(sum.rain_min_mm)&&validNumber(sum.rain_max_mm))?`${fmt(sum.rain_min_mm,0)}–${fmt(sum.rain_max_mm,0)} mm`:'—';
  const scoreText=(validNumber(sum.score_min)&&validNumber(sum.score_max))?`${fmt(sum.score_min,0)}–${fmt(sum.score_max,0)}`:'—';
  return `
    <div class="tradeoffs-strip">
      <div><span>Suitable / Limited</span><b>${fmt(sum.good_count)} + ${fmt(sum.conditional_count)} of ${fmt(sum.years_scored)}</b></div>
      <div><span>Score range</span><b>${scoreText}</b></div>
      <div><span>Seasonal rainfall</span><b>${rainText}</b></div>
    </div>
    <p class="drawer-note">${sum.heat_stress_years>0?`Days above the heat threshold occurred in ${fmt(sum.heat_stress_years)} of ${fmt(sum.years_scored)} seasons.`:'No days above the heat threshold were recorded in this period.'}</p>
    <div class="insights-list">
      ${(risk.years||[]).map(y=>{
        const st=y.status||'unknown';
        const pct=validNumber(y.score)?Math.max(4,Math.round(y.score)):0;
        const wet=validNumber(y.root_zone_wetness)?`root wetness ${Math.round(y.root_zone_wetness*100)}%`:'';
        return `
          <div class="risk-year-row">
            <div class="risk-year-head">
              <strong>${y.year}</strong>
              <span>${validNumber(y.precipitation_mm)?`${fmt(y.precipitation_mm,0)} mm rainfall`:'Incomplete season'}${y.heat_days>0?` · heat ${y.heat_days} days`:''}${wet?` · ${wet}`:''}</span>
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
  if(!rot)return '<p class="drawer-note">No data for rotation guidance.</p>';
  const anchorText=rot.anchor_source==='usda_cdl'
    ? `Reference crop identified by USDA CDL (${escape(rot.cdl_label)}): <strong>${escape(rot.anchor_name)}</strong>`
    : `Rotation from the selected crop: <strong>${escape(rot.anchor_name)}</strong>`;
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
                <span class="rot-season">${i===0?'Now':`Season +${i}`}</span>
                <div>
                  <b>${escape(st.name)}</b> <small>(${validNumber(st.score)?`${fmt(st.score,0)}/100`:'—'}${validNumber(st.deficit_mm)?` · deficit ${fmt(st.deficit_mm,0)} mm`:''})</small>
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
  if(state.insightsLoading&&!data)return '<div class="drawer-sub"><span class="live-loading-indicator" aria-hidden="true"></span> Comparing 7 crops, 5-year NASA POWER risk and rotations…</div>';
  if(state.insightsError&&!data)return `<p class="drawer-note" style="color:#8e301c">Could not load analysis: ${escape(state.insightsError)}</p>${button('Try again','reload-insights')}`;
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
    const title=feature?featureName(feature):'Selected area';
    const sub=feature?cropName(state.crop):`≈ ${formatArea(state.areaSummary?.areaHa||0)}`;
    drawer.innerHTML=`
      <div class="drawer-head">
        <div>
          <span class="drawer-kicker">${escape(sub)} · ${state.year}</span>
          <h2>${escape(title)}</h2>
        </div>
        <button type="button" class="drawer-close" data-action="close-drawer" aria-label="Hide panel">×</button>
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
        <button type="button" class="drawer-close" data-action="close-drawer" aria-label="Hide panel">×</button>
      </div>
      ${hasArea?`<button type="button" class="link-button" data-action="back-to-area">← Back to the boundary overview</button>`:''}
      ${drawerTabsHtml()}
      <div class="live-status-row">${statusPill(status)}<span class="live-score">${validNumber(result?.score)?`${fmt(result.score)} <small>/ 100</small>`:''}</span></div>
      <p class="drawer-note">${tr(`statusInfo.${status}`)}</p>
      <div class="live-toolbar">${button('Report & formulas','open-report','primary')}</div>
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
      <div class="live-toolbar">${button('Zoom to soil detail','detail')}${button('Method','formula')}</div>
    `;
    return;
  }
  const summary=state.areaSummary;
  if(state.loading||!summary){
    drawer.innerHTML=`<div class="drawer-head"><div><h2>Calculating the boundary summary…</h2></div><button type="button" class="drawer-close" data-action="close-drawer" aria-label="Hide panel">×</button></div><p class="drawer-note">Loading NASA and USDA data for ${formatArea(summary?.areaHa||0)}.</p>`;
    return;
  }
  const status=summary.status||'unknown';
  const color=STATUS_COLORS[status]||STATUS_COLORS.unknown;
  drawer.innerHTML=`
    <div class="drawer-head">
      <div>
        <span class="drawer-kicker">${cropName(state.crop)} · ${waterScenarioLabel()}</span>
        <h2>Selected area</h2>
      </div>
      <button type="button" class="drawer-close" data-action="close-drawer" aria-label="Hide panel">×</button>
    </div>
    ${drawerTabsHtml()}
    <div class="live-status-row">
      <span class="live-area-title-wrap"><span class="live-area-swatch" style="background:${color}" aria-hidden="true"></span>${statusPill(status)}</span>
      <span class="live-score">${validNumber(summary.score)?`${fmt(summary.score)} <small>/ 100</small>`:''}</span>
    </div>
    ${areaBreakdownHtml(summary)}
    <div class="live-toolbar">${button('Report & formulas','open-report','primary')}</div>
    ${compareFieldsDrawerHtml()}
    ${pointPlanningHtml()}
    ${factorBarsHtml(summary.avgFactors)}
    ${waterBalanceHtml(summary.avgWaterBalance)}
    <dl class="live-facts">
      <div><dt>Area</dt><dd>${formatArea(summary.areaHa)}</dd></div>
      <div><dt>Zones in boundary</dt><dd>${fmt(summary.totalCount)} (${fmt(summary.scoredCount)} scored)</dd></div>
      <div><dt>Soil pH</dt><dd>${formatRange(summary.soilPhRange,'',1)}</dd></div>
      <div><dt>Temperature</dt><dd>${formatRange(summary.tempRange,' °C',1)}</dd></div>
    </dl>
    ${scalesContextHtml()}
    <div class="live-toolbar">
      ${button(state.areaDisplay==='solid'?'Zones inside':'Solid color','toggle-area-display')}
      ${button('Zoom in','detail')}
      ${button('Clear','clear-area')}
    </div>
    ${economyCard()}
  `;
}

function landcoverCard(landcover) {
  if(!landcover)return '';
  const category=tr(`landcoverCategories.${landcover.category}`,landcover.label||'No data');
  return `<div class="drawer-sub"><strong>Land cover (USDA CDL ${escape(landcover.year??'')}, 30 m)</strong><span>${escape(landcover.label||category)} · code ${fmt(landcover.code)}</span></div>`;
}

function soilCard(soil) {
  if(!soil)return '';
  return `<div class="drawer-sub"><strong>Soil (SSURGO 0–30 cm)</strong><span>pH ${fmt(soil.ph,1)} · slope ${fmt(soil.slope,1)}% · AWC ${fmt(soil.awc,2)}</span></div>`;
}

function climateCard(climate) {
  if(!climate)return '';
  const topWet=validNumber(climate.surface_wetness)?`${Math.round(climate.surface_wetness*100)}%`:'—';
  const rootWet=validNumber(climate.root_zone_wetness)?`${Math.round(climate.root_zone_wetness*100)}%`:'—';
  const dryDays=validNumber(climate.dry_root_days)?` · dry days: ${fmt(climate.dry_root_days)}`:'';
  return `
    <div class="drawer-sub"><strong>Weather (NASA POWER, ~55 km)</strong><span>${fmt(climate.mean_temperature,1)} °C · rainfall ${fmt(climate.precipitation_mm,0)} mm · ETc ${fmt(climate.crop_water_demand_mm,0)} mm</span></div>
    <div class="drawer-sub"><strong>Soil wetness (POWER MERRA-2)</strong><span>Surface 0–5 cm: <b>${topWet}</b> · root zone 0–100 cm: <b>${rootWet}</b>${dryDays}</span></div>
  `;
}

function economyCard() {
  const data=economy(state.crop);
  return `<div class="drawer-sub"><strong>Economics (USDA ERS ${data?.year||state.year})</strong><span>Costs: ${unit(data?.cost_per_ha,'$/ha')} · Price: ${unit(data?.price_per_tonne,'$/t')}</span></div>`;
}

function renderDrawBar() {
  const bar=document.getElementById('draw-bar');
  if(!bar)return;
  if(!state.drawMode){bar.hidden=true;bar.innerHTML='';return;}
  bar.hidden=false;
  const isPoly=state.drawMode==='polygon';
  const hint=(awaitingCompareB?'Field A is saved. Draw the boundary of field B. ':'')+(!isPoly
    ?'Drag a rectangle on the map to select an area.'
    :state.drawPointsCount<3
    ?`Click the map to add boundary points (placed ${state.drawPointsCount}, at least 3 required).`
    :`Points placed: ${state.drawPointsCount}. Click the first green point, double-click, or choose “Finish boundary”.`);
  bar.innerHTML=`<div class="live-draw-controls"><div class="live-draw-modes" role="group" aria-label="Selection mode"><button type="button" class="${isPoly?'active':''}" data-action="draw-mode" data-mode="polygon">Points</button><button type="button" class="${!isPoly?'active':''}" data-action="draw-mode" data-mode="rect">Rectangle</button></div><div class="live-draw-buttons">${isPoly?`<button type="button" data-action="undo-point" ${state.drawPointsCount<1?'disabled':''}>Undo point</button><button type="button" class="accent" data-action="finish-draw" ${state.drawPointsCount<3?'disabled':''}>Finish boundary</button>`:''}<button type="button" data-action="select-view">Entire view</button><button type="button" data-action="cancel-draw">Cancel</button></div></div><p class="live-draw-hint">${hint}</p>`;
}

function renderAreaBanner() {
  const banner=document.getElementById('area-banner');
  if(!banner)return;
  if(!state.customArea||state.drawMode){banner.hidden=true;banner.innerHTML='';return;}
  banner.hidden=false;
  const summary=state.areaSummary;
  if(state.loading||!summary){
    banner.innerHTML=`<div class="live-area-banner-main"><span class="live-loading-indicator" aria-hidden="true"></span><div><strong>Selected area</strong><span>Calculating the summary color…</span></div></div><div class="live-area-banner-actions"><button type="button" data-action="clear-area">Clear</button></div>`;
    return;
  }
  const status=summary.status||'unknown';
  const color=STATUS_COLORS[status]||STATUS_COLORS.unknown;
  const scoreText=validNumber(summary.score)?` · ${fmt(summary.score)} / 100`:'';
  banner.innerHTML=`<div class="live-area-banner-main"><span class="live-area-swatch" style="background:${color}" aria-hidden="true"></span><div><strong>${tr(`statuses.${status}`)}${scoreText}</strong><span>≈ ${formatArea(summary.areaHa)} · ${fmt(summary.totalCount)} zones</span></div></div><div class="live-area-banner-actions"><button type="button" data-action="toggle-drawer">${state.drawerOpen?'Hide details':'Show details'}</button><button type="button" data-action="toggle-area-display">${state.areaDisplay==='solid'?'Zones inside':'Solid color'}</button><button type="button" data-action="clear-area">Clear</button></div>`;
}

function updateMapText() {
  if(state.step===2){renderDrawBar();return;}
  if(state.step!==5)return;
  const drawBtn=document.getElementById('draw-area-button');
  if(drawBtn){
    drawBtn.textContent=state.drawMode?'Drawing…':state.customArea?'Edit boundary':'Draw with points';
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
      ? `NASA MODIS Terra NDVI 8-Day layer (250–500 m · ${state.year})`
      : state.signalLayer==='smap'
      ? `NASA SMAP L4 root-zone moisture layer (~9 km · ${state.year})`
      : '';
    status.classList.toggle('error',!!state.error||!!state.validationError||!!meta?.truncated||(!state.loading&&!activeCount));
    status.hidden=!state.loading&&!state.error&&!state.validationError&&!meta?.truncated&&!meta?.stale&&activeCount>0&&!signalText;
    if(state.validationError)status.textContent=state.validationError;
    else if(state.loading)status.innerHTML='<span class="live-loading-indicator" aria-hidden="true"></span> Loading prepared map…';
    else if(state.error)status.textContent=`Error: ${state.error}`;
    else if(meta?.truncated)status.textContent=meta?.mode==='grid'?'Only part of the overview grid is shown. Zoom in or select an area.':'The first 400 polygons are shown. Zoom in or select a smaller area.';
    else if(!activeCount)status.textContent=meta?.nodata_reason&&meta.nodata_reason!=='not_precomputed'?meta.nodata_reason:'No prepared data here. Choose Available data to explore verified coverage.';
    else if(meta?.stale)status.textContent='Saved map awaiting a data refresh. Check its source dates before using the result.';
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
  return `<section class="result-context" aria-label="Current analysis conditions"><div><strong>${state.mode==='own_land'?'My field':'Suitable-area search'} · ${cropName(state.crop)}</strong><p>${state.mode==='own_land'?`Boundary ${formatArea(geodesicAreaHa(state.customArea?.ring))}`:`North America · desired area ${formatArea(Number(state.scaleHa))}`} · ${waterScenarioLabel()} · historical season ${state.year}${state.targetYear?` · target season ${escape(state.targetYear)}`:''}</p>${state.mode==='find_land'?'<small>The color does not confirm ownership, availability or a continuous field of the desired size.</small>':''}</div><div class="context-actions">${button('Change area','go-territory')}${button('Change crop','go-crops')}${button('Change conditions','go-conditions')}</div></section>`;
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
  state.validationError=invalid?'Enter a water amount between 0 and 5000 mm.':null;
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
  data.features.forEach((feature,index)=>{feature.properties.ui_label=`Zone #${index+1}`;});
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
  if(awaitingCompareB&&compareFieldA&&state.areaSummary){awaitingCompareB=false;openCompareFieldsModal();}
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
    const data=await loadPreparedMap(cond,queryBbox,queryZoom,{signal:controller.signal,refresh});
    if(data.type!=='FeatureCollection'||!Array.isArray(data.features))throw new Error('Unexpected server response format');
    if(identity!==requestId)return;
    storeCachedAnalysis(cond,queryBbox,queryZoom,data);
    applyAnalysisData(data);
    loadSources();
    announce(`Map updated. ${cropName(state.crop)}.`);
  }catch(error){
    if(error.name==='AbortError'||identity!==requestId)return;
    state.loading=false;state.error=error.message;state.meta=null;state.selected=null;state.collection=null;state.areaSummary=null;
    clearAnalysis();updateMapText();announce('Could not retrieve data.');
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
        if(values)values.innerHTML=`<div><span>Costs</span><b>${unit(data?.cost_per_ha,'$/ha')}</b></div><div><span>Harvest price</span><b>${unit(data?.price_per_tonne,'$/t')}</b></div>`;
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
  catch{state.sources={sources:[],error:'Could not retrieve source status.'};}
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
    setBaseLayer(state.baseMap);
    setOverlayOpacity(state.overlayOpacity);
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
  if(window.innerWidth<=820)window.scrollTo({top:0,behavior:'auto'});
  announce(`Step ${step}: ${flowStepNames[step-1]}`);
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

function handleAreaChange(area) {
  const outline=validateTerritory({...state,mode:'own_land',customArea:area});
  if(!outline.valid){
    state.drawMode=null;state.drawPointsCount=0;awaitingCompareB=false;
    setCustomArea(state.customArea);
    if(state.collection)setAnalysis(state.collection,state.areaSummary);
    state.drawerOpen=!!(state.selected||state.customArea);
    updateMapText();announce(outline.error);return;
  }
  state.customArea=area;
  if(state.mode==='own_land')state.ownArea=area;
  state.drawMode=null;state.drawPointsCount=0;
  state.cropOptions=null;state.cropOptionsError=null;
  invalidateAnalysis();
  const validation=validateTerritory(state);
  state.territoryError=validation.valid?null:validation.error;
  if(validation.areaHa)state.scaleHa=String(validation.areaHa);
  setAreaDisplayMode('solid');
  if(state.step===2){renderView();fitCustomArea();}
  else if(state.step===5){
    if(!validation.valid){state.step=2;renderView({focusId:'page-title'});}
    else{state.drawerOpen=true;updateMapText();loadAnalysis(false);}
  }
  announce(validation.valid?'Boundary selected. Continue to crop selection.':validation.error||'Check your boundary.');
}

function enterDrawMode(mode='polygon') {
  state.drawMode=mode==='rect'?'rect':'polygon';
  state.drawPointsCount=0;
  startAreaSelection(state.drawMode);
  updateMapText();
  document.getElementById('live-map')?.scrollIntoView({block:'center',behavior:'auto'});
}

function exitDrawMode() {
  if(awaitingCompareB)state.drawerOpen=true;
  awaitingCompareB=false;
  state.drawMode=null;
  state.drawPointsCount=0;
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
  announce('Selection cleared.');
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
  return `<div class="dialog-header"><h2 id="dialog-title" tabindex="-1">${title}</h2><button type="button" class="close-dialog" data-action="close-dialog" aria-label="Close">×</button></div>`;
}

function buildCurrentReport(){
  const target=activeInsightTarget(),water=irrigationInputState(state.irrigation,state.water);
  return buildCalculationReport({crop:state.crop,cropName:cropName(state.crop),year:state.year,planting:state.planting,
    irrigationMode:state.irrigation,irrigationMm:water.amountMm,irrigationKnown:water.known,targetYear:state.targetYear,
    scaleHa:state.scaleHa,mode:state.mode,selected:state.selected,areaSummary:state.areaSummary,
    coordinates:target?[target.lon,target.lat]:null,insights:insightsCache.get(insightKey(target)),
    planning:planningCache.get(planningKey(target))?.data,economics:economy(state.crop),meta:state.meta});
}
function captureCurrentFieldSnapshot(){
  if(state.loading||(!state.selected&&!state.areaSummary))return null;
  const report=buildCurrentReport(),r=state.selected?.properties?.result||{};
  return createFieldSnapshot({report,label:report.header.scopeLabel,geometryId:state.selected?String(state.selected.properties?.id??state.selected.id):JSON.stringify(state.customArea?.ring),
    coordinates:report.header.coordinates,area:state.selected?null:state.customArea,
    areaHa:state.selected?null:state.areaSummary.areaHa,irrigationLabel:waterScenarioLabel(),
    waterBalance:state.selected?r.water_balance:state.areaSummary.avgWaterBalance});
}
function compareFieldsDrawerHtml(){
  if(!state.selected&&!state.areaSummary)return '';
  if(!compareFieldA)return `<div class="compare-2-box"><button type="button" class="secondary" data-action="pin-compare-a">Compare with another field</button></div>`;
  const current=captureCurrentFieldSnapshot();
  return `<div class="compare-2-box"><strong>Field A saved: ${escape(compareFieldA.label)}</strong><p>Select another map zone or draw a second boundary.</p><div class="compare-2-actions">${current&&current.id!==compareFieldA.id?button('Compare with field A','compare-with-a','primary'):''}${button('Draw field B','draw-compare-b')}${compareFieldA.area?button('Restore field A','restore-compare-a'):''}${button('Reset comparison','clear-compare-fields')}</div></div>`;
}
function openCompareFieldsModal(){
  if(!compareFieldA)return;
  compareFieldB=captureCurrentFieldSnapshot();
  if(compareFieldB)renderDialog('compare-fields');
}
async function downloadCurrentPdf(comparison=false){
  if(downloadBusy)return;
  const payload=comparison?{...compareFieldB.report,comparison:compareTwoFields(compareFieldA,compareFieldB)}:lastReport;
  if(!payload)return;
  downloadBusy=true;
  const buttons=[...dialog.querySelectorAll('[data-action^="download-"]')];
  buttons.forEach(b=>b.disabled=true);
  const status=document.getElementById('report-download-status');if(status)status.textContent='Preparing PDF…';
  try{
    const response=await fetch('/api/report-pdf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!response.ok){const error=await response.json();throw Error(error.error||'PDF generation failed.');}
    if(!response.headers.get('content-type')?.includes('application/pdf'))throw Error('The server did not return a PDF.');
    const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');
    a.href=url;a.download=`growwhere-${comparison?'comparison':'report'}-${payload.header.crop}-${payload.header.year}.pdf`;
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    if(status?.isConnected)status.textContent='PDF downloaded.';
  }catch(error){if(status?.isConnected)status.textContent=error.message;}
  finally{downloadBusy=false;buttons.forEach(b=>{if(b.isConnected)b.disabled=false;});}
}
function restoreCompareFieldA(){
  if(!compareFieldA?.area)return;
  const h=compareFieldA.report.header,area=JSON.parse(JSON.stringify(compareFieldA.area));
  awaitingCompareB=false;invalidateAnalysis();state.mode=h.mode;state.crop=h.crop;state.year=h.year;state.planting=h.planting;
  state.irrigation=h.irrigationMode;state.water=h.irrigationMm;state.customArea=area;
  if(state.mode==='own_land')state.ownArea=area;
  state.scaleHa=String(compareFieldA.areaHa);state.drawerOpen=true;
  setCustomArea(area);renderView();fitCustomArea();loadAnalysis(false);
}

function renderDialog(type,show=true) {
  if(show)dialogTrigger=document.activeElement;
  dialog.dataset.type=type;
  dialog.className=['compare','report','compare-fields'].includes(type)?'compare-dialog report-dialog':'';
  let title='',content='';
  if(type==='report'){
    title='Report & formulas';content=renderReportDialogHtml(lastReport);
  }else if(type==='compare-fields'){
    title='Compare two fields';content=renderFieldCompareDialogHtml(compareTwoFields(compareFieldA,compareFieldB));
  }else if(type==='help') {
    title='How GrowWhere works';
    content=`<p class="live-dialog-text">Workflow:</p><div class="help-list">${[['1. Your goal','Choose your own field or search for suitable areas.'],['2. Area','Draw a closed boundary in the North America map area or choose North America as the search region.'],['3. Crop',`Choose one of ${CROP_IDS.length} crops. For your own field, a preliminary historical comparison is available at a reference point.`],['4. Conditions','Specify your scale and irrigation availability. Historical observations and a future target year are separate parameters.'],['5. Results map','Check suitability, sources and data gaps. Future planting dates and recommended irrigation are not yet available.']].map(([head,text],i)=>`<div class="help-item"><span class="step-num">${String(i+1).padStart(2,'0')}</span><div><h3>${head}</h3><p>${text}</p></div></div>`).join('')}</div>${button('Got it','close-dialog','primary')}`;
  }else if(type==='compare') {
    title='Crop economics comparison (USDA ERS)';
    content=`<p class="live-dialog-text">Regional costs and prices for ${state.year} .</p><div class="live-compare-grid">${CROP_IDS.map(crop=>{const data=economy(crop);return `<article class="live-compare-item"><h3>${cropName(crop)}</h3><dl><div><dt>Costs</dt><dd>${unit(data?.cost_per_ha,'$/ha')}</dd></div><div><dt>Price</dt><dd>${unit(data?.price_per_tonne,'$/t')}</dd></div><div><dt>Model optimum temperature</dt><dd>${escape(copy.cropNotes[crop]?.temp||'')}</dd></div></dl><button type="button" class="secondary" data-action="compare-crop" data-crop="${crop}">Select ${cropName(crop)}</button></article>`;}).join('')}</div>`;
  }else {
    title=type==='formula'?'Suitability method and data':'Sources, caching and limitations';
    const sourceRows=state.sources?.sources||[];
    const weights=state.meta?.weights||{water:.3,temperature:.2,ph:.15,awc:.1,drainage:.1,slope:.1,texture:.05};
    content=`<p class="live-dialog-text">The calculation combines climate from <strong>NASA POWER</strong>, soils from <strong>USDA SSURGO</strong>, land cover from <strong>USDA CDL</strong> and economics from <strong>USDA ERS</strong>.</p><div class="live-dialog-formula">f_water = clamp((0.8 × P_mm + irrigation_mm) / ETc_mm)<br>G = 100 × exp(Σ wᵢ × ln(fᵢ))<br>If min(fᵢ) &lt; 0.10 → S = min(G, 100 × √min(fᵢ))</div><p class="live-dialog-text">Daily ETc demand uses FAO-56 Penman–Monteith. The limiting cap applies only to critical constraints (&lt; 0.10), so changes in irrigation can affect suitability.</p><div class="live-factor-list">${Object.entries(weights).map(([k,v])=>`<div class="live-factor"><span>${escape(tr(`factorNames.${k}`,k))}</span><b>${fmt(v*100)}%</b></div>`).join('')}</div><h3 style="margin:20px 0 10px">Connected sources</h3><div class="live-sources-list">${sourceRows.length?sourceRows.map(source=>`<article><h3>${escape(source.name||source.id)}</h3><p><strong>${source.status==='connected'?'Connected':'Not connected'}</strong> · ${escape(source.role||'')}</p>${sourceLink(source.url||source.source_url,'Official source')}</article>`).join(''):'<p class="live-dialog-text">Source status will appear after the first server request.</p>'}</div><div style="margin-top:20px">${button('Close','close-dialog','primary')}</div>`;
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
  else if(action==='choose-region'){state.searchRegion='north-america';renderView();}
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
  }else if(action==='open-report'){
    lastReport=buildCurrentReport();renderDialog('report');
  }else if(action==='download-report-pdf'){
    downloadCurrentPdf(false);
  }else if(action==='download-comparison-pdf'){
    downloadCurrentPdf(true);
  }else if(action==='pin-compare-a'){
    compareFieldA=captureCurrentFieldSnapshot();compareFieldB=null;renderDrawer();announce('Field A saved. Select another map zone or draw field B.');
  }else if(action==='draw-compare-b'){
    if(compareFieldA){awaitingCompareB=true;state.drawerOpen=false;enterDrawMode('polygon');}
  }else if(action==='compare-with-a'){
    openCompareFieldsModal();
  }else if(action==='swap-compare-fields'){
    [compareFieldA,compareFieldB]=[compareFieldB,compareFieldA];renderDrawer();renderDialog('compare-fields',false);
  }else if(action==='clear-compare-fields'){
    compareFieldA=null;compareFieldB=null;awaitingCompareB=false;renderDrawer();
  }else if(action==='restore-compare-a'){
    restoreCompareFieldA();
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
    if(opBtn)opBtn.textContent=`Layer: ${Math.round(state.overlayOpacity*100)}%`;
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
  else if(action==='toggle-drawer'){state.drawerOpen=!state.drawerOpen;renderDrawer();renderAreaBanner();if(state.customArea)fitCustomArea();}
  else if(action==='toggle-area-display'){state.areaDisplay=state.areaDisplay==='solid'?'zones':'solid';setAreaDisplayMode(state.areaDisplay);renderAreaBanner();renderDrawer();}
  else if(action==='refresh'){analysisCache.clear();insightsCache.clear();clearPreparedCatalog();loadAnalysis(true);loadEconomics(true);loadSources();if(state.drawerOpen&&state.drawerTab!=='overview')loadPointInsights(true);}
  else if(action==='text-size'){state.large=!state.large;document.body.classList.toggle('large-text',state.large);target.setAttribute('aria-pressed',String(state.large));resizeMap();}
  else if(['help','compare','formula','sources'].includes(action)){
    if(action==='sources'&&!state.sources)loadSources().then(()=>renderDialog('sources'));
    else renderDialog(action);
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
    const message=document.getElementById('conditions-validation');if(message)message.textContent=event.target.validity.badInput?'Enter a valid number.':validation.error||'';
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
      if(chosen&&state.crop)chosen.textContent=`${cropName(state.crop)} · historical data ${state.year} · ${value===''?'irrigation amount not specified':`your scenario: ${fmt(value)} mm`}`;
    }else if(valid&&state.step===5)scheduleAnalysis(450);
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

document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.step===5&&!state.collection)loadAnalysis(false);});
window.setInterval(()=>{if(!document.hidden&&state.step===5){loadAnalysis(false);loadEconomics(false,true);loadSources();}},5*60*1000);

buildShell();
