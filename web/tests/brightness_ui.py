"""Browser check for the time-lapse's Brightness change card (the button at the end of Advanced). Needs the app up
(npm run dev). It uses the baked Barnard's Star patch and hands the card made-up results through its cache
(window.__bright), so it downloads no SPHEREx pictures; one check runs the real build with the catalogue route
answering 503, to see the "not answering" state come from the worker itself.
Run: uv run -q --with playwright python web/tests/brightness_ui.py [base url] [chromium executable]

At 1440 x 900 and 390 x 844 (touch):
- the button opens the card in the right column's place (the name, report and distances step aside on a desktop; on a
  phone it sits under the timeline, above Advanced), &bright=1 rides in the address and reopens it;
- it closes with its chevron, with the button again, and with Escape, and focus goes back to the button;
- one card at a time: Brightness closes Spectrum and Discuss, and each of them closes Brightness; Depth closes it;
- the table's "now" follows the visit on screen (the timeline's arrow keys), and the chart rings that pass;
- each state says what happened: no WISE source, too bright, SPHEREx has no pictures, a pass without enough
  wavelengths, a star not detected (its limit), a blend, NEOWISE with too few visits or not answering, the catalogue service not answering."""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
EXE = sys.argv[2] if len(sys.argv) > 2 else None
fails = []


def check(ok, msg):
    print(("PASS " if ok else "FAIL ") + msg)
    if not ok: fails.append(msg)


def canned(frames, **over):
    """A made-up result with one SPHEREx pass per visit of the patch (the numbers are not any real star's)."""
    sx = lambda m0: [{"mjd": f, "m": m0 - 0.1 * i, "e": 0.03, "n": 20} for i, f in enumerate(frames)]
    r = {"v": 1, "state": "ok", "reason": "", "star": {"name": "J000000.00+000000.0", "blend": 1, "ref": "CatWISE2020",
         "ref_mag": {"W1": [12.0, 0.02], "W2": [11.8, 0.02]}},
         "spherex": {"W1": sx(11.0), "W2": sx(11.5)},
         "neowise": {"state": "ok", "W1": [{"mjd": 56700 + 180 * k, "m": 12.0 + 0.02 * (k % 3), "e": 0.02, "n": 12} for k in range(20)]},
         "calibrators": 30, "screened": ""}
    r.update(over)
    return r


async def give(pg, res):
    """Opens the card on the patch on screen with this result (closed first, so it reads the cache again)."""
    await pg.evaluate("""res => { const b = __bright.bright, m = __lapse.state.m; if (b.on) __bright.close(false);
      b.cache.set(`${m.ra.toFixed(4)},${m.dec.toFixed(4)}`, res); b.key = null; __bright.open(); }""", res)
    await pg.wait_for_timeout(200)


async def read(pg):
    return await pg.evaluate("""() => ({ on: document.body.classList.contains('brighting'), shown: getComputedStyle(document.getElementById('bright')).display !== 'none',
      pressed: document.getElementById('bright-btn').getAttribute('aria-pressed'), url: location.search, focus: document.activeElement?.id,
      rows: [...document.querySelectorAll('#br-rows tr')].map(t => t.innerText.replace(/\\s+/g, ' ').trim()), tab: !document.getElementById('br-tab').hidden,
      status: document.getElementById('br-status').textContent, warn: document.getElementById('br-warn').hidden ? '' : document.getElementById('br-warn').textContent,
      note: document.getElementById('br-note').hidden ? '' : document.getElementById('br-note').textContent,
      chart: !document.getElementById('br-chart').hasAttribute('hidden'), sx: document.querySelectorAll('#br-chart circle.sx').length,
      neo: document.querySelectorAll('#br-chart circle.neo').length, wise: document.querySelectorAll('#br-chart line.wise').length, wiseM: document.querySelector('#br-chart line.wise')?.dataset.m ?? null,
      ring: document.querySelectorAll('#br-chart circle.ring').length, peak: document.querySelectorAll('#br-chart line.peak').length,
      key: document.getElementById('br-key').innerText.replace(/\\s+/g, ' ').trim(),
      who: getComputedStyle(document.querySelector('.pv-who')).display, spec: document.body.classList.contains('speccing'), talk: document.body.classList.contains('talking') })""")


