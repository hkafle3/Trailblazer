// Explore in 3D: the same sky as the flat map, as the sphere it really is, seen from outside. Earth sits at its middle,
// with the Sun, the inner planets and the comets inside it, and the sky is built from real SPHEREx photo footprints.
// A click on the sky flies the camera to Earth and then out along the line of sight to that photo, and offers
// "Open time-lapse here": the same address a click on the flat map's "Look closer" opens (explore.js patchUrl).
//
// Nothing here is loaded until the switch is first pressed: explore.js imports this file, which then fetches three.js
// and data/intro/ (the 3D intro's data, bake/intro_assets.py), and later the sharp sky tiles around a chosen photo. The flat map is never touched: it is covered and hidden
// (explore-3d.css, body[data-view="3d"]) and every key and pointer event is kept away from it, so Flat shows it as it was.
// The timeline stays and drives the 3D view too: the day sets where Earth and the comets are and which photos exist yet.
//
// What is real: every footprint (centre, size, tilt and time of a SPHEREx D1 photo; all of the first 4 days, then one
// in three), the sky picture, and the JPL Horizons positions of Earth, the planets and the comets. A comet's line is
// the path it really took during the survey, not its whole orbit. What is not to scale: the sphere's size (a photo
// records a direction, not a distance) and the size of Earth's ball.
//
// The camera: 'overview' turns about Earth (drag, arrow keys; wheel, pinch, + and - zoom); 'flying'; 'photo' sits on
// the line of sight looking out at the photo (drag looks around). Reduced motion cuts where it would fly.
import { dayDate } from './skymap.js';
import { nest2xyf, xyf2radec, radec2tile, tileUrl } from './healpix.js';

const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';   // the version intro.js and timelapse.html use
const SHELL = `<canvas id="x3d-gl" tabindex="0" aria-label="The sky in 3D. Drag or use the arrow keys to turn it. Click a photo, or press Enter for the one in the middle, to fly to it."></canvas>
  <div id="x3d-labels" aria-hidden="true"></div>
  <p id="x3d-hint"></p>
  <div id="x3d-card" hidden>
    <button id="x3d-back" type="button" aria-label="Back to the whole sky"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    <span class="eyebrow" id="x3d-what"></span>
    <h3 id="x3d-when"></h3>
    <p id="x3d-where"></p>
    <a id="x3d-open">Open time-lapse here<svg class="ic" aria-hidden="true"><use href="icons.svg#arrow"/></svg></a>
    <button id="x3d-deep" type="button">Zoom in<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
  </div>
  <div id="x3d-loading">Loading the sky</div>`;

const $ = id => document.getElementById(id);
const page = document.body, calm = matchMedia('(prefers-reduced-motion: reduce)'), phone = matchMedia('(max-width: 640px)');
let root = null, made = null, live = null, patchUrl = null, deepAt = null;   // made: the scene's promise; live: the scene once it is up
let under = [];   // the flat map's controls under the 3D view, made inert while it is up

// show(true, patchUrl) switches to 3D, show(false) back to Flat
export function show(on, urlFor, deepFn, target) { if (urlFor) patchUrl = urlFor; if (deepFn) deepAt = deepFn; aim = on ? target : null; (on ? enter : leave)(); }
let aim = null;   // [ra, dec] to fly to once the scene is up ("View in 3D" from the time-lapse)
const pressed = on => { $('view-3d').setAttribute('aria-pressed', on); $('view-flat').setAttribute('aria-pressed', !on); };

function enter() {
  if (page.dataset.view === '3d') return;
  page.dataset.view = '3d'; pressed(true);
  if (!root) {
    root = Object.assign(document.createElement('div'), { id: 'x3d', innerHTML: SHELL });
    root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'The sky in 3D');
    document.body.append(root);
  }
  root.hidden = false;
  under = [...document.querySelectorAll('.xbtns, .zoomctl, .csheet, #dive-aim')].filter(el => !el.inert); under.forEach(el => { el.inert = true; });
  addEventListener('keydown', onKey, true);
  (made ??= make()).then(s => { live = s; if (page.dataset.view === '3d') { s.start(); if (aim) { s.goTo(...aim); aim = null; } } },
    err => { console.warn('the 3D view could not load', err); made = null; leave(); });
}
function leave() {
  if (page.dataset.view !== '3d') return;
  const a = document.activeElement, back = !a || a === document.body || root.contains(a);
  delete page.dataset.view; pressed(false);
  removeEventListener('keydown', onKey, true);
  live?.stop(); root.hidden = true;
  under.forEach(el => { el.inert = false; }); under = [];
  if (back) $('view-3d').focus({ preventScroll: true });
}
// Keys, before the flat map hears them (explore-desktop.js pans and zooms on the same ones, explore.js closes its pin on Escape)
function onKey(e) {
  if (document.querySelector('[aria-modal="true"]')) return;   // the sign-in sheet, the guide or the tour is up (ui.js): the keys are theirs
  if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); return leave(); }
  if (e.metaKey || e.ctrlKey || e.altKey || (e.target !== document.body && e.target.id !== 'x3d-gl')) return;   // the timeline's handle, buttons and links keep their own keys
  const go = e.target.id === 'x3d-gl' && (e.key === 'Enter' || e.key === ' ');
  if (!go && !/^(Arrow.*|[-+=_0])$/.test(e.key)) return;
  e.stopPropagation(); e.preventDefault();
  live?.key(e.key);
}

// ---------------------------------------------------------------- the scene
async function make() {
const THREE = await import(THREE_URL);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const EPS = 23.4392911 * Math.PI / 180, RAD = Math.PI / 180, TAU = 2 * Math.PI;
const v3 = (x, y, z, o = V()) => o.set(x, z, -y);   // ecliptic (x, y, z) -> three.js (y up = ecliptic north), as intro.js
const Y = V(0, 1, 0), F = V(1, 0, 0), N = V(0, Math.cos(EPS), -Math.sin(EPS));   // ecliptic north; towards RA 0; sky north
// Sizes in AU. The sky has no true distance: R is only a way to draw directions. The photos are flat squares touching
// a sphere of R_TILE; the sky not yet photographed is a sphere just behind them; R_WALL is where a click is taken to land.
const R = 3.2, R_TILE = R * .985, R_WALL = R * .9855, R_SHELL = R * .987, R_FRESH = R * .98, R_SHARP = R * .983, EARTH_R = .022, NEAR_EARTH = .06;
const FRESH = 9;   // days a new photo keeps its outline, as the flat map's strip stays lit
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sm = x => { x = clamp(x, 0, 1); return x * x * x * (x * (6 * x - 15) + 10); };
const get = (url, as) => fetch(url).then(r => (r.ok ? r[as]() : Promise.reject(new Error(`${url}: HTTP ${r.status}`))));

const canvas = $('x3d-gl'), card = $('x3d-card'), hint = $('x3d-hint'), slider = $('time');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);   // the page's own night-blue shows behind the sphere
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, 1, .01, 100);

