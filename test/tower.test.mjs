// The scouts' lookout towers on the REAL level (level.js TOWER, TOWERS): a body climbs the stair onto the deck and stands at its height, walks under the deck only where the
// drawing leaves room, is stopped by the posts, rails and palisade, falls off the deck's open edge; arrows meet the deck where it is drawn; zombies climb after the player.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL, TOWER, TOWERS } from '../src/level.js';
import { createState, step, floorAt, heightAt, rayWorld, fireArrow, emitNoise, TUNING } from '../src/sim.js';

// A point of tower t's frame (u up the stair, v across it) in the world, and a world point in its frame.
const at = (t, u, v) => [t.x + t.c * u + t.s * v, t.z - t.s * u + t.c * v];
const frame = (t, x, z) => [t.c * (x - t.x) - t.s * (z - t.z), t.s * (x - t.x) + t.c * (z - t.z)];
// The outpost with the player at (u, v) of tower t standing on what is there, and only one zombie: a sleeper far off (so the game is not over).
function on(t, u, v, y = -Infinity) {
  const S = createState(LEVEL, 1), [x, z] = at(t, u, v);
  S.zombies = [S.zombies.find((q) => q.role === 'sleeper')];
  Object.assign(S.player, { x, z, y: floorAt(S.level, x, z, Math.max(y, heightAt(S.level, x, z))), hp: 1e9 });
  return S;
}
// Walks the player in the frame's direction (du, dv) for `secs`; returns the heights it stood at, and whether it was ever falling.
function walk(S, t, du, dv, secs) {
  const ys = []; let fell = false;
  for (let i = 0; i < secs * 60; i++) {
    step(S, { mx: t.c * du + t.s * dv, mz: t.c * dv - t.s * du, aim: null });
    ys.push(S.player.y); fell ||= S.player.falling;
  }
  return { ys, fell };
}
const deckY = (t) => t.base + TOWER.deck;

test('the player walks up each tower\'s stair onto the deck and stands at its height, climbing all the way, and back down to the ground', () => {
  for (const t of TOWERS) {
    const S = on(t, -7, 0.12), up = walk(S, t, 1, 0, 6);
    assert.ok(!up.fell, `the climb at ${t.x}, ${t.z} never falls`);
    assert.ok(up.ys.every((y, i) => i === 0 || y >= up.ys[i - 1] - 1e-9), 'it only goes up');
    assert.ok(Math.abs(S.player.y - deckY(t)) < 1e-9, `on the deck: ${(S.player.y - t.base).toFixed(3)} m over the base`);
    const [u] = frame(t, S.player.x, S.player.z);
    assert.ok(u > 0.5 && u < 1.2, `across the deck to the far rail (u ${u.toFixed(2)})`);
    const down = walk(S, t, -1, 0, 6);
    assert.ok(!down.fell && Math.abs(S.player.y - heightAt(S.level, S.player.x, S.player.z)) < 1e-9, 'and down again to the ground, step by step');
  }
  for (const turn of [-0.5, 0.5]) { // heading 30 degrees off the stair's line, from its middle: still up it
    const t = TOWERS[1], S = on(t, -3.5, 0.12, t.base + 1.2), y0 = S.player.y;
    walk(S, t, Math.cos(turn), Math.sin(turn), 0.5);
    assert.ok(S.player.y > y0 + 0.4 && !S.player.falling, `up the stair at ${turn} rad off its line`);
  }
});

