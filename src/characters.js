// characters.js: procedural, articulated, animated humanoids (player archer + four zombie kinds). No assets.
//   createPlayerFigure()   -> fig
//   createZombieFigure(z)  -> fig        z = { id, kind: 'hunter'|'scout'|'sleeper'|'screamer' }
//   fig = { root, head, update(dt, p), dispose() }
// root: feet at local y=0, facing +Z. The caller sets root.position / root.rotation.y; only children are animated here.
// p = { speed, state: 'idle'|'dormant'|'suspicious'|'alert'|'search'|'caution'|'dead', attacking, crouch, drawing, sees }
// Geometries and materials are cached at module level and shared by every figure (dispose() does not free them).
import * as THREE from 'three';

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;
const sstep = (x, a, b) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const rnd = (n, salt = 0) => { const s = Math.sin(n * 127.1 + salt * 311.7 + 1.3) * 43758.5453; return s - Math.floor(s); };
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

// ---------- shared geometry / material caches ----------
const geos = new Map(), mats = new Map();
const geo = (key, make) => { let g = geos.get(key); if (!g) geos.set(key, (g = make())); return g; };
const mat = (color, side) => {
  const key = color + (side ? 'd' : '');
  let m = mats.get(key);
  if (!m) mats.set(key, (m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: side ? THREE.DoubleSide : THREE.FrontSide })));
  return m;
};
export function disposeShared() { geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); geos.clear(); mats.clear(); }

const limbG = (r, L) => geo(`l${r}_${L}`, () => new THREE.CapsuleGeometry(r, L - 2 * r, 3, 8).translate(0, -L / 2, 0)); // top at origin, hangs down
const capG = (r, L) => geo(`c${r}_${L}`, () => new THREE.CapsuleGeometry(r, L - 2 * r, 4, 10));
const ballG = () => geo('ball', () => new THREE.SphereGeometry(1, 14, 10));
const boxG = (w, h, d) => geo(`b${w}_${h}_${d}`, () => new THREE.BoxGeometry(w, h, d));
const cylG = (rt, rb, h, open) => geo(`y${rt}_${rb}_${h}_${open}`, () => new THREE.CylinderGeometry(rt, rb, h, 12, 1, open));
const hoodG = () => geo('hood', () => new THREE.SphereGeometry(1, 16, 12, Math.PI - 0.6, Math.PI + 1.2, 0, 2.3)); // open at the face
const capHeadG = (th) => geo('cap' + th, () => new THREE.SphereGeometry(1, 16, 10, 0, TAU, 0, th));
const bowG = () => geo('bow', () => { const g = new THREE.TorusGeometry(1, 0.014, 6, 24, 1.4); g.rotateZ(-0.7); g.rotateY(-Math.PI / 2); g.translate(0, 0, -1); return g; });
const rodG = (r) => geo('rod' + r, () => new THREE.CylinderGeometry(r, r, 1, 5)); // unit length along Y

const part = (parent, g, m, x = 0, y = 0, z = 0, sx = 1, sy = sx, sz = sx) => {
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
};
const joint = (parent, x = 0, y = 0, z = 0) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };

// ---------- skeleton dimensions (metres, standing, before height scale) ----------
const D = { thigh: 0.44, shin: 0.42, ankle: 0.07, hipY: -0.02, hipX: 0.1, spine0: 0.04, abd: 0.28, neckY: 0.3, shX: 0.215, shY: 0.27, uarm: 0.29, farm: 0.27, headY: 0.17 };
const PELVIS_STAND = D.ankle - D.hipY + D.thigh + D.shin;
const REF_H = PELVIS_STAND + D.spine0 + D.abd + D.neckY + D.headY + 0.115;

