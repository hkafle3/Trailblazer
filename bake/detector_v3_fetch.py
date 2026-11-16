"""Detector v3, preflight (P1): cache every input once, offline afterwards. Also the shared field-directory format.

A field directory (the only thing the detector ever receives) holds ordinary files:
  field.json     name, ra, dec, size (deg)
  exposures.json [{obs, det (D1..D6), t (MJD mid), coll, key, file}]
  exp/<det>_<obs>.npz   img (MJy/sr, float32), flg (int32), x0, y0 (cutout origin on the 2040 px detector), hdr (IMAGE header)
  catwise.csv allwise.csv twomass.csv gaia.csv simbad.csv   catalogue snapshots (cone of size*0.75 + 0.05 deg)
  manifest.json  release, versions, time range, row counts, sha256 of every file, the queries used

Releases: SPHEREx DR1 first, QR3 for exposures DR1 lacks; never QR2. Catalogues from IRSA TAP (catwise_2020,
allwise_p3as_psd, fp_psc), Gaia DR3 from the AIP mirror then IRSA's copy, SIMBAD from the Harvard mirror (identity
only, read after scoring). A failed download or query raises; a field without manifest.json is not usable.

Run: uv run -q --with astropy --with numpy --with scipy --with requests --with fsspec --with aiohttp \
       python -I bake/detector_v3_fetch.py field <name> <ra> <dec> [size]      (one field)
       python -I bake/detector_v3_fetch.py epsf                                 (one ePSF table per detector)
       python -I bake/detector_v3_fetch.py cover <ra> <dec>                     (coverage numbers at a point, from SIA footprints)
"""
import sys, os, io, csv, json, time, hashlib, datetime, warnings, urllib.parse, numpy as np, requests
from concurrent.futures import ThreadPoolExecutor
warnings.simplefilter('ignore')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get('DET_V3_OUT', '/private/tmp/claude-501/-Users-edkiboma-Projects-yoshi/b096768d-88fe-4be7-90b6-16c0f7f75de8/scratchpad/detector-v3')
CACHE = OUT + '/cache'
S3 = 'https://nasa-irsa-spherex.s3.amazonaws.com/'
COLLS = ('spherex_dr1', 'spherex_qr3')
SIZE = 0.56                       # deg, every field
AS = 206264.806
PASS_GAP = 60.0                   # days between exposures that split survey passes
year = lambda mjd: 2000.0 + (np.asarray(mjd, float) - 51544.5) / 365.25
sha = lambda path: hashlib.sha256(open(path, 'rb').read()).hexdigest()

def tan(ra, dec, ra0, dec0):
    a, d, a0, d0 = (np.radians(v) for v in (ra, dec, ra0, dec0)); c = np.sin(d0) * np.sin(d) + np.cos(d0) * np.cos(d) * np.cos(a - a0)
    return AS * np.cos(d) * np.sin(a - a0) / c, AS * (np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(a - a0)) / c
def untan(x, y, ra0, dec0):
    x, y, a0, d0 = np.asarray(x, float) / AS, np.asarray(y, float) / AS, np.radians(ra0), np.radians(dec0)
    r = np.hypot(x, y); c = np.arctan(r); r = np.where(r == 0, 1e-12, r)
    d = np.arcsin(np.cos(c) * np.sin(d0) + y * np.sin(c) * np.cos(d0) / r)
    return np.degrees(a0 + np.arctan2(x * np.sin(c), r * np.cos(d0) * np.cos(c) - y * np.sin(d0) * np.sin(c))) % 360, np.degrees(d)

def get(url, data=None, tries=8, timeout=300):
    for i in range(tries):
        try:
            r = requests.post(url, data=data, timeout=timeout) if data else requests.get(url, timeout=timeout)
            if r.status_code == 200: return r.text
            err = f'{r.status_code} {r.text[:120]}'
        except Exception as e: err = repr(e)
        time.sleep(min(60, 3 * 2 ** i))
    raise IOError(f'gave up: {url[:100]} {err}')

