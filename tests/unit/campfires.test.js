// Unit tests for src/campfires.js and the campfire's block / mesher / pig rules (CONTRACTS §32).
import { describe, it, expect } from 'vitest';
import { BLOCK, BLOCKS, TILE, getFaceTile, isSolid, isOpaque, isPlaceable, isBreakable, isTargetable, isMeshed, FACE_TOP } from '../../src/blocks.js';
import { CAMPFIRE_MAX_TRACKED } from '../../src/config.js';
import { Campfires, campfireKey, flicker } from '../../src/campfires.js';
import { forEachEditedCell, localIndex, chunkKey } from '../../src/coords.js';
import { hexToWorld } from '../../src/hex.js';
import { buildChunkMesh } from '../../src/mesher.js';
import { World } from '../../src/world.js';
import { Pigs, seededRng } from '../../src/pigs.js';
import { makeChunkDataGetter, setWorldBlock, countFaces, flatWorldGen } from '../helpers/fixtures.js';

const B = BLOCK;

describe('campfire block', () => {
  it('is a placeable, breakable, targetable, non-solid block drawn by its own model', () => {
    const d = BLOCKS[B.CAMPFIRE];
    expect(d.name).toBe('campfire');
    expect(d.displayName).toBe('Campfire');
    expect(isSolid(B.CAMPFIRE)).toBe(false);
    expect(isOpaque(B.CAMPFIRE)).toBe(false);
    expect(isPlaceable(B.CAMPFIRE)).toBe(true);
    expect(isBreakable(B.CAMPFIRE)).toBe(true);
    expect(isTargetable(B.CAMPFIRE)).toBe(true);
    expect(isMeshed(B.CAMPFIRE)).toBe(false);
    expect(getFaceTile(B.CAMPFIRE, 0)).toBe(TILE.CAMPFIRE_SIDE);
    expect(getFaceTile(B.CAMPFIRE, FACE_TOP)).toBe(TILE.CAMPFIRE_TOP);
    // Every other block is meshed as before.
    expect(BLOCKS.filter((b) => !b.meshed).map((b) => b.name)).toEqual(['campfire']);
  });
  it('the mesher skips the campfire cell but still draws the ground under it', () => {
    const chunks = new Map();
    setWorldBlock(chunks, 4, 10, 4, B.STONE);
    const ground = countFaces(buildChunkMesh(0, 0, makeChunkDataGetter(chunks)));
    setWorldBlock(chunks, 4, 11, 4, B.CAMPFIRE);
    expect(countFaces(buildChunkMesh(0, 0, makeChunkDataGetter(chunks)))).toBe(ground);
    // A solid block in the same place would hide the ground's top and add its own seven faces.
    setWorldBlock(chunks, 4, 11, 4, B.STONE);
    expect(countFaces(buildChunkMesh(0, 0, makeChunkDataGetter(chunks)))).toBe(ground - 1 + 7);
  });
});

describe('flicker', () => {
  it('stays within [0.75, 1.25], averages ~1, varies, and is deterministic per seed', () => {
    let sum = 0;
    let lo = Infinity;
    let hi = -Infinity;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const v = flicker(i * 0.01, 1.3);
      sum += v;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThanOrEqual(0.75);
    expect(hi).toBeLessThanOrEqual(1.25);
    expect(hi - lo).toBeGreaterThan(0.2);
    expect(sum / N).toBeCloseTo(1, 2);
    expect(flicker(3.7, 2)).toBe(flicker(3.7, 2));
    expect(flicker(3.7, 2)).not.toBe(flicker(3.7, 4));
  });
});

