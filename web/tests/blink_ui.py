"""Browser check for "Then and now" (E4 and E7 of the phase 2 plan), in Chrome. Needs the app up with the showcase
candidate seeded (C-0901, J053604.34-063439.0, its blink baked into R2 by bake/blink_bake.mjs) and a sparse-field
candidate (C-0902, RA 150.1 Dec +2.2) that is built live. Local and preview only: neither is in the production database.
  E4: the canvases are read back and decoded with the page's own stretch, then checked here, in numpy, by the
      reference's rules (build_v3.py): the crop is a sub-array of the wide frame, every gap is drawn as mask and none at
      the star, the frames differ, the star's ratio from pixels within 10% of the measured one, at least 10 unclipped
      field stars at 1 within 10%, and the star-masked backgrounds within 5% (median) and 10% (rms) of the range.
      Two display mutations (the old frame x1.15, W1's frames shown as W2) must fail the same checks.
  E7: warm success with the questions and credits; cold cache with IRSA down shows the old pictures unavailable; too few
      stars shows inconclusive; S3 down shows SPHEREx unavailable; a full live build of a non-showcase spot, timed; the
      time-lapse's third tab; no sideways scroll on a phone.
Run: uv run -q --with playwright --with numpy --with scipy python web/tests/blink_ui.py [base url] [screenshot dir]"""
import asyncio, base64, json, math, pathlib, sys, time
import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8811"
SHOTS = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else None
SHOW, SPARSE = "C-0901", "C-0902"
N, CROP, PIX, C0 = 361, 91, 2.0, 180
WANT = {"W2": 1.95, "W1": 1.41, "Ks": 1.11}   # the plan's showcase numbers (build_v3.py), within 5%
A = math.asinh(10)
fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

# ---------- E4, by the reference's rules ----------
READ = """() => { const b = document.querySelector('.blink[data-state=ok]'); const get = c => { const x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = ''; for (let i = 0; i < x.length; i += 8192) s += String.fromCharCode(...x.subarray(i, i + 8192)); return btoa(s); };
  return { crop: [...b.querySelectorAll('canvas.fr')].map(get), wide: [...b.querySelectorAll('canvas.wide')].map(get), drawn: window.__blink.drawn,
    report: window.__blink.results[window.__blink.drawn.band].report }; }"""
def rgba(s, n): return np.frombuffer(base64.b64decode(s), np.uint8).reshape(n, n, 4)
def decode(px, lo, hi):   # canvas (north up, east left) -> grid order (row iy from the south), NaN for the mask colour
    grey = (px[..., 0] == px[..., 1]) & (px[..., 1] == px[..., 2])
    v = np.sinh(px[..., 0] / 255 * A) / 10 * (hi - lo) + lo
    return np.where(grey, v, np.nan)[::-1]
def dphot(img, y, x, F):
    n = img.shape[0]; r, ri, ro = F / PIX, 2 * F / PIX, 3 * F / PIX
    yy, xx = np.mgrid[0:n, 0:n]; d = np.hypot(yy - y, xx - x)
    if ro > min(x, y, n - 1 - x, n - 1 - y) or not np.isfinite(img[d < ro]).all(): return None
    return float(np.sum(img[d < r] - np.median(img[(d >= ri) & (d < ro)])))
def bgmodel(img, smask):
    nb = N // 15; a = np.where(smask | ~np.isfinite(img), np.nan, img)[:nb * 15, :nb * 15].reshape(nb, 15, nb, 15)
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter('ignore'); blk = np.nanmedian(a, axis=(1, 3))
    blk[np.isfinite(a).mean(axis=(1, 3)) < 0.3] = np.nan
    w = np.isfinite(blk).astype(float); sm = gaussian_filter(np.nan_to_num(blk) * w, 1) / np.maximum(gaussian_filter(w, 1), 1e-6)
    c = (np.arange(N) + 0.5) / 15 - 0.5; cy, cx = np.meshgrid(c, c, indexing='ij')
    return map_coordinates(sm, [cy, cx], order=1, mode='nearest')
def base_checks(sub, gaps_ok, differ, Rd, rep, fr):
    return {"crop is a sub-array of the wide frame": sub, "every gap drawn as mask, none at the star": gaps_ok, "the frames differ": differ,
            f"star ratio from pixels {Rd:.3f} within 10% of {rep['lead_ratio']}": abs(Rd / rep['lead_ratio'] - 1) <= 0.10,
            f"{len(fr)} unclipped field stars, median {np.median(fr) if fr else float('nan'):.3f}": len(fr) >= 10 and abs(np.median(fr) - 1) <= 0.10}
