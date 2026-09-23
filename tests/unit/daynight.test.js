// Tests for src/daynight.js — CONTRACTS.md §13, SPEC-gameplay §6, PLAN-build §2.11.
import { describe, it, expect } from 'vitest';
import { DAY_LENGTH_SECONDS, START_TIME } from '../../src/config.js';
import {
  KEYFRAMES, advanceTime, computeSky, formatTime, sunDirection, hexToRGB, createSkyState,
} from '../../src/daynight.js';

/** SPEC-gameplay §6 table, verbatim. KEYFRAMES must reproduce it exactly (plus a wrap row at t = 1). */
const SPEC_TABLE = [
  { t: 0.00, clock: '00:00', zenith: '#070B1A', horizon: '#101833', fog: '#0C1228', sunColor: '#8C9AC8', sun: 0.35, amb: 0.55, daylight: 0.22, stars: 1.0 },
  { t: 0.20, clock: '04:48', zenith: '#0B1430', horizon: '#2C2F55', fog: '#1E2544', sunColor: '#A090B0', sun: 0.45, amb: 0.65, daylight: 0.30, stars: 1.0 },
  { t: 0.25, clock: '06:00', zenith: '#23457F', horizon: '#F0A25A', fog: '#D6905E', sunColor: '#FFB878', sun: 1.10, amb: 0.90, daylight: 0.55, stars: 0.3 },
  { t: 0.30, clock: '07:12', zenith: '#4F8FD6', horizon: '#B9D6F2', fog: '#A9C7E8', sunColor: '#FFE6C2', sun: 1.80, amb: 1.30, daylight: 0.90, stars: 0.0 },
  { t: 0.50, clock: '12:00', zenith: '#6DA7FF', horizon: '#BFDCFF', fog: '#B6D3F7', sunColor: '#FFF8EA', sun: 2.00, amb: 1.40, daylight: 1.00, stars: 0.0 },
  { t: 0.70, clock: '16:48', zenith: '#4F8FD6', horizon: '#C6D6EC', fog: '#B2C6E0', sunColor: '#FFE0B8', sun: 1.80, amb: 1.30, daylight: 0.90, stars: 0.0 },
  { t: 0.75, clock: '18:00', zenith: '#22336E', horizon: '#EF8546', fog: '#D27447', sunColor: '#FFA060', sun: 1.10, amb: 0.90, daylight: 0.55, stars: 0.3 },
  { t: 0.80, clock: '19:12', zenith: '#0C1436', horizon: '#302E58', fog: '#202646', sunColor: '#A090B0', sun: 0.45, amb: 0.65, daylight: 0.30, stars: 1.0 },
];

const KEYFRAME_TIMES = SPEC_TABLE.map((r) => r.t);
const COLOR_FIELDS = ['sunColor', 'zenithColor', 'horizonColor', 'fogColor'];
const SCALAR_FIELDS = ['sunIntensity', 'hemiIntensity', 'daylight', 'stars'];

/** Every colour channel / scalar of two SkyStates within tol (sunDir excluded — it flips by design at dawn/dusk). */
function expectSkyClose(a, b, tol) {
  for (const f of COLOR_FIELDS) {
    for (let c = 0; c < 3; c++) expect(Math.abs(a[f][c] - b[f][c])).toBeLessThanOrEqual(tol);
  }
  for (const f of SCALAR_FIELDS) expect(Math.abs(a[f] - b[f])).toBeLessThanOrEqual(tol);
}

function expectVec3Close(a, b, digits = 12) {
  expect(a).toHaveLength(3);
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], digits);
}

function expectValidColor(c) {
  expect(c).toHaveLength(3);
  for (const v of c) {
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  }
}

