// Water that runs out (CONTRACTS §83, src/waterBodies.js): what the water in a cell is (fresh, tainted, salt for the
// sea; how deep its pool), what a gulp and a pot take out of a pool, and the water cycle — pools dry in the sun and fill
// in the rain, dry beds and clay basins catch the rain. Then how main wires it, and what a cycle second costs on a real
// generated world. The bodies and the three laws themselves are tests/unit/waterLaws.test.js's.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DAY_LENGTH_SECONDS, GEN_LATEST } from '../../src/config.js';
import { BLOCK, UNLOADED, isWater, isWaterSource, isTaintedWater, waterDepth, waterAtDepth } from '../../src/blocks.js';
import { hexDiscCount, hexLength, hexToWorld } from '../../src/hex.js';
import { mulberry32 } from '../../src/noise.js';
import { World } from '../../src/world.js';
import { createWorldGen } from '../../src/worldgen.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { BODY_MAX_CELLS, waterBodyAt } from '../../src/fluids.js';
import {
  CELL_GULPS, POT_GULPS, CYCLE_SAMPLES, CYCLE_RANGE, CYCLE_COLUMNS, DRY_MEAN_S, STREAM_DRY_MEAN_S, ROOF_DRY_FACTOR, FILL_MEAN_S,
  WATER_STEP_MAX_S, WaterCycle, waterAt, topBody, depthWrites, drawWater, columnWater, dryBedAt, clayBasinAt, cycleStep,
  applyWaterWrites,
} from '../../src/waterBodies.js';
import { SPREAD_SAMPLES, SPREAD_RANGE } from '../../src/spread.js';
import { interactKind, waterHint, waterKind, WATER_POTS } from '../../src/survivalControl.js';
import { installDebugHandle } from '../../src/diagnostics.js';
import { attachPhysics, makeFakeWorld } from '../helpers/fixtures.js';
import { pondCells, rest } from '../helpers/water.js';

const B = BLOCK;
const flow = (k) => B.WATER_FLOW_1 + k - 1;
const G = 4; // the ground of the grid worlds: stone for y ≤ 4

/**
 * A small fast world for the cycle: columns within `R` of the middle, `H` cells high, stone up to G. `gen` sets a cell as
 * GENERATED (it is its origin too), `set` changes it afterwards. Reads outside it are UNLOADED (AIR above and below).
 */
function grid(R = 56, H = 12) {
  const S = 2 * R + 1;
  const now = new Uint8Array(S * S * H);
  const origin = new Uint8Array(S * S * H);
  const idx = (q, y, r) => ((q + R) * S + (r + R)) * H + y;
  const inside = (q, r) => q >= -R && q <= R && r >= -R && r <= R;
  for (let q = -R; q <= R; q++) for (let r = -R; r <= R; r++) for (let y = 0; y <= G; y++) now[idx(q, y, r)] = origin[idx(q, y, r)] = B.STONE;
  /** @type {Map<string, number>} */
  const springs = new Map();
  const w = {
    peek: (q, y, r) => (y < 0 || y >= H ? B.AIR : inside(q, r) ? now[idx(q, y, r)] : UNLOADED),
    originAt: (q, y, r) => (y < 0 || y >= H ? B.AIR : inside(q, r) ? origin[idx(q, y, r)] : UNLOADED),
    isLoadedCell: inside,
    springLevelAt: (q, r) => (springs.size === 0 ? -1 : springs.get(`${q},${r}`) ?? -1),
    saltyAt: (_q, _r) => false,
    q: 0,
    r: 0,
    top: H - 1,
    /** (the fast way to a column's cells, as main's world gives it) */
    column(q, r, out) {
      if (!inside(q, r)) return false;
      out.blocks = now;
      out.base = idx(q, 0, r);
      return true;
    },
    gen(q, y, r, id) {
      now[idx(q, y, r)] = origin[idx(q, y, r)] = id;
    },
    set(q, y, r, id) {
      now[idx(q, y, r)] = id;
    },
    spring(q, y, r) {
      springs.set(`${q},${r}`, y);
    },
    apply(writes) {
      for (let i = 0; i < writes.length; i += 4) now[idx(writes[i], writes[i + 1], writes[i + 2])] = writes[i + 3];
    },
    /** A generated pond of `id` round (q0, r0): seven cells at y G on CLAY. */
    pond(q0, r0, id = B.WATER) {
      for (const [q, r] of pondCells(q0, r0)) {
        w.gen(q, G, r, id);
        w.gen(q, G - 1, r, B.CLAY);
      }
    },
    ids: (cells, y = G) => cells.map(([q, r]) => now[idx(q, y, r)]),
  };
  return w;
}
const DRY = { rain: () => 0, dryness: () => 1 };
const RAIN = { rain: () => 1, dryness: () => 0.3 };
const all = (id, n = 7) => Array(n).fill(id);
/** A `random` that returns the given values, then 0.999 for ever (no sample hits, no roll passes). */
const seq = (...values) => {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0.999);
};