// ---------- rig builder ----------
// o: { H, w (torso width), hw (head width), skin, chest, abd, sleeve, fore, hand, thigh, shinL, shinR, shoe, hem, hood, cap, zombie, bigMouth, player }
function buildRig(o) {
  const rig = new THREE.Group();
  rig.scale.setScalar(o.H / REF_H);
  const J = { arms: [], legs: [] };
  const w = o.w || 1, hw = o.hw || 1;
  J.pelvis = joint(rig, 0, PELVIS_STAND, 0);
  J.pelvis.rotation.order = 'YXZ';
  part(J.pelvis, ballG(), o.thigh, 0, 0, 0, 0.175 * w, 0.11, 0.12);
  if (o.hem) part(J.pelvis, cylG(o.hem.rt, o.hem.rb, o.hem.h, true), o.hem.mat, 0, o.hem.y, 0, 1, 1, 0.78);
  J.spine = joint(J.pelvis, 0, D.spine0, 0); J.spine.rotation.order = 'YXZ';
  part(J.spine, capG(0.125, 0.32), o.abd, 0, 0.14, 0, 1.25 * w, 1, 0.88);
  J.chest = joint(J.spine, 0, D.abd, 0); J.chest.rotation.order = 'YXZ';
  J.chestMesh = part(J.chest, capG(0.15, 0.4), o.chest, 0, 0.15, 0, 1.4 * w, 1, 0.82);
  J.neck = joint(J.chest, 0, D.neckY, 0); J.neck.rotation.order = 'YXZ';
  part(J.neck, cylG(0.045, 0.05, 0.08), o.skin, 0, 0.03, 0);
  J.head = joint(J.neck, 0, D.headY, 0);
  part(J.head, ballG(), o.skin, 0, 0, 0, 0.095 * hw, 0.115, 0.105);
  if (o.zombie) {
    const ex = o.eyeX || 0.04, es = o.eyeS || 1;
    part(J.head, ballG(), mat(0x0b0d0f), ex * hw, 0.02, 0.098, 0.023 * es, 0.019 * es, 0.016);
    part(J.head, ballG(), mat(0x0b0d0f), -ex * hw, 0.02, 0.098, 0.023 * es, 0.019 * es, 0.016);
    J.jaw = joint(J.head, 0, -0.035, 0);
    part(J.jaw, ballG(), o.skin, 0, -0.04, 0.04, 0.066 * hw, 0.04, 0.07);
    part(J.head, ballG(), mat(0x120c0c), 0, -0.058, o.bigMouth ? 0.082 : 0.088, o.bigMouth ? 0.05 : 0.036, o.bigMouth ? 0.05 : 0.016, 0.02);
  }
  if (o.player) for (const sx of [-1, 1]) part(J.head, ballG(), mat(0x2a211c), sx * 0.04, 0.02, 0.1, 0.014, 0.012, 0.01);
  if (o.hood) part(J.head, hoodG(), o.hood, 0, 0.0, -0.018, 0.125 * hw, 0.135, 0.13);
  if (o.cap) {
    const c = part(J.head, capHeadG(o.cap.theta), o.cap.mat, 0, o.cap.y, 0, o.cap.sx * hw, o.cap.sy, o.cap.sz);
    c.rotation.x = o.cap.tilt;
  }
  for (let i = 0; i < 2; i++) {
    const side = 1 - 2 * i; // +x is the character's left
    const sh = joint(J.chest, side * D.shX, D.shY, 0); sh.rotation.order = 'YZX';
    part(sh, limbG(0.059, D.uarm), o.sleeve);
    const el = joint(sh, 0, -D.uarm, 0);
    part(el, limbG(0.051, D.farm), o.fore);
    const wr = joint(el, 0, -D.farm, 0);
    part(wr, ballG(), o.hand, 0, -0.04, 0, 0.048, 0.062, 0.04);
    J.arms.push({ sh, el, wr });
    const hip = joint(J.pelvis, side * D.hipX, D.hipY, 0);
    part(hip, limbG(0.087, D.thigh), o.thigh);
    const kn = joint(hip, 0, -D.thigh, 0);
    part(kn, limbG(0.064, D.shin), i ? o.shinR : o.shinL);
    const an = joint(kn, 0, -D.shin, 0);
    part(an, ballG(), o.shoe, 0, -0.03, 0.06, 0.058, 0.042, 0.14);
    J.legs.push({ hip, kn, an });
  }
  if (o.player) { // quiver with arrows on the back
    const q = part(J.chest, cylG(0.06, 0.07, 0.5), mat(0x6a4a2e), -0.08, 0.1, -0.17);
    q.rotation.z = 0.18; q.rotation.x = -0.1;
    for (let i = 0; i < 2; i++) {
      const a = part(J.chest, rodG(0.009), mat(0xe6d9b0), -0.1 + i * 0.045 - 0.04, 0.4, -0.185 - i * 0.02, 1, 0.22, 1);
      a.rotation.z = 0.18 + i * 0.07; a.rotation.x = -0.1;
    }
  }
  return { rig, J };
}

