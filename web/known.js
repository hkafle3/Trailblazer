// Catalog positions for the patch viewer.
// Comets come from the baked Minor Planet Center ephemeris (one position per comet).
// Asteroids come from GET /api/known (IMCCE SkyBoT). SkyBoT is not asked for comets.

const D2R = Math.PI / 180;
// Half the diagonal of the full 12 arcmin frame (144 pixels at 5 arcsec).
export const FIELD_ARCSEC = 144 / 2 * 5 * Math.SQRT2;

let ephP = null;

export function loadEph() {
  ephP ??= Promise.all([
    fetch('data/comet_eph.json').then(r => { if (!r.ok) throw new Error('comet catalog'); return r.json(); }),
    fetch('data/comet_eph.bin').then(r => { if (!r.ok) throw new Error('comet catalog'); return r.arrayBuffer(); }),
  ]).then(([meta, buf]) => {
    const pos = new Float32Array(buf);
    if (pos.length !== meta.comets.length * meta.days * 2) throw new Error('comet catalog is the wrong size');
    return { meta, pos };
  });
  return ephP;
}

export function eastNorth(ra0, dec0, ra, dec) {
  const dra = ((ra - ra0 + 540) % 360) - 180;
  return [dra * 3600 * Math.cos(dec0 * D2R), (dec - dec0) * 3600];
}

export function cometsAt(eph, ra, dec, mjd) {
  const { meta, pos } = eph;
  const day = (mjd - meta.mjd0) / meta.step;
  if (!(day >= 0 && day <= meta.days - 1)) return [];
  const i0 = Math.floor(day), f = day - i0, i1 = Math.min(meta.days - 1, i0 + 1);
  const stride = meta.days * 2, out = [];
  for (let c = 0; c < meta.comets.length; c++) {
    const b = c * stride;
    const ra0 = pos[b + i0 * 2], ra1 = pos[b + i1 * 2];
    const dec0 = pos[b + i0 * 2 + 1], dec1 = pos[b + i1 * 2 + 1];
    if (!Number.isFinite(ra0) || !Number.isFinite(ra1)) continue;
    const dra = ((ra1 - ra0 + 540) % 360) - 180;
    const r = (ra0 + dra * f + 360) % 360;
    const d = dec0 + (dec1 - dec0) * f;
    const [east, north] = eastNorth(ra, dec, r, d);
    if (Math.hypot(east, north) <= FIELD_ARCSEC) out.push({ kind: 'comet', name: meta.comets[c].name, east, north });
  }
  return out;
}

const asteroids = new Map();

export async function asteroidsAt(ra, dec, mjd) {
  const t = Number(mjd).toFixed(2);
  const key = `${Number(ra).toFixed(4)},${Number(dec).toFixed(4)},${t}`;
  if (asteroids.has(key)) return asteroids.get(key);
  try {
    const r = await fetch(`/api/known?ra=${ra}&dec=${dec}&t=${t}&mv=21`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { error: body.error || 'SkyBoT is not answering', asteroids: [], omitted: 0 };
    const out = { comets: body.comets || [], asteroids: body.asteroids || [], omitted: body.omitted || 0 };
    asteroids.set(key, out);
    return out;
  } catch {
    return { error: 'SkyBoT is not answering', asteroids: [], omitted: 0 };
  }
}
