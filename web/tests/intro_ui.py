"""Browser check of the 3D intro "How this map was made" on Explore (web/intro.js), in system Chrome with the GPU on,
on a desktop (1440 x 900) and as a phone (390 x 844, touch). Needs the app up (npm run dev).
First visit: the page is covered from its first paint, the film plays over it at a steady 60 frames a second, the flat
sky it ends on is drawn on the real #map oval (its edges read back from the drawn pixels, within 2 px), then the film is
gone and the "Welcome to Trailblazer" tour opens. The sky replay does not start under it. A second visit does not play
it and does not fetch intro.js, intro.css, three.js or data/intro/. Links with ?day=, ?focus=, ?q= or ?sample=, and a
browser that has seen the tour (ch.tour, which the other suites set), do not play it either.
The "How this map was made" button replays it over a panned and zoomed map on another day and lands on that same view
(edges within 2 px, the view and the day unchanged, focus back on the button). Skip and Escape end it within 4 s, and
Skip works before the film has loaded.
Reduced motion: nine stills with nine captions and a Next button, no animation, the credit line on the last.
The film's own scenes are checked from the pixels it really draws (frame by frame through ?intro=rec): the flight down the
beam passes two rocks, two stars and a galaxy as solid bodies in order of distance and ends with the whole photo in view.
The photo is not shown before the flight arrives: the shutter flashes over an empty frame, the frame stays empty through
the flight, each body's light lands on it as a dot at that body's own place, in the order the bodies are passed, and only
after arrival does the photo itself come on, whole, with its five lights, while the starry sky behind it stays as it was. Earth is one size throughout
and SPHEREx is at its true height above it, so the opening shows Earth's horizon across the view. Then the colors: the photo gives way to
the same sky in SPHEREx's six bands (real exposures: the sky itself changes), blue, then green, then red, and the
measured star is bright in the short bands and faint in the long ones. Then the galaxy's own measured light is drawn
beside it, with how far its glow has slid towards red, and its distance is lit. There is no step beat: no ringed star,
no wavelength on screen, no stripes.
The film is one camera move: in no frame of the whole film does the camera turn more than TURN degrees or change its lens
much (the turn is of the camera's whole orientation, rolls included), from the start of the flight to the ring it never jumps and nothing fades out, and as the camera passes the galaxy it
loses its light over at least several frames, never in one. Wherever Earth is drawn, the camera is outside its air with
room for the near plane (every frame, every layout), and at 6.3 to 6.7 s, the move in to the telescope's eye, no blue of
the air washes the window. Words: the nine captions are exactly Ed's, one per beat with nothing under it, on one line
on a desktop and on at most two on a phone at the same text size (the rule above them never moves); no credit or small
print shows while the film plays, and the credits come on the finished map with a link to film.html, which names every source.
The flight, its arrival, the photo's assembly, the colors and the captions are also checked at 320 x 1000 and 320 x 1280. Leaving the page while it loads (pagehide, and a
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
MOVE, TURN, ZOOM = .16, 2.5, .2   # the most the camera may do in one frame at 60 fps: move (as a share of its distance to its subject), turn (degrees, anywhere in the film), change its lens (log of the ratio)
AIR = 1.03   # Earth's air ends this many radii out (intro.js AIR): wherever Earth is drawn the camera stays outside it, with room for the near plane
FADE = .12   # the most of its own light the galaxy may lose in one frame at 60 fps (a fade over half a second loses at most about .06)
FILM_S = "window.__perf.frames.reduce((a, b) => a + b, 0) / 1000"   # seconds of film played so far
CAPS = ["This is SPHEREx, a NASA telescope circling Earth.", "It takes a picture of the sky.", "Let's follow the light into that picture.", "Some of it is close. Some is very far away.",
        "Here's the picture it took.", "It sees 102 colors. They tell how far each galaxy is.", "Picture after picture forms a ring.", "In six months it covers the whole sky.", "Lay it flat and you get this map."]   # Ed's wording, exactly


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


def grid(ed, us, vs):
    """Window places of points (u, v) of the photo's square (-1 to 1 across and down), from the middles of its four edges."""
    (rx, ry), (lx, ly), (bx, by), (tx, ty) = ed; cx, cy = (rx + lx) / 2, (ry + ly) / 2   # the edges at u = 1, u = -1, v = 1, v = -1
    return [[cx + (rx - lx) / 2 * u + (bx - tx) / 2 * v, cy + (ry - ly) / 2 * u + (by - ty) / 2 * v] for u in us for v in vs]


