// fparms.js: the survivor's own arms for the first-person view (aiming down the bow), in place of the procedural gloves.
//   createArms(entry, opts) -> { group, update(left, right), dispose() }
//     entry: the models.js prepare() result for the survivor (the same one createSurvivorFigure takes). opts: { material = (src) => src, eye = [0, 165, 8],
//            scale = 1, offset = [0, 0, 0] }. Throws if the Body mesh is missing, so the caller keeps the procedural hands.
//     group: add it to the camera-space viewmodel (metres, the camera at the origin looking down -z). It holds an arms-only SkinnedMesh: the triangles of the
//            survivor's Body mesh (coat sleeves and gloves) whose vertices belong to the arm bones, with the SAME skin weights as the third-person body.
//     update(left, right): two Object3D hand targets in the same scene graph as the group: the target's position is the centre of that palm, its +y axis the
//            direction the fingers point and its +z axis the direction the palm faces. The arms are solved with two-bone IK (ik.js) and the bones posed.
//   `left` is the CHARACTER's left hand (the bow hand), which is on the camera's left side.
// The glove is a static open hand with splayed fingers. A bow hand is RELAXED (archery coaching: the grip sits in the web between thumb and index finger, the
// fingers are slightly bent and loose, never a fist), so the fingers are bent a little toward the palm once at load (curlGlove, below) in the arms' own copy of the
// positions and normals; the survivor's Body geometry is not touched.
// The rig is in the mesh's own units (cm, +x the character's left, +z forward), turned half a circle and scaled into the camera frame, with the eye at `eye`.
import * as THREE from 'three';
import { JOINTS, BONE_INDEX, buildBones, skinned } from './survivor.js';
import { twoBone } from './ik.js';

const PALM_CM = 10;                                  // from the wrist joint to the middle of the palm along the fingers (measured on the glove)
export const FINGER = [0.24, -0.85, 0.48], PALM = [-0.92, -0.36, -0.18]; // the LEFT glove at rest: the fingers point down and forward, the palm faces the body (the right one mirrors x)
const ARM = ['shoulder', 'upperArm', 'forearm', 'hand'];
const POLE = { left: [0.6, -1, -0.3], right: [1, 0.2, -0.8] }; // where the elbow points, in the mesh frame (+x the character's left): the bow arm's down and out, the draw arm's out and back

const v3 = (a, sgn = 1) => new THREE.Vector3(a[0] * sgn, a[1], a[2]);
const frame = (f, p) => { // a rotation taking (1,0,0) to the finger direction and (0,0,1) to the palm normal (made perpendicular to it)
  const e1 = f.clone().normalize(), e3 = p.clone().addScaledVector(e1, -p.dot(e1)).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(e1, new THREE.Vector3().crossVectors(e3, e1), e3));
};

