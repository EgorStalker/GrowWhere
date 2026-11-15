import {tr} from './live-i18n.js';
import {geometryContainsPoint, polygonBounds} from './area-selection.js';
import {buildPresentationZones} from './map-presentation.js';

export const STATUS_COLORS={good:'#27a985',conditional:'#e7b85a',poor:'#d87464',unknown:'#b9c2c6',excluded:'#77858a'};
const DEFAULT_COVERAGE=[-180,5,-10,84];
let map, polygons, presentationLayer, selectedOutline, coverageOutline, coverageBackground, outsideCoverage, customAreaLayer, draftLayer, draftPreviewLayer, draftMarkers;
let osmLayer, satLayer, labelsLayer, gibsLayer;
let baseMode='satellite';
let signalMode='index'; // 'index' | 'ndvi' | 'smap'
let signalYear=new Date().getUTCFullYear()-1;
let overlayOpacity=0.42;
let onMove, onSelect, onAreaChange, onDrawProgress, selectedId=null;
const featureLayers=new Map();
let collection={type:'FeatureCollection',features:[]};
let pending=false;

let drawMode=null; // null | 'rect' | 'polygon'
let customArea=null; // {kind:'rect'|'polygon', ring:[[lng,lat],...], bbox:[w,s,e,n]}
let areaSummary=null;
let areaDisplayMode='solid'; // 'solid' | 'zones'
let draftPoints=[];
let rectAnchor=null; // {latlng, point}
let rectDragging=false;

