// The JSON writer against the object form, on the real index files (not in git; bake/sky_index.py builds them):
//   SKY_INDEX_DIR=/path/to/index node --test worker/sky_index_full.test.mjs
// For every detector: the north ecliptic pole, the cell with the most rows, and an ordinary spot on the ecliptic;
// and an answer at every cell's centre, so every row of every file passes the Worker's checks.
// Its own file because skyImages keeps one parsed head per file name, and the fixture test uses d1.bin too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSync, readSync, fstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { skyImages, skyImagesJson, skyHead, cellAt } from './src/sky_index.js';

const dir = process.env.SKY_INDEX_DIR;
const fds = {};
const read = async (name, off, len) => {
  const b = Buffer.alloc(len);
  readSync(fds[name] ??= openSync(`${dir}/${name}`, 'r'), b, 0, len, off);
  return { buf: b.buffer.slice(b.byteOffset, b.byteOffset + len), etag: 'file', size: fstatSync(fds[name]).size };
};

for (const det of [1, 2, 3, 4, 5, 6]) {
  test(`D${det}: the JSON writer gives JSON.stringify's bytes`, { skip: !dir && 'set SKY_INDEX_DIR to run' }, async () => {
    const { first } = await skyHead(read, det, 'file');
    let big = 0;
    for (let c = 1; c < first.length - 1; c++) if (first[c + 1] - first[c] > first[big + 1] - first[big]) big = c;
    let busiest;
    for (let dec = -89.95; !busiest && dec < 90; dec += 0.1) for (let ra = 0.05; ra < 360; ra += 0.1) if (cellAt(ra, dec) === big) { busiest = [ra, dec]; break; }
    for (const [ra, dec] of [[270, 66.560708], busiest, [180, 0]]) {
      const want = JSON.stringify({ ra, dec, det: `D${det}`, ...(await skyImages(read, ra, dec, det, 'file')), source: 'index' });
      assert.equal(await skyImagesJson(read, ra, dec, det, 'file'), want, `D${det} at (${ra}, ${dec})`);
    }
  });
}

// the centre of every cell of the grid (51 bands of Dec, about 3.5 degree steps of RA, as in sky_index.js)
const centres = [];
for (let b = 0; b < 51; b++) {
  const n = Math.max(1, Math.round(360 * Math.cos((90 - (b + .5) * 180 / 51) * Math.PI / 180) / 3.5));
  for (let k = 0; k < n; k++) centres.push([(k + .5) * 360 / n, 90 - (b + .5) * 180 / 51]);
}

for (const det of [1, 2, 3, 4, 5, 6]) {
  // one answer per cell runs every row of the file through the Worker's own checks, so they never refuse a real image
  test(`D${det}: an answer at every cell's centre, so every row passes the Worker's checks`, { skip: !dir && 'set SKY_INDEX_DIR to run' }, async () => {
    let images = 0;
    for (const [c, [ra, dec]] of centres.entries()) {
      assert.equal(cellAt(ra, dec), c);
      images += (await skyImages(read, ra, dec, det, 'file')).images.length;
    }
    assert.ok(images > 100000, `D${det}: ${images} images over all cell centres`);
  });
}

for (const det of [1, 2, 3, 4, 5, 6]) {
  test(`D${det}: wrangler.toml pins this file (SKY_ETAG_D${det} is its MD5, R2's etag)`, { skip: !dir && 'set SKY_INDEX_DIR to run' }, () => {
    const toml = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
    const pinned = toml.match(new RegExp(`^SKY_ETAG_D${det} = "([0-9a-f]{32})"`, 'm'))?.[1];
    assert.equal(pinned, createHash('md5').update(readFileSync(`${dir}/d${det}.bin`)).digest('hex'));
  });
}
