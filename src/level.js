import { WORLD } from './world-data.js';
import { SIGHT_BOXES, BODY_BOXES } from './shell-data.js';

// The outpost as data. World frame: x east, z south, y up, metres; the fort's pad is the origin and y = 0 exactly (the terrain is baked
// that way by tools/prep-world.mjs from the supplied scans). A yaw of 0 faces +z.
// Rules, enforced by buildLevel() in sim.js: every box that blocks bodies has y0 === 0 (solid from the ground, walkable on top when low enough) or
// y0 >= 2.5 (overhead: blocks sight and arrows, ignored by movement), and the ground under a box is exactly 0. A box with mode 'sight' only
// blocks rays, so it is free of both rules; one with mode 'body' only blocks bodies.

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
// ---------- the scouts' lookout towers ----------
// Each scout stands on the deck of a lookout tower (assets/models/game/hut.fbx: a small wooden tower with a plank deck, a stair up to it and a palisade beside it, drawn `scale`
// times its size, its deck raised to `deck` m over its feet; main.js draws it as the engine does). The model's posts have a fixed length, so on a slope they would hang in the air on
// one side and a body would walk into the deck on the other: the 1 m height grid is blended toward the tower's base height, level within `flat` metres and back to the hillside
// over `blend` more (terrainHeight, terrainSurface and the drawn ground all read this one grid). Beyond that (the stair's foot, the palisade's end) the drawing lets its bottom down
// to the ground where the ground falls below the base: every height under `foot` m is lowered toward it, fully at 0 and not at all at `foot` (sim.js does the same to the parts).
// parts: the tower's solid parts as the rules meet them (sim.js towerTop, towerBlocks, rayTowers), measured on the drawn model (the engine's test holds them to its mesh). Each is a
// box in the tower's own frame: u along the stair (up it is +u, the deck's middle is 0), v across, y metres over the base, lo -1 for one that stands on the ground; `slope` (rise
// per metre of u) tilts both its faces from their heights at u[0] (the stair and the roof's two sides). mode as for the level's boxes: 'sight' blocks rays only, 'body' bodies only, none both.
//   deck: the planks (top 3.25, where the scout stands) from where the stair meets it to the far rail. stair: a ramp through the tops of its eight treads (0.375 m rise, 0.42 m
//   run: the body climbs it smoothly, its feet within 0.17 m of a tread), 0.35 m thick. fence: the palisade on the -v side, 3 m tall; for bodies taller (3.8 m) than any
//   floor a step from it, so that nobody steps onto its top from the upper stair and over it (every part's top is a floor: the deck's, the stair's). rails: a single bar round
//   three sides of the deck, 0.55 to 0.9 m over it, open where the stair comes up (the corner posts leave no room beside the stair's head to step off): a body on the deck cannot pass
//   it ('body', deck to bar top), a ray only meets the bar ('sight'). Under the deck: barred on the +u side and along the bottom of the stair side; open on the +v side
//   under a bar at 1.91 m, between the struts that lean on its posts, so a body walks in there.
// route: three points on the stair's axis that zombies climb by (sim.js goTo): `foot` on the ground before it, `bottom` on its first tread, `top` on the deck.
// watch: where the scout stands, at the rail on the side that faces the fort, 0.4 m from it, on a plank (from the deck's middle the rail, the posts and the roof hid the yard of the fort from
// the plateau's scout: a lookout leans on the rail).
// turn: the model's own turn in its frame, so a tower's frame is turned by its yaw plus this (TOWERS carry its cosine and sine: the rules use no trigonometry of their own).
export const TOWER = {
  scale: 3.6, deck: 3.25, flat: 3.2, blend: 6, foot: 1, turn: 0.4451,
  parts: [
    { u: [-1.51, 1.36], v: [-1.36, 1.36], y: [2.98, 3.25] }, // deck
    { u: [-6.0, -1.51], v: [-0.8, 1.03], y: [-1.076, -0.726], slope: 0.8856 }, // stair (3.25 at its top end)
    { u: [-6.45, -1.4], v: [-1.44, -1.11], y: [-1, 3], mode: 'sight' }, { u: [-0.03, 0.76], v: [-1.38, -1.33], y: [-1, 2.9], mode: 'sight' }, // fence, and its pickets under the deck
    { u: [-6.45, 1.45], v: [-1.44, -1.11], y: [-1, 3.8], mode: 'body' }, // (with the bars under the deck on that side)
    { u: [-1.4, -1.1], v: [-1.44, -1.13], y: [-1, 5.68] }, { u: [1.14, 1.45], v: [-1.41, -1.11], y: [-1, 5.68] }, // posts
    { u: [-1.43, -1.12], v: [1.1, 1.4], y: [-1, 5.68] }, { u: [1.12, 1.43], v: [1.11, 1.42], y: [-1, 5.68] },
    { u: [1.21, 1.36], v: [-1.2, 1.2], y: [3.25, 4.17], mode: 'body' }, { u: [1.21, 1.36], v: [-1.2, 1.2], y: [4.01, 4.17], mode: 'sight' }, // rail, +u
    { u: [-1.2, 1.2], v: [1.16, 1.32], y: [3.25, 4.06], mode: 'body' }, { u: [-1.2, 1.2], v: [1.16, 1.32], y: [3.8, 4.06], mode: 'sight' }, // rail, +v
    { u: [-1.2, 1.2], v: [-1.35, -1.2], y: [3.25, 4], mode: 'body' }, { u: [-1.2, 1.2], v: [-1.35, -1.2], y: [3.85, 4], mode: 'sight' }, // rail, -v
    { u: [1.21, 1.37], v: [-1.2, 1.2], y: [0.27, 2.7], mode: 'body' }, // bars under the deck, +u
    { u: [-1.34, -1.19], v: [-1.19, 1.18], y: [0.67, 0.93] }, // a bar under the deck, stair side
    { u: [-1.19, 1.19], v: [1.16, 1.32], y: [1.91, 2.18] }, // the bar over the way in under the deck, +v
    { u: [-1.4, -1.17], v: [1.42, 2.2], y: [-1, 2], mode: 'body' }, { u: [1.16, 1.39], v: [1.42, 2.2], y: [-1, 2], mode: 'body' }, // the struts leaning on the +v posts
    { u: [-1.75, 0], v: [-1.49, 1.48], y: [5.55, 5.69], slope: 0.61, mode: 'sight' }, { u: [0, 1.8], v: [-1.49, 1.48], y: [6.62, 6.76], slope: -0.61, mode: 'sight' }, // roof
  ],
  route: { foot: [-6, 0.12], bottom: [-5, 0.12], top: [-0.9, 0.12] },
  watch: [-0.2, 0.78],
};
export const TOWERS = [[26, 44], [30, -4], [17, -50]].map(([x, z]) => ({ x, z, base: terrainHeight(x, z), yaw: Math.atan2(-x, -z) })); // yaw: looking at the fort
for (const t of TOWERS) { t.c = Math.cos(t.yaw + TOWER.turn); t.s = Math.sin(t.yaw + TOWER.turn); } // the frame: world = (x, base, z) + (c u + s v, y, c v - s u)
for (const t of TOWERS) {
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const d = Math.hypot(LO + i * WORLD.step - t.x, LO + j * WORLD.step - t.z); if (d > TOWER.flat + TOWER.blend) continue;
    const u = Math.min(1, Math.max(0, (d - TOWER.flat) / TOWER.blend)), w = 1 - u * u * (3 - 2 * u);
    grid[j * N + i] += (t.base - grid[j * N + i]) * w;
  }
}
// ---------- the fortress round the outpost (Poly Haven's Modular Fort 01 and Large Castle Door, CC0; the models are made by the engine's tools/import-fortress.py) ----------
// A wall closes a 24 m square round the hall: its gate in the south side, in line with the hall's doorway; the north-east corner tower left out, a breach about 3 m across.
// w, e, n, s: the outer faces' lines (the square is 0.81 m west of the pad's middle, so that the gate's opening, 1.165 to 3.250 m along its piece, is at x 0.36 to 2.44 round
// the doorway's 1.4); corner, long, short: the pieces' lengths along the wall (the kit's at its scale 0.5954, which closes the 24 m exactly); depth: the walls' thickness. The
// pieces stand `sink` m into the ground, and the ground is level (the pad's 0) within `flat` m of their outer faces and back to the hillside over `blend` m more, as under the
// towers: the shell's body boxes for the walls need ground that is exactly 0.
export const FORT = { w: -12.81, e: 11.19, n: -12, s: 12, corner: 3.1765, long: 8.8238, short: 4.4119, depth: 1.5183, gate: [1.165, 3.25], sink: 0.2, flat: 1, blend: 4 };
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const x = LO + i * WORLD.step, z = LO + j * WORLD.step;
  const d = Math.hypot(Math.max(FORT.w - FORT.flat - x, 0, x - FORT.e - FORT.flat), Math.max(FORT.n - FORT.flat - z, 0, z - FORT.s - FORT.flat)); if (d > FORT.blend) continue;
  const u = d / FORT.blend, w = 1 - u * u * (3 - 2 * u);
  grid[j * N + i] += (0 - grid[j * N + i]) * w;
}
// The pieces (assets/models/game/fortress/<piece>.glb), each where its start (its outer face, on its foot) stands and how it is turned: a piece runs along its own +z with its
// battered outer face on its x 0, and `yaw` (about y, as three.js turns it) lays it along a side with its outer face on that side's line. The door's two leaves are hinged just
// inside the gate's opening and stand open into the yard: one wide, one ajar, clear of the one whole cell of the 1 m movement grid through the gate (x 1 to 2).
export const WALLS = [];
{
  const { w, e, n, s, corner: c } = FORT, y = -FORT.sink, length = { wall_long: FORT.long, wall_short: FORT.short, wall_gate: FORT.short };
  const run = (pieces, yaw, [x, z], [dx, dz]) => { let t = 0; for (const piece of pieces) { WALLS.push({ piece, x: x + dx * t, z: z + dz * t, y, yaw }); t += length[piece]; } };
  run(['wall_long', 'wall_long'], 0, [w, n + c], [0, 1]); // west, running south
  run(['wall_long', 'wall_gate', 'wall_short'], Math.PI / 2, [w + c, s], [1, 0]); // south, running east
  run(['wall_long', 'wall_long'], Math.PI, [e, s - c], [0, -1]); // east, running north
  run(['wall_long', 'wall_long'], -Math.PI / 2, [e - c, n], [-1, 0]); // north, running west from the breach
  for (const [x, z, yaw] of [[w, n, 0], [w, s, Math.PI / 2], [e, s, Math.PI]]) WALLS.push({ piece: 'wall_corner', x, z, y, yaw }); // the north-west, south-west and south-east towers
  const gate = WALLS.find((p) => p.piece === 'wall_gate'), inside = s - FORT.depth - 0.05;
  WALLS.push({ piece: 'door_leaf_left', x: gate.x + FORT.gate[0] + 0.02, z: inside, y: 0, yaw: 95 * Math.PI / 180 }); // shuts along +x: open wide
  WALLS.push({ piece: 'door_leaf_right', x: gate.x + FORT.gate[1] - 0.02, z: inside, y: 0, yaw: -70 * Math.PI / 180 }); // shuts along -x: ajar
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

// ---------- the fort: the shell of the scan (src/shell-data.js, GENERATED by tools/prep-shell.mjs from assets/world/outpost.glb) ----------
// The model is a ruined stone house: a front wall with a stepped gable, a doorway and windows, east and west walls with windows, a flat roof deck with a tower and a
// chimney, and a back wall with a window in its north-east corner. Two views of it, which is why the boxes have a mode (see sim.js):
//   'sight'  about 1,400 thin boxes that follow the scan (rays only): what arrows, zombies' eyes and the binoculars meet, window slots and doorway included
//   'body'   whole cells of the 1 m movement grid, solid where the scan has a wall, with the doorway cell left open
// The body boxes carry skin 'outpost': main.js hides them once the scanned model is drawn, and they stay visible as grey blocks if the model file is missing.
const boxes = [];
for (const [x0, x1, z0, z1, y0, y1] of SIGHT_BOXES) boxes.push({ x0, x1, z0, z1, y0, y1, tag: 'rock', mode: 'sight' });
for (const [x0, x1, z0, z1, y1] of BODY_BOXES) boxes.push({ x0, x1, z0, z1, y0: 0, y1, tag: 'rock', mode: 'body', skin: 'outpost' });
boxes.push({ x0: 4.5, x1: 5.5, z0: 8, z1: 9, y0: 0, y1: 3, tag: 'metal' }); // the bell post on the pad in front of the door

// ---------- anchors: where things start (tuned against the reachable ground, see test/sim.test.mjs) ----------
// The player starts in the low south-west valley (about 11 m below the pad) and climbs north-east to the fort. Three scouts hold vantage points
// over the basin: the south-east plateau (25 m up), the east rim over the pad and the north ridge. Each stands on the deck of its tower (TOWERS above).
const face = (x, z) => Math.atan2(-x, -z); // yaw that looks at the fort from (x, z)
const START = { x: -43, z: 31, yaw: face(-43, 31) };
const BIKE = { x: -40, z: 33 };
// The armored zombie (sim.js TUNING.roles.armored) paces the slope in front of the gate, the way up from the bike to the battery: from A (-5.5, 21.5), where he stands looking
// down the valley toward the bike, 10.2 m to B (4.5, 19.5), 8 m before the gate, where he stands watching the gate, and back; between them his back is to the valley half the time.
// Both stops are in a fold of the slope that hides him from the start (not from the bike), clear of trees and rocks, and 6 to 9 m from the other patrols' points.
const toward = ([x, z], [tx, tz]) => Math.atan2(tx - x, tz - z); // the yaw that looks from one place to another
const STOP_A = [-5.5, 21.5], STOP_B = [4.5, 19.5], GATE = [1.4, 12]; // (the gate's middle: FORT, x 0.36 to 2.44 at z 12)
const ARMORED = { role: 'armored', x: STOP_A[0], z: STOP_A[1], yaw: toward(STOP_A, [BIKE.x, BIKE.z]), patrol: [STOP_A, STOP_B], face: [toward(STOP_A, [BIKE.x, BIKE.z]), toward(STOP_B, GATE)] };
const SPAWNS = [
  ...TOWERS.map((t) => { const [u, v] = TOWER.watch; return { role: 'scout', x: t.x + t.c * u + t.s * v, z: t.z - t.s * u + t.c * v, y: t.base + TOWER.deck, yaw: t.yaw }; }), // south-east plateau, east rim over the pad, north ridge
  { role: 'hunter', x: -25, z: 16, yaw: 0, patrol: [[-25, 16], [-14, 22], [-16, 6], [-31, 17]] },   // the valley, first contact
  { role: 'hunter', x: -10, z: 13.5, yaw: 0, patrol: [[-10, 13.5], [-16, 6], [-14, 0], [-14, 13]] }, // west of the fort (outside its wall)
  { role: 'hunter', x: 13, z: 12, yaw: 0, patrol: [[13, 12], [8, 14], [4, 13.5], [13.5, 6]] },      // at the foot of the escarpment, round the south-east tower
  { role: 'hunter', x: -12, z: -14, yaw: 0, patrol: [[-12, -14], [-4, -18], [4, -14], [-8, -14]] }, // behind the fort (outside its wall)
  { role: 'hunter', x: 12, z: -12, yaw: 0, patrol: [[12, -12], [14, -6], [8, -16], [14, -18]] },    // north-east basin
  { role: 'sleeper', x: -4, z: 3, yaw: 0 },               // inside the fort
  { role: 'sleeper', x: -1, z: -3, yaw: 0 },
  { role: 'sleeper', x: 3, z: 2, yaw: 0 },
  { role: 'sleeper', x: 2, z: -3, yaw: 0 },
  { role: 'screamer', x: -1, z: 9, yaw: 0, patrol: [[-1, 9], [-6, 8.5], [6.5, 9.5], [8.5, 8]] },     // guards the door, in the yard behind the gate
  ARMORED,
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
  wind: { speed: 5.5, gust: 4.5, swing: 0.9 }, // m/s: swells between ~3.6 and 5.5, gusts to 10; the heading is set per run, and each speed and heading is held a few seconds (see sim.windAt)
  bell: { x: 5, y: 3.2, z: 8.5 },
  // Waypoints zombies re-draw their patrols from after a search, so the layout reshuffles.
  patrol: [[-10, 13.5], [10, 13.5], [-14, 0], [14, -4], [0, -14], [-12, -14], [12, -12], [0, 14], [-16, 6], [8, -8]],
  spawns: SPAWNS,
  walls: WALLS, // drawn only (the shell has their solid parts): the fortress round the outpost, see FORT
  tower: TOWER, // the lookout towers: their solid parts and the stair zombies climb by, and where each stands (TOWER and TOWERS above)
  towers: TOWERS,
};
LEVEL.props = scatter(11, [[START.x, START.z, 6], [BIKE.x, BIKE.z, 4], ...TOWERS.map((t) => [t.x, t.z, TOWER.flat + 1]), ...SPAWNS.flatMap((s) => [[s.x, s.z, 3], ...(s.patrol || []).map(([x, z]) => [x, z, 2.5])]), ...LEVEL.patrol.map(([x, z]) => [x, z, 2.5])]);
// The scatter knows the towers only as circles round their middles: a boulder or trunk it put in the way of a tower's stair or palisade (one rock, on the east tower's stair)
// is moved the least way clear of the part it is in, as a square of its radius and a cell more (the rules block the whole 1 m cells a prop touches), so the stair can be
// climbed. The others keep their places, and every prop its place in the list.
for (const p of LEVEL.props) for (const t of TOWERS) for (const q of TOWER.parts) {
  if (q.mode === 'sight') continue;
  const dx = p.x - t.x, dz = p.z - t.z, u = t.c * dx - t.s * dz, v = t.s * dx + t.c * dz, r = p.r + 1;
  const ways = [[q.u[0] - r - u, 0], [q.u[1] + r - u, 0], [0, q.v[0] - r - v], [0, q.v[1] + r - v]]; // to clear it along -u, +u, -v, +v
  if (ways[0][0] >= 0 || ways[1][0] <= 0 || ways[2][1] >= 0 || ways[3][1] <= 0) continue; // clear of it already
  const [mu, mv] = ways.reduce((a, b) => (Math.abs(b[0] + b[1]) < Math.abs(a[0] + a[1]) ? b : a));
  p.x += t.c * mu + t.s * mv; p.z += t.c * mv - t.s * mu;
}
