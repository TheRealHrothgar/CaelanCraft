// The Survival sounds in src/audio.js (docs/DESIGN-survival.md §9.9): playHurt, playDeath, playEat, playDrink, playDig,
// playCraft, playToolBreak, playSizzle and playPick. Each one exists, builds its voices on a running context and never
// throws — with a stub AudioContext that records every node, connection, start/stop time and parameter automation.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createAudio, MAX_VOICES, BREAK_CUTOFF_HZ, BREAK_GAIN, PITCH_VARIATION, CRACKLE_CUTOFF_HZ,
  DIG_GAIN, DIG_TICK_DURATION_S, EAT_TICKS, EAT_TICK_GAP_S, DRINK_GULPS, DRINK_GULP_GAP_S, DRINK_GULP_START_HZ,
  DRINK_GULP_END_HZ, DEATH_TONE_START_HZ, DEATH_TONE_END_HZ, DEATH_THUD_AT_S, HURT_THUMP_START_HZ, HURT_THUMP_END_HZ,
  TOOL_BREAK_HZ, SIZZLE_HIGHPASS_HZ, PICK_SWISHES, PICK_RUSTLE_HZ, CRAFT_CHIME_HZ, CRAFT_CHIME_AT_S, CRAFT_KNOCK_HZ,
} from '../../src/audio.js';
import { SOUND_GROUPS } from '../../src/blocks.js';

/** Every Survival sound and how main calls it (§2.4, §4.2, §4.4, §4.5, §6.1, §6.4, §7.2, §5.3). */
const SOUNDS = Object.freeze({
  playHurt: (a, v) => a.playHurt(v),
  playDeath: (a, v) => a.playDeath(v),
  playEat: (a, v) => a.playEat(v),
  playDrink: (a, v) => a.playDrink(v),
  playDig: (a, v) => a.playDig('stone', v),
  playCraft: (a, v) => a.playCraft(v),
  playToolBreak: (a, v) => a.playToolBreak(v),
  playSizzle: (a, v) => a.playSizzle(v),
  playPick: (a, v) => a.playPick(v),
});
const NAMES = Object.keys(SOUNDS);

/**
 * An AudioParam stand-in that records its automation: `events` ([kind, value, time]) and `peak` (the largest value
 * it was ever set or ramped to — the envelope's peak whether or not the sound has an attack).
 */
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
    setTargetAtTime(v, t) {
      this.events.push(['target', v, t]);
    },
    cancelScheduledValues() {},
  };
}

/**
 * @param {object[]} log every node created, in order
 * @param {{ state?: string, throwOn?: string }} [opts]
 */
function fakeContextClass(log, opts = {}) {
  return class FakeAudioContext {
    constructor() {
      this.state = opts.state ?? 'running';
      this.sampleRate = 8000;
      this.currentTime = 2;
      this.destination = { kind: 'destination' };
      this.resumed = 0;
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
      this.resumed++;
      return Promise.resolve();
    }
  };
}

const sources = (nodes) => nodes.filter((n) => n.kind === 'osc' || n.kind === 'noise');

/** A resumed audio player on a fake context, and the nodes each call adds. */
function rig(opts) {
  const log = [];
  const audio = createAudio({ AudioContextClass: fakeContextClass(log, opts) });
  audio.resume();
  const master = log[0]; // createContext makes the master gain first
  /**
   * Run fn and return the nodes it created; then let those voices finish (their onended fires), as they would a
   * moment later, so a long loop of sounds never runs into MAX_VOICES.
   */
  const during = (fn) => {
    const from = log.length;
    fn();
    const nodes = log.slice(from);
    for (const s of sources(nodes)) if (typeof s.onended === 'function') s.onended();
    return nodes;
  };
  return { log, audio, master, during };
}

