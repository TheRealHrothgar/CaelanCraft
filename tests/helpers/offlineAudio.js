// An offline renderer for the game's sounds: a pure-JS stand-in for the part of WebAudio that src/audio.js uses, which
// computes the samples. Nobody on the sound work could listen (CONTRACTS §82), so every sound is rendered here, by the
// game's own code path, and measured: `createAudio({ AudioContextClass: OfflineContext })` builds the very node graph
// a browser would, and `ctx.render(seconds)` runs it sample by sample — oscillators, noise buffers, biquad filters,
// gains and the parameter automation (set, linear and exponential ramps, setTarget), with nodes connected to parameters
// (the LFOs of a tremolo or a vibrato). No DOM, no WebAudio, no files.
//
// What is modelled follows the Web Audio API specification: the biquad coefficients (a lowpass and a highpass take Q in
// decibels, a bandpass takes it plain), `detune` in cents on oscillators and filters, a-rate parameters, 128-frame render
// quanta, `onended` after a source's stop time. Sawtooth and square oscillators are band-limited with polyBLEP (a browser
// uses band-limited wavetables), so their measured brightness is not inflated by aliasing.
//
// `measure(samples, rate)` then gives the numbers the sound tests assert on: peak, RMS, DC offset, A-weighted loudness
// (how loud it is to an ear, which hears 3 kHz far better than 80 Hz), spectral centroid (brightness), effective
// duration, and how loud the first and last instants are (a sound that starts or stops abruptly clicks). `tremoloOf`,
// `pitchOf` and `burstsOf` measure what makes a voice: its wobble, its pitch at a moment, its separate bursts.
// `renderSound(play, { createAudio, seconds, seed })` plays on a fresh audio player with a seeded Math.random.

const QUANTUM = 128;
const TWO_PI = Math.PI * 2;

/** @param {number} seed @returns {() => number} uniform in [0, 1) (mulberry32): a repeatable Math.random for the tests */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// AudioParam
// ---------------------------------------------------------------------------------------------------------------------

class OfflineParam {
  /** @param {OfflineContext} ctx @param {number} value */
  constructor(ctx, value) {
    this.ctx = ctx;
    this._value = value;
    /**
     * Every event ever scheduled, in time order (the tests read these).
     * @type {{ type: 'set'|'linear'|'exp'|'target', value: number, time: number, tc: number, call: number, from?: number }[]}
     */
    this.events = [];
    /** The events still to come and the last one passed: what rendering reads (a loop steered every frame adds thousands). */
    this._ahead = [];
    /** nodes connected to this parameter (their output is added to its value) */
    this.inputs = [];
    this._buf = new Float32Array(QUANTUM);
  }
  get value() {
    return this._value;
  }
  set value(v) {
    this._value = v;
    if (this.events.length) this._add('set', v, this.ctx.currentTime, 0);
  }
  _add(type, value, time, tc) {
    if (!Number.isFinite(value) || !Number.isFinite(time)) throw new TypeError('AudioParam: a finite value and time are required');
    const e = { type, value, time: Math.max(0, time), tc, call: this.ctx.currentTime };
    for (const list of [this.events, this._ahead]) {
      let i = list.length;
      while (i > 0 && list[i - 1].time > e.time) i--;
      list.splice(i, 0, e);
    }
    return this;
  }
  setValueAtTime(v, t) {
    return this._add('set', v, t, 0);
  }
  linearRampToValueAtTime(v, t) {
    return this._add('linear', v, t, 0);
  }
  exponentialRampToValueAtTime(v, t) {
    if (v === 0) throw new RangeError('exponentialRampToValueAtTime: the target must not be 0');
    return this._add('exp', v, t, 0);
  }
  setTargetAtTime(v, t, tc) {
    if (!(tc >= 0)) throw new RangeError('setTargetAtTime: the time constant must not be negative');
    return this._add('target', v, t, tc);
  }
  cancelScheduledValues(t) {
    this.events = this.events.filter((e) => e.time < t);
    this._ahead = this._ahead.filter((e) => e.time < t);
    return this;
  }

