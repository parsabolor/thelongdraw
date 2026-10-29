// Headless checks for the pure logic in src/sim.js. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL } from '../src/level.js';
import { TUNING, createState, buildLevel, step, emitNoise, fireArrow, retrieve, knife, knifeTarget, windAt, findPath, heightAt, openAt, hasLOS, dropAngle, PIN_RANGES, seesZombie, tagById } from '../src/sim.js';

const idle = { mx: 0, mz: 0, aim: null };
const open = (spawns, boxes = [], terrain = null) => ({
  bounds: { x0: -40, z0: -40, w: 80, d: 80 }, boxes, start: { x: 0, z: 30, yaw: 0 }, bike: { x: 0, z: 30 },
  bell: { x: 0, y: 3, z: 0 }, patrol: [[5, 5], [-5, 5], [5, -5]], spawns, terrain,
});
const hunter = (x, z, yaw = 0) => ({ role: 'hunter', x, z, yaw, patrol: [] });
const guard = { role: 'sleeper', x: 6, z: -6, yaw: 0 }; // keeps a level without other zombies from counting as cleared
const run = (S, seconds, inp = idle) => { for (let i = 0; i < Math.round(seconds / TUNING.dt); i++) step(S, inp); };

test('the world is valid: no floating boxes; start, bike, every post and patrol point are connected ground, both ways; scouts overlook the pad', () => {
  assert.throws(() => buildLevel({ bounds: LEVEL.bounds, boxes: [{ x0: 0, x1: 1, z0: 0, z1: 1, y0: 1, y1: 2, tag: 'wood' }] }), /floats/);
  const S = createState(LEVEL, 1), L = S.level; // throws on a floating box or a box on sloped ground; the ground nobody can reach from the start is sealed
  const inside = (i) => Math.abs(L.x0 + (i % L.w) + 0.5) < L.limit && Math.abs(L.z0 + ((i / L.w) | 0) + 0.5) < L.limit;
  let cells = 0, solid = 0; for (let i = 0; i < L.w * L.d; i++) if (inside(i)) { cells++; if (L.obs[i] === Infinity) solid++; }
  assert.ok(L.sealed > solid && solid < 0.06 * cells, `${solid} of ${cells} cells inside the play limit are sealed cliffs: a few, not hills (${(100 * solid / cells).toFixed(1)}%)`);
  const spots = [['bike', LEVEL.bike], ...LEVEL.spawns.map((s, i) => [`${s.role} ${i}`, s]), ...LEVEL.patrol.map(([x, z], i) => [`pool ${i}`, { x, z }]),
    ...LEVEL.spawns.flatMap((s, i) => (s.patrol || []).map(([x, z], j) => [`patrol ${i}.${j}`, { x, z }]))];
  const reaches = (path, x, z) => { const end = path && path.at(-1); return end && Math.hypot(end[0] - x, end[1] - z) < 1.5; };
  const bad = [];
  for (const [name, p] of spots) {
    if (!Number.isFinite(heightAt(L, p.x, p.z))) { bad.push(`${name} (${p.x}, ${p.z}) is not walkable ground (sealed ground is solid)`); continue; }
    if (!(Math.abs(p.x) < LEVEL.limit && Math.abs(p.z) < LEVEL.limit)) bad.push(`${name} is outside the play limit`);
    if (!reaches(findPath(L, LEVEL.start.x, LEVEL.start.z, p.x, p.z), p.x, p.z)) bad.push(`${name} (${p.x}, ${p.z}): no path from the start`);
    if (!reaches(findPath(L, p.x, p.z, LEVEL.start.x, LEVEL.start.z), LEVEL.start.x, LEVEL.start.z)) bad.push(`${name} (${p.x}, ${p.z}): no path back to the start (a one-way pit)`);
  }
  assert.deepEqual(bad, []);
  for (const s of LEVEL.spawns.filter((q) => q.role === 'scout')) {
    const y = heightAt(L, s.x, s.z);
    assert.ok(y > 4, `a scout stands high (${y.toFixed(1)} m above the pad)`);
    assert.ok([[0, 10], [0, -8], [8, 0], [-8, 0]].some(([x, z]) => hasLOS(L, s.x, y + 1.6, s.z, x, 1.6, z)), `the scout at ${s.x}, ${s.z} sees the pad`);
  }
  for (const p of LEVEL.props) for (const [name, q] of [['start', LEVEL.start], ...spots]) assert.ok(Math.hypot(p.x - q.x, p.z - q.z) > p.r + 1, `a ${p.kind} blocks ${name}`);
});

