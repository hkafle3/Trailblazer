# Detector v3: final evaluation (2026-11-16)

Overall: FAIL. Four of the five frozen checks pass on the final fields; check 2 (planted slow movers) fails in one speed x flux bin. The run was made once, from the freeze commit 570e70f (final seed = that commit), with no change afterwards. Branch bake/detector-v3.

## Check table (final fields f01 to f20, single run)

| check | bar | measured | interval | result |
|---|---|---|---|---|
| 1 held-out T/Y dwarfs | at least 80% recovered (top 3 in field, motion within 20% and 15 deg) | 12 of 12 recovered, 0 invalid, all rank 1 | 90% Clopper-Pearson 0.78 to 1.00 | PASS |
| 2 planted methane dwarfs above the limit | every speed x W2 bin brighter than W2 14.0 at least 80% (13 of 16), and pooled | pooled 129 of 144 (90%); worst bin 11 of 16 (69%) at 0.6 to 1.2 arcsec/yr, W2 13.5 to 14.0; all other bins 13 of 16 or better | pooled 0.84 to 0.93; worst bin 0.45 to 0.87 | FAIL |
| 3 false candidates on real sky | one-sided 95% Poisson upper bound under 1.0 per sq deg, at least 3.0 usable sq deg incl. a field at abs(b) 10 to 20 | 0 false candidates in 5.69 usable sq deg (plane field f04: 0.28 sq deg); diagnostic nulls (4 catalogue shifts, 1 motion reversal, 20 fields each): 0 candidates in all 100 runs | upper bound 0.53 per sq deg | PASS |
| 4 artifacts | 0 candidates on glitches, glitch pairs, persistence, mask-edge rows, or Ed's flash | 0 candidates on 240 artifacts (5 mover records of any verdict near them, none a new candidate); flash present in its exposure (5,435 sigma peak), 0 candidates within 60 arcsec. Coverage caveat: of the 180 pixel artifacts, 100 were fully present in the inputs, 51 partly (for example one end of a pair fell off the cutout) and 29 not at all; the 60 mask-edge rows have no pixels by design | | PASS (frozen rule; the 29 absent artifacts tested nothing) |
| 5 non-dwarf movers | 0 called cold and at least 5 of 6 with a valid non-methane verdict | 0 cold; 6 of 6 reached the spectrum stage with a valid not_cold verdict | | PASS |

The evaluator's own table is in detector-v3/eval_final/table.md and the full detail in detector-v3/eval_final/eval.json.

Check 2 grid (recovered / planted; all eligible plants count, whatever happened to them):

| speed (arcsec/yr) | W2 11.5-12.5 | W2 12.5-13.5 | W2 13.5-14.0 | W2 14.0-14.5 | W2 14.5-15.0 | W2 15.0-15.5 |
|---|---|---|---|---|---|---|
| 0.3-0.6 | 15/16 | 13/16 | 14/16 | 15/16 | 11/16 | 0/16 |
| 0.6-1.2 | 16/16 | 15/16 | 11/16 | 10/16 | 8/16 | 1/16 |
| 1.2-3.0 | 16/16 | 14/16 | 15/16 | 14/16 | 6/16 | 3/16 |
| pooled | 98% | 88% | 83% | 81% | 52% | 8% |

Bins fainter than W2 14.0 are reported, not gated. Rejected draws while placing plants: 27 outside the usable map, 861 not isolated, 189 too close to another plant.

Why the 15 plants above the limit were missed (read from the frozen outputs after scoring; nothing was rerun):

