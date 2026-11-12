// Tests for generation 3's water (CONTRACTS §76 water): streams — where they run, how high their water stands, what the
// generated chunks hold, that they are AT REST for the real fluid rule — and tainted ponds. Tainted water itself (the
// block, drinking, pots) is in taintedWater.test.js. Everything is derived from fixed seeds: the suite is deterministic.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL, GEN_LATEST } from '../../src/config.js';
import { localIndex, floorDiv } from '../../src/coords.js';
import { HEX_DIRS, hexLength, hexToWorld } from '../../src/hex.js';
import { BLOCK, BIOME, isSolid, isWater, isLog, getBlockDef } from '../../src/blocks.js';
import { hash2, mulberry32 } from '../../src/noise.js';
import {
  createWorldGen, POND_CELL, POND_SALT, TREE_CELL, POND_TAINTED_SHARE, STREAM_CELL, STREAM_CHANCE, STREAM_ASCENT,
  STREAM_MAX_LEN, STREAM_MIN_LEN, STREAM_REACH, STREAM_SPRING_MIN_HEIGHT, STREAM_SPRING_MAX_HEIGHT, STREAM_MARGIN,
  STREAM_MAP_SIDE, streamBottom, stampStreams,
} from '../../src/worldgen.js';
import { World } from '../../src/world.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { waterQualityAt } from '../../src/fluids.js';
import { attachPhysics, makeFakeWorld } from '../helpers/fixtures.js';

const B = BLOCK;
const SEED = 'caelancraft-test';
const gen3 = createWorldGen(SEED, { gen: 3 });
const gen2 = createWorldGen(SEED, { gen: 2 });

/** Cached chunks of SEED per generation. */
const chunkCache = new Map();
function chunkOf(g, cq, cr) {
  const key = `${g.gen}:${cq},${cr}`;
  let c = chunkCache.get(key);
  if (!c) {
    c = g.generateChunk(cq, cr);
    chunkCache.set(key, c);
  }
  return c;
}
/** Block (q, y, r) of generation `g`'s world, straight from its chunk. */
function blockAt(g, q, y, r) {
  const cq = floorDiv(q, CHUNK_SIZE);
  const cr = floorDiv(r, CHUNK_SIZE);
  return chunkOf(g, cq, cr).blocks[localIndex(q - cq * CHUNK_SIZE, y, r - cr * CHUNK_SIZE)];
}

/** The scan: stream levels of SEED over −HALF ≤ q, r < HALF (built once; `streamLevelAt` is a map lookup per column). */
const HALF = 320;
const SIDE = 2 * HALF;
let scanCache = null;
function scan() {
  if (scanCache) return scanCache;
  const levels = new Int16Array(SIDE * SIDE);
  /** @type {[number, number, number][]} */
  const columns = [];
  for (let q = -HALF; q < HALF; q++) {
    for (let r = -HALF; r < HALF; r++) {
      const level = gen3.streamLevelAt(q, r);
      levels[(q + HALF) * SIDE + r + HALF] = level;
      if (level >= 0) columns.push([q, r, level]);
    }
  }
  const levelAt = (q, r) => (q >= -HALF && q < HALF && r >= -HALF && r < HALF ? levels[(q + HALF) * SIDE + r + HALF] : gen3.streamLevelAt(q, r));
  scanCache = { columns, levelAt };
  return scanCache;
}

/** The stream model of a column (rule 3): its lowest water cell — one below the lowest lower stream neighbour, else its level. */
function bottomOf(levelAt, q, r) {
  const level = levelAt(q, r);
  let low = level;
  for (const [dq, dr] of HEX_DIRS) {
    const n = levelAt(q + dq, r + dr);
    if (n >= 0 && n < low) low = n;
  }
  return low < level ? low - 1 : level;
}

/** The accepted pond centres of pond-grid cells kq, kr in [k0, k1]. */
function pondCentres(g, k0, k1) {
  const out = [];
  for (let kq = k0; kq <= k1; kq++) {
    for (let kr = k0; kr <= k1; kr++) {
      const h = hash2(kq, kr, g.seed ^ POND_SALT);
      const q = kq * POND_CELL + 2 + (h & 7);
      const r = kr * POND_CELL + 2 + ((h >>> 3) & 7);
      if (g.pondAt(q, r)) out.push({ kq, kr, q, r, H: g.getColumn(q, r).height, biome: g.getColumn(q, r).biome });
    }
  }
  return out;
}

function digest(d) {
  return createHash('sha256').update(d.blocks).update(d.biomes).update(d.heights).digest('hex').slice(0, 32);
}

