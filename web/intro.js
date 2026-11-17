// "How this map was made": an 81 second 3D film that ends on the flat Explore map. It plays over Explore on a first
// visit (explore.html decides, before the tour) and from the "How this map was made" button (explore.js).
// Nothing here is loaded until it plays: explore.js imports this file, which then fetches intro.css, three.js and
// data/intro/ (bake/intro_assets.py). When it ends the WebGL context is given back and the page is as it was.
//
// play() draws a black screen with Skip at once, loads the film behind it, plays it, and resolves when the film has
// handed over to the map (played to the end, skipped with the button or Escape, or failed to load).
// Reduced motion: sixteen stills, one per caption, with a Next button.
// The film itself is film(): everything on screen is a pure function of the film time T (seconds), so it can be
// played, skipped, stepped and recorded frame by frame.
import { win, straight } from './explore-view.js';

const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';   // the version timelapse.html uses
// the bare minimum to see the cover and Skip before intro.css arrives (zero specificity, so intro.css wins once it does)
const SHELL = `<style>:where(#intro){position:fixed;inset:0;z-index:200;background:#010206;color:#fff}:where(#intro-skip){position:absolute;right:14px;top:12px;min-height:44px;padding:0 18px;color:#fff;background:#000;border:1px solid #fff}</style>
  <canvas id="intro-gl"></canvas>
  <div id="intro-labels" aria-hidden="true"></div>
  <canvas id="intro-spec" aria-hidden="true"></canvas>
  <div id="intro-odo" aria-hidden="true"><b></b><span>from Earth</span></div>
  <div id="intro-hud" aria-hidden="true"><span id="intro-h-date"></span><span id="intro-h-count"></span></div>
  <button id="intro-skip" type="button">Skip</button>
  <div id="intro-cap">
    <div class="cap-top"><span id="intro-cap-n">1 / 8</span><span id="intro-cap-ticks"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><button id="intro-next" type="button" hidden>Next</button></div>
    <p id="intro-cap-text" aria-live="polite"></p>
    <p id="intro-cap-note"></p>
  </div>
  <div id="intro-loading">Loading the sky</div>`;

let running = null;
export const play = () => (running ??= run().finally(() => { running = null; }));

async function run() {
  const html = document.documentElement, back = document.activeElement;
  try { localStorage.setItem('ch.intro', '1'); } catch { /* private mode: it plays again next time */ }
  const root = Object.assign(document.createElement('div'), { id: 'intro', innerHTML: SHELL });
  root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'How the sky map is made');
  const under = [...document.body.children].filter(el => !el.inert);   // the page underneath takes no clicks or keys meanwhile
  under.forEach(el => { el.inert = true; });
  document.body.append(root); html.dataset.intro = 'on';   // the black cover explore.html put up (data-intro="wait") is no longer needed
  const off = new AbortController();
  let end, skip = () => end(), made = null;   // until the film is up, Skip and Escape leave at once
  const ended = new Promise(done => { end = done; });
  const skipBtn = root.querySelector('#intro-skip');
  skipBtn.onclick = () => skip(); root.tabIndex = -1; root.focus({ preventScroll: true });   // Tab goes to Skip next
  addEventListener('keydown', e => { if (e.key === 'Escape') skip(); }, { signal: off.signal });
  let torn = false;
  function teardown() {   // everything the film put on the page, taken off at once
    if (torn) return; torn = true;
    off.abort(); made?.dispose(); root.remove(); under.forEach(el => { el.inert = false; }); delete html.dataset.intro;
  }
  // leaving the page ends it there and then, loading or playing: a page kept for the back button must not come back with the film still up
  addEventListener('pagehide', () => { teardown(); end(); }, { signal: off.signal });
  // every load wait is bounded: a stalled intro.css, three.js or data/intro/ lands on the map instead of a black screen
  const LOAD_MS = 8000, late = setTimeout(() => { if (!made) { console.warn('the map intro took too long to load'); end(); } }, LOAD_MS);
  let over = false; ended.then(() => { over = true; clearTimeout(late); });
  if (!document.querySelector('link[href="intro.css"]')) await Promise.race([ended, new Promise(done => document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'intro.css', onload: done, onerror: done })))]);
  if (!over) film(root, off.signal, end).then(f => { made = f; if (off.signal.aborted) f.dispose(); else if (f.skip) skip = f.skip; },
    err => { console.warn('the map intro could not load', err); end(); });
  await ended;
  teardown();
  if (back?.isConnected) back.focus?.({ preventScroll: true });
}

