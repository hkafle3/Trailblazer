// "How this map was made": a 54 second 3D film that ends on the flat Explore map. It plays over Explore on a first
// visit (explore.html decides, before the tour) and from the "How this map was made" button (explore.js).
// Nothing here is loaded until it plays: explore.js imports this file, which then fetches intro.css, three.js and
// data/intro/ (bake/intro_assets.py). When it ends the WebGL context is given back and the page is as it was.
//
// play() draws a black screen with Skip at once, loads the film behind it, plays it, and resolves when the film has
// handed over to the map (played to the end, skipped with the button or Escape, or failed to load).
// Reduced motion: nine stills, one per caption, with a Next button.
// The film itself is film(): everything on screen is a pure function of the film time T (seconds), so it can be
// played, skipped, stepped and recorded frame by frame.
import { win, straight } from './explore-view.js';

const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';   // the version timelapse.html uses
// the bare minimum to see the cover and Skip before intro.css arrives (zero specificity, so intro.css wins once it does)
const SHELL = `<style>:where(#intro){position:fixed;inset:0;z-index:200;background:#010206;color:#fff}:where(#intro-skip){position:absolute;right:14px;top:12px;min-height:44px;padding:0 18px;color:#fff;background:#000;border:1px solid #fff}</style>
  <canvas id="intro-gl"></canvas>
  <div id="intro-labels" aria-hidden="true"></div>
  <div id="intro-odo" aria-hidden="true"><b></b><span>from Earth</span></div>
  <div id="intro-hud" aria-hidden="true"><span id="intro-h-date"></span><span id="intro-h-count"></span></div>
  <button id="intro-skip" type="button">Skip</button>
  <div id="intro-cap">
    <div class="cap-top"><span id="intro-cap-n">1 / 7</span><span id="intro-cap-ticks"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><button id="intro-next" type="button" hidden>Next</button></div>
    <p id="intro-cap-text" aria-live="polite"></p>
  </div>
  <p id="intro-credit">NASA · SDSS · ESA Gaia · <a href="film.html" target="_blank" rel="noopener">About this film</a></p>
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
// photo.jpg and photo.json (the first photo itself, what is in it and how far away, and one star's brightness in all 102
// colors: bake/intro_photo.py), galaxy.jpg, and three NASA maps of Earth (earth_day, earth_cloud, earth_night .webp: bake/intro_earth.py).
// The film is one camera move with no cut: from close on the telescope over Earth, in through it as it takes its first
// photo (a flash on an empty frame: the picture is not shown yet), down the beam past what is in that photo (each thing
// leaves its light on the empty frame ahead), onto the frame, where the finished photo spreads out from those five
// lights and is seen for the first time; a wash of color crosses it, violet to red, while one star brightens and fades
// as SPHEREx really measured it; then back out to the ring of photos, the whole sky and the map.
// The clocks are explained where they are made.
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
// Two clocks. U is the film's own seconds (what plays, and what the captions are timed in). T is the scene's seconds,
// which everything on screen is keyed in: the same as U until the flight, which covers FLY0 to FLY1 of T while it plays
// for FLY_S seconds of U, and in step again after it. v2() turns U into T, fu() T into U.
// The second half (after X) is the first cut's, still keyed in that cut's seconds: w() turns T into them, wi() back.
const CLICK = 6.7;   // T: the shutter. The first photo is taken here, and it is not shown until the flight has arrived on it
const FLY0 = 9, FLY1 = 13.2;   // T: the flight down the beam, from the telescope's mouth to the photo's frame filling the view
const FLY_S = 11;   // the flight's own length in film seconds: T runs slow while it plays
const WASH = [FLY1 + 3, FLY1 + 7.3];   // T: the colors wash over the finished photo, from the first of the 102 to the last
const X = FLY1 + 7.5;   // T: the look at one photo ends here, and the camera pulls back out of it to the ring
const WARP = [[0, 0], [4.8, 4.8], [X, 4.8], [X + 3, 8.6], [X + 6.2, 12.2], [X + 10.8, 19.3], [X + 14.8, 23.9], [X + 16.6, 30.2], [X + 26, 39.6]];   // [T, first cut's seconds]
const w = T => lin(T, WARP, 0, 1), wi = t => lin(t, WARP.slice(2), 1, 0);
const CLOCK = [[0, 0], [FLY0, FLY0], [FLY0 + FLY_S, FLY1]];   // [U, T]
const v2 = U => lin(U, CLOCK, 0, 1), fu = T => lin(T, CLOCK, 1, 0);
const T_END = fu(wi(39.6)), T_HANDOVER = fu(wi(37.7)), UA = fu(FLY1);   // in U; UA: the flight arrives
const SHOW_U = [UA - .6, UA + 1.7];   // U: the finished photo spreads over its frame, seen for the first time
const shellR = T => KL(w(T), [[8, .3], [11, .3], [13, .42], [18.7, .42], [21.7, R_BIG]]);
const EARTH_R = .022, EARTH_NEAR = .04, ORBIT_R = .054, CRAFT = .0125, R_BIG = 3.2;   // drawing sizes in AU (illustrative)

const fw = t => fu(wi(t));
// [from, to (U), step 1..7, text]. One caption per beat and nothing under it: every beat has to read with these hidden,
// and a voice will be recorded over them. The wording is Ed's. The whole sky gets no caption: the picture says it.
// What is real and what is drawn is said on the film's own page (film.html).
const CAPTIONS = [
  [.5, 4.1, 1, 'This is <b>SPHEREx</b>, a NASA telescope circling Earth.'],
  [4.4, 8.6, 2, 'It takes a <b>picture</b> of the sky.'],
  [8.9, 12.6, 3, 'Let\'s follow the <b>light</b> into that picture.'],
  [12.9, UA - .8, 3, 'Some of it is <b>close</b>. Some is <b>very far away</b>.'],
  [UA - .4, fu(WASH[0]) - .5, 4, 'Here\'s the <b>picture</b> it took.'],
  [fu(WASH[0]) - .2, fu(X + .5), 5, 'It sees every spot in <b>102 colors</b>.'],
  [fu(X + .9), fw(12.2), 6, 'Picture after picture forms a <b>ring</b>.'],
  [fw(12.5), fw(20.6), 6, 'In <b>six months</b> it covers the whole sky.'],
  [fw(30.7), fw(35.4), 7, 'Lay it flat and you get this <b>map</b>.'],
];
const STILLS = [1.2, CLICK + .12, FLY0 + 3.2, UA - 1.5, UA + 2.3, fu(WASH[0] + 1.1), fw(11), fw(15), fw(35.2)];   // one frame per caption, for reduced motion

// ---------- renderer ----------
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: REC });
let playing = false, debug = null, disposed = false;
function dispose() { if (disposed) return; disposed = true; playing = false; renderer.dispose(); renderer.forceContextLoss(); if (window.__intro === debug) delete window.__intro; }
signal.addEventListener('abort', dispose, { once: true });
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
    tex('data/intro/sky.jpg'), fetch('data/intro/photo.json', { signal }).then(r => r.json()).then(async p => [p, await tex('data/intro/' + p.objects.find(o => o.image).image.file)]),   // and the galaxy in it, as SDSS saw it
    tex('data/intro/photo.jpg'), Promise.all(['day', 'cloud', 'night'].map(k => tex(`data/intro/earth_${k}.webp`))),   // Earth: NASA's Blue Marble, its clouds, and the Black Marble (bake/intro_earth.py)
    document.fonts.load('17px "Space Mono"'),
  ])]);
} catch (err) { if (signal.aborted) { dispose(); return { dispose }; } throw err; }   // skipped while the data was loading
if (signal.aborted) { dispose(); return { dispose }; }
const [S, tileBuf, skyTex, [PH, galTex], picTex, earthTex] = loaded;
for (const t of earthTex) { t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8; t.wrapS = THREE.RepeatWrapping; }
galTex.colorSpace = THREE.NoColorSpace;
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
// seconds -> day of the survey (day 0 = MJD 60789). The first photo is taken at CLICK and time then stands still while
// the film looks at it; after X the photos keep coming, as in the first cut.
const dayAt = pchip([[0, tDay[0] - .016], [4, tDay[0] - .0012], [CLICK, tDay[0] + .0001], [CLICK + .8, tDay[0] + .0007], [X, tDay[0] + .0009],
  ...[[6.5, .84], [8, 1.25], [9.5, 2.6], [11, 5.5], [12.5, 16], [17.5, 176], [19, 186], [22, 200], [25.5, 227.3], [27.5, 229], [29.5, 232], [31, 232.6], [41, 232.6]].map(([t, d]) => [wi(t), d])]);
const DAY_X = dayAt(X);
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

// ---------- the first photo itself, on its own tile (tile 0) ----------
// A point of the tile's square is c + u e + v f, u and v from -1 to 1 (f = c x e): photo.jpg and photo.json use the same square.
const c0 = V().fromArray(tC, 0), e0 = V().fromArray(tE, 0), f0 = V().crossVectors(c0, e0), HALF = e0.length();   // HALF: half a photo, as a tangent
const PHOTO_R = .9845;   // a hair in front of the tiles
const photoPoint = (u, v, o = V()) => o.copy(c0).addScaledVector(e0, u).addScaledVector(f0, v).multiplyScalar(st.R * PHOTO_R).add(st.E);
// the colour that stands for each of the 102 channels (0.75 to 5 microns), violet to red, as in the app
const RAMP = [[164, 140, 255], [90, 155, 255], [85, 224, 240], [125, 234, 138], [255, 228, 107], [255, 154, 77], [255, 93, 93]];
const rampAt = t => { t = clamp01(t) * 6; const i = Math.min(5, Math.floor(t)); return RAMP[i].map((c, j) => (c + (RAMP[i + 1][j] - c) * (t - i)) / 255); };
// One star of the photo (the farther of the two flown past) was measured by SPHEREx in all 102 colors: photo.json
// "spectrum", made with the app's own live/spectrum.js. fluxAt(p): how bright it is, p of the way from the first color to
// the last, as a share of its brightest. Measurements with a flagged pixel nearby are left out.
const SPEC = PH.spectrum.slice().sort((a, b) => a[0] - b[0]).map((p, i, all) => [i / (all.length - 1), p[1], p[2]]).filter(p => !p[2]), SPEC_MAX = Math.max(...SPEC.map(p => p[1]));
const fluxAt = p => lin(Math.min(SPEC.at(-1)[0], Math.max(SPEC[0][0], p)), SPEC, 0, 1) / SPEC_MAX;
// The frame is empty until the flight arrives on it. Then the photo spreads out from the five places where the lights of
// the flight landed (uShow: how far it has spread, in half photos), the brightest things first. uFlash: the shutter.
// The wash: the whole photo takes the tint of one color after another (uTint) while a band of that color crosses it
// (uWash: where the band is), and the one measured star is as bright as it really is in that color (uStar).
console.assert(PH.objects.length === 5, 'the photo shader spreads the picture from five lights');
const SOFT = .7, SPREAD = (() => { let m = 0; for (let i = -10; i <= 10; i++) for (let j = -10; j <= 10; j++) m = Math.max(m, Math.min(...PH.objects.map(o => Math.hypot(i / 10 - o.u, j / 10 - o.v)))); return m + SOFT; })();   // SPREAD: far enough to cover every corner
const photoU = { uPic: { value: picTex }, uCenter: { value: V() }, uR: { value: .3 }, uC: { value: c0 }, uE: { value: e0 }, uF: { value: f0 }, uAlpha: { value: 0 }, uEdge: { value: 0 }, uFlash: { value: 0 }, uShow: { value: 0 },
  uDots: { value: PH.objects.map(o => new THREE.Vector2(o.u, o.v)) }, uStarAt: { value: new THREE.Vector2(PH.star.u, PH.star.v) }, uStar: { value: 1 }, uWash: { value: 0 }, uWashA: { value: 0 }, uTint: { value: V(1, 1, 1) } };
const photo = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3)).setIndex([0, 1, 2, 0, 2, 3]), new THREE.ShaderMaterial({
  uniforms: photoU, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  vertexShader: `uniform vec3 uCenter, uC, uE, uF; uniform float uR; varying vec2 vQ;
    void main(){ vQ = position.xy * 1.04; gl_Position = projectionMatrix * viewMatrix * vec4(uCenter + uR * (uC + vQ.x * uE + vQ.y * uF), 1.); }`,   // a little wider than the photo, for the line round it
  fragmentShader: `uniform sampler2D uPic; uniform vec2 uDots[5], uStarAt; uniform vec3 uTint; uniform float uAlpha, uEdge, uFlash, uShow, uStar, uWash, uWashA; varying vec2 vQ;
    void main(){ float e = max(abs(vQ.x), abs(vQ.y)), in0 = step(e, 1.), br = clamp(texture2D(uPic, vQ * .5 + .5).r * 1.7, 0., 1.) * in0;   // in0: inside the photo
      float d = 9.; for (int i = 0; i < 5; i++) d = min(d, distance(vQ, uDots[i]));
      float m = smoothstep(0., ${SOFT}, uShow - d), thr = 1.05 * (1. - m); br *= mix(smoothstep(thr, thr + .25, br), 1., smoothstep(.55, 1., m));   // m: how much of the photo has reached this place
      br *= mix(uStar, 1., smoothstep(.012, .04, distance(vQ, uStarAt)));
      vec3 col = br * vec3(.86, .93, 1.1) + vec3(.018, .03, .055) * m * (1. - m) * 4. * in0;   // and a faint light along the edge of the spreading
      float band = exp(-pow((vQ.x - uWash) / .22, 2.)) * in0;
      col = mix(col, uTint * (br * 1.5 + .04), uWashA * .85) + uTint * band * uWashA * (.2 + .9 * br);
      col += mix(vec3(.5, .68, 1.), vec3(1.), uFlash) * uFlash * (1.25 - .55 * length(vQ)) * in0;   // the shutter: brightest in the middle, and bluer as it dies away
      float we = fwidth(e) * 1.2, line = smoothstep(1. - 2.2 * we, 1. - we, e) * step(e, 1. + we);
      col = mix(col, vec3(1.), line * uEdge);
      gl_FragColor = vec4(col, uAlpha * max(in0, line * uEdge)); }`
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

// ---------- the sky behind the flight: the SPHEREx all-sky picture, at infinity ----------
const backdrop = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({ uniforms: { uSky, uA: { value: 0 } }, side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false,
  vertexShader: `varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.); }`,
  fragmentShader: `${SKY_GLSL} uniform float uA; varying vec3 vD; void main(){ gl_FragColor = vec4(skyColor(normalize(vD)), uA); }` }));
backdrop.frustumCulled = false; backdrop.renderOrder = 0; scene.add(backdrop);

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

// Earth as it looks from orbit: NASA's Blue Marble for the lit side, its clouds over it, the Black Marble's city lights on
// the dark side, and air that glows blue round the edge. It stands and turns as the real Earth does: its pole is the
// sky's north pole, and Greenwich faces where it really did at that minute (earthTurn). Its size is not real.
const earthU = { uSun: { value: V(1, 0, 0) }, uDay: { value: earthTex[0] }, uCloud: { value: earthTex[1] }, uNight: { value: earthTex[2] }, uDrift: { value: 0 }, uShow: { value: 1 } };
const EARTH_VS = `varying vec3 vN, vP; varying vec2 vUv; void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), new THREE.ShaderMaterial({
  uniforms: earthU, vertexShader: EARTH_VS, transparent: true,
  fragmentShader: `uniform sampler2D uDay, uCloud, uNight; uniform vec3 uSun; uniform float uDrift, uShow; varying vec3 vN, vP; varying vec2 vUv;
    void main(){ vec3 n = normalize(vN), v = normalize(cameraPosition - vP);
      float l = dot(n, uSun), mu = max(dot(n, v), 0.), day = smoothstep(-.08, .22, l), sunlit = day * (.22 + .78 * pow(max(l, 0.), .85));
      vec3 land = texture2D(uDay, vUv).rgb; land *= land; land = mix(vec3(.015, .05, .14), land, smoothstep(.0, .01, land.g));                                    // to linear light, near enough
      float sea = smoothstep(.0, .05, land.b - 1.25 * max(land.r, land.g)) * (1. - smoothstep(.12, .3, land.g));
      vec2 cuv = vUv + vec2(uDrift, 0.); float cl = texture2D(uCloud, cuv).r, shade = texture2D(uCloud, cuv + .0035 * vec2(-1., .4)).r; cl = smoothstep(.06, .85, cl);
      vec3 col = mix(land * vec3(1.05, 1.12, 1.3) * 1.5, vec3(.012, .045, .13), .35 * sea) * (1. - .42 * smoothstep(.2, .9, shade));   // the sea a little deeper, and the clouds' shadows
      col = mix(col, vec3(.93, .96, 1.), cl) * sunlit;
      col += vec3(1., .93, .8) * pow(max(dot(reflect(-uSun, n), v), 0.), 90.) * sea * (1. - cl) * day * 1.6;      // the Sun's glint off the sea
      col *= mix(vec3(1., .52, .3), vec3(1.), smoothstep(-.02, .3, l));                                            // sunset along the edge of night
      vec3 city = texture2D(uNight, vUv).rgb; float lamp = smoothstep(.16, .62, max(city.r, city.g));
      col += vec3(1., .74, .42) * lamp * 1.25 * (1. - day) * (1. - .75 * cl) + vec3(.004, .007, .016) * (1. - day);   // city lights, under the clouds
      float haze = pow(1. - mu, 2.6); col = mix(col, vec3(.26, .52, 1.) * (.06 + 1.15 * day), haze * .82);           // the air, thicker towards the edge
      gl_FragColor = vec4(sqrt(col * 1.08), uShow); }`
}));
earth.renderOrder = 3; scene.add(earth);
const air = new THREE.Mesh(earth.geometry, new THREE.ShaderMaterial({   // the glow of the air past the edge: a slightly larger ball, seen from inside
  uniforms: earthU, vertexShader: EARTH_VS, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  fragmentShader: `uniform vec3 uSun; uniform float uShow; varying vec3 vN, vP;
    void main(){ vec3 n = normalize(vN), v = normalize(cameraPosition - vP); float rim = clamp(-dot(n, v) / .36, 0., 1.), l = dot(n, uSun);
      gl_FragColor = vec4(vec3(.24, .5, 1.) * pow(rim, 2.2) * (.05 + 1.2 * smoothstep(-.35, .35, l)) + vec3(.5, .2, .1) * pow(rim, 5.) * smoothstep(.3, 0., abs(l)) * .5, uShow); }`
}));
air.renderOrder = 3.1; scene.add(air);
const GREENWICH = day => (280.46061837 + 360.98564736629 * (S.mjd0 + day - 51544.5)) % 360;   // the sidereal time at Greenwich, in degrees: the right ascension overhead there
const earthM = new THREE.Matrix4(), earthX = V(), earthZ = V();
function earthTurn(day) { eqDir(GREENWICH(day), 0, earthX); earthZ.crossVectors(earthX, N); earth.quaternion.setFromRotationMatrix(earthM.makeBasis(earthX, N, earthZ)); air.quaternion.copy(earth.quaternion); }

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

