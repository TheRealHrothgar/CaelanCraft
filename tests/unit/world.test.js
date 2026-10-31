// Unit tests for src/world.js — see src/CONTRACTS.md §9 / §9.1.
// Cells are hexagonal prisms addressed by axial (q, r) + y; chunks are 16×16 in (q, r) and streaming uses
// HEX distance in chunk coordinates. Every World here gets an injected WorldGen from the fixtures and a
// frozen clock (now: () => 0) with an infinite budget unless a test is about the budget itself.
import { describe, it, expect } from 'vitest';
import {
  CHUNK_SIZE, WORLD_HEIGHT, CHUNK_VOLUME, SEA_LEVEL, RENDER_DISTANCE,
  DATA_RADIUS_EXTRA, UNLOAD_RADIUS_EXTRA, MAX_BUILDS_PER_UPDATE,
} from '../../src/config.js';
import { chunkKey, localIndex } from '../../src/coords.js';
import { HEX_DIRS, hexLength, hexNormSq, hexToWorld, worldToHex, hexDiscCount } from '../../src/hex.js';
import { BLOCK, BIOME } from '../../src/blocks.js';
import { normalizeSeed, hashString } from '../../src/noise.js';
import { World } from '../../src/world.js';
import { trivialWorldGen, flatWorldGen, countFaces, makeChunkData } from '../helpers/fixtures.js';

const B = BLOCK;

// ---------------------------------------------------------------------------------------------
// helpers

/** A World with an injected generator, frozen clock and hook recorders. */
function makeWorld(opts = {}) {
  const meshCalls = [];
  const unloadCalls = [];
  const meshes = new Map();
  const world = new World({
    seed: 1,
    renderDistance: 2,
    worldGen: trivialWorldGen(),
    now: () => 0,
    ...opts,
  });
  world.onChunkMesh = (key, cq, cr, m) => {
    meshCalls.push({ key, cq, cr });
    meshes.set(key, m);
  };
  world.onChunkUnload = (key) => unloadCalls.push(key);
  return { world, meshCalls, unloadCalls, meshes };
}

/** Run update() until it reports no pending work; returns the summed counters. Throws if it never converges. */
function converge(world, px = 0, pz = 0, maxCalls = 500) {
  const total = { generated: 0, meshed: 0, unloaded: 0, calls: 0 };
  for (let i = 0; i < maxCalls; i++) {
    const r = world.update(px, pz, Infinity);
    total.generated += r.generated;
    total.meshed += r.meshed;
    total.unloaded += r.unloaded;
    total.calls++;
    if (r.pendingGen === 0 && r.pendingMesh === 0) return total;
  }
  throw new Error(`update() did not converge in ${maxCalls} calls`);
}

/** World position at the centre of chunk (cq, cr) (its local cell (8, 8)). */
function chunkCentre(cq, cr) {
  return hexToWorld(cq * CHUNK_SIZE + 8, cr * CHUNK_SIZE + 8);
}

/** Chunk coordinates of cell (q, r). */
function chunkOf(q, r) {
  return [Math.floor(q / CHUNK_SIZE), Math.floor(r / CHUNK_SIZE)];
}

/** Chunk keys that cell (q, r) and its six HEX_DIRS neighbours fall into (the contract's dirty set). */
function expectedDirty(q, r) {
  const keys = new Set([chunkKey(...chunkOf(q, r))]);
  for (const [dq, dr] of HEX_DIRS) keys.add(chunkKey(...chunkOf(q + dq, r + dr)));
  return [...keys].sort();
}

/** Clear every loaded chunk's dirty flag so a subsequent edit's propagation can be read directly. */
function clearDirty(world) {
  for (const c of world.chunks.values()) c.dirty = false;
}

/** Keys of every loaded chunk that is dirty (after clearDirty: exactly the chunks an edit touched). */
function allDirtyKeys(world) {
  const out = [];
  for (const [key, c] of world.chunks) if (c.dirty) out.push(key);
  return out.sort();
}

/**
 * Keys of meshed chunks that need re-meshing (dirty && meshed). Data-ring chunks outside the render
 * radius are never meshed and therefore stay dirty by design, so they are excluded here.
 */
function dirtyKeys(world) {
  const out = [];
  for (const [key, c] of world.chunks) if (c.dirty && c.meshed) out.push(key);
  return out.sort();
}

/** Wrap a WorldGen so every generateChunk call is recorded. */
function spyGen(gen) {
  const calls = [];
  return {
    gen: {
      seed: gen.seed,
      getColumn: gen.getColumn,
      generateChunk(cq, cr) {
        calls.push([cq, cr]);
        return gen.generateChunk(cq, cr);
      },
    },
    calls,
  };
}

// ---------------------------------------------------------------------------------------------

describe('World constructor', () => {
  it('normalises the seed with normalizeSeed', () => {
    const wg = trivialWorldGen();
    expect(new World({ seed: 42, worldGen: wg, now: () => 0 }).seed).toBe(42);
    expect(new World({ seed: '42', worldGen: wg, now: () => 0 }).seed).toBe(42);
    expect(new World({ seed: '-1', worldGen: wg, now: () => 0 }).seed).toBe(normalizeSeed('-1'));
    expect(new World({ seed: 'hello', worldGen: wg, now: () => 0 }).seed).toBe(hashString('hello'));
    expect(new World({ seed: 1.5, worldGen: wg, now: () => 0 }).seed).toBe(normalizeSeed(1.5));
  });

  it('exposes the contract fields with their initial values', () => {
    const wg = trivialWorldGen();
    const w = new World({ seed: 1, worldGen: wg, now: () => 0 });
    expect(w.renderDistance).toBe(RENDER_DISTANCE);
    expect(w.worldGen).toBe(wg);
    expect(w.chunks).toBeInstanceOf(Map);
    expect(w.chunks.size).toBe(0);
    expect(w.edits).toBeInstanceOf(Map);
    expect(w.edits.size).toBe(0);
    expect(w.editVersion).toBe(0);
    expect(w.chunkCount).toBe(0);
    expect(typeof w.onChunkMesh).toBe('function');
    expect(typeof w.onChunkUnload).toBe('function');
    expect(typeof w.getBlock).toBe('function');
    expect(typeof w.getChunkData).toBe('function');
  });

  it('getBlock / getChunkData are arrow properties (work detached from the instance)', () => {
    const { world } = makeWorld({ worldGen: flatWorldGen(4) });
    converge(world);
    const { getBlock, getChunkData } = world;
    expect(getBlock(3, 4, 3)).toBe(B.STONE);
    expect(getBlock(3, 5, 3)).toBe(B.AIR);
    expect(getChunkData(0, 0)).toBe(world.getChunk(0, 0));
    expect(getChunkData(500, 500)).toBeNull();
  });

  it('clamps renderDistance to 1..16 and accepts a custom one', () => {
    const wg = trivialWorldGen();
    expect(new World({ seed: 1, renderDistance: 3, worldGen: wg, now: () => 0 }).renderDistance).toBe(3);
    expect(new World({ seed: 1, renderDistance: 0, worldGen: wg, now: () => 0 }).renderDistance).toBe(1);
    expect(new World({ seed: 1, renderDistance: 99, worldGen: wg, now: () => 0 }).renderDistance).toBe(16);
    expect(new World({ seed: 1, renderDistance: NaN, worldGen: wg, now: () => 0 }).renderDistance).toBe(RENDER_DISTANCE);
  });

  it('accepts initial edits and applies them when the chunk is generated', () => {
    const li = localIndex(15, 10, 15);
    const { world } = makeWorld({ edits: { '-1,-2': [li, B.STONE] } });
    expect(world.edits.get('-1,-2').get(li)).toBe(B.STONE);
    expect(world.editVersion).toBe(0);
    // Chunk (-1,-2) is at hex distance 3 from (0,0): inside the data ring of renderDistance 2.
    converge(world);
    expect(world.getChunk(-1, -2)).toBeDefined();
    expect(world.getBlock(-1, 10, -17)).toBe(B.STONE);
    expect(world.editVersion).toBe(0);
  });
});

