// models.js: optional downloaded character models (glTF/GLB) behind the same figure interface as characters.js.
// Drop the files in assets/models/ and reload; a missing file is normal and the procedural people are used.
//   zombie: zombie.glb  or  zombie/scene.gltf   (the layout of Sketchfab's glTF download, unzipped)
//   player: player.glb  or  player/scene.gltf
//   credits.txt (optional): shown on the start screen. A CC-BY model must be credited there.
// The model is measured, centred, set on the ground and scaled to a human height, then its animations are mapped by
// name (or by the overrides in CFG). Everything it decided is logged to the console and kept in window.__models.
// Debug: ?clip=N plays clip N on every zombie (to map all of a model's animations in one pass);
//        ?zombie=URL and ?player=URL load a model from anywhere.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { createSurvivorFigure } from './survivor.js';
import { createRagdoll, findAnchors } from './ragdoll.js';
import { gaitRate } from './motion.js';
import { createArms as makeArms } from './fparms.js';

// The one tuning surface. yaw: radians to turn the model so it faces +Z. height: metres.
// clips: for each state, a clip name or index to use instead of the name-pattern guess (null = guess).
export const CFG = {
  // cycleSpeed: the ground the walk clip covers per second at normal playback (m/s). Measured on the Mixamo "Zombie Walk": a stance foot moves back
  // 0.27 m/s, a foot sweeps 0.86 m per half cycle of 4.03 s, so 0.36 splits them. gaitRate (motion.js) plays the clip and widens the leg swing to keep the feet on the ground.
  zombie: { yaw: 0, height: 1.8, cycleSpeed: 0.36, clips: { idle: null, walk: null, run: null, attack: null, death: null } },
  player: { yaw: 0, height: 1.82, clips: { idle: null, walk: null, run: null, attack: null, death: null } },
  scout: { yaw: 0, height: 2.0, clips: { idle: null, walk: null, run: null, attack: null, death: null } }, // the supplied "dead man": one 11.7 s clip, so every state plays it
};
const PATTERN = {
  idle: /idle|stand|breath|wait/i, walk: /walk|shamble|limp|move/i, run: /run|sprint|chase|charge|jog/i,
  attack: /attack|hit|bite|punch|swipe|claw|strike/i, death: /death|die|dead|fall|collapse/i,
};
const TINT = { hunter: [1, 1, 1], scout: [0.7, 0.95, 1.35], sleeper: [1.05, 1, 0.8], screamer: [1.25, 0.85, 0.85], player: [1, 1, 1] };
// A file the user drops in assets/models/ wins over the prepared ones in assets/models/game/ (tools/prep-assets.mjs).
const FILES = {
  zombie: ['zombie.glb', 'zombie/scene.gltf', 'zombie/scene.glb', 'game/zombie.fbx'],
  player: ['player.glb', 'player/scene.gltf', 'player/scene.glb', 'game/survivor.fbx'],
  scout: ['game/scout.glb'], // from tools/prep-scout.mjs: the raw export has ten vertex attributes, which WebGPU cannot draw
};

const ASSETS = new URL('../assets/', import.meta.url).href; // from this file, so any page (the game, dev/*.html) finds the files
const query = new URLSearchParams(location.search);
const gltfLoader = new GLTFLoader(), texLoader = new THREE.TextureLoader();
const loaders = { fbx: new FBXLoader(), obj: new OBJLoader(), glb: gltfLoader, gltf: gltfLoader };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const rnd = (n) => { const s = Math.sin(n * 127.1 + 1.3) * 43758.5453; return s - Math.floor(s); };

// Any supported format -> { scene, animations }. FBX and OBJ give the Group itself; glTF gives { scene, animations }.
async function loadAny(url) {
  const r = await (loaders[url.split('?')[0].split('.').pop().toLowerCase()] || gltfLoader).loadAsync(url);
  const scene = r.scene || r;
  const cams = []; scene.traverse((o) => o.isCamera && cams.push(o)); cams.forEach((c) => c.removeFromParent()); // FBX exports carry their editor camera
  return { scene, animations: r.animations || [] };
}

