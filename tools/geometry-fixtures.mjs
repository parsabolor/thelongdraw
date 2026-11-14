// Seeded fixtures of the simulation's geometry and path finding on the outpost, for the Rust port's tests: random segments through the world (rayWorld, hasLOS), sphere
// tests (segSphere) and A* paths with string pulling (findPath), each with the original's answer; and round the lookout towers, rays at their parts, the floor a body stands on
// (floorAt) and whether a body fits (canStand). (Body moves, moveBy, are not exported by sim.js: the traces check them.)
//
//   node tools/geometry-fixtures.mjs [file]     writes the fixtures (default sim-data/geometry.json)
//
// Format (longdraw-geometry-fixtures/1): {rays: [{a, b, skip, hit: null | {t, tag, kind}}], spheres: [{a, b, c, r, t}], paths: [{from, to, path: null | [[x, z]...]}], hypots: [{v: [2 or 3 numbers], h}],
// floors: [{p: [x, y, z], floor}], bodies: [{p: [x, y, z], r, fits}], sees: [{o, zombie: {x, y, z, state}, points, seen}]} (the tower rays and paths are among the others). Numbers are exact (JSON keeps a double whole); the points come from a fixed generator, so the file is the same every time.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVEL } from '../src/level.js';
import { createState, rayWorld, segSphere, findPath, heightAt, floorAt, canStand, TUNING } from '../src/sim.js';
import * as sim from '../src/sim.js';

export const FIXTURE_FORMAT = 'longdraw-geometry-fixtures/1';

// mulberry32, as in sim.js, kept apart from the simulation's own generator
const generator = (seed) => { const S = { rng: { a: seed } }; return () => sim.rand(S); };

export function geometryFixtures() {
  const S = createState(LEVEL, 1), L = S.level, rnd = generator(12345);
  const between = (lo, hi) => lo + rnd() * (hi - lo);
  const spot = (spread = 55) => { const x = between(-spread, spread), z = between(-spread, spread), g = heightAt(L, x, z); return [x, (Number.isFinite(g) ? g : 0) + between(0.1, 3.5), z]; };
  const rays = [], spheres = [], paths = [];
  for (let i = 0; i < 1500; i++) {
    const a = spot(), b = i % 3 === 0 ? spot() : a.map((v, k) => v + between(-25, 25) * (k === 1 ? 0.2 : 1)), skip = i % 2;
    const hit = rayWorld(L, ...a, ...b, skip);
    rays.push({ a, b, skip, hit: hit ? { t: hit.t, tag: hit.tag, kind: hit.kind } : null });
  }
  for (let i = 0; i < 600; i++) {
    // every other one is aimed at the sphere (a start off to one side, an end within a radius or two of the centre), or nearly all would miss
    const c = spot(30), r = between(0.1, 1.5), near = (k) => [c[0] + between(-k, k), c[1] + between(-k / 4, k / 4), c[2] + between(-k, k)];
    const a = near(8), b = i % 2 ? near(8) : near(r * 1.5);
    spheres.push({ a, b, c, r, t: segSphere(...a, ...b, ...c, r) });
  }
  while (paths.length < 120) {
    const a = spot(50), b = paths.length % 4 === 0 ? spot(80) : [a[0] + between(-30, 30), 0, a[2] + between(-30, 30)];
    paths.push({ from: [a[0], a[2]], to: [b[0], b[2]], path: findPath(L, a[0], a[2], b[0], b[2]) });
  }
  // round each lookout tower: rays from near it at its parts, the floor and the fit of a body at heights from under it to over its deck, and paths past it
  const floors = [], bodies = [];
  for (const t of LEVEL.towers) {
    const near = (u0, u1, v0, v1) => { const u = between(u0, u1), v = between(v0, v1); return [t.x + t.c * u + t.s * v, t.z - t.s * u + t.c * v]; };
    for (let i = 0; i < 300; i++) {
      const [x, z] = near(-7.5, 2.5, -2.5, 2.5), y = t.base + between(-1.5, 5.5);
      floors.push({ p: [x, y, z], floor: floorAt(L, x, z, y) });
      const r = i % 2 ? TUNING.player.radius : 0.5, fy = floorAt(L, x, z, y);
      bodies.push({ p: [x, fy, z], r, fits: canStand(L, x, z, fy, r, TUNING.player.step) });
    }
    for (let i = 0; i < 200; i++) {
      const [ax, az] = near(-12, 6, -6, 6), [bx, bz] = near(-3, 2, -2, 2), a = [ax, t.base + between(-0.5, 8), az], b = [bx, t.base + between(0, 6.5), bz];
      const hit = rayWorld(L, ...a, ...b, i % 2);
      rays.push({ a, b, skip: i % 2, hit: hit ? { t: hit.t, tag: hit.tag, kind: hit.kind } : null });
    }
    for (let i = 0; i < 12; i++) {
      const [ax, az] = near(-10, 4, -8, -3), [bx, bz] = near(-10, 4, 3, 8);
      paths.push({ from: [ax, az], to: [bx, bz], path: findPath(L, ax, az, bx, bz) });
    }
  }
  // Math.hypot of two and three numbers of every size the simulation sees (V8 sums squares with compensation, which a plain sqrt of the sum does not)
  const hypots = [];
  for (let i = 0; i < 600; i++) {
    const k = i % 3 === 0 ? 1 : i % 3 === 1 ? 40 : 0.01, v = Array.from({ length: i % 2 ? 3 : 2 }, () => between(-k, k));
    hypots.push({ v, h: Math.hypot(...v) });
  }
  // the binoculars round the fort (seesZombie): an eye and a zombie, standing or asleep, the points looked for (sightPoints) and whether it is seen
  const sees = [];
  for (let i = 0; i < 400; i++) {
    const o = spot(16), [x, , z] = spot(12), g = heightAt(L, x, z), zombie = { x, y: Number.isFinite(g) ? g : 0, z, state: i % 3 === 0 ? 'dormant' : 'idle' };
    sees.push({ o, zombie, points: sim.sightPoints(o, zombie), seen: sim.seesZombie(S, o, zombie) });
  }
  return { format: FIXTURE_FORMAT, level: 'outpost', rays, spheres, paths, hypots, floors, bodies, sees };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] || fileURLToPath(new URL('../sim-data/geometry.json', import.meta.url));
  mkdirSync(dirname(file), { recursive: true });
  const f = geometryFixtures();
  writeFileSync(file, JSON.stringify(f));
  console.log(`${file}: ${f.rays.length} rays (${f.rays.filter((r) => r.hit).length} hit something), ${f.spheres.length} spheres, ${f.paths.length} paths (${f.paths.filter((p) => p.path).length} found), ${f.hypots.length} hypots, ${f.sees.length} binocular sightings (${f.sees.filter((q) => q.seen).length} seen)`);
}
