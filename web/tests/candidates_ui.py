"""Browser check for the detector's moving-object candidates: the Candidates page, Explore's Investigate layer, the
track on the time-lapse and the votes, in Chrome at 1440x900 and as a phone (390x844, touch). Needs the app up
(npx wrangler dev --config worker/wrangler.toml) with no web/data/candidates.json (the detector not run yet).
Expected values come from web/data/candidates.sample.json and skymap.js, never from the page.
Run: uv run -q --with playwright python web/tests/candidates_ui.py [base url] [screenshot dir]   (default http://127.0.0.1:8787)"""
import asyncio, json, math, pathlib, sys, urllib.request, urllib.error, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
SHOTS = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
SAMPLE = json.loads((pathlib.Path(__file__).parent.parent / "data/candidates.sample.json").read_text())
CANDS = SAMPLE["candidates"]
WORTH = [c for c in CANDS if c["verdict"] == "worth_reporting"]
VERDICTS = {"worth_reporting", "known", "glitch", "star"}
D = math.pi / 180

def offset(ra0, dec0, ra, dec):   # east, north arcsec on the patch's TAN plane
    d0, d, da = dec0 * D, dec * D, (ra - ra0) * D
    c = math.sin(d0) * math.sin(d) + math.cos(d0) * math.cos(d) * math.cos(da)
    return math.cos(d) * math.sin(da) / c / D * 3600, (math.cos(d0) * math.sin(d) - math.sin(d0) * math.cos(d) * math.cos(da)) / c / D * 3600

def mjd(s): return (__import__("datetime").date.fromisoformat(s) - __import__("datetime").date(1858, 11, 17)).days

SIDEWAYS = "() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth"

async def no_fake(pg, path):
    await pg.goto(BASE + path); await pg.wait_for_load_state("networkidle")
    body = await pg.text_content("body")
    leaked = [c["id"] for c in CANDS if c["id"] in body]
    assert not leaked, f"{path}: sample candidates shown without ?sample=1: {leaked}"

