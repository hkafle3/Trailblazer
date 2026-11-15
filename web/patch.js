// Designed patch viewer. Frames come from a baked manifest or from the same live worker as timelapse.html.
// Comparison modes are the design's CSS (:has on the radios). This file paints the pixels and the flag.
import { POLES, cadenceText, deepField } from './skypos.js';
import { asteroidsAt, cometsAt, eastNorth, loadEph } from './known.js';

const TARGETS = [
  { key: 'barnard', name: "Barnard's Star" },
  { key: 'epsindib', name: 'Epsilon Indi B' },
  { key: 'wise0855', name: 'WISE 0855' },
  { key: 'rwaur', name: 'RW Aurigae' },
  { key: 'rdra', name: 'R Draconis' },
];
const $ = id => document.getElementById(id);
const P = new URLSearchParams(location.search);
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const when = s => s ? `${+s.slice(8, 10)} ${MONTH[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}` : '';
const frameLabel = f => when(f.start) + (f.time ? ` ${f.time}` : '') + (Number.isFinite(f.lam) ? ` · ${f.lam.toFixed(2)} µm` : '');

const state = {
  m: null,
  a: 0,
  b: 1,
  fov: Number(P.get('fov')) || 12,
  arm: 0,
  marks: [],
  play: 0,
  playing: false,
  resumed: false,
  eph: null,
  ephErr: false,
  sky: new Map(),
};

function parseCoords(text) {
  const parts = text.trim().replace(/^ra\s*/i, '').replace(/\s*dec\s*/i, ' ').split(/[\s,]+(?=[+-]?\d)/).map(t => t.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const sexa = (t, hours) => {
    const n = t.match(/[+-]?\d+(\.\d+)?/g); if (!n) return NaN;
    if (n.length === 1 && !/[hd:°]/i.test(t)) return Number(n[0]);
    const sign = t.trim().startsWith('-') ? -1 : 1, [a, b = 0, c = 0] = n.map(x => Math.abs(Number(x)));
    return sign * (a + b / 60 + c / 3600) * (hours ? 15 : 1);
  };
  const ra = sexa(parts[0], /[h:]/i.test(parts[0])), dec = sexa(parts[1], false);
  return Number.isFinite(ra) && Number.isFinite(dec) ? { ra, dec } : null;
}

function liveUrl(ra, dec, det) {
  const q = new URLSearchParams({ ra: ra.toFixed(4), dec: dec.toFixed(4), det });
  if ($('m-diff').checked) q.set('diff', '1');
  if (state.fov) q.set('fov', String(state.fov));
  return `patch.html?${q}`;
}

function fillPresets() {
  const sel = $('preset');
  for (const p of POLES) {
    const o = document.createElement('option');
    o.value = `live:${p.ra}:${p.dec}`;
    o.textContent = p.name;
    sel.append(o);
  }
  for (const t of TARGETS) {
    const o = document.createElement('option');
    o.value = `target:${t.key}`;
    o.textContent = t.name;
    sel.append(o);
  }
  const target = P.get('target');
  if (target) sel.value = `target:${target}`;
  else if (P.has('ra')) {
    const ra = Number(P.get('ra')), dec = Number(P.get('dec'));
    const pole = POLES.find(p => Math.abs(p.ra - ra) < 0.02 && Math.abs(p.dec - dec) < 0.02);
    if (pole) sel.value = `live:${pole.ra}:${pole.dec}`;
  }
  sel.onchange = () => {
    const [kind, a, b] = sel.value.split(':');
    if (kind === 'target') location.href = `patch.html?target=${a}`;
    else location.href = liveUrl(Number(a), Number(b), $('det').value);
  };
}

function decode(m) {
  for (const f of m.frames) {
    if (f.px || !f.data) continue;
    const b = atob(f.data), u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    f.px = new Float32Array(u.buffer);
  }
  let peak = 0;
  const G = m.grid;
  for (const f of m.frames) if (f.px && f.x != null) for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) {
    const v = f.px[r * G + c];
    if (Number.isFinite(v) && Math.hypot(c - f.x, G - 1 - r - f.y) < 3) peak = Math.max(peak, v);
  }
  m.hiDisplay = Math.max(m.stretch?.hi || 1, 0.8 * peak);
  return m;
}

function cropOf(m) {
  const full = m.grid * m.arcsec_per_pixel / 60;
  const fov = Math.min(full, Math.max(1, state.fov || full));
  const size = Math.min(m.grid, Math.max(8, Math.round(fov * 60 / m.arcsec_per_pixel)));
  return { o: Math.floor((m.grid - size) / 2), size, fov: size * m.arcsec_per_pixel / 60 };
}

