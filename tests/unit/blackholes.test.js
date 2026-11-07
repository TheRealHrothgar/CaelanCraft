// Unit tests for src/blackholes.js — black hole tracking, pull and swallowing (CONTRACTS §29).
import { describe, it, expect } from 'vitest';
import { BLOCK, BLOCKS, isSolid, isOpaque, isPlaceable, isBreakable, isTargetable } from '../../src/blocks.js';
import {
  BLACK_HOLE_PULL_RADIUS, BLACK_HOLE_PULL_STRENGTH, BLACK_HOLE_EAT_RADIUS, BLACK_HOLE_EAT_INTERVAL_S,
  BLACK_HOLE_MAX_EATS_PER_FRAME, BLACK_HOLE_MAX_EAT_CHUNKS_PER_FRAME, BLACK_HOLE_MAX_TRACKED, CHUNK_SIZE, PLAYER_HEIGHT,
  SEA_LEVEL,
} from '../../src/config.js';
import { BlackHoles, EAT_OFFSETS, canSwallow, columnHasEdits, holeKey } from '../../src/blackholes.js';
import { hexToWorld, hexDistance, worldToHex } from '../../src/hex.js';
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
    // MAX + 6 holes deep inside one chunk (so the chunk limit never applies), each over its own stone.
    const count = BLACK_HOLE_MAX_EATS_PER_FRAME + 6;
    let placed = 0;
    for (let q = 2; q <= 13 && placed < count; q++) {
      for (let r = 2; r <= 13 && placed < count; r++, placed++) {
        world.setBlock(q, 10, r, B.BLACK_HOLE);
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
        world.setBlock(q, 10, r, B.BLACK_HOLE);
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
      world.setBlock(q, 10, 6, B.BLACK_HOLE);
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
    world.setBlock(5, 10, 5, B.BLACK_HOLE);
    for (let i = 0; i < 5; i++) holes.update(dt, world);
    world.setBlock(5, 20, 5, B.BLACK_HOLE);
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
  it('respects edits: a house over spawn puts you on its roof, and water or an eaten crater is never stood in', () => {
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

describe('escaping a black hole (pull drift is pull / GROUND_ACCEL in every mode, §12)', () => {
  /**
   * A hole sitting on a one-cell-thick stone floor (y = 9, void below) that it eats; the player starts `d` units east
   * and moves east in `mode` for 6 s at frame time `dt`, in main's order (pull, physics, swallow check, eat).
   * @returns {boolean} true when swallowed
   */
  function swallowed(mode, d, dt) {
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
      holes.pullAt(p.x, p.y + PLAYER_HEIGHT / 2, p.z, pull);
      stepPlayer(p, { ...input, pullX: pull[0], pullY: pull[1], pullZ: pull[2] }, getBlock, dt);
      if (holes.swallowing(p)) return true;
      holes.update(dt, world);
    }
    return false;
  }
  for (const hz of [30, 60, 144]) {
    it(`at ${hz} Hz: walking, hopping, sprinting or flying away escapes from 1.5 units; standing still does not`, () => {
      for (const mode of ['walk', 'hop', 'sprint', 'fly']) expect(swallowed(mode, 1.5, 1 / hz), mode).toBe(false);
      expect(swallowed('walk', 1.0, 1 / hz)).toBe(true);
      expect(swallowed('still', 6, 1 / hz)).toBe(true);
    });
  }
});