// Bends the finger part of one glove toward the palm. Pure: arrays in, arrays out (positions and normals are changed IN PLACE; `hand` says which vertices are
// the glove's and `side` is +1 for the character's left hand, -1 for the right). In the hand frame (wrist joint, a along the fingers, n out of the palm, lat across it)
// every vertex past the knuckle line a0 moves along a circular arc of curvature curl / FINGER_LEN, and its normal turns with it; the influence ramps in over 1 cm
// past the knuckle line, so the palm, the cuff and the forearm do not move. Returns how many vertices moved.
export const KNUCKLE_CM = 8, FINGER_LEN_CM = 7;
export function curlGlove(pos, nor, hand, side, curl) {
  const H = v3(JOINTS.hand, side), f = v3(FINGER, side).normalize(), p0 = v3(PALM, side), p = p0.addScaledVector(f, -p0.dot(f)).normalize(), l = new THREE.Vector3().crossVectors(f, p);
  const d = new THREE.Vector3(), out = new THREE.Vector3(); let moved = 0;
  for (let i = 0; i < hand.length; i++) {
    const v = hand[i]; d.set(pos[3 * v] - H.x, pos[3 * v + 1] - H.y, pos[3 * v + 2] - H.z);
    const a = d.dot(f), s = a - KNUCKLE_CM; if (s <= 0) continue;
    const n = d.dot(p), lat = d.dot(l), k = Math.min(1, s), ramp = k * k * (3 - 2 * k), phi = (curl / FINGER_LEN_CM) * s * ramp; // the bend angle at this distance along the finger
    const R = FINGER_LEN_CM / curl, sp = Math.sin(phi), cp = Math.cos(phi);
    // the centre line of the finger leaves the knuckle along f and curves toward p; the vertex keeps its offset from it (n along the turned normal, lat across)
    out.copy(H).addScaledVector(f, KNUCKLE_CM + R * sp).addScaledVector(p, R * (1 - cp)).addScaledVector(p, n * cp).addScaledVector(f, -n * sp).addScaledVector(l, lat);
    pos[3 * v] = out.x; pos[3 * v + 1] = out.y; pos[3 * v + 2] = out.z; moved++;
    if (nor) { const nx = nor[3 * v], ny = nor[3 * v + 1], nz = nor[3 * v + 2], nf = nx * f.x + ny * f.y + nz * f.z, np = nx * p.x + ny * p.y + nz * p.z; // turn the normal's (f, p) part by phi
      const f2 = nf * cp - np * sp, p2 = nf * sp + np * cp; nor[3 * v] = nx + f.x * (f2 - nf) + p.x * (p2 - np); nor[3 * v + 1] = ny + f.y * (f2 - nf) + p.y * (p2 - np); nor[3 * v + 2] = nz + f.z * (f2 - nf) + p.z * (p2 - np); }
  }
  return moved;
}

