// audio.js's recipe engine, the fields it gained for lifelike sounds (CONTRACTS §82; circuitSounds.js describes the
// format): hold, glide, vibrato, the amplitude wobble as a stage of its own, partials, formants, grains, variants, vary,
// stretch, spare, the quiet floor, and loops whose rate moves their filters. Each is checked twice where it matters: the
// node graph the engine builds (on the offline renderer, which keeps every node and every scheduled value) and the
// sound that graph makes.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAudio, MAX_VOICES, MAX_GRAINS, MIN_GRAIN_S, RECIPE_DEFAULT_ATTACK_S, LOOP_SMOOTH_S } from '../../src/audio.js';
import { SOUND_BANK } from '../../src/soundBank.js';
import {
  OfflineContext, measure, bandShare, strongestHz, tremoloOf, pitchOf, burstsOf, renderSound, seededRandom,
} from '../helpers/offlineAudio.js';

function rig(seed = 1) {
  vi.spyOn(Math, 'random').mockImplementation(seededRandom(seed));
  const audio = createAudio({ AudioContextClass: OfflineContext });
  audio.resume();
  const ctx = /** @type {any} */ (OfflineContext.last);
  const master = ctx.nodes.find((n) => n.kind === 'gain');
  /** Play and return the nodes it made. */
  const play = (recipe, volume = 1) => {
    const from = ctx.nodes.length;
    audio.playRecipe(recipe, volume);
    return ctx.nodes.slice(from);
  };
  return { audio, ctx, master, play };
}
const kinds = (nodes, kind) => nodes.filter((n) => n.kind === kind);
/** The voices of some nodes: the sources the engine tracks (the LFOs and partials ride along untracked). */
const voices = (nodes) => nodes.filter((n) => (n.kind === 'osc' || n.kind === 'noise') && typeof n.onended === 'function');
const envelopeOf = (nodes, master) => nodes.filter((n) => n.kind === 'gain' && n.outputs.includes(master));
const events = (param) => param.events.map((e) => [e.type, e.value, e.time]);
const render = (recipe, seconds = 1, seed = 1, volume = 1) => renderSound((a) => a.playRecipe(recipe, volume), { createAudio, seconds, seed });
const one = (layer, extra = {}) => ({ dur: 2, gain: 1, layers: [layer], ...extra });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recipe layers: hold, glide, vibrato (§82)', () => {
  it('hold keeps the layer at its gain between the attack and the decay', () => {
    const { play, master } = rig();
    const nodes = play(one({ type: 'sine', f0: 500, gain: 0.5, attack: 0.01, hold: 0.1, decay: 0.05 }));
    const [env] = envelopeOf(nodes, master);
    const ev = events(env.gain);
    expect(ev[0]).toEqual(['set', 0.001, 0]);
    expect(ev[1][0]).toBe('linear');
    expect(ev[1][1]).toBeCloseTo(0.5, 9);
    expect(ev[1][2]).toBeCloseTo(0.01, 9);
    expect(ev[2]).toEqual(['set', 0.5, 0.11]);
    expect(ev[3][0]).toBe('exp');
    expect(ev[3][2]).toBeCloseTo(0.16, 9);
    expect(voices(nodes)[0].stopAt).toBeCloseTo(0.16, 9);
    // and it sounds held: as loud at 0.1 s as at 0.02 s, gone by 0.16 s
    const x = render(one({ type: 'sine', f0: 500, gain: 0.5, attack: 0.01, hold: 0.1, decay: 0.05 }), 0.3);
    const top = (t) => Math.max(...x.slice(Math.round(t * 44100), Math.round((t + 0.004) * 44100)).map(Math.abs));
    expect(top(0.1) / top(0.02)).toBeCloseTo(1, 1);
    expect(measure(x).silentAfter).toBeLessThanOrEqual(0.161);
    // without a hold nothing changes for an old recipe: floor, attack, decay
    const old = envelopeOf(rig().play(one({ type: 'sine', f0: 500, gain: 0.5, decay: 0.05 })), OfflineContext.last.nodes[1]);
    expect(events(old[0].gain).map((e) => e[0])).toEqual(['set', 'linear', 'exp']);
    expect(events(old[0].gain)[1][2]).toBeCloseTo(RECIPE_DEFAULT_ATTACK_S, 9);
  });

  it('glide is a pitch contour: the frequency reaches each point at its part of the layer, by exponential ramps', () => {
    const layer = { type: 'tri', f0: 300, glide: [[0.25, 600], [0.75, 600], [1, 400]], gain: 0.5, attack: 0.05, hold: 0.85, decay: 0.1 };
    const { play } = rig();
    const [osc] = kinds(play(one(layer)), 'osc');
    expect(osc.type).toBe('triangle');
    expect(events(osc.frequency)).toEqual([['set', 300, 0], ['exp', 600, 0.25], ['exp', 600, 0.75], ['exp', 400, 1]]);
    const x = render(one(layer), 1.2);
    expect(pitchOf(x, 0.1, 100, 1000)).toBeGreaterThan(330);
    expect(pitchOf(x, 0.1, 100, 1000)).toBeLessThan(480);
    expect(pitchOf(x, 0.5, 100, 1000)).toBeCloseTo(600, -1);
    expect(pitchOf(x, 0.9, 100, 1000)).toBeLessThan(540);
    // f1 is ignored beside a glide; a bad point is skipped
    const [o2] = kinds(rig().play(one({ ...layer, f1: 50, glide: [[0.5, 0], [1, 500]] })), 'osc');
    expect(events(o2.frequency)).toEqual([['set', 300, 0], ['exp', 500, 1]]);
  });

  it('vibrato is an LFO on the oscillators\' detune, in cents, so the swing is a share of the pitch', () => {
    const layer = { type: 'sine', f0: 400, vibHz: 6, vibDepth: 0.05, gain: 0.5, attack: 0.01, hold: 0.9, decay: 0.05 };
    const { play } = rig();
    const nodes = play(one(layer));
    const oscs = kinds(nodes, 'osc');
    expect(oscs).toHaveLength(2);
    const lfo = oscs.find((o) => o.frequency.value === 6);
    const main = oscs.find((o) => o !== lfo);
    expect(lfo.type).toBe('sine');
    const cents = lfo.outputs[0];
    expect(cents.gain.value).toBeCloseTo(1200 * Math.log2(1.05), 9);
    expect(cents.outputs).toEqual([main.detune]);
    expect(lfo.stopAt).toBeCloseTo(main.stopAt, 9);
    expect(voices(nodes)).toEqual([main]); // the LFO rides along: one voice
    const x = render(one(layer), 1.1);
    const crest = pitchOf(x, 1 / 24 - 0.008, 200, 800, 0.016); // a quarter of the LFO's period in
    const trough = pitchOf(x, 3 / 24 - 0.008, 200, 800, 0.016);
    expect(crest / 400).toBeGreaterThan(1.03);
    expect(trough / 400).toBeLessThan(0.97);
    // a square vibrato alternates between two notes
    const [sq] = kinds(rig().play(one({ ...layer, vibShape: 'square' })), 'osc').filter((o) => o.frequency.value === 6);
    expect(sq.type).toBe('square');
    // a noise layer has no pitch to swing
    expect(kinds(rig().play(one({ type: 'noise', f0: 0, bp: 900, gain: 0.5, decay: 0.1, vibHz: 6, vibDepth: 0.05 })), 'osc')).toHaveLength(0);
  });
});