  /** The automation's value at time t (without the connected inputs). */
  valueAt(t) {
    return this._eval(this.events, this.events.length, t);
  }

  /** The value at t of the first `n` events of `ev`. */
  _eval(ev, n, t) {
    let v = this._value;
    let at = -Infinity; // the time of the event `v` belongs to
    /** @type {{ v0: number, t0: number, target: number, tc: number }|null} */
    let chase = null;
    for (let i = 0; i < n; i++) {
      const e = ev[i];
      if (e.time > t) {
        if (e.type === 'linear' || e.type === 'exp') {
          const t0 = at === -Infinity ? Math.min(e.call, e.time) : at;
          const v0 = chase ? chase.target + (chase.v0 - chase.target) * Math.exp(-(t0 - chase.t0) / chase.tc) : v;
          if (t <= t0) return v0;
          const k = (t - t0) / (e.time - t0);
          if (e.type === 'linear') return v0 + (e.value - v0) * k;
          return v0 > 0 === e.value > 0 && v0 !== 0 ? v0 * Math.pow(e.value / v0, k) : v0;
        }
        break;
      }
      if (e.type === 'target') {
        // where the chase starts from: remembered once the events before it were dropped (_prune), else worked out
        const from = e.from !== undefined ? e.from : chase ? chase.target + (chase.v0 - chase.target) * Math.exp(-(e.time - chase.t0) / chase.tc) : v;
        if (e.tc === 0) {
          v = e.value;
          chase = null;
        } else {
          chase = { v0: from, t0: e.time, target: e.value, tc: e.tc };
        }
      } else {
        v = e.value;
        chase = null;
      }
      at = e.time;
    }
    return chase ? chase.target + (chase.v0 - chase.target) * Math.exp(-(t - chase.t0) / chase.tc) : v;
  }

  /** Drop the events rendering has passed, but the last (it holds the value the next ones start from). */
  _prune(t0) {
    const ev = this._ahead;
    while (ev.length >= 2 && ev[1].time <= t0) {
      if (ev[1].type === 'target' && ev[1].from === undefined) ev[1].from = this._eval(ev, 1, ev[1].time);
      ev.shift();
    }
  }

  /** True when the automation cannot change inside [t0, t1]: no event there, no ramp under way, no chase still moving. */
  _steady(t0, t1) {
    const ev = this._ahead;
    let last = null;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.time > t1) {
        if (e.type === 'linear' || e.type === 'exp') return false;
        break;
      }
      if (e.time >= t0) return false;
      last = e;
    }
    return !(last && last.type === 'target' && t0 - last.time < 20 * last.tc); // 20 time constants on, a chase has arrived
  }

  /**
   * The parameter's values over one render quantum starting at t0: the automation plus whatever is connected to it.
   * @returns {{ steady: boolean, buf: Float32Array }} `steady`: every value in `buf` is the same
   */
  block(stamp, t0) {
    const sr = this.ctx.sampleRate;
    const buf = this._buf;
    const ev = this._ahead;
    this._prune(t0);
    const steady = this._steady(t0, t0 + QUANTUM / sr);
    if (steady) buf.fill(this._eval(ev, ev.length, t0));
    else for (let i = 0; i < QUANTUM; i++) buf[i] = this._eval(ev, ev.length, t0 + i / sr);
    for (const node of this.inputs) {
      const src = node._pull(stamp, t0);
      for (let i = 0; i < QUANTUM; i++) buf[i] += src[i];
    }
    return { steady: steady && this.inputs.length === 0, buf };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------------------------------------------------

class OfflineNode {
  /** @param {OfflineContext} ctx @param {string} kind 'gain' | 'filter' | 'osc' | 'noise' | 'destination' */
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    /** @type {OfflineNode[]} */
    this.inputs = [];
    /** what this node feeds: nodes and parameters */
    this.outputs = [];
    this._stamp = -1;
    this._out = new Float32Array(QUANTUM);
    this._in = new Float32Array(QUANTUM);
    ctx.nodes.push(this);
  }
  connect(dest) {
    if (!dest || !Array.isArray(dest.inputs)) throw new TypeError('connect: not a node or a parameter');
    dest.inputs.push(this);
    this.outputs.push(dest);
    return dest;
  }
  disconnect() {
    for (const dest of this.outputs) {
      const i = dest.inputs.indexOf(this);
      if (i >= 0) dest.inputs.splice(i, 1);
    }
    this.outputs.length = 0;
    this.disconnected = true;
  }
  _pull(stamp, t0) {
    if (this._stamp !== stamp) {
      this._stamp = stamp;
      this._process(stamp, t0, this._out);
    }
    return this._out;
  }
  /** The sum of the connected inputs for this quantum. */
  _mix(stamp, t0) {
    const acc = this._in;
    acc.fill(0);
    for (const node of this.inputs) {
      const src = node._pull(stamp, t0);
      for (let i = 0; i < QUANTUM; i++) acc[i] += src[i];
    }
    return acc;
  }
  /** @param {number} _stamp @param {number} _t0 @param {Float32Array} out */
  _process(_stamp, _t0, out) {
    out.fill(0);
  }
}

