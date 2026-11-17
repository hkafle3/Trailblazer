"""Browser check for zooming the time-lapse's Depth view (live/depth.js), in system Chrome on Barnard's Star. Needs the app
up (npm run dev) and the network (Gaia and SIMBAD through /api/depth).
At 1440x900:
1. the wheel zooms toward the pointer: every point keeps its place relative to the pointer (the target's ring lands
   within 3 px of where a zoom about the pointer puts it, and so does a dot), and the ring grows by the zoom factor;
2. a trackpad pinch (ctrl wheel) zooms the view and not the page (visualViewport.scale and devicePixelRatio stay);
3. labels keep their font size at any zoom; hovering a dot and clicking one still name it while zoomed, and the hover
   name stays shown and in place through 32 hovers on one dot (at 1x and zoomed);
4. a drag still turns the beam while zoomed, and keeps the zoom; the zoom stays between 1x and 8x;
5. the + and - buttons and keys zoom about the middle; Reset view undoes the zoom and the turn (the camera is the
   first one again);
6. shift-drag and right-drag pan the zoomed view (no turn), only as far as the edges of the whole scene; the canvas
   holds back the context menu, the rest of the page does not; the dashed no-distance rings fade in with the swing;
   no page errors.
At 390x844 with touch: a two-finger pinch (CDP touch) zooms toward the fingers' midpoint, the page does not zoom
(visualViewport.scale 1) or scroll, and no two names overlap; one finger still turns; a one-finger swipe outside the canvas still scrolls the page;
the zoom buttons are 44 px taps.
Screenshots go to the folder given as the second argument (default: none).
Run: uv run -q --with playwright python web/tests/depth_zoom_ui.py [base url] [shot dir]   (default http://127.0.0.1:8787)"""
import asyncio, math, os, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
URL = f"{BASE}/timelapse.html?target=barnard&view=depth"
READY = "+document.getElementById('play')?.getAttribute('aria-valuemax') > 0 && !!window.__lapse?.state.m"
DRAWN = "document.getElementById('depth3d').dataset.state === 'ready' && +document.getElementById('depth3d').dataset.rings > 0"
BEAM = "(() => { const c = document.querySelector('#depth3d canvas'), t = document.createElement('canvas'); t.width = 200; t.height = 120; const g = t.getContext('2d'); g.drawImage(c, 0, 0, 200, 120); const d = g.getImageData(0, 0, 200, 120).data; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1]) | 0; return h; })()"
# the zoom (k), the turn (a, p), the target's ring on screen ([x, y, diameter]), the page's own zoom and scroll (a phone's
# time-lapse page scrolls its body)
STATE = """() => ({ v: __depth.view ?? null, ring: __depth.ringOf?.() ?? null, cam: __depth.cam ?? null, scale: visualViewport.scale, dpr: devicePixelRatio, sy: scrollY + document.body.scrollTop,
  font: getComputedStyle(document.querySelector('#depth3d .lbl:not(.tip)')).fontSize, peek: document.getElementById('depth3d').dataset.peek || '' })"""
# visible names that run under the tabs, the zoom box, or the note and hint along the bottom
UNDER = """(() => { const box = s => { const e = document.querySelector(s); if (!e || !e.offsetWidth) return null; const r = e.getBoundingClientRect(); return [s, r]; };
  const covers = ['.pv-views', '#depth3d .xp-d3-zoom', '#depth3d .xp-d3-note', '#depth3d .xp-d3-hint'].map(box).filter(Boolean), out = [];
  for (const l of document.querySelectorAll('#depth3d .lbl:not(.tip)')) { if (+l.style.opacity < .5) continue; const r = l.getBoundingClientRect();
    for (const [s, c] of covers) if (r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top) out.push(l.textContent + ' under ' + s); }
  return out; })()"""
# pairs of visible names that overlap, or sit side by side with less than 4 px between them
CLASH = """(() => { const r = [...document.querySelectorAll('#depth3d .lbl:not(.tip)')].filter(l => +l.style.opacity > .5).map(l => [l.textContent, l.getBoundingClientRect()]), out = [];
  for (const [i, [a, p]] of r.entries()) for (const [b, q] of r.slice(i + 1)) if (p.left < q.right + 4 && p.right + 4 > q.left && p.top < q.bottom && p.bottom > q.top) out.push(a + ' / ' + b); return out; })()"""
