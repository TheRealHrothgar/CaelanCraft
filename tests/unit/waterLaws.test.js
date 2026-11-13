// The laws of water (CONTRACTS §83), on the real rule of src/fluids.js driven through the real scheduler:
//   1. water with nothing under it falls;  2. a pool holds only inside a basin;  3. water never comes from nothing.
// Example cases first, then the laws as INVARIANTS over hundreds of random scenes, then every way a block can change
// (a command, a blast, a seed that fails, a plant that comes up, a save reloaded) and what a spill costs.
// Fake worlds from the fixtures unless a real World matters (reloading a generated pond, the cost on real terrain).
import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, WORLD_HEIGHT, WATER_SURFACE_HEIGHT, WADE_DEPTH, PHYSICS_TICK_S, WATER_SOURCE_NEIGHBOURS } from '../../src/config.js';
import {
  BLOCK, BLOCKS, BLOCK_COUNT, TILE, PICKER_ORDER, UNLOADED, getBlockDef, isWater, isWaterSource, isTaintedWater, isLiquid,
  isFallThrough, isReplaceable, isTargetable, isPlaceable, isSolid, waterLevel, waterDepth, waterAtDepth, waterSurfaceHeight,
  WATER_LOW_SURFACE, WATER_SHALLOW_SURFACE, WATER_LOW_LEVEL, WATER_SHALLOW_LEVEL, WATER_DEPTH_WORDS,
} from '../../src/blocks.js';
import { HEX_DIRS, hexLength, hexToWorld } from '../../src/hex.js';
import { World } from '../../src/world.js';
import { createWorldGen } from '../../src/worldgen.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import {
  BODY_MAX_CELLS, SPILL_STEP_S, SPILL_TICKS, MAX_SPILLS_PER_TICK, WATER_RULE_IDS, isOpenToWater, isWaterFloor, isFlowingWater,
  fallLevel, waterBodyAt, waterSourceOf, waterQualityAt, naturalSeaAt, makeSpringLookup,
} from '../../src/fluids.js';
import { executeCommand, parseLine, resolveBlock } from '../../src/commands.js';
import { createPlayer, stepPlayer, isSwimWater } from '../../src/physics.js';
import { lightOpacity } from '../../src/light.js';
import { buildCellMesh, buildChunkMesh } from '../../src/mesher.js';
import { isEarth } from '../../src/circuitParts.js';
import { isBlastProof } from '../../src/explosions.js';
import { itemForBlock } from '../../src/items.js';
import { ruleFor } from '../../src/harvest.js';
import { buildPickerModel } from '../../src/pickerModel.js';
import { farmSecondOn } from '../../src/main.js';
import { mulberry32 } from '../../src/noise.js';
import { makeFakeWorld, attachPhysics } from '../helpers/fixtures.js';
import { withSprings, settle, rest, ticks, waterCensus, pondCells, putPond } from '../helpers/water.js';

const B = BLOCK;
const flow = (k) => B.WATER_FLOW_1 + k - 1;
const SOURCES = [B.WATER, B.WATER_LOW, B.WATER_SHALLOW, B.TAINTED_WATER, B.TAINTED_WATER_LOW, B.TAINTED_WATER_SHALLOW];
const LOWER = [B.WATER_LOW, B.WATER_SHALLOW, B.TAINTED_WATER_LOW, B.TAINTED_WATER_SHALLOW];

/** A fake world (stone for y ≤ groundY) with physics attached, springs declared first. */
function setup(opts = {}) {
  const world = makeFakeWorld({ groundY: opts.groundY ?? 0 });
  if (opts.springs) withSprings(world, opts.springs);
  const fx = { sounds: [], particles: [], said: [] };
  const physics = attachPhysics(world, BlockPhysics, {
    sound: (name, x, y, z, v) => fx.sounds.push({ name, x, y, z, v }),
    particles: (kind, x, y, z, count) => fx.particles.push({ kind, x, y, z, count }),
    say: (t) => fx.said.push(t),
  });
  return { world, physics, fx };
}

/** A sea on a world whose ground is y ≤ 3: natural WATER where r < 0, natural stone where r ≥ 0, at y 4..top, |q|, |r| ≤ 24. */
function seaWorld(world, top = 4) {
  for (let q = -24; q <= 24; q++) {
    for (let r = -24; r <= 24; r++) for (let y = 4; y <= top; y++) world.put(q, y, r, r < 0 ? B.WATER : B.STONE);
  }
}

/** The ids of the seven pond cells at height y round (q0, r0). */
const pondIds = (world, y, q0 = 0, r0 = 0) => pondCells(q0, r0).map(([q, r]) => world.getBlock(q, y, r));
const all = (id) => Array(7).fill(id);

describe('standing water has three depths: blocks 159–162', () => {
  it('four blocks after the plants: low and shallow, fresh and tainted; BLOCK_COUNT 163 then (173 since §85)', () => {
    expect([B.WATER_LOW, B.WATER_SHALLOW, B.TAINTED_WATER_LOW, B.TAINTED_WATER_SHALLOW]).toEqual([159, 160, 161, 162]);
    expect(BLOCK_COUNT).toBe(173); // §85 appended the ten homestead blocks after them
    expect(B.TAINTED_WATER_SHALLOW).toBe(162);
    expect(BLOCKS).toHaveLength(173);
    expect(LOWER.map((id) => BLOCKS[id].name)).toEqual(['water_low', 'water_shallow', 'tainted_water_low', 'tainted_water_shallow']);
    expect(LOWER.map((id) => BLOCKS[id].displayName)).toEqual(['Low Water', 'Shallow Water', 'Low Tainted Water', 'Shallow Tainted Water']);
  });

  it('they are their full block in every flag and tile, and are never placed by hand: no picker entry, no item, no dig rule', () => {
    for (const [id, full] of [[B.WATER_LOW, B.WATER], [B.WATER_SHALLOW, B.WATER], [B.TAINTED_WATER_LOW, B.TAINTED_WATER], [B.TAINTED_WATER_SHALLOW, B.TAINTED_WATER]]) {
      const a = getBlockDef(id);
      const b = getBlockDef(full);
      for (const key of ['solid', 'opaque', 'liquid', 'breakable', 'cullSame', 'layer', 'soundGroup', 'meshed', 'gravity', 'icon', 'shape']) expect(a[key], `${a.name}.${key}`).toEqual(b[key]);
      expect(a.tiles).toEqual(b.tiles);
      expect(a.tiles.every((t) => t === (isTaintedWater(id) ? TILE.TAINTED_WATER : TILE.WATER))).toBe(true);
      expect(isPlaceable(id)).toBe(false);
      expect(PICKER_ORDER).not.toContain(id);
      expect(itemForBlock(id)).toBeNull();
      expect(ruleFor(id)).toBeNull();
    }
    const picker = buildPickerModel();
    for (const id of LOWER) expect(picker.order).not.toContain(id);
    expect(picker.order).toContain(B.WATER); // (Creative still places full water)
  });

  it('the helpers: sources, tainted, depth 3 / 2 / 1, the block of a quality at a depth', () => {
    expect(SOURCES.map(isWaterSource)).toEqual(Array(6).fill(true));
    expect(SOURCES.map(isWater)).toEqual(Array(6).fill(true));
    expect(SOURCES.map(isTaintedWater)).toEqual([false, false, false, true, true, true]);
    expect(SOURCES.map(waterDepth)).toEqual([3, 2, 1, 3, 2, 1]);
    for (const id of [B.AIR, B.STONE, flow(1), flow(6), B.WATER_FALL, B.ICE, UNLOADED]) {
      expect(isWaterSource(id), String(id)).toBe(false);
      expect(isTaintedWater(id), String(id)).toBe(false);
      expect(waterDepth(id), String(id)).toBe(0);
    }
    expect([3, 2, 1, 0].map((d) => waterAtDepth('fresh', d))).toEqual([B.WATER, B.WATER_LOW, B.WATER_SHALLOW, B.AIR]);
    expect([3, 2, 1, 0].map((d) => waterAtDepth('tainted', d))).toEqual([B.TAINTED_WATER, B.TAINTED_WATER_LOW, B.TAINTED_WATER_SHALLOW, B.AIR]);
    expect([waterAtDepth(true, 2), waterAtDepth(false, 2), waterAtDepth('salt', 1)]).toEqual([B.TAINTED_WATER_LOW, B.WATER_LOW, B.WATER_SHALLOW]);
    expect([waterAtDepth('fresh', 7), waterAtDepth('fresh', -1), waterAtDepth('fresh', 2.9), waterAtDepth('fresh', NaN)]).toEqual([B.WATER, B.AIR, B.WATER_LOW, B.AIR]);
    for (const id of SOURCES) expect(waterAtDepth(isTaintedWater(id), waterDepth(id))).toBe(id); // round trip
    expect(WATER_DEPTH_WORDS).toEqual(['dry', 'shallow', 'low', 'full']);
  });

  it('the table of §83: surface 0.875 / 0.55 / 0.22 and strength E 7 / 5 / 3', () => {
    expect([WATER_SURFACE_HEIGHT, WATER_LOW_SURFACE, WATER_SHALLOW_SURFACE]).toEqual([0.875, 0.55, 0.22]);
    expect([WATER_LOW_LEVEL, WATER_SHALLOW_LEVEL]).toEqual([5, 3]);
    expect(SOURCES.map((id) => waterSurfaceHeight(id, B.AIR))).toEqual([0.875, 0.55, 0.22, 0.875, 0.55, 0.22]);
    expect(SOURCES.map(waterLevel)).toEqual([7, 5, 3, 7, 5, 3]);
    for (const id of SOURCES) {
      expect(waterSurfaceHeight(id, B.WATER)).toBe(1); // under more water the surface is further up
      expect(waterSurfaceHeight(id, flow(1))).toBe(1);
      expect(waterSurfaceHeight(id, B.STONE)).toBe(waterSurfaceHeight(id, B.AIR));
    }
    // falling water carries the strength of the source it pours from
    const column = (...ids) => ({ peek: (_q, y, _r) => ids[y] ?? B.AIR });
    expect([B.WATER, B.WATER_LOW, B.WATER_SHALLOW, B.TAINTED_WATER_LOW].map((id) => fallLevel(column(B.WATER_FALL, B.WATER_FALL, id), 0, 0, 0))).toEqual([7, 5, 3, 5]);
  });

  it('every table that knows the sources knows them: liquid, fall-through, replaceable, never a ray target, light, the rule ids', () => {
    for (const id of LOWER) {
      expect([isLiquid(id), isFallThrough(id), isReplaceable(id), isTargetable(id), isSolid(id)], getBlockDef(id).name).toEqual([true, true, true, false, false]);
      expect(lightOpacity(id)).toBe(lightOpacity(B.WATER));
      expect([isEarth(id), isBlastProof(id)]).toEqual([true, true]); // it conducts like water, and no blast moves it
      expect(WATER_RULE_IDS).toContain(id);
      expect(isWaterFloor(id)).toBe(true); // water spreads over standing water of any depth
      expect(isOpenToWater(id)).toBe(false);
      expect(isFlowingWater(id)).toBe(false);
    }
    expect([B.AIR, B.CAMPFIRE, flow(1), flow(6), B.WATER_FALL].map(isOpenToWater)).toEqual(Array(5).fill(true));
    expect([B.STONE, B.WATER, B.TUSSOCK, B.TORCH, B.GLASS, UNLOADED].map(isOpenToWater)).toEqual(Array(6).fill(false));
  });

  it('the mesher draws their lowered surfaces, with the tile of the full block; no wall between two of a height, a strip above a lower one', () => {
    const topOf = (mesh) => {
      let top = -Infinity;
      for (let k = 1; k < mesh.translucent.positions.length; k += 3) top = Math.max(top, mesh.translucent.positions[k]);
      return top;
    };
    // one cell alone (centred on the origin, y −0.5 … +0.5): the top of the water is its surface height above the bottom
    expect(topOf(buildCellMesh(B.WATER))).toBeCloseTo(-0.5 + WATER_SURFACE_HEIGHT, 5);
    for (const [id, full, h] of [[B.WATER_LOW, B.WATER, 0.55], [B.WATER_SHALLOW, B.WATER, 0.22], [B.TAINTED_WATER_LOW, B.TAINTED_WATER, 0.55], [B.TAINTED_WATER_SHALLOW, B.TAINTED_WATER, 0.22]]) {
      const mesh = buildCellMesh(id);
      expect(mesh.opaque).toBeNull();
      expect(mesh.cutout).toBeNull();
      expect(topOf(mesh), getBlockDef(id).name).toBeCloseTo(-0.5 + h, 5);
      expect(mesh.translucent.indices.length).toBe(buildCellMesh(full).translucent.indices.length); // the same faces …
      expect([...mesh.translucent.uvs].filter((_, i) => i % 2 === 0)).toEqual([...buildCellMesh(full).translucent.uvs].filter((_, i) => i % 2 === 0)); // … cut from the same tile
    }
    const chunkWith = (cells) => {
      const chunk = { blocks: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT), biomes: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE), heights: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE) };
      for (const [lq, y, lr, id] of cells) chunk.blocks[(lq * CHUNK_SIZE + lr) * WORLD_HEIGHT + y] = id;
      return buildChunkMesh(0, 0, (cq, cr) => (cq === 0 && cr === 0 ? chunk : null));
    };
    const pair = (a, b) => chunkWith([[5, 3, 5, a], [6, 3, 5, b]]).translucent.indices.length;
    const level = pair(B.WATER, B.WATER); // two cells of a height: nothing between them
    for (const [a, b] of [[B.WATER_LOW, B.WATER_LOW], [B.WATER_SHALLOW, B.WATER_SHALLOW], [B.WATER_LOW, B.TAINTED_WATER_LOW], [B.TAINTED_WATER_SHALLOW, B.WATER_SHALLOW]]) {
      expect(pair(a, b), `${a} ${b}`).toBe(level);
    }
    // a full cell beside a low one, a low one beside a shallow one: one more face, the strip of the higher surface
    const strip = pair(B.WATER, flow(4)); // (as beside flowing water of a lower level)
    expect(strip).toBeGreaterThan(level);
    for (const [a, b] of [[B.WATER, B.WATER_LOW], [B.WATER_LOW, B.WATER_SHALLOW], [B.TAINTED_WATER, B.WATER_SHALLOW], [B.WATER_SHALLOW, B.WATER]]) {
      expect(pair(a, b), `${a} ${b}`).toBe(strip);
    }
    // under a block a full source stands full height; a low or shallow one keeps its lowered surface (a low cave pool shows it)
    const under = (id) => topOf(chunkWith([[5, 3, 5, id], [5, 4, 5, B.GLASS]]));
    expect(under(B.WATER)).toBe(4);
    expect(under(B.WATER_LOW)).toBeCloseTo(3.55, 5);
    expect(under(B.TAINTED_WATER_SHALLOW)).toBeCloseTo(3.22, 5);
    // under more water every depth is full height: no surface shows inside a pool
    const stacked = chunkWith([[5, 3, 5, B.WATER_SHALLOW], [5, 4, 5, B.WATER_LOW]]);
    expect(topOf(stacked)).toBeCloseTo(4.55, 5);
    expect(stacked.translucent.indices.length).toBeLessThan(2 * buildCellMesh(B.WATER).translucent.indices.length); // no faces between the two
  });

  it('commands know them by name and by id; `water` and `tainted_water` still mean the full blocks', () => {
    expect(resolveBlock('water')).toEqual({ id: B.WATER });
    expect(resolveBlock('tainted_water')).toEqual({ id: B.TAINTED_WATER });
    expect(resolveBlock('water_low')).toEqual({ id: B.WATER_LOW });
    expect(resolveBlock('water_shallow')).toEqual({ id: B.WATER_SHALLOW });
    expect(resolveBlock('tainted_water_low')).toEqual({ id: B.TAINTED_WATER_LOW });
    expect(resolveBlock('tainted_water_shallow')).toEqual({ id: B.TAINTED_WATER_SHALLOW });
    expect(resolveBlock('low water')).toEqual({ id: B.WATER_LOW });
    expect(resolveBlock('162')).toEqual({ id: B.TAINTED_WATER_SHALLOW });
  });

  it('wading and swimming: shallow water is ankle-deep (you walk through it), low water is deep enough to swim, like a flow of its height', () => {
    const cell = (id) => (q, y, r) => (y <= 0 ? B.STONE : q === 0 && r === 0 && y === 1 ? id : B.AIR);
    expect(WATER_SHALLOW_SURFACE).toBeLessThan(WADE_DEPTH);
    expect(WATER_LOW_SURFACE).toBeGreaterThan(WADE_DEPTH);
    expect([B.WATER, B.WATER_LOW, B.WATER_SHALLOW, B.TAINTED_WATER_LOW, B.TAINTED_WATER_SHALLOW].map((id) => isSwimWater(cell(id), 0, 1, 0))).toEqual([true, true, false, true, false]);
    const stand = (id) => {
      const [x, z] = hexToWorld(0, 0);
      const p = createPlayer(x, 1, z);
      for (let i = 0; i < 30; i++) stepPlayer(p, { forward: 0, strafe: 0, yaw: 0, jump: false, sneak: false, sprint: false }, cell(id), 1 / 60);
      return { inWater: p.inWater, headInWater: p.headInWater, onGround: p.onGround, y: Math.round(p.y * 100) / 100 };
    };
    expect(stand(B.WATER_SHALLOW)).toEqual({ inWater: false, headInWater: false, onGround: true, y: 1 });
    expect(stand(B.TAINTED_WATER_SHALLOW)).toEqual({ inWater: false, headInWater: false, onGround: true, y: 1 });
    expect(stand(B.WATER_LOW).inWater).toBe(true);
    expect(stand(B.WATER).inWater).toBe(true);
    // two cells deep, a shallow surface over full water is still deep water
    const deep = (q, y, r) => (y <= 0 ? B.STONE : q === 0 && r === 0 && y === 1 ? B.WATER : q === 0 && r === 0 && y === 2 ? B.WATER_SHALLOW : B.AIR);
    expect(isSwimWater(deep, 0, 2, 0)).toBe(true);
  });
});

