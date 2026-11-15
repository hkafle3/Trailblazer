// Explore's deep zoom: past about 2,500 px of map width, sharp SPHEREx sky tiles (HiPS, from IRSA) are drawn over data/sky.jpg.
//
// How it works
//   One WebGL canvas, the size of the window, sits inside .map right above the sky picture and under every other layer.
//   A HiPS tile is a 512 px picture of one HEALPix cell. Each tile becomes a small textured mesh whose corners go through
//   skymap.js fwdLon() once, so tiles land exactly where the markers do. A pan or zoom only changes two uniforms.
//
// Rules (scratchpad plan, checks 4 to 6)
//   draw    on every view the engine publishes (explore-view.js onView), cached tiles only, coarse first
//   load    only once the view has been still for 120 ms; at most FLIGHT requests at a time, nearest the middle first.
//           A tile that arrives is drawn in the view of that moment; one nobody wants any more is dropped before decoding
//   fail    a tile that fails is left alone for 30 s, then asked for again without a gesture
//   memory  at most CACHE tiles on the GPU, least recently drawn out first
//   off     below ON px of map width, with no WebGL, or after a lost context, the canvas is hidden and sky.jpg shows
//
// Sizes: W is CSS px. The canvas holds window size x devicePixelRatio pixels. Tiles are picked for W x min(dpr, 1.5):
// an order-o tile is sharp up to a map 2831 x 2^o pixels wide, and order 5 is the deepest SPHEREx has.
import { fwdLon, inv, wrap, RAD } from './skymap.js';
import { onView, uvAt } from './explore-view.js';
import { nest2xyf, xyf2radec, radec2tile } from './healpix.js';

const HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
const MAXO = 5, ON = 2500, STILL = 120, FLIGHT = 24, BACKOFF = 30000, CACHE = 120, MESH_PX = 0.25, EDGE = 48;
const map = document.getElementById('map'), phone = matchMedia('(max-width: 640px)');
const DROP = new Error('not wanted any more');

let cv = null, gl = null, loc = null, dead = false, lost = false;
let view = null, order = 0, shown = false, seq = 0;   // seq counts view changes
let need = null, needSeq = -1;   // what the current view wants: computed at most once per view
let queue = [], still = 0, retry = 0, raf = 0;
const tiles = new Map(), pending = new Map(), failed = new Map(), ready = [];   // all keyed "order/tile"
export const stats = { requested: 0, loaded: 0, failed: 0, dropped: 0, bytes: 0 };

// order 0 is no sharper than sky.jpg, so the layer starts at order 1
const orderFor = W => Math.max(0, Math.min(MAXO, Math.ceil(Math.log2(W * Math.min(devicePixelRatio, 1.5) / 2831) - 0.1)));
const url = id => { const [o, k] = id.split('/'); return `${HIPS}/Norder${o}/Dir${Math.floor(k / 10000) * 10000}/Npix${k}.png`; };