describe('coordinate ownership and getBlock/setBlock', () => {
  it('setBlock(-1,10,-17) lands in chunk (-1,-2) at local (15,10,15)', () => {
    const { world } = makeWorld();
    converge(world);
    expect(world.setBlock(-1, 10, -17, B.STONE)).toBe(true);
    const c = world.getChunk(-1, -2);
    expect(c).toBeDefined();
    expect(c.blocks[localIndex(15, 10, 15)]).toBe(B.STONE);
    expect(c.get(15, 10, 15)).toBe(B.STONE);
    expect(world.getBlock(-1, 10, -17)).toBe(B.STONE);
    expect(world.edits.get('-1,-2').get(localIndex(15, 10, 15))).toBe(B.STONE);
    // Neighbouring cells are untouched.
    expect(world.getBlock(0, 10, -17)).toBe(B.AIR);
    expect(world.getBlock(-1, 10, -16)).toBe(B.AIR);
    expect(world.getBlock(-1, 11, -17)).toBe(B.AIR);
  });

  it('roundtrips at a spread of chunk-boundary cell coordinates including negatives', () => {
    const { world } = makeWorld();
    converge(world);
    const coords = [-16, -15, -1, 0, 1, 15, 16];
    let id = 1;
    for (const q of coords) {
      for (const r of coords) {
        const v = 1 + (id++ % 20);
        expect(world.setBlock(q, 7, r, v)).toBe(true);
        expect(world.getBlock(q, 7, r)).toBe(v);
        const [cq, cr] = chunkOf(q, r);
        expect(world.getChunk(cq, cr).get(q - cq * CHUNK_SIZE, 7, r - cr * CHUNK_SIZE)).toBe(v);
      }
    }
  });

  it('getBlock in an unloaded area returns AIR and does not allocate a chunk', () => {
    const { world } = makeWorld();
    converge(world);
    const n = world.chunkCount;
    expect(world.getBlock(1000, 10, 1000)).toBe(B.AIR);
    expect(world.getBlock(-1000, 10, 5)).toBe(B.AIR);
    expect(world.chunkCount).toBe(n);
  });

  it('setBlock outside loaded chunks returns false without allocating or recording', () => {
    const { world } = makeWorld();
    converge(world);
    const n = world.chunkCount;
    expect(world.setBlock(1000, 10, 1000, B.STONE)).toBe(false);
    expect(world.chunkCount).toBe(n);
    expect(world.edits.size).toBe(0);
    expect(world.editVersion).toBe(0);
  });

  it('a no-op set returns false, does not bump editVersion and marks nothing dirty', () => {
    const { world } = makeWorld();
    converge(world);
    expect(world.setBlock(3, 10, 3, B.AIR)).toBe(false);
    expect(world.editVersion).toBe(0);
    expect(dirtyKeys(world)).toEqual([]);
    expect(world.setBlock(3, 10, 3, B.STONE)).toBe(true);
    expect(world.editVersion).toBe(1);
    converge(world);
    expect(world.setBlock(3, 10, 3, B.STONE)).toBe(false);
    expect(world.editVersion).toBe(1);
    expect(dirtyKeys(world)).toEqual([]);
  });

  it('respects y bounds: set returns false, get returns AIR', () => {
    const { world } = makeWorld();
    converge(world);
    expect(world.setBlock(0, -1, 0, B.STONE)).toBe(false);
    expect(world.setBlock(0, WORLD_HEIGHT, 0, B.STONE)).toBe(false);
    expect(world.getBlock(0, -1, 0)).toBe(B.AIR);
    expect(world.getBlock(0, WORLD_HEIGHT, 0)).toBe(B.AIR);
    expect(world.setBlock(0, 0, 0, B.STONE)).toBe(true);
    expect(world.setBlock(0, WORLD_HEIGHT - 1, 0, B.STONE)).toBe(true);
    expect(world.getBlock(0, 0, 0)).toBe(B.STONE);
    expect(world.getBlock(0, WORLD_HEIGHT - 1, 0)).toBe(B.STONE);
  });

  it('rejects invalid block ids', () => {
    const { world } = makeWorld();
    converge(world);
    for (const bad of [-1, 256, 1.5, NaN, Infinity, '1', null, undefined]) {
      expect(world.setBlock(0, 10, 0, bad)).toBe(false);
    }
    expect(world.editVersion).toBe(0);
    expect(world.getBlock(0, 10, 0)).toBe(B.AIR);
  });

  it('getBlock tolerates NaN / non-finite input by returning AIR', () => {
    const { world } = makeWorld({ worldGen: flatWorldGen(4) });
    converge(world);
    expect(world.getBlock(NaN, 2, 0)).toBe(B.AIR);
    expect(world.getBlock(0, NaN, 0)).toBe(B.AIR);
    expect(world.getBlock(0, 2, Infinity)).toBe(B.AIR);
    expect(world.getBlock(0, Infinity, 0)).toBe(B.AIR);
  });

  it('getBlockAt takes WORLD positions and resolves the hex cell (not floor(x), floor(z))', () => {
    const { world } = makeWorld();
    converge(world);
    // (0.4, 0.8) lies in cell (0, 1) — floor() would wrongly say cell (0, 0).
    const [q, r] = worldToHex(0.4, 0.8);
    expect([q, r]).toEqual([0, 1]);
    expect(world.setBlock(0, 10, 1, B.STONE)).toBe(true);
    expect(world.getBlockAt(0.4, 10.2, 0.8)).toBe(B.STONE);
    expect(world.getBlock(0, 10, 0)).toBe(B.AIR);
    expect(world.getBlockAt(0.4, 11, 0.8)).toBe(B.AIR);
    expect(world.getBlockAt(NaN, 10, 0.8)).toBe(B.AIR);
    for (const [x, z] of [[3.3, -2.2], [-7.9, 12.1], [0.49, 0.56], [17.2, 13.8]]) {
      const [cq, cr] = worldToHex(x, z);
      world.setBlock(cq, 20, cr, B.GLASS);
      expect(world.getBlockAt(x, 20.5, z)).toBe(B.GLASS);
    }
  });

  it('records every successful edit and bumps editVersion each time', () => {
    const { world } = makeWorld();
    converge(world);
    const ids = [B.STONE, B.DIRT, B.GLASS, B.WATER, B.AIR];
    let version = 0;
    for (let i = 0; i < ids.length; i++) {
      const ok = world.setBlock(2, 10 + i, 2, ids[i]);
      // Setting AIR on an AIR cell is a no-op.
      if (ids[i] === B.AIR) {
        expect(ok).toBe(false);
      } else {
        expect(ok).toBe(true);
        version++;
      }
      expect(world.editVersion).toBe(version);
    }
    const chunkEdits = world.edits.get('0,0');
    expect(chunkEdits.size).toBe(4);
    expect(chunkEdits.get(localIndex(2, 12, 2))).toBe(B.GLASS);
  });
});