const [S, tileBuf, skyTex] = await Promise.all([get('data/intro/scene.json', 'json'), get('data/intro/tiles.bin', 'arrayBuffer'),
  new THREE.TextureLoader().loadAsync('data/intro/sky.jpg'), document.fonts.load('11px "Space Mono"')]);
skyTex.colorSpace = THREE.NoColorSpace; skyTex.wrapS = THREE.RepeatWrapping; skyTex.anisotropy = 8;
const STEP = S.step, NDAY = S.days;
function seriesAt(arr, day, o) {   // flat xyz every STEP days from day 0 -> position on a day
  const f = clamp(day / STEP, 0, arr.length / 3 - 1 - 1e-6), i = Math.floor(f), u = f - i;
  return v3(arr[3 * i] + u * (arr[3 * i + 3] - arr[3 * i]), arr[3 * i + 1] + u * (arr[3 * i + 4] - arr[3 * i + 1]), arr[3 * i + 2] + u * (arr[3 * i + 5] - arr[3 * i + 2]), o);
}
function eqDir(ra, dec, o = V()) {   // RA, Dec in degrees -> unit vector in the 3D world
  const a = ra * RAD, d = dec * RAD, x = Math.cos(d) * Math.cos(a), y = Math.cos(d) * Math.sin(a), z = Math.sin(d);
  return v3(x, Math.cos(EPS) * y + Math.sin(EPS) * z, -Math.sin(EPS) * y + Math.cos(EPS) * z, o);
}
function dirEq(n) {   // and back: [ra, dec] in degrees
  const ey = -n.z, ez = n.y, y = Math.cos(EPS) * ey - Math.sin(EPS) * ez, z = Math.sin(EPS) * ey + Math.cos(EPS) * ez;
  return [((Math.atan2(y, n.x) / RAD) % 360 + 360) % 360, Math.asin(clamp(z, -1, 1)) / RAD];
}
{ const [ra, dec] = dirEq(eqDir(269.4463, 4.7671)); console.assert(Math.abs(ra - 269.4463) < 1e-9 && Math.abs(dec - 4.7671) < 1e-9, 'sky direction round trip failed', ra, dec); }

// ---------- GLSL shared by the photos and the sky behind them ----------
// skyColor: the SPHEREx all-sky picture looked up by direction (intro.js). paint: that, through deco: the map's grid and dotted
// ecliptic, the outline of the photo under the pointer, and the chosen photo: outlined, the rest of the sky dimmed, and
// an orange ring 12 arcmin across on the spot the time-lapse opens.
const SKY_GLSL = `uniform sampler2D uSky; uniform vec3 uSelC, uSelE, uHovC, uHovE, uSpot; uniform float uSel, uBox, uHov;
vec3 skyColor(vec3 d){
  float lon = atan(-d.z, d.x), v = .5 + asin(clamp(d.y, -1., 1.)) / 3.14159265;
  float u = lon / 6.2831853, ua = fract(u), ub = fract(u + .5) - .5;       // two unwrappings, so the seam does not blur
  vec2 dx = vec2(dFdx(ua), dFdx(v)), dy = vec2(dFdy(ua), dFdy(v)), ex = vec2(dFdx(ub), dx.y), ey = vec2(dFdy(ub), dy.y);
  if (dot(ex, ex) + dot(ey, ey) < dot(dx, dx) + dot(dy, dy)) { dx = ex; dy = ey; }
  vec3 c = textureGrad(uSky, vec2(ua, v), dx, dy).rgb;
  c = (c * 1.9 - .5) * 1.05 + .5;                                          // Explore's look: brighter, cool white
  return clamp(c, 0., 1.) * vec3(.84, .92, 1.1);
}
float grid(vec3 n){   // the flat map's grid: a meridian every 60 degrees of RA, a parallel every 30 of Dec
  float ey = -n.z, ez = n.y, y = ${Math.cos(EPS)} * ey - ${Math.sin(EPS)} * ez, z = ${Math.sin(EPS)} * ey + ${Math.cos(EPS)} * ez;
  float lat = asin(clamp(z, -1., 1.)), lon = atan(y, n.x), gy = lat * 57.29578 / 30., ga = lon * 57.29578 / 60., gb = fract(lon / 6.2831853 + .5) * 6.;
  float lx = 1. - min(abs(fract(ga - .5) - .5) / min(fwidth(ga), fwidth(gb)), 1.), ly = 1. - min(abs(fract(gy - .5) - .5) / fwidth(gy), 1.);
  return max(lx * smoothstep(1.4, 1.2, abs(lat)), ly);
}
float boxd(vec3 n, vec3 c, vec3 e){   // 1 on the outline of the photo with centre c and half-edge e, less inside
  float k = dot(n, c); if (k <= .05) return 50.;
  vec3 q = n / k - c; return min(50., max(abs(dot(q, e)), abs(dot(q, cross(c, e)))) / dot(e, e));
}
float edge(float v, float at){ return 1. - smoothstep(.6, 1.6, abs(v - at) / max(fwidth(v), 1e-7)); }
vec3 deco(vec3 col, vec3 n){
  col = mix(col, vec3(1.), grid(n) * .1);
  float ecl = abs(n.y) / fwidth(n.y), dots = step(fract(atan(n.z, n.x) * 150. / 6.2831853), .3);
  col = mix(col, vec3(1.), (1. - smoothstep(.6, 1.4, ecl)) * dots * .5);
  float s = boxd(n, uSelC, uSelE), h = boxd(n, uHovC, uHovE);
  col *= mix(1., s <= 1. ? 1.1 : .4, uBox);
  col = mix(col, vec3(1.), max(edge(s, 1.) * uBox, edge(h, 1.) * uHov * .75));
  return mix(col, vec3(1., .604, .302), edge(length(n - uSpot), .0017453) * uSel);
}
vec3 paint(vec3 n, float bright){ return deco(skyColor(n) * bright, n); }`;
const uCenter = { value: V() }, uNow = { value: 0 };
const skyU = { uSky: { value: skyTex }, uSelC: { value: V(1, 0, 0) }, uSelE: { value: V(0, 0, 1) }, uHovC: { value: V(1, 0, 0) }, uHovE: { value: V(0, 0, 1) }, uSpot: { value: V(1, 0, 0) }, uSel: { value: 0 }, uBox: { value: 0 }, uHov: { value: 0 } };   // uSel: the spot's ring; uBox: its photo's outline (0 where no photo has been taken yet)

