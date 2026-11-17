"""Browser check that a one-exposure detector flash does not reach the time-lapse (live/pipeline.js combine), in headless
Chrome. Needs the app up and the network (IRSA, NASA's S3 copy of SPHEREx); takes several minutes.
Run: uv run -q --with playwright python web/tests/flash_ui.py [base url] [baseline url] [shots dir]
- Ed's spot (RA 7.6317, Dec +15.7040, D1): exposure 2026W01_2A_0524_3 holds a flash at RA 7.63355, Dec +15.70797 that no
  other exposure has. Its visit's frame must show nothing there: the peak within 20" under 3 sigma of the sky around it,
  or no higher than ordinary sky of the same frame: 10% or more of 72 spots around read as high (before the fix: 5781
  sigma). With a baseline: the brightest star of
  that frame keeps the light of its two exposures' mean (the frame before the fix) within 5%.
- Barnard's Star: found in every visit and the measured motion agrees with Gaia within 20% (recenter_ui's rule).
- C/2024 J3 (ATLAS), two visits opened at the comet's time (comet.js visit pills): the comet stands out at the centre
  (peak within 10\" at 5 sigma or more).
With a baseline url (the same app before the change), each number is also compared side by side: Barnard's light in each
visit at least 80% of before (and the same saturated core), the comet's peak within 20% of before, and Barnard's build time within 10% of before
(median of 5 builds each, alternating, after one warm-up build each so IRSA's answers are cached on both)."""
import asyncio, math, pathlib, re, statistics, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
BEFORE = sys.argv[2] if len(sys.argv) > 2 else None
SHOTS = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else None
D2R, PIX = math.pi / 180, 5.0
ED = "ra=7.6317&dec=15.7040&det=D1"
FLASH, FLASH_T = (7.63355, 15.70797), 61044.0601   # where and when (MJD) the flash is
BARNARD = "ra=269.4463&dec=4.7671&det=D1"
J3 = ["ra=305.6895&dec=17.7581&det=D1&t=61154.9044", "ra=305.7581&dec=23.3361&det=D1&t=61173.7113"]   # known_photos_ui's visits 2 and 3
fails = []


def check(ok, msg):
    print(("PASS " if ok else "FAIL ") + msg)
    if not ok: fails.append(msg)


def peak_snr(m, f, ra, dec, r_in=20):
    """peak within r_in arcsec of (ra, dec) over the sky ring 30 to 80 arcsec around it, in sigma (1.4826 MAD)"""
    G, c0 = m["grid"], (m["grid"] - 1) / 2
    east, north = (ra - m["ra"]) * 3600 * math.cos(m["dec"] * D2R), (dec - m["dec"]) * 3600
    cx, cy = c0 - east / PIX, c0 - north / PIX   # column, and row with row 0 north
    inner, ring = [], []
    for r in range(G):
        for c in range(G):
            v, d = f["px"][r * G + c], math.hypot(c - cx, r - cy) * PIX
            if v is None or not math.isfinite(v): continue
            if d <= r_in: inner.append(v)
            elif 30 <= d <= 80: ring.append(v)
    med = statistics.median(ring); sig = 1.4826 * statistics.median(abs(v - med) for v in ring)
    return (max(inner) - med) / sig if inner else float("nan")


def aperture(m, f, cx, cy):   # (light within 4 grid pixels of column cx, row cy (row 0 north) minus the sky 8 to 16 out; NaN cells)
    G, inner, ring, nan = m["grid"], [], [], 0
    for r in range(G):
        for c in range(G):
            d, v = math.hypot(c - cx, r - cy), f["px"][r * G + c]
            if d < 4:
                if v is None: nan += 1
                else: inner.append(v)
            elif 8 <= d <= 16 and v is not None: ring.append(v)
    sky = statistics.median(ring)
    return sum(v - sky for v in inner), nan