test('hunters can really run to the player across the rugged ground (A*, string-pulling and movement agree)', () => {
  for (const sp of LEVEL.spawns.filter((s) => s.role === 'hunter' || s.role === 'screamer')) {
    const S = createState(LEVEL, 1), z = S.zombies.find((q) => Math.hypot(q.x - sp.x, q.z - sp.z) < 0.1);
    S.player.hp = 1e9; // the player stands at the start
    z.state = 'alert'; z.meter = 1; z.lkp = { x: S.player.x, z: S.player.z }; // told where the player is, and (as if it could still see them) never giving up
    let t = 0;
    for (; t < 240 && Math.hypot(z.x - S.player.x, z.z - S.player.z) > TUNING.zombie.attackRange + 1.5; t += TUNING.dt) { z.seenT = S.t; step(S, idle); }
    assert.ok(t < 240, `the ${sp.role} at ${sp.x}, ${sp.z} never got to the start (stuck at ${z.x.toFixed(0)}, ${z.z.toFixed(0)})`);
  }
});

test('path finding goes around a wall and ends at the goal', () => {
  const L = buildLevel(open([], [{ x0: -1, x1: 1, z0: -10, z1: 10, y0: 0, y1: 3, tag: 'concrete' }]));
  const p = findPath(L, -5, 0, 5, 0);
  assert.deepEqual(p.at(-1), [5, 0]);
  let len = 0, x = -5, z = 0;
  for (const [px, pz] of p) { len += Math.hypot(px - x, pz - z); x = px; z = pz; assert.equal(heightAt(L, px, pz), 0); }
  assert.ok(len > 20, `expected a detour, got ${len.toFixed(1)} m`);
});

test('binoculars: a zombie in the open is seen and can be tagged by id; behind a wall it is not seen; a dead one cannot be tagged', () => {
  const wall = { x0: -5, x1: 5, z0: 8, z1: 9, y0: 0, y1: 4, tag: 'concrete' }, eye = [0, 1.6, 0];
  const open1 = createState(open([hunter(0, 20, 0), guard]), 1), walled = createState(open([hunter(0, 20, 0), guard], [wall]), 1);
  assert.ok(seesZombie(open1, eye, open1.zombies[0]), 'seen in the open');
  assert.ok(!seesZombie(walled, eye, walled.zombies[0]), 'not seen behind a wall');
  assert.ok(tagById(open1, open1.zombies[0].id) && open1.zombies[0].tagged && open1.events.some((e) => e.type === 'tag'), 'tagged, with an event');
  assert.ok(!tagById(open1, open1.zombies[0].id), 'tagging twice does nothing');
  open1.zombies[0].state = 'dead';
  assert.ok(!seesZombie(open1, eye, open1.zombies[0]) && !tagById(open1, open1.zombies[0].id), 'a dead zombie is neither seen nor tagged');
});

test('hills: a small steep hill is walkable (the old 0.62 limit sealed it), a vertical cliff stays solid', () => {
  const hill = { ...open([guard]), seal: true, start: { x: -10, z: 0, yaw: Math.PI / 2 }, terrain: (x) => Math.max(0, 1.5 - 0.85 * Math.abs(x)) }; // a 1.5 m ridge with 40 degree flanks across the way
  const L = buildLevel(hill), p = findPath(L, -10, 0, 10, 0);
  assert.equal(L.sealed, 0, 'nothing is sealed');
  assert.deepEqual(p.at(-1), [10, 0]);
  const S = createState(hill, 1); S.player.hp = 1e9; run(S, 14, { mx: 1, mz: 0, aim: null });
  assert.ok(S.player.x > 8, `the player walked over the hill (x = ${S.player.x.toFixed(1)})`);
  const old = TUNING.player.slope; TUNING.player.slope = 0.62;
  try { assert.ok(buildLevel(hill).sealed > 0, 'under the old limit the hill was sealed'); } finally { TUNING.player.slope = old; }
  const cliff = buildLevel({ ...hill, terrain: (x) => (x > 0 ? 2.5 : 0) });
  assert.ok(cliff.sealed > 0 && !Number.isFinite(heightAt(cliff, 5, 0)), 'a vertical face is still solid');
});