test('the posts, the palisade and the rails stop a body; off the side of the stair it falls to the ground', () => {
  const t = TOWERS[0];
  let S = on(t, 3, 1.3); // beside the +u +v post, walking at it along the deck's side (the strut leaning on it alone would let him to u 1.72)
  walk(S, t, -1, 0, 2);
  let [u, v] = frame(t, S.player.x, S.player.z);
  assert.ok(u > 1.43 + TUNING.player.radius - 0.01, `stopped by the post (u ${u.toFixed(2)})`);
  S = on(t, -3, -3); // beside the palisade, walking at it
  walk(S, t, 0, 1, 2);
  [u, v] = frame(t, S.player.x, S.player.z);
  assert.ok(v < -1.44 - TUNING.player.radius + 0.01, `stopped by the palisade (v ${v.toFixed(2)})`);
  S = on(t, -2, -0.7, t.base + 3); // high on the stair beside the palisade, walking at it: not up onto its top and over
  walk(S, t, 0, -1, 2);
  [u, v] = frame(t, S.player.x, S.player.z);
  assert.ok(v > -1.11 + TUNING.player.radius - 0.01 && S.player.y > t.base + 2.5, `held on the stair by the palisade (v ${v.toFixed(2)}, ${(S.player.y - t.base).toFixed(2)} m up)`);
  S = on(t, 0, 0, deckY(t)); // on the deck, walking at the far rail
  walk(S, t, 1, 0, 2);
  [u] = frame(t, S.player.x, S.player.z);
  assert.ok(u < 1.21 - TUNING.player.radius + 0.01 && S.player.y === deckY(t), `the rail holds him on the deck (u ${u.toFixed(2)})`);
  S = on(t, -2.5, 0.5, t.base + 2.4); // half way up the stair, stepping off its open side
  const fall = walk(S, t, 0, 1, 2.5);
  assert.ok(fall.fell && Math.abs(S.player.y - heightAt(S.level, S.player.x, S.player.z)) < 1e-9, `fell to the ground (${(S.player.y - t.base).toFixed(2)} m over the base)`);
  assert.ok(S.events.some((e) => e.type === 'noise' && e.kind === 'land'), 'and landed loud enough to hear');
});

test('a body walks in under a deck from its open side and stands on the ground there; the barred sides keep it out', () => {
  const t = TOWERS[2];
  let S = on(t, 0, 3.5);
  walk(S, t, 0, -1, 3);
  let [u, v] = frame(t, S.player.x, S.player.z);
  assert.ok(v < 0.5 && Math.abs(S.player.y - t.base) < 0.02, `under the deck, on the ground (v ${v.toFixed(2)}, ${(S.player.y - t.base).toFixed(2)} m over the base)`);
  S = on(t, 3.5, 0); // the barred +u side
  walk(S, t, -1, 0, 3);
  [u] = frame(t, S.player.x, S.player.z);
  assert.ok(u > 1.37 + TUNING.player.radius - 0.01, `kept out by the bars (u ${u.toFixed(2)})`);
});

test('an arrow meets a tower where it is drawn: it sticks in the deck from above and passes beside it', () => {
  const t = TOWERS[1], S = on(t, 0, 0, deckY(t)), L = S.level, y = deckY(t);
  const down = (u, v) => { const [x, z] = at(t, u, v); return rayWorld(L, x, y + 1.5, z, x, y - 10, z); }; // (from under the roof)
  const hit = down(0.3, -0.5);
  assert.ok(hit && hit.tag === 'wood' && Math.abs(y + 1.5 - 11.5 * hit.t - y) < 1e-6, 'the planks, at the deck\'s height');
  const beside = down(0, 1.6); // past the +v rail and the deck's edge
  assert.ok(beside && beside.kind === 'ground', 'beside the deck it goes on to the ground');
  // a real shot: the player standing on the deck fires straight down at his feet; the arrow sticks in the planks, and he can pick it up there
  S.player.drawT = TUNING.bow.drawTime;
  fireArrow(S, [0, -1, 0], 1, 'basic', [S.player.x + 0.2, y + 1.4, S.player.z]);
  for (let i = 0; i < 30; i++) step(S, { mx: 0, mz: 0, aim: null });
  const a = S.arrows[0];
  assert.ok(a.state === 'stuck' && a.tag === 'wood' && Math.abs(a.y - y) < 1e-6, `stuck in the deck at ${(a.y - t.base).toFixed(3)} m`);
});