export function initMap({move,select,areaChange,drawProgress,tileError}) {
  if(!window.L) throw new Error('Leaflet failed to load');
  onMove=move;onSelect=select;onAreaChange=areaChange;onDrawProgress=drawProgress;
  map=L.map('live-map',{zoomControl:false,minZoom:2,maxZoom:18,worldCopyJump:true,keyboard:true,scrollWheelZoom:true,preferCanvas:false,zoomAnimation:false,fadeAnimation:false});
  L.control.zoom({position:'topright',zoomInTitle:'Zoom in',zoomOutTitle:'Zoom out'}).addTo(map);
  L.control.scale({imperial:false,position:'bottomleft'}).addTo(map);
  osmLayer=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:19,maxNativeZoom:19,updateWhenIdle:true,keepBuffer:1,
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
  });
  satLayer=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{
    maxZoom:19,maxNativeZoom:19,updateWhenIdle:true,keepBuffer:1,
    attribution:'Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics'
  });
  map.createPane('overlayLabels');map.getPane('overlayLabels').style.zIndex=435;
  map.getPane('overlayLabels').style.pointerEvents='none';
  labelsLayer=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',{
    maxZoom:19,maxNativeZoom:19,pane:'overlayLabels',opacity:0.9,updateWhenIdle:true
  });
  [osmLayer,satLayer].forEach(layer=>layer.on('tileerror',()=>tileError?.()));
  applyBaseLayer();
  map.createPane('coverageBackground');map.getPane('coverageBackground').style.zIndex=390;
  map.getPane('coverageBackground').style.pointerEvents='none';
  map.createPane('nasaSignal');map.getPane('nasaSignal').style.zIndex=402;
  map.getPane('nasaSignal').style.pointerEvents='none';
  map.createPane('analysisPolygons');map.getPane('analysisPolygons').style.zIndex=410;
  map.getPane('analysisPolygons').style.pointerEvents='none';
  map.createPane('analysisHits');map.getPane('analysisHits').style.zIndex=411;
  map.createPane('customArea');map.getPane('customArea').style.zIndex=425;
  map.getPane('customArea').style.pointerEvents='none';
  map.createPane('selectedZone');map.getPane('selectedZone').style.zIndex=430;
  map.getPane('selectedZone').style.pointerEvents='none';
  map.createPane('drawDraft');map.getPane('drawDraft').style.zIndex=440;
  outsideCoverage=L.polygon([[[85,-180],[85,180],[-85,180],[-85,-180]],[[DEFAULT_COVERAGE[1],DEFAULT_COVERAGE[0]],[DEFAULT_COVERAGE[1],DEFAULT_COVERAGE[2]],[DEFAULT_COVERAGE[3],DEFAULT_COVERAGE[2]],[DEFAULT_COVERAGE[3],DEFAULT_COVERAGE[0]]]],{pane:'coverageBackground',color:STATUS_COLORS.unknown,weight:0,fillColor:'#0b0f0e',fillOpacity:.18,interactive:false}).addTo(map);
  coverageBackground=L.rectangle([[DEFAULT_COVERAGE[1],DEFAULT_COVERAGE[0]],[DEFAULT_COVERAGE[3],DEFAULT_COVERAGE[2]]],{pane:'coverageBackground',color:'#27d39b',weight:1,fillColor:STATUS_COLORS.unknown,fillOpacity:.06,interactive:false}).addTo(map);
  coverageOutline=L.rectangle(coverageBackground.getBounds(),{color:'#27d39b',weight:2.5,dashArray:'7 6',fill:false,interactive:false}).addTo(map);
  presentationLayer=L.geoJSON(null,{pane:'analysisPolygons',renderer:L.canvas({pane:'analysisPolygons',padding:.3}),interactive:false,smoothFactor:0,style:featureStyle}).addTo(map);
  polygons=L.geoJSON(null,{pane:'analysisHits',smoothFactor:0,style:hitFeatureStyle,onEachFeature}).addTo(map);
  customAreaLayer=L.geoJSON(null,{pane:'customArea',interactive:false}).addTo(map);
  selectedOutline=L.geoJSON(null,{pane:'selectedZone',interactive:false,smoothFactor:0,style:{color:'#153e35',weight:2.5,opacity:1,fill:false,lineJoin:'round'}}).addTo(map);
  draftLayer=L.layerGroup({pane:'drawDraft'}).addTo(map);
  draftPreviewLayer=L.layerGroup({pane:'drawDraft'}).addTo(map);
  draftMarkers=L.layerGroup({pane:'drawDraft'}).addTo(map);

  map.on('moveend',()=>onMove?.());
  map.on('mousemove',event=>{
    if(drawMode==='polygon'&&draftPoints.length>=1)renderPolygonPreview(event.latlng);
  });
  map.on('click',event=>{
    if(drawMode==='polygon'){
      addPolygonPoint(event.latlng);
      return;
    }
    if(drawMode==='rect'||pending)return;
    const feature=collection.features.find(f=>geometryContainsPoint(f.geometry,event.latlng.lng,event.latlng.lat));
    if(feature)selectFeature(feature.properties?.id ?? feature.id);
  });
  map.on('dblclick',event=>{
    if(drawMode==='polygon'){
      L.DomEvent.stop(event);
      finishPolygonSelection();
    }
  });

  const container=map.getContainer();
  container.addEventListener('pointerdown',handlePointerDown);
  window.addEventListener('pointermove',handlePointerMove);
  window.addEventListener('pointerup',handlePointerUp);
  window.addEventListener('pointercancel',handlePointerCancel);

  map.fitBounds(coverageBackground.getBounds(),{padding:[18,18],maxZoom:7});
  container.setAttribute('aria-label','Suitability map. Pan with arrow keys and zoom with plus and minus. You can draw a boundary or select a listed zone.');
  return map;
}

function handlePointerDown(event) {
  if(drawMode!=='rect')return;
  if(event.pointerType==='mouse'&&event.button!==0)return;
  if(event.target.closest('.leaflet-control'))return;
  event.preventDefault();
  const latlng=map.mouseEventToLatLng(event);
  const point=map.mouseEventToContainerPoint(event);
  if(!rectAnchor){
    rectAnchor={latlng,point};
    rectDragging=true;
    updateRectDraft(latlng);
  }else{
    commitRect(rectAnchor.latlng,latlng);
  }
}

function handlePointerMove(event) {
  if(drawMode!=='rect'||!rectAnchor)return;
  const latlng=map.mouseEventToLatLng(event);
  updateRectDraft(latlng);
}

function handlePointerUp(event) {
  if(drawMode!=='rect'||!rectAnchor||!rectDragging)return;
  rectDragging=false;
  const point=map.mouseEventToContainerPoint(event);
  const dx=Math.abs(point.x-rectAnchor.point.x);
  const dy=Math.abs(point.y-rectAnchor.point.y);
  if(dx>=10&&dy>=10){
    const latlng=map.mouseEventToLatLng(event);
    commitRect(rectAnchor.latlng,latlng);
  }
}

function handlePointerCancel() {
  if(drawMode!=='rect')return;
  rectDragging=false;
}

