"""Bake the one real photo the 3D intro (web/intro.js) looks at up close, and what is in it, into web/data/intro/.
  photo.jpg    the first SPHEREx photo in the public archive (2025W17_4B_0001_1, detector 1, 24 April 2025), zodiacal
               light model subtracted, resampled onto the square of its tile in tiles.bin (tile 0): pixel (i, j) is
               direction c + u e + v f with u, v = -1..1 across and down, f = c x e. 2048 px, about the photo's own pixels.
  sheba.png    the photo's own pixels around asteroid Sheba (192 x 192 detector pixels, the stretch of photo.jpg), for the
               film's push-in; photo.json "zoom" says where its four corners sit in the square.
  galaxy.jpg   the galaxy in the photo as the Sloan Digital Sky Survey saw it (SkyServer DR18 colour cutout, 72 arcseconds
               wide, north up, east left; CC-BY, credit Sloan Digital Sky Survey), for the film's flight past it.
  photo.json   the wavelength of every point of that square (a fit to web/data/wavemaps.json D1), where known things
               sit in it and how far away they are, the star the film follows and its measured spectrum.
Real distances: asteroids from IMCCE SkyBoT at the photo's time (geocentric), stars from Gaia DR3 parallaxes (IRSA),
the galaxy from its redshift in the 2MASS Redshift Survey (Huchra et al. 2012, VizieR J/ApJS/199/26) with H0 = 70 km/s/Mpc.
Real star colours: each star's Gaia DR3 temperature (teff_gspphot), turned into the colour of a black body that hot.
The star's spectrum comes from bake/intro_spectrum.py (the app's own measurement code). Inputs are kept in
bake/cache/intro/ and fetched when missing (the photo is 65 MB).
Run: uv run -q --with astropy --with numpy --with pillow --with certifi python bake/intro_photo.py"""
import json, math, ssl, struct, urllib.parse, urllib.request
from pathlib import Path

import certifi
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
OUT, CACHE = REPO / "web/data/intro", REPO / "bake/cache/intro"
OBS = "2025W17_4B_0001_1"
FITS_URL = f"https://nasa-irsa-spherex.s3.amazonaws.com/dr1/level2/2025W17_4B/l2b-v27-2026-196/1/level2_{OBS}D1_spx_l2b-v27-2026-196.fits"
STAR = "735835070124268800"       # the Gaia DR3 star the film follows (G 12.8: bright, not saturated, alone)
GALAXY = "10421099+3047551"       # 2MASX id, 2MRS redshift from SDSS
ZOOM, ZN = "Sheba", 96            # the asteroid the film pushes in on, and half the width of its cutout in detector pixels
SHOW = {"asteroid": ["Sheba", "Pyrrhus"], "star": ["735874686902617984", STAR]}   # the nearest bright one, and the one the film follows
N, EPS, H0, LY_PER_MPC, AU_PER_LY = 2048, math.radians(23.4392911), 70.0, 3.26156e6, 63241.08
BAND = (0.75, 1.11)               # detector 1, web/live/spectral.js SP_BANDS


def cached(name, url, data=None):
    p = CACHE / name
    if not p.exists():
        print("fetching", name, flush=True); CACHE.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers={"User-Agent": "intro-bake/1"}), timeout=600, context=ssl.create_default_context(cafile=certifi.where())) as r: p.write_bytes(r.read())
    return p


