// bow.js: first-person compound bow viewmodel with a real 3D pin sight. Two paths, one contract:
//   assets (from loadBowAssets): the user's compound-bow + Avalon sight models, normalised and placed here;
//   no assets: the fully procedural bow (also the fallback when the models fail to load).
// Camera space: camera looks down -Z, +X right, +Y up, metres. Add vm.group to the camera.
//
// GEOMETRY CONTRACT (both paths): at setRaise(1) with update sway [0,0] the sight group is at
// (0, 0, -sightDist) and pin i's tip centre is at (0, -tan(pins[i].angle) * sightDist, -sightDist),
// so every pin tip lies on a ray from the camera at `angle` below the view axis. The pins are always procedural.
//
// API: createBowViewmodel({ pins: [{angle, color}], sightDist = 0.62, assets = null }) -> vm
//      loadBowAssets() -> Promise<{ bow, sight } | null>   (browser only; null = use the procedural bow)
//   vm.group  vm.setRaise(0..1)  vm.setDraw(0..1)  vm.setKind('basic'|'lure')  vm.update(dt, {sway:[x,y], moving})  vm.dispose()
//   extras: vm.sight (Group at (0,0,-sightDist) when raised), vm.pinTips (Mesh[] in pins order), vm.setNocked(bool)
//   sway [x,y] radians moves the whole bow (sight included) on screen: +x right, +y up. Idle/walk bob fades to 0 at raise 1.
//
// assets = { bow: Object3D, sight: Object3D }: the loaded FBX scenes (as FBXLoader returns them, textured). The bow is read by
// mesh name (Body_Low, Grip_Low, UpperWheel_Low, LowerWheel_Low, String_Low, StringHold_Low, Tension_Low); the sight is one mesh.
//
// Node chain: group > bobG (idle/walk offset) > swayG (aim wobble, pivots on the eye) > raiseG
// (low-ready <-> aimed pose, pivots on the grip) > root (all parts, authored in aimed camera space).
import * as THREE from 'three';

const EMI = 0xa9b3c4; // cool moon-tinted self glow so nothing is ever pure black at night
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;

// ---------- the user's models ----------
// Layout of the model path (camera space at full raise, metres). The models are cm; the bow's axle-to-axle is 135 of them, so
// 0.0062 m/cm makes it a real 84 cm compound. Sight: scaled by SK, its track face placed at (XT, YT, ZT) in the sight group.
// sd: the distance of the pin plane from the eye in the model path: the Avalon's housing (the square with the red fibre at the end of its rail) goes
// there, and its arm then ends at the front of the riser. hs: the housing's centre in the sight model, cm (measured on sight.fbx: the rail ends in a
// 9 x 11 x 11 mm box at x 4.56..5.45, y -1.5..-0.38, z -4.47..-3.36). The whole sight slides up and down to put that housing on the pin's ray.
const MD = { k: 0.0062, xs: -0.06, ya: -0.068, nock0: -0.395, sk: 0.0062, sd: 0.683, hs: [5.0, -0.94, -3.91] };
const ARROW_LEN = 0.7; // the supplied arrow (0.8 m, tip at its origin) is shown this long, nocked
const HIDE = ['String_Low', 'StringHold_Low', 'Tension_Low']; // replaced by the procedural string, nock loop and cables
const C45 = Math.SQRT1_2;
// The bow FBX is authored at 45 degrees in the Y-Z plane (up = (y-z)/sqrt2, target = (y+z)/sqrt2, string toward the archer). This proper
// rotation maps it to camera space: up +Y, target -Z, string +Z (the thickness axis x flips: the grip ends up left of the string plane).
const BOW_M = new THREE.Matrix4().set(-1, 0, 0, 0, 0, C45, -C45, 0, 0, -C45, -C45, 0, 0, 0, 0, 1);

export async function loadBowAssets(base = new URL('../assets/models/game/', import.meta.url).href) {
  try {
    const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js'); // not at import time: Node can import this file
    const loader = new FBXLoader(), tl = new THREE.TextureLoader();
    const tex = (f, srgb) => { const t = tl.load(base + f); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 4; return t; };
    // the FBX files carry no usable materials (loaded as Phong): one albedo + normal set per model, like models.js retexture()
    const dress = (root, albedo, normal, rough, metal, flipNormalY, glow) => { // glow: self-light through the albedo (the bow), or a flat lift (the near-black sight)
      const map = tex(albedo, true);
      const m = new THREE.MeshStandardMaterial({ map, normalMap: tex(normal, false), roughness: rough, metalness: metal, emissive: EMI, emissiveMap: glow ? map : null, emissiveIntensity: glow ? 0.3 : 0.035 }); // the dark sight keeps only a faint lift (more washes its numbers out to flat grey)
      if (flipNormalY) m.normalScale.set(1, -1);
      const cams = [];
      root.traverse((o) => { if (o.isCamera) cams.push(o); else if (o.isMesh) o.material = m; });
      cams.forEach((c) => c.removeFromParent());
      return root;
    };
    const [bow, sight] = await Promise.all([loader.loadAsync(base + 'bow.fbx'), loader.loadAsync(base + 'sight.fbx')]);
    return { bow: dress(bow, 'bow_albedo.jpg', 'bow_normal.jpg', 0.65, 0.15, true, true), sight: dress(sight, 'sight_albedo.jpg', 'sight_normal.jpg', 0.4, 0.45, false) };
  } catch (e) {
    console.warn('[bow] models not loaded, using the procedural bow:', e && e.message);
    return null;
  }
}

