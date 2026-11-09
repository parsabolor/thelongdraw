// The scenarios that tools/trace.mjs records: scripted players (some look at the state to aim or to walk toward something, which is fine: the trace stores what they did)
// that between them make the simulation do everything the Rust port has to match: patrols and the random draws behind them, sight and hearing, every zombie state, scout calls,
// arrows with drop and wind, a lure, retrieving, the knife, tagging, a fall. Most run on the outpost; the small ones run on levels defined inline (the trace carries the
// definition), which is how the scenario tests in test/sim.test.mjs build theirs.
//   drive(S, tick) -> { inp, acts }   (see tools/trace.mjs for the format)
import { dropAngle, hasLOS, playerEye } from '../src/sim.js';

const toward = (S, x, z) => {
  const P = S.player, dx = x - P.x, dz = z - P.z, d = Math.hypot(dx, dz) || 1;
  return { mx: dx / d, mz: dz / d };
};
// A unit aim vector from the launch point (just below the eye) to a point, raised by the drop an arrow at full draw falls over that distance.
const aimAt = (S, x, y, z) => {
  const P = S.player, o = [P.x, playerEye(P) - 0.2, P.z], dx = x - o[0], dz = z - o[2], hd = Math.hypot(dx, dz) || 1;
  const el = Math.atan2(y - o[1], hd) + dropAngle(hd), yaw = Math.atan2(dx, dz);
  return [Math.cos(el) * Math.sin(yaw), Math.sin(el), Math.cos(el) * Math.cos(yaw)];
};
const alive = (S) => S.zombies.filter((z) => z.state !== 'dead');
const nearestInSight = (S) => {
  const P = S.player, eye = playerEye(P);
  let best = null, bd = 60;
  for (const z of alive(S)) {
    const d = Math.hypot(z.x - P.x, z.z - P.z);
    if (d < bd && hasLOS(S.level, P.x, eye, P.z, z.x, z.y + 1.2, z.z)) { best = z; bd = d; }
  }
  return best;
};
// Draws for `draw` ticks, lets go, waits for the rest of `period`, again and again, aiming at whatever `pick` gives.
const archer = ({ first = 30, period = 240, draw = 80, pick = nearestInSight, acts = {} }) => (S, tick) => {
  const z = pick(S), phase = (tick - first) % period;
  const out = { inp: {}, acts: acts[tick] || [] };
  if (!z) return out;
  out.inp.aim = aimAt(S, z.x, z.y + 1.2, z.z);
  out.inp.draw = tick >= first && phase < draw;
  return out;
};

const open = (spawns, boxes = [], extra = {}) => ({
  bounds: { x0: -40, z0: -40, w: 80, d: 80 }, boxes, start: { x: 0, z: 30, yaw: 0 }, bike: { x: 0, z: 30 },
  bell: { x: 0, y: 3, z: 0 }, patrol: [[5, 5], [-5, 5], [5, -5]], spawns, terrain: null, ...extra,
});
const hunter = (x, z, yaw = 0, patrol = []) => ({ role: 'hunter', x, z, yaw, patrol });
const guard = { role: 'sleeper', x: 6, z: -6, yaw: 0 }; // keeps a level without other zombies from counting as cleared

