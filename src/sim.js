// sim.js: all game logic. No Three.js, no Math.random, Date.now or performance.now.
// Same seed + same inputs => same run. main.js owns time (fixed 60 Hz steps) and only reads state.
//
// Two views of the level, kept apart on purpose:
//   - a baked 1 m heightfield for movement and path finding (buildLevel, once)
//   - the raw boxes for line of sight, noise occlusion and arrows
// Constraint: no walkable surface above another (see level.js); buildLevel() throws on a floating box.

export const TUNING = {
  dt: 1 / 60,
  gravity: 9.81,
  maxRange: 60, // metres that a loudness of 1.0 carries
  player: { walk: 2.2, run: 4.2, crouch: 1.2, drawMove: 0.5, radius: 0.35, step: 0.45, hp: 100, hit: 25, shove: 1.6, stun: 0.6, eyeStand: 1.6, eyeCrouch: 1.0, slope: 1.2, knife: 1.8, knifeCone: 0.5, knifeCd: 0.6 }, // knifeCone: cos 60 degrees either side of where the player faces
  bow: { basic: 10, lure: 2, drawTime: 1.2, minDraw: 0.35, speed: 65, swaySecs: 6, spread: 0.004, moveSpread: 0.012, swayGrow: 0.006, reach: 2.2 },
  loud: { stepCrouch: 0.05, stepWalk: 0.15, stepRun: 0.35, release: 0.25, soft: 0.35, hard: 0.6, metal: 0.8, kill: 0.1, wound: 0.9, scream: 1, call: 0.8, whistle: 0.4, rummage: 0.08, landPerM: 0.12 },
  bell: { period: 8, ring: 1.6, mask: 0.4 },
  wind: { drift: 0.45 }, // arrow acceleration per m/s of wind: 6 m/s moves a full-draw arrow ~0.5 m sideways at 40 m and ~1.1 m at 60 m
  aware: { suspicious: 0.3, alert: 0.8, decay: 0.05, sightGain: 1.1, hearGain: 1.5, close: 3, occlude: 0.5, expose: { crouch: 0.5, still: 0.7, walk: 1, run: 1.5 } },
  zombie: { walk: 1.1, run: 3.4, pack: 12, scoutReport: 3, radius: 0.35, attackRange: 1.3, attackCd: 1, hp: 2, loseTime: 3, search: [30, 90], searchRadius: 20, investigate: [15, 30], caution: 30, cautionSens: 1.5, down: 0.6, wait: [2, 4], suspiciousWait: 3.5 },
  roles: {
    hunter: { sight: 20, fov: 100, hear: 1, patrol: true },
    // scout: stands on a vantage point, sees far (and down from up there: vert is how far above or below itself it can see, 4 m for the rest)
    // and reports where the player is to every zombie that can hear the call; see alertEnter and the alert case of stepZombie
    // gain: how fast its sight fills the awareness meter, against 1 for the others (it sees far, but it takes a moment to be sure)
    scout: { sight: 40, fov: 80, hear: 1.6, patrol: false, vert: 40, gain: 0.6 },
    sleeper: { sight: 0, fov: 0, hear: 0.6, patrol: true, wake: 0.5 },
    screamer: { sight: 22, fov: 110, hear: 1, patrol: true },
  },
};

// Hit spheres on a standing zombie: [name, height, radius]. Dormant (slumped) zombies are 0.6 scale.
export const PARTS = [['head', 1.68, 0.22], ['chest', 1.2, 0.34], ['hips', 0.7, 0.32]];
export const hitScale = (z) => (z.state === 'dormant' ? 0.6 : 1);

const hyp = Math.hypot;

export function rand(S) { // mulberry32, state kept in S.rng
  S.rng.a = (S.rng.a + 0x6d2b79f5) | 0;
  let t = S.rng.a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (S, [lo, hi]) => lo + rand(S) * (hi - lo);

// ---------- level ----------

// The level has three layers: smooth terrain (bilinear between 1 m corners), piecewise-constant obstacle
// tops per cell (boxes, tree trunks, boulders), and overhead boxes that only block sight and arrows.
// The walkable surface is the higher of terrain and obstacle. Boxes must stand on ground that is exactly 0.

// The ONE walkability rule between two neighbouring cells i -> j, `dist` metres apart (1, or sqrt 2 on a diagonal), used by the seal flood fill, the
// A* edges and the line-of-travel check. Bare ground (no box, prop or sealed cell at either end) is walkable up to TUNING.player.slope metres of
// rise per metre, up or down. Anything else (a box top, a boulder, a trunk) is a step: at most player.step up and `down` down.
const walkEdge = (h, obs, i, j, dist, down) => {
  const dh = h[j] - h[i];
  return obs[i] === -Infinity && obs[j] === -Infinity ? Math.abs(dh) <= TUNING.player.slope * dist : dh <= TUNING.player.step && dh >= -down;
};
export function buildLevel(def) {
  const { x0, z0, w, d } = def.bounds, T = def.terrain || (() => 0), W = w + 1;
  const ter = new Float32Array(W * (d + 1));
  for (let iz = 0; iz <= d; iz++) for (let ix = 0; ix <= w; ix++) ter[iz * W + ix] = T(x0 + ix, z0 + iz);
  const obs = new Float32Array(w * d).fill(-Infinity), obsTag = new Array(w * d).fill(null); // -Infinity = nothing there (0 would lift ground below the pad)
  for (const b of def.boxes) {
    if (!(b.y0 === 0 || b.y0 >= 2.5)) throw new Error('box floats between 0 and 2.5 m: ' + JSON.stringify(b));
    if (b.y0 > 0) continue; // overhead: not walkable
    const ix0 = Math.max(0, Math.floor(b.x0 - x0)), ix1 = Math.min(w, Math.ceil(b.x1 - x0));
    const iz0 = Math.max(0, Math.floor(b.z0 - z0)), iz1 = Math.min(d, Math.ceil(b.z1 - z0));
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      if (ter[iz * W + ix] !== 0) throw new Error('box on sloped ground: ' + JSON.stringify(b));
    }
    for (let iz = iz0; iz < iz1; iz++) for (let ix = ix0; ix < ix1; ix++) {
      const i = iz * w + ix;
      if (b.y1 > obs[i]) { obs[i] = b.y1; obsTag[i] = b.tag; }
    }
  }
  const props = (def.props || []).map((p) => { const base = T(p.x, p.z); return { ...p, y0: base, y1: base + p.h }; });
  for (const p of props) { // round obstacles: block every cell the trunk or boulder touches
    const ix0 = Math.max(0, Math.floor(p.x - p.r - x0)), ix1 = Math.min(w - 1, Math.floor(p.x + p.r - x0));
    const iz0 = Math.max(0, Math.floor(p.z - p.r - z0)), iz1 = Math.min(d - 1, Math.floor(p.z + p.r - z0));
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const i = iz * w + ix;
      const top = Math.max(p.y1, p.y0 + 2.5); // a boulder is never a step: on a slope its top could sit within `step` of the uphill ground, and the planner and the body would disagree
      if (top > obs[i]) { obs[i] = top; obsTag[i] = p.kind === 'tree' ? 'wood' : 'rock'; }
    }
  }
  const h = new Float32Array(w * d); // walkable surface at cell centres, for path finding
  for (let iz = 0; iz < d; iz++) for (let ix = 0; ix < w; ix++) {
    const i = iz * w + ix, c = (ter[iz * W + ix] + ter[iz * W + ix + 1] + ter[(iz + 1) * W + ix] + ter[(iz + 1) * W + ix + 1]) / 4;
    h[i] = Math.max(c, obs[i]);
  }
  const limit = def.limit || 1e9;
  let minY = 0; for (const t of ter) if (t < minY) minY = t;
  let sealed = 0;
  if (def.seal) { // opt in for rugged levels: bare ground that nobody can walk onto from the start becomes solid, so there are no cliffs only the
    // player climbs, no dead-end 'closest reachable cell' for zombies and no one-way pits. The edge rule is walkEdge (symmetric here: down = step).
    // A bare cell is also unwalkable when its own corners, 1 m apart, differ by more than `slope`: cell centres average a sharp rise away (the
    // centres are 0.3 m apart across such a cell), so the centre rule alone lets a cliff face through and this corner test is what really seals it.
    const reach = new Uint8Array(w * d), stack = [], step = TUNING.player.step, slope = TUNING.player.slope;
    const steep = (i) => { const ix = i % w, iz = (i / w) | 0, a = ter[iz * W + ix], b = ter[iz * W + ix + 1], c = ter[(iz + 1) * W + ix], e = ter[(iz + 1) * W + ix + 1]; return Math.max(Math.abs(a - b), Math.abs(c - e), Math.abs(a - c), Math.abs(b - e)) > slope; };
    const s0 = Math.floor(def.start.z - z0) * w + Math.floor(def.start.x - x0);
    reach[s0] = 1; stack.push(s0);
    while (stack.length) {
      const i = stack.pop(), ix = i % w, iz = (i / w) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const jx = ix + dx, jz = iz + dz;
        if ((!dx && !dz) || jx < 0 || jz < 0 || jx >= w || jz >= d) continue;
        const j = jz * w + jx;
        if (reach[j] || Math.abs(x0 + jx + 0.5) >= limit || Math.abs(z0 + jz + 0.5) >= limit || !walkEdge(h, obs, i, j, dx && dz ? Math.SQRT2 : 1, step) || (obs[j] === -Infinity && steep(j))) continue;
        reach[j] = 1; stack.push(j);
      }
    }
    for (let i = 0; i < w * d; i++) if (!reach[i] && obs[i] === -Infinity) { obs[i] = Infinity; obsTag[i] = 'rock'; h[i] = Infinity; sealed++; } // boxes and props keep their own height
  }
  return { boxes: def.boxes, props, x0, z0, w, d, ter, obs, obsTag, h, patrol: def.patrol || [], tag: def.terrainTag || (() => 'dirt'), limit, minY, sealed };
}

