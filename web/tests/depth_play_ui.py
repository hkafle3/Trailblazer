"""Phase 3, the time-lapse plays in Depth (comet-hunt-work/phase3-plan/plan.md): the evaluator's automated parts, in
system Chrome. Needs the app up (npm run dev, or the preview version) with migration 0019 and the showcase blink baked
(bake/blink_bake.mjs, C-0176 at 84.0181 -6.5770), and the network (Gaia and SkyBoT through /api/depth, SPHEREx frames).
Expected values come from the API (and JPL Horizons fixtures), never from the page.
E1 Positions
  (a) Gaia, on C-0176 and Barnard's Star: each star's place along the beam, put back through the beam's log scale, equals
      its /api/depth d_pc within 0.5%; its place on the photo equals the patch projection of its API position (moved by its
      proper motion to the visit's year) within 1 px. C-0176 is Gaia DR3 3016939686189355904.
  (b) JPL: for every known comet every photo time lies inside its baked path; in the scene at each photo time the comet
      sits on its baked photo-time vector and Earth on planets.json; for 3I/ATLAS both lie within 1e-3 AU of Horizons'
      vectors (tests/fixtures/phase3/horizons-*-visits.json).
E2 In step: one test per events-states row (rows 1-8, 10-16, C1-C7 and the two new rows), then a sampler over two
   loops in Depth: on every animation frame the entry shown, the photo plane, the inset and the timeline dot agree, and
   the subject's glow reaches its target before the next step. Pulse: C-0176's settled glow area over its 2010 area
   equals the band's lead_ratio within 3%; outside a measured band the glow stays steady.
E4 Layout: the tab group and the zoom group never overlap at widths 761 to 1100 (step 10), 881, 1440 and 390, in both
   views on both pages.
Run: uv run -q --with playwright python web/tests/depth_play_ui.py [base url]   (default http://127.0.0.1:8787)
     ONLY=e1|e2|comet|e4 runs one part."""
import asyncio, json, math, os, pathlib, sys, urllib.parse, urllib.request
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
ONLY = os.environ.get("ONLY")
HERE = pathlib.Path(__file__).parent
SPOT = "ra=84.0181&dec=-6.5770&det=D1&blink=C-0176"
C0176 = f"{BASE}/timelapse.html?{SPOT}&ch=91&view=depth"   # 4.6 um, inside W2: the 2010 entry is there
C0176_D1 = f"{BASE}/timelapse.html?{SPOT}&view=depth"      # the default channel (about 1 um): outside every measured band
BARNARD = f"{BASE}/timelapse.html?target=barnard&view=depth"
ATLAS = f"{BASE}/comet.html?id=" + urllib.parse.quote("3I/ATLAS", safe="")
GAIA_C0176 = "3016939686189355904"
LY_PC, MJD_JD = 3.26156, 2400000.5
fails = []
def check(ok, what):
    print(("PASS " if ok else "FAIL ") + what, flush=True)
    if not ok: fails.append(what)
def api(path): return json.loads(urllib.request.urlopen(BASE + path, timeout=120).read())

# ---------------------------------------------------------------- pages
async def lapse(b, url, reduced=False, w=1440, h=900, routes=()):
    ctx = await b.new_context(viewport={"width": w, "height": h}, reduced_motion="reduce" if reduced else "no-preference")
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
    for pat, fn in routes: await ctx.route(pat, fn)
    pg = await ctx.new_page(); pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    await pg.goto(url)
    await pg.wait_for_function("!!window.__lapse?.state.m", timeout=300000)
    await pg.evaluate(SHOWN_FN)
    return ctx, pg
async def drawn(pg, entries=None):   # Depth answered, and (with the 2010 entry) the timeline holds it
    await pg.wait_for_function("document.getElementById('depth3d').dataset.state === 'ready' && __depth.stars().length > 0", timeout=180000)
    if entries: await pg.wait_for_function(f"document.querySelectorAll('#tl-visits i').length === {entries}", timeout=120000)
    await pg.wait_for_timeout(2000)   # the swing out ends