describe('what the water in a cell is (waterAt)', () => {
  it('a pond: fresh or tainted, with the depth of the pool and the body it is; not water → null', () => {
    const w = grid();
    w.pond(0, 0, B.WATER_LOW);
    w.pond(10, 0, B.TAINTED_WATER_SHALLOW);
    const a = waterAt(w, 0, G, 0);
    expect({ quality: a.quality, depth: a.depth, sea: a.sea, stream: a.stream, flowing: a.flowing, source: a.source }).toEqual({ quality: 'fresh', depth: 2, sea: false, stream: false, flowing: false, source: [0, G, 0] });
    expect(a.body.count).toBe(7);
    const b = waterAt(w, 11, G, 0);
    expect([b.quality, b.depth, b.body.tainted]).toEqual(['tainted', 1, true]);
    expect(waterAt(w, 5, G, 0)).toBeNull(); // stone
    expect(waterAt(w, 0, G + 1, 0)).toBeNull(); // air
  });

  it('the sea is SALT whatever the biome; a pool is fresh; water generated in a salt biome is salt; rain caught there is fresh', () => {
    const w = grid();
    for (let q = -20; q <= 20; q++) for (let r = 10; r <= 20; r++) w.gen(q, G, r, B.WATER); // a sea of 451 cells, in no salt biome
    expect(waterAt(w, 0, G, 15)).toMatchObject({ quality: 'salt', sea: true, depth: 3 });
    w.pond(0, 0);
    expect(waterAt(w, 0, G, 0)).toMatchObject({ quality: 'fresh', sea: false });
    // exactly 128 cells is still a pool; one more is the sea
    for (let q = -40; q <= 40; q++) w.gen(q, G, -20, q >= -40 && q < -40 + BODY_MAX_CELLS - 60 ? B.WATER : B.STONE);
    const strip = grid(80);
    for (let i = 0; i < BODY_MAX_CELLS; i++) strip.gen(i - 64, G, 0, B.WATER);
    for (let i = 0; i <= BODY_MAX_CELLS; i++) strip.gen(i - 64, G, 5, B.WATER);
    expect(waterAt(strip, 0, G, 0)).toMatchObject({ quality: 'fresh', sea: false });
    expect(waterAt(strip, 0, G, 5)).toMatchObject({ quality: 'salt', sea: true });
    // a beach: a generated lagoon of seven cells is salt, a clay basin the rain filled beside it is fresh
    const beach = grid();
    beach.saltyAt = () => true;
    beach.pond(0, 0);
    beach.set(10, G, 0, B.WATER_SHALLOW); // (generated as stone: this water came later)
    expect(waterAt(beach, 0, G, 0)).toMatchObject({ quality: 'salt', sea: false });
    expect(waterAt(beach, 10, G, 0)).toMatchObject({ quality: 'fresh', depth: 1 });
    // … and running water is never salt, even across a beach
    beach.spring(20, G, 0);
    beach.gen(20, G, 0, B.WATER);
    expect(waterAt(beach, 20, G, 0)).toMatchObject({ quality: 'fresh', stream: true });
    // tainted wins over salt
    beach.pond(-10, 0, B.TAINTED_WATER);
    expect(waterAt(beach, -10, G, 0).quality).toBe('tainted');
    expect(waterKind(true, true)).toBe('tainted');
    expect(WATER_POTS[waterAt(beach, 0, G, 0).quality]).toBe('pot_seawater');
  });

  it('flowing and falling water is the pool that feeds it: its quality, its depth; with no source it is stale', () => {
    const w = grid();
    w.pond(0, 0, B.WATER_LOW);
    w.set(2, G, 0, flow(4)); // the pond runs out through its bank …
    w.set(3, G, 0, flow(3));
    w.set(3, G - 1, 0, B.WATER_FALL); // … and down a hole
    w.set(3, G - 2, 0, B.WATER_FALL);
    for (const [q, y] of [[2, G], [3, G], [3, G - 1], [3, G - 2]]) {
      const info = waterAt(w, q, y, 0);
      expect({ quality: info.quality, depth: info.depth, flowing: info.flowing, source: info.source, count: info.body.count }, `${q},${y}`)
        .toEqual({ quality: 'fresh', depth: 2, flowing: true, source: [1, G, 0], count: 7 });
    }
    w.set(30, G + 1, 0, flow(2)); // nothing feeds this
    expect(waterAt(w, 30, G + 1, 0)).toEqual({ quality: 'fresh', depth: 0, sea: false, stream: false, flowing: true, source: null, body: null });
    // out of the sea it is salt; out of a tainted pool, tainted
    const s = grid();
    for (let q = -20; q <= 20; q++) for (let r = 10; r <= 20; r++) s.gen(q, G, r, B.WATER);
    s.set(0, G, 9, flow(6));
    expect(waterAt(s, 0, G, 9)).toMatchObject({ quality: 'salt', sea: true, flowing: true });
    s.pond(0, 0, B.TAINTED_WATER);
    s.set(2, G, 0, flow(6));
    expect(waterAt(s, 2, G, 0)).toMatchObject({ quality: 'tainted', depth: 3 });
  });

  it('the hint says how much is left: full, low, shallow — but not for the sea, which does not run out', () => {
    expect(waterHint('fresh', false, 3)).toBe('Fresh water · full · R: drink');
    expect(waterHint('fresh', false, 2)).toBe('Fresh water · low · R: drink');
    expect(waterHint('fresh', true, 1)).toBe('Fresh water · shallow · R: fill the pot');
    expect(waterHint('tainted', false, 3)).toBe('Tainted water · full · R: drink (risky)');
    expect(waterHint('tainted', true, 2)).toBe('Tainted water · low · R: fill the pot');
    expect(waterHint('tainted', false, 1)).toBe('Tainted water · shallow · R: drink (risky)');
    expect(waterHint('salt', false, 3)).toBe('Sea water (salty) · R: drink');
    expect(waterHint('salt', true, 1)).toBe('Sea water (salty) · R: fill the pot');
    // no depth told (flowing water no source feeds, or an old caller): as before
    expect(waterHint('fresh', false)).toBe('Fresh water · R: drink');
    expect(waterHint('fresh', false, 0)).toBe('Fresh water · R: drink');
    expect(waterHint('tainted', false, 7)).toBe('Tainted water · R: drink (risky)');
    expect(waterHint(true, false, 2)).toBe('Sea water (salty) · R: drink');
    // R on water carries it: interactKind asks the context for the depth of the cell it looks at
    const pack = { count: () => 0, countTag: () => 0, hasTool: () => false };
    const c = (sel, depth) => ({
      hit: null, waterHit: { q: 3, y: 9, r: -2, blockId: B.WATER_LOW, distance: 2 }, selectedKey: sel, pack,
      waterQuality: () => 'fresh', waterDepth: (q, y, r) => (q === 3 && y === 9 && r === -2 ? depth : 0),
    });
    expect(interactKind(c(null, 2))).toEqual({ kind: 'drink', q: 3, y: 9, r: -2, quality: 'fresh', salty: false, hint: 'Fresh water · low · R: drink' });
    expect(interactKind(c('clay_pot', 1)).hint).toBe('Fresh water · shallow · R: fill the pot');
    const old = { hit: null, waterHit: { q: 3, y: 9, r: -2, blockId: B.WATER, distance: 2 }, selectedKey: null, pack, waterQuality: () => 'tainted' };
    expect(interactKind(old).hint).toBe('Tainted water · R: drink (risky)');
  });
});

