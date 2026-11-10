// Unit tests for src/blackholes.js — black hole tracking, pull and swallowing (CONTRACTS §29), and v2: the Collapsar
// Charge's activation, the ARM → FLASH → IMPLODE → VORTEX phases, the spiral pull, events, effects, views and the
// per-world switch (docs/DESIGN-circuits.md §2, §6.2.4, §7 A).
import { describe, it, expect } from 'vitest';
import { BLOCK, BLOCKS, isSolid, isOpaque, isPlaceable, isBreakable, isTargetable } from '../../src/blocks.js';
import {
  BLACK_HOLE_PULL_RADIUS, BLACK_HOLE_PULL_STRENGTH, BLACK_HOLE_EAT_RADIUS, BLACK_HOLE_EAT_INTERVAL_S,
  BLACK_HOLE_MAX_EATS_PER_FRAME, BLACK_HOLE_MAX_EAT_CHUNKS_PER_FRAME, BLACK_HOLE_MAX_TRACKED, CHUNK_SIZE, PLAYER_HEIGHT,
  SEA_LEVEL, BLACK_HOLE_ARM_S, BLACK_HOLE_FLASH_S, BLACK_HOLE_IMPLODE_S, BLACK_HOLE_SWIRL, BLACK_HOLE_SWIRL_CORE,
  BLACK_HOLE_FLASH_INTENSITY, BLACK_HOLE_FLASH_COLOR, BLACK_HOLE_PINCH_DEG, BLACK_HOLE_PINCH_RANGE, BLACK_HOLE_STRETCH_DEG,
} from '../../src/config.js';
import {
  BlackHoles, EAT_OFFSETS, PHASE, canSwallow, columnHasEdits, holeKey, holeSeed, phaseAt, pullFactor,
} from '../../src/blackholes.js';
import { hexToWorld, hexDistance, worldToHex } from '../../src/hex.js';
import { localIndex, chunkKey } from '../../src/coords.js';
import { createPlayer, stepPlayer } from '../../src/physics.js';
import { World } from '../../src/world.js';
import { flatWorldGen } from '../helpers/fixtures.js';

const B = BLOCK;

/**
 * A Map-backed world: every cell in `cells` ("q,y,r" → id), AIR elsewhere; `loaded(q, r)` defaults to true. Writes go
 * through `holes.onBlockChange` like World.setBlock; `place` (main's blackHoleWorld.place) records its lazy flag.
 */
function fakeWorld(cells = new Map(), loaded = () => true) {
  const holes = new BlackHoles();
  /** @type {{ q: number, y: number, r: number, id: number, lazy: boolean }[]} */
  const places = [];
  const world = {
    cells,
    places,
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
    place(q, y, r, id, lazy) {
      places.push({ q, y, r, id, lazy });
      return world.setBlock(q, y, r, id);
    },
    isLoaded: loaded,
  };
  return { holes, world };
}

/** A hole that is a full VORTEX at once, as loaded from a save: the cell holds BLACK_HOLE and the tracker knows it. */
function vortexAt(world, holes, q, y, r) {
  world.cells.set(holeKey(q, y, r), B.BLACK_HOLE);
  holes.add(q, y, r);
}

/** Every eat record without the centre (the v0.5 shape), for compact expectations. */
const cellsOf = (eaten) => eaten.map(({ q, y, r, id }) => ({ q, y, r, id }));

/** Fill every cell within the eat radius of (0, 10, 0) with `id`. */
function packBall(cells, id) {
  for (const [dq, dy, dr] of EAT_OFFSETS) cells.set(holeKey(dq, 10 + dy, dr), id);
}

