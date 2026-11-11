// Tests for src/light.js (sky and block light, CONTRACTS §62), its World wiring, the mesher's light attribute and the
// shader patch's anchors in the installed three.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CHUNK_SIZE, WORLD_HEIGHT, CHUNK_VOLUME, LIGHT_MAX, GLOWSTONE_LIGHT, CAMPFIRE_LIGHT, TORCH_LIGHT } from '../../src/config.js';
import { chunkKey, localIndex } from '../../src/coords.js';
import { HEX_DIRS, hexLength } from '../../src/hex.js';
import { BLOCK } from '../../src/blocks.js';
import { Chunk } from '../../src/chunk.js';
import { World } from '../../src/world.js';
import {
  LightEngine, FULL_SKY, LIGHT_OPACITY, LIGHT_EMISSION, lightBrightness, lightOpacity, lightEmission, skyLevel, blockLevel,
} from '../../src/light.js';
import { buildChunkMesh } from '../../src/mesher.js';
import { buildLayerGeometry } from '../../src/renderer.js';
import {
  LIGHT_ATTRIBUTE, patchLightsFragmentBegin, applyChunkLight, patchObjectShader, isLitMaterial, lightVolume,
} from '../../src/lightShader.js';
import { flatWorldGen, makeChunkData, makeChunkDataGetter } from '../helpers/fixtures.js';
import { mulberry32 } from '../../src/noise.js';

const B = BLOCK;

// ---------------------------------------------------------------------------------------------
// helpers

/** A World over a flat stone floor (y ≤ groundY), fully loaded and meshed around the origin. */
function flatWorld(groundY = 30, renderDistance = 1) {
  const world = new World({ worldGen: flatWorldGen(groundY), renderDistance, now: () => 0 });
  /** @type {string[]} */
  const meshed = [];
  world.onChunkMesh = (key) => meshed.push(key);
  settle(world);
  return { world, meshed };
}

function settle(world) {
  for (let i = 0; i < 50; i++) {
    const r = world.update(0, 0, Infinity);
    if (r.pendingGen === 0 && r.pendingMesh === 0) return;
  }
  throw new Error('world did not settle');
}

/** Write every cell of the hex disc (radius) around (q, r) for y = ya..yb. */
function disc(world, q, r, radius, ya, yb, id) {
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = -radius; dr <= radius; dr++) {
      if (hexLength(dq, dr) > radius) continue;
      for (let y = ya; y <= yb; y++) world.setBlock(q + dq, y, r + dr, id);
    }
  }
}

const sky = (world, q, y, r) => skyLevel(world.lightAt(q, y, r));
const blk = (world, q, y, r) => blockLevel(world.lightAt(q, y, r));

/**
 * Brute-force light over a fixed set of chunks (no loading order, no incremental anything): the column pass, the
 * emitters, then plain relaxation over every cell's 8 neighbours until nothing changes. Works on one flat box of world
 * cells covering the chunks (cells of absent chunks are marked missing).
 * @param {Map<string, Chunk>} chunks
 * @returns {Map<string, Uint8Array>}
 */
