// check-shell.mjs: how well does the sight shell agree with the model?   node tools/check-shell.mjs [segments]
// Draws random eye-height segments in and around the outpost and asks two questions of each: does the sim's line of sight (src/sim.js hasLOS, over the boxes in
// src/shell-data.js) say clear, and does the scan itself (tools/meshray.mjs) say clear? The two answers that differ are the shell's mistakes:
//   shell clear, model blocked    a zombie or an arrow sees through a wall that is drawn
//   shell blocked, model clear    a window, a doorway or a gap that is drawn but cannot be used
// Short segments (< 2.5 m) and long ones (> 24 m) are left out; the ground is not part of this test (the sim has the terrain for it). A manual tool: run it after
// tools/prep-shell.mjs or after changing the model, and read the percentages.
import { fileURLToPath } from 'node:url';
import { loadMesh } from './meshray.mjs';
import { buildLevel, hasLOS } from '../src/sim.js';
import { SIGHT_BOXES } from '../src/shell-data.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const N = Number(process.argv[2] || 20000);
const M = await loadMesh(ROOT + 'assets/world/outpost.glb', { ground: true });
const L = buildLevel({ bounds: { x0: -30, z0: -30, w: 60, d: 60 }, boxes: SIGHT_BOXES.map((b) => ({ x0: b[0], x1: b[1], z0: b[2], z1: b[3], y0: b[4], y1: b[5], tag: 'rock', mode: 'sight' })) });
let seed = 99; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const count = { both_clear: 0, both_blocked: 0, shell_clear_model_blocked: 0, shell_blocked_model_clear: 0 }, examples = { shell_clear_model_blocked: [], shell_blocked_model_clear: [] };
for (let i = 0; i < N; i++) {
  const pt = () => [-13 + rnd() * 27, 0.9 + rnd() * 0.9, -12 + rnd() * 26];
  const a = pt(), b = pt(), len = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); if (len < 2.5 || len > 24) continue;
  const shell = hasLOS(L, a[0], a[1], a[2], b[0], b[1], b[2]), model = !M.blocked(a, b);
  const key = shell && model ? 'both_clear' : !shell && !model ? 'both_blocked' : shell ? 'shell_clear_model_blocked' : 'shell_blocked_model_clear'; count[key]++;
  if (examples[key] && examples[key].length < 5) examples[key].push(`(${a.map((v) => v.toFixed(1))}) -> (${b.map((v) => v.toFixed(1))})`);
}
const total = Object.values(count).reduce((x, y) => x + y, 0), pct = (v) => (100 * v / total).toFixed(1) + '%';
console.log(`${SIGHT_BOXES.length} boxes; ${total} segments`);
for (const [k, v] of Object.entries(count)) console.log(`  ${k.padEnd(28)} ${String(v).padStart(6)}  ${pct(v)}`);
console.log(`agreement ${pct(count.both_clear + count.both_blocked)}`);
for (const [k, v] of Object.entries(examples)) if (v.length) { console.log(k + ':'); v.forEach((s) => console.log('   ' + s)); }
