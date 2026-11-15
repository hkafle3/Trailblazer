# Catalogs on a patch

Three catalogs, three jobs. A dashed circle on a frame is not "the catalog lists something here." It is drawn only when that exposure's pixels show the body. Gaia never draws one.

## Gaia: the star in the middle

`worker/src/index.js` `gaia` answers `GET /api/gaia?ra=&dec=`. It asks ESA for Gaia DR3 stars inside 0.04° that have a proper motion (`gaiadr3.gaia_source`). Positions are for epoch 2016.0.

`web/live/pipeline.js` moves each star forward to the date of the frames and keeps one star only if that path lands on the source SPHEREx measured, within about 4″ on average (2 pixels of slack if the core is saturated). The match is stored as `pred_east` and `pred_north` on the manifest. A miss, including a star Gaia cannot see, leaves the field unmatched. This is how the centered source is identified. It is not a comet or asteroid catalog.

## SkyBoT: comets and asteroids for this frame

`web/known.js` `asteroidsAt` calls `GET /api/known?ra=&dec=&t=&mv=21` once per frame time. `t` is the frame's MJD. The worker function `known` in `worker/src/index.js` asks IMCCE SkyBoT for a geocentric cone:

- epoch `t + 2400000.5` (Julian date)
- radius 0.15°
- `objFilter=101`: asteroids and comets, no planets

Comets are all kept. `mag` is null when SkyBoT sends no magnitude. Asteroids fainter than V magnitude 21 are dropped, the rest are sorted brightest first, and at most 8 are returned. An empty body (HTTP 204) is an empty list, not an outage. A failure is HTTP 503 `{ "error": "SkyBoT is not answering" }`. Successes are cached for a day. The page caches a success for the session and does not cache a failure, but it will not ask again for the same frame until the patch is opened again.

## Minor Planet Center: backup comet positions

`bake/comet_ephemeris.py` reads the Minor Planet Center comet-element file, keeps comets with perihelion in 2024–2028, and writes a daily two-body ephemeris:

- `web/data/comet_eph.json` — names and elements
- `web/data/comet_eph.bin` — float32 right ascension and declination, one position per comet per day

`web/known.js` `loadEph` loads both. `cometsAt` linearly interpolates to the frame's MJD.

`web/patch.js` `bodiesFor` uses those positions only when SkyBoT does not answer (`sky.error`). If SkyBoT answers, an empty comet list stays empty. The baked orbit is two-body and can sit arcminutes off the real place, because the elements are osculating at their own epoch. It is a backup, not a second circle.

## When a circle is drawn

`bodiesFor` turns a catalog position into an offset from the frame center (`inFrame` / `eastNorth`) and drops anything that falls outside the square picture. Each remaining body is passed to `sourceAt`.

`sourceAt` looks within 2 pixels (10″) of that position, so a bright star nearby is not counted as the catalog body. Then:

1. A saturated core (more than half the window is non-finite) counts as visible.
2. Otherwise the peak must be more than 3× the noise in the central 36×36 pixels. That is the same bar the centered star uses.
3. The peak must also survive the same asinh stretch `paint` uses to draw the picture, and come out at gray level 40 or higher. A 3× peak that the stretch paints as sky does not get a circle.

`knownLayer` draws a dashed circle only for bodies with `visible` true. A comet uses the class `kn comet`. An asteroid uses `kn ast`. The "Known objects" switch hides both, because they share the class `kn`. "Remove still stars" hides them too.

Bodies that are in the picture but fail `sourceAt` stay in the side panel (`catalogLine`). One hidden body is named. Several are counted. Hovering the note (`catalogTitle`) gives the reason: under 3× the noise, or above the noise but too faint to see against the stars.

The catalog magnitude is not that test. SkyBoT's V magnitude decides who is sent to the page. The pixels of this exposure decide who is circled.
