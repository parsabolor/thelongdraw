// main.js: rendering, input, HUD and feedback. All game rules live in sim.js. This file reads the sim
// state and feeds it input in fixed 60 Hz steps; it never writes to zombie fields.
// Third person to walk; first person with a slider sight to aim; binoculars to observe and tag.
import * as THREE from 'three';
import { pass } from 'three/tsl';
import { LEVEL, terrainGrid } from './level.js';
import { WORLD } from './world-data.js';
import * as sim from './sim.js';
import { loadMaterials, boxUV } from './materials.js';
import { turnToward, wrapPi } from './motion.js';
import { createTrees } from './trees.js';
import { SWING_TIME } from './survivor.js';
import { attachHeld } from './held.js';
import { detailMaterial } from './detail.js';

const { TUNING } = sim;
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

// Sound, character and bow-model modules are optional: each falls back if its file is missing.
const optional = (path) => import(path).catch((e) => { console.warn(path + ' unavailable: ' + e.message); return null; });
const [audioMod, charMod, bowMod, bloomMod, modelMod] = await Promise.all([
  optional('./audio.js'), optional('./characters.js'), optional('./bow.js'), optional('three/addons/tsl/display/BloomNode.js'), optional('./models.js'),
]);
// Downloaded character models from assets/models/ (see models.js); null where a file is not there.
const models = modelMod ? await modelMod.loadModels() : { zombie: null, player: null, credits: '' };
const bowAssets = bowMod ? await bowMod.loadBowAssets() : null; // the supplied compound bow and Avalon sight; null = the procedural bow
// Props (knife, arrow, bike, hut) are bigger and optional, so they load after the first frame and are used as they arrive.
const props = {};
const propsReady = modelMod ? modelMod.loadProps().then((p) => Object.assign(props, p)).catch((e) => console.warn('props: ' + e.message)) : Promise.resolve();

// ---------- renderer (WebGPU, with Three's automatic WebGL2 fallback) ----------
const canvas = $('view');
let renderer;
try {
  renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
} catch (err) {
  $('loadmsg').textContent = 'Renderer failed: ' + err.message;
  throw err;
}
const backend = renderer.backend && renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2 (fallback)';
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.5;
const mats = await loadMaterials(renderer);

// ---------- night ----------
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.05, 700);
scene.add(cam);
scene.background = new THREE.Color(0x070b14);
scene.fog = new THREE.FogExp2(0x0b1222, 0.0105);
scene.add(new THREE.HemisphereLight(0x33477a, 0x10131a, 1.3));
const MOON_DIR = new THREE.Vector3(-40, 70, -30).normalize();
const moon = new THREE.DirectionalLight(0xa9bfff, 2.1);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
Object.assign(moon.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 260 });
moon.shadow.bias = -0.0005;
moon.shadow.normalBias = 0.04;
scene.add(moon, moon.target);

function skyTexture() { // a star field painted once, wrapped on a dome around the camera
  const c = document.createElement('canvas'); c.width = 4096; c.height = 2048;
  const g = c.getContext('2d'), grad = g.createLinearGradient(0, 0, 0, 2048);
  grad.addColorStop(0, '#03050b'); grad.addColorStop(0.55, '#09112a'); grad.addColorStop(1, '#16223f');
  g.fillStyle = grad; g.fillRect(0, 0, 4096, 2048);
  let s = 7; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = `rgba(255,255,255,${0.2 + r() * 0.8})`;
    g.beginPath(); g.arc(r() * 4096, r() * 1500, r() < 0.04 ? 1.5 : 0.55 + r() * 0.35, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const sky = new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false }));
const moonDisc = new THREE.Mesh(new THREE.SphereGeometry(14, 24, 16), new THREE.MeshBasicMaterial({ color: 0xe6eeff, fog: false }));
const moonGlow = new THREE.Mesh(new THREE.SphereGeometry(34, 24, 16), new THREE.MeshBasicMaterial({ color: 0x8fa8ff, fog: false, transparent: true, opacity: 0.16, depthWrite: false }));
moonDisc.position.copy(MOON_DIR).multiplyScalar(380); moonGlow.position.copy(moonDisc.position);
sky.renderOrder = -2;
scene.add(sky, moonDisc, moonGlow);

// ---------- terrain, road, level boxes, props ----------
let S = sim.createState(LEVEL, 1);

// The terrain: the baked world (src/level.js terrainGrid): a smooth surface subdivided to 0.25 m cells within 60 m of the middle, the plain 1 m grid out to
// 140 m (beyond the sim's own bounds the ground mirrors itself), textured with the supplied scan's colour and normal maps.
const haveScan = await fetch('./assets/world/terrain_albedo.jpg', { method: 'HEAD' }).then((r) => r.ok && (r.headers.get('content-type') || '').startsWith('image/')).catch(() => false); // is the supplied scan's colour map there? (a server that answers every path with its index page does not count)
function buildTerrain() {
  const grid = terrainGrid({ outer: 140, inner: 60, sub: 4 });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(grid.positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(grid.uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(grid.indices, 1));
  geo.computeVertexNormals();
  const tex = (url, srgb) => { const t = new THREE.TextureLoader().load(url); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; return t; };
  // Without the scan's texture files (they are not in the public repo, see README) the ground is a neutral rocky base under the same gravel detail.
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true; white.colorSpace = THREE.SRGBColorSpace;
  const scan = haveScan
    ? new THREE.MeshStandardMaterial({ map: tex('./assets/world/terrain_albedo.jpg', true), normalMap: tex('./assets/world/terrain_normal.jpg', false), roughness: 0.95, metalness: 0 })
    : new THREE.MeshStandardMaterial({ map: white, color: 0x7a7066, roughness: 0.95, metalness: 0 });
  // the scan's colour map is 1024 px over 200 m (20 cm a texel): gravel detail at two scales, in world space, gives the ground its grain up close (src/detail.js)
  const mat = detailMaterial(scan, [{ map: mats.ground.map, meters: 4, strength: 0.9 }, { map: mats.ground.map, meters: 1.1, strength: 0.6 }]);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = mesh.castShadow = true; mesh.frustumCulled = false;
  scene.add(mesh);
}
buildTerrain();

const skinBoxes = {}; // boxes that a loaded model stands in for (b.skin = the model's name): grey boxes until it arrives, and if it never does
for (const b of LEVEL.boxes) {
  const w = b.x1 - b.x0, h = b.y1 - b.y0, d = b.z1 - b.z0, mat = mats[b.tag === 'dirt' ? 'rock' : b.tag];
  const geo = boxUV(new THREE.BoxGeometry(w, h, d), w, h, d, mat.userData.tileMeters);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  if (b.skin) (skinBoxes[b.skin] = skinBoxes[b.skin] || []).push({ mesh, b });
}

function buildProps() {
  const trees = S.level.props.filter((p) => p.kind === 'tree'), rocks = S.level.props.filter((p) => p.kind === 'rock');
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
  scene.add(createTrees({ trees, barkMaterial: mats.bark, seed: 1 })); // src/trees.js: three seeded conifer variants, instanced (the sim only knows the trunk)
  const rockGeo = new THREE.IcosahedronGeometry(1, 1), pa = rockGeo.attributes.position;
  for (let i = 0; i < pa.count; i++) { // lumpy boulders: displace by a hash of the vertex position, so shared corners move together
    const h = Math.abs(Math.sin(pa.getX(i) * 91.7 + pa.getY(i) * 47.3 + pa.getZ(i) * 13.1) * 43758.5453) % 1;
    pa.setXYZ(i, pa.getX(i) * (0.8 + 0.35 * h), pa.getY(i) * (0.8 + 0.35 * h), pa.getZ(i) * (0.8 + 0.35 * h));
  }
  rockGeo.computeVertexNormals();
  const rk = new THREE.InstancedMesh(rockGeo, mats.rock, rocks.length);
  rocks.forEach((r, i) => rk.setMatrixAt(i, m.compose(p.set(r.x, r.y0 + r.h * 0.25, r.z), q.setFromEuler(e.set(0, i * 2.3, 0)), s.set(r.r, r.h * 0.6, r.r))));
  for (const im of [rk]) { im.castShadow = im.receiveShadow = true; scene.add(im); }
}
buildProps();

// ---------- lamps and fire: the only warm light at night ----------
const lamps = [];
function addLamp(x, y, z, color, intensity, dist, flicker = 0, bulb = true) {
  const light = new THREE.PointLight(color, intensity, dist, 2);
  light.position.set(x, y, z);
  scene.add(light);
  if (bulb) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), new THREE.MeshBasicMaterial({ color }));
    b.position.copy(light.position); scene.add(b);
  }
  lamps.push({ light, base: intensity, flicker, seed: Math.random() * 100 });
  return light;
}
addLamp(2, 3.2, 8, 0xffd9a0, 55, 24, 0.12);             // a lantern over the fort door
addLamp(0, 2.6, 0, 0xbfe0ff, 40, 14, 0.4);              // inside the fort, a failing tube light
addLamp(-5.5, 9.6, -1, 0xffa860, 40, 20, 0.3);          // a fire basket on top of the tower
const bellLight = addLamp(LEVEL.bell.x, LEVEL.bell.y + 0.4, LEVEL.bell.z, 0xffd27a, 18, 16, 0, false);
const fire = addLamp(8, 1.2, 8, 0xff8a3a, 90, 24, 0.45, false); // the barrel fire by the bell
{
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.3, 0.9, 12), mats.metal);
  barrel.position.set(8, 0.45, 8); barrel.castShadow = true;
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.8, 10), new THREE.MeshBasicMaterial({ color: 0xffa040 }));
  flame.position.set(8, 1.25, 8); flame.name = 'flame';
  scene.add(barrel, flame);
}
function updateLamps() {
  const t = S.t * 6;
  for (const l of lamps) {
    const n = Math.sin(t * 1.3 + l.seed) * 0.5 + Math.sin(t * 2.9 + l.seed * 1.7) * 0.3 + Math.sin(t * 7.1 + l.seed * 3.1) * 0.2;
    l.light.intensity = l.base * (1 + l.flicker * n);
  }
  bellLight.intensity = 18 + (S.bell.ring ? 70 : 0);
  const flame = scene.getObjectByName('flame');
  if (flame) flame.scale.set(1, 0.8 + 0.35 * Math.sin(t * 3.3) * Math.sin(t * 1.1 + 2), 1);
}

