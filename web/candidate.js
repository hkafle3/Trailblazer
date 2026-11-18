// Candidate page: a dot someone reported from a time-lapse (GET /api/comets/:id, a comets row with candidate: true).
// The frames are built here the way the time-lapse builds them (live/pipeline.js), cut to the middle 2 arcmin.
// Everything from the API is set with textContent.
import { fwd } from './skymap.js';
import { userName } from './discuss.js';
import { CHANNELS } from './live/spectral.js';
import { thenAndNow } from './thenandnow.js';
import { designation } from './live/blink.js';
const $ = id => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const visitDate = s => `${MONTH[+s.slice(5, 7) - 1]} ${+s.slice(8, 10)}, ${s.slice(0, 4)}`;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const TAG_NAME = { comet: 'comet', asteroid: 'asteroid', glitch: 'glitch', unsure: 'not sure', star: 'star' };
const CROP = 25;   // grid pixels (5 arcsec each) around the spot: about 2 arcmin
function ago(ms) {
  const m = (Date.now() - ms) / 6e4;
  if (m < 60) return `${Math.max(1, Math.round(m))} min`;
  if (m < 1440) return `${Math.round(m / 60)} h`;
  if (m < 10080) return `${Math.round(m / 1440)} d`;
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
// Explore's rule (explore.js): unsettled until at least 5 tags and 60% of them say comet
const settled = t => { const n = t.comet + t.asteroid + t.glitch + t.unsure + (t.star ?? 0); return n >= 5 && t.comet / n >= 0.6; };
// a star lead: at least 3 tags and 60% of them say star (never "Likely comet" for a star)
const starLead = t => { const n = t.comet + t.asteroid + t.glitch + t.unsure + (t.star ?? 0); return n >= 3 && (t.star ?? 0) / n >= 0.6; };
const statusOf = t => (starLead(t) ? 'Star' : settled(t) ? 'Likely comet' : 'Candidate');
let context = null;   // what the baked blink adds about the spot (its region, distance), when there is one
const fmtDate = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function head(c) {
  const star = starLead(c.tags), name = star ? designation(c.ra, c.dec) : c.id;
  document.title = `${name} · Trailblazer`;
  $('c-id').textContent = name;
  status(c);
  if (star) {   // credit: the reporter and date, then how many others tagged it a star (their latest tag; not the reporter)
    const latest = new Map(); for (const m of c.comments) if (m.tag) latest.set(m.author, m.tag);
    const others = [...latest].filter(([a, t]) => t === 'star' && a !== c.author).length;
    $('c-by').replaceChildren('Reported by ', el('b', null, c.author), ` · ${fmtDate(c.created_at)}`,
      ...(others ? [el('span', 'also', `${others} other${others === 1 ? '' : 's'} tagged it a star`)] : []));
  } else
    $('c-by').replaceChildren('Reported by ', el('b', null, c.author), ` · ${fmtDate(c.created_at)} · visit `, el('b', null, visitDate(c.visit)), ' · ', el('b', null, c.det));
  const lapse = $('c-lapse');
  const ch = c.detail?.candidate?.channel;
  lapse.href = `timelapse.html?ra=${c.ra.toFixed(4)}&dec=${c.dec.toFixed(4)}&det=${c.det}${ch ? `&ch=${ch}` : ''}&blink=${encodeURIComponent(c.id)}${star ? '&view=thenandnow' : ''}`;
  const [u, v] = fwd(c.ra, c.dec);
  $('c-dot').style.left = u * 100 + '%'; $('c-dot').style.top = v * 100 + '%';
  $('c-find').href = `explore.html?focus=${encodeURIComponent(c.id)}&day=${c.day ?? 0}`;
  where(c);
}
function status(c) {
  const st = statusOf(c.tags), wrap = $('c-status-wrap');
  $('c-status').textContent = st === 'Star' && context?.region ? `Star · ${context.region}` : st;
  wrap.classList.toggle('has-dot', st !== 'Candidate');
  wrap.style.setProperty('--c', st === 'Star' ? '#e3d58f' : 'var(--comet)');   // the star tag's colour (styles.css; ui.css reuses --star for white)
}
function where(c) {
  $('c-radec').replaceChildren('RA ', el('b', null, c.ra.toFixed(4)), ' Dec ', el('b', null, `${c.dec >= 0 ? '+' : '−'}${Math.abs(c.dec).toFixed(4)}`),
    ...(context?.distance_ly ? [el('br'), `About ${context.distance_ly.toLocaleString('en-US')} light-years away`] : []));
}

function talk(c) {
  for (const [k, n] of Object.entries(c.tags)) { const e = document.querySelector(`[data-t=${k}]`); if (e) e.textContent = n; }   // a tag this page has no row for is skipped
  status(c);
  const said = c.comments.filter(m => m.body);   // a tag alone is a vote: counted above, no box
  $('c-talk').replaceChildren(...said.map(m => {
    const box = el('section', 'pv-frame post'), who = el('p', 'pv-info');
    who.append(el('b', null, m.author), ` · ${ago(m.created_at)}`);
    if (m.tag) { const t = el('span', 'lg', TAG_NAME[m.tag]); t.style.setProperty('--c', `var(--${m.tag})`); t.prepend(el('i')); who.append(t); }
    box.append(who, el('p', 'body', m.body));
    return box;
  }));
  if (!said.length) $('c-talk').append(el('p', 'pv-info', 'No comments yet.'));
}

// the spot at each visit: the time-lapse's own pipeline, the middle CROP pixels, the dot ringed where it was measured
function frames(c) {
  // the channel it was reported at (detail.candidate.channel, 1 to 102), as the time-lapse built it; older candidates
  // have none and get the detector's best-covered wavelength, as before
  const ch = CHANNELS[(c.detail?.candidate?.channel ?? 0) - 1];
  const box = $('c-frames'), note = $('c-frames-note');
  const w = new Worker('live/pipeline.js', { type: 'module' });
  const fail = text => { note.textContent = text; w.terminate(); };
  w.onerror = e => { e.preventDefault(); fail('Frames unavailable right now.'); };
  w.onmessage = ({ data: m }) => {
    if (m.type === 'empty') return fail(`No SPHEREx images of this spot${ch ? ` in channel ${ch.n + 1}` : ` on ${c.det}`}.`);
    if (m.type === 'error') return fail('Frames unavailable right now.');
    if (m.type !== 'done') return;
    w.terminate();
    const man = m.manifest, G = man.grid, x0 = Math.round((G - CROP) / 2), { lo, hi } = man.stretch, A = Math.asinh(10);
    box.replaceChildren(...man.frames.map(f => {
      const fig = el('figure'), plate = el('div', 'pv-mini'), cv = el('canvas'), g = cv.getContext('2d');
      cv.width = cv.height = CROP;
      const img = g.createImageData(CROP, CROP);
      for (let r = 0; r < CROP; r++) for (let k = 0; k < CROP; k++) {
        const v = f.px[(x0 + r) * G + x0 + k], j = 4 * (r * CROP + k);
        const s = Number.isFinite(v) ? Math.min(1, Math.asinh(Math.max(0, (v - lo) / (hi - lo)) * 10) / A) : 0.09;
        img.data.set([255 * s, 247 * s, 235 * s, 255], j);
      }
      g.putImageData(img, 0, 0);
      const end = c.detail?.candidate?.visit?.end ?? c.visit, reported = f.start <= end && (f.end ?? f.start) >= c.visit;   // shares a day with it
      const ring = el('span', reported ? 'ring' : 'ring earlier');   // the reported visit orange, the others blue
      const fx = f.x ?? (G - 1) / 2, fy = f.y ?? (G - 1) / 2;
      ring.style.left = (fx - x0 + .5) / CROP * 100 + '%'; ring.style.top = (G - 1 - fy - x0 + .5) / CROP * 100 + '%';
      plate.append(cv, ring);
      fig.append(plate, `${MONTH[+f.start.slice(5, 7) - 1]} ${f.start.slice(0, 4)}`);
      return fig;
    }));
    note.remove();
  };
  w.postMessage({ id: 1, ra: c.ra, dec: c.dec, det: ch?.detector ?? c.det, api: '', band: ch ? [ch.lo, ch.hi, ch.um] : null });
}

function composer(c) {
  const form = $('c-compose'), text = form.querySelector('textarea'), nick = form.querySelector('.nick'), btn = form.querySelector('button');
  let busy = false;
  const tag = () => document.querySelector('[name=tag]:checked')?.value;
  const author = () => userName() || nick.value.trim();
  const say = (msg, err) => { $('c-note').textContent = msg; $('c-note').classList.toggle('err', !!err); };
  const sync = () => {
    const name = userName();
    nick.hidden = !!name;
    if (name) { $('c-note').classList.remove('err'); if (!$('c-note').dataset.said) $('c-note').replaceChildren('As ', el('b', null, name)); }
    btn.disabled = busy || (!text.value.trim() && !tag()) || !/^[A-Za-z0-9 _.-]{1,24}$/.test(author());
  };
  form.addEventListener('input', sync); form.addEventListener('change', sync);
  document.querySelectorAll('[name=tag]').forEach(x => x.addEventListener('change', sync));
  window.addEventListener('ch:user', sync);
  sync();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (btn.disabled) return;
    const token = window.turnstile?.getResponse() || form.querySelector('[name=cf-turnstile-response]')?.value;
    if (!token) { $('c-note').dataset.said = '1'; return say('One moment, checking you are human…', true); }
    busy = true; sync();
    try {
      const t = tag();
      const r = await fetch('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comet_id: c.id, body: text.value, author: author(), turnstile: token, ...(t ? { tag: t } : {}) }) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `Could not post (${r.status})`);
      c.comments.push(out.comment); c.tags = out.tags;
      talk(c);
      text.value = ''; document.querySelectorAll('[name=tag]').forEach(x => { x.checked = false; });
      delete $('c-note').dataset.said; say('');
    } catch (err) {
      $('c-note').dataset.said = '1'; say(err.message, true);
    } finally {
      window.turnstile?.reset();   // a token works once
      busy = false; sync();
    }
  });
}

fetch(`/api/comets/${encodeURIComponent(id ?? '')}`).then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(c => {
  if (!c.candidate) return location.replace(`comet.html?id=${encodeURIComponent(c.id)}`);   // a comet with its own page
  head(c); talk(c); composer(c);
  // the blink: the reporter's spot, old survey against SPHEREx (baked for the showcase, else built here)
  thenAndNow($('tn'), { ra: c.ra, dec: c.dec, mode: 'page', onResult: r => {
    const ctx = Object.values(r).find(m => m.context)?.context;
    if (ctx && !context) { context = ctx; status(c); where(c); }
  } });
  frames(c);
}).catch(err => {
  console.warn(err);
  $('c-id').textContent = err === 404 ? 'Candidate not found' : 'Could not load this candidate';
  document.querySelector('.cpage .right').hidden = true;
  for (const s of ['#c-frames', '#c-compose', '#tn']) document.querySelector(s).closest('section, form').hidden = true;
});