export function createArms(entry, opts = {}) {
  const tint = opts.material || ((m) => m), eye = opts.eye || [0, 165, 8], offset = opts.offset || [0, 0, 0];
  let src = null; if (entry && entry.scene) entry.scene.traverse((o) => { if (o.isMesh && o.name === 'Body') src = o; });
  if (!src || !src.geometry.attributes.position) throw new Error('fparms: the survivor Body mesh is missing');
  const g = skinned(entry.scene, src), a = g.attributes, n = a.position.count, armBones = new Set(ARM.flatMap((b) => [BONE_INDEX[b + 'L'], BONE_INDEX[b + 'R']]));
  const share = new Float32Array(n); // how much of each vertex follows the arm bones
  for (let v = 0; v < n; v++) for (let k = 0; k < 4; k++) if (armBones.has(a.skinIndex.getComponent(v, k))) share[v] += a.skinWeight.getComponent(v, k);
  const tris = (g.index ? g.index.count : n) / 3, keep = [], at = (t, c) => (g.index ? g.index.getX(3 * t + c) : 3 * t + c);
  for (let t = 0; t < tris; t++) {
    const i = at(t, 0), j = at(t, 1), k = at(t, 2);
    if (share[i] >= 0.6 && share[j] >= 0.6 && share[k] >= 0.6) keep.push(i, j, k); // a triangle of sleeve or glove: all three corners follow the arm bones
  }
  const geo = new THREE.BufferGeometry();
  for (const name of Object.keys(a)) geo.setAttribute(name, a[name]); // shares the survivor's attributes, skin weights included...
  // ...except the positions and normals, which are this mesh's own copy: the glove's fingers are bent a little toward the palm (a relaxed bow hand)
  const pos = a.position.array.slice(), nor = a.normal ? a.normal.array.slice() : null, hands = { 1: [], '-1': [] }, handBone = { 1: BONE_INDEX.handL, '-1': BONE_INDEX.handR };
  for (let v = 0; v < n; v++) for (const side of [1, -1]) { let w = 0; for (let k = 0; k < 4; k++) if (a.skinIndex.getComponent(v, k) === handBone[side]) w += a.skinWeight.getComponent(v, k); if (w >= 0.5 && a.position.getX(v) * side > 0) hands[side].push(v); }
  const curl = opts.curl ?? 0.8; let curled = 0;
  if (curl > 0) for (const side of [1, -1]) curled += curlGlove(pos, nor, hands[side], side, curl);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); if (nor) geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(keep);

  const { inst, bones, list } = buildBones(), skeleton = new THREE.Skeleton(list);
  // The arms' own material (the tinted one is a cache shared with the third-person body): the albedo also glows a little, like the bow's, so the camo reads at night.
  const material = tint(src.material).clone(); if (material.map && material.emissive) { material.emissive.set(0xffffff); material.emissiveMap = material.map; material.emissiveIntensity = opts.glow ?? 0.4; }
  const mesh = new THREE.SkinnedMesh(geo, material); mesh.name = 'arms'; mesh.frustumCulled = false;
  inst.add(mesh); mesh.bind(skeleton);
  const k = entry.scale * (opts.scale || 1), group = new THREE.Group(), rig = new THREE.Group();
  rig.rotation.y = Math.PI; rig.scale.setScalar(k); rig.add(inst); group.add(rig); // mesh +z (forward) to camera -z, +x (the character's left) to the camera's left
  rig.position.set(k * eye[0] + offset[0], -k * eye[1] + offset[1], k * eye[2] + offset[2]); // the eye at the group's origin

  const sides = [['L', 1, 'left'], ['R', -1, 'right']].map(([L, sgn, name]) => {
    const j = (b) => v3(JOINTS[b], sgn), S = j('upperArm'), E = j('forearm'), H = j('hand');
    return { L, sgn, name, S, restU: E.clone().sub(S).normalize(), restF: H.clone().sub(E).normalize(), l1: E.distanceTo(S), l2: H.distanceTo(E), pole: v3(POLE[name], 1), restHand: frame(v3(FINGER, sgn), v3(PALM, sgn)) };
  });
  const inv = new THREE.Matrix4(), tp = new THREE.Vector3(), tf = new THREE.Vector3(), tn = new THREE.Vector3(), qU = new THREE.Quaternion(), qF = new THREE.Quaternion(), qH = new THREE.Quaternion();
  return {
    group, mesh, bones, curled,
    update(left, right) {
      rig.updateWorldMatrix(true, false); inv.copy(rig.matrixWorld).invert();
      for (const side of sides) {
        const target = side.name === 'left' ? left : right; if (!target) continue;
        target.updateWorldMatrix(true, false);
        tp.setFromMatrixPosition(target.matrixWorld).applyMatrix4(inv); // the palm centre, in the mesh frame
        tf.set(0, 1, 0).transformDirection(target.matrixWorld).transformDirection(inv); tn.set(0, 0, 1).transformDirection(target.matrixWorld).transformDirection(inv);
        const wrist = tp.clone().addScaledVector(tf, -PALM_CM);
        const r = twoBone(side.S.toArray(), wrist.toArray(), side.pole.toArray(), side.l1, side.l2), elbow = new THREE.Vector3(...r.elbow), w = new THREE.Vector3(...r.wrist);
        qU.setFromUnitVectors(side.restU, elbow.clone().sub(side.S).normalize());
        qF.setFromUnitVectors(side.restF, w.clone().sub(elbow).normalize());
        qH.copy(frame(tf, tn)).multiply(side.restHand.clone().invert()); // the hand's world turn: from the rest glove to the target hand
        bones['shoulder' + side.L].quaternion.identity();
        bones['upperArm' + side.L].quaternion.copy(qU);
        bones['forearm' + side.L].quaternion.copy(qU).invert().multiply(qF);
        bones['hand' + side.L].quaternion.copy(qF).invert().multiply(qH);
      }
    },
    dispose() { geo.dispose(); material.dispose(); skeleton.dispose(); group.removeFromParent(); },
  };
}
