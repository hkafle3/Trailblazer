"""Evaluator: compare the sky index's answers (worker/src/sky_index.js on the built file) with real IRSA answers.

  uv run --with numpy python bake/sky_index_eval.py INDEX_DIR HEADERS.jsonl EVAL_DIR [DET]

EVAL_DIR holds the IRSA answers (all fetched read-only):
  searches.json          wrangler d1 execute comet-hunt --remote --json --command "SELECT key, part, body FROM searches ..."
                         (/api/images answers saved by the live site: SIA's answer, deduplicated by obs_id, DR1 first)
  sia/<coll>_<det>_<ra>_<dec>.csv   SIA answers fetched with the Worker's own query (eval/sia_fetch.py)
  sia_qr3_sample.csv     one SIA spherex_qr3 answer at Barnard's Star, all detectors (research folder)
  obscore_3I_Atlas.vot   IRSA's table of the images that caught 3I/ATLAS, with the comet's position in each
  edgepts.json           probe points near image edges, with their pixel position from astropy's exact inverse WCS
                         (eval/classify.py): they show whether SIA tests the s_region polygon or the WCS pixel box
Every difference is explained by the image's margin: how far the point lies inside (+) or outside (-) its footprint
polygon, in arcsec, from the headers. SIA's circle is 3.6 arcsec, so a true match has margin > -3.6.
Prints one line per position and exits non-zero if any difference is left unexplained.
"""
import csv, glob, json, math, os, re, subprocess, sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import sky_index as X

ROOT = Path(__file__).resolve().parent.parent
WIDE, DEEP = X.COLLS[:2], X.COLLS[2:]


