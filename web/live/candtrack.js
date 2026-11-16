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
// so a reload or a shared link still draws the track
if (id) {
  const replace = history.replaceState.bind(history);
  history.replaceState = (state, title, url) => {
    if (url != null) { const u = new URL(url, location.href); for (const k of ['cand', 'sample']) if (P.has(k) && !u.searchParams.has(k)) u.searchParams.set(k, P.get(k)); url = u; }
    replace(state, title, url);
  };
}

export function draw(ctx, m, f, toPx, offset) {
  if (!cand) return;
  const G = m.grid, a = m.arcsec_per_pixel;
  const px = cand.detections.map(d => { const [e, n] = offset(m, d.ra, d.dec); return toPx((G - 1) / 2 - e / a, (G - 1) / 2 + n / a); });
  // the visit on screen: its first day to the end of its last; the ring goes on that visit's detection nearest its mean time
  const t0 = dayOf(f.start), t1 = dayOf(f.end ?? f.start) + 1;
  const inVisit = cand.detections.map((d, k) => [d, k]).filter(([d]) => d.t >= t0 && d.t < t1).sort((p, q) => Math.abs(p[0].t - f.mjd) - Math.abs(q[0].t - f.mjd));
  for (const [c, w] of [['rgba(0,0,0,.85)', 4], ['#ff9a4d', 1.8]]) {
    ctx.strokeStyle = c; ctx.lineWidth = w; ctx.setLineDash([2, 5]);
    if (px.length > 1) { ctx.beginPath(); px.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); }
    ctx.setLineDash([]);
  }
  for (const [x, y] of px) { ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fillStyle = '#ff9a4d'; ctx.fill(); }
  const ring = inVisit.length ? px[inVisit[0][1]] : null;
  if (ring) for (const [c, w] of [['rgba(0,0,0,.85)', 6], ['#ff9a4d', 2.5]]) { ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath(); ctx.arc(ring[0], ring[1], 13, 0, 7); ctx.stroke(); }
  Object.assign(window.__cand, { ring, track: px, visit: f.start });
}

if (id) {
  const got = await load();
  cand = got?.data.candidates.find(c => c.id === id) ?? null;
  sample = !!got?.sample;
  if (cand) {
    // under Descriptions: what the detector says (it scrolls with the rest), then the votes, pinned below the scroll so
    // they show without scrolling
    const host = document.getElementById('vKnown').closest('p');
    const box = document.createElement('div'), head = document.createElement('p');
    head.className = 'pv-info cand-info';
    head.append(Object.assign(document.createElement('b'), { textContent: `${cand.id}${sample ? ' (sample)' : ''}` }),
      ` ${VERDICT[cand.verdict]} · score ${cand.score.toFixed(2)} · ${photos(cand)} · ${motion(cand)}. The dotted line is its track; the ring is where it was in this visit.`);
    host.after(head); host.closest('.pv-scroll').after(box);
    voter(cand, box);
    // phones show one tool card at a time: open on Info, where this is (after the page has wired its tabs)
    if (matchMedia('(max-width: 640px)').matches) setTimeout(() => document.querySelector('.pv-tabs [data-t=info]')?.click());
    if (!document.querySelector('link[href="candidates.css"]')) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'candidates.css' }));
  }
}