class OfflineGain extends OfflineNode {
  constructor(ctx) {
    super(ctx, 'gain');
    this.gain = new OfflineParam(ctx, 1);
  }
  _process(stamp, t0, out) {
    const src = this._mix(stamp, t0);
    const g = this.gain.block(stamp, t0).buf;
    for (let i = 0; i < QUANTUM; i++) out[i] = src[i] * g[i];
  }
}

class OfflineDestination extends OfflineNode {
  constructor(ctx) {
    super(ctx, 'destination');
  }
  _process(stamp, t0, out) {
    out.set(this._mix(stamp, t0));
  }
}

class OfflineSource extends OfflineNode {
  constructor(ctx, kind) {
    super(ctx, kind);
    this.startAt = undefined;
    this.stopAt = undefined;
    this.onended = null;
    this._ended = false;
    ctx.sources.push(this);
  }
  stop(when = 0) {
    if (this.startAt === undefined) throw new Error('stop() before start()');
    this.stopAt = Math.max(when, this.ctx.currentTime);
  }
}

/** The polyBLEP correction near a discontinuity at phase 0 (p in [0, 1), dp the phase step). */
function polyBlep(p, dp) {
  if (p < dp) {
    const x = p / dp;
    return x + x - x * x - 1;
  }
  if (p > 1 - dp) {
    const x = (p - 1) / dp;
    return x * x + x + x + 1;
  }
  return 0;
}

class OfflineOscillator extends OfflineSource {
  constructor(ctx) {
    super(ctx, 'osc');
    this.type = 'sine';
    this.frequency = new OfflineParam(ctx, 440);
    this.detune = new OfflineParam(ctx, 0);
    this._phase = 0;
  }
  start(when = 0) {
    if (this.startAt !== undefined) throw new Error('start() called twice');
    this.startAt = Math.max(when, this.ctx.currentTime);
  }
  _process(stamp, t0, out) {
    const sr = this.ctx.sampleRate;
    const start = this.startAt;
    const stop = this.stopAt === undefined ? Infinity : this.stopAt;
    if (start === undefined || t0 + QUANTUM / sr <= start || t0 >= stop) {
      out.fill(0);
      return;
    }
    const f = this.frequency.block(stamp, t0).buf;
    const d = this.detune.block(stamp, t0);
    const nyquist = sr / 2;
    const type = this.type;
    let phase = this._phase;
    for (let i = 0; i < QUANTUM; i++) {
      const t = t0 + i / sr;
      if (t < start || t >= stop) {
        out[i] = 0;
        continue;
      }
      let hz = f[i];
      if (!d.steady || d.buf[0] !== 0) hz *= Math.pow(2, d.buf[i] / 1200);
      hz = Math.max(-nyquist, Math.min(nyquist, hz));
      const dp = Math.abs(hz) / sr;
      let v;
      if (type === 'sine') {
        v = Math.sin(TWO_PI * phase);
      } else if (type === 'sawtooth') {
        const p = (phase + 0.5) % 1; // a browser's sawtooth starts at 0 and rises
        v = 2 * p - 1 - polyBlep(p, dp);
      } else if (type === 'square') {
        v = (phase < 0.5 ? 1 : -1) + polyBlep(phase, dp) - polyBlep((phase + 0.5) % 1, dp);
      } else if (type === 'triangle') {
        v = phase < 0.25 ? 4 * phase : phase < 0.75 ? 2 - 4 * phase : 4 * phase - 4;
      } else {
        throw new Error(`oscillator type ${type}`);
      }
      out[i] = v;
      phase += hz / sr;
      phase -= Math.floor(phase);
    }
    this._phase = phase;
  }
}

