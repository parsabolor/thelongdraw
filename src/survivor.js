// survivor.js: auto-skins the three static survivor meshes (Head, Body, Legs) to a 19-bone skeleton and animates it procedurally.
//   createSurvivorFigure(entry, opts) -> fig = { root, head, anchor(part), update(dt, p), dispose() }   (the interface of models.js createFigure)
//     entry: models.js prepare() result for the survivor (scene = the FBX Group, cm units, meshes already retextured).
//     opts:  { height = 1.82, yaw = 0, scale = 1, material = (src) => src }   (models.js passes CFG.player and its tinting material())
//     Throws if Head/Body/Legs are missing or the proportions are not the known model's, so the caller can fall back to characters.js.
//   Layers: constants (JOINTS, CAPS) -> computeWeights (pure, no THREE) -> pose (pure, no THREE) -> the THREE adapter at the bottom.
// Landmarks are measured ONCE from the mesh (dev/survivor.html shows them over the model): cm, mesh space, +x = the character's left,
// +z = front, soles at y = -3. Rotations are about the bones' own axes, which are all aligned with the mesh axes at rest.
import * as THREE from 'three';
import { spring } from './motion.js';

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sstep = (x, a, b) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------- skeleton ----------
// Sided joints are the LEFT ones (x > 0); the right bone is the mirror image (x negated, name suffix R).
export const JOINTS = {
  hips: [0, 88, 3], spine: [0, 100, 2], chest: [0, 120, 1], neck: [0, 144, 1], head: [0, 151, 1],
  shoulder: [8, 142, 1], upperArm: [25, 140, 0], forearm: [40, 116, 3], hand: [49, 100, 16],
  thigh: [12, 86, 4], shin: [12, 48, 0], foot: [14, 9, -2],
};
const PARENT = { hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck', shoulder: 'chest', upperArm: 'shoulder', forearm: 'upperArm', hand: 'forearm', thigh: 'hips', shin: 'thigh', foot: 'shin' };
const SIDED = new Set(['shoulder', 'upperArm', 'forearm', 'hand', 'thigh', 'shin', 'foot']);
export const BONES = []; // parents before children: { name, parent, joint }
for (const name of Object.keys(JOINTS)) {
  for (const side of SIDED.has(name) ? ['L', 'R'] : ['']) {
    const sgn = side === 'R' ? -1 : 1, par = PARENT[name];
    BONES.push({ name: name + side, parent: par && par + (SIDED.has(par) ? side : ''), joint: [JOINTS[name][0] * sgn, JOINTS[name][1], JOINTS[name][2]] });
  }
}
export const BONE_INDEX = Object.fromEntries(BONES.map((b, i) => [b.name, i]));
const sideName = (n, right) => (SIDED.has(n) ? n + (right ? 'R' : 'L') : n);

// ---------- weights (pure) ----------
// Per mesh, the ONLY bones that may influence it, each as a capsule [bone, a, b, radius, opts]. Sided capsules are the left ones;
// a vertex with x < 0 is folded onto x > 0, weighted against the left capsules and mapped back to the right bones, so left and right
// can never see each other's bones and the weights are mirror-symmetric by construction.
// w = softmax(-(distance to the capsule axis - radius) / sigma): "distance minus bone radius" with a smooth falloff; spec.floor soft-thresholds
// it (a bone whose share is below `floor` of the strongest one is out), then the 4 strongest are normalised.
// opts.ramp = [x, y, z, r0, r1]: the weight fades to 0 within r0 of that point (the arm gives way to the torso at the shoulder).
// spec.seam = [yTop, r0, r1, ky]: the crotch. The two legs are joined along the centre plane (x = 0) from yTop up, so a vertex within r0 of that
// half-plane (distance measured with y scaled by ky) belongs wholly to the pelvis ('hips') and hands over to the same-side limb bones gradually
// up to r1 (a lerp towards the pelvis), or the crotch webs when the legs part.
// ponytail: hand-placed envelopes (no heat-diffusion / DCC auto-weights): good for the walk, run and a moderate crouch, see the limits in the pose gate.
export const CAPS = {
  Head: { sigma: 2, caps: [ // hood, mask, hose and the backpack: only head and neck (the pack rides on the neck, i.e. the chest)
    ['neck', [0, 126, -12], [0, 148, 0], 10],
    ['head', [0, 160, 1], [0, 174, 1], 14],
  ] },
  Legs: { sigma: 4.5, seam: [70, 1.5, 30, 0.7], caps: [ // pants and boots: the pelvis and the same-side leg
    ['hips', [0, 90, 3], [12, 90, 3], 10],
    ['thigh', [12, 84, 4], [12, 48, 0], 9],
    ['shin', [12, 48, 0], [14, 16, -2], 8],
    ['foot', [14, 9, -2], [14, 2, 22], 9],
  ] },
  Body: { sigma: 5, floor: 0.15, caps: [ // coat, belt, pouches, sleeves, gloves: torso bones and the arms
    ['hips', [0, 66, 3], [0, 96, 3], 17],
    ['spine', [0, 96, 2], [0, 118, 1], 18],
    ['chest', [0, 118, 1], [0, 146, 1], 22.5],
    ['shoulder', [8, 142, 1], [25, 140, 0], 9],
    ['upperArm', [25, 140, 0], [40, 116, 3], 8.5, { ramp: [25, 140, 0, 3, 15] }],
    ['forearm', [40, 116, 3], [49, 100, 16], 7],
    ['hand', [49, 100, 16], [53, 86, 24], 6],
  ] },
};
export const MESHES = Object.keys(CAPS);

function segDist(px, py, pz, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const t = clamp(((px - a[0]) * dx + (py - a[1]) * dy + (pz - a[2]) * dz) / (dx * dx + dy * dy + dz * dz || 1), 0, 1);
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy, pz - a[2] - t * dz);
}

