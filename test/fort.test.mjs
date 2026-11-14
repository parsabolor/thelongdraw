// Tests for the outpost's shell on the REAL level (src/level.js + src/shell-data.js, generated from the scan by tools/prep-shell.mjs): a body can walk in through the
// doorway and not through the back wall, sight and arrows pass the windows and the doorway but not the solid walls, and the binoculars can tag a zombie inside through a window.
// Measured on the scan: the front wall is at z about 5.7 with a doorway at x 0.9 to 1.9 and windows at x about -5.3 to -4.3 and -2 to -0.9; the back wall is at z about -5.5.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL, TOWER, TOWERS, terrainHeight } from '../src/level.js';
import { PARTS, createState, step, findPath, hasLOS, heightAt, terrainAt, hitScale, seesZombie, sightPoints, tagById, tagZombie } from '../src/sim.js';

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
// The zombies out of the way (asleep, far off): a hit shoves the body, and with none left alive the game is over and nothing moves.
const alone = (S) => { for (const q of S.zombies) { q.x += 1000; q.state = 'dormant'; } return S; };

test('the fort can be entered through the doorway (even 0.12 m off its middle), and not through the back wall', () => {
  for (const x0 of [1.38, 1.5, 1.62]) {
    const S = place(fresh(), x0, 9);
    assert.equal(walk(S, [[x0, 7], [1.5, 5.6], [1.5, 4], [1.5, 2.2], [0.5, 0.8], [0, -1]]), 6, `a body at x ${x0} gets through the door and the porch into the hall`);
    assert.ok(S.player.z < 0, 'and is inside');
  }
  const back = alone(place(fresh(), 1, -9));
  assert.ok(walk(back, [[1, -6.5], [1, -3], [1, 0]], 10) < 3, 'the back wall (once missing from the shell: it is in the scan\'s second material) stops a body');
  assert.ok(back.player.z < -5, `and it stays outside (z ${back.player.z.toFixed(2)})`);
  const path = findPath(fresh().level, 1.5, 9, 0, -1);
  assert.ok(path && Math.hypot(path.at(-1)[0] - 0, path.at(-1)[1] + 1) < 1, 'the planner finds the way in too');
});

