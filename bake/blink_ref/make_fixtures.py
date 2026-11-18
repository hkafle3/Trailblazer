"""Inputs and reference answers for web/tests/blink_parity.mjs (the browser port against build_v3.py), made from scratch.
  1. the old-survey tiles (old_tiles.json: IRSA cutout URLs, each checked against its sha256) and the SVO band curves
  2. the SPHEREx cutouts (spx_cutouts.json: S3 key and pixel box of each, each checked against its sha256)
  3. build_v3.py (this folder; the phase 2 reference, unchanged) run on them, its arrays exported for the test
Run (about 10 minutes, public NASA and SVO services only):
  uv run -q --with astropy --with numpy --with scipy --with pillow --with requests --with fsspec --with aiohttp \\
    python -I bake/blink_ref/make_fixtures.py --out ../blink-fixtures
Or export from inputs already on disk (no downloads): add --raw <raw_v2 dir> --cache <lead-check cache/L1 dir>.
Then: BLINK_FIXTURES=../blink-fixtures node web/tests/blink_parity.mjs"""
import argparse, concurrent.futures as cf, gzip, hashlib, json, os, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(os.path.dirname(HERE))
a = argparse.ArgumentParser(); a.add_argument('--out', required=True); a.add_argument('--raw'); a.add_argument('--cache'); args = a.parse_args()
OUT = os.path.abspath(args.out); os.makedirs(OUT, exist_ok=True)
sha = lambda b: hashlib.sha256(b).hexdigest()
def get(url, **kw):
    import requests
    for k in range(5):
        try: r = requests.get(url, timeout=120, headers={'User-Agent': 'comet-hunt-fixtures'}, **kw); r.raise_for_status(); return r.content
        except Exception as e: last = e; time.sleep(2 * (k + 1))
    raise last

# ---- 1. old tiles and band curves ----
RAW = os.path.abspath(args.raw) if args.raw else f'{OUT}/raw_v2'
if not args.raw:
    os.makedirs(RAW, exist_ok=True)
    for name, t in json.load(open(f'{HERE}/old_tiles.json')).items():
        b = get(t['url']); b = gzip.decompress(b) if b[:2] == b'\x1f\x8b' else b
        if sha(b) != t['sha256']: sys.exit(f'{name}: IRSA sent different bytes ({sha(b)}), not the reference input')
        open(f'{RAW}/{name}', 'wb').write(b); print('old', name, flush=True); time.sleep(0.5)   # one at a time: IRSA refuses parallel cutouts of a tile
    for f in ('2MASS/2MASS.Ks', 'WISE/WISE.W1', 'WISE/WISE.W2'):
        open(f"{RAW}/rsr_{f.replace('/', '_')}.xml", 'wb').write(get(f'https://svo2.cab.inta-csic.es/theory/fps/fps.php?ID={f}'))
# the curves must be the ones the browser uses (web/data/bands.json)
import re
bands = json.load(open(f'{REPO}/web/data/bands.json'))
for band, f in (('Ks', '2MASS_2MASS.Ks'), ('W1', 'WISE_WISE.W1'), ('W2', 'WISE_WISE.W2')):
    v = [float(x) for x in re.findall(r'<TD>([^<]+)</TD>', open(f'{RAW}/rsr_{f}.xml').read().split('<TABLEDATA>')[1])]
    if not np.allclose(np.array(v[0::2]) / 1e4, bands[band]['lam']) or not np.allclose(v[1::2], bands[band]['r']): sys.exit(f'{f}: SVO curve differs from web/data/bands.json')

# ---- 2. SPHEREx cutouts ----
LC = os.path.abspath(args.cache) if args.cache else f'{OUT}/L1'
CUTS = json.load(open(f'{HERE}/spx_cutouts.json'))
if not args.cache:
    from astropy.io import fits
    os.makedirs(f'{LC}/exp', exist_ok=True)
    def one(c):
        f = f"{LC}/exp/{c['name']}.npz"
        if os.path.exists(f): return c['name']
        h = fits.open('https://nasa-irsa-spherex.s3.amazonaws.com/' + c['key'], use_fsspec=True, fsspec_kwargs={'block_size': 2 ** 20})
        y0, x0 = c['y0'], c['x0']
        img = np.asarray(h['IMAGE'].section[y0:y0 + c['h'], x0:x0 + c['w']], np.float32); flg = np.asarray(h['FLAGS'].section[y0:y0 + c['h'], x0:x0 + c['w']]).astype(np.int32)
        if sha(img.astype('<f4').tobytes() + flg.astype('<i4').tobytes()) != c['sha256']: raise ValueError(f"{c['name']}: S3 sent different pixels")
        np.savez_compressed(f, img=img, flg=flg, x0=x0, y0=y0, hdr=h['IMAGE'].header.tostring(), t=c['t'])
        return c['name']
    with cf.ThreadPoolExecutor(8) as ex:
        for i, n in enumerate(ex.map(one, CUTS)): print('spx', i + 1, len(CUTS), n, flush=True)
    json.dump([dict(obs=c['name'][3:], det=c['det'], t=c['t'], key=c['key'], file=f"exp/{c['name']}.npz") for c in CUTS], open(f'{LC}/exposures.json', 'w'))

