"""Browser check of the 3D intro "How this map was made" on Explore (web/intro.js), in system Chrome with the GPU on,
on a desktop (1440 x 900) and as a phone (390 x 844, touch). Needs the app up (npm run dev).
First visit: the page is covered from its first paint, the film plays over it at a steady 60 frames a second, the flat
sky it ends on is drawn on the real #map oval (its edges read back from the drawn pixels, within 2 px), then the film is
gone and the "Welcome to Trailblazer" tour opens. The sky replay does not start under it. A second visit does not play
it and does not fetch intro.js, intro.css, three.js or data/intro/. Links with ?day=, ?focus=, ?q= or ?sample=, and a
browser that has seen the tour (ch.tour, which the other suites set), do not play it either.
The "How this map was made" button replays it over a panned and zoomed map on another day and lands on that same view
(edges within 2 px, the view and the day unchanged, focus back on the button). Skip and Escape end it within 4 s, and
Skip works before the film has loaded. Reduced motion: ten stills with ten captions and a Next button, no animation, the credit line on the last.
The film's own scenes are checked from the pixels it really draws (frame by frame through ?intro=rec): the flight down the
beam passes two rocks, two stars and a galaxy as solid bodies in order of distance and ends with the whole photo in view.
The photo assembles from the flight: its frame starts empty, each body's light lands on it as a dot at that body's own
place, in the order the bodies are passed, and only after the last does the rest of the photo arrive. The filter's stripes
are on the photo all the way (violet on one side, green on the other). There one star is ringed, and at each of the
telescope's three steps the photo being taken moves a stripe along while the star stays put and its wavelength changes.
The film is one camera move: from the start of the flight to the ring of photos the camera never jumps from one frame to
the next and nothing fades out. Words: every caption is one line with nothing under it, no credit or small print shows
while the film plays, and the credits come on the finished map with a link to film.html, which names every source.
The flight, its arrival, the photo's assembly and the captions are also checked at 320 x 1000 and 320 x 1280. Leaving the page while it loads (pagehide, and a
real navigation away and back) takes the film off at once and it does not come back.
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
MOVE, GLANCE, TURN, ZOOM = .16, 15, 4, .2   # the most the camera may do in one frame: move (as a share of its distance to its subject), turn during the flight's glances at the bodies and turn after it (degrees), change its lens (log of the ratio)
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


async def flight_samples(pg, name, m):
    flight, progress = [], []
    for i in range(221):
        u = m["FLY0"] + (m["FLY1"] - m["FLY0"]) * i / 220
        p = await pg.evaluate(f"window.__intro.probe({u})")
        flight.append((u, sorted(p["flight"], key=lambda b: b["au"]), p["rush"]))
        progress.append(p["fly"])
    path = await pg.evaluate("""(() => { const p = window.__intro.flightPath();
      return { way: p.way.map(q => q.f), bodies: p.way.map(q => q.bf), t: p.t, f: p.f }; })()""")
    for key in ("way", "bodies", "t", "f"):
        assert all(a < b for a, b in zip(path[key], path[key][1:])), f"{name}: flight {key} is not strictly increasing"
    assert all(math.isfinite(f) for f in progress) and all(a < b for a, b in zip(progress, progress[1:])), f"{name}: the flight reverses or stops: {progress}"
    assert progress[-1] > max(path["bodies"][1:-1]), f"{name}: the flight ends before passing every body"
    passed = [next((u for u, bs, _ in flight if not bs[j]["front"]), None) for j in range(len(flight[0][1]))]
    assert all(u is not None for u in passed) and all(a < b for a, b in zip(passed, passed[1:])), f"{name}: bodies are not passed in order: {passed}"
    return flight


async def arrival(pg, name, m, vw, vh):
    """Where the flight ends, the photo is whole, in view and large: the middles of its four edges, in window pixels."""
    ed = (await pg.evaluate(f"window.__intro.probe({m['FLY1']})"))["photoEdges"]
    assert all(math.isfinite(q) for e in ed for q in e), f"{name}: the photo's edges at arrival are not finite: {ed}"
    assert all(0 < x < vw and 0 < y < vh for x, y in ed), f"{name}: at arrival the photo is not inside the window: {ed}"
    wide, high = math.dist(ed[0], ed[1]), math.dist(ed[2], ed[3])
    assert max(wide / vw, high / vh) > .6 and min(wide, high) > .8 * max(wide, high), f"{name}: at arrival the photo is {wide:.0f} by {high:.0f} px in a {vw} by {vh} window"
    return wide


async def assembly(pg, name, m, flight):
    """The photo assembles from the flight. Its frame is empty when the flight sets off; each body's light lands at
    that body's place on the photo, in the order the bodies are passed and not before the body has been reached; the
    rest of the photo comes only after the fifth; at the end all five dots are on a whole photo. The dots are read from
    the pixels drawn: a bright point where there was none before the light set off (unless an earlier dot is a few pixels away, or the body itself was in front of that place)."""
    look = lambda u, pts, r=1: pg.evaluate(f"window.__intro.look({u}, {pts}, {r})")
    first = (await pg.evaluate(f"window.__intro.probe({m['FLY0'] + 1.2})"))
    assert first["fill"] < .01 and all(b["landed"] == 0 for b in first["flight"]), f"{name}: the photo is not empty when the flight sets off: {first['fill']}, {[b['landed'] for b in first['flight']]}"
    lands = [b["lands"] for b in flight[0][1]]   # in order of distance
    reached = [next(u for u, bs, _ in flight if bs[j]["r"] > 12) for j in range(5)]
    assert all(a < b for a, b in zip(lands, lands[1:])), f"{name}: the lights do not land in the order of distance: {lands}"
    assert all(r < l < m["FLY1"] - .3 for r, l in zip(reached, lands)), f"{name}: a light lands before its body is reached, or too late to be seen: reached {reached}, lands {lands}"
    lit = []
    for j, t in enumerate(lands):
        before, after = await pg.evaluate(f"window.__intro.probe({t - 1.2})"), await pg.evaluate(f"window.__intro.probe({t + .4})")
        b0, b1 = sorted(before["flight"], key=lambda b: b["au"]), sorted(after["flight"], key=lambda b: b["au"])
        assert [b["landed"] > .99 for b in b1] == [i <= j for i in range(5)] and b0[j]["landed"] == 0, f"{name}: at {t:.1f}s the lights on the photo are {[b['landed'] for b in b1]}"
        assert after["fill"] < .01 or j == 4, f"{name}: the rest of the photo arrives before {b1[j]['name']}'s light"
        (was,), (now,) = await look(t - 1.2, [b0[j]["land"]]), await look(t + .4, [b1[j]["land"]])
        crowded = any(math.dist(b1[i]["land"], b1[j]["land"]) < 14 for i in range(j)) or math.dist(b0[j]["at"], b0[j]["land"]) < 8 * b0[j]["r"] + 20   # an earlier dot, or the body itself with its glow, in front of that place
        assert now[1] > 200 and (crowded or was[1] < now[1] - 60), f"{name}: no dot appears on the photo for {b1[j]['name']}: brightest {was[1]} before, {now[1]} after"
        lit.append(now[1])
    end = await pg.evaluate(f"window.__intro.probe({m['FLY1']})")
    assert end["fill"] > .99 and all(b["landed"] > .99 for b in end["flight"]), f"{name}: at arrival the photo is not whole with its five dots: {end['fill']}, {[b['landed'] for b in end['flight']]}"
    # the stripes ride with it: across the photo the tint runs from violet (more red than green) to green, half way down the beam and at arrival
    hues = []
    for u in ((m["FLY0"] + m["FLY1"]) / 2, m["FLY1"]):
        ed = (await pg.evaluate(f"window.__intro.probe({u})"))["photoEdges"]; (rx, ry), (lx, ly), (tx, ty), (bx, by) = ed
        at = lambda i, k: [lx + (rx - lx) * i + (tx - bx) * k, ly + (ry - ly) * i + (ty - by) * k]
        got = await look(u, [at(i, k) for i in (.06, .1, .14, .86, .9, .94) for k in (-.3, .38)], 2)
        left, right = [sum(g[2][c] for g in got[:6]) / 6 for c in range(3)], [sum(g[2][c] for g in got[6:]) / 6 for c in range(3)]
        assert left[2] > left[1] + 10 and right[1] - right[0] > left[1] - left[0] + 12, f"{name}: the photo's stripes do not run violet to green at {u:.1f}s: left {left}, right {right}"
        hues.append(round(right[1] - right[0] - left[1] + left[0]))
    return lands, lit, hues


async def words(pg, name, m, vw):
    """One line per caption, nothing under it, and no credit or small print on screen while the film plays. The credits
    come on the finished map, in one quiet line with a link to the film's own page."""
    assert not await pg.evaluate("document.getElementById('intro-cap-note')"), f"{name}: there is a note under the caption"
    longest = 0
    for a, b in m["CAPS"]:
        got = await pg.evaluate(f"""(() => {{ window.__intro.render({(a + b) / 2}); const el = document.getElementById('intro-cap-text'), r = document.createRange(); r.selectNodeContents(el);
          const rows = new Set([...r.getClientRects()].map(q => Math.round(q.top))), box = el.getBoundingClientRect(), cr = getComputedStyle(document.getElementById('intro-credit'));
          return [el.textContent, rows.size, box.left, box.right, +getComputedStyle(el).opacity, cr.visibility, +cr.opacity, [...document.getElementById('intro-cap').children].map(e => e.id || e.className)]; }})()""")
        said, rows, left, right, shown, vis, cred, kids = got
        assert said and shown > .9 and rows == 1 and left >= 0 and right <= vw, f"{name}: the caption at {(a + b) / 2:.1f}s is not one line inside the window: {got}"
        assert vis == "hidden" and cred == 0, f"{name}: the credit line shows during the film, at {(a + b) / 2:.1f}s"
        assert kids == ["cap-top", "intro-cap-text"], f"{name}: something sits under the caption: {kids}"
        longest = max(longest, len(said))
    got = await pg.evaluate(f"""(() => {{ window.__intro.render({m['CREDIT'] + .1}); const el = document.getElementById('intro-credit'), cs = getComputedStyle(el), b = el.getBoundingClientRect();
      return [el.textContent, cs.visibility, +cs.opacity, el.querySelector('a')?.getAttribute('href'), b.left, b.right, +getComputedStyle(document.getElementById('intro-cap')).opacity]; }})()""")
    assert got[1] == "visible" and got[2] > .9 and got[3] == "film.html" and got[4] >= 0 and got[5] <= vw and got[6] == 0, f"{name}: the credits are not on the finished map, alone, with their link: {got}"
    return len(m["CAPS"]), longest


