// The block-physics feature sounds in src/audio.js (CONTRACTS §21, §36–§37): playBoom, playHiss, playFizzle, playCreak
// build their voices on a running context, respect mute and volume 0, and never throw. A minimal fake AudioContext
// records the nodes each sound schedules.
import { describe, it, expect } from 'vitest';
import { createAudio, MAX_VOICES } from '../../src/audio.js';

function fakeContextClass(log) {
  const param = () => ({
    value: 0,
    setValueAtTime(v) {
      this.value = v;
    },
    exponentialRampToValueAtTime() {},
    linearRampToValueAtTime() {},
    setTargetAtTime() {},
    cancelScheduledValues() {},
  });
  const node = (kind) => {
    const n = { kind, connect() {}, disconnect() {}, gain: param(), frequency: param(), playbackRate: param(), type: '' };
    log.push(n);
    return n;
  };
  return class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 8000;
      this.currentTime = 0;
      this.destination = {};
    }
    createGain() {
      return node('gain');
    }
    createBiquadFilter() {
      return node('filter');
    }
    createOscillator() {
      const n = node('osc');
      n.start = () => {};
      n.stop = () => {};
      return n;
    }
    createBufferSource() {
      const n = node('noise');
      n.start = (t, offset) => {
        n.offset = offset;
      };
      n.stop = () => {};
      return n;
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

describe('physics feature sounds', () => {
  for (const name of ['playBoom', 'playHiss', 'playFizzle', 'playCreak']) {
    it(`${name} schedules voices, scales with volume, and is silent when muted or at volume 0`, () => {
      const log = [];
      const audio = createAudio({ AudioContextClass: fakeContextClass(log) });
      expect(typeof audio[name]).toBe('function');
      audio[name](); // before resume(): no context, silent
      expect(log.length).toBe(0);
      audio.resume();
      const base = log.length;
      audio[name](1);
      const sources = log.slice(base).filter((n) => n.kind === 'osc' || n.kind === 'noise');
      expect(sources.length).toBeGreaterThan(0);
      for (const s of sources) if (s.kind === 'noise') expect(s.offset).toBeGreaterThanOrEqual(0);
      const loud = Math.max(...log.slice(base).filter((n) => n.kind === 'gain').map((g) => g.gain.value));
      const n1 = log.length;
      audio[name](0.25);
      const quiet = Math.max(...log.slice(n1).filter((n) => n.kind === 'gain').map((g) => g.gain.value));
      expect(quiet).toBeCloseTo(loud / 4, 6);
      const n2 = log.length;
      audio[name](0);
      audio.setMuted(true);
      audio[name](1);
      expect(log.length).toBe(n2);
    });
  }

  it('a boom stays within the voice limit and never throws on a broken context', () => {
    const log = [];
    const audio = createAudio({ AudioContextClass: fakeContextClass(log) });
    audio.resume();
    for (let i = 0; i < 40; i++) audio.playBoom(1);
    // Voices are counted until they end (never, in the fake): the limit stops new ones.
    expect(log.filter((n) => n.kind === 'osc' || n.kind === 'noise').length).toBeLessThanOrEqual(MAX_VOICES + 4);
    const broken = createAudio({
      AudioContextClass: class {
        constructor() {
          throw new Error('no audio');
        }
      },
    });
    broken.resume();
    expect(() => broken.playBoom(1)).not.toThrow();
  });
});