// The downloaded FBX/OBJ files carry no usable materials, so the albedo (and normal) maps from tools/prep-assets.mjs are applied by hand.
// spec: { meshName or '*': { albedo, normal, rough, metal } }, the files being relative to assets/models/game/.
const T = (albedo, normal, rough = 0.85, metal = 0, emit = 0) => ({ albedo, normal, rough, metal, emit }); // emit: glow through the albedo map, so a dark prop is still seen at night
const TEX = {
  'game/zombie.fbx': { '*': T('zombie_albedo.jpg', 'zombie_normal.jpg', 0.8) },
  'game/survivor.fbx': Object.fromEntries(['Body', 'Head', 'Legs'].map((p) => [p, T(`survivor_${p.toLowerCase()}_albedo.jpg`, `survivor_${p.toLowerCase()}_normal.jpg`, 0.8)])),
};
function texture(file, srgb) {
  const t = texLoader.load(ASSETS + 'models/game/' + file);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}
function retexture(root, spec) {
  if (!spec) return;
  const made = new Map();
  const material = (s) => {
    if (!made.has(s)) {
      const map = texture(s.albedo, true);
      made.set(s, new THREE.MeshStandardMaterial({ map, normalMap: s.normal ? texture(s.normal, false) : null, roughness: s.rough, metalness: s.metal, emissive: new THREE.Color(s.emit, s.emit, s.emit), emissiveMap: s.emit ? map : null }));
    }
    return made.get(s);
  };
  root.traverse((o) => { const s = o.isMesh && (spec[o.name] || spec['*']); if (s) o.material = material(s); });
}

async function tryLoad(role) {
  const rel = query.get(role) ? null : FILES[role];
  const urls = rel ? rel.map((f) => ASSETS + 'models/' + f) : [query.get(role)];
  for (const [i, url] of urls.entries()) {
    try {
      const r = await loadAny(url);
      if (rel) retexture(r.scene, TEX[rel[i]]);
      const entry = prepare(role, url, r);
      if (entry) return entry;
    } catch (e) { if (!(e && e.response && e.response.status === 404)) console.warn(`[models] ${url}: ${e && e.message}`); }
  }
  return null;
}

// Measure, centre and map animations once per model.
function prepare(role, url, gltf) {
  const scene = gltf.scene, cfg = CFG[role], clips = gltf.animations || [];
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  let tris = 0, rootBone = null;
  scene.traverse((o) => {
    if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    if (o.isBone && !rootBone && !(o.parent && o.parent.isBone)) rootBone = o;
  });
  if (!(tris > 0) || !(size.y > 1e-3) || !Number.isFinite(size.y)) { // a model with no geometry or no height would be invisible or giant
    console.warn(`[models] ${role} <- ${url}: no usable geometry, using the procedural figure`);
    return null;
  }
  const scale = cfg.height / size.y;
  const pick = (key) => {
    const o = cfg.clips[key];
    if (typeof o === 'number') return clips[o] || null;
    if (typeof o === 'string') return clips.find((c) => c.name === o) || null;
    return clips.find((c) => PATTERN[key].test(c.name)) || null;
  };
  const map = {};
  for (const key of Object.keys(PATTERN)) map[key] = pick(key);
  if (!map.idle) map.idle = map.walk || clips[0] || null;
  if (!map.walk) map.walk = map.run || map.idle;
  if (!map.run) map.run = map.walk;
  if (rootBone) { // stop root motion drifting the body away from the figure: keep Y, pin X and Z to the rest pose
    for (const c of clips) for (const t of c.tracks) {
      if (t.name !== rootBone.name + '.position') continue;
      for (let i = 0; i < t.values.length; i += 3) { t.values[i] = rootBone.position.x; t.values[i + 2] = rootBone.position.z; }
    }
  }
  const names = Object.fromEntries(Object.entries(map).map(([k, c]) => [k, c ? c.name : null]));
  console.info(`[models] ${role} <- ${url}: ${Math.round(tris)} triangles; size ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} -> height ${cfg.height} (scale ${scale.toFixed(4)}); root bone: ${rootBone ? rootBone.name : 'none'}; mapped: ${JSON.stringify(names)}`);
  if (clips.length) console.table(clips.map((c, i) => ({ index: i, name: c.name, seconds: +c.duration.toFixed(2), tracks: c.tracks.length })));
  else console.info(`[models] ${role} has no animations: it will bob and lean while moving`);
  const entry = { role, url, scene, clips, map, scale, min: box.min, center, tris };
  (window.__models = window.__models || {})[role] = { url, tris: Math.round(tris), size: size.toArray(), scale, rootBone: rootBone && rootBone.name, clips: clips.map((c) => c.name), map: names };
  return entry;
}

