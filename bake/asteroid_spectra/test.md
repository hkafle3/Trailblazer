# Asteroid spectra from SPHEREx stacks: the frozen test

Written 2026-11-16, before any asteroid in the test was measured. The rules below fix which asteroids are measured,
how, and what counts as a pass. Nothing here changes after results are seen. If something has to change, result.md
reports the result before and after the change and the changed version does not count as a pass.

What was looked at before writing this: one SPHEREx cutout of (7) Iris (not in the test) to read the file layout, the
FLAGS bit names and the ePSF table, and to check how the ePSF is normalised. Iris at about 560 mJy had its core pixels
flagged TRANSIENT (bit 0) and BLOOM (bit 26), which is why the brightest slots below have a flux ceiling.

## Question

Can TrailBlazer turn a known asteroid's SPHEREx photos into a clean reflectance spectrum by measuring the asteroid at its
predicted position in every exposure and stacking the exposures by wavelength channel?

## Data

- Exposures: IRSA's Moving Object Search Tool (MOST), catalog `spherex`, the asteroid's NAIF ID (20000000 + number),
  2025-05-01 to 2026-11-16. Keep images whose path is in DR1 (`/dr1/`) or QR3 (`/qr3/`); drop QR2. DR1 covers Surveys
  1 and 2 and QR3 covers Surveys 3 and 4, so they do not overlap.
- Position, heliocentric distance r, distance from SPHEREx delta and phase angle alpha at each exposure's midpoint: JPL
  Horizons with SPHEREx itself as the observer (`500@-163182`).
- Literature classes: JPL Small-Body Database (`spec_B`, the SMASSII Bus class, else `spec_T`, Tholen). Gaia DR3
  reflectance spectra: `gaiadr3.sso_reflectance_spectrum` from the Gaia archive.
- Solar spectrum: CALSPEC `sun_reference_stis_002.fits` (STScI).
- Stars: Gaia DR3 (VizieR I/355/gaiadr3) and 2MASS PSC (VizieR II/246/out), Gaia positions moved to the exposure
  date with their proper motions.

## Selection rule

Pool: numbered asteroids in SBDB with a Bus or Tholen class, queried 2026-11-16. The class used is Bus if present,
else Tholen. Classes marked uncertain (`:` or `(`) are dropped. When both exist they must fall in the same complex.

| Complex | Bus classes | Tholen classes | Expected SPHEREx call |
|---|---|---|---|
| S | S, Sa, Sk, Sl, Sq, Sr | S | banded (S-like) |
| C | C, Cb, Cg, Ch, Cgh | C | flat (C-like) |
| V | V | V | banded (S-like) |
| X | X, Xc, Xe | X, E, M, P | flat (C-like) |

Other classes (B, D, K, L, Q, Xk, A, T and so on) are not used. Orbit classes MBA, IMB, OMB, HIL and TJN are allowed;
MCA (Mars crossers) only in the faint slots F1 and F2; near-Earth objects never.

Predicted single-exposure SNR: for each MOST image on detectors D1 to D3 (0.75 to 2.42 um), predicted flux
`F = 3631 Jy x 10^(-0.4 (V - 0.3))` from MOST's `vmag` (the 0.3 mag is the Sun's V minus its AB magnitude near 1.25 um),
over a single-exposure noise of 0.018 mJy (the forecast single-frame 5 sigma of about 0.09 mJy). The asteroid's value is
the median over those images. `n_img` is the number of DR1 plus QR3 images.

Slots, filled in this order. Each takes the lowest-numbered asteroid that meets every condition and is not already
taken. "Gaia" means a Gaia DR3 reflectance spectrum exists; "Gaia preferred" means candidates with one are tried first.

| Slot | Complex | Predicted SNR | Other conditions |
|---|---|---|---|
| T0 (step 1) | S, Bus class exactly S | at least 100 | median predicted flux 2 to 20 mJy, Gaia, n_img at least 150 |
| S1 | S | at least 100 | predicted flux at most 20 mJy, Gaia, n_img at least 100 |
| S2 | S | 10 to 100 | Gaia, n_img at least 100 |
| S3 | S | 3 to 10 | Gaia preferred, n_img at least 100 |
| C1 | C | at least 100 | predicted flux at most 20 mJy, Gaia, n_img at least 100 |
| C2 | C | 10 to 100 | Gaia, n_img at least 100 |
| C3 | C | 3 to 10 | Gaia preferred, n_img at least 100 |
| V1 | V | at least 10 | Gaia preferred, n_img at least 100 |
| X1 | X | at least 10 | Gaia preferred, n_img at least 100 |
| F1, F2 | any of S, C, V, X | 1 to 3 (invisible in one exposure) | n_img at least 100, MCA allowed |