// positions: flat xyz array in cm (mesh space). Returns { index: Uint16Array(4n), weight: Float32Array(4n) }: 4 influences per vertex
// (unused ones have weight 0), the weights of a vertex sum to 1, and bone indices refer to BONES.
export function computeWeights(positions, meshName, spec = CAPS[meshName]) {
  if (!spec) throw new Error(`survivor: no weight spec for mesh "${meshName}"`);
  const n = Math.floor(positions.length / 3), caps = spec.caps, nc = caps.length;
  const index = new Uint16Array(n * 4), weight = new Float32Array(n * 4), w = new Float64Array(nc), order = new Array(nc);
  for (let i = 0; i < n; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2], right = x < 0, fx = Math.abs(x);
    let lmax = -Infinity;
    for (let c = 0; c < nc; c++) {
      const [, a, b, r] = caps[c];
      w[c] = -(segDist(fx, y, z, a, b) - r) / spec.sigma;
      if (w[c] > lmax) lmax = w[c];
    }
    let sum = 0;
    for (let c = 0; c < nc; c++) {
      const o = caps[c][4];
      let v = Math.max(0, Math.exp(w[c] - lmax) - (spec.floor || 0)); // soft threshold: a bone far behind the strongest one is out
      if (o && o.ramp) v *= sstep(Math.hypot(fx - o.ramp[0], y - o.ramp[1], z - o.ramp[2]), o.ramp[3], o.ramp[4]);
      w[c] = v; sum += v;
    }
    if (!(sum > 1e-12)) { w.fill(0); w[0] = 1; } // everything faded out: the first capsule (the pelvis, or the neck) owns it
    if (spec.seam) { // crotch seam: the sided limb weights hand over to the pelvis near the centre plane
      const [yTop, r0, r1, ky] = spec.seam, s = sstep(Math.hypot(fx, ky * Math.max(0, yTop - y)), r0, r1);
      let freed = 0;
      for (let c = 1; c < nc; c++) { freed += w[c] * (1 - s); w[c] *= s; }
      w[0] += freed;
    }
    for (let c = 0; c < nc; c++) order[c] = c;
    order.sort((p, q) => w[q] - w[p] || p - q); // strongest first, ties by table order (deterministic)
    const m = Math.min(4, nc);
    let keep = 0; for (let k = 0; k < m; k++) keep += w[order[k]];
    for (let k = 0; k < m; k++) {
      const c = order[k];
      index[4 * i + k] = BONE_INDEX[sideName(caps[c][0], right)]; weight[4 * i + k] = w[c] / keep;
    }
  }
  return { index, weight };
}

