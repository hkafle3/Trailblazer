// The time-lapse's Depth tab (timelapse.html): what is in this patch and how far away each thing is, from GET /api/depth
// for the patch and the visit on screen. Two parts, fed by one answer:
// - the beam: SPHEREx at the near end, the whole region's photo at the far end, and each placed object on its own line
//   of sight at its distance, on a compressed log scale (the UX mockup's 3D view, ux-mockups/src/depth3d.js sky(), on
//   real data). Drag turns it; the wheel, a pinch, + and - zoom toward the pointer or the fingers, Reset view undoes both.
// - the Distances list: every placed object, nearest first, with its source and error; then what has no distance, and
//   any source that is still answering (pending, asked again after retry_after) or not answering (unavailable).
// Nothing without a catalog distance gets a number. Names from the network are set with textContent.
import * as THREE from 'three';

const TAU = Math.PI * 2, D2R = Math.PI / 180, LY_PC = 3.26156, AU_LY = 1.58125e-5;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp01 = x => Math.max(0, Math.min(1, x)), sm = x => { x = clamp01(x); return x * x * (3 - 2 * x); };
const WHITE = [1, 1, 1], ACCENT = [1, .604, .302];
const SOURCE = { sso: 'Asteroids and comets (SkyBoT)', stars: 'Stars (Gaia DR3)', galaxies: 'Galaxies (SIMBAD)' };
const LETTERS = 'ABCD';

// a distance in words: AU inside the solar system, light-years beyond, millions and billions spelled out
export function lyText(ly, short = false) {
  if (ly < 0.05) { const au = ly / AU_LY; return `${au < 10 ? au.toFixed(1) : Math.round(au).toLocaleString('en-US')} AU`; }
  const unit = short ? ' ly' : ' light-years';
  if (ly >= 1e9) return `${+(ly / 1e9).toPrecision(2)} billion${unit}`;
  if (ly >= 1e6) return `${+(ly / 1e6).toPrecision(2)} million${unit}`;
  const r = ly >= 100 ? Math.round(ly / 10 ** (Math.floor(Math.log10(ly)) - 1)) * 10 ** (Math.floor(Math.log10(ly)) - 1) : +ly.toPrecision(2);
  return `${r.toLocaleString('en-US')}${ly === 1 ? (short ? ' ly' : ' light-year') : unit}`;
}
// the error of a distance, in the same units, or the reason there is none
function errText(o) {
  if (o.d_lo_pc == null || o.d_hi_pc == null) return 'no error published';
  const half = (o.d_hi_pc - o.d_lo_pc) / 2 * LY_PC;   // in light-years, as the distances are (an AU-sized error stays in light-years)
  return `±${half < 100 ? +half.toPrecision(half < 1 ? 1 : 2) : lyText(half, true).replace(/ ly$/, '')}`;
}
const how = { sso: 'SkyBoT orbit', stars: 'Gaia parallax', galaxies: 'SIMBAD redshift' };
// a small soft dot: the objects that are not named in the beam, so the crowd reads as "a lot is out there" without rings
function dotTex() {
  const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d'), r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.35, 'rgba(255,255,255,.9)'); r.addColorStop(.6, 'rgba(255,255,255,.2)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 32, 32); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// Every placed object of an answer as one list: { key, src, ra, dec, ly, o }. key is what the tests compare with the API.
export function placedOf(data) {
  const out = [];
  for (const src of ['sso', 'stars', 'galaxies']) for (const o of data?.sources?.[src]?.placed ?? [])
    out.push({ key: `${src}:${o.id ?? o.name}`, src, ra: o.ra, dec: o.dec, ly: o.d_pc * LY_PC, o });
  return out.sort((a, b) => a.ly - b.ly);
}

