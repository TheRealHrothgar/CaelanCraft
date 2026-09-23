// Integration harness — docs/PLAN-build.md §2.12. Node only: no Three.js, no DOM.
//
// Drives the REAL world / worldgen / mesher / raycast / physics / storage / daynight modules through the
// same sequence main.js runs in the browser, with a stub renderer that records setChunkMesh /
// removeChunkMesh. The steps build on each other (spawn → land → raycast → break → place → walk → save),
// so they run in file order inside one describe and share the state below.
import { describe, it, expect, beforeAll } from 'vitest';
import {
  CHUNK_SIZE, WORLD_HEIGHT, EYE_HEIGHT, REACH, SEA_LEVEL, RENDER_DISTANCE, DATA_RADIUS_EXTRA,
  UNLOAD_RADIUS_EXTRA, MAX_SUBSTEP_DT, DAY_LENGTH_SECONDS, START_TIME,
} from '../../src/config.js';
import { FACE_NZ, chunkKey, inHeightRange, lookDirection, yawToForward } from '../../src/coords.js';
import {
  BLOCK, DEFAULT_HOTBAR, isBreakable, isPlaceable, isReplaceable, isSolid, isTargetable,
} from '../../src/blocks.js';
import { World } from '../../src/world.js';
import { createPlayer, stepPlayer, getEyeHeight, playerIntersectsBlock } from '../../src/physics.js';
import { raycastVoxel } from '../../src/raycast.js';
import { serializeSave, deserializeSave, saveGame, loadGame, hasSave, clearSave } from '../../src/storage.js';
import { computeSky, advanceTime, createSkyState, sunDirection, formatTime } from '../../src/daynight.js';
import { countFaces } from '../helpers/fixtures.js';

const SEED = 1;
const RD = 2;
const TICK = 1 / 60;
const IDLE = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };

// ---------------------------------------------------------------------------------------------
// helpers

