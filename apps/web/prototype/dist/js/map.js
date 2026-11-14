import {regions, zones, suitability} from './model.js';
import {t} from './i18n.js';

let worldPath = null;
export async function loadMap() {
  const response = await fetch('assets/world.json');
  if (!response.ok) throw new Error(`Map HTTP ${response.status}`);
  const data = await response.json();
  const ring = points => points.map(([lon,lat],i) => `${i?'L':'M'}${((lon+180)*1000/360).toFixed(1)},${((90-lat)*500/180).toFixed(1)}`).join(' ')+'Z';
  worldPath = data.features.filter(f=>f.properties.name!=='Antarctica').map(f => {
    const polygons = f.geometry.type==='Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    return polygons.map(p=>p.map(ring).join(' ')).join(' ');
  }).join(' ');
}
export function worldMap() {
  if (!worldPath) return '';
  return `<svg class="world-svg" viewBox="0 25 1000 430" role="group" aria-label="${t('worldLabel')}">
    <defs><clipPath id="land-mask"><path d="${worldPath}"/></clipPath><pattern id="world-grid" width="83.33" height="83.33" patternUnits="userSpaceOnUse"><path d="M83.33 0H0V83.33" fill="none" stroke="#d7e0d3" stroke-width=".6"/></pattern></defs>
    <rect width="1000" height="500" fill="url(#world-grid)"/>
    <path d="${worldPath}" fill="#d4ddd0" stroke="#bdcbb6" stroke-width=".55"/>
    <g clip-path="url(#land-mask)">${regions.map(r=>`<ellipse cx="${r.x}" cy="${r.y}" rx="${r.rx}" ry="${r.ry}" class="climate-region ${r.active?'active':''}"/>`).join('')}</g>
    ${regions.map(r=>`<g role="button" tabindex="0" data-action="region" data-region="${r.index}" aria-label="${t('regions')[r.index]} — ${t(r.active?'available':'soon')}" class="map-region ${r.active?'active-region':''}">
      <circle cx="${r.x}" cy="${r.y}" r="${r.active?12:7}" class="map-dot"/>
      ${r.active?`<circle class="map-halo" cx="${r.x}" cy="${r.y}" r="23"/>`:''}
      <rect x="${r.x-75}" y="${r.y+20}" width="150" height="${r.active?55:30}" rx="7" class="map-label-bg"/>
      <text x="${r.x}" y="${r.y+40}" class="map-label">${t('regions')[r.index]}</text>
      ${r.active?`<text x="${r.x}" y="${r.y+60}" class="map-label-secondary">${t('available')}</text>`:''}
      <rect x="${r.x-75}" y="${r.y-22}" width="150" height="100" fill="transparent"/>
    </g>`).join('')}
  </svg>`;
}
export function regionMap({crop, irrigation, zone, zoom=1}) {
  return `<svg class="region-svg" viewBox="0 0 1000 610" role="group" aria-label="${t('regionName')}">
    <defs><pattern id="field-texture" width="35" height="35" patternUnits="userSpaceOnUse" patternTransform="rotate(-22)"><path d="M0 0V35" stroke="#c5cdbb" stroke-width=".6"/></pattern><pattern id="missing-texture" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M0 10L10 0" stroke="#788476" stroke-width="1"/></pattern></defs>
    <rect width="1000" height="610" fill="#e9eddf"/>
    <g transform="translate(${500-500*zoom} ${305-305*zoom}) scale(${zoom})">
      <path d="M-50 78 Q180 128 245 52 T655 76 T1050 23 M-30 520 Q170 471 313 527 T714 491 T1060 530 M55 -40 Q144 150 88 350 T173 660 M896 -40 Q835 130 901 371 T859 660" class="contour"/>
      <path d="M-20 104 Q198 147 266 80 T655 109 T1050 51 M-30 547 Q170 498 313 554 T714 518 T1060 558 M77 -40 Q166 150 110 350 T195 660 M920 -40 Q859 130 925 371 T883 660" class="contour"/>
      <path d="M55 305 H935 M402 30V585 M790 30V585" class="state-line"/>
      <path d="M-5 498 C169 423 178 503 288 468 S457 484 553 466 S702 484 798 429 S950 435 1020 396" class="map-river"/>
      <text x="184" y="109" class="state-name">${t('stateNames')[0]}</text><text x="529" y="109" class="state-name">${t('stateNames')[1]}</text><text x="832" y="279" class="state-name">${t('stateNames')[2]}</text><text x="228" y="498" class="state-name">${t('stateNames')[3]}</text>
      <rect x="150" y="128" width="650" height="345" fill="url(#field-texture)" opacity=".45"/>
      ${zones.map(z=>{
        const status=crop?suitability(crop,z.id,irrigation):'empty';
        return `<g class="zone-group ${zone===z.id?'is-selected':''}" role="button" tabindex="0" data-action="zone" data-zone="${z.id}" aria-label="${t('zoneNames')[z.index]}${crop?`, ${t('statuses.'+status)}`:''}" aria-pressed="${zone===z.id}">
          <path d="${z.path}" class="zone ${status}"/>
          ${status==='unknown'?`<path d="${z.path}" fill="url(#missing-texture)" opacity=".3" pointer-events="none"/>`:''}
          <text x="${z.label[0]}" y="${z.label[1]}" class="zone-number">${z.index+1}</text>
          <text x="${z.label[0]}" y="${z.label[1]+25}" class="zone-name">${t('zoneShort')[z.index]}</text>
          ${zone===z.id?`<circle cx="${z.label[0]+53}" cy="${z.label[1]-16}" r="14" fill="#172d24"/><path d="M${z.label[0]+46} ${z.label[1]-16}l5 5 9-10" fill="none" stroke="white" stroke-width="3"/>`:''}
        </g>`;
      }).join('')}
      <text x="490" y="550" text-anchor="middle" class="river-label">${t('demoZones')}</text>
    </g>
  </svg>`;
}