// small noise for the shaders of the model and the rocks
const NOISE_GLSL = `float hash(vec3 p){ p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vn(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y), mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
  float fbm(vec3 p){ return .5 * vn(p) + .25 * vn(p * 2.03 + 7.) + .125 * vn(p * 4.1 + 13.) + .0625 * vn(p * 8.3 + 5.); }`;
// ---------- SPHEREx: three nested cone shields over a telescope and a small body (a simple model, not the flight CAD) ----------
// Lit by rule, as the rocks are: sunlight from where the Sun is, the blue of the day side of Earth below, and black space.
// A shiny part mirrors those three. Foil is the same with a crinkled surface. Inside the shields nothing is in sunlight
// unless the Sun can be seen from there over the rim of the outer shield: that is what the shields are for.
const CONES = [[1, .40, .86], [.84, .34, .93], [.68, .28, 1]];   // top radius, bottom radius, height
const craftU = { uSun: { value: V(1, 0, 0) }, uEarth: { value: V(0, -1, 0) }, uAt: { value: V() }, uAx: { value: V(0, 1, 0) }, uS: { value: 1 } };   // uEarth: the way to Earth; uAt, uAx, uS: where the model is, its axis and its scale
const CRAFT_FS = `uniform vec3 uSun, uEarth, uAt, uAx, uBase; uniform float uS, uMetal, uRough, uFoil, uIn, uCells; uniform mat4 modelMatrix; varying vec3 vO, vNo, vP; varying vec2 vUv; ${NOISE_GLSL}
  vec3 around(vec3 r, float k, float sunny){                       // what is seen in direction r, blurred by k (0 a mirror, 1 matt)
    k = max(k, .02); float e = dot(r, uEarth), disc = smoothstep(.55 - .5 * k, .68 + .4 * k, e), lit = smoothstep(-.35, .25, dot(r, uSun));
    vec3 c = vec3(.012, .016, .03) + vec3(.22, .42, .85) * disc * (.04 + lit) + vec3(.5, .75, 1.) * smoothstep(.2, 0., abs(e - .62)) * (1. - k) * lit * .5;   // space, Earth's day side, the bright edge of its air
    return c + vec3(1., .95, .86) * pow(max(dot(r, uSun), 0.), mix(900., 5., sqrt(k))) * mix(22., 1.1, sqrt(k)) * sunny; }
  void main(){ vec3 no = normalize(vNo), base = uBase; float rough = uRough, metal = uMetal;
    if (uFoil > 0.) { vec3 p = vO * 7.; float e = .04, b0 = fbm(p); vec3 g = vec3(fbm(p + vec3(e, 0, 0)) - b0, fbm(p + vec3(0, e, 0)) - b0, fbm(p + vec3(0, 0, e)) - b0) / e; no = normalize(no - uFoil * (g - dot(g, no) * no)); }
    if (uCells > 0.) { vec2 q = vUv * vec2(5., 8.), f = abs(fract(q) - .5); float line = smoothstep(.44, .47, max(f.x, f.y)), bus = smoothstep(.03, .01, abs(fract(q.y * 3.) - .5)) * (1. - line);   // a solar panel: cells, the gaps between them, the fine wires
      base = mix(base * (.8 + .4 * hash(vec3(floor(q), 1.))), vec3(.62, .66, .72), max(line, bus * .35)); rough = mix(rough, .5, line); }
    vec3 n = normalize(mat3(modelMatrix) * no), v = normalize(cameraPosition - vP); if (dot(n, v) < 0.) n = -n;
    float sunny = 1.; if (uIn > .5) { vec3 q = vP - uAt; float up = dot(uSun, uAx), t = (${CONES[0][2].toFixed(2)} * uS - dot(q, uAx)) / max(up, 1e-4); q += uSun * t; sunny = up > 0. && t > 0. ? smoothstep(1.03, .97, length(q - uAx * dot(q, uAx)) / uS) : step(t, 0.); }
    float nl = max(dot(n, uSun), 0.) * sunny, nv = max(dot(n, v), 0.), fres = pow(1. - nv, 5.);
    vec3 f0 = mix(vec3(.04), base, metal), F = f0 + (1. - f0) * fres * (1. - .6 * rough);
    vec3 matt = base * (1. - metal) * (vec3(1., .96, .9) * nl * 1.05 + vec3(.2, .36, .7) * (.12 + .5 * max(dot(n, uEarth), 0.)) + .015);
    vec3 col = matt + around(reflect(-v, n), min(1., rough + .5 * uFoil), sunny) * F;
    if (uIn > .5) { float h = clamp(dot(vP - uAt, uAx) / uS, 0., 1.); col = col * mix(.22, 1., smoothstep(.05, .95, h)) + base * (vec3(.05, .07, .11) + vec3(.16, .2, .28) * pow(h, 6.)) * (1. - sunny); }   // deep inside the shields it is dark; near the rims, the light that bounces about
    col = col / (1. + .45 * col); gl_FragColor = vec4(pow(col * 1.25, vec3(.4545)), 1.); }`;