/** Renderer stand-in: remembers the latest ChunkMeshData per key and every call, like renderer.js does. */
function createStubRenderer() {
  /** @type {Map<string, import('../../src/types.js').ChunkMeshData>} */
  const meshes = new Map();
  /** @type {{ key: string, cx: number, cz: number }[]} */
  const setCalls = [];
  /** @type {string[]} */
  const removeCalls = [];
  return {
    meshes,
    setCalls,
    removeCalls,
    setChunkMesh(key, cx, cz, meshData) {
      setCalls.push({ key, cx, cz });
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
  world.onChunkMesh = (key, cx, cz, m) => stub.setChunkMesh(key, cx, cz, m);
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
  return raycastVoxel(world.getBlock, player.x, player.y + getEyeHeight(player), player.z, dx, dy, dz, REACH);
}

/** main.js place rule (CONTRACTS §23): hit + normal, in range, replaceable, not inside the player. */
function tryPlace(world, player, hit, id) {
  if (!hit || hit.face < 0 || !isPlaceable(id)) return false;
  const tx = hit.x + hit.nx;
  const ty = hit.y + hit.ny;
  const tz = hit.z + hit.nz;
  if (!inHeightRange(ty)) return false;
  if (!isReplaceable(world.getBlock(tx, ty, tz))) return false;
  if (isSolid(id) && playerIntersectsBlock(player, tx, ty, tz)) return false;
  return world.setBlock(tx, ty, tz, id);
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
/** @type {import('../../src/types.js').PlayerState} */
let player;
/** @type {import('../../src/types.js').RaycastHit} */
let groundHit;
/** id the broken block had before the break */
let brokenId;
/** world coordinates of the placed STONE */
let placed;
const yaw = Math.PI; // face +Z like a fresh spawn in main.js
const pitch = 0;

describe('integration harness: world + physics + raycast + storage + daynight (seed 1, rd 2)', () => {
  beforeAll(() => {
    world = new World({ seed: SEED, renderDistance: RD, now: () => 0 });
    stub = createStubRenderer();
    attach(world, stub);
    spawn = world.findSpawn();
  });

  it('findSpawn returns a dry, above-sea-level column at block centre', () => {
    expect(spawn).toHaveLength(3);
    expect(spawn[0] - Math.floor(spawn[0])).toBeCloseTo(0.5, 12);
    expect(spawn[2] - Math.floor(spawn[2])).toBeCloseTo(0.5, 12);
    expect(spawn[1]).toBeGreaterThanOrEqual(SEA_LEVEL + 3);
    expect(spawn[1]).toBeLessThan(WORLD_HEIGHT);
    const h = world.getSurfaceHeight(Math.floor(spawn[0]), Math.floor(spawn[2]));
    expect(spawn[1]).toBe(h + 1);
  });

  it('loads the (2·(rd+1)+1)² data ring and meshes the (2·rd+1)² render ring around spawn', () => {
    // Loading screen: update until the spawn chunk is ready, then drain everything else.
    let guard = 0;
    let generated = 0;
    while (!world.isReadyAt(spawn[0], spawn[2])) {
      generated += world.update(spawn[0], spawn[2], Infinity).generated;
      if (++guard > 400) throw new Error('spawn chunk never became ready');
    }
    expect(world.isReadyAt(spawn[0], spawn[2])).toBe(true);

    generated += converge(world, spawn[0], spawn[2]).generated;
    const dataSide = 2 * (RD + DATA_RADIUS_EXTRA) + 1;
    const meshSide = 2 * RD + 1;
    expect(world.chunkCount).toBe(dataSide * dataSide); // 49
    expect(generated).toBe(dataSide * dataSide);
    expect(stub.meshes.size).toBe(meshSide * meshSide); // 25
    expect(stub.setCalls.length).toBe(meshSide * meshSide); // each chunk meshed exactly once
    expectNoOrphans(world, stub);

    // Nothing inside the render ring is left dirty; every mesh has real geometry.
    const scx = Math.floor(spawn[0] / CHUNK_SIZE);
    const scz = Math.floor(spawn[2] / CHUNK_SIZE);
    for (let dx = -RD; dx <= RD; dx++) {
      for (let dz = -RD; dz <= RD; dz++) {
        const c = world.getChunk(scx + dx, scz + dz);
        expect(c).toBeDefined();
        expect(c.dirty).toBe(false);
        expect(c.meshed).toBe(true);
        const m = stub.meshes.get(chunkKey(scx + dx, scz + dz));
        expect(countFaces(m)).toBeGreaterThan(0);
        expect(m.opaque).not.toBeNull();
      }
    }
  });

  it('spawn column is standable: solid below the feet, two air blocks above', () => {
    const bx = Math.floor(spawn[0]);
    const bz = Math.floor(spawn[2]);
    const by = Math.floor(spawn[1]);
    expect(isSolid(world.getBlock(bx, by - 1, bz))).toBe(true);
    expect(isSolid(world.getBlock(bx, by, bz))).toBe(false);
    expect(isSolid(world.getBlock(bx, by + 1, bz))).toBe(false);
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
    // Standing on the spawn surface (feet within a hair of the block top, never inside it).
    expect(player.y).toBeGreaterThanOrEqual(Math.floor(spawn[1]));
    expect(player.y).toBeLessThan(Math.floor(spawn[1]) + 0.01);
    expect(isSolid(world.getBlock(Math.floor(player.x), Math.floor(player.y) - 1, Math.floor(player.z)))).toBe(true);
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

  it('looking straight down from the eye hits the block under the feet at ≈ EYE_HEIGHT', () => {
    groundHit = castFrom(world, player, yaw, -Math.PI / 2 + 1e-6);
    expect(groundHit).not.toBeNull();
    expect(groundHit.x).toBe(Math.floor(player.x));
    expect(groundHit.z).toBe(Math.floor(player.z));
    expect(groundHit.y).toBe(Math.floor(player.y) - 1);
    expect(groundHit.face).toBe(2); // +Y top face
    expect([groundHit.nx, groundHit.ny, groundHit.nz]).toEqual([0, 1, 0]);
    expect(groundHit.distance).toBeCloseTo(EYE_HEIGHT, 3);
    expect(isTargetable(groundHit.blockId)).toBe(true);
    expect(groundHit.blockId).toBe(world.getBlock(groundHit.x, groundHit.y, groundHit.z));
  });

  it('looking at the horizon hits a block placed three cells ahead on its -Z face at the exact distance', () => {
    // yaw = π faces +Z (CONTRACTS §0), so the ray leaves the eye along +Z at head height.
    expect(yawToForward(yaw)[1]).toBeCloseTo(1, 12);
    const bx = Math.floor(player.x);
    const bz = Math.floor(player.z);
    const ey = Math.floor(player.y + getEyeHeight(player)); // eye cell
    // Edit the world so the outcome is fully determined: clear air in the two cells between, STONE in the third.
    // (setBlock on an unchanged cell returns false and records nothing, so this is a no-op over open ground.)
    const originals = [1, 2, 3].map((d) => world.getBlock(bx, ey, bz + d));
    world.setBlock(bx, ey, bz + 1, BLOCK.AIR);
    world.setBlock(bx, ey, bz + 2, BLOCK.AIR);
    world.setBlock(bx, ey, bz + 3, BLOCK.STONE);
    expect(world.getBlock(bx, ey, bz + 3)).toBe(BLOCK.STONE);

    const h = castFrom(world, player, yaw, 0);
    expect(h).not.toBeNull();
    expect([h.x, h.y, h.z]).toEqual([bx, ey, bz + 3]);
    expect(h.face).toBe(FACE_NZ); // entered through the face that looks back at the eye
    expect([h.nx, h.ny, h.nz]).toEqual([0, 0, -1]);
    // Eye and feet share (x, z), so the ray meets the cell's -Z plane after exactly (bz + 3) - player.z blocks.
    expect(h.distance).toBeCloseTo(bz + 3 - player.z, 12);
    expect(h.distance).toBeLessThanOrEqual(REACH);
    expect(h.blockId).toBe(BLOCK.STONE);
    expect(h.blockId).toBe(world.getBlock(h.x, h.y, h.z));

    // Put the terrain back and re-mesh so the following steps start from a clean, converged world.
    // (The restore is itself recorded as an edit that re-asserts the generated value — harmless.)
    for (let d = 1; d <= 3; d++) world.setBlock(bx, ey, bz + d, originals[d - 1]);
    expect(world.getBlock(bx, ey, bz + 3)).toBe(originals[2]);
    world.update(player.x, player.z, Infinity);
    expectNoOrphans(world, stub);
  });

  it('looking straight up from the eye over open sky finds nothing within REACH', () => {
    // findSpawn picks an open surface column, so nothing should be above the head. Make that unconditional by
    // clearing every cell the ray can enter (a no-op when already AIR) so `null` is asserted, not tolerated.
    const bx = Math.floor(player.x);
    const bz = Math.floor(player.z);
    const ey = Math.floor(player.y + getEyeHeight(player));
    const top = Math.min(WORLD_HEIGHT - 1, ey + Math.ceil(REACH) + 1);
    for (let y = ey + 1; y <= top; y++) world.setBlock(bx, y, bz, BLOCK.AIR);
    expect(isTargetable(world.getBlock(bx, ey, bz))).toBe(false); // the eye itself is in air
    expect(castFrom(world, player, yaw, Math.PI / 2 - 1e-3)).toBeNull();
    world.update(player.x, player.z, Infinity);
  });

  it('break: setBlock AIR records an edit and update() re-meshes the chunk (stub sees a new mesh)', () => {
    brokenId = groundHit.blockId;
    expect(isBreakable(brokenId)).toBe(true);
    const key = chunkKey(Math.floor(groundHit.x / CHUNK_SIZE), Math.floor(groundHit.z / CHUNK_SIZE));
    const before = stub.countFor(key);
    const prevMesh = stub.meshes.get(key);
    const version = world.editVersion;

    expect(world.setBlock(groundHit.x, groundHit.y, groundHit.z, BLOCK.AIR)).toBe(true);
    expect(world.getBlock(groundHit.x, groundHit.y, groundHit.z)).toBe(BLOCK.AIR);
    expect(world.editVersion).toBe(version + 1);
    expect(world.getChunk(...key.split(',').map(Number)).dirty).toBe(true);
    expect(world.isReadyAt(groundHit.x, groundHit.z)).toBe(false);

    // Breaking the same cell again is a no-op (value unchanged).
    expect(world.setBlock(groundHit.x, groundHit.y, groundHit.z, BLOCK.AIR)).toBe(false);
    expect(world.editVersion).toBe(version + 1);

    const r = world.update(player.x, player.z, Infinity);
    expect(r.meshed).toBeGreaterThanOrEqual(1);
    expect(world.isReadyAt(groundHit.x, groundHit.z)).toBe(true);
    expect(stub.countFor(key)).toBe(before + 1);
    expect(stub.meshes.get(key)).not.toBe(prevMesh);
    expectNoOrphans(world, stub);

    // The edit is in the export in main's SaveData shape.
    const edits = world.exportEdits();
    expect(Object.keys(edits)).toContain(key);
    expect(edits[key].length % 2).toBe(0);
    expect(edits[key]).toContain(BLOCK.AIR);
  });

  it('after the break, looking down hits the exposed block one lower', () => {
    const h = castFrom(world, player, yaw, -Math.PI / 2 + 1e-6);
    expect(h).not.toBeNull();
    expect(h.y).toBe(groundHit.y - 1);
    expect(h.face).toBe(2);
    expect(h.distance).toBeCloseTo(EYE_HEIGHT + 1, 2);
    groundHit = h;
  });

  it('place: STONE goes to hit + normal (the hole), is rejected where the player stands, and re-meshes', () => {
    // Placing into the player's own feet cell must be refused (solid block intersecting the AABB).
    const feetHit = { ...groundHit, ny: 1, y: Math.floor(player.y) - 1, face: 2 };
    expect(playerIntersectsBlock(player, feetHit.x, feetHit.y + 1, feetHit.z)).toBe(true);
    expect(tryPlace(world, player, feetHit, BLOCK.STONE)).toBe(false);
    expect(world.getBlock(feetHit.x, feetHit.y + 1, feetHit.z)).toBe(BLOCK.AIR);

    // The real hit (one lower) targets the hole we just made.
    const tx = groundHit.x + groundHit.nx;
    const ty = groundHit.y + groundHit.ny;
    const tz = groundHit.z + groundHit.nz;
    expect(world.getBlock(tx, ty, tz)).toBe(BLOCK.AIR);
    expect(playerIntersectsBlock(player, tx, ty, tz)).toBe(false);
    const key = chunkKey(Math.floor(tx / CHUNK_SIZE), Math.floor(tz / CHUNK_SIZE));
    const before = stub.countFor(key);
    const version = world.editVersion;

    expect(tryPlace(world, player, groundHit, BLOCK.STONE)).toBe(true);
    expect(world.getBlock(tx, ty, tz)).toBe(BLOCK.STONE);
    expect(world.editVersion).toBe(version + 1);
    placed = [tx, ty, tz];

    // Placing on top of an occupied cell is refused.
    expect(tryPlace(world, player, groundHit, BLOCK.STONE)).toBe(false);
    // Water / AIR are never placeable; BEDROCK is not placeable either.
    expect(tryPlace(world, player, groundHit, BLOCK.AIR)).toBe(false);
    expect(tryPlace(world, player, groundHit, BLOCK.WATER)).toBe(false);

    world.update(player.x, player.z, Infinity);
    expect(world.isReadyAt(tx, tz)).toBe(true);
    expect(stub.countFor(key)).toBe(before + 1);
    expectNoOrphans(world, stub);

    // The player still stands (the hole is filled again and physics agrees).
    for (let i = 0; i < 60; i++) stepPlayer(player, IDLE, world.getBlock, TICK);
    expect(player.onGround).toBe(true);
    expect(player.y).toBeGreaterThanOrEqual(Math.floor(spawn[1]));
  });

  it('a block placed at the top of the world is refused by the height-range rule', () => {
    const topHit = { x: placed[0], y: WORLD_HEIGHT - 1, z: placed[2], face: 2, nx: 0, ny: 1, nz: 0, distance: 1, blockId: BLOCK.STONE };
    expect(inHeightRange(topHit.y + topHit.ny)).toBe(false);
    expect(tryPlace(world, player, topHit, BLOCK.STONE)).toBe(false);
  });

  it('walking 20 s toward +X crosses chunk borders; chunks stream in/out with no orphan meshes', () => {
    const walker = createPlayer(player.x, player.y, player.z);
    const startCx = Math.floor(walker.x / CHUNK_SIZE);
    // yawToForward(-π/2) = [1, 0] → +X. Jump held so 1-block steps are climbed.
    const walkYaw = -Math.PI / 2;
    expect(yawToForward(walkYaw)[0]).toBeCloseTo(1, 12);
    const input = { forward: 1, strafe: 0, jump: true, sneak: false, sprint: false, yaw: walkYaw };

    const dataSide = 2 * (RD + DATA_RADIUS_EXTRA) + 1;
    const unloadSide = 2 * (RD + UNLOAD_RADIUS_EXTRA) + 1;
    let generated = 0;
    let unloaded = 0;
    let maxLoaded = 0;
    let borders = 0;
    let lastCx = startCx;
    let physicsSkips = 0;
    const ticks = Math.round(20 / TICK);
    for (let i = 0; i < ticks; i++) {
      if (world.hasChunkAt(walker.x, walker.z)) stepPlayer(walker, input, world.getBlock, TICK);
      else physicsSkips++;
      const r = world.update(walker.x, walker.z, Infinity);
      generated += r.generated;
      unloaded += r.unloaded;
      maxLoaded = Math.max(maxLoaded, world.chunkCount);
      const cx = Math.floor(walker.x / CHUNK_SIZE);
      if (cx !== lastCx) {
        borders++;
        lastCx = cx;
      }
      if (i % 120 === 0) expectNoOrphans(world, stub);
      for (const v of [walker.x, walker.y, walker.z]) expect(Number.isFinite(v)).toBe(true);
    }
    // Streaming always keeps the player's own chunk loaded, so physics never has to be skipped.
    expect(physicsSkips).toBe(0);
    expect(walker.x - player.x).toBeGreaterThan(CHUNK_SIZE);
    expect(borders).toBeGreaterThanOrEqual(1);
    expect(generated).toBeGreaterThan(0);
    expect(unloaded).toBeGreaterThan(0);
    // Data ring ≤ loaded ≤ unload ring (edge chunks linger until they are > rd + 3 away).
    expect(maxLoaded).toBeLessThanOrEqual(unloadSide * unloadSide);
    expect(world.chunkCount).toBeGreaterThanOrEqual(dataSide * dataSide);
    expect(world.chunkCount).toBeLessThanOrEqual(unloadSide * unloadSide);
    expectNoOrphans(world, stub);

    // Every unloaded key the stub saw is really gone, and the stub only holds meshes of loaded chunks.
    for (const key of stub.removeCalls) {
      if (!world.chunks.has(key)) expect(stub.meshes.has(key)).toBe(false);
    }
    // Drain the queue where the walker stopped and check the render ring is complete there.
    converge(world, walker.x, walker.z);
    const wcx = Math.floor(walker.x / CHUNK_SIZE);
    const wcz = Math.floor(walker.z / CHUNK_SIZE);
    for (let dx = -RD; dx <= RD; dx++) {
      for (let dz = -RD; dz <= RD; dz++) {
        expect(world.isReadyAt((wcx + dx) * CHUNK_SIZE, (wcz + dz) * CHUNK_SIZE)).toBe(true);
      }
    }
    expectNoOrphans(world, stub);
    // Walk back so the edited chunk is loaded again for the save test (edits survive unloading regardless).
    converge(world, player.x, player.z);
    expectNoOrphans(world, stub);
  });

  it('edits survive chunk unload/reload (applied right after generateChunk)', () => {
    expect(world.hasChunkAt(placed[0], placed[2])).toBe(true);
    expect(world.getBlock(placed[0], placed[1], placed[2])).toBe(BLOCK.STONE);
    expect(world.getBlock(groundHit.x, groundHit.y + 1, groundHit.z)).toBe(BLOCK.STONE); // same cell as `placed`
    expect(world.getBlock(placed[0], placed[1] + 1, placed[2])).toBe(BLOCK.AIR); // the broken cell above stays AIR
    expect(brokenId).not.toBe(BLOCK.AIR);
  });

  it('save/load roundtrip via serializeSave/deserializeSave preserves the edits, player and clock', () => {
    const data = {
      version: 1,
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
    expect(back.version).toBe(1);
    expect(back.seed).toBe(world.seed);
    expect(back.time).toBeCloseTo(0.4321, 12);
    expect(back.day).toBe(3);
    expect(back.player).toEqual(data.player);
    expect(back.hotbar).toEqual(DEFAULT_HOTBAR.slice());
    expect(back.selected).toBe(4);
    expect(back.edits).toEqual(data.edits);
    // Canonical form is stable.
    expect(serializeSave(back)).toBe(text);

    // A second world built from the save (as `Continue` does) shows the edits once streamed in.
    const world2 = new World({ seed: back.seed, renderDistance: RD, edits: back.edits, now: () => 0 });
    const stub2 = createStubRenderer();
    attach(world2, stub2);
    expect(world2.editVersion).toBe(0); // restoring is not a new edit
    expect(world2.exportEdits()).toEqual(data.edits);
    converge(world2, back.player.x, back.player.z);
    expect(world2.getBlock(placed[0], placed[1], placed[2])).toBe(BLOCK.STONE);
    expect(world2.getBlock(placed[0], placed[1] + 1, placed[2])).toBe(BLOCK.AIR);
    // An unedited cell is identical in both worlds (same seed → same terrain).
    expect(world2.getBlock(placed[0], placed[1] - 2, placed[2])).toBe(world.getBlock(placed[0], placed[1] - 2, placed[2]));
    // Meshes for the restored world exist and are consistent.
    expectNoOrphans(world2, stub2);
    expect(stub2.meshes.size).toBe((2 * RD + 1) ** 2);
    world2.dispose();
    expect(world2.chunkCount).toBe(0);
    expect(stub2.meshes.size).toBe(0); // dispose fired onChunkUnload for every meshed chunk
  });

  it('saveGame/loadGame/hasSave/clearSave work against an injected storage', () => {
    const storage = fakeStorage();
    expect(hasSave(storage)).toBe(false);
    const data = {
      version: 1,
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