function paint(canvas, frame, m, crop) {
  const { o, size } = crop, G = m.grid;
  const { lo, hi: fieldHi } = m.stretch || { lo: 0, hi: 1 };
  const hi = m.hiDisplay || fieldHi;
  const A = Math.asinh(10 * Math.max(1e-6, (hi - lo) / (fieldHi - lo || 1)));
  const img = new ImageData(size, size);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const v = frame.px[(r + o) * G + (c + o)];
    const j = 4 * (r * size + c);
    if (!Number.isFinite(v)) { img.data.set([22, 26, 34, 255], j); continue; }
    const x = Math.asinh(Math.max(0, (v - lo) / (fieldHi - lo || 1)) * 10) / A;
    const g = Math.min(1, x) * 255;
    img.data.set([g, g * 0.97, g * 0.92, 255], j);
  }
  canvas.width = size; canvas.height = size;
  canvas.getContext('2d').putImageData(img, 0, 0);
}

function fmtCoord(ra, dec) {
  return `RA ${ra.toFixed(1)}  Dec ${dec >= 0 ? '+' : ''}${dec.toFixed(1)}`;
}

function setCadence(ra, dec) {
  const el = $('cadence');
  el.hidden = false;
  el.textContent = deepField(ra, dec) ? 'High-cadence deep field' : 'Fewer frames here';
  el.title = cadenceText(ra, dec);
  el.style.color = deepField(ra, dec) ? 'var(--people)' : '#ffc285';
}

function markerPos(m, crop, east, north) {
  const c0 = (m.grid - 1) / 2, pix = m.arcsec_per_pixel;
  return [(c0 - east / pix - crop.o) / crop.size * 100, (c0 - north / pix - crop.o) / crop.size * 100];
}

function skyKey(m, frame) {
  return `${m.ra.toFixed(4)},${m.dec.toFixed(4)},${Number(frame.mjd).toFixed(2)}`;
}

function inFrame(m, body) {
  const [east, north] = eastNorth(m.ra, m.dec, body.ra, body.dec);
  const c0 = (m.grid - 1) / 2, pix = m.arcsec_per_pixel;
  const x = c0 - east / pix, y = c0 - north / pix;
  if (!(x >= 0 && y >= 0 && x <= m.grid - 1 && y <= m.grid - 1)) return null;
  return { name: body.name, east, north, mag: body.mag };
}

function median(values) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

function frameNoise(frame, grid) {
  if (frame._noise) return frame._noise;
  const fin = [], q = (grid - 36) / 2;
  for (let y = q; y < q + 36; y++) for (let x = q; x < q + 36; x++) {
    const v = frame.px[y * grid + x];
    if (Number.isFinite(v)) fin.push(v);
  }
  const m0 = median(fin);
  const noise = 1.4826 * median(fin.map(v => Math.abs(v - m0))) || 1;
  frame._noise = { m0, noise };
  return frame._noise;
}

// Same 3× noise bar as the centered star, and the same stretch as the picture.
// The peak must sit within 2 pixels (10″) of the catalog position, so a bright
// star nearby is not counted as this body. A 3× peak that the stretch paints
// as sky does not get a circle.
function sourceAt(frame, m, east, north) {
  if (!frame?.px) return { visible: false, snr: 0 };
  const grid = m.grid, c0 = (grid - 1) / 2;
  const x0 = c0 - east / m.arcsec_per_pixel, y0 = c0 - north / m.arcsec_per_pixel;
  if (!(x0 >= 0 && y0 >= 0 && x0 <= grid - 1 && y0 <= grid - 1)) return { visible: false, snr: 0 };
  const { m0, noise } = frameNoise(frame, grid);
  let peak = -Infinity, sat = 0, n = 0;
  const r = 2;
  for (let y = Math.max(0, Math.floor(y0 - r)); y <= Math.min(grid - 1, Math.ceil(y0 + r)); y++) {
    for (let x = Math.max(0, Math.floor(x0 - r)); x <= Math.min(grid - 1, Math.ceil(x0 + r)); x++) {
      if ((x - x0) ** 2 + (y - y0) ** 2 > r * r) continue;
      const v = frame.px[y * grid + x];
      n++;
      if (!Number.isFinite(v)) sat++;
      else if (v > peak) peak = v;
    }
  }
  if (n && sat > 0.5 * n) return { visible: true, snr: Infinity };
  const snr = Number.isFinite(peak) ? (peak - m0) / noise : 0;
  const { lo, hi: fieldHi } = m.stretch || { lo: 0, hi: 1 };
  const hi = m.hiDisplay || fieldHi;
  const span = fieldHi - lo || 1;
  const A = Math.asinh(10 * Math.max(1e-6, (hi - lo) / span));
  const gray = Math.min(1, Math.asinh(Math.max(0, (peak - lo) / span) * 10) / A) * 255;
  // 3× noise is a detection. It still has to survive the same stretch as the picture,
  // or the circle lands on a pixel the eye reads as sky.
  return { visible: snr > 3 && gray >= 40, snr };
}