# what each part shows: the entry (2010 or a visit's MJD), the photo plane, the inset, the timeline dot, the glow
SHOWN_FN = """() => { window.__p3 = () => { const s = __lapse.state, b = document.getElementById('depth3d'), fr = s.m.frames, dots = [...document.querySelectorAll('#tl-visits i')];
  const ents = [...(dots.length > fr.length ? ['old'] : []), ...fr.map(f => f.mjd.toFixed(4))], k = dots.findIndex(d => d.classList.contains('cur'));
  return { entry: s.old ? 'old' : fr[s.i].mjd.toFixed(4), k: ents.indexOf(s.old ? 'old' : fr[s.i].mjd.toFixed(4)), n: ents.length, ents, playing: s.playing,
    view: document.body.classList.contains('tn-on') ? 'thenandnow' : document.body.classList.contains('depth') ? 'depth' : 'photo',
    photo: b.dataset.photo, inset: b.dataset.inset, dot: ents[k] ?? null, glow: __depth.glow(), swing: __depth.view.swing, knobOff: document.getElementById('play').disabled }; }; }"""
S = lambda pg: pg.evaluate("__p3()")
def agree(s): return s["entry"] == s["photo"] == s["inset"] == s["dot"]
async def press(pg, key): await pg.focus("#play"); await pg.keyboard.press(key)
async def entry(pg, k):   # put entry k on screen, paused (Home, then k arrows)
    await press(pg, "Home")
    for _ in range(k): await pg.keyboard.press("ArrowRight")
    await pg.evaluate("document.activeElement.blur()")

# ---------------------------------------------------------------- E1 (a) Gaia
def patch_uv(o, geo):   # where an API star sits on the patch (-1..1, north up): TAN about the centre, moved to the visit's year
    ra, dec = o["ra"], o["dec"]; dt = geo["year"] - 2016
    if o.get("pmra") is not None: dec2 = dec + o["pmdec"] / 3.6e6 * dt; ra = ra + o["pmra"] / 3.6e6 * dt / math.cos(math.radians(dec)); dec = dec2
    d0, d, da = math.radians(geo["dec"]), math.radians(dec), math.radians(ra - geo["ra"])
    cc = math.sin(d0) * math.sin(d) + math.cos(d0) * math.cos(d) * math.cos(da)
    e = math.cos(d) * math.sin(da) / cc * 206264.806; n = (math.cos(d0) * math.sin(d) - math.sin(d0) * math.cos(d) * math.cos(da)) / cc * 206264.806
    return -e / geo["half"], n / geo["half"]

async def e1_gaia(b, url, name, want_target=None):
    ctx, pg = await lapse(b, url); await drawn(pg)
    u = await pg.evaluate("__depth.url"); ans = json.loads(urllib.request.urlopen(u if u.startswith("http") else BASE + u, timeout=120).read())
    geo = await pg.evaluate("(({ m, i }) => ({ ra: m.ra, dec: m.dec, half: m.grid * m.arcsec_per_pixel / 2, year: m.frames[i].year }))(__lapse.state)")
    byid = {f"stars:{o['id']}": o for o in ans["sources"]["stars"]["placed"]}
    stars = await pg.evaluate("__depth.stars()")
    dist_bad, px_bad, worst_d, worst_px = [], [], 0, 0
    for st in stars:
        o = byid.get(st["key"])
        if not o: dist_bad.append(st["key"] + " not in the API's answer"); continue
        ly = await pg.evaluate("f => __depth.scaleInv(f)", st["f"]); want = o["d_pc"] * LY_PC; err = abs(ly / want - 1); worst_d = max(worst_d, err)
        if err > .005: dist_bad.append(f"{st['key']} {ly:.1f} vs {want:.1f} ly")
        uv = patch_uv(o, geo); xy = await pg.evaluate("p => __depth.px(p)", [uv[0], uv[1]]); d = math.hypot(xy[0] - st["photo"][0], xy[1] - st["photo"][1]); worst_px = max(worst_px, d)
        if d > 1 and not st["target"]: px_bad.append(f"{st['key']} {d:.2f} px")
    check(stars and not dist_bad, f"E1a {name}: {len(stars)} stars, each one's place along the beam back through the log scale is its API distance within 0.5% (worst {100 * worst_d:.3f}%) {dist_bad[:3]}")
    check(stars and not px_bad, f"E1a {name}: each star's place on the photo is the patch projection of its API position within 1 px (worst {worst_px:.3f} px) {px_bad[:3]}")
    if want_target:
        t = [s for s in stars if s["target"]]
        check(len(t) == 1 and t[0]["key"] == f"stars:{want_target}", f"E1a {name}: the target is Gaia DR3 {want_target} ({[s['key'] for s in t]})")
    await ctx.close()