describe('world-position queries (hasChunkAt / isReadyAt)', () => {
  it('hasChunkAt / isReadyAt resolve the hex cell under a world point; the *Cell variants take cells', () => {
    const { world } = makeWorld();
    converge(world);
    // Loaded: hex distance <= 3; meshed: hex distance <= 2 (renderDistance).
    for (let cq = -5; cq <= 5; cq++) {
      for (let cr = -5; cr <= 5; cr++) {
        const d = hexLength(cq, cr);
        const [x, z] = chunkCentre(cq, cr);
        expect(world.hasChunkAt(x, z)).toBe(d <= 3);
        expect(world.isReadyAt(x, z)).toBe(d <= 2);
        expect(world.hasChunkAtCell(cq * CHUNK_SIZE + 8, cr * CHUNK_SIZE + 8)).toBe(d <= 3);
        expect(world.isReadyAtCell(cq * CHUNK_SIZE + 8, cr * CHUNK_SIZE + 8)).toBe(d <= 2);
      }
    }
  });

  it('agrees with worldToHex for arbitrary points, including one where floor(x)/16 names the wrong chunk', () => {
    const { world } = makeWorld();
    converge(world);
    // (-8, 55.4) lies in cell (-40, 64) → chunk (-3, 4), hex distance 4: NOT loaded. The naive
    // floor(x/16), floor(z/16) = (-1, 3) is at hex distance 3 and IS loaded.
    const [q, r] = worldToHex(-8, 55.4);
    expect([q, r]).toEqual([-40, 64]);
    expect(world.getChunk(-1, 3)).toBeDefined();
    expect(world.getChunk(-3, 4)).toBeUndefined();
    expect(world.hasChunkAt(-8, 55.4)).toBe(false);
    expect(world.isReadyAt(-8, 55.4)).toBe(false);
    for (let i = 0; i < 200; i++) {
      const x = ((i * 7919) % 1000) / 10 - 50;
      const z = ((i * 104729) % 1000) / 10 - 50;
      const [cq, cr] = worldToHex(x, z);
      expect(world.hasChunkAt(x, z)).toBe(world.hasChunkAtCell(cq, cr));
      expect(world.isReadyAt(x, z)).toBe(world.isReadyAtCell(cq, cr));
    }
    expect(world.hasChunkAt(NaN, 0)).toBe(false);
    expect(world.isReadyAt(0, NaN)).toBe(false);
  });
});