describe('law 1: water with nothing under it falls', () => {
  it('a source dropped from a height comes down one cell a tick, lands in the pit below and stays whole', () => {
    const { world, physics, fx } = setup({ groundY: 3 });
    world.put(0, 3, 0, B.AIR); // a pit one cell deep: floor y 2, walls the ground at y 3
    world.setBlock(0, 15, 0, B.WATER);
    for (let n = 1; n <= 12; n++) {
      physics.tick();
      const c = waterCensus(world, 3, 0, 20);
      expect(c.sources, `tick ${n}`).toBe(1); // it MOVES: never two of it, never none
      expect(c.cells.filter(([, , , id]) => id === B.WATER).map(([, y]) => y), `tick ${n}`).toEqual([15 - n]);
    }
    expect(world.getBlock(0, 3, 0)).toBe(B.WATER);
    rest(physics);
    expect(waterCensus(world, 8, 0, 20).cells).toEqual([[0, 3, 0, B.WATER]]); // whole, alone, and no trail of falling water
    expect(physics.fluids.stats.moved).toBe(12);
    expect(world.editCount).toBe(1); // the one cell it ended in
    expect(fx.sounds.filter((s) => s.name === 'splash').length).toBe(1);
  });

  it('every depth and both kinds fall, whoever put them there: a block change, a command, a floor dug away', () => {
    for (const id of SOURCES) {
      const { world, physics } = setup({ groundY: 3 });
      world.put(0, 3, 0, B.AIR);
      world.setBlock(0, 9, 0, id);
      rest(physics);
      expect(waterCensus(world, 8, 0, 12).cells, getBlockDef(id).name).toEqual([[0, 3, 0, id]]);
    }
    // a command writes it in mid-air (the console's setblock)
    const { world, physics } = setup({ groundY: 3 });
    world.put(0, 3, 0, B.AIR);
    const [x, z] = hexToWorld(9, 9);
    const ctx = { world, player: { ...createPlayer(x, 30, z), flying: true }, controls: { yaw: 0, pitch: 0 }, physics, seed: 1 };
    expect(executeCommand(parseLine('setblock 0 12 0 water_low'), ctx).ok).toBe(true);
    for (let i = 0; i < 100; i++) physics.step(PHYSICS_TICK_S); // 5 s of play: the rule woke by itself
    expect(waterCensus(world, 8, 0, 14).cells).toEqual([[0, 3, 0, B.WATER_LOW]]);
    // the floor under a resting source is dug away (a shaft under it, to a second pit)
    world.put(0, 1, 0, B.AIR);
    world.setBlock(0, 2, 0, B.AIR);
    rest(physics);
    expect(waterCensus(world, 8, 0, 14).cells).toEqual([[0, 1, 0, B.WATER_LOW]]);
  });

  it('it rests on a solid block, on a source, and on a block water cannot enter (a plant holds it as it holds sand)', () => {
    const { world, physics } = setup({ groundY: 3 });
    // three one-cell wells (walls two high): over stone, over a full source, over a tussock
    for (const q of [0, 6, 12]) for (const y of [4, 5]) for (const [dq, dr] of HEX_DIRS) world.put(q + dq, y, dr, B.STONE);
    world.put(6, 4, 0, B.WATER);
    world.put(12, 4, 0, B.TUSSOCK);
    world.setBlock(0, 12, 0, B.WATER);
    world.setBlock(6, 12, 0, B.TAINTED_WATER); // onto fresh water: another kind, it rests on top
    world.setBlock(12, 12, 0, B.WATER);
    rest(physics);
    expect(world.getBlock(0, 4, 0)).toBe(B.WATER);
    expect([world.getBlock(6, 4, 0), world.getBlock(6, 5, 0)]).toEqual([B.WATER, B.TAINTED_WATER]);
    expect([world.getBlock(12, 4, 0), world.getBlock(12, 5, 0)]).toEqual([B.TUSSOCK, B.WATER]);
    expect(waterCensus(world, 20, 0, 14).water).toBe(4);
  });

  it('landing on water of its own kind that is not full, it fills that first; what is left rests on top', () => {
    const well = (below, falling) => {
      const { world, physics } = setup({ groundY: 3 });
      for (const y of [4, 5]) for (const [dq, dr] of HEX_DIRS) world.put(dq, y, dr, B.STONE);
      world.put(0, 4, 0, below);
      world.setBlock(0, 10, 0, falling);
      rest(physics);
      return [world.getBlock(0, 4, 0), world.getBlock(0, 5, 0), world.getBlock(0, 6, 0)];
    };
    expect(well(B.WATER_SHALLOW, B.WATER)).toEqual([B.WATER, B.WATER_SHALLOW, B.AIR]); // 1 + 3: two go in, one is left
    expect(well(B.WATER_LOW, B.WATER_SHALLOW)).toEqual([B.WATER, B.AIR, B.AIR]); // 2 + 1: all of it goes in
    expect(well(B.WATER_SHALLOW, B.WATER_SHALLOW)).toEqual([B.WATER_LOW, B.AIR, B.AIR]);
    expect(well(B.WATER, B.WATER_LOW)).toEqual([B.WATER, B.WATER_LOW, B.AIR]); // full already: it rests on top
    expect(well(B.TAINTED_WATER_LOW, B.TAINTED_WATER)).toEqual([B.TAINTED_WATER, B.TAINTED_WATER_LOW, B.AIR]);
    expect(well(B.TAINTED_WATER_SHALLOW, B.WATER)).toEqual([B.TAINTED_WATER_SHALLOW, B.WATER, B.AIR]); // another kind: no mixing
  });

  it('a campfire under a falling source is put out; the source lands in its place', () => {
    const { world, physics, fx } = setup({ groundY: 3 });
    world.put(0, 3, 0, B.AIR);
    world.setBlock(0, 3, 0, B.CAMPFIRE);
    world.setBlock(0, 8, 0, B.WATER);
    rest(physics);
    expect(world.getBlock(0, 3, 0)).toBe(B.WATER);
    expect(fx.sounds.filter((s) => s.name === 'hiss').length).toBe(1);
    expect(fx.particles.filter((p) => p.kind === 'steam').length).toBe(1);
  });

  it('a stack falls together and lands as a stack; at the bottom of the world it rests', () => {
    const { world, physics } = setup({ groundY: 3 });
    world.put(0, 3, 0, B.AIR);
    world.put(0, 2, 0, B.AIR);
    for (const y of [10, 11]) world.setBlock(0, y, 0, B.WATER);
    rest(physics);
    expect(waterCensus(world, 8, 0, 14).cells).toEqual([[0, 2, 0, B.WATER], [0, 3, 0, B.WATER]]);
    const low = setup({ groundY: -1 }); // no ground at all
    low.world.setBlock(0, 4, 0, B.WATER);
    for (let i = 0; i < 6; i++) low.physics.tick();
    expect(low.world.getBlock(0, 0, 0)).toBe(B.WATER); // y 0: it does not leave the world
    ticks(low.physics, 20);
    expect(low.world.getBlock(0, 0, 0)).toBe(B.WATER);
  });

  it('the edit cap never makes two of a falling source, and never loses it', () => {
    const { world, physics } = setup({ groundY: 3 });
    world.put(0, 3, 0, B.AIR);
    world.setBlock(0, 9, 0, B.WATER);
    world.editCount = 300000; // at the cap: every NEW edit is refused
    rest(physics);
    expect(waterCensus(world, 8, 0, 12).cells).toEqual([[0, 3, 0, B.WATER]]); // it still came down: a move is one edit for another
    const b = setup({ groundY: 3 });
    b.world.put(0, 8, 0, B.WATER); // generated water in mid-air: taking it away would be a new edit
    b.world.put(0, 3, 0, B.AIR);
    b.world.editCount = 300000;
    b.physics.scheduleWaterAround(0, 8, 0);
    settle(b.physics);
    expect(waterCensus(b.world, 8, 0, 12).cells).toEqual([[0, 8, 0, B.WATER]]); // held back whole: not doubled, not lost
  });
});