describe('generations 1 and 2 are untouched', () => {
  it('generation 2 is byte-identical to the generator before §76 (checksums pinned on the foundation commit)', () => {
    const PINNED = [
      ['caelancraft-test', 0, 0, '4510e63fb637083d0998fd9fd459a9cf'], ['caelancraft-test', 1, 0, 'db12dbcce2ac32553508e81150d07c4c'],
      ['caelancraft-test', -1, 2, 'eb0f8cd3f9d27094e3c3d00dd608f583'], ['caelancraft-test', 3, -4, 'c54e9860a07d42c2b602466e4fa7209c'],
      ['caelancraft-test', -2, -2, 'c691db6c7ec6347a239336fd8aae9f11'], ['caelancraft-test', 5, 5, 'c2ffd6f0f162d305d651c79e3fcef0cd'],
      ['caelancraft-test', 12, -7, 'eb80a50525bcd64ee2ae5cb40eeb965c'], [1, 0, 0, 'acc37e329ed491c194a565398413840a'],
      [1, -3, 1, 'e2ec2199da3f5ff1a75e47212921f906'], [1, 2, 2, '7f36e867dccccac20f2ac083182fb0f0'],
      ['survival', 0, 0, 'bd593b26c757262af8a5dd9bf3234991'], ['survival', 4, -1, '61ffb065d621ba30dda920f8e9c46b63'],
      [4242, 0, 0, 'd03ff4a0714f48a810bc4bf2cb8343d1'], [4242, -6, 3, '411334db08006ae55495520921bf9f0a'],
    ];
    for (const [seed, cq, cr, sum] of PINNED) {
      expect(digest(createWorldGen(seed, { gen: 2 }).generateChunk(cq, cr)), `${seed} ${cq},${cr}`).toBe(sum);
    }
  });

  it('streams and tainted ponds exist only in generation 3: below it streamAt is false everywhere and no chunk holds either', () => {
    expect(GEN_LATEST).toBe(3);
    expect(gen3.gen).toBe(3);
    const { columns } = scan();
    expect(columns.length).toBeGreaterThan(500);
    const gen1 = createWorldGen(SEED);
    for (const g of [gen1, gen2]) {
      for (const [q, r] of columns) {
        if (g.streamAt(q, r) || g.streamLevelAt(q, r) !== -1 || g.pondTaintedAt(q, r)) throw new Error(`generation ${g.gen} has a stream at ${q},${r}`);
      }
    }
    // The chunks around the first few stream columns, in generation 2: no falling water, no tainted water — and the
    // column that is a stream in generation 3 is plain land there.
    for (const [q, r, level] of columns.filter((_, i) => i % 97 === 0)) {
      const c2 = chunkOf(gen2, floorDiv(q, CHUNK_SIZE), floorDiv(r, CHUNK_SIZE));
      if (c2.blocks.includes(B.WATER_FALL) || c2.blocks.includes(B.TAINTED_WATER)) throw new Error(`generation 2 chunk of ${q},${r} holds generation-3 water`);
      expect(blockAt(gen3, q, level, r)).toBe(B.WATER);
      expect(isSolid(blockAt(gen2, q, level, r)), `${q},${r}`).toBe(true);
    }
  });
});

describe('streams: where they run (rule 1)', () => {
  it('the constants', () => {
    expect([STREAM_CELL, STREAM_CHANCE, STREAM_ASCENT, STREAM_MAX_LEN, STREAM_MIN_LEN]).toEqual([48, 0.5, 12, 64, 10]);
    expect(STREAM_REACH).toBe(STREAM_ASCENT + STREAM_MAX_LEN + 1);
    expect(STREAM_SPRING_MIN_HEIGHT).toBe(SEA_LEVEL + 3);
    expect(STREAM_SPRING_MAX_HEIGHT).toBe(83); // below BIOME.MOUNTAINS (height ≥ 84)
  });

  it('streamAt and streamLevelAt are pure: a fresh generator asked in another order, after other work, answers the same', () => {
    const { columns, levelAt } = scan();
    const other = createWorldGen(SEED, { gen: 3 });
    other.generateChunk(40, -40); // far away first
    other.streamAt(5000, -7000);
    const rng = mulberry32(11);
    for (let i = 0; i < 4000; i++) {
      const q = Math.floor(rng() * SIDE) - HALF;
      const r = Math.floor(rng() * SIDE) - HALF;
      const want = levelAt(q, r);
      if (other.streamLevelAt(q, r) !== want || other.streamAt(q, r) !== (want >= 0)) throw new Error(`streamLevelAt(${q}, ${r}) differs`);
    }
    for (const [q, r, level] of columns) if (other.streamLevelAt(q, r) !== level) throw new Error(`stream column ${q},${r} differs`);
    // junk never throws and is never a stream
    for (const bad of [NaN, 1.5, Infinity, '3', null, undefined]) {
      expect(gen3.streamAt(/** @type {*} */ (bad), 0)).toBe(false);
      expect(gen3.streamLevelAt(0, /** @type {*} */ (bad))).toBe(-1);
    }
    // another seed has other streams
    const elsewhere = createWorldGen('another-seed', { gen: 3 });
    expect(columns.filter(([q, r]) => elsewhere.streamAt(q, r)).length).toBeLessThan(columns.length / 10);
  });

  it('a stream is a connected ribbon of at least STREAM_MIN_LEN columns, on land, starting on higher ground', () => {
    const { columns, levelAt } = scan();
    // flood the scan into connected components (side neighbours)
    const seen = new Set();
    const comps = [];
    for (const [q0, r0] of columns) {
      if (seen.has(`${q0},${r0}`)) continue;
      const comp = [];
      const todo = [[q0, r0]];
      seen.add(`${q0},${r0}`);
      while (todo.length > 0) {
        const [q, r] = todo.pop();
        comp.push([q, r]);
        for (const [dq, dr] of HEX_DIRS) {
          const key = `${q + dq},${r + dr}`;
          if (seen.has(key) || levelAt(q + dq, r + dr) < 0) continue;
          seen.add(key);
          todo.push([q + dq, r + dr]);
        }
      }
      comps.push(comp);
    }
    expect(comps.length).toBeGreaterThan(40);
    let longest = 0;
    for (const comp of comps) {
      const inside = comp.every(([q, r]) => Math.abs(q) < HALF - STREAM_REACH && Math.abs(r) < HALF - STREAM_REACH);
      if (!inside) continue; // cut by the edge of the scan
      expect(comp.length, `stream at ${comp[0]}`).toBeGreaterThanOrEqual(STREAM_MIN_LEN);
      longest = Math.max(longest, comp.length);
      // every column is land, and its water is at or above the sea
      let top = null;
      for (const [q, r] of comp) {
        const col = gen3.getColumn(q, r);
        expect(col.height).toBeGreaterThanOrEqual(SEA_LEVEL);
        expect(levelAt(q, r)).toBeGreaterThanOrEqual(SEA_LEVEL);
        if (top === null || col.height > top.height) top = col;
      }
      // the highest ground of the ribbon is a spring: plains, forest or snowy land between the beaches and the rock
      expect([BIOME.PLAINS, BIOME.FOREST, BIOME.SNOWY]).toContain(top.biome);
      expect(top.height).toBeGreaterThanOrEqual(STREAM_SPRING_MIN_HEIGHT);
      expect(top.height).toBeLessThanOrEqual(STREAM_SPRING_MAX_HEIGHT);
    }
    expect(longest).toBeGreaterThan(40);
  });

  it('density: from plains and forest a stream is usually within 60 columns, but not at every step', () => {
    const { columns, levelAt } = scan();
    // Stream columns are a small share of the land …
    const share = columns.length / (SIDE * SIDE);
    expect(share).toBeGreaterThan(0.002);
    expect(share).toBeLessThan(0.008);
    // … and from 500 seeded plains / forest columns the nearest one is (hex distance):
    const rng = mulberry32(2026);
    const M = 100;
    const dists = [];
    for (let k = 0; k < 6000 && dists.length < 500; k++) {
      const q = Math.floor(rng() * (SIDE - 2 * M)) - HALF + M;
      const r = Math.floor(rng() * (SIDE - 2 * M)) - HALF + M;
      const biome = gen3.getColumn(q, r).biome;
      if (biome !== BIOME.PLAINS && biome !== BIOME.FOREST) continue;
      let best = M + 1;
      for (let dq = -M; dq <= M; dq++) {
        for (let dr = -M; dr <= M; dr++) {
          const d = hexLength(dq, dr);
          if (d < best && levelAt(q + dq, r + dr) >= 0) best = d;
        }
      }
      dists.push(best);
    }
    expect(dists).toHaveLength(500);
    dists.sort((a, b) => a - b);
    const within = (d) => dists.filter((x) => x <= d).length / dists.length;
    expect(within(60)).toBeGreaterThan(0.85); // usually within 60 …
    expect(within(40)).toBeGreaterThan(0.6); // … mostly within 40 …
    expect(within(10)).toBeLessThan(0.3); // … and seldom on the doorstep
    const median = dists[250];
    expect(median).toBeGreaterThanOrEqual(15);
    expect(median).toBeLessThanOrEqual(40);
  });
});

