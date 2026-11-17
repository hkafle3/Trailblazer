"""Browser check for the comet pages (comet.html?id=, comet.js) and the Comets list (comet.html), direction A
("answers first"). Needs the app up (npm run dev) with the comet facts (migration 0017) and the daily snapshot taken
(the cron; locally /__scheduled with --test-scheduled). Expected values come from GET /api/comets[/:id], never from the page.

For every known comet in the data, at 1440x900 and on a phone (390x844):
- the six answer cards each show an answer, or "needs data";
- every number on the page sits inside a block labelled measured, predicted, needs data or name (data-label), and that
  label is shown (the card's source line, or the mark after the number);
- one time-lapse link per SPHEREx visit (detail.facts.inv.visits), each naming the comet (&comet=) and pointing at a
  picture the comet's record holds (the time-lapse's own check, timelapse.html cometOf: within 5 s, same detector,
  within 2 pixels); web/tests/comet_timelapse_ui.py follows them into the time-lapse;
- the Depth tab draws the comet's path, the Sun, Earth and where the comet is now;
- no tag vote; Discuss is folded;
- images load, no page or console errors, nothing wider than the window.
The list: every known comet is listed once and links to its page; the same label, width and error checks.
A name that is not in the data says so and links back to the list.
Full-size screenshots of Bok, 235P and the list at both sizes go to the folder given as the second argument.
Run: uv run -q --with playwright python web/tests/comet_page_ui.py [base url] [screenshot folder]   (default http://127.0.0.1:8873)"""
import asyncio, math, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8873"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
ONLY = __import__("os").environ.get("ONLY")   # "depth", "zoom" or "list": run just that part
SIZES = [("desktop", dict(viewport={"width": 1440, "height": 900})),
         ("phone", dict(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True))]
SHOT_IDS = {"C/2026 A2 (Bok)": "bok", "235P/LINEAR": "235p"}
LABELS = {"measured", "predicted", "needs", "name", "fact"}
MJD0, PIX = 60789, 6.15
fails = []
slow = {"never": 0}   # pages that never set main[data-ready]: after two, the rest are read once the network is quiet


async def fullshot(pg, path):
    """A full-page screenshot that works on phones too: there <body> is the scroll box (ui.css), which full_page misses,
    so the viewport is made as tall as the page for the shot."""
    vp = pg.viewport_size
    h = await pg.evaluate("Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)")
    await pg.set_viewport_size({"width": vp["width"], "height": h}); await pg.wait_for_timeout(400)
    await pg.screenshot(path=path)
    await pg.set_viewport_size(vp); await pg.wait_for_timeout(200)


async def ready(pg, why):
    try: await pg.wait_for_function(READY, timeout=3000 if slow["never"] >= 2 else 30000); return
    except Exception: pass
    slow["never"] += 1
    check(False, f"{why}: the page never finished (main[data-ready])")
    try: await pg.wait_for_load_state("networkidle", timeout=15000)
    except Exception: pass


def check(ok, what):
    if not ok:
        fails.append(what); print("FAIL " + what, flush=True)


READY = "document.querySelector('main')?.dataset.ready === '1'"
# every text node with a digit in main: its label block, and whether that block shows its label
NUMBERS = """() => { const out = [], vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const w = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    const t = n.textContent.trim(), p = n.parentElement;
    if (!/\\d/.test(t) || !vis(p) || p.closest('script, style, .discuss, title')) continue;
    const b = p.closest('[data-label]'), shown = b && (["name", "fact"].includes(b.dataset.label) || [...b.querySelectorAll('.src, .lb')].some(vis));
    out.push({ t: t.slice(0, 60), label: b?.dataset.label ?? null, shown: !!shown });
  }
  return out; }"""
READ = """() => { const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)], vis = e => !!e && e.getClientRects().length > 0;
  return { id: $('#c-id')?.textContent.trim(), missing: vis($('.missing')) ? $('.missing').textContent : null,
    cards: $$('.answers .ans').map(a => ({ q: a.querySelector('.q')?.textContent.trim(), a: a.querySelector('.a')?.textContent.trim() ?? '',
      needs: !!a.querySelector('.needs'), kv: a.querySelectorAll('.kv dd').length })),
    visits: $$('.vstrip .v:not(.next)').length, links: $$('.vstrip .v a.lapse').map(a => a.getAttribute('href')),
    tags: $$('input[name=tag], [data-t]').length, discussOpen: $('.discuss')?.open ?? null,
    imgs: $$('main img').filter(i => i.complete && i.naturalWidth === 0 && i.getAttribute('src')).map(i => i.getAttribute('src')) }; }"""