const cellIndex = (L, x, z) => {
  const ix = Math.floor(x - L.x0), iz = Math.floor(z - L.z0);
  return ix < 0 || iz < 0 || ix >= L.w || iz >= L.d ? -1 : iz * L.w + ix;
};
export function terrainAt(L, x, z) {
  const fx = x - L.x0, fz = z - L.z0, ix = Math.floor(fx), iz = Math.floor(fz);
  if (ix < 0 || iz < 0 || ix >= L.w || iz >= L.d) return Infinity;
  const u = fx - ix, v = fz - iz, W = L.w + 1, i = iz * W + ix, t = L.ter;
  return (t[i] * (1 - u) + t[i + 1] * u) * (1 - v) + (t[i + W] * (1 - u) + t[i + W + 1] * u) * v;
}
export function heightAt(L, x, z) {
  const i = cellIndex(L, x, z);
  return i < 0 ? Infinity : Math.max(terrainAt(L, x, z), L.obs[i]);
}
// Material under a point: a box or prop top if one is there, else the ground type.
export function surfaceTag(L, x, z) {
  const i = cellIndex(L, x, z);
  return i >= 0 && L.obs[i] > terrainAt(L, x, z) + 0.01 ? L.obsTag[i] : L.tag(x, z);
}
// Open ground: inside the play limit and not blocked by an obstacle.
export const openAt = (L, x, z) => { const i = cellIndex(L, x, z); return i >= 0 && L.obs[i] === -Infinity && Math.abs(x) < L.limit && Math.abs(z) < L.limit; };

// ---------- geometry ----------

// First box hit by the segment a->b, or null. t is the fraction along the segment.
export function rayBoxes(L, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  let best = null, bestT = 1;
  for (const b of L.boxes) {
    let t0 = 0, t1 = bestT, a, c, tmp;
    if (dx !== 0) { a = (b.x0 - ax) / dx; c = (b.x1 - ax) / dx; if (a > c) { tmp = a; a = c; c = tmp; } if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 > t1) continue; }
    else if (ax < b.x0 || ax > b.x1) continue;
    if (dy !== 0) { a = (b.y0 - ay) / dy; c = (b.y1 - ay) / dy; if (a > c) { tmp = a; a = c; c = tmp; } if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 > t1) continue; }
    else if (ay < b.y0 || ay > b.y1) continue;
    if (dz !== 0) { a = (b.z0 - az) / dz; c = (b.z1 - az) / dz; if (a > c) { tmp = a; a = c; c = tmp; } if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 > t1) continue; }
    else if (az < b.z0 || az > b.z1) continue;
    best = b; bestT = t0;
  }
  return best ? { t: bestT, box: best, tag: best.tag } : null;
}
// Vertical cylinder (tree trunk, boulder) vs segment: fraction of first contact, or -1.
function segCylinder(ax, ay, az, bx, by, bz, cx, cz, r, y0, y1) {
  const dx = bx - ax, dz = bz - az, fx = ax - cx, fz = az - cz, a = dx * dx + dz * dz;
  let t0 = 0, t1 = 1;
  if (a < 1e-12) { if (fx * fx + fz * fz > r * r) return -1; }
  else {
    const b = 2 * (fx * dx + fz * dz), c = fx * fx + fz * fz - r * r, disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const s = Math.sqrt(disc);
    t0 = Math.max(0, (-b - s) / (2 * a)); t1 = Math.min(1, (-b + s) / (2 * a));
    if (t0 > t1) return -1;
  }
  const dy = by - ay;
  if (dy !== 0) {
    let u0 = (y0 - ay) / dy, u1 = (y1 - ay) / dy;
    if (u0 > u1) { const t = u0; u0 = u1; u1 = t; }
    t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
    if (t0 > t1) return -1;
  } else if (ay < y0 || ay > y1) return -1;
  return t0;
}

// First crossing of the ground along a segment, sampled every 0.5 m. Crossings within `skip` metres of
// either end are ignored: noises and eyes sit right on the surface.
function rayTerrain(L, ax, ay, az, bx, by, bz, skip) {
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  if (len < 1e-9) return null;
  const n = Math.max(1, Math.ceil(len / 0.5));
  let prevT = 0, prevAbove = ay - terrainAt(L, ax, az);
  for (let i = 1; i <= n; i++) {
    const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t, above = ay + (by - ay) * t - terrainAt(L, x, z);
    if (above <= 0 && prevAbove > 0) {
      const tc = prevT + (t - prevT) * (prevAbove / (prevAbove - above));
      if (tc * len >= skip && (1 - tc) * len >= skip) return { t: tc, tag: L.tag(ax + (bx - ax) * tc, az + (bz - az) * tc), kind: 'ground' };
    }
    prevT = t; prevAbove = above;
  }
  return null;
}