describe('streams: how high the water stands (rule 2)', () => {
  it('a column\'s level is the lowest generated height among itself and its six neighbours, never below the sea', () => {
    // (this also holds the tracer's own height field to getColumn: a level computed from a wrong height fails here)
    const { columns } = scan();
    for (const [q, r, level] of columns) {
      let low = gen3.getColumn(q, r).height;
      for (const [dq, dr] of HEX_DIRS) low = Math.min(low, gen3.getColumn(q + dq, r + dr).height);
      if (level !== Math.max(SEA_LEVEL, low)) throw new Error(`level of ${q},${r} is ${level}, the rule says ${Math.max(SEA_LEVEL, low)}`);
    }
  });

  it('the channel is shallow: flush with its lowest bank or one cell down, and steps drop one cell at a time', () => {
    const { columns, levelAt } = scan();
    let flush = 0;
    let steps = 0;
    for (const [q, r, level] of columns) {
      const carve = gen3.getColumn(q, r).height - level;
      expect(carve).toBeGreaterThanOrEqual(0);
      expect(carve).toBeLessThanOrEqual(3);
      if (carve === 0) flush++;
      const bottom = bottomOf(levelAt, q, r);
      if (bottom < level) {
        steps++;
        expect(level - bottom).toBeLessThanOrEqual(4);
      }
    }
    expect(flush / columns.length).toBeGreaterThan(0.5);
    expect(steps).toBeGreaterThan(columns.length / 20); // streams do run downhill
    expect(steps).toBeLessThan(columns.length / 2);
  });
});