async def run(p, w, h, phone):
    tag = "phone" if phone else "desktop"
    b = await p.chromium.launch(**({"executable_path": EXE} if EXE else {}))
    ctx = await b.new_context(viewport={"width": w, "height": h}, is_mobile=phone, has_touch=phone)
    await ctx.add_init_script("try { localStorage.setItem('ch.adv', '1') } catch {}")
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await pg.goto(BASE + "/timelapse.html?target=barnard")
    await pg.wait_for_function("window.__lapse && __lapse.state.m && window.__bright", timeout=120000)
    frames = await pg.evaluate("__lapse.state.m.frames.map(f => f.mjd)")
    res = canned(frames)

    # open with the button: the made-up result is in the cache for this spot
    await pg.evaluate("""res => { const m = __lapse.state.m; __bright.bright.cache.set(`${m.ra.toFixed(4)},${m.dec.toFixed(4)}`, res); }""", res)
    await pg.click("#bright-btn")
    await pg.wait_for_timeout(300)
    s = await read(pg)
    check(s["on"] and s["shown"] and s["pressed"] == "true" and "bright=1" in s["url"], f"{tag}: the button opens the card, pressed, &bright=1 in the address")
    check(s["rows"][0].startswith("3.4 µm 12.00 11.00") and "2.5× brighter" in s["rows"][0] and "−1.00 ± 0.04 mag" in s["rows"][0], f"{tag}: W1 row: WISE, now, the change in words and magnitudes ({s['rows'][0]})")
    check(s["rows"][1].startswith("4.6 µm 11.80 11.50") and "1.32× brighter" in s["rows"][1], f"{tag}: W2 row ({s['rows'][1]})")
    check(s["chart"] and s["sx"] == len(frames) and s["neo"] == 20 and s["wise"] == 1 and s["ring"] == 1 and s["peak"] == 1, f"{tag}: chart: the WISE segment, 20 NEOWISE visits, {len(frames)} SPHEREx passes, the visit ringed, NEOWISE's brightest line")
    check(s["wiseM"] == s["rows"][0].split()[2], f"{tag}: the chart's WISE segment is the table's 3.4 µm reference ({s['wiseM']})")
    check(s["key"] == "WISE 2010–18 NEOWISE SPHEREx" and not s["status"] and not s["note"], f"{tag}: three-item key, no sentence under it ({s['key']})")
    if phone:
        box = await pg.evaluate("() => ['tl', 'bright', 'adv-btn'].map(id => document.getElementById(id).getBoundingClientRect().top + scrollY)")
        check(box[0] < box[1] < box[2], f"phone: the card sits under the timeline, above Advanced ({box})")
    else:
        check(s["who"] == "none", "desktop: the name and verdict step aside while the card is open")
        cb = await pg.evaluate("() => { const r = document.getElementById('bright').getBoundingClientRect(), f = document.querySelector('.pv-frame').getBoundingClientRect(); return [r.left, f.right]; }")
        check(cb[0] > cb[1], "desktop: the card is in the right column")

    # "now" follows the visit on screen
    await pg.focus("#play")
    await pg.keyboard.press("End")
    await pg.wait_for_timeout(300)
    s2 = await read(pg)
    want = f"{11.0 - 0.1 * (len(frames) - 1):.2f}"
    check(f" {want} " in s2["rows"][0] + " ", f"{tag}: the last visit shows the last pass ({s2['rows'][0]})")
    rx = await pg.evaluate("() => +document.querySelector('#br-chart circle.ring').getAttribute('cx') > +document.querySelector('#br-chart circle.sx').getAttribute('cx')")
    check(rx, f"{tag}: the ring moved to the last pass")
    await pg.keyboard.press("Home")
    await pg.wait_for_timeout(200)

    # closing: chevron, button, Escape; focus back on the button
    await pg.click("#bright-close")
    s = await read(pg)
    check(not s["on"] and not s["shown"] and s["pressed"] == "false" and "bright=1" not in s["url"] and s["focus"] == "bright-btn", f"{tag}: the chevron closes it, focus on the button")
    await pg.click("#bright-btn"); await pg.click("#bright-btn")
    s = await read(pg)
    check(not s["on"] and s["focus"] == "bright-btn", f"{tag}: the button again closes it")
    await pg.click("#bright-btn"); await pg.keyboard.press("Escape")
    s = await read(pg)
    check(not s["on"] and s["focus"] == "bright-btn", f"{tag}: Escape right after opening (focus still on the button) closes it")
    await pg.click("#bright-btn")
    await pg.focus("#bright-close"); await pg.keyboard.press("Escape")
    s = await read(pg)
    check(not s["on"] and s["focus"] == "bright-btn", f"{tag}: Escape inside the card closes it, focus on the button")

    # one card at a time
    await pg.click("#bright-btn")
    await pg.evaluate("() => { const m = __lapse.state.m; __spec.open(m.ra, m.dec, 2026); }")
    await pg.wait_for_timeout(200)
    s = await read(pg)
    check(s["spec"] and not s["on"], f"{tag}: Spectrum closes Brightness")
    await pg.click("#bright-btn")
    s = await read(pg)
    check(s["on"] and not s["spec"], f"{tag}: Brightness closes Spectrum")
    await pg.evaluate("() => document.getElementById('state').click()")
    await pg.wait_for_timeout(500)
    s = await read(pg)
    if s["talk"]:
        check(not s["on"], f"{tag}: Discuss closes Brightness")
        await pg.click("#bright-btn") if not phone else await pg.evaluate("() => document.getElementById('bright-btn').click()")
        s = await read(pg)
        check(s["on"] and not s["talk"], f"{tag}: Brightness closes Discuss")
    else:
        check(False, f"{tag}: Report a new find did not open Discuss here")

    await pg.evaluate("() => document.getElementById('tab-depth').click()")
    await pg.wait_for_timeout(300)
    s = await read(pg)
    check(not s["on"], f"{tag}: Depth closes Brightness (its right column is Distances)")
    await pg.evaluate("() => document.getElementById('tab-photo').click()")
    await pg.wait_for_timeout(300)

    # the states
    async def state(name, res, test):
        await give(pg, res)
        st = await read(pg)
        check(test(st), f"{tag}: {name}: {json.dumps({k: st[k] for k in ('status', 'warn', 'note', 'rows', 'tab', 'chart')}, ensure_ascii=False)[:260]}")
    no = {"v": 1, "state": "no-star", "reason": "No WISE source within 3 arcsec of the middle of the photo"}
    await state("no WISE source", no, lambda s: s["status"].startswith("No WISE source within 3 arcsec") and not s["tab"] and not s["chart"])
    bright_ = canned(frames, state="too-bright", reason="SPHEREx saturates on this star in 40 of 44 pictures: it is too bright to measure cleanly. Fainter stars work.",
                     spherex={"W1": [{"mjd": f, "why": "too bright: SPHEREx saturates on it in 12 of 13 pictures"} for f in frames], "W2": [{"mjd": f, "why": "too bright"} for f in frames]})
    await state("too bright", bright_, lambda s: "too bright to measure cleanly" in s["status"] and not s["tab"] and s["chart"] and s["sx"] == 0 and s["neo"] == 20)
    await state("no SPHEREx pictures", {"v": 1, "state": "no-coverage", "reason": "SPHEREx has no pictures of this star at 3 to 5 µm"}, lambda s: "no pictures" in s["status"] and not s["tab"])
    part = canned(frames); part["spherex"]["W2"][0] = {"mjd": frames[0], "why": "not enough of the band measured"}
    await state("a pass without enough wavelengths", part, lambda s: "not enough of the band measured" in s["rows"][1] and "brighter" in s["rows"][0])
    faint = canned(frames); faint["spherex"]["W1"][0] = {"mjd": frames[0], "why": "not detected", "limit": 17.9}
    await state("not detected: a 3-sigma limit", faint, lambda s: s["rows"][0].startswith("3.4 µm 12.00 >17.90 not detected"))
    await state("blend", canned(frames, star={**res["star"], "blend": 2}, neowise={"state": "blend", "W1": []}), lambda s: s["warn"].startswith("2 WISE sources within 6″") and s["tab"] and s["wise"] == 1 and s["neo"] == 0)
    few = canned(frames, neowise={"state": "few", "W1": res["neowise"]["W1"][:2]})
    await state("too few NEOWISE visits", few, lambda s: "NEOWISE saw it on 2 visits only" in s["note"] and s["neo"] == 2 and s["peak"] == 0)
    await state("NEOWISE not answering", canned(frames, neowise={"state": "unavailable", "W1": []}), lambda s: "NEOWISE (IRSA) did not answer" in s["note"] and s["neo"] == 0 and s["tab"])
    await state("no pass near this visit", canned(frames, spherex={"W1": [{"mjd": 50000, "m": 11, "e": 0.03}], "W2": [{"mjd": 50000, "m": 11, "e": 0.03}]}), lambda s: "no SPHEREx pass near this visit" in s["rows"][0])

    # the real build, with the catalogue service down: the worker's own words
    await pg.evaluate("() => __bright.close(false)")
    await pg.route("**/api/cat?*", lambda r: r.fulfill(status=503, content_type="application/json", body='{"error":"catalogue unavailable"}'))
    await pg.evaluate("() => { __bright.bright.cache.clear(); __bright.bright.key = null; __bright.open(); }")
    await pg.wait_for_function("__bright.bright.res && !__bright.bright.busy", timeout=180000)
    s = await read(pg)
    check("NASA's catalogue service (IRSA) is not answering" in s["status"] and not s["tab"], f"{tag}: IRSA down, said by the worker ({s['status']})")
    await pg.unroute("**/api/cat?*")
    await pg.evaluate("() => __bright.close(false)")
    check(await pg.evaluate("() => __bright.bright.res === null && __bright.bright.key === null"), f"{tag}: an archive failure is not kept: reopening measures again")

    # progressive: the WISE column and NEOWISE first ('partial', no SPHEREx yet), then a pass at a time
    await pg.evaluate("() => { __bright.bright.cache.clear(); __bright.bright.key = null; __bright.open(); }")
    cur = await pg.evaluate("__bright.bright.id")
    loading = {**res, "state": "partial", "spherex": None, "neowise": {"state": "loading", "W1": []}}
    await pg.evaluate("([id, r]) => __bright.bright.worker.onmessage({ data: { id, type: 'partial', result: r } })", [cur, loading])
    s = await read(pg)
    check(s["tab"] and s["rows"][0].startswith("3.4 µm 12.00 measuring") and s["neo"] == 0 and not s["note"], f"{tag}: the WISE column before NEOWISE answers, with no note about it")
    first = {**res, "state": "partial", "spherex": None}
    await pg.evaluate("([id, r]) => __bright.bright.worker.onmessage({ data: { id, type: 'partial', result: r } })", [cur, first])
    s = await read(pg)
    check(s["tab"] and s["rows"][0].startswith("3.4 µm 12.00 measuring") and s["neo"] == 20 and s["wise"] == 1 and s["sx"] == 0, f"{tag}: first content: the WISE column and NEOWISE's history, SPHEREx measuring ({s['rows'][0]})")
    one = json.loads(json.dumps(res)); one["state"] = "partial"
    for band in ("W1", "W2"): one["spherex"][band] = [p if i == 0 else {"mjd": p["mjd"], "pending": True} for i, p in enumerate(one["spherex"][band])]
    await pg.evaluate("([id, r]) => __bright.bright.worker.onmessage({ data: { id, type: 'partial', result: r } })", [cur, one])
    s = await read(pg)
    check("2.5× brighter" in s["rows"][0] and s["sx"] == 1, f"{tag}: the visit on screen's pass fills in first ({s['rows'][0]})")
    await pg.evaluate("() => __bright.close(false)")

    # a stale answer: a build starts here, then the card moves to a result it already has; the old build's answer arrives
    # late and must be dropped, not shown or stored under the new spot
    await pg.evaluate("() => { __bright.bright.cache.clear(); __bright.bright.key = null; __bright.open(); }")
    old = await pg.evaluate("__bright.bright.id")
    await pg.evaluate("res => { const b = __bright.bright, m = __lapse.state.m; b.cache.set(`${m.ra.toFixed(4)},${m.dec.toFixed(4)}`, res); b.key = null; __bright.open(); }", res)
    await pg.evaluate("old => __bright.bright.worker.onmessage({ data: { id: old, type: 'result', result: { v: 1, state: 'no-star', reason: 'late' } } })", old)
    s = await read(pg)
    kept = await pg.evaluate("() => [...__bright.bright.cache.values()].every(r => r.state === 'ok')")
    check(s["tab"] and "late" not in s["status"] and kept, f"{tag}: a late answer from an earlier build is dropped")

    # &bright=1 reopens it
    await pg.evaluate("() => __bright.close(false)")
    await pg.goto(BASE + "/timelapse.html?target=barnard&bright=1")
    await pg.wait_for_function("window.__bright && __bright.bright.on && __lapse.state.m", timeout=120000)
    check(True, f"{tag}: &bright=1 opens the card on load")
    await pg.evaluate("() => __bright.close(false)")
    check(not errors, f"{tag}: no page errors {errors[:3]}")
    await b.close()


async def main():
    async with async_playwright() as p:
        await run(p, 1440, 900, False)
        await run(p, 390, 844, True)
    print("FAIL" if fails else "PASS", f"{len(fails)} failed")
    sys.exit(1 if fails else 0)

asyncio.run(main())
