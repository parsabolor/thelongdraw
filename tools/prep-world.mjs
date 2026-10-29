// Builds the playable world from the two scans the project owner supplied (assets/models/incoming/). Re-runnable, deterministic.
//   node tools/prep-world.mjs terrain   bakes the terrain heightmap into src/world-data.js (GENERATED) and converts the terrain textures
//   node tools/prep-world.mjs outpost   cleans and simplifies the outpost scan into assets/world/outpost.glb and prints 1 m column maps
//                                       of what is left (the collision boxes in src/level.js are authored by hand from those maps)
//
// World frame: the outpost pad is at the origin and y = 0 (the sim needs ground exactly 0 under every box). The terrain scan is a regular
// grid (199.6 m square, 0..39 m of relief); heightmap (hx, hz) = world (x, z) + SITE, and world y = heightmap height - PAD_H.
// The sim samples terrain at 1 m corners, so that is the resolution baked here: the visual mesh uses the same grid (anything finer would
// only subdivide the same bilinear surface; the detail comes from the scan's normal map).
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IN = `${ROOT}assets/models/incoming/`, OUT = `${ROOT}assets/world/`;
const stage = process.argv[2];

// ---- constants chosen by hand (see the analysis in the plan note) -------------------------------------------------------------
export const SITE = { x: -42, z: -42 };                // heightmap coordinates of the world origin: a basin with higher ground all round
export const HALF = 100;                               // the baked grid covers world [-100, 100] in 1 m steps (201 x 201)
export const PAD = { hx: 11, hz: 10, skirt: 12 };      // flat plateau half extents around the origin and the blend distance to natural ground
export const ZERO = 20000, SCALE = 1000;               // uint16 code = round(y * SCALE) + ZERO, so y = 0 is exactly representable
export const YAW = 0;                                  // rotation of the scan about Y when placing it (radians)
// the fort inside the scan (scan coordinates, metres): where the structure is, with margin
const FOOT = { x0: -14, x1: 8, z0: -6, z1: 14 }, FOOT_C = { x: -3.1, z: 3.8 };
// The scan's door is up a short stair (0.2, 0.8, 1.2 m) onto a raised floor. The sim floor is the flat pad, so the whole model is lowered by the
// sill height: the doorway then opens onto the pad, the stair sinks into the ground, and the interior floor is the sim's floor.
const SILL = 1.2;
// How much of the scan the outpost keeps: triangles after simplification (the scan has 1.3M), and the pixels of each texture (the scan's are 8192).
export const OUTPOST = { tris: 220000, diffuse: 4096, normal: 2048 };

fs.mkdirSync(OUT, { recursive: true });
const sips = (src, dst, px, q = 88) => execFileSync('sips', ['-Z', String(px), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(q), src, '--out', dst], { stdio: 'ignore' });