function bodiesFor(m, frame) {
  if (!frame || !Number.isFinite(frame.mjd)) return { comets: [], asteroids: [], error: '', source: '' };
  const sky = state.sky.get(skyKey(m, frame));
  // SkyBoT is an n-body cone, so it wins when it answers. The baked two-body orbit
  // is drawn only when SkyBoT does not answer, and it can sit arcminutes off.
  if (!sky) return { comets: [], asteroids: [], error: '', source: '' };
  const mark = list => (list || []).filter(b => {
    const c0 = (m.grid - 1) / 2, pix = m.arcsec_per_pixel;
    const x = c0 - b.east / pix, y = c0 - b.north / pix;
    return x >= 0 && y >= 0 && x <= m.grid - 1 && y <= m.grid - 1;
  }).map(b => ({ ...b, ...sourceAt(frame, m, b.east, b.north) }));
  if (!sky.error) {
    const place = (list, kind) => mark((list || []).map(b => ({ ...inFrame(m, b), kind })).filter(b => b.name));
    return { comets: place(sky.comets, 'comet'), asteroids: place(sky.asteroids, 'asteroid'), error: '', source: 'skybot' };
  }
  const comets = state.eph ? cometsAt(state.eph, m.ra, m.dec, frame.mjd) : [];
  return { comets: mark(comets), asteroids: [], error: sky?.error || '', source: 'mpc' };
}

function shortName(name) {
  return String(name).replace(/\s*\([^)]*\)$/, '');
}

function catalogPhrase(list, none, noun) {
  const on = list.filter(b => b.visible), off = list.filter(b => !b.visible);
  const names = on.map(b => shortName(b.name)).join(', ');
  const hidden = off.length === 1
    ? `${shortName(off[0].name)} catalogued, not visible in this exposure`
    : `${off.length} ${noun} catalogued, none visible in this exposure`;
  if (on.length && off.length) return `${names} · ${hidden}`;
  if (on.length) return names;
  if (off.length) return hidden;
  return none;
}

function catalogLine(m, frame) {
  if (!frame || !Number.isFinite(frame.mjd)) return 'This frame has no time, so the catalogs cannot be placed';
  const { comets, asteroids, error, source } = bodiesFor(m, frame);
  if (!source && !error) return state.ephErr ? 'Comet catalog did not load' : 'Checking catalogs…';
  if (state.ephErr && error) return 'Comet catalog did not load · ' + error;
  if (error) {
    const on = comets.filter(b => b.visible);
    return on.length
      ? `SkyBoT is not answering. Baked orbit: ${on.map(c => shortName(c.name)).join(', ')}`
      : 'SkyBoT is not answering. No baked comet is visible in this exposure';
  }
  return `${catalogPhrase(comets, 'no catalog comet', 'comets')} · ${catalogPhrase(asteroids, 'no asteroid at mag 21 or brighter', 'asteroids')}`;
}

function catalogTitle(m, frame) {
  const fallback = 'A circle is drawn only when this exposure is brighter than the sky at that position.';
  if (!frame) return fallback;
  const { comets, asteroids } = bodiesFor(m, frame);
  const off = [...comets, ...asteroids].filter(b => !b.visible && Number.isFinite(b.snr));
  if (off.length !== 1) return fallback;
  const b = off[0];
  if (!(b.snr > 3)) return `${shortName(b.name)} is ${b.snr.toFixed(1)}× the noise in this exposure. A circle needs 3×, and the pixel has to show against the stars.`;
  return `${shortName(b.name)} is above the noise, but too faint to see in this picture.`;
}