describe('recipe layers: the amplitude wobble (§82)', () => {
  const bleat = { type: 'saw', f0: 430, lp: 1500, gain: 0.6, attack: 0.04, decay: 0.48, lfoHz: 13, lfoDepth: 0.55 };

  it('is a gain stage of its own in front of the envelope: it swings by ±lfoDepth/2 of the level and dies away with it', () => {
    const { play, master } = rig();
    const nodes = play(one(bleat));
    const [env] = envelopeOf(nodes, master);
    const wobble = nodes.find((n) => n.kind === 'gain' && n.outputs.includes(env));
    expect(wobble.gain.value).toBe(1);
    const lfo = kinds(nodes, 'osc').find((o) => o.frequency.value === 13);
    expect(lfo.outputs[0].gain.value).toBeCloseTo(0.55 / 2, 9);
    expect(lfo.outputs[0].outputs).toEqual([wobble.gain]);
    expect(env.gain.inputs).toHaveLength(0); // nothing is added to the envelope itself any more
    const x = render(one(bleat), 0.8);
    const m = measure(x);
    expect(m.tail, 'the old additive wobble left the sound a quarter loud at its end: a click').toBeLessThan(0.02);
    const tr = tremoloOf(render(one({ ...bleat, hold: 0.6 }), 1.3), 6, 20); // held, so the swing is easy to read
    expect(tr.hz).toBeCloseTo(13, 0);
    expect(tr.depth).toBeCloseTo(0.55 / 2, 1);
  });

  it('lfoShape picks the wave; at depth 2 a square wobble gates the sound into pulses', () => {
    const layer = { type: 'sine', f0: 3000, gain: 0.4, attack: 0.005, hold: 0.19, decay: 0.01, lfoHz: 20, lfoDepth: 2, lfoShape: 'square' };
    const { play } = rig();
    expect(kinds(play(one(layer)), 'osc').find((o) => o.frequency.value === 20).type).toBe('square');
    expect(burstsOf(render(one(layer), 0.3), 0.3)).toHaveLength(4); // 0.2 s at 20 Hz: on, off, on, off …
    expect(kinds(rig().play(one({ ...layer, lfoShape: 'tri' })), 'osc').find((o) => o.frequency.value === 20).type).toBe('triangle');
    expect(kinds(rig().play(one({ ...layer, lfoShape: 'saw' })), 'osc').find((o) => o.frequency.value === 20).type).toBe('sawtooth');
    // depth is capped at 2: the gain never goes negative
    const deep = kinds(rig().play(one({ ...layer, lfoDepth: 9 })), 'osc').find((o) => o.frequency.value === 20);
    expect(deep.outputs[0].gain.value).toBe(1);
  });
});