# ---------------------------------------------------------------- E1 (b) JPL
def lerp(rows, jd):
    if jd <= rows[0][0]: return rows[0][1:]
    if jd >= rows[-1][0]: return rows[-1][1:]
    lo, hi = 0, len(rows) - 1
    while hi - lo > 1:
        m = (lo + hi) // 2
        if rows[m][0] <= jd: lo = m
        else: hi = m
    a, c = rows[lo], rows[hi]; t = (jd - a[0]) / (c[0] - a[0]); return [a[i] + t * (c[i] - a[i]) for i in (1, 2, 3)]
def horizons(f):
    r = json.load(open(HERE / "fixtures/phase3" / f))["result"]; body = r[r.find("$$SOE") + 5:r.find("$$EOE")]
    return [[float(p[0])] + [float(v) for v in p[2:5]] for p in (l.split(",") for l in body.strip().splitlines())]

async def e1_jpl(b):
    listing = api("/api/comets")["comets"]; ids = [c["id"] for c in listing if c["kind"] == "known"]
    planets = json.loads(urllib.request.urlopen(BASE + "/data/planets.json").read())
    recs = {cid: api("/api/comets/" + urllib.parse.quote(cid, safe="")) for cid in ids}
    outside = [(cid, v["link"]["t"]) for cid, c in recs.items() for v in c["detail"]["facts"]["inv"]["visits"]
               if not (c["detail"]["facts"]["path"]["rows"][0][0] <= v["link"]["t"] + MJD_JD <= c["detail"]["facts"]["path"]["rows"][-1][0])]
    check(not outside, f"E1b: every photo time of all {len(ids)} known comets lies inside its baked path {outside[:3]}")
    sem = asyncio.Semaphore(4); bad = []; worst = [0, 0]; scene = {}
    async def one(cid):
        async with sem:
            ctx = await b.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce"); pg = await ctx.new_page()
            await pg.goto(f"{BASE}/comet.html?id={urllib.parse.quote(cid, safe='')}"); await pg.wait_for_function("document.querySelector('main').dataset.ready")
            await pg.click("#tab-depth"); await pg.wait_for_function("!!window.__scene", timeout=60000)
            got = await pg.evaluate("""async () => { await __scene.ready; __scene.play(false); const out = [];
              for (let k = 0; k < __scene.shown.n; k++) { __scene.go(k, { glide: false }); out.push([__scene.ecl(__scene.shown.comet), __scene.ecl(__scene.shown.earth), __scene.shown.jd]); } return out; }""")
            await ctx.close()
            vs = recs[cid]["detail"]["facts"]["inv"]["visits"]
            for v, (cm, ea, jd) in zip(vs, got):
                want_jd = v["link"]["t"] + MJD_JD; dc = max(abs(a - c) for a, c in zip(cm, v["xyz"])); de = max(abs(a - c) for a, c in zip(ea, lerp(planets["earth"], want_jd)))
                worst[0] = max(worst[0], dc); worst[1] = max(worst[1], de)
                if abs(jd - want_jd) > 1e-6 or dc > 1e-9 or de > 1e-9: bad.append(f"{cid} {v['link']['t']}: comet {dc:.2e}, Earth {de:.2e} AU")
            scene[cid] = got
    await asyncio.gather(*(one(c) for c in ids))
    check(not bad and len(scene) == len(ids), f"E1b: in the scene at each photo time of {len(ids)} comets the comet sits on its baked vector and Earth on planets.json (worst {worst[0]:.1e}, {worst[1]:.1e} AU) {bad[:3]}")
    # 3I/ATLAS against independent Horizons vectors at its photo times
    ha, he = horizons("horizons-atlas-visits.json"), horizons("horizons-earth-visits.json"); g = scene.get("3I/ATLAS", [])
    da = max(math.dist(c, h[1:]) for (c, _, _), h in zip(g, ha)) if g else 9; de = max(math.dist(e, h[1:]) for (_, e, _), h in zip(g, he)) if g else 9
    check(len(g) == len(ha) == 5 and da < 1e-3 and de < 1e-3, f"E1b 3I/ATLAS: the comet within {da:.1e} AU and Earth within {de:.1e} AU of Horizons at its 5 photo times (1e-3 allowed)")

