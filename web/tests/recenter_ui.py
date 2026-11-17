"""Browser check for re-centring the time-lapse: click a spot, drag the photo, arrow keys. Needs the app up (npm run dev)
and the network (IRSA, NASA's S3 copy of SPHEREx); takes a few minutes on a slow IRSA day.
Run: uv run -q --with playwright python web/tests/recenter_ui.py [base url]   (default http://127.0.0.1:8787)
Starts live 1.5 arcmin north of Barnard's Star (after a failed pipeline download and a failed wavelength-map download,
neither of which may stick), clicks
the star, then nudges, drags, taps, pinches mid-drag, cancels a drag, switches detector during a key move, fails
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
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.adv', '1') } catch {}")
        reqs = []   # every request, the pipeline's Web Worker included
        ctx.on("request", lambda r: reqs.append((r.method, r.url)))
        pg = await ctx.new_page()
        images = lambda: sum("/api/images" in u for _, u in reqs)
        posts = lambda: sum(m == "POST" and "/api/checks" in u for m, u in reqs)   # heat-map checks: one per new cell
        landed = [1]   # builds that landed, the first included

        async def view():   # the built spot and how the photo sits on screen
            return await pg.evaluate("""() => { const s = __lapse.state, m = s.m, r = document.getElementById('patch').getBoundingClientRect();
              return { ra: m.ra, dec: m.dec, key: m.key, aps: m.arcsec_per_pixel, ...(() => {   // the frame shows cw x ch grid pixels (not square), as the page's view() does
                  const G = m.grid, p = document.getElementById('patch'), cw = Math.min(G, Math.max(2, Math.round(s.fov * 60 / m.arcsec_per_pixel)));
                  const ch = Math.min(G, Math.max(2, Math.round(cw * p.height / p.width))); return { cw, kx: cw / r.width, ky: ch / r.height }; })(),
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
            return v["cx"] - e / v["aps"] / v["kx"], v["cy"] - n / v["aps"] / v["ky"]   # east is left, north is up

        def moved(v, dx, dy):   # the centre after the photo moves dx, dy client px
            return deproject((v["ra"], v["dec"]), dx * v["kx"] * v["aps"], dy * v["ky"] * v["aps"])   # grid px per client px, x and y

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

        def flaky(left):   # a route that fails `left` times, then lets requests through
            async def h(route):
                if left[0]: left[0] -= 1; await route.fulfill(status=503, body="busy")
                else: await route.continue_()
            return h
        status = lambda: pg.evaluate("document.getElementById('status').textContent")
        new_error = "s => { const e = document.getElementById('status'); return e.className === 'err' && e.textContent !== s; }"

        # ---- the pipeline worker fails to download: an error, and the next search starts a new worker
        dead, left = [1], [1]
        await ctx.route("**/live/pipeline.js", flaky(dead))
        await ctx.route("**/data/wavemaps.json", flaky(left))
        await pg.goto(f"{BASE}/timelapse.html?ra={START[0]}&dec={START[1]}&det=D1")
        await pg.wait_for_function("document.getElementById('status').className === 'err'", timeout=60000)
        broken = await status()

        # ---- a failed wavelength-map download is not remembered by the long-lived worker: the next search builds
        await pg.evaluate("document.getElementById('search').requestSubmit()")
        await pg.wait_for_function(new_error, arg=broken, timeout=60000)
        first = await status()
        check(dead[0] == 0 and "pipeline" in broken and "wavelength maps" in first,
              f"worker: a failed pipeline download says '{broken}', and the next search starts a new worker (it got as far as '{first}')")
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
        res = await pg.evaluate("""async src => { const { heatCell } = await import('./live/recenter.js');
          const [cellAt, G, STEP] = new Function(src + '; return [cellAt, GRID, DEC_STEP];')();
          // ordinary spots, the poles, RA 0/360, and every band edge and cell edge as the Worker's own arithmetic places them
          const spots = [[0, 0], [359.999, 0.01], [269.4463, 4.7922], [10, 90], [200, -90], [123.4, -45.6], [7.2, 14.1176], [360, 10]];
          for (let i = 0; i < G.length; i++) {
            const n = G[i][1], decs = [90 - i * STEP, 90 - (i + .5) * STEP, 90 - (i + 1) * STEP];
            for (const dec of decs) for (let j = 0; j <= n; j++) spots.push([360 * j / n, dec], [j / n * 360, dec], [(j + 1e-12) / n * 360, dec]);
          }
          const bad = spots.filter(([ra, dec]) => { const [i, j] = heatCell(ra, dec).split(',').map(Number); return G[i][0] + j !== cellAt(ra % 360, dec); });
          return [spots.length, bad.slice(0, 5)]; }""", grid)
        check(not res[1], f"heatmap: the page's cell matches the Worker's cellAt at {res[0]} spots, band and cell edges included (mismatches {res[1]})")
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

        # ---- Gaia does not hold up a rebuild: a 1 pixel nudge on the star reuses the stars already fetched, so with
        # /api/gaia slowed to 5 s the frames still land within 4 s of the build starting (timed from the URL change,
        # after the keys' 350 ms settle)
        async def slow_gaia(route):
            await asyncio.sleep(5)
            try: await route.continue_()
            except Exception: pass   # that build was replaced and its request cancelled
        await ctx.route("**/api/gaia*", slow_gaia)
        c = (v["ra"], v["dec"]); await mark(); url0 = await pg.evaluate("location.search")
        await pg.focus("#patch"); await pg.keyboard.press("Shift+ArrowUp")
        await pg.wait_for_function("u => location.search !== u", arg=url0, timeout=10000); t0 = time.time()
        await pg.wait_for_function("__lapse.state.m !== window.__was || document.getElementById('status').className === 'err'", timeout=60000)
        dt = time.time() - t0; landed[0] += 1; v = await view()
        await ctx.unroute("**/api/gaia*")
        check(dt < 4 and v["ok"] and abs(sep(c, (v["ra"], v["dec"])) - 5) < 0.5,
              f"gaia: a 5\" nudge on the star rebuilt in {dt:.1f} s from the build's start with /api/gaia slowed to 5 s (limit 4 s), panel still agrees")

        # ---- drag precision: the photo follows the pointer at once, the centre moves by the dragged amount
        dx, dy = -180, 120
        n0 = images(); await mark()
        await pg.mouse.move(v["cx"], v["cy"]); await pg.mouse.down()
        await pg.mouse.move(v["cx"] + dx, v["cy"] + dy, steps=12)
        pan = (await view())["pan"]
        check(abs(pan[0] - dx * v["kx"]) < 0.01 and abs(pan[1] - dy * v["ky"]) < 0.01, f"drag: photo follows before release (pan {pan[0]:.2f}, {pan[1]:.2f} grid px)")
        await pg.mouse.up()
        want = moved(v, dx, dy)
        dt = await rebuilt(); v = await view()
        off = sep((v["ra"], v["dec"]), want)
        check(off <= PIXEL, f"drag: {dx}, {dy} px landed {off:.2f}\" from the expected centre, rebuilt in {dt:.1f} s")
        check(images() == n0, f"drag: no new /api/images request ({images() - n0} made)")
        check(url_and_box(v) < 0.5, f"drag: URL {v['url']} and box '{v['box']}' name the new centre")

        # ---- layers follow the drag: with Heat and Color Difference on, the photo held 6 grid pixels right is the same
        # picture moved by exactly 6 pixels (every layer is coloured through view(), so they move together)
        await pg.click("label[for=ly-heat]"); await pg.click("label[for=diff]"); await pg.focus("#play"); await pg.keyboard.press("End")
        await pg.wait_for_timeout(300); v = await view(); N = 6
        await pg.evaluate("window.__img = (c => c.getContext('2d').getImageData(0, 0, c.width, c.height))(document.getElementById('patch'))")
        await pg.mouse.move(v["cx"], v["cy"]); await pg.mouse.down(); await pg.mouse.move(v["cx"] + N / v["kx"], v["cy"], steps=6)
        same = await pg.evaluate("""N => { const c = document.getElementById('patch'), now = c.getContext('2d').getImageData(0, 0, c.width, c.height), was = window.__img;
          const m = __lapse.state.m, G = m.grid, cw = Math.min(G, Math.max(2, Math.round(__lapse.state.fov * 60 / m.arcsec_per_pixel))), ch = Math.min(G, Math.max(2, Math.round(cw * c.height / c.width)));
          const sx = c.width / cw, sy = c.height / ch, ox = (G - cw) / 2, oy = (G - ch) / 2, px = (d, x, y) => d.data.slice(4 * (Math.floor(y) * c.width + Math.floor(x)), 4 * (Math.floor(y) * c.width + Math.floor(x)) + 3).join();
          let n = 0, eq = 0;
          for (let gr = Math.ceil(oy); gr < oy + ch - 1; gr++) for (let gc = Math.ceil(ox); gc < ox + cw - N - 1; gc++) {
            n++; if (px(was, (gc - ox + .5) * sx, (gr - oy + .5) * sy) === px(now, (gc - ox + N + .5) * sx, (gr - oy + .5) * sy)) eq++;
          }
          return [eq, n, __lapse.state.heat, __lapse.state.diff, __lapse.state.i]; }""", N)
        await mark(); await pg.mouse.up(); await rebuilt(); v = await view()
        check(same[0] >= 0.97 * same[1] and same[2] and same[3] and same[4] > 0,
              f"layers: Heat and Color Difference on, the held photo is the same picture moved {N} pixels ({same[0]} of {same[1]} sampled pixels match)")
        await pg.click("label[for=ly-heat]"); await pg.click("label[for=diff]"); await pg.wait_for_timeout(200); v = await view()

        # ---- short tap: under 5 px of movement is a click on that spot, not a 3 px drag
        tx, ty = v["cx"] + 110, v["cy"] - 70
        n0 = images(); await mark()
        await pg.mouse.move(tx, ty); await pg.mouse.down(); await pg.mouse.move(tx + 3, ty + 1, steps=3); await pg.mouse.up()
        want = moved(v, v["cx"] - tx - 3, v["cy"] - ty - 1)
        dt = await rebuilt(); v = await view()
        off = sep((v["ra"], v["dec"]), want)
        check(off <= PIXEL and images() == n0, f"tap: a 3 px wobble centred the tapped spot ({off:.2f}\" off), rebuilt in {dt:.1f} s, no new search")

        # ---- two fingers: the second turns the drag into a pinch (timelapse_zoom_ui.py): the drag goes back where it
        # began, nothing builds, and the spreading fingers zoom in; then the Zoom bar goes back to 6 arcmin
        await cdp.send("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})
        n0 = images(); cx, cy = v["cx"], v["cy"]; await mark()
        await touch("touchStart", [(0, cx, cy)])
        for k in range(1, 6): await touch("touchMove", [(0, cx - 20 * k, cy)])
        await touch("touchStart", [(0, cx - 100, cy), (1, cx + 150, cy + 100)])
        await touch("touchMove", [(0, cx - 100, cy), (1, cx + 151, cy + 100)])
        check(await pg.evaluate("__lapse.state.fov") >= 5.9, "fingers: a 1 px move after the second finger lands does not jump the zoom")
        for k in range(1, 6): await touch("touchMove", [(0, cx - 100, cy), (1, cx + 150 + 16 * k, cy + 100 + 16 * k)])
        await touch("touchEnd"); await pg.wait_for_timeout(500)
        fov, pinched = await pg.evaluate("__lapse.state.fov"), await view()
        check(fov < 6 and pinched["pan"] == [0, 0] and pinched["url"] == v["url"] and images() == n0 and await pg.evaluate("__lapse.state.m === window.__was"),
              f"fingers: a second finger turned the drag into a pinch (6 -> {fov} arcmin), the photo went back and nothing rebuilt")
        await pg.evaluate("(() => { const f = document.getElementById('fov'); f.value = 7; f.dispatchEvent(new Event('input')); })()")

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
        want = moved(v, -v["cw"] / 8 / v["kx"], 0)   # an eighth of the view across
        dt = await rebuilt(); v2 = await view()
        off = sep((v2["ra"], v2["dec"]), want)
        check(nudged[0] < 0 and off <= PIXEL and images() == n0,
              f"keys: ArrowRight moved the photo at once and the centre {sep((v['ra'], v['dec']), (v2['ra'], v2['dec'])):.1f}\" west ({off:.2f}\" off), rebuilt in {dt:.1f} s")
        v = v2

        # ---- an arrow key, then a click 250 ms later: the click's spot wins. The key's move would fire at 350 ms, in the
        # middle of the click's 180 ms glide, and ask for a spot part way there; a press must drop it.
        await mark(); await pg.focus("#patch"); await pg.keyboard.press("ArrowRight"); t0 = time.time(); mid = await view()
        tx, ty = v["cx"] - 90, v["cy"] + 40
        await pg.wait_for_timeout(max(0, 250 - (time.time() - t0) * 1000)); await pg.mouse.click(tx, ty)
        want = deproject((v["ra"], v["dec"]), (mid["pan"][0] + (v["cx"] - tx) * v["kx"]) * v["aps"], (mid["pan"][1] + (v["cy"] - ty) * v["ky"]) * v["aps"])
        dt = await rebuilt(); await pg.wait_for_timeout(800); v = await view()   # long enough for a stray key move to land too
        off = sep((v["ra"], v["dec"]), want)
        check(mid["pan"][0] < 0 and off <= PIXEL and agree(v) < 1, f"mixed input: arrow then click, the clicked spot is the centre ({off:.2f}\" off), rebuilt in {dt:.1f} s")

        # ---- an arrow key pressed while a pointer is held is ignored: the release decides (a tap there: that spot)
        await pg.focus("#patch"); await mark(); tx, ty = v["cx"] + 70, v["cy"] - 50
        await pg.evaluate("addEventListener('keydown', e => { window.__key = e; }, true)")   # its defaultPrevented is read after dispatch
        i0 = await pg.evaluate("__lapse.state.i")
        await pg.mouse.move(tx, ty); await pg.mouse.down(); await pg.keyboard.press("ArrowRight"); held = (await view())["pan"]
        swallowed = await pg.evaluate("[window.__key.key, window.__key.defaultPrevented, __lapse.state.i]")
        await pg.wait_for_timeout(250); await pg.mouse.up()
        want = moved(v, v["cx"] - tx, v["cy"] - ty)
        dt = await rebuilt(); await pg.wait_for_timeout(800); v = await view()   # long enough for a stray key move to land
        off = sep((v["ra"], v["dec"]), want)
        check(held == [0, 0] and swallowed == ["ArrowRight", True, i0] and off <= PIXEL and agree(v) < 1,
              f"held pointer: ArrowRight ignored and swallowed (pan {held}, default prevented {swallowed[1]}, visit {swallowed[2]} was {i0}), the tapped spot is the centre ({off:.2f}\" off), rebuilt in {dt:.1f} s")

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

        # ---- a detector chosen during a gesture: the gesture ends, and when that search fails the page goes back to
        # the spot on screen (D3 searches fail here on purpose; no
        # earlier step built D3, so nothing is cached for it)
        await ctx.route("**/api/images*det=D3*", lambda route: route.fulfill(status=502, content_type="application/json", body='{"error":"IRSA is not answering"}'))
        settled = "s => { const e = document.getElementById('status'); return (e.className === 'err' && e.textContent !== s) || __lapse.state.m !== window.__was; }"
        a = v; await mark(); s0 = ""
        await pg.evaluate("document.getElementById('status').textContent = ''")   # so the same error text counts as new
        await pg.mouse.move(a["cx"], a["cy"]); await pg.mouse.down(); await pg.mouse.move(a["cx"] + 40, a["cy"] + 20, steps=4)
        await pg.select_option("#det", "D3")
        await pg.mouse.move(a["cx"] + 90, a["cy"] + 50, steps=4); await pg.mouse.up()
        await pg.wait_for_function(settled, arg=s0, timeout=90000); await pg.wait_for_timeout(500); v = await view()
        drag = await pg.evaluate("document.getElementById('patch').classList.contains('drag')")
        check(v["key"] == a["key"] and v["pan"] == [0, 0] and v["det"] == v["mdet"] == "D2" and agree(v) < 1 and not drag,
              f"held drag: choosing D3 ended it, its release moved nothing, the failed D3 search went back ('{v['status']}', selector {v['det']})")
        a = v; await mark(); s0 = ""
        await pg.evaluate("document.getElementById('status').textContent = ''")   # so the same error text counts as new
        await pg.mouse.move(a["cx"], a["cy"]); await pg.mouse.down(); await pg.mouse.move(a["cx"] + 80, a["cy"] + 50, steps=5); await pg.mouse.up()
        await pg.select_option("#det", "D3")
        await pg.wait_for_function(settled, arg=s0, timeout=90000); await pg.wait_for_timeout(500); v = await view()
        check(v["key"] == a["key"] and v["pan"] == [0, 0] and v["det"] == v["mdet"] == "D2" and agree(v) < 1,
              f"replaced re-centre: D3 chosen before it landed, D3 failed, back at the spot on screen ({v['url']}, box '{v['box']}', selector {v['det']})")
        # a band search that fails while a finger holds the photo: the rollback waits, and a cancel where the drag began
        # brings back the spot on screen (box, band, URL)
        await ctx.unroute("**/api/images*det=D3*")
        async def slow_fail(route):
            await asyncio.sleep(2); await route.fulfill(status=502, content_type="application/json", body='{"error":"IRSA is not answering"}')
        await ctx.route("**/api/images*det=D3*", slow_fail)
        a = v; await mark(); s0 = ""
        await pg.evaluate("document.getElementById('status').textContent = ''")
        await cdp.send("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})
        await pg.select_option("#det", "D3")
        await touch("touchStart", [(0, a["cx"], a["cy"])]); await touch("touchMove", [(0, a["cx"] + 30, a["cy"])])
        await pg.wait_for_function(settled, arg=s0, timeout=60000)
        during = await view()
        await touch("touchCancel"); await cdp.send("Emulation.setTouchEmulationEnabled", {"enabled": False})
        await pg.wait_for_timeout(300); v = await view()
        check(during["det"] == "D3" and v["key"] == a["key"] and v["pan"] == [0, 0] and v["det"] == v["mdet"] == a["mdet"] and agree(v) < 1 and "Back at the last spot" in v["status"],
              f"held through a failure: the D3 search failed mid-drag (selector {during['det']}), the cancel went back ({v['url']}, box '{v['box']}', selector {v['det']})")
        await ctx.unroute("**/api/images*det=D3*")

        # ---- another band chosen, then a drag started before its frames land: they show under the drag, which carries on
        # from them, and the release re-centres on them (D4: no earlier step built it)
        a = v; await mark()
        await pg.select_option("#det", "D4")
        await pg.mouse.move(a["cx"], a["cy"]); await pg.mouse.down(); await pg.mouse.move(a["cx"] + 60, a["cy"] + 30, steps=5)
        held = (await view())["pan"]
        await pg.wait_for_function("__lapse.state.m !== window.__was || document.getElementById('status').className === 'err'", timeout=240000)
        under = await view(); await mark()
        await pg.mouse.move(a["cx"] + 90, a["cy"] + 50, steps=4); await pg.mouse.up()
        want = deproject((under["ra"], under["dec"]), 90 * under["kx"] * under["aps"], 50 * under["ky"] * under["aps"])
        try: await pg.wait_for_function("__lapse.state.m !== window.__was", timeout=90000)
        except Exception: pass   # nothing re-centred: the check below says so
        await pg.wait_for_timeout(300); v = await view()
        off = sep((v["ra"], v["dec"]), want)
        check(under["mdet"] == "D4" and under["pan"] == held and held != [0, 0] and off <= PIXEL and v["mdet"] == "D4" and agree(v) < 1,
              f"band then drag: D4 landed under the drag (pan {under['pan']} kept), the release re-centred on it ({off:.2f}\" off, {v['url']})")

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
        # the result lands while a finger holds the photo: not shown, so no heat-map check yet
        await cdp.send("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})
        await touch("touchStart", [(0, v["cx"], v["cy"])]); await touch("touchMove", [(0, v["cx"] + 20, v["cy"])])
        t0 = time.time()
        await pg.wait_for_function("/visits, built|always work|detector\\./.test(document.getElementById('status').textContent)", timeout=400000)
        dt = time.time() - t0; await pg.wait_for_timeout(500)
        held = await pg.evaluate("__lapse.state.m === window.__was")
        check(held and posts() == p1, f"heatmap: a result that landed during a held drag was not shown and posted {posts() - p1} checks")
        await touch("touchCancel"); await cdp.send("Emulation.setTouchEmulationEnabled", {"enabled": False})
        await pg.evaluate(f"__lapse.recenter([{pan}, 0])")   # the same spot again: the kept result, shown now
        await rebuilt(); v = await view()
        off = sep((v["ra"], v["dec"]), want)
        check(images() > n0 and off <= PIXEL and v["frames"] >= 2 and "Back at" not in v["status"],
              f"leave: new /api/images request ({images() - n0}), {v['frames']} visits at the new spot ({off:.2f}\" off), built in {dt:.1f} s")
        check(posts() == p1 + 1, f"heatmap: the move into a new cell, once shown, posted {posts() - p1} check ({posts()} in all for {landed[0]} builds)")
        check(v["cached"] <= 8 and landed[0] > 8, f"cache: {landed[0]} live builds, {v['cached']} kept for instant return (at most 8)")

        # ---- the discovery belongs to the photo on screen: from discovered spot A, search B and then C before B lands;
        # C fails, and A comes back labelled Discovered with its discovery still in the URL
        pg2 = await ctx.new_page()
        await pg2.goto(f"{BASE}/timelapse.html?ra={START[0]}&dec={START[1]}&det=D1&found=TEST-1")
        await pg2.wait_for_function("__lapse.state.m && /visits, built/.test(document.getElementById('status').textContent)", timeout=240000)
        label0 = await pg2.text_content("#state-label")
        await ctx.route(lambda url: "/api/images" in url and "ra=200&" in url, lambda route: route.fulfill(status=502, content_type="application/json", body='{"error":"IRSA is not answering"}'))
        for spot in ("269.4400 4.7900", "200 10"):   # B (inside the listed images, builds in about a second), then C at once
            await pg2.fill("#coords", spot); await pg2.evaluate("document.getElementById('search').requestSubmit()")
        await pg2.wait_for_function("document.getElementById('status').className === 'err'", timeout=60000)
        label = await pg2.text_content("#state-label"); url = await pg2.evaluate("location.search"); box = await pg2.input_value("#coords")
        check(label0 == label == "Discovered" and "found=TEST-1" in url and box == f"{START[0]:.4f} {START[1]:.4f}",
              f"discovery: B then C, C failed, A is back as '{label}' ({url}, box '{box}')")
        await pg2.close()

        # ---- a target whose frames are slow to download, then a live search that lands first: the target's frames,
        # arriving later, do not replace the newer photo
        # Barnard's frames are held back until the live result has landed, then let through
        release = asyncio.Event()
        async def held_back(route):
            await release.wait()
            try: await route.continue_()
            except Exception: pass
        await ctx.route("**/data/flip/barnard/manifest.json", held_back)
        pg3 = await ctx.new_page()
        await pg3.goto(f"{BASE}/timelapse.html?target=barnard")
        await pg3.fill("#coords", f"{START[0]} {START[1]}"); await pg3.evaluate("document.getElementById('search').requestSubmit()")
        await pg3.wait_for_function("__lapse.state.m && /visits, built/.test(document.getElementById('status').textContent)", timeout=240000)
        async with pg3.expect_event("requestfinished", predicate=lambda r: "flip/barnard/manifest.json" in r.url, timeout=60000):
            release.set()
        await pg3.wait_for_timeout(1500)   # the frames are decoded and the old select() has resumed by now
        got = await pg3.evaluate("[__lapse.state.m.key, location.search, document.getElementById('coords').value]")
        check(got[0].startswith("live") and got[1].startswith("?ra=") and got[2] == f"{START[0]:.4f} {START[1]:.4f}",
              f"slow target: Barnard's frames, let through only after the live search landed, did not replace it ({got[0]}, {got[1]})")
        await pg3.close(); await ctx.unroute("**/data/flip/barnard/manifest.json")
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
