// Tests for src/ik.js (pure two-bone IK). Plain node:test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { twoBone } from '../src/ik.js';

const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('twoBone: reaches a target in range with both bone lengths exact, and the pole picks the side the elbow points to', () => {
  const S = [0, 0, 0], T = [20, -10, 15], l1 = 28.5, l2 = 22;
  for (const pole of [[1, 0, 0], [-1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, 1]]) {
    const r = twoBone(S, T, pole, l1, l2);
    assert.ok(r.reached && d(r.wrist, T) < 1e-6, 'the wrist is on the target');
    assert.ok(Math.abs(d(S, r.elbow) - l1) < 1e-9 && Math.abs(d(r.elbow, r.wrist) - l2) < 1e-9, 'bone lengths preserved');
  }
  const side = (pole) => twoBone(S, T, pole, l1, l2).elbow;
  assert.ok(side([1, 0, 0])[0] > side([-1, 0, 0])[0], 'pole +x puts the elbow further +x than pole -x');
  assert.ok(side([0, -1, 0])[1] < side([0, 1, 0])[1], 'pole -y puts the elbow lower than pole +y');
});

test('twoBone: out of reach it straightens toward the target; too close it folds; neither breaks the lengths', () => {
  const far = twoBone([0, 0, 0], [100, 0, 0], [0, 1, 0], 28, 22);
  assert.ok(!far.reached && Math.abs(far.wrist[0] - 50) < 1e-4 && Math.abs(far.wrist[1]) < 1e-6, 'a straight arm along the line to the target');
  assert.ok(Math.abs(d([0, 0, 0], far.elbow) - 28) < 1e-9 && Math.abs(d(far.elbow, far.wrist) - 22) < 1e-6);
  const close = twoBone([0, 0, 0], [1, 0, 0], [0, 1, 0], 28, 22);
  assert.ok(!close.reached && Math.abs(d([0, 0, 0], close.elbow) - 28) < 1e-6 && Math.abs(d(close.elbow, close.wrist) - 22) < 1e-4);
});

test('twoBone: degenerate input never gives NaN (target on the shoulder, pole along the line, zero pole, equal bones)', () => {
  for (const [S, T, pole, l1, l2] of [[[0, 0, 0], [0, 0, 0], [1, 0, 0], 28, 22], [[0, 0, 0], [0, 10, 0], [0, 1, 0], 28, 22], [[0, 0, 0], [10, 0, 0], [0, 0, 0], 28, 22], [[1, 2, 3], [1, 2, 33], [0, 0, 1], 20, 20]]) {
    const r = twoBone(S, T, pole, l1, l2);
    for (const v of [...r.elbow, ...r.wrist]) assert.ok(Number.isFinite(v), JSON.stringify([S, T, pole]));
    assert.ok(Math.abs(d(S, r.elbow) - l1) < 1e-5 && Math.abs(d(r.elbow, r.wrist) - l2) < 1e-4, 'lengths preserved');
  }
});
