"""E11: stills of the Colors tab in the mockup's eleven states and sizes (1440x900 and 881x872 at 1x, 390x844 at 2x, as
yoshi/deliverables/space-apps-2026/colors-mockup/tools/shots.py), for a side-by-side look against the approved stills.
Needs the app up with the showcase copy C-0903 baked (bake/colors_bake.mjs). Local and preview only.
Run: uv run -q --with playwright python web/tests/colors_shots.py <base url> <out dir> [candidate id]"""
import sys, os
from playwright.sync_api import sync_playwright

BASE, OUT = sys.argv[1], sys.argv[2]
CAND = sys.argv[3] if len(sys.argv) > 3 else 'C-0903'
GLOSS = "sel => { const g = document.querySelector(sel); g.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); if (g.dataset.hl) window.__colors.setHl(g.dataset.hl); }"
STATES = {
    '01-colors-all': ('', None),
    '02-colors-sep2025': ('', "() => window.__colors.setPass(1)"),
    '03-colors-sep2026': ('', "() => window.__colors.setPass(3)"),
    '04-hover-dot': ('', "() => { const t = window.__colors.texts(); window.__colors.point(t.findIndex(s => s.startsWith('4.59'))); }"),
    '05-hover-wise2010': ('', "() => { const t = window.__colors.texts(); window.__colors.point(t.findIndex(s => s.startsWith('WISE W2'))); }"),
    '06-rise': ('', f"() => ({GLOSS})('.co-chk[data-hl=rise]')"),
    '07-dips': ('', f"() => ({GLOSS})('.co-chk[data-hl=dip]')"),
    '08-seams': ('', f"() => ({GLOSS})('.co-chk[data-hl=seam]')"),
    '09-bare-gloss': ('', f"() => ({GLOSS})('.co-key .gl')"),
    '10-then-tab': ('&tab=then', None),
    '11-how-open': ('', "() => { document.querySelector('.co-how').open = true; }"),
}
os.makedirs(OUT, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome')
    for w, h, dpr in ((1440, 900, 1), (881, 872, 1), (390, 844, 2)):
        pg = b.new_page(viewport={'width': w, 'height': h}, device_scale_factor=dpr)
        for name, (q, act) in STATES.items():
            pg.goto(f'{BASE}/candidate.html?id={CAND}{q}')
            pg.wait_for_function("() => window.__colors && (window.__colors.S.view === 'then' || document.querySelector('#co-svg circle'))", timeout=60000)
            if name == '10-then-tab': pg.wait_for_function("() => window.__blink?.state === 'ok'", timeout=120000)
            pg.wait_for_timeout(600)
            if name not in ('01-colors-all', '10-then-tab'):
                pg.evaluate("() => { const r = document.getElementById('tn').getBoundingClientRect(); if (r.bottom > innerHeight) { const t = document.getElementById('tn'); t.style.scrollMarginTop = '110px'; t.scrollIntoView({ block: 'start' }); } }")
            pg.wait_for_timeout(300)
            if act: pg.evaluate(act); pg.wait_for_timeout(350)
            pg.screenshot(path=f'{OUT}/{name}-{w}.png')
            if name in ('01-colors-all', '10-then-tab', '11-how-open'): pg.screenshot(path=f'{OUT}/{name}-{w}-full.png', full_page=True)
        pg.close()
    b.close()
print('done', OUT)