test('seal and A* agree: every open ground cell inside the play limit has a path from the start and back', () => {
  const L = createState(LEVEL, 1).level; let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648, bad = [];
  const reaches = (p, x, z) => p && p.length && Math.hypot(p.at(-1)[0] - x, p.at(-1)[1] - z) <= 1.5;
  for (let n = 0; n < 150; n++) {
    const x = (rnd() * 2 - 1) * (LEVEL.limit - 1), z = (rnd() * 2 - 1) * (LEVEL.limit - 1);
    if (!openAt(L, x, z)) continue; // sealed ground, a trunk or a boulder: solid
    if (!reaches(findPath(L, LEVEL.start.x, LEVEL.start.z, x, z), x, z)) bad.push(`no path to ${x.toFixed(1)}, ${z.toFixed(1)}`);
    if (!reaches(findPath(L, x, z, LEVEL.start.x, LEVEL.start.z), LEVEL.start.x, LEVEL.start.z)) bad.push(`no path back from ${x.toFixed(1)}, ${z.toFixed(1)}`);
  }
  assert.deepEqual(bad, []);
});

test('a nearby noise makes an idle hunter suspicious; a distant one does not', () => {
  const near = createState(open([hunter(0, 0, Math.PI)]), 1);
  emitNoise(near, 8, 0.5, 0, 0.6, 'impact', 'arrow');
  step(near, idle);
  assert.equal(near.zombies[0].state, 'suspicious');
  const far = createState(open([hunter(0, 0, Math.PI)]), 1);
  emitNoise(far, 30, 0.5, 0, 0.4, 'impact', 'arrow');
  step(far, idle);
  assert.equal(far.zombies[0].state, 'idle');
});

test('zombies that hear a noise fan out and search the area within 20 m instead of piling up on the spot, then give up', () => {
  const ring = [[24, 0], [-24, 3], [3, 25], [-3, -24], [17, 17], [-17, -17]].map(([x, z]) => hunter(x, z, 0));
  const S = createState(open([...ring, guard]), 4), R = TUNING.zombie.searchRadius, H = S.zombies.filter((z) => z.role === 'hunter');
  S.player.x = -39; S.player.z = 39; S.player.hp = 1e9; // far away and unkillable: the test is about the noise
  assert.equal(R, 20);
  emitNoise(S, 0, 1, 0, 0.9, 'impact', 'arrow'); step(S, idle); // everyone hears it: they all head for the (0, 0) spot
  assert.ok(H.every((z) => z.state === 'suspicious'), 'all six investigate');
  let worstPile = 0, farthestPoint = 0, searching = 0, spread = 0, samples = 0;
  for (let i = 0; i < 150 * 60; i++) {
    step(S, idle);
    for (const z of H) if (z.state === 'search' && z.point !== z.searchC) farthestPoint = Math.max(farthestPoint, Math.hypot(z.point.x - z.searchC.x, z.point.z - z.searchC.z));
    if (i % 60 === 0 && i >= 10 * 60 && i <= 60 * 60) { // from 10 s on, while they investigate and search
      for (const z of H) worstPile = Math.max(worstPile, H.filter((o) => Math.hypot(o.x - z.x, o.z - z.z) < 2).length); // a stack: how many are within 2 m of one of them (itself included)
      if (H.some((z) => z.state === 'search')) searching++;
      if (i >= 35 * 60) { let d = 0, n = 0; for (let a = 0; a < H.length; a++) for (let b = a + 1; b < H.length; b++) { d += Math.hypot(H[a].x - H[b].x, H[a].z - H[b].z); n++; } spread += d / n; samples++; }
    }
  }
  assert.ok(searching > 15, `they were searching for a good while (${searching} s sampled)`);
  assert.ok(worstPile <= 2, `never more than 2 within 2 m of each other (saw ${worstPile}): no pile`);
  assert.ok(spread / samples > 9, `they are spread out: mean distance between two of them ${(spread / samples).toFixed(1)} m`);
  assert.ok(farthestPoint <= R + 0.001 && farthestPoint > 8, `every search point is within ${R} m of the noise, and they do go out there (${farthestPoint.toFixed(1)} m)`);
  assert.ok(H.every((z) => z.state === 'idle' || z.state === 'caution'), `after the search they give up: ${H.map((z) => z.state)}`);
});

