// ik.js: pure two-bone inverse kinematics (no THREE, no DOM). Vectors are [x, y, z] arrays in any one consistent unit.
//   twoBone(shoulder, target, pole, l1, l2) -> { elbow, wrist, reached }
//     The wrist goes to `target`, or as near as the arm can reach in a straight line toward it (reached = false). The elbow bends toward
//     `pole`, a DIRECTION (not a position). Bone lengths are exactly l1 (shoulder-elbow) and l2 (elbow-wrist), whatever the input.
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], len = (a) => Math.hypot(a[0], a[1], a[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function twoBone(shoulder, target, pole, l1, l2) {
  const d = sub(target, shoulder), reach = len(d), dir = reach > 1e-9 ? mul(d, 1 / reach) : [0, 0, 1]; // a target on the shoulder: any direction will do
  const lo = Math.abs(l1 - l2) + 1e-6, hi = l1 + l2 - 1e-6, dist = Math.min(hi, Math.max(lo, reach)), reached = reach >= lo && reach <= hi;
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(0, l1 * l1 - a * a)); // the elbow stands h off the shoulder-wrist line, a along it
  let bend = sub(pole, mul(dir, dot(pole, dir))), bl = len(bend); // the pole's part perpendicular to the line
  if (!(bl > 1e-6)) { bend = cross(dir, Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]); bl = len(bend); } // pole along the line (or zero): any perpendicular
  return { elbow: add(shoulder, add(mul(dir, a), mul(bend, h / bl))), wrist: add(shoulder, mul(dir, dist)), reached };
}