# rings in the view whose names are not shown
NAMELESS = """(() => { const c = document.querySelector('#depth3d canvas').getBoundingClientRect();
  return __depth.ringsOn().filter(({ xy: [x, y], shown }) => x > c.left && x < c.right && y > c.top && y < c.bottom && !shown).map(b => b.name + ' (ring in view, name hidden)'); })()"""
fails = []


def check(ok, msg):
    print(("PASS " if ok else "FAIL ") + msg)
    if not ok: fails.append(msg)


def k_of(s): return (s["v"] or {}).get("k", 1)
def about(p, a, f): return [a[0] + (p[0] - a[0]) * f, a[1] + (p[1] - a[1]) * f]   # p after a zoom by f about a
def off(p, q): return math.hypot(p[0] - q[0], p[1] - q[1]) if p and q else 1e9


async def open_depth(b, phone):
    kw = dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True) if phone else dict(viewport={"width": 1440, "height": 900})
    ctx = await b.new_context(**kw)
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
    pg = await ctx.new_page(); pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and pg.errors.append(m.text))
    await pg.goto(URL); await pg.wait_for_function(READY, timeout=60000)
    await pg.wait_for_function(DRAWN, timeout=90000)
    await pg.evaluate("document.getElementById('depth3d').scrollIntoView({ block: 'center' })")
    await pg.wait_for_timeout(2400)   # the swing out from the telescope ends
    return ctx, pg


async def dot_in_view(pg, margin=30):   # a dot well inside the canvas: its key and client point
    cv = await pg.locator("#depth3d canvas").bounding_box()
    for k in (await pg.evaluate("__depth.shown.dots")):
        xy = await pg.evaluate("k => __depth.screenOf(k)", k)
        if xy and cv["x"] + margin < xy[0] < cv["x"] + cv["width"] - margin and cv["y"] + 70 < xy[1] < cv["y"] + cv["height"] - margin: return k, xy
    return None, None


