"""Browser check for a comet page's time-lapse links (comet.js strip(): one per SPHEREx visit). Needs the app up and the
network (NASA's S3 copy of SPHEREx, Gaia through /api/depth); takes a few minutes.
Run: uv run -q --with playwright python web/tests/comet_timelapse_ui.py [base url] [screenshot folder]   (default http://127.0.0.1:8873)
On a measured comet (C/2026 A2 (Bok), baked photos) and a catalog-only one (C/2024 J3 (ATLAS)), at 1440x900 and on a
phone (390x844):
- one link per visit, each showing, each carrying that visit's picture from the comet's record (detail.facts.inv.visits:
  the comet's position on it, its detector, its time) and the comet's name;
- following the last visit's link opens the time-lapse on that exposure, the white ring within 2 px of the comet's
  position for it;
- the time-lapse names the dot as that comet (the identity rule, 2 px, from the link's place, not SkyBoT's, which is
  60 arcsec off for C/2026 A2), says it is already known, and does not invite a report of a new find; the panel title is
  the comet's name, and the verdict opens with the comet, not a star-style motion line;
- the Depth tab draws its beam (a canvas that is not blank);
- &comet= is only a hint: a made-up name, a real comet at the wrong spot or the wrong time, or its record not loading
  leaves an ordinary view (no comet title, nothing named); without &comet= the view is ordinary; in the linked
  comet's other visits the title stays and the verdict says the comet is in the middle in its own visit only;
- no page or console errors."""
import asyncio, math, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8873"
BOK, J3, MJD0 = "C/2026 A2 (Bok)", "C/2024 J3 (ATLAS)", 60789
SIZES = [("desktop", dict(viewport={"width": 1440, "height": 900})),
         ("phone", dict(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True))]
READY = "+document.getElementById('play')?.getAttribute('aria-valuemax') > 0 && !!window.__lapse?.state.m"
BEAM = "(() => { const c = document.querySelector('#depth3d canvas'); if (!c || !c.width) return 0; const t = document.createElement('canvas'); t.width = 200; t.height = 120; const g = t.getContext('2d'); g.drawImage(c, 0, 0, 200, 120); const d = g.getImageData(0, 0, 200, 120).data; let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 60) lit++; return lit; })()"
# the ring as drawn (timelapse.html predPx) and the comet's spot, both in canvas pixels; the spot from the link's ra, dec
# against the patch centre, 'east' along RA times cos(Dec), as the page's frames are laid out (RA grows to the left)
RING = """([ra, dec]) => { const s = __lapse.state, m = s.m, f = m.frames[s.i], v = __lapse.view(), G = m.grid, a = m.arcsec_per_pixel, W = patch.width, H = patch.height;
  const px = (e, n) => { const x = (G - 1) / 2 - e / a, y = (G - 1) / 2 + n / a; return [(x - v.ox + 0.5) * W / v.cw, (G - 1 - y - v.oy + 0.5) * H / v.ch]; };
  const e = ((((ra - m.ra) % 360) + 540) % 360 - 180) * Math.cos(dec * Math.PI / 180) * 3600, n = (dec - m.dec) * 3600;
  const ring = f.pred_east == null ? null : px(f.pred_east, f.pred_north), at = px(e, n), g = patch.getContext('2d');
  const white = ring ? [0, 1, 2, 3, 4, 5, 6, 7].filter(k => { const t = k * Math.PI / 4, d = g.getImageData(Math.round(ring[0] + 15 * Math.cos(t)), Math.round(ring[1] + 15 * Math.sin(t)), 1, 1).data; return Math.min(d[0], d[1], d[2]) > 200; }).length : 0;
  return { ring, at, white, at_t: !!f.at_t, ringed: document.body.classList.contains('ringed') }; }"""
fails = []


def check(ok, what):
    print(("PASS " if ok else "FAIL ") + what)
    if not ok: fails.append(what)