// ---- WebGL: one program, one texture and one or two meshes per tile ----
const VS = 'attribute vec2 p, t; uniform vec3 mx, my; varying vec2 vT; void main() { vT = t; gl_Position = vec4(dot(mx, vec3(p, 1.)), dot(my, vec3(p, 1.)), 0., 1.); }';
const FS = 'precision mediump float; varying vec2 vT; uniform sampler2D s; void main() { gl_FragColor = vec4(texture2D(s, vT).rrr, 1.); }';
function init() {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); gl.attachShader(prog, s); }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
  gl.useProgram(prog);
  loc = { p: gl.getAttribLocation(prog, 'p'), t: gl.getAttribLocation(prog, 't'), mx: gl.getUniformLocation(prog, 'mx'), my: gl.getUniformLocation(prog, 'my') };
  gl.enableVertexAttribArray(loc.p); gl.enableVertexAttribArray(loc.t);
  return true;
}
function create() {   // on first need. false: this browser cannot draw the layer, and sky.jpg stays
  if (cv || dead) return !dead;
  const c = document.createElement('canvas');
  try { gl = c.getContext('webgl', { alpha: true, antialias: false }); } catch { gl = null; }
  if (!gl || !init()) { dead = true; gl = null; return false; }
  cv = c; cv.className = 'sky ld hips';   // .sky: the picture's colour filter applies to the tiles too
  c.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; tiles.clear(); cancel(); c.style.display = 'none'; });
  c.addEventListener('webglcontextrestored', () => { lost = !init(); if (!lost && shown) { c.style.display = ''; draw(); settle(); } });
  map.querySelector('img.sky').after(cv);
  return true;
}
// ---- a tile's mesh, in map fractions (0..1 across and down the oval's box) ----
// The tile's square is cut in four again and again, but only where it is needed: a piece is left whole once the flat
// piece is within MESH_PX device pixels of the true map at its middle and at the middles of its sides, measured at twice
// the tile's native map width (for order 5 that is the deepest zoom). So an ordinary tile is 16 pieces and a tile on a
// pole, where the map bends hardest, gets small pieces only beside the pole. A tile that crosses the map's left or right
// edge (RA 180) gets a second copy on the far side; .map's oval clips what hangs over.
export function tileGrid(o, k) {
  const n = 1 << o, [ix, iy, f] = nest2xyf(o, k), wd = 2831 * 2 ** (o + 1);
  const lonc = wrap(-xyf2radec((ix + .5) / n, (iy + .5) / n, f)[0] / RAD);
  const at = (x, y) => {   // [lon, dec] in degrees, lon unwrapped around the tile's middle so the tile stays in one piece
    const [ra, dec] = xyf2radec((ix + x) / n, (iy + y) / n, f);
    return [Math.abs(dec) > Math.PI / 2 - 1e-9 ? lonc : lonc + wrap(-ra / RAD - lonc), dec / RAD];   // a pole has no longitude
  };
  const seen = new Map();   // each point is asked for by up to four pieces and their parents
  const map = (x, y) => { const key = x * 4096 * 8192 + y * 4096; let m = seen.get(key); if (!m) seen.set(key, m = fwdLon(...at(x, y))); return m; };
  const off = (i, j, x, y) => { const m = map(x, y); return Math.hypot(((i[0] + j[0]) / 2 - m[0]) * wd, ((i[1] + j[1]) / 2 - m[1]) * wd / 2); };
  const pts = [];   // three per triangle: [x, y] in the tile
  let err = 0, lo = 1e9, hi = -1e9;
  (function cut(x, y, s, depth) {
    const h = s / 2, c = [map(x, y), map(x + s, y), map(x, y + s), map(x + s, y + s)];
    const e = Math.max(off(c[1], c[2], x + h, y + h), off(c[0], c[1], x + h, y), off(c[2], c[3], x + h, y + s), off(c[0], c[2], x, y + h), off(c[1], c[3], x + s, y + h));
    if ((depth < 2 || e > MESH_PX) && depth < 10) { cut(x, y, h, depth + 1); cut(x + h, y, h, depth + 1); cut(x, y + h, h, depth + 1); cut(x + h, y + h, h, depth + 1); return; }
    err = Math.max(err, e);
    pts.push([x, y], [x + s, y], [x, y + s], [x + s, y], [x + s, y + s], [x, y + s]);   // split along x + y = const: HEALPix has a crease there, where its polar caps begin
  })(0, 0, 1, 0);
  const sky = pts.map(([x, y]) => at(x, y));
  for (const [lon] of sky) { lo = Math.min(lo, lon); hi = Math.max(hi, lon); }
  return [0, hi > 180 ? -360 : null, lo < -180 ? 360 : null].filter(s => s !== null).map(shift => {
    const a = new Float32Array(pts.length * 4), box = [1e9, 1e9, -1e9, -1e9];
    pts.forEach(([x, y], q) => {
      const [u, v] = fwdLon(sky[q][0] + shift, sky[q][1]);
      a.set([u, v, y, x], q * 4);   // the tile picture's column runs along iy and its row along ix (sky.js tileUV)
      box[0] = Math.min(box[0], u); box[1] = Math.min(box[1], v); box[2] = Math.max(box[2], u); box[3] = Math.max(box[3], v);
    });
    return { a, n: pts.length, box, err };
  });
}

