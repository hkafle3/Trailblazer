"""Browser checks for the Colors tab (plan.md E6, E7, E8), in Chrome, against the app with the showcase copy C-0903
(84.0181, -6.577) seeded and its Colors and blink bakes stored (local and preview only, never production).
  E6 drawn equals computed: for every result fixture (the method's own results, colors-build/states and the E5 injections)
     and every pass, each dot, error bar, the bare line and band, the fit curve and the 2000 and 2010 marks are read back
     from the SVG and must sit within half a pixel of where the result puts them; the hover texts carry the result's
     numbers; each row's icon and the big number follow the verdicts. A chart fed one fixture and checked against another
     must fail.
  E7 inconclusive states, each with its reason shown: catalogue service down (503), S3 down, a damaged stored catalogue,
     no star at the spot, under 12 comparisons, saturated, W1 mode, a poor fit, a temperature on the grid's edge, D6
     dropped (4.42 um seam inconclusive, the rest judged) and an empty spectrum.
  E8 the tabs survive the blink: Colors stays selected and keeps its pass while blink results arrive, after a band switch
     and after the blink's retry.
Run: uv run -q --with playwright python web/tests/colors_ui.py <base url> <states dir> [inject dir]"""
import json, pathlib, sys
from playwright.sync_api import sync_playwright

BASE, STATES = sys.argv[1], pathlib.Path(sys.argv[2])
INJECT = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else None
CAND, RA, DEC = 'C-0903', 84.0181, -6.577
fails = []
def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: fails.append(msg)

