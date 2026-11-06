// Unit tests for src/blackholes.js — black hole tracking, pull and swallowing (CONTRACTS §29).
import { describe, it, expect } from 'vitest';
import { BLOCK, BLOCKS, isSolid, isOpaque, isPlaceable, isBreakable, isTargetable } from '../../src/blocks.js';
import {
  BLACK_HOLE_PULL_RADIUS, BLACK_HOLE_PULL_STRENGTH, BLACK_HOLE_EAT_RADIUS, BLACK_HOLE_EAT_INTERVAL_S,
  BLACK_HOLE_MAX_EATS_PER_FRAME, BLACK_HOLE_MAX_TRACKED, CHUNK_SIZE,
} from '../../src/config.js';
import { BlackHoles, EAT_OFFSETS, canSwallow, holeKey } from '../../src/blackholes.js';
import { hexToWorld, hexDistance } from '../../src/hex.js';
import { localIndex, chunkKey } from '../../src/coords.js';
import { createPlayer, stepPlayer } from '../../src/physics.js';
import { World } from '../../src/world.js';
import { flatWorldGen } from '../helpers/fixtures.js';

const B = BLOCK;

/** A Map-backed world: every cell in `cells` ("q,y,r" → id), AIR elsewhere; `loaded(q, r)` defaults to true. */
function fakeWorld(cells = new Map(), loaded = () => true) {
  const holes = new BlackHoles();
  const world = {
    cells,
    getBlock: (q, y, r) => cells.get(holeKey(q, y, r)) ?? B.AIR,
    setBlock(q, y, r, id) {
      const k = holeKey(q, y, r);
      const prev = cells.get(k) ?? B.AIR;
      if (prev === id) return false;
      if (id === B.AIR) cells.delete(k);
      else cells.set(k, id);
      holes.onBlockChange(q, y, r, prev, id);
      return true;
    },
    isLoaded: loaded,
  };
  return { holes, world };
}

/** Fill every cell within the eat radius of (0, 10, 0) with `id`. */
function packBall(cells, id) {
  for (const [dq, dy, dr] of EAT_OFFSETS) cells.set(holeKey(dq, 10 + dy, dr), id);
}

describe('black_hole block', () => {
  it('is placeable, breakable and targetable but not solid, so the player can fall in', () => {
    const d = BLOCKS[B.BLACK_HOLE];
    expect(d.name).toBe('black_hole');
    expect(d.displayName).toBe('Black Hole');
    expect(isSolid(B.BLACK_HOLE)).toBe(false);
    expect(isOpaque(B.BLACK_HOLE)).toBe(false);
    expect(isPlaceable(B.BLACK_HOLE)).toBe(true);
    expect(isBreakable(B.BLACK_HOLE)).toBe(true);
    expect(isTargetable(B.BLACK_HOLE)).toBe(true);
  });
});

describe('canSwallow', () => {
  it('protects air, liquids, bedrock, rune blocks and other black holes', () => {
    for (const id of [B.AIR, B.WATER, B.BEDROCK, B.RUNE_BLOCK, B.BLACK_HOLE]) expect(canSwallow(id)).toBe(false);
    for (const id of [B.STONE, B.GRASS_BLOCK, B.GLASS, B.OAK_LEAVES, B.ICE, B.GOLD_BLOCK]) expect(canSwallow(id)).toBe(true);
  });
});

