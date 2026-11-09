// circuitSounds.js (the black-hole and circuit sound recipes) and audio.js's playRecipe / startLoop.
// docs/DESIGN-circuits.md §2.11, §4.12, §6.2.11, §7 C. A stub AudioContext records every node, connection, start/stop time
// and parameter automation (the same stand-in as survivalAudio.test.js, plus looping and setTargetAtTime).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SOUND_RECIPES, SOUND_NAMES, LAYER_TYPES } from '../../src/circuitSounds.js';
import { createAudio, MAX_VOICES, RECIPE_DEFAULT_ATTACK_S } from '../../src/audio.js';

const BLACK_HOLE_SOUNDS = ['bhArm', 'bhFlash', 'bhImplode', 'bhCollapse', 'bhSwallow', 'bhDrone'];
const CIRCUIT_SOUNDS = ['switchClack', 'buttonClick', 'relayClick', 'timerWind', 'timerTick', 'timerDing', 'bellRing',
  'sparkZap', 'plunger', 'igniterPop', 'fuseLight'];

const isFilter = (v) => (typeof v === 'number' && v > 0 && Number.isFinite(v)) ||
  (Array.isArray(v) && v.length === 2 && v.every((f) => typeof f === 'number' && f > 0 && Number.isFinite(f)));
const attackOf = (l) => (l.attack === undefined ? RECIPE_DEFAULT_ATTACK_S : l.attack);
const layerEnd = (l) => (l.delay ?? 0) + attackOf(l) + l.decay;
/** The highest frequency a layer sounds at: an oscillator's pitch, or (for noise) its filters' top. */
const topHz = (l) => (l.type === 'noise' ? 0 : Math.max(l.f0, l.f1 ?? l.f0));