def blackbody_rgb(teff):
    """sRGB colour (0..1, brightest channel 1) of a black body: Planck's law through the CIE 1931 observer
    (the analytic fit of Wyman, Sloan and Shirley 2013), then the sRGB matrix and curve."""
    lam = np.arange(380.0, 781.0, 1.0); g = lambda mu, s1, s2: np.exp(-.5 * ((lam - mu) / np.where(lam < mu, s1, s2)) ** 2)
    x = 1.056 * g(599.8, 37.9, 31.0) + .362 * g(442.0, 16.0, 26.7) - .065 * g(501.1, 20.4, 26.2)
    y = .821 * g(568.8, 46.9, 40.5) + .286 * g(530.9, 16.3, 31.1); z = 1.217 * g(437.0, 11.8, 36.0) + .681 * g(459.0, 26.0, 13.8)
    B = (lam * 1e-9) ** -5 / np.expm1(1.438777e-2 / (lam * 1e-9 * teff)); X, Y, Z = (float((B * c).sum()) for c in (x, y, z))
    rgb = np.clip(np.array([[3.2406, -1.5372, -.4986], [-.9689, 1.8758, .0415], [.0557, -.2040, 1.0570]]) @ [X, Y, Z], 0, None); rgb /= rgb.max()
    return [round(float(v), 3) for v in np.where(rgb <= .0031308, 12.92 * rgb, 1.055 * rgb ** (1 / 2.4) - .055)]


def ecl(ra, dec):
    a, d = np.radians(ra), np.radians(dec); x, y, z = np.cos(d) * np.cos(a), np.cos(d) * np.sin(a), np.sin(d)
    return np.stack([x, math.cos(EPS) * y + math.sin(EPS) * z, -math.sin(EPS) * y + math.cos(EPS) * z], -1)


def eq(v):
    x, y, z = v[..., 0], v[..., 1], v[..., 2]; ye, ze = math.cos(EPS) * y - math.sin(EPS) * z, math.sin(EPS) * y + math.cos(EPS) * z
    return np.degrees(np.arctan2(ye, x)) % 360, np.degrees(np.arcsin(ze / np.sqrt(x * x + ye * ye + ze * ze)))


def sexa(s, hours):
    a, b, c = (abs(float(x)) for x in s.split())
    return (-1 if s.strip().startswith("-") else 1) * (a + b / 60 + c / 3600) * (15 if hours else 1)


# ---- the tile's own square: tile 0 of tiles.bin, exactly as intro.js reads it ----
t0, *q = struct.unpack_from("<f6h", (OUT / "tiles.bin").read_bytes(), 0)
c, e = np.array(q[:3]) / 32767, np.array(q[3:]) / 32767 / 16; f = np.cross(c, e)
def uv(ra, dec):
    d = ecl(np.asarray(ra, float), np.asarray(dec, float)); d = d / (d @ c)[..., None] - c
    return d @ e / (e @ e), d @ f / (f @ f)

# ---- the photo ----
with fits.open(cached("first_d1.fits", FITS_URL)) as h:
    hd = h["IMAGE"].header; w = WCS(hd)
    assert hd["OBSID"] == OBS and abs(hd["MJD-AVG"] - 60789 - t0) < 0.002, "tiles.bin tile 0 is not this photo"
    img = h["IMAGE"].data.astype(np.float32) - h["ZODI"].data.astype(np.float32)
mjd = float(hd["MJD-AVG"])
for _ in range(4):   # holes (saturated star cores, bad pixels) take the mean of what is around them
    bad = ~np.isfinite(img)
    if not bad.any(): break
    p = np.pad(img, 1, constant_values=np.nan)
    with np.errstate(all="ignore"): m = np.nanmean(np.stack([p[1 + a:p.shape[0] - 1 + a, 1 + b:p.shape[1] - 1 + b] for a in (-1, 0, 1) for b in (-1, 0, 1)]), 0)
    img[bad] = m[bad]
img = np.nan_to_num(img, nan=0.0)
g = (np.arange(N) + .5) / N * 2 - 1; U, V = np.meshgrid(g, g)
px, py = w.all_world2pix(*eq(c + U[..., None] * e + V[..., None] * f), 0)
ix, iy = np.clip(np.floor(px).astype(int), 0, 2038), np.clip(np.floor(py).astype(int), 0, 2038); fx, fy = np.clip(px - ix, 0, 1), np.clip(py - iy, 0, 1)
pic = (img[iy, ix] * (1 - fx) + img[iy, ix + 1] * fx) * (1 - fy) + (img[iy + 1, ix] * (1 - fx) + img[iy + 1, ix + 1] * fx) * fy
lo, hi = np.percentile(pic, 45), np.percentile(pic, 99.93)
s = np.arcsinh(np.clip((pic - lo) / (hi - lo), 0, None) * 10) / np.arcsinh(10)
Image.fromarray((np.clip(s, 0, 1) * 255).astype(np.uint8)).save(OUT / "photo.jpg", quality=86, optimize=True)   # row 0 is v = -1 (flipY off in intro.js)

