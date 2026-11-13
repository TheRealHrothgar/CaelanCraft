// The aquifer (CONTRACTS §89): an unminable block of wet rock under every stream head, every natural spring and one
// fresh pond in three (generation 6), that feeds the water standing on it — full in the rains, low in the dry season,
// never dry. The one thing besides rain that makes water. The block and its protection; where generation 6 puts it
// (generations 1–5 byte for byte); the flow by simulation; the seasonal target and the shallow floor; a dug basin on
// the real rule; streams; saving and loading; the wiring (read from main's source); what a second of it costs.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHUNK_SIZE, WORLD_HEIGHT, GEN_LATEST } from '../../src/config.js';
import {
  BLOCK, BLOCKS, BLOCK_COUNT, TILE, TILE_IDS, BIOME, PICKER_ORDER, LAYER_OPAQUE, UNLOADED, isDeepRock, isBreakable, isPlaceable,
  isSolid, isOpaque, isWaterSource, isTaintedWater, waterDepth, getFaceTile, FACE_TOP, FACE_BOTTOM,
} from '../../src/blocks.js';
import { TILE_NAMES, paintTile } from '../../src/tiles.js';
import { ITEMS, itemForBlock } from '../../src/items.js';
import { BLOCK_RULES, ruleFor } from '../../src/harvest.js';
import { isBlastProof } from '../../src/explosions.js';
import { canSwallow } from '../../src/blackholes.js';
import { isAnchorCell } from '../../src/support.js';
import { chooseBelongingsCell } from '../../src/survivalControl.js';
import { deepHint, AQUIFER_DEEP_HINT, SPRING_DEEP_HINT } from '../../src/homestead.js';
import { executeCommand, parseLine } from '../../src/commands.js';
import { createPlayer } from '../../src/physics.js';
import {
  createWorldGen, POND_CELL, POND_SALT, POND_AQUIFER_SHARE, POND_AQUIFER_SALT, STREAM_CELL, STREAM_ASCENT, NATURAL_SPRING_CELL,
} from '../../src/worldgen.js';
import { hash2, rand3, normalizeSeed, mulberry32 } from '../../src/noise.js';
import { hexDiscCount, hexLength, hexToWorld } from '../../src/hex.js';
import { World } from '../../src/world.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { waterBodyAt } from '../../src/fluids.js';
import { DRYNESS_RAINS, DRYNESS_DRY } from '../../src/weather.js';
import {
  AQUIFER_FLOW, AQUIFER_HOUR_S, AQUIFER_FULL_BELOW, AQUIFER_FLOOR, AQUIFER_NEAR_MAX, CYCLE_COLUMNS, CYCLE_RANGE, STREAM_HEAD_CELLS,
  AquiferIndex, WaterCycle, aquiferFlow, aquiferTarget, aquiferUnder, aquiferBasinAt, aquiferFeeds, aquiferInfo, bodyFed, feedStep,
  cycleStep, drawWater, streamDryWrites, applyWaterWrites, POT_GULPS,
} from '../../src/waterBodies.js';
import { installDebugHandle } from '../../src/diagnostics.js';
import { makeFakeWorld, attachPhysics } from '../helpers/fixtures.js';
import { pondCells, rest } from '../helpers/water.js';

const B = BLOCK;
const G = 4; // the ground of the small worlds: stone for y ≤ 4
const RAINS = { rain: () => 0, dryness: () => DRYNESS_RAINS }; // (the rains' season on a dry day: the aquifer alone)
const DRY = { rain: () => 0, dryness: () => DRYNESS_DRY };
const all = (id, n = 7) => Array(n).fill(id);
/** A `random` that returns the given values, then 0.999 for ever (no sample hits, no roll passes). */
const seq = (...values) => {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0.999);
};

/**
 * A small fast world: columns within `R` of the middle, stone up to G, AIR above (H cells high); reads outside it are
 * UNLOADED. `aquifers` is what the aquifers' step is given. `gen` sets a cell as generated, `set` changes it after.
 */