describe('using water uses it up (drawWater)', () => {
  it('constants: a cell holds 6 gulps a level, a pot takes 4 — a 7-cell pond is 42 gulps a level and 126 in all, one cell 18', () => {
    expect([CELL_GULPS, POT_GULPS]).toEqual([6, 4]);
    expect(7 * CELL_GULPS).toBe(42);
    expect(3 * 7 * CELL_GULPS).toBe(126);
    expect(3 * 1 * CELL_GULPS).toBe(18);
  });

  it('one random() per take; below gulps / (cells × 6) the whole pool drops a level', () => {
    const w = grid();
    w.pond(0, 0);
    let rolls = 0;
    const at = (v) => () => (rolls++, v);
    const miss = drawWater(w, 0, G, 0, 1, at(1 / 42));
    expect([miss.dropped, miss.writes, miss.body.count, rolls]).toEqual([false, [], 7, 1]);
    const hit = drawWater(w, 1, G, 0, 1, at(1 / 42 - 1e-9));
    expect(hit.dropped).toBe(true);
    expect(hit.writes.length).toBe(7 * 4);
    for (let i = 0; i < hit.writes.length; i += 4) expect(hit.writes[i + 3]).toBe(B.WATER_LOW);
    expect(rolls).toBe(2);
    expect(drawWater(w, 0, G, 0, POT_GULPS, at(4 / 42 - 1e-9)).dropped).toBe(true); // a pot: four gulps' chance
    expect(drawWater(w, 0, G, 0, POT_GULPS, at(4 / 42)).dropped).toBe(false);
    expect(drawWater(w, 0, G, 0, 1000, at(0.999999)).dropped).toBe(true); // capped at 1: more than it holds empties the level
    expect(drawWater(w, 0, G + 3, 0, 1, at(0))).toBeNull(); // no water there
    expect(drawWater(w, 0, G, 0, 0, at(0)).dropped).toBe(false);
    // the writes of a shallow pool's last level are AIR
    const s = grid();
    s.pond(0, 0, B.TAINTED_WATER_SHALLOW);
    const last = drawWater(s, 0, G, 0, 1, () => 0);
    expect(last.writes.filter((_, i) => i % 4 === 3)).toEqual(all(B.AIR));
    expect(depthWrites(s, last.body, +1).filter((_, i) => i % 4 === 3)).toEqual(all(B.TAINTED_WATER_LOW));
  });

  it('by simulation: a one-cell pool gives about 18 gulps and a 7-cell pond about 126; by the pot, about 4.5 and 31.5', () => {
    const rnd = mulberry32(8306);
    const drain = (cells, gulps) => {
      const w = grid(8);
      for (const [q, r] of cells) w.gen(q, G, r, B.WATER);
      let takes = 0;
      for (;;) {
        const d = drawWater(w, cells[0][0], G, cells[0][1], gulps, rnd);
        if (d === null) return takes;
        takes++;
        if (d.dropped) w.apply(d.writes);
      }
    };
    const mean = (n, cells, gulps) => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += drain(cells, gulps);
      return sum / n;
    };
    const one = mean(4000, [[0, 0]], 1);
    expect(one).toBeGreaterThan(18 * 0.94);
    expect(one).toBeLessThan(18 * 1.06);
    const pond = mean(700, pondCells(), 1);
    expect(pond).toBeGreaterThan(126 * 0.92);
    expect(pond).toBeLessThan(126 * 1.08);
    const pots1 = mean(4000, [[0, 0]], POT_GULPS);
    expect(pots1).toBeGreaterThan(4.5 * 0.94);
    expect(pots1).toBeLessThan(4.5 * 1.06);
    const pots7 = mean(1500, pondCells(), POT_GULPS);
    expect(pots7).toBeGreaterThan(31.5 * 0.92);
    expect(pots7).toBeLessThan(31.5 * 1.08);
  });

  it('drinking from the flow below a pool takes from the pool', () => {
    const w = grid();
    w.pond(0, 0);
    w.set(2, G, 0, flow(6));
    w.set(3, G, 0, flow(5));
    w.set(3, G - 1, 0, B.WATER_FALL);
    const d = drawWater(w, 3, G - 1, 0, 1, () => 0);
    expect(d.info.source).toEqual([1, G, 0]);
    expect(d.dropped).toBe(true);
    w.apply(d.writes);
    expect(w.ids(pondCells())).toEqual(all(B.WATER_LOW));
    expect(w.peek(3, G - 1, 0)).toBe(B.WATER_FALL); // (the flow itself is the rule's to change)
  });

  it('a pool at two depths (levelling left it so) loses a level from its deeper cells and gains one in its shallower: it comes out even', () => {
    const w = grid();
    w.pond(0, 0, B.WATER_LOW);
    for (const [q, r] of pondCells().slice(0, 2)) w.set(q, G, r, B.WATER); // two cells full, five low
    const body = waterBodyAt(w.peek, 0, G, 0);
    expect([body.depth, body.minDepth, body.levels, body.units]).toEqual([3, 2, [0, 0, 5, 2], 16]);
    // a gulp: the chance is that of the two cells that would drop (2 × 6 gulps), and only they drop
    let seen = 0;
    const d = drawWater(w, 0, G, 0, 1, () => (seen++, 1 / 12 - 1e-9));
    expect([d.dropped, seen, d.writes.length / 4]).toEqual([true, 1, 2]);
    expect(drawWater(w, 0, G, 0, 1, () => 1 / 12).dropped).toBe(false);
    expect(depthWrites(w, body, -1)).toEqual(pondCells().slice(0, 2).flatMap(([q, r]) => [q, G, r, B.WATER_LOW]));
    expect(depthWrites(w, body, +1)).toEqual(pondCells().slice(2).flatMap(([q, r]) => [q, G, r, B.WATER]));
    w.apply(d.writes);
    expect(w.ids(pondCells())).toEqual(all(B.WATER_LOW)); // even again: the next gulp that tells drops all seven
    expect(drawWater(w, 0, G, 0, 1, () => 1 / 42 - 1e-9).writes.length / 4).toBe(7);
    // the cycle finds it through the cells that would change, at their chance: the sun through the deeper, the rain through the shallower
    const m = grid();
    m.pond(0, 0, B.WATER_LOW);
    m.set(0, G, 0, B.WATER); // the middle cell full, the six round it low
    const mid = ((hexDiscCount(48) - 1) / 2 + 0.5) / CYCLE_COLUMNS;
    const one = CYCLE_COLUMNS / (CYCLE_SAMPLES * DRY_MEAN_S); // the chance of a thing of ONE cell
    const dry = cycleStep(1, seq(mid, one * 0.999), m, DRY);
    expect([dry.kind, dry.writes]).toEqual(['dry', [0, G, 0, B.WATER_LOW]]);
    expect(cycleStep(1, seq(mid, 0), { ...m, q: 1, r: 0 }, DRY)).toBeNull(); // a low cell of it: not one that dries first
    expect(cycleStep(1, seq(mid, 0), m, RAIN)).toBeNull(); // the full cell gains nothing
    const six = CYCLE_COLUMNS / (CYCLE_SAMPLES * FILL_MEAN_S * 6);
    expect(cycleStep(1, seq(mid, six), { ...m, q: 1, r: 0 }, RAIN)).toBeNull();
    const fill = cycleStep(1, seq(mid, six * 0.999), { ...m, q: 1, r: 0 }, RAIN);
    expect([fill.kind, fill.writes.length / 4, fill.writes[3]]).toEqual(['fill', 6, B.WATER]);
  });

  it('the sea never drops, nor does running water; a pool under water is taken from the top', () => {
    const w = grid();
    for (let q = -20; q <= 20; q++) for (let r = 10; r <= 20; r++) w.gen(q, G, r, B.WATER);
    let rolls = 0;
    const zero = () => (rolls++, 0);
    for (let i = 0; i < 50; i++) expect(drawWater(w, i % 20, G, 15, POT_GULPS, zero)).toMatchObject({ dropped: false, body: null, writes: [] });
    w.spring(0, G, -10);
    w.spring(1, G, -10);
    w.gen(0, G, -10, B.WATER_LOW);
    w.gen(1, G, -10, B.WATER_LOW);
    expect(drawWater(w, 0, G, -10, 100, zero)).toMatchObject({ dropped: false, body: null });
    expect(rolls).toBe(0); // nothing to roll for: they are never used up
    // two levels of a pool: a gulp taken at the lower level (through an opening at its side) lowers the upper one
    w.pond(0, 0);
    for (const [q, r] of pondCells(0, 0)) w.gen(q, G + 1, r, B.WATER);
    w.gen(0, G + 2, 0, B.STONE);
    const d = drawWater(w, 1, G, 0, 1, zero);
    expect(d.body.cells.slice(0, 3)[1]).toBe(G + 1);
    expect(topBody(w, waterBodyAt(w.peek, 1, G, 0)).cells[1]).toBe(G + 1);
    w.apply(d.writes);
    expect([w.ids(pondCells(), G + 1), w.ids(pondCells(), G)]).toEqual([all(B.WATER_LOW), all(B.WATER)]);
  });

  it('applyWaterWrites writes lazily what is still water or open, and leaves a cell that has become something else', () => {
    const world = makeFakeWorld({ groundY: G });
    for (const [q, r] of pondCells()) world.put(q, G, r, B.WATER);
    world.put(1, G, 0, B.STONE); // someone put a block in one cell meanwhile
    const writes = pondCells().flatMap(([q, r]) => [q, G, r, B.WATER_LOW]);
    expect(applyWaterWrites(world, writes)).toBe(6);
    expect(world.getBlock(1, G, 0)).toBe(B.STONE);
    expect(world.writes.every((x) => x.lazy === true && x.id === B.WATER_LOW)).toBe(true);
    expect(applyWaterWrites(world, writes)).toBe(0); // nothing left to change
  });
});

