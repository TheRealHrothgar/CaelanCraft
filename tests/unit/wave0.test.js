import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as C from '../../src/config.js';
import * as coords from '../../src/coords.js';
import {
  floorDiv, mod, worldToChunk, worldToLocal, chunkKey, parseChunkKey, localIndex, indexToLocal, columnIndex,
  inHeightRange, yawToForward, yawToRight, lookDirection,
} from '../../src/coords.js';
import { FACE_TOP as HEX_FACE_TOP, FACE_BOTTOM as HEX_FACE_BOTTOM, FACE_COUNT, HEX_INRADIUS, HEX_SIZE } from '../../src/hex.js';
import {
  BLOCK, BLOCKS, BLOCK_COUNT, TILE, TILE_IDS, DEFAULT_HOTBAR, PICKER_ORDER, getFaceTile, isSolid, isOpaque, isLiquid,
  UNLOADED, isWater, isWaterSource, waterLevel, isGravityBlock, isFallThrough, isLeaves, isLog,
  isReplaceable, isTargetable, isPlaceable, isBreakable, shouldRenderFace, tileToUV, LAYER_CUTOUT, LAYER_TRANSLUCENT, LAYER_OPAQUE,
  SOUND_GROUPS,
  FACE_TOP, FACE_BOTTOM,
  PLANT_IDS, POP_OFF_IDS, isPlant, isLitter, isPopOff, isStation, isContainerBlock,
  BLOCK_ALIASES, getBlockDef, isMeshed,
} from '../../src/blocks.js';
import { Chunk } from '../../src/chunk.js';

