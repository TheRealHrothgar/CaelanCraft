// Unit tests for Tainted Water (CONTRACTS §76 water): the second water source (blocks, tile, fluid rule, saves), telling
// what the water in a cell is (fluids.waterQualityAt: flowing water traced back to its sources), drinking it by hand and
// from a pot (vitals, survival, the R action and its hint), boiling it, and fresh water that spoils in the pot.
// Streams and tainted ponds as generated are in streams.test.js.
import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, WORLD_HEIGHT, DAY_LENGTH_SECONDS, STAT_MAX, WATER_LIGHT_OPACITY } from '../../src/config.js';
import { chunkKey, localIndex } from '../../src/coords.js';
import {
  BLOCK, BLOCKS, BLOCK_COUNT, TILE, LAYER_TRANSLUCENT, PICKER_ORDER, getBlockDef, isWater, isWaterSource, waterLevel, isFallThrough,
  isLiquid, isSolid, isOpaque, isBreakable, isPlaceable, isReplaceable, isTargetable, waterSurfaceHeight, shouldRenderFace,
} from '../../src/blocks.js';
import { HEX_DIRS, hexLength } from '../../src/hex.js';
import { mulberry32 } from '../../src/noise.js';
import { paintTile, averageColor, TILE_NAMES } from '../../src/tiles.js';
import { lightOpacity } from '../../src/light.js';
import { isEarth } from '../../src/circuitParts.js';
import { isBlastProof } from '../../src/explosions.js';
import { ruleFor } from '../../src/harvest.js';
import { resolveBlock } from '../../src/commands.js';
import { buildCellMesh, buildChunkMesh } from '../../src/mesher.js';
import { BlockPhysics, SaveOverlay } from '../../src/blockphysics.js';
import { WATER_RULE_IDS, QUALITY_TRACE_MAX, isWaterFloor, fallLevel, waterQualityAt } from '../../src/fluids.js';
import { RATES, createVitals, gulpWater, eatFood } from '../../src/vitals.js';
import { Survival, SICK_MESSAGE, SALT_MESSAGE } from '../../src/survival.js';
import { ITEMS, ITEM_KEYS, POT_WATER_SPOIL_S, getItem, itemForBlock, resolveItem } from '../../src/items.js';
import { ITEM_ART_KEYS, hasItemArt } from '../../src/itemArt.js';
import { Pack, spoilSlots } from '../../src/inventory.js';
import { Containers } from '../../src/containers.js';
import { FIRE_TRANSFORMS, CENTRE_POTS, EMBERS_SPOT, FireSlots, isCentrePot, spotAccepts } from '../../src/cooking.js';
import { SPOT_ITEMS } from '../../src/campfireRenderer.js';
import { interactKind, useActionOf, waterHint, waterKind, WATER_POTS } from '../../src/survivalControl.js';
import { serializeSave, deserializeSave, SAVE_VERSION } from '../../src/storage.js';
import { spoiledText } from '../../src/main.js';
import { makeFakeWorld, attachPhysics } from '../helpers/fixtures.js';

const B = BLOCK;
const T = B.TAINTED_WATER;
const flow = (k) => B.WATER_FLOW_1 + k - 1;

/** A fake world (stone for y ≤ groundY) with block physics attached. */
function setup(groundY = 0) {
  const world = makeFakeWorld({ groundY });
  const physics = attachPhysics(world, BlockPhysics);
  return { world, physics };
}

/** Tick until nothing is queued. */
function settle(physics, max = 20000) {
  let t = 0;
  while (physics.queued() > 0 && t < max) {
    physics.tick();
    t++;
  }
  if (physics.queued() > 0) throw new Error(`water did not settle within ${max} ticks`);
}

/** Every water cell within hex distance R of (0, 0), y0..y1, as [q, y, r, id]. */
function waterCells(world, R, y0, y1) {
  const out = [];
  for (let q = -R; q <= R; q++) {
    for (let r = -R; r <= R; r++) {
      if (hexLength(q, r) > R) continue;
      for (let y = y0; y <= y1; y++) {
        const id = world.getBlock(q, y, r);
        if (isWater(id)) out.push([q, y, r, id]);
      }
    }
  }
  return out;
}

/** A natural stone slab at y over the hex disc of radius `rad` (a basin's rim / floor for the tests below). */
function slab(world, rad, y, id = B.STONE) {
  for (let q = -rad; q <= rad; q++) for (let r = -rad; r <= rad; r++) if (hexLength(q, r) <= rad) world.put(q, y, r, id);
}

