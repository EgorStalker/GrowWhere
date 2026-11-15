"""PDF layout engine adapted from GrowWhere GitHub 5d4681c; canonical formulas are appended locally."""
import io
import textwrap
import math
import threading
from .analysis import METHOD_VERSION,PROFILES
from .report_methodology import methodology_sections
from urllib.parse import urlsplit,urlunsplit

import matplotlib
matplotlib.use('Agg')
from matplotlib.backends.backend_pdf import PdfPages
import matplotlib.pyplot as plt
import matplotlib.patches as patches


matplotlib.rcParams['font.family'] = 'DejaVu Sans'
matplotlib.rcParams['axes.unicode_minus'] = False

PAGE_W = 8.27
PAGE_H = 11.69
MARGIN_L = 0.065
MARGIN_R = 0.935
STATUS_LABELS = {
    'good': 'Suitable',
    'conditional': 'Limited',
    'poor': 'Unsuitable',
    'unknown': 'No data',
    'excluded': 'Excluded',
}
STATUS_COLORS = {
    'good': ('#e7f7ee', '#157f4b', '#0e5733'),
    'conditional': ('#fff6dc', '#c98a12', '#6d4702'),
    'poor': ('#fdebe8', '#c43e2b', '#7a1f13'),
    'unknown': ('#f1f3f2', '#7d8a84', '#2e3c36'),
    'excluded': ('#eef1f3', '#5f6f78', '#25333a'),
}


def _fmt_num(val, digits=1):
    if val is None or isinstance(val, bool):
        return 'No data'
    try:
        num = float(val)
    except (TypeError, ValueError):
        return 'No data'
    if not (-1e15 < num < 1e15):
        return 'No data'
    if digits == 0:
        return f'{num:.0f}'
    s = f'{num:.{digits}f}'
    return s.rstrip('0').rstrip('.') if '.' in s else s


def _new_page(pages, page_num):
    fig = plt.figure(figsize=(PAGE_W, PAGE_H), dpi=150)
    fig.patch.set_facecolor('#ffffff')
    fig.text(MARGIN_L, 0.025, 'GrowWhere | Historical research screening', fontsize=7.5, color='#556b60')
    fig.text(MARGIN_R, 0.025, f'Page {page_num}', fontsize=7.5, color='#556b60', ha='right')
    return fig