describe('hexToRGB', () => {
  it('converts #RRGGBB to [r,g,b] floats in 0..1', () => {
    expect(hexToRGB('#FFFFFF')).toEqual([1, 1, 1]);
    expect(hexToRGB('#000000')).toEqual([0, 0, 0]);
    expect(hexToRGB('#6DA7FF')).toEqual([0x6d / 255, 0xa7 / 255, 1]);
  });
  it('accepts lower-case and a missing hash', () => {
    expect(hexToRGB('6da7ff')).toEqual(hexToRGB('#6DA7FF'));
  });
  it('rejects malformed input', () => {
    expect(() => hexToRGB('#FFF')).toThrow();
    expect(() => hexToRGB('#GGGGGG')).toThrow();
  });
});

describe('KEYFRAMES', () => {
  it('has the 8 spec rows plus a wrap row at t = 1, strictly ascending in t', () => {
    expect(KEYFRAMES).toHaveLength(SPEC_TABLE.length + 1);
    expect(KEYFRAMES[0].t).toBe(0);
    expect(KEYFRAMES[KEYFRAMES.length - 1].t).toBe(1);
    for (let i = 1; i < KEYFRAMES.length; i++) expect(KEYFRAMES[i].t).toBeGreaterThan(KEYFRAMES[i - 1].t);
  });

  it('reproduces the SPEC-gameplay §6 table verbatim', () => {
    SPEC_TABLE.forEach((row, i) => {
      const k = KEYFRAMES[i];
      expect(k.t).toBe(row.t);
      expect(k.zenith).toEqual(hexToRGB(row.zenith));
      expect(k.horizon).toEqual(hexToRGB(row.horizon));
      expect(k.fog).toEqual(hexToRGB(row.fog));
      expect(k.sunColor).toEqual(hexToRGB(row.sunColor));
      expect(k.sun).toBe(row.sun);
      expect(k.amb).toBe(row.amb);
      expect(k.daylight).toBe(row.daylight);
      expect(k.stars).toBe(row.stars);
    });
  });

  it('wrap row equals the midnight row apart from t', () => {
    const first = KEYFRAMES[0];
    const last = KEYFRAMES[KEYFRAMES.length - 1];
    expect(last).toEqual({ ...first, t: 1 });
  });

  it('has colours in [0,1] and non-negative intensities', () => {
    for (const k of KEYFRAMES) {
      for (const f of ['zenith', 'horizon', 'fog', 'sunColor']) expectValidColor(k[f]);
      expect(k.sun).toBeGreaterThanOrEqual(0);
      expect(k.amb).toBeGreaterThanOrEqual(0);
      expect(k.daylight).toBeGreaterThanOrEqual(0);
      expect(k.daylight).toBeLessThanOrEqual(1);
      expect(k.stars).toBeGreaterThanOrEqual(0);
      expect(k.stars).toBeLessThanOrEqual(1);
    }
  });

  it('is deeply frozen so no consumer can corrupt the table', () => {
    expect(Object.isFrozen(KEYFRAMES)).toBe(true);
    for (const k of KEYFRAMES) {
      expect(Object.isFrozen(k)).toBe(true);
      expect(Object.isFrozen(k.zenith)).toBe(true);
    }
  });
});

