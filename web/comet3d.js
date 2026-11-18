// The comet page's Depth view (comet.js): the comet's SPHEREx photos played in 3D, at real scale from JPL Horizons
// (heliocentric ecliptic J2000, AU). Earth with SPHEREx travels along Earth's path (web/data/planets.json) to each
// photo's time and the comet along its baked path (detail.facts.path, with each visit's exact position at its photo,
// inv.visits[k].xyz); on arrival that photo's sight line and frame light up on "the sky", earlier ones stay faint, later
// ones are hidden. A timeline (one dot a visit; the knob plays, scrubs and steps) and a strip of the photos under the
// box follow the same state. The approved mockup: phase3-mockups/comet-live (scene.js), built here on the app's data.
// The stage, SPHEREx, the drag and zoom come from the time-lapse's Depth view (live/depth.js).
import * as THREE from 'three';
import { stage, spherex, controls } from './live/depth.js';

const TAU = Math.PI * 2, MJD_JD = 2400000.5, V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp01 = x => Math.max(0, Math.min(1, x)), sm = x => { x = clamp01(x); return x * x * (3 - 2 * x); };
const WHITE = [1, 1, 1], ACCENT = [1, .604, .302], BLUE = [.5, .72, 1], Y = V(0, 1, 0);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const utc = jd => new Date((jd - 2440587.5) * 864e5);
const dateOf = jd => { const d = utc(jd); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const KNOB = '<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 5.5v13L6 12z"/></svg><svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="6" width="3.6" height="12" rx="1"/><rect x="13.4" y="6" width="3.6" height="12" rx="1"/></svg>';

// rows [[jd, x, y, z], ...] at jd: linear between the two rows around it (comet.js at()); clamped at the ends
export function lerpRows(rows, jd) {
  if (jd <= rows[0][0]) return rows[0].slice(1);
  if (jd >= rows.at(-1)[0]) return rows.at(-1).slice(1);
  let lo = 0, hi = rows.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m][0] <= jd) lo = m; else hi = m; }
  const a = rows[lo], b = rows[hi], t = (jd - a[0]) / (b[0] - a[0]);
  return [1, 2, 3].map(i => a[i] + t * (b[i] - a[i]));
}