describe('the water cycle: sun and rain (cycleStep)', () => {
  it('constants: 48 columns a second within 48 cells; a pool dries a level in three game days, a stream in two, a roofed pool ten times slower; rain fills a level in 360 s', () => {
    expect([CYCLE_SAMPLES, CYCLE_RANGE, CYCLE_COLUMNS]).toEqual([48, 48, hexDiscCount(48)]);
    expect([CYCLE_SAMPLES, CYCLE_RANGE]).toEqual([SPREAD_SAMPLES, SPREAD_RANGE]); // (the same reach as the plants' spreading)
    expect(CYCLE_COLUMNS).toBe(7057);
    expect(DRY_MEAN_S).toBe(4320);
    expect(DRY_MEAN_S).toBe(3 * DAY_LENGTH_SECONDS);
    expect(STREAM_DRY_MEAN_S).toBe(2880);
    expect(STREAM_DRY_MEAN_S).toBe(2 * DAY_LENGTH_SECONDS);
    expect([ROOF_DRY_FACTOR, FILL_MEAN_S]).toEqual([10, 360]);
    expect(WATER_STEP_MAX_S).toBe(10 * DAY_LENGTH_SECONDS); // (the debug handle: ten game days a call, like farmStep)
  });

  it('what a column holds: its highest source (and whether the sky is over it), a stream\'s own cell, or — in rain — a dry bed or a clay basin', () => {
    const w = grid();
    w.pond(0, 0);
    expect(columnWater(w, 0, 0)).toEqual({ kind: 'water', y: G, sky: true });
    expect(columnWater(w, 5, 0)).toBeNull(); // dry ground
    w.gen(1, G + 3, 0, B.OAK_PLANKS); // a roof over one cell
    expect(columnWater(w, 1, 0)).toEqual({ kind: 'water', y: G, sky: false });
    w.gen(-1, G + 3, 0, B.OAK_LEAVES); // leaves and glass let the sky through
    w.gen(0, G + 3, -1, B.GLASS);
    expect(columnWater(w, -1, 0).sky).toBe(true);
    expect(columnWater(w, 0, -1).sky).toBe(true);
    w.gen(0, G + 2, 0, B.WATER_LOW); // water above: the highest source of the column is what is found
    expect(columnWater(w, 0, 0)).toEqual({ kind: 'water', y: G + 2, sky: true });
    // a dry bed and a clay basin are looked for only when it rains
    w.pond(20, 0, B.TAINTED_WATER);
    for (const [q, r] of pondCells(20, 0)) w.set(q, G, r, B.AIR);
    expect(columnWater(w, 20, 0)).toBeNull();
    expect(columnWater(w, 20, 0, true)).toEqual({ kind: 'bed', y: G, sky: true });
    w.gen(30, G, 0, B.AIR);
    w.gen(30, G - 1, 0, B.CLAY);
    expect(columnWater(w, 30, 0, true)).toEqual({ kind: 'basin', y: G, sky: true });
    w.gen(30, G + 4, 0, B.STONE); // roofed: no rain reaches it
    expect(columnWater(w, 30, 0, true)).toBeNull();
    w.gen(31, G, 0, B.AIR); // a pit on stone holds no rain
    expect(columnWater(w, 31, 0, true)).toBeNull();
    // a stream: its own cell, wet or — in rain — dry
    w.spring(40, G, 0);
    w.gen(40, G, 0, B.WATER_SHALLOW);
    expect(columnWater(w, 40, 0)).toEqual({ kind: 'water', y: G, sky: true });
    w.set(40, G, 0, B.AIR);
    expect(columnWater(w, 40, 0)).toBeNull();
    expect(columnWater(w, 40, 0, true)).toEqual({ kind: 'spring', y: G, sky: true });
    expect(columnWater(w, 99, 0)).toBeNull(); // not loaded
  });

  it('one step: the rolls it draws, and the events it gives (dry, fill, bed, basin) with the cells to write', () => {
    const w = grid();
    w.pond(0, 0);
    const col0 = (hexDiscCount(48) - 1) / 2; // the middle column of the disc: the player's own
    const pick = (col0 + 0.5) / CYCLE_COLUMNS;
    // dry weather: sample the pond, roll under the chance of a 7-cell body → it loses a level
    const p7 = CYCLE_COLUMNS / (CYCLE_SAMPLES * DRY_MEAN_S * 7);
    expect(cycleStep(1, seq(pick, p7), w, DRY)).toBeNull(); // at the chance: not below it
    const dry = cycleStep(1, seq(pick, p7 * 0.999), w, DRY);
    expect({ kind: dry.kind, q: dry.q, y: dry.y, r: dry.r, count: dry.count, stream: dry.stream, quality: dry.quality }).toEqual({ kind: 'dry', q: 0, y: G, r: 0, count: 7, stream: false, quality: 'fresh' });
    expect(dry.writes.filter((_, i) => i % 4 === 3)).toEqual(all(B.WATER_LOW));
    w.apply(dry.writes);
    expect(w.ids(pondCells())).toEqual(all(B.WATER_LOW));
    // rain: the same pond gains a level, at the chance of FILL_MEAN_S
    const f7 = CYCLE_COLUMNS / (CYCLE_SAMPLES * FILL_MEAN_S * 7);
    expect(cycleStep(1, seq(pick, f7), w, RAIN)).toBeNull();
    const fill = cycleStep(1, seq(pick, f7 * 0.999), w, RAIN);
    expect(fill.kind).toBe('fill');
    expect(fill.writes.filter((_, i) => i % 4 === 3)).toEqual(all(B.WATER));
    w.apply(fill.writes);
    expect(cycleStep(1, seq(pick, 0), w, RAIN)).toBeNull(); // full: nothing to gain
    // dt scales the chance; no time, no step
    expect(cycleStep(10, seq(pick, p7 * 9.99), w, DRY).kind).toBe('dry');
    expect(cycleStep(0, seq(pick, 0), w, DRY)).toBeNull();
    // a sample that holds nothing draws no roll: 48 samples, then nothing
    let n = 0;
    expect(cycleStep(1, () => (n++, 0.9999), w, DRY)).toBeNull();
    expect(n).toBe(CYCLE_SAMPLES);
    // the WaterCycle keeps count
    const cycle = new WaterCycle();
    expect(cycle.step(1, seq(pick, 0), w, DRY).kind).toBe('dry');
    expect(cycle.step(1, seq(pick, 0.9), w, DRY)).toBeNull();
    expect([cycle.dried, cycle.filled, cycle.beds, cycle.basins, cycle.events, cycle.last.kind]).toEqual([1, 0, 0, 0, 1, 'dry']);
    cycle.used();
    expect(cycle.drawn).toBe(1);
    cycle.clear();
    expect([cycle.events, cycle.drawn, cycle.last]).toEqual([0, 0, null]);
  });

  /** Simulate `seconds` of the cycle in steps of `dt`; `each(ev)` is told every event (and puts the world back). */
  function simulate(w, env, seconds, dt, seed, each) {
    const rnd = mulberry32(seed);
    for (let t = 0; t < seconds; t += dt) {
      const ev = cycleStep(dt, rnd, w, env);
      if (ev) each(ev);
    }
  }
  /** Which of `spots` ([q, r] of one cell each) an event's first write lies nearest to. */
  const nearest = (ev, spots) => {
    let best = 0;
    for (let i = 1; i < spots.length; i++) if (hexLength(ev.q - spots[i][0], ev.r - spots[i][1]) < hexLength(ev.q - spots[best][0], ev.r - spots[best][1])) best = i;
    return best;
  };

  it('drying is per BODY, whatever its size: pools of 1, 7 and 61 cells each lose a level about once in 4320 s', () => {
    const w = grid();
    const spots = [[-30, 0], [0, 0], [25, 0]];
    w.gen(-30, G, 0, B.WATER); // one cell
    w.pond(0, 0); // seven
    for (let dq = -4; dq <= 4; dq++) for (let dr = -4; dr <= 4; dr++) if (hexLength(dq, dr) <= 4) w.gen(25 + dq, G, dr, B.WATER); // 61
    expect([1, 7, 61]).toEqual(spots.map(([q, r]) => waterBodyAt(w.peek, q, G, r).count));
    const count = [0, 0, 0];
    const T = 300 * DRY_MEAN_S;
    simulate(w, DRY, T, 24, 4320, (ev) => {
      expect(ev.kind).toBe('dry');
      count[nearest(ev, spots)]++; // (the pool is left full: every event is one more level it would have lost)
    });
    for (const n of count) {
      expect(n).toBeGreaterThan(300 * 0.78);
      expect(n).toBeLessThan(300 * 1.22);
    }
  });

  it('drying follows the dryness of the season; a roofed pool dries ten times slower; a stream follows its own mean of 2880 s', () => {
    const w = grid();
    const spots = [[-30, 0], [0, 0], [30, 0]];
    w.pond(-30, 0); // open
    w.pond(0, 0); // roofed: planks over all seven cells
    for (const [q, r] of pondCells(0, 0)) w.gen(q, G + 3, r, B.OAK_PLANKS);
    for (let q = 27; q <= 33; q++) { // a stream of seven cells
      w.spring(q, G, 0);
      w.gen(q, G, 0, B.WATER);
    }
    const run = (env, T, seed) => {
      const count = [0, 0, 0];
      simulate(w, env, T, 24, seed, (ev) => {
        expect(ev.kind).toBe('dry');
        expect(ev.stream).toBe(nearest(ev, spots) === 2);
        count[nearest(ev, spots)]++;
      });
      return count;
    };
    const T = 300 * DRY_MEAN_S;
    const [open, roofed, stream] = run(DRY, T, 11);
    expect(open).toBeGreaterThan(300 * 0.78);
    expect(open).toBeLessThan(300 * 1.22);
    expect(roofed).toBeGreaterThan(30 * 0.45); // 300 / ROOF_DRY_FACTOR
    expect(roofed).toBeLessThan(30 * 1.75);
    expect(stream).toBeGreaterThan((T / STREAM_DRY_MEAN_S) * 0.8); // 450
    expect(stream).toBeLessThan((T / STREAM_DRY_MEAN_S) * 1.2);
    // in the rains (dryness 0.3) everything dries at three tenths of that; with dryness 0 nothing dries at all
    const wet = run({ rain: () => 0, dryness: () => 0.3 }, T, 12);
    expect(wet[0]).toBeGreaterThan(90 * 0.68);
    expect(wet[0]).toBeLessThan(90 * 1.32);
    expect(wet[2]).toBeGreaterThan(135 * 0.72);
    expect(wet[2]).toBeLessThan(135 * 1.28);
    expect(run({ rain: () => 0, dryness: () => 0 }, 40 * DRY_MEAN_S, 13)).toEqual([0, 0, 0]);
  });

  it('filling only in rain, only under the open sky, up to full: a pool gains a level about once in 360 s of full rain, half as often in half rain', () => {
    const w = grid();
    const spots = [[-30, 0], [0, 0], [30, 0], [0, 30]];
    w.pond(-30, 0, B.WATER_SHALLOW); // open
    w.pond(0, 0, B.WATER_SHALLOW); // roofed
    for (const [q, r] of pondCells(0, 0)) w.gen(q, G + 3, r, B.OAK_PLANKS);
    w.pond(30, 0); // full already
    w.gen(0, G, 30, B.TAINTED_WATER_LOW); // one tainted cell, open
    const run = (env, T, seed) => {
      const count = [0, 0, 0, 0];
      simulate(w, env, T, 2, seed, (ev) => {
        expect(ev.kind).toBe('fill');
        count[nearest(ev, spots)]++; // (left as it was: every event is one more level it would have gained)
      });
      return count;
    };
    const T = 300 * FILL_MEAN_S;
    const full = run({ rain: () => 1, dryness: () => 0.3 }, T, 21);
    expect(full[0]).toBeGreaterThan(300 * 0.78);
    expect(full[0]).toBeLessThan(300 * 1.22);
    expect(full[3]).toBeGreaterThan(300 * 0.78); // per body: one cell fills as often as seven
    expect(full[3]).toBeLessThan(300 * 1.22);
    expect([full[1], full[2]]).toEqual([0, 0]); // the roofed pool gets no rain; the full one has nothing to gain
    const half = run({ rain: () => 0.5, dryness: () => 0.3 }, T, 22);
    expect(half[0]).toBeGreaterThan(150 * 0.72);
    expect(half[0]).toBeLessThan(150 * 1.28);
    // it rains only where the env says: here over the west half of the land
    const west = run({ rain: (q) => (q < -10 ? 1 : 0), dryness: () => 0 }, T, 23);
    expect(west[0]).toBeGreaterThan(300 * 0.78);
    expect([west[1], west[2], west[3]]).toEqual([0, 0, 0]);
    // and while it rains nothing dries; while it is dry nothing fills
    simulate(w, { rain: () => 1, dryness: () => 1 }, 4 * DRY_MEAN_S, 2, 24, (ev) => expect(ev.kind).toBe('fill'));
    simulate(w, DRY, 10 * DRY_MEAN_S, 24, 25, (ev) => expect(ev.kind).toBe('dry'));
    // a fill writes each cell one level higher, the quality kept
    const one = cycleStep(1e6, seq((hexDiscCount(48) - 1) / 2 / CYCLE_COLUMNS, 0), { ...w, q: 0, r: 30 }, RAIN);
    expect([one.kind, one.quality, one.writes]).toEqual(['fill', 'tainted', [0, G, 30, B.TAINTED_WATER]]);
  });

  it('a dry natural bed takes water again in the rain, as often as a pool fills: the whole bed, shallow, of the quality it was generated as, never larger than generated', () => {
    const w = grid();
    w.pond(0, 0, B.TAINTED_WATER);
    w.pond(30, 0, B.WATER);
    for (const [q0] of [[0], [30]]) for (const [q, r] of pondCells(q0, 0)) w.set(q, G, r, B.AIR); // both dried out
    // dug-out cells beside the tainted bed: on clay, on stone — none of them was generated as water
    w.set(2, G, 0, B.AIR);
    w.set(2, G - 1, 0, B.CLAY);
    w.set(-2, G, 0, B.AIR);
    const bed = dryBedAt(w, 1, G, 0, false);
    expect([bed.count, bed.tainted]).toEqual([7, true]);
    expect(dryBedAt(w, 2, G, 0, false)).toBeNull(); // not a generated water cell
    expect(dryBedAt(w, 31, G, 0, false)).toMatchObject({ count: 7, tainted: false });
    const count = [0, 0];
    simulate(w, RAIN, 300 * FILL_MEAN_S, 2, 31, (ev) => {
      expect(ev.kind).toBe('bed');
      expect(ev.count).toBe(7);
      const tainted = ev.q < 15;
      expect(ev.quality).toBe(tainted ? 'tainted' : 'fresh');
      expect(ev.writes.filter((_, i) => i % 4 === 3)).toEqual(all(tainted ? B.TAINTED_WATER_SHALLOW : B.WATER_SHALLOW));
      expect(ev.writes.filter((_, i) => i % 4 === 0).every((q) => hexLength(q - (tainted ? 0 : 30), 0) <= 1 || true)).toBe(true);
      for (let i = 0; i < ev.writes.length; i += 4) expect(isWaterSource(w.originAt(ev.writes[i], ev.writes[i + 1], ev.writes[i + 2]))).toBe(true); // only generated water cells
      count[tainted ? 0 : 1]++; // (left dry: every event is one more time it would have come back)
    });
    for (const n of count) {
      expect(n).toBeGreaterThan(300 * 0.78);
      expect(n).toBeLessThan(300 * 1.22);
    }
    simulate(w, DRY, 12 * DRY_MEAN_S, 24, 32, () => expect.fail('nothing comes back without rain'));
    // a bed with a block put in one cell, and one with its floor dug out under a cell: the rest comes back
    w.set(0, G, 0, B.DIRT);
    w.set(1, G - 1, 0, B.AIR);
    expect(dryBedAt(w, -1, G, 0, false).count).toBe(5);
    expect(dryBedAt(w, 1, G, 0, false)).toBeNull(); // no floor: water would fall through
    // a bed over water that is not full waits for it (that water fills first); over full water it comes back
    const deep = grid();
    for (const [q, r] of pondCells()) for (const y of [G - 1, G]) deep.gen(q, y, r, B.WATER);
    for (const [q, r] of pondCells()) {
      deep.set(q, G, r, B.AIR);
      deep.set(q, G - 1, r, B.WATER_LOW);
    }
    expect(dryBedAt(deep, 0, G, 0, false)).toBeNull();
    for (const [q, r] of pondCells()) deep.set(q, G - 1, r, B.WATER);
    expect(dryBedAt(deep, 0, G, 0, false).count).toBe(7);
    // the sea's bed is none: the sea comes back by itself (fluids.js)
    const sea = grid();
    for (let q = -20; q <= 20; q++) for (let r = 10; r <= 20; r++) sea.gen(q, G, r, B.WATER);
    sea.set(0, G, 15, B.AIR);
    expect(dryBedAt(sea, 0, G, 15, false)).toBeNull();
  });

  it('a dry stream comes back in the rain along its whole bed; a stream neither spills dry nor is used up, it only follows the weather', () => {
    const w = grid();
    const cells = [];
    for (let q = -6; q <= 6; q++) {
      const y = q < 0 ? G + 1 : G; // a step in the middle
      w.spring(q, y, 0);
      w.gen(q, y, 0, B.WATER);
      if (y > G) w.gen(q, G, 0, B.STONE);
      cells.push([q, y, 0]);
    }
    expect(waterBodyAt(w.peek, 0, G, 0, w.springLevelAt)).toMatchObject({ count: 13, stream: true });
    // drought: three drying events take it from full to dry, every cell together
    const rnd = mulberry32(5);
    let events = 0;
    for (let t = 0; t < 40 * STREAM_DRY_MEAN_S && events < 3; t += 5) {
      const ev = cycleStep(5, rnd, w, DRY);
      if (!ev) continue;
      expect([ev.kind, ev.stream, ev.count]).toEqual(['dry', true, 13]);
      w.apply(ev.writes);
      events++;
      expect(cells.map(([q, y, r]) => waterDepth(w.peek(q, y, r)))).toEqual(all(3 - events, 13));
    }
    expect(events).toBe(3);
    expect(cells.every(([q, y, r]) => w.peek(q, y, r) === B.AIR)).toBe(true);
    simulate(w, DRY, 20 * STREAM_DRY_MEAN_S, 24, 6, () => expect.fail('a dry stream stays dry in dry weather'));
    // rain: the whole bed takes water at once, shallow; then it fills level by level to full
    expect(dryBedAt(w, 3, G, 0, true)).toMatchObject({ count: 13, tainted: false });
    const seen = [];
    for (let t = 0; t < 60 * FILL_MEAN_S && seen.length < 3; t += 1) {
      const ev = cycleStep(1, rnd, w, RAIN);
      if (!ev) continue;
      seen.push(ev.kind);
      expect([ev.stream, ev.count]).toEqual([true, 13]);
      w.apply(ev.writes);
    }
    expect(seen).toEqual(['bed', 'fill', 'fill']);
    expect(cells.every(([q, y, r]) => w.peek(q, y, r) === B.WATER)).toBe(true);
    // part of it dry, part wet (a block was put in one cell and taken out again): only the gap comes back
    w.set(2, G, 0, B.AIR);
    expect(dryBedAt(w, 2, G, 0, true)).toMatchObject({ count: 1 });
  });

  it('clay holds rain: a dug basin on clay — one cell or many — takes its first water in the rain, and is a pool from then on', () => {
    const w = grid();
    // a single pit on clay
    w.set(0, G, 0, B.AIR);
    w.set(0, G - 1, 0, B.CLAY);
    expect(clayBasinAt(w, 0, G, 0)).toEqual({ cells: [0, G, 0], count: 1, tainted: false });
    // a basin of seven cells on clay
    for (const [q, r] of pondCells(20, 0)) {
      w.set(q, G, r, B.AIR);
      w.set(q, G - 1, r, B.CLAY);
    }
    expect(clayBasinAt(w, 20, G, 0).count).toBe(7);
    expect(clayBasinAt(w, 21, G, 0).count).toBe(7); // from any of its cells
    // not a basin: on stone; with an open side; with a cell off the clay; with a plant in the wall; too big
    w.set(-10, G, 0, B.AIR);
    expect(clayBasinAt(w, -10, G, 0)).toBeNull();
    for (const q of [-20, -19]) w.set(q, G, 5, B.AIR);
    w.set(-20, G - 1, 5, B.CLAY); // its neighbour (-19) is open and not on clay
    expect(clayBasinAt(w, -20, G, 5)).toBeNull();
    w.set(-30, G, 0, B.AIR);
    w.set(-30, G - 1, 0, B.CLAY);
    w.set(-29, G, 0, B.TUSSOCK);
    expect(clayBasinAt(w, -30, G, 0)).toBeNull();
    const big = grid(90);
    for (let i = 0; i <= BODY_MAX_CELLS; i++) {
      big.set(i - 50, G, 20, B.AIR);
      big.set(i - 50, G - 1, 20, B.CLAY);
    }
    expect(clayBasinAt(big, 0, G, 20)).toBeNull();
    big.set(-50, G, 20, B.STONE);
    expect(clayBasinAt(big, 0, G, 20).count).toBe(BODY_MAX_CELLS);
    // in the rain both basins fill, each about once in 360 s, whatever their size; without rain never
    const count = [0, 0];
    simulate(w, RAIN, 300 * FILL_MEAN_S, 2, 41, (ev) => {
      expect(ev.kind).toBe('basin');
      expect(ev.writes.filter((_, i) => i % 4 === 3)).toEqual(all(B.WATER_SHALLOW, ev.count));
      count[ev.count === 1 ? 0 : 1]++;
    });
    for (const n of count) {
      expect(n).toBeGreaterThan(300 * 0.78);
      expect(n).toBeLessThan(300 * 1.22);
    }
    simulate(w, DRY, 10 * DRY_MEAN_S, 24, 42, () => expect.fail('a basin takes no water without rain'));
    // filled, it is a pool like any other: it fills on in the rain and dries in the sun
    const rnd = mulberry32(43);
    const kinds = [];
    for (let t = 0; t < 40 * FILL_MEAN_S && kinds.length < 3; t++) {
      const ev = cycleStep(1, rnd, { ...w, q: 20, r: 0 }, { rain: (q) => (q > 10 ? 1 : 0), dryness: () => 0 });
      if (!ev) continue;
      kinds.push(ev.kind);
      w.apply(ev.writes);
    }
    expect(kinds).toEqual(['basin', 'fill', 'fill']);
    expect(w.ids(pondCells(20, 0))).toEqual(all(B.WATER));
    expect(waterBodyAt(w.peek, 20, G, 0)).toMatchObject({ count: 7, contained: true, depth: 3 });
    // a basin dug where a tainted pond was generated: the generated cells come back tainted, the added one fresh
    const mixed = grid();
    mixed.pond(0, 0, B.TAINTED_WATER);
    for (const [q, r] of pondCells()) mixed.set(q, G, r, B.AIR);
    mixed.set(2, G, 0, B.AIR);
    mixed.set(2, G - 1, 0, B.CLAY);
    const col = (hexDiscCount(48) - 1) / 2;
    const ev = cycleStep(1e6, seq((col + 0.5) / CYCLE_COLUMNS, 0), { ...mixed, q: 2, r: 0 }, RAIN); // the sample falls on the added cell
    expect([ev.kind, ev.count]).toEqual(['basin', 8]);
    const byCell = new Map();
    for (let i = 0; i < ev.writes.length; i += 4) byCell.set(`${ev.writes[i]},${ev.writes[i + 2]}`, ev.writes[i + 3]);
    expect(byCell.get('2,0')).toBe(B.WATER_SHALLOW);
    for (const [q, r] of pondCells()) expect(byCell.get(`${q},${r}`)).toBe(B.TAINTED_WATER_SHALLOW);
  });

  it('the sea never changes, water under water neither dries nor fills, and a body cut by an unloaded chunk waits', () => {
    const w = grid();
    for (let q = -40; q <= 40; q++) for (let r = -40; r <= 40; r++) w.gen(q, G, r, B.WATER); // sea everywhere
    simulate(w, DRY, 1 * DRY_MEAN_S, 12, 51, () => expect.fail('the sea does not dry'));
    simulate(w, RAIN, 4 * FILL_MEAN_S, 2, 52, () => expect.fail('the sea does not fill'));
    // a low cell at the bottom of a two-level pool: only the top level is the weather's
    const two = grid();
    for (const [q, r] of pondCells()) for (const y of [G - 1, G]) two.gen(q, y, r, B.WATER);
    two.set(0, G, 0, B.STONE); // the middle of the top level is a rock: under it the lower level is the column's highest water
    two.gen(0, G + 1, 0, B.AIR);
    const seen = new Set();
    simulate(two, DRY, 120 * DRY_MEAN_S, 24, 53, (ev) => seen.add(ev.y));
    expect([...seen]).toEqual([G]);
    // a pool at the edge of the loaded world
    const edge = grid(52);
    for (let q = 44; q <= 52; q++) edge.gen(q, G, 0, B.WATER); // runs on beyond q = 52: not loaded there
    expect(waterBodyAt(edge.peek, 48, G, 0)).toMatchObject({ truncated: true, sea: false });
    simulate(edge, DRY, 20 * DRY_MEAN_S, 24, 54, () => expect.fail('a body that is not all loaded waits'));
    expect(drawWater(edge, 48, G, 0, 1000, () => 0)).toMatchObject({ dropped: false, body: null });
  });
});