T0 is the step 1 asteroid. S1 to F2 are the confirmation set of 10. The chosen list is appended below in a separate
commit, made from predictions only, before any photometry.

## Measurement (identical for every asteroid)

1. Cutout 360 arcsec around the predicted position from IRSA, one per image.
2. Masked pixels: FLAGS bits 0, 1, 2, 6, 9, 10, 11, 15, 17 (the pipeline's bad bits, PERSIST is 17), 22, 23, 24
   (GHOST, GHOST_FPA, GHOST_EXT), 25 STREAK, 27 SNOWBALL, 28 HALO, 29 SATELLITE_HALO. Bit 21 SOURCE is never masked,
   because it also marks known asteroids.
3. Forced PSF photometry at the predicted position: the ePSF from the file's EPSF table (zone nearest the position on
   the detector, 5x oversampled, pixel-convolved, so native value = 25 x table value), sampled with cubic interpolation.
   Fit pixels within 3 pixels of the position; sky is the median of unmasked pixels 5 to 9 pixels away. Flux =
   sum(w P (d - sky)) / sum(w P^2), w = 1/VARIANCE. Noise from the same weights plus the sky median's error. If the
   fit's reduced chi-square is above 1, the noise is multiplied by its square root (this covers PSF mismatch on bright
   targets). The image is rejected if masked pixels carry more than 20% of the PSF weight inside the fit radius or the
   sky has under 50 pixels.
4. Stars: from Gaia and 2MASS, each star's flux at the exposure's wavelength is estimated from the nearest catalogue
   band (G, J, H, Ks in AB, Rayleigh-Jeans beyond Ks). The image is rejected if the stars' summed leak into the fit,
   `F_star x exp(-d^2 / (4 s^2))` with s from the header PSF_FWHM, exceeds 0.3 times the image's noise, or if any star in
   the sky ring (5 to 9 pixels) is brighter than 10 times the image's noise.