describe('the Tainted Water block (§76)', () => {
  it('is block 120, appended last, with water\'s flags and its own tile; never placed by hand, no item', () => {
    expect(T).toBe(120);
    expect(BLOCK_COUNT).toBe(121);
    expect(BLOCKS[T]).toBe(BLOCKS[BLOCKS.length - 1]);
    const d = getBlockDef(T);
    const w = getBlockDef(B.WATER);
    expect([d.id, d.name, d.displayName]).toEqual([120, 'tainted_water', 'Tainted Water']);
    for (const flag of ['solid', 'opaque', 'liquid', 'breakable', 'cullSame', 'layer', 'soundGroup', 'meshed', 'gravity', 'shape']) {
      expect(d[flag], flag).toBe(w[flag]);
    }
    expect(d.layer).toBe(LAYER_TRANSLUCENT);
    expect(d.placeable).toBe(false);
    expect(PICKER_ORDER).not.toContain(T);
    expect(itemForBlock(T)).toBeNull();
    expect(d.tiles).toEqual(new Array(8).fill(TILE.TAINTED_WATER));
    expect(TILE.TAINTED_WATER).toBe(204);
    expect(TILE_NAMES[204]).toBe('tainted_water');
  });

  it('is water to every predicate: a source of level 7, liquid, fall-through, replaceable, never a ray target', () => {
    expect(isWater(T) && isWaterSource(T) && isLiquid(T) && isFallThrough(T) && isReplaceable(T)).toBe(true);
    expect(isSolid(T) || isOpaque(T) || isBreakable(T) || isPlaceable(T) || isTargetable(T)).toBe(false);
    expect(waterLevel(T)).toBe(7);
    expect(isWaterSource(B.WATER)).toBe(true);
    for (const id of [B.WATER_FALL, flow(1), flow(6), B.AIR, B.ICE, 255]) expect(isWaterSource(id), String(id)).toBe(false);
    // the surface is water's: lowered under air, full under more water — whichever kind of water that is
    expect(waterSurfaceHeight(T, B.AIR)).toBe(waterSurfaceHeight(B.WATER, B.AIR));
    expect(waterSurfaceHeight(T, B.WATER)).toBe(1);
    expect(waterSurfaceHeight(B.WATER, T)).toBe(1);
    expect(waterSurfaceHeight(flow(3), T)).toBe(1);
    // the other modules that ask about water answer the same for it
    expect(lightOpacity(T)).toBe(WATER_LIGHT_OPACITY);
    expect(lightOpacity(T)).toBe(lightOpacity(B.WATER));
    expect(isEarth(T)).toBe(true);
    expect(isBlastProof(T)).toBe(true);
    expect(ruleFor(T)).toBeNull(); // unbreakable in Survival, like the rest of the family
    expect(isWaterFloor(T)).toBe(true);
    expect(fallLevel({ peek: (_q, y, _r) => [B.WATER_FALL, B.WATER_FALL, T][y] ?? B.AIR }, 0, 0, 0)).toBe(7);
    expect(WATER_RULE_IDS).toContain(T);
  });

  it('resolves by name and by id in commands (`setblock … tainted_water`)', () => {
    expect(resolveBlock('tainted_water')).toEqual({ id: T });
    expect(resolveBlock('Tainted Water')).toEqual({ id: T });
    expect(resolveBlock('120')).toEqual({ id: T });
    expect(resolveBlock('water')).toEqual({ id: B.WATER }); // the exact name still wins
  });

  it('its tile is murky green-brown, plainly not water\'s blue, and cloudier (alpha 216 against 178)', () => {
    const px = paintTile(TILE.TAINTED_WATER);
    for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(216);
    const water = paintTile(TILE.WATER);
    for (let i = 3; i < water.length; i += 4) expect(water[i]).toBe(178);
    const [r, g, b] = averageColor(TILE.TAINTED_WATER);
    const [wr, wg, wb] = averageColor(TILE.WATER);
    expect(wb).toBeGreaterThan(wr + 100); // water: blue
    expect(b).toBeLessThan(r - 30); // tainted: no blue to speak of …
    expect(b).toBeLessThan(g - 30);
    expect(Math.abs(r - g)).toBeLessThan(25); // … an olive brown
    expect(Math.hypot(r - wr, g - wg, b - wb)).toBeGreaterThan(150);
    // …and not grass either (0x5e9e3a): much duller
    const [gr, gg, gb] = averageColor(TILE.GRASS_TOP);
    expect(Math.hypot(r - gr, g - gg, b - gb)).toBeGreaterThan(40);
    expect(paintTile(TILE.TAINTED_WATER)).toEqual(px); // deterministic
  });

  it('meshes in the translucent layer with its own tile, and shows no wall against fresh water beside it', () => {
    const mesh = buildCellMesh(T);
    expect(mesh.translucent.indices.length).toBeGreaterThan(0);
    expect(mesh.opaque).toBeNull();
    expect(mesh.cutout).toBeNull();
    // same shape as a water cell (the lowered surface), different picture
    const water = buildCellMesh(B.WATER);
    expect([...mesh.translucent.positions]).toEqual([...water.translucent.positions]);
    expect([...mesh.translucent.uvs]).not.toEqual([...water.translucent.uvs]);
    // Two cells side by side in an empty chunk. The culling rule alone would draw both faces between two DIFFERENT
    // see-through blocks; the mesher's water rule (surfaces of equal height show nothing between them) hides them, since
    // both are water to it: tainted beside fresh draws exactly as many triangles as fresh beside fresh.
    const pair = (a, b) => {
      const chunk = { blocks: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT), biomes: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE), heights: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE) };
      chunk.blocks[localIndex(5, 3, 5)] = a;
      chunk.blocks[localIndex(6, 3, 5)] = b;
      return buildChunkMesh(0, 0, (cq, cr) => (cq === 0 && cr === 0 ? chunk : null)).translucent.indices.length;
    };
    expect(shouldRenderFace(T, B.WATER)).toBe(true); // (the plain rule would draw it)
    expect(pair(T, B.WATER)).toBe(pair(B.WATER, B.WATER));
    expect(pair(B.WATER, T)).toBe(pair(B.WATER, B.WATER));
    expect(pair(T, T)).toBe(pair(B.WATER, B.WATER));
    expect(pair(T, B.AIR) * 2).toBeGreaterThan(pair(T, B.WATER)); // two lone cells draw two more faces
    // a full tainted cell under a solid block stays full height, like water (FULL_WATER)
    const under = (id) => {
      const chunk = { blocks: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT), biomes: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE), heights: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE) };
      chunk.blocks[localIndex(5, 3, 5)] = id;
      chunk.blocks[localIndex(5, 4, 5)] = B.GLASS;
      const pos = buildChunkMesh(0, 0, (cq, cr) => (cq === 0 && cr === 0 ? chunk : null)).translucent.positions;
      let top = -Infinity;
      for (let k = 1; k < pos.length; k += 3) top = Math.max(top, pos[k]);
      return top;
    };
    expect(under(T)).toBe(4);
    expect(under(B.WATER)).toBe(4);
  });
});

