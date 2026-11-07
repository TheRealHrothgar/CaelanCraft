// Shared test fixtures. See src/CONTRACTS.md §24.
import { CHUNK_AREA, CHUNK_VOLUME, CHUNK_SIZE, WORLD_HEIGHT } from '../../src/config.js';
import { chunkKey, localIndex, columnIndex } from '../../src/coords.js';
import { BLOCK, BIOME, UNLOADED, isSolid } from '../../src/blocks.js';
import { worldToHex } from '../../src/hex.js';

/**
 * getBlock over a Map keyed "q,y,r" → id (axial q, height y, axial r). Unknown cells return `fill`.
 * @param {Map<string, number>|Record<string, number>} map
 */
export function makeGetBlock(map, fill = BLOCK.AIR) {
  const m = map instanceof Map ? map : new Map(Object.entries(map));
  return (q, y, r) => {
    if (y < 0 || y >= WORLD_HEIGHT) return BLOCK.AIR;
    const v = m.get(`${q},${y},${r}`);
    return v === undefined ? fill : v;
  };
}

/** Zeroed ChunkData. */
export function makeChunkData() {
  return {
    blocks: new Uint8Array(CHUNK_VOLUME),
    biomes: new Uint8Array(CHUNK_AREA),
    heights: new Uint8Array(CHUNK_AREA),
  };
}

/**
 * getChunkData over a Map keyed chunkKey → ChunkData (or Chunk). Missing → null.
 * @param {Map<string, any>} chunks
 */
export function makeChunkDataGetter(chunks) {
  return (cx, cz) => chunks.get(chunkKey(cx, cz)) ?? null;
}

/** Convenience: set a block in a Map<chunkKey, ChunkData> by CELL coords (q, y, r), creating chunks on demand. */
export function setWorldBlock(chunks, q, y, r, id) {
  const cq = Math.floor(q / CHUNK_SIZE);
  const cr = Math.floor(r / CHUNK_SIZE);
  const key = chunkKey(cq, cr);
  let c = chunks.get(key);
  if (!c) {
    c = makeChunkData();
    chunks.set(key, c);
  }
  c.blocks[localIndex(q - cq * CHUNK_SIZE, y, r - cr * CHUNK_SIZE)] = id;
}

/** isSolidAt for an infinite flat floor: solid iff y <= groundY. */
export function flatIsSolid(groundY) {
  return (_q, y, _r) => y <= groundY;
}

/** getBlock for an infinite flat floor of `id` up to groundY (inclusive), AIR above. */
export function flatGetBlock(groundY, id = BLOCK.STONE) {
  return (_q, y, _r) => (y >= 0 && y <= groundY ? id : BLOCK.AIR);
}

/** Total faces (side quads and hexagonal caps alike) across all non-null layers of a ChunkMeshData. */
export function countFaces(chunkMesh) {
  let n = 0;
  for (const layer of [chunkMesh.opaque, chunkMesh.cutout, chunkMesh.translucent]) {
    if (layer) n += layer.faceCount;
  }
  return n;
}

/** A WorldGen that produces all-AIR chunks (heights 0, biome PLAINS); getColumn reports height 0. */
export function trivialWorldGen(seed = 1) {
  return {
    seed,
    getColumn: () => ({ height: 0, biome: BIOME.PLAINS, temperature: 0, humidity: 0 }),
    generateChunk: () => {
      const d = makeChunkData();
      d.biomes.fill(BIOME.PLAINS);
      return d;
    },
  };
}