describe('recipe layers: partials and formants (§82)', () => {
  it('partials are more sines at ratio × the layer\'s frequency, each with its gain; one with a fade dies away early', () => {
    const layer = { type: 'sine', f0: 1000, f1: 900, partials: [[1.5, 0.5], [2.5, 0.4, 0.25]], gain: 0.5, attack: 0.002, decay: 0.4 };
    const { play, master } = rig();
    const nodes = play(one(layer));
    const oscs = kinds(nodes, 'osc');
    expect(oscs).toHaveLength(3);
    expect(oscs.map((o) => events(o.frequency)[0][1])).toEqual([1000, 1500, 2500]);
    expect(oscs.map((o) => events(o.frequency)[1][1])).toEqual([900, 1350, 2250]); // they follow the sweep
    expect(oscs.every((o) => o.type === 'sine')).toBe(true);
    expect(voices(nodes)).toHaveLength(1);
    const [env] = envelopeOf(nodes, master);
    expect(oscs[0].outputs).toEqual([env]);
    const steady = oscs[1].outputs[0];
    expect(steady.gain.value).toBe(0.5);
    expect(steady.gain.events).toHaveLength(0);
    const fading = oscs[2].outputs[0];
    expect(events(fading.gain)[0]).toEqual(['set', 0.4, 0]);
    expect(events(fading.gain)[1][0]).toBe('exp');
    expect(events(fading.gain)[1][2]).toBeCloseTo(0.402 * 0.25, 9);
    for (const o of oscs) expect(o.stopAt).toBeCloseTo(0.402, 9);
    // heard: three peaks; the fading one is gone from the tail
    const x = render(one(layer), 0.6);
    const early = measure(x.slice(0, Math.round(0.02 * 44100)));
    const late = measure(x.slice(Math.round(0.15 * 44100), Math.round(0.3 * 44100)));
    expect(bandShare(early, 2200, 2700)).toBeGreaterThan(0.02);
    expect(bandShare(late, 2100, 2700)).toBeLessThan(0.002);
    expect(bandShare(late, 1250, 1500)).toBeGreaterThan(0.1);
    // bad partials are skipped
    expect(kinds(rig().play(one({ ...layer, partials: [[0, 1], [2, 0], 'x'] })), 'osc')).toHaveLength(1);
  });

  it('formants are band-passes side by side, each with its gain, added together, between hp and lp', () => {
    const layer = { type: 'saw', f0: 100, hp: 60, formants: [[300, 5, 1.5], [[900, 1200], 6, 0.8]], lp: 3000, gain: 0.5, attack: 0.01, hold: 0.5, decay: 0.1 };
    const { play, master } = rig();
    const nodes = play(one(layer));
    const filters = kinds(nodes, 'filter');
    expect(filters.map((f) => f.type)).toEqual(['highpass', 'bandpass', 'bandpass', 'lowpass']);
    const [hp, f1, f2, lp] = filters;
    expect(hp.outputs.sort()).toEqual([f1, f2].sort()); // side by side
    expect(f1.Q.value).toBe(5);
    expect(f2.Q.value).toBe(6);
    expect(events(f2.frequency)).toEqual([['set', 900, 0], ['exp', 1200, 0.61]]); // a formant can move
    const g1 = f1.outputs[0];
    const g2 = f2.outputs[0];
    expect([g1.gain.value, g2.gain.value]).toEqual([1.5, 0.8]);
    expect(g1.outputs).toEqual([lp]);
    expect(g2.outputs).toEqual([lp]);
    expect(lp.outputs).toEqual(envelopeOf(nodes, master));
    // heard: the energy sits at the formants, not at the fundamental
    const m = measure(render(one({ ...layer, formants: [[300, 5, 1.5], [900, 6, 0.8]] }), 0.8));
    expect(bandShare(m, 230, 380)).toBeGreaterThan(0.5);
    expect(bandShare(m, 780, 1020)).toBeGreaterThan(0.02);
    expect(bandShare(m, 60, 160)).toBeLessThan(0.1);
    expect(pitchOf(render(one(layer), 0.8), 0.3, 50, 200)).toBeCloseTo(100, -1); // the voice keeps its pitch
  });
});

