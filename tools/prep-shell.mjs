// prep-shell.mjs: builds the SIGHT SHELL of the outpost from the scan itself, so that arrows, zombies' eyes and the binoculars see what the model shows.
//   node tools/prep-shell.mjs        reads assets/world/outpost.glb, writes src/shell-data.js (GENERATED: commit it)
// The scan is a one-sided sheet (its walls have no thickness) with window slots, a door and holes. Hand-placed 1 m boxes could not follow that, so the shell is
// sampled from the model: rays along z and along x (through the walls) and along y (above 1.8 m: the roof deck, parapets, the tower's top) mark 0.1 m voxels at
// every wall-like or deck-like hit, thickened along the ray by 0.2 m each way (a wall is 0.4 m thick); a window is simply a place where no ray hit. The voxels
// are merged greedily into boxes. They are `mode: 'sight'` boxes (rays only); what a body may walk through is authored separately in level.js, on the 1 m grid.
// The scan's junk (membranes of photogrammetry fill across the hall, the doorway and the windows) is already gone from the model: tools/prep-world.mjs drops it.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadMesh } from './meshray.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)), GLB = ROOT + 'assets/world/outpost.glb', OUT = ROOT + 'src/shell-data.js';
// voxel size, thickening each way, the smallest box kept (m3), where flat surfaces start to count (the first three can be tried out as STEP=, HALF=, MINV= in the environment)
// cells [x, z] (the cell whose lower corner is x, z) kept open or closed for bodies whatever the shell fills: the front doorway (x 1..2) and the porch corridor behind it
const BODY_FREE = [[1, 5], [1, 4], [1, 3], [1, 2]], BODY_SOLID = [], BODY_FILL = Number(process.env.FILL || 0.15);
const STEP = Number(process.env.STEP || 0.1), HALF = Number(process.env.HALF || 0.1), MIN_VOLUME = Number(process.env.MINV || 0.01), ROOF_FROM = 1.8, COMP = Number(process.env.COMP || 0.5), SNAP = Number(process.env.SNAP || 0.2);