| cause | plants | ids |
|---|---|---|
| no SPHEREx seed: the plant sits 13 to 24 arcsec from a brighter source (W2 9.9 to 12.9), and the 9 arcsec aperture map has no separate peak | 8 | f05-m06, f10-m02, f13-m09, f14-m15, f16-m04, f17-m02, f18-m10, f20-m08 |
| no SPHEREx seed: pixels flagged (HALO bit 28 and others) at the plant | 1 | f06-m12 |
| no CatWISE row (the evaluator withholds 2% of rows at random; they stay in the denominator) | 2 | f01-m01, f12-m09 |
| synthetic CatWISE motion drawn 0.39 arcsec/yr from the truth, under the 4 sigma mover cut | 1 | f08-m09 |
| SPHEREx displacement disagrees with the CatWISE motion (agreement chi-square 38 and 45; flux ratio 1.08 and 1.21 suggests a neighbour pulls the centroid) | 2 | f08-m01, f09-m02 |
| spectrum fit quality q 5.8 against the bar of 5 (W2 11.6, signal to noise 296) | 1 | f03-m03 |

The failing bin (0.6 to 1.2 arcsec/yr, W2 13.5 to 14.0) lost five plants to five different causes: f05-m06 (bright neighbour, no seed), f06-m12 (flagged pixels, no seed), f08-m09 (archive motion under 4 sigma), f09-m02 (motion disagreement) and f12-m09 (no CatWISE row). Fixing the bright-neighbour loss alone would give 12 of 16 there, still a fail. Across all bins above the limit the bright-neighbour seed loss is the largest single cause (8 of 15); it was seen on development fields (1 to 2 plants per bright bin) and deliberately left unfixed (development record below).

## Held-out targets (check 1)

| field | target | stratum | SpT | literature pm (arcsec/yr) | W2 | outcome | rank | measured pm | speed ratio | angle (deg) |
|---|---|---|---|---|---|---|---|---|---|---|
| f01 | WISEPA J213456.73-713743.6 | fast-faint | T9 pec | 1.38 | 13.96 | recovered | 1 | 1.42 | 1.027 | 1.9 |
| f02 | 2MASSI J1553022+153236 | slow-bright | T7 | 0.42 | 13.09 | recovered | 1 | 0.41 | 0.975 | 3.1 |
| f05 | WISEPA J050003.05-122343.2 | slow-faint | T8 | 0.73 | 14.10 | recovered | 1 | 0.86 | 1.180 | 5.2 |
| f08 | 2MASS J12255432-2739466 | slow-bright | T6 | 0.74 | 12.87 | recovered | 1 | 0.73 | 0.991 | 2.2 |
| f09 | SDSSp J162414.37+002915.6 | slow-bright | T6 | 0.37 | 13.13 | recovered | 1 | 0.38 | 1.020 | 1.0 |
| f11 | DENIS J081730.0-615520 | fast-bright | T6 | 1.11 | 11.28 | recovered | 1 | 1.09 | 0.980 | 0.4 |
| f12 | 2MASSI J1047538+212423 | fast-bright | T6.5 | 1.75 | 13.00 | recovered | 1 | 1.78 | 1.020 | 0.0 |
| f13 | 2MASS J23185497-1301106 | slow-faint | T5 | 0.83 | 13.81 | recovered | 1 | 0.82 | 0.986 | 0.1 |
| f14 | 2MASS J12314753+0847331 | fast-bright | T5.5 | 1.57 | 13.08 | recovered | 1 | 1.56 | 0.992 | 0.7 |
| f16 | WISEPA J041022.71+150248.5 | fast-faint | Y0 | 2.42 | 14.10 | recovered | 1 | 2.42 | 1.001 | 0.3 |
| f18 | 2MASS J05160945-0445499 | slow-faint | T5.5 | 0.30 | 13.68 | recovered | 1 | 0.30 | 0.996 | 1.0 |
| f19 | WISEPA J201824.96-742325.9 | fast-faint | T7 | 1.05 | 13.60 | recovered | 1 | 1.06 | 1.002 | 0.2 |

