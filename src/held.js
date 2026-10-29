// held.js: what the survivor carries, attached to the bones of the rig made by survivor.js (third person).
//   attachHeld(fig, { bow, knife }) -> { swing(on) }
//     fig:   the survivor figure (needs fig.attach(boneName, obj) from createSurvivorFigure)
//     bow:   Group from bow.js createHeldBow (metres, grip at the origin, limbs along +y, target toward -z)      -> the left hand, always
//     knife: Group from models.js cloneProp(props.knife) (metres, 0.5 m, the handle end at the origin, blade along +z) -> sheathed on the right hip, and in the
//            right hand while swing(true)
//   Either may be missing. The numbers are in HELD so a dev page can tune them; positions are metres in the BONE's axes (the mesh's at rest: +x the
//   character's left, +y up, +z forward), the hand bones start at the wrist.
import * as THREE from 'three';
import { ARMS } from './survivor.js';

export const HELD = {
  palm: [0.024, -0.085, 0.048],            // the centre of the left palm from the wrist joint (the right one mirrors x)
  grip: 0.45,                              // how far along the glove, from the wrist to the middle of the palm, the machete's handle sits in the right hand (1 = the palm centre)
  bowTilt: 0.45,                           // rad the bow is pitched in the hand frame so it hangs about upright (the more the forearm is raised, the more it needs)
  bowCant: 0.35,                           // rad its top limb leans forward from upright
  sheath: [-0.21, -0.02, 0.03], sheathPitch: 1.67, // the machete on the right hip: handle at the belt, blade down
  knifeAlong: [0.41, -0.73, 0.59],         // the blade's direction in the hand frame: along the forearm, so it continues the arm (the right one mirrors x)
};

export function attachHeld(fig, { bow = null, knife = null } = {}) {
  if (bow) {
    const g = new THREE.Group(); g.rotation.order = 'ZXY'; // Rz * Rx * Ry: first turn the target to the front, then pitch, then undo the arm's inward turn
    bow.rotation.set(0, Math.PI, 0); g.add(bow);
    g.rotation.set(HELD.bowTilt - HELD.bowCant, 0, ARMS.down); g.position.set(...HELD.palm);
    fig.attach('handL', g);
  }
  let sheathed = null, drawn = null;
  if (knife) {
    sheathed = new THREE.Group(); sheathed.add(knife.clone(true)); sheathed.rotation.x = HELD.sheathPitch; sheathed.position.set(...HELD.sheath);
    fig.attach('hips', sheathed);
    drawn = new THREE.Group(); drawn.add(knife.clone(true)); drawn.position.set(-HELD.palm[0] * HELD.grip, HELD.palm[1] * HELD.grip, HELD.palm[2] * HELD.grip); drawn.visible = false; // the handle in the palm, not past the fingertips
    drawn.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(-HELD.knifeAlong[0], HELD.knifeAlong[1], HELD.knifeAlong[2]).normalize());
    fig.attach('handR', drawn);
  }
  return { swing(on) { if (knife) { sheathed.visible = !on; drawn.visible = !!on; } } };
}
