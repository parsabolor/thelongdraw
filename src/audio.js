// audio.js: The Long Draw, pure WebAudio synthesiser. No samples, no network.
// Driven by the sim's event list and state: the noises the zombies "hear" are the noises the player hears.
//
// Usage: const audio = createAudio();            // once, no AudioContext yet
//        audio.resume();                         // from a user gesture (click/keydown); safe to repeat
//        audio.update(S, S.events, dt, { x, y, z, fx, fy, fz });   // every frame, after the sim stepped
// Extras beyond the frozen API: audio.setAmbient(bool), audio.stopAll() (call on restart), stats().errors.
// World metres: x east, y up, z south. That is already WebAudio's right-handed frame, so no conversion.

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const rnd = (a, b) => a + Math.random() * (b - a);
const num = (v, d) => (Number.isFinite(v) ? v : d);
const hash = (n) => { n = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); n ^= n >>> 13; n = Math.imul(n, 0xc2b2ae35); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
const loudGain = (loud) => 0.18 + 0.82 * Math.pow(clamp(num(loud, 0.5)), 0.7); // `loud` -> gain, floored so quiet sounds stay audible
const P3 = (o, y = 1.2) => (o && Number.isFinite(o.x) && Number.isFinite(o.z) ? { x: o.x, y: num(o.y, y), z: o.z } : null);

const CAP = 24; // simultaneous one-shot voices
const ZRANGE = 45; // zombies talk, and the heart beats, inside this many metres
const GAP = { idle: [8, 18], suspicious: [3, 6], search: [4, 8], caution: [6, 12], alert: [1.6, 3.2] }; // seconds between a zombie's voices

// Vocal presets: f0 = pitch contour, f1/f2 = formant sweeps (Hz, evenly spaced over the sound), rough = [AM rate, depth],
// vib = [rate, depth Hz], det = detuned 2nd oscillator, breath = noise level, atk/hold/rel seconds.
const VOX = {
  groan: { f0: [88, 96, 72, 58], f1: [420, 520, 380, 300], f2: [900, 1100, 800, 700], rough: [24, 0.35], vib: [5, 2], breath: 0.3, atk: 0.25, hold: 0.5, rel: 0.7, peak: 0.9 },
  growl: { f0: [115, 92, 78], f1: [500, 700, 450], f2: [1000, 1300, 900], rough: [34, 0.5], vib: [6, 2], breath: 0.4, atk: 0.05, hold: 0.3, rel: 0.45, peak: 1 },
  roar: { f0: [130, 210, 180, 95], f1: [600, 950, 800, 500], f2: [1200, 1750, 1500, 1000], rough: [38, 0.55], det: 1.012, breath: 0.6, atk: 0.05, hold: 0.8, rel: 0.7, peak: 1 },
  pain: { f0: [330, 540, 660, 430, 300], f1: [800, 1150, 1000, 700, 600], f2: [1800, 2500, 2200, 1700, 1500], rough: [18, 0.25], vib: [7, 12], det: 1.008, breath: 0.3, atk: 0.03, hold: 0.45, rel: 0.5, peak: 0.9 },
  shriek: { f0: [600, 1100, 1500, 1300, 1750, 900], f1: [1400, 2000, 2400, 2000, 2600, 1600], f2: [2800, 3600, 4000, 3400, 4200, 2800], rough: [55, 0.45], vib: [9, 40], det: 1.015, breath: 0.5, atk: 0.12, hold: 2, rel: 1, peak: 1 },
  wail: { f0: [260, 420, 430, 390, 300], f1: [700, 900, 900, 800, 600], f2: [1300, 1700, 1600, 1500, 1200], rough: [14, 0.12], vib: [5.5, 14], det: 1.004, breath: 0.15, atk: 0.3, hold: 1.5, rel: 0.9, peak: 0.9 },
  gurgle: { f0: [100, 85, 120, 70], f1: [350, 300, 380, 300], f2: [800, 600, 900, 600], rough: [30, 0.7], breath: 0.8, atk: 0.04, hold: 0.25, rel: 0.35, peak: 0.9 },
  grunt: { f0: [150, 90], f1: [500, 380], f2: [1000, 800], rough: [28, 0.4], breath: 0.4, atk: 0.02, hold: 0.1, rel: 0.22, peak: 1 },
  wake: { f0: [60, 80, 110, 90], f1: [350, 450, 550, 400], f2: [800, 1000, 1200, 900], rough: [20, 0.3], vib: [4, 2], breath: 0.3, atk: 0.3, hold: 0.4, rel: 0.5, peak: 0.9 },
};
const voxDur = (o) => o.atk + o.hold + o.rel;