test('a noise inside a wall does not strand the zombies at it: they give up reaching it and search the area', () => {
  const wall = { x0: -4, x1: 4, z0: -1, z1: 1, y0: 0, y1: 3, tag: 'concrete' }; // the noise is in the middle of this block
  const S = createState(open([hunter(14, 0, 0), hunter(-14, 3, 0), guard], [wall]), 6), H = S.zombies.filter((z) => z.role === 'hunter');
  S.player.x = -39; S.player.z = 39; S.player.hp = 1e9;
  emitNoise(S, 0, 1, 0, 0.9, 'impact', 'arrow');
  let searched = false;
  for (let i = 0; i < 90 * 60; i++) { step(S, idle); if (H.some((z) => z.state === 'search')) searched = true; }
  assert.ok(searched, 'they ended up searching');
  assert.ok(H.every((z) => z.state === 'idle' || z.state === 'caution' || z.state === 'search'), `none is still trying to reach the wall: ${H.map((z) => z.state)}`);
});

test('a hunter that sees the player becomes alert; a wall stops it', () => {
  const clear = createState(open([hunter(0, 0, 0)]), 1);
  clear.player.x = 0; clear.player.z = 10;
  run(clear, 4);
  assert.equal(clear.zombies[0].state, 'alert');
  const walled = createState(open([hunter(0, 0, 0)], [{ x0: -5, x1: 5, z0: 4, z1: 5, y0: 0, y1: 3, tag: 'concrete' }]), 1);
  walled.player.x = 0; walled.player.z = 10;
  run(walled, 6);
  assert.notEqual(walled.zombies[0].state, 'alert');
});

test('losing the target leads alert -> search -> caution -> idle', () => {
  const search = [...TUNING.zombie.search], caution = TUNING.zombie.caution;
  TUNING.zombie.search = [2, 2]; TUNING.zombie.caution = 2;
  try {
    const S = createState(open([hunter(0, 0, 0)]), 3);
    emitNoise(S, 0, 1, 3, 1, 'scream', 'world');
    run(S, 14);
    assert.deepEqual(S.events.filter((e) => e.type === 'state').map((e) => e.to), ['alert', 'search', 'caution', 'idle']);
  } finally { TUNING.zombie.search = search; TUNING.zombie.caution = caution; }
});

test('a headshot kills silently; a body shot wounds and screams', () => {
  const B = TUNING.bow, saved = [B.spread, B.moveSpread, B.swayGrow];
  B.spread = B.moveSpread = B.swayGrow = 0;
  try {
    const shoot = (aimY) => { // aim a little high to cover gravity drop over 10 m
      const S = createState(open([hunter(0, 10, 0)]), 1);
      S.player.x = 0; S.player.z = 0;
      const dy = aimY - 1.4, n = Math.hypot(dy, 10);
      fireArrow(S, [0, dy / n, 10 / n], 1, 'basic');
      run(S, 1);
      return S;
    };
    const head = shoot(1.68 + 0.12);
    assert.equal(head.zombies[0].state, 'dead');
    assert.equal(head.stats.clean, 1);
    assert.equal(head.stats.messy, 0);
    assert.ok(!head.events.some((e) => e.type === 'noise' && e.src === 'zombie' && e.loud > 0.15), 'a headshot makes no scream');
    const body = shoot(1.2 + 0.12);
    assert.equal(body.zombies[0].state, 'alert');
    assert.equal(body.stats.messy, 1);
    assert.ok(body.events.some((e) => e.type === 'noise' && e.kind === 'wound' && e.loud >= 0.9), 'a body shot screams');
  } finally { [B.spread, B.moveSpread, B.swayGrow] = saved; }
});