// The nearest thing a segment hits: a box, a trunk or boulder, or the ground.
export function rayWorld(L, ax, ay, az, bx, by, bz, skip = 0) {
  let best = rayBoxes(L, ax, ay, az, bx, by, bz);
  if (best) best.kind = 'box';
  for (const p of L.props) {
    const t = segCylinder(ax, ay, az, bx, by, bz, p.x, p.z, p.r, p.y0, p.y1);
    if (t >= 0 && (!best || t < best.t)) best = { t, tag: p.kind === 'tree' ? 'wood' : 'rock', kind: 'prop' };
  }
  const g = rayTerrain(L, ax, ay, az, bx, by, bz, skip);
  return g && (!best || g.t < best.t) ? g : best;
}
export const hasLOS = (L, ax, ay, az, bx, by, bz) => !rayWorld(L, ax, ay, az, bx, by, bz, 1);

// Fraction along segment a->b where it first enters the sphere, or -1.
export function segSphere(ax, ay, az, bx, by, bz, cx, cy, cz, r) {
  const dx = bx - ax, dy = by - ay, dz = bz - az, fx = ax - cx, fy = ay - cy, fz = az - cz;
  const a = dx * dx + dy * dy + dz * dz, b = 2 * (fx * dx + fy * dy + fz * dz), c = fx * fx + fy * fy + fz * fz - r * r;
  if (c <= 0) return 0;
  const disc = b * b - 4 * a * c;
  if (disc < 0 || a === 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

// ---------- movement and path finding (heightfield only) ----------

// The centre follows the terrain; the four corners only look for obstacles (boxes, props, sealed ground, the edge of the map). Ground that is
// merely steep cannot stop the body: a corner test against the terrain made slopes above ~0.6 impassable by a few millimetres even where the
// planner routed over them. What is too steep is decided once, by the sealing in buildLevel.
const obsAt = (L, x, z) => { const i = cellIndex(L, x, z); return i < 0 ? Infinity : L.obs[i]; };
function canStand(L, x, z, y, r, step) {
  return heightAt(L, x, z) <= y + step && obsAt(L, x - r, z - r) <= y + step && obsAt(L, x + r, z - r) <= y + step &&
    obsAt(L, x - r, z + r) <= y + step && obsAt(L, x + r, z + r) <= y + step;
}
function moveBy(L, e, dx, dz, r, step, n = 1) {
  for (let i = 0; i < n; i++) {
    if (dx && canStand(L, e.x + dx / n, e.z, e.y, r, step)) e.x += dx / n;
    if (dz && canStand(L, e.x, e.z + dz / n, e.y, r, step)) e.z += dz / n;
  }
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [-1, 1, 1.4142], [1, -1, 1.4142], [-1, -1, 1.4142]];
const edgeOK = (L, i, j, down, dist = 1) => walkEdge(L.h, L.obs, i, j, dist, down);

function lineOK(L, ax, az, bx, bz, down) { // the walkEdge rule sampled along a straight line, plus a sideways probe for obstacles only (the body ignores terrain at its corners)
  const len = hyp(bx - ax, bz - az), n = Math.max(1, Math.ceil(len / 0.4)), run = len / n, step = TUNING.player.step;
  const px = len ? -(bz - az) / len * 0.4 : 0, pz = len ? (bx - ax) / len * 0.4 : 0;
  let prev = heightAt(L, ax, az), prevBare = obsAt(L, ax, az) === -Infinity;
  for (let s = 1; s <= n; s++) {
    const t = s / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t, h = heightAt(L, x, z), dh = h - prev, bare = obsAt(L, x, z) === -Infinity;
    if (!(bare && prevBare ? Math.abs(dh) <= TUNING.player.slope * run : dh <= step && dh >= -down)) return false;
    if (obsAt(L, x + px, z + pz) > h + step || obsAt(L, x - px, z - pz) > h + step) return false;
    prev = h; prevBare = bare;
  }
  return true;
}
function smooth(L, ax, az, pts, down) {
  if (pts.length < 2) return pts;
  const out = [];
  let cx = ax, cz = az, i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !lineOK(L, cx, cz, pts[j][0], pts[j][1], down)) j--;
    out.push(pts[j]);
    cx = pts[j][0]; cz = pts[j][1]; i = j + 1;
  }
  return out;
}

// A* over 1 m cells. Steps up <= player step, drops <= down. If the goal is unreachable the path
// leads to the closest reachable cell. Returns waypoints [[x, z], ...] excluding the start, or null.
export function findPath(L, ax, az, bx, bz, down = TUNING.zombie.down) {
  const { w, d } = L, si = cellIndex(L, ax, az), gi = cellIndex(L, bx, bz);
  if (si < 0 || gi < 0) return null;
  const gx = gi % w, gz = (gi / w) | 0, N = w * d;
  const g = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const hf = (i) => { const dx = Math.abs((i % w) - gx), dz = Math.abs(((i / w) | 0) - gz); return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz); };
  const heap = new Heap();
  g[si] = 0; heap.push(hf(si), si);
  let best = si, bestH = hf(si);
  while (heap.size) {
    const i = heap.pop();
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === gi) { best = gi; break; }
    const hv = hf(i);
    if (hv < bestH) { bestH = hv; best = i; }
    const x = i % w, z = (i / w) | 0;
    for (const [ox, oz, c] of NB) {
      const nx = x + ox, nz = z + oz;
      if (nx < 0 || nz < 0 || nx >= w || nz >= d) continue;
      const j = nz * w + nx;
      if (closed[j] || !edgeOK(L, i, j, down, c)) continue;
      if (ox && oz && !(edgeOK(L, i, z * w + nx, down) && edgeOK(L, i, nz * w + x, down))) continue;
      const ng = g[i] + c;
      if (ng < g[j]) { g[j] = ng; came[j] = i; heap.push(ng + hf(j), j); }
    }
  }
  const cells = [];
  for (let i = best; i !== -1 && i !== si; i = came[i]) cells.push(i);
  cells.reverse();
  const pts = cells.map((i) => [L.x0 + (i % w) + 0.5, L.z0 + ((i / w) | 0) + 0.5]);
  if (best === gi) { if (pts.length) pts[pts.length - 1] = [bx, bz]; else pts.push([bx, bz]); }
  return smooth(L, ax, az, pts, down);
}

// ---------- state ----------