def run_index(index_dir, det, points):
    """Answers of worker/src/sky_index.js for [(ra, dec)], run in node exactly as the Worker calls it."""
    js = f"""
import {{ readFileSync, readSync, openSync }} from 'node:fs';
import {{ skyImages }} from {json.dumps(str(ROOT / 'worker/src/sky_index.js'))};
const fds = {{}};
const read = async (name, off, len) => {{
  const fd = fds[name] ??= openSync({json.dumps(str(index_dir))} + '/' + name, 'r'), b = Buffer.alloc(len);
  readSync(fd, b, 0, len, off); return b.buffer.slice(b.byteOffset, b.byteOffset + len);
}};
const out = [];
for (const [ra, dec] of JSON.parse(readFileSync(0, 'utf8'))) out.push(await skyImages(read, ra, dec, {det}));
process.stdout.write(JSON.stringify(out));
"""
    r = subprocess.run(["node", "--input-type=module", "-e", js], input=json.dumps(points), capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def worker_answer(per_coll, det):
    """What /api/images builds from SIA rows: science rows of this detector, one per obs_id with DR1 first, by t."""
    seen = {}
    for coll in X.COLLS:
        for x in per_coll.get(coll, []):
            if x["energy_bandpassname"] == f"SPHEREx-D{det}" and x["dataproduct_subtype"] == "science" and x["obs_id"] not in seen:
                key = x["access_url"].split("/ibe/data/spherex/")[1]   # the CSV's cloud_access JSON is not CSV-quoted; same key (s3Key)
                seen[x["obs_id"]] = {"t": float(x["t_min"]), "key": key, "obs": x["obs_id"], "coll": coll}
    return sorted(seen.values(), key=lambda r: r["t"])


class Margins:
    """Signed distance (arcsec) of a point from every image's footprint polygon, straight from the headers."""
    def __init__(self, headers, det):
        meta, H = X.load(headers)
        sel = [i for i, m in enumerate(meta) if m["det"] == det]
        self.meta = [meta[i] for i in sel]
        self.N = X.normals(X.corners({k: v[sel] for k, v in H.items()}))
        self.by_obs = defaultdict(list)
        for i, m in enumerate(self.meta):
            self.by_obs[m["obs"]].append(i)

    def margin(self, obs, ra, dec):
        p = X.unit(ra, dec)
        return [round(float(np.degrees(np.arcsin(np.min(self.N[i] @ p)))) * 3600, 2) for i in self.by_obs.get(obs, [])]

    def inside_all(self, ra, dec, deep):
        """Brute force over every image (no cells): the index's answer without the index, to check the bucketing."""
        ok = X.inside(self.N, X.unit(ra, dec))
        return {self.meta[i]["obs"]: self.meta[i]["coll"] for i in np.nonzero(ok)[0] if deep or self.meta[i]["coll"] in WIDE}


def compare(name, ra, dec, got, want, M, deep, colls=None):
    """One line per position: exact matches, extras (index only), misses (IRSA only), with each difference explained."""
    g = {r["obs"]: r for r in got["images"] if colls is None or r["coll"] in colls}
    w = {r["obs"]: r for r in want}
    same = [o for o in w if o in g and g[o] == w[o]]
    diff_fields = [o for o in w if o in g and g[o] != w[o]]
    extra, miss = [o for o in g if o not in w], [o for o in w if o not in g]
    brute = M.inside_all(ra, dec, deep)
    bucket = sorted(o for o, c in brute.items() if (colls is None or c in colls) and o not in g)
    notes, unexplained = [], 0
    for o in diff_fields:
        notes.append(f"field difference {o}: index {g[o]} irsa {w[o]}"); unexplained += 1
    for o in extra:
        m = M.margin(o, ra, dec)
        ok = m and max(m) <= -3.5   # just outside SIA's circle: an edge effect, not an error
        notes.append(f"extra {o} margin {m}\"" + ("" if ok else " UNEXPLAINED")); unexplained += not ok
    for o in miss:
        m = M.margin(o, ra, dec)
        if not m:
            notes.append(f"miss {o}: not in the bucket listing UNEXPLAINED"); unexplained += 1; continue
        ok = max(m) < -3.5
        notes.append(f"miss {o} margin {m}\"" + ("" if ok else " UNEXPLAINED")); unexplained += not ok
    if bucket:
        notes.append(f"BUCKETING: {len(bucket)} images inside by brute force but not returned: {bucket[:5]}"); unexplained += len(bucket)
    print(f"{name:42s} ({ra:.4f}, {dec:.4f}) irsa {len(w):5d} index {len(g):5d} exact {len(same):5d} extra {len(extra)} miss {len(miss)}"
          + ("  OK" if not unexplained else f"  {unexplained} UNEXPLAINED"))
    for n in notes:
        print("    " + n)
    return unexplained


def main():
    index_dir, headers, ev = Path(sys.argv[1]).resolve(), sys.argv[2], Path(sys.argv[3])
    det = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    M = Margins(headers, det)
    cases = []   # (name, ra, dec, want rows, collections compared or None)

    # 1. answers the live site saved from SIA
    parts = defaultdict(list)
    for r in json.load(open(ev / "searches.json"))[0]["results"]:
        parts[r["key"]].append((r["part"], r["body"]))
    for key, ps in sorted(parts.items()):
        q = dict(x.split("=") for x in key.split("?")[1].split("&"))
        if q.get("det") != f"D{det}":
            continue
        body = json.loads("".join(b for _, b in sorted(ps)))
        cases.append((f"saved {key.split('?')[1]}", float(q["ra"]), float(q["dec"]), body["images"], None))

    # 2. SIA answers fetched for this evaluation
    per_pos = defaultdict(dict)
    for f in glob.glob(str(ev / "sia" / f"*_D{det}_*.csv")):
        m = re.match(r"(spherex_\w+?)_D\d_([\d.]+)_(-?[\d.]+)\.csv$", os.path.basename(f))
        per_pos[(float(m.group(2)), float(m.group(3)))][m.group(1)] = list(csv.DictReader(open(f)))
    names = {(round(p["ra"], 6), round(p["dec"], 6)): p["name"] for p in json.load(open(ev / "points.json"))} if (ev / "points.json").exists() else {}
    for (ra, dec), pc in sorted(per_pos.items()):
        deep = abs(X_beta(ra, dec)) > 75
        need = X.COLLS if deep else WIDE
        if not all(c in pc for c in need):
            print(f"skip ({ra}, {dec}): SIA answer incomplete, has {sorted(pc)}"); continue
        cases.append((f"sia {names.get((ra, dec), '')}", ra, dec, worker_answer(pc, det), None))

    # 3. the research folder's SIA sample (spherex_qr3 only)
    sample = ev / "sia_qr3_sample.csv"
    if sample.exists():
        cases.append(("sia_qr3_sample (qr3 only)", 269.4463, 4.7671, worker_answer({"spherex_qr3": list(csv.DictReader(open(sample)))}, det), ["spherex_qr3"]))

    got = run_index(index_dir, det, [(c[1], c[2]) for c in cases])
    bad = sum(compare(n, ra, dec, g, w, M, abs(X_beta(ra, dec)) > 75, cl) for (n, ra, dec, w, cl), g in zip(cases, got))

    # edge probes: does SIA list the probe's own image? (needs that position's SIA answer in sia/)
    probes = json.load(open(ev / "edgepts.json")) if (ev / "edgepts.json").exists() else []
    if probes:
        print("\nedge probes: the image the point was placed against, by SIA and by the index")
    for p in probes:
        pc = per_pos.get((round(p["ra"], 6), round(p["dec"], 6)))
        if not pc:
            continue
        sia = any(x["obs_id"] == p["obs"] and x["energy_bandpassname"] == f"SPHEREx-D{det}" for rows in pc.values() for x in rows)
        idx = any(x["obs"] == p["obs"] for g, c in zip(got, cases) if (round(c[1], 6), round(c[2], 6)) == (round(p["ra"], 6), round(p["dec"], 6)) for x in g["images"])
        m = M.margin(p["obs"], p["ra"], p["dec"])[0]
        wcs = X.LO <= p["px"] <= X.HI and X.LO <= p["py"] <= X.HI
        print(f"  {p['obs']} {p['edge']:24s} pixel ({p['px']:8.2f}, {p['py']:8.2f}) inside WCS box {str(wcs):5s} polygon margin {m:7.2f}\" "
              f"| SIA lists it {str(sia):5s} index {str(idx):5s}" + ("" if sia == idx else "  MISMATCH"))
        bad += sia != idx

    # 4. 3I/ATLAS: each image IRSA lists as catching the comet must be in our answer at the comet's position
    vot = ev / "obscore_3I_Atlas.vot"
    if vot.exists():
        text = vot.read_text()
        fields = re.findall(r'<FIELD [^>]*name="([^"]+)"', text)
        rows = [dict(zip(fields, re.findall(r"<TD>(.*?)</TD>", tr, re.S))) for tr in re.findall(r"<TR>(.*?)</TR>", text, re.S)]
        rows = [r for r in rows if r["spherex_detector"].strip() in (f"D{det}", str(det))]
        ans = run_index(index_dir, det, [(float(r["comet_ra"]), float(r["comet_dec"])) for r in rows])
        # these rows are spherex_qr2, a release /api/images does not search; the same exposure is in DR1, so the check
        # is obs_id and t (the key differs by release: qr2/... vs dr1/...)
        found, notes = 0, []
        for r, a in zip(rows, ans):
            o = r["obs_id"].strip()
            hit = [x for x in a["images"] if x["obs"] == o]
            if hit and abs(hit[0]["t"] - float(r["t_min"])) < 1e-6:
                found += 1
            else:
                m = M.margin(o, float(r["comet_ra"]), float(r["comet_dec"]))
                ok = not hit and m and max(m) < -3.5
                notes.append(f"{'miss' if not hit else 't differs'} {o} margin {m}\"" + ("" if ok else " UNEXPLAINED"))
                bad += not ok
        colls = sorted({r["obs_collection"].strip() for r in rows})
        print(f"{'3I/ATLAS obscore, D' + str(det) + ' rows':42s} rows {len(rows)} ({', '.join(colls)}) found with same obs_id and t {found}"
              + ("  OK" if all("UNEXPLAINED" not in n for n in notes) else ""))
        for n in notes:
            print("    " + n)
    print(f"\n{bad} unexplained differences")
    sys.exit(1 if bad else 0)


def X_beta(ra, dec):
    e, a, d = math.radians(23.4393), math.radians(ra), math.radians(dec)
    return math.degrees(math.asin(math.sin(d) * math.cos(e) - math.cos(d) * math.sin(e) * math.sin(a)))


if __name__ == "__main__":
    main()
