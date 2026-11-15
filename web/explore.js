// Explore: the all-sky map. One Mollweide projection places everything so markers, the coverage replay
// and the heat map line up with data/sky.jpg (RA increases to the left, RA 0 in the middle).
// Data: data/coverage.{png,json} (built by bake/sky_assets.py), /api/comets and /api/explored (worker/).
const R2 = Math.SQRT2, RAD = Math.PI / 180;
const wrap = d => ((d + 180) % 360 + 360) % 360 - 180;

// map longitude (degrees, -180..180, positive right) and Dec -> [u, v] in 0..1 across the map
function fwdLon(lon, dec) {
  const lat = dec * RAD;
  let t = lat;
  for (let i = 0; i < 10 && Math.abs(dec) < 89.9; i++) t -= (2 * t + Math.sin(2 * t) - Math.PI * Math.sin(lat)) / (2 + 2 * Math.cos(2 * t));
  const x = (2 * R2 / Math.PI) * lon * RAD * Math.cos(t), y = R2 * Math.sin(t);
  return [(x + 2 * R2) / (4 * R2), (R2 - y) / (2 * R2)];
}
const fwd = (ra, dec) => fwdLon(wrap(-ra), dec);
// [u, v] -> [ra, dec], or null outside the oval
function inv(u, v) {
  const x = (u * 2 - 1) * 2 * R2, y = (1 - v * 2) * R2;
  if ((x / (2 * R2)) ** 2 + (y / R2) ** 2 > 1) return null;
  const th = Math.asin(y / R2), lon = Math.PI * x / (2 * R2 * Math.cos(th));
  return [((-lon / RAD) % 360 + 360) % 360, Math.asin((2 * th + Math.sin(2 * th)) / Math.PI) / RAD];
}
for (const [ra, dec] of [[0, 0], [77, 30.4], [266, -29], [181, 60], [179, -75]]) {   // projection round trip
  const [r2, d2] = inv(...fwd(ra, dec));
  console.assert(Math.abs(wrap(r2 - ra)) < 1e-3 && Math.abs(d2 - dec) < 1e-3, 'projection round trip failed', ra, dec);
}

const $ = id => document.getElementById(id);
const place = (el, ra, dec) => { const [u, v] = fwd(ra, dec); el.style.left = u * 100 + '%'; el.style.top = v * 100 + '%'; return u; };
const patchUrl = (ra, dec) => `timelapse.html?ra=${ra.toFixed(4)}&dec=${dec.toFixed(4)}&det=D1&diff=1`;
const getJson = url => fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(`${url}: HTTP ${r.status}`))));