// ---------- the photos: one instanced square per real SPHEREx footprint (data/intro/tiles.bin) ----------
const NT = tileBuf.byteLength / 16, tDay = new Float32Array(NT), tC = new Float32Array(NT * 3), tE = new Float32Array(NT * 3);
{
  const dv = new DataView(tileBuf), p = V();
  for (let i = 0; i < NT; i++) {
    const o = 16 * i; tDay[i] = dv.getFloat32(o, true);
    v3(dv.getInt16(o + 4, true), dv.getInt16(o + 6, true), dv.getInt16(o + 8, true), p).divideScalar(32767).toArray(tC, 3 * i);
    v3(dv.getInt16(o + 10, true), dv.getInt16(o + 12, true), dv.getInt16(o + 14, true), p).divideScalar(32767 * 16).toArray(tE, 3 * i);
  }
}
function tileIndex(day) { let lo = 0, hi = NT; while (lo < hi) { const m = (lo + hi) >> 1; tDay[m] <= day ? lo = m + 1 : hi = m; } return lo; }   // photos taken so far
// the newest photo taken by `day` that holds sky direction n (the same test as the shader's boxd), or -1
function tileAt(n, day) {
  for (let i = tileIndex(day) - 1; i >= 0; i--) {
    const cx = tC[3 * i], cy = tC[3 * i + 1], cz = tC[3 * i + 2], k = n.x * cx + n.y * cy + n.z * cz;
    if (k < .99) continue;
    const ex = tE[3 * i], ey = tE[3 * i + 1], ez = tE[3 * i + 2], ee = ex * ex + ey * ey + ez * ez, qx = n.x / k - cx, qy = n.y / k - cy, qz = n.z / k - cz;
    if (Math.abs(qx * ex + qy * ey + qz * ez) > ee) continue;
    if (Math.abs(qx * (cy * ez - cz * ey) + qy * (cz * ex - cx * ez) + qz * (cx * ey - cy * ex)) <= ee) return i;
  }
  return -1;
}
const tileGeo = new THREE.InstancedBufferGeometry();
tileGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3)); tileGeo.setIndex([0, 1, 2, 0, 2, 3]);
tileGeo.setAttribute('iC', new THREE.InstancedBufferAttribute(tC, 3)); tileGeo.setAttribute('iE', new THREE.InstancedBufferAttribute(tE, 3));
tileGeo.setAttribute('iDay', new THREE.InstancedBufferAttribute(tDay, 1)); tileGeo.instanceCount = NT;
// A photo is drawn once it has been taken, and only on the far side of the sphere: the near side is left open to see in.
// Every photo shows the same picture of the sky at the same depth, so where they overlap it does not matter which one
// wins, and the depth test leaves each pixel to be coloured about once however many photos cover it.
const TILE_VS = (r, test) => `attribute vec3 iC, iE; attribute float iDay; uniform vec3 uCenter; uniform float uNow; varying vec3 vDir; varying vec2 vQ; varying float vAge;
  void main(){ vec3 d = iC + position.x * iE + position.y * cross(iC, iE), wp = uCenter + ${r} * d; vDir = d; vQ = position.xy; vAge = uNow - iDay;
    bool on = ${test} && dot(iC, cameraPosition - uCenter - ${r} * iC) < 0.;
    gl_Position = on ? projectionMatrix * viewMatrix * vec4(wp, 1.) : vec4(2., 2., 2., 1.); }`;
const tiles = new THREE.Mesh(tileGeo, new THREE.ShaderMaterial({ uniforms: { ...skyU, uCenter, uNow }, side: THREE.DoubleSide,
  vertexShader: TILE_VS(R_TILE, 'iDay <= uNow'),
  fragmentShader: `${SKY_GLSL} varying vec3 vDir; void main(){ vec3 n = normalize(vDir); gl_FragColor = vec4(paint(n, 1.), 1.); }` }));
// the newest photos keep a thin outline and a faint glow: SPHEREx's scanning strip, as on the flat map
const fresh = new THREE.Mesh(tileGeo, new THREE.ShaderMaterial({ uniforms: { uCenter, uNow }, side: THREE.DoubleSide, transparent: true, depthWrite: false, depthTest: false,
  vertexShader: TILE_VS(R_FRESH, `iDay <= uNow && uNow - iDay < ${FRESH}.`),
  fragmentShader: `varying vec2 vQ; varying float vAge;
    void main(){ float e = max(abs(vQ.x), abs(vQ.y)), w = fwidth(e) * 1.2, line = smoothstep(1. - 2.2 * w, 1. - w, e) * clamp(1.6 - w * 5., 0., 1.);
      float a = max(line * .5, .05) * (1. - vAge / ${FRESH}.); if (a < .004) discard; gl_FragColor = vec4(.92, .95, 1., a); }` }));
tiles.frustumCulled = fresh.frustumCulled = false; tiles.renderOrder = 1; fresh.renderOrder = 3; scene.add(tiles, fresh);