# ---- wavelength over the square: the app's map for detector 1 (pixel -> microns), fitted with a small polynomial ----
wm = json.loads((REPO / "web/data/wavemaps.json").read_text())["D1"]
def lam_pix(x, y):   # web/live/fits.js wavelengthAt
    gx, gy, A = np.array(wm["x"], float), np.array(wm["y"], float), np.array(wm["lam"])
    i, j = np.clip(np.searchsorted(gx, x + 1) - 1, 0, len(gx) - 2), np.clip(np.searchsorted(gy, y + 1) - 1, 0, len(gy) - 2)
    a, b = (x + 1 - gx[i]) / (gx[i + 1] - gx[i]), (y + 1 - gy[j]) / (gy[j + 1] - gy[j])
    return (A[j, i] * (1 - a) + A[j, i + 1] * a) * (1 - b) + (A[j + 1, i] * (1 - a) + A[j + 1, i + 1] * a) * b
k = slice(None, None, 16); lam = lam_pix(px[k, k], py[k, k]); u_, v_ = U[k, k].ravel(), V[k, k].ravel()
terms = lambda u, v: np.stack([np.ones_like(u), u, u * u, v * v, u * v * v, u ** 3, v, u * v], -1)   # lam = sum(coef * term)
coef, *_ = np.linalg.lstsq(terms(u_, v_), lam.ravel(), rcond=None)
fit_err = float(np.abs(terms(u_, v_) @ coef - lam.ravel()).max())
assert fit_err < 0.004, fit_err   # a channel is about 0.02 microns wide
lam_at = lambda u, v: float(terms(np.float64(u), np.float64(v)) @ coef)
col = np.median(pic, 0); band_u = float(g[np.argmax(np.convolve(col, np.ones(40) / 40, "same"))])   # the bright band's middle

# ---- what is in it ----
def snr(u, v):   # 3 x 3 pixels of light at that spot against the sky around it
    i, j = int((u + 1) / 2 * N), int((v + 1) / 2 * N); ap, ring = pic[j - 1:j + 2, i - 1:i + 2], pic[j - 10:j + 11, i - 10:i + 11]
    med = np.median(ring); return round(float((ap.sum() - 9 * med) / (3 * 1.4826 * np.median(np.abs(ring - med)))), 1)
foot = w.calc_footprint(); ra0, dec0 = (float(x) for x in eq(c))
sb = json.loads(cached("skybot.json", "https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?" + urllib.parse.urlencode(
    {"-ep": mjd + 2400000.5, "-ra": ra0, "-dec": dec0, "-rd": 2.6, "-mime": "json", "-output": "all", "-objFilter": "111", "-from": "intro-bake"})).read_text())
bodies = []
for r in sb:
    u, v = uv(sexa(r["RA (hms)"], True), sexa(r["DEC (dms)"], False))
    if abs(u) < .97 and abs(v) < .97: bodies.append(dict(name=str(r["Name"]), num=r.get("Num"), cls=r["Class"], u=float(u), v=float(v), au=float(r["dg (ua)"])))
gaia = {}
tbl = cached("gaia.tbl", "https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query?" + urllib.parse.urlencode(
    {"catalog": "gaia_dr3_source", "spatial": "polygon", "polygon": ", ".join(f"{a:.4f} {b:.4f}" for a, b in foot), "outfmt": "1",
     "selcols": "source_id,ra,dec,parallax,parallax_error,phot_g_mean_mag", "constraints": "phot_g_mean_mag < 13 and parallax_over_error > 10"})).read_text()