def expected(detail):   # each visit's link in the record: ra, dec, detector, MJD
    return [(v["link"]["ra"], v["link"]["dec"], v["link"]["det"], v["link"]["t"]) for v in detail["facts"]["inv"]["visits"]]


def parse(href):
    q = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
    return float(q["ra"][0]), float(q["dec"][0]), q["det"][0], float(q["t"][0]), q.get("comet", [None])[0]


same = lambda h, e: h[2] == e[2] and all(abs(x - y) < 1e-4 for x, y in zip(h[:2] + h[3:4], e[:2] + e[3:4]))


async def run(b, cid, size, kw):
    tag = f"{cid}, {size}"
    ctx = await b.new_context(reduced_motion="reduce", **kw)   # reduced motion: the player starts paused, so the photo holds
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.adv', '1') } catch {}")
    pg = await ctx.new_page(); errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
    detail = (await (await ctx.request.get(BASE + "/api/comets/" + urllib.parse.quote(cid, safe=""))).json())["detail"]
    want = expected(detail)
    await pg.goto(f"{BASE}/comet.html?id=" + urllib.parse.quote(cid, safe=""))
    await pg.wait_for_function("document.querySelector('main')?.dataset.ready === '1'", timeout=60000)
    links = pg.locator(".vstrip .v a.lapse")
    n = await links.count()
    check(n == len(want) and n > 0, f"{tag}: {n} time-lapse links for {len(want)} visits")
    if not n: await ctx.close(); return
    hrefs = [parse(await links.nth(k).get_attribute("href")) for k in range(n)]
    bad = [k for k, h in enumerate(hrefs) if not (same(h, want[k]) and h[4] == cid)]
    check(not bad, f"{tag}: every link carries its visit's picture and the comet's name (wrong: {bad})")
    link = links.nth(n - 1)
    await link.scroll_into_view_if_needed()
    box = await link.bounding_box()
    check(await link.is_visible() and box and box["height"] >= 12 and "Time-lapse" in await link.inner_text(), f"{tag}: the last visit's link shows ({box})")
    if SHOTS: await pg.screenshot(path=f"{SHOTS}/{'bok' if cid == BOK else 'j3'}-{size}.png")
    h = hrefs[n - 1]
    await link.click()
    await pg.wait_for_url("**/timelapse*")
    await pg.wait_for_function(READY, timeout=240000); await pg.wait_for_timeout(800)
    r = await pg.evaluate(RING, [h[0], h[1]])
    off = math.dist(r["ring"], r["at"]) if r["ring"] else None
    check(r["at_t"] and r["ringed"] and r["white"] >= 6 and off is not None and off <= 2,
          f"{tag}: the time-lapse opens on that exposure, ring {off if off is None else round(off, 2)} px from the comet ({r})")
    # what the page says about the dot, once SkyBoT has answered for every exposure (or after 2 minutes)
    try: await pg.wait_for_function("(t => t && !/checking/i.test(t))(document.getElementById('vKnown')?.textContent)", timeout=120000)
    except Exception: pass
    say, note, title = await pg.evaluate("['pv-say', 'state-note', 'pv-name'].map(i => document.getElementById(i).textContent.trim())")
    names = (cid, cid.split(" (")[0])   # the page's id, or SkyBoT's name for it (C/2026 A2)
    check(any(f"The dot in the middle matches the known comet {n}." in say for n in names) and "too far to be it" not in say
          and "already known, so there is nothing to report" in note and "Tells other hunters" not in note,
          f"{tag}: the time-lapse names the dot as the comet, already known, no report invitation: '{say}' / '{note}'")
    check(title == cid, f"{tag}: the panel title is the comet's name ('{title}')")
    check(say.startswith("The dot in the middle matches the known comet") and "arcseconds a year" not in say and "No motion measured" not in say,
          f"{tag}: the verdict opens with the comet, no star-style motion line ('{say}')")
    await pg.click("#tab-depth")
    lit = 0
    for _ in range(60):
        lit = await pg.evaluate(BEAM)
        if lit > 50: break
        await pg.wait_for_timeout(500)
    check(lit > 50, f"{tag}: Depth draws its beam ({lit} lit pixels)")
    check(not errors, f"{tag}: no page or console errors {errors}")
    await ctx.close()