function updateRectDraft(otherLatLng) {
  draftLayer.clearLayers();
  if(!rectAnchor)return;
  const bounds=L.latLngBounds(rectAnchor.latlng,otherLatLng);
  L.rectangle(bounds,{pane:'drawDraft',color:'#102d20',weight:3,dashArray:'6 4',fillColor:'#27d39b',fillOpacity:.22,interactive:false}).addTo(draftLayer);
}

function commitRect(a,b) {
  const west=Math.min(a.lng,b.lng), east=Math.max(a.lng,b.lng);
  const south=Math.min(a.lat,b.lat), north=Math.max(a.lat,b.lat);
  rectAnchor=null;rectDragging=false;
  if(east-west<1e-5||north-south<1e-5){draftLayer.clearLayers();return;}
  const ring=[[west,south],[east,south],[east,north],[west,north],[west,south]];
  commitCustomArea('rect',ring);
}

function addPolygonPoint(latlng) {
  const prev=draftPoints[draftPoints.length-1];
  if(prev&&Math.hypot(prev[0]-latlng.lng,prev[1]-latlng.lat)<1e-6)return;
  draftPoints.push([latlng.lng,latlng.lat]);
  renderPolygonDraft();
  onDrawProgress?.(draftPoints.length);
}

function renderPolygonPreview(cursorLatLng) {
  draftPreviewLayer.clearLayers();
  if(drawMode!=='polygon'||!draftPoints.length||!cursorLatLng)return;
  const last=draftPoints[draftPoints.length-1];
  const segments=[[[last[1],last[0]],[cursorLatLng.lat,cursorLatLng.lng]]];
  if(draftPoints.length>=2){
    const first=draftPoints[0];
    segments.push([[cursorLatLng.lat,cursorLatLng.lng],[first[1],first[0]]]);
  }
  segments.forEach(pair=>{
    L.polyline(pair,{pane:'drawDraft',color:'#16835c',weight:2,dashArray:'4 5',opacity:.85,interactive:false}).addTo(draftPreviewLayer);
  });
}

function renderPolygonDraft() {
  draftLayer.clearLayers();
  draftPreviewLayer.clearLayers();
  draftMarkers.clearLayers();
  if(!draftPoints.length)return;
  const latLngs=draftPoints.map(([lng,lat])=>[lat,lng]);
  if(latLngs.length>=3){
    L.polygon(latLngs,{pane:'drawDraft',color:'#102d20',weight:3,dashArray:'6 4',fillColor:'#27d39b',fillOpacity:.22,interactive:false}).addTo(draftLayer);
  }else if(latLngs.length===2){
    L.polyline(latLngs,{pane:'drawDraft',color:'#102d20',weight:3,dashArray:'6 4',interactive:false}).addTo(draftLayer);
  }
  latLngs.forEach((coord,index)=>{
    const isFirst=index===0&&latLngs.length>=3;
    const marker=L.circleMarker(coord,{
      pane:'drawDraft',
      radius:isFirst?9:6,
      color:'#102d20',
      weight:2.5,
      fillColor:isFirst?'#27d39b':'#ffffff',
      fillOpacity:1,
      interactive:isFirst
    }).addTo(draftMarkers);
    if(isFirst){
      marker.bindTooltip('Click to close the boundary',{direction:'top',offset:[0,-8]});
      marker.on('click',event=>{L.DomEvent.stopPropagation(event);finishPolygonSelection();});
    }
  });
}

function commitCustomArea(kind,ring) {
  stopDrawingState();
  customArea={kind,ring,bbox:polygonBounds(ring)};
  areaSummary=null;
  renderCustomAreaOverlay();
  onAreaChange?.(customArea);
}

function stopDrawingState() {
  drawMode=null;rectAnchor=null;rectDragging=false;draftPoints=[];
  draftLayer.clearLayers();draftPreviewLayer.clearLayers();draftMarkers.clearLayers();
  map.dragging.enable();
  map.doubleClickZoom.enable();
  const container=map.getContainer();
  container.classList.remove('is-drawing','is-drawing-rect','is-drawing-poly');
  onDrawProgress?.(0);
}

export function startAreaSelection(mode='polygon') {
  stopDrawingState();
  drawMode=mode==='rect'?'rect':'polygon';
  const container=map.getContainer();
  container.classList.add('is-drawing',drawMode==='rect'?'is-drawing-rect':'is-drawing-poly');
  if(drawMode==='rect')map.dragging.disable();
  map.doubleClickZoom.disable();
  onDrawProgress?.(0);
}

