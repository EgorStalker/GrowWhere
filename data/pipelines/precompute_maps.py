"""Explicit map build job; HTTP tile reads never execute this pipeline."""
import argparse
import json
import sys
from unittest.mock import patch
import urllib.error

from growwhere.analysis import PROFILES,METHOD_VERSION
from growwhere.map_store import MapStore,DEFAULT_PATH,validate_bbox


def build_product(store,bbox,crop,year,planting,zoom=6,refresh=False,ttl_seconds=86400,offline=False,irrigation_mm=0,irrigation_known=True):
    # Import expensive/network-capable analysis only inside the explicit job.
    from growwhere.service import analyze
    scenario={'crop':crop,'year':year,'planting':planting,'irrigation_mm':irrigation_mm,
              'irrigation_known':irrigation_known,'method':METHOD_VERSION}
    pending=store.begin(scenario,bbox,zoom)
    try:
        if offline:
            # Fresh local cache can be used. Missing/expired inputs become NoData;
            # an offline job must never silently acquire new upstream responses.
            with patch('urllib.request.urlopen',side_effect=urllib.error.URLError('Offline map build: source not cached')):
                collection=analyze(bbox,zoom,crop,year,planting,irrigation_mm,irrigation_known,False)
        else:
            collection=analyze(bbox,zoom,crop,year,planting,irrigation_mm,irrigation_known,refresh)
        return store.publish(pending['product_id'],collection,ttl_seconds=ttl_seconds)
    except Exception as exc:
        store.fail(pending['product_id'],str(exc))
        raise


def main(argv=None):
    parser=argparse.ArgumentParser(description='Precompute immutable historical map products; no live client analysis.')
    parser.add_argument('--db',default=str(DEFAULT_PATH))
    parser.add_argument('--bbox',required=True,help='west,south,east,north in WGS84; use --bbox=-102.1,36.9,-94.5,40.1')
    parser.add_argument('--crops',required=True,help='Comma-separated supported crop IDs')
    parser.add_argument('--year',required=True,type=int)
    parser.add_argument('--planting',help='Historical reference YYYY-MM-DD; omitted uses each crop profile reference, never sowing advice')
    water=parser.add_mutually_exclusive_group(required=True)
    water.add_argument('--rainfed',action='store_true',help='Explicitly select zero additional irrigation, known rainfed')
    water.add_argument('--irrigation-mm',type=float,help='Explicit irrigation scenario in mm, 0..5000; not a recommendation')
    parser.add_argument('--irrigation-known',choices=('true','false'),default='true')
    parser.add_argument('--zoom',type=float,default=6)
    parser.add_argument('--ttl-seconds',type=int,default=86400)
    parser.add_argument('--refresh',action='store_true')
    parser.add_argument('--offline',action='store_true',help='Block network; use fresh local source cache or explicit NoData')
    args=parser.parse_args(argv)
    try:
        bbox=validate_bbox([float(v) for v in args.bbox.split(',')])
        crops=list(dict.fromkeys(args.crops.split(',')))
        if not crops or any(crop not in PROFILES for crop in crops): raise ValueError('Unsupported crop')
        if args.offline and args.refresh: raise ValueError('Offline and refresh are mutually exclusive')
        if args.rainfed and args.irrigation_known!='true': raise ValueError('Rainfed means known zero irrigation; use --irrigation-mm=0 --irrigation-known=false for an unknown scenario')
        if not 5<=args.zoom<=11: raise ValueError('Overview build zoom must be between 5 and 11; no invented fine-resolution tiles')
        store=MapStore(args.db)
        failed=False
        for crop in crops:
            planting=args.planting or f"{args.year}-{PROFILES[crop]['default_planting']}"
            try:
                result=build_product(store,bbox,crop,args.year,planting,args.zoom,args.refresh,args.ttl_seconds,args.offline,
                    0 if args.rainfed else args.irrigation_mm,args.irrigation_known=='true')
                print(json.dumps({'product_id':result['product_id'],'crop':crop,'status':result['status'],
                    'data_status':result['data_status'],'feature_count':result['feature_count'],
                    'actual_data_bbox':result['actual_data_bbox'],'version_key':result['version_key']},ensure_ascii=True),flush=True)
            except Exception as exc:
                failed=True;print(json.dumps({'crop':crop,'status':'failed','error':str(exc)[:300]}),flush=True)
        return 1 if failed else 0
    except ValueError as exc:
        parser.error(str(exc))


if __name__=='__main__':
    sys.exit(main())