function grid(R = 52, H = 12) {
  const S = 2 * R + 1;
  const now = new Uint8Array(S * S * H);
  const origin = new Uint8Array(S * S * H);
  const idx = (q, y, r) => ((q + R) * S + (r + R)) * H + y;
  const inside = (q, r) => q >= -R && q <= R && r >= -R && r <= R;
  for (let q = -R; q <= R; q++) for (let r = -R; r <= R; r++) for (let y = 0; y <= G; y++) now[idx(q, y, r)] = origin[idx(q, y, r)] = B.STONE;
  /** @type {Map<string, number>} */
  const springs = new Map();
  /** @type {number[]} */
  const aquifers = [];
  const w = {
    peek: (q, y, r) => (y < 0 || y >= H ? B.AIR : inside(q, r) ? now[idx(q, y, r)] : UNLOADED),
    originAt: (q, y, r) => (y < 0 || y >= H ? B.AIR : inside(q, r) ? origin[idx(q, y, r)] : UNLOADED),
    isLoadedCell: inside,
    springLevelAt: (q, r) => (springs.size === 0 ? -1 : springs.get(`${q},${r}`) ?? -1),
    q: 0,
    r: 0,
    top: H - 1,
    aquifers: () => aquifers.slice(),
    list: aquifers,
    gen(q, y, r, id) {
      now[idx(q, y, r)] = origin[idx(q, y, r)] = id;
      if (id === B.AQUIFER) aquifers.push(q, y, r);
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
    ids: (cells, y = G) => cells.map(([q, r]) => now[idx(q, y, r)]),
  };
  return w;
}

/** The columns within `radius` of (q0, r0), as [q, r]. */
function disc(q0, r0, radius) {
  const out = [];
  for (let dq = -radius; dq <= radius; dq++) for (let dr = -radius; dr <= radius; dr++) if (hexLength(dq, dr) <= radius) out.push([q0 + dq, r0 + dr]);
  return out;
}

/** A basin of the cells within `radius` of (q0, r0), dug one deep into the ground (y G), on an aquifer at its middle. */
function aquiferBasin(w, radius, q0 = 0, r0 = 0) {
  const cells = disc(q0, r0, radius);
  for (const [q, r] of cells) w.gen(q, G, r, B.AIR);
  w.gen(q0, G - 1, r0, B.AQUIFER);
  return cells;
}

/** A generated pond of `id` round (q0, r0) at y G, on CLAY, with an aquifer under its middle (as generation 6 has it). */
function aquiferPond(w, id = B.WATER, q0 = 0, r0 = 0) {
  for (const [q, r] of pondCells(q0, r0)) {
    w.gen(q, G, r, id);
    w.gen(q, G - 1, r, B.CLAY);
  }
  w.gen(q0, G - 1, r0, B.AQUIFER);
}

/** The pick of `random` that samples the middle column (0, 0) in cycleStep (spread.discCells order). */
const MIDDLE = ((hexDiscCount(CYCLE_RANGE) - 1) / 2 + 0.5) / CYCLE_COLUMNS;

// ---------------------------------------------------------------------------------------------------------------------

describe('the block (blocks.js, tiles.js)', () => {
  it('AQUIFER 173 "Aquifer", appended after the beds; BLOCK_COUNT 174; wet rock: solid, opaque, unbreakable, never placed, sound stone', () => {
    expect(B.AQUIFER).toBe(173);
    expect(BLOCK_COUNT).toBe(174);
    expect(BLOCKS).toHaveLength(174);
    const d = BLOCKS[B.AQUIFER];
    expect([d.id, d.name, d.displayName, d.soundGroup]).toEqual([173, 'aquifer', 'Aquifer', 'stone']);
    expect([d.solid, d.opaque, d.liquid, d.breakable, d.placeable, d.layer, d.shape, d.icon, d.gravity, d.meshed])
      .toEqual([true, true, false, false, false, LAYER_OPAQUE, 'prism', 'prism', false, true]);
    expect(isSolid(B.AQUIFER) && isOpaque(B.AQUIFER)).toBe(true);
    expect(isBreakable(B.AQUIFER) || isPlaceable(B.AQUIFER) || isWaterSource(B.AQUIFER)).toBe(false);
    // no item, no picker entry, no harvest rule
    expect(PICKER_ORDER).not.toContain(B.AQUIFER);
    expect(itemForBlock(B.AQUIFER)).toBeNull();
    expect(Object.keys(ITEMS)).not.toContain('aquifer');
    expect(BLOCK_RULES[B.AQUIFER]).toBeNull();
    expect(ruleFor(B.AQUIFER)).toBeNull();
  });

  it('two tiles in the ids §85 left free: 238 aquifer_side and 239 aquifer_top (TILE_IDS 195), opaque, its own, wet dark rock with bright water', () => {
    expect([TILE.AQUIFER_SIDE, TILE.AQUIFER_TOP]).toEqual([238, 239]);
    expect([TILE_NAMES[238], TILE_NAMES[239]]).toEqual(['aquifer_side', 'aquifer_top']);
    expect(TILE_IDS).toHaveLength(195);
    for (let f = 0; f < 6; f++) expect(getFaceTile(B.AQUIFER, f)).toBe(TILE.AQUIFER_SIDE);
    expect([getFaceTile(B.AQUIFER, FACE_TOP), getFaceTile(B.AQUIFER, FACE_BOTTOM)]).toEqual([TILE.AQUIFER_TOP, TILE.AQUIFER_TOP]);
    for (const t of [TILE.AQUIFER_SIDE, TILE.AQUIFER_TOP]) {
      const px = paintTile(t);
      let water = 0;
      let dark = 0;
      let lum = 0;
      for (let i = 0; i < px.length; i += 4) {
        expect(px[i + 3], TILE_NAMES[t]).toBe(255);
        const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
        if (b > 180 && b > r + 80) water++; // the bright blue of the spring's water
        if (r + g + b < 90) dark++; // the cracks
        lum += (r + g + b) / 3;
      }
      expect(water, TILE_NAMES[t]).toBeGreaterThanOrEqual(15);
      expect(dark, TILE_NAMES[t]).toBeGreaterThanOrEqual(15);
      expect(lum / 256, TILE_NAMES[t]).toBeLessThan(90); // dark rock, darker than stone and bedrock
      expect(Buffer.from(px).equals(Buffer.from(paintTile(TILE.BEDROCK)))).toBe(false);
      expect(Buffer.from(px).equals(Buffer.from(paintTile(TILE.SPRING_SIDE)))).toBe(false);
    }
  });
});

describe('it cannot be dug, blasted or pulled, in either mode; commands may set it', () => {
  it('isDeepRock: bedrock and the aquifer, nothing else', () => {
    const deep = Array.from({ length: 256 }, (_, i) => i).filter(isDeepRock);
    expect(deep).toEqual([B.BEDROCK, B.AQUIFER]);
    expect(isDeepRock(UNLOADED)).toBe(false);
  });

  it('Survival: no dig rule, and the hint says why; Creative: not breakable; no blast and no black hole takes it', () => {
    expect(BLOCK_RULES[B.AQUIFER]).toBeNull();
    expect(deepHint(B.AQUIFER)).toBe(AQUIFER_DEEP_HINT);
    expect(AQUIFER_DEEP_HINT).toBe('Aquifer · water rises through this rock: it cannot be dug');
    expect([deepHint(B.SPRING), deepHint(B.STONE)]).toEqual([SPRING_DEEP_HINT, null]);
    expect(isBreakable(B.AQUIFER)).toBe(false);
    expect(isBlastProof(B.AQUIFER)).toBe(true);
    expect(canSwallow(B.AQUIFER)).toBe(false);
    // (the real blast and the real black hole are explosions.test.js's and blackholes.test.js's: both keep it)
  });

  it('a support search ends on one as on bedrock (also one a command set), and no belongings heap replaces one', () => {
    const world = makeFakeWorld({ groundY: G });
    world.setBlock(0, 10, 0, B.AQUIFER); // an edit, floating: not natural ground
    expect(world.isNaturalGround(0, 10, 0)).toBe(false);
    expect(isAnchorCell(world, 0, 10, 0)).toBe(true);
    world.setBlock(1, 10, 0, B.STONE);
    expect(isAnchorCell(world, 1, 10, 0)).toBe(false);
    // buried in aquifer: every candidate cell is the aquifer or bedrock — the items are lost rather than the rock dug
    const get = (_q, y, _r) => (y === 0 ? B.BEDROCK : B.AQUIFER);
    expect(chooseBelongingsCell(get, 0, 5, 0)).toBeNull();
    const mixed = (q, y, r) => (q === 1 && y === 5 && r === 0 ? B.STONE : B.AQUIFER);
    expect(chooseBelongingsCell(mixed, 0, 5, 0)).toEqual([1, 5, 0]);
  });

  it('commands set it and set over it (bedrock is neither placed nor replaced)', () => {
    const world = makeFakeWorld({ groundY: G });
    const player = createPlayer(...hexToWorld(20, 20).flatMap((v, i) => (i === 0 ? [v, G + 1] : [v])));
    const ctx = { world, player, say: () => {} };
    const exec = (line) => executeCommand(/** @type {*} */ (parseLine(line)), /** @type {*} */ (ctx));
    expect(exec(`setblock 0 ${G} 0 aquifer`)).toEqual({ ok: true, message: `set aquifer at (0, ${G}, 0)` });
    expect(world.getBlock(0, G, 0)).toBe(B.AQUIFER);
    expect(exec(`setblock 0 ${G} 0 stone`).ok).toBe(true);
    expect(world.getBlock(0, G, 0)).toBe(B.STONE);
    expect(exec(`setblock 0 ${G} 0 bedrock`).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

/** sha1 of the blocks, biomes and heights of the 9 × 9 chunks round the origin, as worldgenHomestead.test.js takes them. */
function digest(seed, gen) {
  const g = createWorldGen(seed, { gen });
  const h = createHash('sha1');
  for (let cq = -4; cq <= 4; cq++) {
    for (let cr = -4; cr <= 4; cr++) {
      const c = g.generateChunk(cq, cr);
      h.update(Buffer.from(c.blocks));
      h.update(Buffer.from(c.biomes));
      h.update(Buffer.from(c.heights));
    }
  }
  return h.digest('hex');
}

/** Generation 5's digests at 68227cf, the commit §89 starts from (1–4 are pinned in worldgenHomestead.test.js too). */
const GEN5_DIGESTS = {
  'caelancraft-test': '7ae522634ef684a3547710f89e6ab263148b7570',
  4242: 'cae290d5a6b809cbc752ba655aeb97a2ff3ec341',
  homestead: 'a2f394d470d20e1048265f9e406a42558e49f62b',
};
const GEN1_4_DIGESTS = {
  'caelancraft-test': ['78cc2c6617fa5e60f97edf067c9d6b579d6547c4', '86c61a5c42ea35daf6823909d6d1e4b52f5e7d86', '2a59116110c487e1edd6b92b2d1bb82e75c281bc', '104dae6aa63723859dcd0ae7f3c5c23e1558be85'],
  4242: ['01d3d36d0e8f773e826216a8f0206d41c3888cdb', '7c9407ccfddcf1a9466af38aa9ab02d59563db5f', 'b03e6c6aefb1e6e0753661db1bd96eef3ac7edc1', 'b577abdbcb5c4f7b371910fa20f4340ef68a2624'],
  homestead: ['3c168568399f18c02e95e66f9ac95ad8d86e88dd', 'ed580564531568c5bd273b689797312a2d6a4a2a', 'd5441e10d42ceca5b2c16054b0eb4adf0667a896', 'b586f25359b120d81270f8c3fa4982115161f3f5'],
};

const SEED = 4242;
const N = 6; // the measured land: the 13 × 13 chunks round the origin
const gen5 = createWorldGen(SEED, { gen: 5 });
const gen6 = createWorldGen(SEED, { gen: 6 });

/** Generation 5 and 6 of the measured land, with every difference and every aquifer site. */
const LAND = (() => {
  const out = { diff: /** @type {number[][]} */ ([]), sites: /** @type {import('../../src/worldgen.js').AquiferSite[]} */ ([]), chunks: new Map() };
  for (let cq = -N; cq <= N; cq++) {
    for (let cr = -N; cr <= N; cr++) {
      const a = gen5.generateChunk(cq, cr);
      const b = gen6.generateChunk(cq, cr);
      out.chunks.set(`${cq},${cr}`, b);
      for (let i = 0; i < a.blocks.length; i++) {
        if (a.blocks[i] === b.blocks[i]) continue;
        const y = i % WORLD_HEIGHT;
        const col = (i - y) / WORLD_HEIGHT;
        const lr = col % CHUNK_SIZE;
        out.diff.push([cq * CHUNK_SIZE + (col - lr) / CHUNK_SIZE, y, cr * CHUNK_SIZE + lr, a.blocks[i], b.blocks[i]]);
      }
      out.sites.push(...gen6.aquifersIn(cq, cr));
    }
  }
  return out;
})();
/** The generation-6 block at (q, y, r) of the measured land. */
function at6(q, y, r) {
  const cq = Math.floor(q / CHUNK_SIZE);
  const cr = Math.floor(r / CHUNK_SIZE);
  const c = LAND.chunks.get(`${cq},${cr}`);
  return c.blocks[((q - cq * CHUNK_SIZE) * CHUNK_SIZE + (r - cr * CHUNK_SIZE)) * WORLD_HEIGHT + y];
}
const inLand = (q, r) => q >= -N * CHUNK_SIZE && q < (N + 1) * CHUNK_SIZE && r >= -N * CHUNK_SIZE && r < (N + 1) * CHUNK_SIZE;

describe('where it is: generation 6 (worldgen.js, GEN_LATEST 6)', () => {
  it('generations 1–5 are byte for byte what they were before §89 (digests of 81 chunks, three seeds)', () => {
    expect(GEN_LATEST).toBe(6);
    for (const seed of ['caelancraft-test', 4242, 'homestead']) {
      expect([1, 2, 3, 4, 5].map((g) => digest(seed, g)), String(seed)).toEqual([...GEN1_4_DIGESTS[seed], GEN5_DIGESTS[seed]]);
    }
    for (const g of [1, 2, 3, 4, 5]) expect(createWorldGen(SEED, { gen: g }).aquifersIn(0, 0)).toEqual([]);
    expect(createWorldGen(SEED, { gen: 9 }).gen).toBe(6);
  });

  it('generation 6 is generation 5 with aquifers: the two differ in exactly the cells aquifersIn lists, each AQUIFER in place of solid ground', () => {
    expect(LAND.sites.length).toBeGreaterThanOrEqual(10); // (seed 4242: 6 stream heads, 3 springs, 1 pond)
    expect(LAND.diff.length).toBe(LAND.sites.length);
    const sites = new Set(LAND.sites.map((s) => `${s.q},${s.y},${s.r}`));
    for (const [q, y, r, was, now] of LAND.diff) {
      expect(sites.has(`${q},${y},${r}`), `${q},${y},${r}`).toBe(true);
      expect(now).toBe(B.AQUIFER);
      expect(isSolid(was), `${q},${y},${r} was ${BLOCKS[was].name}`).toBe(true);
    }
    // every chunk lists its own, and the same from wherever it is asked
    expect(new Set(LAND.sites.map((s) => `${s.q},${s.y},${s.r}`)).size).toBe(LAND.sites.length);
    for (const s of LAND.sites) {
      expect(gen6.aquifersIn(Math.floor(s.q / CHUNK_SIZE), Math.floor(s.r / CHUNK_SIZE))).toContainEqual(s);
    }
    expect(new Set(LAND.sites.map((s) => s.kind))).toEqual(new Set(['stream', 'spring', 'pond']));
  });

  it('under every stream head: the floor of the head column, under its water (and the falling water of a lip)', () => {
    let heads = 0;
    let lips = 0;
    const R = N * CHUNK_SIZE + STREAM_ASCENT;
    for (let kq = Math.floor(-R / STREAM_CELL) - 1; kq <= Math.floor((R + CHUNK_SIZE) / STREAM_CELL) + 1; kq++) {
      for (let kr = Math.floor(-R / STREAM_CELL) - 1; kr <= Math.floor((R + CHUNK_SIZE) / STREAM_CELL) + 1; kr++) {
        const head = gen6.streamHeadOf(kq, kr);
        if (head === null || !inLand(head.q, head.r)) continue;
        heads++;
        expect(gen6.streamLevelAt(head.q, head.r)).toBe(head.level);
        expect(gen5.streamHeadOf(kq, kr)).toEqual(head); // the same streams as generation 5
        // down the column from the head's water: falling water, then the aquifer
        expect(at6(head.q, head.level, head.r)).toBe(B.WATER);
        let y = head.level - 1;
        while (at6(head.q, y, head.r) === B.WATER_FALL) y--;
        if (y < head.level - 1) lips++;
        expect(at6(head.q, y, head.r), `head ${head.q},${head.r}`).toBe(B.AQUIFER);
        expect(LAND.sites).toContainEqual({ q: head.q, y, r: head.r, kind: 'stream' });
      }
    }
    expect(heads).toBeGreaterThan(5);
    expect(lips).toBeGreaterThan(0); // (some heads are lips: the aquifer lies under the falling water)
    expect(LAND.sites.filter((s) => s.kind === 'stream')).toHaveLength(heads);
    expect(gen5.streamHeadOf(1000, 1000) === null || typeof gen5.streamHeadOf(1000, 1000) === 'object').toBe(true);
    expect(createWorldGen(SEED, { gen: 2 }).streamHeadOf(0, 0)).toBeNull(); // no streams below generation 3
  });

  it('under every natural spring: the block under the SPRING', () => {
    let springs = 0;
    const R = N * CHUNK_SIZE + 6;
    for (let kq = Math.floor(-R / NATURAL_SPRING_CELL); kq <= Math.floor((R + CHUNK_SIZE) / NATURAL_SPRING_CELL); kq++) {
      for (let kr = Math.floor(-R / NATURAL_SPRING_CELL); kr <= Math.floor((R + CHUNK_SIZE) / NATURAL_SPRING_CELL); kr++) {
        const sp = gen6.naturalSpringOf(kq, kr);
        if (sp === null || !inLand(sp.q, sp.r)) continue;
        springs++;
        expect([at6(sp.q, sp.y, sp.r), at6(sp.q, sp.y - 1, sp.r)]).toEqual([B.SPRING, B.AQUIFER]);
        expect(LAND.sites).toContainEqual({ q: sp.q, y: sp.y - 1, r: sp.r, kind: 'spring' });
      }
    }
    expect(springs).toBeGreaterThanOrEqual(3);
    expect(LAND.sites.filter((s) => s.kind === 'spring')).toHaveLength(springs);
  });

  it('under the middle of one fresh pond in three (never a tainted or a frozen one), in place of its clay', () => {
    const s = normalizeSeed(SEED);
    let fresh = 0;
    let onAquifer = 0;
    let measured = 0;
    for (let kq = -40; kq < 40; kq++) {
      for (let kr = -40; kr < 40; kr++) {
        const h = hash2(kq, kr, s ^ POND_SALT);
        const pq = kq * POND_CELL + 2 + (h & 7);
        const pr = kr * POND_CELL + 2 + ((h >>> 3) & 7);
        if (!gen6.pondAt(pq, pr)) continue;
        const frozen = gen6.getColumn(pq, pr).biome === BIOME.SNOWY;
        const tainted = gen6.pondTaintedAt(pq, pr);
        const roll = rand3(kq, POND_AQUIFER_SALT, kr, s ^ POND_SALT) < POND_AQUIFER_SHARE;
        const want = !frozen && !tainted && roll;
        if (!frozen && !tainted) fresh++;
        if (want) onAquifer++;
        if (!inLand(pq, pr)) continue;
        // in the measured land: the chunk has exactly that, and a pond on an aquifer is fresh water
        measured++;
        const H = gen6.getColumn(pq, pr).height;
        const site = { q: pq, y: H - 1, r: pr, kind: 'pond' };
        if (want) {
          expect(LAND.sites).toContainEqual(site);
          expect([at6(pq, H, pr), at6(pq, H - 1, pr)]).toEqual([B.WATER, B.AQUIFER]);
          for (const [q, r] of pondCells(pq, pr)) if (q !== pq || r !== pr) expect(at6(q, H - 1, r)).toBe(B.CLAY);
        } else {
          expect(LAND.sites).not.toContainEqual(site);
        }
      }
    }
    expect(POND_AQUIFER_SHARE).toBeCloseTo(1 / 3, 12);
    expect(fresh).toBeGreaterThan(150);
    expect(onAquifer / fresh).toBeGreaterThan(0.27);
    expect(onAquifer / fresh).toBeLessThan(0.4);
    expect(measured).toBeGreaterThan(8);
    for (const site of LAND.sites.filter((x) => x.kind === 'pond')) {
      expect(gen6.pondTaintedAt(site.q, site.r)).toBe(false);
      expect(at6(site.q, site.y + 1, site.r)).toBe(B.WATER);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the flow, the target and the floor (waterBodies.js)', () => {
  it('constants: 12 cell-levels a game hour in the rains, 3 in the dry season, a straight line between; full below dryness 0.65, low from it; never below shallow', () => {
    expect(AQUIFER_FLOW).toEqual({ rains: 12, dry: 3 });
    expect(AQUIFER_HOUR_S).toBe(60);
    expect(AQUIFER_FULL_BELOW).toBeCloseTo(0.65, 12);
    expect(AQUIFER_FLOOR).toBe(1);
    expect(AQUIFER_NEAR_MAX).toBe(256);
    expect([aquiferFlow(DRYNESS_RAINS), aquiferFlow(DRYNESS_DRY), aquiferFlow(0), aquiferFlow(5), aquiferFlow(NaN)]).toEqual([12, 3, 12, 3, 3]);
    expect(aquiferFlow(0.65)).toBeCloseTo(7.5, 12); // half way
    expect([aquiferTarget(0.3), aquiferTarget(0.64), aquiferTarget(0.65), aquiferTarget(1), aquiferTarget(NaN)]).toEqual([3, 3, 2, 2, 2]);
  });

  it('what an aquifer feeds: the fresh pool on it, the dry basin on it, the stream in its column; a tainted pool, a block over it: nothing', () => {
    const w = grid(10);
    aquiferPond(w, B.WATER_LOW);
    expect(aquiferFeeds(w, 0, G - 1, 0)).toEqual({ kind: 'pool', y: G, open: false });
    const t = grid(10);
    aquiferPond(t, B.TAINTED_WATER);
    expect(aquiferFeeds(t, 0, G - 1, 0).kind).toBe('none');
    const b = grid(10);
    aquiferBasin(b, 1);
    expect(aquiferFeeds(b, 0, G - 1, 0)).toEqual({ kind: 'basin', y: G, open: true });
    b.set(0, G, 0, B.SPRING);
    expect(aquiferFeeds(b, 0, G - 1, 0).kind).toBe('none');
    // a stream's head over a lip: the falling water is looked through
    const s = grid(10);
    s.gen(0, 1, 0, B.AQUIFER);
    for (let y = 2; y < 6; y++) s.gen(0, y, 0, B.WATER_FALL);
    s.gen(0, 6, 0, B.WATER);
    s.spring(0, 6, 0);
    expect(aquiferFeeds(s, 0, 1, 0)).toEqual({ kind: 'stream', y: 6, open: false });
    expect(aquiferUnder(s.peek, 0, 6, 0)).toBe(true);
    s.set(0, 6, 0, B.AIR);
    for (let y = 2; y < 6; y++) s.set(0, y, 0, B.AIR);
    expect(aquiferFeeds(s, 0, 1, 0)).toEqual({ kind: 'stream', y: 6, open: true });
  });

  it('one random() per aquifer that has something to feed; a pool gains a level in its shallowest cells below u < dt × flow / (N × hour)', () => {
    const w = grid(10);
    aquiferPond(w, B.WATER_SHALLOW);
    // the chance for seven cells in the rains: 12 / (7 × 60) a second
    const p7 = 12 / (7 * 60);
    expect(feedStep(1, seq(p7 * 0.99), w, RAINS, w.list)).toMatchObject([{ kind: 'feed', q: 0, y: G, r: 0, count: 7, stream: false, quality: 'fresh' }]);
    expect(feedStep(1, seq(p7 * 1.01), w, RAINS, w.list)).toEqual([]);
    const ev = feedStep(1, seq(0), w, RAINS, w.list)[0];
    expect(ev.writes).toHaveLength(7 * 4);
    w.apply(ev.writes);
    expect(w.ids(pondCells())).toEqual(all(B.WATER_LOW));
    // one random() for it, none for an aquifer under a block or in an unloaded chunk
    let calls = 0;
    const counted = () => (calls++, 0.999);
    w.gen(5, G - 1, 5, B.AQUIFER); // buried in the ground
    feedStep(1, counted, w, RAINS, [...w.list, 500, G, 500]);
    expect(calls).toBe(1);
    // a body at two depths gains a level in its shallower cells only: it comes out even
    w.set(1, G, 0, B.WATER);
    w.set(0, G, 1, B.WATER);
    const two = feedStep(1, seq(0), w, RAINS, w.list)[0];
    expect(two.writes.length / 4).toBe(5);
    w.apply(two.writes);
    expect(w.ids(pondCells())).toEqual(all(B.WATER));
    expect(feedStep(1, seq(0), w, RAINS, w.list)).toEqual([]); // full: at its target in the rains
  });

  it('by simulation: a basin of 1, 7 and 19 cells dug on an aquifer fills in N / flow hours a level — fast when small, slowly when big; rains against dry season', () => {
    const rnd = mulberry32(89);
    /** Mean seconds for a dry basin of `radius` to stand at the season's target, over `trials` runs. */
    const fill = (radius, env, trials) => {
      const target = aquiferTarget(env.dryness());
      let total = 0;
      const w = grid(4);
      const cells = aquiferBasin(w, radius);
      for (let t = 0; t < trials; t++) {
        for (const [q, r] of cells) w.set(q, G, r, B.AIR);
        let s = 0;
        while (!w.ids(cells).every((id) => waterDepth(id) === target)) {
          for (const ev of feedStep(1, rnd, w, env, w.list)) w.apply(ev.writes);
          s++;
          if (s > 100000) throw new Error('never filled');
        }
        total += s;
      }
      return total / trials;
    };
    // the prediction: three levels (the seep, then two) in the rains, two in the dry season, each N / flow game hours
    const want = (n, levels, flow) => (levels * n * AQUIFER_HOUR_S) / flow;
    const cases = [
      [0, 1, 400], [1, 7, 300], [2, 19, 160],
    ];
    const got = {};
    for (const [radius, n, trials] of cases) {
      const rains = fill(radius, RAINS, trials);
      const dry = fill(radius, DRY, trials);
      got[n] = [Math.round(rains), Math.round(dry)];
      expect(rains / want(n, 3, 12), `${n} cells, the rains`).toBeGreaterThan(0.85);
      expect(rains / want(n, 3, 12), `${n} cells, the rains`).toBeLessThan(1.15);
      expect(dry / want(n, 2, 3), `${n} cells, the dry season`).toBeGreaterThan(0.85);
      expect(dry / want(n, 2, 3), `${n} cells, the dry season`).toBeLessThan(1.15);
    }
    // 15 s, 105 s and 285 s to full in the rains; 40 s, 280 s and 760 s to low in the dry season
    expect([want(1, 3, 12), want(7, 3, 12), want(19, 3, 12), want(1, 2, 3), want(7, 2, 3), want(19, 2, 3)]).toEqual([15, 105, 285, 40, 280, 760]);
    expect(got[19][0]).toBeGreaterThan(got[7][0]);
    expect(got[7][0]).toBeGreaterThan(got[1][0]);
  });

  it('the seasonal target: full in the rains, low in the dry season — the sun dries it to its target and no lower', () => {
    const w = grid();
    aquiferPond(w, B.WATER);
    // the dry season: the sun takes it from full to low (above the target), then no further
    const ev = cycleStep(1, seq(MIDDLE, 0), w, DRY);
    expect(ev).toMatchObject({ kind: 'dry', count: 7 });
    w.apply(ev.writes);
    expect(w.ids(pondCells())).toEqual(all(B.WATER_LOW));
    for (let i = 0; i < 200; i++) expect(cycleStep(1, seq(MIDDLE, 0), w, DRY)).toBeNull();
    expect(w.ids(pondCells())).toEqual(all(B.WATER_LOW));
    // …nor does the aquifer raise it in the dry season
    expect(feedStep(1, seq(0), w, DRY, w.list)).toEqual([]);
    // the rains come: it rises to full
    w.apply(feedStep(1, seq(0), w, RAINS, w.list)[0].writes);
    expect(w.ids(pondCells())).toEqual(all(B.WATER));
    // a pond with no aquifer dries on, to nothing
    const c = grid();
    for (const [q, r] of pondCells()) {
      c.gen(q, G, r, B.WATER_SHALLOW);
      c.gen(q, G - 1, r, B.CLAY);
    }
    const gone = cycleStep(1, seq(MIDDLE, 0), c, DRY);
    expect(gone.writes.filter((_, i) => i % 4 === 3)).toEqual(all(B.AIR));
  });

  it('the shallow floor: drink it hard and it stops at shallow, then the aquifer brings it back', () => {
    const w = grid(10);
    aquiferPond(w, B.WATER);
    const depths = [];
    for (let i = 0; i < 6; i++) {
      const d = drawWater(w, 0, G, 0, POT_GULPS, () => 0); // (every take drops a level)
      w.apply(d.writes);
      depths.push(waterDepth(w.peek(0, G, 0)));
    }
    expect(depths).toEqual([2, 1, 1, 1, 1, 1]);
    const last = drawWater(w, 0, G, 0, POT_GULPS, () => 0);
    expect(last).toMatchObject({ body: null, dropped: false, writes: [] }); // still water to drink: the aquifer pays
    expect(last.info.quality).toBe('fresh');
    // and it comes back: low in the dry season, full in the rains
    w.apply(feedStep(1, seq(0), w, DRY, w.list)[0].writes);
    expect(w.ids(pondCells())).toEqual(all(B.WATER_LOW));
    expect(feedStep(1, seq(0), w, DRY, w.list)).toEqual([]);
    w.apply(feedStep(1, seq(0), w, RAINS, w.list)[0].writes);
    expect(w.ids(pondCells())).toEqual(all(B.WATER));
    // the same pond with no aquifer is drunk dry
    const c = grid(10);
    for (const [q, r] of pondCells()) c.gen(q, G, r, B.WATER_SHALLOW);
    expect(drawWater(c, 0, G, 0, POT_GULPS, () => 0).writes.filter((_, i) => i % 4 === 3)).toEqual(all(B.AIR));
  });

  it('fed water is fresh: a tainted pool on an aquifer gets nothing and dries like any; once it is gone the basin takes fresh water', () => {
    const w = grid();
    aquiferPond(w, B.TAINTED_WATER_SHALLOW);
    const body = waterBodyAt(w.peek, 0, G, 0, null);
    expect(bodyFed(w, body)).toBe(false);
    expect(feedStep(1, seq(0), w, RAINS, w.list)).toEqual([]);
    expect(drawWater(w, 0, G, 0, POT_GULPS, () => 0).dropped).toBe(true); // not held at shallow: it is not fed
    const ev = cycleStep(1, seq(MIDDLE, 0), w, DRY);
    expect(ev.kind).toBe('dry');
    w.apply(ev.writes);
    expect(w.ids(pondCells())).toEqual(all(B.AIR));
    const seep = feedStep(1, seq(0), w, RAINS, w.list)[0];
    expect(seep).toMatchObject({ kind: 'seep', count: 7, quality: 'fresh' });
    w.apply(seep.writes);
    expect(w.ids(pondCells())).toEqual(all(B.WATER_SHALLOW));
    expect(isTaintedWater(w.peek(0, G, 0))).toBe(false);
  });

  it('a basin: AIR on the aquifer, every cell on a floor, every outside side solid, at most 128 cells; open, it is none', () => {
    const w = grid(12);
    aquiferBasin(w, 1);
    expect(aquiferBasinAt(w, 0, G, 0)).toMatchObject({ count: 7, tainted: false });
    expect(aquiferBasinAt(w, 1, G, 0)).toBeNull(); // not on the aquifer itself
    w.set(2, G, 0, B.AIR); // a gap in the wall, over a floor: the basin grows into it and its next cell is the ground
    expect(aquiferBasinAt(w, 0, G, 0)).toMatchObject({ count: 8 });
    w.set(2, G - 1, 0, B.AIR); // …now the gap has no floor: water would run away
    expect(aquiferBasinAt(w, 0, G, 0)).toBeNull();
    w.set(2, G, 0, B.STONE);
    w.set(1, G + 1, 0, B.STONE); // (what is above does not matter)
    expect(aquiferBasinAt(w, 0, G, 0)).toMatchObject({ count: 7 });
    w.set(-2, G, 0, B.TORCH); // a torch in the wall does not hold water
    expect(aquiferBasinAt(w, 0, G, 0)).toBeNull();
    // larger than 128 cells: none
    const big = grid(12);
    aquiferBasin(big, 6); // 127 cells
    expect(aquiferBasinAt(big, 0, G, 0).count).toBe(127);
    big.set(7, G, 0, B.AIR);
    big.set(7, G, -1, B.AIR);
    expect(aquiferBasinAt(big, 0, G, 0)).toBeNull();
  });
});

describe('on the real rule (blockphysics.js): a basin dug on an aquifer fills and holds; an open one does not', () => {
  /** A fake world with an aquifer at (0, G − 1, 0) as generated, the physics on it, and the cycle's view of it. */
  function world0() {
    const world = makeFakeWorld({ groundY: G });
    world.put(0, G - 1, 0, B.AQUIFER);
    const physics = attachPhysics(world, BlockPhysics);
    const w = { peek: world.peekBlock, originAt: world.originAt, springLevelAt: physics.fluids.springLevelAt, isLoadedCell: () => true, q: 0, r: 0, top: 20 };
    return { world, physics, w, list: [0, G - 1, 0] };
  }

  it('dug by hand round an aquifer, seven cells with whole walls: it takes water and rises to full in the rains, and the laws leave it be', () => {
    const { world, physics, w, list } = world0();
    for (const [q, r] of pondCells()) world.setBlock(q, G, r, B.AIR);
    rest(physics);
    const rnd = mulberry32(5);
    const kinds = [];
    for (let s = 0; s < 3000 && pondCells().some(([q, r]) => world.getBlock(q, G, r) !== B.WATER); s++) {
      for (const ev of feedStep(1, rnd, w, RAINS, list)) {
        kinds.push(ev.kind);
        applyWaterWrites(world, ev.writes);
        rest(physics);
      }
    }
    expect(kinds).toEqual(['seep', 'feed', 'feed']);
    expect(pondCells().map(([q, r]) => world.getBlock(q, G, r))).toEqual(all(B.WATER));
    expect([physics.fluids.stats.spilled, physics.fluids.stats.moved]).toEqual([0, 0]); // it stands: nothing ran out
  });

  it('a gap in its wall: it spills dry by the laws, and the aquifer gives nothing until the wall is whole again', () => {
    const { world, physics, w, list } = world0();
    for (const [q, r] of pondCells()) world.setBlock(q, G, r, B.AIR);
    world.setBlock(2, G, 0, B.AIR);
    world.setBlock(2, G - 1, 0, B.AIR); // the gap opens on a drop
    rest(physics);
    expect(aquiferBasinAt(w, 0, G, 0)).toBeNull();
    for (let s = 0; s < 600; s++) expect(feedStep(1, mulberry32(s), w, RAINS, list)).toEqual([]);
    // water poured into it runs out (the laws hold, fed or not)
    for (const [q, r] of pondCells()) world.setBlock(q, G, r, B.WATER);
    rest(physics);
    expect(pondCells().every(([q, r]) => world.getBlock(q, G, r) === B.AIR)).toBe(true);
    // mended: it fills
    world.setBlock(2, G, 0, B.STONE);
    rest(physics);
    expect(feedStep(1, seq(0), w, RAINS, list)[0].kind).toBe('seep');
  });

  it('a stream\'s head over an aquifer is kept in a drought (generation 6); a stream with none keeps its three highest cells (generations 3–5)', () => {
    const w = grid(16);
    // a stream of eight cells stepping down from (0, 9, 0) eastward, its head on an aquifer
    const cells = [];
    for (let i = 0; i < 8; i++) {
      const y = 9 - Math.floor(i / 2);
      for (let yy = G + 1; yy < y; yy++) w.gen(i, yy, 0, B.STONE);
      w.gen(i, y, 0, B.WATER_SHALLOW);
      w.spring(i, y, 0);
      cells.push([i, y, 0]);
    }
    w.gen(0, 7, 0, B.AQUIFER);
    w.gen(0, 8, 0, B.WATER_FALL); // the head is a lip: falling water down to the aquifer
    const body = waterBodyAt(w.peek, 3, cells[3][1], 0, w.springLevelAt);
    expect(body.stream).toBe(true);
    expect(bodyFed(w, body)).toBe(true);
    const writes = streamDryWrites(w, body);
    expect(writes.length / 4).toBe(7);
    expect(writes.filter((_, i) => i % 4 === 0)).not.toContain(0); // the head (q 0) stays
    w.apply(writes);
    expect(w.peek(0, 9, 0)).toBe(B.WATER_SHALLOW);
    const head = waterBodyAt(w.peek, 0, 9, 0, w.springLevelAt);
    expect(streamDryWrites(w, head)).toEqual([]); // only its head: it loses nothing more
    // the same stream without the aquifer keeps its STREAM_HEAD_CELLS highest
    w.set(0, 7, 0, B.STONE);
    for (const [q, y, r] of cells) w.set(q, y, r, B.WATER_SHALLOW);
    const old = streamDryWrites(w, waterBodyAt(w.peek, 3, cells[3][1], 0, w.springLevelAt));
    expect(STREAM_HEAD_CELLS).toBe(3);
    expect(old.length / 4).toBe(8 - STREAM_HEAD_CELLS);
    // an emptied head over its aquifer takes shallow running water again, whatever the weather
    w.set(0, 7, 0, B.AQUIFER);
    w.set(0, 8, 0, B.AIR);
    w.set(0, 9, 0, B.AIR);
    const ev = feedStep(1, seq(0), w, DRY, [0, 7, 0]);
    expect(ev).toMatchObject([{ kind: 'seep', q: 0, y: 9, r: 0, count: 1, stream: true, writes: [0, 9, 0, B.WATER_SHALLOW] }]);
    // a stream standing there is not raised by the flow: it follows the rain
    w.apply(ev[0].writes);
    expect(feedStep(1, seq(0), w, RAINS, [0, 7, 0])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

/** A generation-6 World of SEED loaded round column (q, r), with block physics. */
function realWorld(q, r, renderDistance = 3, edits = undefined) {
  const world = new World({ seed: SEED, gen: 6, renderDistance, now: () => 0, edits });
  const physics = attachPhysics(world, BlockPhysics);
  const [x, z] = hexToWorld(q, r);
  for (let i = 0; i < 6000; i++) {
    const u = world.update(x, z, Infinity);
    if (u.pendingGen === 0 && u.pendingMesh === 0) break;
  }
  const cw = {
    peek: (a, b, c) => world.peekBlock(a, b, c),
    originAt: (a, b, c) => world.originAt(a, b, c),
    isLoadedCell: (a, b) => world.hasChunkAtCell(a, b),
    springLevelAt: physics.fluids.springLevelAt,
    chunkBlocks: (cq, cr) => world.getChunk(cq, cr)?.blocks ?? null,
    q,
    r,
  };
  return { world, physics, cw };
}

describe('in a real generation-6 world: the index, saving and loading, what a second costs', () => {
  const pond = LAND.sites.find((s) => s.kind === 'pond');
  const head = LAND.sites.find((s) => s.kind === 'stream');

  it('the cycle finds the aquifers in the loaded chunks (AquiferIndex), forgets a chunk that changed, and the stream head\'s is fed', () => {
    const { world, cw } = realWorld(head.q, head.r);
    const index = new AquiferIndex();
    const near = index.near(cw, head.q, head.r, CYCLE_RANGE);
    const listed = [];
    for (let i = 0; i < near.length; i += 3) listed.push(`${near[i]},${near[i + 1]},${near[i + 2]}`);
    expect(listed).toContain(`${head.q},${head.y},${head.r}`);
    for (const key of listed) {
      const [q, y, r] = key.split(',').map(Number);
      expect(world.peekBlock(q, y, r)).toBe(B.AQUIFER);
      expect(hexLength(q - head.q, r - head.r)).toBeLessThanOrEqual(CYCLE_RANGE);
    }
    // every generated aquifer of the loaded land within range is found
    for (const s of LAND.sites) {
      if (hexLength(s.q - head.q, s.r - head.r) <= CYCLE_RANGE && world.hasChunkAtCell(s.q, s.r)) expect(listed).toContain(`${s.q},${s.y},${s.r}`);
    }
    // one set by a command is found once its chunk is forgotten (main: World.onBlockChange → WaterCycle.onBlockChange)
    const cycle = new WaterCycle();
    cycle.aquifers = index;
    world.setBlock(head.q + 2, 100, head.r, B.AQUIFER);
    expect(index.near(cw, head.q, head.r, 4)).not.toContain(100);
    cycle.onBlockChange(head.q + 2, 100, head.r, B.AIR, B.AQUIFER);
    expect(index.near(cw, head.q, head.r, 4)).toContain(100);
    // the stream over the head's aquifer is fed
    const level = cw.springLevelAt(head.q, head.r);
    const body = waterBodyAt(cw.peek, head.q, level, head.r, cw.springLevelAt);
    expect(body.stream).toBe(true);
    expect(bodyFed(cw, body)).toBe(true);
    expect(aquiferInfo(cw, head.q, head.y, head.r, DRY)).toMatchObject({ feeds: 'stream', target: AQUIFER_FLOOR, fed: true });
    expect(aquiferInfo(cw, head.q, head.y, head.r, DRY).cells).toBe(body.count);
  });

  it('a generation-6 pond on its aquifer: drunk down to shallow it stops; the cycle feeds it back; the edits save and load, the aquifer is no edit', () => {
    expect(pond).toBeTruthy();
    const { world, physics, cw } = realWorld(pond.q, pond.r, 2);
    expect(world.peekBlock(pond.q, pond.y, pond.r)).toBe(B.AQUIFER);
    expect(world.hasEdit(pond.q, pond.y, pond.r)).toBe(false);
    const y = pond.y + 1;
    expect(aquiferInfo(cw, pond.q, pond.y, pond.r, RAINS)).toEqual({ q: pond.q, y: pond.y, r: pond.r, feeds: 'pool', cells: 7, depth: 3, target: 3, fed: true });
    for (let i = 0; i < 4; i++) applyWaterWrites(world, drawWater(cw, pond.q, y, pond.r, POT_GULPS, () => 0).writes);
    rest(physics);
    expect(pondCells(pond.q, pond.r).map(([q, r]) => world.getBlock(q, y, r))).toEqual(all(B.WATER_SHALLOW));
    // the cycle, as main runs it: the aquifers round the player, found in the loaded chunks
    const cycle = new WaterCycle();
    const rnd = mulberry32(3);
    for (let s = 0; s < 600 && world.getBlock(pond.q, y, pond.r) !== B.WATER_LOW; s++) {
      for (const ev of cycle.feed(1, rnd, cw, DRY)) applyWaterWrites(world, ev.writes);
    }
    expect(cycle.fed).toBe(1);
    rest(physics);
    expect(pondCells(pond.q, pond.r).map(([q, r]) => world.getBlock(q, y, r))).toEqual(all(B.WATER_LOW));
    expect(cycle.events).toBe(1);
    // saved and loaded: the pond keeps its depth, the aquifer is generated again, and feeds again
    const saved = world.exportEdits();
    const again = realWorld(pond.q, pond.r, 2, saved);
    expect(again.world.peekBlock(pond.q, pond.y, pond.r)).toBe(B.AQUIFER);
    expect(pondCells(pond.q, pond.r).map(([q, r]) => again.world.getBlock(q, y, r))).toEqual(all(B.WATER_LOW));
    const ev = feedStep(1, seq(0), again.cw, RAINS, [pond.q, pond.y, pond.r]);
    expect(ev).toMatchObject([{ kind: 'feed', count: 7 }]);
    applyWaterWrites(again.world, ev[0].writes);
    expect(again.world.editCount).toBe(0); // full again: back as generated, every edit pruned
  });

  it('a second of the aquifers round the player costs a few microseconds; the first look at 50 chunks well under 10 ms', () => {
    const { cw } = realWorld(head.q, head.r);
    const cycle = new WaterCycle();
    const rnd = mulberry32(11);
    const t0 = performance.now();
    cycle.feed(1, rnd, cw, RAINS); // (scans the loaded chunks once)
    const first = performance.now() - t0;
    let best = Infinity;
    for (let batch = 0; batch < 5; batch++) {
      const t1 = performance.now();
      for (let i = 0; i < 400; i++) cycle.feed(1, rnd, cw, i % 2 ? RAINS : DRY);
      best = Math.min(best, (performance.now() - t1) / 400);
    }
    expect(first).toBeLessThan(10);
    expect(best).toBeLessThan(0.1); // ms a second (a few µs on a quiet machine)
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the wiring (main.js, diagnostics.js, types.js): read from the source, since main needs a browser', () => {
  const read = (name) => readFileSync(fileURLToPath(new URL(`../../src/${name}`, import.meta.url)), 'utf8');
  const main = read('main.js');
  const body = (name) => {
    const at = main.indexOf(`  function ${name}(`);
    expect(at, name).toBeGreaterThan(0);
    return main.slice(at, main.indexOf('\n  }\n', at));
  };

  it('every water second runs the aquifers round the player after the cycle, and writes what they give lazily', () => {
    const ws = body('waterSecond');
    expect(ws.indexOf('aquiferSecond(dt, random, q, r, env)')).toBeGreaterThan(ws.indexOf('waterCycle.step('));
    const as = body('aquiferSecond');
    expect(as).toContain('waterCycle.feed(dt, random, aquiferWorld(q, r), env)');
    expect(as).toContain('applyWaterWrites(world, ev.writes)');
    expect(body('aquiferWorld')).toContain('chunkBlocks: (cq, cr) => world.getChunk(cq, cr)?.blocks ?? null');
    expect(body('onBlockChanged')).toContain('waterCycle.onBlockChange(q, y, r, prev, next);');
  });

  it('the debug handle: aquiferNear(radius) and waterStep (which runs the feeding, and counts it)', () => {
    const game0 = main.slice(main.indexOf('  const game = {'));
    const stepSrc = game0.slice(game0.indexOf('    waterStep(seconds, env) {'), game0.indexOf('    aquiferNear: (radius) => aquiferNear(radius),'));
    expect(stepSrc).toContain('waterSecond(1, Math.random, weather)');
    expect(stepSrc).toContain('total.fed = waterCycle.fed - fed0;');
    expect(stepSrc).toContain('total.seeped = waterCycle.seeped - seeped0;');
    const near = body('aquiferNear');
    expect(near).toContain('waterCycle.aquifers.near(w, q, r, R)');
    expect(near).toContain('aquiferInfo(w, cells[i], cells[i + 1], cells[i + 2], waterEnv)');
    expect(near).toContain('Math.min(AQUIFER_NEAR_MAX');
    const calls = [];
    const game = { aquiferNear: (radius) => (calls.push(radius), [{ q: 1, y: 2, r: 3, feeds: 'pool', cells: 7, depth: 2, target: 3, fed: true, distance: 4 }]) };
    const handle = installDebugHandle({}, /** @type {*} */ (game));
    expect(handle.aquiferNear(20)).toEqual([{ q: 1, y: 2, r: 3, feeds: 'pool', cells: 7, depth: 2, target: 3, fed: true, distance: 4 }]);
    expect(calls).toEqual([20]);
    expect(installDebugHandle({}, null).aquiferNear(5)).toBeNull();
    const types = read('types.js');
    const ctx = types.slice(types.indexOf('@typedef {Object} GameContext'));
    expect(ctx).toMatch(/@property \{[^\n]*\} \[aquiferNear\]/);
  });
});
