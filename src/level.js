import { WORLD } from './world-data.js';

// The outpost as data. World frame: x east, z south, y up, metres; the fort's pad is the origin and y = 0 exactly (the terrain is baked
// that way by tools/prep-world.mjs from the supplied scans). A yaw of 0 faces +z.
// Rules, enforced by buildLevel() in sim.js: every box has y0 === 0 (solid from the ground, walkable on top when low enough) or
// y0 >= 2.5 (overhead: blocks sight and arrows, ignored by movement), and the ground under a box is exactly 0.

// ---------- terrain: the baked 1 m grid (src/world-data.js, GENERATED), mirrored beyond its edge so it stays continuous ----------
const N = WORLD.n, LO = WORLD.x0, SPAN = (N - 1) * WORLD.step, grid = new Float32Array(N * N);
{
  const raw = atob(WORLD.heights), dv = new DataView(Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer);
  for (let i = 0; i < grid.length; i++) grid[i] = (dv.getUint16(i * 2, true) - WORLD.zero) / WORLD.scale;
}
const fold = (v) => { let t = (v - LO) % (2 * SPAN); if (t < 0) t += 2 * SPAN; return LO + (t > SPAN ? 2 * SPAN - t : t); };
export function terrainHeight(x, z) {
  const fx = (fold(x) - LO) / WORLD.step, fz = (fold(z) - LO) / WORLD.step, a = Math.min(N - 2, Math.floor(fx)), b = Math.min(N - 2, Math.floor(fz)), u = fx - a, v = fz - b;
  const g = (i, j) => grid[j * N + i];
  return (g(a, b) * (1 - u) + g(a + 1, b) * u) * (1 - v) + (g(a, b + 1) * (1 - u) + g(a + 1, b + 1) * u) * v;
}
// The renderer's ground: a smooth (Catmull-Rom) surface through the SAME 1 m samples, so it meets terrainHeight at every grid point and is only a few
// centimetres off between them (p99 about 11 cm), without the facets of the bilinear one. The sim keeps terrainHeight: ground contact, line of sight and
// path finding all stay as they were; the renderer subdivides its mesh finely and takes the heights from here.
const cr = (p0, p1, p2, p3, t) => 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
export function terrainSurface(x, z) {
  const fx = (fold(x) - LO) / WORLD.step, fz = (fold(z) - LO) / WORLD.step, a = Math.floor(fx), b = Math.floor(fz), u = fx - a, v = fz - b;
  const g = (i, j) => grid[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];
  const row = (j) => cr(g(a - 1, j), g(a, j), g(a + 1, j), g(a + 2, j), u);
  return cr(row(b - 1), row(b), row(b + 1), row(b + 2), v);
}
// The ground mesh for the renderer, as flat typed arrays (pure: no THREE). Inside +-`inner` m it is subdivided `sub` times (0.25 m cells) on the smooth surface;
// out to +-`outer` m it is the plain 1 m grid. The seam is welded and its heights are the straight (bilinear) ones, so the two meet exactly and there are no cracks.
// uv follows the supplied scan's texture: u from the heightmap x, v from its z (flipped: image rows run downward), mirrored beyond the scan like the heights.
export function terrainGrid({ outer = 140, inner = 60, sub = 4 } = {}) {
  const sc = WORLD.scan, span = sc.x1 - sc.x0, no = 2 * outer + 1, nf = 2 * inner * sub + 1, h = 1 / sub;
  const foldScan = (v) => { let t = (v - sc.x0) % (2 * span); if (t < 0) t += 2 * span; return t > span ? 2 * span - t : t; };
  const coarse = no * no, fine = nf * nf, pos = new Float32Array((coarse + fine) * 3), uv = new Float32Array((coarse + fine) * 2);
  const put = (i, x, z, y) => { pos[3 * i] = x; pos[3 * i + 1] = y; pos[3 * i + 2] = z; uv[2 * i] = foldScan(x + WORLD.site.x) / span; uv[2 * i + 1] = 1 - foldScan(z + WORLD.site.z) / span; };
  for (let iz = 0; iz < no; iz++) for (let ix = 0; ix < no; ix++) { const x = ix - outer, z = iz - outer; put(iz * no + ix, x, z, terrainHeight(x, z)); }
  const fineIndex = (i, j) => { // the vertex of the fine block at (i, j): on its edge a corner of the coarse grid is shared with it, the rest are its own
    if ((i === 0 || j === 0 || i === nf - 1 || j === nf - 1) && i % sub === 0 && j % sub === 0) return ((j / sub - inner + outer) * no) + (i / sub - inner + outer);
    return coarse + j * nf + i;
  };
  for (let j = 0; j < nf; j++) for (let i = 0; i < nf; i++) {
    const idx = fineIndex(i, j); if (idx < coarse) continue;
    const x = -inner + i * h, z = -inner + j * h, edge = i === 0 || j === 0 || i === nf - 1 || j === nf - 1;
    put(idx, x, z, edge ? terrainHeight(x, z) : terrainSurface(x, z));
  }
  const tri = [], quad = (a, b, c, d) => tri.push(a, c, b, b, c, d); // a b / c d, looking down: counter-clockwise from above
  for (let iz = 0; iz < no - 1; iz++) for (let ix = 0; ix < no - 1; ix++) {
    const cx = ix - outer, cz = iz - outer;
    if (cx >= -inner && cx + 1 <= inner && cz >= -inner && cz + 1 <= inner) continue; // covered by the fine block
    quad(iz * no + ix, iz * no + ix + 1, (iz + 1) * no + ix, (iz + 1) * no + ix + 1);
  }
  for (let j = 0; j < nf - 1; j++) for (let i = 0; i < nf - 1; i++) quad(fineIndex(i, j), fineIndex(i + 1, j), fineIndex(i, j + 1), fineIndex(i + 1, j + 1));
  return { positions: pos, uvs: uv, indices: Uint32Array.from(tri), counts: { coarse, fine, triangles: tri.length / 3 } };
}
export const slopeAt = (x, z) => Math.hypot(terrainHeight(x + 0.5, z) - terrainHeight(x - 0.5, z), terrainHeight(x, z + 0.5) - terrainHeight(x, z - 0.5));
// footstep and impact material: bare rock where it is steep, hard dirt on the pad, grass and dirt patches elsewhere
export function terrainTag(x, z) {
  if (slopeAt(x, z) > 0.55) return 'rock';
  if (Math.abs(x) < WORLD.pad.hx + 2 && Math.abs(z) < WORLD.pad.hz + 2) return 'dirt';
  return Math.sin(x * 0.37 + z * 0.21) * Math.sin(z * 0.29 - x * 0.17) > -0.15 ? 'grass' : 'dirt';
}