describe('recipe layers: grains (§82)', () => {
  const click = { type: 'noise', f0: 0, bp: 2000, q: 2, gain: 0.8, attack: 0.001, decay: 0.01 };

  it('strike a layer several times inside ONE voice: scattered at random, each with its gain and pitch', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { play, master } = rig(seed);
      const nodes = play(one({ ...click, delay: 0.05, grains: { count: [4, 7], over: 0.2, gainVar: 0.5, pitchVar: 0.3 } }));
      expect(voices(nodes), `seed ${seed}`).toHaveLength(1);
      const [env] = envelopeOf(nodes, master);
      const tops = events(env.gain).filter((e) => e[0] === 'linear');
      expect(tops.length).toBeGreaterThanOrEqual(4);
      expect(tops.length).toBeLessThanOrEqual(7);
      for (const [, v, t] of tops) {
        expect(v).toBeGreaterThanOrEqual(0.8 * 0.5 - 1e-9);
        expect(v).toBeLessThanOrEqual(0.8 + 1e-9);
        expect(t).toBeGreaterThanOrEqual(0.05);
        expect(t).toBeLessThanOrEqual(0.05 + 0.2 + 0.001 + 1e-9);
      }
      const src = voices(nodes)[0];
      expect(src.stopAt).toBeLessThanOrEqual(0.05 + 0.2 + 0.011 + 1e-9); // delay + over + one strike
      const [bp] = kinds(nodes, 'filter');
      const sets = events(bp.frequency).filter((e) => e[0] === 'set');
      expect(sets).toHaveLength(tops.length);
      for (const [, hz] of sets) {
        expect(hz).toBeGreaterThanOrEqual(2000 * 0.7 - 1e-6);
        expect(hz).toBeLessThanOrEqual(2000 * 1.3 + 1e-6);
      }
      // strikes are in time order, never closer than MIN_GRAIN_S, and each ends where the next begins at the latest
      const starts = events(env.gain).filter((e) => e[0] === 'set').map((e) => e[2]);
      const ends = events(env.gain).filter((e) => e[0] === 'exp').map((e) => e[2]);
      for (let i = 1; i < starts.length; i++) {
        expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(MIN_GRAIN_S - 1e-9);
        expect(ends[i - 1]).toBeLessThanOrEqual(starts[i] + 1e-9);
      }
    }
  });

  it('a list of grains strikes at fixed times with fixed pitch and gain (a bird\'s notes)', () => {
    const notes = [[0, 1, 1], [0.2, 0.75, 0.5], [0.4, 1.5, 0.8]];
    const layer = { type: 'sine', f0: 2000, f1: 2200, gain: 0.5, attack: 0.01, hold: 0.04, decay: 0.05, grains: notes };
    const { play, master } = rig();
    const nodes = play(one(layer));
    expect(voices(nodes)).toHaveLength(1);
    const [osc] = kinds(nodes, 'osc');
    expect(events(osc.frequency).map((e) => [e[0], Math.round(e[1]), Math.round(e[2] * 1000)])).toEqual([
      ['set', 2000, 0], ['exp', 2200, 100], ['set', 1500, 200], ['exp', 1650, 300], ['set', 3000, 400], ['exp', 3300, 500],
    ]);
    const [env] = envelopeOf(nodes, master);
    expect(events(env.gain).filter((e) => e[0] === 'linear').map((e) => e[1])).toEqual([0.5, 0.25, 0.4]);
    const x = render(one(layer), 0.7);
    const starts = burstsOf(x, 0.2);
    expect(starts).toHaveLength(3);
    expect(starts[1]).toBeCloseTo(0.2, 2);
    expect(pitchOf(x, 0.23, 500, 5000, 0.03)).toBeGreaterThan(1500);
    expect(pitchOf(x, 0.23, 500, 5000, 0.03)).toBeLessThan(1660);
    expect(pitchOf(x, 0.43, 500, 5000, 0.03)).toBeGreaterThan(3000);
  });

  it('the count is capped at MAX_GRAINS, a strike cut short keeps its shape, and nothing clicks', () => {
    const { play, master } = rig(3);
    const nodes = play(one({ ...click, grains: { count: 500, over: 1, jitter: 0 } }));
    const [env] = envelopeOf(nodes, master);
    expect(events(env.gain).filter((e) => e[0] === 'linear')).toHaveLength(MAX_GRAINS);
    // evenly spaced (jitter 0), 0.05 s apart: exactly the count of bursts is heard
    const x = render(one({ ...click, grains: { count: 6, over: 0.3, jitter: 0 } }), 0.5);
    expect(burstsOf(x, 0.25)).toHaveLength(6);
    expect(measure(x).tail).toBeLessThan(0.02);
    // grains longer than their share of the time are squeezed, not overlapped: the envelope is back at the floor each time
    const long = rig(4).play(one({ type: 'sine', f0: 800, gain: 0.5, attack: 0.02, decay: 0.2, grains: { count: 4, over: 0.2, jitter: 0 } }));
    const ev = events(envelopeOf(long, OfflineContext.last.nodes[1])[0].gain);
    const ramps = ev.filter((e) => e[0] === 'linear');
    expect(ramps[0][2]).toBeCloseTo(0.02 * (0.05 / 0.22), 6); // the attack, squeezed with the strike
    expect(ev.filter((e) => e[0] === 'exp').slice(0, 3).map((e) => Math.round(e[2] * 1000))).toEqual([50, 100, 150]);
  });
});