test('zombies climb: a hunter that sees the player on a deck follows him up the stair and attacks him there; a noise up there draws one up, one under the deck does not', () => {
  for (const t of TOWERS) {
    const S = on(t, 0.3, -0.3, deckY(t)), L = S.level, all = createState(LEVEL, 1).zombies.filter((z) => z.role === 'hunter').slice(0, 2);
    all.forEach((z, i) => { [z.x, z.z] = at(t, -9 - i, 3 + i); z.y = heightAt(L, z.x, z.z); z.meter = 1; });
    S.zombies.push(...all);
    let hit = null;
    for (let i = 0; i < 60 * 12 && !hit && !S.over; i++) { step(S, { mx: 0, mz: 0, aim: null }); hit = S.events.find((e) => e.type === 'hit'); }
    assert.ok(hit, `the tower at ${t.x}, ${t.z}: a hunter reached the player on the deck and struck`);
    assert.ok(Math.abs(all.find((q) => q.id === hit.id).y - deckY(t)) < 1e-9, 'standing on the deck');
    for (const q of all) assert.ok(Math.abs(q.y - floorAt(L, q.x, q.z, q.y)) < 1e-9, 'and neither of the two stands in the air or in the boards');
  }
  const t = TOWERS[0], hunterAt = (y) => {
    const S = on(t, 0, 0, y), L = S.level, z = createState(LEVEL, 1).zombies.find((q) => q.role === 'hunter');
    [z.x, z.z] = at(t, -9, 3); z.y = heightAt(L, z.x, z.z); S.zombies.push(z);
    const [x, zz] = at(t, 0, 0);
    emitNoise(S, x, y + 1, zz, 0.6, 'impact');
    let top = -Infinity;
    for (let i = 0; i < 60 * 12; i++) { step(S, { mx: 0, mz: 0, aim: null }); top = Math.max(top, z.y); }
    return top - t.base;
  };
  assert.ok(hunterAt(deckY(t)) > TOWER.deck - 1e-9, 'a noise on the deck: it goes up to look');
  assert.ok(hunterAt(t.base) < 0.5, 'a noise under the deck: it stays on the ground');
});

test('a jump over the rail of the deck on the fort side drops the player to the ground below: a way off the tower other than the stair', () => {
  const t = TOWERS[0], S = on(t, 0, 0.6, deckY(t));
  let over = false;
  for (let i = 0; i < 120; i++) { step(S, { mx: t.s, mz: t.c, aim: null, jump: true }); over ||= frame(t, S.player.x, S.player.z)[1] > 1.4; } // (+v, held)
  assert.ok(over, 'over the rail');
  for (let i = 0; i < 120 && S.player.falling; i++) step(S, { mx: 0, mz: 0, aim: null });
  assert.ok(Math.abs(S.player.y - heightAt(S.level, S.player.x, S.player.z)) < 1e-9, `down on the ground (${(S.player.y - t.base).toFixed(2)} m over the base)`);
  assert.ok(S.events.some((e) => e.type === 'noise' && e.kind === 'land' && e.loud > 0.3), 'landing loud after a 3 m drop');
});

test('a jump on a deck lands on the deck, one on the stair on the stair; under the deck the bar over the way in stops the head', () => {
  const t = TOWERS[0];
  let S = on(t, 0.3, -0.3, deckY(t)), top = 0;
  step(S, { mx: 0, mz: 0, aim: null, jump: true });
  while (S.player.falling) { step(S, { mx: 0, mz: 0, aim: null }); top = Math.max(top, S.player.y); }
  assert.ok(top > deckY(t) + 0.4 && S.player.y === deckY(t), `up ${(top - deckY(t)).toFixed(2)} m and down on the planks`);
  assert.ok(S.events.some((e) => e.type === 'noise' && e.kind === 'land' && e.tag === 'wood'), 'a landing on wood');
  S = on(t, -3, 0.12, t.base + 1.5); const y0 = S.player.y;
  step(S, { mx: 0, mz: 0, aim: null, jump: true });
  while (S.player.falling) step(S, { mx: 0, mz: 0, aim: null });
  assert.ok(Math.abs(S.player.y - y0) < 1e-9, 'back on the same tread');
  S = on(t, 0, 1.24); // under the bar at 1.91 m over the way in under the deck: a 1.8 m body has 0.11 m over its head
  step(S, { mx: 0, mz: 0, aim: null, jump: true });
  top = 0; while (S.player.falling) { step(S, { mx: 0, mz: 0, aim: null }); top = Math.max(top, S.player.y - t.base); }
  assert.ok(top < 0.12 && Math.abs(S.player.y - t.base) < 0.02, `the head stopped at the bar: up only ${top.toFixed(3)} m`);
});