test('an arrow in a zombie belongs to it: out of reach while it lives, picked up from the body once it is dead', () => {
  const B = TUNING.bow, saved = [B.spread, B.moveSpread, B.swayGrow];
  B.spread = B.moveSpread = B.swayGrow = 0;
  try {
    const S = createState(open([hunter(0, 1.5, 0)]), 1);
    S.player.x = 0; S.player.z = 0;
    const dy = 1.2 - 1.4, n = Math.hypot(dy, 1.5);
    fireArrow(S, [0, dy / n, 1.5 / n], 1, 'basic'); // point blank, into the chest, inside pick-up reach
    run(S, 0.1);
    const a = S.arrows[0], z = S.zombies[0], before = S.player.quiver.basic;
    assert.equal(a.state, 'stuck');
    assert.equal(a.zid, z.id, 'the arrow knows who holds it');
    assert.equal(a.part, 'chest', 'and which body part, so the renderer can pin it there');
    assert.notEqual(z.state, 'dead');
    assert.equal(retrieve(S), false, 'it cannot be taken from a living zombie');
    z.state = 'dead';
    assert.equal(retrieve(S), true, 'but it can from the body');
    assert.equal(S.player.quiver.basic, before + 1);
  } finally { [B.spread, B.moveSpread, B.swayGrow] = saved; }
});

test('the knife: an instant silent kill from behind, a noisy two-stab fight from the front', () => {
  const at = (z, boxes = []) => { const S = createState(open([z], boxes), 1); S.player.x = 0; S.player.z = 0; return S; }; // the player faces +z (yaw 0)
  const behind = at(hunter(0, 1, 0)); // the zombie faces +z, so the player at z = 0 is behind it
  const t = knifeTarget(behind);
  assert.equal(t.z, behind.zombies[0]);
  assert.equal(t.silent, true);
  assert.equal(knife(behind), true);
  assert.equal(behind.zombies[0].state, 'dead');
  assert.deepEqual(behind.events.find((e) => e.type === 'knife'), { type: 'knife', hit: true, id: behind.zombies[0].id, silent: true, killed: true });
  const kill = behind.events.find((e) => e.type === 'kill');
  assert.equal(kill.how, 'knife');
  assert.deepEqual(kill.dir, [0, 0, 1], 'the ragdoll is thrown along the stab');

  const front = at(hunter(0, 1, Math.PI)); // the zombie faces the player: a stab, not an assassination
  assert.equal(knifeTarget(front).silent, false);
  assert.equal(knife(front), true);
  const z = front.zombies[0];
  assert.equal(z.hp, TUNING.zombie.hp - 1, 'one hit point off');
  assert.equal(z.state, 'alert');
  assert.ok(front.events.some((e) => e.type === 'noise' && e.kind === 'wound' && e.loud >= 0.9), 'and it screams');
  assert.equal(knife(front), false, 'the cooldown: pressing again at once does nothing');
  assert.equal(z.hp, TUNING.zombie.hp - 1);
  front.player.knifeCd = 0; // (the cooldown running down is checked below)
  assert.equal(knife(front), true);
  assert.equal(z.state, 'dead', 'the second stab kills');
  assert.ok(front.events.some((e) => e.type === 'kill' && e.how === 'stab'));

  const cd = at(guard); cd.player.knifeCd = TUNING.player.knifeCd;
  run(cd, TUNING.player.knifeCd + 0.05);
  assert.equal(cd.player.knifeCd, 0, 'the cooldown runs down with the sim');

  const walled = at(hunter(0, 1, Math.PI), [{ x0: -2, x1: 2, z0: 0.4, z1: 0.6, y0: 0, y1: 3, tag: 'concrete' }]);
  assert.equal(knifeTarget(walled), null, 'not through a wall');
  assert.equal(knife(walled), false);
  assert.equal(walled.events.find((e) => e.type === 'knife').hit, false, 'a miss is still reported, for the sound and the swing');

  const back = at(hunter(0, -1, Math.PI)); // right behind the player, who faces +z
  assert.equal(knifeTarget(back), null, 'outside the swing arc');
  back.player.yaw = Math.PI;
  assert.ok(knifeTarget(back), 'turn round and it is in front');
  step(back, { mx: 0, mz: 0, aim: [1, 0, 0] });
  assert.ok(Math.abs(back.player.yaw - Math.PI / 2) < 1e-9, 'the sim takes the facing from the aim direction');
});