export async function loadModels() {
  const [zombie, player, scout] = await Promise.all([tryLoad('zombie'), tryLoad('player'), tryLoad('scout')]);
  let credits = '';
  try { const r = await fetch(ASSETS + 'models/credits.txt'); if (r.ok) credits = (await r.text()).trim(); } catch { /* optional */ }
  return { zombie, player, scout, credits };
}

// One tinted copy per (source material, kind), shared by every instance of that kind.
const tinted = new Map();
function material(src, kind) {
  const key = src.uuid + kind;
  let m = tinted.get(key);
  if (!m) {
    m = src.clone();
    const t = TINT[kind] || TINT.hunter;
    if (m.color) m.color.multiply(new THREE.Color(t[0], t[1], t[2]));
    if (m.emissive && !m.emissiveMap && m.color) { m.emissive.copy(m.color).multiplyScalar(0.05); if (m.map) m.emissiveMap = m.map; } // never pure black at night (through the albedo map, or it washes the texture flat grey)
    tinted.set(key, m);
  }
  return m;
}

// The survivor's own arms for the first-person view (src/fparms.js), tinted like the rest of the survivor; null (the procedural hands stay) if the model is not the survivor.
// The rig is pushed 11 cm forward and the arms are 10% longer: the bow hand is further from the shoulders than a real arm reaches from where the eye sits.
export function createArms(entry) {
  try { return makeArms(entry, { material: (m) => material(m, 'player'), scale: 1.1, offset: [0, 0, -0.11] }); }
  catch (e) { console.warn(`[models] first-person arms: ${e.message}; using the procedural hands`); return null; }
}

// A shuffling clip's strides are short, so a run swings the thighs wider than authored: each thigh's rotation is scaled about its mean over the clip
// (spherical interpolation past 1). Returns apply(gain), to call after the mixer has posed the bones; gain 1 leaves the pose as authored.
function legSwing(inst, clip) {
  const mean = new Map(), q = new THREE.Quaternion(), first = new THREE.Quaternion();
  inst.traverse((bone) => {
    const tr = bone.isBone && /(Left|Right)UpLeg$/.test(bone.name) && clip.tracks.find((t) => t.name === bone.name + '.quaternion');
    if (!tr) return;
    first.fromArray(tr.values, 0);
    const acc = new THREE.Quaternion(0, 0, 0, 0);
    for (let i = 0; i < tr.values.length; i += 4) { q.fromArray(tr.values, i); if (q.dot(first) < 0) q.set(-q.x, -q.y, -q.z, -q.w); acc.set(acc.x + q.x, acc.y + q.y, acc.z + q.z, acc.w + q.w); }
    mean.set(bone, acc.normalize());
  });
  const d = new THREE.Quaternion(), id = new THREE.Quaternion();
  return (gain) => { if (gain > 1.001) for (const [bone, m] of mean) { d.copy(m).invert().multiply(bone.quaternion); bone.quaternion.copy(m).multiply(id.identity().slerp(d, gain)); } };
}