describe('recipes: variants, vary, stretch, spare (§82)', () => {
  const tone = (f0) => ({ dur: 0.2, gain: 0.5, layers: [{ type: 'sine', f0, gain: 1, decay: 0.1 }] });
  const three = { dur: 0.2, gain: 0.5, variants: [tone(100), tone(200), tone(300)] };
  const firstHz = (nodes) => events(kinds(nodes, 'osc')[0].frequency)[0][1];

  it('variants: each play is one of them, never the one played last; the parent\'s gain multiplies', () => {
    const { play: playNow, master, ctx } = rig(8);
    const play = (recipe) => {
      const nodes = playNow(recipe);
      ctx.render(0.2); // let its voices end, so sixty plays never run out of them
      return nodes;
    };
    const seen = [];
    for (let i = 0; i < 60; i++) seen.push(firstHz(play(three)));
    expect(new Set(seen)).toEqual(new Set([100, 200, 300]));
    for (let i = 1; i < seen.length; i++) expect(seen[i], `play ${i}`).not.toBe(seen[i - 1]);
    const nodes = playNow(three);
    expect(envelopeOf(nodes, master)[0].gain.events.find((e) => e.type === 'linear').value).toBeCloseTo(0.25, 9);
    ctx.render(0.2);
    // two recipes keep their own "last": playing one does not disturb the other
    const other = { dur: 0.2, gain: 1, variants: [tone(1000), tone(2000)] };
    const alt = [];
    for (let i = 0; i < 10; i++) {
      alt.push(firstHz(play(other)));
      play(three);
    }
    for (let i = 1; i < alt.length; i++) expect(alt[i]).not.toBe(alt[i - 1]); // with two, they alternate
    // a single variant just plays; a broken one is skipped without a throw
    expect(firstHz(play({ dur: 0.2, gain: 1, variants: [tone(440)] }))).toBe(440);
    expect(play({ dur: 0.2, gain: 1, variants: [null, 'x'] })).toEqual([]);
    expect(play({ dur: 0.2, gain: 1, variants: 'x' })).toEqual([]);
  });

  it('vary pitches a whole play by one random factor within ±vary: oscillators and filters alike', () => {
    const recipe = { dur: 0.3, gain: 1, vary: 0.1, layers: [
      { type: 'sine', f0: 1000, gain: 0.5, decay: 0.1 },
      { type: 'noise', f0: 0, bp: 2000, lp: [4000, 3000], gain: 0.5, decay: 0.1 },
    ] };
    const factors = [];
    for (let seed = 1; seed <= 30; seed++) {
      const nodes = rig(seed).play(recipe);
      const k = firstHz(nodes) / 1000;
      factors.push(k);
      expect(k).toBeGreaterThanOrEqual(0.9);
      expect(k).toBeLessThanOrEqual(1.1);
      const [bp, lp] = kinds(nodes, 'filter');
      expect(events(bp.frequency)[0][1] / 2000).toBeCloseTo(k, 9);
      expect(events(lp.frequency)[1][1] / 3000).toBeCloseTo(k, 9);
      expect(kinds(nodes, 'noise')[0].playbackRate.value).toBe(1); // the noise itself is not re-pitched
    }
    expect(Math.max(...factors) - Math.min(...factors)).toBeGreaterThan(0.1);
    expect(firstHz(rig().play({ ...recipe, vary: undefined }))).toBe(1000); // no vary: as written
    // a variant takes its parent's vary unless it has its own
    const k = firstHz(rig(2).play({ dur: 0.3, gain: 1, vary: 0.2, variants: [tone(500), tone(500)] })) / 500;
    expect(k).not.toBe(1);
    expect(Math.abs(k - 1)).toBeLessThanOrEqual(0.2);
  });

  it('stretch scales every time of a play by one random factor within ±stretch', () => {
    const recipe = { dur: 0.7, gain: 1, stretch: 0.15, layers: [
      { type: 'sine', f0: 500, gain: 0.5, delay: 0.1, attack: 0.02, hold: 0.1, decay: 0.2 },
      { type: 'sine', f0: 700, gain: 0.5, attack: 0.02, decay: 0.3, grains: [[0, 1, 1], [0.2, 1, 1]] },
    ] };
    const factors = [];
    for (let seed = 1; seed <= 30; seed++) {
      const nodes = rig(seed).play(recipe);
      const [a, b] = voices(nodes);
      const k = a.startAt / 0.1;
      factors.push(k);
      expect(k).toBeGreaterThanOrEqual(0.85);
      expect(k).toBeLessThanOrEqual(1.15);
      expect((a.stopAt - a.startAt) / 0.32).toBeCloseTo(k, 9);
      expect(b.stopAt / 0.52).toBeCloseTo(k, 9); // the grains' times too
      expect(Math.max(a.stopAt, b.stopAt)).toBeLessThanOrEqual(0.7); // never past dur, which allows for the stretch
    }
    expect(Math.max(...factors) - Math.min(...factors)).toBeGreaterThan(0.15);
  });

  it('spare: a sound of little weight is not played at all unless that many voices stay free', () => {
    const step = SOUND_BANK.stepStone;
    expect(step.spare).toBe(12);
    const { play, ctx, audio } = rig();
    const busy = (n) => {
      for (const s of ctx.live) if (typeof s.onended === 'function') s.onended();
      for (let i = 0; i < n; i++) audio.playRecipe('relayClick');
    };
    busy(MAX_VOICES - 12 - step.layers.length);
    expect(voices(play('stepStone'))).toHaveLength(step.layers.length); // just fits
    busy(MAX_VOICES - 12 - step.layers.length + 1);
    expect(play('stepStone')).toEqual([]); // one voice short: not half a step, none
    expect(voices(play('breakStone')).length).toBeGreaterThan(0); // what matters still plays
    busy(MAX_VOICES - 1);
    expect(voices(play('breakStone'))).toHaveLength(1); // a sound without `spare` takes what is left
    expect(play('stepGrass')).toEqual([]);
  });

  it('`running` says whether a sound played now would be heard', () => {
    const cold = createAudio({ AudioContextClass: OfflineContext });
    expect(cold.running).toBe(false);
    expect(cold.available).toBe(false);
    cold.resume();
    expect(cold.available).toBe(true);
    expect(cold.running).toBe(true);
    OfflineContext.last.state = 'suspended'; // a browser before the first gesture
    expect(cold.running).toBe(false);
    expect(createAudio({ AudioContextClass: undefined }).running).toBe(false);
  });

  it('bank names and recipe objects both play; unknown names and broken recipes do nothing', () => {
    const { play, audio } = rig();
    expect(voices(play('cowMoo')).length).toBe(2);
    expect(voices(play(SOUND_BANK.cowMoo)).length).toBe(2);
    expect(voices(play('bellRing')).length).toBe(4); // the circuit sounds as before
    for (const bad of ['noSuchSound', null, undefined, 7, {}, { layers: 'x' }, { variants: [] }]) expect(play(bad), String(bad)).toEqual([]);
    expect(play('cowMoo', 0)).toEqual([]);
    audio.setMuted(true);
    expect(play('cowMoo')).toEqual([]);
  });
});