describe('dirty propagation (cell + six hex neighbours)', () => {
  it('an interior edit dirties exactly one chunk', () => {
    const { world } = makeWorld();
    converge(world);
    clearDirty(world);
    world.setBlock(8, 10, 8, B.STONE);
    expect(allDirtyKeys(world)).toEqual(['0,0']);
    expect(expectedDirty(8, 8)).toEqual(['0,0']);
  });

  it('an edge edit at lq=0 also dirties (-1,0) but nothing else', () => {
    const { world } = makeWorld();
    converge(world);
    clearDirty(world);
    world.setBlock(0, 10, 8, B.STONE);
    expect(allDirtyKeys(world)).toEqual(['-1,0', '0,0']);
    expect(allDirtyKeys(world)).toEqual(expectedDirty(0, 8));
  });

  it('an edge edit at lr=15 also dirties (0,1) and — through the (-1,+1) neighbour — (-1,1) when lq=0', () => {
    const { world } = makeWorld();
    converge(world);
    clearDirty(world);
    world.setBlock(8, 10, 15, B.STONE);
    expect(allDirtyKeys(world)).toEqual(['0,0', '0,1']);
    expect(allDirtyKeys(world)).toEqual(expectedDirty(8, 15));
    clearDirty(world);
    world.setBlock(0, 10, 15, B.STONE);
    expect(allDirtyKeys(world)).toEqual(['-1,0', '-1,1', '0,0', '0,1']);
    expect(allDirtyKeys(world)).toEqual(expectedDirty(0, 15));
  });

  it('the corner cell (15,·,15) dirties (0,0),(1,0),(0,1) but NOT (1,1)', () => {
    const { world } = makeWorld();
    converge(world);
    clearDirty(world);
    world.setBlock(15, 10, 15, B.STONE);
    expect(allDirtyKeys(world)).toEqual(['0,0', '0,1', '1,0']);
    expect(allDirtyKeys(world)).toEqual(expectedDirty(15, 15));
    expect(world.getChunk(1, 1).dirty).toBe(false);
  });

  it('the corner cell (0,·,0) dirties (0,0),(-1,0),(0,-1) but NOT (-1,-1)', () => {
    const { world } = makeWorld();
    converge(world);
    clearDirty(world);
    world.setBlock(0, 10, 0, B.STONE);
    expect(allDirtyKeys(world)).toEqual(['-1,0', '0,-1', '0,0']);
    expect(allDirtyKeys(world)).toEqual(expectedDirty(0, 0));
    expect(world.getChunk(-1, -1).dirty).toBe(false);
  });

  it('the corner cell (15,·,0) dirties four chunks: (0,0),(1,0),(0,-1),(1,-1)', () => {
    const { world } = makeWorld();
    converge(world);
    clearDirty(world);
    world.setBlock(15, 10, 0, B.STONE);
    expect(allDirtyKeys(world)).toEqual(['0,-1', '0,0', '1,-1', '1,0']);
    expect(allDirtyKeys(world)).toEqual(expectedDirty(15, 0));
  });

  it('matches the HEX_DIRS rule for every cell of chunk (0,0) and for negative chunks', () => {
    const { world } = makeWorld();
    converge(world);
    for (const [oq, or] of [[0, 0], [-16, -16], [-16, 0], [16, -16]]) {
      for (let lq = 0; lq < CHUNK_SIZE; lq += 5) {
        for (let lr = 0; lr < CHUNK_SIZE; lr += 5) {
          const q = oq + lq;
          const r = or + lr;
          clearDirty(world);
          expect(world.setBlock(q, 20, r, B.STONE)).toBe(true);
          expect(allDirtyKeys(world)).toEqual(expectedDirty(q, r));
        }
      }
    }
  });

  it('never treats vertical neighbours as other chunks', () => {
    const { world } = makeWorld();
    converge(world);
    clearDirty(world);
    world.setBlock(8, 0, 8, B.STONE);
    world.setBlock(8, WORLD_HEIGHT - 1, 8, B.STONE);
    expect(allDirtyKeys(world)).toEqual(['0,0']);
  });

  it('only marks LOADED neighbours dirty (no allocation for missing ones)', () => {
    const { world } = makeWorld();
    converge(world);
    // Chunk (3,0) is in the data ring (hex distance 3); its neighbour (4,0) is not loaded.
    expect(world.getChunk(3, 0)).toBeDefined();
    expect(world.getChunk(4, 0)).toBeUndefined();
    const n = world.chunkCount;
    clearDirty(world);
    expect(world.setBlock(63, 10, 0, B.STONE)).toBe(true);
    expect(allDirtyKeys(world)).toEqual(expectedDirty(63, 0).filter((k) => world.chunks.has(k)));
    expect(allDirtyKeys(world)).toContain('3,0');
    expect(allDirtyKeys(world)).not.toContain('4,0');
    expect(world.chunkCount).toBe(n);
  });
});

