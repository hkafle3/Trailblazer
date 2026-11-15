"""Browser check for zooming the time-lapse photo with the wheel, a pinch and the + and - keys, and for the loading
caption keeping clear of the target and the known objects' names. In system Chrome on Barnard's Star (baked), then a
re-centre that builds live. Needs the app up (npm run dev) and the network (NASA's S3 copy of SPHEREx) for the builds.
At 1440x900:
1. the wheel up over the photo narrows state.fov and moves Ming's Zoom bar to match; the wheel down widens it; a
   trackpad's small steps add up; a line-mode wheel and a trackpad pinch (ctrl wheel) zoom too; 1 and 12 arcmin hold;
   the page does not scroll; the wheel outside the photo does not zoom;
2. + and - zoom with the photo in focus, and do not move it (no arrow nudge, no rebuild);
3. while frames build after a drag, the loading caption covers neither the photo's centre nor any known object's name;
4. a drag re-centres, and a click re-centres.
At 390x844 with touch: a two-finger pinch (CDP touch) zooms the photo, the page does not zoom (visualViewport.scale 1)
or scroll, and nothing rebuilds.
Screenshots go to the folder given as the second argument (default: none).
Run: uv run -q --with playwright python web/tests/timelapse_zoom_ui.py [base url] [shot dir]   (default http://127.0.0.1:8787)"""
import asyncio, os, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
URL = f"{BASE}/timelapse.html?target=barnard"
READY = "window.__lapse?.state.m && !document.body.classList.contains('busy')"
# the zoom as the page has it, and as Ming's bar shows it (state.fov = 13 - the bar's value)
ZOOM = """() => { const f = document.getElementById('fov');
  return { fov: __lapse.state.fov, bar: 13 - +f.value, text: f.getAttribute('aria-valuetext'), fill: f.style.getPropertyValue('--p'),
    sy: scrollY, sx: scrollX, pan: __lapse.pan, url: location.search, scale: visualViewport.scale }; }"""
fails = []


def check(ok, msg):
    print(("PASS " if ok else "FAIL ") + msg)
    if not ok: fails.append(msg)


