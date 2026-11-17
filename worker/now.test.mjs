// worker/src/now.js, the daily snapshot: parsing JPL Horizons' replies (real ones for C/2026 A2 on 17 Nov 2026, in
// worker/fixtures/now/), refusing a reply for another body, and a cron run that keeps the last good row when a fetch fails.
// Run: node --test worker/now.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { horizonsNow, snapshot } from './src/now.js';

const fix = n => fs.readFileSync(new URL(`./fixtures/now/${n}.json`, import.meta.url), 'utf8');
const reply = body => ({ ok: true, status: 200, json: async () => JSON.parse(body) });
const horizons = (opts = {}) => async url => {
  const q = new URL(url).searchParams;
  if (opts.fail) return { ok: false, status: 503, json: async () => ({}) };
  const body = fix(q.get('EPHEM_TYPE') === 'VECTORS' ? 'bok-vectors' : 'bok-observer');
  return reply(opts.other ? body.replaceAll('Bok (C/2026 A2)', 'Lemmon (C/2025 A6)') : body);
};

test('the day\'s values from real replies', async () => {
  const { soln, now } = await horizonsNow('2026 A2', false, '2026-11-17', horizons());
  assert.equal(soln, 'JPL#34');
  assert.deepEqual([now.T, now.T30, now.r, now.delta, now.elong, now.side, now.cnst], [13.797, 13.915, 1.986126118115, 1.58189713082361, 98.5409, '/T', 'Cyg']);
  assert.equal(now.rdot, -4.657965);
  assert.ok(Math.abs(Math.hypot(now.vx, now.vy, now.vz) * 149.6e6 / 86400 - 29.87) < 0.05, 'speed about 29.9 km/s');
  assert.ok(Math.abs(now.ra - 315.7331) < 1e-3 && Math.abs(now.dec - 43.504) < 1e-3);
});

test('a reply for another body is refused', async () => {
  await assert.rejects(horizonsNow('2026 A2', false, '2026-11-17', horizons({ other: true })), /answered for/);
});

test('positions from another solution are refused', async () => {
  const f = async url => { const r = await horizons()(url); const q = new URL(url).searchParams;
    return q.get('EPHEM_TYPE') === 'VECTORS' ? reply(JSON.stringify({ result: (await r.json()).result.replaceAll('JPL#34', 'JPL#35') })) : r; };
  await assert.rejects(horizonsNow('2026 A2', false, '2026-11-17', f), /positions from JPL#35/);
});

test('a reply missing a velocity component is refused', async () => {
  const f = async url => { const r = await horizons()(url); const q = new URL(url).searchParams;
    if (q.get('EPHEM_TYPE') !== 'VECTORS') return r;
    const t = (await r.json()).result.replace(/(\$\$SOE\n[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,)[^,]*,/, '$1 ,');
    return reply(JSON.stringify({ result: t })); };
  await assert.rejects(horizonsNow('2026 A2', false, '2026-11-17', f), /no vy/);
});

// a D1 stand-in for the cron's statements on a Map of rows: the claim, the select, the two conditional writes
function db(rows) {
  return { prepare: sql => ({ bind: (...a) => ({
    all: async () => ({ results: [{ id: 'C/2026 A2 (Bok)', des: '2026 A2', frag: 0 }] }),
    run: async () => {
      const [id, x, y, z, w] = a, old = rows.get(id) ?? {};
      if (/^INSERT/.test(sql)) {   // the claim: (id, at, at - RETRY)
        if (old.tried_at != null && old.tried_at >= y) return { meta: { changes: 0 } };
        rows.set(id, { ...old, tried_at: x }); return { meta: { changes: 1 } };
      }
      if (/as_of = \?2/.test(sql)) { if (old.tried_at === w) rows.set(id, { ...old, as_of: x, soln: y, now: z, error: null }); }
      else if (old.tried_at === y) rows.set(id, { ...old, error: x });
      return { meta: { changes: 1 } };
    } }) }) };
}

test('a cron run writes today\'s row, and a failure keeps the last good one', async () => {
  const rows = new Map([['C/2026 A2 (Bok)', { as_of: '2026-11-16', soln: 'JPL#34', now: '{"T":13.8}' }]]);
  const at = Date.parse('2026-11-17T00:10:00Z');
  let r = await snapshot({ DB: db(rows) }, at, horizons({ fail: true }));
  assert.deepEqual([r.due, r.ok], [1, 0]);
  const kept = rows.get('C/2026 A2 (Bok)');
  assert.deepEqual([kept.as_of, kept.now, kept.error], ['2026-11-16', '{"T":13.8}', 'Horizons HTTP 503']);
  r = await snapshot({ DB: db(rows) }, at + 30 * 60e3, horizons());
  assert.deepEqual([r.day, r.ok], ['2026-11-17', 1]);
  const row = rows.get('C/2026 A2 (Bok)');
  assert.deepEqual([row.as_of, row.soln, row.error, JSON.parse(row.now).T], ['2026-11-17', 'JPL#34', null, 13.797]);
});

test('an overlapping run neither fetches a claimed comet nor writes over a newer claim', async () => {
  const rows = new Map(), at = Date.parse('2026-11-17T00:00:00Z');
  let release;   // the first run stalls on Horizons until released
  const slow = async url => { await new Promise(ok => { release ??= ok; if (release !== ok) ok(); }); return horizons()(url); };
  const first = snapshot({ DB: db(rows) }, at, slow);
  await new Promise(ok => setTimeout(ok, 10));
  const second = await snapshot({ DB: db(rows) }, at + 10 * 60e3, horizons());   // within RETRY_MS of the claim: skipped
  assert.equal(second.ok, 0);
  rows.get('C/2026 A2 (Bok)').tried_at = at + 30 * 60e3;   // a later run claimed it meanwhile
  release(); await first;
  assert.equal(rows.get('C/2026 A2 (Bok)').as_of, undefined, 'the stalled run wrote over a newer claim');
});

test('migration 0018 can be applied twice (CREATE ... IF NOT EXISTS)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const sql = fs.readFileSync(new URL('./migrations/0018_comet_now.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE comets (id TEXT PRIMARY KEY); INSERT INTO comets VALUES ('x')");
  db.exec(sql);
  db.exec("INSERT INTO comet_now (id, as_of) VALUES ('x', '2026-11-17')");
  db.exec(sql);   // again: no error, and the row is still there
  assert.equal(db.prepare('SELECT as_of FROM comet_now WHERE id = ?').get('x').as_of, '2026-11-17');
});
