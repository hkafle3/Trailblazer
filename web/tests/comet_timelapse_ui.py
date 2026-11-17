"""Browser check for a comet page's "Open in time-lapse" (comet.js player()). Needs the app up and the network (IRSA, NASA's
S3 copy of SPHEREx, Gaia through /api/depth); takes a few minutes.
Run: uv run -q --with playwright python web/tests/comet_timelapse_ui.py [base url] [screenshot folder]   (default http://127.0.0.1:8787)
On a measured comet (C/2026 A2 (Bok), baked photos) and a catalog-only one (C/2024 J3 (ATLAS), live photos), at 1440x900
and on a phone (390x844):
- the control sits under the photo player, visible;
- its link carries the photo on screen: the comet's position then (a measured photo's own ra, dec and the detector in its
  file name; a catalog visit's middle exposure, on D1), and its time;
- stepping the timeline moves the link to the next photo;
- following it opens the time-lapse on that exposure, the white ring within 2 px of the comet's position for it;
- the Depth tab draws its beam (a canvas that is not blank);
- no page or console errors."""
import asyncio, math, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
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


def visit_picks(shots):   # live/cutout.js visitShots: photos under 5 days apart are one visit; its middle exposure
    vs = []
    for i, s in enumerate(shots):
        if i == 0 or s["day"] - shots[i - 1]["day"] >= 5: vs.append([])
        vs[-1].append(s)
    return [v[(len(v) - 1) // 2] for v in vs]


def expected(detail):   # what each photo in the player's order should link to: ra, dec, detector, MJD
    if detail.get("photos"):
        return [(p.get("ra"), p.get("dec"), p["file"].rsplit("_", 1)[1][:2], p["mjd"]) for p in sorted(detail["photos"], key=lambda p: p["mjd"])]
    return [(s["ra"], s["dec"], "D1", MJD0 + s["day"]) for s in visit_picks(detail["spherex"])]


def parse(href):
    q = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
    return float(q["ra"][0]), float(q["dec"][0]), q["det"][0], float(q["t"][0])


same = lambda h, e: h[2] == e[2] and all(abs(x - y) < 1e-4 for x, y in zip(h[:2] + h[3:], e[:2] + e[3:]))


async def run(b, cid, size, kw):
    tag = f"{cid}, {size}"
    ctx = await b.new_context(reduced_motion="reduce", **kw)   # reduced motion: the player starts paused, so the photo holds
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.adv', '1') } catch {}")
    pg = await ctx.new_page(); errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
    detail = (await (await ctx.request.get(BASE + "/api/comets/" + urllib.parse.quote(cid, safe=""))).json())["detail"]
    want = expected(detail)
    if detail.get("photos"):   # every measured photo carries the comet's place on it (bake/photo_positions.py)
        check(all(p.get("ra") is not None for p in detail["photos"]), f"{tag}: all {len(detail['photos'])} photos carry the comet's position")
    await pg.goto(f"{BASE}/comet.html?id=" + urllib.parse.quote(cid, safe=""))
    await pg.wait_for_selector("#c-photos-panel:not([hidden])")
    await pg.locator("#c-photos-panel").scroll_into_view_if_needed()
    await pg.wait_for_function("document.querySelector('.player')?.dataset.i != null", timeout=240000)   # a photo is on screen
    link = pg.locator(".player a.lapse")
    if not await link.count():
        check(False, f"{tag}: an 'Open in time-lapse' control under the photo player"); await ctx.close(); return
    await link.evaluate("e => e.scrollIntoView({ block: 'center' })")
    box = await link.bounding_box()
    check(await link.is_visible() and box["height"] >= 44 and "Open in time-lapse" in await link.inner_text(),
          f"{tag}: the control is shown under the player, {box['width']:.0f}x{box['height']:.0f} px")
    if SHOTS: await pg.screenshot(path=f"{SHOTS}/{'bok' if cid == BOK else 'j3'}-{size}.png")
    i = int(await pg.evaluate("document.querySelector('.player').dataset.i"))
    h = parse(await link.get_attribute("href"))
    check(same(h, want[i]), f"{tag}: the link carries photo {i + 1}'s place, detector and time {h} (want {want[i]})")
    knob = pg.locator(".player .tl-knob"); await knob.focus(); await knob.press("ArrowRight"); await pg.wait_for_timeout(200)
    j = int(await pg.evaluate("document.querySelector('.player').dataset.i"))
    h = parse(await link.get_attribute("href"))
    check(j != i and same(h, want[j]), f"{tag}: stepping the timeline moves the link to photo {j + 1} {h}")
    await link.click()
    await pg.wait_for_url("**/timelapse*")
    await pg.wait_for_function(READY, timeout=240000); await pg.wait_for_timeout(800)
    r = await pg.evaluate(RING, [h[0], h[1]])
    off = math.dist(r["ring"], r["at"]) if r["ring"] else None
    check(r["at_t"] and r["ringed"] and r["white"] >= 6 and off is not None and off <= 2,
          f"{tag}: the time-lapse opens on that exposure, ring {off if off is None else round(off, 2)} px from the comet ({r})")
    await pg.click("#tab-depth")
    lit = 0
    for _ in range(60):
        lit = await pg.evaluate(BEAM)
        if lit > 50: break
        await pg.wait_for_timeout(500)
    check(lit > 50, f"{tag}: Depth draws its beam ({lit} lit pixels)")
    check(not errors, f"{tag}: no page or console errors {errors}")
    await ctx.close()


SHOTS = sys.argv[2] if len(sys.argv) > 2 else None   # a folder for a screenshot of the control on each page and size


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        for cid in (BOK, J3):
            for size, kw in SIZES:
                await run(b, cid, size, kw)
        await b.close()
    print(f"\n{'FAIL' if fails else 'PASS'}: {len(fails)} failed" + (f": {fails}" if fails else ""))
    sys.exit(1 if fails else 0)

asyncio.run(main())
