// The daily "right now" snapshot (comet-plan/fact-table.md, decision D4): once a day each known comet's values for that
// UTC day from JPL Horizons, written to D1 (comet_now) with the date. Pages read only D1 and say "as of" the date.
// The cron (wrangler.toml [triggers]) runs every 10 minutes in the first hours of the UTC day; each run takes up to
// BATCH comets that have no row for today and were not tried in the last 20 minutes, so a failed comet is tried again
// later that day while its last good row (and that row's date) stays. A failure is never written over good values.
// Two Horizons requests a comet, one after another (Horizons answers 503 to parallel requests from one client):
// - OBSERVER from Earth's centre at 0h UT today and 30 days later: magnitude (T, T30), r, rdot, delta, deldot,
//   elongation and side, constellation, RA/Dec; its header names JPL's orbit solution (soln);
// - VECTORS from the Sun's centre (ecliptic, AU and AU/day) at 0h today: position and velocity, for the speed (R7) and Depth.
const HZ = 'https://ssd.jpl.nasa.gov/api/horizons.api?';
export const BATCH = 10, RETRY_MS = 20 * 60e3, TIMEOUT_MS = 45e3;
const JD_UNIX = 2440587.5;

// the CSV rows between $$SOE and $$EOE, keyed by the header line's column names
export function horizonsTable(text) {
  if (!text.includes('$$SOE')) throw new Error(`Horizons answered without a table: ${text.slice(-200)}`);
  const head = text.split('$$SOE')[0].trim().split('\n'), cols = head[head.length - 2].split(',').map(s => s.trim());
  return text.split('$$SOE')[1].split('$$EOE')[0].trim().split('\n').map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v.trim()])));
}
const num = v => (v == null || v === '' || v === 'n.a.' ? null : Number(v));
const pick = (r, pre) => r[Object.keys(r).find(k => k.startsWith(pre))];

// the day's values for one comet (des: its Horizons designation; frag: a fragment, searched without CAP/NOFRAG)
export async function horizonsNow(des, frag, day, fetchFn = fetch) {
  const jd = Date.parse(day + 'T00:00:00Z') / 864e5 + JD_UNIX;
  const command = `'DES=${des};${frag ? '' : ' CAP; NOFRAG;'}'`;
  const get = async params => {
    // a stalled reply must not hold the run: the whole request, body included, gets TIMEOUT_MS
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const r = await fetchFn(HZ + new URLSearchParams({ format: 'json', COMMAND: command, MAKE_EPHEM: 'YES', CSV_FORMAT: 'YES', ...params }), { signal });
    if (!r.ok) throw new Error(`Horizons HTTP ${r.status}`);
    const text = (await r.json()).result ?? '';
    const target = text.match(/Target body name: (.+?)\s+\{/)?.[1] ?? '';
    if (!target.includes(des) || (!frag && target.includes(des + '-'))) throw new Error(`Horizons answered for ${target || 'nothing'}, not ${des}`);
    return text;
  };
  const obs = await get({ EPHEM_TYPE: 'OBSERVER', OBJ_DATA: 'YES', CENTER: "'500@399'", TLIST: `'${jd} ${jd + 30}'`, TLIST_TYPE: 'JD',
    QUANTITIES: "'1,9,19,20,23,29'", ANG_FORMAT: 'DEG', EXTRA_PREC: 'YES' });
  const source = t => t.match(/Target body name: .+?\{source: (JPL#[^}\s]+)\}/)?.[1];
  const soln = obs.match(/soln ref\.=\s*(JPL#[^,\s]+)/)?.[1] ?? source(obs);
  if (!soln) throw new Error('no JPL solution in the reply');
  const [a, b] = horizonsTable(obs);
  if (!b) throw new Error('Horizons gave one row, not two');
  const vec = await get({ EPHEM_TYPE: 'VECTORS', OBJ_DATA: 'NO', CENTER: "'500@10'", TLIST: `'${jd}'`, TLIST_TYPE: 'JD', REF_PLANE: 'ECLIPTIC',
    OUT_UNITS: 'AU-D', VEC_TABLE: '2' });
  if (source(vec) !== soln) throw new Error(`positions from ${source(vec)}, magnitudes from ${soln}`);   // one solution or none
  const [v] = horizonsTable(vec);
  const now = { T: num(a['T-mag']), T30: num(b['T-mag']), r: num(a.r), rdot: num(a.rdot), delta: num(a.delta), deldot: num(a.deldot),
    elong: num(a['S-O-T']), side: a['/r'], cnst: a.Cnst, ra: num(pick(a, 'R.A.')), dec: num(pick(a, 'DEC')),
    x: num(v.X), y: num(v.Y), z: num(v.Z), vx: num(v.VX), vy: num(v.VY), vz: num(v.VZ) };
  for (const k of ['r', 'rdot', 'delta', 'elong', 'ra', 'dec', 'x', 'y', 'z', 'vx', 'vy', 'vz']) if (!Number.isFinite(now[k])) throw new Error(`no ${k} in the reply`);
  return { soln, now };
}

// one cron run: up to BATCH comets without today's row
export async function snapshot(env, at = Date.now(), fetchFn = fetch) {
  const day = new Date(at).toISOString().slice(0, 10);
  const due = (await env.DB.prepare(`SELECT c.id, json_extract(c.detail, '$.facts.orb.des') AS des, json_extract(c.detail, '$.facts.orb.frag') AS frag
    FROM comets c LEFT JOIN comet_now n ON n.id = c.id
    WHERE c.kind = 'known' AND json_extract(c.detail, '$.facts.orb.des') IS NOT NULL AND (n.as_of IS NULL OR n.as_of < ?1) AND (n.tried_at IS NULL OR n.tried_at < ?2)
    ORDER BY n.tried_at IS NOT NULL, n.tried_at, c.id LIMIT ?3`).bind(day, at - RETRY_MS, BATCH).all()).results;
  let ok = 0;
  for (const c of due) {
    // claim the comet first (tried_at = this run's time, only if no other run claimed it within RETRY_MS), and write
    // the result only while the claim is still this run's: an overlapping run can never put older values over newer
    const claim = await env.DB.prepare(`INSERT INTO comet_now (id, tried_at) VALUES (?1, ?2)
      ON CONFLICT(id) DO UPDATE SET tried_at = ?2 WHERE tried_at IS NULL OR tried_at < ?3`).bind(c.id, at, at - RETRY_MS).run();
    if (!claim.meta?.changes) continue;
    try {
      const { soln, now } = await horizonsNow(c.des, !!c.frag, day, fetchFn);
      await env.DB.prepare(`UPDATE comet_now SET as_of = ?2, soln = ?3, now = ?4, error = NULL WHERE id = ?1 AND tried_at = ?5`)
        .bind(c.id, day, soln, JSON.stringify(now), at).run();
      ok++;
    } catch (e) {
      console.warn(`snapshot ${c.id}: ${e.message}`);
      await env.DB.prepare(`UPDATE comet_now SET error = ?2 WHERE id = ?1 AND tried_at = ?3`).bind(c.id, String(e.message).slice(0, 300), at).run();
    }
  }
  return { day, due: due.length, ok };
}

// the row a page reads: the values with their date and solution, or null
export const nowRow = r => (r?.as_of && r.now ? { as_of: r.as_of, soln: r.soln, ...JSON.parse(r.now) } : null);