# the page's chart against a result: a list of differences over half a pixel (empty when the drawing matches)
CHECK = """(R) => {
  const C = window.__colors, bad = [], svg = document.querySelector('#co-svg'), d = C.drawn;
  const sx = l => d.X0 + (l - 0.75) / 4.25 * (d.X1 - d.X0), sy = v => d.Y1 - v / d.YMAX * (d.Y1 - d.Y0), near = (a, b) => Math.abs(a - b) <= 0.5;
  const p = R.passes.find(q => q.key === d.pass), B = R.bare;
  const bareAt = l => { let i = 0; while (i < B.lam.length - 2 && B.lam[i + 1] < l) i++; const f = (l - B.lam[i]) / (B.lam[i + 1] - B.lam[i]); return B.mjy[i] + Math.max(0, Math.min(1, f)) * (B.mjy[i + 1] - B.mjy[i]); };
  const dots = [...svg.querySelectorAll('circle.dot')], errs = [...svg.querySelectorAll('line.err')];
  if (dots.length !== p.lam.length) bad.push(`dots ${dots.length} of ${p.lam.length}`);
  dots.forEach((c, i) => { if (!near(+c.getAttribute('cx'), sx(p.lam[i])) || !near(+c.getAttribute('cy'), sy(p.mjy[i]))) bad.push(`dot ${i}`); });
  errs.forEach((e, i) => { const lo = sy(Math.max(0, p.mjy[i] - p.err[i])), hi = sy(Math.min(d.YMAX, p.mjy[i] + p.err[i]));
    if (!near(+e.getAttribute('y1'), lo) || !near(+e.getAttribute('y2'), hi) || !near(+e.getAttribute('x1'), sx(p.lam[i]))) bad.push(`error bar ${i}`); });
  const pts = el => el.getAttribute('points').trim().split(/\\s+/).map(s => s.split(',').map(Number));
  const bl = pts(svg.querySelector('polyline.bare'));
  if (bl.length !== B.lam.length || bl.some(([x, y], i) => !near(x, sx(B.lam[i])) || !near(y, sy(B.mjy[i])))) bad.push('bare line');
  const band = pts(svg.querySelector('polygon.bare-band')), n = B.lam.length;
  if (band.length !== 2 * n || band.slice(0, n).some(([x, y], i) => !near(y, sy(B.mjy[i] + B.spread[i]))) || band.slice(n).reverse().some(([x, y], i) => !near(y, sy(B.mjy[i] - B.spread[i])))) bad.push('bare band');
  const rise = R.fingerprints.rise.verdict === 'seen', want = p.lam.map((l, i) => [l, p.fit[i]]).filter(([l]) => l >= 2.42);
  const fl = pts(svg.querySelector('polyline.fit'));
  if (fl.length !== want.length || fl.some(([x, y], i) => !near(x, sx(want[i][0])) || !near(y, sy(want[i][1])))) bad.push('fit curve');
  if (!!svg.querySelector('polygon.extra') !== rise) bad.push('extra light area');
  if (rise) { const ex = pts(svg.querySelector('polygon.extra')), m = want.length;   // the shaded area: the fit, held at or above the bare star
    if (ex.length !== 2 * m || ex.slice(0, m).some(([x, y], i) => !near(y, sy(Math.max(want[i][1], bareAt(want[i][0])))))) bad.push('extra light shape'); }
  for (const o of R.old ?? []) {
    const m = svg.querySelector(`.old[data-band="${o.band}"]`); if (!m) { bad.push(`old ${o.band} missing`); continue; }
    const cx = m.tagName === 'rect' ? +m.getAttribute('x') + +m.getAttribute('width') / 2 : +m.getAttribute('d').match(/^M([\\d.]+) /)[1];
    const cy = m.tagName === 'rect' ? +m.getAttribute('y') + +m.getAttribute('height') / 2 : (([a, b]) => (a + b) / 2)([...m.getAttribute('d').matchAll(/L[\\d.]+ ([\\d.]+)/g)].map(x => +x[1]).filter((_, k) => k !== 1));
    if (!near(cx, sx(o.lam)) || Math.abs(cy - sy(o.mjy)) > 0.5) bad.push(`old ${o.band}`);
  }
  const T = C.texts();
  p.lam.forEach((l, i) => { if (!T[i].includes(`${p.mjy[i].toFixed(2)} ± ${p.err[i].toFixed(2)} mJy`)) bad.push(`hover ${i}`); });
  for (const r of document.querySelectorAll('.co-chk')) { const v = R.fingerprints[r.dataset.hl].verdict, ic = r.querySelector('svg.ok').getAttribute('aria-label');
    if (r.dataset.v !== v || ic !== v) bad.push(`row ${r.dataset.hl} ${ic} for ${v}`);
    if (v === 'inconclusive' && !r.dataset.g.includes(R.fingerprints[r.dataset.hl].reason)) bad.push(`row ${r.dataset.hl} reason`); }
  const big = document.querySelector('#co-big b')?.textContent ?? '', k = R.fits[d.pass];
  const own = k && k.chi2_star_dust / k.dof_star_dust <= 3 && k.chi2_star - k.chi2_star_dust >= 25 && k.b >= 5 * k.b_err && k.T > 200 && k.T < 2500, shownT = R.fingerprints.temperature.verdict === 'seen' && (d.pass === 'all' || own);
  if (shownT ? big !== `${k.T} K` : /K$/.test(big)) bad.push(`big number ${big}`);
  if (!/^\\d/.test(String(R.comparisons.n)) || !document.querySelector('.co-key .gl').dataset.g.startsWith(`What this star gives off on its own: ${R.comparisons.n} stars`)) bad.push('comparison count');
  return bad;
}"""

def open_with(b, result=None, w=1440, h=900, routes=(), query='&tab=colors'):
    ctx = b.new_context(viewport={'width': w, 'height': h})
    if result is not None:
        body = json.dumps({**result, 'ra': RA, 'dec': DEC})
        ctx.route('**/api/colors?**', lambda r: r.fulfill(status=200, content_type='application/json', body=body))
    for pat, fn in routes: ctx.route(pat, fn)
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'{BASE}/candidate.html?id={CAND}{query}')
    pg.wait_for_function("() => window.__colors", timeout=60000)
    return ctx, pg, errs

def wait_result(pg, timeout=60000):
    pg.wait_for_function("() => window.__colors.S.state === 'result'", timeout=timeout); pg.wait_for_timeout(300)