function knownLayer(host, m, frame, crop) {
  host.replaceChildren();
  if (!m || !frame) return;
  if (!String(m.key || '').startsWith('live-')) {
    const name = document.createElement('span');
    name.className = 'kn';
    name.style.left = '50%';
    name.style.top = '50%';
    name.innerHTML = `<b>${m.name}</b>`;
    host.append(name);
  }
  const { comets, asteroids } = bodiesFor(m, frame);
  for (const b of [...comets, ...asteroids].filter(b => b.visible)) {
    const el = document.createElement('span');
    el.className = `kn ${b.kind === 'comet' ? 'comet' : 'ast'}`;
    const [left, top] = markerPos(m, crop, b.east, b.north);
    el.style.left = left + '%';
    el.style.top = top + '%';
    el.title = b.name;
    const lab = document.createElement('b');
    const short = b.name.replace(/\s*\([^)]*\)$/, '');
    lab.textContent = b.mag ? `${short}  ${b.mag}` : short;
    el.append(lab);
    host.append(el);
  }
}

function visibleFrames() {
  const m = state.m;
  if (!m?.frames.length) return [];
  if ($('m-play').checked) return [m.frames[Math.min(m.frames.length - 1, Math.max(0, state.play))]];
  return [m.frames[state.a], m.frames[state.b]].filter(Boolean);
}

let catToken = 0, catTimer = 0;
function paintKnown() {
  const m = state.m;
  if (!m?.frames.length) return;
  const crop = cropOf(m);
  const frames = visibleFrames();
  if ($('m-play').checked) {
    knownLayer($('known-a'), m, frames[0], crop);
    knownLayer($('known-b'), m, null, crop);
    placeFlag($('known-a'), state.marks.find(k => k.frame === state.play), crop);
  } else {
    knownLayer($('known-a'), m, frames[0], crop);
    knownLayer($('known-b'), m, frames[1], crop);
    placeFlag($('known-a'), state.marks.find(k => k.which === 'a' && k.frame === state.a), crop);
    placeFlag($('known-b'), state.marks.find(k => k.which === 'b' && k.frame === state.b), crop);
  }
  const focus = $('m-play').checked ? frames[0] : frames[1] || frames[0];
  $('known-chip').textContent = catalogLine(m, focus);
  $('known-chip').title = catalogTitle(m, focus);
}

function scheduleCatalog() {
  const token = ++catToken;
  paintKnown();
  clearTimeout(catTimer);
  catTimer = setTimeout(() => { ensureCatalog(token); }, 120);
}

async function ensureCatalog(token) {
  const m = state.m;
  if (!m) return;
  if (!state.eph && !state.ephErr) {
    try { state.eph = await loadEph(); }
    catch { state.ephErr = true; }
  }
  if (token !== catToken) return;
  paintKnown();
  for (const f of visibleFrames()) {
    if (!Number.isFinite(f?.mjd)) continue;
    const key = skyKey(m, f);
    if (!state.sky.has(key)) state.sky.set(key, await asteroidsAt(m.ra, m.dec, f.mjd));
    if (token !== catToken) return;
    paintKnown();
  }
}

function placeFlag(host, mark, crop) {
  if (!mark) return;
  const el = document.createElement('span');
  el.className = `flagmark ${mark.which}`;
  el.style.left = ((mark.x - crop.o) / crop.size * 100) + '%';
  el.style.top = ((mark.y - crop.o) / crop.size * 100) + '%';
  host.append(el);
}

function assignFrame(n) {
  const m = state.m;
  if ($('m-play').checked && state.playing) { state.play = clampPlay(n); showPlaying(state.play); return; }
  const last = m.frames.length - 1;
  if ($('pick-b').checked) {
    state.b = n === 0 ? Math.min(1, last) : n;
    if (state.a >= state.b) state.a = state.b - 1;
  } else {
    state.a = n === last ? Math.max(0, last - 1) : n;
    if (state.b <= state.a) state.b = Math.min(last, state.a + 1);
  }
  state.play = n;
  state.marks = [];
  state.saved = null;
  try { sessionStorage.removeItem(flagKey(m)); } catch {}
  render();
}

let playTimer = 0;
function stopPlay() {
  state.playing = false;
  clearInterval(playTimer);
}

function timePos(m, mjd) {
  const a = m.frames[0].mjd, b = m.frames.at(-1).mjd;
  if (!(b > a) || !Number.isFinite(mjd)) return m.frames.length < 2 ? 0 : null;
  return Math.min(1, Math.max(0, (mjd - a) / (b - a)));
}

function endLabel(f, spanDays) {
  const day = when(f.start);
  return spanDays < 2 && f.time ? `${day} ${f.time}` : day;
}

function spanOn() { return $('play-span').checked; }

function playLo() { return spanOn() ? state.a : 0; }
function playHi() { return spanOn() ? state.b : state.m.frames.length - 1; }