// ---------------------------------------------------------------- the film
// Data: data/intro/tiles.bin (real SPHEREx photo footprints), scene.json (JPL Horizons orbits), sky.jpg (the all-sky picture),
// photo.jpg and photo.json (the first photo itself, what is in it and how far away, one star's spectrum: bake/intro_photo.py),
// sheba.png (that photo's own pixels round one asteroid), and data/comets/3i-atlas/ (the comet page's own measurements).
// The film is in three parts. The first stays with one photo: what it is, how deep it is, that the faint things in it
// are really there, why it holds many colours. The second is the deck of colours: what the colours are for, shown on
// comet 3I/ATLAS. The third pulls back to the ring, the whole sky and the map. The clocks are explained where they are made.
async function film(root, signal, done) {
const THREE = await import(THREE_URL);
if (signal.aborted) return { dispose() {} };   // skipped while three.js was loading: nothing was made yet

const Q = new URLSearchParams(location.search);
const $ = id => root.querySelector('#intro-' + id);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const EPS = 23.4392911 * Math.PI / 180, R2 = Math.SQRT2, TAU = 2 * Math.PI;
const REC = Q.get('intro') === 'rec';   // ?intro=rec: nothing plays; a recorder draws frames with window.__intro.render(seconds)
const REDUCED = !REC && matchMedia('(prefers-reduced-motion: reduce)').matches;
// ecliptic (x, y, z) -> three.js (y up = ecliptic north)
const v3 = (x, y, z, o = V()) => o.set(x, z, -y);
const Y = V(0, 1, 0);
const tmp = V(), tmp2 = V(), tmp3 = V(), tmp4 = V(), tmp5 = V(), skewM = new THREE.Matrix4();
// the map's own axes in the 3D world: F = towards RA 0 (the middle of the map), N = sky north (map up), RT = map right
const F = V(1, 0, 0), N = V(0, Math.cos(EPS), -Math.sin(EPS)), RT = V(0, Math.sin(EPS), Math.cos(EPS));

// ---------- small maths: easing, keyframes ----------
const clamp01 = x => Math.min(1, Math.max(0, x));
const sm = x => { x = clamp01(x); return x * x * x * (x * (6 * x - 15) + 10); };
function K(T, keys) {   // eased steps between [time, value] keys
  if (T <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (T < keys[i][0]) { const [t0, a] = keys[i - 1], [t1, b] = keys[i]; return a + (b - a) * sm((T - t0) / (t1 - t0)); }
  return keys.at(-1)[1];
}
const KL = (T, keys) => Math.exp(K(T, keys.map(([t, v]) => [t, Math.log(v)])));
function lin(x, keys, a, b) {   // straight lines through the keys, from column a to column b; past the ends it runs on at 1:1
  if (x <= keys[0][a]) return keys[0][b]; const n = keys.length - 1; if (x >= keys[n][a]) return keys[n][b] + x - keys[n][a];
  let i = 1; while (x > keys[i][a]) i++; return keys[i - 1][b] + (keys[i][b] - keys[i - 1][b]) * (x - keys[i - 1][a]) / (keys[i][a] - keys[i - 1][a]);
}
function pchip(keys) {   // smooth, never-reversing curve through the keys (film time -> survey day)
  const n = keys.length, h = [], d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) { h[i] = keys[i + 1][0] - keys[i][0]; d[i] = (keys[i + 1][1] - keys[i][1]) / h[i]; }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (() => { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; return (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); })();
  return T => {
    if (T <= keys[0][0]) return keys[0][1]; if (T >= keys[n - 1][0]) return keys[n - 1][1];
    let i = 0; while (T > keys[i + 1][0]) i++;
    const t = (T - keys[i][0]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * keys[i][1] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * keys[i + 1][1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

// ---------- the film's clock ----------
// Three clocks. U is the film's own seconds (what plays, and what the captions are timed in). T is the second cut's
// seconds: that cut's close look at one photo is keyed in T, and v2() turns U into T. Twice T stands still while a beat
// of this cut plays on U: the push-in on one asteroid (SH), and the deck of colours (DK), which is its own scene. The
// film cuts into the deck and back out, and T jumps past the old pull-back from the star while it is away.
// The second half (after X) is the first cut's, still keyed in that cut's seconds: w() turns T into them, wi() back.
const X = 35.8;   // T: the close look at one photo ends here, and the film pulls back
const WARP = [[0, 0], [4.8, 4.8], [X, 4.8], [X + 3, 8.6], [X + 6.2, 12.2], [X + 10.8, 19.3], [X + 14.8, 23.9], [X + 16.6, 30.2], [X + 26, 39.6]];   // [T, first cut's seconds]
const w = T => lin(T, WARP, 0, 1), wi = t => lin(t, WARP.slice(2), 1, 0);
const SH_T = 20.8, SH = 5.6, DK_T = 35.6, DK = 16.5, BACK_T = X + .6, DIP = .3;   // DIP: seconds to fade to black and back at each cut
const CLOCK = [[0, 0], [1, 1]];   // [U, T]: the same until the push-in
const FLY0 = 9, FLY1 = 13.2, OVER = 14.6;   // T: the flight down the beam, and when the camera has pulled out to see all of it
const SH_U = lin(SH_T, CLOCK, 1, 0), DK_U = SH_U + SH + DK_T - SH_T, DK_END = DK_U + DK;   // the deck is on screen from DK_U + DIP to DK_END - DIP
const v2 = U => U < SH_U ? lin(U, CLOCK, 0, 1) : U < DK_END - DIP ? Math.min(DK_T, SH_T + Math.max(0, U - SH_U - SH)) : BACK_T + U - (DK_END - DIP);
const fu = T => T <= SH_T ? lin(T, CLOCK, 1, 0) : T <= DK_T ? T - SH_T + SH_U + SH : T - BACK_T + DK_END - DIP;   // when the film reaches T
const T_END = fu(wi(39.6)), T_HANDOVER = fu(wi(37.7));   // in U
const STEP_T = [28.4, 29.4, 30.4];   // T: when the telescope takes its second, third and fourth photo
const shellR = T => KL(w(T), [[8, .3], [11, .3], [13, .42], [18.7, .42], [21.7, R_BIG]]);
const EARTH_R = .022, ORBIT_R = .054, CRAFT = .0125, R_BIG = 3.2;   // drawing sizes in AU (illustrative)
// the deck's own seconds (U - DK_U): the question, the fan, the answer
const DQ = 4.4, D_FAN = 3.2, D_LIT = 8.8, D_POP = 10;

const NOTE_PHOTO = 'The real photo: the first in SPHEREx’s public archive, 24 April 2025 (NASA/IPAC IRSA).';
const NOTE_DEPTH = 'Real distances on a compressed scale: asteroids from IMCCE SkyBoT, stars from Gaia, the galaxy from its redshift.';
const NOTE_MAP = 'This way of flattening a sphere is called a Mollweide projection.';
const fw = t => fu(wi(t));
const CAPTIONS = [   // [from, to (U), step 1..8, text, small note]. Few words: every beat has to read with these hidden
  [.5, 4.3, 1, '<b>SPHEREx</b>: a telescope in orbit around Earth.', 'Earth, SPHEREx and its orbit are drawn far larger than life.'],
  [4.8, 8.6, 2, 'One <b>photo</b>. Seven full Moons wide.', NOTE_PHOTO],
  [8.9, fu(16.4), 3, 'The photo is flat. Space is <b>deep</b>.', NOTE_DEPTH],
  [fu(16.7), SH_U - .1, 3, 'Near or far, it all lands on <b>one flat photo</b>.', 'Each ring marks its place in the real photo.'],
  [SH_U + .2, SH_U + SH - .5, 3, 'This asteroid is <b>one pixel</b>.', 'The photo’s own pixels, each 6 arcseconds wide. Sheba was predicted to be here (IMCCE SkyBoT); Gaia lists no star.'],
  [fu(21.5), fu(26), 4, 'Each stripe of the photo sees a different <b>color</b>.', 'Infrared has no colors we can see: these stand for its wavelengths. The bright band is real, helium glowing above Earth.'],
  [fu(26.3), fu(31), 4, 'The telescope steps. The star lands on the <b>next color</b>.', 'The next three real photos, two minutes apart.'],
  [fu(31.3), DK_U - .1, 4, 'One star in 102 colors: its <b>spectrum</b>.', 'Real SPHEREx measurements, April 2025 to May 2026. Pale bars had a flagged pixel nearby.'],
  [DK_U + DIP + .2, DK_U + DQ, 5, 'Two dots. <b>Which one is the comet?</b>', 'Two real objects. The star is the one from before, from another part of the sky, scaled to start as bright as the comet.'],
  [DK_U + DQ + .3, DK_U + D_LIT - .3, 5, 'Look at them in <b>every color</b>.', 'A bigger glow is a brighter reading. Each sheet is its own exposure, taken over about a week in December 2025. The tint only names the color.'],
  [DK_U + D_LIT, DK_U + 13.4, 5, 'The comet <b>blazes in one color</b>: carbon dioxide gas.', 'Real SPHEREx readings of comet 3I/ATLAS. Smaller rises near 2.7 and 4.7 microns are not judged here. Pale: less sure. Dashed: no reading.'],
  [DK_U + 13.7, DK_END - DIP, 5, 'A photo shows <b>where</b>. A spectrum shows <b>what</b>.', 'The photo held up is the real one of the brightest sheet.'],
  [fu(BACK_T + .15), fw(12.2), 6, 'Photo after photo makes a <b>ring</b>.', 'Each square is one real photo, placed where SPHEREx pointed: at right angles to the Sun.'],
  [fw(12.5), fw(19.3), 6, 'In six months the ring <b>sweeps the whole sky</b>.', 'Real pointings, April to October 2025. One photo in three is drawn.'],
  [fw(19.9), fw(30.2), 7, 'Every photo together: the <b>whole sky</b>.', 'The sphere has no true size. It is only a way to draw directions. Planet orbits from NASA JPL.'],
  [fw(30.7), fw(36.9), 8, 'Unfold it, and you get the <b>map</b>.', NOTE_MAP],
];
const STILLS = [3.6, 8.2, fu(15.6), fu(20.6), SH_U + 3, fu(25.4), fu(30.7), fu(35.2), DK_U + 3, DK_U + 8, DK_U + 12.6, DK_U + 15, fw(11), fw(15), fw(22.9), fw(35.6)];   // one frame per caption, for reduced motion

// ---------- renderer ----------
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: REC });
let playing = false, debug = null;
function dispose() { playing = false; renderer.dispose(); renderer.forceContextLoss(); if (window.__intro === debug) delete window.__intro; }
try {
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, .01, 100);
let W = 1, H = 1, VFOV = 40;
function resize() {
  W = innerWidth; H = innerHeight; VFOV = W < H ? 50 : 40;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.setSize(W, H, false);
}
resize();

// every load stops when the film is skipped (Skip, Escape, the load timeout): the renderer is let go at once, not after a stalled request
const gone = new Promise((_, no) => { if (signal.aborted) no(signal.reason); else signal.addEventListener('abort', () => no(signal.reason), { once: true }); });
const tex = url => new THREE.TextureLoader().loadAsync(url);   // image loads cannot take a signal; the race below stops waiting for them
let loaded;
try {
  loaded = await Promise.race([gone, Promise.all([
    fetch('data/intro/scene.json', { signal }).then(r => r.json()), fetch('data/intro/tiles.bin', { signal }).then(r => r.arrayBuffer()),
    tex('data/intro/sky.jpg'), fetch('data/intro/photo.json', { signal }).then(r => r.json()),
    tex('data/intro/photo.jpg'), tex('data/intro/sheba.png'),
    fetch('data/comets/3i-atlas/comet.json', { signal }).then(r => r.json()).then(async c => [c, await tex('data/comets/3i-atlas/' + c.photos.reduce((a, q) => q.flux > a.flux ? q : a).file)]),   // comet 3I/ATLAS as the app measured it, and its brightest photo
    document.fonts.load('17px "Space Mono"'),
  ])]);
} catch (err) { if (signal.aborted) { dispose(); return { dispose }; } throw err; }   // skipped while the data was loading
if (signal.aborted) { dispose(); return { dispose }; }
const [S, tileBuf, skyTex, PH, picTex, zoomTex, [CM, cometTex]] = loaded;
for (const t of [zoomTex, cometTex]) { t.colorSpace = t === zoomTex ? THREE.NoColorSpace : THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; }   // real pixels, shown as squares
zoomTex.flipY = false;   // row 0 of sheba.png is the lowest detector row
skyTex.colorSpace = THREE.NoColorSpace; skyTex.wrapS = THREE.RepeatWrapping; skyTex.anisotropy = 8;
picTex.colorSpace = THREE.NoColorSpace; picTex.flipY = false; picTex.anisotropy = 8;   // row 0 of photo.jpg is the top of the tile's square
const STEP = S.step, NDAY = S.days;
function seriesAt(arr, day, o) {   // flat xyz every STEP days from day 0 -> position on a day
  const f = Math.max(0, Math.min(NDAY / STEP - 1e-6, day / STEP)), i = Math.floor(f), u = f - i;
  return v3(arr[3 * i] + u * (arr[3 * i + 3] - arr[3 * i]), arr[3 * i + 1] + u * (arr[3 * i + 4] - arr[3 * i + 1]), arr[3 * i + 2] + u * (arr[3 * i + 5] - arr[3 * i + 2]), o);
}
const earthAt = (d, o) => seriesAt(S.earth, d, o);
function eqDir(ra, dec, o = V()) {   // RA, Dec degrees -> unit vector in the 3D world
  const a = ra * Math.PI / 180, d = dec * Math.PI / 180, x = Math.cos(d) * Math.cos(a), y = Math.cos(d) * Math.sin(a), z = Math.sin(d);
  return v3(x, Math.cos(EPS) * y + Math.sin(EPS) * z, -Math.sin(EPS) * y + Math.cos(EPS) * z, o);
}

// ---------- shared GLSL: the SPHEREx all-sky picture looked up by direction ----------
const SKY_GLSL = `uniform sampler2D uSky;
vec3 skyColor(vec3 d){
  float lon = atan(-d.z, d.x), v = .5 + asin(clamp(d.y, -1., 1.)) / 3.14159265;
  float u = lon / 6.2831853, ua = fract(u), ub = fract(u + .5) - .5;       // two unwrappings, so the seam does not blur
  vec2 dx = vec2(dFdx(ua), dFdx(v)), dy = vec2(dFdy(ua), dFdy(v)), ex = vec2(dFdx(ub), dx.y), ey = vec2(dFdy(ub), dy.y);
  if (dot(ex, ex) + dot(ey, ey) < dot(dx, dx) + dot(dy, dy)) { dx = ex; dy = ey; }
  vec3 c = textureGrad(uSky, vec2(ua, v), dx, dy).rgb;
  c = (c * 1.9 - .5) * 1.05 + .5;                                          // Explore's look: brighter, cool white
  return clamp(c, 0., 1.) * vec3(.84, .92, 1.1);
}`;
const uSky = { value: skyTex }, uLift = { value: 1 };

// ---------- the photo tiles: one instanced square per real SPHEREx photo footprint ----------
const NT = tileBuf.byteLength / 16, tDay = new Float32Array(NT), tC = new Float32Array(NT * 3), tE = new Float32Array(NT * 3);
{
  const dv = new DataView(tileBuf), p = V();
  for (let i = 0; i < NT; i++) {
    const o = 16 * i; tDay[i] = dv.getFloat32(o, true);
    v3(dv.getInt16(o + 4, true), dv.getInt16(o + 6, true), dv.getInt16(o + 8, true), p).divideScalar(32767).toArray(tC, 3 * i);
    v3(dv.getInt16(o + 10, true), dv.getInt16(o + 12, true), dv.getInt16(o + 14, true), p).divideScalar(32767 * 16).toArray(tE, 3 * i);
  }
}
const EARLY = (() => { let i = 0; while (tDay[i] < 4.75) i++; return i; })();   // every photo is kept up to here, then one in three
// seconds -> day of the survey (day 0 = MJD 60789). The first photo is taken at 4.6 s and time then stands still while
// the film looks at it; the next three photos are the steps at STEP_T; after X it runs as in the first cut.
const dayAt = pchip([[0, tDay[0] - .016], [4, tDay[0] - .0012], [4.6, tDay[0] + .0001], [5.4, tDay[0] + .0007], [STEP_T[0] - .6, tDay[0] + .0007],
  ...STEP_T.flatMap((t, k) => [[t - .2, tDay[k + 1] - .0004], [t + .2, tDay[k + 1] + .0003]]), [X, tDay[3] + .0006],
  ...[[6.5, .84], [8, 1.25], [9.5, 2.6], [11, 5.5], [12.5, 16], [17.5, 176], [19, 186], [22, 200], [25.5, 227.3], [27.5, 229], [29.5, 232], [31, 232.6], [41, 232.6]].map(([t, d]) => [wi(t), d])]);
function tileIndex(day) { let lo = 0, hi = NT; while (lo < hi) { const m = (lo + hi) >> 1; tDay[m] <= day ? lo = m + 1 : hi = m; } return lo; }   // photos taken so far
const tileGeo = new THREE.InstancedBufferGeometry();
tileGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3)); tileGeo.setIndex([0, 1, 2, 0, 2, 3]);
tileGeo.setAttribute('iC', new THREE.InstancedBufferAttribute(tC, 3)); tileGeo.setAttribute('iE', new THREE.InstancedBufferAttribute(tE, 3));
tileGeo.setAttribute('iDay', new THREE.InstancedBufferAttribute(tDay, 1));
const tileU = { uSky, uCenter: { value: V() }, uR: { value: .3 }, uNow: { value: 0 }, uFresh: { value: .001 }, uFill: { value: 1 }, uFront: { value: 1 }, uSeam: { value: .3 }, uAlpha: { value: 1 }, uLift };
const tiles = new THREE.Mesh(tileGeo, new THREE.ShaderMaterial({
  uniforms: tileU, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  vertexShader: `attribute vec3 iC, iE; attribute float iDay; uniform vec3 uCenter; uniform float uR, uNow, uFresh;
    varying vec3 vDir; varying vec2 vQ; varying float vF, vFront;
    void main(){ vec3 d = iC + position.x * iE + position.y * cross(iC, iE), wp = uCenter + uR * d;
      vDir = d; vQ = position.xy; vF = 1. - smoothstep(0., uFresh, uNow - iDay);
      vFront = step(0., dot(iC, cameraPosition - wp));          // seen from outside the sphere
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.); }`,
  fragmentShader: `${SKY_GLSL} uniform float uFill, uFront, uSeam, uAlpha, uLift; varying vec3 vDir; varying vec2 vQ; varying float vF, vFront;
    void main(){ float e = max(abs(vQ.x), abs(vQ.y)), w = fwidth(e) * 1.2, line = smoothstep(1. - 2.2 * w, 1. - w, e) * clamp(1.6 - w * 5., 0., 1.);
      float fill = uFill * mix(1., uFront, vFront), la = line * max(vF, uSeam);
      vec3 col = skyColor(normalize(vDir)) * (1. + .5 * uLift + 1.1 * vF) + vec3(.1, .15, .24) * vF * vF + vec3(.016, .024, .042) * uLift;
      col = mix(col, vec3(1.), la);
      float a = max(max(fill, la), vFront * vF * .25) * uAlpha; if (a < .004) discard;
      gl_FragColor = vec4(col, a); }`
}));
tiles.frustumCulled = false; tiles.renderOrder = 2; scene.add(tiles);

// ---------- the first photo itself, on its own tile (tile 0), and the colours of the filter over the photo being taken ----------
// A point of the tile's square is c + u e + v f, u and v from -1 to 1 (f = c x e): photo.jpg and photo.json use the same square.
const c0 = V().fromArray(tC, 0), e0 = V().fromArray(tE, 0), f0 = V().crossVectors(c0, e0), HALF = e0.length();   // HALF: half a photo, as a tangent
const PHOTO_R = .9845;   // a hair in front of the tiles
const photoPoint = (u, v, o = V()) => o.copy(c0).addScaledVector(e0, u).addScaledVector(f0, v).multiplyScalar(st.R * PHOTO_R).add(st.E);
function tileUV(k, d) {   // where direction d falls in photo k's square
  const c = tmp2.fromArray(tC, 3 * k), e = tmp3.fromArray(tE, 3 * k), q = tmp4.copy(d).divideScalar(d.dot(c)).sub(c), u = q.dot(e) / e.lengthSq();
  return [u, q.dot(tmp2.cross(e)) / tmp2.lengthSq()];
}
const LC = PH.lam.coef, BAND = PH.lam.band;   // wavelength in microns at (u, v) of a detector 1 photo: bake/intro_photo.py's fit to data/wavemaps.json
const lamAt = (u, v) => LC[0] + LC[1] * u + LC[2] * u * u + LC[3] * v * v + LC[4] * u * v * v + LC[5] * u * u * u + LC[6] * v + LC[7] * u * v;
const chanOf = (um, band) => Math.min(16, Math.max(0, Math.floor(17 * Math.log(um / band[0]) / Math.log(band[1] / band[0]))));   // 17 channels a detector, as live/spectral.js
// the colour that stands for each of the 102 channels (0.75 to 5 microns): violet to red, the same in the photo's stripes and the star's bars
const RAMP = [[164, 140, 255], [90, 155, 255], [85, 224, 240], [125, 234, 138], [255, 228, 107], [255, 154, 77], [255, 93, 93]];
function rampAt(t) { const x = clamp01(t) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x)); return RAMP[i].map((a, k) => Math.round(a + (RAMP[i + 1][k] - a) * (x - i))); }
const photoU = { uPic: { value: picTex }, uCenter: { value: V() }, uR: { value: .3 }, uC: { value: c0 }, uE: { value: e0 }, uF: { value: f0 }, uCk: { value: V() }, uEk: { value: V() },
  uAlpha: { value: 0 }, uStripe: { value: 0 }, uSweep: { value: 2 }, uEdge: { value: 0 }, uL: { value: LC }, uBand: { value: new THREE.Vector2(...BAND) } };
const photo = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3)).setIndex([0, 1, 2, 0, 2, 3]), new THREE.ShaderMaterial({
  uniforms: photoU, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  vertexShader: `uniform vec3 uCenter, uC, uE, uF; uniform float uR; varying vec3 vDir; varying vec2 vQ;
    void main(){ vDir = uC + position.x * uE + position.y * uF; vQ = position.xy; gl_Position = projectionMatrix * viewMatrix * vec4(uCenter + uR * vDir, 1.); }`,
  fragmentShader: `uniform sampler2D uPic; uniform vec3 uCk, uEk; uniform float uAlpha, uStripe, uSweep, uEdge, uL[8]; uniform vec2 uBand; varying vec3 vDir; varying vec2 vQ;
    vec3 ramp(float t){ t = clamp(t, 0., 1.) * 6.; vec3 c = ${RAMP.map((c, i) => { const v = `vec3(${c.map(x => (x / 255).toFixed(3)).join(', ')})`; return i ? `c = mix(c, ${v}, clamp(t - ${i - 1}., 0., 1.));` : `${v};`; }).join(' ')} return c; }
    void main(){ float lum = texture2D(uPic, vQ * .5 + .5).r, br = clamp(lum * 1.7, 0., 1.);
      vec3 col = br * vec3(.86, .93, 1.1);
      // the photo being taken now: its square on the sky, and the wavelength its filter passes at each point of it
      vec3 q = vDir / dot(vDir, uCk) - uCk, fk = cross(uCk, uEk); float u = dot(q, uEk) / dot(uEk, uEk), v = dot(q, fk) / dot(fk, fk), e = max(abs(u), abs(v));
      float lam = uL[0] + uL[1] * u + uL[2] * u * u + uL[3] * v * v + uL[4] * u * v * v + uL[5] * u * u * u + uL[6] * v + uL[7] * u * v;
      float ch = 17. * log(lam / uBand.x) / log(uBand.y / uBand.x), k = clamp(floor(ch), 0., 16.), fr = ch - k, wc = fwidth(ch);
      vec3 sc = ramp((k + .5) / 102.);
      float s = uStripe * step(e, 1.) * smoothstep(0., .08, uSweep - u), div = 1. - smoothstep(wc * .7, wc * 1.7, min(fr, 1. - fr));
      col = mix(col, br * sc * 1.3 + sc * (.13 + .06 * mod(k, 2.)), s);
      col = mix(col, sc * .5, div * s * .7);
      float we = fwidth(e) * 1.2, line = smoothstep(1. - 2.2 * we, 1. - we, e) * step(e, 1. + we);
      col = mix(col, vec3(1.), line * uEdge);
      gl_FragColor = vec4(col, uAlpha); }`
}));
photo.frustumCulled = false; photo.renderOrder = 2.5; scene.add(photo);