describe('the water rule with two kinds of source (§35.2, §76)', () => {
  it('a tainted source spreads exactly like water: 126 flowing cells, level 7 − distance', () => {
    const { world, physics } = setup();
    world.setBlock(0, 1, 0, T);
    settle(physics);
    const cells = waterCells(world, 12, 0, 4);
    expect(cells.filter(([, , , id]) => id === T)).toHaveLength(1);
    const flows = cells.filter(([, , , id]) => id !== T);
    expect(flows).toHaveLength(126);
    for (const [q, y, r, id] of flows) {
      expect(y).toBe(1);
      expect(id, `${q},${r}`).toBe(flow(7 - hexLength(q, r)));
    }
    // taking the source away drains all of it
    world.setBlock(0, 1, 0, B.AIR);
    settle(physics);
    expect(waterCells(world, 12, 0, 4)).toEqual([]);
    expect(world.editCount).toBe(0);
  });

  it('falls like water: off a ledge it lands at full strength and spreads where it lands', () => {
    const { world, physics } = setup();
    world.setBlock(0, 6, 0, T); // in mid-air, five cells above the floor
    settle(physics);
    for (let y = 2; y <= 5; y++) expect(world.getBlock(0, y, 0), `y ${y}`).toBe(B.WATER_FALL);
    expect(world.getBlock(0, 1, 0)).toBe(B.WATER_FALL);
    expect(world.getBlock(1, 1, 0)).toBe(flow(6));
    expect(waterCells(world, 12, 1, 1).filter(([, , , id]) => id !== B.WATER_FALL)).toHaveLength(126);
  });

  /**
   * A hole at (0, 4, 0) in a natural stone slab, with sources `kinds` (three ids) in three of its six side cells: the hole
   * fills (FLOW_6), and with three sources beside it over a floor it becomes a source itself (the infinite-source rule).
   */
  function holeAmong(kinds) {
    const { world, physics } = setup(3);
    slab(world, 4, 4);
    world.put(0, 4, 0, B.AIR);
    [0, 2, 4].forEach((j, i) => world.put(HEX_DIRS[j][0], 4, HEX_DIRS[j][1], kinds[i]));
    physics.scheduleWaterAround(0, 4, 0);
    settle(physics);
    return world.getBlock(0, 4, 0);
  }

  it('a new source among three sources is tainted when ANY of them is: taint never dilutes', () => {
    expect(holeAmong([B.WATER, B.WATER, B.WATER])).toBe(B.WATER);
    expect(holeAmong([T, T, T])).toBe(T);
    expect(holeAmong([B.WATER, B.WATER, T])).toBe(T);
    expect(holeAmong([T, B.WATER, B.WATER])).toBe(T);
  });

  it('natural tainted water refills as tainted water, leaving no edit; natural fresh water as fresh', () => {
    for (const id of [T, B.WATER]) {
      const { world, physics } = setup(3);
      slab(world, 4, 4);
      // a natural seven-cell pond in the slab
      world.put(0, 4, 0, id);
      for (const [dq, dr] of HEX_DIRS) world.put(dq, 4, dr, id);
      world.setBlock(0, 4, 0, B.AIR); // the middle cell taken away (six sources round it)
      settle(physics);
      expect(world.getBlock(0, 4, 0)).toBe(id);
      world.setBlock(1, 4, 0, B.AIR); // an edge cell: three sources beside it (the middle and two of the ring)
      settle(physics);
      expect(world.getBlock(1, 4, 0)).toBe(id);
      expect(world.editCount).toBe(0);
    }
    // … whatever is beside it: a natural tainted cell with only FRESH water around comes back tainted
    const { world, physics } = setup(3);
    slab(world, 4, 4);
    world.put(0, 4, 0, T);
    for (const [dq, dr] of HEX_DIRS) world.put(dq, 4, dr, B.WATER);
    world.setBlock(0, 4, 0, B.AIR);
    settle(physics);
    expect(world.getBlock(0, 4, 0)).toBe(T);
    expect(world.editCount).toBe(0);
  });

  it('sand sinks through it and `drain` removes it, counting it as natural water', () => {
    const { world, physics } = setup(3);
    slab(world, 4, 4);
    world.put(0, 4, 0, T);
    for (const [dq, dr] of HEX_DIRS) world.put(dq, 4, dr, T);
    const res = physics.fluids.drain(0, 4, 0, 1);
    expect(res.ok).toBe(true);
    expect(res.message).toBe('drained 7 water cells within 1'); // (nothing round it to flow back in)
    settle(physics);
    expect(waterCells(world, 3, 4, 4)).toEqual([]);
  });
});