# ---------- SPHEREx exposure listing and coverage ----------
def sia(ra, dec, radius):
    """Science exposures whose footprint meets the circle, all detectors, one row per (obs, det), DR1 before QR3."""
    rows = {}
    for coll in COLLS:
        url = 'https://irsa.ipac.caltech.edu/SIA?' + urllib.parse.urlencode({'COLLECTION': coll, 'POS': f'CIRCLE {ra} {dec} {radius}', 'RESPONSEFORMAT': 'CSV', 'MAXREC': '50000'})
        txt = get(url)
        if not txt.startswith('s_ra'): raise IOError(f'SIA {coll}: {txt[:200]}')
        for r in csv.DictReader(io.StringIO(txt)):
            if r['dataproduct_subtype'] != 'science': continue
            det = r['energy_bandpassname'].replace('SPHEREx-', ''); key = r['access_url'].split('/ibe/data/spherex/')[1]
            rows.setdefault((r['obs_id'], det), dict(obs=r['obs_id'], det=det, t=(float(r['t_min']) + float(r['t_max'])) / 2, coll=coll, key=key,
                                                     poly=[float(v) for v in r['s_region'].split()[2:10]]))
    return sorted(rows.values(), key=lambda e: (e['det'], e['t']))

def inside(ra, dec, poly):
    """Is the point inside the 4-corner footprint (tangent plane about the point)."""
    x, y = tan(np.array(poly[0::2]), np.array(poly[1::2]), ra, dec); s = [x[i] * y[(i + 1) % 4] - x[(i + 1) % 4] * y[i] for i in range(4)]
    return all(v > 0 for v in s) or all(v < 0 for v in s)

def passes(ts):
    ts = sorted(ts); g = [[ts[0]]] if ts else []
    for t in ts[1:]: (g[-1].append(t) if t - g[-1][-1] < PASS_GAP else g.append([t]))
    return g

def cover(ra, dec, rows=None):
    """Coverage of one sky point from footprints alone: D6 exposures per pass, and D4 exposures in all."""
    rows = rows if rows is not None else sia(ra, dec, 0.002); hit = [e for e in rows if inside(ra, dec, e['poly'])]
    p6 = passes([e['t'] for e in hit if e['det'] == 'D6'])
    return dict(d6_per_pass=[len(p) for p in p6], pass_years=[round(float(year(np.mean(p))), 2) for p in p6], d4=sum(e['det'] == 'D4' for e in hit),
                n=len(hit), colls=sorted({e['coll'] for e in hit}))

# ---------- catalogues ----------
IRSA = 'https://irsa.ipac.caltech.edu/TAP/sync'
CATS = {
    'catwise': ('CatWISE2020 (IRSA catwise_2020)', "SELECT source_name,source_id,ra,dec,sigra,sigdec,ra_pm,dec_pm,sigra_pm,sigdec_pm,pmra,pmdec,sigpmra,sigpmdec,meanobsmjd,w1mpro_pm,w1sigmpro_pm,w2mpro_pm,w2sigmpro_pm,w1snr_pm,w2snr_pm,rchi2_pm,nb,na,cc_flags,ab_flags,par_pm,par_pmsig,w1mjdmin,w1mjdmax,w2mjdmean FROM catwise_2020"),
    'allwise': ('AllWISE source catalog (IRSA allwise_p3as_psd)', "SELECT designation,ra,dec,sigra,sigdec,ra_pm,dec_pm,sigra_pm,sigdec_pm,pmra,pmdec,sigpmra,sigpmdec,w1mpro,w1sigmpro,w2mpro,w2sigmpro,w1snr,w2snr,cc_flags,ext_flg,nb,na,w1mjdmean,w2mjdmean FROM allwise_p3as_psd"),
    'twomass': ('2MASS PSC (IRSA fp_psc)', "SELECT designation,ra,dec,err_maj,j_m,h_m,k_m,j_cmsig,k_cmsig,ph_qual,jdate FROM fp_psc"),
}
GAIA_Q = "SELECT source_id, ra, dec, pmra, pmdec, pmra_error, pmdec_error, parallax, phot_g_mean_mag, bp_rp, ruwe FROM {t} WHERE phot_g_mean_mag < 20 AND pmra IS NOT NULL AND 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {r}))"

def votable_csv(t):
    import re
    if 'QUERY_STATUS" value="OK"' not in t or 'OVERFLOW' in t: raise IOError('votable not OK')
    cols = re.findall(r'<FIELD name="([^"]+)"', t)
    return ','.join(cols) + '\n' + '\n'.join(','.join(re.findall(r'<TD>(.*?)</TD>', r)) for r in re.findall(r'<TR>(.*?)</TR>', t, re.S)) + '\n'

def gaia_query(q_fmt, **kw):
    """Gaia DR3 by ADQL: AIP mirror, then IRSA's copy. -> (csv text, source)"""
    try: return votable_csv(get('https://gaia.aip.de/tap/sync', dict(REQUEST='doQuery', LANG='ADQL', FORMAT='votable', QUERY=q_fmt.format(t='gaiadr3.gaia_source', **kw)), tries=2, timeout=180)), 'gaia.aip.de gaiadr3.gaia_source'
    except Exception: pass
    t = get(IRSA, dict(QUERY=q_fmt.format(t='gaia_dr3_source', **kw), FORMAT='csv'))
    if not t.startswith('source_id'): raise IOError('gaia: ' + t[:200])
    return t, 'IRSA gaia_dr3_source'

