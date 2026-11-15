"""Browser check for re-centring the time-lapse: click a spot, drag the photo, arrow keys. Needs the app up (npm run dev)
and the network (IRSA, NASA's S3 copy of SPHEREx); takes a few minutes on a slow IRSA day.
Run: uv run -q --with playwright python web/tests/recenter_ui.py [base url]   (default http://127.0.0.1:8787)
Starts live 1.5 arcmin north of Barnard's Star, clicks the star, then drags, taps and nudges, and finally moves 4 degrees
away, out of the listed images. Precision is 1 SPHEREx pixel (6.15 arcsec); the photo's grid is 5 arcsec per pixel."""
import asyncio, math, sys, time, urllib.parse
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

        async def view():   # the built spot and how the photo sits on screen
            return await pg.evaluate("""() => { const s = __lapse.state, m = s.m, r = document.getElementById('patch').getBoundingClientRect();
              return { ra: m.ra, dec: m.dec, key: m.key, aps: m.arcsec_per_pixel, crop: Math.round(s.fov * 60 / m.arcsec_per_pixel),
                cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, pan: __lapse.pan, year: m.frames[s.i].year, frames: m.frames.length,
                gaia: m.gaia && m.gaia.total, motion: m.motion && m.motion.total, ok: !!document.querySelector('#vMotion .ok'),
                url: location.search, box: document.getElementById('coords').value, status: document.getElementById('status').textContent } }""")

        async def rebuilt(timeout=240000):   # wait for the next build to land; seconds taken
            t0 = time.time()
            await pg.wait_for_function("__lapse.state.m !== window.__was || document.getElementById('status').className === 'err'", timeout=timeout)
            return time.time() - t0

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

        def url_and_box(v):
            q = urllib.parse.parse_qs(v["url"][1:])
            u = (float(q["ra"][0]), float(q["dec"][0])); bx = tuple(map(float, v["box"].split()))
            return max(sep(u, (v["ra"], v["dec"])), sep(bx, (v["ra"], v["dec"])))

        # ---- live start, 1.5 arcmin from the star
        t0 = time.time()
        await pg.goto(f"{BASE}/timelapse.html?ra={START[0]}&dec={START[1]}&det=D1")
        await pg.wait_for_function("__lapse.state.m && /visits, built/.test(document.getElementById('status').textContent)", timeout=240000)
        v = await view()
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
        check(any(m == "POST" and "/api/checks" in u for m, u in reqs[c0:]), "click: heat map check posted")
        check(url_and_box(v) < 0.5, f"click: URL {v['url']} and box '{v['box']}' name the new centre")

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

        # ---- leaving coverage: 4 degrees west is outside every listed image, so IRSA is asked again
        n0 = images(); await mark()
        pan = -4 * 3600 / v["aps"]
        await pg.evaluate(f"__lapse.recenter([{pan}, 0])")
        want = deproject((v["ra"], v["dec"]), pan * v["aps"], 0)
        dt = await rebuilt(400000); v = await view()
        off = sep((v["ra"], v["dec"]), want)
        check(images() > n0 and off <= PIXEL and v["frames"] >= 2 and "built" in v["status"],
              f"leave: new /api/images request ({images() - n0}), {v['frames']} visits at the new spot ({off:.2f}\" off), built in {dt:.1f} s")
        await b.close()
    sys.exit(1 if fails else 0)

asyncio.run(main())