DEPTH = """() => { const s = document.querySelector('.shot .depth .scene svg'); if (!s || !s.getClientRects().length) return null;
  const p = s.querySelector('.cpath'); return { pts: p ? p.getAttribute('points').trim().split(/\\s+/).length : 0,
    sun: !!s.querySelector('.sun'), earth: !!s.querySelector('.earth'), now: !!s.querySelector('.now') }; }"""
CLIPPED = """() => { const W = innerWidth, out = [];
  for (const e of document.querySelectorAll('main *')) { const r = e.getBoundingClientRect();
    if (r.width && r.height && getComputedStyle(e).visibility !== 'hidden' && !e.closest('.vstrip') && (r.right > W + 1 || r.left < -1)) out.push(e.id || e.className.baseVal || e.className || e.tagName); }
  return { overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - W, out: out.slice(0, 5) }; }"""


def record_shots(d):   # what timelapse.html cometOf accepts: [mjd, ra, dec, detector]
    out = [(p["mjd"], p["ra"], p["dec"], p["file"].rsplit("_", 1)[1][:2]) for p in d.get("photos") or [] if p.get("ra") is not None]
    out += [(MJD0 + s["day"], s["ra"], s["dec"], "D1") for s in d.get("spherex") or []]
    out += [(v["link"]["t"], v["link"]["ra"], v["link"]["dec"], v["link"]["det"]) for v in ((d.get("facts") or {}).get("inv") or {}).get("visits", []) if v.get("link")]
    return out


def sep(ra1, dec1, ra2, dec2):   # arcsec
    a, b = math.radians(dec1), math.radians(dec2)
    c = math.sin(a) * math.sin(b) + math.cos(a) * math.cos(b) * math.cos(math.radians(ra1 - ra2))
    return math.degrees(math.acos(max(-1, min(1, c)))) * 3600


def want_hero(d):   # a measured comet's brightest baked photo; else the visit picture with the highest SNR where SPHEREx detected it, else the first not-detected one
    if d.get("photos"):
        p = max(d["photos"], key=lambda p: p["flux"]); return f"data/comets/{d['dir']}/{p['file']}"
    vs = [v for v in ((d.get("facts") or {}).get("inv") or {}).get("visits", []) if v.get("img")]
    seen = [v for v in vs if v["verdict"] == "seen"]
    v = max(seen, key=lambda v: v["snr"]) if seen else next((v for v in vs if v["verdict"] == "faint"), vs[0] if vs else None)
    return v["img"] if v else None


def link_ok(href, cid, shots):
    q = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
    try: ra, dec, det, t, c = float(q["ra"][0]), float(q["dec"][0]), q["det"][0], float(q["t"][0]), q["comet"][0]
    except (KeyError, ValueError): return False
    return href.startswith("timelapse.html?") and c == cid and any(abs(s[0] - t) * 86400 <= 5 and s[3] == det and sep(ra, dec, s[1], s[2]) <= 2 * PIX for s in shots)


def watch(pg, allow404=False):
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and not (allow404 and "404" in m.text) and errors.append(m.text))
    return errors


