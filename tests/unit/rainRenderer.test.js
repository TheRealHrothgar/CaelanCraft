// src/rainRenderer.js (CONTRACTS §84.5): rain and snow as they are drawn. The budget (a fixed pool of drops and of
// splashes, one mesh, one draw call, a bounded number of world looks an update), where drops may be (never under a roof,
// fewer under leaves), how their number follows the rain, the splashes, the flakes, and what an update costs.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  RainField, createRainRenderer, RAIN_MAX_DROPS, RAIN_MAX_SPLASHES, RAIN_RADIUS, RAIN_TOP, RAIN_SPEED, RAIN_LENGTH, RAIN_WIDTH,
  SNOW_SPEED, SNOW_SIZE, SNOW_SWAY, SNOW_DENSITY, SPLASH_RANGE, SPLASH_S, SPLASH_SIZE, RAIN_COLUMN_SCANS, RAIN_COLUMN_TTL_S,
  RAIN_COLUMNS_KEPT, RAIN_BIRTHS, RAIN_COLOR, SNOW_COLOR, RAIN_ALPHA, SNOW_ALPHA, RAIN_NIGHT_LIGHT, RAIN_NEAR_ANGLE,
  SNOW_NEAR_ANGLE, RAIN_NEAR_M, RAIN_NEAR_ALPHA,
} from '../../src/rainRenderer.js';
import { LEAF_COVER } from '../../src/weather.js';
import { BLOCK } from '../../src/blocks.js';
import { PARTICLE_CAPACITY, WORLD_HEIGHT } from '../../src/config.js';
import { worldToHex } from '../../src/hex.js';
import { mulberry32 } from '../../src/noise.js';

const B = BLOCK;
const DT = 1 / 60;
/** Flat ground with its top at y = 64 (the cells up to 63 are `id`), and what `over(q, y, r)` lays over it. */
function ground(over = () => undefined, id = B.GRASS_BLOCK) {
  const getBlock = (q, y, r) => {
    getBlock.reads++;
    const o = over(q, y, r);
    if (o !== undefined) return o;
    return y >= 0 && y <= 63 ? id : B.AIR;
  };
  getBlock.reads = 0;
  return getBlock;
}
const EYE = { x: 0.2, y: 65.6, z: -0.3 };
const view = (getBlock, over = {}) => ({ ...EYE, intensity: 1, snow: false, getBlock, ...over });
function run(field, seconds, v, each) {
  for (let t = 0; t < seconds; t += DT) {
    field.update(DT, v);
    if (each) each();
  }
}
const liveDrops = (f) => {
  const out = [];
  for (let i = 0; i < f.max; i++) if (f.alive[i]) out.push({ x: f.x[i], y: f.y[i], z: f.z[i], floor: f.floor[i], speed: f.speed[i], size: f.size[i], flake: f.flake[i] });
  return out;
};

