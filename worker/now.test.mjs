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

// a D1 stand-in: the cron's three statements, on a Map of rows
function db(rows, due) {
  return { prepare: sql => ({ bind: (...a) => ({
    all: async () => ({ results: due }),
    run: async () => {
      const [id, x, y, z, w] = a, old = rows.get(id) ?? {};
      if (/as_of = \?2/.test(sql)) rows.set(id, { ...old, as_of: x, soln: y, now: z, tried_at: w, error: null });
      else rows.set(id, { ...old, tried_at: x, error: y });
    } }) }) };
}

test('a cron run writes today\'s row, and a failure keeps the last good one', async () => {
  const rows = new Map([['C/2026 A2 (Bok)', { as_of: '2026-11-16', soln: 'JPL#34', now: '{"T":13.8}' }]]);
  const due = [{ id: 'C/2026 A2 (Bok)', des: '2026 A2', frag: 0 }];
  const at = Date.parse('2026-11-17T00:10:00Z');
  let r = await snapshot({ DB: db(rows, due) }, at, horizons({ fail: true }));
  assert.deepEqual([r.due, r.ok], [1, 0]);
  const kept = rows.get('C/2026 A2 (Bok)');
  assert.deepEqual([kept.as_of, kept.now, kept.error], ['2026-11-16', '{"T":13.8}', 'Horizons HTTP 503']);
  r = await snapshot({ DB: db(rows, due) }, at + 30 * 60e3, horizons());
  assert.deepEqual([r.day, r.ok], ['2026-11-17', 1]);
  const row = rows.get('C/2026 A2 (Bok)');
  assert.deepEqual([row.as_of, row.soln, row.error, JSON.parse(row.now).T], ['2026-11-17', 'JPL#34', null, 13.797]);
});
