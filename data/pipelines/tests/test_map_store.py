from contextlib import closing
import datetime as dt
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from growwhere.map_store import MapStore
from precompute_maps import build_product

SCENARIO={'crop':'corn','year':2025,'planting':'2025-05-01','irrigation_mm':0,'irrigation_known':True,'method':'test-only-method'}
SOURCE={'id':'test-only-source','source_id':'test-fixture','source_url':'https://example.invalid/test-fixture',
        'retrieved_at':'2026-11-14T12:00:00Z','sha256':'test-only-hash','path':'private/raw/file','request':{'body':'private'}}


def cell(identity='first',bbox=(-99,38,-98,39),score=75,status='good',missing=None):
    w,s,e,n=bbox
    return {'type':'Feature','id':identity,'geometry':{'type':'Polygon','coordinates':[[[w,s],[e,s],[e,n],[w,n],[w,s]]]},
            'properties':{'source_meta':[SOURCE],'result':{'score':score,'status':status,'missing':missing or []}}}


class MapStoreTests(unittest.TestCase):
    def setUp(self):
        parent=Path(__file__).resolve().parents[2]/'processed'
        parent.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(prefix='test-map-store-',dir=parent)
        self.path=Path(self.temp.name)/'maps.sqlite3'
        self.store=MapStore(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def publish(self,scenario=None,features=None,**kwargs):
        pending=self.store.begin(scenario or SCENARIO,[-102.1,36.9,-94.5,40.1],6)
        return self.store.publish(pending['product_id'],{'type':'FeatureCollection','features':features if features is not None else [cell()],'meta':{}},**kwargs)

    def test_empty_cold_store_is_read_only_explicit_nodata_and_never_networks(self):
        with patch('urllib.request.urlopen',side_effect=AssertionError('No network on read')):
            self.assertEqual(self.store.list_products(),[])
            value=self.store.tiles('not-created',[-120,45,-119,46],8)
        self.assertFalse(self.path.exists())
        self.assertEqual(value['features'],[])
        self.assertEqual(value['meta']['status'],'not_precomputed')
        self.assertEqual(value['meta']['upstream_requests'],0)
        self.assertIsNone(value['meta']['nodata_background']['properties']['result']['score'])

    def test_pending_and_failed_products_never_publish_partial_features(self):
        pending=self.store.begin(SCENARIO,[-100,37,-96,40])
        self.assertEqual(self.store.list_products(),[])
        self.assertEqual(self.store.list_products(include_unready=True)[0]['status'],'pending')
        self.assertEqual(self.store.tiles(pending['product_id'],[-100,37,-96,40],6)['features'],[])
        self.store.fail(pending['product_id'],'Test-only failure')
        self.assertEqual(self.store.tiles(pending['product_id'],[-100,37,-96,40],6)['meta']['status'],'failed')
        with self.assertRaises(ValueError):
            self.store.publish(pending['product_id'],{'type':'FeatureCollection','features':[]})

    def test_publication_is_atomic_even_when_second_insert_fails(self):
        pending=self.store.begin(SCENARIO,[-100,37,-96,40])
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("CREATE TRIGGER fail_test_insert BEFORE INSERT ON cells WHEN NEW.feature LIKE '%explode%' BEGIN SELECT RAISE(ABORT,'test-only failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.publish(pending['product_id'],{'type':'FeatureCollection','features':[cell(),cell('explode')]})
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM cells').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM cell_bounds').fetchone()[0],0)
        self.assertEqual(self.store.list_products(include_unready=True)[0]['status'],'pending')

    def test_ready_product_survives_cold_reload_without_upstream_and_spatially_filters(self):
        manifest=self.publish(features=[cell('west'),cell('east',(-97,38,-96,39))])
        cold=MapStore(self.path)
        with patch('urllib.request.urlopen',side_effect=AssertionError('No network on read')):
            value=cold.tiles(manifest['product_id'],[-99.1,38.1,-98.1,38.9],15)
        self.assertEqual([f['id'] for f in value['features']],['west'])
        self.assertEqual(value['features'][0]['geometry'],cell('west')['geometry'])
        self.assertEqual(value['meta']['native_zoom'],6)
        self.assertEqual(value['meta']['lod'],'native_unsmoothed')
        self.assertEqual(value['meta']['upstream_requests'],0)
        self.assertNotIn('path',value['features'][0]['properties']['source_meta'][0])
        self.assertNotIn('request',value['meta']['source_snapshots'][0])

    def test_missing_viewport_never_extrapolates_known_cells_or_invents_resolution(self):
        manifest=self.publish()
        value=self.store.tiles(manifest['product_id'],[-120,45,-119,46],18)
        self.assertEqual(value['features'],[])
        self.assertEqual(value['meta']['nodata_reason'],'not_precomputed')
        self.assertEqual(value['meta']['native_zoom'],6)
        self.assertEqual(value['meta']['nodata_background']['properties']['result']['status'],'unknown')

    def test_critical_missing_data_is_unknown_and_offline_nodata_product_is_valid(self):
        manifest=self.publish(features=[cell(score=99,missing=['soil']),cell('missing',(-97,38,-96,39),score=88,status='unknown')])
        self.assertEqual(manifest['data_status'],'no_data')
        self.assertIsNone(manifest['actual_data_bbox'])
        value=self.store.tiles(manifest['product_id'],[-100,37,-95,40],7)
        self.assertTrue(all(f['properties']['result']['score'] is None for f in value['features']))
        empty=self.publish(features=[])
        self.assertEqual(empty['status'],'ready')
        self.assertEqual(empty['data_status'],'no_data')

    def test_immutable_versions_change_with_sources_scenario_and_method(self):
        first=self.publish()
        identical=self.publish()
        self.assertEqual(first['version_key'],identical['version_key'])
        changed=cell();changed['properties']['source_meta'][0]=dict(SOURCE,sha256='changed-source-hash')
        source_version=self.publish(features=[changed])
        self.assertNotEqual(first['source_snapshot'],source_version['source_snapshot'])
        self.assertNotEqual(first['version_key'],source_version['version_key'])
        for key,value in [('planting','2025-05-02'),('irrigation_mm',100),('irrigation_known',False),('method','test-only-method-v2')]:
            scenario=dict(SCENARIO);scenario[key]=value
            updated=self.publish(scenario=scenario)
            self.assertNotEqual(first['version_key'],updated['version_key'])
            self.assertNotEqual(first['scenario_key'],updated['scenario_key'])
        with self.assertRaises(ValueError):
            self.store.publish(first['product_id'],{'type':'FeatureCollection','features':[]})

    def test_product_lookup_filters_exact_scenario_and_indexed_bbox(self):
        first=self.publish()
        self.publish(scenario=dict(SCENARIO,crop='soy',irrigation_mm=100))
        products=self.store.list_products(crop='corn',year=2025,planting='2025-05-01',irrigation_mm=0,irrigation_known=True,method=SCENARIO['method'],source_snapshot=first['source_snapshot'],bbox=[-100,37,-95,40])
        self.assertEqual([p['product_id'] for p in products],[first['product_id']])
        self.assertEqual(self.store.list_products(crop='corn',bbox=[-120,45,-119,46]),[])
        self.assertEqual(self.store.list_products(crop='corn',irrigation_mm=100),[])

    def test_expired_snapshot_is_explicit_stale_and_new_version_does_not_mutate_it(self):
        manifest=self.publish(ttl_seconds=60)
        future=dt.datetime.now(dt.timezone.utc)+dt.timedelta(seconds=120)
        with patch('growwhere.map_store._now',return_value=future):
            old=self.store.tiles(manifest['product_id'],[-100,37,-95,40],8)
        self.assertTrue(old['meta']['stale'])
        self.assertEqual(old['meta']['freshness'],'stale')
        self.assertEqual(old['meta']['scenario']['year'],2025)
        self.assertFalse(old['meta']['is_live_forecast'])
        self.publish(scenario=dict(SCENARIO,irrigation_mm=150))
        self.assertEqual(self.store.list_products(irrigation_mm=0)[0]['product_id'],manifest['product_id'])

    def test_invalid_bbox_and_numeric_input_rejected_before_store_creation(self):
        for bbox in [[0,0,0,1],[0,0,1,float('nan')],[0,0,True,1],[180,0,181,1]]:
            with self.assertRaises(ValueError): self.store.begin(SCENARIO,bbox)
        for value in [True,float('nan'),-1,5001]:
            with self.assertRaises(ValueError): self.store.begin(dict(SCENARIO,irrigation_mm=value),[-100,37,-95,40])
        self.assertFalse(self.path.exists())

    def test_explicit_job_passes_changed_irrigation_scenario_and_failure_is_not_ready(self):
        collection={'type':'FeatureCollection','features':[cell()],'meta':{}}
        with patch('growwhere.service.analyze',return_value=collection) as analyze:
            result=build_product(self.store,[-100,37,-96,40],'corn',2025,'2025-05-01',offline=True,irrigation_mm=0,irrigation_known=False)
        self.assertEqual(result['scenario']['irrigation_mm'],0)
        self.assertFalse(result['scenario']['irrigation_known'])
        self.assertEqual(analyze.call_args.args[-3:],(0,False,False))
        with patch('growwhere.service.analyze',side_effect=RuntimeError('Test-only upstream failure')):
            with self.assertRaises(RuntimeError):
                build_product(self.store,[-100,37,-96,40],'soy',2025,'2025-05-01')
        self.assertEqual(self.store.list_products(crop='soy'),[])
        self.assertEqual(self.store.list_products(crop='soy',include_unready=True)[0]['status'],'failed')


if __name__=='__main__': unittest.main()