const gains = (nodes) => nodes.filter((n) => n.kind === 'gain');
const peakOf = (nodes) => Math.max(...gains(nodes).map((g) => g.gain.peak));
/** The filter a noise source feeds. */
const filterOf = (src) => src.outputs.find((o) => o.kind === 'filter');
/** First and last frequency an oscillator was set or ramped to. */
const sweep = (osc) => [osc.frequency.events[0][1], osc.frequency.events[osc.frequency.events.length - 1][1]];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Survival sounds: every method exists and behaves like the others (§9.9)', () => {
  for (const name of NAMES) {
    it(`${name} exists, is silent before resume(), and schedules voices that all stop`, () => {
      const log = [];
      const audio = createAudio({ AudioContextClass: fakeContextClass(log) });
      expect(typeof audio[name]).toBe('function');
      expect(SOUNDS[name](audio, 1)).toBeUndefined(); // no context yet: nothing, no throw
      expect(log.length).toBe(0);
      audio.resume();
      const master = log[0];
      const t0 = 2;
      const from = log.length;
      expect(() => SOUNDS[name](audio, 1)).not.toThrow();
      const nodes = log.slice(from);
      const src = sources(nodes);
      expect(src.length).toBeGreaterThan(0);
      for (const s of src) {
        expect(s.startAt, `${name}: ${s.kind} starts now or later`).toBeGreaterThanOrEqual(t0);
        expect(s.stopAt, `${name}: ${s.kind} stops after it starts`).toBeGreaterThan(s.startAt);
        expect(s.stopAt - t0, `${name}: short`).toBeLessThan(2);
        expect(s.outputs.length).toBe(1); // wired into its chain
        if (s.kind === 'noise') expect(s.offset).toBeGreaterThanOrEqual(0);
      }
      // Every envelope feeds the master gain and decays to (almost) nothing by the time its voice stops.
      for (const g of gains(nodes)) {
        expect(g.outputs).toContain(master);
        const last = g.gain.events[g.gain.events.length - 1];
        expect(last[0]).toBe('exp');
        expect(last[1]).toBeLessThan(0.01);
      }
      expect(peakOf(nodes)).toBeGreaterThan(0);
      expect(peakOf(nodes)).toBeLessThanOrEqual(1);
    });

    it(`${name} scales with its volume (default 1) and is silent at 0, below 0, NaN or when muted`, () => {
      const { audio, during } = rig();
      const loud = peakOf(during(() => SOUNDS[name](audio, 1)));
      const byDefault = peakOf(during(() => (name === 'playDig' ? audio.playDig('stone') : audio[name]())));
      expect(byDefault).toBeCloseTo(loud, 9);
      expect(peakOf(during(() => SOUNDS[name](audio, 0.5)))).toBeCloseTo(loud / 2, 9);
      expect(peakOf(during(() => SOUNDS[name](audio, 0.1)))).toBeCloseTo(loud / 10, 9);
      expect(peakOf(during(() => SOUNDS[name](audio, 4)))).toBeCloseTo(loud, 9); // clamped to 1
      for (const v of [0, -1, NaN, -Infinity]) expect(during(() => SOUNDS[name](audio, v)), String(v)).toEqual([]);
      audio.setMuted(true);
      expect(during(() => SOUNDS[name](audio, 1))).toEqual([]);
      audio.setMuted(false);
      expect(during(() => SOUNDS[name](audio, 1)).length).toBeGreaterThan(0);
    });

    it(`${name} never throws: a failing context only skips the sound (one warning)`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (const throwOn of ['filter', 'osc', 'noise', 'gain']) {
        const log = [];
        const audio = createAudio({ AudioContextClass: fakeContextClass(log) });
        audio.resume(); // the master gain is created before the failure is armed
        const Ctx = fakeContextClass(log, { throwOn });
        const failing = createAudio({ AudioContextClass: Ctx });
        expect(() => failing.resume()).not.toThrow();
        expect(() => SOUNDS[name](failing, 1)).not.toThrow();
        expect(() => SOUNDS[name](audio, 1)).not.toThrow();
      }
      expect(warn.mock.calls.length).toBeGreaterThan(0);
    });

    it(`${name} waits for a running context (a suspended one is asked to resume, nothing piles up)`, () => {
      const { audio, during, log } = rig({ state: 'suspended' });
      expect(log.length).toBeGreaterThan(0); // the context exists
      expect(during(() => SOUNDS[name](audio, 1))).toEqual([]);
    });
  }

  it('the Survival methods sit on the Audio object beside the older ones', () => {
    const audio = createAudio({ AudioContextClass: fakeContextClass([]) });
    for (const name of [...NAMES, 'playBreak', 'playCrackle', 'playWatcherVanish']) expect(typeof audio[name], name).toBe('function');
  });

  it('voices end and free their slot: at MAX_VOICES new sounds are dropped until some finish', () => {
    const log = [];
    const audio = createAudio({ AudioContextClass: fakeContextClass(log) });
    audio.resume();
    const added = (fn) => {
      const from = log.length;
      fn();
      return log.length - from;
    };
    let plays = 0;
    while (added(() => audio.playDig('stone', 1)) > 0 && plays < 1000) plays++;
    expect(plays).toBe(MAX_VOICES); // one voice per dig tick, none ended yet
    for (const name of NAMES) expect(added(() => SOUNDS[name](audio, 1)), name).toBe(0);
    // The voices finish: each source's onended disconnects its whole chain.
    for (const s of sources(log)) s.onended();
    for (const n of log.slice(1)) expect(n.disconnected, n.kind).toBe(true);
    expect(added(() => audio.playEat(1))).toBeGreaterThan(0);
  });
});