class _PdfCursor:
    def __init__(self, pp):
        self.pp = pp
        self.page_num = 1
        self.fig = _new_page(pp, self.page_num)
        self.y = 0.955

    def close_page(self):
        self.pp.savefig(self.fig, bbox_inches=None)
        plt.close(self.fig)

    def ensure_space(self, needed_y):
        if self.y - needed_y < 0.065:
            self.close_page()
            self.page_num += 1
            self.fig = _new_page(self.pp, self.page_num)
            self.y = 0.955

    def section_title(self, text):
        self.ensure_space(0.09)
        self.y -= 0.012
        self.fig.text(MARGIN_L, self.y, text, fontsize=11, fontweight='bold', color='#0e3d2b', va='top')
        self.y -= 0.020
        line = plt.Line2D([MARGIN_L, MARGIN_R], [self.y, self.y], color='#c9d8cf', linewidth=0.9, transform=self.fig.transFigure)
        self.fig.add_artist(line)
        self.y -= 0.012

    def paragraph(self, text, fontsize=8.8, color='#1c3127', width=98, mono=False, bg=None, bold=False):
        if not text:
            return
        lines = []
        for raw_line in str(text).splitlines():
            wrapped = textwrap.wrap(raw_line, width=width, break_long_words=True, replace_whitespace=False) or ['']
            lines.extend(wrapped)
        line_h = 0.0165 if fontsize <= 9 else 0.019
        total_h = len(lines) * line_h + (0.014 if bg else 0.004)
        self.ensure_space(total_h + 0.01)
        if bg:
            rect = patches.FancyBboxPatch(
                (MARGIN_L, self.y - total_h + 0.004),
                MARGIN_R - MARGIN_L,
                total_h,
                boxstyle='round,pad=0.004,rounding_size=0.008',
                facecolor=bg,
                edgecolor='#c5d5cc',
                linewidth=0.8,
                transform=self.fig.transFigure,
            )
            self.fig.add_artist(rect)
            self.y -= 0.006
        x = MARGIN_L + (0.01 if bg else 0.0)
        kwargs = {
            'fontsize': fontsize,
            'color': color,
            'va': 'top',
            'fontfamily': 'DejaVu Sans Mono' if mono else 'DejaVu Sans',
            'fontweight': 'bold' if bold else 'normal',
            'parse_math': False,
        }
        for line in lines:
            self.fig.text(x, self.y, line, **kwargs)
            self.y -= line_h
        self.y -= 0.017 if bg else 0.008

    def factor_chart(self, factor_steps):
        valid = [s for s in (factor_steps or []) if s.get('score') is not None]
        if not valid:
            return
        self.ensure_space(0.24)
        ax_top = self.y
        ax_h = 0.205
        ax = self.fig.add_axes([MARGIN_L + 0.19, ax_top - ax_h, 0.56, ax_h])
        labels = [f"{s.get('label', s.get('key'))} ({s.get('weightPct', '')}%)" for s in reversed(valid)]
        vals = [max(0.0, min(100.0, float(s['score']) * 100.0)) for s in reversed(valid)]
        colors = ['#157f4b' if v >= 70 else '#d69c36' if v >= 40 else '#c43e2b' for v in vals]
        y_pos = list(range(len(labels)))
        bars = ax.barh(y_pos, vals, color=colors, height=0.62, edgecolor='#244034', linewidth=0.4)
        ax.set_yticks(y_pos)
        ax.set_yticklabels(labels, fontsize=8, color='#12281e')
        ax.set_xlim(0, 112)
        ax.set_xlabel('Factor index, %', fontsize=8, color='#324a3e')
        ax.grid(axis='x', linestyle='--', alpha=0.35, linewidth=0.6)
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        for bar, v in zip(bars, vals):
            ax.text(v + 2.0, bar.get_y() + bar.get_height() / 2.0, f'{v:.0f}%', va='center', fontsize=8, fontweight='bold', color='#12281e')
        self.y = ax_top - ax_h - 0.032

    def finish(self):
        self.close_page()

    def comparison_table(self,rows):
        if not rows:
            self.paragraph('No comparable measures are available in this snapshot.')
            return
        height=(len(rows)+1)*.026
        self.ensure_space(height+.04)
        ax=self.fig.add_axes([MARGIN_L,self.y-height,MARGIN_R-MARGIN_L,height]);ax.set_axis_off()
        table=ax.table(cellText=[[r.get('label',''),r.get('valueA','No data'),r.get('valueB','No data')] for r in rows],
            colLabels=['Measure','Field A','Field B'],colWidths=[.52,.24,.24],cellLoc='left',colLoc='left',bbox=[0,0,1,1])
        table.auto_set_font_size(False);table.set_fontsize(8.2)
        for (row,col),cell in table.get_celld().items():
            cell.set_edgecolor('#d5e1d9');cell.set_linewidth(.5)
            cell.set_facecolor('#e8f2ec' if row==0 else '#f6f9f7' if row%2 else '#ffffff')
            cell.get_text().set_color('#18392b')
            if row==0:cell.get_text().set_fontweight('bold')
        self.y-=height+.025

    def comparison_chart(self,field_a,field_b):
        keys=['temperature','water','ph','awc','drainage','slope','texture']
        self.ensure_space(.29)
        labels=['Temperature','Water','Soil acidity','Water storage','Drainage','Slope','Soil texture']
        ax=self.fig.add_axes([MARGIN_L+.17,self.y-.235,.65,.22])
        for field,shift,color,label in [(field_a,-.17,'#186b50','Field A'),(field_b,.17,'#668fb8','Field B')]:
            factors=field.get('factors') or {}
            positions=[i+shift for i,key in enumerate(keys) if factors.get(key) is not None]
            values=[100*factors[key] for key in keys if factors.get(key) is not None]
            ax.barh(positions,values,height=.30,color=color,label=label)
        ax.set_yticks(range(len(labels)),labels=labels,fontsize=8)
        ax.invert_yaxis();ax.set_xlim(0,100);ax.set_xticks([0,25,50,75,100]);ax.tick_params(axis='x',labelsize=7)
        ax.grid(axis='x',alpha=.2);ax.set_axisbelow(True);ax.spines[['top','right']].set_visible(False)
        ax.legend(loc='lower right',bbox_to_anchor=(1,1.01),frameon=False,ncol=2,fontsize=8)
        self.y-=.28


