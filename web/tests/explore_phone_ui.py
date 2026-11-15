"""Explore on a phone (direction A, full-screen map), in Chrome as an iPhone 14 (390 x 844, touch, mobile).
Touches are real touch events sent through the DevTools protocol (Input.dispatchTouchEvent), one or two fingers.
Checks: the page never scrolls, down or sideways; a first touch stops the replay; one finger pans the map (a marker moves
by the drag within 2 px); two fingers zoom around their midpoint (a marker's distance from it grows by the zoom within 3%)
while the page's own zoom stays 1 and dots and names keep their pixel size; a double tap zooms in 2x; the whole-sky
button goes to the whole oval and back; Layers opens a bottom sheet with rows of 44 px or more whose checkboxes switch
the layers; tapping 3I/ATLAS opens a peek sheet and stays on the page, a swipe up expands it, its arrow opens the comet
page; every tap target on screen is 44 px or more (markers by their invisible tap circle); sheet and timeline tops are a
straight 2 px white rule on square corners.
Run: uv run -q --with playwright python web/tests/explore_phone_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, math, pathlib, re, subprocess, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
PLAYING = "document.getElementById('play').classList.contains('on')"
WRAP = "(() => { const r = document.querySelector('.map-wrap').getBoundingClientRect(); return [r.left, r.top, r.width]; })()"
# visible markers well inside the map area: name, dot centre, dot size, name font size
MARKS = """() => [...document.querySelectorAll('#marks .mk')].filter(m => getComputedStyle(m).display !== 'none' && m.style.visibility !== 'hidden' && !m.hidden)
  .map(m => { const r = m.querySelector('i').getBoundingClientRect(), b = m.querySelector('b');
    return { name: b?.textContent ?? '', x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, font: b ? getComputedStyle(b).fontSize : '' }; })"""
EMPTY = """([x0, y0, x1, y1]) => { for (let y = y0; y < y1; y += 13) for (let x = x0; x < x1; x += 17) {   // a spot on the sky with no marker within 30 px
  const e = document.elementFromPoint(x, y); if (!e || !e.closest('#map')) continue;
  if ([...document.querySelectorAll('#marks .mk i, .pin')].every(i => { const r = i.getBoundingClientRect(); return !r.width || Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y) > 30; })) return [x, y]; }
  return null; }"""
# every tap target on screen smaller than 44 px; markers are measured by their invisible tap circle (i::before)
SMALL = """() => { const bad = [], seen = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.pointerEvents !== 'none' && !e.closest('[hidden]'); };
  for (const e of document.querySelectorAll('a[href], button, summary, label, input:not([type=hidden]):not(label input), select, textarea, [role=slider], [tabindex]:not([tabindex="-1"])')) {
    if (e.closest('.mk') || !seen(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 44 - .5 || r.height < 44 - .5) bad.push(`${e.tagName.toLowerCase()}.${[...e.classList].join('.')} "${(e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`); }
  for (const m of document.querySelectorAll('#marks .mk')) {
    const i = m.querySelector('i'), r = i.getBoundingClientRect();
    if (!r.width || getComputedStyle(m).display === 'none' || m.style.visibility === 'hidden' || r.right < 0 || r.left > innerWidth || r.bottom < 0 || r.top > innerHeight) continue;
    const s = getComputedStyle(i, '::before');
    if (parseFloat(s.width) < 44 || parseFloat(s.height) < 44) bad.push(`marker ${m.querySelector('b')?.textContent} tap circle ${s.width}`); }
  return bad; }"""
# a top rule: 2 px white on square top corners
RULE = """sel => { const e = document.querySelector(sel), s = getComputedStyle(e);
  return [s.borderTopWidth, s.borderTopColor, s.borderTopLeftRadius, s.borderTopRightRadius]; }"""


class Touch:
    def __init__(self, cdp): self.cdp = cdp

    async def send(self, kind, pts):
        await self.cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})

    async def gesture(self, start, end, steps=12):
        """Fingers from start points to end points (one or two), in steps."""
        await self.send("touchStart", start)
        for k in range(1, steps + 1):
            await self.send("touchMove", [(a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps) for a, b in zip(start, end)])
            await asyncio.sleep(0.016)
        await self.send("touchEnd", [])

    async def tap(self, x, y):
        await self.send("touchStart", [(x, y)]); await asyncio.sleep(0.03); await self.send("touchEnd", [])


async def center(pg, sel):
    r = await pg.locator(sel).first.bounding_box()
    return r["x"] + r["width"] / 2, r["y"] + r["height"] / 2


async def home(pg, t):
    """The first view (centred on 3I/ATLAS): whole sky first, then the button's second tap."""
    for _ in range(2):
        if await pg.locator(".whole.on").count(): break
        await t.tap(*await center(pg, ".whole")); await pg.wait_for_timeout(450)
    await t.tap(*await center(pg, ".whole")); await pg.wait_for_timeout(450)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
        await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
        pg = await ctx.new_page()
        errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
        t = Touch(await ctx.new_cdp_session(pg))

        # the replay plays on open; a first touch on the map stops it
        await pg.goto(BASE + "/explore.html"); await pg.wait_for_selector("body[data-ready='1']")
        assert await pg.evaluate(PLAYING), "the replay is not playing on open"
        spot = await pg.evaluate(EMPTY, [60, 200, 330, 600])
        await t.send("touchStart", [spot]); await t.send("touchEnd", [])
        await pg.wait_for_timeout(100)
        assert not await pg.evaluate(PLAYING), "a touch on the map did not stop the replay"
        # and on the timeline
        await pg.reload(); await pg.wait_for_selector("body[data-ready='1']")
        assert await pg.evaluate(PLAYING)
        x, y = await center(pg, "#tl-line"); await t.tap(x - 100, y)
        assert not await pg.evaluate(PLAYING), "a touch on the timeline did not stop the replay"
        print("PASS replay: plays on open, and a first touch on the map or on the timeline stops it")

        await pg.reload(); await pg.wait_for_selector("body[data-ready='1']")
        await pg.wait_for_function(f"!({PLAYING})", timeout=60000); await pg.wait_for_timeout(1200)   # the replay ends; the map has scaled in

        # the page never scrolls
        size = await pg.evaluate("[document.documentElement.scrollHeight, document.documentElement.scrollWidth, document.body.scrollHeight, innerHeight, innerWidth]")
        await pg.mouse.wheel(0, 600); await t.gesture([(200, 300)], [(200, 120)]); await pg.wait_for_timeout(100)
        assert size[0] == size[3] and size[2] <= size[3], f"the page is {size[0]} px tall in a {size[3]} px window"
        assert size[1] == size[4], f"the page is {size[1]} px wide in a {size[4]} px window"
        assert await pg.evaluate("scrollY") == 0 and await pg.evaluate("scrollX") == 0, "the page scrolled"
        print(f"PASS fit: the page is exactly {size[4]} x {size[3]}, nothing scrolls down or sideways")
        await home(pg, t)

        # one finger pans: every marker moves by the drag
        before = {m["name"]: m for m in await pg.evaluate(MARKS)}
        a = await pg.evaluate(EMPTY, [80, 250, 300, 500])
        await t.gesture([a], [(a[0] - 80, a[1] + 60)]); await pg.wait_for_timeout(200)
        after = {m["name"]: m for m in await pg.evaluate(MARKS)}
        common = [n for n in before if n in after and n]
        assert common, "no marker to follow"
        for n in common:
            dx, dy = after[n]["x"] - before[n]["x"], after[n]["y"] - before[n]["y"]
            assert abs(dx + 80) <= 2 and abs(dy - 60) <= 2, f"drag of (-80, +60) moved {n} by ({dx:.1f}, {dy:.1f})"
        assert (await pg.evaluate("location.pathname")).startswith("/explore") and await pg.locator("#csheet").is_hidden(), "a drag opened something"
        print(f"PASS pan: a one-finger drag of (-80, +60) px moves all {len(common)} markers by it within 2 px")

        # double tap zooms in 2x around the tap
        w0 = (await pg.evaluate(WRAP))[2]
        a = await pg.evaluate(EMPTY, [80, 250, 300, 500])
        await t.tap(*a); await pg.wait_for_timeout(120); await t.tap(*a); await pg.wait_for_timeout(500)
        w1 = (await pg.evaluate(WRAP))[2]
        assert abs(w1 / w0 - 2) < .02, f"a double tap zoomed {w1 / w0:.2f}x"
        print(f"PASS double tap: the map zooms 2x ({w0:.0f} to {w1:.0f} px wide)")

        # the whole-sky button: the whole oval as wide as the screen, then back to the first view
        await t.tap(*await center(pg, ".whole")); await pg.wait_for_timeout(500)
        x0, y0, w = await pg.evaluate(WRAP)
        assert abs(w - 390) < 1 and abs(x0) < 1 and await pg.locator(".whole.on").count() == 1, f"whole sky: map at {x0:.0f}, {w:.0f} px wide"
        await t.tap(*await center(pg, ".whole")); await pg.wait_for_timeout(500)
        assert (await pg.evaluate(WRAP))[2] > 1000 and await pg.locator(".whole.on").count() == 0, "the whole-sky button did not come back"
        print("PASS whole sky: the button shows the whole oval across the screen, and a second tap returns")

        # two fingers zoom around their midpoint; the page itself never zooms; dots and names keep their size
        mid = (195, 420)
        before = {m["name"]: m for m in await pg.evaluate(MARKS)}
        w0 = (await pg.evaluate(WRAP))[2]
        await t.gesture([(mid[0] - 50, mid[1] - 20), (mid[0] + 50, mid[1] + 20)], [(mid[0] - 90, mid[1] - 36), (mid[0] + 90, mid[1] + 36)], steps=16)
        await pg.wait_for_timeout(300)
        k = (await pg.evaluate(WRAP))[2] / w0
        after = {m["name"]: m for m in await pg.evaluate(MARKS)}
        assert abs(k - 1.8) < .03, f"fingers spread 1.8x, the map zoomed {k:.3f}x"
        checked = 0
        for n in before:
            if n not in after or not n: continue
            d0 = math.hypot(before[n]["x"] - mid[0], before[n]["y"] - mid[1]); d1 = math.hypot(after[n]["x"] - mid[0], after[n]["y"] - mid[1])
            if d0 < 20: continue
            assert abs(d1 / d0 / k - 1) < .03, f"{n}: {d0:.0f} px from the midpoint became {d1:.0f} ({d1 / d0:.3f}x), the map zoomed {k:.3f}x"
            assert abs(after[n]["w"] - before[n]["w"]) < .5 and after[n]["font"] == before[n]["font"], f"{n}: the dot or name changed size with the zoom"
            checked += 1
        assert checked, "no marker to measure"
        scale = await pg.evaluate("visualViewport.scale")
        assert scale == 1, f"the page itself zoomed to {scale}"
        print(f"PASS pinch: {k:.2f}x around the midpoint, {checked} markers kept their direction and grew by it within 3%, dots and names the same size, page zoom {scale}")

        # tap targets in the resting view
        bad = await pg.evaluate(SMALL)
        assert not bad, f"tap targets under 44 px: {bad}"

        # Layers: a bottom sheet with 52 px rows; the checkboxes switch layers
        await t.tap(*await center(pg, "#layers > summary")); await pg.wait_for_timeout(400)
        body = pg.locator("#layers .layers-body")
        box = await body.bounding_box()
        assert await body.is_visible() and abs(box["y"] + box["height"] - 844) < 1 and box["width"] == 390, f"Layers is not a bottom sheet: {box}"
        rows = await pg.evaluate("[...document.querySelectorAll('#layers .layer')].map(l => l.getBoundingClientRect().height)")
        assert len(rows) == 6 and min(rows) >= 44, f"Layers rows: {rows}"
        bad = await pg.evaluate(SMALL)
        assert not bad, f"tap targets under 44 px with Layers open: {bad}"
        await t.tap(*await center(pg, "label:has(#ly-people)")); await pg.wait_for_timeout(500)
        assert await pg.evaluate("document.getElementById('ly-people').checked") and await pg.evaluate("getComputedStyle(document.querySelector('.map .heat')).opacity") == "1", "Heat map did not switch on"
        await t.tap(*await center(pg, "label:has(#ly-known)")); await pg.wait_for_timeout(100)
        assert await pg.evaluate("[...document.querySelectorAll('.mk.known')].every(m => getComputedStyle(m).display === 'none')"), "Known objects did not switch off"
        await t.tap(*await center(pg, "label:has(#ly-known)")); await t.tap(*await center(pg, "label:has(#ly-people)")); await pg.wait_for_timeout(100)
        assert await pg.evaluate("document.getElementById('ly-known').checked && !document.getElementById('ly-people').checked")
        assert (await pg.evaluate("location.pathname")).startswith("/explore")
        await t.tap(*await center(pg, "#layers .sheet-x")); await pg.wait_for_timeout(200)
        assert not await pg.evaluate("document.getElementById('layers').open"), "the close button did not close Layers"
        await t.tap(*await center(pg, "#layers > summary")); await pg.wait_for_timeout(300)
        g = await center(pg, "#layers .grab"); await t.gesture([g], [(g[0], g[1] + 160)], steps=8); await pg.wait_for_timeout(200)
        assert not await pg.evaluate("document.getElementById('layers').open"), "a swipe down did not close Layers"
        print(f"PASS layers: a bottom sheet with {len(rows)} rows of {min(rows):.0f} px or more; Heat map and Known objects switch; X and a swipe down close it")

        # tap 3I/ATLAS: a peek sheet, the page stays; swipe up expands it; its arrow opens the comet page
        await home(pg, t)
        dot = await pg.evaluate("(() => { const r = document.querySelector('.mk.sel i').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
        await t.tap(dot[0] + 12, dot[1] + 12); await pg.wait_for_timeout(500)   # inside the 44 px tap circle, off the 6 px dot
        sheet = pg.locator("#csheet")
        assert await sheet.is_visible() and (await pg.evaluate("location.pathname")).startswith("/explore"), "tapping 3I/ATLAS did not open the peek sheet, or left the page"
        name, what, when = [await sheet.locator(f"[data-f={f}]").text_content() for f in ("name", "what", "when")]
        assert name == "3I/ATLAS" and what == "CO2 glow detected" and when.startswith("Position on "), f"sheet: {name!r} {what!r} {when!r}"
        peek = (await sheet.bounding_box())["height"]
        bad = await pg.evaluate(SMALL)
        assert not bad, f"tap targets under 44 px with the sheet open: {bad}"
        c = await center(pg, "#csheet .ch h3"); await t.gesture([c], [(c[0], c[1] - 200)], steps=8); await pg.wait_for_timeout(500)
        full = (await sheet.bounding_box())["height"]
        assert full > peek + 150 and await sheet.locator("[data-f=open]").is_visible(), f"a swipe up did not expand the sheet ({peek:.0f} to {full:.0f} px)"
        bad = await pg.evaluate(SMALL)
        assert not bad, f"tap targets under 44 px with the sheet expanded: {bad}"
        rules = {s: await pg.evaluate(RULE, s) for s in ("#csheet", ".tl")}
        await t.tap(*await center(pg, "#csheet .ch .go"))
        await pg.wait_for_url(re.compile(r"/comet(\.html)?\?id=3I%2FATLAS"), timeout=5000)
        print(f"PASS comet: a tap opens a {peek:.0f} px peek ({name}, {what}, {when}) on the same page; a swipe up expands it to {full:.0f} px; its arrow opens the comet page")
        print("PASS tap targets: every control, link and marker tap circle on screen is 44 px or more (resting, Layers open, peek, expanded)")

        # straight top rules: computed, then the stylesheet scan
        await pg.go_back(); await pg.wait_for_selector("body[data-ready='1']")
        await t.tap(*await center(pg, "#layers > summary")); await pg.wait_for_timeout(300)
        rules["#layers .layers-body"] = await pg.evaluate(RULE, "#layers .layers-body")
        for s, (wd, col, l, r) in rules.items():
            assert wd == "2px" and col == "rgb(255, 255, 255)" and l == "0px" and r == "0px", f"{s}: top rule {wd} {col}, corners {l} {r}"
        out = subprocess.run(["node", str(pathlib.Path(__file__).with_name("straight_rules.mjs"))], capture_output=True, text=True)
        assert out.returncode == 0, out.stdout + out.stderr
        print("PASS straight rules: timeline, Layers sheet and comet sheet tops are 2 px white on square corners; " + out.stdout.strip())

        assert not errors, f"page errors: {errors}"
        await b.close()


asyncio.run(main())
