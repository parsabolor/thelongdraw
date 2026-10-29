// Headless checks for src/ragdoll.js: the pure solver (no three) and the three adapter on the real zombie skeleton. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createBody, createRagdoll, findAnchors, skinnedBones, JOINTS, BONES } from '../src/ragdoll.js';

// Two mid-stride poses of the zombie's walk clip, in metres, pelvis over the origin facing +Z (made from assets/models/game/zombie.fbx).
const WALK_A = { Hips: [0, 0.858, 0], Spine: [0.006, 0.961, 0.005], Spine1: [0.018, 1.077, 0.032], Spine2: [0.032, 1.194, 0.101], Neck: [0.053, 1.295, 0.214], Head: [0.048, 1.299, 0.304], HeadTop: [0.047, 1.43, 0.483], LShoulder: [0.116, 1.265, 0.206], LArm: [0.246, 1.229, 0.248], LForeArm: [0.238, 1.163, 0.481], LHand: [0.155, 1.123, 0.778], LHandMid: [0.111, 1.12, 0.896], LUpLeg: [0.083, 0.795, 0.033], LLeg: [0.066, 0.494, 0.339], LFoot: [0.093, 0.112, 0.222], LToe: [0.127, 0.01, 0.368], LToeEnd: [0.145, 0.012, 0.437], RShoulder: [-0.014, 1.306, 0.194], RArm: [-0.144, 1.351, 0.164], RForeArm: [-0.216, 1.248, 0.37], RHand: [-0.19, 1.104, 0.641], RHandMid: [-0.146, 1.022, 0.725], RUpLeg: [-0.083, 0.81, -0.052], RLeg: [-0.229, 0.43, -0.188], RFoot: [-0.266, 0.115, -0.433], RToe: [-0.37, 0.013, -0.327], RToeEnd: [-0.419, 0.012, -0.275] };
const WALK_B = { Hips: [0, 0.878, 0], Spine: [-0.004, 0.98, 0.013], Spine1: [-0.006, 1.095, 0.046], Spine2: [0.005, 1.211, 0.118], Neck: [0.035, 1.313, 0.229], Head: [0.072, 1.315, 0.311], HeadTop: [0.09, 1.419, 0.506], LShoulder: [0.088, 1.321, 0.183], LArm: [0.221, 1.365, 0.192], LForeArm: [0.331, 1.266, 0.384], LHand: [0.357, 1.125, 0.66], LHandMid: [0.352, 1.066, 0.771], LUpLeg: [0.078, 0.832, -0.06], LLeg: [0.27, 0.45, -0.105], LFoot: [0.241, 0.112, -0.317], LToe: [0.324, 0.01, -0.193], LToeEnd: [0.365, 0.013, -0.134], RShoulder: [-0.027, 1.285, 0.248], RArm: [-0.164, 1.269, 0.277], RForeArm: [-0.116, 1.224, 0.51], RHand: [0.017, 1.183, 0.784], RHandMid: [0.082, 1.132, 0.878], RUpLeg: [-0.082, 0.815, 0.034], RLeg: [-0.109, 0.508, 0.333], RFoot: [-0.17, 0.112, 0.334], RToe: [-0.133, 0.01, 0.478], RToeEnd: [-0.117, 0.008, 0.547] };