// ---------- pose (pure) ----------
// Leg segments in the sagittal plane, (y, z) in cm.
const TV = [JOINTS.shin[1] - JOINTS.thigh[1], JOINTS.shin[2] - JOINTS.thigh[2]], SV = [JOINTS.foot[1] - JOINTS.shin[1], JOINTS.foot[2] - JOINTS.shin[2]];
const LEG = Math.hypot(...TV) + Math.hypot(...SV);
const rot2 = (v, th) => [v[0] * Math.cos(th) - v[1] * Math.sin(th), v[0] * Math.sin(th) + v[1] * Math.cos(th)];
const ankleZ = (a, k) => rot2(TV, -a)[1] + rot2(SV, -a + k)[1]; // how far in front of the hip the ankle is when the thigh is flexed a and the knee k
// ponytail: a deep crouch (head top ~1.47 m of 1.82, was 1.66). Linear blend skinning creases the hip and knee at this depth (the pose gate measures edges
// down to 0.1x), but the coat hides it from every angle (looked at in dev/survivor.html); corrective bones are the upgrade if a bare-legged model comes.
export const CROUCH = { hip: 1.1, knee: 2.1, lean: 0.8, tilt: 0.3 }; // at full crouch (rad): leg flexion (from the vertical), forward lean of the torso, and how much of that lean is the pelvis tilting

// GAIT.swing scales the hip swing against the stride length; tuned on the planted-foot slip (it is lowest at 0.6-0.75, see the test).
export const GAIT = { swing: 0.75 };
// The model holds its arms out in an A-pose: the upper arm points ARM_REST rad (32 degrees) away from the body. A walker lets them hang, so the pose
// adds `down` rad of adduction, of which the clavicle (`shoulder`) takes a share so the armpit does not crumple. 0.45 of the 0.56 leaves the arms about
// 6 degrees off the body (the coat is bulky), looked at front, side and three-quarter in dev/survivor.html. The skin-stretch gate (test) measures
// the armpit folding a little at this angle; that is the explicit limit it carries for idle, run and crouch.
export const ARM_REST = Math.atan2(JOINTS.forearm[0] - JOINTS.upperArm[0], JOINTS.upperArm[1] - JOINTS.forearm[1]);
export const ARMS = { down: 0.45, shoulder: 0.3 };
// Metres of travel per full gait cycle (two steps) at speed sp (m/s). The phase advances by distance / this, so nothing steps while standing
// still and the stride follows the speed. The legs are short (0.77 m), so the strides are too.
export const strideLength = (sp, cr = 0) => (0.5 + 0.4 * sp) * (1 - 0.3 * cr);

