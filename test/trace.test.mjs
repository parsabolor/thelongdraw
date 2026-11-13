// The recorded traces (test/traces) and the level export (tools/export-sim-data.mjs): the traces replay exactly against the current simulation, are up to date with their
// scenarios, still cover everything the Rust port has to match, and the export says what buildLevel says. If a trace fails because the rules changed on purpose, record
// them again (node tools/trace.mjs record) and look at the diff; if it was not on purpose, the simulation just changed behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { LEVEL, terrainHeight } from '../src/level.js';
import { WORLD } from '../src/world-data.js';
import { buildLevel } from '../src/sim.js';
import { simulate, verify, format, readTraces, tuningHash, FORMAT } from '../tools/trace.mjs';
import { SCENARIOS } from '../tools/trace-scenarios.mjs';
import { exportOutpost, LEVEL_FORMAT } from '../tools/export-sim-data.mjs';

const DIR = fileURLToPath(new URL('./traces', import.meta.url));
const traces = readTraces(DIR);

test('every scenario has a recorded trace, and every recorded trace has a scenario', () => {
  assert.deepEqual(traces.map((t) => t.file), SCENARIOS.map((s) => s.name + '.json').sort());
});

test('each recorded trace replays exactly: the random number generator, the events and every checkpoint', () => {
  for (const { file, trace } of traces) {
    assert.equal(trace.format, FORMAT, file);
    assert.equal(trace.tuning, tuningHash(), `${file} was recorded under other rules: record the traces again`);
    assert.equal(verify(trace), null, file);
  }
});

test('recording a scenario again gives the recorded file, byte for byte', () => {
  for (const sc of SCENARIOS) {
    const file = traces.find((t) => t.file === sc.name + '.json');
    assert.equal(format(simulate(sc)), format(file.trace), sc.name);
  }
});

test('between them the traces cover what the port has to match: every kind of event, every state a zombie can be in, every kind of noise', () => {
  const events = new Set(), states = new Set(), noises = new Set(), ends = new Set();
  for (const { trace } of traces) {
    for (const e of trace.events) {
      events.add(e.type);
      if (e.type === 'state') states.add(e.to);
      if (e.type === 'noise') noises.add(e.kind);
    }
    ends.add(trace.checkpoints.at(-1).state.over);
  }
  for (const type of ['bell', 'noise', 'state', 'alert', 'blown', 'hit', 'swarmed', 'over', 'tag', 'kill', 'knife', 'shot', 'stick', 'retrieve', 'wound', 'wake']) assert.ok(events.has(type), `an event of type ${type}`);
  // (a sleeper starts dormant, so a state event never says it is entering that one)
  for (const state of ['suspicious', 'alert', 'search', 'caution', 'dead']) assert.ok(states.has(state), `a zombie entering ${state}`);
  for (const kind of ['step', 'release', 'impact', 'whistle', 'scream', 'call', 'wound', 'land', 'rummage']) assert.ok(noises.has(kind), `a noise of kind ${kind}`);
  assert.ok(ends.has('dead') && ends.has(null), 'runs that end in the player dying and runs that do not');
});

