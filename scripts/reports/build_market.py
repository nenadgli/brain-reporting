"""F&F MPL & REPORT, October 2026, one workbook per market, in the PPC team's structure. Data: report_data.sql output.
Totals, CTR, frequency and ROAS are Excel formulas, so the manual inputs (orange) recalculate everything."""
import json, re, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter as L

DATA = json.load(open(sys.argv[1])); OUT = sys.argv[2]
HDR = PatternFill('solid', fgColor='1F3864'); HF = Font(bold=True, color='FFFFFF')
SUB = PatternFill('solid', fgColor='D9E1F2'); TOT = PatternFill('solid', fgColor='B4C6E7'); MAN = PatternFill('solid', fgColor='FCE4D6')
B = Font(bold=True); thin = Side(style='thin', color='BFBFBF'); BOX = Border(top=thin, bottom=thin, left=thin, right=thin)
EUR = '#,##0.00'; INT = '#,##0'; DEC = '#,##0.0'; PCT = '0.00%'; X = '0.00'
COLS = ['Type','Network','Start','End','Linija','Regular','Flash','Plan Sum','Actual Spend','Reach (Unique)','Impressions','Frequency',
        'Clicks','CTR','Conversions','Revenue','ROAS','Installs','Napomena','Kampanje / ad setovi / asset grupe']
W = [10,20,7,7,34,10,10,11,12,12,13,9,11,8,11,14,8,9,62,60]
f = lambda v: None if v is None else float(v)
INACTIVE = {('HR', 'Halloween - Awareness'): 'Kampanja nije bila aktivna (PPC, 5.11.).', ('ME', 'MSS - Awareness'): 'Kampanja nije bila aktivna (PPC, 5.11.).'}

def group_of(x):
    lab, ch, t = x['label'].lower(), (x['channel'] or '').lower(), (x['type'] or '').lower()
    if x['network'] == 'meta':
        if re.search(r'ad ?hoc', lab): return 'Ad hoc'
        if 'awareness' in lab: return 'Awareness (reach objective)'
        if 'remarketing' in lab or 'dpa' in ch: return 'Consolidated Remarketing'
        return 'Always On Prospecting' if t == 'always-on' else 'Flight Prospecting'
    if re.search(r'ad ?hoc', lab): return 'Ad Hoc'
    if re.search(r'deman|youtube', lab): return 'Flight - consideration'
    if t == 'always-on' or re.search(r'search|display|kiko', lab): return 'Always On'
    return 'Flight - Conversion'

def promo_of(x):
    lab = x['label'].lower()
    for k, v in (('hallow|hellow', 'Halloween'), (r'\bmss\b', 'MSS'), ('loyal', 'Loyalty akcija'), ('20%', '–20% FW'),
                 ('ad ?hoc', 'Ad Hoc'), ('main', 'Main campaign FW26')):
        if re.search(k, lab): return v
    return 'Always-on'