// ---------- people ----------
const KIND_COLOR = { hunter: 0x74865f, scout: 0x607a94, sleeper: 0x8a8460, screamer: 0xa6605c };
const STATE_COLOR = { dormant: 0x9aa5ad, idle: 0x9aa5ad, suspicious: 0xf2c14e, alert: 0xe5584f, search: 0x5bc0de, caution: 0x5bc0de };
const skin = new THREE.MeshStandardMaterial({ color: 0xc9b9a6, roughness: 0.9 });
function capsuleFigure(color) { // fallback when characters.js is missing
  const root = new THREE.Group(), body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.9, 4, 12), new THREE.MeshStandardMaterial({ color, roughness: 0.9 }));
  body.position.y = 0.85; body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), skin); head.position.y = 1.68; head.castShadow = true;
  root.add(body, head);
  return { root, head, update() {}, dispose() {} };
}
const makeZombie = (z) => {
  const m = z.kind === 'scout' && models.scout ? models.scout : models.zombie; // scouts have their own model
  return m ? modelMod.createFigure(m, z) : charMod ? charMod.createZombieFigure(z) : capsuleFigure(KIND_COLOR[z.kind]);
};
const makePlayer = () => (models.player ? modelMod.createFigure(models.player) : charMod ? charMod.createPlayerFigure() : capsuleFigure(0x4c6a8a));
const player = makePlayer();
scene.add(player.root);

// What the survivor carries (src/held.js): the bow in the left hand at all times, the machete on the right hip and in the right hand during the swing,
// which the survivor's own animation plays (src/survivor.js melee). A figure without bones (the procedural fallbacks) gets the old floating prop below.
let held = null;
propsReady.then(() => { if (player.attach && !held) held = attachHeld(player, { bow: bowAssets && bowMod ? bowMod.createHeldBow(bowAssets) : null, knife: props.knife ? modelMod.cloneProp(props.knife) : null }); });
// The knife for figures without bones: a prop on the figure's root (feet at the origin, facing +Z, its right hand at -X). The model points its blade along +Z from the handle.
const knifeG = new THREE.Group();
const blade = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.45), new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.4 })); // stands in until the model arrives
blade.position.z = 0.22; knifeG.add(blade);
if (!player.attach) player.root.add(knifeG);
propsReady.then(() => { if (props.knife) { knifeG.clear(); knifeG.add(modelMod.cloneProp(props.knife)); } });
// [seconds, x, y, z, blade pitch]: sheathed, wind-up, strike, follow-through, back on the hip
const SWING = [[0, -0.27, 0.92, -0.05, 1.35], [0.09, -0.55, 1.35, 0.0, -1.9], [0.19, -0.5, 1.15, 0.7, -0.15], [0.3, -0.45, 1.05, 0.55, -0.3], [0.48, -0.27, 0.92, -0.05, 1.35]]; // out to the side, so the swing shows past the shoulder in third person
let knifeT = -1; // seconds into the swing, -1 while sheathed
function poseKnife(dt) {
  if (knifeT >= 0) { knifeT += dt; if (knifeT >= SWING_TIME) knifeT = -1; }
  if (held) held.swing(knifeT >= 0); // the machete is in the hand for the swing, on the hip otherwise
  if (player.attach) return;
  let k = SWING[0];
  if (knifeT >= 0) {
    const t = knifeT * (SWING[SWING.length - 1][0] / SWING_TIME); // the table is in its own seconds (0.48 s long); the swing's length is SWING_TIME
    let i = 0; while (SWING[i + 1][0] < t) i++;
    const a = SWING[i], b = SWING[i + 1], u = (t - a[0]) / (b[0] - a[0]), s = u * u * (3 - 2 * u);
    k = a.map((v, j) => v + (b[j] - v) * s);
  }
  knifeG.position.set(k[1], k[2], k[3]); knifeG.rotation.set(k[4], 0, 0);
}