// ---------- the whole sky as one surface: a sphere that can unroll into the Mollweide oval ----------
const NX = 256, NY = 128;
const POLE_FROM = '.9', POLE_TO = '1.4', POLE_LAG = '.12';   // the poles' own rule (the shader below): from and to these latitudes in radians; they start to open this far into the unfolding
const shellGeo = new THREE.BufferGeometry();
{
  const ll = [], mo = [], dir = [], idx = [], p = V();
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
    const lon = (i / NX * 2 - 1) * Math.PI, lat = (.5 - j / NY) * Math.PI;   // map longitude (right is positive), Dec
    let t = lat; for (let k = 0; k < 12 && Math.abs(lat) < 1.5706; k++) t -= (2 * t + Math.sin(2 * t) - Math.PI * Math.sin(lat)) / (2 + 2 * Math.cos(2 * t));
    ll.push(lon, lat); mo.push(2 * R2 / Math.PI * lon * Math.cos(t), R2 * Math.sin(t));   // same formula as web/skymap.js fwdLon
    p.set(0, 0, 0).addScaledVector(F, Math.cos(lat) * Math.cos(lon)).addScaledVector(RT, Math.cos(lat) * Math.sin(lon)).addScaledVector(N, Math.sin(lat));
    dir.push(p.x, p.y, p.z);
  }
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i, b = a + NX + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  shellGeo.setAttribute('position', new THREE.Float32BufferAttribute(dir, 3));   // also the sky direction
  shellGeo.setAttribute('aLL', new THREE.Float32BufferAttribute(ll, 2)); shellGeo.setAttribute('aM', new THREE.Float32BufferAttribute(mo, 2));
  shellGeo.setIndex(idx);
}
const shellU = { uSky, uCenter: { value: V() }, uR: { value: 1 }, uT: { value: 0 }, uF: { value: F }, uRt: { value: RT }, uN: { value: N }, uAlpha: { value: 0 }, uGrid: { value: 0 }, uEcl: { value: 0 }, uMode: { value: 0 }, uLift };
const SHELL_VS = `attribute vec2 aLL, aM; uniform vec3 uCenter, uF, uRt, uN; uniform float uR, uT; varying vec3 vDir; varying vec2 vLL;
  void main(){
    // The poles open last. A sphere cut down its back and rolled flat has to tear open at each pole, and early on, while it
    // still reads as a ball, that showed as a hole. So high latitudes run on a later clock (tp), and each circle of latitude
    // there keeps the length it should have, which keeps a pole one point for as long as it can be.
    float wp = smoothstep(${POLE_FROM}, ${POLE_TO}, abs(aLL.y)), tp = mix(uT, smoothstep(${POLE_LAG}, 1., uT), wp);
    float s = max(1. - tp, 1e-4), rho = uR / s; vec2 ab = mix(aLL, aM, tp) * s;   // angles on a sphere that grows flat
    ab.x = mix(ab.x, s * mix(aLL.x * cos(aLL.y), aM.x, tp) / max(cos(ab.y), 1e-4), wp);
    float sx = sin(ab.x * .5), sy = sin(ab.y * .5);
    vec3 p = uCenter + uR * uF + rho * (sin(ab.x) * cos(ab.y) * uRt + sin(ab.y) * uN - 2. * (cos(ab.y) * sx * sx + sy * sy) * uF);
    vDir = position; vLL = aLL; gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.); }`;
const SHELL_FS = `${SKY_GLSL} uniform float uAlpha, uGrid, uEcl, uMode, uLift; varying vec3 vDir; varying vec2 vLL;
  void main(){ bool inner = gl_FrontFacing;
    vec2 g = vLL * 57.29578 / 30., fg = abs(fract(g - .5) - .5) / fwidth(g);
    float gl = max((1. - min(fg.x, 1.)) * smoothstep(1.4, 1.2, abs(vLL.y)), 1. - min(fg.y, 1.));
    if (uMode > .5) { if (inner) discard; gl_FragColor = vec4(vec3(1.), gl * uGrid * uAlpha); return; }   // the near side: lines on glass
    if (!inner) discard;
    vec3 d = normalize(vDir), col = skyColor(d) * (1. + .5 * uLift) + vec3(.016, .024, .042) * uLift;
    col = mix(col, vec3(1.), gl * uGrid);
    float ey = abs(d.y) / fwidth(d.y), dots = step(fract(atan(d.z, d.x) * 150. / 6.2831853), .3);   // the ecliptic, dotted as on Explore
    col = mix(col, vec3(1.), (1. - smoothstep(.6, 1.4, ey)) * dots * uEcl);
    gl_FragColor = vec4(col, uAlpha); }`;
const shell = new THREE.Mesh(shellGeo, new THREE.ShaderMaterial({ uniforms: shellU, vertexShader: SHELL_VS, fragmentShader: SHELL_FS, side: THREE.DoubleSide, transparent: true }));
const glassU = { ...shellU, uMode: { value: 1 }, uGrid: { value: 0 } };
const glass = new THREE.Mesh(shellGeo, new THREE.ShaderMaterial({ uniforms: glassU, vertexShader: SHELL_VS, fragmentShader: SHELL_FS, side: THREE.DoubleSide, transparent: true, depthWrite: false }));
shell.frustumCulled = glass.frustumCulled = false; shell.renderOrder = 1; glass.renderOrder = 9; scene.add(shell, glass);

// ---------- Sun, Earth, planets ----------
function glowTex(stops) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64); stops.forEach(([o, col]) => r.addColorStop(o, col));
  g.fillStyle = r; g.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const dotTex = glowTex([[0, '#fff'], [.5, '#fff'], [.72, 'rgba(255,255,255,0)'], [1, 'rgba(255,255,255,0)']]);
const sprite = (tex, add) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending })); s.renderOrder = 6; scene.add(s); return s; };
const sun = sprite(glowTex([[0, '#fff'], [.1, '#fff3d6'], [.3, 'rgba(255,180,90,.4)'], [1, 'rgba(255,140,60,0)']]), true);
const earthDot = sprite(glowTex([[0, '#fff'], [.3, '#bcd8ff'], [.6, 'rgba(127,184,255,.35)'], [1, 'rgba(127,184,255,0)']]), true);
const craftDot = sprite(dotTex, false);

const earthU = { uSun: { value: V(1, 0, 0) }, uA: { value: 1 } };
const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), new THREE.ShaderMaterial({
  uniforms: earthU, transparent: true,
  vertexShader: `varying vec3 vN, vP, vO; void main(){ vO = position; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform vec3 uSun; uniform float uA; varying vec3 vN, vP, vO;
    void main(){ vec3 n = normalize(vN), v = normalize(cameraPosition - vP), o = normalize(vO);
      float l = dot(n, uSun), day = smoothstep(-.12, .32, l), fr = pow(1. - max(dot(n, v), 0.), 2.6);
      vec3 col = mix(vec3(.004, .008, .02), vec3(.03, .1, .26) * (.3 + .9 * max(l, 0.)), day);
      vec2 g = vec2(atan(o.z, o.x), asin(o.y)) * 57.29578 / 15., fg = abs(fract(g - .5) - .5) / fwidth(g);
      float gl = max((1. - min(fg.x, 1.)) * smoothstep(.97, .9, abs(o.y)), 1. - min(fg.y, 1.));
      col += vec3(.55, .75, 1.) * gl * (.03 + .13 * day) + vec3(.3, .56, 1.) * fr * (.1 + .8 * day);
      gl_FragColor = vec4(col, uA); }`
}));
earth.renderOrder = 3; scene.add(earth);

const lineMat = (color, opacity = 1) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
const periods = { Mercury: 88, Venus: 225, Earth: 365.25, Mars: 687 };
const planets = S.planets.filter(p => periods[p.name]).map(p => {
  const n = p.orbit.length / 3, pts = []; for (let i = 0; i < n; i++) pts.push(v3(p.orbit[3 * i], p.orbit[3 * i + 1], p.orbit[3 * i + 2]));
  const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMat(0xffffff, 0)); line.renderOrder = 4; scene.add(line);
  return { name: p.name, pts, n, line, pos: V() };
});
function planetAt(p, day, o) { const f = ((day / periods[p.name]) * 360) % 360, i = Math.floor(f); return o.copy(p.pts[i % p.n]).lerp(p.pts[(i + 1) % p.n], f - i); }
const others = planets.filter(p => p.name !== 'Earth');
const pointsMat = (size, color) => new THREE.PointsMaterial({ size, sizeAttenuation: false, color, map: dotTex, transparent: true, depthWrite: false, opacity: 0 });
const planetDots = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(others.length * 3, 3)), pointsMat(7, 0xffffff));
const cometDots = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(S.comets.length * 3, 3)), pointsMat(4.5, 0x7fb8ff));
planetDots.frustumCulled = cometDots.frustumCulled = false; planetDots.renderOrder = cometDots.renderOrder = 5; scene.add(planetDots, cometDots);

// ---------- SPHEREx: three nested cone shields over a telescope and a small body (a simple model, not the flight CAD) ----------
function makeCraft() {
  const craft = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf1eee9, metalness: .15, roughness: .55, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171c, metalness: .4, roughness: .6 });
  const rim = lineMat(0xffffff, .9);
  [[1, .40, .86], [.84, .34, .93], [.68, .28, 1]].forEach(([top, bot, h]) => {
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(top, bot, h, 64, 1, true), white); cone.position.y = h / 2; craft.add(cone);
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 96 }, (_, i) => V(Math.cos(i / 96 * TAU) * top, h, Math.sin(i / 96 * TAU) * top))), rim); craft.add(ring);
  });
  const scope = new THREE.Mesh(new THREE.CylinderGeometry(.2, .2, .62, 32), dark); scope.position.y = .31; craft.add(scope);
  const bus = new THREE.Mesh(new THREE.CylinderGeometry(.33, .33, .42, 6), white); bus.position.y = -.2; craft.add(bus);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(.345, .345, .08, 6), dark); band.position.y = -.08; craft.add(band);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(.62, .9, .025), new THREE.MeshStandardMaterial({ color: 0x1b2a55, metalness: .5, roughness: .35 }));
  panel.position.set(0, -.12, .42); panel.rotation.x = -.16; craft.add(panel);
  return craft;
}
const craft = makeCraft(); craft.scale.setScalar(CRAFT); scene.add(craft);
const sunLight = new THREE.DirectionalLight(0xfff4e2, 3.2); scene.add(sunLight, sunLight.target);
scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x0a1020, .5));

// ---------- thin guide lines, rebuilt every frame (few points): SPHEREx's orbit, its line of sight, Sun to Earth, the right angle ----------
function dynLines(max, into = scene, order = 7) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(max * 6, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(max * 8, 4));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, depthTest: into === scene }));
  l.frustumCulled = false; l.renderOrder = order; into.add(l);
  let n = 0; const P = g.attributes.position.array, C = g.attributes.color.array;
  return {
    line: l, begin() { n = 0; },
    seg(a, b, col, ia = 1, ib = ia) { if (n >= max) return; a.toArray(P, 6 * n); b.toArray(P, 6 * n + 3); C.set([col[0], col[1], col[2], Math.min(1, ia), col[0], col[1], col[2], Math.min(1, ib)], 8 * n); n++; },
    dash(a, b, col, ia, k = 12) { for (let i = 0; i < k; i += 2) this.seg(tmp.copy(a).lerp(b, i / k), tmp2.copy(a).lerp(b, (i + 1) / k), col, ia); },
    end() { g.setDrawRange(0, 2 * n); g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = true; }
  };
}
const guides = dynLines(400);
function beamBody(into) {   // a beam's faint body: its four sides, from a point to the corners of a photo
  const m = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(15, 3)).setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]),
    new THREE.MeshBasicMaterial({ color: 0xbfd6ff, transparent: true, opacity: 0, depthWrite: false, depthTest: into === scene, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  m.frustumCulled = false; m.renderOrder = 6; into.add(m);
  m.put = (top, corners) => { const bp = m.geometry.attributes.position; top.toArray(bp.array, 0); corners.forEach((c, k) => c.toArray(bp.array, 3 + 3 * k)); bp.needsUpdate = true; };
  return m;
}
const beamFill = beamBody(scene);
const WHITE = [1, 1, 1], ACCENT = [1, .604, .302];

// ---------- SPHEREx's orbit: a circle side-on to the Sun; its phase is fitted to where the real photos pointed ----------
const st = { fly: 0, day: 0, E: V(), s: V(), u: V(), v: V(), p: V(), r: V(), t: V(), R: .3, look: V(), idx: 0, top: V(), px: 1, sideUp: V(0, 1, 0), sideRight: V(1, 0, 0) };   // top: the mouth of the telescope
function orbitFrame(day, E, s, u, v) { earthAt(day, E); s.copy(E).normalize().negate(); u.copy(Y).addScaledVector(s, -Y.dot(s)).normalize(); v.crossVectors(s, u); }
const PHASE = (() => {   // least squares: angle of each early pointing around the Sun line = a0 + w * day
  const E = V(), s = V(), u = V(), v = V(), c = V(); let prev = null, n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; tDay[i] < 3; i++) {
    orbitFrame(tDay[i], E, s, u, v); c.fromArray(tC, 3 * i);
    let a = Math.atan2(c.dot(v), c.dot(u)); if (prev !== null) a += Math.round((prev - a) / TAU) * TAU; prev = a;
    n++; sx += tDay[i]; sy += a; sxx += tDay[i] * tDay[i]; sxy += tDay[i] * a;
  }
  const w = (n * sxy - sx * sy) / (n * sxx - sx * sx); return { w, a0: (sy - w * sx) / n };
})();
console.assert(Math.abs(Math.abs(TAU / PHASE.w) * 1440 - 98) < 6, 'SPHEREx orbit period from the pointings should be near 98 minutes', TAU / PHASE.w * 1440);

