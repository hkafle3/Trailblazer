"""Read the WCS and timing cards of SPHEREx level-2 images straight from NASA's public S3 bucket.

Each level-2 FITS file starts with a one-block primary header and then the IMAGE extension header, which holds
OBSID, DETECTOR, MJD-BEG/END, the TAN-SIP WCS and the survey flags. One HTTP range request per file reads them.
The cards are parsed here by hand (80-character records); astropy is only used by the self-check.

  uv run --with aiohttp --with numpy python bake/sky_headers.py KEYS.tsv OUT.jsonl DETS [--conc 600] [--bytes N]

KEYS.tsv: key<TAB>size lines (the bucket listing). DETS: e.g. 1 or 123456. Resumable: keys already in OUT are skipped.
Each output line: {"key", "end", "h": {card: value}} with the cards in KEEP plus every SIP coefficient.
"""
import asyncio, json, math, re, sys, time

BUCKET = "https://nasa-irsa-spherex.s3.amazonaws.com/"
KEY_RE = re.compile(r"level2_(\d{4}W\d\d_\d[A-Z]_\d{4}_\d)D([1-6])_spx_")
KEEP = {"NAXIS1", "NAXIS2", "DETECTOR", "OBSID", "MJD-BEG", "MJD-END", "CRPIX1", "CRPIX2", "CRVAL1", "CRVAL2",
        "PC1_1", "PC1_2", "PC2_1", "PC2_2", "CDELT1", "CDELT2", "CTYPE1", "CTYPE2", "LONPOLE", "LATPOLE",
        "A_ORDER", "B_ORDER", "AP_ORDER", "BP_ORDER", "SPS_FLAGS", "SPS_TARGET", "NON_SURVEY", "L2DQAFLG", "FINAST"}
SIP_RE = re.compile(r"^(A|B|AP|BP)_\d+_\d+$")
END = b"END" + b" " * 77


def value(s):
    s = s.strip()
    if s.startswith("'"):
        return s[1:s.index("'", 1)].rstrip() if "'" in s[1:] else s[1:]
    s = s.split("/", 1)[0].strip()
    if s in ("T", "F"):
        return s == "T"
    try:
        return int(s)
    except ValueError:
        try:
            return float(s.replace("D", "E"))
        except ValueError:
            return s


def cards(block):
    """{keyword: value} for one header (bytes up to and including END). HIERARCH keywords keep their last word."""
    out = {}
    for i in range(0, len(block), 80):
        c = block[i:i + 80].decode("ascii", "replace")
        if c.startswith("HIERARCH "):
            k, _, v = c[9:].partition("=")
            out[k.split()[-1]] = value(v)
        elif c[8:10] == "= ":
            out[c[:8].strip()] = value(c[10:])
    return out


def header_end(buf, start):
    """Byte offset just past the END card of the header that starts at `start`, or None if END is not in buf yet."""
    for i in range(start, len(buf) - 79, 80):
        if buf[i:i + 80] == END:
            return i + 80
    return None


def parse(buf):
    """(image header cards, byte offset just past its END) from the first bytes of a file; None if buf is too short."""
    p = header_end(buf, 0)
    if p is None:
        return None
    start = math.ceil(p / 2880) * 2880
    e = header_end(buf, start)
    if e is None:
        return None
    h = cards(buf[start:e])
    return {k: v for k, v in h.items() if k in KEEP or SIP_RE.match(k)}, e


def pix2sky(h, x, y):
    """FITS 1-based pixel (x, y) -> (ra, dec) degrees with the forward SIP polynomial and TAN projection."""
    u, v = x - h["CRPIX1"], y - h["CRPIX2"]
    f = sum(h.get(f"A_{p}_{q}", 0) * u ** p * v ** q for p in range(h["A_ORDER"] + 1) for q in range(h["A_ORDER"] + 1 - p))
    g = sum(h.get(f"B_{p}_{q}", 0) * u ** p * v ** q for p in range(h["B_ORDER"] + 1) for q in range(h["B_ORDER"] + 1 - p))
    u, v = (u + f) * h["CDELT1"], (v + g) * h["CDELT2"]
    xi = math.radians(h["PC1_1"] * u + h["PC1_2"] * v)
    eta = math.radians(h["PC2_1"] * u + h["PC2_2"] * v)
    a0, d0 = math.radians(h["CRVAL1"]), math.radians(h["CRVAL2"])
    # TAN with LONPOLE 180 (checked in the headers): standard gnomonic inverse
    den = math.cos(d0) - eta * math.sin(d0)
    ra = a0 + math.atan2(xi, den)
    dec = math.atan2(math.sin(d0) + eta * math.cos(d0), math.hypot(xi, den))
    return math.degrees(ra) % 360, math.degrees(dec)


