"""Dump colors_ref intermediates without reimplementing its science.
Usage: py.sh bake/colors_dump.py FIELD_DIR RA DEC [OBS ...] (five named obs/file values).
Defaults to the first five exposures on the star; records their names in manifest.json.
"""
import os
import sys
import json
import numpy as np
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import colors_ref as C

BASE = '/Users/edkiboma/Projects/comet-hunt-work/colors-build/dumps'


def dump_numerics(out):
    """Small SciPy probes, including boundaries and float32 intermediate results."""
    from scipy import ndimage as ndi
    import scipy
    a = (np.sin(np.arange(37 * 43).reshape(37, 43) * .13) + 3).astype(np.float32)
    a[:16, :16] = np.nan
    a[20, 20] = 100
    p = (np.arange(225, dtype=float).reshape(15, 15) / 100) ** 1.3
    coords = [[0, 0], [-1e-9, 2], [14, 14], [14 + 1e-9, 2], [.3, 1.7]]
    c = ndi.spline_filter(p, order=3)
    flags = np.zeros(a.shape, np.int32)
    flags[0, -1] = 1 << 26
    flags[18, 24] = 1 << 1
    flags[24, 24] = 1 << 22
    prepared = C.prep(dict(img=a, flg=flags, x0=0, y0=0, t=58000, det='D1', obs='probe', hdr=''), None)
    rnd = C.mulberry32(C.BOOT_SEED)
    probe = dict(scipy=scipy.__version__, rng=[rnd() for _ in range(32)], mesh_input=a.tolist(), mesh=C.mesh(a, 16).tolist(),
                 spline_input=p.tolist(), spline=c.tolist(), coords=coords,
                 mapped=ndi.map_coordinates(c, np.array(coords).T, order=3, prefilter=False,
                                            cval=0, mode='constant').tolist(),
                 shift=ndi.shift(p, (.3, -.4), order=3, mode='nearest').tolist(),
                 wave={d: C.wave(d)([[0, 0], [500.3, 900.7], [-10, 2050]]).tolist() for d in C.DETS},
                 median=float(np.median([3, 1, 2, 7])),
                 percentile=np.percentile([3, 1, 2, 7], [16, 50, 84]).tolist(),
                 interp=np.interp([-1, .5, 4], [0, 1, 3], [2, 4, 1]).tolist(),
                 digitize=np.digitize([-.1, 0, 1, 3], [0, 1, 3]).tolist(),
                 inverse=np.linalg.inv([[4., 2], [1, 3]]).tolist(),
                 prep_flags=flags.tolist(), prep_bad=prepared['bad'].tolist(),
                 prep_sub=prepared['sub'].tolist(), prep_sig=prepared['sig_ap'])
    json.dump(C.clean(probe), open(f'{out}/numerics.json', 'w'))


def main(field, ra, dec, names=()):
    ra, dec = float(ra), float(dec)
    out = f'{BASE}/{os.path.basename(os.path.normpath(field))}'
    os.makedirs(out, exist_ok=True)
    dump_numerics(out)
    manifest = {'exposures': [], 'wcs': []}
    original_psfs, original_source = C.psfs, C.per_source
    original_executor = C.ProcessPoolExecutor
    exposure_names = {}

    class RecordingExecutor:
        def __init__(self, *args, **kwargs):
            self.executor = original_executor(*args, **kwargs)

        def __enter__(self):
            self.executor.__enter__()
            return self

        def __exit__(self, *args):
            return self.executor.__exit__(*args)

        def map(self, fn, args, **kwargs):
            args = list(args)
            result = list(self.executor.map(fn, args, **kwargs))
            if fn is C._fit:
                named = [dict(component=int(r[0]), obs=exposure_names[(arg[0]['t'], arg[0]['det'])],
                              det=arg[0]['det'], row=list(r))
                         for arg, rows in zip(args, result) for r in rows]
                json.dump(C.clean(named), open(f'{out}/stamp_rows.json', 'w'))
            return iter(result)

    def psfs(X, K):
        exposure_names.update({(a['t'], a['det']): a['obs'] for a in X})
        chosen = [a for a in X if not names or a['obs'] in names or f"{a['det']}_{a['obs']}" in names][:5]
        if len(chosen) != 5:
            raise ValueError('select exactly five exposures on the star')
        for i, a in enumerate(chosen):
            prefix = f'prep{i}'
            np.save(f'{out}/{prefix}.bad.npy', a['bad'])
            np.save(f'{out}/{prefix}.sub.npy', a['sub'])
            manifest['exposures'].append(dict(obs=a['obs'], det=a['det'], prefix=prefix,
                                              sig_ap=a['sig_ap'], shift=a['shift'], nstar=a['nstar']))
        for a in X[:3]:
            points = [(ra, dec), (ra + .01, dec + .01), (ra - .02, dec - .01)]
            manifest['wcs'].append(dict(obs=a['obs'], det=a['det'], points=[
                dict(ra=r, dec=d, pixel=[float(v) for v in a['w'].pix(r, d)]) for r, d in points]))
        P = original_psfs(X, K)
        manifest['psf_stamps'] = {d: P[d + '_n'] for d in C.DETS}
        for d in C.DETS:
            if P[d] is not None:
                np.save(f'{out}/{d}.psf.npy', P[d])
        return P

    def per_source(rows, idx, passes):
        S = original_source(rows, idx, passes)
        json.dump(C.clean({str(i): {str(k): [v.tolist() for v in pair] for k, pair in r.items()}
                           for i, r in S.items()}), open(f'{out}/spectra.json', 'w'))
        return S

    C.psfs, C.per_source, C.ProcessPoolExecutor = psfs, per_source, RecordingExecutor
    try:
        result = C.build(C.load_field(field), C.load_exposures(field), float(ra), float(dec))
        if not isinstance(result, tuple):
            raise ValueError(result)
        res, rows = result
        np.save(f'{out}/stamp_fit.npy', rows)
        json.dump(C.clean(manifest), open(f'{out}/manifest.json', 'w'), indent=1)
        json.dump(C.clean(res), open(f'{out}/result.json', 'w'), indent=1)
        print(out, len(rows), 'stamp fits', flush=True)
    finally:
        C.psfs, C.per_source, C.ProcessPoolExecutor = original_psfs, original_source, original_executor


if __name__ == '__main__':
    main(*sys.argv[1:4], names=sys.argv[4:])