// =============================================================================================================================
async function terrain() {
  const T = `${IN}rugged-terrain/source/Rugged_terrain_x/`;
  globalThis.document = { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, set src(v) {}, style: {} }) }; // FBXLoader builds image elements for textures we do not use here
  const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
  const buf = fs.readFileSync(`${T}Rugged_terrain.fbx`);
  const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  let mesh = null; root.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  mesh.updateMatrixWorld(true);
  const pos = mesh.geometry.attributes.position, m = mesh.matrixWorld.elements, n = pos.count;

  // 1. fine heightmap (513 x 513 over the scan's square) by binning the vertices of the displaced grid
  const FN = 513; let x0 = Infinity, x1 = -Infinity;
  for (let i = 0; i < n; i++) { const x = m[0] * pos.getX(i) + m[4] * pos.getY(i) + m[8] * pos.getZ(i) + m[12]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  const sum = new Float64Array(FN * FN), cnt = new Uint32Array(FN * FN), span = x1 - x0;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wy = m[1] * x + m[5] * y + m[9] * z + m[13], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const k = Math.round(((wz - x0) / span) * (FN - 1)) * FN + Math.round(((wx - x0) / span) * (FN - 1));
    sum[k] += wy; cnt[k]++;
  }
  const fine = new Float32Array(FN * FN);
  for (let k = 0; k < fine.length; k++) fine[k] = cnt[k] ? sum[k] / cnt[k] : NaN;
  for (let pass = 0; pass < 8; pass++) for (let gz = 0; gz < FN; gz++) for (let gx = 0; gx < FN; gx++) { // fill any empty cell from its neighbours
    const k = gz * FN + gx; if (!Number.isNaN(fine[k])) continue;
    let s = 0, c = 0; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = gx + dx, b = gz + dz; if (a >= 0 && b >= 0 && a < FN && b < FN && !Number.isNaN(fine[b * FN + a])) { s += fine[b * FN + a]; c++; } }
    if (c) fine[k] = s / c;
  }
  const cell = span / (FN - 1), lo = x0, hi = x1;
  const reflect = (v) => { while (v < lo || v > hi) v = v < lo ? 2 * lo - v : 2 * hi - v; return v; }; // beyond the scan the ground mirrors itself, so it stays continuous
  const hm = (hx, hz) => { // bilinear on the fine grid
    const fx = (reflect(hx) - lo) / cell, fz = (reflect(hz) - lo) / cell, a = Math.min(FN - 2, Math.floor(fx)), b = Math.min(FN - 2, Math.floor(fz)), u = fx - a, v = fz - b, g = (i, j) => fine[j * FN + i];
    return (g(a, b) * (1 - u) + g(a + 1, b) * u) * (1 - v) + (g(a, b + 1) * (1 - u) + g(a + 1, b + 1) * u) * v;
  };

  // 2. natural ground on the sim's 1 m grid: the mean of 3 x 3 samples over each 1 m cell around the grid point
  const N = 2 * HALF + 1, nat = new Float32Array(N * N);
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    let s = 0; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) s += hm(ix - HALF + SITE.x + dx * 0.33, iz - HALF + SITE.z + dz * 0.33);
    nat[iz * N + ix] = s / 9;
  }
  // pad height: the mean natural ground over the pad rectangle, so the cut and the fill are about equal
  let padH = 0, pc = 0;
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) { const x = ix - HALF, z = iz - HALF; if (Math.abs(x) <= PAD.hx && Math.abs(z) <= PAD.hz) { padH += nat[iz * N + ix]; pc++; } }
  padH /= pc;

  // 3. the plateau: exactly 0 inside the pad rectangle grown by one cell (buildLevel tests every corner under a box), a smooth blend outside
  const grid = new Float32Array(N * N); let cut = 0, fill = 0;
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const x = ix - HALF, z = iz - HALF, dx = Math.max(0, Math.abs(x) - (PAD.hx + 1)), dz = Math.max(0, Math.abs(z) - (PAD.hz + 1)), d = Math.hypot(dx, dz);
    const w = Math.min(1, d / PAD.skirt), s = w * w * (3 - 2 * w), natural = nat[iz * N + ix] - padH;
    grid[iz * N + ix] = natural * s; // s = 0 on the pad, 1 beyond the skirt
    if (s < 1) { if (natural > 0) cut += natural * (1 - s); else fill -= natural * (1 - s); }
  }
  const u16 = new Uint16Array(N * N);
  for (let k = 0; k < u16.length; k++) u16[k] = Math.max(0, Math.min(65535, Math.round(grid[k] * SCALE) + ZERO));
  const b64 = Buffer.from(u16.buffer).toString('base64');

  // 4. report
  let mx = -1e9, mn = 1e9, steep = 0, cells = 0;
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const h = (u16[iz * N + ix] - ZERO) / SCALE; mx = Math.max(mx, h); mn = Math.min(mn, h);
    if (ix > 0 && iz > 0 && Math.abs(ix - HALF) < 55 && Math.abs(iz - HALF) < 55) { cells++; const g = (u16[iz * N + ix] - u16[iz * N + ix - 1]) / SCALE, f = (u16[iz * N + ix] - u16[(iz - 1) * N + ix]) / SCALE; if (Math.hypot(g, f) > 0.9) steep++; }
  }
  console.log(`pad height in the scan ${padH.toFixed(2)} m; world y ${mn.toFixed(1)}..${mx.toFixed(1)}; steep (>0.9) share of the play area ${(100 * steep / cells).toFixed(1)}%; skirt cut ${cut.toFixed(0)} fill ${fill.toFixed(0)}`);

  // 5. the generated module
  const hash = crypto.createHash('sha1').update(buf).update(JSON.stringify({ SITE, HALF, PAD, ZERO, SCALE })).digest('hex').slice(0, 12);
  fs.writeFileSync(`${ROOT}src/world-data.js`,
`// GENERATED by tools/prep-world.mjs terrain (input hash ${hash}). Do not edit.
// The terrain on the sim's 1 m grid, world frame: the outpost pad is the origin and y = 0 exactly (code ${ZERO}).
// heights: little-endian uint16 base64, row = z (from z0), column = x (from x0); y = (code - zero) / scale.
export const WORLD = {
  n: ${N}, x0: ${-HALF}, z0: ${-HALF}, step: 1, zero: ${ZERO}, scale: ${SCALE},
  pad: { hx: ${PAD.hx}, hz: ${PAD.hz} }, site: { x: ${SITE.x}, z: ${SITE.z}, padH: ${padH.toFixed(4)} }, scan: { x0: ${lo.toFixed(4)}, x1: ${hi.toFixed(4)} },
  heights: '${b64}',
};
`);
  // 6. textures: the scan's colour and normal maps over the 199.6 m square
  sips(`${T}Combine.tif`, `${OUT}terrain_albedo.jpg`, 1024); sips(`${T}Normal Map.tif`, `${OUT}terrain_normal.jpg`, 1024);
  console.log('wrote src/world-data.js', (fs.statSync(`${ROOT}src/world-data.js`).size / 1024).toFixed(0), 'KB and assets/world/terrain_{albedo,normal}.jpg');
}

