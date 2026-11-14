# Prior art: public hunting for moving objects

Checked 2026-11-14. Short answer: many projects let the public find moving objects in optical or two-band WISE images. None we found does it on SPHEREx, and none gives every detection a spectrum.

| Project | Data | What the public does | Status | Results |
|---|---|---|---|---|
| [Backyard Worlds: Planet 9](https://backyardworlds.org) + WiseView | WISE/NEOWISE, 3.4 and 4.6 µm | Flip through multi-year WISE animations, flag movers (mostly brown dwarfs) | Active; already pairing finds with SPHEREx spectra (2026) | Hundreds of brown dwarfs |
| [Daily Minor Planet](https://www.zooniverse.org/projects/fulsdavid/the-daily-minor-planet) | Catalina Sky Survey, optical | Spot a dot moving across 4 frames; reported to the Minor Planet Center | Active, new data each clear night | Volunteer-found near-Earth asteroid |
| [Rubin Comet Catchers](https://www.zooniverse.org/projects/orionnau/rubin-comet-catchers) | Rubin LSST, optical | Tail or no tail on cutouts | Active (2026) | No count found |
| [Active Asteroids](https://arxiv.org/abs/2403.09768) | DECam archive, optical | Tail or coma, yes or no | Launched 2021 | 16 active bodies |
| [Kilonova Seekers](https://www.zooniverse.org/projects/tkillestein/kilonova-seekers) | GOTO, optical | Vote on new / reference / difference triplets in near real time | Active | 48 of GOTO's 2025 transients |
| [Hubble Asteroid Hunter](https://www.aanda.org/10.1051/0004-6361/202142998) | Hubble archive, optical | Mark asteroid trails; machine learning extended it | Paper phase | 1,031 trails not in the MPC |
| [IASC](https://astronomerswithoutborders.org) | Pan-STARRS | School teams measure movers; IASC vets and submits to the MPC | Yearly campaigns | 7,000+ asteroids since 2006 (self-reported) |
| Comet Hunters, Asteroid Zoo | Subaru HSC; Catalina | Spot tails; find movers | Finished | |
| SPHEREx public tools ([IRSA](https://irsa.ipac.caltech.edu/Missions/spherex.html)) | 0.75 to 5 µm, 102 bands | Download and view data. No volunteer project. | DR1 November 2026 | Professional work only (3I/ATLAS spectra, a solar-system catalog team) |

## What is new about doing it on SPHEREx

- **Every find comes with a spectrum.** Each detection sits in a narrow infrared band, and repeat shots step through 102 bands, so a dot can show the carbon dioxide (4.26 µm) and water (2.7 µm) glow of a comet, or the flat spectrum of bare rock. The projects above classify by shape only.
- **The whole sky, twice a year,** with several shots of each spot spread over a day or two (checked in real photo times: RW Aurigae was shot 6.4 and then 8.2 hours apart). Hours apart is enough for a comet to visibly move.
- **IRSA already hosts SPHEREx images of comet 3I/ATLAS,** a real comet for the guide's practice patch.
- **The catch:** each shot is a different wavelength, so a mover bright in one band may be faint in the next. Blink pairs should be matched in wavelength, which the time-lapse code already does.

## Ideas to borrow

- **Blink:** WiseView's flip with a contrast slider; Kilonova Seekers' new, reference and difference triplet.
- **Consensus:** several independent votes per dot before it counts. Hubble Asteroid Hunter paired volunteer marks with a model and expert review.
- **Confirming a find:** check known objects first (we use SkyBoT), then a person vets candidates before anything goes to the Minor Planet Center, as IASC and Daily Minor Planet do.
- **Credit:** name the volunteers on each find. A public page per comet with its finders is cheap and motivating.
- **Cutouts scale:** asking about one small cutout at a time (Active Asteroids, Comet Catchers) gets far more answers than asking people to scan whole images.

Not confirmed: current activity of Active Asteroids and Hubble Asteroid Hunter; exact Daily Minor Planet counts.