export function createAudio() {
  let ctx = null, analyser = null, noiseBuf = null, scope = null, master = null;
  let bus = {}, creak = null, tension = null, bed = null, windBus = null; // windBus: only the wind layers, scaled by S.wind.speed (bed also carries the drone)
  let volume = 0.8, muted = false, ambientOn = true, errs = 0;
  let clock = 0, nextCricket = 2, nextBeat = 0, hbLvl = 0, hbBpm = 70, tLvl = 0, prevDrawing = false, prevDrawT = 0;
  const voices = [], zs = new Map(), seen = new WeakSet(), alerted = [];
  const L = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1 };

  // ---------------------------------------------------------------- graph
  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    master.channelCount = 2; master.channelCountMode = 'explicit'; // always stereo, mono sources upmix to both ears
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.18;
    // soft clip: linear to 0.7, then a tanh knee. The curve never exceeds ~0.93 even for clamped inputs, so peak < 1 is guaranteed.
    const shaper = ctx.createWaveShaper(), n = 2049, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x); curve[i] = Math.sign(x) * (a < 0.7 ? a : 0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3)); }
    shaper.curve = curve;
    const ceil = ctx.createGain(); ceil.gain.value = 0.97;
    analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
    master.connect(comp); comp.connect(shaper); shaper.connect(ceil); ceil.connect(ctx.destination); ceil.connect(analyser);
    audio.analyser = analyser; scope = new Float32Array(analyser.fftSize);

    // one shared noise buffer for every hiss, wind and click in the game
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    const g = (v) => { const x = ctx.createGain(); x.gain.value = v; return x; };
    bus.sfx = g(1); bus.sfx.connect(master);
    bus.heart = g(0); bus.heart.connect(master);
    bus.ambIn = g(1); bus.ambLP = ctx.createBiquadFilter(); bus.ambLP.type = 'lowpass'; bus.ambLP.frequency.value = 5200;
    bus.ambOut = g(1); bus.ambIn.connect(bus.ambLP); bus.ambLP.connect(bus.ambOut); bus.ambOut.connect(master);
    bed = g(1); bed.connect(bus.ambIn); // wind + drone, switchable for tests

    const noiseLoop = () => { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.start(0, rnd(0, 1.5)); return s; };
    const lfo = (rate, depth, param) => { const o = ctx.createOscillator(), a = g(depth); o.frequency.value = rate; o.connect(a); a.connect(param); o.start(); };
    const filt = (type, f, q) => { const x = ctx.createBiquadFilter(); x.type = type; x.frequency.value = f; x.Q.value = q; return x; };
    // wind: three layers of filtered noise, each with its own slow gain LFO, through one gain that follows the real wind
    windBus = g(1); windBus.connect(bed);
    for (const [type, f, q, base, rate, depth] of [['lowpass', 360, 0.7, 0.065, 0.07, 0.04], ['bandpass', 850, 0.6, 0.02, 0.11, 0.014], ['lowpass', 160, 0.5, 0.04, 0.031, 0.027]]) {
      const gn = g(base); lfo(rate, depth, gn.gain); noiseLoop().connect(filt(type, f, q)).connect(gn); gn.connect(windBus);
    }
    // faint low drone: two beating sines plus a fifth
    for (const [f, a] of [[55, 0.012], [55.6, 0.012], [82.4, 0.004]]) { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(g(a)).connect(bed); o.start(); }

    // draw creak: stick-slip noise through a narrow band that rises with draw time, plus a groaning limb
    const gate = g(0), am = g(0.5), bp = filt('bandpass', 600, 10), wood = ctx.createOscillator(), wl = filt('lowpass', 380, 0.8), wg = g(0.5);
    const lf = ctx.createOscillator(); lf.type = 'triangle'; lf.frequency.value = 8; const lfg = g(0.5); lf.connect(lfg); lfg.connect(am.gain); lf.start();
    noiseLoop().connect(bp); bp.connect(am); am.connect(gate);
    wood.type = 'sawtooth'; wood.frequency.value = 90; wood.connect(wl); wl.connect(wg); wg.connect(am); wood.start();
    gate.connect(bus.sfx);
    creak = { gate, bp, lf, wood };

    // tension bed: dissonant low pair, plus a thin whine; both scale with how hunted the player is
    const tg = g(0), tf = filt('lowpass', 280, 1.5);
    for (const f of [73.4, 77.8]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(tf); o.start(); }
    lfo(0.23, 90, tf.frequency); tf.connect(tg); tg.connect(master);
    const wh = ctx.createOscillator(), wn = g(0), wt = g(0.5); wh.frequency.value = 3100; lfo(0.4, 0.4, wt.gain); wh.connect(wt); wt.connect(wn); wn.connect(master); wh.start();
    tension = { tg, wn };
  }

  // ---------------------------------------------------------------- voices (one per sound, capped)
  const attn = (p) => { if (!p) return 1; const d = Math.hypot(p.x - L.x, p.y - L.y, p.z - L.z); return d <= 4 ? 1 : 4 / (4 + (p.roll || 1.4) * (d - 4)); }; // p.roll: optional slower roll-off for sounds that must carry
  const detach = (v) => { try { v.out.disconnect(); } catch { /* already gone */ } };
  function evict(v) {
    const t = ctx.currentTime;
    v.in.gain.cancelScheduledValues(t); v.in.gain.setTargetAtTime(0, t, 0.01);
    for (const s of v.srcs) { try { s.stop(t + 0.08); } catch { /* not started */ } }
    voices.splice(voices.indexOf(v), 1);
    setTimeout(() => detach(v), 150);
  }
  function prune() {
    const now = ctx.currentTime;
    for (let i = voices.length - 1; i >= 0; i--) if (voices[i].t1 < now) { detach(voices[i]); voices.splice(i, 1); }
  }
  // ponytail: a panner's position is fixed when the voice starts, so a long shriek from a moving zombie will not track it. Upgrade: keep v.out and move it each frame.
  // Returns null when the new sound is the quietest one and the cap is reached. Otherwise drops the quietest/oldest existing voice.
  function voice(vol, dur, pos, dest, hrtf) {
    prune();
    const eff = vol * attn(pos);
    if (voices.length >= CAP) {
      let q = voices[0];
      for (const x of voices) if (x.eff < q.eff || (x.eff === q.eff && x.t0 < q.t0)) q = x;
      if (q.eff > eff) return null;
      evict(q);
    }
    const now = ctx.currentTime, gn = ctx.createGain();
    gn.gain.value = vol;
    const v = { vol, eff, t0: now, t1: now + dur + 0.15, srcs: [], in: gn, out: gn, hrtf: false };
    if (pos && Math.hypot(pos.x - L.x, pos.y - L.y, pos.z - L.z) > 1) { // closer than 1 m: leave it centred
      const p = ctx.createPanner();
      v.hrtf = !!hrtf && voices.filter((x) => x.hrtf).length < 8; // HRTF is the costly model: only a few at once
      p.panningModel = v.hrtf ? 'HRTF' : 'equalpower';
      p.distanceModel = 'inverse'; p.refDistance = 4; p.rolloffFactor = pos.roll || 1.4; p.maxDistance = 150;
      p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
      gn.connect(p); p.connect(dest || bus.sfx); v.out = p;
    } else gn.connect(dest || bus.sfx);
    voices.push(v);
    return v;
  }
  const fire = (dur, vol, pos, fn, arg, dest, hrtf) => { const v = voice(vol, dur, pos, dest, hrtf); if (v) fn(v, ctx.currentTime + 0.005, arg); return v; };

  // ---------------------------------------------------------------- synthesis primitives
  const go = (v, s, t, d) => { s.start(t); s.stop(t + d + 0.05); v.srcs.push(s); return s; };
  function env(v, t, atk, hold, rel, peak, dest) {
    const gn = ctx.createGain(), p = gn.gain;
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(peak, t + atk);
    if (hold > 0) p.setValueAtTime(peak, t + atk + hold);
    p.exponentialRampToValueAtTime(0.0001, t + atk + hold + rel);
    gn.connect(dest || v.in);
    return gn;
  }
  function tone(v, type, f0, f1, t, dur, peak, atk = 0.004, dest) { // oscillator with a pitch glide and a percussive envelope
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    o.connect(env(v, t, atk, 0, Math.max(dur - atk, 0.005), peak, dest));
    return go(v, o, t, dur);
  }
  function hiss(v, type, f0, f1, q, t, dur, peak, atk = 0.002, dest) { // filtered noise burst with a sweeping cutoff
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    s.connect(f); f.connect(env(v, t, atk, 0, Math.max(dur - atk, 0.005), peak, dest));
    s.start(t, rnd(0, 1.5)); s.stop(t + dur + 0.05); v.srcs.push(s);
  }
  const ring = (v, t, f, ratios, dur, peak, tilt) => ratios.forEach((r, i) => tone(v, 'sine', f * r, f * r, t, dur / (1 + i * tilt), peak / (1 + i * 0.4))); // inharmonic partials
  const path = (param, t, d, pts) => { param.setValueAtTime(pts[0], t); for (let i = 1; i < pts.length; i++) param.linearRampToValueAtTime(pts[i], t + (d * i) / (pts.length - 1)); };

  // Voice synth: detuned saws -> two formant band-passes, amplitude "roughness" LFO, vibrato, breath noise.
  function vocal(v, t, o, p) {
    const d = voxDur(o), out = env(v, t, o.atk, o.hold, o.rel, o.peak);
    let tail = out;
    if (o.rough) {
      const r = ctx.createGain(), l = ctx.createOscillator(), lg = ctx.createGain();
      r.gain.value = 1 - o.rough[1]; l.frequency.value = o.rough[0] * rnd(0.9, 1.1); lg.gain.value = o.rough[1];
      l.connect(lg); lg.connect(r.gain); r.connect(out); go(v, l, t, d); tail = r;
    }
    const mix = ctx.createGain(), fs = Math.sqrt(p);
    for (let i = 0; i < (o.det ? 2 : 1); i++) {
      const s = ctx.createOscillator(); s.type = 'sawtooth';
      path(s.frequency, t, d, o.f0.map((x) => x * p * (i ? o.det : 1)));
      if (o.vib) { const l = ctx.createOscillator(), lg = ctx.createGain(); l.frequency.value = o.vib[0]; lg.gain.value = o.vib[1] * p; l.connect(lg); lg.connect(s.frequency); go(v, l, t, d); }
      s.connect(mix); go(v, s, t, d);
    }
    for (const [F, q, a] of [[o.f1, 5, 5], [o.f2, 8, 3.5]]) {
      const b = ctx.createBiquadFilter(), gn = ctx.createGain();
      b.type = 'bandpass'; b.Q.value = q; path(b.frequency, t, d, F.map((x) => x * fs)); gn.gain.value = a;
      mix.connect(b); b.connect(gn); gn.connect(tail);
    }
    if (o.breath) hiss(v, 'bandpass', o.f2[0] * fs, o.f2[o.f2.length - 1] * fs, 1.5, t, d, o.breath, o.atk, tail);
  }

  // ---------------------------------------------------------------- the sound set
  const STEP = {
    grass: [0.3, (v, t) => { hiss(v, 'bandpass', 2800, 1700, 0.9, t, 0.16, 0.9, 0.045); hiss(v, 'lowpass', 320, 150, 0.7, t + 0.02, 0.07, 0.5); }],
    dirt: [0.3, (v, t) => { tone(v, 'sine', 100, 48, t, 0.11, 1); hiss(v, 'lowpass', 1200, 400, 0.8, t, 0.08, 0.7); }],
    rock: [0.3, (v, t) => { for (let i = 0; i < 4; i++) hiss(v, 'bandpass', rnd(1800, 4200), rnd(1200, 2500), 1.8, t + i * rnd(0.012, 0.03), 0.035, 0.8); tone(v, 'sine', 150, 70, t, 0.08, 0.5); }],
    asphalt: [0.2, (v, t) => { hiss(v, 'highpass', 1800, 1800, 0.7, t, 0.035, 0.9); tone(v, 'sine', 230, 120, t, 0.06, 0.6); }],
    concrete: [0.25, (v, t) => { hiss(v, 'highpass', 1100, 1100, 0.7, t, 0.04, 0.8); tone(v, 'sine', 170, 95, t, 0.08, 0.8); }],
    metal: [0.7, (v, t) => { ring(v, t, 540, [1, 2.76, 5.4], 0.45, 0.6, 1); hiss(v, 'highpass', 3000, 3000, 0.7, t, 0.012, 0.6); tone(v, 'sine', 140, 80, t, 0.06, 0.5); }],
    wood: [0.25, (v, t) => { tone(v, 'sine', 200, 105, t, 0.1, 1); tone(v, 'sine', 350, 250, t, 0.05, 0.5); hiss(v, 'bandpass', 900, 700, 3, t, 0.04, 0.6); }],
  };
  const IMP = {
    dirt: [0.4, (v, t) => { tone(v, 'sine', 120, 42, t, 0.16, 1); hiss(v, 'lowpass', 700, 250, 0.8, t, 0.12, 0.8); }],
    grass: [0.4, (v, t) => { tone(v, 'sine', 100, 45, t, 0.14, 0.8); hiss(v, 'bandpass', 2000, 1200, 0.9, t, 0.1, 0.5, 0.01); }],
    rock: [0.3, (v, t) => { hiss(v, 'highpass', 2500, 2500, 0.7, t, 0.012, 1); tone(v, 'sine', 1900, 1200, t, 0.03, 0.5); hiss(v, 'bandpass', 3500, 2500, 2, t, 0.05, 0.6); tone(v, 'sine', 260, 130, t, 0.05, 0.4); }],
    concrete: [0.3, (v, t) => { hiss(v, 'highpass', 2000, 2000, 0.7, t, 0.012, 1); tone(v, 'sine', 1300, 800, t, 0.04, 0.5); hiss(v, 'bandpass', 2200, 1500, 2, t, 0.06, 0.6); tone(v, 'sine', 200, 110, t, 0.06, 0.5); }],
    metal: [1.6, (v, t) => { ring(v, t, 480, [1, 2.756, 5.404, 8.933], 1.4, 0.7, 0.8); hiss(v, 'highpass', 2500, 2500, 0.7, t, 0.02, 0.8); }],
    wood: [0.3, (v, t) => { tone(v, 'sine', 320, 150, t, 0.07, 1); tone(v, 'sine', 640, 420, t, 0.04, 0.5); hiss(v, 'bandpass', 1300, 900, 4, t, 0.035, 0.7); }],
    flesh: [0.4, (v, t) => { hiss(v, 'lowpass', 900, 200, 0.8, t, 0.09, 1, 0.006); tone(v, 'sine', 150, 60, t, 0.12, 0.9, 0.006); }],
  };
  const twang = (v, t) => { // plucked string: partials at a drifting pitch, plus click and limb whoosh
    const f = 150 + rnd(-8, 8);
    [[1, 1, 0.9], [2, 0.6, 0.55], [3, 0.4, 0.35], [4.02, 0.25, 0.22], [5.1, 0.12, 0.14]].forEach(([k, a, d]) => tone(v, 'sine', f * k * 1.03, f * k, t, d, a));
    hiss(v, 'highpass', 2500, 2500, 0.7, t, 0.015, 0.8); hiss(v, 'bandpass', 900, 300, 2, t, 0.09, 0.5);
  };
  const whistle = (v, t, dist) => { // short grain: the lure arrow is a run of these, one per 0.1 s
    const f = 1900 + 1500 * clamp(1 - dist / 40) + rnd(-60, 60), o = ctx.createOscillator(), l = ctx.createOscillator(), lg = ctx.createGain();
    o.frequency.setValueAtTime(f, t); o.frequency.linearRampToValueAtTime(f * 1.03, t + 0.14);
    l.frequency.value = 38; lg.gain.value = f * 0.012; l.connect(lg); lg.connect(o.frequency);
    o.connect(env(v, t, 0.025, 0.04, 0.09, 0.55)); go(v, o, t, 0.16); go(v, l, t, 0.16);
    hiss(v, 'bandpass', 4200, 4600, 9, t, 0.14, 0.15, 0.03);
  };
  const fall = (v, t) => { tone(v, 'sine', 75, 32, t, 0.3, 1, 0.006); hiss(v, 'lowpass', 320, 120, 0.7, t, 0.22, 0.9, 0.006); hiss(v, 'bandpass', 1600, 900, 0.8, t + 0.05, 0.16, 0.4, 0.03); };
  const land = (v, t) => { tone(v, 'sine', 85, 38, t, 0.16, 0.8); hiss(v, 'lowpass', 500, 200, 0.8, t, 0.1, 0.6); };
  const rummage = (v, t) => {
    const n = 4 + ((Math.random() * 4) | 0);
    for (let i = 0; i < n; i++) hiss(v, 'bandpass', rnd(1500, 4500), rnd(1200, 3500), 1.2, t + i * rnd(0.07, 0.13), rnd(0.05, 0.1), 0.8, 0.015);
    tone(v, 'sine', 220, 150, t + 0.3, 0.05, 0.4);
  };
  const tagClick = (v, t) => { tone(v, 'sine', 2400, 2400, t, 0.03, 0.8, 0.002); tone(v, 'sine', 3200, 3200, t + 0.055, 0.025, 0.6, 0.002); };
  const fullDraw = (v, t) => { tone(v, 'sine', 2200, 2000, t, 0.04, 0.6, 0.002); hiss(v, 'highpass', 3000, 3000, 0.7, t, 0.01, 0.6); };
  const nock = (v, t) => { hiss(v, 'bandpass', 1200, 900, 3, t, 0.03, 0.7); tone(v, 'sine', 260, 180, t, 0.04, 0.4); };
  const retrieve = (v, t) => { hiss(v, 'bandpass', 600, 2400, 2, t, 0.12, 0.6, 0.02); tone(v, 'sine', 260, 200, t + 0.12, 0.04, 0.5); };
  const knifeFx = (v, t, hit) => { // a blade through the air, then (on a hit) a dull thud
    hiss(v, 'bandpass', 700, 3200, 1.5, t, 0.16, 0.6, 0.01);
    if (hit) { tone(v, 'sine', 130, 45, t + 0.12, 0.16, 0.9, 0.003); hiss(v, 'lowpass', 500, 200, 0.8, t + 0.12, 0.1, 0.7, 0.003); }
  };
  const bell = (v, t) => { ring(v, t, 330, [0.56, 0.92, 1.19, 1.71, 2, 2.74, 3, 3.76, 4.07], 6, 0.5, 0.35); tone(v, 'sine', 330 * 0.56 + 1.3, 330 * 0.56 + 1.3, t, 5, 0.3); hiss(v, 'highpass', 2000, 2000, 0.7, t, 0.02, 0.5); };
  const hitFx = (v, t) => { vocal(v, t, VOX.grunt, 1); tone(v, 'sine', 90, 36, t, 0.25, 1.3, 0.004); hiss(v, 'lowpass', 400, 150, 0.8, t, 0.15, 1, 0.003); };
  const blown = (v, t) => { tone(v, 'sine', 55, 38, t, 1.6, 1, 0.01); tone(v, 'sine', 220, 220, t, 1.3, 0.2, 0.5); tone(v, 'sine', 233, 233, t, 1.3, 0.2, 0.5); };
  const swarmed = (v, t) => { tone(v, 'sine', 60, 28, t, 0.7, 1.4, 0.005); hiss(v, 'lowpass', 300, 100, 0.7, t, 0.5, 1); vocal(v, t, VOX.growl, 0.9); vocal(v, t + 0.12, VOX.grunt, 0.8); };
  const overDead = (v, t) => { tone(v, 'sine', 110, 27, t, 2.6, 0.9, 0.02); hiss(v, 'lowpass', 400, 80, 0.7, t, 2.2, 0.5, 0.3); };
  const overWin = (v, t) => [196, 247, 294, 392].forEach((f, i) => tone(v, 'sine', f, f, t + i * 0.1, 3.4, 0.3, 0.6));
  const vox = (name, p) => (v, t) => vocal(v, t, VOX[name], p);
  const cricket = (v, t, f) => { // 3 pulses per chirp, a handful of chirps
    const o = ctx.createOscillator(), gn = ctx.createGain(), groups = 3 + ((Math.random() * 4) | 0), per = rnd(0.3, 0.42);
    o.frequency.value = f; gn.gain.value = 0; o.connect(gn); gn.connect(v.in);
    for (let k = 0; k < groups; k++) for (let j = 0; j < 3; j++) { const s = t + k * per + j * 0.05; gn.gain.setValueAtTime(0, s); gn.gain.linearRampToValueAtTime(1, s + 0.01); gn.gain.linearRampToValueAtTime(0, s + 0.032); }
    go(v, o, t, groups * per + 0.2);
  };
  function cricketGroup() {
    const a = rnd(0, 6.28), d = rnd(7, 24);
    fire(3.5, 0.16 * (1 - 0.85 * tLvl), { x: L.x + Math.cos(a) * d, y: L.y - 1.2, z: L.z + Math.sin(a) * d }, cricket, rnd(3900, 5100), bus.ambIn);
  }
  function beat(t, bpm) { // lub-dub, non-positional, through the heartbeat bus
    const v = voice(1, 0.8, null, bus.heart);
    if (!v) return;
    const gap = Math.min(0.2, (60 / bpm) * 0.28);
    for (const [dt, a, f0, f1] of [[0, 1, 68, 42], [gap, 0.7, 58, 38]]) {
      tone(v, 'sine', f0, f1, t + dt, 0.16, a, 0.005); tone(v, 'triangle', f0 * 1.6, f1 * 1.6, t + dt, 0.1, a * 0.35, 0.005);
      hiss(v, 'lowpass', 260, 120, 0.7, t + dt, 0.07, a * 0.4, 0.004);
    }
  }

  // ---------------------------------------------------------------- zombies
  const zOf = (S, id) => (S.zombies || []).find((z) => z.id === id);
  const zPos = (z) => ({ x: z.x, y: z.y + 1.4, z: z.z });
  const zinfo = (id) => { let m = zs.get(id); if (!m) { m = { next: clock + rnd(1, 9), p: 0.82 + hash(id) * 0.4, st: null, roar: -9 }; zs.set(id, m); } return m; };
  const speak = (name, pos, p, vol) => fire(voxDur(VOX[name]) + 0.1, vol, pos, vox(name, p), null, null, true);
  function roar(S, id, pos) {
    const z = zOf(S, id), m = zinfo(id);
    pos = pos || (z && zPos(z));
    if (!pos || clock - m.roar < 1) return;
    m.roar = clock; speak('roar', pos, m.p, 1);
  }

  // ---------------------------------------------------------------- events
  function noise(e) {
    const pos = P3(e), vol = loudGain(e.loud);
    switch (e.kind) {
      case 'step': { const s = STEP[e.tag] || STEP.dirt; return fire(s[0], (0.06 + 0.94 * Math.pow(clamp(num(e.loud, 0.3)), 0.8)) * 0.9, pos, s[1]); }
      case 'release': return fire(1.1, Math.min(1, vol * 0.7), pos, twang);
      case 'impact': { const s = IMP[e.tag] || IMP.dirt; return fire(s[0], vol, pos, s[1]); }
      case 'whistle': return fire(0.2, vol, pos, whistle, pos ? Math.hypot(pos.x - L.x, pos.y - L.y, pos.z - L.z) : 20);
      case 'fall': return fire(0.5, vol, pos, fall);
      case 'land': return fire(0.3, vol, pos, land);
      case 'rummage': return fire(0.8, vol, pos, rummage);
      case 'wound': return speak('pain', pos, rnd(0.9, 1.1), vol);
      case 'scream': if (pos) pos.roll = 0.8; return speak('shriek', pos, 1, vol);
      case 'call': if (pos) pos.roll = 0.8; return speak('wail', pos, rnd(0.95, 1.05), vol);
    }
  }
  function handle(S, e) {
    switch (e.type) {
      case 'noise': return noise(e);
      case 'alert': return roar(S, e.id, P3(e));
      case 'state': { // fallback when the sim only emits state changes: hunters roar on entering alert
        if (e.to !== 'alert' || alerted.includes(e.id)) return;
        const z = zOf(S, e.id);
        if (z && z.kind !== 'scout' && z.kind !== 'screamer') roar(S, e.id);
        return;
      }
      case 'kill': { const z = zOf(S, e.id); if (z) speak('gurgle', zPos(z), zinfo(e.id).p * (e.how === 'head' ? 1.15 : 1), e.how === 'head' ? 0.6 : 0.9); return; }
      case 'wake': { const z = zOf(S, e.id); if (z) speak('wake', zPos(z), zinfo(e.id).p, 0.8); return; }
      case 'hit': return fire(0.6, 0.85, null, hitFx);
      case 'tag': return fire(0.15, 0.3, null, tagClick);
      case 'retrieve': return fire(0.3, 0.5, null, retrieve);
      case 'knife': return fire(0.5, 0.55, null, knifeFx, e.hit);
      case 'bell': { const p = P3(e, 3) || P3(S.bell, 3); if (p) p.roll = 0.5; return fire(7, 1, p, bell); }
      case 'blown': return fire(2, 0.3, null, blown);
      case 'swarmed': return fire(1, 0.55, null, swarmed);
      case 'over': return e.result === 'dead' ? fire(3, 0.4, null, overDead) : e.result === 'cleared' ? fire(4.5, 0.5, null, overWin) : undefined;
    }
  }

  // ---------------------------------------------------------------- per frame
  function setListener(l) {
    if (l) {
      L.x = num(l.x, L.x); L.y = num(l.y, L.y); L.z = num(l.z, L.z);
      L.fx = num(l.fx, L.fx); L.fy = clamp(num(l.fy, L.fy), -0.99, 0.99); L.fz = num(l.fz, L.fz);
      if (!L.fx && !L.fy && !L.fz) L.fz = -1;
    }
    const a = ctx.listener;
    a.positionX.value = L.x; a.positionY.value = L.y; a.positionZ.value = L.z;
    a.forwardX.value = L.fx; a.forwardY.value = L.fy; a.forwardZ.value = L.fz;
    a.upX.value = 0; a.upY.value = 1; a.upZ.value = 0;
  }

  function update(S, events, dt, lis) {
    if (!ctx || ctx.state !== 'running' || !S) return;
    try {
      dt = clamp(num(dt, 0.016), 0, 0.25); clock += dt;
      const now = ctx.currentTime;
      setListener(lis);
      prune();

      alerted.length = 0;
      if (events) for (const e of events) if (e.type === 'alert') alerted.push(e.id);
      if (events) {
        for (const e of events) {
          if (seen.has(e)) continue; // the same array may be handed over twice
          seen.add(e);
          try { handle(S, e); } catch (err) { errs++; console.error('audio event', e.type, err); }
        }
      }

      // draw creak (continuous), nock and full-draw tick
      const P = S.player || {}, drawing = !!P.drawing, dT = num(P.drawT, 0), k = clamp(dT / 1.4);
      if (drawing && !prevDrawing) fire(0.1, 0.2, null, nock);
      if (drawing && prevDrawT < 1.2 && dT >= 1.2) fire(0.12, 0.25, null, fullDraw);
      prevDrawing = drawing; prevDrawT = dT;
      creak.bp.frequency.setTargetAtTime(500 + 1100 * k, now, 0.05);
      creak.lf.frequency.setTargetAtTime(6 + 12 * k, now, 0.1);
      creak.wood.frequency.setTargetAtTime(90 + 130 * k, now, 0.05);
      creak.gate.gain.setTargetAtTime(drawing ? 0.1 + 0.12 * k : 0, now, drawing ? 0.05 : 0.025);
      // the wind bed follows the wind: 1.0 at 4 m/s (as before), 0.6 in still air, 1.7 in a 10 m/s gust
      windBus.gain.setTargetAtTime(0.6 + 0.1 * clamp(num(S.wind && S.wind.speed, 4), 0, 11), now, 0.35);

      // zombie voices: each has its own timer and a pitch from its id; a state change brings the next voice forward
      for (const z of S.zombies || []) {
        if (z.state === 'dead' || z.state === 'dormant') continue;
        const m = zinfo(z.id);
        if (m.st !== z.state) { if (m.st) m.next = Math.min(m.next, clock + rnd(0.3, 1.4)); m.st = z.state; }
        const dx = z.x - L.x, dz = z.z - L.z;
        if (dx * dx + dz * dz > ZRANGE * ZRANGE || clock < m.next) continue;
        const gap = GAP[z.state] || GAP.idle;
        m.next = clock + rnd(gap[0], gap[1]);
        if (z.state === 'alert') speak('growl', zPos(z), m.p, 1); else speak('groan', zPos(z), m.p, 0.9);
      }

      // heartbeat: tempo and level from threat distance, fades slowly when the threat is gone
      const dist = S.threat ? S.threat.dist : Infinity, near = dist < ZRANGE;
      const hb = near ? clamp((ZRANGE - dist) / 40) : 0, hbT = near ? 0.7 * (0.12 + 0.88 * hb) : 0, tc = hbT > hbLvl ? 0.25 : 1.4;
      hbLvl += (hbT - hbLvl) * (1 - Math.exp(-dt / tc));
      bus.heart.gain.setTargetAtTime(hbT, now, tc);
      if (near) hbBpm += (70 + 70 * hb - hbBpm) * (1 - Math.exp(-dt / 0.6));
      if (hbLvl > 0.03) {
        if (nextBeat < now) nextBeat = now + 0.02;
        while (nextBeat < now + 0.12) { beat(nextBeat, hbBpm); nextBeat += 60 / hbBpm; }
      }

      // tension: duck and low-pass the night, fade in the dissonant bed
      const st = S.status, tT = Math.max(hb * 0.9, st === 'HUNTED' ? 1 : st === 'SPOTTED' ? 0.65 : st === 'NOTICED' ? 0.3 : 0);
      tLvl += (tT - tLvl) * (1 - Math.exp(-dt / 0.8));
      bus.ambLP.frequency.setTargetAtTime(5200 - 4200 * tLvl, now, 0.3);
      bus.ambOut.gain.setTargetAtTime(1 - 0.5 * tLvl, now, 0.3);
      tension.tg.gain.setTargetAtTime(0.1 * tLvl, now, 0.4);
      tension.wn.gain.setTargetAtTime(0.004 * tLvl, now, 0.4);

      if (ambientOn && clock >= nextCricket) { nextCricket = clock + rnd(0.8, 4); cricketGroup(); }
    } catch (err) { errs++; console.error('audio update', err); }
  }

  // ---------------------------------------------------------------- public API
  function resume() {
    if (!ctx) { try { build(); } catch (err) { errs++; console.error('audio init', err); ctx = null; return Promise.resolve(); } }
    return ctx.state === 'suspended' ? ctx.resume().catch(() => {}) : Promise.resolve();
  }
  function stats() {
    if (!analyser) return { state: ctx ? ctx.state : 'none', voices: 0, rms: 0, peak: 0, errors: errs };
    analyser.getFloatTimeDomainData(scope);
    let pk = 0, s = 0, bad = false;
    for (let i = 0; i < scope.length; i++) { const x = scope[i], a = Math.abs(x); s += x * x; if (a !== a) bad = true; else if (a > pk) pk = a; }
    return { state: ctx.state, voices: voices.length, rms: bad ? NaN : Math.sqrt(s / scope.length), peak: bad ? NaN : pk, errors: errs };
  }
  const audio = {
    analyser: null, resume, update, stats,
    setMuted(m) { muted = !!m; if (ctx) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.03); },
    setVolume(x) { volume = clamp(num(x, volume)); if (ctx) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.03); },
    setAmbient(on) { ambientOn = !!on; if (ctx) bed.gain.setTargetAtTime(ambientOn ? 1 : 0, ctx.currentTime, 0.05); }, // wind, drone, crickets
    stopAll() { if (!ctx) return; for (const v of voices.slice()) evict(v); hbLvl = 0; nextBeat = 0; }, // restart / game over screen
    _cricket: () => ctx && cricketGroup(), // test only
  };
  return audio;
}