// ---------- the sky not photographed yet (dim), and the near side of the sphere (grid lines on glass) ----------
const ball = new THREE.SphereGeometry(1, 96, 48);
const BALL_VS = `uniform vec3 uCenter; varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * viewMatrix * vec4(uCenter + ${R_SHELL} * position, 1.); }`;
const shell = new THREE.Mesh(ball, new THREE.ShaderMaterial({ uniforms: { ...skyU, uCenter }, side: THREE.BackSide, vertexShader: BALL_VS,
  fragmentShader: `${SKY_GLSL} varying vec3 vDir; void main(){ vec3 n = normalize(vDir); gl_FragColor = vec4(paint(n, .2), 1.); }` }));
const glass = new THREE.Mesh(ball, new THREE.ShaderMaterial({ uniforms: { ...skyU, uCenter }, side: THREE.FrontSide, transparent: true, depthWrite: false, depthTest: false, vertexShader: BALL_VS,
  fragmentShader: `${SKY_GLSL} varying vec3 vDir; void main(){ gl_FragColor = vec4(vec3(1.), grid(normalize(vDir)) * .13); }` }));
shell.frustumCulled = glass.frustumCulled = false; shell.renderOrder = 2; glass.renderOrder = 4; scene.add(shell, glass);

// ---------- the chosen photo, sharp ----------
// The all-sky picture has 11 pixels to a degree, too few for a photo seen close. So when a photo is chosen, the sharp
// SPHEREx sky tiles the flat map's deep zoom uses (HiPS order 3 from IRSA: 70 pixels to a degree, explore-deep.js) are
// laid over the sky around it, each on its own HEALPix cell, and fade in as they arrive. Without them the photo is soft.
const SHARP_O = 3, sharp = new Map();   // "tile number" -> mesh
function sharpen(n) {
  const want = new Set(), [ra, dec] = dirEq(n), c = Math.max(.05, Math.cos(dec * RAD));
  for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {   // the cells within about 9 degrees
    const d = clamp(dec + j * 3, -89.9, 89.9); want.add(radec2tile(SHARP_O, (ra + i * 3 / c) * RAD, d * RAD));
  }
  for (const [k, m] of sharp) if (!want.has(k) && sharp.size > 40) { scene.remove(m); m.geometry.dispose(); m.material.uniforms.uTex.value?.dispose(); m.material.dispose(); sharp.delete(k); }
  for (const k of want) {
    if (sharp.has(k)) continue;
    const G = 16, nside = 1 << SHARP_O, [ix, iy, f] = nest2xyf(SHARP_O, k), P = [], T = [], I = [], p = V();
    for (let b = 0; b <= G; b++) for (let a = 0; a <= G; a++) {
      const [r, d] = xyf2radec((ix + a / G) / nside, (iy + b / G) / nside, f);
      eqDir(r / RAD, d / RAD, p).toArray(P, P.length); T.push(b / G, a / G);   // the tile picture's column runs along iy and its row along ix (explore-deep.js)
    }
    for (let b = 0; b < G; b++) for (let a = 0; a < G; a++) { const q = b * (G + 1) + a; I.push(q, q + 1, q + G + 1, q + 1, q + G + 2, q + G + 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(T, 2)); g.setIndex(I);
    const u = { ...skyU, uCenter, uTex: { value: null }, uIn: { value: 0 } };
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: u, side: THREE.DoubleSide, transparent: true, depthWrite: false, depthTest: false,
      vertexShader: `uniform vec3 uCenter; varying vec3 vDir; varying vec2 vT; void main(){ vDir = position; vT = uv; gl_Position = projectionMatrix * viewMatrix * vec4(uCenter + ${R_SHARP} * position, 1.); }`,
      fragmentShader: `${SKY_GLSL} uniform sampler2D uTex; uniform float uIn; varying vec3 vDir; varying vec2 vT;
        void main(){ vec3 n = normalize(vDir); float g = texture2D(uTex, vT).r;
          vec3 col = clamp(vec3((g * 1.9 - .5) * 1.05 + .5), 0., 1.) * vec3(.84, .92, 1.1);   // the same look as skyColor
          gl_FragColor = vec4(deco(col, n), uIn * uSel); }` }));
    m.frustumCulled = false; m.renderOrder = 2.5; m.visible = false; m.since = 0; sharp.set(k, m); scene.add(m);
    new THREE.TextureLoader().load(tileUrl(SHARP_O, k), t => { t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.anisotropy = 4; u.uTex.value = t; m.visible = true; m.since = performance.now(); dirty = true; }, undefined, () => {});
  }
}

// ---------- Sun, Earth, planets and comets (JPL Horizons, data/intro/scene.json), drawn over the sky ----------
function glowTex(stops) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64); stops.forEach(([o, col]) => r.addColorStop(o, col));
  g.fillStyle = r; g.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const dotTex = glowTex([[0, '#fff'], [.5, '#fff'], [.72, 'rgba(255,255,255,0)'], [1, 'rgba(255,255,255,0)']]);
const sprite = (tex, add) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending })); s.renderOrder = 8; scene.add(s); return s; };
const sun = sprite(glowTex([[0, '#fff'], [.1, '#fff3d6'], [.3, 'rgba(255,180,90,.4)'], [1, 'rgba(255,140,60,0)']]), true);
const earthDot = sprite(glowTex([[0, '#fff'], [.3, '#bcd8ff'], [.6, 'rgba(127,184,255,.35)'], [1, 'rgba(127,184,255,0)']]), true);
const cometHead = sprite(glowTex([[0, '#fff'], [.2, '#ffd2a8'], [.5, 'rgba(255,154,77,.45)'], [1, 'rgba(255,154,77,0)']]), true);
const atlasRing = sprite(glowTex([[0, 'rgba(255,154,77,0)'], [.62, 'rgba(255,154,77,0)'], [.74, '#ff9a4d'], [.86, '#ff9a4d'], [1, 'rgba(255,154,77,0)']]), false);

