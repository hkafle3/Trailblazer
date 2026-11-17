// Per-picture verdicts for bake/comet_facts.py: each picture measured exactly as a comet's page measured it live
// (web/live/cutout.js knownPhoto: the spot's light now minus the same spot's light in same-wavelength pictures taken
// more than 5 days away; seen at SNR 5 or more), and its cutout saved as a PNG drawn as the page draws it (paint).
// Results are cached in the output file, so a rerun measures only what is missing or failed.
// Run: node bake/visit_verdicts.mjs jobs.json http://127.0.0.1:8873 results.json   (the app answers /api/images)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { knownPhoto, paint, pool } from '../web/live/cutout.js';

const [jobsFile, api, outFile] = process.argv.slice(2);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const maps = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/data/wavemaps.json'), 'utf8'));
const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
const done = new Map((fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : []).map(r => [`${r.obs} ${r.det}`, r]));

// an 8-bit grey PNG from paint()'s RGBA (all three channels equal)
function png(w, h, rgba) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = rgba[4 * (y * w + x)];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const canvas = () => {   // what paint() draws on
  let img = null;
  return { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: i => { img = i; } }), get img() { return img; } };
};

const todo = jobs.filter(j => { const r = done.get(`${j.obs} ${j.det}`); return !r || r.verdict === 'error'; });
console.log(`${jobs.length} pictures, ${todo.length} to measure`);
let n = 0;
const save = () => fs.writeFileSync(outFile, JSON.stringify([...done.values()]));
await pool(todo, 4, async j => {
  let r;
  try {
    const p = await knownPhoto({ obs: j.obs, det: j.det, ra: j.ra, dec: j.dec }, { api, maps });
    r = { obs: j.obs, det: j.det, verdict: p.verdict, snr: p.snr == null ? null : +p.snr.toFixed(2), why: p.why || null, refs: p.refs, few: !!p.few, lam: +p.lam.toFixed(3), png: j.png, png_ok: false };
    const c = canvas();
    if (p.px && p.px.some(Number.isFinite)) {
      paint(c, p);
      fs.mkdirSync(path.join(ROOT, path.dirname(j.png)), { recursive: true });
      fs.writeFileSync(path.join(ROOT, j.png), png(p.grid, p.grid, c.img.data));
      r.png_ok = true;
    }
  } catch (e) {
    r = { obs: j.obs, det: j.det, verdict: 'error', snr: null, why: String(e.message || e).slice(0, 160), png: j.png, png_ok: false };
  }
  done.set(`${j.obs} ${j.det}`, r);
  if (++n % 20 === 0) { save(); console.log(`  measured ${n} of ${todo.length}`); }
});
save();
const count = v => [...done.values()].filter(r => r.verdict === v).length;
console.log(`done: seen ${count('seen')}, faint ${count('faint')}, unmeasured ${count('unmeasured')}, error ${count('error')}`);
