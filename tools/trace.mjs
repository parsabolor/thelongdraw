// Trace recorder and checker for the simulation (src/sim.js). A trace is a recorded run: the level, the seed, the inputs and actions of every tick, the random number
// generator's state after every tick, every event with the tick it happened on, and a rounded snapshot of the whole state every CHECKPOINT_EVERY ticks. The Rust port of the
// simulation (the engine's M2) replays the same inputs and must match the checkpoints within a tolerance and the generator's state exactly (it says whether `rand()` is
// drawn the same number of times: the state is a counter, so a swap of two draws shows only later, in a value that differs). In this repo the traces guard the simulation against unintended change.
//
//   node tools/trace.mjs record [dir]    record every scenario of tools/trace-scenarios.mjs into dir (default test/traces)
//   node tools/trace.mjs check [dir]     replay every trace in dir and say whether it still matches
//
// Format (longdraw-trace/1): numbers in events and snapshots are rounded to 1e-4 (and infinity is the string "inf"); inputs are rounded to 1e-6 *before* the simulation sees
// them, so a replay is bit-exact. `inputs` lists changes only: {tick, inp} holds from that tick until the next entry (fields not named are the defaults), {tick, acts} are
// one-shot actions taken just before that tick's step.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVEL } from '../src/level.js';
import { TUNING, createState, step, knife, retrieve, bail, tagById } from '../src/sim.js';

export const FORMAT = 'longdraw-trace/1';
export const CHECKPOINT_EVERY = 60;
const LEVELS = { outpost: LEVEL };
const DEFAULT_INPUT = { mx: 0, mz: 0, aim: null, from: null, crouch: false, run: false, draw: false, cancel: false, jump: false };

/** A hash of the rules (TUNING) a trace was recorded under, so a trace says when it is out of date. */
export const tuningHash = () => createHash('sha256').update(JSON.stringify(TUNING)).digest('hex').slice(0, 16);

const num = (v) => (v === Infinity ? 'inf' : v === -Infinity ? '-inf' : Number.isNaN(v) ? 'nan' : Math.round(v * 1e4) / 1e4);
const rounded = (o) => {
  if (typeof o === 'number') return num(o);
  if (Array.isArray(o)) return o.map(rounded);
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, rounded(v)]));
  return o;
};
const input6 = (o) => {
  if (typeof o === 'number') return Math.round(o * 1e6) / 1e6;
  if (Array.isArray(o)) return o.map(input6);
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, input6(v)]));
  return o;
};
const point = (p) => (p ? { x: p.x, z: p.z, y: p.y ?? null } : null); // (y: how high a place is when it matters, a player seen up a tower; null on the ground)

/** Everything in the state that the rules decide, rounded. */
export function snapshot(S) {
  const P = S.player;
  return rounded({
    t: S.t, rng: S.rng.a, over: S.over, status: S.status, threat: S.threat, entered: S.entered, wasAlert: S.wasAlert, nextId: S.nextId,
    wind: { x: S.wind.x, z: S.wind.z, speed: S.wind.speed, gust: S.wind.gust },
    stats: S.stats,
    player: {
      x: P.x, y: P.y, z: P.z, vy: P.vy, yaw: P.yaw, hp: P.hp, crouch: P.crouch, run: P.run, moving: P.moving, stride: P.stride, falling: P.falling, kind: P.kind,
      quiver: P.quiver, drawing: P.drawing, drawT: P.drawT, stun: P.stun, knifeCd: P.knifeCd,
    },
    zombies: S.zombies.map((z) => ({
      id: z.id, role: z.role, state: z.state, x: z.x, y: z.y, z: z.z, yaw: z.yaw, meter: z.meter, sens: z.sens, hp: z.hp, tagged: z.tagged, sees: z.sees, timer: z.timer,
      wait: z.wait, pi: z.pi, arrived: z.arrived, atk: z.atk, screamed: z.screamed, report: z.report, lkp: point(z.lkp), point: point(z.point), searchC: point(z.searchC), leg: z.leg,
    })),
    arrows: S.arrows.map((a) => ({ id: a.id, kind: a.kind, state: a.state, x: a.x, y: a.y, z: a.z, vx: a.vx, vy: a.vy, vz: a.vz, age: a.age, whistle: a.whistle, tag: a.tag, zid: a.zid ?? null })),
  });
}

