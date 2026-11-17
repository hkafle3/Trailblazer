"""SMDET-1 diagnostic, part 2: (a) which per-detector PSFs the frozen run has in this field, (b) a fixed-position forced
flux in each pass stack at the published track (same frozen PSF, neighbours and background plane as the frozen joint
fit, but positions held fixed; diagnostic only), (c) stamp plot of data, model and residual per pass, and the forced
spectrum against the Y and T9 templates."""
import sys, os, json, pickle, numpy as np
S = '/private/tmp/claude-501/-Users-edkiboma-Projects-yoshi/b096768d-88fe-4be7-90b6-16c0f7f75de8/scratchpad'; DD = S + '/detector-smdet1'; os.environ['DET_V4_OUT'] = DD
sys.path.insert(0, S + '/wt-detector-v4/bake'); import detector_v4 as D, detector_v3_fetch as F
from scipy import ndimage as ndi
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
ra0, dec0, pe, pn, t0 = 295.791939, 28.132809, 1.0595, 0.7143, 55972.68
sky = lambda mjd: (ra0 + pe * (mjd - t0) / 365.25 / 3600 / np.cos(np.radians(dec0)), dec0 + pn * (mjd - t0) / 365.25 / 3600)
def main():
    d = DD + '/cache/smdet1'; A = pickle.load(open(f'{DD}/stageA/{D.cache_key(d)}.pkl', 'rb')); P, N = A['P'], A['N']; R = json.load(open(DD + '/diag.json'))
    R['per_detector_psf_built'] = {k: (v is not None) for k, v in (A.get('dpsf') or {}).items()}
    used = [j for j, p in enumerate(A['passes']) if p['used']]; out = []; fig, ax = plt.subplots(len(used), 3, figsize=(9, 3 * len(used)))
    for row, j in enumerate(used):
        p = A['passes'][j]; st = A['stacks'][j]; cal = st['cal']; a, dd = sky(p['t']); x, y = F.tan(a, dd, P['ra'], P['dec']); u, v = D.apply(D.invert(np.array(cal['M3'])), x, y); x0, y0 = float(u) / D.OPIX + (N - 1) / 2, float(v) / D.OPIX + (N - 1) / 2
        G = A['gnb']; gx, gy = D.gaia_px(p, P, G, N); gpx, gpy = D.to_px(p, N, gx, gy); nb = D.neighbours(A['S'], j, x0, y0, gpx, gpy, G[:, 4])
        Rr = int(np.ceil(D.R_FIT)); xi, yi = int(round(x0)), int(round(y0)); Y, X = np.mgrid[yi - Rr:yi + Rr + 1, xi - Rr:xi + Rr + 1]; dat = st['s'][Y, X]; w = 1 / st['sig'][Y, X]; m = np.isfinite(dat) & ((X - x0) ** 2 + (Y - y0) ** 2 <= D.R_FIT ** 2)
        V = lambda px_, py_: ndi.map_coordinates(st['psf'], [D.PSF_H + Y - py_, D.PSF_H + X - px_], order=3, prefilter=False, cval=0.0)
        cols = [V(x0, y0)] + [V(q[0], q[1]) for q in nb] + [np.ones_like(X, float), X - x0, Y - y0]; Am = np.array([c[m] for c in cols]).T
        c = np.linalg.lstsq(Am * w[m][:, None], dat[m] * w[m], rcond=None)[0]; cov = np.linalg.inv((Am * w[m][:, None]).T @ (Am * w[m][:, None])); r2 = ((dat[m] - Am @ c) * w[m]) ** 2; chi2r = r2.sum() / max(m.sum() - len(c), 1); cov *= max(chi2r, 1)
        f, sf = c[0] * D.MJY_STACK * cal['apc'], np.sqrt(cov[0, 0]) * D.MJY_STACK * cal['apc']
        model = sum(cc * col for cc, col in zip(c, cols)); res = np.where(m, dat - model, np.nan)
        out.append(dict(year=round(p['year'], 3), neighbours=len(nb), flux_mjy=round(float(f), 4), sigma_mjy=round(float(sf), 4), snr=round(float(f / sf), 2), chi2r=round(float(chi2r), 2)))
        vmax = np.nanpercentile(np.abs(dat[m]), 99)
        for k, (img, t) in enumerate(((np.where(m, dat, np.nan), 'stack'), (np.where(m, model, np.nan), 'model: SMDET-1 + %d neighbours' % len(nb)), (res, 'residual'))):
            q = ax[row, k]; q.imshow(img, origin='lower', cmap='gray', vmin=-vmax * 0.2, vmax=vmax); q.plot(x0 - (xi - Rr), y0 - (yi - Rr), '+', color='#e33', ms=12); q.plot(nb[:, 0] - (xi - Rr), nb[:, 1] - (yi - Rr), 'o', mfc='none', color='#39f', ms=6) if len(nb) else None
            q.set_title(f"{p['year']:.2f} {t}" + (f"\nforced flux {f:.2f} +- {sf:.2f} mJy (expected 0.24)" if k == 2 else ''), fontsize=7); q.set_xticks([]); q.set_yticks([])
    fig.suptitle('SMDET-1: 4.5 um pass stacks, 3.08 arcsec pixels, fit window 24.6 arcsec; red + = published track, blue o = fitted neighbours (x = east, y = north)', fontsize=7); fig.tight_layout(); fig.savefig(DD + '/smdet1_stamps.png', dpi=120); plt.close(fig)
    tot = np.array([[o_['flux_mjy'], o_['sigma_mjy']] for o_ in out]); wv = 1 / tot[:, 1] ** 2; fm = float((tot[:, 0] * wv).sum() / wv.sum()); sm_ = float(np.sqrt(1 / wv.sum()))
    R['fixed_position_forced_flux'] = dict(per_pass=out, combined_mjy=round(fm, 4), combined_sigma_mjy=round(sm_, 4), combined_snr=round(fm / sm_, 2), expected_mjy_from_W2_14_65=0.2371, expected_snr=round(0.2371 / sm_, 2))
    # spectrum vs templates
    T = D.templates(); lam = np.array(T['lam']); fig, q = plt.subplots(figsize=(8, 4)); b = np.array(R['spectrum_what_if']['aperture']['bins'])
    q.errorbar(b[:, 0], b[:, 1], yerr=b[:, 2], fmt='.', color='#222', lw=0.8, label='SPHEREx forced aperture photometry on the published track (all passes)')
    for k, col in (('WISEPA J041022.71+150248.5 (smoothed)', '#0a7'), ('WISEPA J213456.73-713743.6 (smoothed)', '#c60')):
        q.plot(lam, np.array(T['dwarf'][k]) * 0.2371, '-', color=col, label=k.split(' (')[0][:20] + (' Y0' if '0410' in k else ' T9 pec') + ' template scaled to W2 14.65')
    q.axvspan(3.05, 3.65, color='#88f', alpha=0.12); q.axhline(0, color='#999', lw=0.5); q.set_xlabel('wavelength (um)'); q.set_ylabel('mJy'); q.legend(fontsize=7)
    sp = R['spectrum_what_if']['aperture']; q.set_title(f"frozen classify: {sp['verdict']} (dchi2 {sp['dchi2']:.0f}, dwarf share {sp['dwarf_share_45']:.2f}); the aperture holds neighbour light, the expected dwarf is the coloured line", fontsize=8)
    fig.tight_layout(); fig.savefig(DD + '/smdet1_spectrum.png', dpi=120); plt.close(fig)
    json.dump(R, open(DD + '/diag.json', 'w'), indent=1, default=float); print(json.dumps({k: R[k] for k in ('per_detector_psf_built', 'fixed_position_forced_flux')}, indent=1))
if __name__ == '__main__':
    main()
