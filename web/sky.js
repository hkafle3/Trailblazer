// The shared 3D sky: SPHEREx all-sky tiles (blurry whole sky, sharp tiles where you look) plus Gaia stars.
// Used by index.html (smooth-check benchmark) and timelapse.html.
import * as THREE from 'three';

export const HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
export const D2R = Math.PI / 180;
// celestial (x to RA 0, y to RA 90, z north) -> three (y up)
export const cel = (x, y, z, out = new THREE.Vector3()) => out.set(x, z, -y);
export const dirRaDec = (ra, dec, out) => cel(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec), out);

// ---------- HEALPix (nested) geometry ----------
const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];
function compress(v) { let r = 0; for (let i = 0; i < 16; i++) r |= ((v >>> (2 * i)) & 1) << i; return r; }
function nest2xyf(order, ipix) {
  const npf = 1 << (2 * order), face = Math.floor(ipix / npf), ipf = ipix - face * npf;
  return [compress(ipf), compress(ipf >>> 1), face];
}
// continuous face coords x,y in [0,1] -> (ra, dec) radians (HEALPix xyf2loc)
function xyf2radec(x, y, face) {
  const jr = JRLL[face] - x - y; let nr, z;
  if (jr < 1) { nr = jr; z = 1 - nr * nr / 3; } else if (jr > 3) { nr = 4 - jr; z = nr * nr / 3 - 1; } else { nr = 1; z = (2 - jr) * 2 / 3; }
  let t = JPLL[face] * nr + x - y; if (t < 0) t += 8; if (t >= 8) t -= 8;
  const phi = nr < 1e-15 ? 0 : (Math.PI / 4) * t / nr;
  return [phi, Math.asin(Math.max(-1, Math.min(1, z)))];
}
// (ra, dec) radians -> continuous face coords x, y in [0,1] and face: the inverse of xyf2radec (HEALPix loc2pix
// without rounding to a pixel). tests/skymap.html checks the round trip.
export function radec2xyf(ra, dec) {
  const z = Math.sin(dec), za = Math.abs(z);
  let tt = (ra / (Math.PI / 2)) % 4; if (tt < 0) tt += 4;
  if (za <= 2 / 3) {
    const jp = 0.5 + tt - z * 0.75, jm = 0.5 + tt + z * 0.75, ifp = Math.floor(jp), ifm = Math.floor(jm);
    const face = ifp === ifm ? (ifp % 4) | 4 : ifp < ifm ? ifp % 4 : (ifm % 4) + 8;
    return [jm - ifm, 1 - (jp - ifp), face];
  }
  const ntt = Math.min(3, Math.floor(tt)), tp = tt - ntt, tmp = Math.sqrt(3 * (1 - za));
  const jp = tp * tmp, jm = (1 - tp) * tmp;
  return z > 0 ? [1 - jm, 1 - jp, ntt] : [jp, jm, ntt + 8];
}
function spread(v) { let r = 0; for (let i = 0; i < 16; i++) r |= ((v >>> i) & 1) << (2 * i); return r >>> 0; }
// nested tile index at `order` plus the position inside that tile
export function radec2tile(order, ra, dec) {
  const n = 1 << order, [x, y, f] = radec2xyf(ra, dec);
  const ix = Math.min(n - 1, Math.floor(x * n)), iy = Math.min(n - 1, Math.floor(y * n));
  return { k: f * n * n + spread(ix) + 2 * spread(iy), u: x * n - ix, v: y * n - iy };
}
export { xyf2radec };
// three.js direction -> [ra, dec] degrees (the inverse of dirRaDec)
export const radecFromDir = d => [((Math.atan2(-d.z, d.x) / D2R) % 360 + 360) % 360, Math.asin(Math.max(-1, Math.min(1, d.y / d.length()))) / D2R];

// tile-local face coords (u along ix, v along iy) -> image coords (c column, r row from top) in [0,1].
// Checked against real tiles by bake/check_orientation.py (orientation 6).
export const tileUV = (u, v) => [v, u];
function tileGrid(order, ipix, G, radius, onVertex) {
  const nside = 1 << order, [ix, iy, f] = nest2xyf(order, ipix), v3 = new THREE.Vector3();
  for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
    const u = i / G, v = j / G, [ra, dec] = xyf2radec((ix + u) / nside, (iy + v) / nside, f);
    dirRaDec(ra, dec, v3).multiplyScalar(radius);
    onVertex(v3, ...tileUV(u, v));
  }
}
function gridIndex(G, base, out) {
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const a = base + j * (G + 1) + i, b = a + 1, c = a + G + 1, d = c + 1;
    out.push(a, b, d, a, d, c);
  }
}
function meshFrom(pos, uv, idx, mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return new THREE.Mesh(g, mat);
}

