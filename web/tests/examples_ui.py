"""Browser check that the examples a first visit lands on show something real. Needs the app up and the network (NASA's S3
copy of SPHEREx for the live photos); takes a few minutes.
Run: uv run -q --with playwright python web/tests/examples_ui.py [base url]   (default http://127.0.0.1:8787)
- Comet pages: the photo player's first frame is the clearest one. Live photos (C/2024 J3 (ATLAS), 235P/LINEAR): the
  highest-SNR Seen visit, orange ring. Baked photos (C/2025 R2 (SWAN)): the photo with the most light. 2P/Encke, seen in
  no visit: its brightest predicted visit, and a line saying SPHEREx could not see it and what the ring marks.
- Crops (live/cutout.js paint): a bright star whose core is masked (saturated) is drawn filled, with no black pixel in
  it; edges off the image stay black; the light measured on the same pixels is unchanged.
- Explore on the default day: the featured card's comet has a marker drawn and not dimmed, the card within 1% of it.
  Searching "3I/ATLAS" still puts 3I/ATLAS on the card."""
import asyncio, re, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
page = lambda cid: f"{BASE}/comet.html?id=" + urllib.parse.quote(cid, safe="")
# every frame the big player shows, in order: [index, ring class, playing]
WATCH = """window.__shown = [];
new MutationObserver(ms => { for (const m of ms) if (m.attributeName === 'data-i') { const p = m.target;
  window.__shown.push([+p.dataset.i, p.querySelector('.ring').className, p.dataset.playing === '1']); } })
  .observe(document, { subtree: true, attributes: true, attributeFilter: ['data-i'] });"""
DONE = "!/Building|Built/.test(document.querySelector('#c-photos-panel .frames-note')?.textContent ?? 'Building')"


async def ctx_for(b):
    ctx = await b.new_context(viewport={"width": 1440, "height": 900})
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
    await ctx.add_init_script(f"document.addEventListener('DOMContentLoaded', () => {{ {WATCH} }})")
    return ctx


async def live(b, cid, seen_expected):
    ctx = await ctx_for(b); pg = await ctx.new_page()
    await pg.goto(page(cid))
    await pg.wait_for_selector("#c-photos-panel:not([hidden])")
    await pg.locator("#c-photos-panel").scroll_into_view_if_needed()
    await pg.wait_for_function(DONE, timeout=300000)
    await pg.wait_for_timeout(300)
    figs = await pg.eval_on_selector_all("#c-photos figure", "fs => fs.map(f => [f.dataset.verdict, f.dataset.snr === '' || f.dataset.snr == null ? null : +f.dataset.snr])")
    shown = await pg.evaluate("window.__shown")
    note = await pg.text_content("#c-photos-panel .frames-note")
    assert shown, f"{cid}: the player showed nothing ({figs})"
    first = shown[0][0]
    seen = [k for k, (v, _) in enumerate(figs) if v == "seen"]
    if seen_expected:
        assert seen, f"{cid}: expected a Seen visit, got {figs}"
        best = max(seen, key=lambda k: figs[k][1])
        assert first == best and shown[0][1] == "ring", f"{cid}: opened on {shown[0]}, the clearest is {best} ({figs})"
        color = await pg.evaluate("getComputedStyle(document.querySelector('.player .ring')).borderTopColor")
        r, g, bl = [float(x) for x in re.findall(r"[\d.]+", color)[:3]]
        assert r > 200 and g < 200 and bl < 120, f"{cid}: ring colour {color} is not orange"
        print(f"  {cid}: opens on visit {first + 1} of {len(figs)} (SNR {figs[first][1]:.1f}, the highest), orange ring {color}")
    else:
        assert not seen, f"{cid}: expected no Seen visit, got {figs}"
        assert "could not see it" in note and "The ring shows where JPL says it was" in note, f"{cid}: note {note!r}"
        print(f"  {cid}: none seen, opens on visit {first + 1}; note: {note}")
    await ctx.close()


async def baked(b, cid):
    ctx = await ctx_for(b); pg = await ctx.new_page()
    d = (await (await ctx.request.get(BASE + "/api/comets/" + urllib.parse.quote(cid, safe=""))).json())["detail"]
    shots = sorted(d["photos"], key=lambda p: p["mjd"])
    best = max(range(len(shots)), key=lambda k: shots[k]["flux"])
    await pg.goto(page(cid))
    await pg.wait_for_selector(".player[data-i]")
    shown = await pg.evaluate("window.__shown")
    assert shown[0][0] == best and shown[0][1] == "ring", f"{cid}: opened on {shown[0]}, most light is photo {best}"
    print(f"  {cid}: opens on photo {best + 1} of {len(shots)} ({shots[best]['flux']:.0f} mJy, the most light)")
    await ctx.close()


