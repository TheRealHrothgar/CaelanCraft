// The zombie sounds in src/audio.js (CONTRACTS §21, §39): playGroan, playZombieHurt, playZombieDown build their voices on a
// running context, scale with volume, respect mute and volume 0, and never throw. A minimal fake AudioContext records the
// nodes each sound schedules (as in explosionsAudio.test.js).
import { describe, it, expect } from 'vitest';
import { createAudio } from '../../src/audio.js';

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
      n.start = () => {};
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

describe('zombie sounds (§39)', () => {
  for (const name of ['playGroan', 'playZombieHurt', 'playZombieDown']) {
    it(`${name} schedules voices, scales with volume, and is silent when muted or at volume 0`, () => {
      const log = [];
      const audio = createAudio({ AudioContextClass: fakeContextClass(log) });
      expect(typeof audio[name]).toBe('function');
      audio[name]();
      expect(log.length).toBe(0); // no context before resume()
      audio.resume();
      const base = log.length;
      audio[name](1);
      expect(log.slice(base).some((n) => n.kind === 'osc')).toBe(true); // a voiced sound, not just noise
      const loud = Math.max(...log.slice(base).filter((n) => n.kind === 'gain').map((g) => g.gain.value));
      const n1 = log.length;
      audio[name](0.5);
      const quiet = Math.max(...log.slice(n1).filter((n) => n.kind === 'gain').map((g) => g.gain.value));
      expect(quiet).toBeCloseTo(loud / 2, 6);
      const n2 = log.length;
      audio[name](0);
      audio.setMuted(true);
      audio[name](1);
      expect(log.length).toBe(n2);
    });
  }
});
