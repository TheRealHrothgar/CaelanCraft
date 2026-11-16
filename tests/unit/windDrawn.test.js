// CONTRACTS §101 — the wind drawn: the HUD's vane (windDrawn.js, hud.js), the rain that leans and the snow that drifts
// (rainRenderer.js), the smoke that drifts (campfireRenderer.js, particles.js), and the Pennant (pennants.js,
// pennantRenderer.js; its block, tile, recipe, picker entry and handbook page), and main's wiring.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  DRAWN_CALM, AIR_MS, SMOKE_CATCH, SMOKE_FLATTEN, RAIN_LEAN_MAX, SNOW_DRIFT_MS, RAIN_SWIRL_M, SNOW_SWIRL_M, VANE_LEVELS,
  VANE_GUST, VANE_CLASSES, drawnStrength, windAir, smokeDrift, smokeRise, dropDrift, dropSwirl, timeInCircle, vaneAngle,
  vaneLevel, vaneWords, vaneView,
} from '../../src/windDrawn.js';
import { windAt } from '../../src/wind.js';
import {
  Pennants, pennantKey, pennantSeed, poleHeight, flagLift, flagWave, flagRibbon, FLAG_FLOATS, PENNANT_SEGMENTS,
  PENNANT_POLE_TALL, PENNANT_POLE_SHORT, PENNANT_TIP, PENNANT_MAX_MODELS,
} from '../../src/pennants.js';
import { createPennantRenderer, PENNANT_COLORS, FLAG_TRIANGLES } from '../../src/pennantRenderer.js';
import { RainField, RAIN_RADIUS, RAIN_TOP, RAIN_ENTRY_RADIUS, RAIN_PATH_STEPS } from '../../src/rainRenderer.js';
import { createCampfireRenderer, SMOKE_PER_FIRE } from '../../src/campfireRenderer.js';
import { Campfires } from '../../src/campfires.js';
import { createParticles, PARTICLE_WIND } from '../../src/particles.js';
import {
  BLOCK, BLOCKS, TILE, PICKER_ORDER, LAYER_CUTOUT, isPlaceable, isSolid, isMeshed, getFaceTile, FACE_TOP,
} from '../../src/blocks.js';
import { paintTile, TILE_NAMES } from '../../src/tiles.js';
import { getItem, itemForBlock, blockForItem, TAGS } from '../../src/items.js';
import { getRecipe } from '../../src/crafting.js';
import { purposeOf, PURPOSE_MAX } from '../../src/purpose.js';
import { buildPickerModel, searchBlocks } from '../../src/pickerModel.js';
import { buildChapters, plainText } from '../../src/handbook.js';
import { createHUD } from '../../src/hud.js';
import { readSceneParam, WIND_SCENE } from '../../src/diagnostics.js';
import { worldToHex, hexToWorld } from '../../src/hex.js';
import { WORLD_HEIGHT } from '../../src/config.js';
import { mulberry32 } from '../../src/noise.js';
import { documentFromHTML } from '../helpers/fakeDom.js';

const read = (path) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

/** A wind blowing toward (x, z) (normalised), at `strength`, with `gust`. */
function wind(x, z, strength, gust = 0) {
  const len = Math.hypot(x, z);
  return { dir: Math.atan2(x, z), x: x / len, z: z / len, strength, speed: strength * 12, gust };
}
const EAST = (s, g = 0) => wind(1, 0, s, g); // blows toward +x, from the west
const CALM = wind(1, 0, 0.08);

// ---------------------------------------------------------------------------------------------------------------------

describe('the drawn wind (windDrawn.js)', () => {
  it('a calm is still: nothing drawn moves below DRAWN_CALM, then it rises evenly to 1', () => {
    expect(DRAWN_CALM).toBeGreaterThan(0.08); // above wind.WIND_MIN: the calmest wind draws nothing
    expect(drawnStrength(null)).toBe(0);
    expect(drawnStrength(CALM)).toBe(0);
    expect(drawnStrength(EAST(DRAWN_CALM))).toBe(0);
    expect(drawnStrength(EAST(1))).toBe(1);
    expect(drawnStrength(EAST(0.56))).toBeCloseTo((0.56 - DRAWN_CALM) / (1 - DRAWN_CALM), 9);
    expect(windAir(CALM)).toEqual([0, 0]);
    expect(windAir(null)).toEqual([0, 0]);
    const [ax, az] = windAir(EAST(1));
    expect(ax).toBeCloseTo(AIR_MS, 9);
    expect(az).toBeCloseTo(0, 9);
    expect(AIR_MS).toBeLessThan(12); // the drawn air is gentler than the real wind: the smoke stays readable
  });

  it('smoke leaves the fire upright and bends over downwind as it rises; on a calm day it rises straight', () => {
    expect(smokeDrift(0, 3, 0)).toEqual([0, 0]);
    const [x1] = smokeDrift(0.2, 3, 0);
    const [x2] = smokeDrift(1, 3, 0);
    const [x3] = smokeDrift(3, 3, 0);
    expect(x1).toBeGreaterThan(0);
    expect(x1).toBeLessThan(0.2 * 3 * 0.2); // it starts at rest: far less than the air's speed × age
    expect(x2 - x1).toBeLessThan(x3 - x2); // and gathers speed: the column curves
    expect(x3).toBeCloseTo(3 * (3 - (1 - Math.exp(-SMOKE_CATCH * 3)) / SMOKE_CATCH), 9);
    expect(x3).toBeGreaterThan(3); // a puff three seconds old has drifted metres away
    expect(smokeDrift(3, 0, -2)[1]).toBeLessThan(0); // it goes where the air goes
    expect(smokeDrift(2, 0, 0)).toEqual([0, 0]);
    expect(smokeRise(CALM)).toBe(1);
    expect(smokeRise(EAST(1))).toBeCloseTo(1 - SMOKE_FLATTEN, 9);
  });

  it('rain leans with the wind, in proportion to its fall; snow drifts much more; a calm is straight down', () => {
    expect(dropDrift(CALM, false, 15)).toEqual([0, 0]);
    expect(dropDrift(null, true, 1.5)).toEqual([0, 0]);
    const [rx] = dropDrift(EAST(1), false, 15);
    expect(rx / 15).toBeCloseTo(RAIN_LEAN_MAX, 9); // a lean of RAIN_LEAN_MAX metres sideways per metre fallen
    expect(Math.atan(RAIN_LEAN_MAX) * (180 / Math.PI)).toBeLessThan(35);
    const [sx] = dropDrift(EAST(1), true, 1.5);
    expect(sx).toBeCloseTo(SNOW_DRIFT_MS, 9);
    expect(sx / 1.5).toBeGreaterThan(2 * (rx / 15)); // snow drifts far more than rain leans
    const [, rz] = dropDrift(wind(0, -1, 0.7), false, 14);
    expect(rz).toBeLessThan(0);
    // gusts swirl: nothing without a gust or in a calm, more for snow
    expect(dropSwirl(EAST(1, 0), false)).toBe(0);
    expect(dropSwirl(wind(1, 0, 0.08, 1), false)).toBe(0);
    expect(dropSwirl(EAST(1, 1), false)).toBeCloseTo(RAIN_SWIRL_M, 9);
    expect(dropSwirl(EAST(1, 1), true)).toBeCloseTo(SNOW_SWIRL_M, 9);
  });

  it('timeInCircle: how long a drop has been inside the cylinder, back along its path', () => {
    expect(timeInCircle(0, 0, 0, 0, 0, 0, 5)).toBe(Infinity);
    expect(timeInCircle(6, 0, 1, 0, 0, 0, 5)).toBe(0);
    expect(timeInCircle(0, 0, 1, 0, 0, 0, 5)).toBeCloseTo(5, 9); // from the centre, moving +x at 1 m/s: entered at x = −5
    expect(timeInCircle(3, 0, 2, 0, 0, 0, 5)).toBeCloseTo(4, 9); // entered at x = −5, 8 m back at 2 m/s
    const t = timeInCircle(1, 2, 0.6, -0.8, 0.5, 0.5, 4);
    expect(Math.hypot(1 - 0.6 * t - 0.5, 2 + 0.8 * t - 0.5)).toBeCloseTo(4, 6);
  });
});