test('the walls are solid for a body: walking straight at the front wall, away from the doorway, stops at it', () => {
  for (const x of [-5.5, -3, 3, 5.5]) {
    const S = alone(place(fresh(), x, 7)); // (the yard's screamer patrols this strip: it would shove the body along the wall)
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
  assert.ok(!hasLOS(L, 1, 1.6, -9, 1, 1.6, 0), 'nor through the back wall');
  const east = (z) => hasLOS(L, 9, 1.5, z, 3, 1.4, z); // from the yard east of the hall (its east wall at x about 6.9), in through it at z
  assert.ok(east(-0.4), 'the east wall\'s first window');
  assert.ok(east(3.8), 'its second window');
  assert.ok(!east(1.6), 'the east wall between them');
});

test('the fortress wall closes the yard: a body gets in only through the gate and the breach, and the way in is found from the start', () => {
  // straight at the wall from outside, away from the gate and the breach: stopped at its outer face (south z 12, west x -12.81, east x 11.19, north z -12)
  for (const [x0, z0, mx, mz, stopped] of [[-6, 16, 0, -1, (P) => P.z > 12], [-17, 2, 1, 0, (P) => P.x < -12.81], [15, 2, -1, 0, (P) => P.x > 11.19], [-3, -16, 0, 1, (P) => P.z < -12]]) {
    const S = place(fresh(), x0, z0);
    for (let t = 0; t < 600; t++) step(S, { mx, mz, aim: null });
    assert.ok(stopped(S.player), `a body walking at the wall from (${x0}, ${z0}) stops at it (${S.player.x.toFixed(2)}, ${S.player.z.toFixed(2)})`);
  }
  assert.equal(walk(place(fresh(), 1.4, 16), [[1.4, 13], [1.4, 9], [1.5, 7]]), 3, 'in through the gate (south, in line with the hall\'s doorway), past its open leaves');
  assert.equal(walk(place(fresh(), 14, -15), [[10.5, -11], [8, -8], [5, -7]]), 3, 'in through the breach (the north-east corner)');
  const L = fresh().level, path = findPath(L, LEVEL.start.x, LEVEL.start.z, 1.5, 4);
  assert.ok(path && Math.hypot(path.at(-1)[0] - 1.5, path.at(-1)[1] - 4) < 1, 'the planner finds the way from the start into the hall');
});

test('sight and arrows pass the gate and the breach, and not the fortress wall', () => {
  const L = fresh().level;
  assert.ok(hasLOS(L, 1.4, 1.6, 18, 1.4, 1.4, 8), 'through the gate');
  assert.ok(hasLOS(L, 15, 1.6, -15, 6, 1.4, -6), 'through the breach');
  assert.ok(!hasLOS(L, -6, 1.6, 18, -6, 1.4, 8), 'not through the south wall');
  assert.ok(!hasLOS(L, -18, 1.6, 2, -9, 1.4, 2), 'nor the west wall');
  assert.ok(!hasLOS(L, 17, 1.6, 2, 8.5, 1.4, 2), 'nor the east wall');
  assert.ok(!hasLOS(L, -3, 1.6, -18, -3, 1.4, -8), 'nor the north wall');
});

test('the hall is open: a body crosses it where the scan had membranes (sheets of photogrammetry fill) and the sight crosses it too', () => {
  const S = place(fresh(), 1.5, 4.5); // just inside the doorway
  const across = [[1.5, 0], [3.5, 0], [4.5, -2.5], [0, -1], [-4, 2], [3, 3.5]];
  assert.equal(walk(S, across), across.length, 'through the middle of the hall, the east side, the north-east corner, the west side and back');
  const L = S.level;
  assert.ok(hasLOS(L, -4, 1.5, 2, 5, 1.5, -1), 'from the west side of the hall to the east');
  assert.ok(hasLOS(L, 1.4, 1.5, 4.5, 4.5, 1.5, -2.5), 'from the doorway to the north-east corner');
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

test('the binoculars see what an arrow could hit: a sleeper whose middle is behind the window frame but whose edge shows in it, and every point they see by is one an arrow reaches', () => {
  const S = fresh(), L = S.level, z = S.zombies.find((q) => q.role === 'sleeper' && q.x === -4 && q.z === 3), o = [-7.5, 1.6, 6.7]; // from the yard, at a slant through the left window
  for (const q of S.zombies) if (q !== z) q.x += 1000; // nothing else in the way of an arrow
  assert.ok(!PARTS.some(([, hy]) => hasLOS(L, ...o, z.x, z.y + hy * hitScale(z), z.z)), 'the line to the middle of each part is behind the frame');
  assert.ok(seesZombie(S, o, z), 'but its edge is in the window: seen');
  // over the yard: wherever a point the binoculars look for is in sight, an arrow aimed at it (tagZombie: the arrow's own test, its hit spheres and the world in the way) reaches this zombie
  let seen = 0;
  for (let px = -8; px <= 8; px += 1) for (let pz = 6.5; pz <= 11.5; pz += 1) {
    const e = [px, terrainAt(L, px, pz) + 1.6, pz], clear = sightPoints(e, z).filter((p) => hasLOS(L, ...e, ...p));
    if (clear.length) seen++;
    for (const p of clear) { const d = p.map((v, i) => v - e[i]), n = Math.hypot(...d); assert.equal(tagZombie(S, e, d.map((v) => v / n), 200, false), z.id, `from ${e}, toward ${p}`); }
  }
  assert.ok(seen >= 10, `seen from ${seen} spots in the yard`);
  assert.ok(!seesZombie(S, [-2.5, 1.6, 9], { ...z, x: -2.5, z: 3 }), 'still not through the wall');
});

test('the scouts stand on the decks of their towers, on level ground, and stay there', () => {
  for (const t of TOWERS) {
    for (let a = 0; a < 8; a++) for (const r of [0, 1.5, 3]) { // level within TOWER.flat metres
      assert.ok(Math.abs(terrainHeight(t.x + Math.cos(a) * r, t.z + Math.sin(a) * r) - t.base) < 0.02, `the ground under the tower at ${t.x}, ${t.z} is level (${r} m out)`);
    }
  }
  const S = fresh(), scouts = S.zombies.filter((z) => z.role === 'scout');
  assert.equal(scouts.length, TOWERS.length);
  TOWERS.forEach((t, i) => assert.ok(Math.abs(scouts[i].y - (t.base + TOWER.deck)) < 1e-9, `scout ${i} stands on its deck`));
  // a hunter right under a scout, and a player in sight, for a minute: the scout is not pushed off its deck and does not drop to the ground
  const t0 = TOWERS[0], hunter = S.zombies.find((z) => z.role === 'hunter');
  Object.assign(hunter, { x: t0.x + 0.1, z: t0.z, y: heightAt(S.level, t0.x, t0.z) });
  S.player.hp = 1e9;
  const before = scouts.map((z) => [z.x, z.y, z.z]);
  for (let i = 0; i < 3600; i++) step(S, { mx: 0, mz: 0, aim: null });
  scouts.forEach((z, i) => assert.deepEqual([z.x, z.y, z.z], before[i], `scout ${i} has not moved`));
});

test('a scout on its deck can be seen and hit from the ground at a reasonable angle, and not from right underneath', () => {
  const S = fresh(), t = TOWERS[1], scout = S.zombies.filter((z) => z.role === 'scout')[1]; // the east rim, over the pad
  let seen = 0;
  for (let a = 0; a < 16; a++) { // from 14 m away, all round: wherever the hillside is not too steep to look up the deck's edge
    const x = t.x + Math.cos(a * Math.PI / 8) * 14, z = t.z + Math.sin(a * Math.PI / 8) * 14, y = heightAt(S.level, x, z);
    if (Number.isFinite(y) && seesZombie(S, [x, y + 1.6, z], scout)) seen++;
  }
  assert.ok(seen >= 4, `seen from ${seen} of 16 directions`);
  assert.ok(!seesZombie(S, [t.x + 0.5, heightAt(S.level, t.x, t.z) + 1.6, t.z], scout), 'not from under the deck');
});

test('nothing starts inside a wall', () => {
  const S = fresh();
  for (const p of [...LEVEL.spawns, LEVEL.start, LEVEL.bike]) {
    const y = heightAt(S.level, p.x, p.z);
    for (const b of S.level.boxes) assert.ok(!(p.x >= b.x0 && p.x <= b.x1 && p.z >= b.z0 && p.z <= b.z1 && y + 1 >= b.y0 && y + 1 <= b.y1), `${p.role || 'start'} at ${p.x}, ${p.z} stands inside a box`);
  }
});