// Normalise the bow model, place it in camera space and derive every anchor from its named meshes. Returns { wrap, ... } (metres, camera space).
function prepBow(src) {
  const wrap = new THREE.Group();
  wrap.add(src.clone(true)); // clone shares geometry and materials: the assets can feed several viewmodels
  wrap.setRotationFromMatrix(BOW_M);
  wrap.scale.setScalar(MD.k);
  wrap.updateMatrixWorld(true);
  const box = (n) => {
    const m = wrap.getObjectByName(n);
    if (!m) throw new Error('bow model has no mesh ' + n);
    return new THREE.Box3().setFromObject(m, true);
  };
  const ctr = (b) => b.getCenter(V(0, 0, 0));
  const up = box('UpperWheel_Low'), lo = box('LowerWheel_Low'), grip = box('Grip_Low'), body = box('Body_Low');
  const cT = ctr(up), cB = ctr(lo), xStr = ctr(box('String_Low')).x, slide = ctr(box('StringHold_Low')), g = ctr(grip);
  HIDE.forEach((n) => { box(n); wrap.getObjectByName(n).visible = false; });
  // the string leaves each cam at its rear rim; the nock sits on that line at the arrow height
  const rimT = V(xStr, cT.y, up.max.z), rimB = V(xStr, cB.y, lo.max.z);
  // ponytail: the model has no arrow rest; the arrow height (just below the grip midpoint) was picked from the riser window and the rest is procedural
  const ya = g.y - 0.15 * (grip.max.y - grip.min.y);
  const nockZ = lerp(rimT.z, rimB.z, (rimT.y - ya) / (rimT.y - rimB.y));
  const off = V(MD.xs - xStr, MD.ya - ya, MD.nock0 - nockZ);
  wrap.position.copy(off);
  const P = (v) => v.add(off);
  return {
    wrap, camT: P(cT), camB: P(cB), rimT: P(rimT), rimB: P(rimB), slide: P(slide),
    camRT: (up.max.z - up.min.z) / 2, camRB: (lo.max.z - lo.min.z) / 2,
    grip: P(g), gripHalf: V((grip.max.x - grip.min.x) / 2, (grip.max.y - grip.min.y) / 2, (grip.max.z - grip.min.z) / 2),
    restZ: body.max.z + off.z - 0.01,
  };
}

// The supplied bow as the survivor CARRIES it (third person, string not drawn): a Group in metres with the grip's centre at the origin, the limbs along +y,
// the target toward -z and the string toward the archer (+z), the model's own string and cables shown. Rotate it into the hand's frame where it is used.
export function createHeldBow(assets) {
  const wrap = new THREE.Group();
  wrap.add(assets.bow.clone(true)); // shares geometry and materials with the first-person bow
  wrap.setRotationFromMatrix(BOW_M);
  wrap.scale.setScalar(MD.k);
  wrap.updateMatrixWorld(true);
  const grip = wrap.getObjectByName('Grip_Low');
  if (!grip) throw new Error('bow model has no mesh Grip_Low');
  wrap.position.sub(new THREE.Box3().setFromObject(grip, true).getCenter(V(0, 0, 0)));
  wrap.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  const held = new THREE.Group(); held.name = 'heldBow'; held.add(wrap);
  return held;
}