test('the same seed and inputs give the same run', () => {
  const snap = (S) => JSON.stringify([S.t, S.rng, S.zombies.map((z) => [z.x.toFixed(4), z.z.toFixed(4), z.yaw.toFixed(4), z.state])]);
  const a = createState(LEVEL, 7), b = createState(LEVEL, 7);
  const before = snap(createState(LEVEL, 7));
  for (let i = 0; i < 1800; i++) { step(a, idle); step(b, idle); }
  assert.equal(snap(a), snap(b));
  assert.notEqual(snap(a), before, 'the patrols actually moved');
});

test('terrain: a box needs flat ground; the pad is exactly 0; the relief is the scan\'s (a valley and a plateau); the mirror seam is continuous', () => {
  assert.throws(() => buildLevel(open([], [{ x0: 10, x1: 12, z0: 10, z1: 12, y0: 0, y1: 2, tag: 'wood' }], (x) => 0.1 * x)), /sloped/);
  for (let x = -12; x <= 12; x++) for (let z = -11; z <= 11; z++) assert.equal(LEVEL.terrain(x, z), 0, `the pad is not flat at ${x}, ${z}`);
  let lo = Infinity, hi = -Infinity;
  for (let x = -LEVEL.limit; x <= LEVEL.limit; x += 2) for (let z = -LEVEL.limit; z <= LEVEL.limit; z += 2) { const h = LEVEL.terrain(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); }
  assert.ok(lo < -8 && hi > 20, `relief ${lo.toFixed(1)}..${hi.toFixed(1)} m around the pad`);
  assert.ok(Math.abs(LEVEL.terrain(100.01, 7) - LEVEL.terrain(99.99, 7)) < 0.1, 'continuous across the edge of the baked grid');
  assert.ok(Math.abs(LEVEL.terrain(-99.99, -40) - LEVEL.terrain(-100.01, -40)) < 0.1);
});

test('walking downhill follows the ground with no landing noise; steps carry a surface tag', () => {
  const slope = (x, z) => 0.25 * z;
  const S = createState({ ...open([guard]), terrain: slope, terrainTag: () => 'grass' }, 1);
  assert.ok(Math.abs(S.player.y - slope(0, 30)) < 0.01);
  run(S, 4, { mx: 0, mz: -1, aim: null });
  assert.ok(S.player.z < 24, 'walked downhill');
  assert.ok(Math.abs(S.player.y - slope(S.player.x, S.player.z)) < 0.02, 'y tracks the ground');
  assert.ok(!S.events.some((e) => e.type === 'noise' && e.kind === 'land'), 'no landing noise');
  assert.ok(S.events.some((e) => e.type === 'noise' && e.kind === 'step' && e.tag === 'grass'), 'footsteps carry the surface');
});

test('a hill blocks sight and arrows', () => {
  const hill = (x, z) => 6 * Math.exp(-((x * x + (z - 5) ** 2) / 6.25));
  const flat = createState(open([hunter(0, 10, Math.PI)]), 1);
  flat.player.x = 0; flat.player.z = 0;
  run(flat, 5);
  assert.equal(flat.zombies[0].state, 'alert', 'control: it sees the player without the hill');
  const S = createState(open([hunter(0, 10, Math.PI)], [], hill), 1);
  S.player.x = 0; S.player.z = 0; S.player.y = heightAt(S.level, 0, 0);
  run(S, 5);
  assert.notEqual(S.zombies[0].state, 'alert', 'the hill hides the player');
  const B = TUNING.bow, saved = [B.spread, B.moveSpread, B.swayGrow];
  B.spread = B.moveSpread = B.swayGrow = 0;
  try {
    fireArrow(S, [0, 0, 1], 1, 'basic', [0, S.player.y + 1.6, 0]);
    run(S, 1);
    const a = S.arrows[0];
    assert.equal(a.state, 'stuck');
    assert.ok(a.z < 8, `the arrow stuck in the hill, at z=${a.z.toFixed(1)}`);
  } finally { [B.spread, B.moveSpread, B.swayGrow] = saved; }
});