describe('EAT_OFFSETS', () => {
  it('covers the ball of radius BLACK_HOLE_EAT_RADIUS nearest-first, without the centre or duplicates', () => {
    const seen = new Set();
    let last = 0;
    for (const [dq, dy, dr] of EAT_OFFSETS) {
      const [x, z] = hexToWorld(dq, dr);
      const [ox, oz] = hexToWorld(0, 0);
      const d = Math.hypot(x - ox, dy, z - oz);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(BLACK_HOLE_EAT_RADIUS);
      expect(d).toBeGreaterThanOrEqual(last - 1e-12);
      last = d;
      const k = `${dq},${dy},${dr}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    // The 6 side neighbours and the cells above / below come first (distance 1).
    expect(EAT_OFFSETS.slice(0, 8).every(([dq, dy, dr]) => hexDistance(0, 0, dq, dr) + Math.abs(dy) === 1)).toBe(true);
    expect(Object.isFrozen(EAT_OFFSETS)).toBe(true);
  });
});

describe('BlackHoles tracking', () => {
  it('follows onBlockChange: placing adds, replacing or breaking removes', () => {
    const h = new BlackHoles();
    h.onBlockChange(3, 20, -4, B.AIR, B.BLACK_HOLE);
    expect(h.size).toBe(1);
    expect(h.holes.get('3,20,-4')).toMatchObject({ q: 3, y: 20, r: -4, cy: 20.5 });
    h.onBlockChange(3, 20, -4, B.BLACK_HOLE, B.BLACK_HOLE);
    expect(h.size).toBe(1);
    h.onBlockChange(3, 20, -4, B.BLACK_HOLE, B.STONE);
    expect(h.size).toBe(0);
  });
  it('caps the tracked set at BLACK_HOLE_MAX_TRACKED', () => {
    const h = new BlackHoles();
    for (let i = 0; i < BLACK_HOLE_MAX_TRACKED + 5; i++) h.add(i, 10, 0);
    expect(h.size).toBe(BLACK_HOLE_MAX_TRACKED);
    expect(h.add(0, 10, 0)).toBe(false);
  });
  it('loadFromEdits finds every recorded black hole (and only those)', () => {
    const edits = new Map([
      [chunkKey(0, 0), new Map([[localIndex(1, 30, 2), B.BLACK_HOLE], [localIndex(5, 30, 5), B.STONE]])],
      [chunkKey(-1, 2), new Map([[localIndex(15, 64, 0), B.BLACK_HOLE]])],
    ]);
    const h = new BlackHoles();
    h.add(99, 1, 99);
    h.loadFromEdits(edits);
    expect([...h.holes.keys()].sort()).toEqual([holeKey(1, 30, 2), holeKey(-CHUNK_SIZE + 15, 64, 2 * CHUNK_SIZE)].sort());
  });
  it('a real World save round-trip restores the holes from World.edits', () => {
    const w = new World({ worldGen: flatWorldGen(10), renderDistance: 1 });
    w.update(0, 0, 1e9);
    expect(w.setBlock(2, 20, 3, B.BLACK_HOLE)).toBe(true);
    const w2 = new World({ worldGen: flatWorldGen(10), renderDistance: 1, edits: w.exportEdits() });
    const h = new BlackHoles();
    h.loadFromEdits(w2.edits);
    expect([...h.holes.keys()]).toEqual(['2,20,3']);
  });
});

describe('BlackHoles.pullAt', () => {
  it('pulls toward the centre with STRENGTH·(1 − d/R)², nothing at or beyond R', () => {
    const h = new BlackHoles();
    h.add(0, 10, 0); // centre (0, 10.5, 0)
    const [ax, ay, az] = h.pullAt(3, 10.5, 0);
    expect(ax).toBeCloseTo(-BLACK_HOLE_PULL_STRENGTH * (1 - 3 / BLACK_HOLE_PULL_RADIUS) ** 2, 9);
    expect(ay).toBeCloseTo(0, 12);
    expect(az).toBeCloseTo(0, 12);
    expect(h.pullAt(0, 10.5 + BLACK_HOLE_PULL_RADIUS, 0)).toEqual([0, 0, 0]);
    expect(h.pullAt(0, 10.5, 0)).toEqual([0, 0, 0]); // exactly at the centre: no direction, no NaN
    const up = h.pullAt(0, 6.5, 0);
    expect(up[1]).toBeGreaterThan(0);
  });
  it('sums several holes (two opposite holes cancel)', () => {
    const h = new BlackHoles();
    h.add(2, 10, 0);
    h.add(-2, 10, 0);
    const [ax, ay, az] = h.pullAt(0, 10.5, 0);
    expect(Math.hypot(ax, ay, az)).toBeLessThan(1e-9);
  });
  it('drags a walking player in: physics applies pullX/Y/Z as acceleration', () => {
    const groundY = 10;
    const getBlock = (_q, y) => (y < groundY ? B.STONE : B.AIR);
    const h = new BlackHoles();
    h.add(0, groundY, 0); // hole sitting on the ground at the origin
    const p = createPlayer(2.5, groundY, 0);
    const input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };
    for (let i = 0; i < 120; i++) {
      const [px, py, pz] = h.pullAt(p.x, p.y + 0.9, p.z);
      stepPlayer(p, { ...input, pullX: px, pullY: py, pullZ: pz }, getBlock, 1 / 60);
      if (h.swallowing(p)) break;
    }
    expect(h.swallowing(p)).not.toBeNull();
  });
});

describe('BlackHoles.update (swallowing)', () => {
  it('eats one cell per interval, nearest first, and records the old id', () => {
    const cells = new Map();
    const { holes, world } = fakeWorld(cells);
    world.setBlock(0, 10, 0, B.BLACK_HOLE);
    packBall(cells, B.STONE);
    expect(holes.update(BLACK_HOLE_EAT_INTERVAL_S * 0.5, world)).toEqual([]);
    const eaten = holes.update(BLACK_HOLE_EAT_INTERVAL_S * 0.5, world);
    expect(eaten).toHaveLength(1);
    const [dq, dy, dr] = EAT_OFFSETS[0];
    expect(eaten[0]).toEqual({ q: dq, y: 10 + dy, r: dr, id: B.STONE });
    expect(world.getBlock(dq, 10 + dy, dr)).toBe(B.AIR);
    // The next interval eats the next-nearest cell.
    const [q2, y2, r2] = EAT_OFFSETS[1];
    expect(holes.update(BLACK_HOLE_EAT_INTERVAL_S, world)).toEqual([{ q: q2, y: 10 + y2, r: r2, id: B.STONE }]);
  });
  it('empties its whole ball, then goes idle; never touches protected cells', () => {
    const cells = new Map();
    const { holes, world } = fakeWorld(cells);
    world.setBlock(0, 10, 0, B.BLACK_HOLE);
    packBall(cells, B.DIRT);
    const [pq, py, pr] = EAT_OFFSETS[3];
    cells.set(holeKey(pq, 10 + py, pr), B.BEDROCK);
    cells.set(holeKey(EAT_OFFSETS[4][0], 10 + EAT_OFFSETS[4][1], EAT_OFFSETS[4][2]), B.WATER);
    let total = 0;
    for (let i = 0; i < EAT_OFFSETS.length + 10; i++) total += holes.update(BLACK_HOLE_EAT_INTERVAL_S, world).length;
    expect(total).toBe(EAT_OFFSETS.length - 2);
    expect(world.getBlock(pq, 10 + py, pr)).toBe(B.BEDROCK);
    expect([...cells.values()].sort()).toEqual([B.WATER, B.BEDROCK, B.BLACK_HOLE].sort());
    // Idle until new food appears inside the ball.
    expect(holes.update(10, world)).toEqual([]);
    world.setBlock(0, 11, 0, B.SAND);
    expect(holes.update(BLACK_HOLE_EAT_INTERVAL_S, world)).toEqual([{ q: 0, y: 11, r: 0, id: B.SAND }]);
  });
  it('shares at most BLACK_HOLE_MAX_EATS_PER_FRAME eats per frame across holes', () => {
    const cells = new Map();
    const { holes, world } = fakeWorld(cells);
    for (let i = 0; i < 10; i++) {
      world.setBlock(i * 20, 10, 0, B.BLACK_HOLE);
      world.setBlock(i * 20, 9, 0, B.STONE);
    }
    expect(holes.update(BLACK_HOLE_EAT_INTERVAL_S, world)).toHaveLength(BLACK_HOLE_MAX_EATS_PER_FRAME);
    // The holes that waited go first next frame, even with a tiny dt.
    expect(holes.update(1e-6, world)).toHaveLength(BLACK_HOLE_MAX_EATS_PER_FRAME);
    expect(holes.update(1e-6, world)).toHaveLength(2);
    expect([...cells.values()].filter((id) => id === B.STONE)).toHaveLength(0);
  });
  it('is frozen while its own chunk or the target chunk is unloaded', () => {
    const cells = new Map();
    let loaded = true;
    const { holes, world } = fakeWorld(cells, (q) => loaded || q <= 0);
    world.setBlock(0, 10, 0, B.BLACK_HOLE);
    const [dq, dy, dr] = EAT_OFFSETS.find(([q]) => q > 0);
    cells.set(holeKey(dq, 10 + dy, dr), B.STONE);
    loaded = false;
    for (let i = 0; i < 20; i++) expect(holes.update(BLACK_HOLE_EAT_INTERVAL_S, world)).toEqual([]);
    expect(world.getBlock(dq, 10 + dy, dr)).toBe(B.STONE);
    loaded = true;
    expect(holes.update(BLACK_HOLE_EAT_INTERVAL_S, world)).toEqual([{ q: dq, y: 10 + dy, r: dr, id: B.STONE }]);
  });
  it('breaking the hole stops it', () => {
    const cells = new Map();
    const { holes, world } = fakeWorld(cells);
    world.setBlock(0, 10, 0, B.BLACK_HOLE);
    packBall(cells, B.STONE);
    world.setBlock(0, 10, 0, B.AIR);
    expect(holes.size).toBe(0);
    expect(holes.update(10, world)).toEqual([]);
  });
});

describe('BlackHoles.swallowing', () => {
  it('reports the hole whose cell the player overlaps', () => {
    const h = new BlackHoles();
    h.add(0, 10, 0);
    const [x, z] = hexToWorld(0, 0);
    expect(h.swallowing(createPlayer(x, 9.2, z))?.key).toBe('0,10,0');
    expect(h.swallowing(createPlayer(x + 3, 10, z))).toBeNull();
    expect(h.swallowing(createPlayer(x, 11, z))).toBeNull();
  });
});