def catalogues(d, ra, dec, r):
    """All catalogue snapshots of a cone, written to d. -> manifest entries. Any failure raises."""
    man = {}; cone = f" WHERE CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},{r}))=1"
    for name, (title, q) in CATS.items():
        f = f'{d}/{name}.csv'
        if not os.path.exists(f):
            t = get(IRSA, dict(QUERY=q + cone, FORMAT='csv'))
            if not t.startswith(q.split()[1].split(',')[0]): raise IOError(f'{name}: {t[:200]}')
            open(f, 'w').write(t)
        man[name] = dict(source=title, query=q + cone, rows=sum(1 for _ in open(f)) - 1, sha256=sha(f))
    f = f'{d}/gaia.csv'
    if not os.path.exists(f):
        t, src = gaia_query(GAIA_Q, ra=ra, dec=dec, r=r); open(f, 'w').write(t); open(f + '.src', 'w').write(src)
    man['gaia'] = dict(source='Gaia DR3 via ' + open(f + '.src').read(), rows=sum(1 for _ in open(f)) - 1, sha256=sha(f))
    f = f'{d}/simbad.csv'
    if not os.path.exists(f):
        q = f"SELECT main_id, otype, sp_type, ra, dec, pmra, pmdec FROM basic WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {r})) = 1"
        for host in ('simbad.harvard.edu', 'simbad.cds.unistra.fr'):
            try:
                t = get(f'https://{host}/simbad/sim-tap/sync', dict(REQUEST='doQuery', LANG='ADQL', FORMAT='csv', QUERY=q), tries=2, timeout=120)
                if t.startswith('main_id'): open(f, 'w').write(t); open(f + '.src', 'w').write(host); break
            except Exception: pass
        else: raise IOError('simbad unreachable')
    man['simbad'] = dict(source='SIMBAD via ' + open(f + '.src').read() + ' (identity only, read after scoring)', rows=sum(1 for _ in open(f)) - 1, sha256=sha(f))
    return man


# ---------- shared by the evaluator and the detector ----------
_wave = {}
def wave(det):
    """Interpolator (y, x on 0-based detector pixels) -> wavelength in microns, from web/data/wavemaps.json."""
    from scipy.interpolate import RegularGridInterpolator
    if det not in _wave:
        m = json.load(open(ROOT + '/web/data/wavemaps.json'))[det]
        _wave[det] = RegularGridInterpolator((np.array(m['y'], float) - 1, np.array(m['x'], float) - 1), np.array(m['lam']), bounds_error=False, fill_value=None)
    return _wave[det]

def pfac(ra, dec, mjd):
    """Parallax factors: a source of parallax p arcsec is displaced by p * (east, north) arcsec at time mjd.
    Observer taken at the Earth's centre (SPHEREx is in low Earth orbit), astropy's built-in ephemeris."""
    from astropy.time import Time
    from astropy.coordinates import get_body_barycentric
    X = get_body_barycentric('earth', Time(np.atleast_1d(mjd), format='mjd')).xyz.to_value('au'); a, d = np.radians(ra), np.radians(dec)
    return X[0] * np.sin(a) - X[1] * np.cos(a), X[0] * np.cos(a) * np.sin(d) + X[1] * np.sin(a) * np.sin(d) - X[2] * np.cos(d)

def track(ra, dec, pme, pmn, plx, mjd, mjd_ref):
    """Sky position at mjd of a source at (ra, dec) at mjd_ref (parallax not included in that reference position)."""
    dt = (np.atleast_1d(mjd) - mjd_ref) / 365.25; fe, fn = pfac(ra, dec, mjd)
    return ra + (pme * dt + plx * fe) / 3600 / np.cos(np.radians(dec)), dec + (pmn * dt + plx * fn) / 3600