test('the scenarios added after the first port review cover what it found untested: the knife beyond a silent kill, the scout\'s report, retrieving, loud impacts, the endings', () => {
  const ev = (name) => traces.find((t) => t.file === name + '.json').trace.events;
  const knives = ev('knife-from-the-front').filter((e) => e.type === 'knife'), swings = ev('knife-cone-and-miss').filter((e) => e.type === 'knife');
  assert.ok(knives.some((e) => e.hit && !e.silent && !e.killed) && knives.some((e) => e.hit && e.killed), 'a plain stab that wounds, then one that kills');
  assert.ok(ev('knife-from-the-front').some((e) => e.type === 'kill' && e.how === 'stab'));
  assert.deepEqual(swings.map((e) => [e.hit, e.silent]), [[false, false], [false, false], [true, true]], 'two swings at nothing (the one in the cooldown leaves no event), then a silent kill');
  // the scout alerts, calls, and the far hunter is told in the same tick; the sleeper out of earshot stays dormant
  const scout = ev('scout-reports-to-a-hunter'), alert = scout.find((e) => e.type === 'alert' && e.id === 1);
  assert.ok(alert && scout.some((e) => e.type === 'state' && e.id === 2 && e.to === 'suspicious' && e.tick === alert.tick), 'told at the moment of the first report');
  assert.ok(scout.filter((e) => e.type === 'noise' && e.kind === 'call').length >= 5, 'it keeps reporting while it sees the player');
  assert.deepEqual(traces.find((t) => t.file === 'scout-reports-to-a-hunter.json').trace.checkpoints.at(-1).state.zombies.map((z) => z.state === 'dormant'), [false, false, true]);
  const impacts = ev('impacts-on-three-surfaces').filter((e) => e.type === 'noise' && e.kind === 'impact');
  assert.deepEqual(impacts.map((e) => [e.tag, e.loud]), [['metal', 0.8], ['concrete', 0.6], ['asphalt', 0.6]]);
  const corpse = ev('head-shot-and-retrieve-from-the-corpse');
  assert.ok(corpse.findIndex((e) => e.type === 'retrieve') > corpse.findIndex((e) => e.type === 'kill' && e.how === 'head') && corpse.some((e) => e.type === 'kill'), 'the arrow comes out of the corpse');
  assert.ok(!ev('a-wounded-zombie-keeps-the-arrow').some((e) => e.type === 'retrieve') && ev('a-wounded-zombie-keeps-the-arrow').some((e) => e.type === 'wound'), 'but not out of a zombie that is still alive');
  assert.deepEqual(ev('bail-at-the-bike').filter((e) => e.type === 'over').map((e) => e.result), ['bailed'], 'pressed before going in it does nothing');
  assert.deepEqual(ev('clear-the-outpost').filter((e) => e.type === 'over').map((e) => e.result), ['cleared']);
  const vest = ev('an-arrow-rings-off-the-armored-vest');
  assert.deepEqual(vest.filter((e) => ['stick', 'wound', 'kill'].includes(e.type)).map((e) => [e.type, e.tag ?? e.how ?? null]), [['stick', 'metal'], ['wound', null], ['stick', 'flesh'], ['kill', 'head']],
    'the armored zombie: an arrow rings off his vest and he cries out unhurt, then a head shot kills him');
  const pick = traces.find((t) => t.file === 'lure-then-the-patrol-points.json').trace;
  assert.ok(Math.max(...pick.checkpoints.map((c) => c.state.zombies[0].pi)) >= 3, 'a hunter walks on past the first patrol point it picked');
});

test('the generator state is recorded for every tick, and it moves in the traces where something draws a random number (patrols, searches, arrows)', () => {
  const moves = (trace) => trace.rng.some((v, i) => i > 0 && v !== trace.rng[i - 1]);
  for (const { file, trace } of traces) assert.equal(trace.rng.length, trace.ticks, file);
  for (const name of ['idle-patrol', 'creep-then-run', 'snipe-from-the-valley', 'lure-and-wait', 'wind-and-drop']) assert.ok(moves(traces.find((t) => t.file === name + '.json').trace), `${name} draws random numbers`);
});

const decode = (b64, Type) => { const b = Buffer.from(b64, 'base64'); return new Type(b.buffer, b.byteOffset, b.byteLength / Type.BYTES_PER_ELEMENT); };

test('the exported outpost is what buildLevel makes, cell for cell, and its terrain is the level\'s own', () => {
  const x = exportOutpost(), L = buildLevel(LEVEL);
  assert.equal(x.format, LEVEL_FORMAT);
  for (const k of ['ter', 'obs', 'h']) assert.deepEqual(Array.from(decode(x.built[k], Float32Array)), Array.from(L[k]), k); // (infinity is in the cells that are sealed)
  const cells = decode(x.built.obsTag.cells, Uint8Array);
  assert.deepEqual(Array.from(cells, (c) => (c ? x.built.obsTag.tags[c - 1] : null)), L.obsTag);
  assert.deepEqual([x.built.w, x.built.d, x.built.x0, x.built.z0, x.built.minY, x.built.sealed], [L.w, L.d, L.x0, L.z0, L.minY, L.sealed]);
  const heights = decode(x.terrain.heights, Float32Array), n = x.terrain.n;
  assert.equal(heights.length, n * n);
  for (const [i, j] of [[0, 0], [100, 100], [200, 200], [57, 143], [143, 57], [30, 170]]) assert.equal(heights[j * n + i], terrainHeight(WORLD.x0 + i, WORLD.z0 + j), `terrain sample ${i}, ${j}`);
  assert.equal(x.def.spawns.length, LEVEL.spawns.length);
  assert.equal(x.def.boxes.length, LEVEL.boxes.length);
  assert.equal(JSON.stringify(exportOutpost()), JSON.stringify(x), 'the export is the same every time');
});