CROP = """async () => {
  const { paint, starMeasure, R_OUT } = await import('/live/cutout.js');
  const G = 96, px = new Float32Array(G * G), c = 40;
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < G * G; k++) { const x = k % G, y = Math.floor(k / G);
    px[k] = 10 + rnd() + 4000 * Math.exp(-((x - c) ** 2 + (y - c) ** 2) / 8) + 300 * Math.exp(-((x - 70) ** 2 + (y - 20) ** 2) / 4); }
  for (let k = 0; k < G * G; k++) { const x = k % G, y = Math.floor(k / G);
    if (Math.hypot(x - c, y - c) <= 2.2) px[k] = NaN;   // the saturated core, masked
    if (x < 4) px[k] = NaN; }   // off the image: a strip at the edge
  // the measurement, on the star's window (as readCells gives it): the masked core is left out, before and after paint
  const W = 2 * (R_OUT + 1) + 1, h = (W - 1) / 2, win = Float64Array.from({ length: W * W }, (_, k) => px[(c - h + Math.floor(k / W)) * G + c - h + k % W]);
  const more = { flag: Array(W * W).fill(0), var: Array(W * W).fill(1) };
  const before = starMeasure(win, more, h, h), copy = Float32Array.from(px);
  const cv = document.createElement('canvas'); paint(cv, { px, grid: G });
  const d = cv.getContext('2d').getImageData(0, 0, G, G).data, grey = (x, y) => d[4 * (y * G + x)];
  const core = []; for (let y = c - 3; y <= c + 3; y++) for (let x = c - 3; x <= c + 3; x++) if (Math.hypot(x - c, y - c) <= 3) core.push(grey(x, y));
  const winAfter = Float64Array.from({ length: W * W }, (_, k) => px[(c - h + Math.floor(k / W)) * G + c - h + k % W]);
  return { core, edge: [grey(1, 50), grey(3, 10)], same: px.every((v, k) => Object.is(v, copy[k])),
    before: before.flux ?? before.gap, after: (r => r.flux ?? r.gap)(starMeasure(winAfter, more, h, h)) };
}"""


async def crop(b):
    ctx = await ctx_for(b); pg = await ctx.new_page()
    await pg.goto(BASE + "/comet.html")
    r = await pg.evaluate(CROP)
    assert min(r["core"]) > 200, f"the masked star core is drawn dark: {r['core']}"
    assert max(r["edge"]) == 0, f"pixels off the image are no longer black: {r['edge']}"
    assert r["same"] and r["before"] == r["after"], f"painting changed the pixels the light is measured on: {r}"
    print(f"  crop: masked core drawn {min(r['core'])}-{max(r['core'])} of 255, edge black, light measured {r['before']} before and after")
    await ctx.close()


CARD = """() => { const c = document.getElementById('card-comet'), id = c.querySelector('[data-f=id]').textContent, map = document.getElementById('map').getBoundingClientRect();
  const m = [...document.querySelectorAll('.mk.known')].find(a => a.querySelector('b')?.textContent === id), s = m && getComputedStyle(m);
  const i = m?.querySelector('i').getBoundingClientRect();
  return { id, href: c.getAttribute('href'), shown: !c.hidden && getComputedStyle(c).visibility !== 'hidden',
    drawn: !!m && !m.hidden && s.display !== 'none' && s.visibility !== 'hidden' && i.width > 0, dim: m?.classList.contains('faint') || m?.classList.contains('speck'),
    card: [parseFloat(c.style.left) / 100, parseFloat(c.style.top) / 100], dot: [parseFloat(m?.style.left) / 100, parseFloat(m?.style.top) / 100] }; }"""


async def explore(b):
    ctx = await ctx_for(b); pg = await ctx.new_page()
    await pg.goto(BASE + "/explore.html")
    await pg.wait_for_selector("body[data-ready='1']"); await pg.wait_for_selector(".mk.sel", state="attached")
    await pg.wait_for_function("!document.getElementById('play').classList.contains('on')", timeout=60000)   # the replay ends on the default day
    g = await pg.evaluate(CARD)
    assert g["shown"] and g["drawn"] and not g["dim"], f"default day: featured card on a comet that is not drawn: {g}"
    assert all(abs(a - d) < 0.01 for a, d in zip(g["card"], g["dot"])), f"card not at its comet: {g}"
    assert f"id={urllib.parse.quote(g['id'], safe='()')}" in g["href"], f"card links elsewhere: {g}"
    print(f"  explore: default day features {g['id']}, drawn and not dimmed, card at its dot")
    await pg.fill("#xs-q", "3I/ATLAS"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(1500)
    g = await pg.evaluate(CARD)
    assert g["id"] == "3I/ATLAS" and g["shown"], f"search did not feature 3I/ATLAS: {g}"
    print("  explore: searching 3I/ATLAS puts it on the card")
    await ctx.close()


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        await crop(b)
        await explore(b)
        await baked(b, "C/2025 R2 (SWAN)")
        await asyncio.gather(live(b, "C/2024 J3 (ATLAS)", True), live(b, "235P/LINEAR", True), live(b, "2P/Encke", False))
        await b.close()
    print("PASS examples: comet players open on the clearest photo, masked star cores drawn filled, Explore features a comet on the map")

asyncio.run(main())