async def one_move(pg, name, m):
    """No hard cut from the start of the flight to the ring: at 60 frames a second the camera never moves more than a
    small share of its distance to what it looks at, turns more than a little, or changes its lens much between two
    frames, and the picture stays fully shown. (Half a second apart the same measures are far past these limits.)"""
    n = int((m["RING"] + 1 - m["FLY0"]) * 60)
    cams = await pg.evaluate(f"""(() => {{ const out = [], op = id => +getComputedStyle(document.getElementById(id)).opacity;
      for (let i = 0; i <= {n}; i++) {{ const c = window.__intro.probe({m['FLY0']} + i / 60).cam; out.push([c.pos, c.dir, c.fov, c.dist, op('intro') * op('intro-gl')]); }} return out; }})()""")
    def jump(a, b):
        return (math.dist(a[0], b[0]) / min(a[3], b[3]), math.degrees(math.acos(max(-1, min(1, sum(p * q for p, q in zip(a[1], b[1])))))), abs(math.log(a[2] / b[2])))
    worst = [max(jump(a, b)[k] for a, b in zip(cams, cams[1:])) for k in range(3)]
    join = cams[int((m['FLY1'] - m['FLY0']) * 60):]; calm = max(jump(a, b)[1] for a, b in zip(join, join[1:]))   # after the flight's own glances at the bodies
    assert all(c[4] == 1 for c in cams), f"{name}: the picture fades between the flight and the ring"
    assert worst[0] < MOVE and worst[1] < GLANCE and calm < TURN and worst[2] < ZOOM, f"{name}: the camera jumps between the flight and the ring: moves {worst[0]:.3f} of its distance, turns {worst[1]:.2f} degrees, lens changes {worst[2]:.3f} in one frame"
    apart = [max(jump(a, b)[k] for a, b in zip(cams, cams[30:])) for k in range(3)]
    assert apart[0] > 3 * MOVE, f"{name}: the continuity check would not see a cut: {apart}"
    return [worst[0], calm, worst[2]]