describe('saving (§33.9, §35.6, §76)', () => {
  it('a tainted source that was placed is saved as itself; flow over a tainted origin is dropped, over anything else it is AIR', () => {
    const key = chunkKey(0, 0);
    const li = (q, y, r) => localIndex(q, y, r);
    const world = {
      peekBlock: () => B.AIR,
      edits: new Map([[key, new Map([[li(1, 5, 1), T], [li(2, 5, 2), flow(4)], [li(3, 5, 3), B.WATER_FALL], [li(4, 5, 4), flow(2)], [li(5, 5, 5), flow(6)]])]]),
      origins: new Map([[key, new Map([[li(1, 5, 1), B.AIR], [li(2, 5, 2), T], [li(3, 5, 3), B.WATER], [li(4, 5, 4), B.STONE], [li(5, 5, 5), B.AIR]])]]),
    };
    expect(new SaveOverlay(world).toJSON()).toEqual({ [key]: [li(1, 5, 1), T, li(4, 5, 4), B.AIR] });
    // with Water switched off the flow is kept as it stands, as before
    expect(new SaveOverlay(world, { keepFlow: true }).toJSON()[key]).toHaveLength(10);
  });

  it('a spillway dug out of a natural tainted pond saves only the dug cells (as AIR) and re-flows from the pond on load', () => {
    const { world, physics } = setup(3);
    slab(world, 6, 4);
    world.put(0, 4, 0, T);
    for (const [dq, dr] of HEX_DIRS) world.put(dq, 4, dr, T);
    world.setBlock(2, 4, 0, B.AIR); // beside the ring cell (1, 4, 0)
    world.setBlock(3, 4, 0, B.AIR);
    settle(physics);
    expect(world.getBlock(2, 4, 0)).toBe(flow(6));
    expect(world.getBlock(3, 4, 0)).toBe(flow(5));
    const edits = physics.exportEdits();
    const ids = Object.values(edits).flatMap((arr) => arr.filter((_, i) => i % 2 === 1));
    expect(ids).toEqual([B.AIR, B.AIR]);
  });

  it('block 120 in the edits and a Pot of Tainted Water in the pack, a basket and on a fire survive save and load', () => {
    const edits = { [chunkKey(0, 0)]: [localIndex(1, 64, 1), T, localIndex(2, 64, 2), B.WICKER_BASKET, localIndex(3, 64, 3), B.CAMPFIRE] };
    const nulls = (n) => new Array(n).fill(null);
    const survival = {
      health: 90, satiation: 60, hydration: 55, temp: 37, breath: 20, wet: 0, sick: 0, heal: 0, healRate: 0, spawn: null, deaths: 0,
      pack: [{ k: 'pot_tainted', n: 1 }, { k: 'pot_water', n: 1 }, { k: 'pot_boiled', n: 1 }, ...nulls(24)],
      wear: [null, null, null],
      fires: { '3,64,3': { s: [...nulls(6), { k: 'pot_tainted', t: 4.5 }], f: 200 } },
    };
    const containers = { '2,64,2': { kind: 'basket', slots: [{ k: 'pot_tainted', n: 1 }, ...nulls(17)] } };
    const data = {
      version: SAVE_VERSION, seed: 7, time: 0.3, day: 0, player: { x: 0.5, y: 70, z: 0.5, yaw: 0, pitch: 0, flying: false },
      hotbar: [1, 2, 3, 4, 5, 10, 11, 12, 20], selected: 0, edits, gen: 3, mode: 'survival', survival, containers,
    };
    const text = serializeSave(data);
    const back = deserializeSave(text);
    expect(back.warnings).toEqual([]);
    expect(back.gen).toBe(3);
    expect(back.edits).toEqual(edits);
    expect(back.survival.pack.slice(0, 3)).toEqual([{ k: 'pot_tainted', n: 1 }, { k: 'pot_water', n: 1 }, { k: 'pot_boiled', n: 1 }]);
    expect(back.survival.fires).toEqual(survival.fires);
    expect(back.containers).toEqual(containers);
    expect(serializeSave(back)).toBe(text); // canonical
  });
});