// opts: { box (the scene's box, #c-scene), after (where the timeline and strip go), zoomBox, name, path (rows), earth
// (planets.json rows), visits: [{ jd, xyz, img, span, short, lam }], fmt (au -> words), photoTab, depthTab }
export function comet3d(opts) {
  const { box, after, zoomBox, name, earth: EARTH, fmt } = opts;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const VIS = opts.visits, N = VIS.length;
  // the comet: the baked path with each photo's exact position merged in, so at a photo's time it sits on that position
  const ROWS = [...opts.path, ...VIS.filter(v => v.xyz).map(v => [v.jd, ...v.xyz])].sort((a, b) => a[0] - b[0]);
  const v3 = ([x, y, z]) => V(x, z, -y);   // the ecliptic lies flat, north up
  const earthAt = jd => v3(lerpRows(EARTH, jd)), cometAt = jd => v3(lerpRows(ROWS, jd));

  // ---------------------------------------------------------------- the markup
  box.replaceChildren();
  const solar = document.createElement('div'); solar.className = 'xp-d3 p3-solar';
  solar.innerHTML = `<canvas tabindex="0" aria-label="3D view: the Sun, Earth with SPHEREx, the comet on its path, and the sight line of each SPHEREx photo. Drag or use the arrow keys to turn it."></canvas><div class="xp-d3-lbl" aria-hidden="true"></div><p class="p3-miss" role="status" hidden></p>`;
  box.append(solar);
  const pics = VIS.some(v => v.img);   // no picture at all: the scene alone, no timeline or strip
  const play_ = document.createElement('div'); play_.className = 'p3-play'; play_.hidden = !pics;
  play_.innerHTML = `<div class="tl-line">${'<i class="tl-visit"></i>'.repeat(N)}<output class="tl-date"></output><button class="tl-knob" type="button" role="slider" aria-label="Photo. Press to play the photos in turn; drag or use the arrow keys to move." aria-valuemin="0" aria-valuemax="${N - 1}" aria-valuenow="0">${KNOB}</button></div><div class="p3-strip"></div>`;
  const stripEl = play_.querySelector('.p3-strip');
  for (const v of VIS) {
    const f = document.createElement('figure'); f.title = `${v.span}${v.lam ? `, ${v.lam.toFixed(2)} µm` : ''}`;
    const im = document.createElement('img'); im.alt = `${name}, ${v.span}`; if (v.img) im.src = v.img;
    const c = document.createElement('figcaption'); c.textContent = v.short;
    f.append(im, c); stripEl.append(f);
  }
  after.after(play_);
  const figs = [...stripEl.children], imgs = figs.map(f => f.querySelector('img'));
  const FAIL = new Set();
  const loaded = Promise.all(imgs.map((im, k) => (VIS[k].img ? im.decode().catch(() => FAIL.add(k)) : (FAIL.add(k), null))));

  // ---------------------------------------------------------------- the stage (live/depth.js stage())
  const S = stage(solar), { scene, camera, renderer } = S, layer = solar.querySelector('.xp-d3-lbl'), cv = solar.querySelector('canvas');
  const Z = { k: 1, x: 0, y: 0 }, yaw = { a: 0, p: 0 };
  let keep = [];   // the controls over the scene (the tabs, the zoom buttons): names keep clear of them
  const placed = [];
  function label(text, cls = '') {
    const el = document.createElement('div'); el.className = 'lbl ' + cls; el.textContent = text; layer.append(el);
    const tmp = V();
    return { el, at(p, [dx, dy, ax, ay] = [10, -5, 0, 0], a = 1, yield_ = false) {
      tmp.copy(p).project(camera); el.dataset.at = '';
      if (a < .01 || tmp.z > 1) { el.style.opacity = 0; return; }
      const px = (tmp.x + 1) / 2 * S.W, py = (1 - tmp.y) / 2 * S.H;
      const w = el.offsetWidth, h = el.offsetHeight, x = px + dx + ax * w, y = py + dy + ay * h;
      const hit = ([x0, y0, x1, y1], g = 0) => x < x1 + g && x + w + g > x0 && y < y1 && y + h > y0;
      // past the view's edges or under a control: not shown; a date or the sky's name gives way to the other names
      if (x < 1 || y < 1 || x + w > S.W - 1 || y + h > S.H - 1 || keep.some(b => hit(b, 2)) || (yield_ && placed.some(b => hit(b, 4)))) { el.style.opacity = 0; return; }
      placed.push([x, y, x + w, y + h]); el.style.opacity = a.toFixed(3); el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      el.dataset.at = `${px.toFixed(1)},${py.toFixed(1)}`;   // what it names (tests: it sits there)
    } };
  }
  function glowTex(stops) { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 0, 64, 64, 64); stops.forEach(([o, col]) => r.addColorStop(o, col)); g.fillStyle = r; g.fillRect(0, 0, 128, 128); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; }
  const sprite = (tex, add, order = 6) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending })); s.renderOrder = order; scene.add(s); return s; };

  // ---------------------------------------------------------------- the solar system
  // "the sky": an arc standing in for the stars far beyond this scale, 1.15 times the comet's largest distance from the
  // Sun at a photo (at least 4.4 AU), so every sight line reaches it past the comet. Each photo sits where its line meets it.
  const SKY = Math.max(4.4, 1.15 * Math.max(...VIS.map(v => cometAt(v.jd).length()))), TILE = .62 * SKY / 6.4;
  function shot(E, Cm) {
    const d = Cm.clone().sub(E).normalize(), b = E.dot(d), t = -b + Math.sqrt(b * b - E.lengthSq() + SKY * SKY), c = E.clone().addScaledVector(d, t);
    const r = V().crossVectors(d, Y).normalize(), u = V().crossVectors(r, d);
    return { E, Cm, d, c, r, u, corners: [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, k]) => c.clone().addScaledVector(r, a * TILE).addScaledVector(u, k * TILE)) };
  }
  const shots = VIS.map((v, k) => {
    const s = { ...shot(earthAt(v.jd), cometAt(v.jd)), jd: v.jd, k };
    s.tile = new THREE.Mesh(new THREE.PlaneGeometry(2 * TILE, 2 * TILE), new THREE.MeshBasicMaterial({ color: 0x16191f, transparent: true, side: THREE.DoubleSide, depthTest: false }));
    s.tile.position.copy(s.c); s.tile.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(s.r, s.u, s.d.clone().negate())); s.tile.renderOrder = 4; scene.add(s.tile);
    return s;
  });
  loaded.then(() => {   // each photo on its frame once it has loaded; one that did not stays a dark frame
    shots.forEach((s, k) => {
      if (FAIL.has(k)) return;
      const t = new THREE.Texture(imgs[k]); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
      Object.assign(s.tile.material, { map: t, color: new THREE.Color(1.5, 1.5, 1.5) }); s.tile.material.needsUpdate = true;
    });
    ok.splice(0, N, ...VIS.map((_, k) => k).filter(k => !FAIL.has(k)));
    if (!ok.length) ok.push(0);
    dots.forEach((d, k) => d.classList.toggle('miss', FAIL.has(k)));
    paint(); kick();
  });
  const sunDot = sprite(glowTex([[0, '#fff'], [.1, '#fff3d6'], [.3, 'rgba(255,180,90,.4)'], [1, 'rgba(255,140,60,0)']]), true);
  const earthDot = sprite(glowTex([[0, '#fff'], [.3, '#bcd8ff'], [.6, 'rgba(127,184,255,.35)'], [1, 'rgba(127,184,255,0)']]), true);
  const head = sprite(glowTex([[0, '#fff'], [.2, '#ffd2a8'], [.5, 'rgba(255,154,77,.45)'], [1, 'rgba(255,154,77,0)']]), true, 9);
  const ring = sprite((() => { const c = document.createElement('canvas'); c.width = c.height = 96; const g = c.getContext('2d'); g.strokeStyle = '#ff9a4d'; g.lineWidth = 5; g.beginPath(); g.arc(48, 48, 40, 0, TAU); g.stroke(); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })(), false, 8);
  const tail = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(.5, 0, 0), new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, map: (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64; const g = c.getContext('2d'), im = g.createImageData(256, 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 256; x++) { const u = x / 255, w = .12 + .88 * u, d = Math.abs(y - 31.5) / 32 / w, a = Math.max(0, 1 - d * d) * (1 - u) ** 1.6; im.data.set([255, 170, 100, 255 * a], 4 * (y * 256 + x)); }
    g.putImageData(im, 0, 0); return new THREE.CanvasTexture(c); })() }));
  tail.renderOrder = 8; scene.add(tail);
  const craft = spherex(), CR = .16 * SKY / 6.4; craft.scale.setScalar(CR); scene.add(craft);
  const light = new THREE.DirectionalLight(0xfff4e2, 3.2); scene.add(light, light.target, new THREE.HemisphereLight(0x8fb4ff, 0x0a1020, .9));
  const beam = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(15, 3)).setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]),
    new THREE.MeshBasicMaterial({ color: 0xbfd6ff, transparent: true, opacity: .05, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  beam.frustumCulled = false; beam.renderOrder = 5; scene.add(beam);
  const setBeam = (top, corners) => { const bp = beam.geometry.attributes.position; top.toArray(bp.array, 0); corners.forEach((c, k) => c.toArray(bp.array, 3 + 3 * k)); bp.needsUpdate = true; };
  const guides = S.lines(2400);
  const dotTex = glowTex([[0, '#fff'], [.5, '#fff'], [.72, 'rgba(255,255,255,0)'], [1, 'rgba(255,255,255,0)']]);
  // the comet's path as a dotted trail, a dot every 2 days (the mockup's daily Horizons rows, every second one)
  const pathPts = [];
  for (let jd = ROWS[0][0]; jd <= ROWS.at(-1)[0]; jd += 2) { const p = cometAt(jd); if (p.length() < SKY * .95) pathPts.push(p); }
  const trail = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pathPts), new THREE.PointsMaterial({ size: 3.2, sizeAttenuation: false, color: 0xff9a4d, map: dotTex, transparent: true, opacity: .75, depthTest: false }));
  trail.renderOrder = 5; trail.frustumCulled = false; scene.add(trail);
  // Earth's path: a lap round the visits' middle, and all of it between the first and last photo
  const J0 = VIS[0].jd, J1 = VIS.at(-1).jd, mid = (J0 + J1) / 2;
  const orbit = EARTH.filter(r => (r[0] >= mid - 183 && r[0] <= mid + 183) || (r[0] >= J0 - 2 && r[0] <= J1 + 2)).map(r => v3(r.slice(1)));
  const lSun = label('Sun'), lEarth = label('Earth · SPHEREx'), lComet = label(name, 'accent'), lDist = label('', 'dist'), lPhoto = label('the photo');
  const ang = v => Math.atan2(v.z, v.x);
  let SK0 = ang(shots[0].c), SK1 = SK0 + ((ang(shots[N - 1].c) - SK0 + 3 * Math.PI) % TAU - Math.PI);
  if (Math.abs(SK1 - SK0) < 1) { const m = (SK0 + SK1) / 2, h = (SK1 >= SK0 ? .5 : -.5); SK0 = m - h; SK1 = m + h; }   // a short run of photos: a stretch of sky either side
  const lSky = label('the sky · stars are far beyond this scale', 'mark');
  const lDates = shots.map(s => label(MON[utc(s.jd).getUTCMonth()], 'mark'));

  // ---------------------------------------------------------------- playback
  // i: the visit selected (strip, timeline dot). jd: the moment the scene shows. A step glides jd to the next visit's
  // photo time (0.5 s for days apart, about 2.1 s for months), then that photo lights up and holds for the dwell.
  const st = { i: 0, jd: J0, from: J0, to: J0, t0: -9, dur: 0, arrived: 0, playing: false, next: 0, view: 'depth', opened: 0 };
  const ok = VIS.map((_, k) => k);   // the visits with a picture (play steps through these)
  const DWELL = 1.8, glideFor = d => (REDUCED ? 0 : Math.min(2.1, .5 + 1.6 * Math.sqrt(Math.abs(d) / 240)));
  const clock = () => performance.now() / 1000;
  function go(k, { glide = true, jd = null } = {}) {
    const now = clock(); st.i = k; st.from = st.jd; st.to = jd ?? VIS[k].jd;
    st.dur = glide ? glideFor(st.to - st.from) : 0; st.t0 = st.dur > 0 ? now : -9; if (!st.dur) st.jd = st.to;
    st.arrived = st.dur > 0 ? now + st.dur : now; paint(); kick();
  }
  const nextOk = k => ok.find(x => x > k) ?? ok[0];
  function play(on) { st.playing = on && ok.length > 1; st.next = clock() + .2; knob.classList.toggle('on', st.playing); kick(); }
  function step() { const k = nextOk(st.i); go(k); st.next = st.arrived + (k === ok.at(-1) ? DWELL * 1.5 : DWELL); }

  const xOf = jd => (J1 > J0 ? 4 + 92 * (jd - J0) / (J1 - J0) : 50);
  const line = play_.querySelector('.tl-line'), date = play_.querySelector('.tl-date'), knob = play_.querySelector('.tl-knob');
  const dots = [...play_.querySelectorAll('.tl-visit')];
  dots.forEach((d, k) => { d.style.left = `${xOf(VIS[k].jd)}%`; });
  const miss = solar.querySelector('.p3-miss');
  function paint() {
    figs.forEach((f, k) => { f.classList.toggle('now', k === st.i); f.classList.toggle('miss', FAIL.has(k)); f.setAttribute('aria-current', k === st.i); });
    dots.forEach((d, k) => d.classList.toggle('cur', k === st.i));
    knob.setAttribute('aria-valuenow', st.i); knob.setAttribute('aria-valuetext', `Visit ${st.i + 1} of ${N}, ${VIS[st.i].span}`);
    miss.hidden = !pics || !FAIL.has(st.i);
    miss.textContent = `The ${VIS[st.i].span} picture did not load. Its place and sight line are from JPL.`;
    // the strip scrolls sideways when it is wider than the box: the chosen photo stays in view
    const f = figs[st.i];
    if (f && stripEl.scrollWidth > stripEl.clientWidth + 1) {
      const l = f.offsetLeft - stripEl.offsetLeft, r = l + f.offsetWidth;
      if (l < stripEl.scrollLeft) stripEl.scrollLeft = l; else if (r > stripEl.scrollLeft + stripEl.clientWidth) stripEl.scrollLeft = r - stripEl.clientWidth;
    }
  }
  function knobAt() {
    const x = xOf(st.jd); line.style.setProperty('--x', `${x.toFixed(2)}%`);
    date.textContent = Math.abs(st.jd - VIS[st.i].jd) < .01 ? VIS[st.i].span : dateOf(st.jd);
    const W = line.clientWidth, hw = date.offsetWidth / 2 + 2; date.style.left = `${Math.max(hw - 11, Math.min(W - hw + 11, x / 100 * W)).toFixed(1)}px`;   // the whole date stays inside the column
  }
  // the knob: a press plays or pauses; a drag scrubs day by day (the photo taken last by then is selected); keys step
  let drag = null;
  knob.addEventListener('pointerdown', e => { if (e.button) return; drag = { x: e.clientX, moved: false }; knob.setPointerCapture(e.pointerId); e.preventDefault(); });
  knob.addEventListener('pointermove', e => {
    if (!drag) return; if (!drag.moved && Math.abs(e.clientX - drag.x) < 4) return;
    if (!drag.moved) { drag.moved = true; play(false); }
    const r = line.getBoundingClientRect(), x = clamp01((e.clientX - r.left) / r.width) * 100, jd = J0 + (Math.max(4, Math.min(96, x)) - 4) / 92 * (J1 - J0);
    const k = ok.filter(n => VIS[n].jd <= jd + 1e-6).at(-1) ?? ok[0];
    st.t0 = -9; st.jd = jd; st.from = st.to = jd; st.arrived = clock(); if (k !== st.i) { st.i = k; paint(); } knobAt(); kick();
  });
  knob.addEventListener('pointerup', () => { if (!drag) return; if (!drag.moved) play(!st.playing); else go(ok.reduce((b, n) => (Math.abs(VIS[n].jd - st.jd) < Math.abs(VIS[b].jd - st.jd) ? n : b))); drag = null; });
  knob.addEventListener('keydown', e => {
    const k = ok.indexOf(st.i), to = { ArrowLeft: k - 1, ArrowDown: k - 1, ArrowRight: k + 1, ArrowUp: k + 1, Home: 0, End: ok.length - 1 }[e.key];
    if (to != null) { play(false); go(ok[Math.max(0, Math.min(ok.length - 1, to))]); e.preventDefault(); }
    else if (e.key === ' ' || e.key === 'Enter') { play(!st.playing); e.preventDefault(); }
  });
  line.addEventListener('pointerdown', e => { if (e.target.closest('.tl-knob')) return; const r = line.getBoundingClientRect(), jd = J0 + ((e.clientX - r.left) / r.width * 100 - 4) / 92 * (J1 - J0); play(false); go(ok.reduce((b, n) => (Math.abs(VIS[n].jd - jd) < Math.abs(VIS[b].jd - jd) ? n : b))); });
  figs.forEach((f, k) => f.addEventListener('click', () => { play(false); go(k); }));

  // drag to turn, zoom and pan: the time-lapse Depth view's controls, on the whole box (it holds the canvas)
  const { zoomAt } = controls(box, { S, Z, yaw, render: kick, zoomBox, lim: { a: [-1.6, 1.6], p: [-.4, .9] }, sign: -1 });
  box.tabIndex = 0;

  // ---------------------------------------------------------------- one frame
  const key = [...shots.flatMap(s => s.corners), ...orbit.filter((_, k) => k % 15 === 0), ...Array.from({ length: 13 }, (_, k) => { const t = SK0 + (SK1 - SK0) * (k / 12 * 1.26 - .13); return V(Math.cos(t) * SKY, 0, Math.sin(t) * SKY); })];
  const AZ = 1.75, EL = .9;   // the square box: a little more from above than mockup 7
  const q = V(), q2 = V();
  let raf = 0, sunAt = null;
  function render() {
    raf = 0;
    if (st.view !== 'depth' || box.closest('[hidden]')) return;
    S.size(); placed.length = 0; camera.clearViewOffset(); S.z = 1;
    const br = solar.getBoundingClientRect();
    keep = [document.querySelector('.shot .tabs'), zoomBox].filter(e => e?.offsetWidth).map(e => { const r = e.getBoundingClientRect(); return [r.left - br.left, r.top - br.top, r.right - br.left, r.bottom - br.top]; });
    const now = clock();
    if (st.playing && now >= st.next) step();
    if (st.t0 > 0) { const k = sm((now - st.t0) / st.dur); st.jd = st.from + (st.to - st.from) * k; if (k >= 1) st.t0 = -9; }
    knobAt();
    const lit = now >= st.arrived, flash = lit && !REDUCED ? Math.exp(-(now - st.arrived) / .3) : 0;
    const E = earthAt(st.jd), Cm = cometAt(st.jd), cur = shots[st.i], here = lit ? cur : shot(E, Cm);
    const az = AZ + yaw.a, el = EL + yaw.p, a = REDUCED ? 1 : sm((now - st.opened) / 1.2);
    S.aim(S.fit(key, V(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)), Y, 24, [26, 64, S.W - 48, S.H - 26]));
    if (Z.k > 1) { camera.setViewOffset(S.W, S.H, Z.x, Z.y, S.W / Z.k, S.H / Z.k); S.z = Z.k; }
    for (const [n, off] of [['in', Z.k >= 8], ['out', Z.k <= 1]]) { const b = zoomBox?.querySelector(`[data-zoom=${n}]`); if (b) b.disabled = off; }
    const w = p => S.pxAt(p);
    sunDot.scale.setScalar(w(sunDot.position) * 64); earthDot.position.copy(E); earthDot.scale.setScalar(w(E) * 22);
    head.position.copy(Cm); head.scale.setScalar(w(Cm) * 28); ring.position.copy(Cm); ring.scale.setScalar(w(Cm) * 28);
    craft.quaternion.setFromUnitVectors(Y, here.d); craft.position.copy(E).addScaledVector(here.d, CR * .2);
    light.target.position.copy(E);
    const away = Cm.clone().normalize(), vw = camera.position.clone().sub(Cm).normalize(), wd = V().crossVectors(away, vw).normalize(), nn = V().crossVectors(away, wd);
    tail.position.copy(Cm); tail.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(away, wd, nn)); tail.scale.set(.55 * SKY / 6.4, .22 * SKY / 6.4, 1);   // drawn, not measured
    for (const m of [sunDot, earthDot, head, ring, tail, trail]) m.material.opacity = (m === trail ? .75 : 1) * a;

    guides.begin();
    orbit.forEach((p, k) => k && guides.seg(orbit[k - 1], p, WHITE, .32 * a));
    for (let k = -8; k < 68; k++) { const t0 = SK0 + (SK1 - SK0) * k / 60, t1 = SK0 + (SK1 - SK0) * (k + .55) / 60; guides.seg(q.set(Math.cos(t0) * SKY, 0, Math.sin(t0) * SKY), q2.set(Math.cos(t1) * SKY, 0, Math.sin(t1) * SKY), WHITE, .2 * a); }
    for (let k = 0; k < 24; k += 2) guides.seg(V().lerp(E, k / 24), V().lerp(E, (k + 1) / 24), WHITE, .4 * a);
    // the photos already taken by now: their sight lines and frames stay, faint; where Earth and the comet were, small rings
    for (const sh of shots) {
      const isCur = sh === cur && lit, taken = sh.jd <= st.jd + 1e-6 && !isCur;
      sh.tile.visible = taken || isCur; sh.tile.material.opacity = (isCur ? 1 : .45) * a;
      if (!taken) continue;
      guides.seg(sh.E, sh.c, WHITE, .22 * a, .12 * a); sh.corners.forEach((c, n) => guides.seg(c, sh.corners[(n + 1) % 4], WHITE, .35 * a));
      for (const [pt, col] of [[sh.E, BLUE], [sh.Cm, ACCENT]]) { const r = w(pt) * 3; for (let n = 0; n < 8; n++) guides.seg(q.copy(pt).addScaledVector(sh.r, Math.cos(n / 8 * TAU) * r).addScaledVector(sh.u, Math.sin(n / 8 * TAU) * r).clone(), q2.copy(pt).addScaledVector(sh.r, Math.cos((n + 1) / 8 * TAU) * r).addScaledVector(sh.u, Math.sin((n + 1) / 8 * TAU) * r), col, .8 * a); }
    }
    // the selected photo, lit on arrival: its frustum from SPHEREx through the comet, out to its frame on the sky.
    // On the way to the next photo, a dim beam follows where SPHEREx would be looking.
    const ba = lit ? 1 : .35, bc = here.corners;
    setBeam(E, bc); beam.material.opacity = (.07 + .12 * flash) * ba * a;
    for (const c of bc) guides.seg(E, c, WHITE, .3 * ba * a, (.6 + .4 * flash) * ba * a);
    bc.forEach((c, n) => guides.seg(c, bc[(n + 1) % 4], WHITE, ba * a));
    guides.seg(E, Cm, WHITE, .95 * a); guides.seg(Cm, here.c, WHITE, .4 * ba * a);
    guides.end();

    lComet.at(Cm, [0, -22, -.5, -1], a); lSun.at(V(), [0, 14, -.5, 0], a, true);
    { const [sx, sy] = S.px(V()), [ex, ey] = S.px(E), l = Math.hypot(ex - sx, ey - sy) || 1, ux = (ex - sx) / l, uy = (ey - sy) / l; lEarth.at(E, [ux * 16, uy * 16 - 6, ux < -.3 ? -1 : ux > .3 ? 0 : -.5, uy < -.3 ? -1 : 0], a); }   // Earth's name on the side away from the Sun
    lDist.el.textContent = fmt(E.distanceTo(Cm)); lDist.at(E.clone().lerp(Cm, .4), [0, -10, -.5, -1], a, true);   // over the sight line, nearer Earth: clear of the comet's ring
    { const low = bc.reduce((b, c) => { const p = S.px(c); return p[1] > b[1] ? p : b; }, [0, -1e9]); lPhoto.at(here.c, [0, low[1] - S.px(here.c)[1] + 7, -.5, 0], lit ? a : 0, true); }
    shots.forEach((sh, k) => lDates[k].at(sh.c.clone().addScaledVector(sh.u, TILE), [0, -8, -.5, -1], sh.tile.visible && !(sh === cur && lit) ? a : 0, true));
    lSky.at(q.set(Math.cos((SK0 + SK1) / 2) * SKY, 0, Math.sin((SK0 + SK1) / 2) * SKY), [0, -10, -.5, -1], a, true);
    { const r = cv.getBoundingClientRect(), [x, y] = S.px(V()); sunAt = [r.left + x, r.top + y]; }
    S.draw();
    // keep drawing while something moves: playing, gliding, the flash or the fade-in
    if (st.playing || st.t0 > 0 || (!REDUCED && (now - st.arrived < 1.5 || now - st.opened < 1.3))) kick();
  }
  function kick() { if (!raf) raf = requestAnimationFrame(render); }
  new ResizeObserver(() => kick()).observe(solar);

  // the page's Photo and Depth tabs (comet.js tab()): Photo is today's picture; the playback belongs to Depth and pauses
  let autoplay = 0;
  function view(v) {
    st.view = v;
    if (v === 'photo') { play(false); clearTimeout(autoplay); return; }
    st.opened = clock(); kick();
    if (!REDUCED && !st.played && ok.length > 1) { st.played = true; autoplay = setTimeout(() => { if (st.view === 'depth') play(true); }, 1500); }   // plays once on first opening
  }
  go(0, { glide: false }); paint();

  // for tests: the zoom and turn, the Sun on screen, what each part shows, the names and where they sit
  const api = {
    view: () => ({ k: Z.k, x: Z.x, y: Z.y, W: S.W, H: S.H, az: yaw.a, elv: yaw.p, sun: sunAt }),
    get shown() {
      return { i: st.i, jd: st.jd, lit: clock() >= st.arrived, playing: st.playing, view: st.view, n: N, failed: [...FAIL], pts: pathPts.length,
        strip: figs.findIndex(f => f.classList.contains('now')), dot: dots.findIndex(d => d.classList.contains('cur')), date: date.textContent,
        tiles: shots.map(s => (s.tile.visible ? (s.tile.material.opacity >= .99 * (REDUCED ? 1 : sm((clock() - st.opened) / 1.2)) && s === shots[st.i] && clock() >= st.arrived ? 'lit' : 'faint') : 'hidden')),
        earth: earthAt(st.jd).toArray(), comet: cometAt(st.jd).toArray(), sky: SKY };
    },
    labels: () => [...layer.children].map(e => ({ text: e.textContent, shown: +e.style.opacity > .5, at: e.dataset.at, rect: (r => [r.left, r.top, r.right, r.bottom])(e.getBoundingClientRect()) })),
    // the scene's coordinates back to JPL's (heliocentric ecliptic AU): x, y, z = X, -Z, Y
    ecl: p => [p[0], -p[2], p[1]],
    play, go: (k, o) => go(k, o), view, ready: loaded, rows: ROWS,
  };
  return api;
}