describe('recipes: levels and endings (§82)', () => {
  it('a quiet layer decays to a hundredth of its own peak; a loud one to the old floor', () => {
    const { play, master } = rig();
    const loud = envelopeOf(play(one({ type: 'sine', f0: 500, gain: 0.5, decay: 0.1 })), master)[0];
    expect(events(loud.gain)[0][1]).toBe(0.001);
    expect(events(loud.gain).at(-1)[1]).toBe(0.001);
    const quiet = envelopeOf(play(one({ type: 'sine', f0: 500, gain: 0.02, decay: 0.1 })), master)[0];
    expect(events(quiet.gain)[0][1]).toBeCloseTo(0.0002, 9);
    expect(events(quiet.gain).at(-1)[1]).toBeCloseTo(0.0002, 9);
    expect(measure(render(one({ type: 'sine', f0: 500, gain: 0.02, decay: 0.1 }), 0.2)).tail).toBeLessThan(0.02);
  });

  it('every voice of a recipe ends, tears its nodes down and frees its slot', () => {
    const { play, ctx } = rig();
    const nodes = play('horseNeigh');
    play('breakGlass');
    play('pheasantCrow');
    expect(ctx.live.length).toBeGreaterThan(5);
    ctx.render(2);
    expect(ctx.live).toHaveLength(0);
    for (const n of nodes) expect(n.disconnected, n.kind).toBe(true);
    for (let i = 0; i < MAX_VOICES; i++) play('relayClick');
    expect(voices(ctx.nodes.slice(-200)).filter((s) => !s._ended)).toHaveLength(MAX_VOICES); // all 32 slots were free again
  });

  it('never throws out of a broken graph, whatever the recipe uses', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const broken of ['createGain', 'createBiquadFilter', 'createOscillator', 'createBufferSource']) {
      const { audio, ctx } = rig();
      ctx[broken] = () => {
        throw new Error('no node today');
      };
      for (const name of ['cowMoo', 'breakGlass', 'birdTit', 'stepGravel', 'wolfHowl']) expect(() => audio.playRecipe(name), `${broken} ${name}`).not.toThrow();
      expect(() => audio.startLoop('ambWind').set(1, 1)).not.toThrow();
      expect(() => audio.playBreak('stone')).not.toThrow();
      expect(() => audio.playGroan(1)).not.toThrow();
    }
    expect(warn).toHaveBeenCalled();
  });
});