describe('the HUD vane: where the wind blows, seen from where the player looks', () => {
  // the player looks along (−sin yaw, −cos yaw): yaw 0 looks toward −z (north)
  it('up: at your back; down: in your face; right: it blows from your left to your right', () => {
    const north = wind(0, -1, 0.5); // blows toward −z
    expect(vaneAngle(north, 0)).toBeCloseTo(0, 9); // looking north, a wind blowing north is at your back
    expect(Math.abs(vaneAngle(wind(0, 1, 0.5), 0))).toBeCloseTo(Math.PI, 9); // a north wind blows in your face
    expect(vaneAngle(EAST(0.5), 0)).toBeCloseTo(Math.PI / 2, 9); // looking north, east is to your right
    expect(vaneAngle(wind(-1, 0, 0.5), 0)).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('turning to the right turns the vane to the left by as much: it stays fixed to the world', () => {
    const w = windAt(12345, 4321);
    for (const yaw of [0, 0.3, 1, 2.5, -1.2, 4]) {
      for (const d of [0.1, 0.5, 1.4]) {
        // the player turns right (clockwise seen from above) when yaw decreases
        const a0 = vaneAngle(w, yaw);
        const a1 = vaneAngle(w, yaw - d);
        const delta = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
        expect(delta).toBeCloseTo(-d, 9);
      }
      expect(vaneAngle(w, yaw)).toBeGreaterThan(-Math.PI);
      expect(vaneAngle(w, yaw)).toBeLessThanOrEqual(Math.PI);
    }
  });

  it('levels and words follow wind.windWord; the view rounds to whole degrees', () => {
    expect(VANE_LEVELS).toEqual([0.18, 0.4, 0.7]);
    expect(VANE_CLASSES).toEqual(['wind-calm', 'wind-light', 'wind-breeze', 'wind-strong']);
    expect([0.08, 0.2, 0.5, 0.9].map((s) => vaneLevel(EAST(s)))).toEqual([0, 1, 2, 3]);
    expect(vaneLevel(null)).toBe(0);
    expect(vaneWords(CALM)).toBe('Calm');
    expect(vaneWords(EAST(0.3))).toBe('A light breeze from the west');
    expect(vaneWords(wind(0, 1, 0.9))).toBe('A strong breeze from the north');
    const v = vaneView(EAST(0.5, 0.6), 0);
    expect(v).toEqual({ angle: 90, level: 2, gust: true, words: 'A breeze from the west' });
    expect(vaneView(EAST(0.5, VANE_GUST - 0.01), 0).gust).toBe(false);
    expect(vaneView(wind(1, 0, 0.1, 1), 0).gust).toBe(false); // no gust shown in a calm
    expect(vaneView(wind(-1, 0.001, 0.5), 0).angle).toBe(270); // 0..359
    const out = { angle: 0, level: 0, gust: false, words: '' };
    expect(vaneView(EAST(0.5), 0.0001, out)).toBe(out);
    expect(out.angle).toBe(90);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the HUD vane on the page (hud.js, index.html, styles.css)', () => {
  function page() {
    const doc = documentFromHTML(read('index.html'));
    const hud = createHUD(/** @type {*} */ (doc), /** @type {*} */ ({ width: 256, height: 256 }));
    return { doc, hud, el: /** @type {any} */ (doc.getElementById('wind-indicator')) };
  }

  it('hidden until told the wind; then a vane turned to the angle, sized by the level, and the words; null hides it', () => {
    const { hud, el } = page();
    expect(el).toBeTruthy();
    expect(el.classList.contains('hidden')).toBe(true);
    hud.setWind(vaneView(EAST(0.5), 0));
    expect(el.classList.contains('hidden')).toBe(false);
    expect(el.classList.contains('wind-breeze')).toBe(true);
    expect(el.classList.contains('wind-calm')).toBe(false);
    const arrow = el.querySelector('.wind-arrow');
    expect(arrow.getAttribute('transform')).toBe('rotate(90) scale(0.86)');
    expect(el.querySelector('.wind-words').textContent).toBe('A breeze from the west');
    expect(el.getAttribute('aria-label')).toBe('Wind: A breeze from the west');
    hud.setWind(vaneView(CALM, 0));
    expect(el.classList.contains('wind-calm')).toBe(true);
    expect(el.classList.contains('wind-breeze')).toBe(false);
    expect(el.querySelector('.wind-words').textContent).toBe('Calm');
    hud.setWind(vaneView(EAST(0.9, 0.8), Math.PI / 2)); // looking west: the east-going wind blows in your face
    expect(arrow.getAttribute('transform')).toBe('rotate(180) scale(1)');
    expect(el.classList.contains('wind-strong') && el.classList.contains('wind-gust')).toBe(true);
    hud.setWind(null);
    expect(el.classList.contains('hidden')).toBe(true);
    hud.dispose();
  });

  it('the DOM is touched only when the angle, the level, the gust or the words change', () => {
    const { doc, hud } = page();
    hud.setWind(vaneView(EAST(0.5), 0.3));
    const w = doc.writes;
    for (let i = 0; i < 50; i++) hud.setWind(vaneView(EAST(0.5), 0.3 + i * 1e-5)); // a turn too small to see
    expect(doc.writes).toBe(w);
    hud.setWind(vaneView(EAST(0.5), 0.4));
    expect(doc.writes).toBeGreaterThan(w);
    hud.dispose();
  });

  it('a page without the element still works (it is made)', () => {
    const doc = documentFromHTML(read('index.html').replace(/\s*<div id="wind-indicator"[^>]*><\/div>/, ''));
    expect(doc.getElementById('wind-indicator')).toBeNull();
    const hud = createHUD(/** @type {*} */ (doc), /** @type {*} */ ({ width: 256, height: 256 }));
    hud.setWind(vaneView(EAST(0.3), 0));
    expect(/** @type {any} */ (doc.getElementById('wind-indicator')).querySelector('.wind-words').textContent).toBe('A light breeze from the west');
    hud.dispose();
  });

  it('glass at the top centre: under the calendar line in Survival, under the top bar on a narrow tablet; it sways', () => {
    const css = read('src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (sel) => {
      const m = new RegExp(`(?:^|[}\\s])${sel.replace(/[.#()]/g, '\\$&')}\\{([^}]*)\\}`).exec(css);
      expect(m, sel).toBeTruthy();
      return Object.fromEntries(m[1].split(';').filter((d) => d.trim()).map((d) => d.split(/:(.*)/).slice(0, 2).map((x) => x.trim())));
    };
    const base = rule('.wind-indicator');
    expect([base.position, base.top, base.left, base['white-space']]).toEqual(['absolute', '6px', '50%', 'nowrap']);
    expect(base['backdrop-filter']).toBe(base['-webkit-backdrop-filter']);
    expect(base['border-radius']).toBe('999px');
    expect(rule('#hud.survival .wind-indicator').top).toBe('28px'); // the calendar line is 6..24 px
    expect(css).toMatch(/@media \(max-width:900px\)\{html\.touch \.wind-indicator\{top:calc\(88px/);
    expect(css).toMatch(/html\.touch #hud\.survival \.wind-indicator\{top:calc\(110px/);
    expect(css).toMatch(/@keyframes wind-sway\{/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\.wind-sway/);
    expect(rule('.wind-calm .wind-arrow').display).toBe('none');
    expect(read('index.html')).toContain('<div id="wind-indicator" class="wind-indicator hidden" role="img" aria-label="Wind"></div>');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const DT = 1 / 60;
function ground(over = () => undefined) {
  return (q, y, r) => {
    const o = over(q, y, r);
    if (o !== undefined) return o;
    return y >= 0 && y <= 63 ? BLOCK.GRASS_BLOCK : BLOCK.AIR;
  };
}
const EYE = { x: 0.2, y: 65.6, z: -0.3 };
const rainView = (getBlock, over = {}) => ({ ...EYE, intensity: 1, snow: false, getBlock, ...over });
function run(field, seconds, v, each) {
  for (let t = 0; t < seconds; t += DT) {
    field.update(DT, v);
    if (each) each();
  }
}

describe('the rain leans and the snow drifts (rainRenderer.js)', () => {
  it('without wind, or in a calm, the rain is exactly what it was: straight down', () => {
    const a = new RainField({ random: mulberry32(41) });
    const b = new RainField({ random: mulberry32(41) });
    const g = ground();
    run(a, 2, rainView(g));
    run(b, 2, rainView(g, { wind: CALM }));
    expect(Array.from(b.x)).toEqual(Array.from(a.x));
    expect(Array.from(b.y)).toEqual(Array.from(a.y));
    expect(Array.from(b.z)).toEqual(Array.from(a.z));
    expect(b.vx.every((v) => v === 0) && b.vz.every((v) => v === 0)).toBe(true);
  });

  it('in a wind every drop moves downwind as it falls, born upwind of where it lands, inside the cylinder', () => {
    const f = new RainField({ random: mulberry32(42) });
    const v = rainView(ground(), { wind: EAST(0.8) });
    const lean = RAIN_LEAN_MAX * drawnStrength(EAST(0.8));
    let checked = 0;
    /** @type {string[]} no expect() in the hot loop: the first few faults, reported once */
    const bad = [];
    run(f, 4, v, () => {
      for (let i = 0; i < f.max; i++) {
        if (!f.alive[i]) continue;
        checked++;
        const ok = f.vx[i] > 0 && Math.abs(f.vz[i]) < 1e-6 && Math.abs(f.vx[i] / f.speed[i] - lean) < 1e-5
          && Math.hypot(f.x[i] - EYE.x, f.z[i] - EYE.z) <= RAIN_RADIUS + 2 && f.y[i] <= EYE.y + RAIN_TOP + 1e-3 && f.y[i] > 64 - 1e-3;
        if (!ok && bad.length < 5) bad.push(`${i}: ${f.x[i]} ${f.y[i]} ${f.z[i]} v ${f.vx[i]} ${f.vz[i]} / ${f.speed[i]}`);
      }
    });
    expect(bad).toEqual([]);
    expect(checked).toBeGreaterThan(5000);
    expect(RAIN_ENTRY_RADIUS).toBeLessThan(RAIN_RADIUS + 2); // born inside the cylinder it is kept in
    // a streak's tail trails back up its path: upwind of its head
    const pos = new Float32Array((f.max + f.maxSplashes) * 12);
    const alpha = new Float32Array((f.max + f.maxSplashes) * 4);
    f.fill(pos, alpha, EYE.x, EYE.z);
    let leaning = 0;
    for (let i = 0; i < f.max; i++) {
      if (!f.alive[i]) continue;
      const p = pos.subarray(i * 12, i * 12 + 12);
      const headX = (p[0] + p[3]) / 2;
      const tailX = (p[6] + p[9]) / 2;
      expect(tailX - headX).toBeCloseTo(-(f.vx[i] / f.speed[i]) * f.size[i], 4);
      expect(p[7] - p[1]).toBeCloseTo(f.size[i], 4);
      leaning++;
    }
    expect(leaning).toBe(f.live);
  });

  it('a drop still lands where its column was looked at: under a slab roof in the wind, none is ever below the roof', () => {
    const roofed = (q, r) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= 4;
    const g = ground((q, y, r) => (y === 70 && roofed(q, r) ? BLOCK.OAK_PLANKS : undefined));
    const f = new RainField({ random: mulberry32(43) });
    let under = 0;
    let onRoof = 0;
    run(f, 10, rainView(g, { wind: EAST(1) }), () => {
      for (let i = 0; i < f.max; i++) {
        if (!f.alive[i]) continue;
        const [q, r] = worldToHex(f.x[i], f.z[i]);
        if (roofed(q, r)) {
          if (f.y[i] < 71 - 1e-3) under++;
          else onRoof++;
        }
      }
    });
    expect(under).toBe(0);
    expect(onRoof).toBeGreaterThan(500);
  });

  it('the lee of a wall is a rain shadow: drops never pass through it, and fewer land just behind it', () => {
    // a stone wall four cells high across the wind at x ≈ 2.5 (every cell whose centre lies within 0.6 of it)
    const wall = (q, y, r) => y >= 64 && y <= 67 && Math.abs(hexToWorld(q, r)[0] - 2.5) < 0.6;
    const g = ground((q, y, r) => (wall(q, y, r) ? BLOCK.STONE : undefined));
    const f = new RainField({ random: mulberry32(44) });
    let inside = 0;
    run(f, 10, rainView(g, { wind: EAST(1) }), () => {
      for (let i = 0; i < f.max; i++) {
        if (!f.alive[i]) continue;
        const [q, r] = worldToHex(f.x[i], f.z[i]);
        if (wall(q, Math.floor(f.y[i]), r)) inside++;
      }
    });
    expect(inside).toBe(0);
    // where the drops landing on the ground stand: just behind the wall (downwind) against just in front of it
    let lee = 0;
    let windward = 0;
    for (let i = 0; i < f.max; i++) {
      if (!f.alive[i] || f.floor[i] !== 64) continue;
      const landX = f.x[i] + f.vx[i] * ((f.y[i] - 64) / f.speed[i]);
      const landZ = f.z[i];
      if (Math.abs(landZ) > 6) continue;
      if (landX > 3.2 && landX < 4.4) lee++;
      if (landX > 0.6 && landX < 1.8) windward++;
    }
    expect(windward).toBeGreaterThan(5);
    expect(lee).toBeLessThan(windward / 2);
    expect(RAIN_PATH_STEPS).toBeLessThanOrEqual(12); // a bounded walk per drop
  });

  it('a frame of heavy rain in a full, gusting wind, walking, still costs well under a millisecond and its column looks', () => {
    let reads = 0;
    const base = ground();
    const g = (q, y, r) => {
      reads++;
      return base(q, y, r);
    };
    const f = new RainField({ random: mulberry32(46) });
    const v = rainView(g, { wind: wind(0.6, -0.8, 1, 1) });
    for (let i = 0; i < 300; i++) f.update(DT, v); // established
    const pos = new Float32Array((f.max + f.maxSplashes) * 12);
    const alpha = new Float32Array((f.max + f.maxSplashes) * 4);
    const FRAMES = 300;
    const reads0 = reads;
    const t0 = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      v.x += 0.07;
      f.update(DT, v);
      f.fill(pos, alpha, v.x, v.z);
    }
    const ms = (performance.now() - t0) / FRAMES;
    // measured on the development machine: about 0.2 ms a frame; the bound is loose for a busy one
    expect(ms).toBeLessThan(1);
    expect((reads - reads0) / FRAMES).toBeLessThanOrEqual(8 * WORLD_HEIGHT); // never more than RAIN_COLUMN_SCANS looks
    expect(f.live).toBeGreaterThan(f.max * 0.7);
  });

  it('snow drifts sideways far more than rain leans; gusts swirl the drawn drops to and fro', () => {
    const snow = new RainField({ random: mulberry32(45) });
    run(snow, 4, rainView(ground(), { snow: true, wind: EAST(0.8) }));
    let ratio = 0;
    let n = 0;
    for (let i = 0; i < snow.max; i++) {
      if (!snow.alive[i]) continue;
      ratio += snow.vx[i] / snow.speed[i];
      n++;
    }
    expect(n).toBeGreaterThan(50);
    expect(ratio / n).toBeGreaterThan(2 * RAIN_LEAN_MAX * drawnStrength(EAST(0.8)));
    // the same field drawn in a gust and without: the flakes are moved, by at most the swirl
    const draw = (field) => {
      const pos = new Float32Array((field.max + field.maxSplashes) * 12);
      field.fill(pos, new Float32Array((field.max + field.maxSplashes) * 4), EYE.x, EYE.z);
      return pos;
    };
    snow.swirl = 0;
    const still = draw(snow);
    snow.swirl = dropSwirl(EAST(0.8, 1), true);
    const swirled = draw(snow);
    let moved = 0;
    for (let i = 0; i < snow.max; i++) {
      if (!snow.alive[i]) continue;
      const d = Math.hypot(swirled[i * 12] - still[i * 12], swirled[i * 12 + 2] - still[i * 12 + 2]);
      expect(d).toBeLessThanOrEqual(snow.swirl * Math.SQRT2 + 0.1); // (a flake's width turns with it a little)
      if (d > 0.01) moved++;
    }
    expect(moved).toBeGreaterThan(n / 2);
    // the field remembers the swirl of the last update: none without a gust
    snow.update(DT, rainView(ground(), { snow: true, wind: EAST(0.8, 0) }));
    expect(snow.swirl).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

function fakeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, fillStyle: null }),
  };
}
function matrixPos(mesh, i) {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  return new THREE.Vector3().setFromMatrixPosition(m);
}

describe('the smoke drifts downwind (campfireRenderer.js, particles.js)', () => {
  function smokeAfter(w, seconds = 4) {
    const scene = new THREE.Scene();
    const cr = createCampfireRenderer(scene, { makeCanvas: /** @type {*} */ (fakeCanvas) });
    const c = new Campfires();
    c.add(0, 10, 0);
    const near = c.nearest(0, 11, 0, 64);
    const fire = near[0].fire;
    cr.setWind(w);
    for (let t = 0; t < seconds; t += 0.05) cr.sync(near, t, 0.05);
    const smoke = /** @type {THREE.InstancedMesh} */ (scene.getObjectByName('campfire-smoke'));
    const flame = /** @type {THREE.InstancedMesh} */ (scene.getObjectByName('campfire-flame-0'));
    const puffs = Array.from({ length: SMOKE_PER_FIRE }, (_, i) => matrixPos(smoke, i));
    const m = new THREE.Matrix4();
    flame.getMatrixAt(0, m);
    const tip = new THREE.Vector3(0, 0.5, 0).applyMatrix4(m);
    const base = new THREE.Vector3(0, 0, 0).applyMatrix4(m);
    cr.dispose();
    return { fire, puffs, tip, base };
  }

  it('on a calm day the column stands straight; in a breeze the high puffs lie far downwind, the low ones near the fire', () => {
    const calm = smokeAfter(CALM);
    for (const p of calm.puffs) expect(Math.hypot(p.x - calm.fire.x, p.z - calm.fire.z)).toBeLessThan(0.12 * 3.2 + 1e-6);
    const windy = smokeAfter(EAST(0.9));
    const byHeight = [...windy.puffs].sort((a, b) => a.y - b.y);
    const low = byHeight[0];
    const high = byHeight[byHeight.length - 1];
    expect(high.x - windy.fire.x).toBeGreaterThan(1.5);
    expect(high.x - windy.fire.x).toBeGreaterThan(low.x - windy.fire.x + 1);
    expect(Math.abs(high.z - windy.fire.z)).toBeLessThan(0.5);
    // it rises a little slower in a strong wind
    const calmTop = Math.max(...calm.puffs.map((p) => p.y));
    expect(Math.max(...windy.puffs.map((p) => p.y))).toBeLessThan(calmTop);
    // the flames lean downwind about their base
    expect(windy.tip.x - windy.base.x).toBeGreaterThan(0.02);
    expect(Math.abs(calm.tip.x - calm.base.x)).toBeLessThan(0.06);
    expect(windy.base.x).toBeCloseTo(calm.base.x, 6);
  });

  it('particles: smoke and steam are carried by the air, leaves a little, sparks not at all; still air changes nothing', () => {
    expect(PARTICLE_WIND).toMatchObject({ smoke: 1, steam: 1, sparks: 0, infall: 0 });
    expect(PARTICLE_WIND.leaves).toBeGreaterThan(PARTICLE_WIND.dust);
    const drift = (kind, ax) => {
      const p = createParticles(new THREE.Scene(), { capacity: 64, random: mulberry32(7) });
      p.setWind(ax, 0);
      p.emit(kind, 0, 10, 0, 32, { spread: 0 });
      for (let i = 0; i < 30; i++) p.update(1 / 60);
      const pos = p.points.geometry.getAttribute('position');
      let sum = 0;
      for (let i = 0; i < 32; i++) sum += pos.getX(i);
      p.dispose();
      return sum / 32;
    };
    expect(drift('smoke', 3) - drift('smoke', 0)).toBeGreaterThan(0.3);
    expect(drift('sparks', 3)).toBeCloseTo(drift('sparks', 0), 9);
    expect(drift('smoke', -3)).toBeLessThan(drift('smoke', 0));
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the Pennant\'s flag (pennants.js)', () => {
  const L = 0.7;
  const H = 0.38;
  const tip = (rib) => {
    const o = PENNANT_SEGMENTS * 6;
    return { x: (rib[o] + rib[o + 3]) / 2, y: (rib[o + 1] + rib[o + 4]) / 2, z: (rib[o + 2] + rib[o + 5]) / 2 };
  };

  it('hangs limp in a calm, lifts in a light breeze, streams straight out in a breeze', () => {
    expect(flagLift(0.08)).toBe(0);
    expect(flagLift(0.3)).toBeGreaterThan(0.4);
    expect(flagLift(0.7)).toBe(1);
    for (let s = 0; s < 1; s += 0.05) expect(flagLift(s + 0.05)).toBeGreaterThanOrEqual(flagLift(s));
    const limp = tip(flagRibbon(0.08, 0, 0, 0, L, H));
    const out = tip(flagRibbon(0.9, 0, 0, 0, L, H));
    expect(limp.y).toBeLessThan(-H / 2 - 0.6 * L); // the fly hangs well below the hoist
    expect(limp.x).toBeLessThan(0.3 * L);
    expect(out.x).toBeGreaterThan(0.95 * L); // straight out downwind
    expect(Math.abs(out.y + H / 2)).toBeLessThan(0.08 * L); // level with the middle of the hoist
    // in between, the stronger the wind, the farther out the tip
    let last = -Infinity;
    for (const s of [0.1, 0.2, 0.3, 0.45, 0.6, 0.8]) {
      const t = tip(flagRibbon(s, 0, 0, 0, L, H));
      expect(t.x).toBeGreaterThan(last - 1e-9);
      last = t.x;
    }
  });

  it('the hoist stays on the pole, upright; the cloth tapers to a point; nothing is NaN', () => {
    for (const s of [0.08, 0.3, 1]) {
      const rib = flagRibbon(s, 0.5, 3.3, 1.7, L, H);
      expect(rib).toHaveLength(FLAG_FLOATS);
      expect(Array.from(rib).every(Number.isFinite)).toBe(true);
      for (const k of [0, 1, 2]) expect(rib[k]).toBeCloseTo(0, 9); // the top of the hoist, under the knob
      expect(rib[3]).toBeCloseTo(0, 9);
      expect(rib[4]).toBeCloseTo(-H, 6);
      expect(rib[5]).toBeCloseTo(0, 9);
      const o = PENNANT_SEGMENTS * 6;
      const tipEdge = Math.hypot(rib[o] - rib[o + 3], rib[o + 1] - rib[o + 4], rib[o + 2] - rib[o + 5]);
      expect(tipEdge).toBeCloseTo(H * PENNANT_TIP, 6);
    }
  });

  it('a wave runs along it: quicker and wider in a gust; deterministic; neighbours do not wave in step', () => {
    const swing = (s, g) => {
      let most = 0;
      for (let t = 0; t < 3; t += 0.05) most = Math.max(most, Math.abs(tip(flagRibbon(s, g, t, 0, L, H)).z));
      return most;
    };
    expect(swing(0.6, 1)).toBeGreaterThan(1.5 * swing(0.6, 0));
    expect(swing(0.08, 0)).toBeGreaterThan(0); // a calm still sways a little
    expect(swing(0.08, 0)).toBeLessThan(swing(0.8, 0));
    expect(flagWave(0.9, 1, L).omega).toBeGreaterThan(flagWave(0.1, 0, L).omega);
    expect(Array.from(flagRibbon(0.5, 0.3, 2, 1, L, H))).toEqual(Array.from(flagRibbon(0.5, 0.3, 2, 1, L, H)));
    expect(tip(flagRibbon(0.5, 0.3, 2, pennantSeed(1, 10, 2), L, H)).z)
      .not.toBeCloseTo(tip(flagRibbon(0.5, 0.3, 2, pennantSeed(2, 10, 2), L, H)).z, 3);
  });

  it('the pole stands tall under the open sky and short under a block', () => {
    expect(poleHeight(BLOCK.AIR)).toBe(PENNANT_POLE_TALL);
    expect(poleHeight(BLOCK.OAK_LEAVES)).toBe(PENNANT_POLE_SHORT);
    expect(PENNANT_POLE_SHORT).toBeLessThan(1); // it never pokes into the block above
  });
});

describe('the Pennants tracker (pennants.js)', () => {
  it('follows World.onBlockChange and World.edits, and lists the nearest first', () => {
    const p = new Pennants();
    p.onBlockChange(0, 10, 0, BLOCK.AIR, BLOCK.PENNANT);
    p.onBlockChange(5, 10, 0, BLOCK.AIR, BLOCK.PENNANT);
    p.onBlockChange(5, 10, 0, BLOCK.PENNANT, BLOCK.PENNANT); // no change
    p.onBlockChange(9, 10, 9, BLOCK.AIR, BLOCK.STONE);
    expect(p.size).toBe(2);
    expect(p.has(5, 10, 0)).toBe(true);
    const near = p.nearest(4, 11, 0, 64);
    expect(near.map((n) => n.pennant.key)).toEqual([pennantKey(5, 10, 0), pennantKey(0, 10, 0)]);
    expect(p.nearest(4, 11, 0, 2)).toHaveLength(1);
    expect(p.nearest(4, 11, 0, 64, 1)).toHaveLength(1);
    const [x, z] = hexToWorld(5, 0);
    expect(near[0].pennant).toMatchObject({ q: 5, y: 10, r: 0, x, z });
    expect(near[0].pennant.seed).toBeGreaterThanOrEqual(0);
    expect(near[0].pennant.seed).toBeLessThan(Math.PI * 2);
    p.onBlockChange(0, 10, 0, BLOCK.PENNANT, BLOCK.AIR);
    expect(p.size).toBe(1);
    // World.edits: chunk key → Map(local index → id)
    const edits = new Map([['0,0', new Map([[3 * 16 * 16 + 1, BLOCK.PENNANT], [7, BLOCK.STONE]])]]);
    p.loadFromEdits(/** @type {*} */ (edits));
    expect(p.size).toBe(1);
  });
});

describe('the Pennants drawn (pennantRenderer.js)', () => {
  function two(heights = [PENNANT_POLE_TALL, PENNANT_POLE_SHORT]) {
    const p = new Pennants();
    p.add(0, 10, 0);
    p.add(4, 10, 0);
    const near = p.nearest(0, 11, 0, 64);
    const heightOf = (pn) => (pn.q === 0 ? heights[0] : heights[1]);
    return { near, heightOf };
  }

  it('four draw calls: the feet, the poles, the knobs and every flag in one geometry; nothing drawn without pennants', () => {
    const scene = new THREE.Scene();
    const r = createPennantRenderer(scene);
    const group = scene.getObjectByName('pennants');
    expect(group).toBe(r.group);
    const meshes = [];
    group.traverse((o) => { if (o.isMesh) meshes.push(o); });
    expect(meshes.map((m) => m.name).sort()).toEqual(['pennant-feet', 'pennant-flags', 'pennant-knobs', 'pennant-poles']);
    expect(meshes.every((m) => !m.visible)).toBe(true);
    const { near, heightOf } = two();
    r.sync(near, EAST(0.8), 1, heightOf);
    expect(r.count()).toBe(2);
    expect(meshes.every((m) => m.visible)).toBe(true);
    const flags = /** @type {THREE.Mesh} */ (scene.getObjectByName('pennant-flags'));
    expect(flags.geometry.drawRange.count).toBe(2 * FLAG_TRIANGLES * 3);
    expect(/** @type {THREE.InstancedMesh} */ (scene.getObjectByName('pennant-poles')).count).toBe(2);
    expect(scene.children.some((o) => o.isLight)).toBe(false); // it adds no light (no program key changes)
    r.sync([], EAST(0.8), 2, heightOf);
    expect(meshes.every((m) => !m.visible)).toBe(true);
    expect(r.count()).toBe(0);
    r.dispose();
    expect(scene.getObjectByName('pennants')).toBeUndefined();
  });

  it('the flag streams out downwind from the top of its pole, honey with a teal band, lit and faceted', () => {
    const scene = new THREE.Scene();
    const r = createPennantRenderer(scene);
    const { near, heightOf } = two();
    const fp = near.find((n) => n.pennant.q === 0).pennant;
    const index = near.findIndex((n) => n.pennant.q === 0);
    const flagPoints = () => {
      const pos = /** @type {THREE.Mesh} */ (scene.getObjectByName('pennant-flags')).geometry.getAttribute('position');
      const pts = [];
      for (let v = index * FLAG_TRIANGLES * 3; v < (index + 1) * FLAG_TRIANGLES * 3; v++) pts.push([pos.getX(v), pos.getY(v), pos.getZ(v)]);
      return pts;
    };
    r.sync(near, wind(0, -1, 0.9), 0.5, heightOf); // blowing north (−z)
    let pts = flagPoints();
    expect(Math.min(...pts.map((p) => p[2]))).toBeLessThan(fp.z - 0.5); // streams out to the north
    expect(Math.max(...pts.map((p) => p[2]))).toBeLessThan(fp.z + 0.01);
    expect(Math.max(...pts.map((p) => p[1]))).toBeLessThanOrEqual(fp.y + PENNANT_POLE_TALL + 1e-6); // under the knob
    expect(Math.min(...pts.map((p) => p[1]))).toBeGreaterThan(fp.y + PENNANT_POLE_TALL * 0.6);
    r.sync(near, CALM, 0.5, heightOf); // a calm: it hangs down the pole
    pts = flagPoints();
    expect(Math.min(...pts.map((p) => p[1]))).toBeLessThan(fp.y + PENNANT_POLE_TALL * 0.55);
    expect(Math.max(...pts.map((p) => Math.hypot(p[0] - fp.x, p[2] - fp.z)))).toBeLessThan(0.45);
    const mat = /** @type {THREE.MeshLambertMaterial} */ (/** @type {THREE.Mesh} */ (scene.getObjectByName('pennant-flags')).material);
    expect([mat.isMeshLambertMaterial, mat.flatShading, mat.side, mat.vertexColors]).toEqual([true, true, THREE.DoubleSide, true]);
    const col = /** @type {THREE.Mesh} */ (scene.getObjectByName('pennant-flags')).geometry.getAttribute('color');
    const seen = new Set();
    const c = new THREE.Color();
    for (let v = 0; v < FLAG_TRIANGLES * 3; v++) seen.add(c.setRGB(col.getX(v), col.getY(v), col.getZ(v)).getHex(THREE.SRGBColorSpace));
    expect([...seen].sort()).toEqual([PENNANT_COLORS.teal, PENNANT_COLORS.honey].sort());
    // the poles stand on their cells' floors, each as tall as it is given
    const poles = /** @type {THREE.InstancedMesh} */ (scene.getObjectByName('pennant-poles'));
    const m = new THREE.Matrix4();
    poles.getMatrixAt(index, m);
    expect(new THREE.Vector3().setFromMatrixScale(m).y).toBeCloseTo(PENNANT_POLE_TALL, 6);
    expect(new THREE.Vector3().setFromMatrixPosition(m).y).toBeCloseTo(10, 6);
    r.dispose();
  });

  it('at most its capacity; prewarm compiles every mesh and leaves nothing drawn', async () => {
    const scene = new THREE.Scene();
    const r = createPennantRenderer(scene, { capacity: 1 });
    const { near, heightOf } = two();
    r.sync(near, EAST(0.5), 0, heightOf);
    expect(r.count()).toBe(1);
    r.sync([], EAST(0.5), 0, heightOf);
    const log = [];
    const webgl = {
      compileAsync(obj) {
        const seen = [];
        obj.traverse((o) => { if (o.isMesh) seen.push({ visible: o.visible }); });
        log.push(seen);
        return Promise.resolve();
      },
    };
    await r.prewarm(webgl, new THREE.PerspectiveCamera());
    expect(log).toHaveLength(1);
    expect(log[0]).toHaveLength(4);
    expect(log[0].every((m) => m.visible)).toBe(true);
    r.group.traverse((o) => { if (/** @type {*} */ (o).isMesh) expect(o.visible).toBe(false); });
    expect(PENNANT_MAX_MODELS).toBeGreaterThanOrEqual(8);
    r.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the Pennant: block, picture, item, recipe, picker, purpose, handbook', () => {
  it('block 178, appended: walk-through like the torch, drawn by its own renderer, a flat icon, placeable', () => {
    expect(BLOCK.PENNANT).toBe(178);
    const d = BLOCKS[BLOCK.PENNANT];
    expect([d.name, d.displayName, d.solid, d.opaque, d.layer, d.meshed, d.icon, d.soundGroup])
      .toEqual(['pennant', 'Pennant', false, false, LAYER_CUTOUT, false, 'flat', 'cloth']);
    expect(isPlaceable(BLOCK.PENNANT) && !isSolid(BLOCK.PENNANT) && !isMeshed(BLOCK.PENNANT)).toBe(true);
    expect(getFaceTile(BLOCK.PENNANT, FACE_TOP)).toBe(TILE.PENNANT);
    const i = PICKER_ORDER.indexOf(BLOCK.PENNANT);
    expect(PICKER_ORDER[i - 1]).toBe(BLOCK.RAIN_BARREL);
    expect(PICKER_ORDER[i + 1]).toBe(BLOCK.CAMPFIRE);
  });

  it('its picture (tile 107): a pole on a stone foot, a honey pennant with a teal band, on clear', () => {
    expect(TILE.PENNANT).toBe(107);
    expect(TILE_NAMES[107]).toBe('pennant');
    const px = paintTile(TILE.PENNANT);
    const at = (x, y) => (px[(y * 16 + x) * 4] << 16) | (px[(y * 16 + x) * 4 + 1] << 8) | px[(y * 16 + x) * 4 + 2];
    const alpha = (x, y) => px[(y * 16 + x) * 4 + 3];
    expect(alpha(15, 15)).toBe(0);
    expect(alpha(15, 0)).toBe(0);
    let honey = 0;
    let teal = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (alpha(x, y) !== 255) continue;
        if (at(x, y) === 0xf2b33d) honey++;
        if (at(x, y) === 0x2f9e8f) teal++;
      }
    }
    expect(honey).toBeGreaterThan(15);
    expect(teal).toBeGreaterThan(10);
    expect(alpha(3, 12) && alpha(4, 12)).toBe(255); // the pole
  });

  it('an item, made by hand from a stick, cord and a rag or a hide; a purpose line; in the picker\'s Camp & Crafts', () => {
    expect(getItem('pennant')).toMatchObject({ key: 'pennant', name: 'Pennant', kind: 'block', stack: 64, block: BLOCK.PENNANT });
    expect(itemForBlock(BLOCK.PENNANT)).toBe('pennant');
    expect(blockForItem('pennant')).toBe(BLOCK.PENNANT);
    expect(TAGS.cloth).toEqual(['grave_rag', 'rawhide', 'leather']);
    const rec = getRecipe('pennant');
    expect(rec).toMatchObject({ station: 'hand', inputs: [{ k: 'stick', n: 1 }, { k: 'cord', n: 1 }, { tag: 'cloth', n: 1 }],
      outputs: [{ k: 'pennant', n: 1 }], tools: [] });
    expect(purposeOf('pennant').length).toBeGreaterThan(0);
    expect(purposeOf('pennant').length).toBeLessThanOrEqual(PURPOSE_MAX);
    const model = buildPickerModel();
    const camp = model.sections.find((s) => s.id === 'camp');
    expect(camp.entries).toContainEqual({ type: 'block', id: BLOCK.PENNANT });
    for (const q of ['pennant', 'flag', 'wind', 'banner']) expect(searchBlocks(model, q), q).toContain(BLOCK.PENNANT);
  });

  it('the handbook\'s page on the wind: the vane, the rain and the smoke, the Pennant\'s recipe, stalking into the wind', () => {
    const chapter = buildChapters().find((c) => c.id === 'seasons');
    const page = chapter.pages.find((pg) => pg.some((b) => b.kind === 'h' && b.text === 'The wind'));
    expect(page).toBeTruthy();
    const text = page.flatMap((b) => ('text' in b ? [plainText(b.text)] : b.kind === 'list' ? b.items.map(plainText) : [])).join('\n');
    expect(text).toContain('The vane');
    expect(text).toContain('in your face');
    expect(text).toContain('Rain leans with the wind');
    expect(text).toContain('Smoke drifts downwind');
    expect(text).toContain('A Pennant shows the wind where you set it. Make one by hand: a rag or a hide lashed to a Stick with Cord.');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the wiring (main.js, diagnostics.js): read from the source, since main needs a browser', () => {
  const main = read('src/main.js');
  const body = (name) => {
    const at = main.indexOf(`  function ${name}(`);
    expect(at, name).toBeGreaterThan(0);
    return main.slice(at, main.indexOf('\n  }\n', at));
  };

  it('stepWeather draws the wind here and now: the vane, the rain, the smoke and the particles all read windNow()', () => {
    const step = body('stepWeather');
    expect(step).toContain('const wind = windNow();');
    expect(step).toContain('hud.setWind(vaneView(wind, controls.yaw, vaneNow));');
    expect(step).toContain('campfireRenderer.setWind(wind);');
    expect(step).toContain('particles.setWind(windAirNow[0], windAirNow[1]);');
    expect(step).toMatch(/rainRenderer\.update\([^;]*wind,\s*\}\);/);
    // the wind is worked out after this frame's shower, which it rises with
    expect(step.indexOf('fx.falling =')).toBeLessThan(step.indexOf('const wind = windNow();'));
    expect(main.match(/windAt\(/g)).toHaveLength(1); // only windNow works the wind out: it is not duplicated
  });

  it('the pennants are tracked like the campfires and drawn every frame; the renderer exists before every prewarm', () => {
    expect(main).toContain('pennants.onBlockChange(q, y, r, prev, next);');
    expect(main).toContain('pennants.loadFromEdits(world.edits);');
    expect(main).toContain('pennantRenderer.sync(nearP, windNow(), fxTime, pennantHeight);');
    const created = main.indexOf('pennantRenderer = createPennantRenderer(renderer.three.scene);');
    expect(created).toBeGreaterThan(0);
    for (const name of ['campfireRenderer', 'particles', 'rainRenderer', 'watcherRenderer', 'pennantRenderer']) {
      expect(created, name).toBeLessThan(main.indexOf(`${name}.prewarm(`));
    }
  });

  it('?scene=wind and ?scene=wind-rain: a campfire and two pennants ahead (and the rain)', () => {
    const p = (s) => readSceneParam(new URLSearchParams(s));
    expect([p('scene=wind'), p('scene=WIND-rain'), p('scene=windy'), p('')]).toEqual(['wind', 'wind-rain', null, null]);
    expect(WIND_SCENE.map((s) => s[0])).toEqual(['campfire', 'pennant', 'far-pennant']);
    for (const [, ahead] of WIND_SCENE) expect(ahead).toBeGreaterThan(2);
    const build = body('buildWindScene');
    expect(build).toContain("BLOCK.PENNANT");
    expect(build).toContain("theWeather().force('rain')");
    expect(read('README.md')).toContain('`?scene=wind` / `?scene=wind-rain`');
    expect(WORLD_HEIGHT).toBeGreaterThan(8);
  });
});