def build(mk, d):
    wb = Workbook(); ws = wb.active; ws.title = f'MPL & REPORT Oktobar 2026'
    for i, w in enumerate(W, 1): ws.column_dimensions[L(i)].width = w
    def put(r, c, v, nf=None, fill=None, bold=False, wrap=False):
        x = ws.cell(row=r, column=c, value=v); x.border = BOX
        if nf: x.number_format = nf
        if fill: x.fill = fill
        if bold: x.font = B
        if wrap: x.alignment = Alignment(wrap_text=True, vertical='top')
        return x
    lines = d['lines'] or []; res = d['res'] or {}
    ws['A1'] = f'F&F {mk} · MPL & REPORT · Oktobar 2026'; ws['A1'].font = Font(bold=True, size=14)
    ws['A2'] = 'Brain, plan sa Drive-a (dnevna provera). Narandžasto = ručni unos PPC; zbirovi su formule i preračunaju se posle unosa.'
    # RESULTS block
    put(4, 5, 'RESULTS', fill=HDR).font = HF
    for j, hh in enumerate(['TOTAL WEB', 'TOTAL PAID', 'Meta Ads', 'Google Ads', 'Programmatic', 'TikTok Ads'], 6): put(4, j, hh, fill=HDR).font = HF
    for rr, lab in ((5, 'Conversions'), (6, 'Revenue'), (7, 'ROAS'), (8, 'Percent')): put(rr, 5, lab, bold=True)
    for j, k in zip(range(8, 12), ['meta', 'google', 'prog', 'tiktok']):
        v = res.get(k) or [None, None]; put(5, j, f(v[0]) or 0, INT); put(6, j, f(v[1]) or 0, EUR)
    w0 = res.get('web') or [0, 0]; put(5, 6, f(w0[0]), INT); put(6, 6, f(w0[1]), EUR)
    put(5, 7, '=SUM(H5:K5)', INT); put(6, 7, '=SUM(H6:K6)', EUR); put(7, 6, 'N/A')
    for j in range(7, 12): put(8, j, f'=IFERROR({L(j)}6/$F$6,"")', PCT)
    put(8, 6, 1, PCT)
    put(4, 13, 'Napomena', fill=HDR).font = HF; ws.merge_cells('M5:T8')
    put(5, 13, f'GA4, {mk} prodavnica, ceo oktobar. Meta = source „facebook", Google = google/cpc, Programmatic = rtbhouse, TikTok = tiktok '
               '(pravila PPC izveštaja, provereno na RS septembru do centa). Kanal ukupno je veći od zbira linija (GA4 lookback). '
               'ROAS = prihod kanala / ecomm spend kanala.', wrap=True)
    r = [10]
    for i, hh in enumerate(COLS, 1):
        x = put(r[0], i, hh, fill=HDR); x.font = HF; x.alignment = Alignment(wrap_text=True, horizontal='center', vertical='center')
    ws.row_dimensions[10].height = 32; ws.freeze_panes = 'F11'; r[0] += 1
    promo_rows = {}

    def write_line(x, manual=(), note='', inst_row=False, ga=None):
        rr = r[0]; sub_g = x['network'] == 'google' and ' / ' in (x['matched'] or '')
        no_acct = x['network'] in ('meta', 'google') and (d['acct'] or {}).get(x['network']) is None
        if no_acct:
            manual = tuple(manual) + (9, 10, 11, 13, 15, 16)
        notes, reach = [], f(x['reach'])
        if x['note']: notes.append(('Pretpostavka – ' if x['confirmed'] is False else '') + x['note'])
        if no_acct and f(x['plan']):
            notes.append(f"{'Google Ads' if x['network'] == 'google' else 'Meta'} nalog za {mk} nije povezan sa Brain-om: ručni unos.")
        elif x['matched'] is None and x['network'] in ('meta', 'google') and f(x['plan']) and (mk, x['label']) not in INACTIVE:
            notes.append('Nema kampanje u nalogu za ovu liniju.' if not re.search(r'ad ?hoc', x['label'], re.I) else 'Rezerva; nije trošena.')
        camps = {u.split(' / ')[0].replace(' (bez grupa drugih linija)', '') for u in (x['matched'] or '').split(' | ')} if x['matched'] else set()
        if x['network'] == 'google' and x['matched']:
            if sub_g and reach is not None and len(camps) == 1:
                notes.append('Asset grupe ove linije su cela kampanja u oktobru: GA4 i doseg kampanje.')
            elif sub_g:
                reach = None; notes.append('Doseg: Google ga ne daje po asset/ad grupi. GA4: dnevni GA4 kampanje × udeo grupe u potrošnji (kampanja deli asset grupe sa drugim linijama).')
            elif (x['n'] or 0) > 1 or '(bez grupa' in x['matched']:
                notes.append(f"Doseg: ručno iz Google Ads UI (deduplikovano); zbir kampanja {int(reach or 0):,} je gornja granica.".replace(',', '.')); reach = None
                manual = tuple(manual) + (10,)
        if x['network'] == 'meta' and (x['n'] or 0) > 1:
            notes.append(f"Doseg: {x['n']} kampanje/ad seta, deduplikovano ručno iz Ads Manager-a (zbir {int(reach or 0):,}).".replace(',', '.')); reach = None
            manual = tuple(manual) + (10,)
        if (mk, x['label']) in INACTIVE: notes.append(INACTIVE[(mk, x['label'])])
        if note: notes.append(note)
        v = {1: x['type'], 2: x['channel'], 3: x['start'] and f"{int(x['start'][8:10])}.{int(x['start'][5:7])}.",
             4: x['end'] and f"{int(x['end'][8:10])}.{int(x['end'][5:7])}.", 5: x['label'], 6: f(x['reg']), 7: f(x['flash']), 8: f(x['plan']),
             9: f(x['spend']) if x['matched'] or x['network'] not in ('meta', 'google') else (None if no_acct else 0),
             10: reach, 11: f(x['imp']), 13: f(x['clk']), 15: f(x['tx']), 16: f(x['rev']), 19: ' '.join(notes), 20: x['matched']}
        if ga: v[15], v[16] = ga
        if inst_row: v[15] = v[16] = None; v[18] = f(x['inst'])
        for c in range(1, 21):
            nf = {6: EUR, 7: EUR, 8: EUR, 9: EUR, 10: INT, 11: INT, 13: INT, 15: (DEC if sub_g else INT), 16: EUR, 18: INT}.get(c)
            put(rr, c, v.get(c), nf, MAN if c in manual else None, wrap=c in (19, 20))
        put(rr, 12, f'=IFERROR(K{rr}/J{rr},"")', X); put(rr, 14, f'=IFERROR(M{rr}/K{rr},"")', PCT)
        if not inst_row: put(rr, 17, f'=IFERROR(P{rr}/I{rr},"")', X)
        if x['section'] == 'ecomm': promo_rows.setdefault(promo_of(x) if x['network'] in ('meta', 'google') else
                                                          {'programmatic': 'Programmatic', 'tiktok': 'TikTok'}[x['network']], []).append(rr)
        r[0] += 1; return rr

    def subtotal(label, rows, kind='SUBTOTAL', fill=SUB, installs=False):
        rr = r[0]; put(rr, 1, kind, fill=fill, bold=True); put(rr, 5, label, fill=fill, bold=True)
        cols = (6, 7, 8, 9, 11, 13) + ((18,) if installs else (15, 16))
        for c in cols: put(rr, c, ('=' + '+'.join(f'{L(c)}{x}' for x in rows)) if rows else 0, INT if c in (11, 13, 15, 18) else EUR, fill, True)
        put(rr, 10, None, None, MAN if kind == 'SUBTOTAL' and rows else fill)
        for c in (2, 3, 4, 19, 20): put(rr, c, None, fill=fill)
        put(rr, 12, f'=IFERROR(K{rr}/J{rr},"")', X, fill); put(rr, 14, f'=IFERROR(M{rr}/K{rr},"")', PCT, fill)
        if not installs: put(rr, 17, f'=IFERROR(P{rr}/I{rr},"")', X, fill, True)
        r[0] += 1; return rr

    def section(title):
        r[0] += 1; put(r[0], 5, title, fill=HDR).font = HF; r[0] += 1

    tot = {}
    for net, title, groups, total in (
            ('meta', 'META ADS', ['Always On Prospecting', 'Flight Prospecting', 'Consolidated Remarketing', 'Awareness (reach objective)', 'Ad hoc'], 'ECOMM META TOTAL'),
            ('google', 'GOOGLE ADS', ['Always On', 'Flight - Conversion', 'Flight - consideration', 'Ad Hoc'], 'ECOMM GOOGLE TOTAL')):
        ec = [x for x in lines if x['network'] == net and x['section'] == 'ecomm']
        if ec:
            section(f'{title} · ECOMM'); subs = []
            for g in groups:
                gl = [x for x in ec if group_of(x) == g]
                if gl: subs.append(subtotal(g, [write_line(x) for x in gl]))
            tot[net] = subtotal(total, subs, 'TOTAL', TOT)
        ly = [x for x in lines if x['network'] == net and x['section'] == 'loyalty']
        if ly:
            section(f'{title} · LOYALTY')
            rows = [write_line(x, inst_row=True,
                               note='Installs: Meta rezultat kampanje (mobile app install); App kampanje se sabiraju.' if net == 'meta'
                                    else 'Installs: Google Ads akcije „install / first open"; App kampanje se sabiraju.') for x in ly]
            subtotal(f'LOYALTY {title.split()[0]}', rows, 'TOTAL', TOT, installs=True)
    for net, title, key in (('tiktok', 'TIKTOK', 'tiktok'), ('programmatic', 'PROGRAMMATIC', 'prog')):
        pl = [x for x in lines if x['network'] == net and f(x['plan'])]
        ga = res.get(key) or [0, 0]
        if not pl and not f(ga[0]): continue
        section(title); rows = []
        rem = [x for x in pl if x['label'].strip().upper() == 'REM'] if net == 'programmatic' else [x for x in pl if re.search('test', x['label'], re.I)]
        rtb = d.get('rtb') or {}
        for x in pl:
            g = (f(ga[0]), f(ga[1])) if rem and x is rem[0] else None
            gnote = ((' Konverzije/prihod: GA4 rtbhouse.' if net == 'programmatic'
                      else ' Konverzije/prihod: ceo GA4 TikTok na liniji sa budžetom (PPC).') if g else '')
            tab = {'REM': 'Retargeting', 'PRO': 'Traffic'}.get(x['label'].strip().upper()) if net == 'programmatic' else None
            if tab and tab in rtb:
                x = dict(x, spend=rtb[tab][0], imp=rtb[tab][1], clk=rtb[tab][2])
                rows.append(write_line(x, ga=g, note=f'Spend, impresije, klikovi: RTB House dnevni sheet (tab {mk} – {tab}).' + gnote))
            elif net == 'programmatic':
                rows.append(write_line(x, manual=(9, 11, 13), ga=g, note=f'Nema taba „{mk} – {tab or x["label"]}" u RTB sheet-u: spend ručno.' + gnote))
            else:
                rows.append(write_line(x, manual=(9, 10, 11, 13), ga=g, note='Spend ručno (nije povezano sa Brain-om).' + gnote))
        for tab, v in rtb.items():  # RTB spend on a line the plan has no budget for
            if not any({'REM': 'Retargeting', 'PRO': 'Traffic'}.get(x['label'].strip().upper()) == tab for x in pl) and net == 'programmatic' and f(v[0]):
                lab = {'Retargeting': 'REM', 'Traffic': 'PRO'}.get(tab, tab)
                rows.append(write_line({'type': None, 'channel': 'Programmatic', 'start': None, 'end': None, 'label': f'{lab} (van plana)', 'reg': None,
                                        'flash': None, 'plan': 0, 'spend': v[0], 'imp': v[1], 'clk': v[2], 'reach': None, 'tx': None, 'rev': None,
                                        'inst': None, 'n': None, 'matched': None, 'confirmed': None, 'note': None, 'network': 'programmatic',
                                        'section': 'ecomm'}, note=f'RTB sheet (tab {mk} – {tab}) ima trošak, u MPL-u ova linija nema budžet.'))
        tot[key] = subtotal(f'ECOMM {title.title()}', rows, 'TOTAL', TOT)
        if not rem:
            ws.cell(row=tot[key], column=15, value=f(ga[0])).number_format = INT; ws.cell(row=tot[key], column=16, value=f(ga[1])).number_format = EUR
            ws.cell(row=tot[key], column=19, value=f'GA4 {key} ukupno za mesec (po linijama se ne može razdvojiti).').alignment = Alignment(wrap_text=True, vertical='top')
    # ROAS in RESULTS
    sp = [f'I{tot[k]}' for k in ('meta', 'google', 'prog', 'tiktok') if k in tot]
    ws['G7'] = f'=IFERROR(G6/({"+".join(sp)}),"")' if sp else ''
    for col, k in zip('HIJK', ('meta', 'google', 'prog', 'tiktok')):
        ws[f'{col}7'] = f'=IFERROR({col}6/I{tot[k]},"")' if k in tot else ''
        ws[f'{col}7'].number_format = X; ws[f'{col}7'].border = BOX
    ws['G7'].number_format = X; ws['G7'].border = BOX
    # spend by promo
    r[0] += 2; put(r[0], 5, 'Actual Spend po akcijama', fill=HDR).font = HF; put(r[0], 9, 'Actual Spend', fill=HDR).font = HF; r[0] += 1
    srows = []
    for k in ('Always-on', 'Main campaign FW26', '–20% FW', 'Loyalty akcija', 'MSS', 'Halloween', 'Programmatic', 'TikTok', 'Ad Hoc'):
        if k in promo_rows:
            put(r[0], 5, k); put(r[0], 9, '=' + '+'.join(f'I{x}' for x in promo_rows[k]), EUR); srows.append(r[0]); r[0] += 1
    put(r[0], 5, 'TOTAL ECOMM', bold=True, fill=TOT); put(r[0], 9, '=' + '+'.join(f'I{x}' for x in srows), EUR, TOT, True); r[0] += 1
    put(r[0], 5, 'kontrola: ECOMM Meta + Google + Programmatic + TikTok'); put(r[0], 9, '=' + '+'.join(sp) if sp else 0, EUR); r[0] += 2
    # outside the plan
    line_sp = {n: sum(f(x['spend']) or 0 for x in lines if x['network'] == n) for n in ('meta', 'google')}
    put(r[0], 5, 'Van MPL plana', fill=HDR).font = HF; put(r[0], 9, 'Spend', fill=HDR).font = HF; r[0] += 1
    for n, lab in (('meta', 'Meta – kampanje/ad setovi bez linije u planu (bez Social)'), ('google', 'Google – kampanje bez linije u planu')):
        acct = f((d['acct'] or {}).get(n)) or 0
        put(r[0], 5, lab); put(r[0], 9, round(acct - line_sp[n], 2), EUR); r[0] += 1
    soc = d['social'] or []
    put(r[0], 5, 'Meta Social boost (van MPL-a)'); put(r[0], 9, round(sum(float(s[1]) for s in soc), 2), EUR)
    put(r[0], 19, ', '.join(f"{s[0]} {float(s[1]):,.2f}" for s in soc), wrap=True); r[0] += 1
    wb.save(f'{OUT}/FF_{mk}_MPL_Report_Oktobar_2026.xlsx')
    return {n: (round(line_sp[n], 2), f((d['acct'] or {}).get(n))) for n in line_sp}

for mk, d in DATA.items():
    print(mk, build(mk, d))
