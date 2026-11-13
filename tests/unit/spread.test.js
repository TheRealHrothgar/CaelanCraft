// Tests for src/spread.js — plants that spread on their own (CONTRACTS §80): the table of kinds and their soft
// maxima, the birth chance and its derivation, what counts as a plant that can seed and as ground a seed can land on,
// one step's rolls in order, plants from nothing, and the rates by simulation. Pure module; every roll is injected.
import { describe, it, expect } from 'vitest';
import { WORLD_HEIGHT, DAY_LENGTH_SECONDS } from '../../src/config.js';
import { BLOCK, BLOCKS, FARM_IDS, isPlant } from '../../src/blocks.js';
import { hexDiscCount, hexLength } from '../../src/hex.js';
import { RIPE_OF } from '../../src/harvest.js';
import { CROPS, cropOf } from '../../src/farming.js';
import {
  SPREAD_SAMPLES, SPREAD_RANGE, SPREAD_RADIUS, SPREAD_STEP, SPREAD_RISE, SPREAD_MEAN_S, SPREAD_COLUMNS, SPREAD_BIRTH,
  SPONTANEOUS_MEAN_S, SPONTANEOUS_CLEAR, SPREAD_KINDS, spreadKindOf, crowding, birthChance, discCells, spreaderAt, countKind,
  plantNear, canGrowAt, siteNear, surfaceCell, spreadStep, Spread,
} from '../../src/spread.js';
import { mulberry32 } from '../../src/noise.js';
import { makeFakeWorld } from '../helpers/fixtures.js';

const B = BLOCK;
/** The ground of the test worlds: `groundId` up to y = G, so a plant stands in the cell at y = G + 1. */
const G = 10;
const Y = G + 1;
const flat = (groundId = B.GRASS_BLOCK) => makeFakeWorld({ groundY: G, groundId });
const kindOf = (key) => SPREAD_KINDS.find((k) => k.key === key);
/** A `random` that returns the listed values in turn, then the last one for ever; `.calls` counts the draws. */
function seq(...vals) {
  let i = 0;
  const f = () => {
    f.calls++;
    return vals[Math.min(i++, vals.length - 1)];
  };
  f.calls = 0;
  return f;
}
/** The roll that makes a sample land on the column (dq, dr) from the player. */
function column(dq, dr) {
  const cells = discCells(SPREAD_RANGE);
  for (let i = 0; i < cells.length; i += 2) if (cells[i] === dq && cells[i + 1] === dr) return (i / 2 + 0.5) / SPREAD_COLUMNS;
  throw new Error(`(${dq}, ${dr}) is out of range`);
}
/** The roll that makes a seed land (dq, dr) from its parent (never (0, 0): the parent's own column is not on the list). */
function neighbour(dq, dr) {
  const cells = discCells(SPREAD_STEP);
  const others = cells.length / 2 - 1;
  for (let i = 0; i < cells.length; i += 2) {
    if (cells[i] === dq && cells[i + 1] === dr) {
      const j = i / 2;
      if (j === others / 2) break;
      return ((j > others / 2 ? j - 1 : j) + 0.5) / others;
    }
  }
  throw new Error(`(${dq}, ${dr}) is not a neighbour within SPREAD_STEP`);
}
/** A roll that lands on no plant in these worlds (the far corner of the range) and is no birth and no spontaneous moment. */
const MISS = 0.9999;
/** The SpreadWorld of a fake world, the player at (0, 0); `top` keeps the column scans short. */
const view = (w, o = {}) => ({ getBlock: w.getBlock, isLoadedCell: w.hasChunkAtCell, q: 0, r: 0, top: Y + 12, ...o });

describe('the constants and the derivation of the birth chance', () => {
  it('48 samples a second within 48 cells; a lone plant seeds every three game days; from nothing once in ten', () => {
    expect([SPREAD_SAMPLES, SPREAD_RANGE, SPREAD_RADIUS, SPREAD_STEP, SPREAD_RISE]).toEqual([48, 48, 6, 3, 4]);
    expect(SPREAD_MEAN_S).toBe(4320);
    expect(SPREAD_MEAN_S).toBe(3 * DAY_LENGTH_SECONDS);
    expect(SPONTANEOUS_MEAN_S).toBe(14400);
    expect(SPONTANEOUS_MEAN_S).toBe(10 * DAY_LENGTH_SECONDS);
    expect(SPONTANEOUS_CLEAR).toBe(3);
  });

  it('SPREAD_BIRTH is derived, not chosen: columns in range ÷ (samples × the mean)', () => {
    expect(SPREAD_COLUMNS).toBe(hexDiscCount(SPREAD_RANGE));
    expect(SPREAD_COLUMNS).toBe(7057);
    expect(SPREAD_BIRTH).toBe(SPREAD_COLUMNS / (SPREAD_SAMPLES * SPREAD_MEAN_S));
    expect(SPREAD_BIRTH).toBeCloseTo(0.034, 3);
    // a given column is sampled SAMPLES / COLUMNS times a second, so a lone plant's births per second are 1 / the mean
    expect((SPREAD_SAMPLES / SPREAD_COLUMNS) * SPREAD_BIRTH * SPREAD_MEAN_S).toBeCloseTo(1, 12);
  });
});