describe('Campfires tracking', () => {
  it('follows onBlockChange and stores the cell floor centre', () => {
    const c = new Campfires();
    c.onBlockChange(2, 30, -1, B.AIR, B.CAMPFIRE);
    expect(c.size).toBe(1);
    const [x, z] = hexToWorld(2, -1);
    expect(c.fires.get(campfireKey(2, 30, -1))).toMatchObject({ q: 2, y: 30, r: -1, x, z });
    expect(c.has(2, 30, -1)).toBe(true);
    c.onBlockChange(2, 30, -1, B.CAMPFIRE, B.AIR);
    expect(c.size).toBe(0);
    c.onBlockChange(0, 0, 0, B.AIR, B.STONE);
    expect(c.size).toBe(0);
  });
  it('caps the tracked set at CAMPFIRE_MAX_TRACKED', () => {
    const c = new Campfires();
    for (let i = 0; i < CAMPFIRE_MAX_TRACKED + 3; i++) c.add(i, 5, 0);
    expect(c.size).toBe(CAMPFIRE_MAX_TRACKED);
  });
  it('gives neighbouring fires different flicker phases', () => {
    const c = new Campfires();
    c.add(0, 10, 0);
    c.add(1, 10, 0);
    const [a, b] = [...c.fires.values()];
    expect(a.seed).not.toBe(b.seed);
    expect(a.seed).toBeGreaterThanOrEqual(0);
    expect(a.seed).toBeLessThan(Math.PI * 2);
  });
  it('nearest returns fires within range, nearest first, limited', () => {
    const c = new Campfires();
    c.add(0, 10, 0);
    c.add(5, 10, 0);
    c.add(2, 10, 0);
    c.add(40, 10, 0);
    const near = c.nearest(0, 10.3, 0, 10);
    expect(near.map((n) => n.fire.q)).toEqual([0, 2, 5]);
    expect(near[0].dist).toBeCloseTo(0, 9);
    expect(c.nearest(0, 10.3, 0, 10, 2).map((n) => n.fire.q)).toEqual([0, 2]);
  });
  it('loadFromEdits (via forEachEditedCell) restores campfires from a saved world', () => {
    const w = new World({ worldGen: flatWorldGen(10), renderDistance: 1 });
    w.update(0, 0, 1e9);
    w.setBlock(-3, 11, 2, B.CAMPFIRE);
    w.setBlock(1, 11, 1, B.STONE);
    const w2 = new World({ worldGen: flatWorldGen(10), renderDistance: 1, edits: w.exportEdits() });
    const c = new Campfires();
    c.add(50, 50, 50);
    c.loadFromEdits(w2.edits);
    expect([...c.fires.keys()]).toEqual(['-3,11,2']);
  });
  it('forEachEditedCell skips malformed chunk keys and other ids', () => {
    const edits = new Map([
      [chunkKey(1, -1), new Map([[localIndex(2, 7, 3), B.CAMPFIRE], [localIndex(0, 0, 0), B.DIRT]])],
      ['nonsense', new Map([[0, B.CAMPFIRE]])],
    ]);
    const seen = [];
    forEachEditedCell(edits, B.CAMPFIRE, (q, y, r) => seen.push([q, y, r]));
    expect(seen).toEqual([[16 + 2, 7, -16 + 3]]);
  });
});

describe('pigs and fire', () => {
  const GROUND = 10;
  it('a wandering pig never walks into a campfire', () => {
    // A ring of campfires at hex distance 3 around the pig.
    const fire = (q, r) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) === 3;
    const getBlock = (q, y, r) => (y < GROUND ? B.STONE : y === GROUND && fire(q, r) ? B.CAMPFIRE : B.AIR);
    for (let seed = 1; seed <= 4; seed++) {
      const pigs = new Pigs(seededRng(seed));
      pigs.spawn(0, GROUND, 0);
      for (let i = 0; i < 60 * 40; i++) {
        pigs.update(1 / 60, { getBlock, isLoaded: () => true });
        expect(pigs.scorched, `seed ${seed}`).toEqual([]);
      }
    }
  });
  it('a pig standing in a campfire yelps and jumps out, away from it', () => {
    const getBlock = (q, y, r) => (y < GROUND ? B.STONE : y === GROUND && q === 0 && r === 0 ? B.CAMPFIRE : B.AIR);
    const pigs = new Pigs(seededRng(1));
    const pig = pigs.spawn(0.2, GROUND, 0);
    pigs.update(1 / 60, { getBlock, isLoaded: () => true });
    expect(pigs.scorched).toEqual([pig]);
    expect(pig.vx).toBeGreaterThan(0);
    expect(pig.vy).toBeGreaterThan(0);
    expect(pig.mode).toBe('flee');
    for (let i = 0; i < 120; i++) pigs.update(1 / 60, { getBlock, isLoaded: () => true });
    expect(Math.hypot(pig.x, pig.z)).toBeGreaterThan(0.9);
  });
});