describe('Survival sounds: what each one is made of', () => {
  it('playHurt: a short low thump (falling sine) plus a filtered breath with a soft attack', () => {
    const { audio, during } = rig();
    for (let i = 0; i < 20; i++) {
      const nodes = during(() => audio.playHurt(1));
      const [osc] = nodes.filter((n) => n.kind === 'osc');
      expect(nodes.filter((n) => n.kind === 'osc')).toHaveLength(1);
      expect(osc.type).toBe('sine');
      const [f0, f1] = sweep(osc);
      expect(f0).toBeGreaterThan(f1);
      expect(f0).toBeLessThanOrEqual(HURT_THUMP_START_HZ * (1 + PITCH_VARIATION) + 1e-9);
      expect(f1).toBeGreaterThanOrEqual(HURT_THUMP_END_HZ * (1 - PITCH_VARIATION) - 1e-9);
      expect(osc.stopAt - osc.startAt).toBeLessThan(0.2); // short
      const [breath] = nodes.filter((n) => n.kind === 'noise');
      expect(filterOf(breath).type).toBe('bandpass');
      const env = breath.outputs[0].outputs[0];
      expect(env.gain.events[0]).toEqual(['set', 0.001, breath.startAt]); // rises from silence: a breath, not a click
      expect(env.gain.events[1][0]).toBe('linear');
    }
  });

  it('playDeath: a falling low tone and, near its end, a muffled thud', () => {
    const { audio, during } = rig();
    const nodes = during(() => audio.playDeath());
    const oscs = nodes.filter((n) => n.kind === 'osc');
    expect(oscs).toHaveLength(2);
    const [tone, thud] = oscs;
    expect(tone.type).toBe('triangle');
    const [f0, f1] = sweep(tone);
    expect(Math.abs(f0 / DEATH_TONE_START_HZ - 1)).toBeLessThanOrEqual(0.03 + 1e-9); // nearly the same every time
    expect(Math.abs(f1 / DEATH_TONE_END_HZ - 1)).toBeLessThanOrEqual(0.03 + 1e-9);
    expect(f0 / f1).toBeCloseTo(DEATH_TONE_START_HZ / DEATH_TONE_END_HZ, 6); // it falls two octaves
    expect(f1).toBeLessThan(80);
    expect(thud.startAt - tone.startAt).toBeCloseTo(DEATH_THUD_AT_S, 9);
    expect(sweep(thud)[0]).toBeGreaterThan(sweep(thud)[1]);
    const [knock] = nodes.filter((n) => n.kind === 'noise');
    expect(filterOf(knock).type).toBe('lowpass'); // muffled
    expect(filterOf(knock).frequency.value).toBeLessThan(400);
    expect(knock.startAt).toBeCloseTo(thud.startAt, 9);
  });

  it('playEat: three crunchy ticks — short bandpassed noise bursts about 0.11 s apart', () => {
    const { audio, during } = rig();
    for (let round = 0; round < 10; round++) {
      const nodes = during(() => audio.playEat());
      const ticks = nodes.filter((n) => n.kind === 'noise');
      expect(EAT_TICKS).toBe(3);
      expect(ticks).toHaveLength(3);
      expect(nodes.filter((n) => n.kind === 'osc')).toHaveLength(0);
      for (const t of ticks) {
        expect(filterOf(t).type).toBe('bandpass');
        expect(filterOf(t).frequency.value).toBeGreaterThan(1500);
        expect(t.stopAt - t.startAt).toBeLessThan(0.06);
      }
      const starts = ticks.map((t) => t.startAt);
      for (let i = 1; i < 3; i++) {
        const gap = starts[i] - starts[i - 1];
        expect(gap).toBeGreaterThan(EAT_TICK_GAP_S - 0.021);
        expect(gap).toBeLessThan(EAT_TICK_GAP_S + 0.021);
      }
    }
  });

  it('playDrink: two low gulps, sines whose pitch drops', () => {
    const { audio, during } = rig();
    const nodes = during(() => audio.playDrink());
    expect(DRINK_GULPS).toBe(2);
    expect(nodes.filter((n) => n.kind === 'noise')).toHaveLength(0);
    const gulps = nodes.filter((n) => n.kind === 'osc');
    expect(gulps).toHaveLength(2);
    for (const g of gulps) {
      expect(g.type).toBe('sine');
      const [f0, f1] = sweep(g);
      expect(f1).toBeLessThan(f0);
      expect(f0).toBeLessThanOrEqual(DRINK_GULP_START_HZ * (1 + PITCH_VARIATION) + 1e-9);
      expect(f1).toBeGreaterThanOrEqual(DRINK_GULP_END_HZ * 0.92 * (1 - PITCH_VARIATION) - 1e-9);
      expect(f0).toBeLessThan(500); // low
    }
    expect(gulps[1].startAt - gulps[0].startAt).toBeCloseTo(DRINK_GULP_GAP_S, 9);
  });

  it('playDig: one short tick through the block\'s break lowpass (BREAK_CUTOFF_HZ), quieter than a break', () => {
    const { audio, during } = rig();
    for (const group of [...SOUND_GROUPS, null, undefined, 'no-such-group']) {
      const nodes = during(() => audio.playDig(group, 1));
      const src = sources(nodes);
      expect(src).toHaveLength(1);
      expect(src[0].kind).toBe('noise');
      expect(src[0].stopAt - src[0].startAt).toBeCloseTo(DIG_TICK_DURATION_S, 9);
      const lp = filterOf(src[0]);
      expect(lp.type).toBe('lowpass');
      const cutoff = BREAK_CUTOFF_HZ[typeof group === 'string' && Object.hasOwn(BREAK_CUTOFF_HZ, group) ? group : 'stone'];
      const pitch = src[0].playbackRate.value;
      expect(Math.abs(pitch - 1)).toBeLessThanOrEqual(PITCH_VARIATION + 1e-9);
      expect(lp.frequency.value).toBeCloseTo(Math.min(cutoff * pitch, 4000), 6); // 4000 = the fake's Nyquist
      expect(peakOf(nodes)).toBeCloseTo(DIG_GAIN, 9);
    }
    // At the volumes main uses (0.35 while digging, 0.15 for "cannot"), it is well below a break.
    expect(DIG_GAIN * 0.35).toBeLessThan(BREAK_GAIN / 2);
    expect(peakOf(during(() => audio.playDig('wood', 0.35)))).toBeCloseTo(DIG_GAIN * 0.35, 9);
    expect(peakOf(during(() => audio.playDig('wood', 0.15)))).toBeCloseTo(DIG_GAIN * 0.15, 9);
    // Glass gets no ping on a dig tick (only playBreak rings).
    expect(sources(during(() => audio.playDig('glass', 1)))).toHaveLength(1);
  });

  it('playCraft: a wooden knock and a soft chime', () => {
    const { audio, during } = rig();
    const nodes = during(() => audio.playCraft());
    const [knock] = nodes.filter((n) => n.kind === 'noise');
    expect(filterOf(knock).type).toBe('bandpass');
    expect(filterOf(knock).frequency.value).toBeLessThan(CRAFT_KNOCK_HZ * 1.2);
    const oscs = nodes.filter((n) => n.kind === 'osc');
    const chime = oscs.filter((o) => sweep(o)[0] >= CRAFT_CHIME_HZ - 1e-6);
    expect(chime.length).toBeGreaterThanOrEqual(1);
    for (const c of chime) {
      expect(c.type).toBe('sine');
      expect(c.startAt - knock.startAt).toBeCloseTo(CRAFT_CHIME_AT_S, 9); // after the knock
      const env = c.outputs[0];
      expect(env.gain.peak).toBeLessThan(0.15); // soft
      expect(c.stopAt - c.startAt).toBeGreaterThan(0.3); // it rings a little
    }
    const wood = oscs.filter((o) => sweep(o)[0] < 1000);
    expect(wood).toHaveLength(1);
    expect(sweep(wood[0])[1]).toBeLessThan(sweep(wood[0])[0]);
  });

  it('playToolBreak: a snap — a short noise burst through a high bandpass', () => {
    const { audio, during } = rig();
    const nodes = during(() => audio.playToolBreak());
    expect(nodes.filter((n) => n.kind === 'osc')).toHaveLength(0);
    const bursts = nodes.filter((n) => n.kind === 'noise');
    expect(bursts.length).toBeGreaterThanOrEqual(1);
    for (const b of bursts) {
      const f = filterOf(b);
      expect(f.type).toBe('bandpass');
      expect(f.frequency.value).toBeGreaterThanOrEqual(Math.min(TOOL_BREAK_HZ * (1 - PITCH_VARIATION), 4000) - 1e-6);
      expect(f.Q.value).toBeGreaterThan(1); // narrow: a crack, not a hiss
      expect(b.stopAt - b.startAt).toBeLessThan(0.1);
    }
  });

  it('playSizzle: hissing highpassed noise with a soft attack, and two or three crackle pops', () => {
    const { audio, during } = rig();
    const popCounts = new Set();
    for (let i = 0; i < 40; i++) {
      const nodes = during(() => audio.playSizzle(0.8));
      const noises = nodes.filter((n) => n.kind === 'noise');
      const hiss = noises.filter((n) => filterOf(n).type === 'highpass');
      expect(hiss).toHaveLength(1);
      expect(filterOf(hiss[0]).frequency.value).toBeGreaterThanOrEqual(Math.min(SIZZLE_HIGHPASS_HZ * (1 - PITCH_VARIATION), 4000) - 1e-6);
      expect(hiss[0].outputs[0].outputs[0].gain.events[1][0]).toBe('linear'); // fades in
      const pops = noises.filter((n) => filterOf(n).type === 'lowpass');
      for (const p of pops) {
        expect(filterOf(p).frequency.value).toBeCloseTo(Math.min(CRACKLE_CUTOFF_HZ * p.playbackRate.value, 4000), 6);
        expect(p.startAt).toBeLessThan(hiss[0].stopAt); // within the hiss
      }
      popCounts.add(pops.length);
    }
    expect([...popCounts].sort()).toEqual([2, 3]);
  });

  it('playPick: a leafy rustle — overlapping soft swishes through a bandpass', () => {
    const { audio, during } = rig();
    const nodes = during(() => audio.playPick());
    expect(nodes.filter((n) => n.kind === 'osc')).toHaveLength(0);
    const swishes = nodes.filter((n) => n.kind === 'noise');
    expect(swishes).toHaveLength(PICK_SWISHES);
    for (const s of swishes) {
      const f = filterOf(s);
      expect(f.type).toBe('bandpass');
      expect(f.frequency.value).toBeGreaterThan(PICK_RUSTLE_HZ * 0.8 * (1 - PITCH_VARIATION) - 1e-6);
      expect(s.outputs[0].outputs[0].gain.events[1][0]).toBe('linear'); // soft attack
    }
    // They overlap: each starts before the previous one stops.
    for (let i = 1; i < swishes.length; i++) expect(swishes[i].startAt).toBeLessThan(swishes[i - 1].stopAt);
  });

  it('noise offsets leave room for the whole burst inside the 1 s noise buffer', () => {
    const { audio, during } = rig();
    let bursts = 0;
    for (let i = 0; i < 30; i++) {
      for (const name of NAMES) {
        for (const n of during(() => SOUNDS[name](audio, 1)).filter((x) => x.kind === 'noise')) {
          const dur = n.stopAt - n.startAt;
          expect(n.offset + dur * n.playbackRate.value).toBeLessThanOrEqual(1 + 1e-9);
          bursts++;
        }
      }
    }
    expect(bursts).toBeGreaterThan(30 * 8); // every sound but the drink has noise, none was dropped
  });
});