# ---------------------------------------------------------------- E2: the time-lapse rows
async def e2_lapse(b):
    ctx, pg = await lapse(b, C0176); await drawn(pg, 4)
    s = await S(pg); check(s["n"] == 4 and s["ents"][0] == "old", f"C-0176 at 4.6 um: the entries are [2010, 3 visits] ({s['ents']})")
    await entry(pg, 0); await pg.wait_for_timeout(300)
    # 1, 2 play and pause
    await pg.click("#play"); await pg.wait_for_timeout(1900); s = await S(pg)
    check(s["playing"] and s["k"] == 1 and agree(s), f"row 1 press the knob | paused: frame, photo plane, inset and dot moved to entry 2 together ({s['entry']}, {s['photo']}, {s['inset']}, {s['dot']})")
    await pg.click("#play"); k = (await S(pg))["k"]; await pg.wait_for_timeout(2200); s = await S(pg)
    check(not s["playing"] and s["k"] == k, f"row 2 press the knob | playing: paused on entry {k} ({s['k']})")
    # 3, 4 the tabs keep the frame and the playing
    await pg.click("#play"); await pg.wait_for_timeout(100); await pg.click("#tab-photo"); k = (await S(pg))["k"]; await pg.wait_for_timeout(1800); s = await S(pg)
    check(s["view"] == "photo" and s["playing"] and s["k"] != k, f"row 3 tab to Photo | Depth, playing: Photo, still playing, the frame advanced ({k} -> {s['k']})")
    await pg.click("#tab-depth"); await pg.wait_for_timeout(50); s = await S(pg)
    check(s["view"] == "depth" and s["playing"] and s["swing"] is not None and s["swing"] < .3 and agree(s), f"row 4 tab to Depth | Photo, playing: Depth, still playing, the swing restarted ({s['swing']})")
    await pg.click("#play"); await pg.wait_for_timeout(2000)
    # 5 drag the knob end to end
    await entry(pg, 0); line = await pg.locator("#tl-line").bounding_box(); kn = await pg.locator("#play").bounding_box()
    await pg.mouse.move(kn["x"] + kn["width"] / 2, kn["y"] + kn["height"] / 2); await pg.mouse.down(); seen = []
    for n in range(31): await pg.mouse.move(line["x"] + line["width"] * n / 30, line["y"] + 1); seen.append((await S(pg))["k"])
    await pg.mouse.up(); s = await S(pg)
    check(not s["playing"] and seen == sorted(seen) and set(seen) == {0, 1, 2, 3} and agree(s), f"row 5 drag the knob | any: entries 1 to 4 in order, paused after release ({sorted(set(seen))})")
    # 6 the line, 7 arrows, 8 space
    await pg.mouse.click(line["x"] + line["width"] * .05, line["y"] + 1); s = await S(pg)
    check(s["k"] == 0 and not s["playing"], f"row 6 click the line | any: the nearest entry (2010), paused ({s['entry']})")
    await press(pg, "ArrowRight"); s = await S(pg)
    check(s["k"] == 1 and not s["playing"] and agree(s), f"row 7 arrow key on the knob | any: next entry, paused ({s['k']})")
    await pg.keyboard.press("Space"); s = await S(pg)
    check(s["playing"], "row 8 space on the knob | paused: playing")
    # 14 drag to turn while playing
    k = s["k"]; c = await pg.locator("#depth3d > canvas").bounding_box(); await pg.mouse.move(c["x"] + 300, c["y"] + 300); await pg.mouse.down()
    for n in range(10): await pg.mouse.move(c["x"] + 300 - 15 * n, c["y"] + 300 + 3 * n)
    await pg.mouse.up(); await pg.wait_for_timeout(1700); s = await S(pg)
    check(s["playing"] and s["k"] != k and await pg.evaluate("__depth.view.a") != 0, f"row 14 drag to turn | playing: turned, still playing, entry {k} -> {s['k']}")
    # 15 Then and now pauses; back in Depth: the same entry, paused
    k = (await S(pg))["k"]; await pg.click("#tab-tn"); await pg.wait_for_timeout(1700); t = await S(pg); await pg.click("#tab-depth"); await pg.wait_for_timeout(1700); s = await S(pg)
    check(t["view"] == "thenandnow" and not t["playing"] and not s["playing"] and s["k"] == t["k"] == k, f"row 15 tab to Then and now | playing: paused there, back on the same entry ({k}, {t['k']}, {s['k']})")
    # the sampler: two loops in Depth, every animation frame
    await entry(pg, 0); await pg.click("#play")
    r = await pg.evaluate("""ms => new Promise(done => { const out = { n: 0, bad: [], late: [], steps: 0, stars: [] }; let prev = null; const t0 = performance.now();
      const f = () => { const s = __p3(); out.n++; out.stars.push(__depth.stars().length);
        if (!(s.entry === s.photo && s.entry === s.inset && s.entry === s.dot)) out.bad.push([s.entry, s.photo, s.inset, s.dot]);
        if (prev && s.entry !== prev.entry) { out.steps++; if (prev.glow && Math.abs(prev.glow.b - prev.glow.to) > 1e-6) out.late.push(prev.entry); }
        prev = s; performance.now() - t0 < ms ? requestAnimationFrame(f) : done(out); }; requestAnimationFrame(f); })""", 2 * 4 * 1600 + 400)
    check(r["steps"] >= 7 and not r["bad"] and not r["late"], f"E2 sampler: {r['n']} animation frames over two loops ({r['steps']} steps): entry, photo plane, inset and dot disagree on {len(r['bad'])}, the glow arrived late on {len(r['late'])} {r['bad'][:2]}")
    check(min(r["stars"]) == max(r["stars"]) > 0, f"new row: the visit changes in Depth while playing, the stars stay ({min(r['stars'])} to {max(r['stars'])} on every frame)")
    await pg.click("#play")
    # the SkyBoT marks of another visit never show: at each visit, the sso keys drawn are that visit's own answer's
    wrong = []
    for k in range(1, 4):
        await entry(pg, k); await pg.wait_for_function("document.getElementById('depth3d').dataset.state !== 'asking'", timeout=120000); await pg.wait_for_timeout(300)
        u = await pg.evaluate("__depth.url"); ans = json.loads(urllib.request.urlopen(u if u.startswith("http") else BASE + u, timeout=120).read())
        own = {f"sso:{o.get('id') or o.get('name')}" for o in ans["sources"]["sso"].get("placed") or []}
        drawn_sso = set(k2 for k2 in (await pg.evaluate("__depth.shown.rings.concat(__depth.shown.dots)")) if k2.startswith("sso:"))
        if not drawn_sso <= own: wrong.append((k, sorted(drawn_sso - own)))
    check(not wrong, f"new row: SkyBoT marks swap with the visit, never another visit's {wrong}")
    # the pulse: the settled glow on a SPHEREx entry over the 2010 entry's, by area, against the band's lead_ratio
    ratio = await pg.evaluate("window.__blink?.results?.W2?.report?.lead_ratio")
    blink = api("/api/blink?ra=84.01810&dec=-6.57700"); want = blink["bands"]["W2"]["report"]["lead_ratio"]
    await entry(pg, 0); await pg.wait_for_timeout(1300); g0 = (await S(pg))["glow"]
    await entry(pg, 2); await pg.wait_for_timeout(1300); g1 = (await S(pg))["glow"]
    area = (g1["d"] / g0["d"]) ** 2
    print(f"  settled {g0['settled']} {g1['settled']}, the page's ratio {ratio}")
    check(g0["settled"] and g1["settled"] and abs(area / want - 1) <= .03 and ratio is not None and abs(ratio - want) < 1e-9,
          f"pulse: C-0176's settled glow area on a SPHEREx entry over 2010's is {area:.4f}, the band's lead_ratio {want} (within 3%: {100 * abs(area / want - 1):.3f}%)")
    check(g0["sub"] == "its 2010 brightness" and g1["sub"] == f"{want:.2f}× its 2010 brightness", f"pulse: the subject's second line says it ({g0['sub']!r}, {g1['sub']!r})")
    check(not pg.errors, f"time-lapse rows: no page errors {pg.errors[:3]}")
    await ctx.close()

    # 10 and 11: no 2010 entry outside a measured band, or when the band's result is not ok; the glow stays steady
    async def steady(url, routes=(), why=""):
        ctx, pg = await lapse(b, url, routes=routes); await drawn(pg)
        await pg.wait_for_timeout(3000)   # the blink's answer has landed
        s = await S(pg); ds = []
        for k in range(s["n"]): await entry(pg, k); await pg.wait_for_timeout(900); ds.append((await S(pg))["glow"])
        steady_ = all(g and abs(g["d"] - ds[0]["d"]) < 1e-6 and g["b"] == 1 and not g["sub"] for g in ds)
        check("old" not in s["ents"] and steady_, f"{why}: no 2010 entry ({s['ents']}), the glow steady over every entry ({[round(g['d'], 3) for g in ds if g]})")
        check(not pg.errors, f"{why}: no page errors {pg.errors[:3]}"); await ctx.close()
    await steady(C0176_D1, why="row 10 the dial outside the measured bands (D1, about 1 um)")
    async def not_ok(route):
        r = await route.fetch(); body = await r.json()
        for k in body.get("bands", {}): body["bands"][k] = {"state": "comparison-unavailable", "reason": "test: no fair comparison"}
        await route.fulfill(response=r, json=body)
    await steady(C0176, routes=[("**/api/blink?**", not_ok)], why="row 11 the blink not ok (every band refused), at 4.6 um")

    # 12, 13 reduced motion
    ctx, pg = await lapse(b, C0176, reduced=True); await drawn(pg, 4); await pg.wait_for_timeout(600); s = await S(pg)
    check(not s["playing"] and s["swing"] is None, f"row 12 Depth opens | reduced motion: not playing, no swing ({s['playing']}, {s['swing']})")
    await entry(pg, 2); s = await S(pg)
    check(s["glow"]["b"] == s["glow"]["to"] and agree(s), f"row 13 frame changes | reduced motion: the glow takes its new size at once ({s['glow']['b']} = {s['glow']['to']})")
    await pg.click("#play"); await pg.wait_for_timeout(1900); s2 = await S(pg)
    check(s2["playing"] and s2["k"] != s["k"], "reduced motion: pressing play still steps")
    await ctx.close()

    # 16 every frame fails: no patch geometry, so Depth says so with a retry; the knob is off; no beam
    async def boom(route): await route.abort()
    ctx = await b.new_context(viewport={"width": 1440, "height": 900})
    for pat in ("**/api/images**", "**/nasa-irsa-spherex/**", "**irsa.ipac.caltech.edu/**", "**/data/targets/**"): await ctx.route(pat, boom)
    pg = await ctx.new_page(); pg.errors = []; pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    await pg.goto(f"{BASE}/timelapse.html?ra=12.3456&dec=-45.6789&det=D2&view=depth")
    try:
        await pg.wait_for_function("!document.getElementById('depth-retry').hidden", timeout=180000)
        r = await pg.evaluate("[document.getElementById('play').disabled, +document.getElementById('depth3d').dataset.objects || 0, document.getElementById('depth-msg').textContent, getComputedStyle(document.getElementById('p3-inset')).display]")
        check(r[0] and r[1] == 0 and "did not load" in r[2] and r[3] == "none", f"row 16 every frame fails: the photos did not load, a retry, the knob disabled, no beam ({r})")
    except Exception as e: check(False, f"row 16 every frame fails: no retry shown ({str(e)[:80]})")
    check(not pg.errors, f"row 16: no page errors {pg.errors[:3]}")
    await ctx.close()