describe('the kinds that spread (SPREAD_KINDS)', () => {
  it('eleven rows: the nine crops in their order, then the two mushrooms; each with its soft maximum', () => {
    expect(SPREAD_KINDS.map((k) => [k.key, k.cap])).toEqual([
      ['carrot', 8], ['onion', 8], ['tuber', 6], ['honeyberry', 5], ['hazel', 4], ['crab_apple', 4], ['healwort', 3], ['prickly_pear', 5],
      ['cattails', 10], ['honeycap', 8], ['frecklecap', 6],
    ]);
    expect(SPREAD_KINDS.slice(0, 9).map((k) => k.key)).toEqual(CROPS.map((c) => c.key));
    SPREAD_KINDS.forEach((k, i) => expect(k.index).toBe(i));
    expect(Object.isFrozen(SPREAD_KINDS) && SPREAD_KINDS.every((k) => Object.isFrozen(k) && Object.isFrozen(k.blocks))).toBe(true);
  });

  it('ripe and picked are the same kind; a new plant is the crop\'s grown block: roots and mushrooms ripe, bushes picked', () => {
    const rows = Object.fromEntries(SPREAD_KINDS.map((k) => [k.key, [[...k.blocks], k.born]]));
    expect(rows).toEqual({
      carrot: [[B.CARROT_PLANT], B.CARROT_PLANT],
      onion: [[B.ONION_PLANT], B.ONION_PLANT],
      tuber: [[B.TUBER_PLANT], B.TUBER_PLANT],
      honeyberry: [[B.HONEYBERRY_BUSH, B.HONEYBERRY_BUSH_BARE], B.HONEYBERRY_BUSH_BARE],
      hazel: [[B.HAZEL_THICKET, B.HAZEL_THICKET_BARE], B.HAZEL_THICKET_BARE],
      crab_apple: [[B.CRAB_APPLE_BUSH, B.CRAB_APPLE_BUSH_BARE], B.CRAB_APPLE_BUSH_BARE],
      healwort: [[B.HEALWORT_PLANT, B.HEALWORT_PLANT_BARE], B.HEALWORT_PLANT_BARE],
      prickly_pear: [[B.PRICKLY_PEAR, B.PRICKLY_PEAR_BARE], B.PRICKLY_PEAR_BARE],
      cattails: [[B.CATTAILS], B.CATTAILS],
      honeycap: [[B.HONEYCAP_MUSHROOM], B.HONEYCAP_MUSHROOM],
      frecklecap: [[B.FRECKLECAP_MUSHROOM], B.FRECKLECAP_MUSHROOM],
    });
    for (const k of SPREAD_KINDS) {
      expect(k.blocks, k.key).toContain(k.born);
      for (const id of k.blocks) {
        expect(spreadKindOf(id), BLOCKS[id].name).toBe(k);
        expect(isPlant(id), BLOCKS[id].name).toBe(true);
        // a picked block is in the kind of its ripe one
        if (Object.hasOwn(RIPE_OF, id)) expect(k.blocks, BLOCKS[id].name).toContain(RIPE_OF[id]);
      }
      const crop = cropOf(k.key);
      if (crop) expect([k.born, k.soil, k.reed, k.shade], k.key).toEqual([crop.grown, crop.soil, crop.reed, false]);
    }
    // the mushrooms want shade: grass or dirt under cover, or a cave's stone floor; only the cattail is a reed
    expect(SPREAD_KINDS.filter((k) => k.shade).map((k) => [k.key, [...k.soil], [...k.cave]])).toEqual([
      ['honeycap', [B.GRASS_BLOCK, B.DIRT], [B.STONE]], ['frecklecap', [B.GRASS_BLOCK, B.DIRT], [B.STONE]],
    ]);
    expect(SPREAD_KINDS.filter((k) => k.reed).map((k) => k.key)).toEqual(['cattails']);
    expect(SPREAD_KINDS.filter((k) => !k.shade).every((k) => k.cave.length === 0)).toBe(true);
  });

  it('nothing else spreads: not the tussock, not a planted seed or a sprout, not the ground', () => {
    for (const id of [B.TUSSOCK, ...FARM_IDS, B.AIR, B.GRASS_BLOCK, B.OAK_LEAVES, B.LOOSE_STONES, B.GROUND_NEST, 255, 256, -1, 1.5, NaN, null, undefined, '125']) {
      expect(spreadKindOf(/** @type {*} */ (id)), String(id)).toBeNull();
    }
    const spreading = SPREAD_KINDS.flatMap((k) => k.blocks);
    expect(new Set(spreading).size).toBe(spreading.length);
    expect(spreading).toHaveLength(16);
  });
});

describe('the chance: proportional below the cap, zero at it', () => {
  it('crowding is 1 for a plant alone and falls in a straight line to 0 at the cap, where it stays', () => {
    for (const { key, cap } of SPREAD_KINDS) {
      expect(crowding(1, cap), key).toBe(1);
      expect(crowding(cap, cap), key).toBe(0);
      expect(crowding(cap + 1, cap) + crowding(cap + 50, cap), key).toBe(0);
      for (let n = 1; n <= cap; n++) {
        expect(crowding(n, cap), `${key} ${n}`).toBeCloseTo((cap - n) / (cap - 1), 12);
        if (n < cap) expect(crowding(n, cap) - crowding(n + 1, cap), `${key} ${n}`).toBeCloseTo(1 / (cap - 1), 12); // equal steps
      }
    }
    expect([crowding(1, 8), crowding(2, 8), crowding(8, 8), crowding(2, 3), crowding(0, 5)]).toEqual([1, 6 / 7, 0, 0.5, 1]);
    expect(crowding(1, 1) + crowding(0, 1) + crowding(1, 0)).toBe(0); // a cap of one never seeds
  });

  it('birthChance is SPREAD_BIRTH × crowding × dt, never above 1', () => {
    expect(birthChance(1, 8)).toBe(SPREAD_BIRTH);
    expect(birthChance(5, 8)).toBeCloseTo((SPREAD_BIRTH * 3) / 7, 12);
    expect(birthChance(8, 8)).toBe(0);
    expect(birthChance(3, 3) + birthChance(9, 4)).toBe(0);
    expect(birthChance(1, 8, 10)).toBeCloseTo(10 * SPREAD_BIRTH, 12);
    expect(birthChance(1, 8, 1e6)).toBe(1);
  });
});