// ---------- animation ----------
const KEYS = ['sp', 'crouch', 'kneel', 'lean', 'hunch', 'stride', 'armSw', 'armL', 'armR', 'elbL', 'elbR', 'hy', 'hp', 'hr', 'twist', 'sway', 'draw', 'atk', 'jaw', 'shuf', 'dd'];
const RATE = { sp: 6, hy: 9, hp: 9, hr: 6, atk: 24, draw: 9, crouch: 8, kneel: 4, dd: 8, jaw: 10 };
// [time, arm raise, lean, elbow, lunge z, head pitch]: windup, slam, recover
const ATK = [[0, 1.4, 0.3, 0.3, 0, 0], [0.2, 2.7, -0.05, 0.9, -0.05, -0.3], [0.36, 0.3, 0.8, 0.15, 0.2, 0.5], [0.6, 1.3, 0.4, 0.3, 0.05, 0]];
const _A = { arm: 0, lean: 0, elb: 0, z: 0, hp: 0 };
function atkAt(u) {
  let i = 0;
  while (i < ATK.length - 2 && u > ATK[i + 1][0]) i++;
  const a = ATK[i], b = ATK[i + 1], s = sstep(u, a[0], b[0]);
  _A.arm = mix(a[1], b[1], s); _A.lean = mix(a[2], b[2], s); _A.elb = mix(a[3], b[3], s); _A.z = mix(a[4], b[4], s); _A.hp = mix(a[5], b[5], s);
  return _A;
}
export const DRAW = { tw: 1.0, f: 1.3, y: 0.194, z: -1.225, e: 2.357 }; // right (string) arm pose when the bow is drawn (shoulder fwd, yaw, abduction, elbow)
export const DRAWL = { f: 1.724, y: 0.705, e: 0.05 };      // left (bow) arm

const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0);
const seg = (m, a, b) => {
  m.position.addVectors(a, b).multiplyScalar(0.5);
  _d.subVectors(b, a);
  const len = _d.length();
  m.scale.set(1, Math.max(len, 1e-4), 1);
  m.quaternion.setFromUnitVectors(_Y, _d.divideScalar(len || 1));
};

function playerTarget(f, p, T) {
  const t = f.time, sp = f.S.sp;
  const run = sstep(sp, 2.9, 4.0), walk = sstep(sp, 0.3, 2.0);
  const d = p.drawing ? 1 : 0, c = p.crouch ? 1 : 0;
  T.crouch = c; T.draw = d; T.stride = c ? 0.7 : 1;
  T.lean = 0.03 + 0.07 * walk + 0.25 * run + 0.6 * c * (1 - 0.4 * d);
  T.hunch = 0.02; T.armSw = 0.6 + 0.3 * run;
  T.armL = 0.12; T.armR = 0.06; T.elbL = 0.5 + 0.5 * run; T.elbR = 0.18 + 1.0 * run;
  T.twist = DRAW.tw * d;
  T.hy = d * DRAW.tw + Math.sin(t * 0.35 + f.seed * 9) * 0.12 * (1 - d);
  T.hyRate = 9;
}