describe('config', () => {
  it('has consistent world constants', () => {
    expect(C.CHUNK_SIZE).toBe(16);
    expect(C.WORLD_HEIGHT).toBe(128);
    expect(C.CHUNK_VOLUME).toBe(16 * 16 * 128);
    expect(C.SEA_LEVEL).toBeLessThan(C.WORLD_HEIGHT - 20);
    expect(C.MAX_TERRAIN_HEIGHT).toBeLessThan(C.WORLD_HEIGHT);
  });
  it('has a sane jump height and physics knobs', () => {
    const h = (C.JUMP_VELOCITY ** 2) / (2 * -C.GRAVITY);
    expect(h).toBeGreaterThanOrEqual(1.2);
    expect(h).toBeLessThanOrEqual(1.6);
    expect(C.EYE_HEIGHT).toBeLessThan(C.PLAYER_HEIGHT);
    expect(C.MAX_FRAME_DT).toBeLessThanOrEqual(0.1);
    expect(C.REACH).toBeGreaterThanOrEqual(4);
    // The collider samples only the player's cell and its six neighbours, which is only sufficient while
    // the footprint radius is smaller than a cell's inradius.
    // The player must fit through the HEX_SIZE-wide throat of a 1-cell passage (which also implies the 7-column bound).
    expect(C.PLAYER_WIDTH / 2).toBeLessThan(HEX_SIZE / 2);
    expect(C.PLAYER_WIDTH / 2).toBeLessThan(HEX_INRADIUS);
  });
  it('hex render tunables are in range', () => {
    expect(C.TOP_UV_SCALE).toBeCloseTo(Math.sqrt(3) / 2, 12);
    // Negative: the fog must end before the nearest possibly-unmeshed cell, which is (rd − 1) rings away because the
    // mesh disc is keyed by chunk origin cells (see renderer.fogRangeForRenderDistance). Never below -1.
    expect(C.FOG_FAR_CHUNK_MARGIN).toBeGreaterThanOrEqual(-1);
    expect(C.FOG_FAR_CHUNK_MARGIN).toBeLessThan(1);
    expect(C.AO_CURVE).toHaveLength(4);
    for (let i = 1; i < 4; i++) expect(C.AO_CURVE[i]).toBeGreaterThan(C.AO_CURVE[i - 1]);
    expect(C.AO_CURVE[3]).toBe(1);
    expect(C.VERSION).toBe('0.10.0');
  });
  it('has the survival constants of DESIGN-survival §9.2 (the pack hotbar is HOTBAR_SIZE)', () => {
    expect({
      GEN_LATEST: C.GEN_LATEST,
      PACK_SLOTS: C.PACK_SLOTS, WEAR_SLOTS: C.WEAR_SLOTS, BASKET_SLOTS: C.BASKET_SLOTS, REMAINS_SLOTS: C.REMAINS_SLOTS,
      MAX_CONTAINERS: C.MAX_CONTAINERS,
      FIRE_SPOTS: C.FIRE_SPOTS, MAX_FIRE_SLOTS: C.MAX_FIRE_SLOTS,
      CAMPFIRE_FUEL_START_S: C.CAMPFIRE_FUEL_START_S, CAMPFIRE_FUEL_MAX_S: C.CAMPFIRE_FUEL_MAX_S, FUEL_STICK_S: C.FUEL_STICK_S,
      FUEL_LOG_S: C.FUEL_LOG_S, RELIGHT_HOLD_S: C.RELIGHT_HOLD_S,
      STATION_RANGE: C.STATION_RANGE, STATION_WORK_RANGE: C.STATION_WORK_RANGE, MAX_CRAFT_JOBS: C.MAX_CRAFT_JOBS,
      STAT_MAX: C.STAT_MAX, BREATH_MAX_S: C.BREATH_MAX_S, BREATH_REFILL_PER_S: C.BREATH_REFILL_PER_S,
      BODY_TEMP_NORMAL: C.BODY_TEMP_NORMAL, BODY_TEMP_MIN: C.BODY_TEMP_MIN, BODY_TEMP_MAX: C.BODY_TEMP_MAX,
      SICK_MAX_S: C.SICK_MAX_S, HEAL_MAX: C.HEAL_MAX,
      FALL_SAFE_SPEED: C.FALL_SAFE_SPEED, FALL_DAMAGE_K: C.FALL_DAMAGE_K, CRUSH_DAMAGE_PER_CELL: C.CRUSH_DAMAGE_PER_CELL,
      ATTACK_REPEAT_S: C.ATTACK_REPEAT_S, DIG_TICK_S: C.DIG_TICK_S, USE_REPEAT_GAP_S: C.USE_REPEAT_GAP_S, GULP_GAP_S: C.GULP_GAP_S,
      TAP_HOLD_S: C.TAP_HOLD_S,
      PIG_HEALTH: C.PIG_HEALTH, PIG_REPOP_CHECK_S: C.PIG_REPOP_CHECK_S, PIG_REPOP_TARGET: C.PIG_REPOP_TARGET,
      PIG_REPOP_RADIUS: C.PIG_REPOP_RADIUS, PIG_REPOP_MIN: C.PIG_REPOP_MIN, PIG_REPOP_MAX: C.PIG_REPOP_MAX,
      ZOMBIE_DAMAGE: C.ZOMBIE_DAMAGE, FIRE_BURN_DAMAGE: C.FIRE_BURN_DAMAGE,
      REGROW_MEAN_S: C.REGROW_MEAN_S, MAX_REGROW_TRACKED: C.MAX_REGROW_TRACKED,
    }).toEqual({
      GEN_LATEST: 3,
      PACK_SLOTS: 27, WEAR_SLOTS: 3, BASKET_SLOTS: 18, REMAINS_SLOTS: 30, MAX_CONTAINERS: 1024,
      FIRE_SPOTS: 7, MAX_FIRE_SLOTS: 256,
      CAMPFIRE_FUEL_START_S: 300, CAMPFIRE_FUEL_MAX_S: 1200, FUEL_STICK_S: 40, FUEL_LOG_S: 300, RELIGHT_HOLD_S: 3,
      STATION_RANGE: 3, STATION_WORK_RANGE: 16, MAX_CRAFT_JOBS: 8,
      STAT_MAX: 100, BREATH_MAX_S: 20, BREATH_REFILL_PER_S: 5,
      BODY_TEMP_NORMAL: 37, BODY_TEMP_MIN: 25, BODY_TEMP_MAX: 45, SICK_MAX_S: 600, HEAL_MAX: 50,
      FALL_SAFE_SPEED: 14, FALL_DAMAGE_K: 0.1, CRUSH_DAMAGE_PER_CELL: 6,
      ATTACK_REPEAT_S: 0.55, DIG_TICK_S: 0.25, USE_REPEAT_GAP_S: 0.25, GULP_GAP_S: 0.5, TAP_HOLD_S: 4,
      PIG_HEALTH: 5, PIG_REPOP_CHECK_S: 240, PIG_REPOP_TARGET: 2, PIG_REPOP_RADIUS: 64, PIG_REPOP_MIN: 24, PIG_REPOP_MAX: 48,
      ZOMBIE_DAMAGE: 8, FIRE_BURN_DAMAGE: 4,
      REGROW_MEAN_S: 600, MAX_REGROW_TRACKED: 4096,
    });
    expect(C.HOTBAR_SIZE).toBe(9);
    expect(C.HOTBAR_SIZE).toBeLessThan(C.PACK_SLOTS);
    // The pack rosette is 6 + 12 cells around the hotbar strip; a basket is the same rosette; belongings hold pack + wear.
    expect(C.PACK_SLOTS - C.HOTBAR_SIZE).toBe(6 + 12);
    expect(C.BASKET_SLOTS).toBe(6 + 12);
    expect(C.REMAINS_SLOTS).toBe(C.PACK_SLOTS + C.WEAR_SLOTS);
    // Attacks never repeat inside a mob's invulnerability window; feeding a log beats riving it into six sticks.
    expect(C.ATTACK_REPEAT_S).toBeGreaterThan(Math.max(C.PIG_HURT_S, C.ZOMBIE_HURT_S));
    expect(C.FUEL_LOG_S).toBeGreaterThan(6 * C.FUEL_STICK_S);
    expect(C.CAMPFIRE_FUEL_START_S).toBeLessThanOrEqual(C.CAMPFIRE_FUEL_MAX_S);
    expect(C.BODY_TEMP_MIN).toBeLessThan(C.BODY_TEMP_NORMAL);
    expect(C.BODY_TEMP_NORMAL).toBeLessThan(C.BODY_TEMP_MAX);
    expect(C.PIG_REPOP_MIN).toBeLessThan(C.PIG_REPOP_MAX);
    expect(C.PIG_REPOP_MAX).toBeLessThanOrEqual(C.PIG_REPOP_RADIUS);
    expect(C.STATION_RANGE).toBeLessThan(C.STATION_WORK_RANGE);
  });
  it('has the circuit and black-hole constants of DESIGN-circuits §6.3', () => {
    const CIRCUITS = {
      CIRCUIT_TICK_S: 0.05, VOLT_UNIT: 0.0625, WIRE_OHMS: 0.0625,
      BATTERY_V: 6, BATTERY_EMPTY_V: 4.5, BATTERY_KNEE: 0.25, MAX_PILE: 4, BLASTER_V: 24, SELENIUM_MAX_V: 3,
      LAMP_MIN_V: 1.5, LAMP_FULL_V: 6, COIL_MIN_V: 2.5, IGNITER_MIN_V: 3,
      LAMP_AMPS: 1, BELL_AMPS: 1, IGNITER_AMPS: 2, COIL_AMPS: 0.5, BATTERY_CAPACITY: 3600,
      EARTH_WALK_CELLS: 8,
      IGNITER_REFIRE_S: 0.5, RELAY_DELAY_TICKS: 1, RELAY_HAND_S: 0.5, BUTTON_PULSE_S: 0.3, BUTTON_RELEASE_S: 0.1,
      BLASTER_PULSE_S: 1, BLASTER_RESET_S: 1.5,
      TIMER_MIN_S: 0.5, TIMER_MAX_S: 3600, TIMER_DEFAULT_S: 5, TIMER_PULSE_S: 1,
      RADIO_CHANNELS: 16, RADIO_BASE_M: 300, RADIO_STEP_M: 50, RADIO_DISTRESS_CH: 7, RADIO_RANGE: 160, RADIO_PULSE_S: 1,
      FUSE_CELL_S: 0.4, MAX_BURNING_FUSES: 2048, MAX_FLAME_QUEUE: 4096, KEG_DIRECT_FUSE_S: 0.25,
      MAX_FUSE_SPARK_CELLS: 16, MAX_FUSE_PUFFS_PER_TICK: 24,
      MAX_CIRCUIT_PARTS: 4096, MAX_PART_LABEL_CHARS: 24,
      MAX_CIRCUIT_VISITS_PER_TICK: 6000, CIRCUIT_TICK_BUDGET_MS: 2, MAX_NETWORK_CELLS: 8192,
      MAX_CONTACT_CHANGES_PER_TICK: 1024, MAX_SETTLE_PASSES: 4,
      MAX_CIRCUIT_WRITES_PER_TICK: 32, MAX_IGNITIONS_PER_TICK: 32,
      CIRCUIT_DRAW_RANGE: 64, CIRCUIT_OVERLAY_RANGE: 64, MAX_CIRCUIT_OVERLAYS: 512,
    };
    const HOLES = {
      BLACK_HOLE_ARM_S: 0.4, BLACK_HOLE_FLASH_S: 0.3, BLACK_HOLE_IMPLODE_S: 1.2,
      BLACK_HOLE_SWIRL: 1.6, BLACK_HOLE_SWIRL_CORE: 1.5,
      BLACK_HOLE_FLASH_INTENSITY: 220, BLACK_HOLE_FLASH_COLOR: 0xfff4e6,
      BLACK_HOLE_SCREEN_FLASH_RANGE: 48, BLACK_HOLE_SCREEN_FLASH_S: 0.6,
      BLACK_HOLE_SCREEN_FLASH_MAX: 0.75, BLACK_HOLE_SCREEN_FLASH_GAP_S: 0.5,
      BLACK_HOLE_PINCH_DEG: 8, BLACK_HOLE_PINCH_RANGE: 24, BLACK_HOLE_STRETCH_DEG: 4,
      VORTEX_MODEL_RANGE: 128, VORTEX_MAX_MODELS: 16, VORTEX_MAX_CORES: 256,
      VORTEX_PARTICLES_PER_S: 40, VORTEX_PARTICLE_HOLES: 4,
      VORTEX_SPIRAL_K: 3.33, VORTEX_INFLOW: 1.2, VORTEX_FLOW_RATE: 9,
      VORTEX_BILLBOARD: 3.6, VORTEX_CORE_R: 0.3, VORTEX_EVENT_R: 0.45,
      MAX_INFALL_BLOCKS: 96, MAX_INFALL_MOBS: 8, INFALL_VIEW_RANGE: 48,
      INFALL_MIN_S: 0.6, INFALL_MAX_S: 2.4, INFALL_MOB_S: 1.2,
    };
    for (const table of [CIRCUITS, HOLES]) {
      expect(Object.fromEntries(Object.keys(table).map((k) => [k, C[k]]))).toEqual(table);
    }
    // Volts are whole VOLT_UNITs: a wire cell drops one unit per amp, and every source, threshold and battery voltage is a
    // whole number of units (the solver's bucket queue, §4.7).
    expect(C.WIRE_OHMS).toBe(C.VOLT_UNIT);
    for (const v of [C.BATTERY_V, C.BATTERY_EMPTY_V, C.BLASTER_V, C.SELENIUM_MAX_V, C.LAMP_MIN_V, C.LAMP_FULL_V, C.COIL_MIN_V, C.IGNITER_MIN_V]) {
      expect(Number.isInteger(v / C.VOLT_UNIT), String(v)).toBe(true);
    }
    // A pile of MAX_PILE batteries is the blasting machine's 24 V; the knee leaves 4.5 V just before empty.
    expect(C.MAX_PILE * C.BATTERY_V).toBe(C.BLASTER_V);
    expect(C.BATTERY_V * (1 - C.BATTERY_KNEE)).toBe(C.BATTERY_EMPTY_V);
    // 16 wavelengths from 300 m to 1050 m; the distress channel is 600 m.
    expect(C.RADIO_BASE_M + C.RADIO_STEP_M * (C.RADIO_CHANNELS - 1)).toBe(1050);
    expect(C.RADIO_BASE_M + C.RADIO_STEP_M * (C.RADIO_DISTRESS_CH - 1)).toBe(600);
    // A fuse burns at 2.5 cells/s; the ARM + FLASH + IMPLODE sequence takes 1.9 s; timer delays come in 0.5 s steps.
    expect(1 / C.FUSE_CELL_S).toBeCloseTo(2.5, 12);
    expect(C.BLACK_HOLE_ARM_S + C.BLACK_HOLE_FLASH_S + C.BLACK_HOLE_IMPLODE_S).toBeCloseTo(1.9, 12);
    expect(C.TIMER_DEFAULT_S >= C.TIMER_MIN_S && C.TIMER_DEFAULT_S <= C.TIMER_MAX_S).toBe(true);
    // One spiral everywhere: the disk, the particles and the infall share dθ/d ln ρ = 4 / 1.2 (§2.4).
    expect(C.VORTEX_SPIRAL_K).toBeCloseTo(4 / C.VORTEX_INFLOW, 2);
    expect(C.INFALL_MIN_S).toBeLessThan(C.INFALL_MAX_S);
  });
  it('every version string matches VERSION (F3, console, debug handle, title footer, package files)', () => {
    // Regression: v0.4–v0.7 shipped as "v0.2.0" in F3 and "v0.3" on the title screen because only some were bumped.
    const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const pkg = JSON.parse(read('../../package.json'));
    const lock = JSON.parse(read('../../package-lock.json'));
    expect(pkg.version).toBe(C.VERSION);
    expect(lock.version).toBe(C.VERSION);
    expect(lock.packages[''].version).toBe(C.VERSION);
    const [major, minor] = C.VERSION.split('.');
    const footer = /<div id="title-footer">Caelancraft v([0-9.]+) ·/.exec(read('../../index.html'));
    expect(footer && footer[1]).toBe(`${major}.${minor}`);
    expect(read('../../src/CONTRACTS.md')).toContain(`\`VERSION = '${C.VERSION}'\``);
  });
});