test('the pin angles land an arrow at 20 to 60 m when fired from the camera', () => {
  const B = TUNING.bow, saved = [B.spread, B.moveSpread, B.swayGrow];
  B.spread = B.moveSpread = B.swayGrow = 0;
  try {
    for (const D of PIN_RANGES) {
      const def = { ...open([guard], [{ x0: -3, x1: 3, z0: D, z1: D + 1, y0: 0, y1: 20, tag: 'concrete' }]), bounds: { x0: -10, z0: -10, w: 20, d: 90 } };
      const S = createState(def, 1);
      S.player.x = 0; S.player.z = 0;
      const th = dropAngle(D);
      fireArrow(S, [0, Math.sin(th), Math.cos(th)], 1, 'basic', [0, 1.6, 0]);
      run(S, 2);
      const a = S.arrows[0];
      assert.equal(a.state, 'stuck', `${D} m: stuck`);
      assert.ok(Math.abs(a.y - 1.6) < 0.3, `${D} m: landed at y=${a.y.toFixed(2)}, wanted 1.6`);
    }
  } finally { [B.spread, B.moveSpread, B.swayGrow] = saved; }
});

test('wind: a pure function of time and seed, still without a level wind, and it moves an arrow about half a metre sideways at 40 m', () => {
  const W = { speed: 6, gust: 4, swing: 0.9 };
  const [a, b, c] = [5, 5, 6].map((seed) => createState({ ...open([guard]), wind: W }, seed));
  const sample = (S) => [0, 7, 31, 90, 250].map((t) => JSON.stringify(windAt(S, t)));
  assert.deepEqual(sample(a), sample(b), 'same seed, same wind');
  assert.notDeepEqual(sample(a), sample(c), 'another seed, another wind');
  assert.equal(windAt(createState(open([guard]), 5)).speed, 0, 'no level wind, no wind');
  const speeds = []; for (let t = 0; t < 900; t++) speeds.push(windAt(a, t).speed);
  assert.ok(Math.max(...speeds) > Math.min(...speeds) + 2, 'it swells and gusts');
  assert.ok(Math.max(...speeds) <= W.speed + W.gust + 1e-9 && Math.min(...speeds) >= W.speed * 0.65 - 1e-9, 'within its range');

  const D = 40, shot = (wind) => {
    const def = { ...open([guard], [{ x0: -10, x1: 10, z0: D, z1: D + 1, y0: 0, y1: 20, tag: 'concrete' }]), bounds: { x0: -15, z0: -10, w: 30, d: 90 }, wind };
    const S = createState(def, 1); S.player.x = 0; S.player.z = 0;
    const th = dropAngle(D); fireArrow(S, [0, Math.sin(th), Math.cos(th)], 1, 'basic', [0, 1.6, 0]);
    run(S, 2);
    return S.arrows[0];
  };
  const B = TUNING.bow, saved = [B.spread, B.moveSpread, B.swayGrow];
  B.spread = B.moveSpread = B.swayGrow = 0;
  try {
    const calm = shot(undefined), blown = shot({ speed: 6, gust: 0, swing: 0, vary: 0, dir: Math.PI / 2 }); // dir pi/2: toward +x
    assert.ok(Math.abs(calm.x) < 0.02, 'no wind, no drift');
    assert.ok(blown.x > 0.3 && blown.x < 0.8, `a 6 m/s wind toward +x moved the arrow ${blown.x.toFixed(2)} m at 40 m`);
  } finally { [B.spread, B.moveSpread, B.swayGrow] = saved; }
});