# ---- 3. the reference, run on them, and its arrays exported ----
src = open(f'{HERE}/build_v3.py').read()
for old, new in [("HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))", f"HERE = {OUT!r}"),
                 ("RAW, OUT = HERE + '/raw_v2', HERE + '/stills_v3'", f"RAW, OUT = {RAW!r}, {OUT + '/ref'!r}"),
                 ("LC = '/Users/edkiboma/Projects/comet-hunt-work/lead-check/cache/L1'", f"LC = {LC!r}"),
                 ("WAVE = '/Users/edkiboma/Projects/comet-hunt/web/data/wavemaps.json'", f"WAVE = {REPO + '/web/data/wavemaps.json'!r}"),
                 ("    po_path, ps_path = paths['old'], paths['spherex']\n", "    if write: DUMP[name] = dict(o=o, s=s, mo=mo, ms=ms, ow=ow, sw=sw, lo=lo, hi=hi, scale=scale, F=F, smask=smask)\n    po_path, ps_path = paths['old'], paths['spherex']\n")]:
    assert old in src, old; src = src.replace(old, new)
g = {'__name__': 'build_v3_fixtures', 'DUMP': {}}
exec(compile(src, f'{HERE}/build_v3.py', 'exec'), g)
from astropy.io import fits
from astropy.wcs import WCS
for band, d in g['DUMP'].items():
    img, m, meta = g['cache'][(band, g['PAIRS'][band][0])]; o0, mo0, _ = g['olds'][band]
    os.makedirs(f'{OUT}/ref/{band}', exist_ok=True); meta_out = {}
    for k, v in dict(synth=img, synth_m=m, old=o0, old_m=mo0, **d).items():
        v = np.asarray(v)
        if v.ndim == 0: meta_out[k] = float(v)
        else: v.astype('<f8').tofile(f'{OUT}/ref/{band}/{k}.f64'); meta_out[k] = list(v.shape)
    json.dump(meta_out, open(f'{OUT}/ref/{band}/meta.json', 'w'))
os.makedirs(f'{OUT}/fixtures/spx', exist_ok=True)
N, GRA, GDEC = g['N'], g['GRA'], g['GDEC']; pts = np.random.default_rng(1).integers(0, N, size=(100, 2))
ra, dec = GRA[pts[:, 0], pts[:, 1]], GDEC[pts[:, 0], pts[:, 1]]; idx, wcs = [], {}
for e in json.load(open(f'{LC}/exposures.json')):
    if e['det'] not in ('D3', 'D4', 'D5', 'D6'): continue
    z = np.load(f"{LC}/{e['file']}"); name = os.path.basename(e['file'])[:-4]
    open(f'{OUT}/fixtures/spx/{name}.bin', 'wb').write(z['img'].astype('<f4').tobytes() + z['flg'].astype('<i4').tobytes())
    idx.append(dict(name=name, det=e['det'], t=e['t'], key=e['key'], x0=int(z['x0']), y0=int(z['y0']), w=z['img'].shape[1], h=z['img'].shape[0], hdr=str(z['hdr'])))
    px, py = WCS(fits.Header.fromstring(str(z['hdr']))).all_world2pix(ra, dec, 0); wcs[name] = dict(px=px.tolist(), py=py.tolist())
json.dump(idx, open(f'{OUT}/fixtures/spx/index.json', 'w'))
for f in sorted(os.listdir(RAW)):
    if f.endswith('.fits'): px, py = WCS(fits.getheader(f'{RAW}/{f}')).all_world2pix(ra, dec, 0); wcs[f] = dict(px=px.tolist(), py=py.tolist())
json.dump(dict(ra=ra.tolist(), dec=dec.tolist(), files=wcs), open(f'{OUT}/fixtures/wcs.json', 'w'))
json.dump(dict(raw=RAW, made=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())), open(f'{OUT}/fixtures/source.json', 'w'))
print('fixtures in', OUT)