const earthU = { uSun: { value: V(1, 0, 0) } };
const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.ShaderMaterial({   // the intro's Earth: a lit ball with a grid, far larger than life
  uniforms: earthU, depthTest: false,
  vertexShader: `varying vec3 vN, vP, vO; void main(){ vO = position; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform vec3 uSun; varying vec3 vN, vP, vO;
    void main(){ vec3 n = normalize(vN), v = normalize(cameraPosition - vP), o = normalize(vO);
      float l = dot(n, uSun), day = smoothstep(-.12, .32, l), fr = pow(1. - max(dot(n, v), 0.), 2.6);
      vec3 col = mix(vec3(.004, .008, .02), vec3(.03, .1, .26) * (.3 + .9 * max(l, 0.)), day);
      vec2 g = vec2(atan(o.z, o.x), asin(o.y)) * 57.29578 / 15., fg = abs(fract(g - .5) - .5) / fwidth(g);
      float gl = max((1. - min(fg.x, 1.)) * smoothstep(.97, .9, abs(o.y)), 1. - min(fg.y, 1.));
      col += vec3(.55, .75, 1.) * gl * (.03 + .13 * day) + vec3(.3, .56, 1.) * fr * (.1 + .8 * day);
      gl_FragColor = vec4(col, 1.); }` }));
earth.scale.setScalar(EARTH_R); earth.renderOrder = 7; scene.add(earth);

// orbits and paths: one set of line pieces, cut off where they leave the sphere (it is centred on Earth, which moves)
const pathU = { uCenter };
const paths = (() => {
  const P = [], C = [];
  const line = (pts, col, closed) => { for (let i = 0, n = pts.length / 3; i < n - (closed ? 0 : 1); i++) { const j = (i + 1) % n; v3(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]).toArray(P, P.length); v3(pts[3 * j], pts[3 * j + 1], pts[3 * j + 2]).toArray(P, P.length); C.push(...col, ...col); } };
  for (const p of S.planets) line(p.orbit, [1, 1, 1, p.name === 'Earth' ? .5 : .26], true);
  for (const c of S.comets) line(c.pos, [.5, .72, 1, .22], false);
  line(S.atlas.arc, [1, .604, .302, .8], false);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('aC', new THREE.Float32BufferAttribute(C, 4));
  return new THREE.LineSegments(g, new THREE.ShaderMaterial({ uniforms: pathU, transparent: true, depthWrite: false, depthTest: false,
    vertexShader: `attribute vec4 aC; varying vec4 vC; varying vec3 vP; void main(){ vC = aC; vP = position; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.); }`,
    fragmentShader: `uniform vec3 uCenter; varying vec4 vC; varying vec3 vP; void main(){ if (distance(vP, uCenter) > ${R * .96}) discard; gl_FragColor = vC; }` }));
})();
paths.frustumCulled = false; paths.renderOrder = 5; scene.add(paths);
const periods = { Mercury: 88, Venus: 225, Mars: 687 };
const planets = S.planets.filter(p => periods[p.name]).map(p => ({ name: p.name, n: p.orbit.length / 3, pts: Array.from({ length: p.orbit.length / 3 }, (_, i) => v3(p.orbit[3 * i], p.orbit[3 * i + 1], p.orbit[3 * i + 2])), pos: V() }));
function planetAt(p, day, o) { const f = ((day / periods[p.name]) * 360) % 360, i = Math.floor(f); return o.copy(p.pts[i % p.n]).lerp(p.pts[(i + 1) % p.n], f - i); }   // as intro.js places them
const pointsMat = (size, color, opacity) => new THREE.PointsMaterial({ size, sizeAttenuation: false, color, map: dotTex, transparent: true, depthWrite: false, depthTest: false, opacity });
const dots = (n, mat) => { const p = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(n * 3, 3)), mat); p.frustumCulled = false; p.renderOrder = 6; scene.add(p); return p; };
const planetDots = dots(planets.length, pointsMat(7, 0xffffff, 1)), cometDots = dots(S.comets.length, pointsMat(4.5, 0x7fb8ff, .85));

// thin guide lines, rebuilt each frame: the line of sight to the chosen photo, and the direction comet 3I/ATLAS is seen in
const guides = (() => {
  const max = 8, g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(max * 6, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(max * 8, 4));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, depthTest: false }));
  l.frustumCulled = false; l.renderOrder = 6; scene.add(l);
  let n = 0; const P = g.attributes.position.array, C = g.attributes.color.array;
  return { begin() { n = 0; }, seg(a, b, col, ia, ib = ia) { a.toArray(P, 6 * n); b.toArray(P, 6 * n + 3); C.set([...col, ia, ...col, ib], 8 * n); n++; },
    end() { g.setDrawRange(0, 2 * n); g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = true; } };
})();

// ---------- names ----------
const labels = [];
function label(text, pos, cls = '') { const el = document.createElement('div'); el.className = 'lbl ' + cls; el.textContent = text; $('x3d-labels').append(el); labels.push({ el, pos }); }
const E = V(), atlasPos = V(), atlasDir = V(), atlasSky = V();   // Earth; comet 3I/ATLAS, its direction from Earth and where that meets the sky
let atlasIn = false, atlasSeen = false;
label('Sun', o => o.set(0, 0, 0));
label('Earth', o => o.copy(E));
label('3I/ATLAS', o => (atlasIn ? o.copy(atlasPos) : atlasSeen ? o.copy(atlasSky) : null), 'accent');