describe('the columns a roll can pick (discCells)', () => {
  it('every cell within the radius once, the middle one in the middle', () => {
    for (const radius of [0, 1, SPREAD_STEP, SPREAD_RADIUS, SPREAD_RANGE]) {
      const cells = discCells(radius);
      expect(cells.length).toBe(hexDiscCount(radius) * 2);
      const seen = new Set();
      for (let i = 0; i < cells.length; i += 2) {
        expect(hexLength(cells[i], cells[i + 1])).toBeLessThanOrEqual(radius);
        seen.add(`${cells[i]},${cells[i + 1]}`);
      }
      expect(seen.size).toBe(hexDiscCount(radius));
      const mid = (cells.length / 2 - 1) / 2;
      expect([cells[mid * 2], cells[mid * 2 + 1]]).toEqual([0, 0]);
      expect(discCells(radius)).toBe(cells); // cached
    }
    expect([...discCells(1)]).toEqual([-1, 0, -1, 1, 0, -1, 0, 0, 0, 1, 1, -1, 1, 0]);
    expect([hexDiscCount(SPREAD_STEP), hexDiscCount(SPREAD_RADIUS)]).toEqual([37, 127]);
  });
});

describe('the plant that can seed (spreaderAt) and its neighbours (countKind)', () => {
  it('the highest spreading plant of the column; none on bare ground or under a tussock', () => {
    const w = flat();
    expect(spreaderAt(w.getBlock, 0, 0)).toBeNull();
    w.put(0, Y, 0, B.TUSSOCK);
    expect(spreaderAt(w.getBlock, 0, 0)).toBeNull();
    for (const k of SPREAD_KINDS) {
      for (const id of k.blocks) {
        w.put(0, Y, 0, id);
        expect(spreaderAt(w.getBlock, 0, 0), BLOCKS[id].name).toEqual({ y: Y, kind: k });
      }
    }
    expect(spreaderAt(w.getBlock, 0, 0, Y - 1)).toBeNull(); // `top` bounds the look
    expect(spreaderAt(w.getBlock, 1, 0)).toBeNull();
  });

  it('a plant that needs the sky seeds from under leaves, not from under a roof; a mushroom seeds from anywhere', () => {
    const under = (id, cover) => {
      const w = flat();
      w.put(0, Y, 0, id);
      if (cover) w.put(0, Y + 3, 0, cover);
      return spreaderAt(w.getBlock, 0, 0);
    };
    expect(under(B.CARROT_PLANT, B.OAK_LEAVES)).toMatchObject({ y: Y });
    expect(under(B.CARROT_PLANT, B.GLASS)).toMatchObject({ y: Y });
    expect(under(B.CARROT_PLANT, B.OAK_PLANKS)).toBeNull();
    expect(under(B.HAZEL_THICKET_BARE, B.STONE)).toBeNull();
    for (const cover of [null, B.OAK_LEAVES, B.OAK_PLANKS, B.STONE]) expect(under(B.HONEYCAP_MUSHROOM, cover), String(cover)).toMatchObject({ y: Y });
    // a cave under the grass: the look goes on down past the ground, and past a roofed plant, to a mushroom below
    const w = flat();
    w.put(0, 4, 0, B.FRECKLECAP_MUSHROOM);
    expect(spreaderAt(w.getBlock, 0, 0)).toEqual({ y: 4, kind: kindOf('frecklecap') });
    w.put(0, 7, 0, B.ONION_PLANT); // an onion in a higher gallery, under the ground: it does not seed
    expect(spreaderAt(w.getBlock, 0, 0)).toEqual({ y: 4, kind: kindOf('frecklecap') });
    w.put(0, Y, 0, B.ONION_PLANT); // one on the surface does
    expect(spreaderAt(w.getBlock, 0, 0)).toEqual({ y: Y, kind: kindOf('onion') });
  });

  it('countKind: the plant itself and every other of its kind within six cells, ripe or picked, a few levels up or down', () => {
    const w = flat();
    const hazel = kindOf('hazel');
    w.put(0, Y, 0, B.HAZEL_THICKET);
    expect(countKind(w.getBlock, hazel, 0, Y, 0)).toBe(1);
    w.put(6, Y, 0, B.HAZEL_THICKET_BARE); // at the radius: counted
    w.put(-3, Y, -3, B.HAZEL_THICKET);
    expect(countKind(w.getBlock, hazel, 0, Y, 0)).toBe(3);
    w.put(7, Y, 0, B.HAZEL_THICKET); // one cell beyond: not counted
    w.put(-4, Y, -3, B.HAZEL_THICKET);
    w.put(2, Y, 2, B.CRAB_APPLE_BUSH); // another kind
    w.put(1, Y, 1, B.PLANTED_HAZEL); // a planted seed and a sprout are no plants yet
    w.put(1, Y, 2, B.HAZEL_SPROUT);
    expect(countKind(w.getBlock, hazel, 0, Y, 0)).toBe(3);
    w.put(2, Y + SPREAD_RISE, -1, B.HAZEL_THICKET);
    w.put(-2, Y - SPREAD_RISE, 1, B.HAZEL_THICKET_BARE);
    expect(countKind(w.getBlock, hazel, 0, Y, 0)).toBe(5);
    w.put(3, Y + SPREAD_RISE + 1, -1, B.HAZEL_THICKET);
    w.put(4, Y, -2, B.HAZEL_THICKET);
    w.put(4, Y + 2, -2, B.HAZEL_THICKET); // two in one column are one
    expect(countKind(w.getBlock, hazel, 0, Y, 0)).toBe(6);
    expect(countKind(w.getBlock, kindOf('crab_apple'), 0, Y, 0)).toBe(1);
    expect(countKind(w.getBlock, kindOf('carrot'), 0, Y, 0)).toBe(0);
  });

  it('plantNear: any spreading plant within the reach, whatever its kind', () => {
    const w = flat();
    expect(plantNear(w.getBlock, 0, Y, 0, 3)).toBe(false);
    w.put(4, Y, 0, B.FRECKLECAP_MUSHROOM);
    w.put(1, Y, 0, B.TUSSOCK);
    w.put(0, Y, 1, B.PLANTED_CARROT);
    expect(plantNear(w.getBlock, 0, Y, 0, 3)).toBe(false);
    expect(plantNear(w.getBlock, 0, Y, 0, 4)).toBe(true);
    w.put(-3, Y - 2, 3, B.PRICKLY_PEAR_BARE);
    expect(plantNear(w.getBlock, 0, Y, 0, 3)).toBe(true);
  });
});