// ---- grid and ecliptic ----
{
  const P = (lon, dec) => { const [u, v] = fwdLon(lon, dec); return (u * 2000).toFixed(1) + ' ' + (v * 1000).toFixed(1); };
  let d = '';
  for (let lon = -120; lon <= 120; lon += 60) for (let dec = -90; dec <= 90; dec += 3) d += (dec === -90 ? 'M' : 'L') + P(lon, dec);
  for (let dec = -60; dec <= 60; dec += 30) d += 'M' + P(-180, dec) + 'L' + P(180, dec);
  $('grat').setAttribute('d', d);
  const eps = 23.44 * RAD, pts = [];
  for (let l = 0; l < 360; l += 2) {
    const ra = Math.atan2(Math.cos(eps) * Math.sin(l * RAD), Math.cos(l * RAD)) / RAD;
    pts.push([wrap(-ra), Math.asin(Math.sin(eps) * Math.sin(l * RAD)) / RAD]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  $('ecl').setAttribute('d', pts.map((p, i) => (i ? 'L' : 'M') + P(p[0], p[1])).join(''));
}

// ---- click anywhere on the oval: drop a pin with a small card; "Look closer" opens that patch (difference view on) ----
const pin = $('pin'), readout = $('readout');
function showPin(ra, dec) {
  const u = place(pin, ra, dec), v = fwd(ra, dec)[1];
  pin.classList.toggle('left', u > 0.7);
  pin.classList.toggle('up', v > 0.62);
  pin.querySelector('[data-f=where]').textContent = `RA ${ra.toFixed(1)}\u00b0  Dec ${dec >= 0 ? '+' : ''}${dec.toFixed(1)}\u00b0`;
  pin.querySelector('[data-f=open]').href = patchUrl(ra, dec);
  pin.hidden = false;
  pin.querySelector('.pin-ring').style.animation = 'none'; void pin.offsetWidth; pin.querySelector('.pin-ring').style.animation = '';   // replay the drop
}
const skyAt = e => { const b = $('map').getBoundingClientRect(); return inv((e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height); };
$('map').addEventListener('click', e => { const rd = skyAt(e); if (rd) showPin(...rd); });
$('map').addEventListener('pointermove', e => {   // live coordinates beside the pointer (hidden on touch by CSS)
  const rd = skyAt(e);
  readout.hidden = !rd;
  if (rd) { readout.textContent = `${rd[0].toFixed(1)}\u00b0  ${rd[1] >= 0 ? '+' : ''}${rd[1].toFixed(1)}\u00b0`; readout.style.left = e.clientX + 16 + 'px'; readout.style.top = e.clientY + 16 + 'px'; }
});
$('map').addEventListener('pointerleave', () => { readout.hidden = true; });
$('pin-x').addEventListener('click', () => { pin.hidden = true; });
addEventListener('keydown', e => { if (e.key === 'Escape') pin.hidden = true; });
$('search').addEventListener('submit', e => {
  e.preventDefault();
  const [ra, dec] = $('q').value.trim().split(/[\s,]+/).map(Number);
  if (Number.isFinite(ra) && Number.isFinite(dec) && ra >= 0 && ra < 360 && Math.abs(dec) <= 90) showPin(ra, dec);
  else $('q').setCustomValidity('Type RA and Dec in degrees, e.g. 269.45 4.69'), $('q').reportValidity(), $('q').setCustomValidity('');
});

// ---- markers from /api/comets: comets people found (orange) and known objects (blue) ----
// Known comets move: their marker follows the JPL path in `track` ([[day, ra, dec, magnitude], ...] every 10 days)
// and shows only while the comet is bright enough to see (magnitude 16 or brighter).
const movers = [];
function followTracks(day) {
  for (const { el, track } of movers) {
    const i = Math.min(track.length - 2, Math.max(0, Math.floor(day / 10))), [d0, r0, c0, m0] = track[i], [d1, r1, c1, m1] = track[i + 1];
    const f = Math.min(1, Math.max(0, (day - d0) / (d1 - d0))), dr = ((r1 - r0 + 540) % 360) - 180;   // shortest way round in RA
    place(el, (r0 + f * dr + 360) % 360, c0 + f * (c1 - c0));
    const mag = m0 == null ? m1 : m1 == null ? m0 : m0 + f * (m1 - m0);
    const bright = mag != null && mag <= 16;
    // 3I/ATLAS stays findable as our measured comet, but dimmed while it is too faint to see; the rest hide
    if (el.dataset.always === '1') el.classList.toggle('faint', !bright); else el.hidden = !bright;
  }
}
let trailN = 0;
const cometsLoaded = getJson('/api/comets').then(({ comets }) => {
  const marks = $('marks'), card = $('card-comet');
  const votes = c => Object.values(c.tags || {}).reduce((a, b) => a + b, 0);
  const featured = comets.filter(c => c.kind === 'comet').sort((a, b) => votes(b) - votes(a))[0];
  for (const c of comets) {
    const a = document.createElement('a');
    a.className = `mk ${c.kind}`;
    a.dataset.day = c.day ?? 0;
    a.innerHTML = '<i></i>';
    if (c.kind === 'comet') {
      a.href = `comet.html?id=${encodeURIComponent(c.id)}`;
      a.style.setProperty('--tail', `${c.tail ?? -150}deg`);
      if (c.tags.comet / Math.max(1, votes(c)) < 0.6) a.classList.add('open');   // not settled yet: hollow marker
    } else a.setAttribute('aria-label', c.real ? `${c.id} (known comet)` : 'Known object (example)');
    if (c === featured) a.classList.add('sel');   // its name label is hidden while its card shows (styles.css)
    if (c.kind === 'known') a.href = `comet.html?id=${encodeURIComponent(c.id)}`;
    if (c.kind === 'comet' || c.real) { const b = document.createElement('b'); b.textContent = c.id; a.append(b); }
    if (c.kind === 'known' && c.real && c.id !== '3I/ATLAS') a.classList.add('peek');   // other known comets: name on hover
    if (c.track) { movers.push({ el: a, track: c.track }); if (c.detail?.photos || c.id === '3I/ATLAS') a.dataset.always = '1'; }
    if (c.kind === 'comet') {   // where it has been: a dotted trail behind the head, on the tail's side (heading is illustrative for example comets)
      const ang = (c.tail ?? -150) * RAD, L = 70 + (c.id.charCodeAt(c.id.length - 1) % 5) * 14, bend = (c.id.charCodeAt(c.id.length - 2) % 2 ? 1 : -1) * .45;
      const ex = Math.cos(ang) * L, ey = Math.sin(ang) * L, cx = Math.cos(ang + bend) * L * .6, cy = Math.sin(ang + bend) * L * .6, gid = 'tg' + (trailN++);
      a.insertAdjacentHTML('beforeend', `<svg class="trail" aria-hidden="true"><defs><linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}"><stop offset="0" stop-color="#ff9a4d" stop-opacity="1"/><stop offset="1" stop-color="#ff9a4d" stop-opacity="0"/></linearGradient></defs><path d="M0 0Q${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}" stroke="url(#${gid})"/></svg>`);
    }
    if (place(a, c.ra, c.dec) > 0.88) a.classList.add('left');   // label on the left only near the map's right edge
    marks.prepend(a);
  }
  followTracks(+$('time').value);
  if (featured) {
    const n = votes(featured), t = featured.tags;
    card.href = `comet.html?id=${encodeURIComponent(featured.id)}`;
    card.dataset.day = featured.day;
    card.querySelector('[data-f=id]').textContent = featured.id;
    card.querySelector('[data-f=count]').textContent = `${t.comet} of ${n} tags`;
    card.querySelector('.t-comet').style.setProperty('--n', t.comet);
    card.querySelector('.t-asteroid').style.setProperty('--n', t.asteroid);
    card.querySelector('.t-unsure').style.setProperty('--n', t.unsure + t.glitch);
    place(card, featured.ra, featured.dec);
    card.hidden = false;
  }
  showByDay();
}).catch(err => console.warn('comets unavailable', err));

// Back from a time-lapse: the browser may restore this page from memory, with the heat map from before; reload it
addEventListener('pageshow', e => { if (e.persisted) location.reload(); });

// ---- heat map from /api/explored: patch-sized cells people have checked (mint), the rest stay dark ----
const exploredLoaded = getJson('/api/explored').then(({ total, cells, suggest }) => {
  const cv = $('heat'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
  const level = n => (n >= 20 ? 3 : n >= 5 ? 2 : 1);
  for (const c of cells) {
    const lon0 = wrap(-c.ra_max), lon1 = lon0 + (c.ra_max - c.ra_min);   // keeps a cell whole where RA wraps at 180
    g.beginPath();
    [[lon0, c.dec_max], [lon1, c.dec_max], [lon1, c.dec_min], [lon0, c.dec_min]].forEach(([l, d], k) => {
      const [u, v] = fwdLon(l, d); k ? g.lineTo(u * W, v * H) : g.moveTo(u * W, v * H);
    });
    g.closePath();
    g.fillStyle = `rgba(95,224,173,${[0, .26, .5, .82][level(c.checks)]})`; g.fill();
    g.strokeStyle = 'rgba(4,6,11,.75)'; g.lineWidth = 1.5; g.stroke();
  }
  const fmt = n => n.toLocaleString('en-US');
  document.querySelector('[data-n=seen]').textContent = fmt(cells.length);
  document.querySelector('[data-n=total]').textContent = fmt(total);
  $('people-meter').style.setProperty('--p', cells.length / total * 100 + '%');

  const url = patchUrl(suggest.ra, suggest.dec), pin = document.createElement('a');
  pin.className = 'mk patch'; pin.href = url; pin.innerHTML = '<i></i><b>unexplored</b>';
  place(pin, suggest.ra, suggest.dec);
  $('marks').append(pin);
  const card = $('card-patch');
  place(card, suggest.ra, suggest.dec);
  card.querySelector('[data-f=where]').textContent = `RA ${suggest.ra.toFixed(1)}  Dec ${suggest.dec >= 0 ? '+' : ''}${suggest.dec.toFixed(1)}`;
  card.querySelector('[data-f=open]').href = url;
  $('go-unexplored').href = url;
}).catch(err => console.warn('explored unavailable', err));

// ---- phones: flip a name to the left of its marker when it would cover another name or dot, or run off screen ----
Promise.all([cometsLoaded, exploredLoaded]).then(() => {
  if (!matchMedia('(max-width: 640px)').matches) return;
  const box = el => el.getBoundingClientRect(), hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const marks = [...document.querySelectorAll('.mk')], dots = marks.map(m => box(m.querySelector('i'))), kept = [];
  for (const m of marks) {
    const b = m.querySelector('b');
    if (!b || !b.offsetWidth) continue;
    const bad = () => { const r = box(b); return r.left < 4 || r.right > innerWidth - 4 || kept.some(k => hit(r, k)) || dots.some((d, i) => marks[i] !== m && hit(r, d)); };
    if (bad()) { m.classList.toggle('left'); if (bad()) m.classList.toggle('left'); }
    kept.push(box(b));
  }
});

// ---- SPHEREx coverage replay ----
// visits.png (bake/sky_assets.py): for each 0.5 degree cell, the start day of up to 6 visits (bursts of photos).
// The visit days for every pixel of the oval are looked up once, so moving the slider only compares numbers.
// Each frame: never photographed = dark; photographed = a veil that clears with each pass; any visit in the last
// FRESH days glows, so SPHEREx's scanning strip keeps moving across the sky for the whole timeline.
// SPHEREx's two deep fields, on the ecliptic poles where every scan circle crosses: the densest time-lapses and the
// most complete spectra. Numbers come from the real photo counts (bake/sky_assets.py deep_fields); a click opens one.
function deepFields(fields) {
  for (const f of fields) {
    if (!(f.sky > 0)) continue;   // no typical count to compare against
    const a = document.createElement('a'), times = Math.round(f.photos / f.sky);
    a.className = 'mk deep';
    a.href = patchUrl(f.ra, f.dec);
    a.title = `${f.name}: SPHEREx photographs here about ${times}x as often as a typical patch (${Math.round(f.photos)} photos vs ${Math.round(f.sky)}). Click to open it.`;
    a.innerHTML = '<i></i>';
    const b = document.createElement('b'); b.textContent = `Deep field ${times}x`; a.append(b);
    place(a, f.ra, f.dec);
    $('marks').append(a);
  }
}

let showByDay = () => {};
(async () => {
  const img = new Image(); img.src = 'data/visits.png';
  const [meta] = await Promise.all([getJson('data/coverage.json'), img.decode()]);   // both at once
  deepFields(meta.deep_fields ?? []);
  const src = Object.assign(document.createElement('canvas'), { width: 720, height: 1080 }).getContext('2d', { willReadFrequently: true });
  src.drawImage(img, 0, 0);
  const px = src.getImageData(0, 0, 720, 1080).data;

  const cv = $('cover'), g = cv.getContext('2d'), W = cv.width, H = cv.height, K = 6, NONE = 65535;
  const inOval = new Uint8Array(W * H), visits = new Uint16Array(W * H * K).fill(NONE);
  let inside = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const rd = inv((i + .5) / W, (j + .5) / H);
    if (!rd) continue;
    inside++; inOval[j * W + i] = 1;
    const cell = Math.min(359, Math.floor((90 - rd[1]) / meta.step)) * 720 + Math.min(719, Math.floor(rd[0] / meta.step));
    for (let v = 0; v < K; v++) {   // block v>>1 of the stacked image: visit 2k low byte in R, 2k+1 in G, high bits in B
      const q = ((v >> 1) * 360 * 720 + cell) * 4, day = px[q + (v & 1)] | (((px[q + 2] >> ((v & 1) * 4)) & 15) << 8);
      if (day) visits[(j * W + i) * K + v] = day - 1;
    }
  }

  const out = g.createImageData(W, H), o = out.data, slider = $('time');
  const FRESH = 9;   // days a newly photographed strip stays lit up
  showByDay = () => {
    for (const el of document.querySelectorAll('[data-day]')) el.style.visibility = +el.dataset.day <= +slider.value ? '' : 'hidden';
    followTracks(+slider.value);
  };
  const VEIL = [232, 110, 45, 0];   // darkness by passes so far: none, 1, 2, 3+
  function draw() {
    const d = +slider.value, passes = new Uint32Array(K + 1);
    for (let k = 0, q = 0; k < inOval.length; k++, q += 4) {
      if (!inOval[k]) { o[q + 3] = 0; continue; }
      let n = 0, age = Infinity;
      for (let v = 0, b = k * K; v < K; v++) {
        const t = visits[b + v];
        if (t <= d) { n++; age = Math.min(age, d - t); }
      }
      passes[n]++;
      if (age < FRESH) { o[q] = 234; o[q + 1] = 241; o[q + 2] = 255; o[q + 3] = 90 * (1 - age / FRESH); }
      else { o[q] = 3; o[q + 1] = 5; o[q + 2] = 10; o[q + 3] = VEIL[Math.min(n, 3)]; }
    }
    g.putImageData(out, 0, 0);
    // share of the sky photographed at least p times (Mollweide is equal-area, so counting pixels counts sky fairly)
    const atLeast = p => { let c = 0; for (let n = p; n <= K; n++) c += passes[n]; return c / inside * 100; };
    const fmt = x => (x > 99.5 ? Math.floor(x) : Math.round(x)) + '%';
    let pass = 1;
    while (pass < K && atLeast(pass) >= 99) pass++;
    const pct = atLeast(1), now = atLeast(pass);
    const when = new Date((meta.mjd0 + d - 40587) * 864e5);
    $('t-date').textContent = when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    $('t-pct').textContent = pass === 1 ? `${fmt(pct)} photographed` : `Pass ${pass} · ${fmt(now)}`;
    slider.style.setProperty('--p', d / meta.days * 100 + '%');
    slider.parentNode.style.setProperty('--f', d / meta.days);
    $('t-bubble').textContent = $('t-date').textContent;
    $('photo-meter').style.setProperty('--p', pct + '%');
    $('photo-meter').querySelector('b').textContent = Math.floor(pct) + '%';
    showByDay();
  }
  slider.max = meta.days;
  slider.value = meta.days;
  let queued = 0;   // many input events can arrive per frame while dragging: draw once per frame
  slider.addEventListener('input', () => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; draw(); }); });
  draw();

  let timer = 0;
  const play = $('play');
  play.addEventListener('click', () => {
    if (timer) { clearInterval(timer); timer = 0; play.classList.remove('on'); return; }
    if (+slider.value >= meta.days) slider.value = 0;
    play.classList.add('on');
    timer = setInterval(() => { slider.value = +slider.value + 2; draw(); if (+slider.value >= meta.days) play.click(); }, 40);
  });
  document.body.dataset.ready = '1';
})();
