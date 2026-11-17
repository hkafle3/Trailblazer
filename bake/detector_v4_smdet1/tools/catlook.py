import csv, numpy as np
D = '/private/tmp/claude-501/-Users-edkiboma-Projects-yoshi/b096768d-88fe-4be7-90b6-16c0f7f75de8/scratchpad/detector-smdet1/cache/smdet1'
ra0, dec0, pe, pn, t0 = 295.791939, 28.132809, 1.0595, 0.7143, 55972.68
at = lambda mjd: (ra0 + pe * (mjd - t0) / 365.25 / 3600 / np.cos(np.radians(dec0)), dec0 + pn * (mjd - t0) / 365.25 / 3600)
fl = lambda v: float(v) if v not in ('', 'null') else np.nan
for cat, epoch, kr, kd, cols in (('catwise', 57170.0, 'ra_pm', 'dec_pm', ['w1mpro_pm', 'w2mpro_pm', 'w2snr_pm', 'pmra', 'pmdec', 'sigpmra', 'sigpmdec', 'nb', 'ab_flags', 'cc_flags']), ('allwise', 55400.0, 'ra', 'dec', ['w1mpro', 'w2mpro', 'w2snr', 'pmra', 'pmdec', 'nb', 'cc_flags'])):
    a, d = at(epoch); print(cat, 'predicted', round(a, 6), round(d, 6))
    for r in csv.DictReader(open(f'{D}/{cat}.csv')):
        s = np.hypot((fl(r[kr]) - a) * np.cos(np.radians(d)), fl(r[kd]) - d) * 3600
        if s < 12: print('  sep %.1f' % s, {k: r[k] for k in cols})
a, d = at(57388.5)
for r in csv.DictReader(open(f'{D}/gaia.csv')):
    s = np.hypot((fl(r['ra']) - a) * np.cos(np.radians(d)), fl(r['dec']) - d) * 3600
    if s < 12: print('gaia sep %.1f' % s, r['phot_g_mean_mag'], r['pmra'], r['pmdec'])