// ---- what a view wants: its tiles at the right order, nearest the middle first, and how much of the window is covered ----
function wants() {
  if (needSeq === seq) return need;
  const vw = innerWidth, vh = innerHeight, ids = new Map();
  let inside = 0, have = 0;
  for (let y = -EDGE; y <= vh + EDGE; y += 32) for (let x = -EDGE; x <= vw + EDGE; x += 32) {
    const rd = inv(...uvAt(x, y));
    if (!rd) continue;
    const id = order + '/' + radec2tile(order, rd[0] * RAD, rd[1] * RAD), d = (x - vw / 2) ** 2 + (y - vh / 2) ** 2;
    if (!(ids.get(id) <= d)) ids.set(id, d);
    if (x >= 0 && x <= vw && y >= 0 && y <= vh) { inside++; if (tiles.has(id)) have++; }
  }
  needSeq = seq;
  return need = { ids, inside, have };
}

// ---- loading ----
function cancel() {   // forget everything on its way: the view it was for is gone
  clearTimeout(still); clearTimeout(retry); still = retry = 0;
  for (const c of pending.values()) c.abort();
  pending.clear(); queue = [];
  for (const r of ready.splice(0)) r.bmp.close();
}
const replan = () => { retry = 0; if (!still) plan(); };   // a failed tile's second try; a moving view plans by itself when it stops
function settle() { clearTimeout(still); still = setTimeout(plan, STILL); }
function plan() {
  still = 0;
  if (!shown || lost) return;
  const now = performance.now(), { ids } = wants();
  for (const [id, c] of pending) if (!ids.has(id)) { c.abort(); pending.delete(id); }
  const waiting = [];
  queue = [...ids].filter(([id]) => {
    if (tiles.has(id) || pending.has(id) || ready.some(r => r.id === id)) return false;
    const t = failed.get(id);
    if (t > now - BACKOFF) { waiting.push(t); return false; }
    return true;
  }).sort((a, b) => a[1] - b[1]).map(a => a[0]);
  clearTimeout(retry); retry = 0;
  if (waiting.length) retry = setTimeout(replan, Math.min(...waiting) + BACKOFF - now + 50);
  if (tiles.size > CACHE) for (const [id, t] of [...tiles].filter(([id]) => !ids.has(id)).sort((a, b) => a[1].used - b[1].used).slice(0, tiles.size - CACHE)) {
    gl.deleteTexture(t.tex); t.meshes.forEach(m => gl.deleteBuffer(m.b)); tiles.delete(id);
  }
  pump();
}
function pump() {
  while (pending.size < FLIGHT && queue.length) {
    const id = queue.shift(), ctl = new AbortController();
    pending.set(id, ctl); stats.requested++;
    const wanted = () => pending.get(id) === ctl && shown && !lost && wants().ids.has(id);
    fetch(url(id), { signal: ctl.signal })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(b => { stats.bytes += b.size; if (!wanted()) throw DROP; return createImageBitmap(b); })
      .then(bmp => { if (!wanted()) { bmp.close(); throw DROP; } ready.push({ id, bmp }); frame(); })
      .catch(e => {
        if (e === DROP) stats.dropped++;
        else if (e.name !== 'AbortError') { stats.failed++; failed.set(id, performance.now()); if (!retry) retry = setTimeout(replan, BACKOFF + 50); }
      })
      .finally(() => { if (pending.get(id) === ctl) pending.delete(id); pump(); });
  }
}
// arrivals: put on the GPU a few per frame (about 3 ms of work), then draw the view of this moment
function frame() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (lost || !shown) return;
    const t0 = performance.now();
    while (ready.length && performance.now() - t0 < 3) {
      const { id, bmp } = ready.shift(), [o, k] = id.split('/').map(Number), tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, bmp); bmp.close();
      gl.generateMipmap(gl.TEXTURE_2D);   // a tile can be drawn smaller than it is while the view zooms out
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const meshes = tileGrid(o, k).map(m => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, m.a, gl.STATIC_DRAW); return { b, n: m.n, box: m.box }; });
      tiles.set(id, { o, tex, meshes, used: t0 }); failed.delete(id); stats.loaded++; needSeq = -1;
    }
    draw();
    if (ready.length) frame();
  });
}