function zombieTarget(f, p, T, st) {
  const t = f.time, sd = f.seed, sp = f.S.sp, kind = f.kind;
  const m = sstep(sp, 0.4, 2.4);
  T.crouch = p.crouch ? 1 : 0;
  // baseline: stiff shamble, arms hanging forward, head lolling
  T.lean = 0.1; T.hunch = 0.3; T.stride = 0.8; T.armSw = 0.14; T.shuf = 1;
  T.armL = 0.5; T.armR = 0.75; T.elbL = 0.4; T.elbR = 0.6;
  T.hy = Math.sin(t * 0.5 + sd * 40) * 0.3 + Math.sin(t * 1.3 + sd * 13) * 0.15;
  T.hp = 0.12 + Math.sin(t * 0.7 + sd * 17) * 0.08;
  T.hr = Math.sin(t * 0.4 + sd * 29) * 0.28;
  T.twist = 0; T.sway = Math.sin(t * 0.6 + sd * 7) * 0.05;
  T.jaw = 0.18 + Math.sin(t * 0.9 + sd * 5) * 0.05; T.hyRate = 7;
  if (kind === 'scout') { T.lean = 0.04; T.hunch = 0.12; T.stride = 1; T.armL = T.armR = 0.3; T.elbL = T.elbR = 0.35; T.hr *= 0.3; T.hp = 0.02; T.shuf = 0.4; T.jaw = 0.1; }
  else if (kind === 'sleeper') { T.lean = 0.2; T.hunch = 0.4; T.hp = 0.3; T.stride = 0.7; T.armSw = 0.1; }
  else if (kind === 'screamer') { T.hunch = 0.25; T.armL = 0.95; T.armR = 1.0; T.elbL = 1.5; T.elbR = 1.4; T.jaw = 0.6 + Math.sin(t * 1.1 + sd) * 0.08; T.hp = -0.12; T.shuf = 0.6; }

  if (st === 'dormant') {
    T.kneel = 1; T.lean = 0.55; T.hunch = 0.5; T.hp = 0.35; T.hr = 0.35; T.stride = 0; T.armL = 0.3; T.armR = 0.25; T.elbL = 0.7; T.elbR = 0.8;
    T.hy = Math.sin(t * 0.3 + sd * 9) * 0.15; T.sway = 0; T.jaw = 0.25;
  } else if (st === 'suspicious') {
    const seg_ = Math.floor(t / 0.6 + sd * 9), tg = rnd(seg_, sd) > 0.78 ? 0 : (rnd(seg_, sd + 3) - 0.5) * 2;
    T.lean *= 0.6; T.hunch *= 0.5; T.armL = T.armR = 0.3; T.elbL = T.elbR = 0.9;
    T.hy = tg; T.twist = tg * 0.35; T.hp = -0.1; T.hyRate = 20; T.hr *= 0.3; T.sway = Math.sin(t * 17) * 0.015;
  } else if (st === 'alert') {
    T.lean = 0.26 + 0.22 * m; T.hunch = 0.1; T.stride = 1; T.armSw = 0.15; T.shuf = 0;
    T.armL = 1.45 + Math.sin(t * 9 + sd * 5) * 0.12; T.armR = 1.4 + Math.sin(t * 9 + 1.7 + sd * 5) * 0.12; T.elbL = T.elbR = 0.2;
    T.hy = p.sees ? 0 : Math.sin(t * 2.2 + sd * 9) * 0.5; T.hp = -0.3; T.hr = 0; T.twist = Math.sin(t * 6 + sd) * 0.08 * m;
    T.jaw = kind === 'screamer' ? 1 : 0.55; T.sway = 0;
  } else if (st === 'search' || st === 'caution') {
    const k = st === 'search' ? 1 : 0.7;
    T.lean = 0.1 * k; T.hunch = 0.2; T.armL = 0.4; T.armR = 0.5; T.elbL = T.elbR = 0.4; T.stride = 0.9;
    T.twist = Math.sin(t * 0.8 + sd * 5) * 0.5 * k; T.hy = Math.sin(t * 1.15 + sd * 3) * 0.85 * k; T.hp = 0.05 + Math.sin(t * 0.9) * 0.08;
    T.sway = Math.sin(t * 0.9 + sd * 5) * 0.08 * k;
  } else if (st === 'dead') {
    T.crouch = 0; T.lean = 0; T.hunch = 0; T.stride = 0; T.armL = T.armR = 0; T.elbL = 0.3; T.elbR = 0.45; T.hy = 0.3; T.hp = -0.3; T.hr = 0.4; T.jaw = 0.4; T.sway = 0;
  }
}

class Figure {
  constructor(rig, J, o) {
    this.root = new THREE.Group();
    this.root.add(rig);
    this.rig = rig; this.J = J; this.head = J.head;
    this.kind = o.kind; this.zombie = !!o.zombie; this.seed = o.seed; this.bow = o.bow || null;
    this.S = {}; this.T = { hyRate: 9 };
    for (const k of KEYS) this.S[k] = this.T[k] = 0;
    this.chestZ = J.chestMesh.scale.z;
    this.ph = o.seed * TAU; this.time = o.seed * 100;
    this.dead = 0; this.first = true; this.atkT = 0; this.wasAtk = false;
    this.roll = (o.seed < 0.5 ? -1 : 1) * (0.1 + 0.25 * Math.abs(o.seed - 0.5) * 2); // slight roll onto one side when lying
    this.root.userData.figure = this;
  }

  // Where an arrow that hit body part `part` (head, chest or hips, from sim.PARTS) sticks: that joint, so it follows the pose and the fall.
  anchor(part) { return { head: this.J.head, chest: this.J.chest, hips: this.J.pelvis }[part] || this.root; }