with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome')
    # ---------- E6 ----------
    fixtures = {f.stem: json.loads(f.read_text()) for f in sorted(STATES.glob('*.json'))}
    if INJECT: fixtures.update({f.stem: json.loads(f.read_text()) for f in sorted(INJECT.glob('*.json'))})
    charted = {k: v for k, v in fixtures.items() if any(q['key'] == 'all' and q['lam'] for q in v.get('passes') or [])}
    for name, R in charted.items():
        for w in (1440, 390):
            ctx, pg, errs = open_with(b, R, w=w, h=900)
            wait_result(pg)
            n = pg.evaluate("() => document.querySelectorAll('.co-seg button').length")
            npass = len([q for q in R['passes'] if q['key'] != 'all' and q['lam']])
            check(n == (npass + 1 if npass > 1 else 1), f'E6 {name} {w}: {n} pass buttons for {npass} passes')
            for i in range(n):
                pg.evaluate(f'() => window.__colors.setPass({i})')
                bad = pg.evaluate(CHECK, R)
                check(not bad, f'E6 {name} {w} pass {i} ({pg.evaluate("() => window.__colors.drawn.pass")}) drawn equals computed' + (f': {bad[:6]}' if bad else ''))
            check(not errs, f'E6 {name} {w}: no page errors {errs[:2]}')
            ctx.close()
    # the bright star goes past the mockup's 12 mJy axis and the scale follows it
    if 'bright' in charted:
        ctx, pg, _ = open_with(b, charted['bright']); wait_result(pg)
        top = pg.evaluate('() => window.__colors.drawn.YMAX'); check(top > 12, f'E6 bright star: axis top {top} mJy, above 12')
        ctx.close()
    # a chart fed one fixture, checked against another, must fail
    pairs = [('three_pass', 'bright'), ('three_pass', 'inject_700_k_dust_at_half_the_star_at_4_6_um'), ('one_pass', 'two_pass')]
    for a, c in pairs:
        if a in charted and c in charted:
            ctx, pg, _ = open_with(b, charted[a]); wait_result(pg)
            bad = pg.evaluate(CHECK, charted[c]); check(len(bad) > 0, f'E6 mutation: {a} drawn, checked against {c}, fails ({len(bad)} differences)')
            ctx.close()
    # ---------- E7: states from the method's results ----------
    want = {'under12': 'clean comparison stars, 12 needed', 'empty': 'SPHEREx measured no colours of this star', 'saturated': 'too bright, saturated in'}
    for name, text in want.items():
        if name not in fixtures: check(False, f'E7 {name}: fixture missing'); continue
        ctx, pg, _ = open_with(b, fixtures[name]); wait_result(pg)
        shown = pg.inner_text('#tn-colors'); check(text.lower() in shown.lower() and 'Inconclusive' in shown, f'E7 {name}: "{text}" shown')
        ctx.close()
    rowwise = {'w1_mode': ('rise', 'no clean 2MASS Ks'), 'poor_fit': ('spike', 'the best fit misses the colours'), 'grid_edge': ('rise', None), 'd6_dropped': ('seam', 'too few colours on both sides of 4.42 um')}
    for name, (row, text) in rowwise.items():
        if name not in fixtures: check(False, f'E7 {name}: fixture missing'); continue
        R = fixtures[name]; ctx, pg, _ = open_with(b, R); wait_result(pg)
        g = pg.get_attribute(f'.co-chk[data-hl={row}]', 'data-g') or ''
        if name == 'grid_edge':
            t = R['fingerprints']['temperature']; check(t['verdict'] == 'inconclusive' and 'edge' in t['reason'] and 'edge of the 200 to 2500 K grid' in pg.inner_text('#co-near'), f'E7 grid_edge: temperature "{t["reason"]}" shown')
        else: check(text in g and pg.get_attribute(f'.co-chk[data-hl={row}] svg.ok', 'aria-label') == 'inconclusive', f'E7 {name}: {row} inconclusive, "{text}" in its card')
        if name == 'd6_dropped': check(all(R['fingerprints'][k]['verdict'] != 'inconclusive' for k in ('rise', 'spike', 'dip')), 'E7 d6_dropped: the rest judged')
        ctx.close()
    # ---------- E7: archives down, damaged and empty catalogues, through the live build ----------
    none = ('**/api/colors?**', lambda r: r.fulfill(status=404, content_type='application/json', body='{"error":"none"}'))
    def live(routes, text, label, timeout=180000):
        ctx, pg, _ = open_with(b, None, routes=[none, *routes])
        pg.wait_for_selector('[data-start]:not([disabled])', timeout=60000); pg.click('[data-start]')
        wait_result(pg, timeout); shown = pg.inner_text('#tn-colors'); check(text.lower() in shown.lower(), f'E7 {label}: "{text}" shown' + ('' if text in shown else f' (got: {shown[:160]!r})'))
        ctx.close()
    live([('**/api/cat?**', lambda r: r.fulfill(status=503, content_type='application/json', body='{"error":"catalogue unavailable"}'))], 'is not answering', 'catalogue service down (503)')
    live([('https://nasa-irsa-spherex.s3.amazonaws.com/**', lambda r: r.abort())], "NASA's SPHEREx archive (S3) is not answering", 'S3 down')
    def gaia_damaged(r):
        if 'cat=gaia' in r.request.url: r.fulfill(status=200, content_type='text/csv', body='source_id,ra,dec,pmra,pmdec,phot_g_mean_mag\n1,84.0,-6.5,0,0,15\n')
        else: r.continue_()
    live([('**/api/cat?**', gaia_damaged)], 'the stored catalogue of this spot is damaged (the gaia catalogue lacks phot_variable_flag)', 'damaged stored catalogue')
    def far_only(r):
        u = r.request.url
        if 'cat=catwise' in u or 'cat=allwise' in u:
            resp = r.fetch(); lines = resp.text().split('\n'); head, rows = lines[0], [l for l in lines[1:] if l]
            ra_i = head.split(',').index('ra'); keep = [l for l in rows if abs(float(l.split(',')[ra_i]) - RA) > 0.01]
            r.fulfill(status=200, content_type='text/csv', body='\n'.join([head, *keep]) + '\n')
        else: r.continue_()
    live([('**/api/cat?**', far_only)], 'no catalogued star within 2 arcsec of this spot', 'no star at the spot')
    # ---------- E8 ----------
    ctx, pg, errs = open_with(b, None, query='&tab=then')   # the real bake; the blink arrives from its own bake
    pg.click('#co-h'); wait_result(pg); pg.evaluate('() => window.__colors.setPass(2)')
    pg.wait_for_function("() => window.__blink?.state === 'ok'", timeout=120000); pg.wait_for_timeout(500)
    state = lambda: pg.evaluate("() => ({ view: window.__colors.S.view, sel: document.querySelector('#co-h').getAttribute('aria-selected'), shown: !document.querySelector('#tn-colors').hidden, chart: !!document.querySelector('#co-svg circle'), pass: window.__colors.drawn?.pass, tabs: document.querySelectorAll('.tn-tab').length })")
    s = state(); check(s['view'] == 'colors' and s['sel'] == 'true' and s['shown'] and s['chart'] and s['pass'] == '1' and s['tabs'] == 2, f'E8 blink results arrived while on Colors: {s}')
    pg.click('#tn-h'); pg.click('[data-band=Ks]'); pg.wait_for_timeout(500); pg.click('#co-h'); pg.wait_for_timeout(300)
    s = state(); check(s['view'] == 'colors' and s['chart'] and s['pass'] == '1' and s['tabs'] == 2, f'E8 after a band switch: {s}')
    ctx.close()
    down = ('**/api/oldsky**', lambda r: r.fulfill(status=503, content_type='application/json', body='{"error":"older survey unavailable"}'))
    blink_none = ('**/api/blink?**', lambda r: r.fulfill(status=404, content_type='application/json', body='{"error":"none"}'))
    ctx, pg, errs = open_with(b, None, query='&tab=then', routes=[down, blink_none])
    pg.wait_for_selector('[data-retry]', timeout=180000); pg.click('#co-h'); pg.wait_for_timeout(300); pg.evaluate('() => window.__colors.setPass(2)')
    pg.click('#tn-h'); pg.click('[data-retry]'); pg.wait_for_timeout(1500); pg.click('#co-h'); pg.wait_for_timeout(300)
    s = state(); check(s['view'] == 'colors' and s['chart'] and s['pass'] == '1' and s['tabs'] == 2, f'E8 after the blink retry: {s}')
    check(not errs, f'E8 no page errors {errs[:2]}')
    ctx.close()
    b.close()
print(f'{len(fails)} failed' if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
