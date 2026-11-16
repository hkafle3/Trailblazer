"""Browser check of the 3D intro "How this map was made" on Explore (web/intro.js), in system Chrome with the GPU on,
on a desktop (1440 x 900) and as a phone (390 x 844, touch). Needs the app up (npm run dev).
First visit: the page is covered from its first paint, the film plays over it at a steady 60 frames a second, the flat
sky it ends on is drawn on the real #map oval (its edges read back from the drawn pixels, within 2 px), then the film is
gone and the "Welcome to Trailblazer" tour opens. The sky replay does not start under it. A second visit does not play
it and does not fetch intro.js, intro.css, three.js or data/intro/. Links with ?day=, ?focus=, ?q= or ?sample=, and a
browser that has seen the tour (ch.tour, which the other suites set), do not play it either.
The "How this map was made" button replays it over a panned and zoomed map on another day and lands on that same view
(edges within 2 px, the view and the day unchanged, focus back on the button). Skip and Escape end it within 4 s, and
Skip works before the film has loaded. Reduced motion: nine stills with nine captions and a Next button, no animation.
Run: uv run -q --with playwright python web/tests/intro_ui.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, math, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
SIZES = [("desktop", dict(viewport={"width": 1440, "height": 900})),
         ("phone", dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True))]
LAZY = ("intro.js", "intro.css", "three", "data/intro/")   # what a visit that does not play the film must not fetch
ON = "document.documentElement.dataset.intro"
RECT = "(() => { const b = document.getElementById('map').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()"
DAY = "+document.getElementById('time').value"
TOUR = "document.querySelector('.tour-card h2')?.textContent"
FILM_S = "window.__perf.frames.reduce((a, b) => a + b, 0) / 1000"   # seconds of film played so far


async def page(b, opts, errs, seen_tour=False, **more):
    ctx = await b.new_context(**opts, **more)
    if seen_tour: await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.maphint', '1') } catch {}")
    pg = await ctx.new_page(); pg.fetched = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    pg.on("request", lambda r: pg.fetched.append(r.url))
    return pg


async def film_up(pg):
    """The film has loaded and is on screen; its frame times are kept where they outlive it."""
    await pg.wait_for_function("window.__intro", timeout=60000)
    await pg.evaluate("window.__perf = window.__intro.perf")


async def landing(pg, why):
    """The flat sky's drawn edges, along the row and the column through the middle of the real map (kept on screen),
    against the oval of #map: an ellipse filling its box. An edge off the screen reads as the screen's own edge."""
    x, y, w, h = await pg.evaluate(RECT); vw, vh = await pg.evaluate("[innerWidth, innerHeight]")
    cx, cy, a, b = x + w / 2, y + h / 2, w / 2, h / 2
    sx, sy = min(max(cx, 2), vw - 2), min(max(cy, 2), vh - 2)
    got = await pg.evaluate(f"window.__intro.edges({sx}, {sy})")
    dx, dy = a * math.sqrt(max(0, 1 - ((sy - cy) / b) ** 2)), b * math.sqrt(max(0, 1 - ((sx - cx) / a) ** 2))
    want = {"x0": max(0, cx - dx), "x1": min(vw, cx + dx), "y0": max(0, cy - dy), "y1": min(vh, cy + dy)}
    off = {k: round(got[k] - want[k], 2) for k in want}
    assert all(abs(v) <= 2 for v in off.values()), f"{why}: the flat sky is not on the map. Drawn {got}, #map oval {want}"
    on_screen = sum(0 < want[k] < lim for k, lim in [("x0", vw), ("x1", vw), ("y0", vh), ("y1", vh)])
    assert on_screen >= 2, f"{why}: only {on_screen} edges of the map are on screen, too few to check the landing"
    return f"left {off['x0']:+.1f}, right {off['x1']:+.1f}, top {off['y0']:+.1f}, bottom {off['y1']:+.1f} px"


