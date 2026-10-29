// motion.js: pure motion helpers (no THREE, no DOM, so Node tests reach them) shared by the figure code and main.js.
//   wrapPi(a)                      the angle a wrapped to [-pi, pi]
//   turnToward(cur, target, rate, dt)   turns cur toward target along the SHORTEST arc at up to rate rad/s; returns the new angle (any range in, any range out)
//   gaitRate(speed, cycle, opts)   how to play a walk clip so the feet keep up with the body: { rate, gain } (see below)
//   spring(s, target, k, c, dt)    damped spring s = { x, v }: x'' = k (target - x) - c x'. Returns s.x. Substepped (<= 1/120 s each), so it stays stable
//                                  for a stiff spring even when a slow frame hands in dt = 0.1. Critical damping is c = 2 sqrt(k); less rings, more is sluggish.
const TAU = Math.PI * 2;

export const wrapPi = (a) => a - TAU * Math.round(a / TAU);

export function turnToward(cur, target, rate, dt) {
  const d = wrapPi(target - cur), most = Math.max(0, rate * dt);
  return cur + (Math.abs(d) <= most ? d : Math.sign(d) * most);
}

export function spring(s, target, k, c, dt) {
  if (!(dt > 0) || !Number.isFinite(target)) return s.x;
  const n = Math.ceil(dt * 120), h = dt / n;
  for (let i = 0; i < n; i++) { s.v += (k * (target - s.x) - c * s.v) * h; s.x += s.v * h; }
  return s.x;
}

// A shuffling clip covers little ground: `cycle` is the ground it covers per second at normal playback (m/s, measured from its planted foot).
// Playing it at rate = speed / cycle would need absurd cadences at a run, so the legs also swing wider as speed rises: gain is 1 (as authored) up to
// `walk` m/s and 1 + `stride` at `run` m/s. rate x gain x cycle = speed, until the rate hits [min, max].
export function gaitRate(speed, cycle, { walk = 1.1, run = 3.4, stride = 0.7, min = 0.4, max = 6 } = {}) {
  const t = Math.min(1, Math.max(0, (speed - walk) / (run - walk))), gain = 1 + stride * t * t * (3 - 2 * t);
  return { rate: Math.min(max, Math.max(min, speed / (cycle * gain))), gain };
}
