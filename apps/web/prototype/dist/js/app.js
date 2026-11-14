import {t, locale} from './i18n.js';
import {crops, zones, suitability, budgetStatus} from './model.js';
import {loadMap, worldMap, regionMap} from './map.js';

const state = {step:1, crop:'wheat', zone:null, irrigation:'unknown', budget:'', zoom:1, large:false, mapStatus:'loading', notice:''};
const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
let dialogTrigger = null;
const n = value => new Intl.NumberFormat(locale).format(value);
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const cropName = id => t('cropNames.'+id);
const zoneName = id => t('zoneNames')[zones.find(z=>z.id===id)?.index ?? 0];

const paths = {
  arrow:'M4 12h16m-6-6 6 6-6 6', back:'M20 12H4m6-6-6 6 6 6',
  globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18Z',
  pin:'M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0ZM14.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  help:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM9.5 8.8c0-2.8 5-2.8 5 .2 0 2-2.5 1.8-2.5 4M12 17h.01',
  leaf:'M20 4C8 2 2 9 7 15c6 5 13-1 13-11ZM4 21 15 10M8 15h5',
  wheat:'M12 22V3M12 17C5 17 4 13 4 10c5 0 8 3 8 7ZM12 12C7 12 6 8 6 5c4 0 6 3 6 7ZM12 17c7 0 8-4 8-7-5 0-8 3-8 7ZM12 12c5 0 6-4 6-7-4 0-6 3-6 7Z',
  corn:'M12 22C4 18 3 12 4 8c5 2 8 6 8 14ZM12 22c8-4 9-10 8-14-5 2-8 6-8 14ZM8 12V7a4 4 0 0 1 8 0v5M12 4v12M8 7h8M9 10h6',
  check:'m5 12 4 4 10-10', shield:'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6ZM8 12l3 3 5-6',
  info:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 11v6M12 7h.01',
  layers:'m12 3 10 6-10 6L2 9Zm-10 12 10 6 10-6M2 12l10 6 10-6',
  chart:'M4 20V4M4 20h17M7 14l4-4 4 2 6-7M16 5h5v5',
  money:'M3 5h18v14H3ZM8 12h.01M16 12h.01M14 12a2 3 0 1 1-4 0 2 3 0 0 1 4 0Z',
  droplet:'M12 2C9 7 5 11 5 15a7 7 0 0 0 14 0c0-4-4-8-7-13ZM8 15c0 2 1 3 3 3',
  plus:'M12 5v14M5 12h14', minus:'M5 12h14', expand:'M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5', close:'m6 6 12 12M6 18 18 6'
};
function icon(name, cls='') {return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.leaf}"/></svg>`;}
function announce(message) { document.querySelector('#announcement').textContent = message; }
function primary(label, action, disabled=false) { return `<button class="primary" data-action="${action}" ${disabled?'disabled':''}><span>${label}</span>${icon('arrow')}</button>`; }
function waterControl() { return `<fieldset class="water-group"><legend class="field-label">${t('waterQuestion')}</legend><div class="segmented">${Object.entries(t('waterOptions')).map(([id,label])=>`<button type="button" id="water-${id}" class="segment ${state.irrigation===id?'active':''}" data-action="water" data-value="${id}" aria-pressed="${state.irrigation===id}">${label}</button>`).join('')}</div></fieldset>`; }
function header() { return `<header class="site-header"><button class="brand" data-action="home" aria-label="GrowWhere — ${t('worldBack')}"><img src="assets/logo.png" alt="" width="49" height="49"><div><div class="brand-name">GrowWhere</div><div class="brand-tag">${t('brandTag')}</div></div></button><div class="header-actions"><span class="prototype-tag">${t('prototype')}</span><button id="text-size" class="header-button text-button" data-action="text-size" aria-label="${t(state.large?'textSizeActive':'textSize')}" aria-pressed="${state.large}">A+</button><button class="header-button help-button" data-action="help" aria-label="${t('help')}">${icon('help')}<span>${t('help')}</span></button><span class="language">${icon('globe')}${t('language')}</span></div></header>`; }
function progress() { return `<div class="progress-wrap"><nav class="progress" aria-label="${t('stepOf',{step:state.step})}">${t('steps').map((name,i)=>`${i?'<span class="progress-line" aria-hidden="true"></span>':''}<button class="progress-step ${i+1===state.step?'current':i+1<state.step?'done':''}" data-action="step" data-step="${i+1}" ${i+1>state.step?'disabled':''} ${i+1===state.step?'aria-current="step"':''} aria-label="${t('stepAccessible',{name})}"><span class="progress-number">${i+1<state.step?icon('check'):i+1}</span><span>${name}</span></button>`).join('')}</nav></div>`; }
function demoBanner() { return `<aside class="demo-banner" aria-label="${t('demo')}"><div class="demo-text">${icon('info')}<span><strong>${t('demo')}.</strong> ${t('demoNote')}</span></div><button class="link-button" data-action="data">${t('demoDetails')}${icon('arrow')}</button></aside>`; }
function footer() { return `<footer class="site-footer"><div class="footer-brand">GrowWhere<span style="color:#27a476">.</span></div><div class="footer-copy">${t('footer')}<div class="footer-small">${t('footerSmall')}</div></div></footer>`; }
function benefits() { return `<section class="benefits"><h2>${t('whyTitle')}</h2><div class="benefit-grid">${t('whyCards').map(([title,description],i)=>`<article class="benefit"><div class="benefit-icon">${icon(['leaf','pin','chart'][i])}</div><div><h3>${title}</h3><p>${description}</p></div></article>`).join('')}</div></section>`; }
function introPanel() {return `<section class="intro-panel"><p class="eyebrow">${t('eyebrow')}</p><h1 id="page-title" tabindex="-1" class="hero-title">${t('heroLine1')}<br><span class="second-line">${t('heroLine2')}</span></h1><p class="hero-description">${t('heroText')}</p><div class="setup"><label class="field-label" for="region-select">${t('regionLabel')}</label><div class="select-wrap">${icon('pin')}<select id="region-select" name="region"><option value="us">${t('regionName')}</option>${t('regions').slice(1).map(name=>`<option disabled>${name} — ${t('soon')}</option>`).join('')}</select></div><p class="field-hint">${t('regionHint')}</p>${waterControl()}${primary(t('start'),'start')}<p class="no-registration">${icon('shield')}${t('noRegistration')}</p></div></section>`; }
function mapCard(world=false) {
  const crop=crops.find(c=>c.id===state.crop);
  const title=world?t('worldHeading'):state.step===2?t('cropMapTitle'):t('regionMapTitle',{crop:cropName(state.crop)});
  return `<section id="map" class="map-card ${world?'world-card':'region-card'}" aria-labelledby="map-title"><div class="map-heading"><div><h2 id="map-title">${title}</h2><p>${t(world?'worldDescription':state.step===2?'cropMapDescription':'regionMapDescription')}</p></div><span class="map-chip"><span class="live-dot"></span>${t(world?'available':'demo')}</span></div><div class="map-surface">${world?(state.mapStatus==='ready'?worldMap():`<div class="map-loading">${t(state.mapStatus==='error'?'mapError':'mapLoading')}${state.mapStatus==='error'?`<button class="secondary" data-action="retry-map">${t('retry')}</button>`:''}</div>`):`${regionMap(state)}<span class="map-crop-pill">${icon(crop.icon)}${cropName(crop.id)}</span><div class="map-tools"><button id="zoom-in" data-action="zoom-in" aria-label="${t('zoomIn')}" ${state.zoom>=1.4?'disabled':''}>${icon('plus')}</button><button id="zoom-out" data-action="zoom-out" aria-label="${t('zoomOut')}" ${state.zoom<=1?'disabled':''}>${icon('minus')}</button><button id="reset-map" data-action="reset-map" aria-label="${t('resetMap')}">${icon('expand')}</button></div>`}</div>${state.notice&&world?`<div class="map-status" role="status">${escape(state.notice)}</div>`:''}${!world?`<div class="map-legend" aria-label="${t('compareCondition')}">${['good','conditional','poor','unknown'].map(status=>`<span class="legend-item"><span class="legend-swatch ${status}" aria-hidden="true"></span>${t('statuses.'+status)}</span>`).join('')}</div>${state.step===3?`<div class="quick-zone-picker"><label for="zone-picker">${t('zoneChoose')}</label><select id="zone-picker"><option value="">${t('zoneLabel')}</option>${zones.map(z=>`<option value="${z.id}" ${state.zone===z.id?'selected':''}>${z.index+1}. ${t('zoneShort')[z.index]} — ${t('statuses.'+suitability(state.crop,z.id,state.irrigation))}</option>`).join('')}</select></div>`:''}`:''}<div class="map-bottom"><span>${t(world?'worldNote':'demoZones')}</span>${world?`<a href="https://www.naturalearthdata.com/about/terms-of-use/" target="_blank" rel="noopener noreferrer">${t('mapSource')} ↗</a>`:`<span>${t('period')}</span>`}</div></section>`;
}
function cropPanel() {return `<section class="intro-panel"><button class="link-button detail-back" data-action="home">${icon('back')}${t('worldBack')}</button><p class="eyebrow">${t('cropEyebrow')}</p><h1 id="page-title" tabindex="-1" class="panel-heading">${t('cropTitle')}</h1><p class="panel-description">${t('cropIntro')}</p><div class="small-controls"><label for="water-select">${t('chosenWater')}</label><select id="water-select">${Object.entries(t('waterOptions')).map(([id,label])=>`<option value="${id}" ${state.irrigation===id?'selected':''}>${label}</option>`).join('')}</select></div><p class="inline-demo">${t('cropDataNote')}</p><div class="crop-list" role="group" aria-label="${t('cropTitle')}">${crops.map(c=>`<button class="crop-card ${state.crop===c.id?'active':''}" data-action="crop" data-crop="${c.id}" id="crop-${c.id}" aria-pressed="${state.crop===c.id}" aria-label="${t('selectCrop',{crop:cropName(c.id)})}"><div class="crop-top"><span class="crop-art ${c.id}">${icon(c.icon)}</span><span class="crop-name">${cropName(c.id)}</span><span class="radio-mark">${state.crop===c.id?icon('check'):''}</span></div><div class="crop-metrics"><div><span>${t('growingCost')}</span><b>${n(c.cost)} <small>${t('perHa')}</small></b></div><div><span>${t('salePrice')}</span><b>${n(c.price)} <small>${t('perTonne')}</small></b></div><div class="crop-market">${icon('chart')}${t('markets.'+c.market)}</div></div></button>`).join('')}</div><div class="action-stack">${primary(t('viewLand'),'find-land')}<button class="link-button" data-action="compare">${icon('layers')}${t('compare')}</button></div></section>`; }
function statusPill(status) {return `<span class="status-pill ${status}">${icon(status==='good'?'check':status==='unknown'?'help':'info')}${t('statuses.'+status)}</span>`; }
function budgetMessage() {
  const status=budgetStatus(crops.find(c=>c.id===state.crop).cost,state.budget);
  return status?`<p class="budget-message ${status}" role="status">${t(status==='fit'?'budgetFit':'budgetOver')}</p>`:'';
}
function moneyBlock() {
  const crop=crops.find(c=>c.id===state.crop);
  return `<section class="detail-block"><h2>${icon('money')}${t('moneyTitle')}</h2><div class="money-numbers"><div><p class="money-label">${t('growingCost')}</p><b>${n(crop.cost)} <small>${t('perHa')}</small></b></div><div><p class="money-label">${t('salePrice')}</p><b>${n(crop.price)} <small>${t('perTonne')}</small></b></div></div><p class="money-note">${t('moneyNote')}</p><div class="market-row"><span>${t('market')}</span><span class="market-value">${icon('chart')}${t('markets.'+crop.market)}</span></div><div class="budget-field"><label for="budget">${t('budgetLabel')}</label><input id="budget" type="number" inputmode="decimal" min="0" step="50" placeholder="${t('budgetPlaceholder')}" value="${escape(state.budget)}"><div id="budget-feedback">${budgetMessage()}</div></div></section>`;
}
function detailPanel() {
  const zone=zones.find(z=>z.id===state.zone);
  const status=zone?suitability(state.crop,zone.id,state.irrigation):null;
  const tipKeys={good:'growingTipGood',conditional:'growingTipConditional',poor:'growingTipPoor',unknown:'growingTipUnknown'};
  return `<section class="detail-panel"><button class="link-button detail-back" data-action="back-crops">${icon('back')}${t('cropTitle')}</button><div class="detail-header"><h1 id="page-title" tabindex="-1">${zone?t('zoneShort')[zone.index]:t('detailTitle')}</h1>${status?statusPill(status):''}</div><p class="detail-subtitle">${cropName(state.crop)} · ${t('regionContext')}</p>${zone?`<section class="detail-block"><h2>${icon('leaf')}${t('conditionsTitle')}</h2><p class="detail-text">${t('statusDescriptions.'+status)}</p><div class="facts"><div class="fact"><span>${t('soil')}</span><b>${t('soils.'+zone.soil)}</b></div><div class="fact"><span>${t('moisture')}</span><b>${t('moistures.'+zone.moisture)}</b></div></div>${state.irrigation==='unknown'?`<p class="unknown-water">${t('unknownWater')}</p>`:''}<p class="detail-text" style="margin-top:13px">${t(tipKeys[status])}</p></section>${moneyBlock()}`:`<div class="empty-detail">${icon('pin')}<h2>${t('zonePrompt')}</h2><p>${t('zonePromptText')}</p></div>`}<div class="small-controls"><label for="water-select">${t('chosenWater')}</label><select id="water-select">${Object.entries(t('waterOptions')).map(([id,label])=>`<option value="${id}" ${state.irrigation===id?'selected':''}>${label}</option>`).join('')}</select></div><div class="action-stack">${primary(t('summary'),'summary',!zone)}<button class="secondary" data-action="compare">${icon('layers')}${t('compare')}</button><button class="link-button" data-action="data">${icon('info')}${t('sourceLabel')}</button></div></section>`;
}
function render({focusId=null}={}) {
  document.body.classList.toggle('large-text',state.large);
  app.innerHTML = `${header()}${progress()}<main class="main" id="main"><div class="workspace ${state.step===3?'detail-workspace':''}">${state.step===1?introPanel():state.step===2?cropPanel():detailPanel()}${mapCard(state.step===1)}</div>${demoBanner()}${state.step===1?benefits():'<div style="height:30px"></div>'}</main>${footer()}`;
  if(focusId) document.getElementById(focusId)?.focus({preventScroll:true});
}
function setStep(step) {
  state.step=step;state.notice='';state.zoom=1;
  render({focusId:'page-title'});
  window.scrollTo({top:0,behavior:'instant'});
  announce(t('stepChanged',{step,name:t('steps')[step-1]}));
}
function showDialog(type) {
  dialogTrigger=document.activeElement;
  dialog.className=type==='compare'?'compare-dialog':'';
  let content='';let title='';
  if(type==='help') {
    title=t('helpTitle');
    content=`<p class="dialog-intro">${t('helpIntro')}</p><div class="help-list">${t('helpSteps').map(([head,body],i)=>`<div class="help-item"><span class="help-number">${i+1}</span><div><h3>${head}</h3><p>${body}</p></div></div>`).join('')}</div>${primary(t('gotIt'),'close-dialog')}`;
  } else if(type==='data') {
    title=t('dataTitle');
    content=`<p class="data-copy">${t('dataBody')}</p><p class="data-copy">${t('dataFuture')}</p><p class="data-copy">${t('costIncludes')}</p>${primary(t('gotIt'),'close-dialog')}`;
  } else if(type==='compare') {
    title=t('compareTitle');
    const row=(heading,fn)=>`<tr><th scope="row">${heading}</th>${crops.map(c=>`<td>${fn(c)}</td>`).join('')}</tr>`;
    content=`<p class="dialog-intro">${t('compareIntro')}</p><div class="compare-scroll" tabindex="0"><table class="compare-table"><thead><tr><th scope="col">${t('chosenCulture')}</th>${crops.map(c=>`<th scope="col">${cropName(c.id)}</th>`).join('')}</tr></thead><tbody>${row(t('growingCost'),c=>`${n(c.cost)} ${t('perHa')}`)}${row(t('salePrice'),c=>`${n(c.price)} ${t('perTonne')}`)}${row(t('market'),c=>t('markets.'+c.market))}${row(t('compareCondition'),c=>state.zone?statusPill(suitability(c.id,state.zone,state.irrigation)):t('noZone'))}${row('',c=>`<button class="secondary" data-action="compare-select" data-crop="${c.id}">${t('selectCrop',{crop:cropName(c.id)})}</button>`)}</tbody></table></div><div class="compare-mobile">${crops.map(c=>`<article><h3>${cropName(c.id)}</h3><dl><div><dt>${t('growingCost')}</dt><dd>${n(c.cost)} ${t('perHa')}</dd></div><div><dt>${t('salePrice')}</dt><dd>${n(c.price)} ${t('perTonne')}</dd></div><div><dt>${t('market')}</dt><dd>${t('markets.'+c.market)}</dd></div><div><dt>${t('compareCondition')}</dt><dd>${state.zone?statusPill(suitability(c.id,state.zone,state.irrigation)):t('noZone')}</dd></div></dl><button class="secondary" data-action="compare-select" data-crop="${c.id}">${t('selectCrop',{crop:cropName(c.id)})}</button></article>`).join('')}</div><p class="money-note" style="margin-bottom:20px">${t('marketExplain')}</p>`;
  } else if(type==='summary' && state.zone) {
    title=t('summaryTitle');
    const crop=crops.find(c=>c.id===state.crop);
    const status=suitability(state.crop,state.zone,state.irrigation);
    content=`<p class="dialog-intro">${t('summaryIntro')}</p><dl class="summary-grid">${[[t('chosenCulture'),cropName(state.crop)],[t('chosenTerritory'),zoneName(state.zone)],[t('chosenWater'),t('waterOptions.'+state.irrigation)],[t('compareCondition'),statusPill(status)],[t('growingCost'),`${n(crop.cost)} ${t('perHa')}`],[t('salePrice'),`${n(crop.price)} ${t('perTonne')}`]].map(([a,b])=>`<div><dt>${a}</dt><dd>${b}</dd></div>`).join('')}</dl><p class="summary-note">${t('statusDescriptions.'+status)}</p><p class="summary-note">${t('moneyNote')} ${t('demoNote')}</p>${primary(t('keepExploring'),'close-dialog')}`;
  }
  dialog.innerHTML=`<div class="dialog-body"><div class="dialog-header"><h2 id="dialog-title" tabindex="-1">${title}</h2><button class="close-dialog" data-action="close-dialog" aria-label="${t('close')}">${icon('close')}</button></div>${content}</div>`;
  dialog.showModal();
  dialog.querySelector('h2').focus();
}
function chooseZone(zoneId) {
  if(!zones.some(z=>z.id===zoneId)) return;
  state.zone=zoneId;
  if(state.step!==3) setStep(3); else render({focusId:'page-title'});
  announce(t('mapSelected',{zone:zoneName(zoneId),status:t('statuses.'+suitability(state.crop,zoneId,state.irrigation))}));
  if(window.innerWidth<=780) document.querySelector('.detail-panel').scrollIntoView({behavior:'smooth',block:'start'});
}
async function fetchMap() {
  state.mapStatus='loading';render();
  try { await loadMap();state.mapStatus='ready'; } catch {state.mapStatus='error';}
  render();
}
document.addEventListener('click',event=>{
  const target=event.target.closest('[data-action]');
  if(!target || target.disabled) return;
  const action=target.dataset.action;
  if(action==='start') setStep(2);
  else if(action==='home') setStep(1);
  else if(action==='step') setStep(Number(target.dataset.step));
  else if(action==='water') {state.irrigation=target.dataset.value;render({focusId:`water-${state.irrigation}`});}
  else if(action==='crop') {state.crop=target.dataset.crop;render({focusId:`crop-${state.crop}`});announce(`${cropName(state.crop)}. ${t('cropMapDescription')}`);}
  else if(action==='find-land') setStep(3);
  else if(action==='back-crops') setStep(2);
  else if(action==='zone') chooseZone(target.dataset.zone);
  else if(action==='text-size') {state.large=!state.large;render({focusId:'text-size'});}
  else if(['help','data','compare','summary'].includes(action)) showDialog(action);
  else if(action==='close-dialog') dialog.close();
  else if(action==='compare-select') {state.crop=target.dataset.crop;dialog.close();render({focusId:'page-title'});announce(cropName(state.crop));}
  else if(action==='region') {
    const index=Number(target.dataset.region);
    state.notice=index===0?t('regionReady'):t('unavailableRegion',{region:t('regions')[index]});
    render();announce(state.notice);
  }
  else if(action==='retry-map') fetchMap();
  else if(action==='zoom-in') {state.zoom=Math.min(1.4,state.zoom+.2);render({focusId:state.zoom>=1.4?'reset-map':'zoom-in'});}
  else if(action==='zoom-out') {state.zoom=Math.max(1,state.zoom-.2);render({focusId:state.zoom<=1?'reset-map':'zoom-out'});}
  else if(action==='reset-map') {state.zoom=1;render({focusId:'reset-map'});}
});
document.addEventListener('keydown',event=>{
  if((event.key==='Enter'||event.key===' ') && event.target.matches('[role="button"][data-action]')) {event.preventDefault();event.target.dispatchEvent(new MouseEvent('click',{bubbles:true}));}
});
document.addEventListener('change',event=>{
  if(event.target.id==='zone-picker') chooseZone(event.target.value);
  if(event.target.id==='water-select') {state.irrigation=event.target.value;render({focusId:'water-select'});}
});
document.addEventListener('input',event=>{
  if(event.target.id==='budget') {state.budget=event.target.value;document.getElementById('budget-feedback').innerHTML=budgetMessage();}
});
dialog.addEventListener('close',()=>{if(dialogTrigger?.isConnected) dialogTrigger.focus({preventScroll:true});});
dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
fetchMap();