# &comet= checks on the time-lapse alone (desktop): the address, then what must hold. Bok's 29 Sep 2026 D5 photo and
# C/2024 J3's Sep 2026 visit, as their pages link them (comet_timelapse_ui's own runs above check those links)
BOK_Q, J3_Q, BOK_ID = "ra=269.0113&dec=69.1596&det=D5&t=61312.8036", "ra=276.8868&dec=42.5785&det=D1&t=61303.3769", urllib.parse.quote(BOK, safe="")
HINTS = [   # name, address, route /api/comets/* to fail, step the timeline back one visit, the title it must show
    ("made-up name at Bok's photo", f"{BOK_Q}&comet=Definitely%20not%20a%20real%20comet", False, False, "Sky spot"),
    ("Bok's name at J3's spot", f"{J3_Q}&comet={BOK_ID}", False, False, "Sky spot"),
    ("Bok's name and spot, 4 minutes off its photo", f"ra=269.0113&dec=69.1596&det=D5&t=61312.8066&comet={BOK_ID}", False, False, "Sky spot"),
    ("Bok's link with its record not loading", f"{BOK_Q}&comet={BOK_ID}", True, False, "Sky spot"),
    ("Bok's link without &comet=", BOK_Q, False, False, "Sky spot"),
    ("Bok's link, another visit", f"{BOK_Q}&comet={BOK_ID}", False, True, BOK),
]


async def hints(b):
    for name, q, fail, step, title in HINTS:
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.adv', '1') } catch {}")
        pg = await ctx.new_page(); errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        # the browser logs the record's refusal itself (404 for a made-up name, 503 when made to fail): expected here
        pg.on("console", lambda m: m.type == "error" and not any(f"status of {c}" in m.text for c in (404, 503)) and errors.append(m.text))
        if fail: await pg.route("**/api/comets/**", lambda r: r.fulfill(status=503, body='{"error":"down"}', content_type="application/json"))
        await pg.goto(f"{BASE}/timelapse.html?{q}"); await pg.wait_for_function(READY, timeout=240000)
        if step: await pg.focus("#play"); await pg.keyboard.press("ArrowLeft")
        try: await pg.wait_for_function("(t => t && !/checking/i.test(t))(document.getElementById('vKnown')?.textContent)", timeout=120000)
        except Exception: pass
        await pg.wait_for_timeout(1000)
        at_t, t, say, note = await pg.evaluate("[!!__lapse.state.m.frames[__lapse.state.i].at_t, ...['pv-name', 'pv-say', 'state-note'].map(i => document.getElementById(i).textContent.trim())]")
        named = "matches the known comet" in say or "already known" in note
        if step: ok = t == title and not at_t and not named and "is in the middle only in the Sep 2026 visit its page opened" in say
        else: ok = t == title and not named and "Definitely" not in t + say + note and "C/2026 A2 (Bok)" not in say + note and (at_t or "J3" in name)
        check(ok and not errors, f"&comet= {name}: title '{t}', linked exposure on screen {at_t}, '{say}' / '{note}' {errors}")
        await ctx.close()


SHOTS = sys.argv[2] if len(sys.argv) > 2 else None   # a folder for a screenshot of the control on each page and size


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        await hints(b)
        for cid in (BOK, J3):
            for size, kw in SIZES:
                await run(b, cid, size, kw)
        await b.close()
    print(f"\n{'FAIL' if fails else 'PASS'}: {len(fails)} failed" + (f": {fails}" if fails else ""))
    sys.exit(1 if fails else 0)

asyncio.run(main())