def e4(snap, label):
    d, rep = snap["drawn"], snap["report"]; lo, hi, F = d["stretch"]["lo"], d["stretch"]["hi"], d["F"]
    crop = [rgba(s, CROP) for s in snap["crop"]]; wide = [rgba(s, N) for s in snap["wide"]]
    h0 = (N - CROP) // 2
    sub = all(np.array_equal(crop[f], wide[f][h0:h0 + CROP, h0:h0 + CROP]) for f in (0, 1))
    do, ds = (decode(c, lo, hi) for c in crop); dow, dsw = (decode(w, lo, hi) for w in wide)
    masked = [int((~np.isfinite(x)).sum()) for x in (do, ds)]
    yy, xx = np.mgrid[0:N, 0:N]; star = np.hypot(yy - C0, xx - C0) < 3 * F / PIX
    gaps_ok = masked == d["masked"] and np.isfinite(dow[star]).all() and np.isfinite(dsw[star]).all()
    differ = float(np.nanmean(np.abs(do - ds))) > 0
    a, b = dphot(ds, CROP // 2, CROP // 2, F), dphot(do, CROP // 2, CROP // 2, F); Rd = a / b if a is not None and b else float('nan')
    box = lambda im, q: np.nanmax(im[int(q['y']) - 2:int(q['y']) + 3, int(q['x']) - 2:int(q['x']) + 3])
    fr = []
    for q in d["quals"]:
        if max(box(dow, q), box(dsw, q)) >= 0.9 * hi: continue
        a, b = dphot(dsw, q['y'], q['x'], F), dphot(dow, q['y'], q['x'], F)
        if a is not None and b: fr.append(a / b)
    sm = np.unpackbits(np.frombuffer(base64.b64decode(d["smask"]), np.uint8), bitorder='little')[:N * N].reshape(N, N).astype(bool)
    bo, bs = bgmodel(dow, sm), bgmodel(dsw, sm); sl = slice(h0, h0 + CROP)
    dd = (bs - bo)[sl, sl]; rng = float(np.percentile(bs[sl, sl], 95) - np.percentile(bs[sl, sl], 5))
    to_grey = lambda v: np.round(255 * np.clip(np.arcsinh(np.clip((v - lo) / (hi - lo), 0, None) * 10) / A, 0, 1))
    gd = (bgmodel(to_grey(dsw), sm) - bgmodel(to_grey(dow), sm))[sl, sl]
    step = np.sinh(1 / 255 * A) / 10 * (hi - lo)   # one grey level at the floor
    if rng < step:   # the grain rule (Ks): both backgrounds sit at the stretch floor, flat; then compare in grey levels
        flat = abs(float(np.median(gd))) <= 1 and float(np.sqrt(np.mean(gd ** 2))) <= 1
        return {**base_checks(sub, gaps_ok, differ, Rd, rep, fr), f"background flat at the floor in both frames (range {rng:.2g} under one grey level): {np.median(gd):+.1f} / {np.sqrt(np.mean(gd ** 2)):.1f} grey levels": flat}
    md, rms = float(np.median(dd)) / rng, float(np.sqrt(np.mean(dd ** 2))) / rng
    res = {**base_checks(sub, gaps_ok, differ, Rd, rep, fr),
           f"background difference median {md:+.3f}, rms {rms:.3f} of the range ({np.median(gd):+.1f} / {np.sqrt(np.mean(gd ** 2)):.1f} grey levels)": abs(md) <= 0.05 and rms <= 0.10}
    return res

async def wait_state(pg, band, timeout=180000):
    await pg.wait_for_function(f"window.__blink?.results?.{band}?.state", timeout=timeout)
    return await pg.evaluate(f"window.__blink.results.{band}.state")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        async def ctx(w=1440, h=900, **kw):
            c = await b.new_context(viewport={"width": w, "height": h}, has_touch=w < 641, is_mobile=w < 641, **kw)
            await c.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
            return c
        shot = lambda pg, n: pg.screenshot(path=str(SHOTS / f"blink-{n}.png")) if SHOTS else asyncio.sleep(0)

        # ---- E7 warm: the showcase, baked; E4 on every band ----
        c = await ctx(); pg = await c.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(f"{BASE}/candidate.html?id={SHOW}")
        check(await wait_state(pg, "W2") == "ok", "showcase W2 shows the blink")
        await pg.wait_for_function("window.__blink.done === 'baked' && ['W2','W1','Ks'].every(b => window.__blink.results[b])")
        check(await pg.text_content("#c-id") == "J053604.34-063439.0", "the star lead is named by its position")
        by = await pg.text_content("#c-by")
        check("Reported by Ed" in by and "17 Nov 2026" in by and "2 others tagged it a star" in by, f"credit line: {by}")
        check("Star" in await pg.text_content("#c-status"), "status says Star, never Likely comet")
        await shot(pg, "1-warm")
        for band in ["W2", "W1", "Ks"]:
            await pg.click(f"#tn [data-band={band}]")
            await pg.wait_for_function(f"window.__blink.drawn.band === '{band}'")
            snap = await pg.evaluate(READ); rep = snap["report"]
            check(abs(rep["lead_ratio"] / WANT[band] - 1) <= 0.05, f"{band} ratio {rep['lead_ratio']} (plan {WANT[band]})")
            check(rep["passed"] and rep["expectation"], f"{band} every science and display check passes, and the showcase expectation: {[k for k, v in rep['checks'].items() if not v]}")
            for k, v in e4(snap, band).items(): check(v, f"E4 {band}: {k}")
            words = await pg.eval_on_selector_all("#tn .chk", "e => e.map(x => [x.textContent.trim(), x.dataset.g])")
            check(len(words) == 3 and all(any(ch.isdigit() for ch in g) for _, g in words), f"{band} three checks, each with its numbers: {[w for w, _ in words]}")
            big = await pg.text_content("#tn .res .big")
            check(f"{rep['lead_ratio']:.2f}×" in big, f"{band} result says {big.strip()}")
        await pg.click("#tn [data-band=W2]")
        words = [w for w, _ in await pg.eval_on_selector_all("#tn .chk", "e => e.map(x => [x.textContent.trim(), x.dataset.g])")]
        check(words == ["Nearby stars unchanged", "Grows with wavelength", "Same star, same spot"], f"the questions answered: {words}")
        cred = await pg.evaluate("document.querySelector('.credits').textContent")
        check(all(s in cred for s in ["Spectro-Photometer for the History of the Universe", "Jet Propulsion Laboratory", "Bock et al. 2026", "WISE", "2MASS", "IRSA", "SVO"]), "credits: SPHEREx's wording, WISE, 2MASS, IRSA, SVO")
        # the knob plays and pauses, a stop or the picture shows one frame, F flips
        await pg.click("#tn .knob"); f0 = await pg.evaluate("window.__blink.S.playing")
        await pg.click("#tn .stop[data-to='1']"); fr = await pg.evaluate("[window.__blink.S.playing, window.__blink.S.frame]")
        await pg.keyboard.press("f"); f2 = await pg.evaluate("window.__blink.S.frame")
        check(f0 is False and fr == [False, 1] and f2 == 0, "knob pauses, the 2025 stop shows SPHEREx, F flips back")
        check(not errs, f"no page errors: {errs[:2]}")
        await c.close()

        # ---- E4 mutations on the page: each must FAIL the displayed-pixel checks ----
        for name, kind in [("the old frame x1.15", "scale"), ("W1's frames shown as W2", "swap")]:
            c = await ctx(); pg = await c.new_page(); res_holder = {}
            async def on_result(route):
                r = await route.fetch(); j = await r.json(); res_holder['j'] = j
                if kind == "swap": j["bands"]["W2"]["frames"] = j["bands"]["W1"]["frames"]
                await route.fulfill(response=r, body=json.dumps(j))
            async def on_frames(route):
                r = await route.fetch(); buf = bytearray(await r.body())
                if kind == "scale":
                    while 'j' not in res_holder: await asyncio.sleep(0.05)
                    off, n = res_holder['j']["bands"]["W2"]["frames"]["ow"]
                    a = np.frombuffer(bytes(buf[off:off + 4 * n]), '<f4') * np.float32(1.15); buf[off:off + 4 * n] = a.astype('<f4').tobytes()
                await route.fulfill(response=r, body=bytes(buf))
            await pg.route("**/api/blink?*", on_result); await pg.route("**/frames.bin", on_frames)
            await pg.goto(f"{BASE}/candidate.html?id={SHOW}"); await wait_state(pg, "W2")
            await pg.wait_for_function("window.__blink.drawn.band === 'W2'")
            r = e4(await pg.evaluate(READ), "W2"); bad = [k for k, v in r.items() if not v]
            check(bool(bad), f"mutation '{name}' FAILS E4: {bad}")
            await c.close()

        # ---- E7 cold cache, IRSA down: no bake, no stored tiles, the Worker answering 503 ----
        c = await ctx(); pg = await c.new_page()
        await pg.route("**/api/blink?*", lambda r: r.fulfill(status=404, content_type="application/json", body='{"error":"no baked blink here"}'))
        await pg.route("**/api/oldsky?*", lambda r: r.fulfill(status=503, content_type="application/json", body='{"error":"older survey unavailable","reason":"IRSA HTTP 503"}'))
        await pg.goto(f"{BASE}/candidate.html?id={SHOW}")
        st = await wait_state(pg, "W2", 120000)
        txt = await pg.text_content("#tn")
        check(st == "old-unavailable" and "The old pictures are not available right now" in txt and "Older survey unavailable" in txt and await pg.locator("#tn [data-retry]").is_visible(),
              f"cold cache, IRSA down: {st}, says the old pictures are unavailable, offers Try again")
        await shot(pg, "2-irsa-down")
        await c.close()

        # ---- E7 SPHEREx S3 down (a spot built live) ----
        c = await ctx(); pg = await c.new_page()
        await c.route("https://nasa-irsa-spherex.s3.amazonaws.com/**", lambda r: r.abort())
        await pg.goto(f"{BASE}/candidate.html?id={SPARSE}")
        st = await wait_state(pg, "W2", 120000)
        check(st == "spherex-unavailable" and "The SPHEREx pictures are not available right now" in await pg.text_content("#tn"), f"S3 down: {st}")
        await shot(pg, "3-s3-down")
        await c.close()

        # ---- E7 a full live build of a non-showcase spot, timed; too few stars is inconclusive ----
        c = await ctx(); pg = await c.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        t0 = time.time(); await pg.goto(f"{BASE}/candidate.html?id={SPARSE}")
        await pg.wait_for_function("window.__blink?.done === 'live'", timeout=180000); took = time.time() - t0
        states = await pg.evaluate("Object.fromEntries(Object.entries(window.__blink.results).map(([k, v]) => [k, [v.state, v.reason, v.report?.qualified_stars]]))")
        print(f"   live build of {SPARSE}: {took:.1f} s, {states}")
        check(took < 30, f"full live build of a non-showcase spot in {took:.1f} s (under 30 s)")
        await pg.click("#tn [data-band=Ks]")
        txt = await pg.text_content("#tn")
        check(states["Ks"][0] == "inconclusive" and "Inconclusive" in txt and "clean comparison stars, 20 needed" in txt, f"too few stars: Ks {states['Ks']}")
        check(not await pg.locator("#tn .blink canvas").count(), "no blink without numbers")
        check(not errs, f"no page errors: {errs[:2]}")
        await shot(pg, "4-inconclusive")
        await c.close()

        # ---- the showcase built live in this browser (no bake): the same numbers as the bake and the reference ----
        c = await ctx(); pg = await c.new_page()
        await pg.route("**/api/blink?*", lambda r: r.fulfill(status=404, content_type="application/json", body='{"error":"no baked blink here"}'))
        t0 = time.time(); await pg.goto(f"{BASE}/candidate.html?id={SHOW}")
        await pg.wait_for_function("window.__blink?.done === 'live'", timeout=240000); took = time.time() - t0
        got = await pg.evaluate("Object.fromEntries(Object.entries(window.__blink.results).map(([k, v]) => [k, [v.state, v.report?.lead_ratio, v.report?.passed]]))")
        check(all(got[k][0] == "ok" and abs(got[k][1] / WANT[k] - 1) <= 0.05 and got[k][2] for k in WANT), f"showcase built live in the browser in {took:.1f} s: {got}")
        await c.close()

        # ---- the time-lapse's third tab ----
        c = await ctx(); pg = await c.new_page()
        await pg.goto(f"{BASE}/timelapse.html?ra=84.0181&dec=-6.5775&det=D6&blink={SHOW}&view=thenandnow")
        st = await wait_state(pg, "W2")
        check(st == "ok" and await pg.get_attribute("#tab-tn", "aria-selected") == "true" and await pg.text_content("#tn-name") == "J053604.34-063439.0"
              and (await pg.get_attribute("#tn-go", "href")).endswith(f"candidate.html?id={SHOW}"), "time-lapse: Then and now tab selected, the blink, All checks")
        await pg.click("#tab-photo"); check(await pg.locator("#tn-lapse").is_hidden() and await pg.get_attribute("#pv-name", "hidden") is None and await pg.locator("#tn-name").is_hidden()
              and await pg.locator("#patch").is_visible(), "Photo tab puts the time-lapse back")
        await c.close()

        # ---- phone ----
        c = await ctx(390, 844); pg = await c.new_page()
        await pg.goto(f"{BASE}/candidate.html?id={SHOW}"); await wait_state(pg, "W2")
        side = await pg.evaluate("Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth")
        check(side <= 0, f"phone: no sideways scroll ({side} px)")
        await c.close(); await b.close()
    print(f"{len(fails)} failed" if fails else "all passed")
    sys.exit(1 if fails else 0)
asyncio.run(main())