function clampPlay(n) {
  if (!spanOn()) return n;
  return Math.min(playHi(), Math.max(playLo(), n));
}

function playDelay() {
  return 1000 / Math.max(0.5, +$('speed').value || 2);
}

function paintWindow() {
  const el = $('tl-window');
  if (!spanOn() || !state.m) { el.classList.remove('on'); return; }
  const x0 = frameAt(state.m, state.a) * 100;
  const x1 = frameAt(state.m, state.b) * 100;
  el.style.left = x0 + '%';
  el.style.width = Math.max(0.8, x1 - x0) + '%';
  el.classList.add('on');
}

function frameAt(m, n) {
  const at = timePos(m, m.frames[n].mjd);
  return at == null ? n / Math.max(1, m.frames.length - 1) : at;
}

function drawTimeline(m) {
  const host = $('tl-ticks');
  host.replaceChildren();
  const span = m.frames.at(-1).mjd - m.frames[0].mjd;
  $('tl-start').textContent = endLabel(m.frames[0], span);
  $('tl-end').textContent = endLabel(m.frames.at(-1), span);
  const width = Math.max(240, $('viewer').clientWidth);
  const bins = [];
  m.frames.forEach((f, n) => {
    const x = frameAt(m, n);
    const px = x * width;
    const last = bins.at(-1);
    if (last && px - last.px0 < 8) { last.n1 = n; last.count++; last.px1 = px; }
    else bins.push({ n0: n, n1: n, count: 1, px0: px, px1: px, x });
  });
  for (const bin of bins) {
    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'tl-tick' + (bin.count > 1 ? ' crowd' : '');
    tick.style.left = (((bin.px0 + bin.px1) / 2 / width) * 100) + '%';
    tick.dataset.n0 = String(bin.n0);
    tick.dataset.n1 = String(bin.n1);
    tick.title = bin.count === 1
      ? frameLabel(m.frames[bin.n0])
      : `${bin.count} photos, ${endLabel(m.frames[bin.n0], span)} – ${endLabel(m.frames[bin.n1], span)}`;
    tick.onclick = ev => { ev.stopPropagation(); seek(bin.n0); };
    host.append(tick);
  }
}

function moveTimeline(n) {
  const m = state.m, f = m.frames[n];
  const p = frameAt(m, n) * 100;
  $('tl-fill').style.width = p + '%';
  $('tl-head').style.left = p + '%';
  $('tl-now').textContent = frameLabel(f).replace(/ · [\d.]+ µm$/, '');
  for (const tick of $('tl-ticks').children) {
    const n0 = +tick.dataset.n0, n1 = +tick.dataset.n1;
    tick.classList.toggle('here', n >= n0 && n <= n1);
  }
}

function seek(n) {
  if (!$('m-play').checked) $('m-play').click();
  state.play = state.playing ? clampPlay(n) : n;
  if (state.playing) showPlaying(state.play);
  else showFrame(state.play, 'Paused');
}

function showFrame(n, role) {
  const m = state.m;
  if (!m?.frames.length) return;
  n = Math.min(m.frames.length - 1, Math.max(0, n));
  const f = m.frames[n];
  paint($('cv-a'), f, m, cropOf(m));
  $('cap-role').textContent = role;
  $('cap-a').textContent = frameLabel(f);
  moveTimeline(n);
  paintWindow();
  scheduleCatalog();
  const thumbs = $('strip').children;
  for (let i = 0; i < thumbs.length; i++) thumbs[i].classList.toggle('playhead', role === 'Playing' && i === n);
  const el = thumbs[n], strip = $('strip');
  if (!el) return;
  const top = el.offsetTop, bot = top + el.offsetHeight;
  if (top < strip.scrollTop) strip.scrollTop = Math.max(0, top - 8);
  else if (bot > strip.scrollTop + strip.clientHeight) strip.scrollTop = bot - strip.clientHeight + 8;
}

function showPlaying(n) { showFrame(n, 'Playing'); }

function syncPlayBtn() {
  const btn = $('play-toggle');
  btn.textContent = state.playing ? 'Pause' : (state.resumed ? 'Resume' : 'Play');
  btn.setAttribute('aria-pressed', String(state.playing));
}

function pauseFilm() {
  state.playing = false;
  state.resumed = true;
  clearInterval(playTimer);
  syncPlayBtn();
  if (state.m) showFrame(state.play, 'Paused');
}

function armPlay() {
  state.playing = false;
  state.resumed = false;
  clearInterval(playTimer);
  syncPlayBtn();
  if (state.m) render();
}

