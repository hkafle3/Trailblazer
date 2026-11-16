"""Thumbnails for the Comets list: for every known comet without measured photos, its clearest SPHEREx photo where it is
Seen (SNR 5 or more), centred on the comet. Built by web/live/cutout.js itself, in headless Chrome against the app, so a
thumbnail is the same crop, stretch and verdict the comet's page shows (visitShots, knownPhoto, paint): one photo per
visit, the highest SNR among the Seen ones. Comets with no Seen visit get no thumbnail. Each comet's visit tally is kept in
bake/cache/known_thumbs_tried.json: a second run measures only the comets with no thumbnail whose last try had a photo
that failed to load (a network error), so it finishes what an interrupted run left (a comet already baked is measured again too, in case the visit that failed
was its clearest).
Writes web/data/comets/thumbs/<slug>.png (96x96 grey) and web/data/comets/thumbs/index.json
({ id: { file, snr, obs, day } }), which the Worker merges into GET /api/comets `thumb` (worker/src/index.js).
Run with the app up (npm run dev):
  uv run -q --with playwright --with pillow python bake/known_thumbs.py [base url]   (default http://127.0.0.1:8787)"""
import asyncio, base64, io, json, re, sys, urllib.parse, urllib.request
from pathlib import Path
from PIL import Image
from playwright.async_api import async_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787").rstrip("/")
OUT = Path(__file__).resolve().parent.parent / "web" / "data" / "comets" / "thumbs"
TRIED = Path(__file__).resolve().parent / "cache" / "known_thumbs_tried.json"
slug = lambda i: re.sub(r"[^a-z0-9]+", "-", i.lower()).strip("-")

# every visit of one comet measured (two at a time, as the comet page does); the clearest Seen one painted to a PNG
BEST = """async ([shots]) => {
  const { visitShots, knownPhoto, paint, pool } = await import('/live/cutout.js');
  const picks = visitShots(shots), got = await pool(picks, 2, s => knownPhoto(s).then(p => ({ s, p })).catch(e => ({ s, err: String(e) })));
  const seen = got.filter(g => g.p?.verdict === 'seen').sort((a, b) => b.p.snr - a.p.snr);
  const tally = got.reduce((t, g) => (t[g.p?.verdict ?? 'error'] = (t[g.p?.verdict ?? 'error'] ?? 0) + 1, t), {});
  if (!seen.length) return { tally };
  const { s, p } = seen[0], cv = document.createElement('canvas');
  paint(cv, p);
  return { tally, png: cv.toDataURL('image/png'), snr: p.snr, obs: s.obs, day: s.day };
}"""


async def main():
    comets = json.load(urllib.request.urlopen(BASE + "/api/comets"))["comets"]
    tally = json.loads(TRIED.read_text()) if TRIED.exists() else {}
    OUT.mkdir(parents=True, exist_ok=True); TRIED.parent.mkdir(exist_ok=True)
    index, tried = json.loads((OUT / "index.json").read_text()) if (OUT / "index.json").exists() else {}, set()
    # not the measured comets (their thumbnail is their brightest measured photo); a baked one again if a visit failed
    todo = [c["id"] for c in comets if c["kind"] == "known" and c["real"] and (not c.get("thumb") or c["id"] in index) and tally.get(c["id"], {"error": 1}).get("error")]
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        pg = await b.new_page()
        await pg.goto(BASE + "/guide.html")
        sem = asyncio.Semaphore(8)   # each comet measures two visits at a time

        async def one(cid):
            async with sem:
                d = json.load(urllib.request.urlopen(BASE + "/api/comets/" + urllib.parse.quote(cid, safe="")))["detail"]
                r = await pg.evaluate(BEST, [d.get("spherex") or []])
            line = f"{cid}: {r['tally']}"
            if "png" in r:
                im = Image.open(io.BytesIO(base64.b64decode(r["png"].split(",", 1)[1]))).convert("L")
                f = slug(cid) + ".png"
                im.save(OUT / f, optimize=True)
                index[cid] = {"file": f, "snr": round(r["snr"], 1), "obs": r["obs"], "day": r["day"]}
                line += f" -> {f} (SNR {r['snr']:.1f})"
            print(line, flush=True)
            tried.add(cid); tally[cid] = r["tally"]

        await asyncio.gather(*(one(c) for c in todo), return_exceptions=True)
        await b.close()
    TRIED.write_text(json.dumps(tally, indent=1))
    (OUT / "index.json").write_text(json.dumps(dict(sorted(index.items())), indent=1) + "\n")
    if missed := [c for c in todo if c not in tried]: print("FAILED (run again):", missed)
    print(f"{len(index)} of {len(todo)} comets seen: thumbnails in {OUT}")

asyncio.run(main())
