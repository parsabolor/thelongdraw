// Tests for src/motion.js (pure helpers). Plain node:test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapPi, turnToward, spring, gaitRate } from '../src/motion.js';

test('wrapPi maps any angle into [-pi, pi] without changing the direction it points', () => {
  for (const a of [0, 1, -1, 3.2, -3.2, 7, -7, 100, -100]) {
    const w = wrapPi(a);
    assert.ok(w >= -Math.PI - 1e-12 && w <= Math.PI + 1e-12, `${a} -> ${w}`);
    assert.ok(Math.abs(Math.sin(w) - Math.sin(a)) < 1e-9 && Math.abs(Math.cos(w) - Math.cos(a)) < 1e-9);
  }
});

test('turnToward takes the short way round the +-pi seam, at no more than the rate, and never overshoots', () => {
  assert.ok(turnToward(3.0, -3.0, 1, 0.1) > 3.0, 'from 3.0 to -3.0 is 0.28 rad the positive way, not 6 the other way');
  assert.ok(Math.abs(turnToward(0, 2, 1, 0.1) - 0.1) < 1e-12, 'rate x dt');
  assert.equal(turnToward(0, 0.05, 10, 0.1), 0.05, 'arrives exactly, no overshoot');
  assert.equal(turnToward(0.3, 0.3, 5, 0.1), 0.3);
  let a = 0; for (let i = 0; i < 100; i++) a = turnToward(a, 2.5, 4, 1 / 60); // 1.67 s at 4 rad/s is 6.7 rad of turning available: it gets there and stops
  assert.ok(Math.abs(a - 2.5) < 1e-9);
  assert.equal(turnToward(1, 2, 5, 0), 1, 'no time, no turn');
  assert.equal(turnToward(1, 2, -5, 0.1), 1, 'a negative rate does not turn away');
});

test('spring settles on the target, rings when under-damped, and stays stable at a slow-frame dt', () => {
  const s = { x: 0, v: 0 }; let peak = 0;
  for (let i = 0; i < 240; i++) { spring(s, 1, 80, 4, 1 / 60); peak = Math.max(peak, s.x); }
  assert.ok(peak > 1.1 && Math.abs(s.x - 1) < 0.02, `an under-damped spring overshoots (peak ${peak.toFixed(2)}) and then settles (${s.x.toFixed(3)})`);
  const stiff = { x: 0, v: 0 };
  for (let i = 0; i < 60; i++) spring(stiff, 1, 400, 40, 0.1); // a stiff spring and a 10 fps frame: plain explicit Euler would blow up
  assert.ok(Number.isFinite(stiff.x) && Math.abs(stiff.x - 1) < 0.01, `stable, x = ${stiff.x}`);
  const a = { x: 0, v: 0 }, b = { x: 0, v: 0 };
  for (let i = 0; i < 120; i++) spring(a, 1, 60, 10, 1 / 60);
  for (let i = 0; i < 60; i++) spring(b, 1, 60, 10, 1 / 30);
  assert.ok(Math.abs(a.x - b.x) < 0.02, 'the frame rate barely changes the motion');
  assert.equal(spring({ x: 2, v: 0 }, NaN, 50, 5, 0.01), 2, 'a NaN target leaves it alone');
  assert.equal(spring({ x: 2, v: 5 }, 0, 50, 5, 0), 2, 'dt = 0 does nothing');
});

test('gaitRate: the planted foot keeps up with the body at every speed, and a run swings the legs wider instead of an absurd cadence', () => {
  for (const speed of [0.5, 1.1, 2, 3.4]) {
    const { rate, gain } = gaitRate(speed, 0.36);
    assert.ok(Math.abs(rate * gain * 0.36 - speed) < 1e-9, `${speed} m/s: rate ${rate.toFixed(2)} x gain ${gain.toFixed(2)} covers the ground`);
  }
  assert.equal(gaitRate(1.1, 0.36).gain, 1, 'a walk is played as authored');
  assert.ok(Math.abs(gaitRate(3.4, 0.36).gain - 1.7) < 1e-9, 'a run swings 70% wider');
  assert.ok(gaitRate(3.4, 0.36).rate < 6 && gaitRate(3.4, 0.36).rate / gaitRate(1.1, 0.36).rate < 2, 'the run cadence is under twice the walk cadence');
  assert.ok(gaitRate(0, 0.36).rate >= 0.4 && gaitRate(50, 0.36).rate <= 6, 'rate stays inside its limits');
  assert.ok(gaitRate(2, 0.36).gain > 1 && gaitRate(2, 0.36).gain < 1.7, 'in between, in between');
});