// ---------- wind ----------
// The wind is a pure function of time and the run's seed (no RNG, so replays and tests are exact; each restart blows differently).
// A level opts in with def.wind = { speed, gust, swing, vary?, dir? }; without it the air is still.
//   dir: the way the air moves, in the same angle as yaw (x = sin dir, z = cos dir); it wanders by +-swing radians around a per-run heading (or `dir`).
//   speed: a slow swell between speed*(1-vary) and speed, plus gust bursts of up to `gust` m/s that are mostly absent.
const CALM = Object.freeze({ x: 0, z: 0, speed: 0, dir: 0, gust: 0 });
function windPhases(seed) { // four angles from the seed alone: an integer hash, never S.rng
  return [1, 2, 3, 4].map((n) => {
    let x = Math.imul((seed | 0) + n * 0x9e3779b1, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
    return ((x >>> 0) / 4294967296) * Math.PI * 2;
  });
}
export function windAt(S, t = S.t) {
  const W = S.windDef;
  if (!W) return CALM;
  const p = S.windPhase;
  const dir = (W.dir ?? p[0]) + (W.swing || 0) * (Math.sin(t * 0.021 + p[1]) + 0.5 * Math.sin(t * 0.057 + p[2]));
  const base = W.speed * (1 - (W.vary ?? 0.35) * (0.5 - 0.5 * Math.sin(t * 0.033 + p[3])));
  const g = Math.max(0, Math.sin(t * 0.31 + p[1] * 2) * Math.sin(t * 0.113 + p[2] * 3)), gust = g * g;
  const speed = base + (W.gust || 0) * gust;
  return { x: Math.sin(dir) * speed, z: Math.cos(dir) * speed, speed, dir, gust };
}

export function createState(def, seed = 1) {
  const level = buildLevel(def);
  const S = {
    t: 0, rng: { a: seed | 0 }, level, events: [], arrows: [], zombies: [], over: null, status: 'UNSEEN', threat: { dist: Infinity, count: 0 },
    wasAlert: false, entered: false, enter: def.enter || null, nextId: 1, bell: { ...def.bell, ring: false }, bike: def.bike,
    stats: { shots: 0, clean: 0, messy: 0, blown: 0, retrieved: 0, kills: 0, time: 0 },
    player: {
      x: def.start.x, z: def.start.z, y: 0, vy: 0, falling: false, fallFrom: 0, yaw: def.start.yaw || 0, crouch: false, run: false,
      moving: false, stride: 0, hp: TUNING.player.hp, kind: 'basic', quiver: { basic: TUNING.bow.basic, lure: TUNING.bow.lure },
      drawing: false, drawT: 0, stun: 0, knifeCd: 0,
    },
  };
  S.player.y = heightAt(level, S.player.x, S.player.z);
  S.windDef = def.wind || null; S.windPhase = windPhases(seed); S.wind = windAt(S);
  for (const s of def.spawns) {
    const rp = TUNING.roles[s.role];
    const z = {
      id: S.nextId++, kind: s.role, role: s.role, x: s.x, z: s.z, y: heightAt(level, s.x, s.z), yaw: s.yaw || 0,
      state: rp.wake ? 'dormant' : 'idle', meter: 0, sens: 1, hp: TUNING.zombie.hp, tagged: false, sees: false,
      post: { x: s.x, z: s.z, yaw: s.yaw || 0 }, patrol: s.patrol || [], pi: 0, wait: 0, path: null, pi2: 0, goal: null, repath: 0,
      point: null, arrived: false, searchC: null, leg: 0, lkp: null, stim: null, seenT: -99, lastStim: -99, heardT: -99, timer: 0, atk: 0, screamed: false, report: 0,
    };
    S.zombies.push(z);
  }
  return S;
}

// ---------- noise and awareness ----------

const eyeY = (P) => P.y + (P.crouch ? TUNING.player.eyeCrouch : TUNING.player.eyeStand);

// `target` (optional) is where listeners think the trouble is: an alarm points at the player, not at the
// shouter. `tag` is the surface for steps and impacts (the audio uses it).
export function emitNoise(S, x, y, z, loud, kind, src = 'world', by = -1, target = null, tag = null) {
  S.events.push({ type: 'noise', x, y, z, loud, range: loud * TUNING.maxRange, kind, src, tag, t: S.t });
  for (const zb of S.zombies) if (zb.state !== 'dead' && zb.id !== by) hear(S, zb, x, y, z, loud, src, target);
}
const playerNoise = (S, loud, kind, tag = null) => emitNoise(S, S.player.x, S.player.y + 1, S.player.z, loud, kind, 'player', -1, null, tag);

function hear(S, zb, x, y, z, loud, src, target) {
  const T = TUNING, rp = T.roles[zb.role], d = hyp(x - zb.x, z - zb.z), range = loud * T.maxRange * rp.hear;
  if (d >= range) return;
  let s = loud * (1 - d / range) * rp.hear * zb.sens;
  if (!hasLOS(S.level, x, y, z, zb.x, zb.y + 1.6, zb.z)) s *= T.aware.occlude;
  if (src === 'player' && S.bell.ring) s *= T.bell.mask;
  const gain = s * T.aware.hearGain;
  zb.heardT = S.t; zb.lastStim = S.t; zb.stim = target ? { x: target.x, z: target.z } : { x, z };
  zb.meter = Math.min(1, zb.meter + gain);
  if (zb.state === 'dormant') { if (gain >= rp.wake) wake(S, zb); return; }
  if (zb.state === 'suspicious') { zb.point = zb.stim; zb.arrived = false; zb.timer = 0; zb.leg = 0; }
  else if (zb.state === 'search') { zb.searchC = zb.stim; zb.point = zb.stim; zb.arrived = false; zb.wait = 0; zb.leg = 0; zb.timer = Math.max(zb.timer, T.zombie.investigate[0]); }
  else if (zb.state === 'alert' && !zb.sees) { zb.lkp = zb.stim; zb.seenT = Math.max(zb.seenT, S.t - T.zombie.loseTime * 0.5); }
}

// ---------- zombies ----------

function setState(S, z, to) {
  if (z.state === to) return;
  if (to === 'suspicious') z.leg = 0; // how long this investigation has been walking
  S.events.push({ type: 'state', id: z.id, from: z.state, to });
  z.state = to;
}
function pickPatrol(S) {
  const pool = S.level.patrol.slice(), out = [];
  for (let k = 0; k < 3 && pool.length; k++) out.push(pool.splice((rand(S) * pool.length) | 0, 1)[0]);
  return out;
}
function wake(S, z) {
  z.role = 'hunter'; z.patrol = pickPatrol(S); z.pi = 0; z.point = z.stim; z.arrived = false; z.timer = 0;
  setState(S, z, 'suspicious');
  S.events.push({ type: 'wake', id: z.id });
}
function alertEnter(S, z) {
  setState(S, z, 'alert');
  z.meter = 1; z.arrived = false; z.path = null; z.goal = null;
  if (!z.lkp) z.lkp = z.stim || { x: S.player.x, z: S.player.z };
  z.seenT = Math.max(z.seenT, S.t - 0.1);
  S.events.push({ type: 'alert', id: z.id, x: z.x, y: z.y + 1.6, z: z.z });
  if (z.role === 'scout') { z.report = TUNING.zombie.scoutReport; emitNoise(S, z.x, z.y + 1.6, z.z, TUNING.loud.call, 'call', 'zombie', z.id, z.lkp); }
  else if (z.kind === 'screamer' && !z.screamed) { z.screamed = true; emitNoise(S, z.x, z.y + 1.6, z.z, TUNING.loud.scream, 'scream', 'zombie', z.id, z.lkp); }
  else packPull(S, z);
}
// A hunter that finds the player pulls the hunters around it toward the same spot (suspicious, not alert).
function packPull(S, z) {
  for (const o of S.zombies) {
    if (o === z || o.state === 'dead' || o.state === 'dormant' || o.state === 'alert' || o.role === 'scout') continue;
    if (hyp(o.x - z.x, o.z - z.z) < TUNING.zombie.pack) { o.meter = Math.max(o.meter, 0.45); o.stim = z.lkp; o.lastStim = S.t; o.heardT = S.t; }
  }
}
// A zombie that hears a noise or loses the player searches the AREA, not the one spot: it picks points within `searchRadius` (20 m) of the centre, each time
// the best of 12 random open candidates by how far it is from where the OTHER investigating or searching zombies stand or are heading, so a crowd that
// heard the same noise fans out instead of piling up on the noise point. Only rand(S) is consumed, in a fixed order, so runs stay reproducible.
function pickSearchPoint(S, z, c, R) {
  const others = [];
  for (const o of S.zombies) if (o !== z && o.role !== 'scout' && (o.state === 'suspicious' || o.state === 'search')) { others.push([o.x, o.z]); if (o.point) others.push([o.point.x, o.point.z]); }
  let best = null, bestScore = -Infinity;
  for (let k = 0; k < 12; k++) {
    const a = rand(S) * Math.PI * 2, r = R * Math.sqrt(0.06 + 0.94 * rand(S)), x = c.x + Math.cos(a) * r, zz = c.z + Math.sin(a) * r; // from a quarter of R out to R
    if (!openAt(S.level, x, zz)) continue;
    let apart = 15; for (const [ox, oz] of others) apart = Math.min(apart, hyp(ox - x, oz - zz));
    const score = apart - 0.05 * hyp(x - z.x, zz - z.z); // far from the others, a little less far to walk
    if (score > bestScore) { bestScore = score; best = { x, z: zz }; }
  }
  return best;
}
// centre: what is searched around (default: where the player was last seen); arrived: already there (it came to investigate a noise), so it looks round
// briefly and moves on at once instead of waiting where the others are.
function searchEnter(S, z, centre = z.lkp, time = TUNING.zombie.search, arrived = false) {
  setState(S, z, 'search');
  z.searchC = centre || { x: z.x, z: z.z };
  z.timer = between(S, time); z.sens = TUNING.zombie.cautionSens;
  z.point = z.searchC; z.arrived = arrived; z.wait = arrived ? 0.4 + rand(S) * 0.8 : 0; z.leg = 0; z.path = null; z.goal = null;
  z.meter = Math.min(z.meter, TUNING.aware.alert - 0.1); // only a new stimulus re-alerts it
}
function cautionEnter(S, z) {
  setState(S, z, 'caution');
  z.timer = TUNING.zombie.caution; z.sens = TUNING.zombie.cautionSens;
  z.patrol = z.role === 'scout' ? [] : pickPatrol(S); z.pi = 0; z.wait = 0; z.path = null; z.goal = null; z.lkp = null;
  z.meter = Math.min(z.meter, TUNING.aware.suspicious - 0.05); // calm down, or it re-suspects the same spot at once
}
function idleEnter(S, z) {
  setState(S, z, 'idle');
  z.sens = 1; z.screamed = false; z.path = null; z.goal = null;
  z.meter = Math.min(z.meter, TUNING.aware.suspicious - 0.05);
}

const turn = (a, b, k) => { let d = b - a; d -= Math.PI * 2 * Math.round(d / (Math.PI * 2)); return a + d * Math.min(1, k); };

function steer(S, z, wx, wz, speed, dt) {
  const dx = wx - z.x, dz = wz - z.z, d = hyp(dx, dz);
  if (d < 1e-3) return;
  const ox = z.x, oz = z.z, R = TUNING.zombie.radius, step = TUNING.player.step;
  moveBy(S.level, z, (dx / d) * speed * dt, (dz / d) * speed * dt, R, step);
  // The planner routes through cell centres, 0.5 m from any obstacle cell, but the body (R = 0.35) can drift off that line and catch a corner of
  // a tree or wall: with almost no progress for 0.4 s, slide toward the middle of the current cell, which the planner knows is clear.
  z.jam = hyp(z.x - ox, z.z - oz) < speed * dt * 0.3 ? (z.jam || 0) + dt : 0;
  if (z.jam > 0.4) {
    const cx = Math.floor(z.x) + 0.5, cz = Math.floor(z.z) + 0.5, cd = hyp(cx - z.x, cz - z.z);
    if (cd > 0.05) moveBy(S.level, z, ((cx - z.x) / cd) * speed * dt, ((cz - z.z) / cd) * speed * dt, R, step);
    if (z.jam > 0.9) z.jam = 0;
  }
  z.y = heightAt(S.level, z.x, z.z);
  z.yaw = turn(z.yaw, Math.atan2(dx, dz), 10 * dt);
}
function goTo(S, z, tx, tz, speed, dt) {
  if ((!z.goal || hyp(z.goal.x - tx, z.goal.z - tz) > 1.5) && z.repath <= 0) {
    z.path = findPath(S.level, z.x, z.z, tx, tz); z.pi2 = 0; z.goal = { x: tx, z: tz }; z.repath = 0.5;
  }
  let wx = tx, wz = tz;
  if (z.path && z.pi2 < z.path.length) {
    [wx, wz] = z.path[z.pi2];
    if (hyp(wx - z.x, wz - z.z) < 0.45 && ++z.pi2 < z.path.length) [wx, wz] = z.path[z.pi2];
  }
  steer(S, z, wx, wz, speed, dt);
}
const arrivedAt = (z, x, zz, r) => hyp(x - z.x, zz - z.z) < r;

function patrol(S, z, dt) {
  const Z = TUNING.zombie;
  if (z.role === 'scout') {
    if (hyp(z.post.x - z.x, z.post.z - z.z) > 1) goTo(S, z, z.post.x, z.post.z, Z.walk, dt);
    else z.yaw = z.post.yaw + Math.sin(S.t * 0.5 + z.id) * 1.0;
    return;
  }
  if (!z.patrol.length) return;
  const [px, pz] = z.patrol[z.pi % z.patrol.length];
  if (z.wait > 0) { z.wait -= dt; z.yaw += 0.8 * dt; return; }
  goTo(S, z, px, pz, Z.walk, dt);
  if (arrivedAt(z, px, pz, 1)) { z.pi++; z.wait = between(S, Z.wait); z.path = null; z.goal = null; }
}

function attack(S, z) {
  const P = S.player, dx = P.x - z.x, dz = P.z - z.z, d = hyp(dx, dz) || 1;
  z.atk = TUNING.zombie.attackCd;
  P.hp -= TUNING.player.hit;
  P.stun = TUNING.player.stun; // grabbed: you stumble, and the others catch up
  moveBy(S.level, P, (dx / d) * TUNING.player.shove, (dz / d) * TUNING.player.shove, TUNING.player.radius, TUNING.player.step, 8);
  S.events.push({ type: 'hit', id: z.id });
}

function stepZombie(S, z, dt) {
  const T = TUNING, Z = T.zombie, A = T.aware, P = S.player, rp = T.roles[z.role];
  z.repath -= dt; z.atk -= dt;

  // sight
  let sees = false;
  if (rp.sight > 0 && z.state !== 'dormant') {
    const dx = P.x - z.x, dz = P.z - z.z, d = hyp(dx, dz), range = rp.sight * (P.crouch ? 0.7 : 1);
    if (d < range && Math.abs(P.y - z.y) < (rp.vert || 4)) {
      const cos = (Math.sin(z.yaw) * dx + Math.cos(z.yaw) * dz) / (d || 1);
      if (cos > Math.cos((rp.fov * Math.PI) / 360) && hasLOS(S.level, z.x, z.y + 1.6, z.z, P.x, eyeY(P), P.z)) {
        sees = true;
        const ex = P.crouch ? A.expose.crouch : P.run ? A.expose.run : P.moving ? A.expose.walk : A.expose.still;
        let gain = A.sightGain * (rp.gain || 1) * ex * (1 - d / range) * dt * z.sens;
        if (d < A.close) gain += dt * 3;
        z.meter = Math.min(1, z.meter + gain);
        z.lkp = { x: P.x, z: P.z }; z.seenT = S.t; z.lastStim = S.t; z.stim = z.lkp;
      }
    }
  }
  z.sees = sees;
  if (S.t - z.lastStim > 0.4) z.meter = Math.max(0, z.meter - A.decay * dt);
  if (z.kind === 'screamer' && sees && !z.screamed && z.meter >= A.suspicious && z.state !== 'alert') { alertEnter(S, z); return; }

  const calm = z.state === 'idle' || z.state === 'caution';
  if (z.state !== 'alert' && z.state !== 'dormant' && z.meter >= A.alert) { alertEnter(S, z); return; }
  if (calm && z.meter >= A.suspicious) {
    setState(S, z, 'suspicious'); z.point = z.stim || z.lkp || { x: z.x, z: z.z }; z.arrived = false; z.timer = 0;
  }

  switch (z.state) {
    case 'dormant': break;
    case 'idle': patrol(S, z, dt); break;
    case 'caution':
      z.timer -= dt; z.sens = 1 + (Z.cautionSens - 1) * Math.max(0, z.timer / Z.caution);
      patrol(S, z, dt);
      if (z.timer <= 0) idleEnter(S, z);
      break;
    case 'suspicious':
      if (z.role === 'scout') {
        z.yaw = turn(z.yaw, Math.atan2(z.point.x - z.x, z.point.z - z.z), 6 * dt); z.timer += dt;
        if (z.timer > Z.suspiciousWait) idleEnter(S, z);
      } else {
        goTo(S, z, z.point.x, z.point.z, Z.walk, dt); z.leg += dt;
        // At the end of a path that stops short of the spot (the noise was inside a wall or on sealed ground), it cannot get closer: it searches from here.
        const end = z.path && z.path.length ? z.path[z.path.length - 1] : null, blocked = end && hyp(end[0] - z.x, end[1] - z.z) < 1 && hyp(end[0] - z.point.x, end[1] - z.point.z) > 1.5;
        // there, or close to it with another investigator already on top of it (so a crowd does not stack up): search the area round the noise
        const crowded = hyp(z.point.x - z.x, z.point.z - z.z) < 6 && S.zombies.some((o) => o !== z && o.role !== 'scout' && (o.state === 'suspicious' || o.state === 'search') && hyp(o.x - z.x, o.z - z.z) < 2);
        const standoff = 1.5 + 4 * ((z.id * 0.6180339887) % 1); // each stops at its own distance (1.5 to 5.5 m), so they come in as a ring round the noise, not a stack on it
        if (arrivedAt(z, z.point.x, z.point.z, standoff) || crowded || blocked || z.leg > 40) searchEnter(S, z, z.point, Z.investigate, true);
      }
      break;
    case 'alert': {
      const tgt = sees ? { x: P.x, z: P.z } : z.lkp || { x: P.x, z: P.z };
      const dP = hyp(P.x - z.x, P.z - z.z);
      if (z.role === 'scout') {
        z.yaw = turn(z.yaw, Math.atan2(tgt.x - z.x, tgt.z - z.z), 6 * dt);
        z.report -= dt;
        if (sees && z.report <= 0) { // keeps reporting while it can see you, with where you are NOW, so the others follow you
          z.report = Z.scoutReport;
          emitNoise(S, z.x, z.y + 1.6, z.z, T.loud.call, 'call', 'zombie', z.id, { x: P.x, z: P.z });
        }
        if (!sees && S.t - z.seenT > Z.loseTime) cautionEnter(S, z);
        break;
      }
      if (dP < Z.attackRange && Math.abs(P.y - z.y) < 1.2 && sees) {
        z.yaw = turn(z.yaw, Math.atan2(P.x - z.x, P.z - z.z), 10 * dt);
        if (z.atk <= 0) attack(S, z);
      } else goTo(S, z, tgt.x, tgt.z, Z.run, dt);
      const lost = !sees && S.t - z.seenT > Z.loseTime;
      if (lost && (arrivedAt(z, tgt.x, tgt.z, 2) || S.t - z.seenT > Z.loseTime + 6)) searchEnter(S, z);
      break;
    }
    case 'search':
      z.timer -= dt; z.leg += dt;
      if (!z.arrived) {
        goTo(S, z, z.point.x, z.point.z, Z.walk, dt);
        if (arrivedAt(z, z.point.x, z.point.z, 1.5) || z.leg > 25) { z.arrived = true; z.wait = between(S, Z.wait); } // 25 s: a point it cannot reach is given up
      } else {
        z.wait -= dt; z.yaw += 1.2 * dt;
        if (z.wait <= 0) { // on to the next point, anywhere within the search radius of the centre and away from the other searchers
          const next = pickSearchPoint(S, z, z.searchC || z.lkp || z.point, Z.searchRadius);
          if (next) { z.point = next; z.arrived = false; z.leg = 0; z.path = null; z.goal = null; } else z.wait = 0.5;
        }
      }
      if (z.timer <= 0) cautionEnter(S, z);
      break;
  }
}

function separate(S) {
  const Z = S.zombies;
  for (let i = 0; i < Z.length; i++) {
    if (Z[i].state === 'dead') continue;
    for (let j = i + 1; j < Z.length; j++) {
      if (Z[j].state === 'dead') continue;
      const dx = Z[j].x - Z[i].x, dz = Z[j].z - Z[i].z, d = hyp(dx, dz);
      if (d > 0 && d < 0.55) {
        const k = (0.55 - d) / 2 / d;
        moveBy(S.level, Z[i], -dx * k, -dz * k, TUNING.zombie.radius, TUNING.player.step);
        moveBy(S.level, Z[j], dx * k, dz * k, TUNING.zombie.radius, TUNING.player.step);
      }
    }
  }
}

// dir: unit vector [x, y, z] of the killing blow (the arrow's flight, or the player's aim for the knife) and part: 'head' | 'chest' | 'hips'
// or null; the renderer uses them to throw the ragdoll.
function kill(S, z, how, dir = null, part = null) {
  setState(S, z, 'dead');
  z.meter = 0; z.sees = false;
  S.stats.kills++;
  S.events.push({ type: 'kill', id: z.id, how, dir, part });
  emitNoise(S, z.x, z.y + 0.3, z.z, TUNING.loud.kill, 'fall', 'zombie', z.id); // the body falls
}

// ---------- arrows ----------

// The launch angle above the line of sight that lands an arrow at horizontal distance D, from the same
// height, at launch speed v. A pin sight puts the pin for D this far below the bore line.
export const dropAngle = (D, v = TUNING.bow.speed) => 0.5 * Math.asin(Math.min(1, (TUNING.gravity * D) / (v * v)));
export const PIN_RANGES = [20, 30, 40, 50, 60];
export const pinAngles = () => PIN_RANGES.map((D) => dropAngle(D));

// `from` (optional) is the launch point, e.g. the camera in first person; the default is just below the eye.
export function fireArrow(S, aim, f, kind, from = null) {
  const P = S.player, B = TUNING.bow;
  if (P.quiver[kind] <= 0) return false;
  P.quiver[kind]--;
  const held = Math.max(0, P.drawT - B.drawTime - B.swaySecs);
  const cone = B.spread + (P.moving ? B.moveSpread : 0) + B.swayGrow * held;
  let dx = aim[0] + (rand(S) - 0.5) * 2 * cone, dy = aim[1] + (rand(S) - 0.5) * 2 * cone, dz = aim[2] + (rand(S) - 0.5) * 2 * cone;
  const n = hyp(dx, dy, dz); dx /= n; dy /= n; dz /= n;
  const sp = B.speed * (0.5 + 0.5 * f), o = from || [P.x, eyeY(P) - 0.2, P.z];
  const a = {
    id: S.nextId++, kind, state: 'fly', x: o[0] + dx * 0.4, y: o[1] + dy * 0.4, z: o[2] + dz * 0.4, vx: dx * sp, vy: dy * sp, vz: dz * sp,
    dir: [dx, dy, dz], origin: { x: P.x, z: P.z }, age: 0, whistle: 0, tag: null,
  };
  S.arrows.push(a);
  S.stats.shots++;
  playerNoise(S, TUNING.loud.release, 'release');
  S.events.push({ type: 'shot', id: a.id, kind });
  return true;
}

function stick(S, a, x, y, z, tag) {
  a.state = 'stuck'; a.x = x; a.y = y; a.z = z; a.tag = tag; a.vx = a.vy = a.vz = 0;
  const L = TUNING.loud, loud = tag === 'metal' ? L.metal : tag === 'concrete' || tag === 'rock' || tag === 'asphalt' ? L.hard : L.soft;
  emitNoise(S, x, y, z, loud, 'impact', 'arrow', -1, null, tag);
  S.events.push({ type: 'stick', id: a.id, tag });
}

function hitZombie(S, a, z, part, x, y, z2) {
  a.zid = z.id; a.part = part; // the renderer sticks the arrow to that body part, and retrieve() knows who is holding it
  if (a.kind === 'lure') return stick(S, a, x, y, z2, 'flesh'); // a whistling arrow does no damage
  a.state = 'stuck'; a.x = x; a.y = y; a.z = z2; a.tag = 'flesh'; a.vx = a.vy = a.vz = 0;
  S.events.push({ type: 'stick', id: a.id, tag: 'flesh' });
  if (part === 'head') { kill(S, z, 'head', a.dir, 'head'); S.stats.clean++; return; }
  bodyHit(S, z, a.origin, a.dir, part, 'body');
}

// A hit that is not a headshot, shared by arrows and the knife so the two cannot drift apart: one hit point off; a kill if that was the
// last, otherwise the zombie screams, turns toward `from` (where the blow came from) and goes alert. Returns true if it died.
function bodyHit(S, z, from, dir, part, how) {
  z.hp -= 1;
  if (z.hp <= 0) { kill(S, z, how, dir, part); return true; }
  S.stats.messy++;
  S.events.push({ type: 'wound', id: z.id });
  z.lkp = { x: from.x, z: from.z }; z.stim = z.lkp; z.seenT = S.t;
  alertEnter(S, z);
  emitNoise(S, z.x, z.y + 1.2, z.z, TUNING.loud.wound, 'wound', 'zombie', z.id); // the scream
  return false;
}

function stepArrows(S, dt) {
  const L = S.level, h = dt / 4;
  for (const a of S.arrows) {
    if (a.state !== 'fly') continue;
    a.age += dt;
    for (let i = 0; i < 4 && a.state === 'fly'; i++) {
      const nx = a.x + a.vx * h, ny = a.y + a.vy * h, nz = a.z + a.vz * h;
      const sp = hyp(a.vx, a.vy, a.vz); a.dir = [a.vx / sp, a.vy / sp, a.vz / sp];
      let bestT = 2, hitBox = null, hitZ = null, part = null;
      const w = rayWorld(L, a.x, a.y, a.z, nx, ny, nz);
      if (w) { bestT = w.t; hitBox = w; }
      for (const z of S.zombies) {
        if (z.state === 'dead') continue;
        const k = hitScale(z);
        for (const [name, hy, r] of PARTS) {
          const t = segSphere(a.x, a.y, a.z, nx, ny, nz, z.x, z.y + hy * k, z.z, r * k);
          if (t >= 0 && t < bestT) { bestT = t; hitZ = z; part = name; hitBox = null; }
        }
      }
      if (bestT <= 1) {
        const x = a.x + (nx - a.x) * bestT, y = a.y + (ny - a.y) * bestT, z = a.z + (nz - a.z) * bestT;
        if (hitZ) hitZombie(S, a, hitZ, part, x, y, z); else stick(S, a, x, y, z, hitBox.tag);
      } else {
        a.x = nx; a.y = ny; a.z = nz; a.vy -= TUNING.gravity * h;
        // ponytail: the wind pushes with an acceleration proportional to its speed, not to the arrow's speed relative to the air;
        // slow lobs and fast shots drift alike apart from the flight time. Switch to relative-velocity drag if long lobs need to be exact.
        a.vx += S.wind.x * TUNING.wind.drift * h; a.vz += S.wind.z * TUNING.wind.drift * h;
      }
    }
    if (a.state === 'fly') {
      if (a.kind === 'lure') { a.whistle += dt; if (a.whistle >= 0.1) { a.whistle = 0; emitNoise(S, a.x, a.y, a.z, TUNING.loud.whistle, 'whistle', 'arrow'); } }
      if (a.age > 10 || a.y < L.minY - 10) a.state = 'gone';
    }
  }
  S.arrows = S.arrows.filter((a) => a.state !== 'gone');
}

// ---------- player actions ----------

export function retrieve(S) {
  const P = S.player;
  let best = -1, bd = TUNING.bow.reach;
  S.arrows.forEach((a, i) => {
    if (a.state !== 'stuck') return;
    let x = a.x, y = a.y, z = a.z;
    if (a.zid) { // stuck in a zombie: out of reach while it lives, and it lies where it fell (not where it was hit) once dead
      const h = S.zombies.find((q) => q.id === a.zid);
      if (h && h.state !== 'dead') return;
      if (h) { x = h.x; y = h.y; z = h.z; }
    }
    const d = hyp(x - P.x, z - P.z);
    if (d < bd && Math.abs(y - P.y) < 3) { bd = d; best = i; }
  });
  if (best < 0) return false;
  const [a] = S.arrows.splice(best, 1);
  P.quiver[a.kind]++;
  S.stats.retrieved++;
  playerNoise(S, TUNING.loud.rummage, 'rummage');
  S.events.push({ type: 'retrieve', id: a.id });
  return true;
}

// What the knife would hit right now: the nearest living zombie within reach, in front of the player (the cone around P.yaw, which
// stepPlayer takes from the aim direction) and in line of sight, else null. `silent` is true when the stab is an instant quiet kill:
// the zombie is not alert and is either dormant or has its back to the player. Anything else is a plain stab (one hit point and a scream).
// main.js reads this for the [F] Knife prompt, so the rule lives in one place.
export function knifeTarget(S) {
  const P = S.player, T = TUNING.player, fx = Math.sin(P.yaw), fz = Math.cos(P.yaw);
  let best = null, bd = T.knife;
  for (const z of S.zombies) {
    if (z.state === 'dead') continue;
    const d = hyp(z.x - P.x, z.z - P.z);
    if (d >= bd || Math.abs(z.y - P.y) > 1) continue;
    if (d > 0.4 && ((z.x - P.x) * fx + (z.z - P.z) * fz) / d < T.knifeCone) continue; // outside the swing arc
    if (!hasLOS(S.level, P.x, P.y + 1, P.z, z.x, z.y + 1, z.z)) continue; // not through a wall
    best = z; bd = d;
  }
  if (!best) return null;
  const d = hyp(best.x - P.x, best.z - P.z);
  const behind = best.state === 'dormant' || (Math.sin(best.yaw) * (P.x - best.x) + Math.cos(best.yaw) * (P.z - best.z)) / (d || 1) < -0.2;
  return { z: best, silent: best.state !== 'alert' && behind };
}

// One swing, hit or miss: the event is what the sound, the swing animation and the toast react to. Every swing starts a cooldown (a hit
// that does damage must not be spammable: two presses in two frames would otherwise skip the wound scream and kill anything).
// Returns true if it hit.
export function knife(S) {
  const P = S.player;
  if (P.knifeCd > 0) return false;
  P.knifeCd = TUNING.player.knifeCd;
  const t = knifeTarget(S);
  if (!t) { S.events.push({ type: 'knife', hit: false, id: -1, silent: false, killed: false }); return false; }
  const { z, silent } = t, d = hyp(z.x - P.x, z.z - P.z) || 1, dir = [(z.x - P.x) / d, 0, (z.z - P.z) / d];
  let killed = true;
  if (silent) { kill(S, z, 'knife', dir, 'chest'); S.stats.clean++; }
  else killed = bodyHit(S, z, P, dir, 'chest', 'stab');
  S.events.push({ type: 'knife', hit: true, id: z.id, silent, killed });
  return true;
}

// Mark the first living zombie along the ray (origin, dir) within 80 m and in the open.
export function tagZombie(S, o, dir, range = 80, commit = true) {
  const e = [o[0] + dir[0] * range, o[1] + dir[1] * range, o[2] + dir[2] * range];
  let bestT = 2, best = null;
  for (const z of S.zombies) {
    if (z.state === 'dead') continue;
    const k = hitScale(z);
    for (const [, hy, r] of PARTS) {
      const t = segSphere(o[0], o[1], o[2], e[0], e[1], e[2], z.x, z.y + hy * k, z.z, r * k);
      if (t >= 0 && t < bestT) { bestT = t; best = z; }
    }
  }
  if (!best) return -1;
  const wall = rayWorld(S.level, o[0], o[1], o[2], e[0], e[1], e[2]);
  if (wall && wall.t < bestT) return -1;
  if (commit && !best.tagged) { best.tagged = true; S.events.push({ type: 'tag', id: best.id }); }
  return best.id; // with commit = false this only reports what is under the crosshair
}

// Binoculars: does the point `o` see this living zombie's head, chest or hips through nothing solid? (Whether it is inside the viewfinder is the renderer's call.)
export function seesZombie(S, o, z) {
  if (z.state === 'dead') return false;
  const k = hitScale(z);
  return PARTS.some(([, hy]) => hasLOS(S.level, o[0], o[1], o[2], z.x, z.y + hy * k, z.z));
}
// Tag one zombie by id (the binoculars do this once it has stayed in the viewfinder long enough). Returns true if it was newly tagged.
export function tagById(S, id) {
  const z = S.zombies.find((q) => q.id === id);
  if (!z || z.state === 'dead' || z.tagged) return false;
  z.tagged = true; S.events.push({ type: 'tag', id });
  return true;
}

export function bail(S) {
  const P = S.player;
  if (!S.entered || S.over || hyp(P.x - S.bike.x, P.z - S.bike.z) > 3) return false;
  S.over = 'bailed';
  S.events.push({ type: 'over', result: S.over });
  return true;
}

// ---------- the step ----------

// inp: { mx, mz (world move direction), run, crouch, draw, cancel, aim: [x, y, z] unit vector }
export function step(S, inp) {
  if (S.over) return;
  const dt = TUNING.dt;
  S.t += dt; S.stats.time = S.t;
  S.wind = windAt(S);
  stepBell(S);
  stepPlayer(S, inp, dt);
  for (const z of S.zombies) if (z.state !== 'dead') stepZombie(S, z, dt);
  separate(S);
  stepArrows(S, dt);
  stepStatus(S);
}

function stepBell(S) {
  const B = TUNING.bell, ring = S.t % B.period < B.ring;
  if (ring && !S.bell.ring) S.events.push({ type: 'bell', x: S.bell.x, y: S.bell.y, z: S.bell.z });
  S.bell.ring = ring;
}

function stepPlayer(S, inp, dt) {
  const T = TUNING, P = S.player, L = S.level, B = T.bow;
  P.crouch = !!inp.crouch;
  P.stun = Math.max(0, P.stun - dt);
  P.knifeCd = Math.max(0, P.knifeCd - dt);
  if (inp.aim) P.yaw = Math.atan2(inp.aim[0], inp.aim[2]); // where the player faces: the knife swings that way (tests pass aim: null and keep P.yaw)
  P.run = !!inp.run && !P.crouch && !inp.draw && P.stun <= 0;
  const speed = (P.crouch ? T.player.crouch : P.run ? T.player.run : T.player.walk) * (inp.draw ? T.player.drawMove : 1) * (P.stun > 0 ? 0.35 : 1);
  const m = hyp(inp.mx || 0, inp.mz || 0);
  P.moving = m > 0.01;
  if (P.moving) {
    moveBy(L, P, (inp.mx / m) * speed * dt, (inp.mz / m) * speed * dt, T.player.radius, T.player.step);
    P.stride += speed * dt;
    const stride = P.run ? 2.2 : P.crouch ? 1.2 : 1.6;
    if (P.stride >= stride) { P.stride = 0; playerNoise(S, P.run ? T.loud.stepRun : P.crouch ? T.loud.stepCrouch : T.loud.stepWalk, 'step', surfaceTag(L, P.x, P.z)); }
  }
  const g = heightAt(L, P.x, P.z);
  if (isFinite(g)) {
    if (P.y < g || (!P.falling && P.y - g <= T.player.step)) P.y = g; // stepped up, or down a slope or a step
    else if (P.y > g + 0.001) {
      if (!P.falling) { P.falling = true; P.fallFrom = P.y; P.vy = 0; }
      P.vy -= T.gravity * dt; P.y += P.vy * dt;
      if (P.y <= g) {
        P.y = g; P.falling = false; P.vy = 0;
        const drop = P.fallFrom - g;
        if (drop > 0.8) playerNoise(S, Math.min(1, T.loud.landPerM * drop), 'land', surfaceTag(L, P.x, P.z));
      }
    }
  }
  // bow
  if (inp.cancel) { P.drawing = false; P.drawT = 0; }
  else if (inp.draw && P.quiver[P.kind] > 0) { P.drawing = true; P.drawT += dt; }
  else if (P.drawing) {
    const f = Math.min(1, P.drawT / B.drawTime);
    if (f >= B.minDraw && inp.aim) fireArrow(S, inp.aim, f, P.kind, inp.from);
    P.drawing = false; P.drawT = 0;
  }
}

function stepStatus(S) {
  const P = S.player;
  let alert = false, seen = false, susp = false, search = false, alive = 0, adjacent = 0, threatDist = Infinity, threatN = 0;
  for (const z of S.zombies) {
    if (z.state === 'dead') continue;
    alive++;
    if (z.state === 'alert') {
      const dist = hyp(z.x - P.x, z.z - P.z);
      alert = true;
      if (z.sees) seen = true;
      if (z.role !== 'scout') { threatDist = Math.min(threatDist, dist); threatN++; } // scouts hold their post
      if (dist < TUNING.zombie.attackRange + 0.3 && Math.abs(z.y - P.y) < 1.2) adjacent++;
    }
    else if (z.state === 'suspicious') susp = true;
    else if (z.state === 'search' || z.state === 'caution') search = true;
  }
  S.threat.dist = threatDist; S.threat.count = threatN;
  S.status = seen ? 'SPOTTED' : alert ? 'HUNTED' : susp ? 'NOTICED' : search ? 'HIDING' : 'UNSEEN';
  if (alert && !S.wasAlert) { S.stats.blown++; S.events.push({ type: 'blown' }); }
  S.wasAlert = alert;
  const E = S.enter; // the level says where the outpost starts: the bike can only be used to bail once the player has gone in
  if (E ? hyp(P.x - E.x, P.z - E.z) < E.r : P.z < 25 && Math.abs(P.x) < 30) S.entered = true;
  if (adjacent >= 2) { P.hp = 0; S.events.push({ type: 'swarmed' }); }
  if (P.hp <= 0) { P.hp = 0; S.over = 'dead'; S.events.push({ type: 'over', result: S.over }); }
  else if (alive === 0) { S.over = 'cleared'; S.events.push({ type: 'over', result: S.over }); }
}

export const aliveCount = (S) => S.zombies.filter((z) => z.state !== 'dead').length;
export const playerEye = eyeY;
