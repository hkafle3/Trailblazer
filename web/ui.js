// Comet Catcher shared UI: star field, constellation buttons, demo sign-in, search, skippable tour.
// Plain script (no build step). Everything is optional decoration on top of working pages.
// Other scripts can listen for the 'ch:user' event or read window.CH_USER ({name, via} or null).
(() => {
  'use strict';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: fine */ } },
    del: k => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const k in props) k === 'class' ? (e.className = props[k]) : k === 'text' ? (e.textContent = props[k]) : k.startsWith('on') ? e.addEventListener(k.slice(2), props[k]) : e.setAttribute(k, props[k]);
    e.append(...kids); return e;
  };
  const isExplore = document.body.classList.contains('explore');
  const noStars = document.body.classList.contains('nostars');   // pages with their own 3D star field

  // ---------------------------------------------------------------- star field
  function starfield() {
    const cv = h('canvas', { id: 'stars', 'aria-hidden': 'true' });
    document.body.prepend(cv);
    const g = cv.getContext('2d');
    let W, H, stars = [], mx = -1e4, my = -1e4, sx = 0, sy = 0, shoot = null, nextShoot = 2500;
    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = Array.from({ length: Math.min(150, Math.round(W * H / 11000)) }, () => ({ x: Math.random() * W, y: Math.random() * H, z: Math.random(), ph: Math.random() * 6.28, sp: .4 + Math.random() * 1.4 }));
      if (reduce) draw(0);
    };
    function draw(t) {
      g.clearRect(0, 0, W, H);
      sx += ((mx - W / 2) - sx) * .04; sy += ((my - H / 2) - sy) * .04;
      const near = [];
      for (const s of stars) {
        const par = s.z * .018, x = s.x - (mx > -1e3 ? sx * par : 0), y = s.y - (mx > -1e3 ? sy * par : 0);
        const tw = reduce ? .8 : .55 + .45 * Math.sin(t * .001 * s.sp + s.ph), a = (.25 + s.z * .7) * tw, r = .4 + s.z * 1.1;
        g.fillStyle = `rgba(${s.z > .85 ? '255,226,200' : '226,236,255'},${a})`;
        g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
        if (Math.hypot(x - mx, y - my) < 150) near.push({ x, y });
      }
      // constellation lines between stars close to the pointer
      g.lineWidth = 1;
      for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
        const d = Math.hypot(near[i].x - near[j].x, near[i].y - near[j].y);
        if (d < 95) { const a = (1 - d / 95) * (1 - Math.hypot(near[i].x - mx, near[i].y - my) / 150) * .55; g.strokeStyle = `rgba(190,215,255,${Math.max(a, 0)})`; g.beginPath(); g.moveTo(near[i].x, near[i].y); g.lineTo(near[j].x, near[j].y); g.stroke(); }
      }
      if (!reduce) {
        if (!shoot && t > nextShoot) { shoot = { x: Math.random() * W * .8, y: Math.random() * H * .35, t0: t }; nextShoot = t + 6000 + Math.random() * 7000; }
        if (shoot) {
          const k = (t - shoot.t0) / 900;
          if (k > 1) shoot = null;
          else { const x = shoot.x + k * 340, y = shoot.y + k * 170, gr = g.createLinearGradient(x - 90, y - 45, x, y); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(1, `rgba(255,255,255,${1 - k})`); g.strokeStyle = gr; g.lineWidth = 1.6; g.beginPath(); g.moveTo(x - 90, y - 45); g.lineTo(x, y); g.stroke(); }
        }
      }
    }
    let lastT = 0;
    const loop = t => { requestAnimationFrame(loop); if (t - lastT < 33 || document.hidden) return; lastT = t; draw(t); };   // 30 fps is plenty for twinkling and keeps the page light
    addEventListener('resize', resize);
    resize();
    if (!reduce) {
      addEventListener('pointermove', e => { mx = e.clientX; my = e.clientY; }, { passive: true });
      document.addEventListener('pointerleave', () => { mx = my = -1e4; });
      requestAnimationFrame(loop);
    }
  }

  // ---------------------------------------------------------------- constellation buttons
  // Stars sit round the outline of a button, joined by thin lines. On load they fly in from scatter and the lines draw.
  const PAD = 12;
  function stadium(w, hh, s) {       // point at distance s along a pill outline (w wide, hh tall)
    const r = hh / 2, L = Math.max(w - hh, 0), P = 2 * L + 2 * Math.PI * r; s = ((s % P) + P) % P;
    if (s < L) return [r + s, 0];
    s -= L; if (s < Math.PI * r) { const a = -Math.PI / 2 + s / r; return [w - r + r * Math.cos(a), r + r * Math.sin(a)]; }
    s -= Math.PI * r; if (s < L) return [w - r - s, hh];
    s -= L; const a = Math.PI / 2 + s / r; return [r + r * Math.cos(a), r + r * Math.sin(a)];
  }
  function constellate(el) {
    el.querySelector(':scope > .cb')?.remove();
    const w = el.offsetWidth, hh = el.offsetHeight;
    if (!w || !hh) return;
    const r = hh / 2, P = 2 * Math.max(w - hh, 0) + 2 * Math.PI * r, n = Math.max(6, Math.min(16, Math.round(P / 56)));
    const s = svg('svg', { class: 'cb', width: w + PAD * 2, height: hh + PAD * 2, 'aria-hidden': 'true' });
    // a soft outline that draws itself, with a few stars sitting on it
    s.append(svg('rect', { class: 'cb-ring', x: PAD + .5, y: PAD + .5, width: w - 1, height: hh - 1, rx: r, ry: r, pathLength: 1 }));
    for (let i = 0; i < n; i++) {
      const [x, y] = stadium(w, hh, P * (i + .5) / n), c = svg('circle', { cx: x + PAD, cy: y + PAD, r: i % 4 === 0 ? 1.9 : 1.4 });
      c.style.setProperty('--i', i); c.style.setProperty('--dx', (Math.random() * 30 - 15).toFixed(1) + 'px'); c.style.setProperty('--dy', (Math.random() * 30 - 15).toFixed(1) + 'px'); s.append(c);
    }
    el.prepend(s);
    if (reduce) s.classList.add('in'); else requestAnimationFrame(() => requestAnimationFrame(() => s.classList.add('in')));
  }
  const ro = 'ResizeObserver' in window ? new ResizeObserver(entries => entries.forEach(e => constellate(e.target))) : null;
  function scanButtons() {
    document.querySelectorAll('.btn:not([data-cb]):not(.plain)').forEach(el => {
      el.dataset.cb = '1';
      if (ro) ro.observe(el); else constellate(el);
    });
  }

  // ---------------------------------------------------------------- demo sign-in
  // Demo only: there is no server-side account. The name lives in this browser (localStorage).
  // To make it real later: replace signIn() with Google Identity Services and verify the ID token in the Worker.
  let user = null;
  try { user = JSON.parse(store.get('ch.user') || 'null'); } catch { user = null; }
  window.CH_USER = user;
  const initials = n => n.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '··';
  function setUser(u) {
    user = u; window.CH_USER = u;
    if (u) store.set('ch.user', JSON.stringify(u)); else store.del('ch.user');
    renderAuth(); dispatchEvent(new CustomEvent('ch:user', { detail: u }));
  }
  const G = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
  let lastFocus = null;
  function closeModal() { document.querySelector('.veil')?.remove(); document.removeEventListener('keydown', escModal); lastFocus?.focus?.(); }
  const escModal = e => { if (e.key === 'Escape') closeModal(); };
  function openSignIn() {
    if (document.querySelector('.veil')) return;
    lastFocus = document.activeElement;
    const name = h('input', { type: 'text', maxlength: '24', placeholder: 'Pick a name', 'aria-label': 'Your name' });
    const done = (n, via) => { setUser({ name: n, via }); closeModal(); };
    const gbtn = h('button', { class: 'btn gbtn', type: 'button', onclick: () => done('Sky Watcher', 'google-demo') });
    gbtn.innerHTML = `${G}<span>Continue with Google</span>`;
    const form = h('form', { onsubmit: e => { e.preventDefault(); done(name.value.trim() || 'Sky Watcher', 'name'); } }, name, h('button', { class: 'btn', type: 'submit', text: 'Continue' }));
    const sheet = h('div', { class: 'sheet glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'si-t' },
      h('button', { class: 'x', 'aria-label': 'Close', text: '×', onclick: closeModal }),
      h('div', { class: 'comet-mark' }, h('span', { class: 'brand-mark' })),
      h('h2', { id: 'si-t', text: 'Join Comet Catcher' }),
      h('p', { text: 'Sign in to tag what you find and join the conversation about it.' }),
      gbtn, h('div', { class: 'or', text: 'or' }), form,
      h('p', { class: 'fine', text: 'Demo sign-in: no account is created and nothing leaves your browser. The Google button is a stand-in.' }));
    const veil = h('div', { class: 'veil', onclick: e => { if (e.target === veil) closeModal(); } }, sheet);
    document.body.append(veil); scanButtons();
    document.addEventListener('keydown', escModal);
    gbtn.focus();
  }
  function renderAuth() {
    const old = document.querySelector('.authbox'); if (old) old.remove();
    const bar = document.querySelector('.topbar'); if (!bar) return;
    const box = h('div', { class: 'authbox' });
    if (user) {
      const av = h('button', { class: 'av on', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: user.name, text: initials(user.name) });
      av.addEventListener('click', e => {
        e.stopPropagation();
        const open = box.querySelector('.menu-pop');
        if (open) { open.remove(); av.setAttribute('aria-expanded', 'false'); return; }
        const pop = h('div', { class: 'menu-pop glass', role: 'menu' },
          h('div', { class: 'who' }, h('b', { text: user.name }), h('span', { text: 'Demo account · this browser only' })),
          h('button', { role: 'menuitem', text: 'Replay the tour', onclick: () => { pop.remove(); isExplore ? startTour() : (location.href = './?tour=1'); } }),
          h('button', { role: 'menuitem', text: 'Sign out', onclick: () => setUser(null) }));
        box.append(pop); av.setAttribute('aria-expanded', 'true');
      });
      box.append(av);
    } else box.append(h('button', { class: 'btn small', type: 'button', text: 'Sign in', onclick: openSignIn }));
    bar.querySelector('.av')?.remove();
    bar.append(box); scanButtons();
  }
  document.addEventListener('click', () => { document.querySelectorAll('.authbox .menu-pop').forEach(m => m.remove()); });
  document.addEventListener('click', e => { document.querySelectorAll('details.layers[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; }); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('details.layers[open]').forEach(d => { d.open = false; }); });

  // ---------------------------------------------------------------- top bar extras: help button, working search on inner pages
  function topbar() {
    const bar = document.querySelector('.topbar'); if (!bar) return;
    const help = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Take the tour', title: 'Take the tour', text: '?', onclick: () => (isExplore ? startTour() : (location.href = './?tour=1')) });
    bar.append(help);
    const s = bar.querySelector('.search');
    if (s && !isExplore) {   // inner pages: same search, jumps to a comet or a sky position
      const input = s.querySelector('input'); input.removeAttribute('disabled'); input.placeholder = 'Comet name or sky position';
      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return; e.preventDefault();
        const v = input.value.trim(), nums = v.split(/[\s,]+/).map(Number);
        if (nums.length === 2 && nums.every(Number.isFinite)) location.href = `timelapse.html?ra=${nums[0]}&dec=${nums[1]}&det=D1&diff=1`;
        else if (v) location.href = `comet.html?id=${encodeURIComponent(v)}`;
      });
    }
    if (s) s.addEventListener('click', () => s.querySelector('input').focus());
  }


  // ---------------------------------------------------------------- guide: a notebook laid over whatever page you are on
  const PIC = 'data/flip/rwaur/';
  const GUIDE_HTML = `
    <section class="nb-page nb-left">
      <p class="nb-kicker">field notes</p>
      <h2 id="nb-t">How to catch a comet</h2>
      <p class="nb-lede">Stars stay still between two photos. <span class="nb-hl">Comets move.</span></p>
      <ol class="nb-steps">
        <li><div><h3>Pick a patch</h3><p>Start where nobody has looked.</p></div><div class="pic"><span class="oval"></span></div></li>
        <li><div><h3>Remove the still stars</h3><p>Subtract one photo from the other.</p></div>
          <div class="pic"><span class="plate"><img src="${PIC}f0.png" alt=""></span><svg class="ic" style="color:var(--ink-3)"><use href="icons.svg#arrow"/></svg>
          <span class="plate sub"><img src="${PIC}f0.png" alt=""><img src="${PIC}f1.png" alt=""><span class="dot" style="left:62%;top:40%"></span></span></div></li>
        <li><div><h3>Blink the photos</h3><p>Look for a dot that <span class="nb-hl">jumps</span>.</p></div>
          <div class="pic"><span class="plate"><img src="${PIC}f0.png" alt=""><span class="ring earlier" style="--d:20px;left:30%;top:66%"></span></span><svg class="ic" style="color:var(--ink-3)"><use href="icons.svg#blink"/></svg>
          <span class="plate"><img src="${PIC}f1.png" alt=""><span class="ring" style="--d:20px;left:62%;top:40%"></span></span></div></li>
        <li><div><h3>Fuzzy or sharp?</h3><p>Fuzzy with a tail is a comet. Sharp is an asteroid.</p></div>
          <div class="pic"><span class="big fuzzy"><span class="dot tail"></span><small>comet</small></span><span class="big sharp"><span class="dot"></span><small>asteroid</small></span></div></li>
        <li><div><h3>Say what you think</h3><p>Comment with a tag. Your tag is your vote.</p></div>
          <div class="pic"><span class="bubble"><span class="tag comet">comet</span><i></i></span></div></li>
      </ol>
    </section>
    <section class="nb-page nb-right">
      <div class="nb-head"><span class="eyebrow">Practice 1 of 3</span><span class="example">Example dot</span></div>
      <h2>One dot here moves.</h2>
      <div class="nb-photo"><span class="tape"></span>
        <div class="plate">
          <img src="${PIC}f1.png" alt="Practice patch, first photo"><span class="dot tail" style="left:38%;top:58%"></span>
          <div class="b" style="position:absolute;inset:0;background:#000"><img src="${PIC}f2.png" alt="Practice patch, second photo"><span class="dot tail" style="left:61%;top:44%"></span></div>
          <span class="blinkbar">blinking</span>
        </div>
      </div>
      <div class="nb-actions"><a class="btn" href="timelapse.html?target=rwaur&diff=1">Start practice <svg class="ic"><use href="icons.svg#arrow"/></svg></a>
        <button class="btn ghost" id="nb-show" type="button" aria-pressed="false"><span>Show me</span></button></div>
    </section>`;
  function openGuide() {
    if (document.querySelector('.nb-veil')) return;
    if (!document.getElementById('nb-font')) document.head.append(h('link', { id: 'nb-font', rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Caveat:wght@500;600&display=swap' }));
    const prev = document.activeElement;
    const nb = h('div', { class: 'notebook', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'nb-t' }, h('button', { class: 'nb-x', 'aria-label': 'Close the guide', text: '×' }), h('div', { class: 'nb-spine', 'aria-hidden': 'true' }));
    nb.insertAdjacentHTML('beforeend', GUIDE_HTML);
    const veil = h('div', { class: 'nb-veil' }, nb);
    document.body.append(veil);
    const links = [...document.querySelectorAll('.topbar nav a')], was = links.map(a => a.classList.contains('on'));
    links.forEach(a => a.classList.toggle('on', /guide\.html$/.test(a.getAttribute('href'))));
    const close = () => { veil.classList.add('out'); setTimeout(() => veil.remove(), 260); links.forEach((a, i) => a.classList.toggle('on', was[i])); document.removeEventListener('keydown', esc); prev?.focus?.(); if (/[?&]guide=1/.test(location.search)) history.replaceState(null, '', location.pathname); };
    const esc = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc);
    veil.addEventListener('click', e => { if (e.target === veil) close(); });
    nb.querySelector('.nb-x').addEventListener('click', close);
    const show = nb.querySelector('#nb-show'), plate = nb.querySelector('.nb-photo .plate');
    show.addEventListener('click', () => { const on = plate.classList.toggle('show'); show.setAttribute('aria-pressed', on); show.querySelector('span').textContent = on ? 'Hide' : 'Show me'; });
    scanButtons(); nb.querySelector('.nb-x').focus();
  }
  document.addEventListener('click', e => {
    const a = e.target.closest?.('a[href$="guide.html"]');
    if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); openGuide(); }
  });
  window.CH_GUIDE = openGuide;

  // ---------------------------------------------------------------- tour
  const STEPS = [
    { title: 'Welcome to Comet Catcher', text: 'NASA’s SPHEREx telescope photographs the whole sky again and again. Anything that moves between photos is a comet or an asteroid. Take a one-minute look around, or skip it.' },
    { sel: '.map-wrap', title: 'The whole sky, flat', text: 'This is the entire sky unrolled like a world map. The bright band is our galaxy. Orange dots are comets people found, blue ones are already known.' },
    { sel: '.timebar', title: 'Watch it get photographed', text: 'Press play to see SPHEREx scan the sky, strip by strip, over its first year and a half.' },
    { sel: '.layers', title: 'More, when you want it', text: 'Layers hides the extras: coverage, where people have looked, comets and known objects. Leave them alone to start.' },
    { sel: '#go-unexplored', title: 'Your first hunt', text: 'Not sure where to look? This takes you to a patch nobody has checked yet. You can also click anywhere on the sky.' },
    { title: 'You’re ready', text: 'Compare two photos, spot the dot that jumped, and tag it. Sign in any time to join the conversation.', last: true },
  ];
  let tourEl = null;
  function startTour() {
    if (tourEl) return;
    const steps = STEPS.filter(s => !s.sel || document.querySelector(s.sel));
    let i = 0; const prevFocus = document.activeElement;
    const spot = h('div', { class: 'tour-spot none' }), card = h('div', { class: 'tour-card glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-t', tabindex: '-1' });
    tourEl = h('div', { class: 'tour' }, spot, card); document.body.append(tourEl);
    const end = (mark = true) => { if (mark) store.set('ch.tour', '1'); tourEl.remove(); tourEl = null; removeEventListener('resize', place); removeEventListener('keydown', key); prevFocus?.focus?.(); };
    const key = e => { if (e.key === 'Escape') end(); else if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1); };
    function go(d) { const n = i + d; if (n < 0) return; if (n >= steps.length) return end(); i = n; render(); }
    function render() {
      const s = steps[i];
      card.replaceChildren(
        h('div', { class: 'tour-dots', 'aria-label': `Step ${i + 1} of ${steps.length}` }, ...steps.map((_, k) => h('i', { class: k < i ? 'done' : k === i ? 'now' : '' }))),
        h('h2', { id: 'tour-t', text: s.title }), h('p', { text: s.text }),
        h('div', { class: 'row' },
          s.last ? h('span') : h('button', { class: 'skip', type: 'button', text: 'Skip tour', onclick: () => end() }),
          i > 0 && !s.last ? h('button', { class: 'btn ghost small', type: 'button', text: 'Back', onclick: () => go(-1) }) : '',
          h('button', { class: 'btn', type: 'button', text: s.last ? 'Start catching' : i === 0 ? 'Show me' : 'Next', onclick: () => { if (s.last) { end(); document.getElementById('go-unexplored')?.click(); } else go(1); } })));
      card.querySelectorAll('.btn').forEach(b => delete b.dataset.cb); scanButtons();
      const t = s.sel && document.querySelector(s.sel); if (t) t.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      place(); card.querySelector('.btn:last-child')?.focus({ preventScroll: true });
    }
    function place() {
      const s = steps[i], t = s?.sel && document.querySelector(s.sel), small = innerWidth <= 640;
      if (!t) { spot.className = 'tour-spot none'; Object.assign(spot.style, { left: '50%', top: '50%', width: '0px', height: '0px' }); card.style.left = Math.max(12, (innerWidth - card.offsetWidth) / 2) + 'px'; card.style.top = Math.max(12, (innerHeight - card.offsetHeight) / 2) + 'px'; return; }
      let b = t.getBoundingClientRect();
      if (s.sel === '.map-wrap') { const m = t.querySelector('.map').getBoundingClientRect(); b = m; }
      const p = 10, rad = s.sel === '.map-wrap' ? 9999 : 34;
      spot.className = 'tour-spot';
      Object.assign(spot.style, { left: b.left - p + 'px', top: b.top - p + 'px', width: b.width + p * 2 + 'px', height: b.height + p * 2 + 'px', borderRadius: Math.min(rad, (b.height + p * 2) / 2 > 150 ? 9999 : 34) + 'px' });
      if (small) return;
      const cw = card.offsetWidth, ch = card.offsetHeight, gap = 24;
      let x = b.right + gap, y = b.top + b.height / 2 - ch / 2;                 // prefer the right,
      if (x + cw > innerWidth - 12) { x = b.left - gap - cw; }                  // else the left,
      if (x < 12) { x = Math.min(Math.max(12, b.left + b.width / 2 - cw / 2), innerWidth - cw - 12); y = b.top - gap - ch; if (y < 12) y = b.bottom + gap; }   // else above or below
      if (s.sel === '.map-wrap') { x = Math.max(12, innerWidth * .5 - cw / 2); y = b.top + 40; }
      card.style.left = Math.min(Math.max(12, x), innerWidth - cw - 12) + 'px'; card.style.top = Math.min(Math.max(12, y), innerHeight - ch - 12) + 'px';
    }
    addEventListener('resize', place); addEventListener('keydown', key);
    render();
  }
  window.CH_TOUR = startTour;

  // ---------------------------------------------------------------- boot
  if (!noStars) starfield();
  topbar();
  renderAuth();
  scanButtons();
  if (/[?&]guide=1/.test(location.search)) openGuide();
  new MutationObserver(() => scanButtons()).observe(document.body, { childList: true, subtree: true });
  if (isExplore && (!store.get('ch.tour') || /[?&]tour=1/.test(location.search))) {
    const wait = setInterval(() => { if (document.body.dataset.ready || document.querySelector('#go-unexplored[href]')) { clearInterval(wait); setTimeout(startTour, 900); } }, 300);
    setTimeout(() => clearInterval(wait), 15000);
  }
})();