describe('sunDirection', () => {
  it('always returns a unit vector', () => {
    for (let t = -1; t <= 2; t += 0.01) {
      const d = sunDirection(t);
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 12);
    }
  });

  it('rises at +X (06:00), is overhead at noon, sets at -X (18:00), is below the horizon at midnight', () => {
    const dawn = sunDirection(0.25);
    expect(dawn[0]).toBeGreaterThan(0.9);
    expect(Math.abs(dawn[1])).toBeLessThan(1e-9);

    const noon = sunDirection(0.5);
    expect(noon[1]).toBeGreaterThan(0.8);
    expect(Math.abs(noon[0])).toBeLessThan(1e-9);

    const dusk = sunDirection(0.75);
    expect(dusk[0]).toBeLessThan(-0.9);
    expect(Math.abs(dusk[1])).toBeLessThan(1e-9);

    const midnight = sunDirection(0);
    expect(midnight[1]).toBeLessThan(-0.8);
  });

  it('matches normalize(cos θ, sin θ, 0.25) with θ = (t − 0.25)·2π', () => {
    for (const t of [0, 0.1, 0.25, 0.33, 0.5, 0.66, 0.75, 0.9]) {
      const th = (t - 0.25) * Math.PI * 2;
      const len = Math.hypot(Math.cos(th), Math.sin(th), 0.25);
      expectVec3Close(sunDirection(t), [Math.cos(th) / len, Math.sin(th) / len, 0.25 / len]);
    }
  });

  it('is periodic in t and finite for non-finite input', () => {
    expectVec3Close(sunDirection(0.37), sunDirection(1.37));
    expectVec3Close(sunDirection(0.37), sunDirection(-0.63));
    for (const bad of [NaN, Infinity, -Infinity]) {
      const d = sunDirection(bad);
      expect(d.every(Number.isFinite)).toBe(true);
    }
  });
});