describe('the budget (§84.5)', () => {
  it('a small fixed pool: 480 drops and 48 splashes, a quarter of the particle system\'s points', () => {
    expect(RAIN_MAX_DROPS).toBe(480);
    expect(RAIN_MAX_SPLASHES).toBe(48);
    expect(RAIN_MAX_DROPS + RAIN_MAX_SPLASHES).toBeLessThanOrEqual(PARTICLE_CAPACITY / 2);
    const f = new RainField({ random: mulberry32(1) });
    expect(f.max).toBe(RAIN_MAX_DROPS);
    expect(f.x).toHaveLength(RAIN_MAX_DROPS);
    expect(f.sx).toHaveLength(RAIN_MAX_SPLASHES);
  });

  it('never more drops or splashes than the pool, however long and hard it rains; the arrays never grow', () => {
    const f = new RainField({ random: mulberry32(2) });
    const arrays = [f.x, f.y, f.z, f.floor, f.speed, f.size, f.alive, f.sx, f.sAge];
    const g = ground();
    let most = 0;
    let mostSplashes = 0;
    run(f, 20, view(g), () => {
      most = Math.max(most, f.live);
      mostSplashes = Math.max(mostSplashes, f.splashes);
      expect(f.live).toBe(liveDrops(f).length);
    });
    expect(most).toBeLessThanOrEqual(RAIN_MAX_DROPS);
    expect(most).toBeGreaterThan(RAIN_MAX_DROPS * 0.9); // and a heavy rain uses it
    expect(mostSplashes).toBeLessThanOrEqual(RAIN_MAX_SPLASHES);
    expect(mostSplashes).toBeGreaterThan(8);
    expect([f.x, f.y, f.z, f.floor, f.speed, f.size, f.alive, f.sx, f.sAge]).toEqual(arrays);
    for (let i = 0; i < arrays.length; i++) expect([f.x, f.y, f.z, f.floor, f.speed, f.size, f.alive, f.sx, f.sAge][i]).toBe(arrays[i]);
  });

  it('an update looks at RAIN_COLUMN_SCANS columns at the most, and bears RAIN_BIRTHS drops at the most', () => {
    expect(RAIN_COLUMN_SCANS).toBeLessThanOrEqual(8);
    const f = new RainField({ random: mulberry32(3) });
    const g = ground();
    let worstReads = 0;
    let worstBirths = 0;
    for (let i = 0; i < 600; i++) {
      const before = g.reads;
      const live = f.live;
      f.update(DT, view(g));
      expect(f.scans).toBeLessThanOrEqual(RAIN_COLUMN_SCANS);
      worstReads = Math.max(worstReads, g.reads - before);
      worstBirths = Math.max(worstBirths, f.live - live);
    }
    expect(worstReads).toBeLessThanOrEqual(RAIN_COLUMN_SCANS * WORLD_HEIGHT);
    expect(worstBirths).toBeLessThanOrEqual(RAIN_BIRTHS);
    // the columns are remembered: once the rain is established an update reads far less than its allowance
    let reads = 0;
    for (let i = 0; i < 120; i++) {
      const before = g.reads;
      f.update(DT, view(g));
      reads += g.reads - before;
    }
    expect(reads / 120).toBeLessThan(RAIN_COLUMN_SCANS * WORLD_HEIGHT * 0.6);
    expect(f.columns.size).toBeLessThanOrEqual(RAIN_COLUMNS_KEPT);
    expect(f.columns.size).toBeGreaterThan(100); // the disc round the eye: some hundreds of columns
  });

  it('the remembered columns are bounded while the player travels, and a column is looked at again after its time', () => {
    const f = new RainField({ random: mulberry32(4) });
    const g = ground();
    const v = view(g);
    for (let i = 0; i < 4000; i++) {
      v.x += 0.4; // 24 m/s: faster than anything in the game
      f.update(DT, v);
      expect(f.columns.size).toBeLessThanOrEqual(RAIN_COLUMNS_KEPT);
    }
    expect(RAIN_COLUMN_TTL_S).toBeGreaterThan(0.5);
    expect(RAIN_COLUMN_TTL_S).toBeLessThanOrEqual(3); // a new roof stops the rain under it within seconds
  });

  it('one mesh of quads in one geometry: one draw call, whatever the weather', () => {
    const scene = new THREE.Scene();
    const before = scene.children.length;
    const rr = createRainRenderer(scene, { random: mulberry32(5) });
    expect(scene.children.length).toBe(before + 1);
    expect(rr.mesh.isMesh).toBe(true);
    expect(rr.mesh.name).toBe('rain');
    const quads = RAIN_MAX_DROPS + RAIN_MAX_SPLASHES;
    expect(rr.mesh.geometry.getAttribute('position').count).toBe(quads * 4);
    expect(rr.mesh.geometry.getAttribute('color').itemSize).toBe(4); // rgb and the alpha a tail fades with
    expect(rr.mesh.geometry.getIndex().count).toBe(quads * 6);
    expect(Array.isArray(rr.mesh.material)).toBe(false);
    expect(rr.mesh.visible).toBe(false); // nothing falls yet
    const g = ground();
    for (let i = 0; i < 240; i++) rr.update(DT, { ...view(g), daylight: 1 });
    expect(rr.mesh.visible).toBe(true);
    expect(rr.count()).toBeGreaterThan(300);
    expect(rr.mesh.geometry.getAttribute('position').count).toBe(quads * 4); // the same buffers
    expect(scene.children.length).toBe(before + 1);
    // unlit, fogged, drawn with the particles after the water; it writes no depth
    const m = /** @type {THREE.MeshBasicMaterial} */ (rr.mesh.material);
    expect(m.isMeshBasicMaterial && m.transparent && m.fog && m.vertexColors && !m.depthWrite).toBe(true);
    expect(rr.mesh.renderOrder).toBe(3);
    rr.clear();
    expect(rr.mesh.visible).toBe(false);
    expect(rr.count()).toBe(0);
    rr.dispose();
    expect(scene.children.length).toBe(before);
  });
});

