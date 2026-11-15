"""Generate clean A4 PDF reports with Cyrillic UTF-8 support from calculation report payloads."""
import io
import textwrap

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
    'good': 'Підходить',
    'conditional': 'Є обмеження',
    'poor': 'Не підходить',
    'unknown': 'Без даних',
    'excluded': 'Поза аналізом',
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
        return '—'
    try:
        num = float(val)
    except (TypeError, ValueError):
        return '—'
    if not (-1e15 < num < 1e15):
        return '—'
    if digits == 0:
        return f'{num:.0f}'
    s = f'{num:.{digits}f}'
    return s.rstrip('0').rstrip('.') if '.' in s else s


def _new_page(pages, page_num):
    fig = plt.figure(figsize=(PAGE_W, PAGE_H), dpi=150)
    fig.patch.set_facecolor('#ffffff')
    fig.text(MARGIN_L, 0.025, 'GrowWhere · RightVersion · Field Shift (NASA Space Apps) — некалібрований скринінговий звіт', fontsize=7.5, color='#556b60')
    fig.text(MARGIN_R, 0.025, f'Стор. {page_num}', fontsize=7.5, color='#556b60', ha='right')
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
        self.ensure_space(0.055)
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
        }
        for line in lines:
            self.fig.text(x, self.y, line, **kwargs)
            self.y -= line_h
        self.y -= 0.008

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
        ax.set_xlabel('Індекс чинника, %', fontsize=8, color='#324a3e')
        ax.grid(axis='x', linestyle='--', alpha=0.35, linewidth=0.6)
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        for bar, v in zip(bars, vals):
            ax.text(v + 2.0, bar.get_y() + bar.get_height() / 2.0, f'{v:.0f}%', va='center', fontsize=8, fontweight='bold', color='#12281e')
        self.y = ax_top - ax_h - 0.032

    def finish(self):
        self.close_page()


