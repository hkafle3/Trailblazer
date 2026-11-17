// A detector candidate on the time-lapse (timelapse.html?…&cand=K-0001): its detections as a dotted track over the photo,
// a ring at the detection taken during the visit on screen, and the vote buttons under the patch's Descriptions.
// timelapse.html's draw() calls draw() below with its own projection (offset: the frames' TAN plane, toPx: grid to canvas),
// the same two the known-objects rings use, so the track sits where those would.
import { load, VERDICT, photos, motion, voter } from '../candidates-data.js';

const P = new URLSearchParams(location.search), id = P.get('cand');
let cand = null, sample = false;
const dayOf = s => Date.parse(s) / 864e5 + 40587;   // 'YYYY-MM-DD' -> MJD at 0h

// for tests: what was drawn last, in canvas pixels
window.__cand = { id, ring: null, track: [] };
// the page rewrites its address as the visit and channel change, naming only its own fields: keep &cand= (and &sample=, where it came from) in every rewrite
// so a reload or a shared link still draws the track, but only while the view is still the candidate's (same target, or same ra/dec);
// a move to another spot drops &cand= and takes the candidate's title, track and votes off the page
let leave = () => {}, here = true;
const near = (a, b) => a != null && b != null && Math.abs(+a - +b) < 1e-3;
const same = u => (P.has('target') ? u.get('target') === P.get('target') : near(u.get('ra'), P.get('ra')) && near(u.get('dec'), P.get('dec')));
if (id) {
  const replace = history.replaceState.bind(history);
  history.replaceState = (state, title, url) => {
    if (url != null) {
      const u = new URL(url, location.href);
      for (const k of here ? ['cand', 'sample'] : ['sample']) if (P.has(k) && !u.searchParams.has(k)) u.searchParams.set(k, P.get(k));
      if (!here) u.searchParams.delete('cand');
      url = u;
    }
    replace(state, title, url);
  };
}

// A tentative URL change can roll back after a failed search. Leave only when its frames are shown.
export function commit(url) {
  if (here && !same(new URL(url, location.href).searchParams)) { here = false; leave(); }
}

// the page's title while a candidate is open: a sample one says so, never the baked target's real name
export const title = () => (cand ? `${sample ? 'Sample candidate' : 'Candidate'} ${cand.id}` : null);
export const on = () => !!cand;

// where the candidate is in the visit on screen (its first day to the end of its last): the detection taken during it
// nearest its mean time, or null with none in it. The ring goes there, and the page's target is there (timelapse.html
// targetAt: Depth's marker, the mini-map's ring)
function inVisit(f) {
  const t0 = dayOf(f.start), t1 = dayOf(f.end ?? f.start) + 1;
  return cand.detections.filter(d => d.t >= t0 && d.t < t1).sort((p, q) => Math.abs(p.t - f.mjd) - Math.abs(q.t - f.mjd))[0] ?? null;
}
// that detection: { pos: [east, north] arcsec from the patch centre (offset: the frames' TAN plane), sky: [ra, dec] },
// or null with none in this visit
export function at(m, f, offset) {
  const d = cand && inVisit(f);
  return d ? { pos: offset(m, d.ra, d.dec), sky: [d.ra, d.dec] } : null;
}
export const isSample = () => !!cand && sample;

export function draw(ctx, m, f, toPx, offset) {
  if (!cand) return;
  const G = m.grid, a = m.arcsec_per_pixel;
  const px = cand.detections.map(d => { const [e, n] = offset(m, d.ra, d.dec); return toPx((G - 1) / 2 - e / a, (G - 1) / 2 + n / a); });
  for (const [c, w] of [['rgba(0,0,0,.85)', 4], ['#ff9a4d', 1.8]]) {
    ctx.strokeStyle = c; ctx.lineWidth = w; ctx.setLineDash([2, 5]);
    if (px.length > 1) { ctx.beginPath(); px.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); }
    ctx.setLineDash([]);
  }
  for (const [x, y] of px) { ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fillStyle = '#ff9a4d'; ctx.fill(); }
  const d = inVisit(f), ring = d ? px[cand.detections.indexOf(d)] : null;
  if (ring) for (const [c, w] of [['rgba(0,0,0,.85)', 6], ['#ff9a4d', 2.5]]) { ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath(); ctx.arc(ring[0], ring[1], 13, 0, 7); ctx.stroke(); }
  Object.assign(window.__cand, { ring, track: px, visit: f.start });
}

if (id) {
  const got = await load();
  cand = got?.data.candidates.find(c => c.id === id) ?? null;
  sample = !!got?.sample;
  if (cand) {
    // at the top of Descriptions: what the detector says, then the votes, so neither waits behind a scroll
    const scroll = document.querySelector('.pv-desc .pv-scroll');
    const box = document.createElement('div'), head = document.createElement('p');
    head.className = 'pv-info cand-info';
    if (sample) head.append(Object.assign(document.createElement('span'), { className: 'cand-sample', textContent: 'Sample data, made up to show the page. Not a real find.' }));
    head.append(Object.assign(document.createElement('b'), { textContent: title() }),
      ` ${VERDICT[cand.verdict]} · score ${cand.score.toFixed(2)} · ${photos(cand)} · ${motion(cand)}. The dotted line is its track; the ring is where it was in this visit.`);
    scroll.prepend(head, box);
    voter(cand, box);
    leave = () => { cand = null; head.remove(); box.remove(); document.body.classList.remove('cand', 'cand-sample'); Object.assign(window.__cand, { id: null, ring: null, track: [] }); };
    document.body.classList.add('cand', ...(sample ? ['cand-sample'] : []));
    document.title = `${title()} · Trailblazer`;
    for (const a of document.querySelectorAll('.topbar nav a')) a.classList.toggle('on', a.getAttribute('href') === 'candidates.html');
    // its votes are in Advanced: open it for this page (without changing what the drawer remembers), once the page has wired it
    setTimeout(() => window.__advOpen?.(true));
    if (!document.querySelector('link[href="candidates.css"]')) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'candidates.css' }));
  }
}