// ---- drawing: every cached tile that touches the window, up to one order finer than the view needs, coarse first ----
function draw() {
  if (!shown || lost) return;
  const { W, X, Y, M, C } = view, H = W / 2, vw = innerWidth, vh = innerHeight, dpr = devicePixelRatio, cw = Math.round(vw * dpr), ch = Math.round(vh * dpr), now = performance.now();
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  // .map's top-left corner is at (X, Y) in the layout, so this puts the canvas over the window. A straightened map
  // (explore-view.js) carries M; the canvas undoes it about the same pivot to stay square to the window, and M goes
  // into the drawing: window point = C + M (layout point - C), layout point = (X + u W, Y + v H)
  cv.style.left = -X + 'px'; cv.style.top = -Y + 'px'; cv.style.width = vw + 'px'; cv.style.height = vh + 'px';
  cv.style.transformOrigin = `${C[0]}px ${C[1]}px`; cv.style.transform = M[1] || M[2] || M[0] !== 1 || M[3] !== 1 ? 'var(--un)' : '';
  gl.viewport(0, 0, cw, ch); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  const ox = C[0] + M[0] * (X - C[0]) + M[1] * (Y - C[1]), oy = C[1] + M[2] * (X - C[0]) + M[3] * (Y - C[1]);
  gl.uniform3f(loc.mx, 2 / vw * M[0] * W, 2 / vw * M[1] * H, 2 / vw * ox - 1); gl.uniform3f(loc.my, -2 / vh * M[2] * W, -2 / vh * M[3] * H, 1 - 2 / vh * oy);
  const us = [], vs = [];   // the window's corners on the map
  for (const [x, y] of [[0, 0], [vw, 0], [0, vh], [vw, vh]]) { const [u, v] = uvAt(x, y); us.push(u); vs.push(v); }
  const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
  for (let o = 1; o <= Math.min(MAXO, order + 1); o++) for (const t of tiles.values()) {
    if (t.o !== o) continue;
    for (const m of t.meshes) {
      if (m.box[0] > u1 || m.box[2] < u0 || m.box[1] > v1 || m.box[3] < v0) continue;
      t.used = now;
      gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.bindBuffer(gl.ARRAY_BUFFER, m.b);
      gl.vertexAttribPointer(loc.p, 2, gl.FLOAT, false, 16, 0); gl.vertexAttribPointer(loc.t, 2, gl.FLOAT, false, 16, 8);
      gl.drawArrays(gl.TRIANGLES, 0, m.n);
    }
  }
}

function hide() {
  if (!shown) return;
  shown = false; cancel();
  if (cv) cv.style.display = 'none';
}
onView(v => {
  view = v; seq++; order = orderFor(v.W);
  if (v.W < ON || order < 1 || !create()) return hide();
  if (!shown) { shown = true; if (!lost) cv.style.display = ''; }
  queue = [];   // nothing new is asked for while the view moves; what is already on its way may still land
  draw(); settle();
});
// leaving the phone layout hands .map-wrap back to the page's own oval (the whole sky) without a new view from the engine
phone.addEventListener('change', () => { if (!phone.matches) hide(); });

// for the tests (web/tests/deep_zoom_ui.py)
export const state = () => ({ shown, order, dead, lost, cached: tiles.size, tiles: [...tiles.keys()], wantIds: shown ? [...wants().ids.keys()] : [], pending: pending.size, queued: queue.length, ready: ready.length,
  covered: shown && !lost ? (({ inside, have }) => (inside ? have / inside : 1))(wants()) : 0, wanted: shown ? wants().ids.size : 0 });
export const redraw = draw;