_RENDER_LOCK=threading.Lock()


def _validate_report(report):
    if not isinstance(report,dict):
        raise ValueError('Report payload must be a JSON object')
    header=report.get('header')
    if not isinstance(header,dict) or header.get('crop') not in PROFILES:
        raise ValueError('A supported crop is required in the report header')
    if header.get('methodVersion',METHOD_VERSION)!=METHOD_VERSION:
        raise ValueError('This report uses a different method version; reload the map before exporting')
    for name,limit in [('factorSteps',7),('zoneTrace',400),('missingList',100),('limitations',30)]:
        value=report.get(name,[])
        if not isinstance(value,list) or len(value)>limit:
            raise ValueError('Invalid or oversized report section: '+name)
    for step in report.get('factorSteps',[]):
        if not isinstance(step,dict):
            raise ValueError('Invalid factor step')
        score=step.get('score')
        if score is not None and (isinstance(score,bool) or not isinstance(score,(float,int)) or not math.isfinite(score) or not 0<=score<=1):
            raise ValueError('A factor score must be between 0 and 1 or missing')
    score=report.get('reportedScore')
    if score is not None and (isinstance(score,bool) or not isinstance(score,(int,float)) or not math.isfinite(score) or not 0<=score<=100):
        raise ValueError('A reported score must be between 0 and 100 or missing')
    if report.get('status') in ('unknown','excluded') and score is not None:
        raise ValueError('No data and excluded areas cannot have a numerical score')