export function undoLastPolygonPoint() {
  if(drawMode!=='polygon'||!draftPoints.length)return 0;
  draftPoints.pop();
  renderPolygonDraft();
  onDrawProgress?.(draftPoints.length);
  return draftPoints.length;
}

export function finishPolygonSelection() {
  if(drawMode!=='polygon'||draftPoints.length<3)return false;
  const ring=[...draftPoints,draftPoints[0]];
  commitCustomArea('polygon',ring);
  return true;
}

export function cancelAreaSelection() {
  if(!drawMode)return;
  stopDrawingState();
}

export function selectCurrentViewArea() {
  stopDrawingState();
  const b=map.getBounds();
  const dx=(b.getEast()-b.getWest())*0.12;
  const dy=(b.getNorth()-b.getSouth())*0.12;
  const west=b.getWest()+dx, east=b.getEast()-dx;
  const south=b.getSouth()+dy, north=b.getNorth()-dy;
  const ring=[[west,south],[east,south],[east,north],[west,north],[west,south]];
  commitCustomArea('rect',ring);
}

export function clearCustomArea() {
  stopDrawingState();
  customArea=null;areaSummary=null;
  customAreaLayer.clearLayers();
  refreshPolygonStyles();
}

export function setAreaDisplayMode(mode) {
  areaDisplayMode=mode==='zones'?'zones':'solid';
  renderCustomAreaOverlay();
  refreshPolygonStyles();
}

export function getCustomArea() {return customArea;}

// Restore a previously drawn outline without simulating a user selection or
// triggering dependent analysis. The caller validates the territory first.
export function setCustomArea(area) {
  if(!map) return;
  stopDrawingState();
  customArea=area?.ring?{kind:area.kind==='rect'?'rect':'polygon',ring:area.ring.map(p=>[...p]),bbox:polygonBounds(area.ring)}:null;
  areaSummary=null;
  renderCustomAreaOverlay();
  refreshPolygonStyles();
}

export function fitCustomArea() {
  if(!customArea)return;
  const [west,south,east,north]=customArea.bbox;
  map.invalidateSize({pan:false});
  const drawer=document.getElementById('map-drawer');
  const coveredWidth=drawer&&!drawer.hidden?drawer.getBoundingClientRect().width+24:0;
  map.fitBounds([[south,west],[north,east]],{paddingTopLeft:[32,32],paddingBottomRight:[Math.max(32,Math.min(coveredWidth,map.getSize().x*.58)),32],maxZoom:14,animate:false});
}

function applyBaseLayer() {
  if(!map)return;
  if(baseMode==='satellite'){
    if(map.hasLayer(osmLayer))map.removeLayer(osmLayer);
    if(!map.hasLayer(satLayer))satLayer.addTo(map);
    if(!map.hasLayer(labelsLayer))labelsLayer.addTo(map);
  }else{
    if(map.hasLayer(satLayer))map.removeLayer(satLayer);
    if(map.hasLayer(labelsLayer))map.removeLayer(labelsLayer);
    if(!map.hasLayer(osmLayer))osmLayer.addTo(map);
  }
}

export function setBaseLayer(mode) {
  baseMode=mode==='osm'?'osm':'satellite';
  applyBaseLayer();
  refreshPolygonStyles();
}

export function setOverlayOpacity(alpha) {
  const num=Number(alpha);
  overlayOpacity=Number.isFinite(num)?Math.max(0,Math.min(0.85,num)):0.42;
  refreshPolygonStyles();
  renderCustomAreaOverlay();
}

function gibsDateForYear(year) {
  const y=Number(year)||new Date().getUTCFullYear()-1;
  const target=new Date(Date.UTC(y,6,4));
  const safeLatest=new Date(Date.now()-14*86400*1000);
  const chosen=target<=safeLatest?target:safeLatest;
  return chosen.toISOString().slice(0,10);
}

