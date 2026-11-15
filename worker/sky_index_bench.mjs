// CPU of one /api/images answer from the sky index, on the cells with the most rows (the ecliptic poles' deep fields).
// Times skyImages plus the JSON.stringify the Worker does; reads come from memory, as an R2 body already received would.
//   node worker/sky_index_bench.mjs INDEX_DIR [det]
// Each point runs in a fresh child process too ("cold": head parse and unoptimised code, like a new Worker instance).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { skyImages, cellAt } from './src/sky_index.js';

const [dir, det = '1', only] = process.argv.slice(2);
const file = readFileSync(`${dir}/d${det}.bin`);
const read = async (name, off, len) => file.buffer.slice(file.byteOffset + off, file.byteOffset + off + len);
const answer = async (ra, dec) => JSON.stringify({ ra, dec, det: `D${det}`, ...(await skyImages(read, ra, dec, det)) });

if (only) {   // child: one cold answer
  const [ra, dec] = only.split(',').map(Number), t0 = performance.now(), c0 = process.cpuUsage();
  const n = (await answer(ra, dec)).length, c = process.cpuUsage(c0);
  console.log(JSON.stringify({ ms: performance.now() - t0, cpu_ms: (c.user + c.system) / 1000, bytes: n }));
} else {
  const v = new DataView(file.buffer, file.byteOffset), cells = v.getUint32(12, true);
  const first = new Uint32Array(file.buffer.slice(file.byteOffset + 24, file.byteOffset + 24 + 4 * (cells + 1)));
  const sizes = [...Array(cells).keys()].map(c => [first[c + 1] - first[c], c]).sort((a, b) => b[0] - a[0]);
  const pts = [[270, 66.560708, 'north ecliptic pole'], [90, -66.560708, 'south ecliptic pole'], [267, 65.5, 'north deep, off centre']];
  // the centre of each of the 4 biggest cells: find a point in it by scanning a fine grid
  for (const [, c] of sizes.slice(0, 4)) {
    outer: for (let dec = -89.9; dec < 90; dec += 0.2) for (let ra = 0.05; ra < 360; ra += 0.2) if (cellAt(ra, dec) === c) { pts.push([ra + 0.5, dec + 0.5, `cell ${c}`]); break outer; }
  }
  console.log(`rows per cell: max ${sizes[0][0]}, then ${sizes.slice(1, 4).map(s => s[0]).join(', ')}`);
  for (const [ra, dec, name] of pts) {
    const cold = JSON.parse(execFileSync(process.execPath, [new URL(import.meta.url).pathname, dir, det, `${ra},${dec}`]).toString());
    await answer(ra, dec);
    const times = [];
    for (let i = 0; i < 50; i++) { const t0 = performance.now(); await answer(ra, dec); times.push(performance.now() - t0); }
    times.sort((a, b) => a - b);
    const r = await skyImages(read, ra, dec, det);
    console.log(`${name.padEnd(24)} (${ra.toFixed(2)}, ${dec.toFixed(2)}) cell ${cellAt(ra, dec)} rows ${first[cellAt(ra, dec) + 1] - first[cellAt(ra, dec)]} images ${r.images.length} ` +
      `json ${(cold.bytes / 1024).toFixed(0)} KB | cold ${cold.ms.toFixed(2)} ms (cpu ${cold.cpu_ms.toFixed(2)}) | warm median ${times[25].toFixed(2)} ms, max ${times[49].toFixed(2)} ms`);
  }
}
