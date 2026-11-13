// tests/helpers/offlineAudio.js — the offline renderer the sound tests stand on (CONTRACTS §82). Nobody could listen to
// the sounds, so they are judged by what this renders and measures; these tests check the renderer itself against what
// the Web Audio API specifies and against signals whose numbers are known.
import { describe, it, expect } from 'vitest';
import {
  OfflineContext, measure, aWeight, bandShare, strongestHz, tremoloOf, pitchOf, burstsOf, seededRandom, renderSound,
} from '../helpers/offlineAudio.js';
import { createAudio, MASTER_GAIN } from '../../src/audio.js';

const RATE = OfflineContext.sampleRate;
const rmsOf = (x, from = 0, to = x.length) => {
  let sq = 0;
  for (let i = from; i < to; i++) sq += x[i] * x[i];
  return Math.sqrt(sq / (to - from));
};
/** A context with one oscillator → (chain) → destination; returns what `seconds` of it renders to. */
function tone(hz, seconds, build) {
  const c = new OfflineContext();
  const osc = c.createOscillator();
  osc.frequency.value = hz;
  osc.start(0);
  const last = build ? build(c, osc) : osc;
  last.connect(c.destination);
  return { c, osc, x: c.render(seconds) };
}

describe('offline renderer: sources', () => {
  it('a sine has the amplitude, RMS and frequency it was given', () => {
    const { x } = tone(1000, 0.5, (c, osc) => {
      const g = c.createGain();
      g.gain.value = 0.5;
      osc.connect(g);
      return g;
    });
    const m = measure(x);
    expect(m.peak).toBeCloseTo(0.5, 2);
    expect(m.rms).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(Math.abs(strongestHz(m, 20, 20000) - 1000)).toBeLessThan(m.binHz);
    expect(Math.abs(m.centroid - 1000)).toBeLessThan(30);
    expect(m.loud).toBeCloseTo(-6.02, 0); // 0 dB is a full-scale 1 kHz sine; this one is half that
    expect(m.dc).toBeLessThan(0.01);
    expect(pitchOf(x, 0.1, 200, 4000)).toBeCloseTo(1000, -1);
  });

  it('sawtooth, square and triangle have their shapes\' RMS (band-limited: no aliasing below the fundamental)', () => {
    for (const [type, rms] of [['sawtooth', 1 / Math.sqrt(3)], ['square', 1], ['triangle', 1 / Math.sqrt(3)]]) {
      const c = new OfflineContext();
      const osc = c.createOscillator();
      osc.type = type;
      osc.frequency.value = 441;
      osc.connect(c.destination);
      osc.start(0);
      const x = c.render(0.5);
      expect(Math.abs(rmsOf(x) - rms) / rms, type).toBeLessThan(0.04);
      const m = measure(x);
      expect(bandShare(m, 0, 380), type).toBeLessThan(0.005); // nothing folded back under 441 Hz
      expect(Math.abs(strongestHz(m, 20, 20000) - 441)).toBeLessThan(m.binHz);
    }
  });

  it('starts and stops on the sample, is silent outside, and fires onended once after its stop', () => {
    const c = new OfflineContext();
    const osc = c.createOscillator();
    osc.frequency.value = 500;
    osc.connect(c.destination);
    let ended = 0;
    osc.onended = () => ended++;
    osc.start(0.1);
    osc.stop(0.2);
    const x = c.render(0.15);
    expect(ended).toBe(0);
    expect(c.live).toHaveLength(1);
    const y = c.render(0.15);
    expect(ended).toBe(1);
    expect(c.live).toHaveLength(0);
    const all = Float32Array.from([...x, ...y]);
    const first = all.findIndex((v) => v !== 0);
    let last = all.length - 1;
    while (all[last] === 0) last--;
    expect(Math.abs(first / RATE - 0.1)).toBeLessThan(2 / RATE);
    expect(Math.abs(last / RATE - 0.2)).toBeLessThan(2 / RATE);
    expect(c.currentTime).toBeCloseTo(0.3, 2);
  });

  it('detune is in cents: +1200 doubles the pitch; a node connected to it is a vibrato', () => {
    const c = new OfflineContext();
    const osc = c.createOscillator();
    osc.frequency.value = 440;
    osc.detune.value = 1200;
    osc.connect(c.destination);
    osc.start(0);
    expect(pitchOf(c.render(0.3), 0.1, 200, 2000)).toBeCloseTo(880, -1);
    // a 5 Hz LFO of ±100 cents: the pitch swings between 440 / 1.0595 and 440 × 1.0595
    const d = new OfflineContext();
    const o = d.createOscillator();
    o.frequency.value = 440;
    const lfo = d.createOscillator();
    lfo.frequency.value = 5;
    const cents = d.createGain();
    cents.gain.value = 100;
    lfo.connect(cents);
    cents.connect(o.detune);
    o.connect(d.destination);
    o.start(0);
    lfo.start(0);
    const x = d.render(0.4);
    const up = pitchOf(x, 0.05 - 0.01, 300, 600, 0.02); // the LFO's crest is at 0.05 s
    const down = pitchOf(x, 0.15 - 0.01, 300, 600, 0.02);
    expect(up / 440).toBeCloseTo(2 ** (100 / 1200), 1);
    expect(down / 440).toBeCloseTo(2 ** (-100 / 1200), 1);
  });

  it('a buffer source plays its buffer from an offset, at its rate, and loops', () => {
    const c = new OfflineContext();
    const buffer = c.createBuffer(1, 100, RATE);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < 100; i++) data[i] = i / 100;
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(c.destination);
    src.start(0, 10 / RATE);
    const x = c.render(0.01);
    expect(x[0]).toBeCloseTo(0.1, 6);
    expect(x[50]).toBeCloseTo(0.6, 6);
    expect(x[90]).toBeCloseTo(0, 6); // wrapped
    expect(x[95]).toBeCloseTo(0.05, 6);
    const once = c.createBufferSource();
    once.buffer = buffer;
    once.playbackRate.value = 2;
    once.connect(c.destination);
    let ended = false;
    once.onended = () => {
      ended = true;
    };
    src.disconnect();
    once.start(c.currentTime);
    const y = c.render(0.01);
    expect(y[10]).toBeCloseTo(0.2, 6); // twice as fast
    expect(y[60]).toBe(0); // ran off the end
    expect(ended).toBe(true);
  });
});

