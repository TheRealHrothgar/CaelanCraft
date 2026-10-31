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
import { countFaces } from '../helpers/fixtures.js';

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