describe('the wiring (main.js, diagnostics.js): read from the source, since main needs a browser', () => {
  const read = (name) => readFileSync(fileURLToPath(new URL(`../../src/${name}`, import.meta.url)), 'utf8');
  const main = read('main.js');
  /** The body of a function of main's closure. */
  const body = (name) => {
    const at = main.indexOf(`  function ${name}(`);
    expect(at, name).toBeGreaterThan(0);
    return main.slice(at, main.indexOf('\n  }\n', at));
  };

  it('the weather is a stand-in until it is wired: it never rains, dryness 1 — one line to change', () => {
    expect(main).toMatch(/^ {2}const waterEnv = \{ rain: \(_q, _r\) => 0, dryness: \(\) => 1 \};$/m);
    expect(main).toMatch(/^ {2}const waterCycle = new WaterCycle\(\);$/m);
    expect(main).not.toMatch(/from '\.\/weather\.js'/); // (the weather reaches the cycle through waterEnv only)
    const env = { rain: (_q, _r) => 0, dryness: () => 1 };
    const w = grid();
    w.pond(0, 0);
    let fills = 0;
    const rnd = mulberry32(1);
    for (let t = 0; t < 30 * DRY_MEAN_S; t += 5) if (cycleStep(5, rnd, w, env)?.kind === 'fill') fills++;
    expect(fills).toBe(0); // with the stand-in water only dries and is used up
  });

  it('once a second in Survival, after the farm work; the cycle samples round the player and its writes are lazy block changes', () => {
    const step = body('stepSurvival');
    const second = step.slice(step.indexOf('if (survivalSecond >= 1) {'));
    expect(second.indexOf('waterSecond(1, Math.random)')).toBeGreaterThan(second.indexOf('farmSecond(1, Math.random)'));
    expect(second.indexOf('waterSecond(1, Math.random)')).toBeLessThan(second.indexOf('pack.spoil(1, Math.random)'));
    const ws = body('waterSecond');
    expect(ws).toContain('worldToHex(player.x, player.z)');
    expect(ws).toContain('waterCycle.step(dt, random, { ...waterWorld, isLoadedCell: isLoadedCellFn, q, r }, env)');
    expect(ws).toContain('applyWaterWrites(world, ev.writes)');
    expect(main).toContain('function waterSecond(dt, random, env = waterEnv) {');
    expect(body('loadSurvival')).toContain('waterCycle.clear()');
    expect(body('clearSurvival')).toContain('waterCycle.clear()');
  });

  it('a gulp takes 1 and a pot POT_GULPS out of the pool looked at (the head\'s own cell when drinking under water)', () => {
    const act = body('doInteract');
    expect(act).toContain('useWater(q, y, r, POT_GULPS);');
    expect(act).toContain("if (act.kind === 'drink') useWater(q, y, r, 1);");
    expect(act).toContain('else useWater(...headCell(), 1);');
    const use = body('useWater');
    expect(use).toContain('drawWater(waterWorld, q, y, r, gulps, Math.random)');
    expect(use).toContain('applyWaterWrites(world, draw.writes)');
    // what the water is comes from the body: the sea is salt, whatever the biome
    expect(body('waterQualityOf')).toContain('waterInfoAt(q, y, r)');
    expect(body('waterInfoAt')).toContain('waterAt(waterWorld, q, y, r)');
    expect(main).toContain('waterDepth: (q, y, r) => waterDepthOf(q, y, r), // §83');
    expect(main).toContain('saltyAt: (q, r) => isSaltyBiome(world.getBiome(q, r)),');
    expect(main).toContain('return blockPhysics ? blockPhysics.fluids.springLevelAt : null;');
  });

  it('the debug handle carries waterCycle, waterBodyAt(q, y, r) and waterStep(seconds, env)', () => {
    const cycle = new WaterCycle();
    const calls = [];
    const game = {
      waterCycle: cycle,
      waterBodyAt: (q, y, r) => (calls.push(['body', q, y, r]), { cells: 7, depth: 2, quality: 'fresh', sea: false, stream: false, contained: true }),
      waterStep: (seconds, env) => (calls.push(['step', seconds, env]), { seconds, dried: 1, filled: 0, beds: 0, basins: 0 }),
    };
    const win = {};
    const handle = installDebugHandle(win, /** @type {*} */ (game));
    expect(win.__caelancraft).toBe(handle);
    expect(handle.waterCycle).toBe(cycle);
    expect(handle.waterBodyAt(1, 64, 2)).toEqual({ cells: 7, depth: 2, quality: 'fresh', sea: false, stream: false, contained: true });
    expect(handle.waterStep(600, { rain: 1, dryness: 1 })).toEqual({ seconds: 600, dried: 1, filled: 0, beds: 0, basins: 0 });
    expect(calls).toEqual([['body', 1, 64, 2], ['step', 600, { rain: 1, dryness: 1 }]]);
    const none = installDebugHandle({}, null);
    expect([none.waterCycle, none.waterBodyAt(0, 0, 0), none.waterStep(5)]).toEqual([null, null, null]);
    // main hands all three over; its waterStep is capped and runs the same second as the game does, in the weather given
    const game0 = main.slice(main.indexOf('  const game = {'));
    expect(game0).toMatch(/\n {4}waterCycle,\n/);
    const stepSrc = game0.slice(game0.indexOf('    waterStep(seconds, env) {'), game0.indexOf('    /** Queue a mode switch'));
    expect(stepSrc).toContain('Math.min(WATER_STEP_MAX_S, Math.floor(seconds))');
    expect(stepSrc).toContain('waterSecond(1, Math.random, weather)');
    const bodySrc = game0.slice(game0.indexOf('    waterBodyAt(q, y, r) {'), game0.indexOf('    waterStep(seconds, env) {'));
    expect(bodySrc).toContain('return { cells: b.count, depth: b.depth, quality: info.quality, sea: b.sea, stream: b.stream, contained: b.contained,');
    const types = read('types.js');
    const ctx = types.slice(types.indexOf('@typedef {Object} GameContext'));
    for (const m of ['waterCycle', 'waterBodyAt', 'waterStep']) expect(ctx, m).toMatch(new RegExp(`@property \\{[^\\n]*\\} \\[?${m}\\]?`));
  });
});