describe('loops (§82)', () => {
  it('the rate of set() moves a loop\'s filters with its oscillators and its noise', () => {
    const { audio, ctx } = rig();
    const from = ctx.nodes.length;
    const h = audio.startLoop({ dur: 1, gain: 0.5, layers: [
      { type: 'noise', f0: 0, bp: 400, lp: [900, 100], gain: 1, decay: 1 },
      { type: 'sine', f0: 200, partials: [[2, 0.5, 0.3]], gain: 0.5, decay: 1, lfoHz: 0.5, lfoDepth: 0.4, lfoShape: 'tri' },
    ] });
    h.set(0.5, 1);
    const nodes = ctx.nodes.slice(from);
    const [bp, lp] = kinds(nodes, 'filter');
    expect(events(bp.frequency)[0]).toEqual(['set', 400, 0]);
    expect(events(lp.frequency)[0]).toEqual(['set', 900, 0]); // a loop holds a sweep at its start
    h.set(0.5, 1.25);
    const last = (p) => p.events.at(-1);
    expect(last(bp.frequency).type).toBe('target');
    expect(last(bp.frequency).value).toBeCloseTo(500, 9);
    expect(last(bp.frequency).tc).toBe(LOOP_SMOOTH_S);
    expect(last(lp.frequency).value).toBeCloseTo(1125, 9);
    const oscs = kinds(nodes, 'osc').filter((o) => o.frequency.events.length && o.frequency.events[0].type === 'set');
    expect(oscs.map((o) => last(o.frequency).value)).toEqual([250, 500]); // the partial too; its fade does nothing here
    expect(kinds(nodes, 'noise')[0].playbackRate.events.at(-1).value).toBe(1.25);
    expect(kinds(nodes, 'osc').find((o) => o.frequency.value === 0.5).type).toBe('triangle');
    // one voice while it sounds; set(0) stops every source
    expect(ctx.live.length).toBe(4);
    h.set(0);
    ctx.render(0.2);
    expect(ctx.live).toHaveLength(0);
  });

  it('a bank loop plays by name; a recipe of variants or an unknown name gives a handle that does nothing', () => {
    const { audio, ctx } = rig();
    const n = ctx.nodes.length;
    audio.startLoop('pigOink').set(1);
    audio.startLoop('nope').set(1);
    expect(ctx.nodes.length).toBe(n);
    const wind = audio.startLoop('ambWind');
    wind.set(1, 1);
    expect(kinds(ctx.nodes.slice(n), 'noise')).toHaveLength(SOUND_BANK.ambWind.layers.length);
    const x = ctx.render(1);
    expect(measure(x).peak).toBeGreaterThan(0.005);
    expect(strongestHz(measure(x), 20, 20000)).toBeLessThan(1200);
    wind.stop();
    expect(() => wind.stop()).not.toThrow();
    ctx.render(0.3);
    expect(measure(ctx.render(0.2)).peak).toBe(0); // it faded and stopped: no click, nothing left
  });
});
