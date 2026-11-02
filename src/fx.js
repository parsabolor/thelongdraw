// fx.js: the night's atmosphere: a lighter mist in the distance, drifting light motes, wind in the conifers and frost glints on the ground.
// Everything is made in the shader (TSL node materials, WebGPU renderer): no asset files, no per-frame JavaScript, no Math.random. main.js loads this module only
// when the effects are on (?fx=0 turns them all off; ?fx=fog,motes,sway,glint picks some) and builds each effect on its own, so one failing never stops the game.
// Every export is a builder: it takes its inputs and returns an object or a node; nothing here reads the scene or main.js.
//   MIST, MIST_CSS                         the colour of the distant mist. The fog and the sky's horizon use the same value, so far ground fades into the sky with no seam
//   mistFog(density)                       -> THREE.FogExp2. The density stays near 0.01 on purpose: lower, and the rim of the terrain (140 m) shows against the sky
//   createMotes({ count, half, reducedMotion }) -> THREE.Sprite (instanced): warm fireflies that fade in and out slowly, and faint cold dust, in a box that follows the camera
//   swayMaterial(src, { amplitude, reducedMotion }) -> a MeshStandardNodeMaterial like src whose vertices sway in the wind (cached per src); src itself if there is nothing to do
//   frostGlint({ moonDir, radius })        -> a colour node for material.emissiveNode: sparse glints that flash when the view lines up with the moon, within `radius` m
import * as THREE from 'three/webgpu';
import { float, vec2, vec3, time, hash, instanceIndex, cameraPosition, positionLocal, positionGeometry, positionWorld, normalWorld, uv, sin, cos, floor, mod, mix, smoothstep, pow, max, step, length, normalize, dot, reflect, clamp } from 'three/tsl';

const TAU = Math.PI * 2;
export const MIST = 0x22345a, MIST_CSS = '#22345a';
export const mistFog = (density = 0.0098) => new THREE.FogExp2(MIST, density);

export function createMotes({ count = 700, half = 24, reducedMotion = false } = {}) {
  const n = instanceIndex.toFloat();
  const rnd = (k) => hash(n.mul(8).add(k)); // eight independent numbers in 0..1 for each mote
  const wander = reducedMotion ? vec3(0, 0, 0) : vec3(sin(time.mul(0.11).add(rnd(3).mul(TAU))), sin(time.mul(0.17).add(rnd(4).mul(TAU))).mul(0.5), cos(time.mul(0.13).add(rnd(5).mul(TAU)))).mul(1.6);
  // Each mote has a fixed home in a box of side 2 * half; wrapping it around the camera tiles that box over the whole world, so there are always motes near the player and none to move.
  const around = (v, c) => mod(v.sub(c).add(half), 2 * half).sub(half).add(c);
  const x = around(rnd(0).mul(2 * half).add(wander.x), cameraPosition.x), z = around(rnd(1).mul(2 * half).add(wander.z), cameraPosition.z);
  const y = cameraPosition.y.sub(1.8).add(rnd(2).mul(5.5)).add(wander.y); // from about the ground to well above the head, relative to the eye: the terrain is hilly and the shader has no height lookup
  const position = vec3(x, y, z), toEye = position.sub(cameraPosition);
  const fade = smoothstep(1.4, 4, length(toEye)).mul(float(1).sub(smoothstep(half * 0.55, half * 0.95, length(vec2(toEye.x, toEye.z))))); // not at the camera (binoculars would blow them up), not at the box edge

  const fly = step(0.62, rnd(6)); // about four in ten are fireflies, the rest dust
  const blink = reducedMotion ? float(0.7) : smoothstep(0.2, 0.9, sin(time.mul(rnd(7).mul(2.05).add(0.75)).add(rnd(5).mul(TAU))).mul(0.5).add(0.5)); // a slow fade, at most 0.45 Hz: never an on/off flash
  const dust = reducedMotion ? float(0.5) : sin(time.mul(0.5).add(rnd(4).mul(TAU))).mul(0.25).add(0.65);
  const glow = pow(clamp(float(1).sub(length(uv().sub(0.5)).mul(2)), 0, 1), 2.2); // a soft round falloff across the quad

  // blending: additive, no depth write, and fog off (fog would paint fog-coloured discs under additive blending; the fade above is the distance falloff). The depth test stays on so hills and trees hide them.
  const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  material.positionNode = position;
  material.scaleNode = mix(float(0.04), float(0.07), fly);
  material.colorNode = mix(vec3(0.55, 0.72, 1.0).mul(1.3), vec3(1.0, 0.86, 0.4).mul(2.8), fly); // above 1, so the scene's bloom pass lifts them into a glow
  material.opacityNode = glow.mul(fade).mul(mix(dust, blink, fly));
  const motes = new THREE.Sprite(material);
  motes.count = count; motes.name = 'motes';
  motes.frustumCulled = false; // a sprite is culled by a sphere at its own origin, so with the origin out of view every mote would vanish
  motes.renderOrder = 4;
  return motes;
}

