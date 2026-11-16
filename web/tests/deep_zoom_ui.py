"""Explore's deep zoom (web/explore-deep.js): sharp SPHEREx sky tiles past about 2,500 px of map width.
Widths are CSS px; the deepest is 90600 / devicePixelRatio and every check prints the width it reached.
Checks (numbers from the plan's evaluator):
  3 roundness   at the deepest zoom Alkaid's halo, which the plain map shears 3.5 to 1, is at most 1.3 times as long as wide
  2 alignment   around four stars at four map widths, every tile in the window: the drawn picture is within 1 device px of
                where that tile's own picture belongs (worked out apart from the page's code), and a marker sits on the
                same place; catalogue stars within 2.5 device px, Barnard's Star within 6
  5 timing      no tile is asked for until the view has been still 120 ms; a failed tile is not asked for again within
                30 s and is then retried with no gesture; with tile replies held back, then a move and a resize, then
                released, the view does not change and only the new view's tiles are kept, and the picture matches a
                fresh load; the same with replies in reverse order; a view left and revisited needs no new requests
  6 fallback    tiles blocked, WebGL refused, the WebGL context lost: the sky picture shows, the wheel still zooms, no
                page errors; a restored context brings the tiles back
  F handoff     switching to the phone width (with replies held, in a glide) opens the phone on the same sky, as the dive's
                saved view does, and the layer follows that view with no tile of the old one; switching to the desktop
                width (with a sheet open, in a pinch) gives the whole oval with the layer off
  7 regression  the whole sky is pixel-identical to the same page with deep zoom switched off (no tile layer, the 3,200 px
                limit, no straightening, skymap.js as it was at DZ_BASE_REF), on load and after a trip to the deepest
                zoom and back; at the deepest zoom a marker keeps its size and place, a drag keeps the sky
                under the pointer under it, and so does the wheel
  8 pin         a click on a star at the deepest zoom drops the pin within 2 px of the star in the picture
Sharpness, smoothness and the data budgets (checks 1, 4, 5) are in deep_zoom_measure.py.
Run: uv run -q --with playwright --with pillow --with numpy python web/tests/deep_zoom_ui.py [base url] [check ...]   (default http://127.0.0.1:8787)"""
import asyncio, io, math, os, subprocess, sys, urllib.request
from urllib.parse import urlparse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].startswith("http") else "http://127.0.0.1:8787"
ONLY = [a for a in sys.argv[1:] if not a.startswith("http")]
REF = os.environ.get("DZ_BASE_REF", "5f72dfd")   # main just before deep zoom
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TILES = "**/data/hips/**"
ARGS = ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]
STARS = {   # RA, Dec in degrees at the SPHEREx epoch
    "Alkaid": (206.88516, 49.31327), "Denebola": (177.26491, 14.57206), "gamma Crv": (183.95154, -17.54193), "M31 core": (10.68471, 41.26875),
    "Barnard": (269.44637, 4.76777), "Orion": (83.82, -5.39),
}
INIT = """localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.maphint', '1');
window.__req = []; window.__chg = [];
{ const f = window.fetch; window.fetch = function (u, ...a) { if (String(u).includes('/hips/')) __req.push([performance.now(), String(u)]); return f.call(this, u, ...a); }; }
window.__dz = async () => { const [v, d, s, k] = await Promise.all(['view', 'deep', 'desktop'].map(n => import('/explore-' + n + '.js')).concat(import('/skymap.js'))); return { v, d, k: s, s: k }; };
window.__wide = () => !matchMedia('(max-width: 640px)').matches;"""
# put sky position (ra, dec) at window fraction (fx, fy), at map width w (clamped to the deepest)
GO = """async ([ra, dec, w, fx, fy]) => { const { v, k, s } = await __dz();
  if (__wide()) k.flyTo(ra, dec, 1);
  v.cancel(); const W = Math.min(v.MAXW, w), [u, vv] = s.fwd(ra, dec);
  v.set(W, ...v.place(u, vv, innerWidth * fx, innerHeight * fy, W));
  return { W: v.W, X: v.X, Y: v.Y, MAXW: v.MAXW, M: v.M, C: [v.A.w / 2, (v.A.t + v.A.b) / 2] }; }"""
VIEW = "__dz().then(({ v }) => ({ W: v.W, X: v.X, Y: v.Y, M: v.M }))"
STATE = "__dz().then(({ d }) => ({ ...d.state(), ...d.stats }))"
SETTLED = """async ms => { const { d } = await __dz(), t0 = performance.now();
  for (;;) { const s = d.state(), out = { ms: Math.round(performance.now() - t0), ...s, ...d.stats };
    if (s.shown && !s.pending && !s.queued && !s.ready && s.covered >= .95) return out;
    if (performance.now() - t0 > ms) return { ...out, timeout: true };
    await new Promise(r => setTimeout(r, 20)); } }"""
# the tile picture alone: grey values of a square of device pixels, centre (cx, cy), half-width r
GL = """async ([cx, cy, r]) => { const { d } = await __dz(), cv = document.querySelector('canvas.hips'), n = 2 * r + 1;
  d.redraw();
  const g = Object.assign(document.createElement('canvas'), { width: n, height: n }).getContext('2d');
  g.drawImage(cv, Math.round(cx) - r, Math.round(cy) - r, n, n, 0, 0, n, n);
  const px = g.getImageData(0, 0, n, n).data, out = []; for (let i = 0; i < px.length; i += 4) out.push(px[i]); return out; }"""