async def comet_page(ctx, size, cid, c):
    why = f"{cid} ({size})"
    pg = await ctx.new_page(); errors = watch(pg)
    await pg.goto(BASE + "/comet.html?id=" + urllib.parse.quote(cid, safe=""))
    await ready(pg, why)
    await pg.wait_for_timeout(300)
    g = await pg.evaluate(READ)
    check(g["id"] == cid, f"{why}: title {g['id']!r}")
    qs = [x["q"] for x in g["cards"]]
    check(len(g["cards"]) == 6, f"{why}: {len(g['cards'])} answer cards {qs}")
    for x in g["cards"]:
        check(bool(x["a"]) or x["needs"] or x["kv"] > 0, f"{why}: card {x['q']!r} has neither an answer nor 'needs data'")
    nums = await pg.evaluate(NUMBERS)
    bad = [n for n in nums if n["label"] not in LABELS or not n["shown"]]
    check(nums and not bad, f"{why}: {len(bad)} of {len(nums)} numbers without a shown label, e.g. {bad[:3]}")
    visits = (((c.get("detail") or {}).get("facts") or {}).get("inv") or {}).get("visits")
    check(visits is not None, f"{why}: the record has no picture inventory (detail.facts.inv)")
    if visits is not None:
        check(g["visits"] == len(visits) and len(g["links"]) == len(visits), f"{why}: {g['visits']} visit cards, {len(g['links'])} links for {len(visits)} visits")
        shots = record_shots(c["detail"])
        badl = [h for h in g["links"] if not link_ok(h, cid, shots)]
        check(not badl, f"{why}: time-lapse links the time-lapse would not name as {cid}: {badl[:2]}")
    check(g["tags"] == 0, f"{why}: a tag vote shows ({g['tags']} parts)")
    check(g["discussOpen"] is False, f"{why}: Discuss is not folded ({g['discussOpen']})")
    check(not g["imgs"], f"{why}: images that did not load {g['imgs'][:3]}")
    hero = await pg.evaluate("document.getElementById('c-hero')?.getAttribute('src') ?? null")
    check(hero == want_hero(c["detail"]), f"{why}: main picture {hero}, want {want_hero(c['detail'])}")
    r = await pg.evaluate(CLIPPED)
    check(r["overflow"] <= 0 and not r["out"], f"{why}: overflow {r['overflow']} px, past the edge {r['out']}")
    if cid in SHOT_IDS and SHOTS:
        await fullshot(pg, f"{SHOTS}/{SHOT_IDS[cid]}-{size}.png")
    try:
        await pg.click("#tab-depth", timeout=3000)
        await pg.wait_for_timeout(300)
        dp = await pg.evaluate(DEPTH)
    except Exception as e: dp = str(e)[:80]
    check(isinstance(dp, dict) and dp["pts"] >= 10 and dp["sun"] and dp["earth"] and dp["now"], f"{why}: Depth path scene {dp}")
    if cid in SHOT_IDS and SHOTS and isinstance(dp, dict):
        await pg.locator(".shot").screenshot(path=f"{SHOTS}/{SHOT_IDS[cid]}-{size}-depth.png")
    check(not errors, f"{why}: page or console errors {errors[:3]}")
    await pg.close()


async def list_page(ctx, size, known, listing):
    why = f"list ({size})"
    pg = await ctx.new_page(); errors = watch(pg)
    await pg.goto(BASE + "/comet.html")
    await ready(pg, why)
    if SHOTS: await fullshot(pg, f"{SHOTS}/list-{size}.png")
    r = await pg.evaluate(CLIPPED)
    check(r["overflow"] <= 0 and not r["out"], f"{why}: overflow {r['overflow']} px, past the edge {r['out']}")
    await pg.evaluate("document.querySelectorAll('main details').forEach(d => d.open = true)")
    hrefs = await pg.evaluate("[...document.querySelectorAll('#l-all a.crow')].map(a => a.getAttribute('href'))")
    ids = sorted(urllib.parse.parse_qs(urllib.parse.urlparse(h).query).get("id", [""])[0] for h in hrefs)
    check(ids == sorted(known), f"{why}: {len(ids)} rows for {len(known)} known comets; missing {sorted(set(known) - set(ids))[:3]}")
    nums = await pg.evaluate(NUMBERS)
    bad = [n for n in nums if n["label"] not in LABELS or not n["shown"]]
    check(nums and not bad, f"{why}: {len(bad)} of {len(nums)} numbers without a shown label, e.g. {bad[:3]}")
    thumbs = dict(await pg.evaluate("[...document.querySelectorAll('#l-all a.crow')].map(a => [a.dataset.id, a.querySelector('img')?.getAttribute('src') ?? null])"))
    wrong = [i for i, t in thumbs.items() if t != listing[i].get("thumb")]
    check(not wrong, f"{why}: rows whose thumbnail is not the API's: {wrong[:3]}")
    await pg.evaluate("document.querySelectorAll('main details').forEach(d => d.open = false)")
    # search: only the matching rows show, a folded group opens when it holds a match, nothing matching says so
    shown = "[...document.querySelectorAll('#l-all a.crow')].filter(a => a.getClientRects().length).map(a => a.dataset.id)"
    for q in ("bok", "encke", "K1-"):
        await pg.fill("#l-q", q); await pg.wait_for_timeout(150)
        got = sorted(await pg.evaluate(shown)); want = sorted(i for i in known if q.lower() in i.lower())
        check(got == want, f"{why}: search {q!r} shows {got}, want {want}")
    await pg.fill("#l-q", "no such comet"); await pg.wait_for_timeout(150)
    check(await pg.is_visible("#l-none") and not await pg.evaluate(shown), f"{why}: a search with no match does not say so")
    await pg.fill("#l-q", ""); await pg.wait_for_timeout(150)
    check(len(await pg.evaluate("[...document.querySelectorAll('#l-all a.crow')].filter(a => !a.hidden)")) == len(known), f"{why}: clearing the search brings every row back")
    check(not errors, f"{why}: page or console errors {errors[:3]}")
    await pg.close()