Each was the only candidate in its field. Spectrum and motion evidence per survivor (dchi2 is the methane evidence margin, cold needs 30; share is the dwarf templates' share of the 4 to 5 um light, cold needs 0.5):

| field | dchi2 | dwarf chi2/bin | dwarf share | spectrum S/N | motion significance | CatWISE rows merged | SPHEREx/W2 flux ratio |
|---|---|---|---|---|---|---|---|
| f01 | 189 | 0.71 | 0.62 | 57 | 79 | 3 | 1.13 |
| f02 | 4,056 | 0.85 | 1.00 | 125 | 36 | 1 | 0.87 |
| f05 | 170 | 0.75 | 0.58 | 39 | 41 | 2 | 2.37 |
| f08 | 4,733 | 0.39 | 0.95 | 231 | 57 | 2 | 1.06 |
| f09 | 2,427 | 0.55 | 1.00 | 104 | 29 | 1 | 0.90 |
| f11 | 10,032 | 0.44 | 0.97 | 652 | 89 | 2 | 0.79 |
| f12 | 1,739 | 0.65 | 0.85 | 149 | 145 | 2 | 1.02 |
| f13 | 2,478 | 1.45 | 0.93 | 115 | 42 | 2 | 0.91 |
| f14 | 4,694 | 0.91 | 0.95 | 150 | 113 | 3 | 0.91 |
| f16 | 30 | 1.21 | 0.52 | 22 | 84 | 2 | 0.86 |
| f18 | 1,737 | 0.65 | 1.00 | 81 | 23 | 1 | 0.91 |
| f19 | 485 | 0.53 | 0.84 | 55 | 54 | 2 | 0.99 |

M-dwarf controls (check 5): all six reached the spectrum stage, motions within 0.01 arcsec/yr of Gaia, verdict not_cold with dchi2 0 to 6 and dwarf share 0.01 to 0.11 (rejected by the share rule).

| field | control | Gaia pm | measured pm | dchi2 | dwarf share | spectrum S/N |
|---|---|---|---|---|---|---|
| f06 | Gaia DR3 3931845716842542080 | 0.34 | 0.339 | 1 | 0.04 | 2,798 |
| f07 | Gaia DR3 6574918563022096384 | 0.44 | 0.434 | 6 | 0.11 | 1,106 |
| f10 | Gaia DR3 1472282460851209984 | 0.31 | 0.313 | 2 | 0.06 | 1,241 |
| f15 | Gaia DR3 4007508575148453248 | 0.33 | 0.338 | 0 | 0.03 | 1,479 |
| f17 | Gaia DR3 2316780542865925760 | 0.33 | 0.330 | 0 | 0.02 | 594 |
| f20 | Gaia DR3 943755192838705792 | 0.33 | 0.335 | 0 | 0.01 | 1,398 |

## Plots

One astrometry + spectrum PNG per survivor and per control, drawn by the frozen detector's plot command:
- survivors: detector-v3/plots/survivors/f01-001.png, f02-001, f05-001, f08-001, f09-001, f11-001, f12-001, f13-001, f14-001, f16-001, f18-001, f19-001 (.png)
- controls (none failed; plotted for the record): detector-v3/plots/controls/f06_nearest_mover_f06-004.png, f07_nearest_mover_f07-001, f10_nearest_mover_f10-004, f15_nearest_mover_f15-003, f17_nearest_mover_f17-001, f20_nearest_mover_f20-002 (.png)

## Solid and not solid

Solid
- Motion. All 12 held-out dwarfs, at 0.30 to 2.42 arcsec/yr, came back as the top (and only) candidate in their fields; 11 of 12 have speed within 3% and direction within 3.1 deg of the literature. Three of them move slower than 0.5 arcsec/yr, where SPHEREx-only searches have failed.
- False candidates and artifacts. Zero non-target candidates in 5.69 usable sq deg, zero in 100 null runs, zero on the 211 planted artifacts that were at least partly present in the inputs (29 more were absent and tested nothing) and none near Ed's flash. The bound (0.53 per sq deg) is well under the bar.
- M dwarfs. Six of six Gaia M-dwarf movers measured correctly and classified not_cold on valid spectra.
- Bright plants. W2 11.5 to 12.5: 47 of 48 recovered.

Not solid
- Check 2 fails. Completeness falls to 69% in one bin above the limit, mostly because sources within about 25 arcsec of a brighter star get no SPHEREx seed. The development fields showed this loss at a smaller scale and I chose not to fix it before the freeze.
- The methane margin is thin for the faintest and coldest objects. WISE 0410+1502 (Y0, W2 14.1) passed with dchi2 30 against a cut of 30 and a dwarf share of 0.52 against 0.5; the four T5 to T8 templates do not describe a Y dwarf, so a Y dwarf only just passes. WISE 0500-1223 (share 0.58, flux ratio 2.37) and WISE 2134-7137 (share 0.62) also sit near the share cut.
- The impostor margin narrowed. After the nested-test change, non-dwarf controls on development fields reach dchi2 up to 18 against the cut of 30 (before the change they sat thousands below it). The M dwarfs are now rejected by the share rule, not by dchi2. Zero false candidates on the final fields is consistent with that margin but does not measure the tail.
- WISE 0500-1223's motion is 18% fast (bar 20%): the detector picked a fainter CatWISE fragment row (W2 14.9 against 14.1, flux ratio 2.37). This is the known CatWISE row-splitting problem for this target.
- The sample is small: 12 held-out dwarfs give a 90% interval of 0.78 to 1.00 for recovery, and the real sky searched is 5.7 sq deg.
- Development and final scores differ on check 2 (bin minimum 94% on development, 69% on final), so the development plants under-represented crowded spots.
## Development record (development fields only, before the freeze)

Every threshold or method change made while looking at development results, with before and after. All numbers are from development fields; no final-field output was opened before commit 570e70f.

| # | change | before | after | evidence |
|---|---|---|---|---|
| 1 | CAL_FLOOR (fractional flux error per bin), previous builder | 0.08 | 0.15 | two real non-template dwarfs failed the fit-quality cut at 0.08 (WISE 0435 q 3.4, 2MASS 0937 q 7.3); at 0.15 they pass with q 2.5 and 3.2 |
| 2 | Q_MAX (dwarf chi-square per bin), previous builder | 3 | 5 | same evidence as 1 |
| 3 | Single-exposure outlier clipping in the spectrum (CLIP = 8 sigma against the median of neighbouring samples within 0.05 um, or the 4 nearest within 0.15 um where sampling is sparse); also applied when building templates | none | on | first development score: one glitch sample (12 times the peak) made a bright plant fail with q 22.7; a random Gaia star reached dchi2 +11,714 (the "q 191 star" the previous builder saw) only because of one glitch. With clipping: that star 0, all 1,320 random stars max 0 |
| 4 | Spectrum test made nested: the dwarf model is the smooth alternatives plus the dwarf templates (a dwarf blended with a star is still a dwarf), with a new requirement SHARE_MIN = 0.5 (dwarf templates carry at least half of the modelled 4 to 5 um light); q now divides by bins minus non-zero coefficients | dwarf templates alone vs smooth alternatives | nested, share >= 0.5 | bright plants failed on blended starlight (one W2 11.7 plant had a stellar pedestal at 0.8 to 2 um and got dchi2 -2,089); WISE 0049 (real dwarf blended with a star) went from not_cold (dchi2 -2,744, q 26) to cold (dchi2 649, q 0.4) |
| 5 | Templates rebuilt with clipping | old file | new file | dwarf templates changed by at most 0.33 (one bin of 2MASS 0243), star templates by at most 0.14 |
| - | Tried, not adopted: dwarf templates times (lambda/4.5)^a for a in -0.5..0.5, and a free dwarf brightness per pass | | | tilt barely changed plant recovery (still 12/15 in the brightest bin of the first fields), improved the real dwarfs only slightly (q 1.4 to 1.1, 1.5 to 1.2) and widened the null tail (no-Gaia sources max 18 to 21, stars unchanged at 15, measured before the sparse-wavelength clipping fix); per-pass dwarf brightness made q worse. Not adopted, so the dwarf model has no slope or depth freedom tuned to the injection generator |
| - | Not done: a sharper seed map for sources near bright stars | | | development plants 15 to 25 arcsec from a much brighter source get no SPHEREx seed (the 9 arcsec aperture map has no separate peak). It cost 1 to 2 plants per bright bin; left as a known completeness loss, so there are no extra seeds and no change in false or artifact counts from it |

Effect of changes 3 to 5 on the development score (same plants, same inputs):

| quantity | first development score (before) | final development score (after) |
|---|---|---|
| check 1 held-out | 6 of 8 | 7 of 8 (WISE 0049 now recovered) |
| plants W2 11.5-12.5 / 12.5-13.5 / 13.5-14.0 / 14.0-14.5 (pooled over speed) | 42/48, 41/48, 43/48, 35/48 | 47/48, 47/48, 46/48, 37/48 |
| proposed W2 limit (frozen rule: each bin from the brightest at least 90%) | 11.5 (check 2 would be INVALID) | 14.0 |
| false candidates in 3.12 usable sq deg | 0 | 0 |
| artifact hits (132 artifacts) | 0 | 0 |
| null runs (55): candidates; movers reaching the spectrum stage | 0; 0 | 0; 0 |
| M-dwarf controls | 2 of 2 valid not_cold | 2 of 2 valid not_cold |

Methane evidence margin (dchi2 = chi-square of the smooth alternative minus that of the dwarf model; cold needs at least 30), measured on cached development photometry:

| control | before (old test) | after (frozen test) |
|---|---|---|
| development M-dwarf controls (Gaia DR3 2816946561275274880, 775305922653299328) | -30,806 and -13,168 | +2 and +8; both rejected by the share rule (dwarf share 0.05 and 0.16) |
| 1,320 random Gaia stars (120 per field, G 13 to 19.5) | max +11,714 (a glitch; q stopped it), next +1,119 | max +5 |
| 320 static CatWISE sources with no Gaia star within 3 arcsec, W2 < 14.5, reddest W1-W2 first (galaxies and AGN: the red and flat continuum control) | max -1 | max +18 (W1-W2 0.51); next +6 |
| null runs (catalogue shifted 90 arcsec four ways, motions reversed) | no mover reached the spectrum stage | no mover reached the spectrum stage |
| real development dwarfs | 2,610 to 37,257 (0049: -2,744) | 649 to 36,373 |
| faintest recovered development plants | | many between 30 and 80 |

Plainly: the nested test made the impostor margin much thinner. Before, non-dwarfs sat thousands below the cut; now the worst control sits 12 below it (18 against 30) and the weakest real plants sit just above it. The share rule, not dchi2, is what rejects the M dwarfs now.
## Deviations from the plan

Process and evaluator
1. Commit order: the evaluator (step 3, b5f0c1b) was committed before the selection rule and field lists (step 2, b03202a). Both precede any detector code.
2. Evaluator change after its freeze (7b8147a), before any plant or detector run: the injection-spectrum photometry now masks flagged pixels, uses a 3x3 box instead of 5x5 and despikes; WISE J0049+2151 was dropped from the injection set (its SPHEREx light is blended with a star). No gate or number changed. Before/after spectra: detector-v3/inject_spectra_before_fix.json and bake/detector_v3_inject_spectra.json.
3. The development M-dwarf gate needs 2 of 2 valid (the final gate needs 5 of 6, as frozen).
4. Plants get no synthetic AllWISE, Gaia or 2MASS rows (only a CatWISE row, I2); the detector never requires AllWISE. Plants and artifacts are drawn only inside the baseline usable map (the detector's own map). Check 1 does not use the map, so a held-out target in an excluded zone counts as a miss.
5. The injected ePSF is about 5% sharper than real stars (central pixel fraction 0.49 against 0.46 in D6), with wings beyond 3.5 px folded in; plant W2 is the mean f_nu over 4.0 to 5.0 um, not the W2 passband.
6. Null tests: the plan's "shuffled epochs" became the amended F3 form: CatWISE shifted 90 arcsec in four directions plus CatWISE motions reversed (5 runs per field), diagnostic only.
7. The independent tester kept by the amendments was run after the final scoring as a read-only Codex (gpt-6.1-sol) pass over the frozen outputs; its findings are summarised below.

Method
8. Data: DR1 first, QR3 for exposures DR1 lacks, never QR2 (as planned). The passes run 2025.4 to 2026.7; no 2027 data exist yet, so the SPHEREx lever is about one year, joined to CatWISE at 2015.4.
9. AllWISE is reported (corroboration flag) and never fitted, as amended (M2). No WISE image work.
10. Parallax is a nuisance on a fixed grid of 0 to 0.3 arcsec; no distance is claimed (M3).
11. Not implemented: known-asteroid exclusion (kete or SkyBoT). A solar-system object cannot follow a CatWISE proper-motion track across 11 years, and any survivor counts in the false burden anyway (accepted cut).
12. Gaia and 2MASS are never a veto by themselves; a Gaia star at the spot whose own motion disagrees with the fit rejects the link (the static/blend alternative).
13. Bright-star exclusion: 2MASS Ks < 9 zones of radius 20 + 25 (9 - Ks) arcsec are not searched. This loses real dwarfs near bright stars (2MASS J1503+2525 in development is 102 arcsec from a Ks 3.9 star).
14. Spectrum stage changes 3 and 4 in the development record (outlier clipping; nested test with a dwarf-share rule) are not in the plan's method sketch. They were made on development fields, logged above, and frozen.
15. Not done: candidates.json, web export and evidence strips (accepted cut); the offline outputs are the out.json records, the evaluator table and the PNGs.
16. After the last development run and before the freeze, only the version string and two plot labels changed (570e70f); the development scores were not rerun with the new version string.
17. Artifact coverage (amendment F5 asks that each artifact be confirmed present): the frozen evaluator records presence but does not invalidate on it. 29 of 180 pixel artifacts were not present in any input exposure and 51 only partly; check 4 is reported PASS under the frozen rule with that caveat, not as full F5 compliance.
18. Persistence artifacts (F5 says fixed detector coordinates across visits): the frozen evaluator plants a decaying source at one detector pixel over four consecutive D6 exposures within 0.02 days, one visit, not across visits.
19. M1 is implemented as a per-exposure translation: each exposure's offset from Gaia stars is measured and applied again in forced photometry (world2pix). The per-pass affine tie (and its stored inverse) is used for the stacked positions only and is not inverted in forced photometry.
20. Isolation of the detector: the run path reads the field directory, bake/detector_v3_templates.json, web/data/wavemaps.json and its own stage A cache (keyed on the input files); it reads no truth and no target list. The development-only templates command loads the whole bake/detector_v3_fields.json (which also lists the final targets) and then uses only the development entries. The docstring's "reads one field directory and nothing else" is therefore too strong.

## Independent tester

A read-only Codex (gpt-6.1-sol, high effort) pass over the frozen code and outputs (detector-v3/tester-report.md) found: no change to the detector, templates or freeze file after 570e70f and none to the evaluator after 7b8147a; no numerical mismatch between this table and eval_final/eval.json; agreement with all five results; every final candidate within 1.7 arcsec of its field's held-out target. It raised four points, all now reflected above: the artifact coverage caveat (17), the persistence design (18), the translation-only M1 (19), the templates command's access to the full field list (20), and an overstatement in my first draft, which said the bright-neighbour seed loss was the main reason check 2 fails; in the failing bin it accounts for one of five misses. It also noted that "final fields were never inspected before the freeze" and "scored exactly once" cannot be proven from the artifacts alone; the commit times and detector-v3/final.log (base 14:25, plant 14:45, runs 15:12, score 16:03, after the 570e70f push) are the record.

## Where things are

- Branch bake/detector-v3, worktree scratchpad/wt-detector-v3. Commits this session: aea6530 input manifest; 7441991 development spectrum changes; 570e70f freeze (detector, templates, bake/detector_v3_frozen.json).
- Outputs (scratchpad/detector-v3): eval_final/ and eval_dev/ (tables and detail), runs/final and runs/dev (out.json per run), truth/, plots/, final.log, tester-report.md. Development helper scripts are in detector-v3/src (samples.py, reclass.py, margins.py, why*.py, final_plots.py, tables.py).