// one stage: renderer, camera, HTML labels over the canvas, thin lines rebuilt every frame
function stage(box) {
  const canvas = box.querySelector('canvas'), layer = box.querySelector('.xp-d3-lbl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(20, 1, .05, 400);
  const S = { W: 1, H: 1, z: 1, renderer, scene, camera, keep: [], placed: [] };   // keep: boxes over the view (x0, y0, x1, y1) labels stay clear of; z: the zoom (render())
  S.size = () => { const W = box.clientWidth || 1, H = box.clientHeight || 1; if (W === S.W && H === S.H) return false; S.W = W; S.H = H; renderer.setSize(W, H, false); camera.aspect = W / H; camera.updateProjectionMatrix(); return true; };
  S.sprite = (tex, order = 6) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false })); s.renderOrder = order; scene.add(s); return s; };
  S.lines = (max, order = 7) => {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(max * 6, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(max * 8, 4));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, depthTest: false }));
    l.frustumCulled = false; l.renderOrder = order; scene.add(l);
    let n = 0; const P = g.attributes.position.array, C = g.attributes.color.array;
    return {
      begin() { n = 0; },
      seg(a, b, col, ia = 1, ib = ia) { if (n >= max) return; a.toArray(P, 6 * n); b.toArray(P, 6 * n + 3); C.set([...col, Math.min(1, ia), ...col, Math.min(1, ib)], 8 * n); n++; },
      end() { g.setDrawRange(0, 2 * n); g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = true; },
    };
  };
  const tmp = V();
  S.label = (text, cls = '') => {
    const el = document.createElement('div'); el.className = 'lbl ' + cls; el.textContent = text; layer.append(el);
    return { el, at(p, [dx, dy, ax, ay] = [10, -5, 0, 0], a = 1) {
      tmp.copy(p).project(camera); const vis = a > .01 && tmp.z < 1 && (S.z === 1 || Math.abs(tmp.x) <= 1 && Math.abs(tmp.y) <= 1);   // zoomed: none for what is out of view
      el.style.opacity = vis ? a.toFixed(3) : 0; if (!vis) return;
      // kept inside the view sideways: a name that would run off an edge slides back in
      const w = el.offsetWidth, h = el.offsetHeight, x = Math.max(4, Math.min(S.W - w - 4, (tmp.x + 1) / 2 * S.W + dx + ax * w));
      let y = (1 - tmp.y) / 2 * S.H + dy;
      // under a box it would run beneath (the tabs over the beam): moved down just clear of it, and of the names moved
      // there before it (zoomed in, several can land under the tabs)
      const clear = boxes => { let moved = false; for (const [x0, y0, x1, y1] of boxes) { const top = y + ay * h; if (x < x1 && x + w > x0 && top < y1 + 2 && top + h > y0) { y += y1 + 2 - top; moved = true; } } return moved; };
      if (clear(S.keep)) clear(S.placed);
      S.placed.push([x, y + ay * h, x + w, y + ay * h + h]);
      el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(0,${ay * 100}%)`;
    }, remove() { el.remove(); } };
  };
  S.px = p => (tmp.copy(p).project(camera), [(tmp.x + 1) / 2 * S.W, (1 - tmp.y) / 2 * S.H]);
  S.pxAt = p => tmp.copy(p).sub(camera.position).dot(camera.getWorldDirection(V())) * Math.tan(camera.fov / 2 * D2R) * 2 / S.H / S.z;   // world size of one CSS px there
  S.aim = ({ pos, tgt, up, fov }) => { camera.fov = fov; camera.position.copy(pos); camera.up.copy(up); camera.lookAt(tgt); camera.updateProjectionMatrix(); camera.updateMatrixWorld(); };
  // the camera that looks along -dir with these points filling the rectangle [x0, y0, x1, y1] (CSS px) of the view
  S.fit = (pts, dir, up, fov, [x0, y0, x1, y1]) => {
    const tgt = pts.reduce((a, p) => a.add(p), V()).divideScalar(pts.length); let dist = 30; dir = dir.clone().normalize();
    for (let k = 0; k < 14; k++) {
      S.aim({ pos: tgt.clone().addScaledVector(dir, dist), tgt, up, fov });
      let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const p of pts) { const [x, y] = S.px(p); a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
      const w = dist * Math.tan(fov / 2 * D2R) * 2 / S.H, right = V().setFromMatrixColumn(camera.matrixWorld, 0), upv = V().setFromMatrixColumn(camera.matrixWorld, 1);
      tgt.addScaledVector(right, ((a + c) / 2 - (x0 + x1) / 2) * w).addScaledVector(upv, -((b + d) / 2 - (y0 + y1) / 2) * w);
      dist *= Math.max((c - a) / (x1 - x0), (d - b) / (y1 - y0));
    }
    return { pos: tgt.clone().addScaledVector(dir, dist), tgt, up: up.clone(), fov };
  };
  S.draw = () => renderer.render(scene, camera);
  return S;
}
function ringTex(color, dash) {
  const c = document.createElement('canvas'); c.width = c.height = 384; const g = c.getContext('2d'); g.scale(4, 4);   // sharp at 8x zoom
  g.strokeStyle = color; g.lineWidth = 7; if (dash) g.setLineDash([14, 9.56]); g.beginPath(); g.arc(48, 48, 36, 0, TAU); g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// SPHEREx: three nested cone shields over a telescope and a small body (the intro's simple model). Looks along +Y.
function spherex() {
  const craft = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf1eee9, metalness: .15, roughness: .55, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171c, metalness: .4, roughness: .6 });
  const rim = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .9 });
  [[1, .40, .86], [.84, .34, .93], [.68, .28, 1]].forEach(([top, bot, h]) => {
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(top, bot, h, 64, 1, true), white); cone.position.y = h / 2; craft.add(cone);
    craft.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 96 }, (_, i) => V(Math.cos(i / 96 * TAU) * top, h, Math.sin(i / 96 * TAU) * top))), rim));
  });
  const scope = new THREE.Mesh(new THREE.CylinderGeometry(.2, .2, .62, 32), dark); scope.position.y = .31; craft.add(scope);
  const bus = new THREE.Mesh(new THREE.CylinderGeometry(.33, .33, .42, 6), white); bus.position.y = -.2; craft.add(bus);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(.62, .9, .025), new THREE.MeshStandardMaterial({ color: 0x1b2a55, metalness: .5, roughness: .35 }));
  panel.position.set(0, -.12, .42); panel.rotation.x = -.16; craft.add(panel);
  return craft;
}

// page: { api, box, list, status, region() -> { m, f, canvas } | null, onScreen(m, ra, dec, year) -> [u, v] (-1..1 across
// the region, north up), target(m, f, stars) -> index of the star that is the patch's own target, or -1 }
export function depthView(page) {
  const { box, list, status } = page;
  let S = null, gl = true, scene3 = null, data = null, asked = null, retry = 0, tries = 0, ctl = null, open = false, raf = 0;
  const yaw = { a: 0, p: 0, t0: 0 };   // drag: the turn and tilt added to the side view; t0: when the swing out started
  const Z = { k: 1, x: 0, y: 0 };   // the zoom: k times, the view's top-left corner at (x, y) CSS px of the unzoomed view

  // ---------- the answer ----------
  function want(m, f) { return `${page.api}/api/depth?ra=${m.ra.toFixed(4)}&dec=${m.dec.toFixed(4)}&t=${f.mjd.toFixed(4)}`; }
  async function fetchNow(url, m, f) {
    ctl?.abort(); clearTimeout(retry);
    const c = ctl = new AbortController();
    if (!data || data.url !== url) { data = null; say('Asking the catalogs how far each thing is...'); paintList(); clearBeam('Asking the catalogs how far each thing is...'); }
    let d;
    try {
      const r = await fetch(url, { signal: c.signal });
      d = await r.json();
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
    } catch (e) {
      if (c.signal.aborted) return;
      data = { url, m, f, failed: String(e.message || e) }; say(`Could not ask the catalogs: ${data.failed}. Trying again in 30 s.`); paintList();
      clearBeam(`Could not ask the catalogs for distances (${data.failed}). Trying again in 30 s.`, true);
      retry = setTimeout(() => fetchNow(url, m, f), 30000);
      return;
    }
    if (asked !== url) return;
    data = { url, m, f, d };
    const down = Object.entries(d.sources).filter(([, s]) => s.status === 'unavailable').map(([k]) => SOURCE[k]);
    msg(down.length === Object.keys(d.sources).length ? `No catalog is answering for this visit (${down.join(', ')}). Trying again in a minute.` : '', down.length === Object.keys(d.sources).length);
    paintList(); build();
    if (down.length === Object.keys(d.sources).length && tries++ < 8) retry = setTimeout(() => fetchNow(url, m, f), 60000);
    // a pending source is asked again after retry_after (it keeps fetching in the background), at most 8 times
    const wait = Object.values(d.sources).filter(s => s.status === 'pending').map(s => s.retry_after || 5);
    if (wait.length && tries++ < 8) retry = setTimeout(() => fetchNow(url, m, f), 1000 * Math.min(...wait));
  }
  function say(t) { status.textContent = t; }
  function msg(t, err = false) { const el = box.querySelector('.xp-d3-msg'); if (el) { el.textContent = t; el.classList.toggle('err', err); } box.dataset.state = err ? 'error' : t ? 'asking' : 'ready'; }
  // the beam of the last answer goes at once: no rings, dots, names or scale marks from another patch or visit
  function clearBeam(t, err = false) {
    msg(t, err); shown = { rings: [], dots: [] }; box.dataset.objects = box.dataset.rings = box.dataset.dots = '0';
    if (!scene3) return;
    for (const s of scene3.beads) { s.sp.removeFromParent(); s.lab.remove(); }
    for (const k of scene3.marks) k.lab.remove();
    scene3.beads = []; scene3.marks = []; scene3.dots = [];
    for (const p of [scene3.cloud, scene3.unk]) p.geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    render();
  }

  // ---------- the list ----------
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function row(mark, name, small, dist, key) {
    const li = el('li', 'drow'); if (key) li.dataset.key = key;
    const left = el('span', 'dn'), i = el('i', `dmk ${mark}`); i.setAttribute('aria-hidden', 'true');
    left.append(i, el('span', 'nm', name), el('small', null, small));
    li.append(left, el('span', 'dd', dist)); return li;
  }
  let picked = { target: -1, letters: new Map() }, pickedFor = null;   // pickedFor: page.matchKey() when the pick was made
  function choose(all) {   // the target, and up to four more to name in the beam: the nearest, the farthest, one between
    pickedFor = page.matchKey();
    const t = page.target(data.m, data.f, all), named = page.named?.(data.m, data.f, all) ?? null;   // named: a known star that is not the target keeps its name
    const letters = new Map(), rest = all.map((_, i) => i).filter(i => i !== t && i !== named?.i);
    const stars = rest.filter(i => all[i].src === 'stars'), other = rest.filter(i => all[i].src !== 'stars');
    const pick = new Set([stars[0], stars[Math.floor(stars.length / 2)], stars[stars.length - 1], other[other.length - 1], other[0], stars[1]].filter(i => i != null));
    [...pick].slice(0, 4).sort((a, b) => a - b).forEach((i, k) => letters.set(i, LETTERS[k]));   // lettered nearest first
    return { target: t, letters, named };
  }
  function nameOf(p, i) {
    if (i === picked.target) return p.src === 'sso' ? p.o.name : page.targetName(data.m) ?? 'The star in the middle';
    if (i === picked.named?.i) return picked.named.name;
    const L = picked.letters.get(i);
    if (p.src === 'sso') return `${p.o.name}${p.o.class ? ` (${p.o.class.split('>')[0].toLowerCase()})` : ''}`;
    if (p.src === 'galaxies') return L ? `Galaxy ${L} · ${p.o.id}` : p.o.id;
    return L ? `Star ${L}` : `Star, G ${p.o.g?.toFixed(1) ?? '?'}`;
  }
  // what is in the photo: the patch square (the API's cone is wider), a star at its place this visit. The target is kept
  // whatever its catalog place: it is found by who it is (page.target) and drawn where the page places it (targetAt, an
  // asteroid at its matched exposure); the answer's place, at the visit's middle, is for every other object
  function inPatch(ra, dec, pm) { const [u, v] = page.onScreen(data.m, ra, dec, pm); return Math.abs(u) <= 1 && Math.abs(v) <= 1; }
  function placedHere() {
    const year = data.f.year ?? 2026, every = placedOf(data.d), t = page.target(data.m, data.f, every);
    return every.filter((p, i) => i === t || inPatch(p.ra, p.dec, p.src === 'stars' ? { year, pmra: p.o.pmra, pmdec: p.o.pmdec } : null));
  }
  const unknownHere = src => (data.d.sources[src]?.unknown ?? []).filter(o => inPatch(o.ra, o.dec, null));
  function paintList() {
    list.replaceChildren();
    if (!data?.d) return;
    const all = placedHere(); picked = choose(all);
    const S0 = data.d.sources, frag = document.createDocumentFragment();
    all.forEach((p, i) => frag.append(row(i === picked.target ? 'a' : '', nameOf(p, i),
      `${how[p.src]}, ${errText(p.o)}${p.src === 'stars' ? ` · Gaia DR3 ${p.o.id}` : ''}`, lyText(p.ly, true).replace(/ ly$/, ''), p.key)));
    // no distance: named rows with their reasons, then the count of stars Gaia measured too roughly
    for (const src of ['sso', 'galaxies']) for (const o of unknownHere(src))
      frag.append(row('u', o.name ?? o.id, `${how[src]}: ${o.reason}`, 'unknown', `${src}?:${o.id ?? o.name}`));
    if (picked.target < 0) {   // the patch's own object has no catalog distance: said first among the unknowns, never borrowed
      const mid = page.middle(data.m, data.f), cap = mid.name[0].toUpperCase() + mid.name.slice(1);
      frag.append(row('u a', cap, 'no catalog distance for it here', 'unknown', 'middle?:unknown'));
    }
    const su = S0.stars?.unknown_count;
    if (su) frag.append(row('u', `${su.toLocaleString('en-US')} more star${su === 1 ? '' : 's'} in and around the patch`, 'Gaia parallax too rough, or the star not clean enough to trust it', 'unknown'));
    const gu = S0.galaxies?.unknown_count, gl = (S0.galaxies?.unknown ?? []).length;
    if (gu > gl) frag.append(row('u', `${(gu - gl).toLocaleString('en-US')} more galaxies in and around the patch`, 'no usable redshift in SIMBAD', 'unknown'));
    list.append(frag);
    // the sources that did not answer in full, said plainly
    const notes = [];
    for (const [src, s] of Object.entries(S0)) {
      if (s.status === 'pending') notes.push(`${SOURCE[src]}: still answering, asking again in ${s.retry_after || 5} s.`);
      else if (s.status === 'unavailable') notes.push(`${SOURCE[src]}: not answering right now${s.retry_after ? `, try again in ${s.retry_after} s` : ''}. Nothing from it is shown.`);
      else if (s.status === 'skipped') notes.push(`${SOURCE[src]}: not asked (${s.reason || 'no visit date'}).`);
      else if (s.truncated) notes.push(`${SOURCE[src]}: the ${s.placed.length.toLocaleString('en-US')} brightest of ${s.count.toLocaleString('en-US')} are shown.`);
    }
    say(`${all.length.toLocaleString('en-US')} with a distance${notes.length ? '. ' + notes.join(' ') : ''}`);
    list.dataset.state = Object.values(S0).map(s => s.status).join(',');
  }

  // ---------- the beam ----------
  const L = 10, hw = 2, hh = 2;   // the photo is the whole square region
  const P = (u, v) => V(L, v * hh, u * hw), at = (u, v, f) => P(u, v).multiplyScalar(f);
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([u, v]) => P(u, v)), top = V(), Y = V(0, 1, 0), CR = .55;
  function init() {
    if (S || !gl) return !!S;
    try { S = stage(box); } catch { gl = false; box.classList.add('nogl'); return false; }
    const { scene } = S;
    const photo = new THREE.Mesh(new THREE.PlaneGeometry(2 * hw, 2 * hh), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, depthTest: false }));
    photo.position.set(L, 0, 0); photo.rotation.y = -Math.PI / 2; photo.renderOrder = 4; scene.add(photo);
    const beam = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, ...corners.flatMap(c => c.toArray())], 3)).setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]),
      new THREE.MeshBasicMaterial({ color: 0xbfd6ff, transparent: true, opacity: .05, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    beam.frustumCulled = false; beam.renderOrder = 5; scene.add(beam);
    const craft = spherex(); craft.scale.setScalar(CR); craft.rotation.z = -Math.PI / 2; craft.position.set(-CR, 0, 0); scene.add(craft);
    const sun = new THREE.DirectionalLight(0xfff4e2, 3); sun.position.set(-2, 5, 8); scene.add(sun, new THREE.HemisphereLight(0x8fb4ff, 0x0a1020, .6));
    const rW = ringTex('#fff'), rA = ringTex('#ff9a4d'), rU = ringTex('rgba(255,255,255,.6)', true), rAu = ringTex('#ff9a4d', true);
    // every other placed object: faint small dots, no ring and no name (one draw call); hover or tap one for its name
    const cloud = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: dotTex(), size: 4, sizeAttenuation: false, transparent: true, opacity: .3, depthTest: false, depthWrite: false }));
    cloud.renderOrder = 8; cloud.frustumCulled = false; scene.add(cloud);
    const unk = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: rU, size: 11, sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false }));
    unk.renderOrder = 8; unk.frustumCulled = false; scene.add(unk);
    scene3 = { photo, beam, craft, cloud, unk, rW, rA, rU, rAu, guides: S.lines(400), beads: [], marks: [], dots: [], fixed: [S.label('the photo'), S.label('SPHEREx')] };
    const tip = S.label('', 'tip'); tip.el.style.opacity = 0;
    // the dot nearest the pointer (within 10 px): its name and distance beside it; a tap does the same on a phone
    const peek = e => {
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 10;
      for (const d of scene3.dots) { const [px, py] = S.px(d.pos), dd = Math.hypot(px - x, py - y); if (dd < bd) { bd = dd; best = d; } }
      if (!best) { tip.el.style.opacity = 0; box.dataset.peek = ''; return; }
      tip.el.textContent = best.text; tip.at(best.pos, [8, -6, 0, -1], 1); box.dataset.peek = best.key;
    };
    // drag to turn: sideways turns the beam, up and down tilts it (a little). Two fingers zoom about their midpoint and
    // move with it (as on Explore and the photo): a second finger ends the turn, and none starts until both lift.
    const cv = box.querySelector('canvas'), fingers = new Map(); let drag = null, pinch = null;
    const two = () => { const [a, b] = fingers.values(), r = cv.getBoundingClientRect(); return { m: [(a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top], d: Math.hypot(a[0] - b[0], a[1] - b[1]) }; };
    cv.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse') fingers.set(e.pointerId, [e.clientX, e.clientY]);
      if (fingers.size === 2) { if (drag) { yaw.a = drag.a; yaw.p = drag.p; drag = null; cv.classList.remove('drag'); } cv.setPointerCapture(e.pointerId); pinch = two(); tip.el.style.opacity = 0; render(); return; }
      if (fingers.size > 2 || pinch || e.button) return;
      drag = { x: e.clientX, y: e.clientY, a: yaw.a, p: yaw.p }; cv.setPointerCapture(e.pointerId); cv.classList.add('drag'); box.dataset.turned = '1'; });
    cv.addEventListener('pointermove', e => {
      if (fingers.has(e.pointerId)) fingers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch) { if (fingers.size === 2 && fingers.has(e.pointerId)) { const n = two(); if (n.d > 0 && pinch.d > 0) zoomAt(n.d / pinch.d, ...pinch.m, ...n.m); pinch = n; } return; }
      if (!drag) return peek(e); tip.el.style.opacity = 0; yaw.a = Math.max(-1.3, Math.min(1.9, drag.a + (e.clientX - drag.x) / 260)); yaw.p = Math.max(-.15, Math.min(.9, drag.p + (e.clientY - drag.y) / 300)); render(); });
    const up = e => { fingers.delete(e?.pointerId); if (!fingers.size) pinch = null; if (drag && e?.type === 'pointerup' && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) peek(e); drag = null; cv.classList.remove('drag'); };
    cv.addEventListener('pointerleave', () => { if (!drag) tip.el.style.opacity = 0; });
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    // the wheel and a trackpad pinch (a ctrl wheel: smaller steps, so stronger each) zoom toward the pointer, and neither
    // the page nor the browser zooms or scrolls over the view. Safari's trackpad pinch is a gesture, not a ctrl wheel.
    const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const px = e.deltaY * [1, 33, cv.clientHeight][e.deltaMode];   // pixels, lines or pages
      zoomAt(Math.exp(-Math.max(-300, Math.min(300, px)) * (e.ctrlKey ? .01 : .002)), ...local(e));
    }, { passive: false });
    let gs = 1;
    cv.addEventListener('gesturestart', e => { e.preventDefault(); gs = 1; });
    cv.addEventListener('gesturechange', e => { e.preventDefault(); if (!fingers.size && e.scale > 0) { zoomAt(e.scale / gs, ...local(e)); gs = e.scale; } });   // on iPhone the fingers above zoom
    cv.addEventListener('gestureend', e => e.preventDefault());
    const mid = () => [S.W / 2, S.H / 2];
    box.querySelector('.xp-d3-zoom')?.addEventListener('click', e => {
      const z = e.target.closest('button')?.dataset.zoom;
      if (z === 'in') zoomAt(1.5, ...mid()); else if (z === 'out') zoomAt(1 / 1.5, ...mid());
      else if (z === 'reset') { Object.assign(Z, { k: 1, x: 0, y: 0 }); yaw.a = yaw.p = 0; tip.el.style.opacity = 0; render(); }
    });
    cv.addEventListener('keydown', e => {
      const z = { '+': 1.5, '=': 1.5, '-': 1 / 1.5, '_': 1 / 1.5 }[e.key];   // Ctrl or Cmd with them is the browser's own zoom
      if (z && !e.ctrlKey && !e.metaKey && !e.altKey) { zoomAt(z, ...mid()); e.preventDefault(); e.stopPropagation(); return; }
      const k = { ArrowLeft: [-.12, 0], ArrowRight: [.12, 0], ArrowUp: [0, -.08], ArrowDown: [0, .08] }[e.key]; if (!k) return;
      yaw.a = Math.max(-1.3, Math.min(1.9, yaw.a + k[0])); yaw.p = Math.max(-.15, Math.min(.9, yaw.p + k[1])); render(); e.preventDefault(); e.stopPropagation();
    });
    new ResizeObserver(() => open && render()).observe(box);
    return true;
  }
  // zoom by f about the view point (x0, y0), which lands at (x1, y1): what was under it stays under it. 1x to 8x, and
  // never past the edges of the unzoomed view
  function zoomAt(f, x0, y0, x1 = x0, y1 = y0) {
    if (!S) return;
    const u = Z.x + x0 / Z.k, v = Z.y + y0 / Z.k; Z.k = Math.max(1, Math.min(8, Z.k * f));
    Z.x = Math.max(0, Math.min(S.W - S.W / Z.k, u - x1 / Z.k)); Z.y = Math.max(0, Math.min(S.H - S.H / Z.k, v - y1 / Z.k));
    render();
  }
  let scale = null, shown = { rings: [], dots: [] };   // shown: which objects the beam draws as named rings, which as dots (for tests)
  function build() {   // the objects of the answer on screen: positions, the scale, the named ones
    if (!open || !data?.d || !init()) return;
    const all = placedHere(), { m } = data, year = data.f.year ?? 2026;
    // the scale: log10 of light-years across [lo, hi], drawn from 12% to 86% of the way to the photo
    const lg = all.map(p => Math.log10(p.ly));
    let lo = Math.min(...lg, 0) - .4, hi = Math.max(...lg, 3) + .3; if (hi - lo < 2) hi = lo + 2;
    scale = ly => .12 + .74 * clamp01((Math.log10(ly) - lo) / (hi - lo));
    const uv = p => page.onScreen(m, p.ra, p.dec, p.src === 'stars' ? { year, pmra: p.o.pmra, pmdec: p.o.pmdec } : null);
    const pos = []; scene3.dots = [];
    for (const s of scene3.beads) { s.sp.removeFromParent(); s.lab.remove(); }
    scene3.beads = [];
    // the target's ring goes where the page places it (targetAt: a matched asteroid at its matched exposure, not where
    // /api/depth puts it at the visit's middle), so Depth and the Photo mark the same spot
    const tp = picked.target >= 0 ? page.middle(m, data.f) : null;
    all.forEach((p, i) => {
      const [u, v] = i === picked.target && tp?.u != null ? [tp.u, tp.v] : uv(p), f = scale(p.ly), name = i === picked.target || picked.letters.has(i) || i === picked.named?.i;
      if (!name) { const q = at(u, v, f); pos.push(...q.toArray()); scene3.dots.push({ pos: q, key: p.key, text: `${p.src === 'sso' ? p.o.name : p.src === 'galaxies' ? p.o.id : `star, G ${p.o.g?.toFixed(1) ?? '?'}`} · ${lyText(p.ly, true)}` }); return; }
      const acc = i === picked.target, L0 = picked.letters.get(i), d = lyText(p.ly, S.W < 500);
      const text = acc ? `${p.src === 'sso' ? p.o.name : page.targetName(m) ?? 'the star in the middle'} · ${d}` : i === picked.named?.i ? `${picked.named.name} · ${d}` : `${p.src === 'sso' ? p.o.name : `${p.src === 'galaxies' ? 'galaxy' : 'star'} ${L0}`} · ${d}`;
      const err = p.o.d_lo_pc != null ? [scale(p.o.d_lo_pc * LY_PC), scale(p.o.d_hi_pc * LY_PC)] : null;
      scene3.beads.push({ u, v, f, pos: at(u, v, f), err, acc, sp: S.sprite(acc ? scene3.rA : scene3.rW, 9), lab: S.label(text, acc ? 'accent' : ''), size: acc ? 20 : 15 });
    });
    const mid = picked.target < 0 && page.middle(m, data.f);
    if (mid && mid.u != null) {   // the target, at the photo's end of its line of sight: a dashed orange ring, "distance unknown" (none when it has no place this visit)
      scene3.beads.push({ u: mid.u, v: mid.v, f: .95, pos: at(mid.u, mid.v, .95), err: null, acc: true, sp: S.sprite(scene3.rAu, 9), lab: S.label(`${mid.name} · distance unknown`, 'accent'), size: 20, unknown: true });
    }
    scene3.beads.sort((a, b) => a.f - b.f).forEach((b, k) => { b.tier = k; });
    scene3.cloud.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); scene3.cloud.geometry.computeBoundingSphere();
    // what has a position and no distance: dashed rings by the photo
    const up = [];
    for (const src of ['sso', 'galaxies']) for (const o of unknownHere(src)) { const [u, v] = page.onScreen(m, o.ra, o.dec, null); up.push(...at(u, v, .95).toArray()); }
    scene3.unk.geometry.setAttribute('position', new THREE.Float32BufferAttribute(up, 3));
    // the scale marks: one decade of light-years per mark, at most three, spread out
    for (const k of scene3.marks) k.lab.remove();
    const dec = []; for (let x = Math.ceil(lo + .2); x <= Math.floor(hi - .1); x++) dec.push(x);
    const small = S.W < 500, near = dec.filter(x => scale(10 ** x) < (small ? .55 : .7));   // none by the photo, where its own label sits
    const pickD = near.length <= (small ? 2 : 3) ? near : small ? [near[0], near[near.length - 1]] : [near[0], near[Math.floor(near.length / 2)], near[near.length - 1]];
    scene3.marks = pickD.map(x => ({ f: scale(10 ** x), lab: S.label(lyText(10 ** x, false), 'mark') }));
    box.dataset.objects = String(all.length);
    box.dataset.rings = String(scene3.beads.length); box.dataset.dots = String(scene3.dots.length);
    shown = { rings: all.filter((_, i) => i === picked.target || picked.letters.has(i) || i === picked.named?.i).map(p => p.key), dots: scene3.dots.map(d => d.key), target: picked.target >= 0 ? all[picked.target].key : 'unknown',
      mark: (b => b ? { uv: [b.u, b.v], label: b.lab.el.textContent } : null)(scene3.beads.find(b => b.acc)) };   // the target's ring and its label, for tests
    photo();
    render();
  }
  function photo() {   // the region's photo for the visit on screen, as the beam's far end
    if (!scene3) return;
    const r = page.region(); if (!r) return;
    const mat = scene3.photo.material; box.dataset.photo = r.f.mjd.toFixed(4);   // which visit's photo (for tests)
    if (!mat.map || mat.map.image !== r.canvas) { mat.map?.dispose(); mat.map = new THREE.CanvasTexture(r.canvas); mat.map.colorSpace = THREE.SRGBColorSpace; mat.map.magFilter = THREE.NearestFilter; mat.map.minFilter = THREE.LinearFilter; mat.needsUpdate = true; }
    else mat.map.needsUpdate = true;
  }

  const q = V();
  function render() {
    if (!S || !open) return;
    S.size(); S.z = 1; S.camera.clearViewOffset();   // the fit below is of the unzoomed view
    const br = box.getBoundingClientRect();
    S.keep = (page.cover?.() ?? []).filter(Boolean).map(e => e.getBoundingClientRect()).filter(r => r.width && r.height)
      .map(r => [r.left - br.left, r.top - br.top, r.right - br.left, r.bottom - br.top]);
    S.placed = [];   // the names placed so far this frame
    const { W, H } = S, small = W < 500, T = yaw.t0 ? (performance.now() - yaw.t0) / 1000 : 9;
    const s = sm(T / 1.8);   // the swing: from through the telescope (the photo fills the view, as in Photo) out to the side
    const frame = small ? [14, 64, W - 20, H - 40] : [36, 110, W - 46, H - 70];
    const key = [V(-1.25 * CR, CR, 0), V(-1.25 * CR, -CR, 0), ...corners];
    const tilt = .6 + yaw.a, el = .2 + yaw.p;
    const to = S.fit(key, V(-Math.sin(tilt) * Math.cos(el), Math.sin(el), Math.cos(tilt) * Math.cos(el)), Y, small ? 22 : 20, frame);
    const eye = { pos: V(.02, 0, 0), tgt: V(L, 0, 0), fov: 2 * Math.atan(Math.max(hh, hw * H / W) / L) / D2R };
    const mid = V(1.6, .5, 3.2), k = 1 - s;
    S.aim({ pos: V().addScaledVector(eye.pos, k * k).addScaledVector(mid, 2 * k * s).addScaledVector(to.pos, s * s), tgt: eye.tgt.clone().lerp(to.tgt, s), up: Y, fov: eye.fov + (to.fov - eye.fov) * sm(s * 1.4) });
    // the zoom: the camera draws the part of that view it covers. Rings and the photo grow with it; names, lines and the
    // gaps between them stay their size on screen (S.pxAt is per screen px)
    if (Z.k > 1) { Z.x = Math.min(Z.x, W - W / Z.k); Z.y = Math.min(Z.y, H - H / Z.k); S.camera.setViewOffset(W, H, Z.x, Z.y, W / Z.k, H / Z.k); S.z = Z.k; }
    for (const [n, off] of [['in', Z.k >= 8], ['out', Z.k <= 1]]) { const bt = box.querySelector(`[data-zoom=${n}]`); if (bt) bt.disabled = off; }
    const a = sm((s - .45) / .4), la = sm((s - .8) / .2);
    const { guides, craft, beam, cloud, unk } = scene3;
    unk.material.size = 11 * S.z; craft.visible = s > .02; beam.material.opacity = .055 * a; cloud.material.opacity = (small ? .14 : .28) * a; cloud.material.size = small ? 2.5 : 4;   // a phone's narrower beam packs them closer unk.material.opacity = a;
    guides.begin();
    for (const c of corners) guides.seg(top, c, WHITE, .3 * a, .6 * a);
    corners.forEach((c, i) => guides.seg(c, corners[(i + 1) % 4], WHITE, .9 * a));
    for (const m of scene3.marks) {
      const r = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([u, v]) => at(u, v, m.f)); r.forEach((c, i) => guides.seg(c, r[(i + 1) % 4], WHITE, .2 * la));
      const p = V(L * m.f, -m.f * hh, m.f * hw), w = S.pxAt(p), t0 = p.clone().addScaledVector(Y, -4 * w), t1 = p.clone().addScaledVector(Y, -12 * w);
      guides.seg(t0, t1, WHITE, .7 * la); m.lab.at(t1, [0, 5, -.5, 0], la);
    }
    for (const b of scene3.beads) {
      const w = S.pxAt(b.pos), col = b.acc ? ACCENT : WHITE; b.sp.position.copy(b.pos); b.sp.scale.setScalar(w * b.size * S.z); b.sp.material.opacity = a;
      guides.seg(top, b.pos, col, .12 * a, .5 * a); guides.seg(b.pos, P(b.u, b.v), col, .5 * a, .25 * a);   // its line of sight, on to the photo
      if (b.err) {   // the distance's error, along the line of sight
        const e0 = at(b.u, b.v, b.err[0]), e1 = at(b.u, b.v, b.err[1]); guides.seg(e0, e1, col, la);
        for (const e of [e0, e1]) guides.seg(e.clone().addScaledVector(Y, 4 * w), e.clone().addScaledVector(Y, -4 * w), col, la);
      }
      // its name over the beam's upper edge, each on its own row, joined to the ring by a thin line
      const lift = q.set(b.pos.x, b.f * hh, b.pos.z).clone().addScaledVector(Y, ((small ? 6 : 9) + b.tier * (small ? 14 : 18)) * w);
      guides.seg(b.pos.clone().addScaledVector(Y, b.size / 2 * S.z * w), lift, col, .45 * la); b.lab.at(lift, [-3, -4, -1, -1], la);
    }
    guides.end();
    scene3.fixed[0].at(P(1, -1), [0, small ? 6 : 9, -1, 0], la); scene3.fixed[1].at(V(-CR * .6, -CR, 0), [0, small ? 6 : 10, -.5, 0], la);
    S.draw();
    if (T < 1.9) { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); }
  }

  return {
    // the patch or the visit on screen changed (or the picture: a toggle, a new frame)
    frame() {
      if (!open) return;
      const r = page.region(); if (!r) return;
      if (init()) photo();   // the far end shows this visit's photo straight away, whatever the catalogs answer
      const url = want(r.m, r.f);
      if (asked !== url) { asked = url; tries = 0; fetchNow(url, r.m, r.f); return; }
      // the target comes from two answers that land in either order: this one, and the verdict's match (SkyBoT's
      // passers, GET /api/known). A new match re-picks the target and redraws the list and the beam.
      if (data?.d && data.url === url && page.matchKey() !== pickedFor) { paintList(); build(); }
      else render();
    },
    show(on) {
      open = on; box.hidden = !on;
      if (!on) { cancelAnimationFrame(raf); return; }
      yaw.t0 = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : performance.now();
      this.frame(); if (data?.d && asked === data.url) build();
    },
    get data() { return data; }, get url() { return asked; }, get gl() { return gl; }, get shown() { return shown; },
    // for tests: the zoom and turn, the camera, and the target's ring on screen ([x, y, diameter] in client px)
    get view() { return { k: Z.k, x: Z.x, y: Z.y, a: yaw.a, p: yaw.p }; },
    get cam() { return S && [...S.camera.matrixWorld.elements, ...S.camera.projectionMatrix.elements]; },
    ringOf() {
      const b = scene3?.beads.find(x => x.acc); if (!b) return null;
      const r = box.querySelector('canvas').getBoundingClientRect(), [x, y] = S.px(b.pos), [x2, y2] = S.px(V().setFromMatrixColumn(S.camera.matrixWorld, 0).multiplyScalar(b.sp.scale.x / 2).add(b.pos));
      return [r.left + x, r.top + y, 2 * Math.hypot(x2 - x, y2 - y)];
    },
    screenOf(key) { const d = scene3?.dots.find(x => x.key === key); if (!d) return null; const [x, y] = S.px(d.pos), r = box.querySelector('canvas').getBoundingClientRect(); return [r.left + x, r.top + y]; },
  };
}
