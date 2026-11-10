// Integration harness — docs/PLAN-build.md §2.12. Node only: no Three.js, no DOM.
//
// Drives the REAL world / worldgen / mesher / raycast / physics / storage / daynight modules through the
// same sequence main.js runs in the browser, with a stub renderer that records setChunkMesh /
// removeChunkMesh. The steps build on each other (spawn → land → raycast → break → place → walk → save),
// so they run in file order inside one describe and share the state below.
//
// The world is a honeycomb of hexagonal prisms (src/hex.js): cells are addressed by axial (q, r) + y,
// chunks are 16×16 in (q, r), and the streamed region is a hex disc of chunks around the player.
import { describe, it, expect, beforeAll } from 'vitest';
import {
  CHUNK_SIZE, WORLD_HEIGHT, EYE_HEIGHT, REACH, SEA_LEVEL, RENDER_DISTANCE, DATA_RADIUS_EXTRA,
  UNLOAD_RADIUS_EXTRA, MAX_SUBSTEP_DT, DAY_LENGTH_SECONDS, START_TIME,
} from '../../src/config.js';
import { chunkKey, inHeightRange, lookDirection, yawToForward } from '../../src/coords.js';
import {
  FACE_TOP, FACE_BOTTOM, FACE_NORMALS, HEX_DIRS, HEX_INRADIUS, hexToWorld, worldToHex, hexDiscCount, hexLength,
  faceNeighbor, hexSignedDistance,
} from '../../src/hex.js';
import {
  BLOCK, DEFAULT_HOTBAR, isBreakable, isPlaceable, isReplaceable, isSolid, isTargetable,
} from '../../src/blocks.js';
import { World } from '../../src/world.js';
import { createPlayer, stepPlayer, getEyeHeight, playerIntersectsBlock } from '../../src/physics.js';
import { raycastHex } from '../../src/raycast.js';
import {
  SAVE_VERSION, serializeSave, deserializeSave, saveGame, loadGame, hasSave, clearSave,
} from '../../src/storage.js';
import { computeSky, advanceTime, createSkyState, sunDirection, formatTime } from '../../src/daynight.js';
import { RuneStore, RuneRunner, runeKey, SOURCE } from '../../src/runes.js';
import { countFaces } from '../helpers/fixtures.js';
// v0.9 Survival (§10 I-3)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { GEN_LATEST, STAT_MAX, BREATH_MAX_S, BODY_TEMP_MIN, BODY_TEMP_MAX, HOTBAR_SIZE, PACK_SLOTS } from '../../src/config.js';
import { BIOME } from '../../src/blocks.js';
import { Survival } from '../../src/survival.js';
import { Pack } from '../../src/inventory.js';
import { Containers } from '../../src/containers.js';
import { FireSlots } from '../../src/cooking.js';
import { CraftQueue } from '../../src/crafting.js';
import { parseLine, executeCommand } from '../../src/commands.js';
import { parseParams, survivalDebugLine, buildDebugText, circuitSceneWrites } from '../../src/diagnostics.js';
import { createMenus } from '../../src/menus.js';
import {
  STATE, stateSimulates, stateAfterLoading, loadingGen, loadingMode, modeParamPlan, consumeModeParam, survivalSaveFields,
  physicsMenuStateFor, sampleClimate, deathScreenText, knockCause, cellsLifted, MODE_PARAM_IGNORED, SURVIVAL_NEEDS_GEN2,
  survivalIntroLines, SURVIVAL_INTRO, HANDBOOK_INTRO, leftBehindText, spoiledText, packListText, CLIMATE_SAMPLE_S,
  consolePackAdd, consolePackClear, HANDBOOK_KEY,
} from '../../src/main.js';
import { documentFromHTML } from '../helpers/fakeDom.js';
// v0.10 circuits (§7 I-2)
import { PLACE_REPEAT_S } from '../../src/config.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { BlackHoles } from '../../src/blackholes.js';
import { Circuits } from '../../src/circuits.js';
import { CircuitStore } from '../../src/circuitStore.js';
import { isControl as isControlPart } from '../../src/circuitParts.js';
import { interactKind } from '../../src/survivalControl.js';
import { makeFakeWorld } from '../helpers/fixtures.js';
import {
  rKeyStep, rightMouseStep, ControlLatch, explainLine, snuffsKeg, panelCellChanged, kegHintText, hotbarFrom, hasRAction,
  makeCircuitHooks, makeBlackHoleWorld, physicsCircuitHooks, KEG_EXPLAIN,
} from '../../src/main.js';
import * as mainModule from '../../src/main.js';
import { canHarvest, harvestHint } from '../../src/harvest.js';
import { getBlockDef } from '../../src/blocks.js';

const SEED = 1;
const RD = 2;
const TICK = 1 / 60;
const IDLE = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };
/** Chunks in the data / mesh / unload discs for RD (hex discs: 37 / 19 / 91). */
const DATA_COUNT = hexDiscCount(RD + DATA_RADIUS_EXTRA);
const MESH_COUNT = hexDiscCount(RD);
const UNLOAD_COUNT = hexDiscCount(RD + UNLOAD_RADIUS_EXTRA);

// ---------------------------------------------------------------------------------------------
// helpers

/** Renderer stand-in: remembers the latest ChunkMeshData per key and every call, like renderer.js does. */
function createStubRenderer() {
  /** @type {Map<string, import('../../src/types.js').ChunkMeshData>} */
  const meshes = new Map();
  /** @type {{ key: string, cq: number, cr: number }[]} */
  const setCalls = [];
  /** @type {string[]} */
  const removeCalls = [];
  return {
    meshes,
    setCalls,
    removeCalls,
    setChunkMesh(key, cq, cr, meshData) {
      setCalls.push({ key, cq, cr });
      meshes.set(key, meshData);
    },
    removeChunkMesh(key) {
      removeCalls.push(key);
      meshes.delete(key);
    },
    /** number of setChunkMesh calls for a key */
    countFor(key) {
      let n = 0;
      for (const c of setCalls) if (c.key === key) n++;
      return n;
    },
  };
}

/** Wire a world to a stub renderer exactly as main.js does. */
function attach(world, stub) {
  world.onChunkMesh = (key, cq, cr, m) => stub.setChunkMesh(key, cq, cr, m);
  world.onChunkUnload = (key) => stub.removeChunkMesh(key);
}

/** Run update() with an infinite budget until nothing is pending. */
function converge(world, px, pz, maxCalls = 400) {
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

/** Eye-origin raycast along the look direction, as main.js does each frame. */
function castFrom(world, player, yaw, pitch) {
  const [dx, dy, dz] = lookDirection(yaw, pitch);
  return raycastHex(world.getBlock, player.x, player.y + getEyeHeight(player), player.z, dx, dy, dz, REACH);
}

/** main.js place rule (CONTRACTS §23): the cell across the hit face, in range, replaceable, not inside the player. */
function tryPlace(world, player, hit, id) {
  if (!hit || hit.face < 0 || !isPlaceable(id)) return false;
  const [tq, ty, tr] = faceNeighbor(hit.q, hit.y, hit.r, hit.face);
  if (!inHeightRange(ty)) return false;
  if (!isReplaceable(world.getBlock(tq, ty, tr))) return false;
  if (isSolid(id) && playerIntersectsBlock(player, tq, ty, tr)) return false;
  return world.setBlock(tq, ty, tr, id);
}

/** Chunk key of the chunk containing cell (q, r). */
function cellChunkKey(q, r) {
  return chunkKey(Math.floor(q / CHUNK_SIZE), Math.floor(r / CHUNK_SIZE));
}

/** Keys of the chunks containing cell (q, r) and its six side neighbours (what an edit must re-mesh). */
function affectedChunkKeys(q, r) {
  const keys = new Set([cellChunkKey(q, r)]);
  for (const [dq, dr] of HEX_DIRS) keys.add(cellChunkKey(q + dq, r + dr));
  return keys;
}

/** Chunk coordinates of the chunk under world point (x, z). */
function chunkOf(x, z) {
  const [q, r] = worldToHex(x, z);
  return [Math.floor(q / CHUNK_SIZE), Math.floor(r / CHUNK_SIZE)];
}

/** Every stub mesh must belong to a loaded chunk, and every meshed chunk must have a stub mesh. */
function expectNoOrphans(world, stub) {
  for (const key of stub.meshes.keys()) {
    expect(world.chunks.has(key), `stub holds a mesh for unloaded chunk ${key}`).toBe(true);
  }
  for (const [key, chunk] of world.chunks) {
    if (chunk.meshed) expect(stub.meshes.has(key), `meshed chunk ${key} has no mesh in the stub`).toBe(true);
  }
}

/** Every non-null layer of a ChunkMeshData is a self-consistent indexed triangle list. */
function expectMeshConsistent(m) {
  for (const name of ['opaque', 'cutout', 'translucent']) {
    const layer = m[name];
    if (!layer) continue;
    expect(layer.faceCount, `${name}.faceCount`).toBeGreaterThan(0);
    expect(layer.indices.length, `${name}.indices`).toBe(layer.indexCount);
    expect(layer.indexCount % 3).toBe(0);
    expect(layer.positions.length).toBe(layer.vertexCount * 3);
    expect(layer.normals.length).toBe(layer.vertexCount * 3);
    expect(layer.uvs.length).toBe(layer.vertexCount * 2);
    expect(layer.colors.length).toBe(layer.vertexCount * 3);
    // Side quads take 6 indices, hexagonal caps 18: faceCount is bracketed by both.
    expect(layer.faceCount).toBeLessThanOrEqual(layer.indexCount / 6);
    expect(layer.faceCount).toBeGreaterThanOrEqual(layer.indexCount / 18);
    let maxIndex = -1;
    for (let i = 0; i < layer.indices.length; i++) if (layer.indices[i] > maxIndex) maxIndex = layer.indices[i];
    expect(maxIndex).toBeLessThan(layer.vertexCount);
  }
}

/** Map-backed localStorage stand-in. */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    get size() {
      return m.size;
    },
  };
}

function isFiniteVec(v) {
  return Array.isArray(v) && v.length === 3 && v.every((c) => Number.isFinite(c));
}

// ---------------------------------------------------------------------------------------------
// shared state (filled by the steps in order)

/** @type {World} */
let world;
let stub;
/** @type {import('../../src/types.js').Vec3} */
let spawn;
/** axial cell of the spawn column */
let spawnQ;
let spawnR;
/** @type {import('../../src/types.js').PlayerState} */
let player;
/** @type {import('../../src/types.js').RaycastHit} */
let groundHit;
/** id the broken block had before the break */
let brokenId;
/** cell (q, y, r) of the placed STONE */
let placed;
const yaw = Math.PI; // face +Z like a fresh spawn in main.js
const pitch = 0;