describe('update() streaming', () => {
  it('with radius 2 converges to 19 meshed and 37 loaded chunks (hex discs); onChunkMesh once per chunk', () => {
    const { world, meshCalls } = makeWorld();
    const total = converge(world);
    expect(world.chunkCount).toBe(hexDiscCount(2 + DATA_RADIUS_EXTRA));
    expect(world.chunkCount).toBe(37);
    expect(total.generated).toBe(37);
    expect(total.meshed).toBe(hexDiscCount(2));
    expect(meshCalls.length).toBe(19);
    expect(new Set(meshCalls.map((c) => c.key)).size).toBe(19);
    for (const { key, cq, cr } of meshCalls) {
      expect(key).toBe(chunkKey(cq, cr));
      expect(hexLength(cq, cr)).toBeLessThanOrEqual(2);
      const c = world.getChunk(cq, cr);
      expect(c.meshed).toBe(true);
      expect(c.dirty).toBe(false);
    }
    for (const c of world.chunks.values()) {
      const d = hexLength(c.cq, c.cr);
      expect(d).toBeLessThanOrEqual(3);
      expect(c.meshed).toBe(d <= 2);
      if (d === 3) expect(c.dirty).toBe(true); // data-only chunks are never meshed
    }
  });

  it('a repeat converge reports zero work and the loaded set is exactly the hex disc', () => {
    const { world } = makeWorld();
    converge(world);
    const again = converge(world);
    expect(again).toEqual({ generated: 0, meshed: 0, unloaded: 0, calls: 1 });
    const keys = new Set(world.chunks.keys());
    for (let cq = -4; cq <= 4; cq++) {
      for (let cr = -4; cr <= 4; cr++) {
        expect(keys.has(chunkKey(cq, cr))).toBe(hexLength(cq, cr) <= 3);
      }
    }
  });

  it('generates nearest-first: ring order by dq²+dq·dr+dr², ties dr then dq', () => {
    const { gen, calls } = spyGen(trivialWorldGen());
    const { world } = makeWorld({ worldGen: gen });
    converge(world);
    expect(calls.length).toBe(37);
    expect(calls[0]).toEqual([0, 0]);
    for (let i = 1; i < calls.length; i++) {
      const [aq, ar] = calls[i - 1];
      const [bq, br] = calls[i];
      const da = hexNormSq(aq, ar);
      const db = hexNormSq(bq, br);
      const before = da < db || (da === db && (ar < br || (ar === br && aq < bq)));
      expect(before).toBe(true);
    }
    // The first ring (6 cells at norm² 1) immediately follows the centre.
    for (let i = 1; i <= 6; i++) expect(hexLength(...calls[i])).toBe(1);
  });

  it('returns the contract counters on the first call and respects MAX_BUILDS_PER_UPDATE', () => {
    const { world } = makeWorld();
    const r = world.update(0, 0, Infinity);
    expect(r.generated + r.meshed).toBe(MAX_BUILDS_PER_UPDATE);
    expect(r.generated).toBe(MAX_BUILDS_PER_UPDATE); // nothing can be meshed before its 6 neighbours exist
    expect(r.meshed).toBe(0);
    expect(r.unloaded).toBe(0);
    expect(r.pendingGen).toBe(37 - MAX_BUILDS_PER_UPDATE);
    expect(r.pendingMesh).toBe(19);
    expect(world.chunkCount).toBe(MAX_BUILDS_PER_UPDATE);
  });

  it('does at least one build per call even with a zero budget, then stops', () => {
    const { world } = makeWorld();
    const r = world.update(0, 0, 0);
    expect(r.generated + r.meshed).toBe(1);
    expect(r.pendingGen).toBe(36);
    let calls = 0;
    while (calls < 1000) {
      const s = world.update(0, 0, 0);
      calls++;
      if (s.pendingGen === 0 && s.pendingMesh === 0) break;
    }
    expect(calls).toBeLessThan(1000);
    expect(world.chunkCount).toBe(37);
  });

  it('honours a time budget between builds (clock jumps past budgetMs after each build)', () => {
    let t = 0;
    const { world } = makeWorld({ now: () => (t += 10) });
    const r = world.update(0, 0, 5);
    expect(r.generated + r.meshed).toBe(1);
    const r2 = world.update(0, 0, 5);
    expect(r2.generated + r2.meshed).toBe(1);
    expect(world.chunkCount).toBe(2);
  });

  it('repeated update at the same position does nothing', () => {
    const { world, meshCalls } = makeWorld();
    converge(world);
    const n = meshCalls.length;
    for (let i = 0; i < 5; i++) {
      expect(world.update(0, 0, Infinity)).toEqual({ generated: 0, meshed: 0, unloaded: 0, pendingGen: 0, pendingMesh: 0 });
    }
    expect(meshCalls.length).toBe(n);
  });

  it('moving within the same chunk does nothing either', () => {
    const { world, meshCalls } = makeWorld();
    converge(world);
    const n = meshCalls.length;
    for (const [x, z] of [[0.3, 0.2], [3, 4], [7, 6], [-0.4, 0.1]]) {
      const [q, r] = worldToHex(x, z);
      expect(chunkOf(q, r)).toEqual([0, 0]);
      expect(world.update(x, z, Infinity)).toEqual({ generated: 0, meshed: 0, unloaded: 0, pendingGen: 0, pendingMesh: 0 });
    }
    expect(meshCalls.length).toBe(n);
  });

  it('moving far away unloads every chunk, calling onChunkUnload exactly once per meshed chunk', () => {
    const { world, meshCalls, unloadCalls } = makeWorld();
    converge(world);
    const meshedKeys = new Set(meshCalls.map((c) => c.key));
    const [fx, fz] = chunkCentre(100, 100);
    const r = world.update(fx, fz, Infinity);
    expect(r.unloaded).toBe(37);
    expect(unloadCalls.length).toBe(19);
    expect(new Set(unloadCalls).size).toBe(19);
    for (const k of unloadCalls) expect(meshedKeys.has(k)).toBe(true);
    for (const k of meshedKeys) expect(world.chunks.has(k)).toBe(false);
  });

  it('unloads only beyond renderDistance + UNLOAD_RADIUS_EXTRA in hex distance (hysteresis)', () => {
    const { world, unloadCalls } = makeWorld();
    converge(world);
    const before = new Set(world.chunks.keys());
    const unloadRadius = 2 + UNLOAD_RADIUS_EXTRA; // 5
    // Step three chunks east: chunk (-3,0) is now at hex distance 6 and goes; (-2,0) at 5 stays.
    const [x, z] = chunkCentre(3, 0);
    const r = world.update(x, z, Infinity);
    expect(r.unloaded).toBeGreaterThan(0);
    for (const key of before) {
      const [cq, cr] = key.split(',').map(Number);
      const d = hexLength(cq - 3, cr);
      expect(world.chunks.has(key)).toBe(d <= unloadRadius);
    }
    expect(world.chunks.has('-2,0')).toBe(true); // beyond the new data ring (3) but inside the unload radius
    expect(world.chunks.has('-3,0')).toBe(false);
    expect(world.chunks.has('-3,1')).toBe(false); // hexLength(-6, 1) = 6
    // Every unload callback names a chunk that had been meshed and is now gone.
    for (const k of unloadCalls) {
      const [cq, cr] = k.split(',').map(Number);
      expect(hexLength(cq, cr)).toBeLessThanOrEqual(2);
      expect(world.chunks.has(k)).toBe(false);
    }
  });

  it('meshes a chunk only once its 6 hex-adjacent chunks exist, so generation never invalidates a mesh', () => {
    const { world } = makeWorld({ renderDistance: 3 });
    const seen = new Set();
    const unloadedSince = new Set();
    let meshes = 0;
    world.onChunkMesh = (key, cq, cr) => {
      for (const [dq, dr] of HEX_DIRS) expect(world.getChunk(cq + dq, cr + dr)).toBeDefined();
      // A chunk may only be meshed again after it has been unloaded and regenerated in between.
      if (seen.has(key)) expect(unloadedSince.has(key), `${key} re-meshed without an unload`).toBe(true);
      seen.add(key);
      unloadedSince.delete(key);
      meshes++;
    };
    world.onChunkUnload = (key) => unloadedSince.add(key);
    // Stream with the default (small) budget and a moving player; no edits happen.
    let t = 0;
    world._now = () => (t += 1);
    const path = [[0, 0], [1, 0], [2, 0], [2, 1], [1, 2], [0, 2], [-1, 2], [-2, 1], [-2, 0]];
    for (const [cq, cr] of path) {
      const [x, z] = chunkCentre(cq, cr);
      for (let i = 0; i < 60; i++) world.update(x, z);
    }
    for (const [cq, cr] of path) {
      const [x, z] = chunkCentre(cq, cr);
      converge(world, x, z);
    }
    expect(seen.size).toBeGreaterThan(hexDiscCount(3));
    expect(meshes).toBeGreaterThanOrEqual(seen.size);
  });

  it('mesh data for a flat world is non-empty, chunk-local and has one top hexagon per column', () => {
    const { world, meshes } = makeWorld({ worldGen: flatWorldGen(4) });
    converge(world);
    const m = meshes.get('0,0');
    expect(m).toBeDefined();
    expect(m.opaque).not.toBeNull();
    expect(m.cutout).toBeNull();
    expect(m.translucent).toBeNull();
    // Interior top faces only: sides between equal-height neighbours (also across borders) are culled and
    // the y=0 bottoms sit on the virtual bedrock floor.
    expect(countFaces(m)).toBe(CHUNK_SIZE * CHUNK_SIZE);
    expect(m.opaque.vertexCount).toBe(CHUNK_SIZE * CHUNK_SIZE * 7);
    expect(m.opaque.indexCount).toBe(CHUNK_SIZE * CHUNK_SIZE * 18);
    const p = m.opaque.positions;
    for (let i = 0; i < p.length; i += 3) {
      expect(p[i]).toBeGreaterThanOrEqual(-0.51);
      expect(p[i]).toBeLessThanOrEqual(24.51);
      expect(p[i + 1]).toBe(5);
      expect(p[i + 2]).toBeGreaterThanOrEqual(-0.58);
      expect(p[i + 2]).toBeLessThanOrEqual(13.58);
    }
  });
});