class OfflineBufferSource extends OfflineSource {
  constructor(ctx) {
    super(ctx, 'noise');
    this.buffer = null;
    this.loop = false;
    this.playbackRate = new OfflineParam(ctx, 1);
    this.offset = 0;
    this._pos = 0;
  }
  start(when = 0, offset = 0) {
    if (this.startAt !== undefined) throw new Error('start() called twice');
    if (!(offset >= 0)) throw new RangeError('start: a negative offset');
    this.startAt = Math.max(when, this.ctx.currentTime);
    this.offset = offset;
    this._pos = this.buffer ? offset * this.buffer.sampleRate : 0;
  }
  _process(stamp, t0, out) {
    const sr = this.ctx.sampleRate;
    const start = this.startAt;
    const stop = this.stopAt === undefined ? Infinity : this.stopAt;
    const buffer = this.buffer;
    if (!buffer || start === undefined || t0 + QUANTUM / sr <= start || t0 >= stop) {
      out.fill(0);
      return;
    }
    const data = buffer.getChannelData(0);
    const len = data.length;
    const rate = this.playbackRate.block(stamp, t0).buf;
    const step = buffer.sampleRate / sr;
    let pos = this._pos;
    for (let i = 0; i < QUANTUM; i++) {
      const t = t0 + i / sr;
      if (t < start || t >= stop) {
        out[i] = 0;
        continue;
      }
      if (pos >= len) {
        if (this.loop) pos %= len;
        else {
          out[i] = 0;
          if (this.stopAt === undefined || this.stopAt > t) this.stopAt = t; // ran off the end of the buffer
          continue;
        }
      }
      const i0 = Math.floor(pos);
      const i1 = i0 + 1 < len ? i0 + 1 : this.loop ? 0 : i0;
      const k = pos - i0;
      out[i] = data[i0] + (data[i1] - data[i0]) * k;
      pos += rate[i] * step;
    }
    this._pos = pos;
  }
}