// One tick: the actions the game takes between steps (main.js), then the step.
function advance(S, inp, acts) {
  for (const a of acts) {
    if (a.do === 'kind') S.player.kind = a.v;
    else if (a.do === 'retrieve') retrieve(S);
    else if (a.do === 'bail') bail(S);
    else if (a.do === 'knife') knife(S);
    else if (a.do === 'tag') tagById(S, a.id);
    else throw new Error('unknown action ' + JSON.stringify(a));
  }
  step(S, { ...DEFAULT_INPUT, ...inp });
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Runs a scenario: `drive(S, tick)` gives `{inp, acts}` for each tick (it may look at the state, which is why a trace stores what it returned, not the controller). Stops at `ticks` or when the game is over. */
export function simulate({ name, level = 'outpost', seed = 1, ticks, drive }) {
  const def = typeof level === 'string' ? LEVELS[level] : level;
  if (!def) throw new Error('unknown level ' + level);
  const S = createState(def, seed);
  const trace = { format: FORMAT, name, level, seed, dt: TUNING.dt, tuning: tuningHash(), ticks: 0, inputs: [], rng: [], events: [], checkpoints: [{ tick: 0, state: snapshot(S) }] };
  let current = {};
  for (let tick = 1; tick <= ticks; tick++) {
    const driven = drive(S, tick);
    const inp = input6(driven.inp || {}), acts = input6(driven.acts || []);
    const changes = Object.fromEntries(Object.entries({ ...DEFAULT_INPUT, ...inp }).filter(([k, v]) => !same(v, current[k] ?? DEFAULT_INPUT[k])));
    if (Object.keys(changes).length) { // the fields that changed, each at its new value (a field back at its default is written out, so the entry is complete)
      trace.inputs.push({ tick, inp: changes });
      current = { ...current, ...changes };
    }
    if (acts.length) trace.inputs.push({ tick, acts });
    advance(S, current, acts);
    trace.rng.push(S.rng.a);
    for (const e of S.events.splice(0)) trace.events.push({ tick, ...rounded(e) });
    trace.ticks = tick;
    if (tick % CHECKPOINT_EVERY === 0) trace.checkpoints.push({ tick, state: snapshot(S) });
    if (S.over) break;
  }
  if (trace.ticks % CHECKPOINT_EVERY !== 0) trace.checkpoints.push({ tick: trace.ticks, state: snapshot(S) });
  return trace;
}

/** The controller that replays a trace's own inputs. */
export function driveFromTrace(trace) {
  let at = 0, inp = {};
  return (S, tick) => {
    let acts = [];
    while (at < trace.inputs.length && trace.inputs[at].tick === tick) {
      const e = trace.inputs[at++];
      if (e.inp) inp = { ...inp, ...e.inp };
      if (e.acts) acts = acts.concat(e.acts);
    }
    return { inp, acts };
  };
}

/** Replays a trace against the current simulation; null if it matches exactly, else a description of the first difference. */
export function verify(trace) {
  const again = simulate({ name: trace.name, level: trace.level, seed: trace.seed, ticks: trace.ticks, drive: driveFromTrace(trace) });
  if (again.tuning !== trace.tuning) return `recorded under other rules (tuning ${trace.tuning}, now ${again.tuning})`;
  const i = again.rng.findIndex((v, k) => v !== trace.rng[k]);
  if (i >= 0 || again.rng.length !== trace.rng.length) return `the random number generator differs at tick ${i + 1}`;
  const e = again.events.findIndex((v, k) => !same(v, trace.events[k]));
  if (e >= 0 || again.events.length !== trace.events.length) return `the events differ at event ${e}: ${JSON.stringify(again.events[e])} against ${JSON.stringify(trace.events[e])}`;
  const c = again.checkpoints.findIndex((v, k) => !same(v, trace.checkpoints[k]));
  if (c >= 0 || again.checkpoints.length !== trace.checkpoints.length) return `the state differs at checkpoint ${c} (tick ${trace.checkpoints[c]?.tick})`;
  return null;
}

/** JSON with one entry per line for the long lists, so a change in a trace is a readable diff. */
export function format(trace) {
  const { inputs, rng, events, checkpoints, ...head } = trace;
  const lines = (list) => '[\n' + list.map((x) => '    ' + JSON.stringify(x)).join(',\n') + '\n  ]';
  return `{\n  ${Object.entries(head).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n  ')},\n  "inputs": ${lines(inputs)},\n  "rng": ${JSON.stringify(rng)},\n  "events": ${lines(events)},\n  "checkpoints": ${lines(checkpoints)}\n}\n`;
}

export function readTraces(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ file: f, trace: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}

// ---------- command line ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, dir = fileURLToPath(new URL('../test/traces', import.meta.url))] = process.argv.slice(2);
  if (cmd === 'record') {
    const { SCENARIOS } = await import('./trace-scenarios.mjs');
    mkdirSync(dir, { recursive: true });
    for (const sc of SCENARIOS) {
      const trace = simulate(sc);
      writeFileSync(join(dir, sc.name + '.json'), format(trace));
      console.log(`${sc.name}: ${trace.ticks} ticks, ${trace.events.length} events, ${trace.checkpoints.length} checkpoints`);
    }
  } else if (cmd === 'check') {
    let bad = 0;
    for (const { file, trace } of readTraces(dir)) {
      const problem = verify(trace);
      console.log(`${file}: ${problem ?? 'matches'}`);
      if (problem) bad++;
    }
    process.exit(bad ? 1 : 0);
  } else {
    console.error('usage: node tools/trace.mjs record|check [dir]');
    process.exit(2);
  }
}
