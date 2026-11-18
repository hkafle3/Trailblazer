"""Phase 3 smoothness (E3): frame times while Depth plays, as deep_zoom_measure.py measures them (the browser's own
requestAnimationFrame clock, headless Chrome with the GPU on). Each page, at 1440x900 DPR 2 and at 881x872, through two
observed loops of playback, a drag turn, and a zoom in and out:
  the comet page's Depth (3I/ATLAS, comet3d.js) and the time-lapse's Depth (C-0176 at 4.6 um, live/depth.js).
Budget: 95% of frames within 17 ms, none over 50 ms, no page errors. Run it against main first for the baseline (main's
comet Depth is the flat path and its time-lapse leaves Depth when played; the same gestures are timed).
Run: uv run -q --with playwright python web/tests/depth_play_measure.py [base url] [label]   (default http://127.0.0.1:8787)"""
import asyncio, json, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
LABEL = sys.argv[2] if len(sys.argv) > 2 else "build"
ARGS = ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]   # deep_zoom_ui.py's
PAGES = {
    "comet": (f"{BASE}/comet.html?id=" + urllib.parse.quote("3I/ATLAS", safe=""), "#c-scene", ".p3-play .tl-knob", 2 * 5 * 3.4),
    "timelapse": (f"{BASE}/timelapse.html?ra=84.0181&dec=-6.5770&det=D1&blink=C-0176&ch=91&view=depth", "#depth3d", "#play", 2 * 4 * 1.6),
}
REC = """() => { window.__fr = []; window.__rec = true; let last = 0; const f = t => { if (last) __fr.push(t - last); last = t; if (__rec) requestAnimationFrame(f); }; requestAnimationFrame(f); }"""
fails = []
def check(ok, what, detail): print(("PASS " if ok else "FAIL ") + what + ": " + detail, flush=True); ok or fails.append(what)
def pct(a, p): a = sorted(a); return a[min(len(a) - 1, int(len(a) * p / 100))]

async def run(b, name, w, h, dpr):
    url, box, knob, loops = PAGES[name]
    ctx = await b.new_context(viewport={"width": w, "height": h}, device_scale_factor=dpr, reduced_motion="no-preference")
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
    pg = await ctx.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    await pg.goto(url)
    if name == "comet":
        await pg.wait_for_function("document.querySelector('main').dataset.ready"); await pg.click("#tab-depth")
        await pg.wait_for_timeout(2500)   # three.js and the photos load (main: the flat path draws)
        await pg.evaluate("window.__scene?.play?.(false)")
    else:
        await pg.wait_for_function("!!window.__lapse?.state.m && document.getElementById('depth3d').dataset.state === 'ready'", timeout=300000)
        await pg.wait_for_timeout(4000)   # the blink lands, the swing ends
    await pg.evaluate("document.querySelector(arguments[0] ?? 'body')?.scrollIntoView?.({ block: 'center' })".replace("arguments[0] ?? 'body'", f"'{box}'"))
    await pg.wait_for_timeout(500)
    await pg.evaluate(REC)
    # two loops of playback
    k = pg.locator(knob)
    if await k.count() and await k.is_visible(): await k.click()
    await pg.wait_for_timeout(int(loops * 1000) + 500)
    if await k.count() and await k.is_visible(): await k.click()
    # a drag turn
    r = await pg.locator(box).bounding_box(); cx, cy = r["x"] + r["width"] * .55, r["y"] + r["height"] * .55
    await pg.mouse.move(cx, cy); await pg.mouse.down()
    for n in range(40): await pg.mouse.move(cx - 4 * n, cy + n); await pg.wait_for_timeout(16)
    await pg.mouse.up()
    # a zoom in and out
    for d in [-120] * 12 + [120] * 12: await pg.mouse.wheel(0, d); await pg.wait_for_timeout(40)
    await pg.wait_for_timeout(600)
    fr = await pg.evaluate("window.__rec = false, __fr")
    p95, worst = pct(fr, 95), max(fr)
    check(p95 <= 17 and worst <= 50 and not errs, f"{LABEL} {name} {w}x{h} DPR {dpr}",
          f"{len(fr)} frames: 95% within {p95:.1f} ms (17 allowed), worst {worst:.1f} ms (50 allowed), {sum(f > 25 for f in fr)} over 25 ms, errors {errs[:2]}")
    await ctx.close()
    return dict(frames=len(fr), p50=round(pct(fr, 50), 2), p95=round(p95, 2), p99=round(pct(fr, 99), 2), worst=round(worst, 1), over25=sum(f > 25 for f in fr))

async def main():
    out = {}
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True, args=ARGS)
        for name in PAGES:
            for w, h, dpr in ((1440, 900, 2), (881, 872, 1)):
                out[f"{name}_{w}x{h}"] = await run(b, name, w, h, dpr)
        await b.close()
    print(json.dumps({LABEL: out})); print("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"); sys.exit(1 if fails else 0)
asyncio.run(main())