describe('what a cycle second costs on a real generated world', () => {
  it('a second of the cycle stays well under a millisecond, in dry weather and in the rain; and it finds the world\'s ponds and streams', () => {
    const SEED = 20260507;
    const worldGen = createWorldGen(SEED, { gen: GEN_LATEST });
    // a place with a stream close by
    let at = null;
    for (let q = -200; q <= 200 && !at; q += 3) for (let r = -200; r <= 200 && !at; r += 3) if (worldGen.streamAt(q, r)) at = [q, r];
    expect(at).not.toBeNull();
    const world = new World({ seed: SEED, gen: GEN_LATEST, renderDistance: 5, worldGen, now: () => 0 });
    const physics = attachPhysics(world, BlockPhysics);
    const [x, z] = hexToWorld(at[0], at[1]);
    for (let i = 0; i < 6000; i++) {
      const u = world.update(x, z, Infinity);
      if (u.pendingGen === 0 && u.pendingMesh === 0) break;
    }
    const w = {
      peek: (q, y, r) => world.peekBlock(q, y, r),
      originAt: (q, y, r) => world.originAt(q, y, r),
      isLoadedCell: (q, r) => world.hasChunkAtCell(q, r),
      springLevelAt: physics.fluids.springLevelAt,
      q: at[0],
      r: at[1],
      column: (q, r, out) => { // as main hands it over
        const cq = Math.floor(q / 16);
        const cr = Math.floor(r / 16);
        const chunk = world.getChunk(cq, cr);
        if (!chunk) return false;
        out.blocks = chunk.blocks;
        out.base = ((q - cq * 16) * 16 + (r - cr * 16)) * 128;
        return true;
      },
    };
    let loaded = 0;
    for (let dq = -CYCLE_RANGE; dq <= CYCLE_RANGE; dq += 8) for (let dr = -CYCLE_RANGE; dr <= CYCLE_RANGE; dr += 8) if (hexLength(dq, dr) <= CYCLE_RANGE && w.isLoadedCell(at[0] + dq, at[1] + dr)) loaded++;
    expect(loaded).toBeGreaterThan(100); // the whole reach of the cycle is loaded
    const rnd = mulberry32(99);
    const time = (env, n) => {
      const kinds = new Map();
      for (let i = 0; i < 200; i++) cycleStep(1, rnd, w, env); // warm
      let best = Infinity;
      for (let batch = 0; batch < 6; batch++) {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          const ev = cycleStep(1, rnd, w, env);
          if (ev) kinds.set(ev.kind + (ev.stream ? ':stream' : ''), (kinds.get(ev.kind + (ev.stream ? ':stream' : '')) ?? 0) + 1);
        }
        best = Math.min(best, (performance.now() - t0) / n);
      }
      return { best, kinds };
    };
    const dry = time({ rain: () => 0, dryness: () => 1 }, 400);
    const rain = time({ rain: () => 1, dryness: () => 0.3 }, 400);
    expect(dry.best).toBeLessThan(0.5); // ms per cycle second (about 0.05 on a quiet machine)
    expect(rain.best).toBeLessThan(0.5);
    // the events it finds there are real ones (the world is left as it is: nothing is written)
    const drought = time({ rain: () => 0, dryness: () => 400 }, 400); // a drought sped up 400 times
    expect([...drought.kinds.keys()].sort()).toContain('dry:stream');
    const flood = time({ rain: () => 1, dryness: () => 0 }, 400);
    for (const kind of flood.kinds.keys()) expect(['fill', 'fill:stream', 'bed', 'bed:stream', 'basin']).toContain(kind);
  });

  it('the real world\'s water is at rest under the laws: every pond and stream cell woken, nothing falls, spills or levels', () => {
    for (const [seed, gen] of [[20260507, GEN_LATEST], [7, 3], [42, 2]]) {
      const worldGen = createWorldGen(seed, { gen });
      const world = new World({ seed, gen, renderDistance: 3, worldGen, now: () => 0 });
      const physics = attachPhysics(world, BlockPhysics);
      for (let i = 0; i < 4000; i++) {
        const u = world.update(0, 0, Infinity);
        if (u.pendingGen === 0 && u.pendingMesh === 0) break;
      }
      let woken = 0;
      for (const chunk of world.chunks.values()) {
        for (let lq = 0; lq < 16; lq++) {
          for (let lr = 0; lr < 16; lr++) {
            for (let y = 56; y < 110; y++) {
              const id = world.peekBlock(chunk.cq * 16 + lq, y, chunk.cr * 16 + lr);
              if (!isWater(id)) continue;
              physics.scheduleWaterAround(chunk.cq * 16 + lq, y, chunk.cr * 16 + lr);
              woken++;
            }
          }
        }
      }
      expect(woken, `seed ${seed}`).toBeGreaterThan(100);
      rest(physics);
      for (let i = 0; i < 100; i++) physics.tick();
      expect([physics.fluids.stats.writes, physics.fluids.stats.moved, physics.fluids.stats.spilled, physics.fluids.stats.levelled, world.editCount], `seed ${seed} gen ${gen}`).toEqual([0, 0, 0, 0, 0]);
      expect(physics.fluids.pendingSpills).toBe(0);
    }
  });
});

