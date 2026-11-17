"""Blind crowded-sky purity test of the FROZEN detector v4 (bake/detector_v4.py as committed in 734dc40). DESIGN,
written and committed before any field is fetched or run. Running this file only draws the fields (needs SIA coverage
answers, cached on disk) and writes fields.json beside it.

Question: v4's final fields were centred near known dwarfs, so its "0 false candidates" need not hold for a blind survey
of crowded sky. What is the candidate rate per sq deg, and what are the candidates, on randomly drawn low-latitude
fields? And how complete is v4 there for injected cold movers?

FIELDS (seeded random draw, seed string SEED below, numpy default_rng from its sha256)
  sky: |b| < 10 deg, the whole sky in longitude
  strata by longitude distance from the Galactic centre, dl = min(l, 360 - l): S1 0-30 (bulge and inner disc),
    S2 30-90, S3 90-150, S4 150-180 (anticentre); 7 fields per stratum, 28 fields of 0.56 x 0.56 deg
  draw within a stratum: l uniform over its two longitude ranges, b uniform in -10..10 (area-uniform to 1.5%)
  a draw is kept if (in order): it is at least 2 deg from every v3 field (development and final, 31) and every v4 final
    field (22), the only exclusion; it is at least 1.5 deg from every field already kept; SIA footprints give at least
    2 passes of at least 8 D6 exposures and at least 8 D4 exposures at the centre (v3's E7). Rejections are recorded.
  replacement: a kept field whose fetch fails is replaced by the next kept draw of the same stratum (recorded)
  expected usable area: about 0.21 to 0.28 sq deg per field (SMDET-1's plane field gave 0.21), so about 6 to 7.5 sq
    deg; the area actually used is whatever the frozen detector's usable maps give, summed (fields do not overlap)

RUN: frozen v4 once per field (python -I bake/detector_v4.py run <field dir> <out.json>), detector files checked
  identical to 734dc40 before the run; stage-A cache in the experiment's own directory; nothing tuned.

CANDIDATES (classified only after the run, never fed back): every candidate in the baseline runs is cross-matched
  within 6 arcsec (motion within 20% and 15 deg where the catalogue has motion) against the UltracoolSheet v2.1.0
  snapshot, SIMBAD (the per-field snapshot fetched with the inputs), MOCAdb (Gagne et al.) and Schneider et al. 2026
  (arXiv:2604.01323) when reachable, and Gaia DR3 (the field snapshot). Classes: known cold dwarf (T or Y), known
  non-dwarf (any other classified object, including Gaia stars whose motion matches), artifact (stamp shows a single-
  exposure, edge or mask feature), unexplained. Each candidate gets a stamp (pass stacks with the fitted track) and its
  spectrum against the templates. Rate: candidates per usable sq deg with the one-sided 95% Poisson upper bound,
  overall and excluding known cold dwarfs.

COMPLETENESS: injected movers written by the frozen evaluator's own writer (detector_v4_eval.inject, spectrum_fn,
  synth_row, its calibrated injection PSF with the 0 to 0.3 px blur): 3 speed bins (0.3-0.6, 0.6-1.2, 1.2-3.0
  arcsec/yr, log-uniform) x 3 W2-proxy bins (11.5-12.5, 12.5-13.5, 13.5-14.0) x 10 = 90 plants, fields in rotation,
  positions uniform inside the baseline usable map, at least 60 arcsec from the edge and 150 arcsec from each other,
  with NO isolation rule (blind crowded sky). Each plant gets a CatWISE row by the evaluator's legacy model (98% of
  rows kept, donor errors x 1.3), appended to the catalogue. Declared limit: an appended clean row is optimistic in
  crowded sky (the A10 concern), so completeness is reported for all plants and separately for plants with a CatWISE
  row brighter than plant W2 + 1 within 24 arcsec. Recovered = candidate one to one within 6 arcsec at MJD 61000 with
  motion within 20% and 15 deg (the evaluator's rule). Plant seed: PLANT_SEED.
REPORT: rate with bound, candidate breakdown with stamps and spectra, completeness per bin and pooled with 90%
  Clopper-Pearson intervals, unexplained candidates worth follow-up.
"""
import sys, os, json, hashlib, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE))
import detector_v3_fetch as F
import detector_v3_select as S3
SEED, PLANT_SEED = 'detector-v4-blind-2026-11-17', 'detector-v4-blind-plants-2026-11-17'
OUT = os.environ.get('DET_BLIND_OUT', os.path.dirname(F.OUT) + '/detector-blind')
S3.F.CACHE = OUT + '/cache'                      # SIA answers cached in the experiment's own cache/select
STRATA = [('S1', 0, 30), ('S2', 30, 90), ('S3', 90, 150), ('S4', 150, 180)]
N_PER, B_MAX, EXCL, APART = 7, 10.0, 2.0, 1.5

def main():
    V3 = json.load(open(os.path.dirname(HERE) + '/detector_v3_fields.json')); V4 = json.load(open(os.path.dirname(HERE) + '/detector_v4_fields.json'))
    excl = [(f['ra'], f['dec']) for f in V3['dev'] + V3['final'] + V4['final']]
    rng = np.random.default_rng(int(hashlib.sha256(SEED.encode()).hexdigest()[:12], 16)); kept, log = [], []
    for name, lo, hi in STRATA:
        got, tries = 0, 0
        while got < N_PER + 2 and tries < 400:          # 2 predeclared replacements per stratum
            tries += 1; dl = rng.uniform(lo, hi); l = float(dl if rng.random() < 0.5 else (360 - dl) % 360); b = float(rng.uniform(-B_MAX, B_MAX))
            ra, dec = S3.galactic(l, b, inverse=True); ra, dec = round(ra, 4), round(dec, 4)
            why = ('within 2 deg of a v3/v4 field' if any(S3.sepdeg(ra, dec, a, d) < EXCL for a, d in excl) else
                   'within 1.5 deg of a kept field' if any(S3.sepdeg(ra, dec, k['ra'], k['dec']) < APART for k in kept) else None)
            if why is None:
                cov = S3.cover(ra, dec)
                if not (sum(n >= 8 for n in cov['d6_per_pass']) >= 2 and cov['d4'] >= 8): why = f'E7 coverage {cov["d6_per_pass"]} D4 {cov["d4"]}'
            if why: log.append(dict(stratum=name, l=round(l, 3), b=round(b, 3), excluded=why)); continue
            kept.append(dict(field=f'b{len(kept) + 1:02d}', stratum=name, l=round(l, 3), b=round(b, 3), ra=ra, dec=dec, role='field' if got < N_PER else 'replacement')); got += 1
    json.dump(dict(seed=SEED, plant_seed=PLANT_SEED, strata=STRATA, fields=kept, rejected=log, detector_commit='734dc40'), open(HERE + '/fields.json', 'w'), indent=1)
    print([(k['field'], k['stratum'], k['l'], k['b'], k['role']) for k in kept], len(log), 'rejected')

if __name__ == '__main__':
    main()