async def depth_solution(ctx):
    """Depth never joins the daily snapshot to the baked path when they come from different JPL solutions (x.same)."""
    for soln, joined in ((None, True), ("JPL#999", False)):
        pg = await ctx.new_page(); errors = watch(pg)
        if soln:
            def other(soln):
                async def handle(route):
                    r = await route.fetch(); body = await r.json(); body["now"]["soln"] = soln
                    await route.fulfill(response=r, json=body)
                return handle
            await pg.route("**/api/comets/C%2F2026%20A2%20(Bok)", other(soln))
        await pg.goto(BASE + "/comet.html?id=" + urllib.parse.quote("C/2026 A2 (Bok)", safe=""))
        await ready(pg, "depth solution")
        await pg.click("#tab-depth"); await pg.wait_for_timeout(400)
        g = await pg.evaluate("({ sight: !!document.querySelector('.shot .depth .sight'), now: !!document.querySelector('.shot .depth .now'), src: document.getElementById('c-scene-src').textContent })")
        why = f"Depth with {'another JPL solution' if soln else 'the same solution'} in the snapshot"
        if joined: check(g["sight"] and g["now"] and "as of" in g["src"], f"{why}: {g}")
        else: check(not g["sight"] and g["now"] and "as of" not in g["src"], f"{why}: the snapshot is drawn onto the baked path {g}")
        check(not errors, f"{why}: errors {errors[:3]}")
        await pg.close()


# ---------------- Depth zoom (the time-lapse Depth view's, web/live/depth.js, mirrored on the path scene) ----------------
SCENE = """() => { const v = window.__scene?.view?.() ?? null, f = document.querySelector('.shot .depth .scene svg text');
  return { v, font: f ? getComputedStyle(f).fontSize : null, scale: visualViewport.scale, sy: scrollY + document.body.scrollTop }; }"""
# names shown in the scene that run past its edges or under the tabs or the zoom buttons
UNDER = """(() => { const sc = document.querySelector('.shot .depth .scene').getBoundingClientRect(), out = [];
  const covers = ['.shot .tabs', '.shot .dzoom'].map(s => document.querySelector(s)).filter(e => e && e.offsetWidth).map(e => e.getBoundingClientRect());
  for (const t of document.querySelectorAll('.shot .depth .scene svg text')) { const r = t.getBoundingClientRect(); if (!r.width) continue;
    if (r.left < sc.left - 1 || r.right > sc.right + 1 || r.top < sc.top - 1 || r.bottom > sc.bottom + 1) out.push(t.textContent + ' past the edge');
    for (const c of covers) if (r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top) out.push(t.textContent + ' under a control'); }
  return out; })()"""
# names that do not sit at what they name: each text's data-at lists its point (or a ring's points), and the text's box
# must come within 22 px of one of them
AWAY = """(() => { const sc = document.querySelector('.shot .depth .scene').getBoundingClientRect(), out = [];
  for (const t of document.querySelectorAll('.shot .depth .scene svg text[data-at]')) { const r = t.getBoundingClientRect();
    const d = Math.min(...t.dataset.at.split(' ').map(s => s.split(',').map(Number)).map(([x, y]) => { x += sc.left; y += sc.top;
      return Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom)); }));
    if (d > 22) out.push(`${t.textContent} ${Math.round(d)} px from it`); }
  const names = [...document.querySelectorAll('.shot .depth .scene svg text')].map(t => t.textContent);
  for (const n of ['Earth today', 'Sun']) if (!names.includes(n)) out.push(n + ' missing');
  return out; })()"""