describe('black_hole block', () => {
  it('is breakable and targetable but not solid, so the player can fall in; not placeable (DESIGN-circuits §1.1)', () => {
    const d = BLOCKS[B.BLACK_HOLE];
    expect(d.name).toBe('black_hole');
    expect(d.displayName).toBe('Black Hole');
    expect(isSolid(B.BLACK_HOLE)).toBe(false);
    expect(isOpaque(B.BLACK_HOLE)).toBe(false);
    expect(isPlaceable(B.BLACK_HOLE)).toBe(false); // the picker gives the dormant Collapsar Charge instead
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
    expect(h.inert).toBe(5);
    expect(h.add(0, 10, 0)).toBe(false);
  });
  it('holes past the cap are inert (no pull, no swallowing) and wake, oldest first, when tracked holes go', () => {
    const M = BLACK_HOLE_MAX_TRACKED;
    const h = new BlackHoles();
    for (let i = 0; i < M + 3; i++) h.onBlockChange(i * 30, 10, 0, B.AIR, B.BLACK_HOLE);
    expect(h.size).toBe(M);
    expect(h.inert).toBe(3);
    const [x, z] = hexToWorld(M * 30, 0); // the oldest inert hole
    expect(h.swallowing(createPlayer(x, 10, z))).toBeNull();
    expect(h.pullAt(x + 2, 10.5, z)).toEqual([0, 0, 0]);
    // Breaking an inert hole just forgets it: it never wakes.
    h.onBlockChange((M + 2) * 30, 10, 0, B.BLACK_HOLE, B.AIR);
    expect(h.inert).toBe(2);
    // Breaking (or replacing) a tracked hole wakes the oldest inert one.
    h.onBlockChange(0, 10, 0, B.BLACK_HOLE, B.STONE);
    expect([h.size, h.inert]).toEqual([M, 1]);
    expect(h.swallowing(createPlayer(x, 10, z))?.key).toBe(holeKey(M * 30, 10, 0));
    h.onBlockChange(30, 10, 0, B.BLACK_HOLE, B.AIR);
    expect([h.size, h.inert]).toEqual([M, 0]);
    expect(h.holes.has(holeKey((M + 1) * 30, 10, 0))).toBe(true);
    expect(h.holes.has(holeKey((M + 2) * 30, 10, 0))).toBe(false);
    h.onBlockChange(60, 10, 0, B.BLACK_HOLE, B.AIR);
    expect([h.size, h.inert]).toEqual([M - 1, 0]);
    h.add(1, 1, 1);
    h.add(2, 2, 2);
    expect(h.inert).toBe(1);
    h.clear();
    expect([h.size, h.inert]).toEqual([0, 0]);
  });
  it('a real World filled past the cap: breaking tracked holes wakes the rest at once, matching a reload', () => {
    const w = new World({ worldGen: flatWorldGen(10), renderDistance: 1 });
    w.update(0, 0, 1e9);
    const h = new BlackHoles();
    w.onBlockChange = (q, y, r, prev, next) => h.onBlockChange(q, y, r, prev, next);
    const cells = [];
    for (let q = 0; q < 20; q++) {
      for (let r = 0; r < 15; r++) {
        expect(w.setBlock(q, 40, r, B.BLACK_HOLE)).toBe(true);
        cells.push([q, 40, r]);
      }
    }
    expect([h.size, h.inert]).toEqual([BLACK_HOLE_MAX_TRACKED, 300 - BLACK_HOLE_MAX_TRACKED]);
    const last = holeKey(...cells[cells.length - 1]);
    expect(h.holes.has(last)).toBe(false);
    for (const c of cells.filter((c) => h.holes.has(holeKey(...c))).slice(0, 60)) w.setBlock(c[0], c[1], c[2], B.AIR);
    expect([h.size, h.inert]).toEqual([240, 0]);
    expect(h.holes.has(last)).toBe(true);
    const reloaded = new BlackHoles();
    reloaded.loadFromEdits(w.edits);
    expect([...reloaded.holes.keys()].sort()).toEqual([...h.holes.keys()].sort());
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
  it('pulls toward the centre with STRENGTH·(1 − d/R)² (radial part unchanged by the swirl), nothing at or beyond R', () => {
    const h = new BlackHoles();
    h.add(0, 10, 0); // centre (0, 10.5, 0)
    const [ax, ay, az] = h.pullAt(3, 10.5, 0);
    expect(ax).toBeCloseTo(-BLACK_HOLE_PULL_STRENGTH * (1 - 3 / BLACK_HOLE_PULL_RADIUS) ** 2, 9);
    expect(ay).toBeCloseTo(0, 12);
    expect(Math.abs(az)).toBeGreaterThan(1); // the swirl (see the spiral tests below)
    expect(h.pullAt(0, 10.5 + BLACK_HOLE_PULL_RADIUS, 0)).toEqual([0, 0, 0]);
    expect(h.pullAt(0, 10.5, 0)).toEqual([0, 0, 0]); // exactly at the centre: no direction, no NaN
    const up = h.pullAt(0, 6.5, 0);
    expect(up[1]).toBeGreaterThan(0);
  });
  it('sums several holes (two opposite holes cancel, swirl included)', () => {
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
    vortexAt(world, holes, 0, 10, 0);
    packBall(cells, B.STONE);
    expect(holes.update(BLACK_HOLE_EAT_INTERVAL_S * 0.5, world)).toEqual([]);
    const eaten = holes.update(BLACK_HOLE_EAT_INTERVAL_S * 0.5, world);
    expect(eaten).toHaveLength(1);
    const [dq, dy, dr] = EAT_OFFSETS[0];
    const [cx, cz] = hexToWorld(0, 0);
    expect(eaten[0]).toEqual({ q: dq, y: 10 + dy, r: dr, id: B.STONE, cx, cy: 10.5, cz }); // with the eating hole's centre
    expect(world.getBlock(dq, 10 + dy, dr)).toBe(B.AIR);
    // The next interval eats the next-nearest cell.
    const [q2, y2, r2] = EAT_OFFSETS[1];
    expect(holes.update(BLACK_HOLE_EAT_INTERVAL_S, world)).toMatchObject([{ q: q2, y: 10 + y2, r: r2, id: B.STONE }]);
  });
  it('empties its whole ball, then goes idle; never touches protected cells', () => {
    const cells = new Map();
    const { holes, world } = fakeWorld(cells);
    vortexAt(world, holes, 0, 10, 0);
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
    expect(cellsOf(holes.update(BLACK_HOLE_EAT_INTERVAL_S, world))).toEqual([{ q: 0, y: 11, r: 0, id: B.SAND }]);
  });
  it('shares at most BLACK_HOLE_MAX_EATS_PER_FRAME eats per frame across holes', () => {
    const cells = new Map();
    const { holes, world } = fakeWorld(cells);
    // MAX + 6 holes deep inside one chunk (so the chunk limit never applies), each over its own stone.
    const count = BLACK_HOLE_MAX_EATS_PER_FRAME + 6;
    let placed = 0;
    for (let q = 2; q <= 13 && placed < count; q++) {
      for (let r = 2; r <= 13 && placed < count; r++, placed++) {
        vortexAt(world, holes, q, 10, r);
        world.setBlock(q, 9, r, B.STONE);
      }
    }
    expect(placed).toBe(count);
    expect(holes.update(BLACK_HOLE_EAT_INTERVAL_S, world)).toHaveLength(BLACK_HOLE_MAX_EATS_PER_FRAME);
    // The holes that waited are still due and eat next frame, even with a tiny dt; then the round is over.
    expect(holes.update(1e-6, world)).toHaveLength(6);
    expect(holes.update(1e-6, world)).toHaveLength(0);
    expect([...cells.values()].filter((id) => id === B.STONE)).toHaveLength(0);
  });
  it('one frame dirties at most BLACK_HOLE_MAX_EAT_CHUNKS_PER_FRAME chunks: crowds in different chunks take turns', () => {
    expect(BLACK_HOLE_MAX_EAT_CHUNKS_PER_FRAME).toBe(1);
    const cells = new Map();
    const { holes, world } = fakeWorld(cells);
    const chunkOf = (q, r) => `${Math.floor(q / CHUNK_SIZE)},${Math.floor(r / CHUNK_SIZE)}`;
    // Three holes deep inside each of chunks (0,0), (2,0) and (0,2), each over its own stone.
    for (const [cq, cr] of [[0, 0], [2, 0], [0, 2]]) {
      for (let i = 0; i < 3; i++) {
        const q = cq * CHUNK_SIZE + 4 + 3 * i;
        const r = cr * CHUNK_SIZE + 6;
        vortexAt(world, holes, q, 10, r);
        world.setBlock(q, 9, r, B.STONE);
      }
    }
    const frames = [];
    for (let f = 0; f < 4; f++) frames.push(holes.update(f === 0 ? BLACK_HOLE_EAT_INTERVAL_S : 1e-6, world));
    // Each frame eats one chunk's whole crowd (a single re-mesh), and every chunk gets its turn within the round.
    expect(frames.map((e) => e.length)).toEqual([3, 3, 3, 0]);
    for (const e of frames.slice(0, 3)) expect(new Set(e.map((c) => chunkOf(c.q, c.r))).size).toBe(1);
    expect(new Set(frames.flat().map((c) => chunkOf(c.q, c.r)))).toEqual(new Set(['0,0', '2,0', '0,2']));
  });
  it("a frame's first eat always goes, even across a chunk border, and later eats may use every chunk it dirtied", () => {
    const cells = new Map();
    const { holes, world } = fakeWorld(cells);
    // The oldest hole goes first: its stone is on the q = 15 | 16 border, so eating it dirties chunks (0,0) and (1,0).
    for (const q of [15, 5, 20, 40]) {
      vortexAt(world, holes, q, 10, 6);
      world.setBlock(q, 9, 6, B.STONE);
    }
    expect(holes.update(BLACK_HOLE_EAT_INTERVAL_S, world).map((e) => e.q)).toEqual([15, 5, 20]);
    expect(holes.update(1e-6, world).map((e) => e.q)).toEqual([40]); // chunk (2,0) waited one frame
  });
  it('holes eat in step on one shared clock, however far apart in time they were placed', () => {
    const cells = new Map();
    const { holes, world } = fakeWorld(cells);
    const dt = 1 / 60;
    // Two holes in the same chunk whose balls (and their neighbours) stay inside it, packed with stone.
    vortexAt(world, holes, 5, 10, 5);
    for (let i = 0; i < 5; i++) holes.update(dt, world);
    vortexAt(world, holes, 5, 20, 5);
    for (const y0 of [10, 20]) for (const [dq, dy, dr] of EAT_OFFSETS) cells.set(holeKey(5 + dq, y0 + dy, 5 + dr), B.STONE);
    let framesWithEats = 0;
    for (let i = 0; i < 121; i++) {
      const n = holes.update(dt, world).length;
      expect([0, 2]).toContain(n); // both eat in the same frame: the chunk is re-meshed once a round, not twice
      if (n > 0) framesWithEats++;
    }
    expect(framesWithEats).toBeGreaterThanOrEqual(9); // ~2 s of rounds every BLACK_HOLE_EAT_INTERVAL_S
    expect(framesWithEats).toBeLessThanOrEqual(11);
  });
  it('is frozen while its own chunk or the target chunk is unloaded', () => {
    const cells = new Map();
    let loaded = true;
    const { holes, world } = fakeWorld(cells, (q) => loaded || q <= 0);
    vortexAt(world, holes, 0, 10, 0);
    const [dq, dy, dr] = EAT_OFFSETS.find(([q]) => q > 0);
    cells.set(holeKey(dq, 10 + dy, dr), B.STONE);
    loaded = false;
    for (let i = 0; i < 20; i++) expect(holes.update(BLACK_HOLE_EAT_INTERVAL_S, world)).toEqual([]);
    expect(world.getBlock(dq, 10 + dy, dr)).toBe(B.STONE);
    loaded = true;
    expect(cellsOf(holes.update(BLACK_HOLE_EAT_INTERVAL_S, world))).toEqual([{ q: dq, y: 10 + dy, r: dr, id: B.STONE }]);
  });
  it('breaking the hole stops it', () => {
    const cells = new Map();
    const { holes, world } = fakeWorld(cells);
    vortexAt(world, holes, 0, 10, 0);
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

describe('BlackHoles.respawnPoint', () => {
  const IDLE = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };
  /** A real World on a flat dry floor (top cell y = 70), loaded around the origin, with the holes wired in like main. */
  function flatWorld() {
    const w = new World({ worldGen: flatWorldGen(70), renderDistance: 3 });
    for (let i = 0; i < 40; i++) w.update(0, 0, 1e9);
    const holes = new BlackHoles();
    w.onBlockChange = (q, y, r, prev, next) => holes.onBlockChange(q, y, r, prev, next);
    const view = {
      getBlock: w.getBlock,
      setBlock: (q, y, r, id) => w.setBlock(q, y, r, id),
      isLoaded: (q, r) => w.hasChunkAtCell(q, r),
      surfaceHeight: (q, r) => w.getSurfaceHeight(q, r),
      hasEdits: (q, r) => columnHasEdits(w.edits, q, r),
    };
    return { w, holes, view, spawn: w.findSpawn() };
  }
  /** Feet position → distance from the body middle to the nearest hole. */
  const clearance = (holes, [x, y, z]) => holes.nearestDistance(x, y + PLAYER_HEIGHT / 2, z);

  it('is World.findSpawn() itself while no hole can reach it', () => {
    const { holes, view, spawn } = flatWorld();
    expect(spawn).toEqual([0, 71, 0]);
    expect(holes.respawnPoint(spawn, view)).toEqual(spawn);
    holes.add(30, 71, 0);
    expect(holes.respawnPoint(spawn, view)).toEqual(spawn);
  });
  it('a hole in the spawn cell: the nearest place to stand out of every pull, where a player standing still is safe', () => {
    const { w, holes, view, spawn } = flatWorld();
    w.setBlock(0, 71, 0, B.BLACK_HOLE); // `setblock ~ ~ ~ black_hole` at spawn
    w.setBlock(0, 70, 2, B.BLACK_HOLE); // and one in the ground next to it
    const at = holes.respawnPoint(spawn, view);
    expect(clearance(holes, at)).toBeGreaterThanOrEqual(BLACK_HOLE_PULL_RADIUS);
    expect(at[1]).toBe(71);
    expect(Math.hypot(at[0], at[2])).toBeLessThan(BLACK_HOLE_PULL_RADIUS + 3); // nearest ring out of reach, not far away
    expect(holes.pullAt(at[0], at[1] + PLAYER_HEIGHT / 2, at[2])).toEqual([0, 0, 0]);
    // 20 s standing there while both holes eat their neighbourhoods: never swallowed, never moved.
    const p = createPlayer(...at);
    const pull = [0, 0, 0];
    for (let i = 0; i < 20 * 60; i++) {
      holes.pullAt(p.x, p.y + PLAYER_HEIGHT / 2, p.z, pull);
      stepPlayer(p, { ...IDLE, pullX: pull[0], pullY: pull[1], pullZ: pull[2] }, w.getBlock, 1 / 60);
      if (holes.swallowing(p)) break;
      holes.update(1 / 60, view);
    }
    expect(holes.swallowing(p)).toBeNull();
    expect(Math.hypot(p.x - at[0], p.y - at[1], p.z - at[2])).toBeLessThan(1e-3);
  });
  it('respects edits: blocks stacked on the ground lift you onto them, and water or an eaten crater is never stood in', () => {
    const { w, holes, view, spawn } = flatWorld();
    for (let y = 71; y <= 75; y++) w.setBlock(0, y, 0, B.STONE);
    expect(holes.respawnPoint(spawn, view)).toEqual([0, 76, 0]);
    w.setBlock(0, 76, 0, B.WATER);
    const wet = holes.respawnPoint(spawn, view);
    expect(hexDistance(0, 0, ...worldToHex(wet[0], wet[2]))).toBe(1);
    expect(wet[1]).toBe(71);
    // A hole that ate a deep crater under spawn: the crater floor is out, and so is everything the hole can reach.
    for (let y = 60; y <= 76; y++) w.setBlock(0, y, 0, B.AIR);
    w.setBlock(0, 58, 0, B.BLACK_HOLE);
    const dry = holes.respawnPoint(spawn, view);
    expect(clearance(holes, dry)).toBeGreaterThanOrEqual(BLACK_HOLE_PULL_RADIUS);
    expect(dry[1]).toBe(71);
  });
  it('searches upward from the natural ground: a house over spawn keeps you inside it; a roof, sky platform or canopy never lifts you', () => {
    // Regression: the respawn went to the TOPMOST solid block of the column, even for a hole far away.
    const build = (w, cells) => { for (const [q, y, r, id] of cells) w.setBlock(q, y, r, id); };
    const disc = (q0, y, r0, R, id) => {
      const out = [];
      for (let dq = -R; dq <= R; dq++) for (let dr = -R; dr <= R; dr++) if (hexDistance(0, 0, dq, dr) <= R) out.push([q0 + dq, y, r0 + dr, id]);
      return out;
    };
    const scenes = {
      // `hexfill 0 90 0 3 1 glass`: a glass platform high over spawn
      platform: disc(0, 90, 0, 3, B.GLASS),
      // a stone house: walls ring 3, floor at ground level, roof at 76, hollow inside
      house: [
        ...disc(0, 76, 0, 3, B.STONE),
        ...[71, 72, 73, 74, 75].flatMap((y) => disc(0, y, 0, 3, B.STONE).filter(([q, , r]) => hexDistance(0, 0, q, r) === 3)),
      ],
      // a leaf canopy two cells above the ground
      canopy: [...disc(0, 73, 0, 2, B.OAK_LEAVES), ...disc(0, 74, 0, 2, B.OAK_LEAVES)],
    };
    for (const [name, cells] of Object.entries(scenes)) {
      const { w, holes, view, spawn } = flatWorld();
      build(w, cells);
      w.setBlock(-40, 71, 0, B.BLACK_HOLE); // a hole far from spawn: it cannot reach spawn at all
      expect(holes.respawnPoint(spawn, view), name).toEqual(spawn);
      // A hole at spawn: the nearest place out of reach is still at ground level, never up on the build.
      w.setBlock(0, 71, 0, B.BLACK_HOLE);
      const at = holes.respawnPoint(spawn, view);
      expect(at[1], name).toBe(71);
      expect(clearance(holes, at)).toBeGreaterThanOrEqual(BLACK_HOLE_PULL_RADIUS);
    }
  });
  it('climbs one-cell gaps but never over a taken or dug-out ground spot to a floor high above it', () => {
    const { w, holes, view, spawn } = flatWorld();
    w.setBlock(0, 72, 0, B.STONE); // a one-cell overhang just above the ground: no room under it, so on top
    expect(holes.respawnPoint(spawn, view)).toEqual([0, 73, 0]);
    w.setBlock(0, 72, 0, B.AIR);
    w.setBlock(0, 80, 0, B.OAK_PLANKS); // a plank floor high over spawn
    for (let y = 60; y <= 70; y++) w.setBlock(0, y, 0, B.AIR); // and the ground under spawn dug away
    const dug = holes.respawnPoint(spawn, view);
    expect(hexDistance(0, 0, ...worldToHex(dug[0], dug[2]))).toBe(1);
    expect(dug[1]).toBe(71);
  });
  it('a hole floating high above spawn does not hide the ground under it', () => {
    const { w, holes, view, spawn } = flatWorld();
    w.setBlock(0, 100, 0, B.BLACK_HOLE); // 29 cells up: out of reach of anyone on the ground
    expect(holes.respawnPoint(spawn, view)).toEqual(spawn);
    w.setBlock(0, 71, 0, B.CAMPFIRE); // but a campfire (or a hole, or water) in the body's cells rules the column out
    const at = holes.respawnPoint(spawn, view);
    expect(hexDistance(0, 0, ...worldToHex(at[0], at[2]))).toBe(1);
  });
  it('unloaded columns are judged from worldgen (dry land only) and skipped when they have recorded edits', () => {
    const holes = new BlackHoles();
    holes.add(0, 71, 0);
    const view = {
      getBlock: () => B.AIR,
      isLoaded: () => false,
      surfaceHeight: (q) => (q > 0 ? SEA_LEVEL - 5 : 70), // the east half is sea
      hasEdits: (q, r) => r > -20, // only the far north-west is unedited
    };
    const at = holes.respawnPoint([0, 71, 0], view);
    const [q, r] = worldToHex(at[0], at[2]);
    expect(q).toBeLessThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(-20);
    expect(at[1]).toBe(71);
    expect(clearance(holes, at)).toBeGreaterThanOrEqual(BLACK_HOLE_PULL_RADIUS);
  });
  it('nothing out of reach → the place farthest from every hole; no place to stand at all → the spawn unchanged', () => {
    const holes = new BlackHoles();
    holes.add(0, 71, 0);
    // Only the columns within 3 rings of spawn can be stood on, all inside the pull.
    const view = {
      getBlock: (q, y, r) => (hexDistance(0, 0, q, r) <= 3 && y <= 70 ? B.STONE : B.AIR),
      isLoaded: () => true,
      surfaceHeight: () => 70,
      hasEdits: () => false,
    };
    const at = holes.respawnPoint([0, 71, 0], view);
    expect(hexDistance(0, 0, ...worldToHex(at[0], at[2]))).toBe(3);
    expect(holes.respawnPoint([0, 71, 0], { ...view, getBlock: () => B.AIR })).toEqual([0, 71, 0]);
  });
  it('columnHasEdits looks only at the recorded cells of that one column', () => {
    const w = new World({ worldGen: flatWorldGen(10), renderDistance: 1 });
    w.update(0, 0, 1e9);
    expect(columnHasEdits(w.edits, 3, 4)).toBe(false);
    w.setBlock(3, 50, 4, B.STONE);
    expect(columnHasEdits(w.edits, 3, 4)).toBe(true);
    expect(columnHasEdits(w.edits, 4, 4)).toBe(false);
    expect(columnHasEdits(w.edits, 3 - CHUNK_SIZE, 4)).toBe(false);
  });
});

describe('escaping a black hole (pull drift is pull / GROUND_ACCEL in every mode, §12; the swirl, DESIGN-circuits §2.5)', () => {
  /**
   * A hole sitting on a one-cell-thick stone floor (y = 9, void below) that it eats; the player starts `d` units east
   * and moves in `mode` for 6 s at frame time `dt`, in main's order (pull, physics, swallow check, eat). With `aim` it
   * steers straight away from the hole every frame (yaw = atan2(−(x − cx), −(z − cz))); without it it keeps heading east.
   * @returns {boolean} true when swallowed
   */
  function swallowed(mode, d, dt, aim) {
    const eaten = new Set();
    const getBlock = (q, y, r) => (y === 9 && !eaten.has(holeKey(q, y, r)) ? B.STONE : B.AIR);
    const holes = new BlackHoles();
    holes.add(0, 10, 0);
    const world = { getBlock, setBlock: (q, y, r) => (eaten.add(holeKey(q, y, r)), true), isLoaded: () => true };
    const [cx, cz] = hexToWorld(0, 0);
    const p = createPlayer(cx + d, 10, cz);
    p.flying = mode === 'fly';
    const input = { forward: mode === 'still' ? 0 : 1, strafe: 0, jump: mode === 'hop', sneak: false, sprint: mode === 'sprint', yaw: -Math.PI / 2 };
    const pull = [0, 0, 0];
    for (let i = 0; i < Math.round(6 / dt); i++) {
      if (aim) input.yaw = Math.atan2(-(p.x - cx), -(p.z - cz));
      holes.pullAt(p.x, p.y + PLAYER_HEIGHT / 2, p.z, pull);
      stepPlayer(p, { ...input, pullX: pull[0], pullY: pull[1], pullZ: pull[2] }, getBlock, dt);
      if (holes.swallowing(p)) return true;
      holes.update(dt, world);
    }
    return false;
  }
  for (const hz of [30, 60, 144]) {
    it(`at ${hz} Hz: steering straight away escapes from 1.5 units in every mode; standing still does not`, () => {
      for (const mode of ['walk', 'hop', 'sprint', 'fly']) expect(swallowed(mode, 1.5, 1 / hz, true), mode).toBe(false);
      expect(swallowed('still', 6, 1 / hz, false)).toBe(true);
    });
    it(`at ${hz} Hz: on a fixed heading the swirl carries you back in from 1.5 units; every mode escapes from 3`, () => {
      expect(swallowed('walk', 1.5, 1 / hz, false)).toBe(true);
      expect(swallowed('walk', 2.5, 1 / hz, false)).toBe(true); // walking is caught from up to 2.5 units
      for (const mode of ['walk', 'hop', 'sprint', 'fly']) expect(swallowed(mode, 3, 1 / hz, false), mode).toBe(false);
    });
  }
});

describe('pullAt: the spiral (DESIGN-circuits §2.5)', () => {
  const R = BLACK_HOLE_PULL_RADIUS;
  /** Radial (toward the centre) and tangential (+θ) parts of the pull at a point, about hole (0, 10, 0). */
  function parts(h, x, y, z) {
    const [cx, cz] = hexToWorld(0, 0);
    const [ax, ay, az] = h.pullAt(x, y, z);
    const vx = x - cx;
    const vy = y - 10.5;
    const vz = z - cz;
    const d = Math.hypot(vx, vy, vz);
    const rho = Math.hypot(vx, vz);
    const radial = -(ax * vx + ay * vy + az * vz) / d;
    // The pull minus its radial part, projected on +θ = (−vz, 0, vx)/ρ.
    const tx = ax + (radial * vx) / d;
    const ty = ay + (radial * vy) / d;
    const tz = az + (radial * vz) / d;
    const tangent = rho > 1e-9 ? (tx * -vz + tz * vx) / rho : 0;
    const off = Math.hypot(tx, ty, tz) - Math.abs(tangent); // anything neither radial nor along +θ
    return { radial, tangent, off, d, rho };
  }
  it('the radial part is unchanged; the swirl is SWIRL·g·min(1, ρ/1.5), perpendicular, in the +θ sense', () => {
    const h = new BlackHoles();
    h.add(0, 10, 0);
    for (const [x, y, z] of [[3, 10.5, 0], [0, 10.5, -2.2], [-0.8, 11.3, 0.6], [5, 8, 4], [0.2, 10.5, 0.1], [1, 13, -1]]) {
      const { radial, tangent, off, d, rho } = parts(h, x, y, z);
      const g = BLACK_HOLE_PULL_STRENGTH * (1 - d / R) ** 2;
      expect(radial).toBeCloseTo(g, 9);
      expect(tangent).toBeCloseTo(BLACK_HOLE_SWIRL * g * Math.min(1, rho / BLACK_HOLE_SWIRL_CORE), 9);
      expect(tangent).toBeGreaterThan(0); // +θ: counter-clockwise from +X toward +Z, like the disk and the particles
      expect(Math.abs(off)).toBeLessThan(1e-9);
    }
    // Straight above the centre there is no swirl (no direction), and nothing is NaN.
    const above = h.pullAt(0, 13, 0);
    expect(above[0]).toBe(0);
    expect(above[2]).toBe(0);
    expect(above[1]).toBeLessThan(0);
  });
  it('the swirl fades inside BLACK_HOLE_SWIRL_CORE, so the last plunge is straight', () => {
    const h = new BlackHoles();
    h.add(0, 10, 0);
    const far = parts(h, 2, 10.5, 0);
    const near = parts(h, 0.5, 10.5, 0);
    expect(far.tangent / far.radial).toBeCloseTo(BLACK_HOLE_SWIRL, 9);
    expect(near.tangent / near.radial).toBeCloseTo(BLACK_HOLE_SWIRL * (0.5 / BLACK_HOLE_SWIRL_CORE), 9);
  });
  it('strength by phase: 0 for an arming charge and in FLASH, s² in IMPLODE, 1 in VORTEX; 0 when switched off', () => {
    const { holes, world } = fakeWorld();
    world.cells.set(holeKey(0, 10, 0), B.COLLAPSAR_CHARGE);
    const g = BLACK_HOLE_PULL_STRENGTH * (1 - 3 / R) ** 2;
    const radial = () => -holes.pullAt(3, 10.5, 0)[0];
    expect(holes.activate(0, 10, 0, world).ok).toBe(true);
    expect(radial()).toBeCloseTo(0, 12); // ARM: still a charge
    holes.update(BLACK_HOLE_ARM_S, world);
    expect(holes.holes.get('0,10,0').phase).toBe(PHASE.FLASH);
    expect(radial()).toBeCloseTo(0, 12);
    holes.update(BLACK_HOLE_FLASH_S, world);
    expect(holes.holes.get('0,10,0').phase).toBe(PHASE.IMPLODE);
    for (const s of [0.25, 0.5, 0.75]) {
      holes.update(0.25 * BLACK_HOLE_IMPLODE_S, world);
      expect(holes.holes.get('0,10,0').s).toBeCloseTo(s, 9);
      expect(radial()).toBeCloseTo(g * s * s, 9);
    }
    holes.update(0.25 * BLACK_HOLE_IMPLODE_S, world);
    expect(holes.holes.get('0,10,0').phase).toBe(PHASE.VORTEX);
    expect(radial()).toBeCloseTo(g, 9);
    holes.setEnabled(false);
    expect(holes.pullAt(3, 10.5, 0)).toEqual([0, 0, 0]);
  });
  it('a body standing still spirals in on the real stepPlayer: its angle only grows, ≥ 2.4 rad from ρ 8 to 1.5, then it is swallowed', () => {
    const groundY = 10;
    const getBlock = (_q, y) => (y < groundY ? B.STONE : B.AIR);
    for (const hz of [30, 60, 144]) {
      const h = new BlackHoles();
      h.add(0, groundY, 0);
      const [cx, cz] = hexToWorld(0, 0);
      const p = createPlayer(cx + 8, groundY, cz);
      const input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };
      const pull = [0, 0, 0];
      let theta = 0; // unwrapped angle about the hole
      let last = Math.atan2(p.z - cz, p.x - cx);
      let at15 = null;
      let swallowedAt = -1;
      for (let i = 0; i < 20 * hz; i++) {
        h.pullAt(p.x, p.y + PLAYER_HEIGHT / 2, p.z, pull);
        stepPlayer(p, { ...input, pullX: pull[0], pullY: pull[1], pullZ: pull[2] }, getBlock, 1 / hz);
        const a = Math.atan2(p.z - cz, p.x - cx);
        let da = a - last;
        if (da > Math.PI) da -= 2 * Math.PI;
        if (da < -Math.PI) da += 2 * Math.PI;
        last = a;
        if (h.swallowing(p)) {
          swallowedAt = i / hz;
          break;
        }
        expect(da, `${hz} Hz, frame ${i}`).toBeGreaterThanOrEqual(-1e-9); // monotonic: always the +θ way
        theta += da;
        if (at15 === null && Math.hypot(p.x - cx, p.z - cz) <= 1.5) at15 = theta;
      }
      expect(swallowedAt, `${hz} Hz`).toBeGreaterThan(0);
      expect(at15, `${hz} Hz`).toBeGreaterThanOrEqual(2.4); // more than a third of a turn: a visible spiral
    }
  });
});

describe('phases (DESIGN-circuits §2.3)', () => {
  it('phaseAt: ARM 0–0.4, FLASH –0.7, IMPLODE –1.9, then VORTEX with its 0.25 s forming flare; Infinity is a settled vortex', () => {
    expect(PHASE).toEqual({ ARM: 0, FLASH: 1, IMPLODE: 2, VORTEX: 3 });
    expect(Object.isFrozen(PHASE)).toBe(true);
    const at = (age) => phaseAt(age, [0, 0]);
    expect(at(0)).toEqual([PHASE.ARM, 0]);
    expect(at(0.2)[1]).toBeCloseTo(0.5, 12);
    expect(at(0.1 + 0.1 + 0.1 + 0.1)[0]).toBe(PHASE.FLASH); // summed dt reaches the boundary
    expect(at(BLACK_HOLE_ARM_S + BLACK_HOLE_FLASH_S / 2)[1]).toBeCloseTo(0.5, 12);
    expect(at(BLACK_HOLE_ARM_S + BLACK_HOLE_FLASH_S)[0]).toBe(PHASE.IMPLODE);
    const vortexAge = BLACK_HOLE_ARM_S + BLACK_HOLE_FLASH_S + BLACK_HOLE_IMPLODE_S;
    expect(at(vortexAge - 0.01)[0]).toBe(PHASE.IMPLODE);
    expect(at(vortexAge)).toEqual([PHASE.VORTEX, 0]);
    expect(at(vortexAge + 0.125)[1]).toBeCloseTo(0.5, 9);
    expect(at(vortexAge + 5)).toEqual([PHASE.VORTEX, 1]);
    expect(at(Infinity)).toEqual([PHASE.VORTEX, 1]);
    expect([pullFactor(PHASE.ARM, 0.5), pullFactor(PHASE.FLASH, 0.5), pullFactor(PHASE.IMPLODE, 0.5), pullFactor(PHASE.VORTEX, 0)]).toEqual([0, 0, 0.25, 1]);
  });
  it('add() defaults to VORTEX (no flash, at once: survival’s pig and zombie tests rely on it); loadFromEdits gives VORTEX', () => {
    const h = new BlackHoles();
    expect(h.add(1, 20, 2)).toBe(true);
    expect(h.holes.get('1,20,2')).toMatchObject({ phase: PHASE.VORTEX, age: Infinity, s: 1, fromCharge: false });
    expect(h.drainEvents()).toEqual([]);
    expect(h.busy).toBe(false);
    const edits = new Map([[chunkKey(0, 0), new Map([[localIndex(1, 30, 2), B.BLACK_HOLE]])]]);
    h.loadFromEdits(edits);
    expect(h.holes.get('1,30,2')).toMatchObject({ phase: PHASE.VORTEX, age: Infinity });
    expect(h.drainEvents()).toEqual([]);
  });
  it('onBlockChange adds at FLASH with age ARM_S, and sets fromCharge only when the cell held a charge', () => {
    const h = new BlackHoles();
    h.onBlockChange(0, 10, 0, B.COLLAPSAR_CHARGE, B.BLACK_HOLE);
    h.onBlockChange(5, 10, 0, B.STONE, B.BLACK_HOLE); // `setblock … black_hole`: flashes and implodes too
    h.onBlockChange(9, 10, 0, B.AIR, B.BLACK_HOLE);
    expect(h.holes.get('0,10,0')).toMatchObject({ phase: PHASE.FLASH, age: BLACK_HOLE_ARM_S, s: 0, fromCharge: true });
    expect(h.holes.get('5,10,0')).toMatchObject({ phase: PHASE.FLASH, age: BLACK_HOLE_ARM_S, fromCharge: false });
    expect(h.holes.get('9,10,0').fromCharge).toBe(false);
    expect(h.drainEvents().map((e) => e.type)).toEqual(['flash', 'flash', 'flash']);
    expect(h.busy).toBe(true); // still forming
    expect(h.holes.get('0,10,0').seed).toBe(holeSeed(0, 10, 0));
    expect(h.holes.get('0,10,0').seed).not.toBe(h.holes.get('5,10,0').seed);
  });
  it('ages advance only in update (pausing freezes them); a big frame crosses several phases with every event in order', () => {
    const { holes, world } = fakeWorld();
    world.setBlock(0, 10, 0, B.BLACK_HOLE);
    const before = { ...holes.holes.get('0,10,0') };
    holes.pullAt(1, 10, 1);
    holes.swallowing(createPlayer(0, 10, 0));
    holes.vortexViews(0, 10, 0, 64, 4, 8, []);
    holes.cameraFx(0, 10, 0);
    holes.flash();
    holes.renderItems(() => {});
    holes.status();
    holes.update(0, world);
    expect(holes.holes.get('0,10,0').age).toBe(before.age);
    holes.drainEvents();
    holes.update(BLACK_HOLE_FLASH_S + BLACK_HOLE_IMPLODE_S + 0.1, world);
    expect(holes.drainEvents().map((e) => e.type)).toEqual(['implode', 'formed']);
    expect(holes.holes.get('0,10,0').phase).toBe(PHASE.VORTEX);
  });
  it('eating and swallowing happen only in VORTEX', () => {
    const cells = new Map();
    const { holes, world } = fakeWorld(cells);
    world.setBlock(0, 10, 0, B.BLACK_HOLE); // FLASH
    packBall(cells, B.STONE);
    const [x, z] = hexToWorld(0, 0);
    const inside = createPlayer(x, 9.6, z);
    const formingFor = BLACK_HOLE_FLASH_S + BLACK_HOLE_IMPLODE_S;
    const dt = 1 / 60;
    let t = 0;
    let eatenWhileForming = 0;
    while (t + dt < formingFor - 1e-6) {
      eatenWhileForming += holes.update(dt, world).length;
      expect(holes.swallowing(inside)).toBeNull();
      t += dt;
    }
    expect(eatenWhileForming).toBe(0);
    expect(holes.holes.get('0,10,0').phase).toBe(PHASE.IMPLODE);
    let eaten = 0;
    for (let i = 0; i < 60; i++) eaten += holes.update(dt, world).length;
    expect(holes.holes.get('0,10,0').phase).toBe(PHASE.VORTEX);
    expect(eaten).toBeGreaterThan(0);
    expect(holes.swallowing(inside)?.key).toBe('0,10,0');
  });
});

describe('activate: setting off a Collapsar Charge (DESIGN-circuits §2.2)', () => {
  it('refuses with the documented messages; a second activate is refused quietly', () => {
    let loaded = true;
    const { holes, world } = fakeWorld(new Map(), () => loaded);
    expect(holes.activate(3, 20, -4, world)).toEqual({ ok: false, message: 'there is no collapsar charge at (3, 20, -4)' });
    world.cells.set(holeKey(3, 20, -4), B.COLLAPSAR_CHARGE);
    loaded = false;
    expect(holes.activate(3, 20, -4, world)).toEqual({ ok: false, message: 'cell (3, 20, -4) is not loaded' });
    loaded = true;
    holes.setEnabled(false);
    expect(holes.activate(3, 20, -4, world)).toEqual({ ok: false, message: 'black holes are off — turn them on with `blackholes on`' });
    holes.setEnabled(true);
    expect(holes.activate(3, 20, -4, world)).toEqual({ ok: true, message: 'the collapsar charge at (3, 20, -4) is collapsing' });
    expect(holes.activate(3, 20, -4, world)).toEqual({ ok: false, quiet: true, message: 'the charge at (3, 20, -4) is already collapsing' });
    expect(holes.arming).toBe(1);
    expect(holes.size).toBe(0);
    expect(holes.busy).toBe(true); // main steps black holes while a charge arms, even with no hole yet
    // A hole is not a charge.
    world.cells.set(holeKey(7, 20, 0), B.BLACK_HOLE);
    expect(holes.activate(7, 20, 0, world).message).toBe('there is no collapsar charge at (7, 20, 0)');
  });
  it('arming lasts exactly BLACK_HOLE_ARM_S, then ONE place(…, BLACK_HOLE) turns the cell into a hole at FLASH', () => {
    const { holes, world } = fakeWorld();
    world.cells.set(holeKey(0, 10, 0), B.COLLAPSAR_CHARGE);
    holes.activate(0, 10, 0, world);
    for (let i = 0; i < 3; i++) {
      holes.update(0.1, world);
      expect(world.places).toHaveLength(0);
      expect(world.getBlock(0, 10, 0)).toBe(B.COLLAPSAR_CHARGE);
    }
    holes.update(0.1, world); // 0.4 s
    expect(world.places).toEqual([{ q: 0, y: 10, r: 0, id: B.BLACK_HOLE, lazy: false }]);
    expect(world.getBlock(0, 10, 0)).toBe(B.BLACK_HOLE);
    expect(holes.arming).toBe(0);
    expect(holes.holes.get('0,10,0')).toMatchObject({ phase: PHASE.FLASH, fromCharge: true });
    for (let i = 0; i < 40; i++) holes.update(0.1, world);
    expect(world.places).toHaveLength(1);
  });
  it('three charges ending ARM in one update: the first 2 writes are non-lazy, the third lazy', () => {
    const { holes, world } = fakeWorld();
    for (const q of [0, 10, 20]) {
      world.cells.set(holeKey(q, 10, 0), B.COLLAPSAR_CHARGE);
      holes.activate(q, 10, 0, world);
    }
    holes.update(BLACK_HOLE_ARM_S, world);
    expect(world.places.map((p) => p.lazy)).toEqual([false, false, true]);
    expect(holes.size).toBe(3);
    // The next update's budget starts again.
    world.cells.set(holeKey(30, 10, 0), B.COLLAPSAR_CHARGE);
    holes.activate(30, 10, 0, world);
    holes.update(BLACK_HOLE_ARM_S, world);
    expect(world.places[3].lazy).toBe(false);
  });
  it('breaking the charge while it arms cancels (event `cancelled`): it never becomes a hole', () => {
    const { holes, world } = fakeWorld();
    world.cells.set(holeKey(0, 10, 0), B.COLLAPSAR_CHARGE);
    holes.activate(0, 10, 0, world);
    holes.update(0.2, world);
    world.setBlock(0, 10, 0, B.AIR);
    expect(holes.arming).toBe(0);
    holes.update(1, world);
    expect(world.places).toHaveLength(0);
    expect(holes.size).toBe(0);
    expect(holes.drainEvents().map((e) => e.type)).toEqual(['arm', 'cancelled']);
    expect(holes.busy).toBe(false);
  });
  it('switching black holes off cancels arming charges: they stay dormant charges', () => {
    const { holes, world } = fakeWorld();
    world.cells.set(holeKey(0, 10, 0), B.COLLAPSAR_CHARGE);
    holes.activate(0, 10, 0, world);
    holes.setEnabled(false);
    holes.setEnabled(true);
    holes.update(1, world);
    expect(world.getBlock(0, 10, 0)).toBe(B.COLLAPSAR_CHARGE);
    expect(holes.drainEvents().map((e) => e.type)).toEqual(['arm', 'cancelled']);
  });
  it('an arming charge whose chunk unloads waits at the end of ARM, then forms once it loads', () => {
    let loaded = true;
    const { holes, world } = fakeWorld(new Map(), () => loaded);
    world.cells.set(holeKey(0, 10, 0), B.COLLAPSAR_CHARGE);
    holes.activate(0, 10, 0, world);
    loaded = false;
    holes.update(2, world);
    expect(holes.arming).toBe(1);
    loaded = true;
    holes.update(0.01, world);
    expect(world.getBlock(0, 10, 0)).toBe(B.BLACK_HOLE);
    expect(holes.holes.get('0,10,0').phase).toBe(PHASE.FLASH);
  });
  it('a charge swallowed or replaced while arming is cancelled; `setblock black_hole` on it just forms the hole', () => {
    const { holes, world } = fakeWorld();
    world.cells.set(holeKey(0, 10, 0), B.COLLAPSAR_CHARGE);
    world.cells.set(holeKey(5, 10, 0), B.COLLAPSAR_CHARGE);
    holes.activate(0, 10, 0, world);
    holes.activate(5, 10, 0, world);
    world.setBlock(0, 10, 0, B.STONE);
    world.setBlock(5, 10, 0, B.BLACK_HOLE);
    expect(holes.drainEvents().map((e) => [e.type, e.q])).toEqual([['arm', 0], ['arm', 5], ['cancelled', 0], ['flash', 5]]);
    expect(holes.arming).toBe(0);
    expect(holes.holes.get('5,10,0').fromCharge).toBe(true);
  });
  it('past the 256-hole cap the new hole is inert, as before', () => {
    const { holes, world } = fakeWorld();
    for (let i = 0; i < BLACK_HOLE_MAX_TRACKED; i++) holes.add(i * 20, 50, 0);
    world.cells.set(holeKey(0, 10, 0), B.COLLAPSAR_CHARGE);
    expect(holes.activate(0, 10, 0, world).ok).toBe(true);
    holes.update(BLACK_HOLE_ARM_S, world);
    expect(world.getBlock(0, 10, 0)).toBe(B.BLACK_HOLE);
    expect(holes.inert).toBe(1);
    expect(holes.size).toBe(BLACK_HOLE_MAX_TRACKED);
  });
});

describe('events and effects (DESIGN-circuits §2.3–§2.4)', () => {
  it('a charge goes arm → flash → implode → formed, each event carrying its cell and centre; breaking the vortex: collapsed', () => {
    const { holes, world } = fakeWorld();
    world.cells.set(holeKey(2, 10, -3), B.COLLAPSAR_CHARGE);
    holes.activate(2, 10, -3, world);
    const types = [];
    for (let i = 0; i < 150; i++) {
      holes.update(1 / 60, world);
      for (const e of holes.drainEvents()) types.push(e.type);
    }
    expect(types).toEqual(['arm', 'flash', 'implode', 'formed']);
    expect(holes.busy).toBe(false);
    world.setBlock(2, 10, -3, B.AIR); // a left click on the core
    const [e] = holes.drainEvents();
    const [cx, cz] = hexToWorld(2, -3);
    expect(e).toEqual({ type: 'collapsed', q: 2, y: 10, r: -3, cx, cy: 10.5, cz });
    expect(holes.size).toBe(0);
    // drainEvents appends to `out` and empties the queue.
    const out = ['x'];
    expect(holes.drainEvents(out)).toBe(out);
    expect(out).toEqual(['x']);
  });
  it('breaking an inert hole also reports collapsed; the pending queue is bounded', () => {
    const h = new BlackHoles();
    for (let i = 0; i < BLACK_HOLE_MAX_TRACKED + 1; i++) h.add(i * 20, 50, 0);
    h.onBlockChange(BLACK_HOLE_MAX_TRACKED * 20, 50, 0, B.BLACK_HOLE, B.AIR);
    expect(h.drainEvents().map((e) => [e.type, e.q])).toEqual([['collapsed', BLACK_HOLE_MAX_TRACKED * 20]]);
    for (let i = 0; i < 5000; i++) h.onBlockChange(i, 1, 0, B.AIR, B.BLACK_HOLE) && h.onBlockChange(i, 1, 0, B.BLACK_HOLE, B.AIR);
    expect(h.drainEvents().length).toBeLessThanOrEqual(1024);
  });
  it('flash(): the brightest hole in FLASH, warm white, BLACK_HOLE_FLASH_INTENSITY·(1 − u)² at its centre; 0 otherwise', () => {
    const { holes, world } = fakeWorld();
    const out = holes.flash();
    expect(out).toMatchObject({ intensity: 0, color: BLACK_HOLE_FLASH_COLOR });
    expect(BLACK_HOLE_FLASH_COLOR).toBe(0xfff4e6);
    world.setBlock(4, 12, 1, B.BLACK_HOLE);
    holes.flash(out);
    const [cx, cz] = hexToWorld(4, 1);
    expect(out).toEqual({ x: cx, y: 12.5, z: cz, intensity: BLACK_HOLE_FLASH_INTENSITY, color: BLACK_HOLE_FLASH_COLOR });
    expect(BLACK_HOLE_FLASH_INTENSITY).toBe(220);
    holes.update(BLACK_HOLE_FLASH_S / 2, world);
    expect(holes.flash(out).intensity).toBeCloseTo(BLACK_HOLE_FLASH_INTENSITY * 0.25, 9);
    // A second hole whose flash just began is brighter.
    world.setBlock(-6, 12, 0, B.BLACK_HOLE);
    expect(holes.flash(out)).toMatchObject({ intensity: BLACK_HOLE_FLASH_INTENSITY, x: hexToWorld(-6, 0)[0] });
    holes.update(BLACK_HOLE_FLASH_S, world);
    expect(holes.flash(out).intensity).toBe(0);
  });
  it('cameraFx: the IMPLODE pinch −8°·(1 − d/24)·sin(πs) and its shake, then the stretch inside the pull radius', () => {
    const { holes, world } = fakeWorld();
    world.setBlock(0, 10, 0, B.BLACK_HOLE);
    holes.update(BLACK_HOLE_FLASH_S + BLACK_HOLE_IMPLODE_S / 2, world); // IMPLODE, s = 0.5
    const h = holes.holes.get('0,10,0');
    expect(h.s).toBeCloseTo(0.5, 9);
    const fx = holes.cameraFx(6, 10.5, 0);
    expect(fx.fov).toBeCloseTo(-BLACK_HOLE_PINCH_DEG * (1 - 6 / BLACK_HOLE_PINCH_RANGE), 9);
    expect(Math.hypot(fx.sx, fx.sy, fx.sz)).toBeGreaterThan(0);
    expect(Math.max(Math.abs(fx.sx), Math.abs(fx.sy), Math.abs(fx.sz))).toBeLessThanOrEqual(0.05 * (1 - 6 / 24) + 1e-12);
    expect(holes.cameraFx(BLACK_HOLE_PINCH_RANGE + 1, 10.5, 0)).toEqual({ fov: 0, sx: 0, sy: 0, sz: 0 });
    // The shake oscillates with the hole's age.
    const a = holes.cameraFx(6, 10.5, 0).sx;
    holes.update(1 / 36, world); // a quarter of a 9 Hz period
    expect(holes.cameraFx(6, 10.5, 0).sx).not.toBeCloseTo(a, 3);
    holes.update(BLACK_HOLE_IMPLODE_S, world); // VORTEX
    const st = holes.cameraFx(4, 10.5, 0);
    expect(st.fov).toBeCloseTo(BLACK_HOLE_STRETCH_DEG * (1 - 4 / BLACK_HOLE_PULL_RADIUS) ** 2, 9);
    expect([st.sx, st.sy, st.sz]).toEqual([0, 0, 0]);
    expect(holes.cameraFx(BLACK_HOLE_PULL_RADIUS + 0.5, 10.5, 0).fov).toBe(0);
    holes.setEnabled(false);
    expect(holes.cameraFx(4, 10.5, 0).fov).toBe(0);
  });
  it('vortexViews: nearest first, full for the nearest maxFull, arming charges (ARM) and inert holes (0.2), capped at maxCores', () => {
    const { holes, world } = fakeWorld();
    for (let i = 0; i < BLACK_HOLE_MAX_TRACKED; i++) holes.add(1000 + i * 3, 50, 0); // far away: the cap is full
    holes.onBlockChange(20, 10, 0, B.AIR, B.BLACK_HOLE); // inert, 20 east
    holes.add(1000, 50, 0);
    world.cells.set(holeKey(5, 10, 0), B.COLLAPSAR_CHARGE);
    holes.activate(5, 10, 0, world);
    holes.update(0.1, world);
    const h0 = new BlackHoles();
    expect(h0.vortexViews(0, 0, 0, 64, 4, 8)).toEqual([]);
    // Bring the tracked ones near: a fresh tracker with a mix.
    const t = new BlackHoles();
    const w2 = fakeWorld().world;
    for (const q of [3, -9, 14, 30]) t.add(q, 10, 0);
    w2.cells.set(holeKey(-5, 10, 0), B.COLLAPSAR_CHARGE);
    t.activate(-5, 10, 0, w2);
    t.update(0.2, w2);
    const views = t.vortexViews(0, 10.5, 0, 25, 2, 256, []);
    expect(views.map((v) => Math.round(v.cx))).toEqual([3, -5, -9, 14]); // 30 is out of range
    expect(views.map((v) => v.full)).toEqual([true, true, false, false]);
    expect(views[1]).toMatchObject({ phase: PHASE.ARM, strength: 1, age: 0.2 });
    expect(views[1].s).toBeCloseTo(0.2 / BLACK_HOLE_ARM_S, 9);
    expect(views[0]).toMatchObject({ phase: PHASE.VORTEX, s: 1, strength: 1, age: Infinity, seed: holeSeed(3, 10, 0), cy: 10.5 });
    expect(t.vortexViews(0, 10.5, 0, 25, 2, 3, []).length).toBe(3); // maxCores
    // The inert hole of the first tracker is drawn at 0.2, as a vortex.
    const near = holes.vortexViews(10, 10.5, 0, 30, 16, 256, []);
    expect(near.map((v) => [Math.round(v.cx), v.phase, v.strength])).toEqual([[5, PHASE.ARM, 1], [20, PHASE.VORTEX, 0.2]]);
    // Switched off: tracked holes are drawn at 0.2 too.
    t.setEnabled(false);
    expect(t.vortexViews(0, 10.5, 0, 25, 2, 256, []).map((v) => v.strength)).toEqual([0.2, 0.2, 0.2]); // the charge was cancelled
  });
  it('vortexViews caches the inert scan: it follows inert-set changes and an eye that moved 8 units', () => {
    const h = new BlackHoles();
    for (let i = 0; i < BLACK_HOLE_MAX_TRACKED; i++) h.add(5000 + i * 3, 50, 0);
    h.onBlockChange(10, 10, 0, B.AIR, B.BLACK_HOLE);
    expect(h.vortexViews(0, 10.5, 0, 20, 4, 256, []).length).toBe(1);
    h.onBlockChange(-10, 10, 0, B.AIR, B.BLACK_HOLE); // the inert set changed
    expect(h.vortexViews(0, 10.5, 0, 20, 4, 256, []).length).toBe(2);
    // Walk east in small steps: the hole 26 east comes into the 20-unit range on time.
    h.onBlockChange(36, 10, 0, B.AIR, B.BLACK_HOLE);
    for (let x = 0; x <= 16; x += 1) {
      const views = h.vortexViews(x, 10.5, 0, 20, 4, 256, []);
      expect(views.some((v) => Math.round(v.cx) === 36), `x = ${x}`).toBe(36 - x <= 20);
    }
    h.onBlockChange(36, 10, 0, B.BLACK_HOLE, B.AIR);
    expect(h.vortexViews(16, 10.5, 0, 20, 4, 256, []).some((v) => Math.round(v.cx) === 36)).toBe(false);
  });
  it('the views are pooled objects written into out (no allocation per frame once warm)', () => {
    const h = new BlackHoles();
    h.add(0, 10, 0);
    h.add(4, 10, 0);
    const out = [];
    const a = h.vortexViews(0, 10.5, 0, 64, 4, 8, out);
    const first = a[0];
    const b = h.vortexViews(0, 10.5, 0, 64, 4, 8, out);
    expect(b).toBe(out);
    expect(b[0]).toBe(first);
    h.remove(4, 10, 0);
    expect(h.vortexViews(0, 10.5, 0, 64, 4, 8, out)).toHaveLength(1);
  });
  it('renderItems: the charge copy from FLASH start through IMPLODE for a charge-made hole (swelling, then crumpling)', () => {
    const { holes, world } = fakeWorld();
    world.cells.set(holeKey(0, 10, 0), B.COLLAPSAR_CHARGE);
    world.cells.set(holeKey(8, 10, 0), B.STONE);
    holes.activate(0, 10, 0, world);
    const items = [];
    const push = (id, x, y, z, rx, ry, rz, scale) => items.push({ id, x, y, z, rx, ry, rz, scale });
    holes.renderItems(push);
    expect(items).toEqual([]); // ARM: the charge is still a block
    holes.update(BLACK_HOLE_ARM_S, world);
    world.setBlock(8, 10, 0, B.BLACK_HOLE); // a setblock hole: no copy
    const dt = 1 / 60;
    const frames = [];
    for (let t = 0; t < BLACK_HOLE_FLASH_S + BLACK_HOLE_IMPLODE_S + 0.2; t += dt) {
      items.length = 0;
      holes.renderItems(push);
      const h = holes.holes.get('0,10,0');
      frames.push({ phase: h.phase, s: h.s, items: items.map((i) => ({ ...i })) });
      holes.update(dt, world);
    }
    const [cx, cz] = hexToWorld(0, 0);
    for (const f of frames) {
      for (const it of f.items) {
        expect(it).toMatchObject({ id: B.COLLAPSAR_CHARGE, x: cx, y: 10.5, z: cz });
        expect(it.scale).toBeGreaterThan(0);
      }
      if (f.phase === PHASE.FLASH) {
        expect(f.items).toHaveLength(1);
        expect(f.items[0].scale).toBeCloseTo(1 + 0.1 * Math.sin(Math.PI * f.s), 9);
        expect(f.items[0].scale).toBeGreaterThanOrEqual(1);
      } else if (f.phase === PHASE.IMPLODE) {
        const scale = 1 - f.s / 0.7;
        if (scale > 0.01) {
          expect(f.items).toHaveLength(1);
          expect(f.items[0].scale).toBeCloseTo(scale, 9);
          expect(f.items[0].ry).toBeCloseTo(14 * f.s * f.s, 9);
          expect(f.items[0].rx).toBeCloseTo(0.6 * Math.min(1, f.s / 0.7), 9);
        } else {
          expect(f.items).toHaveLength(0);
        }
      } else {
        expect(f.items).toHaveLength(0);
      }
    }
    expect(frames.filter((f) => f.phase === PHASE.FLASH).length).toBeGreaterThan(10);
    expect(frames.some((f) => f.phase === PHASE.IMPLODE && f.items.length === 0)).toBe(true);
  });
  it('status() and list() strings', () => {
    const { holes, world } = fakeWorld();
    expect(holes.status()).toBe('black holes on · 0 active, 0 inert');
    expect(holes.list(0, 0, 0)).toEqual([]);
    holes.add(3, 20, -4);
    holes.add(30, 20, 0);
    world.cells.set(holeKey(0, 20, 0), B.COLLAPSAR_CHARGE);
    holes.activate(0, 20, 0, world);
    expect(holes.status()).toBe('black holes on · 3 active (1 forming), 0 inert');
    holes.update(BLACK_HOLE_ARM_S, world);
    expect(holes.status()).toBe('black holes on · 3 active (1 forming), 0 inert');
    holes.update(BLACK_HOLE_FLASH_S, world);
    const [x, z] = hexToWorld(0, 0);
    expect(holes.list(x, 20.5, z)).toEqual([
      '(0, 20, 0) · imploding · 0 m',
      `(3, 20, -4) · vortex · ${Math.round(Math.hypot(hexToWorld(3, -4)[0] - x, hexToWorld(3, -4)[1] - z))} m`,
      '(30, 20, 0) · vortex · 30 m',
    ]);
    expect(holes.list(x, 20.5, z, 1)).toHaveLength(1);
    holes.update(BLACK_HOLE_IMPLODE_S, world);
    holes.setEnabled(false);
    expect(holes.status()).toBe('black holes off · 3 active, 0 inert');
    for (let i = 0; i < BLACK_HOLE_MAX_TRACKED; i++) holes.add(1000 + i * 3, 50, 0);
    expect(holes.status()).toBe(`black holes off · ${BLACK_HOLE_MAX_TRACKED} active, 3 inert`);
    expect(holes.list(1000, 50.5, 0, 2)[0]).toBe('(1000, 50, 0) · vortex · 0 m');
    world.cells.set(holeKey(0, 30, 0), B.COLLAPSAR_CHARGE);
    holes.setEnabled(true);
    holes.activate(0, 30, 0, world);
    expect(holes.list(x, 30.5, z, 1)).toEqual(['(0, 30, 0) · arming · 0 m']);
    expect(holes.list(-30, 20.5, 0, 1000).filter((s) => s.includes('inert'))).toHaveLength(3);
  });
});

describe('the per-world switch (DESIGN-circuits §2.8)', () => {
  it('off: no pull, no eating, no swallowing; forming holes jump to VORTEX; on again acts on nothing that happened meanwhile', () => {
    const cells = new Map();
    const { holes, world } = fakeWorld(cells);
    expect(holes.enabled).toBe(true);
    world.setBlock(0, 10, 0, B.BLACK_HOLE); // FLASH
    packBall(cells, B.STONE);
    const v0 = holes.switchVersion;
    holes.setEnabled(false);
    expect(holes.switchVersion).toBe(v0 + 1);
    holes.setEnabled(false);
    expect(holes.switchVersion).toBe(v0 + 1); // no change, no bump
    expect(holes.holes.get('0,10,0')).toMatchObject({ phase: PHASE.VORTEX, s: 1 });
    expect(holes.busy).toBe(true); // the flash event still waits to be drained
    holes.drainEvents();
    expect(holes.busy).toBe(false);
    expect(holes.pullAt(2, 10.5, 0)).toEqual([0, 0, 0]);
    const [x, z] = hexToWorld(0, 0);
    expect(holes.swallowing(createPlayer(x, 9.6, z))).toBeNull();
    for (let i = 0; i < 20; i++) expect(holes.update(BLACK_HOLE_EAT_INTERVAL_S, world)).toEqual([]);
    expect(holes.flash().intensity).toBe(0);
    // A hole made while off is a quiet vortex (no flash).
    world.setBlock(9, 10, 0, B.BLACK_HOLE);
    expect(holes.holes.get('9,10,0')).toMatchObject({ phase: PHASE.VORTEX, fromCharge: false });
    expect(holes.drainEvents()).toEqual([]);
    holes.setEnabled(true);
    expect(holes.swallowing(createPlayer(x, 9.6, z))?.key).toBe('0,10,0');
    let eaten = 0;
    for (let i = 0; i < 5; i++) eaten += holes.update(BLACK_HOLE_EAT_INTERVAL_S, world).length;
    expect(eaten).toBeGreaterThan(0);
    expect(holes.drainEvents()).toEqual([]); // no flash, implode or formed replayed
  });
  it('clear() and loadFromEdits keep the switch; they forget arming charges and events (a reload during ARM leaves a dormant charge)', () => {
    const { holes, world } = fakeWorld();
    world.cells.set(holeKey(0, 10, 0), B.COLLAPSAR_CHARGE);
    holes.activate(0, 10, 0, world);
    holes.loadFromEdits(new Map());
    expect([holes.arming, holes.busy, holes.enabled]).toEqual([0, false, true]);
    holes.setEnabled(false);
    holes.clear();
    expect(holes.enabled).toBe(false);
  });
});