// ---------- what is in the first photo, strung along the telescope's line of sight at real distances ----------
// The scale is compressed (a photo's contents span thirteen powers of ten): DEPTH gives [log10 of the distance in AU,
// fraction of the way from the telescope to the photo], straight lines between. The marks along the beam are labelled.
const AU_LY = 63241.08, DEPTH = [[0, .08], [1, .26], [Math.log10(AU_LY), .38], [Math.log10(AU_LY) + 2, .47], [Math.log10(AU_LY) + 4, .66], [Math.log10(AU_LY) + 6, .76], [Math.log10(AU_LY) + 9, .93]];
const depthOf = au => lin(Math.log10(au), DEPTH, 0, 1);
const MARKS = [['1 AU:\nEarth to Sun', 1], ['1 light-year', AU_LY], ['1,000\nlight-years', AU_LY * 1e3], ['1 million\nlight-years', AU_LY * 1e6]]   // \n: where a phone breaks the line
 .map(([text, au]) => ({ text, short: text.replace(/:?\n/, ' ').replace(' Earth to Sun', ''), f: depthOf(au), pos: V() }));
// a gate across the beam at every tenfold step in distance (1 AU to 10,000 AU, then 1 light-year to 100 million): flown through, each one is ten times farther
const GATES = [...[0, 1, 2, 3, 4].map(k => 10 ** k), ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map(k => AU_LY * 10 ** k)].map(au => ({ f: depthOf(au), named: MARKS.some(m => Math.abs(m.f - depthOf(au)) < 1e-9) }));
function odoText(f) {   // the distance from Earth at that point of the beam, to one figure: it ticks over as the flight goes
  const au = 10 ** lin(f, DEPTH, 1, 0), r = x => { const m = 10 ** Math.floor(Math.log10(x)); return Math.round(x / m) * m; }, n = x => r(x).toLocaleString('en-US');
  if (au < AU_LY * .7) return n(au) + ' AU'; const ly = au / AU_LY;
  return ly < 1.5 ? '1 light-year' : ly < 1e6 ? n(ly) + ' light-years' : n(ly / 1e6) + ' million light-years';
}
function ringTex(color) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.strokeStyle = color; g.lineWidth = 5; g.beginPath(); g.arc(32, 32, 24, 0, TAU); g.stroke(); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const ringWhite = ringTex('#fff'), ringAccent = ringTex('#ff9a4d'), coreTex = glowTex([[0, '#fff'], [.25, 'rgba(255,255,255,.9)'], [.6, 'rgba(255,255,255,.2)'], [1, 'rgba(255,255,255,0)']]);
const beads = PH.objects.map((o, i) => {
  const ours = o.kind === 'star' && Math.abs(o.u - PH.star.u) < 1e-3 && Math.abs(o.v - PH.star.v) < 1e-3;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: ours ? ringAccent : ringWhite, transparent: true, depthWrite: false, depthTest: false })); sp.renderOrder = 8; scene.add(sp);
  // a plain mark of what it is, for the flight and the overview: a rock, a star, a galaxy (drawn, not a picture of it)
  const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: o.kind === 'asteroid' ? dotTex : coreTex, color: o.kind === 'asteroid' ? 0xb9ad9c : o.kind === 'galaxy' ? 0xffe9c4 : 0xdfeaff, transparent: true, depthWrite: false, depthTest: false })); core.renderOrder = 7.5; scene.add(core);
  return { ...o, ours, f: depthOf(o.au), sp, core, pos: V(), a: 0, px: 17, tier: i % 2 };
});
const star = beads.find(b => b.ours), starDir = V().copy(c0).addScaledVector(e0, PH.star.u).addScaledVector(f0, PH.star.v).normalize();
const stepAt = T => STEP_T.reduce((a, t) => a + sm((T - t + .35) / .7), 0);   // which of the first four photos is being taken: 0 to 3, sliding from one to the next
// the flight: how far down the beam the camera is (st.fly, 0 at the telescope, 1 at the photo), and how much of the film is flight
const flyA = T => K(T, [[8.5, 0], [FLY0, 1], [FLY1, 1], [FLY1 + .7, 0]]);
const ahead = f => f > st.fly + .003 ? sm((.2 - (f - st.fly)) / .06) : 0;   // in flight a name shows as its thing comes up, and goes as it is passed
const BEAD_GO = 21.4;   // the rings leave the photo, all but the star's

// ---------- one star's spectrum: 102 bars, each a real measurement (photo.json, from live/spectrum.js) ----------
const SP_BANDS = [[.75, 1.11], [1.11, 1.64], [1.64, 2.42], [2.42, 3.82], [3.82, 4.42], [4.42, 5]];   // live/spectral.js
const bars = PH.spectrum.map(([um, flux, doubt, day, det]) => ({ n: (det - 1) * 17 + chanOf(um, SP_BANDS[det - 1]), flux, doubt, day, at: 0 })).sort((a, b) => a.n - b.n);
const STAR_UM = [0, 1, 2, 3].map(k => lamAt(...tileUV(k, starDir)));   // the wavelength the star was seen at in each of the first four photos
const SPEC_MAX = Math.max(...bars.map(b => b.flux));
{ // when each bar appears: the four colors of the first four photos at their own moments, then the rest in the order they were really measured
  const first = STAR_UM.map(um => chanOf(um, BAND)), when = [27.3, ...STEP_T];
  const rest = bars.filter(b => !first.includes(b.n)).sort((a, b) => a.day - b.day);
  bars.forEach(b => { const k = first.indexOf(b.n); b.at = k >= 0 ? when[k] + .3 : 31.6 + 2.9 * rest.indexOf(b) / (rest.length - 1); });
}
const specEl = $('spec'), specG = specEl.getContext('2d'); let specW = 0, specDrawn = -1;
function drawSpectrum(T, x, y) {   // under the star at window (x, y)
  const a = K(T, [[27, 0], [27.5, 1], [X, 1], [X + .5, 0]]) * mainA; specEl.style.opacity = a; if (a <= 0) return;
  const w = Math.round(Math.min(620, W - 36)), h = 118, k = Math.min(2, devicePixelRatio);
  if (specW !== w) { specW = w; specEl.width = w * k; specEl.height = h * k; specEl.style.width = w + 'px'; specEl.style.height = h + 'px'; specDrawn = -1; }
  specEl.style.transform = `translate(${Math.round(x - w / 2)}px,${Math.round(y + (W < H ? 58 : 74))}px)`;
  const key = Math.round(T * 60); if (key === specDrawn) return; specDrawn = key;
  const g = specG, bw = w / 102, base = h - 22, top = 16; let n = 0;
  g.setTransform(k, 0, 0, k, 0, 0); g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,255,255,.3)'; g.fillRect(0, base, w, 1);
  for (const b of bars) {
    const grow = clamp01((T - b.at) / .22); if (grow <= 0) continue; n++;
    const bh = Math.max(2, (base - top) * b.flux / SPEC_MAX) * sm(grow), [r, gr, bl] = rampAt((b.n + .5) / 102), bx = b.n * bw + .6, wd = Math.max(1, bw - 1.2);
    g.fillStyle = g.strokeStyle = `rgb(${r},${gr},${bl})`;
    if (b.doubt) { g.globalAlpha = .38; g.fillRect(bx, base - bh, wd, bh); g.globalAlpha = 1; g.fillRect(bx, base - bh, wd, 1.5); } else g.fillRect(bx, base - bh, wd, bh);   // doubtful: pale, with a cap
    if (grow < 1) { g.globalAlpha = 1 - grow; g.fillStyle = '#fff'; g.fillRect(bx, base - bh, wd, bh); g.globalAlpha = 1; }
  }
  g.font = '10px "Space Mono", monospace'; g.fillStyle = 'rgba(255,255,255,.6)'; g.textBaseline = 'top';
  g.textAlign = 'left'; g.fillText('0.75 microns', 0, base + 7); g.textAlign = 'right'; g.fillText('5 microns', w, base + 7);
  g.textAlign = 'left'; g.fillStyle = 'rgba(255,255,255,.86)'; g.fillText(n === 1 ? '1 color' : n < 102 ? `${n} colors` : '102 colors: the star\u2019s spectrum', 0, 0);
}

// ---------- the push-in: the photo's own pixels around one asteroid (sheba.png and photo.json "zoom": bake/intro_photo.py) ----------
// No resampling: each square is one detector pixel, placed where it sits on the photo, in the photo's own stretch.
const ZM = PH.zoom, sheba = beads.find(b => b.name === ZM.name), ZMID = ZM.corners.reduce((a, q) => [a[0] + q[0] / 4, a[1] + q[1] / 4], [0, 0]);
const pixels = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(12, 3)).setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2)).setIndex([0, 1, 2, 0, 2, 3]), new THREE.ShaderMaterial({
  uniforms: { uPic: { value: zoomTex }, uAlpha: { value: 0 }, uGain: { value: 1.7 }, uN: { value: ZM.n } }, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
  fragmentShader: `uniform sampler2D uPic; uniform float uAlpha, uGain, uN; varying vec2 vUv;
    void main(){ float br = clamp(texture2D(uPic, vUv).r * uGain, 0., 1.); vec2 g = vUv * uN, fg = abs(fract(g - .5) - .5) / fwidth(g);
      vec3 col = br * vec3(.86, .93, 1.1) + vec3(.5, .62, .8) * (1. - min(min(fg.x, fg.y), 1.)) * .13;   // the photo's look, and a faint line between pixels
      gl_FragColor = vec4(col, uAlpha); }`
}));
pixels.frustumCulled = false; pixels.renderOrder = 2.6; scene.add(pixels);
const pushAt = U => K(U, [[SH_U, 0], [SH_U + 2.2, 1], [SH_U + SH - 1.4, 1], [SH_U + SH + .4, 0]]);
const PIX_IN = .8;   // how far in before the photo's own pixels take over from photo.jpg (they fill the view from about there)
let pushK = 0, mainA = 1, deckA = 0;   // how far in the push is; and which of the two scenes is on screen (the other is 0)
function pushIn(P, k) {   // the pose through the telescope (eyePose), pushed in on the asteroid: it stays where it is on screen while everything grows round it
  const S = photoPoint(sheba.u + (ZM.at[0] - sheba.u) * k, sheba.v + (ZM.at[1] - sheba.v) * k), c = ZM.corners.map(q => photoPoint(q[0], q[1])), pix = c[0].distanceTo(c[1]) / ZM.n;
  const fovS = 2 * Math.atan(pix * (wide() ? 34 : 44) / 2 / S.distanceTo(st.top)) / D2R, fov = Math.exp(Math.log(P.fov) * (1 - k) + Math.log(fovS) * k);
  P.tgt.copy(S).lerp(photoPoint(0, 0, tmp), (fov - fovS) / (P.fov - fovS)); P.dir.copy(st.top).sub(P.tgt); P.dist = P.dir.length(); P.dir.normalize(); P.fov = fov;
  const ax = [c[1].clone().sub(c[0]).normalize(), c[3].clone().sub(c[0]).normalize()].flatMap(a => [a, a.clone().negate()]).sort((a, b) => b.dot(P.up) - a.dot(P.up))[0];   // the pixels' own upright
  P.up.lerp(ax, k).normalize();
}