async def run(b, name, opts):
    errs = []
    # ---- first visit ----
    pg = await page(b, opts, errs)
    await pg.goto(BASE + "/explore", wait_until="commit")
    await pg.wait_for_function(f"{ON} && document.body", timeout=10000)   # set before anything is drawn
    await pg.wait_for_selector("#intro-skip"); await film_up(pg)
    assert await pg.evaluate("localStorage.getItem('ch.intro')") == "1", "the intro is not remembered as seen"
    assert not await pg.evaluate("window.__intro.reduced"), "the film should be moving here"
    assert await pg.evaluate("['probe', 'look', 'flightPath', 'marks'].every(k => !(k in window.__intro))"), "recording helpers are exposed during normal playback"
    await pg.wait_for_selector("body[data-ready='1']")
    assert not await pg.evaluate("document.getElementById('play').classList.contains('on')"), "the sky replay started under the film"
    assert not await pg.evaluate(TOUR), "the tour opened over the film"
    await pg.wait_for_function(f"{FILM_S} > window.__intro.T_HANDOVER + .3", timeout=120000)   # the flat sky is on the map and dissolving
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

    # ---- a stalled load: Skip is visible and works without intro.css; a stalled film gives up after 8 s and lands on the map ----
    async def stall(route): await asyncio.sleep(20); await route.abort()
    pg = await page(b, opts, errs, seen_tour=True)
    await pg.route("**/intro.css*", stall)
    await pg.goto(BASE + "/explore"); await pg.wait_for_selector("body[data-ready='1']"); await pg.wait_for_timeout(800)
    await pg.evaluate("document.getElementById('how').click()"); await pg.wait_for_selector("#intro-skip", timeout=1000)
    box = await pg.evaluate("(() => { const r = document.getElementById('intro-skip').getBoundingClientRect(), c = getComputedStyle(document.getElementById('intro')); return [r.width, r.height, r.right, c.position]; })()")
    assert box[0] > 20 and box[1] >= 40 and box[2] <= opts["viewport"]["width"] and box[3] == "fixed", f"Skip not shown without intro.css: {box}"
    await pg.click("#intro-skip"); await gone(pg, f"{name} Skip without intro.css")
    await pg.unroute("**/intro.css*"); await pg.route("**/three.module.js*", stall)
    await pg.evaluate("document.getElementById('how').click()"); await pg.wait_for_selector("#intro")
    await gone(pg, f"{name} stalled film", 10000)
    await pg.unroute("**/three.module.js*")
    await pg.context.close()
    print(f"{name}: a stalled intro.css still shows Skip, and a stalled film lands on the map within 10 s")

    # ---- data arriving after Skip or timeout releases its renderer and leaves a reopened film alone ----
    for way in ("Skip", "timeout"):
        pg = await page(b, opts, errs, seen_tour=True)
        held, release = asyncio.Event(), asyncio.Event()
        async def late_data(route):
            held.set(); await release.wait(); await route.continue_()
        await pg.route("**/data/intro/scene.json", late_data, times=1)
        await pg.goto(BASE + "/explore"); await pg.wait_for_selector("body[data-ready='1']")
        await pg.click("#how"); await asyncio.wait_for(held.wait(), timeout=10)
        await pg.evaluate("window.__lost = false; document.getElementById('intro-gl').addEventListener('webglcontextlost', () => { window.__lost = true; })")
        if way == "Skip": await pg.click("#intro-skip")
        await gone(pg, f"{name} late data {way}", 10000)
        await pg.click("#how"); await film_up(pg)
        await pg.evaluate("window.__reopened = window.__intro")
        release.set()
        await pg.wait_for_function("window.__lost", timeout=10000)
        assert await pg.evaluate("window.__intro === window.__reopened && !!document.getElementById('intro')"), "stale film touched the reopened intro"
        await pg.keyboard.press("Escape"); await gone(pg, f"{name} reopened intro")
        await pg.context.close()

    # ---- the film's own scenes, from the pixels drawn ----
    pg = await page(b, opts, errs, seen_tour=True)
    await pg.goto(BASE + "/explore?intro=rec"); await film_up(pg)
    m = await pg.evaluate("window.__intro.marks")
    probe = lambda u: pg.evaluate(f"window.__intro.probe({u})")
    look = lambda u, pts, r=2: pg.evaluate(f"window.__intro.look({u}, {pts}, {r})")
    vw, vh = opts["viewport"]["width"], opts["viewport"]["height"]
    # the flight: half way down the beam the photo is ahead in the middle, far smaller than it will be at the end
    e0 = (await probe((m["FLY0"] + m["FLY1"]) / 2))["photoEdges"]
    w0, w1 = abs(e0[0][0] - e0[1][0]), await arrival(pg, name, m, vw, vh)
    assert 10 < w0 < .5 * w1, f"{name}: the flight does not close in on the photo: {w0:.0f} px wide half way, {w1:.0f} px at the end"
    # The bodies. Each of the five (two rocks, two stars, a galaxy) is flown past as a solid body, held in view for a
    # while as it grows, and left behind, in order of distance. Checked on the pixels drawn: a rock is lit across its
    # face (a ring would be empty in the middle) and stands out from the sky; a star is bright and warmer than white, the
    # cooler star the warmer of the two (their real Gaia colors); the galaxy's photo is bright at its heart and fades
    # to nothing at its edge. Between bodies the speed lines come on, and they are off while a body is held.
    flight = await flight_samples(pg, name, m)
    assert [b["kind"] for b in flight[0][1]] == ["asteroid", "asteroid", "star", "star", "galaxy"], f"{name}: the flight's bodies: {flight[0][1]}"
    mean = lambda gs: sum(g[0] for g in gs) / len(gs)
    passed, warmth, held = [], [], []
    for j in range(5):
        obj, kind = flight[0][1][j]["name"], flight[0][1][j]["kind"]
        size = lambda b: b["r"] * (.4 if kind == "galaxy" else 1)   # the galaxy's own light fills the middle of its photo
        seen = [(u, bs[j], rush) for u, bs, rush in flight if bs[j]["drawn"] and bs[j]["front"] and size(bs[j]) >= (18 if name == "phone" else 28)
                and all(size(bs[j]) + 3 < q < lim - size(bs[j]) - 3 for q, lim in zip(bs[j]["at"], (vw, vh)))]
        assert seen and seen[-1][0] - seen[0][0] >= .5, f"{name}: {obj} is not held in view as a body for half a second: {[round(u, 2) for u, *_ in seen]}"
        assert size(seen[-1][1]) > 1.5 * size(seen[0][1]), f"{name}: {obj} does not grow as it is approached"
        u, bead, rush = seen[len(seen) // 2]; (x, y), r = bead["at"], bead["r"]
        assert rush < .05, f"{name}: the speed lines are on while {obj} is held ({rush:.2f} at {u:.2f}s)"
        ring = lambda k: [[x + k * r, y], [x - k * r, y], [x, y + k * r], [x, y - k * r]]
        if kind == "asteroid":
            face, sky = await look(u, [[x, y]] + ring(.45), 2), await look(u, ring(1.9), 2)
            dark = sorted(g[0] for g in sky)[1]   # the photo ahead may be behind one of the four places round it
            assert sum(g[0] > 22 for g in face) >= 4 and mean(face) > 2 * dark, f"{name}: {obj} is not a lit, solid body at {u:.2f}s: face {face}, sky round it {sky}"
        elif kind == "star":
            (core,), near, out = await look(u, [[x, y]], max(1, r / 4)), await look(u, ring(1.5), 2), await look(u, ring(7), 2)
            red, green, blue = core[2]
            assert core[0] > 170 and red > green > blue, f"{name}: {obj} is not a bright disc warmer than white at {u:.2f}s: {core}"
            assert mean(near) > 1.5 * mean(out), f"{name}: {obj} has no glow round it at {u:.2f}s: {near} against {out}"
            warmth.append(blue / red)
        else:
            (heart,), edge = await look(u, [[x, y]], 3), await look(u, ring(.92), 2)
            assert heart[1] > 150 and mean(edge) < .35 * heart[0], f"{name}: {obj}'s photo is not bright at its heart and dark at its edge at {u:.2f}s: {heart}, {edge}"
        after = [v for v, bs, _ in flight if v > seen[-1][0] and not bs[j]["front"]]
        assert after, f"{name}: {obj} is never left behind"
        passed.append(after[0]); held.append(seen[-1][0] - seen[0][0])
    assert all(a < b for a, b in zip(passed, passed[1:])), f"{name}: the bodies are passed out of distance order: {passed}"
    assert warmth[0] < warmth[1] - .02, f"{name}: the 4,850 K star should be drawn warmer than the 5,960 K one (blue over red {warmth})"
    assert max(rush for *_, rush in flight) > .8, f"{name}: the speed lines never come on"
    # the speed lines run out from the point the camera flies towards. Round a circle about it, count the places lit at
    # three steps outwards at once (a line along the radius, not a speck of the sky): many in the rush, few before the camera has moved off
    async def streaks(u):
        ed = (await probe(u))["photoEdges"]; cx, cy, rad = sum(q[0] for q in ed) / 4, sum(q[1] for q in ed) / 4, .3 * min(vw, vh); n = int(6.283 * rad)
        g = await look(u, [[cx + (rad + d) * math.cos(6.283 * i / n), cy + (rad + d) * math.sin(6.283 * i / n)] for i in range(n) for d in (0, 6, 12)], 1)
        return sum(all(g[3 * i + k][1] > 35 for k in range(3)) for i in range(n))
    rest = flight[10]; assert rest[2] < .01 and all(b["r"] < 20 for b in rest[1]), f"{name}: the flight should not have moved off by {rest[0]:.2f}s: {rest}"
    lines, still = await streaks(next(u for u, _, rush in flight if rush > .8)), await streaks(rest[0])
    assert lines > 2 * still + 20, f"{name}: no speed lines are drawn in the rush: {lines} places against {still} at rest"
    # The photo assembles from the flight, with the filter's stripes on it all the way
    lands, lit, hues = await assembly(pg, name, m, flight)
    # The colors. One star is ringed, and at each step the photo being taken moves a sixteenth of its width while the
    # star stays where it is on the photo and is seen at the next wavelength.
    said, offs = [], []
    for u in [m["STEPS"][0] - .5] + [t + .45 for t in m["STEPS"]]:
        p = await probe(u); ed = p["photoEdges"]; wd = math.dist(ed[0], ed[1])
        said.append(await pg.evaluate("[...document.querySelectorAll('#intro-labels .lbl.accent')].find(el => +el.style.opacity > .9)?.textContent"))
        offs.append(((p["frame"][0] - p["star"][0]) / wd, (p["frame"][1] - p["star"][1]) / wd))
        assert all(0 < q < lim for q, lim in zip(p["star"], (vw, vh))), f"{name}: the ringed star is off screen at {u:.1f}s"
        ring = (await look(u, [[p["star"][0] + 8.3, p["star"][1]]], 1))[0][2]   # the ring is a thin line 8 px out
        assert ring[0] > 100 and ring[0] > ring[2] + 50, f"{name}: no orange ring round the star at {u:.1f}s: {ring}"
    um = [float(t.split()[-2]) for t in said if t and t.startswith("one star")]
    assert len(um) == 4 and all(.015 < b - a < .03 for a, b in zip(um, um[1:])), f"{name}: the star's label does not step through four colors: {said}"
    steps = [math.dist(a, b) for a, b in zip(offs, offs[1:])]
    assert all(.045 < d < .07 for d in steps) and math.dist(offs[0], offs[3]) > .15, f"{name}: the photo being taken does not step a sixteenth of its width each time: {steps}"
    # one camera move, flight to ring
    worst = await one_move(pg, name, m)
    ncap, longest = await words(pg, name, m, vw)
    page_text = await (await pg.request.get(BASE + "/film")).text()
    missing = [k for k in ("Sloan Digital Sky Survey", "CC BY", "Gaia", "shapes are imagined", "compressed scale", "Blue Marble", "SkyBoT", "Horizons") if k not in page_text]
    assert not missing, f"film.html does not name {missing}"
    await pg.context.close()
    print(f"{name}: the flight closes in on the photo ({w0:.0f} to {w1:.0f} px) past five bodies in order (each held {min(held):.1f} to {max(held):.1f} s; blue over red {warmth[0]:.2f} for the cooler star, {warmth[1]:.2f} for the hotter; {lines} speed lines crossed in the rush, {still} at rest), the photo assembles from the flight (lights land at {[round(t, 1) for t in lands]} s, in order, each a new dot of brightness {lit}; then the rest; stripes violet to green by {hues}), the star is seen at {um} microns as the telescope steps, and flight to ring is one camera move (most in one frame: {worst[0]:.3f} of its distance, {worst[1]:.2f} degrees, lens {worst[2]:.3f}); {ncap} captions, each one line (longest {longest} characters) with nothing under it, no credits during the film, then the credit line and its link on the finished map; film.html names every source")

    # ---- leaving the page while the film loads: it is taken off at once and does not come back ----
    pg = await page(b, opts, errs, seen_tour=True)
    held, release = asyncio.Event(), asyncio.Event()
    async def hold(route):
        held.set(); await release.wait(); await route.continue_()
    await pg.route("**/data/intro/scene.json", hold, times=1)
    await pg.goto(BASE + "/explore"); await pg.wait_for_selector("body[data-ready='1']")
    await pg.click("#how"); await asyncio.wait_for(held.wait(), timeout=10)
    # WebGLRenderer.dispose() synchronously removes its context listener; contextlost itself arrives later.
    left = await pg.evaluate(f"""(() => {{
      const canvas = document.getElementById('intro-gl'), remove = canvas.removeEventListener;
      let disposed = false;
      canvas.removeEventListener = function(type, ...args) {{ if (type === 'webglcontextlost') disposed = true; return remove.call(this, type, ...args); }};
      dispatchEvent(new PageTransitionEvent('pagehide', {{ persisted: true }}));
      return [!!document.getElementById('intro'), !!{ON}, [...document.body.children].some(e => e.inert), disposed];
    }})()""")
    assert left == [False, False, False, True], f"{name}: pagehide did not synchronously remove the film, restore the page and dispose the renderer: {left}"
    release.set(); await pg.wait_for_timeout(1500)
    assert not await pg.evaluate("window.__intro || document.getElementById('intro')"), f"{name}: a film left while loading came back"
    async def stall2(route): await asyncio.sleep(6); await route.abort()
    await pg.route("**/data/intro/tiles.bin", stall2)
    await pg.click("#how"); await pg.wait_for_selector("#intro")
    await pg.goto(BASE + "/"); await pg.go_back(); await pg.wait_for_selector("body[data-ready='1']"); await pg.wait_for_timeout(800)
    assert not await pg.evaluate(f"document.getElementById('intro') || {ON} || [...document.body.children].some(e => e.inert)"), f"{name}: back on the page, the film is still up"
    await pg.context.close()
    print(f"{name}: leaving the page while it loads takes it off at once; back on the page it is not there")

    # ---- reduced motion: stills with Next ----
    pg = await page(b, opts, errs, reduced_motion="reduce")
    await pg.goto(BASE + "/explore"); await film_up(pg)
    assert await pg.evaluate("window.__intro.reduced") and await pg.is_visible("#intro-next")
    seen = []
    for i in range(10):
        await pg.wait_for_timeout(600); seen.append(await pg.inner_text("#intro-cap-text"))
        assert await pg.evaluate("window.__perf.frames.length") == 0, "reduced motion ran the animation"
        cred = await pg.evaluate("(() => { const el = document.getElementById('intro-credit'), cs = getComputedStyle(el), b = el.getBoundingClientRect(), c = document.getElementById('intro-cap').getBoundingClientRect(); return [cs.visibility === 'visible' && +cs.opacity === 1, el.querySelector('a').getAttribute('href'), b.left >= 0 && b.right <= innerWidth && b.bottom < c.top]; })()")
        assert cred == [i == 9, "film.html", True], f"reduced motion: the credits should be on the last still only, clear of the caption: still {i + 1}, {cred}"
        await pg.click("#intro-next")
    assert len(set(seen)) == 10, f"reduced motion: {len(set(seen))} captions, not 10"
    await gone(pg, f"{name} reduced motion"); await pg.wait_for_function(f"{TOUR} === 'Welcome to Trailblazer'", timeout=4000)
    await pg.keyboard.press("Escape"); await pg.wait_for_function(f"!{TOUR}")   # close the tour
    await pg.click("#how"); await film_up(pg); await pg.wait_for_timeout(500); await pg.click("#intro-skip"); await gone(pg, f"{name} reduced motion Skip", 1500)
    await pg.click("#how"); await film_up(pg); await pg.wait_for_timeout(500); await pg.keyboard.press("Escape"); await gone(pg, f"{name} reduced motion Escape", 1500)
    print(f"{name}: reduced motion shows 10 stills with Next and no animation, the credits and their link on the last, then the tour; Skip and Escape end it")
    await pg.context.close()
    assert not errs, f"{name}: page errors {errs}"


async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(channel="chrome", args=["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"])
        for name, opts in SIZES: await run(b, name, opts)
        for height in (1000, 1280):
            name = f"tall phone 320x{height}"
            errs = []
            pg = await page(b, dict(viewport={"width": 320, "height": height}, device_scale_factor=2, has_touch=True, is_mobile=True), errs, seen_tour=True)
            await pg.goto(BASE + "/explore?intro=rec"); await film_up(pg)
            m = await pg.evaluate("window.__intro.marks")
            flight = await flight_samples(pg, name, m); wide = await arrival(pg, name, m, 320, height); await one_move(pg, name, m)
            await assembly(pg, name, m, flight); await words(pg, name, m, 320)
            assert not errs, f"{name}: page errors {errs}"
            await pg.context.close()
            print(f"{name}: flight passes every body in order with increasing waypoints and timestamps, ends with the photo {wide:.0f} px wide inside the window, the photo assembles from the flight in order, flight to ring is one camera move, and every caption is one line")
        await b.close()
    print("intro_ui: all checks passed")

asyncio.run(main())