def corners(h):
    """Footprint corners at the outer corner pixels' centres, in astropy calc_footprint's order."""
    n1, n2 = h["NAXIS1"], h["NAXIS2"]
    return [pix2sky(h, x, y) for x, y in ((1, 1), (1, n2), (n1, n2), (n1, 1))]


RETRIES = [0]


async def fetch(session, key, nbytes, tries=8):
    """(key, row or None, error or None). Reads more if END is past nbytes."""
    import aiohttp
    err = None
    for i in range(tries):
        RETRIES[0] += i > 0
        try:
            async with session.get(BUCKET + key, headers={"Range": f"bytes=0-{nbytes - 1}"}) as r:
                if r.status in (200, 206):
                    buf = await r.read()
                    got = parse(buf)
                    if got is None:
                        if nbytes >= 57600:
                            return key, None, f"no END in {nbytes} bytes"
                        nbytes = 57600   # rare long header: read again with room to spare
                        continue
                    h, end = got
                    return key, {"key": key, "end": end, "h": h}, None
                err = f"HTTP {r.status}"
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            err = repr(e)
        await asyncio.sleep(min(30, 0.5 * 2 ** i))
    return key, None, err


async def run(keys, out_path, conc, nbytes, log=print):
    import aiohttp
    q = asyncio.Queue()
    for k in keys:
        q.put_nowait(k)
    stats = {"ok": 0, "failed": 0, "t0": time.time(), "errors": []}
    timeout = aiohttp.ClientTimeout(total=120, sock_connect=30)
    conn = aiohttp.TCPConnector(limit=conc, ttl_dns_cache=600)
    with open(out_path, "a") as out:
        async with aiohttp.ClientSession(connector=conn, timeout=timeout) as s:
            async def worker():
                while not q.empty():
                    k = q.get_nowait()
                    _, row, err = await fetch(s, k, nbytes)
                    if row:
                        out.write(json.dumps(row, separators=(",", ":")) + "\n")
                        stats["ok"] += 1
                    else:
                        stats["failed"] += 1
                        stats["errors"].append((k, err))
                        print("FAILED", k, err, file=sys.stderr, flush=True)
                    n = stats["ok"] + stats["failed"]
                    if n % 10000 == 0:
                        out.flush()
                        log(f"{n}/{len(keys)} {n / (time.time() - stats['t0']):.0f}/s failed {stats['failed']} retries {RETRIES[0]}")
            await asyncio.gather(*(worker() for _ in range(conc)))
    stats["secs"] = time.time() - stats["t0"]
    return stats


def main():
    a = sys.argv[1:]
    keys_f, out_f, dets = a[0], a[1], set(a[2])
    conc = int(a[a.index("--conc") + 1]) if "--conc" in a else 600
    nbytes = int(a[a.index("--bytes") + 1]) if "--bytes" in a else 28800
    try:
        done = {json.loads(l)["key"] for l in open(out_f)}
    except FileNotFoundError:
        done = set()
    keys = [k for k in (l.split("\t")[0].strip() for l in open(keys_f)) if k.endswith(".fits")
            and (m := KEY_RE.search(k)) and m.group(2) in dets and k not in done]
    print(f"{len(keys)} to read, {len(done)} already done", flush=True)
    st = asyncio.run(run(keys, out_f, conc, nbytes, log=lambda s: print(s, flush=True)))
    print(f"done ok {st['ok']} failed {st['failed']} retries {RETRIES[0]} in {st['secs']:.0f}s ({st['ok'] / st['secs']:.0f}/s)", flush=True)


def _check():   # parser and SIP against astropy on the saved sample header: python -c "import sky_headers; sky_headers._check()"
    from astropy.io import fits
    from astropy.wcs import WCS
    import warnings; warnings.simplefilter("ignore")
    buf = open(sys.argv[1], "rb").read()
    h, e = parse(buf)
    w = WCS(fits.Header.fromstring(buf[2880:e].decode("ascii")))
    for (ra, dec), (r2, d2) in zip(corners(h), w.calc_footprint(axes=(h["NAXIS1"], h["NAXIS2"]))):
        assert abs(ra - r2) < 1e-7 and abs(dec - d2) < 1e-7, (ra, r2, dec, d2)
    print("ok", e, corners(h))


if __name__ == "__main__":
    _check() if sys.argv[1:2] == ["--check"] and sys.argv.pop(1) else main()