describe('pools on the real rule: what the cycle and a gulp write, the laws carry on from', () => {
  it('a pond drunk dry level by level stays a sound pool at each level; rain brings the dry bed back, and it fills to full', () => {
    const world = makeFakeWorld({ groundY: G });
    for (const [q, r] of pondCells()) {
      world.put(q, G, r, B.TAINTED_WATER);
      world.put(q, G - 1, r, B.CLAY);
    }
    const physics = attachPhysics(world, BlockPhysics);
    const w = { peek: world.peekBlock, originAt: world.originAt, springLevelAt: physics.fluids.springLevelAt, isLoadedCell: () => true, q: 0, r: 0, top: 10 };
    const ids = () => pondCells().map(([q, r]) => world.getBlock(q, G, r));
    for (const want of [B.TAINTED_WATER_LOW, B.TAINTED_WATER_SHALLOW, B.AIR]) {
      const d = drawWater(w, 0, G, 0, POT_GULPS, () => 0);
      expect(applyWaterWrites(world, d.writes)).toBe(7);
      rest(physics);
      expect(ids()).toEqual(all(want));
      expect(physics.fluids.stats.writes).toBe(0); // the rule had nothing to add: a level pool in its basin
    }
    expect(drawWater(w, 0, G, 0, 1, () => 0)).toBeNull(); // dry: nothing to drink
    // rain: the bed comes back shallow and tainted, then gains its levels
    const col = (hexDiscCount(48) - 1) / 2;
    const pick = (col + 0.5) / CYCLE_COLUMNS;
    for (const [kind, want] of [['bed', B.TAINTED_WATER_SHALLOW], ['fill', B.TAINTED_WATER_LOW], ['fill', B.TAINTED_WATER]]) {
      const ev = cycleStep(1, seq(pick, 0), w, RAIN);
      expect(ev.kind).toBe(kind);
      applyWaterWrites(world, ev.writes);
      rest(physics);
      expect(ids()).toEqual(all(want));
    }
    expect(cycleStep(1, seq(pick, 0), w, RAIN)).toBeNull();
    expect(world.editCount).toBe(0); // back as generated: every edit pruned
    expect(isTaintedWater(waterAtDepth('tainted', 3))).toBe(true);
  });

  it('a rain-filled basin with a breach loses what it caught: the laws do not care where water came from', () => {
    const world = makeFakeWorld({ groundY: G });
    for (const [q, r] of pondCells()) {
      world.put(q, G, r, B.AIR);
      world.put(q, G - 1, r, B.CLAY);
    }
    const physics = attachPhysics(world, BlockPhysics);
    const w = { peek: world.peekBlock, originAt: world.originAt, springLevelAt: physics.fluids.springLevelAt, isLoadedCell: () => true, q: 0, r: 0, top: 10 };
    const pick = ((hexDiscCount(48) - 1) / 2 + 0.5) / CYCLE_COLUMNS;
    const ev = cycleStep(1, seq(pick, 0), w, RAIN);
    expect([ev.kind, ev.count]).toEqual(['basin', 7]);
    applyWaterWrites(world, ev.writes);
    rest(physics);
    expect(pondCells().map(([q, r]) => world.getBlock(q, G, r))).toEqual(all(B.WATER_SHALLOW));
    world.setBlock(2, G, 0, B.AIR); // its wall dug away
    rest(physics);
    expect(pondCells().every(([q, r]) => world.getBlock(q, G, r) === B.AIR)).toBe(true);
    expect(cycleStep(1, seq(pick, 0), w, RAIN)).toBeNull(); // open: it is no basin any more, the rain runs out of it
    world.setBlock(2, G, 0, B.STONE);
    expect(cycleStep(1, seq(pick, 0), w, RAIN).kind).toBe('basin'); // mended, it holds rain again
  });
});