function referenceLight(chunks) {
  const list = [...chunks.values()];
  const cq0 = Math.min(...list.map((c) => c.cq));
  const cr0 = Math.min(...list.map((c) => c.cr));
  const nq = (Math.max(...list.map((c) => c.cq)) - cq0 + 1) * CHUNK_SIZE;
  const nr = (Math.max(...list.map((c) => c.cr)) - cr0 + 1) * CHUNK_SIZE;
  const H = WORLD_HEIGHT;
  const idx = (q, y, r) => (q * nr + r) * H + y;
  const blocks = new Uint8Array(nq * nr * H);
  const present = new Uint8Array(nq * nr);
  const L = new Uint8Array(nq * nr * H);
  for (const c of list) {
    for (let lq = 0; lq < CHUNK_SIZE; lq++) {
      for (let lr = 0; lr < CHUNK_SIZE; lr++) {
        const q = (c.cq - cq0) * CHUNK_SIZE + lq;
        const r = (c.cr - cr0) * CHUNK_SIZE + lr;
        present[q * nr + r] = 1;
        blocks.set(c.blocks.subarray(localIndex(lq, 0, lr), localIndex(lq, 0, lr) + H), idx(q, 0, r));
      }
    }
  }
  for (let col = 0; col < nq * nr; col++) {
    if (!present[col]) continue;
    let s = LIGHT_MAX;
    for (let y = H - 1; y >= 0; y--) {
      const op = LIGHT_OPACITY[blocks[col * H + y]];
      if (op >= LIGHT_MAX) break;
      s = s === LIGHT_MAX && op === 0 ? LIGHT_MAX : s - Math.max(1, op);
      if (s <= 0) break;
      L[col * H + y] = s << 4;
    }
    for (let y = 0; y < H; y++) L[col * H + y] |= LIGHT_EMISSION[blocks[col * H + y]];
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let q = 0; q < nq; q++) {
      for (let r = 0; r < nr; r++) {
        if (!present[q * nr + r]) continue;
        for (let y = 0; y < H; y++) {
          const i = idx(q, y, r);
          const op = LIGHT_OPACITY[blocks[i]];
          if (op >= LIGHT_MAX) continue;
          const cost = op > 1 ? op : 1;
          let s = L[i] >> 4;
          let b = L[i] & 15;
          if (y === H - 1) s = Math.max(s, op === 0 ? LIGHT_MAX : LIGHT_MAX - cost);
          if (y + 1 < H) {
            const n = L[i + 1];
            s = Math.max(s, (n >> 4) === LIGHT_MAX && op === 0 ? LIGHT_MAX : (n >> 4) - cost);
            b = Math.max(b, (n & 15) - cost);
          }
          if (y > 0) {
            const n = L[i - 1];
            s = Math.max(s, (n >> 4) - cost);
            b = Math.max(b, (n & 15) - cost);
          }
          for (let j = 0; j < 6; j++) {
            const q2 = q + HEX_DIRS[j][0];
            const r2 = r + HEX_DIRS[j][1];
            if (q2 < 0 || q2 >= nq || r2 < 0 || r2 >= nr || !present[q2 * nr + r2]) continue;
            const n = L[idx(q2, y, r2)];
            s = Math.max(s, (n >> 4) - cost);
            b = Math.max(b, (n & 15) - cost);
          }
          const v = (s << 4) | b;
          if (v !== L[i]) {
            L[i] = v;
            changed = true;
          }
        }
      }
    }
  }
  const out = new Map();
  for (const [key, c] of chunks) {
    const A = new Uint8Array(CHUNK_VOLUME);
    for (let lq = 0; lq < CHUNK_SIZE; lq++) {
      for (let lr = 0; lr < CHUNK_SIZE; lr++) {
        const at = idx((c.cq - cq0) * CHUNK_SIZE + lq, 0, (c.cr - cr0) * CHUNK_SIZE + lr);
        A.set(L.subarray(at, at + H), localIndex(lq, 0, lr));
      }
    }
    out.set(key, A);
  }
  return out;
}

/** Three mutually adjacent chunks (0,0), (1,0), (0,1) with a stone floor up to y = ground and a LightEngine over them. */
function triangle(ground = 30) {
  /** @type {Map<string, Chunk>} */
  const chunks = new Map();
  for (const [cq, cr] of [[0, 0], [1, 0], [0, 1]]) {
    const d = makeChunkData();
    for (let col = 0; col < CHUNK_SIZE * CHUNK_SIZE; col++) d.blocks.fill(B.STONE, col * WORLD_HEIGHT, col * WORLD_HEIGHT + ground + 1);
    chunks.set(chunkKey(cq, cr), new Chunk(cq, cr, d));
  }
  const engine = new LightEngine({ getChunkData: (cq, cr) => chunks.get(chunkKey(cq, cr)) ?? null });
  /** Write a block by WORLD cell and note it for flush(). */
  const put = (q, y, r, id) => {
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    const c = chunks.get(chunkKey(cq, cr));
    if (!c) return;
    const li = localIndex(q - cq * CHUNK_SIZE, y, r - cr * CHUNK_SIZE);
    if (c.blocks[li] === id) return;
    c.blocks[li] = id;
    if (c.light) engine.noteChange(c, li);
  };
  return { chunks, engine, put };
}