// ---------- the deck of colours: comet 3I/ATLAS and a star, one thin sheet per colour ----------
// Its own small scene: SPHEREx, its beam, and 102 sheets fanned out along it, 0.75 microns nearest the telescope and
// 5 microns farthest. On every sheet each object's glow has an AREA in proportion to its measured brightness in that
// colour: the comet's from data/comets/3i-atlas/comet.json (December 2025, bake/comet_spectrum.py), the star's from
// photo.json (the film's star, scaled by one number so that the two start as bright). Brightness is the measurement, so
// the sheets are only faintly tinted. A reading with a large error bar, or a flagged one, is pale; a colour with no
// reading is an empty dashed sheet. The repo's CO2 band (4.20 to 4.32 microns, the band co2_verdict tests) is outlined
// in orange, and the real photo of the brightest sheet is held up beside the deck.
// Illustrative: each sheet is really its own exposure, taken over about a week; the star is elsewhere in the sky.
const dScene = new THREE.Scene(), dcam = new THREE.PerspectiveCamera(20, 1, .05, 400);
const dlabels = [];
function dlabel(text, cls = '') {   // a deck label: at(world point, [dx, dy, anchor x, anchor y], opacity)
  const el = document.createElement('div'); el.className = 'lbl deck ' + cls; el.textContent = text; el.style.opacity = 0; $('labels').append(el);
  const L = { el, o: 0, at(q, [dx, dy, ax, ay] = [10, -5, 0, 0], a = 1) {
    tmp.copy(q).project(dcam); const o = tmp.z < 1 ? +(a * deckA).toFixed(3) : 0; if (o !== L.o) el.style.opacity = L.o = o; if (o <= .01) return;
    el.style.transform = `translate(${((tmp.x + 1) / 2 * W + dx).toFixed(1)}px,${((1 - tmp.y) / 2 * H + dy).toFixed(1)}px) translate(${ax * 100}%,${ay * 100}%)`;
  } };
  dlabels.push(L); return L;
}
const deckFrame = (() => {
  const N = 102, X0 = 2.8, hs = 1.5, CR = .5, STAR = [-.45, .6], FOV = 20;
  const posOf = um => { let k = SP_BANDS.findIndex(b => um < b[1]); if (k < 0) k = 5; return Math.max(0, Math.min(101.99, 17 * k + 17 * Math.log(um / SP_BANDS[k][0]) / Math.log(SP_BANDS[k][1] / SP_BANDS[k][0]))); };
  const sheets = Array.from({ length: N }, (_, n) => ({ n, c: [], s: null, col: rampAt((n + .5) / N).map(v => .7 + .3 * v / 255) }));   // mostly white
  for (const q of CM.spectrum['2025-12']) sheets[Math.floor(posOf(q.lam))].c.push(q);
  for (const [um, flux, doubt] of PH.spectrum) sheets[Math.floor(posOf(um))].s = { flux, doubt };
  for (const sh of sheets) if (sh.c.length) { sh.flux = sh.c.reduce((a, q) => a + q.flux, 0) / sh.c.length; sh.rel = Math.min(1, sh.c.reduce((a, q) => a + q.err, 0) / sh.c.length / Math.max(sh.flux, 1e-3)); }
  const lit0 = sheets.find(sh => sh.flux && sh.s), KS = lit0.flux / lit0.s.flux;   // the star, scaled to start as bright as the comet
  const FMAX = Math.max(...sheets.map(sh => sh.flux ?? 0)), rad = f => .46 * hs * Math.sqrt(Math.max(f, 0) / FMAX);   // area in proportion to brightness
  const co2 = sheets.filter(sh => sh.c.some(q => q.lam >= 4.20 && q.lam <= 4.32)), hot = new Set(co2.map(sh => sh.n)), best = sheets.reduce((a, sh) => (sh.flux ?? 0) > (a.flux ?? 0) ? sh : a), measured = sheets.filter(sh => sh.flux).length;
  const shot = CM.photos.reduce((a, q) => q.flux > a.flux ? q : a), when = new Date((shot.mjd - 40587) * 864e5);   // the brightest sheet's own photo
  console.assert(hot.has(best.n) && Math.floor(posOf(shot.lam)) === best.n, 'the photo held up should be the brightest sheet, in the CO2 band');
  const glow = glowTex([[0, '#fff'], [.18, 'rgba(255,255,255,.95)'], [.42, 'rgba(255,255,255,.32)'], [.7, 'rgba(255,255,255,.07)'], [1, 'rgba(255,255,255,0)']]), plane = new THREE.PlaneGeometry(2, 2);
  const flat = (map, order, add = true) => { const m = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending })); m.rotation.y = -Math.PI / 2; m.renderOrder = order; m.frustumCulled = false; dScene.add(m); return m; };
  const spr = (map, order) => { const m = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, depthTest: false })); m.renderOrder = order; dScene.add(m); return m; };
  for (const sh of sheets) {
    sh.fill = flat(null, 3); sh.fill.material.color.setRGB(.8, .88, 1); sh.fill.scale.setScalar(hs);
    if (sh.flux) { sh.cg = flat(glow, 6); sh.cg.material.color.setRGB(...sh.col); }
    if (sh.s) { sh.sg = flat(glow, 6); sh.sg.material.color.setRGB(...sh.col); }
  }
  const card = flat(cometTex, 10, false), cardRing = spr(ringAccent, 11), ask = [spr(ringWhite, 9), spr(ringWhite, 9)];
  const dcraft = makeCraft(); dcraft.scale.setScalar(CR); dcraft.rotation.z = -Math.PI / 2; dcraft.position.set(-CR, 0, 0); dScene.add(dcraft);   // its mouth at the origin, looking along +x
  const dsun = new THREE.DirectionalLight(0xfff4e2, 3); dsun.position.set(-2, 5, 8); dScene.add(dsun, new THREE.HemisphereLight(0x8fb4ff, 0x0a1020, .6));
  const beam = beamBody(dScene), lines = dynLines(2600, dScene, 7), over = dynLines(40, dScene, 12), top = V(); beam.material.opacity = .05;
  const P = (x, u, v) => V(x, v * hs, u * hs), corners = x => [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([u, v]) => P(x, u, v));
  beam.put(top, corners(X0));

  const lCraft = dlabel('SPHEREx'), lCount = dlabel('', 'big'), lNear = dlabel('0.75 microns', 'mark'), lFar = dlabel('5', 'mark'), ticks = [1, 2, 3, 4].map(um => ({ um, lab: dlabel(String(um), 'mark') }));
  const lCo2 = dlabel('CO2 gas glows here\n4.26 microns', 'accent co2'), lCard = dlabel('', 'mark'), lAgree = dlabel(`${co2.length} sheets agree`, 'mark');
  const lOne = dlabel('one photo, one color'), lAsk = [dlabel('?', 'ask'), dlabel('?', 'ask')];
  const pad = n => String(n).padStart(2, '0'), shotDay = `${when.getUTCDate()} Dec`, shotTime = `${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}`;
  console.assert(when.getUTCMonth() === 11, 'the photo held up should be from December');

  const proj = q => { tmp.copy(q).project(dcam); return [(tmp.x + 1) / 2 * W, (1 - tmp.y) / 2 * H]; };
  function aim(pos, tgt, up) { dcam.fov = FOV; dcam.aspect = W / H; dcam.position.copy(pos); dcam.up.copy(up); dcam.lookAt(tgt); dcam.updateProjectionMatrix(); dcam.updateMatrixWorld(); }
  function fit(pts, dir, up, [x0, y0, x1, y1]) {   // look along -dir with these points filling that rectangle of the window (CSS px)
    const tgt = pts.reduce((a, q) => a.add(q), V()).divideScalar(pts.length); let dist = 30;
    for (let k = 0; k < 14; k++) {
      aim(tmp2.copy(tgt).addScaledVector(dir, dist), tgt, up);
      let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const q of pts) { const [x, y] = proj(q); a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
      const px = dist * Math.tan(FOV / 2 * D2R) * 2 / H;
      tgt.addScaledVector(tmp3.setFromMatrixColumn(dcam.matrixWorld, 0), ((a + c) / 2 - (x0 + x1) / 2) * px).addScaledVector(tmp3.setFromMatrixColumn(dcam.matrixWorld, 1), -((b + d) / 2 - (y0 + y1) / 2) * px);
      dist *= Math.max((c - a) / (x1 - x0), (d - b) / (y1 - y0));
    }
    aim(tmp2.copy(tgt).addScaledVector(dir, dist), tgt, up);
  }
  return function frame(d) {   // d: the deck's own seconds
    const tall = !wide(), DX = tall ? .075 : .105, CARD = tall ? 1.15 : 1.5, xEnd = X0 + (N - 1) * DX;   // on a phone the deck stands up, the telescope at the bottom
    const s = sm((d - DQ) / D_FAN), la = sm((d - DQ - D_FAN + .5) / .7), lit = sm((d - D_LIT) / .9), pop = sm((d - D_POP) / 1.3), kc = sm((d - D_POP + 1.4) / 1.6), qa = sm(d / .6), named = lit > .5, throb = 1 + .12 * Math.sin((d - D_LIT) * 5.5) * lit * (1 - sm((d - D_LIT - 2.6) / .8));
    const tilt = .82 - .06 * Math.min(1, d / DQ) - (tall ? .1 : .28) * sm((d - DQ + .6) / 4) + .12 * sm((d - D_LIT) / (DK - D_LIT)), el = .1;   // the first sheet seen clear of the telescope for the question, drifting; then round to the side as the deck grows
    const dir = V(-Math.sin(tilt) * Math.cos(el), Math.sin(el), Math.cos(tilt) * Math.cos(el)), up0 = tall ? V(1, 0, 0) : Y;
    const right = V().crossVectors(up0, dir).normalize(), up = V().crossVectors(dir, right);   // the camera's own right and up
    const xNow = X0 + (N - 1) * DX * s, Xn = n => X0 + n * DX * s;
    const cHome = tall ? V(X0 + best.n * DX, 0, 0).addScaledVector(right, hs + CARD + .45) : V(xEnd + (CARD + 1.25) * Math.cos(tilt), 0, (CARD + 1.25) * Math.sin(tilt));   // where the photo is held up
    const key = [V(-1.3 * CR, CR, 0), V(-1.3 * CR, -CR, 0), ...corners(X0), ...corners(xNow), ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => V(xNow, 0, 0).lerp(cHome.clone().addScaledVector(right, a * CARD).addScaledVector(up, b * CARD), kc))];
    fit(key, dir, up0, tall ? [58, 84, W - 14, H - 262] : [58, 150, W - 58, H - 214]);
    const pxAt = q => tmp.copy(dcam.position).sub(q).dot(dir) * Math.tan(FOV / 2 * D2R) * 2 / H;   // world size of one CSS pixel there
    const out = tall ? right : up, ve = tall ? -1 : 1;   // labels stand off the deck's upper edge (on a phone, its right edge); the scale runs along the opposite one
    const mixc = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    lines.begin(); over.begin();
    for (const c of corners(X0)) lines.seg(top, c, WHITE, .3, .6);
    lines.seg(top, P(Xn(N - 1), 0, 0), mixc(WHITE, ACCENT, lit), .15, .4 * s);   // the comet's line of sight, through every sheet
    lines.seg(P(X0, ...STAR), P(Xn(N - 1), ...STAR), WHITE, .22 * s);            // and the star's
    for (const sh of sheets) {
      const x = Xn(sh.n), a = sh.n ? sm(s * 2.5) : 1, h = hot.has(sh.n), k = h ? 1 : 1 - .45 * lit, cs = corners(x);
      sh.fill.position.set(x, 0, 0); sh.fill.material.opacity = Math.max(a * (h ? .035 + .03 * lit : .03) * (sh.cg ? 1 : .3) * (tall ? .4 : .6) * (.12 + .88 * s * s), sh.n ? 0 : .05 * (1 - s));   // closed up, the sheets overlap: each one fainter
      const ec = h ? mixc(sh.col, ACCENT, lit) : sh.col;
      if (sh.cg || !sh.n) cs.forEach((c, i) => lines.seg(c, cs[(i + 1) % 4], sh.n ? ec : WHITE, a * (sh.n ? (h ? .5 + .5 * lit : .34 * k) : 1 - .55 * s)));
      else cs.forEach((c, i) => lines.dash(c, cs[(i + 1) % 4], sh.col, a * .3 * k));   // no reading: an empty dashed sheet
      let show = a * (.03 + (tall ? .24 : .4) * s * s); if (!sh.n) show = .95 + (show - .95) * sm(s * 2.5);   // before the fan, the first sheet alone: two dots
      if (sh.cg) { sh.cg.position.set(x + .001, 0, 0); sh.cg.scale.setScalar(Math.max(rad(sh.flux) * 1.7, .03) * (h ? throb : 1)); sh.cg.material.opacity = show / (1 + 5 * sh.rel) * (h ? 1 + .5 * lit : 1 - .25 * lit); }
      if (sh.sg) { sh.sg.position.copy(P(x + .001, ...STAR)); sh.sg.scale.setScalar(Math.max(rad(KS * sh.s.flux) * 1.7, .03)); sh.sg.material.opacity = show * (sh.s.doubt ? .4 : 1) * (1 - .25 * lit); }
    }
    // the question: which of the two dots is the comet?
    [[0, 0], STAR].forEach((uv, i) => {   // the question marks turn into the answer, where they stand
      const q = P(X0, ...uv), k = pxAt(q), said = named ? (i ? 'star' : 'comet 3I/ATLAS') : '?', el = lAsk[i].el;
      ask[i].position.copy(q); ask[i].scale.setScalar(k * 56); ask[i].material.map = named && !i ? ringAccent : ringWhite; ask[i].material.opacity = qa;
      if (el.textContent !== said) { el.textContent = said; el.className = 'lbl deck ' + (named ? 'big' + (i ? '' : ' accent') : 'ask'); }
      lAsk[i].at(q.addScaledVector(up, 32 * k), [0, 0, -.5, -1], qa * Math.abs(2 * lit - 1));
    });
    lOne.at(P(X0, 0, -1).addScaledVector(up, -8 * pxAt(P(X0, 0, -1))), [0, 6, -.5, 0], tall ? 0 : sm(d / .6) * (1 - sm(s * 14)));
    // the scale, in microns
    const edge = n => P(Xn(n), tall ? 0 : 1, -ve),   // on a phone, level with the comet in the middle of each sheet
     tAt = tall ? [-5, 0, -1, -.5] : [0, 4, -.5, 0];
    for (const t of ticks) { const q = edge(posOf(t.um)), k = pxAt(q); lines.seg(q.clone().addScaledVector(out, -3 * k), q.addScaledVector(out, -9 * k), WHITE, .6 * la); t.lab.at(q, tAt, la); }
    lNear.at(edge(0).addScaledVector(out, -9 * pxAt(edge(0))), tAt, la); lFar.at(edge(N - 1).addScaledVector(out, -9 * pxAt(edge(N - 1))), tAt, la * (tall ? 1 : 1 - pop));
    { const a = P(Xn(co2[0].n - .5), 1, ve), b = P(Xn(co2.at(-1).n + .5), 1, ve), k = pxAt(a), dd = out.clone().multiplyScalar(12 * k), a1 = a.clone().add(dd), b1 = b.clone().add(dd);   // the CO2 band, bracketed
      for (const [p0, p1] of [[a.clone().addScaledVector(out, 3 * k), a1], [b.clone().addScaledVector(out, 3 * k), b1], [a1, b1]]) lines.seg(p0, p1, ACCENT, .9 * lit);
      lAgree.at(a1.lerp(b1, .5), [0, -5, -.5, -1], tall ? 0 : lit); }
    // the real photo of the brightest sheet: out of the deck, turned to face the viewer
    const xc = Xn(best.n), cc = V(xc, 0, 0).lerp(cHome, pop), half = hs + (CARD - hs) * pop;
    card.visible = pop > 0; card.position.copy(cc); card.scale.setScalar(half); card.quaternion.setFromEuler(new THREE.Euler(0, -Math.PI / 2, 0)).slerp(dcam.quaternion, pop); card.material.opacity = sm(pop * 3);
    card.material.color.setRGB(1.5, 1.3, 1.1); cardRing.material.opacity = 0;
    if (pop > 0) {
      const cr = V(1, 0, 0).applyQuaternion(card.quaternion), cu = V(0, 1, 0).applyQuaternion(card.quaternion), cq = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([u, v]) => cc.clone().addScaledVector(cr, u * half).addScaledVector(cu, v * half));
      cq.forEach((c, i) => over.seg(c, cq[(i + 1) % 4], WHITE, pop));
      (tall ? [[P(xc, -1, -1), cq[1]], [P(xc, 1, -1), cq[2]]] : [[P(xc, 1, 1), cq[1]], [P(xc, 1, -1), cq[2]]]).forEach(([a, b]) => over.seg(a, b, ACCENT, .8 * pop, .45 * pop));   // from its own sheet
      cardRing.position.copy(cc); cardRing.scale.setScalar(half * .62); cardRing.material.opacity = sm((pop - .7) / .3);
      lCo2.at(cc.clone().addScaledVector(up, half), [0, -8, -.5, -1], sm((pop - .6) / .4));
      lCard.el.textContent = tall ? `its real photo\n${shotDay}, ${shotTime}` : `its real photo · ${shotDay}, ${shotTime}`;
      lCard.at(cc.clone().addScaledVector(up, -half), [0, 8, -.5, 0], sm((pop - .75) / .25));
    } else { lCo2.at(cc, undefined, 0); lCard.at(cc, undefined, 0); }

    lCraft.at(tall ? V(-CR, 0, 0).addScaledVector(right, CR) : V(-CR * .6, -CR, 0), tall ? [8, 0, 0, -.5] : [0, 10, -.5, 0], sm(d / .6));
    const shown = Math.min(measured, Math.round(1 + (measured - 1) * s));
    lCount.el.textContent = s < 1 ? `${shown} colors` : tall ? `${measured} of 102\nmeasured` : `${measured} of 102 measured`;
    if (tall) lCount.at(P(X0, 1, 1).addScaledVector(right, -14 * pxAt(P(X0, 1, 1))), [-8, 0, -1, -.5], sm((s - .07) * 10) * (1 - la)); else lCount.at(P(X0, -1, 1), [0, -12, -1, -1], sm((s - .07) * 10));
    lNear.el.textContent = tall ? '0.75\nmicrons' : '0.75 microns';
    frame.info = { co2: proj(P(Xn(best.n), 0, 0)), scan: [proj(P(X0, 1, .5)), proj(P(Xn(N - 1), 1, .5))], measured, dashed: N - measured, co2n: co2.length, fanned: s };   // for the checks
    lines.end(); over.end();
  };
})();