# where a marker with this RA and Dec sits (a real, empty marker in #marks), in CSS px
MARK = """async ([ra, dec]) => { const { s } = await __dz(), [u, v] = s.fwd(ra, dec), m = document.createElement('a');
  m.className = 'mk'; m.style.left = u * 100 + '%'; m.style.top = v * 100 + '%'; document.getElementById('marks').append(m);
  const r = m.getBoundingClientRect(); m.remove(); return [r.left, r.top]; }"""

fails = []
def check(ok, name, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (": " + detail if detail else ""), flush=True)
    if not ok: fails.append(name)

def centroid(px, r):
    """brightness-weighted middle of the brightest thing in a (2r+1) square, in pixels from the corner of the middle pixel"""
    n = 2 * r + 1; bg = sorted(px)[len(px) // 2]; peak = max(px); cut = (bg + peak) / 2
    sw = sx = sy = 0
    for j in range(n):
        for i in range(n):
            w = max(0, px[j * n + i] - cut); sw += w; sx += w * (i + .5 - r); sy += w * (j + .5 - r)   # + .5: a pixel's middle
    return (sx / sw, sy / sw, peak, bg) if sw else (float("nan"), float("nan"), peak, bg)

# HEALPix and Mollweide again, written apart from the page's code (numpy), to say what the tile picture must show at a window pixel
JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]; JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7]
def tile_xyf(o, k):
    npf = 4 ** o; face, ipf = divmod(k, npf); ix = iy = 0
    for bit in range(o): ix |= ((ipf >> (2 * bit)) & 1) << bit; iy |= ((ipf >> (2 * bit + 1)) & 1) << bit
    return ix, iy, face
def tile_spot_to_map(o, k, col, row):
    """a spot in tile k of order o, in texels from the picture's top-left -> map fraction (u, v)"""
    ix, iy, face = tile_xyf(o, k); x, y = (ix + row / 512) / 2 ** o, (iy + col / 512) / 2 ** o   # the picture's rows run along x, its columns along y
    jr = JRLL[face] - x - y
    if jr < 1: nr, z = jr, 1 - jr * jr / 3
    elif jr > 3: nr = 4 - jr; z = nr * nr / 3 - 1
    else: nr, z = 1, (2 - jr) * 2 / 3
    ra = math.degrees(math.pi / 4 * ((JPLL[face] * nr + x - y) % 8) / nr); lat = math.asin(z)
    lon = (-ra + 180) % 360 - 180; th = lat
    for _ in range(100):
        d = (2 * th + math.sin(2 * th) - math.pi * math.sin(lat)) / (2 + 2 * math.cos(2 * th)); th -= d
        if abs(d) < 1e-14: break
    return .5 + lon / 360 * math.cos(th), .5 - math.sin(th) / 2
def tile_at(np, tile, o, k, u, v):
    """what tile k of order o shows at map fractions (u, v) (arrays): grey values, and where the tile has any"""
    R2 = math.sqrt(2); mx = (u * 2 - 1) * 2 * R2; my = (1 - 2 * v) * R2; th = np.arcsin(np.clip(my / R2, -1, 1))
    ra = (-math.pi * mx / (2 * R2 * np.cos(th))) % (2 * math.pi); z = np.clip((2 * th + np.sin(2 * th)) / math.pi, -1, 1); za = np.abs(z); tt = (ra / (math.pi / 2)) % 4
    jp = .5 + tt - .75 * z; jm = .5 + tt + .75 * z; ifp = np.floor(jp); ifm = np.floor(jm)
    fe = np.where(ifp == ifm, ifp % 4 + 4, np.where(ifp < ifm, ifp % 4, ifm % 4 + 8)); xe = jm - ifm; ye = 1 - (jp - ifp)
    ntt = np.minimum(3, np.floor(tt)); tp = tt - ntt; tmp = np.sqrt(3 * (1 - za)); pp = tp * tmp; pm = (1 - tp) * tmp
    cap = za > 2 / 3; north = z > 0
    face = np.where(cap, np.where(north, ntt, ntt + 8), fe); x = np.where(cap, np.where(north, 1 - pm, pp), xe); y = np.where(cap, np.where(north, 1 - pp, pm), ye)
    ix, iy, f = tile_xyf(o, k); row = (x * 2 ** o - ix) * 512 - .5; col = (y * 2 ** o - iy) * 512 - .5
    ok = (face == f) & (row > 0) & (row < 511) & (col > 0) & (col < 511)
    r0 = np.clip(np.floor(row), 0, 510).astype(int); c0 = np.clip(np.floor(col), 0, 510).astype(int); fr = np.clip(row - r0, 0, 1); fc = np.clip(col - c0, 0, 1)
    val = tile[r0, c0] * (1 - fr) * (1 - fc) + tile[r0, c0 + 1] * (1 - fr) * fc + tile[r0 + 1, c0] * fr * (1 - fc) + tile[r0 + 1, c0 + 1] * fr * fc
    return val, ok

async def launch(p): return await p.chromium.launch(channel="chrome", headless=True, args=ARGS)
async def open_page(b, w=1440, h=900, dpr=2, phone=False, less_motion=True, path="/explore?day=529", before=None):
    cx = await b.new_context(viewport=dict(width=w, height=h), device_scale_factor=dpr, is_mobile=phone, has_touch=phone, reduced_motion="reduce" if less_motion else "no-preference")
    await cx.add_init_script(INIT)
    pg = await cx.new_page(); pg.errs = []
    pg.on("pageerror", lambda e: pg.errs.append(str(e)))
    if before: await before(pg)
    await pg.goto(BASE + path); await pg.wait_for_function("document.body.dataset.ready === '1'"); await pg.wait_for_timeout(1300)   # the map's scale-in
    return pg