describe('integration harness: world + physics + raycast + storage + daynight (seed 1, rd 2)', () => {
  beforeAll(() => {
    world = new World({ seed: SEED, renderDistance: RD, now: () => 0 });
    stub = createStubRenderer();
    attach(world, stub);
    spawn = world.findSpawn();
    [spawnQ, spawnR] = worldToHex(spawn[0], spawn[2]);
  });

  it('findSpawn returns a dry, above-sea-level column at the centre of a hex cell', () => {
    expect(spawn).toHaveLength(3);
    const [cx, cz] = hexToWorld(spawnQ, spawnR);
    expect(spawn[0]).toBeCloseTo(cx, 12);
    expect(spawn[2]).toBeCloseTo(cz, 12);
    expect(spawn[1]).toBeGreaterThanOrEqual(SEA_LEVEL + 3);
    expect(spawn[1]).toBeLessThan(WORLD_HEIGHT);
    expect(spawn[1]).toBe(world.getSurfaceHeight(spawnQ, spawnR) + 1);
    expect(Number.isInteger(spawn[1])).toBe(true);
  });

  it('loads the hex data disc (37 chunks) and meshes the hex render disc (19 chunks) around spawn', () => {
    // Loading screen: update until the spawn chunk is ready, then drain everything else.
    let guard = 0;
    let generated = 0;
    while (!world.isReadyAt(spawn[0], spawn[2])) {
      generated += world.update(spawn[0], spawn[2], Infinity).generated;
      if (++guard > 400) throw new Error('spawn chunk never became ready');
    }
    expect(world.isReadyAt(spawn[0], spawn[2])).toBe(true);
    expect(world.isReadyAtCell(spawnQ, spawnR)).toBe(true);

    generated += converge(world, spawn[0], spawn[2]).generated;
    expect(DATA_COUNT).toBe(37);
    expect(MESH_COUNT).toBe(19);
    expect(world.chunkCount).toBe(DATA_COUNT);
    expect(generated).toBe(DATA_COUNT);
    expect(stub.meshes.size).toBe(MESH_COUNT);
    expect(stub.setCalls.length).toBe(MESH_COUNT); // each chunk meshed exactly once
    expectNoOrphans(world, stub);

    // Every loaded chunk lies within the data disc; nothing inside the render disc is left dirty; every
    // mesh is real, self-consistent geometry and the stub received the chunk's own coordinates.
    const [scq, scr] = chunkOf(spawn[0], spawn[2]);
    for (const c of world.chunks.values()) expect(hexLength(c.cq - scq, c.cr - scr)).toBeLessThanOrEqual(RD + DATA_RADIUS_EXTRA);
    for (let dq = -RD; dq <= RD; dq++) {
      for (let dr = -RD; dr <= RD; dr++) {
        if (hexLength(dq, dr) > RD) continue;
        const c = world.getChunk(scq + dq, scr + dr);
        expect(c).toBeDefined();
        expect(c.dirty).toBe(false);
        expect(c.meshed).toBe(true);
        const key = chunkKey(scq + dq, scr + dr);
        const m = stub.meshes.get(key);
        expect(countFaces(m)).toBeGreaterThan(0);
        expect(m.opaque).not.toBeNull();
        expectMeshConsistent(m);
        const call = stub.setCalls.find((s) => s.key === key);
        expect([call.cq, call.cr]).toEqual([scq + dq, scr + dr]);
      }
    }
    // Chunks in the data halo (distance RD+1) are loaded but never meshed.
    for (const c of world.chunks.values()) {
      if (hexLength(c.cq - scq, c.cr - scr) > RD) expect(c.meshed).toBe(false);
    }
  });

  it('spawn column is standable: solid cell below the feet, two air cells above', () => {
    const by = Math.floor(spawn[1]);
    expect(isSolid(world.getBlock(spawnQ, by - 1, spawnR))).toBe(true);
    expect(isSolid(world.getBlock(spawnQ, by, spawnR))).toBe(false);
    expect(isSolid(world.getBlock(spawnQ, by + 1, spawnR))).toBe(false);
    // getBlockAt (world coordinates) agrees with getBlock (cell coordinates).
    expect(world.getBlockAt(spawn[0], by - 1, spawn[2])).toBe(world.getBlock(spawnQ, by - 1, spawnR));
  });

  it('player lands and is stable after 300 idle ticks', () => {
    player = createPlayer(spawn[0], spawn[1], spawn[2]);
    expect(player.onGround).toBe(false);
    let yAt250 = NaN;
    for (let i = 0; i < 300; i++) {
      if (world.hasChunkAt(player.x, player.z)) stepPlayer(player, IDLE, world.getBlock, TICK);
      if (i === 249) yAt250 = player.y;
    }
    expect(player.onGround).toBe(true);
    expect(player.flying).toBe(false);
    expect(player.inWater).toBe(false);
    expect(player.vy).toBe(0);
    expect(Math.abs(player.vx) + Math.abs(player.vz)).toBeLessThan(1e-9);
    // No horizontal drift and no sinking / bouncing.
    expect(player.x).toBeCloseTo(spawn[0], 12);
    expect(player.z).toBeCloseTo(spawn[2], 12);
    expect(player.y).toBeCloseTo(yAt250, 12);
    // Standing on the spawn surface (feet within a hair of the cell top, never inside it).
    expect(player.y).toBeGreaterThanOrEqual(Math.floor(spawn[1]));
    expect(player.y).toBeLessThan(Math.floor(spawn[1]) + 0.01);
    const [pq, pr] = worldToHex(player.x, player.z);
    expect([pq, pr]).toEqual([spawnQ, spawnR]);
    expect(isSolid(world.getBlock(pq, Math.floor(player.y) - 1, pr))).toBe(true);
    for (const v of [player.x, player.y, player.z, player.vx, player.vy, player.vz]) expect(Number.isFinite(v)).toBe(true);
  });

  it('a 100-substep idle run keeps the player exactly in place (no jitter)', () => {
    const { x, y, z } = player;
    for (let i = 0; i < 100; i++) stepPlayer(player, IDLE, world.getBlock, MAX_SUBSTEP_DT);
    expect(player.x).toBe(x);
    expect(player.z).toBe(z);
    expect(Math.abs(player.y - y)).toBeLessThan(1e-9);
    expect(player.onGround).toBe(true);
  });

  it('looking straight down from the eye hits the cell under the feet at ≈ EYE_HEIGHT on its top face', () => {
    groundHit = castFrom(world, player, yaw, -Math.PI / 2 + 1e-6);
    expect(groundHit).not.toBeNull();
    const [pq, pr] = worldToHex(player.x, player.z);
    expect(groundHit.q).toBe(pq);
    expect(groundHit.r).toBe(pr);
    expect(groundHit.y).toBe(Math.floor(player.y) - 1);
    expect(groundHit.face).toBe(FACE_TOP);
    expect([groundHit.nx, groundHit.ny, groundHit.nz]).toEqual([0, 1, 0]);
    expect(groundHit.distance).toBeCloseTo(EYE_HEIGHT, 3);
    expect(isTargetable(groundHit.blockId)).toBe(true);
    expect(groundHit.blockId).toBe(world.getBlock(groundHit.q, groundHit.y, groundHit.r));
  });

  it('looking east along a row hits a block placed three cells ahead on its west face at the exact distance', () => {
    // yaw = -π/2 faces +X (CONTRACTS §0). Rows of the pointy-top honeycomb run along +X, so from a cell centre
    // the ray passes through the centres of (q+1, r), (q+2, r), (q+3, r) and enters each through its W face.
    const eastYaw = -Math.PI / 2;
    expect(yawToForward(eastYaw)[0]).toBeCloseTo(1, 12);
    const [q, r] = worldToHex(player.x, player.z);
    const ox = player.x;
    const oy = player.y + getEyeHeight(player);
    const oz = player.z;
    const ey = Math.floor(oy); // eye cell
    const [dx, dy, dz] = lookDirection(eastYaw, 0);
    expect(worldToHex(ox + 3 * dx, oz + 3 * dz)).toEqual([q + 3, r]);
    // Edit the world so the outcome is fully determined: clear air in the two cells between, STONE in the third.
    // (setBlock on an unchanged cell returns false and records nothing, so this is a no-op over open ground.)
    const originals = [1, 2, 3].map((d) => world.getBlock(q + d, ey, r));
    world.setBlock(q + 1, ey, r, BLOCK.AIR);
    world.setBlock(q + 2, ey, r, BLOCK.AIR);
    world.setBlock(q + 3, ey, r, BLOCK.STONE);
    expect(world.getBlock(q + 3, ey, r)).toBe(BLOCK.STONE);

    const h = raycastHex(world.getBlock, ox, oy, oz, dx, dy, dz, REACH);
    expect(h).not.toBeNull();
    expect([h.q, h.y, h.r]).toEqual([q + 3, ey, r]);
    expect(h.face).toBe(3); // W: the face that looks back at the eye
    expect([h.nx, h.ny, h.nz]).toEqual([-1, 0, 0]);
    // Distance to the W plane of the hit cell: (c − o)·x − inradius = 3 − 0.5.
    const [cx, cz] = hexToWorld(h.q, h.r);
    const n = FACE_NORMALS[h.face];
    const expected = (HEX_INRADIUS - ((ox - cx) * n[0] + (oz - cz) * n[2])) / (dx * n[0] + dz * n[2]);
    expect(h.distance).toBeCloseTo(expected, 12);
    expect(h.distance).toBeCloseTo(3 - HEX_INRADIUS, 9);
    expect(h.distance).toBeLessThanOrEqual(REACH);
    expect(h.blockId).toBe(BLOCK.STONE);
    expect(h.blockId).toBe(world.getBlock(h.q, h.y, h.r));

    // Put the terrain back and re-mesh so the following steps start from a clean, converged world.
    // (The restore is itself recorded as an edit that re-asserts the generated value — harmless.)
    for (let d = 1; d <= 3; d++) world.setBlock(q + d, ey, r, originals[d - 1]);
    expect(world.getBlock(q + 3, ey, r)).toBe(originals[2]);
    world.update(player.x, player.z, Infinity);
    expectNoOrphans(world, stub);
  });

  it('a ray in any direction enters the cell three blocks ahead through a face plane it really crosses', () => {
    // Synthetic single-block worlds: only the cell containing eye + 3·dir is STONE. The hit must be that cell,
    // the hit point must lie on the reported face's plane and inside the prism's footprint / height.
    const ox = 0.123;
    const oy = 70.37;
    const oz = 0.456;
    for (const yw of [0.37, 1.1, 2.3, -0.8, 3.0, -2.6]) {
      for (const pt of [0.1, -0.25, 0.4, -0.6]) {
        const [dx, dy, dz] = lookDirection(yw, pt);
        const [tq, tr] = worldToHex(ox + 3 * dx, oz + 3 * dz);
        const ty = Math.floor(oy + 3 * dy);
        const getBlock = (q, y, r) => (q === tq && y === ty && r === tr ? BLOCK.STONE : BLOCK.AIR);
        const h = raycastHex(getBlock, ox, oy, oz, dx, dy, dz, REACH);
        const label = `yaw ${yw} pitch ${pt}`;
        expect(h, label).not.toBeNull();
        expect([h.q, h.y, h.r], label).toEqual([tq, ty, tr]);
        expect(h.blockId).toBe(BLOCK.STONE);
        expect(h.distance, label).toBeLessThanOrEqual(3);
        expect(h.distance, label).toBeGreaterThan(3 - 1.6); // longest chord through a prism is < 1.6
        const px = ox + h.distance * dx;
        const py = oy + h.distance * dy;
        const pz = oz + h.distance * dz;
        const [cx, cz] = hexToWorld(h.q, h.r);
        if (h.face === FACE_TOP) {
          expect(py, label).toBeCloseTo(ty + 1, 9);
          expect([h.nx, h.ny, h.nz]).toEqual([0, 1, 0]);
        } else if (h.face === FACE_BOTTOM) {
          expect(py, label).toBeCloseTo(ty, 9);
          expect([h.nx, h.ny, h.nz]).toEqual([0, -1, 0]);
        } else {
          const n = FACE_NORMALS[h.face];
          expect((px - cx) * n[0] + (pz - cz) * n[2], label).toBeCloseTo(HEX_INRADIUS, 9);
          expect([h.nx, h.ny, h.nz], label).toEqual([n[0], n[1], n[2]]);
          // The ray must be heading INTO the cell through that face.
          expect(dx * n[0] + dz * n[2], label).toBeLessThan(0);
        }
        expect(hexSignedDistance(cx, cz, px, pz), label).toBeLessThanOrEqual(1e-9);
        expect(py, label).toBeGreaterThanOrEqual(ty - 1e-9);
        expect(py, label).toBeLessThanOrEqual(ty + 1 + 1e-9);
      }
    }
  });

  it('looking straight up from the eye over open sky finds nothing within REACH', () => {
    // findSpawn picks an open surface column, so nothing should be above the head. Make that unconditional by
    // clearing every cell the ray can enter (a no-op when already AIR) so `null` is asserted, not tolerated.
    const [q, r] = worldToHex(player.x, player.z);
    const ey = Math.floor(player.y + getEyeHeight(player));
    const top = Math.min(WORLD_HEIGHT - 1, ey + Math.ceil(REACH) + 1);
    for (let y = ey + 1; y <= top; y++) world.setBlock(q, y, r, BLOCK.AIR);
    expect(isTargetable(world.getBlock(q, ey, r))).toBe(false); // the eye itself is in air
    expect(castFrom(world, player, yaw, Math.PI / 2 - 1e-3)).toBeNull();
    world.update(player.x, player.z, Infinity);
  });

  it('break: setBlock AIR records an edit and update() re-meshes exactly the chunks touching the cell', () => {
    brokenId = groundHit.blockId;
    expect(isBreakable(brokenId)).toBe(true);
    const key = cellChunkKey(groundHit.q, groundHit.r);
    const before = stub.countFor(key);
    const prevMesh = stub.meshes.get(key);
    const version = world.editVersion;
    const callsBefore = stub.setCalls.length;

    expect(world.setBlock(groundHit.q, groundHit.y, groundHit.r, BLOCK.AIR)).toBe(true);
    expect(world.getBlock(groundHit.q, groundHit.y, groundHit.r)).toBe(BLOCK.AIR);
    expect(world.editVersion).toBe(version + 1);
    expect(world.getChunk(...key.split(',').map(Number)).dirty).toBe(true);
    expect(world.isReadyAtCell(groundHit.q, groundHit.r)).toBe(false);
    expect(world.isReadyAt(player.x, player.z)).toBe(false);

    // Breaking the same cell again is a no-op (value unchanged).
    expect(world.setBlock(groundHit.q, groundHit.y, groundHit.r, BLOCK.AIR)).toBe(false);
    expect(world.editVersion).toBe(version + 1);

    const r = world.update(player.x, player.z, Infinity);
    expect(r.meshed).toBeGreaterThanOrEqual(1);
    expect(world.isReadyAtCell(groundHit.q, groundHit.r)).toBe(true);
    expect(stub.countFor(key)).toBe(before + 1);
    expect(stub.meshes.get(key)).not.toBe(prevMesh);
    expectMeshConsistent(stub.meshes.get(key));
    expectNoOrphans(world, stub);

    // Exactly the chunks containing the cell or one of its six neighbours were re-meshed, each once.
    const remeshed = stub.setCalls.slice(callsBefore).map((c) => c.key);
    expect(new Set(remeshed)).toEqual(affectedChunkKeys(groundHit.q, groundHit.r));
    expect(remeshed.length).toBe(new Set(remeshed).size);

    // The edit is in the export in main's SaveData shape.
    const edits = world.exportEdits();
    expect(Object.keys(edits)).toContain(key);
    expect(edits[key].length % 2).toBe(0);
    expect(edits[key]).toContain(BLOCK.AIR);
  });

  it('after the break, looking down hits the exposed cell one lower', () => {
    const h = castFrom(world, player, yaw, -Math.PI / 2 + 1e-6);
    expect(h).not.toBeNull();
    expect([h.q, h.r]).toEqual([groundHit.q, groundHit.r]);
    expect(h.y).toBe(groundHit.y - 1);
    expect(h.face).toBe(FACE_TOP);
    expect(h.distance).toBeCloseTo(EYE_HEIGHT + 1, 2);
    groundHit = h;
  });

  it('place: STONE goes to the cell across the hit face (the hole), is rejected where the player stands, and re-meshes', () => {
    // Placing into the player's own feet cell must be refused (solid block intersecting the cylinder).
    const feetHit = { ...groundHit, y: Math.floor(player.y) - 1, face: FACE_TOP, nx: 0, ny: 1, nz: 0 };
    const [fq, fy, fr] = faceNeighbor(feetHit.q, feetHit.y, feetHit.r, feetHit.face);
    expect(fy).toBe(Math.floor(player.y));
    expect(playerIntersectsBlock(player, fq, fy, fr)).toBe(true);
    expect(tryPlace(world, player, feetHit, BLOCK.STONE)).toBe(false);
    expect(world.getBlock(fq, fy, fr)).toBe(BLOCK.AIR);

    // The real hit (one lower) targets the hole we just made.
    const [tq, ty, tr] = faceNeighbor(groundHit.q, groundHit.y, groundHit.r, groundHit.face);
    expect([tq, ty, tr]).toEqual([groundHit.q, groundHit.y + 1, groundHit.r]);
    expect(world.getBlock(tq, ty, tr)).toBe(BLOCK.AIR);
    expect(playerIntersectsBlock(player, tq, ty, tr)).toBe(false);
    const key = cellChunkKey(tq, tr);
    const before = stub.countFor(key);
    const version = world.editVersion;

    expect(tryPlace(world, player, groundHit, BLOCK.STONE)).toBe(true);
    expect(world.getBlock(tq, ty, tr)).toBe(BLOCK.STONE);
    expect(world.editVersion).toBe(version + 1);
    placed = { q: tq, y: ty, r: tr };

    // Placing on top of an occupied cell is refused.
    expect(tryPlace(world, player, groundHit, BLOCK.STONE)).toBe(false);
    // Water / AIR are never placeable; BEDROCK is not placeable either.
    expect(tryPlace(world, player, groundHit, BLOCK.AIR)).toBe(false);
    expect(tryPlace(world, player, groundHit, BLOCK.WATER)).toBe(false);
    expect(tryPlace(world, player, groundHit, BLOCK.BEDROCK)).toBe(false);

    world.update(player.x, player.z, Infinity);
    expect(world.isReadyAtCell(tq, tr)).toBe(true);
    expect(stub.countFor(key)).toBe(before + 1);
    expectNoOrphans(world, stub);

    // The player still stands (the hole is filled again and physics agrees).
    for (let i = 0; i < 60; i++) stepPlayer(player, IDLE, world.getBlock, TICK);
    expect(player.onGround).toBe(true);
    expect(player.y).toBeGreaterThanOrEqual(Math.floor(spawn[1]));
  });

  it('a block placed at the top of the world is refused by the height-range rule', () => {
    const topHit = { q: placed.q, y: WORLD_HEIGHT - 1, r: placed.r, face: FACE_TOP, nx: 0, ny: 1, nz: 0, distance: 1, blockId: BLOCK.STONE };
    expect(inHeightRange(faceNeighbor(topHit.q, topHit.y, topHit.r, topHit.face)[1])).toBe(false);
    expect(tryPlace(world, player, topHit, BLOCK.STONE)).toBe(false);
  });

  it('walking 20 s toward +X crosses chunk borders; chunks stream in/out with no orphan meshes', () => {
    const walker = createPlayer(player.x, player.y, player.z);
    let [lastCq, lastCr] = chunkOf(walker.x, walker.z);
    // yawToForward(-π/2) = [1, 0] → +X. Jump held so 1-block steps are climbed.
    const walkYaw = -Math.PI / 2;
    expect(yawToForward(walkYaw)[0]).toBeCloseTo(1, 12);
    const input = { forward: 1, strafe: 0, jump: true, sneak: false, sprint: false, yaw: walkYaw };

    let generated = 0;
    let unloaded = 0;
    let maxLoaded = 0;
    let borders = 0;
    let physicsSkips = 0;
    const ticks = Math.round(20 / TICK);
    for (let i = 0; i < ticks; i++) {
      if (world.hasChunkAt(walker.x, walker.z)) stepPlayer(walker, input, world.getBlock, TICK);
      else physicsSkips++;
      const r = world.update(walker.x, walker.z, Infinity);
      generated += r.generated;
      unloaded += r.unloaded;
      maxLoaded = Math.max(maxLoaded, world.chunkCount);
      const [cq, cr] = chunkOf(walker.x, walker.z);
      if (cq !== lastCq || cr !== lastCr) {
        borders++;
        lastCq = cq;
        lastCr = cr;
      }
      if (i % 120 === 0) expectNoOrphans(world, stub);
      for (const v of [walker.x, walker.y, walker.z]) expect(Number.isFinite(v)).toBe(true);
      // The walker never ends a tick inside a solid cell.
      const [wq, wr] = worldToHex(walker.x, walker.z);
      expect(isSolid(world.getBlock(wq, Math.floor(walker.y + 0.5), wr))).toBe(false);
    }
    // Streaming always keeps the player's own chunk loaded, so physics never has to be skipped.
    expect(physicsSkips).toBe(0);
    expect(walker.x - player.x).toBeGreaterThan(CHUNK_SIZE);
    expect(borders).toBeGreaterThanOrEqual(1);
    expect(generated).toBeGreaterThan(0);
    expect(unloaded).toBeGreaterThan(0);
    // Data disc ≤ loaded ≤ unload disc (edge chunks linger until they are > rd + 3 away).
    expect(maxLoaded).toBeLessThanOrEqual(UNLOAD_COUNT);
    expect(world.chunkCount).toBeGreaterThanOrEqual(DATA_COUNT);
    expect(world.chunkCount).toBeLessThanOrEqual(UNLOAD_COUNT);
    expectNoOrphans(world, stub);
    // Every loaded chunk is within the unload radius of the walker.
    const [wcq, wcr] = chunkOf(walker.x, walker.z);
    for (const c of world.chunks.values()) {
      expect(hexLength(c.cq - wcq, c.cr - wcr)).toBeLessThanOrEqual(RD + UNLOAD_RADIUS_EXTRA);
    }

    // Every unloaded key the stub saw is really gone, and the stub only holds meshes of loaded chunks.
    for (const key of stub.removeCalls) {
      if (!world.chunks.has(key)) expect(stub.meshes.has(key)).toBe(false);
    }
    // Drain the queue where the walker stopped and check the render disc is complete there.
    converge(world, walker.x, walker.z);
    for (let dq = -RD; dq <= RD; dq++) {
      for (let dr = -RD; dr <= RD; dr++) {
        if (hexLength(dq, dr) > RD) continue;
        expect(world.isReadyAtCell((wcq + dq) * CHUNK_SIZE, (wcr + dr) * CHUNK_SIZE)).toBe(true);
      }
    }
    expectNoOrphans(world, stub);
    // Walk back so the edited chunk is loaded again for the save test (edits survive unloading regardless).
    converge(world, player.x, player.z);
    expectNoOrphans(world, stub);
  });

  it('edits survive chunk unload/reload (applied right after generateChunk)', () => {
    expect(world.hasChunkAtCell(placed.q, placed.r)).toBe(true);
    expect(world.getBlock(placed.q, placed.y, placed.r)).toBe(BLOCK.STONE);
    expect(world.getBlock(groundHit.q, groundHit.y + 1, groundHit.r)).toBe(BLOCK.STONE); // same cell as `placed`
    expect(world.getBlock(placed.q, placed.y + 1, placed.r)).toBe(BLOCK.AIR); // the broken cell above stays AIR
    expect(brokenId).not.toBe(BLOCK.AIR);
  });

  it('save/load roundtrip via serializeSave/deserializeSave (v2) preserves the edits, player and clock', () => {
    expect(SAVE_VERSION).toBe(2);
    const data = {
      version: SAVE_VERSION,
      seed: world.seed,
      time: 0.4321,
      day: 3,
      player: { x: player.x, y: player.y, z: player.z, yaw, pitch, flying: false },
      hotbar: DEFAULT_HOTBAR.slice(),
      selected: 4,
      edits: world.exportEdits(),
    };
    const text = serializeSave(data);
    expect(typeof text).toBe('string');
    const back = deserializeSave(text);
    expect(back).not.toBeNull();
    expect(back.version).toBe(SAVE_VERSION);
    expect(back.seed).toBe(world.seed);
    expect(back.time).toBeCloseTo(0.4321, 12);
    expect(back.day).toBe(3);
    expect(back.player).toEqual(data.player);
    expect(back.hotbar).toEqual(DEFAULT_HOTBAR.slice());
    expect(back.selected).toBe(4);
    expect(back.edits).toEqual(data.edits);
    // Canonical form is stable.
    expect(serializeSave(back)).toBe(text);
    // A cube-era (v1) save is refused rather than misread as hex edits.
    expect(deserializeSave(JSON.stringify({ ...data, version: 1 }))).toBeNull();

    // A second world built from the save (as `Continue` does) shows the edits once streamed in.
    const world2 = new World({ seed: back.seed, renderDistance: RD, edits: back.edits, now: () => 0 });
    const stub2 = createStubRenderer();
    attach(world2, stub2);
    expect(world2.editVersion).toBe(0); // restoring is not a new edit
    expect(world2.exportEdits()).toEqual(data.edits);
    converge(world2, back.player.x, back.player.z);
    expect(world2.getBlock(placed.q, placed.y, placed.r)).toBe(BLOCK.STONE);
    expect(world2.getBlock(placed.q, placed.y + 1, placed.r)).toBe(BLOCK.AIR);
    // An unedited cell is identical in both worlds (same seed → same terrain).
    expect(world2.getBlock(placed.q, placed.y - 2, placed.r)).toBe(world.getBlock(placed.q, placed.y - 2, placed.r));
    // Meshes for the restored world exist and are consistent.
    expectNoOrphans(world2, stub2);
    expect(stub2.meshes.size).toBe(MESH_COUNT);
    world2.dispose();
    expect(world2.chunkCount).toBe(0);
    expect(stub2.meshes.size).toBe(0); // dispose fired onChunkUnload for every meshed chunk
  });

  it('saveGame/loadGame/hasSave/clearSave work against an injected storage', () => {
    const storage = fakeStorage();
    expect(hasSave(storage)).toBe(false);
    const data = {
      version: SAVE_VERSION,
      seed: world.seed,
      time: START_TIME,
      day: 1,
      player: { x: player.x, y: player.y, z: player.z, yaw, pitch, flying: true },
      hotbar: DEFAULT_HOTBAR.slice(),
      selected: 0,
      edits: world.exportEdits(),
    };
    expect(saveGame(data, storage)).toBe(true);
    expect(hasSave(storage)).toBe(true);
    const loaded = loadGame(storage);
    expect(loaded.edits).toEqual(data.edits);
    expect(loaded.player.flying).toBe(true);
    clearSave(storage);
    expect(hasSave(storage)).toBe(false);
    expect(loadGame(storage)).toBeNull();
    // A throwing setItem (quota) reports false and leaves nothing behind.
    const full = { ...fakeStorage(), setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(saveGame(data, full)).toBe(false);
  });

  it('computeSky over a whole day never produces NaN or out-of-range values', () => {
    const sky = createSkyState();
    const steps = 2000;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const s = computeSky(t, sky);
      expect(s).toBe(sky); // in-place fill
      expect(Number.isFinite(s.time)).toBe(true);
      expect(isFiniteVec(s.sunDir)).toBe(true);
      expect(Math.hypot(...s.sunDir)).toBeCloseTo(1, 6);
      for (const c of [s.sunColor, s.zenithColor, s.horizonColor, s.fogColor]) {
        expect(isFiniteVec(c)).toBe(true);
        for (const ch of c) {
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(1);
        }
      }
      expect(s.sunIntensity).toBeGreaterThanOrEqual(0);
      expect(s.hemiIntensity).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(s.sunIntensity)).toBe(true);
      expect(Number.isFinite(s.hemiIntensity)).toBe(true);
      expect(s.daylight).toBeGreaterThanOrEqual(0);
      expect(s.daylight).toBeLessThanOrEqual(1);
      expect(s.stars).toBeGreaterThanOrEqual(0);
      expect(s.stars).toBeLessThanOrEqual(1);
      expect(typeof s.isDay).toBe('boolean');
    }
    // Midnight wraps: 0 and 1 are the same sky.
    const a = computeSky(0);
    const b = computeSky(1);
    expect(b).toEqual(a);
    // Never black at any hour (hemisphere or sun light present).
    for (let i = 0; i < 24; i++) {
      const s = computeSky(i / 24);
      expect(s.sunIntensity + s.hemiIntensity).toBeGreaterThan(0);
    }
  });

  it('advanceTime driven like the game loop stays finite and wraps exactly once per DAY_LENGTH_SECONDS', () => {
    let t = START_TIME;
    let wraps = 0;
    const dt = TICK;
    const ticks = Math.round(DAY_LENGTH_SECONDS / dt) + 1;
    for (let i = 0; i < ticks; i++) {
      const nt = advanceTime(t, dt);
      expect(Number.isFinite(nt)).toBe(true);
      expect(nt).toBeGreaterThanOrEqual(0);
      expect(nt).toBeLessThan(1);
      if (nt < t) wraps++;
      t = nt;
    }
    expect(wraps).toBe(1);
    expect(t).toBeCloseTo(START_TIME, 3);
    // Frozen clock (?time=) leaves time untouched with dt 0.
    expect(advanceTime(0.5, 0)).toBe(0.5);
    expect(formatTime(0.25)).toBe('06:00');
    expect(isFiniteVec(sunDirection(0.5))).toBe(true);
  });

  it('rune block: placed via setBlock + onBlockChange, scripted with @, triggered, saved, restored, and removed on break', () => {
    // main-style wiring: the hook keeps the store in step, the runner executes scripts against a CommandContext.
    const store = new RuneStore();
    /** @type {string[]} */
    const log = [];
    /** @type {string[]} */
    const said = [];
    let time = 0.3;
    /** @type {import('../../src/commands.js').CommandContext} */
    const ctx = {
      world,
      player,
      controls: { yaw, pitch },
      getTime: () => time,
      setTime: (t) => {
        time = t;
      },
      addTime: (s) => {
        time = (((time + s / 86400) % 1) + 1) % 1;
      },
      timeFrozen: false,
      hotbar: DEFAULT_HOTBAR.slice(),
      selected: 0,
      setHotbarSlot: () => {},
      say: (t) => said.push(t),
      teleport: (x, y, z) => {
        player.x = x;
        player.y = y;
        player.z = z;
      },
      setFlying: (on) => {
        player.flying = on;
      },
      runes: store,
      runner: /** @type {*} */ (null),
      rune: null,
      running: null,
      seed: world.seed,
    };
    const runner = new RuneRunner(store, ctx);
    ctx.runner = runner;
    runner.onLog = (line) => log.push(line);
    world.onBlockChange = (q, y, r, prev, next) => {
      if (next === BLOCK.RUNE_BLOCK && prev !== BLOCK.RUNE_BLOCK) store.ensure(q, y, r);
      else if (prev === BLOCK.RUNE_BLOCK && next !== BLOCK.RUNE_BLOCK) {
        runner.cancel(runeKey(q, y, r));
        store.delete(runeKey(q, y, r));
      }
    };

    // A surface cell two cells east of the player: solid with two air cells above it.
    const [pq, pr] = worldToHex(player.x, player.z);
    const rq = pq + 2;
    const rr = pr;
    let ry = -1;
    for (let y = WORLD_HEIGHT - 3; y >= 1; y--) {
      if (isSolid(world.getBlock(rq, y, rr)) && !isSolid(world.getBlock(rq, y + 1, rr)) && !isSolid(world.getBlock(rq, y + 2, rr))) {
        ry = y;
        break;
      }
    }
    expect(ry).toBeGreaterThan(0);
    expect(world.hasChunkAtCell(rq, rr)).toBe(true);
    const key = runeKey(rq, ry, rr);

    // Place: the hook creates a default (pristine) entry; it is not exported until customised.
    expect(world.setBlock(rq, ry, rr, BLOCK.RUNE_BLOCK)).toBe(true);
    expect(store.has(key)).toBe(true);
    expect(store.export()).toEqual({});
    const rune = store.set(rq, ry, rr, { script: 'setblock @ @1 @ stone\nsay built', label: 'harness' });
    expect(rune).not.toBeNull();
    expect(store.export()[key]).toEqual({ script: 'setblock @ @1 @ stone\nsay built', label: 'harness' });

    // Trigger and run: the script places STONE on top of its own block (rune-relative @) and says its line.
    expect(world.getBlock(rq, ry + 1, rr)).toBe(BLOCK.AIR);
    expect(runner.trigger(key, SOURCE.INTERACT)).toEqual({ ok: true });
    expect(runner.isRunning(key)).toBe(true);
    let frames = 0;
    while (runner.isRunning(key) && frames < 10) {
      runner.update(TICK);
      frames++;
    }
    expect(frames).toBeLessThanOrEqual(2);
    expect(world.getBlock(rq, ry + 1, rr)).toBe(BLOCK.STONE);
    expect(said).toEqual(['built']);
    expect(log.filter((l) => l.includes('usage'))).toEqual([]); // no command errors
    expect(runner.getLastRun(key)).toMatchObject({ commands: 2, errors: 0, cancelled: false, source: SOURCE.INTERACT });
    expect(store.has(key)).toBe(true); // a script never deletes its own rune by running
    converge(world, player.x, player.z); // re-mesh the edited chunk; nothing orphaned
    expectNoOrphans(world, stub);

    // Save: the runes field roundtrips and only holds the customised entry.
    const data = {
      version: SAVE_VERSION,
      seed: world.seed,
      time,
      day: 1,
      player: { x: player.x, y: player.y, z: player.z, yaw, pitch, flying: false },
      hotbar: DEFAULT_HOTBAR.slice(),
      selected: 0,
      edits: world.exportEdits(),
      runes: store.export(),
    };
    const text = serializeSave(data);
    const back = deserializeSave(text);
    expect(back).not.toBeNull();
    expect(back.runes).toEqual({ [key]: { script: 'setblock @ @1 @ stone\nsay built', label: 'harness' } });
    expect(serializeSave(back)).toBe(text);

    // Restore into a fresh world + store: the rune block and its script are both there, nothing runs.
    const world2 = new World({ seed: back.seed, renderDistance: RD, edits: back.edits, now: () => 0 });
    const stub2 = createStubRenderer();
    attach(world2, stub2);
    const store2 = new RuneStore();
    expect(store2.replaceAll(back.runes)).toEqual([]);
    expect(store2.version).toBe(0);
    converge(world2, back.player.x, back.player.z);
    expect(world2.getBlock(rq, ry, rr)).toBe(BLOCK.RUNE_BLOCK);
    expect(world2.getBlock(rq, ry + 1, rr)).toBe(BLOCK.STONE);
    expect(store2.get(key)).toMatchObject({ q: rq, y: ry, r: rr, script: 'setblock @ @1 @ stone\nsay built', label: 'harness', enabled: true, interact: true });
    expect(store2.export()).toEqual(back.runes);
    world2.dispose();

    // Break the rune block: the hook removes the entry and the save no longer carries it; the stone stays.
    expect(world.setBlock(rq, ry, rr, BLOCK.AIR)).toBe(true);
    expect(store.has(key)).toBe(false);
    expect(runner.isRunning(key)).toBe(false);
    expect(serializeSave({ ...data, edits: world.exportEdits(), runes: store.export() })).not.toContain('"runes"');
    expect(world.getBlock(rq, ry + 1, rr)).toBe(BLOCK.STONE);
    // A trigger on the now-empty cell is refused with a clear reason.
    expect(runner.trigger(key, SOURCE.INTERACT)).toEqual({ ok: false, reason: `no rune block at (${rq}, ${ry}, ${rr})` });
    world.onBlockChange = () => {};
  });

  it('the whole harness world is still internally consistent at the end', () => {
    expectNoOrphans(world, stub);
    expect(world.renderDistance).toBe(RD);
    expect(RENDER_DISTANCE).toBeGreaterThanOrEqual(RD);
    world.dispose();
    expect(world.chunkCount).toBe(0);
    expect(stub.meshes.size).toBe(0);
    // Edits survive dispose (they are what the save stores).
    expect(Object.keys(world.exportEdits()).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// v0.9 Survival (docs/DESIGN-survival.md §10 "I" test 3, CONTRACTS §42 / §49): the same real modules, in main.js's order,
// with main.js's own exported helpers for the decisions it makes.

/** The survival objects main keeps, fresh. */
function survivalObjects() {
  return { survival: new Survival(), pack: new Pack(), fireSlots: new FireSlots(), containers: new Containers() };
}

/** A minimal Creative save of `world` (what buildSaveData writes without the survival fields). */
function creativeSave(w, p) {
  return {
    version: SAVE_VERSION,
    seed: w.seed,
    time: START_TIME,
    day: 1,
    player: { x: p.x, y: p.y, z: p.z, yaw, pitch, flying: false },
    hotbar: DEFAULT_HOTBAR.slice(),
    selected: 0,
    edits: w.exportEdits(),
    meta: { name: 'Harness', createdAt: 1, lastPlayed: 2 },
  };
}

describe('integration harness: Survival (v0.9)', () => {
  it('a Creative world that never entered Survival saves byte-identically, still version 2; generation 2 makes it 3', () => {
    const w = new World({ seed: SEED, renderDistance: RD, now: () => 0 });
    expect(w.gen).toBe(1);
    const p = createPlayer(...w.findSpawn());
    const base = creativeSave(w, p);
    const fields = survivalSaveFields({ gen: w.gen, ...survivalObjects() });
    expect(fields).toEqual({});
    const text = serializeSave({ ...base, ...fields });
    expect(text).toBe(serializeSave(base));
    expect(JSON.parse(text).version).toBe(2);
    // A new world with the survival resources box checked (the default) is generation 2, in Creative: version 3.
    expect(loadingGen(null, {})).toBe(GEN_LATEST);
    expect(loadingGen(null, { survivalResources: false })).toBe(1);
    expect(loadingGen(base, {})).toBe(1);
    const g2 = JSON.parse(serializeSave({ ...base, ...survivalSaveFields({ gen: 2, ...survivalObjects() }) }));
    expect([g2.version, g2.gen, g2.mode, g2.survival]).toEqual([3, 2, undefined, undefined]);
    w.dispose();
  });

  it('a survival state saves gen, mode, survival and containers in order, and loads back', () => {
    const o = survivalObjects();
    o.survival.setMode('survival');
    o.pack.give('flint_pick', 1);
    o.pack.give('rock', 7);
    o.containers.ensureBasket(0, 64, 0);
    const fields = survivalSaveFields({ gen: 2, ...o });
    expect(Object.keys(fields)).toEqual(['gen', 'mode', 'survival', 'containers']);
    expect(fields.survival.pack.filter(Boolean)).toEqual([{ k: 'flint_pick', n: 1 }, { k: 'rock', n: 7 }]);
    const w = new World({ seed: SEED, renderDistance: RD, now: () => 0, gen: 2 });
    w.importEdits({});
    const save = { ...creativeSave(w, createPlayer(0, 70, 0)), ...fields, edits: { '0,0': [64, BLOCK.WICKER_BASKET] } };
    const back = deserializeSave(serializeSave(save));
    expect(back.version).toBe(3);
    expect(Object.keys(back).slice(-5)).toEqual(['gen', 'mode', 'survival', 'containers', 'meta']);
    const loaded = survivalObjects();
    loaded.survival.import(back.survival);
    expect(loadingMode(back, back.gen)).toEqual({ mode: 'survival', warning: null });
    loaded.pack.load(back.survival);
    expect(loaded.pack.count('rock')).toBe(7);
    // A hand-edited Survival save on generation 1 loads in Creative, with the warning.
    expect(loadingMode({ ...back, gen: undefined }, 1)).toEqual({ mode: 'creative', warning: SURVIVAL_NEEDS_GEN2 });
    w.dispose();
  });

  it('60 simulated seconds of Survival on a generation-2 world keep every vital in range', () => {
    const w = new World({ seed: SEED, renderDistance: RD, now: () => 0, gen: 2 });
    attach(w, createStubRenderer());
    const start = w.findSurvivalSpawn();
    converge(w, start[0], start[2]);
    const p = createPlayer(...start);
    const s = new Survival();
    expect(s.setMode('survival')).toBe(true);
    let sample = sampleClimate(w, p);
    expect([BIOME.PLAINS, BIOME.FOREST]).toContain(sample.biome);
    let t = START_TIME;
    let sinceSample = 0;
    // Standing at the survival spawn (on seed 1 any walk soon goes downhill into the sea, which is another test's business).
    for (let frame = 0; frame < 60 * 60; frame++) {
      // The climate is sampled every CLIMATE_SAMPLE_S, as main does.
      stepPlayer(p, IDLE, w.getBlock, TICK);
      sinceSample += TICK;
      if (sinceSample >= CLIMATE_SAMPLE_S) {
        sinceSample = 0;
        sample = sampleClimate(w, p);
      }
      t = advanceTime(t, TICK);
      const ev = s.step(TICK, { player: p, climate: sample, heat: 0, time: t, random: () => 0.99 });
      expect(ev.died).toBeNull();
      if (frame % 60 === 0) {
        const v = s.vitals;
        expect(v.health).toBeGreaterThan(0);
        expect(v.health).toBeLessThanOrEqual(STAT_MAX);
        expect(v.satiation).toBeGreaterThanOrEqual(0);
        expect(v.hydration).toBeGreaterThanOrEqual(0);
        expect(v.temp).toBeGreaterThanOrEqual(BODY_TEMP_MIN);
        expect(v.temp).toBeLessThanOrEqual(BODY_TEMP_MAX);
        expect(v.breath).toBeGreaterThanOrEqual(0);
        expect(v.breath).toBeLessThanOrEqual(BREATH_MAX_S);
        expect(Number.isFinite(s.felt)).toBe(true);
      }
    }
    // A minute on green land on a cool morning: a little hungrier (the cold factor too, §2.2) and thirstier, no harm done.
    expect(s.active).toBe(true);
    expect(s.vitals.health).toBe(100);
    // (At most 2.5× the resting drain, §2.2: 100 → 0 in 30 / 20 min at rest.)
    expect(s.vitals.satiation).toBeLessThan(80);
    expect(s.vitals.satiation).toBeGreaterThan(80 - 2.5 * 0.0556 * 60);
    expect(s.vitals.hydration).toBeLessThan(80);
    expect(s.vitals.hydration).toBeGreaterThan(80 - 2.5 * 0.0833 * 60);
    expect(Math.abs(s.vitals.temp - 37)).toBeLessThan(1.5);
    w.dispose();
  });

  it('lanes keep running under the pack screen (and the field book); nothing steps while dead or paused', () => {
    for (const st of [STATE.PLAYING, STATE.PACK, STATE.BOOK]) expect(stateSimulates(st), st).toBe(true);
    for (const st of [STATE.DEAD, STATE.PAUSED, STATE.PICKER, STATE.CONSOLE, STATE.EDITOR, STATE.TITLE, STATE.LOADING, STATE.CLICK_TO_PLAY]) {
      expect(stateSimulates(st), st).toBe(false);
    }
    // Frames as main runs them: the lane steps only in simulating states.
    const pack = new Pack();
    pack.give('plant_fibre', 4);
    const queue = new CraftQueue();
    expect(queue.enqueue('cord', 2, pack, { hand: true }).ok).toBe(true);
    let state = STATE.PACK;
    for (let i = 0; i < 90; i++) if (stateSimulates(state)) queue.step(TICK, pack, null, [0, 64, 0]);
    expect(pack.count('cord')).toBe(1);
    state = STATE.DEAD;
    for (let i = 0; i < 600; i++) if (stateSimulates(state)) queue.step(TICK, pack, null, [0, 64, 0]);
    expect(pack.count('cord')).toBe(1); // frozen: pitfall 28
  });

  it('a save left on the death screen reloads into DEAD, never into click-to-play or play', () => {
    const s = new Survival();
    s.setMode('survival');
    s.damage(500, 'zombie');
    expect(s.dead).toBe('zombie');
    const w = new World({ seed: SEED, renderDistance: RD, now: () => 0, gen: 2 });
    const save = { ...creativeSave(w, createPlayer(0, 70, 0)), ...survivalSaveFields({ gen: 2, ...survivalObjects(), survival: s }) };
    const back = deserializeSave(serializeSave(save));
    expect(back.survival.dead).toBe('zombie');
    const again = new Survival();
    again.import(back.survival);
    again.mode = loadingMode(back, back.gen).mode;
    expect(again.dead).toBe('zombie');
    expect(again.inSurvival).toBe(true);
    expect(again.active).toBe(false);
    for (const autoplay of [false, true]) expect(stateAfterLoading({ dead: Boolean(again.dead), autoplay })).toBe(STATE.DEAD);
    expect(stateAfterLoading({ dead: false, autoplay: false })).toBe(STATE.CLICK_TO_PLAY);
    expect(stateAfterLoading({ dead: false, autoplay: true })).toBe(STATE.PLAYING);
    // Waking clears it; the next save is alive.
    again.respawn();
    expect(again.export().dead).toBeUndefined();
    w.dispose();
  });

  it('`mode survival` from a rune script fails; from the console it is queued through ctx.survival', () => {
    const calls = [];
    const fakeSurvival = {
      mode: 'creative',
      hasState: false,
      setMode: (m) => {
        calls.push(m);
        return { ok: true, message: `${m} (saved with this world)` };
      },
      vitals: () => null,
      setVital: () => false,
      restoreVitals() {},
      packAdd: () => null,
      packClear() {},
      packList: () => '',
    };
    const cmd = parseLine('mode survival');
    const fromRune = executeCommand(cmd, { survival: fakeSurvival, running: { key: '0,64,0' }, rune: { q: 0, y: 64, r: 0 } });
    expect(fromRune.ok).toBe(false);
    expect(fromRune.message).toContain('only valid in the console');
    expect(calls).toEqual([]);
    const fromConsole = executeCommand(cmd, { survival: fakeSurvival, running: null, rune: null });
    expect(fromConsole).toMatchObject({ ok: true, message: 'survival (saved with this world)' });
    expect(calls).toEqual(['survival']);
  });

  it('?mode touches only the first world the page loads, and never raises an old saved world\'s generation', () => {
    const params = parseParams('?autoplay=1&mode=Survival');
    expect(params.mode).toBe('survival');
    expect(parseParams('?mode=hardcore').mode).toBeNull();
    expect(parseParams('').mode).toBeNull();
    expect(consumeModeParam(params)).toBe('survival');
    expect(params.mode).toBeNull();
    expect(consumeModeParam(params)).toBeNull(); // the next world (from the Worlds panel) is never touched
    const gen1 = { gen: undefined };
    expect(modeParamPlan('survival', { save: null, nosave: false })).toEqual({ apply: true, raiseGen: false, warning: null });
    expect(modeParamPlan('survival', { save: gen1, nosave: false })).toEqual({ apply: false, raiseGen: false, warning: MODE_PARAM_IGNORED });
    expect(modeParamPlan('survival', { save: gen1, nosave: true })).toEqual({ apply: true, raiseGen: true, warning: null });
    expect(modeParamPlan('survival', { save: { gen: 2 }, nosave: false })).toEqual({ apply: true, raiseGen: false, warning: null });
    expect(modeParamPlan('creative', { save: gen1, nosave: false }).apply).toBe(true);
    expect(modeParamPlan(null, { save: null, nosave: false }).apply).toBe(false);
  });

  it('Undo is refused in Survival: the pause menu disables it and says why', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
      const doc = documentFromHTML(html);
      let undone = 0;
      const menus = createMenus(/** @type {any} */ (doc), /** @type {any} */ ({ width: 256, height: 256 }), { onUndoPhysics: () => undone++ });
      const bp = { exportSwitches: () => ({ falling: true, water: true, collapse: true, explosions: true }), canUndo: true, lastEvent: { kind: 'explosion' } };
      const undo = /** @type {any} */ (doc.getElementById('btn-undo-physics'));
      menus.setPhysicsState(physicsMenuStateFor(bp, false));
      expect([undo.disabled, undo.textContent]).toEqual([false, 'Undo Last Explosion']);
      menus.setPhysicsState(physicsMenuStateFor(bp, true));
      expect([undo.disabled, undo.textContent]).toEqual([true, 'Undo (not in Survival)']);
      expect(physicsMenuStateFor(null, true)).toBeNull();
      menus.dispose();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('main\'s small survival decisions: knock cause, crush cells, death lines, chat lines', () => {
    expect(knockCause(3, 4)).toBe('blast');
    expect(knockCause(3, 3)).toBe('log');
    expect(cellsLifted(64.2, 65)).toBe(1);
    expect(cellsLifted(64, 65)).toBe(1);
    expect(cellsLifted(64, 66)).toBe(2);
    expect(deathScreenText('blackhole', null)).toEqual({ title: 'Swallowed by a black hole.', detail: 'Your belongings are lost.', where: '' });
    expect(deathScreenText('void', null, false).detail).toBe('You carried nothing.');
    expect(survivalIntroLines(BIOME.PLAINS, [10, -4], false)).toEqual([SURVIVAL_INTRO]);
    expect(survivalIntroLines(BIOME.DESERT, [10, -4], true)).toEqual([
      `${SURVIVAL_INTRO} ${HANDBOOK_INTRO}`, 'This land is harsh: green land lies near q 10, r -4.',
    ]);
    expect(leftBehindText([{ k: 'rock', n: 2 }])).toBe('Pack full: 2 Rock left behind');
    expect(spoiledText([{ k: 'raw_pork', n: 1 }, { k: 'honeyberries', n: 2 }])).toBe('1 Raw Pork and 2 Honeyberries went bad.');
    const pack = new Pack();
    pack.give('flint_pick', 1);
    pack.give('rock', 3);
    expect(packListText(pack)).toBe('1: Flint Pick (90/90)\n2: 3 Rock');
  });

  it('diagnostics: ?ui=pack, and the F3 survival line only while Survival is active (§9.10)', () => {
    expect(parseParams('?autoplay=1&ui=pack').ui).toBe('pack');
    const s = new Survival();
    expect(survivalDebugLine(s)).toBe('');
    s.setMode('survival');
    s.vitals.temp = 34.9;
    s.felt = 12.34;
    s.air = 9.8;
    expect(survivalDebugLine(s)).toBe(
      '\nSurvival: HP 100 · Nourishment 80 · Hydration 80 · Breath 20 · body 34.9 °C · felt 12.3 °C (air 9.8) · Chilled');
    s.damage(1000, 'fall');
    expect(survivalDebugLine(s)).toBe(''); // dead: not active
    const text = buildDebugText({ survival: null }, { fps: 60, frameMs: 16 });
    expect(text).not.toContain('Survival:');
  });

  it('the console pack rules (§14.2): add never mints a second handbook, clear gives it back in slot 8', () => {
    const pack = new Pack();
    // an empty pack (a save from before the handbook): `pack add handbook` gives the one copy, in the last hotbar slot
    expect(consolePackAdd(pack, HANDBOOK_KEY, 1)).toBeNull();
    expect(pack.slots[HOTBAR_SIZE - 1]).toEqual({ k: HANDBOOK_KEY, n: 1 });
    // a second copy is refused (nothing changes), and so is any count above one
    const v = pack.version;
    expect(consolePackAdd(pack, HANDBOOK_KEY, 1)).toEqual({ n: 1, refused: 'the pack already has a handbook' });
    expect(consolePackAdd(pack, HANDBOOK_KEY, 3)).toEqual({ n: 3, refused: 'one handbook is enough' });
    expect(pack.version).toBe(v);
    expect(pack.slots.filter((s) => s && s.k === HANDBOOK_KEY)).toHaveLength(1);
    // everything else adds as before: stacks in one piece, tools one at a time, the overflow reported
    expect(consolePackAdd(pack, 'rock', 70)).toBeNull();
    expect(pack.count('rock')).toBe(70);
    expect(consolePackAdd(pack, 'flint_pick', 2)).toBeNull();
    expect(pack.slots.filter((s) => s && s.k === 'flint_pick')).toHaveLength(2);
    for (let i = 0; i < PACK_SLOTS; i++) if (!pack.slots[i]) pack.slots[i] = { k: 'stick', n: 64 };
    expect(consolePackAdd(pack, 'clay_lump', 5)).toEqual([{ k: 'clay_lump', n: 5 }]);
    // `pack clear` empties everything, then the handbook comes back (slot 8)
    pack.wear[0] = { k: 'straw_hat', n: 1 };
    consolePackClear(pack);
    expect(pack.slots.filter(Boolean)).toEqual([{ k: HANDBOOK_KEY, n: 1 }]);
    expect(pack.slots[HOTBAR_SIZE - 1]).toEqual({ k: HANDBOOK_KEY, n: 1 });
    expect(pack.wear.filter(Boolean)).toEqual([]);
  });

  it('main imports the Handbook modules statically (KNOWN-ISSUES S2: no import.meta.glob guard is left)', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/main.js', import.meta.url)), 'utf8');
    expect(src).not.toContain('import.meta.glob');
    expect(src).toMatch(/^import \{[^}]*\bensureHandbook\b[^}]*\} from '\.\/handbook\.js';$/m);
    expect(src).toMatch(/^import \{ createHandbookUI \} from '\.\/handbookUI\.js';$/m);
    expect(src).not.toContain('cannot be opened in this build');
    // types.js's GameContext lists the v0.9 members main hands to diagnostics (KNOWN-ISSUES S3)
    const types = readFileSync(fileURLToPath(new URL('../../src/types.js', import.meta.url)), 'utf8');
    const ctx = types.slice(types.indexOf('@typedef {Object} GameContext'));
    for (const m of ['survival', 'pack', 'setMode', 'getMode', 'urlMode', 'selectSlot', 'interact', 'digTargeted', 'useSelected']) {
      expect(ctx, m).toMatch(new RegExp(`@property \\{[^\\n]*\\} \\[?${m}\\]?\\b`));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// v0.10 circuits (DESIGN-circuits §7 I-2): the R key, the right mouse button's control latch, snuffing and the device panel,
// through main.js's own rules (rKeyStep, rightMouseStep / ControlLatch, snuffsKeg, explainLine, panelCellChanged) on a real
// Circuits and BlockPhysics over a fake world wired with main's hooks.

describe('v0.10 circuits through main\'s rules (§7 I-2)', () => {
  const CY = 11;
  /** A fake world (natural stone ≤ 10) with block physics, black holes and circuits wired as main wires them. */
  function circuitRig() {
    const world = makeFakeWorld({ groundY: CY - 1 });
    const blackHoles = new BlackHoles();
    const bhWorld = makeBlackHoleWorld(() => world);
    /** @type {*} */
    let circuits = null;
    const physics = new BlockPhysics(world, {
      say() {}, sound() {}, particles() {}, bodies: () => [], player: () => null, knock() {}, ...physicsCircuitHooks(() => circuits),
    });
    const hooks = makeCircuitHooks({ world: () => world, physics: () => physics, blackHoles, blackHoleWorld: bhWorld, daylight: () => 1, now: () => 0 });
    circuits = new Circuits(new CircuitStore(), hooks);
    world.onBlockChange = (q, y, r, prev, next) => {
      blackHoles.onBlockChange(q, y, r, prev, next);
      circuits.onBlockChange(q, y, r, prev, next);
      physics.onBlockChange(q, y, r, prev, next);
    };
    const placed = [];
    const latch = new ControlLatch();
    const env = {
      isControl: (id) => isControlPart(id),
      operate: (h) => circuits.interact(h.q, h.y, h.r, 'use'),
      hold: (h) => circuits.hold(h.q, h.y, h.r),
      place: () => placed.push(1),
    };
    const frame = () => {
      physics.step(TICK);
      circuits.step(TICK);
    };
    const hitAt = (q, r, id) => ({ q, y: CY, r, blockId: id, face: 0, nx: 0, ny: 1, nz: 0, distance: 3 });
    return { world, physics, circuits, latch, env, placed, frame, hitAt };
  }
  const down = { rightPressed: true, right: true };
  const held = { rightPressed: false, right: true };
  const up = { rightPressed: false, right: false };

  it('the R key on a keg does not light it and explains (once per 4 s); with a Spark Transmitter selected it sends', () => {
    const t = circuitRig();
    t.world.setBlock(0, CY, 0, BLOCK.POWDER_KEG);
    const keg = t.hitAt(0, 0, BLOCK.POWDER_KEG);
    expect(rKeyStep(keg, { circuits: t.circuits, pocketSelected: false })).toEqual({ kind: 'explain' });
    for (let i = 0; i < 30; i++) t.frame();
    expect(t.physics.explosions.isBurning(0, CY, 0)).toBe(false);
    expect(explainLine(BLOCK.POWDER_KEG, -Infinity, 10)).toBe(KEG_EXPLAIN);
    expect(explainLine(BLOCK.POWDER_KEG, 10, 12)).toBeNull(); // pressed again 2 s later: nothing
    expect(explainLine(BLOCK.POWDER_KEG, 10, 14)).toBe(KEG_EXPLAIN);
    expect(explainLine(BLOCK.COLLAPSAR_CHARGE, -Infinity, 0)).toMatch(/Collapsar Charge/);
    expect(rKeyStep(keg, { circuits: t.circuits, pocketSelected: true })).toEqual({ kind: 'pocket' });
    // a part's own R action comes first, even with the transmitter selected (§4.9 step 1)
    t.world.setBlock(2, CY, 0, BLOCK.KNIFE_SWITCH);
    const sw = rKeyStep(t.hitAt(2, 0, BLOCK.KNIFE_SWITCH), { circuits: t.circuits, pocketSelected: true });
    expect(sw.kind).toBe('part');
    expect(t.circuits.store.get(`2,${CY},0`).on).toBe(true);
    // a Rune Block next, then nothing at all
    expect(rKeyStep(t.hitAt(4, 0, BLOCK.RUNE_BLOCK), { circuits: t.circuits, pocketSelected: true })).toEqual({ kind: 'rune' });
    expect(rKeyStep(t.hitAt(4, 0, BLOCK.STONE), { circuits: t.circuits, pocketSelected: false })).toBeNull();
  });

  it('right-click on a knife switch toggles it and places nothing; held for 1 s it still toggles once and places nothing', () => {
    const t = circuitRig();
    t.world.setBlock(0, CY, 0, BLOCK.KNIFE_SWITCH);
    const sw = t.hitAt(0, 0, BLOCK.KNIFE_SWITCH);
    const on = () => Boolean(t.circuits.store.get(`0,${CY},0`)?.on);
    expect(rightMouseStep(t.latch, down, sw, false, TICK, t.env)).toBe('operate');
    rightMouseStep(t.latch, up, sw, false, TICK, t.env);
    expect(on()).toBe(true);
    expect(t.placed).toHaveLength(0);
    // pressed and held for a full second (5 × PLACE_REPEAT_S): one toggle, no place
    rightMouseStep(t.latch, down, sw, false, TICK, t.env);
    for (let i = 0; i < 60; i++) {
      expect(rightMouseStep(t.latch, held, sw, false, TICK, t.env)).toBe('hold');
      t.frame();
    }
    rightMouseStep(t.latch, up, sw, false, TICK, t.env);
    expect(on()).toBe(false);
    expect(t.placed).toHaveLength(0);
    // holding right-click while the crosshair slides off the control onto stone: still nothing placed until released
    rightMouseStep(t.latch, down, sw, false, TICK, t.env);
    for (let i = 0; i < 30; i++) rightMouseStep(t.latch, held, t.hitAt(5, 0, BLOCK.STONE), false, TICK, t.env);
    expect(t.placed).toHaveLength(0);
    rightMouseStep(t.latch, up, null, false, TICK, t.env);
    // the place repeat never places against a control without Shift
    rightMouseStep(t.latch, down, t.hitAt(5, 0, BLOCK.STONE), false, TICK, t.env);
    expect(t.placed).toHaveLength(1);
    for (let i = 0; i < 30; i++) rightMouseStep(t.latch, held, sw, false, TICK, t.env);
    expect(t.placed).toHaveLength(1);
  });

  it('Shift+right-click places against a switch (and does not toggle it)', () => {
    const t = circuitRig();
    t.world.setBlock(0, CY, 0, BLOCK.KNIFE_SWITCH);
    const sw = t.hitAt(0, 0, BLOCK.KNIFE_SWITCH);
    expect(rightMouseStep(t.latch, down, sw, true, TICK, t.env)).toBe('place');
    expect(t.placed).toHaveLength(1);
    expect(Boolean(t.circuits.store.get(`0,${CY},0`)?.on)).toBe(false);
    // and the shifted hold repeats like any place
    for (let i = 0; i < Math.round(PLACE_REPEAT_S / TICK) + 1; i++) rightMouseStep(t.latch, held, sw, true, TICK, t.env);
    expect(t.placed).toHaveLength(2);
  });

  it('holding right-click on the doorbell\'s button for 2 s rings the bell for 2 s (§4.14 example 1)', () => {
    const t = circuitRig();
    t.world.setBlock(0, CY, 0, BLOCK.VOLTAIC_BATTERY);
    for (let q = 1; q <= 6; q++) t.world.setBlock(q, CY, 0, BLOCK.COPPER_WIRE);
    t.world.setBlock(7, CY, 0, BLOCK.PUSH_BUTTON);
    for (let q = 8; q <= 10; q++) t.world.setBlock(q, CY, 0, BLOCK.COPPER_WIRE);
    t.world.setBlock(11, CY, 0, BLOCK.ELECTRIC_BELL);
    for (let i = 0; i < 10; i++) t.frame();
    const bell = () => t.circuits.probe(11, CY, 0);
    expect(bell().state).not.toBe('ringing');
    const button = t.hitAt(7, 0, BLOCK.PUSH_BUTTON);
    rightMouseStep(t.latch, down, button, false, TICK, t.env);
    let ringing = 0;
    for (let i = 0; i < 120; i++) {
      rightMouseStep(t.latch, held, button, false, TICK, t.env);
      t.frame();
      if (bell().state === 'ringing') ringing++;
    }
    expect(ringing).toBeGreaterThan(110); // all 2 s, but the first tick or two
    expect(bell().volts).toBeCloseTo(5.4375, 9); // 6 − 9 × 0.0625
    rightMouseStep(t.latch, up, button, false, TICK, t.env);
    for (let i = 0; i < 30; i++) t.frame(); // released: 0.1 s more, then silence
    expect(bell().state).not.toBe('ringing');
    expect(t.circuits.probe(1, CY, 0).volts).toBe(6); // no current, no drop
    expect(t.placed).toHaveLength(0);
  });

  it('a left-click on a keg burning in place (lit by ignite) snuffs it and keeps the keg', () => {
    const t = circuitRig();
    t.world.setBlock(0, CY, 0, BLOCK.POWDER_KEG);
    expect(t.circuits.ignite(0, CY, 0).ok).toBe(true); // 3 s in place
    const keg = t.hitAt(0, 0, BLOCK.POWDER_KEG);
    expect(snuffsKeg(keg, t.physics.explosions)).toBe(true);
    expect(t.physics.explosions.snuff(0, CY, 0)).toBe(true);
    expect(snuffsKeg(keg, t.physics.explosions)).toBe(false);
    for (let i = 0; i < 240; i++) t.frame();
    expect(t.world.getBlock(0, CY, 0)).toBe(BLOCK.POWDER_KEG);
    expect(t.physics.explosions.blastCount).toBe(0);
    expect(kegHintText(true, false)).toBe('Powder Keg · light it with a fuse, a torch or an igniter');
    expect(kegHintText(true, true)).toBe('Powder Keg · burning! left-click: pinch out the fuse');
    expect(kegHintText(false, false)).toBe('Powder Keg (explosions are off)');
  });

  it('the moving copies main draws reach the circuit renderer too: the collapsar charge\'s swelling copy is a device model', () => {
    // A charge going off pushes its own block as a moving copy in FLASH and IMPLODE; devices are not meshed (the art redo),
    // so only circuitRenderer.syncMoving can draw it.
    const t = circuitRig();
    t.world.setBlock(0, CY, 0, BLOCK.COLLAPSAR_CHARGE);
    const holes = new BlackHoles();
    const bhWorld = makeBlackHoleWorld(() => t.world);
    expect(holes.activate(0, CY, 0, bhWorld).ok).toBe(true);
    const seen = new Set();
    for (let i = 0; i < 240; i++) {
      holes.update(TICK, bhWorld);
      holes.renderItems((id, x, y, z, rx, ry, rz, s) => seen.add(`${id}:${s > 0}`));
    }
    expect(seen.has(`${BLOCK.COLLAPSAR_CHARGE}:true`)).toBe(true);
    expect(getBlockDef(BLOCK.COLLAPSAR_CHARGE).meshed).toBe(false);
    // main: every frame's moving list goes to both renderers, and both are cleared together.
    const src = readFileSync(fileURLToPath(new URL('../../src/main.js', import.meta.url)), 'utf8');
    expect(src).toMatch(/fallingRenderer\.sync\(movingItems, movingCount\);\n\s+circuitRenderer\.syncMoving\(movingItems, movingCount\);/);
    const clears = src.match(/fallingRenderer\.sync\(\[\], 0\);\n\s+circuitRenderer\.syncMoving\(null\);/g) ?? [];
    expect(clears.length).toBe((src.match(/fallingRenderer\.sync\(\[\], 0\);/g) ?? []).length);
    expect(clears.length).toBeGreaterThan(0);
  });

  it('Creative: holding the left button on a burning keg pinches it out and keeps it; the hold does not break it after', () => {
    const step = /** @type {*} */ (mainModule).leftMouseStep;
    expect(typeof step).toBe('function');
    const t = circuitRig();
    t.world.setBlock(0, CY, 0, BLOCK.POWDER_KEG);
    t.world.setBlock(2, CY, 0, BLOCK.STONE);
    expect(t.circuits.ignite(0, CY, 0).ok).toBe(true);
    let target = t.hitAt(0, 0, BLOCK.POWDER_KEG);
    const env = {
      snuffs: () => snuffsKeg(target, t.physics.explosions),
      // main's breakTargeted: a keg burning in place is snuffed, anything else broken
      act: () => (snuffsKeg(target, t.physics.explosions) ? t.physics.explosions.snuff(target.q, target.y, target.r)
        : t.world.setBlock(target.q, target.y, target.r, BLOCK.AIR)),
    };
    const st = { held: 0, snuffed: false };
    const did = [];
    did.push(step(st, { leftPressed: true, left: true }, TICK, env));
    for (let i = 0; i < 90; i++) {
      did.push(step(st, { leftPressed: false, left: true }, TICK, env)); // held 1.5 s
      t.frame();
    }
    expect(did[0]).toBe('snuff');
    expect(did.filter((d) => d === 'break')).toEqual([]);
    expect(t.world.getBlock(0, CY, 0)).toBe(BLOCK.POWDER_KEG);
    expect(t.physics.explosions.isBurning(0, CY, 0)).toBe(false);
    step(st, { leftPressed: false, left: false }, TICK, env); // released
    // Holding on anything else still repeats the break every BREAK_REPEAT_S.
    target = t.hitAt(2, 0, BLOCK.STONE);
    expect(step(st, { leftPressed: true, left: true }, TICK, env)).toBe('break');
    expect(t.world.getBlock(2, CY, 0)).toBe(BLOCK.AIR);
    t.world.setBlock(2, CY, 0, BLOCK.STONE);
    let breaks = 0;
    for (let i = 0; i < 40; i++) if (step(st, { leftPressed: false, left: true }, TICK, env) === 'break') breaks++;
    expect(breaks).toBe(2); // 0.67 s held: the repeat at 0.25 s and at 0.5 s
  });

  it('Survival: a keg burning in place says how to put it out, not which axe it needs (the snuff needs no tool)', () => {
    const t = circuitRig();
    t.world.setBlock(0, CY, 0, BLOCK.POWDER_KEG);
    const keg = t.hitAt(0, 0, BLOCK.POWDER_KEG);
    const burningKegHint = /** @type {*} */ (mainModule).burningKegHint;
    expect(typeof burningKegHint).toBe('function');
    expect(burningKegHint(keg, t.physics.explosions)).toBeNull(); // not lit: the usual hints apply
    expect(harvestHint(BLOCK.POWDER_KEG)).toMatch(/axe/); // … and bare-handed that is the tool requirement
    expect(canHarvest(BLOCK.POWDER_KEG, null)).toBe(false);
    expect(t.circuits.ignite(0, CY, 0).ok).toBe(true); // lit in place (a campfire's way)
    expect(burningKegHint(keg, t.physics.explosions)).toBe('Powder Keg · burning! left-click: pinch out the fuse');
    expect(burningKegHint(keg, null)).toBeNull();
    // survivalHintText asks for it before the tool requirement.
    const src = readFileSync(fileURLToPath(new URL('../../src/main.js', import.meta.url)), 'utf8');
    const at = src.indexOf('  function survivalHintText() {');
    const body = src.slice(at, src.indexOf('\n  }\n', at));
    expect(body.indexOf('burningKegHint(h,')).toBeGreaterThan(0);
    expect(body.indexOf('burningKegHint(h,')).toBeLessThan(body.indexOf('harvestHint('));
  });

  it('a fuse burning beside a big wired area rebuilds the wiring at most once a second; a placed part at once', () => {
    const due = /** @type {*} */ (mainModule).wiringRebuildDue;
    expect(typeof due).toBe('function');
    const S = /** @type {*} */ (mainModule).FUSE_REBUILD_S;
    expect(S).toBe(1);
    const t = circuitRig();
    for (let q = 0; q < 30; q++) for (let r = 0; r < 30; r++) t.world.setBlock(q, CY, r, BLOCK.COPPER_WIRE);
    for (let q = 0; q < 40; q++) t.world.setBlock(q, CY, -3, BLOCK.POWDER_FUSE);
    const built = { geometry: -1, burn: -1, at: -Infinity };
    let rebuilds = 0;
    let time = 0;
    const frame = () => {
      t.circuits.step(TICK);
      time += TICK;
      if (due(built, t.circuits.geometryVersion, t.circuits.burnVersion, false, time)) {
        built.geometry = t.circuits.geometryVersion;
        built.burn = t.circuits.burnVersion;
        built.at = time;
        t.circuits.geometryBuilt();
        rebuilds++;
      }
    };
    for (let i = 0; i < 10; i++) frame();
    rebuilds = 0;
    expect(t.circuits.ignite(0, CY, -3).ok).toBe(true);
    for (let i = 0; i < 18 * 60; i++) frame(); // the 40 cells burn for 16 s, one every 0.4 s
    expect(t.world.getBlock(39, CY, -3)).toBe(BLOCK.AIR);
    expect(rebuilds).toBeGreaterThan(10);
    expect(rebuilds).toBeLessThanOrEqual(18); // not 40 (one per burnt cell)
    expect(built.burn).toBe(t.circuits.burnVersion); // and the last burnt cells are gone from the wiring
    // A part placed: the very next frame.
    rebuilds = 0;
    t.world.setBlock(50, CY, 0, BLOCK.COPPER_WIRE);
    frame();
    expect(rebuilds).toBe(1);
    expect(due(built, built.geometry, built.burn, true, time)).toBe(true); // the eye moved
    expect(due(built, built.geometry, built.burn, false, time + 5)).toBe(false); // nothing changed
  });

  it('?scene=circuits: the timer row\'s keg going off leaves the other rows standing (rows more than a blast apart)', () => {
    const t = circuitRig();
    const scene = circuitSceneWrites(0, CY, 0);
    for (const [q, y, r, id] of scene.blocks) t.world.setBlock(q, y, r, id);
    for (const [q, y, r, face] of scene.faces) t.circuits.setInputFace(q, y, r, face);
    for (const [q, y, r, partial] of scene.settings) t.circuits.applySettings(q, y, r, partial);
    for (let i = 0; i < 10; i++) t.frame();
    const [kq, ky, kr] = scene.named['timer.keg'];
    expect(t.circuits.ignite(kq, ky, kr).ok).toBe(true);
    for (let i = 0; i < 6 * 60 && t.physics.explosions.blastCount === 0; i++) t.frame();
    for (let i = 0; i < 120; i++) t.frame();
    expect(t.physics.explosions.blastCount).toBe(1); // the switch row's keg did not follow
    expect(t.world.getBlock(kq, ky, kr)).not.toBe(BLOCK.POWDER_KEG);
    for (const name of ['switch.keg', 'switch.igniter', 'switch.knife', 'lamp.relay', 'lamp.battery', 'lamp.lamp', 'doorbell.button', 'doorbell.bell']) {
      const [q, y, r] = scene.named[name];
      expect(t.world.getBlock(q, y, r), name).not.toBe(BLOCK.AIR);
    }
    expect(scene.bounds).toEqual({ q0: 0, q1: 11, r0: 0, r1: 3 * 6 + 1 }); // what main flattens (plus 2)
  });

  it('placing a timer, relay or coherer gives it the face back at the player unless a battery stands there (partPlaced)', () => {
    const t = circuitRig();
    t.world.setBlock(0, CY, 0, BLOCK.VOLTAIC_BATTERY);
    t.world.setBlock(1, CY, 0, BLOCK.CLOCKWORK_TIMER);
    expect(t.circuits.placementInputFace(1, CY, 0, 3)).toBe(4);
    const src = readFileSync(fileURLToPath(new URL('../../src/main.js', import.meta.url)), 'utf8');
    const at = src.indexOf('  function partPlaced(id, cell) {');
    const body = src.slice(at, src.indexOf('\n  }\n', at));
    expect(body).toMatch(/circuits\.placementInputFace\(cell\[0\], cell\[1\], cell\[2\], inputFaceFromYaw\(controls\.yaw\)\)/);
  });

  it('the device panel: Creative freezes the world under it, Survival keeps it running; its part changing closes it', () => {
    expect(stateSimulates(STATE.DEVICE)).toBe(false);
    expect(stateSimulates(STATE.DEVICE, false)).toBe(false);
    expect(stateSimulates(STATE.DEVICE, true)).toBe(true);
    expect(stateSimulates(STATE.PACK)).toBe(true); // survival's states unchanged
    const t = circuitRig();
    t.world.setBlock(0, CY, 0, BLOCK.CLOCKWORK_TIMER);
    const view = t.circuits.panelView(0, CY, 0, true);
    expect(view.key).toBe(`0,${CY},0`);
    expect(view.actions).toEqual(['start']);
    // a console-less setblock of the timer's cell (Creative), or a blast removing it (Survival): main closes the panel
    let closed = false;
    const prevHook = t.world.onBlockChange;
    t.world.onBlockChange = (q, y, r, prev, next) => {
      prevHook(q, y, r, prev, next);
      if (panelCellChanged(view.key, q, y, r, prev, next)) closed = true;
    };
    t.world.setBlock(1, CY, 0, BLOCK.STONE);
    expect(closed).toBe(false);
    t.world.setBlock(0, CY, 0, BLOCK.AIR);
    expect(closed).toBe(true);
    expect(panelCellChanged(null, 0, CY, 0, 1, 0)).toBe(false);
  });

  it('dying in Survival with the device panel open closes it first: no screen is left up over the death screen (§2.5, §57)', () => {
    // Every state but PLAYING in which Survival's world steps is a screen over a world that can kill: die() closes it.
    const closes = /** @type {*} */ (mainModule).screenClosedOnDeath;
    expect(typeof closes).toBe('function');
    for (const s of Object.values(STATE)) {
      if (s === STATE.PLAYING || !stateSimulates(s, true)) expect(closes(s), s).toBeNull();
      else expect(closes(s), s).not.toBeNull();
    }
    expect(closes(STATE.DEVICE)).toBe('device');
    // … and main's die() does so before the death state; closing the panel never resumes play from there, and a panel
    // still showing outside STATE.DEVICE is closed rather than left with its key capture on (Done / Esc / Shift+R).
    const src = readFileSync(fileURLToPath(new URL('../../src/main.js', import.meta.url)), 'utf8');
    const dieAt = src.indexOf('  function die(cause) {');
    const die = src.slice(dieAt, src.indexOf('\n  }\n', dieAt));
    const deadAt = die.indexOf('setState(STATE.DEAD)');
    expect(deadAt).toBeGreaterThan(0);
    expect(die.slice(0, deadAt)).toMatch(/screenClosedOnDeath\(state\)/);
    expect(die.slice(0, deadAt)).toMatch(/=== 'device'\) closeDevicePanel\(false\)/);
    const closeAt = src.indexOf('  function closeDevicePanel(');
    const close = src.slice(closeAt, src.indexOf('\n  }\n', closeAt));
    expect(close).not.toMatch(/if \(state !== STATE\.DEVICE\) return;/);
    expect(close).toMatch(/if \(devicePanel\.isOpen\(\)\) devicePanel\.close\(\);/);
    expect(close).toMatch(/if \(inDevice && resume\) enterPlayingFromModal\(\);/);
  });

  it('a hotbar slot holding the old BLACK_HOLE (66) holds the Collapsar Charge (§2.10)', () => {
    expect(hotbarFrom([66, 1, 2, 3, 4, 5, 6, 7, 8])[0]).toBe(BLOCK.COLLAPSAR_CHARGE);
    expect(hotbarFrom([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(hotbarFrom(null)).toEqual(DEFAULT_HOTBAR);
  });

  it('survival keeps its R priorities, with the parts and the pocket key slotted in (§4.9, §8.3)', () => {
    const pack = new Pack();
    const base = { waterHit: null, headInWater: false, pack, partR: (id) => hasRAction(id) };
    const fuse = { q: 0, y: CY, r: 0, blockId: BLOCK.POWDER_FUSE, face: 0, distance: 2 };
    expect(interactKind({ ...base, hit: fuse, selectedKey: null })).toMatchObject({ kind: 'fuse_hint', hint: 'Powder Fuse · needs a Fire Drill (R key)' });
    pack.add({ k: 'fire_drill', n: 1 });
    expect(interactKind({ ...base, hit: fuse, selectedKey: null })).toMatchObject({ kind: 'circuit', q: 0, y: CY, r: 0 });
    const sw = { ...fuse, blockId: BLOCK.KNIFE_SWITCH };
    expect(interactKind({ ...base, hit: sw, selectedKey: 'spark_transmitter' })).toMatchObject({ kind: 'circuit' });
    const keg = { ...fuse, blockId: BLOCK.POWDER_KEG };
    expect(interactKind({ ...base, hit: keg, selectedKey: 'spark_transmitter' })).toEqual({ kind: 'pocket' });
    expect(interactKind({ ...base, hit: keg, selectedKey: null })).toBeNull(); // → the rune, then the keg's explanation
    expect(interactKind({ ...base, hit: keg, selectedKey: HANDBOOK_KEY })).toMatchObject({ kind: 'read' }); // the Handbook first
    // without circuits (no partR), survival's old steps are exactly as they were
    expect(interactKind({ ...base, partR: undefined, hit: fuse, selectedKey: 'spark_transmitter' })).toBeNull();
  });
});