def star_light(m, f):   # (light within 4 grid pixels of where the source was measured, minus the sky; saturated pixels)
    G, inner, ring, sat = m["grid"], [], [], 0
    for r in range(G):
        for c in range(G):
            d, v = math.hypot(c - f["x"], G - 1 - r - f["y"]), f["px"][r * G + c]
            if d < 4: (inner.append(v) if v is not None else None); sat += d < 4 and v is None
            elif 8 <= d <= 16 and v is not None: ring.append(v)
    sky = statistics.median(ring)
    return sum(v - sky for v in inner), sat


async def build(b, base, q, shot=None):
    """open the time-lapse at q on base; (manifest, seconds to build)"""
    ctx = await b.new_context(viewport={"width": 1440, "height": 900})
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1'); localStorage.setItem('ch.adv', '1') } catch {}")
    pg = await ctx.new_page(); errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
    await pg.goto(f"{base}/timelapse.html?{q}")
    await pg.wait_for_function("__lapse.state.m?.key?.startsWith('live') && /visits, built/.test(document.getElementById('status')?.textContent || '')", timeout=300000)
    secs = float(re.search(r"built in ([\d.]+) s", await pg.text_content("#status")).group(1))   # the build's own time, as the page says
    m = await pg.evaluate("""() => { const m = __lapse.state.m; return { ra: m.ra, dec: m.dec, grid: m.grid, motion: m.motion && m.motion.total,
      gaia: m.gaia && m.gaia.total, frames: m.frames.map(f => ({ px: Array.from(f.px, v => Number.isFinite(v) ? v : null), x: f.x, y: f.y,
      snr: f.snr === Infinity ? 1e9 : f.snr, epochs: f.epochs, at_t: !!f.at_t, exposures: f.exposures })) } }""")
    if shot:
        n = next((k for k, f in enumerate(m["frames"]) if any(abs(e - FLASH_T) < 0.01 for e in f["epochs"])), None) if "7.6317" in q else None
        if n is not None:   # the flash's visit
            await pg.focus("#play"); await pg.keyboard.press("Home")
            for _ in range(n): await pg.keyboard.press("ArrowRight")
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=str(shot))
    assert not errors, errors
    await ctx.close()
    return m, secs


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        sides = [("after", BASE)] + ([("before", BEFORE)] if BEFORE else [])
        res = {}
        for name, base in sides:
            shot = (lambda w: SHOTS / f"{name}-{w}.png") if SHOTS else (lambda w: None)
            ed, _ = await build(b, base, ED, shot("ed-spot"))
            bar, _ = await build(b, base, BARNARD, shot("barnard"))   # also the warm-up build for the timing below
            j3 = [(await build(b, base, q))[0] for q in J3]
            res[name] = (ed, bar, j3)
        ed, bar, j3 = res["after"]

        fr = [f for f in ed["frames"] if any(abs(e - FLASH_T) < 0.01 for e in f["epochs"])]
        check(len(fr) == 1, f"Ed's spot: one frame holds the flash's exposure ({len(fr)})")
        s = peak_snr(ed, fr[0], *FLASH)
        was = f" (before: {peak_snr(res['before'][0], [f for f in res['before'][0]['frames'] if any(abs(e - FLASH_T) < 0.01 for e in f['epochs'])][0], *FLASH):.1f})" if BEFORE else ""
        # Under 3 sigma, or no brighter than ordinary sky of the same frame: the same measure at 72 spots 2, 3 and 4 arcmin
        # around, at least 10% of which read as high or higher. Where the flash was, the frame can use only the other
        # exposure, whose noise is sqrt(2) the noise of the two-exposure mean the sky ring is measured on: after the fix it
        # reads about 3.2, one cell of 0524_4 at about 2 sigma of its own noise.
        sky = sorted(peak_snr(ed, fr[0], ed["ra"] + r / 3600 * math.cos(a) / math.cos(ed["dec"] * D2R), ed["dec"] + r / 3600 * math.sin(a))
                     for r in (120, 180, 240) for a in [k * math.pi / 12 for k in range(24)])
        share = sum(v >= s for v in sky) / len(sky)
        check(s < 3 or share >= 0.1, f"Ed's spot: the flash's visit ({fr[0]['exposures']} exposures) peaks at {s:.1f} sigma within 20\" of it{was}; "
              f"sky 2-4' around: median {statistics.median(sky):.1f}, upper quartile {sky[53]:.1f}, {100 * share:.0f}% of 72 spots as high or higher")

        check(all(f["x"] is not None for f in bar["frames"]), f"Barnard: found in all {len(bar['frames'])} visits")
        check(bar["motion"] and bar["gaia"] and abs(bar["motion"] / bar["gaia"] - 1) <= 0.2, f"Barnard: motion {bar['motion'] and round(bar['motion'], 2)}\"/yr vs Gaia {bar['gaia'] and round(bar['gaia'], 2)}\"/yr")
        for k, m in enumerate(j3):
            s = peak_snr(m, next(f for f in m["frames"] if f["at_t"]), m["ra"], m["dec"], 10)
            check(s >= 5, f"J3 visit {k + 2}: the comet stands out at the centre of its visit, peak {s:.1f} sigma within 10\"")

        if BEFORE:
            ed0, bar0, j30 = res["before"]
            # the brightest star in the flash's visit, away from the flash: before the fix that frame was the mean of its
            # two exposures (a median of two), so its light then is the mean the new rule must keep, within 5%
            f0 = next(f for f in ed0["frames"] if any(abs(e - FLASH_T) < 0.01 for e in f["epochs"]))
            G, c0 = ed0["grid"], (ed0["grid"] - 1) / 2
            fx, fy = c0 - (FLASH[0] - ed0["ra"]) * 3600 * math.cos(ed0["dec"] * D2R) / PIX, c0 - (FLASH[1] - ed0["dec"]) * 3600 / PIX
            k = max((k for k in range(G * G) if f0["px"][k] is not None and math.hypot(k % G - fx, k // G - fy) > 8 and 8 < k % G < G - 9 and 8 < k // G < G - 9), key=lambda k: f0["px"][k])
            (la, na), (lb, nb) = aperture(ed, fr[0], k % G, k // G), aperture(ed0, f0, k % G, k // G)
            check(abs(la / lb - 1) <= 0.05, f"Ed's spot: the brightest star of the flash's visit (column {k % G}, row {k // G}) has {la:.0f} vs the two exposures' mean {lb:.0f} ({100 * (la / lb - 1):+.1f}%; NaN cells {na} vs {nb})")
            pk, pk0 = [star_light(bar, f) for f in bar["frames"]], [star_light(bar0, f) for f in bar0["frames"]]
            check(len(pk) == len(pk0) and all(a[0] >= 0.8 * c[0] and a[1] == c[1] for a, c in zip(pk, pk0)),
                  f"Barnard: (light, saturated pixels) per visit {[(round(a), n) for a, n in pk]} vs before {[(round(a), n) for a, n in pk0]}")
            for k, (m, m0) in enumerate(zip(j3, j30)):
                a, c = (peak_snr(x, next(f for f in x["frames"] if f["at_t"]), x["ra"], x["dec"], 10) for x in (m, m0))
                check(abs(a / c - 1) <= 0.2, f"J3 visit {k + 2}: SNR {a:.1f} vs before {c:.1f}")
            times = {"after": [], "before": []}
            for _ in range(5):
                for name, base in sides: times[name].append((await build(b, base, BARNARD))[1])
            ta, tb = statistics.median(times["after"]), statistics.median(times["before"])
            check(ta <= 1.1 * tb, f"Barnard build: {ta:.1f} s vs before {tb:.1f} s (median of {times})")
        await b.close()
    print("ALL PASS" if not fails else f"{len(fails)} FAILED")
    sys.exit(1 if fails else 0)


asyncio.run(main())