describe('law 2: a pool holds only inside a basin', () => {
  it('constants: a body is at most 128 cells, a spilling body drops a level every 4 s (80 ticks)', () => {
    expect([BODY_MAX_CELLS, SPILL_STEP_S, SPILL_TICKS, MAX_SPILLS_PER_TICK]).toEqual([128, 4, 80, 4]);
    expect(SPILL_TICKS * PHYSICS_TICK_S).toBe(SPILL_STEP_S);
  });

  it('a pond in its basin is at rest: waking every cell of it changes nothing and nothing is left to do', () => {
    for (const id of SOURCES) {
      const { world, physics } = setup({ groundY: 4 });
      putPond(world, 4, id);
      for (const [q, r] of pondCells()) physics.scheduleWaterAround(q, 4, r);
      rest(physics);
      expect(pondIds(world, 4)).toEqual(all(id));
      expect(physics.fluids.stats.writes).toBe(0);
      expect(world.editCount).toBe(0);
      const body = waterBodyAt(world.peekBlock, 0, 4, 0);
      expect({ count: body.count, depth: body.depth, minDepth: body.minDepth, units: body.units, contained: body.contained, sea: body.sea, stream: body.stream, covered: body.covered })
        .toEqual({ count: 7, depth: waterDepth(id), minDepth: waterDepth(id), units: 7 * waterDepth(id), contained: true, sea: false, stream: false, covered: false });
      expect(body.quality).toBe(isTaintedWater(id) ? 'tainted' : 'fresh');
    }
  });

  it('a pond with its bank removed is dry within 3 × SPILL_STEP_S: full, low, shallow, gone — the whole pond a level at a time', () => {
    const { world, physics } = setup({ groundY: 4 });
    putPond(world, 4);
    world.setBlock(2, 4, 0, B.AIR); // one block of the bank, beside the pond cell (1, 4, 0)
    ticks(physics, 20);
    expect(world.getBlock(2, 4, 0)).toBe(flow(6)); // the pond runs out through the breach
    expect(pondIds(world, 4)).toEqual(all(B.WATER));
    expect(physics.fluids.pendingSpills).toBe(1); // the one cell that stands open
    ticks(physics, 70); // 90 ticks: past the first step
    expect(pondIds(world, 4)).toEqual(all(B.WATER_LOW));
    expect(world.getBlock(2, 4, 0)).toBe(flow(4)); // what leaves a low pool is weaker
    ticks(physics, 80);
    expect(pondIds(world, 4)).toEqual(all(B.WATER_SHALLOW));
    expect(world.getBlock(2, 4, 0)).toBe(flow(2));
    ticks(physics, 80); // 250 ticks = 12.5 s
    expect(waterCensus(world, 10, 0, 8).sources).toBe(0); // dry within 3 × SPILL_STEP_S and a few ticks
    const n = rest(physics);
    expect(n).toBeLessThan(40); // (settling: the last of the flow drains)
    expect(pondIds(world, 4)).toEqual(all(B.AIR));
    expect(waterCensus(world, 10, 0, 8).water).toBe(0);
    expect(world.editCount).toBe(8); // the dug bank and the seven dry cells: block edits, saved as they are
    expect(physics.fluids.stats.spilled).toBe(3);
  });

  it('…tainted water drains the same way, and one drop per step however many cells stand open', () => {
    const { world, physics } = setup({ groundY: 4 });
    putPond(world, 4, B.TAINTED_WATER);
    for (const [q, r] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, -2], [-2, 2]]) world.setBlock(q, 4, r, B.AIR); // six breaches at once
    ticks(physics, 90);
    expect(pondIds(world, 4)).toEqual(all(B.TAINTED_WATER_LOW)); // one level, not six
    world.setBlock(1, 4, 1, B.AIR); // a seventh, in mid-step: it does not bring the next drop forward
    ticks(physics, 60); // tick 150
    expect(pondIds(world, 4)).toEqual(all(B.TAINTED_WATER_LOW));
    ticks(physics, 20); // tick 170: the second step
    expect(pondIds(world, 4)).toEqual(all(B.TAINTED_WATER_SHALLOW));
    rest(physics);
    expect(waterCensus(world, 10, 0, 8).water).toBe(0);
    expect(physics.fluids.stats.spilled).toBe(3);
  });

  it('a breach closed again stops the spill where it stands: what ran out is gone, the rest holds', () => {
    const { world, physics } = setup({ groundY: 4 });
    putPond(world, 4);
    world.setBlock(2, 4, 0, B.AIR);
    ticks(physics, 90);
    expect(pondIds(world, 4)).toEqual(all(B.WATER_LOW));
    world.setBlock(2, 4, 0, B.STONE);
    rest(physics);
    ticks(physics, 400);
    expect(pondIds(world, 4)).toEqual(all(B.WATER_LOW));
    expect(physics.fluids.pendingSpills).toBe(0);
    expect(waterCensus(world, 10, 0, 8).water).toBe(7);
  });

  it('a canal with sound banks holds; breach one bank and all of it runs out', () => {
    const { world, physics } = setup({ groundY: 4 });
    const canal = [];
    for (let q = -6; q <= 6; q++) canal.push([q, 4, 0]);
    for (const [q, y, r] of canal) world.put(q, y, r, B.AIR); // a trench one wide in the ground
    for (const [q, y, r] of canal) world.setBlock(q, y, r, B.WATER); // filled in one go (Creative, or a command)
    rest(physics);
    ticks(physics, 400);
    expect(canal.map(([q, y, r]) => world.getBlock(q, y, r))).toEqual(Array(13).fill(B.WATER));
    expect(waterCensus(world, 12, 0, 8).water).toBe(13);
    expect(waterBodyAt(world.peekBlock, -6, 4, 0)).toMatchObject({ count: 13, contained: true, depth: 3 });
    world.setBlock(3, 4, 1, B.AIR); // one block of one bank
    rest(physics);
    expect(waterCensus(world, 14, 0, 8).water).toBe(0);
  });

  it('pouring a source on flat ground leaves nothing: it spreads, weakens and is gone in 12 s', () => {
    const { world, physics } = setup();
    world.setBlock(0, 1, 0, B.WATER);
    ticks(physics, 60);
    let c = waterCensus(world, 12, 0, 4);
    expect([c.sources, c.flow, c.fall]).toEqual([1, 126, 0]); // a reach-6 disc for the first 4 s
    ticks(physics, 60); // 6 s
    c = waterCensus(world, 12, 0, 4);
    expect([world.getBlock(0, 1, 0), c.flow]).toEqual([B.WATER_LOW, 60]); // reach 4
    ticks(physics, 80); // 10 s
    c = waterCensus(world, 12, 0, 4);
    expect([world.getBlock(0, 1, 0), c.flow]).toEqual([B.WATER_SHALLOW, 18]); // reach 2
    const n = rest(physics);
    expect(200 + n).toBeLessThanOrEqual(3 * SPILL_TICKS + 20);
    expect(waterCensus(world, 12, 0, 4).water).toBe(0);
    expect(world.editCount).toBe(0); // not a trace
  });

  it('the walls must be solid or water: a plant, a torch or a campfire beside a pool does not hold it', () => {
    for (const id of [B.TUSSOCK, B.TORCH, B.FIRE_PIT, B.SNARE]) {
      const { world, physics } = setup({ groundY: 4 });
      putPond(world, 4);
      world.setBlock(2, 4, 0, id);
      rest(physics);
      expect(pondIds(world, 4), getBlockDef(id).name).toEqual(all(B.AIR));
      expect(world.getBlock(2, 4, 0)).toBe(id);
    }
    // glass, leaves and ice are walls; so is water of the other kind
    for (const id of [B.GLASS, B.OAK_LEAVES, B.ICE, B.TAINTED_WATER, B.TAINTED_WATER_SHALLOW]) {
      const { world, physics } = setup({ groundY: 4 });
      putPond(world, 4);
      world.setBlock(2, 4, 0, id);
      rest(physics);
      ticks(physics, 300);
      expect(pondIds(world, 4), getBlockDef(id).name).toEqual(all(B.WATER));
    }
  });

  it('a body is ONE LEVEL of a pool: a source set on a pond spills alone, the pond under it holds', () => {
    const { world, physics } = setup({ groundY: 4 });
    putPond(world, 4);
    world.setBlock(0, 9, 0, B.WATER); // falls onto the middle of the pond and rests on it
    ticks(physics, 30);
    expect(world.getBlock(0, 5, 0)).toBe(B.WATER);
    const top = waterBodyAt(world.peekBlock, 0, 5, 0);
    const pond = waterBodyAt(world.peekBlock, 0, 4, 0);
    expect({ count: top.count, contained: top.contained, covered: top.covered }).toEqual({ count: 1, contained: false, covered: false });
    expect({ count: pond.count, contained: pond.contained, covered: pond.covered, cover: pond.cover }).toEqual({ count: 7, contained: true, covered: true, cover: [0, 5, 0] });
    rest(physics);
    expect(pondIds(world, 4)).toEqual(all(B.WATER));
    expect(waterCensus(world, 12, 0, 12).water).toBe(7);
    expect(world.editCount).toBe(0);
  });

  it('a pool two levels deep drains from the top down to the breach: a hole in the upper level leaves the lower one', () => {
    const build = () => {
      const s = setup({ groundY: 5 });
      for (const [q, r] of pondCells()) for (const y of [4, 5]) s.world.put(q, y, r, B.WATER);
      return s;
    };
    const a = build();
    a.world.setBlock(2, 5, 0, B.AIR); // the bank of the upper level
    rest(a.physics);
    expect(pondIds(a.world, 5)).toEqual(all(B.AIR));
    expect(pondIds(a.world, 4)).toEqual(all(B.WATER)); // below the breach: it stays
    expect(a.physics.fluids.stats.spilled).toBe(3);

    const b = build();
    b.world.put(3, 4, 0, B.AIR); // a dry pocket beyond the bank of the LOWER level …
    b.world.setBlock(2, 4, 0, B.AIR); // … and the bank between is dug away
    ticks(b.physics, 90);
    expect([pondIds(b.world, 5), pondIds(b.world, 4)]).toEqual([all(B.WATER_LOW), all(B.WATER)]); // the top goes first
    ticks(b.physics, 160);
    expect([pondIds(b.world, 5), pondIds(b.world, 4)]).toEqual([all(B.AIR), all(B.WATER)]);
    const n = rest(b.physics);
    expect(pondIds(b.world, 4)).toEqual(all(B.AIR)); // then the level with the hole in it
    expect(250 + n).toBeLessThanOrEqual(6 * SPILL_TICKS + 40); // six levels, 4 s each
    expect(waterCensus(b.world, 12, 0, 10).water).toBe(0);
    expect(b.physics.fluids.stats.spilled).toBe(6);
  });

  it('two pools that come to touch level: no two cells more than one depth apart, and not a level of water lost or made', () => {
    const joined = (a, b, nA, nB) => {
      // a trench of nA + 1 + nB cells; the middle one is a wall until a command turns it into water of depth b
      const { world, physics } = setup({ groundY: 4 });
      const cells = [];
      for (let q = 0; q < nA + 1 + nB; q++) cells.push(q);
      for (const q of cells) if (q !== nA) world.put(q, 4, 0, q < nA ? a : b);
      world.setBlock(nA, 4, 0, b);
      rest(physics);
      ticks(physics, 300);
      return cells.map((q) => world.getBlock(q, 4, 0));
    };
    const depths = (ids) => ids.map(waterDepth);
    // full beside shallow is two depths apart: the water is spread evenly, the levels left over staying with the cells
    // that stood deepest (the lower q first)
    expect(depths(joined(B.WATER, B.WATER_SHALLOW, 1, 0))).toEqual([2, 2]); // 3 + 1 = 4 over 2
    expect(depths(joined(B.WATER, B.WATER_SHALLOW, 3, 0))).toEqual([3, 3, 2, 2]); // 9 + 1 = 10 over 4: 2 each and 2 left over
    expect(depths(joined(B.TAINTED_WATER, B.TAINTED_WATER_SHALLOW, 6, 0))).toEqual([3, 3, 3, 3, 3, 2, 2]); // 19 over 7
    expect(joined(B.TAINTED_WATER, B.TAINTED_WATER_SHALLOW, 6, 0).every(isTaintedWater)).toBe(true);
    expect(depths(joined(B.WATER, B.WATER_SHALLOW, 1, 3))).toEqual([2, 2, 1, 1, 1]); // 3 + 4 = 7 over 5: 1 each and 2 left over
    // one depth apart is level enough: nothing moves (so a pool can be topped up a cell at a time)
    expect(depths(joined(B.WATER_LOW, B.WATER_SHALLOW, 1, 1))).toEqual([2, 1, 1]);
    expect(depths(joined(B.WATER, B.WATER_LOW, 2, 2))).toEqual([3, 3, 2, 2, 2]);
    expect(depths(joined(B.WATER, B.WATER, 2, 2))).toEqual([3, 3, 3, 3, 3]);
    // every time, exactly the water that was there
    for (const [a, b, nA, nB] of [[B.WATER, B.WATER_SHALLOW, 5, 4], [B.WATER_LOW, B.WATER_SHALLOW, 3, 2], [B.WATER, B.WATER_SHALLOW, 2, 7]]) {
      const after = depths(joined(a, b, nA, nB));
      expect(after.reduce((s, d) => s + d, 0)).toBe(nA * waterDepth(a) + (nB + 1) * waterDepth(b));
      expect(Math.max(...after) - Math.min(...after)).toBeLessThanOrEqual(1);
    }
    // water of the other kind is a wall, not part of the pool: nothing levels, nothing mixes
    expect(joined(B.WATER, B.TAINTED_WATER_SHALLOW, 3, 0)).toEqual([B.WATER, B.WATER, B.WATER, B.TAINTED_WATER_SHALLOW]);
    // a low pool is filled up by hand a cell at a time (Creative): each full source put in stays, and the pool is full after seven
    const { world, physics } = setup({ groundY: 4 });
    putPond(world, 4, B.WATER_LOW);
    for (const [q, r] of pondCells()) {
      world.setBlock(q, 4, r, B.WATER);
      rest(physics);
    }
    expect(pondIds(world, 4)).toEqual(all(B.WATER));
    expect(physics.fluids.stats.levelled).toBe(0);
  });

  it('a pool left at two depths loses a level from its deeper cells first: it is even again after its first spill step', () => {
    const { world, physics } = setup({ groundY: 4 });
    putPond(world, 4, B.WATER_LOW);
    for (const [q, r] of pondCells().slice(0, 3)) world.put(q, 4, r, B.WATER); // three cells full, four low: level to within one
    world.setBlock(2, 4, 0, B.AIR);
    ticks(physics, 60);
    expect(pondIds(world, 4).map(waterDepth)).toEqual([3, 3, 3, 2, 2, 2, 2]); // nothing levels it: one depth apart is level
    ticks(physics, 30); // the first step: only the full cells come down
    expect(pondIds(world, 4)).toEqual(all(B.WATER_LOW));
    ticks(physics, 80);
    expect(pondIds(world, 4)).toEqual(all(B.WATER_SHALLOW));
    rest(physics);
    expect(waterCensus(world, 10, 0, 8).water).toBe(0);
    expect(physics.fluids.stats.spilled).toBe(3); // as many steps as its deepest cell has depths
    const body = (() => {
      const w = makeFakeWorld({ groundY: 4 });
      putPond(w, 4, B.TAINTED_WATER_SHALLOW);
      w.put(0, 4, 0, B.TAINTED_WATER_LOW);
      return waterBodyAt(w.peekBlock, 0, 4, 0);
    })();
    expect({ depth: body.depth, minDepth: body.minDepth, levels: body.levels, units: body.units }).toEqual({ depth: 2, minDepth: 1, levels: [0, 6, 1, 0], units: 8 });
  });

  it('pools level like joined vessels: a full level over a low one fills it, and the two settle together', () => {
    // two chambers at y 4 joined by a channel, a second level of water over the left one only
    const { world, physics } = setup({ groundY: 5 });
    for (let q = 0; q <= 5; q++) world.put(q, 4, 0, q <= 2 ? B.WATER : B.WATER_SHALLOW); // one body of six cells, uneven
    for (let q = 0; q <= 2; q++) world.put(q, 5, 0, B.WATER); // three full cells standing over the left half
    const before = waterCensus(world, 10, 0, 8).units; // 9 + 3 + 9 = 21
    physics.scheduleWaterAround(2, 4, 0);
    rest(physics);
    const after = waterCensus(world, 10, 0, 8);
    expect(before).toBe(21);
    expect(after.units).toBe(before); // every level of it is still there
    expect(after.flow + after.fall).toBe(0);
    for (let q = 0; q <= 5; q++) expect(world.getBlock(q, 4, 0), `lower ${q}`).toBe(B.WATER); // the lower level filled up from above
    expect(after.units).toBe(18 + waterCensus(world, 10, 5, 5).units);
    for (const [q, y, r, id] of after.cells) if (y === 5) expect([q >= 0 && q <= 2, r, waterDepth(id)]).toEqual([true, 0, 1]); // what is left over it: shallow
  });
});