export const SCENARIOS = [
  // the world alone: patrols, the random draws behind them, the wind, the bell, a binocular tag
  { name: 'idle-patrol', seed: 1, ticks: 3600, drive: (S, t) => ({ inp: {}, acts: t === 300 ? [{ do: 'tag', id: 4 }] : [] }) },
  // creep toward the valley hunter, then run: noticed, alerted, the pack, the scouts' calls, searching
  { name: 'creep-then-run', seed: 2, ticks: 3600, drive: (S, t) => ({ inp: { ...toward(S, -25, 16), crouch: t < 1200, run: t >= 1200 } }) },
  // run straight at the fort: hunted, attacks, the player is shoved and stunned
  { name: 'run-at-the-fort', seed: 3, ticks: 3600, drive: (S) => ({ inp: { ...toward(S, 0, 10), run: true } }) },
  // shoot whatever is in sight from the start, plain arrows and then whistling ones: drop, wind, hits, wounds, kills, noise, wakings
  { name: 'snipe-from-the-valley', seed: 4, ticks: 5400, drive: archer({ first: 60, period: 240, acts: { 1: [{ do: 'kind', v: 'basic' }], 1500: [{ do: 'kind', v: 'lure' }], 2100: [{ do: 'kind', v: 'basic' }] } }) },
  // one whistling arrow into the valley, then keep still and watch the hunters come to look
  { name: 'lure-and-wait', seed: 5, ticks: 3000, drive: (S, t) => ({ inp: { aim: aimAt(S, -18, 0.3, 14), draw: t >= 30 && t < 110 }, acts: t === 1 ? [{ do: 'kind', v: 'lure' }] : [] }) },
  // a hunter facing away: creep up behind it and knife it (a silent kill), the sleeper is left
  {
    name: 'knife-from-behind', seed: 6, ticks: 1500, level: open([hunter(0, 10, Math.PI), guard]),
    drive: (S) => {
      const z = S.zombies[0], d = Math.hypot(z.x - S.player.x, z.z - S.player.z);
      return { inp: { ...toward(S, z.x, z.z), crouch: true, aim: [0, 0, -1] }, acts: d < 1.5 && S.player.knifeCd === 0 && z.state !== 'dead' ? [{ do: 'knife' }] : [] };
    },
  },
  // a strong crosswind: three full draws at a target 40 m away, aimed straight at it, so the wind and the fall decide where the arrows land
  {
    name: 'wind-and-drop', seed: 7, ticks: 1500, level: open([hunter(0, -10, 0), guard], [], { wind: { speed: 8, dir: 1.2, swing: 0, vary: 0, gust: 0 } }),
    drive: archer({ first: 30, period: 300, pick: (S) => alive(S)[0] }),
  },
  // an arrow into the ground, then walk to it and pick it up
  {
    name: 'shoot-and-retrieve', seed: 8, ticks: 1800, level: open([{ role: 'sleeper', x: 0, z: -4, yaw: 0 }, guard]),
    drive: (S, t) => {
      const stuck = S.arrows.find((a) => a.state === 'stuck');
      if (t < 200 || !stuck) return { inp: { aim: aimAt(S, 0, 0.2, 10), draw: t >= 30 && t < 110 } };
      const d = Math.hypot(stuck.x - S.player.x, stuck.z - S.player.z);
      return { inp: { ...(d > 1.6 ? toward(S, stuck.x, stuck.z) : {}), aim: [0, 0, -1] }, acts: d <= 1.6 ? [{ do: 'retrieve' }] : [] };
    },
  },
  // a screamer sees the player and screams: the sleeper near it wakes (a dormant zombie wakes only to a loud enough noise, and an arrow ringing off a post is not one: a noise
  // at a wall's own surface counts as behind that wall), then both come for the player
  {
    name: 'scream-wakes-a-sleeper', seed: 10, ticks: 1800, level: open([{ role: 'screamer', x: 0, z: 16, yaw: 0 }, { role: 'sleeper', x: 4, z: 18, yaw: 0 }, guard]),
    drive: () => ({ inp: { aim: [0, 0, -1] } }),
  },
  // off the edge of a 2.4 m block: the landing noise, with a hunter near enough to hear it
  {
    name: 'fall-from-a-ledge', seed: 9, ticks: 900, level: open([hunter(14, 22, Math.PI / 2), guard], [{ x0: 0, x1: 4, z0: 20, z1: 24, y0: 0, y1: 2.4, tag: 'concrete' }], { start: { x: 2, z: 22, yaw: 0 } }),
    drive: (S, t) => ({ inp: { mx: t > 60 ? 1 : 0, mz: 0, aim: [1, 0, 0] } }),
  },
];