const flat = () => 0, slope = (x, z) => 0.6 * z; // the slope rises toward +Z, the way the zombie faces
const shift = (pose, dx, dy, dz) => Object.fromEntries(Object.entries(pose).map(([k, v]) => [k, [v[0] + dx, v[1] + dy, v[2] + dz]]));
const R = JOINTS.map((j) => j[1]);
// Runs a body for `seconds`, tracking the lowest gap to the floor (after the first 0.1 s) and the farthest the pelvis got from the anchor.
function drop(pose, { ground = flat, anchor = { x: 0, y: ground(0, 0), z: 0 }, seconds = 4.2, ...o } = {}) {
  const b = createBody({ pose: shift(pose, 0, anchor.y, 0), ground, anchor, ...o }), log = { minGap: Infinity, tether: 0, nan: false, last: 0 }, hist = [];
  for (let k = 0; k < seconds * 120; k++) {
    hist.push(Float64Array.from(b.x)); if (hist.length > 31) hist.shift(); // positions 0.25 s ago
    b.step(1 / 120);
    log.last = Math.max(...R.map((_, i) => Math.hypot(b.x[i * 3] - hist[0][i * 3], b.x[i * 3 + 1] - hist[0][i * 3 + 1], b.x[i * 3 + 2] - hist[0][i * 3 + 2])));
    for (let i = 0; i < R.length; i++) {
      const [x, y, z] = [b.x[i * 3], b.x[i * 3 + 1], b.x[i * 3 + 2]];
      if (!Number.isFinite(x + y + z)) log.nan = true;
      if (b.time > 0.1) log.minGap = Math.min(log.minGap, y - R[i] - ground(x, z));
    }
    log.tether = Math.max(log.tether, Math.hypot(b.x[0] - anchor.x, b.x[2] - anchor.z));
    if (b.frozen) break;
  }
  return { b, log };
}
const CASES = [['head', [0, 0.1, -1]], ['chest', [0.7, 0, 0.7]], ['hips', [0, -0.2, 1]], [null, null]];

test('bone lengths hold within 2% once the corpse has settled, on flat ground and on a 0.6 slope', () => {
  for (const ground of [flat, slope]) for (const pose of [WALK_A, WALK_B]) for (const [part, dir] of CASES) {
    const { b } = drop(pose, { ground, part, dir, speed: 1.1, seed: 3 });
    assert.ok(b.frozen, 'frozen');
    assert.ok(b.maxStrain() <= 0.02, `strain ${(b.maxStrain() * 100).toFixed(2)}% (${part}, ${ground === flat ? 'flat' : 'slope'})`);
  }
});

test('it settles and freezes within 4 s, and what froze is at rest on the ground', () => {
  for (const ground of [flat, slope]) for (const pose of [WALK_A, WALK_B]) for (const [part, dir] of CASES) {
    const { b, log } = drop(pose, { ground, part, dir, speed: 1.1, seed: 5 });
    assert.ok(b.frozen && b.time <= 4.01, `frozen at ${b.time.toFixed(2)} s`);
    assert.ok(log.last < 0.1, `still moving ${log.last.toFixed(3)} m in the last 0.25 s before it froze`);
    const top = Math.max(...R.map((r, i) => b.x[i * 3 + 1] - ground(b.x[i * 3], b.x[i * 3 + 2])));
    assert.ok(top < 0.6, `lying, not standing or hanging: highest joint ${top.toFixed(2)} m above the ground`);
  }
});

test('no joint goes below the floor (radius included), flat, sloped, and on a steep rugged slope', () => {
  const rugged = (x, z) => 1.0 * x + 0.15 * Math.sin(5 * z);
  for (const ground of [flat, slope, rugged]) for (const [part, dir] of CASES) {
    const { log } = drop(WALK_A, { ground, part, dir, speed: 2, seed: 9 });
    assert.ok(log.minGap > -0.03, `lowest gap ${log.minGap.toFixed(3)} m`);
  }
});

test('the pelvis stays within 0.7 m of the sim position, even thrown hard down a slope', () => {
  for (const ground of [flat, slope, (x, z) => 1.0 * x, (x, z) => -0.8 * z]) for (const [part, dir] of [['head', [1, 0, 0]], ['head', [0, 0.3, -1]], ['chest', [-1, 0, 0.5]], ['hips', [0, 0, 1]]]) {
    const { log } = drop(WALK_B, { ground, part, dir, speed: 3, seed: 11 });
    assert.ok(log.tether <= 0.7 + 1e-6, `pelvis got ${log.tether.toFixed(3)} m away`);
  }
});

