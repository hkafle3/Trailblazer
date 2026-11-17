"""Explore's dive: zooming in past the map's deepest level opens the time-lapse under the pointer (explore-dive.js).
Chrome, three setups: a desktop (1440 x 900, mouse and wheel), the same with reduced motion, and a phone (390 x 844, touch).
Checks, desktop: one long scroll from the whole sky stops at the deepest zoom and does not dive; nor do panning there, a
double click, the + button or a scroll that stops short (the aim's outline fills, then empties); a new scroll past the
threshold dives; the address is the time-lapse's, under the pointer within 0.1 degree; the time-lapse fills the
window; back shows the map exactly where it was, forward dives again; "Dive in" does the same; scrolling out past the
widest view in the time-lapse comes back to the map; a time-lapse loaded ahead of a dive counts no heat-map check
until it is on screen; the sky tiles the flying frame shows line up with the first real frame; a time-lapse opened by a link stops at its widest view
and stays; a reload of the time-lapse's address is the page on its own, and back from it opens Explore
on the same view with no replay.
Reduced motion: no flight (the dive is never part-way), the time-lapse takes the map's place, back swaps it back.
Phone: a one-finger pan and a pinch that only arrives at the deepest zoom do not dive; a pinch that starts there does,
to the sky between the fingers; back restores the view.
Run: uv run -q --with playwright python web/tests/zoom_into_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, math, re, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
VIEW = "(async () => { const v = await import('/explore-view.js'); return v.A ? { W: v.W, X: v.X, Y: v.Y, max: v.atMax(), mid: [v.A.w / 2, (v.A.t + v.A.b) / 2], sky: v.skyAt(v.A.w / 2, (v.A.t + v.A.b) / 2) } : null; })()"
SKY_AT = "(async ([x, y]) => (await import('/explore-view.js')).skyAt(x, y))"
DIVE = "window.__diveState()"
AIM = "(() => { const a = document.getElementById('dive-aim'); return { on: !a.hidden && getComputedStyle(a).visibility !== 'hidden', fill: 1 - parseFloat(document.getElementById('aim-ring').style.strokeDashoffset || 1) }; })()"
# The sky the flying frame shows (its copy of the deep layer's tiles) against the first real frame, both on the frame's 12 arcmin grid (5 arcsec a pixel):
# the best match of brightness over shifts of up to 8 pixels, as drawn and for three wrong orientations.
REGISTER = """() => { const N = 144, sky = window.__diveSky(0.2, N), shot = window.__diveShot();
  const lum = (src, sw, sx, sy, flipx, flipy) => { const c = new OffscreenCanvas(N, N), g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
    if (flipx || flipy) { g.translate(flipx ? N : 0, flipy ? N : 0); g.scale(flipx ? -1 : 1, flipy ? -1 : 1); }
    g.drawImage(src, sx, sy, sw, sw, 0, 0, N, N); const d = g.getImageData(0, 0, N, N).data, o = new Float32Array(N * N); for (let i = 0; i < N * N; i++) o[i] = d[4 * i]; return o; };
  const a = lum(sky, N, 0, 0);
  const corr = (b, dx, dy) => { let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0; for (let y = 30; y < N - 30; y++) for (let x = 30; x < N - 30; x++) { const p = a[y * N + x], q = b[(y + dy) * N + x + dx]; sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q; n++; }
    return (sab - sa * sb / n) / Math.sqrt((saa - sa * sa / n) * (sbb - sb * sb / n)); };
  const out = {};
  for (const [name, fx, fy] of [['as drawn', 0, 0], ['mirrored left-right', 1, 0], ['upside down', 0, 1], ['rotated 180', 1, 1]]) {
    const b = lum(shot, shot.width, 0, 0, fx, fy); let best = [-2, 0, 0];
    for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) { const c = corr(b, dx, dy); if (c > best[0]) best = [c, dx, dy]; }
    out[name] = [+best[0].toFixed(3), best[1], best[2]]; }
  return out; }"""
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
    for _ in range(30):   # a view put back as the page opens settles once the timeline has risen into place
        v = await pg.evaluate(VIEW)
        if v and all(abs(v[k] - before[k]) < 0.5 for k in "WXY"): break
        await asyncio.sleep(0.1)
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
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.adv', '1') } catch {}")   # no first-visit tour over the map
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

    # a new scroll past the threshold dives, to the sky under the pointer
    before = await pg.evaluate(VIEW)
    under = await pg.evaluate(SKY_AT, list(pg.pos))
    await scroll(pg, 7)
    check("a new scroll past the threshold dives", await until(pg, f"{DIVE}?.phase === 'open'"), str(await pg.evaluate(DIVE)))
    at = spot(pg.url)
    off = sep(at[0], at[1], *under) if at else 99
    check("the address is the time-lapse under the pointer, within 0.1 degree", off < 0.1, f"{pg.url.split('/')[-1]}  {off:.5f} deg off")
    fr = pg.frame_locator("iframe.dive-frame")
    check("the time-lapse is that spot's", at and (await fr.locator("#coords").input_value()).split() == [f"{at[0]:.4f}", f"{at[1]:.4f}"])
    r = await pg.locator("iframe.dive-frame").bounding_box()
    check("the time-lapse fills the window and takes the pointer", r["width"] == 1440 and r["height"] == 900 and await pg.evaluate("document.elementFromPoint(700, 450).className") == "dive-frame on")
    check("the map underneath takes no input", await pg.evaluate("document.querySelector('.xstage').inert && document.querySelector('.topbar').inert"))

    # The embedded viewer reports its URL after re-centring. Keep that spot and unrelated history fields for Forward.
    at = (round((at[0] + .01) % 360, 4), round(at[1] + (.01 if at[1] < 89 else -.01), 4), at[2])
    await pg.evaluate("history.replaceState({ ...history.state, kept: 1, dive: { ...history.state.dive, kept: 2 } }, '')")
    await fr.locator("body").evaluate("(_, [ra, dec, det]) => history.replaceState(null, '', `?ra=${ra.toFixed(4)}&dec=${dec.toFixed(4)}&det=${det}`)", at)
    check("viewer URL updates the saved dive and preserves other state", await until(pg, f"history.state.dive.ra === {at[0]} && history.state.dive.dec === {at[1]} && history.state.kept === 1 && history.state.dive.kept === 2"))
    await pg.go_back()
    check("back closes the time-lapse", await until(pg, f"{DIVE} === null") and "/explore" in pg.url and await pg.locator("iframe.dive-frame").count() == 0, pg.url)
    await same_view(pg, before, "back shows the map where it was")
    check("the map takes input again, on the same day", not await pg.evaluate("document.querySelector('.xstage').inert") and await pg.evaluate("+document.getElementById('time').value") == 400)
    await pg.go_forward()
    check("forward dives again at the same spot", await until(pg, f"{DIVE}?.phase === 'open'") and spot(pg.url) == at, pg.url)
    await pg.go_back()
    await until(pg, f"{DIVE} === null")
    before = await pg.evaluate(VIEW)

    # Dive in, with a time-lapse that loaded ahead: no heat-map check until it is on screen
    await asyncio.sleep(0.5); posts.clear()   # the dives above were on screen: theirs count
    await pg.locator("#dive-go").hover()
    built = await until(pg, "document.querySelector('iframe.dive-frame')?.contentWindow.__lapse?.state.m", 120000)
    check("the time-lapse builds ahead of the dive (needs the image search to answer)", built)
    await asyncio.sleep(0.3)
    check("a time-lapse loaded ahead counts no check", len(posts) == 0, str(len(posts)))
    day = await pg.evaluate("document.querySelector('iframe.dive-frame').contentWindow.__lapse.state.i === 0 ? 529 : 0")
    await pg.evaluate("day => { document.getElementById('time').value = day; document.getElementById('time').dispatchEvent(new Event('input', { bubbles: true })); }", day)
    await pg.locator("#dive-go").click()
    check("Dive in dives", await until(pg, f"{DIVE}?.phase === 'open'") and spot(pg.url) is not None, pg.url)
    check("a prepared dive opens on the timeline's current day", await fr.locator("body").evaluate("async (_, day) => { const { MJD0 } = await import('./skymap.js'), { m, i } = __lapse.state; return i === m.frames.reduce((best, f, n) => Math.abs(f.mjd - MJD0 - day) < Math.abs(m.frames[best].mjd - MJD0 - day) ? n : best, 0); }", day))
    await asyncio.sleep(0.5)
    check("on screen it counts one check", len(posts) == 1, str(len(posts)))
    if await until(pg, "window.__diveSky(0.2, 8) && window.__diveShot()", 20000):
        reg = await pg.evaluate(REGISTER)
        best = reg["as drawn"]
        check("the sky in the flying frame (the deep layer's tiles) line up with the first real frame (within one 5 arcsec pixel, right way round)",
              abs(best[1]) <= 1 and abs(best[2]) <= 1 and all(best[0] > v[0] + 0.1 for k, v in reg.items() if k != "as drawn"), str(reg))
    else: check("the sky tiles and the first frame are there to compare", False)
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
    await pg.evaluate("document.getElementById('time').value = 400; document.getElementById('time').dispatchEvent(new Event('input', { bubbles: true }))")

    # the time-lapse's address on its own, and back from it
    await pg.locator("#dive-go").click()
    await until(pg, f"{DIVE}?.phase === 'open'")
    await pg.reload()
    await pg.wait_for_selector("#patch")
    check("a reload of the address is the time-lapse page itself", await pg.evaluate("self === top && !!document.getElementById('patch') && !document.querySelector('.xstage')"))
    # a time-lapse opened by a link, not a dive: scrolling out stops at the widest view and stays on the page
    direct = await ctx.new_page(); direct.cdp = await ctx.new_cdp_session(direct)
    await direct.goto(f"{BASE}/timelapse.html?target=barnard")
    await direct.wait_for_function("window.__lapse?.state.m")
    p = await direct.locator("#patch").bounding_box()
    await point(direct, p["x"] + p["width"] / 2, p["y"] + p["height"] / 2)
    await scroll(direct, 30, 100); await asyncio.sleep(0.4); await scroll(direct, 12, 100); await asyncio.sleep(0.8)
    check("a time-lapse opened directly stops at its widest view and stays", "timelapse" in direct.url and await direct.evaluate("!!window.__lapse && document.getElementById('fov').value === '1' && !document.querySelector('.pv-frame').style.transform"), direct.url)
    await direct.close()
    await pg.go_back()
    await pg.wait_for_function("document.body.dataset.ready === '1'")
    await asyncio.sleep(0.4)
    await same_view(pg, before, "back from it opens Explore on the same view")
    check("with no replay, on the same day", not await pg.evaluate("document.getElementById('play').classList.contains('on')") and await pg.evaluate("+document.getElementById('time').value") == 400)
    await ctx.close()


async def reduced(browser):
    ctx = await browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.adv', '1') } catch {}")
    pg = await open_explore(ctx)
    await point(pg, 620, 470)
    await scroll(pg, 40)
    await asyncio.sleep(0.4)
    before = await pg.evaluate(VIEW)
    await pg.evaluate("""() => { window.__ts = []; const tick = () => { const d = window.__diveState(); if (d) window.__ts.push(d.t); requestAnimationFrame(tick); }; tick(); }""")
    await scroll(pg, 7)
    check("reduced motion: the scroll opens the time-lapse", await until(pg, f"{DIVE}?.phase === 'open'") and spot(pg.url) is not None, pg.url)
    ts = await pg.evaluate("window.__ts")
    check("reduced motion: no flight, the dive is never part-way", all(t in (0, 1) for t in ts) and await pg.evaluate("document.querySelector('.map-wrap').style.scale") in ("", "1", "6"), str(sorted(set(ts))[:6]))
    await pg.evaluate("window.__ts = []")
    await pg.go_back()
    check("reduced motion: back shows the map", await until(pg, f"{DIVE} === null") and "/explore" in pg.url)
    check("reduced motion: with no flight back", all(t in (0, 1) for t in await pg.evaluate("window.__ts")))
    await same_view(pg, before, "reduced motion: where it was")
    await ctx.close()


async def phone(browser):
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
                                    user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.adv', '1'); localStorage.setItem('ch.maphint', '1') } catch {}")
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
    under = await pg.evaluate(SKY_AT, [(near[0][0] + near[1][0]) / 2, (near[0][1] + near[1][1]) / 2])
    await touch(near, far)
    check("phone: a pinch that starts at the deepest zoom dives", await until(pg, f"{DIVE}?.phase === 'open'"), str(await pg.evaluate(DIVE)))
    at = spot(pg.url)
    off = sep(at[0], at[1], *under) if at else 99
    check("phone: to the sky between the fingers, within 0.1 degree", off < 0.1, f"{off:.5f} deg off")
    # the map follows the fingers until the dive starts (each finger's move shifts their midpoint), so "where it was" is
    # the view the dive left, read underneath it
    before = await pg.evaluate(VIEW)
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
