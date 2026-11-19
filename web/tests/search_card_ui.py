"""The pin card a search opens (Explore, ?q=) is never under the map's controls, at any window size.
For every window from 360 to 1440 px wide and 640 to 1000 px tall (in steps, phones with touch), open /explore?q=<target>
for a sky name (Orion Nebula) and coordinates (84.0181 -6.577), wait for the page to settle, then read the real on-screen
rectangles (getBoundingClientRect):
  controls    the card's box touches none of the top bar, the search box (or the phone's search button row), Flat / 3D,
              the zoom buttons, How this map was made, Examples, Layers, the whole-sky button, the timeline (its bar, date and knob)
  window      the card is all inside the window
  tappable    "Look closer" and the close button are 44 px or more, and the page's top element at the middle of each is
              that button (nothing drawn over it)
  settled     the view and the layout come to rest (a glide that never stops fails)
Then the cases a fresh search does not reach: an open pin through a resize to 641 x 640 and back (the whole card again),
a click on the desktop's whole sky before any pan, and a pin closed and searched again at the same spot on a phone.
The comet cards and the names that share the placement pass are judged by labels_ui.py.
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
JUDGE = """([sel, which]) => { const R = e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
  const pin = document.getElementById('pin'), card = which ? document.querySelector(which) : pin.querySelector('.pincard');
  if (which ? card.hidden : pin.hidden || !card.offsetWidth) return ['no card'];
  const c = R(card), bad = [], hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  for (const e of document.querySelectorAll(sel)) {
    const o = R(e);
    if (o[2] > o[0] && o[3] > o[1] && getComputedStyle(e).visibility !== 'hidden' && hit(c, o)) bad.push(`card on ${e.id || e.className}`);
  }
  if (c[0] < 0 || c[1] < 0 || c[2] > innerWidth || c[3] > innerHeight) bad.push(`card leaves the window [${c.map(Math.round)}]`);
  for (const s of which ? [':scope'] : ['.btn', '.x']) {
    const b = card.querySelector(s) ?? card, r = b.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!which && (r.height < 43.5 || r.width < 43.5)) bad.push(`${s} is ${Math.round(r.width)} x ${Math.round(r.height)} px`);
    if (!top || !b.contains(top)) bad.push(`${s} is covered by ${top ? top.id || top.className || top.tagName : 'nothing (off screen)'}`);
  }
  return bad; }"""
# wait until the view and the labels' layout have both been still for 400 ms; false if they never are (a glide loop)
SETTLED = """async () => { const v = await import('/explore-view.js'); const key = () => [v.W, v.X, v.Y, window.skyLabels?.stats.passes].join();
  let k = key(), t = performance.now(), t0 = t;
  while (performance.now() - t < 400) { if (performance.now() - t0 > 8000) return false; await new Promise(r => setTimeout(r, 50)); if (key() !== k) { k = key(); t = performance.now(); } }
  return true; }"""


async def page(b, w, h, path):
    phone = w <= 640
    ctx = await b.new_context(viewport={"width": w, "height": h}, has_touch=phone, is_mobile=phone)
    await ctx.add_init_script(INIT)
    pg = await ctx.new_page()
    pg.errs = []; pg.on("pageerror", lambda e: pg.errs.append(str(e)))
    await pg.goto(f"{BASE}{path}")
    return pg


async def judge(pg):
    await pg.wait_for_timeout(300)
    bad = [] if await pg.evaluate(SETTLED) else ["the map or the layout never settled (8 s)"]
    return bad + await pg.evaluate(JUDGE, [CONTROLS, None]) + [f"page error: {e}" for e in pg.errs]


async def one(b, w, h, q):
    pg = await page(b, w, h, f"/explore.html?q={q}")
    try:
        await pg.wait_for_function("!document.getElementById('pin').hidden", timeout=15000)
        bad = await judge(pg)
    except Exception as e:
        bad = [f"{type(e).__name__}: {str(e).splitlines()[0]}"]
    await pg.context.close()
    return bad


async def judge_card(pg):
    await pg.wait_for_timeout(300)
    bad = [] if await pg.evaluate(SETTLED) else ["the map or the layout never settled (8 s)"]
    return bad + await pg.evaluate(JUDGE, [CONTROLS, "#card-comet"]) + [f"page error: {e}" for e in pg.errs]


SENTENCE = "() => getComputedStyle(document.querySelector('#pin .pincard p')).display !== 'none'"
async def scenarios(b, check):
    # an open pin, the window made small then large again: the card finds room at each size, and gets its sentence back
    pg = await page(b, 1440, 1000, "/explore.html?q=84.0181%20-6.577")
    await pg.wait_for_function("!document.getElementById('pin').hidden", timeout=15000)
    check(await judge(pg), "resize: 1440x1000 first")
    await pg.set_viewport_size({"width": 641, "height": 640})
    check(await judge(pg), "resize: the open pin, window made 641x640")
    await pg.set_viewport_size({"width": 1440, "height": 1000})
    bad = await judge(pg)
    check(bad + ([] if await pg.evaluate(SENTENCE) else ["the card did not get its sentence back"]), "resize: back to 1440x1000, the whole card")
    await pg.context.close()
    # a click on the desktop's whole sky before any pan or zoom (the engine not started yet), near the search box
    pg = await page(b, 641, 640, "/explore.html")
    await pg.wait_for_timeout(2500)
    at = await pg.evaluate("""() => { for (let y = 176; y <= 240; y += 8) for (let x = 440; x >= 200; x -= 12) {
      const e = document.elementFromPoint(x, y); if (e?.closest('#map') && !e.closest('a, .mk')) return [x, y]; } return null; }""")
    if at: await pg.mouse.click(*at)
    check(([] if at else ["no bare sky under the search box"]) + await judge(pg), f"click: 641x640 whole sky, at {at} under the search box")
    await pg.context.close()
    # the same spot again: close the pin, search the same name; the fly puts it back in the middle, the card finds room again
    pg = await page(b, 360, 640, "/explore.html?q=Orion%20Nebula")
    await pg.wait_for_function("!document.getElementById('pin').hidden", timeout=15000)
    check(await judge(pg), "again: 360x640 first search")
    await pg.tap("#pin-x"); await pg.wait_for_timeout(200)
    await pg.tap("#xs-q"); await pg.fill("#xs-q", "Orion Nebula"); await pg.wait_for_timeout(300); await pg.keyboard.press("Enter")
    await pg.wait_for_function("!document.getElementById('pin').hidden", timeout=15000)
    check(await judge(pg), "again: 360x640 closed and searched again")
    await pg.context.close()
    # near the pole on a straightened map (zoomed to 3,300 px): the glide must predict where the straightening puts the pin
    pg = await page(b, 641, 640, "/explore.html")
    await pg.wait_for_timeout(2500)
    await pg.evaluate("""async () => { (await import('/explore-desktop.js')).flyTo(0, 80, 1); const v = await import('/explore-view.js'); v.cancel(); v.flyTo(0, 80, 3300, 1); }""")
    await pg.evaluate(SETTLED)
    await pg.fill("#xs-q", "0 89"); await pg.wait_for_timeout(300); await pg.keyboard.press("Enter")
    await pg.wait_for_function("!document.getElementById('pin').hidden", timeout=15000)
    check(await judge(pg), "pole: 641x640 zoomed to 3,300 px, search 0 89")
    await pg.context.close()
    # the comet card (C-0176 from "Find on map", and the featured comet on a day link, which does not replay) shares the
    # placement: clear of the controls and the timeline, inside the window, at load and after a resize. (Where it has no
    # room at all, as for some days at 760 px, it keeps its default side: it follows its comet, so it never pans the map.)
    for w, h, path in [(1440, 900, "/explore.html?focus=C-0176&day=501"), (881, 872, "/explore.html?focus=C-0176&day=501"), (1024, 700, "/explore.html?day=330"), (881, 872, "/explore.html?day=330")]:
        pg = await page(b, w, h, path)
        await pg.wait_for_function("!document.getElementById('card-comet').hidden", timeout=15000)
        check(await judge_card(pg), f"comet card: {w}x{h} {path}")
        await pg.set_viewport_size({"width": 1180, "height": 790})
        check(await judge_card(pg), f"comet card: {w}x{h} {path}, then 1180x790")
        await pg.context.close()


async def main():
    fails = []
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        gate = asyncio.Semaphore(6)
        def check(bad, name):
            print(("PASS " if not bad else "FAIL ") + name + ("" if not bad else ": " + "; ".join(bad)), flush=True)
            if bad: fails.append(name)
        async def run(w, h, q):
            async with gate:
                bad = await one(b, w, h, q)
            check(bad, f"{w}x{h} ?q={q.replace('%20', ' ')}")
        await asyncio.gather(*(run(w, h, q) for w, h in SIZES for q in QUERIES))
        if not os.environ.get("CARD_SIZES"): await scenarios(b, check)
        await b.close()
    print("ALL PASS" if not fails else f"{len(fails)} FAILED: {sorted(fails)}"); sys.exit(1 if fails else 0)

asyncio.run(main())