function startPlay() {
  if (!state.m?.frames.length) return;
  clearInterval(playTimer);
  state.playing = true;
  syncPlayBtn();
  if (state.play < playLo() || state.play > playHi()) state.play = playLo();
  showPlaying(state.play);
  playTimer = setInterval(() => {
    state.play = state.play >= playHi() ? playLo() : state.play + 1;
    showPlaying(state.play);
  }, playDelay());
}

function render() {
  const m = state.m;
  if (!m || !m.frames.length) return;
  if (state.b >= m.frames.length) state.b = m.frames.length - 1;
  if (state.a >= state.b) state.a = Math.max(0, state.b - 1);
  const crop = cropOf(m);
  const fa = m.frames[state.a], fb = m.frames[state.b];
  if (!state.playing) {
    paint($('cv-a'), fa, m, crop);
    paint($('cv-b'), fb, m, crop);
    $('cap-role').textContent = 'Earlier';
    $('cap-a').textContent = frameLabel(fa);
    $('cap-b').textContent = frameLabel(fb);
  }
  $('where').textContent = fmtCoord(m.ra, m.dec);
  document.title = `${m.name} · Comet Hunt`;
  setCadence(m.ra, m.dec);
  const arcmin = crop.fov;
  const bar = Math.min(1, 2 / arcmin);
  $('scale').style.width = (bar * 100) + '%';
  $('scale').textContent = bar < 0.98 ? '2′' : `${arcmin.toFixed(arcmin < 10 ? 1 : 0)}′`;
  $('fov').max = String(Math.ceil(m.grid * m.arcsec_per_pixel / 60));
  $('fov').value = String(state.fov);
  paintRange($('fov'));
  $('fov-label').textContent = `${(+state.fov).toFixed(state.fov < 10 ? 1 : 0)}′`;
  const strip = $('strip');
  const keep = strip.scrollTop;
  strip.replaceChildren();
  m.frames.forEach((f, n) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = frameLabel(f);
    btn.className = 'thumb' + (n === state.a ? ' earlier' : n === state.b ? ' later' : '');
    const c = document.createElement('canvas');
    paint(c, f, m, crop);
    btn.append(c, document.createTextNode(`${+f.start.slice(8, 10)} ${MONTH[+f.start.slice(5, 7) - 1]}`));
    btn.classList.toggle('playhead', state.playing && n === state.play);
    btn.onclick = () => assignFrame(n);
    strip.append(btn);
  });
  strip.scrollTop = keep;
  drawTimeline(m);
  if (state.playing) showPlaying(state.play);
  else if ($('m-play').checked) showFrame(state.play, 'Paused');
  else scheduleCatalog();
  facts(m, fa, fb);
  showFlag(m, fa, fb);
}

function facts(m, fa, fb) {
  const hours = fa.mjd && fb.mjd ? Math.abs(fb.mjd - fa.mjd) * 24 : 0;
  const star = m.motion && m.motion.total ? `${m.motion.total.toFixed(1)}″/yr` : '—';
  $('facts').innerHTML = `
    <div class="fact" title="Time between the two photos"><b>${hours ? (hours < 48 ? hours.toFixed(1) + ' h' : (hours / 24).toFixed(0) + ' d') : '—'}</b><span>apart</span></div>
    <div class="fact" title="Frames in this blink"><b>${m.frames.length}</b><span>frames</span></div>
    <div class="fact" title="Motion fitted to the centered source, when the bake measured one"><b>${star}</b><span>centered source</span></div>`;
}

function flagKey(m) {
  return `flag:${m.ra.toFixed(3)}:${m.dec.toFixed(3)}:${m.detector || ''}`;
}

function showFlag(m, fa, fb) {
  const saved = state.saved;
  const out = $('flag-out');
  if (!saved) { out.replaceChildren(); return; }
  const hours = Math.abs(fb.mjd - fa.mjd) * 24;
  const sep = Math.hypot(saved.x1 - saved.x0, saved.y1 - saved.y0) * m.arcsec_per_pixel;
  const rate = hours > 0 ? sep / hours : 0;
  const pace = rate >= 0.5 ? `${rate.toFixed(1)}″/hour` : `${(rate * 24).toFixed(2)}″/day`;
  out.innerHTML = `<p><b>Unverified.</b> ${sep.toFixed(0)}″ between the clicks${hours ? `, about ${pace}` : ''}. Not a discovery.</p>`;
}

function armFlag() {
  state.arm = 1;
  state.marks = [];
  state.saved = null;
  $('viewer').classList.add('arming');
  $('flag-help').textContent = 'Click the dot in the earlier photo.';
  $('flag-arm').textContent = 'Cancel';
  render();
}