// The machete STAB: u 0..1 over SWING_TIME seconds. A forward thrust, built from how knife and sword thrusts are done (fencing lunge, close-combat knife work, and
// the usual game-animation advice: a held guard, an accelerating strike that peaks at contact, a short hold, a faster return):
//   guard   u 0      the knife hand at the ribs with the blade pointing forward, torso coiled a little to the right, weight back (the carried pose)
//   thrust  u -> .2  the arm drives out to full reach at chest height, the torso uncoils and leans in, and (standing) the hips push forward over a stepped-out
//                    lead leg while the rear foot stays put. Eased IN, so the hand is moving fastest at contact: ~90 ms from the start
//   hold    u -> .32 a beat at full extension, the impact
//   return  u -> .52 back to the guard, eased OUT: fast, then settling
//   recover u -> 1   the pose joins the walk again (w fades out)
// Keyframes [u, ease, arm raised forward (rad), arm out from the body (rad), elbow flex (rad, rest is 0.68 bent: negative extends), torso twist (rad, + toward
// the character's left), torso lean (rad), lunge 0..1, left-arm balance (rad swung back)]. The ease is that of the segment ARRIVING at the key.
export const SWING_TIME = 0.45;
const MELEE = [
  [0, 'lin', 0.35, 0.05, 0.62, -0.28, -0.04, 0, 0],
  [0.2, 'in', 1.3, 0.1, -0.55, 0.4, 0.26, 1, 0.45],
  [0.32, 'lin', 1.34, 0.1, -0.58, 0.42, 0.28, 1, 0.5],
  [0.52, 'out', 0.35, 0.05, 0.62, -0.1, 0.0, 0.3, 0.1],
  [1, 'io', 0.2, 0.1, 0.3, 0, 0, 0, 0],
];
const EASE = { lin: (x) => x, in: (x) => x * x, out: (x) => 1 - (1 - x) * (1 - x), io: (x) => x * x * (3 - 2 * x) };
export function melee(u) {
  u = clamp(u, 0, 1);
  let i = 0; while (i < MELEE.length - 2 && MELEE[i + 1][0] < u) i++;
  const a = MELEE[i], b = MELEE[i + 1], k = EASE[b[1]]((u - a[0]) / (b[0] - a[0])), v = a.slice(2).map((x, j) => x + (b[j + 2] - x) * k);
  return { arm: v[0], out: v[1], elbow: v[2], twist: v[3], lean: v[4], lunge: v[5], balance: v[6], w: sstep(u, 0, 0.08) * (1 - sstep(u, 0.6, 1)) };
}