5. Geometry: each flux is scaled to the asteroid's median r0, delta0, alpha0 by `(r delta / r0 delta0)^2 x
   Phi(alpha0) / Phi(alpha)`, Phi the H-G phase function with SBDB's G (0.15 when missing).
6. Reflectance: flux over the CALSPEC solar flux at the image's wavelength, smoothed by a Gaussian of FWHM equal to the
   image's bandwidth (both from the spectral WCS).
7. Rotation: images within 10 minutes of each other form a burst; a burst shares one rotation state, and it includes
   the simultaneous partner detectors (D1 with D4, D2 with D5, D3 with D6). Each burst gets one factor A, the weighted
   mean ratio of its reflected-light images (under 3.5 um, SNR at least 5) to a spectrum built only from the other
   bursts (weighted mean within 2 channels in wavelength). Iterated 5 times, with the factors' geometric mean held at 1.
   Every image in the burst (thermal ones too) is divided by A and gets A's error added. A burst with nothing to
   compare keeps A = 1 and gets the measured rotation scatter (spread of the factors; 0.10 if fewer than 4 bursts have
   factors) added to its errors. Images days apart never correct each other directly.
8. Channels: 102, 17 per band, spaced geometrically between the band edges of the Explanatory Supplement Table 2
   (0.744-1.116, 1.099-1.651, 1.636-2.421, 2.423-3.822, 3.809-4.420, 4.412-5.002 um). An image goes to the channel of
   its detector's band that holds its wavelength.
9. Stack: inverse-variance weighted mean per channel. With 3 or more images, the error is multiplied by the square root
   of the reduced chi-square when that is above 1.
10. Reflectance is normalised to the mean of the channels centred within 0.95 to 1.05 um. Channels beyond 3.5 um are
    the thermal tail and are shown as flux separately.
11. Nulls: the same measurement (same images, same normalisation, star rejection redone at the null position, pixels
    within 5 pixels of the asteroid masked) at three positions 50 arcsec from the asteroid: perpendicular to its motion
    on both sides, and at 45 degrees between the motion and the first side (35 arcsec off the path).

## Pass bars (per asteroid)

- (a) Stacked SNR at least 5 in at least 30 of the 102 channels. Always reported as a count; the count for reflected
  light alone (under 3.5 um) is also given.
- (b) Nulls consistent with zero: |z| under 3 in at least 99% of the channels of the three null stacks pooled, and the
  broadband null stack (every image under 2.42 um) of each null under |z| = 3.
- (c) Where Gaia DR3 has a spectrum: the 0.75 to 1.0 um slope agrees with Gaia's within 2 combined sigma. Slope =
  b / a from a weighted straight-line fit `a + b (lambda - 0.875)` (per um), SPHEREx channels centred in 0.75 to 1.0 um,
  Gaia bands in the same range with flag 0. Reported, not part of the overall pass.
- (d) S versus C call from SPHEREx alone. Band depth `D = 1 - Rb / Rc`: Rb the mean reflectance of channels centred in
  0.88 to 1.00 um, Rc a straight continuum between the means over 0.75-0.80 and 1.45-1.65 um, taken at 0.94 um. Call
  S-like (banded) if D at least 0.05 and the 0.75 to 1.0 um slope is negative, otherwise C-like (flat). Pass if the
  call matches the complex's expected call in the table above.
- (e) Faint slots F1 and F2 only: median measured single-exposure SNR of the D1 to D3 images under 3, and the broadband
  stack (inverse-variance mean reflectance of every image under 2.42 um) at SNR at least 5.

Overall pass: (a), (b) for all 10 confirmation asteroids, (e) for F1 and F2, and (d) for at least 8 of the 10.

## Selection (from bake/asteroid_spectra/choose.py, predictions only)

Slots T0 to C2, committed while the selector was still searching later slots, before any photometry.

| Slot | Asteroid | Class (source) | Orbit | Predicted single-exposure SNR | Predicted flux (mJy) | Images (DR1+QR3) | Gaia DR3 |
|---|---|---|---|---|---|---|---|
| T0 | (60) Echo | S (Bus (SMASSII), Tholen S) | MBA | 795.71 | 14.3227 | 417 | yes |
| S1 | (17) Thetis | Sl (Bus (SMASSII), Tholen S) | MBA | 1088.31 | 19.5896 | 254 | yes |
| S2 | (228) Agathe | S (Bus (SMASSII), Tholen S) | MBA | 95.67 | 1.722 | 345 | yes |
| S3 | (1272) Gefion | Sl (Bus (SMASSII)) | MBA | 7.39 | 0.1331 | 273 | yes |
| C1 | (34) Circe | Ch (Bus (SMASSII), Tholen C) | MBA | 774.02 | 13.9324 | 253 | yes |
| C2 | (253) Mathilde | Cb (Bus (SMASSII)) | MBA | 89.7 | 1.6145 | 260 | yes |

Remaining slots, committed when the selector finished, before any of them was measured (only T0 had been cut out by then).

| Slot | Asteroid | Class (source) | Orbit | Predicted single-exposure SNR | Predicted flux (mJy) | Images (DR1+QR3) | Gaia DR3 |
|---|---|---|---|---|---|---|---|
| C3 | (2370) van Altena | Cb (Bus (SMASSII)) | MBA | 6.26 | 0.1127 | 298 | yes |
| V1 | (4) Vesta | V (Bus (SMASSII), Tholen V) | MBA | 275901.3 | 4966.2234 | 319 | yes |
| X1 | (16) Psyche | X (Bus (SMASSII), Tholen M) | MBA | 6438.04 | 115.8847 | 295 | yes |
| F1 | (2744) Birgitta | S (Bus (SMASSII), Tholen S) | MCA | 1.65 | 0.0297 | 152 | no |
| F2 | (3833) Calingasta | Cb (Bus (SMASSII)) | MCA | 1.44 | 0.0259 | 299 | no |

Known flaw in the rule, noticed on reading this list and before measuring: V1 and X1 have no flux ceiling, so they
picked (4) Vesta (predicted 5 Jy) and (16) Psyche (116 mJy), far brighter than the level at which Iris's core was
flagged. They stay in the counted set as chosen. Replacements under the 20 mJy ceiling (slots V1b, X1b, same rule plus
that ceiling) are measured and reported separately and do not count toward the pass.