# ---------------------------------------------------------------- E2: the comet page rows (C1 to C7, and 11 visits)
async def comet(b, url, reduced=False, routes=()):
    ctx = await b.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce" if reduced else "no-preference")
    for pat, fn in routes: await ctx.route(pat, fn)
    pg = await ctx.new_page(); pg.errors = []; pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    await pg.goto(url); await pg.wait_for_function("document.querySelector('main').dataset.ready")
    await pg.click("#tab-depth"); await pg.wait_for_function("!!window.__scene", timeout=60000); await pg.evaluate("__scene.ready")
    return ctx, pg
C = lambda pg: pg.evaluate("__scene.shown")

async def e2_comet(b):
    vs = api("/api/comets/" + urllib.parse.quote("3I/ATLAS", safe=""))["detail"]["facts"]["inv"]["visits"]; jd = [v["link"]["t"] + MJD_JD for v in vs]
    ctx, pg = await comet(b, ATLAS); await pg.wait_for_timeout(1700); await pg.evaluate("__scene.play(false); __scene.go(0, { glide: false })"); await pg.wait_for_timeout(300)
    await pg.click(".p3-play .tl-knob"); await pg.wait_for_timeout(500); s = await C(pg)
    check(s["playing"] and s["i"] == 1 and s["strip"] == 1 and s["dot"] == 1, f"C1 press the knob | comet, paused: playing, visit 2 in the strip and timeline ({s['i']}, {s['strip']}, {s['dot']})")
    await pg.wait_for_function("__scene.shown.i === 2", timeout=8000); await pg.wait_for_timeout(300); mid = await C(pg)
    await pg.wait_for_function("__scene.shown.lit", timeout=8000); s = await C(pg)
    check(jd[1] < mid["jd"] < jd[2] and mid["earth"] != s["earth"] and s["tiles"] == ["faint", "faint", "lit", "hidden", "hidden"], f"C2 a visit months later | comet, playing: mid-glide {mid['date']}, then tiles {s['tiles']}")
    await pg.click(".p3-play .tl-knob"); await pg.click(".p3-strip figure:nth-child(4)"); await pg.wait_for_function("__scene.shown.lit", timeout=8000); await pg.wait_for_timeout(250); s = await C(pg)
    check(not s["playing"] and s["i"] == 3 and s["strip"] == 3 and s["tiles"][3] == "lit", f"C3 click a photo in the strip | comet: paused, visit 4 lit ({s['i']}, {s['tiles']})")
    line = await pg.locator(".p3-play .tl-line").bounding_box(); kn = await pg.locator(".p3-play .tl-knob").bounding_box()
    await pg.mouse.move(kn["x"] + kn["width"] / 2, kn["y"] + kn["height"] / 2); await pg.mouse.down(); jds, sel = [], []
    await pg.mouse.move(line["x"] + 2, line["y"] + 1)
    for n in range(11): await pg.mouse.move(line["x"] + line["width"] * (.05 + .9 * n / 10), line["y"] + 1); sh = await C(pg); jds.append(sh["jd"]); sel.append(sh["i"])
    await pg.mouse.up()
    check(all(b_ > a_ for a_, b_ in zip(jds, jds[1:])) and sel == sorted(sel), f"C4 drag the knob | comet: the date rises every step, the selection only moves forward ({sel})")
    hero = await pg.evaluate("document.getElementById('c-hero').getAttribute('src')")
    await pg.click(".p3-play .tl-knob"); await pg.click("#tab-photo"); s = await C(pg)
    h = await pg.evaluate("[document.getElementById('c-photo').hidden, document.getElementById('c-depth').hidden, document.getElementById('c-hero').getAttribute('src')]")
    check(s["view"] == "photo" and not s["playing"] and h == [False, True, hero], f"C5 tab to Photo | comet, playing: today's picture, not playing ({s['view']}, {s['playing']}, {h})")
    check(not pg.errors, f"comet rows: no page errors {pg.errors[:3]}")
    await ctx.close()
    # C6: visit 3's picture fails: play from visit 2 goes to visit 4; chosen by hand its frustum is still drawn
    async def gone(route): await route.fulfill(status=404, body="")
    ctx, pg = await comet(b, ATLAS, routes=[(f"**/{vs[2]['img']}", gone)]); await pg.wait_for_timeout(1700)
    await pg.evaluate("__scene.play(false); __scene.go(1, { glide: false })"); await pg.click(".p3-play .tl-knob"); await pg.wait_for_function("__scene.shown.i !== 1", timeout=8000); s = await C(pg)
    await pg.click(".p3-play .tl-knob"); await pg.evaluate("__scene.go(2, { glide: false })"); await pg.wait_for_timeout(200); s2 = await C(pg)
    miss = await pg.evaluate("[document.querySelectorAll('.p3-play .tl-visit')[2].classList.contains('miss'), !document.querySelector('.p3-miss').hidden]")
    check(s["i"] == 3 and 2 in s["failed"] and s2["tiles"][2] == "lit" and miss == [True, True], f"C6 a visit's picture fails | comet, playing: skipped ({s['i']}), hollow dot and the note, its frustum still drawn when chosen ({s2['tiles']}, {miss})")
    await ctx.close()
    # C7: reduced motion: no autoplay; a step jumps
    ctx, pg = await comet(b, ATLAS, reduced=True); await pg.wait_for_timeout(2500); s = await C(pg)
    await pg.evaluate("__scene.go(3)"); s2 = await C(pg)
    check(not s["playing"] and s2["lit"] and abs(s2["jd"] - jd[3]) < 1e-6, f"C7 open and step | comet, reduced motion: not playing, the scene at visit 4's time at once ({s['playing']}, {s2['jd']})")
    await ctx.close()
    # new row: a comet with 11 visits (C/2025 E1): every visit reachable in the strip, the chosen one in view
    cid = "C/2025 E1 (PANSTARRS)"; n = len(api("/api/comets/" + urllib.parse.quote(cid, safe=""))["detail"]["facts"]["inv"]["visits"])
    for w in (1440, 390):
        ctx = await b.new_context(viewport={"width": w, "height": 900 if w > 400 else 844}, reduced_motion="reduce", is_mobile=w < 400, has_touch=w < 400)
        pg = await ctx.new_page(); await pg.goto(f"{BASE}/comet.html?id={urllib.parse.quote(cid, safe='')}"); await pg.wait_for_function("document.querySelector('main').dataset.ready")
        await pg.click("#tab-depth"); await pg.wait_for_function("!!window.__scene", timeout=60000); await pg.evaluate("__scene.ready")
        got = []
        for k in range(n):
            f = pg.locator(f".p3-strip figure:nth-child({k + 1})"); await f.scroll_into_view_if_needed(); await f.click(); s = await C(pg)
            inview = await pg.evaluate("k => { const s = document.querySelector('.p3-strip'), f = s.children[k], a = s.getBoundingClientRect(), r = f.getBoundingClientRect(); return r.left >= a.left - 1 && r.right <= a.right + 1 && r.width >= 43.5; }", k)
            got.append(s["i"] == k and s["strip"] == k and inview)
        check(n == 11 and all(got), f"new row: {cid}'s {n} visits each reachable in the strip at {w} px, 44 px or wider and in view when chosen ({got.count(True)} of {n})")
        await ctx.close()

