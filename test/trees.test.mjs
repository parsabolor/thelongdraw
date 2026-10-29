// Contract test for src/trees.js: the pure geometry builders (deterministic, no NaN, triangle budget, <= 5 vertex attributes,
// crown clear of the ground, bounding box, trunk radius) and the instancing (110 trees stay under the triangle ceiling).
// Node cannot judge the look: see dev/trees.html. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildTreeVariant, TREE_VARIANTS, createTrees, variantOf } from '../src/trees.js';

const H = 6, MAX_TRIS = 3000, MAX_TOTAL = 350000;
const tris = (g) => g.index.count / 3;
const verts = (g) => { const p = g.attributes.position, out = []; for (let i = 0; i < p.count; i++) out.push([p.getX(i), p.getY(i), p.getZ(i)]); return out; };

for (let v = 0; v < TREE_VARIANTS.length; v++) {
  const name = TREE_VARIANTS[v].name, { trunk, canopy } = buildTreeVariant(v);

  test(`${name}: same output twice`, () => {
    const b = buildTreeVariant(v);
    for (const k of ['trunk', 'canopy']) {
      const x = { trunk, canopy }[k], y = b[k];
      assert.deepEqual(Object.keys(x.attributes), Object.keys(y.attributes));
      for (const a of Object.keys(x.attributes)) assert.deepEqual(x.attributes[a].array, y.attributes[a].array, `${k}.${a}`);
      assert.deepEqual(x.index.array, y.index.array);
    }
  });

  test(`${name}: no NaN, valid indices, at most 5 attributes per geometry`, () => {
    for (const g of [trunk, canopy]) {
      assert.ok(Object.keys(g.attributes).length <= 5, Object.keys(g.attributes).join());
      for (const a of Object.values(g.attributes)) assert.ok(a.array.every(Number.isFinite));
      assert.ok(g.index.array.every((i) => i < g.attributes.position.count));
      const n = g.attributes.normal.array; for (let i = 0; i < n.length; i += 3) assert.ok(Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1) < 1e-4, 'unit normals');
    }
    assert.ok(canopy.attributes.color && !trunk.attributes.color);
  });

  test(`${name}: triangle budget (<= ${MAX_TRIS} for trunk + canopy)`, () => {
    assert.ok(tris(trunk) + tris(canopy) <= MAX_TRIS, `${tris(trunk)} + ${tris(canopy)}`);
    assert.ok(tris(trunk) + tris(canopy) >= 500, 'not degenerate');
  });

  test(`${name}: crown clear of the ground, bounding box, trunk radius`, () => {
    const c = verts(canopy), t = verts(trunk), all = [...c, ...t];
    assert.ok(Math.min(...c.map((p) => p[1])) >= 2.4 - 1e-6, 'lowest canopy vertex >= 2.4 m (2.0 m on a 5 m tree)');
    const crown = Math.max(...c.map((p) => Math.hypot(p[0], p[2])));
    assert.ok(crown >= 1.2 && crown <= 2.4, `crown radius ${crown}`);
    const top = Math.max(...all.map((p) => p[1]));
    assert.ok(top >= H && top <= H * 1.1, `height ${top}`);
    const bottom = Math.min(...t.map((p) => p[1]));
    assert.ok(bottom >= -0.35 && bottom <= -0.25, `trunk sunk ${bottom}`);
    const base = Math.max(...t.filter((p) => p[1] <= 0.001).map((p) => Math.hypot(p[0], p[2])));
    assert.ok(base >= 0.25 && base <= 0.34, `trunk base radius ${base}`);
    const up = t.filter((p) => p[1] >= 5.4 && p[1] <= 5.6), width = Math.max(...[0, 2].map((a) => Math.max(...up.map((p) => p[a])) - Math.min(...up.map((p) => p[a])))); // the trunk leans, so measure width, not distance from the axis
    assert.ok(width < base, `trunk tapers: width ${width} up high vs base radius ${base}`);
  });

  test(`${name}: trunk uv is metres / 1.5, canopy u wraps on whole repeats`, () => {
    const p = trunk.attributes.position, u = trunk.attributes.uv;
    for (let i = 0; i < 111; i++) assert.ok(Math.abs(u.getY(i) - p.getY(i) / 1.5) < 1e-5, 'trunk rings: v = y / 1.5'); // the first 11 rings of 10 + the leader tip
    const base = []; for (let i = 0; i < 10; i++) base.push(u.getX(10 + i)); // ring at y = 0
    assert.ok(Math.abs(Math.max(...base) - Math.PI * 0.25 / 1.5) < 0.05, 'u = half circumference / tileMeters at the mirror line');
    const cu = canopy.attributes.uv; let maxU = 0;
    for (let i = 0; i < cu.count; i++) { maxU = Math.max(maxU, cu.getX(i)); assert.ok(cu.getY(i) >= 0 && cu.getY(i) <= 1); }
    assert.ok(Math.abs(maxU - Math.round(maxU)) < 1e-4, `u max ${maxU}`);
  });
}