describe('coords', () => {
  it('floor-divides and mods negatives', () => {
    expect(floorDiv(-1, 16)).toBe(-1);
    expect(mod(-1, 16)).toBe(15);
    expect(worldToChunk(-1)).toBe(-1);
    expect(worldToChunk(-17)).toBe(-2);
    expect(worldToLocal(-1)).toBe(15);
    expect(worldToLocal(-17)).toBe(15);
    expect(worldToChunk(16)).toBe(1);
    expect(worldToLocal(16)).toBe(0);
  });
  it('round-trips chunk keys', () => {
    expect(chunkKey(-3, 7)).toBe('-3,7');
    expect(parseChunkKey('-3,7')).toEqual([-3, 7]);
    expect(parseChunkKey('0,0')).toEqual([0, 0]);
    expect(parseChunkKey(chunkKey(-0, 12))).toEqual([0, 12]);
    // Strict inverse: anything chunkKey could not have produced is [NaN, NaN], never a silent (0, 0).
    for (const bad of ['', '0', ',', ' , ', '3,', ',1', ' 1,2', '1,2 ', '1,2,3', '1.5,2', '1e3,2', '0x10,2', '+1,2', 'a,b', '--1,2', '1,-']) {
      const [cq, cr] = parseChunkKey(bad);
      expect(Number.isNaN(cq), bad).toBe(true);
      expect(Number.isNaN(cr), bad).toBe(true);
    }
  });
  it('localIndex is a bijection with the documented strides', () => {
    expect(localIndex(0, 1, 0)).toBe(1);
    expect(localIndex(0, 0, 1)).toBe(128);
    expect(localIndex(1, 0, 0)).toBe(16 * 128);
    const seen = new Uint8Array(C.CHUNK_VOLUME);
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) for (let ly = 0; ly < 128; ly++) {
      const i = localIndex(lx, ly, lz);
      expect(seen[i]).toBe(0);
      seen[i] = 1;
      expect(indexToLocal(i)).toEqual([lx, ly, lz]);
    }
    expect(columnIndex(3, 5)).toBe(3 * 16 + 5);
  });
  it('no longer carries the cube face tables (they live in hex.js)', () => {
    for (const name of ['FACE_NORMALS', 'FACE_VERTS', 'FACE_TANGENTS', 'FACE_AXIS', 'FACE_OPPOSITE', 'FACE_NAMES']) {
      expect(coords[name], name).toBeUndefined();
    }
  });
  it('inHeightRange covers exactly 0..WORLD_HEIGHT-1', () => {
    expect(inHeightRange(0)).toBe(true);
    expect(inHeightRange(C.WORLD_HEIGHT - 1)).toBe(true);
    expect(inHeightRange(-1)).toBe(false);
    expect(inHeightRange(C.WORLD_HEIGHT)).toBe(false);
    expect(inHeightRange(NaN)).toBe(false);
  });
  it('orientation conventions: yaw 0 faces -Z, positive yaw turns left', () => {
    const [fx, fz] = yawToForward(0);
    expect(fx).toBeCloseTo(0);
    expect(fz).toBeCloseTo(-1);
    const [rx, rz] = yawToRight(0);
    expect(rx).toBeCloseTo(1);
    expect(rz).toBeCloseTo(0);
    const [lx] = yawToForward(Math.PI / 2);
    expect(lx).toBeCloseTo(-1);
    const d = lookDirection(0, Math.PI / 2);
    expect(d[1]).toBeCloseTo(1);
  });
});