async def go(pg, star, w=1e9, fx=.5, fy=.5):
    ra, dec = STARS[star] if isinstance(star, str) else star
    return await pg.evaluate(GO, [ra, dec, w, fx, fy])
async def settled(pg, ms=20000): return await pg.evaluate(SETTLED, ms)
async def crop(pg, r=200):   # the middle of the tile picture
    d = await pg.evaluate("devicePixelRatio"); vp = pg.viewport_size
    return await pg.evaluate(GL, [vp["width"] * d / 2, vp["height"] * d / 2, r])
def differ(a, b): return sum(abs(x - y) for x, y in zip(a, b)) / len(a)

# ---------- 2: alignment ----------
# For each tile in a view: 33 x 33 device px squares of the drawn picture (the tile's middle and four more) are set against what the
# tile's own picture must show there, worked out with the maths above from the view the engine reports. The shift between
# the two that fits best (searched to a quarter pixel) is the misalignment. A marker placed at the same map position must
# sit on the engine's place for it, so the markers and the picture agree. Single stars cannot say this to a pixel: SPHEREx
# pixels are as big as its stars, so catalogue stars are checked more loosely.
HIPS = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
MARK_UV = """([u, v]) => { const m = document.createElement('a'); m.className = 'mk'; m.style.left = u * 100 + '%'; m.style.top = v * 100 + '%';
  document.getElementById('marks').append(m); const r = m.getBoundingClientRect(); m.remove(); return [r.left, r.top]; }"""
def to_layout(view, x, y):   # undo the engine's straightening: window point -> layout point
    (a, b, c, d), (cx, cy) = view["M"], view["C"]; det = a * d - b * c; x = x - cx; y = y - cy
    return cx + (d * x - b * y) / det, cy + (a * y - c * x) / det
def to_window(view, x, y):
    (a, b, c, d), (cx, cy) = view["M"], view["C"]; x -= cx; y -= cy
    return cx + a * x + b * y, cy + c * x + d * y
_tiles = {}
async def tile_picture(pg, o, k):
    if (o, k) not in _tiles:
        import numpy as np; from PIL import Image
        _tiles[(o, k)] = np.asarray(Image.open(io.BytesIO(await (await pg.context.request.get(f"{HIPS}/Norder{o}/Dir{k // 10000 * 10000}/Npix{k}.png")).body())).convert("L"), dtype=float)
    return _tiles[(o, k)]
async def misfit(pg, o, k, view, dpr, cx, cy, r=16):
    """shift, in device px, between the drawn picture around device pixel (cx, cy) and tile o/k's own picture there; None if too plain to tell"""
    import numpy as np
    got = np.array(await pg.evaluate(GL, [cx, cy, r]), dtype=float).reshape(2 * r + 1, 2 * r + 1); tile = await tile_picture(pg, o, k)
    ys, xs = np.mgrid[-r:r + 1, -r:r + 1]; xs = xs + cx + .5; ys = ys + cy + .5   # pixel middles
    def score(dx, dy):
        lx, ly = to_layout(view, (xs + dx) / dpr, (ys + dy) / dpr)
        val, ok = tile_at(np, tile, o, k, (lx - view["X"]) / view["W"], (ly - view["Y"]) / (view["W"] / 2))
        if ok.sum() < ok.size * .6 or val[ok].std() < 12: return None
        a = got[ok] - got[ok].mean(); e = val[ok] - val[ok].mean(); return float((a * e).sum() / (math.sqrt((a * a).sum() * (e * e).sum()) + 1e-9))
    if score(0, 0) is None: return None
    best = max(((score(dx, dy) or -1), dx, dy) for dx in range(-3, 4) for dy in range(-3, 4))
    fine = [((score(best[1] + i / 4, best[2] + j / 4) or -1), best[1] + i / 4, best[2] + j / 4) for i in range(-4, 5) for j in range(-4, 5)]
    top = max(fine)[0]   # a blurred or sheared patch fits almost as well over a range of shifts: take the smallest that fits as well as the best
    return (min(math.hypot(dx, dy) for sc, dx, dy in fine if sc >= top - .02), top) if top > .5 else None
