"""Browser check of Explore's Flat / 3D switch (web/explore-3d.js), in system Chrome with the GPU on, on a desktop
(1440 x 900, mouse and keys) and as a phone (390 x 844, touch). Needs the app up (npm run dev).
1. Same place: for Barnard's Star, comet 3I/ATLAS on the timeline's day and SPHEREx's northern deep field, a click on
   that spot of the 3D sky and "Open time-lapse here" opens the same time-lapse as a click on that spot of the flat map
   and "Look closer": RA and Dec within 0.05 degrees of each other and of the target, the same detector, the same view
   and day in the address, and (when both time-lapses load in time) the same photo on screen. Desktop: all three; phone:
   Barnard's Star. The camera really goes by way of Earth: it passes Earth, then ends on the line from Earth to the spot,
   looking along it.
2. Flat stays put: with the map zoomed and panned, a layer switched and a pin dropped, 3D and back (by Escape and by the
   Flat button, after turning, zooming and flying in 3D) leaves the view numbers, the day, the layers, the pin, the page
   address and its history entry the same, and the screenshot the same pixel for pixel.
3. Speed: frame times while turning the sky and flying to photos. Median, 95th and 99th percentile are printed; the 95th
   must be 17 ms or less (60 frames a second).
4. Lazy: a visit that never presses 3D fetches none of explore-3d.js, three.js or data/intro/.
Also: both buttons can be reached and pressed from the keyboard, the arrow keys turn the sky and Enter flies to the
middle of the view, Escape returns to Flat with focus back on the switch, reduced motion cuts to the photo with no
flight, and on the phone the switch is a full-size tap target clear of the other buttons.
Run: uv run -q --with playwright --with pillow python web/tests/explore_3d_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, io, math, re, sys
from PIL import Image, ImageChops
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
DAY = 400
SIZES = [("desktop", dict(viewport={"width": 1440, "height": 900})),
         ("phone", dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True))]
LAZY = ("explore-3d.js", "three", "data/intro/")   # what a visit that never presses 3D must not fetch
BARNARD = (269.4463, 4.7671)   # search-core.js
MODE = "document.body.dataset.view"
READY = "window.__x3d && window.__x3d.ready"
X3D_STATE = "window.__x3d.state"
STATE = """(async () => { const v = await import('/explore-view.js'), b = document.getElementById('map').getBoundingClientRect(), pin = document.getElementById('pin');
  return { view: [v.W, v.X, v.Y, ...v.M], rect: [b.left, b.top, b.width, b.height], day: +document.getElementById('time').value,
    playing: document.getElementById('play').classList.contains('on'), layers: [...document.querySelectorAll('#layers input')].map(i => i.checked),
    pin: [pin.hidden, pin.style.left, pin.style.top], wrap: document.querySelector('.map-wrap').getAttribute('style'), body: document.body.className,
    hist: JSON.stringify(history.state), url: location.href, inert: [...document.body.children].filter(e => e.inert).length }; })()"""
POSE = "window.__x3d.pose()"
fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    if not ok: fails.append(name)


def sep(ra1, dec1, ra2, dec2):   # degrees between two sky positions
    a1, d1, a2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    h = math.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((a2 - a1) / 2) ** 2
    return math.degrees(2 * math.asin(min(1, math.sqrt(h))))


def lapse_addr(url):
    """The time-lapse address a link opens: (ra, dec, the rest of the query as a dict)."""
    q = dict(re.findall(r"[?&]([^=&#]+)=([^&#]*)", url))
    assert "timelapse" in url and "ra" in q and "dec" in q, f"not a time-lapse address: {url}"
    return float(q.pop("ra")), float(q.pop("dec")), q


async def page(b, opts, errs, url=f"/explore.html?day={DAY}", **more):
    ctx = await b.new_context(**opts, **more)
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.intro', '1'); localStorage.setItem('ch.maphint', '1') } catch {}")
    pg = await ctx.new_page(); pg.fetched = []; pg.phone = bool(opts.get("is_mobile"))
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    pg.on("request", lambda r: pg.fetched.append(r.url))
    pg.cdp = await ctx.new_cdp_session(pg)
    await pg.goto(BASE + url)
    await pg.wait_for_selector("body[data-ready='1']"); await pg.wait_for_selector(".mk.known", state="attached")
    await pg.evaluate("Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))")   # the map scales in
    return pg


async def press(pg, sel):
    """Press a control the way this device does: a click, or a tap."""
    if pg.phone: await pg.tap(sel)
    else: await pg.click(sel)


async def to_3d(pg):
    await press(pg, "#view-3d")
    await pg.wait_for_function(f"{MODE} === '3d' && {READY}", timeout=60000)
    await pg.wait_for_timeout(300)


async def drag(pg, x0, y0, x1, y1, steps=12, pause=0.012):
    """A drag with the mouse, or with one finger on the phone, one step per frame or so."""
    if pg.phone:
        touch = lambda kind, x, y: pg.cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [] if kind == "touchEnd" else [{"x": x, "y": y, "id": 1}]})
        await touch("touchStart", x0, y0)
        for i in range(1, steps + 1): await touch("touchMove", x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); await asyncio.sleep(pause)
        await touch("touchEnd", x1, y1)
    else:
        await pg.mouse.move(x0, y0); await pg.mouse.down()
        for i in range(1, steps + 1): await pg.mouse.move(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); await asyncio.sleep(pause)
        await pg.mouse.up()
    await pg.wait_for_timeout(120)


async def on_sky(pg, ra, dec):
    """Window point of a sky position on the 3D sky, if it can be clicked there now: drawn, well inside the window and not under a button."""
    return await pg.evaluate("""([ra, dec]) => { const p = window.__x3d.toScreen(ra, dec); if (!p) return null;
      const m = 48, ok = p[0] > m && p[0] < innerWidth - m && p[1] > m + 60 && p[1] < innerHeight - m && document.elementFromPoint(p[0], p[1])?.id === 'x3d-gl';
      return ok ? p : null; }""", [ra, dec])


async def turn_to(pg, ra, dec):
    """Turn the 3D sky with real drags until the spot can be clicked. Returns its window point."""
    vw, vh = pg.viewport_size["width"], pg.viewport_size["height"]; cx, cy = vw / 2, vh * .45
    for dx, dy in [(0, 0)] + [(vw * .22, 0)] * 12 + [(0, vh * .12)] + [(vw * .22, 0)] * 12 + [(0, -vh * .24)] + [(vw * .22, 0)] * 12:
        if dx or dy: await drag(pg, cx, cy, cx + dx, cy + dy)
        p = await on_sky(pg, ra, dec)
        if p: return p
    raise AssertionError(f"RA {ra} Dec {dec} never came into view on the 3D sky")


async def click_at(pg, x, y):
    if pg.phone: await pg.touchscreen.tap(x, y)
    else: await pg.mouse.click(x, y)


async def fly_to(pg, ra, dec, why, reduced=False):
    """Click the spot on the 3D sky and wait for its photo. Checks the route the camera took. Returns the spot the app reports."""
    p = await turn_to(pg, ra, dec)
    # the camera's place on every frame from the click to the photo
    await pg.evaluate("""() => { const log = window.__flight = []; const step = () => { const q = window.__x3d.pose(); log.push([...q.cam, window.__x3d.state]); if (log.length < 900 && !(log.length > 3 && window.__x3d.state === 'photo')) requestAnimationFrame(step); }; requestAnimationFrame(step); }""")
    await click_at(pg, *p)
    await pg.wait_for_function(f"{X3D_STATE} === 'photo'", timeout=15000)
    await pg.wait_for_timeout(250)
    spot, pose, log = await pg.evaluate("window.__x3d.spot"), await pg.evaluate(POSE), await pg.evaluate("window.__flight")
    assert spot, f"{why}: no spot after the click"
    off = sep(spot["ra"], spot["dec"], ra, dec)
    check(f"{why}: the click lands on the spot aimed at", off <= 0.05, f"{off:.4f} deg off")
    E, C, L, R = pose["earth"], pose["cam"], pose["look"], pose["R"]
    a, d = math.radians(spot["ra"]), math.radians(spot["dec"])
    eq = (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)); eps = math.radians(23.4392911)
    ecl = (eq[0], math.cos(eps) * eq[1] + math.sin(eps) * eq[2], -math.sin(eps) * eq[1] + math.cos(eps) * eq[2])
    D = (ecl[0], ecl[2], -ecl[1])   # the app's 3D axes: y up is ecliptic north (intro.js v3)
    rel = [C[i] - E[i] for i in range(3)]; along = sum(rel[i] * D[i] for i in range(3))
    perp = math.sqrt(max(0, sum(x * x for x in rel) - along * along)); aim = sum(L[i] * D[i] for i in range(3))
    check(f"{why}: the camera ends on the line of sight from Earth, looking along it", perp < .01 * R and 0 < along < R and aim > .9999, f"{perp / R:.4f} R off the line, {along / R:.2f} R out, aim {aim:.6f}")
    flying = [f for f in log if f[3] == "flying"]
    if reduced:
        check(f"{why}: reduced motion cuts to the photo", len(flying) <= 1, f"{len(flying)} frames in flight")
    else:
        near = min(math.dist(f[:3], E) for f in log) / R
        check(f"{why}: the camera flies, by way of Earth", len(flying) >= 40 and near < .03, f"{len(flying)} frames in flight, nearest {near:.3f} R from Earth")
    return spot


async def lapse_shown(pg):
    """The photo the time-lapse opened on: its MJD, or None if it did not load in time (the worker asks IRSA for the images)."""
    try:
        await pg.wait_for_function("window.__lapse && window.__lapse.state.m && window.__lapse.state.m.frames.length", timeout=40000)
        return await pg.evaluate("(() => { const s = window.__lapse.state; return { mjd: s.m.frames[s.i].mjd, i: s.i, n: s.m.frames.length, diff: s.diff }; })()")
    except Exception:
        return None


async def same_place(b, name, opts, errs, label, target):
    """Check 1 for one target. target is (ra, dec) or a function of the page that returns it."""
    # ---- 3D ----
    pg = await page(b, opts, errs)
    ra, dec = target if isinstance(target, tuple) else await target(pg)
    await to_3d(pg)
    spot = await fly_to(pg, ra, dec, f"{name} {label}")
    await pg.wait_for_selector("#x3d-open", state="visible")
    assert (await pg.inner_text("#x3d-open")).strip().startswith("Open time-lapse here"), "the button does not say Open time-lapse here"
    href3 = await pg.evaluate("document.getElementById('x3d-open').href")
    await press(pg, "#x3d-open"); await pg.wait_for_url("**/timelapse*", timeout=10000)
    at3, shown3 = lapse_addr(pg.url), await lapse_shown(pg)
    check(f"{name} {label}: the button opens the address it shows", lapse_addr(href3) == at3, f"{href3} -> {pg.url}")
    await pg.context.close()
    # ---- flat: zoom far in on the spot (so one pixel is far less than 0.05 degrees), click it, Look closer ----
    pg = await page(b, opts, errs)
    await pg.evaluate("document.querySelectorAll('#ly-known, #ly-comets').forEach(i => { if (i.checked) i.click(); })")   # the click is for the sky, not a comet's dot
    if pg.phone: await pg.evaluate("([ra, dec]) => import('/explore-view.js').then(v => v.flyTo(ra, dec, v.A.min * 60, 0))", [ra, dec])
    else: await pg.evaluate("([ra, dec]) => import('/explore-desktop.js').then(m => m.flyTo(ra, dec, 60))", [ra, dec])
    await pg.wait_for_timeout(1200)
    p = await pg.evaluate("([ra, dec]) => import('/explore-view.js').then(v => v.toScreen(ra, dec))", [ra, dec])
    under = await pg.evaluate("([x, y]) => !!document.elementFromPoint(x, y)?.closest('#map')", p)
    assert under, f"{name} {label}: the flat map's sky is not under the click at {p}"
    await click_at(pg, *p)
    await pg.wait_for_selector("#pin:not([hidden])", timeout=5000)
    hreff = await pg.evaluate("document.querySelector('#pin [data-f=open]').href")
    await pg.evaluate("document.querySelector('#pin [data-f=open]').click()"); await pg.wait_for_url("**/timelapse*", timeout=10000)
    atf, shownf = lapse_addr(pg.url), await lapse_shown(pg)
    assert lapse_addr(hreff) == atf
    await pg.context.close()
    # ---- the two against each other ----
    d = sep(at3[0], at3[1], atf[0], atf[1]); dt = max(sep(at3[0], at3[1], ra, dec), sep(atf[0], atf[1], ra, dec))
    check(f"{name} {label}: 3D and flat open the same RA and Dec", d <= 0.05 and dt <= 0.05, f"3D {at3[0]:.4f} {at3[1]:+.4f}, flat {atf[0]:.4f} {atf[1]:+.4f}: {d:.4f} deg apart, at most {dt:.4f} deg from the target {ra:.4f} {dec:+.4f}")
    check(f"{name} {label}: the same detector, view and day in the address", at3[2] == atf[2], f"3D {at3[2]}, flat {atf[2]}")
    if shown3 and shownf:
        check(f"{name} {label}: the same photo on screen", abs(shown3["mjd"] - shownf["mjd"]) < 1e-6 and shown3["diff"] == shownf["diff"], f"3D photo {shown3['i'] + 1} of {shown3['n']} (MJD {shown3['mjd']:.4f}), flat photo {shownf['i'] + 1} of {shownf['n']} (MJD {shownf['mjd']:.4f})")
    else:
        print(f"NOTE {name} {label}: a time-lapse did not load within 40 s (3D {'loaded' if shown3 else 'no'}, flat {'loaded' if shownf else 'no'}); the photo on screen was not compared, the addresses were")
    return spot


async def atlas(pg):
    return await pg.evaluate(f"(async () => {{ const m = await import('/skymap.js'), {{ comets }} = await (await fetch('/api/comets')).json(); return m.trackAt(comets.find(c => c.id === '3I/ATLAS').track, {DAY}).slice(0, 2); }})()")


async def deep_field(pg):
    return await pg.evaluate("fetch('/data/coverage.json').then(r => r.json()).then(m => { const f = m.deep_fields.reduce((a, b) => (b.dec > a.dec ? b : a)); return [f.ra, f.dec]; })")


async def shot(pg):
    await pg.evaluate("document.activeElement?.blur()")
    if not pg.phone: await pg.mouse.move(700, 12)   # off the map: no coordinates beside the pointer
    await pg.wait_for_timeout(500)
    return Image.open(io.BytesIO(await pg.screenshot(animations="disabled"))).convert("RGB")


def differ(a, b):
    """Pixels that differ between two screenshots."""
    if a.size != b.size: return a.size[0] * a.size[1]
    d = ImageChops.difference(a, b)
    return sum(1 for px in d.getdata() if max(px) > 0) if d.getbbox() else 0


async def stays_put(b, name, opts, errs):
    """Check 2."""
    pg = await page(b, opts, errs)
    vw, vh = pg.viewport_size["width"], pg.viewport_size["height"]
    await pg.evaluate("document.getElementById('ly-people').click()")   # a layer switched: the heat map on
    if pg.phone:
        await pg.evaluate("import('/explore-view.js').then(v => v.flyTo(120, -30, v.A.min * 3.3, 0))")
    else:
        await pg.focus("#map")
        for key in ["+", "+", "ArrowLeft", "ArrowUp"]: await pg.keyboard.press(key); await pg.wait_for_timeout(600)
    await pg.wait_for_timeout(500)
    await click_at(pg, vw * .42, vh * .4); await pg.wait_for_selector("#pin:not([hidden])")
    await pg.wait_for_timeout(900)   # the view is saved in the history entry 300 ms after it settles
    before, pic = await pg.evaluate(STATE), await shot(pg)
    assert before["view"][0] > 1000 and not before["pin"][0], f"the map was not moved or pinned first: {before}"

    for way in ["Escape", "the Flat button"]:
        if pg.phone or way == "the Flat button": await to_3d(pg)
        else:   # from the keyboard
            await pg.focus("#view-3d"); await pg.keyboard.press("Enter")
            await pg.wait_for_function(f"{MODE} === '3d' && {READY}", timeout=60000); await pg.wait_for_timeout(300)
        assert await pg.get_attribute("#view-3d", "aria-pressed") == "true" and await pg.get_attribute("#view-flat", "aria-pressed") == "false"
        assert not await pg.is_visible("#map"), "the flat map still shows under the 3D view"
        # use the 3D view: turn it, zoom it, fly to a photo
        await drag(pg, vw * .5, vh * .45, vw * .7, vh * .52); await drag(pg, vw * .5, vh * .45, vw * .4, vh * .38)
        if not pg.phone:
            await pg.mouse.move(vw * .5, vh * .45)
            for _ in range(4): await pg.mouse.wheel(0, -120); await pg.wait_for_timeout(60)
            for _ in range(4): await pg.mouse.wheel(0, 120); await pg.wait_for_timeout(60)
            for key in ["ArrowLeft", "ArrowUp", "+", "-", "0"]: await pg.keyboard.press(key); await pg.wait_for_timeout(120)
        await fly_to(pg, *BARNARD, f"{name} round trip ({way})")
        if way == "Escape" and not pg.phone:
            await pg.keyboard.press("Escape")
        else: await press(pg, "#view-flat")
        await pg.wait_for_function(f"{MODE} !== '3d'", timeout=5000)
        if way == "Escape" and not pg.phone:
            check(f"{name}: Escape returns to Flat with focus on the switch", await pg.evaluate("document.activeElement?.id") == "view-3d", await pg.evaluate("document.activeElement?.id"))
        assert await pg.get_attribute("#view-flat", "aria-pressed") == "true" and await pg.get_attribute("#view-3d", "aria-pressed") == "false"
        await pg.wait_for_timeout(900)
        after, pic2 = await pg.evaluate(STATE), await shot(pg)
        changed = {k: (before[k], after[k]) for k in before if before[k] != after[k]}
        check(f"{name}: 3D and back by {way} leaves the flat view state identical", not changed, f"changed: {changed}" if changed else f"W X Y {[round(v, 2) for v in after['view'][:3]]}, day {after['day']}")
        n = differ(pic, pic2)
        check(f"{name}: 3D and back by {way} leaves the screenshot identical", n == 0, f"{n} of {pic.size[0] * pic.size[1]} pixels differ")
        if n: pic.save(f"/tmp/x3d-{name}-before.png"); pic2.save(f"/tmp/x3d-{name}-after.png")
    await pg.context.close()


async def speed(b, name, opts, errs):
    """Check 3: frame times while the sky turns and the camera flies."""
    pg = await page(b, opts, errs)
    vw, vh = pg.viewport_size["width"], pg.viewport_size["height"]
    await to_3d(pg)
    await pg.wait_for_timeout(500)
    await pg.evaluate("window.__x3d.perf.frames.length = 0")
    for k in range(4): await drag(pg, vw * .3, vh * .45, vw * .7, vh * (.4 + .03 * k), steps=45, pause=0.016)
    p = await turn_to(pg, *BARNARD)
    for k in range(3):   # three flights: from the whole view, then from one photo to another
        await click_at(pg, *p)
        await pg.wait_for_function(f"{X3D_STATE} === 'flying'", timeout=3000); await pg.wait_for_function(f"{X3D_STATE} === 'photo'", timeout=15000)
        await drag(pg, vw * .45, vh * .3, vw * .55, vh * .34, steps=30, pause=0.016)   # look around from the photo
        p = (vw * (.3 if k == 0 else .66), vh * .3)
        assert await pg.evaluate("([x, y]) => document.elementFromPoint(x, y)?.id === 'x3d-gl' && !!window.__x3d.skyAt(x, y)", list(p)), "no sky to click from the photo"
    f = await pg.evaluate("""(() => { const f = window.__x3d.perf.frames.slice().sort((a, b) => a - b), n = f.length, q = p => +f[Math.min(n - 1, Math.floor(n * p))].toFixed(2);
      return { frames: n, median: q(.5), p95: q(.95), p99: q(.99), worst: +f[n - 1].toFixed(1), over25: f.filter(x => x > 25).length }; })()""")
    check(f"{name}: 60 frames a second in 3D (95th percentile frame time at most 17 ms)", f["frames"] >= 300 and f["p95"] <= 17, f"{f['frames']} frames, median {f['median']} ms, 95th {f['p95']} ms, 99th {f['p99']} ms, worst {f['worst']} ms, {f['over25']} over 25 ms")
    await pg.context.close()


async def lazy_and_keys(b, name, opts, errs):
    """Check 4, the keyboard, reduced motion and the phone's layout."""
    pg = await page(b, opts, errs)
    await pg.wait_for_timeout(1500)
    got = [u for u in pg.fetched if any(k in u for k in LAZY)]
    check(f"{name}: a visit that never presses 3D fetches none of it", not got, f"fetched {got}" if got else f"{len(pg.fetched)} requests, none for {', '.join(LAZY)}")
    box = await pg.locator(".viewsw").bounding_box(); vw, vh = pg.viewport_size["width"], pg.viewport_size["height"]
    sizes = [await pg.locator(s).bounding_box() for s in ("#view-flat", "#view-3d")]
    check(f"{name}: the switch is on screen, each side at least 44 px tall and 44 px wide", box and box["x"] >= 0 and box["x"] + box["width"] <= vw and box["y"] >= 0 and box["y"] + box["height"] <= vh and all(s["height"] >= 43.5 and s["width"] >= 43.5 for s in sizes), f"{box}")
    hit = await pg.evaluate("""() => ['view-flat', 'view-3d'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button')?.id; })""")
    check(f"{name}: nothing covers the switch", hit == ["view-flat", "view-3d"], f"{hit}")
    over = await pg.evaluate("""() => { const a = document.querySelector('.viewsw').getBoundingClientRect(); return [...document.querySelectorAll('.how, #examples > summary, #layers > summary, #whole, .xsearch, .xs-open, .zoomctl, .topbar a, .tl-line')]
      .filter(e => { const r = e.getBoundingClientRect(); return r.width && getComputedStyle(e).visibility !== 'hidden' && r.left < a.right && r.right > a.left && r.top < a.bottom && r.bottom > a.top; }).map(e => e.className || e.id); }""")
    check(f"{name}: the switch overlaps no other control", not over, f"{over}")
    await to_3d(pg)
    got = [u for u in pg.fetched if any(k in u for k in LAZY)]
    check(f"{name}: pressing 3D fetches the 3D code and data", all(any(k in u for u in got) for k in LAZY), f"{len(got)} requests")
    hidden = await pg.evaluate("""() => ['.how', '#examples', '#layers', '.zoomctl', '.xsearch', '#map'].filter(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(), c = getComputedStyle(e);
      return r.width && c.visibility !== 'hidden' && c.display !== 'none'; })""")
    check(f"{name}: the flat map's own controls are put away in 3D", not hidden, f"still showing: {hidden}")
    check(f"{name}: the timeline and the switch stay in 3D", await pg.is_visible("#play") and await pg.is_visible("#view-flat"))
    if not pg.phone:
        # arrows turn the sky, Enter flies to the middle of the view, Tab reaches the button, Escape leaves
        await pg.focus("#x3d-gl")
        p0 = await pg.evaluate(POSE)
        await pg.keyboard.press("ArrowLeft"); await pg.keyboard.press("ArrowUp"); await pg.wait_for_timeout(400)
        p1 = await pg.evaluate(POSE)
        check(f"{name}: the arrow keys turn the 3D sky", math.dist(p0["cam"], p1["cam"]) > .05 * p0["R"], f"camera moved {math.dist(p0['cam'], p1['cam']) / p0['R']:.2f} R")
        flat_before = await pg.evaluate(STATE)
        await pg.keyboard.press("Enter")
        await pg.wait_for_function(f"{X3D_STATE} === 'photo'", timeout=15000)
        for _ in range(4):
            await pg.keyboard.press("Tab")
            if await pg.evaluate("document.activeElement?.id") == "x3d-open": break
        check(f"{name}: Enter flies to the middle of the view and Tab reaches Open time-lapse here", await pg.evaluate("document.activeElement?.id") == "x3d-open" and await pg.evaluate("!!window.__x3d.spot"))
        await pg.keyboard.press("Escape"); await pg.wait_for_function(f"{MODE} !== '3d'", timeout=5000)
        flat_after = await pg.evaluate(STATE)
        check(f"{name}: keys pressed in 3D did not move the flat map", flat_before["view"] == flat_after["view"] and flat_before["rect"] == flat_after["rect"] and flat_before["pin"] == flat_after["pin"])
    await pg.context.close()

    # reduced motion: a cut, no flight
    pg = await page(b, opts, errs, reduced_motion="reduce")
    await to_3d(pg)
    assert await pg.evaluate("window.__x3d.reduced"), "reduced motion was not noticed"
    await fly_to(pg, *BARNARD, f"{name} reduced motion", reduced=True)
    await pg.wait_for_selector("#x3d-open", state="visible")
    await pg.context.close()


async def run(b, name, opts):
    errs = []
    await lazy_and_keys(b, name, opts, errs)
    await stays_put(b, name, opts, errs)
    await speed(b, name, opts, errs)
    for label, target in [("Barnard's Star", BARNARD)] + ([("comet 3I/ATLAS", atlas), ("north deep field", deep_field)] if name == "desktop" else []):
        await same_place(b, name, opts, errs, label, target)
    check(f"{name}: no page errors", not errs, f"{errs}")


async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"])
        for name, opts in SIZES: await run(b, name, opts)
        await b.close()
    print("explore_3d_ui: " + ("all checks passed" if not fails else f"{len(fails)} FAILED: {fails}"))
    sys.exit(1 if fails else 0)

asyncio.run(main())