async function main() {
  const M = await loadMesh(GLB, { ground: true }), B = M.bounds;
  const ox = Math.floor(B.x0) - 1, oy = Math.max(0, Math.floor(B.y0)), oz = Math.floor(B.z0) - 1;
  const nx = Math.ceil((B.x1 + 1 - ox) / STEP), ny = Math.ceil((B.y1 + 0.5 - oy) / STEP), nz = Math.ceil((B.z1 + 1 - oz) / STEP);
  const vox = new Uint8Array(nx * ny * nz), at = (ix, iy, iz) => (iz * ny + iy) * nx + ix;
  const mark = (ix, iy, iz) => { if (ix >= 0 && iy >= 0 && iz >= 0 && ix < nx && iy < ny && iz < nz) vox[at(ix, iy, iz)] = 1; };
  const k = Math.round(HALF / STEP), snap = (v) => Math.round(v / SNAP) * SNAP; // a hit is moved to the nearest SNAP grid line first: the relief of the stones (+-0.1 m) then lines the slabs up into long flat boxes
  const wall = (axis) => (t) => { const n = M.tri(t); return Math.abs(axis === 'z' ? n.nz : n.nx) >= 0.6; };
  const zWall = wall('z'), xWall = wall('x'), deck = (t) => { const n = M.tri(t); return Math.abs(n.ny) >= 0.7 && n.cy >= ROOF_FROM; };
  let rays = 0;
  for (let iy = 0; iy < ny; iy++) {
    const y = oy + (iy + 0.5) * STEP;
    for (let ix = 0; ix < nx; ix++) { // along -z, through walls that face the front or the back
      const x = ox + (ix + 0.5) * STEP; rays++;
      for (const h of M.hits([x, y, oz + nz * STEP], [0, 0, -1], nz * STEP, zWall)) { const iz = Math.floor((snap(oz + nz * STEP - h) - oz) / STEP); for (let d = -k; d <= k; d++) mark(ix, iy, iz + d); }
    }
    for (let iz = 0; iz < nz; iz++) { // along -x, through walls that face east or west
      const z = oz + (iz + 0.5) * STEP; rays++;
      for (const h of M.hits([ox + nx * STEP, y, z], [-1, 0, 0], nx * STEP, xWall)) { const ix = Math.floor((snap(ox + nx * STEP - h) - ox) / STEP); for (let d = -k; d <= k; d++) mark(ix + d, iy, iz); }
    }
  }
  const kk = Math.round(0.15 / STEP);
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) { // straight down, onto roofs, ledges and the underside of lintels
    const x = ox + (ix + 0.5) * STEP, z = oz + (iz + 0.5) * STEP; rays++;
    for (const h of M.hits([x, oy + ny * STEP, z], [0, -1, 0], ny * STEP, deck)) { const iy = Math.floor((ny * STEP - h) / STEP); for (let d = -kk; d <= kk; d++) mark(ix, iy + d, iz); }
  }
  // Debris: the scan has floating shards (a sliver of stone in the middle of a room). A piece of solid that is smaller than COMP m3 is not part of any wall: drop it,
  // so it does not stop an arrow that the model lets through.
  const label = new Int32Array(vox.length), stack = new Int32Array(vox.length), sizes = [0];
  for (let s = 0; s < vox.length; s++) {
    if (!vox[s] || label[s]) continue;
    const id = sizes.length; let top = 0, n = 0; stack[top++] = s; label[s] = id;
    while (top) {
      const i = stack[--top]; n++; const ix = i % nx, iy = Math.floor(i / nx) % ny, iz = Math.floor(i / (nx * ny));
      for (const [j, ok] of [[i - 1, ix > 0], [i + 1, ix < nx - 1], [i - nx, iy > 0], [i + nx, iy < ny - 1], [i - nx * ny, iz > 0], [i + nx * ny, iz < nz - 1]]) if (ok && vox[j] && !label[j]) { label[j] = id; stack[top++] = j; }
    }
    sizes.push(n);
  }
  let dropped = 0; for (let i = 0; i < vox.length; i++) if (vox[i] && sizes[label[i]] * STEP ** 3 < COMP) { vox[i] = 0; dropped++; }
  // greedy merge: grow a box from the first free voxel along x, then y, then z while the whole face stays solid and unused
  const used = new Uint8Array(vox.length), boxes = [], solid = (ix, iy, iz) => vox[at(ix, iy, iz)] && !used[at(ix, iy, iz)];
  let voxels = 0;
  for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    if (!solid(ix, iy, iz)) continue;
    let x1 = ix; while (x1 + 1 < nx && solid(x1 + 1, iy, iz)) x1++;
    let y1 = iy; grow_y: while (y1 + 1 < ny) { for (let x = ix; x <= x1; x++) if (!solid(x, y1 + 1, iz)) break grow_y; y1++; }
    let z1 = iz; grow_z: while (z1 + 1 < nz) { for (let y = iy; y <= y1; y++) for (let x = ix; x <= x1; x++) if (!solid(x, y, z1 + 1)) break grow_z; z1++; }
    for (let z = iz; z <= z1; z++) for (let y = iy; y <= y1; y++) for (let x = ix; x <= x1; x++) { used[at(x, y, z)] = 1; voxels++; }
    boxes.push([ox + ix * STEP, ox + (x1 + 1) * STEP, oz + iz * STEP, oz + (z1 + 1) * STEP, oy + iy * STEP, oy + (y1 + 1) * STEP]);
  }
  const r = (v) => Math.round(v * 100) / 100;
  const kept = boxes.filter((b) => (b[1] - b[0]) * (b[3] - b[2]) * (b[5] - b[4]) >= MIN_VOLUME).map((b) => b.map(r));
  // What a BODY meets: the sim walks on a 1 m grid, so the movement layer is cells. A cell is solid if the shell fills at least BODY_FILL m3 of it between the knee
  // and the head (0.45 to 1.9 m), and its box is as tall as the shell is there; BODY_FREE cells are kept open whatever the shell says (the doorway and the porch
  // behind it: the model's door is about 1 m wide, the cell [1, 2) is the closest whole cell), BODY_SOLID ones closed. Cells with the same height merge into rectangles.
  const cellTop = new Map();
  for (let cx = Math.floor(B.x0); cx <= Math.ceil(B.x1); cx++) for (let cz = Math.floor(B.z0); cz <= Math.ceil(B.z1); cz++) {
    let v = 0, top = 0;
    for (const [x0, x1, z0, z1, y0, y1] of kept) {
      const w = Math.min(x1, cx + 1) - Math.max(x0, cx), d = Math.min(z1, cz + 1) - Math.max(z0, cz), h = Math.min(y1, 1.9) - Math.max(y0, 0.45);
      if (w > 0 && d > 0 && h > 0) { v += w * d * h; top = Math.max(top, y1); }
    }
    const key = cx + ',' + cz, free = BODY_FREE.some(([x, z]) => x === cx && z === cz), solid = BODY_SOLID.some(([x, z]) => x === cx && z === cz);
    if (solid || (v >= BODY_FILL && !free)) cellTop.set(key, Math.max(3, Math.min(8, Math.ceil(top * 2) / 2)));
  }
  const bodyBoxes = [], seen = new Set();
  for (const [key, top] of cellTop) { // greedy: extend along x while the height matches, then down z while the whole run matches
    if (seen.has(key)) continue; const [cx, cz] = key.split(',').map(Number);
    let x1 = cx; while (cellTop.get(x1 + 1 + ',' + cz) === top && !seen.has(x1 + 1 + ',' + cz)) x1++;
    let z1 = cz; grow: while (true) { for (let x = cx; x <= x1; x++) if (cellTop.get(x + ',' + (z1 + 1)) !== top || seen.has(x + ',' + (z1 + 1))) break grow; z1++; }
    for (let z = cz; z <= z1; z++) for (let x = cx; x <= x1; x++) seen.add(x + ',' + z);
    bodyBoxes.push([cx, x1 + 1, cz, z1 + 1, top]);
  }
  const body = kept.map((b) => `  [${b.join(', ')}],`).join('\n');
  fs.writeFileSync(OUT, `// GENERATED by tools/prep-shell.mjs from assets/world/outpost.glb: do not edit; run \`node tools/prep-shell.mjs\` again after changing the model.
// SIGHT_BOXES: ${kept.length} thin boxes [x0, x1, z0, z1, y0, y1] in metres, world frame, for rays only (arrows, zombies' eyes, binoculars): the walls with their
// window slots and doorway, the roof deck, the tower.
export const SIGHT_BOXES = [
${body}
];
// BODY_BOXES: ${bodyBoxes.length} cell-aligned boxes [x0, x1, z0, z1, top] (y from 0) that a body cannot walk through: whole 1 m cells of the movement grid (the doorway cell and the porch behind it
// are left open). level.js turns them into \`mode: 'body'\` boxes; they are also what is drawn as grey blocks if the model file is missing.
export const BODY_BOXES = ${JSON.stringify(bodyBoxes)};
`);
  console.log(`body cells ${cellTop.size} -> ${bodyBoxes.length} boxes`);
  console.log(`rays ${rays}, voxels ${voxels} (${dropped} dropped as debris), boxes ${boxes.length} -> kept ${kept.length} (volume >= ${MIN_VOLUME} m3); wrote src/shell-data.js (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