async def alignment(b):
    for dpr in (1, 2):
        pg = await open_page(b, dpr=dpr); rows = []; cat = []; anchor = 0
        for star in ("Alkaid", "Denebola", "gamma Crv", "M31 core"):
            for w in (5000, 12000, 30000, 90600):
                v = await go(pg, star, w / dpr); s = await settled(pg); vp = pg.viewport_size
                for o, k in [map(int, t.split("/")) for t in s["wantIds"]]:
                  for col, row in ((256, 256), (128, 128), (384, 128), (128, 384), (384, 384)):
                    u, vv = tile_spot_to_map(o, k, col, row); mx, my = await pg.evaluate(MARK_UV, [u, vv])
                    if not (20 < mx < vp["width"] - 20 and 20 < my < vp["height"] - 20): continue
                    ex, ey = to_window(v, v["X"] + u * v["W"], v["Y"] + vv * v["W"] / 2); anchor = max(anchor, math.hypot(mx - ex, my - ey) * dpr)
                    m = await misfit(pg, o, k, v, dpr, round(mx * dpr), round(my * dpr))
                    if m: rows.append((m[0], star, round(v["W"]), f"{o}/{k}", round(mx / vp["width"], 2), round(my / vp["height"], 2), round(m[1], 2)))
                mx, my = await pg.evaluate(MARK, list(STARS[star])); r = 8
                cx, cy, *_ = centroid(await pg.evaluate(GL, [mx * dpr, my * dpr, r]), r); cat.append((math.hypot(cx + round(mx * dpr) - mx * dpr, cy + round(my * dpr) - my * dpr), star, round(v["W"])))
        bad = [r for r in rows if not r[0] <= 1]; worst = max(rows)
        spread = (min(r[4] for r in rows), max(r[4] for r in rows), min(r[5] for r in rows), max(r[5] for r in rows))
        check(len(rows) > 60 and not bad and anchor <= .1, f"alignment at DPR {dpr}", f"{len(rows)} tile squares at widths {sorted({r[2] for r in rows})} CSS px, from {spread[0]:.0%} to {spread[1]:.0%} across and {spread[2]:.0%} to {spread[3]:.0%} down the window: worst shift {worst[0]:.2f} device px ({worst[1:]}), "
              f"{sum(r[0] == 0 for r in rows)} with none; markers within {anchor:.3f} device px of the engine's places" + (f"; {len(bad)} over 1 px: {bad[:6]}" if bad else ""))
        check(max(cat)[0] <= 2.5, f"catalogue stars at DPR {dpr}", f"Alkaid, Denebola, gamma Crv and the M31 core sit within {max(cat)[0]:.2f} device px of their catalogue places (worst {max(cat)[1:]}; 2.5 allowed, the data's own limit)")
        v = await go(pg, "Alkaid"); await settled(pg); mx, my = await pg.evaluate(MARK, list(STARS["Alkaid"])); r = 40
        px = await pg.evaluate(GL, [mx * dpr, my * dpr, r]); n = 2 * r + 1; cut = (sorted(px)[len(px) // 5] + max(px)) / 2
        pts = [(i - r, j - r) for j in range(n) for i in range(n) if px[j * n + i] > cut]; ax = sum(p[0] for p in pts) / len(pts); ay = sum(p[1] for p in pts) / len(pts)
        sxx = sum((p[0] - ax) ** 2 for p in pts); syy = sum((p[1] - ay) ** 2 for p in pts); sxy = sum((p[0] - ax) * (p[1] - ay) for p in pts); h = math.hypot((sxx - syy) / 2, sxy)
        ratio = math.sqrt(((sxx + syy) / 2 + h) / ((sxx + syy) / 2 - h))
        check(ratio <= 1.3 and v["M"] != [1, 0, 0, 1], f"round stars at DPR {dpr}", f"Alkaid's halo at {round(v['W'])} CSS px is {ratio:.2f} times as long as wide (1.3 allowed; the plain map shows it 3.5 times)")
        v = await go(pg, "Barnard"); await settled(pg); mx, my = await pg.evaluate(MARK, list(STARS["Barnard"]))
        cx, cy, *_ = centroid(await pg.evaluate(GL, [mx * dpr, my * dpr, 12]), 12)
        check(math.hypot(cx, cy) <= 6, f"Barnard's Star at DPR {dpr}", f"{math.hypot(cx, cy):.2f} device px from its 2025.7 place at {round(v['W'])} CSS px")
        check(not pg.errs, f"no page errors (alignment, DPR {dpr})", str(pg.errs[:3])); await pg.context.close()

# ---------- 5: timing ----------
async def still_rule(b):
    pg = await open_page(b, less_motion=False)
    await pg.evaluate("__dz().then(({ v }) => v.onView(() => __chg.push(performance.now())))")
    await go(pg, "Barnard", 4000); await pg.mouse.move(700, 450)
    for i in range(60): await pg.mouse.wheel(0, -40); await pg.wait_for_timeout(40 if i % 15 else 260)   # zoom in, with four short rests
    await pg.mouse.down()
    for i in range(60): await pg.mouse.move(700 - i * 6, 450 + i * 3); await pg.wait_for_timeout(30 if i % 20 else 300)   # drag, with rests
    await pg.mouse.up(); await settled(pg)
    req, chg = await pg.evaluate("[__req.map(r => r[0]), __chg]")
    gaps = [t - max([c for c in chg if c <= t], default=-1e9) for t in req]
    check(req and min(gaps) >= 115, "still rule", f"{len(req)} tile requests over {len(chg)} view changes; the shortest wait after a view change was {min(gaps, default=0):.0f} ms (120 ms rule)")
    check(not pg.errs, "no page errors (still rule)", str(pg.errs[:3])); await pg.context.close()

async def backoff(b):   # counted from the layer's own tally: the dive (explore-dive.js) asks IRSA for tiles of its own at the deepest zoom
    block = True
    async def gate(route): await (route.abort() if block else route.continue_())
    pg = await open_page(b, before=lambda p: p.route(TILES, gate))
    v = await go(pg, "Barnard"); t0 = asyncio.get_event_loop().time(); await pg.wait_for_timeout(1500); first = await pg.evaluate(STATE)
    for i in range(6): await pg.evaluate("([x, y, w]) => __dz().then(({ v }) => v.set(w, x, y))", [v["X"] + (i % 2), v["Y"], v["W"]]); await pg.wait_for_timeout(700)
    s = await pg.evaluate(STATE)
    check(first["failed"] > 0 and first["failed"] == first["requested"] and s["requested"] == first["requested"] and s["cached"] == 0, "failed tiles wait", f"{first['failed']} tiles failed; after 6 more settles in {asyncio.get_event_loop().time() - t0:.0f} s the layer had asked for {s['requested'] - first['requested']} more")
    block = False; s = await settled(pg, 40000); dt = asyncio.get_event_loop().time() - t0
    check(not s.get("timeout") and dt >= 29 and s["requested"] == 2 * first["requested"], "failed tiles retry by themselves", f"with no gesture the {first['failed']} tiles were asked for once more after {dt:.1f} s and the view filled ({s['covered']:.0%})")
    check(not pg.errs, "no page errors (failed tiles)", str(pg.errs[:3])); await pg.context.close()

async def reference(b, w, h, view):   # the tile picture of a view, loaded fresh
    pg = await open_page(b, w, h)
    await go(pg, "Barnard", 3000); await pg.evaluate("([x, y, w]) => __dz().then(({ v }) => v.set(w, x, y))", [view["X"], view["Y"], view["W"]])
    await settled(pg); px = await crop(pg); ids = (await pg.evaluate(STATE))["tiles"]; await pg.context.close(); return px, set(ids)

async def deadline(b):
    for body in (False, True):
        async def stall(pg):
            await pg.add_init_script("""{
              const realFetch = window.fetch; window.__stallTiles = true;
              window.fetch = (url, opts) => {
                if (!__stallTiles || !String(url).includes('/hips/')) return realFetch(url, opts);
                const wait = () => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
                return BODY ? Promise.resolve({ ok: true, blob: wait }) : wait();
              };
            }""".replace("BODY", str(body).lower()))
        pg = await open_page(b, before=stall)
        await go(pg, "Barnard"); await pg.wait_for_timeout(500)
        await go(pg, "Orion"); await pg.wait_for_timeout(500)
        check((await pg.evaluate(STATE))["failed"] == 0, "moving aborts quietly", f"body={body}")
        for _ in range(40):   # wait_for_function does not await a Promise, so poll: the 15 s deadline has to fire first
            s = await pg.evaluate(STATE)
            if s["failed"] > 0 and not s.get("pending") and not s.get("queued"): break
            await pg.wait_for_timeout(500)
        check(s["failed"] > 0, "stalled requests release pending slots", f"body={body}, failed={s['failed']}")
        await pg.evaluate("window.__stallTiles = false")
        s = await settled(pg, 40000)
        check(not s.get("timeout") and s["covered"] >= .95, "timed out tiles retry without a gesture", f"body={body}")
        await pg.context.close()

async def late_replies(b):
    held = []; hold = True
    async def gate(route):
        if hold: held.append(route)
        else: await route.continue_()
    pg = await open_page(b, before=lambda p: p.route(TILES, gate))
    await go(pg, "Barnard"); await pg.wait_for_timeout(500); a_ids = set((await pg.evaluate(STATE))["wantIds"]); n_a = len(held)
    await go(pg, "Orion"); await pg.set_viewport_size(dict(width=1200, height=800)); await pg.wait_for_timeout(500)
    v1 = await pg.evaluate(VIEW); hold = False
    for r in held: await r.continue_()
    s = await settled(pg); v2 = await pg.evaluate(VIEW); px = await crop(pg)
    ref, ref_ids = await reference(b, 1200, 800, v1); kept = set(s["tiles"])
    check(n_a > 0 and v1 == v2 and not (kept & a_ids) and kept <= set(s["wantIds"]) and differ(px, ref) < 1.5, "late replies",
          f"{n_a} replies held, then a move and a resize: view unchanged, {len(kept & a_ids)} tiles of the old view kept, {len(kept)} tiles all wanted by the new view, picture differs from a fresh load by {differ(px, ref):.2f} of 255")
    # replies in reverse order
    held.clear(); hold = True; await go(pg, "Alkaid"); va = await pg.evaluate(VIEW)
    for _ in range(400):
        if held: await held.pop().continue_()
        await pg.wait_for_timeout(25)
        st = await pg.evaluate(STATE)
        if not held and not st["pending"] and not st["queued"] and not st["ready"] and st["covered"] >= .95: break
    px = await crop(pg); ref, _ = await reference(b, 1200, 800, va)
    check(differ(px, ref) < 1.5 and await pg.evaluate(VIEW) == va, "replies in reverse order", f"picture differs from a fresh load by {differ(px, ref):.2f} of 255")
    # leave and come back
    hold = False; n0 = (await pg.evaluate(STATE))["requested"]
    await go(pg, "Orion"); await settled(pg); n1 = (await pg.evaluate(STATE))["requested"]
    await pg.evaluate("([x, y, w]) => __dz().then(({ v }) => v.set(w, x, y))", [va["X"], va["Y"], va["W"]]); s = await settled(pg)
    check(n1 == n0 and s["requested"] == n1 and s["ms"] < 400 and differ(await crop(pg), ref) < 1.5, "leave and revisit", f"both views came back from memory: {s['requested'] - n0} new requests, filled in {s['ms']} ms")
    check(not pg.errs, "no page errors (late replies)", str(pg.errs[:3])); await pg.context.close()

# ---------- 6: fallback ----------
SKY_OK = "(() => { const i = document.querySelector('img.sky'); return i.complete && i.naturalWidth > 0 && getComputedStyle(i).opacity === '1'; })()"
async def wheel_zooms(pg):
    w0 = (await pg.evaluate(VIEW))["W"]; await pg.mouse.move(700, 450); await pg.mouse.wheel(0, 200); await pg.wait_for_timeout(100)
    return (await pg.evaluate(VIEW))["W"] < w0
async def fallback(b):
    pg = await open_page(b, before=lambda p: p.route(TILES, lambda r: r.abort()))
    v = await go(pg, "Barnard"); await pg.wait_for_timeout(1200); s = await pg.evaluate(STATE)
    check(s["cached"] == 0 and s["failed"] > 0 and await pg.evaluate(SKY_OK) and await wheel_zooms(pg) and not pg.errs, "tiles blocked",
          f"at {round(v['W'])} CSS px {s['failed']} tiles failed, the sky picture shows, the wheel zooms, page errors: {pg.errs[:2]}")
    await pg.context.close()
    async def no_gl(p): await p.add_init_script("{ const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/.test(t) ? null : g.call(this, t, ...a); }; }")
    pg = await open_page(b, before=no_gl)
    v = await go(pg, "Barnard"); await pg.wait_for_timeout(600); s = await pg.evaluate(STATE)
    check(s["dead"] and not await pg.query_selector("canvas.hips") and s["requested"] == 0 and await pg.evaluate(SKY_OK) and await wheel_zooms(pg) and not pg.errs, "WebGL refused",
          f"at {round(v['W'])} CSS px no canvas and no requests, the sky picture shows, the wheel zooms, page errors: {pg.errs[:2]}")
    await pg.context.close()
    pg = await open_page(b); v = await go(pg, "Barnard"); await settled(pg)
    await pg.evaluate("window.__lose = document.querySelector('canvas.hips').getContext('webgl').getExtension('WEBGL_lose_context'); __lose.loseContext()"); await pg.wait_for_timeout(400)
    s = await pg.evaluate(STATE); hidden = await pg.evaluate("getComputedStyle(document.querySelector('canvas.hips')).display === 'none'")
    ok = s["lost"] and hidden and s["cached"] == 0 and await pg.evaluate(SKY_OK) and await wheel_zooms(pg)
    await go(pg, "Barnard"); await pg.evaluate("__lose.restoreContext()"); s2 = await settled(pg)
    check(ok and not s2.get("timeout") and not s2["lost"] and not pg.errs, "context lost and restored", f"lost: canvas hidden, sky picture shows, the wheel zooms; restored: {s2['covered']:.0%} covered again; page errors: {pg.errs[:2]}")
    await pg.context.close()

# ---------- F: the switch between the desktop and phone layouts ----------
OVAL = "(() => { const r = document.querySelector('.map-wrap').getBoundingClientRect(); return [r.left, r.top, r.width]; })()"
HIDDEN = "__dz().then(({ d }) => { const s = d.state(), c = document.querySelector('canvas.hips'); return !s.shown && !s.pending && !s.queued && !s.ready && (!c || getComputedStyle(c).display === 'none'); })"
# the layer follows the view the engine published: on when that view is deep, off when it is not, and no tile on its way or shown that the view does not want
FOLLOWS = """__dz().then(({ d, v }) => { const s = d.state(), c = document.querySelector('canvas.hips'), deep = v.W >= 2500 && s.order >= 1, want = new Set(s.wantIds);
  return { ok: s.shown === deep && (!c || (getComputedStyle(c).display !== 'none') === deep) && (deep || (!s.pending && !s.queued && !s.ready)), W: Math.round(v.W), shown: s.shown, straight: v.straight(),
    css: document.querySelector('.map-wrap').classList.contains('straight') }; })"""
async def handoff(b):
    held = []
    pg = await open_page(b, less_motion=False, path="/explore?day=529", before=lambda p: p.route(TILES, lambda r: held.append(r)))
    oval0 = await pg.evaluate(OVAL)
    await go(pg, "Barnard"); await pg.wait_for_timeout(400); n = len(held); old = set((await pg.evaluate(STATE))["wantIds"])
    await pg.set_viewport_size(dict(width=390, height=844)); await pg.wait_for_timeout(300); f1 = await pg.evaluate(FOLLOWS)
    for r in held:
        try: await r.continue_()
        except Exception: pass   # aborted by the page
    await pg.unroute(TILES); await pg.wait_for_timeout(300); s = await settled(pg) if f1["shown"] else await pg.evaluate(STATE); f2 = await pg.evaluate(FOLLOWS)
    stale = set(s["tiles"]) - set(s["wantIds"]) if f1["shown"] else set(s["tiles"])
    await pg.set_viewport_size(dict(width=1440, height=900)); await pg.wait_for_timeout(400); oval1 = await pg.evaluate(OVAL)
    check(n > 0 and f1["ok"] and f2["ok"] and f1["straight"] == f1["css"] and not stale and all(abs(a - c) < .5 for a, c in zip(oval0, oval1)) and await pg.evaluate(HIDDEN), "handoff with replies held",
          f"{n} replies held at the deepest zoom, then phone width: the phone opens on the same sky at {f1['W']} px and the layer follows it ({'on' if f1['shown'] else 'off'}); after release {len(stale)} tiles of the old view are kept; back on desktop the whole oval is where it was and the layer is off")
    await go(pg, "Barnard", 20000); await settled(pg); await pg.click("#zoom-in"); await pg.wait_for_timeout(80)   # in a glide
    await pg.set_viewport_size(dict(width=390, height=844)); await pg.wait_for_timeout(500); f = await pg.evaluate(FOLLOWS); w1 = f["W"]; await pg.wait_for_timeout(400); w2 = (await pg.evaluate(FOLLOWS))["W"]
    check(f["ok"] and w1 == w2 and f["straight"] == f["css"], "handoff in a glide", f"phone layout at {w1} px, the glide has stopped, the layer follows the view ({'on' if f['shown'] else 'off'})")
    check(not pg.errs, "no page errors (handoff, desktop first)", str(pg.errs[:3])); await pg.context.close()
    # phone first: a comet sheet open, then a pinch in progress
    pg = await open_page(b, 390, 844, 3, phone=True, less_motion=False)
    await pg.evaluate("document.querySelector('#marks .mk.sel').click()"); await pg.wait_for_timeout(500); sheet = await pg.evaluate("!document.getElementById('csheet').hidden")
    await go(pg, "Barnard"); s = await settled(pg)
    await pg.set_viewport_size(dict(width=1000, height=800)); await pg.wait_for_timeout(500)
    check(sheet and not s.get("timeout") and await pg.evaluate(HIDDEN) and not await pg.evaluate("document.querySelector('.map-wrap').classList.contains('straight')") and await pg.evaluate("document.getElementById('csheet').hidden"), "handoff with a sheet open", "deepest zoom on the phone with the comet sheet open, then desktop width: the whole oval, layer off, map not straightened, sheet closed")
    await pg.set_viewport_size(dict(width=390, height=844)); await pg.wait_for_timeout(500); await go(pg, "Barnard", 20000); await settled(pg)
    cdp = await pg.context.new_cdp_session(pg); pts = lambda d: [dict(x=195 - d, y=400, id=0), dict(x=195 + d, y=400, id=1)]
    await cdp.send("Input.dispatchTouchEvent", dict(type="touchStart", touchPoints=pts(40)))
    for d in (50, 60, 70): await cdp.send("Input.dispatchTouchEvent", dict(type="touchMove", touchPoints=pts(d))); await pg.wait_for_timeout(30)
    w_pinch = (await pg.evaluate(VIEW))["W"]
    await pg.set_viewport_size(dict(width=1000, height=800)); await pg.wait_for_timeout(300)
    await cdp.send("Input.dispatchTouchEvent", dict(type="touchMove", touchPoints=pts(90))); await cdp.send("Input.dispatchTouchEvent", dict(type="touchEnd", touchPoints=[])); await pg.wait_for_timeout(400)
    check(w_pinch > 6667 and await pg.evaluate(HIDDEN), "handoff in a pinch", f"a pinch had zoomed to {round(w_pinch)} px; desktop width mid-pinch: layer hidden and it stays hidden when the fingers move on")
    check(not pg.errs, "no page errors (handoff, phone first)", str(pg.errs[:3])); await pg.context.close()

# ---------- 7: regression ----------
async def without_deep_zoom(route):   # the page as it is now with deep zoom switched off: no tile layer, the old zoom limit, no straightening, the old skymap.js
    name = urlparse(route.request.url).path.lstrip("/")
    if name == "explore-deep.js": return await route.fulfill(body="", content_type="text/javascript")
    if name == "skymap.js": return await route.fulfill(body=subprocess.run(["git", "-C", REPO, "show", f"{REF}:web/skymap.js"], capture_output=True, check=True).stdout, content_type="text/javascript")
    if name != "explore-view.js": return await route.continue_()
    src = open(os.path.join(REPO, "web", name)).read(); cut = [("export const MAXW = Math.round(90600 / devicePixelRatio);", "export const MAXW = 3200;"), ("const fade = w => {", "const fade = w => 0; const fadeOff = w => {")]
    for old, new in cut:
        assert src.count(old) == 1, f"explore-view.js changed: {old}"
        src = src.replace(old, new)
    await route.fulfill(body=src, content_type="text/javascript")
async def shot(pg): return await pg.screenshot(animations="disabled", caret="hide")
def same(a, b):
    if a == b: return 0, None
    from PIL import Image, ImageChops
    d = ImageChops.difference(Image.open(io.BytesIO(a)).convert("RGB"), Image.open(io.BytesIO(b)).convert("RGB")).convert("L")
    return sum(d.histogram()[1:]), d.getbbox()
SEED = "{ let s = 42; Math.random = () => (s = s * 16807 % 2147483647) / 2147483647; }"   # the page's background stars
async def regression(b):
    probe = await b.new_context(); api = {u: await (await probe.request.get(BASE + u)).body() for u in ("/api/explored", "/api/comets")}; await probe.close()   # the unexplored suggestion is random: both pages get the same one
    async def fixed(pg, old):
        await pg.add_init_script(SEED)
        if old: await pg.route("**/explore*", without_deep_zoom); await pg.route("**/skymap.js", without_deep_zoom)
        for u, body in api.items(): await pg.route("**" + u, lambda r, _q=None, body=body: r.fulfill(body=body, content_type="application/json"))
    for name, w, h, dpr, phone, whole in (("desktop", 1440, 900, 2, False, "#zoom-whole"), ("phone", 390, 844, 3, True, "#whole")):
        new = await open_page(b, w, h, dpr, phone, before=lambda p: fixed(p, False)); old = await open_page(b, w, h, dpr, phone, before=lambda p: fixed(p, True))
        await new.wait_for_timeout(1500); d0, box0 = same(await shot(new), await shot(old))
        for pg in (new, old):
            await pg.mouse.move(w / 2, h / 2); await pg.mouse.wheel(0, -500); await pg.wait_for_timeout(200)
        v = await go(new, "Barnard"); s = await settled(new)
        for pg in (new, old):
            await pg.click(whole); await pg.mouse.move(w / 2, h / 2); await pg.wait_for_timeout(900)
        d1, box1 = same(await shot(new), await shot(old)); canvas = await new.evaluate(HIDDEN)
        check(d0 == 0 and d1 == 0 and canvas and not s.get("timeout") and s["cached"] > 0, f"whole sky as before ({name})",
              f"against the page with deep zoom off: {d0} pixels differ on load, {d1} after a trip to {round(v['W'])} CSS px ({s['cached']} tiles loaded) and back" + (f"; where: {box0} {box1}" if d0 or d1 else ""))
        check(not new.errs, f"no page errors (regression, {name})", str(new.errs[:3])); await new.context.close(); await old.context.close()

DOT = """() => { const m = document.querySelector('#marks .mk.sel'), r = m.querySelector('i').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, u: parseFloat(m.style.left) / 100, v: parseFloat(m.style.top) / 100 }; }"""
async def overlays(b):
    pg = await open_page(b); d0 = await pg.evaluate(DOT)
    await go(pg, "Barnard", 3000)
    v = await pg.evaluate("([u, vv]) => __dz().then(({ v }) => { v.set(v.MAXW, ...v.place(u, vv, 700, 500, v.MAXW)); return { W: v.W }; })", [d0["u"], d0["v"]])
    d1 = await pg.evaluate(DOT)
    await pg.emulate_media(reduced_motion="no-preference")
    check(await pg.evaluate("document.querySelector('.map-wrap').classList.contains('straight') && getComputedStyle(document.querySelector('.map-wrap')).transitionDuration === '0s'"), "straightening has no transition")
    check(abs(d1["x"] - 700) <= 1 and abs(d1["y"] - 500) <= 1 and abs(d1["w"] - d0["w"]) < .01, "marker at the deepest zoom", f"at {round(v['W'])} CSS px the featured comet's dot is {abs(d1['x'] - 700):.2f}, {abs(d1['y'] - 500):.2f} px from its place and still {d1['w']:.0f} px wide")
    held = await pg.evaluate("__dz().then(({ v }) => v.skyAt(400, 300))")
    await pg.mouse.move(400, 300); await pg.mouse.down(); await pg.mouse.move(340, 270, steps=4); await pg.mouse.move(280, 240, steps=4); await pg.mouse.up()
    at = await pg.evaluate("s => __dz().then(({ v }) => v.toScreen(...s))", held); d2 = await pg.evaluate(DOT)
    check(abs(at[0] - 280) <= 1 and abs(at[1] - 240) <= 1 and abs(d2["x"] - d1["x"] + 120) <= 3 and abs(d2["y"] - d1["y"] + 60) <= 3, "drag at the deepest zoom",
          f"after a drag of (-120, -60) the sky that was under the pointer is {abs(at[0] - 280):.2f}, {abs(at[1] - 240):.2f} px from it; the comet's dot, 360 px away, moved ({d2['x'] - d1['x']:.1f}, {d2['y'] - d1['y']:.1f}) (north stays up, so the view turns a little)")
    sky = await pg.evaluate("__dz().then(({ v }) => v.skyAt(900, 600))"); await pg.mouse.move(900, 600); await pg.mouse.wheel(0, 300); await pg.wait_for_timeout(100)
    at, w = await pg.evaluate("s => __dz().then(({ v }) => [v.toScreen(...s), v.W])", sky)
    check(abs(at[0] - 900) <= 1 and abs(at[1] - 600) <= 1 and w < v["W"], "wheel at the deepest zoom", f"zoomed out to {round(w)} px; the sky under the pointer moved {abs(at[0] - 900):.2f}, {abs(at[1] - 600):.2f} px")
    check(not pg.errs, "no page errors (overlays)", str(pg.errs[:3])); await pg.context.close()

# ---------- 8: the pin ----------
async def pin(b):
    pg = await open_page(b); dpr = 2; worst = 0; rows = []
    for star, fx, fy in (("Alkaid", .5, .5), ("Denebola", .3, .4), ("gamma Crv", .65, .35), ("M31 core", .4, .6)):
        v = await go(pg, star, 1e9, fx, fy); await settled(pg)
        mx, my = await pg.evaluate(MARK, list(STARS[star]))
        cx, cy, *_ = centroid(await pg.evaluate(GL, [mx * dpr, my * dpr, 10]), 10)
        sx, sy = (round(mx * dpr) + cx) / dpr, (round(my * dpr) + cy) / dpr   # the star in the picture, CSS px
        await pg.mouse.click(sx, sy); await pg.wait_for_timeout(700)
        px, py = await pg.evaluate("(() => { const r = document.querySelector('.pin-ring').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
        off = ((px - sx) ** 2 + (py - sy) ** 2) ** .5; worst = max(worst, off); rows.append(f"{star} {off:.2f}")
        await pg.keyboard.press("Escape")
    check(worst <= 2, "pin on a star", f"at {round(v['W'])} CSS px the pin lands {', '.join(rows)} px from the star in the picture")
    check(not pg.errs, "no page errors (pin)", str(pg.errs[:3])); await pg.context.close()

ALL = dict(alignment=alignment, still=still_rule, backoff=backoff, deadline=deadline, late=late_replies, fallback=fallback, handoff=handoff, regression=regression, overlays=overlays, pin=pin)
async def main():
    async with async_playwright() as p:
        b = await launch(p)
        for name, fn in ALL.items():
            if not ONLY or name in ONLY: await fn(b)
        await b.close()
    print("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"); sys.exit(1 if fails else 0)
if __name__ == "__main__": asyncio.run(main())
