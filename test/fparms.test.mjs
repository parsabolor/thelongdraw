// Tests for src/fparms.js: the survivor's first-person arms. The real FBX is parsed in Node (no textures), like test/survivor.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { createArms, curlGlove, KNUCKLE_CM, FINGER } from '../src/fparms.js';
import { JOINTS, BONE_INDEX } from '../src/survivor.js';
const BONE_INDEX_OF = (name) => BONE_INDEX[name];

const FBX = new URL('../assets/models/game/survivor.fbx', import.meta.url);
const skip = fs.existsSync(FBX) ? false : 'assets/models/game/survivor.fbx not present';

let modelP = null;
const model = () => modelP || (modelP = (async () => {
  globalThis.document ??= { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, set src(v) {}, style: {} }) };
  const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
  const buf = fs.readFileSync(FBX), warn = console.warn; console.warn = () => {};
  let root; try { root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), ''); } finally { console.warn = warn; }
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3());
  return { root, entry: { role: 'player', scene: root, clips: [], scale: 1.82 / size.y, min: box.min, center: box.getCenter(new THREE.Vector3()), tris: 47099 } };
})());

// a hand target: position, finger direction (+y) and palm normal (+z), in the group's parent space
const target = (parent, pos, fingers, palm) => {
  const o = new THREE.Object3D(), y = new THREE.Vector3(...fingers).normalize(), z = new THREE.Vector3(...palm); z.addScaledVector(y, -z.dot(y)).normalize();
  o.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(y, z), y, z)); o.position.set(...pos); parent.add(o); return o;
};
const rigged = async (opts = { scale: 1.1, offset: [0, 0, -0.11] } /* what models.js createArms uses */) => {
  const { entry } = await model(), arms = createArms(entry, opts), cam = new THREE.PerspectiveCamera(); cam.add(arms.group);
  return { arms, cam, left: target(cam, [-0.09, -0.05, -0.54], [-0.45, 0.85, -0.25], [0, 0, -1]), right: target(cam, [0.0, -0.13, -0.075], [0, 0.25, -0.97], [-1, 0, 0]) };
};
const wristOf = (cam, arms, side) => { cam.updateMatrixWorld(true); return arms.bones['hand' + side].getWorldPosition(new THREE.Vector3()); };
const finite = (arms) => Object.values(arms.bones).every((b) => [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w].every(Number.isFinite));

test('arms: only sleeve and glove triangles of the Body mesh, sharing its skin weights', { skip }, async () => {
  const { entry } = await model(), arms = createArms(entry), body = entry.scene.getObjectByName('Body');
  const tris = arms.mesh.geometry.index.count / 3, all = body.geometry.attributes.position.count / 3;
  assert.ok(tris > 3000 && tris < 0.5 * all, `${tris} of ${all} triangles: the arms, not the coat`);
  assert.ok(arms.mesh.isSkinnedMesh && arms.mesh.geometry.attributes.skinIndex && arms.mesh.skeleton.bones.length === 19);
  assert.equal(arms.mesh.geometry.attributes.position.count, all * 3, 'the vertex buffer is the survivor\'s own (shared)');
  assert.throws(() => createArms({ scene: new THREE.Group(), scale: 1 }), /Body mesh is missing/);
});

test('arms: the bow hand reaches its target (the wrist a palm-length behind the palm along the fingers), and the arm bones keep their lengths', { skip }, async () => {
  const { arms, cam, left, right } = await rigged();
  arms.update(left, right);
  cam.updateMatrixWorld(true);
  const k = 0.0098 * 1.1, len = (a, b) => Math.hypot(...a.map((v, i) => v - b[i])), L1 = len(JOINTS.forearm, JOINTS.upperArm), L2 = len(JOINTS.hand, JOINTS.forearm); // metres per mesh unit; the bone lengths
  for (const [side, o] of [['L', left], ['R', right]]) {
    const got = wristOf(cam, arms, side), want = o.getWorldPosition(new THREE.Vector3()).addScaledVector(new THREE.Vector3(0, 1, 0).transformDirection(o.matrixWorld), -10 * k);
    if (side === 'L') assert.ok(got.distanceTo(want) < 0.01, `left wrist ${got.toArray().map((v) => v.toFixed(3))} vs ${want.toArray().map((v) => v.toFixed(3))}`); // the draw hand is placed by the draw, not asserted here
    const sh = arms.bones['upperArm' + side].getWorldPosition(new THREE.Vector3()), el = arms.bones['forearm' + side].getWorldPosition(new THREE.Vector3());
    assert.ok(Math.abs(sh.distanceTo(el) - L1 * k) < 0.003, `${side} upper arm keeps its length (${sh.distanceTo(el).toFixed(3)} m)`);
    assert.ok(Math.abs(el.distanceTo(got) - L2 * k) < 0.004, `${side} forearm keeps its length (${el.distanceTo(got).toFixed(3)} m)`);
  }
});

test('arms: an unreachable target straightens the arm toward it; bad positions never leave a NaN behind', { skip }, async () => {
  const { arms, cam, left, right } = await rigged();
  left.position.set(-0.1, -0.05, -3); // 3 m away
  arms.update(left, right);
  const wrist = wristOf(cam, arms, 'L'), sh = arms.bones.upperArmL.getWorldPosition(new THREE.Vector3());
  assert.ok(wrist.z < sh.z - 0.4 && Number.isFinite(wrist.x), 'the arm stretches out toward the target');
  for (const p of [[0, 0, 0], [1e3, -1e3, 1e3]]) { left.position.set(...p); arms.update(left, right); assert.ok(finite(arms), `finite for a target at ${p}`); }
  left.position.set(-0.09, -0.05, -0.54); arms.update(left, right);
  assert.ok(finite(arms) && wristOf(cam, arms, 'L').distanceTo(new THREE.Vector3(-0.09, -0.05, -0.54)) < 0.2, 'back on the grip after the bad frames');
});