describe('blocks', () => {
  it('ids are contiguous and names unique', () => {
    expect(BLOCKS.length).toBe(BLOCK_COUNT);
    const names = new Set();
    BLOCKS.forEach((b, i) => {
      expect(b.id).toBe(i);
      expect(names.has(b.name)).toBe(false);
      names.add(b.name);
      expect(BLOCK[b.name.toUpperCase()]).toBe(i);
      expect(b.tiles).toHaveLength(FACE_COUNT);
    });
  });
  it('re-exports the hex top/bottom face indices', () => {
    expect(FACE_TOP).toBe(HEX_FACE_TOP);
    expect(FACE_BOTTOM).toBe(HEX_FACE_BOTTOM);
    expect(FACE_TOP).toBe(6);
    expect(FACE_BOTTOM).toBe(7);
  });
  it('every non-air block resolves 8 valid tiles: six identical sides, a top and a bottom', () => {
    const tileSet = new Set(TILE_IDS);
    for (let id = 1; id < BLOCK_COUNT; id++) {
      for (let f = 0; f < FACE_COUNT; f++) {
        const t = getFaceTile(id, f);
        expect(tileSet.has(t)).toBe(true);
        expect(t).not.toBe(TILE.MISSING);
      }
      for (let f = 1; f < 6; f++) expect(getFaceTile(id, f)).toBe(getFaceTile(id, 0));
    }
    expect(getFaceTile(BLOCK.GRASS_BLOCK, FACE_TOP)).toBe(TILE.GRASS_TOP);
    expect(getFaceTile(BLOCK.GRASS_BLOCK, FACE_BOTTOM)).toBe(TILE.DIRT);
    expect(getFaceTile(BLOCK.GRASS_BLOCK, 0)).toBe(TILE.GRASS_SIDE);
    expect(getFaceTile(BLOCK.GRASS_BLOCK, 5)).toBe(TILE.GRASS_SIDE);
    expect(getFaceTile(BLOCK.OAK_LOG, FACE_TOP)).toBe(TILE.OAK_LOG_END);
    expect(getFaceTile(BLOCK.OAK_LOG, FACE_BOTTOM)).toBe(TILE.OAK_LOG_END);
    expect(getFaceTile(BLOCK.OAK_LOG, 3)).toBe(TILE.OAK_LOG_SIDE);
    expect(getFaceTile(BLOCK.SNOWY_GRASS, FACE_TOP)).toBe(TILE.SNOW);
    expect(getFaceTile(BLOCK.SNOWY_GRASS, FACE_BOTTOM)).toBe(TILE.DIRT);
    // Out-of-range faces and unknown ids fall back to MISSING / AIR.
    expect(getFaceTile(BLOCK.STONE, 8)).toBe(TILE.MISSING);
    expect(getFaceTile(200, 0)).toBe(TILE.MISSING);
  });
  it('RUNE_BLOCK (25) is a solid, opaque, placeable, breakable stone-sounding block with the RUNE tile on all 8 faces', () => {
    expect(BLOCK.RUNE_BLOCK).toBe(25);
    expect(TILE.RUNE).toBe(27);
    expect(TILE_IDS).toContain(TILE.RUNE);
    const def = BLOCKS[BLOCK.RUNE_BLOCK];
    expect(def.name).toBe('rune_block');
    expect(def.displayName).toBe('Rune Block');
    expect(def.solid).toBe(true);
    expect(def.opaque).toBe(true);
    expect(def.liquid).toBe(false);
    expect(isSolid(BLOCK.RUNE_BLOCK)).toBe(true);
    expect(isOpaque(BLOCK.RUNE_BLOCK)).toBe(true);
    expect(isPlaceable(BLOCK.RUNE_BLOCK)).toBe(true);
    expect(isBreakable(BLOCK.RUNE_BLOCK)).toBe(true);
    expect(isTargetable(BLOCK.RUNE_BLOCK)).toBe(true);
    expect(isReplaceable(BLOCK.RUNE_BLOCK)).toBe(false);
    expect(def.layer).toBe(LAYER_OPAQUE);
    expect(def.soundGroup).toBe('stone');
    for (let f = 0; f < FACE_COUNT; f++) expect(getFaceTile(BLOCK.RUNE_BLOCK, f)).toBe(TILE.RUNE);
    // Picker: the rune block listed right before water, which is last.
    const iRune = PICKER_ORDER.indexOf(BLOCK.RUNE_BLOCK);
    expect(iRune).toBeGreaterThanOrEqual(0);
    expect(PICKER_ORDER[iRune + 1]).toBe(BLOCK.WATER);
    expect(PICKER_ORDER[PICKER_ORDER.length - 1]).toBe(BLOCK.WATER);
    // Not in the default hotbar.
    expect(DEFAULT_HOTBAR).not.toContain(BLOCK.RUNE_BLOCK);
  });
  it('v0.4 batch: 40 blocks appended after RUNE_BLOCK (v2 save ids unchanged), every placeable block in the picker once', () => {
    // v0.8 appended 68..75 (see the block-physics test below), v0.9 survival 76..94, powder and circuits 95..114, v0.11 the Workbench 115
    expect(BLOCK_COUNT).toBe(120); // … the three snares 116–118 and Flinty Gravel 119 (§75)
    // + 6 zombie part tiles 240–245 (§39), + 3 Watcher tiles 250–252 (§40: stone, crack glow, smoke), not block faces;
    // v0.9 survival + 28 (77–104); powder and circuits + 35 (160–194)
    expect(TILE_IDS).toHaveLength(159); // v0.11: + the Workbench 195, 196; v0.13: + 201–203 (§75; 204 withdrawn in §76)
    expect(BLOCK.BLACK_HOLE).toBe(66);
    expect(TILE.BLACK_HOLE).toBe(72);
    expect(BLOCK.STONE).toBe(1);
    expect(BLOCK.WOOL_RED).toBe(24);
    expect(BLOCK.SPRUCE_LOG).toBe(26);
    expect(BLOCK.WOOL_LIGHT_GRAY).toBe(65);
    expect(TILE.SPRUCE_LOG_SIDE).toBe(28);
    expect(TILE.WOOL_LIGHT_GRAY).toBe(71);
    const placeable = BLOCKS.filter((b) => b.placeable).map((b) => b.id).sort((a, b) => a - b);
    expect(PICKER_ORDER).toHaveLength(101); // 67 before the v0.9 survival blocks, 80 before powder and circuits, 99 before the Workbench
    expect(new Set(PICKER_ORDER).size).toBe(PICKER_ORDER.length);
    expect([...PICKER_ORDER].sort((a, b) => a - b)).toEqual(placeable);
    // Logs and hay bales: distinct end tiles on top and bottom.
    expect(getFaceTile(BLOCK.SPRUCE_LOG, FACE_TOP)).toBe(TILE.SPRUCE_LOG_END);
    expect(getFaceTile(BLOCK.BIRCH_LOG, FACE_BOTTOM)).toBe(TILE.BIRCH_LOG_END);
    expect(getFaceTile(BLOCK.HAY_BALE, 0)).toBe(TILE.HAY_BALE_SIDE);
    expect(getFaceTile(BLOCK.PUMPKIN, FACE_TOP)).toBe(TILE.PUMPKIN_TOP);
    // Leaves are cutout like oak; ice is a solid, see-through, translucent block that culls against itself.
    for (const id of [BLOCK.SPRUCE_LEAVES, BLOCK.BIRCH_LEAVES]) {
      expect(BLOCKS[id].layer).toBe(LAYER_CUTOUT);
      expect(BLOCKS[id].cullSame).toBe(false);
      expect(isOpaque(id)).toBe(false);
    }
    expect(isSolid(BLOCK.ICE)).toBe(true);
    expect(isOpaque(BLOCK.ICE)).toBe(false);
    expect(BLOCKS[BLOCK.ICE].layer).toBe(LAYER_TRANSLUCENT);
    expect(shouldRenderFace(BLOCK.ICE, BLOCK.ICE)).toBe(false);
    expect(shouldRenderFace(BLOCK.STONE, BLOCK.ICE)).toBe(true);
    expect(isOpaque(BLOCK.PACKED_ICE)).toBe(true);
    // Every new block is a normal solid, breakable, placeable block with a known sound group.
    for (let id = BLOCK.SPRUCE_LOG; id <= BLOCK.WOOL_LIGHT_GRAY; id++) {
      const d = BLOCKS[id];
      expect(d.solid && d.breakable && d.placeable && !d.liquid, d.name).toBe(true);
      expect(SOUND_GROUPS).toContain(d.soundGroup);
    }
    expect(BLOCKS[BLOCK.WOOL_LIGHT_BLUE].displayName).toBe('Light Blue Wool');
    expect(DEFAULT_HOTBAR.every((id) => id < BLOCK.RUNE_BLOCK)).toBe(true);
  });
  it('v0.8 block physics: water levels 68..74, the keg (once "blast barrel") 75, gravity flag, fall-through, UNLOADED', () => {
    expect(BLOCK.BLAST_BARREL).toBe(75);
    expect(BLOCK.POWDER_KEG).toBe(75); // DESIGN-circuits §1.1: the canonical key; BLAST_BARREL is its deprecated alias
    expect([BLOCK.WATER_FLOW_1, BLOCK.WATER_FLOW_6, BLOCK.WATER_FALL, BLOCK.BLAST_BARREL]).toEqual([68, 73, 74, 75]);
    expect([TILE.BARREL_SIDE, TILE.BARREL_TOP]).toEqual([75, 76]);
    for (let id = BLOCK.WATER_FLOW_1; id <= BLOCK.WATER_FALL; id++) {
      const d = BLOCKS[id];
      expect(d.liquid && !d.solid && !d.opaque && !d.breakable && !d.placeable, d.name).toBe(true);
      expect(d.layer).toBe(LAYER_TRANSLUCENT);
      for (let f = 0; f < FACE_COUNT; f++) expect(getFaceTile(id, f)).toBe(TILE.WATER);
      expect(isReplaceable(id)).toBe(true);
      expect(isTargetable(id)).toBe(false);
      expect(PICKER_ORDER).not.toContain(id);
    }
    expect([0, 1, 2, 3, 4, 5, 6].map((k) => (k === 0 ? waterLevel(BLOCK.WATER) : waterLevel(BLOCK.WATER_FLOW_1 + k - 1))))
      .toEqual([7, 1, 2, 3, 4, 5, 6]);
    expect(waterLevel(BLOCK.WATER_FALL)).toBe(7);
    expect(waterLevel(BLOCK.STONE)).toBe(0);
    expect(isWater(BLOCK.WATER) && isWater(BLOCK.WATER_FLOW_3) && isWater(BLOCK.WATER_FALL)).toBe(true);
    expect(isWater(BLOCK.ICE) || isWater(BLOCK.AIR)).toBe(false);
    expect(isWaterSource(BLOCK.WATER)).toBe(true);
    expect(isWaterSource(BLOCK.WATER_FALL)).toBe(false);
    // The keg: a plain solid, placeable, breakable, wood-sounding block in the picker's special group. Renamed from
    // "Blast Barrel" (DESIGN-circuits §1.1); saves store the id, and BLOCK_ALIASES keeps the old name resolving.
    const barrel = BLOCKS[BLOCK.BLAST_BARREL];
    expect(barrel.name).toBe('powder_keg');
    expect(barrel.displayName).toBe('Powder Keg');
    expect(BLOCK_ALIASES.blast_barrel).toBe(BLOCK.POWDER_KEG);
    expect(barrel.solid && barrel.opaque && barrel.placeable && barrel.breakable).toBe(true);
    expect(barrel.soundGroup).toBe('wood');
    expect(getFaceTile(BLOCK.BLAST_BARREL, 0)).toBe(TILE.BARREL_SIDE);
    expect(getFaceTile(BLOCK.BLAST_BARREL, FACE_TOP)).toBe(TILE.BARREL_TOP);
    expect(getFaceTile(BLOCK.BLAST_BARREL, FACE_BOTTOM)).toBe(TILE.BARREL_TOP);
    expect(PICKER_ORDER.indexOf(BLOCK.BLAST_BARREL)).toBe(PICKER_ORDER.indexOf(BLOCK.CAMPFIRE) + 1);
    // Gravity and fall-through.
    expect(BLOCKS.filter((d) => d.gravity).map((d) => d.id).sort((a, c) => a - c)).toEqual([BLOCK.SAND, BLOCK.GRAVEL, BLOCK.RED_SAND, BLOCK.FLINT_GRAVEL]);
    expect(isGravityBlock(BLOCK.SAND)).toBe(true);
    expect(isGravityBlock(BLOCK.SANDSTONE)).toBe(false);
    const through = BLOCKS.filter((d) => isFallThrough(d.id)).map((d) => d.id);
    expect(through).toEqual([BLOCK.AIR, BLOCK.WATER, BLOCK.CAMPFIRE, 68, 69, 70, 71, 72, 73, 74]);
    expect(isFallThrough(BLOCK.WATER)).toBe(true); // v0.8 water (CONTRACTS §35.6): sand sinks through sources too
    expect(UNLOADED).toBe(255);
    expect(BLOCKS[UNLOADED]).toBeUndefined();
    expect(isFallThrough(UNLOADED) || isSolid(UNLOADED) || isWater(UNLOADED)).toBe(false);
    expect(isLeaves(BLOCK.BIRCH_LEAVES) && isLog(BLOCK.SPRUCE_LOG)).toBe(true);
    expect(isLeaves(BLOCK.OAK_LOG) || isLog(BLOCK.OAK_PLANKS)).toBe(false);
  });
  it('v0.9 survival: blocks 76..94 exactly as DESIGN-survival §8.1, tiles 77..104 (powder and circuits follow at 95)', () => {
    expect(BLOCK_COUNT).toBe(120); // 95 after survival; DESIGN-circuits §1.3 appends 95..114; v0.11 the Workbench 115, the snares 116–118; v0.13 Flinty Gravel 119
    expect(BLOCKS).toHaveLength(120);
    const P = 'plant'; // the PLANT flags: walk-through, see-through cutout, never culled against itself
    const S = 'solid'; // a plain full block (def defaults)
    // [key, id, name, displayName, flags, soundGroup, [side, top, bottom] TILE keys, placeable]
    const TABLE = [
      ['COPPER_ORE', 76, 'copper_ore', 'Copper Ore', S, 'stone', ['COPPER_ORE', 'COPPER_ORE', 'COPPER_ORE'], true],
      ['TIN_ORE', 77, 'tin_ore', 'Tin Ore', S, 'stone', ['TIN_ORE', 'TIN_ORE', 'TIN_ORE'], true],
      ['HONEYBERRY_BUSH', 78, 'honeyberry_bush', 'Honeyberry Bush', P, 'leaves', ['HONEYBERRY_BUSH', 'HONEYBERRY_BUSH', 'HONEYBERRY_BUSH'], true],
      ['HONEYBERRY_BUSH_BARE', 79, 'honeyberry_bush_bare', 'Picked Honeyberry Bush', P, 'leaves',
        ['HONEYBERRY_BUSH_BARE', 'HONEYBERRY_BUSH_BARE', 'HONEYBERRY_BUSH_BARE'], false],
      ['TUSSOCK', 80, 'tussock', 'Tussock Grass', P, 'grass', ['TUSSOCK', 'TUSSOCK', 'TUSSOCK'], true],
      ['CATTAILS', 81, 'cattails', 'Cattails', P, 'grass', ['CATTAILS_SIDE', 'CATTAILS_SIDE', 'CATTAILS_SIDE'], true],
      ['TUBER_PLANT', 82, 'tuber_plant', 'Wild Tuber Plant', P, 'grass', ['TUBER_PLANT', 'TUBER_PLANT', 'TUBER_PLANT'], true],
      ['PRICKLY_PEAR', 83, 'prickly_pear', 'Prickly Pear', P, 'leaves', ['PRICKLY_PEAR', 'PRICKLY_PEAR', 'PRICKLY_PEAR'], true],
      ['PRICKLY_PEAR_BARE', 84, 'prickly_pear_bare', 'Picked Prickly Pear', P, 'leaves',
        ['PRICKLY_PEAR_BARE', 'PRICKLY_PEAR_BARE', 'PRICKLY_PEAR_BARE'], false],
      ['WORK_STUMP', 85, 'work_stump', 'Work Stump', S, 'wood', ['STUMP_SIDE', 'STUMP_TOP', 'OAK_LOG_END'], true],
      ['KILN', 86, 'kiln', 'Kiln', S, 'stone', ['KILN_SIDE', 'KILN_TOP', 'KILN_TOP'], true],
      ['BLOOMERY', 87, 'bloomery', 'Bloomery', S, 'stone', ['BLOOMERY_SIDE', 'BLOOMERY_TOP', 'BLOOMERY_TOP'], true],
      ['FORGE', 88, 'forge', 'Forge', S, 'stone', ['FORGE_SIDE', 'FORGE_TOP', 'FORGE_TOP'], true],
      ['WICKER_BASKET', 89, 'wicker_basket', 'Wicker Basket', S, 'wood', ['BASKET_SIDE', 'BASKET_TOP', 'BASKET_TOP'], true],
      ['SLEEPING_HIDE', 90, 'sleeping_hide', 'Sleeping Hide', S, 'cloth', ['HIDE_SIDE', 'HIDE_TOP', 'HIDE_TOP'], true],
      ['REMAINS', 91, 'remains', 'Your Belongings', P, 'cloth', ['REMAINS_SIDE', 'REMAINS_TOP', 'REMAINS_TOP'], false],
      ['LOOSE_STONES', 92, 'loose_stones', 'Loose Stones', P, 'stone', ['LOOSE_STONES', 'LOOSE_STONES', 'LOOSE_STONES'], false],
      ['FALLEN_BRANCHES', 93, 'fallen_branches', 'Fallen Branches', P, 'wood',
        ['FALLEN_BRANCHES', 'FALLEN_BRANCHES', 'FALLEN_BRANCHES'], false],
      ['FIRE_PIT', 94, 'fire_pit', 'Cold Fire Pit', P, 'stone', ['FIRE_PIT_SIDE', 'PLANT_TOP_CLEAR', 'PLANT_TOP_CLEAR'], false],
    ];
    expect(TABLE.map((row) => row[1])).toEqual(Array.from({ length: 19 }, (_, i) => 76 + i));
    for (const [key, id, name, displayName, flags, sound, [side, top, bottom], placeable] of TABLE) {
      expect(BLOCK[key], key).toBe(id);
      const d = BLOCKS[id];
      expect([d.id, d.name, d.displayName, d.soundGroup, d.placeable], key).toEqual([id, name, displayName, sound, placeable]);
      expect(SOUND_GROUPS).toContain(d.soundGroup);
      expect(d.breakable && !d.liquid && d.meshed && !d.gravity, key).toBe(true);
      if (flags === P) {
        expect([d.solid, d.opaque, d.layer, d.cullSame], key).toEqual([false, false, LAYER_CUTOUT, false]);
        expect(shouldRenderFace(id, id), key).toBe(true); // a bush beside a bush draws both faces
        expect(shouldRenderFace(BLOCK.STONE, id), key).toBe(true); // and never hides the stone behind it
      } else {
        expect([d.solid, d.opaque, d.layer, d.cullSame], key).toEqual([true, true, LAYER_OPAQUE, true]);
      }
      // Walk-through or not, none of them is replaceable (break it first), fall-through (sand rests on it) or untargetable.
      expect(isReplaceable(id) || isFallThrough(id) || !isTargetable(id), key).toBe(false);
      for (let f = 0; f < 6; f++) expect(getFaceTile(id, f), `${key} side ${f}`).toBe(TILE[side]);
      expect(getFaceTile(id, FACE_TOP), key).toBe(TILE[top]);
      expect(getFaceTile(id, FACE_BOTTOM), key).toBe(TILE[bottom]);
      expect(PICKER_ORDER.includes(id), key).toBe(placeable);
    }
    // Tiles 77..104 (§8.1), contiguous after BARREL_TOP 76.
    const TILES = [
      'COPPER_ORE', 'TIN_ORE', 'HONEYBERRY_BUSH', 'HONEYBERRY_BUSH_BARE', 'TUSSOCK', 'CATTAILS_SIDE', 'CATTAILS_TOP', 'TUBER_PLANT',
      'PRICKLY_PEAR', 'PRICKLY_PEAR_BARE', 'STUMP_SIDE', 'STUMP_TOP', 'KILN_SIDE', 'KILN_TOP', 'BLOOMERY_SIDE', 'BLOOMERY_TOP',
      'FORGE_SIDE', 'FORGE_TOP', 'BASKET_SIDE', 'BASKET_TOP', 'HIDE_SIDE', 'HIDE_TOP', 'REMAINS_SIDE', 'REMAINS_TOP',
      'PLANT_TOP_CLEAR', 'LOOSE_STONES', 'FALLEN_BRANCHES', 'FIRE_PIT_SIDE',
    ];
    TILES.forEach((key, i) => expect(TILE[key], key).toBe(77 + i));
    expect(TILE_IDS).toHaveLength(159); // 115 after survival; + the 35 circuit tiles 160..194; + the Workbench 195, 196; + 201–203 (§75)
    expect(new Set(TILE_IDS).size).toBe(TILE_IDS.length);
    // Every survival tile is used by a block face — except CATTAILS_TOP: the cattails became a crossed sprite drawn from
    // CATTAILS_SIDE, and tile ids are fixed, so 83 stays painted but no face names it.
    const used = new Set(BLOCKS.flatMap((d) => d.tiles));
    for (const key of TILES) expect(used.has(TILE[key]), key).toBe(key !== 'CATTAILS_TOP');
  });

  it('v0.9 survival: PICKER_ORDER inserts the 13 placeable blocks into their groups; WATER last, RUNE_BLOCK before it', () => {
    expect(PICKER_ORDER).toHaveLength(101); // 80 after survival; DESIGN-circuits §1.5: − BLACK_HOLE + the 20 circuit blocks; + the Workbench
    expect(PICKER_ORDER[PICKER_ORDER.length - 1]).toBe(BLOCK.WATER);
    expect(PICKER_ORDER[PICKER_ORDER.length - 2]).toBe(BLOCK.RUNE_BLOCK);
    const after = (id, ids) => {
      const i = PICKER_ORDER.indexOf(id);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(PICKER_ORDER.slice(i + 1, i + 1 + ids.length)).toEqual(ids);
    };
    after(BLOCK.DIAMOND_ORE, [BLOCK.COPPER_ORE, BLOCK.TIN_ORE, BLOCK.COAL_BLOCK]);
    after(BLOCK.PUMPKIN, [BLOCK.TUSSOCK, BLOCK.CATTAILS, BLOCK.TUBER_PLANT, BLOCK.HONEYBERRY_BUSH, BLOCK.PRICKLY_PEAR, BLOCK.OAK_LOG]);
    // The keg follows the campfire; the circuit blocks (tested below) follow it; the Black Hole is gone (DESIGN-circuits §1.5).
    after(BLOCK.WOOL_PINK, [
      BLOCK.WORK_STUMP, BLOCK.KILN, BLOCK.BLOOMERY, BLOCK.FORGE, BLOCK.WORKBENCH, BLOCK.WICKER_BASKET, BLOCK.SLEEPING_HIDE, BLOCK.SNARE, BLOCK.CAMPFIRE,
      BLOCK.POWDER_KEG, BLOCK.COLLAPSAR_CHARGE,
    ]);
    const placeable = BLOCKS.filter((b) => b.placeable).map((b) => b.id).sort((a, b) => a - b);
    expect([...PICKER_ORDER].sort((a, b) => a - b)).toEqual(placeable);
    expect(BLOCKS.filter((b) => b.id >= 76 && b.id <= 94 && b.placeable)).toHaveLength(13);
    expect(DEFAULT_HOTBAR.every((id) => id < BLOCK.RUNE_BLOCK)).toBe(true); // Creative's default hotbar is unchanged
  });

  it('v0.9 survival predicates: isPlant, isLitter, isPopOff, isStation, isContainerBlock and their id lists', () => {
    const B = BLOCK;
    expect(PLANT_IDS).toEqual([78, 79, 80, 81, 82, 83, 84]);
    expect(POP_OFF_IDS).toEqual([B.CAMPFIRE, ...PLANT_IDS, B.LOOSE_STONES, B.FALLEN_BRANCHES, B.FIRE_PIT]);
    expect(POP_OFF_IDS).toHaveLength(11);
    expect(Object.isFrozen(PLANT_IDS) && Object.isFrozen(POP_OFF_IDS)).toBe(true);
    // Each predicate over every byte value (and the UNLOADED sentinel) is exactly its list.
    const all = Array.from({ length: 256 }, (_, i) => i);
    expect(all.filter(isPlant)).toEqual([...PLANT_IDS]);
    expect(all.filter(isLitter)).toEqual([B.LOOSE_STONES, B.FALLEN_BRANCHES]);
    expect(all.filter(isPopOff)).toEqual([...POP_OFF_IDS]);
    expect(all.filter(isStation)).toEqual([B.WORK_STUMP, B.KILN, B.BLOOMERY, B.FORGE, B.WORKBENCH]);
    expect(all.filter(isContainerBlock)).toEqual([B.WICKER_BASKET, B.REMAINS]);
    for (const f of [isPlant, isLitter, isPopOff, isStation, isContainerBlock]) {
      expect(f(UNLOADED) || f(-1) || f(NaN) || f(undefined), f.name).toBe(false);
    }
    // The plants carry the PLANT flags; the PLANT-flagged non-plants are belongings, litter and the fire pit. (The thin
    // circuit parts share those flags but are unmeshed: DESIGN-circuits §1.2 "THIN", tested below.)
    const plantFlagged = BLOCKS.filter((d) => d.layer === LAYER_CUTOUT && !d.solid && !d.cullSame && d.meshed).map((d) => d.id);
    expect(plantFlagged).toEqual([...PLANT_IDS, B.REMAINS, B.LOOSE_STONES, B.FALLEN_BRANCHES, B.FIRE_PIT, B.SNARE, B.SNARE_BAITED, B.SNARE_SPRUNG]);
    // FIRE_PIT is a meshed cutout block. Only CAMPFIRE, the Black Hole and the circuit parts but the keg (the thin parts and
    // the 14 device models) have their own models, and only CAMPFIRE is fall-through.
    expect(BLOCKS.filter((d) => !d.meshed).map((d) => d.id)).toEqual([
      B.BLACK_HOLE, B.CAMPFIRE, ...Array.from({ length: 20 }, (_, i) => B.COLLAPSAR_CHARGE + i),
    ]);
    expect(isFallThrough(B.FIRE_PIT) || isFallThrough(B.TUSSOCK) || isFallThrough(B.REMAINS)).toBe(false);
  });

  // DESIGN-circuits §1.2–§1.4 (final ids, §1.3: BLOCK_COUNT 95 after survival + working id − 140). The user named the
  // design's Linstock a Torch: key TORCH, name torch, display name "Torch", tile 164 TORCH. The design's 14 "CAB" cabinets
  // are 3D models since the user's "fun and simple" redo: shape MODEL below.
  const CIRCUIT_BLOCKS = [
    // [BLOCK key, id, name, displayName, shape, soundGroup, [side, top] TILE keys] (bottom = top; THIN: CIRCUIT_CLEAR)
    ['COLLAPSAR_CHARGE', 95, 'collapsar_charge', 'Collapsar Charge', 'MODEL', 'glass', ['COLLAPSAR_SIDE', 'COLLAPSAR_TOP']],
    ['POWDER_FUSE', 96, 'powder_fuse', 'Powder Fuse', 'THIN', 'cloth', ['CIRCUIT_CLEAR', 'POWDER_FUSE']],
    ['TORCH', 97, 'torch', 'Torch', 'THIN', 'wood', ['CIRCUIT_CLEAR', 'TORCH']],
    ['COPPER_WIRE', 98, 'copper_wire', 'Copper Wire', 'THIN', 'cloth', ['CIRCUIT_CLEAR', 'COPPER_WIRE']],
    ['BROWN_WIRE', 99, 'brown_wire', 'Brown Wire', 'THIN', 'cloth', ['CIRCUIT_CLEAR', 'BROWN_WIRE']],
    ['WHITE_WIRE', 100, 'white_wire', 'White Wire', 'THIN', 'cloth', ['CIRCUIT_CLEAR', 'WHITE_WIRE']],
    ['EARTH_WIRE', 101, 'earth_wire', 'Earth Wire', 'THIN', 'cloth', ['CIRCUIT_CLEAR', 'EARTH_WIRE']],
    ['TERMINAL_BOARD', 102, 'terminal_board', 'Terminal Board', 'MODEL', 'wood', ['TERMINAL_SIDE', 'TERMINAL_TOP']],
    ['VOLTAIC_BATTERY', 103, 'voltaic_battery', 'Voltaic Battery', 'MODEL', 'wood', ['BATTERY_SIDE', 'BATTERY_TOP']],
    ['BLASTING_MACHINE', 104, 'blasting_machine', 'Blasting Machine', 'MODEL', 'wood', ['BLASTER_SIDE', 'BLASTER_TOP']],
    ['SELENIUM_PANEL', 105, 'selenium_panel', 'Selenium Panel', 'MODEL', 'glass', ['SELENIUM_SIDE', 'SELENIUM_TOP']],
    ['KNIFE_SWITCH', 106, 'knife_switch', 'Knife Switch', 'MODEL', 'stone', ['SWITCH_SIDE', 'SWITCH_TOP']],
    ['PUSH_BUTTON', 107, 'push_button', 'Push Button', 'MODEL', 'stone', ['BUTTON_SIDE', 'BUTTON_TOP']],
    ['CLOCKWORK_TIMER', 108, 'clockwork_timer', 'Clockwork Timer', 'MODEL', 'wood', ['TIMER_SIDE', 'TIMER_TOP']],
    ['RELAY', 109, 'relay', 'Relay', 'MODEL', 'wood', ['RELAY_SIDE', 'RELAY_TOP']],
    ['IGNITER', 110, 'igniter', 'Igniter', 'MODEL', 'stone', ['IGNITER_SIDE', 'IGNITER_TOP']],
    ['FILAMENT_LAMP', 111, 'filament_lamp', 'Filament Lamp', 'MODEL', 'wood', ['LAMP_SIDE', 'LAMP_TOP']],
    ['ELECTRIC_BELL', 112, 'electric_bell', 'Electric Bell', 'MODEL', 'stone', ['BELL_SIDE', 'BELL_TOP']],
    ['SPARK_TRANSMITTER', 113, 'spark_transmitter', 'Spark Transmitter', 'MODEL', 'wood', ['TX_SIDE', 'TX_TOP']],
    ['COHERER_RECEIVER', 114, 'coherer_receiver', 'Coherer Receiver', 'MODEL', 'glass', ['RX_SIDE', 'RX_TOP']],
  ];
  const CIRCUIT_TILES = [
    'CIRCUIT_CLEAR', 'COLLAPSAR_SIDE', 'COLLAPSAR_TOP', 'POWDER_FUSE', 'TORCH', 'COPPER_WIRE', 'BROWN_WIRE', 'WHITE_WIRE',
    'EARTH_WIRE', 'TERMINAL_SIDE', 'TERMINAL_TOP', 'BATTERY_SIDE', 'BATTERY_TOP', 'BLASTER_SIDE', 'BLASTER_TOP',
    'SELENIUM_SIDE', 'SELENIUM_TOP', 'SWITCH_SIDE', 'SWITCH_TOP', 'BUTTON_SIDE', 'BUTTON_TOP', 'TIMER_SIDE', 'TIMER_TOP',
    'RELAY_SIDE', 'RELAY_TOP', 'IGNITER_SIDE', 'IGNITER_TOP', 'LAMP_SIDE', 'LAMP_TOP', 'BELL_SIDE', 'BELL_TOP', 'TX_SIDE',
    'TX_TOP', 'RX_SIDE', 'RX_TOP',
  ];

  it('powder and circuits: blocks 95..114 exactly as DESIGN-circuits §1.2 (THIN and MODEL), BLOCK_COUNT 115', () => {
    expect(CIRCUIT_BLOCKS.map((row) => row[1])).toEqual(Array.from({ length: 20 }, (_, i) => 95 + i));
    expect(BLOCK_COUNT).toBe(120); // + v0.11's Workbench at 115, the snares 116–118 and v0.13's Flinty Gravel 119
    for (const [key, id, name, displayName, shape, sound, [side, top]] of CIRCUIT_BLOCKS) {
      expect(BLOCK[key], key).toBe(id);
      const d = BLOCKS[id];
      expect([d.id, d.name, d.displayName, d.soundGroup], key).toEqual([id, name, displayName, sound]);
      expect(SOUND_GROUPS).toContain(d.soundGroup);
      // All 20 are breakable and placeable, have no gravity and do not fall through (§1.2); none is liquid or replaceable.
      expect(d.breakable && d.placeable && !d.gravity && !d.liquid, key).toBe(true);
      expect(isFallThrough(id) || isReplaceable(id) || isPopOff(id) || !isTargetable(id), key).toBe(false);
      for (let f = 0; f < 6; f++) expect(getFaceTile(id, f), `${key} side ${f}`).toBe(TILE[side]);
      expect(getFaceTile(id, FACE_TOP), key).toBe(TILE[top]);
      if (shape === 'THIN') {
        // solid: false, opaque: false, layer cutout, cullSame: false, meshed: false, icon 'flat'; bottom CIRCUIT_CLEAR.
        expect([d.solid, d.opaque, d.layer, d.cullSame, d.meshed, d.icon], key).toEqual([false, false, LAYER_CUTOUT, false, false, 'flat']);
        expect(getFaceTile(id, FACE_BOTTOM), key).toBe(TILE.CIRCUIT_CLEAR);
        expect(shouldRenderFace(BLOCK.STONE, id), key).toBe(true); // never hides the stone it lies on
      } else {
        // A device model: solid (the whole cell collides, targets and bears load) but not opaque and not meshed, so the
        // terrain draws every face round it (no holes); a flat icon of its top tile; bottom = top.
        expect([d.solid, d.opaque, d.layer, d.cullSame, d.meshed, d.icon], key).toEqual([true, false, LAYER_CUTOUT, false, false, 'flat']);
        expect(getFaceTile(id, FACE_BOTTOM), key).toBe(TILE[top]);
        for (const n of [BLOCK.STONE, BLOCK.GRASS_BLOCK, BLOCK.WATER]) expect(shouldRenderFace(n, id), `${key} beside ${n}`).toBe(true);
        expect(isSolid(id) && isTargetable(id), key).toBe(true);
      }
    }
    // 6 thin parts (the fuse, the torch, four wires) and 14 device models.
    expect(CIRCUIT_BLOCKS.filter((row) => row[4] === 'THIN')).toHaveLength(6);
    expect(CIRCUIT_BLOCKS.filter((row) => row[4] === 'MODEL')).toHaveLength(14);
    expect(isOpaque(BLOCK.FILAMENT_LAMP) || isMeshed(BLOCK.FILAMENT_LAMP)).toBe(false);
    // Worldgen-era survival blocks keep their ids.
    expect([BLOCK.COPPER_ORE, BLOCK.FIRE_PIT]).toEqual([76, 94]);
  });

  it('powder and circuits: tiles 160..194 (§1.4), each used by a block face; TILE_IDS 150', () => {
    CIRCUIT_TILES.forEach((key, i) => expect(TILE[key], key).toBe(160 + i));
    expect(TILE_IDS).toHaveLength(159); // + the Workbench's 195, 196 (§67) and 201–203 (§75)
    expect(new Set(TILE_IDS).size).toBe(TILE_IDS.length);
    const used = new Set(BLOCKS.flatMap((d) => d.tiles));
    for (const key of CIRCUIT_TILES) expect(used.has(TILE[key]), key).toBe(true);
    // Clear of survival's 77–104 and the creatures' 240–252; the keg keeps its own two tiles.
    expect(TILE.FIRE_PIT_SIDE).toBeLessThan(160);
    expect(TILE.ZOMBIE_FACE).toBeGreaterThan(194);
    expect([TILE.BARREL_SIDE, TILE.BARREL_TOP]).toEqual([75, 76]);
  });

  it('BlockDef.icon is "prism" by default and "flat" only on the 20 circuit parts but the keg, the 7 plants and the 2 litters', () => {
    const flat = BLOCKS.filter((d) => d.icon === 'flat').map((d) => d.id);
    expect(flat).toEqual([...PLANT_IDS, BLOCK.LOOSE_STONES, BLOCK.FALLEN_BRANCHES, ...Array.from({ length: 20 }, (_, i) => BLOCK.COLLAPSAR_CHARGE + i),
      BLOCK.SNARE, BLOCK.SNARE_BAITED, BLOCK.SNARE_SPRUNG]);
    expect(BLOCKS[BLOCK.POWDER_KEG].icon).toBe('prism');
    for (const d of BLOCKS) expect(['prism', 'flat'], d.name).toContain(d.icon);
    expect(getBlockDef(200).icon).toBe('prism'); // unknown ids read as AIR
  });

  it('the Black Hole is the active vortex only: not placeable, not meshed, still breakable and targetable (§1.1)', () => {
    const d = BLOCKS[BLOCK.BLACK_HOLE];
    expect([d.id, d.name, d.displayName]).toEqual([66, 'black_hole', 'Black Hole']);
    expect(isPlaceable(BLOCK.BLACK_HOLE) || isMeshed(BLOCK.BLACK_HOLE) || isSolid(BLOCK.BLACK_HOLE)).toBe(false);
    expect(isBreakable(BLOCK.BLACK_HOLE) && isTargetable(BLOCK.BLACK_HOLE)).toBe(true);
    expect(PICKER_ORDER).not.toContain(BLOCK.BLACK_HOLE);
    expect(DEFAULT_HOTBAR).not.toContain(BLOCK.BLACK_HOLE);
    expect(getFaceTile(BLOCK.BLACK_HOLE, 0)).toBe(TILE.BLACK_HOLE); // its old tile stays (old icons)
  });

  it('POWDER_KEG is the canonical key of 75; BLAST_BARREL is its alias; BLOCK_ALIASES resolves the old name (§1.1, §1.5)', () => {
    expect(BLOCK.POWDER_KEG).toBe(75);
    expect(BLOCK.BLAST_BARREL).toBe(BLOCK.POWDER_KEG);
    expect(BLOCKS[BLOCK.POWDER_KEG].name.toUpperCase()).toBe('POWDER_KEG');
    expect(BLOCK_ALIASES).toEqual({ blast_barrel: BLOCK.POWDER_KEG });
    expect(Object.isFrozen(BLOCK_ALIASES)).toBe(true);
    // An alias never shadows a real block name, and every alias points at a real block.
    const names = new Set(BLOCKS.map((b) => b.name));
    for (const [alias, id] of Object.entries(BLOCK_ALIASES)) {
      expect(names.has(alias), alias).toBe(false);
      expect(BLOCKS[id], alias).toBeDefined();
    }
    // Every other BLOCK key is unique to its id: BLAST_BARREL is the only alias.
    const keysById = new Map();
    for (const [k, id] of Object.entries(BLOCK)) keysById.set(id, [...(keysById.get(id) ?? []), k]);
    expect([...keysById.values()].filter((ks) => ks.length > 1)).toEqual([['POWDER_KEG', 'BLAST_BARREL']]);
  });

  it('PICKER_ORDER (§1.5): 100 placeable ids; the keg after the campfire, then the 20 new ids in table order, RUNE_BLOCK, WATER', () => {
    expect(PICKER_ORDER).toHaveLength(101); // v0.11: + the Workbench among the workplaces
    const iKeg = PICKER_ORDER.indexOf(BLOCK.POWDER_KEG);
    expect(iKeg).toBe(PICKER_ORDER.indexOf(BLOCK.CAMPFIRE) + 1);
    expect(PICKER_ORDER.slice(iKeg + 1)).toEqual([...CIRCUIT_BLOCKS.map(([key]) => BLOCK[key]), BLOCK.RUNE_BLOCK, BLOCK.WATER]);
    const placeable = BLOCKS.filter((b) => b.placeable).map((b) => b.id).sort((a, b) => a - b);
    expect([...PICKER_ORDER].sort((a, b) => a - b)).toEqual(placeable);
    expect(Object.isFrozen(PICKER_ORDER)).toBe(true);
    // DEFAULT_HOTBAR is unchanged.
    expect(DEFAULT_HOTBAR).toEqual([
      BLOCK.GRASS_BLOCK, BLOCK.DIRT, BLOCK.STONE, BLOCK.COBBLESTONE, BLOCK.OAK_PLANKS, BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, BLOCK.GLASS,
      BLOCK.BRICKS,
    ]);
  });

  it('flags are consistent', () => {
    for (const b of BLOCKS) {
      if (b.opaque) expect(b.solid).toBe(true);
      if (b.liquid) expect(b.solid).toBe(false);
    }
    expect(isSolid(BLOCK.WATER)).toBe(false);
    expect(isLiquid(BLOCK.WATER)).toBe(true);
    expect(isOpaque(BLOCK.GLASS)).toBe(false);
    expect(isSolid(BLOCK.GLASS)).toBe(true);
    expect(isOpaque(BLOCK.OAK_LEAVES)).toBe(false);
    expect(BLOCKS[BLOCK.OAK_LEAVES].cullSame).toBe(false);
    expect(BLOCKS[BLOCK.OAK_LEAVES].layer).toBe(LAYER_CUTOUT);
    expect(BLOCKS[BLOCK.GLASS].layer).toBe(LAYER_CUTOUT);
    expect(BLOCKS[BLOCK.WATER].layer).toBe(LAYER_TRANSLUCENT);
    expect(BLOCKS[BLOCK.STONE].layer).toBe(LAYER_OPAQUE);
    expect(isBreakable(BLOCK.BEDROCK)).toBe(false);
    expect(isPlaceable(BLOCK.BEDROCK)).toBe(false);
    expect(isPlaceable(BLOCK.WATER)).toBe(true);
    expect(isReplaceable(BLOCK.WATER)).toBe(true);
    expect(isReplaceable(BLOCK.AIR)).toBe(true);
    expect(isReplaceable(BLOCK.STONE)).toBe(false);
    expect(isTargetable(BLOCK.WATER)).toBe(false);
    expect(isTargetable(BLOCK.STONE)).toBe(true);
  });
  it('hotbar and picker contain unique placeable ids', () => {
    expect(DEFAULT_HOTBAR).toHaveLength(9);
    expect(new Set(DEFAULT_HOTBAR).size).toBe(9);
    for (const id of DEFAULT_HOTBAR) expect(isPlaceable(id)).toBe(true);
    expect(new Set(PICKER_ORDER).size).toBe(PICKER_ORDER.length);
    const placeable = BLOCKS.filter((b) => b.placeable).map((b) => b.id).sort((a, b) => a - b);
    expect([...PICKER_ORDER].sort((a, b) => a - b)).toEqual(placeable);
  });
  it('culling rule', () => {
    const { AIR, STONE, WATER, GLASS, OAK_LEAVES } = BLOCK;
    expect(shouldRenderFace(AIR, STONE)).toBe(false);
    expect(shouldRenderFace(STONE, AIR)).toBe(true);
    expect(shouldRenderFace(STONE, STONE)).toBe(false);
    expect(shouldRenderFace(STONE, WATER)).toBe(true);
    expect(shouldRenderFace(STONE, GLASS)).toBe(true);
    expect(shouldRenderFace(WATER, WATER)).toBe(false);
    expect(shouldRenderFace(WATER, AIR)).toBe(true);
    expect(shouldRenderFace(WATER, STONE)).toBe(false);
    expect(shouldRenderFace(GLASS, GLASS)).toBe(false);
    expect(shouldRenderFace(OAK_LEAVES, OAK_LEAVES)).toBe(true);
    expect(shouldRenderFace(WATER, GLASS)).toBe(true);
  });
  it('tileToUV rectangles are inside [0,1], inset, and non-overlapping', () => {
    const [u0, v0, u1, v1] = tileToUV(TILE.STONE);
    expect(u0).toBeCloseTo(C.UV_INSET, 10);
    expect(v0).toBeCloseTo(C.UV_INSET, 10);
    expect(u1).toBeCloseTo(C.TILE_UV - C.UV_INSET, 10);
    expect(v1).toBeCloseTo(C.TILE_UV - C.UV_INSET, 10);
    const [a0, b0, a1, b1] = tileToUV(TILE.DIRT); // tile 1: next column, same row
    expect(a0).toBeGreaterThan(u1);
    expect(b0).toBe(v0);
    expect(a1).toBeLessThanOrEqual(1);
    expect(b1).toBeLessThanOrEqual(1);
    const [m0, n0, m1, n1] = tileToUV(TILE.MISSING); // tile 255: bottom-right
    expect(m1).toBeLessThanOrEqual(1);
    expect(n1).toBeLessThanOrEqual(1);
    expect(m0).toBeGreaterThan(0.9);
    expect(n0).toBeGreaterThan(0.9);
  });
});