describe('computeSky', () => {
  it('returns a complete SkyState', () => {
    const s = computeSky(0.4);
    expect(Object.keys(s).sort()).toEqual([
      'daylight', 'fogColor', 'hemiIntensity', 'horizonColor', 'isDay', 'stars', 'sunColor', 'sunDir', 'sunIntensity',
      'time', 'zenithColor',
    ]);
    expect(typeof s.time).toBe('number');
    expect(typeof s.isDay).toBe('boolean');
    expect(s.sunDir).toHaveLength(3);
    for (const f of COLOR_FIELDS) expectValidColor(s[f]);
    for (const f of SCALAR_FIELDS) expect(Number.isFinite(s[f])).toBe(true);
  });

  it('computeSky(0) equals computeSky(1)', () => {
    expect(computeSky(0)).toEqual(computeSky(1));
  });

  it('noon: sun high overhead at full intensity, no stars', () => {
    const s = computeSky(0.5);
    expect(s.isDay).toBe(true);
    expect(s.sunDir[1]).toBeGreaterThan(0.8);
    expect(s.sunIntensity).toBe(2.0);
    expect(s.hemiIntensity).toBe(1.4);
    expect(s.daylight).toBe(1);
    expect(s.stars).toBe(0);
    expect(s.sunColor).toEqual(hexToRGB('#FFF8EA'));
    expect(s.zenithColor).toEqual(hexToRGB('#6DA7FF'));
    expect(s.horizonColor).toEqual(hexToRGB('#BFDCFF'));
    expect(s.fogColor).toEqual(hexToRGB('#B6D3F7'));
  });

  it('midnight: light comes from the moon (above the horizon), dim but never black, stars fully out', () => {
    const s = computeSky(0);
    expect(s.isDay).toBe(false);
    expect(s.sunDir[1]).toBeGreaterThan(0);
    expect(s.sunIntensity).toBe(0.35);
    expect(s.hemiIntensity).toBe(0.55);
    expect(s.hemiIntensity).toBeGreaterThan(0.1);
    expect(s.stars).toBe(1);
    expect(s.daylight).toBe(0.22);
    expect(s.zenithColor).toEqual(hexToRGB('#070B1A'));
  });

  it('sunDir points at the sun by day and at the moon (= −sun) by night', () => {
    for (const t of [0.25, 0.3, 0.5, 0.7, 0.7499]) {
      expectVec3Close(computeSky(t).sunDir, sunDirection(t));
    }
    for (const t of [0, 0.1, 0.2, 0.2499, 0.75, 0.8, 0.95]) {
      const sun = sunDirection(t);
      const s = computeSky(t);
      expectVec3Close(s.sunDir, [-sun[0], -sun[1], -sun[2]]);
      // Moon is on or above the horizon all night (exactly on it at the 18:00 instant).
      expect(s.sunDir[1]).toBeGreaterThanOrEqual(-1e-12);
    }
    expect(computeSky(0.8).sunDir[1]).toBeGreaterThan(0.2);
    expect(computeSky(0.2).sunDir[1]).toBeGreaterThan(0.2);
  });

  it('isDay is 0.25 <= t < 0.75', () => {
    expect(computeSky(0.25).isDay).toBe(true);
    expect(computeSky(0.7499).isDay).toBe(true);
    expect(computeSky(0.75).isDay).toBe(false);
    expect(computeSky(0.2499).isDay).toBe(false);
    expect(computeSky(0).isDay).toBe(false);
    expect(computeSky(0.9999).isDay).toBe(false);
  });

  it('hits every keyframe exactly at its time', () => {
    SPEC_TABLE.forEach((row) => {
      const s = computeSky(row.t);
      expect(s.time).toBe(row.t);
      expect(s.zenithColor).toEqual(hexToRGB(row.zenith));
      expect(s.horizonColor).toEqual(hexToRGB(row.horizon));
      expect(s.fogColor).toEqual(hexToRGB(row.fog));
      expect(s.sunColor).toEqual(hexToRGB(row.sunColor));
      expect(s.sunIntensity).toBe(row.sun);
      expect(s.hemiIntensity).toBe(row.amb);
      expect(s.daylight).toBe(row.daylight);
      expect(s.stars).toBe(row.stars);
    });
  });

  it('interpolates linearly between neighbouring keyframes', () => {
    // 0.40 is halfway between the 07:12 and 12:00 rows.
    const mid = computeSky(0.4);
    expect(mid.sunIntensity).toBeCloseTo((1.8 + 2.0) / 2, 12);
    expect(mid.hemiIntensity).toBeCloseTo((1.3 + 1.4) / 2, 12);
    expect(mid.daylight).toBeCloseTo((0.9 + 1.0) / 2, 12);
    const za = hexToRGB('#4F8FD6');
    const zb = hexToRGB('#6DA7FF');
    expectVec3Close(mid.zenithColor, [(za[0] + zb[0]) / 2, (za[1] + zb[1]) / 2, (za[2] + zb[2]) / 2]);

    // 0.225 is halfway between 04:48 and 06:00: stars fade 1.0 → 0.3, sun 0.45 → 1.10.
    const dawn = computeSky(0.225);
    expect(dawn.stars).toBeCloseTo(0.65, 12);
    expect(dawn.sunIntensity).toBeCloseTo(0.775, 12);

    // Quarter of the way from 19:12 to midnight (0.85): sun 0.45 → 0.35.
    const dusk = computeSky(0.85);
    expect(dusk.sunIntensity).toBeCloseTo(0.45 + (0.35 - 0.45) * 0.25, 12);
    expect(dusk.stars).toBe(1);
  });

  it('keeps colours in [0,1], intensities >= 0 and daylight/stars in [0,1] for every t', () => {
    for (let i = 0; i <= 2000; i++) {
      const s = computeSky(i / 2000);
      for (const f of COLOR_FIELDS) expectValidColor(s[f]);
      expect(s.sunIntensity).toBeGreaterThanOrEqual(0);
      expect(s.hemiIntensity).toBeGreaterThanOrEqual(0);
      expect(s.daylight).toBeGreaterThanOrEqual(0);
      expect(s.daylight).toBeLessThanOrEqual(1);
      expect(s.stars).toBeGreaterThanOrEqual(0);
      expect(s.stars).toBeLessThanOrEqual(1);
      expect(Math.hypot(...s.sunDir)).toBeCloseTo(1, 12);
    }
  });

  it('is continuous across every keyframe boundary and the midnight wrap', () => {
    const eps = 1e-4;
    for (const tb of KEYFRAME_TIMES) {
      expectSkyClose(computeSky(tb - eps), computeSky(tb + eps), 0.01);
      expectSkyClose(computeSky(tb - eps), computeSky(tb), 0.005);
      expectSkyClose(computeSky(tb), computeSky(tb + eps), 0.005);
    }
    expectSkyClose(computeSky(1 - eps), computeSky(eps), 0.01);
  });

  it('is continuous everywhere: f(t) vs f(t + 1e-4) over a dense sweep', () => {
    const eps = 1e-4;
    for (let i = 0; i < 1000; i++) {
      const t = i / 1000 + eps / 3;
      expectSkyClose(computeSky(t), computeSky(t + eps), 0.005);
    }
  });

  it('wraps times outside [0,1) and reports the wrapped time', () => {
    const a = computeSky(-0.5);
    const b = computeSky(0.5);
    expect(a.time).toBeCloseTo(0.5, 12);
    expectSkyClose(a, b, 1e-9);
    expectVec3Close(a.sunDir, b.sunDir);

    const c = computeSky(2.3);
    expect(c.time).toBeCloseTo(0.3, 12);
    expectSkyClose(c, computeSky(0.3), 1e-9);

    for (const t of [1, 2, -1, 1.999999, -0.000001]) {
      const s = computeSky(t);
      expect(s.time).toBeGreaterThanOrEqual(0);
      expect(s.time).toBeLessThan(1);
    }
  });

  it('never produces NaN for non-finite input', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const s = computeSky(bad);
      expect(s.time).toBe(0);
      for (const f of COLOR_FIELDS) expectValidColor(s[f]);
      for (const f of SCALAR_FIELDS) expect(Number.isFinite(s[f])).toBe(true);
      expect(s.sunDir.every(Number.isFinite)).toBe(true);
    }
  });

  it('fills a caller-supplied SkyState without allocating new arrays', () => {
    const out = createSkyState();
    const arrays = [out.sunDir, out.sunColor, out.zenithColor, out.horizonColor, out.fogColor];
    const ret = computeSky(0.5, out);
    expect(ret).toBe(out);
    expect([out.sunDir, out.sunColor, out.zenithColor, out.horizonColor, out.fogColor]).toEqual(arrays.map((a) => a));
    expect(out.sunDir).toBe(arrays[0]);
    expect(out.zenithColor).toBe(arrays[2]);
    expect(out).toEqual(computeSky(0.5));
    // Re-filling with another time overwrites everything.
    computeSky(0, out);
    expect(out).toEqual(computeSky(0));
  });

  it('does not mutate KEYFRAMES', () => {
    const before = JSON.stringify(KEYFRAMES);
    for (let i = 0; i <= 100; i++) computeSky(i / 100);
    const out = computeSky(0.5);
    out.zenithColor[0] = 9;
    out.sunDir[1] = 9;
    expect(JSON.stringify(KEYFRAMES)).toBe(before);
    expect(computeSky(0.5).zenithColor[0]).toBe(hexToRGB('#6DA7FF')[0]);
  });
});

