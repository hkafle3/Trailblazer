"""Browser check for re-centring the time-lapse: click a spot, drag the photo, arrow keys. Needs the app up (npm run dev)
and the network (IRSA, NASA's S3 copy of SPHEREx); takes a few minutes on a slow IRSA day.
Run: uv run -q --with playwright python web/tests/recenter_ui.py [base url]   (default http://127.0.0.1:8787)
Starts live 1.5 arcmin north of Barnard's Star (after a failed wavelength-map download, which must not stick), clicks
the star, then nudges, drags, taps, drags with two fingers, cancels a drag, switches detector during a key move, fails
a re-centre on purpose, and finally moves 4 degrees away, out of the listed images. Precision is 1 SPHEREx pixel
(6.15 arcsec); the photo's grid is 5 arcsec per pixel. Throughout, the photo, the URL and the box must name one spot."""
import asyncio, math, os, sys, time, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
PIXEL = 6.15   # arcsec, one SPHEREx pixel
D2R = math.pi / 180
# Barnard's Star, Gaia DR3 4472832130942575872 at epoch 2016.0 (what /api/gaia answers): ra, dec in degrees, mas/yr
BARNARD = (269.44850252544, 4.73942005111, -801.551, 10362.394)
START = (269.4463, 4.7922)   # 1.5 arcmin north of where the star is in SPHEREx's first visit (Aug 2025)
fails = []


def check(ok, msg):
    print(("PASS " if ok else "FAIL ") + msg)
    if not ok: fails.append(msg)


def star_at(year):
    ra, dec, pmra, pmdec = BARNARD; dt = year - 2016
    return ra + pmra / 1000 * dt / 3600 / math.cos(dec * D2R), dec + pmdec / 1000 * dt / 3600


def sep(a, b):   # arcsec between two (ra, dec) in degrees
    (r1, d1), (r2, d2) = [(x * D2R, y * D2R) for x, y in (a, b)]
    h = math.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((r2 - r1) / 2) ** 2
    return 2 * math.asin(math.sqrt(h)) / D2R * 3600