describe('edits, re-meshing and persistence', () => {
  it('an edit re-meshes the chunk on the next update and the new mesh has the extra faces', () => {
    const { world, meshes, meshCalls } = makeWorld({ worldGen: flatWorldGen(4) });
    converge(world);
    const n = meshCalls.length;
    expect(world.setBlock(8, 5, 8, B.STONE)).toBe(true);
    expect(dirtyKeys(world)).toEqual(['0,0']);
    const r = world.update(0, 0, Infinity);
    expect(r.meshed).toBe(1);
    expect(meshCalls.length).toBe(n + 1);
    expect(dirtyKeys(world)).toEqual([]);
    // 256 tops + 6 new sides + 1 new top − 1 hidden top of the cell underneath.
    expect(countFaces(meshes.get('0,0'))).toBe(CHUNK_SIZE * CHUNK_SIZE + 6);
  });

  it('a placed STONE in an empty world produces an 8-face mesh; breaking it empties the mesh', () => {
    const { world, meshes } = makeWorld();
    converge(world);
    expect(meshes.get('0,0')).toEqual({ opaque: null, cutout: null, translucent: null });
    world.setBlock(5, 20, 5, B.STONE);
    world.update(0, 0, Infinity);
    expect(countFaces(meshes.get('0,0'))).toBe(8); // 6 sides + top + bottom
    world.setBlock(5, 20, 5, B.AIR);
    world.update(0, 0, Infinity);
    expect(meshes.get('0,0')).toEqual({ opaque: null, cutout: null, translucent: null });
  });

  it('re-meshes ALL dirty meshed chunks immediately, ignoring the budget (§9.1 step 2)', () => {
    const { world } = makeWorld();
    converge(world);
    world.setBlock(8, 10, 8, B.STONE);     // chunk (0,0)
    world.setBlock(24, 10, 8, B.STONE);    // chunk (1,0)
    world.setBlock(8, 10, -8, B.STONE);    // chunk (0,-1)
    expect(dirtyKeys(world)).toEqual(['0,-1', '0,0', '1,0']);
    const r = world.update(0, 0, 0);
    expect(r.meshed).toBe(3);
    expect(r.generated).toBe(0);
    expect(dirtyKeys(world)).toEqual([]);
  });

  it('cross-border culling: STONE at (16,10,0) hides the east face of STONE at (15,10,0)', () => {
    const { world, meshes } = makeWorld();
    converge(world);
    world.setBlock(15, 10, 0, B.STONE);
    world.update(0, 0, Infinity);
    expect(countFaces(meshes.get('0,0'))).toBe(8);
    world.setBlock(16, 10, 0, B.STONE);
    world.update(0, 0, Infinity);
    expect(countFaces(meshes.get('0,0'))).toBe(7);
    expect(countFaces(meshes.get('1,0'))).toBe(7);
    // (16,-1) — in chunk (1,-1) — touches BOTH (15,0) (across face 5/2) and (16,0) (across face 1/4): the three
    // cells meet at one vertex, so each of them now hides two side faces.
    world.setBlock(16, 10, -1, B.STONE);
    world.update(0, 0, Infinity);
    expect(countFaces(meshes.get('0,0'))).toBe(6);
    expect(countFaces(meshes.get('1,-1'))).toBe(6);
    expect(countFaces(meshes.get('1,0'))).toBe(6);
  });

  it('edits survive unload → reload', () => {
    const { world } = makeWorld();
    converge(world);
    world.setBlock(3, 10, 3, B.STONE);
    world.setBlock(-1, 10, -17, B.DIRT);
    const [fx, fz] = chunkCentre(100, 100);
    world.update(fx, fz, Infinity); // unloads everything here (and starts generating chunks over there)
    expect(world.chunks.has('0,0')).toBe(false);
    expect(world.chunks.has('-1,-2')).toBe(false);
    expect(world.getBlock(3, 10, 3)).toBe(B.AIR); // unloaded
    expect(world.edits.get('0,0').get(localIndex(3, 10, 3))).toBe(B.STONE);
    converge(world);
    expect(world.getBlock(3, 10, 3)).toBe(B.STONE);
    expect(world.getBlock(-1, 10, -17)).toBe(B.DIRT);
  });

  it('edits are applied before the chunk becomes visible to getBlock', () => {
    const li = localIndex(3, 10, 3);
    let world;
    const gen = {
      seed: 1,
      getColumn: () => ({ height: 0, biome: BIOME.PLAINS, temperature: 0, humidity: 0 }),
      generateChunk(cq, cr) {
        if (cq === 0 && cr === 0) expect(world.getBlock(3, 10, 3)).toBe(B.AIR); // not visible yet
        return makeChunkData();
      },
    };
    world = new World({ seed: 1, renderDistance: 1, worldGen: gen, now: () => 0, edits: { '0,0': [li, B.STONE] } });
    world.update(0, 0, 0); // generates exactly chunk (0,0)
    expect(world.getChunk(0, 0)).toBeDefined();
    expect(world.getBlock(3, 10, 3)).toBe(B.STONE);
  });

  it('exportEdits produces flat pairs keyed by chunk and skips empty entries', () => {
    const { world } = makeWorld();
    converge(world);
    world.setBlock(1, 2, 3, B.STONE);
    world.setBlock(1, 3, 3, B.DIRT);
    world.setBlock(-1, 10, -17, B.GLASS);
    world.edits.set('5,5', new Map()); // an empty entry must be skipped
    const out = world.exportEdits();
    expect(Object.keys(out).sort()).toEqual(['-1,-2', '0,0']);
    expect(out['0,0']).toEqual([localIndex(1, 2, 3), B.STONE, localIndex(1, 3, 3), B.DIRT]);
    expect(out['-1,-2']).toEqual([localIndex(15, 10, 15), B.GLASS]);
    // Fresh arrays: mutating the export does not touch the world.
    out['0,0'][1] = 99;
    expect(world.edits.get('0,0').get(localIndex(1, 2, 3))).toBe(B.STONE);
  });

  it('exportEdits → new World({ edits }) roundtrip reproduces the blocks', () => {
    const { world } = makeWorld();
    converge(world);
    const cells = [[1, 2, 3, B.STONE], [15, 50, 15, B.GLASS], [-16, 7, 16, B.BRICKS], [0, 0, 0, B.WATER]];
    for (const [q, y, r, id] of cells) expect(world.setBlock(q, y, r, id)).toBe(true);
    const json = JSON.parse(JSON.stringify(world.exportEdits()));
    const { world: w2 } = makeWorld({ edits: json });
    expect(w2.editVersion).toBe(0);
    converge(w2);
    for (const [q, y, r, id] of cells) expect(w2.getBlock(q, y, r)).toBe(id);
    expect(w2.exportEdits()).toEqual(world.exportEdits());
  });

  it('importEdits merges (last write wins) and applies to loaded chunks, marking them and their border neighbours dirty', () => {
    const { world } = makeWorld();
    converge(world);
    clearDirty(world);
    const li = localIndex(15, 10, 15);
    world.importEdits({ '0,0': [li, B.STONE, li, B.DIRT] });
    expect(world.getBlock(15, 10, 15)).toBe(B.DIRT);
    expect(world.edits.get('0,0').get(li)).toBe(B.DIRT);
    expect(allDirtyKeys(world)).toEqual(expectedDirty(15, 15));
    // Not an edit by the player: editVersion is untouched.
    expect(world.editVersion).toBe(0);
    // Importing for an unloaded chunk only records; the block appears when the chunk is generated.
    world.importEdits({ '20,20': [localIndex(0, 5, 0), B.GLASS] });
    expect(world.edits.get('20,20').get(localIndex(0, 5, 0))).toBe(B.GLASS);
    expect(world.getChunk(20, 20)).toBeUndefined();
    // Last write wins across calls too.
    world.importEdits({ '0,0': [li, B.SAND] });
    expect(world.getBlock(15, 10, 15)).toBe(B.SAND);
  });

  it('importEdits ignores malformed entries and leaves state unchanged for empty input', () => {
    const { world } = makeWorld();
    converge(world);
    const before = JSON.stringify(world.exportEdits());
    world.importEdits(null);
    world.importEdits(undefined);
    world.importEdits({});
    world.importEdits('nope');
    world.importEdits({ 'a,b': [0, 1], '0,0': 'notarray', '1,1': [-1, 5, CHUNK_VOLUME, 5, 3, 256, 4, 1.5, 7], '2,2': [] });
    expect(JSON.stringify(world.exportEdits())).toBe(before);
    expect(world.edits.has('a,b')).toBe(false);
    expect(world.edits.has('1,1')).toBe(false);
    expect(world.edits.has('2,2')).toBe(false);
    // A valid pair after an odd dangling element is still kept.
    world.importEdits({ '1,1': [localIndex(1, 1, 1), B.STONE, 5] });
    expect(world.edits.get('1,1').get(localIndex(1, 1, 1))).toBe(B.STONE);
  });

  it('importEdits skips a chunk key without a comma instead of reading it as chunk (0,0)', () => {
    const { world } = makeWorld();
    converge(world);
    world.importEdits({ '0': [localIndex(1, 1, 1), B.STONE], '': [localIndex(2, 2, 2), B.DIRT], '5': [0, 1] });
    expect(world.edits.size).toBe(0);
    expect(world.getBlock(1, 1, 1)).toBe(B.AIR);
    expect(world.getBlock(2, 2, 2)).toBe(B.AIR);
  });
});