describe('offline renderer: parameter automation', () => {
  it('setValueAtTime, linear and exponential ramps, and setTargetAtTime follow the specification', () => {
    const c = new OfflineContext();
    const g = c.createGain();
    const p = g.gain;
    p.setValueAtTime(0.001, 1);
    p.linearRampToValueAtTime(1, 2);
    p.setValueAtTime(1, 2.5);
    p.exponentialRampToValueAtTime(0.01, 3.5);
    expect(p.valueAt(0.5)).toBe(1); // the default until the first event
    expect(p.valueAt(1)).toBeCloseTo(0.001, 9);
    expect(p.valueAt(1.5)).toBeCloseTo(0.5005, 9);
    expect(p.valueAt(2.2)).toBe(1);
    expect(p.valueAt(3)).toBeCloseTo(0.1, 9); // half way down two decades
    expect(p.valueAt(4)).toBeCloseTo(0.01, 9);
    p.setTargetAtTime(0, 5, 0.5);
    expect(p.valueAt(5.5)).toBeCloseTo(0.01 * Math.exp(-1), 9);
    p.cancelScheduledValues(2.4);
    expect(p.valueAt(6)).toBe(1);
    expect(() => p.exponentialRampToValueAtTime(0, 7)).toThrow(RangeError);
    expect(() => p.setTargetAtTime(1, 7, -1)).toThrow(RangeError);
  });

  it('a ramp scheduled first starts from the value at the time of the call', () => {
    const c = new OfflineContext();
    const g = c.createGain();
    g.gain.value = 0.2;
    g.gain.linearRampToValueAtTime(1, 1);
    expect(g.gain.valueAt(0.5)).toBeCloseTo(0.6, 9);
  });

  it('a gain follows its automation sample by sample, and a node connected to it adds to it (a tremolo)', () => {
    const { x } = tone(2000, 0.2, (c, osc) => {
      const g = c.createGain();
      g.gain.setValueAtTime(1, 0);
      g.gain.exponentialRampToValueAtTime(0.001, 0.1);
      osc.connect(g);
      return g;
    });
    const at = (t) => rmsOf(x, Math.round(t * RATE), Math.round((t + 0.002) * RATE)) * Math.SQRT2;
    expect(at(0.05)).toBeCloseTo(Math.sqrt(0.001), 2); // −30 dB half way
    expect(at(0.12)).toBeCloseTo(0.001, 3); // holds the last value
    const t = tone(2000, 1, (c, osc) => {
      const g = c.createGain();
      g.gain.value = 1;
      const lfo = c.createOscillator();
      lfo.frequency.value = 8;
      const depth = c.createGain();
      depth.gain.value = 0.6;
      lfo.connect(depth);
      depth.connect(g.gain);
      lfo.start(0);
      osc.connect(g);
      return g;
    });
    const tr = tremoloOf(t.x, 4, 16);
    expect(tr.hz).toBeCloseTo(8, 0);
    expect(tr.depth).toBeCloseTo(0.6, 1);
  });
});

