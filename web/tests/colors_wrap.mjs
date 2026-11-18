// Right ascension across 0 degrees (Codex re-review 2): two blended sources either side of 0 merge near 0, not at 180, and a
// star at RA 0 is still found. The same check runs on the Python reference.
import { execFileSync } from 'node:child_process';
import { catalogueStep } from '../live/colors.js';
const cw = (name, ra, dec, w1) => ({ source_name: name, source_id: name, ra: String(ra), dec: String(dec), ra_pm: String(ra), dec_pm: String(dec), pmra: '0', pmdec: '0', sigpmra: '1', sigpmdec: '1',
  w1mpro_pm: String(w1), w1sigmpro_pm: '0.02', w2mpro_pm: String(w1), w2sigmpro_pm: '0.02', nb: '1', ab_flags: '00', cc_flags: '0000' });
const cats = { catwise: [cw('A', 359.9999, 10, 11), cw('B', 0.0001, 10, 11), cw('C', 0.05, 10.05, 12)], allwise: [], gaia: [], simbad: [], vsx: [],
  twomass: [{ designation: 'X', ra: '0.0', dec: '10', j_m: '12', h_m: '11.5', k_m: '11.3', j_cmsig: '0.02', h_cmsig: '0.02', k_cmsig: '0.02', ph_qual: 'AAA', jdate: '2451000' }] };
const ctx = catalogueStep(cats, 0.0, 10.0);
let fail = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); fail += !c; };
ok(!ctx.result, `JS: the star at RA 0 is found (${ctx.result?.reason ?? ctx.star.name}, ra ${ctx.star?.ra})`);
ok(ctx.star && (ctx.star.ra < 0.001 || ctx.star.ra > 359.999), 'JS: the merged pair sits at RA 0, not 180');
const py = execFileSync('/Users/edkiboma/Projects/comet-hunt-work/detector-decade/py.sh', ['-c', `
import sys; sys.path.insert(0, 'bake'); import colors_ref as C, numpy as np
K = C.merge(dict(ra=np.array([359.9999, 0.0001, 0.05]), dec=np.array([10., 10., 10.05]), w1=np.array([11., 11., 12.]), w2=np.array([11., 11., 12.]), e1=np.full(3, .02), e2=np.full(3, .02),
  name=np.array(['A', 'B', 'C']), nb=np.ones(3, int), pme=np.zeros(3), pmn=np.zeros(3)))
print(min(K['ra'][0], 360 - K['ra'][0]) < 0.001, K['nmem'][0], C.sep_as(K['ra'][0], K['dec'][0], 0.0, 10.0) < 2)`]).toString().trim();
ok(py === 'True 2 True', `Python: the merged pair at RA 0 and within 2 arcsec of the spot (${py})`);
process.exit(fail ? 1 : 0);