def _write_field(cur,report,tag='Selected field'):
    h=report['header']
    cur.section_title(tag)
    cur.paragraph(f"{h.get('cropName',h['crop'])} | Historical season {h.get('year','No data')} | {h.get('scopeLabel','Selected area')}",fontsize=10,bold=True)
    cur.paragraph(f"Suitability: {_fmt_num(report.get('reportedScore'))} / 100 | {STATUS_LABELS.get(report.get('status'),'No data')}",fontsize=10,bg='#eef7f2',bold=True)
    cur.paragraph(report.get('verdictText') or 'No numerical conclusion is available.')
    cur.paragraph(f"Historical reference date: {h.get('planting','No data')} (not a sowing recommendation). Irrigation scenario: {_fmt_num(h.get('irrigationMm'))} mm; {'confirmed user input' if h.get('irrigationKnown') else 'unconfirmed, lower-bound rainfed scenario'}.")
    coordinates=h.get('coordinates')
    if isinstance(coordinates,list) and len(coordinates)>=2:
        cur.paragraph(f"Reference coordinates (WGS84): lon {_fmt_num(coordinates[0],5)}, lat {_fmt_num(coordinates[1],5)}.")
    ab=report.get('areaBreakdown')
    if isinstance(ab,dict):
        cur.paragraph(f"Boundary: {_fmt_num(ab.get('areaHa'),2)} ha. Zones with scores: {ab.get('scoredCount',0)} / {ab.get('totalCount',0)}. Geometric coverage: not calculated.")
        cur.paragraph(ab.get('coverageNote') or 'Zone weights use whole intersecting areas, not clipped intersections.',bg='#fff8e9')
    for title,key in [('Stored soil observations','soil'),('Stored seasonal climate','climate')]:
        data=report.get(key)
        if isinstance(data,dict):
            keys=['ph','awc','slope','sand','clay','drainage','depth_coverage_cm'] if key=='soil' else ['mean_temperature','precipitation_mm','crop_water_demand_mm','expected_days','valid_days','heat_days','frost_days']
            cur.paragraph(title+': '+ '; '.join(f'{k}={data.get(k) if data.get(k) is not None else "No data"}' for k in keys),fontsize=8.1)
    steps=report.get('factorSteps',[])
    if any(s.get('score') is not None for s in steps):
        cur.factor_chart(steps)
    cur.section_title('Factor equations and available substitutions')
    for step in steps:
        cur.ensure_space(.13)
        cur.paragraph(f"{step.get('label',step.get('key'))} | weight {step.get('weightPct',0)}% | stored factor {_fmt_num(step.get('score'),3)}",bold=True)
        cur.paragraph(step.get('formulaTemplate',''),fontsize=7.8,mono=True,width=90)
        cur.paragraph(step.get('inputsText',''),fontsize=8.1,width=98)
        cur.paragraph(step.get('substituted',''),fontsize=8.0,width=96,bg='#f4f8f5')
        cur.paragraph('Weighted log term: '+str(step.get('logText','No data')),fontsize=7.8,mono=True,width=90)
    agg=report.get('aggregation') or {}
    cur.section_title('Applied aggregation')
    cur.paragraph(agg.get('formulaApplied') or 'No aggregation trace is available.',fontsize=8.4,bg='#eef7f2')
    cur.paragraph(agg.get('formulaGeometric',''),fontsize=8,mono=True,width=90)
    cur.paragraph(agg.get('formulaCeiling',''),fontsize=8,mono=True,width=90)
    if agg.get('mode')=='point' and agg.get('allSevenScored'):
        if agg.get('hasZeroFactor'):
            cur.paragraph('At least one known factor is zero: reconstructed S = 0. ln(0) is not evaluated.')
        else:
            cur.paragraph(f"sum(w_i*ln(f_i)) = {_fmt_num(agg.get('sumWeightedLog'),6)}; G = {_fmt_num(agg.get('geometricMean'),3)}; reconstructed S = {_fmt_num(agg.get('computedFinalScore'),3)}. Stored values are rounded; this reconstruction may differ slightly.")
    else:
        cur.paragraph('No nonlinear point-score reconstruction is made from averaged factors. Individual sample inputs are not retained in this prepared product.',bg='#fff8e9')
    trace=report.get('zoneTrace') or []
    if trace:
        cur.section_title('Prepared zone trace')
        for row in trace:
            cur.paragraph(f"{row.get('id','zone')} | {row.get('status','unknown')} | score {_fmt_num(row.get('score'),1)} | zone weight {_fmt_num(row.get('areaWeight'),0)} m2",fontsize=8.0,bold=True)
            if row.get('factors'):
                cur.paragraph('Stored factors: '+ '; '.join(f'{k}={_fmt_num(v,3)}' for k,v in row['factors'].items()),fontsize=7.8)
            u=row.get('uncertainty')
            if isinstance(u,dict):
                cur.paragraph(f"Samples: {u.get('scored_samples','No data')} scored / {u.get('sample_count','No data')}; unknown {u.get('unknown_samples','No data')}; excluded {u.get('excluded_samples','No data')}; score range {u.get('score_range','No data')}.",fontsize=7.8)
    hw=report.get('historicalWater')
    cur.section_title('Seasonal water balance')
    cur.paragraph(hw.get('formulaText','No complete water-balance values in this snapshot.') if isinstance(hw,dict) else 'No complete water-balance values in this snapshot.',fontsize=8.2,bg='#f4f8f5')
    econ=report.get('economics') or {}
    cur.section_title('Historical economic context')
    cur.paragraph(f"USDA ERS | {econ.get('actual_year') or econ.get('year') or 'year unavailable'} | {econ.get('region') or 'region unavailable'} | Costs: {_fmt_num(econ.get('cost_per_ha'),2)} USD/ha | Harvest price: {_fmt_num(econ.get('price_per_tonne'),2)} USD/t.")
    cur.paragraph('Current market demand: No data. Historical prices are not current sale quotes or a guarantee of profit.')
    cur.section_title('Source version and data gaps')
    provenance=report.get('provenance') or {}
    for key in ['productId','versionKey','sourceSnapshot','publishedAt','expiresAt']:
        cur.paragraph(f"{key}: {provenance.get(key) or 'No data'}",fontsize=7.8,width=95)
    if provenance.get('stale'):
        cur.paragraph('STALE SNAPSHOT: this saved map is awaiting a data refresh.',bold=True,bg='#fff8e9')
    sources={}
    for s in provenance.get('sourceSnapshots',[]):
        if isinstance(s,dict):
            sources.setdefault(s.get('source_id') or 'source',[]).append(s)
    for name,items in sources.items():
        times=sorted(str(s.get('retrieved_at')) for s in items if s.get('retrieved_at'))
        urls=sorted({urlunsplit((*urlsplit(str(s['source_url']))[:3],'','')) for s in items if s.get('source_url')})
        cur.paragraph(f"{name}: {len(items)} source snapshots; retrieved {times[0] if times else 'No data'} to {times[-1] if times else 'No data'}.",fontsize=7.8)
        for url in urls[:3]:
            cur.paragraph(url,fontsize=7.3,width=100)
    gaps=list(report.get('missingList',[]))
    for g in (report.get('planning') or {}).get('criticalGaps',[]):
        if isinstance(g,dict):
            gaps.append(g.get('message') or g.get('id') or 'Missing planning input')
    for g in gaps:
        cur.paragraph('Missing: '+str(g),fontsize=8.2)
    for note in report.get('limitations',[]):
        cur.paragraph(note,fontsize=8.0)


