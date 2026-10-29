// ragdoll.js: ragdoll physics for DEAD zombies, renderer only (the sim keeps the corpse at its last x,y,z).
//   createBody(...)    pure Verlet solver, no imports (unit-tested in Node): 27 joint particles, distance constraints, hinge knees and elbows,
//                      a heightfield floor with walls, a tether to the sim position, sleep.
//   createRagdoll(...) thin three adapter: starts the solver from the skinned skeleton's current pose and writes bone rotations back each frame.
//   findAnchors(model) the bones an arrow sticks to ({ head, chest, hips }), taken from the real skinned skeleton (skinnedBones(model) is that bone list).
// Mixamo bone names only (mixamorigHips ...); createRagdoll returns null for a rig it does not know, so the caller keeps its fallback.
// ponytail: a particle/distance-constraint doll, no rigid bodies, no self-collision beyond a few minimum distances, no joint limits but knees/elbows, walls and floor are
// sphere-vs-heightfield probes (a bone between two particles can clip a box corner). Upgrade path if it ever matters: a real rigid-body engine (Rapier/cannon-es) with
// capsule colliders and twist limits, driven through the same adapter (createRagdoll only needs the particles' positions back).

const H = 1 / 120, G = 9.81, ITER = 12, WALL = 0.5, LEDGE = 0.2, TETHER = 0.7, MAXPUSH = 0.1, TMAX = 4, MU = 1.2;

// name, collision radius (m), mass. The particle sits on the bone origin; the radius keeps the skinned body off the floor.
const side = (s) => [[s + 'Shoulder', 0.05, 1], [s + 'Arm', 0.05, 1], [s + 'ForeArm', 0.045, 0.8], [s + 'Hand', 0.04, 0.6], [s + 'HandMid', 0.03, 0.4],
  [s + 'UpLeg', 0.08, 1.5], [s + 'Leg', 0.065, 1.2], [s + 'Foot', 0.06, 1], [s + 'Toe', 0.02, 0.6], [s + 'ToeEnd', 0.02, 0.5]];
export const JOINTS = [['Hips', 0.12, 2], ['Spine', 0.11, 1.5], ['Spine1', 0.11, 1.5], ['Spine2', 0.12, 2], ['Neck', 0.05, 0.8], ['Head', 0.1, 1.2], ['HeadTop', 0.08, 0.8], ...side('L'), ...side('R')];
const IDX = Object.fromEntries(JOINTS.map((j, i) => [j[0], i]));
const both = (s) => s.trim().split(/\s+/).flatMap((c) => (c.includes('*') ? [c.replace(/\*/g, 'L'), c.replace(/\*/g, 'R')] : [c]));

// Real bones (parent-child): lengths must hold within +-2%.
export const BONES = both(`Hips-Spine Spine-Spine1 Spine1-Spine2 Spine2-Neck Neck-Head Head-HeadTop *Shoulder-*Arm *Arm-*ForeArm *ForeArm-*Hand *Hand-*HandMid
  Hips-*UpLeg *UpLeg-*Leg *Leg-*Foot *Foot-*Toe *Toe-*ToeEnd`).map((s) => s.split('-'));
// Rigid cross constraints: the pelvis (4 points) and the chest (5 points) and the shoulder sockets are rigid bodies, the foot a rigid triangle.
const RIGID = both(`Hips-*UpLeg LUpLeg-RUpLeg Spine-*UpLeg Spine1-Neck Spine2-*Shoulder LShoulder-RShoulder Neck-*Shoulder Spine1-*Shoulder
  *Arm-Spine2 *Arm-Neck *Arm-Spine1 *Foot-*ToeEnd`).map((s) => s.split('-'));
// Flexible ranges as a ratio of the initial distance: [a, b, min, max]. They stop the spine and neck folding and the chest twisting off the pelvis.
const RANGE = [['Hips', 'Spine1', 0.7, 9], ['Spine', 'Spine2', 0.7, 9], ['Hips', 'Spine2', 0.6, 9], ['Spine2', 'Head', 0.7, 9], ['Neck', 'HeadTop', 0.6, 9],
  ...both('LUpLeg-*Shoulder RUpLeg-*Shoulder').map((s) => [...s.split('-'), 0.88, 1.12])];