// =============================================================================================================================
async function outpost() {
  const { MeshoptSimplifier } = await import('meshoptimizer');
  const { Document, NodeIO } = await import('@gltf-transform/core');
  await MeshoptSimplifier.ready;
  const D = `${IN}abandoned-military-outpost-building-scan/source/model_x/`;

  // 1. read the OBJ (v, vt, f v/vt/vn, usemtl groups), merging (v, vt) pairs into single vertices
  const readline = (await import('node:readline')).default;
  const P = [], UV = [], uniq = new Map(), pos = [], uv = [], groups = new Map(); let cur = null;
  for await (const line of readline.createInterface({ input: fs.createReadStream(`${D}model.obj`), crlfDelay: Infinity })) {
    const c = line.charCodeAt(0);
    if (c === 118) { const t = line.split(' '); if (t[0] === 'v') P.push(+t[1], +t[2], +t[3]); else if (t[0] === 'vt') UV.push(+t[1], +t[2]); }
    else if (c === 117) { const name = line.slice(7).trim(); if (!groups.has(name)) groups.set(name, []); cur = groups.get(name); }
    else if (c === 102) {
      const t = line.split(' ');
      for (let k = 1; k <= 3; k++) {
        const [vi, ti] = t[k].split('/'), key = (+vi - 1) * 1048576 + (+ti - 1);
        let id = uniq.get(key);
        if (id === undefined) { id = pos.length / 3; uniq.set(key, id); const a = (+vi - 1) * 3, b = (+ti - 1) * 2; pos.push(P[a], P[a + 1], P[a + 2]); uv.push(UV[b], UV[b + 1]); }
        cur.push(id);
      }
    }
  }
  const V = new Float32Array(pos), TX = new Float32Array(uv);
  console.log('read', [...groups].map(([k, l]) => `${k}:${l.length / 3}`).join(' '), 'triangles,', V.length / 3, 'vertices');

  // 2. ground under and around the fort: a plane fitted to the lowest points of a ring just outside it
  const ring = { x0: FOOT.x0 - 5, x1: FOOT.x1 + 5, z0: FOOT.z0 - 5, z1: FOOT.z1 + 5 }, low = new Map();
  for (let i = 0; i < V.length; i += 3) {
    const x = V[i], z = V[i + 2];
    if (x < ring.x0 || x > ring.x1 || z < ring.z0 || z > ring.z1) continue;
    if (x > FOOT.x0 - 0.5 && x < FOOT.x1 + 0.5 && z > FOOT.z0 - 0.5 && z < FOOT.z1 + 0.5) continue;
    const k = Math.floor(x) * 4096 + Math.floor(z); const v = low.get(k);
    if (!v || V[i + 1] < v.y) low.set(k, { x, y: V[i + 1], z });
  }
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
  for (const { x, y, z } of low.values()) { const r = [x, z, 1]; for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) A[a][b] += r[a] * r[b]; B[a] += r[a] * y; } }
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const dA = det(A), col = (j) => A.map((row, i) => row.map((v, k) => (k === j ? B[i] : v)));
  const [pa, pb, pc] = [0, 1, 2].map((j) => det(col(j)) / dA); // ground(x, z) = pa x + pb z + pc
  const ground = (x, z) => pa * x + pb * z + pc;
  console.log(`ground plane around the fort: slope ${pa.toFixed(3)} / ${pb.toFixed(3)}, ${low.size} samples, level at the fort centre ${ground(FOOT_C.x, FOOT_C.z).toFixed(2)}`);

  // 3. keep the structure: drop ground-level up-facing triangles, everything below ground, thin slivers, and anything outside the fort
  const keep = new Map(); const dropped = { ground: 0, under: 0, sliver: 0, outside: 0 };
  for (const [name, list] of groups) {
    const out = [];
    for (let t = 0; t < list.length; t += 3) {
      const ia = list[t] * 3, ib = list[t + 1] * 3, ic = list[t + 2] * 3;
      if ([ia, ib, ic].some((i) => V[i] < FOOT.x0 || V[i] > FOOT.x1 || V[i + 2] < FOOT.z0 || V[i + 2] > FOOT.z1)) { dropped.outside++; continue; } // every corner inside: long slivers reach out
      const ux = V[ib] - V[ia], uy = V[ib + 1] - V[ia + 1], uz = V[ib + 2] - V[ia + 2], vx = V[ic] - V[ia], vy = V[ic + 1] - V[ia + 1], vz = V[ic + 2] - V[ia + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, area2 = Math.hypot(nx, ny, nz) || 1e-12;
      const e = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(V[ic] - V[ib], V[ic + 1] - V[ib + 1], V[ic + 2] - V[ib + 2]));
      if (e > 6 || (e > 2.5 && area2 / 2 / (e * e) < 0.15)) { dropped.sliver++; continue; } // photogrammetry triangles are small: a long one is a fill artefact
      const h = [ia, ib, ic].map((i) => V[i + 1] - ground(V[i], V[i + 2]));
      if (Math.max(...h) < -0.4) { dropped.under++; continue; }
      if (Math.max(...h) < 0.35 && Math.abs(ny) / area2 > 0.6) { dropped.ground++; continue; }
      out.push(list[t], list[t + 1], list[t + 2]);
    }
    keep.set(name, out);
  }
  console.log('dropped', JSON.stringify(dropped), 'kept', [...keep].map(([k, l]) => `${k}:${l.length / 3}`).join(' '));

  // 4. remove small floating islands (connected components under 300 triangles)
  const parent = new Map(); const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  for (const list of keep.values()) for (const v of list) if (!parent.has(v)) parent.set(v, v);
  for (const list of keep.values()) for (let t = 0; t < list.length; t += 3) { const a = find(list[t]), b = find(list[t + 1]), c = find(list[t + 2]); parent.set(b, a); parent.set(find(c), find(a)); }
  const size = new Map(); for (const list of keep.values()) for (let t = 0; t < list.length; t += 3) { const r = find(list[t]); size.set(r, (size.get(r) || 0) + 1); }
  let islands = 0;
  for (const [name, list] of keep) { const out = []; for (let t = 0; t < list.length; t += 3) { if (size.get(find(list[t])) >= 300) out.push(list[t], list[t + 1], list[t + 2]); else islands++; } keep.set(name, out); }
  console.log('removed', islands, 'island triangles');

  // 5. place in the world frame, simplify (UV-aware), smooth normals, write the GLB with downsized textures
  const base = ground(FOOT_C.x, FOOT_C.z) + 0.2 + SILL; // pad level in scan coordinates; walls sink into it so none float, and the door sill is the pad
  const c = Math.cos(YAW), s = Math.sin(YAW);
  const place = (x, y, z) => { const px = x - FOOT_C.x, pz = z - FOOT_C.z; return [c * px + s * pz, y - base, -s * px + c * pz]; };
  const doc = new Document(), buffer = doc.createBuffer(), scene = doc.createScene(), node = doc.createNode('outpost'); scene.addChild(node);
  const mesh = doc.createMesh('outpost'); node.setMesh(mesh);
  const total = [...keep.values()].reduce((a, l) => a + l.length / 3, 0), TARGET = OUTPOST.tris;
  let tris = 0; const world = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9 }, kept = [];
  for (const [name, list] of keep) {
    if (!list.length) continue;
    const idx = new Uint32Array(list), target = Math.max(1500, Math.floor((idx.length * Math.min(1, TARGET / total)) / 3) * 3);
    const [simp] = MeshoptSimplifier.simplifyWithAttributes(idx, V, 3, TX, 2, [1, 1], null, target, 0.02, ['LockBorder']);
    const [remap, count] = MeshoptSimplifier.compactMesh(simp);
    const p = new Float32Array(count * 3), t = new Float32Array(count * 2), nrm = new Float32Array(count * 3);
    for (let i = 0; i < remap.length; i++) { const r = remap[i]; if (r === 0xffffffff) continue; const w = place(V[i * 3], V[i * 3 + 1], V[i * 3 + 2]); p.set(w, r * 3); t.set(TX.subarray(i * 2, i * 2 + 2), r * 2); } // remap is shorter than V: an out-of-range read here once smeared vertex 0 across the map
    for (let i = 0; i < p.length; i += 3) { world.x0 = Math.min(world.x0, p[i]); world.x1 = Math.max(world.x1, p[i]); world.y0 = Math.min(world.y0, p[i + 1]); world.y1 = Math.max(world.y1, p[i + 1]); world.z0 = Math.min(world.z0, p[i + 2]); world.z1 = Math.max(world.z1, p[i + 2]); }
    for (let i = 0; i < simp.length; i += 3) { // area-weighted vertex normals
      const a = simp[i] * 3, b = simp[i + 1] * 3, d = simp[i + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[d] - p[a], vy = p[d + 1] - p[a + 1], vz = p[d + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const k of [a, b, d]) { nrm[k] += nx; nrm[k + 1] += ny; nrm[k + 2] += nz; }
    }
    for (let i = 0; i < nrm.length; i += 3) { const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1; nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l; }
    tris += simp.length / 3; kept.push({ p, idx: simp });
    const mat = doc.createMaterial(name).setRoughnessFactor(0.95).setMetallicFactor(0);
    for (const [kind, px] of [['diffuse', OUTPOST.diffuse], ['normal', OUTPOST.normal]]) {
      const jpg = `${OUT}outpost_${name}_${kind}.jpg`; sips(`${D}${name}_${kind}.jpg`, jpg, px, 85);
      const tex = doc.createTexture(`${name}_${kind}`).setImage(fs.readFileSync(jpg)).setMimeType('image/jpeg');
      if (kind === 'diffuse') mat.setBaseColorTexture(tex); else mat.setNormalTexture(tex);
      fs.unlinkSync(jpg); // only the copy this script just made
    }
    mesh.addPrimitive(doc.createPrimitive().setMaterial(mat)
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(p).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(t).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(simp)).setBuffer(buffer)));
  }
  await new NodeIO().write(`${OUT}outpost.glb`, doc);
  console.log(`wrote assets/world/outpost.glb: ${tris} triangles, ${(fs.statSync(`${OUT}outpost.glb`).size / 1e6).toFixed(1)} MB; world box x ${world.x0.toFixed(1)}..${world.x1.toFixed(1)} y ${world.y0.toFixed(1)}..${world.y1.toFixed(1)} z ${world.z0.toFixed(1)}..${world.z1.toFixed(1)}`);

  // 6. 1 m column maps of what is left, for authoring the collision boxes by hand: per cell the top and the lowest point of the structure
  //    (triangles sampled every ~0.25 m so thin walls are not missed). '.' = nothing. Digits are metres (0-9, then letters a-z).
  const X0 = Math.floor(world.x0), X1 = Math.ceil(world.x1), Z0 = Math.floor(world.z0), Z1 = Math.ceil(world.z1), W = X1 - X0, H = Z1 - Z0;
  const top = new Float32Array(W * H).fill(-1e9), bot = new Float32Array(W * H).fill(1e9), hits = new Uint16Array(W * H), NB = 12, bins = new Uint16Array(W * H * NB); // bins: samples per 1 m height band
  const cellOf = (x, z) => Math.floor(z - Z0) * W + Math.floor(x - X0);
  for (const { p, idx } of kept) for (let t = 0; t < idx.length; t += 3) {
    const a = [p[idx[t] * 3], p[idx[t] * 3 + 1], p[idx[t] * 3 + 2]], b = [p[idx[t + 1] * 3], p[idx[t + 1] * 3 + 1], p[idx[t + 1] * 3 + 2]], d = [p[idx[t + 2] * 3], p[idx[t + 2] * 3 + 1], p[idx[t + 2] * 3 + 2]];
    const e = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2])), n = Math.max(1, Math.ceil(e / 0.25));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, v = j / n, w = 1 - u - v, x = a[0] * w + b[0] * u + d[0] * v, y = a[1] * w + b[1] * u + d[1] * v, z = a[2] * w + b[2] * u + d[2] * v, k = cellOf(x, z);
      if (k < 0 || k >= top.length) continue;
      top[k] = Math.max(top[k], y); bot[k] = Math.min(bot[k], y); hits[k]++;
      if (y >= 0) bins[k * NB + Math.min(NB - 1, Math.floor(y))]++;
    }
  }
  // one map per height band: '#' where the band has real samples (walls and roofs show up as outlines), '.' where it is open
  for (let b = 0; b < 10; b++) {
    console.log(`\nband ${b}..${b + 1} m (x ${X0}..${X1 - 1} across, z ${Z0}..${Z1 - 1} down): # = surface samples here`);
    for (let r = 0; r < H; r++) { let s = String(Z0 + r).padStart(4) + ' '; for (let q = 0; q < W; q++) s += bins[(r * W + q) * NB + b] > 6 ? '#' : '.'; console.log(s); }
  }
  const ch = (v) => (v < -0.5 ? '-' : v < 10 ? String(Math.round(v)) : String.fromCharCode(97 + Math.min(25, Math.round(v) - 10)));
  const dump = (title, f) => { console.log(`\n${title} (x ${X0}..${X1 - 1} across, z ${Z0}..${Z1 - 1} down)`); for (let r = 0; r < H; r++) { let s = String(Z0 + r).padStart(4) + ' '; for (let q = 0; q < W; q++) { const k = r * W + q; s += hits[k] > 2 ? f(k) : '.'; } console.log(s); } };
  console.log('\n      ' + Array.from({ length: W }, (_, i) => String(Math.abs(X0 + i) % 10)).join(''));
  dump('TOP of structure above the pad, m', (k) => ch(top[k]));
  dump('LOWEST point of structure, m (0 = on the ground; higher = an opening below it)', (k) => ch(bot[k]));
  fs.writeFileSync(`${OUT}columns.json`, JSON.stringify({ x0: X0, z0: Z0, w: W, h: H, top: [...top].map((v) => (v < -1e8 ? null : +v.toFixed(2))), bot: [...bot].map((v) => (v > 1e8 ? null : +v.toFixed(2))), hits: [...hits], nb: NB, bins: [...bins] }));
}

if (stage === 'terrain') await terrain();
else if (stage === 'outpost') await outpost();
else console.log('usage: node tools/prep-world.mjs terrain | outpost');