// ---------- the fort: boxes authored by hand from the 1 m column maps that tools/prep-world.mjs prints for the cleaned scan ----------
// Stone ruin on the pad: a 3 m high shell with a flat roof deck (overhead), a 7.4 m tower in the north-west corner, and one doorway in the
// front (south) wall at x 1..3. The outpost model (assets/world/outpost.glb) is drawn over these boxes; they are collision only.
const boxes = [];
const add = (x0, x1, z0, z1, y1, tag, y0 = 0) => boxes.push({ x0, x1, z0, z1, y0, y1, tag });
add(-8, -3, -3, 1, 7.4, 'rock');           // tower (solid)
add(-7, -6, 1, 5, 3, 'rock');              // west wall
add(-2, 5, -6, -5, 3, 'rock');             // north wall
add(-3, -1, -5, -4, 3, 'rock');            // north-west chamfer
add(-4, -2, -4, -3, 3, 'rock');
add(4, 6, -5, -4, 3, 'rock');              // north-east chamfer
add(4, 7, -4, -3, 3, 'rock');
add(6, 7, -3, 5, 3, 'rock');               // east wall
add(-7, -3, 5, 6, 3.9, 'rock');            // front wall, with its stepped gable
add(-3, 0, 5, 6, 5.2, 'rock');
add(0, 1, 5, 6, 5.9, 'rock');
add(1, 3, 5, 6, 5.9, 'rock', 2.6);         // lintel over the 2 m doorway (overhead)
add(3, 6, 5, 6, 5.2, 'rock');
add(6, 7, 5, 6, 3.9, 'rock');
add(1, 2, -2, -1, 6.1, 'rock');            // chimney on the roof deck
add(-4, -2, 1, 3, 6.5, 'rock');            // pillar on the roof deck, west
add(-3, 8, -6, 6, 3.1, 'rock', 2.6);       // roof deck over the main body (overhead)
add(-8, -3, 1, 6, 3.3, 'rock', 2.6);       // roof deck, west part
for (const b of boxes) b.skin = 'outpost'; // main.js hides these grey boxes once the scanned fort model has loaded
add(4.5, 5.5, 8, 9, 3, 'metal');           // the bell post on the pad in front of the door
add(9, 11.4, -9, -6.56, 1.95, 'wood');     // a lookout hut at the edge of the pad: the footprint of the hut model (assets/models/game/hut.fbx)
boxes[boxes.length - 1].skin = 'hut';      // main.js hides this box and stands the model on it when the model has loaded