describe('the sea and running water are fed: outside laws 1 and 2', () => {
  it('the sea is a body of more than 128 cells, and everything under one', () => {
    const { world } = setup({ groundY: 3 });
    seaWorld(world, 6);
    const top = waterBodyAt(world.peekBlock, 0, 6, -10);
    expect({ sea: top.sea, count: top.count, stream: top.stream }).toEqual({ sea: true, count: 128, stream: false }); // the search stops at the cap
    // a pocket of the seabed: 3 cells of water at y 3, below the sea — small, but under the sea
    for (const q of [0, 1, 2]) world.put(q, 3, -10, B.WATER);
    const pocket = waterBodyAt(world.peekBlock, 1, 3, -10);
    expect({ sea: pocket.sea, count: pocket.count, covered: pocket.covered }).toEqual({ sea: true, count: 3, covered: true });
    // exactly 128 cells is a pool, 129 is the sea
    const flat = makeFakeWorld({ groundY: 4 });
    for (let i = 0; i < 129; i++) flat.put(i % 43, 4, Math.floor(i / 43) * 2, B.AIR);
    for (let i = 0; i < 128; i++) flat.put(i, 6, 0, B.WATER);
    for (let i = 0; i < 129; i++) flat.put(i, 8, 0, B.WATER);
    expect(waterBodyAt(flat.peekBlock, 0, 6, 0)).toMatchObject({ count: 128, sea: false });
    expect(waterBodyAt(flat.peekBlock, 0, 8, 0)).toMatchObject({ count: 128, sea: true });
    expect(waterBodyAt(flat.peekBlock, 64, 8, 0).sea).toBe(true); // from any of its cells
  });

  it('the sea never spills dry and never changes depth: a hole dug in the shore fills with flowing water and stays', () => {
    const { world, physics } = setup({ groundY: 3 });
    seaWorld(world);
    world.setBlock(0, 4, 0, B.AIR);
    ticks(physics, 400); // five spill steps
    expect(world.getBlock(0, 4, 0)).toBe(flow(6));
    expect(world.getBlock(0, 4, -1)).toBe(B.WATER);
    expect(physics.fluids.pendingSpills).toBe(0); // looked at once, found to be the sea, forgotten
    expect(physics.fluids.stats.spilled).toBe(0);
    expect(world.editCount).toBe(1);
  });

  it('the sea does not fall: over a hole dug in its bed it pours, as it always did', () => {
    const { world, physics } = setup({ groundY: 3 });
    seaWorld(world, 5);
    for (const y of [1, 2]) world.put(0, y, -10, B.AIR); // a cave under the seabed …
    world.setBlock(0, 3, -10, B.AIR); // … and the bed over it broken through
    rest(physics);
    expect([4, 5].map((y) => world.getBlock(0, y, -10))).toEqual([B.WATER, B.WATER]); // the sea is where it was
    expect([3, 2, 1].map((y) => world.getBlock(0, y, -10))).toEqual([B.WATER_FALL, B.WATER_FALL, B.WATER_FALL]);
    expect(physics.fluids.stats.moved).toBe(0);
  });

  it('a source set on the sea is not the sea: it spills alone (no bump of water is left standing on it)', () => {
    const { world, physics } = setup({ groundY: 3 });
    seaWorld(world);
    world.setBlock(0, 5, -10, B.WATER);
    ticks(physics, 30);
    expect(waterBodyAt(world.peekBlock, 0, 5, -10)).toMatchObject({ count: 1, sea: false, contained: false });
    expect(waterCensus(world, 8, 5, 5, 0, -10).flow).toBeGreaterThan(30); // it runs out over the sea's surface
    rest(physics);
    expect(waterCensus(world, 10, 5, 6, 0, -10).water).toBe(0);
    expect(world.editCount).toBe(0);
  });

  it('a shallower cell that joins the sea is filled up by it', () => {
    const { world, physics } = setup({ groundY: 3 });
    seaWorld(world);
    world.setBlock(0, 4, 0, B.WATER_SHALLOW); // a command turns a block of the shore into shallow water
    rest(physics);
    expect(world.getBlock(0, 4, 0)).toBe(B.WATER);
    for (let q = -3; q <= 3; q++) expect(world.getBlock(q, 4, -1)).toBe(B.WATER);
  });

  it('running water — a fresh source in the cell a stream was generated in — neither falls nor spills', () => {
    // a stream of five cells stepping down, generated: (0..4, y, 0) at y 6, 6, 5, 5, 4 on a hillside
    const springs = [[0, 6, 0], [1, 6, 0], [2, 5, 0], [3, 5, 0], [4, 4, 0]];
    const { world, physics } = setup({ groundY: 3, springs });
    for (let q = -3; q <= 8; q++) for (let r = -3; r <= 3; r++) for (let y = 4; y <= 6; y++) world.put(q, y, r, B.STONE);
    for (const [q, y, r] of springs) {
      for (let yy = y; yy <= 6; yy++) world.put(q, yy, r, B.AIR);
      world.put(q, y, r, B.WATER);
    }
    const body = waterBodyAt(world.peekBlock, 0, 6, 0, physics.fluids.springLevelAt);
    expect({ count: body.count, stream: body.stream, sea: body.sea }).toEqual({ count: 5, stream: true, sea: false }); // one body, whatever the steps
    // every upper cell at a step stands open toward the lower one: the stream runs down it for ever
    for (const [q, y, r] of springs) physics.scheduleWaterAround(q, y, r);
    ticks(physics, 500);
    expect(springs.map(([q, y, r]) => world.getBlock(q, y, r))).toEqual(Array(5).fill(B.WATER));
    expect(physics.fluids.stats.spilled).toBe(0);
    expect(physics.fluids.pendingSpills).toBe(0);
    // a bank dug away: it runs out through it, as it always did, and loses nothing
    world.setBlock(0, 6, 1, B.AIR);
    ticks(physics, 500);
    expect(world.getBlock(0, 6, 1)).toBe(flow(6));
    expect(springs.map(([q, y, r]) => world.getBlock(q, y, r))).toEqual(Array(5).fill(B.WATER));
    // its bed dug away: it pours down the hole, and does not move
    world.setBlock(4, 3, 0, B.AIR);
    world.setBlock(4, 2, 0, B.AIR);
    ticks(physics, 100);
    expect([4, 3, 2].map((y) => world.getBlock(4, y, 0))).toEqual([B.WATER, B.WATER_FALL, B.WATER_FALL]);
    expect(physics.fluids.stats.moved).toBe(0);
  });

  it('…at every depth; a tainted source in a stream\'s cell is not running water, and a pool beside a stream is its own body', () => {
    const { world, physics } = setup({ groundY: 4, springs: [[0, 4, 0], [1, 4, 0]] });
    world.put(0, 4, 0, B.WATER_SHALLOW);
    world.put(1, 4, 0, B.WATER_SHALLOW);
    world.put(2, 4, 0, B.WATER); // standing water beside the stream's end, in the same trench
    world.setBlock(0, 4, 1, B.AIR); // the stream's bank
    ticks(physics, 400);
    expect([0, 1, 2].map((q) => world.getBlock(q, 4, 0))).toEqual([B.WATER_SHALLOW, B.WATER_SHALLOW, B.WATER]); // neither spills nor levels
    expect(waterBodyAt(world.peekBlock, 2, 4, 0, physics.fluids.springLevelAt)).toMatchObject({ count: 1, stream: false, contained: true });
    expect(waterBodyAt(world.peekBlock, 1, 4, 0, physics.fluids.springLevelAt)).toMatchObject({ count: 2, stream: true });
    world.setBlock(1, 4, 0, B.TAINTED_WATER); // someone fouls the stream's cell: that water has no spring behind it
    world.setBlock(1, 4, 1, B.AIR);
    rest(physics);
    expect(isWaterSource(world.getBlock(1, 4, 0))).toBe(false); // it spilled dry through its bank …
    expect(world.getBlock(1, 4, 0)).toBe(flow(2)); // … and the shallow stream beside it runs into the gap
    expect(world.getBlock(0, 4, 0)).toBe(B.WATER_SHALLOW);
    expect(world.getBlock(2, 4, 0)).toBe(flow(1)); // the pool on the other side lost its wall of water: it ran out too
  });

  it('makeSpringLookup: the generator\'s streamLevelAt, a chunk at a time; −1 without streams', () => {
    let asked = 0;
    const gen = { streamLevelAt: (q, r) => (asked++, q === 3 && r === -2 ? 70 : q === 40 && r === 40 ? 65 : -1) };
    const at = makeSpringLookup(() => gen);
    expect([at(3, -2), at(4, -2), at(40, 40), at(-1, -1)]).toEqual([70, -1, 65, -1]);
    const first = asked;
    expect(first).toBe(3 * CHUNK_SIZE * CHUNK_SIZE); // three chunks looked at once each
    for (let i = 0; i < 100; i++) at(3, -2);
    expect(asked).toBe(first);
    at.clear();
    at(3, -2);
    expect(asked).toBe(first + CHUNK_SIZE * CHUNK_SIZE);
    expect(makeSpringLookup(() => ({}))(3, -2)).toBe(-1);
    expect(makeSpringLookup(() => null)(3, -2)).toBe(-1);
  });
});

