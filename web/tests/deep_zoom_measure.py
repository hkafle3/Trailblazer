"""Explore's deep zoom, the numbers: sharpness, how fast a stopped view fills, smoothness and data (the plan's checks 1, 4, 5).
Desktop is 1440 x 900 at DPR 2 and the phone is 390 x 844 at DPR 3 with the CPU slowed 4x, in headless Chrome with the GPU on.
Widths are CSS px; the deepest is 90600 / devicePixelRatio.
  1 sharpness   the tile picture alone over Barnard's Star at 20,000 / dpr: its Laplacian variance is at least 5x that of
                data/sky.jpg drawn at the same view
  1 fill        at the deepest width, from a cold start, 95% of the window is covered by tiles of the view's order within 3 s
  4 smoothness  an 8 s flight from the whole sky to the deepest width, a 2 s rest while tiles arrive, a 6 s pan with a short
                rest every second, a 2 s rest: 95% of frames within 17 ms, none over 50 ms
  5 data        at most 3 MB of tiles for a settled deepest view on the phone; at most 20 MB over the whole desktop run above
With DZ_NO_DIVE_WARMUP=1 the dive's load-ahead at the deepest zoom (explore-dive.js: sky cutouts and the time-lapse page) is
switched off, to tell its cost from the map's own.
Run: uv run -q --with playwright python web/tests/deep_zoom_measure.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, json, os, sys, urllib.request
from playwright.async_api import async_playwright
import deep_zoom_ui as T
from deep_zoom_ui import check, go, settled, open_page, STARS

SHARP = """async ([ra, dec]) => { const { v, d, s } = await __dz(), cv = document.querySelector('canvas.hips'), img = document.querySelector('img.sky'), n = 512, dpr = devicePixelRatio;
  const lap = g => { const p = g.getImageData(0, 0, n, n).data, at = (i, j) => p[(j * n + i) * 4]; let a = 0, b = 0, m = 0;
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) { const l = 4 * at(i, j) - at(i - 1, j) - at(i + 1, j) - at(i, j - 1) - at(i, j + 1); a += l; b += l * l; m++; }
    return b / m - (a / m) ** 2; };
  const ctx = () => Object.assign(document.createElement('canvas'), { width: n, height: n }).getContext('2d', { willReadFrequently: true });
  d.redraw(); const a = ctx(); a.drawImage(cv, cv.width / 2 - n / 2, cv.height / 2 - n / 2, n, n, 0, 0, n, n);
  // the same patch of sky.jpg: the middle of the window is map fraction (u, v); n device px are n / (W dpr) of the map's width
  const [u, vv] = s.fwd(ra, dec), du = n / (v.W * dpr), dv = n / (v.W * dpr / 2), b = ctx(); b.imageSmoothingQuality = 'high';
  b.drawImage(img, (u - du / 2) * img.naturalWidth, (vv - dv / 2) * img.naturalHeight, du * img.naturalWidth, dv * img.naturalHeight, 0, 0, n, n);
  return { tiles: lap(a), sky: lap(b), W: v.W }; }"""
FLIGHT = """async ([ra, dec]) => { const { v, d, s, k } = await __dz(); if (__wide()) k.flyTo(ra, dec, 1); v.cancel();
  const [u, vv] = s.fwd(ra, dec), cx = v.A.w / 2, cy = (v.A.t + v.A.b) / 2, w0 = v.A.min, w1 = v.MAXW, fr = [], b0 = d.stats.bytes, n0 = d.stats.loaded;
  const run = (ms, fn) => new Promise(done => { const t0 = performance.now(); let last = 0;   // frame times are the browser's own (requestAnimationFrame's clock)
    const f = t => { const q = Math.min(1, (performance.now() - t0) / ms); if (last) fr.push(t - last); last = t; fn(q); q < 1 ? requestAnimationFrame(f) : done(); }; requestAnimationFrame(f); });
  await run(8000, q => { const w = w0 * (w1 / w0) ** q; v.set(w, cx - u * w, cy - vv * w / 2); });
  const reached = v.W; await run(2000, () => {});
  const X0 = v.X, Y0 = v.Y, far = v.A.w * 2;
  await run(6000, q => { const seg = Math.min(5, Math.floor(q * 6)), p = (seg + Math.min(1, (q * 6 - seg) / .8)) / 6; v.set(v.W, X0 - p * far, Y0 + p * far * .4); });   // six moves, a 0.2 s rest after each
  await run(2000, () => {});
  return { fr, reached, max: v.MAXW, bytes: d.stats.bytes - b0, loaded: d.stats.loaded - n0, covered: d.state().covered }; }"""
WARM = "cutouts(round4(s[0]), round4(s[1])); prepare();"
async def no_warmup(pg):
    if not os.environ.get("DZ_NO_DIVE_WARMUP"): return
    async def handle(route):
        r = await route.fetch(); src = await r.text(); assert WARM in src, "explore-dive.js changed"
        await route.fulfill(response=r, body=src.replace(WARM, ""))
    await pg.route("**/explore-dive.js", handle)
def pct(a, p): a = sorted(a); return a[min(len(a) - 1, int(len(a) * p / 100))]

async def main():
    out = {}
    async with async_playwright() as p:
        b = await T.launch(p)
        for name, w, h, dpr, phone in (("desktop", 1440, 900, 2, False), ("phone", 390, 844, 3, True)):
            # 1: sharpness
            pg = await open_page(b, w, h, dpr, phone); v = await go(pg, "Barnard", 20000 / dpr); await settled(pg)
            s = await pg.evaluate(SHARP, list(STARS["Barnard"])); ratio = s["tiles"] / s["sky"]
            check(ratio >= 5 and abs(v["W"] - 20000 / dpr) < 1, f"sharpness ({name})", f"at {round(v['W'])} CSS px the tile picture's Laplacian variance is {s['tiles']:.0f} against {s['sky']:.1f} for sky.jpg: {ratio:.0f}x (5x needed)")
            await pg.context.close()
            # 1: a stopped view fills (cold), and 5: what one deepest view costs
            pg = await open_page(b, w, h, dpr, phone); v = await go(pg, "Orion"); s = await settled(pg, 10000)
            check(not s.get("timeout") and s["ms"] <= 3000 and v["W"] == v["MAXW"], f"fill ({name})", f"at {round(v['W'])} CSS px (the deepest, order {s['order']}) {s['covered']:.0%} covered {s['ms']} ms after stopping, {s['loaded']} tiles, {s['bytes'] / 1e6:.2f} MB (3 s allowed)")
            if phone: check(s["bytes"] <= 3e6, "data, one deepest view (phone)", f"{s['bytes'] / 1e6:.2f} MB in {s['loaded']} tiles (3 MB allowed)")
            out[name + "_fill"] = dict(ms=s["ms"], tiles=s["loaded"], MB=round(s["bytes"] / 1e6, 2), order=s["order"], W=v["W"])
            await pg.context.close()
            # 4: smoothness, and 5: data over the run
            pg = await open_page(b, w, h, dpr, phone, less_motion=False, before=no_warmup)
            if phone: await (await pg.context.new_cdp_session(pg)).send("Emulation.setCPUThrottlingRate", dict(rate=4))
            r = await pg.evaluate(FLIGHT, list(STARS["Barnard"])); fr = r["fr"]; p95 = pct(fr, 95); worst = max(fr)
            check(p95 <= 17 and worst <= 50 and abs(r["reached"] - r["max"]) < .5, f"smoothness ({name}{', CPU 4x' if phone else ''})",
                  f"{len(fr)} frames over 18 s to {round(r['reached'])} CSS px: 95% within {p95:.1f} ms (17 allowed), worst {worst:.1f} ms (50 allowed), {sum(f > 25 for f in fr)} over 25 ms; {r['loaded']} tiles arrived on the way")
            if not phone: check(r["bytes"] <= 20e6, "data, zoom and pan (desktop)", f"{r['bytes'] / 1e6:.2f} MB over the 18 s run (20 MB allowed)")
            check(not pg.errs, f"no page errors ({name})", str(pg.errs[:3]))
            out[name + "_run"] = dict(frames=len(fr), p50=round(pct(fr, 50), 2), p95=round(p95, 2), p99=round(pct(fr, 99), 2), worst=round(worst, 1), over25=sum(f > 25 for f in fr), MB=round(r["bytes"] / 1e6, 2), tiles=r["loaded"])
            await pg.context.close()
        await b.close()
    print(json.dumps(out)); print("ALL PASS" if not T.fails else f"{len(T.fails)} FAILED: {T.fails}"); sys.exit(1 if T.fails else 0)
asyncio.run(main())