export function createBowViewmodel({ pins = [], sightDist = 0.62, assets = null } = {}) {
  let MB = null; // model path anchors, or null: the procedural bow (no assets, or assets that are not the bow + sight)
  if (assets) try { if (!assets.sight) throw new Error('no sight model'); MB = prepBow(assets.bow); } catch (e) { console.warn('[bow] unusable models, using the procedural bow: ' + e.message); }
  const D = MB ? MD.sd : sightDist; // the model path fixes its own pin plane (see MD.sd); vm.sightDist tells the caller
  const trash = []; // everything to dispose
  const track = (o) => (trash.push(o), o);

  const mat = (color, rough = 0.5, metal = 0.1, emi = 0.06, extra = {}) =>
    track(new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive: EMI, emissiveIntensity: emi, ...extra }));
  const M = {
    riser: mat(0x2b2f36, 0.4, 0.5, 0.08),
    alu: mat(0x8d949b, 0.38, 0.5, 0.07),
    steel: mat(0x6c7178, 0.35, 0.6, 0.06),
    carbon: mat(0x1b2025, 0.22, 0.15, 0.08, { side: THREE.DoubleSide }),
    rubber: mat(0x34373a, 0.9, 0.0, 0.08),
    string: mat(0x35322c, 0.8, 0.0, 0.08),
    cable: mat(0x232628, 0.8, 0.0, 0.06),
    glove: mat(0x3a403c, 0.9, 0.0, 0.08),
    leather: mat(0x4a3a2e, 0.85, 0.0, 0.07),
    sleeve: mat(0x33403f, 1.0, 0.0, 0.08),
    strap: mat(0x55595c, 0.8, 0.0, 0.06),
    shaft: mat(0xb4b9bf, 0.5, 0.1, 0.08),
    nock: mat(0xff6a1f, 0.5, 0.0, 1.0, { emissive: 0xff5a14 }),
    vane: mat(0xd9d4c0, 0.8, 0.0, 0.07, { side: THREE.DoubleSide }),
    cock: mat(0xe2661f, 0.8, 0.0, 0.1, { side: THREE.DoubleSide }),
    wood: mat(0xa27a4c, 0.8, 0.0, 0.08),
    slot: mat(0x1a1208, 1.0, 0.0, 0.03),
    sight: mat(0x2e3238, 0.4, 0.45, 0.1),
    pinBody: mat(0x2b2e33, 0.4, 0.5, 0.06),
  };

  // ---------- helpers ----------
  const geoCache = new Map();
  const cylGeo = (r, n = 8) => {
    const k = r + ':' + n;
    if (!geoCache.has(k)) geoCache.set(k, track(new THREE.CylinderGeometry(r, r, 1, n)));
    return geoCache.get(k);
  };
  const _up = V(0, 1, 0), _d = V(0, 0, 0);
  const place = (mesh, a, b) => { // stretch a unit-length Y cylinder from a to b
    _d.subVectors(b, a);
    const len = _d.length() || 1e-6;
    mesh.position.addVectors(a, b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(_up, _d.multiplyScalar(1 / len));
    mesh.scale.set(1, len, 1);
  };
  const add = (parent, geo, m, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  const rod = (parent, m, r, a, b, n = 8) => { const mesh = new THREE.Mesh(cylGeo(r, n), m); place(mesh, a, b); parent.add(mesh); return mesh; };
  const capsule = (parent, m, r, a, b) => {
    const len = Math.max(1e-4, a.distanceTo(b) - 2 * r);
    const mesh = new THREE.Mesh(track(new THREE.CapsuleGeometry(r, len, 4, 10)), m);
    mesh.position.addVectors(a, b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(_up, _d.subVectors(b, a).normalize());
    parent.add(mesh);
    return mesh;
  };
  const blob = (parent, m, r, x, y, z, sx = 1, sy = 1, sz = 1) => {
    const mesh = add(parent, track(new THREE.SphereGeometry(r, 16, 12)), m, x, y, z);
    mesh.scale.set(sx, sy, sz);
    return mesh;
  };

  // ---------- layout (camera space at full raise) ----------
  // XR and ZR are the hand frame in the model path (the grip centre x, the grip rear face z - 38 mm), the riser frame in the procedural one.
  const ZR = MB ? MB.grip.z + MB.gripHalf.z - 0.0385 : -(D - 0.075); // riser / arrow rest depth; the sight bracket reaches 75 mm further forward
  const XS = MB ? MD.xs : 0.046; // string plane x == arrow axis x
  const YA = MB ? MD.ya : -0.068; // arrow axis height (below the sight axis, like a real centre-shot rig)
  const XR = MB ? MB.grip.x : -0.05; // riser spine centre x
  const YT = 0.098, YB = -0.248; // limb pocket centres (riser top / bottom)
  const RISE = 0.27;         // pocket to cam height
  const BRACE = 0.15;        // string behind the rest at rest
  const DRAW = 0.32;         // string travel
  const GRIP = MB ? MB.grip.clone() : V(XR - 0.012, -0.115, ZR + 0.03); // pivot of the bow hand
  const HY = MB ? MB.grip.y + 0.125 : 0; // the hands below were drawn round a grip at y = -0.125
  const LIMB_X = [XS - 0.0135, XS + 0.0135];

  const group = new THREE.Group(); group.name = 'bowViewmodel';
  const bobG = new THREE.Group(); group.add(bobG);
  const swayG = new THREE.Group(); swayG.rotation.order = 'YXZ'; bobG.add(swayG);
  const raiseG = new THREE.Group(); raiseG.rotation.order = 'YXZ'; swayG.add(raiseG);
  const root = new THREE.Group(); root.position.copy(GRIP).multiplyScalar(-1); raiseG.add(root);

  // ---------- riser ----------
  if (MB) {
    root.add(MB.wrap); // riser, grip, limbs, cams, cable guard rod: static meshes (ponytail: no limb flex or cam turn, the string just moves back)
    // the model has no arrow rest: a blade pair under the arrow and a shelf
    for (const dx of [-0.0035, 0.0035]) add(root, track(new THREE.BoxGeometry(0.0035, 0.012, 0.03)), M.steel, XS + dx, YA - 0.007, MB.restZ);
    add(root, track(new THREE.BoxGeometry(0.02, 0.006, 0.032)), M.riser, XS, YA - 0.013, MB.restZ);
  } else {
    // side profile in (z, y), extruded along x (spine thickness 30 mm)
    const rows = [ // y, half depth rear (toward the shooter), half depth front
      [0.108, 0.024, 0.026], [0.075, 0.017, 0.018], [0.03, 0.012, 0.013], [-0.02, 0.012, 0.013], [-0.065, 0.015, 0.016],
      [-0.095, 0.026, 0.017], [-0.15, 0.03, 0.017], [-0.19, 0.022, 0.016], [-0.225, 0.017, 0.019], [-0.258, 0.024, 0.026],
    ];
    const curve = (idx) => new THREE.SplineCurve(rows.map((r) => new THREE.Vector2(ZR + (idx === 1 ? r[1] : -r[2]), r[0]))).getPoints(48);
    const rear = curve(1), front = curve(2).reverse();
    const shape = new THREE.Shape();
    shape.moveTo(rear[0].x, rear[0].y);
    for (const p of rear) shape.lineTo(p.x, p.y);
    for (const p of front) shape.lineTo(p.x, p.y);
    const geo = track(new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.0035, bevelSegments: 3, curveSegments: 4 }));
    geo.rotateY(-Math.PI / 2); // shape x -> world z, extrusion -> world -x
    geo.translate(XR + 0.01, 0, 0);
    add(root, geo, M.riser);
    add(root, track(new THREE.BoxGeometry(0.004, 0.13, 0.0016)), M.steel, XR, 0.025, ZR + 0.0162); // machined stripe
    // limb pockets, bridged to the spine
    for (const [yc, s] of [[YT, 1], [YB, -1]]) {
      add(root, track(new THREE.BoxGeometry(0.056, 0.03, 0.05)), M.riser, XS, yc, ZR);
      for (const lx of LIMB_X) { const bolt = add(root, cylGeo(0.0042, 6), M.alu, lx, yc, ZR + 0.0255); bolt.rotation.x = Math.PI / 2; bolt.scale.set(1, 0.004, 1); }
      rod(root, M.riser, 0.0105, V(XR, yc - s * 0.013, ZR), V(XS - 0.02, yc, ZR), 10);
    }
    // grip: rubber wrap on the rear of the handle
    capsule(root, M.rubber, 0.0185, V(XR, -0.1, ZR + 0.02), V(XR, -0.15, ZR + 0.02));
    // arrow shelf and rest (launcher arm + blade under the arrow)
    add(root, track(new THREE.BoxGeometry(0.05, 0.006, 0.032)), M.riser, XR + 0.03, YA - 0.013, ZR - 0.004);
    rod(root, M.alu, 0.0028, V(XR + 0.012, YA - 0.006, ZR + 0.002), V(XS - 0.004, YA - 0.006, ZR + 0.002), 6);
    add(root, track(new THREE.BoxGeometry(0.0035, 0.012, 0.03)), M.steel, XS - 0.0035, YA - 0.007, ZR - 0.002);
    add(root, track(new THREE.BoxGeometry(0.0035, 0.012, 0.03)), M.steel, XS + 0.0035, YA - 0.007, ZR - 0.002);
    // stabiliser: forward and left, with a weight and a rubber cap
    const s0 = V(XR - 0.002, -0.1, ZR - 0.026), s1 = V(XR - 0.055, -0.108, ZR - 0.36);
    rod(root, M.riser, 0.0062, s0, s1, 10);
    const dir = s1.clone().sub(s0).normalize();
    rod(root, M.alu, 0.0115, s1.clone().addScaledVector(dir, -0.07), s1.clone().addScaledVector(dir, -0.012), 14);
    blob(root, M.rubber, 0.0118, s1.x + dir.x * 0.002, s1.y + dir.y * 0.002, s1.z + dir.z * 0.002, 1, 1, 0.6);
    // cable guard rod: short rod going back from the spine, cables ride on it
    rod(root, M.alu, 0.0028, V(XR - 0.004, -0.04, ZR + 0.012), V(XR - 0.004, -0.04, ZR + BRACE - 0.005), 6);
  }

  // ---------- sight (centred on the view axis at z = -D) ----------
  const sight = new THREE.Group(); sight.name = 'sight'; sight.position.set(0, 0, -D); root.add(sight);
  const pinTips = [], pinSet = [];
  const PX = 0.034; // where the pin rods leave the pin guard (procedural sight only)
  let sightModel = null;
  if (MB) { sightModel = assets.sight.clone(true); sightModel.scale.setScalar(MD.sk); sight.add(sightModel); } // the Avalon slider sight: its housing is at the pin, the arm runs back to the riser
  if (!MB) {
    const arc = 290 * Math.PI / 180;
    const ring = add(sight, track(new THREE.TorusGeometry(0.022, 0.0013, 8, 64, arc)), M.sight);
    ring.rotation.z = -55 * Math.PI / 180; // open gap at the bottom so the lower pins clear the ring
    // housing depth: a second, thinner arc behind the ring, joined by three short posts
    const ring2 = add(sight, track(new THREE.TorusGeometry(0.022, 0.0009, 6, 64, arc)), M.sight, 0, 0, 0.014);
    ring2.rotation.z = ring.rotation.z;
    for (const a of [Math.PI / 2, Math.PI, 0]) rod(sight, M.sight, 0.0007, V(Math.cos(a) * 0.022, Math.sin(a) * 0.022, 0), V(Math.cos(a) * 0.022, Math.sin(a) * 0.022, 0.014), 4);
    // pin guard: vertical bar on the right with a bracket from the ring
    const barBot = Math.min(-0.03, ...pins.map((p) => -Math.tan(p.angle) * D)) - 0.01;
    rod(sight, M.sight, 0.0022, V(0.034, 0.02, 0), V(0.034, barBot, 0), 8);
    rod(sight, M.sight, 0.0016, V(0.0215, 0.0, 0), V(0.034, 0.0, 0), 6);
    rod(sight, M.sight, 0.0016, V(0.0125, -0.018, 0), V(0.034, -0.018, 0), 6);
    rod(sight, M.sight, 0.0022, V(0.034, 0.0, 0), V(0.034, 0.0, 0.03), 6);
    // mounting: arm back to the riser, small crossbar behind the ring
    rod(root, M.sight, 0.0045, V(XR + 0.005, -0.002, ZR - 0.03), V(XR + 0.005, -0.002, -D + 0.004), 8);
    rod(root, M.sight, 0.0035, V(XR + 0.005, -0.002, -D + 0.004), V(-0.02, -0.0, -D + 0.004), 8);
    add(root, track(new THREE.BoxGeometry(0.022, 0.028, 0.02)), M.riser, XR + 0.005, -0.002, ZR - 0.038);
  }
  {
    // soft glow texture for the fibre tips
    let glowTex = null;
    if (typeof document !== 'undefined') {
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const g = cv.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      glowTex = track(new THREE.CanvasTexture(cv));
      glowTex.colorSpace = THREE.SRGBColorSpace;
    }
    const tipGeo = track(new THREE.SphereGeometry(0.0013, 12, 8)), glowGeo = track(new THREE.PlaneGeometry(0.0075, 0.0075));
    pins.forEach((p) => {
      const y = -Math.tan(p.angle) * D;
      const prod = MB ? null : rod(sight, M.pinBody, 0.00045, V(PX, y, 0), V(0.0, y, 0), 5); // the model's own housing carries its fibre: no rod
      const tm = track(new THREE.MeshStandardMaterial({ color: p.color, emissive: p.color, emissiveIntensity: 3, roughness: 0.4, toneMapped: false }));
      const tip = add(sight, tipGeo, tm, 0, y, 0);
      tip.name = 'pinTip';
      pinSet.push({ tip, glow: null, rod: prod });
      if (!glowTex) { pinTips.push(tip); return; }
      const gm = track(new THREE.MeshBasicMaterial({ color: p.color, map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, opacity: 0.7 }));
      const glow = add(sight, glowGeo, gm, 0, y, 0.0006);
      glow.renderOrder = 5;
      pinSet[pinSet.length - 1].glow = glow;
      pinTips.push(tip);
    });
  }
  // A pin's height is its ballistic ray at the pin plane: the tip, its glow, the procedural rod, and (pin 0, model path) the whole sight, which slides so
  // that its housing is on the tip.
  function setPinY(i, y) {
    const o = pinSet[i]; if (!o) return;
    o.tip.position.y = y; if (o.glow) o.glow.position.y = y;
    if (o.rod) place(o.rod, V(PX, y, 0), V(0, y, 0));
    if (sightModel && i === 0) sightModel.position.set(-MD.hs[0] * MD.sk, y - MD.hs[1] * MD.sk, -MD.hs[2] * MD.sk);
  }
  pins.forEach((p, i) => setPinY(i, -Math.tan(p.angle) * D));

  // ---------- limbs, cams, string, cables ----------
  function ribbon(N, wA, wB, tA, tB) { // tapered rectangular strip along a curve in the y-z plane
    const pos = new Float32Array(N * 4 * 3), idx = [];
    for (let i = 0; i < N - 1; i++) for (let k = 0; k < 4; k++) {
      const a = i * 4 + k, b = i * 4 + (k + 1) % 4, c = (i + 1) * 4 + k, d = (i + 1) * 4 + (k + 1) % 4;
      idx.push(a, c, b, b, c, d);
    }
    const e = (N - 1) * 4;
    idx.push(0, 1, 2, 0, 2, 3, e, e + 2, e + 1, e, e + 3, e + 2);
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, M.carbon);
    const _t = V(0, 0, 0);
    mesh.userData.set = (pts, x) => {
      for (let i = 0; i < N; i++) {
        _t.subVectors(pts[Math.min(i + 1, N - 1)], pts[Math.max(i - 1, 0)]).normalize();
        const s = i / (N - 1), w = lerp(wA, wB, s) / 2, t = lerp(tA, tB, s) / 2;
        const ny = -_t.z, nz = _t.y; // in-plane normal
        const p = pts[i];
        for (let k = 0; k < 4; k++) {
          const sx = k === 0 || k === 3 ? 1 : -1, sn = k < 2 ? 1 : -1;
          const o = (i * 4 + k) * 3;
          pos[o] = x + sx * w;
          pos[o + 1] = p.y + sn * t * ny;
          pos[o + 2] = p.z + sn * t * nz;
        }
      }
      geo.attributes.position.needsUpdate = true;
      geo.computeVertexNormals();
    };
    return mesh;
  }

  // eccentric cam: lobed profile with lightening holes, axle along x
  const camGeo = MB ? null : (() => {
    const s = new THREE.Shape();
    for (let i = 0; i <= 48; i++) { const a = i / 48 * Math.PI * 2, r = 0.027 + 0.008 * (1 + Math.cos(a - 0.8)) / 2 + 0.003 * Math.cos(2 * a); const x = r * Math.cos(a), y = r * Math.sin(a); i ? s.lineTo(x, y) : s.moveTo(x, y); }
    for (let k = 0; k < 3; k++) { const a = k / 3 * Math.PI * 2 + 0.3, h = new THREE.Path(); h.absarc(0.0165 * Math.cos(a), 0.0165 * Math.sin(a), 0.0065, 0, Math.PI * 2, true); s.holes.push(h); }
    const g = track(new THREE.ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.001, bevelSegments: 1, curveSegments: 6 }));
    g.rotateY(Math.PI / 2); g.center();
    return g;
  })();
  const camDisc = MB ? null : track(new THREE.CylinderGeometry(0.02, 0.02, 0.006, 24));
  const axleGeo = MB ? null : track(new THREE.CylinderGeometry(0.0035, 0.0035, 0.046, 10));

  const ENDS = MB ? [] : [1, -1].map((s) => {
    const yRoot = s > 0 ? YT : YB;
    const ribbons = LIMB_X.map((x) => { const m = ribbon(12, 0.013, 0.0105, 0.012, 0.0055); root.add(m); return { m, x }; });
    const camG = new THREE.Group(); root.add(camG);
    const cam = add(camG, camGeo, M.alu); // rotates
    add(cam, camDisc, M.steel, 0.011, 0, 0).rotation.z = Math.PI / 2;
    add(camG, axleGeo, M.steel).rotation.z = Math.PI / 2;
    return { s, yRoot, ribbons, camG, cam };
  });
  const pts = Array.from({ length: 12 }, () => V(0, 0, 0));
  const R = V(0, 0, 0), C = V(0, 0, 0), T = V(0, 0, 0);

  const strTop = new THREE.Mesh(cylGeo(0.00085, 5), M.string), strBot = new THREE.Mesh(cylGeo(0.00085, 5), M.string);
  const cabA = new THREE.Mesh(cylGeo(0.0011, 5), M.cable), cabB = new THREE.Mesh(cylGeo(0.0011, 5), M.cable);
  root.add(strTop, strBot, cabA, cabB);
  const dLoop = add(root, track(new THREE.TorusGeometry(0.0055, 0.0011, 6, 14)), M.string);

  // ---------- arrow (origin at the nock groove, shaft toward -Z) ----------
  const arrow = new THREE.Group(); root.add(arrow);
  const L = 0.6;
  {
    const sh = rod(arrow, M.shaft, 0.0033, V(0, 0, -0.012), V(0, 0, -(L - 0.03)), 10);
    sh.name = 'shaft';
    rod(arrow, M.nock, 0.0046, V(0, 0, 0), V(0, 0, -0.02), 10);
    const vg = track(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.058, 0), new THREE.Vector2(0.05, 0.0105), new THREE.Vector2(0.01, 0.0105)])));
    for (let k = 0; k < 3; k++) {
      const holder = new THREE.Group(); holder.rotation.z = k * Math.PI * 2 / 3 + 0.35; arrow.add(holder);
      const vane = add(holder, vg, k === 0 ? M.cock : M.vane);
      vane.rotation.set(0, Math.PI / 2, 0); // shape x -> -z (along shaft), shape y -> radial +y of holder
      vane.position.set(0, 0.003, -0.026);
    }
  }
  const headBasic = new THREE.Group(), headLure = new THREE.Group();
  arrow.add(headBasic, headLure);
  let modelArrow = null, kind = 'basic', procedural = []; // the supplied arrow (setArrowModel) stands in for the plain arrow; the whistling one stays procedural
  {
    const cone = add(headBasic, track(new THREE.ConeGeometry(0.0046, 0.04, 14)), M.steel, 0, 0, -(L - 0.03 + 0.02));
    cone.rotation.x = -Math.PI / 2;
    // kabura-ya: blunt tip in front of a bulbous, slotted whistle head
    rod(headLure, M.steel, 0.0052, V(0, 0, -(L - 0.03)), V(0, 0, -(L - 0.012)), 12);
    blob(headLure, M.steel, 0.0052, 0, 0, -(L - 0.012), 1, 1, 0.6);
    blob(headLure, M.wood, 0.0175, 0, 0, -(L - 0.075), 1, 1, 1.55);
    for (let k = 0; k < 4; k++) { // dark vent slots on the rear of the bulb
      const a = k * Math.PI / 2 + 0.4, d = V(Math.cos(a) * 0.8, Math.sin(a) * 0.8, 0.6).normalize();
      const slot = add(headLure, track(new THREE.CylinderGeometry(0.0038, 0.0038, 0.004, 10)), M.slot, d.x * 0.0176, d.y * 0.0176, -(L - 0.075) + d.z * 0.027);
      slot.quaternion.setFromUnitVectors(_up, d);
    }
    rod(headLure, M.steel, 0.0058, V(0, 0, -(L - 0.118)), V(0, 0, -(L - 0.112)), 12);
    headLure.visible = false;
  }
  procedural = [...arrow.children];
  function showArrow() {
    const useModel = !!modelArrow && kind !== 'lure';
    for (const o of procedural) o.visible = !useModel;
    headBasic.visible = !useModel && kind !== 'lure'; headLure.visible = !useModel && kind === 'lure';
    if (modelArrow) modelArrow.visible = useModel;
  }

  // ---------- right hand with release aid (follows the nock) ----------
  const rhand = new THREE.Group(); root.add(rhand);
  const hand = new THREE.Group(); rhand.add(hand); // the part that swings away from the sight at low draw
  {
    rod(rhand, M.alu, 0.0042, V(0, 0, 0.002), V(0, 0, 0.03), 10); // caliper head
    rod(hand, M.alu, 0.0072, V(0, 0, 0.03), V(0, -0.003, 0.07), 10); // release body
    blob(hand, M.glove, 0.024, 0.008, -0.008, 0.095, 0.85, 0.95, 1.3); // fist
    for (let k = 0; k < 4; k++) capsule(hand, M.glove, 0.0062, V(-0.01, 0.014 - k * 0.0105, 0.09), V(-0.012, 0.014 - k * 0.0105, 0.055)); // fingers curled round the release
    capsule(hand, M.glove, 0.0085, V(0.002, 0.024, 0.1), V(-0.002, 0.022, 0.062)); // thumb on top
    rod(hand, M.strap, 0.021, V(0.016, -0.014, 0.135), V(0.024, -0.016, 0.16), 14); // wrist strap
    rod(hand, M.sleeve, 0.027, V(0.022, -0.016, 0.15), V(0.3, -0.09, 0.5), 14); // forearm toward the shoulder (away to the right)
  }

  // ---------- left (bow) hand and forearm ----------
  const hg = new THREE.Group(); hg.position.y = HY; root.add(hg); // the procedural bow hand: hidden when the survivor's own arms are set (setArms)
  {
    blob(hg, M.glove, 1, XR - 0.015, -0.118, ZR + 0.04, 0.03, 0.04, 0.026); // palm heel behind the grip
    blob(hg, M.glove, 1, XR - 0.05, -0.118, ZR + 0.008, 0.016, 0.038, 0.036); // fingers wrapped round the front
    for (let k = 0; k < 4; k++) blob(hg, M.glove, 0.0085, XR - 0.06, -0.1 - k * 0.0165, ZR - 0.012, 1, 1, 1.3); // knuckle bumps
    capsule(hg, M.glove, 0.0105, V(XR + 0.006, -0.1, ZR + 0.04), V(XR + 0.015, -0.066, ZR + 0.02)); // thumb along the riser
    capsule(hg, M.glove, 0.03, V(XR - 0.03, -0.152, ZR + 0.06), V(XR - 0.06, -0.185, ZR + 0.13)); // cuff
    rod(hg, M.sleeve, 0.036, V(XR - 0.055, -0.18, ZR + 0.115), V(-0.36, -0.3, 0.02), 16);
    rod(hg, M.strap, 0.0345, V(XR - 0.045, -0.17, ZR + 0.095), V(XR - 0.055, -0.18, ZR + 0.115), 16);
  }

  // ---------- hand targets for the survivor's arms (fparms.js): +y = the way the fingers point, +z = the way the palm faces ----------
  const handMark = (parent, pos, fingers, palm) => {
    const o = new THREE.Object3D(), y = V(...fingers).normalize(), z = V(...palm); z.addScaledVector(y, -z.dot(y)).normalize();
    o.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(y, z), y, z)); o.position.set(...pos); parent.add(o);
    return o;
  };
  // The bow hand, as archery coaching has it: the grip sits in the web between thumb and index finger (the thumb pad), the wrist is straight so the hand continues the
  // arm toward the target, the fingers are loose and point forward alongside the grip, the palm turned inward (knuckles at about 45 degrees), the thumb forward.
  const gripMark = handMark(root, [XR - 0.038, -0.118 + HY, ZR + 0.06], [-0.25, 0.15, -0.95], [0.4, 0.2, -0.85]); // left of the sight line, so the pin stays clear
  const nockMark = handMark(rhand, [0.07, -0.075, 0.16], [0, 0.25, -0.97], [-1, 0, 0]);                     // the draw hand: low and right of the string, so it sits below the frame at brace and passes behind the eye plane as the bow is drawn (the release aid is procedural)
  let arms = null;

  // ---------- state + pose ----------
  let raise = 1, draw = 0, nocked = true;
  const nockZ0 = MB ? MD.nock0 : ZR + BRACE;
  // model path: the string leaves each cam at its rear rim, the cables run from the cams to the slide on the guard rod (static: the cams do not turn)
  const fixed = MB && {
    aTop: MB.rimT, aBot: MB.rimB, slide: MB.slide,
    cabT: V(MB.camT.x, MB.camT.y - 0.5 * MB.camRT, MB.camT.z), cabB: V(MB.camB.x, MB.camB.y + 0.5 * MB.camRB, MB.camB.z),
  };

  function applyDraw() {
    const f = draw;
    for (const e of ENDS) {
      const yTip = e.yRoot + e.s * (RISE - 0.02 * f);
      const camZ = ZR + 0.115 + 0.035 * f;
      for (const { m, x } of e.ribbons) {
        R.set(x, e.yRoot, ZR + 0.014); T.set(x, yTip, camZ);
        C.set(x, e.yRoot + e.s * RISE * 0.5, ZR + 0.014 + 0.002);
        for (let i = 0; i < pts.length; i++) {
          const s = i / (pts.length - 1), u = 1 - s;
          pts[i].set(0, u * u * R.y + 2 * u * s * C.y + s * s * T.y, u * u * R.z + 2 * u * s * C.z + s * s * T.z);
        }
        m.userData.set(pts, x);
      }
      e.camG.position.set(XS, yTip, camZ);
      e.cam.rotation.x = e.s * f * 2.4;
    }
    const nock = V(XS, YA, nockZ0 + f * DRAW);
    if (fixed) {
      place(strTop, fixed.aTop, nock); place(strBot, nock, fixed.aBot);
      place(cabA, fixed.cabT, fixed.slide); place(cabB, fixed.slide, fixed.cabB);
    } else {
      const top = ENDS[0], bot = ENDS[1];
      const camTopZ = top.camG.position.z, camBotZ = bot.camG.position.z;
      const aTop = V(XS, top.camG.position.y - 0.012, camTopZ + 0.033), aBot = V(XS, bot.camG.position.y + 0.012, camBotZ + 0.033);
      place(strTop, aTop, nock); place(strBot, nock, aBot);
      const slide = V(XR - 0.004, -0.04, ZR + BRACE - 0.005);
      place(cabA, V(XS - 0.012, top.camG.position.y - 0.006, camTopZ + 0.026), slide);
      place(cabB, slide, V(XS - 0.012, bot.camG.position.y + 0.006, camBotZ + 0.026));
    }
    dLoop.position.copy(nock).add(V(0, 0, 0.003)); dLoop.rotation.y = Math.PI / 2;
    arrow.position.copy(nock);
    rhand.position.copy(nock);
    hand.rotation.set(0.5 * (1 - f), 0.5 * (1 - f), 0);
    arrow.visible = nocked;
  }

  const LOW = { pos: V(-0.2, -0.3, -0.3), rx: -0.7, ry: 0.5, rz: -0.18 }; // low-ready: grip near the left hip, bow pitched forward
  function applyRaise() {
    const e = raise;
    raiseG.position.set(lerp(LOW.pos.x, GRIP.x, e), lerp(LOW.pos.y, GRIP.y, e), lerp(LOW.pos.z, GRIP.z, e));
    raiseG.rotation.set(LOW.rx * (1 - e), LOW.ry * (1 - e), LOW.rz * (1 - e));
  }

  group.traverse((o) => { o.frustumCulled = false; });
  root.traverse((o) => { o.frustumCulled = false; });
  applyDraw(); applyRaise();

  // ---------- public API ----------
  let t = 0, walk = 0, walkAmt = 0;
  const vm = {
    group, sight, pinTips,
    setRaise(r) { raise = clamp01(r); applyRaise(); },
    setDraw(f) { draw = clamp01(f); applyDraw(); },
    setKind(k) { kind = k; showArrow(); },
    // The supplied arrow model (models.js cloneProp(props.arrow): 0.8 m long, tip at its origin, pointing +z) as the nocked plain arrow.
    setArrowModel(model) {
      if (modelArrow) modelArrow.removeFromParent();
      modelArrow = new THREE.Group(); model.rotation.y = Math.PI; model.position.z = -ARROW_LEN; model.scale.setScalar(ARROW_LEN / 0.8); // nock at the origin, tip toward the target
      model.traverse((o) => { o.frustumCulled = false; });
      modelArrow.add(model); arrow.add(modelArrow); showArrow();
    },
    // Moves pin i to the ballistic angle (rad below the line of sight): the range setting of the slider sight.
    setPin(i, angle) { setPinY(i, -Math.tan(angle) * D); },
    sightDist: D,
    setNocked(b) { nocked = !!b; arrow.visible = nocked; },
    // sway [x, y] radians: sight offset on screen (+x right, +y up). Idle/walk motion fades out to exactly 0 at raise 1.
    update(dt, { sway = [0, 0], moving = false } = {}) {
      t += dt;
      walkAmt += ((moving ? 1 : 0) - walkAmt) * Math.min(1, dt * 6);
      walk += dt * 9.5 * walkAmt;
      const loose = 1 - raise;
      bobG.position.set(
        (Math.sin(walk * 0.5) * 0.006 * walkAmt + Math.sin(t * 0.7) * 0.0015) * loose,
        (-Math.abs(Math.sin(walk * 0.5)) * 0.009 * walkAmt + Math.sin(t * 1.25) * 0.002) * loose,
        0,
      );
      bobG.rotation.set(Math.sin(t * 1.25 + 0.6) * 0.004 * loose, 0, Math.sin(walk * 0.5) * 0.012 * walkAmt * loose);
      swayG.rotation.set(sway[1], -sway[0], 0);
      if (arms) arms.update(gripMark, nockMark); // after everything above has moved: the arms reach for the grip and the nock
    },
    // The survivor's own arms (fparms.js createArms) in place of the procedural gloves and sleeves. They hang off the eye (swayG), not off the raised bow.
    setArms(a) { arms = a; swayG.add(a.group); hg.visible = false; hand.visible = false; },
    markers: { grip: gripMark, nock: nockMark },
    dispose() {
      group.removeFromParent();
      for (const o of trash) o.dispose?.();
      trash.length = 0;
    },
  };
  return vm;
}
