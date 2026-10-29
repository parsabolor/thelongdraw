// Conifers for the outpost: three seeded variants (slender pine, spruce, scraggly old pine), drawn as InstancedMeshes.
//
//   buildTreeVariant(variant, rng?) -> { trunk, canopy }   PURE (no DOM, no Math.random, runs in Node). variant = index into TREE_VARIANTS.
//     Built 6 m tall (tip at 6.06), base at y = 0 (trunk sunk to y = -0.3), axis +y, metres. rng defaults to mulberry32(variant).
//     trunk:  position / normal / uv         uv = metres / bark tileMeters (1.5): v = y, u = arc length from a mirrored seam (no visible seam)
//     canopy: position / normal / uv / color  uv: u around (integer repeats), v 0 (trunk) .. 1 (rim); color = brightness / tint multiplier
//     <= 4 attributes each: WebGPU allows 8 vertex buffers per pipeline including the instance matrices, more and the mesh silently vanishes.
//   createFoliageMaterial(seed) -> MeshStandardMaterial: canvas needle texture + alphaTest, DoubleSide (flat dark green without a DOM)
//   variantOf(i, seed) -> variant index createTrees gives to trees[i]
//   createTrees({ trees: [{ x, y0, z, h }], barkMaterial, seed }) -> THREE.Group   (group.userData.triangles = total drawn triangles)
//     h = total tree height in metres. Instance matrix = T(x, y0, z) * Ry(hash yaw) * S(sxz, h / 6, sxz), sxz = sqrt(h / 6) * (0.92..1.08)
//     per axis: height scales linearly, girth and crown only with its square root, so an 8 m tree has a 0.35 m trunk, not 0.4.
//     The lowest skirt is at 2.4 m at h = 6 (2.0 m at h = 5): the sim only treats the trunk (r 0.3) as cover, the crown is for show.
import * as THREE from 'three';

const H = 6, TIP = 6.06, SINK = 0.3, TILE = 1.5, MIN_Y = 2.4, TAU = Math.PI * 2;

// yLow: height of the lowest skirt tips; rMax/rTop: crown radius at the bottom / top tier; slope: skirt drop / radius; irr: per-tier radius
// irregularity; off: per-tier sideways shift; lean: trunk lean at the tip; stubs: dead branches on the trunk up to stubTop.
export const TREE_VARIANTS = [
  { name: 'slender pine', tiers: 8, yLow: 2.7, rMax: 1.45, rTop: 0.2, rPow: 0.9, slope: 0.5, spokes: 18, layers: 2, lean: 0.06, off: 0.04, irr: 0.1, stubs: 5, stubTop: 2.4, stubLen: 0.4 },
  { name: 'spruce', tiers: 7, yLow: 2.55, rMax: 1.8, rTop: 0.25, rPow: 1.0, slope: 0.45, spokes: 20, layers: 2, lean: 0.08, off: 0.06, irr: 0.1, stubs: 6, stubTop: 2.4, stubLen: 0.45 },
  { name: 'old pine', tiers: 6, yLow: 3.0, rMax: 1.45, rTop: 0.3, rPow: 0.7, slope: 0.45, spokes: 14, layers: 1, lean: 0.25, off: 0.28, irr: 0.3, stubs: 11, stubTop: 4.4, stubLen: 0.6 },
];

const mulberry32 = (a) => () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const norm = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
const mesh = () => ({ p: [], n: [], t: [], c: [], i: [] });
const vtx = (m, p, n, t, c) => { m.p.push(...p); m.n.push(...n); m.t.push(...t); if (c) m.c.push(...c); return m.p.length / 3 - 1; };
function geometry(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(m.n, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(m.t, 2));
  if (m.c.length) g.setAttribute('color', new THREE.Float32BufferAttribute(m.c, 3));
  g.setIndex(m.i);
  return g;
}