// Minimum distances in metres: keeps the legs and hands out of each other (no real self-collision; hands and torso may interpenetrate, squeezing them apart made limbs spit out).
const SEP = [['LLeg', 'RLeg', 0.13], ['LFoot', 'RFoot', 0.1], ['LHand', 'RHand', 0.08]];
// Hinges [knee, hip, ankle, frame, sign, rest]: the knee bends so the shin goes back (sign +1), the elbow so the forearm goes forward (sign -1). rest: the direction of the
// upper limb at rest in the body frame (0: straight down, +1: out to the left, -1: out to the right); the swing from there to where it points now turns "forward".
const HINGE = [['LLeg', 'LUpLeg', 'LFoot', 0, 1, 0], ['RLeg', 'RUpLeg', 'RFoot', 0, 1, 0], ['LForeArm', 'LArm', 'LHand', 1, -1, 1], ['RForeArm', 'RArm', 'RHand', 1, -1, -1]];

const IMPULSE = { head: 3.5, chest: 2.6, hips: 2.2 }, HIT = { head: 'Head', chest: 'Spine2', hips: 'Hips' };

function rng(seed) { // mulberry32
  let a = (Math.floor(Number.isFinite(seed) ? seed : 0) ^ 0x9e3779b9) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// pose: { JointName: [x, y, z] } in world metres (all of JOINTS). ground(x, z): the walkable surface height. anchor: { x, y, z }: the sim position.
// dir: unit [x, y, z] of the killing blow or null; part: 'head' | 'chest' | 'hips' | null; speed: the zombie's speed (m/s) when it died.
export function createBody({ pose, ground, anchor, dir = null, part = null, speed = 0, seed = 0 }) {
  const N = JOINTS.length, x = new Float64Array(N * 3), p = new Float64Array(N * 3), w = JOINTS.map((j) => 1 / j[2]), rad = JOINTS.map((j) => j[1]);
  JOINTS.forEach(([n], i) => { const v = pose[n]; x[i * 3] = v[0]; x[i * 3 + 1] = v[1]; x[i * 3 + 2] = v[2]; });
  const ax = anchor.x, az = anchor.z, ay = anchor.y || 0;
  const G2 = (a, b) => { const h = ground ? ground(a, b) : ay; return h === Infinity || Number.isFinite(h) ? h : ay; }; // sim.heightAt gives Infinity for solid rock and out of bounds: a wall

  const dist = (a, b) => Math.hypot(x[a * 3] - x[b * 3], x[a * 3 + 1] - x[b * 3 + 1], x[a * 3 + 2] - x[b * 3 + 2]);
  const cons = []; // [a, b, min, max]
  const add = (a, b, lo, hi) => cons.push([IDX[a], IDX[b], lo, hi]);
  for (const [a, b] of [...BONES, ...RIGID]) { const d = dist(IDX[a], IDX[b]); add(a, b, d, d); }
  for (const [a, b, lo, hi] of RANGE) { const d = dist(IDX[a], IDX[b]); add(a, b, d * lo, d * hi); }
  for (const [a, b, m] of SEP) add(a, b, m, Infinity);
  const bones = BONES.map(([a, b]) => [IDX[a], IDX[b], dist(IDX[a], IDX[b])]);
  const hinges = HINGE.map(([k, h, a, f, s, r]) => [IDX[k], IDX[h], IDX[a], f, s, r]);
  const frame = [[IDX.Hips, IDX.Spine, IDX.LUpLeg, IDX.RUpLeg], [IDX.Spine2, IDX.Neck, IDX.LShoulder, IDX.RShoulder]];
  const F = [new Float64Array(3), new Float64Array(3)];
  const fwd = () => { // body forward = side x up, for the pelvis and for the chest
    for (let k = 0; k < 2; k++) {
      const [h, s, l, r] = frame[k], ux = x[s * 3] - x[h * 3], uy = x[s * 3 + 1] - x[h * 3 + 1], uz = x[s * 3 + 2] - x[h * 3 + 2];
      const sx = x[l * 3] - x[r * 3], sy = x[l * 3 + 1] - x[r * 3 + 1], sz = x[l * 3 + 2] - x[r * 3 + 2];
      const fx = sy * uz - sz * uy, fy = sz * ux - sx * uz, fz = sx * uy - sy * ux, n = Math.hypot(fx, fy, fz) || 1;
      F[k][0] = fx / n; F[k][1] = fy / n; F[k][2] = fz / n;
    }
  };

  // ---- initial velocities: stagger carried from the walk, the killing blow, a little seeded asymmetry
  const rand = rng(seed), v0 = new Float64Array(N * 3);
  fwd();
  const fl = Math.hypot(F[0][0], F[0][2]) || 1, carry = Math.min(Math.max(speed || 0, 0), 3) * 0.5;
  for (let i = 0; i < N; i++) {
    v0[i * 3] = (F[0][0] / fl) * carry + (rand() - 0.5) * 0.16; v0[i * 3 + 1] = (rand() - 0.5) * 0.08; v0[i * 3 + 2] = (F[0][2] / fl) * carry + (rand() - 0.5) * 0.16;
  }
  for (const k of [IDX.LLeg, IDX.RLeg]) for (let c = 0; c < 3; c++) v0[k * 3 + c] += F[0][c] * 0.4; // the legs fold: a straight leg is a perfectly balanced pole
  if (dir && dir.every(Number.isFinite)) {
    const hit = IDX[HIT[part] || 'Spine2'], mag = IMPULSE[part] || IMPULSE.chest, dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    for (let i = 0; i < N; i++) {
      const wt = (0.2 + 0.8 * Math.max(0, 1 - dist(i, hit) / 0.7)) * (0.85 + 0.3 * rand()) * mag / dl;
      for (let c = 0; c < 3; c++) v0[i * 3 + c] += dir[c] * wt;
    }
  }
  for (let i = 0; i < N * 3; i++) p[i] = x[i] - v0[i] * H;

  // ---- one substep
  const fl_ = new Float64Array(N), pen = new Float64Array(N);
  const snap = Float64Array.from(x);
  const ga = rand() * 6.2832, gx = Math.cos(ga) * G * 0.015, gz = Math.sin(ga) * G * 0.015; // gravity leans a little (seeded): a limb balanced perfectly upright would otherwise stand for seconds
  let t = 0, acc = 0, still = 0, snapT = 0, motion = 1, frozen = false;

  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [-0.7071, -0.7071], [0.7071, -0.7071]];
  const gp = new Float64Array(N); // the floor under each particle at the end of the last substep
  // A wall, not a floor: the floor is more than WALL above the particle, or it jumped up by more than LEDGE since the last substep (a box face, not a slope) and the particle is below its top.
  // Without the second rule a limb under a ledge would be lifted onto it, and drag the body up with it.
  const isWall = (h, y, g) => h - y > WALL || (h - g > LEDGE && y < h - 0.02);
  function exit(o, g, ux, uz) { // distance along (ux, uz) from particle o to the first spot that is not a wall (to ~3 mm), or Infinity
    const free = (d) => !isWall(G2(x[o] + ux * d, x[o + 2] + uz * d), x[o + 1], g);
    for (let k = 1; k <= 60; k++) {
      if (!free(0.04 * k)) continue;
      let lo = 0.04 * (k - 1), hi = 0.04 * k; // bisect the last step
      for (let j = 0; j < 4; j++) { const m = (lo + hi) / 2; if (free(m)) hi = m; else lo = m; }
      return hi;
    }
    return Infinity;
  }
  const AXES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  function wall(i) { // if particle i is in a wall push it back toward the tether centre (or the nearest way out); then keep its sphere out of walls; gp[i] follows
    const o = i * 3, h = G2(x[o], x[o + 2]);
    if (isWall(h, x[o + 1], gp[i])) {
      let ux = ax - x[o], uz = az - x[o + 2]; const l = Math.hypot(ux, uz) || 1; ux /= l; uz /= l;
      let e = exit(o, gp[i], ux, uz);
      if (e === Infinity) { // the tether centre is behind more wall (the corpse stands on a roof): leave by the shortest way out instead
        for (const [dx, dz] of DIRS) { const d = exit(o, gp[i], dx, dz); if (d < e) { e = d; ux = dx; uz = dz; } }
      }
      if (e < Infinity) shove(o, ux, uz, e + 0.003);
    }
    for (const [dx, dz] of AXES) { // the sphere against box faces: probe one radius away along each axis, push back by what is inside
      const r = rad[i];
      if (!isWall(G2(x[o] + dx * r, x[o + 2] + dz * r), x[o + 1], gp[i])) continue;
      let lo = 0, hi = r; for (let j = 0; j < 4; j++) { const m = (lo + hi) / 2; if (isWall(G2(x[o] + dx * m, x[o + 2] + dz * m), x[o + 1], gp[i])) hi = m; else lo = m; }
      shove(o, -dx, -dz, r - lo);
    }
    gp[i] = G2(x[o], x[o + 2]);
  }
  function shove(o, ux, uz, d) { // move a particle d along (ux, uz) out of a wall, keeping its speed except what goes into the wall
    x[o] += ux * d; x[o + 2] += uz * d; p[o] += ux * d; p[o + 2] += uz * d;
    const vin = -((x[o] - p[o]) * ux + (x[o + 2] - p[o + 2]) * uz);
    if (vin > 0) { p[o] -= ux * vin; p[o + 2] -= uz * vin; }
  }

  const rigid = cons.filter((c) => c[2] === c[3]);
  function project([a, b, lo, hi]) { // distance constraint: pull or push the pair back into [lo, hi]
    const oa = a * 3, ob = b * 3, dx = x[ob] - x[oa], dy = x[ob + 1] - x[oa + 1], dz = x[ob + 2] - x[oa + 2], d = Math.hypot(dx, dy, dz);
    const tg = d < lo ? lo : d > hi ? hi : d; if (tg === d || d < 1e-9) return;
    const s = (d - tg) / d / (w[a] + w[b]);
    x[oa] += dx * s * w[a]; x[oa + 1] += dy * s * w[a]; x[oa + 2] += dz * s * w[a]; x[ob] -= dx * s * w[b]; x[ob + 1] -= dy * s * w[b]; x[ob + 2] -= dz * s * w[b];
  }

  // Knee and elbow: K bends one way only. The bending direction n is the body's forward turned along with the upper limb (the minimal swing from its rest direction to where
  // it points now), so it stays defined when the limb is raised or spread; the lower limb must not deflect the wrong way from it.
  function hinge([k, a, b, fi, sg, rest]) {
    const [hh, ss, l, r] = frame[fi];
    let ux = x[ss * 3] - x[hh * 3], uy = x[ss * 3 + 1] - x[hh * 3 + 1], uz = x[ss * 3 + 2] - x[hh * 3 + 2]; const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    let sx = x[l * 3] - x[r * 3], sy = x[l * 3 + 1] - x[r * 3 + 1], sz = x[l * 3 + 2] - x[r * 3 + 2];
    let fx = sy * uz - sz * uy, fy = sz * ux - sx * uz, fz = sx * uy - sy * ux; const fl2 = Math.hypot(fx, fy, fz) || 1; fx /= fl2; fy /= fl2; fz /= fl2; // forward = side x up
    let tx = x[k * 3] - x[a * 3], ty = x[k * 3 + 1] - x[a * 3 + 1], tz = x[k * 3 + 2] - x[a * 3 + 2]; const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    // the rest direction, tilted so the direction opposite to it (where the swing is undefined) is one a limb practically never points: legs down and forward, arms out and down
    let rx = -ux + 0.6 * fx, ry = -uy + 0.6 * fy, rz = -uz + 0.6 * fz;
    if (rest) { const sl = Math.hypot(sx, sy, sz) || 1; rx = rest * sx / sl - 0.5 * ux + 0.3 * fx; ry = rest * sy / sl - 0.5 * uy + 0.3 * fy; rz = rest * sz / sl - 0.5 * uz + 0.3 * fz; }
    const rl = Math.hypot(rx, ry, rz); rx /= rl; ry /= rl; rz /= rl;
    const fr = fx * rx + fy * ry + fz * rz; fx -= rx * fr; fy -= ry * fr; fz -= rz * fr; const fm = Math.hypot(fx, fy, fz) || 1; fx /= fm; fy /= fm; fz /= fm; // forward, made square to the rest direction
    const c = rx * tx + ry * ty + rz * tz, fade = Math.min(1, (1 + c) / 0.2); // c: cos of the swing; the limb opposite its rest direction has no defined swing
    if (fade <= 0) return;
    const vx = ry * tz - rz * ty, vy = rz * tx - rx * tz, vz = rx * ty - ry * tx; // v = rest x t
    const cx = vy * fz - vz * fy, cy = vz * fx - vx * fz, cz = vx * fy - vy * fx; // v x f
    const k1 = 1 / (1 + c), nx = fx + cx + (vy * cz - vz * cy) * k1, ny = fy + cy + (vz * cx - vx * cz) * k1, nz = fz + cz + (vx * cy - vy * cx) * k1; // the swung forward
    const e = ((x[b * 3] - x[k * 3]) * nx + (x[b * 3 + 1] - x[k * 3 + 1]) * ny + (x[b * 3 + 2] - x[k * 3 + 2]) * nz) * sg; // > 0: the lower limb deflects the wrong way
    if (e <= 0) return;
    const m = Math.min(e, 0.001) * fade * sg; // a small step per pass: a flipped limb unfolds over a few substeps instead of snapping (which would inject energy)
    x[b * 3] -= nx * m * 0.6; x[b * 3 + 1] -= ny * m * 0.6; x[b * 3 + 2] -= nz * m * 0.6; x[k * 3] += nx * m * 0.4; x[k * 3 + 1] += ny * m * 0.4; x[k * 3 + 2] += nz * m * 0.4;
  }

  function sub() {
    t += H;
    const ramp = t > 1.5 ? Math.min(1, (t - 1.5) / (TMAX - 1.5)) : 0, damp = 0.9985 - 0.12 * ramp * ramp; // from 1.5 s on the corpse gets heavier and heavier damping, so it is still by TMAX
    for (let i = 0; i < N; i++) { // integrate (Verlet), gravity, damping, a speed cap
      const o = i * 3; let vx = (x[o] - p[o]) * damp, vy = (x[o + 1] - p[o + 1]) * damp, vz = (x[o + 2] - p[o + 2]) * damp;
      const sp = Math.hypot(vx, vy, vz); if (sp > 0.15) { const k = 0.15 / sp; vx *= k; vy *= k; vz *= k; }
      p[o] = x[o]; p[o + 1] = x[o + 1]; p[o + 2] = x[o + 2]; x[o] += vx + gx * H * H; x[o + 1] += vy - G * H * H; x[o + 2] += vz + gz * H * H;
    }
    for (let i = 0; i < N; i++) { const h = G2(x[i * 3], x[i * 3 + 2]); fl_[i] = isWall(h, x[i * 3 + 1], gp[i]) ? -1e9 : h + rad[i]; pen[i] = 0; } // floors under the moved particles (a particle in a wall has none: it is pushed out below)
    for (let it = 0; it < ITER; it++) {
      for (const h of hinges) hinge(h);
      for (const c of cons) project(c);
      for (let i = 0; i < N; i++) { const y = x[i * 3 + 1]; if (y < fl_[i] && pen[i] < MAXPUSH) { const u = Math.min(fl_[i] - y, MAXPUSH - pen[i]); x[i * 3 + 1] = y + u; pen[i] += u; } } // at most MAXPUSH a substep in total, or a step up would be a catapult
    }
    for (let i = 0; i < N; i++) { // contact: no bounce, Coulomb friction from the push (a stronger push = a harder press = more grip)
      if (pen[i] <= 0) continue;
      const o = i * 3; p[o + 1] = x[o + 1];
      const dx = x[o] - p[o], dz = x[o + 2] - p[o + 2], l = Math.hypot(dx, dz), lim = MU * Math.max(pen[i], G * H * H);
      if (l <= lim) { x[o] = p[o]; x[o + 2] = p[o + 2]; } else { const k = (1 - lim / l) * 0.9; x[o] = p[o] + dx * k; x[o + 2] = p[o + 2] + dz * k; } // sliding on the floor also loses 10% a substep: dead weight, not a skid
    }
    for (let it = 0; it < 4; it++) for (const c of rigid) project(c); // a last rigid-only pass: bone lengths win over contact
    // tether: the pelvis stays within TETHER of the sim position (the whole body shifts with it); over the last 0.25 m its outward speed is removed from the whole body
    let tx = x[0] - ax, tz = x[2] - az; const td = Math.hypot(tx, tz);
    if (td > TETHER - 0.25) {
      tx /= td; tz /= td;
      const cut = Math.max(0, td - TETHER), vo = Math.max(0, (x[0] - p[0]) * tx + (x[2] - p[2]) * tz) * Math.min(1, (td - TETHER + 0.25) / 0.25);
      for (let i = 0; i < N; i++) { const o = i * 3; x[o] -= tx * cut; x[o + 2] -= tz * cut; p[o] -= tx * (cut - vo); p[o + 2] -= tz * (cut - vo); }
    }
    for (let i = 0; i < N; i++) wall(i); // the walls are resolved last, so no particle ends a step inside one
    if (t - snapT >= 0.25) { // asleep when nothing moved more than 2 cm in the last 0.25 s twice in a row (per-substep speed is no use, the solver jitters)
      let m = 0; for (let i = 0; i < N; i++) m = Math.max(m, Math.hypot(x[i * 3] - snap[i * 3], x[i * 3 + 1] - snap[i * 3 + 1], x[i * 3 + 2] - snap[i * 3 + 2]));
      still = m < 0.02 ? still + 1 : 0; snapT = t; snap.set(x); motion = m;
    }
    if ((still >= 2 && t > 0.8) || t >= TMAX) { // freeze: one last rigid-only pass so the resting pose has exact bone lengths
      for (let it = 0; it < 300; it++) for (const c of rigid) project(c); // the stiff rigid groups converge slowly, 300 passes is ~0.1 ms once
      frozen = true; for (let i = 0; i < N * 3; i++) p[i] = x[i];
    }
  }

  for (let i = 0; i < N; i++) gp[i] = G2(x[i * 3], x[i * 3 + 2]);

  return {
    x, names: JOINTS.map((j) => j[0]), index: IDX,
    get frozen() { return frozen; }, get time() { return t; }, get motion() { return motion; },
    pos: (n) => [x[IDX[n] * 3], x[IDX[n] * 3 + 1], x[IDX[n] * 3 + 2]],
    step(dt) { // fixed 1/120 s substeps, at most 0.1 s per call
      if (frozen || !(dt > 0)) return;
      acc += Math.min(dt, 0.1);
      while (acc >= H && !frozen) { sub(); acc -= H; }
    },
    maxStrain() { let m = 0; for (const [a, b, d] of bones) m = Math.max(m, Math.abs(dist(a, b) / d - 1)); return m; },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Three adapter. THREE is passed in (this module imports nothing). model: the cloned FBX group (SkeletonUtils.clone result).
const strip = (n) => n.replace(/^mixamorig:?/, '').replace(/_\d+$/, ''); // some exporters append a unique id (mixamorigHips_65)
const BONE = { Hips: 'Hips', Spine: 'Spine', Spine1: 'Spine1', Spine2: 'Spine2', Neck: 'Neck', Head: 'Head', HeadTop: 'HeadTop_End' };
for (const [s, n] of [['L', 'Left'], ['R', 'Right']]) {
  Object.assign(BONE, { [s + 'Shoulder']: n + 'Shoulder', [s + 'Arm']: n + 'Arm', [s + 'ForeArm']: n + 'ForeArm', [s + 'Hand']: n + 'Hand', [s + 'HandMid']: n + 'HandMiddle1',
    [s + 'UpLeg']: n + 'UpLeg', [s + 'Leg']: n + 'Leg', [s + 'Foot']: n + 'Foot', [s + 'Toe']: n + 'ToeBase', [s + 'ToeEnd']: n + 'Toe_End' });
}
// [bone, primary child, frame]: top-down. Hips and Spine2 take a two-vector frame (up + side) so the pelvis and chest twist correctly, the rest swing to their child.
const DRIVE = [['Hips', 'Spine', 0], ['Spine', 'Spine1'], ['Spine1', 'Spine2'], ['Spine2', 'Neck', 1], ['Neck', 'Head'], ['Head', 'HeadTop'],
  ...['L', 'R'].flatMap((s) => [[s + 'Shoulder', s + 'Arm'], [s + 'Arm', s + 'ForeArm'], [s + 'ForeArm', s + 'Hand'], [s + 'Hand', s + 'HandMid'],
    [s + 'UpLeg', s + 'Leg'], [s + 'Leg', s + 'Foot'], [s + 'Foot', s + 'Toe'], [s + 'Toe', s + 'ToeEnd']])];
const FRAME = [['Spine', 'Hips', 'LUpLeg', 'RUpLeg'], ['Neck', 'Spine2', 'LShoulder', 'RShoulder']]; // [up end, up start, side +, side -]

// The skinned skeleton: the one with most bones (the body) is the real one; the exporter's duplicate bones (same name as their parent, identity transform, only skin
// the eyelashes and the like) follow their parent, so any of them is a valid arrow anchor.
export function skinnedBones(model) {
  let main = null;
  model.traverse((o) => { if (o.isSkinnedMesh && (!main || o.skeleton.bones.length > main.bones.length)) main = o.skeleton; });
  return main ? main.bones : [];
}
export function findAnchors(model) { // { head, chest, hips } bones of the skinned skeleton, falling back to the model itself
  const b = skinnedBones(model), find = (...re) => { for (const r of re) { const f = b.find((o) => r.test(o.name)); if (f) return f; } return model; };
  return { head: find(/head(_\d+)?$/i), chest: find(/spine2(_\d+)?$/i, /spine1(_\d+)?$/i, /chest(_\d+)?$/i), hips: find(/hips(_\d+)?$/i, /pelvis(_\d+)?$/i) };
}

// model: the clone; ground(x, z); anchor {x, y, z} = the sim position; impulse { dir, part, speed }; seed (the zombie id).
// Call right after the last mixer update (the pose at death). Returns { update(dt), frozen, dispose(), body } or null when the rig is not Mixamo-named.
export function createRagdoll({ THREE, model, ground, anchor, impulse = {}, seed = 0 }) {
  const { Vector3: V3, Quaternion: Q, Matrix4: M4 } = THREE;
  model.updateWorldMatrix(true, true);
  // canonical bones: the outermost bone of each name (parents come first in a traversal)
  const byName = new Map(); model.traverse((o) => { if (o.isBone && !byName.has(strip(o.name))) byName.set(strip(o.name), o); });
  const bone = {}; for (const [j, n] of Object.entries(BONE)) { bone[j] = byName.get(n); if (!bone[j]) return null; }
  // bind world matrices (model space) from the skins' inverse bind matrices; the duplicates share them
  const bindM = new Map();
  model.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.bones.forEach((b, i) => { const n = strip(b.name); if (!bindM.has(n)) bindM.set(n, o.skeleton.boneInverses[i].clone().invert()); }); });
  const Qb = {}, Pb = {}, ts = new V3();
  for (const j of Object.keys(BONE)) { // bones with no skin (HeadTop_End, Toe_End) hang off their parent by their local offset
    const m = bindM.get(BONE[j]);
    if (m) { Pb[j] = new V3(); Qb[j] = new Q(); m.decompose(Pb[j], Qb[j], ts); }
  }
  for (const j of Object.keys(BONE)) {
    if (Pb[j]) continue;
    const pj = Object.keys(BONE).find((k) => bone[k] === bone[j].parent);
    if (!pj || !Pb[pj]) return null;
    Pb[j] = bone[j].position.clone().applyQuaternion(Qb[pj]).add(Pb[pj]);
  }
  const jointOf = new Map(Object.entries(bone).map(([j, b]) => [b, j]));
  const qInst = model.getWorldQuaternion(new Q()); // the bind pose lives in the model's frame; the dead body does not move, so this is fixed
  const basis = (up, sd, out) => { // orthonormal frame from an up and a side vector
    const y = up.clone().normalize(), xx = sd.clone().addScaledVector(y, -sd.dot(y)).normalize(), z = new V3().crossVectors(xx, y);
    return out.setFromRotationMatrix(new M4().makeBasis(xx, y, z));
  };

  const pose = {}; for (const j of Object.keys(BONE)) pose[j] = bone[j].getWorldPosition(new V3()).toArray();
  const body = createBody({ pose, ground, anchor, dir: impulse.dir || null, part: impulse.part || null, speed: impulse.speed || 0, seed });
  const P = (n) => new V3(body.x[body.index[n] * 3], body.x[body.index[n] * 3 + 1], body.x[body.index[n] * 3 + 2]);

  const drv = DRIVE.map(([j, c, fr]) => {
    const b = bone[j], pj = jointOf.get(b.parent) || null;
    if (!pj && b.parent !== model) return null;
    const qr = (pj ? Qb[pj].clone().invert() : new Q()).multiply(Qb[j]); // bind rotation relative to the parent, parent bind (model) is identity at the root
    const out = { j, c, b, pj, qr, qa: b.getWorldQuaternion(new Q()), C: new Q(), fr: fr === undefined ? -1 : fr };
    out.dirL = Pb[c].clone().sub(Pb[j]).applyQuaternion(Qb[j].clone().invert()).normalize(); // bone-local direction to the primary child
    out.qbw = qInst.clone().multiply(Qb[j]); // bind rotation in world
    if (out.fr >= 0) { // bind frame inverse for the two-vector frames
      const [u1, u0, s1, s0] = FRAME[out.fr];
      out.fbInv = basis(Pb[u1].clone().sub(Pb[u0]).applyQuaternion(qInst), Pb[s1].clone().sub(Pb[s0]).applyQuaternion(qInst), new Q()).invert();
    }
    return out;
  });
  if (drv.some((d) => !d)) return null;
  const wq = new Map(); // world rotation of each driven bone, top-down
  const parentQ = (d) => (d.pj ? wq.get(d.pj) : d.b.parent.getWorldQuaternion(new Q()));
  const qr = new Q(), q0 = new Q(), sw = new Q(), d0 = new V3(), dc = new V3();
  function reconstruct(d) { // the rotation the particles ask for, before the twist correction
    const pq = parentQ(d);
    if (d.fr >= 0) {
      const [u1, u0, s1, s0] = FRAME[d.fr];
      return basis(P(u1).sub(P(u0)), P(s1).sub(P(s0)), new Q()).multiply(d.fbInv).multiply(d.qbw);
    }
    q0.copy(pq).multiply(d.qr); // as if rigidly attached to the parent
    d0.copy(d.dirL).applyQuaternion(q0); dc.copy(P(d.c)).sub(P(d.j)).normalize();
    sw.setFromUnitVectors(d0, dc);
    return qr.copy(sw).multiply(q0).clone();
  }
  // twist the swing model cannot represent is captured once at death, so the first frame is exactly the pose the mixer froze
  for (const d of drv) { d.C.copy(reconstruct(d)).invert().multiply(d.qa); wq.set(d.j, d.qa.clone()); }

  const pelvis = new V3();
  function pose_() { // write the bones from the particles
    model.updateWorldMatrix(true, false);
    for (const d of drv) {
      const pq = parentQ(d), qt = reconstruct(d).multiply(d.C);
      wq.set(d.j, qt);
      d.b.quaternion.copy(pq).invert().multiply(qt);
    }
    pelvis.copy(P('Hips')); bone.Hips.position.copy(bone.Hips.parent.worldToLocal(pelvis));
  }
  let dead = false;
  return {
    body, bone,
    get frozen() { return body.frozen; },
    update(dt) { if (dead || body.frozen) return; body.step(dt); pose_(); },
    dispose() { dead = true; },
  };
}
