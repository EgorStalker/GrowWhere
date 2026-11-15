// Display geometry only: remove shared overview-cell edges without inventing
// finer observations, moving class boundaries or changing analytical features.
const STATUSES=new Set(['good','conditional','poor','unknown','excluded']);
const key=point=>`${point[0]},${point[1]}`;
const area=ring=>ring.slice(0,-1).reduce((sum,p,i)=>sum+p[0]*ring[i+1][1]-ring[i+1][0]*p[1],0)/2;
const same=(a,b)=>a[0]===b[0]&&a[1]===b[1];

function rectangle(feature,snap) {
  const geometry=feature?.geometry;
  if(geometry?.type!=='Polygon'||!Array.isArray(geometry.coordinates)||geometry.coordinates.length!==1)return null;
  const ring=geometry.coordinates[0];
  if(!Array.isArray(ring)||ring.length!==5||ring.some(point=>!Array.isArray(point)||point.length!==2||point.some(value=>typeof value!=='number'||!Number.isFinite(value)))||!same(ring[0],ring[4]))return null;
  const xs=ring.slice(0,4).map(p=>snap(p[0])),ys=ring.slice(0,4).map(p=>snap(p[1]));
  const west=Math.min(...xs),east=Math.max(...xs),south=Math.min(...ys),north=Math.max(...ys);
  if(west===east||south===north)return null;
  if(new Set(ring.slice(0,4).map((_,i)=>`${xs[i]},${ys[i]}`)).size!==4)return null;
  for(let i=0;i<4;i++){
    const j=(i+1)%4;
    if((xs[i]!==west&&xs[i]!==east)||(ys[i]!==south&&ys[i]!==north)||xs[i]!==xs[j]&&ys[i]!==ys[j])return null;
  }
  return {west,east,south,north};
}

function hasOverlaps(rectangles) {
  const sorted=[...rectangles].sort((a,b)=>a.west-b.west);
  let active=[];
  for(const rect of sorted){
    active=active.filter(other=>other.east>rect.west);
    if(active.some(other=>Math.min(other.north,rect.north)>Math.max(other.south,rect.south)))return true;
    active.push(rect);
  }
  return false;
}

