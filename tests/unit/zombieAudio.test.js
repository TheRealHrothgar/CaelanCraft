// The zombie sounds in src/audio.js (CONTRACTS §21, §39, §71, §82): playGroan, playZombieHurt, playZombieDown build their
// voices on a running context, scale with volume, respect mute and volume 0, and never throw.
// v0.16: they are bank recipes (`zombieGroan`, `zombieHurt`, `zombieDown`), so they are checked on the offline renderer
// (tests/helpers/offlineAudio.js) — what is asserted is the rendered sound, not the node list; what a groan sounds like
// (low, muffled, slow to come in) is measured in soundBank.test.js.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAudio, MAX_VOICES } from '../../src/audio.js';
import { SOUND_BANK, voicesOf } from '../../src/soundBank.js';
import { OfflineContext, measure, renderSound, seededRandom } from '../helpers/offlineAudio.js';

/** A resumed audio player on a rendering context, with Math.random seeded for the test. */
function rig(seed = 1) {
  vi.spyOn(Math, 'random').mockImplementation(seededRandom(seed));
  const audio = createAudio({ AudioContextClass: OfflineContext });
  audio.resume();
  return { audio, ctx: /** @type {OfflineContext} */ (OfflineContext.last) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('zombie sounds (§39, §82)', () => {
  for (const [method, name] of [['playGroan', 'zombieGroan'], ['playZombieHurt', 'zombieHurt'], ['playZombieDown', 'zombieDown']]) {
    it(`${method} schedules voices, scales with volume, and is silent when muted or at volume 0`, () => {
      // before resume(): no context, silent, no throw
      const cold = createAudio({ AudioContextClass: OfflineContext });
      expect(typeof cold[method]).toBe('function');
      const before = OfflineContext.last;
      expect(() => cold[method]()).not.toThrow();
      expect(OfflineContext.last).toBe(before);

      const { audio, ctx } = rig();
      const base = ctx.nodes.length;
      audio[method](1);
      const made = ctx.nodes.slice(base);
      expect(made.some((n) => n.kind === 'osc' && n.type === 'sawtooth')).toBe(true); // a voiced sound, not just noise
      expect(ctx.live.filter((s) => typeof s.onended === 'function').length).toBeLessThanOrEqual(voicesOf(SOUND_BANK[name]));
      const full = measure(ctx.render(SOUND_BANK[name].dur + 0.2));
      expect(full.peak).toBeGreaterThan(0.02);
      expect(full.peak).toBeLessThan(0.3);
      expect(ctx.live).toHaveLength(0); // every voice ended and freed its slot

      // the same random choices at half the volume: half the level
      const opts = { createAudio, seconds: SOUND_BANK[name].dur + 0.2, seed: 7 };
      const loud = measure(renderSound((a) => a[method](1), opts));
      const half = measure(renderSound((a) => a[method](0.5), opts));
      expect(Math.abs(half.rms / loud.rms - 0.5)).toBeLessThan(0.03); // (each decay ends at the same floor, so not to the last digit)
      expect(half.peak / loud.peak).toBeCloseTo(0.5, 2);
      expect(measure(renderSound((a) => a[method](), opts)).rms).toBeCloseTo(loud.rms, 9); // 1 by default
      expect(measure(renderSound((a) => a[method](7), opts)).rms).toBeCloseTo(loud.rms, 9); // clamped to 1

      // volume 0, a bad volume, or muted: nothing is scheduled
      const n = ctx.nodes.length;
      audio[method](0);
      audio[method](-1);
      audio[method](NaN);
      audio.setMuted(true);
      audio[method](1);
      expect(ctx.nodes.length).toBe(n);
      audio.setMuted(false);
      audio[method](1);
      expect(ctx.nodes.length).toBeGreaterThan(n);
    });
  }

  it('a groan is one of three (an "uhh", an "mmm-uh", a sigh): over a few plays more than one is heard', () => {
    const { audio, ctx } = rig(5);
    expect(SOUND_BANK.zombieGroan.variants).toHaveLength(3);
    const lengths = new Set();
    for (let i = 0; i < 12; i++) {
      audio.playGroan(1);
      const x = ctx.render(1.8);
      lengths.add(Math.round(measure(x).duration * 10));
      expect(ctx.live).toHaveLength(0);
    }
    expect(lengths.size).toBeGreaterThanOrEqual(3); // different takes, different lengths
  });

  it('a crowd of groans stays within the voice limit and never throws on a broken context', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { audio, ctx } = rig();
    for (let i = 0; i < 40; i++) audio.playGroan(1);
    expect(ctx.live.filter((s) => typeof s.onended === 'function').length).toBeLessThanOrEqual(MAX_VOICES);
    const broken = createAudio({
      AudioContextClass: class {
        constructor() {
          throw new Error('no audio');
        }
      },
    });
    broken.resume();
    expect(() => broken.playGroan(1)).not.toThrow();
    expect(() => broken.playZombieDown(1)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1); // said once, then silent
  });
});

describe('playBreak volume (play-test fire-holes F1: physics breaks played at full volume, up to 256 a frame)', () => {
  it('scales the whole break (crack, modes, debris) with the optional volume; 1 by default; silent at 0', () => {
    for (const group of ['wood', 'glass']) {
      const opts = { createAudio, seconds: 0.7, seed: 9 };
      const full = measure(renderSound((a) => a.playBreak(group), opts));
      const quarter = measure(renderSound((a) => a.playBreak(group, 0.25), opts));
      expect(full.peak, group).toBeGreaterThan(0.05);
      expect(Math.abs(quarter.rms / full.rms - 0.25), group).toBeLessThan(0.02);
      expect(measure(renderSound((a) => a.playBreak(group, 1), opts)).rms, group).toBeCloseTo(full.rms, 9);
      expect(measure(renderSound((a) => a.playBreak(group, NaN), opts)).rms, group).toBeCloseTo(full.rms, 9); // not a number: full
      const { audio, ctx } = rig();
      const n = ctx.nodes.length;
      audio.playBreak(group, 0);
      audio.playBreak(group, -2);
      expect(ctx.nodes.length, group).toBe(n);
    }
  });
});
