"""The pin card a search opens (Explore, ?q=) is never under the map's controls, at any window size.
For every window from 360 to 1440 px wide and 640 to 1000 px tall (in steps, phones with touch), open /explore?q=<target>
for a sky name (Orion Nebula) and coordinates (84.0181 -6.577), wait for the page to settle, then read the real on-screen
rectangles (getBoundingClientRect):
  controls    the card's box touches none of the top bar, the search box (or the phone's search button row), Flat / 3D,
              the zoom buttons, How this map was made, Examples, Layers, the whole-sky button, the timeline (its bar, date and knob)
  window      the card is all inside the window
  tappable    "Look closer" and the close button are 44 px or more, and the page's top element at the middle of each is
              that button (nothing drawn over it)
Run: uv run -q --with playwright python web/tests/search_card_ui.py [base url]   (default http://127.0.0.1:8787)
     CARD_SIZES=750x790,390x844 runs only those windows."""
import asyncio, os, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
WIDTHS = [360, 390, 430, 520, 600, 640, 641, 700, 750, 820, 900, 1024, 1180, 1280, 1440]
HEIGHTS = [640, 700, 790, 860, 1000]
SIZES = [(w, h) for w in WIDTHS for h in HEIGHTS]
if os.environ.get("CARD_SIZES"): SIZES = [tuple(map(int, s.split("x"))) for s in os.environ["CARD_SIZES"].split(",")]
QUERIES = ["Orion%20Nebula", "84.0181%20-6.577"]
INIT = "localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.maphint', '1'); localStorage.setItem('ch.intro', '1');"
CONTROLS = ".topbar, .xsearch, .viewsw, .zoomctl, .xbtns > *, #tl, #t-date, .tl-knob"
JUDGE = """sel => { const R = e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
  const pin = document.getElementById('pin'), card = pin.querySelector('.pincard');
  if (pin.hidden || !card.offsetWidth) return ['no pin card'];
  const c = R(card), bad = [], hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  for (const e of document.querySelectorAll(sel)) {
    const o = R(e);
    if (o[2] > o[0] && o[3] > o[1] && getComputedStyle(e).visibility !== 'hidden' && hit(c, o)) bad.push(`card on ${e.id || e.className}`);
  }
  if (c[0] < 0 || c[1] < 0 || c[2] > innerWidth || c[3] > innerHeight) bad.push(`card leaves the window [${c.map(Math.round)}]`);
  for (const s of ['.btn', '.x']) {
    const b = card.querySelector(s), r = b.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (r.height < 43.5 || r.width < 43.5) bad.push(`${s} is ${Math.round(r.width)} x ${Math.round(r.height)} px`);
    if (!top || !b.contains(top)) bad.push(`${s} is covered by ${top ? top.id || top.className || top.tagName : 'nothing (off screen)'}`);
  }
  return bad; }"""
# wait until the view and the labels' layout have both been still for 400 ms
SETTLED = """async () => { const v = await import('/explore-view.js'); const key = () => [v.W, v.X, v.Y, window.skyLabels?.stats.passes].join();
  let k = key(), t = performance.now(), t0 = t;
  while (performance.now() - t < 400 && performance.now() - t0 < 8000) { await new Promise(r => setTimeout(r, 50)); if (key() !== k) { k = key(); t = performance.now(); } } }"""


async def one(b, w, h, q):
    phone = w <= 640
    ctx = await b.new_context(viewport={"width": w, "height": h}, has_touch=phone, is_mobile=phone)
    await ctx.add_init_script(INIT)
    pg = await ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    try:
        await pg.goto(f"{BASE}/explore.html?q={q}")
        await pg.wait_for_function("!document.getElementById('pin').hidden", timeout=15000)
        await pg.wait_for_timeout(300); await pg.evaluate(SETTLED)
        bad = await pg.evaluate(JUDGE, CONTROLS) + [f"page error: {e}" for e in errs]
    except Exception as e:
        bad = [f"{type(e).__name__}: {str(e).splitlines()[0]}"]
    await ctx.close()
    return bad


async def main():
    fails = []
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        gate = asyncio.Semaphore(6)
        async def run(w, h, q):
            async with gate:
                bad = await one(b, w, h, q)
            name = f"{w}x{h} ?q={q.replace('%20', ' ')}"
            print(("PASS " if not bad else "FAIL ") + name + ("" if not bad else ": " + "; ".join(bad)), flush=True)
            if bad: fails.append(name)
        await asyncio.gather(*(run(w, h, q) for w, h in SIZES for q in QUERIES))
        await b.close()
    n = len(SIZES) * len(QUERIES)
    print(f"ALL PASS ({n} windows)" if not fails else f"{len(fails)} of {n} FAILED: {sorted(fails)}"); sys.exit(1 if fails else 0)

asyncio.run(main())