describe('offline renderer: biquad filters (Web Audio "Filters characteristics")', () => {
  /** The level a sine of `hz` comes out at through one filter. */
  const through = (type, fc, q, hz) => {
    const { x } = tone(hz, 0.4, (c, osc) => {
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.value = fc;
      f.Q.value = q;
      osc.connect(f);
      return f;
    });
    return rmsOf(x, Math.round(0.2 * RATE)) * Math.SQRT2;
  };
  const analog = (r, q) => 1 / Math.sqrt((1 - r * r) ** 2 + (r / q) ** 2);

  it('lowpass: Q is in decibels; flat below, 12 dB an octave above', () => {
    expect(through('lowpass', 500, 0, 50)).toBeCloseTo(1, 1);
    expect(through('lowpass', 500, 0, 500)).toBeCloseTo(1, 1); // |H(f0)| = 10^(Q/20) = 1
    expect(through('lowpass', 500, 6, 500)).toBeCloseTo(10 ** (6 / 20), 1);
    expect(through('lowpass', 500, 0, 2000) / analog(4, 1)).toBeCloseTo(1, 1);
    expect(through('lowpass', 500, 0, 4000)).toBeLessThan(0.02);
  });

  it('highpass: the mirror image', () => {
    expect(through('highpass', 2000, 0, 8000)).toBeCloseTo(1, 1);
    expect(through('highpass', 2000, 0, 2000)).toBeCloseTo(1, 1);
    expect(through('highpass', 2000, 0, 500) / (analog(4, 1) / 1)).toBeCloseTo(1, 1);
    expect(through('highpass', 2000, 0, 125)).toBeLessThan(0.006);
  });

  it('bandpass: Q is plain; 0 dB at the centre, bandwidth centre / Q', () => {
    const skirt = (r, q) => 1 / Math.sqrt(1 + q * q * (r - 1 / r) ** 2);
    expect(through('bandpass', 1000, 5, 1000)).toBeCloseTo(1, 2);
    expect(through('bandpass', 1000, 5, 2000) / skirt(2, 5)).toBeCloseTo(1, 1);
    expect(through('bandpass', 1000, 5, 500) / skirt(0.5, 5)).toBeCloseTo(1, 1);
    expect(through('bandpass', 1000, 1, 2000)).toBeGreaterThan(through('bandpass', 1000, 5, 2000) * 2.5); // wider
  });

  it('a filter\'s frequency can be swept: a sine is let through only while the band passes over it', () => {
    const { x } = tone(1000, 1, (c, osc) => {
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 8;
      f.frequency.setValueAtTime(250, 0);
      f.frequency.exponentialRampToValueAtTime(4000, 1); // at 1 kHz half way
      osc.connect(f);
      return f;
    });
    const at = (t) => rmsOf(x, Math.round((t - 0.01) * RATE), Math.round((t + 0.01) * RATE));
    expect(at(0.5)).toBeGreaterThan(at(0.15) * 4);
    expect(at(0.5)).toBeGreaterThan(at(0.85) * 4);
  });

  it('white noise through a bandpass is centred on it', () => {
    const c = new OfflineContext();
    const rnd = seededRandom(9);
    const buffer = c.createBuffer(1, RATE, RATE);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = rnd() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buffer;
    const white = measure(Float32Array.from(data));
    expect(white.rms).toBeCloseTo(1 / Math.sqrt(3), 2);
    expect(white.centroid).toBeGreaterThan(7000);
    expect(white.centroid).toBeLessThan(9000); // (30 + 16000) / 2
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2000;
    f.Q.value = 4;
    src.connect(f);
    f.connect(c.destination);
    src.start(0);
    const m = measure(c.render(0.9));
    expect(bandShare(m, 1500, 2700)).toBeGreaterThan(0.6);
    expect(Math.abs(m.centroid - 2000)).toBeLessThan(450);
  });
});