describe('law 3: water never comes from nothing', () => {
  it('sources beside a flowing cell do not make another: three in a basin of four stay three, and spill', () => {
    expect(WATER_SOURCE_NEIGHBOURS).toBe(3); // (still the sea's rule)
    const { world, physics } = setup({ groundY: 4 });
    // a basin of four cells: the hole (0, 0) and three cells round it
    const ring = [HEX_DIRS[0], HEX_DIRS[2], HEX_DIRS[4]];
    world.put(0, 4, 0, B.AIR);
    for (const [q, r] of ring) world.put(q, 4, r, B.WATER);
    physics.scheduleWaterAround(0, 4, 0);
    let most = 0;
    for (let i = 0; i < 400; i++) {
      physics.tick();
      most = Math.max(most, waterCensus(world, 6, 0, 8).sources);
      if (i === 30) expect(world.getBlock(0, 4, 0)).toBe(flow(6)); // the hole holds flowing water, never a source
    }
    expect(most).toBe(3);
    expect(waterCensus(world, 6, 0, 8).water).toBe(0); // the hole is a breach: they ran out through it
  });

  it('a cell generated as a pond\'s water does not fill again by itself: scooped out, the pond drains through it', () => {
    for (const id of [B.WATER, B.TAINTED_WATER]) {
      const { world, physics } = setup({ groundY: 4 });
      putPond(world, 4, id);
      world.setBlock(0, 4, 0, B.AIR); // the middle cell taken away (Creative), six generated sources round it
      ticks(physics, 30);
      expect(world.getBlock(0, 4, 0)).toBe(flow(6));
      rest(physics);
      expect(pondIds(world, 4)).toEqual(all(B.AIR));
      expect(naturalSeaAt(world, 0, 4, 0)).toEqual({ id, sea: false, truncated: false, unloaded: null });
    }
  });

  it('the sea alone keeps both: a cell generated as sea comes back, and a pocket with sea on three sides becomes sea', () => {
    const { world, physics } = setup({ groundY: 3 });
    seaWorld(world, 6);
    world.setBlock(3, 5, -8, B.AIR);
    world.setBlock(3, 6, -8, B.AIR);
    rest(physics);
    expect([world.getBlock(3, 5, -8), world.getBlock(3, 6, -8)]).toEqual([B.WATER, B.WATER]);
    expect(world.editCount).toBe(0);
    expect(naturalSeaAt(world, 3, 5, -8)).toMatchObject({ id: B.WATER, sea: true });
    // a bay: two shore blocks turned to sea by a command, the block between them dug out (sea on three sides, a floor)
    world.setBlock(5, 4, 0, B.WATER);
    world.setBlock(6, 4, 0, B.AIR);
    rest(physics);
    expect(world.getBlock(6, 4, 0)).toBe(B.WATER);
    // the same pocket beside a POND is no source: three pond cells round a hole
    const p = setup({ groundY: 4 });
    for (const [q, r] of [HEX_DIRS[0], HEX_DIRS[1], HEX_DIRS[2]]) p.world.put(q, 4, r, B.WATER);
    p.world.put(0, 4, 0, B.AIR);
    p.physics.scheduleWaterAround(0, 4, 0);
    ticks(p.physics, 30);
    expect(p.world.getBlock(0, 4, 0)).toBe(flow(6));
  });

  it('flowing water traces back to the source that feeds it; with none it is stale and reads fresh', () => {
    const { world, physics } = setup({ groundY: 3, springs: [[0, 4, 0]] });
    for (let q = -1; q <= 9; q++) for (let r = -1; r <= 1; r++) if (!(r === 0 && q >= 0 && q <= 8)) world.put(q, 4, r, B.STONE);
    world.put(0, 4, 0, B.WATER_LOW); // a spring at low water feeds a channel
    physics.scheduleWaterAround(0, 4, 0);
    settle(physics);
    expect([1, 2, 3, 4, 5].map((q) => world.getBlock(q, 4, 0))).toEqual([flow(4), flow(3), flow(2), flow(1), B.AIR]);
    expect(waterSourceOf(world.peekBlock, 4, 4, 0)).toEqual({ q: 0, y: 4, r: 0, id: B.WATER_LOW, tainted: false });
    expect(waterSourceOf(world.peekBlock, 0, 4, 0)).toEqual({ q: 0, y: 4, r: 0, id: B.WATER_LOW, tainted: false });
    expect(waterSourceOf(world.peekBlock, 5, 4, 0)).toBeNull(); // not water
    world.put(20, 4, 0, flow(3)); // stale flowing water, nothing near it
    expect(waterSourceOf(world.peekBlock, 20, 4, 0)).toBeNull();
    expect(waterQualityAt(world.peekBlock, 20, 4, 0)).toBe('fresh');
  });
});