test('deterministic: the same seed gives identical positions, another seed a different corpse; never NaN', () => {
  const a = drop(WALK_A, { part: 'chest', dir: [0, 0, -1], speed: 1, seed: 42 }).b, b = drop(WALK_A, { part: 'chest', dir: [0, 0, -1], speed: 1, seed: 42 }).b, c = drop(WALK_A, { part: 'chest', dir: [0, 0, -1], speed: 1, seed: 43 }).b;
  assert.deepEqual(Array.from(a.x), Array.from(b.x));
  assert.ok(Array.from(a.x).some((v, i) => Math.abs(v - c.x[i]) > 1e-3), 'seed 43 differs');
  for (let seed = 0; seed < 12; seed++) for (const [part, dir] of CASES) {
    const { log, b: d } = drop(seed % 2 ? WALK_A : WALK_B, { ground: seed % 3 ? slope : flat, part, dir, speed: 5, seed, seconds: 1.5 });
    assert.ok(!log.nan && Array.from(d.x).every(Number.isFinite), `NaN with seed ${seed}`);
  }
  const hostile = drop(WALK_A, { dir: [1e3, -1e3, 1e3], part: 'head', speed: 1e3, seed: 1, seconds: 1 }); // a silly impulse must not blow up
  assert.ok(!hostile.log.nan && hostile.log.tether <= 0.7 + 1e-6);
});

