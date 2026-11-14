import sys
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'data/pipelines'))
from growwhere.landcover import _interpret_samples,category_for,classify_points


class LandcoverTests(unittest.TestCase):
    def test_nonagricultural_classes_are_excluded_and_pasture_is_context(self):
        for code,category in [(111,'water'),(124,'urban'),(141,'forest'),(190,'wetland'),(112,'snow')]:
            self.assertEqual(category_for(code,'official label'),(category,False))
        self.assertEqual(category_for(176,'Grassland/Pasture'),('pasture',True))
        self.assertEqual(category_for(1,'Corn'),('cropland',True))
        self.assertEqual(category_for(131,'Barren'),('barren',None))

    def test_nodata_unknown_code_and_missing_legend_are_not_crop(self):
        for code,label in [(0,'Background'),(81,'Clouds/No Data'),(1,None),(999,'Unrecognized')]:
            self.assertIsNone(category_for(code,label)[1])

    def test_missing_samples_and_wrong_year_do_not_fallback(self):
        points=[{'id':'a','lon':-97.5,'lat':38.5},{'id':'b','lon':-97.4,'lat':38.4}]
        response={'samples':[{'location':{'x':-97.5,'y':38.5,'spatialReference':{'wkid':4326}},'locationId':0,'value':'1','attributes':{'Year':2024},'resolution':30}]}
        result=_interpret_samples(response,points,2025,{1:'Corn'},'source')
        self.assertEqual(result['a']['reason'],'year_mismatch')
        self.assertIsNone(result['a']['allow_analysis'])
        self.assertEqual(result['b']['reason'],'sample_not_returned')

    def test_location_id_requires_matching_coordinates_and_exact_resolution(self):
        points=[{'id':'a','lon':-97.5,'lat':38.5}]
        sample={'location':{'x':-97.5,'y':38.5,'spatialReference':{'wkid':4326}},'locationId':0,'value':'176','rasterId':40,'attributes':{'Year':2025,'Name':'2025_10m_cdls'},'resolution':10}
        result=_interpret_samples({'samples':[sample]},points,2025,{176:'Grassland/Pasture'},'source')
        self.assertEqual(result['a']['resolution_m'],10)
        self.assertEqual(result['a']['category'],'pasture')
        sample['location']['x']=-98
        self.assertIsNone(_interpret_samples({'samples':[sample]},points,2025,{176:'Grassland/Pasture'},'source')['a']['code'])

    def test_absent_year_returns_missing_before_any_sampling(self):
        class EmptyCache:
            def fetch(self,*args,**kwargs): return {'features':[]},{'source_url':args[1]}
        result=classify_points([{'id':'a','lon':-97.5,'lat':38.5}],2030,cache=EmptyCache())
        self.assertEqual(result['by_id']['a']['reason'],'year_not_available')
        self.assertIsNone(result['by_id']['a']['allow_analysis'])

    def test_source_failure_never_turns_into_land(self):
        class FailedCache:
            def fetch(self,*args,**kwargs): raise TimeoutError('test')
        result=classify_points([('a',-97.5,38.5)],2025,cache=FailedCache())
        self.assertIsNone(result['by_id']['a']['allow_analysis'])
        self.assertTrue(result['errors'])


if __name__=='__main__': unittest.main()
