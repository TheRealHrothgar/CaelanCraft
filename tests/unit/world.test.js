// Unit tests for src/world.js — see src/CONTRACTS.md §9 / §9.1 and docs/PLAN-build.md §2.5.
// worldgen.js may still be a stub, so every World here gets an injected WorldGen from the fixtures
// and a frozen clock (now: () => 0) with an infinite budget unless a test is about the budget itself.
import { describe, it, expect } from 'vitest';
import {
  CHUNK_SIZE, WORLD_HEIGHT, CHUNK_VOLUME, SEA_LEVEL, RENDER_DISTANCE,
  DATA_RADIUS_EXTRA, UNLOAD_RADIUS_EXTRA, MAX_BUILDS_PER_UPDATE,
} from '../../src/config.js';
import { chunkKey, localIndex } from '../../src/coords.js';
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
  world.onChunkMesh = (key, cx, cz, m) => {
    meshCalls.push({ key, cx, cz });
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

/**
 * Keys of meshed chunks that need re-meshing (dirty && meshed). Data-ring chunks outside the render
 * radius are never meshed and therefore stay dirty by design, so they are excluded here.
 */
function dirtyKeys(world) {
  const out = [];
  for (const [key, c] of world.chunks) if (c.dirty && c.meshed) out.push(key);
  return out.sort();
}

/** Chebyshev distance between chunk (cx,cz) and (pcx,pcz). */
function cheb(cx, cz, pcx, pcz) {
  return Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz));
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
  });

  it('accepts initial edits and applies them when the chunk is generated', () => {
    const li = localIndex(15, 10, 15);
    const { world } = makeWorld({ edits: { '-1,-2': [li, B.STONE] } });
    expect(world.edits.get('-1,-2').get(li)).toBe(B.STONE);
    expect(world.editVersion).toBe(0);
    converge(world);
    expect(world.getBlock(-1, 10, -17)).toBe(B.STONE);
    expect(world.getChunk(-1, -2).get(15, 10, 15)).toBe(B.STONE);
  });
});

// ---------------------------------------------------------------------------------------------

