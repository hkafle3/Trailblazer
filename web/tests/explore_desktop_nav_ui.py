"""Explore on a desktop (1440 x 900, mouse): pan and zoom the way map apps do (web/explore-desktop.js on web/explore-view.js).
Checks: a wheel and a first drag each stop the replay; the page never scrolls, zoomed in or not; the wheel zooms around the
pointer (a marker's distance from it grows by the zoom within 3%) and dots and names keep their pixel size; a drag of
(-120, -60) moves every marker, the pin and the featured card by it within 2 px and drops no pin; a short click drops a
pin at the clicked RA and Dec (within 0.5 degrees) and the pointer readout shows the zoomed position; a double click zooms
2x and leaves the pin as it was before it (none, or the earlier one); +, - and whole sky, and the + - 0 and arrow keys, do
what they say; a marker click on a zoomed map still opens its comet page.
Run: uv run -q --with playwright python web/tests/explore_desktop_nav_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, math, re, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
PLAYING = "document.getElementById('play').classList.contains('on')"
WRAP = "(() => { const r = document.querySelector('.map-wrap').getBoundingClientRect(); return [r.left, r.top, r.width]; })()"
# visible markers in the window: name, dot centre, dot size, name font size
MARKS = """() => [...document.querySelectorAll('#marks .mk')].filter(m => getComputedStyle(m).display !== 'none' && m.style.visibility !== 'hidden' && !m.hidden)
  .map(m => { const r = m.querySelector('i').getBoundingClientRect(), b = m.querySelector('b');
    return { name: b?.textContent ?? '', x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, font: b ? getComputedStyle(b).fontSize : '' }; })
  .filter(m => m.x > 0 && m.x < innerWidth && m.y > 0 && m.y < innerHeight)"""
# a spot on the sky, inside [x0, y0, x1, y1], with no marker, card or pin within 40 px
EMPTY = """([x0, y0, x1, y1]) => { for (let y = y0; y < y1; y += 13) for (let x = x0; x < x1; x += 17) {
  const e = document.elementFromPoint(x, y); if (!e || !e.closest('#map')) continue;
  if ([...document.querySelectorAll('#marks .mk i, .pin-ring, .mapcard:not([hidden])')].every(i => { const r = i.getBoundingClientRect();
    return !r.width || x < r.left - 40 || x > r.right + 40 || y < r.top - 40 || y > r.bottom + 40; })) return [x, y]; }
  return null; }"""
RECT = "sel => { const r = document.querySelector(sel).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }"
PIN = "(() => { const p = document.getElementById('pin'); return p.hidden ? null : p.querySelector('[data-f=where]').textContent; })()"
R2 = math.sqrt(2)


def inv(u, v):
    """[u, v] across the map -> [ra, dec] in degrees (skymap.js inv)."""
    x, y = (u * 2 - 1) * 2 * R2, (1 - v * 2) * R2
    th = math.asin(y / R2)
    lon = math.pi * x / (2 * R2 * math.cos(th))
    return (-math.degrees(lon)) % 360, math.degrees(math.asin((2 * th + math.sin(2 * th)) / math.pi))


def radec(text):
    ra, dec = re.findall(r"[-+]?\d+\.\d", text)[:2]
    return float(ra), float(dec)


async def sky_at(pg, x, y):
    l, t, w = await pg.evaluate(WRAP)
    return inv((x - l) / w, (y - t) / (w / 2))


async def drag(pg, x, y, dx, dy, steps=12):
    await pg.mouse.move(x, y); await pg.mouse.down()
    for k in range(1, steps + 1):
        await pg.mouse.move(x + dx * k / steps, y + dy * k / steps); await asyncio.sleep(0.016)
    await pg.mouse.up()


async def settle(pg, ms=450):
    await pg.wait_for_timeout(ms)


async def explore(pg, url):
    await pg.goto(BASE + url)
    await pg.wait_for_selector("body[data-ready='1']"); await pg.wait_for_selector(".mk.known", state="attached")
    await pg.evaluate("Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        await ctx.add_init_script("localStorage.setItem('ch.tour','1')")
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        # ---- the replay stops on the first wheel and on the first drag ----
        await explore(pg, "/explore.html")
        assert await pg.evaluate(PLAYING), "the replay is not playing on open"
        await pg.mouse.move(720, 450); await pg.mouse.wheel(0, -60); await settle(pg, 200)
        assert not await pg.evaluate(PLAYING), "a wheel did not stop the replay"
        await explore(pg, "/explore.html")
        assert await pg.evaluate(PLAYING), "the replay is not playing on open"
        ex, ey = await pg.evaluate(EMPTY, [500, 300, 1000, 650])
        w0 = await pg.evaluate(WRAP)
        await drag(pg, ex, ey, -120, -60)
        assert not await pg.evaluate(PLAYING), "a drag did not stop the replay"
        assert await pg.evaluate(PIN) is None, "a drag dropped a pin"
        await settle(pg)
        assert all(abs(a - b) < 1 for a, b in zip(await pg.evaluate(WRAP), w0)), "a drag on the whole sky did not spring back"
        print("PASS replay: a first wheel and a first drag each stop it; a drag on the whole sky drops no pin and springs back")

        await explore(pg, "/explore.html?day=529")
        await pg.evaluate("Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))")
        base = (await pg.evaluate(WRAP))[2]

        # ---- wheel: zoom around the pointer, dots and names keep their size ----
        px, py = await pg.evaluate(EMPTY, [560, 330, 900, 600])
        before = {m["name"]: m for m in await pg.evaluate(MARKS) if m["name"]}
        await pg.mouse.move(px, py); await pg.mouse.wheel(0, -100); await settle(pg, 200)
        after = {m["name"]: m for m in await pg.evaluate(MARKS) if m["name"]}
        f = (await pg.evaluate(WRAP))[2] / base
        assert f > 1.15, f"the wheel zoomed by only {f:.3f}"
        n = 0
        for name, a in before.items():
            if name not in after: continue
            z = after[name]
            d0, d1 = math.hypot(a["x"] - px, a["y"] - py), math.hypot(z["x"] - px, z["y"] - py)
            if d0 < 40: continue
            assert abs(d1 / d0 - f) / f < 0.03, f"{name}: its distance from the pointer grew {d1 / d0:.3f}x, the map {f:.3f}x"
            assert (a["w"], a["h"], a["font"]) == (z["w"], z["h"], z["font"]), f"{name}: dot or name changed size with the zoom"
            n += 1
        assert n >= 5, f"only {n} markers to compare"
        print(f"PASS wheel: {f:.2f}x around the pointer, {n} markers grew their distance from it by that within 3%, dots and names the same size")

        sc = await pg.evaluate("[document.scrollingElement.scrollWidth, document.scrollingElement.scrollHeight, innerWidth, innerHeight, scrollX, scrollY]")
        assert sc[0] <= sc[2] and sc[1] <= sc[3] and sc[4] == sc[5] == 0, f"the page scrolls when zoomed: {sc}"
        print("PASS fit: zoomed in, the page still does not scroll")

        # ---- drag: markers, pin and card move with it, no pin dropped ----
        await pg.keyboard.press("Escape")
        before = await pg.evaluate(MARKS)
        ex, ey = await pg.evaluate(EMPTY, [400, 250, 1100, 700])
        await drag(pg, ex, ey, -120, -60); await settle(pg, 100)
        assert await pg.evaluate(PIN) is None, "a drag dropped a pin"
        after = await pg.evaluate(MARKS)
        bad = [m for m in after if not any(abs(m["x"] - (a["x"] - 120)) <= 2 and abs(m["y"] - (a["y"] - 60)) <= 2 and m["name"] == a["name"] for a in before)
               and 140 < m["x"] < 1300 and 140 < m["y"] < 760]
        assert len(after) >= 5 and not bad, f"markers that did not follow the drag: {bad[:3]}"
        # with a pin and the card: they follow too, and the pin stays the same
        sx, sy = await pg.evaluate(EMPTY, [500, 300, 1000, 650])
        await pg.mouse.click(sx, sy); await settle(pg, 100)
        text = await pg.evaluate(PIN)
        pin0, card0 = await pg.evaluate(RECT, ".pin-ring"), await pg.evaluate(RECT, "#card-comet")
        ex, ey = await pg.evaluate(EMPTY, [400, 250, 1100, 700])
        await drag(pg, ex, ey, 120, 60); await settle(pg, 100)   # back again: the first drag took the view near its edge
        pin1, card1 = await pg.evaluate(RECT, ".pin-ring"), await pg.evaluate(RECT, "#card-comet")
        assert await pg.evaluate(PIN) == text, "a drag moved or dropped the pin"
        for what, a, z in [("pin", pin0, pin1), ("3I/ATLAS card", card0, card1)]:
            assert abs(z[0] - a[0] - 120) <= 2 and abs(z[1] - a[1] - 60) <= 2, f"the {what} moved by {z[0] - a[0]:.1f}, {z[1] - a[1]:.1f}"
        print(f"PASS drag: (-120, -60) moved all {len(after)} markers on screen, and a drag back moved the pin and the 3I/ATLAS card by it within 2 px, and dropped no pin")

        # ---- short click: a pin at the clicked RA and Dec; the readout shows the zoomed position ----
        await pg.keyboard.press("Escape")
        cx, cy = await pg.evaluate(EMPTY, [450, 280, 1000, 650])
        await pg.mouse.move(cx, cy)
        rd = radec(await pg.evaluate("document.getElementById('readout').textContent"))
        want = await sky_at(pg, cx, cy)
        assert abs((rd[0] - want[0] + 180) % 360 - 180) <= 0.15 and abs(rd[1] - want[1]) <= 0.15, f"readout {rd}, under the pointer {want}"
        await pg.mouse.click(cx, cy); await settle(pg, 100)
        got = radec(await pg.evaluate(PIN))
        assert abs((got[0] - want[0] + 180) % 360 - 180) <= 0.5 and abs(got[1] - want[1]) <= 0.5, f"pin at {got}, clicked {want}"
        ring = await pg.evaluate(RECT, ".pin-ring")
        assert math.hypot(ring[0] - cx, ring[1] - cy) <= 2, f"the pin is drawn at {ring}, clicked {cx, cy}"
        first_pin = await pg.evaluate(PIN)
        print(f"PASS click: a short click drops the pin at RA {got[0]} Dec {got[1]} (clicked {want[0]:.2f}, {want[1]:.2f}); the readout follows the zoom")

        # ---- double click: 2x, and the pin as it was (the earlier one, then none) ----
        w0 = (await pg.evaluate(WRAP))[2]
        dx, dy = await pg.evaluate(EMPTY, [450, 280, 1000, 650])
        await pg.mouse.dblclick(dx, dy); await settle(pg)
        w1 = (await pg.evaluate(WRAP))[2]
        assert abs(w1 / w0 - 2) < 0.01, f"a double click zoomed {w1 / w0:.3f}x"
        assert await pg.evaluate(PIN) == first_pin, "a double click left a stray pin instead of the earlier one"
        await pg.keyboard.press("Escape"); await pg.click("#zoom-whole"); await settle(pg)
        assert abs((await pg.evaluate(WRAP))[2] - base) < 1, "whole sky did not return to the whole oval"
        dx, dy = await pg.evaluate(EMPTY, [500, 300, 1000, 650])
        await pg.mouse.dblclick(dx, dy); await settle(pg)
        w2 = (await pg.evaluate(WRAP))[2]
        assert abs(w2 / base - 2) < 0.01 and await pg.evaluate(PIN) is None, f"double click from the whole sky: {w2 / base:.3f}x, pin {await pg.evaluate(PIN)}"
        print(f"PASS double click: 2x ({w0:.0f} to {w1:.0f} px, {base:.0f} to {w2:.0f} px), no stray pin, an earlier pin kept")

        # ---- buttons and keys ----
        await pg.click("#zoom-whole"); await settle(pg)
        assert await pg.evaluate("document.getElementById('zoom-out').disabled && document.getElementById('zoom-whole').disabled"), "- and whole sky should be off on the whole sky"
        await pg.click("#zoom-in"); await settle(pg)
        assert abs((await pg.evaluate(WRAP))[2] / base - 1.5) < 0.01, "+ did not zoom in 1.5x"
        await pg.click("#zoom-out"); await settle(pg)
        assert abs((await pg.evaluate(WRAP))[2] - base) < 1, "- did not zoom back out"
        await pg.focus("#map")
        await pg.keyboard.press("+"); await settle(pg)
        assert abs((await pg.evaluate(WRAP))[2] / base - 1.5) < 0.01, "the + key did not zoom in"
        await pg.keyboard.press("+"); await settle(pg)
        l0 = await pg.evaluate(WRAP)
        await pg.keyboard.press("ArrowLeft"); await settle(pg, 300)
        await pg.keyboard.press("ArrowUp"); await settle(pg, 300)
        l1 = await pg.evaluate(WRAP)
        assert abs(l1[0] - l0[0] - 100) < 1 and abs(l1[1] - l0[1] - 100) < 1, f"arrow keys moved the map by {l1[0] - l0[0]:.0f}, {l1[1] - l0[1]:.0f}"
        await pg.keyboard.press("-"); await settle(pg)
        assert abs((await pg.evaluate(WRAP))[2] / base - 1.5) < 0.01, "the - key did not zoom out"
        await pg.keyboard.press("0"); await settle(pg)
        assert abs((await pg.evaluate(WRAP))[2] - base) < 1, "the 0 key did not show the whole sky"
        print("PASS controls: + 1.5x, - back, whole sky; keys + and - zoom, arrows move the map 100 px, 0 shows the whole sky")

        # ---- a marker on a zoomed map still opens its comet page ----
        await pg.click("#zoom-in"); await settle(pg)
        mk = await pg.evaluate("""() => { for (const a of document.querySelectorAll('#marks a.mk.known[href^="comet.html"]')) {
            const r = a.querySelector('i').getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
            if (r.width && x > 200 && x < innerWidth - 200 && y > 150 && y < 700 && document.elementFromPoint(x, y)?.closest('.mk') === a) return [x, y, a.getAttribute('href')]; } return null; }""")
        assert mk, "no known comet marker to click on the zoomed map"
        await pg.mouse.click(mk[0], mk[1])
        await pg.wait_for_url(re.compile(r"/comet(\.html)?\?id="), timeout=10000)
        print(f"PASS marker: on a zoomed map a click on a known comet opens its page ({mk[2]})")

        assert not errors, f"page errors: {errors}"
        await b.close()


asyncio.run(main())
