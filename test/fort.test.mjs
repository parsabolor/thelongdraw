// Tests for the outpost's shell on the REAL level (src/level.js + src/shell-data.js, generated from the scan by tools/prep-shell.mjs): a body can walk in through the
// doorway and from the open back, sight and arrows pass the windows and the doorway but not the solid wall, and the binoculars can tag a zombie inside through a window.
// Measured on the scan: the front wall is at z about 5.7 with a doorway at x 0.9 to 1.9 and windows at x about -5.0 to -4.4 and -1.6 to -1.2; there is no back wall.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL } from '../src/level.js';
import { createState, step, findPath, hasLOS, heightAt, seesZombie, tagById } from '../src/sim.js';

const fresh = () => createState(LEVEL, 1);
// Walks the player through the waypoints with plain movement input (so the real collision applies); returns how many were reached.
function walk(S, pts, secs = 40) {
  let i = 0;
  for (let t = 0; t < secs * 60 && i < pts.length; t++) {
    const P = S.player, [x, z] = pts[i], d = Math.hypot(x - P.x, z - P.z);
    if (d < 0.25) { i++; continue; }
    step(S, { mx: (x - P.x) / d, mz: (z - P.z) / d, aim: null });
  }
  return i;
}
const place = (S, x, z) => { Object.assign(S.player, { x, z, y: heightAt(S.level, x, z), hp: 1e9 }); return S; };

test('the fort can be entered: through the doorway (even 0.12 m off its middle) and from the open back', () => {
  for (const x0 of [1.38, 1.5, 1.62]) {
    const S = place(fresh(), x0, 9);
    assert.equal(walk(S, [[x0, 7], [1.5, 5.6], [1.5, 4], [1.5, 2.2], [0.5, 0.8], [0, -1]]), 6, `a body at x ${x0} gets through the door and the porch into the hall`);
    assert.ok(S.player.z < 0, 'and is inside');
  }
  const back = place(fresh(), 0, -9);
  assert.equal(walk(back, [[0, -6], [0, -3], [0, 0]]), 3, 'the scan has no back wall: a body walks in from the north');
  const path = findPath(fresh().level, 1.5, 9, 0, -1);
  assert.ok(path && Math.hypot(path.at(-1)[0] - 0, path.at(-1)[1] + 1) < 1, 'the planner finds the way in too');
});

test('the walls are solid for a body: walking straight at the front wall, away from the doorway, stops at it', () => {
  for (const x of [-5.5, -3, 3, 5.5]) {
    const S = place(fresh(), x, 7);
    for (let t = 0; t < 600; t++) step(S, { mx: 0, mz: -1, aim: null }); // ten seconds straight north
    assert.ok(S.player.z > 5.9, `a body at x ${x} stops at the wall (z ${S.player.z.toFixed(2)})`);
  }
});

test('sight and arrows pass the windows and the doorway, and stop at the solid wall', () => {
  const L = fresh().level, los = (x) => hasLOS(L, x, 1.6, 9, x, 1.4, 3); // from the pad, in through the front wall at x
  assert.ok(los(-4.75), 'the left window');
  assert.ok(los(-1.4), 'the second window');
  assert.ok(los(1.4), 'the doorway');
  for (const x of [-2.5, 3, 5, -6.8]) assert.ok(!los(x), `the wall at x ${x}`);
  assert.ok(hasLOS(L, 0, 1.6, -9, 0, 1.6, 0), 'and into the hall from the open back');
});

test('the binoculars see a zombie inside through a window or the doorway, not through the wall, and can tag it', () => {
  const S = fresh(), z = S.zombies.find((q) => q.role === 'sleeper'), eye = (x) => [x, 1.6, 9];
  Object.assign(z, { x: -4.75, z: 3, y: 0 });
  assert.ok(seesZombie(S, eye(-4.75), z), 'through the window');
  Object.assign(z, { x: -2.5, z: 3 });
  assert.ok(!seesZombie(S, eye(-2.5), z), 'not through the wall');
  Object.assign(z, { x: 1.4, z: 3 });
  assert.ok(seesZombie(S, eye(1.4), z), 'through the doorway');
  assert.ok(tagById(S, z.id), 'tagged');
});

test('nothing starts inside a wall', () => {
  const S = fresh();
  for (const p of [...LEVEL.spawns, LEVEL.start, LEVEL.bike]) {
    const y = heightAt(S.level, p.x, p.z);
    for (const b of S.level.boxes) assert.ok(!(p.x >= b.x0 && p.x <= b.x1 && p.z >= b.z0 && p.z <= b.z1 && y + 1 >= b.y0 && y + 1 <= b.y1), `${p.role || 'start'} at ${p.x}, ${p.z} stands inside a box`);
  }
});