describe('offline renderer: measuring', () => {
  it('A-weighting: 0 dB at 1 kHz, −19 dB at 100 Hz, −30 dB at 50 Hz, about +1 dB at 3 kHz', () => {
    const db = (f) => 10 * Math.log10(aWeight(f));
    expect(db(1000)).toBeCloseTo(0, 1);
    expect(db(100)).toBeCloseTo(-19.1, 0);
    expect(db(50)).toBeCloseTo(-30.2, 0);
    expect(db(3000)).toBeCloseTo(1.2, 0);
    expect(aWeight(0)).toBe(0);
  });

  it('a low tone reads far quieter than a high one of the same amplitude; lowShare says where the energy is', () => {
    const low = measure(tone(80, 0.5).x);
    const high = measure(tone(2500, 0.5).x);
    expect(low.rms).toBeCloseTo(high.rms, 2);
    expect(high.loud - low.loud).toBeGreaterThan(15);
    expect(low.lowShare).toBeGreaterThan(0.95);
    expect(high.lowShare).toBeLessThan(0.01);
  });

  it('duration, start, head and tail: a burst that fades is whole; one cut off shows it', () => {
    const faded = tone(1500, 0.5, (c, osc) => {
      const g = c.createGain();
      g.gain.setValueAtTime(0, 0);
      g.gain.setValueAtTime(0.0001, 0.1);
      g.gain.linearRampToValueAtTime(1, 0.11);
      g.gain.exponentialRampToValueAtTime(0.0001, 0.3);
      osc.connect(g);
      osc.stop(0.3);
      return g;
    });
    const m = measure(faded.x);
    expect(m.start).toBeGreaterThan(0.099);
    expect(m.start).toBeLessThan(0.103);
    expect(m.duration).toBeGreaterThan(0.08); // within 40 dB of the peak: half of the 80 dB fall
    expect(m.duration).toBeLessThan(0.12);
    expect(m.tail).toBeLessThan(0.01);
    expect(m.head).toBeLessThan(0.05);
    expect(m.silentAfter).toBeLessThanOrEqual(0.3 + 2 / RATE);
    const cut = tone(1500, 0.5, (c, osc) => {
      osc.stop(0.2);
      return osc;
    });
    expect(measure(cut.x).tail).toBeGreaterThan(0.5);
    expect(measure(new Float32Array(1000)).peak).toBe(0);
    expect(measure(new Float32Array(1000)).loud).toBe(-Infinity);
  });

  it('burstsOf counts separate bursts; pitchOf follows a glide', () => {
    const c = new OfflineContext();
    const osc = c.createOscillator();
    osc.frequency.setValueAtTime(300, 0);
    osc.frequency.exponentialRampToValueAtTime(600, 1);
    const g = c.createGain();
    g.gain.value = 0;
    for (const t of [0.1, 0.4, 0.7]) {
      g.gain.setValueAtTime(1, t);
      g.gain.setValueAtTime(0, t + 0.1);
    }
    osc.connect(g);
    g.connect(c.destination);
    osc.start(0);
    const x = c.render(1);
    const starts = burstsOf(x);
    expect(starts).toHaveLength(3);
    expect(starts[1]).toBeCloseTo(0.4, 2);
    expect(pitchOf(x, 0.12, 100, 1000)).toBeCloseTo(300 * 2 ** 0.15, -1);
    expect(pitchOf(x, 0.72, 100, 1000)).toBeCloseTo(300 * 2 ** 0.75, -1);
    expect(pitchOf(x, 0.25, 100, 1000)).toBe(0); // silence has no pitch
  });
});

describe('offline renderer: the game\'s own audio graph', () => {
  it('createAudio runs on it: a sound is rendered after the master gain, and a seed makes it repeatable', () => {
    const a = renderSound((audio) => audio.playRecipe('timerDing', 1), { createAudio, seconds: 1, seed: 4 });
    const b = renderSound((audio) => audio.playRecipe('timerDing', 1), { createAudio, seconds: 1, seed: 4 });
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    const m = measure(a);
    // two sines at 1320 Hz (gain 1) and 1980 Hz (0.5) × the recipe's 0.3 × the master gain
    expect(m.peak).toBeLessThanOrEqual(0.3 * 1.5 * MASTER_GAIN + 1e-6);
    expect(m.peak).toBeGreaterThan(0.3 * MASTER_GAIN * 0.9);
    expect(Math.abs(strongestHz(m, 500, 5000) - 1320)).toBeLessThan(m.binHz);
    expect(m.silentAfter).toBeLessThanOrEqual(0.61 + 0.01);
    expect(OfflineContext.last.live).toHaveLength(0); // every voice ended and was torn down
    const half = renderSound((audio) => audio.playRecipe('timerDing', 0.5), { createAudio, seconds: 1, seed: 4 });
    expect(measure(half).rms / m.rms).toBeCloseTo(0.5, 2);
  });

  it('a noise sound differs with the seed, and muting or volume 0 renders silence', () => {
    const play = (audio) => audio.playBoom(1);
    const a = renderSound(play, { createAudio, seconds: 1.5, seed: 1 });
    const b = renderSound(play, { createAudio, seconds: 1.5, seed: 2 });
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(false);
    expect(measure(a).peak).toBeGreaterThan(0.1);
    const silent = renderSound((audio) => {
      audio.playBoom(0);
      audio.setMuted(true);
      audio.playBoom(1);
    }, { createAudio, seconds: 0.5 });
    expect(measure(silent).peak).toBe(0);
  });
});