// ---------- the camera ----------
// st.mode: 'overview', 'flying' or 'photo'. Overview: az, el and zoom (1 = the whole sphere in view) about Earth, eased
// towards azT, elT and zoomT. Photo: on the line of sight st.spot, close enough that its photo (st.tile, half-width st.half)
// fills part of the view, turned by yaw and pitch. st.sel runs 0 to 1 as the chosen photo's outline and ring come up.
const st = { mode: 'overview', az: -.7, el: .3, zoom: 1, azT: -.7, elT: .3, zoomT: 1, spot: null, tile: -1, half: .0305, yaw: 0, pitch: 0, fly: null, sel: 0 };
let W = 1, H = 1, VFOV = 40, area = { t: 0, b: 1 }, dirty = true;
const ZOOM_MIN = .08;
function layout() {
  W = innerWidth; H = innerHeight; VFOV = W < H ? 50 : 40;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.setSize(W, H, false);
  // the room the sky has: under the header, above the timeline (desktop) or the switch's row (phone), and above the photo's card on a phone
  const t = document.querySelector('.topbar').getBoundingClientRect().bottom + 34;   // the hint's line
  let b = phone.matches ? document.querySelector('.viewsw').getBoundingClientRect().top - 12 : $('tl-line').getBoundingClientRect().top - 56;
  if (phone.matches && !card.hidden) b = card.getBoundingClientRect().top - 12;
  area = { t, b: Math.max(t + 120, b) };
  dirty = true;
}
const tanH = () => Math.tan(VFOV / 2 * RAD), room = () => Math.min(W, area.b - area.t), shiftNow = () => H / 2 - (area.t + area.b) / 2;
const lookM = new THREE.Matrix4(), tmp = V(), tmp2 = V(), tmp3 = V();
const lookQ = (from, to, up, q = new THREE.Quaternion()) => q.setFromRotationMatrix(lookM.lookAt(from, to, up));
function overviewPose() {   // { rel: camera - Earth, q, shift }
  const fit = R * 1.02 / Math.sin(Math.atan(.46 * room() * tanH() / (H / 2))), d = fit * st.zoom;
  const rel = V(-Math.cos(st.el) * Math.cos(st.az), Math.sin(st.el), -Math.cos(st.el) * Math.sin(st.az)).multiplyScalar(d);
  return { rel, q: lookQ(rel, tmp.set(0, 0, 0), Y), shift: shiftNow() };
}
function photoPose() {   // the photo is (phone: 60%, desktop: 40%) of the room across
  const D = R_WALL * st.half * (H / 2) / ((phone.matches ? .3 : .2) * room() * tanH()), d = st.spot;
  const q = lookQ(tmp.set(0, 0, 0), d, Math.abs(d.dot(N)) > .999 ? F : N);
  if (st.yaw || st.pitch) q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(st.pitch, st.yaw, 0, 'YXZ')));
  return { rel: d.clone().multiplyScalar(Math.max(NEAR_EARTH, R_WALL - D)), q, shift: shiftNow() };
}
function setCam(P) {
  camera.position.copy(E).add(P.rel); camera.quaternion.copy(P.q);
  camera.fov = VFOV; camera.aspect = W / H; camera.near = clamp(P.rel.length() * .02, .004, 1); camera.far = 80;
  camera.setViewOffset(W, H, 0, P.shift, W, H); camera.updateMatrixWorld();
}
const poseNow = () => (st.mode === 'photo' ? photoPose() : overviewPose());

// a flight: to a photo by way of Earth (in to NEAR_EARTH along a turning path, then straight out along the line of sight), or back out to the overview
const T_IN = 1.5, T_OUT = 1.3, T_BACK = 1.1;
function flightPose(f, s) {
  const to = f.to === 'photo' ? photoPose() : overviewPose(), r0 = f.rel.length(), d0 = tmp2.copy(f.rel).divideScalar(r0);
  const swing = (toDir, r1, k) => tmp3.copy(d0).applyQuaternion(new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(d0, toDir), k)).multiplyScalar(r0 ** (1 - k) * r1 ** k).clone();
  if (f.to === 'overview') { const k = sm(s / T_BACK), r1 = to.rel.length(); st.sel = 1 - k; return { rel: swing(tmp.copy(to.rel).divideScalar(r1), r1, k), q: f.q.clone().slerp(to.q, k), shift: f.shift + (to.shift - f.shift) * k }; }
  const k = sm(s / T_IN), k2 = sm((s - T_IN) / T_OUT), shift = f.shift + (to.shift - f.shift) * sm(s / (T_IN + T_OUT));
  st.sel = k2;
  if (s < T_IN) return { rel: swing(st.spot, NEAR_EARTH, k), q: f.q.clone().slerp(to.q, k), shift };
  return { rel: st.spot.clone().multiplyScalar(NEAR_EARTH + (to.rel.length() - NEAR_EARTH) * k2), q: to.q, shift };
}
function land(mode) { st.fly = null; st.mode = mode; st.sel = mode === 'photo' ? 1 : 0; card.classList.toggle('in', mode === 'photo'); if (mode === 'overview') { card.hidden = true; st.spot = null; layout(); } words(); setCam(poseNow()); dirty = true; }   // the camera again: hiding the card changed the room

// a sky direction chosen: fill the card, then fly (or cut) to its photo
const f2 = x => (Math.abs(x) + 1e-9).toFixed(2);   // as the flat map's pin writes them
function choose(n) {
  if (!n) return;   // a click in mid-flight starts the new flight from where the camera is
  if (st.mode === 'overview') setCam(poseNow());   // the flight starts from here, whatever the card does to the room
  const shift0 = st.fly ? camera.view?.offsetY ?? shiftNow() : shiftNow();
  const from = { rel: camera.position.clone().sub(E), q: camera.quaternion.clone(), shift: shift0 };
  st.spot = n.clone(); describe();
  st.half = st.tile < 0 ? .0305 : Math.hypot(tE[3 * st.tile], tE[3 * st.tile + 1], tE[3 * st.tile + 2]);   // the photo's size sets how close the camera comes
  skyU.uSpot.value.copy(n); sharpen(n);
  card.classList.remove('in'); card.hidden = false; layout();
  st.yaw = st.pitch = 0; skyU.uHov.value = 0; canvas.classList.remove('x3d-pick');
  if (calm.matches) return land('photo');
  st.fly = { to: 'photo', t0: null, ...from }; st.mode = 'flying'; words(); dirty = true;
}
// the chosen spot on the timeline's day: the newest photo that holds it (its outline and date), and the time-lapse's address
function describe() {
  const n = st.spot, i = st.tile = tileAt(n, +slider.value + 1), [ra, dec] = dirEq(n);
  st.where = { ra, dec, day: i < 0 ? null : tDay[i] };
  if (i >= 0) { skyU.uSelC.value.fromArray(tC, 3 * i); skyU.uSelE.value.fromArray(tE, 3 * i); }
  $('x3d-what').textContent = i < 0 ? 'Patch of sky' : 'SPHEREx photo';
  $('x3d-when').textContent = i < 0 ? 'Not photographed yet' : dayDate(tDay[i], { day: 'numeric', month: 'short', year: 'numeric' });
  $('x3d-where').textContent = `RA ${f2(ra)}° Dec ${dec < 0 ? '-' : '+'}${f2(dec)}°`;
  $('x3d-open').href = patchUrl(ra, dec);
  dirty = true;
}
function back() {
  if (st.mode !== 'photo') return;
  card.classList.remove('in');
  if (calm.matches) return land('overview');
  st.fly = { to: 'overview', t0: null, rel: camera.position.clone().sub(E), q: camera.quaternion.clone(), shift: shiftNow() };
  st.yaw = st.pitch = 0; st.mode = 'flying'; skyU.uHov.value = 0; canvas.classList.remove('x3d-pick'); words(); dirty = true;
}
$('x3d-back').onclick = () => { back(); canvas.focus({ preventScroll: true }); };
function words() { hint.textContent = phone.matches ? 'Drag to turn. Tap a photo.' : 'Drag to turn. Click a photo.'; hint.style.opacity = st.mode === 'overview' ? 1 : 0; }