describe('the laws as invariants: random scenes on the real rule', () => {
  /**
   * Count what the RULE does to the water: every block change is either an edit of the test's (`editing`) or the
   * physics' own. `sources` and `units` (the sum of the depths) are the running balance of the physics' own changes;
   * `worstSources` / `worstUnits` the highest either ever stood. Law 3 says: never above zero, not for one write.
   */
  function monitor(world) {
    const m = { editing: false, sources: 0, units: 0, worstSources: 0, worstUnits: 0, writes: 0 };
    const forward = world.onBlockChange;
    world.onBlockChange = (q, y, r, prev, next) => {
      if (!m.editing) {
        m.sources += (isWaterSource(next) ? 1 : 0) - (isWaterSource(prev) ? 1 : 0);
        m.units += waterDepth(next) - waterDepth(prev);
        if (m.sources > m.worstSources) m.worstSources = m.sources;
        if (m.units > m.worstUnits) m.worstUnits = m.units;
        m.writes++;
      }
      forward(q, y, r, prev, next);
    };
    return m;
  }

  const R = 5; // the arena: columns within 5 cells of the middle
  const TOP = 12;

  /**
   * One random scene: blocky random ground (4..7 high), then random edits — sources of every kind dropped anywhere
   * (in mid-air too), stone put and dug, plants and torches, wells and ponds carved and filled, banks and floors taken
   * away — with random pauses between them. `sea`: a sea along one side. `springs`: a few cells of running water.
   * @returns {{ world: *, physics: *, m: ReturnType<typeof monitor>, springs: number[][], edits: number }}
   */
  function scene(seed, kind) {
    const rnd = mulberry32(seed * 7919 + 13);
    const int = (n) => Math.floor(rnd() * n);
    const world = makeFakeWorld({ groundY: 3 });
    const q0 = 0;
    const r0 = kind === 'sea' ? 4 : 0;
    if (kind === 'sea') seaWorld(world, 6);
    const height = new Map();
    for (let dq = -R - 2; dq <= R + 2; dq++) {
      for (let dr = -R - 2; dr <= R + 2; dr++) {
        if (hexLength(dq, dr) > R + 2) continue;
        const q = q0 + dq;
        const r = r0 + dr;
        if (kind === 'sea' && r < 0) continue; // the sea's own columns
        const h = 4 + int(4);
        height.set(`${q},${r}`, h);
        for (let y = 4; y <= h; y++) world.put(q, y, r, B.STONE);
      }
    }
    const cell = () => {
      for (;;) {
        const dq = int(2 * R + 1) - R;
        const dr = int(2 * R + 1) - R;
        if (hexLength(dq, dr) <= R) return [q0 + dq, r0 + dr];
      }
    };
    /** @type {number[][]} */
    const springs = [];
    if (kind === 'springs') {
      for (let i = 0; i < 3; i++) {
        const [q, r] = cell();
        const h = height.get(`${q},${r}`) ?? 4;
        if (springs.some((s) => s[0] === q && s[2] === r)) continue;
        springs.push([q, h, r]);
        world.put(q, h, r, pickOf(rnd, [B.WATER, B.WATER, B.WATER_LOW, B.WATER_SHALLOW])); // generated in its bed
      }
      withSprings(world, springs);
    }
    const physics = attachPhysics(world, BlockPhysics);
    const m = monitor(world);
    const edit = (q, y, r, id) => {
      m.editing = true;
      world.setBlock(q, y, r, id);
      m.editing = false;
    };
    const n = 18 + int(18);
    for (let i = 0; i < n; i++) {
      const [q, r] = cell();
      const y = 4 + int(TOP - 4);
      const here = world.getBlock(q, y, r);
      const roll = int(100);
      if (roll < 34) {
        if (here === B.AIR || isWater(here)) edit(q, y, r, pickOf(rnd, SOURCES)); // water, anywhere
      } else if (roll < 46) {
        edit(q, y, r, B.STONE);
      } else if (roll < 66) {
        edit(q, 4 + int(5), r, B.AIR); // dig: a bank, a floor, a bit of a pool
      } else if (roll < 74) {
        if (here === B.AIR) edit(q, y, r, pickOf(rnd, [B.TUSSOCK, B.TORCH, B.CAMPFIRE]));
      } else if (roll < 88) {
        // a well: the column cut down to y 4, walls round it two high, then water let in from above
        for (let yy = 5; yy <= TOP; yy++) if (world.getBlock(q, yy, r) !== B.AIR) edit(q, yy, r, B.AIR);
        for (const [dq, dr] of HEX_DIRS) for (const yy of [5, 6]) if (!isSolid(world.getBlock(q + dq, yy, r + dr))) edit(q + dq, yy, r + dr, B.STONE);
        const id = pickOf(rnd, SOURCES);
        edit(q, 5 + int(6), r, id);
        if (int(2) === 0) edit(q, TOP, r, isTaintedWater(id) === (int(3) === 0) ? B.WATER : B.TAINTED_WATER_LOW);
      } else {
        // a pond: seven cells at y 5 in a rim of stone, filled in one go
        for (const [pq, pr] of pondCells(q, r)) {
          for (let yy = 5; yy <= TOP; yy++) if (world.getBlock(pq, yy, pr) !== B.AIR) edit(pq, yy, pr, B.AIR);
          if (!isSolid(world.getBlock(pq, 4, pr))) edit(pq, 4, pr, B.STONE);
        }
        for (let dq = -2; dq <= 2; dq++) {
          for (let dr = -2; dr <= 2; dr++) if (hexLength(dq, dr) === 2 && !isSolid(world.getBlock(q + dq, 5, r + dr))) edit(q + dq, 5, r + dr, B.STONE);
        }
        const id = pickOf(rnd, SOURCES);
        for (const [pq, pr] of pondCells(q, r)) edit(pq, 5, pr, id);
      }
      ticks(physics, pickOf(rnd, [0, 0, 1, 3, 7, 20, 45, 90, 170]));
    }
    return { world, physics, m, springs, edits: n };
  }

  function pickOf(rnd, list) {
    return list[Math.floor(rnd() * list.length)];
  }

  /**
   * Everything the laws promise of a world AT REST, as a list of violations (empty: none).
   * @param {{ world: *, physics: *, springs: number[][] }} s
   * @param {{ sea?: boolean }} [opts]
   */
  function violations(s, opts = {}) {
    const { world, physics } = s;
    const springAt = physics.fluids.springLevelAt;
    const out = [];
    const q0 = 0;
    const r0 = opts.sea ? 4 : 0;
    const flowing = [];
    for (let dq = -R - 9; dq <= R + 9; dq++) {
      for (let dr = -R - 9; dr <= R + 9; dr++) {
        const q = q0 + dq;
        const r = r0 + dr;
        for (let y = 0; y <= TOP + 1; y++) {
          const id = world.getBlock(q, y, r);
          if (!isWater(id)) continue;
          if (!isWaterSource(id)) {
            flowing.push([q, y, r]);
            if (waterSourceOf(world.peekBlock, q, y, r) === null) out.push(`flowing water at ${q},${y},${r} that no source feeds`);
            continue;
          }
          if (opts.sea && r < 0 && id === B.WATER && !world.hasEdit(q, y, r)) continue; // the generated sea, untouched: fed
          const body = waterBodyAt(world.peekBlock, q, y, r, springAt);
          const fed = body.sea || body.stream;
          const below = y > 0 ? world.getBlock(q, y - 1, r) : B.BEDROCK;
          if (isOpenToWater(below) && !fed) out.push(`law 1: the source at ${q},${y},${r} has ${getBlockDef(below).name} under it`);
          if (!body.contained && !fed) out.push(`law 2: the pool of ${q},${y},${r} stands open`);
          if (!fed && body.depth - body.minDepth > 1) out.push(`law 2: the pool of ${q},${y},${r} is not level (${body.minDepth}..${body.depth})`);
          if (!fed && isWaterSource(below) && waterDepth(below) < 3 && isTaintedWater(below) === isTaintedWater(id) && springAt(q, r) !== y - 1) {
            out.push(`the water under ${q},${y},${r} is not full`);
          }
        }
      }
    }
    if (!opts.sea && s.springs.length === 0 && flowing.length > 0) out.push(`${flowing.length} cells of flowing water are left with nothing to feed them`);
    return out;
  }

  it('120 scenes of standing water: at rest nothing hangs, no pool stands open, every pool is level — and nothing flows', () => {
    const bad = [];
    let kept = 0;
    let writes = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const s = scene(seed, 'plain');
      rest(s.physics, 8000);
      for (const v of violations(s)) bad.push(`seed ${seed}: ${v}`);
      kept += waterCensus(s.world, R + 9, 0, TOP + 1).sources;
      writes += s.m.writes;
    }
    expect(bad).toEqual([]);
    expect(kept).toBeGreaterThan(150); // (the scenes do end with pools standing: wells and ponds that were not breached)
    expect(writes).toBeGreaterThan(20000); // … after a great deal of falling, spilling and levelling
  });

  it('…and through all of it the rule never made water: the count of sources and the sum of their depths never rose', () => {
    const bad = [];
    let lost = 0;
    for (let seed = 121; seed <= 240; seed++) {
      const s = scene(seed, seed % 2 === 0 ? 'plain' : 'springs');
      rest(s.physics, 8000);
      if (s.m.worstSources > 0) bad.push(`seed ${seed}: ${s.m.worstSources} more sources than the edits made, at some moment`);
      if (s.m.worstUnits > 0) bad.push(`seed ${seed}: ${s.m.worstUnits} more levels of water than the edits made, at some moment`);
      lost -= s.m.units;
      for (const v of violations(s)) bad.push(`seed ${seed}: ${v}`);
    }
    expect(bad).toEqual([]);
    expect(lost).toBeGreaterThan(1000); // (water was lost all the time: spilled, or rounded away in levelling)
  });

  it('80 scenes with running water: springs keep running through any of it, and all flowing water traces to a source', () => {
    const bad = [];
    let springs = 0;
    let flowing = 0;
    for (let seed = 241; seed <= 320; seed++) {
      const s = scene(seed, 'springs');
      const before = s.springs.map(([q, y, r]) => [q, y, r, s.world.getBlock(q, y, r)]);
      rest(s.physics, 8000);
      for (const v of violations(s)) bad.push(`seed ${seed}: ${v}`);
      for (const [q, y, r, id] of before) {
        // a spring an edit did not touch still holds exactly what it held (the edits may have replaced or removed some)
        if (isWaterSource(id) && s.world.hasEdit(q, y, r) === false && s.world.getBlock(q, y, r) !== id) bad.push(`seed ${seed}: the spring at ${q},${y},${r} changed`);
        if (isWaterSource(s.world.getBlock(q, y, r))) springs++;
      }
      const c = waterCensus(s.world, R + 9, 0, TOP + 1);
      flowing += c.flow + c.fall;
    }
    expect(bad).toEqual([]);
    expect(springs).toBeGreaterThan(100);
    expect(flowing).toBeGreaterThan(1000); // (running water does flow out wherever it can)
  });

  it('24 scenes on a sea shore: the sea is as it was generated wherever no edit touched it, and the laws hold beside it', () => {
    const bad = [];
    for (let seed = 321; seed <= 344; seed++) {
      const s = scene(seed, 'sea');
      rest(s.physics, 8000);
      for (const v of violations(s, { sea: true })) bad.push(`seed ${seed}: ${v}`);
      // the open sea, well away from the arena: untouched
      for (let q = -20; q <= 20; q += 4) for (let y = 4; y <= 6; y++) if (s.world.getBlock(q, y, -12) !== B.WATER) bad.push(`seed ${seed}: the sea at ${q},${y},-12 changed`);
      // no cell of the sea that was generated is left dry or flowing unless an edit holds it
      for (let q = -8; q <= 8; q++) {
        for (let r = -5; r <= -1; r++) {
          for (let y = 4; y <= 6; y++) {
            const id = s.world.getBlock(q, y, r);
            if (id !== B.WATER && !isSolid(id) && !s.world.hasEdit(q, y, r)) bad.push(`seed ${seed}: sea cell ${q},${y},${r} holds ${getBlockDef(id).name}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('every write to the world wakes the laws', () => {
  /** A pond in its basin and a console that writes to its world. */
  function pondScene() {
    const s = setup({ groundY: 4 });
    putPond(s.world, 4);
    const [x, z] = hexToWorld(12, 12);
    const ctx = { world: s.world, player: { ...createPlayer(x, 30, z), flying: true }, controls: { yaw: 0, pitch: 0 }, physics: s.physics, seed: 1 };
    return { ...s, cmd: (line) => executeCommand(parseLine(line), ctx) };
  }
  /** 5 s of play, stepped as the game steps it. */
  const fiveSeconds = (physics) => {
    for (let i = 0; i < 100; i++) physics.step(PHYSICS_TICK_S);
  };

  it('a plain block change (world.setBlock), lazy or not: within 5 s the breached pond has dropped a level', () => {
    for (const lazy of [false, true]) {
      const { world, physics } = pondScene();
      world.setBlock(2, 4, 0, B.AIR, lazy);
      fiveSeconds(physics);
      expect(pondIds(world, 4), `lazy ${lazy}`).toEqual(all(B.WATER_LOW));
      rest(physics);
      expect(waterCensus(world, 10, 0, 8).water).toBe(0);
    }
  });

  it('a command: setblock and fill that open a bank, setblock that hangs water in the air or takes a floor away', () => {
    const a = pondScene();
    expect(a.cmd('setblock 2 4 0 air').ok).toBe(true);
    fiveSeconds(a.physics);
    expect(pondIds(a.world, 4)).toEqual(all(B.WATER_LOW));
    const b = pondScene();
    const fill = b.cmd('fill -3 4 -2 3 4 -2 air'); // a row of the ground along the pond's edge, by an area command
    expect(fill.ok).toBe(true);
    expect(fill.job.step(1000)).toBe(7); // (the job the game runs a few cells a frame)
    for (let i = 0; i < 400; i++) b.physics.step(PHYSICS_TICK_S);
    expect(waterCensus(b.world, 10, 0, 8).sources).toBe(0);
    const c = pondScene();
    expect(c.cmd('setblock 5 9 5 tainted_water').ok).toBe(true); // in mid-air, over open ground
    fiveSeconds(c.physics);
    expect(c.world.getBlock(5, 9, 5)).toBe(B.AIR);
    expect(c.world.getBlock(5, 5, 5)).toBe(B.TAINTED_WATER_LOW); // it came down, and stands open there: one level gone already
    expect(pondIds(c.world, 4)).toEqual(all(B.WATER)); // the pond is no business of it
    const d = pondScene();
    d.world.put(0, 2, 0, B.AIR); // a cave under the pond's bed
    expect(d.cmd('setblock 0 3 0 air').ok).toBe(true); // the bed under the middle cell
    fiveSeconds(d.physics);
    expect(d.world.getBlock(0, 2, 0)).toBe(B.WATER); // the middle of the pond fell through
    expect(pondCells().slice(1).map(([q, r]) => d.world.getBlock(q, 4, r))).toEqual(Array(6).fill(B.WATER_LOW)); // and the rest runs after it
  });

  it('a blast: a keg that takes out a pond\'s bank drains the pond (water itself is blast-proof)', () => {
    const { world, physics } = pondScene();
    world.setBlock(4, 5, 0, B.BLAST_BARREL); // on the ground, two cells from the pond's edge
    expect(physics.explosions.lightAt(4, 5, 0)).toBe(true);
    const before = physics.explosions.blastCount;
    for (let i = 0; i < 600 && physics.explosions.blastCount === before; i++) physics.step(1 / 60);
    expect(physics.explosions.blastCount).toBe(before + 1);
    expect(pondIds(world, 4).every((id) => isWaterSource(id))).toBe(true); // every cell of it survived the blast
    expect(isSolid(world.getBlock(2, 4, 0))).toBe(false); // its bank did not
    for (let i = 0; i < 1200; i++) physics.step(1 / 60); // 20 s
    expect(waterCensus(world, 12, 0, 8).sources).toBe(0);
  });

  it('growth: a seed that fails under a source (main.farmSecondOn\'s write) lets it fall', () => {
    const { world, physics } = setup({ groundY: 3 });
    for (const y of [4, 5]) for (const [dq, dr] of HEX_DIRS) world.put(dq, y, dr, B.STONE); // a well two deep
    world.setBlock(0, 4, 0, B.PLANTED_CARROT);
    world.setBlock(0, 5, 0, B.WATER); // it rests on the planted seed
    rest(physics);
    expect([world.getBlock(0, 4, 0), world.getBlock(0, 5, 0)]).toEqual([B.PLANTED_CARROT, B.WATER]);
    const growth = { step: () => [{ q: 0, y: 4, r: 0, from: B.PLANTED_CARROT, to: B.AIR, took: false, crop: {} }] };
    const done = farmSecondOn(1, () => 0.999, { world, growth: /** @type {*} */ (growth), spread: /** @type {*} */ ({ step: () => null }), isLoadedCell: () => true, waterQuality: null, q: 0, r: 0 });
    expect(done.failed).toBe(1);
    expect(physics.queued()).toBeGreaterThan(0);
    fiveSeconds(physics);
    expect([world.getBlock(0, 4, 0), world.getBlock(0, 5, 0)]).toEqual([B.WATER, B.AIR]);
  });

  it('spread: a plant that comes up beside water (main.farmSecondOn\'s write) wakes the rule, and a sound pond stays sound', () => {
    const { world, physics } = pondScene();
    const spread = { step: () => ({ q: 2, y: 5, r: 0, id: B.CATTAILS, seeded: false, parent: null }) }; // on the rim, over the bank
    const done = farmSecondOn(1, () => 0.999, { world, growth: /** @type {*} */ ({ step: () => [] }), spread: /** @type {*} */ (spread), isLoadedCell: () => true, waterQuality: null, q: 0, r: 0 });
    expect(done.births).toBe(1);
    expect(world.getBlock(2, 5, 0)).toBe(B.CATTAILS);
    const updates = physics.fluids.stats.updates;
    fiveSeconds(physics);
    rest(physics);
    expect(pondIds(world, 4)).toEqual(all(B.WATER));
    // and one that comes up IN a dry gap of the bank does not close it: the pond drains past it
    world.setBlock(-2, 4, 0, B.AIR);
    ticks(physics, 3);
    const gap = { step: () => ({ q: -2, y: 4, r: 1, id: B.TUSSOCK, seeded: false, parent: null }) };
    world.setBlock(-2, 4, 1, B.AIR);
    farmSecondOn(1, () => 0.999, { world, growth: /** @type {*} */ ({ step: () => [] }), spread: /** @type {*} */ (gap), isLoadedCell: () => true, waterQuality: null, q: 0, r: 0 });
    expect(physics.fluids.stats.updates).toBeGreaterThanOrEqual(updates);
    rest(physics);
    expect(waterCensus(world, 10, 0, 8).sources).toBe(0);
  });

  it('with the water switch off nothing falls or spills; on again, the next change beside it wakes it', () => {
    const { world, physics } = pondScene();
    physics.setSwitch('water', false);
    world.setBlock(2, 4, 0, B.AIR);
    world.setBlock(6, 9, 6, B.WATER);
    for (let i = 0; i < 400; i++) physics.step(PHYSICS_TICK_S);
    expect(pondIds(world, 4)).toEqual(all(B.WATER));
    expect(world.getBlock(6, 9, 6)).toBe(B.WATER);
    physics.setSwitch('water', true);
    for (let i = 0; i < 400; i++) physics.step(PHYSICS_TICK_S);
    expect(pondIds(world, 4)).toEqual(all(B.WATER)); // (switching on floods nothing after the fact, as before)
    world.setBlock(2, 4, 0, B.STONE); // a change in the open cell beside the pond
    world.setBlock(2, 4, 0, B.AIR);
    world.setBlock(6, 8, 6, B.STONE); // and under the hanging source
    world.setBlock(6, 8, 6, B.AIR);
    rest(physics);
    expect(waterCensus(world, 12, 0, 12).sources).toBe(0);
    // paused physics holds everything still, and carries on when resumed
    const p = pondScene();
    p.physics.setPaused(true);
    p.world.setBlock(2, 4, 0, B.AIR);
    for (let i = 0; i < 400; i++) p.physics.step(PHYSICS_TICK_S);
    expect(pondIds(p.world, 4)).toEqual(all(B.WATER));
    p.physics.setPaused(false);
    for (let i = 0; i < 400; i++) p.physics.step(PHYSICS_TICK_S);
    expect(waterCensus(p.world, 12, 0, 12).sources).toBe(0);
  });
});

describe('saving and loading: a pool is the blocks it is made of', () => {
  /** A fresh fake world with the same generated pond, the saved edits put back, then its chunks "generated". */
  function reload(saved, opts = {}) {
    const world = makeFakeWorld({ groundY: 4 });
    putPond(world, 4, opts.id ?? B.WATER);
    if (opts.springs) withSprings(world, opts.springs);
    if (opts.terrain) opts.terrain(world);
    for (const [key, arr] of Object.entries(saved)) {
      const [cq, cr] = key.split(',').map(Number);
      for (let i = 0; i < arr.length; i += 2) {
        const li = arr[i];
        const y = li % WORLD_HEIGHT;
        const col = (li - y) / WORLD_HEIGHT;
        const lr = col % CHUNK_SIZE;
        world.setBlock(cq * CHUNK_SIZE + (col - lr) / CHUNK_SIZE, y, cr * CHUNK_SIZE + lr, arr[i + 1]);
      }
    }
    const physics = attachPhysics(world, BlockPhysics);
    for (const cq of [-2, -1, 0, 1]) for (const cr of [-2, -1, 0, 1]) world.load(cq, cr);
    return { world, physics };
  }
  const savedIds = (saved) => Object.values(saved).flatMap((arr) => arr.filter((_, i) => i % 2 === 1)).sort((a, b) => a - b);

  it('a low, a shallow and a dry pool are still that after a reload: nothing fills them, nothing floods, nothing dries', () => {
    for (const [from, to] of [[B.WATER, B.WATER_LOW], [B.WATER, B.WATER_SHALLOW], [B.WATER, B.AIR], [B.TAINTED_WATER, B.TAINTED_WATER_LOW], [B.TAINTED_WATER, B.TAINTED_WATER_SHALLOW], [B.TAINTED_WATER, B.AIR]]) {
      const live = setup({ groundY: 4 });
      putPond(live.world, 4, from);
      for (const [q, r] of pondCells()) live.world.setBlock(q, 4, r, to, true); // what drinking, the sun or a spill writes
      rest(live.physics);
      const saved = JSON.parse(JSON.stringify(live.physics.exportEdits()));
      expect(savedIds(saved)).toEqual(all(to)); // seven block edits, saved as they are
      const re = reload(saved, { id: from });
      const n = rest(re.physics);
      expect(pondIds(re.world, 4), `${getBlockDef(from).name} → ${getBlockDef(to).name}`).toEqual(all(to));
      expect(re.physics.fluids.stats.writes).toBe(0);
      expect(waterCensus(re.world, 10, 0, 8).water).toBe(to === B.AIR ? 0 : 7);
      expect(n).toBeLessThan(20);
      ticks(re.physics, 400);
      expect(pondIds(re.world, 4)).toEqual(all(to));
      expect(re.world.editCount).toBe(7);
    }
  });

  it('a pond saved while it spills goes on spilling after the reload; the flow in the breach is not saved', () => {
    const live = setup({ groundY: 4 });
    putPond(live.world, 4);
    live.world.setBlock(2, 4, 0, B.AIR);
    ticks(live.physics, 100);
    expect(pondIds(live.world, 4)).toEqual(all(B.WATER_LOW));
    const saved = JSON.parse(JSON.stringify(live.physics.exportEdits()));
    expect(savedIds(saved)).toEqual([B.AIR, ...all(B.WATER_LOW)]);
    expect(live.world.getBlock(2, 4, 0)).toBe(flow(4)); // the live world is untouched by saving
    const re = reload(saved);
    expect(re.world.getBlock(2, 4, 0)).toBe(B.AIR);
    ticks(re.physics, 20);
    expect(re.world.getBlock(2, 4, 0)).toBe(flow(4)); // the edited AIR beside water woke up
    const n = rest(re.physics);
    expect(waterCensus(re.world, 10, 0, 8).water).toBe(0);
    expect(20 + n).toBeLessThanOrEqual(2 * SPILL_TICKS + 40); // two levels were left
  });

  it('a source saved in mid-fall comes down after the reload', () => {
    const live = setup({ groundY: 4 });
    putPond(live.world, 4);
    live.world.put(8, 4, 8, B.AIR); // a pit
    live.world.setBlock(8, 30, 8, B.TAINTED_WATER_LOW);
    ticks(live.physics, 10);
    expect(live.world.getBlock(8, 20, 8)).toBe(B.TAINTED_WATER_LOW);
    const re = reload(JSON.parse(JSON.stringify(live.physics.exportEdits())), { terrain: (w) => w.put(8, 4, 8, B.AIR) });
    expect(re.world.getBlock(8, 20, 8)).toBe(B.TAINTED_WATER_LOW);
    rest(re.physics);
    expect(waterCensus(re.world, 4, 0, 40, 8, 8).cells).toEqual([[8, 4, 8, B.TAINTED_WATER_LOW]]);
  });

  it('flowing water standing in a dry pond\'s bed is saved as AIR — a reload must not bring the pond back — but in the sea it is dropped', () => {
    // a dry generated pond, a spring one block away, and the bank between them dug out: the stream runs into the bed
    const spring = [[3, 4, 0]];
    const terrain = (w) => w.put(3, 4, 0, B.WATER);
    const live = setup({ groundY: 4, springs: spring });
    putPond(live.world, 4);
    terrain(live.world);
    for (const [q, r] of pondCells()) live.world.setBlock(q, 4, r, B.AIR, true); // dried out
    live.world.setBlock(2, 4, 0, B.AIR);
    settle(live.physics);
    expect(live.world.getBlock(1, 4, 0)).toBe(flow(5));
    expect(pondIds(live.world, 4).filter((id) => isFlowingWater(id)).length).toBeGreaterThanOrEqual(4);
    const saved = JSON.parse(JSON.stringify(live.physics.exportEdits()));
    expect(savedIds(saved)).toEqual(Array(8).fill(B.AIR)); // the dug bank and all seven cells of the bed, as AIR: none left out to reload as water
    const re = reload(saved, { springs: spring, terrain });
    settle(re.physics);
    expect(pondIds(re.world, 4).some((id) => isWaterSource(id))).toBe(false);
    expect(re.world.getBlock(1, 4, 0)).toBe(flow(5)); // the same flow, from the same spring
    // the sea: a hole at its edge holds flowing water over a cell generated as sea — dropped, so it reloads as sea
    const sea = setup({ groundY: 3 });
    seaWorld(sea.world, 5);
    sea.world.put(3, 5, -2, B.STONE);
    sea.world.put(4, 5, -1, B.STONE);
    sea.physics.setSwitch('water', false);
    sea.world.setBlock(3, 5, -1, flow(4)); // (written with the rule off, so that it stands as flowing water in the save)
    expect(sea.world.originAt(3, 5, -1)).toBe(B.WATER);
    sea.physics.switches.water = true;
    expect(sea.physics.exportEdits()).toEqual({});
  });

  it('a real generated pond (generation 3): lowered, saved and loaded into a new World it is as it was left', () => {
    const SEED = 20260507;
    const gen = createWorldGen(SEED, { gen: 3 });
    let pond = null;
    for (let q = -60; q <= 60 && !pond; q++) {
      for (let r = -60; r <= 60 && !pond; r++) {
        if (!gen.pondAt(q, r) || !HEX_DIRS.every(([dq, dr]) => gen.pondAt(q + dq, r + dr))) continue; // a middle cell: all six round it are pond
        if (gen.getColumn(q, r).biome === 5) continue; // (a frozen pond is ice)
        pond = [q, gen.getColumn(q, r).height, r];
      }
    }
    expect(pond, 'a liquid pond near the origin').not.toBeNull();
    const [pq, py, pr] = pond;
    const open = (edits) => {
      const world = new World({ seed: SEED, gen: 3, renderDistance: 2, worldGen: createWorldGen(SEED, { gen: 3 }), now: () => 0, edits });
      const physics = attachPhysics(world, BlockPhysics);
      const [x, z] = hexToWorld(pq, pr);
      for (let i = 0; i < 2000; i++) {
        const u = world.update(x, z, Infinity);
        if (u.pendingGen === 0 && u.pendingMesh === 0) break;
      }
      return { world, physics };
    };
    const live = open(undefined);
    const full = live.world.getBlock(pq, py, pr);
    expect(isWaterSource(full) && waterDepth(full) === 3).toBe(true);
    const body = waterBodyAt((q, y, r) => live.world.peekBlock(q, y, r), pq, py, pr, live.physics.fluids.springLevelAt);
    expect(body).toMatchObject({ count: 7, contained: true, sea: false, stream: false, depth: 3 });
    expect(live.world.getBlock(pq, py - 1, pr)).toBe(B.CLAY);
    const shallow = waterAtDepth(body.tainted, 1);
    for (let i = 0; i < body.cells.length; i += 3) live.world.setBlock(body.cells[i], body.cells[i + 1], body.cells[i + 2], shallow, true);
    rest(live.physics);
    const re = open(JSON.parse(JSON.stringify(live.physics.exportEdits())));
    rest(re.physics);
    for (let i = 0; i < body.cells.length; i += 3) expect(re.world.getBlock(body.cells[i], body.cells[i + 1], body.cells[i + 2])).toBe(shallow);
    expect(re.physics.fluids.stats.writes).toBe(0);
    expect(re.world.editCount).toBe(7);
    // dried right out, and reloaded: the bed stays dry (it was generated as water; nothing fills it but the rain)
    for (let i = 0; i < body.cells.length; i += 3) re.world.setBlock(body.cells[i], body.cells[i + 1], body.cells[i + 2], B.AIR, true);
    rest(re.physics);
    const dry = open(JSON.parse(JSON.stringify(re.physics.exportEdits())));
    rest(dry.physics);
    ticks(dry.physics, 200);
    for (let i = 0; i < body.cells.length; i += 3) expect(dry.world.getBlock(body.cells[i], body.cells[i + 1], body.cells[i + 2])).toBe(B.AIR);
    expect(dry.physics.fluids.stats.writes).toBe(0);
  });
});

describe('what a spill costs', () => {
  /** A real World loaded round column (q, r), physics forwarded like main. */
  function realWorld(worldGen, q, r, renderDistance) {
    const world = new World({ seed: worldGen.seed, gen: worldGen.gen, renderDistance, worldGen, now: () => 0 });
    const physics = attachPhysics(world, BlockPhysics);
    const [x, z] = hexToWorld(q, r);
    for (let i = 0; i < 4000; i++) {
      const u = world.update(x, z, Infinity);
      if (u.pendingGen === 0 && u.pendingMesh === 0) break;
    }
    return { world, physics };
  }
  /** Run a breached pool dry; the time of each tick in which its body dropped a level (ms). */
  function spillTicks(physics) {
    const out = [];
    for (let i = 0; i < 3 * SPILL_TICKS + 30; i++) {
      const before = physics.fluids.stats.spilled;
      const t0 = performance.now();
      physics.tick();
      const dt = performance.now() - t0;
      if (physics.fluids.stats.spilled > before) out.push(dt);
    }
    return out;
  }

  it('on a real generated world a pond\'s spill step — the whole pond dropping a level — stays well under a millisecond', () => {
    const SEED = 20260507;
    const gen = createWorldGen(SEED, { gen: 3 });
    const ponds = [];
    for (let q = -150; q <= 150 && ponds.length < 5; q++) {
      for (let r = -150; r <= 150 && ponds.length < 5; r++) {
        if (!gen.pondAt(q, r) || !HEX_DIRS.every(([dq, dr]) => gen.pondAt(q + dq, r + dr)) || gen.getColumn(q, r).biome === 5) continue;
        if (ponds.every(([a, , b]) => hexLength(a - q, b - r) > 40)) ponds.push([q, gen.getColumn(q, r).height, r]);
      }
    }
    expect(ponds.length).toBe(5);
    const steps = [];
    for (const [q, y, r] of ponds) {
      const { world, physics } = realWorld(createWorldGen(SEED, { gen: 3 }), q, r, 2);
      const body = waterBodyAt((a, b, c) => world.peekBlock(a, b, c), q, y, r, physics.fluids.springLevelAt);
      expect(body).toMatchObject({ count: 7, contained: true });
      world.setBlock(q + 2, y, r, B.AIR); // a block of its bank
      const times = spillTicks(physics);
      expect(times.length).toBe(3);
      expect(waterBodyAt((a, b, c) => world.peekBlock(a, b, c), q, y, r)).toBeNull(); // dry
      steps.push(...times);
    }
    steps.sort((a, b) => a - b);
    expect(steps[Math.floor(steps.length / 2)]).toBeLessThan(0.5); // the median of 15 steps (about 0.05 ms on a quiet machine)
    expect(steps[0]).toBeLessThan(0.25);
  });

  it('the largest pool there can be, 128 cells, drops a level within one tick\'s budget (about 1 ms)', () => {
    // a generated trench of 128 cells of water in flat stone
    const gen = {
      seed: 1,
      getColumn: () => ({ height: 4, biome: 2, temperature: 0, humidity: 0 }),
      generateChunk: (cq, cr) => {
        const d = { blocks: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT), biomes: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE).fill(2), heights: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE).fill(4) };
        for (let lq = 0; lq < CHUNK_SIZE; lq++) {
          for (let lr = 0; lr < CHUNK_SIZE; lr++) {
            const base = (lq * CHUNK_SIZE + lr) * WORLD_HEIGHT;
            d.blocks.fill(B.STONE, base, base + 5);
            const q = cq * CHUNK_SIZE + lq;
            if (cr * CHUNK_SIZE + lr === 0 && q >= 0 && q < 128) d.blocks[base + 4] = B.WATER;
          }
        }
        return d;
      },
    };
    let best = Infinity;
    for (let run = 0; run < 4; run++) {
      const { world, physics } = realWorld(gen, 64, 0, 5);
      expect(waterBodyAt((a, b, c) => world.peekBlock(a, b, c), 0, 4, 0)).toMatchObject({ count: 128, sea: false, contained: true });
      world.setBlock(-1, 4, 0, B.AIR);
      const times = spillTicks(physics);
      expect(times.length).toBe(3);
      expect(waterCensus(world, 70, 4, 4, 64, 0).sources).toBe(0);
      best = Math.min(best, ...times);
    }
    expect(best).toBeLessThan(3); // PHYSICS_TICK_BUDGET_MS
  });
});
