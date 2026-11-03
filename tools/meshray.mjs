// meshray.mjs: rays and segments against the triangles of a glb (the outpost scan), for tools/prep-shell.mjs and tools/check-shell.mjs.
//   const M = await loadMesh(file, { ground: true, cuts: [{ x0, x1, z0, z1, y0, y1 }] })
//     ground: leave out the ground slab, steps and rubble (up- or down-facing triangles that lie below 1.3 m): the sim has the terrain for those
//     cuts:   leave out every triangle whose centre lies inside one of these boxes (the same list main.js removes from the drawn model)
//   M.hits(o, d, tmax, accept)  distances (sorted) of every triangle the ray o + t d (d a unit vector) hits for t < tmax; accept(t) may filter triangles
//   M.blocked(a, b)             true if the segment a -> b is cut by any triangle
//   M.tri(t)                    { nx, ny, nz, cx, cy, cz, ymax } of triangle t (unit normal, centre, highest corner)
//   M.bounds                    { x0, x1, y0, y1, z0, z1 } of the triangles that were kept
// A 1 m grid over x and z holds the triangle lists, so a ray only meets the triangles near its path.
import { createRequire } from 'node:module';
const { NodeIO } = createRequire(import.meta.url)('@gltf-transform/core');

export async function loadMesh(file, { ground = true, cuts = [] } = {}) {
  const doc = await new NodeIO().read(file), prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const P = prim.getAttribute('POSITION').getArray(), I = prim.getIndices().getArray(), nT = I.length / 3;
  const nrm = new Float32Array(3 * nT), ctr = new Float32Array(3 * nT), ymax = new Float32Array(nT), kept = [];
  const b = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9 };
  for (let t = 0; t < nT; t++) {
    const a = I[3 * t] * 3, c = I[3 * t + 1] * 3, d = I[3 * t + 2] * 3;
    const e1x = P[c] - P[a], e1y = P[c + 1] - P[a + 1], e1z = P[c + 2] - P[a + 2], e2x = P[d] - P[a], e2y = P[d + 1] - P[a + 1], e2z = P[d + 2] - P[a + 2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    nrm[3 * t] = nx; nrm[3 * t + 1] = ny; nrm[3 * t + 2] = nz;
    const cx = (P[a] + P[c] + P[d]) / 3, cy = (P[a + 1] + P[c + 1] + P[d + 1]) / 3, cz = (P[a + 2] + P[c + 2] + P[d + 2]) / 3;
    ctr[3 * t] = cx; ctr[3 * t + 1] = cy; ctr[3 * t + 2] = cz; ymax[t] = Math.max(P[a + 1], P[c + 1], P[d + 1]);
    if (ground && Math.abs(ny) > 0.75 && ymax[t] < 1.3) continue;
    if (cuts.some((k) => cx >= k.x0 && cx <= k.x1 && cy >= k.y0 && cy <= k.y1 && cz >= k.z0 && cz <= k.z1)) continue;
    kept.push(t);
    for (const i of [a, c, d]) { b.x0 = Math.min(b.x0, P[i]); b.x1 = Math.max(b.x1, P[i]); b.y0 = Math.min(b.y0, P[i + 1]); b.y1 = Math.max(b.y1, P[i + 1]); b.z0 = Math.min(b.z0, P[i + 2]); b.z1 = Math.max(b.z1, P[i + 2]); }
  }
  const X0 = Math.floor(b.x0) - 1, Z0 = Math.floor(b.z0) - 1, W = Math.ceil(b.x1) - X0 + 2, H = Math.ceil(b.z1) - Z0 + 2, cells = Array.from({ length: W * H }, () => []);
  for (const t of kept) {
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let k = 0; k < 3; k++) { const i = I[3 * t + k] * 3; x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); z0 = Math.min(z0, P[i + 2]); z1 = Math.max(z1, P[i + 2]); }
    for (let cz = Math.floor(z0) - Z0; cz <= Math.floor(z1) - Z0; cz++) for (let cx = Math.floor(x0) - X0; cx <= Math.floor(x1) - X0; cx++) cells[cz * W + cx].push(t);
  }
  function one(t, ox, oy, oz, dx, dy, dz) { // Moller-Trumbore: distance along d to triangle t, or -1
    const a = I[3 * t] * 3, c = I[3 * t + 1] * 3, d = I[3 * t + 2] * 3;
    const e1x = P[c] - P[a], e1y = P[c + 1] - P[a + 1], e1z = P[c + 2] - P[a + 2], e2x = P[d] - P[a], e2y = P[d + 1] - P[a + 1], e2z = P[d + 2] - P[a + 2];
    const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x, det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-12) return -1;
    const f = 1 / det, sx = ox - P[a], sy = oy - P[a + 1], sz = oz - P[a + 2], u = f * (sx * hx + sy * hy + sz * hz);
    if (u < 0 || u > 1) return -1;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, v = f * (dx * qx + dy * qy + dz * qz);
    if (v < 0 || u + v > 1) return -1;
    const tt = f * (e2x * qx + e2y * qy + e2z * qz); return tt > 1e-5 ? tt : -1;
  }
  function hits(o, d, tmax, accept) {
    const seen = new Set(), out = [], n = Math.ceil(tmax / 0.4);
    for (let s = 0; s <= n; s++) {
      const t = Math.min(tmax, s * 0.4), cx = Math.floor(o[0] + d[0] * t) - X0, cz = Math.floor(o[2] + d[2] * t) - Z0;
      if (cx < 0 || cz < 0 || cx >= W || cz >= H) continue;
      for (const tr of cells[cz * W + cx]) {
        if (seen.has(tr)) continue; seen.add(tr);
        if (accept && !accept(tr)) continue;
        const h = one(tr, o[0], o[1], o[2], d[0], d[1], d[2]); if (h > 0 && h < tmax) out.push(h);
      }
    }
    return out.sort((x, y) => x - y);
  }
  function blocked(a, c) {
    const d = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], len = Math.hypot(...d); if (len < 1e-9) return false;
    const u = d.map((v) => v / len), seen = new Set(), n = Math.ceil(len / 0.4);
    for (let s = 0; s <= n; s++) {
      const t = Math.min(len, s * 0.4), cx = Math.floor(a[0] + u[0] * t) - X0, cz = Math.floor(a[2] + u[2] * t) - Z0;
      if (cx < 0 || cz < 0 || cx >= W || cz >= H) continue;
      for (const tr of cells[cz * W + cx]) { if (seen.has(tr)) continue; seen.add(tr); const h = one(tr, a[0], a[1], a[2], u[0], u[1], u[2]); if (h > 0 && h < len) return true; }
    }
    return false;
  }
  const tri = (t) => ({ nx: nrm[3 * t], ny: nrm[3 * t + 1], nz: nrm[3 * t + 2], cx: ctr[3 * t], cy: ctr[3 * t + 1], cz: ctr[3 * t + 2], ymax: ymax[t] });
  return { hits, blocked, tri, bounds: b, count: kept.length, total: nT };
}
