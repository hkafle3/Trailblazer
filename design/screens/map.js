// Sky map for the Explore screen. Everything is placed with one Mollweide
// projection so markers, the coverage replay and the heat tiles line up
// with web/data/sky.jpg (RA increases to the left, RA 0 in the middle).
const R2 = Math.SQRT2, RAD = Math.PI / 180;
const DATA = "../../web/data/";

// lon in degrees (-180..180, positive to the right), dec in degrees -> [u, v] in 0..1
function fwdLon(lon, dec) {
  const lat = dec * RAD;
  let t = lat;
  for (let i = 0; i < 10 && Math.abs(dec) < 89.9; i++)
    t -= (2 * t + Math.sin(2 * t) - Math.PI * Math.sin(lat)) / (2 + 2 * Math.cos(2 * t));
  const x = (2 * R2 / Math.PI) * lon * RAD * Math.cos(t), y = R2 * Math.sin(t);
  return [(x + 2 * R2) / (4 * R2), (R2 - y) / (2 * R2)];
}
const wrap = d => ((d + 180) % 360 + 360) % 360 - 180;
const fwd = (ra, dec) => fwdLon(wrap(-ra), dec);

// The check for the projection: forward then the brief's inverse must return the input.
function selfCheck() {
  for (const [ra, dec] of [[0, 0], [77, 30.4], [266, -29], [181, 60], [179, -75]]) {
    const [u, v] = fwd(ra, dec);
    const x = (u * 2 - 1) * 2 * R2, y = (1 - v * 2) * R2;
    const th = Math.asin(y / R2), lon = Math.PI * x / (2 * R2 * Math.cos(th));
    const lat = Math.asin((2 * th + Math.sin(2 * th)) / Math.PI);
    const ra2 = ((-lon / RAD) % 360 + 360) % 360;
    console.assert(Math.abs(wrap(ra2 - ra)) < 1e-3 && Math.abs(lat / RAD - dec) < 1e-3, "projection round trip failed", ra, dec);
  }
}
selfCheck();

// ---- markers and cards: any element with data-ra / data-dec ----
for (const el of document.querySelectorAll("[data-ra]")) {
  const [u, v] = fwd(+el.dataset.ra, +el.dataset.dec);
  el.style.left = u * 100 + "%";
  el.style.top = v * 100 + "%";
}