async def true_scale(pg, name, m, vw, vh):
    """Earth is one size from first frame to last and SPHEREx circles it at its true height (650 km over 6,371 km), so
    the opening, beside the telescope, has Earth's horizon right across the view below it (both sides of the window lit
    low down, black above), and the whole globe comes into view only because the camera draws far back."""
    probe = lambda u: pg.evaluate(f"window.__intro.probe({u})")
    seen = [(await probe(u))["earth"] for u in (.05, 2, 4.3, m["CLICK"], m["FLY0"] + 2, m["OUT"] + 4, m["RING"] + 6, m["CAPS"][8][0] - 6, 5.5, 6.5)]
    assert len({e["r"] for e in seen}) == 1, f"{name}: Earth changes size: {[e['r'] for e in seen]}"
    assert all(abs(e["alt"] - 650 / 6371) < .002 for e in seen[:5]), f"{name}: SPHEREx is not 650 km up: {[e['alt'] for e in seen]}"
    assert seen[0]["cam"] < .2 and seen[0]["craft"] < 30 and seen[2]["cam"] > 2 and seen[0]["shown"] == 1, f"{name}: the opening should start beside the telescope, just above Earth, and end far out: {seen[0]}, {seen[2]}"
    low, high = await pg.evaluate(f"window.__intro.look(.05, {[[vw * .04, vh * .7], [vw * .96, vh * .7]]}, 3)"), await pg.evaluate(f"window.__intro.look(.05, {[[vw * .04, vh * .1], [vw * .5, vh * .1], [vw * .96, vh * .1]]}, 3)")
    assert all(g[0] > 20 for g in low) and all(g[0] < 10 for g in high), f"{name}: in the opening Earth is not a horizon across the view: low {low}, high {high}"
    # the move in to the telescope's eye goes round Earth: every thirtieth of a second from 6.3 to 6.7 s, no share of the window is the air's blue (seen from inside it, it covered the window)
    pts = [[vw * (i + .5) / 12, vh * (j + .5) / 20] for i in range(12) for j in range(20)]
    for k in range(13):
        g = await pg.evaluate(f"window.__intro.look({6.3 + k / 30}, {pts}, 2)"); blue = sum(q[2][2] > 60 and q[2][2] > q[2][0] + 25 for q in g) / len(g)
        assert blue < .05, f"{name}: at {6.3 + k / 30:.2f}s {blue:.0%} of the window is the blue of Earth's air"
    return round(seen[0]["cam"], 2), round(seen[2]["cam"], 1)