about = lambda p, a, f: [a[0] + (p[0] - a[0]) * f, a[1] + (p[1] - a[1]) * f]
off = lambda p, q: math.hypot(p[0] - q[0], p[1] - q[1]) if p and q else 1e9


async def depth_zoom(b):
    bok = BASE + "/comet.html?id=" + urllib.parse.quote("C/2026 A2 (Bok)", safe="")
    # ---------------- desktop ----------------
    ctx = await b.new_context(viewport={"width": 1440, "height": 900}); pg = await ctx.new_page(); errors = watch(pg)
    await pg.goto(bok); await ready(pg, "zoom"); await pg.click("#tab-depth"); await pg.wait_for_timeout(400)
    st = lambda: pg.evaluate(SCENE)
    s0 = await st()
    if not s0["v"]:
        check(False, "Depth zoom: the scene has no zoom (window.__scene)"); await ctx.close(); return
    check(not await pg.evaluate(AWAY), f"Depth names at 1x sit at what they name {await pg.evaluate(AWAY)}")
    out_btn = pg.locator(".shot .dzoom [data-zoom=out]")
    check(await out_btn.count() == 1 and await out_btn.is_disabled(), "Depth zoom: -, + and Reset view controls, - disabled at 1x")
    sc = await pg.locator(".shot .depth .scene").bounding_box(); mid = [sc["x"] + sc["width"] / 2, sc["y"] + sc["height"] / 2]
    sun0 = s0["v"]["sun"]
    await pg.click(".shot .dzoom [data-zoom=in]"); s1 = await st()
    check(abs(s1["v"]["k"] - 1.5) < 1e-6 and off(s1["v"]["sun"], about(sun0, mid, 1.5)) <= 2, f"Depth zoom: + zooms 1.5x about the middle ({s1['v']['k']}, Sun {off(s1['v']['sun'], about(sun0, mid, 1.5)):.2f} px off)")
    check(not await pg.evaluate(AWAY), f"Depth names zoomed 1.5x sit at what they name {await pg.evaluate(AWAY)}")
    check(s1["font"] == s0["font"] and not await pg.evaluate(UNDER), f"Depth zoom: names keep their size ({s0['font']} -> {s1['font']}) and stay inside, clear of the controls {await pg.evaluate(UNDER)}")
    await pg.click(".shot .dzoom [data-zoom=reset]"); s2 = await st()
    check(s2["v"]["k"] == 1 and off(s2["v"]["sun"], sun0) <= 1 and await out_btn.is_disabled(), f"Depth zoom: Reset view goes back to 1x ({s2['v']})")
    # the wheel zooms toward the pointer, the page neither scrolls nor zooms
    await pg.mouse.move(*sun0); await pg.mouse.wheel(0, -300); await pg.wait_for_timeout(150); s3 = await st()
    check(s3["v"]["k"] > 1.5 and off(s3["v"]["sun"], sun0) <= 2 and s3["sy"] == s2["sy"], f"Depth zoom: the wheel zooms toward the pointer ({s3['v']['k']:.2f}x, Sun {off(s3['v']['sun'], sun0):.2f} px off, scroll {s2['sy']} -> {s3['sy']})")
    cdp = await ctx.new_cdp_session(pg)
    for _ in range(3): await cdp.send("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": sun0[0], "y": sun0[1], "deltaX": 0, "deltaY": -10, "modifiers": 2})
    await pg.wait_for_timeout(150); s4 = await st()
    check(s4["v"]["k"] > s3["v"]["k"] and s4["scale"] == 1 and off(s4["v"]["sun"], sun0) <= 2, f"Depth zoom: a trackpad pinch (ctrl wheel) zooms the view, not the page ({s4['v']['k']:.2f}x, page scale {s4['scale']})")
    # shift-drag and right-drag pan (no turn), never past the scene's edges
    a0 = s4["v"]["az"]; await pg.keyboard.down("Shift"); await pg.mouse.move(*mid); await pg.mouse.down(); await pg.mouse.move(mid[0] - 40, mid[1] - 30, steps=5); await pg.mouse.up(); await pg.keyboard.up("Shift")
    s5 = await st(); moved = [s5["v"]["sun"][0] - s4["v"]["sun"][0], s5["v"]["sun"][1] - s4["v"]["sun"][1]]
    check(s5["v"]["az"] == a0 and s5["v"]["k"] == s4["v"]["k"] and off(moved, [-40, -30]) <= 2, f"Depth zoom: shift-drag pans the zoomed view by the drag ({moved}), no turn")
    await pg.mouse.move(*mid); await pg.mouse.down(button="right"); await pg.mouse.move(mid[0] + 4000, mid[1] + 4000, steps=4); await pg.mouse.up(button="right")
    s6 = await st(); v = s6["v"]
    check(v["az"] == a0 and v["x"] >= 0 and v["y"] >= 0 and v["x"] <= v["W"] - v["W"] / v["k"] + 1e-6 and v["y"] <= v["H"] - v["H"] / v["k"] + 1e-6, f"Depth zoom: a right-drag pans only as far as the scene's edges ({v})")
    # a drag still turns, and keeps the zoom; + and - keys; Safari's gesture events
    await pg.mouse.move(*mid); await pg.mouse.down(); await pg.mouse.move(mid[0] + 60, mid[1], steps=5); await pg.mouse.up(); s7 = await st()
    check(s7["v"]["az"] != a0 and s7["v"]["k"] == s6["v"]["k"], f"Depth zoom: a drag turns the path and keeps the zoom ({a0} -> {s7['v']['az']})")
    await pg.click(".shot .dzoom [data-zoom=reset]"); await pg.focus(".shot .depth .scene"); await pg.keyboard.press("+"); s8 = await st()
    check(abs(s8["v"]["k"] - 1.5) < 1e-6 and s8["v"]["az"] == s0["v"]["az"], f"Depth zoom: Reset view undoes the turn, the + key zooms ({s8['v']})")
    await pg.keyboard.press("-"); check((await st())["v"]["k"] == 1, "Depth zoom: the - key zooms out")
    k9 = await pg.evaluate("""([x, y]) => { const s = document.querySelector('.shot .depth .scene'), ev = (t, scale) => { const e = new Event(t, { cancelable: true }); Object.assign(e, { scale, clientX: x, clientY: y }); s.dispatchEvent(e); };
      ev('gesturestart', 1); ev('gesturechange', 2); ev('gestureend', 2); return window.__scene.view().k; }""", sun0)
    check(abs(k9 - 2) < 1e-6, f"Depth zoom: Safari's trackpad pinch (gesture events) zooms ({k9}x)")
    for _ in range(12):
        if await pg.locator(".shot .dzoom [data-zoom=in]").is_disabled(): break
        await pg.click(".shot .dzoom [data-zoom=in]")
    check((await st())["v"]["k"] == 8 and await pg.locator(".shot .dzoom [data-zoom=in]").is_disabled(), "Depth zoom: at most 8x, + disabled there")
    check(not await pg.evaluate(UNDER), f"Depth zoom: at 8x the names stay inside, clear of the controls {await pg.evaluate(UNDER)}")
    check(not errors, f"Depth zoom: errors {errors[:3]}")
    await ctx.close()
    # ---------------- phone: a two-finger pinch about its midpoint ----------------
    ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True); pg = await ctx.new_page(); errors = watch(pg)
    await pg.goto(bok); await ready(pg, "zoom phone"); await pg.click("#tab-depth"); await pg.wait_for_timeout(400)
    await pg.locator(".shot").scroll_into_view_if_needed(); await pg.wait_for_timeout(200)
    st = lambda: pg.evaluate(SCENE); s0 = await st()
    if not s0["v"]:
        check(False, "Depth zoom (phone): no zoom"); await ctx.close(); return
    sc = await pg.locator(".shot .depth .scene").bounding_box(); M = [sc["x"] + sc["width"] / 2, sc["y"] + sc["height"] / 2 + 20]
    cdp = await ctx.new_cdp_session(pg)
    async def touch(kind, pts=()):
        await cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"id": i, "x": x, "y": y} for i, x, y in pts]}); await pg.wait_for_timeout(20)
    await touch("touchStart", [(0, M[0] - 30, M[1])]); await touch("touchStart", [(0, M[0] - 30, M[1]), (1, M[0] + 30, M[1])])
    for i in range(1, 9):
        d = 60 + 120 * i / 8; await touch("touchMove", [(0, M[0] - d / 2, M[1]), (1, M[0] + d / 2, M[1])])
    await touch("touchEnd"); await pg.wait_for_timeout(200); s1 = await st(); f1 = s1["v"]["k"]
    check(abs(f1 - 3) < 0.05 and off(s1["v"]["sun"], about(s0["v"]["sun"], M, f1)) <= 3 and s1["v"]["az"] == s0["v"]["az"],
          f"Depth zoom (phone): a pinch zooms {f1:.3f}x about the fingers' midpoint (Sun {off(s1['v']['sun'], about(s0['v']['sun'], M, f1)):.2f} px off), no turn")
    check(s1["scale"] == 1 and s1["sy"] == s0["sy"], f"Depth zoom (phone): the page does not zoom or scroll ({s1['scale']}, {s0['sy']} -> {s1['sy']})")
    sizes = await pg.evaluate("[...document.querySelectorAll('.shot .dzoom button')].map(b => [b.offsetWidth, b.offsetHeight])")
    check(sizes and all(w >= 44 and h >= 44 for w, h in sizes), f"Depth zoom (phone): the zoom buttons are 44 px taps {sizes}")
    check(not await pg.evaluate(UNDER), f"Depth zoom (phone): names inside, clear of the controls {await pg.evaluate(UNDER)}")
    await pg.click(".shot .dzoom [data-zoom=reset]")
    check(not await pg.evaluate(AWAY), f"Depth names on a phone at 1x sit at what they name {await pg.evaluate(AWAY)}")
    check(not errors, f"Depth zoom (phone): errors {errors[:3]}")
    await ctx.close()