  update(dt, p) {
    p = p || {};
    const dtS = clamp(num(dt), 0, 5), dtP = Math.min(dtS, 0.1);
    const S = this.S, T = this.T, state = p.state || 'idle';
    this.time += dtP;
    // targets for this frame
    T.sp = clamp(num(p.speed), 0, 12);
    T.kneel = 0; T.draw = 0; T.dd = state === 'dead' ? 1 : 0; T.sway = 0; T.shuf = 0; T.jaw = 0; T.hp = 0; T.hr = 0; T.twist = 0; T.hyRate = 9;
    T.atk = p.attacking && !this.player ? 1 : 0;
    if (this.zombie) zombieTarget(this, p, T, state); else playerTarget(this, p, T);
    // attack timer (rising edge restarts the swing)
    if (p.attacking) { if (!this.wasAtk) this.atkT = 0; this.atkT = Math.min(this.atkT + dtP, 0.6); }
    this.wasAtk = !!p.attacking;
    // exponential smoothing so poses blend, never snap (first call snaps to the target)
    for (const k of KEYS) {
      const rate = k === 'hy' ? T.hyRate : RATE[k] || 7;
      S[k] += (T[k] - S[k]) * (this.first ? 1 : 1 - Math.exp(-dtS * rate));
    }
    this.dead = this.first ? T.dd : clamp(this.dead + (T.dd ? dtS : -dtS) / 0.5, 0, 1);
    this.first = false;
    // gait phase from smoothed speed
    this.ph = (this.ph + TAU * (S.sp / ((this.zombie ? 1.15 : 1.4) + 0.4 * S.sp)) * dtP) % TAU;
    this.apply();
  }

  apply() {
    const { S, J, rig, ph, time: t } = this;
    const sp = S.sp, m = sstep(sp, 0.12, 0.6);
    const amp = (0.18 + 0.1 * sp) * m * S.stride, lift0 = (0.3 + 0.18 * sp) * m;
    const atk = S.atk, A = atkAt(this.atkT);
    const lean = mix(S.lean, A.lean, atk);
    // legs: hip flexion a, knee flexion k; the pelvis rides on the leg that reaches the ground
    let vmax = 0;
    for (let i = 0; i < 2; i++) {
      const side = 1 - 2 * i, q = ph + i * Math.PI, c = Math.cos(q - 0.6), sn = Math.sin(q);
      const asym = i ? 1 - 0.35 * S.shuf : 1;
      const a = amp * sn * asym + 1.1 * S.crouch + 0.2 * S.kneel + S.dd * (i ? 0.7 : 0);
      const k = 0.06 + lift0 * Math.max(0, c) * (i ? 1 - 0.6 * S.shuf : 1) + 2.2 * S.crouch + 1.65 * S.kneel + S.dd * (i ? 1 : 0);
      vmax = Math.max(vmax, D.thigh * Math.cos(a) + D.shin * Math.cos(k - a));
      const L = J.legs[i];
      L.hip.rotation.set(-a, 0, side * (0.04 + 0.12 * S.draw + 0.08 * S.crouch + 0.2 * S.dd + 0.04 * S.kneel));
      L.kn.rotation.x = k;
      L.an.rotation.x = (a - k) * 0.9 + 1.1 * S.kneel + 0.35 * Math.max(0, -sn) * m;
    }
    J.pelvis.position.set(Math.sin(ph) * 0.015 * m, D.ankle - D.hipY + vmax, -0.06 * S.crouch - 0.04 * S.kneel);
    J.pelvis.rotation.set(0, Math.sin(ph) * 0.12 * m - 0.2 * S.twist, Math.sin(ph) * 0.03 * m + S.sway * 0.5);
    // torso, head
    const br = Math.sin(t * 1.7 + this.seed * 6) * (1 + 0.8 * S.kneel) * (1 - S.dd), bob = Math.sin(2 * ph) * m;
    J.spine.rotation.set(0.55 * lean, -0.3 * S.twist - Math.sin(ph) * 0.14 * m, S.sway * 0.5);
    J.chest.rotation.set(0.45 * lean + S.hunch + 0.012 * br + 0.02 * bob, -0.5 * S.twist, S.sway * 0.5);
    J.chestMesh.scale.z = this.chestZ * (1 + 0.035 * br);
    J.neck.rotation.set(S.hp + mix(0, A.hp, atk) - 0.75 * (lean + S.hunch) - 0.02 * bob, S.hy, S.hr);
    if (J.jaw) J.jaw.rotation.x = S.jaw;
    // arms
    const asw = S.armSw * m * clamp(0.3 + 0.1 * sp, 0.3, 0.8), d = S.draw;
    for (let i = 0; i < 2; i++) {
      const side = 1 - 2 * i, R = J.arms[i];
      const sw = asw * (i === 0 && this.bow ? 0.45 : 1) * Math.sin(ph + (1 - i) * Math.PI) * (1 - d);
      let fwd = (i ? S.armR : S.armL) + sw - 0.15 * S.dd;
      let elb = (i ? S.elbR : S.elbL) + 0.5 * Math.max(0, sw);
      let yaw = side * (0.06 + 0.1 * atk), abd = side * (0.07 + S.dd * (side * this.roll > 0 ? 0.45 : 0.9)); // the arm on the low side stays closer to the body
      fwd = mix(fwd, A.arm, atk); elb = mix(elb, A.elb, atk);
      if (d > 0.001) {
        if (i === 0) { fwd = mix(fwd, DRAWL.f, d); elb = mix(elb, DRAWL.e, d); yaw = mix(yaw, DRAWL.y, d); abd = mix(abd, 0, d); }
        else { fwd = mix(fwd, DRAW.f, d); elb = mix(elb, DRAW.e, d); yaw = mix(yaw, DRAW.y, d); abd = mix(abd, DRAW.z, d); }
      }
      R.sh.rotation.set(-fwd, yaw, abd);
      R.el.rotation.x = -elb;
    }
    // whole-body fall (pivot at the feet): pitch onto the back, rolled a little onto one side
    const e = sstep(this.dead, 0, 1);
    rig.rotation.set(-Math.PI / 2 * e, this.roll * e, 0);
    rig.position.set(0, (0.14 + 0.12 * Math.abs(Math.sin(this.roll))) * e, mix(0, A.z, atk) + 0.6 * e); // fallen body ends up centred near the sim position
    if (this.bow) this.updateBow(d);
  }