test('a scout on high ground sees far and down, calls the others to where the player is, and keeps reporting while it sees them', () => {
  const vantage = { x0: -1, x1: 1, z0: -1, z1: 1, y0: 0, y1: 10, tag: 'rock' };
  const long = (spawns) => ({ ...open(spawns, [vantage]), bounds: { x0: -40, z0: -40, w: 80, d: 120 } }); // the post is at z = 0 and the player at z = 24: keep the level long enough
  const S = createState(long([{ role: 'scout', x: 0, z: 0, yaw: 0 }, hunter(10, 2, Math.PI)]), 1);
  assert.equal(S.zombies[0].y, 10, 'the scout stands on the vantage point');
  S.player.x = 0; S.player.z = 24; // 24 m away and 10 m below: well beyond a hunter's 20 m, and out of its 4 m vertical reach too
  for (let i = 0; i < 3600 && S.zombies[0].state !== 'alert'; i++) step(S, idle); // it sweeps its gaze, so wait for it to find the player
  assert.equal(S.zombies[0].state, 'alert', 'the scout sees the player from 24 m, down a 10 m drop');
  run(S, 0.3);
  const hunterZ = S.zombies[1];
  assert.ok(hunterZ.stim && Math.hypot(hunterZ.stim.x, hunterZ.stim.z - 24) < 0.5, 'the call names the player, 22 m from that hunter, which could not see them');
  assert.notEqual(hunterZ.state, 'idle');

  S.player.x = 15; // the player moves: the scout keeps telling the others where they are now
  run(S, TUNING.zombie.scoutReport + 1);
  assert.ok(Math.hypot(hunterZ.stim.x - 15, hunterZ.stim.z - 24) < 0.5, 'the hunter is told the new position');

  const plain = createState(open([{ role: 'hunter', x: 0, z: 0, yaw: 0, patrol: [] }], [vantage]), 1); // the same post, without the scout's eyes
  plain.player.x = 0; plain.player.z = 15;
  run(plain, 4);
  assert.equal(plain.zombies[0].meter, 0, 'a hunter cannot see 10 m down');
});

test('a scout alarm points the hunters at the player, and an alert hunter pulls its pack', () => {
  const S = createState(open([{ role: 'scout', x: 0, z: 0, yaw: 0 }, hunter(10, 0, Math.PI), hunter(-12, 4, Math.PI)]), 1);
  S.player.x = 0; S.player.z = 12;
  for (let i = 0; i < 900 && S.zombies[0].state !== 'alert'; i++) step(S, idle); // the scout sweeps its gaze, so wait for it
  run(S, 0.3);
  assert.equal(S.zombies[0].state, 'alert');
  for (const h of S.zombies.slice(1)) {
    assert.ok(h.stim && Math.hypot(h.stim.x, h.stim.z - 12) < 0.5, 'the alarm names the player, not the scout');
    assert.notEqual(h.state, 'idle');
  }
  const pack = createState(open([hunter(0, 0, 0), hunter(6, -3, Math.PI)]), 1);
  pack.player.x = 0; pack.player.z = 8;
  run(pack, 5);
  assert.equal(pack.zombies[0].state, 'alert');
  assert.notEqual(pack.zombies[1].state, 'idle', 'its neighbour was pulled in');
});

test('events carry what audio needs: surface tags, alert and bell positions', () => {
  const S = createState({ ...open([hunter(0, 14, Math.PI)]), terrainTag: () => 'grass' }, 1);
  S.player.x = 0; S.player.z = 0;
  fireArrow(S, [0, -0.2, 1], 1, 'basic');
  run(S, 4, { mx: 1, mz: 0, aim: null });
  const noise = (kind) => S.events.find((e) => e.type === 'noise' && e.kind === kind);
  assert.equal(noise('step')?.tag, 'grass');
  assert.equal(noise('impact')?.tag, 'grass');
  for (const type of ['alert', 'bell']) {
    const e = S.events.find((x) => x.type === type);
    assert.ok(e && [e.x, e.y, e.z].every(Number.isFinite), `${type} event has a position`);
  }
});