for l in tbl.splitlines():
    if l.strip() and l[0] not in "\\|":
        p = l.split(); gaia[p[0]] = dict(ra=float(p[1]), dec=float(p[2]), plx=float(p[5]), plx_err=float(p[6]), g=float(p[7]))
for l in cached("gaia_color.tbl", "https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query?" + urllib.parse.urlencode(
    {"catalog": "gaia_dr3_source", "spatial": "NONE", "outfmt": "1", "selcols": "source_id,bp_rp,teff_gspphot", "constraints": f"source_id in ({','.join(SHOW['star'])})"})).read_text().splitlines():
    if l.strip() and l[0] not in "\\|": p = l.split(); gaia[p[0]].update(bp_rp=float(p[-2]), teff=float(p[-1]))
gal = next(l.split("\t") for l in cached("2mrs.tsv", f"https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=J/ApJS/199/26/table3&-c={ra0:.3f}+{dec0:.3f}&-c.rd=2.6&-out.all&-out.max=200").read_text().splitlines() if GALAXY in l)
# 2MRS table3 columns: _r recno ID A RAJ2000 DEJ2000 ... cz is the 28th, its source the 31st
gra, gdec, cz = float(gal[4]), float(gal[5]), float(gal[27])

GAL_ARCSEC, GAL_PX = 72, 400
(OUT / "galaxy.jpg").write_bytes(cached("galaxy_sdss.jpg", f"https://skyserver.sdss.org/dr18/SkyServerWS/ImgCutout/getjpeg?ra={gra}&dec={gdec}&scale={GAL_ARCSEC / GAL_PX}&width={GAL_PX}&height={GAL_PX}").read_bytes())

objects = []
def add(kind, name, ra_dec_or_uv, au, dist, src, **more):
    u, v = ra_dec_or_uv; objects.append(dict(kind=kind, name=name, u=round(float(u), 4), v=round(float(v), 4), au=au, dist=dist, snr=snr(u, v), src=src, **more))
for nm in SHOW["asteroid"]:
    b = next(b for b in bodies if b["name"] == nm)
    add("asteroid", f"asteroid {b['name']}", (b["u"], b["v"]), round(b["au"], 3), f"{b['au']:.1f} AU", f"IMCCE SkyBoT ({b['cls']}, number {b['num']})")
for sid in SHOW["star"]:
    s = gaia[sid]; ly = 3261.56 / s["plx"]; rel = s["plx_err"] / s["plx"]
    txt = f"{round(ly, -2 if ly > 3000 else (-1 if ly > 1000 else 0)):,.0f} light-years"
    add("star", "the star we follow" if sid == STAR else "star", uv(s["ra"], s["dec"]), round(ly * AU_PER_LY), txt, f"Gaia DR3 {sid}, parallax {s['plx']} +- {s['plx_err']} mas ({rel:.0%})",
        teff=round(s["teff"]), bp_rp=round(s["bp_rp"], 3), rgb=blackbody_rgb(s["teff"]))
mly = cz / H0 * LY_PER_MPC / 1e6
add("galaxy", "galaxy", uv(gra, gdec), round(mly * 1e6 * AU_PER_LY), f"{round(mly, -1):.0f} million light-years", f"2MASX J{GALAXY}, cz {cz:.0f} km/s (2MRS, {gal[30].strip()}), H0 {H0:.0f}",
    ra=gra, dec=gdec, image=dict(file="galaxy.jpg", arcsec=GAL_ARCSEC, credit="Sloan Digital Sky Survey", src="SDSS DR18 SkyServer ImgCutout, CC-BY"))
objects.sort(key=lambda o: o["au"])

