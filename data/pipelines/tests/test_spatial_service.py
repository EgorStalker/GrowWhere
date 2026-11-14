"""Spatial/API regression tests; all source adapters are mocked, no network."""
import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from growwhere import service, soil
from growwhere.sources import UpstreamError


def soil_fixture():
    return {'mukey':'test-1', 'ph':6.5, 'awc':.15, 'slope':1, 'sand':35,
            'clay':25, 'drainage':'Well drained', 'depth_coverage_cm':30}


def climate_fixture():
    return {'complete':True, 'missing':[], 'mean_temperature':24,
            'precipitation_mm':450, 'crop_water_demand_mm':500,
            'frost_days':0, 'heat_days':0, 'expected_days':150}


def provenance(source='nasa-power'):
    return {'id':source+'-fixture', 'source_id':source,
            'source_url':'https://example.invalid/test-fixture',
            'retrieved_at':'2026-11-14T10:00:00+00:00', 'kind':'reanalysis',
            'sha256':'a'*64, 'cache_status':'cached', 'age_seconds':2,
            'ttl_seconds':86400, 'request':{'body':{'query':'PRIVATE SQL'}},
            'path':'private/local/path', 'token':'must-not-escape'}


class GeometryTests(unittest.TestCase):
    def test_polygon_preserves_inner_hole_and_coordinate_order(self):
        result=soil.wkt_geometry('POLYGON ((-98 38,-97 38,-97 39,-98 39,-98 38),(-97.8 38.2,-97.2 38.2,-97.2 38.8,-97.8 38.8,-97.8 38.2))')
        self.assertEqual(result['type'],'Polygon')
        self.assertEqual(len(result['coordinates']),2)
        self.assertEqual(result['coordinates'][0][0],[-98,38])
        self.assertEqual(result['coordinates'][1][0],[-97.8,38.2])

    def test_multipolygon_preserves_each_polygon_and_hole(self):
        wkt='MULTIPOLYGON (((0 0,2 0,2 2,0 2,0 0),(0.5 0.5,1 0.5,1 1,0.5 1,0.5 0.5)),((3 3,4 3,4 4,3 4,3 3)))'
        result=soil.wkt_geometry(wkt)
        self.assertEqual(result['type'],'MultiPolygon')
        self.assertEqual(len(result['coordinates']),2)
        self.assertEqual(len(result['coordinates'][0]),2)
        self.assertEqual(result['coordinates'][1][0][-1],[3,3])

    def test_empty_unclosed_and_non_geographic_shapes_are_rejected(self):
        for wkt in [None, '', 'POLYGON EMPTY', 'LINESTRING (0 0,1 1)',
                    'POLYGON ((181 0,182 0,182 1,181 0))',
                    'POLYGON ((0 0,1 0,1 1,0 0)',
                    'POLYGON ((0 0,1 0,1 1))',
                    'POLYGON ((0 0,1 0,0 0))',
                    'POLYGON ((0 0,1 0,1 1,0 0)) unexpected']:
            with self.subTest(wkt=wkt):
                self.assertIsNone(soil.wkt_geometry(wkt))

    def test_per_attribute_depth_coverage_is_not_hidden_by_other_horizons(self):
        row={'mukey':'1','ph':'6.4','awc':'.15','clay':'20','sand':'40',
             'depth_ph':'30','depth_awc':'20','depth_clay':'30','depth_sand':'30'}
        self.assertEqual(soil.normalize(row)['depth_coverage_cm'],20)
        row['depth_awc']=None
        self.assertIsNone(soil.normalize(row)['depth_coverage_cm'])