function onPlate(which, ev) {
  if (!state.arm || !state.m) return;
  const crop = cropOf(state.m);
  const b = ev.currentTarget.getBoundingClientRect();
  const u = (ev.clientX - b.left) / b.width, v = (ev.clientY - b.top) / b.height;
  const x = crop.o + u * crop.size, y = crop.o + v * crop.size;
  if (state.arm === 1 && which === 'a') {
    state.marks = [{ which: 'a', frame: state.a, x, y }];
    state.arm = 2;
    $('flag-help').textContent = 'Click the same dot in the later photo.';
  } else if (state.arm === 2 && which === 'b') {
    state.marks.push({ which: 'b', frame: state.b, x, y });
    const a = state.marks[0];
    state.saved = { x0: a.x, y0: a.y, x1: x, y1: y, a: state.a, b: state.b };
    try { sessionStorage.setItem(flagKey(state.m), JSON.stringify(state.saved)); } catch {}
    state.arm = 0;
    $('viewer').classList.remove('arming');
    $('flag-help').textContent = 'Click the same dot in the earlier photo, then in the later one. The mark stays unverified.';
    $('flag-arm').textContent = 'Mark again';
  }
  render();
}

let job = null;
function paintRange(el) {
  const min = +el.min, max = +el.max;
  const p = max > min ? ((+el.value - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--p', Math.min(100, Math.max(0, p)) + '%');
}

function setBusy(text) {
  $('patch').classList.remove('ready');
  $('load').hidden = false;
  $('loadbar').hidden = false;
  $('status').textContent = text;
  const fill = $('load-fill');
  const m = String(text).match(/(\d+)\s+of\s+(\d+)/);
  if (m && +m[2] > 0) {
    fill.classList.remove('indeterminate');
    fill.style.width = Math.min(100, (+m[1] / +m[2]) * 100) + '%';
  } else {
    fill.classList.add('indeterminate');
    fill.style.width = '';
  }
}

function setReady(text) {
  $('patch').classList.add('ready');
  $('loadbar').hidden = true;
  $('load-fill').classList.remove('indeterminate');
  $('load').hidden = !text;
  $('status').textContent = text || '';
}

function setStatus(text) {
  $('loadbar').hidden = true;
  $('load-fill').classList.remove('indeterminate');
  $('load').hidden = !text;
  $('status').textContent = text || '';
}

function openManifest(m) {
  stopPlay();
  state.m = decode(m);
  state.sky = new Map();
  state.play = 0;
  state.a = 0;
  state.b = Math.max(1, m.frames.length - 1);
  try { state.saved = JSON.parse(sessionStorage.getItem(flagKey(m)) || 'null'); } catch { state.saved = null; }
  if (state.saved?.a != null && state.saved.a < m.frames.length && state.saved.b < m.frames.length) {
    state.a = state.saved.a;
    state.b = state.saved.b;
  }
  if (state.saved) {
    state.marks = [
      { which: 'a', frame: state.a, x: state.saved.x0, y: state.saved.y0 },
      { which: 'b', frame: state.b, x: state.saved.x1, y: state.saved.y1 },
    ];
  }
  if (m.detector && $('det').querySelector(`option[value="${m.detector}"]`)) $('det').value = m.detector;
  const hash = location.hash.slice(1);
  const mode = hash ? $(`m-${hash}`) : null;
  if (mode && !mode.checked) mode.click();
  else if ($('m-play').checked) armPlay();
  render();
}

async function openTarget(key) {
  setBusy('Opening this patch…');
  const m = await fetch(`data/flip/${key}/manifest.json`).then(r => { if (!r.ok) throw new Error('missing'); return r.json(); });
  openManifest(m);
  setReady('');
}

function openLive(ra, dec, det) {
  job?.terminate();
  setBusy('Finding SPHEREx images of this spot…');
  $('where').textContent = fmtCoord(ra, dec);
  setCadence(ra, dec);
  const w = job = new Worker('live/pipeline.js', { type: 'module' });
  w.onmessage = ({ data: msg }) => {
    if (w !== job) return;
    if (msg.type === 'progress') setBusy(msg.text + '…');
    else if (msg.type === 'frame') setBusy(`Building frame ${msg.n + 1} of ${msg.of}…`);
    else if (msg.type === 'empty') { setStatus(`No SPHEREx images of this spot on ${det} yet. Try another detector, or a challenge star above.`); w.terminate(); }
    else if (msg.type === 'error') { setStatus(`${msg.error}. The challenge stars in the menu open without a search.`); w.terminate(); }
    else if (msg.type === 'done') {
      w.terminate(); job = null;
      openManifest(msg.manifest);
      setReady(`${msg.manifest.frames.length} frames at ${msg.manifest.lam0.toFixed(2)} µm. Each exposure is its own picture.`);
    }
  };
  w.postMessage({ ra, dec, det, api: '' });
}

fillPresets();
if (/^D[1-6]$/.test(P.get('det'))) $('det').value = P.get('det');
$('det').onchange = () => {
  if (!state.m) return;
  location.href = liveUrl(state.m.ra, state.m.dec, $('det').value);
};
$('search').onsubmit = e => {
  e.preventDefault();
  const c = parseCoords($('q').value);
  if (!c || !(c.ra >= 0 && c.ra < 360) || !(c.dec >= -90 && c.dec <= 90)) {
    setStatus('Type RA and Dec, for example 270 66.56 or 18h +66d');
    return;
  }
  location.href = liveUrl(c.ra, c.dec, $('det').value);
};
$('contrast').oninput = e => {
  document.body.style.setProperty('--contrast', e.target.value / 100);
  paintRange(e.target);
};
$('play-toggle').onclick = () => { if (state.playing) pauseFilm(); else startPlay(); };
$('speed').oninput = e => {
  paintRange(e.target);
  const n = +e.target.value;
  $('speed-label').textContent = `${n < 1 ? n.toFixed(1) : n}/s`;
  if (state.playing) startPlay();
};
$('play-span').onchange = () => {
  paintWindow();
  if (state.playing) startPlay();
};
$('fov').oninput = e => {
  state.fov = +e.target.value;
  paintRange(e.target);
  const q = new URLSearchParams(location.search);
  q.set('fov', String(state.fov));
  history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
  if (state.m) render();
};
function setFlagMin(min) {
  $('flagbox').classList.toggle('min', min);
  $('flag-min').textContent = min ? 'Show' : 'Minimize';
  $('flag-min').setAttribute('aria-expanded', String(!min));
  try { sessionStorage.setItem('flagbox-min', min ? '1' : '0'); } catch {}
}
$('flag-min').onclick = () => setFlagMin(!$('flagbox').classList.contains('min'));
try { if (sessionStorage.getItem('flagbox-min') === '1') setFlagMin(true); } catch {}
$('flag-arm').onclick = () => {
  if (state.arm) {
    state.arm = 0;
    $('viewer').classList.remove('arming');
    $('flag-arm').textContent = 'Start two clicks';
    $('flag-help').textContent = 'Click the same dot in the earlier photo, then in the later one. The mark stays unverified.';
    return;
  }
  armFlag();
};
$('plate-a').onclick = e => onPlate('a', e);
$('plate-b').onclick = e => onPlate('b', e);
document.querySelectorAll('input[name=mode]').forEach(el => el.addEventListener('change', () => {
  const id = document.querySelector('input[name=mode]:checked')?.id?.slice(2);
  if (id && id !== 'side') history.replaceState(null, '', `${location.pathname}${location.search}#${id}`);
  else history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (id === 'play') armPlay();
  else { stopPlay(); syncPlayBtn(); if (state.m) render(); }
}));
document.addEventListener('keydown', e => {
  if (e.code !== 'Space' || e.target.matches('input, textarea, select')) return;
  e.preventDefault();
  if ($('m-play').checked) $('play-toggle').click();
  else $('m-play').click();
});
$('tl-track').onclick = ev => {
  if (!state.m?.frames.length) return;
  const r = ev.currentTarget.getBoundingClientRect();
  const x = (ev.clientX - r.left) / r.width;
  let best = 0, gap = Infinity;
  state.m.frames.forEach((f, n) => {
    const at = timePos(state.m, f.mjd);
    const p = at == null ? n / Math.max(1, state.m.frames.length - 1) : at;
    const d = Math.abs(p - x);
    if (d < gap) { gap = d; best = n; }
  });
  seek(best);
};

if (P.get('diff') === '1') $('m-diff').checked = true;
const hashMode = location.hash.slice(1);
if (hashMode) $(`m-${hashMode}`)?.click();
if (TARGETS.some(t => t.key === P.get('target'))) openTarget(P.get('target')).catch(() => setStatus('That baked target is missing.'));
else if (P.has('ra') && P.has('dec')) openLive(Number(P.get('ra')), Number(P.get('dec')), $('det').value);
else location.replace(liveUrl(POLES[0].ra, POLES[0].dec, 'D1'));