function applySignalLayer() {
  if(!map)return;
  if(gibsLayer){map.removeLayer(gibsLayer);gibsLayer=null;}
  if(signalMode==='index')return;
  const dateStr=gibsDateForYear(signalYear);
  const cfg=signalMode==='ndvi'
    ? {id:'MODIS_Terra_NDVI_8Day',matrix:'GoogleMapsCompatible_Level9',maxNative:9,attr:'NASA EOSDIS GIBS · MODIS Terra 8-Day NDVI'}
    : {id:'SMAP_L4_Analyzed_Root_Zone_Soil_Moisture',matrix:'GoogleMapsCompatible_Level6',maxNative:6,attr:'NASA EOSDIS GIBS · SMAP L4 Root-Zone Moisture'};
  const url=`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${cfg.id}/default/${dateStr}/${cfg.matrix}/{z}/{y}/{x}.png`;
  gibsLayer=L.tileLayer(url,{pane:'nasaSignal',maxZoom:19,maxNativeZoom:cfg.maxNative,opacity:0.78,attribution:cfg.attr}).addTo(map);
}

export function setSignalLayer(mode,year) {
  signalMode=['ndvi','smap'].includes(mode)?mode:'index';
  if(year)signalYear=Number(year);
  applySignalLayer();
  refreshPolygonStyles();
}

function featureStyle(feature) {
  const status=feature.properties?.result?.status || 'unknown';
  const id=String(feature.properties?.id ?? feature.id);
  const effectiveOpacity=signalMode==='index'?overlayOpacity:Math.min(0.16,overlayOpacity);
  const fillOp=effectiveOpacity<=0?0:status==='unknown'?Math.min(0.14,effectiveOpacity*0.3):status==='excluded'?Math.min(.24,effectiveOpacity*.6):effectiveOpacity;
  const base={stroke:false,weight:0,fillColor:STATUS_COLORS[status]||STATUS_COLORS.unknown,fillOpacity:fillOp,smoothFactor:0};
  if(!customArea)return base;
  const inside=feature.properties?.presentation_partition==='inside'||areaSummary?.intersectingIds?.has(id);
  if(!inside)return {...base,fillOpacity:overlayOpacity<=0?0:(status==='unknown' ? 0.025 : 0.06)};
  if(areaDisplayMode==='solid')return {...base,fillOpacity:0};
  return {...base,fillOpacity:overlayOpacity<=0?0:status==='unknown'?Math.min(.18,fillOp):Math.min(.75,Math.max(.18,overlayOpacity+.12))};
}

function hitFeatureStyle(){return {stroke:false,weight:0,opacity:0,fill:true,fillColor:'#000000',fillOpacity:0};}

function refreshPolygonStyles() {
  presentationLayer?.setStyle(featureStyle);
  polygons?.setStyle(hitFeatureStyle);
}

function renderPresentation() {
  if(!presentationLayer)return;
  const display=buildPresentationZones(collection,{zoom:map.getZoom(),partition:feature=>customArea?(areaSummary?.intersectingIds?.has(String(feature.properties?.id??feature.id))?'inside':'outside'):''});
  presentationLayer.clearLayers();presentationLayer.addData(display);
}

function renderCustomAreaOverlay() {
  customAreaLayer.clearLayers();
  if(!customArea)return;
  const geo={type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[customArea.ring]}};
  customAreaLayer.addData(geo);
  if(pending||!areaSummary){
    customAreaLayer.setStyle({color:'#27d39b',weight:3,dashArray:'7 5',fillColor:'#c7cec4',fillOpacity:.22});
    return;
  }
  const color=STATUS_COLORS[areaSummary.status]||STATUS_COLORS.unknown;
  if(areaDisplayMode==='solid'){
    customAreaLayer.setStyle({
      color:areaSummary.status==='unknown'?'#d2dad3':'#ffffff',
      weight:3,
      dashArray:null,
      fillColor:color,
      fillOpacity:overlayOpacity<=0?0:Math.min(0.72,overlayOpacity+0.12)
    });
  }else{
    customAreaLayer.setStyle({
      color:'#ffffff',
      weight:3.5,
      dashArray:'8 5',
      fill:false,
      fillOpacity:0
    });
  }
}