class OfflineBiquad extends OfflineNode {
  constructor(ctx) {
    super(ctx, 'filter');
    this.type = 'lowpass';
    this.frequency = new OfflineParam(ctx, 350);
    this.detune = new OfflineParam(ctx, 0);
    this.Q = new OfflineParam(ctx, 1);
    this.gain = new OfflineParam(ctx, 0);
    this._x1 = 0;
    this._x2 = 0;
    this._y1 = 0;
    this._y2 = 0;
    this._c = [1, 0, 0, 0, 0];
  }
  /** Normalised coefficients [b0, b1, b2, a1, a2] (Web Audio API, "Filters characteristics"). */
  _coefficients(hz, q) {
    const sr = this.ctx.sampleRate;
    const c = this._c;
    const f = Math.max(0, Math.min(sr / 2, hz));
    const w0 = (TWO_PI * f) / sr;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    let b0;
    let b1;
    let b2;
    let alpha;
    if (this.type === 'lowpass') {
      alpha = sin / (2 * Math.pow(10, q / 20));
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = b0;
    } else if (this.type === 'highpass') {
      alpha = sin / (2 * Math.pow(10, q / 20));
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = b0;
    } else if (this.type === 'bandpass') {
      alpha = sin / (2 * Math.max(1e-4, q));
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    } else {
      throw new Error(`biquad type ${this.type}`);
    }
    const a0 = 1 + alpha;
    c[0] = b0 / a0;
    c[1] = b1 / a0;
    c[2] = b2 / a0;
    c[3] = (-2 * cos) / a0;
    c[4] = (1 - alpha) / a0;
    return c;
  }
  _process(stamp, t0, out) {
    const src = this._mix(stamp, t0);
    const f = this.frequency.block(stamp, t0);
    const d = this.detune.block(stamp, t0);
    const q = this.Q.block(stamp, t0);
    const fixed = f.steady && d.steady && q.steady;
    let c = this._coefficients(f.buf[0] * Math.pow(2, d.buf[0] / 1200), q.buf[0]);
    let x1 = this._x1;
    let x2 = this._x2;
    let y1 = this._y1;
    let y2 = this._y2;
    for (let i = 0; i < QUANTUM; i++) {
      // a moving filter: new coefficients every 8 frames (0.2 ms), far finer than any sweep or wobble in the game
      if (!fixed && (i & 7) === 0) c = this._coefficients(f.buf[i] * Math.pow(2, d.buf[i] / 1200), q.buf[i]);
      const x = src[i];
      const y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
    this._x1 = x1;
    this._x2 = x2;
    this._y1 = Math.abs(y1) < 1e-30 ? 0 : y1;
    this._y2 = Math.abs(y2) < 1e-30 ? 0 : y2;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A running "AudioContext" that renders on demand. Give the class to `createAudio({ AudioContextClass })`, play sounds,
 * then call `render(seconds)` on the instance (`OfflineContext.last`, or the `contexts` list).
 */
export class OfflineContext {
  constructor() {
    this.sampleRate = OfflineContext.sampleRate;
    this.state = 'running';
    this.currentTime = 0;
    /** @type {OfflineNode[]} every node ever created, in order */
    this.nodes = [];
    /** @type {OfflineSource[]} */
    this.sources = [];
    this._frame = 0;
    this._stamp = 0;
    this.destination = new OfflineDestination(this);
    OfflineContext.last = this;
  }
  createGain() {
    return new OfflineGain(this);
  }
  createBiquadFilter() {
    return new OfflineBiquad(this);
  }
  createOscillator() {
    return new OfflineOscillator(this);
  }
  createBufferSource() {
    return new OfflineBufferSource(this);
  }
  createBuffer(channels, length, rate) {
    const data = new Float32Array(length);
    return { duration: length / rate, length, sampleRate: rate, numberOfChannels: channels, getChannelData: () => data };
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  /** Sources started and not yet ended (the voices and the LFOs riding with them). */
  get live() {
    return this.sources.filter((s) => s.startAt !== undefined && !s._ended);
  }
  /**
   * Render the next `seconds` of output (what reaches the speakers, after the master gain).
   * @param {number} seconds
   * @returns {Float32Array}
   */
  render(seconds) {
    const sr = this.sampleRate;
    const quanta = Math.ceil((seconds * sr) / QUANTUM);
    const out = new Float32Array(quanta * QUANTUM);
    for (let k = 0; k < quanta; k++) {
      const t0 = this._frame / sr;
      this._stamp++;
      out.set(this.destination._pull(this._stamp, t0), k * QUANTUM);
      this._frame += QUANTUM;
      this.currentTime = this._frame / sr;
      for (const s of this.sources) {
        if (s._ended || s.stopAt === undefined || s.stopAt > this.currentTime) continue;
        s._ended = true;
        if (typeof s.onended === 'function') s.onended();
      }
      if (this.sources.length > 256) this.sources = this.sources.filter((s) => !s._ended);
    }
    return out;
  }
}
/** Frames per second of new contexts. */
OfflineContext.sampleRate = 44100;
/** @type {OfflineContext|null} the context created last */
OfflineContext.last = null;

// ---------------------------------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------------------------------

/** In-place radix-2 FFT of (re, im), length a power of two. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -TWO_PI / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** The A-weighting curve as a power gain at f Hz (IEC 61672; 1 at 1 kHz). */
export function aWeight(f) {
  if (!(f > 0)) return 0;
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  const g = ra * 1.2589; // +2 dB: 0 dB at 1 kHz
  return g * g;
}

const FRAME = 2048;
const HOP = 512;
const dB = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/**
 * @typedef {Object} SoundMeasure
 * @property {number} peak       the largest |sample|
 * @property {number} rms        root mean square over the effective duration
 * @property {number} dc         |mean| / rms over the effective duration (0 = no offset)
 * @property {number} loud       dB: the loudest 46 ms of the sound, A-weighted (0 dB = a full-scale 1 kHz sine)
 * @property {number} level      dB: the A-weighted level over the whole effective duration
 * @property {number} centroid   Hz: the spectrum's centre of gravity (brightness), 30 Hz to 16 kHz
 * @property {number} lowShare   the part of the energy below 150 Hz, 0..1 (small speakers lose it)
 * @property {number} duration   seconds between the first and the last sample within 40 dB of the peak
 * @property {number} start      seconds: where that first sample is
 * @property {number} head       |first sample that is not silent| / peak (near 1: it starts with a click)
 * @property {number} tail       the largest |sample| of the last 2 ms that are not silent / peak (near 1: it is cut off)
 * @property {number} silentAfter seconds: the time of the last sample that is not silent
 * @property {Float64Array} spectrum  the summed power spectrum (FRAME / 2 bins of `binHz`)
 * @property {number} binHz
 */

/**
 * Measure a rendered sound.
 * @param {Float32Array} x
 * @param {number} [rate]
 * @returns {SoundMeasure}
 */
export function measure(x, rate = OfflineContext.sampleRate) {
  const n = x.length;
  let peak = 0;
  for (let i = 0; i < n; i++) if (Math.abs(x[i]) > peak) peak = Math.abs(x[i]);
  const half = FRAME / 2;
  const binHz = rate / FRAME;
  const spectrum = new Float64Array(half);
  const empty = {
    peak, rms: 0, dc: 0, loud: -Infinity, level: -Infinity, centroid: 0, lowShare: 0, duration: 0, start: 0, head: 0, tail: 0,
    silentAfter: 0, spectrum, binHz,
  };
  if (!(peak > 0)) return empty;
  const silent = Math.max(1e-7, peak * 1e-5);
  let first = 0;
  while (first < n && Math.abs(x[first]) <= silent) first++;
  let last = n - 1;
  while (last > first && Math.abs(x[last]) <= silent) last--;

  const window = new Float64Array(FRAME);
  let wsum = 0;
  for (let i = 0; i < FRAME; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / FRAME);
    wsum += window[i] * window[i];
  }
  const weights = new Float64Array(half);
  for (let k = 0; k < half; k++) weights[k] = aWeight(k * binHz);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  /** @type {number[]} A-weighted power of each frame (a full-scale sine reads 0.5) */
  const frames = [];
  for (let at = -HOP; at < n; at += HOP) {
    for (let i = 0; i < FRAME; i++) {
      const j = at + i;
      re[i] = j >= 0 && j < n ? x[j] * window[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    let pa = 0;
    for (let k = 1; k < half; k++) {
      const p = (2 * (re[k] * re[k] + im[k] * im[k])) / (FRAME * wsum);
      spectrum[k] += p;
      pa += p * weights[k];
    }
    frames.push(pa);
  }
  let loudest = 0;
  for (const p of frames) if (p > loudest) loudest = p;
  // The effective duration: from the first to the last sample within 40 dB of the peak.
  let a = first;
  while (a < last && Math.abs(x[a]) < peak * 0.01) a++;
  let b = last;
  while (b > a && Math.abs(x[b]) < peak * 0.01) b--;
  b += 1;
  const startS = a / rate;
  const endS = b / rate;

  let num = 0;
  let den = 0;
  let low = 0;
  let all = 0;
  let weighted = 0;
  for (let k = 1; k < half; k++) {
    const f = k * binHz;
    all += spectrum[k];
    weighted += spectrum[k] * weights[k];
    if (f < 150) low += spectrum[k];
    if (f < 30 || f > 16000) continue;
    num += f * spectrum[k];
    den += spectrum[k];
  }

  let sum = 0;
  let sq = 0;
  for (let i = a; i < b; i++) {
    sum += x[i];
    sq += x[i] * x[i];
  }
  const rms = Math.sqrt(sq / (b - a));
  let tail = 0;
  for (let i = Math.max(first, last - Math.round(rate * 0.002)); i <= last; i++) tail = Math.max(tail, Math.abs(x[i]));

  return {
    peak,
    rms,
    dc: rms > 0 ? Math.abs(sum / (b - a)) / rms : 0,
    loud: dB(Math.sqrt(2 * loudest)),
    level: dB(Math.sqrt((2 * weighted * HOP) / Math.max(1, b - a))),
    centroid: den > 0 ? num / den : 0,
    lowShare: all > 0 ? low / all : 0,
    duration: Math.max(0, endS - startS),
    start: startS,
    head: Math.abs(x[first]) / peak,
    tail: tail / peak,
    silentAfter: (last + 1) / rate,
    spectrum,
    binHz,
  };
}

/**
 * The share of the energy between two frequencies, 0..1.
 * @param {SoundMeasure} m @param {number} lo Hz @param {number} hi Hz
 */
export function bandShare(m, lo, hi) {
  let band = 0;
  let all = 0;
  for (let k = 1; k < m.spectrum.length; k++) {
    const f = k * m.binHz;
    all += m.spectrum[k];
    if (f >= lo && f < hi) band += m.spectrum[k];
  }
  return all > 0 ? band / all : 0;
}

/**
 * The strongest frequency between two bounds (the pitch of a tone, a formant of a voice).
 * @param {SoundMeasure} m @param {number} lo Hz @param {number} hi Hz @returns {number} Hz
 */
export function strongestHz(m, lo, hi) {
  let best = 0;
  let at = 0;
  for (let k = 1; k < m.spectrum.length; k++) {
    const f = k * m.binHz;
    if (f < lo || f >= hi) continue;
    if (m.spectrum[k] > best) {
      best = m.spectrum[k];
      at = f;
    }
  }
  return at;
}

/**
 * The short-time level of a sound: the RMS of consecutive windows of `stepS` seconds.
 * @param {Float32Array} x @param {number} rate @param {number} stepS
 * @returns {number[]}
 */
function envelopeOf(x, rate, stepS) {
  const step = Math.max(1, Math.round(rate * stepS));
  const env = [];
  for (let at = 0; at + step <= x.length; at += step) {
    let sq = 0;
    for (let i = at; i < at + step; i++) sq += x[i] * x[i];
    env.push(Math.sqrt(sq / step));
  }
  return env;
}

/**
 * The amplitude wobble of a sound (a bleat's tremolo, a gobble, the beat of wings): the strongest regular swing of its
 * level between `lo` and `hi` Hz, measured over the middle of the sound (from 15 % to 75 % of its effective duration).
 * @param {Float32Array} x
 * @param {number} lo Hz @param {number} hi Hz
 * @param {number} [rate]
 * @returns {{ hz: number, depth: number }} `depth`: the swing as a part of the mean level (0 = steady, 1 = down to nothing)
 */
export function tremoloOf(x, lo, hi, rate = OfflineContext.sampleRate) {
  const m = measure(x, rate);
  const stepS = 0.004;
  const env = envelopeOf(x, rate, stepS);
  const a = Math.floor((m.start + 0.15 * m.duration) / stepS);
  const b = Math.min(env.length, Math.ceil((m.start + 0.75 * m.duration) / stepS));
  const part = env.slice(a, b);
  if (part.length < 8) return { hz: 0, depth: 0 };
  // take out the slow shape (a straight line through the part), keep the swing
  const n = part.length;
  const mean = part.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - (n - 1) / 2) * (part[i] - mean);
    sxx += (i - (n - 1) / 2) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  let best = 0;
  let at = 0;
  for (let f = lo; f <= hi + 1e-9; f += 0.25) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const v = part[i] - mean - slope * (i - (n - 1) / 2);
      const ph = TWO_PI * f * i * stepS;
      re += v * Math.cos(ph);
      im -= v * Math.sin(ph);
    }
    const amp = (2 * Math.hypot(re, im)) / n;
    if (amp > best) {
      best = amp;
      at = f;
    }
  }
  return { hz: at, depth: mean > 0 ? best / mean : 0 };
}

/**
 * The pitch of a voiced sound at a moment: the period that best repeats in the `windowS` seconds from `at` (normalised
 * autocorrelation; of the periods that repeat nearly as well as the best, the shortest, so a voice is not read an
 * octave low).
 * @param {Float32Array} x
 * @param {number} at       seconds
 * @param {number} fMin Hz  @param {number} fMax Hz
 * @param {number} [windowS]
 * @param {number} [rate]
 * @returns {number} Hz (0 when nothing repeats)
 */
export function pitchOf(x, at, fMin, fMax, windowS = 0.06, rate = OfflineContext.sampleRate) {
  const i0 = Math.max(0, Math.round(at * rate));
  const n = Math.min(x.length - i0, Math.round(windowS * rate));
  const lagMin = Math.max(2, Math.floor(rate / fMax));
  const lagMax = Math.min(n - 2, Math.ceil(rate / fMin));
  if (n < 16 || lagMax <= lagMin) return 0;
  const r = new Float64Array(lagMax + 2);
  let top = 0;
  for (let lag = lagMin; lag <= lagMax + 1; lag++) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = i0; i < i0 + n - lag; i++) {
      xy += x[i] * x[i + lag];
      xx += x[i] * x[i];
      yy += x[i + lag] * x[i + lag];
    }
    r[lag] = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
    if (lag <= lagMax && r[lag] > top) top = r[lag];
  }
  if (top < 0.3) return 0;
  for (let lag = lagMin + 1; lag <= lagMax; lag++) {
    if (r[lag] >= 0.92 * top && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
      const d = r[lag - 1] - 2 * r[lag] + r[lag + 1];
      const shift = d !== 0 ? (0.5 * (r[lag - 1] - r[lag + 1])) / d : 0;
      return rate / (lag + Math.max(-0.5, Math.min(0.5, shift)));
    }
  }
  return 0;
}

