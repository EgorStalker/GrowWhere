"""Ported PDF contract tests plus current-method and missing-data safeguards."""
import unittest
import re
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from growwhere.report_pdf import generate_report_pdf
from growwhere.report_methodology import methodology_sections
from growwhere.analysis import METHOD_VERSION,PROFILES,WEIGHTS


def payload():
    return {'header':{'crop':'corn','cropName':'Corn','year':2025,'planting':'2025-05-01','methodVersion':METHOD_VERSION,
        'scopeLabel':'Synthetic unit-test field','generatedAt':'2026-11-15T18:00:00Z'},
        'status':'unknown','reportedScore':None,'factorSteps':[],'missingList':['soil'],
        'limitations':['Synthetic fixture; not an observation of a real field.']}


class ReportPdfTests(unittest.TestCase):
    def test_transferred_pdf_engine_returns_a_real_multipage_pdf(self):
        pdf=generate_report_pdf(payload())
        self.assertTrue(pdf.startswith(b'%PDF-1.'))
        self.assertGreater(len(pdf),10000)
        self.assertGreater(len(re.findall(rb'/Type\s*/Page\b',pdf)),1)

    def test_pdf_rejects_malformed_payloads_and_wrong_method(self):
        for p in [[],{},dict(payload(),reportedScore=float('nan')),
                  dict(payload(),status='unknown',reportedScore=42)]:
            with self.assertRaises(ValueError):generate_report_pdf(p)
        p=payload();p['header']['methodVersion']='future-unverified-method'
        with self.assertRaises(ValueError):generate_report_pdf(p)

    def test_pdf_preserves_known_zero_factors(self):
        p=payload();p.update(status='poor',reportedScore=0,factorSteps=[{'key':'ph','label':'Soil acidity','score':0,'weightPct':15}],
                            aggregation={'mode':'point','allSevenScored':True,'hasZeroFactor':True})
        self.assertTrue(generate_report_pdf(p).startswith(b'%PDF'))

    def test_comparison_includes_both_field_reports(self):
        p=payload();p['comparison']={'rows':[],'fieldA':{'report':payload()},'fieldB':{'report':payload()},'verdict':'No scores are available.'}
        pdf=generate_report_pdf(p)
        self.assertGreater(len(re.findall(rb'/Type\s*/Page\b',pdf)),3)

    def test_canonical_appendix_contains_every_calculation_stage_and_live_parameters(self):
        text='\n'.join(title+'\n'+body for title,body in methodology_sections('corn'))
        for token in ['ET0 =','e0(T)','Patm =','gamma =','Ra =','Rso =','Rnl =','Rn =','Kc(t)','ETc =',
                      'f_temperature','f_water','f_ph','f_awc','f_slope','f_texture','f_drainage','S_cell =','S_area =',
                      'Ring area','ln(0)','USD/ha','Deficit =','0.5','coverage percentage is unavailable']:
            self.assertIn(token,text)
        self.assertIn(str(PROFILES['corn']['stages']),text)
        self.assertIn(f"water={WEIGHTS['water']:g}",text)

    def test_no_forecast_or_default_irrigation_is_added_by_the_export(self):
        text='\n'.join(body for _,body in methodology_sections('corn'))
        self.assertIn('No sowing date or recommended irrigation amount is calculated',text)