def synced(z):
    return z["fov"] == z["bar"] and z["text"] == f"{z['fov']:g} arcmin wide"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        errors = []

        # ---------------- desktop ----------------
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
        pg = await ctx.new_page(); pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL); await pg.wait_for_function(READY, timeout=60000)
        r = await pg.evaluate("(() => { const r = document.getElementById('patch').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()")
        cx, cy = r["x"] + r["w"] / 2, r["y"] + r["h"] / 2
        zoom = lambda: pg.evaluate(ZOOM)
        z0 = await zoom()

        await pg.mouse.move(cx, cy)
        await pg.mouse.wheel(0, -100); await pg.wait_for_timeout(150)
        z1 = await zoom()
        check(z1["fov"] < z0["fov"] and synced(z1) and z1["sy"] == 0, f"wheel up: {z0['fov']} -> {z1['fov']} arcmin, the bar says {z1['bar']} ({z1['text']}, filled {z1['fill']}), page scrollY {z1['sy']}")
        await pg.mouse.wheel(0, 100); await pg.mouse.wheel(0, 100); await pg.wait_for_timeout(150)
        z2 = await zoom()
        check(z2["fov"] > z1["fov"] and synced(z2) and z2["sy"] == 0, f"wheel down: {z1['fov']} -> {z2['fov']} arcmin, bar {z2['bar']}, scrollY {z2['sy']}")

        for _ in range(12): await pg.mouse.wheel(0, -8); await pg.wait_for_timeout(16)   # trackpad: small steps add up
        z3 = await zoom()
        check(z3["fov"] < z2["fov"] and synced(z3), f"trackpad: twelve 8 px steps zoom {z2['fov']} -> {z3['fov']} arcmin")

        cdp = await ctx.new_cdp_session(pg)
        for _ in range(6):   # a Mac trackpad pinch: Chrome sends ctrl wheels
            await cdp.send("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": cx, "y": cy, "deltaX": 0, "deltaY": -10, "modifiers": 2})
        await pg.wait_for_timeout(150); z4 = await zoom()
        check(z4["fov"] < z3["fov"] and synced(z4) and z4["scale"] == 1, f"pinch (ctrl wheel): {z3['fov']} -> {z4['fov']} arcmin, visualViewport.scale {z4['scale']}")

        await pg.evaluate("document.getElementById('patch').dispatchEvent(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true }))")
        z5 = await zoom()
        check(z5["fov"] > z4["fov"] and synced(z5), f"line-mode wheel (3 lines down): {z4['fov']} -> {z5['fov']} arcmin")

        for _ in range(40): await pg.mouse.wheel(0, -120)
        await pg.wait_for_timeout(150); lo = await zoom()
        for _ in range(40): await pg.mouse.wheel(0, 120)
        await pg.wait_for_timeout(150); hi = await zoom()
        check(lo["fov"] == 1 and hi["fov"] == 12 and synced(lo) and synced(hi) and hi["sy"] == 0, f"limits: in to {lo['fov']}, out to {hi['fov']} arcmin, page scrollY {hi['sy']}")

        await pg.mouse.move(cx, cy); await pg.mouse.wheel(0, -300); await pg.wait_for_timeout(150)
        base = await zoom()
        o = await pg.evaluate("(() => { const r = document.querySelector('.pv-options').getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; })()")
        await pg.mouse.move(*o); await pg.mouse.wheel(0, -200); await pg.mouse.wheel(0, 200); await pg.wait_for_timeout(150)
        out = await zoom()
        check(out["fov"] == base["fov"], f"outside the photo (over Options) the wheel does not zoom: {base['fov']} -> {out['fov']} arcmin")

        # + and - with the photo in focus: a zoom, not an arrow nudge
        await pg.focus("#patch"); k0 = await zoom()
        await pg.keyboard.press("+"); await pg.wait_for_timeout(100); k1 = await zoom()
        await pg.keyboard.press("-"); await pg.keyboard.press("-"); await pg.wait_for_timeout(500); k2 = await zoom()
        check(k1["fov"] < k0["fov"] < k2["fov"] and synced(k2) and k2["pan"] == [0, 0] and k2["url"] == k0["url"],
              f"keys: + {k0['fov']} -> {k1['fov']}, - - -> {k2['fov']} arcmin; the photo did not move (pan {k2['pan']}, URL {k2['url']})")
        if SHOTS: await pg.screenshot(path=os.path.join(SHOTS, "desktop-zoomed.png"))

        # back to the default 6 arcmin with the bar itself, then a drag re-centres and builds live
        await pg.evaluate("(() => { const f = document.getElementById('fov'); f.value = 7; f.dispatchEvent(new Event('input')); })()")
        await pg.evaluate("window.__was = __lapse.state.m")
        await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx + 60, cy + 30, steps=6); await pg.mouse.up()
        await pg.wait_for_timeout(100); d = await zoom()
        check(d["pan"] != [0, 0] and "ra=" in d["url"], f"drag: the photo moved (pan {[round(x, 1) for x in d['pan']]}) and the URL names the new spot ({d['url'][:40]})")

        # while it builds: the caption must cover neither the photo's centre nor a known object's name
        COVER = """() => { const L = document.getElementById('loading'), s = getComputedStyle(L);
          if (s.visibility !== 'visible' || +s.opacity < .5) return null;
          const a = L.getBoundingClientRect(), p = document.getElementById('patch'), r = p.getBoundingClientRect(), q = r.width / p.width;
          const mid = [r.left + r.width / 2, r.top + r.height / 2], bad = [];
          if (a.left <= mid[0] && mid[0] <= a.right && a.top <= mid[1] && mid[1] <= a.bottom) bad.push('the centre');
          const names = (window.__labels?.names || []).map(n => [r.left + n[0] * q, r.top + n[1] * q, r.left + n[2] * q, r.top + n[3] * q]);
          for (const n of names) if (n[0] < a.right && n[2] > a.left && n[1] < a.bottom && n[3] > a.top) bad.push(`a name at ${n.map(Math.round)}`);
          return { text: document.getElementById('ld-text').textContent, names: names.length, bad }; }"""
        # Barnard's Star has no known objects passing, so one is put just left of the caption, where its name's first
        # choice (right of it) would sit under the caption, as "Dove" did; the page then redraws (the Zoom bar's input)
        PLANT = """() => { const s = __lapse.state, m = s.m, f = m.frames[s.i], p = document.getElementById('patch'), L = document.getElementById('loading');
          const q = p.width / p.clientWidth, G = m.grid, a = m.arcsec_per_pixel;
          const cw = Math.min(G, Math.max(2, Math.round(s.fov * 60 / a))), ch = Math.min(G, Math.max(2, Math.round(cw * p.height / p.width)));
          const sx = p.width / cw, sy = p.height / ch, ox = (G - cw) / 2 - __lapse.pan[0], oy = (G - ch) / 2 - __lapse.pan[1];
          const x = L.offsetLeft * q - 30, y = (L.offsetTop + L.offsetHeight / 2) * q;   // canvas px, then grid, then sky (small angles)
          const gx = ox + x / sx - .5, gy = G - 1 - (oy + y / sy - .5), e = ((G - 1) / 2 - gx) * a, n = (gy - (G - 1) / 2) * a;
          f.known = { bodies: [['Dove', { kind: 'asteroid', pts: [[0, m.ra + e / 3600 / Math.cos(m.dec * Math.PI / 180), m.dec + n / 3600]] }]] };
          document.getElementById('fov').dispatchEvent(new Event('input')); return window.__labels?.names?.length || 0; }"""
        looks, bad, shot, planted = 0, [], False, 0
        for _ in range(2400):   # 4 minutes at most
            c = await pg.evaluate(COVER)
            if c:
                if not planted: planted = await pg.evaluate(PLANT); c = await pg.evaluate(COVER)
                looks += 1; bad += c["bad"]
                if SHOTS and not shot and c["text"].startswith(("Building frame", "Measuring")):
                    await pg.screenshot(path=os.path.join(SHOTS, "desktop-building.png")); shot = True
            if await pg.evaluate("__lapse.state.m !== window.__was || document.getElementById('status').className === 'err'"): break
            await pg.wait_for_timeout(100)
        landed = await pg.evaluate("__lapse.state.m !== window.__was")
        check(landed and looks > 0 and planted > 0 and not bad, f"caption: seen {looks} times while frames built, over the centre or a name: {bad or 'never'} ({planted} name planted beside it); the drag's build landed: {landed}")

        # a click re-centres on the clicked spot
        await pg.evaluate("window.__was = __lapse.state.m"); u0 = (await zoom())["url"]
        await pg.mouse.click(cx - 80, cy - 50); await pg.wait_for_timeout(300); c = await zoom()
        check(c["pan"] != [0, 0] and c["url"] != u0, f"click: the photo eases to the clicked spot (pan {[round(x, 1) for x in c['pan']]}) and the URL follows")
        await pg.wait_for_function("__lapse.state.m !== window.__was || document.getElementById('status').className === 'err'", timeout=240000)
        check(await pg.evaluate("__lapse.state.m !== window.__was"), "click: its build landed")
        await ctx.close()

        # ---------------- phone ----------------
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
        pg = await ctx.new_page(); pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(URL); await pg.wait_for_function(READY, timeout=60000)
        zoom = lambda: pg.evaluate(ZOOM)
        r = await pg.evaluate("(() => { const r = document.getElementById('patch').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()")
        cx, cy = r["x"] + r["w"] / 2, r["y"] + r["h"] / 2
        cdp = await ctx.new_cdp_session(pg)

        async def touch(kind, pts=()):
            await cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"id": i, "x": x, "y": y} for i, x, y in pts]})
            await pg.wait_for_timeout(20)

        async def pinch(d0, d1):   # two fingers either side of the centre, from d0 apart to d1 apart
            await touch("touchStart", [(0, cx - d0 / 2, cy)])
            await touch("touchStart", [(0, cx - d0 / 2, cy), (1, cx + d0 / 2, cy)])
            for k in range(1, 9):
                d = d0 + (d1 - d0) * k / 8
                await touch("touchMove", [(0, cx - d / 2, cy), (1, cx + d / 2, cy)])
            await touch("touchEnd"); await pg.wait_for_timeout(200)

        p0 = await zoom()
        await pinch(60, 200); p1 = await zoom()
        check(p1["fov"] < p0["fov"] and synced(p1) and p1["scale"] == 1 and p1["sy"] == 0 and p1["pan"] == [0, 0] and p1["url"] == p0["url"],
              f"phone pinch out: {p0['fov']} -> {p1['fov']} arcmin (bar {p1['bar']}), visualViewport.scale {p1['scale']}, scrollY {p1['sy']}, no move or rebuild")
        if SHOTS: await pg.screenshot(path=os.path.join(SHOTS, "phone-pinched.png"))
        await pinch(200, 80); p2 = await zoom()
        check(p2["fov"] > p1["fov"] and synced(p2) and p2["scale"] == 1 and p2["sy"] == 0, f"phone pinch in: {p1['fov']} -> {p2['fov']} arcmin, scale {p2['scale']}")
        # one finger still drags the photo
        await touch("touchStart", [(0, cx, cy)])
        for k in range(1, 6): await touch("touchMove", [(0, cx - 12 * k, cy)])
        await touch("touchEnd"); await pg.wait_for_timeout(100); p3 = await zoom()
        check(p3["pan"] != [0, 0] and p3["url"] != p0["url"] and p3["fov"] == p2["fov"], f"phone: one finger still drags (pan {[round(x, 1) for x in p3['pan']]}), no zoom")
        if SHOTS:
            await pg.wait_for_function("document.body.classList.contains('busy') && getComputedStyle(document.getElementById('loading')).opacity > .9", timeout=20000)
            await pg.screenshot(path=os.path.join(SHOTS, "phone-building.png"))
        await ctx.close()

        check(not errors, f"no page errors: {errors[:3]}")
        await b.close()
    print("PASS all" if not fails else f"FAIL {len(fails)}: " + "; ".join(fails))
    sys.exit(1 if fails else 0)

asyncio.run(main())
