"""E10, the live build's budget, in Chrome on this laptop: a cold Colors build of the quiet star (C-0904, SPOT2's
J134605.51+113824.8) from opening the tab to the result, at most 120 s and 1.1 GB read, and no main-thread task over
50 ms (PerformanceObserver 'longtask'). The browser cache is empty (a new context). Local and preview only.
Run: uv run -q --with playwright python web/tests/colors_budget.py <base url> [candidate id]"""
import sys, time
from playwright.sync_api import sync_playwright
BASE = sys.argv[1]; CAND = sys.argv[2] if len(sys.argv) > 2 else 'C-0904'
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome'); ctx = b.new_context(viewport={'width': 1440, 'height': 900}); pg = ctx.new_page()
    pg.add_init_script("window.__long = []; new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: true });")
    pg.goto(f'{BASE}/candidate.html?id={CAND}'); pg.wait_for_function('() => window.__colors', timeout=60000); pg.wait_for_timeout(1500)
    pg.evaluate('() => { window.__long.length = 0; }')
    pg.click('#co-h'); pg.wait_for_selector('[data-start]:not([disabled])', timeout=120000)
    est = pg.evaluate('() => window.__colors.S.est'); t0 = time.time(); pg.click('[data-start]')
    pg.wait_for_function("() => window.__colors.S.state === 'result'", timeout=600000, polling=500); secs = time.time() - t0
    r = pg.evaluate('() => ({ state: window.__colors.S.result.state, reason: window.__colors.S.result.reason, bytes: window.__colors.S.prog?.bytes, rows: Object.fromEntries(Object.entries(window.__colors.S.result.fingerprints || {}).map(([k, v]) => [k, v.verdict])), long: window.__long.slice() })')
    b.close()
gb, worst = (r['bytes'] or 0) / 1e9, max(r['long'] or [0])
print(f"estimate shown: {est['exposures']} pictures, about {est['bytes'] / 1e9:.1f} GB")
print(f"{'PASS' if secs <= 120 else 'FAIL'} time {secs:.0f} s (120 s at most)")
print(f"{'PASS' if gb <= 1.1 else 'FAIL'} read {gb:.2f} GB (1.1 GB at most)")
print(f"{'PASS' if worst <= 50 else 'FAIL'} longest main-thread task {worst:.0f} ms (50 ms at most), {len(r['long'])} long tasks")
print('result', r['state'], r['reason'], r['rows'])
sys.exit(0 if secs <= 120 and gb <= 1.1 and worst <= 50 and r['state'] == 'ok' else 1)