describe('spawn, surface, biome', () => {
  it('findSpawn returns the centre of cell (0,0) for a flat land world', () => {
    const { world } = makeWorld({ worldGen: flatWorldGen(70) });
    expect(world.findSpawn()).toEqual([0, 71, 0]);
  });

  it('findSpawn walks hex rings of 4-cell steps and returns the first valid cell centre', () => {
    const target = [8, -4]; // hexLength 2 in step units → ring 2
    const calls = [];
    const gen = {
      seed: 1,
      getColumn(q, r) {
        calls.push([q, r]);
        if (q === target[0] && r === target[1]) return { height: 80, biome: BIOME.PLAINS, temperature: 0, humidity: 0 };
        return { height: SEA_LEVEL - 10, biome: BIOME.OCEAN, temperature: 0, humidity: 0 };
      },
      generateChunk: () => makeChunkData(),
    };
    const { world } = makeWorld({ worldGen: gen });
    const [tx, tz] = hexToWorld(target[0], target[1]);
    expect(world.findSpawn()).toEqual([tx, 81, tz]);
    expect(calls[0]).toEqual([0, 0]);
    expect(calls[calls.length - 1]).toEqual(target);
    let ring = 0;
    for (const [q, r] of calls) {
      expect(q % 4 === 0).toBe(true);
      expect(r % 4 === 0).toBe(true);
      const n = hexLength(q / 4, r / 4);
      expect(n).toBeGreaterThanOrEqual(ring); // rings are visited in order
      ring = n;
    }
    // Ring 1 (6 cells) was fully visited before anything on ring 2.
    expect(calls.filter(([q, r]) => hexLength(q / 4, r / 4) === 1).length).toBe(6);
  });

  it('findSpawn skips low, ocean and beach columns', () => {
    const gen = {
      seed: 1,
      getColumn(q, r) {
        if (q === 0 && r === 0) return { height: SEA_LEVEL + 1, biome: BIOME.PLAINS, temperature: 0, humidity: 0 }; // too low
        if (q === 4 && r === 0) return { height: 80, biome: BIOME.BEACH, temperature: 0, humidity: 0 };
        if (q === 0 && r === 4) return { height: 80, biome: BIOME.OCEAN, temperature: 0, humidity: 0 };
        if (q === -4 && r === 4) return { height: SEA_LEVEL + 2, biome: BIOME.FOREST, temperature: 0, humidity: 0 }; // first valid
        return { height: 80, biome: BIOME.PLAINS, temperature: 0, humidity: 0 };
      },
      generateChunk: () => makeChunkData(),
    };
    const { world } = makeWorld({ worldGen: gen });
    const s = world.findSpawn();
    // The first ring is walked from 4·HEX_DIRS[4] = (0,-4) along the directions in order; whichever valid
    // cell comes first must be a ring-1 cell that is not one of the rejected ones.
    const [q, r] = worldToHex(s[0], s[2]);
    expect(hexLength(q / 4, r / 4)).toBe(1);
    expect([`${q},${r}`]).not.toContain('4,0');
    expect([`${q},${r}`]).not.toContain('0,4');
    expect(s[1]).toBe(gen.getColumn(q, r).height + 1);
  });

  it('findSpawn terminates with a sane fallback when no column is ever valid', () => {
    const ocean = { height: SEA_LEVEL - 20, biome: BIOME.OCEAN, temperature: 0, humidity: 0 };
    let calls = 0;
    const gen = { seed: 1, getColumn: () => (calls++, ocean), generateChunk: () => makeChunkData() };
    const { world } = makeWorld({ worldGen: gen });
    expect(world.findSpawn()).toEqual([0, SEA_LEVEL + 1, 0]);
    // 1 + Σ 6n for n = 1..128 rings, plus the fallback query.
    expect(calls).toBe(1 + 6 * (128 * 129) / 2 + 1);
    // A high all-ocean world keeps its height.
    const high = { height: 90, biome: BIOME.OCEAN, temperature: 0, humidity: 0 };
    const { world: w2 } = makeWorld({ worldGen: { seed: 1, getColumn: () => high, generateChunk: () => makeChunkData() } });
    expect(w2.findSpawn()).toEqual([0, 91, 0]);
  });

  it('findSpawn does not load chunks', () => {
    const { world } = makeWorld({ worldGen: flatWorldGen(70) });
    world.findSpawn();
    expect(world.chunkCount).toBe(0);
  });

  it('getSurfaceHeight and getBiome come from worldGen.getColumn and ignore edits', () => {
    const gen = {
      seed: 1,
      getColumn: (q, r) => ({ height: 60 + ((q + r) & 7), biome: q < 0 ? BIOME.DESERT : BIOME.FOREST, temperature: 0, humidity: 0 }),
      generateChunk: () => makeChunkData(),
    };
    const { world } = makeWorld({ worldGen: gen });
    converge(world);
    expect(world.getSurfaceHeight(3, 2)).toBe(65);
    expect(world.getSurfaceHeight(-3, 2)).toBe(67);
    expect(world.getBiome(3, 2)).toBe(BIOME.FOREST);
    expect(world.getBiome(-3, 2)).toBe(BIOME.DESERT);
    world.setBlock(3, 100, 2, B.STONE);
    expect(world.getSurfaceHeight(3, 2)).toBe(65);
  });
});

