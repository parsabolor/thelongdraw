// Tests for the renderer's ground (src/level.js terrainGrid / terrainSurface): the fine mesh must meet the coarse ring without cracks, lie flat on the
// pad (the fort's boxes stand on y = 0), pass through the same heights as the sim at every grid point, and never drift far from them in between.
import test from 'node:test';
import assert from 'node:assert/strict';
import { terrainGrid, terrainSurface, terrainHeight, LEVEL } from '../src/level.js';

const G = terrainGrid({ outer: 140, inner: 60, sub: 4 }), P = G.positions, I = G.indices;

test('terrain mesh: valid indices, no NaN, every face looks up, about half a million triangles', () => {
  assert.ok(P.every(Number.isFinite), 'finite');
  assert.ok(G.counts.triangles > 400000 && G.counts.triangles < 800000, `${G.counts.triangles} triangles`);
  let bad = 0, down = 0;
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
    if (Math.max(I[t], I[t + 1], I[t + 2]) >= P.length / 3) { bad++; continue; }
    if ((P[b + 2] - P[a + 2]) * (P[c] - P[a]) - (P[b] - P[a]) * (P[c + 2] - P[a + 2]) <= 0) down++; // the y of (b - a) x (c - a) must be positive
  }
  assert.deepEqual([bad, down], [0, 0]);
});

test('terrain mesh: the fine block meets the 1 m ring exactly (no cracks): its edge lies on the straight line between the grid points', () => {
  const inner = 60, edge = []; // every vertex on the block's edge that is not a grid point
  for (let v = 0; v < P.length / 3; v++) {
    const x = P[3 * v], z = P[3 * v + 2], onEdge = (Math.abs(Math.abs(x) - inner) < 1e-6 && Math.abs(z) <= inner) || (Math.abs(Math.abs(z) - inner) < 1e-6 && Math.abs(x) <= inner);
    if (onEdge && (Math.abs(x - Math.round(x)) > 1e-6 || Math.abs(z - Math.round(z)) > 1e-6)) edge.push(v);
  }
  assert.ok(edge.length > 900, `${edge.length} edge vertices between grid points`);
  for (const v of edge) {
    const x = P[3 * v], z = P[3 * v + 2], alongX = Math.abs(Math.abs(z) - inner) < 1e-6, t = (alongX ? x : z) - Math.floor(alongX ? x : z);
    const a = alongX ? [Math.floor(x), z] : [x, Math.floor(z)], b = alongX ? [Math.floor(x) + 1, z] : [x, Math.floor(z) + 1];
    const want = terrainHeight(...a) * (1 - t) + terrainHeight(...b) * t;
    assert.ok(Math.abs(P[3 * v + 1] - want) < 1e-5, `edge vertex (${x}, ${z}) is ${P[3 * v + 1]} vs the chord ${want}`);
  }
});

test('terrain surface: through the sim\'s heights at every grid point, within 30 cm of them between, and flat on the fort pad', () => {
  let worst = 0, n = 0;
  for (let x = -58; x <= 58; x += 1) for (let z = -58; z <= 58; z += 1) {
    assert.equal(terrainSurface(x, z), terrainHeight(x, z), `at the grid point ${x}, ${z}`);
    for (const [dx, dz] of [[0.25, 0.5], [0.5, 0.5], [0.75, 0.25]]) { worst = Math.max(worst, Math.abs(terrainSurface(x + dx, z + dz) - terrainHeight(x + dx, z + dz))); n++; }
  }
  assert.ok(worst < 0.3, `the surface is at most ${worst.toFixed(2)} m off the sim's bilinear ground (${n} samples)`);
  for (let x = -9.5; x <= 9.5; x += 0.5) for (let z = -8.5; z <= 8.5; z += 0.5) assert.equal(terrainSurface(x, z), 0, `the pad is exactly flat at ${x}, ${z}`);
  assert.ok(LEVEL.terrain === terrainHeight, 'the sim still uses the bilinear terrain');
});