/**
 * How many separate bursts a sound has (the grunts of a pig, the thumps of a rabbit, the notes of a bird, the pulses of a
 * cricket): the times its level (in steps of `stepS`) rises above `floor` of its peak after having been below half of
 * that. A low voice needs a step longer than its pitch period (0.012 s), a train of clicks a short one.
 * @param {Float32Array} x
 * @param {number} [floor] 0..1
 * @param {number} [stepS] seconds
 * @param {number} [rate]
 * @returns {number[]} the start of each burst, seconds
 */
export function burstsOf(x, floor = 0.3, stepS = 0.002, rate = OfflineContext.sampleRate) {
  const env = envelopeOf(x, rate, stepS);
  let top = 0;
  for (const v of env) if (v > top) top = v;
  const starts = [];
  let up = false;
  for (let i = 0; i < env.length; i++) {
    if (!up && env[i] >= top * floor) {
      up = true;
      starts.push(i * stepS);
    } else if (up && env[i] < top * floor * 0.5) {
      up = false;
    }
  }
  return top > 0 ? starts : [];
}

/**
 * Render what `play(audio)` schedules on a fresh audio player, with Math.random replaced by a seeded generator for the
 * duration (the noise buffer, pitches, grains and variants are then the same on every run).
 * @param {(audio: any) => void} play
 * @param {{ seconds?: number, seed?: number, createAudio: (opts: object) => any }} opts
 * @returns {Float32Array}
 */
export function renderSound(play, opts) {
  const real = Math.random;
  Math.random = seededRandom(opts.seed ?? 1);
  try {
    const audio = opts.createAudio({ AudioContextClass: OfflineContext });
    audio.resume();
    const ctx = /** @type {OfflineContext} */ (OfflineContext.last);
    play(audio);
    return ctx.render(opts.seconds ?? 2);
  } finally {
    Math.random = real;
  }
}