test('glove curl: only the fingers past the knuckle line bend, toward the palm; no cuff or forearm vertex moves; edges survive; left and right mirror', { skip }, async () => {
  const { entry } = await model(), body = entry.scene.getObjectByName('Body');
  const withCurl = createArms(entry, { curl: 0.8 }), without = createArms(entry, { curl: 0 }), a = withCurl.mesh.geometry.attributes, b = without.mesh.geometry.attributes, src = body.geometry.attributes.position.array;
  assert.equal(without.curled, 0, 'no curl, no moved vertices');
  assert.ok(without.mesh.geometry.attributes.position.array.every((v, i) => v === src[i]), 'with no curl the positions are the survivor\'s own');
  assert.ok(withCurl.curled > 1000, `${withCurl.curled} glove vertices curled`);
  assert.ok(src.every((v, i) => v === body.geometry.attributes.position.array[i]), 'the survivor\'s Body geometry itself is untouched');
  // where the vertices that moved are: nothing at or before the knuckle line moves, and just past it (the 1 cm ramp) it barely does
  let moved = 0, maxShift = 0, early = 0, ramp = 0; const shift = (v) => Math.hypot(a.position.getX(v) - b.position.getX(v), a.position.getY(v) - b.position.getY(v), a.position.getZ(v) - b.position.getZ(v));
  const f = new THREE.Vector3(...FINGER).normalize(), H = (side) => new THREE.Vector3(JOINTS.hand[0] * side, JOINTS.hand[1], JOINTS.hand[2]);
  for (let v = 0; v < a.position.count; v++) {
    const d = shift(v); if (d < 1e-6) continue; moved++; maxShift = Math.max(maxShift, d);
    const side = b.position.getX(v) > 0 ? 1 : -1, ff = new THREE.Vector3(FINGER[0] * side, FINGER[1], FINGER[2]).normalize(), along = new THREE.Vector3(b.position.getX(v), b.position.getY(v), b.position.getZ(v)).sub(H(side)).dot(ff);
    if (along <= KNUCKLE_CM) early++; else if (along < KNUCKLE_CM + 1) ramp = Math.max(ramp, d);
  }
  assert.equal(moved, withCurl.curled, 'what moved is exactly what curlGlove reported');
  assert.equal(early, 0, 'no vertex at or before the knuckle line moves');
  assert.ok(ramp < 0.6, `in the 1 cm ramp just past the knuckle line the largest move is ${ramp.toFixed(2)} cm (the palm and cuff stay put)`);
  assert.ok(maxShift > 1.5 && maxShift < 6, `the fingertips move ${maxShift.toFixed(1)} cm: a relaxed bend, not a fist`);
  const norm = (v) => Math.hypot(a.normal.getX(v), a.normal.getY(v), a.normal.getZ(v)); let badN = 0; for (let v = 0; v < a.position.count; v += 7) if (shift(v) > 1e-6 && Math.abs(norm(v) - 1) > 0.05) badN++;
  assert.equal(badN, 0, 'bent normals stay unit length');
  // edges between two moved vertices keep their length (a bend, not a tear)
  const idx = withCurl.mesh.geometry.index; let worstEdge = 1;
  for (let t = 0; t < idx.count; t += 3) for (let e = 0; e < 3; e++) { const i = idx.getX(t + e), j = idx.getX(t + (e + 1) % 3); if (shift(i) < 1e-6 || shift(j) < 1e-6) continue; const l0 = Math.hypot(b.position.getX(i) - b.position.getX(j), b.position.getY(i) - b.position.getY(j), b.position.getZ(i) - b.position.getZ(j)), l1 = Math.hypot(a.position.getX(i) - a.position.getX(j), a.position.getY(i) - a.position.getY(j), a.position.getZ(i) - a.position.getZ(j)); if (l0 > 1e-4) worstEdge = Math.min(worstEdge, l1 / l0); }
  assert.ok(worstEdge > 0.5, `no finger edge shrinks below ${worstEdge.toFixed(2)} of its length (the palm-side edges of a bent finger compress; it looks right on screen at this limit)`);
  // left and right mirror: the mean shift of the two glove sides agree
  let ls = 0, ln = 0, rs = 0, rn = 0; for (let v = 0; v < a.position.count; v++) { const d = shift(v); if (d < 1e-6) continue; if (b.position.getX(v) > 0) { ls += d; ln++; } else { rs += d; rn++; } }
  assert.ok(ln > 300 && rn > 300 && Math.abs(ls / ln - rs / rn) < 0.15 * (ls / ln), `left ${(ls / ln).toFixed(2)} cm and right ${(rs / rn).toFixed(2)} cm mean shift`);
  // the pure function alone: a vertex before the knuckle line stays, one past it moves toward +p (the palm side)
  const pos = new Float32Array([49, 100, 16, 49 + 0.24 * 12, 100 - 0.85 * 12, 16 + 0.48 * 12]), nor = new Float32Array([0, 0, 1, 0, 0, 1]);
  assert.equal(curlGlove(pos, nor, [0, 1], 1, 0.8), 1, 'the wrist vertex stays, the one 12 cm along the fingers moves');
  assert.ok(Math.abs(pos[0] - 49) + Math.abs(pos[1] - 100) + Math.abs(pos[2] - 16) < 1e-9 && KNUCKLE_CM > 5);
  assert.equal(curlGlove(new Float32Array(3), null, [], 1, 0.8), 0, 'an empty hand is fine');
});