// S = { ph (gait phase, rad), sp (smoothed speed, m/s), cr (crouch 0..1), at (attack 0..1), t (s), cm (cm per world metre) }
//   hold (0..1, the left hand carries the bow: its arm swings little and the forearm comes up), swing (-1 = none, else 0..1 progress through the machete
//   swing, SWING_TIME seconds: the right arm and torso play MELEE, blended in and out)
//   optional secondary motion, all 0 when absent (the adapter drives them with springs): lean (rad, torso pitch from acceleration, + forward),
//   arm (rad, extra arm swing, + backward), bank (rad, torso roll into a turn, + to the character's right), look (rad, head yaw, + to the left),
//   grade (rad, ground slope along the heading, + uphill)
// -> { pos: [x, y, z] of the hips (cm, offset from rest; y is left 0, see grounding below), rot: { boneName: [x, y, z] euler } }; bones not listed stay at rest.
export function pose(S) {
  const { ph, sp, cr: c = 0, at = 0, t = 0, cm = 100, hold = 0, swing = -1, lean: leanIn = 0, arm: armIn = 0, bank = 0, look = 0, grade = 0 } = S;
  const m = sstep(sp, 0.1, 0.7), run = sstep(sp, 2.8, 3.9), idle = 1 - m;
  // Hip swing amplitude: g() is a triangle-like wave, so the planted foot sweeps back at a near constant speed; A (radians) is sized so that sweep
  // roughly matches the body's advance over half a stride (strideLength / 2) times GAIT.swing, which keeps the planted sole's slip low.
  const A = Math.min(0.85, GAIT.swing * m * strideLength(sp, c) * cm / (4 * LEG * (1 - 0.3 * c))), g = (x) => 0.8106 * (Math.sin(x) - Math.sin(3 * x) / 9);
  const rot = {}, Yp = (0.12 + 0.02 * run) * (1 - 0.5 * c), sP = Math.sin(ph), cP = Math.cos(ph), c2 = Math.cos(2 * ph); // Yp: the pelvis yaw swing, the torso counter-twists against it
  for (let i = 0; i < 2; i++) {
    const side = 1 - 2 * i, L = i ? 'R' : 'L', q = ph + i * Math.PI, s = Math.sin(q);
    const lift = Math.pow(Math.max(0, Math.cos(q + 0.6)), 1.2);
    const a = A * g(q) + CROUCH.hip * c;
    const k = m * (0.07 + (0.95 + 0.25 * run) * lift * (1 - 0.9 * c)) + CROUCH.knee * c;
    const toe = m * (0.4 * Math.pow(Math.max(0, -s), 1.5) - 0.15 * Math.pow(Math.max(0, s), 3)) * (1 - 0.5 * c); // heel strike, flat, heel off
    const f = 0.4 * (a - k) + toe; // the foot follows the shin only half way: heel strike toes up, crouch on the balls of the feet (a flat foot would fold the ankle)
    rot['thigh' + L] = [-a - CROUCH.tilt * c, 0, side * (0.02 + 0.1 * c)]; rot['shin' + L] = [k, 0, 0]; rot['foot' + L] = [f, 0, 0];
    // arms swing opposite to the same-side leg; the A-pose forearm is already bent forward, so the elbow flexion is extra
    const hb = i === 0 ? hold : 0; // the bow hand is the left one: it swings a little less and carries the bow low, in front of the thigh
    // Overlapping action, as phase: the upper arm leads, the forearm's bend follows it by ~35 degrees and the wrist by ~75, so the arm drags and the hand
    // whips instead of every joint moving in lock-step. fwd(lag) is how far forward the arm was `lag` radians of the gait ago (-1 .. 1).
    const amp = m * (0.45 + 0.02 * run) * (1 - 0.5 * c) * (1 - 0.2 * hb), fwd = (lag) => -Math.sin(q - lag), sw = amp * fwd(0); // sw: arm swing, + forward
    // The model's forearm already bends ~39 degrees (0.68 rad) forward at rest, so a hanging arm needs the elbow EXTENDED (negative here) and it bends back
    // toward that and beyond only as the arm comes forward; the left arm carrying the bow bends more.
    const el = -0.4 + m * (0.1 + 0.6 * run) + 1.0 * amp * (0.5 + 0.5 * fwd(0.6)) + 0.35 * c + 0.25 * hb + (0.02 + 0.03 * idle) * Math.sin(1.3 * t + 2 * i);
    const add = m * (0.05 + 0.1 * run); // arms close in towards the body when running
    const atk = i ? at : 0;
    rot['shoulder' + L] = [-0.2 * sw, 0, side * 0.012 * Math.sin(1.6 * t + 0.5) * idle - side * ARMS.shoulder * (1 - atk) + side * 0.03 * cP * m]; // the shoulder dips as the opposite foot lands
    rot['upperArm' + L] = [(-(0.9 * sw + 0.35 * c + 0.1 * hb) + 0.08 * m + armIn) * (1 - atk) - 1.5 * atk, 0.05 * sw, -side * ((ARMS.down - ARMS.shoulder + add) * (1 - atk) + 0.1 * c)]; // (+0.08 m: a little back-bias, the arms swing further behind than ahead)
    rot['forearm' + L] = [-(el * (1 - atk) + 0.5 * atk), 0, 0.03 * sw * side];
    rot['hand' + L] = [-0.12 - 0.5 * amp * fwd(1.3) - 0.1 * hb, 0, side * 0.1 * amp * fwd(1.3)]; // the wrist flicks with the swing, last of all
  }
  const fwd = 0.02 + m * (0.05 + 0.2 * run) * (1 - c) + 0.15 * at + leanIn + 0.4 * grade, P = fwd + CROUCH.lean * c, br = Math.sin(1.6 * t); // uphill leans in
  // the whole body walks: the pelvis rolls and yaws with each step and shifts its weight over the planted foot, the spine and chest twist and roll
  // back against it (so the shoulders stay roughly square), and the head rides the bob.
  const roll = -0.05 * cP * m + 0.012 * Math.sin(0.45 * t) * idle;
  rot.hips = [CROUCH.tilt * c, -Yp * sP * m + 0.15 * at, roll]; // (no pelvis pitch: it would swing both planted feet fore and aft)
  rot.spine = [0.45 * (P - CROUCH.tilt * c) - 0.04 * c2 * m, 1.7 * Yp * sP * m, -0.7 * roll + 0.5 * bank];
  rot.chest = [0.55 * (P - CROUCH.tilt * c) + 0.012 * br * (1 - 0.6 * m) - 0.03 * c2 * m, 1.0 * Yp * sP * m + 0.4 * at, -0.5 * roll + 0.5 * bank];
  rot.neck = [-0.55 * P + 0.03 * c2 * m, -1.5 * Yp * sP * m + 0.04 * Math.sin(0.37 * t) * idle + 0.5 * look, 0.5 * roll];
  rot.head = [-0.25 * P + 0.04 * c2 * m, 0.5 * look, 0.02 * Math.sin(0.29 * t + 1) * idle + 0.3 * roll];
  let lungeZ = 0; // cm the pelvis is pushed forward in the stab's lunge
  if (swing >= 0) { // the machete stab: the right arm, the torso and (standing) the legs follow MELEE, blended over the walk pose
    const k = melee(swing), w = k.w, mixTo = (cur, to) => cur.map((v, j) => v + (to[j] - v) * w), lg = w * k.lunge * (1 - m) * (1 - c); // lunge only when standing: while walking the body is already moving
    rot.upperArmR = mixTo(rot.upperArmR, [-k.arm, 0, -k.out]); rot.forearmR = mixTo(rot.forearmR, [-k.elbow, 0, 0]); rot.handR = mixTo(rot.handR, [-0.2, 0, 0]);
    rot.upperArmL[0] += w * k.balance; rot.forearmL[0] -= 0.3 * w * k.balance; // the bow arm swings back to balance the reach
    rot.spine[1] += 0.5 * w * k.twist; rot.chest[1] += 0.5 * w * k.twist; rot.spine[0] += 0.5 * w * k.lean; rot.chest[0] += 0.5 * w * k.lean;
    rot.hips[1] += 0.25 * w * k.twist * (1 - m); rot.neck[1] -= 0.3 * w * k.twist; // the pelvis helps the turn when standing; the head stays on the target
    // The lunge: the lead (right) leg steps out with its knee bent, the rear (left) leg extends so its foot stays where it was while the pelvis moves 18 cm.
    rot.thighR[0] -= 0.5 * lg; rot.shinR[0] += 0.45 * lg; rot.thighL[0] += 0.14 * lg; rot.shinL[0] += 0.06 * lg; lungeZ = 18 * lg;
  }
  return { pos: [-1.8 * cP * m + 0.6 * Math.sin(0.45 * t) * idle, 0, lungeZ - (ankleZ(CROUCH.hip * c, CROUCH.knee * c) - ankleZ(0, 0))], rot }; // y: the adapter sets it so the lowest sole touches the ground
}