describe('where a plant can come up (canGrowAt, siteNear, surfaceCell)', () => {
  it('a sky kind: AIR over its own soil with no opaque block above', () => {
    for (const k of SPREAD_KINDS.filter((kind) => !kind.shade)) {
      for (const ground of [B.GRASS_BLOCK, B.DIRT, B.SAND, B.RED_SAND, B.STONE, B.GRAVEL, B.SNOWY_GRASS]) {
        const w = flat(ground);
        if (k.reed) w.put(1, G, 0, B.WATER);
        expect(canGrowAt(w.getBlock, k, 0, Y, 0), `${k.key} on ${BLOCKS[ground].name}`).toBe(k.soil.includes(ground));
      }
      const w = flat(k.soil[0]);
      if (k.reed) w.put(1, G, 0, B.WATER);
      expect(canGrowAt(w.getBlock, k, 0, Y + 1, 0), k.key).toBe(false); // not in mid air
      expect(canGrowAt(w.getBlock, k, 0, G, 0), k.key).toBe(false); // not inside the ground
      w.put(0, Y + 6, 0, B.OAK_LEAVES);
      expect(canGrowAt(w.getBlock, k, 0, Y, 0), k.key).toBe(true); // leaves are no roof
      w.put(0, Y + 7, 0, B.OAK_LOG);
      expect(canGrowAt(w.getBlock, k, 0, Y, 0), k.key).toBe(false);
      for (const taken of [B.TUSSOCK, B.WATER, B.LOOSE_STONES, B.PLANTED_ONION, k.born]) {
        const v = flat(k.soil[0]);
        if (k.reed) v.put(1, G, 0, B.WATER);
        v.put(0, Y, 0, taken);
        expect(canGrowAt(v.getBlock, k, 0, Y, 0), `${k.key} into ${BLOCKS[taken].name}`).toBe(false); // only ever into AIR
      }
    }
    expect(canGrowAt(flat().getBlock, kindOf('carrot'), 0, 0, 0)).toBe(false);
    expect(canGrowAt(() => B.AIR, kindOf('carrot'), 0, WORLD_HEIGHT, 0)).toBe(false);
  });

  it('a cattail comes up only with water within one cell', () => {
    const reed = kindOf('cattails');
    const w = flat(B.SAND);
    expect(canGrowAt(w.getBlock, reed, 0, Y, 0)).toBe(false);
    w.put(2, G, 0, B.WATER);
    expect(canGrowAt(w.getBlock, reed, 0, Y, 0)).toBe(false);
    expect(canGrowAt(w.getBlock, reed, 1, Y, 0)).toBe(true);
    expect(canGrowAt(w.getBlock, reed, 3, Y, -1)).toBe(true);
    w.put(2, G, 0, B.TAINTED_WATER); // a foul pond has its reeds too
    expect(canGrowAt(w.getBlock, reed, 1, Y, 0)).toBe(true);
  });

  it('a mushroom: grass or dirt under a tree or a roof, or stone under a roof; never under the open sky', () => {
    for (const k of [kindOf('honeycap'), kindOf('frecklecap')]) {
      const on = (ground, cover) => {
        const w = flat(ground);
        if (cover) w.put(0, Y + 5, 0, cover);
        return canGrowAt(w.getBlock, k, 0, Y, 0);
      };
      expect([on(B.GRASS_BLOCK, null), on(B.DIRT, null), on(B.STONE, null)]).toEqual([false, false, false]);
      expect([on(B.GRASS_BLOCK, B.OAK_LEAVES), on(B.DIRT, B.BIRCH_LEAVES), on(B.GRASS_BLOCK, B.OAK_LOG), on(B.DIRT, B.STONE)]).toEqual([true, true, true, true]);
      expect([on(B.STONE, B.OAK_LEAVES), on(B.STONE, B.STONE), on(B.STONE, B.OAK_PLANKS)]).toEqual([false, true, true]);
      expect([on(B.SAND, B.STONE), on(B.GRAVEL, B.STONE), on(B.COBBLESTONE, B.STONE), on(B.GRASS_BLOCK, B.GLASS)]).toEqual([false, false, false, false]);
      // in a cave: the gallery's floor, under the rock above it
      const cave = flat(B.STONE);
      cave.put(0, 5, 0, B.AIR);
      cave.put(0, 6, 0, B.AIR);
      expect(canGrowAt(cave.getBlock, k, 0, 5, 0)).toBe(true);
      expect(canGrowAt(cave.getBlock, k, 0, 6, 0)).toBe(false); // AIR below it
    }
  });

  it('siteNear: the cell of the column where the kind can grow, within SPREAD_RISE of the parent\'s height', () => {
    const carrot = kindOf('carrot');
    const w = flat();
    expect(siteNear(w.getBlock, carrot, 1, 0, Y)).toBe(Y);
    for (let up = 1; up <= SPREAD_RISE + 1; up++) w.put(2, G + up, 0, B.DIRT); // a bank beside it
    expect(siteNear(w.getBlock, carrot, 2, 0, Y)).toBe(-1); // its top is SPREAD_RISE + 1 above: too high
    expect(siteNear(w.getBlock, carrot, 2, 0, Y + 1)).toBe(Y + SPREAD_RISE + 1);
    w.put(3, G, 0, B.AIR); // a step down
    w.put(3, G - 1, 0, B.DIRT);
    expect(siteNear(w.getBlock, carrot, 3, 0, Y)).toBe(G);
    w.put(4, Y, 0, B.LOOSE_STONES);
    expect(siteNear(w.getBlock, carrot, 4, 0, Y)).toBe(-1);
    expect(siteNear(flat(B.SAND).getBlock, carrot, 0, 0, Y)).toBe(-1);
    // a mushroom's seed lands on the gallery floor it stands on, not on the grass above it
    const cave = flat();
    for (const q of [0, 1]) for (const y of [4, 5]) cave.put(q, y, 0, B.AIR);
    cave.put(0, 3, 0, B.STONE);
    cave.put(1, 3, 0, B.STONE);
    expect(siteNear(cave.getBlock, kindOf('honeycap'), 1, 0, 4)).toBe(4);
  });

  it('surfaceCell: the open cell on top of the column, under any leaves', () => {
    const w = flat();
    expect(surfaceCell(w.getBlock, 0, 0)).toBe(Y);
    w.put(0, Y + 4, 0, B.OAK_LEAVES);
    w.put(0, Y + 5, 0, B.OAK_LEAVES);
    expect(surfaceCell(w.getBlock, 0, 0)).toBe(Y);
    w.put(0, Y, 0, B.OAK_LEAVES); // leaves lying on the ground: no open cell
    expect(surfaceCell(w.getBlock, 0, 0)).toBe(-1);
    w.put(1, Y, 0, B.CARROT_PLANT);
    expect(surfaceCell(w.getBlock, 1, 0)).toBe(Y + 1); // (nothing grows on a plant: canGrowAt says no)
    expect(SPREAD_KINDS.some((k) => canGrowAt(w.getBlock, k, 1, Y + 1, 0))).toBe(false);
    expect(surfaceCell(() => B.AIR, 0, 0)).toBe(-1);
    expect(surfaceCell(() => B.STONE, 0, 0)).toBe(-1); // a full column
  });
});