// ---------- anchors: where things start (tuned against the reachable ground, see test/sim.test.mjs) ----------
// The player starts in the low south-west valley (about 11 m below the pad) and climbs north-east to the fort. Three scouts hold vantage points
// over the basin: the south-east plateau (25 m up), the east rim over the pad and the north ridge.
const face = (x, z) => Math.atan2(-x, -z); // yaw that looks at the fort from (x, z)
const START = { x: -43, z: 31, yaw: face(-43, 31) };
const BIKE = { x: -40, z: 33 };
const SPAWNS = [
  { role: 'scout', x: 26, z: 44, yaw: face(26, 44) },     // south-east plateau: sees the whole south-west approach and the pad
  { role: 'scout', x: 30, z: -4, yaw: face(30, -4) },     // east rim, straight over the pad
  { role: 'scout', x: 17, z: -50, yaw: face(17, -50) },   // north ridge
  { role: 'hunter', x: -25, z: 16, yaw: 0, patrol: [[-25, 16], [-14, 22], [-16, 6], [-31, 17]] },   // the valley, first contact
  { role: 'hunter', x: -10, z: 12, yaw: 0, patrol: [[-10, 12], [-16, 6], [-11, 0], [-14, 13]] },    // west of the fort
  { role: 'hunter', x: 13, z: 12, yaw: 0, patrol: [[13, 12], [8, 14], [4, 12], [12, 6]] },          // at the foot of the escarpment
  { role: 'hunter', x: -12, z: -14, yaw: 0, patrol: [[-12, -14], [-4, -18], [4, -14], [-8, -10]] }, // behind the fort
  { role: 'hunter', x: 12, z: -12, yaw: 0, patrol: [[12, -12], [14, -6], [8, -16], [14, -18]] },    // north-east basin
  { role: 'sleeper', x: -4, z: 3, yaw: 0 },               // inside the fort
  { role: 'sleeper', x: -1, z: -3, yaw: 0 },
  { role: 'sleeper', x: 3, z: 2, yaw: 0 },
  { role: 'sleeper', x: 2, z: -3, yaw: 0 },
  { role: 'screamer', x: 2, z: 10, yaw: 0, patrol: [[2, 10], [-4, 11], [6, 11], [10, 8]] },          // guards the door
];

// ---------- trees and boulders: rejection scatter on gentle ground, clear of the pad and of every anchor ----------
function scatter(seed, avoid) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647, props = [];
  for (let tries = 0; tries < 3000 && props.length < 150; tries++) {
    const x = (rnd() - 0.5) * 112, z = (rnd() - 0.5) * 112, sl = slopeAt(x, z), kind = rnd() < 0.72 ? 'tree' : 'rock';
    if (sl > (kind === 'tree' ? 0.42 : 0.7) || (Math.abs(x) < WORLD.pad.hx + 4 && Math.abs(z) < WORLD.pad.hz + 4)) continue;
    if (avoid.some(([ax, az, r]) => Math.hypot(x - ax, z - az) < r) || props.some((p) => Math.hypot(x - p.x, z - p.z) < 3)) continue;
    props.push(kind === 'tree' ? { kind, x, z, r: 0.3, h: 5 + rnd() * 3 } : { kind, x, z, r: 0.8 + rnd() * 1.2, h: 0.8 + rnd() * 1.1 });
  }
  return props;
}

export const LEVEL = {
  bounds: { x0: -60, z0: -60, w: 120, d: 120 },
  boxes,
  terrain: terrainHeight,
  terrainTag,
  props: [],
  limit: 56, // nobody goes further than this from the pad; beyond it the ground is sealed (see def.seal in sim.js)
  seal: true,
  start: START,
  bike: BIKE,
  enter: { x: 0, z: 0, r: 34 }, // the bike can be used to bail once the player is within 34 m of the fort
  wind: { speed: 5.5, gust: 4.5, swing: 0.9 }, // m/s: swells between ~3.6 and 5.5, gusts to 10; the heading is set per run (see sim.windAt)
  bell: { x: 5, y: 3.2, z: 8.5 },
  // Waypoints zombies re-draw their patrols from after a search, so the layout reshuffles.
  patrol: [[-10, 12], [10, 12], [-14, 0], [14, -4], [0, -14], [-12, -14], [12, -12], [0, 14], [-16, 6], [8, -8]],
  spawns: SPAWNS,
};
LEVEL.props = scatter(11, [[START.x, START.z, 6], [BIKE.x, BIKE.z, 4], ...SPAWNS.flatMap((s) => [[s.x, s.z, 3], ...(s.patrol || []).map(([x, z]) => [x, z, 2.5])]), ...LEVEL.patrol.map(([x, z]) => [x, z, 2.5])]);