# ---------- one field ----------
def field(name, ra, dec, size=SIZE, base=None):
    from astropy.io import fits
    from astropy.wcs import WCS
    d = f'{base or CACHE}/{name}'; os.makedirs(d + '/exp', exist_ok=True)
    if os.path.exists(d + '/manifest.json'): print(name, 'cached'); return
    half = size * 1800 + 60; edge = np.linspace(-half, half, 9)
    bra, bdec = untan(np.concatenate([edge, edge, 0 * edge - half, 0 * edge + half]), np.concatenate([0 * edge - half, 0 * edge + half, edge, edge]), ra, dec)
    L = sia(ra, dec, size * 0.75)
    def one(e):
        f = f"{d}/exp/{e['det']}_{e['obs']}.npz"
        if os.path.exists(f): return 'ok'
        for k in range(5):
            try:
                h = fits.open(S3 + e['key'], use_fsspec=True, fsspec_kwargs={'block_size': 2 ** 20}); hd = h['IMAGE'].header
                x, y = WCS(hd).all_world2pix(bra, bdec, 0, quiet=True); x0, x1, y0, y1 = (int(np.clip(v, 0, 2040)) for v in (x.min() - 8, x.max() + 9, y.min() - 8, y.max() + 9))
                if x1 - x0 < 16 or y1 - y0 < 16: return 'off'
                np.savez_compressed(f + '.tmp.npz', img=np.asarray(h['IMAGE'].section[y0:y1, x0:x1], np.float32), flg=np.asarray(h['FLAGS'].section[y0:y1, x0:x1]).astype(np.int32),
                                    x0=x0, y0=y0, hdr=hd.tostring(), t=float(hd['MJD-AVG'])); os.replace(f + '.tmp.npz', f); return 'ok'
            except Exception as err: last = err; time.sleep(3 * (k + 1))
        return 'FAILED ' + repr(last)[:200]
    with ThreadPoolExecutor(16) as ex: st = list(ex.map(one, L))
    bad = [(e['obs'], e['det'], s) for e, s in zip(L, st) if s.startswith('FAILED')]
    if bad: raise IOError(f'{name}: {len(bad)} exposures failed, e.g. {bad[:3]}')
    E = [dict(obs=e['obs'], det=e['det'], t=e['t'], coll=e['coll'], key=e['key'], file=f"exp/{e['det']}_{e['obs']}.npz") for e, s in zip(L, st) if s == 'ok']
    cats = catalogues(d, ra, dec, round(size * 0.75 + 0.05, 4))
    json.dump(dict(name=name, ra=ra, dec=dec, size=size), open(d + '/field.json', 'w')); json.dump(E, open(d + '/exposures.json', 'w'))
    ts = [e['t'] for e in E]
    man = dict(name=name, ra=ra, dec=dec, size=size, retrieved=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
               exposures=len(E), listed=len(L), off_patch=st.count('off'), by_det={k: sum(e['det'] == k for e in E) for k in ('D1', 'D2', 'D3', 'D4', 'D5', 'D6')},
               by_coll={c: sum(e['coll'] == c for e in E) for c in COLLS}, versions=sorted({e['key'].split('/')[3] for e in E}),
               mjd_range=[min(ts), max(ts)] if ts else None, d6_passes=[len(p) for p in passes([e['t'] for e in E if e['det'] == 'D6'])],
               catalogues=cats, files={e['file']: sha(f"{d}/{e['file']}") for e in E})
    json.dump(man, open(d + '/manifest.json', 'w'), indent=1)
    print(name, man['exposures'], man['by_det'], man['by_coll'], man['d6_passes'], {k: v['rows'] for k, v in cats.items()}, flush=True)

def epsf():
    """One ePSF table per detector (the injection writer's PSF), from the first DR1 exposure of a fixed week."""
    from astropy.io import fits
    os.makedirs(CACHE + '/epsf', exist_ok=True); man = {}
    for n in range(1, 7):
        key = f'dr1/level2/2025W19_1B/l2b-v27-2026-197/{n}/level2_2025W19_1B_0116_1D{n}_spx_l2b-v27-2026-197.fits'
        h = fits.open(S3 + key, use_fsspec=True, fsspec_kwargs={'block_size': 2 ** 20}); t = h['EPSF'].data; f = f'{CACHE}/epsf/D{n}.npz'
        np.savez_compressed(f, xc=np.array(t['XCENTER']), yc=np.array(t['YCENTER']), psf=np.array(t['EPSF'], np.float32), oversample=int(h['EPSF'].header['OVSMPX']))
        man[f'D{n}'] = dict(key=key, calibration=[c for c in h['EPSF'].header.get('HISTORY', []) if 'epsf' in str(c)], sha256=sha(f))
    json.dump(man, open(CACHE + '/epsf/manifest.json', 'w'), indent=1); print(man)

if __name__ == '__main__':
    c, a = sys.argv[1], sys.argv[2:]
    if c == 'field': field(a[0], float(a[1]), float(a[2]), float(a[3]) if len(a) > 3 else SIZE)
    elif c == 'epsf': epsf()
    elif c == 'cover': print(cover(float(a[0]), float(a[1])))