// One drooping skirt: an open cone shell around the trunk, profile y = ya - D * f^1.7 (flat near the trunk, bending down at the rim),
// whose rim is a zigzag of long tips (one per spoke) and shorter notches between them; the alpha-cut texture ragged-ises it further.
function skirt(m, rng, { cx, cz, ya, R, D, N, phi, shade, hue, rep }) {
  const sp = Array.from({ length: N }, (_, k) => ({ a: phi + (k + (rng() - 0.5) * 0.4) * TAU / N, len: 0.82 + rng() * 0.33, dj: 0.85 + rng() * 0.25, cj: 0.92 + rng() * 0.16 }));
  const put = (a, len, dj, cj, f, u) => {
    const r = R * len * f, drop = D * dj, nr = drop * 1.7 * f ** 0.7, ny = R * len, s = shade * cj * (0.4 + 0.6 * f ** 0.7); // darker toward the trunk
    return vtx(m, [cx + Math.cos(a) * r, Math.max(ya - drop * f ** 1.7, MIN_Y), cz + Math.sin(a) * r],
      norm(Math.cos(a) * nr, ny, Math.sin(a) * nr), [u, f], [s * (1 + hue), s, s * (1 - hue)]);
  };
  const F = [0.12, 0.45, 0.75], ring = F.map(() => []), tip = [], notch = [];
  for (let k = 0; k <= N; k++) { // column N repeats column 0 so the texture can wrap
    const s = sp[k % N], t = sp[(k + 1) % N], a = s.a + (k === N ? TAU : 0), a2 = t.a + (k + 1 >= N ? TAU : 0), u = k / N * rep;
    F.forEach((f, j) => ring[j].push(put(a, s.len, s.dj, s.cj, f, u)));
    tip.push(put(a, s.len, s.dj, s.cj, 1, u));
    if (k < N) notch.push(put((a + a2) / 2, (s.len + t.len) / 2, (s.dj + t.dj) / 2, (s.cj + t.cj) / 2, 0.8, u + rep / N / 2));
  }
  for (let k = 0; k < N; k++) {
    for (let j = 0; j < 2; j++) { const a = ring[j][k], b = ring[j][k + 1], c = ring[j + 1][k], d = ring[j + 1][k + 1]; m.i.push(a, c, b, b, c, d); }
    const a = ring[2][k], b = ring[2][k + 1];
    m.i.push(a, tip[k], notch[k], a, notch[k], b, b, notch[k], tip[k + 1]);
  }
}