async def run(p, name, ctx_args):
    b = await p.chromium.launch(channel="chrome")
    ctx = await b.new_context(**ctx_args)
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.user', JSON.stringify({ name: 'cand tester' })) } catch {}")
    pg = await ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    phone = ctx_args["viewport"]["width"] < 641
    shot = lambda n: pg.screenshot(path=str(SHOTS / f"{name}-{n}.png"), full_page=False) if SHOTS else asyncio.sleep(0)

    # ---- the detector not run yet (its file answered 404 here): said plainly, nothing made up anywhere ----
    await pg.route("**/data/candidates.json", lambda r: r.fulfill(status=404, body="not found"))
    await pg.goto(BASE + "/candidates.html"); await pg.wait_for_selector("#c-empty:not([hidden])")
    assert await pg.locator(".cd").count() == 0 and await pg.is_hidden("#c-check") and await pg.is_hidden("#c-sample")
    assert "not run yet" in await pg.text_content("#c-empty")
    assert await pg.evaluate(SIDEWAYS) <= 0, "sideways scroll on the empty page"
    await shot("empty")
    await no_fake(pg, "/candidates.html")
    await no_fake(pg, "/explore.html"); assert await pg.locator(".mk.cand, #ly-cand").count() == 0, "Investigate layer without data"
    await no_fake(pg, "/timelapse.html?target=barnard&cand=K-0001")
    assert await pg.evaluate("window.__cand?.ring") is None, "a track drawn without data"
    await pg.unroute("**/data/candidates.json")

    # ---- the real detector file: a test run, said so; each check pass or fail; Worth reporting empty, said so ----
    # (skipped while the detector has not shipped a file: then the page says so, checked above)
    try: REAL = json.load(urllib.request.urlopen(BASE + "/data/candidates.json"))
    except urllib.error.HTTPError as e: assert e.code == 404; REAL = None
    if REAL is not None:
        await pg.goto(BASE + "/candidates.html"); await pg.wait_for_selector(".c-group")
        assert await pg.is_hidden("#c-sample"), "real data labelled as sample"
        v = REAL["validation"]; fails = (v["known_recovered"] / v["known_expected"] < .8) + (v["planted_found"] < .8) + (v["false_per_sqdeg"] >= 1)
        if fails:
            t = await pg.text_content("#c-test")
            assert await pg.is_visible("#c-test") and f"Test run on {len(REAL['regions'])} fields, detector still being tuned" in t, t
        marks = await pg.eval_on_selector_all("#c-check dl > div", "e => e.map(d => [d.dataset.pass, d.querySelector('.ok').textContent])")
        assert [m[0] for m in marks] == [str(v["known_recovered"] / v["known_expected"] >= .8).lower(), str(v["planted_found"] >= .8).lower(), str(v["false_per_sqdeg"] < 1).lower()], marks
        assert all(m[1].startswith("Pass") if m[0] == "true" else m[1].startswith("Fail") for m in marks), marks
        groups = await pg.eval_on_selector_all(".c-group", "e => e.map(g => [g.dataset.v, +g.querySelector('.sec .n').textContent, [...g.querySelectorAll('.cd')].map(c => c.dataset.id), g.querySelector('.c-none')?.textContent || ''])")
        for gv, n, cids, none in groups:
            want = [c["id"] for c in REAL["candidates"] if c["verdict"] == gv]
            assert n == len(want) and cids == want, (gv, n, cids)
            if gv == "worth_reporting" and not want: assert none.startswith("None yet"), none
        assert groups[0][0] == "worth_reporting", "Worth reporting is not first"
        # a real card opens the time-lapse at its own first detection, never a baked target patch that only shares the region's name
        links = await pg.eval_on_selector_all(".cd .cd-open", "e => e.map(a => [a.closest('.cd').dataset.id, new URL(a.href).searchParams.toString()])")
        for cid, q in links:
            d0 = next(c for c in REAL["candidates"] if c["id"] == cid)["detections"][0]
            assert "target=" not in q and f"ra={d0['ra']:.4f}" in q and f"cand={cid}" in q, (cid, q)
        assert await pg.evaluate(SIDEWAYS) <= 0, "sideways scroll on the real Candidates page"
        await shot("real")

    # ---- sample: every verdict in its group (the Comets list's headings, with counts), the check banner ----
    await pg.goto(BASE + "/candidates.html?sample=1"); await pg.wait_for_selector(".cd")
    assert await pg.is_visible("#c-sample"), "sample data is not labelled"
    ORDER = ["worth_reporting", "known", "glitch", "star"]
    ids = await pg.eval_on_selector_all(".cd", "e => e.map(x => [x.dataset.id, x.dataset.verdict])")
    assert ids == [[c["id"], c["verdict"]] for v in ORDER for c in CANDS if c["verdict"] == v], f"cards {ids}"
    assert {v for _, v in ids} == VERDICTS
    groups = await pg.evaluate("""() => [...document.querySelectorAll('.c-group')].map(g => { const h = g.querySelector('.sec'), cs = getComputedStyle(h);
        return [g.dataset.v, h.textContent, +h.querySelector('.n').textContent, g.querySelectorAll('.cd').length, cs.borderTopStyle, cs.borderTopColor, !!h.querySelector('i.g')]; })""")
    names = {"worth_reporting": "Worth reporting", "known": "Known", "glitch": "Glitch", "star": "Star"}
    want = [v for v in ORDER if any(c["verdict"] == v for c in CANDS)]
    assert [g[0] for g in groups] == want, groups
    for v, text, n, k, style, colour, dot in groups:
        assert text.startswith(names[v]) and n == k == sum(c["verdict"] == v for c in CANDS) and style == "solid" and colour == "rgb(255, 255, 255)" and dot, (v, text, n, k, style, colour, dot)
    v = SAMPLE["validation"]; check = await pg.text_content("#c-check")
    assert f"{v['known_recovered']} of {v['known_expected']}" in check and f"{round(v['planted_found'] * 100)}%" in check and str(v["false_per_sqdeg"]) in check, check
    c0 = CANDS[0]; card = await pg.text_content(f".cd[data-id='{c0['id']}']")
    assert f"{c0['checks']['n_photos']} of {c0['checks']['n_total']} photos" in card and c0["track"]["distance_guess"] in card, card
    assert await pg.evaluate(f"document.querySelector(\".cd[data-id='{c0['id']}'] img\").naturalWidth") > 0, "strip did not load"
    assert await pg.evaluate(SIDEWAYS) <= 0, "sideways scroll on the Candidates page"
    # one name field for the whole page (hidden while signed in, as here), never one per card
    assert await pg.locator(".cv-nick").count() == 1 and await pg.locator(".cd .cv-nick").count() == 0, "a name field per card"
    if phone:
        small = await pg.evaluate("""() => [...document.querySelectorAll('.cd .cv-b, .cd .cd-open')]
          .filter(e => { const r = e.getBoundingClientRect(); return r.height < 44 || r.width < 44; }).map(e => e.textContent.trim().slice(0, 20))""")
        assert not small, f"tap targets under 44 px: {small}"
    await pg.evaluate("scrollTo(0, 0)"); await shot("sample")
    await pg.locator(".c-grid").first.scroll_into_view_if_needed(); await pg.wait_for_timeout(900); await shot("sample-cards")

    # ---- votes post locally (Turnstile's test key passes) ----
    await pg.wait_for_function("document.querySelector('[name=cf-turnstile-response]')?.value", timeout=20000)
    await pg.click(f".cd[data-id='{c0['id']}'] .cv-b[data-tag=asteroid]")
    await pg.wait_for_function(f"document.querySelector(\".cd[data-id='{c0['id']}'] .cvote\").dataset.voted", timeout=10000)
    thread = await pg.evaluate(f"document.querySelector(\".cd[data-id='{c0['id']}'] .cvote\").dataset.voted")
    got = json.load(urllib.request.urlopen(f"{BASE}/api/comets/{thread}"))
    assert any(m["tag"] == "asteroid" and c0["id"] in m["body"] and m["author"] == "cand tester" for m in got["comments"]), got["comments"][-3:]

    # ---- Explore: one marker per worth-reporting candidate at its first detection ----
    await pg.goto(BASE + "/explore.html?sample=1"); await pg.wait_for_selector(".mk.cand i")
    await pg.wait_for_timeout(1200)   # the map's scale-in
    places = await pg.evaluate("""async () => { const { fwd } = await import('/skymap.js'), w = document.querySelector('.map-wrap').getBoundingClientRect();
      return [...document.querySelectorAll('.mk.cand')].map(m => { const r = m.querySelector('i').getBoundingClientRect();
        return [m.dataset.cand, (r.left + r.width / 2 - w.left) / w.width, (r.top + r.height / 2 - w.top) / w.height]; }); }""")
    assert [p_[0] for p_ in places] == [c["id"] for c in WORTH], places
    for cid, u, vv in places:
        d = next(c for c in WORTH if c["id"] == cid)["detections"][0]
        eu, ev = await pg.evaluate(f"import('/skymap.js').then(m => m.fwd({d['ra']}, {d['dec']}))")
        assert abs(u - eu) < .01 and abs(vv - ev) < .01, f"{cid} at {u:.4f},{vv:.4f}, fwd says {eu:.4f},{ev:.4f}"
    await pg.evaluate("document.getElementById('ly-cand').click()")
    assert await pg.locator(".mk.cand i:visible").count() == 0, "Layers toggle does not hide the markers"
    await pg.evaluate("document.getElementById('ly-cand').click()")
    mk = pg.locator(f".mk.cand[data-cand='{c0['id']}'] i")
    if phone:
        await mk.tap(force=True); await pg.wait_for_selector("#csheet:not([hidden])")
        assert await pg.text_content("#csheet [data-f=name]") == c0["id"] and await pg.text_content("#csheet [data-f=openlabel]") == "Investigate"
        when = await pg.text_content("#csheet [data-f=when]")
        assert f"{c0['checks']['n_photos']} of {c0['checks']['n_total']} photos" in when, when
        full = await pg.text_content("#csheet [data-f=facts]")
        assert c0["track"]["distance_guess"] in full, full
        assert c0["strip"] in (await pg.get_attribute("#csheet [data-f=thumb]", "src") or ""), "the peek sheet lacks the evidence strip"
        go = await pg.get_attribute("#csheet [data-f=open]", "href")
    else:
        # no candidate's name covers another name on the map (the declutter hides it instead)
        await pg.wait_for_timeout(2200)
        bad = await pg.evaluate("""() => { const box = b => b.getBoundingClientRect(), on = b => b.offsetParent && getComputedStyle(b).display !== 'none' && box(b).width;
          const cand = [...document.querySelectorAll('.mk.cand b')].filter(on), rest = [...document.querySelectorAll('#marks .mk b')].filter(on);
          return cand.flatMap(c => rest.filter(o => o !== c).filter(o => { const a = box(c), r = box(o); return a.left < r.right && r.left < a.right && a.top < r.bottom && r.top < a.bottom; })
            .map(o => c.textContent + ' over ' + o.textContent)); }""")
        assert not bad, f"candidate names overlap: {bad}"
        # opening a candidate's card closes the comet card
        await pg.evaluate("document.getElementById('card-comet').hidden = false")
        await mk.click(force=True); await pg.wait_for_selector("#card-cand:not([hidden])")
        assert await pg.text_content("#card-cand [data-f=id]") == c0["id"]
        assert await pg.evaluate("document.getElementById('card-comet').hidden"), "the comet card stayed open under the candidate's card"
        # square, opaque: no rounded corners, a solid background behind Investigate
        cs = await pg.evaluate("(() => { const c = getComputedStyle(document.getElementById('card-cand')), b = getComputedStyle(document.querySelector('#card-cand .btn')); return [c.borderTopLeftRadius, c.borderBottomRightRadius, b.backgroundColor, b.borderTopLeftRadius]; })()")
        assert cs == ["0px", "0px", "rgb(0, 0, 0)", "0px"], cs
        go = await pg.get_attribute("#card-cand [data-f=go]", "href")
    await shot("explore")
    assert f"cand={c0['id']}" in go and "sample=1" in go, go

    # ---- the time-lapse: the track, and the ring on this visit's detection ----
    go = urllib.parse.urljoin(BASE + "/", go)
    await pg.goto(go)
    await pg.wait_for_function("window.__cand?.ring && window.__lapse?.state.m", timeout=20000)
    s = await pg.evaluate("""() => { const st = window.__lapse.state, m = st.m, f = m.frames[st.i], c = document.getElementById('patch');
      return { ra: m.ra, dec: m.dec, G: m.grid, a: m.arcsec_per_pixel, fov: st.fov, W: c.width, H: c.height, cw: c.getBoundingClientRect().width,
        start: f.start, end: f.end || f.start, mjd: f.mjd, ring: window.__cand.ring, n: window.__cand.track.length }; }""")
    assert s["n"] == len(c0["detections"]), "not every detection is on the track"
    # sample data says so: its own title, no Discovered/Undiscovered claim, the baked star's name nowhere; Candidates lit in the nav
    head = await pg.evaluate("[document.getElementById('pv-name').textContent, document.title, document.querySelector('.cand-info').textContent, document.querySelector('.topbar nav a.on')?.textContent, getComputedStyle(document.getElementById('state')).display]")
    assert head[0] == f"Sample candidate {c0['id']}" and head[1].startswith(f"Sample candidate {c0['id']}"), head
    assert "Sample data" in head[2] and head[3] == "Candidates" and head[4] == "none", head
    assert c0["region"] not in head[0] + head[1], head
    t0, t1 = mjd(s["start"]), mjd(s["end"]) + 1
    near = sorted([d for d in c0["detections"] if t0 <= d["t"] < t1], key=lambda d: abs(d["t"] - s["mjd"]))
    assert near, f"the visit on screen ({s['start']}) has none of the candidate's detections"
    G, a = s["G"], s["a"]; cw = min(G, max(2, round(s["fov"] * 60 / a))); ch = min(G, max(2, round(cw * s["H"] / s["W"])))
    e, n = offset(s["ra"], s["dec"], near[0]["ra"], near[0]["dec"])
    x, y = (G - 1) / 2 - e / a, (G - 1) / 2 + n / a
    ex, ey = (x - (G - cw) / 2 + .5) * s["W"] / cw, (G - 1 - y - (G - ch) / 2 + .5) * s["H"] / ch
    k = s["cw"] / s["W"]   # canvas pixels to CSS pixels
    off = math.hypot(s["ring"][0] - ex, s["ring"][1] - ey) * k
    assert off <= 1, f"ring {off:.2f} px from the detection"
    rgb = await pg.evaluate(f"[...document.getElementById('patch').getContext('2d').getImageData({round(s['ring'][0] + 13)}, {round(s['ring'][1])}, 1, 1).data]")
    assert rgb[0] > 180 and 100 < rgb[1] < 200 and rgb[2] < 140, f"no orange ring drawn there: {rgb}"
    await pg.locator(".cand-info").scroll_into_view_if_needed()
    await shot("timelapse")
    # and a vote from the time-lapse
    await pg.wait_for_function("document.querySelector('[name=cf-turnstile-response]')?.value", timeout=20000)
    # the address keeps the candidate, so a reload draws the track again
    q = await pg.evaluate("location.search")
    assert f"cand={c0['id']}" in q and "sample=1" in q, f"the address dropped the candidate: {q}"
    # the candidate and its votes head Descriptions: every button in view without scrolling Descriptions
    hid = await pg.evaluate("""() => [...document.querySelectorAll('.cvote .cv-b')].filter(b => { const r = b.getBoundingClientRect(), s = b.closest('.pv-scroll')?.getBoundingClientRect();
        return r.top < 0 || r.bottom > innerHeight || !r.height || (s && (r.top < s.top || r.bottom > s.bottom)); }).map(b => b.textContent)""")
    assert not hid, f"vote buttons need scrolling: {hid}"
    # "Star" is stored as the tag star
    await pg.click(".cvote .cv-b[data-tag=star]")
    await pg.wait_for_function("document.querySelector('.cvote').dataset.voted", timeout=10000)
    thread = await pg.evaluate("document.querySelector('.cvote').dataset.voted")
    got = json.load(urllib.request.urlopen(f"{BASE}/api/comets/{thread}"))
    assert got["tags"]["star"] >= 1 and any(m["tag"] == "star" and m["author"] == "cand tester" for m in got["comments"]), got["tags"]
    await pg.reload(); await pg.wait_for_function("window.__cand?.ring", timeout=20000)
    for path in [go, BASE + "/explore.html?sample=1"]:
        await pg.goto(path); await pg.wait_for_timeout(800)
        assert await pg.evaluate(SIDEWAYS) <= 0, f"sideways scroll on {path}"
    assert not errs, errs
    await b.close()
    print(f"{name}: ok (ring {off:.2f} px off)")

async def main():
    if SHOTS: SHOTS.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        await run(p, "desktop", {"viewport": {"width": 1440, "height": 900}})
        await run(p, "phone", {"viewport": {"width": 390, "height": 844}, "has_touch": True, "is_mobile": True, "device_scale_factor": 3})
    print("candidates_ui: all checks passed")

asyncio.run(main())