function contains(ring,point) {
  let inside=false;
  for(let i=0,j=ring.length-2;i<ring.length-1;j=i++){
    const a=ring[i],b=ring[j];
    if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}

function removeCollinear(ring) {
  const points=ring.slice(0,-1);
  const result=points.filter((p,i)=>{
    const previous=points[(i+points.length-1)%points.length],next=points[(i+1)%points.length];
    return !((previous[0]===p[0]&&p[0]===next[0])||(previous[1]===p[1]&&p[1]===next[1]));
  });
  return [...result,result[0]];
}

function dissolve(rectangles) {
  // Signed edge intervals also cancel T-junctions from differing cell sizes.
  const lines=new Map();
  const interval=(axis,line,start,end,direction)=>{
    const id=`${axis}:${line}`;
    if(!lines.has(id))lines.set(id,{axis,line,events:new Map()});
    const events=lines.get(id).events;
    events.set(start,(events.get(start)||0)+direction);
    events.set(end,(events.get(end)||0)-direction);
  };
  for(const r of rectangles){
    interval('h',r.south,r.west,r.east,1);interval('h',r.north,r.west,r.east,-1);
    interval('v',r.east,r.south,r.north,1);interval('v',r.west,r.south,r.north,-1);
  }
  const edges=[];
  for(const {axis,line,events} of lines.values()){
    const positions=[...events.keys()].sort((a,b)=>a-b);
    let balance=0;
    for(let i=0;i<positions.length-1;i++){
      balance+=events.get(positions[i]);
      if(!balance)continue;
      const a=axis==='h'?[positions[i],line]:[line,positions[i]];
      const b=axis==='h'?[positions[i+1],line]:[line,positions[i+1]];
      edges.push(balance>0?{a,b}:{a:b,b:a});
    }
  }
  const outgoing=new Map();
  edges.forEach((edge,index)=>{const id=key(edge.a);if(!outgoing.has(id))outgoing.set(id,[]);outgoing.get(id).push(index);});
  const used=new Set(),rings=[];
  for(let first=0;first<edges.length;first++){
    if(used.has(first))continue;
    const ring=[edges[first].a];
    let current=first;
    while(!used.has(current)){
      const edge=edges[current];used.add(current);ring.push(edge.b);
      if(same(edge.b,ring[0]))break;
      const candidates=(outgoing.get(key(edge.b))||[]).filter(index=>!used.has(index));
      if(!candidates.length)throw new Error('Open presentation boundary');
      const incoming=Math.atan2(edge.b[1]-edge.a[1],edge.b[0]-edge.a[0]);
      const turn=index=>{
        const next=edges[index];let angle=Math.atan2(next.b[1]-next.a[1],next.b[0]-next.a[0])-incoming;
        while(angle<=-Math.PI)angle+=2*Math.PI;while(angle>Math.PI)angle-=2*Math.PI;
        return angle;
      };
      // Keeping the left-hand boundary separates cells touching at one corner.
      current=candidates.sort((a,b)=>turn(b)-turn(a))[0];
    }
    if(!same(ring[0],ring.at(-1)))throw new Error('Unclosed presentation boundary');
    const simplified=removeCollinear(ring);
    if(simplified.length>=4&&area(simplified)!==0)rings.push(simplified);
  }
  const exteriors=rings.filter(ring=>area(ring)>0).map(ring=>({ring,holes:[],size:area(ring)}));
  for(const hole of rings.filter(ring=>area(ring)<0)){
    const outer=exteriors.filter(item=>hole.some(point=>contains(item.ring,point))).sort((a,b)=>a.size-b.size)[0];
    if(!outer)throw new Error('Orphan presentation hole');
    outer.holes.push(hole);
  }
  return exteriors.map(item=>[item.ring,...item.holes]);
}

/**
 * Merge adjacent, same-class rectangular overview cells for display only.
 * Native soil polygons pass through unchanged. No-data/exclusion holes stay
 * holes; absent cells remain absent. Snapping is < 0.000001 display pixels and
 * capped at 1e-9 degrees to reconcile floating-point copies of shared edges.
 * `partition` separates cells with different existing area-display styling.
 */
export function buildPresentationZones(collection,{zoom=7,partition=()=>''}={}) {
  const features=collection?.features||[];
  const base={type:'FeatureCollection',features,meta:{presentation_only:true,dissolved:false}};
  if(!features.length)return base;
  if(collection.meta?.mode==='soil_polygons')return base;
  const nativeZoom=collection.meta?.native_zoom;
  const overview=collection.meta?.mode==='grid'||typeof nativeZoom==='number'&&Number.isFinite(nativeZoom)&&nativeZoom>=0&&nativeZoom<12||features.every(feature=>['center_sample_only','multi_point_overview_5pt'].includes(feature?.properties?.representation));
  if(!overview)return base;
  const displayZoom=Number.isFinite(zoom)?Math.max(0,Math.min(24,zoom)):7;
  const precision=Math.max(9,Math.min(13,Math.ceil(Math.log10(256*2**displayZoom/360))+6));
  const snap=value=>Number(value.toFixed(precision));
  const rectangles=features.map(feature=>rectangle(feature,snap));
  if(rectangles.some(value=>!value)||hasOverlaps(rectangles))return base;
  const groups=new Map();
  features.forEach((feature,index)=>{
    const status=STATUSES.has(feature.properties?.result?.status)?feature.properties.result.status:'unknown';
    const section=String(partition(feature)||'');
    const id=`${status}|${section}`;
    if(!groups.has(id))groups.set(id,{status,section,rectangles:[]});
    groups.get(id).rectangles.push(rectangles[index]);
  });
  try{
    const zones=[...groups.values()].map((group,index)=>({
      type:'Feature',id:`presentation-${index}`,
      properties:{result:{status:group.status,score:null},presentation_only:true,presentation_partition:group.section,source_cell_count:group.rectangles.length},
      geometry:{type:'MultiPolygon',coordinates:dissolve(group.rectangles)}
    }));
    return {type:'FeatureCollection',features:zones,meta:{presentation_only:true,dissolved:true,source_cell_count:features.length}};
  }catch{return base;}
}