def generate_report_pdf(report):
    """Build an A4 UTF-8 vector PDF from a calculation report dictionary."""
    if not isinstance(report, dict):
        raise ValueError('Report payload must be a JSON object')

    header = report.get('header') or {}
    status = report.get('status') or 'unknown'
    status_label = report.get('statusLabel') or STATUS_LABELS.get(status, status)
    score = report.get('reportedScore')

    buf = io.BytesIO()
    with PdfPages(buf) as pp:
        cur = _PdfCursor(pp)

        # Header card
        bg_c, edge_c, txt_c = STATUS_COLORS.get(status, STATUS_COLORS['unknown'])
        card_h = 0.105
        rect = patches.FancyBboxPatch(
            (MARGIN_L, cur.y - card_h),
            MARGIN_R - MARGIN_L,
            card_h,
            boxstyle='round,pad=0.004,rounding_size=0.01',
            facecolor='#f3faf6',
            edgecolor='#0e5a3f',
            linewidth=1.3,
            transform=cur.fig.transFigure,
        )
        cur.fig.add_artist(rect)

        kicker = f"GROWWHERE · {header.get('methodVersion', 'growwhere-screening-0.2')} · {str(header.get('generatedAt', ''))[:16]}"
        cur.fig.text(MARGIN_L + 0.012, cur.y - 0.015, kicker, fontsize=8, fontweight='bold', color='#245c46', va='top')
        title = f"{header.get('scopeLabel', 'Аналіз ділянки')} — {header.get('cropName', header.get('crop', ''))} ({header.get('year', '')})"
        cur.fig.text(MARGIN_L + 0.012, cur.y - 0.036, title[:64], fontsize=13, fontweight='bold', color='#0c3525', va='top')

        coords = header.get('coordinates')
        coord_str = f"{_fmt_num(coords[1], 4)}° N, {_fmt_num(abs(float(coords[0])), 4)}° W" if isinstance(coords, list) and len(coords) >= 2 else 'Контур / область'
        irr_str = f"{_fmt_num(header.get('irrigationMm'), 0)} мм" if header.get('irrigationKnown') else 'не визначено'
        sub = f"Координати: {coord_str}  |  Сівба: {header.get('planting', '—')}  |  Полив: {irr_str}"
        if header.get('scaleHa'):
            sub += f"  |  Площа: {_fmt_num(header.get('scaleHa'), 1)} га"
        cur.fig.text(MARGIN_L + 0.012, cur.y - 0.068, sub, fontsize=8.3, color='#2b4539', va='top')

        badge = patches.FancyBboxPatch(
            (MARGIN_R - 0.175, cur.y - card_h + 0.012),
            0.163,
            card_h - 0.024,
            boxstyle='round,pad=0.003,rounding_size=0.008',
            facecolor=bg_c,
            edgecolor=edge_c,
            linewidth=1.1,
            transform=cur.fig.transFigure,
        )
        cur.fig.add_artist(badge)
        cur.fig.text(MARGIN_R - 0.093, cur.y - 0.026, f"{_fmt_num(score, 1)} / 100" if score is not None else '—', fontsize=15, fontweight='bold', color=txt_c, ha='center', va='top')
        cur.fig.text(MARGIN_R - 0.093, cur.y - 0.066, status_label, fontsize=8.5, fontweight='bold', color=txt_c, ha='center', va='top')

        cur.y -= (card_h + 0.022)

        # Final verdict
        cur.section_title('Підсумковий висновок')
        cur.paragraph(report.get('verdictText') or 'Немає підсумкових даних.', fontsize=9, bg='#f7fbf8', width=92)

        # Factor Chart
        steps = report.get('factorSteps') or []
        if any(s.get('score') is not None for s in steps):
            cur.section_title('Візуалізація 7 чинників придатності')
            cur.factor_chart(steps)

        # Landcover + Area Breakdown + Crop Profile
        cur.section_title('1. Вхідні дані та параметри культури')
        lc = report.get('landcover')
        if lc:
            allow_txt = 'дозволено аналіз' if lc.get('allow_analysis') else 'виключено з орних оцінок'
            cur.paragraph(f"USDA CDL ({lc.get('year', header.get('year', ''))}): {lc.get('label') or lc.get('category') or '—'} (код {lc.get('code', '—')}, {allow_txt}).", fontsize=8.6)
        ab = report.get('areaBreakdown')
        if ab:
            cur.paragraph(
                f"Агрегація по контуру: S_area = Σ(Sⱼ × Aⱼ) / Σ(Aⱼ) | Площа: {_fmt_num(ab.get('areaHa'), 1)} га | "
                f"Оцінено зон: {_fmt_num(ab.get('scoredCount'), 0)} із {_fmt_num(ab.get('totalCount'), 0)} (покриття {_fmt_num(ab.get('coveragePct'), 0)}%).",
                fontsize=8.6,
            )
        prof = report.get('profile')
        if prof:
            stages = prof.get('stages') or []
            cur.paragraph(
                f"Профіль «{prof.get('name', '')}»: стадії {stages} (всього {sum(stages)} дн.), FAO-56 Kc {prof.get('kc')}, "
                f"температурна трапеція {prof.get('temperature')} °C, pH {prof.get('ph')}, заморозки < {prof.get('frost')} °C, спека > {prof.get('heat')} °C.",
                fontsize=8.4,
            )

        # Step-by-step factor formulas
        cur.section_title('2. Покроковий розрахунок 7 факторів із підстановкою чисел')
        for step in steps:
            lim_mark = '  [ОБМЕЖУВАЧ]' if step.get('isLimiting') else ''
            head = f"• {step.get('label', step.get('key'))} (вага {step.get('weightPct', '')}%){lim_mark} → f = {_fmt_num(step.get('score'), 3)}"
            cur.paragraph(head, fontsize=8.8, bold=True, color='#0e3d2b')
            cur.paragraph(f"  Формула: {step.get('formulaTemplate', '')}", fontsize=7.8, mono=True, width=96)
            cur.paragraph(f"  Вхід: {step.get('inputsText', '')}", fontsize=8.1, color='#2c4237', width=98)
            cur.paragraph(f"  Підстановка: {step.get('substituted', '')} | Внесок: {step.get('logText', '—')}", fontsize=7.8, mono=True, bg='#f4f8f5', width=93)

        # Aggregation formula
        agg = report.get('aggregation') or {}
        cur.section_title('3. Фінальне згортання індексу (зважене геометричне середнє і стеля)')
        cur.paragraph(f"{agg.get('formulaGeometric', '')}  |  {agg.get('formulaCeiling', '')}", fontsize=8.4)
        if agg.get('allSevenScored') and not agg.get('hasZeroFactor'):
            ceil_txt = (
                f"Спрацювала стеля критичного мінімуму: min(fᵢ) = {_fmt_num(agg.get('minFactorValue'), 3)} < 0.10 → "
                f"S = min({_fmt_num(agg.get('geometricMean'), 1)}, 100×√{_fmt_num(agg.get('minFactorValue'), 3)} = {_fmt_num(agg.get('ceilingValue'), 1)}) = {_fmt_num(agg.get('computedFinalScore'), 1)}"
                if agg.get('criticalCeilingApplied')
                else f"min(fᵢ) = {_fmt_num(agg.get('minFactorValue'), 3)} ≥ 0.10 → стеля не застосовується → S = {_fmt_num(agg.get('computedFinalScore'), 1)}"
            )
            agg_block = (
                f"Σᵢ wᵢ × ln(fᵢ) = {_fmt_num(agg.get('sumWeightedLog'), 4)}\n"
                f"G = 100 × exp({_fmt_num(agg.get('sumWeightedLog'), 4)}) = {_fmt_num(agg.get('geometricMean'), 1)}\n"
                f"{ceil_txt}"
            )
            if report.get('isAreaAggregate') and report.get('reportedScore') is not None:
                agg_block += f"\nЗважений бал по зонах контуру: S_area = {_fmt_num(report.get('reportedScore'), 1)} / 100"
            cur.paragraph(agg_block, fontsize=8.1, mono=True, bg='#f1f6f3', width=92)
        else:
            cur.paragraph('Недостатньо повних факторів (або один із факторів = 0) для розрахунку геометричного середнього.', fontsize=8.4)

        # Water balance + 7-day Open-Meteo
        cur.section_title('4. Сезонний водний баланс (FAO-56) та 7-денний прогноз')
        hw = report.get('historicalWater')
        if hw:
            cur.paragraph(hw.get('formulaText', ''), fontsize=8.0, mono=True, bg='#f1f6f3', width=92)
            cur.paragraph(
                f"Ефективні опади = {_fmt_num(hw.get('effectiveRainMm'), 1)} мм | "
                f"Полив = {(_fmt_num(hw.get('irrigationMm'), 1) + ' мм') if hw.get('irrigationMm') is not None else 'не визначено'} | "
                f"Потреба ETc = {_fmt_num(hw.get('demandMm'), 1)} мм | Дефіцит = {_fmt_num(hw.get('deficitMm'), 1)} мм.",
                fontsize=8.4,
            )
        planning = report.get('planning') or {}
        sdf = planning.get('sevenDayFormula')
        if sdf:
            cur.paragraph(f"Open-Meteo 7 днів: {sdf.get('equationText', '')}", fontsize=8.0, mono=True, bg='#f4f8f5', width=92)
        if (planning.get('sowingSoilCheck') or {}).get('summary'):
            cur.paragraph(f"Ґрунт 6 см (Open-Meteo): {planning['sowingSoilCheck']['summary']}", fontsize=8.3)

        # 5-year history
        five = report.get('fiveYear') or {}
        lc_hist = five.get('landcoverHistory') or {}
        risk_5y = five.get('climateRisk') or {}
        if lc_hist.get('years') or risk_5y.get('years'):
            cur.section_title('5. Поле за 5 років (USDA CDL сівозміна + NASA POWER ризик)')
            if lc_hist.get('diagnosis'):
                cur.paragraph(f"Діагноз 5-річної історії: {lc_hist['diagnosis']}", fontsize=8.6, bold=True, bg='#fff8ea' if lc_hist.get('monoculture_alert') else '#eef8f2', width=92)
            risk_by_year = {r.get('year'): r for r in (risk_5y.get('years') or [])}
            for item in (lc_hist.get('years') or []):
                ry = risk_by_year.get(item.get('year')) or {}
                crop_txt = item.get('crop_name') or item.get('label') or 'Без даних'
                r_txt = f" | NASA POWER: {_fmt_num(ry.get('score'), 0)}/100, опади {_fmt_num(ry.get('precipitation_mm'), 0)} мм, спека {ry.get('heat_days', 0)} дн." if ry else ''
                cur.paragraph(f"  {item.get('year')}: {crop_txt} ({item.get('category', '—')}){r_txt}", fontsize=8.2)

        # 7 crops comparison
        comp = report.get('cropComparison') or []
        if comp:
            cur.section_title('6. Порівняння 7 культур та економіка USDA ERS')
            for row in comp:
                sc_val = row.get('score') if row.get('score') is not None else row.get('potential_score')
                pot = ' (потенц.)' if row.get('score') is None and row.get('potential_score') is not None else ''
                econ = row.get('economics') or {}
                c_txt = f"${_fmt_num(econ.get('cost_per_ha'), 0)}/га" if econ.get('cost_per_ha') is not None else '—'
                p_txt = f"${_fmt_num(econ.get('price_per_tonne'), 0)}/т" if econ.get('price_per_tonne') is not None else '—'
                mark = ' [ОБРАНО]' if row.get('crop') == header.get('crop') else ''
                cur.paragraph(
                    f"  • {row.get('name', row.get('crop'))}{mark}: {_fmt_num(sc_val, 1)}/100{pot} | дефіцит {_fmt_num(row.get('deficit_mm'), 0)} мм | "
                    f"обмежує {row.get('limiting_factor') or '—'} | витрати {c_txt} | ціна {p_txt}",
                    fontsize=8.1,
                )

        # Gaps and Limitations
        cur.section_title('7. Прогалини даних та наукові обмеження')
        gaps = list(report.get('missingList') or []) + [g.get('message') for g in (planning.get('criticalGaps') or []) if g.get('message')]
        if gaps:
            for g in gaps:
                cur.paragraph(f"  - {g}", fontsize=8.1)
        cur.paragraph(
            f"Важливе застереження: модель {header.get('methodVersion', 'growwhere-screening-0.2')} є некаліброваним інструментом "
            "попереднього скринінгу за історичною погодою NASA POWER (~55 км), ґрунтами USDA SSURGO (0–30 см) і покривом USDA CDL (10–30 м). "
            "Це не прогноз урожайності, не фінансова гарантія й не заміна польового агрохімічного обстеження. NASA не схвалює та не сертифікує RightVersion.",
            fontsize=8.0,
            color='#3a4f44',
            width=96,
        )

        cur.finish()

    return buf.getvalue()