const craftMat = (base, metal, rough, more = {}) => new THREE.ShaderMaterial({ vertexShader: `varying vec3 vP, vO, vNo; varying vec2 vUv; void main(){ vO = position; vNo = normal; vUv = uv; vec4 w = modelMatrix * vec4(position, 1.); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`, fragmentShader: CRAFT_FS, side: more.side ?? THREE.FrontSide,
  uniforms: { ...craftU, uBase: { value: new THREE.Color(base) }, uMetal: { value: metal }, uRough: { value: rough }, uFoil: { value: more.foil ?? 0 }, uIn: { value: more.inside ? 1 : 0 }, uCells: { value: more.cells ? 1 : 0 } } });
function makeCraft() {
  const craft = new THREE.Group(), add = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); craft.add(m); return m; };
  const skin = craftMat(0xe9e6df, .35, .5, { foil: .16 }), skinIn = craftMat(0xe9e6df, .35, .5, { foil: .16, inside: true });   // the shields' outer faces: pale blanket
  const mirror = craftMat(0xdfe3ea, 1, .1, { side: THREE.BackSide, inside: true, foil: .03 });                                  // their inner faces: bare polished metal
  const metal = craftMat(0xc9ced6, 1, .28), metalIn = craftMat(0xc9ced6, 1, .28, { inside: true }), black = craftMat(0x0b0c10, .2, .55, { inside: true });
  const gold = craftMat(0xd8a03c, 1, .3, { foil: .32 }), dark = craftMat(0x121419, .5, .45);
  CONES.forEach(([top, bot, h], k) => {
    const geo = new THREE.CylinderGeometry(top, bot, h, 96, 1, true); add(geo, k ? skinIn : skin, 0, h / 2); add(geo, mirror, 0, h / 2);
    add(new THREE.TorusGeometry(top, .011, 8, 128), k ? metalIn : metal, 0, h).rotation.x = Math.PI / 2;                        // the rim
    add(new THREE.CylinderGeometry(bot, bot * .9, .03, 64), k ? metalIn : metal, 0, .015);
  });
  add(new THREE.CylinderGeometry(.2, .2, .62, 48, 1, true), craftMat(0x1a1c22, .6, .4, { inside: true, side: THREE.DoubleSide }), 0, .31);   // the telescope's tube, its black inside and its ring
  add(new THREE.CircleGeometry(.2, 48), black, 0, .3).rotation.x = -Math.PI / 2; add(new THREE.TorusGeometry(.2, .014, 8, 64), metalIn, 0, .62).rotation.x = Math.PI / 2;
  [.0, -.035, -.07].forEach((y, k) => add(new THREE.CylinderGeometry(.44 - .04 * k, .36 - .03 * k, .012, 64), metal, 0, y - .012));   // three radiator plates under the shields
  add(new THREE.CylinderGeometry(.31, .31, .4, 6), gold, 0, -.31);                                                              // the body, in foil
  add(new THREE.CylinderGeometry(.325, .325, .05, 6), dark, 0, -.13); add(new THREE.CylinderGeometry(.325, .325, .03, 6), metal, 0, -.5);
  for (let k = 0; k < 6; k++) { const a = (k + .5) / 6 * TAU, strut = add(new THREE.CylinderGeometry(.008, .008, .5, 6), metal, Math.cos(a) * .36, .12, Math.sin(a) * .36); strut.rotation.set(Math.sin(a) * .5, 0, -Math.cos(a) * .5); }   // struts up to the shields
  add(new THREE.BoxGeometry(.09, .07, .09), dark, -.3, -.3, -.12); add(new THREE.CylinderGeometry(.012, .012, .2, 8), metal, .22, -.56, -.16); add(new THREE.ConeGeometry(.04, .06, 16), metal, .22, -.67, -.16);   // a star tracker and an antenna
  const panel = new THREE.Group(); panel.position.set(0, -.14, .44); panel.rotation.x = -.16; craft.add(panel);                  // the solar panel, on the Sun's side
  const cells = new THREE.Mesh(new THREE.PlaneGeometry(.62, .92), craftMat(0x12224e, .7, .22, { cells: true })); cells.position.z = .0135; panel.add(cells);
  panel.add(new THREE.Mesh(new THREE.BoxGeometry(.65, .95, .025), metal));
  return craft;
}
const craft = makeCraft(); craft.scale.setScalar(CRAFT); scene.add(craft);