// ---------- labels ----------
// A label sits to the right of its point unless `at` says otherwise: [dx, dy] in pixels, then how much of its own
// width and height to shift by (-.5, -1 = centred above), then true for a short line down to the point.
const labels = [];
function label(text, pos, alpha, cls = '', at = null) { const el = document.createElement('div'); el.className = 'lbl ' + cls; $('labels').append(el); labels.push({ el, pos, alpha, at, o: -1, lead: false, text: typeof text === 'function' ? text : () => text, said: null }); }
const sysA = T => K(w(T), [[30, 1], [31.4, 0]]);   // the solar system fades before the sphere unfolds
const wide = () => W > H;
const sideA = T => K(T, [[FLY1 + .6, 0], [OVER, 1], [16.4, 1], [17.4, 0]]);   // while the beam is seen from the side
label('Sun', o => o.set(0, 0, 0), T => K(w(T), [[11.6, 0], [12.6, 1]]) * sysA(T));
label('Earth', o => o.copy(st.E), T => Math.max(sideA(T), K(w(T), [[6.8, 0], [7.8, 1]]) * sysA(T)), '', () => T_now < X ? [0, EARTH_R / st.px + 8, -.5, 0] : null);
label('SPHEREx', o => o.copy(st.p), T => Math.max(K(T, [[.8, 0], [1.6, 1], [4.9, 1], [5.7, 0]]), sideA(T)), '', () => T_now > 8 ? (wide() ? [0, 44, -.5, 0] : [-16, 0, -1, -.5]) : null);
label('to the Sun', o => o.copy(st.E).addScaledVector(st.s, st.R * 1.25), T => K(w(T), [[7.4, 0], [8.4, 1], [10.6, 1], [11.6, 0]]));
label('90°', o => o.copy(st.E).addScaledVector(st.s, st.R * .34).addScaledVector(st.u, st.R * .34), T => K(w(T), [[8.4, 0], [9.2, 1], [17.4, 1], [18.6, 0]]));
// the close look: the photo, what is in it, the marks of the distance scale, then the filter's colours
label('the photo', o => photoPoint(0, 0, o).addScaledVector(wide() ? st.sideUp : st.sideRight, (wide() ? -1.5 : 1.5) * HALF * st.R), sideA, '', () => wide() ? [0, 6, -.5, 0] : [6, 0, 0, -.5]);
for (const b of beads) label(`${b.ours ? 'star' : b.name} · ${b.dist}`, o => o.copy(b.pos), T => { const fa = flyA(T); return b.a * K(T, [[16.4, 1], [17.4, 0]]) * (1 + (ahead(b.f) - 1) * fa); }, b.ours ? 'accent' : '',
  () => flyA(T_now) > .5 ? (wide() ? [b.px * .42 + 8, 0, 0, -.5] : [0, b.px * .42 + 8, -.5, 0]) : wide() ? [0, -(b.f * HALF * st.R * 1.15 / st.px) - (b.tier ? 32 : 9), -.5, -1, !!b.tier] : [14, 0, 0, -.5]);   // clear of the beam's upper edge, on two rows
for (const m of MARKS) label(m.short, o => o.copy(st.top).lerp(photoPoint(0, -1, tmp2), m.f), T => flyA(T) * ahead(m.f), 'mark', () => [0, -7, -.5, -1]);   // in flight: over its gate
for (const m of MARKS) label(() => wide() ? m.text.replace('\n', ' ') : m.text, o => o.copy(m.pos), sideA, 'mark', () => wide() ? [0, 5, -.5, 0] : [-8, 0, -1, -.5]);
label(T => T < 26.9 ? 'one star' : `one star · ${STAR_UM[Math.round(stepAt(T))].toFixed(2)} microns`, o => o.copy(star.pos), T => K(T, [[21.6, 0], [22.4, 1], [X, 1], [X + .6, 0]]), 'accent', () => [13, -13, 0, -1]);
const stripeA = T => K(T, [[23.2, 0], [23.8, 1], [25.8, 1], [26.4, 0]]);
label(`about ${BAND[0]} microns`, o => photoPoint(-1, 1, o), stripeA, '', () => [0, 8, 0, 0]);
label(`about ${BAND[1]} microns`, o => photoPoint(1, 1, o), stripeA, '', () => [0, 8, -1, 0]);
label('helium glow', o => photoPoint(PH.lam.bright_band_u, -1, o), stripeA, '', () => [0, -8, -.5, -1]);
label(`${ZM.name} · one pixel`, o => o.copy(sheba.pos), () => sm((pushK - .85) / .15), '', () => [0, wide() ? 50 : 44, -.5, 0]);
let T_now = 0;
function placeLabels(T) {
  for (const L of labels) {
    const a = L.alpha(T) * mainA; let vis = a > .01 && L.pos(tmp);
    if (vis) { tmp.project(camera); vis = tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05; }
    const o = vis ? +a.toFixed(3) : 0; if (o !== L.o) L.el.style.opacity = L.o = o;
    if (!vis) continue;
    const said = L.text(T); if (said !== L.said) L.el.textContent = L.said = said;
    const [dx, dy, ax, ay, lead] = L.at?.() ?? [10, -5, 0, 0];
    if (!!lead !== L.lead) L.el.classList.toggle('lead', L.lead = !!lead);
    L.el.style.transform = `translate(${((tmp.x + 1) / 2 * W + dx).toFixed(1)}px,${((1 - tmp.y) / 2 * H + dy).toFixed(1)}px) translate(${ax * 100}%,${ay * 100}%)`;
  }
}
function tileCorner(i, a, b, o) { const c = tmp2.fromArray(tC, 3 * i), e = tmp3.fromArray(tE, 3 * i); return o.crossVectors(c, e).multiplyScalar(b).addScaledVector(e, a).add(c).multiplyScalar(st.R).add(st.E); }

// ---------- camera: a list of shots; between two shots the pose is blended ----------
const fitDist = r => r / Math.sin(Math.min(VFOV / 2 * .8 * Math.PI / 180, Math.atan(Math.tan(VFOV / 2 * Math.PI / 180) * W / H)));
const pose = (tgt, dir, dist, up, shift = .06, fov = VFOV) => ({ tgt: tgt.clone(), dir: dir.clone().normalize(), dist, up: up.clone(), shift, fov });
const MID = earthAt(95, V()).normalize();   // where Earth is half way through the sweep
const D2R = Math.PI / 180, tanV = () => Math.tan(VFOV / 2 * D2R);
// the lens that makes something `half` wide (each side of the middle), `dist` away, fill this share of the window's height and width at most
const fovFill = (half, dist, fh, fw) => 2 * Math.atan(Math.max(half / (dist * fh), half * H / (dist * fw * W))) / D2R;
const upPhoto = f0.clone().negate().normalize();   // with this up, the photo's u runs to the right: short wavelengths on the left
// through the telescope: from the top of SPHEREx, a long lens on the photo. Every line of sight is a point from here.
function eyePose() { const C = photoPoint(0, 0), d = st.top.clone().sub(C), L = d.length(); return pose(C, d, L, upPhoto, wide() ? .07 : .15, fovFill(HALF * st.R, L, .62, .9)); }
// The flight: from the telescope's mouth straight down the beam towards the photo, with a wide lens, so that what is in the
// photo comes past one thing at a time in order of distance. It ends where the photo fills most of the view.
const flyFov = () => wide() ? 55 : 80;
function flyAt(T) { const th = Math.tan(flyFov() / 2 * D2R), L = photoPoint(0, 0, tmp).distanceTo(st.top); return (1 - HALF * st.R / Math.min(th * .8, th * W / H * .9) / L) * sm((T - FLY0) / (FLY1 - FLY0)); }
function flyPose() { const C = photoPoint(0, 0), d = st.top.clone().sub(C); return pose(C, d, d.length() * (1 - st.fly), upPhoto, wide() ? .07 : .15, flyFov()); }
// the beam from the side: the telescope on the left and the photo on the right (on a phone, bottom and top), Earth kept out of its way
function sidePose(T) {
  const C = photoPoint(0, 0), ax = C.clone().sub(st.top), L = ax.length(); ax.divideScalar(L);
  const dE = st.E.clone().sub(st.top); dE.addScaledVector(ax, -dE.dot(ax)).normalize();   // from the beam towards Earth
  const away = [e0, f0].flatMap(a => [a.clone(), a.clone().negate()]).sort((a, b) => a.dot(dE) / a.length() - b.dot(dE) / b.length())[0];   // the side of the photo that faces away from Earth
  away.addScaledVector(ax, -away.dot(ax)).normalize();   // with this as "up" the photo is seen square on, not as a diamond
  const up = wide() ? away : ax, right = wide() ? ax : away, back = V().crossVectors(right, up), tilt = (wide() ? .45 : .4) + .02 * (T - 13), fov = wide() ? 14 : 18, tf = Math.tan(fov / 2 * D2R);   // a long lens, so the far end is not squeezed
  const dir = back.multiplyScalar(Math.cos(tilt)).addScaledVector(ax, -Math.sin(tilt));   // a little from behind the telescope, so the photo shows its face
  st.sideUp.copy(up); st.sideRight.copy(right);
  const dist = wide() ? L * Math.cos(tilt) / (1.5 * tf * W / H) : L * Math.cos(tilt) / (.94 * tf);
  const tgt = st.top.clone().addScaledVector(ax, L * (wide() ? .47 : .5)); if (!wide()) tgt.addScaledVector(right, 54 * dist * 2 * tf / H);   // on a phone the beam stands left of the middle: its labels are on its right
  return pose(tgt, dir, dist, up, wide() ? .1 : .19, fov);
}
// the star, seen from the middle of Earth with a very long lens: every photo of it is then exactly where it was on the sky
function starPose() { const S = photoPoint(PH.star.u, PH.star.v), d = st.E.clone().sub(S), L = d.length(); return pose(S, d, L, upPhoto, wide() ? .1 : .16, wide() ? 1.15 : 1.7); }
// the way out of the close look: straight back along the photo's line of sight, to over Earth's shoulder. The photo stays
// in the middle and Earth comes into view under it; only then does the film swing round to see the ring.
function backPose() { const ax = photoPoint(0, 0).sub(st.E).normalize(); return pose(st.E.clone().addScaledVector(ax, st.R * .56), ax.clone().negate().addScaledVector(upPhoto, .3), fitDist(st.R * .62), upPhoto, .22); }
function rectPose(r) {   // look straight at the flat map so it lands exactly on a screen rectangle (CSS px)
  const ppu = r.w / (4 * R2 * st.R), dist = H / (2 * Math.tan(VFOV / 2 * Math.PI / 180) * ppu);
  const tgt = st.E.clone().addScaledVector(F, st.R).addScaledVector(RT, -(r.x + r.w / 2 - W / 2) / ppu).addScaledVector(N, (r.y + r.h / 2 - H / 2) / ppu);
  return pose(tgt, F.clone().negate(), dist, N, 0);
}
// The landing: the real map as it is on screen now (any pan and zoom), so the flat sky ends exactly on it.
// c is the oval's centre, ex and ey run from there to its right and top edges, in window pixels. Zoomed far in, Explore
// straightens the map (explore-view.js: a turn and a stretch); `skew` is that same change, given to the camera.
const mapEl = document.getElementById('map');
function landPose() {
  let c, ex, ey;
  if (straight()) { c = win(.5, .5); const r = win(1, .5), t = win(.5, 0); ex = [r[0] - c[0], r[1] - c[1]]; ey = [t[0] - c[0], t[1] - c[1]]; }
  else { const b = mapEl.getBoundingClientRect(); c = [b.left + b.width / 2, b.top + b.height / 2]; ex = [b.width / 2, 0]; ey = [0, -b.height / 2]; }
  const a = Math.hypot(ex[0], ex[1]), P = rectPose({ x: c[0] - a, y: c[1] - a / 2, w: 2 * a, h: a });
  if (straight()) P.skew = [ex[0] / a, -2 * ey[0] / a, ex[1] / a, -2 * ey[1] / a, c[0], c[1]];
  return P;
}
function ovalRect() { const w = Math.min(W * .92, H * .56 * 2); return { x: (W - w) / 2, y: H * .42 - w / 4, w, h: w / 2 }; }
const SHOTS = [   // a and b in film seconds; the shots after X are the first cut's, and are given that cut's seconds (t)
  { a: 0, b: 4.5, f: T => pose(tmp.copy(st.E).addScaledVector(st.r, .074), tmp2.copy(st.s).multiplyScalar(K(T, [[0, .7], [5, .5]])).addScaledVector(st.t, .68).addScaledVector(st.r, -.1), fitDist(W > H ? .05 : .062), W > H ? tmp3.copy(st.r).multiplyScalar(.3).addScaledVector(tmp4.crossVectors(tmp2, st.r).normalize(), -.95) : st.r, W > H ? .09 : .225) },   // on a phone, high enough that the orbit line clears the caption's rule
  { a: 6.9, b: 8.4, f: eyePose },
  { a: FLY0, b: FLY1, f: flyPose },
  { a: OVER, b: 16.2, f: sidePose },
  { a: 18.4, b: 25.8, f: eyePose },
  { a: 27.6, b: X, f: starPose },
  { a: BACK_T - .1, b: BACK_T + .2, f: eyePose },   // the film cuts back from the deck to here (T jumps from DK_T to BACK_T)
  { a: BACK_T + 1.4, b: BACK_T + 1.6, f: backPose },
  { a: X + 3.6, b: wi(10.4), f: (T, t) => pose(st.E, tmp2.copy(st.s).multiplyScalar(.78).addScaledVector(Y, .42).addScaledVector(tmp3.crossVectors(st.s, Y), .46 + .03 * (t - 8)), fitDist(.38), Y) },
  { a: wi(12.7), b: wi(18.3), f: () => { const el = (W < H ? 60 : 40) * Math.PI / 180; return pose(tmp.copy(st.E).multiplyScalar(.6), tmp2.copy(MID).multiplyScalar(Math.cos(el)).addScaledVector(Y, Math.sin(el)), fitDist(1.1), Y); } },
  { a: wi(21.8), b: wi(29.6), f: (T, t) => { const az = K(t, [[21, -1.08], [30.4, -.34]]), el = K(t, [[21, .44], [30.4, .2]]);
    return pose(st.E, tmp2.set(-Math.cos(el) * Math.cos(az), Math.sin(el), -Math.cos(el) * Math.sin(az)), fitDist(R_BIG * 1.1), Y); } },
  { a: wi(31.2), b: wi(31.4), f: () => pose(st.E, tmp2.copy(F).negate(), fitDist(R_BIG * 1.1), N) },
  { a: wi(33.7), b: wi(36.1), f: () => rectPose(ovalRect()) },
  { a: wi(37.6), b: 999, f: () => landPose() },
];
function poseAt(T) {
  let i = 0; while (i < SHOTS.length - 1 && T >= SHOTS[i + 1].a) i++;
  const t = w(T), A = SHOTS[i].f(T, t); if (T <= SHOTS[i].b || i === SHOTS.length - 1) return A;
  const B = SHOTS[i + 1].f(T, t), k = sm((T - SHOTS[i].b) / (SHOTS[i + 1].a - SHOTS[i].b)), mix = (a, b) => Math.exp(Math.log(a) * (1 - k) + Math.log(b) * k);
  return { tgt: A.tgt.lerp(B.tgt, k), dir: A.dir.lerp(B.dir, k).normalize(), dist: mix(A.dist, B.dist), up: A.up.lerp(B.up, k).normalize(), shift: A.shift + (B.shift - A.shift) * k, fov: mix(A.fov, B.fov),
    skew: B.skew?.map((v, j) => (j < 4 ? (j % 3 ? 0 : 1) * (1 - k) + v * k : v)) };
}