test('the browser draws the tower the rules climb: its feet on the ground, its planks at the deck\'s height, its stair and posts where the parts are', async (t) => {
  const FBX = new URL('../assets/models/game/hut.fbx', import.meta.url);
  if (!(await import('node:fs')).existsSync(FBX)) return t.skip('assets/models/game/hut.fbx not present');
  globalThis.document ??= { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, set src(v) {}, style: {} }) }; // FBXLoader builds image elements for textures
  globalThis.location ??= { search: '' }; // (models.js reads the page's query)
  const THREE = await import('three'), { FBXLoader } = await import('three/addons/loaders/FBXLoader.js'), { PROPS, raiseDeck, normalise, standTowerOnGround } = await import('../src/models.js');
  const { terrainSurface } = await import('../src/level.js'), fs = await import('node:fs');
  const buf = fs.readFileSync(FBX), warn = console.warn;
  console.warn = () => {}; // (it warns about the textures it does not load)
  let scene; try { scene = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), ''); } finally { console.warn = warn; }
  const tw = TOWERS[1], S = createState(LEVEL, 1), { root } = normalise(raiseDeck(scene, PROPS.tower), PROPS.tower);
  root.position.set(tw.x, tw.base, tw.z); root.rotation.y = tw.yaw;
  standTowerOnGround(root, tw.base, terrainSurface, TOWER.foot);
  root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(), down = (u, v, from) => { const [x, z] = at(tw, u, v); ray.set(new THREE.Vector3(x, from, z), new THREE.Vector3(0, -1, 0)); return ray.intersectObject(root, true).map((h) => h.point.y - tw.base); };
  for (const [u, v] of [[0.3, -0.5], [-0.6, 0.5], [0.6, 0.9]]) { const top = down(u, v, tw.base + 4)[0]; assert.ok(Math.abs(top - TOWER.deck) < 0.05, `the planks at (${u}, ${v}) are ${top.toFixed(3)} m over the base`); }
  for (const u of [-4.64, -3.79, -2.95, -2.1]) { // the treads' middles, where the rules' ramp runs through them
    const [x, z] = at(tw, u, 0.12), rule = floorAt(S.level, x, z, 1e9) - tw.base, drawn = down(u, 0.12, tw.base + 3.3)[0];
    assert.ok(Math.abs(drawn - rule) < 0.2, `the tread at u ${u} is drawn at ${drawn.toFixed(2)} m, the ramp there ${rule.toFixed(2)} m`);
  }
  let foot = Infinity; // the bottom of the +u +v post, where the ground is level
  root.traverse((o) => { if (!o.isMesh) return; const p = o.geometry.attributes.position, w = new THREE.Vector3(); for (let i = 0; i < p.count; i++) { w.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); const [u, v] = frame(tw, w.x, w.z); if (u > 1.12 && u < 1.43 && v > 1.11 && v < 1.42) foot = Math.min(foot, w.y - tw.base); } });
  assert.ok(Math.abs(foot) < 0.03, `its post stands on the ground (its foot ${foot.toFixed(3)} m over the base)`);
  const [px, pz] = at(tw, 1.28, 3); // across toward the +v post 2.5 m up (over the strut leaning on it): it is met where the parts have it (v 1.11 to 1.42)
  ray.set(new THREE.Vector3(px, tw.base + 2.5, pz), new THREE.Vector3(-tw.s, 0, -tw.c));
  const post = 3 - ray.intersectObject(root, true)[0].distance;
  assert.ok(post < 1.45 && post > 1.38, `the post's face at v ${post.toFixed(2)}`);
});
