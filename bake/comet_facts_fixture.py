"""Freeze every known comet's record and snapshot (GET /api/comets/:id on the running app) into
web/tests/fixtures/comets.json for web/tests/facts_test.mjs, without the large parts facts.js does not read
(spectrum points, positions, Depth's path). Run after the bake and a snapshot:
  python3 bake/comet_facts_fixture.py [http://127.0.0.1:8873]"""
import json, sys, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8873"
get = lambda path: json.loads(urllib.request.urlopen(API + path, timeout=60).read())
ids = [c["id"] for c in get("/api/comets")["comets"] if c["kind"] == "known"]
out, days = [], set()
for cid in ids:
    c = get("/api/comets/" + urllib.parse.quote(cid, safe=""))
    d = c["detail"] or {}
    f = dict(d.get("facts") or {}, path=None, T=None)
    keep = {k: d[k] for k in ("co2", "co2_verdict", "dir") if k in d}
    keep["photos"] = [{k: p[k] for k in ("mjd", "flux", "lam", "file", "ra", "dec") if k in p} for p in d.get("photos") or []]
    out.append(dict(id=cid, detail=dict(keep, facts=f), now=c.get("now")))
    if c.get("now"): days.add(c["now"]["as_of"])
assert len(days) == 1, f"the snapshot has more than one date: {days} (take today's snapshot for every comet first)"
p = ROOT / "web/tests/fixtures/comets.json"
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(dict(today=days.pop(), comets=out), separators=(",", ":")))
print(f"wrote {p.relative_to(ROOT)}: {len(out)} comets")