// The bike waits at the start (a visual: E there bails out, the sim does not collide with it). Its model's long axis is X, nose toward +X;
// a quarter turn points it north, up the road into the outpost. The hut replaces the grey box that stands for it in the level.
propsReady.then(() => {
  const ground = (x, z) => sim.heightAt(S.level, x, z);
  if (props.bike) {
    // It rests on the terrain: pitched along its length and rolled across it to the ground under the two wheels (0.78 m from the middle) and
    // to either side, with the middle at the mean wheel height. Local axes: +x the nose, +y up, +z to the right.
    const bike = modelMod.cloneProp(props.bike), bx = LEVEL.bike.x, bz = LEVEL.bike.z, yaw = Math.atan2(bz, -bx), tz = (x, z) => sim.terrainAt(S.level, x, z);
    const fx = Math.cos(yaw), fz = -Math.sin(yaw), W = 0.78, hF = tz(bx + fx * W, bz + fz * W), hR = tz(bx - fx * W, bz - fz * W);
    const sx = -fz * 0.4, sz = fx * 0.4, roll = (tz(bx + sx, bz + sz) - tz(bx - sx, bz - sz)) / 0.8; // rise per metre toward +z (the bike's right)
    const nose = new THREE.Vector3(fx, (hF - hR) / (2 * W), fz).normalize(), up = new THREE.Vector3(-roll * sx / 0.4, 1, -roll * sz / 0.4).normalize();
    up.addScaledVector(nose, -up.dot(nose)).normalize();
    bike.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(nose, up, new THREE.Vector3().crossVectors(nose, up)));
    bike.position.set(bx, (hF + hR) / 2, bz);
    scene.add(bike);
  }
  if (props.hut && skinBoxes.hut) {
    const { mesh, b } = skinBoxes.hut[0], hut = modelMod.cloneProp(props.hut);
    hut.position.set((b.x0 + b.x1) / 2, b.y0, (b.z0 + b.z1) / 2);
    mesh.visible = false; scene.add(hut);
  }
});
// The outpost: the cleaned scan (assets/world/outpost.glb, built by tools/prep-world.mjs) in the world frame; the grey collision boxes it stands in for are hidden.
if (modelMod) modelMod.loadOutpost().then((fort) => {
  if (!fort) return;
  // the scan's wall texture is soft, so stone and plaster detail goes over it (src/detail.js)
  fort.traverse((o) => { if (o.isMesh) o.material = detailMaterial(o.material, [{ map: mats.concrete.map, meters: 1.0, strength: 1 }, { map: mats.rock.map, meters: 0.45, strength: 0.9 }]); });
  scene.add(fort); for (const { mesh } of skinBoxes.outpost || []) mesh.visible = false; });

const zm = new Map();
const kills = new Map(); // zombie id -> { dir, part } of the killing blow, for the ragdoll
const simGround = (x, z) => sim.heightAt(S.level, x, z); // the sim's walkable height (terrain, box tops; sealed ground and the map edge are Infinity)
function addZombie(z) {
  const fig = makeZombie(z);
  const ind = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), new THREE.MeshBasicMaterial({ color: 0x9aa5ad, depthTest: false, transparent: true }));
  ind.position.y = 2.4; ind.renderOrder = 10; ind.visible = false;
  fig.root.add(ind);
  scene.add(fig.root);
  zm.set(z.id, { fig, ind, px: z.x, pz: z.z, speed: 0, attackUntil: 0 });
}
for (const z of S.zombies) addZombie(z);

// ---------- the bow in first person, with the slider sight ----------
// One pin, like the supplied Avalon: the wheel slides it to a range (20 to 60 m), and it sits on the arrow's ballistic ray for that range at full draw.
const SIGHT_MIN = 20, SIGHT_MAX = 60, SIGHT_STEP = 5;
let sightRange = 40;
const vm = bowMod ? bowMod.createBowViewmodel({ pins: [{ angle: sim.dropAngle(sightRange), color: 0xff4a3a }], assets: bowAssets }) : null;
propsReady.then(() => { if (vm && props.arrow) vm.setArrowModel(modelMod.cloneProp(props.arrow)); }); // the supplied arrow, nocked
if (vm && modelMod && models.player && !models.player.clips.length) { const arms = modelMod.createArms(models.player); if (arms) vm.setArms(arms); } // the survivor's own arms hold the bow
if (vm) { vm.group.visible = false; cam.add(vm.group); }

// ---------- arrows and noise rings ----------
const UP = new THREE.Vector3(0, 1, 0);
const shaftGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.85, 6); shaftGeo.translate(0, -0.425, 0);
const headGeo = new THREE.ConeGeometry(0.03, 0.1, 8); headGeo.translate(0, -0.05, 0);
const arrowMat = { basic: new THREE.MeshStandardMaterial({ color: 0xd9c8a0 }), lure: new THREE.MeshStandardMaterial({ color: 0xe8d36a }) };
const headMat = new THREE.MeshStandardMaterial({ color: 0x555a5e });
const am = new Map(), tmpDir = new THREE.Vector3();
const EMBED = 0.1; // metres of shaft buried in a body: the sim's hit point is on its hit sphere, not on the mesh

// An arrow mesh has its tip at the origin and its shaft trailing along -Y. The loaded arrow model (props.arrow, which points
// along +Z) replaces the plain one once it has arrived; whistling arrows are tinted yellow.
function makeArrow(kind) {
  const g = new THREE.Group();
  if (props.arrow) {
    const p = modelMod.cloneProp(props.arrow); p.rotation.x = -Math.PI / 2; g.add(p);
    if (kind === 'lure') p.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.color.set(0xffe27a); } });
  } else g.add(new THREE.Mesh(shaftGeo, arrowMat[kind]), new THREE.Mesh(headGeo, headMat));
  return g;
}

// An arrow that hit a zombie is handed to that zombie's body part (bone or joint), so it moves with the walk, the stagger and the fall.
function stickArrow(m, a) {
  const z = zm.get(a.zid);
  if (!z) return; // keep it where it hit
  m.position.set(a.x + a.dir[0] * EMBED, a.y + a.dir[1] * EMBED, a.z + a.dir[2] * EMBED);
  m.quaternion.setFromUnitVectors(UP, tmpDir.set(a.dir[0], a.dir[1], a.dir[2]));
  (z.fig.anchor ? z.fig.anchor(a.part) : z.fig.root).attach(m); // attach() keeps the world transform, then the new parent drives it
  m.userData.onBody = true;
}

const RING_N = 40, rings = [];
const ringGeo = new THREE.RingGeometry(0.97, 1, 72);
for (let i = 0; i < RING_N; i++) {
  const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.visible = false; scene.add(m);
  rings.push({ m, live: false, t0: 0, x: 0, z: 0, range: 0, src: 'world' });
}
let ringI = 0;
const RING_COLOR = { player: 0xffffff, arrow: 0xf2c14e, zombie: 0xe5584f, world: 0xe5584f };
const RING_CSS = { player: '255,255,255', arrow: '242,193,78', zombie: '229,88,79', world: '229,88,79' };

// ---------- post-processing: bloom so lamps, fire and the moon glow ----------
let pipeline = null;
try {
  if (bloomMod) {
    const scenePass = pass(scene, cam);
    pipeline = new THREE.RenderPipeline(renderer, scenePass.add(bloomMod.bloom(scenePass, 0.5, 0.55, 0.85)));
  }
} catch (err) { console.warn('post-processing unavailable: ' + err.message); }

// ---------- state ----------
let seed = 1, playing = false, started = false, mode = 'walk'; // started: the first click happened, so audio may run
const view = { yaw: LEVEL.start.yaw, pitch: -0.1 };
const keys = new Set();
let bodyYaw = LEVEL.start.yaw, bodyTurning = false; // where the survivor's body faces (see syncMeshes)
let mouseDown = false, aimHeld = false, cancelPending = false, drawLatch = false, crouchToggle = false;
let camBlend = 0, camY = null, binoZoom = 8, hurtT = 0, shakeT = 0, debugAI = false;
let aimDist = Infinity, swayX = 0, swayY = 0, aimDir = [0, 0, -1];
const camPos = [0, 0, 0];

