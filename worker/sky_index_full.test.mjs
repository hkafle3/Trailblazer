// The JSON writer against the object form, on the real index files (not in git; bake/sky_index.py builds them):
//   SKY_INDEX_DIR=/path/to/index node --test worker/sky_index_full.test.mjs
// For every detector: the north ecliptic pole, the cell with the most rows, and an ordinary spot on the ecliptic.
// Its own file because skyImages keeps one parsed head per file name, and the fixture test uses d1.bin too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSync, readSync } from 'node:fs';
import { skyImages, skyImagesJson, skyHead, cellAt } from './src/sky_index.js';

const dir = process.env.SKY_INDEX_DIR;
const fds = {};
const read = async (name, off, len) => {
  const b = Buffer.alloc(len);
  readSync(fds[name] ??= openSync(`${dir}/${name}`, 'r'), b, 0, len, off);
  return b.buffer.slice(b.byteOffset, b.byteOffset + len);
};

for (const det of [1, 2, 3, 4, 5, 6]) {
  test(`D${det}: the JSON writer gives JSON.stringify's bytes`, { skip: !dir && 'set SKY_INDEX_DIR to run' }, async () => {
    const { first } = await skyHead(read, det);
    let big = 0;
    for (let c = 1; c < first.length - 1; c++) if (first[c + 1] - first[c] > first[big + 1] - first[big]) big = c;
    let busiest;
    for (let dec = -89.95; !busiest && dec < 90; dec += 0.1) for (let ra = 0.05; ra < 360; ra += 0.1) if (cellAt(ra, dec) === big) { busiest = [ra, dec]; break; }
    for (const [ra, dec] of [[270, 66.560708], busiest, [180, 0]]) {
      const want = JSON.stringify({ ra, dec, det: `D${det}`, ...(await skyImages(read, ra, dec, det)), source: 'index' });
      assert.equal(await skyImagesJson(read, ra, dec, det), want, `D${det} at (${ra}, ${dec})`);
    }
  });
}
