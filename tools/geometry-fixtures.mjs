// Seeded fixtures of the simulation's geometry and path finding on the outpost, for the Rust port's tests: random segments through the world (rayWorld, hasLOS), sphere
// tests (segSphere) and A* paths with string pulling (findPath), each with the original's answer. (Body moves, moveBy, are not exported by sim.js: the traces check them.)
//
//   node tools/geometry-fixtures.mjs [file]     writes the fixtures (default sim-data/geometry.json)
//
// Format (longdraw-geometry-fixtures/1): {rays: [{a, b, skip, hit: null | {t, tag, kind}}], spheres: [{a, b, c, r, t}], paths: [{from, to, path: null | [[x, z]...]}], hypots: [{v: [2 or 3 numbers], h}]}. Numbers are exact (JSON keeps a double whole); the points come from a fixed generator, so the file is the same every time.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVEL } from '../src/level.js';
import { createState, rayWorld, segSphere, findPath, heightAt } from '../src/sim.js';
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
  // Math.hypot of two and three numbers of every size the simulation sees (V8 sums squares with compensation, which a plain sqrt of the sum does not)
  const hypots = [];
  for (let i = 0; i < 600; i++) {
    const k = i % 3 === 0 ? 1 : i % 3 === 1 ? 40 : 0.01, v = Array.from({ length: i % 2 ? 3 : 2 }, () => between(-k, k));
    hypots.push({ v, h: Math.hypot(...v) });
  }
  return { format: FIXTURE_FORMAT, level: 'outpost', rays, spheres, paths, hypots };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] || fileURLToPath(new URL('../sim-data/geometry.json', import.meta.url));
  mkdirSync(dirname(file), { recursive: true });
  const f = geometryFixtures();
  writeFileSync(file, JSON.stringify(f));
  console.log(`${file}: ${f.rays.length} rays (${f.rays.filter((r) => r.hit).length} hit something), ${f.spheres.length} spheres, ${f.paths.length} paths (${f.paths.filter((p) => p.path).length} found), ${f.hypots.length} hypots`);
}