async def gone(pg, why, within=4000):
    await pg.wait_for_function(f"!document.getElementById('intro') && !{ON}", timeout=within)
    assert await pg.evaluate("![...document.body.children].some(e => e.inert)"), f"{why}: the page is still inert"


async def run(b, name, opts):
    errs = []
    # ---- first visit ----
    pg = await page(b, opts, errs)
    await pg.goto(BASE + "/explore", wait_until="commit")
    await pg.wait_for_function(f"{ON} && document.body", timeout=10000)   # set before anything is drawn
    await pg.wait_for_selector("#intro-skip"); await film_up(pg)
    assert await pg.evaluate("localStorage.getItem('ch.intro')") == "1", "the intro is not remembered as seen"
    assert not await pg.evaluate("window.__intro.reduced"), "the film should be moving here"
    await pg.wait_for_selector("body[data-ready='1']")
    assert not await pg.evaluate("document.getElementById('play').classList.contains('on')"), "the sky replay started under the film"
    assert not await pg.evaluate(TOUR), "the tour opened over the film"
    await pg.wait_for_function(f"{FILM_S} > window.__intro.T_HANDOVER + .3", timeout=60000)   # the flat sky is on the map and dissolving
    assert not await pg.evaluate(TOUR), "the tour opened before the film ended"
    fps = await pg.evaluate("""(() => { const f = window.__perf.frames.slice().sort((a, b) => a - b), n = f.length, sum = f.reduce((a, b) => a + b, 0);
      return { frames: n, fps: +(1000 * n / sum).toFixed(1), median: +f[n >> 1].toFixed(1), p99: +f[Math.floor(n * .99)].toFixed(1), worst: +f[n - 1].toFixed(1), slow: f.filter(x => x > 25).length }; })()""")
    land = await landing(pg, f"{name} first visit")
    await gone(pg, f"{name} first visit", 6000)
    await pg.wait_for_function(f"{TOUR} === 'Welcome to Trailblazer'", timeout=4000)
    assert fps["fps"] >= 59 and fps["median"] <= 17.5 and fps["p99"] <= 18.5 and fps["slow"] <= 3, f"{name}: not a steady 60 fps: {fps}"
    print(f"{name}: first visit plays ({fps['frames']} frames, {fps['fps']} fps, median {fps['median']} ms, 99th {fps['p99']} ms, worst {fps['worst']} ms, {fps['slow']} over 25 ms), lands on #map ({land}), then the tour opens")

    # ---- second visit: nothing plays, nothing of the film is fetched ----
    pg.fetched.clear()
    await pg.reload(); await pg.wait_for_selector("body[data-ready='1']"); await pg.wait_for_function(f"{TOUR} === 'Welcome to Trailblazer'", timeout=6000)
    assert not await pg.evaluate(f"{ON} || document.getElementById('intro')"), "the intro played on a second visit"
    lazy = [u for u in pg.fetched if any(k in u for k in LAZY)]
    assert not lazy, f"a visit without the film fetched {lazy}"
    print(f"{name}: a second visit skips it and fetches none of it")
    await pg.context.close()

    # ---- links to a day, a comet, a search or a sample, and a browser that has seen the tour ----
    for url, seen in [("/explore?day=120", False), ("/explore?focus=3I%2FATLAS&day=200", False), ("/explore?q=barnard", False), ("/explore?sample=1", False), ("/explore", True)]:
        p = await page(b, opts, errs, seen_tour=seen)
        await p.goto(BASE + url); await p.wait_for_selector("body[data-ready='1']"); await p.wait_for_timeout(1200)
        assert not await p.evaluate(f"{ON} || document.getElementById('intro')"), f"{url}: the intro played"
        lazy = [u for u in p.fetched if any(k in u for k in LAZY)]
        assert not lazy, f"{url}: fetched {lazy}"
        await p.context.close()
    print(f"{name}: ?day=, ?focus=, ?q=, ?sample= and a browser with ch.tour set do not play it")

    # ---- the button: over a moved map on another day, back to the same view ----
    pg = await page(b, opts, errs, seen_tour=True)
    await pg.goto(BASE + "/explore?day=300"); await pg.wait_for_selector("body[data-ready='1']"); await pg.wait_for_selector(".mk.known", state="attached"); await pg.wait_for_timeout(1500)
    if name == "desktop":   # zoom in and pan, so the map is not where it opens (the phone already opens zoomed in on a comet)
        await pg.focus("#map")
        for key in ["+", "ArrowLeft", "ArrowLeft", "ArrowLeft"]: await pg.keyboard.press(key); await pg.wait_for_timeout(700)   # each glides
        assert (await pg.evaluate(RECT))[2] > 1500, "the map did not zoom in"
    view = await pg.evaluate(RECT)
    await pg.click("#how"); await film_up(pg)
    land = await landing(pg, f"{name} replay")
    await pg.wait_for_timeout(1500); await pg.click("#intro-skip"); await gone(pg, f"{name} Skip")
    after = await pg.evaluate(RECT)
    assert all(abs(p - q) < .5 for p, q in zip(view, after)) and await pg.evaluate(DAY) == 300, f"{name}: the view changed under the film: {view} to {after}, day {await pg.evaluate(DAY)}"
    assert await pg.evaluate("document.activeElement?.id") == "how", "focus did not go back to the button"
    print(f"{name}: the button replays it over a moved map and lands on the same view ({land}); Skip ends it")
    await pg.click("#how"); await film_up(pg); await pg.wait_for_timeout(1200); await pg.keyboard.press("Escape"); await gone(pg, f"{name} Escape")
    await pg.evaluate("document.getElementById('how').click(); new Promise(done => { const t = setInterval(() => { const s = document.getElementById('intro-skip'); if (s) { clearInterval(t); s.click(); done(); } }, 5); })")
    await gone(pg, f"{name} Skip while loading", 1500); await pg.wait_for_timeout(1500)   # the film, loaded late, must stay away
    assert not await pg.evaluate("window.__intro || document.getElementById('intro')"), "a film skipped while loading came back"
    print(f"{name}: Escape ends it, and Skip works before it has loaded")
    await pg.context.close()

    # ---- reduced motion: stills with Next ----
    pg = await page(b, opts, errs, reduced_motion="reduce")
    await pg.goto(BASE + "/explore"); await film_up(pg)
    assert await pg.evaluate("window.__intro.reduced") and await pg.is_visible("#intro-next")
    seen = []
    for i in range(9):
        await pg.wait_for_timeout(600); seen.append(await pg.inner_text("#intro-cap-text"))
        assert await pg.evaluate("window.__perf.frames.length") == 0, "reduced motion ran the animation"
        await pg.click("#intro-next")
    assert len(set(seen)) == 9, f"reduced motion: {len(set(seen))} captions, not 9"
    await gone(pg, f"{name} reduced motion"); await pg.wait_for_function(f"{TOUR} === 'Welcome to Trailblazer'", timeout=4000)
    await pg.keyboard.press("Escape"); await pg.wait_for_function(f"!{TOUR}")   # close the tour
    await pg.click("#how"); await film_up(pg); await pg.wait_for_timeout(500); await pg.click("#intro-skip"); await gone(pg, f"{name} reduced motion Skip", 1500)
    await pg.click("#how"); await film_up(pg); await pg.wait_for_timeout(500); await pg.keyboard.press("Escape"); await gone(pg, f"{name} reduced motion Escape", 1500)
    print(f"{name}: reduced motion shows 9 stills with Next and no animation, then the tour; Skip and Escape end it")
    await pg.context.close()
    assert not errs, f"{name}: page errors {errs}"


async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"])
        for name, opts in SIZES: await run(b, name, opts)
        await b.close()
    print("intro_ui: all checks passed")

asyncio.run(main())
