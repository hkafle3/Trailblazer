// Moving-object candidates from the detector (data/candidates.json, written by the detector; contract in docs/api.md
// "Candidates"). Shared by the Candidates page, Explore's Investigate layer and the time-lapse's track.
//   load()        -> { data, sample } or null when the detector has not run yet (no file). ?sample=1 loads
//                    data/candidates.sample.json instead, and every page says it is sample data.
//   lapseUrl(c)   the time-lapse on the candidate's first detection, its visit on screen, its track drawn (&cand=)
//   voter(c, el)  "Real mover / Glitch / Star" buttons: a vote is a tag on the comments thread at the first detection
//                 (POST /api/candidates, the time-lapse's "Discuss this"), with Turnstile as there
import { userName } from './discuss.js';
import { CHANNELS } from './live/spectral.js';
import { MJD0 } from './skymap.js';

export const SAMPLE = new URLSearchParams(location.search).get('sample') === '1';
export const VERDICT = { worth_reporting: 'Worth reporting', known: 'Known', glitch: 'Glitch', star: 'Star' };
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

export async function load() {
  const r = await fetch(SAMPLE ? 'data/candidates.sample.json' : 'data/candidates.json', { cache: 'no-cache' }).catch(() => null);
  if (!r?.ok) return null;
  const data = await r.json().catch(() => null);
  return data && Array.isArray(data.candidates) ? { data, sample: SAMPLE } : null;
}

// the five baked challenge targets open instantly; anywhere else is a live build at the first detection's time
const BAKED = { "Barnard's Star": 'barnard', 'Epsilon Indi B': 'epsindib', 'WISE 0855': 'wise0855', 'RW Aurigae': 'rwaur', 'R Draconis': 'rdra' };
export function lapseUrl(c) {
  const d = c.detections[0], key = BAKED[c.region], tail = `&cand=${encodeURIComponent(c.id)}${SAMPLE ? '&sample=1' : ''}`;
  return key ? `timelapse.html?target=${key}&day=${Math.max(0, Math.floor(d.t - MJD0))}${tail}`
    : `timelapse.html?ra=${d.ra.toFixed(4)}&dec=${d.dec.toFixed(4)}&det=${d.det}&t=${d.t}${tail}`;
}
export const photos = c => `${c.checks.n_photos} of ${c.checks.n_total} photos`;
export function motion(c) {
  const r = c.track?.rate_arcsec_hr, d = c.track?.distance_guess;
  return [r != null ? `${r < 10 ? r.toFixed(1) : Math.round(r)}″/hr` : null, d].filter(Boolean).join(' · ') || 'No motion measured';
}

// One Turnstile widget per page (interaction-only: unseen unless Cloudflare asks); each vote spends its token.
let widget = null;
function human() {
  if (widget) return widget;
  widget = Object.assign(document.createElement('div'), { className: 'cf-turnstile' });
  Object.assign(widget.dataset, { sitekey: LOCAL ? '1x00000000000000000000AA' : '0x4AAAAAAGBTgXAx-fdK_qGx', theme: 'dark', size: 'flexible', appearance: 'interaction-only' });
  document.body.append(widget);
  if (window.turnstile) window.turnstile.render(widget);
  else if (!document.querySelector('script[src*="turnstile"]')) document.head.append(Object.assign(document.createElement('script'), { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js', async: true }));
  return widget;
}
const token = () => widget?.querySelector('[name=cf-turnstile-response]')?.value || window.turnstile?.getResponse?.(widget);

// the tags the comments API knows: a real mover is an asteroid-like vote, a star is "not sure" with the word in the body
const VOTES = [['asteroid', 'Real mover'], ['glitch', 'Glitch'], ['unsure', 'Star']];
const NAME = /^[A-Za-z0-9 _.-]{1,24}$/;
function visit(c) {   // the visit as POST /api/candidates reads it: the detections' days, mean time and count
  const ts = c.detections.map(d => d.t), day = t => new Date((t - 40587) * 864e5).toISOString().slice(0, 10);
  const ch = CHANNELS.filter(x => x.detector === c.detections[0].det), lam = ch.reduce((a, x) => a + x.um, 0) / ch.length;
  return { start: day(Math.min(...ts)), end: day(Math.max(...ts)), mjd: +(ts.reduce((a, b) => a + b, 0) / ts.length).toFixed(5), exposures: ts.length, lam: +lam.toFixed(4), epochs: ts };
}
export function voter(c, box) {
  const off = SAMPLE && !LOCAL;   // sample candidates are made up: on the real site nobody votes on them
  box.classList.add('cvote');
  box.innerHTML = '<div class="cv-row"></div><input class="cv-nick" placeholder="Your name to vote" maxlength="24" aria-label="Your name to vote" hidden><p class="cv-note" role="status" aria-live="polite"></p>';
  const row = box.querySelector('.cv-row'), nick = box.querySelector('.cv-nick'), note = box.querySelector('.cv-note');
  const say = (t, err) => { note.textContent = t; note.classList.toggle('err', !!err); };
  for (const [tag, label] of VOTES) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'cv-b', textContent: label, disabled: off });
    b.dataset.tag = tag;
    b.addEventListener('click', () => send(tag, label, b));
    row.append(b);
  }
  if (off) return say('Sample data: voting is off');
  human();
  const sync = () => { nick.hidden = !!userName(); };
  sync(); addEventListener('ch:user', sync);
  async function send(tag, label, b) {
    const author = userName() || nick.value.trim();
    if (!NAME.test(author)) { nick.hidden = false; nick.focus(); return say('Add a name (letters and digits) to vote', true); }
    const t = token();
    if (!t) return say('One moment, checking you are human…', true);
    const d = c.detections[0];
    row.querySelectorAll('button').forEach(x => { x.disabled = true; });
    try {
      const r = await fetch('/api/candidates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        ra: +(d.ra % 360).toFixed(4), dec: +d.dec.toFixed(4), det: d.det, visit: visit(c), tag, body: `${label} (${c.id})`, author, turnstile: t }) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `Could not vote (${r.status})`);
      row.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      say(`Voted ${label.toLowerCase()}`);
      box.dataset.voted = out.id;   // the thread it went to (C-xxxx), for tests
    } catch (err) { say(err.message, true); }
    finally { window.turnstile?.reset?.(widget); row.querySelectorAll('button').forEach(x => { x.disabled = false; }); }
  }
}