describe('advanceTime', () => {
  it('advances by dt / dayLength', () => {
    expect(advanceTime(0, 150, 600)).toBeCloseTo(0.25, 12);
    expect(advanceTime(0.25, 300, 600)).toBeCloseTo(0.75, 12);
    expect(advanceTime(0.5, 0, 600)).toBe(0.5);
  });

  it('defaults to DAY_LENGTH_SECONDS', () => {
    expect(advanceTime(0, DAY_LENGTH_SECONDS / 2)).toBeCloseTo(0.5, 12);
    expect(advanceTime(0, DAY_LENGTH_SECONDS / 4)).toBeCloseTo(0.25, 12);
  });

  it('wraps past midnight back into [0,1)', () => {
    expect(advanceTime(0.99, 12, 600)).toBeCloseTo(0.01, 12);
    expect(advanceTime(0, 600, 600)).toBe(0);
    expect(advanceTime(0.5, 1200, 600)).toBeCloseTo(0.5, 12);
    expect(advanceTime(0.999, 60, 600)).toBeCloseTo(0.099, 12);
    const r = advanceTime(0.9999999, 1, 600);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });

  it('wraps backwards for negative dt', () => {
    expect(advanceTime(0.1, -120, 600)).toBeCloseTo(0.9, 12);
    expect(advanceTime(0, -1, 600)).toBeCloseTo(1 - 1 / 600, 12);
  });

  it('always returns a value in [0,1) even from out-of-range inputs', () => {
    for (let i = 0; i < 500; i++) {
      const time = (i * 0.731) % 3 - 1; // deterministic spread over [-1, 2)
      const dt = ((i * 37) % 1900) - 300; // -300..1599 s
      const r = advanceTime(time, dt, 600);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
    expect(advanceTime(-1e-17, 0, 600)).toBe(0);
  });

  it('leaves time unchanged (but wrapped) for invalid day length or dt', () => {
    expect(advanceTime(0.3, 10, 0)).toBe(0.3);
    expect(advanceTime(0.3, 10, -600)).toBe(0.3);
    expect(advanceTime(0.3, 10, NaN)).toBe(0.3);
    expect(advanceTime(0.3, NaN, 600)).toBe(0.3);
    expect(advanceTime(0.3, Infinity, 600)).toBe(0.3);
    expect(advanceTime(1.3, NaN, 600)).toBeCloseTo(0.3, 12);
    expect(advanceTime(0.3, 10, Infinity)).toBe(0.3);
  });

  it('accumulates a full day of 1/60 s frames back to the start', () => {
    let t = 0.3;
    const dt = 1 / 60;
    const frames = Math.round(600 / dt);
    for (let i = 0; i < frames; i++) t = advanceTime(t, dt, 600);
    // One full day later we are back where we started (allow float drift).
    expect(Math.min(Math.abs(t - 0.3), Math.abs(t - 1.3), Math.abs(t + 0.7))).toBeLessThan(1e-6);
  });
});

describe('formatTime', () => {
  it('formats the spec clock column', () => {
    for (const row of SPEC_TABLE) expect(formatTime(row.t)).toBe(row.clock);
    expect(formatTime(0.25)).toBe('06:00');
    expect(formatTime(0.5)).toBe('12:00');
    expect(formatTime(START_TIME)).toBe('07:12');
  });

  it('is robust to floating-point products (0.7 * 1440 is 1007.999…)', () => {
    expect(formatTime(0.7)).toBe('16:48');
    expect(formatTime(0.1)).toBe('02:24');
    expect(formatTime(0.9)).toBe('21:36');
    expect(formatTime(1.3 - 1)).toBe('07:12');
  });

  it('floors within the minute and zero-pads', () => {
    expect(formatTime(0.5 + 0.5 / 1440)).toBe('12:00'); // 12:00:30
    expect(formatTime(1 / 1440)).toBe('00:01');
    expect(formatTime(9 / 24)).toBe('09:00');
    expect(formatTime(0.999999)).toBe('23:59');
    expect(formatTime(1 - 0.5 / 1440)).toBe('23:59'); // 23:59:30
    expect(formatTime(0.25 - 1e-9)).toBe('05:59'); // 86 µs before 06:00 still reads 05:59
  });

  it('wraps times outside [0,1)', () => {
    expect(formatTime(1)).toBe('00:00');
    expect(formatTime(1.25)).toBe('06:00');
    expect(formatTime(-0.25)).toBe('18:00');
    expect(formatTime(2.5)).toBe('12:00');
  });

  it('returns midnight for non-finite input', () => {
    expect(formatTime(NaN)).toBe('00:00');
    expect(formatTime(Infinity)).toBe('00:00');
  });

  it('always matches /^\\d\\d:\\d\\d$/ with valid hours and minutes', () => {
    for (let i = 0; i <= 1440; i++) {
      const s = formatTime(i / 1440);
      expect(s).toMatch(/^\d\d:\d\d$/);
      const [h, m] = s.split(':').map(Number);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(24);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThan(60);
      if (i < 1440) expect(h * 60 + m).toBe(i);
    }
  });
});