describe('waterQualityAt: flowing water is as good as its sources (§76)', () => {
  it('a source is what it is; anything that is not water reads fresh', () => {
    const cells = { '0,1,0': T, '1,1,0': B.WATER, '2,1,0': B.STONE, '3,1,0': B.ICE };
    const get = (q, y, r) => cells[`${q},${y},${r}`] ?? B.AIR;
    expect(waterQualityAt(get, 0, 1, 0)).toBe('tainted');
    expect(waterQualityAt(get, 1, 1, 0)).toBe('fresh');
    for (const q of [2, 3, 4]) expect(waterQualityAt(get, q, 1, 0)).toBe('fresh');
  });

  it('every cell that flows out of a tainted source reads tainted, out of a fresh one fresh', () => {
    for (const [id, want] of [[T, 'tainted'], [B.WATER, 'fresh']]) {
      const { world, physics } = setup();
      world.setBlock(0, 1, 0, id);
      settle(physics);
      const flows = waterCells(world, 8, 1, 1).filter(([, , , c]) => c !== id);
      expect(flows).toHaveLength(126);
      for (const [q, y, r] of flows) expect(waterQualityAt(world.getBlock, q, y, r), `${q},${r}`).toBe(want);
    }
  });

  it('a spillway does not make a pond fresh: down a waterfall and along the ground below it the water is still tainted', () => {
    const { world, physics } = setup();
    // a 10-high stone pillar disc of radius 2 with a tainted source on top, at its edge
    for (let y = 1; y <= 10; y++) slab(world, 2, y);
    world.setBlock(2, 11, 0, T);
    settle(physics);
    const cells = waterCells(world, 12, 1, 11);
    const falls = cells.filter(([, , , id]) => id === B.WATER_FALL);
    const flows = cells.filter(([, , , id]) => id !== B.WATER_FALL && id !== T);
    expect(falls.length).toBeGreaterThan(20);
    expect(flows.length).toBeGreaterThan(40);
    expect(flows.some(([, y]) => y === 1)).toBe(true); // it reached the ground
    for (const [q, y, r] of [...falls, ...flows]) expect(waterQualityAt(world.getBlock, q, y, r), `${q},${y},${r}`).toBe('tainted');
  });

  /**
   * A one-wide trench along q at y = 1 (stone walls either side, on the y = 0 floor), q = 0..len: sources go in by hand.
   * @returns {{ world: *, physics: * }}
   */
  function trench(len) {
    const { world, physics } = setup();
    // the cells (q, 0) for q = 0..len are the trench; the rows either side of it and the two cells past its ends are wall
    for (let q = -3; q <= len + 3; q++) for (const r of [-1, 1]) world.put(q, 1, r, B.STONE);
    world.put(-1, 1, 0, B.STONE);
    world.put(len + 1, 1, 0, B.STONE);
    return { world, physics };
  }

  it('where fresh and tainted water meet, the mix is tainted; water fed by the fresh source alone stays fresh', () => {
    const { world, physics } = trench(12);
    world.setBlock(0, 1, 0, B.WATER);
    world.setBlock(12, 1, 0, T);
    settle(physics);
    const row = [];
    for (let q = 0; q <= 12; q++) row.push(world.getBlock(q, 1, 0));
    expect(row).toEqual([B.WATER, flow(6), flow(5), flow(4), flow(3), flow(2), flow(1), flow(2), flow(3), flow(4), flow(5), flow(6), T]);
    const quality = row.map((_, q) => waterQualityAt(world.getBlock, q, 1, 0));
    expect(quality.slice(0, 6)).toEqual(new Array(6).fill('fresh')); // fed from the fresh end only
    expect(quality.slice(7)).toEqual(new Array(6).fill('tainted')); // fed from the tainted end only
    // the middle cell is level 1 from both sides: both feed it, so it is tainted
    expect(quality[6]).toBe('tainted');
  });

  it('a tainted trickle falling into a fresh channel taints the water downstream of where it lands, not upstream', () => {
    const { world, physics } = trench(8);
    world.setBlock(0, 1, 0, B.WATER);
    settle(physics);
    expect(world.getBlock(3, 1, 0)).toBe(flow(4));
    // falling water lands on channel cell q = 3: a tainted source five cells above it
    world.setBlock(3, 6, 0, T);
    settle(physics);
    expect(world.getBlock(3, 1, 0)).toBe(B.WATER_FALL); // the fall (7) feeds it better than the channel (4)
    expect(waterQualityAt(world.getBlock, 3, 1, 0)).toBe('tainted');
    expect(waterQualityAt(world.getBlock, 3, 4, 0)).toBe('tainted');
    for (const q of [4, 5, 6, 7, 8]) expect(waterQualityAt(world.getBlock, q, 1, 0), `q ${q}`).toBe('tainted');
    // upstream: q = 1 is still fed by the fresh source alone; q = 2 now takes its level from the landing as well
    expect(world.getBlock(1, 1, 0)).toBe(flow(6));
    expect(waterQualityAt(world.getBlock, 1, 1, 0)).toBe('fresh');
    expect(world.getBlock(2, 1, 0)).toBe(flow(6));
    expect(waterQualityAt(world.getBlock, 2, 1, 0)).toBe('tainted');
  });

  it('stale water with no source in reach reads fresh, UNLOADED cells are skipped, and the search is bounded', () => {
    // a FLOW cell with nothing feeding it (about to drain), and one whose only feeder is not loaded
    const cells = { '0,1,0': flow(3), '5,1,0': flow(3), '6,1,0': 255 };
    const get = (q, y, r) => (y === 0 ? B.STONE : cells[`${q},${y},${r}`] ?? B.AIR);
    expect(waterQualityAt(get, 0, 1, 0)).toBe('fresh');
    expect(waterQualityAt(get, 5, 1, 0)).toBe('fresh');
    // an endless column of falling water with nothing on top: the search gives up after QUALITY_TRACE_MAX cells
    let reads = 0;
    const endless = (q, _y, r) => {
      reads++;
      return q === 0 && r === 0 ? B.WATER_FALL : B.AIR;
    };
    expect(waterQualityAt(endless, 0, 0, 0)).toBe('fresh');
    expect(QUALITY_TRACE_MAX).toBe(256);
    expect(reads).toBeLessThanOrEqual(3 * QUALITY_TRACE_MAX);
    // … and a tainted source just inside the bound is still found
    const tall = (q, y, r) => (q === 0 && r === 0 ? (y === 200 ? T : y < 200 ? B.WATER_FALL : B.AIR) : B.AIR);
    expect(waterQualityAt(tall, 0, 0, 0)).toBe('tainted');
  });
});