describe('setRenderDistance and dispose', () => {
  it('clamps to 1..16 and changes the streaming footprint', () => {
    const { world } = makeWorld();
    world.setRenderDistance(0);
    expect(world.renderDistance).toBe(1);
    world.setRenderDistance(40);
    expect(world.renderDistance).toBe(16);
    world.setRenderDistance(1);
    converge(world);
    expect(world.chunkCount).toBe(hexDiscCount(1 + DATA_RADIUS_EXTRA));
    let meshed = 0;
    for (const c of world.chunks.values()) if (c.meshed) meshed++;
    expect(meshed).toBe(hexDiscCount(1));
  });

  it('shrinking the render distance unloads chunks beyond the new unload radius on the next update', () => {
    const { world, unloadCalls } = makeWorld({ renderDistance: 4 });
    converge(world);
    expect(world.chunkCount).toBe(hexDiscCount(5));
    world.setRenderDistance(1);
    const newUnloadRadius = 1 + UNLOAD_RADIUS_EXTRA; // 4
    const r = world.update(0, 0, Infinity);
    expect(r.unloaded).toBe(hexDiscCount(5) - hexDiscCount(newUnloadRadius)); // ring 5: 30 chunks
    expect(world.chunkCount).toBe(hexDiscCount(newUnloadRadius));
    for (const c of world.chunks.values()) expect(hexLength(c.cq, c.cr)).toBeLessThanOrEqual(newUnloadRadius);
    // Ring 5 was never meshed (render distance was 4), so no unload callbacks fire.
    expect(unloadCalls).toEqual([]);
  });

  it('dispose removes all chunks and fires onChunkUnload only for meshed ones; edits survive', () => {
    const { world, unloadCalls, meshCalls } = makeWorld();
    converge(world);
    world.setBlock(1, 1, 1, B.STONE);
    world.dispose();
    expect(world.chunkCount).toBe(0);
    expect(world.chunks.size).toBe(0);
    expect(unloadCalls.length).toBe(19);
    expect(new Set(unloadCalls)).toEqual(new Set(meshCalls.map((c) => c.key)));
    expect(world.edits.get('0,0').get(localIndex(1, 1, 1))).toBe(B.STONE);
    expect(world.getBlock(1, 1, 1)).toBe(B.AIR);
    expect(world.hasChunkAt(0, 0)).toBe(false);
    // The world is still usable afterwards.
    converge(world);
    expect(world.getBlock(1, 1, 1)).toBe(B.STONE);
  });

  it('uses the injected worldGen output arrays as-is (no copy)', () => {
    const data = makeChunkData();
    const gen = {
      seed: 1,
      getColumn: () => ({ height: 0, biome: BIOME.PLAINS, temperature: 0, humidity: 0 }),
      generateChunk: (cq, cr) => (cq === 0 && cr === 0 ? data : makeChunkData()),
    };
    const { world } = makeWorld({ worldGen: gen });
    converge(world);
    expect(world.getChunk(0, 0).blocks).toBe(data.blocks);
    expect(world.getChunk(0, 0).biomes).toBe(data.biomes);
    expect(world.getChunk(0, 0).heights).toBe(data.heights);
  });
});

// ---------------------------------------------------------------------------------------------
// Regression (review finding): a non-finite player position used to generate and mesh a phantom 'NaN,NaN'
// chunk (every packId(NaN, …) collides in the Map, so it even passed the 6-neighbour check) that nothing unloaded.
describe('update() with a non-finite position', () => {
  it('does nothing and reports zero work', () => {
    const world = new World({ seed: 1, renderDistance: 2, worldGen: flatWorldGen(10), now: () => 0 });
    let r;
    do r = world.update(0, 0, Infinity); while (r.pendingGen > 0 || r.pendingMesh > 0);
    const before = world.chunkCount;
    const keys = [...world.chunks.keys()].sort();
    for (const [px, pz] of [[NaN, 0], [0, NaN], [Infinity, 0], [0, -Infinity], [NaN, NaN]]) {
      expect(world.update(px, pz, Infinity)).toEqual({ generated: 0, meshed: 0, unloaded: 0, pendingGen: 0, pendingMesh: 0 });
    }
    expect(world.chunkCount).toBe(before);
    expect([...world.chunks.keys()].sort()).toEqual(keys);
    expect(world.chunks.has('NaN,NaN')).toBe(false);
    expect(world.getChunk(NaN, NaN)).toBeUndefined();
  });
});