describe('one step (spreadStep): the rolls in order', () => {
  it('with no plant about: one roll a sample and one for the moment from nothing; no birth', () => {
    const w = flat();
    const random = seq(MISS);
    expect(spreadStep(1, random, view(w))).toBeNull();
    expect(random.calls).toBe(SPREAD_SAMPLES + 1);
    expect(spreadStep(0, seq(0), view(w)) ?? spreadStep(-1, seq(0), view(w)) ?? spreadStep(NaN, seq(0), view(w))).toBeNull();
    const none = seq(0);
    spreadStep(0, none, view(w));
    expect(none.calls).toBe(0);
  });

  it('a sampled plant seeds a neighbour within three cells: a third roll picks the column, and the step ends', () => {
    const w = flat();
    w.put(5, Y, -2, B.CARROT_PLANT);
    const random = seq(MISS, MISS, column(5, -2), SPREAD_BIRTH - 1e-9, neighbour(-1, 3));
    const birth = spreadStep(1, random, view(w));
    expect(birth).toEqual({ q: 4, y: Y, r: 1, id: B.CARROT_PLANT, kind: kindOf('carrot'), seeded: true, parent: [5, Y, -2] });
    expect(random.calls).toBe(5); // two misses, the hit, the birth roll, the neighbour: nothing after a birth
    expect(w.writes).toEqual([]); // the step writes nothing: main does
    // every one of the 36 neighbours can be picked, and never the parent's own column
    const landed = new Set();
    const cells = discCells(SPREAD_STEP);
    for (let i = 0; i < cells.length; i += 2) {
      if (cells[i] === 0 && cells[i + 1] === 0) continue;
      const b = spreadStep(1, seq(column(5, -2), 0, neighbour(cells[i], cells[i + 1])), view(w));
      expect([b.q - 5, b.r + 2]).toEqual([cells[i], cells[i + 1]]);
      landed.add(`${b.q},${b.r}`);
    }
    expect(landed.size).toBe(36);
    for (const r of [0, 0.25, 0.4999, 0.5, 0.75, 0.9999]) {
      const b = spreadStep(1, seq(column(5, -2), 0, r), view(w));
      expect(hexLength(b.q - 5, b.r + 2)).toBeGreaterThanOrEqual(1);
      expect(hexLength(b.q - 5, b.r + 2)).toBeLessThanOrEqual(SPREAD_STEP);
    }
  });

  it('the birth roll is against SPREAD_BIRTH × crowding: a miss goes on to the next sample', () => {
    const w = flat();
    w.put(0, Y, 0, B.CARROT_PLANT);
    const here = column(0, 0);
    expect(here).toBeCloseTo(0.5, 3); // the player's own column is the middle of the list
    const miss = seq(here, SPREAD_BIRTH, MISS);
    expect(spreadStep(1, miss, view(w))).toBeNull();
    expect(miss.calls).toBe(SPREAD_SAMPLES + 2);
    expect(spreadStep(1, seq(here, SPREAD_BIRTH - 1e-9, 0), view(w))).not.toBeNull();
    // four carrots within six cells: each seeds at 4/7 of the lone chance
    for (const [q, r] of [[2, 0], [-3, 1], [0, -5]]) w.put(q, Y, r, B.CARROT_PLANT);
    const p = SPREAD_BIRTH * (4 / 7);
    expect(birthChance(4, 8)).toBeCloseTo(p, 12);
    expect(spreadStep(1, seq(here, p + 1e-9, MISS), view(w))).toBeNull();
    expect(spreadStep(1, seq(here, p - 1e-9, neighbour(1, 1)), view(w))).toMatchObject({ q: 1, r: 1, seeded: true });
    // dt scales it
    expect(spreadStep(10, seq(here, 10 * p - 1e-9, neighbour(1, 1)), view(w))).toMatchObject({ q: 1, r: 1 });
    expect(spreadStep(10, seq(here, 10 * p + 1e-9, MISS), view(w))).toBeNull();
  });

  it('at the soft maximum a plant seeds no more: no birth roll is drawn, whatever the rolls', () => {
    for (const k of SPREAD_KINDS) {
      const w = flat(k.shade ? B.GRASS_BLOCK : k.soil[0]);
      // the kind's cap of plants round the player, in a ring two cells out (under a roof for the mushrooms, by water for the reed)
      const ring = [[0, 0], [2, 0], [0, 2], [-2, 2], [-2, 0], [0, -2], [2, -2], [1, 1], [-1, 2], [-2, 1]].slice(0, k.cap);
      for (let q = -8; q <= 8; q++) {
        for (let r = -8; r <= 8; r++) {
          if (k.shade) w.put(q, Y + 6, r, B.OAK_LEAVES);
          if (k.reed) w.put(q, G - 1, r, B.WATER);
        }
      }
      for (const [q, r] of ring) w.put(q, Y, r, k.blocks[k.blocks.length - 1]);
      expect(countKind(w.getBlock, k, 0, Y, 0), k.key).toBe(k.cap);
      // The sample lands on the plant in the middle, and no birth roll follows: the rolls of 0 after it are taken as
      // the next SAMPLES (the first column of the list, far from every plant), so the step draws one roll a sample and
      // the one for a plant from nothing, as it does with no plant about.
      const random = seq(column(0, 0), 0, 0, MISS);
      expect(spreadStep(1, random, view(w)), k.key).toBeNull();
      expect(random.calls, k.key).toBe(SPREAD_SAMPLES + 1);
      // one fewer and it seeds again
      w.put(ring[ring.length - 1][0], Y, ring[ring.length - 1][1], B.AIR);
      expect(spreadStep(1, seq(column(0, 0), birthChance(k.cap - 1, k.cap) - 1e-9, neighbour(3, 0)), view(w)), k.key).toMatchObject({ id: k.born, seeded: true });
    }
  });

  it('a seed lands only in AIR over its soil: on anything else it is lost, and nothing is ever overwritten', () => {
    const w = flat();
    w.put(0, Y, 0, B.ONION_PLANT);
    const spoil = (q, r, put) => {
      put(q, r);
      const random = seq(column(0, 0), 0, neighbour(q, r), MISS);
      expect(spreadStep(1, random, view(w)), `${q},${r}`).toBeNull();
      expect(random.calls).toBe(SPREAD_SAMPLES + 3); // the seed was rolled for, and lost
    };
    spoil(1, 0, (q, r) => w.put(q, Y, r, B.TUSSOCK));
    spoil(0, 1, (q, r) => w.put(q, Y, r, B.CARROT_PLANT));
    spoil(-1, 1, (q, r) => w.put(q, G, r, B.STONE));
    spoil(-1, 0, (q, r) => w.put(q, G, r, B.WATER));
    spoil(0, -1, (q, r) => w.put(q, Y + 9, r, B.OAK_PLANKS));
    spoil(1, -1, (q, r) => w.put(q, Y, r, B.PLANTED_ONION));
    spoil(2, 0, (q, r) => w.put(q, Y, r, B.GROUND_NEST));
    spoil(3, 0, (q, r) => w.put(q, G, r, B.SAND));
    expect(spreadStep(1, seq(column(0, 0), 0, neighbour(0, 2)), view(w))).toMatchObject({ q: 0, y: Y, r: 2, id: B.ONION_PLANT });
  });

  it('only loaded columns: an unloaded sample is not looked at, and a seed into an unloaded column is lost', () => {
    const w = flat();
    w.put(15, Y, 0, B.CARROT_PLANT); // in chunk (0, 0), at its edge
    w.put(20, Y, 0, B.CARROT_PLANT); // in chunk (1, 0)
    w.unload(1, 0);
    let reads = 0; // of cells in the unloaded chunk
    const counting = {
      ...view(w),
      getBlock: (q, y, r) => {
        if (!w.hasChunkAtCell(q, r)) reads++;
        return w.getBlock(q, y, r);
      },
    };
    const sampled = seq(column(20, 0), MISS);
    expect(spreadStep(1, sampled, counting)).toBeNull();
    expect(sampled.calls).toBe(SPREAD_SAMPLES + 1); // no birth roll for the plant that is not there
    expect(reads).toBe(0);
    const lost = seq(column(15, 0), 0, neighbour(1, 0), MISS);
    expect(spreadStep(1, lost, view(w))).toBeNull();
    expect(lost.calls).toBe(SPREAD_SAMPLES + 3);
    expect(spreadStep(1, seq(column(15, 0), 0, neighbour(-1, 0)), view(w))).toMatchObject({ q: 14, r: 0 });
  });

  it('each kind seeds its own: bushes come up picked, mushrooms and roots ripe, each on its own ground', () => {
    for (const k of SPREAD_KINDS) {
      const w = flat(k.shade ? B.DIRT : k.soil[k.soil.length - 1]);
      for (let q = -4; q <= 4; q++) {
        for (let r = -4; r <= 4; r++) {
          if (k.shade) w.put(q, Y + 6, r, B.SPRUCE_LEAVES);
          if (k.reed) w.put(q, G - 1, r, B.WATER);
        }
      }
      w.put(0, Y, 0, k.blocks[0]);
      const birth = spreadStep(1, seq(column(0, 0), 0, neighbour(2, -1)), view(w));
      expect(birth, k.key).toEqual({ q: 2, y: Y, r: -1, id: k.born, kind: k, seeded: true, parent: [0, Y, 0] });
    }
  });

  it('a mushroom under a tree seeds only into the shade; one in a cave seeds along the gallery floor', () => {
    const w = flat();
    for (const [q, r] of [[0, 0], [1, 0], [0, 1]]) w.put(q, Y + 5, r, B.OAK_LEAVES);
    w.put(0, Y, 0, B.HONEYCAP_MUSHROOM);
    expect(spreadStep(1, seq(column(0, 0), 0, neighbour(1, 0)), view(w))).toMatchObject({ q: 1, y: Y, r: 0, id: B.HONEYCAP_MUSHROOM });
    expect(spreadStep(1, seq(column(0, 0), 0, neighbour(2, 0), MISS), view(w))).toBeNull(); // out in the open: lost
    const cave = flat(B.STONE);
    for (let q = 0; q <= 3; q++) for (const y of [5, 6]) cave.put(q, y, 0, B.AIR);
    cave.put(0, 5, 0, B.FRECKLECAP_MUSHROOM);
    expect(spreadStep(1, seq(column(0, 0), 0, neighbour(3, 0)), view(cave))).toMatchObject({ q: 3, y: 5, r: 0, id: B.FRECKLECAP_MUSHROOM });
    expect(spreadStep(1, seq(column(0, 0), 0, neighbour(0, 3), MISS), view(cave))).toBeNull(); // solid rock: lost
  });
});