async def missing(ctx):
    pg = await ctx.new_page(); errors = watch(pg, allow404=True)   # the record's 404 is the browser's own log line
    await pg.goto(BASE + "/comet.html?id=12P%2FPons-Brooks")
    await ready(pg, "missing id")
    g = await pg.evaluate(READ)
    check("not in" in (g["missing"] or "") and not g["cards"] and not errors, f"missing id: {g['id']!r}, {g['missing']!r}, {len(g['cards'])} cards {errors}")
    await pg.close()


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        api = await p.request.new_context()
        listing = {c["id"]: c for c in (await (await api.get(BASE + "/api/comets")).json())["comets"] if c["kind"] == "known"}
        known = list(listing)
        recs = {}
        for cid in known:
            recs[cid] = await (await api.get(BASE + "/api/comets/" + urllib.parse.quote(cid, safe=""))).json()
        if ONLY == "depth":   # just the solution check (quick)
            ctx = await b.new_context(viewport={"width": 1440, "height": 900}); await depth_solution(ctx); await ctx.close()
            print(f"{'FAIL' if fails else 'PASS'} Depth solution check, {len(fails)} failures"); sys.exit(1 if fails else 0)
        if ONLY == "zoom":
            await depth_zoom(b); print(f"{'FAIL' if fails else 'PASS'} Depth zoom, {len(fails)} failures"); sys.exit(1 if fails else 0)
        if ONLY == "list":
            ctx = await b.new_context(viewport={"width": 1440, "height": 900}); await list_page(ctx, "desktop", known, listing); await ctx.close()
            print(f"{'FAIL' if fails else 'PASS'} list check, {len(fails)} failures"); sys.exit(1 if fails else 0)
        for size, kw in SIZES:
            ctx = await b.new_context(**kw)
            await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
            await list_page(ctx, size, known, listing)
            for cid in known:
                await comet_page(ctx, size, cid, recs[cid])
            if size == "desktop": await missing(ctx); await depth_solution(ctx)
            await ctx.close()
        await depth_zoom(b)
        await b.close()
    print(f"{'FAIL' if fails else 'PASS'} comet pages: {len(known)} comets and the list at 1440x900 and 390x844, {len(fails)} failures")
    sys.exit(1 if fails else 0)

asyncio.run(main())