class GridTests(unittest.TestCase):
    def test_bbox_is_clipped_to_supported_coverage(self):
        self.assertEqual(service.clip_bbox([-180,-85,180,85]),service.COVERAGE)
        self.assertIsNone(service.clip_bbox([0,0,1,1]))

    def test_invalid_bbox_never_becomes_an_upstream_query(self):
        for bbox in [[1,2,3], [2,38,1,39], [-98,39,-97,38],
                     [-181,38,-97,39], [-98,-90,-97,39],
                     [float('nan'),38,-97,39]]:
            with self.subTest(bbox=bbox):
                with self.assertRaises(ValueError): service.clip_bbox(bbox)

    def test_zoom_increases_grid_detail_without_crossing_coverage(self):
        bounds=[-100,37,-95,40]
        counts=[]
        for zoom in [6,8,10]:
            features,resolution=service.grid(bounds,zoom)
            counts.append(len(features))
            self.assertIn('центрі',resolution)
            self.assertEqual(len({feature['id'] for feature in features}),len(features))
            for feature in features:
                ring=feature['geometry']['coordinates'][0]
                self.assertEqual(ring[0],ring[-1])
                for lon,lat in ring:
                    self.assertTrue(service.COVERAGE[0]<=lon<=service.COVERAGE[2])
                    self.assertTrue(service.COVERAGE[1]<=lat<=service.COVERAGE[3])
        self.assertLess(counts[0],counts[1])
        self.assertLess(counts[1],counts[2])

    def test_same_native_climate_support_cell_has_same_cache_key(self):
        self.assertEqual(service.power_key([-97.50,38.51]),
                         service.power_key([-97.49,38.52]))
        self.assertNotEqual(service.power_key([-97.50,38.51]),
                            service.power_key([-95.0,38.51]))


