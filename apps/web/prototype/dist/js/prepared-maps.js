// Client delivery is read-only. A missing scenario never starts an upstream job.
export const NORTH_AMERICA_BBOX=Object.freeze([-180,5,-10,84]);
const catalogs=new Map();
export async function loadPreparedMap(conditions,bbox,zoom,{signal,refresh=false}={}) {
  const query=new URLSearchParams(conditions),key=query.toString();
  const cached=catalogs.get(key);
  let products=cached&&Date.now()-cached.receivedAt<60000?cached.products:null;
  if(!products||refresh){
    const response=await fetch(`/api/map-products?${query}`,{signal});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'Prepared maps are unavailable.');
    products=(result.products||[]).filter(p=>p.status==='ready');
    catalogs.set(key,{products,receivedAt:Date.now()});
  }
  const complete=products.filter(p=>{
    const b=p.enabled_bbox;return b&&b[0]<=bbox[0]&&b[1]<=bbox[1]&&b[2]>=bbox[2]&&b[3]>=bbox[3];
  });
  const candidates=complete.length?complete:products;
  const product=candidates.find(p=>p.stale!==true)||candidates[0];
  if(!product)return {type:'FeatureCollection',features:[],meta:{status:'not_precomputed',nodata_reason:'This crop, season and irrigation scenario has not been prepared. Try the 2025 reference season with no irrigation.',enabled_bbox:[...NORTH_AMERICA_BBOX],feature_count:0,read_only:true,upstream_requests:0}};
  const params=new URLSearchParams({product_id:product.product_id,bbox:bbox.join(','),zoom:String(zoom)});
  const response=await fetch(`/api/map-products/tiles?${params}`,{signal});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Could not load the prepared map.');
  data.meta={...data.meta,enabled_bbox:[...NORTH_AMERICA_BBOX],prepared:true,
    resolution:data.meta?.analysis_metadata?.resolution||data.meta?.resolution,
    coverage_bbox:product.actual_data_bbox||product.enabled_bbox};
  return data;
}
export function clearPreparedCatalog(){catalogs.clear();}
