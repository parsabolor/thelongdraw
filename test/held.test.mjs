// Tests for src/held.js: what the survivor carries. A stand-in figure records what is attached where, so no model files are needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { attachHeld, HELD } from '../src/held.js';
import { SWING_TIME, melee, pose } from '../src/survivor.js';

const figure = () => { const on = {}; return { on, attach(bone, obj) { (on[bone] = on[bone] || []).push(obj); return obj; } }; };
const prop = () => { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.5))); return g; };

test('held: the bow is in the left hand at all times, the machete is on the right hip and only in the right hand during a swing', () => {
  const fig = figure(), held = attachHeld(fig, { bow: prop(), knife: prop() });
  assert.equal(fig.on.handL.length, 1, 'the bow goes to the left hand');
  assert.equal(fig.on.hips.length, 1, 'the sheathed machete goes to the hip');
  assert.equal(fig.on.handR.length, 1, 'the drawn machete goes to the right hand');
  const [sheathed, drawn] = [fig.on.hips[0], fig.on.handR[0]];
  assert.ok(sheathed.visible && !drawn.visible, 'sheathed at rest');
  held.swing(true); assert.ok(!sheathed.visible && drawn.visible, 'in the hand during the swing');
  held.swing(false); assert.ok(sheathed.visible && !drawn.visible, 'back on the hip');
  assert.ok(fig.on.handL[0].visible, 'the bow is never hidden');
});

test('held: either prop may be missing, and the numbers stay finite', () => {
  const a = figure(); attachHeld(a, { bow: prop() }); assert.deepEqual(Object.keys(a.on), ['handL']);
  const b = figure(), h = attachHeld(b, { knife: prop() }); h.swing(true); assert.deepEqual(Object.keys(b.on).sort(), ['handR', 'hips']);
  const c = figure(); attachHeld(c, {}).swing(true); assert.deepEqual(c.on, {}, 'nothing to carry, nothing attached');
  for (const v of [...HELD.palm, ...HELD.sheath, ...HELD.knifeAlong, HELD.bowTilt, HELD.bowCant, HELD.sheathPitch]) assert.ok(Number.isFinite(v));
});

test('stab: starts and ends in the walk pose; the thrust accelerates into contact and stops, the return is fast then settles', () => {
  assert.ok(SWING_TIME > 0.35 && SWING_TIME < 0.6, `${SWING_TIME} s`);
  assert.equal(melee(0).w, 0); assert.equal(melee(1).w, 0); assert.ok(melee(0.15).w > 0.8 && melee(0.5).w > 0.99, 'blended fully in over the stab');
  const speed = (u) => Math.abs(melee(u + 0.005).arm - melee(u - 0.005).arm) / 0.01 + Math.abs(melee(u + 0.005).elbow - melee(u - 0.005).elbow) / 0.01; // how fast the arm is moving
  assert.ok(speed(0.17) > speed(0.1) && speed(0.17) > 1, 'the thrust is still accelerating just before contact');
  assert.ok(speed(0.27) < 0.1 * speed(0.17) && speed(0.3) < 0.1 * speed(0.17), 'a beat of near-stillness at full extension (the impact)');
  assert.ok(speed(0.35) > speed(0.48), 'the return is fast, then settles');
  assert.ok(melee(0.2).arm > 1.2 && melee(0.2).elbow < -0.4, 'at contact the arm is out and nearly straight');
  assert.ok(melee(0).twist < 0 && melee(0.2).twist > 0.3, 'the torso coils to the right in the guard and uncoils into the thrust');
  assert.ok(melee(0.2).lunge === 1 && melee(0.2).balance > 0.3, 'the lunge is at full and the left arm swings back to balance');
});

test('stab pose: the lunge happens only standing still, the knife arm and torso lead, the left arm balances, and it hands back to the walk', () => {
  const stand = (swing) => pose({ ph: 0, sp: 0, t: 0, cm: 102, swing }), walk = (swing) => pose({ ph: 1, sp: 2.2, t: 0, cm: 102, swing });
  const [rest, hit] = [stand(-1), stand(0.2)];
  assert.ok(hit.pos[2] - rest.pos[2] > 15, `standing, the pelvis moves ${(hit.pos[2] - rest.pos[2]).toFixed(0)} cm forward`);
  assert.ok(hit.rot.thighR[0] < rest.rot.thighR[0] - 0.4 && hit.rot.shinR[0] > rest.rot.shinR[0] + 0.3, 'the lead (right) leg steps out with its knee bent');
  assert.ok(hit.rot.thighL[0] > rest.rot.thighL[0], 'the rear leg extends');
  assert.ok(hit.rot.upperArmL[0] > rest.rot.upperArmL[0] + 0.3, 'the bow arm swings back to balance');
  assert.ok(hit.rot.upperArmR[0] < -1.2 && hit.rot.forearmR[0] > 0.4, 'the knife arm is raised and extended');
  assert.ok(hit.rot.chest[1] > rest.rot.chest[1] + 0.1 && hit.rot.chest[2] === rest.rot.chest[2], 'the torso turns into it');
  const [wRest, wHit] = [walk(-1), walk(0.2)];
  assert.ok(Math.abs(wHit.pos[2] - wRest.pos[2]) < 1e-9 && wHit.rot.thighR.every((v, i) => Math.abs(v - wRest.rot.thighR[i]) < 1e-9) && wHit.rot.shinL.every((v, i) => Math.abs(v - wRest.rot.shinL[i]) < 1e-9), 'walking, the legs are left alone: the stab is upper body only');
  assert.ok(wHit.rot.upperArmR[0] < -1.2, 'but the arm still stabs');
  const crouch = pose({ ph: 0, sp: 0, cr: 1, t: 0, cm: 102, swing: 0.2 }), crouchRest = pose({ ph: 0, sp: 0, cr: 1, t: 0, cm: 102 });
  assert.equal(crouch.pos[2], crouchRest.pos[2], 'crouching, there is no lunge either');
  const done = stand(1);
  assert.ok(done.rot.upperArmR.every((v, i) => Math.abs(v - rest.rot.upperArmR[i]) < 1e-9) && done.pos[2] === rest.pos[2], 'at the end the pose is the standing pose again');
  assert.ok(pose({ ph: 0, sp: 0, t: 0, hold: 1 }).rot.forearmL[0] < rest.rot.forearmL[0] - 0.2, 'holding the bow raises the left forearm');
});