function onEachFeature(feature,layer) {
  const id=String(feature.properties?.id ?? feature.id);
  layer.options.bubblingMouseEvents=false;
  featureLayers.set(id,layer);
  layer.on('click',event=>{
    if(drawMode==='polygon'){L.DomEvent.stopPropagation(event);addPolygonPoint(event.latlng);return;}
    if(drawMode==='rect'||pending)return;
    L.DomEvent.stopPropagation(event);
    selectFeature(id);
  });
  layer.on('dblclick',event=>{
    if(drawMode==='polygon'){L.DomEvent.stop(event);finishPolygonSelection();}
  });
  layer.on('mouseover',()=>{if(!pending&&!drawMode&&(!customArea||areaDisplayMode==='zones'))layer.setStyle({stroke:true,weight:1.3,color:'#224c42',opacity:.8,fillOpacity:0});});
  layer.on('mouseout',()=>layer.setStyle(hitFeatureStyle()));
  const label=L.DomUtil.create('span');
  const score=feature.properties?.result?.score;
  label.textContent=`${featureName(feature)} · ${tr('statuses.'+(feature.properties?.result?.status||'unknown'))}${typeof score==='number'&&Number.isFinite(score)?` · ${Math.round(score)}/100`:''}`;
  layer.bindTooltip(label,{sticky:true,direction:'top',opacity:.94});
  layer.on('add',()=>{
    const element=layer.getElement?.();
    if(!element)return;
    element.setAttribute('tabindex','0');element.setAttribute('role','button');
    element.setAttribute('aria-label',`${featureName(feature)}. ${tr('statuses.'+(feature.properties?.result?.status||'unknown'))}`);
    element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectFeature(id);}});
  });
}

export function featureName(feature) {
  const p=feature.properties||{};
  if(p.ui_label)return p.ui_label;
  if(['center_sample_only','multi_point_overview_5pt'].includes(p.representation)&&p.center?.length>=2)return `Grid cell ${Number(p.center[1]).toFixed(2)}°, ${Number(p.center[0]).toFixed(2)}°`;
  const coords=p.climate?.climate_sample || p.sample || p.center;
  if(coords?.length>=2)return `Area ${Number(coords[1]).toFixed(2)}°, ${Number(coords[0]).toFixed(2)}°`;
  return `Area #${String(p.id??feature.id).slice(-8)}`;
}

export function setAnalysis(data,summary=null) {
  collection=data;pending=false;areaSummary=summary;
  featureLayers.clear();polygons.clearLayers();polygons.addData(data);
  renderPresentation();
  refreshPolygonStyles();
  renderCustomAreaOverlay();
  const bbox=data.meta?.enabled_bbox||DEFAULT_COVERAGE;
  if(bbox?.length===4){const bounds=[[bbox[1],bbox[0]],[bbox[3],bbox[2]]];coverageBackground.setBounds(bounds);coverageOutline.setBounds(bounds);}
  if(selectedId && featureLayers.has(selectedId))selectFeature(selectedId,{notify:true});
  else {selectedId=null;selectedOutline.clearLayers();}
}

export function clearAnalysis() {
  pending=true;areaSummary=null;
  collection={type:'FeatureCollection',features:[]};featureLayers.clear();polygons.clearLayers();selectedOutline.clearLayers();
  presentationLayer.clearLayers();
  renderCustomAreaOverlay();
}

export function getView() {
  const bounds=map.getBounds();
  return {bbox:[bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()],zoom:map.getZoom()};
}

export function selectFeature(id,{notify=true,zoom=false}={}) {
  if(pending)return;
  if(!id){selectedId=null;selectedOutline.clearLayers();return;}
  const feature=collection.features.find(f=>String(f.properties?.id??f.id)===String(id));
  if(!feature)return;
  selectedId=String(id);selectedOutline.clearLayers();selectedOutline.addData(feature);
  if(zoom){const layer=featureLayers.get(selectedId);if(layer)map.fitBounds(layer.getBounds(),{maxZoom:map.getZoom(),padding:[20,20]});}
  if(notify)onSelect?.(feature);
}

export function clearSelectedFeature() {
  selectedId=null;selectedOutline.clearLayers();
}

export function focusKansas() {
  map.invalidateSize({pan:false});
  map.fitBounds([[36.9,-102.1],[40.1,-94.5]],{padding:[18,18],maxZoom:7,animate:false});
}
export function focusNorthAmerica() {
  map.invalidateSize({pan:false});
  map.fitBounds([[DEFAULT_COVERAGE[1],DEFAULT_COVERAGE[0]],[DEFAULT_COVERAGE[3],DEFAULT_COVERAGE[2]]],{padding:[18,18],maxZoom:5,animate:false});
}
export function focusDetail() {
  if(customArea){fitCustomArea();return;}
  const center=selectedOutline.getLayers().length?selectedOutline.getBounds().getCenter():map.getCenter();
  map.setView(center,13);
}
export function showWorld() {map.setView([22,-8],2);}
export function resizeMap() {map?.invalidateSize({pan:false});}
