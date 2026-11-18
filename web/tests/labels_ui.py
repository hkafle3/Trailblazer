"""Sky labels on Explore (web/sky-labels.js), the plan's evaluator 2: no overlap, and always a name.
At 1440 x 900, 881 x 872 and 390 x 844 (a phone), at the whole sky and at 5, 7.5, 10, 18, 28, 40, 45, 50 and 60 px per
degree plus the deepest zoom, over Orion, a seeded random spot and the south pole. Again with the pin dropped, a card
open (C-0176's, from "Find on map"), the search list open, and on the phone the comet sheet up.
Every check reads real on-screen rectangles (getBoundingClientRect), not the layout's own arithmetic:
  overlap     no shown name touches another name or anything it must avoid: marker dots and names, the famous-object
              rings, cards, the pin, the controls (search box and list, Flat / 3D, zoom buttons, the button row, open
              panels, the phone sheet, the dive's aim) and the Milky Way text
  bounds      no name leaves the window or crosses the top bar or the timeline
  a name      at least one place name is shown (a name, the pinned constellation, or the Milky Way at the whole sky); not
              required where an opened panel covers the names (see ZOOMED below)
  card        the comet card never touches the Flat / 3D switch or the search box, at load and after a pan (the 881 px fix)
  still       C-0176 (tagged star, 1 of 1) has no trail and no tail; C-0175 (tagged unsure) keeps both
Overlaps between the page's own elements (a card over a marker) are not judged.
Run: uv run -q --with playwright python web/tests/labels_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, random, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
SIZES = [(1440, 900, 2), (881, 872, 2), (390, 844, 3)]
ZOOMS = [None, 5, 7.5, 10, 18, 28, 40, 45, 50, 60, "max"]   # px per degree; None is the whole sky
rng = random.Random(2026)
SPOTS = {"Orion": (84.0, -4.0), "random": (round(rng.uniform(0, 360), 3), round(rng.uniform(-60, 60), 3)), "south pole": (30.0, -88.5)}
INIT = "localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.maphint', '1'); localStorage.setItem('ch.intro', '1');"
GO = """async ([ra, dec, k]) => { const v = await import('/explore-view.js');
  if (!matchMedia('(max-width: 640px)').matches) (await import('/explore-desktop.js')).flyTo(ra, dec, 1);
  v.cancel(); v.flyTo(ra, dec, k === 'max' ? v.MAXW : k * 360, 1);
  await new Promise(r => setTimeout(r, 60)); return v.W / 360; }"""
WHOLE = """async () => { const v = await import('/explore-view.js'); if (v.A) { const ph = matchMedia('(max-width: 640px)').matches;
  if (ph) v.set(v.A.min, 0, (v.A.t + v.A.b) / 2 - v.A.min / 4); else v.set(v.A.min, v.A.x0, v.A.y0); } return document.querySelector('.map-wrap').offsetWidth / 360; }"""
# everything a name must keep clear of, as the page shows it now
JUDGE = """() => { skyLabels.layout();
  const R = e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
  const vis = e => !e.closest('[style*="visibility: hidden"]') && getComputedStyle(e).visibility !== 'hidden';
  const all = s => [...document.querySelectorAll(s)].filter(vis).map(e => [R(e), e]).filter(([r]) => r[2] > r[0] && r[3] > r[1]);
  const names = all('.skylabels .lb:not(.off) span, .skypin:not(.off) span').map(([r, e]) => [r, e.textContent]);
  const obst = all('#marks .mk:not([hidden]) i, #marks .mk:not([hidden]) b, #marks .mapcard:not([hidden]), #pin:not([hidden]) .pincard, #pin:not([hidden]) .pin-ring, '
    + '.skylabels .lb:not(.off) > i, .xsearch, #xs-panel:not([hidden]), .viewsw, .zoomctl, .xbtns > *, .layers[open] > .layers-body, #csheet:not([hidden]), '
    + '#dive-aim:not([hidden]) .aim-box, #dive-aim:not([hidden]) .aim-go, .grat .mw-text:not(.mw-off)').map(([r, e]) => [r, e.id || e.className?.baseVal || e.className || e.tagName]);
  const top = document.querySelector('.topbar').getBoundingClientRect().bottom, bot = document.getElementById('tl').getBoundingClientRect().top;
  const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const bad = [];
  names.forEach(([r, n], i) => {
    names.forEach(([r2, n2], j) => { if (j > i && hit(r, r2)) bad.push(`${n} on ${n2}`); });
    for (const [o, what] of obst) if (hit(r, o)) bad.push(`${n} on ${what}`);
    if (r[0] < 0 || r[2] > innerWidth || r[1] < top || r[3] > bot) bad.push(`${n} out of bounds`);
  });
  const mw = all('.grat .mw-text:not(.mw-off)').length > 0;
  return { names: names.map(([, n]) => n), bad, any: names.length > 0 || mw, k: document.querySelector('.map-wrap').offsetWidth / 360 }; }"""
CARD = """() => { const c = document.getElementById('card-comet'); if (!c || c.hidden || !c.offsetWidth) return null;
  const R = e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }, a = R(c);
  const hit = b => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  return ['.viewsw', '.xsearch'].filter(s => { const e = document.querySelector(s); return e && e.offsetWidth && hit(R(e)); }); }"""
STILL = """() => Object.fromEntries([...document.querySelectorAll('#marks .mk.comet')].map(m => [m.querySelector('b')?.textContent,
  { trail: !!m.querySelector('.trail'), tail: getComputedStyle(m, '::before').content !== 'none' }]))"""

FREE = """() => { for (const [fx, fy] of [[.42, .47], [.38, .52], [.47, .42], [.33, .45], [.52, .55], [.45, .6]]) {
  const x = innerWidth * fx, y = innerHeight * fy, e = document.elementFromPoint(x, y);
  if (e?.closest('#map') && !e.closest('.mk, a')) return [x, y]; } return null; }"""
fails = []
# a name is required in every view, except under what the person just opened: at the whole sky the pin card, the sheet
# or the search list can cover its few names (the Milky Way, the Magellanic Clouds, Andromeda), and a phone's search list
# covers the whole map. Overlap is judged in every view.
ZOOMED, NEVER = (lambda k: k is not None), (lambda k: False)
def check(ok, name, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (": " + detail if detail else ""), flush=True)
    if not ok: fails.append(name)

async def page(b, w, h, dpr, path="/explore.html?day=529"):
    phone = w <= 640
    cx = await b.new_context(viewport=dict(width=w, height=h), device_scale_factor=dpr, is_mobile=phone, has_touch=phone, reduced_motion="reduce")
    await cx.add_init_script(INIT)
    pg = await cx.new_page(); pg.errs = []
    pg.on("pageerror", lambda e: pg.errs.append(str(e)))
    await pg.goto(BASE + path); await pg.wait_for_function("document.body.dataset.ready === '1' && window.skyLabels")
    await pg.evaluate("document.fonts.ready"); await pg.wait_for_timeout(1500)
    return pg

async def sweep(pg, w, h, state, prepare=None, need=lambda k: True):
    """every zoom at every spot. need(k): whether this state must show a name at zoom k (None is the whole sky)"""
    n, bad, empty = 0, [], []
    for spot, (ra, dec) in SPOTS.items():
        for k in ZOOMS:
            if k is None and spot != "Orion": continue   # the whole sky is the same from every spot
            got = await pg.evaluate(WHOLE) if k is None else await pg.evaluate(GO, [ra, dec, k])
            if prepare: await prepare(pg)
            await pg.wait_for_timeout(350)
            j = await pg.evaluate(JUDGE); n += 1
            where = f"{spot} at {'whole sky' if k is None else k} ({j['k']:.1f} px/deg)"
            if j["bad"]: bad.append(f"{where}: {j['bad'][:3]}")
            if not j["any"] and need(k): empty.append(where)
    check(not bad, f"no overlap, {state} ({w}x{h})", f"{n} views" + (f"; {len(bad)} with overlaps, first: {bad[:2]}" if bad else ""))
    check(not empty, f"always a name, {state} ({w}x{h})", f"{n} views" + (f"; none shown at {empty[:3]}" if empty else ""))

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        for w, h, dpr in SIZES:
            phone = w <= 640
            pg = await page(b, w, h, dpr)
            if not phone:   # the card off the controls, at load and after a pan
                c0 = await pg.evaluate(CARD)
                await pg.mouse.move(w * .5, h * .5); await pg.mouse.down(); await pg.mouse.move(w * .5 - 60, h * .5 + 30, steps=6); await pg.mouse.up(); await pg.wait_for_timeout(400)
                c1 = await pg.evaluate(CARD)
                check(c0 == [] and c1 == [], f"comet card clear of Flat / 3D and the search box ({w}x{h})", f"at load {c0}, after a pan {c1}")
            st = await pg.evaluate(STILL)
            check(st.get("C-0176") == {"trail": False, "tail": False} and st.get("C-0175") == {"trail": True, "tail": True}, f"C-0176 has no trail or tail ({w}x{h})", str({k: st.get(k) for k in ("C-0175", "C-0176")}))
            await sweep(pg, w, h, "plain")
            async def pin(pg):   # a click on bare sky near the middle (not on a marker, which would open its page)
                xy = await pg.evaluate(FREE)
                if xy: await pg.mouse.click(*xy); await pg.wait_for_timeout(450)   # past the double-click window
            await sweep(pg, w, h, "pin dropped", pin, ZOOMED)
            if phone:
                await pg.evaluate("document.querySelector('#marks .mk.known:not([hidden])').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))")
                await pg.wait_for_timeout(500)
                check(await pg.evaluate("!document.getElementById('csheet').hidden"), f"comet sheet opened ({w}x{h})")
                await sweep(pg, w, h, "sheet up", None, ZOOMED)
                await pg.evaluate("document.querySelector('#csheet .sheet-x').click()"); await pg.wait_for_timeout(400)
                await pg.click("#xs-open")
            await pg.fill("#xs-q", "C-01"); await pg.wait_for_timeout(400)
            check(await pg.evaluate("!document.getElementById('xs-panel').hidden"), f"search list opened ({w}x{h})")
            await sweep(pg, w, h, "search list open", None, NEVER if phone else ZOOMED)
            check(not pg.errs, f"no page errors ({w}x{h})", str(pg.errs[:3]))
            await pg.context.close()
            pg = await page(b, w, h, dpr, "/explore.html?focus=C-0176&day=501")   # C-0176's card, as "Find on map" opens it
            check(phone or await pg.evaluate("!document.getElementById('card-comet').hidden"), f"C-0176's card open ({w}x{h})")
            await sweep(pg, w, h, "card open")
            check(not pg.errs, f"no page errors, card ({w}x{h})", str(pg.errs[:3]))
            await pg.context.close()
        await b.close()
    print("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"); sys.exit(1 if fails else 0)

asyncio.run(main())