test('variants differ from each other', () => {
  const t = TREE_VARIANTS.map((_, v) => tris(buildTreeVariant(v).canopy));
  assert.equal(new Set(t).size, TREE_VARIANTS.length);
});

const fakeTrees = (n) => Array.from({ length: n }, (_, i) => ({ x: i * 7 % 90, y0: (i % 5) * 0.3, z: i * 13 % 80, h: 5 + (i % 4) }));

test('createTrees: 110 trees stay under the triangle ceiling, every tree is drawn once per part', () => {
  const bark = new THREE.MeshStandardMaterial(), trees = fakeTrees(110), g = createTrees({ trees, barkMaterial: bark, seed: 3 });
  const ims = g.children.filter((c) => c.isInstancedMesh);
  let total = 0, trunks = 0, canopies = 0;
  for (const im of ims) { total += tris(im.geometry) * im.count; if (im.material === bark) trunks += im.count; else canopies += im.count; assert.ok(im.castShadow && im.receiveShadow); }
  assert.equal(trunks, 110); assert.equal(canopies, 110);
  assert.equal(total, g.userData.triangles);
  assert.ok(total <= MAX_TOTAL, `${total} triangles`);
  assert.equal(new Set(trees.map((_, i) => variantOf(i, 3))).size, 3, 'all three variants appear');
});

test('createTrees: instance matrices place and scale each tree (translate, yaw, h / 6 in y), deterministically', () => {
  const trees = fakeTrees(30), bark = new THREE.MeshStandardMaterial();
  const mats = () => createTrees({ trees, barkMaterial: bark, seed: 9 }).children.filter((c) => c.material === bark).flatMap((im) => {
    const out = []; for (let i = 0; i < im.count; i++) out.push(im.instanceMatrix.array.slice(i * 16, i * 16 + 16)); return out;
  });
  const a = mats(), b = mats(); assert.deepEqual(a, b);
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  assert.equal(a.length, 30);
  for (const e of a) {
    m.fromArray(e).decompose(p, q, s);
    const t = trees.find((t) => Math.abs(t.x - p.x) < 1e-4 && Math.abs(t.z - p.z) < 1e-4);
    assert.ok(t && Math.abs(t.y0 - p.y) < 1e-4, 'position');
    assert.ok(Math.abs(s.y - t.h / 6) < 1e-5, 'y scale = h / 6');
    const k = Math.sqrt(t.h / 6); for (const w of [s.x, s.z]) assert.ok(w >= k * 0.92 - 1e-5 && w <= k * 1.08 + 1e-5, 'xz scale');
  }
});

test('src/trees.js never calls Math.random (the project is deterministic)', () => {
  assert.ok(!/Math\s*\.\s*random\s*\(/.test(readFileSync(new URL('../src/trees.js', import.meta.url), 'utf8')));
});