def generate_report_pdf(report):
    """Render the transferred report feature with canonical current equations."""
    _validate_report(report)
    comparison=report.get('comparison')
    if comparison is not None:
        if not isinstance(comparison,dict) or not isinstance(comparison.get('rows'),list) or len(comparison['rows'])>20:
            raise ValueError('Invalid field comparison')
        for key in ('fieldA','fieldB'):
            if not isinstance(comparison.get(key),dict):
                raise ValueError('Two field snapshots are required')
            _validate_report(comparison[key].get('report'))
    buf=io.BytesIO()
    with _RENDER_LOCK,PdfPages(buf,metadata={'Title':'GrowWhere calculation report','Author':'GrowWhere','Subject':'Historical suitability, calculation formulas and data limits'}) as pp:
        cur=_PdfCursor(pp)
        cur.paragraph('GrowWhere',fontsize=18,bold=True,color='#0e3d2b')
        cur.paragraph('Field comparison report' if comparison else 'Calculation report',fontsize=12,bold=True)
        cur.paragraph(f"Generated: {report['header'].get('generatedAt','No data')} | Method: {METHOD_VERSION}",fontsize=8)
        if comparison:
            cur.section_title('Field A and field B')
            if comparison.get('scopeWarning'):
                cur.paragraph(comparison['scopeWarning'],bg='#fff8e9')
            cur.paragraph(comparison.get('verdict',''),bg='#eef7f2')
            for tag,key in [('A','fieldA'),('B','fieldB')]:
                cur.paragraph(f"Field {tag}: {comparison[key]['report']['header'].get('scopeLabel','selected area')}",fontsize=8.3)
            cur.comparison_table(comparison['rows'])
            cur.comparison_chart(comparison['fieldA'],comparison['fieldB'])
            cur.paragraph('Factor advantages are descriptive; they are not independent votes for an optimal field. Both results inherit source resolution and data limits.',fontsize=8.1)
            for key,tag in [('fieldA','Field A'),('fieldB','Field B')]:
                cur.close_page();cur.page_num+=1;cur.fig=_new_page(pp,cur.page_num);cur.y=.955
                _write_field(cur,comparison[key]['report'],tag)
        else:
            _write_field(cur,report)
        cur.close_page();cur.page_num+=1;cur.fig=_new_page(pp,cur.page_num);cur.y=.955
        cur.section_title('Calculation methodology: complete equations')
        crops=[report['header']['crop']]
        if comparison:
            crops=list(dict.fromkeys(comparison[k]['report']['header']['crop'] for k in ('fieldA','fieldB')))
        for crop in crops:
            for title,body in methodology_sections(crop):
                cur.section_title(title)
                cur.paragraph(body,fontsize=8.4,width=96)
        cur.finish()
    return buf.getvalue()