function reset() {
  seed++;
  S = sim.createState(LEVEL, seed);
  if (audio) audio.stopAll();
  for (const m of zm.values()) scene.remove(m.fig.root);
  zm.clear(); kills.clear();
  for (const m of am.values()) m.removeFromParent();
  am.clear();
  for (const r of rings) { r.live = false; r.m.visible = false; }
  for (const z of S.zombies) addZombie(z);
  view.yaw = bodyYaw = LEVEL.start.yaw; bodyTurning = false; view.pitch = -0.1; camY = null; crouchToggle = false; mouseDown = false; aimHeld = false; mode = 'walk';
  hurtT = shakeT = 0; tagTimers.clear(); tagView.length = 0;
  hideScreen();
  playing = true;
}

// ---------- screens, toasts ----------
const TAG_TIME = 1; // seconds a zombie must stay anywhere inside the binocular viewfinder (either lens, in line of sight) to be tagged
const tagTimers = new Map(), tagView = []; // zombie id -> seconds in view; this frame's zombies in view: { z, t, px, py } (px, py: where they are on screen)
const lens = (w, h) => { const r = Math.min(h * 0.42, w * 0.25); return { r, gap: r * 0.55 }; }; // the two binocular lenses: radius and half the distance between their centres
const HELP = 'WASD move   Shift run   C crouch   B binoculars   M sound   G AI debug\nHold right mouse: raise the bow (first person, slider sight: the wheel sets its range, 20 to 60 m). Hold left mouse: draw; release to fire.\n1 arrow   2 whistling arrow (lure)   F knife (silent kill from behind or on a sleeper, a noisy stab otherwise)   E pick up an arrow, or bail at the bike\nBinoculars: wheel zooms, anything in the viewfinder for 1 second is tagged, right mouse or B to lower.\nWind (bottom right): the arrow is where the air is going, relative to where you look. It pushes your arrows sideways, more at range.\nR restart   H help';
const showScreen = (html) => { $('screenbody').innerHTML = html; $('screen').classList.remove('hidden'); };
const hideScreen = () => $('screen').classList.add('hidden');
let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.opacity = 0; }, 1800);
}
function endScreen(result) {
  const s = S.stats, P = S.player;
  const title = { cleared: 'Outpost cleared', bailed: 'You bailed on the bike', dead: 'You died' }[result];
  showScreen(`<h1>${title}</h1><pre>time ${s.time.toFixed(0)} s\nshots ${s.shots}   arrows back ${s.retrieved}   arrows left ${P.quiver.basic + P.quiver.lure}\nclean kills ${s.clean}   messy ${s.messy}   blown ${s.blown}\nzombies left ${sim.aliveCount(S)}</pre><p>Press R to play again</p>`);
  playing = false;
  if (document.pointerLockElement) document.exitPointerLock();
}
$('help').textContent = HELP;
const creditsHtml = models.credits ? `<p style="font-size:11px">${models.credits.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>` : '';
showScreen(`<h1>The Long Draw: Outpost Prototype</h1><p>Clear the outpost with planned shots. The dead hunt by sound.</p><pre>${HELP}</pre><p><b>Click to play</b></p>${creditsHtml}`);
$('badge').textContent = backend;

const audio = audioMod ? audioMod.createAudio() : null;

// ---------- input ----------
$('screen').addEventListener('click', () => {
  if (S.over) return;
  playing = started = true;
  hideScreen();
  $('help').classList.add('hidden'); // H brings it back
  if (audio) audio.resume();
  const lock = canvas.requestPointerLock && canvas.requestPointerLock();
  if (lock && lock.catch) lock.catch(() => {});
});
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && playing && !S.over) {
    playing = false;
    showScreen('<h1>Paused</h1><p>Click to resume</p>');
  }
});
addEventListener('mousedown', (e) => {
  if (!playing) return;
  if (e.button === 0 && mode !== 'bino') mouseDown = true;
  if (e.button === 2) { if (mode === 'bino') mode = 'walk'; else aimHeld = true; }
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) mouseDown = false;
  if (e.button === 2) { aimHeld = false; if (S.player.drawing) cancelPending = true; }
});
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('wheel', (e) => {
  if (mode === 'bino') binoZoom = clamp(binoZoom * (e.deltaY < 0 ? 1.15 : 0.87), 4, 16);
  else if (vm && (aimHeld || S.player.drawing)) { // aiming: the wheel slides the sight pin to a longer (up) or shorter (down) range
    sightRange = clamp(sightRange + (e.deltaY < 0 ? SIGHT_STEP : -SIGHT_STEP), SIGHT_MIN, SIGHT_MAX); vm.setPin(0, sim.dropAngle(sightRange));
  }
}, { passive: true });
addEventListener('mousemove', (e) => {
  if (!document.pointerLockElement) return;
  const k = 0.0022 * (mode === 'bino' ? 8 / binoZoom : S.player.drawing || aimHeld ? 0.6 : 1); // slower look when zoomed
  view.yaw -= e.movementX * k;
  view.pitch = clamp(view.pitch - e.movementY * k, -1.25, 1.25);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('keydown', (e) => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'KeyR') return reset();
  if (e.code === 'KeyH') return $('help').classList.toggle('hidden');
  if (e.code === 'KeyM' && audio) { audio.muted = !audio.muted; audio.setMuted(audio.muted); toast(audio.muted ? 'Sound off' : 'Sound on'); return; }
  if (e.code === 'KeyG') { debugAI = !debugAI; toast(debugAI ? 'AI debug on: all zombies on the minimap' : 'AI debug off'); return; }
  if (!playing || S.over) return;
  const P = S.player;
  if (e.code === 'KeyC') crouchToggle = !crouchToggle;
  else if (e.code === 'KeyB') { if (P.drawing) cancelPending = true; aimHeld = false; mode = mode === 'bino' ? 'walk' : 'bino'; tagTimers.clear(); }
  else if (e.code === 'Digit1' && !P.drawing) P.kind = 'basic';
  else if (e.code === 'Digit2' && !P.drawing) P.kind = 'lure';
  else if (e.code === 'KeyE') { if (!sim.retrieve(S) && !sim.bail(S)) toast('Nothing in reach'); }
  else if (e.code === 'KeyF') sim.knife(S); // the 'knife' event does the toast, the swing and the sound
});
addEventListener('blur', () => { keys.clear(); mouseDown = false; });
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  cam.aspect = innerWidth / innerHeight;
  cam.updateProjectionMatrix();
  sizeOverlay();
});

function forward3(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
}
function readInput() {
  const f = [Math.sin(view.yaw), Math.cos(view.yaw)], r = [-Math.cos(view.yaw), Math.sin(view.yaw)];
  const kz = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0), kx = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const want = (mouseDown || keys.has('Space')) && mode === 'walk';
  if (!want) drawLatch = false;
  const cancel = cancelPending;
  if (cancel) { drawLatch = true; cancelPending = false; }
  return {
    mx: f[0] * kz + r[0] * kx, mz: f[1] * kz + r[1] * kx,
    run: keys.has('ShiftLeft') || keys.has('ShiftRight'), crouch: crouchToggle,
    draw: want && !drawLatch, cancel, aim: aimDir, from: camPos,
  };
}