  updateBow(d) {
    const { rig, J, bow } = this;
    rig.updateMatrixWorld(true);
    const hand = (wr, out) => rig.worldToLocal(wr.localToWorld(out.set(0, -0.045, 0)));
    hand(J.arms[0].wr, _a); hand(J.arms[1].wr, _b);
    const nock = _v.set(_a.x, _a.y, _a.z - 0.235).lerp(_b, d);
    const yaw = d * Math.atan2(_a.x - nock.x, _a.z - nock.z), sy = Math.sin(yaw) * 0.235, cy = Math.cos(yaw) * 0.235;
    bow.limb.position.copy(_a); bow.limb.rotation.y = yaw;
    seg(bow.strT, _d.set(_a.x - sy, _a.y + 0.644, _a.z - cy), nock);
    seg(bow.strB, _d.set(_a.x - sy, _a.y - 0.644, _a.z - cy), nock);
    bow.arrow.visible = d > 0.25;
    _d.subVectors(_a, nock);
    const len = _d.length();
    seg(bow.arrow, nock, _d.multiplyScalar(len > 1e-3 ? 0.85 / len : 0).add(nock));
  }

  dispose() { this.root.removeFromParent(); }
}

// ---------- factories ----------
export function createPlayerFigure() {
  const jacket = mat(0x437a50), pants = mat(0x375f43), leather = mat(0x6a4a2e);
  const { rig, J } = buildRig({
    H: 1.8, w: 1.02, skin: mat(0xd4ad8c), chest: jacket, abd: jacket, sleeve: jacket, fore: jacket, hand: leather,
    thigh: pants, shinL: pants, shinR: pants, shoe: mat(0x5b4632),
    hem: { rt: 0.17, rb: 0.185, h: 0.15, y: -0.04, mat: jacket }, hood: mat(0x3b6e47, true), player: true,
  });
  const limb = part(rig, bowG(), mat(0x7a5530)); limb.scale.setScalar(1);
  const strMat = mat(0xeeeeee);
  const strT = part(rig, rodG(0.004), strMat), strB = part(rig, rodG(0.004), strMat);
  const arrow = part(rig, rodG(0.009), mat(0xe6d9b0)); arrow.visible = false;
  const f = new Figure(rig, J, { kind: 'player', seed: 0.37, bow: { limb, strT, strB, arrow } });
  f.player = true;
  f.updateBow(0);
  return f;
}