describe('drinking it (§66, §76)', () => {
  it('RATES: a tainted gulp poisons 40 % of the time, a fresh one 6 %; both give +8', () => {
    expect(RATES.GULP_TAINTED_SICK).toBe(0.4);
    expect(RATES.GULP_FRESH_SICK).toBe(0.06);
    const v = createVitals();
    v.hydration = 40;
    expect(gulpWater(v, 'tainted', () => 0.41)).toEqual({ sick: false });
    expect(v.hydration).toBe(48);
    expect(gulpWater(v, 'tainted', () => 0.39)).toEqual({ sick: true });
    expect(v.hydration).toBe(48 + RATES.GULP_FRESH + RATES.POISON_THIRST); // +8, and the poisoning's −8 at once
    expect(v.sick).toBe(RATES.SICK_S);
    // 'fresh' and 'salt' are the old false and true
    const a = createVitals();
    const b = createVitals();
    a.hydration = b.hydration = 50;
    expect(gulpWater(a, 'fresh', () => 0.059)).toEqual(gulpWater(b, false, () => 0.059));
    expect(a).toEqual(b);
    expect(gulpWater(a, 'salt', () => 0)).toEqual(gulpWater(b, true, () => 0));
    expect(a).toEqual(b);
    expect(a.hydration).toBe(50 + RATES.GULP_FRESH + RATES.POISON_THIRST + RATES.GULP_SALT);
    // hydration stays within 0..STAT_MAX
    const full = createVitals();
    full.hydration = STAT_MAX - 1;
    gulpWater(full, 'tainted', () => 0.99);
    expect(full.hydration).toBe(STAT_MAX);
  });

  it('exactly one random() per fresh or tainted gulp, none for salt', () => {
    let calls = 0;
    const random = () => {
      calls++;
      return 0.5;
    };
    gulpWater(createVitals(), 'tainted', random);
    expect(calls).toBe(1);
    gulpWater(createVitals(), 'fresh', random);
    expect(calls).toBe(2);
    gulpWater(createVitals(), 'salt', random);
    gulpWater(createVitals(), true, random);
    expect(calls).toBe(2);
  });

  it('over 20 000 seeded gulps the poisoning rates are 40 % (tainted) and 6 % (fresh)', () => {
    const random = mulberry32(76);
    const rate = (quality) => {
      let sick = 0;
      for (let i = 0; i < 20000; i++) if (gulpWater(createVitals(), quality, random).sick) sick++;
      return sick / 20000;
    };
    const tainted = rate('tainted');
    const fresh = rate('fresh');
    expect(tainted).toBeGreaterThan(0.38);
    expect(tainted).toBeLessThan(0.42);
    expect(fresh).toBeGreaterThan(0.05);
    expect(fresh).toBeLessThan(0.07);
    expect(rate('salt')).toBe(0);
  });

  it('Survival.drink takes the quality (or the old salty flag): tainted is +8 with the 40 % chance and the poisoned line', () => {
    const s = new Survival();
    s.setMode('survival');
    s.vitals.hydration = 50;
    expect(s.drink('tainted', () => 0.5)).toBe('');
    expect(s.vitals.hydration).toBe(58);
    expect(s.drink('tainted', () => 0.39)).toBe(SICK_MESSAGE);
    expect(s.vitals.hydration).toBe(58);
    expect(s.drink('fresh', () => 0.39)).toBe('');
    expect(s.vitals.hydration).toBe(66);
    expect(s.drink('salt', () => 0)).toBe(SALT_MESSAGE);
    expect(s.vitals.hydration).toBe(62);
    expect(s.drink(false, () => 0.5)).toBe(''); // the old flags still mean fresh …
    expect(s.vitals.hydration).toBe(70);
    expect(s.drink(true, () => 0.5)).toBe(''); // … and salt (its line is throttled)
    expect(s.vitals.hydration).toBe(66);
    const creative = new Survival();
    expect(creative.drink('tainted', () => 0)).toBe(''); // nothing happens outside Survival
    expect(creative.vitals.sick).toBe(0);
  });

  it('the Pot of Tainted Water: the hydration of a Pot of Water, poisons 60 % of the time, gives the pot back, keeps', () => {
    const tainted = getItem('pot_tainted');
    const water = getItem('pot_water');
    expect(tainted).toEqual({
      key: 'pot_tainted', name: 'Pot of Tainted Water', kind: 'food', stack: 1,
      food: { satiation: 0, hydration: 30, sick: 0.6, useS: 1.0, returns: 'clay_pot' },
    });
    expect(tainted.food.hydration).toBe(water.food.hydration);
    expect(tainted.food.useS).toBe(water.food.useS);
    expect(tainted.food.spoilS).toBeUndefined();
    expect(ITEM_KEYS.filter((k) => ITEMS[k].kind === 'food').at(-1)).toBe('pot_tainted'); // the last food
    expect(resolveItem('Pot of Tainted Water')).toEqual({ key: 'pot_tainted' });
    expect(hasItemArt('pot_tainted')).toBe(true);
    expect(ITEM_ART_KEYS.indexOf('pot_tainted')).toBe(ITEM_ART_KEYS.indexOf('pot_milk') + 1);
    expect(useActionOf({ k: 'pot_tainted', n: 1 })).toEqual({ kind: 'drink', key: 'pot_tainted', needS: 1 });
    // drinking one
    const s = new Survival();
    s.setMode('survival');
    s.vitals.hydration = 40;
    expect(s.eat('pot_tainted', () => 0.61)).toEqual({ ok: true, returns: 'clay_pot' });
    expect(s.vitals.hydration).toBe(70);
    expect(s.eat('pot_tainted', () => 0.59)).toEqual({ ok: true, message: SICK_MESSAGE, returns: 'clay_pot' });
    // rates over seeded samples: 60 % tainted, 20 % fresh, never boiled
    const random = mulberry32(2026);
    const rate = (key) => {
      let sick = 0;
      for (let i = 0; i < 20000; i++) if (eatFood(createVitals(), ITEMS[key].food, random).sick) sick++;
      return sick / 20000;
    };
    const rt = rate('pot_tainted');
    const rw = rate('pot_water');
    expect(rt).toBeGreaterThan(0.58);
    expect(rt).toBeLessThan(0.62);
    expect(rw).toBeGreaterThan(0.18);
    expect(rw).toBeLessThan(0.22);
    expect(rate('pot_boiled')).toBe(0);
  });
});