describe('chunk', () => {
  it('stores its (cq, cr) coordinates and key', () => {
    const c = new Chunk(-3, 7);
    expect(c.cq).toBe(-3);
    expect(c.cr).toBe(7);
    expect(c.key).toBe(chunkKey(-3, 7));
    expect(c.meshed).toBe(false);
    expect(c.heights.length).toBe(C.CHUNK_AREA);
  });
  it('adopts the ChunkData arrays it is given (no copy)', () => {
    const data = {
      blocks: new Uint8Array(C.CHUNK_VOLUME),
      biomes: new Uint8Array(C.CHUNK_AREA),
      heights: new Uint8Array(C.CHUNK_AREA),
    };
    data.blocks[localIndex(2, 3, 4)] = 9;
    const c = new Chunk(0, 0, data);
    expect(c.blocks).toBe(data.blocks);
    expect(c.biomes).toBe(data.biomes);
    expect(c.heights).toBe(data.heights);
    expect(c.get(2, 3, 4)).toBe(9);
  });
  it('get/set round trip with dirty flag and range checks', () => {
    const c = new Chunk(-1, 2);
    expect(c.key).toBe('-1,2');
    expect(c.dirty).toBe(true);
    c.dirty = false;
    expect(c.set(3, 7, 11, 5)).toBe(true);
    expect(c.dirty).toBe(true);
    expect(c.get(3, 7, 11)).toBe(5);
    expect(c.set(3, 7, 11, 5)).toBe(false);
    expect(c.get(16, 0, 0)).toBe(0);
    expect(c.get(0, 128, 0)).toBe(0);
    expect(c.get(0, -1, 0)).toBe(0);
    expect(c.set(16, 0, 0, 1)).toBe(false);
    expect(c.blocks).toBeInstanceOf(Uint8Array);
    expect(c.blocks.length).toBe(C.CHUNK_VOLUME);
    expect(c.biomes.length).toBe(C.CHUNK_AREA);
    let nonzero = 0;
    for (const v of c.blocks) if (v) nonzero++;
    expect(nonzero).toBe(1);
  });
});