async def steady_tip(pg, n=32):   # hover the same dot n times, within 1 px: the tip stays shown and in one place
    key, xy = await dot_in_view(pg)
    if not key: return False, "no dot in view"
    seen = []
    for i in range(n):
        await pg.mouse.move(xy[0] + (i % 3) - 1, xy[1] + (i % 2)); await pg.wait_for_timeout(15)
        seen.append(await pg.evaluate("(t => [+t.style.opacity, t.getBoundingClientRect().left, t.getBoundingClientRect().top, document.getElementById('depth3d').dataset.peek])(document.querySelector('#depth3d .lbl.tip'))"))
    bad = [i for i, (o, x, y, k) in enumerate(seen) if o < .9 or k != key or abs(x - seen[0][1]) > 1.5 or abs(y - seen[0][2]) > 1.5]
    return not bad, f"{key}: off or moved on updates {bad[:6]} (first {[round(v, 1) for v in seen[0][:3]]}, last {[round(v, 1) for v in seen[-1][:3]]})"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)

        # ---------------- desktop ----------------
        ctx, pg = await open_depth(b, False)
        st = lambda: pg.evaluate(STATE)
        s0 = await st(); cam0 = s0["cam"]
        check(s0["ring"] is not None and k_of(s0) == 1, f"desktop: the target's ring is on screen at 1x ({s0['ring']}, view {s0['v']})")
        ring0 = s0["ring"] or [700, 400, 20]
        ok, say = await steady_tip(pg)
        check(ok, f"1x: the hover name stays shown and in place through 32 hovers on one dot ({say})")
        await pg.mouse.move(5, 5); await pg.wait_for_timeout(100)
        key, dot0 = await dot_in_view(pg)
        # 1. the wheel at a point beside the ring
        A = [ring0[0] + 40, ring0[1] + 25]
        await pg.mouse.move(*A); await pg.mouse.wheel(0, -200); await pg.wait_for_timeout(150)
        s1 = await st(); f1 = k_of(s1)
        dot1 = await pg.evaluate("k => __depth.screenOf(k)", key) if key else None
        check(f1 > 1.2 and s1["ring"] and off(s1["ring"], about(ring0, A, f1)) <= 3 and (not key or off(dot1, about(dot0, A, f1)) <= 3),
              f"wheel: zooms {f1:.3f}x toward the pointer (ring {off(s1['ring'], about(ring0, A, f1)):.2f} px, dot {off(dot1, about(dot0, A, f1)) if key else 0:.2f} px from where it should be)")
        check(s1["ring"] and abs(s1["ring"][2] / ring0[2] - f1) < 0.02 * f1, f"wheel: the ring grows by the zoom factor ({ring0[2]:.1f} -> {(s1['ring'] or [0, 0, 0])[2]:.1f} px, {f1:.3f}x)")
        check(s1["sy"] == s0["sy"], f"wheel: the page does not scroll ({s0['sy']} -> {s1['sy']})")
        # 2. a trackpad pinch: a ctrl wheel, here at a dot
        cdp = await ctx.new_cdp_session(pg)
        B = dot1 or A; r1 = s1["ring"] or ring0
        for _ in range(3): await cdp.send("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": B[0], "y": B[1], "deltaX": 0, "deltaY": -10, "modifiers": 2})
        await pg.wait_for_timeout(150)
        s2 = await st(); f2 = k_of(s2) / f1
        check(f2 > 1.2 and off(s2["ring"], about(r1, B, f2)) <= 3, f"ctrl wheel (trackpad pinch): zooms {f2:.3f}x more toward the pointer (ring {off(s2['ring'], about(r1, B, f2)):.2f} px off)")
        check(s2["scale"] == 1 and s2["dpr"] == s0["dpr"], f"ctrl wheel: the page itself does not zoom (visualViewport.scale {s2['scale']}, devicePixelRatio {s0['dpr']} -> {s2['dpr']})")
        # 3. labels keep their size; hover and click name a dot while zoomed
        check(s2["font"] == s0["font"], f"labels keep their font size ({s0['font']} at 1x, {s2['font']} at {k_of(s2):.2f}x)")
        key2, xy2 = await dot_in_view(pg)
        if key2:
            await pg.mouse.move(*xy2); await pg.wait_for_timeout(150)
            hov = await st()
            await pg.mouse.move(xy2[0] + 200, xy2[1] + 200); await pg.wait_for_timeout(50)
            await pg.mouse.click(*xy2); await pg.wait_for_timeout(150)
            clk = await st()
            check(hov["peek"] == key2 and clk["peek"] == key2, f"zoomed: hovering and clicking a dot still name it ({key2}: {hov['peek']}, {clk['peek']})")
        else: check(False, "zoomed: a dot in view to hover")
        ok, say = await steady_tip(pg)
        check(ok, f"zoomed: the hover name stays shown and in place through 32 hovers on one dot ({say})")
        if SHOTS: await pg.screenshot(path=os.path.join(SHOTS, "desktop-zoomed.png"))
        # 4. a drag turns while zoomed and keeps the zoom
        cv = await pg.locator("#depth3d canvas").bounding_box(); cx, cy = cv["x"] + cv["width"] / 2, cv["y"] + cv["height"] / 2
        h0, k0 = await pg.evaluate(BEAM), k_of(await st())
        await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx + 120, cy + 20, steps=8); await pg.mouse.up(); await pg.wait_for_timeout(150)
        s4 = await st()
        check(await pg.evaluate(BEAM) != h0 and s4["v"] and s4["v"]["a"] != 0 and k_of(s4) == k0, f"zoomed: a drag still turns ({s4['v']}) and keeps the zoom ({k0:.3f})")
        if SHOTS: await pg.screenshot(path=os.path.join(SHOTS, "desktop-zoomed-turned.png"))
        await pg.mouse.move(cx, cy)
        for _ in range(12): await pg.mouse.wheel(0, -300)
        await pg.wait_for_timeout(100); hi = k_of(await st())
        for _ in range(16): await pg.mouse.wheel(0, 300)
        await pg.wait_for_timeout(100); lo = k_of(await st())
        check(abs(hi - 8) < 1e-6 and lo == 1, f"the zoom stays between 1x and 8x ({hi}, {lo})")
        # 5. buttons and keys
        zin, zout, zreset = (pg.locator(f"#depth3d [data-zoom={n}]") for n in ("in", "out", "reset"))
        if await zin.count() and await zout.count() and await zreset.count():
            await zin.click(); a = k_of(await st()); await zin.click(); bb = k_of(await st()); await zout.click(); c = k_of(await st())
            check(abs(a - 1.5) < 1e-6 and abs(bb - 2.25) < 1e-6 and abs(c - 1.5) < 1e-6, f"buttons: + and - zoom in steps of 1.5 ({a}, {bb}, {c})")
            await pg.focus("#depth3d canvas"); await pg.keyboard.press("+"); d = k_of(await st()); await pg.keyboard.press("-"); await pg.keyboard.press("-"); e = k_of(await st())
            check(abs(d - 2.25) < 1e-6 and abs(e - 1) < 1e-6, f"keys: + and - zoom with the canvas in focus ({d}, {e})")
            await pg.keyboard.press("+"); await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx - 90, cy - 30, steps=6); await pg.mouse.up()
            await zreset.click(); await pg.wait_for_timeout(100); s5 = await st()
            same = s5["cam"] and cam0 and max(abs(x - y) for x, y in zip(s5["cam"], cam0)) < 1e-6
            check(k_of(s5) == 1 and s5["v"]["a"] == 0 and s5["v"]["p"] == 0 and same, f"Reset view: back to 1x, no turn, the first camera ({s5['v']}, camera same: {same})")
            labels = await pg.evaluate("[...document.querySelectorAll('#depth3d .lbl:not(.tip)')].filter(l => +l.style.opacity > .5).map(l => l.getBoundingClientRect()).map(r => [r.left, r.top, r.right, r.bottom])")
            zr = await pg.evaluate("(r => [r.left, r.top, r.right, r.bottom])(document.querySelector('#depth3d .xp-d3-zoom').getBoundingClientRect())")
            under = [l for l in labels if l[0] < zr[2] and l[2] > zr[0] and l[1] < zr[3] and l[3] > zr[1]]
            check(not under, f"no label runs under the zoom buttons ({under})")
            # 6. pan: shift-drag and right-drag move the zoomed view (the scene follows the pointer); a plain drag still turns
            async def drag(dx, dy, how=None):
                if how == "shift": await pg.keyboard.down("Shift")
                await pg.mouse.move(cx, cy); await pg.mouse.down(button="right" if how == "right" else "left")
                await pg.mouse.move(cx + dx, cy + dy, steps=6); await pg.mouse.up(button="right" if how == "right" else "left")
                if how == "shift": await pg.keyboard.up("Shift")
                await pg.wait_for_timeout(80); return await st()
            s6 = await drag(-80, 0, "shift")
            check(s6["v"]["x"] == 0 and s6["v"]["y"] == 0 and s6["v"]["a"] == 0, f"pan: at 1x a shift-drag moves nothing and turns nothing ({s6['v']})")
            await zin.click(); await zin.click(); s6 = await st(); r6 = s6["ring"]
            s7 = await drag(-60, -40, "shift")
            check(off(s7["ring"], [r6[0] - 60, r6[1] - 40]) <= 2 and s7["v"]["a"] == s6["v"]["a"] and k_of(s7) == k_of(s6),
                  f"pan: a shift-drag moves the zoomed scene with the pointer (ring {off(s7['ring'], [r6[0] - 60, r6[1] - 40]):.2f} px off), no turn, same zoom ({s7['v']})")
            s8 = await drag(50, 30, "right")
            check(off(s8["ring"], [s7["ring"][0] + 50, s7["ring"][1] + 30]) <= 2 and s8["v"]["a"] == s6["v"]["a"],
                  f"pan: a right-drag moves it too (ring {off(s8['ring'], [s7['ring'][0] + 50, s7['ring'][1] + 30]):.2f} px off), no turn")
            menu = await pg.evaluate("[!document.querySelector('#depth3d canvas').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })), document.querySelector('.pv-who').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))]")
            check(menu == [True, True], f"pan: the context menu is held back on the canvas only (canvas, elsewhere: {menu})")
            W, H, k = cv["width"], cv["height"], k_of(s8)
            for _ in range(5): s9 = await drag(250, 250, "shift")
            for _ in range(5): s10 = await drag(-250, -250, "shift")
            unders = []
            await zreset.click(); rr = (await st())["ring"]; await pg.mouse.move(*rr[:2])   # about 3x toward the target's ring
            for _ in range(28): await pg.mouse.wheel(0, -20)
            await pg.wait_for_timeout(100); unders += await pg.evaluate(UNDER)
            await zreset.click(); await pg.mouse.move(cv["x"] + 590, cv["y"] + 315.5)   # about 5x toward a dashed ring on the photo (as in the video)
            for _ in range(40):   # at every step
                await pg.mouse.wheel(0, -20); await pg.wait_for_timeout(20)
                unders += await pg.evaluate(NAMELESS)
                unders += await pg.evaluate(UNDER) + await pg.evaluate("""(() => { const n = document.querySelector('#depth3d .xp-d3-note').getBoundingClientRect().top;   // nor squeezed in below them
                  return [...document.querySelectorAll('#depth3d .lbl:not(.tip)')].filter(l => +l.style.opacity > .5 && l.getBoundingClientRect().bottom > n).map(l => l.textContent + ' below the note'); })()""")
            unders = sorted(set(unders))
            await zin.click(); await zin.click()   # about 7x, then at the scene's four corners
            for xy in ((0, 0), (1, 0), (0, 1), (1, 1)):   # the zoomed view at the scene's four corners
                for _ in range(5): await drag(-250 if xy[0] else 250, -250 if xy[1] else 250, "shift")
                unders += await pg.evaluate(UNDER)
            check(not unders, f"zoomed toward the ring and panned to each corner: no name runs under the tabs, the zoom box, the note or the hint ({unders})")
            check(s9["v"]["x"] == 0 and s9["v"]["y"] == 0 and abs(s10["v"]["x"] - (W - W / k)) < 1 and abs(s10["v"]["y"] - (H - H / k)) < 1,
                  f"pan: stops at the edges of the whole scene ({s9['v']['x']:.1f}, {s9['v']['y']:.1f} and {s10['v']['x']:.1f}, {s10['v']['y']:.1f} of {W - W / k:.1f}, {H - H / k:.1f})")
            # the dashed "no distance" rings fade in with the swing, as everything else does
            await pg.click("#tab-photo"); await pg.click("#tab-depth"); u0 = await pg.evaluate("__depth.view.unk")
            await pg.wait_for_timeout(2400); u1 = await pg.evaluate("__depth.view.unk")
            check(u0 is not None and u0 < .05 and u1 == 1, f"the dashed no-distance rings fade in with the swing (opacity {u0} at its start, {u1} after)")
        else: check(False, "the Depth panel has + , - and Reset view buttons")
        check(not pg.errors, f"desktop: no page errors {pg.errors}")
        await ctx.close()

        # ---------------- phone ----------------
        ctx, pg = await open_depth(b, True)
        st = lambda: pg.evaluate(STATE)
        cdp = await ctx.new_cdp_session(pg)

        async def touch(kind, pts=()):
            await cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"id": i, "x": x, "y": y} for i, x, y in pts]})
            await pg.wait_for_timeout(20)

        s0 = await st(); ring0 = s0["ring"] or [195, 400, 20]
        cv = await pg.locator("#depth3d canvas").bounding_box()
        M = [min(cv["x"] + cv["width"] - 70, ring0[0] + 30), ring0[1] + 20]   # the fingers' midpoint, beside the ring
        await touch("touchStart", [(0, M[0] - 30, M[1])])
        await touch("touchStart", [(0, M[0] - 30, M[1]), (1, M[0] + 30, M[1])])
        for i in range(1, 9):
            d = 60 + 120 * i / 8
            await touch("touchMove", [(0, M[0] - d / 2, M[1]), (1, M[0] + d / 2, M[1])])
        await touch("touchEnd"); await pg.wait_for_timeout(200)
        s1 = await st(); f1 = k_of(s1)
        check(abs(f1 - 3) < 0.05 and s1["ring"] and off(s1["ring"], about(ring0, M, f1)) <= 3,
              f"phone pinch: zooms {f1:.3f}x toward the fingers' midpoint (ring {off(s1['ring'], about(ring0, M, f1)):.2f} px off)")
        check(s1["scale"] == 1 and s1["sy"] == s0["sy"] and (s1["v"] or {}).get("a", 1) == 0, f"phone pinch: the page does not zoom or scroll (scale {s1['scale']}, scrollY {s0['sy']} -> {s1['sy']}) and nothing turns ({s1['v']})")
        clash = await pg.evaluate(CLASH)
        check(not clash, f"phone zoomed: no two names overlap ({clash})")
        # the names moved below the note and hint (a pinch like the video's: 3.6x just right of the ring)
        await pg.tap("#depth3d [data-zoom=reset]"); await pg.wait_for_timeout(100)
        N = [ring0[0] + 20, ring0[1] + 10]
        await touch("touchStart", [(0, N[0] - 25, N[1])]); await touch("touchStart", [(0, N[0] - 25, N[1]), (1, N[0] + 25, N[1])])
        during = set()
        for i in range(1, 11):
            d = 50 + 130 * i / 10
            await touch("touchMove", [(0, N[0] - d / 2, N[1] - d / 6), (1, N[0] + d / 2, N[1] + d / 6)])
            during.update(await pg.evaluate(CLASH))
            during.update(await pg.evaluate(NAMELESS))
        await touch("touchEnd"); await pg.wait_for_timeout(200); f1 = k_of(await st())
        check(not during, f"phone: at every step of a pinch no two names overlap, and every ring in view keeps its name ({sorted(during)})")
        sliver = await pg.evaluate("""(() => { const b = document.getElementById('depth3d').getBoundingClientRect();
          return [...document.querySelectorAll('#depth3d .lbl:not(.tip)')].filter(l => +l.style.opacity > .5).filter(l => { const r = l.getBoundingClientRect(); return r.bottom > b.bottom || r.top < b.top; }).map(l => l.textContent); })()""")
        check(not sliver, f"phone zoomed: no name is cut off at the frame's edge ({sliver})")
        if SHOTS: await pg.screenshot(path=os.path.join(SHOTS, "phone-zoomed.png"))
        # one finger still turns, and keeps the zoom
        h0 = await pg.evaluate(BEAM)
        await touch("touchStart", [(0, N[0], N[1])])   # as in the video: 90 px left, from where the pinch was
        for i in range(1, 31): await touch("touchMove", [(0, N[0] - 3 * i, N[1])])
        await touch("touchEnd"); await pg.wait_for_timeout(150); s2 = await st()
        check(await pg.evaluate(BEAM) != h0 and s2["v"] and s2["v"]["a"] != 0 and abs(k_of(s2) - f1) < 1e-9, f"phone: one finger still turns ({s2['v']}) and keeps the zoom")
        clash = await pg.evaluate(CLASH) + await pg.evaluate(NAMELESS)
        check(not clash, f"phone zoomed and turned: no two names overlap or touch, and every ring in view keeps its name ({clash})")
        # the zoom buttons are 44 px taps
        sizes = await pg.evaluate("[...document.querySelectorAll('#depth3d .xp-d3-zoom button')].map(b => [b.getBoundingClientRect().width, b.getBoundingClientRect().height])")
        check(len(sizes) == 3 and all(w >= 44 and h >= 44 for w, h in sizes), f"phone: the zoom buttons are 44 px taps ({sizes})")
        if len(sizes) == 3:
            await pg.tap("#depth3d [data-zoom=reset]"); await pg.wait_for_timeout(100)
            check(k_of(await st()) == 1, "phone: a tap on Reset view goes back to 1x")
        # a one-finger swipe outside the canvas still scrolls the page
        await pg.evaluate("scrollTo(0, 0); document.body.scrollTo(0, 0)"); await pg.wait_for_timeout(100)
        who = await pg.locator(".pv-who").bounding_box()   # the name and verdict over the photo: outside the canvas
        await cdp.send("Input.synthesizeScrollGesture", {"x": who["x"] + who["width"] / 2, "y": who["y"] + who["height"] / 2, "yDistance": -300, "gestureSourceType": "touch", "speed": 1200})
        await pg.wait_for_timeout(300)
        sy = await pg.evaluate("scrollY + document.body.scrollTop")
        check(sy > 50 and await pg.evaluate("visualViewport.scale") == 1, f"phone: a one-finger swipe outside the canvas scrolls the page (scrollY {sy})")
        check(not pg.errors, f"phone: no page errors {pg.errors}")
        await ctx.close()
        await b.close()
    print(f"{'FAIL' if fails else 'PASS'} depth zoom: {len(fails)} failed")
    sys.exit(1 if fails else 0)

asyncio.run(main())