describe('a plant from nothing: near zero', () => {
  /** Rolls that sample no plant, then the moment's roll and what follows it. */
  const fromNothing = (...rest) => seq(...Array(SPREAD_SAMPLES).fill(MISS), ...rest);

  it('the moment comes with chance dt / SPONTANEOUS_MEAN_S; then a column, then a kind the ground can carry', () => {
    const w = flat();
    const p = 1 / SPONTANEOUS_MEAN_S;
    const no = fromNothing(p, 0, 0);
    expect(spreadStep(1, no, view(w))).toBeNull();
    expect(no.calls).toBe(SPREAD_SAMPLES + 1);
    // open grass carries the seven kinds of the grassland: not the reed, the cactus or the mushrooms
    const able = ['carrot', 'onion', 'tuber', 'honeyberry', 'hazel', 'crab_apple', 'healwort'];
    able.forEach((key, i) => {
      const random = fromNothing(p - 1e-12, column(7, -3), (i + 0.5) / able.length);
      expect(spreadStep(1, random, view(w)), key).toEqual({ q: 7, y: Y, r: -3, id: kindOf(key).born, kind: kindOf(key), seeded: false, parent: null });
      expect(random.calls).toBe(SPREAD_SAMPLES + 3);
    });
    expect(spreadStep(10, fromNothing(10 * p - 1e-12, column(7, -3), 0), view(w))).not.toBeNull();
    expect(spreadStep(10, fromNothing(10 * p + 1e-12, column(7, -3), 0), view(w))).toBeNull();
  });

  it('the kind is one the land there can carry: sand a cactus, a bank its reeds, a forest floor its mushrooms too', () => {
    const born = (w, pick = 0) => spreadStep(1, fromNothing(0, column(0, 0), pick), view(w))?.kind.key ?? null;
    expect(born(flat(B.SAND))).toBe('prickly_pear');
    expect(born(flat(B.RED_SAND), 0.99)).toBe('prickly_pear');
    for (const ground of [B.STONE, B.GRAVEL, B.SNOWY_GRASS, B.SNOW_BLOCK, B.CLAY]) expect(born(flat(ground)), BLOCKS[ground].name).toBeNull();
    const bank = flat(B.SAND);
    bank.put(1, G, 0, B.WATER);
    expect([born(bank, 0), born(bank, 0.99)]).toEqual(['prickly_pear', 'cattails']);
    const forest = flat();
    forest.put(0, Y + 5, 0, B.OAK_LEAVES);
    const here = new Set();
    for (let i = 0; i < 9; i++) here.add(born(forest, (i + 0.5) / 9));
    expect([...here]).toEqual(['carrot', 'onion', 'tuber', 'honeyberry', 'hazel', 'crab_apple', 'healwort', 'honeycap', 'frecklecap']);
    // water, a trunk, a roofed floor of stone under planks... carry nothing or only what fits
    const pond = flat();
    pond.put(0, G, 0, B.WATER);
    expect(born(pond)).toBeNull();
    const hut = flat();
    hut.put(0, Y + 3, 0, B.OAK_PLANKS);
    expect(born(hut)).toBeNull(); // the roof is the top of that column, and nothing grows on planks
  });

  it('never where a spreading plant of any kind stands within three cells; never in an unloaded column', () => {
    const w = flat();
    w.put(3, Y, 0, B.FRECKLECAP_MUSHROOM);
    expect(spreadStep(1, fromNothing(0, column(0, 0), 0), view(w))).toBeNull();
    expect(spreadStep(1, fromNothing(0, column(-1, 0), 0), view(w))).toMatchObject({ q: -1, r: 0, seeded: false });
    w.put(-1, Y, -3, B.HEALWORT_PLANT_BARE); // a picked plant is a plant
    expect(spreadStep(1, fromNothing(0, column(-1, 0), 0), view(w))).toBeNull();
    // a tussock, a sprout and a nest are no spreading plants
    const v = flat();
    for (const [q, id] of [[1, B.TUSSOCK], [-1, B.CARROT_SPROUT], [2, B.GROUND_NEST], [-2, B.LOOSE_STONES]]) v.put(q, Y, 0, id);
    expect(spreadStep(1, fromNothing(0, column(0, 0), 0), view(v))).not.toBeNull();
    v.unload(0, 0);
    expect(spreadStep(1, fromNothing(0, column(0, 0), 0), view(v))).toBeNull();
  });

  it('at most one birth a second: after a seeded birth there is no roll for a plant from nothing', () => {
    const w = flat();
    w.put(0, Y, 0, B.TUBER_PLANT);
    const random = seq(column(0, 0), 0, 0, 0, 0, 0);
    const birth = spreadStep(1, random, view(w));
    expect(birth.seeded).toBe(true);
    expect(random.calls).toBe(3);
  });
});