// ---------- sky under a window point, and back ----------
function skyAt(px, py) {   // unit direction from Earth, or null off the sphere
  if (!st.fly) setCam(poseNow());
  const dir = tmp.set(px / W * 2 - 1, 1 - py / H * 2, .5).unproject(camera).sub(camera.position).normalize(), o = tmp2.copy(camera.position).sub(E);
  const b = o.dot(dir), disc = b * b - o.lengthSq() + R_WALL * R_WALL;
  if (disc < 0) return null;
  const t = -b + Math.sqrt(disc);   // the far side: where the line of sight leaves the sphere
  return t > 0 ? o.addScaledVector(dir, t).divideScalar(R_WALL).clone() : null;
}
function toScreen(n) {   // window point of a sky direction, or null when it is on the open near side or off the screen
  if (!st.fly) setCam(poseNow());
  const p = tmp.copy(n).multiplyScalar(R_WALL).add(E);
  if (n.dot(tmp2.copy(camera.position).sub(p)) >= 0) return null;
  p.project(camera);
  return p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 ? [(p.x + 1) / 2 * W, (1 - p.y) / 2 * H] : null;
}

// ---------- one frame ----------
function render() {
  const day = lastDay;
  uCenter.value.copy(E); uNow.value = day + 1;   // the whole of the timeline's day
  skyU.uSel.value = st.sel; skyU.uBox.value = st.tile < 0 ? 0 : st.sel;
  const s = tmp.copy(E).normalize().negate(); earthU.uSun.value.copy(s); earth.position.copy(E);
  const px = camera.position.distanceTo(E) * tanH() * 2 / H;   // world size of one CSS pixel at Earth's distance
  sun.scale.setScalar(Math.max(.1, px * 90));
  earthDot.position.copy(E); earthDot.scale.setScalar(px * 26); earthDot.material.opacity = clamp(1.6 - EARTH_R / px / 9, 0, 1);   // the glow gives way to the ball up close
  const inside = p => p.distanceTo(E) < R * .96;
  planets.forEach((q, i) => { planetAt(q, day, q.pos); (inside(q.pos) ? q.pos : E).toArray(planetDots.geometry.attributes.position.array, 3 * i); });
  S.comets.forEach((c, i) => { seriesAt(c.pos, day, tmp); (inside(tmp) ? tmp : E).toArray(cometDots.geometry.attributes.position.array, 3 * i); });
  planetDots.geometry.attributes.position.needsUpdate = cometDots.geometry.attributes.position.needsUpdate = true;
  // comet 3I/ATLAS: where it is, and where that is on the sky
  seriesAt(S.atlas.pos, day, atlasPos); atlasDir.copy(atlasPos).sub(E).normalize(); atlasSky.copy(atlasDir).multiplyScalar(R_FRESH).add(E);
  atlasIn = inside(atlasPos); atlasSeen = atlasDir.dot(tmp.copy(camera.position).sub(atlasSky)) < 0;
  cometHead.visible = atlasIn; cometHead.position.copy(atlasPos); cometHead.scale.setScalar(px * 30);
  atlasRing.visible = atlasSeen; atlasRing.position.copy(atlasSky); atlasRing.scale.setScalar(camera.position.distanceTo(atlasSky) * tanH() * 2 / H * 22);
  guides.begin();
  if (atlasSeen) guides.seg(E, atlasSky, [1, .604, .302], .5, .2);
  if (st.spot && st.sel < 1) guides.seg(E, tmp.copy(st.spot).multiplyScalar(R_FRESH).add(E), [1, 1, 1], .8 * (1 - st.sel));
  guides.end();
  for (const m of sharp.values()) if (m.visible && m.material.uniforms.uIn.value < 1) { m.material.uniforms.uIn.value = calm.matches ? 1 : clamp((performance.now() - m.since) / 400, 0, 1); dirty = true; }
  renderer.render(scene, camera);
  for (const L of labels) {
    let vis = L.pos(tmp);
    if (vis) { tmp.project(camera); vis = tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05; }
    L.el.style.opacity = vis ? 1 : 0;
    if (vis) L.el.style.transform = `translate(${((tmp.x + 1) / 2 * W + 10).toFixed(1)}px,${((1 - tmp.y) / 2 * H - 5).toFixed(1)}px)`;
  }
}
const perf = { frames: [] };
let raf = 0, lastTs = 0, lastDrawn = false, lastDay = -1;
// the timeline moved: Earth's place first (every camera pose is worked out from it), then the chosen spot's photo, which
// may not have been taken yet on the new day
function onDay() {
  lastDay = +slider.value; seriesAt(S.earth, lastDay, E); dirty = true;
  if (st.spot && st.mode !== 'overview' && tileAt(st.spot, lastDay + 1) !== st.tile) describe();
}
function tick(ts) {
  raf = requestAnimationFrame(tick);
  const dt = Math.min(100, ts - lastTs), f = st.fly;
  if (+slider.value !== lastDay) onDay();
  if (f) {
    f.t0 ??= ts; const s = (ts - f.t0) / 1000, end = f.to === 'photo' ? T_IN + T_OUT : T_BACK;
    setCam(flightPose(f, Math.min(s, end))); dirty = true;
    if (s >= end) land(f.to === 'photo' ? 'photo' : 'overview');
  } else {
    const k = calm.matches ? 1 : 1 - Math.exp(-dt / 70);   // turns and zooms ease in
    for (const [a, b] of [['az', 'azT'], ['el', 'elT'], ['zoom', 'zoomT']]) if (st[a] !== st[b]) { st[a] = Math.abs(st[b] - st[a]) < 1e-4 ? st[b] : st[a] + (st[b] - st[a]) * k; dirty = true; }
    if (dirty) setCam(poseNow());
  }
  if (dirty) { dirty = false; render(); if (lastDrawn) perf.frames.push(ts - lastTs); lastDrawn = true; api.ready = true; } else lastDrawn = false;
  lastTs = ts;
}

