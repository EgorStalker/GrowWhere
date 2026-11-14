// Pure demonstration model. Replace through a data adapter when verified data exists.
export const crops = [
  {id:'wheat', cost:920, price:185, market:'steady', icon:'wheat'},
  {id:'soy', cost:1080, price:380, market:'growing', icon:'leaf'},
  {id:'corn', cost:1540, price:165, market:'variable', icon:'corn'}
];
export const zones = [
  {id:'northwest', index:0, soil:'sandy', moisture:'limited', base:{wheat:68,soy:38,corn:29}, waterGain:20, path:'M170 154 L353 136 L384 253 L194 276 Z', label:[274,207]},
  {id:'north', index:1, soil:'loam', moisture:'enough', base:{wheat:85,soy:74,corn:61}, waterGain:15, path:'M363 136 L569 151 L554 270 L395 252 Z', label:[464,207]},
  {id:'east', index:2, soil:'clay', moisture:'enough', base:{wheat:52,soy:82,corn:73}, waterGain:7, path:'M579 154 L783 190 L751 322 L566 270 Z', label:[670,235]},
  {id:'west', index:3, soil:'sandy', moisture:'limited', base:{wheat:45,soy:29,corn:20}, waterGain:19, path:'M194 287 L382 266 L364 412 L213 433 L172 365 Z', label:[276,352]},
  {id:'central', index:4, soil:'loam', moisture:'enough', base:{wheat:90,soy:83,corn:66}, waterGain:13, path:'M395 264 L553 282 L596 418 L376 412 Z', label:[477,350]},
  {id:'south', index:5, soil:'unknown', moisture:'unknown', base:{wheat:null,soy:null,corn:null}, waterGain:0, path:'M572 287 L749 336 L721 454 L605 419 Z', label:[659,370]}
];
export function suitability(cropId, zoneId, irrigation = 'unknown') {
  const zone = zones.find(z => z.id === zoneId);
  if (!zone || !crops.some(c => c.id === cropId)) return 'unknown';
  const score = zone.base[cropId];
  if (score === null) return 'unknown';
  const adjusted = score + (irrigation === 'yes' ? zone.waterGain : 0);
  return adjusted >= 70 ? 'good' : adjusted >= 45 ? 'conditional' : 'poor';
}
export function budgetStatus(cost, budget) {
  if (budget === '' || budget === null || !Number.isFinite(Number(budget)) || Number(budget) <= 0) return null;
  return cost <= Number(budget) ? 'fit' : 'over';
}
export const regions = [
  {index:0,x:225,y:139,rx:70,ry:39,active:true},
  {index:1,x:328,y:344,rx:63,ry:85},
  {index:2,x:520,y:125,rx:52,ry:39},
  {index:3,x:519,y:209,rx:73,ry:42},
  {index:4,x:564,y:312,rx:64,ry:63},
  {index:5,x:679,y:147,rx:94,ry:59},
  {index:6,x:805,y:203,rx:67,ry:76},
  {index:7,x:871,y:347,rx:66,ry:44}
];