// ---- graticule and ecliptic ----
{
  const P = (lon, dec) => { const [u, v] = fwdLon(lon, dec); return (u * 2000).toFixed(1) + " " + (v * 1000).toFixed(1); };
  let d = "";
  for (let lon = -120; lon <= 120; lon += 60) for (let dec = -90; dec <= 90; dec += 3) d += (dec === -90 ? "M" : "L") + P(lon, dec);
  for (let dec = -60; dec <= 60; dec += 30) d += "M" + P(-180, dec) + "L" + P(180, dec);
  document.getElementById("grat").setAttribute("d", d);
  const eps = 23.44 * RAD, pts = [];
  for (let l = 0; l < 360; l += 2) {
    const ra = Math.atan2(Math.cos(eps) * Math.sin(l * RAD), Math.cos(l * RAD)) / RAD;
    pts.push([wrap(-ra), Math.asin(Math.sin(eps) * Math.sin(l * RAD)) / RAD]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  document.getElementById("ecl").setAttribute("d", pts.map((p, i) => (i ? "L" : "M") + P(p[0], p[1])).join(""));
}

// ---- "explored by people" heat tiles (example data, generated the same way every load) ----
{
  const cv = document.getElementById("heat"), g = cv.getContext("2d"), W = cv.width, H = cv.height;
  const hot = [[328, 34, 9, 1], [18, 22, 8, .9], [300, -30, 6, .6], [95, -12, 8, .8], [140, 48, 5, .5], [215, -8, 10, 1],
    [84, -2, 11, 1], [56.8, 24.1, 7, 1], [266, -29, 10, .9], [80, -69, 7, .7], [10.7, 41.3, 7, .9], [270, 66.6, 6, .7], [201, -43, 6, .6]];
  const keep = [77, 30.4]; // the patch we send people to stays unexplored
  const sep = (ra1, d1, ra2, d2) => Math.acos(Math.min(1, Math.sin(d1 * RAD) * Math.sin(d2 * RAD) + Math.cos(d1 * RAD) * Math.cos(d2 * RAD) * Math.cos((ra1 - ra2) * RAD))) / RAD;
  const rnd = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
  const bands = 51, step = 180 / bands;
  let total = 0, seen = 0;
  for (let i = 0; i < bands; i++) {
    const d0 = 90 - i * step, d1 = d0 - step, dm = (d0 + d1) / 2;
    const n = Math.max(1, Math.round(360 * Math.cos(dm * RAD) / 3.5));
    for (let j = 0; j < n; j++) {
      const l0 = -180 + 360 * j / n, l1 = -180 + 360 * (j + 1) / n, ra = ((-(l0 + l1) / 2) % 360 + 360) % 360;
      let p = 0;
      for (const [hr, hd, s, w] of hot) p += w * Math.exp(-((sep(ra, dm, hr, hd) / s) ** 2));
      const beta = Math.asin(Math.sin(dm * RAD) * Math.cos(23.44 * RAD) - Math.cos(dm * RAD) * Math.sin(23.44 * RAD) * Math.sin(ra * RAD)) / RAD;
      p += .2 * Math.exp(-((beta / 9) ** 2));
      p *= .35 + 1.1 * rnd(i, j);
      if (sep(ra, dm, keep[0], keep[1]) < 7) p = 0;
      const level = p > .62 ? 3 : p > .34 ? 2 : p > .15 ? 1 : 0;
      total++; if (level) seen++;
      g.beginPath();
      [[l0, d0], [l1, d0], [l1, d1], [l0, d1]].forEach(([l, d], k) => { const [u, v] = fwdLon(l, d); k ? g.lineTo(u * W, v * H) : g.moveTo(u * W, v * H); });
      g.closePath();
      if (level) { g.fillStyle = `rgba(95,224,173,${[0, .26, .5, .82][level]})`; g.fill(); g.strokeStyle = "rgba(4,6,11,.75)"; }
      else g.strokeStyle = "rgba(255,255,255,.045)";
      g.lineWidth = 1.5; g.stroke();
    }
  }
  const fmt = n => n.toLocaleString("en-US");
  for (const el of document.querySelectorAll("[data-n]"))
    el.textContent = { total: fmt(total), seen: fmt(seen), unseen: fmt(total - seen), pct: Math.round(seen / total * 100) + "%" }[el.dataset.n];
  document.getElementById("people-meter").style.setProperty("--p", seen / total * 100 + "%");
}

// ---- SPHEREx coverage replay ----
// coverage.png: R*256+G = day of first photo, A = covered. We precompute the day for every
// pixel of the oval, then the slider only has to compare numbers.
(async () => {
  const meta = await (await fetch(DATA + "coverage.json")).json();
  const img = new Image(); img.src = DATA + "coverage.png"; await img.decode();
  const src = Object.assign(document.createElement("canvas"), { width: 720, height: 360 }).getContext("2d", { willReadFrequently: true });
  src.drawImage(img, 0, 0);
  const px = src.getImageData(0, 0, 720, 360).data;

  const cv = document.getElementById("cover"), g = cv.getContext("2d"), W = cv.width, H = cv.height;
  const OUT = 65535, NEVER = 65534, day = new Uint16Array(W * H);
  let inside = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = ((i + .5) / W * 2 - 1) * 2 * R2, y = (1 - (j + .5) / H * 2) * R2;
    const th = Math.asin(y / R2), lon = Math.PI * x / (2 * R2 * Math.cos(th));
    let v = OUT;
    if (Math.abs(lon) <= Math.PI) {
      const lat = Math.asin((2 * th + Math.sin(2 * th)) / Math.PI) / RAD, ra = ((-lon / RAD) % 360 + 360) % 360;
      const k = (Math.min(359, Math.floor((90 - lat) / meta.step)) * 720 + Math.min(719, Math.floor(ra / meta.step))) * 4;
      v = px[k + 3] ? px[k] * 256 + px[k + 1] : NEVER;
      inside++;
    }
    day[j * W + i] = v;
  }

  const out = g.createImageData(W, H), o = out.data;
  const slider = document.getElementById("time"), dateEl = document.getElementById("t-date"), pctEl = document.getElementById("t-pct");
  const FRESH = 9; // days a newly photographed strip stays lit up
  function draw() {
    const d = +slider.value; let lit = 0;
    for (let k = 0; k < day.length; k++) {
      const v = day[k], q = k * 4;
      if (v === OUT) { o[q + 3] = 0; continue; }
      if (v <= d) {
        lit++;
        const age = d - v, fresh = age < FRESH && d < meta.days;
        o[q] = 234; o[q + 1] = 241; o[q + 2] = 255; o[q + 3] = fresh ? 70 * (1 - age / FRESH) : 0;
      } else { o[q] = 3; o[q + 1] = 5; o[q + 2] = 10; o[q + 3] = 232; }
    }
    g.putImageData(out, 0, 0);
    const pct = lit / inside * 100;  // Mollweide is equal-area, so pixels count sky fairly
    const when = new Date((meta.mjd0 + d - 40587) * 864e5);
    dateEl.textContent = when.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    pctEl.textContent = (pct > 99.5 ? Math.floor(pct) : Math.round(pct)) + "% photographed";
    slider.style.setProperty("--p", d / meta.days * 100 + "%");
    const meter = document.getElementById("photo-meter");
    meter.style.setProperty("--p", pct + "%");
    meter.querySelector("b").textContent = Math.floor(pct) + "%";
    for (const el of document.querySelectorAll("[data-day]")) el.style.visibility = +el.dataset.day <= d ? "" : "hidden";
  }
  slider.max = meta.days;
  slider.value = new URLSearchParams(location.hash.slice(1)).get("d") ?? meta.days;
  slider.addEventListener("input", draw);
  draw();

  let timer = 0;
  const play = document.getElementById("play");
  play.addEventListener("click", () => {
    if (timer) { clearInterval(timer); timer = 0; play.classList.remove("on"); return; }
    if (+slider.value >= meta.days) slider.value = 0;
    play.classList.add("on");
    timer = setInterval(() => {
      slider.value = +slider.value + 2; draw();
      if (+slider.value >= meta.days) play.click();
    }, 40);
  });
  document.body.dataset.ready = "1";
})();