test('a body dropped next to a wall does not climb it, a corpse on a roof that falls off lands on the ground', () => {
  const wall = (x, z) => (z > 0.7 && z < 1.7 ? 1 : 0); // a 1 m thick, 1 m high box in front of the zombie
  for (const [part, dir] of [['head', [0, 0, 1]], ['chest', [0.2, 0.3, 1]], ['hips', [0, 0, 1]]]) {
    const { b } = drop(WALK_A, { ground: wall, part, dir, speed: 2, seed: 8 });
    for (const j of ['Hips', 'Spine', 'Spine1', 'Spine2', 'Head']) assert.ok(b.pos(j)[2] < 0.75, `${j} ended at z ${b.pos(j)[2].toFixed(2)}, on or in the wall`);
    for (let i = 0; i < R.length; i++) {
      assert.ok(wall(b.x[i * 3], b.x[i * 3 + 2]) === 0 || b.x[i * 3 + 1] >= 0.95, `${JOINTS[i][0]} is inside the wall (z ${b.x[i * 3 + 2].toFixed(2)}, y ${b.x[i * 3 + 1].toFixed(2)})`);
      assert.ok(b.x[i * 3 + 1] - R[i] >= wall(b.x[i * 3], b.x[i * 3 + 2]) - 0.03, `${JOINTS[i][0]} is below the floor`); // (the in-flight gap is not checked here: a limb that meets the wall edge is lifted onto it over a few substeps)
    }
  }
  const rock = (x, z) => (z > 0.7 ? Infinity : 0); // sim.heightAt gives Infinity for solid rock: also a wall
  assert.ok(drop(WALK_A, { ground: rock, part: 'head', dir: [0, 0, 1], speed: 2, seed: 2 }).b.pos('Hips')[2] < 0.75);
  const roof = (x, z) => (x < 0.3 ? 1 : 0); // standing on a 1 m high roof, the edge half a metre away, shot toward the edge
  const { b, log } = drop(WALK_A, { ground: roof, anchor: { x: 0, y: 1, z: 0 }, part: 'chest', dir: [1, 0, 0], speed: 2, seed: 4 });
  assert.ok(!log.nan && log.tether <= 0.7 + 1e-6);
  assert.ok(b.pos('Hips')[1] < 1.35, 'the pelvis did not get thrown onto something higher than the roof');
  for (let i = 0; i < R.length; i++) assert.ok(b.x[i * 3 + 1] - R[i] >= roof(b.x[i * 3], b.x[i * 3 + 2]) - 0.03, `${JOINTS[i][0]} is below the floor`);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The adapter, on the real skeleton: needs three and the prepared FBX (both in the repo).
const FBX = new URL('../assets/models/game/zombie.fbx', import.meta.url);
test('adapter: the first frame is the pose the mixer froze, the skin never tears, anchors come from the skinned skeleton', { skip: !existsSync(FBX) }, async () => {
  const THREE = await import('three'), { FBXLoader } = await import('three/addons/loaders/FBXLoader.js'), { clone } = await import('three/addons/utils/SkeletonUtils.js');
  const warn = console.warn; console.warn = () => {}; // the loader complains about >4 skin weights per vertex
  const buf = readFileSync(FBX), src = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), ''); console.warn = warn;
  const inst = clone(src), mixer = new THREE.AnimationMixer(inst);
  mixer.clipAction(src.animations[0]).play(); mixer.setTime(1.3);
  const root = new THREE.Group(), scaled = new THREE.Group(); // like models.js: root > scaled > inst, the root placed and turned by the sim
  scaled.scale.setScalar(0.0101); scaled.add(inst); root.add(scaled); root.position.set(3, 0.5, -2); root.rotation.y = 1; root.updateMatrixWorld(true);
  const bones = []; inst.traverse((o) => o.isBone && bones.push(o));
  const snap = () => bones.map((b) => [b.getWorldPosition(new THREE.Vector3()), b.getWorldQuaternion(new THREE.Quaternion())]);
  const before = snap();

  const rag = createRagdoll({ THREE, model: inst, ground: () => 0.5, anchor: { x: 3, y: 0.5, z: -2 }, impulse: { dir: [0.3, 0, -1], part: 'head', speed: 1 }, seed: 6 });
  assert.ok(rag, 'a Mixamo rig is accepted');
  rag.update(0); root.updateMatrixWorld(true); // poses the bones from the initial particles without stepping
  const first = snap(); let worstPos = 0, worstRot = 1;
  first.forEach(([p, q], i) => { worstPos = Math.max(worstPos, p.distanceTo(before[i][0])); worstRot = Math.min(worstRot, Math.abs(q.dot(before[i][1]))); });
  assert.ok(worstPos < 1e-4, `bones moved ${worstPos} m on the first frame`);
  assert.ok(worstRot > 0.9999, `bones turned on the first frame (dot ${worstRot})`);

  const skins = []; inst.traverse((o) => o.isSkinnedMesh && skins.push(o));
  const seg = () => BONES.map(([a, c]) => [b0(a), b0(c)]);
  const body = rag.body, b0 = (n) => new THREE.Vector3(body.x[body.index[n] * 3], body.x[body.index[n] * 3 + 1], body.x[body.index[n] * 3 + 2]);
  const gap = (v, segs) => Math.min(...segs.map(([a, c]) => { const t = THREE.MathUtils.clamp(v.clone().sub(a).dot(c.clone().sub(a)) / (c.distanceToSquared(a) || 1), 0, 1); return v.distanceTo(a.clone().lerp(c, t)); }));
  const verts = (segs) => skins.flatMap((m) => { const out = []; for (let i = 0; i < m.geometry.attributes.position.count; i += 97) { const v = new THREE.Vector3(); m.getVertexPosition(i, v); out.push(gap(v.applyMatrix4(m.matrixWorld), segs)); } return out; });
  const d0 = verts(seg());

  for (let k = 0; k < 600 && !rag.frozen; k++) { rag.update(1 / 120); } // the whole fall
  assert.ok(rag.frozen, 'frozen');
  root.updateMatrixWorld(true);
  const d1 = verts(seg());
  let torn = 0; d1.forEach((d, i) => { torn = Math.max(torn, d - d0[i]); });
  assert.ok(torn < 0.12, `a skin vertex ended ${torn.toFixed(3)} m farther from its bone than it started: torn`);
  for (const [p, q] of snap()) assert.ok(Number.isFinite(p.x + p.y + p.z + q.x + q.w), 'finite bones');
  // the skeleton follows the particles: every driven joint's bone is where its particle is
  for (const j of Object.keys(rag.bone)) assert.ok(rag.bone[j].getWorldPosition(new THREE.Vector3()).distanceTo(b0(j)) < 0.06, `${j} bone is away from its particle`);
  assert.ok(rag.bone.Hips.getWorldPosition(new THREE.Vector3()).y > 0.5 + 0.05, 'the pelvis lies on the floor, not under it');

  const real = new Set(skinnedBones(inst)), a = findAnchors(inst);
  assert.ok(real.size >= 50, 'the real skinned skeleton');
  for (const part of ['head', 'chest', 'hips']) assert.ok(real.has(a[part]), `${part} anchor is a skinned bone`);
  assert.match(a.head.name, /head$/i); assert.match(a.chest.name, /spine[12]$/i); assert.match(a.hips.name, /hips$/i);
  assert.equal(findAnchors(new THREE.Group()).head.type, 'Group', 'no skin: falls back to the model');
  assert.equal(createRagdoll({ THREE, model: new THREE.Group(), ground: flat, anchor: { x: 0, y: 0, z: 0 } }), null, 'a rig it does not know: null, the caller keeps its fallback');
  rag.dispose(); rag.update(1); // harmless after dispose
});