// Same interface as characters.js: { root, head, update(dt, p), dispose() }.
export function createFigure(entry, z = null) {
  const kind = z ? z.kind : 'player', cfg = CFG[entry.role], tint = entry.role === 'scout' ? 'player' : kind; // 'player' = no tint
  if (entry.role === 'player' && !entry.clips.length) { // a static player model (the survivor): skin it to a skeleton and animate it (src/survivor.js)
    try { return createSurvivorFigure(entry, { height: cfg.height, yaw: cfg.yaw, material: (m) => material(m, kind) }); }
    catch (e) { console.warn(`[models] survivor rig failed (${e.message}); using the static figure`); } // falls through to the static path below
  }
  const inst = clone(entry.scene); // SkeletonUtils: re-binds skinned meshes to cloned bones; geometry and textures stay shared
  inst.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false; // skinned bounds are unreliable
    o.castShadow = entry.tris < 50000; // a very heavy model would cost too much in the shadow pass
    o.receiveShadow = true;
    o.material = Array.isArray(o.material) ? o.material.map((m) => material(m, tint)) : material(o.material, tint);
  });
  // the scout's own model keeps its own colours; a scout drawn with the ordinary zombie model stands taller and bluer, so it reads from afar
  const s = entry.scale * (z ? (0.95 + 0.1 * rnd(z.id)) * (z.kind === 'scout' && entry.role !== 'scout' ? 1.12 : 1) : 1);
  const centre = new THREE.Group(), scaled = new THREE.Group(), turn = new THREE.Group(), root = new THREE.Group();
  centre.position.set(-entry.center.x, -entry.min.y, -entry.center.z); // feet on the ground, middle at the origin
  centre.add(inst); scaled.scale.setScalar(s); scaled.add(centre); turn.rotation.y = cfg.yaw; turn.add(scaled); root.add(turn);
  const head = new THREE.Object3D(); head.position.y = cfg.height * 0.93; root.add(head);

  const mixer = entry.clips.length ? new THREE.AnimationMixer(inst) : null, act = {};
  if (mixer) {
    for (const [k, clip] of Object.entries(entry.map)) if (clip) act[k] = mixer.clipAction(clip);
    for (const k of ['attack', 'death']) if (act[k] && act[k] !== act.idle && act[k] !== act.walk) { act[k].setLoop(THREE.LoopOnce, 1); act[k].clampWhenFinished = true; }
  }
  const swing = mixer && cfg.cycleSpeed && entry.map.walk ? legSwing(inst, entry.map.walk) : null;
  const force = mixer && z && query.get('clip') !== null ? entry.clips[+query.get('clip')] : null;
  if (force) mixer.clipAction(force).play();
  let cur = null, lying = 0, t = rnd((z ? z.id : 0) + 3) * 10;

  // Where an arrow that hit body part `part` (head, chest or hips, from sim.PARTS) sticks: that bone, so it follows the pose and the fall.
  // The exporter duplicates bones (a same-named identity child) and the skinned meshes use a mix of the copies, so the anchors come from the largest
  // skinned skeleton (src/ragdoll.js), not from the first bone with a matching name; the ragdoll drives the same set, so arrows follow the body.
  const anchors = findAnchors(inst) || {};
  let rag = null, ragTried = false, lastSpeed = 0; // the ragdoll that takes over a dead zombie (no death clip) from the pose the mixer froze in

  return {
    root, head, anchor: (part) => anchors[part] || inst,
    update(dt, p = {}) {
      dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
      const speed = Number.isFinite(p.speed) ? p.speed : 0, dead = p.state === 'dead';
      t += dt;
      // p.ground(x, z) = the sim's walkable height, p.anchor = the sim position of the body, p.kill = { dir, part } of the killing blow
      if (dead && mixer && !act.death && p.ground && !ragTried) { // the first dead frame: the mixer froze in the walking pose
        ragTried = true; root.updateMatrixWorld(true);
        rag = createRagdoll({ THREE, model: inst, ground: p.ground, anchor: p.anchor, impulse: { ...p.kill, speed: lastSpeed }, seed: z ? z.id : 0 });
      }
      if (rag) { rag.update(dt); return; } // no mixer update and no tip-over while it is a ragdoll
      if (!dead) lastSpeed = speed;
      if (!mixer) { // a static model: bob and lean while moving, kneel when crouching, tip over when dead
        const moving = !dead && speed > 0.25;
        scaled.position.y = moving ? Math.abs(Math.sin(t * speed * 2.6)) * 0.03 : 0;
        scaled.rotation.x = moving ? 0.07 : 0;
        scaled.scale.y = s * (p.crouch ? 0.78 : 1);
      } else if (force) { mixer.update(dt); return; }
      else if (!(dead && !act.death)) { // a corpse with no death clip stops where it was (then tips over below), it must not keep walking
        let want = 'idle';
        if (dead) want = 'death';
        else if (p.attacking && act.attack) want = 'attack';
        else if (speed > 2.2) want = 'run';
        else if (speed > 0.25) want = 'walk';
        const a = act[want] || act.idle;
        if (a && a !== cur) { a.reset().setEffectiveWeight(1).fadeIn(0.25).play(); if (cur) cur.fadeOut(0.25); cur = a; }
        let gain = 1; // how much wider than authored the legs swing (see legSwing)
        if (a && cfg.cycleSpeed && (want === 'walk' || want === 'run')) ({ rate: a.timeScale, gain } = gaitRate(speed, cfg.cycleSpeed)); // the feet keep up with the body
        else if (a) a.timeScale = want === 'walk' ? clamp(speed / 1.1, 0.5, 1.8) : want === 'run' ? clamp(speed / 3.4, 0.7, 1.6) : act.idle === act.walk && want === 'idle' && entry.role !== 'scout' ? 0.25 : 1; // the scout's one clip is a slow sway already
        mixer.update(dt);
        if (swing) swing(gain);
      }
      if (!(mixer && act.death)) { // no death animation: tip over
        lying = clamp(lying + (dead ? dt * 2 : -dt * 2), 0, 1);
        turn.rotation.x = -lying * Math.PI / 2; turn.position.y = lying * 0.25;
      }
    },
    dispose() { if (rag) rag.dispose(); if (mixer) mixer.uncacheRoot(inst); root.removeFromParent(); },
  };
}