// ---------- one frame ----------
const capText = $('cap-text'), capNote = $('cap-note'), ticks = [...$('cap-ticks').children];
const hDate = $('h-date').appendChild(new Text('')), hCount = $('h-count').appendChild(new Text(''));   // text nodes: ui.js watches the page for added elements, and these change every frame
let capShown = -1, odoShown = -1;
const odoEl = $('odo'), odoNum = odoEl.firstChild.appendChild(new Text(''));
const fmtDate = d => new Date((S.mjd0 + d - 40587) * 864e5).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
let deckOn = false, cutShown = -1;
function render(U) {
  const T = v2(U), inDeck = U >= DK_U + DIP && U < DK_END - DIP, cut = Math.min(1, Math.abs(U - DK_U - DIP) / DIP, Math.abs(U - DK_END + DIP) / DIP);   // each cut dips to black
  mainA = inDeck ? 0 : cut; deckA = inDeck ? cut : 0; pushK = pushAt(U);
  if (cut !== cutShown) canvas.style.opacity = cutShown = cut;
  const t = w(T), day = st.day = dayAt(T), speed = (dayAt(T + .05) - dayAt(T - .05)) / .1, R = st.R = shellR(T), close = T < X;   // t: the first cut's seconds
  const { E, s, u, v, p, r, top } = st; T_now = T;
  orbitFrame(day, E, s, u, v);
  const al = PHASE.a0 + PHASE.w * day; r.copy(u).multiplyScalar(Math.cos(al)).addScaledVector(v, Math.sin(al));
  st.t.copy(u).multiplyScalar(-Math.sin(al)).addScaledVector(v, Math.cos(al)).multiplyScalar(Math.sign(PHASE.w)); p.copy(E).addScaledVector(r, ORBIT_R);
  const idx = st.idx = tileIndex(day), sys = sysA(T);

  // tiles
  tileGeo.instanceCount = idx; tileU.uCenter.value.copy(E); tileU.uR.value = R * .985;   // a hair inside the joined-up sky, so it never hides them
  tileU.uNow.value = day;
  tileU.uFresh.value = Math.max(.0009, .13 * speed);
  tileU.uFill.value = K(t, [[18.2, 1], [19.6, 0]]); tileU.uFront.value = K(t, [[7.5, 0], [9.3, .85], [12.6, 0]]); tileU.uSeam.value = K(t, [[6, .4], [10, .1], [12.5, 0]]);   // on the way out of the close look the camera passes the near side of the ring: outlines only there
  tileU.uAlpha.value = sys * (T < 5.9 ? 1 : K(T, [[5.9, 1], [6.4, 0], [BACK_T + .5, 0], [BACK_T + 1.4, 1]])); tiles.visible = tileU.uAlpha.value > 0;   // not under the real photo: up close the all-sky picture is a blur
  uLift.value = K(t, [[19, 1], [21.5, 0]]);

  // the first photo on its tile; the stripes are the filter of the photo being taken now (the first, then the three steps)
  const pa = photoU.uAlpha.value = K(T, [[4.9, 0], [5.9, 1], [BACK_T + 1.6, 1], [BACK_T + 2.8, 0]]); photo.visible = pa > 0;   // the real photo stays on its tile until the ring is in view
  if (photo.visible) {
    const kf = T < BACK_T ? stepAt(T) : 0, k = Math.min(2, Math.floor(kf)); photoU.uCenter.value.copy(E); photoU.uR.value = R * PHOTO_R;   // between photos the square slides to its next place; back from the deck, the white edge is the first photo's own again
    photoU.uCk.value.fromArray(tC, 3 * k).lerp(tmp.fromArray(tC, 3 * k + 3), kf - k); photoU.uEk.value.fromArray(tE, 3 * k).lerp(tmp.fromArray(tE, 3 * k + 3), kf - k);
    photoU.uStripe.value = K(T, [[21.6, 0], [21.7, 1], [X - .2, 1], [X + .5, 0]]); photoU.uSweep.value = K(T, [[21.7, -1.1], [23.4, 1.2]]);
    photoU.uEdge.value = K(T, [[4.9, 0], [5.9, .8], [BACK_T + 1.6, .8], [BACK_T + 2.8, 0]]);
  }

  // the joined-up sky, and its unfolding
  const unroll = K(t, [[31.4, 0], [35.3, 1]]);
  shellU.uCenter.value.copy(E); shellU.uR.value = R; shellU.uT.value = unroll;
  shellU.uAlpha.value = K(t, [[17.6, 0], [19.2, 1]]); shellU.uGrid.value = K(t, [[19.5, 0], [22, .13], [35.5, .13], [37.5, .05]]); shellU.uEcl.value = K(t, [[21, 0], [23, .55], [35.5, .55], [37.5, .75]]);
  glassU.uGrid.value = K(t, [[19.5, 0], [22, .2]]); shell.visible = glass.visible = shellU.uAlpha.value > 0; shell.material.depthWrite = shellU.uAlpha.value > .99;

  // Sun, Earth, SPHEREx. Earth and the model of SPHEREx are put away for the look at one star (the camera sits inside Earth);
  // Earth comes back as the film pulls out, SPHEREx as the white dot it is from then on.
  earthU.uSun.value.copy(s); const er = K(t, [[19, EARTH_R], [21.4, .0001]]); earth.position.copy(E); earth.scale.setScalar(er);
  earthU.uA.value = K(T, [[26, 1], [27, 0], [X, 0], [BACK_T, 1]]); earth.visible = er > .0002 && earthU.uA.value > 0;
  sunLight.position.copy(E).addScaledVector(s, 5); sunLight.target.position.copy(E);
  const look = st.look; if (idx > 0 && idx < NT) {   // where the telescope points: the last photo, turning to the next one
    const f = sm((day - tDay[idx - 1]) / Math.max(1e-6, tDay[idx] - tDay[idx - 1]) * 1.6 - .6);
    look.fromArray(tC, 3 * (idx - 1)).lerp(tmp.fromArray(tC, 3 * idx), f).normalize();
  } else if (idx === 0) look.copy(r).lerp(c0, sm((T - 2.6) / 1.8)).normalize();   // turning to its first field
  else look.copy(r);
  const cs = CRAFT * K(T, [[16.7, 1], [17.4, 0]]); craft.visible = cs > 1e-5;   // the model is gone before the camera comes back to its mouth
  top.copy(p).addScaledVector(look, CRAFT * 1.2);   // just clear of the shields, so the camera can sit there
  if (craft.visible) {
    const z = tmp.copy(s).addScaledVector(look, -s.dot(look)).normalize(), x = tmp2.crossVectors(look, z);
    craft.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, look, z)); craft.position.copy(p); craft.scale.setScalar(cs);
  }

  // camera
  st.fly = flyAt(T);
  const P = poseAt(T); if (pushK > 0) pushIn(P, pushK);
  const fov = P.fov ?? VFOV;
  camera.fov = fov; camera.aspect = W / H; camera.near = P.dist * .02; camera.far = P.dist * 60 + 60;
  camera.position.copy(P.tgt).addScaledVector(P.dir, P.dist); camera.up.copy(P.up); camera.lookAt(P.tgt);
  camera.setViewOffset(W, H, 0, P.shift * H, W, H); camera.updateMatrixWorld();
  if (P.skew) {   // a turn and a stretch of the picture about window point (cx, cy), written for the camera
    const [a, b, c, d, cx, cy] = P.skew, nx = 2 * cx / W - 1, ny = 1 - 2 * cy / H, bb = -b * H / W, cc = -c * W / H;
    camera.projectionMatrix.premultiply(skewM.set(a, bb, 0, nx - a * nx - bb * ny, cc, d, 0, ny - cc * nx - d * ny, 0, 0, 1, 0, 0, 0, 0, 1));
  }
  const ppx = Math.tan(fov / 2 * D2R) * 2 / H, px = st.px = P.dist * ppx;   // world size of one CSS pixel: per unit of depth, and at the subject
  const depth = q => tmp5.copy(q).sub(camera.position).dot(P.dir) * -1;

  sun.scale.setScalar(Math.max(.1, px * 90)); sun.material.opacity = K(t, [[0, 1], [30, 1], [31.4, 0]]);
  earthDot.position.copy(E); earthDot.scale.setScalar(px * 26); earthDot.material.opacity = K(t, [[19.6, 0], [21.4, 1]]) * sys;
  craftDot.position.copy(p); craftDot.scale.setScalar(px * 7); craftDot.material.opacity = K(t, [[5.2, 0], [7, 1], [10.6, 1], [12, 0]]);
  planets.forEach(q => { planetAt(q, day, q.pos); q.line.material.opacity = (q.name === 'Earth' ? K(t, [[5, 0], [7.5, .5]]) : K(t, [[19.8, 0], [22.4, .3]])) * sys; });
  others.forEach((q, i) => q.pos.toArray(planetDots.geometry.attributes.position.array, 3 * i)); planetDots.geometry.attributes.position.needsUpdate = true;
  const inD = K(t, [[21.6, 0], [23.4, 1]]) * sys; planetDots.material.opacity = inD;
  S.comets.forEach((c, i) => { seriesAt(c.pos, day, tmp); if (tmp.distanceTo(E) > R * .96) tmp.copy(E); tmp.toArray(cometDots.geometry.attributes.position.array, 3 * i); });
  cometDots.geometry.attributes.position.needsUpdate = true; cometDots.material.opacity = inD * .8;

  // guides
  guides.begin();
  // SPHEREx's orbit: put away while the camera looks out through the telescope and from inside Earth
  const ga = close ? K(T, [[4.9, 1], [6.2, 0], [FLY1 + .6, 0], [OVER, 1], [16.2, 1], [17.4, 0]]) : K(T, [[X + .6, 0], [X + 1.8, 1]]) * K(t, [[0, 1], [9.6, 1], [11.6, 0]]);
  if (ga > 0) {
    for (let i = 0; i < 96; i++) {
      const a0 = i / 96 * TAU, a1 = (i + 1) / 96 * TAU;
      guides.seg(tmp.copy(E).addScaledVector(u, Math.cos(a0) * ORBIT_R).addScaledVector(v, Math.sin(a0) * ORBIT_R), tmp2.copy(E).addScaledVector(u, Math.cos(a1) * ORBIT_R).addScaledVector(v, Math.sin(a1) * ORBIT_R), WHITE, .3 * ga);
    }
    if (idx > 0 && !close) {   // the telescope's view of the photo it has just taken
      const flash = Math.exp(-(day - tDay[idx - 1]) / Math.max(.0006, .5 * speed)), from = top.clone();
      for (const [a, b] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) guides.seg(from, tileCorner(idx - 1, a, b, tmp), WHITE, (.1 + .5 * flash) * ga, (.05 + .3 * flash) * ga);
    }
  }
  // the beam of the first photo: from the telescope to the four corners of the photo, with a gate across it at every
  // tenfold step in distance, and each thing in the photo where it really is along its own line of sight
  const beam = close ? K(T, [[4.55, 0], [4.7, 1], [6.4, .55], [8.4, .55], [FLY0, .8], [16.2, .8], [18.4, .5], [21.2, 0]]) : 0, fa = flyA(T), sa = sideA(T);
  beamFill.visible = beam > 0; beamFill.material.opacity = .05 * beam * K(T, [[18.4, 1], [19.4, 0]]);
  if (beam > 0) {
    const shut = 1 + 1.6 * Math.exp(-Math.max(0, T - 4.6) / .3), corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, b]) => photoPoint(a, b));
    for (const c of corners) guides.seg(top, c, WHITE, .2 * beam * shut, .5 * beam * shut);
    beamFill.put(top, corners);
    const ps = st.px, gateA = Math.max(fa * .7, sa * .32);
    if (gateA > 0) for (const gt of GATES) for (let k = 0; k < 4; k++) guides.seg(tmp.copy(top).lerp(corners[k], gt.f).clone(), tmp2.copy(top).lerp(corners[(k + 1) % 4], gt.f), WHITE, gateA * (gt.named ? 1.6 : 1));
    for (const m of MARKS) {   // the marks of the distance scale, off the side of the beam that faces the caption
      const a = sa, out = wide() ? tmp3.copy(st.sideUp).negate() : tmp3.copy(st.sideRight).negate(), half = m.f * HALF * R * 1.5;
      tmp.copy(top).lerp(photoPoint(0, 0, tmp2), m.f).addScaledVector(out, half + 5 * ps); m.pos.copy(tmp).addScaledVector(out, 9 * ps);
      if (a > 0) guides.seg(tmp, m.pos, WHITE, .7 * a);
    }
  }
  for (const b of beads) {
    const f = b.ours ? b.f + (1 - b.f) * K(T, [[22.4, 0], [23.4, 1]]) : b.f;   // the star's ring slides out to the photo, along the line of sight
    if (b === sheba) photoPoint(b.u + (ZM.at[0] - b.u) * pushK, b.v + (ZM.at[1] - b.v) * pushK, tmp); else photoPoint(b.u, b.v, tmp);   // pushed in, Sheba's ring sits on its pixel (the predicted spot is 0.4 of a pixel away)
    b.pos.copy(top).lerp(tmp, f);
    b.a = close ? K(T, [[8.5, 0], [FLY0, 1]]) * (b.ours ? 1 : K(T, [[BEAD_GO, 1], [BEAD_GO + 1, 0]])) : b.ours ? K(T, [[X, 1], [X + .6, 0]]) : 0;
    // its ring is a fixed size on screen, except in flight, where it has a size in space (a share of the beam's width there) and so comes up and goes by
    const dz = depth(b.pos), base = b.ours ? 22 : b === sheba ? 17 + 54 * pushK : 17, ca = b.a * Math.max(fa, sa);
    b.px = base + (Math.max(4, .24 * b.f * HALF * R / (Math.max(dz, 1e-9) * ppx)) - base) * fa;
    const near = 1 - sm((b.px - 260) / 420) * fa;   // flown past, it is gone before it fills the view
    b.sp.visible = b.a > 0 && dz > camera.near; b.core.visible = b.sp.visible && ca > 0; if (!b.sp.visible) continue;
    b.sp.position.copy(b.pos); b.sp.scale.setScalar(dz * ppx * b.px); b.sp.material.opacity = b.a * near;
    if (b.core.visible) { const cs = dz * ppx * b.px * (b.kind === 'asteroid' ? .2 : .42); b.core.position.copy(b.pos); b.core.scale.set(cs * (b.kind === 'galaxy' ? 1.7 : 1), cs, 1); b.core.material.opacity = ca * near * near; }
    if (beam > 0 && f < .999) guides.seg(top, b.pos, WHITE, .05 * beam * b.a, .3 * beam * b.a);
  }
  const gs = K(t, [[7, 0], [8.4, 1], [17.4, 1], [18.8, 0]]);
  if (gs > 0) {
    const L = E.length(); for (let i = 0; i < 60; i += 2) guides.seg(tmp.copy(E).multiplyScalar(i / 60), tmp2.copy(E).multiplyScalar((i + 1) / 60), WHITE, .45 * gs);   // Sun to Earth, dashed
    const q = R * .26; guides.seg(tmp.copy(E).addScaledVector(s, q), tmp2.copy(E).addScaledVector(s, q).addScaledVector(u, q), WHITE, .8 * gs);   // the right angle
    guides.seg(tmp2.clone(), tmp.copy(E).addScaledVector(u, q), WHITE, .8 * gs);
    guides.seg(tmp.copy(E).addScaledVector(u, -R), tmp2.copy(E).addScaledVector(u, R), WHITE, .35 * gs);   // across the ring
  }
  guides.end();

  pixels.visible = pushK > PIX_IN;
  if (pixels.visible) {   // the pixels are placed from their own middle, so they stay sharp under a very long lens
    const mid = photoPoint(ZMID[0], ZMID[1], pixels.position), pa = pixels.geometry.attributes.position;
    ZM.corners.forEach((q, i) => photoPoint(q[0], q[1], tmp).sub(mid).toArray(pa.array, 3 * i)); pa.needsUpdate = true; pixels.material.uniforms.uAlpha.value = sm((pushK - PIX_IN) / .14); pixels.material.uniforms.uGain.value = 1.7 + 1.5 * sm((pushK - .9) / .1);   // once they fill the view, the exposure is lifted so the one pixel reads (illustrative)
  }
  if (inDeck) { deckOn = true; deckFrame(U - DK_U); renderer.render(dScene, dcam); }
  else { if (deckOn) { deckOn = false; for (const L of dlabels) L.el.style.opacity = L.o = 0; } renderer.render(scene, camera); }
  placeLabels(T);
  if (close || T < X + .6) { tmp.copy(star.pos).project(camera); drawSpectrum(T, (tmp.x + 1) / 2 * W, (1 - tmp.y) / 2 * H); } else if (specEl.style.opacity !== '0') specEl.style.opacity = 0;

  // words
  const oa = fa * sm((st.fly - .05) / .04) * (1 - sm((st.fly - .9) / .03)); if (oa !== odoShown) odoEl.style.opacity = odoShown = oa;
  if (oa > 0) { const said = odoText(st.fly); if (said !== odoText.said) odoNum.data = odoText.said = said; }
  const hud = close ? K(T, [[.3, 0], [1.2, 1], [4.9, 1], [5.7, 0]]) : K(T, [[X + 1, 0], [X + 2, 1]]) * K(t, [[30, 1], [31, 0]]); $('hud').style.opacity = hud;
  if (hud > 0) { hDate.data = fmtDate(day); hCount.data = (idx <= EARLY ? idx : EARLY + 3 * (idx - EARLY)).toLocaleString('en-US') + (idx === 1 ? ' photo' : ' photos'); }
  const ci = U < CAPTIONS[0][0] ? 0 : CAPTIONS.findIndex(c => U >= c[0] - .15 && U < c[1] + .15);
  if (ci >= 0 && ci !== capShown) { const c = CAPTIONS[ci]; capShown = ci; capText.innerHTML = c[3]; capNote.textContent = c[4]; $('cap-n').textContent = c[2] + ' / 8'; ticks.forEach((el, i) => el.classList.toggle('on', i < c[2])); }
  const c = CAPTIONS[capShown]; capText.style.opacity = capNote.style.opacity = c && !REDUCED ? Math.min(clamp01((U - c[0]) / .35), clamp01((c[1] - U) / .3)) : c ? 1 : 0;
  $('cap').style.opacity = K(t, [[36.9, 1], [37.4, 0]]);
  root.style.opacity = K(U, [[T_HANDOVER + .1, 1], [T_HANDOVER + 1.5, 0]]);   // hand over to the real map underneath
}