/** First mismatching cell between the engine's light and the reference, or null. */
function firstMismatch(chunks) {
  const ref = referenceLight(chunks);
  for (const [key, c] of chunks) {
    const R = ref.get(key);
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      if (c.light[i] !== R[i]) {
        const lq = i >> 11;
        const lr = (i >> 7) & 15;
        const y = i & 127;
        return `${key} local (${lq}, ${y}, ${lr}) block ${c.blocks[i]}: engine ${c.light[i] >> 4}/${c.light[i] & 15}, reference ${R[i] >> 4}/${R[i] & 15}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------

describe('tables and curve', () => {
  it('opaque blocks stop light, leaves / water / ice dim it, air / glass / plants do not', () => {
    expect(lightOpacity(B.STONE)).toBe(LIGHT_MAX);
    expect(lightOpacity(B.GLOWSTONE)).toBe(LIGHT_MAX);
    expect(lightOpacity(B.AIR)).toBe(0);
    expect(lightOpacity(B.GLASS)).toBe(0);
    expect(lightOpacity(B.TUSSOCK)).toBe(0);
    expect(lightOpacity(B.OAK_LEAVES)).toBe(1);
    expect(lightOpacity(B.WATER)).toBe(1);
    expect(lightOpacity(B.WATER_FLOW_3)).toBe(1);
    expect(lightOpacity(B.ICE)).toBe(1);
  });

  it('emitters: glowstone 15, campfire 14, torch 13; a cold fire pit and a lamp block emit nothing', () => {
    expect(lightEmission(B.GLOWSTONE)).toBe(GLOWSTONE_LIGHT);
    expect(lightEmission(B.CAMPFIRE)).toBe(CAMPFIRE_LIGHT);
    expect(lightEmission(B.TORCH)).toBe(TORCH_LIGHT);
    expect([GLOWSTONE_LIGHT, CAMPFIRE_LIGHT, TORCH_LIGHT]).toEqual([15, 14, 13]);
    expect(lightEmission(B.FIRE_PIT)).toBe(0);
    expect(lightEmission(B.FILAMENT_LAMP)).toBe(0);
    expect(lightEmission(B.STONE)).toBe(0);
  });

  it('brightness is 1 at 15, 0 at 0 and rises monotonically', () => {
    expect(lightBrightness(15)).toBe(1);
    expect(lightBrightness(0)).toBe(0);
    for (let l = 1; l <= 15; l++) expect(lightBrightness(l)).toBeGreaterThan(lightBrightness(l - 1));
    expect(lightBrightness(12)).toBeCloseTo(0.5, 6);
  });
});

describe('sky light', () => {
  it('is 15 straight down every open column to the ground, 0 in the ground; unloaded space reads open sky', () => {
    const { world } = flatWorld(30);
    for (const [q, r] of [[0, 0], [7, -3], [15, 15], [-9, 4], [20, -20]]) {
      expect(sky(world, q, 31, r)).toBe(15);
      expect(sky(world, q, 127, r)).toBe(15);
      expect(sky(world, q, 30, r)).toBe(0);
      expect(sky(world, q, 5, r)).toBe(0);
      expect(blk(world, q, 31, r)).toBe(0);
    }
    expect(world.lightAt(5000, 40, 5000)).toBe(FULL_SKY);
    expect(world.lightAt(0, 200, 0)).toBe(FULL_SKY);
    expect(world.lightAt(0, -1, 0)).toBe(0);
    expect(world.light.chunkCount).toBe(world.chunkCount);
  });

  it('a sealed cave is dark at any depth, and opening a shaft lets the sky fall in and flood sideways', () => {
    const { world } = flatWorld(40);
    disc(world, 4, 4, 3, 20, 23, B.AIR);
    for (let dq = -3; dq <= 3; dq++) {
      for (let dr = -3; dr <= 3; dr++) {
        if (hexLength(dq, dr) > 3) continue;
        for (let y = 20; y <= 23; y++) expect(world.lightAt(4 + dq, y, 4 + dr)).toBe(0);
      }
    }
    // A one-cell shaft from the room's ceiling to the surface above (4, 4).
    for (let y = 24; y <= 40; y++) world.setBlock(4, y, 4, B.AIR);
    expect(sky(world, 4, 30, 4)).toBe(15); // free fall down the shaft
    expect(sky(world, 4, 20, 4)).toBe(15); // … to the room's floor
    expect(sky(world, 5, 20, 4)).toBe(14); // then losing 1 per step sideways
    expect(sky(world, 7, 20, 4)).toBe(12);
    expect(sky(world, 7, 23, 4)).toBe(12);
    // Closing the shaft at the top darkens everything again.
    world.setBlock(4, 40, 4, B.STONE);
    expect(sky(world, 4, 30, 4)).toBe(0);
    expect(sky(world, 7, 20, 4)).toBe(0);
  });

  it('leaves and water dim sky light: no free fall through them, one level per cell', () => {
    const { world } = flatWorld(30);
    // A pool 4 deep inside a big flat area: water at y = 27..30 under open sky.
    disc(world, 2, 2, 4, 27, 30, B.WATER);
    expect(sky(world, 2, 31, 2)).toBe(15);
    expect(sky(world, 2, 30, 2)).toBe(14);
    expect(sky(world, 2, 27, 2)).toBe(11);
    // One leaf at y = 40 over open ground: the leaf itself 14, and the whole column under it 14 (lit from the open
    // columns beside it, one step sideways), never 15 again.
    world.setBlock(-6, 40, 6, B.OAK_LEAVES);
    expect(sky(world, -6, 40, 6)).toBe(14);
    expect(sky(world, -6, 39, 6)).toBe(14);
    expect(sky(world, -6, 31, 6)).toBe(14);
    expect(sky(world, -5, 31, 6)).toBe(15);
  });
});

describe('block light', () => {
  it('falls off one level per cell from glowstone, campfire and torch', () => {
    const { world } = flatWorld(40);
    disc(world, 0, 0, 9, 20, 26, B.AIR); // a big sealed room
    world.setBlock(0, 20, 0, B.GLOWSTONE);
    expect(blk(world, 0, 20, 0)).toBe(15);
    for (let d = 1; d <= 9; d++) expect(blk(world, d, 20, 0)).toBe(15 - d);
    expect(blk(world, 0, 21, 0)).toBe(14);
    expect(blk(world, 0, 25, 0)).toBe(10);
    expect(sky(world, 3, 20, 0)).toBe(0);
    world.setBlock(0, 20, 0, B.CAMPFIRE);
    for (let d = 0; d <= 9; d++) expect(blk(world, d, 20, 0)).toBe(14 - d);
    world.setBlock(0, 20, 0, B.TORCH);
    for (let d = 0; d <= 9; d++) expect(blk(world, d, 20, 0)).toBe(13 - d);
    world.setBlock(0, 20, 0, B.FIRE_PIT); // a cold pit: dark again
    for (let d = 0; d <= 9; d++) expect(blk(world, d, 20, 0)).toBe(0);
  });

  it('opaque cells block it: a wall across a room darkens the far side until a door is cut', () => {
    const { world } = flatWorld(40);
    // A corridor along +q at r = 0, y = 20..21, 12 long, sealed in stone.
    for (let q = 0; q <= 12; q++) for (let y = 20; y <= 21; y++) world.setBlock(q, y, 0, B.AIR);
    world.setBlock(0, 20, 0, B.GLOWSTONE);
    expect(blk(world, 8, 20, 0)).toBe(7);
    // A wall at q = 4 (both cells): nothing reaches past it.
    world.setBlock(4, 20, 0, B.STONE);
    world.setBlock(4, 21, 0, B.STONE);
    expect(blk(world, 3, 20, 0)).toBe(12);
    expect(blk(world, 5, 20, 0)).toBe(0);
    expect(blk(world, 8, 20, 0)).toBe(0);
    // A door in the wall's upper cell: light goes over (one step up, along, back down: one extra step).
    world.setBlock(4, 21, 0, B.AIR);
    expect(blk(world, 4, 21, 0)).toBe(10);
    expect(blk(world, 5, 21, 0)).toBe(9);
    expect(blk(world, 5, 20, 0)).toBe(8);
    expect(blk(world, 8, 20, 0)).toBe(5);
  });

  it('crosses chunk borders, and the neighbour chunk is re-meshed even when the edit only touched one chunk', () => {
    const { world, meshed } = flatWorld(40, 2);
    // A sealed room straddling the border between chunks (0,0) and (1,0) (q = 15 | 16).
    for (let q = 10; q <= 22; q++) for (let y = 20; y <= 22; y++) world.setBlock(q, y, 8, B.AIR);
    settle(world);
    meshed.length = 0;
    world.setBlock(13, 20, 8, B.GLOWSTONE); // interior cell: the write itself dirties chunk (0,0) only
    expect(world.getChunk(1, 0).dirty).toBe(false);
    settle(world);
    expect(blk(world, 15, 20, 8)).toBe(13);
    expect(blk(world, 16, 20, 8)).toBe(12);
    expect(blk(world, 20, 20, 8)).toBe(8);
    expect(meshed).toContain('0,0');
    expect(meshed).toContain('1,0');
  });
});

describe('incremental updates match a from-scratch reference', () => {
  it('lights the same whatever order the chunks load in', () => {
    const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0]];
    /** @type {Map<string, Uint8Array>|null} */
    let first = null;
    for (const order of orders) {
      const { chunks, engine } = triangle(30);
      const list = [...chunks.values()];
      // Some structure: a cave across all three borders, an overhang, water and a glowstone.
      const set = (q, y, r, id) => {
        const c = chunks.get(chunkKey(Math.floor(q / 16), Math.floor(r / 16)));
        c.blocks[localIndex(q - c.cq * 16, y, r - c.cr * 16)] = id;
      };
      for (let q = 8; q <= 22; q++) for (let y = 22; y <= 26; y++) set(q, y, 12, B.AIR);
      for (let r = 8; r <= 22; r++) for (let y = 22; y <= 26; y++) set(12, y, r, B.AIR);
      for (let y = 27; y <= 30; y++) set(9, y, 12, B.AIR); // a shaft into the cave
      set(18, 22, 12, B.GLOWSTONE);
      for (let q = 14; q <= 18; q++) set(q, 34, 14, B.STONE); // a floating slab (an overhang across the border)
      set(5, 31, 5, B.WATER);
      for (const k of order) engine.lightChunk(list[k]);
      if (first === null) expect(firstMismatch(chunks)).toBeNull(); // the other orders must match this one exactly
      const snap = new Map([...chunks].map(([key, c]) => [key, c.light.slice()]));
      if (first === null) first = snap;
      else for (const [key, L] of snap) expect(L).toEqual(first.get(key));
    }
  });

  it('stays exact through random placing and breaking near the borders (stone, glowstone, water, leaves, air)', () => {
    const { chunks, engine, put } = triangle(30);
    for (const c of chunks.values()) engine.lightChunk(c);
    const rand = mulberry32(1234);
    const ids = [B.AIR, B.AIR, B.STONE, B.GLOWSTONE, B.WATER, B.OAK_LEAVES, B.CAMPFIRE, B.GLASS];
    for (let round = 0; round < 6; round++) {
      const n = 1 + Math.floor(rand() * 12);
      for (let k = 0; k < n; k++) {
        const q = 10 + Math.floor(rand() * 12); // straddles q = 16 (chunk (1,0))
        const r = 10 + Math.floor(rand() * 12); // straddles r = 16 (chunk (0,1))
        const y = 24 + Math.floor(rand() * 10);
        put(q, y, r, ids[Math.floor(rand() * ids.length)]);
      }
      if (round === 3) put(3, 127, 3, B.STONE); // the very top of the world
      if (round === 4) put(3, 127, 3, B.AIR);
      engine.flush();
      expect(firstMismatch(chunks)).toBeNull();
    }
  });
});

describe('World wiring', () => {
  it('re-lights at the start of update (and in lightAt), not in setBlock', () => {
    const { world } = flatWorld(40);
    disc(world, 0, 0, 3, 20, 22, B.AIR);
    world.flushLight();
    world.setBlock(0, 20, 0, B.GLOWSTONE);
    expect(world.light.hasPending).toBe(true);
    expect(world.light.get(1, 20, 0)).toBe(0);
    world.update(0, 0, Infinity);
    expect(world.light.hasPending).toBe(false);
    expect(blockLevel(world.light.get(1, 20, 0))).toBe(14);
  });

  it('lights new chunks from their loaded neighbours and releases unloaded ones', () => {
    const { world } = flatWorld(30, 1);
    const before = world.light.chunkCount;
    expect(before).toBe(world.chunkCount);
    world.dispose();
    expect(world.light.chunkCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The mesher's light attribute

describe('mesher light attribute', () => {
  /** One chunk with stone at local (5, 10, 5); its light array given by fill(y) → packed. */
  function oneStone(fill) {
    const d = makeChunkData();
    d.blocks[localIndex(5, 10, 5)] = B.STONE;
    if (fill) {
      d.light = new Uint8Array(CHUNK_VOLUME);
      for (let i = 0; i < CHUNK_VOLUME; i++) d.light[i] = fill(i & 127);
    }
    return buildChunkMesh(0, 0, makeChunkDataGetter(new Map([[chunkKey(0, 0), d]])));
  }

  it('writes 2 bytes per vertex; chunks without light read as open sky (255, 0)', () => {
    const m = oneStone(null);
    const layer = m.opaque;
    expect(layer.light).toBeInstanceOf(Uint8Array);
    expect(layer.light.length).toBe(layer.vertexCount * 2);
    for (let v = 0; v < layer.vertexCount; v++) {
      expect(layer.light[v * 2]).toBe(255);
      expect(layer.light[v * 2 + 1]).toBe(0);
    }
  });

  it('smooths per vertex over the see-through cells in front of the face', () => {
    // y = 11 → sky 3 / block 9; y = 10 → sky 7 / block 2; everything else open sky.
    const m = oneStone((y) => (y === 11 ? (3 << 4) | 9 : y === 10 ? (7 << 4) | 2 : FULL_SKY));
    const layer = m.opaque;
    let tops = 0;
    let sideTop = 0;
    let sideBottom = 0;
    for (let v = 0; v < layer.vertexCount; v++) {
      const ny = layer.normals[v * 3 + 1];
      const y = layer.positions[v * 3 + 1];
      const s = layer.light[v * 2];
      const b = layer.light[v * 2 + 1];
      if (ny > 0.5) {
        // Top face: the cell above and its two side neighbours at each corner, all at y = 11.
        expect([s, b]).toEqual([3 * 17, 9 * 17]);
        tops++;
      } else if (ny === 0 && y === 11) {
        // A side face's top corner: front and third cell at y = 10, the two above them at y = 11.
        expect([s, b]).toEqual([5 * 17, Math.round(5.5 * 17)]);
        sideTop++;
      } else if (ny === 0 && y === 10) {
        // A side face's bottom corner: y = 10 and y = 9 (open sky, no block light).
        expect([s, b]).toEqual([11 * 17, 1 * 17]);
        sideBottom++;
      }
    }
    expect(tops).toBe(7);
    expect(sideTop).toBe(12);
    expect(sideBottom).toBe(12);
  });

  it('carries the world light: a sealed room is dark, glowstone faces are fully lit, its floor glows around it', () => {
    const { world } = flatWorld(40);
    disc(world, 4, 4, 3, 20, 22, B.AIR);
    world.setBlock(4, 20, 4, B.GLOWSTONE);
    world.flushLight();
    const m = buildChunkMesh(0, 0, world.getChunkData);
    const layer = m.opaque;
    let glowFaces = 0;
    let floor = 0;
    for (let v = 0; v < layer.vertexCount; v++) {
      const x = layer.positions[v * 3];
      const y = layer.positions[v * 3 + 1];
      const z = layer.positions[v * 3 + 2];
      // Every vertex inside the room's box (y 20..23) is underground: no sky at all.
      if (y >= 20 && y <= 23) expect(layer.light[v * 2]).toBe(0);
      // The glowstone's own faces (centre of cell (4, 4) is x = 6, z = 4·√3/2).
      const ny = layer.normals[v * 3 + 1];
      if (Math.abs(x - 6) < 0.6 && Math.abs(z - 2 * Math.sqrt(3)) < 0.6 && (ny === 0 ? y >= 20 && y <= 21 : y === 21)) {
        expect(layer.light[v * 2 + 1]).toBe(255);
        glowFaces++;
      } else if (y === 20 && ny > 0.5) {
        // The room's floor (top faces at y = 20): lit by the glowstone, 1–3 cells away.
        expect(layer.light[v * 2 + 1]).toBeGreaterThanOrEqual(11 * 17);
        floor++;
      }
    }
    expect(glowFaces).toBeGreaterThan(0);
    expect(floor).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Rendering hooks

describe('shader patch and geometry', () => {
  it('finds every anchor in the installed three\'s lights_fragment_begin', () => {
    const out = patchLightsFragmentBegin();
    expect(out).toContain('directLight.color *= caelSky;');
    expect(out).toContain('irradiance += caelSky * getHemisphereLightIrradiance');
    expect(out).toContain('+ caelExtra;');
    expect(() => patchLightsFragmentBegin('nothing to see')).toThrow();
  });

  it('patches the chunk materials from the vertex attribute and other lit materials from the volume', () => {
    const lambert = THREE.ShaderLib.lambert;
    const m = applyChunkLight(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const shader = { vertexShader: lambert.vertexShader, fragmentShader: lambert.fragmentShader, uniforms: {} };
    m.onBeforeCompile(/** @type {*} */ (shader), /** @type {*} */ (null));
    expect(shader.vertexShader).toContain(`attribute vec2 ${LIGHT_ATTRIBUTE};`);
    expect(shader.vertexShader).toContain(`vCaelLight = ${LIGHT_ATTRIBUTE};`);
    expect(shader.fragmentShader).not.toContain('#include <lights_fragment_begin>');
    expect(shader.fragmentShader).toContain('float caelSky = caelCurve( vCaelLight.x );');
    expect(Object.keys(shader.uniforms)).toEqual(expect.arrayContaining(['caelDaylight', 'caelBlockColor', 'caelVol', 'caelVolInfo']));
    expect(m.customProgramCacheKey()).toBe('caelancraft-chunk-light');

    const obj = { vertexShader: lambert.vertexShader, fragmentShader: lambert.fragmentShader, uniforms: {} };
    patchObjectShader(obj);
    expect(obj.vertexShader).toContain('vCaelLight = max( caelVolumeLevels( caelAt )');
    expect(obj.fragmentShader).toContain('caelExtra');
    expect(isLitMaterial(new THREE.MeshLambertMaterial())).toBe(true);
    expect(isLitMaterial(new THREE.MeshBasicMaterial())).toBe(false);
    const vol = lightVolume();
    expect(vol.data.length).toBe(vol.size * vol.size * WORLD_HEIGHT);
  });

  it('buildLayerGeometry adds the normalised light attribute (open sky when a layer has none)', () => {
    const m = buildChunkMesh(0, 0, makeChunkDataGetter(new Map([[chunkKey(0, 0), (() => {
      const d = makeChunkData();
      d.blocks[localIndex(3, 3, 3)] = B.STONE;
      return d;
    })()]])));
    const g = buildLayerGeometry(m.opaque);
    const attr = /** @type {THREE.BufferAttribute} */ (g.getAttribute(LIGHT_ATTRIBUTE));
    expect(attr.itemSize).toBe(2);
    expect(attr.normalized).toBe(true);
    expect(attr.count).toBe(m.opaque.vertexCount);
    const bare = { ...m.opaque, light: undefined };
    const g2 = buildLayerGeometry(/** @type {*} */ (bare));
    const a2 = /** @type {THREE.BufferAttribute} */ (g2.getAttribute(LIGHT_ATTRIBUTE));
    expect(a2.getX(0)).toBe(1);
    expect(a2.getY(0)).toBe(0);
  });
});