# ---- the photo's own pixels around one asteroid: no resampling, the same stretch as photo.jpg ----
zb = next(b for b in bodies if b["name"] == ZOOM); zx, zy = (int(round(float(t))) for t in w.all_world2pix(*eq(c + zb["u"] * e + zb["v"] * f), 0))
cut = img[zy - ZN:zy + ZN, zx - ZN:zx + ZN]; assert cut[ZN, ZN] == cut[ZN - 3:ZN + 4, ZN - 3:ZN + 4].max(), "the asteroid is not the brightest pixel at its predicted place"
Image.fromarray((np.clip(np.arcsinh(np.clip((cut - lo) / (hi - lo), 0, None) * 10) / np.arcsinh(10), 0, 1) * 255).astype(np.uint8)).save(OUT / "sheba.png", optimize=True)   # row 0 is the lowest detector row
zc = [[round(float(t), 6) for t in uv(*w.all_pix2world(x - .5, y - .5, 0))] for x, y in [(zx - ZN, zy - ZN), (zx + ZN, zy - ZN), (zx + ZN, zy + ZN), (zx - ZN, zy + ZN)]]   # pixel i covers i - .5 to i + .5
zoom = dict(name=f"asteroid {ZOOM}", file="sheba.png", n=2 * ZN, corners=zc, at=[round(float(t), 6) for t in uv(*w.all_pix2world(zx, zy, 0))], peak=round(float(cut[ZN, ZN] / np.median(np.abs(cut - np.median(cut))) / 1.4826), 1))

spec_f = CACHE / "star_spectrum.json"
if spec_f.exists(): spectrum = [[round(p["lam"], 4), round(p["flux"], 2), int(bool(p["doubt"])), round(p["t"] - 60789, 2), int(p["det"][1])] for p in json.loads(spec_f.read_text())["points"]]
else: spectrum = json.loads((OUT / "photo.json").read_text())["spectrum"]   # keep the committed one
star = gaia[STAR]; su, sv = uv(star["ra"], star["dec"])
doc = dict(
    photo=dict(obs=OBS, det=1, mjd=round(mjd, 5), day=round(mjd - 60789, 5), utc=hd["DATE-AVG"][:16], width_deg=round(2 * math.degrees(math.atan(math.sqrt(e @ e))), 3),
               src=f"SPHEREx level 2 image {OBS} D1 (DR1), NASA/IPAC IRSA; zodiacal light model subtracted"),
    lam=dict(coef=[round(float(x), 6) for x in coef], terms="1 u u2 v2 uv2 u3 v uv", band=BAND, fit_err=round(fit_err, 5), bright_band_u=round(band_u, 3), bright_band_um=round(lam_at(band_u, 0), 3)),
    objects=objects, zoom=zoom, n_bodies=len(bodies),
    star=dict(id=STAR, ra=star["ra"], dec=star["dec"], g=round(star["g"], 2), u=round(float(su), 4), v=round(float(sv), 4), um=round(lam_at(su, sv), 4)),
    spectrum=spectrum)
(OUT / "photo.json").write_text(json.dumps(doc, separators=(",", ":")))
assert len(spectrum) == 102 and sorted({p[4] for p in spectrum}) == [1, 2, 3, 4, 5, 6]
print(f"photo.jpg {(OUT / 'photo.jpg').stat().st_size / 1e6:.2f} MB; {doc['photo']}; wavelength fit within {fit_err:.4f} um; bright band at u {band_u:.2f} = {doc['lam']['bright_band_um']} um")
for o in objects: print(f"  {o['name']:20s} u {o['u']:+.3f} v {o['v']:+.3f}  {o['dist']:28s} light there: {o['snr']} sigma   {o['src']}")
print(f"  sheba.png: {2 * ZN} px around detector pixel ({zx}, {zy}); its pixel is {zoom['peak']} times the spread of the pixels around it")
print(f"  {len(bodies)} known asteroids and comets on the detector; star we follow at u {su:+.3f} v {sv:+.3f}, {doc['star']['um']} um in this photo; spectrum {len(spectrum)} points, {sum(p[2] for p in spectrum)} doubtful")