/** A WorldGen producing a flat world: `id` for 0..groundY, AIR above, everywhere. */
export function flatWorldGen(groundY, id = BLOCK.STONE, seed = 1) {
  return {
    seed,
    getColumn: () => ({ height: groundY, biome: BIOME.PLAINS, temperature: 0, humidity: 0 }),
    generateChunk: () => {
      const d = makeChunkData();
      d.biomes.fill(BIOME.PLAINS);
      d.heights.fill(groundY);
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          const base = localIndex(lq, 0, lr);
          d.blocks.fill(id, base, base + groundY + 1);
          void columnIndex;
        }
      }
      return d;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Block physics (CONTRACTS §33): a Map-backed fake world with the physics surface of World.

/**
 * A fake World for block-physics tests: cells live in a Map (packed by "q,y,r"), "generated" terrain is a flat
 * `groundId` floor for y ≤ groundY, chunks are loaded unless `unload(cq, cr)` hid them (peekBlock → UNLOADED,
 * getBlock → AIR, setBlock → false). Edits, origins (pruning back to the origin) and editCount behave like World's;
 * every successful setBlock is logged in `writes` and fires `onBlockChange`. `load(cq, cr)` makes a chunk visible
 * again and fires `onChunkGenerated` like a regenerated chunk.
 * @param {{ groundY?: number, groundId?: number, seed?: number, now?: () => number }} [opts]
 */
export function makeFakeWorld(opts = {}) {
  const groundY = opts.groundY ?? -1;
  const groundId = opts.groundId ?? BLOCK.STONE;
  /** @type {Map<string, number>} */
  const cells = new Map();
  /** @type {Set<string>} */
  const unloaded = new Set();
  const key = (q, y, r) => `${q},${y},${r}`;
  const chunkOf = (q, r) => [Math.floor(q / CHUNK_SIZE), Math.floor(r / CHUNK_SIZE)];
  const loadedCell = (q, r) => {
    const [cq, cr] = chunkOf(q, r);
    return !unloaded.has(chunkKey(cq, cr));
  };
  const generated = (y) => (y >= 0 && y <= groundY ? groundId : BLOCK.AIR);
  const raw = (q, y, r) => {
    const v = cells.get(key(q, y, r));
    return v === undefined ? generated(y) : v;
  };
  const editKey = (q, y, r) => {
    const [cq, cr] = chunkOf(q, r);
    return [chunkKey(cq, cr), localIndex(q - cq * CHUNK_SIZE, y, r - cr * CHUNK_SIZE)];
  };
  const world = {
    seed: opts.seed ?? 1,
    /** @type {Map<string, Map<number, number>>} */
    edits: new Map(),
    /** @type {Map<string, Map<number, number>>} */
    origins: new Map(),
    editCount: 0,
    editVersion: 0,
    /** @type {{ q: number, y: number, r: number, id: number, lazy: boolean }[]} */
    writes: [],
    _now: opts.now ?? (() => 0),
    onBlockChange: (_q, _y, _r, _prev, _next) => {},
    onChunkGenerated: (_cq, _cr) => {},
    getBlock: (q, y, r) => (y >= 0 && y < WORLD_HEIGHT && loadedCell(q, r) ? raw(q, y, r) : BLOCK.AIR),
    peekBlock(q, y, r) {
      if (!(y >= 0 && y < WORLD_HEIGHT)) return BLOCK.AIR;
      return loadedCell(q, r) ? raw(q, y, r) : UNLOADED;
    },
    hasChunkAtCell: (q, r) => loadedCell(q, r),
    hasChunkAt(x, z) {
      const [q, r] = worldToHex(x, z);
      return loadedCell(q, r);
    },
    setBlock(q, y, r, id, lazy = false) {
      if (!(y >= 0 && y < WORLD_HEIGHT) || !loadedCell(q, r)) return false;
      const prev = raw(q, y, r);
      if (prev === id) return false;
      cells.set(key(q, y, r), id);
      const [ck, li] = editKey(q, y, r);
      let e = world.edits.get(ck);
      let o = world.origins.get(ck);
      if (e && e.has(li)) {
        if (o && o.get(li) === id) {
          e.delete(li);
          o.delete(li);
          world.editCount--;
        } else {
          e.set(li, id);
        }
      } else {
        if (!e) world.edits.set(ck, (e = new Map()));
        if (!o) world.origins.set(ck, (o = new Map()));
        e.set(li, id);
        o.set(li, prev);
        world.editCount++;
      }
      world.editVersion++;
      world.writes.push({ q, y, r, id, lazy });
      world.onBlockChange(q, y, r, prev, id);
      return true;
    },
    hasEdit(q, y, r) {
      const [ck, li] = editKey(q, y, r);
      return world.edits.get(ck)?.has(li) ?? false;
    },
    originAt(q, y, r) {
      const [ck, li] = editKey(q, y, r);
      const o = world.origins.get(ck)?.get(li);
      return o !== undefined ? o : world.peekBlock(q, y, r);
    },
    terrainHeightAt: (q, r) => (loadedCell(q, r) ? groundY : -1),
    isNaturalGround(q, y, r) {
      return loadedCell(q, r) && !world.hasEdit(q, y, r) && y >= 0 && y <= groundY && isSolid(raw(q, y, r));
    },
    /** Hide chunk (cq, cr) as if it streamed out (its cells and edits are kept). */
    unload(cq, cr) {
      unloaded.add(chunkKey(cq, cr));
    },
    /** Bring chunk (cq, cr) back and fire onChunkGenerated. */
    load(cq, cr) {
      unloaded.delete(chunkKey(cq, cr));
      world.onChunkGenerated(cq, cr);
    },
    /** Set a cell WITHOUT the hook or an edit (pre-existing terrain for a test). */
    put(q, y, r, id) {
      cells.set(key(q, y, r), id);
    },
  };
  return world;
}

/**
 * A BlockPhysics over `world` with the world's onBlockChange / onChunkGenerated forwarded to it (as main does).
 * @param {*} world
 * @param {import('../../src/blockphysics.js').PhysicsHooks} [hooks]
 * @param {typeof import('../../src/blockphysics.js').BlockPhysics} BlockPhysicsClass
 * @param {{ now?: () => number }} [opts]
 */
export function attachPhysics(world, BlockPhysicsClass, hooks = {}, opts = {}) {
  const physics = new BlockPhysicsClass(world, hooks, opts);
  world.onBlockChange = (q, y, r, prev, next) => physics.onBlockChange(q, y, r, prev, next);
  world.onChunkGenerated = (cq, cr) => physics.onChunkGenerated(cq, cr);
  return physics;
}