describe('R on water: the hint says what it is (§44, §76)', () => {
  it('waterKind: tainted wins, then the biome\'s salt, else fresh; each fills its own pot', () => {
    expect(waterKind(false, false)).toBe('fresh');
    expect(waterKind(false, true)).toBe('salt');
    expect(waterKind(true, false)).toBe('tainted');
    expect(waterKind(true, true)).toBe('tainted');
    // a generated stream runs fresh across the beach (a salty biome) to the sea; tainted water in it is still tainted
    expect(waterKind(false, true, true)).toBe('fresh');
    expect(waterKind(false, false, true)).toBe('fresh');
    expect(waterKind(true, true, true)).toBe('tainted');
    expect(waterKind(false, true, false)).toBe('salt');
    expect(WATER_POTS).toEqual({ fresh: 'pot_water', salt: 'pot_seawater', tainted: 'pot_tainted' });
    for (const k of Object.values(WATER_POTS)) expect(getItem(k)?.food?.returns, k).toBe('clay_pot');
    expect(Object.isFrozen(WATER_POTS)).toBe(true);
  });

  it('waterHint names fresh, salt and tainted water; the old boolean still means fresh / salt', () => {
    expect(waterHint('fresh', false)).toBe('Fresh water · R: drink');
    expect(waterHint('salt', false)).toBe('Sea water (salty) · R: drink');
    expect(waterHint('tainted', false)).toBe('Tainted water · R: drink (risky)');
    expect(waterHint('fresh', true)).toBe('Fresh water · R: fill the pot');
    expect(waterHint('salt', true)).toBe('Sea water (salty) · R: fill the pot');
    expect(waterHint('tainted', true)).toBe('Tainted water · R: fill the pot');
    expect(waterHint(false, false)).toBe(waterHint('fresh', false));
    expect(waterHint(true, true)).toBe(waterHint('salt', true));
  });

  it('interactKind carries the quality of the water cell it was asked about, with its hint', () => {
    const asked = [];
    const waterQuality = (q, y, r) => {
      asked.push([q, y, r]);
      return q > 0 ? 'tainted' : q < 0 ? 'salt' : 'fresh';
    };
    const ctx = (o) => ({ hit: null, waterHit: null, headInWater: false, selectedKey: null, pack: new Pack(), waterQuality, ...o });
    const at = (q, blockId = B.WATER) => ({ q, y: 65, r: 2, blockId, distance: 2 });
    expect(interactKind(ctx({ waterHit: at(4, T) })))
      .toEqual({ kind: 'drink', q: 4, y: 65, r: 2, quality: 'tainted', salty: false, hint: 'Tainted water · R: drink (risky)' });
    expect(interactKind(ctx({ waterHit: at(4, B.WATER_FLOW_3), selectedKey: 'clay_pot' })))
      .toEqual({ kind: 'fill', q: 4, y: 65, r: 2, quality: 'tainted', salty: false, hint: 'Tainted water · R: fill the pot' });
    expect(interactKind(ctx({ waterHit: at(0) })))
      .toEqual({ kind: 'drink', q: 0, y: 65, r: 2, quality: 'fresh', salty: false, hint: 'Fresh water · R: drink' });
    expect(interactKind(ctx({ waterHit: at(-3), selectedKey: 'clay_pot' })))
      .toEqual({ kind: 'fill', q: -3, y: 65, r: 2, quality: 'salt', salty: true, hint: 'Sea water (salty) · R: fill the pot' });
    expect(asked).toEqual([[4, 65, 2], [4, 65, 2], [0, 65, 2], [-3, 65, 2]]);
    // `waterQuality` is used instead of `salty` when both are given
    expect(interactKind(ctx({ waterHit: at(4, T), salty: () => true })).quality).toBe('tainted');
    // the tainted source is water to the R ray like any other
    expect(interactKind(ctx({ waterHit: at(4, T), waterQuality: undefined })).kind).toBe('drink');
  });
});

describe('boiling it (§46, §76)', () => {
  it('a Pot of Tainted Water goes in the embers and boils to a Pot of Boiled Water in 15 s, exactly like fresh water', () => {
    expect(FIRE_TRANSFORMS.pot_tainted).toEqual(FIRE_TRANSFORMS.pot_water);
    expect(FIRE_TRANSFORMS.pot_tainted).toEqual({ to: 'pot_boiled', seconds: 15, spot: 'centre' });
    expect(CENTRE_POTS).toContain('pot_tainted');
    expect(isCentrePot('pot_tainted')).toBe(true);
    expect(spotAccepts(EMBERS_SPOT, 'pot_tainted')).toBe(true);
    expect(spotAccepts(0, 'pot_tainted')).toBe(false);
    expect(SPOT_ITEMS.pot_tainted).toEqual(SPOT_ITEMS.pot_water);
    const fs = new FireSlots();
    expect(fs.put(0, 64, 0, 'pot_tainted', 0)).toBe(EMBERS_SPOT);
    fs.step(14.5, null, null);
    expect(fs.view(0, 64, 0).spots[EMBERS_SPOT].k).toBe('pot_tainted');
    fs.step(1, null, null);
    expect(fs.view(0, 64, 0).spots[EMBERS_SPOT].k).toBe('pot_boiled');
    expect(fs.takeReady(0, 64, 0)).toEqual([{ k: 'pot_boiled', n: 1 }]);
    expect(ITEMS.pot_boiled.food.sick).toBe(0);
  });
});