describe('by simulation', () => {
  /** A flat grass world as a plain function (fast): `plantAt(q, r)` gives the block standing on column (q, r), or AIR. */
  const meadow = (plantAt) => ({
    getBlock: (q, y, r) => (y === Y ? plantAt(q, r) : y >= 0 && y <= G ? B.GRASS_BLOCK : B.AIR),
    isLoadedCell: () => true,
    q: 0,
    r: 0,
    top: Y,
  });
  /** One plant every 14 cells, out to the edge of the range: 37 of them, none with another of its kind within six cells. */
  const lattice = (id) => (q, r) => (q % 14 === 0 && r % 14 === 0 && hexLength(q, r) <= SPREAD_RANGE ? id : B.AIR);

  it('a lone plant on open ground gives a new plant every three game days on average, whatever its kind\'s cap', () => {
    for (const [id, seed] of [[B.CARROT_PLANT, 5], [B.HEALWORT_PLANT_BARE, 6]]) {
      const world = meadow(lattice(id));
      let plants = 0;
      for (let q = -48; q <= 48; q++) for (let r = -48; r <= 48; r++) if (world.getBlock(q, Y, r) === id) plants++;
      expect(plants).toBe(37);
      expect(countKind(world.getBlock, spreadKindOf(id), 14, Y, -14)).toBe(1);
      const random = mulberry32(seed);
      const STEPS = 40000;
      let births = 0;
      for (let s = 0; s < STEPS; s++) {
        const b = spreadStep(1, random, world); // (the births are counted, not written: every plant stays alone)
        if (!b || !b.seeded) continue; // (the odd plant from nothing is not this test's business)
        expect(b.id).toBe(spreadKindOf(id).born);
        expect(hexLength(b.q - b.parent[0], b.r - b.parent[2])).toBeLessThanOrEqual(SPREAD_STEP);
        births++;
      }
      // 37 plants × 40 000 s ÷ 4320 s = 343 births expected (± 18)
      const mean = (plants * STEPS) / births;
      expect(mean / SPREAD_MEAN_S, BLOCKS[id].name).toBeGreaterThan(0.85);
      expect(mean / SPREAD_MEAN_S, BLOCKS[id].name).toBeLessThan(1.15);
    }
  });

  it('a patch left alone grows toward its soft maximum and stops; picked clean, the place stays bare', () => {
    // a world the births are written into; nine onions to start with would be over the cap, three are a patch
    const cells = new Map();
    const world = meadow((q, r) => cells.get(`${q},${r}`) ?? B.AIR);
    for (const [q, r] of [[0, 0], [2, -1], [-1, 2]]) cells.set(`${q},${r}`, B.ONION_PLANT);
    const random = mulberry32(42);
    const onion = kindOf('onion');
    const DAYS = 40;
    /** onions at the end of each day (whatever came up from nothing elsewhere in range is not the patch) */
    const onions = [];
    for (let s = 1; s <= DAYS * DAY_LENGTH_SECONDS; s++) {
      const b = spreadStep(1, random, world);
      if (b) {
        expect(cells.has(`${b.q},${b.r}`)).toBe(false); // never onto another plant
        cells.set(`${b.q},${b.r}`, b.id);
      }
      if (s % DAY_LENGTH_SECONDS === 0) onions.push([...cells.values()].filter((id) => id === B.ONION_PLANT).length);
    }
    // more appear over the first days (this seed: 4 5 5 6 8, then eight for good) …
    expect(onions[1]).toBeGreaterThan(3);
    expect(onions[9]).toBeGreaterThanOrEqual(onion.cap - 1);
    // … and then the patch is full and stays as it is: no more in the last twenty days than there were
    expect(onions[DAYS - 1]).toBe(onions[DAYS - 21]);
    expect(onions[DAYS - 1]).toBeLessThanOrEqual(onion.cap + 2);
    // nowhere do more than a few over the cap stand within six cells of a plant (the maximum is soft: a parent counts
    // round ITSELF, and its seed may land where another plant counts more)
    let most = 0;
    for (const [key, id] of cells) {
      if (id !== B.ONION_PLANT) continue;
      const [q, r] = key.split(',').map(Number);
      most = Math.max(most, countKind(world.getBlock, onion, q, Y, r));
    }
    expect(most).toBeGreaterThanOrEqual(onion.cap - 1);
    expect(most).toBeLessThanOrEqual(onion.cap + 2);

    // the same land picked clean: over the same forty days almost nothing comes
    const bare = new Map();
    const empty = meadow((q, r) => bare.get(`${q},${r}`) ?? B.AIR);
    const again = mulberry32(42);
    let fromNothing = 0;
    for (let s = 1; s <= DAYS * DAY_LENGTH_SECONDS; s++) {
      const b = spreadStep(1, again, empty);
      if (b && !b.seeded) fromNothing++;
      // (a plant from nothing is left unwritten here, so that only the rate from nothing is measured)
    }
    // one moment in ten days: four expected in forty (this seed: 2), against the five onions the patch gained in five days
    expect(fromNothing).toBeGreaterThanOrEqual(1);
    expect(fromNothing).toBeLessThanOrEqual(10);
    expect(SPREAD_COLUMNS / fromNothing).toBeGreaterThan(500); // spread over the whole range: one plant in hundreds of columns
  });
});

describe('Spread: the session\'s counts', () => {
  it('step is spreadStep, counted: seeded, from nothing, the last birth; clear forgets', () => {
    const w = flat();
    w.put(0, Y, 0, B.CARROT_PLANT);
    const s = new Spread();
    expect([s.births, s.seeded, s.spontaneous, s.last]).toEqual([0, 0, 0, null]);
    expect(s.step(1, seq(MISS), view(w))).toBeNull();
    const a = s.step(1, seq(column(0, 0), 0, neighbour(1, 0)), view(w));
    expect(a).toMatchObject({ q: 1, r: 0, seeded: true });
    const b = s.step(1, seq(...Array(SPREAD_SAMPLES).fill(MISS), 0, column(20, 5), 0), view(w));
    expect(b).toMatchObject({ q: 20, r: 5, seeded: false });
    expect([s.births, s.seeded, s.spontaneous]).toEqual([2, 1, 1]);
    expect(s.last).toBe(b);
    s.clear();
    expect([s.births, s.seeded, s.spontaneous, s.last]).toEqual([0, 0, 0, null]);
  });
});