describe('where the drops are (§84.5)', () => {
  it('under the open sky they fall round the eye, from above it down to the ground', () => {
    const f = new RainField({ random: mulberry32(6) });
    run(f, 6, view(ground()), () => {
      for (const d of liveDrops(f)) {
        expect(Math.hypot(d.x - EYE.x, d.z - EYE.z)).toBeLessThanOrEqual(RAIN_RADIUS + 1e-3);
        expect(d.y).toBeLessThanOrEqual(EYE.y + RAIN_TOP + 1e-3);
        expect(d.y).toBeGreaterThan(64 - 1e-3); // the ground's top: never through it
        expect(d.floor).toBe(64);
        expect(d.speed).toBeGreaterThanOrEqual(RAIN_SPEED[0]);
        expect(d.speed).toBeLessThanOrEqual(RAIN_SPEED[1]);
        expect(d.size).toBeGreaterThanOrEqual(RAIN_LENGTH[0] - 1e-6);
        expect(d.size).toBeLessThanOrEqual(RAIN_LENGTH[1] + 1e-6);
      }
    });
    // spread over the whole disc, not bunched: every quarter has drops, near and far
    const drops = liveDrops(f);
    const quarters = [0, 0, 0, 0];
    let near = 0;
    for (const d of drops) {
      quarters[(d.x > EYE.x ? 1 : 0) + (d.z > EYE.z ? 2 : 0)]++;
      if (Math.hypot(d.x - EYE.x, d.z - EYE.z) < RAIN_RADIUS / 2) near++;
    }
    for (const n of quarters) expect(n).toBeGreaterThan(drops.length / 8);
    expect(near / drops.length).toBeGreaterThan(0.15);
    expect(near / drops.length).toBeLessThan(0.35); // a quarter of the disc's area
  });

  it('never under a roof: under a slab of planks six cells up no drop is ever below the slab\'s top', () => {
    // a roof over every column within 4 cells of the origin, at y = 70; open sky beyond
    const roofed = (q, r) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= 4;
    const g = ground((q, y, r) => (y === 70 && roofed(q, r) ? B.OAK_PLANKS : undefined));
    const f = new RainField({ random: mulberry32(7) });
    let underRoof = 0;
    let outside = 0;
    run(f, 12, view(g), () => {
      for (const d of liveDrops(f)) {
        const [q, r] = worldToHex(d.x, d.z);
        if (roofed(q, r)) {
          underRoof++;
          expect(d.y).toBeGreaterThan(71 - 1e-3); // it lands on the roof
          expect(d.floor).toBe(71);
        } else {
          outside++;
          expect(d.floor).toBe(64);
        }
      }
    });
    expect(underRoof).toBeGreaterThan(1000); // the rain does fall on the roof
    expect(outside).toBeGreaterThan(10000);
  });

  it('a glass roof is a roof; a roof far above the eye lets no drop appear under it at all', () => {
    const glass = ground((_q, y) => (y === 68 ? B.GLASS : undefined));
    const f = new RainField({ random: mulberry32(8) });
    run(f, 4, view(glass), () => {
      for (const d of liveDrops(f)) expect(d.y).toBeGreaterThan(69 - 1e-3);
    });
    expect(f.live).toBeGreaterThan(100);
    const high = ground((_q, y) => (y === 110 ? B.STONE : undefined));
    const h = new RainField({ random: mulberry32(8) });
    let most = 0;
    run(h, 4, view(high), () => {
      most = Math.max(most, h.live);
    });
    expect(most).toBe(0); // the roof is above the top of the rain's cylinder: nothing to draw
  });

  it('a tree is partial cover: about LEAF_COVER of the drops over it come through, the rest stop on the canopy', () => {
    // leaves over everything at y = 68..69 (well under the top of the cylinder)
    const g = ground((q, y) => (y === 68 || y === 69 ? B.OAK_LEAVES : undefined));
    const f = new RainField({ random: mulberry32(9) });
    let through = 0;
    let stopped = 0;
    const seen = new Set();
    run(f, 20, view(g), () => {
      for (let i = 0; i < f.max; i++) {
        if (!f.alive[i]) continue;
        const id = `${i}:${f.x[i]}:${f.z[i]}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (f.floor[i] === 64) through++;
        else {
          stopped++;
          expect(f.floor[i]).toBe(70); // on top of the highest leaves
        }
      }
    });
    const share = through / (through + stopped);
    expect(through + stopped).toBeGreaterThan(2000);
    expect(share).toBeGreaterThan(LEAF_COVER - 0.05);
    expect(share).toBeLessThan(LEAF_COVER + 0.05);
    // so under the leaves there are fewer drops than under the open sky
    const below = liveDrops(f).filter((d) => d.y < 68).length;
    const open = new RainField({ random: mulberry32(9) });
    run(open, 20, view(ground()));
    expect(below).toBeLessThan(liveDrops(open).filter((d) => d.y < 68).length * 0.6);
  });

  it('rain lands on water at its surface, and passes what is not solid (a plant, a fire)', () => {
    const g = ground((q, y) => (y === 64 ? (q > 0 ? B.WATER : B.TUSSOCK_GRASS) : undefined));
    const f = new RainField({ random: mulberry32(10) });
    run(f, 5, view(g));
    const floors = new Set(liveDrops(f).map((d) => +d.floor.toFixed(3)));
    expect([...floors].sort()).toEqual([64, 64.9]);
  });
});

describe('how much falls (§84.5)', () => {
  it('the number of drops follows the rain: none when it is dry, a visible rain when it is light, the pool when it pours', () => {
    const f = new RainField({ random: mulberry32(11) });
    expect(f.target(0)).toBe(0);
    expect(f.target(-1)).toBe(0);
    expect(f.target(NaN)).toBe(0);
    expect(f.target(1)).toBe(RAIN_MAX_DROPS);
    expect(f.target(7)).toBe(RAIN_MAX_DROPS);
    expect(f.target(0.35)).toBeGreaterThan(RAIN_MAX_DROPS * 0.4); // the lightest shower's height: already a rain
    expect(f.target(0.35)).toBeLessThan(RAIN_MAX_DROPS * 0.6);
    expect(f.target(0.001)).toBeGreaterThanOrEqual(1);
    let last = 0;
    for (let i = 0.05; i <= 1; i += 0.05) {
      expect(f.target(i)).toBeGreaterThan(last);
      last = f.target(i);
    }
    const g = ground();
    run(f, 6, view(g, { intensity: 0.3 }));
    const light = f.live;
    expect(light).toBeLessThanOrEqual(f.target(0.3));
    expect(light).toBeGreaterThan(f.target(0.3) * 0.85);
    run(f, 6, view(g, { intensity: 1 }));
    expect(f.live).toBeGreaterThan(light * 1.8);
  });

  it('the rain thickens over a few frames and thins out as the drops in the air land: no pop either way', () => {
    const f = new RainField({ random: mulberry32(12) });
    const g = ground();
    let jump = 0;
    let last = 0;
    run(f, 4, view(g), () => {
      jump = Math.max(jump, f.live - last);
      last = f.live;
    });
    expect(jump).toBeLessThanOrEqual(RAIN_BIRTHS);
    const full = f.live;
    f.update(DT, view(g, { intensity: 0 }));
    expect(f.live).toBeGreaterThan(full * 0.9); // the drops in the air finish their fall
    run(f, 1.5, view(g, { intensity: 0 }));
    expect(f.live).toBe(0);
    run(f, 0.5, view(g, { intensity: 0 }));
    expect(f.splashes).toBe(0);
  });

  it('with dt 0 (a menu) nothing moves and nothing is read; clear() empties it', () => {
    const f = new RainField({ random: mulberry32(13) });
    const g = ground();
    run(f, 3, view(g));
    const ys = Array.from(f.y);
    const reads = g.reads;
    f.update(0, view(g));
    f.update(-1, view(g));
    f.update(NaN, view(g));
    expect(Array.from(f.y)).toEqual(ys);
    expect(g.reads).toBe(reads);
    f.clear();
    expect(f.live).toBe(0);
    expect(f.splashes).toBe(0);
    expect(f.columns.size).toBe(0);
  });
});

describe('splashes and flakes (§84.5)', () => {
  it('a splash where a drop lands near the eye: on the ground, short, growing, at most the pool', () => {
    const f = new RainField({ random: mulberry32(14) });
    const g = ground();
    let seen = 0;
    run(f, 8, view(g), () => {
      for (let i = 0; i < f.maxSplashes; i++) {
        if (!(f.sAge[i] < SPLASH_S)) continue;
        seen++;
        expect(Math.hypot(f.sx[i] - EYE.x, f.sz[i] - EYE.z)).toBeLessThanOrEqual(SPLASH_RANGE + 1e-3);
        expect(f.sy[i]).toBeCloseTo(64.02, 4);
      }
    });
    expect(seen).toBeGreaterThan(500);
    expect(SPLASH_S).toBeLessThan(0.4);
    expect(SPLASH_SIZE[1]).toBeGreaterThan(SPLASH_SIZE[0]);
    expect(SPLASH_SIZE[1]).toBeLessThanOrEqual(0.4); // small
  });

  it('snow: slow flakes, fewer than raindrops, no splashes', () => {
    const f = new RainField({ random: mulberry32(15) });
    const g = ground();
    run(f, 25, view(g, { snow: true }));
    const flakes = liveDrops(f);
    expect(flakes.length).toBeGreaterThan(200);
    expect(flakes.length).toBeLessThanOrEqual(Math.round(RAIN_MAX_DROPS * SNOW_DENSITY));
    for (const d of flakes) {
      expect(d.flake).toBe(1);
      expect(d.speed).toBeGreaterThanOrEqual(SNOW_SPEED[0]);
      expect(d.speed).toBeLessThanOrEqual(SNOW_SPEED[1]);
      expect(d.size).toBeGreaterThanOrEqual(SNOW_SIZE[0] - 1e-6);
      expect(d.size).toBeLessThanOrEqual(SNOW_SIZE[1] + 1e-6);
    }
    expect(SNOW_SPEED[1]).toBeLessThan(RAIN_SPEED[0] / 5); // slow
    expect(SNOW_SWAY).toBeLessThanOrEqual(0.15); // it sways, but not in under a roof's edge
    expect(f.splashes).toBe(0);
    expect(f.landings).toBe(0);
  });
});

describe('the quads (§84.5)', () => {
  it('a streak is a thin upright quad facing the eye, opaque at its head and clear at its tail; a dead drop is a point', () => {
    const f = new RainField({ random: mulberry32(16) });
    const g = ground();
    run(f, 3, view(g));
    const quads = f.max + f.maxSplashes;
    const pos = new Float32Array(quads * 12);
    const alpha = new Float32Array(quads * 4);
    f.fill(pos, alpha, EYE.x, EYE.z);
    let drawn = 0;
    for (let i = 0; i < f.max; i++) {
      const p = pos.subarray(i * 12, i * 12 + 12);
      const a = alpha.subarray(i * 4, i * 4 + 4);
      if (!f.alive[i]) {
        expect(Array.from(p).every((v) => v === 0) && Array.from(a).every((v) => v === 0)).toBe(true);
        continue;
      }
      drawn++;
      const dist = Math.hypot(f.x[i] - EYE.x, f.z[i] - EYE.z);
      const near = Math.min(1, RAIN_NEAR_ALPHA + (1 - RAIN_NEAR_ALPHA) * (dist / RAIN_NEAR_M));
      expect(a[0]).toBeCloseTo(near, 5); // the head: opaque, but fainter right before the face
      expect(a[1]).toBe(a[0]);
      expect([a[2], a[3]]).toEqual([0, 0]); // the tail: clear
      if (dist >= RAIN_NEAR_M) expect(a[0]).toBe(1);
      expect(p[1]).toBeCloseTo(f.y[i], 4); // the head
      expect(p[7] - p[1]).toBeCloseTo(f.size[i], 4); // the tail above it
      // RAIN_WIDTH wide, but never wider on screen than RAIN_NEAR_ANGLE: a drop at arm's length is a hair, not a bar
      expect(Math.hypot(p[3] - p[0], p[5] - p[2])).toBeCloseTo(Math.min(RAIN_WIDTH, dist * RAIN_NEAR_ANGLE), 4);
      expect(Math.hypot(p[3] - p[0], p[5] - p[2]) / Math.max(dist, 1e-6)).toBeLessThanOrEqual(RAIN_NEAR_ANGLE + 1e-4);
      // across the line of sight: the quad's width is at right angles to the line from the eye
      const dot = (p[3] - p[0]) * (f.x[i] - EYE.x) + (p[5] - p[2]) * (f.z[i] - EYE.z);
      expect(Math.abs(dot)).toBeLessThan(1e-3);
      expect(p[4] - p[1]).toBe(0); // upright: straight down, never slanting in under a roof
      expect(p[9]).toBeCloseTo(p[0], 5);
    }
    expect(drawn).toBe(f.live);
    expect(RAIN_WIDTH).toBeLessThan(0.05);
    expect(RAIN_NEAR_ANGLE).toBeLessThanOrEqual(0.006); // some 3 px on a 720-line screen with a 70° view
    expect(RAIN_NEAR_ALPHA).toBeLessThan(0.5);
  });

  it('a flake is a small square, opaque all over; a splash lies flat on what the drop hit and fades', () => {
    const f = new RainField({ random: mulberry32(17) });
    const g = ground();
    run(f, 6, view(g, { snow: true }));
    const quads = f.max + f.maxSplashes;
    const pos = new Float32Array(quads * 12);
    const alpha = new Float32Array(quads * 4);
    f.fill(pos, alpha, EYE.x, EYE.z);
    const i = Array.from(f.alive).indexOf(1);
    const p = pos.subarray(i * 12, i * 12 + 12);
    const fa = Array.from(alpha.subarray(i * 4, i * 4 + 4));
    expect(new Set(fa).size).toBe(1); // the same all over
    expect(fa[0]).toBeGreaterThanOrEqual(RAIN_NEAR_ALPHA);
    expect(fa[0]).toBeLessThanOrEqual(1);
    // a square, its size (never larger on screen than SNOW_NEAR_ANGLE, so no flake is a blob before the face)
    const fd = Math.hypot(f.x[i] + Math.sin(f.t * 1.3 + f.phase[i]) * SNOW_SWAY - EYE.x, f.z[i] - EYE.z);
    const side = Math.min(f.size[i], fd * SNOW_NEAR_ANGLE);
    expect(Math.hypot(p[3] - p[0], p[5] - p[2])).toBeCloseTo(side, 4);
    expect(p[7] - p[1]).toBeCloseTo(side, 4);
    const r = new RainField({ random: mulberry32(18) });
    run(r, 4, view(g));
    r.fill(pos, alpha, EYE.x, EYE.z);
    let splashes = 0;
    for (let s = 0; s < r.maxSplashes; s++) {
      const q = pos.subarray((r.max + s) * 12, (r.max + s) * 12 + 12);
      const a = alpha.subarray((r.max + s) * 4, (r.max + s) * 4 + 4);
      if (!(r.sAge[s] < SPLASH_S)) {
        expect(Array.from(a)).toEqual([0, 0, 0, 0]);
        continue;
      }
      splashes++;
      expect(new Set([q[1], q[4], q[7], q[10]]).size).toBe(1); // flat
      expect(a[0]).toBeCloseTo(1 - r.sAge[s] / SPLASH_S, 5);
      expect(q[3] - q[0]).toBeGreaterThanOrEqual(SPLASH_SIZE[0] - 1e-5);
      expect(q[3] - q[0]).toBeLessThanOrEqual(SPLASH_SIZE[1] + 1e-5);
    }
    expect(splashes).toBeGreaterThan(5);
  });

  it('the renderer colours it: pale blue-grey rain, white snow, dimmer by night, never glowing', () => {
    const scene = new THREE.Scene();
    const rr = createRainRenderer(scene, { random: mulberry32(19) });
    const g = ground();
    const m = /** @type {THREE.MeshBasicMaterial} */ (rr.mesh.material);
    const srgb = () => {
      const c = m.color.clone().convertLinearToSRGB();
      return [c.r, c.g, c.b];
    };
    for (let i = 0; i < 120; i++) rr.update(DT, { ...view(g), daylight: 1 });
    expect(m.opacity).toBe(RAIN_ALPHA);
    srgb().forEach((v, i) => expect(v).toBeCloseTo(RAIN_COLOR[i], 3));
    rr.update(DT, { ...view(g), daylight: 0 });
    srgb().forEach((v, i) => expect(v).toBeCloseTo(RAIN_COLOR[i] * RAIN_NIGHT_LIGHT, 3));
    rr.update(DT, { ...view(g, { snow: true }), daylight: 1 });
    expect(m.opacity).toBe(SNOW_ALPHA);
    srgb().forEach((v, i) => expect(v).toBeCloseTo(SNOW_COLOR[i], 3));
    // the alphas reach the colour attribute; the rgb stays white (the material tints)
    const color = rr.mesh.geometry.getAttribute('color');
    let opaque = 0;
    for (let v = 0; v < color.count; v++) {
      expect([color.getX(v), color.getY(v), color.getZ(v)]).toEqual([1, 1, 1]);
      if (color.getW(v) === 1) opaque++;
    }
    expect(opaque).toBeGreaterThan(200);
    expect(RAIN_ALPHA).toBeLessThan(0.7); // see-through: it never hides the world
    rr.dispose();
  });

  it('prewarm compiles the material through the renderer it is given, and never throws', async () => {
    const scene = new THREE.Scene();
    const rr = createRainRenderer(scene);
    const calls = [];
    await rr.prewarm({ compileAsync: (obj, cam, sc) => (calls.push([obj, sc]), Promise.resolve()) }, new THREE.PerspectiveCamera());
    expect(calls).toEqual([[rr.mesh, scene]]);
    await rr.prewarm({ compile: () => { throw new Error('lost context'); } }, new THREE.PerspectiveCamera());
    await rr.prewarm(null, new THREE.PerspectiveCamera());
    await rr.prewarm({ compileAsync: () => Promise.reject(new Error('no')) }, new THREE.PerspectiveCamera());
    rr.dispose();
  });
});

describe('what it costs (§84.5)', () => {
  it('a frame of the heaviest rain, simulated and written to its buffers, takes well under a millisecond', () => {
    const scene = new THREE.Scene();
    const rr = createRainRenderer(scene, { random: mulberry32(20) });
    const g = ground();
    const v = { ...view(g), daylight: 1 };
    for (let i = 0; i < 300; i++) rr.update(DT, v); // established
    const FRAMES = 600;
    const reads0 = g.reads;
    const t0 = performance.now();
    for (let i = 0; i < FRAMES; i++) {
      v.x += 0.07; // walking
      rr.update(DT, v);
    }
    const ms = (performance.now() - t0) / FRAMES;
    const reads = (g.reads - reads0) / FRAMES;
    // measured on the development machine: 0.025 ms a frame and about 200 block reads; the bound is loose for a busy one
    expect(ms).toBeLessThan(1);
    expect(reads).toBeLessThanOrEqual(RAIN_COLUMN_SCANS * WORLD_HEIGHT);
    expect(rr.count()).toBeGreaterThan(RAIN_MAX_DROPS * 0.85);
    rr.dispose();
  });
});