// ---------- camera ----------
const binoFov = () => (2 * Math.atan(Math.tan((31 * Math.PI) / 180) / binoZoom) * 180) / Math.PI;
function updateCamera(dt) {
  const P = S.player, aiming = mode === 'walk' && (aimHeld || P.drawing), bino = mode === 'bino', fp = aiming || bino;
  camBlend += ((fp ? 1 : 0) - camBlend) * Math.min(1, 14 * dt);
  // aim wobble in radians: breath, walking, and the longer you hold full draw
  const held = P.drawing ? Math.max(0, P.drawT - TUNING.bow.drawTime - TUNING.bow.swaySecs) : 0;
  const amp = (fp ? 0.0014 : 0) + (P.moving ? 0.004 : 0) + TUNING.bow.swayGrow * held * 2;
  swayX = (Math.sin(S.t * 1.7) + 0.4 * Math.sin(S.t * 4.3)) * amp;
  swayY = (1.2 * Math.sin(S.t * 1.3 + 1) + 0.4 * Math.sin(S.t * 3.7)) * amp;

  const eyeY = sim.playerEye(P), targetY = P.y + (P.crouch ? 1.3 : 1.75);
  camY = camY === null ? targetY : camY + (targetY - camY) * Math.min(1, 10 * dt);
  const f0 = forward3(view.yaw, view.pitch), right = [-Math.cos(view.yaw), 0, Math.sin(view.yaw)];
  const eye = [P.x, camY, P.z], want = [eye[0] - f0[0] * 3.6 + right[0] * 0.95, eye[1] - f0[1] * 3.6 + 0.35, eye[2] - f0[2] * 3.6 + right[2] * 0.95];
  const hit = sim.rayWorld(S.level, eye[0], eye[1], eye[2], want[0], want[1], want[2]);
  const k = hit ? clamp(hit.t * 0.85, 0.1, 1) : 1;
  const tp = [eye[0] + (want[0] - eye[0]) * k, eye[1] + (want[1] - eye[1]) * k, eye[2] + (want[2] - eye[2]) * k];
  tp[1] = Math.max(sim.terrainAt(S.level, tp[0], tp[2]) + 0.3, tp[1]);
  const fp3 = [P.x, eyeY, P.z];
  cam.position.set(lerp(tp[0], fp3[0], camBlend), lerp(tp[1], fp3[1], camBlend), lerp(tp[2], fp3[2], camBlend));
  if (shakeT > 0) cam.position.add(new THREE.Vector3((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12).multiplyScalar(shakeT));
  const f = forward3(view.yaw + swayX, view.pitch + swayY);
  cam.lookAt(cam.position.x + f[0], cam.position.y + f[1], cam.position.z + f[2]);
  const fov = lerp(62, bino ? binoFov() : 40, camBlend);
  if (Math.abs(cam.fov - fov) > 0.02) { cam.fov = fov; cam.updateProjectionMatrix(); }
  camPos[0] = cam.position.x; camPos[1] = cam.position.y; camPos[2] = cam.position.z;
  aimDir = f;

  // rangefinder: how far along the line of sight before it hits anything
  const hitR = sim.rayWorld(S.level, camPos[0], camPos[1], camPos[2], camPos[0] + f[0] * 300, camPos[1] + f[1] * 300, camPos[2] + f[2] * 300);
  aimDist = hitR ? hitR.t * 300 : Infinity;

  if (vm) {
    vm.group.visible = camBlend > 0.04 && !bino;
    vm.setRaise(camBlend);
    vm.setDraw(P.drawing ? Math.min(1, P.drawT / TUNING.bow.drawTime) : 0);
    vm.setKind(P.kind);
    vm.update(dt, { sway: [swayX, swayY], moving: P.moving });
  }
  moon.position.set(P.x + MOON_DIR.x * 90, P.y + MOON_DIR.y * 90, P.z + MOON_DIR.z * 90);
  moon.target.position.set(P.x, P.y, P.z);
  sky.position.copy(cam.position); moonDisc.position.copy(cam.position).addScaledVector(MOON_DIR, 380); moonGlow.position.copy(moonDisc.position);
  player.root.visible = !(fp && camBlend > 0.6);
  renderer.toneMappingExposure = lerp(1.5, 3.2, bino ? camBlend : 0); // binoculars amplify the light
}

// ---------- events and visuals ----------
function addRing(e) {
  const r = rings[ringI++ % RING_N], h = sim.heightAt(S.level, e.x, e.z);
  r.live = true; r.t0 = e.t; r.x = e.x; r.z = e.z; r.range = Math.max(e.range, 1.5); r.src = e.src;
  r.m.material.color.setHex(RING_COLOR[e.src] ?? 0xffffff);
  r.m.position.set(e.x, (isFinite(h) ? h : 0) + 0.08, e.z);
  r.m.visible = true;
}
function consumeEvents() {
  for (const e of S.events) {
    if (e.type === 'noise') addRing(e);
    else if (e.type === 'wound') toast('Wounded: it screams');
    else if (e.type === 'blown') toast('Blown: they are coming');
    else if (e.type === 'tag') toast('Tagged');
    else if (e.type === 'wake') toast('Something woke up');
    else if (e.type === 'hit') { hurtT = 1; shakeT = 1; const m = zm.get(e.id); if (m) m.attackUntil = S.t + 0.6; }
    else if (e.type === 'swarmed') toast('Swarmed');
    else if (e.type === 'knife') { knifeT = 0; if (e.hit) toast(e.silent ? 'Silent kill' : e.killed ? 'Down' : 'Stabbed: it screams'); }
    else if (e.type === 'kill') { kills.set(e.id, { dir: e.dir, part: e.part }); if (e.how !== 'knife' && e.how !== 'stab') toast(e.how === 'head' ? 'Clean kill' : 'Down'); }
    else if (e.type === 'over') endScreen(e.result);
  }
  S.events.length = 0;
}
function updateRings() {
  for (const r of rings) {
    if (!r.live) continue;
    const age = S.t - r.t0, life = 1.6;
    if (age > life || age < 0) { r.live = false; r.m.visible = false; continue; }
    const k = Math.min(1, age / 0.5);
    r.m.scale.setScalar(Math.max(0.01, r.range * (1 - (1 - k) * (1 - k))));
    r.m.material.opacity = 0.75 * (1 - age / life);
  }
}
function syncMeshes(dt) {
  const P = S.player;
  player.root.position.set(P.x, P.y, P.z);
  if (!player.ps) player.ps = { x: P.x, z: P.z, speed: 0 };
  const mvx = P.x - player.ps.x, mvz = P.z - player.ps.z;
  player.ps.speed = lerp(player.ps.speed, dt > 0 ? Math.hypot(mvx, mvz) / dt : 0, 0.3);
  player.ps.x = P.x; player.ps.z = P.z;
  // The body faces where it travels (so strafing and walking backward turn the character, they do not slide it), except while aiming, drawing,
  // looking through the binoculars or swinging the knife (the sim aims along the camera): then it snaps to the camera. Standing still, it turns to
  // the camera once that is more than ~70 degrees off. The head keeps looking where the camera looks.
  const before = bodyYaw, faceView = mode === 'bino' || aimHeld || P.drawing || knifeT >= 0;
  if (faceView) { bodyYaw = turnToward(bodyYaw, view.yaw, 14, dt); bodyTurning = false; }
  else if (player.ps.speed > 0.4 && Math.hypot(mvx, mvz) > 1e-4) { bodyYaw = turnToward(bodyYaw, Math.atan2(mvx, mvz), 10, dt); bodyTurning = false; }
  else {
    const off = Math.abs(wrapPi(view.yaw - bodyYaw));
    if (off > 1.2) bodyTurning = true; else if (off < 0.3) bodyTurning = false;
    if (bodyTurning) bodyYaw = turnToward(bodyYaw, view.yaw, 6, dt);
  }
  player.root.rotation.y = bodyYaw;
  const fx = Math.sin(bodyYaw), fz = Math.cos(bodyYaw), terr = (d) => sim.terrainAt(S.level, P.x + fx * d, P.z + fz * d);
  player.update(dt, { speed: player.ps.speed, state: 'idle', attacking: false, crouch: P.crouch, drawing: P.drawing, sees: false, hold: true, swing: knifeT >= 0 ? knifeT / SWING_TIME : -1,
    turn: dt > 0 ? wrapPi(bodyYaw - before) / dt : 0, look: wrapPi(view.yaw - bodyYaw), grade: Math.atan((terr(0.6) - terr(-0.6)) / 1.2) });
  poseKnife(dt);

  for (const z of S.zombies) {
    const m = zm.get(z.id);
    if (!m) continue;
    m.speed = lerp(m.speed, dt > 0 ? Math.hypot(z.x - m.px, z.z - m.pz) / dt : 0, 0.25);
    m.px = z.x; m.pz = z.z;
    m.fig.root.position.set(z.x, z.y, z.z);
    m.fig.root.rotation.y = z.yaw;
    m.fig.update(dt, { speed: m.speed, state: z.state, attacking: S.t < m.attackUntil, crouch: false, drawing: false, sees: z.sees,
      ground: simGround, anchor: z, kill: kills.get(z.id) }); // a dead zombie becomes a ragdoll on the sim's ground (src/ragdoll.js)
    m.ind.visible = z.tagged && z.state !== 'dead';
    if (m.ind.visible) { m.ind.material.color.setHex(STATE_COLOR[z.state] ?? 0x9aa5ad); m.ind.rotation.y = S.t * 2; }
  }

  const seen = new Set();
  for (const a of S.arrows) {
    seen.add(a.id);
    let m = am.get(a.id);
    if (!m) { m = makeArrow(a.kind); scene.add(m); am.set(a.id, m); }
    if (a.zid && a.state === 'stuck' && !m.userData.onBody) stickArrow(m, a);
    if (m.userData.onBody) continue; // a bone moves it now
    m.position.set(a.x, a.y, a.z);
    m.quaternion.setFromUnitVectors(UP, tmpDir.set(a.dir[0], a.dir[1], a.dir[2]));
  }
  for (const [id, m] of am) if (!seen.has(id)) { m.removeFromParent(); am.delete(id); } // removeFromParent: it may be on a zombie, not the scene
}

// ---------- HUD, overlay and minimap ----------
const STATUS_COLOR = { UNSEEN: '#6fbf73', NOTICED: '#f2c14e', SPOTTED: '#e5584f', HUNTED: '#e5584f', HIDING: '#5bc0de' };
const ov = document.createElement('canvas');
ov.id = 'overlay';
Object.assign(ov.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
document.body.insertBefore(ov, $('cross'));
const octx = ov.getContext('2d');
function sizeOverlay() { const r = Math.min(devicePixelRatio, 2); ov.width = innerWidth * r; ov.height = innerHeight * r; octx.setTransform(r, 0, 0, r, 0, 0); }
sizeOverlay();

function drawOverlay() {
  const w = innerWidth, h = innerHeight, c = octx, P = S.player, m = Math.min(w, h);
  c.clearRect(0, 0, w, h);
  // being hunted: a pulsing red edge that closes in, plus an arrow toward each chaser (drawn last, over everything)
  const drawThreat = () => {
  const threat = S.threat.count > 0 ? clamp(1 - S.threat.dist / 45, 0, 1) : 0;
  const red = Math.max(threat * (0.22 + 0.22 * (0.5 + 0.5 * Math.sin(S.t * (4 + 8 * threat)))), hurtT * 0.65);
  if (red > 0.01) {
    const g = c.createRadialGradient(w / 2, h / 2, m * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.6);
    g.addColorStop(0, 'rgba(160,0,0,0)'); g.addColorStop(1, `rgba(175,10,10,${red})`);
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  }
  const chasers = S.zombies.filter((z) => z.state === 'alert' && z.role !== 'scout').map((z) => ({ z, d: Math.hypot(z.x - P.x, z.z - P.z) })).filter((o) => o.d < 45).sort((a, b) => a.d - b.d).slice(0, 5);
  for (const { z, d } of chasers) {
    const dx = z.x - P.x, dz = z.z - P.z, fwd = Math.sin(view.yaw) * dx + Math.cos(view.yaw) * dz, rgt = -Math.cos(view.yaw) * dx + Math.sin(view.yaw) * dz;
    const a = Math.atan2(rgt, fwd), R = m * 0.36, s = 9 + 15 * (1 - d / 45);
    c.save(); c.translate(w / 2 + Math.sin(a) * R, h / 2 - Math.cos(a) * R); c.rotate(a);
    c.fillStyle = `rgba(235,70,60,${0.55 + 0.4 * (1 - d / 45)})`;
    c.beginPath(); c.moveTo(0, -s); c.lineTo(s * 0.7, s * 0.6); c.lineTo(-s * 0.7, s * 0.6); c.closePath(); c.fill(); c.restore();
  }
  };
  // aiming through the sight: darken the edges like a peep sight, show range and draw
  if (camBlend > 0.05 && mode === 'walk') {
    const g = c.createRadialGradient(w / 2, h / 2, m * 0.26, w / 2, h / 2, m * 0.6);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${0.8 * camBlend})`);
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.textAlign = 'center'; c.font = '13px ui-monospace, Menlo, monospace';
    if (isFinite(aimDist) && camBlend > 0.6) { c.fillStyle = 'rgba(232,236,239,0.9)'; c.fillText(`${aimDist.toFixed(0)} m`, w / 2, h / 2 + m * 0.34); }
    if (camBlend > 0.6) { c.fillStyle = 'rgba(255,120,100,0.9)'; c.fillText(`sight ${sightRange} m  (wheel)`, w / 2, h / 2 + m * 0.42); }
    if (P.drawing && P.drawT >= TUNING.bow.drawTime) { c.fillStyle = 'rgba(111,191,115,0.95)'; c.fillText(`FULL DRAW: the pin is true at ${sightRange} m`, w / 2, h / 2 + m * 0.38); }
    else if (P.drawing) { c.fillStyle = 'rgba(242,193,78,0.9)'; c.fillText('draw to full for a true pin', w / 2, h / 2 + m * 0.38); }
  }
  // binoculars: two circles, green light amplification, mil-dot reticle, rangefinder, tag progress
  if (mode === 'bino' && camBlend > 0.05) {
    const { r, gap } = lens(w, h), a = camBlend;
    c.fillStyle = `rgba(0,0,0,${0.97 * a})`; c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'destination-out'; c.fillStyle = '#000'; // two lenses, merged where they overlap
    for (const dx of [-gap, gap]) { c.beginPath(); c.arc(w / 2 + dx, h / 2, r, 0, Math.PI * 2); c.fill(); }
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = `rgba(30,150,80,${0.1 * a})`; c.fillRect(0, 0, w, h);
    c.strokeStyle = `rgba(210,255,225,${0.8 * a})`; c.lineWidth = 1;
    c.beginPath();
    c.moveTo(w / 2 - r * 0.85, h / 2); c.lineTo(w / 2 - 14, h / 2); c.moveTo(w / 2 + 14, h / 2); c.lineTo(w / 2 + r * 0.85, h / 2);
    c.moveTo(w / 2, h / 2 - r * 0.85); c.lineTo(w / 2, h / 2 - 14); c.moveTo(w / 2, h / 2 + 14); c.lineTo(w / 2, h / 2 + r * 0.85);
    for (let i = 1; i <= 5; i++) for (const s of [-1, 1]) { c.moveTo(w / 2 + s * r * 0.15 * i, h / 2 - 4); c.lineTo(w / 2 + s * r * 0.15 * i, h / 2 + 4); c.moveTo(w / 2 - 4, h / 2 + s * r * 0.15 * i); c.lineTo(w / 2 + 4, h / 2 + s * r * 0.15 * i); }
    c.stroke();
    c.fillStyle = `rgba(210,255,225,${0.95 * a})`; c.font = '13px ui-monospace, Menlo, monospace'; c.textAlign = 'center';
    c.fillText(`${binoZoom.toFixed(0)}x   ${isFinite(aimDist) ? aimDist.toFixed(0) + ' m' : '---'}`, w / 2, h / 2 + r + 22);
    const pending = tagView.filter((v) => !v.z.tagged);
    if (pending.length) c.fillText(`${pending.length} in view: tagging`, w / 2, h / 2 - r - 12);
    c.strokeStyle = 'rgba(120,255,170,0.95)'; c.lineWidth = 3;
    for (const v of pending) { c.beginPath(); c.arc(v.px, v.py, 16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, v.t / TAG_TIME)); c.stroke(); } // a ring fills over each zombie in view
  }
  drawThreat();
  // banners
  c.textAlign = 'center'; c.font = '600 15px ui-monospace, Menlo, monospace';
  if (S.status === 'SPOTTED' || S.status === 'HUNTED') {
    c.fillStyle = `rgba(235,80,70,${0.6 + 0.4 * Math.sin(S.t * 8)})`;
    c.fillText(S.status === 'SPOTTED' ? 'SPOTTED: break line of sight' : 'HUNTED: get out of sight and hide', w / 2, 38);
  } else if (S.status === 'NOTICED') { c.fillStyle = 'rgba(242,193,78,0.85)'; c.fillText('something heard you', w / 2, 38); }
  else if (S.status === 'HIDING') { c.fillStyle = 'rgba(91,192,222,0.8)'; c.fillText('they are searching: stay quiet', w / 2, 38); }
  drawWind(c, w, h); // after the sight vignette, so it stays readable while aiming
}

// Wind vane: an arrow toward where the air is going, relative to where you look (up = the way you face), with its speed in m/s.
// A longer arrow is a stronger wind; amber while a gust is blowing. Dashes flow along the arrow at a rate set by the speed.
function drawWind(c, w, h) {
  const W = S.wind;
  if (!W || !(W.speed > 0)) return;
  const cx = w - 62, cy = h - 126, R = 30, rel = W.dir - view.yaw; // rel > 0: blowing toward your left
  const gust = W.gust > 0.25, col = gust ? '242,193,78' : '232,236,239', len = 7 + 17 * clamp(W.speed / 10, 0, 1);
  c.save(); c.translate(cx, cy);
  c.fillStyle = 'rgba(12,16,20,0.62)'; c.beginPath(); c.arc(0, 0, R + 9, 0, Math.PI * 2); c.fill();
  c.strokeStyle = 'rgba(154,165,173,0.55)'; c.lineWidth = 1; c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.moveTo(0, -R); c.lineTo(0, -R + 6); c.stroke(); // the tick is the way you face
  c.rotate(-rel); c.lineCap = 'round'; c.strokeStyle = c.fillStyle = `rgba(${col},0.95)`; c.lineWidth = 3;
  c.setLineDash([5, 4]); c.lineDashOffset = -(S.t * (4 + W.speed * 3)); // a negative offset moves the dashes toward the tip
  c.beginPath(); c.moveTo(0, len); c.lineTo(0, -len + 3); c.stroke();
  c.setLineDash([]); c.beginPath(); c.moveTo(0, -len - 6); c.lineTo(6, -len + 4); c.lineTo(-6, -len + 4); c.closePath(); c.fill();
  c.restore();
  c.textAlign = 'center'; c.font = '600 12px ui-monospace, Menlo, monospace'; c.fillStyle = `rgba(${col},0.95)`;
  c.fillText(`${W.speed.toFixed(1)} m/s${gust ? ' gust' : ''}`, cx, cy + R + 26);
  c.font = '11px ui-monospace, Menlo, monospace'; c.fillStyle = 'rgba(154,165,173,0.9)'; c.fillText('WIND', cx, cy - R - 14);
}

// A hill-shaded map of the terrain, painted once and drawn under the minimap each frame.
const shade = document.createElement('canvas');
shade.width = shade.height = 320;
{
  const g = shade.getContext('2d'), img = g.createImageData(320, 320), T = LEVEL.terrain;
  for (let py = 0; py < 320; py++) for (let px = 0; px < 320; px++) {
    const x = -64 + px / 2.5, z = -64 + py / 2.5, lit = clamp(0.5 + (T(x - 1, z - 1) - T(x + 1, z + 1)) * 0.12, 0, 1), v = 22 + clamp((T(x, z) + 12) / 40, 0, 1) * 44 + lit * 34, o = (py * 320 + px) * 4; // the map covers +-64 m; heights run from about -12 to 27 m
    img.data[o] = v * 0.9; img.data[o + 1] = v; img.data[o + 2] = v * 1.1; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
const mctx = $('mini').getContext('2d');
const MS = 4, MW = 480; // minimap canvas pixels per metre; canvas size (shows 120 m, so a full-volume noise fits)
function drawMini() {
  const P = S.player, c = mctx;
  c.clearRect(0, 0, MW, MW);
  c.save();
  c.translate(MW / 2, MW / 2); c.scale(MS, MS); c.translate(-P.x, -P.z);
  c.drawImage(shade, -64, -64, 128, 128);
  for (const b of LEVEL.boxes) {
    c.fillStyle = b.y0 > 0 ? 'rgba(130,145,155,.25)' : b.y1 >= 2.5 ? '#7b8a95' : '#4a565e';
    c.fillRect(b.x0, b.z0, b.x1 - b.x0, b.z1 - b.z0);
  }
  c.fillStyle = 'rgba(40,90,50,.55)';
  for (const p of S.level.props) if (p.kind === 'tree') c.fillRect(p.x - 0.5, p.z - 0.5, 1, 1);
  c.lineWidth = 0.6;
  for (const r of rings) {
    if (!r.live) continue;
    const age = S.t - r.t0, k = Math.min(1, age / 0.5), rad = r.range * (1 - (1 - k) * (1 - k));
    c.strokeStyle = `rgba(${RING_CSS[r.src] ?? '255,255,255'},${0.8 * (1 - age / 1.6)})`;
    c.beginPath(); c.arc(r.x, r.z, rad, 0, Math.PI * 2); c.stroke();
  }
  c.fillStyle = '#6fbf73'; c.fillRect(LEVEL.bike.x - 1, LEVEL.bike.z - 1, 2, 2);
  c.fillStyle = S.bell.ring ? '#f2c14e' : '#8a7a2a'; c.beginPath(); c.arc(LEVEL.bell.x, LEVEL.bell.z, 1.4, 0, Math.PI * 2); c.fill();
  for (const z of S.zombies) {
    if (z.state === 'dead') continue;
    const heard = S.t - z.heardT < 2.5;
    if (!z.tagged && !heard && !debugAI) continue;
    const css = '#' + (STATE_COLOR[z.state] ?? 0x9aa5ad).toString(16).padStart(6, '0');
    if (z.tagged || debugAI) {
      const rp = TUNING.roles[z.role], a = Math.PI / 2 - z.yaw, half = (rp.fov * Math.PI) / 360;
      if (rp.sight > 0 && z.state !== 'dormant') { c.fillStyle = css + '33'; c.beginPath(); c.moveTo(z.x, z.z); c.arc(z.x, z.z, rp.sight, a - half, a + half); c.closePath(); c.fill(); }
      const spot = z.state === 'search' ? z.searchC || z.lkp : z.state === 'alert' ? z.lkp : null; // where it last saw the player, or the middle of the area it is searching
      if (spot) {
        c.strokeStyle = css; c.lineWidth = 0.5; c.beginPath();
        c.moveTo(spot.x - 1, spot.z - 1); c.lineTo(spot.x + 1, spot.z + 1); c.moveTo(spot.x + 1, spot.z - 1); c.lineTo(spot.x - 1, spot.z + 1); c.stroke();
        if (z.state === 'search') { c.beginPath(); c.arc(spot.x, spot.z, TUNING.zombie.searchRadius, 0, Math.PI * 2); c.stroke(); } // the 20 m search area
      }
    }
    c.fillStyle = z.tagged || debugAI ? css : '#ffffff'; c.beginPath(); c.arc(z.x, z.z, 1.3, 0, Math.PI * 2); c.fill();
  }
  const a = Math.PI / 2 - view.yaw;
  c.fillStyle = '#e8ecef'; c.beginPath();
  c.moveTo(P.x + Math.cos(a) * 2.6, P.z + Math.sin(a) * 2.6);
  c.lineTo(P.x + Math.cos(a + 2.5) * 1.8, P.z + Math.sin(a + 2.5) * 1.8);
  c.lineTo(P.x + Math.cos(a - 2.5) * 1.8, P.z + Math.sin(a - 2.5) * 1.8);
  c.closePath(); c.fill();
  c.restore();
}
let fps = 0, fpsN = 0, fpsT = 0;
function drawHud(dt) {
  const P = S.player, B = TUNING.bow, f = Math.min(1, P.drawT / B.drawTime);
  $('hpn').textContent = Math.ceil(P.hp);
  $('hp').firstElementChild.style.width = P.hp + '%';
  $('drawn').textContent = P.drawing ? (f >= 1 ? 'full' : Math.round(f * 100) + '%') : '';
  $('draw').firstElementChild.style.width = (P.drawing ? f * 100 : 0) + '%';
  $('arrowname').textContent = P.kind === 'basic' ? 'Arrow [1]' : 'Whistling [2]';
  $('quiver').textContent = `${P.quiver.basic}   whistle ${P.quiver.lure}`;
  $('left').textContent = sim.aliveCount(S);
  const kt = sim.knifeTarget(S); // lit when the knife would hit right now (the same rule as pressing F): green = silent kill, amber = a noisy stab
  $('knife').textContent = kt ? (kt.silent ? 'silent kill' : 'stab: noisy') : S.player.knifeCd > 0 ? '...' : '';
  $('knifeRow').style.color = kt ? (kt.silent ? 'var(--ok)' : 'var(--warn)') : '';
  $('status').innerHTML = `<b style="color:${STATUS_COLOR[S.status]}">${S.status}</b>${S.bell.ring ? '<br>bell ringing: your noise is muffled' : ''}`;
  $('range').textContent = '';
  $('cross').style.display = mode === 'walk' && camBlend < 0.3 ? 'block' : 'none';
  fpsN++; fpsT += dt;
  if (fpsT > 0.5) { fps = Math.round(fpsN / fpsT); fpsN = 0; fpsT = 0; $('badge').textContent = `${backend}  ${fps} fps${pipeline ? '' : '  (no bloom)'}${audio ? '' : '  (no sound)'}`; }
}

// ---------- loop ----------
let last = performance.now(), acc = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (keys.has('ArrowLeft')) view.yaw += 1.8 * dt;
  if (keys.has('ArrowRight')) view.yaw -= 1.8 * dt;
  if (keys.has('ArrowUp')) view.pitch = clamp(view.pitch + 1.2 * dt, -1.25, 1.25);
  if (keys.has('ArrowDown')) view.pitch = clamp(view.pitch - 1.2 * dt, -1.25, 1.25);
  hurtT = Math.max(0, hurtT - dt * 1.6); shakeT = Math.max(0, shakeT - dt * 4);
  if (playing && !S.over) {
    acc += dt;
    for (let n = 0; acc >= TUNING.dt && n < 8; n++, acc -= TUNING.dt) sim.step(S, readInput());
  }
  // binoculars: every zombie inside the viewfinder (either lens) in line of sight is tagged after TAG_TIME seconds there, no button; leaving it starts over
  tagView.length = 0;
  if (mode === 'bino' && camBlend > 0.6) {
    const w = innerWidth, h = innerHeight, { r, gap } = lens(w, h), seen = new Set(), at = new THREE.Vector3();
    for (const z of S.zombies) {
      if (z.state === 'dead') continue;
      at.set(z.x, z.y + 1.1, z.z); const d = at.distanceTo(cam.position);
      if (d > 150) continue;
      at.project(cam);
      if (at.z < -1 || at.z > 1) continue; // behind the camera
      const px = (at.x * 0.5 + 0.5) * w, py = (-at.y * 0.5 + 0.5) * h;
      if (Math.min(Math.hypot(px - (w / 2 - gap), py - h / 2), Math.hypot(px - (w / 2 + gap), py - h / 2)) > r || !sim.seesZombie(S, camPos, z)) continue;
      seen.add(z.id);
      const t = z.tagged ? 0 : (tagTimers.get(z.id) || 0) + dt;
      if (t >= TAG_TIME) { sim.tagById(S, z.id); tagTimers.delete(z.id); } else if (t > 0) tagTimers.set(z.id, t);
      tagView.push({ z, t, px, py });
    }
    for (const id of [...tagTimers.keys()]) if (!seen.has(id)) tagTimers.delete(id); // out of the viewfinder or behind cover: start over
  } else tagTimers.clear();
  updateCamera(dt);
  if (audio && started) audio.update(S, S.events, dt, { x: camPos[0], y: camPos[1], z: camPos[2], fx: aimDir[0], fy: aimDir[1], fz: aimDir[2] });
  consumeEvents();
  updateRings();
  updateLamps();
  syncMeshes(dt);
  drawOverlay();
  drawMini();
  drawHud(dt);
  if (pipeline) pipeline.render(); else renderer.render(scene, cam);
}
renderer.setAnimationLoop(frame);

// Debug and tuning hooks: window.game.TUNING is live, so tweak it in the console and play.
window.game = {
  get S() { return S; }, sim, TUNING, THREE, view, backend, cam, scene, audio, vm, mats, player, knifeG, props, zm, am, models: window.__models || null, get mode() { return mode; },
  advance(seconds, inp = {}) { for (let i = 0; i < Math.round(seconds / TUNING.dt); i++) sim.step(S, { mx: 0, mz: 0, aim: aimDir, from: camPos, ...inp }); },
  teleport(x, z) { const P = S.player; P.x = x; P.z = z; P.y = sim.heightAt(S.level, x, z); },
  look(yaw, pitch = 0) { view.yaw = yaw; view.pitch = pitch; },
  aim(on) { aimHeld = !!on; },
  bino(on) { mode = on ? 'bino' : 'walk'; },
  zoom(z) { binoZoom = clamp(z, 4, 16); },
  shoot(f = 1) { return sim.fireArrow(S, aimDir, f, S.player.kind, camPos); },
  start() { playing = started = true; hideScreen(); $('help').classList.add('hidden'); if (audio) audio.resume(); },
  reset,
};
addEventListener('error', (e) => { $('badge').textContent = 'error: ' + e.message; });
