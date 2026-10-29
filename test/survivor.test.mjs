// Tests for src/survivor.js: the auto-skinned, procedurally animated survivor. Plain node:test, no browser: the real FBX is parsed in Node.
// Weights (pure) are checked on the real vertices; the pose gate skins the real meshes on the CPU and compares every triangle edge with rest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { BONES, BONE_INDEX, CAPS, MESHES, ARMS, ARM_REST, SWING_TIME, computeWeights, pose, strideLength, createSurvivorFigure } from '../src/survivor.js';

const FBX = new URL('../assets/models/game/survivor.fbx', import.meta.url);
const skip = fs.existsSync(FBX) ? false : 'assets/models/game/survivor.fbx not present';
const TAU = Math.PI * 2;

let modelP = null;
const model = () => modelP || (modelP = (async () => {
  globalThis.document ??= { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, set src(v) {}, style: {} }) }; // FBXLoader builds image elements for textures we never use
  const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
  const buf = fs.readFileSync(FBX), warn = console.warn;
  console.warn = () => {}; // the loader complains about the Maya materials
  let root; try { root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), ''); } finally { console.warn = warn; }
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3());
  let tris = 0; root.traverse((o) => { if (o.isMesh) tris += o.geometry.attributes.position.count / 3; });
  return { root, entry: { role: 'player', scene: root, clips: [], scale: 1.82 / size.y, min: box.min, center: box.getCenter(new THREE.Vector3()), tris } }; // what models.js prepare() builds
})());
const positions = async (name) => (await model()).root.getObjectByName(name).geometry.attributes.position.array;
const cache = {};
const weightsOf = async (name) => cache[name] || (cache[name] = computeWeights(await positions(name), name));
const swap = (n) => n.replace(/L$/, '#').replace(/R$/, 'L').replace(/#$/, 'R'); // thighL <-> thighR
const asMap = (W, i) => { const m = {}; for (let k = 0; k < 4; k++) if (W.weight[4 * i + k] > 0) m[BONES[W.index[4 * i + k]].name] = (m[BONES[W.index[4 * i + k]].name] || 0) + W.weight[4 * i + k]; return m; };
const at = (name, pts) => { const W = computeWeights(new Float32Array(pts.flat()), name); return pts.map((_, i) => asMap(W, i)); };

// ---------- weights ----------
test('weights: normalised, finite, non-negative, at most 4 distinct valid bones per vertex', { skip }, async () => {
  for (const name of MESHES) {
    const W = await weightsOf(name), n = W.weight.length / 4;
    assert.equal(n, (await positions(name)).length / 3);
    for (let i = 0; i < n; i++) {
      let sum = 0; const seen = new Set();
      for (let k = 0; k < 4; k++) {
        const w = W.weight[4 * i + k];
        assert.ok(Number.isFinite(w) && w >= 0, `${name} vertex ${i}: weight ${w}`);
        if (w > 0) { assert.ok(W.index[4 * i + k] < BONES.length, `${name} ${i}: bone index`); assert.ok(!seen.has(W.index[4 * i + k]), `${name} ${i}: bone used twice`); seen.add(W.index[4 * i + k]); }
        sum += w;
      }
      assert.ok(Math.abs(sum - 1) < 1e-5, `${name} vertex ${i}: weights sum to ${sum}`);
    }
  }
});

test('weights: left and right are mirror images', { skip }, async () => {
  for (const name of MESHES) {
    const P = await positions(name), pts = [], mir = [];
    for (let i = 0; i < P.length; i += 15) if (Math.abs(P[i]) > 1e-3) { pts.push(P[i], P[i + 1], P[i + 2]); mir.push(-P[i], P[i + 1], P[i + 2]); }
    const A = computeWeights(new Float32Array(pts), name), B = computeWeights(new Float32Array(mir), name);
    for (let i = 0; i < pts.length / 3; i++) {
      const a = asMap(A, i), b = asMap(B, i);
      assert.deepEqual(Object.keys(a).sort(), Object.keys(b).map(swap).sort(), `${name} sample ${i}: bone sets`);
      for (const [bone, w] of Object.entries(a)) assert.ok(Math.abs(w - b[swap(bone)]) < 1e-6, `${name} sample ${i} ${bone}`);
    }
    assert.ok(pts.length > 300, 'enough samples');
  }
});

test('weights: every mesh only sees its own bones, and limbs only their own side', { skip }, async () => {
  const sided = (names, side) => names.map((n) => n + side);
  const allowed = (name, side) => new Set({
    Head: ['head', 'neck'],
    Legs: ['hips', ...sided(['thigh', 'shin', 'foot'], side)],
    Body: ['hips', 'spine', 'chest', ...sided(['shoulder', 'upperArm', 'forearm', 'hand'], side)],
  }[name]);
  for (const name of MESHES) {
    const W = await weightsOf(name), P = await positions(name), ok = { L: allowed(name, 'L'), R: allowed(name, 'R') }, used = new Set();
    for (let i = 0; i < P.length / 3; i++) {
      const side = P[3 * i] < 0 ? 'R' : 'L';
      for (const bone of Object.keys(asMap(W, i))) { assert.ok(ok[side].has(bone), `${name} vertex ${i} at x=${P[3 * i].toFixed(1)} is weighted to ${bone}`); used.add(bone); }
    }
    assert.equal(used.size, { Head: 2, Legs: 7, Body: 11 }[name], `${name} uses ${[...used]}`); // and no bone of the table is dead weight
  }
});

test('weights: landmark points belong to the obvious bone', () => {
  const [top, pack] = at('Head', [[0, 178, 1], [0, 125, -22]]);
  assert.ok(top.head > 0.95, 'top of the hood follows the head');
  assert.ok(pack.neck > 0.95, 'the backpack (part of the Head mesh) rides on the neck, not the head');
  const [toe, shaft, thigh, seamL, seamR] = at('Legs', [[14, 0, 15], [14, 30, -2], [-12, 70, 4], [0.2, 75, 5], [-0.2, 75, 5]]);
  assert.ok(toe.footL > 0.9 && shaft.shinL > 0.9, 'boot sole -> foot, boot shaft -> shin');
  assert.ok(thigh.thighR > 0.2 && !Object.keys(thigh).some((b) => b.endsWith('L')), 'right thigh sees right bones only');
  assert.ok(seamL.hips > 0.99 && seamR.hips > 0.99, 'the crotch seam belongs to the pelvis, so it cannot web when the legs part');
  const [handL, handR, chest, sleeve, skirt] = at('Body', [[53, 88, 24], [-53, 88, 24], [0, 125, 10], [-34, 125, 0], [0, 80, 20]]);
  assert.ok(handL.handL > 0.95 && handR.handR > 0.95, 'gloves -> hands');
  assert.ok(chest.chest > 0.8 && Object.keys(chest).every((b) => !/Arm|hand/.test(b)), 'the chest is the chest');
  assert.ok(sleeve.upperArmR > 0.9, 'right sleeve -> right upper arm');
  assert.ok(skirt.hips > 0.8, 'the coat skirt follows the pelvis');
});

test('weights: degenerate input never produces NaN', () => {
  for (const name of MESHES) {
    const W = computeWeights(new Float32Array([0, 0, 0, 0, 1e5, 0, 1e5, 0, 1e5, -1e5, 5, 5, 0, 0, 1e-9]), name);
    let sum = 0; for (let i = 0; i < 20; i++) { assert.ok(Number.isFinite(W.weight[i])); if (i < 4) sum += W.weight[i]; }
    assert.ok(Math.abs(sum - 1) < 1e-5);
  }
  assert.throws(() => computeWeights(new Float32Array(3), 'Torso'), /no weight spec/);
});

// ---------- skeleton and animation ----------
test('skeleton: 19 bones, parents first, every capsule names a real bone', () => {
  assert.equal(BONES.length, 19);
  BONES.forEach((b, i) => { assert.equal(BONE_INDEX[b.name], i); if (b.parent) assert.ok(BONE_INDEX[b.parent] < i, `${b.name}: parent before child`); else assert.equal(b.name, 'hips'); });
  for (const name of MESHES) for (const c of CAPS[name].caps) assert.ok(BONE_INDEX[c[0] + (/^(shoulder|upperArm|forearm|hand|thigh|shin|foot)$/.test(c[0]) ? 'L' : '')] !== undefined, `${name}: ${c[0]}`);
});

test('pose: pure, deterministic, and at rest when standing still', () => {
  const S = { ph: 1.3, sp: 2.2, cr: 0.4, at: 0, t: 3.7, cm: 102 };
  assert.deepEqual(pose(S), pose({ ...S }));
  const idle = pose({ ph: 0, sp: 0, cr: 0, at: 0, t: 0, cm: 102 });
  for (const b of ['thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR']) for (const a of idle.rot[b]) assert.ok(Math.abs(a) < 0.05, `${b} straight when idle`);
  for (const v of Object.values(pose(S).rot).flat().concat(pose(S).pos)) assert.ok(Number.isFinite(v));
  assert.ok(strideLength(4.2) > strideLength(2.2) && strideLength(2.2, 1) < strideLength(2.2), 'longer strides when faster, shorter when crouched');
});

const figureOf = async () => createSurvivorFigure((await model()).entry, { height: 1.82 });
const settle = (fig, p, n = 120) => { for (let i = 0; i < n; i++) fig.update(1 / 60, p); };

test('figure: same interface as models.js createFigure, with the bones as anchors', { skip }, async () => {
  const fig = await figureOf();
  assert.ok(fig.root instanceof THREE.Group && fig.head instanceof THREE.Object3D);
  assert.equal(typeof fig.update, 'function'); assert.equal(typeof fig.dispose, 'function');
  assert.equal(fig.anchor('head').name, 'head'); assert.equal(fig.anchor('chest').name, 'chest'); assert.equal(fig.anchor('hips').name, 'hips');
  assert.ok(fig.anchor('head').isBone && fig.anchor('nonsense') !== undefined);
  assert.equal(fig.skeleton.bones.length, 19);
  assert.deepEqual(fig.meshes.map((m) => m.name).sort(), ['Body', 'Head', 'Legs']);
  assert.ok(fig.meshes.every((m) => m.isSkinnedMesh && m.geometry.attributes.skinIndex.count === m.geometry.attributes.position.count));
  assert.equal(fig.meshes.reduce((n, m) => n + m.geometry.attributes.position.count, 0) / 3, 47099);
  fig.update(NaN, { speed: NaN }); fig.update(0.016, undefined); fig.update(10, { speed: 3 }); // junk in, no crash
  for (const b of Object.values(fig.bones)) assert.ok([b.rotation.x, b.rotation.y, b.rotation.z, b.position.x, b.position.y, b.position.z].every(Number.isFinite));
  fig.dispose();
});

test('figure: fallback, it throws instead of returning a broken rig', { skip }, async () => {
  const { root, entry } = await model();
  const part = (n) => root.getObjectByName(n).clone();
  for (const missing of MESHES) {
    const scene = new THREE.Group(); for (const n of MESHES) if (n !== missing) scene.add(part(n));
    assert.throws(() => createSurvivorFigure({ ...entry, scene }), new RegExp(missing), `without ${missing}`);
  }
  assert.throws(() => createSurvivorFigure({ ...entry, scene: new THREE.Group() }), /missing/);
  assert.throws(() => createSurvivorFigure(null), /missing/);
  const moved = new THREE.Group(); for (const n of MESHES) moved.add(part(n)); moved.scale.setScalar(0.01); // a model in metres, not cm
  assert.throws(() => createSurvivorFigure({ ...entry, scene: moved }), /transform|proportions/);
});

test('figure: deterministic, the same inputs give the same pose', { skip }, async () => {
  const run = async () => { const f = await figureOf(); for (let i = 0; i < 200; i++) f.update(1 / 60, { speed: i < 100 ? 2.2 : 4.2, crouch: i > 150 }); return Object.values(f.bones).map((b) => [b.position.toArray(), b.rotation.toArray().slice(0, 3)]); };
  assert.deepEqual(await run(), await run());
});

test('figure: the gait phase follows the distance travelled, not the time', { skip }, async () => {
  const a = await figureOf(), b = await figureOf(), c = await figureOf();
  settle(a, { speed: 2.2 }, 0); settle(b, { speed: 2.2 }, 0); settle(c, { speed: 2.2 }, 0);
  for (let i = 0; i < 120; i++) a.update(1 / 60, { speed: 2.2 }); // 2 s
  for (let i = 0; i < 60; i++) b.update(1 / 30, { speed: 2.2 }); // the same 2 s at another frame rate
  assert.ok(Math.abs(a.state.ph - b.state.ph) < 1e-6, 'frame rate does not change the phase');
  const expect = (TAU * 2.2 * 2 / strideLength(2.2)) % TAU;
  assert.ok(Math.abs(a.state.ph - expect) < 1e-6, `phase ${a.state.ph} vs ${expect}`);
  for (let i = 0; i < 100; i++) c.update(1 / 60, { speed: 4.4 }); // twice as fast for 100 frames, but the stride is longer: still distance / stride
  assert.ok(Math.abs(c.state.ph - (TAU * 4.4 * (100 / 60) / strideLength(4.4)) % TAU) < 1e-6);
  const s = await figureOf(); for (let i = 0; i < 600; i++) s.update(1 / 60, { speed: 0 });
  assert.equal(s.state.ph, 0, 'standing still never steps');
});

test('figure: the lowest sole touches the ground in every pose', { skip }, async () => {
  const fig = await figureOf(), legs = fig.meshes.find((m) => m.name === 'Legs'), lp = legs.geometry.attributes.position, v = new THREE.Vector3();
  const lowest = () => { fig.root.updateMatrixWorld(true); let lo = Infinity; for (let i = 0; i < lp.count; i++) { legs.applyBoneTransform(i, v.fromBufferAttribute(lp, i)); lo = Math.min(lo, v.applyMatrix4(legs.matrixWorld).y); } return lo; };
  for (const p of [{ speed: 0 }, { speed: 2.2 }, { speed: 4.2 }, { speed: 0, crouch: true }, { speed: 1.2, crouch: true }]) {
    settle(fig, p);
    for (let ph = 0; ph < TAU; ph += 0.9) { fig.state.ph = ph; fig.update(0, p); const lo = lowest(); assert.ok(Math.abs(lo) < 0.004, `${JSON.stringify(p)} phase ${ph.toFixed(1)}: lowest point at ${(lo * 100).toFixed(2)} cm`); }
  }
});

test('figure: planted feet do not skate (distance driven stride)', { skip }, async (t) => {
  const fig = await figureOf(), legs = fig.meshes.find((m) => m.name === 'Legs'), lp = legs.geometry.attributes.position, v = new THREE.Vector3();
  const near = (x, y, z) => { let b = 0, bd = Infinity; for (let i = 0; i < lp.count; i++) { const d = (lp.getX(i) - x) ** 2 + (lp.getY(i) - y) ** 2 + (lp.getZ(i) - z) ** 2; if (d < bd) { bd = d; b = i; } } return b; };
  const sole = [near(14, -2.8, 8), near(-14, -2.8, 8), near(14, -2, -6), near(-14, -2, -6)]; // ball and heel of each foot
  for (const [speed, limit] of [[2.2, 0.45], [4.2, 1.0]]) {
    settle(fig, { speed });
    const dt = 1 / 120, prev = [], slips = []; let z = 0;
    for (let f = 0; f < 480; f++) {
      fig.update(dt, { speed }); z += speed * dt; fig.root.updateMatrixWorld(true);
      sole.forEach((i, k) => { legs.applyBoneTransform(i, v.fromBufferAttribute(lp, i)); v.applyMatrix4(legs.matrixWorld); if (prev[k] && v.y < 0.012 && prev[k].y < 0.012) slips.push(Math.abs(v.z + z - prev[k].z) / dt); prev[k] = { y: v.y, z: v.z + z }; });
    }
    slips.sort((a, b) => a - b);
    const med = slips[slips.length >> 1];
    t.diagnostic(`speed ${speed} m/s: planted sole slip median ${med.toFixed(2)} m/s, p90 ${slips[Math.floor(slips.length * 0.9)].toFixed(2)} (${slips.length} samples)`);
    assert.ok(slips.length > 100 && med < limit, `speed ${speed}: median slip ${med} m/s`);
  }
});

test('pose: the arms hang rather than stand out in the model\'s A-pose, and swing against the legs', () => {
  const idle = pose({ ph: 0, sp: 0, cr: 0, at: 0, t: 0, cm: 102 }), walk = (ph) => pose({ ph, sp: 2.2, cr: 0, at: 0, t: 0, cm: 102 });
  assert.ok(Math.abs(idle.rot.upperArmL[2] + ARMS.down - ARMS.shoulder) < 0.03 && Math.abs(idle.rot.shoulderL[2] + ARMS.shoulder) < 0.03 && Math.abs(idle.rot.upperArmR[2] - ARMS.down + ARMS.shoulder) < 0.03, 'both arms are brought in by ARMS.down, the clavicle taking ARMS.shoulder of it');
  assert.ok(ARMS.down > 0.15 && ARMS.down < ARM_REST, `in by ${ARMS.down} rad of the ${ARM_REST.toFixed(2)} rad the model holds them out: closer to the body, never through it`);
  const [a, b] = [walk(Math.PI / 2), walk(3 * Math.PI / 2)]; // the quarter points of the cycle, where the swing peaks
  assert.ok(a.rot.upperArmL[0] * b.rot.upperArmL[0] < 0, 'the arm swings forward then back through the cycle');
  assert.ok(a.rot.upperArmL[0] * a.rot.thighL[0] < 0, 'the left arm swings against the left leg');
});

test('pose: overlapping action: the forearm bends after the upper arm swings forward and the wrist flicks after the forearm; the arm hangs nearly straight', () => {
  const N = 128, S = (i) => ({ ph: (i / N) * TAU, sp: 2.2, cr: 0, at: 0, t: 0, cm: 102 }), at = (f) => Array.from({ length: N }, (_, i) => f(pose(S(i)).rot));
  const peak = (xs) => xs.indexOf(Math.max(...xs)), lagOf = (a, b) => ((peak(b) - peak(a)) % N + N) % N / N * TAU; // how many radians of the gait b peaks after a
  const swing = at((r) => -r.upperArmR[0]), elbow = at((r) => -r.forearmR[0]), wrist = at((r) => -r.handR[0]);
  assert.ok(lagOf(swing, elbow) > 0.3 && lagOf(swing, elbow) < 1.2, `the elbow bend peaks ${lagOf(swing, elbow).toFixed(2)} rad after the arm is furthest forward`);
  assert.ok(lagOf(elbow, wrist) > 0.3 && lagOf(elbow, wrist) < 1.4, `and the wrist ${lagOf(elbow, wrist).toFixed(2)} rad after that`);
  assert.ok(Math.min(...elbow) < -0.2, 'at the back of the swing the elbow is extended (the model\'s rest forearm is bent 0.68 rad, so the arm hangs nearly straight)');
});

test('figure: walking physics: a push leans the torso and trails the arms then settles; the head follows the look; junk input stays finite', { skip }, async () => {
  const fig = await figureOf();
  settle(fig, { speed: 0 });
  for (let i = 0; i < 8; i++) fig.update(1 / 60, { speed: i * 0.4 }); // a sudden push to 2.8 m/s
  assert.ok(fig.state.lean > 0.02 && fig.state.arm > 0.02, `leans forward (${fig.state.lean.toFixed(3)}) and the arms trail (${fig.state.arm.toFixed(3)})`);
  settle(fig, { speed: 2.8 }, 240);
  assert.ok(Math.abs(fig.state.lean) < 0.01 && Math.abs(fig.state.arm) < 0.01, 'at a steady speed the springs settle');
  settle(fig, { speed: 0, look: 1 }, 120);
  assert.ok(fig.bones.neck.rotation.y > 0.4 && fig.bones.head.rotation.y > 0.4, 'the head turns to where the camera looks');
  settle(fig, { speed: 0, look: 99, turn: NaN, grade: Infinity }, 30);
  for (const b of Object.values(fig.bones)) assert.ok([b.rotation.x, b.rotation.y, b.rotation.z, b.position.x, b.position.y, b.position.z].every(Number.isFinite));
  assert.ok(Math.abs(fig.bones.neck.rotation.y) < 0.8, 'an extreme look is clamped');
});

// ---------- the pose gate: no triangle edge may stretch or collapse badly against the rest pose ----------
test('pose gate: edge length vs rest in the extreme idle, walk, run and crouch poses, and over time', { skip, timeout: 120000 }, async (t) => {
  const fig = await figureOf(), v = new THREE.Vector3();
  const rest = fig.meshes.map((m) => new Float32Array(m.geometry.attributes.position.array));
  // The armpit (a vertex that mixes the upper arm and the chest) is gated on its own: hanging arms that swing fold the coat there, and that is the one place a
  // linear-blend rig cannot keep the length; the rest of the body keeps tight limits. armpit[mi][vertex] = 1 for those vertices.
  const arm = [BONE_INDEX.upperArmL, BONE_INDEX.upperArmR], chest = BONE_INDEX.chest;
  const armpit = fig.meshes.map((m) => { const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight, f = new Uint8Array(si.count); for (let i = 0; i < si.count; i++) { let a = 0, c = 0; for (let k = 0; k < 4; k++) { const b = si.getComponent(i, k), w = sw.getComponent(i, k); if (arm.includes(b)) a += w; else if (b === chest) c += w; } f[i] = a > 0.15 && c > 0.15 ? 1 : 0; } return f; });
  const phases = Array.from({ length: 10 }, (_, i) => (i * TAU) / 10);
  // edge length now / at rest, for every triangle edge of the posed figure: the extremes of the body and of the armpit
  const measure = (ext) => {
    fig.root.updateMatrixWorld(true);
    fig.meshes.forEach((m, mi) => {
      const pos = m.geometry.attributes.position, n = pos.count, out = new Float32Array(n * 3), r = rest[mi];
      for (let i = 0; i < n; i++) { m.applyBoneTransform(i, v.fromBufferAttribute(pos, i)); out[3 * i] = v.x; out[3 * i + 1] = v.y; out[3 * i + 2] = v.z; }
      for (let a = 0; a < n; a += 3) for (let e = 0; e < 3; e++) {
        const i = a + e, j = a + (e + 1) % 3, l0 = Math.hypot(r[3 * i] - r[3 * j], r[3 * i + 1] - r[3 * j + 1], r[3 * i + 2] - r[3 * j + 2]);
        if (l0 < 1e-4) continue;
        const q = Math.hypot(out[3 * i] - out[3 * j], out[3 * i + 1] - out[3 * j + 1], out[3 * i + 2] - out[3 * j + 2]) / l0, r2 = armpit[mi][i] || armpit[mi][j] ? ext.armpit : ext.body;
        if (q > r2.max) r2.max = q; if (q < r2.min) r2.min = q;
      }
    });
  };
  const fresh = () => ({ body: { max: 0, min: Infinity }, armpit: { max: 0, min: Infinity } });
  const gate = (p, list) => { settle(fig, p); const ext = fresh(); for (const ph of list) { fig.state.ph = ph; fig.update(0, p); measure(ext); } return ext; };
  // Measured (dev/survivor.html checked by eye from the front, side and three-quarter: no tearing, the coat tucks in): body / armpit. Limits sit just outside.
  // The crouch (CROUCH, head top 1.47 m) creases the hip and knee; the coat covers it. Tighten them if the weights improve.
  const cases = [
    ['idle', { speed: 0 }, [0], [1.4, 0.6], [1.4, 0.55]], ['walk', { speed: 2.2 }, phases, [1.7, 0.45], [1.85, 0.27]], ['run', { speed: 4.2 }, phases, [2.0, 0.4], [2.1, 0.22]],
    ['crouch', { speed: 0, crouch: true }, [0], [2.6, 0.08], [2.6, 0.08]], ['crouch-walk', { speed: 1.2, crouch: true }, phases, [2.8, 0.05], [2.8, 0.05]],
  ];
  for (const [label, p, list, [bhi, blo], [ahi, alo]] of cases) {
    const { body, armpit: ap } = gate(p, list);
    t.diagnostic(`${label.padEnd(11)} body ${body.max.toFixed(2)}x / ${body.min.toFixed(2)}x   armpit ${ap.max.toFixed(2)}x / ${ap.min.toFixed(2)}x`);
    assert.ok(body.max <= bhi && body.min >= blo, `${label}: the body went ${body.min.toFixed(2)}x to ${body.max.toFixed(2)}x`);
    assert.ok(ap.max <= ahi && ap.min >= alo, `${label}: the armpit went ${ap.min.toFixed(2)}x to ${ap.max.toFixed(2)}x`);
  }
  // The machete stab, at 11 points through the swing, standing and walking
  for (const [label, speed, hi, lo, ahi, alo] of [['stab standing', 0, 2.0, 0.38, 2.5, 0.18], ['stab walking', 2.2, 2.0, 0.37, 2.5, 0.17]]) {
    const ext = fresh(); settle(fig, { speed });
    for (let k = 0; k <= 10; k++) { fig.update(0, { speed, swing: k / 10 }); measure(ext); }
    t.diagnostic(`${label.padEnd(13)} body ${ext.body.max.toFixed(2)}x / ${ext.body.min.toFixed(2)}x   armpit ${ext.armpit.max.toFixed(2)}x / ${ext.armpit.min.toFixed(2)}x`);
    assert.ok(ext.body.max <= hi && ext.body.min >= lo, `${label}: the body went ${ext.body.min.toFixed(2)}x to ${ext.body.max.toFixed(2)}x`);
    assert.ok(ext.armpit.max <= ahi && ext.armpit.min >= alo, `${label}: the armpit went ${ext.armpit.min.toFixed(2)}x to ${ext.armpit.max.toFixed(2)}x`);
  }
  // In motion, with the real time-stepped update: a walk, a run, and a stop from the run (the springs that lean and trail the body play out)
  const moving = fresh(); settle(fig, { speed: 0 });
  for (let f = 0; f < 120; f++) { fig.update(1 / 60, { speed: 2.2 }); if (f % 4 === 0) measure(moving); }
  for (let f = 0; f < 120; f++) { fig.update(1 / 60, { speed: 4.2 }); if (f % 4 === 0) measure(moving); }
  for (let f = 0; f < 90; f++) { fig.update(1 / 60, { speed: 0 }); if (f % 3 === 0) measure(moving); }
  t.diagnostic(`in motion    body ${moving.body.max.toFixed(2)}x / ${moving.body.min.toFixed(2)}x   armpit ${moving.armpit.max.toFixed(2)}x / ${moving.armpit.min.toFixed(2)}x`);
  assert.ok(moving.body.max <= 2.0 && moving.body.min >= 0.38, `in motion the body went ${moving.body.min.toFixed(2)}x to ${moving.body.max.toFixed(2)}x`);
  assert.ok(moving.armpit.max <= 2.1 && moving.armpit.min >= 0.22, `in motion the armpit went ${moving.armpit.min.toFixed(2)}x to ${moving.armpit.max.toFixed(2)}x`);
});

test('stab: the knife hand reaches chest height within 100 ms, moves fastest at contact, the rear foot stays planted, and the sole stays on the ground', { skip }, async () => {
  const fig = await figureOf(), legs = fig.meshes.find((m) => m.name === 'Legs'), lp = legs.geometry.attributes.position, v = new THREE.Vector3(), hp = new THREE.Vector3();
  const near = (x, y, z) => { let b = 0, bd = Infinity; for (let i = 0; i < lp.count; i++) { const d = (lp.getX(i) - x) ** 2 + (lp.getY(i) - y) ** 2 + (lp.getZ(i) - z) ** 2; if (d < bd) { bd = d; b = i; } } return b; };
  const ballL = near(14, -2.8, 8), at = (i) => { legs.applyBoneTransform(i, v.fromBufferAttribute(lp, i)); return v.applyMatrix4(legs.matrixWorld).clone(); };
  const lowest = () => { let lo = Infinity; for (let i = 0; i < lp.count; i += 3) { legs.applyBoneTransform(i, v.fromBufferAttribute(lp, i)); lo = Math.min(lo, v.applyMatrix4(legs.matrixWorld).y); } return lo; };
  settle(fig, { speed: 0 });
  const rows = [];
  for (let k = 0; k <= 50; k++) { const u = k / 50; fig.update(0, { speed: 0, swing: u }); fig.root.updateMatrixWorld(true); fig.bones.handR.getWorldPosition(hp); rows.push({ u, z: hp.z, y: hp.y, foot: at(ballL).z, low: lowest() }); }
  const z0 = rows[0].z, zmax = Math.max(...rows.map((r) => r.z)), contact = rows.find((r) => r.z >= z0 + 0.95 * (zmax - z0));
  assert.ok(zmax - z0 > 0.55, `the hand travels ${(zmax - z0).toFixed(2)} m from the guard to full reach`);
  assert.ok(contact.u * SWING_TIME <= 0.1, `contact at ${(contact.u * SWING_TIME * 1000).toFixed(0)} ms`);
  const top = rows.find((r) => r.z === zmax); assert.ok(top.y > 0.9 && top.y < 1.5, `the hand is at ${top.y.toFixed(2)} m at contact: chest to stomach height`);
  const speed = (k) => Math.abs(rows[k + 1].z - rows[k].z) / (0.02 * SWING_TIME); // m/s along the thrust
  const peak = Math.max(...rows.slice(0, 20).map((r, k) => speed(k)));
  assert.ok(peak > 4 && speed(Math.round(contact.u * 50) - 1) > 0.7 * peak, `the hand is at ${speed(Math.round(contact.u * 50) - 1).toFixed(1)} m/s just before contact, near its peak (${peak.toFixed(1)}), not easing to a stop`);
  assert.ok(speed(13) < 0.1 * peak, 'and it stops there for the impact');
  const drift = Math.max(...rows.map((r) => Math.abs(r.foot - rows[0].foot)));
  assert.ok(drift < 0.03, `the rear foot drifts ${(drift * 100).toFixed(1)} cm during the lunge`);
  assert.ok(rows.every((r) => Math.abs(r.low) < 0.004), `the lowest sole stays on the ground (worst ${Math.max(...rows.map((r) => Math.abs(r.low))) * 100} cm off)`);
});

test('figure: the crouch is lower, a dead survivor tips over', { skip }, async () => {
  const top = (fig) => { fig.root.updateMatrixWorld(true); const h = fig.meshes.find((m) => m.name === 'Head'), v = new THREE.Vector3(); let hi = -Infinity; for (let i = 0; i < h.geometry.attributes.position.count; i += 7) { h.applyBoneTransform(i, v.fromBufferAttribute(h.geometry.attributes.position, i)); hi = Math.max(hi, v.applyMatrix4(h.matrixWorld).y); } return hi; };
  const a = await figureOf(), b = await figureOf(), d = await figureOf();
  settle(a, { speed: 0 }); settle(b, { speed: 0, crouch: true });
  assert.ok(Math.abs(top(a) - 1.82) < 0.03, `standing head top ${top(a)}`);
  assert.ok(top(b) < top(a) - 0.1, `crouched head top ${top(b)}`);
  for (let i = 0; i < 90; i++) d.update(1 / 60, { speed: 2, state: 'dead' });
  assert.ok(Math.abs(d.root.children[0].rotation.x + Math.PI / 2) < 1e-6, 'lying on its back');
  assert.equal(d.state.ph, 0, 'a corpse does not walk');
});