async def assembly(pg, name, m, flight):
    """The photo is not shown before the flight arrives on it. The shutter flashes over an empty frame. The frame is
    empty when the flight sets off; each body's light lands at that body's place on it, in the order the bodies are
    passed and not before the body has been reached; the photo itself has not started when the last light lands, nor
    half a second before arrival; when the reveal is over the photo is whole with all five lights. Read from the pixels
    drawn: a bright point where there was none before the light set off (unless an earlier dot is a few pixels away, or
    the body itself was in front of that place), and the photo's own bright band, black before the reveal and lit after."""
    look = lambda u, pts, r=1: pg.evaluate(f"window.__intro.look({u}, {pts}, {r})")
    probe = lambda u: pg.evaluate(f"window.__intro.probe({u})")
    # the shutter: a flash over the whole frame that is gone a second and a half later, leaving it empty
    pre, at, post = await probe(m["CLICK"] - .1), await probe(m["CLICK"] + .08), await probe(m["CLICK"] + 1.6)
    mid = lambda p: grid(p["photoEdges"], (-.5, 0, .5), (-.5, 0, .5))
    b_pre, b_at, b_post = [sum(g[0] for g in await look(u, mid(p), 2)) / 9 for u, p in ((m["CLICK"] - .1, pre), (m["CLICK"] + .08, at), (m["CLICK"] + 1.6, post))]
    assert pre["flash"] == 0 and at["flash"] > .7 and b_at > 120 and b_pre < 12 and b_post < 12, f"{name}: the shutter does not flash over an empty frame: brightness {b_pre:.0f} before, {b_at:.0f} at the flash, {b_post:.0f} after"
    assert all(p["fill"] == 0 for p in (pre, at, post)), f"{name}: the photo is shown when it is taken"
    first = await probe(m["FLY0"] + 1.2)
    assert first["fill"] == 0 and all(b["landed"] == 0 for b in first["flight"]), f"{name}: the photo is not empty when the flight sets off: {first['fill']}, {[b['landed'] for b in first['flight']]}"
    lands = [b["lands"] for b in flight[0][1]]   # in order of distance
    reached = [next(u for u, bs, _ in flight if bs[j]["r"] > 12) for j in range(5)]
    assert all(a < b for a, b in zip(lands, lands[1:])), f"{name}: the lights do not land in the order of distance: {lands}"
    assert all(r < l < m["FLY1"] - .3 for r, l in zip(reached, lands)), f"{name}: a light lands before its body is reached, or too late to be seen: reached {reached}, lands {lands}"
    lit = []
    for j, t in enumerate(lands):
        before, after = await probe(t - 1.2), await probe(min(t + .4, m["SHOW"][0]))
        b0, b1 = sorted(before["flight"], key=lambda b: b["au"]), sorted(after["flight"], key=lambda b: b["au"])
        assert [b["landed"] > .99 for b in b1] == [i <= j for i in range(5)] and b0[j]["landed"] == 0, f"{name}: at {t:.1f}s the lights on the photo are {[b['landed'] for b in b1]}"
        assert after["fill"] == 0, f"{name}: the photo is shown before the flight has arrived, at {t + .4:.1f}s"
        (was,), (now,) = await look(t - 1.2, [b0[j]["land"]]), await look(min(t + .4, m["SHOW"][0]), [b1[j]["land"]])
        crowded = any(math.dist(b1[i]["land"], b1[j]["land"]) < 14 for i in range(j)) or math.dist(b0[j]["at"], b0[j]["land"]) < 8 * b0[j]["r"] + 20   # an earlier dot, or the body itself with its glow, in front of that place
        assert now[1] > 200 and (crowded or was[1] < now[1] - 60), f"{name}: no dot appears on the photo for {b1[j]['name']}: brightest {was[1]} before, {now[1]} after"
        lit.append(now[1])
    # the reveal happens at arrival and not before: every sixth of a second of the flight the photo is not shown, and its own
    # bright band (near its right edge) is black just before the reveal and lit once it is over
    n = int((m["SHOW"][0] - m["FLY0"]) * 6)
    early = await pg.evaluate(f"(() => {{ const out = []; for (let i = 0; i <= {n}; i++) out.push(window.__intro.probe({m['FLY0']} + i / 6).fill); return out; }})()")
    assert all(f == 0 for f in early) and m["FLY1"] <= m["SHOW"][0] < m["SHOW"][1] < m["FLY1"] + 3, f"{name}: the photo is shown before arrival, or not at it: reveal {m['SHOW']}, arrival {m['FLY1']}, shown {max(early)}"
    band = lambda p: grid(p["photoEdges"], (.82, .86, .9), (-.6, -.3, 0, .3, .6))
    # the whole approach, every tenth of a second from the last light's landing to arrival: the band stays black (the median of its 15 places, so a speed line crossing one of them does not count). While the galaxy
    # itself, which is flown past just then, is still ahead of the camera it can be in front of the band: those moments are checked by the photo's own "shown" value above, not by pixels
    darks, gone = [], next(u for u, bs, _ in flight if not bs[4]["front"])
    for i in range(int((m["FLY1"] - lands[4]) * 10) + 1):
        u = min(lands[4] + i / 10, m["FLY1"]); got = sorted(g[0] for g in await look(u, band(await probe(u)), 2))
        if u >= gone: darks.append(got[7])
    assert len(darks) >= 3 and m["FLY1"] - gone > .3, f"{name}: too little of the approach is clear of the galaxy to check: from {gone:.1f} to {m['FLY1']:.1f}s"
    t1 = m["SHOW"][1] + .2; end = await probe(t1); dark, bright = max(darks), sum(g[0] for g in await look(t1, band(end), 2)) / 15
    assert dark < 6 and bright > dark + 25, f"{name}: the photo's own picture should be black all through the approach and lit after the reveal: at most {dark:.1f}, then {bright:.1f}"
    # the sky behind does not change at the reveal: the same starry backdrop from the approach through the reveal and the colors (its strength, and the lit places counted all round the photo, above the captions)
    async def sky(u):
        p = await probe(u); xs, ys = [q[0] for q in p["photoEdges"]], [q[1] for q in p["photoEdges"]]; vw, vh = await pg.evaluate("[innerWidth, innerHeight]")
        pts = [[x, y] for x in range(8, vw - 8, max(6, vw // 60)) for y in range(8, int(vh * .8), max(6, vh // 60)) if not (min(xs) - 12 < x < max(xs) + 12 and min(ys) - 12 < y < max(ys) + 12)]
        got = await look(u, pts, 1); return p["sky"], sum(g[1] > 40 for g in got) / len(got)
    skies = [await sky(u) for u in (m["FLY1"] - .4, m["FLY1"] + .1, m["SHOW"][1], m["WASH"][0] + 1, m["WASH"][1] - .5)]
    assert len({a for a, _ in skies}) == 1 and skies[0][0] > .2 and all(n > .5 * skies[0][1] and n > .02 for _, n in skies), f"{name}: the sky behind the photo changes at the reveal or in the colors: {skies}"
    assert end["fill"] > .999 and all(b["landed"] > .99 for b in end["flight"]), f"{name}: after the reveal the photo is not whole with its five lights: {end['fill']}, {[b['landed'] for b in end['flight']]}"
    shown = await pg.evaluate(f"(window.__intro.render({m['SHOW'][1] + .6}), [...document.querySelectorAll('#intro-labels .lbl.land')].filter(el => +el.style.opacity > .9).map(el => el.textContent))")
    assert len(shown) == 5, f"{name}: the finished photo should carry its five labels: {shown}"
    return lands, lit, [round(dark, 1), round(bright, 1)]


async def colors(pg, name, m, vw, vh):
    """The colors. Over the finished photo the picture becomes the same sky in SPHEREx's six bands, one after another, in
    the color that stands for each (blue first, then green, then red, read from the glow of the picture's brightest star). They are
    real exposures: the sky itself changes, with far fewer places lit in the longest band than in the shortest, and
    most of those still lit were lit before (the same sky, not noise). The measured star is bright early and faint
    late as its real spectrum goes, while the galaxy holds its light better (both from SPHEREx). One label stays in the
    bands, the star's. Then color tells distance: the photo steps back, and beside the galaxy its own measured light is
    drawn as a line; a dashed copy of its bump marks where that glow sits nearby, an arrow runs from it towards red to
    where the bump is, and the label says how much redder, which is the galaxy's redshift in photo.json; then the
    galaxy's label, the only one, is lit. The drawing is inside the window, clear of the caption, and gone before and
    after. The data behind it is checked too: the top of the bump is where the redshift puts it. No wavelengths, no stripes."""
    look = lambda u, pts, r=2: pg.evaluate(f"window.__intro.look({u}, {pts}, {r})")
    probe = lambda u: pg.evaluate(f"window.__intro.probe({u})")
    w0, w1 = m["WASH"]; s0, s1 = m["SHIFT"]
    async def band(k):   # the film time at which the picture is k bands along
        lo, hi = w0, w1
        for _ in range(30):
            mid = (lo + hi) / 2
            if (await probe(mid))["wash"]["band"] < k: lo = mid
            else: hi = mid
        return hi
    t_early, t_mid, t_late = await band(.4), await band(2.5), await band(4.9)
    early, mid, late = await probe(t_early), await probe(t_mid), await probe(t_late)
    assert all(p["wash"]["a"] > .95 for p in (early, mid, late)) and (await probe(w0 - .5))["wash"]["a"] == 0, f"{name}: the bands are not fully shown, or are shown before the colors"
    # the color of each band, read where the picture is brightest (the glow of its brightest star), on a grid of places over the photo clear of the two measured lights
    us = [-.9 + 1.8 * i / 35 for i in range(36)]
    keep = [math.dist(q, early["star"]) > 40 for q in grid(early["photoEdges"], us, us)]   # the same places of the photo each time (the camera drifts a little)
    async def places(u, p): return await look(u, [q for q, k in zip(grid(p["photoEdges"], us, us), keep) if k], 2)
    seen = [await places(u, p) for u, p in ((t_early, early), (t_mid, mid), (t_late, late))]
    tints = [max(g, key=lambda q: q[0])[2] for g in seen]
    assert tints[0][2] > tints[0][0] + 15, f"{name}: the colors do not start blue: {tints[0]}"
    assert tints[1][1] > tints[1][2] + 15, f"{name}: the colors are not green or yellow half way: {tints[1]}"
    assert tints[2][0] > tints[2][1] + 15 and tints[2][0] > tints[2][2] + 15, f"{name}: the colors do not end red: {tints[2]}"
    # the sky itself changes
    a, c = [g[1] > 45 for g in seen[0]], [g[1] > 45 for g in seen[2]]
    assert sum(a) > 25 and sum(c) > 3 and sum(a) > 1.5 * sum(c), f"{name}: the sky does not change from the shortest band to the longest: {sum(a)} places lit, then {sum(c)}"
    both = sum(g[1] > 20 and y for g, y in zip(seen[0], c)); chance = sum(g[1] > 20 for g in seen[0]) / len(a)   # lit at all in the shortest band, where the longest is clearly lit; chance: how often that would happen anywhere
    assert both > .7 * sum(c) and both / sum(c) > chance + .25, f"{name}: the longest band does not show the same sky: {both} of its {sum(c)} lit places were lit in the shortest ({chance:.0%} of all places are)"
    (b0,), (b1,) = await look(t_early, [early["star"]], 3), await look(t_late, [late["star"]], 3)
    assert early["wash"]["flux"] > .8 and late["wash"]["flux"] < .2, f"{name}: the star's measured brightness: {early['wash']['flux']:.2f} early, {late['wash']['flux']:.2f} late"
    assert late["wash"]["gal"] > 1.5 * late["wash"]["flux"] and mid["wash"]["gal"] > 1.3 * mid["wash"]["flux"] and early["wash"]["gal"] < .7, f"{name}: the galaxy should hold its light where the star fades: {mid['wash']}, {late['wash']}"
    assert b0[0] > 1.6 * b1[0] and b0[0] > b1[0] + 40, f"{name}: the star does not glow in the short bands and fade in the long ones: {b0[0]:.0f}, then {b1[0]:.0f}"
    labels = lambda u: pg.evaluate(f"(window.__intro.render({u}), [...document.querySelectorAll('#intro-labels .lbl')].filter(el => +el.style.opacity > .5).map(el => el.textContent + '|' + el.className))")
    said = await labels(t_mid)
    assert len(said) == 1 and said[0].startswith("star"), f"{name}: in the bands only the star keeps its label: {said}"
    # color tells distance
    box = "(() => { const el = document.getElementById('intro-shift'), cs = getComputedStyle(el), b = el.getBoundingClientRect(), q = k => el.querySelector(k), n = (k, a) => +q(k).getAttribute(a), o = k => +getComputedStyle(q(k)).opacity, r = k => { const c = q(k).getBoundingClientRect(); return [c.left, c.right, c.top, c.bottom]; };" \
          " return { vis: cs.visibility, op: +cs.opacity, box: [b.left, b.top, b.right, b.bottom], cap: document.querySelector('#intro .cap-top').getBoundingClientRect().top, clip: n('#intro-sc rect', 'width') / 300, arrow: [n('.move line', 'x1'), n('.move line', 'x2')], rest: o('.rest'), move: o('.s-move'), said: q('.s-move').textContent, texts: ['.s-rest', '.s-here', '.s-move'].map(r), ghost: q('line.ghost').getBoundingClientRect().left }; })()"
    see = lambda u: pg.evaluate(f"(window.__intro.render({u}), {box})")
    for u in (w0 + .5, s0 - .05, s1 + .6):
        g = await see(u); assert g["vis"] == "hidden" and g["op"] == 0, f"{name}: the galaxy's light is drawn outside its moment, at {u:.1f}s: {g}"
    start, done = await see(s0 + .5), await see(m["FOUND"] + .3); p = await probe(m["FOUND"] + .3)
    assert start["op"] > .9 and start["clip"] < .5 and start["rest"] == 0 and start["move"] == 0, f"{name}: the galaxy's light should be drawn on, line first: {start}"
    assert done["vis"] == "visible" and done["op"] > .99 and done["clip"] == 1 and done["rest"] == 1 and done["move"] == 1, f"{name}: the galaxy's light is not fully drawn when its distance is lit: {done}"
    assert done["arrow"][1] > done["arrow"][0] + 20, f"{name}: the arrow does not run towards red (to the right): {done['arrow']}"
    assert done["box"][0] >= 0 and done["box"][2] <= vw and done["box"][1] >= 0 and done["box"][3] < done["cap"] - 20, f"{name}: the drawing is not inside the window, clear of the caption: {done['box']}, caption at {done['cap']}"
    assert all(0 <= t[0] and t[1] <= vw for t in done["texts"]) and done["texts"][0][1] <= done["texts"][1][0], f"{name}: the drawing's words are cut off or run into each other: {done['texts']}"
    gal = next(b for b in p["flight"] if b["kind"] == "galaxy")
    assert 0 < gal["land"][0] < vw and done["box"][3] < gal["land"][1] < done["cap"], f"{name}: the galaxy is not in view under its drawing: {gal['land']}"
    assert p["wash"]["dim"] < .6 and (await probe(w0 + 1))["wash"]["dim"] == 1 and p["wash"]["a"] == 0, f"{name}: the photo should step back, untinted, while the galaxy's light is read: {p['wash']}"
    light = await pg.evaluate("fetch('data/intro/photo.json').then(r => r.json()).then(p => p.light)")
    clean = [q for q in light["fine"] if not q[2]]; top = max(clean, key=lambda q: q[1])[0]
    assert abs(top / light["rest"] - 1 - light["z"]) < .006 and light["sigma"] > 5 and len(clean) >= 15, f"{name}: the galaxy's glow is not where its redshift puts it in the data: top {top}, rest {light['rest']}, z {light['z']}, {light['sigma']} sigma"
    assert done["said"] == f"{light['z'] * 100:.1f}% redder", f"{name}: the drawing says {done['said']!r}, the galaxy's redshift is {light['z']}"
    before, after = await labels(m["FOUND"] - .4), await labels(m["FOUND"] + .3)
    assert len(before) == 1 and before[0].startswith("galaxy") and "found" not in before[0] and len(after) == 1 and after[0].startswith("galaxy · 480 million light-years") and "found" in after[0], f"{name}: the galaxy's label should be the only one, and lit once the arrow has arrived: {before}, {after}"
    every = await pg.evaluate("[...document.querySelectorAll('#intro-labels .lbl')].map(el => el.textContent + ' ' + el.className).join(' | ') + document.getElementById('intro-shift').textContent")
    assert "STEPS" not in m and not any(k in every for k in ("micron", "stripe", "accent", "helium")), f"{name}: the step beat is still in the film: {every}"
    return [round(b0[0]), round(b1[0]), sum(a), sum(c), top]


async def words(pg, name, m, vw):
    """The nine captions are Ed's, word for word, one per beat with nothing under it, and no credit or small print is on
    screen while the film plays. On a desktop each is one line. On a phone the text keeps its size and a long caption
    wraps to a second line; the rule above the captions does not move. The credits come on the finished map, in one
    quiet line with a link to the film's own page."""
    assert not await pg.evaluate("document.getElementById('intro-cap-note')"), f"{name}: there is a note under the caption"
    assert len(m["CAPS"]) == len(CAPS), f"{name}: {len(m['CAPS'])} captions, not {len(CAPS)}"
    rules, most = set(), 0
    for (a, b), want in zip(m["CAPS"], CAPS):
        got = await pg.evaluate(f"""(() => {{ window.__intro.render({(a + b) / 2}); const el = document.getElementById('intro-cap-text'), r = document.createRange(); r.selectNodeContents(el);
          const rows = new Set([...r.getClientRects()].map(q => Math.round(q.top))), box = el.getBoundingClientRect(), cr = getComputedStyle(document.getElementById('intro-credit')), cs = getComputedStyle(el);
          return [el.textContent, rows.size, box.left, box.right, +cs.opacity, cr.visibility, +cr.opacity, [...document.getElementById('intro-cap').children].map(e => e.id || e.className), parseFloat(cs.fontSize),
            Math.round(document.querySelector('#intro .cap-top').getBoundingClientRect().bottom), box.bottom <= innerHeight, (el.style.whiteSpace = 'nowrap', el.scrollWidth <= el.clientWidth), (el.style.whiteSpace = '', 0)]; }})()""")
        said, rows, left, right, shown, vis, cred, kids, size, rule, inside, fits, _ = got   # fits: it would go on one line
        assert said == want, f"{name}: the caption at {(a + b) / 2:.1f}s is not Ed's wording: {said!r}, not {want!r}"
        assert shown > .9 and left >= 0 and right <= vw and inside and rows == (1 if fits else 2) and (fits or vw < 760), f"{name}: the caption at {(a + b) / 2:.1f}s is not on one line (two on a phone, only when it cannot fit): {got}"
        assert size == (17 if vw >= 760 else 14), f"{name}: the caption's text is {size} px: it must not shrink"
        assert vis == "hidden" and cred == 0, f"{name}: the credit line shows during the film, at {(a + b) / 2:.1f}s"
        assert kids == ["cap-top", "intro-cap-text"], f"{name}: something sits under the caption: {kids}"
        rules.add(rule); most = max(most, rows)
    assert len(rules) == 1, f"{name}: the rule above the captions moves between captions: {rules}"
    quiet = (m["CAPS"][7][1] + m["CAPS"][8][0]) / 2   # the whole sky: no caption
    assert await pg.evaluate(f"(window.__intro.render({quiet}), +getComputedStyle(document.getElementById('intro-cap-text')).opacity)") == 0 and m["CAPS"][8][0] - m["CAPS"][7][1] > 3, f"{name}: the whole sky should have no caption"
    got = await pg.evaluate(f"""(() => {{ window.__intro.render({m['CREDIT'] + .1}); const el = document.getElementById('intro-credit'), cs = getComputedStyle(el), b = el.getBoundingClientRect();
      return [el.textContent, cs.visibility, +cs.opacity, el.querySelector('a')?.getAttribute('href'), b.left, b.right, +getComputedStyle(document.getElementById('intro-cap')).opacity]; }})()""")
    assert got[1] == "visible" and got[2] > .9 and got[3] == "film.html" and got[4] >= 0 and got[5] <= vw and got[6] == 0, f"{name}: the credits are not on the finished map, alone, with their link: {got}"
    return len(m["CAPS"]), most


async def one_move(pg, name, m):
    """No hard cut. Every frame of the whole film at 60 frames a second: the camera turns (rolls included) less than TURN degrees and its lens
    changes little. From the start of the flight to the ring it also never moves more than a small share of its distance
    to what it looks at, and the picture stays fully shown (the opening's hundredfold draw-back is a steady move of its own,
    checked by true_scale). Wherever Earth is drawn, the camera is outside its air by more than the near plane's distance,
    so neither the globe nor the air is ever seen from inside or cut open, and the near plane is never more than half the camera's height above the air. (Half a second apart the same measures are far past these limits.)"""
    n = int(await pg.evaluate("window.__intro.T_END") * 60)
    cams = await pg.evaluate(f"""(() => {{ const out = [], op = id => +getComputedStyle(document.getElementById(id)).opacity;
      for (let i = 0; i <= {n}; i++) {{ const p = window.__intro.probe(i / 60), c = p.cam, e = p.earth; out.push([c.pos, c.quat, c.fov, c.dist, op('intro') * op('intro-gl'), e.cam + 1 - AIR_ - c.near / e.r, e.shown, c.near / e.r - (e.cam + 1 - AIR_) / 2]); }} return out; }})()""".replace("AIR_", str(AIR)))
    def jump(a, b):
        return (math.dist(a[0], b[0]) / min(a[3], b[3]), math.degrees(2 * math.acos(min(1, abs(sum(p * q for p, q in zip(a[1], b[1])))))), abs(math.log(a[2] / b[2])))   # the turn is of the whole orientation (the two quaternions), so a roll about the line of sight counts
    steps = [jump(a, b) for a, b in zip(cams, cams[1:])]; i0, i1 = int(m["FLY0"] * 60), int((m["RING"] + 1) * 60)
    turn, lens, move = max(range(len(steps)), key=lambda i: steps[i][1]), max(s[2] for s in steps), max(s[0] for s in steps[i0:i1])
    assert all(c[4] == 1 for c in cams[i0:i1 + 1]), f"{name}: the picture fades between the flight and the ring"
    assert steps[turn][1] < TURN and lens < ZOOM and move < MOVE, f"{name}: the camera jumps: turns {steps[turn][1]:.2f} degrees at {(turn + 1) / 60:.2f}s, lens changes {lens:.3f}, moves {move:.3f} of its distance in one frame"
    apart = [max(jump(a, b)[k] for a, b in zip(cams[i0:i1], cams[i0 + 30:i1])) for k in range(3)]
    assert apart[0] > 3 * MOVE, f"{name}: the continuity check would not see a cut: {apart}"
    shown = [(i / 60, c[5]) for i, c in enumerate(cams) if c[6] > 0]; low = min(shown, key=lambda q: q[1])
    assert low[1] > 0, f"{name}: at {low[0]:.2f}s, with Earth drawn, the camera is {low[1]:+.3f} Earth radii clear of its air and near plane; frames under: {[round(u, 2) for u, c in shown if c <= 0][:12]}"
    over = [(i / 60, c[7]) for i, c in enumerate(cams) if c[6] > 0 and c[5] > 0 and c[7] > 1e-9]
    assert not over, f"{name}: the near plane is more than half the camera's height above the air at {over[:6]}"
    return [move, steps[turn][1], lens, low[1]]


async def galaxy_goes(pg, name, m, flight):
    """As the camera passes the galaxy it does not vanish in a frame. Every frame at 60 fps from when the last of the nearer
    bodies' light has landed (it can land behind the galaxy) until the camera has passed it: the light the galaxy itself adds
    to the window (61 places spread over its middle, moving and growing with it, each less the sky's own level there; places
    off the window count as dark) never drops by more than FADE of its brightest in one frame."""
    start, end = max(b["lands"] for b in flight[0][1][:4]) + .1, next(u for u, bs, _ in flight if not bs[4]["front"]) + .1
    n = int((end - start) * 60)
    got = await pg.evaluate(f"""(() => {{ const out = [], ring = [[0, 1], [.1, 6], [.2, 12], [.3, 18], [.4, 24]].flatMap(([d, k]) => [...Array(k)].map((_, j) => [d * Math.cos(6.283 * j / k), d * Math.sin(6.283 * j / k)]));
      for (let i = 0; i <= {n}; i++) {{ const u = {start} + i / 60, g = window.__intro.probe(u).flight.find(b => b.kind === 'galaxy'), bg = [];
        const on = g.front ? ring.map(([x, y]) => [g.at[0] + x * g.r, g.at[1] + y * g.r]).filter(([x, y]) => x >= 2 && y >= 2 && x <= innerWidth - 2 && y <= innerHeight - 2) : [];
        for (let x = 8; x < innerWidth; x += 48) for (let y = 8; y < innerHeight; y += 48) if (Math.hypot(x - g.at[0], y - g.at[1]) > 1.2 * g.r) bg.push([x, y]);
        const sky = window.__intro.look(u, bg, 2).map(q => q[0]).sort((p, q) => p - q)[bg.length >> 1] ?? 0;
        out.push([u, (on.length ? window.__intro.look(u, on, 2) : []).reduce((a, q) => a + Math.max(0, q[0] - sky), 0) / ring.length]); }} return out; }})()""")
    top = max(g for _, g in got); drop = max(((a - b) / top, u) for (_, a), (u, b) in zip(got, got[1:]))
    assert top > 20 and got[-1][1] < .1 * top, f"{name}: the galaxy is not seen and then left behind: brightest {top:.0f}, last {got[-1][1]:.0f}"
    assert drop[0] < FADE, f"{name}: the galaxy loses {drop[0]:.0%} of its light in one frame at {drop[1]:.2f}s"
    return round(drop[0], 3)


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
            assert sum(g[0] > 22 for g in face) >= 4 and mean(face) > 2 * mean(sky), f"{name}: {obj} is not a lit, solid body at {u:.2f}s: face {face}, sky round it {sky}"
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
    # The photo is not shown until the flight arrives; then the colors wash over it
    scale = await true_scale(pg, name, m, vw, vh)
    lands, lit, shown = await assembly(pg, name, m, flight)
    star = await colors(pg, name, m, vw, vh)
    # one camera move, the whole film; the galaxy goes gradually
    worst = await one_move(pg, name, m); gal = await galaxy_goes(pg, name, m, flight)
    ncap, most = await words(pg, name, m, vw)
    page_text = await (await pg.request.get(BASE + "/film")).text()
    missing = [k for k in ("Sloan Digital Sky Survey", "CC BY", "Gaia", "shapes are imagined", "compressed scale", "Blue Marble", "SkyBoT", "Horizons", "102 colors", "six bands", "3.29 microns", "not at zero") if k not in page_text]
    assert not missing, f"film.html does not name {missing}"
    await pg.context.close()
    print(f"{name}: the flight closes in on the photo ({w0:.0f} to {w1:.0f} px) past five bodies in order (each held {min(held):.1f} to {max(held):.1f} s; blue over red {warmth[0]:.2f} for the cooler star, {warmth[1]:.2f} for the hotter; {lines} speed lines crossed in the rush, {still} at rest), Earth is one size throughout with SPHEREx 650 km up (the camera starts {scale[0]} Earth radii above the ground and draws back to {scale[1]}), the shutter flashes over an empty frame and the photo is not shown until arrival (lights land at {[round(t, 1) for t in lands]} s, in order, each a new dot of brightness {lit}; the photo's bright band reads at most {shown[0]} through the whole approach and {shown[1]} after, with five labels), the picture goes through six real bands, blue to red, while the measured star goes from {star[0]} to {star[1]} and the lit places of the sky from {star[2]} to {star[3]}, the galaxy's measured glow (top at {star[4]} microns) is drawn with its shift towards red and its distance lit, and nothing of the step beat is left, and the film is one camera move (most in one frame: {worst[0]:.3f} of its distance from flight to ring, {worst[1]:.2f} degrees and lens {worst[2]:.3f} anywhere; the camera stays at least {worst[3]:.3f} Earth radii clear of the air and near plane wherever Earth is drawn; the galaxy loses at most {gal:.0%} of its light in a frame); {ncap} captions in Ed's words, at most {most} line{'s' if most > 1 else ''} each at full size with nothing under them, none over the whole sky, no credits during the film, then the credit line and its link on the finished map; film.html names every source")

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
    for i in range(9):
        await pg.wait_for_timeout(600); seen.append(await pg.inner_text("#intro-cap-text"))
        assert await pg.evaluate("window.__perf.frames.length") == 0, "reduced motion ran the animation"
        cred = await pg.evaluate("(() => { const el = document.getElementById('intro-credit'), cs = getComputedStyle(el), b = el.getBoundingClientRect(), c = document.getElementById('intro-cap').getBoundingClientRect(); return [cs.visibility === 'visible' && +cs.opacity === 1, el.querySelector('a').getAttribute('href'), b.left >= 0 && b.right <= innerWidth && b.bottom < c.top]; })()")
        assert cred == [i == 8, "film.html", True], f"reduced motion: the credits should be on the last still only, clear of the caption: still {i + 1}, {cred}"
        await pg.click("#intro-next")
    assert seen == CAPS, f"reduced motion: the stills' captions are {seen}"
    await gone(pg, f"{name} reduced motion"); await pg.wait_for_function(f"{TOUR} === 'Welcome to Trailblazer'", timeout=4000)
    await pg.keyboard.press("Escape"); await pg.wait_for_function(f"!{TOUR}")   # close the tour
    await pg.click("#how"); await film_up(pg); await pg.wait_for_timeout(500); await pg.click("#intro-skip"); await gone(pg, f"{name} reduced motion Skip", 1500)
    await pg.click("#how"); await film_up(pg); await pg.wait_for_timeout(500); await pg.keyboard.press("Escape"); await gone(pg, f"{name} reduced motion Escape", 1500)
    print(f"{name}: reduced motion shows 9 stills with Next and no animation, the credits and their link on the last, then the tour; Skip and Escape end it")
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
            flight = await flight_samples(pg, name, m); wide = await arrival(pg, name, m, 320, height); worst = await one_move(pg, name, m); gal = await galaxy_goes(pg, name, m, flight)
            await true_scale(pg, name, m, 320, height); await assembly(pg, name, m, flight); await colors(pg, name, m, 320, height); await words(pg, name, m, 320)
            assert not errs, f"{name}: page errors {errs}"
            await pg.context.close()
            print(f"{name}: flight passes every body in order with increasing waypoints and timestamps, ends with the photo {wide:.0f} px wide inside the window, the photo is not shown until arrival, the colors wash over it, the film is one camera move (at most {worst[1]:.2f} degrees in a frame, at least {worst[3]:.3f} Earth radii clear of the air), the galaxy loses at most {gal:.0%} of its light in a frame, and the captions are Ed's, on one or two lines at full size")
        await b.close()
    print("intro_ui: all checks passed")

asyncio.run(main())