// ---------- pointer, wheel and keys ----------
const turn = (dx, dy, now) => {   // by window pixels: the sky follows the pointer
  if (st.mode === 'overview') {
    const k = Math.PI / room() * Math.min(1, .25 + st.zoom);
    st.azT += dx * k; st.elT = clamp(st.elT + dy * k, -1.45, 1.45);
    if (now) { st.az = st.azT; st.el = st.elT; }
  } else if (st.mode === 'photo') { const k = 2 * tanH() / H; st.yaw = clamp(st.yaw + dx * k, -1, 1); st.pitch = clamp(st.pitch + dy * k, -1, 1); }
  dirty = true;
};
// Zooming in further than 3D goes (at the overview's closest, or at a photo) hands over to the flat map at the same sky
// position: it has the sharp tiles for a deep zoom. A scroll, pinch or + has to keep asking for a moment (push) first.
let push = 0, pushT = 0;
function handOff() {
  const n = skyAt(W / 2, (area.t + area.b) / 2) ?? (st.mode === 'photo' ? st.spot : null);
  push = 0; if (!n || !deepAt || st.mode === 'flying') return;
  const [ra, dec] = dirEq(n); leave(); deepAt(ra, dec);
}
function deeper(f) { push -= Math.log(f); clearTimeout(pushT); pushT = setTimeout(() => { push = 0; }, 700); if (push > .6) handOff(); }
$('x3d-deep').onclick = handOff;
const zoomBy = f => {
  if (f < 1 && (st.mode === 'photo' || (st.mode === 'overview' && st.zoomT <= ZOOM_MIN * 1.001))) return deeper(f);
  if (st.mode === 'overview') { st.zoomT = clamp(st.zoomT * f, ZOOM_MIN, 1); dirty = true; }
};
const pts = new Map(); let press = null;
const spread = () => { const [a, b] = [...pts.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
canvas.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button) return;
  pts.set(e.pointerId, [e.clientX, e.clientY]); canvas.setPointerCapture(e.pointerId);
  press = pts.size === 1 ? { moved: 0, drag: false, touch: e.pointerType !== 'mouse' } : { ...press, drag: true, d: spread() };
});
canvas.addEventListener('pointermove', e => {
  const p = pts.get(e.pointerId);
  if (!p) { if (e.pointerType === 'mouse') hover(e.clientX, e.clientY); return; }
  const dx = e.clientX - p[0], dy = e.clientY - p[1]; pts.set(e.pointerId, [e.clientX, e.clientY]);
  if (pts.size === 2) { const d = spread(); if (press.d) zoomBy(press.d / d); press.d = d; return; }
  press.moved += Math.hypot(dx, dy);
  if (!press.drag) { if (press.moved < (press.touch ? 8 : 5)) return; press.drag = true; canvas.classList.add('x3d-drag'); skyU.uHov.value = 0; }
  turn(dx, dy, true);
});
const lift = e => {
  if (!pts.delete(e.pointerId)) return;
  if (pts.size) return;
  canvas.classList.remove('x3d-drag');
  if (press && e.type === 'pointerup' && !press.drag) choose(skyAt(e.clientX, e.clientY));
  press = null;
};
canvas.addEventListener('pointerup', lift); canvas.addEventListener('pointercancel', lift);
canvas.addEventListener('pointerleave', () => { if (skyU.uHov.value) { skyU.uHov.value = 0; dirty = true; } canvas.classList.remove('x3d-pick'); });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
  zoomBy(Math.exp(clamp(dy, -300, 300) * (e.ctrlKey ? .01 : .002)));
}, { passive: false });
let hovered = -2;
function hover(px, py) {   // the photo under the pointer gets its outline
  if (st.mode === 'flying') return;
  const n = skyAt(px, py), i = n ? tileAt(n, +slider.value + 1) : -1;
  canvas.classList.toggle('x3d-pick', !!n);
  if (i === hovered && skyU.uHov.value === +(i >= 0)) return;
  hovered = i; skyU.uHov.value = +(i >= 0);
  if (i >= 0) { skyU.uHovC.value.fromArray(tC, 3 * i); skyU.uHovE.value.fromArray(tE, 3 * i); }
  dirty = true;
}
function key(k) {
  const a = Math.PI / 12, step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[k];
  if (step && st.mode === 'overview') { st.azT += step[0] * a; st.elT = clamp(st.elT + step[1] * a, -1.45, 1.45); dirty = true; }
  else if (step) turn(step[0] * 40, step[1] * 40);
  else if (k === '+' || k === '=') zoomBy(1 / 1.4);
  else if (k === '-' || k === '_') zoomBy(1.4);
  else if (k === '0') { if (st.mode === 'photo') back(); else { st.zoomT = 1; dirty = true; } }
  else if (k === 'Enter' || k === ' ') choose(skyAt(W / 2, (area.t + area.b) / 2));
}
addEventListener('resize', () => { if (page.dataset.view === '3d') layout(); });
phone.addEventListener('change', () => { if (page.dataset.view === '3d') { layout(); words(); } });

// for the checks (web/tests/explore_3d_ui.py)
const api = window.__x3d = {
  ready: false, perf, get state() { return st.mode; }, get reduced() { return calm.matches; },
  get spot() { return st.where && st.spot ? { ...st.where } : null; },
  toScreen: (ra, dec) => toScreen(eqDir(ra, dec)), skyAt: (x, y) => { const n = skyAt(x, y); return n && dirEq(n); },
  pose() { if (!st.fly) setCam(poseNow()); return { cam: camera.position.toArray(), earth: E.toArray(), look: camera.getWorldDirection(V()).toArray(), R: R_WALL }; },
};
$('x3d-loading').remove();
return {
  key,
  goTo(ra, dec) { choose(eqDir(ra, dec)); },
  start() { onDay(); layout(); words(); lastDrawn = false; dirty = true; cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); },
  stop() { cancelAnimationFrame(raf); lastDrawn = false; pts.clear(); press = null; },
};
}