export function buildTreeVariant(variant, rng = mulberry32(variant)) {
  const v = TREE_VARIANTS[variant], leanDir = rng() * TAU;
  const axis = (y) => { const o = v.lean * (Math.max(y, 0) / H) ** 2; return [Math.cos(leanDir) * o, Math.sin(leanDir) * o]; }; // trunk centre line
  const rad = (y) => (y < 0 ? 0.25 + 0.05 * (-y / SINK) : Math.max(0.012, 0.25 * (1 - y / TIP) ** 0.8)); // slight flare below ground, taper above

  // trunk: 10-sided, bumpy rings, bark uv in metres, ends in a thin leader
  const T = mesh(), S = 10, ys = [-SINK, 0, 0.4, 1, 1.8, 2.7, 3.6, 4.4, 5, 5.5, 5.85];
  ys.forEach((y) => {
    const [ax, az] = axis(y), r = rad(y), p1 = rng() * TAU, p2 = rng() * TAU;
    for (let k = 0; k < S; k++) {
      const a = k / S * TAU, rr = r * (1 + 0.04 * Math.sin(2 * a + p1 + 0.9 * y) + 0.025 * Math.sin(5 * a + p2 + 1.7 * y));
      const m = 1 - Math.abs(2 * k / S - 1); // 0 -> 1 -> 0 around the trunk: mirrored u, so no seam
      vtx(T, [ax + Math.cos(a) * rr, y, az + Math.sin(a) * rr], norm(Math.cos(a), 0.15, Math.sin(a)), [m * Math.PI * r / TILE, y / TILE]);
    }
  });
  for (let j = 0; j < ys.length - 1; j++) for (let k = 0; k < S; k++) {
    const a = j * S + k, b = j * S + (k + 1) % S, c = a + S, d = b + S;
    T.i.push(a, c, b, b, c, d);
  }
  const [tx, tz] = axis(TIP), apex = vtx(T, [tx, TIP, tz], [0, 1, 0], [0, TIP / TILE]);
  for (let k = 0; k < S; k++) T.i.push((ys.length - 1) * S + k, apex, (ys.length - 1) * S + (k + 1) % S);

  // dead stubby branches on the lower trunk: 5-sided tapering spikes (bark uv: u around, v along)
  for (let s = 0; s < v.stubs; s++) {
    const y = 0.9 + (v.stubTop - 0.9) * (s + rng() * 0.8) / v.stubs, a = rng() * TAU, el = (rng() - 0.35) * 0.6, L = v.stubLen * (0.7 + 0.6 * rng()), rb = 0.032 + 0.02 * rng();
    const [ax, az] = axis(y), d = norm(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
    const e1 = norm(-d[2], 0, d[0]), e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
    const p0 = [ax + Math.cos(a) * rad(y) * 0.55, y, az + Math.sin(a) * rad(y) * 0.55], rings = [];
    for (const [t, q] of [[0, 1], [0.5, 0.6]]) {
      rings.push([]);
      for (let k = 0; k <= 5; k++) {
        const b = k / 5 * TAU, c = [Math.cos(b), Math.sin(b)], n = [0, 1, 2].map((i) => e1[i] * c[0] + e2[i] * c[1]);
        rings[rings.length - 1].push(vtx(T, [0, 1, 2].map((i) => p0[i] + d[i] * L * t + n[i] * rb * q), n, [k / 5 * TAU * rb * q / TILE, (y + L * t) / TILE]));
      }
    }
    const end = vtx(T, [0, 1, 2].map((i) => p0[i] + d[i] * L), d, [0, (y + L) / TILE]);
    for (let k = 0; k < 5; k++) T.i.push(rings[0][k], rings[1][k], rings[0][k + 1], rings[0][k + 1], rings[1][k], rings[1][k + 1], rings[1][k], end, rings[1][k + 1]);
  }

  // canopy: tiers shrink toward the top, each a main skirt plus (spruce, slender pine) a smaller inner one, rotated half a spoke and higher
  const C = mesh();
  for (let i = 0; i < v.tiers; i++) {
    const f = i / (v.tiers - 1), R = (v.rTop + (v.rMax - v.rTop) * (1 - f) ** v.rPow) * (1 + v.irr * (rng() - 0.6)), D = Math.max(0.45, R * v.slope);
    const yTip = v.yLow + (5.25 - v.yLow) * f ** 0.85, phi = rng() * TAU, oa = rng() * TAU, orad = v.off * rng(), shade = 0.9 + 0.3 * f + 0.08 * (rng() - 0.5), hue = 0.05 * (rng() - 0.5);
    const N = Math.max(8, Math.round(v.spokes * Math.sqrt(R / v.rMax)));
    const at = (ya) => { const [ax, az] = axis(ya); return { cx: ax + Math.cos(oa) * orad, cz: az + Math.sin(oa) * orad }; };
    skirt(C, rng, { ...at(yTip + D), ya: yTip + D, R, D, N, phi, shade, hue, rep: Math.max(1, Math.round(TAU * R / 2.4)) });
    if (v.layers > 1) skirt(C, rng, { ...at(yTip + 1.2 * D), ya: yTip + 1.2 * D, R: R * 0.62, D: D * 0.8, N: Math.max(8, N - 4), phi: phi + Math.PI / N, shade: shade * 0.95, hue, rep: Math.max(1, Math.round(TAU * R * 0.62 / 2.4)) });
  }
  return { trunk: geometry(T), canopy: geometry(C) };
}

// ---- foliage material (browser-only texture kept apart from the pure builders) ----

// Tiling needle sprays: u across, v up from the trunk end (canvas bottom) to the rim (canvas top). Opaque core, ragged fronds toward the rim.
function needleTexture(rng) {
  if (typeof document === 'undefined') return null;
  const W = 512, cv = Object.assign(document.createElement('canvas'), { width: W, height: W }), g = cv.getContext('2d');
  const pal = ['#5f9482', '#548876', '#6aa08c', '#497a69', '#5c8f7d'], frost = ['#c3d8de', '#e4eef1'];
  g.fillStyle = '#3d6a5b'; g.fillRect(0, W * 0.5, W, W * 0.5); g.lineCap = 'round';
  const nf = 30, needle = (x, y, th, nl, col) => { g.strokeStyle = col; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.sin(th) * nl, y - Math.cos(th) * nl); g.stroke(); };
  for (let i = 0; i < nf; i++) { // a frond: stem up the canvas with side branchlets, each carrying short needles
    const x0 = (i + 0.5 + (rng() - 0.5) * 0.6) / nf * W, len = W * (0.62 + rng() * 0.36), drift = (rng() - 0.5) * 40;
    for (const dx of [-W, 0, W]) {
      if (Math.abs(x0 + dx - W / 2) > W / 2 + 70) continue; // wrap copies only where a frond crosses the edge
      g.strokeStyle = '#2c4a3f'; g.lineWidth = 3; g.beginPath(); g.moveTo(x0 + dx, W); g.lineTo(x0 + dx + drift, W - len); g.stroke();
      for (let t = 0; t < 1; t += 0.035) {
        const x = x0 + dx + drift * t * t, y = W - len * t, bl = 14 + 60 * (1 - t) ** 0.6 * (0.7 + 0.3 * rng());
        for (const side of [-1, 1]) {
          const th = (0.8 + 0.3 * rng()) * side, ex = x + Math.sin(th) * bl, ey = y - Math.cos(th) * bl;
          g.strokeStyle = '#2c4a3f'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, y); g.lineTo(ex, ey); g.stroke();
          g.lineWidth = 1.8;
          for (let u = 0.15; u <= 1; u += 0.17) for (const sd of [-1, 1]) {
            const c = u > 0.5 && rng() < 0.05 + 0.5 * t * t * t;
            needle(x + (ex - x) * u, y + (ey - y) * u, th + sd * (0.7 + 0.4 * rng()), 8 + 9 * (1 - u * 0.5) * rng() + 4, c ? frost[(rng() * 2) | 0] : pal[(rng() * pal.length) | 0]);
          }
        }
      }
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = THREE.RepeatWrapping; tex.anisotropy = 4;
  return tex;
}

// emissive (times the needle map) = a dim floor so needles in the crown's own shadow read as foliage, not black holes (the night ambient is nearly black)
export function createFoliageMaterial(seed = 0) {
  const map = needleTexture(mulberry32(seed + 101));
  return new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: map ? 0x3a3a3a : 0x12261f, color: map ? 0xffffff : 0x1f3d33, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
}

// ---- instancing ----

const treeRng = (i, seed) => mulberry32(i * 2654435761 + seed); // stable per instance index: first draw picks the variant, then yaw, then scale
export const variantOf = (i, seed = 0) => Math.floor(treeRng(i, seed)() * TREE_VARIANTS.length);

export function createTrees({ trees, barkMaterial, seed = 0 }) {
  const group = new THREE.Group(), leaf = createFoliageMaterial(seed), lists = TREE_VARIANTS.map(() => []);
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), s = new THREE.Vector3();
  trees.forEach((t, i) => {
    const r = treeRng(i, seed), v = Math.floor(r() * TREE_VARIANTS.length), k = Math.sqrt(t.h / H);
    q.setFromAxisAngle(up, r() * TAU); s.set(k * (0.92 + 0.16 * r()), t.h / H, k * (0.92 + 0.16 * r()));
    lists[v].push(new THREE.Matrix4().compose(p.set(t.x, t.y0, t.z), q, s));
  });
  let triangles = 0;
  lists.forEach((list, v) => {
    if (!list.length) return;
    const { trunk, canopy } = buildTreeVariant(v);
    for (const [geo, mat] of [[trunk, barkMaterial], [canopy, leaf]]) {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = im.receiveShadow = true;
      im.computeBoundingSphere();
      group.add(im);
      triangles += geo.index.count / 3 * list.length;
    }
  });
  group.userData.triangles = triangles;
  return group;
}