describe('sound recipes (§2.11, §4.12, §6.2.11)', () => {
  it('hold exactly the black-hole and circuit sounds', () => {
    expect([...SOUND_NAMES].sort()).toEqual([...BLACK_HOLE_SOUNDS, ...CIRCUIT_SOUNDS].sort());
    expect(Object.isFrozen(SOUND_RECIPES)).toBe(true);
    expect(Object.isFrozen(SOUND_RECIPES.bhDrone.layers[0])).toBe(true);
  });

  for (const name of [...BLACK_HOLE_SOUNDS, ...CIRCUIT_SOUNDS]) {
    it(`${name} fits the recipe schema`, () => {
      const r = SOUND_RECIPES[name];
      expect(Object.keys(r).every((k) => ['dur', 'gain', 'layers', 'repeat'].includes(k))).toBe(true);
      expect(r.dur > 0 && Number.isFinite(r.dur)).toBe(true);
      expect(r.gain > 0 && r.gain <= 1).toBe(true);
      expect(Array.isArray(r.layers) && r.layers.length > 0).toBe(true);
      const strikes = r.repeat ? r.repeat.count : 1;
      const every = r.repeat ? r.repeat.every : 0;
      if (r.repeat) {
        expect(Number.isInteger(r.repeat.count) && r.repeat.count >= 2 && r.repeat.every > 0).toBe(true);
        expect(r.repeat.count * r.repeat.every).toBeLessThanOrEqual(r.dur + 1e-9);
      }
      for (const l of r.layers) {
        const known = ['type', 'f0', 'f1', 'lp', 'hp', 'bp', 'q', 'gain', 'delay', 'attack', 'decay', 'lfoHz', 'lfoDepth'];
        expect(Object.keys(l).every((k) => known.includes(k)), JSON.stringify(l)).toBe(true);
        expect(LAYER_TYPES).toContain(l.type);
        if (l.type === 'noise') expect(l.f0).toBe(0);
        else expect(l.f0 > 0 && Number.isFinite(l.f0)).toBe(true);
        if (l.f1 !== undefined) expect(l.type !== 'noise' && l.f1 > 0).toBe(true);
        for (const f of ['lp', 'hp', 'bp']) if (l[f] !== undefined) expect(isFilter(l[f]), `${name}.${f}`).toBe(true);
        if (l.q !== undefined) expect(l.q > 0).toBe(true);
        expect(l.gain > 0 && l.gain <= 1).toBe(true);
        if (l.delay !== undefined) expect(l.delay >= 0).toBe(true);
        if (l.attack !== undefined) expect(l.attack >= 0).toBe(true);
        expect(l.decay > 0).toBe(true);
        expect((l.lfoHz === undefined) === (l.lfoDepth === undefined)).toBe(true);
        if (l.lfoHz !== undefined) expect(l.lfoHz > 0 && l.lfoDepth > 0 && l.lfoDepth <= 1).toBe(true);
        // Every voice has ended by the end of the sound.
        expect((strikes - 1) * every + layerEnd(l), `${name} layer ends by dur`).toBeLessThanOrEqual(r.dur + 1e-9);
      }
    });
  }

  it('bhImplode, bhDrone and bhCollapse each carry a layer at or above 100 Hz (small speakers lose the fundamental)', () => {
    for (const name of ['bhImplode', 'bhDrone', 'bhCollapse']) {
      expect(SOUND_RECIPES[name].layers.some((l) => topHz(l) >= 100), name).toBe(true);
    }
  });

  it('follow §2.11 and §4.12\'s numbers', () => {
    const R = SOUND_RECIPES;
    expect(R.bhArm.gain).toBe(0.35);
    expect(R.bhArm.layers.find((l) => l.type === 'sine')).toMatchObject({ f0: 180, f1: 900 });
    expect(R.bhArm.layers.find((l) => l.type === 'noise').bp).toEqual([300, 2500]);
    expect(R.bhFlash.gain).toBe(0.8);
    expect(R.bhFlash.layers[0]).toMatchObject({ type: 'noise', hp: 3000, decay: 0.08 });
    expect(R.bhFlash.layers[1]).toMatchObject({ type: 'sine', f0: 2400, f1: 300, decay: 0.25 });
    expect(R.bhImplode.gain).toBe(0.9);
    expect(R.bhImplode.layers[0].lp).toEqual([200, 4000]);
    expect(R.bhImplode.layers.filter((l) => l.type === 'sine').map((l) => [l.f0, l.f1, l.gain])).toEqual([[55, 28, 1], [110, 56, 0.5]]);
    expect(R.bhImplode.layers.find((l) => l.type === 'noise' && l.lp === 300).decay).toBe(0.02);
    expect(R.bhCollapse.layers.filter((l) => l.type === 'sine').map((l) => [l.f0, l.f1, l.gain])).toEqual([[28, 70, 1], [56, 140, 0.5]]);
    expect(R.bhSwallow.layers[0].bp).toEqual([1800, 200]);
    const drone = R.bhDrone.layers;
    expect(drone.filter((l) => l.type === 'sine').map((l) => l.f0)).toEqual([38, 57, 114, 171]);
    expect(drone.find((l) => l.f0 === 114).gain / drone.find((l) => l.f0 === 38).gain).toBeCloseTo(0.5, 9);
    expect(drone.filter((l) => l.type === 'sine').every((l) => l.lfoHz === 0.3)).toBe(true);
    expect(drone.find((l) => l.type === 'noise').bp).toBe(400);
    expect(R.switchClack.layers.map((l) => l.bp ?? l.f0)).toEqual([2500, 180]);
    expect(R.relayClick.gain).toBe(0.2);
    expect(R.timerWind.repeat).toEqual({ every: 0.05, count: 6 });
    expect(R.timerDing.layers.map((l) => l.f0)).toEqual([1320, 1980]);
    expect(R.bellRing.layers.filter((l) => l.type === 'sine').map((l) => l.f0)).toEqual([950, 1430, 2600]);
    expect(R.bellRing.layers[0].decay).toBe(0.25);
    expect(R.sparkZap.layers[0]).toMatchObject({ type: 'noise', hp: 6000, decay: 0.04 });
    expect(R.sparkZap.layers[1]).toMatchObject({ f0: 120, decay: 0.03 });
    expect(R.plunger.layers[0]).toMatchObject({ type: 'saw', f0: 400, f1: 80 });
    expect(R.plunger.layers.slice(1).every((l) => l.delay === 0.3)).toBe(true);
  });

  it('circuitSounds.js is pure data: no imports, no DOM, no clock', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/circuitSounds.js', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/Math\.random\(|Date\.now\(|performance\.now\(|document\.|window\.|AudioContext/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// audio.js: playRecipe / startLoop
// ---------------------------------------------------------------------------------------------------------------

function fakeParam() {
  return {
    value: 0,
    peak: 0,
    events: [],
    setValueAtTime(v, t) {
      this.value = v;
      this.peak = Math.max(this.peak, v);
      this.events.push(['set', v, t]);
    },
    linearRampToValueAtTime(v, t) {
      this.peak = Math.max(this.peak, v);
      this.events.push(['linear', v, t]);
    },
    exponentialRampToValueAtTime(v, t) {
      if (!(v > 0)) throw new RangeError('exponential ramps need a positive target');
      this.peak = Math.max(this.peak, v);
      this.events.push(['exp', v, t]);
    },
    setTargetAtTime(v, t, k) {
      if (!(k > 0)) throw new RangeError('time constant must be positive');
      this.events.push(['target', v, t]);
    },
    cancelScheduledValues() {},
  };
}

function fakeContextClass(log, opts = {}) {
  return class FakeAudioContext {
    constructor() {
      this.state = opts.state ?? 'running';
      this.sampleRate = 44100;
      this.currentTime = 3;
      this.destination = { kind: 'destination' };
    }
    _node(kind) {
      if (opts.throwOn === kind) throw new Error(`no ${kind} today`);
      const n = {
        kind,
        type: '',
        outputs: [],
        connect(to) {
          this.outputs.push(to);
          return to;
        },
        disconnect() {
          this.disconnected = true;
        },
        gain: fakeParam(),
        frequency: fakeParam(),
        playbackRate: fakeParam(),
        Q: fakeParam(),
      };
      log.push(n);
      return n;
    }
    _source(kind) {
      const n = this._node(kind);
      n.start = (t, offset) => {
        n.startAt = t;
        n.offset = offset;
      };
      n.stop = (t) => {
        n.stopAt = t;
      };
      return n;
    }
    createGain() {
      return this._node('gain');
    }
    createBiquadFilter() {
      return this._node('filter');
    }
    createOscillator() {
      return this._source('osc');
    }
    createBufferSource() {
      return this._source('noise');
    }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return { duration: length / rate, getChannelData: () => data };
    }
    resume() {
      return Promise.resolve();
    }
  };
}

const sources = (nodes) => nodes.filter((n) => n.kind === 'osc' || n.kind === 'noise');
/** Voices still sounding: tracked sources whose onended has not fired. */
const live = (log) => sources(log).filter((s) => typeof s.onended === 'function');

function rig(opts) {
  const log = [];
  const audio = createAudio({ AudioContextClass: fakeContextClass(log, opts) });
  audio.resume();
  const master = log[0];
  const during = (fn, finish = true) => {
    const from = log.length;
    fn();
    const nodes = log.slice(from);
    if (finish) for (const s of sources(nodes)) if (typeof s.onended === 'function') s.onended();
    return nodes;
  };
  return { log, audio, master, during };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('audio.playRecipe (§6.2.11)', () => {
  it('exists, is silent before resume(), and never throws', () => {
    const log = [];
    const audio = createAudio({ AudioContextClass: fakeContextClass(log) });
    expect(typeof audio.playRecipe).toBe('function');
    expect(typeof audio.startLoop).toBe('function');
    expect(audio.playRecipe('bhArm')).toBeUndefined();
    expect(log).toHaveLength(0);
    const quiet = createAudio({ AudioContextClass: undefined });
    expect(() => quiet.playRecipe('bhFlash')).not.toThrow();
  });

  for (const name of [...BLACK_HOLE_SOUNDS, ...CIRCUIT_SOUNDS]) {
    it(`${name}: one voice per layer per strike, each started, filtered, enveloped and stopped`, () => {
      const { audio, master, during } = rig();
      const r = SOUND_RECIPES[name];
      const nodes = during(() => audio.playRecipe(name), false);
      const strikes = r.repeat ? r.repeat.count : 1;
      const lfos = r.layers.filter((l) => l.lfoHz).length * strikes;
      const src = sources(nodes);
      expect(src).toHaveLength(r.layers.length * strikes + lfos);
      const tracked = src.filter((s) => typeof s.onended === 'function'); // one voice per layer; LFOs ride along
      expect(tracked).toHaveLength(r.layers.length * strikes);
      for (const s of tracked) s.onended();
      for (const s of src) {
        expect(s.startAt).toBeGreaterThanOrEqual(3);
        expect(s.stopAt).toBeGreaterThan(s.startAt);
        expect(s.stopAt - 3).toBeLessThanOrEqual(r.dur + 1e-9);
      }
      // Each layer's envelope feeds the master and decays to (almost) nothing.
      const envelopes = nodes.filter((n) => n.kind === 'gain' && n.outputs.includes(master));
      expect(envelopes).toHaveLength(r.layers.length * strikes);
      for (const g of envelopes) {
        const last = g.gain.events[g.gain.events.length - 1];
        expect(last[0]).toBe('exp');
        expect(last[1]).toBeLessThan(0.01);
        expect(g.gain.peak).toBeLessThanOrEqual(1);
      }
      // The filters are the recipe's, in series hp → bp → lp.
      const filters = nodes.filter((n) => n.kind === 'filter');
      const want = r.layers.reduce((s, l) => s + ['hp', 'bp', 'lp'].filter((f) => l[f] !== undefined).length, 0) * strikes;
      expect(filters).toHaveLength(want);
    });
  }

  it('sweeps oscillators and swept filters exponentially over the layer, and holds static filters', () => {
    const { audio, during } = rig();
    const nodes = during(() => audio.playRecipe('bhSwallow'));
    const f = nodes.find((n) => n.kind === 'filter');
    expect(f.type).toBe('bandpass');
    expect(f.frequency.events[0]).toEqual(['set', 1800, 3]);
    const end = 3 + 0.05 + 0.55;
    expect(f.frequency.events[1][0]).toBe('exp');
    expect(f.frequency.events[1][1]).toBe(200);
    expect(f.frequency.events[1][2]).toBeCloseTo(end, 9);
    const arm = during(() => audio.playRecipe('bhArm'));
    const osc = arm.find((n) => n.kind === 'osc');
    expect(osc.type).toBe('sine');
    expect(osc.frequency.events.map((e) => e[1])).toEqual([180, 900]);
    const flash = during(() => audio.playRecipe('bhFlash'));
    const hp = flash.find((n) => n.kind === 'filter');
    expect(hp.type).toBe('highpass');
    expect(hp.frequency.events).toEqual([['set', 3000, 3]]);
    const delayed = flash.filter((n) => n.kind === 'osc')[0];
    expect(delayed.startAt).toBeCloseTo(3.06, 9); // its `delay`
    const plunger = during(() => audio.playRecipe('plunger'));
    expect(plunger.find((n) => n.kind === 'osc').type).toBe('sawtooth');
    expect(during(() => audio.playRecipe('sparkZap')).find((n) => n.kind === 'osc').type).toBe('square');
  });

  it('strikes a repeat recipe `count` times, `every` seconds apart', () => {
    const { audio, during } = rig();
    const nodes = during(() => audio.playRecipe('timerWind'));
    const starts = sources(nodes).filter((s) => s.kind === 'noise').map((s) => s.startAt);
    expect(starts).toHaveLength(6);
    starts.forEach((t, k) => expect(t).toBeCloseTo(3 + 0.05 * k, 9));
  });

  it('scales with its volume and the recipe\'s gain, accepts a recipe object, and is silent at 0, NaN, an unknown name or muted', () => {
    const { audio, during, master } = rig();
    const peak = (nodes) => Math.max(...nodes.filter((n) => n.kind === 'gain' && n.outputs.includes(master)).map((g) => g.gain.peak));
    const full = peak(during(() => audio.playRecipe('timerDing')));
    expect(full).toBeCloseTo(SOUND_RECIPES.timerDing.gain * SOUND_RECIPES.timerDing.layers[0].gain, 9);
    expect(peak(during(() => audio.playRecipe('timerDing', 0.5)))).toBeCloseTo(full / 2, 9);
    expect(peak(during(() => audio.playRecipe('timerDing', 7)))).toBeCloseTo(full, 9);
    const custom = { dur: 0.2, gain: 0.5, layers: [{ type: 'sine', f0: 440, gain: 0.8, decay: 0.1 }] };
    expect(peak(during(() => audio.playRecipe(custom)))).toBeCloseTo(0.4, 9);
    for (const v of [0, -1, NaN]) expect(during(() => audio.playRecipe('timerDing', v))).toEqual([]);
    expect(during(() => audio.playRecipe('noSuchSound'))).toEqual([]);
    expect(during(() => audio.playRecipe({ layers: 'x' }))).toEqual([]);
    expect(during(() => audio.playRecipe(null))).toEqual([]);
    audio.setMuted(true);
    for (const name of SOUND_NAMES) expect(during(() => audio.playRecipe(name)), name).toEqual([]);
    audio.setMuted(false);
    expect(during(() => audio.playRecipe('timerDing')).length).toBeGreaterThan(0);
  });

  it('keeps within MAX_VOICES: layers past the limit are dropped until voices end', () => {
    const { log, audio } = rig();
    for (let k = 0; k < 20; k++) audio.playRecipe('bellRing');
    expect(live(log).length).toBe(MAX_VOICES);
    audio.playRecipe('bhImplode');
    expect(live(log).length).toBe(MAX_VOICES);
    for (const s of live(log).slice(0, 4)) s.onended();
    audio.playRecipe('bhImplode');
    expect(live(log).length).toBe(MAX_VOICES);
    for (const s of live(log)) s.onended();
    expect(live(log)).toHaveLength(0);
    audio.playRecipe('timerWind');
    expect(live(log).length).toBe(12);
  });

  it('never throws out of a broken audio graph', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { audio } = rig({ throwOn: 'filter' });
    for (const name of SOUND_NAMES) expect(() => audio.playRecipe(name)).not.toThrow();
    expect(() => audio.startLoop('bhDrone').set(1)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('waits for a running context: a suspended one schedules nothing', () => {
    const { log, audio } = rig({ state: 'suspended' });
    const before = log.length;
    audio.playRecipe('bhFlash');
    expect(log.length).toBe(before);
  });
});

describe('audio.startLoop (§6.2.11)', () => {
  it('a no-op handle without WebAudio, before resume() and for an unknown recipe', () => {
    const quiet = createAudio({ AudioContextClass: undefined });
    const h = quiet.startLoop('bhDrone');
    expect(() => {
      h.set(1, 1.1);
      h.set(0);
      h.stop();
    }).not.toThrow();
    const log = [];
    const audio = createAudio({ AudioContextClass: fakeContextClass(log) });
    audio.startLoop('bhDrone').set(0.5);
    expect(log).toHaveLength(0);
    audio.resume();
    const n = log.length;
    audio.startLoop('nope').set(1);
    expect(log.length).toBe(n);
  });

  it('builds one persistent voice on the first audible set: every layer, looping, with its LFO; volume and rate follow set', () => {
    const { log, audio, master } = rig();
    const h = audio.startLoop('bhDrone');
    const from = log.length;
    h.set(0, 1);
    expect(log.length).toBe(from); // volume 0: nothing built
    h.set(0.4, 1);
    const nodes = log.slice(from);
    const layers = SOUND_RECIPES.bhDrone.layers;
    const oscs = nodes.filter((n) => n.kind === 'osc');
    const noise = nodes.filter((n) => n.kind === 'noise');
    expect(noise).toHaveLength(1);
    expect(noise[0].loop).toBe(true);
    expect(oscs).toHaveLength(4 + layers.length); // four tones and five LFOs
    expect(sources(nodes).every((s) => s.startAt === 3 && s.stopAt === undefined)).toBe(true);
    const out = nodes.find((n) => n.kind === 'gain' && n.outputs.includes(master));
    expect(out.gain.events.at(-1)).toEqual(['target', 0.4, 3]);
    const tones = oscs.filter((o) => o.frequency.events.length && o.frequency.events[0][0] === 'set');
    expect(tones.map((o) => o.frequency.events[0][1])).toEqual([38, 57, 114, 171]);
    h.set(0.8, 1.1);
    expect(out.gain.events.at(-1)).toEqual(['target', 0.8, 3]);
    for (const [k, o] of tones.entries()) expect(o.frequency.events.at(-1)[1]).toBeCloseTo([38, 57, 114, 171][k] * 1.1, 9);
    expect(noise[0].playbackRate.events.at(-1)[1]).toBeCloseTo(1.1, 9);
    // A second audible set builds nothing new.
    const n = log.length;
    h.set(0.3);
    expect(log.length).toBe(n);
  });

  it('counts as one voice while audible; set(0), stop() and muting free it', () => {
    const { log, audio } = rig();
    const h = audio.startLoop('bhDrone');
    const from = log.length;
    h.set(1);
    const loopSources = sources(log.slice(from));
    const voices = () => live(log).filter((s) => !loopSources.includes(s));
    for (let k = 0; k < 40; k++) audio.playRecipe('relayClick');
    expect(voices().length).toBe(MAX_VOICES - 1); // the loop holds one voice
    for (const s of voices()) s.onended();
    h.set(0);
    expect(loopSources.every((s) => s.stopAt !== undefined)).toBe(true); // faded out and stopped
    for (let k = 0; k < 40; k++) audio.playRecipe('relayClick');
    expect(voices().length).toBe(MAX_VOICES); // freed
    for (const s of voices()) s.onended();
    for (const s of live(log)) s.onended(); // the loop's own clean-up
    // Muted: an audible set builds nothing, and muting a running loop stops it at the next set.
    h.set(1);
    const built = log.length;
    audio.setMuted(true);
    h.set(1);
    const stopped = sources(log.slice(0, built)).filter((s) => s.stopAt !== undefined);
    expect(stopped.length).toBeGreaterThan(0);
    const n = log.length;
    h.set(1);
    expect(log.length).toBe(n);
    audio.setMuted(false);
    h.set(1);
    expect(log.length).toBeGreaterThan(n);
    h.stop();
    expect(() => h.stop()).not.toThrow();
  });

  it('is not built while every voice is busy', () => {
    const { log, audio } = rig();
    for (let k = 0; k < 40; k++) audio.playRecipe('relayClick');
    const n = log.length;
    audio.startLoop('bhDrone').set(1);
    expect(log.length).toBe(n);
  });

  it('accepts a recipe object', () => {
    const { log, audio } = rig();
    const n = log.length;
    audio.startLoop({ dur: 1, gain: 0.5, layers: [{ type: 'saw', f0: 90, lp: 300, gain: 1, decay: 1 }] }).set(1);
    const nodes = log.slice(n);
    expect(nodes.filter((x) => x.kind === 'osc')).toHaveLength(1);
    expect(nodes.find((x) => x.kind === 'filter').frequency.events[0]).toEqual(['set', 300, 3]);
  });
});
