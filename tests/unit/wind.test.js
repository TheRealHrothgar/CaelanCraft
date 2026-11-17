// src/wind.js — the wind: deterministic from the seed and the clock, a wandering direction, gusts, stronger in showers;
// which way the player's scent goes.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  windAt, windSeed, scentToward, windFromWord, windWord, WIND_MIN, WIND_MAX, WIND_MAX_MS, SHOWER_WIND, WIND_CALM,
} from '../../src/wind.js';
import { DAY_LENGTH_SECONDS } from '../../src/config.js';

describe('windAt', () => {
  it('is the same for the same seed and time (every player on a server feels it alike)', () => {
    expect(windAt(42, 1234.5)).toEqual(windAt(42, 1234.5));
    expect(windAt('meadow', 99)).toEqual(windAt('meadow', 99));
    expect(windAt(1, 500)).not.toEqual(windAt(2, 500));
  });

  it('stays in range, with a unit direction', () => {
    for (let t = 0; t < 20000; t += 37) {
      const w = windAt(7, t, (t % 3) / 2);
      expect(w.strength).toBeGreaterThanOrEqual(WIND_MIN);
      expect(w.strength).toBeLessThanOrEqual(WIND_MAX);
      expect(Math.hypot(w.x, w.z)).toBeCloseTo(1, 9);
      expect(w.speed).toBeCloseTo(w.strength * WIND_MAX_MS, 9);
      expect(w.gust).toBeGreaterThanOrEqual(0);
      expect(w.gust).toBeLessThanOrEqual(1);
    }
  });

  it('changes smoothly from second to second, and wanders over the hours', () => {
    let maxStep = 0;
    for (let t = 0; t < 3000; t += 0.5) {
      const a = windAt(3, t);
      const b = windAt(3, t + 0.5);
      maxStep = Math.max(maxStep, Math.abs(Math.atan2(Math.sin(b.dir - a.dir), Math.cos(b.dir - a.dir))));
    }
    expect(maxStep).toBeLessThan(0.2);
    const dirs = [0, 4000, 8000, 12000, 16000].map((t) => windAt(3, t).dir);
    expect(Math.max(...dirs) - Math.min(...dirs)).toBeGreaterThan(0.5);
  });

  it('blows harder in a shower', () => {
    let more = 0;
    for (let t = 0; t < 5000; t += 50) if (windAt(9, t, 1).strength > windAt(9, t, 0).strength) more++;
    expect(more).toBeGreaterThan(80);
    expect(SHOWER_WIND).toBeGreaterThan(0);
  });

  it('takes any seed', () => {
    expect(windSeed(12.7)).toBe(12);
    expect(windSeed('abc')).toBe(windSeed('abc'));
    expect(Number.isFinite(windAt(undefined, NaN).dir)).toBe(true);
  });
});

describe('scent and words', () => {
  const east = { dir: Math.PI / 2, x: 1, z: 0, strength: 0.5, speed: 6, gust: 0 }; // blows toward +x

  it('the player upwind of an animal sends it their scent (+1), downwind none (−1)', () => {
    expect(scentToward(east, 0, 0, 10, 0)).toBeCloseTo(1); // the animal is where the wind goes
    expect(scentToward(east, 10, 0, 0, 0)).toBeCloseTo(-1);
    expect(scentToward(east, 0, 0, 0, 10)).toBeCloseTo(0);
    expect(scentToward(east, 1, 1, 1, 1)).toBe(0);
  });

  it('names where the wind comes from (north is −z, east +x)', () => {
    expect(windFromWord(east)).toBe('west'); // blowing toward +x: it comes from the west
    expect(windFromWord({ ...east, x: 0, z: 1 })).toBe('north'); // toward +z, from −z
    expect(windWord({ ...east, strength: 0.1 })).toBe('calm');
    expect(windWord({ ...east, strength: 0.8 })).toBe('a strong breeze');
    // a calm is below WIND_CALM (the vane, the drawn wind, the flag and the stalking hint share it, §101.1)
    expect(WIND_CALM).toBeGreaterThan(WIND_MIN);
    expect(windWord({ ...east, strength: WIND_CALM - 1e-9 })).toBe('calm');
    expect(windWord({ ...east, strength: WIND_CALM })).toBe('a light breeze');
  });
});

describe('what the module says of itself', () => {
  it('no hour is calmer than another: the strength swells over minutes and rises in showers, with no dawn calm', () => {
    const header = readFileSync(fileURLToPath(new URL('../../src/wind.js', import.meta.url)), 'utf8').split('\nimport')[0].split('\nexport')[0];
    expect(header).not.toMatch(/dawn/i);
    // the mean strength in the hour after sunrise (04:30) against the rest of the day, over many days: alike
    const hour = DAY_LENGTH_SECONDS / 24;
    let dawn = 0;
    let dawnN = 0;
    let rest = 0;
    let restN = 0;
    for (let day = 0; day < 400; day++) {
      for (let h = 0; h < 24; h += 0.25) {
        const s = windAt(11, day * DAY_LENGTH_SECONDS + h * hour).strength;
        if (h >= 4.5 && h < 5.5) {
          dawn += s;
          dawnN++;
        } else {
          rest += s;
          restN++;
        }
      }
    }
    expect(Math.abs(dawn / dawnN - rest / restN)).toBeLessThan(0.03);
  });
});
