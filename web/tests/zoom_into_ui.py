"""Explore's dive: zooming in past the map's deepest level opens the time-lapse of the middle of the view (explore-dive.js).
Chrome, three setups: a desktop (1440 x 900, mouse and wheel), the same with reduced motion, and a phone (390 x 844, touch).
Checks, desktop: one long scroll from the whole sky stops at the deepest zoom and does not dive; nor do panning there, a
double click, the + button or a scroll that stops short (the aim's outline fills, then empties); a new scroll past the
threshold dives; the address is the time-lapse's, at the middle of the view within 0.1 degree; the time-lapse fills the
window; back shows the map exactly where it was, forward dives again; "Dive in" does the same; scrolling out past the
widest view in the time-lapse comes back to the map; a time-lapse loaded ahead of a dive counts no heat-map check
until it is on screen; a reload of the time-lapse's address is the page on its own, and back from it opens Explore
on the same view with no replay.
Reduced motion: no flight (the dive is never part-way), the time-lapse takes the map's place, back swaps it back.
Phone: a one-finger pan and a pinch that only arrives at the deepest zoom do not dive; a pinch that starts there does;
back restores the view.
Run: uv run -q --with playwright python web/tests/zoom_into_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, math, re, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
VIEW = "(async () => { const v = await import('/explore-view.js'); return v.A ? { W: v.W, X: v.X, Y: v.Y, max: v.atMax(), mid: [v.A.w / 2, (v.A.t + v.A.b) / 2], sky: v.skyAt(v.A.w / 2, (v.A.t + v.A.b) / 2) } : null; })()"
DIVE = "window.__diveState()"
AIM = "(() => { const a = document.getElementById('dive-aim'); return { on: !a.hidden && getComputedStyle(a).visibility !== 'hidden', fill: 1 - parseFloat(document.getElementById('aim-ring').style.strokeDashoffset || 1) }; })()"
fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    if not ok: fails.append(name)


def sep(ra1, dec1, ra2, dec2):   # degrees between two sky positions
    a1, d1, a2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    return math.degrees(math.acos(min(1, math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(a1 - a2))))


def spot(url):
    m = re.search(r"timelapse(?:\.html)?\?ra=([\d.]+)&dec=(-?[\d.]+)&det=(D\d)", url)
    return (float(m[1]), float(m[2]), m[3]) if m else None


async def until(pg, expr, ms=8000):
    try: await pg.wait_for_function(expr, timeout=ms); return True
    except Exception: return False


async def scroll(pg, n, dy=-100):
    """n wheel notches as one scroll: sent 25 ms apart without waiting for the page, the way a wheel does."""
    x, y = pg.pos
    for _ in range(n):
        asyncio.ensure_future(pg.cdp.send("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": x, "y": y, "deltaX": 0, "deltaY": dy}))
        await asyncio.sleep(0.025)
    await asyncio.sleep(0.3)


async def point(pg, x, y):
    pg.pos = (x, y)
    await pg.mouse.move(x, y)


async def same_view(pg, before, name):
    v = await pg.evaluate(VIEW)
    check(name, v and all(abs(v[k] - before[k]) < 0.5 for k in "WXY"), f"{[round(before[k], 1) for k in 'WXY']} -> {[round(v[k], 1) for k in 'WXY'] if v else None}")


async def open_explore(ctx):
    pg = await ctx.new_page()
    pg.on("pageerror", lambda e: fails.append(f"page error: {e}") or print("FAIL page error", e))
    await pg.goto(f"{BASE}/explore.html?day=400")
    await pg.wait_for_function("document.body.dataset.ready === '1'")
    pg.cdp = await ctx.new_cdp_session(pg)
    return pg


async def desktop(browser):
    ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")   # no first-visit tour over the map
    pg = await open_explore(ctx)
    posts = []
    pg.on("request", lambda r: posts.append(r.url) if r.method == "POST" and "/api/checks" in r.url else None)
    cx, cy = 620, 470
    await point(pg, cx, cy)

    # one long scroll from the whole sky: it stops at the deepest zoom
    await scroll(pg, 40)
    await asyncio.sleep(0.4)
    v = await pg.evaluate(VIEW)
    check("a long scroll reaches the deepest zoom", v["max"])
    check("a long scroll that arrives there does not dive", "/explore" in pg.url and (await pg.evaluate(DIVE)) is None, pg.url)
    aim = await pg.evaluate(AIM)
    check("the aim and Dive in show at the deepest zoom", aim["on"] and await pg.locator("#dive-go").is_visible())
    box = await pg.locator(".aim-box").bounding_box()
    check("the aim sits at the middle of the view", abs(box["x"] + box["width"] / 2 - v["mid"][0]) < 1 and abs(box["y"] + box["height"] / 2 - v["mid"][1]) < 1)

    # panning, a double click, the + button: none dives
    for dx, dy in [(-260, 90), (180, -140), (-120, -60), (240, 130)]:
        await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx + dx / 2, cy + dy / 2, steps=6); await pg.mouse.move(cx + dx, cy + dy, steps=6); await pg.mouse.up()
    await pg.mouse.dblclick(cx - 200, cy - 150)
    await pg.locator("#zoom-in").click(force=True)
    await pg.keyboard.press("Escape")
    await asyncio.sleep(0.5)
    check("panning, a double click and + at the deepest zoom do not dive", "/explore" in pg.url and (await pg.evaluate(DIVE) or {}).get("phase", "ready") == "ready", pg.url)

    # a new scroll that stops short: the outline fills part-way, then empties
    await point(pg, cx, cy)
    await asyncio.sleep(0.3)
    await scroll(pg, 2)
    part = (await pg.evaluate(AIM))["fill"]
    await asyncio.sleep(0.9)
    check("a short scroll fills the aim part-way and springs back", 0.2 < part < 1 and (await pg.evaluate(AIM))["fill"] == 0 and "/explore" in pg.url, f"{part:.2f}")

    # a new scroll past the threshold dives, to the middle of the view
    before = await pg.evaluate(VIEW)
    await scroll(pg, 7)
    check("a new scroll past the threshold dives", await until(pg, f"{DIVE}?.phase === 'open'"), str(await pg.evaluate(DIVE)))
    at = spot(pg.url)
    off = sep(at[0], at[1], *before["sky"]) if at else 99
    check("the address is the time-lapse of the middle of the view, within 0.1 degree", off < 0.1, f"{pg.url.split('/')[-1]}  {off:.5f} deg off")
    fr = pg.frame_locator("iframe.dive-frame")
    check("the time-lapse is that spot's", at and (await fr.locator("#coords").input_value()).split() == [f"{at[0]:.4f}", f"{at[1]:.4f}"])
    r = await pg.locator("iframe.dive-frame").bounding_box()
    check("the time-lapse fills the window and takes the pointer", r["width"] == 1440 and r["height"] == 900 and await pg.evaluate("document.elementFromPoint(700, 450).className") == "dive-frame on")
    check("the map underneath takes no input", await pg.evaluate("document.querySelector('.xstage').inert && document.querySelector('.topbar').inert"))

    await pg.go_back()
    check("back closes the time-lapse", await until(pg, f"{DIVE} === null") and "/explore" in pg.url and await pg.locator("iframe.dive-frame").count() == 0, pg.url)
    await same_view(pg, before, "back shows the map where it was")
    check("the map takes input again, on the same day", not await pg.evaluate("document.querySelector('.xstage').inert") and await pg.evaluate("+document.getElementById('time').value") == 400)
    await pg.go_forward()
    check("forward dives again at the same spot", await until(pg, f"{DIVE}?.phase === 'open'") and spot(pg.url) == at, pg.url)
    await pg.go_back()
    await until(pg, f"{DIVE} === null")

    # Dive in, with a time-lapse that loaded ahead: no heat-map check until it is on screen
    await asyncio.sleep(0.5); posts.clear()   # the dives above were on screen: theirs count
    await pg.locator("#dive-go").hover()
    built = await until(pg, "document.querySelector('iframe.dive-frame')?.contentWindow.__lapse?.state.m", 120000)
    check("the time-lapse builds ahead of the dive (needs the image search to answer)", built)
    await asyncio.sleep(0.3)
    check("a time-lapse loaded ahead counts no check", len(posts) == 0, str(len(posts)))
    await pg.locator("#dive-go").click()
    check("Dive in dives", await until(pg, f"{DIVE}?.phase === 'open'") and spot(pg.url) is not None, pg.url)
    await asyncio.sleep(0.5)
    check("on screen it counts one check", len(posts) == 1, str(len(posts)))
    check("no picture is left over the photo", await until(pg, "getComputedStyle(document.querySelector('iframe.dive-frame').contentDocument.getElementById('hold')).visibility === 'hidden'"))

    # scroll out in the time-lapse: to the widest view, then a new scroll goes back to the map
    p = await fr.locator("#patch").bounding_box()
    await point(pg, p["x"] + p["width"] / 2, p["y"] + p["height"] / 2)
    await scroll(pg, 30, 100)
    await asyncio.sleep(0.4)
    check("one long scroll out stops at the widest view", await fr.locator("#fov").input_value() == "1" and (await pg.evaluate(DIVE))["phase"] == "open")
    await scroll(pg, 6, 100)
    check("a new scroll out goes back to the map", await until(pg, f"{DIVE} === null") and "/explore" in pg.url, pg.url)
    await same_view(pg, before, "and the map is where it was")

    # the time-lapse's address on its own, and back from it
    await pg.locator("#dive-go").click()
    await until(pg, f"{DIVE}?.phase === 'open'")
    await pg.reload()
    await pg.wait_for_selector("#patch")
    check("a reload of the address is the time-lapse page itself", await pg.evaluate("self === top && !!document.getElementById('patch') && !document.querySelector('.xstage')"))
    await pg.go_back()
    await pg.wait_for_function("document.body.dataset.ready === '1'")
    await asyncio.sleep(0.4)
    await same_view(pg, before, "back from it opens Explore on the same view")
    check("with no replay, on the same day", not await pg.evaluate("document.getElementById('play').classList.contains('on')") and await pg.evaluate("+document.getElementById('time').value") == 400)
    await ctx.close()


async def reduced(browser):
    ctx = await browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
    pg = await open_explore(ctx)
    await point(pg, 620, 470)
    await scroll(pg, 40)
    await asyncio.sleep(0.4)
    before = await pg.evaluate(VIEW)
    await pg.evaluate("""() => { window.__ts = []; const tick = () => { const d = window.__diveState(); if (d) window.__ts.push(d.t); requestAnimationFrame(tick); }; tick(); }""")
    await scroll(pg, 7)
    check("reduced motion: the scroll opens the time-lapse", await until(pg, f"{DIVE}?.phase === 'open'") and spot(pg.url) is not None, pg.url)
    ts = await pg.evaluate("window.__ts")
    check("reduced motion: no flight, the dive is never part-way", all(t in (0, 1) for t in ts) and await pg.evaluate("document.querySelector('.map-wrap').style.transform") in ("", "scale(6)"), str(sorted(set(ts))[:6]))
    await pg.evaluate("window.__ts = []")
    await pg.go_back()
    check("reduced motion: back shows the map", await until(pg, f"{DIVE} === null") and "/explore" in pg.url)
    check("reduced motion: with no flight back", all(t in (0, 1) for t in await pg.evaluate("window.__ts")))
    await same_view(pg, before, "reduced motion: where it was")
    await ctx.close()


async def phone(browser):
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
                                    user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.maphint', '1') } catch {}")
    pg = await open_explore(ctx)
    cdp = pg.cdp

    async def touch(start, end, steps=14):
        send = lambda kind, pts: cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})
        await send("touchStart", start)
        for k in range(1, steps + 1):
            await send("touchMove", [(a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps) for a, b in zip(start, end)])
            await asyncio.sleep(0.016)
        await send("touchEnd", [])
        await asyncio.sleep(0.25)

    near, far = [(175, 400), (215, 400)], [(40, 400), (350, 400)]
    # one pinch from a middle zoom that runs far past the deepest level: it arrives there and stays on the map
    await touch(near, far)
    v = await pg.evaluate(VIEW)
    if not v["max"]: await touch(near, far); v = await pg.evaluate(VIEW)
    check("phone: a pinch that only arrives at the deepest zoom does not dive", v["max"] and "/explore" in pg.url and (await pg.evaluate(DIVE)) is None, f"W {v['W']:.0f}")
    await touch([(200, 300)], [(120, 520)]); await touch([(150, 500)], [(260, 330)])
    check("phone: panning there does not dive", "/explore" in pg.url and (await pg.evaluate(DIVE) or {}).get("phase", "ready") == "ready")
    check("phone: Dive in is a 44 px target", (await pg.locator("#dive-go").bounding_box())["height"] >= 44)
    await touch(near, [(165, 400), (225, 400)])   # a small pinch there: not enough
    check("phone: a small pinch there springs back", "/explore" in pg.url and (await pg.evaluate(AIM))["fill"] == 0)
    before = await pg.evaluate(VIEW)
    await touch(near, far)
    check("phone: a pinch that starts at the deepest zoom dives", await until(pg, f"{DIVE}?.phase === 'open'"), str(await pg.evaluate(DIVE)))
    at = spot(pg.url)
    off = sep(at[0], at[1], *before["sky"]) if at else 99
    check("phone: to the middle of the view, within 0.1 degree", off < 0.1, f"{off:.5f} deg off")
    check("phone: the time-lapse in the frame can scroll", await pg.evaluate("getComputedStyle(document.body).touchAction") == "auto")
    await pg.go_back()
    check("phone: back closes it", await until(pg, f"{DIVE} === null") and "/explore" in pg.url)
    await same_view(pg, before, "phone: the map is where it was")
    await ctx.close()


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=True)
        await desktop(browser)
        await reduced(browser)
        await phone(browser)
        await browser.close()
    print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILED: ' + '; '.join(fails)}")
    sys.exit(1 if fails else 0)

asyncio.run(main())