const KINDS = ['hunter', 'scout', 'sleeper', 'screamer'];
const SKIN = [0x8a9868, 0x95a072, 0x819264, 0x98a47c], PALE = [0xc3cbbd, 0xcfd2c4, 0xb9c4bb, 0xc9c3b5];
const SHIRT = [0x5f7388, 0x94615a, 0x72845f, 0x80789a], PANTS = [0x6b5d48, 0x435672, 0x5a5a52, 0x4f4a5c];
const ARMY = [0x5d6b45, 0x66704b, 0x56644a, 0x6a6a4e], TROUSER = [0x4a5640, 0x535a42, 0x484f3a, 0x555640];
const HOODIE = [0x6b6f86, 0x7a6a62, 0x5f7a78, 0x77727f], TRACK = [0x55586a, 0x4f5a66, 0x5c5560, 0x4d5560];
const HAIR = [0x3a2f28, 0x6a5a45, 0x2d2a2a, 0x7a7466];

export function createZombieFigure(z) {
  const id = z && Number.isFinite(z.id) ? Math.trunc(z.id) : 0;
  const kind = z && KINDS.includes(z.kind) ? z.kind : 'hunter';
  const v = ((id % 4) + 4) % 4, v2 = ((((id >> 2) % 4) + 4) % 4);
  const o = { zombie: true, kind, H: kind === 'scout' ? 1.8 + rnd(id, 1) * 0.1 : 1.65 + rnd(id, 1) * 0.25, w: 1, hw: 1, shoe: mat(0x45423e) };
  const hairC = { mat: mat(HAIR[(v + v2) % 4]), theta: 1.25, y: 0.012, sx: 0.1, sy: 0.12, sz: 0.112, tilt: -0.15 };
  if (kind === 'hunter') {
    const skin = mat(SKIN[v]), shirt = mat(SHIRT[v]), shirt2 = mat(SHIRT[(v + 1) % 4]), pants = mat(PANTS[v2]);
    Object.assign(o, { skin, chest: shirt, abd: skin, sleeve: shirt, fore: skin, hand: skin, thigh: pants, shinL: pants, shinR: skin, // torn: bare belly, short sleeves, one bare shin
      hem: { rt: 0.165, rb: 0.18, h: 0.12, y: -0.03, mat: shirt2 }, cap: hairC });
  } else if (kind === 'scout') {
    const skin = mat(SKIN[v]), jacket = mat(ARMY[v]), tr = mat(TROUSER[v2]);
    Object.assign(o, { w: 1.12, skin, chest: jacket, abd: jacket, sleeve: jacket, fore: jacket, hand: skin, thigh: tr, shinL: tr, shinR: tr, shoe: mat(0x4a463e),
      hem: { rt: 0.18, rb: 0.2, h: 0.17, y: -0.05, mat: mat(ARMY[(v + 2) % 4]) },
      cap: { mat: mat(0x5d6650, true), theta: 1.6, y: 0.025, sx: 0.12, sy: 0.12, sz: 0.128, tilt: -0.3 } });
  } else if (kind === 'sleeper') {
    const skin = mat(SKIN[v]), hood = mat(HOODIE[v]), tr = mat(TRACK[v2]);
    Object.assign(o, { w: 1.05, skin, chest: hood, abd: hood, sleeve: hood, fore: hood, hand: skin, thigh: tr, shinL: tr, shinR: tr, shoe: mat(0xb0b0a8),
      hem: { rt: 0.165, rb: 0.18, h: 0.08, y: -0.02, mat: mat(HOODIE[(v + 1) % 4]) }, hood: mat(HOODIE[v], true) });
  } else {
    const skin = mat(PALE[v]), gown = mat(0x9fa3a0);
    Object.assign(o, { w: 0.86, hw: 1.25, bigMouth: true, eyeS: 1.4, skin, chest: gown, abd: gown, sleeve: skin, fore: skin, hand: skin, thigh: skin, shinL: skin, shinR: skin, shoe: skin,
      hem: { rt: 0.15, rb: 0.26, h: 0.42, y: -0.21, mat: mat(0x8f9490) }, cap: hairC });
  }
  const { rig, J } = buildRig(o);
  return new Figure(rig, J, { kind, zombie: true, seed: rnd(id, 7) });
}
