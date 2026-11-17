"""Browser check that the examples a first visit lands on show something real. Needs the app up and the network (NASA's S3
copy of SPHEREx for the live photos); takes a few minutes.
Run: uv run -q --with playwright python web/tests/examples_ui.py [base url]   (default http://127.0.0.1:8873)
(The comet pages' main picture and visit pictures are checked by web/tests/comet_page_ui.py since the redesign.)
- Crops (live/cutout.js paint): a bright star whose core is masked (saturated) is drawn filled, with no black pixel in
  it; edges off the image stay black; the light measured on the same pixels is unchanged.
- Explore on the default day: the featured card's comet has a marker drawn and not dimmed, the card within 1% of it.
  Searching "3I/ATLAS" still puts 3I/ATLAS on the card."""
import asyncio, re, sys, urllib.parse
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8873"
page = lambda cid: f"{BASE}/comet.html?id=" + urllib.parse.quote(cid, safe="")
async def ctx_for(b):
    ctx = await b.new_context(viewport={"width": 1440, "height": 900})
    await ctx.add_init_script("try { localStorage.setItem('ch.tour', '1') } catch {}")
    return ctx


CROP = """async () => {
  const { paint, starMeasure, R_OUT } = await import('/live/cutout.js');
  const G = 96, px = new Float32Array(G * G), c = 40;
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < G * G; k++) { const x = k % G, y = Math.floor(k / G);
    px[k] = 10 + rnd() + 4000 * Math.exp(-((x - c) ** 2 + (y - c) ** 2) / 8) + 300 * Math.exp(-((x - 70) ** 2 + (y - 20) ** 2) / 4); }
  for (let k = 0; k < G * G; k++) { const x = k % G, y = Math.floor(k / G);
    if (Math.hypot(x - c, y - c) <= 1) px[k] = NaN;   // the saturated core, masked (5 pixels, so the circle can still be measured)
    if (x < 4) px[k] = NaN; }   // off the image: a strip at the edge
  // the measurement, on the star's window (as readCells gives it): the masked core is left out, before and after paint
  const W = 2 * (R_OUT + 1) + 1, h = (W - 1) / 2, win = Float64Array.from({ length: W * W }, (_, k) => px[(c - h + Math.floor(k / W)) * G + c - h + k % W]);
  const more = { flag: Array(W * W).fill(0), var: Array(W * W).fill(1) };
  const before = starMeasure(win, more, h, h), copy = Float32Array.from(px);
  const cv = document.createElement('canvas'); paint(cv, { px, grid: G });
  const d = cv.getContext('2d').getImageData(0, 0, G, G).data, grey = (x, y) => d[4 * (y * G + x)];
  const core = []; for (let y = c - 2; y <= c + 2; y++) for (let x = c - 2; x <= c + 2; x++) if (Math.hypot(x - c, y - c) <= 2) core.push(grey(x, y));
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
        await b.close()
    print("PASS examples: masked star cores drawn filled, Explore features a comet on the map")

asyncio.run(main())