// ---------- thin guide lines, rebuilt every frame (few points): SPHEREx's orbit, its line of sight, Sun to Earth, the right angle ----------
function dynLines(max) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(max * 6, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(max * 8, 4));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
  l.frustumCulled = false; l.renderOrder = 7; scene.add(l);
  let n = 0; const P = g.attributes.position.array, C = g.attributes.color.array;
  return {
    begin() { n = 0; },
    seg(a, b, col, ia = 1, ib = ia) {
      if (n >= max) return; a.toArray(P, 6 * n); b.toArray(P, 6 * n + 3);
      const c = 8 * n; C[c] = C[c + 4] = col[0]; C[c + 1] = C[c + 5] = col[1]; C[c + 2] = C[c + 6] = col[2]; C[c + 3] = Math.min(1, ia); C[c + 7] = Math.min(1, ib); n++;
    },
    end() { g.setDrawRange(0, 2 * n); g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = true; }
  };
}
const guides = dynLines(600);
const beamFill = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(15, 3)).setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]),   // the beam's faint body: its four sides, from a point to the corners of a photo
  new THREE.MeshBasicMaterial({ color: 0xbfd6ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
beamFill.frustumCulled = false; beamFill.renderOrder = 6; scene.add(beamFill);
const WHITE = [1, 1, 1], STREAK_COL = [.78, .87, 1];
const STREAKS = Array.from({ length: 180 }, (_, j) => { const r = k => { const h = Math.sin(j * 12.9898 + k * 78.233) * 43758.5453; return h - Math.floor(h); }, a = TAU * r(1), d = 1.5 + 10 * r(2) ** 1.5; return [d * Math.cos(a), d * Math.sin(a), 70 * r(3), .35 + .65 * r(4)]; });   // where each line of speed sits round the flight path

// ---------- SPHEREx's orbit: a circle side-on to the Sun; its phase is fitted to where the real photos pointed ----------
const st = { fly: 0, day: 0, E: V(), s: V(), u: V(), v: V(), p: V(), r: V(), t: V(), R: .3, look: V(), idx: 0, top: V(), px: 1, dist: 1 };   // top: the mouth of the telescope
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
// fraction of the way from the telescope to the photo], straight lines between.
const AU_LY = 63241.08, DEPTH = [[0, .08], [1, .26], [Math.log10(AU_LY), .38], [Math.log10(AU_LY) + 2, .47], [Math.log10(AU_LY) + 4, .62], [Math.log10(AU_LY) + 6, .72], [Math.log10(AU_LY) + 9, .86]];
const depthOf = au => lin(Math.log10(au), DEPTH, 0, 1);
// a gate across the beam at every tenfold step in distance (1 AU to 10,000 AU, then 1 light-year to 100 million): flown through, each one is ten times farther
const GATES = [...[0, 1, 2, 3, 4].map(k => 10 ** k), ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map(k => AU_LY * 10 ** k)].map(depthOf);
function odoText(f) {   // the distance from Earth at that point of the beam, to one figure: it ticks over as the flight goes
  const au = 10 ** lin(f, DEPTH, 1, 0), r = x => { const m = 10 ** Math.floor(Math.log10(x)); return Math.round(x / m) * m; }, n = x => r(x).toLocaleString('en-US');
  if (au < AU_LY * .7) return n(au) + ' AU'; const ly = au / AU_LY;
  return ly < 1.5 ? '1 light-year' : ly < 1e6 ? n(ly) + ' light-years' : n(ly / 1e6) + ' million light-years';
}
const coreTex = glowTex([[0, '#fff'], [.25, 'rgba(255,255,255,.9)'], [.6, 'rgba(255,255,255,.2)'], [1, 'rgba(255,255,255,0)']]);
// ---------- the bodies flown past: two rocks, two stars, a galaxy ----------
// In flight each thing in the photo is a body with a size in space (a share of the beam's width where it is), so it comes
// up, is passed and is left behind. Real: where each one is; the direction sunlight falls on the rocks (from where the
// Sun is, seen from a rock that far along the line of sight); the stars' colors (a black body at the star's Gaia DR3
// temperature: bake/intro_photo.py); and the galaxy, which is its own photo from the Sloan Digital Sky Survey, north up
// as on the sky. Imagined: the rocks' shapes, surfaces, tints and tumbling (nobody has seen them as more than a point of
// light), and every size.
const BODY = { asteroid: { r: .085, pass: .19, hold: 2.2 }, star: { r: .04, pass: .2, hold: 2.4 }, galaxy: { r: .3, pass: .27, hold: 3.2 } };   // radius and passing distance, in half-widths of the beam there; hold: how many passing distances short of it the camera is slowest
function rockGeo(seed) {   // a lumpy, cratered ball: a sphere pushed in and out by noise and a few bowls, normals from the same rule
  const hash = (x, y, z) => { const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 53.3) * 43758.5453; return h - Math.floor(h); }, L = (p, q, t) => p + (q - p) * t;
  const vn = (x, y, z) => { const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), f = x - i, g = y - j, h = z - k, a = f * f * (3 - 2 * f), b = g * g * (3 - 2 * g), c = h * h * (3 - 2 * h);
    return L(L(L(hash(i, j, k), hash(i + 1, j, k), a), L(hash(i, j + 1, k), hash(i + 1, j + 1, k), a), b), L(L(hash(i, j, k + 1), hash(i + 1, j, k + 1), a), L(hash(i, j + 1, k + 1), hash(i + 1, j + 1, k + 1), a), b), c); };
  const fbm = (x, y, z, n) => { let s = 0, a = .5; for (let i = 0; i < n; i++) { s += a * (vn(x, y, z) - .5); x = x * 2.03 + 11; y = y * 2.03 + 5; z = z * 2.03 + 7; a *= .5; } return s; };
  const bowls = Array.from({ length: 9 }, (_, k) => { const z = 2 * hash(k, 1, 0) - 1, a = TAU * hash(k, 2, 0), r = Math.sqrt(1 - z * z); return [r * Math.cos(a), r * Math.sin(a), z, .16 + .32 * hash(k, 3, 0) ** 2]; });
  const sq = [1, .8 + .1 * hash(0, 0, 1), .64 + .1 * hash(0, 0, 2)];
  function at(x, y, z, o) {
    const n = Math.hypot(x, y, z); x /= n; y /= n; z /= n; let r = 1 + .55 * fbm(x * 1.4, y * 1.4, z * 1.4, 3) + .15 * fbm(x * 5 + 3, y * 5, z * 5, 3);
    for (const [cx, cy, cz, w] of bowls) { const t = Math.acos(Math.min(1, x * cx + y * cy + z * cz)) / w; if (t < 1.7) r += w * ((t < 1 ? -.24 * (1 - t * t) : 0) + .07 * Math.exp(-(((t - 1) / .22) ** 2))); }
    at.h = r - 1; return o.set(x * r * sq[0], y * r * sq[1], z * r * sq[2]);
  }
  const g = new THREE.IcosahedronGeometry(1, 32), P = g.attributes.position, Nn = g.attributes.normal, hs = new Float32Array(P.count), a = V(), b = V(), c = V(), t1 = V(), t2 = V(), h = .012, done = new Map();
  for (let i = 0; i < P.count; i++) {
    a.fromBufferAttribute(P, i); const key = (Math.round(a.x * 1e4) * 20001 + Math.round(a.y * 1e4)) * 20001 + Math.round(a.z * 1e4), j = done.get(key);   // each corner is shared by six triangles: worked out once
    if (j !== undefined) { P.setXYZ(i, P.getX(j), P.getY(j), P.getZ(j)); Nn.setXYZ(i, Nn.getX(j), Nn.getY(j), Nn.getZ(j)); hs[i] = hs[j]; continue; }
    done.set(key, i); t1.set(a.y, -a.x, 0); if (t1.lengthSq() < .01) t1.set(0, a.z, -a.y); t1.normalize(); t2.crossVectors(a, t1);
    at(a.x + h * t1.x, a.y + h * t1.y, a.z + h * t1.z, b); at(a.x + h * t2.x, a.y + h * t2.y, a.z + h * t2.z, c); at(a.x, a.y, a.z, a); hs[i] = at.h;
    t1.crossVectors(b.sub(a), c.sub(a)).normalize(); P.setXYZ(i, a.x, a.y, a.z); Nn.setXYZ(i, t1.x, t1.y, t1.z);
  }
  g.setAttribute('aH', new THREE.BufferAttribute(hs, 1)); g.computeBoundingSphere(); return g;   // aH: how far out the ground is there, to darken the hollows
}
const BODY_VS = `attribute float aH; varying vec3 vN, vP, vO, vNo; varying vec2 vUv; varying float vH; void main(){ vO = position; vNo = normal; vUv = uv; vH = aH; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const rockMat = tint => new THREE.ShaderMaterial({ transparent: true, uniforms: { uLight: { value: V(1, 0, 0) }, uTint: { value: V(...tint) }, uRot: { value: new THREE.Matrix3() }, uA: { value: 0 } }, vertexShader: BODY_VS,
  fragmentShader: `uniform vec3 uLight, uTint; uniform mat3 uRot; uniform float uA; varying vec3 vO, vNo, vP; varying float vH; ${NOISE_GLSL}
    void main(){ vec3 p = vO * 9., no = normalize(vNo); float e = .05, b0 = fbm(p);
      vec3 g = vec3(fbm(p + vec3(e, 0, 0)) - b0, fbm(p + vec3(0, e, 0)) - b0, fbm(p + vec3(0, 0, e)) - b0) / e;   // fine roughness: the slope of a small noise
      vec3 n = uRot * normalize(no - .42 * (g - dot(g, no) * no));
      float l = dot(n, uLight), lit = smoothstep(-.03, .05, dot(uRot * no, uLight)) * pow(max(l, 0.), .8);
      float mottle = .55 + 1.5 * (fbm(vO * 2.6 + 3.) - .45), grain = .8 + .5 * (b0 - .45), hollow = mix(.5, 1.12, smoothstep(-.13, .09, vH));
      vec3 col = uTint * mottle * grain * hollow * (lit * (1.15 + .5 * max(dot(n, normalize(cameraPosition - vP)), 0.)) + .012);
      gl_FragColor = vec4(col, uA); }` });
const starMat = tint => new THREE.ShaderMaterial({ transparent: true, uniforms: { uTint: { value: V(...tint) }, uTime: { value: 0 }, uA: { value: 0 } }, vertexShader: BODY_VS,
  fragmentShader: `uniform vec3 uTint; uniform float uA, uTime; varying vec3 vN, vP, vO; ${NOISE_GLSL}
    void main(){ float mu = max(dot(normalize(vN), normalize(cameraPosition - vP)), 0.), gr = fbm(vO * 7. + vec3(0., uTime * .2, 0.));
      vec3 col = mix(uTint * uTint * .72, mix(uTint, vec3(1.), .3), pow(mu, .6)) * (.84 + .3 * gr);   // its own color at the middle; darker and deeper towards the limb
      gl_FragColor = vec4(col, uA * smoothstep(0., .22, mu)); }` });
const galMat = map => new THREE.ShaderMaterial({ transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { uPic: { value: map }, uA: { value: 0 } }, vertexShader: BODY_VS,
  fragmentShader: `uniform sampler2D uPic; uniform float uA; varying vec2 vUv;
    void main(){ float r = length(vUv - .5) * 2.; vec3 c = texture2D(uPic, vUv).rgb; c = max(c - .07, 0.) * 2. * smoothstep(.1, .24, dot(c, vec3(.4, .4, .2))) * (1. - smoothstep(.36, .72, r));   // the sky around it, and the grain of its faint edge, taken down to black
      gl_FragColor = vec4(c, uA); }` });
const haloTex = glowTex([[0, 'rgba(255,255,255,.85)'], [.1, 'rgba(255,255,255,.85)'], [.15, 'rgba(255,255,255,.4)'], [.28, 'rgba(255,255,255,.14)'], [.55, 'rgba(255,255,255,.035)'], [1, 'rgba(255,255,255,0)']]);   // the disc's edge is a tenth of the way out
const ballGeo = new THREE.SphereGeometry(1, 64, 32), flatGeo = new THREE.PlaneGeometry(2, 2);
const beads = PH.objects.map((o, i) => {
  const ours = o.kind === 'star' && Math.abs(o.u - PH.star.u) < 1e-3 && Math.abs(o.v - PH.star.v) < 1e-3;
  // a plain mark for a rock or a galaxy too far ahead to be more than a point (a star has its glow)
  const core = o.kind === 'star' ? null : new THREE.Sprite(new THREE.SpriteMaterial({ map: o.kind === 'asteroid' ? dotTex : coreTex, color: o.kind === 'asteroid' ? 0xb9ad9c : 0xffe9c4, transparent: true, depthWrite: false, depthTest: false }));
  if (core) { core.renderOrder = 7.5; scene.add(core); }
  const dir = V().copy(c0).addScaledVector(e0, o.u).addScaledVector(f0, o.v).normalize(), tint = o.rgb ?? (i ? [.5, .38, .3] : [.56, .53, .5]);   // imagined tints: a grey rock, and a darker, redder one, as Trojans tend to be
  const mesh = new THREE.Mesh(o.kind === 'asteroid' ? rockGeo(i + 1) : o.kind === 'star' ? ballGeo : flatGeo, o.kind === 'asteroid' ? rockMat(tint) : o.kind === 'star' ? starMat(tint) : galMat(galTex));
  mesh.frustumCulled = false; mesh.renderOrder = 7.2; mesh.visible = false; scene.add(mesh);
  let glow = null; if (o.kind === 'star') { glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: new THREE.Color().setRGB(...tint, THREE.SRGBColorSpace), transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending })); glow.renderOrder = 7.1; glow.visible = false; scene.add(glow); }
  if (o.kind === 'galaxy') {   // its photo has north up and east to the left: stood the same way here, facing back down the line of sight
    const up = N.clone().addScaledVector(dir, -N.dot(dir)).normalize(); mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(V().crossVectors(dir, up), up, dir.clone().negate()));
    console.assert(eqDir(o.ra, o.dec).angleTo(dir) < 2e-4, 'the galaxy should be where its own coordinates say');
  }
  const h = k => { const x = Math.sin(i * 91.7 + k * 37.3) * 43758.5453; return x - Math.floor(x); };
  // its light on the photo: a spark that leaves the body and runs down its line of sight, and the dot it makes where it lands
  const light = o.rgb ?? (o.kind === 'galaxy' ? [1, .9, .74] : [1, .95, .86]), glowing = (rgb, tex) => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color().setRGB(...rgb, THREE.SRGBColorSpace), transparent: true, opacity: 0, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending })); sp.renderOrder = 7.6; sp.visible = false; scene.add(sp); return sp; };
  const spark = glowing(light, coreTex), dot = glowing(light, haloTex), dotCore = glowing([1, 1, 1], coreTex);
  return { ...o, i, ours, light, spark, dot, dotCore, landed: 0, short: `${ours || o.kind !== 'asteroid' ? o.kind : o.name.split(' ')[1]} · ${o.dist}`, said: `${ours ? 'star' : o.name} · ${o.dist}`, f: depthOf(o.au), core, mesh, glow, dir, pos: V(), rpx: 0, lab: 0, front: true, axis: V(h(1) - .5, h(2) - .5, h(3) - .5).normalize(), spin: .22 + .16 * h(4) };
});
// ---------- the colors: a wash over the finished photo ----------
const starSpot = V(), washP = T => clamp01((T - WASH[0]) / (WASH[1] - WASH[0])), washA = T => K(T, [[WASH[0] - .35, 0], [WASH[0] + .3, 1], [WASH[1] - .3, 1], [WASH[1] + .5, 0]]);
// ---------- the flight down the beam ----------
// The camera leaves the telescope's mouth and passes close by each body in turn, on a path bent a little to do so. Its
// speed is in proportion to how far it is from the nearest stopping place (to a power, FLY_P), and the stopping places are
// just short of each body, so it closes in on each one ever more slowly, holds it in view, and is flung past it to the next: the long gaps go by in a rush and the bodies get the time. The path
// (where the camera is after each moment, how fast, and how far the speed lines have run) is worked out once per window size.
const FILL = .72, FLY_P = 1.3, SIG = [Math.log(.02), Math.log(.3)], GLANCE = .55;   // FILL: the share of the window's height the photo fills where the flight ends, clear of the caption; SIG: the speeds (beam lengths a second, natural log) between which the speed lines come on
const flyA = T => K(T, [[8.5, 0], [FLY0, 1], [FLY1, 1], [FLY1 + .7, 0]]);   // how much of the film is flight: the bodies, the sky behind, the gates
const RAY_S = .9, RAY_T = RAY_S * (FLY1 - FLY0) / FLY_S;   // how long a body's light takes to reach the photo: film seconds, and the scene's
let fl = null;
function flightPath() {
  const L = photoPoint(0, 0, tmp).distanceTo(st.top), key = W + 'x' + H; if (fl?.key === key) return fl;
  const lat = HALF * st.R * PHOTO_R / L, th = Math.tan(flyFov() / 2 * D2R), fitEnd = 1 - HALF * st.R / Math.min(th * FILL, th * W / H * .9) / L;
  const end = Math.max(fitEnd, ...beads.map(b => b.f + BODY[b.kind].hold * BODY[b.kind].pass * b.f * lat));   // pass every body even when a tall window needs a wider lens to frame the photo
  const way = [{ f: 0, e: .004, bf: 0, e0: .004, u: 0, v: 0 }, ...beads.map((b, i) => { const B = BODY[b.kind], sx = i % 2 ? -1 : 1, [dx, dy] = wide() ? [sx * .96, .28] : [sx * .3, .95];   // each body passes to one side (on a phone, overhead)
    const e0 = B.pass * b.f * lat; return { f: b.f - B.hold * e0, e: 1.6 * e0, bf: b.f, e0, u: b.u - dx * B.pass, v: b.v + dy * B.pass }; }), { f: end, e: .012, bf: end, e0: .012, u: 0, v: 0 }];   // bf, e0: the body's own place, and its passing distance as a share of the beam's length
  const t = [0], f = [0], sig = [0], phi = [0], sg = (e, s) => sm((Math.log(e) + FLY_P * Math.log(Math.cosh(s)) - SIG[0]) / (SIG[1] - SIG[0])), n = 200;
  const put = (dt, ff, s) => { t.push(t.at(-1) + dt); f.push(ff); sig.push(s); };
  for (let k = 0; k < way.length - 1; k++) {   // each leg: away from one body, then in on the next; they meet where the two speeds are the same
    const A = way[k], B = way[k + 1], hh = (d, e) => e * Math.pow(1 + d * d / e / e, FLY_P / 2); let lo = A.f, hi = B.f;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; hh(m - A.f, A.e) < hh(B.f - m, B.e) ? lo = m : hi = m; }
    const sA = Math.asinh((lo - A.f) / A.e), sB = Math.asinh((B.f - lo) / B.e);
    for (let i = 1; i <= n; i++) { const go = k ? 1 + 1.4 * sm(sA * i / n / 1.2) : 1; put(Math.pow(Math.cosh(sA * (i - .5) / n), 1 - FLY_P) * sA / n / go, A.f + A.e * Math.sinh(sA * i / n), sg(A.e * go, sA * i / n)); }   // go: it leaves a body faster than it came
    for (let i = n - 1; i >= 0; i--) put(Math.pow(Math.cosh(sB * (i + .5) / n), 1 - FLY_P) * sB / n, B.f - B.e * Math.sinh(sB * i / n), sg(B.e, sB * i / n));
  }
  const k = FLY_S / t.at(-1); for (let i = 1; i < t.length; i++) { t[i] *= k; phi.push(phi[i - 1] + (sig[i] + sig[i - 1]) / 2 * (t[i] - t[i - 1])); }
  // each body's light leaves it where the camera is slowest before it, and lands on the photo RAY_S seconds later
  const emit = beads.map((b, i) => { let j = 0; while (f[j] < way[i + 1].f) j++; return Math.min(FLY0 + (t[j] - .25) / FLY_S * (FLY1 - FLY0), FLY1 - .45 - RAY_T); });
  return fl = { key, way, L, t, f, sig, phi, emit, fov: end > fitEnd ? fovFill(HALF * st.R, L * (1 - end), FILL, .9) : flyFov(), cu: pchip(way.map(q => [q.bf, q.u])), cv: pchip(way.map(q => [q.bf, q.v])) };
}
function flyNow(T) {   // st.fly: how far down the beam (0 at the telescope, 1 at the photo); st.sig: how hard it is rushing, 0 to 1; st.phi: how far the speed lines have run
  if (T < 8) { st.fly = st.sig = st.phi = 0; return; }   // the telescope is still turning to its field: no path yet
  const F = flightPath(), q = clamp01((T - FLY0) / (FLY1 - FLY0)) * FLY_S; let lo = 0, hi = F.t.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; F.t[m] <= q ? lo = m : hi = m; }
  const k = clamp01((q - F.t[lo]) / Math.max(1e-9, F.t[hi] - F.t[lo])), mix = a => a[lo] + (a[hi] - a[lo]) * k;
  st.fly = mix(F.f); st.sig = mix(F.sig) * flyA(T); st.phi = mix(F.phi);
}

// ---------- labels ----------
// A label sits to the right of its point unless `at` says otherwise: [dx, dy] in pixels, then how much of its own
// width and height to shift by (-.5, -1 = centred above).
const labels = [];
function label(text, pos, alpha, cls = '', at = null) { const el = document.createElement('div'); el.className = 'lbl ' + cls; $('labels').append(el); labels.push({ el, pos, alpha, at, o: -1, text: typeof text === 'function' ? text : () => text, said: null }); }
const sysA = T => K(w(T), [[30, 1], [31.4, 0]]);   // the solar system fades before the sphere unfolds
const wide = () => W > H;
label('Sun', o => o.set(0, 0, 0), T => K(w(T), [[11.6, 0], [12.6, 1]]) * sysA(T));
label('Earth', o => o.copy(st.E), T => K(w(T), [[6.8, 0], [7.8, 1]]) * sysA(T));
label('SPHEREx', o => o.copy(st.p), T => K(T, [[.8, 0], [1.6, 1], [4.9, 1], [5.7, 0]]));
label('to the Sun', o => o.copy(st.E).addScaledVector(st.s, st.R * 1.25), T => K(w(T), [[7.4, 0], [8.4, 1], [10.6, 1], [11.6, 0]]));
label('90°', o => o.copy(st.E).addScaledVector(st.s, st.R * .34).addScaledVector(st.u, st.R * .34), T => K(w(T), [[8.4, 0], [9.2, 1], [17.4, 1], [18.6, 0]]));
// the flight: each body's name and distance under it while it is the one being passed; then the five lights on the finished photo
for (const b of beads) label(b.said, o => o.copy(b.pos), () => b.lab, '', () => [0, Math.min(b.rpx * (b.kind === 'star' ? 1.7 : b.kind === 'galaxy' ? .62 : 1.08), H * .2) + 12, -.5, 0]);
// on the finished photo, each of the five lights says what it is and how far: side by side on one flat picture. The star's stays through the colors: it is the one to watch
const landA = (T, ours) => K(T, [[FLY1 + .5, 0], [FLY1 + 1.1, 1], ...(ours ? [[WASH[1] - .2, 1], [WASH[1] + .4, 0]] : [[WASH[0] - .7, 1], [WASH[0] - .2, 0]])]);
const LAND_AT = [[10, -6, 0, 0], [10, -6, 0, 0], [10, -6, 0, 0], [-9, -8, -1, -1]];   // the far star and the galaxy are a few pixels apart: one label up and to the left, the other to the right (below, on a phone)
for (const b of beads) label(b.short, o => photoPoint(b.u, b.v, o), T => landA(T, b.ours), 'land', () => LAND_AT[b.i] ?? (wide() ? [10, 1, 0, 0] : [0, 10, -.5, 0]));
function placeLabels(T) {
  for (const L of labels) {
    const a = L.alpha(T); let vis = a > .01 && L.pos(tmp);
    if (vis) { tmp.project(camera); vis = tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05; }
    const o = vis ? +a.toFixed(3) : 0; if (o !== L.o) L.el.style.opacity = L.o = o;
    if (!vis) continue;
    const said = L.text(T); if (said !== L.said) L.el.textContent = L.said = said;
    const [dx, dy, ax, ay] = L.at?.() ?? [10, -5, 0, 0];
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
// photo comes past one thing at a time in order of distance. After the last body, the lens frames the photo. Once there
// it never quite stops: it starts to draw back, slowly at first, and that becomes the pull-out to the ring.
const flyFov = () => wide() ? 55 : 80, CREEP = .14;   // CREEP: how much farther back the camera is when the pull-out begins
const flyCam = (f, o) => o.copy(st.top).lerp(photoPoint(fl.cu(f), fl.cv(f), tmp), f);
function flyPose(T) {
  const F = flightPath(), f = st.fly, pos = flyCam(f, V()), view = flyCam(Math.min(1, f + 2e-4), V()).sub(flyCam(Math.max(0, f - 2e-4), tmp2)).normalize();
  for (const b of beads) {   // a glance at each body as it comes up, let go as it is passed
    const q = F.way[b.i + 1], xi = (f - q.bf) / q.e0, g = GLANCE * sm((xi + 40) / 30) * (1 - sm((xi + 1.4) / 2.4));
    if (g > 0) view.lerp(tmp2.copy(st.top).lerp(photoPoint(b.u, b.v, tmp), b.f).sub(pos).normalize(), g).normalize();
  }
  const D = F.L * (1 - f), back = 1 + CREEP * (Math.max(0, T - FLY1) / (X - FLY1)) ** 2;
  const framing = sm((f - F.way.at(-2).bf) / (F.way.at(-1).f - F.way.at(-2).bf));
  return pose(pos.addScaledVector(view, D), view.negate(), D * back, upPhoto, wide() ? .07 + .04 * framing : .15, flyFov() + (F.fov - flyFov()) * framing + (wide() ? 16 : 10) * st.sig);   // the lens opens up in the rush
}
// the way out of the photo: straight back along its line of sight, past the telescope, to over Earth's shoulder. The photo
// stays in the middle and Earth comes into view under it; only then does the film swing round to see the ring.
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
  // it opens close on SPHEREx from above, Earth filling the view behind it, and draws back until the orbit is in view
  { a: 0, b: 4.5, f: T => { const k = sm(T / 4.4), near = W > H ? .021 : .024;
    return pose(tmp.copy(st.p).addScaledVector(st.look, CRAFT * .35).lerp(st.E, .3).lerp(tmp5.copy(st.E).addScaledVector(st.r, .074), k), tmp2.copy(st.s).multiplyScalar(K(T, [[0, .7], [5, .5]])).addScaledVector(st.t, .68).addScaledVector(st.r, .55 - .65 * k),
      fitDist(near * Math.pow((W > H ? .05 : .062) / near, k)), W > H ? tmp3.copy(st.r).multiplyScalar(.3).addScaledVector(tmp4.crossVectors(tmp2, st.r).normalize(), -.95) : st.r, (W > H ? .09 : .225) * k + .03 * (1 - k)); } },   // on a phone, high enough that the orbit line clears the caption's rule
  { a: 6.9, b: 8.4, f: eyePose },
  { a: FLY0, b: X, f: flyPose },
  { a: X + 2, b: X + 2.2, f: backPose },
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
const capText = $('cap-text'), credit = $('credit'), ticks = [...$('cap-ticks').children];
const hDate = $('h-date').appendChild(new Text('')), hCount = $('h-count').appendChild(new Text(''));   // text nodes: ui.js watches the page for added elements, and these change every frame
let capShown = -1, odoShown = -1;
const odoEl = $('odo'), odoNum = odoEl.firstChild.appendChild(new Text(''));
const fmtDate = d => new Date((S.mjd0 + d - 40587) * 864e5).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
function render(U) {
  const T = v2(U);
  const t = w(T), day = st.day = dayAt(T), speed = (dayAt(T + .05) - dayAt(T - .05)) / .1, R = st.R = shellR(T), close = T < X;   // t: the first cut's seconds
  const { E, s, u, v, p, r, top } = st;
  orbitFrame(day, E, s, u, v);
  const al = PHASE.a0 + PHASE.w * day; r.copy(u).multiplyScalar(Math.cos(al)).addScaledVector(v, Math.sin(al));
  st.t.copy(u).multiplyScalar(-Math.sin(al)).addScaledVector(v, Math.cos(al)).multiplyScalar(Math.sign(PHASE.w)); p.copy(E).addScaledVector(r, ORBIT_R);
  const idx = st.idx = tileIndex(day), sys = sysA(T);

  // tiles
  tileGeo.instanceCount = idx; tileU.uCenter.value.copy(E); tileU.uR.value = R * .985;   // a hair inside the joined-up sky, so it never hides them
  tileU.uNow.value = day;
  tileU.uFresh.value = Math.max(.0009, .13 * speed);
  tileU.uFill.value = K(t, [[18.2, 1], [19.6, 0]]); tileU.uFront.value = K(t, [[7.5, 0], [9.3, .85], [12.6, 0]]); tileU.uSeam.value = K(t, [[6, .4], [10, .1], [12.5, 0]]);   // on the way out of the close look the camera passes the near side of the ring: outlines only there
  tileU.uAlpha.value = sys * K(T, [[X + 1.1, 0], [X + 2, 1]]); tiles.visible = tileU.uAlpha.value > 0;   // not in the close look: the first photo has its own frame there, and up close the all-sky picture is a blur
  uLift.value = K(t, [[19, 1], [21.5, 0]]);

  // The first photo's frame. It is there, faintly, from when the telescope has turned to its field. At CLICK the shutter
  // flashes over it and it stays empty: what is flown past puts its light there, and only when the flight has arrived
  // does the photo itself spread over it. It stays on its tile until the ring is in view.
  const pa = photoU.uAlpha.value = K(T, [[4.4, 0], [4.9, 1], [X + 2.2, 1], [X + 3.4, 0]]); photo.visible = pa > 0;
  const wa = washA(T), wp = washP(T), flux = fluxAt(wp), tint = rampAt(wp), starLit = 1 + wa * (flux - 1);   // starLit: the measured star's brightness now, 1 outside the wash
  if (photo.visible) {
    photoU.uCenter.value.copy(E); photoU.uR.value = R * PHOTO_R;
    photoU.uEdge.value = K(T, [[4.4, 0], [4.9, .45], [CLICK - .05, .45], [CLICK + .1, 1], [CLICK + 1, .8], [X + 2.2, .8], [X + 3.4, 0]]);
    photoU.uFlash.value = T < CLICK ? 0 : clamp01((T - CLICK) / .05) * Math.exp(-Math.max(0, T - CLICK - .05) / .3);
    const sk = clamp01((U - SHOW_U[0]) / (SHOW_U[1] - SHOW_U[0])); photoU.uShow.value = SPREAD * (sk + sm(sk)) / 2;   // at a steady pace, eased only at its two ends
    photoU.uWashA.value = wa; photoU.uWash.value = -1.35 + 2.7 * wp; photoU.uTint.value.set(...tint); photoU.uStar.value = starLit;
  }

  // the joined-up sky, and its unfolding
  const unroll = K(t, [[31.4, 0], [35.3, 1]]);
  shellU.uCenter.value.copy(E); shellU.uR.value = R; shellU.uT.value = unroll;
  shellU.uAlpha.value = K(t, [[17.6, 0], [19.2, 1]]); shellU.uGrid.value = K(t, [[19.5, 0], [22, .13], [35.5, .13], [37.5, .05]]); shellU.uEcl.value = K(t, [[21, 0], [23, .55], [35.5, .55], [37.5, .75]]);
  glassU.uGrid.value = K(t, [[19.5, 0], [22, .2]]); shell.visible = glass.visible = shellU.uAlpha.value > 0; shell.material.depthWrite = shellU.uAlpha.value > .99;

  // Sun, Earth, SPHEREx. The model of SPHEREx is put away once the flight has left it behind; from the pull-out on it is a white dot.
  earthU.uSun.value.copy(s); const er = T < FLY1 ? K(T, [[FLY0 + .5, EARTH_NEAR], [FLY0 + 1.5, EARTH_R]]) : K(t, [[19, EARTH_R], [21.4, .0001]]); earth.position.copy(E); earth.scale.setScalar(er); air.position.copy(E); air.scale.setScalar(er * 1.07);   // larger in the opening, where it is the backdrop; it is changed while the flight looks the other way
  earth.visible = air.visible = er > .0002;
  if (earth.visible) { const turn = Math.min(day, DAY_X) + Math.max(0, T - X) * .003; earthTurn(turn); earthU.uDrift.value = turn * .02; }   // it turns as it really did while the first photos are taken; after that the film's days fly by, and it is slowed to a drift
  const look = st.look; if (idx > 0 && idx < NT) {   // where the telescope points: the last photo, turning to the next one
    const f = sm((day - tDay[idx - 1]) / Math.max(1e-6, tDay[idx] - tDay[idx - 1]) * 1.6 - .6);
    look.fromArray(tC, 3 * (idx - 1)).lerp(tmp.fromArray(tC, 3 * idx), f).normalize();
  } else if (idx === 0) look.copy(r).lerp(c0, sm((T - 2.6) / 1.8)).normalize();   // turning to its first field
  else look.copy(r);
  const cs = CRAFT * K(T, [[FLY0 + .6, 1], [FLY0 + 1.2, 0]]); craft.visible = cs > 1e-5;   // the model is gone before the camera pulls back past it
  top.copy(p).addScaledVector(look, CRAFT * 1.2);   // just clear of the shields, so the camera can sit there
  if (craft.visible) {
    const z = tmp.copy(s).addScaledVector(look, -s.dot(look)).normalize(), x = tmp2.crossVectors(look, z);
    craft.quaternion.setFromRotationMatrix(skewM.makeBasis(x, look, z)); craft.position.copy(p); craft.scale.setScalar(cs);
    craftU.uSun.value.copy(s); craftU.uEarth.value.copy(r).negate(); craftU.uAt.value.copy(p); craftU.uAx.value.copy(look); craftU.uS.value = cs;
  }

  // camera
  flyNow(T); const fa = flyA(T);
  const P = poseAt(T); st.dist = P.dist;
  const fov = P.fov ?? VFOV;
  camera.fov = fov; camera.aspect = W / H; camera.near = Math.exp(Math.log(P.dist * .02) * (1 - fa) + Math.log((fl?.L ?? 1) * 2e-5) * fa); camera.far = P.dist * 60 + 60;
  camera.position.copy(P.tgt).addScaledVector(P.dir, P.dist); camera.up.copy(P.up); camera.lookAt(P.tgt);
  camera.setViewOffset(W, H, 0, P.shift * H, W, H); camera.updateMatrixWorld();
  if (P.skew) {   // a turn and a stretch of the picture about window point (cx, cy), written for the camera
    const [a, b, c, d, cx, cy] = P.skew, nx = 2 * cx / W - 1, ny = 1 - 2 * cy / H, bb = -b * H / W, cc = -c * W / H;
    camera.projectionMatrix.premultiply(skewM.set(a, bb, 0, nx - a * nx - bb * ny, cc, d, 0, ny - cc * nx - d * ny, 0, 0, 1, 0, 0, 0, 0, 1));
  }
  // The pull-out goes straight back along the photo's line of sight, which runs through Earth. Earth is not drawn from inside,
  // and it comes into view as the camera draws away from it, not all at once as the camera leaves it.
  earthU.uShow.value = sm((camera.position.distanceTo(E) / Math.max(earth.scale.x, 1e-9) - 1.15) / 1.6);
  backdrop.visible = T > FLY0 - .25 && fa > 0; backdrop.position.copy(camera.position); backdrop.scale.setScalar(camera.far * .5); backdrop.material.uniforms.uA.value = .32 * K(T, [[FLY0 - .25, 0], [FLY0 + .1, 1], [FLY1, 1], [FLY1 + .7, 0]]);   // not under the long lens before the flight: there it is a blur
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
  const ga = close ? K(T, [[4.9, 1], [6.2, 0]]) : K(T, [[X + .6, 0], [X + 1.8, 1]]) * K(t, [[0, 1], [9.6, 1], [11.6, 0]]);
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
  // the beam of the first photo: from the telescope to the four corners of the photo, with a gate across it at every tenfold step in distance
  const beam = close ? K(T, [[4.4, 0], [4.9, .55], [CLICK - .05, .55], [CLICK + .1, 1], [CLICK + 1.2, .55], [8.4, .55], [FLY0, .8], [FLY1, .8], [FLY1 + 1, 0]]) : 0;   // faint while the telescope looks, bright from the shutter on
  beamFill.visible = beam > 0; beamFill.material.opacity = .05 * beam;
  if (beam > 0) {
    const shut = T < CLICK ? 1 : 1 + 1.6 * Math.exp(-(T - CLICK) / .3), corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, b]) => photoPoint(a, b));
    for (const c of corners) guides.seg(top, c, WHITE, .2 * beam * shut, .5 * beam * shut);
    const bp = beamFill.geometry.attributes.position; top.toArray(bp.array, 0); corners.forEach((c, k) => c.toArray(bp.array, 3 + 3 * k)); bp.needsUpdate = true;
    if (fa > 0) for (const f of GATES) for (let k = 0; k < 4; k++) guides.seg(tmp.copy(top).lerp(corners[k], f).clone(), tmp2.copy(top).lerp(corners[(k + 1) % 4], f), WHITE, fa * .22);
  }
  for (const b of beads) {
    b.pos.copy(top).lerp(photoPoint(b.u, b.v, tmp), b.f);
    const dz = depth(b.pos), dc = camera.position.distanceTo(b.pos), B = BODY[b.kind], rw = B.r * b.f * HALF * R * PHOTO_R, rpx = b.rpx = rw / (Math.max(dc, 1e-12) * ppx);   // rpx: the body's radius on screen
    // the body itself, with a size in space. Far ahead it is a point of light
    const q = fl?.way[b.i + 1], xi = q ? (st.fly - q.bf) / q.e0 : -99, far = fa * (1 - sm((rpx - (b.kind === 'galaxy' ? 4 : 1.5)) / 3));
    b.front = dz > 0; b.lab = fa * sm((rpx * (b.kind === 'star' ? 2.5 : 1) - 24) / 14) * sm((xi + 16) / 8) * (1 - sm((xi + .5) / 1.3));
    if (b.core) {
      b.core.visible = dz > camera.near && far > 0;
      if (b.core.visible) { const cs = dz * ppx * (b.kind === 'galaxy' ? 7 : 3.4); b.core.position.copy(b.pos); b.core.scale.set(cs * (b.kind === 'galaxy' ? 1.7 : 1), cs, 1); b.core.material.opacity = far; }
    }
    // its light: the spark runs from the body to its place on the photo, a thin thread stays behind it, and the dot stays where it lands
    const em = fl ? fl.emit[b.i] : 1e9, pr = clamp01((T - em) / RAY_T), fh = b.f + (1 - b.f) * pr * Math.sqrt(pr), thr = pr > 0 ? K(T, [[FLY1 - .5, 1], [FLY1 + .15, 0]]) * (T < FLY0 ? 0 : 1) : 0;
    const land = b.landed = sm((T - em - RAY_T) / .04 + 1) * (b.ours ? K(T, [[WASH[1] - .1, 1], [WASH[1] + .5, 0]]) : K(T, [[WASH[0] - .6, 1], [WASH[0] - .1, 0]])) * (T < FLY0 ? 0 : 1), where = photoPoint(b.u, b.v, tmp4);   // the star's light stays through the colors
    if (thr > 0) { const from = Math.max(b.f, st.fly + .002); if (fh > from) guides.seg(tmp.copy(top).lerp(where, from), tmp2.copy(top).lerp(where, fh), b.light, .1 * thr, (pr < 1 ? .95 : .3) * thr); }
    b.spark.visible = pr > 0 && pr < 1 && thr > 0;
    if (b.spark.visible) { b.spark.position.copy(top).lerp(where, fh); const d = depth(b.spark.position); b.spark.visible = d > camera.near; b.spark.scale.setScalar(d * ppx * (18 + 14 * (1 - pr))); b.spark.material.opacity = Math.min(1, 6 * pr) * thr; }
    b.dot.visible = b.dotCore.visible = land > 0;
    if (land > 0) { const d = depth(where), burst = 1 + 2.4 * Math.exp(-Math.max(0, T - em - RAY_T) / RAY_T * 7), size = Math.max(d * ppx * 2.4, HALF * R * PHOTO_R * .022);   // it flares as it lands
      // in the wash the star's light takes the color of the moment, and its size goes with how bright the star really is in that color (area with brightness)
      const glow = b.ours ? 1 + wa * (2.6 * Math.sqrt(flux) - 1) : 1, lit = b.ours ? .3 + .7 * starLit : 1; if (b.ours) b.dot.material.color.setRGB(...b.light.map((c, j) => c + (tint[j] - c) * .85 * wa), THREE.SRGBColorSpace);
      b.dot.position.copy(where); b.dotCore.position.copy(where); b.dot.scale.setScalar(size * 4 * burst * glow); b.dotCore.scale.setScalar(size * 2 * Math.sqrt(burst) * glow); b.dot.material.opacity = land * lit; b.dotCore.material.opacity = land * lit; }
    b.mesh.visible = fa > 0; if (b.glow) b.glow.visible = fa > 0;
    if (fa > 0) {
      const un = b.mesh.material.uniforms; b.mesh.position.copy(b.pos); b.mesh.scale.setScalar(rw); un.uA.value = fa;
      if (b.kind === 'asteroid') {   // tumbling slowly, lit from where the Sun really is from there
        b.mesh.quaternion.setFromAxisAngle(b.axis, b.i * 2 + U * b.spin); un.uRot.value.setFromMatrix4(skewM.makeRotationFromQuaternion(b.mesh.quaternion));
        un.uLight.value.copy(E).addScaledVector(b.dir, b.au).normalize().negate();
      } else if (b.kind === 'star') {
        un.uTime.value = U; b.glow.position.copy(b.pos); b.glow.scale.setScalar(Math.max(rw * 20, Math.max(dz, 0) * ppx * 9)); b.glow.material.opacity = fa * (.6 + .4 * sm(rpx / 4));
      } else un.uA.value = fa * (1 - sm((xi + 1.1) / .9)) * sm(rpx / 5) * (1 - sm((rpx / H - .42) / .3));   // a flat photo: gone before it is seen edge on, or so large that it is a blur
    }
  }
  photoPoint(PH.star.u, PH.star.v, starSpot);
  // the rush between bodies: lines of speed past the lens (drawn; they are not stars)
  if (st.sig > .004) {
    const S = camera.near * 60, ax = tmp3.copy(photoPoint(0, 0, tmp)).sub(top).normalize(), rt = tmp4.crossVectors(ax, upPhoto).normalize(), up = tmp5.crossVectors(rt, ax);
    for (const [x, y, z0, wgt] of STREAKS) {
      const z = ((z0 - st.phi * 110) % 70 + 70) % 70 - 6, len = 1 + 18 * st.sig * wgt;
      tmp.copy(camera.position).addScaledVector(rt, x * S).addScaledVector(up, y * S).addScaledVector(ax, z * S); tmp2.copy(tmp).addScaledVector(ax, len * S);
      guides.seg(tmp, tmp2, STREAK_COL, .7 * st.sig * wgt * Math.min(1, (64 - z) / 14), 0);
    }
  }
  const gs = K(t, [[7, 0], [8.4, 1], [17.4, 1], [18.8, 0]]);
  if (gs > 0) {
    const L = E.length(); for (let i = 0; i < 60; i += 2) guides.seg(tmp.copy(E).multiplyScalar(i / 60), tmp2.copy(E).multiplyScalar((i + 1) / 60), WHITE, .45 * gs);   // Sun to Earth, dashed
    const q = R * .26; guides.seg(tmp.copy(E).addScaledVector(s, q), tmp2.copy(E).addScaledVector(s, q).addScaledVector(u, q), WHITE, .8 * gs);   // the right angle
    guides.seg(tmp2.clone(), tmp.copy(E).addScaledVector(u, q), WHITE, .8 * gs);
    guides.seg(tmp.copy(E).addScaledVector(u, -R), tmp2.copy(E).addScaledVector(u, R), WHITE, .35 * gs);   // across the ring
  }
  guides.end();

  renderer.render(scene, camera);
  placeLabels(T);

  // words
  const oa = fa * sm((st.fly - .05) / .04) * (1 - sm((st.fly - (fl?.way.at(-2).f ?? 1) - .001) / .004)); if (oa !== odoShown) odoEl.style.opacity = odoShown = oa;   // it stops at the galaxy: past it there is only the photo
  if (oa > 0) { const said = odoText(st.fly); if (said !== odoText.said) odoNum.data = odoText.said = said; }
  const hud = close ? K(T, [[.3, 0], [1.2, 1], [4.9, 1], [5.7, 0]]) : K(T, [[X + 1, 0], [X + 2, 1]]) * K(t, [[30, 1], [31, 0]]); $('hud').style.opacity = hud;
  if (hud > 0) { hDate.data = fmtDate(day); hCount.data = (idx <= EARLY ? idx : EARLY + 3 * (idx - EARLY)).toLocaleString('en-US') + (idx === 1 ? ' photo' : ' photos'); }
  const ci = U < CAPTIONS[0][0] ? 0 : CAPTIONS.findIndex(c => U >= c[0] - .15 && U < c[1] + .15);
  if (ci >= 0 && ci !== capShown) { const c = CAPTIONS[ci]; capShown = ci; capText.innerHTML = c[3]; $('cap-n').textContent = c[2] + ' / 7'; ticks.forEach((el, i) => el.classList.toggle('on', i < c[2])); }
  const c = CAPTIONS[capShown]; capText.style.opacity = c && !REDUCED ? Math.min(clamp01((U - c[0]) / .35), clamp01((c[1] - U) / .3)) : c ? 1 : 0;
  $('cap').style.opacity = K(t, [[35.4, 1], [35.9, 0]]);
  const cr = REDUCED ? +(still === STILLS.length - 1) : K(t, [[35.9, 0], [36.5, 1]]); credit.style.opacity = cr; credit.style.visibility = cr > 0 ? 'visible' : 'hidden';   // the credits, on the finished map: quiet, and only there (with reduced motion, on the last still, where they stay until Next is pressed)
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
for (const t of [.2, 2, CLICK + .1, 8, fu(11), UA - .2, UA + .4, fu(WASH[0] + 2), fw(9), fw(18.8), fw(27), fw(33)]) render(t);   // warm up: compile every shader and upload the pictures before the first real frame
render(0);
renderer.getContext().readPixels(0, 0, 1, 1, 6408, 5121, new Uint8Array(4));   // wait here for the graphics card to finish all of that, not in the film's first frame
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
function probe(U) {   // where things are in the frame at film time U (window pixels), and the camera itself
  render(U);
  return { photoEdges: [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([u, v]) => css(photoPoint(u, v))), star: css(starSpot), wash: { a: photoU.uWashA.value, p: washP(v2(U)), flux: fluxAt(washP(v2(U))), tint: rampAt(washP(v2(U))) }, flash: photoU.uFlash.value,
    cam: { pos: camera.position.toArray(), dir: camera.getWorldDirection(V()).toArray(), fov: camera.fov, dist: st.dist },
    flight: beads.map(b => ({ name: b.name, kind: b.kind, au: b.au, at: css(b.pos), r: b.rpx, front: b.front, drawn: b.mesh.visible && b.mesh.material.uniforms.uA.value > .5, land: css(photoPoint(b.u, b.v)), landed: b.landed, lands: fu(fl.emit[b.i] + RAY_T) })), fly: st.fly, rush: st.sig, fill: photoU.uShow.value / SPREAD };   // fill: how much of the photo is shown
}
function look(U, pts, r = 2) {   // the brightness really drawn round each point at film time U: [mean, max, mean color] of 0 to 255 over a square of 2r + 1 window pixels
  render(U); const gl = renderer.getContext(), k = renderer.getPixelRatio(), n = Math.max(1, Math.round((2 * r + 1) * k)), px = new Uint8Array(n * n * 4);
  return pts.map(([x, y]) => { px.fill(0); gl.readPixels(Math.round(x * k - n / 2), Math.round(canvas.height - y * k - n / 2), n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0, max = 0; const c = [0, 0, 0]; for (let i = 0; i < px.length; i += 4) { const v = (px[i] + px[i + 1] + px[i + 2]) / 3; sum += v; if (v > max) max = v; for (let j = 0; j < 3; j++) c[j] += px[i + j] / (n * n); } return [sum / (n * n), max, c]; });
}
window.__intro = debug = { perf, render, edges, T_END, T_HANDOVER, reduced: REDUCED };
if (REC) Object.assign(debug, { probe, look, flightPath, marks: { CLICK, FLY0, FLY1: UA, SHOW: SHOW_U, WASH: WASH.map(fu), OUT: fu(X), RING: fu(X + 3.6), CAPS: CAPTIONS.map(c => [c[0], c[1]]), CREDIT: fw(36.5) } });
if (REC) { $('skip').hidden = true; return { dispose }; }   // a clean picture for the recorder; Escape still leaves
if (REDUCED) { root.classList.add('still'); $('next').hidden = false; showStill(0); } else { playing = true; requestAnimationFrame(() => requestAnimationFrame(tick)); }   // the frame after next: the next one was timed before all of the above ran, and the film would start that much late
return { skip, dispose };
} catch (err) { dispose(); throw err; }
}
