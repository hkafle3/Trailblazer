"""SMDET-1 diagnostic with the frozen v4 detector (734dc40): stage by stage, using only the frozen functions on the frozen
run's own stage-A products. What-if steps (forced joint fits and a forced spectrum on the published track) are
diagnostics, never part of the detector's decision."""
import sys, os, json, pickle, numpy as np
S = '/private/tmp/claude-501/-Users-edkiboma-Projects-yoshi/b096768d-88fe-4be7-90b6-16c0f7f75de8/scratchpad'; DD = S + '/detector-smdet1'; os.environ['DET_V4_OUT'] = DD
sys.path.insert(0, S + '/wt-detector-v4/bake'); import detector_v4 as D, detector_v3_fetch as F
from concurrent.futures import ProcessPoolExecutor
from scipy import ndimage as ndi
def main():
    d = DD + '/cache/smdet1'; o = json.load(open(DD + '/run/out.json')); A = pickle.load(open(f'{DD}/stageA/{D.cache_key(d)}.pkl', 'rb')); P, N, Sd = A['P'], A['N'], A['S']
    ra0, dec0, pe, pn, t0 = 295.791939, 28.132809, 1.0595, 0.7143, 55972.68
    global sky
    def sky(mjd): return ra0 + pe * (mjd - t0) / 365.25 / 3600 / np.cos(np.radians(dec0)), dec0 + pn * (mjd - t0) / 365.25 / 3600
    R = dict(paper=dict(ra=ra0, dec=dec0, mjd=t0, pmra=pe, pmdec=pn, w2=14.65, source='Meisner et al. 2026, arXiv:2608.00046, Table 1'))
    G, C, T, AW = D.read_cat(d); tie = D.tie_catwise(G, C, P); R['catwise_tie'] = tie
    used = [j for j, p in enumerate(A['passes']) if p['used']]; R['passes'] = [dict(year=round(p['year'], 3), exposures=p['exposures'], used=p['used'], tie_stars=p['stars']) for p in A['passes']]
    # 1 seed stage
    rows = []
    for j in used:
        p = A['passes'][j]; a, dd = sky(p['t']); x, y = F.tan(a, dd, P['ra'], P['dec']); u, v = D.to_px(p, N, x, y)
        dist = np.hypot(Sd['px'][:, j] - u, Sd['py'][:, j] - v); i = int(np.nanargmin(dist)); st = A['stacks'][j]
        ap = st['s']; rows.append(dict(year=round(p['year'], 3), predicted_px=[round(float(u), 1), round(float(v), 1)], nearest_seed_px=round(float(dist[i]), 2), nearest_seed_arcsec=round(float(dist[i]) * D.OPIX, 1), nearest_seed_snr=round(float(Sd['snr'][i, j]), 1), nearest_seed_flux_mjy=round(float(Sd['f'][i, j]), 3)))
    R['seed_stage'] = rows
    mx, my = F.tan(*sky(np.mean([A['passes'][j]['t'] for j in used])), P['ra'], P['dec']); ms = np.hypot(np.nanmean(Sd['x'], 1) - mx, np.nanmean(Sd['y'], 1) - my)
    R['seeds_within_6arcsec_of_mean_position'] = int((ms < 6).sum()); R['usable_at_target'] = bool(A['usable'][int(round(my / D.OPIX + (N - 1) / 2)), int(round(mx / D.OPIX + (N - 1) / 2))])
    # 2 archive stage
    cx, cy = F.tan(C[:, 0], C[:, 1], P['ra'], P['dec']); cx, cy = cx - tie['offset'][0], cy - tie['offset'][1]; mue, mun = C[:, 4] - tie['pm_offset'][0], C[:, 5] - tie['pm_offset'][1]
    se = np.hypot(C[:, 6] * tie['pm_scale'], D.PM_FRAC * np.hypot(mue, mun)); sn = np.hypot(C[:, 7] * tie['pm_scale'], D.PM_FRAC * np.hypot(mue, mun))
    x15, y15 = F.tan(*sky(57170.0), P['ra'], P['dec']); near = np.nonzero(np.hypot(cx - x15, cy - y15) < 12)[0]
    R['archive_stage'] = [dict(sep_2015_arcsec=round(float(np.hypot(cx[k] - x15, cy[k] - y15)), 2), w2=float(C[k, 9]), pm=[round(float(mue[k]), 3), round(float(mun[k]), 3)], pm_significance=round(float(np.hypot(mue[k] / se[k], mun[k] / sn[k])), 1),
                               valid_mover=bool(D.MU_MIN <= np.hypot(mue[k], mun[k]) <= D.MU_MAX and np.hypot(mue[k] / se[k], mun[k] / sn[k]) >= D.K_CW)) for k in near]
    mv = [m for m in o['movers'] if np.hypot((m['ra'] - sky(61000)[0]) * np.cos(np.radians(dec0)), m['dec'] - sky(61000)[1]) * 3600 < 10]
    R['mover_records_within_10arcsec'] = [dict(stage=m['stage'], path=m['path'], pm=m['pm']) for m in mv]
    # 3 what-if joint fits at the published track (frozen measure())
    fits = []
    for j in used:
        p = A['passes'][j]; cal = A['stacks'][j]['cal']; a, dd = sky(p['t']); x, y = F.tan(a, dd, P['ra'], P['dec']); u, v = D.apply(D.invert(np.array(cal['M3'])), x, y); u, v = float(u) / D.OPIX + (N - 1) / 2, float(v) / D.OPIX + (N - 1) / 2
        m = D.measure(A, j, u, v); fits.append(dict(year=round(p['year'], 3), start_px=[round(u, 2), round(v, 2)], result=None if m is None else dict(snr=round(m[3], 2), flux_mjy=round(m[4], 4), moved_arcsec=round(m[5]['moved'] * D.OPIX, 2), nearest_fitted_neighbour_arcsec=round(m[5]['sep'] * D.OPIX, 1), sigma_arcsec=round(m[2], 2), n_neighbours=m[5]['n_nb'], chi2r=round(m[5]['chi2r'], 2),
                                                                                                                       accepted_by_proposal_rule=bool(m[3] >= D.SNR_PASS and m[5]['sep'] >= D.MERGE_PX and m[5]['moved'] * D.OPIX <= D.LINK_R))))
    R['joint_fit_what_if'] = fits; R['expected_flux_mjy_from_w2'] = round(171787.0 * 10 ** (-0.4 * 14.65), 4)
    # 4 what-if spectrum along the published track (aperture and neighbour-fit photometry), frozen classify()
    G2 = G; ref = G[(G[:, 4] > 10.5) & (G[:, 4] < 17) & (np.hypot(G[:, 2], G[:, 3]) < 100)]
    with ProcessPoolExecutor(8) as ex: X = list(ex.map(D.prep, [(d, e, ref) for e in json.load(open(d + '/exposures.json'))], chunksize=8))
    x0, y0 = F.tan(*sky(D.MJD_CW), P['ra'], P['dec']); track = [float(x0), float(y0), pe, pn]; pt = [A['passes'][j]['t'] for j in used]
    m = dict(t=pt, track=track, f45_mjy=R['expected_flux_mjy_from_w2']); nbs = D.crowd_neighbours(A, m, G2); dpsf = A.get('dpsf') or D.det_psfs(X, G2, P)
    R['spectrum_what_if'] = {}
    for lab, nb in (('neighbour_fit', nbs), ('aperture', [])):
        sm = D.spectrum(X, P, track, 0.0, nb, dpsf); c = D.classify(sm, pt)
        R['spectrum_what_if'][lab] = {k: c.get(k) for k in ('verdict', 'why', 'dchi2', 'q_dwarf', 'dwarf_share_45', 'sn', 'n_samples', 'clipped', 'dwarf_mix')}; R['spectrum_what_if'][lab]['bins'] = c.get('bins'); R['spectrum_what_if'][lab]['model_dwarf'] = c.get('model_dwarf'); R['spectrum_what_if'][lab]['model_alt'] = c.get('model_alt')
    R['spectrum_what_if']['neighbours_used'] = len(nbs)
    json.dump(R, open(DD + '/diag.json', 'w'), indent=1, default=float)
    show = {k: v for k, v in R.items() if k != 'spectrum_what_if'}; print(json.dumps(show, indent=1, default=float)[:6000])
    for lab in ('neighbour_fit', 'aperture'): print(lab, {k: v for k, v in R['spectrum_what_if'][lab].items() if k not in ('bins', 'model_dwarf', 'model_alt')})


if __name__ == '__main__':
    main()
