// Tests for src/fx.js (the night's atmosphere). The shaders cannot be compiled without a GPU, so this checks what can go wrong in Node: the module links (every TSL name it
// imports exists), the builders return what main.js expects with the settings that keep them visible, and the sway copy of a material keeps what the original had.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three/webgpu';
import { MIST, MIST_CSS, mistFog, createMotes, swayMaterial, frostGlint } from '../src/fx.js';
import { createFoliageMaterial } from '../src/trees.js';

test('mist: a FogExp2 in the shared mist colour, dense enough that the terrain rim (140 m) is mostly fogged', () => {
  const f = mistFog();
  assert.ok(f.isFogExp2 && f.color.getHex() === MIST);
  assert.equal(MIST_CSS, '#' + MIST.toString(16).padStart(6, '0'), 'the sky horizon uses the same colour as the fog');
  const at140 = 1 - Math.exp(-((f.density * 140) ** 2));
  assert.ok(at140 > 0.8 && at140 < 0.95, `fog factor at 140 m is ${at140.toFixed(2)}`);
});

test('motes: one instanced sprite that is not culled, fog-free, additive and does not write depth', () => {
  const m = createMotes({ count: 300 });
  assert.ok(m.isSprite && m.count === 300);
  assert.equal(m.frustumCulled, false, 'culled by a sphere at its own origin otherwise');
  assert.equal(m.material.fog, false);
  assert.equal(m.material.blending, THREE.AdditiveBlending);
  assert.equal(m.material.depthWrite, false);
  assert.ok(m.material.transparent && m.material.depthTest, 'the depth test stays on, so hills hide them');
  for (const n of ['positionNode', 'scaleNode', 'colorNode', 'opacityNode']) assert.ok(m.material[n] && m.material[n].isNode, n);
  assert.ok(createMotes({ reducedMotion: true }).material.opacityNode.isNode, 'the reduced-motion variant builds too');
});

test('sway: the node copy keeps everything the needles and the bark need (alphaTest, side, maps, colours)', () => {
  const src = createFoliageMaterial(0), m = swayMaterial(src);
  assert.ok(m !== src && m.isMeshStandardNodeMaterial && m.positionNode && m.positionNode.isNode);
  for (const k of ['alphaTest', 'side', 'vertexColors', 'roughness', 'metalness', 'transparent', 'opacity']) assert.equal(m[k], src[k], k);
  assert.ok(src.alphaTest > 0 && m.alphaTest === src.alphaTest, 'without alphaTest the needles turn into solid cards (and their shadows)');
  assert.equal(m.color.getHex(), src.color.getHex()); assert.equal(m.emissive.getHex(), src.emissive.getHex());
  assert.equal(m.map, src.map); assert.equal(m.emissiveMap, src.emissiveMap);
  const bark = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), normalMap: new THREE.Texture(), roughnessMap: new THREE.Texture(), roughness: 0.9, color: 0x887766 });
  bark.normalScale.set(0.5, 0.5);
  const b = swayMaterial(bark);
  assert.ok(b.map === bark.map && b.normalMap === bark.normalMap && b.roughnessMap === bark.roughnessMap && b.roughness === 0.9);
  assert.deepEqual(b.normalScale.toArray(), [0.5, 0.5]);
  assert.equal(bark.positionNode, undefined, 'the shared source material is not touched');
});

test('sway: one copy per source material (not one per mesh), and nothing to do without a material or with reduced motion', () => {
  const src = createFoliageMaterial(1);
  assert.equal(swayMaterial(src), swayMaterial(src));
  assert.equal(swayMaterial(src, { reducedMotion: true }), src);
  assert.equal(swayMaterial(null), null);
});

test('frost glint: a colour node', () => {
  assert.ok(frostGlint().isNode && frostGlint({ radius: 8 }).isNode);
});

test('src/fx.js never calls Math.random (the project is deterministic)', () => {
  assert.ok(!/Math\.random\s*\(/.test(fs.readFileSync(new URL('../src/fx.js', import.meta.url), 'utf8')));
});
