// Contract test for src/bow.js: at full raise with no sway, pin i's tip is at (0, -tan(angle) * D, -D) in camera space (D = vm.sightDist: the model
// path puts the Avalon's pin housing at its own distance), on the procedural bow and on the model bow. The model path gets synthetic assets (boxes with the real mesh names and
// bounding boxes, in the frame the FBX loader gives), so no browser or file is needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createBowViewmodel } from '../src/bow.js';
import { pinAngles } from '../src/sim.js';

const D = 0.62;
const pins = pinAngles().map((angle, i) => ({ angle, color: 0x3cff7a + i })); // five pins: the procedural sight still supports several
const one = [{ angle: pinAngles()[2], color: 0xff3b2f }]; // the game's slider sight has one pin, set to a range with setPin

const part = (name, [x0, x1, y0, y1, z0, z1]) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  m.name = name; m.scale.set(x1 - x0, y1 - y0, z1 - z0); m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return m;
};
const fakeAssets = () => ({
  bow: new THREE.Group().add(
    part('Body_Low', [-3.8, 2.4, -15.4, 32.9, -15.4, 33]), part('Grip_Low', [-1.6, 3.5, -8.7, 8.7, 5.4, 20.3]),
    part('UpperWheel_Low', [-2, -1, 33.7, 44.5, -64.3, -53.6]), part('LowerWheel_Low', [-1.7, -1.4, -62.7, -46.7, 28.4, 46.6]),
    part('String_Low', [-2, -1.3, -59.5, 44.6, -64.4, 33.3]), part('StringHold_Low', [-3.6, -1.3, -25.4, -21.5, 0.7, 4.6]),
    part('Tension_Low', [-3.8, 0.6, -58.9, 40.3, -60.2, 38.9]),
  ),
  sight: new THREE.Group().add(part('pokretlo_szyna_pinowa_ze_sruba', [-4.3, 5.4, -7, 7.5, -4.5, 20.1])),
});

const tips = (vm) => {
  const cam = new THREE.PerspectiveCamera(); // at the origin looking down -Z
  cam.add(vm.group);
  vm.setRaise(1); vm.setDraw(0); vm.update(0, { sway: [0, 0], moving: false });
  cam.updateMatrixWorld(true);
  return vm.pinTips.map((t) => t.getWorldPosition(new THREE.Vector3()));
};

for (const [label, assets] of [['procedural', null], ['model', fakeAssets()]]) {
  test(`${label} bow: every pin tip is on its ballistic ray (0.5 mm)`, () => {
    const vm = createBowViewmodel({ pins, sightDist: D, assets });
    const p = tips(vm);
    assert.equal(p.length, pins.length);
    pins.forEach((pin, i) => {
      const want = new THREE.Vector3(0, -Math.tan(pin.angle) * vm.sightDist, -vm.sightDist);
      assert.ok(p[i].distanceTo(want) < 0.0005, `pin ${i}: ${p[i].toArray()} vs ${want.toArray()}`);
    });
    vm.setDraw(1); vm.setKind('lure'); vm.setNocked(false); vm.dispose(); // the sight does not move with the draw, and disposing is safe
  });
}

test('assets that are not the bow model fall back to the procedural bow (the contract still holds)', () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const vm = createBowViewmodel({ pins, sightDist: D, assets: { bow: new THREE.Group(), sight: new THREE.Group() } });
    assert.ok(tips(vm)[0].distanceTo(new THREE.Vector3(0, -Math.tan(pins[0].angle) * vm.sightDist, -vm.sightDist)) < 0.0005);
    assert.ok(vm.group.getObjectByName('shaft'));
  } finally { console.warn = warn; }
});

test('model bow: the hidden string meshes stay out, the nock is left of and below the pin column, 0.395 m ahead', () => {
  const vm = createBowViewmodel({ pins, sightDist: D, assets: fakeAssets() });
  const hidden = [];
  vm.group.traverse((o) => { if (o.isMesh && o.name && !o.visible) hidden.push(o.name); });
  assert.deepEqual(hidden.sort(), ['StringHold_Low', 'String_Low', 'Tension_Low']);
  const cam = new THREE.PerspectiveCamera(); cam.add(vm.group);
  vm.setRaise(1); vm.setDraw(0); cam.updateMatrixWorld(true);
  const nock = new THREE.Vector3(); vm.group.getObjectByName('shaft').parent.getWorldPosition(nock);
  assert.ok(Math.abs(nock.z - -0.395) < 1e-6 && nock.y < 0 && nock.x < 0, `nock at ${nock.toArray()}`);
});

for (const [label, assets] of [['procedural', null], ['model', fakeAssets()]]) {
  test(`${label} bow, slider sight: one pin, and setPin puts it on the ray of another range (0.5 mm) while the sight follows it`, () => {
    const vm = createBowViewmodel({ pins: one, sightDist: D, assets });
    assert.equal(tips(vm).length, 1, 'a single pin');
    const sightY = () => { const m = vm.sight.children.find((c) => !c.isMesh); return m ? m.position.y : null; }; // the model's housing slides with the pin
    const before = sightY();
    for (const angle of [pinAngles()[0], pinAngles()[4]]) {
      vm.setPin(0, angle);
      const p = tips(vm)[0], want = new THREE.Vector3(0, -Math.tan(angle) * vm.sightDist, -vm.sightDist);
      assert.ok(p.distanceTo(want) < 0.0005, `pin at ${p.toArray()} vs ${want.toArray()}`);
    }
    if (assets) assert.ok(Math.abs(sightY() - before - (-Math.tan(pinAngles()[4]) * vm.sightDist - -Math.tan(pinAngles()[2]) * vm.sightDist)) < 1e-9, 'the sight model moved by exactly the pin\'s travel');
  });
}

test('the supplied arrow model is the nocked plain arrow (tip 0.7 m ahead of the nock); the whistling arrow stays procedural', () => {
  const vm = createBowViewmodel({ pins: one, sightDist: D, assets: fakeAssets() });
  const model = new THREE.Group(); model.add(part('arrowMesh', [-0.01, 0.01, -0.01, 0.01, -0.8, 0])); // the prop: tip at its origin, 0.8 m along -z
  vm.setArrowModel(model);
  const cam = new THREE.PerspectiveCamera(); cam.add(vm.group); vm.setRaise(1); vm.setDraw(0); cam.updateMatrixWorld(true);
  const shaft = vm.group.getObjectByName('shaft'), mesh = vm.group.getObjectByName('arrowMesh'), box = () => new THREE.Box3().setFromObject(mesh);
  assert.ok(!shaft.visible && mesh.parent.parent.visible, 'plain arrow: the model is shown, the procedural shaft is hidden');
  const nockZ = shaft.parent.getWorldPosition(new THREE.Vector3()).z;
  assert.ok(Math.abs(box().min.z - (nockZ - 0.7)) < 1e-3 && Math.abs(box().max.z - nockZ) < 1e-3, `the arrow runs from the nock (${nockZ}) to 0.7 m ahead: ${box().min.z}..${box().max.z}`);
  vm.setKind('lure'); assert.ok(shaft.visible && !mesh.parent.parent.visible, 'whistling arrow: the procedural one');
  vm.setKind('basic'); assert.ok(!shaft.visible && mesh.parent.parent.visible);
});