describe('streams: what the chunks hold (rule 3), on both sides of every chunk border', () => {
  /** Chunks of the scan that hold stream columns, most first. */
  function streamChunks(limit) {
    const count = new Map();
    for (const [q, r] of scan().columns) {
      const key = `${floorDiv(q, CHUNK_SIZE)},${floorDiv(r, CHUNK_SIZE)}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
    return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit).map(([key]) => key.split(',').map(Number));
  }

  it('a stream column is AIR over a WATER source over WATER_FALL (at a step) over a solid bed; nothing else falls', () => {
    const { levelAt } = scan();
    let sources = 0;
    let falling = 0;
    for (const [cq, cr] of streamChunks(40)) {
      const chunk = chunkOf(gen3, cq, cr);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const q = cq * CHUNK_SIZE + lq;
          const r = cr * CHUNK_SIZE + lr;
          const base = localIndex(lq, 0, lr);
          const level = levelAt(q, r);
          const height = chunk.heights[lq * CHUNK_SIZE + lr];
          expect(height).toBe(gen3.getColumn(q, r).height); // the heights stay the generated terrain's
          if (level < 0) {
            // not a stream: no falling water anywhere, and above the sea only pond water (at the column's height)
            for (let y = 0; y < WORLD_HEIGHT; y++) {
              const id = chunk.blocks[base + y];
              if (id === B.WATER_FALL || (isWater(id) && y > SEA_LEVEL && !(gen3.pondAt(q, r) && y === height))) {
                throw new Error(`${getBlockDef(id).name} at ${q},${y},${r}, which is no stream`);
              }
            }
            continue;
          }
          const bottom = bottomOf(levelAt, q, r);
          const want = (y) => (y > level ? B.AIR : y === level ? B.WATER : y >= bottom ? B.WATER_FALL : -1);
          for (let y = bottom; y <= height + 1; y++) {
            if (chunk.blocks[base + y] !== want(y)) throw new Error(`${q},${y},${r}: ${getBlockDef(chunk.blocks[base + y]).name}, the stream wants ${getBlockDef(want(y)).name}`);
          }
          if (!isSolid(chunk.blocks[base + bottom - 1])) throw new Error(`the bed at ${q},${bottom - 1},${r} is not solid`);
          sources++;
          falling += level - bottom;
        }
      }
    }
    expect(sources).toBeGreaterThan(400);
    expect(falling).toBeGreaterThan(40);
  });

  it('every water cell that could spread has nothing open beside it — also where the neighbour is in another chunk', () => {
    // The static form of "at rest" (the real fluid rule runs below): a source on its bed, and the bottom of a shaft,
    // feed their six side cells; each of those must be solid or water. Sources over falling water feed nothing.
    const { columns, levelAt } = scan();
    let borders = 0;
    let checked = 0;
    for (const [q, r, level] of columns) {
      if (Math.abs(q) > HALF - 20 || Math.abs(r) > HALF - 20 || (q + r) % 3 !== 0) continue; // a third of them, well inside
      const bottom = bottomOf(levelAt, q, r);
      for (const [dq, dr] of HEX_DIRS) {
        const id = blockAt(gen3, q + dq, bottom, r + dr);
        if (!isSolid(id) && !isWater(id)) throw new Error(`open ${getBlockDef(id).name} at ${q + dq},${bottom},${r + dr} beside the stream at ${q},${r}`);
        if (floorDiv(q + dq, CHUNK_SIZE) !== floorDiv(q, CHUNK_SIZE) || floorDiv(r + dr, CHUNK_SIZE) !== floorDiv(r, CHUNK_SIZE)) borders++;
        // … and the carved air above a stream's water is never beside a spreading cell: a higher stream neighbour is a lip
        const n = levelAt(q + dq, r + dr);
        if (n > level && bottomOf(levelAt, q + dq, r + dr) > level - 1) throw new Error(`the stream at ${q + dq},${r + dr} would pour into ${q},${r}`);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
    expect(borders).toBeGreaterThan(50);
  });

  it('any chunk can be generated alone: a fresh generator makes the same bytes, whatever its neighbours', () => {
    for (const [cq, cr] of streamChunks(6)) {
      const alone = createWorldGen(SEED, { gen: 3 }).generateChunk(cq, cr);
      expect(digest(alone), `${cq},${cr}`).toBe(digest(chunkOf(gen3, cq, cr)));
      const after = createWorldGen(SEED, { gen: 3 });
      for (const [dq, dr] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, -1], [-1, 1]]) after.generateChunk(cq + dq, cr + dr);
      expect(digest(after.generateChunk(cq, cr)), `${cq},${cr} after its neighbours`).toBe(digest(alone));
    }
  });

  it('the fauna contract: where streamAt is true, the cell at streamLevelAt is fresh WATER', () => {
    const { columns } = scan();
    for (const [q, r, level] of columns.filter((_, i) => i % 7 === 0)) {
      expect(gen3.streamAt(q, r)).toBe(true);
      const id = blockAt(gen3, q, level, r);
      if (id !== B.WATER) throw new Error(`${q},${level},${r} is ${getBlockDef(id).name}`);
      expect(waterQualityAt((a, y, b) => blockAt(gen3, a, y, b), q, level, r)).toBe('fresh');
      // the falling water under a step is the stream's own: fresh too
      if (blockAt(gen3, q, level - 1, r) === B.WATER_FALL) expect(waterQualityAt((a, y, b) => blockAt(gen3, a, y, b), q, level - 1, r)).toBe('fresh');
    }
  });
});

describe('stampStreams: the stamp alone, on made-up land (rule 3)', () => {
  const idx = (lq, lr) => (lq + STREAM_MARGIN) * STREAM_MAP_SIDE + lr + STREAM_MARGIN;
  const emptyMap = () => new Int16Array(STREAM_MAP_SIDE * STREAM_MAP_SIDE).fill(-1);
  /** A chunk of stone up to `height(lq, lr)`. */
  function land(height) {
    const blocks = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
    const heights = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    for (let lq = 0; lq < CHUNK_SIZE; lq++) {
      for (let lr = 0; lr < CHUNK_SIZE; lr++) {
        const h = height(lq, lr);
        heights[lq * CHUNK_SIZE + lr] = h;
        blocks.fill(B.STONE, localIndex(lq, 0, lr), localIndex(lq, h, lr) + 1);
      }
    }
    return { blocks, heights };
  }
  const at = (c, lq, y, lr) => c.blocks[localIndex(lq, y, lr)];

  it('streamBottom: a column\'s level, or one below its lowest lower stream neighbour; −1 off the stream', () => {
    expect(STREAM_MARGIN).toBe(2);
    expect(STREAM_MAP_SIDE).toBe(CHUNK_SIZE + 4);
    const map = emptyMap();
    map[idx(5, 5)] = 70;
    map[idx(6, 5)] = 70;
    map[idx(7, 5)] = 69;
    map[idx(8, 5)] = 66;
    expect(streamBottom(map, idx(4, 5))).toBe(-1);
    expect(streamBottom(map, idx(5, 5))).toBe(70); // flat: its neighbour is level with it
    expect(streamBottom(map, idx(6, 5))).toBe(68); // a lip over 69: the shaft ends one below it
    expect(streamBottom(map, idx(7, 5))).toBe(65); // a lip over 66
    expect(streamBottom(map, idx(8, 5))).toBe(66); // the lowest: no shaft
  });

  it('carves the column, sets the source and the shaft, clears what stood on it, and never touches columns off the stream', () => {
    const c = land(() => 70);
    c.blocks[localIndex(5, 71, 5)] = B.CATTAILS; // something standing on a stream column
    c.blocks[localIndex(5, 71, 6)] = B.TUSSOCK; // … and beside it
    c.blocks[localIndex(9, 70, 5)] = B.TAINTED_WATER; // a pond cell beside the stream's end
    const before = c.blocks.slice();
    const map = emptyMap();
    map[idx(5, 5)] = 70;
    map[idx(6, 5)] = 70;
    map[idx(7, 5)] = 69;
    map[idx(8, 5)] = 68;
    stampStreams(c.blocks, c.heights, map);
    const column = (lq, lr) => Array.from({ length: 8 }, (_, k) => at(c, lq, 64 + k, lr));
    const S = B.STONE;
    const W = B.WATER;
    const F = B.WATER_FALL;
    //                           y: 64 65 66 67 68 69 70 71
    expect(column(5, 5)).toEqual([S, S, S, S, S, S, W, B.AIR]); // flush, the cattails gone
    expect(column(6, 5)).toEqual([S, S, S, S, F, F, W, B.AIR]); // a lip over 69: falling down to 68
    expect(column(7, 5)).toEqual([S, S, S, F, F, W, B.AIR, B.AIR]); // carved one, a lip over 68: falling down to 67
    expect(column(8, 5)).toEqual([S, S, S, S, W, B.AIR, B.AIR, B.AIR]); // carved two, the end
    // everything else is as it was: the tussock beside it, the pond cell (water is not air: it is left alone)
    let changed = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== c.blocks[i]) changed++;
    expect(changed).toBe(1 + 3 + 5 + 3); // the cells listed above that differ from stone / cattails / air
    expect(at(c, 5, 71, 6)).toBe(B.TUSSOCK);
    expect(at(c, 9, 70, 5)).toBe(B.TAINTED_WATER);
    expect([...c.heights].every((h) => h === 70)).toBe(true); // heights stay the generated terrain's
  });

  it('fills the air a cave left in a bed or beside a water cell with stone — but not a neighbouring stream\'s own cells', () => {
    const c = land(() => 70);
    const map = emptyMap();
    map[idx(5, 5)] = 70;
    map[idx(6, 5)] = 70;
    map[idx(7, 5)] = 68;
    // caves: under the bed of (5, 5); beside its source, in the bank (5, 6); beside the shaft of (6, 5), in the bank
    // (6, 6) at y 67..70; and deep below everything
    c.blocks[localIndex(5, 69, 5)] = B.AIR;
    c.blocks[localIndex(5, 70, 6)] = B.AIR;
    for (let y = 66; y <= 70; y++) c.blocks[localIndex(6, y, 6)] = B.AIR;
    c.blocks[localIndex(5, 60, 5)] = B.AIR;
    c.blocks[localIndex(4, 71, 5)] = B.AIR; // (already air: above the bank)
    stampStreams(c.blocks, c.heights, map);
    expect(at(c, 5, 69, 5)).toBe(B.STONE); // the bed
    expect(at(c, 5, 70, 6)).toBe(B.STONE); // the bank beside the source
    expect(streamBottom(map, idx(6, 5))).toBe(67);
    for (let y = 67; y <= 70; y++) expect(at(c, 6, y, 6), `y ${y}`).toBe(B.STONE); // beside every water cell of the shaft
    expect(at(c, 6, 66, 6)).toBe(B.AIR); // below the shaft's bottom: nobody's business
    expect(at(c, 5, 60, 5)).toBe(B.AIR);
    // (7, 5) is a stream column: its carved air at y 69, 70 — beside the shaft of (6, 5) — stays air, its water water
    expect([67, 68, 69, 70].map((y) => at(c, 7, y, 5))).toEqual([B.STONE, B.WATER, B.AIR, B.AIR]);
    // … but UNDER its own water it is a wall to the shaft of (6, 5) like any other: a cave there is filled
    const d = land(() => 70);
    d.blocks[localIndex(7, 67, 5)] = B.AIR;
    stampStreams(d.blocks, d.heights, map);
    expect(at(d, 7, 67, 5)).toBe(B.STONE);
  });

  it('a stream column one column outside the chunk still gets its bank inside it; two columns out it is nobody here', () => {
    const map = emptyMap();
    map[idx(-1, 5)] = 70; // just outside: its side neighbours in the chunk are (0, 5) and (0, 4) (HEX_DIRS [1, 0] and [1, −1])
    map[idx(-2, 9)] = 70; // two out: no neighbour of it is in the chunk
    const c = land(() => 70);
    for (const lr of [3, 4, 5, 6, 8, 9, 10]) c.blocks[localIndex(0, 70, lr)] = B.AIR; // caves all along the chunk's edge
    stampStreams(c.blocks, c.heights, map);
    expect([3, 4, 5, 6, 8, 9, 10].map((lr) => at(c, 0, 70, lr))).toEqual([B.AIR, B.STONE, B.STONE, B.AIR, B.AIR, B.AIR, B.AIR]);
    expect(c.blocks.includes(B.WATER)).toBe(false); // no water of theirs in this chunk
  });

  it('whatever the map and the land, the stamped water is at rest under the real fluid rule (40 random chunks)', () => {
    // Random heights, random caves, random stream columns with random levels — streams side by side, crossing, in
    // clumps, far steeper than the generator makes them. The stamp is what makes them hold: lips, beds and banks.
    const rng = mulberry32(76);
    let lips = 0;
    let fills = 0;
    for (let trial = 0; trial < 40; trial++) {
      const hs = Array.from({ length: CHUNK_SIZE * CHUNK_SIZE }, () => 62 + Math.floor(rng() * 9));
      const c = land((lq, lr) => hs[lq * CHUNK_SIZE + lr]);
      for (let k = 0; k < 500; k++) c.blocks[localIndex(Math.floor(rng() * 16), 52 + Math.floor(rng() * 20), Math.floor(rng() * 16))] = B.AIR;
      const map = emptyMap();
      const density = 0.05 + rng() * 0.3;
      for (let lq = 2; lq <= 13; lq++) {
        for (let lr = 2; lr <= 13; lr++) {
          // (levels at or below the column's own height, like the generator's — but any neighbour may be lower or higher)
          if (rng() < density) map[idx(lq, lr)] = Math.min(hs[lq * CHUNK_SIZE + lr], 60 + Math.floor(rng() * 8));
        }
      }
      const before = c.blocks.slice();
      stampStreams(c.blocks, c.heights, map);
      for (let i = 0; i < before.length; i++) if (before[i] === B.AIR && c.blocks[i] === B.STONE) fills++;
      // the chunk as a world: its cells are the generated ("natural") terrain of a fake world
      const world = makeFakeWorld({ groundY: -1 });
      const physics = attachPhysics(world, BlockPhysics);
      const water = [];
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          for (let y = 40; y < 80; y++) {
            const id = at(c, lq, y, lr);
            if (id === B.AIR) continue;
            world.put(lq, y, lr, id);
            if (isWater(id)) water.push([lq, y, lr]);
          }
          if (map[idx(lq, lr)] >= 0 && streamBottom(map, idx(lq, lr)) < map[idx(lq, lr)]) lips++;
        }
      }
      for (const [q, y, r] of water) physics.scheduleWaterAround(q, y, r);
      let ticks = 0;
      while (physics.queued() > 0 && ticks < 2000) {
        physics.tick();
        ticks++;
      }
      expect(physics.queued()).toBe(0);
      if (world.writes.length > 0) {
        const w = world.writes[0];
        throw new Error(`trial ${trial}: the water moved — ${w.q},${w.y},${w.r} became ${getBlockDef(w.id).name} (${world.writes.length} writes)`);
      }
      expect(physics.fluids.stats.updates).toBeGreaterThan(water.length);
    }
    expect(lips).toBeGreaterThan(200); // the trials really had steps …
    expect(fills).toBeGreaterThan(200); // … and banks and beds to fill
  });
});

describe('streams, trees and ponds', () => {
  it('no tree grows in a stream column — the whole tree is left out — and every log still stands on something', () => {
    // tree candidates (the gen-1 test, unchanged) whose trunk column is a stream
    const dropped = [];
    for (let kq = floorDiv(-HALF, TREE_CELL) + 1; kq < floorDiv(HALF, TREE_CELL) - 1; kq++) {
      for (let kr = floorDiv(-HALF, TREE_CELL) + 1; kr < floorDiv(HALF, TREE_CELL) - 1; kr++) {
        const t = gen3.treeTrunkAt(kq, kr);
        if (t !== null && gen3.streamAt(t.tq, t.tr)) dropped.push(t);
      }
    }
    expect(dropped.length).toBeGreaterThan(3);
    for (const t of dropped.slice(0, 12)) {
      expect(gen2.treeTrunkAt(floorDiv(t.tq - 1, TREE_CELL), floorDiv(t.tr - 1, TREE_CELL))).toEqual(t); // the same candidate in generation 2 …
      expect(isLog(blockAt(gen2, t.tq, t.height + 1, t.tr))).toBe(true); // … where it grows
      for (let y = t.height; y <= t.height + t.trunk + 2; y++) {
        const id = blockAt(gen3, t.tq, y, t.tr);
        if (isLog(id)) throw new Error(`a log at ${t.tq},${y},${t.tr}, over a stream`);
      }
      // its crown is gone as well: the leaf right above where its trunk would end is not there (unless another tree's is)
      const crown = blockAt(gen3, t.tq, t.height + t.trunk + 1, t.tr);
      const neighbourTree = HEX_DIRS.some(([dq, dr]) => [1, 2].some((k) => isLog(blockAt(gen3, t.tq + dq * k, t.height + t.trunk - 1, t.tr + dr * k))));
      if (!neighbourTree) expect(crown).toBe(B.AIR);
    }
    // over the chunks of those trees: every log has a log or ground under it
    const seen = new Set();
    for (const t of dropped.slice(0, 12)) {
      const cq = floorDiv(t.tq, CHUNK_SIZE);
      const cr = floorDiv(t.tr, CHUNK_SIZE);
      if (seen.has(`${cq},${cr}`)) continue;
      seen.add(`${cq},${cr}`);
      const chunk = chunkOf(gen3, cq, cr);
      for (let i = 0; i < chunk.blocks.length; i++) {
        if (!isLog(chunk.blocks[i])) continue;
        const below = chunk.blocks[i - 1];
        if (!isLog(below) && ![B.GRASS_BLOCK, B.SNOWY_GRASS, B.DIRT].includes(below)) throw new Error(`a log in chunk ${cq},${cr} stands on ${getBlockDef(below).name}`);
      }
    }
  });

  it('a pond keeps its ground: a stream ends beside it, or on its rim exactly at the pond\'s level — never lower', () => {
    const ponds = pondCentres(gen3, floorDiv(-HALF, POND_CELL) + 1, floorDiv(HALF, POND_CELL) - 2);
    expect(ponds.length).toBeGreaterThan(40);
    let mouths = 0;
    let beside = 0;
    for (const p of ponds) {
      for (let dq = -3; dq <= 3; dq++) {
        for (let dr = -3; dr <= 3; dr++) {
          const d = hexLength(dq, dr);
          if (d > 3) continue;
          const level = gen3.streamLevelAt(p.q + dq, p.r + dr);
          if (level < 0) continue;
          if (d === 3) {
            beside++;
            continue;
          }
          // on the pond's ground: only the rim, only at the pond's own level, and never a pond water column
          expect(d, `stream at ${p.q + dq},${p.r + dr} in the pond at ${p.q},${p.r}`).toBe(2);
          expect(level).toBe(p.H);
          expect(gen3.pondAt(p.q + dq, p.r + dr)).toBe(false);
          mouths++;
        }
      }
      // the pond's water is where generation 2 has it (tainted or not, or ice) — looked at in the chunks of every fourth pond
      if ((p.kq + 2 * p.kr) % 4 !== 0) continue;
      for (const [dq, dr] of [[0, 0], ...HEX_DIRS]) {
        if (!gen3.pondAt(p.q + dq, p.r + dr)) continue;
        const id3 = blockAt(gen3, p.q + dq, p.H, p.r + dr);
        const id2 = blockAt(gen2, p.q + dq, p.H, p.r + dr);
        expect(id2 === B.ICE ? id3 === B.ICE : (id3 === B.WATER || id3 === B.TAINTED_WATER) && id2 === B.WATER, `${p.q + dq},${p.r + dr}`).toBe(true);
        expect(blockAt(gen3, p.q + dq, p.H - 1, p.r + dr)).toBe(B.CLAY);
      }
    }
    expect(beside + mouths).toBeGreaterThan(0); // some streams do reach ponds in the scan
  });
});

describe('tainted ponds (generation 3)', () => {
  it('about three ponds in four are tainted — the whole pond or none of it; frozen ponds stay ice; generation 2 stays fresh', () => {
    expect(POND_TAINTED_SHARE).toBe(0.75);
    const ponds = pondCentres(gen3, -40, 40);
    const liquid = ponds.filter((p) => p.biome !== BIOME.SNOWY);
    const frozen = ponds.filter((p) => p.biome === BIOME.SNOWY);
    expect(liquid.length).toBeGreaterThan(200);
    let tainted = 0;
    for (const p of liquid) {
      const t = gen3.pondTaintedAt(p.q, p.r);
      if (t) tainted++;
      for (const [dq, dr] of HEX_DIRS) {
        if (gen3.pondAt(p.q + dq, p.r + dr)) expect(gen3.pondTaintedAt(p.q + dq, p.r + dr), `${p.q},${p.r}`).toBe(t);
        else expect(gen3.pondTaintedAt(p.q + dq, p.r + dr)).toBe(false); // only pond water columns
      }
      expect(gen2.pondTaintedAt(p.q, p.r)).toBe(false);
    }
    const share = tainted / liquid.length;
    expect(share).toBeGreaterThan(0.68);
    expect(share).toBeLessThan(0.82);
    for (const p of frozen) expect(gen3.pondTaintedAt(p.q, p.r)).toBe(false);
    // the same ponds in another world roll their own taint
    const other = createWorldGen('another-seed', { gen: 3 });
    const theirs = pondCentres(other, -20, 20).filter((p) => p.biome !== BIOME.SNOWY);
    const theirShare = theirs.filter((p) => other.pondTaintedAt(p.q, p.r)).length / theirs.length;
    expect(theirShare).toBeGreaterThan(0.6);
    expect(theirShare).toBeLessThan(0.9);
  });

  it('the generated pond holds TAINTED_WATER exactly where pondTaintedAt says, WATER or ICE otherwise, CLAY under it', () => {
    const ponds = pondCentres(gen3, -8, 8);
    expect(ponds.length).toBeGreaterThan(10);
    const kinds = new Set();
    for (const p of ponds) {
      for (const [dq, dr] of [[0, 0], ...HEX_DIRS]) {
        const q = p.q + dq;
        const r = p.r + dr;
        if (!gen3.pondAt(q, r)) continue;
        const want = p.biome === BIOME.SNOWY ? B.ICE : gen3.pondTaintedAt(q, r) ? B.TAINTED_WATER : B.WATER;
        expect(blockAt(gen3, q, p.H, r), `${q},${r}`).toBe(want);
        expect(blockAt(gen2, q, p.H, r)).toBe(p.biome === BIOME.SNOWY ? B.ICE : B.WATER);
        expect(blockAt(gen3, q, p.H + 1, r)).toBe(B.AIR);
        kinds.add(want);
      }
    }
    expect(kinds.has(B.TAINTED_WATER) && kinds.has(B.WATER)).toBe(true);
  });
});

describe('performance', () => {
  it('generates a warm generation-3 chunk in ≤ 8 ms on average over 10 chunks (streams traced as they come)', () => {
    // The same ten chunks as the generation-1 and -2 tests, a diagonal line — the worst case for the streams: every
    // chunk of a line brings new spring-grid cells into reach (over an area a chunk costs about a twentieth of that).
    // Warm: the code (three chunks elsewhere, and the stream tracer over a patch of land far away) and the land (the
    // three chunks before the line, as chunks stream in during play; the very first chunk of a world also traces every
    // stream within reach of it, once).
    const g = createWorldGen(SEED, { gen: 3 });
    for (let i = 0; i < 3; i++) g.generateChunk(50 + i, 50); // warm up
    for (let cq = 0; cq < 24; cq++) for (let cr = 0; cr < 24; cr++) g.streamLevelAt(9000 + cq * CHUNK_SIZE, cr * CHUNK_SIZE);
    for (let i = 3; i >= 1; i--) g.generateChunk(60 - i, -60 - i);
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) g.generateChunk(60 + i, -60 + i);
    const avg = (performance.now() - t0) / 10;
    expect(avg).toBeLessThan(8);
  });

  it('the stream work of a chunk is a small part of it: a generation-3 chunk takes less than 1.5 × generation 2\'s time', () => {
    // interleaved, best of five rounds each, so a busy machine slows both alike (measured: about 1.15 ×)
    const a = createWorldGen(SEED, { gen: 2 });
    const b = createWorldGen(SEED, { gen: 3 });
    for (let i = 0; i < 3; i++) {
      a.generateChunk(50 + i, 50);
      b.generateChunk(50 + i, 50);
    }
    let best2 = Infinity;
    let best3 = Infinity;
    for (let round = 0; round < 5; round++) {
      let t0 = performance.now();
      for (let i = 0; i < 10; i++) a.generateChunk(100 + i + 20 * round, -60 + i);
      best2 = Math.min(best2, (performance.now() - t0) / 10);
      t0 = performance.now();
      for (let i = 0; i < 10; i++) b.generateChunk(100 + i + 20 * round, -60 + i);
      best3 = Math.min(best3, (performance.now() - t0) / 10);
    }
    expect(best3).toBeLessThan(best2 * 1.5);
  });
});

describe('streams are at rest: the real fluid rule changes nothing', () => {
  /** A real generation-3 World of SEED loaded around column (q, r) (render distance 3: 61 chunks), physics forwarded like main. */
  function realWorld(q, r, renderDistance = 3) {
    const world = new World({ seed: SEED, renderDistance, worldGen: createWorldGen(SEED, { gen: 3 }), now: () => 0 });
    const physics = attachPhysics(world, BlockPhysics);
    const [x, z] = hexToWorld(q, r);
    for (let i = 0; i < 2000; i++) {
      const s = world.update(x, z, Infinity);
      if (s.pendingGen === 0 && s.pendingMesh === 0) break;
    }
    return { world, physics };
  }

  /** Queue the water rule on every water cell from y 58 up (all streams, ponds and the sea's surface) and its neighbours. */
  function wakeAllWater(world, physics) {
    const census = { water: 0, falling: 0, tainted: 0, streams: 0 };
    for (const chunk of world.chunks.values()) {
      const oq = chunk.cq * CHUNK_SIZE;
      const or = chunk.cr * CHUNK_SIZE;
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          if (world.worldGen.streamAt(oq + lq, or + lr)) census.streams++;
          const base = localIndex(lq, 0, lr);
          for (let y = 58; y < WORLD_HEIGHT; y++) {
            const id = chunk.blocks[base + y];
            if (!isWater(id)) continue;
            census.water++;
            if (id === B.WATER_FALL) census.falling++;
            if (id === B.TAINTED_WATER) census.tainted++;
            physics.scheduleWaterAround(oq + lq, y, or + lr);
          }
        }
      }
    }
    return census;
  }

  function settle(physics, max = 20000) {
    let t = 0;
    while (physics.queued() > 0 && t < max) {
      physics.tick();
      t++;
    }
    if (physics.queued() > 0) throw new Error(`water did not settle within ${max} ticks`);
    return t;
  }

  /** @returns {Map<string, Uint8Array>} a copy of every loaded chunk's blocks */
  function snapshot(world) {
    const snap = new Map();
    for (const chunk of world.chunks.values()) snap.set(chunk.key, chunk.blocks.slice());
    return snap;
  }

  /** Cells that differ from the snapshot, as text (at most `limit`). */
  function changes(world, snap, limit = 10) {
    const out = [];
    for (const chunk of world.chunks.values()) {
      const before = snap.get(chunk.key);
      for (let i = 0; i < before.length; i++) {
        if (before[i] === chunk.blocks[i]) continue;
        out.push(`${chunk.key}#${i}: ${getBlockDef(before[i]).name} → ${getBlockDef(chunk.blocks[i]).name}`);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Stream columns of the scan to load a world round: on a slope (a step), at the sea, and beside a pond. */
  function sites() {
    const { columns, levelAt } = scan();
    const inside = columns.filter(([q, r]) => Math.abs(q) < HALF - 80 && Math.abs(r) < HALF - 80);
    const step = inside.find(([q, r, level]) => bottomOf(levelAt, q, r) < level);
    const sea = inside.find(([q, r, level]) => level === SEA_LEVEL && HEX_DIRS.some(([dq, dr]) => gen3.getColumn(q + dq, r + dr).height < SEA_LEVEL));
    const pond = inside.find(([q, r]) => {
      for (let dq = -3; dq <= 3; dq++) for (let dr = -3; dr <= 3; dr++) if (gen3.pondTaintedAt(q + dq, r + dr)) return true;
      return false;
    });
    return { step, sea, pond };
  }

  it('the scan has a stream with a step, one that reaches the sea and one beside a tainted pond', () => {
    const s = sites();
    expect(s.step).toBeDefined();
    expect(s.sea).toBeDefined();
    expect(s.pond).toBeDefined();
  });

  for (const name of ['step', 'sea', 'pond']) {
    it(`round a stream ${name === 'step' ? 'with a step' : name === 'sea' ? 'that reaches the sea' : 'beside a tainted pond'}: waking every water cell changes no block and makes no edit`, () => {
      const [q, r] = sites()[name];
      const { world, physics } = realWorld(q, r);
      expect(world.gen).toBe(3);
      const snap = snapshot(world);
      const census = wakeAllWater(world, physics);
      expect(census.streams).toBeGreaterThan(20);
      expect(census.falling).toBeGreaterThan(0);
      if (name === 'pond') expect(census.tainted).toBeGreaterThan(0);
      expect(physics.queued()).toBeGreaterThan(census.water); // the rule really is about to run on them
      const ticks = settle(physics);
      expect(ticks).toBeGreaterThanOrEqual(5); // the water ring's delay: it ran
      expect(physics.fluids.stats.updates).toBeGreaterThan(census.water);
      expect(physics.fluids.stats.writes).toBe(0);
      expect(changes(world, snap)).toEqual([]);
      expect(world.editCount).toBe(0);
    });
  }

  it('it is live water all the same: a dug bank lets it out, a scooped-out source comes back, and nothing lingers', () => {
    const { columns, levelAt } = scan();
    // a column on a flat reach — its bed right under the source — with a stream neighbour at its level either side, and a bank
    const flat = columns.find(([q, r, level]) => Math.abs(q) < HALF - 80 && Math.abs(r) < HALF - 80 && bottomOf(levelAt, q, r) === level
      && HEX_DIRS.filter(([dq, dr]) => levelAt(q + dq, r + dr) === level).length >= 2
      && HEX_DIRS.some(([dq, dr]) => levelAt(q + dq, r + dr) < 0 && gen3.getColumn(q + dq, r + dr).height === level));
    expect(flat).toBeDefined();
    const [q, r, level] = flat;
    const { world, physics } = realWorld(q, r, 2);
    const snap = snapshot(world);
    expect(world.getBlock(q, level, r)).toBe(B.WATER);

    // 1. dig the bank beside it (a non-stream neighbour whose top block is at the water's level): the stream runs into the hole
    const [bq, br] = HEX_DIRS.map(([dq, dr]) => [q + dq, r + dr]).find(([a, b]) => levelAt(a, b) < 0 && gen3.getColumn(a, b).height === level);
    expect(isSolid(world.getBlock(bq, level, br))).toBe(true);
    world.setBlock(bq, level, br, B.AIR);
    settle(physics);
    expect(isWater(world.getBlock(bq, level, br))).toBe(true);
    expect(waterQualityAt(world.getBlock, bq, level, br)).toBe('fresh');
    expect(changes(world, snap).length).toBeGreaterThan(0);
    // … and putting the bank back drains whatever got out, leaving the world as generated
    world.setBlock(bq, level, br, snap.get(world.getChunk(floorDiv(bq, CHUNK_SIZE), floorDiv(br, CHUNK_SIZE)).key)[localIndex(bq - floorDiv(bq, CHUNK_SIZE) * CHUNK_SIZE, level, br - floorDiv(br, CHUNK_SIZE) * CHUNK_SIZE)]);
    settle(physics);
    expect(changes(world, snap)).toEqual([]);
    expect(world.editCount).toBe(0);

    // 2. take the source itself away: its neighbours flow in, and natural water becomes a source again
    world.setBlock(q, level, r, B.AIR);
    settle(physics);
    expect(world.getBlock(q, level, r)).toBe(B.WATER);
    expect(changes(world, snap)).toEqual([]);
    expect(world.editCount).toBe(0);
  });
});