# ---------------------------------------------------------------- E4: the tab group and the zoom group never overlap
OVER = """([tabs, zoom]) => { const a = document.querySelector(tabs), z = [...document.querySelectorAll(zoom)].find(e => e.offsetWidth);
  if (!a || !z || !a.offsetWidth) return null; const r = a.getBoundingClientRect(), q = z.getBoundingClientRect();
  return { gap: q.left - r.right, over: r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top }; }"""
async def e4(b):
    widths = sorted(set(list(range(761, 1101, 10)) + [881, 1440, 390]))
    for name, url, tabs, zoom, sel in (("comet page", ATLAS, ".shot .tabs", ".shot .dzoom", ("#tab-photo", "#tab-depth")),
                                       ("time-lapse", f"{BASE}/timelapse.html?{SPOT}&ch=91", ".pv-views", ".xp-d3-zoom", ("#tab-photo", "#tab-depth"))):
        ctx = await b.new_context(viewport={"width": 1440, "height": 900}); await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
        pg = await ctx.new_page(); await pg.goto(url)
        await pg.wait_for_function("document.querySelector('main')?.dataset.ready || window.__lapse?.state.m", timeout=300000)
        bad, seen = [], 0
        for view in sel:
            await pg.click(view); await pg.wait_for_timeout(600)
            for w in widths:
                await pg.set_viewport_size({"width": w, "height": 844 if w < 400 else 900}); await pg.wait_for_timeout(120)
                r = await pg.evaluate(OVER, [tabs, zoom])
                if r is None: continue
                seen += 1
                if r["over"]: bad.append(f"{view} {w}px ({r['gap']:.0f})")
        check(seen and not bad, f"E4 {name}: the tabs and the zoom group never overlap at {len(widths)} widths in both views ({seen} views with both shown) {bad[:4]}")
        await ctx.close()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True, args=["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"])
        if ONLY in (None, "e1"):
            await e1_gaia(b, C0176, "C-0176", GAIA_C0176); await e1_gaia(b, BARNARD, "Barnard's Star"); await e1_jpl(b)
        if ONLY in (None, "e2"): await e2_lapse(b)
        if ONLY in (None, "e2", "comet"): await e2_comet(b)
        if ONLY in (None, "e4"): await e4(b)
        await b.close()
    print(f"{'PASS' if not fails else 'FAIL'} depth play: {len(fails)} failed"); sys.exit(1 if fails else 0)

asyncio.run(main())