class ServiceTests(unittest.TestCase):
    def setUp(self):
        # A newly introduced adapter must be explicitly mocked; a test must never
        # accidentally acquire real data or alter the download registry.
        blocker=patch('growwhere.sources.CACHE.fetch',
                      side_effect=AssertionError('Network is forbidden in spatial unit tests'))
        blocker.start(); self.addCleanup(blocker.stop)
        def cropland(centers, year, refresh=False):
            return {'by_id':{point['id']:{'allow_analysis':True,
                                         'category':'cropland','year':year,
                                         'sample_only':True}
                             for point in centers},
                    'meta':[provenance('usda-cdl')],'errors':[]}
        landcover=patch('growwhere.landcover.classify_points',side_effect=cropland)
        self.landcover=landcover.start();self.addCleanup(landcover.stop)

    def analyze(self,**overrides):
        params={'bbox':[-97.55,38.45,-97.45,38.55], 'zoom':10,
                'crop':'corn', 'year':2025, 'planting':'2025-05-01'}
        params.update(overrides)
        return service.analyze(**params)

    def test_outside_coverage_and_world_overview_do_not_query_sources(self):
        with patch.object(service.soil,'points') as points, \
             patch.object(service.soil,'polygons') as polygons, \
             patch.object(service,'power_point') as power:
            for overrides in [{'bbox':[10,40,11,41]}, {'zoom':3}]:
                result=self.analyze(**overrides)
                self.assertEqual(result['features'],[])
            points.assert_not_called();polygons.assert_not_called();power.assert_not_called()
            self.landcover.assert_not_called()

    def test_complete_sources_and_cropland_sample_allow_a_real_score(self):
        def points(features,refresh):
            return {f['id']:soil_fixture() for f in features},provenance('ssurgo-statsgo2')
        with patch.object(service.soil,'points',side_effect=points), \
             patch.object(service,'power_point',return_value=({},provenance())), \
             patch.object(service,'climate_metrics',return_value=climate_fixture()):
            result=self.analyze()
        self.assertGreater(len(result['features']),0)
        for feature in result['features']:
            self.assertIsNotNone(feature['properties']['result']['score'])
            self.assertNotEqual(feature['properties']['result']['status'],'unknown')

    def test_missing_landcover_stays_unknown_despite_complete_climate_and_soil(self):
        def points(features,refresh):
            return {f['id']:soil_fixture() for f in features},provenance('ssurgo-statsgo2')
        for missing in ['absent','unknown']:
            with self.subTest(missing=missing):
                def landcover(centers,year,refresh=False):
                    by_id={} if missing=='absent' else {
                        point['id']:{'allow_analysis':None,'category':'unknown'}
                        for point in centers}
                    return {'by_id':by_id,'meta':[],'errors':[]}
                self.landcover.side_effect=landcover
                with patch.object(service.soil,'points',side_effect=points), \
                     patch.object(service,'power_point',return_value=({},provenance())), \
                     patch.object(service,'climate_metrics',return_value=climate_fixture()):
                    result=self.analyze()
                self.assertGreater(len(result['features']),0)
                for feature in result['features']:
                    rating=feature['properties']['result']
                    self.assertEqual(rating['status'],'unknown')
                    self.assertIsNone(rating['score'])
                    self.assertIn('landcover',rating['missing'])

    def test_known_nonagricultural_cover_is_excluded_not_missing_or_red(self):
        def points(features,refresh):
            return {f['id']:soil_fixture() for f in features},provenance('ssurgo-statsgo2')
        def forest(centers,year,refresh=False):
            return {'by_id':{point['id']:{'allow_analysis':False,
                                         'category':'forest','sample_only':True}
                             for point in centers},
                    'meta':[provenance('usda-cdl')],'errors':[]}
        self.landcover.side_effect=forest
        with patch.object(service.soil,'points',side_effect=points), \
             patch.object(service,'power_point',return_value=({},provenance())), \
             patch.object(service,'climate_metrics',return_value=climate_fixture()):
            result=self.analyze()
        self.assertGreater(len(result['features']),0)
        for feature in result['features']:
            rating=feature['properties']['result']
            self.assertEqual(rating['status'],'excluded')
            self.assertIsNone(rating['score'])
            self.assertEqual(rating['missing'],[])
            self.assertEqual(rating['exclusion'],'landcover_not_agricultural')

    def test_missing_soil_keeps_each_cell_unknown(self):
        with patch.object(service.soil,'points',return_value=({},provenance('ssurgo-statsgo2'))), \
             patch.object(service,'power_point',return_value=({},provenance())), \
             patch.object(service,'climate_metrics',return_value=climate_fixture()):
            result=self.analyze()
        self.assertGreater(len(result['features']),0)
        for feature in result['features']:
            self.assertEqual(feature['properties']['result']['status'],'unknown')
            self.assertIsNone(feature['properties']['result']['score'])
            self.assertIn('soil',feature['properties']['result']['missing'])

    def test_missing_climate_keeps_each_cell_unknown_and_reports_error(self):
        def points(features,refresh):
            return {f['id']:soil_fixture() for f in features},provenance('ssurgo-statsgo2')
        with patch.object(service.soil,'points',side_effect=points), \
             patch.object(service,'power_point',side_effect=UpstreamError('Test source unavailable')):
            result=self.analyze()
        self.assertGreater(len(result['features']),0)
        self.assertTrue(result['meta']['errors'])
        for feature in result['features']:
            self.assertEqual(feature['properties']['result']['status'],'unknown')
            self.assertIsNone(feature['properties']['result']['score'])

    def test_native_soil_polygons_reuse_one_climate_request_per_support_cell(self):
        geometry={'type':'Polygon','coordinates':[[[-97.50,38.51],[-97.49,38.51],[-97.49,38.52],[-97.50,38.51]]]}
        features=[{'id':'one','center':[-97.50,38.51], 'geometry':geometry,'soil':soil_fixture()},
                  {'id':'two','center':[-97.49,38.52], 'geometry':copy.deepcopy(geometry),'soil':soil_fixture()}]
        with patch.object(service.soil,'polygons',return_value=(features,provenance('ssurgo-statsgo2'),False)), \
             patch.object(service,'power_point',return_value=({},provenance())) as power, \
             patch.object(service,'climate_metrics',return_value=climate_fixture()):
            result=self.analyze(zoom=13)
        self.assertEqual(power.call_count,1)
        self.assertEqual(result['meta']['mode'],'soil_polygons')
        self.assertEqual(len(result['features']),2)
        self.assertEqual(result['features'][0]['geometry'],geometry)

    def test_public_provenance_omits_private_request_and_filesystem_details(self):
        compact=service.public_meta(provenance())
        self.assertEqual(compact['source_id'],'nasa-power')
        self.assertEqual(compact['sha256'],'a'*64)
        self.assertFalse({'request','path','token'} & compact.keys())
        self.assertNotIn('PRIVATE SQL',str(compact))


if __name__=='__main__': unittest.main()