// ---------- THREE adapter ----------
const skinCache = new WeakMap(); // entry.scene -> { meshName: BufferGeometry sharing the source attributes, plus skinIndex / skinWeight }
export function skinned(scene, src) { // also used by fparms.js: the same weights, so the first-person arms deform exactly like the third-person body
  let cache = skinCache.get(scene);
  if (!cache) skinCache.set(scene, (cache = {}));
  return cache[src.name] || (cache[src.name] = (() => {
    const g = new THREE.BufferGeometry(), a = src.geometry.attributes, { index, weight } = computeWeights(a.position.array, src.name);
    for (const k of Object.keys(a)) g.setAttribute(k, a[k]);
    if (src.geometry.index) g.setIndex(src.geometry.index);
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
    return g;
  })());
}

// The 19 bones at rest, in the mesh's own units (cm): { inst: a Group holding the root bone, bones: { name: Bone }, list: Bone[] in BONES order }.
export function buildBones() {
  const inst = new THREE.Group(), bones = {}, list = [];
  for (const b of BONES) {
    const bone = new THREE.Bone(), pj = b.parent ? BONES[BONE_INDEX[b.parent]].joint : [0, 0, 0];
    bone.name = b.name; bone.position.set(b.joint[0] - pj[0], b.joint[1] - pj[1], b.joint[2] - pj[2]);
    bones[b.name] = bone; list.push(bone); (b.parent ? bones[b.parent] : inst).add(bone);
  }
  for (const n of ['hips', 'spine', 'chest', 'neck', 'head']) bones[n].rotation.order = 'YXZ'; // yaw outermost, then pitch
  inst.updateMatrixWorld(true);
  return { inst, bones, list };
}