def deproject(c, east, north):   # gnomonic: the point east, north arcsec from centre c on the tangent plane
    x, y, a0, d0 = east / 3600 * D2R, north / 3600 * D2R, c[0] * D2R, c[1] * D2R
    rho = math.hypot(x, y)
    if not rho: return c
    cc = math.atan(rho)
    dec = math.asin(math.cos(cc) * math.sin(d0) + y * math.sin(cc) * math.cos(d0) / rho)
    ra = a0 + math.atan2(x * math.sin(cc), rho * math.cos(d0) * math.cos(cc) - y * math.sin(d0) * math.sin(cc))
    return (ra / D2R) % 360, dec / D2R


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
        reqs = []   # every request, the pipeline's Web Worker included
        ctx.on("request", lambda r: reqs.append((r.method, r.url)))
        pg = await ctx.new_page()
        images = lambda: sum("/api/images" in u for _, u in reqs)
        posts = lambda: sum(m == "POST" and "/api/checks" in u for m, u in reqs)   # heat-map checks: one per new cell
        landed = [1]   # builds that landed, the first included

        async def view():   # the built spot and how the photo sits on screen
            return await pg.evaluate("""() => { const s = __lapse.state, m = s.m, r = document.getElementById('patch').getBoundingClientRect();
              return { ra: m.ra, dec: m.dec, key: m.key, aps: m.arcsec_per_pixel, crop: Math.round(s.fov * 60 / m.arcsec_per_pixel),
                cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, pan: __lapse.pan, year: m.frames[s.i].year, frames: m.frames.length,
                gaia: m.gaia && m.gaia.total, motion: m.motion && m.motion.total, ok: !!document.querySelector('#vMotion .ok'),
                url: location.search, box: document.getElementById('coords').value, status: document.getElementById('status').textContent,
                det: document.getElementById('det').value, mdet: m.detector, cached: __lapse.cached } }""")

        async def rebuilt(timeout=240000):   # wait for the next build to land; seconds taken
            t0 = time.time()
            await pg.wait_for_function("__lapse.state.m !== window.__was || document.getElementById('status').className === 'err'", timeout=timeout)
            if await pg.evaluate("__lapse.state.m !== window.__was"): landed[0] += 1
            await pg.wait_for_timeout(300)   # request events arrive a moment after the page sends them
            return time.time() - t0 - 0.3

        async def mark():
            await pg.evaluate("window.__was = __lapse.state.m")

        def screen(v, ra, dec):   # sky -> client px through the photo's TAN projection (pan is 0 after a build)
            d0, d, da = v["dec"] * D2R, dec * D2R, (ra - v["ra"]) * D2R
            cosc = math.sin(d0) * math.sin(d) + math.cos(d0) * math.cos(d) * math.cos(da)
            e = math.cos(d) * math.sin(da) / cosc / D2R * 3600
            n = (math.cos(d0) * math.sin(d) - math.sin(d0) * math.cos(d) * math.cos(da)) / cosc / D2R * 3600
            k = v["w"] / v["crop"] / v["aps"]   # client px per arcsec
            return v["cx"] - e * k, v["cy"] - n * k   # east is left, north is up

        def moved(v, dx, dy):   # the centre after the photo moves dx, dy client px
            k = v["crop"] / v["w"] * v["aps"]   # arcsec per client px
            return deproject((v["ra"], v["dec"]), dx * k, dy * k)

        def shown(v):   # the spot at the middle of the photo: the built centre moved by the pan
            return deproject((v["ra"], v["dec"]), v["pan"][0] * v["aps"], v["pan"][1] * v["aps"])

        def agree(v):   # arcsec between the photo's middle and what the URL and the box name
            q = urllib.parse.parse_qs(v["url"][1:]); u = (float(q["ra"][0]), float(q["dec"][0])); bx = tuple(map(float, v["box"].split()))
            return max(sep(u, shown(v)), sep(bx, shown(v)))

        async def touch(kind, pts=()):   # CDP touch: pts are (finger id, x, y), every finger still down
            await cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"id": i, "x": x, "y": y} for i, x, y in pts]})
            await pg.wait_for_timeout(20)

        def url_and_box(v):
            q = urllib.parse.parse_qs(v["url"][1:])
            u = (float(q["ra"][0]), float(q["dec"][0])); bx = tuple(map(float, v["box"].split()))
            return max(sep(u, (v["ra"], v["dec"])), sep(bx, (v["ra"], v["dec"])))

        # ---- a failed wavelength-map download is not remembered by the long-lived worker: the next search builds
        left = [1]
        async def flaky(route):
            if left[0]: left[0] -= 1; await route.fulfill(status=503, body="busy")
            else: await route.continue_()
        await ctx.route("**/data/wavemaps.json", flaky)
        await pg.goto(f"{BASE}/timelapse.html?ra={START[0]}&dec={START[1]}&det=D1")
        await pg.wait_for_function("document.getElementById('status').className === 'err'", timeout=60000)
        first = await pg.evaluate("document.getElementById('status').textContent")
        cdp = await ctx.new_cdp_session(pg)

        # ---- live start, 1.5 arcmin from the star
        t0 = time.time()
        await pg.evaluate("document.getElementById('search').requestSubmit()")
        await pg.wait_for_function("__lapse.state.m && /visits, built/.test(document.getElementById('status').textContent)", timeout=240000)
        v = await view()
        check(left[0] == 0, f"maps: after a failed download ('{first}') the next search builds")
        await pg.wait_for_timeout(1000)
        p0 = posts()

        # ---- the page's heat-map cell matches the Worker's cellAt (taken from worker/src/index.js itself)
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "worker", "src", "index.js")).read()
        grid = src[src.index("const BANDS"):src.index("const cellBox")]
        bad = await pg.evaluate("""async src => { const { heatCell } = await import('./live/recenter.js');
          const cellAt = new Function(src + '; return (ra, dec) => [cellAt(ra, dec), GRID];')();
          const spots = [[0, 0], [359.999, 0.01], [269.4463, 4.7922], [265.4, 4.8], [10, 89.99], [200, -89.99], [123.4, -45.6], [331.096, -56.801], [77.3, 27.35]];
          return spots.filter(([ra, dec]) => { const [c, G] = cellAt(ra, dec), [i, j] = heatCell(ra, dec).split(',').map(Number); return G[i][0] + j !== c; }); }""", grid)
        check(not bad, f"heatmap: the page's cell matches the Worker's cellAt at 9 spots, poles and RA 0/360 included (mismatches {bad})")
        check(p0 == 1, f"heatmap: the first build posted {p0} check")
        check(images() >= 1, f"start: live build in {time.time() - t0:.1f} s, {v['frames']} visits, {images()} /api/images request seen")

        # ---- click precision: click Barnard's Star where it is in the visit on screen
        star = star_at(v["year"]); x, y = map(round, screen(v, *star))   # a whole pixel, as a mouse gives
        n0, c0 = images(), len(reqs)
        await mark(); await pg.mouse.click(x, y)
        dt = await rebuilt(); v = await view()
        off = sep((v["ra"], v["dec"]), star)
        check(off <= PIXEL, f"click: centre {off:.2f}\" from the star at {v['year']:.2f} (limit {PIXEL}\"), rebuilt in {dt:.1f} s")
        check(images() == n0, f"click: no new /api/images request ({images() - n0} made)")
        check(v["key"].startswith("live") and v["ok"] and v["gaia"] and abs(v["motion"] / v["gaia"] - 1) <= 0.2,
              f"click: motion {v['motion'] and round(v['motion'], 2)}\"/yr vs Gaia {v['gaia'] and round(v['gaia'], 2)}\"/yr, panel marks it agreeing ({v['key']})")
        await pg.wait_for_timeout(1500)   # request events arrive a moment after the page sends them
        new = [u for _, u in reqs[c0:]]
        check(any("/api/known" in u and f"dec={v['dec']:.4f}" in u for u in new), "click: known objects checked at the new centre")
        check(posts() == p0, f"heatmap: the click, 90\" away in the same cell, posted {posts() - p0} new checks")
        check(url_and_box(v) < 0.5, f"click: URL {v['url']} and box '{v['box']}' name the new centre")

        # ---- Gaia is asked only when the stars already fetched do not fit: a 1 pixel nudge on the star reuses them
        c = (v["ra"], v["dec"]); await mark()
        await pg.focus("#patch"); await pg.keyboard.press("Shift+ArrowUp")
        dt = await rebuilt(); v = await view()
        check(dt < 2.5 and v["ok"] and abs(sep(c, (v["ra"], v["dec"])) - 5) < 0.5,
              f"gaia: a 5\" nudge on the star rebuilt in {dt:.1f} s (limit 2.5 s), panel still agrees")

        # ---- drag precision: the photo follows the pointer at once, the centre moves by the dragged amount
        dx, dy = -180, 120
        n0 = images(); await mark()
        await pg.mouse.move(v["cx"], v["cy"]); await pg.mouse.down()
        await pg.mouse.move(v["cx"] + dx, v["cy"] + dy, steps=12)
        pan = (await view())["pan"]; k = v["crop"] / v["w"]
        check(abs(pan[0] - dx * k) < 0.01 and abs(pan[1] - dy * k) < 0.01, f"drag: photo follows before release (pan {pan[0]:.2f}, {pan[1]:.2f} grid px)")
        await pg.mouse.up()
        want = moved(v, dx, dy)
        dt = await rebuilt(); v = await view()
        off = sep((v["ra"], v["dec"]), want)
        check(off <= PIXEL, f"drag: {dx}, {dy} px landed {off:.2f}\" from the expected centre, rebuilt in {dt:.1f} s")
        check(images() == n0, f"drag: no new /api/images request ({images() - n0} made)")
        check(url_and_box(v) < 0.5, f"drag: URL {v['url']} and box '{v['box']}' name the new centre")

        # ---- short tap: under 5 px of movement is a click on that spot, not a 3 px drag
        tx, ty = v["cx"] + 110, v["cy"] - 70
        n0 = images(); await mark()
        await pg.mouse.move(tx, ty); await pg.mouse.down(); await pg.mouse.move(tx + 3, ty + 1, steps=3); await pg.mouse.up()
        want = moved(v, v["cx"] - tx - 3, v["cy"] - ty - 1)
        dt = await rebuilt(); v = await view()
        off = sep((v["ra"], v["dec"]), want)
        check(off <= PIXEL and images() == n0, f"tap: a 3 px wobble centred the tapped spot ({off:.2f}\" off), rebuilt in {dt:.1f} s, no new search")

        # ---- two fingers: the second is ignored, the first finger's drag decides the centre
        await cdp.send("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})
        n0 = images(); cx, cy = v["cx"], v["cy"]; await mark()
        await touch("touchStart", [(0, cx, cy)])
        for k in range(1, 6): await touch("touchMove", [(0, cx - 20 * k, cy)])
        await touch("touchStart", [(0, cx - 100, cy), (1, cx + 150, cy + 100)])
        for k in range(1, 6): await touch("touchMove", [(0, cx - 100, cy), (1, cx + 150 + 16 * k, cy + 100 + 16 * k)])
        await touch("touchEnd")
        want = moved(v, -100, 0)
        dt = await rebuilt(); v = await view()
        off = sep((v["ra"], v["dec"]), want)
        check(off <= PIXEL and images() == n0, f"fingers: a second finger did not move the drag ({off:.2f}\" from the first finger's centre), rebuilt in {dt:.1f} s")

        # ---- a drag cancelled while the last move is still building puts the photo back where that move left it
        cx, cy = v["cx"], v["cy"]; await mark()
        await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx + 90, cy + 60, steps=5); await pg.mouse.up()
        want = moved(v, 90, 60); p1 = (await view())["pan"]
        await touch("touchStart", [(0, cx, cy)])
        for k in range(1, 5): await touch("touchMove", [(0, cx - 15 * k, cy - 15 * k)])
        await touch("touchCancel")
        mid = await view()
        await cdp.send("Emulation.setTouchEmulationEnabled", {"enabled": False})
        check((p1[0] or p1[1]) and agree(mid) < 1, f"cancel: started at pan {p1[0]:.1f}, {p1[1]:.1f}; after the cancel the photo shows what the URL names ({agree(mid):.2f}\" apart)")
        await rebuilt(); v = await view()
        check(sep((v["ra"], v["dec"]), want) <= PIXEL and agree(v) < 1, f"cancel: the move before it still lands ({sep((v['ra'], v['dec']), want):.2f}\" off)")

        # ---- keyboard: an arrow key with the photo in focus nudges the centre an eighth of the view
        n0 = images(); await mark()
        await pg.focus("#patch"); await pg.keyboard.press("ArrowRight")
        nudged = (await view())["pan"]
        want = moved(v, -v["crop"] / 8 * v["w"] / v["crop"], 0)
        dt = await rebuilt(); v2 = await view()
        off = sep((v2["ra"], v2["dec"]), want)
        check(nudged[0] < 0 and off <= PIXEL and images() == n0,
              f"keys: ArrowRight moved the photo at once and the centre {sep((v['ra'], v['dec']), (v2['ra'], v2['dec'])):.1f}\" west ({off:.2f}\" off), rebuilt in {dt:.1f} s")
        v = v2

        # ---- three small nudges inside one heat-map cell post no new check
        p1 = posts()
        for key in ("Shift+ArrowUp", "Shift+ArrowLeft", "Shift+ArrowDown"):
            await mark(); await pg.focus("#patch"); await pg.keyboard.press(key); await rebuilt()
        v = await view()
        check(posts() == p1, f"heatmap: three 1 pixel nudges in one cell posted {posts() - p1} new checks")

        # ---- another detector chosen while a key move waits: the move is dropped and D2 builds at this spot
        before = v
        await pg.focus("#patch"); await pg.keyboard.press("ArrowRight"); await mark()
        await pg.select_option("#det", "D2"); await pg.wait_for_timeout(800)
        mid = await view()
        check(mid["det"] == "D2" and mid["pan"] == [0, 0] and mid["box"] == before["box"], f"detector: D2 kept, the key move dropped (box '{mid['box']}', selector {mid['det']})")
        dt = await rebuilt(); v = await view()
        check(v["mdet"] == "D2" and "det=D2" in v["url"] and sep((v["ra"], v["dec"]), (before["ra"], before["dec"])) < 1 and agree(v) < 1,
              f"detector: D2 built at the same spot in {dt:.1f} s ({v['url']})")

        # ---- a re-centre that fails goes back to the last spot: photo, URL and box agree with the panel
        await ctx.route("**/api/images*", lambda route: route.fulfill(status=502, content_type="application/json", body='{"error":"IRSA is not answering"}'))
        keep = v
        await pg.evaluate(f"__lapse.recenter([{-4 * 3600 / v['aps']}, 0])")
        await pg.wait_for_function("document.getElementById('status').className === 'err'", timeout=60000)
        v = await view()
        check(v["key"] == keep["key"] and v["pan"] == [0, 0] and agree(v) < 1 and v["url"] == keep["url"] and "Back at the last spot" in v["status"],
              f"failure: back at the last spot ('{v['status']}', {v['url']})")
        await ctx.unroute("**/api/images*")

        # ---- leaving coverage: 4 degrees west is outside every listed image, so IRSA is asked again
        n0, p1 = images(), posts(); await mark()
        pan = -4 * 3600 / v["aps"]
        await pg.evaluate(f"__lapse.recenter([{pan}, 0])")
        want = deproject((v["ra"], v["dec"]), pan * v["aps"], 0)
        dt = await rebuilt(400000); v = await view()
        off = sep((v["ra"], v["dec"]), want)
        check(images() > n0 and off <= PIXEL and v["frames"] >= 2 and "built" in v["status"],
              f"leave: new /api/images request ({images() - n0}), {v['frames']} visits at the new spot ({off:.2f}\" off), built in {dt:.1f} s")
        check(posts() == p1 + 1, f"heatmap: the move into a new cell posted {posts() - p1} check ({posts()} in all for {landed[0]} builds)")
        check(v["cached"] <= 8 and landed[0] > 8, f"cache: {landed[0]} live builds, {v['cached']} kept for instant return (at most 8)")
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