// ---------- props (not figures): knife, arrow, bike, hut ----------
// Each is scaled so its long axis is `long` metres, and moved so the origin sits at `pivot` along that axis (min, max or
// centre; centre on the other two) and, with `floor`, on the bottom. The orientation stays the file's own (knife and arrow
// point along +Z): main.js turns them where they are used.
const PROPS = {
  knife: { url: 'game/knife.fbx', tex: { '*': T('knife_albedo.jpg', 'knife_normal.jpg', 0.4, 0.3, 0.3) }, long: 0.5, axis: 'z', pivot: 'min' },
  arrow: { url: 'game/arrow.obj', tex: { '*': T('arrow_albedo.jpg', 'arrow_normal.jpg', 0.6, 0.1, 0.7) }, long: 0.8, axis: 'z', pivot: 'max', girth: 3 }, // a real 5 mm shaft is a hairline in play: 3x, and the fletching glows
  bike: { url: 'game/bike.glb', long: 2.1, axis: 'x', pivot: 'centre', floor: true }, // textures are embedded
  hut: { url: 'game/hut.fbx', tex: { '*': T('hut_albedo.jpg', 'hut_normal.jpg') }, long: 2.4, axis: 'x', pivot: 'centre', floor: true },
};

function normalise(scene, { long, axis, pivot, floor, girth = 1 }) {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene), size = box.getSize(new THREE.Vector3()), off = box.getCenter(new THREE.Vector3());
  if (pivot === 'min') off[axis] = box.min[axis]; else if (pivot === 'max') off[axis] = box.max[axis];
  if (floor) off.y = box.min.y;
  const inner = new THREE.Group(), root = new THREE.Group(), s = long / size[axis];
  scene.position.sub(off); inner.add(scene); root.add(inner);
  inner.scale.set(...['x', 'y', 'z'].map((k) => (k === axis ? s : s * girth))); // girth thickens the model across its long axis
  return { root, size: size.multiplyScalar(s) };
}

// Loaded after the first frame (the figures are loaded before it): { knife, arrow, bike, hut } with whatever was found.
export async function loadProps() {
  const out = {};
  await Promise.all(Object.entries(PROPS).map(async ([name, spec]) => {
    try {
      const { scene } = await loadAny(ASSETS + 'models/' + spec.url);
      retexture(scene, spec.tex);
      scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      out[name] = normalise(scene, spec);
    } catch (e) { if (!(e && e.response && e.response.status === 404)) console.warn(`[models] ${spec.url}: ${e && e.message}`); }
  }));
  return out;
}
export const cloneProp = (entry) => clone(entry.root); // shares geometry and materials with the loaded prop

// ---------- the world: the cleaned outpost scan ----------
// assets/world/outpost.glb (tools/prep-world.mjs): the fort with the ground slab, the junk and the sliver removed, in the world frame (the pad is the
// origin, y = 0). Returns the scene, or null if the file is missing (the grey collision boxes then stay visible).
export async function loadOutpost() {
  try {
    const { scene } = await loadAny(ASSETS + 'world/outpost.glb');
    scene.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = true;
      for (const m of [].concat(o.material)) { m.roughness = 0.95; m.metalness = 0; if (m.map && m.emissive) { m.emissive.setRGB(0.05, 0.05, 0.05); m.emissiveMap = m.map; } } // never pure black at night, through the albedo
    });
    return scene;
  } catch (e) { if (!(e && e.response && e.response.status === 404)) console.warn(`[models] outpost.glb: ${e && e.message}`); return null; }
}