describe('fresh water that stands too long spoils (§43, §76)', () => {
  it('a Pot of Water spoils INTO a Pot of Tainted Water after about two game days; boiled and tainted water keep', () => {
    expect(POT_WATER_SPOIL_S).toBe(2 * DAY_LENGTH_SECONDS);
    expect(ITEMS.pot_water.food.spoilS).toBe(POT_WATER_SPOIL_S);
    expect(ITEMS.pot_water.food.spoilsTo).toBe('pot_tainted');
    expect(ITEMS.pot_boiled.food.spoilS).toBeUndefined();
    expect(ITEMS.pot_tainted.food.spoilS).toBeUndefined();
    // every `spoilsTo` names a real item, and only the Pot of Water has one
    const turning = Object.values(ITEMS).filter((d) => d.food?.spoilsTo !== undefined);
    expect(turning.map((d) => d.key)).toEqual(['pot_water']);
    for (const d of turning) expect(getItem(d.food.spoilsTo)).not.toBeNull();
  });

  it('spoilSlots turns the pot where it lies — it never vanishes — with one random() per perishable stack', () => {
    const slots = [{ k: 'pot_water', n: 1 }, { k: 'pot_boiled', n: 1 }, null, { k: 'pot_water', n: 1 }, { k: 'pot_tainted', n: 1 }, { k: 'raw_pork', n: 3 }];
    const rolls = [0.9999, 0, 0.9999]; // pot 0 keeps, pot 3 turns, the pork keeps
    let calls = 0;
    const spoiled = new Map();
    expect(spoilSlots(slots, 1, () => rolls[calls++], spoiled)).toBe(true);
    expect(calls).toBe(3); // the two Pots of Water and the pork: nothing for boiled, tainted or the empty slot
    expect(slots).toEqual([{ k: 'pot_water', n: 1 }, { k: 'pot_boiled', n: 1 }, null, { k: 'pot_tainted', n: 1 }, { k: 'pot_tainted', n: 1 }, { k: 'raw_pork', n: 3 }]);
    expect([...spoiled]).toEqual([['pot_water', 1]]);
    // the roll is min(1, n·dt / spoilS): 1 / 2880 a second
    const one = [{ k: 'pot_water', n: 1 }];
    expect(spoilSlots(one, 1, () => 1 / POT_WATER_SPOIL_S, new Map())).toBe(false);
    expect(spoilSlots(one, 1, () => 1 / POT_WATER_SPOIL_S - 1e-9, new Map())).toBe(true);
    expect(one).toEqual([{ k: 'pot_tainted', n: 1 }]);
    // … and a pot that has turned is done: nothing rolls for it again
    calls = 0;
    expect(spoilSlots(one, 1e9, () => (calls++, 0), new Map())).toBe(false);
    expect(calls).toBe(0);
  });

  it('a pot lasts about two game days on average (seeded, second by second)', () => {
    const random = mulberry32(9);
    let total = 0;
    const pots = 400;
    for (let i = 0; i < pots; i++) {
      const slots = [{ k: 'pot_water', n: 1 }];
      let t = 0;
      while (slots[0].k === 'pot_water') {
        spoilSlots(slots, 1, random, new Map());
        t++;
      }
      total += t;
    }
    const mean = total / pots;
    expect(mean).toBeGreaterThan(POT_WATER_SPOIL_S * 0.85);
    expect(mean).toBeLessThan(POT_WATER_SPOIL_S * 1.15);
  });

  it('in the pack and in a basket alike; the pack reports what turned and the chat line says what it became', () => {
    const p = new Pack();
    p.slots[4] = { k: 'pot_water', n: 1 };
    p.slots[5] = { k: 'honeyberries', n: 2 };
    const v = p.version;
    expect(p.spoil(1, () => 0)).toEqual([{ k: 'pot_water', n: 1 }, { k: 'honeyberries', n: 1 }]);
    expect(p.slots[4]).toEqual({ k: 'pot_tainted', n: 1 });
    expect(p.slots[5]).toEqual({ k: 'honeyberries', n: 1 });
    expect(p.version).toBe(v + 1);
    expect(p.count('pot_water')).toBe(0);
    expect(p.count('pot_tainted')).toBe(1);

    const c = new Containers();
    c.onBlockChange(0, 60, 0, B.AIR, B.WICKER_BASKET);
    c.get(0, 60, 0).slots[2] = { k: 'pot_water', n: 1 };
    expect(c.spoil(1, () => 0, () => true)).toEqual([{ k: 'pot_water', n: 1 }]);
    expect(c.get(0, 60, 0).slots[2]).toEqual({ k: 'pot_tainted', n: 1 });

    expect(spoiledText([{ k: 'pot_water', n: 1 }])).toBe('1 Pot of Water stood too long: now Pot of Tainted Water.');
    expect(spoiledText([{ k: 'raw_pork', n: 1 }, { k: 'pot_water', n: 1 }, { k: 'honeyberries', n: 2 }]))
      .toBe('1 Raw Pork and 2 Honeyberries went bad. 1 Pot of Water stood too long: now Pot of Tainted Water.');
    expect(spoiledText([{ k: 'raw_pork', n: 1 }])).toBe('1 Raw Pork went bad.'); // unchanged
  });

  it('one of a bigger stack that turns needs a place of its own, or the stack stays good (a registry stand-in)', () => {
    // no real item both stacks and turns; the rule is written for one that would
    const itemOf = (k) => (k === 'honeyberries' ? { food: { ...ITEMS.honeyberries.food, spoilS: 10, spoilsTo: 'rock' } } : getItem(k));
    const slots = [{ k: 'honeyberries', n: 3 }, null, { k: 'rock', n: 5 }];
    const spoiled = new Map();
    expect(spoilSlots(slots, 1, () => 0, spoiled, itemOf)).toBe(true);
    expect(slots).toEqual([{ k: 'honeyberries', n: 2 }, null, { k: 'rock', n: 6 }]); // merged into the stack of its kind
    const noRock = [{ k: 'honeyberries', n: 2 }, null];
    expect(spoilSlots(noRock, 1, () => 0, spoiled, itemOf)).toBe(true);
    expect(noRock).toEqual([{ k: 'honeyberries', n: 1 }, { k: 'rock', n: 1 }]); // else the first empty slot
    expect(spoilSlots(noRock, 1, () => 0, spoiled, itemOf)).toBe(true);
    expect(noRock).toEqual([{ k: 'rock', n: 1 }, { k: 'rock', n: 1 }]); // the last one turns where it lies
    expect([...spoiled]).toEqual([['honeyberries', 3]]);
    const full = [{ k: 'honeyberries', n: 2 }, { k: 'stick', n: 1 }];
    const before = JSON.stringify(full);
    let calls = 0;
    expect(spoilSlots(full, 1, () => (calls++, 0), new Map(), itemOf)).toBe(false); // no room: nothing spoils this time
    expect(JSON.stringify(full)).toBe(before);
    expect(calls).toBe(1); // (the roll was still made: one per perishable stack)
  });
});