export function createSurvivorFigure(entry, opts = {}) {
  const height = opts.height || 1.82, yaw = opts.yaw || 0, tint = opts.material || ((m) => m);
  const src = {};
  if (entry && entry.scene) { entry.scene.updateMatrixWorld(true); entry.scene.traverse((o) => { if (o.isMesh && MESHES.includes(o.name)) src[o.name] = o; }); }
  for (const n of MESHES) if (!src[n] || !src[n].geometry.attributes.position || !(src[n].geometry.attributes.position.count > 0)) throw new Error(`survivor: mesh "${n}" missing, cannot rig`);
  const box = new THREE.Box3();
  for (const n of MESHES) {
    if (!src[n].matrixWorld.equals(new THREE.Matrix4())) throw new Error(`survivor: mesh "${n}" has a transform, the landmarks assume the identity`);
    src[n].geometry.computeBoundingBox(); box.union(src[n].geometry.boundingBox);
  }
  if (!(Math.abs(box.min.y + 3) < 3 && Math.abs(box.max.y - 183.5) < 6 && box.max.x < 60 && box.min.x > -60)) throw new Error('survivor: proportions differ from the model the landmarks were measured on');

  const { inst, bones, list } = buildBones();
  const skeleton = new THREE.Skeleton(list), meshes = [];
  for (const n of MESHES) {
    const m = new THREE.SkinnedMesh(skinned(entry.scene, src[n]), tint(src[n].material));
    m.name = n; m.frustumCulled = false; m.castShadow = entry.tris < 50000; m.receiveShadow = true;
    inst.add(m); m.bind(skeleton); meshes.push(m);
  }
  const rest = BONES[BONE_INDEX.hips].joint, s = entry.scale * (opts.scale || 1);
  const centre = new THREE.Group(), scaled = new THREE.Group(), turn = new THREE.Group(), root = new THREE.Group();
  centre.position.set(-entry.center.x, -entry.min.y, -entry.center.z); // the same normalisation as models.js createFigure
  centre.add(inst); scaled.scale.setScalar(s); scaled.add(centre); turn.rotation.y = yaw; turn.add(scaled); root.add(turn);
  const head = new THREE.Object3D(); head.position.y = height * 0.93; root.add(head);

  // Ground contact: the hips ride on the lowest point of the posed soles (a few hundred real sole vertices, skinned on the CPU each frame), so
  // the feet touch the ground whatever the weights do to the boots. Skinning is linear, so shifting the hips shifts every vertex equally.
  // ponytail: no flight phase while running (the lowest foot is always on the ground); an IK foot plant is the upgrade if skating shows.
  const legs = meshes.find((m) => m.name === 'Legs'), lp = legs.geometry.attributes.position, cells = new Map(), _v = new THREE.Vector3();
  for (let i = 0; i < lp.count; i++) {
    if (lp.getY(i) > 3) continue;
    const key = `${lp.getX(i) < 0}|${Math.round(lp.getZ(i) / 2)}|${Math.round(Math.abs(lp.getX(i)) / 3)}`, j = cells.get(key);
    if (j === undefined || lp.getY(i) < lp.getY(j)) cells.set(key, i); // the lowest vertex of each 2 x 3 cm cell of the soles
  }
  const soles = [...cells.values()];
  const lowest = () => { inst.updateMatrixWorld(true); let lo = Infinity; for (const i of soles) { legs.applyBoneTransform(i, _v.fromBufferAttribute(lp, i)); lo = Math.min(lo, _v.y); } return lo; };
  root.updateMatrixWorld(true);
  const floor = lowest();

  const S = { ph: 0, sp: 0, cr: 0, at: 0, t: 0, cm: 1 / s, hold: 0, swing: -1, lean: 0, arm: 0, bank: 0, look: 0, grade: 0 }, sec = { lean: { x: 0, v: 0 }, arm: { x: 0, v: 0 }, bank: { x: 0, v: 0 }, look: { x: 0, v: 0 }, grade: { x: 0, v: 0 } }, anchors = { head: bones.head, chest: bones.chest, hips: bones.hips };
  let lying = 0;
  const fig = {
    root, head, skeleton, bones, meshes, state: S, anchor: (part) => anchors[part] || inst,
    // Puts a prop on a bone: `obj` is in METRES (the bone's own axes, which turn with the pose, are the mesh's at rest: +x the character's left,
    // +y up, +z forward). Returns the holder (hide it, or remove it with holder.removeFromParent()).
    attach(boneName, obj) { const h = new THREE.Group(); h.scale.setScalar(1 / s); h.add(obj); bones[boneName].add(h); return h; },
    update(dt, p = {}) {
      dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
      const dead = p.state === 'dead', v = dead || !Number.isFinite(p.speed) ? 0 : clamp(p.speed, 0, 8), ease = (rate) => 1 - Math.exp(-rate * dt);
      S.t += dt;
      S.sp += (v - S.sp) * ease(9); S.cr += ((p.crouch && !dead ? 1 : 0) - S.cr) * ease(7); S.at += ((p.attacking && !dead ? 1 : 0) - S.at) * ease(14);
      S.ph = (S.ph + TAU * v * dt / strideLength(v, S.cr)) % TAU; // distance driven: no travel, no stepping
      // Walking physics: springs that follow what the body is doing, so it leans into a push, its arms trail it, it banks into a turn, the head
      // follows where the camera looks a beat late, and it leans into a hill. p.turn (yaw rate, rad/s), p.look (camera yaw - body yaw, rad) and
      // p.grade (ground slope along the heading, rad, + uphill) are optional: without them only the acceleration terms act.
      S.hold += ((p.hold ? 1 : 0) - S.hold) * ease(8);
      S.swing = Number.isFinite(p.swing) && p.swing >= 0 && !dead ? Math.min(1, p.swing) : -1;
      const fin = (x, lim) => (Number.isFinite(x) ? clamp(x, -lim, lim) : 0), acc = dt > 0 ? clamp((v - (S.vp ?? v)) / dt, -12, 12) : 0, moving = sstep(v, 0.1, 1.5);
      S.vp = v;
      S.lean = spring(sec.lean, 0.018 * acc, 70, 9, dt);
      S.arm = spring(sec.arm, 0.03 * acc * moving, 90, 7, dt);
      S.bank = spring(sec.bank, -0.03 * fin(p.turn, 8) * moving, 45, 8, dt);
      S.look = spring(sec.look, dead ? 0 : fin(p.look, 1.1), 120, 16, dt);
      S.grade = spring(sec.grade, fin(p.grade, 0.8), 40, 12, dt);
      const P = pose(S);
      bones.hips.position.set(rest[0] + P.pos[0], rest[1] + P.pos[1], rest[2] + P.pos[2]);
      for (const [name, r] of Object.entries(P.rot)) bones[name].rotation.set(r[0], r[1], r[2]);
      bones.hips.position.y += floor - lowest();
      lying = clamp(lying + (dead ? dt * 2 : -dt * 2), 0, 1); // a dead survivor tips over, like the other static models
      turn.rotation.x = -lying * Math.PI / 2; turn.position.y = lying * 0.25;
    },
    dispose() { skeleton.dispose(); root.removeFromParent(); },
  };
  fig.update(0, {});
  return fig;
}
