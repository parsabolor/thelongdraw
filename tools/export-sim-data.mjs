// Exports the outpost as data for the Rust port of the simulation, so that there is one source of the level (this repo's level.js, shell-data.js and world-data.js) and the
// engine reads what this writes:
//
//   node tools/export-sim-data.mjs [dir]     writes dir/outpost.level.json and dir/tuning.json (default sim-data)
//
// tuning.json is the simulation's TUNING table as it is (JSON keeps every double whole): the port compares its own copy of the numbers with it, field by field.
//
// Format (longdraw-level/1), all grids little-endian float32 as base64, row = z, column = x:
//   terrain: the terrain function of the level (terrainHeight in level.js: bilinear between the 1 m samples, mirrored beyond the grid so it stays continuous), as its samples
//            after the scouts' towers have levelled the ground under them: {n, x0, z0, step, pad: {hx, hz}, heights}
//   def:     the level definition buildLevel() takes (bounds, boxes, props, limit, seal, start, bike, enter, wind, bell, patrol, spawns), without the functions
//   built:   what buildLevel(def) makes from it (w, d, x0, z0, minY, sealed, and the grids ter, obs, h, plus obsTag as a table of tag names and one byte per cell), so the port
//            can check its own buildLevel against the original, cell for cell
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVEL, terrainHeight } from '../src/level.js';
import { WORLD } from '../src/world-data.js';
import { buildLevel, TUNING } from '../src/sim.js';

export const LEVEL_FORMAT = 'longdraw-level/1';
const f32 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

export function exportOutpost() {
  const n = WORLD.n, samples = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) samples[j * n + i] = terrainHeight(WORLD.x0 + i * WORLD.step, WORLD.z0 + j * WORLD.step); // at a grid point it is the sample itself
  const L = buildLevel(LEVEL);
  const tags = [...new Set(L.obsTag.filter((t) => t !== null))].sort();
  const def = { ...LEVEL }; // the two functions are described by `terrain` above and by the rule in level.js (terrainTag is ported as it is)
  delete def.terrain; delete def.terrainTag;
  return {
    format: LEVEL_FORMAT, name: 'outpost',
    terrain: { n, x0: WORLD.x0, z0: WORLD.z0, step: WORLD.step, pad: WORLD.pad, heights: f32(samples) },
    def,
    built: {
      w: L.w, d: L.d, x0: L.x0, z0: L.z0, minY: L.minY, sealed: L.sealed, ter: f32(L.ter), obs: f32(L.obs), h: f32(L.h),
      obsTag: { tags, cells: Buffer.from(Uint8Array.from(L.obsTag, (t) => (t === null ? 0 : tags.indexOf(t) + 1))).toString('base64') },
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || fileURLToPath(new URL('../sim-data', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const level = exportOutpost();
  writeFileSync(join(dir, 'outpost.level.json'), JSON.stringify(level));
  writeFileSync(join(dir, 'tuning.json'), JSON.stringify(TUNING));
  console.log(`tuning.json: ${Object.keys(TUNING).length} sections`);
  console.log(`outpost.level.json: ${level.def.boxes.length} boxes, ${level.def.props.length} props, ${level.def.spawns.length} spawns, ${level.built.w} x ${level.built.d} cells`);
}
