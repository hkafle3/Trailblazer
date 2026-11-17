// "Discuss this" on the time-lapse (timelapse.html), about the page's target in the visit on screen (page.place:
// timelapse.html targetAt): the dot in the middle, or a detector candidate's detection. Its place is what the sheet
// shows, centres its thumbnail on, checks for earlier reports and submits; with no place this visit it does not open.
// - Undiscovered: Ming's state box opens the sheet in place of the right column (his Descriptions card, discuss.css).
//   If SkyBoT puts a known object within 1 arcmin in this visit, the sheet leads with "It's <name>" / "Something else".
//   Post creates a candidate (POST /api/candidates) and opens its page.
// - Already reported here in this visit (GET /api/candidates/near): Ming's Discovered state, "Found as <id>", whose
//   arrow opens that candidate's page.
// Everything that reaches the page from the network or the person is set with textContent.
const NEAR = 60;   // arcsec: the known-object match radius (the server uses the same 1 arcmin for duplicates)
const D2R = Math.PI / 180, MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NAME = /^[A-Za-z0-9 _.-]{1,24}$/;   // the API's rule for names (comet.js)
const TAGS = [['comet', 'Comet'], ['asteroid', 'Asteroid'], ['glitch', 'Glitch'], ['unsure', 'Not sure'], ['star', 'Star']];
const GO = '<span class="go" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 12h16M14 6l6 6-6 6"/></svg></span>';
const ARROW = '<svg class="ic" aria-hidden="true"><use href="icons.svg#arrow"/></svg>';
const visitDate = s => `${MONTH[+s.slice(5, 7) - 1]} ${+s.slice(8, 10)}, ${s.slice(0, 4)}`;
const dayMonth = mjd => { const d = new Date((mjd - 40587) * 864e5); return `${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const sepArcsec = (r1, d1, r2, d2) => 3600 / D2R * Math.acos(Math.min(1, Math.sin(d1 * D2R) * Math.sin(d2 * D2R) + Math.cos(d1 * D2R) * Math.cos(d2 * D2R) * Math.cos((r1 - r2) * D2R)));
const ago = ms => { const m = (Date.now() - ms) / 6e4; return m < 60 ? `${Math.max(1, Math.round(m))} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function userName() {
  let n = window.CH_USER?.name;
  if (!n) try { n = JSON.parse(localStorage.getItem('ch.user'))?.name; } catch {}
  n = typeof n === 'string' ? n.trim() : '';
  return NAME.test(n) ? n : null;
}

// The closest known object SkyBoT predicts within NEAR arcsec of (ra, dec) at any exposure time of frame f, or null
export function knownMatch(f, ra, dec) {
  let best = null;
  for (const [name, b] of f.known?.bodies ?? []) for (const [t, r, d] of b.pts) {
    const s = sepArcsec(ra, dec, r, d);
    if (s <= NEAR && (!best || s < best.sep)) best = { name, kind: b.kind, mag: b.mag, t, sep: s };
  }
  return best;
}

// page: { state, api, setFound(id, at), found() -> id, spot(ra, dec) -> key, status(text),
//   place(f) -> { name, sky: [ra, dec] or null, px: [x, y] on the photo's canvas or null } }
export function discuss(page) {
  const { state } = page, $ = id => document.getElementById(id);
  const stateBox = $('state'), stage = $('stage');
  let near = { key: null, list: [] }, mine = null, sheet = null, openOn = null, ts = null;
  const skyOf = (m, f) => page.place(f).sky;

  // ---------- Discovered: a candidate already reported within 1 arcmin of the target in the visit on screen ----------
  async function loadNear(m, sky) {
    const key = `${m.key}|${page.spot(...sky)}`;
    near = { key, list: [] };
    try {
      const r = await fetch(`${page.api}/api/candidates/near?ra=${sky[0].toFixed(4)}&dec=${sky[1].toFixed(4)}`);
      if (r.ok && near.key === key) near.list = (await r.json()).candidates;
    } catch {}
    if (near.key === key) frame(true);
  }
  function showFound(m, f) {
    // a found= link to a candidate (the address keeps the Discovered state) is that candidate's, so it follows the visit
    if (page.found() && page.found() !== mine && near.list.some(x => x.id === page.found())) mine = page.found();
    // the same visit: one that shares a day with this one (its first day can differ by channel and detector)
    const c = near.list.find(x => x.visit <= (f.end ?? f.start) && (x.visit_end ?? x.visit) >= f.start);
    if (c && (!page.found() || page.found() === mine)) {
      if (page.found() !== c.id) page.setFound(c.id, page.spot(...skyOf(m, f)));
      mine = c.id;
      stateBox.href = `candidate.html?id=${encodeURIComponent(c.id)}`;
      const n = $('vName'), t = c.tags, votes = t.comet + t.asteroid + t.glitch + t.unsure + (t.star ?? 0);
      n.querySelector('.by')?.remove();
      n.append(el('span', 'by', `${c.author}, ${ago(c.created_at)} · ${votes} tag${votes === 1 ? '' : 's'}`));
    } else if (!c && mine && page.found() === mine) { page.setFound(null); mine = null; }
  }

  // called after every draw: a new spot asks the server once; a new visit re-reads the answer
  let last = [null, null];
  function frame(force = false) {
    const m = state.m; if (!m) return;
    const f = m.frames[state.i], sky = skyOf(m, f);
    if (sky && near.key !== `${m.key}|${page.spot(...sky)}`) loadNear(m, sky);
    // the open sheet follows the target: a later SkyBoT answer can move it or make another object the match
    if (sheet && openOn && openOn[0] === m && openOn[1] === f && keyOf(f) !== openKey) follow(m, f);
    else if (sheet && openOn && !offered && openOn[0] === m && openOn[1] === f && !started()) offer(m, f);   // a late SkyBoT answer
    if (!force && last[0] === m && last[1] === f) return;
    last = [m, f];
    if (sheet && openOn && (openOn[0] !== m || openOn[1] !== f)) close();   // the sheet describes one spot in one visit
    if (sky) showFound(m, f);
    else if (mine && page.found() === mine) { page.setFound(null); mine = null; }   // no target this visit: nothing found here
  }

  // ---------- the sheet ----------
  stateBox.addEventListener('click', e => {
    if (page.found() || !state.m || state.mode === 'sky') return;   // Discovered: Ming's link to the page
    e.preventDefault();
    open();
  });

  function build() {
    const form = el('form', 'pv-talkwrap'); form.id = 'talk'; form.noValidate = true;
    form.innerHTML = `<section class="pv-card pv-desc pv-talk" aria-labelledby="talk-h">
        <h2 id="talk-h">Discuss<button class="close" type="button" aria-label="Close"><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg></button></h2>
        <div class="thumb"><canvas width="728" height="420"></canvas><span class="ring" aria-hidden="true"></span></div>
        <p class="pv-info" data-f="where"></p>
        <div class="match" hidden>
          <p class="pv-info"><span class="kdot" aria-hidden="true"></span><b data-f="kname"></b><br><span data-f="kwhat"></span></p>
          <div class="answers"><button class="example" type="button" data-f="its"><span></span>${ARROW}</button><button class="example" type="button" data-f="else"><span>Something else</span>${ARROW}</button></div>
        </div>
        <div class="talk-form">
          <fieldset class="tags"><legend class="sr-only">Tag</legend>${TAGS.map(([k, t]) =>
            `<label class="pv-row" style="--c:var(--${k})"><input class="cbx" type="radio" name="tag" value="${k}"><span>${t}</span></label>`).join('')}</fieldset>
          <textarea class="box" maxlength="1000" aria-label="Comment" placeholder="Add a comment (optional)"></textarea>
          <p class="pv-info" data-f="as">As <b></b></p>
          <input class="box nick" maxlength="24" placeholder="Your nickname" aria-label="Your nickname" autocomplete="nickname">
          <div class="cf-turnstile" data-theme="dark" data-size="flexible" data-appearance="interaction-only"></div>
        </div>
        <p class="pv-info" data-f="note" role="status"></p>
      </section>
      <button class="pv-state pv-post" type="submit" disabled><span>Post</span>${GO}</button>`;
    (stateBox.closest('.pstage > *') ?? stateBox).after(form);   // a card of the stage's own (the button sits in Report's section)
    const q = s => form.querySelector(s), ts0 = q('.cf-turnstile');
    // Turnstile: the always-pass test key locally, to match worker/.dev.vars; loaded once, the first time the sheet opens
    ts0.dataset.sitekey = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? '1x00000000000000000000AA' : '0x4AAAAAAGBTgXAx-fdK_qGx';
    ts = ts0;
    if (!document.querySelector('script[src*="turnstile"]')) document.head.append(Object.assign(document.createElement('script'), { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js', async: true }));
    q('.close').onclick = close;
    form.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    form.addEventListener('input', sync); form.addEventListener('change', sync);
    q('[data-f=else]').onclick = () => { offered = true; q('.match').hidden = true; q('.talk-form').hidden = false; sync(); q('.cbx').focus(); };
    q('[data-f=its]').onclick = logSighting;
    form.onsubmit = e => { e.preventDefault(); post(); };
    window.addEventListener('ch:user', sync);
    return form;
  }
  const q = s => sheet.querySelector(s);
  const author = () => userName() || q('.nick').value.trim();
  function sync() {
    const name = userName(), plain = !q('.talk-form').hidden;
    q('[data-f=as]').hidden = !name; q('[data-f=as] b').textContent = name ?? '';
    q('.nick').hidden = !!name;
    q('.pv-post').hidden = !plain;
    q('.pv-post').disabled = sheet.dataset.busy === '1' || !q('[name=tag]:checked') || !NAME.test(author());
  }
  const say = (text, err) => { const n = q('[data-f=note]'); n.textContent = text; n.classList.toggle('err', !!err); };

  async function open() {
    const m = state.m, f = m.frames[state.i], tg = page.place(f);
    if (!tg.sky) return page.status(`${tg.name} has no detection in this visit, so there is nothing to report here.`);
    sheet ??= build();
    page.opening?.();   // the page closes any other card that takes the same place
    page.stop();   // the sheet is about this visit: playback would move on and close it
    openOn = [m, f, tg.sky]; offered = false;
    document.body.classList.add('talking');
    thumb(tg);
    const where = q('[data-f=where]'), [ra, dec] = tg.sky;
    where.replaceChildren(el('b', null, visitDate(f.start)), ` · ${m.detector} ${f.lam.toFixed(3)} µm`, el('br'),
      'RA ', el('b', null, (ra % 360).toFixed(4)), ' Dec ', el('b', null, `${dec >= 0 ? '+' : ''}${dec.toFixed(4)}`));
    say('');
    q('.match').hidden = true; q('.talk-form').hidden = false; sync();
    q('.close').focus();
    // SkyBoT's answers for this visit come in after the frames (timelapse.html knownFor): wait for them, a little
    for (let t = 0; t < 40 && f.known?.left > 0 && openOn?.[1] === f; t++) await new Promise(r => setTimeout(r, 250));
    if (openOn?.[1] !== f) return;
    if (offer(m, f)) q('[data-f=its]').focus();
  }
  // the thumbnail: the photo on screen around the target, ringed at the thumbnail's middle
  let openKey = null;   // the target the sheet shows: its place, and the passer matched and when (keyOf)
  const keyOf = f => { const t = page.place(f), k = t.id?.pass.match; return JSON.stringify([t.pos, k?.name ?? null, k?.t ?? null]); };
  function thumb(tg) {
    const c = q('.thumb canvas'), g = c.getContext('2d'), p = $('patch'), w = p.width * .49, h = w * c.height / c.width;
    const [cx, cy] = tg.px ?? [p.width / 2, p.height / 2];
    g.imageSmoothingEnabled = false; g.clearRect(0, 0, c.width, c.height);
    g.drawImage(p, cx - w / 2, cy - h / 2, w, h, 0, 0, c.width, c.height);
    q('.thumb').dataset.at = `${cx.toFixed(1)},${cy.toFixed(1)}`;   // the crop's middle on the photo (for tests)
    openKey = keyOf(openOn[1]);
  }
  // the target moved or changed while the sheet is open: a new thumbnail, and the offer again unless the person has
  // started on the form
  function follow(m, f) {
    thumb(page.place(f));
    if (started()) return;
    q('.match').hidden = true; q('.talk-form').hidden = false; offered = false; sync();
    offer(m, f);
  }
  // "It's X": the passer the page's verdict put on the dot (timelapse.html identityAt, live/identity.js). SkyBoT's answers can land after
  // the sheet opened, so frame() asks again on every redraw until it is offered or the person has started on the form.
  let offered = false;
  function offer(m, f) {
    const k = page.middle ? page.middle(f) : knownMatch(f, m.ra, m.dec);
    if (!k) return false;
    offered = true;
    q('[data-f=kname]').textContent = k.name;
    q('[data-f=kwhat]').textContent = `${k.kind === 'comet' ? 'Comet' : 'Asteroid'}${k.mag != null ? ` · mag ${k.mag}` : ''} · predicted here ${dayMonth(k.t)}`;
    q('[data-f=its] span').textContent = `It's ${k.name}`;
    q('[data-f=its]').dataset.name = k.name;
    q('.match').hidden = false; q('.talk-form').hidden = true; sync();
    return true;
  }
  const started = () => !!sheet.querySelector('[name=tag]:checked') || !!sheet.querySelector('textarea')?.value.trim();
  function close() {
    document.body.classList.remove('talking');
    openOn = null;
    if (sheet?.contains(document.activeElement)) stateBox.focus();
  }

  const spotBody = () => {
    const [m, f, [ra, dec]] = openOn;
    return { ra: +(ra % 360).toFixed(4), dec: +dec.toFixed(4), det: m.detector, ...(m.channel != null ? { channel: m.channel + 1 } : {}),
      visit: { start: f.start, end: f.end ?? f.start, mjd: f.mjd, exposures: f.exposures, lam: f.lam, ...(f.epochs ? { epochs: f.epochs } : {}) } };
  };
  async function send(path, body) {
    sheet.dataset.busy = '1'; sync();
    try {
      const r = await fetch(`${page.api}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `Could not post (${r.status})`);
      return out;
    } finally { sheet.dataset.busy = ''; sync(); }
  }
  async function logSighting() {
    const name = q('[data-f=its]').dataset.name, [m, f] = openOn;
    // only the match the page has now: a stale offer is refreshed, not logged
    if (page.middle(f)?.name !== name || keyOf(f) !== openKey) { follow(m, f); return say('The match changed with a later answer. Check it again.', true); }
    try {
      await send('/api/sightings', { ...spotBody(), name, author: userName() || 'guest' });
      close();
      page.status(`Logged as ${name}`);
    } catch (err) { say(err.message, true); }
  }
  async function post() {
    sync();
    if (q('.pv-post').disabled) return;
    const token = window.turnstile?.getResponse?.() || q('[name=cf-turnstile-response]')?.value;
    if (!token) return say('One moment, checking you are human…', true);
    try {
      const out = await send('/api/candidates', { ...spotBody(), tag: q('[name=tag]:checked').value, body: q('textarea').value, author: author(), turnstile: token });
      location.href = `candidate.html?id=${encodeURIComponent(out.id)}`;
    } catch (err) {
      say(err.message, true);
      window.turnstile?.reset?.();   // a token works once
    }
  }
  return { frame, close, body: () => openOn && spotBody() };   // body: what Post would submit (for tests)
}