// What a material needs to keep when it is rebuilt as a node material. (`copy` would silently drop alphaTest: the needles would turn into solid cards.)
const KEEP = ['map', 'normalMap', 'roughnessMap', 'emissiveMap', 'emissive', 'emissiveIntensity', 'color', 'vertexColors', 'side', 'roughness', 'metalness', 'alphaTest', 'transparent', 'opacity'];
const swayed = new WeakMap();

export function swayMaterial(src, { amplitude = 0.14, reducedMotion = false } = {}) {
  if (!src || reducedMotion || !THREE.MeshStandardNodeMaterial) return src;
  if (swayed.has(src)) return swayed.get(src);
  const params = {};
  for (const k of KEEP) if (src[k] !== undefined && src[k] !== null) params[k] = src[k].isColor ? src[k].clone() : src[k];
  const m = new THREE.MeshStandardNodeMaterial(params);
  if (src.normalScale) m.normalScale.copy(src.normalScale);
  m.name = (src.name || 'tree') + '+sway';
  // Inside positionNode, positionLocal is already in world space (the trees' group is at the origin), and positionGeometry is the model's own, so its height is 0..6 m.
  const grow = positionGeometry.y.div(6).clamp(0, 1.4), bend = grow.mul(grow); // still at the foot, most at the crown
  const phase = positionLocal.xz.mul(0.04), t = time.mul(1.15); // the phase comes from where the tree stands, so a gust crosses the stand and the trunk and crown of one tree agree
  const gx = sin(t.add(phase.x).add(phase.y.mul(0.7))).add(sin(t.mul(1.9).add(phase.y.mul(1.3)).add(1.7)).mul(0.45));
  const gz = sin(t.mul(0.8).add(phase.x.mul(0.6)).add(2.1)).mul(0.6);
  m.positionNode = positionLocal.add(vec3(gx, 0, gz).mul(bend.mul(amplitude))); // the shadow pass uses positionNode too, so the shadows sway with the trees
  swayed.set(src, m);
  return m;
}

export function frostGlint({ moonDir = new THREE.Vector3(-40, 70, -30), radius = 11 } = {}) {
  const L = moonDir.clone().normalize();
  const toEye = cameraPosition.sub(positionWorld), dist = length(toEye), view = toEye.div(dist);
  const grid = positionWorld.xz.mul(12), cell = floor(grid); // cells of about 8 cm, each with its own tiny facet
  const id = cell.x.mul(157).add(cell.y.mul(311)).add(600000); // a positive number to hash
  const a = hash(id.add(1)), b = hash(id.add(2)), c = hash(id.add(3));
  const facet = normalize(normalWorld.add(vec3(a, b, c).sub(0.5).mul(2.2)));
  const glint = pow(max(dot(reflect(view.negate(), facet), vec3(L.x, L.y, L.z)), 0), 40); // bright only where this facet mirrors the moon into the eye: it moves as you move, and does not flicker in time
  const dot2 = float(1).sub(smoothstep(0.1, 0.28, length(grid.sub(cell).sub(0.5)))); // a round dot in the middle of the cell, not the whole square (a square stretches into a dash at a low angle)
  const near = float(1).sub(smoothstep(radius * 0.5, radius, dist)); // finer than a pixel beyond this and it would shimmer
  return vec3(0.7, 0.86, 1.0).mul(glint.mul(step(0.93, hash(id))).mul(dot2).mul(near).mul(clamp(normalWorld.y, 0, 1)).mul(3.5));
}