// ---------- playing and skipping; stills for reduced motion ----------
const perf = { frames: [] };
let T0 = null, Tnow = 0, still = 0;
function finish() { playing = false; done(); }
function tick(ts) {
  if (!playing) return;
  if (T0 === null) T0 = ts; else perf.frames.push(ts - perf.last);
  perf.last = ts; Tnow = (ts - T0) / 1000;
  if (Tnow >= T_END) return finish();
  render(Tnow); requestAnimationFrame(tick);
}
function showStill(i) {
  still = i; root.style.transition = 'opacity .3s'; root.style.opacity = 0;
  setTimeout(() => { if (signal.aborted) return; render(STILLS[i]); root.style.opacity = 1; $('next').textContent = i === STILLS.length - 1 ? 'Open the map' : 'Next'; }, 300);
}
function skip() {
  if (REDUCED || !playing) return finish();
  if (Tnow < T_HANDOVER) T0 -= (T_HANDOVER - Tnow) * 1000;   // cut to the flat map, then the usual dissolve
}
$('next').onclick = () => (still < STILLS.length - 1 ? showStill(still + 1) : finish());
addEventListener('resize', () => { resize(); if (!playing) render(REDUCED ? STILLS[still] : Tnow); }, { signal });
for (const t of [2, 8, fu(11), fu(15.5), SH_U + 3, fu(24), fu(30), DK_U + 2, DK_U + 12, fw(9), fw(18.8), fw(27), fw(33)]) render(t);   // warm up: compile every shader and upload the pictures before the first real frame
render(0);
$('loading').remove();
// for the checks (web/tests/intro_ui.py) and the recorder: the frame times, any frame on demand, and where the flat map
// was really drawn at the landing: the first and last drawn pixel along window row y and column x, in CSS pixels
function edges(x, y) {
  render(T_HANDOVER);
  const gl = renderer.getContext(), k = renderer.getPixelRatio(), w = canvas.width, h = canvas.height, row = new Uint8Array(w * 4), col = new Uint8Array(h * 4);
  gl.readPixels(0, h - 1 - Math.round(y * k), w, 1, gl.RGBA, gl.UNSIGNED_BYTE, row); gl.readPixels(Math.round(x * k), 0, 1, h, gl.RGBA, gl.UNSIGNED_BYTE, col);
  const span = (px, n) => { let a = 0, b = n - 1; while (a < n && px[4 * a + 3] < 128) a++; while (b > a && px[4 * b + 3] < 128) b--; return [a, b + 1]; };
  const [x0, x1] = span(row, w), [yb, yt] = span(col, h);   // readPixels counts rows from the bottom
  return { x0: x0 / k, x1: x1 / k, y0: (h - yt) / k, y1: (h - yb) / k };
}
const css = q => { tmp.copy(q).project(camera); return [(tmp.x + 1) / 2 * W, (1 - tmp.y) / 2 * H]; };
function probe(U) {   // where things are in the frame at film time U (window pixels)
  render(U); const c = ZM.corners.map(q => photoPoint(q[0], q[1]));
  return { sheba: css(sheba.pos), pixel: c[0].distanceTo(c[1]) / ZM.n / (camera.position.distanceTo(photoPoint(ZM.at[0], ZM.at[1])) * Math.tan(camera.fov / 2 * D2R) * 2 / H),
    photoEdges: [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([u, v]) => css(photoPoint(u, v))), deck: deckFrame.info };
}
function look(U, pts, r = 2) {   // the brightness really drawn round each point at film time U: [mean, max] of 0 to 255 over a square of 2r + 1 window pixels
  render(U); const gl = renderer.getContext(), k = renderer.getPixelRatio(), n = Math.max(1, Math.round((2 * r + 1) * k)), px = new Uint8Array(n * n * 4);
  return pts.map(([x, y]) => { px.fill(0); gl.readPixels(Math.round(x * k - n / 2), Math.round(canvas.height - y * k - n / 2), n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0, max = 0; for (let i = 0; i < px.length; i += 4) { const v = (px[i] + px[i + 1] + px[i + 2]) / 3; sum += v; if (v > max) max = v; } return [sum / (n * n), max]; });
}
window.__intro = debug = { perf, render, edges, probe, look, T_END, T_HANDOVER, reduced: REDUCED, marks: { SH_U, SH, DK_U, DK_END, DIP, D_LIT, FLY0, FLY1 } };
if (REC) { $('skip').hidden = true; return { dispose }; }   // a clean picture for the recorder; Escape still leaves
if (REDUCED) { $('next').hidden = false; showStill(0); } else { playing = true; requestAnimationFrame(tick); }
return { skip, dispose };
} catch (err) { dispose(); throw err; }
}
