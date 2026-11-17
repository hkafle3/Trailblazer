"""Explore, desktop (1440 x 900, Chrome): zooming anchors at the pointer, and the page itself never zooms over the map.
A trackpad pinch is sent the way a Mac trackpad sends it (CDP Input.synthesizePinchGesture from a touchpad: wheel events
with ctrlKey, which zoom the page's visual viewport unless the page prevents them). Every wheel event is logged with
whether its default was prevented.
Checks: at a point off the middle, the sky under the pointer stays under it (within 2 px) on every step of a plain
scroll and of a pinch, from the whole sky to the deepest zoom; every wheel event over the map is prevented and
visualViewport.scale stays 1; a pinch that starts at the deepest zoom dives to the sky under the pointer (the hover
readout's coordinates), and the page does not zoom while the dive flies, even as the pinch carries on; a scroll that
dives does the same at another point; after an off-centre dive, or an off-centre zoom that stops short, the map is drawn
where the engine's numbers put it; "Dive in" after a partial off-centre scroll opens the middle; with the middle of the
view off the sky oval (near the north pole), a pinch over sky dives there, and a second one does too; a Safari trackpad
pinch (gesture events, dispatched here as plain events, so only the page's handling is checked) is prevented, zooms
around the pointer, and at the deepest zoom dives to the sky under it, while one that arrives there and pauses does
not; on a phone, a pinch at the deepest zoom that a third finger ends puts the aim and "Dive in" back in the middle, and
a lopsided pinch (one finger still, so the sky follows the midpoint) dives to the sky between the fingers.
Run: uv run -q --with playwright python web/tests/zoom_anchor_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, math, re, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
LOG = """window.__wheels = []; addEventListener('wheel', e => { const r = { ctrl: e.ctrlKey }; __wheels.push(r); setTimeout(() => { r.prevented = e.defaultPrevented; }); }, { capture: true, passive: true });"""
SKY = "(async ([x, y]) => { const v = await import('/explore-view.js'); return v.A && v.W ? { sky: v.skyAt(x, y), W: v.W, max: v.atMax() } : null; })"
OFF = "(async ([x, y, ra, dec]) => { const v = await import('/explore-view.js'); const [px, py] = v.toScreen(ra, dec); return Math.hypot(px - x, py - y); })"
# the map as drawn against the engine's numbers: a mark placed in .map-wrap at the map fraction the engine puts under each
# window point, and how far from that point the browser draws it (the largest of five points, in px)
DRAWN = """(async () => { const v = await import('/explore-view.js'), wrap = document.querySelector('.map-wrap'); let worst = 0;
  for (const [x, y] of [[720, 434], [300, 200], [1200, 250], [250, 700], [1150, 680]]) {
    const [u, w] = v.uvAt(x, y), m = document.createElement('i');
    m.style.cssText = `position: absolute; width: 0; height: 0; left: ${u * 100}%; top: ${w * 100}%`;
    wrap.append(m); const r = m.getBoundingClientRect(); m.remove(); worst = Math.max(worst, Math.hypot(r.x - x, r.y - y)); }
  return worst; })()"""
WHEELS = "(() => { const w = __wheels.splice(0); return { n: w.length, open: w.filter(r => !r.prevented).length }; })()"
fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    if not ok: fails.append(name)


def sep(ra1, dec1, ra2, dec2):   # degrees between two sky positions
    a1, d1, a2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    return math.degrees(math.acos(min(1, math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(a1 - a2))))


def spot(url):
    m = re.search(r"timelapse(?:\.html)?\?ra=([\d.]+)&dec=(-?[\d.]+)", url)
    return (float(m[1]), float(m[2])) if m else None


async def until(pg, expr, ms=8000):
    try: await pg.wait_for_function(expr, timeout=ms); return True
    except Exception: return False


async def page(p):
    # a browser for each page: a pinch synthesized in a second context of one browser is refused as out of bounds
    browser = await p.chromium.launch(channel="chrome", headless=True, args=["--window-size=1440,900"])
    ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
    await ctx.add_init_script(LOG)
    pg = await ctx.new_page()
    pg.on("pageerror", lambda e: fails.append(f"page error: {e}") or print("FAIL page error", e))
    await pg.goto(f"{BASE}/explore.html?day=400")
    await pg.wait_for_function("document.body.dataset.ready === '1'")
    await pg.bring_to_front()   # a synthesized pinch goes to the page in front
    pg.cdp = await ctx.new_cdp_session(pg)
    return browser, pg


async def wheel(pg, x, y, dy=-250):
    await pg.cdp.send("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": x, "y": y, "deltaX": 0, "deltaY": dy})


async def pinch(pg, x, y, f=1.7):
    await pg.cdp.send("Input.synthesizePinchGesture", {"x": x, "y": y, "scaleFactor": f, "relativeSpeed": 800, "gestureSourceType": "mouse"})


async def scroll(pg, x, y, n, dy=-100):
    """n wheel notches as one scroll, 25 ms apart, the way a wheel sends them"""
    for _ in range(n):
        asyncio.ensure_future(wheel(pg, x, y, dy))
        await asyncio.sleep(0.025)
    await asyncio.sleep(0.4)


async def anchored(p, kind, x, y):
    browser, pg = await page(p)
    await pg.mouse.move(x, y)
    worst, steps, levels = 0, 0, []
    for _ in range(16):
        a = await pg.evaluate(SKY, [x, y])
        if a and a["max"]: break   # a new zoom from here would dive (checked below)
        await (wheel(pg, x, y) if kind == "scroll" else pinch(pg, x, y))
        await asyncio.sleep(0.3)
        if a and a["sky"]:
            worst = max(worst, await pg.evaluate(OFF, [x, y, *a["sky"]])); steps += 1; levels.append(round(a["W"]))
    w = await pg.evaluate(WHEELS)
    v = await pg.evaluate(SKY, [x, y])
    check(f"{kind} at ({x}, {y}): the sky under the pointer stays under it, whole sky to deepest", steps >= 6 and worst < 2 and v["max"], f"{steps} steps, W {levels[0] if levels else '?'} to {levels[-1] if levels else '?'}, worst {worst:.2f} px")
    check(f"{kind}: every wheel event over the map is prevented and the page does not zoom", w["n"] > 0 and w["open"] == 0 and await pg.evaluate("visualViewport.scale") == 1, f"{w['open']} of {w['n']} not prevented, scale {await pg.evaluate('visualViewport.scale'):.3f}")
    await browser.close()


async def dives(p):
    browser, pg = await page(p)
    x, y = 1000, 300   # well off the middle of the view (720, 434)
    await pg.mouse.move(x, y)
    await scroll(pg, x, y, 40)   # one long scroll: it stops at the deepest zoom and does not dive
    check("a long scroll reaches the deepest zoom without diving", (await pg.evaluate(SKY, [x, y]))["max"] and "/explore" in pg.url)
    await pg.mouse.move(x + 1, y); await pg.mouse.move(x, y); await asyncio.sleep(0.3)
    readout = await pg.locator("#readout").text_content()
    here = (await pg.evaluate(SKY, [x, y]))["sky"]
    await pg.evaluate(WHEELS)

    # a pinch that starts at the deepest zoom, and carries on while the dive flies
    scales = []
    async def watch():
        for _ in range(40):
            try: scales.append(await pg.evaluate("visualViewport.scale"))
            except Exception: return
            await asyncio.sleep(0.05)
    watcher = asyncio.ensure_future(watch())
    await pinch(pg, x, y, 3)
    await pinch(pg, x, y, 1.5)   # still pinching after the dive took off
    await watcher
    w = await pg.evaluate(WHEELS)
    check("a pinch at the deepest zoom dives", await until(pg, "window.__diveState()?.phase === 'open'"))
    check("the page does not zoom while the pinch starts the dive and the dive flies", max(scales) == 1 and w["open"] == 0, f"largest scale {max(scales):.3f}, {w['open']} of {w['n']} wheel events not prevented")
    at = spot(pg.url)
    off = sep(*at, *here) if at else 99
    check("the pinch dives to the sky under the pointer", off < 0.005, f"pointer {here[0]:.4f} {here[1]:.4f} (readout {readout}), dive {pg.url.split('?')[-1]}, {off:.4f} deg off")
    rd = [float(s) for s in re.findall(r"-?[\d.]+", (readout or "").replace("+", ""))]
    check("that is where the hover readout said", at and len(rd) == 2 and abs(rd[0] - at[0]) < 0.06 and abs(rd[1] - at[1]) < 0.06, f"readout {readout}")
    await pg.go_back()
    check("back closes the dive", await until(pg, "window.__diveState() === null && location.pathname.includes('explore')"))
    await asyncio.sleep(0.3)
    d = await pg.evaluate(DRAWN)
    check("back from an off-centre dive, the map is drawn where its coordinates say", d < 1, f"{d:.1f} px off")

    # a plain scroll at another point: while it adds up, the aim is there; one that stops short sends it back to the middle
    x, y = 420, 560
    await pg.mouse.move(x, y); await asyncio.sleep(0.4)
    here = (await pg.evaluate(SKY, [x, y]))["sky"]
    centre = "(() => { const r = document.querySelector('.aim-box').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()"
    await scroll(pg, x, y, 2)
    c1 = await pg.evaluate(centre)
    await asyncio.sleep(0.9)
    c2 = await pg.evaluate(centre)
    check("a scroll that adds up moves the aim to the pointer, and back to the middle when it stops short", math.hypot(c1[0] - x, c1[1] - y) < 1 and math.hypot(c2[0] - 720, c2[1] - 434.3) < 1, f"{[round(v) for v in c1]} then {[round(v) for v in c2]}")
    d = await pg.evaluate(DRAWN)
    check("after an off-centre zoom that stops short, the map is drawn where its coordinates say", d < 1, f"{d:.1f} px off")

    # "Dive in" while an off-centre scroll is adding up: the middle of the view, not the pointer
    middle = (await pg.evaluate(SKY, [720, 434.28]))["sky"]
    await scroll(pg, x, y, 2)
    await pg.evaluate("document.getElementById('dive-go').click()")
    check("Dive in during a partial off-centre scroll dives", await until(pg, "window.__diveState()?.phase === 'open'"))
    at = spot(pg.url)
    off = sep(*at, *middle) if at else 99
    check("and opens the middle of the view", off < 0.005, f"{off:.4f} deg off the middle")
    await pg.go_back()
    check("back closes that dive", await until(pg, "window.__diveState() === null && location.pathname.includes('explore')"))
    await asyncio.sleep(0.4)
    await scroll(pg, x, y, 7)
    check("a scroll at the deepest zoom dives", await until(pg, "window.__diveState()?.phase === 'open'"))
    at = spot(pg.url)
    off = sep(*at, *here) if at else 99
    check("the scroll dives to the sky under the pointer", off < 0.005, f"{off:.4f} deg off")
    check("the page did not zoom", await pg.evaluate("visualViewport.scale") == 1)

    # a pinch over "Dive in" (on the map, outside its stage) zooms the map, not the page
    await pg.go_back()
    check("back closes the dive again", await until(pg, "window.__diveState() === null && location.pathname.includes('explore')"))
    b = await pg.locator("#dive-go").bounding_box()
    bx, by = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
    await pg.mouse.move(bx, by); await pg.evaluate(WHEELS)
    await pinch(pg, bx, by, 0.7)
    await asyncio.sleep(0.3)
    w = await pg.evaluate(WHEELS)
    check("a pinch over Dive in zooms the map and not the page", w["open"] == 0 and not (await pg.evaluate(SKY, [bx, by]))["max"] and await pg.evaluate("visualViewport.scale") == 1, f"{w['open']} of {w['n']} not prevented")
    await browser.close()


async def edge(p):
    browser, pg = await page(p)
    await pg.mouse.move(720, 434)
    await scroll(pg, 720, 434, 40)
    # the north pole of the oval at the middle of the view, a little to its side: the middle is off the sky
    await pg.evaluate("import('/explore-view.js').then(v => v.set(v.MAXW, v.A.w / 2 - 0.52 * v.MAXW, (v.A.t + v.A.b) / 2))")
    await asyncio.sleep(0.6)
    mid = await pg.evaluate("import('/explore-view.js').then(v => v.skyAt(v.A.w / 2, (v.A.t + v.A.b) / 2))")
    pt = None
    for y in range(460, 820, 20):
        for x in (720, 600, 840, 480, 960):
            s = await pg.evaluate(SKY, [x, y])
            if s and s["sky"] and s["max"]: pt = (x, y); break
        if pt: break
    check("edge: the middle of the view is off the sky, with sky elsewhere in the window", mid is None and pt, f"middle {mid}, sky at {pt}")
    if not pt: return await browser.close()
    x, y = pt
    for n in ("first", "second"):
        await pg.mouse.move(x + 1, y); await pg.mouse.move(x, y); await asyncio.sleep(0.4)
        here = (await pg.evaluate(SKY, [x, y]))["sky"]
        await pinch(pg, x, y, 3)
        ok = await until(pg, "window.__diveState()?.phase === 'open'")
        at = spot(pg.url)
        off = sep(*at, *here) if at else 99
        # 0.02 degrees: 0.2 deg from the pole the pinch's zoom steps at the deepest level move the view a few px
        check(f"edge: a {n} pinch over sky dives there", ok and off < 0.02, f"{off:.4f} deg off, {pg.url.split('/')[-1]}")
        if not ok: break
        await pg.go_back()
        check(f"edge: back closes the {n} dive", await until(pg, "window.__diveState() === null && location.pathname.includes('explore') && !document.body.classList.contains('diving')"))
        await asyncio.sleep(0.4)
    # a dive that fails as it starts (made to throw once, reading the sky picture's style) leaves the map usable
    await pg.evaluate("""(() => { const g = getComputedStyle; window.getComputedStyle = (el, ...a) => {
      if (!window.__thrown && el?.matches?.('#map img.sky')) { window.__thrown = 1; throw new Error('test: dive fails'); } return g(el, ...a); }; })()""")
    await pinch(pg, x, y, 3)
    await asyncio.sleep(1.5)
    stuck = await pg.evaluate("({ thrown: !!window.__thrown, dive: window.__diveState(), diving: document.body.classList.contains('diving'), path: location.pathname })")
    check("edge: a dive that fails as it starts leaves the map, not a half-started dive", stuck["thrown"] and stuck["dive"] is None and not stuck["diving"] and "explore" in stuck["path"], str(stuck))
    await asyncio.sleep(0.4)
    await pinch(pg, x, y, 3)
    check("edge: and the next dive works", await until(pg, "window.__diveState()?.phase === 'open'"))
    await browser.close()


async def safari(p):
    browser, pg = await page(p)
    x, y = 1000, 300
    await pg.mouse.move(x, y)
    await scroll(pg, x, y, 6)
    a = await pg.evaluate(SKY, [x, y])
    r = await pg.evaluate("""([x, y]) => { const el = document.elementFromPoint(x, y), out = [];
      for (const [type, scale] of [['gesturestart', 1], ['gesturechange', 1.2], ['gesturechange', 1.5], ['gestureend', 1.5]]) {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(e, { scale: { value: scale }, clientX: { value: x }, clientY: { value: y } });
        el.dispatchEvent(e); out.push(e.defaultPrevented); }
      return out; }""", [x, y])
    b = await pg.evaluate(SKY, [x, y])
    off = await pg.evaluate(OFF, [x, y, *a["sky"]])
    check("Safari pinch: gesture events over the map are prevented", all(r), str(r))
    check("Safari pinch: it zooms 1.5x around the pointer", abs(b["W"] / a["W"] - 1.5) < 0.01 and off < 2, f"x{b['W'] / a['W']:.3f}, {off:.2f} px off")

    # a Safari pinch that arrives at the deepest zoom, pauses longer than a scroll's gap, and goes on: no dive
    gesture = """([x, y, scales]) => { const el = document.elementFromPoint(x, y);
      for (const [type, scale] of scales) { const e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(e, { scale: { value: scale }, clientX: { value: x }, clientY: { value: y } }); el.dispatchEvent(e); } }"""
    await pg.evaluate(gesture, [x, y, [["gesturestart", 1]] + [["gesturechange", 1.5 ** k] for k in range(1, 13)]])
    arrived = (await pg.evaluate(SKY, [x, y]))["max"]
    await asyncio.sleep(0.4)
    await pg.evaluate(gesture, [x, y, [["gesturechange", 1.5 ** 12 * 1.5 ** k] for k in range(1, 5)]])
    await asyncio.sleep(1)
    none = await pg.evaluate("window.__diveState()") is None or (await pg.evaluate("window.__diveState()"))["phase"] == "ready"
    check("Safari pinch: one that arrives at the deepest zoom, pauses and goes on does not dive", arrived and none and "explore" in pg.url, pg.url.split("/")[-1])
    await pg.evaluate(gesture, [x, y, [["gestureend", 1]]])
    await asyncio.sleep(0.3)

    # at the deepest zoom a new Safari pinch dives, to the sky under the pointer
    await scroll(pg, x, y, 40)
    await asyncio.sleep(0.4)
    here = (await pg.evaluate(SKY, [x, y]))["sky"]
    await pg.evaluate("""([x, y]) => { const el = document.elementFromPoint(x, y);
      for (const [type, scale] of [['gesturestart', 1], ['gesturechange', 1.3], ['gesturechange', 1.8], ['gesturechange', 2.5], ['gesturechange', 3.2]]) {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(e, { scale: { value: scale }, clientX: { value: x }, clientY: { value: y } });
        el.dispatchEvent(e); } }""", [x, y])
    ok = await until(pg, "window.__diveState()?.phase === 'open'")
    at = spot(pg.url)
    off = sep(*at, *here) if at else 99
    check("Safari pinch at the deepest zoom dives to the sky under the pointer", ok and off < 0.005, f"{off:.4f} deg off, {pg.url.split('/')[-1]}")
    await browser.close()


async def third_finger(p):
    browser = await p.chromium.launch(channel="chrome", headless=True)
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True)
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.maphint', '1') } catch {}")
    pg = await ctx.new_page()
    pg.on("pageerror", lambda e: fails.append(f"page error: {e}") or print("FAIL page error", e))
    await pg.goto(f"{BASE}/explore.html?day=400")
    await pg.wait_for_function("document.body.dataset.ready === '1'")
    cdp = await ctx.new_cdp_session(pg)
    send = lambda kind, pts: cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})
    async def spread(a, b, steps=12, end=True):
        await send("touchStart", a)
        for k in range(1, steps + 1):
            await send("touchMove", [(p0[0] + (p1[0] - p0[0]) * k / steps, p0[1] + (p1[1] - p0[1]) * k / steps) for p0, p1 in zip(a, b)])
            await asyncio.sleep(0.016)
        if end: await send("touchEnd", []); await asyncio.sleep(0.3)
    for _ in range(4):   # to the deepest zoom
        await spread([(175, 400), (215, 400)], [(40, 400), (350, 400)])
        if (await pg.evaluate(SKY, [195, 400]))["max"]: break
    await asyncio.sleep(0.4)
    state = """(async () => { const v = await import('/explore-view.js'), r = document.querySelector('.aim-box').getBoundingClientRect(), go = document.getElementById('dive-go');
      return { max: v.atMax(), aim: [r.x + r.width / 2, r.y + r.height / 2], mid: [v.A.w / 2, (v.A.t + v.A.b) / 2], button: getComputedStyle(go).opacity === '1' && getComputedStyle(go).pointerEvents !== 'none',
        fill: 1 - parseFloat(document.getElementById('aim-ring').style.strokeDashoffset || 1), dive: window.__diveState() }; })()"""
    a, b = [(150, 300), (190, 300)], [(140, 300), (200, 300)]   # off the middle, spread 1.5x: part of the way to a dive
    await spread(a, b, end=False)
    during = await pg.evaluate(state)
    await send("touchStart", b + [(300, 600)])   # a third finger
    await asyncio.sleep(0.1)
    await send("touchEnd", []); await asyncio.sleep(0.4)
    after = await pg.evaluate(state)
    check("phone: a pinch at the deepest zoom moves the aim between the fingers and fades Dive in", during["max"] and math.hypot(during["aim"][0] - 170, during["aim"][1] - 300) < 2 and not during["button"] and 0 < during["fill"] < 1, str(during))
    check("phone: a third finger ends it, and with all fingers up the aim and Dive in are back in the middle",
          after["dive"] is None and after["fill"] == 0 and after["button"] and math.hypot(after["aim"][0] - after["mid"][0], after["aim"][1] - after["mid"][1]) < 2, str(after))

    # a lopsided pinch: one finger stays, the other moves away, so the midpoint and the sky under it move together
    await asyncio.sleep(0.4)
    a, b = [(150, 300), (190, 300)], [(150, 300), (300, 300)]
    under = (await pg.evaluate(SKY, [170, 300]))["sky"]
    await spread(a, b, steps=20)
    ok = await until(pg, "window.__diveState()?.phase === 'open'")
    at = spot(pg.url)
    off = sep(*at, *under) if at else 99
    # 0.03 degrees is about 2.5 px here; the dive at the first midpoint's screen point is about 12 px (0.14 degrees) off
    check("phone: a lopsided pinch dives to the sky between the fingers", ok and off < 0.03, f"{off:.4f} deg off")
    await browser.close()


async def main():
    async with async_playwright() as p:
        for kind in ("scroll", "pinch"):
            for x, y in ((1000, 300), (420, 560)):
                await anchored(p, kind, x, y)
        await dives(p)
        await edge(p)
        await safari(p)
        await third_finger(p)
    print(f"\n{len(fails)} failed" if fails else "\nall passed")
    sys.exit(1 if fails else 0)


asyncio.run(main())
