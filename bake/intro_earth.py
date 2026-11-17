"""Bake the Earth of the 3D intro (web/intro.js) into web/data/intro/: three NASA maps of the whole globe, each
equirectangular (longitude -180 to 180 left to right, north up), made smaller and stored as WebP.
  earth_day.webp     Blue Marble Next Generation with topography and bathymetry, April 2004 (the first photo is from an
                     April): NASA Earth Observatory, R. Stockli. world.topo.bathy.200404.3x5400x2700.jpg
  earth_cloud.webp   Blue Marble clouds (2002): NASA Goddard Space Flight Center, R. Stockli. cloud_combined_2048.jpg
  earth_night.webp   Black Marble 2016, Earth at night: NASA Earth Observatory, J. Stevens and M. Roman, Suomi NPP VIIRS.
                     BlackMarble_2016_01deg.jpg
All three are NASA images, free of copyright (NASA media usage guidelines); the film credits them.
The originals are fetched into bake/cache/intro/ if they are not there. Needs ffmpeg and cwebp.
Run: python3 bake/intro_earth.py"""
import subprocess, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CACHE, OUT = REPO / "bake/cache/intro", REPO / "web/data/intro"
EO = "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/"
MAPS = [  # name, source, width, WebP quality, extra ffmpeg filter
    ("earth_day", EO + "bmng/bmng-topography-bathymetry/april/world.topo.bathy.200404.3x5400x2700.jpg", 4096, 76, ""),
    # NASA's own address for the clouds (eoimages.gsfc.nasa.gov) no longer answers: this is the Internet Archive's copy of that file
    ("earth_cloud", "https://web.archive.org/web/20210217230404id_/https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_2048.jpg", 2048, 62, ",format=gray"),
    ("earth_night", EO + "imagerecords/144000/144898/BlackMarble_2016_01deg.jpg", 2048, 70, ""),
]
for name, url, width, q, more in MAPS:
    src = CACHE / (name + "_nasa.jpg")
    if not src.exists():
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        src.write_bytes(urllib.request.urlopen(req, timeout=180).read())
    png = CACHE / (name + ".png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", f"scale={width}:{width // 2}:flags=lanczos{more}", str(png)], check=True)
    subprocess.run(["cwebp", "-quiet", "-q", str(q), "-m", "6", str(png), "-o", str(OUT / (name + ".webp"))], check=True)
    png.unlink()
    print(name, (OUT / (name + ".webp")).stat().st_size, "bytes")