describe('coordinate ownership and getBlock/setBlock', () => {
  it('setBlock(-1,10,-17) lands in chunk (-1,-2) at local (15,10,15)', () => {
    const { world } = makeWorld();
    converge(world);
    expect(world.setBlock(-1, 10, -17, B.STONE)).toBe(true);
    const chunk = world.getChunk(-1, -2);
    expect(chunk).toBeDefined();
    expect(chunk.cx).toBe(-1);
    expect(chunk.cz).toBe(-2);
    expect(chunk.get(15, 10, 15)).toBe(B.STONE);
    expect(chunk.blocks[localIndex(15, 10, 15)]).toBe(B.STONE);
    expect(world.getBlock(-1, 10, -17)).toBe(B.STONE);
    // Neighbouring cells in every direction are untouched.
    expect(world.getBlock(0, 10, -17)).toBe(B.AIR);
    expect(world.getBlock(-2, 10, -17)).toBe(B.AIR);
    expect(world.getBlock(-1, 10, -16)).toBe(B.AIR);
    expect(world.getBlock(-1, 10, -18)).toBe(B.AIR);
    expect(world.getBlock(-1, 9, -17)).toBe(B.AIR);
    expect(world.getBlock(-1, 11, -17)).toBe(B.AIR);
    // No other chunk received the block.
    expect(world.getChunk(0, -1).get(15, 10, 15)).toBe(B.AIR);
    expect(world.getChunk(0, 0).get(15, 10, 15)).toBe(B.AIR);
  });

  it('roundtrips at a spread of chunk-boundary coordinates including negatives', () => {
    const { world } = makeWorld();
    converge(world);
    const cases = [
      [0, 5, 0, 0, 0, 0, 0],
      [16, 5, 15, 1, 0, 0, 15],
      [-16, 5, -16, -1, -1, 0, 0],
      [-17, 5, 31, -2, 1, 15, 15],
      [-1, 5, -1, -1, -1, 15, 15],
      [15, 5, 15, 0, 0, 15, 15],
    ];
    for (const [wx, wy, wz, cx, cz, lx, lz] of cases) {
      expect(world.setBlock(wx, wy, wz, B.BRICKS)).toBe(true);
      expect(world.getBlock(wx, wy, wz)).toBe(B.BRICKS);
      expect(world.getChunk(cx, cz).get(lx, wy, lz)).toBe(B.BRICKS);
    }
  });

  it('getBlock in an unloaded area returns AIR and does not allocate a chunk', () => {
    const { world } = makeWorld();
    expect(world.getBlock(0, 10, 0)).toBe(B.AIR);
    expect(world.getBlock(-1000, 10, 1000)).toBe(B.AIR);
    expect(world.getBlock(1e9, 64, -1e9)).toBe(B.AIR);
    expect(world.chunkCount).toBe(0);
    expect(world.chunks.size).toBe(0);
    expect(world.getChunk(0, 0)).toBeUndefined();
    expect(world.hasChunkAt(0, 0)).toBe(false);
    expect(world.isReadyAt(0, 0)).toBe(false);
  });

  it('setBlock outside loaded chunks returns false without allocating or recording', () => {
    const { world } = makeWorld();
    expect(world.setBlock(0, 10, 0, B.STONE)).toBe(false);
    expect(world.setBlock(-1, 10, -17, B.STONE)).toBe(false);
    expect(world.chunkCount).toBe(0);
    expect(world.editVersion).toBe(0);
    expect(world.edits.size).toBe(0);
    // Just outside the loaded ring too.
    converge(world);
    const far = (world.renderDistance + DATA_RADIUS_EXTRA + 1) * CHUNK_SIZE;
    expect(world.hasChunkAt(far, 0)).toBe(false);
    expect(world.setBlock(far, 10, 0, B.STONE)).toBe(false);
    expect(world.editVersion).toBe(0);
  });

  it('a no-op set returns false, does not bump editVersion and marks nothing dirty', () => {
    const { world } = makeWorld();
    converge(world);
    expect(dirtyKeys(world)).toEqual([]);
    expect(world.setBlock(8, 10, 8, B.STONE)).toBe(true);
    expect(world.editVersion).toBe(1);
    converge(world);
    expect(dirtyKeys(world)).toEqual([]);
    expect(world.setBlock(8, 10, 8, B.STONE)).toBe(false);
    expect(world.editVersion).toBe(1);
    expect(dirtyKeys(world)).toEqual([]);
    // Setting AIR where it is already AIR is a no-op as well.
    expect(world.setBlock(1, 1, 1, B.AIR)).toBe(false);
    expect(world.editVersion).toBe(1);
  });

  it('respects y bounds: set returns false, get returns AIR', () => {
    const { world } = makeWorld();
    converge(world);
    expect(world.setBlock(0, -1, 0, B.STONE)).toBe(false);
    expect(world.setBlock(0, WORLD_HEIGHT, 0, B.STONE)).toBe(false);
    expect(world.setBlock(0, 1000, 0, B.STONE)).toBe(false);
    expect(world.getBlock(0, -1, 0)).toBe(B.AIR);
    expect(world.getBlock(0, WORLD_HEIGHT, 0)).toBe(B.AIR);
    expect(world.getBlock(0, 1e6, 0)).toBe(B.AIR);
    expect(world.editVersion).toBe(0);
    // Boundaries themselves are valid.
    expect(world.setBlock(0, 0, 0, B.STONE)).toBe(true);
    expect(world.setBlock(0, WORLD_HEIGHT - 1, 0, B.STONE)).toBe(true);
    expect(world.getBlock(0, WORLD_HEIGHT - 1, 0)).toBe(B.STONE);
  });

  it('rejects invalid block ids', () => {
    const { world } = makeWorld();
    converge(world);
    expect(world.setBlock(0, 5, 0, -1)).toBe(false);
    expect(world.setBlock(0, 5, 0, 256)).toBe(false);
    expect(world.setBlock(0, 5, 0, 1.5)).toBe(false);
    expect(world.setBlock(0, 5, 0, NaN)).toBe(false);
    expect(world.editVersion).toBe(0);
  });

  it('getBlock tolerates NaN / non-finite input by returning AIR', () => {
    const { world } = makeWorld({ worldGen: flatWorldGen(4) });
    converge(world);
    expect(world.getBlock(NaN, 2, 0)).toBe(B.AIR);
    expect(world.getBlock(0, NaN, 0)).toBe(B.AIR);
    expect(world.getBlock(0, 2, Infinity)).toBe(B.AIR);
  });

  it('records every successful edit and bumps editVersion each time', () => {
    const { world } = makeWorld();
    converge(world);
    world.setBlock(3, 4, 5, B.STONE);
    world.setBlock(3, 4, 5, B.DIRT);
    world.setBlock(-1, 10, -17, B.GLASS);
    expect(world.editVersion).toBe(3);
    expect(world.edits.get('0,0').get(localIndex(3, 4, 5))).toBe(B.DIRT);
    expect(world.edits.get('-1,-2').get(localIndex(15, 10, 15))).toBe(B.GLASS);
    expect(world.edits.get('0,0').size).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('dirty propagation (3×3 neighbour rule)', () => {
  it('an interior edit dirties exactly one chunk', () => {
    const { world } = makeWorld();
    converge(world);
    world.setBlock(8, 10, 8, B.STONE);
    expect(dirtyKeys(world)).toEqual(['0,0']);
  });

  it('an edge edit at lx=0 also dirties (-1,0) but nothing else', () => {
    const { world } = makeWorld();
    converge(world);
    world.setBlock(0, 10, 8, B.STONE);
    expect(dirtyKeys(world)).toEqual(['-1,0', '0,0'].sort());
  });

  it('an edge edit at lz=15 also dirties (0,1)', () => {
    const { world } = makeWorld();
    converge(world);
    world.setBlock(8, 10, 15, B.STONE);
    expect(dirtyKeys(world)).toEqual(['0,0', '0,1'].sort());
  });

  it('a corner edit at (15,·,15) dirties (0,0),(1,0),(0,1),(1,1)', () => {
    const { world } = makeWorld();
    converge(world);
    world.setBlock(15, 10, 15, B.STONE);
    expect(dirtyKeys(world)).toEqual(['0,0', '1,0', '0,1', '1,1'].sort());
  });

  it('a negative-coordinate corner edit dirties the right four chunks', () => {
    const { world } = makeWorld();
    converge(world);
    world.setBlock(-16, 10, -16, B.STONE); // local (0,·,0) of chunk (-1,-1)
    expect(dirtyKeys(world)).toEqual(['-1,-1', '-2,-1', '-1,-2', '-2,-2'].sort());
  });

  it('never treats vertical neighbours as other chunks', () => {
    const { world } = makeWorld();
    converge(world);
    world.setBlock(8, 0, 8, B.STONE);
    world.setBlock(8, WORLD_HEIGHT - 1, 8, B.STONE);
    expect(dirtyKeys(world)).toEqual(['0,0']);
  });

  it('only marks LOADED neighbours dirty (no allocation for missing ones)', () => {
    const { world } = makeWorld();
    converge(world);
    // Outer ring chunk at cx = renderDistance + DATA_RADIUS_EXTRA = 3; its +X neighbour (4, 0) is not loaded.
    const cx = world.renderDistance + DATA_RADIUS_EXTRA;
    expect(world.getChunk(cx, 0)).toBeDefined();
    expect(world.getChunk(cx + 1, 0)).toBeUndefined();
    expect(world.setBlock(cx * CHUNK_SIZE + 15, 10, 8, B.STONE)).toBe(true);
    expect(world.getChunk(cx, 0).dirty).toBe(true);
    expect(world.getChunk(cx, 0).meshed).toBe(false);
    expect(world.getChunk(cx + 1, 0)).toBeUndefined();
    expect(world.chunkCount).toBe(49);
    // Edit on the render-radius edge: the data-ring neighbour is marked but the meshed one is the only re-mesh.
    world.setBlock((cx - 1) * CHUNK_SIZE + 15, 10, 8, B.STONE);
    expect(dirtyKeys(world)).toEqual([chunkKey(cx - 1, 0)]);
    expect(world.getChunk(cx, 0).dirty).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe('update() streaming', () => {
  it('with radius 2 converges to 25 meshed chunks and 49 loaded; onChunkMesh once per chunk', () => {
    const { world, meshCalls } = makeWorld();
    const total = converge(world);
    expect(world.chunkCount).toBe(49);
    expect(total.generated).toBe(49);
    expect(total.meshed).toBe(25);
    expect(meshCalls.length).toBe(25);
    const keys = new Set(meshCalls.map((c) => c.key));
    expect(keys.size).toBe(25);
    for (const { key, cx, cz } of meshCalls) {
      expect(key).toBe(chunkKey(cx, cz));
      expect(cheb(cx, cz, 0, 0)).toBeLessThanOrEqual(2);
    }
    // Every chunk within the render radius is meshed and clean; the outer data ring is not meshed.
    let meshedCount = 0;
    for (const c of world.chunks.values()) {
      const d = cheb(c.cx, c.cz, 0, 0);
      expect(d).toBeLessThanOrEqual(2 + DATA_RADIUS_EXTRA);
      if (d <= 2) {
        expect(c.meshed).toBe(true);
        expect(c.dirty).toBe(false);
        meshedCount++;
      } else {
        expect(c.meshed).toBe(false);
      }
    }
    expect(meshedCount).toBe(25);
    expect(world.isReadyAt(0, 0)).toBe(true);
    expect(world.isReadyAt(-33, 33)).toBe(false); // chunk (-3,2): data ring only
  });

  it('isReadyAt / hasChunkAt distinguish meshed, data-only and missing chunks', () => {
    const { world } = makeWorld();
    converge(world);
    expect(world.isReadyAt(31, -32)).toBe(true);   // chunk (1,-2), radius 2
    expect(world.hasChunkAt(48, 0)).toBe(true);    // chunk (3,0), data ring only
    expect(world.isReadyAt(48, 0)).toBe(false);
    expect(world.hasChunkAt(64, 0)).toBe(false);   // chunk (4,0), not loaded
    expect(world.isReadyAt(64, 0)).toBe(false);
    expect(world.hasChunkAt(-1, -1)).toBe(true);
    expect(world.isReadyAt(-1, -1)).toBe(true);
  });

  it('returns the contract counters and generates nearest-first (RING_OFFSETS order)', () => {
    const order = [];
    const wg = trivialWorldGen();
    const base = wg.generateChunk;
    wg.generateChunk = (cx, cz) => {
      order.push([cx, cz]);
      return base(cx, cz);
    };
    const { world } = makeWorld({ worldGen: wg });
    const r = world.update(5, -5, Infinity);
    expect(Object.keys(r).sort()).toEqual(['generated', 'meshed', 'pendingGen', 'pendingMesh', 'unloaded'].sort());
    expect(r.generated).toBe(MAX_BUILDS_PER_UPDATE);
    expect(r.meshed).toBe(0);
    expect(r.unloaded).toBe(0);
    expect(r.pendingGen).toBe(49 - MAX_BUILDS_PER_UPDATE);
    expect(r.pendingMesh).toBe(25);
    // Player chunk is (0,-1): nearest first, ties broken by dz then dx ascending.
    expect(order).toEqual([[0, -1], [0, -2], [-1, -1], [1, -1], [0, 0], [-1, -2]]);
  });

  it('respects MAX_BUILDS_PER_UPDATE when the budget is Infinity', () => {
    const { world } = makeWorld();
    for (let i = 0; i < 20; i++) {
      const r = world.update(0, 0, Infinity);
      expect(r.generated + r.meshed).toBeLessThanOrEqual(MAX_BUILDS_PER_UPDATE);
      if (r.pendingGen === 0 && r.pendingMesh === 0) break;
      // §9.1 guarantee: at least one build per call while work is pending.
      expect(r.generated + r.meshed).toBeGreaterThanOrEqual(1);
    }
    expect(world.chunkCount).toBe(49);
  });

  it('does at least one build per call even with a zero budget, then stops', () => {
    let t = 0;
    const { world } = makeWorld({ now: () => (t += 10) });
    const r1 = world.update(0, 0, 5);
    expect(r1.generated + r1.meshed).toBe(1);
    const r2 = world.update(0, 0, 0);
    expect(r2.generated + r2.meshed).toBe(1);
    expect(world.chunkCount).toBe(2);
  });

  it('honours a time budget between builds', () => {
    let t = 0;
    // Each now() call advances 1 ms: start=1, then after each build the check reads 2, 3, ... → 3 builds at budget 3.
    const { world } = makeWorld({ now: () => ++t });
    const r = world.update(0, 0, 3);
    expect(r.generated + r.meshed).toBe(3);
  });

  it('repeated update at the same position does nothing', () => {
    const { world, meshCalls, unloadCalls } = makeWorld();
    converge(world);
    const meshBefore = meshCalls.length;
    for (let i = 0; i < 5; i++) {
      const r = world.update(3, 3, Infinity);
      expect(r).toEqual({ generated: 0, meshed: 0, unloaded: 0, pendingGen: 0, pendingMesh: 0 });
    }
    expect(meshCalls.length).toBe(meshBefore);
    expect(unloadCalls.length).toBe(0);
    expect(world.chunkCount).toBe(49);
  });

  it('moving within the same chunk does nothing either', () => {
    const { world } = makeWorld();
    converge(world);
    const r = world.update(15.9, -0.01, Infinity); // chunk (0,-1): one chunk north → some work
    expect(r.unloaded).toBe(0);
    converge(world, 15.9, -0.01);
    const r2 = world.update(0.5, -15.5, Infinity); // still chunk (0,-1)
    expect(r2).toEqual({ generated: 0, meshed: 0, unloaded: 0, pendingGen: 0, pendingMesh: 0 });
  });

  it('moving far away unloads every chunk, calling onChunkUnload exactly once per meshed chunk', () => {
    const { world, unloadCalls } = makeWorld();
    converge(world);
    const meshedKeys = [...world.chunks.values()].filter((c) => c.meshed).map((c) => c.key).sort();
    expect(meshedKeys.length).toBe(25);
    const r = world.update(10000, -10000, Infinity);
    expect(r.unloaded).toBe(49);
    expect(unloadCalls.length).toBe(25);
    expect([...unloadCalls].sort()).toEqual(meshedKeys);
    // Only chunks at the new location remain / get created.
    for (const c of world.chunks.values()) {
      expect(cheb(c.cx, c.cz, Math.floor(10000 / 16), Math.floor(-10000 / 16))).toBeLessThanOrEqual(3);
    }
    converge(world, 10000, -10000);
    expect(world.chunkCount).toBe(49);
    expect(unloadCalls.length).toBe(25);
  });

  it('unloads only beyond renderDistance + UNLOAD_RADIUS_EXTRA (hysteresis)', () => {
    const { world, unloadCalls } = makeWorld();
    converge(world);
    const unloadR = world.renderDistance + UNLOAD_RADIUS_EXTRA;
    // Move one chunk east: the western column at cx = -3 is now at distance 4 <= 5 → kept.
    let r = world.update(16, 0, Infinity);
    expect(r.unloaded).toBe(0);
    converge(world, 16, 0);
    expect(world.getChunk(-3, 0)).toBeDefined();
    // Move far enough that cx = -2 (meshed at the origin) is at distance unloadR + 1.
    const pcx = -2 + unloadR + 1;
    r = world.update(pcx * 16 + 8, 0, Infinity);
    expect(r.unloaded).toBeGreaterThan(0);
    expect(world.getChunk(-3, 0)).toBeUndefined();
    expect(world.getChunk(-2, 0)).toBeUndefined();
    expect(world.getChunk(-1, 0)).toBeDefined();
    for (const c of world.chunks.values()) expect(cheb(c.cx, c.cz, pcx, 0)).toBeLessThanOrEqual(unloadR);
    expect(unloadCalls).toContain('-2,0');
    expect(unloadCalls).not.toContain('-3,0');  // data-ring only chunk, never meshed
    expect(unloadCalls).not.toContain('-3,-3');
  });

  it('meshes a chunk only once all 8 neighbours exist, so generation never invalidates a mesh', () => {
    const { world, meshCalls } = makeWorld();
    const seenMeshed = new Set();
    let ok = true;
    for (let i = 0; i < 100; i++) {
      const before = meshCalls.length;
      const r = world.update(0, 0, Infinity);
      for (let j = before; j < meshCalls.length; j++) {
        const { cx, cz, key } = meshCalls[j];
        if (seenMeshed.has(key)) ok = false; // re-meshed without an edit
        seenMeshed.add(key);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (!world.getChunk(cx + dx, cz + dz)) ok = false;
      }
      if (r.pendingGen === 0 && r.pendingMesh === 0) break;
    }
    expect(ok).toBe(true);
    expect(seenMeshed.size).toBe(25);
  });

  it('mesh data for a flat world is non-empty and chunk-local', () => {
    const { world, meshes } = makeWorld({ worldGen: flatWorldGen(4), renderDistance: 1 });
    converge(world);
    const m = meshes.get('0,0');
    expect(m).toBeDefined();
    expect(countFaces(m)).toBe(CHUNK_SIZE * CHUNK_SIZE); // 256 top faces; sides hidden by neighbours, bottom by bedrock rule
    expect(m.cutout).toBeNull();
    expect(m.translucent).toBeNull();
    for (let i = 0; i < m.opaque.positions.length; i += 3) {
      expect(m.opaque.positions[i]).toBeGreaterThanOrEqual(0);
      expect(m.opaque.positions[i]).toBeLessThanOrEqual(16);
      expect(m.opaque.positions[i + 1]).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('edits, re-meshing and persistence', () => {
  it('an edit re-meshes the chunk on the next update and the new mesh has the extra faces', () => {
    const { world, meshCalls, meshes } = makeWorld({ worldGen: flatWorldGen(4) });
    converge(world);
    const before = meshCalls.length;
    expect(countFaces(meshes.get('0,0'))).toBe(256);
    expect(world.setBlock(8, 10, 8, B.STONE)).toBe(true);
    expect(world.getChunk(0, 0).dirty).toBe(true);
    expect(world.isReadyAt(8, 8)).toBe(false);
    const r = world.update(0, 0, Infinity);
    expect(r.meshed).toBe(1);
    expect(r.generated).toBe(0);
    expect(meshCalls.length).toBe(before + 1);
    expect(meshCalls[before].key).toBe('0,0');
    expect(world.isReadyAt(8, 8)).toBe(true);
    const m = meshes.get('0,0');
    expect(countFaces(m)).toBe(256 + 6); // floating stone: all six faces visible
    expect(m.opaque).not.toBeNull();
    expect(m.opaque.faceCount).toBe(262);
  });

  it('a placed STONE in an empty world produces a mesh with faces; breaking it empties the mesh', () => {
    const { world, meshes } = makeWorld({ renderDistance: 1 });
    converge(world);
    expect(meshes.get('0,0')).toEqual({ opaque: null, cutout: null, translucent: null });
    world.setBlock(5, 20, 5, B.STONE);
    world.update(0, 0, Infinity);
    expect(countFaces(meshes.get('0,0'))).toBe(6);
    world.setBlock(5, 20, 5, B.AIR);
    world.update(0, 0, Infinity);
    expect(countFaces(meshes.get('0,0'))).toBe(0);
    expect(world.editVersion).toBe(2);
  });

  it('re-meshes ALL dirty meshed chunks immediately, ignoring the budget (§9.1 step 2)', () => {
    let t = 0;
    const { world, meshCalls } = makeWorld({ now: () => (t += 10) });
    converge(world);
    const before = meshCalls.length;
    world.setBlock(15, 10, 15, B.STONE);
    expect(dirtyKeys(world).length).toBe(4);
    const r = world.update(0, 0, 0);
    expect(r.meshed).toBe(4);
    expect(r.generated).toBe(0);
    expect(r.pendingMesh).toBe(0);
    expect(meshCalls.slice(before).map((c) => c.key).sort()).toEqual(['0,0', '1,0', '0,1', '1,1'].sort());
    expect(dirtyKeys(world)).toEqual([]);
  });

  it('cross-border culling: STONE at (16,10,0) hides the +X face of STONE at (15,10,0)', () => {
    const { world, meshes } = makeWorld({ renderDistance: 1 });
    converge(world);
    world.setBlock(15, 10, 0, B.STONE);
    world.setBlock(16, 10, 0, B.STONE);
    expect(dirtyKeys(world)).toEqual(['0,-1', '0,0', '1,-1', '1,0'].sort());
    world.update(0, 0, Infinity);
    expect(countFaces(meshes.get('0,0'))).toBe(5);
    expect(countFaces(meshes.get('1,0'))).toBe(5);
    expect(dirtyKeys(world)).toEqual([]);
  });

  it('edits survive unload → reload', () => {
    const { world, meshes } = makeWorld();
    converge(world);
    expect(world.setBlock(-1, 10, -17, B.STONE)).toBe(true);
    expect(world.setBlock(3, 4, 5, B.GLASS)).toBe(true);
    converge(world);
    world.update(10000, 10000, Infinity);
    expect(world.getChunk(-1, -2)).toBeUndefined();
    expect(world.getBlock(-1, 10, -17)).toBe(B.AIR); // not loaded
    expect(world.edits.get('-1,-2').get(localIndex(15, 10, 15))).toBe(B.STONE);
    converge(world, 10000, 10000);
    meshes.clear();
    converge(world, 0, 0);
    expect(world.getBlock(-1, 10, -17)).toBe(B.STONE);
    expect(world.getBlock(3, 4, 5)).toBe(B.GLASS);
    expect(world.getChunk(-1, -2).get(15, 10, 15)).toBe(B.STONE);
    // The regenerated chunk was meshed with the edit already applied.
    expect(countFaces(meshes.get('-1,-2'))).toBe(6);
    expect(countFaces(meshes.get('0,0'))).toBe(6);
  });

  it('edits are applied before the chunk becomes visible to getBlock', () => {
    const wg = trivialWorldGen();
    const { world } = makeWorld({ worldGen: wg, edits: { '0,0': [localIndex(1, 2, 3), B.SAND] } });
    let sawSand = null;
    const base = wg.generateChunk;
    wg.generateChunk = (cx, cz) => {
      if (cx === 0 && cz === 0) sawSand = world.getBlock(1, 2, 3); // during generation: still unloaded → AIR
      return base(cx, cz);
    };
    world.update(0, 0, Infinity);
    expect(sawSand).toBe(B.AIR);
    expect(world.getBlock(1, 2, 3)).toBe(B.SAND);
  });

  it('exportEdits produces flat pairs keyed by chunk and skips empty entries', () => {
    const { world } = makeWorld();
    converge(world);
    world.setBlock(-1, 10, -17, B.STONE);
    world.setBlock(3, 4, 5, B.GLASS);
    world.setBlock(3, 4, 5, B.DIRT);
    world.setBlock(4, 4, 5, B.GLASS);
    const json = world.exportEdits();
    expect(Object.keys(json).sort()).toEqual(['-1,-2', '0,0'].sort());
    expect(json['-1,-2']).toEqual([localIndex(15, 10, 15), B.STONE]);
    expect(json['0,0'].length).toBe(4);
    const pairs = new Map();
    for (let i = 0; i < json['0,0'].length; i += 2) pairs.set(json['0,0'][i], json['0,0'][i + 1]);
    expect(pairs.get(localIndex(3, 4, 5))).toBe(B.DIRT);
    expect(pairs.get(localIndex(4, 4, 5))).toBe(B.GLASS);
    // JSON-safe and detached from the internal map.
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    json['0,0'].push(1, 1);
    expect(world.edits.get('0,0').size).toBe(2);
    expect(new World({ seed: 1, worldGen: trivialWorldGen(), now: () => 0 }).exportEdits()).toEqual({});
  });

  it('exportEdits → new World({ edits }) roundtrip reproduces the blocks', () => {
    const a = makeWorld().world;
    converge(a);
    a.setBlock(-1, 10, -17, B.STONE);
    a.setBlock(3, 4, 5, B.GLASS);
    a.setBlock(31, 0, -33, B.BRICKS);
    const json = JSON.parse(JSON.stringify(a.exportEdits()));

    const b = makeWorld({ edits: json }).world;
    expect(b.editVersion).toBe(0);
    expect(b.exportEdits()).toEqual(json);
    converge(b);
    expect(b.getBlock(-1, 10, -17)).toBe(B.STONE);
    expect(b.getBlock(3, 4, 5)).toBe(B.GLASS);
    expect(b.getBlock(31, 0, -33)).toBe(B.BRICKS);
  });

  it('importEdits merges (last write wins) and applies to loaded chunks, marking them dirty', () => {
    const { world } = makeWorld();
    converge(world);
    world.setBlock(3, 4, 5, B.GLASS);
    converge(world);
    expect(dirtyKeys(world)).toEqual([]);
    world.importEdits({
      '0,0': [localIndex(3, 4, 5), B.DIRT, localIndex(0, 7, 0), B.SAND],
      '-1,-2': [localIndex(15, 10, 15), B.STONE],
      '50,50': [localIndex(1, 1, 1), B.STONE], // not loaded: stored only
    });
    expect(world.getBlock(3, 4, 5)).toBe(B.DIRT);
    expect(world.getBlock(0, 7, 0)).toBe(B.SAND);
    expect(world.getBlock(-1, 10, -17)).toBe(B.STONE);
    expect(world.edits.get('50,50').get(localIndex(1, 1, 1))).toBe(B.STONE);
    expect(world.chunkCount).toBe(49);
    // Loaded, edited chunks are dirty (the edge edit at lx=0 also dirties (-1,0)).
    const dirty = dirtyKeys(world);
    expect(dirty).toContain('0,0');
    expect(dirty).toContain('-1,-2');
    expect(dirty).toContain('-1,0');
    const r = world.update(0, 0, Infinity);
    expect(r.meshed).toBe(dirty.length);
    expect(dirtyKeys(world)).toEqual([]);
    // Roundtrip includes merged entries.
    const json = world.exportEdits();
    expect(json['50,50']).toEqual([localIndex(1, 1, 1), B.STONE]);
    expect(json['0,0']).toContain(B.DIRT);
  });

  it('importEdits ignores malformed entries and returns unchanged state for empty input', () => {
    const { world } = makeWorld();
    converge(world);
    world.importEdits(null);
    world.importEdits(undefined);
    world.importEdits({});
    world.importEdits({
      '0,0': [CHUNK_VOLUME, B.STONE, -1, B.STONE, localIndex(1, 1, 1), 999, localIndex(2, 2, 2), 1.5, 'x', 1, localIndex(3, 3, 3)],
      'garbage': [1, 2],
      '1,1': 'nope',
      '2,2': [localIndex(4, 4, 4), B.STONE],
    });
    expect(world.edits.has('0,0')).toBe(false);
    expect(world.edits.has('garbage')).toBe(false);
    expect(world.edits.has('1,1')).toBe(false);
    expect(world.getBlock(4 + 32, 4, 4 + 32)).toBe(B.STONE);
    expect(world.exportEdits()).toEqual({ '2,2': [localIndex(4, 4, 4), B.STONE] });
  });
});

// ---------------------------------------------------------------------------------------------

describe('spawn, surface, biome', () => {
  it('findSpawn returns the first valid column of the 4-block spiral, centred', () => {
    const { world } = makeWorld({ worldGen: flatWorldGen(70) });
    expect(world.findSpawn()).toEqual([0.5, 71, 0.5]);
  });

  it('findSpawn skips ocean/beach/low columns and steps in multiples of 4', () => {
    const wg = trivialWorldGen();
    const asked = [];
    wg.getColumn = (x, z) => {
      asked.push([x, z]);
      if (x === 8 && z === 4) return { height: 80, biome: BIOME.FOREST, temperature: 0, humidity: 0 };
      if (x === 4 && z === 0) return { height: 80, biome: BIOME.BEACH, temperature: 0, humidity: 0 }; // wrong biome
      if (x === 0 && z === 4) return { height: SEA_LEVEL + 1, biome: BIOME.PLAINS, temperature: 0, humidity: 0 }; // too low
      return { height: 50, biome: BIOME.OCEAN, temperature: 0, humidity: 0 };
    };
    const { world } = makeWorld({ worldGen: wg });
    expect(world.findSpawn()).toEqual([8.5, 81, 4.5]);
    expect(asked[0]).toEqual([0, 0]);
    for (const [x, z] of asked) {
      expect(Math.abs(x % 4)).toBe(0);
      expect(Math.abs(z % 4)).toBe(0);
    }
    // Nearest ring first: nothing at Chebyshev radius 12+ was asked before the hit at radius 8.
    for (const [x, z] of asked) expect(Math.max(Math.abs(x), Math.abs(z))).toBeLessThanOrEqual(8);
  });

  it('findSpawn terminates with a sane fallback when no column is ever valid', () => {
    const { world } = makeWorld(); // trivialWorldGen: height 0 everywhere
    const s = world.findSpawn();
    expect(s.length).toBe(3);
    for (const v of s) expect(Number.isFinite(v)).toBe(true);
    expect(s[1]).toBeGreaterThan(SEA_LEVEL);
    expect(s[1]).toBeLessThan(WORLD_HEIGHT);
  });

  it('findSpawn does not load chunks', () => {
    const { world } = makeWorld({ worldGen: flatWorldGen(70) });
    world.findSpawn();
    expect(world.chunkCount).toBe(0);
  });

  it('getSurfaceHeight and getBiome come from worldGen.getColumn and ignore edits', () => {
    const { world } = makeWorld({ worldGen: flatWorldGen(4) });
    expect(world.getSurfaceHeight(0, 0)).toBe(4);
    expect(world.getSurfaceHeight(-1000, 1000)).toBe(4);
    expect(world.getBiome(0, 0)).toBe(BIOME.PLAINS);
    converge(world);
    world.setBlock(0, 10, 0, B.STONE);
    expect(world.getSurfaceHeight(0, 0)).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------

describe('setRenderDistance and dispose', () => {
  it('clamps to 1..16 and changes the streaming footprint', () => {
    const { world } = makeWorld({ renderDistance: 1 });
    converge(world);
    expect(world.chunkCount).toBe(9 + 16); // 3×3 meshed + data ring → 5×5
    world.setRenderDistance(0);
    expect(world.renderDistance).toBe(1);
    world.setRenderDistance(100);
    expect(world.renderDistance).toBe(16);
    world.setRenderDistance(2);
    expect(world.renderDistance).toBe(2);
    const total = converge(world);
    expect(world.chunkCount).toBe(49);
    expect(total.generated).toBe(49 - 25);
    expect(total.meshed).toBe(25 - 9);
  });

  it('shrinking the render distance unloads chunks beyond the new unload radius on the next update', () => {
    const { world, unloadCalls } = makeWorld({ renderDistance: 4 });
    converge(world);
    expect(world.chunkCount).toBe(11 * 11);
    world.setRenderDistance(1);
    const r = world.update(0, 0, Infinity);
    const keep = 1 + UNLOAD_RADIUS_EXTRA; // 4 → 9×9 remain
    expect(r.unloaded).toBe(121 - 81);
    expect(world.chunkCount).toBe(81);
    for (const c of world.chunks.values()) expect(cheb(c.cx, c.cz, 0, 0)).toBeLessThanOrEqual(keep);
    // The 40 dropped chunks were the data ring at radius 5, never meshed → no unload hooks.
    expect(unloadCalls.length).toBe(0);
    // A second shrink-and-move does drop meshed chunks.
    world.setRenderDistance(1);
    world.update(10 * 16, 0, Infinity);
    expect(unloadCalls.length).toBeGreaterThan(0);
    expect(new Set(unloadCalls).size).toBe(unloadCalls.length);
  });

  it('dispose removes all chunks and fires onChunkUnload only for meshed ones', () => {
    const { world, unloadCalls } = makeWorld();
    converge(world);
    world.dispose();
    expect(world.chunkCount).toBe(0);
    expect(world.chunks.size).toBe(0);
    expect(unloadCalls.length).toBe(25);
    expect(new Set(unloadCalls).size).toBe(25);
    expect(world.getBlock(0, 0, 0)).toBe(B.AIR);
    // Edits are kept; the world remains usable.
    world.dispose();
    expect(unloadCalls.length).toBe(25);
    converge(world);
    expect(world.chunkCount).toBe(49);
  });

  it('uses the injected worldGen output arrays as-is (no copy)', () => {
    const data = makeChunkData();
    const wg = { seed: 1, getColumn: () => ({ height: 0, biome: 2, temperature: 0, humidity: 0 }), generateChunk: () => data };
    const { world } = makeWorld({ worldGen: wg, renderDistance: 1 });
    world.update(0, 0, 0);
    const c = [...world.chunks.values()][0];
    expect(c.blocks).toBe(data.blocks);
  });
});