export function createWorld({ renderer, scene, camera, local = false, stress = 0 }) {
  const timings = { allskyMs: null, tiles: [] };

  // ---------- layer 1: whole sky from one Allsky image (order 3, 768 tiles of 64 px) ----------
  const sky = new THREE.Group(); scene.add(sky);
  {
    const t0 = performance.now(), src = local ? 'data/allsky3.png' : `${HIPS}/Norder3/Allsky.png`;
    new THREE.TextureLoader().setCrossOrigin('anonymous').load(src, tex => {
      tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
      const G = 4, W = tex.image.width, H = tex.image.height, cols = Math.floor(W / 64), pos = [], uv = [], idx = [];
      for (let k = 0; k < 768; k++) {
        const cx = (k % cols) * 64, cy = Math.floor(k / cols) * 64, base = pos.length / 3;
        tileGrid(3, k, G, 1000, (p, c, r) => { pos.push(p.x, p.y, p.z); uv.push((cx + 0.5 + c * 63) / W, (cy + 0.5 + r * 63) / H); });
        gridIndex(G, base, idx);
      }
      const m = meshFrom(pos, uv, idx, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, depthWrite: false }));
      m.renderOrder = -2; sky.add(m);
      timings.allskyMs = Math.round(performance.now() - t0);
    });
  }

  // ---------- layer 2: sharp order-5 tiles streamed only where you look (the Google Maps trick) ----------
  const ORDER = 5, NT = 12 * 4 ** ORDER, centers = new Float32Array(NT * 3);
  for (let k = 0, v = new THREE.Vector3(); k < NT; k++) {
    const [ix, iy, f] = nest2xyf(ORDER, k), [ra, dec] = xyf2radec((ix + 0.5) / 32, (iy + 0.5) / 32, f);
    dirRaDec(ra, dec, v).toArray(centers, k * 3);
  }
  const live = new Map();   // ipix -> {mesh, used}
  // Decode PNGs off the main thread, then upload one tile per frame, and only while the frame has time left.
  // No mipmaps: building them for a 512 px tile cost 10-25 ms per upload on a 60 Hz MacBook in Safari.
  const loader = new THREE.ImageBitmapLoader().setCrossOrigin('anonymous').setOptions({ imageOrientation: 'none' });
  const arrived = [];
  function tileMesh(k, tex) {
    const G = 8, pos = [], uv = [], idx = [];
    tileGrid(ORDER, k, G, 990, (p, c, r) => { pos.push(p.x, p.y, p.z); uv.push(c, r); });
    gridIndex(G, 0, idx);
    const m = meshFrom(pos, uv, idx, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, depthWrite: false, transparent: true, opacity: 0 }));
    m.renderOrder = -1; return m;
  }
  { // compile the tile shader at load, so the first sharp tile does not stall a frame (51 ms on a 60 Hz MacBook)
    const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
    const warm = new THREE.Scene(); warm.add(tileMesh(0, t)); renderer.compile(warm, camera);
  }
  function addArrivedTiles(frameStart) {
    while (arrived.length && performance.now() - frameStart < 4) {
      const { k, rec, bmp, t0 } = arrived.shift();
      if (live.get(k) !== rec) { bmp.close(); continue; }   // evicted while decoding
      const tex = new THREE.Texture(bmp);
      Object.assign(tex, { flipY: false, colorSpace: THREE.SRGBColorSpace, generateMipmaps: false, minFilter: THREE.LinearFilter, needsUpdate: true });
      renderer.initTexture(tex);   // upload now, inside this frame's budget, not at an unlucky draw later
      rec.mesh = tileMesh(k, tex); sky.add(rec.mesh); rec.born = performance.now();
      timings.tiles.push(performance.now() - t0);
      break;
    }
  }
  const viewDir = new THREE.Vector3();
  let lastRefine = 0;
  function refine(now) {
    if (now - lastRefine < 200) return; lastRefine = now;
    if (camera.fov > 25) return;
    camera.getWorldDirection(viewDir);
    const cosR = Math.cos(Math.min(25, camera.fov * 0.9 * Math.max(1, camera.aspect)) * D2R);
    const want = [];
    for (let k = 0; k < NT; k++) {
      const d = centers[k * 3] * viewDir.x + centers[k * 3 + 1] * viewDir.y + centers[k * 3 + 2] * viewDir.z;
      if (d > cosR) want.push([d, k]);
    }
    want.sort((a, b) => b[0] - a[0]);
    for (const [, k] of want.slice(0, 48)) {
      if (live.has(k)) { live.get(k).used = now; continue; }
      const rec = { mesh: null, used: now }; live.set(k, rec);
      const t0 = performance.now(), dir = Math.floor(k / 10000) * 10000;
      loader.load(`${HIPS}/Norder${ORDER}/Dir${dir}/Npix${k}.png`, bmp => arrived.push({ k, rec, bmp, t0 }), undefined, () => live.delete(k));
    }
    if (live.size > 120) {   // forget the least recently used tiles
      [...live.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, live.size - 120).forEach(([k, r]) => {
        if (r.mesh) { sky.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh.material.map.image.close?.(); r.mesh.material.map.dispose(); r.mesh.material.dispose(); }
        live.delete(k);
      });
    }
  }

  // ---------- layer 3: Gaia stars within 25 pc, one draw call, motion on the GPU ----------
  const starMat = new THREE.ShaderMaterial({
    uniforms: { uKyr: { value: 0 }, uPx: { value: renderer.getPixelRatio() } },
    vertexShader: `
      attribute vec3 vel; attribute float absmag; attribute vec3 color;
      uniform float uKyr, uPx; varying vec3 vColor; varying float vA;
      void main(){
        vec3 p = position + vel * uKyr;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float d = max(length(mv.xyz), 0.01);
        float m = absmag + 5.0 * log(d / 10.0) / log(10.0);
        gl_PointSize = clamp((9.0 - m) * 1.1, 1.2, 16.0) * uPx;
        vA = clamp((12.0 - m) / 6.0, 0.15, 1.0); vColor = color;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vA;
      void main(){ float r = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, r); gl_FragColor = vec4(vColor * a * vA, 1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true
  });
  const stars = fetch('data/stars.json').then(r => r.json()).then(S => {
    const n = S.n, pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      cel(S.pos[3 * i], S.pos[3 * i + 1], S.pos[3 * i + 2], v).toArray(pos, 3 * i);
      cel(S.vel[3 * i], S.vel[3 * i + 1], S.vel[3 * i + 2], v).toArray(vel, 3 * i);
      const b = Math.max(-0.2, Math.min(3.5, S.bp_rp[i])) / 3.5;
      col.set([1.0, 0.95 - 0.45 * b, 0.9 - 0.75 * b + (b < 0.15 ? 0.1 : 0)], 3 * i);
    }
    // ponytail: extra synthetic stars only for a stress test (?stress=N), real data stays at 5,323
    const g = new THREE.BufferGeometry();
    const all = (a, k) => { const out = new Float32Array((n + stress) * k); out.set(a); return out; };
    const P3 = all(pos, 3), V3 = all(vel, 3), C3 = all(col, 3), M = all(Float32Array.from(S.absmag), 1);
    for (let i = n; i < n + stress; i++) { v.randomDirection().multiplyScalar(5 + Math.random() * 60).toArray(P3, 3 * i); C3.set([1, .9, .8], 3 * i); M[i] = 8 + Math.random() * 6; }
    g.setAttribute('position', new THREE.BufferAttribute(P3, 3));
    g.setAttribute('vel', new THREE.BufferAttribute(V3, 3));
    g.setAttribute('color', new THREE.BufferAttribute(C3, 3));
    g.setAttribute('absmag', new THREE.BufferAttribute(M, 1));
    const points = new THREE.Points(g, starMat);
    scene.add(points);
    return { n, pos, vel, points };
  });

  // call once per frame, before rendering
  function update(now, frameStart) {
    sky.position.copy(camera.position);
    for (const r of live.values()) if (r.mesh && r.mesh.material.opacity < 1) r.mesh.material.opacity = Math.min(1, (now - r.born) / 250);
    refine(now); addArrivedTiles(frameStart);
  }
  const sharpTiles = () => [...live.values()].filter(r => r.mesh).length;
  return { sky, starMat, stars, timings, update, sharpTiles };
}
