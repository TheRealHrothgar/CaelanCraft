// Unit tests for src/watcher.js — the Hollow Watcher (CONTRACTS §40): when it may appear (night, deep underground, once a
// night — a reload included — about one night in three), where (0.75–0.95 of the fog distance, never within 30, on solid
// ground in a loaded chunk, on screen toward the edge of the view and in line of sight, else the roll waits), how it goes
// (looked at for 0.4 s, approached within 20, 30 s off screen — never on the update it appears in), that it never moves,
// attacks or writes while it is there, the switch, summon, and its three traces with their safety rules (applied
// through a real BlockPhysics: nothing else falls; never anything the player made).
import { describe, it, expect } from 'vitest';
import { WORLD_HEIGHT, NIGHT_SECONDS } from '../../src/config.js';
import { HEX_DIRS, hexLength, hexToWorld, worldToHex } from '../../src/hex.js';
import { BLOCK, isSolid, isLeaves, isLog } from '../../src/blocks.js';
import { lookDirection } from '../../src/coords.js';
import { createPlayer, getEyeHeight, playerIntersectsBlock } from '../../src/physics.js';
import { mulberry32 } from '../../src/noise.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import {
  Watcher, nightKey, blocksSight, lineOfSight, isDeepUnderground, planTrace, planPillar, planDeadFire, planUproot,
  planUprootAt, traceWritable, TRACE_KINDS,
  WATCHER_HEIGHT, WATCHER_EYE_Y, WATCHER_CENTRE_Y, WATCHER_MIN_DIST, WATCHER_FOG_MIN, WATCHER_FOG_MAX,
  WATCHER_NEAR_VANISH, WATCHER_GAZE_S, WATCHER_UNSEEN_S, WATCHER_CHECK_S, WATCHER_CHECK_CHANCE, WATCHER_NIGHT_CHANCE,
  WATCHER_EDGE_MIN, WATCHER_EDGE_MAX, WATCHER_VIEW_MARGIN, WATCHER_SUMMON_SIDE_MIN, WATCHER_SUMMON_SIDE_MAX,
  WATCHER_HEAD_TURN_RATE,
  WATCHER_HEAD_MAX_TURN, WATCHER_TRACE_CHANCE, WATCHER_SPAWN_CLEAR, WATCHER_TREE_RANGE, WATCHER_PILLAR_MIN,
  WATCHER_PILLAR_MAX,
} from '../../src/watcher.js';
import { serializeSave, deserializeSave } from '../../src/storage.js';
import { makeFakeWorld, attachPhysics } from '../helpers/fixtures.js';

const B = BLOCK;
const GROUND = 10; // natural stone for y ≤ 10; feet stand at 11
const FEET = GROUND + 1;
const DEG = Math.PI / 180;

/** A WatcherWorld over a fake world (makeFakeWorld or anything with its read surface), the player at (x, y, z). */
function view(world, o = {}) {
  const player = createPlayer(o.x ?? 0, o.y ?? FEET, o.z ?? 0);
  const yaw = o.yaw ?? 0;
  return {
    getBlock: world.getBlock,
    isLoadedCell: (q, r) => world.hasChunkAtCell(q, r),
    groundHeight: (q, r) => world.terrainHeightAt(q, r),
    isNaturalGround: (q, y, r) => world.isNaturalGround(q, y, r),
    hasEdit: (q, y, r) => world.hasEdit(q, y, r),
    occupied: o.occupied,
    player,
    eye: [player.x, player.y + getEyeHeight(player), player.z],
    look: lookDirection(yaw, o.pitch ?? 0),
    yaw,
    time: o.time ?? 0.95,
    day: o.day ?? 1,
    fogFar: o.fogFar ?? 80,
    spawn: o.spawn ?? null,
    fov: o.fov, // undefined → the Watcher's fallbacks (FOV 70°, 16:9)
    aspect: o.aspect,
  };
}

/**
 * Where a world point lands on screen for the view's camera — worked out here independently of watcher.js, the way
 * three.js does it: a PerspectiveCamera of vertical `fovDeg` and `aspect` rotated (pitch, yaw, 0) in order 'YXZ'.
 * @returns {[number, number]|null} [ndcX, ndcY] (|·| ≤ 1 on screen), null behind the camera
 */
function project(v, x, y, z, fovDeg = 70, aspect = 16 / 9) {
  const yaw = v.yaw;
  const pitch = Math.asin(v.look[1]);
  const fwd = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = [Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), Math.cos(yaw) * Math.sin(pitch)];
  const d = [x - v.eye[0], y - v.eye[1], z - v.eye[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const depth = dot(d, fwd);
  if (!(depth > 0)) return null;
  const tanV = Math.tan((fovDeg * DEG) / 2);
  return [dot(d, right) / (depth * tanV * aspect), dot(d, up) / (depth * tanV)];
}

/** Move the player (and the eye with it). */
function moveTo(v, x, y, z) {
  v.player.x = x;
  v.player.y = y;
  v.player.z = z;
  v.eye = [x, y + getEyeHeight(v.player), z];
}

/** Aim the view at a world point. */
function lookAt(v, x, y, z) {
  const dx = x - v.eye[0];
  const dy = y - v.eye[1];
  const dz = z - v.eye[2];
  const d = Math.hypot(dx, dy, dz);
  v.look = [dx / d, dy / d, dz / d];
  v.yaw = Math.atan2(-dx, -dz);
}

/** Aim the view `deg` degrees to the side of the figure's centre (rotated about +Y). */
function lookBeside(v, f, deg) {
  lookAt(v, f.x, f.y + WATCHER_CENTRE_Y, f.z);
  const a = deg * DEG;
  const [x, y, z] = v.look;
  v.look = [x * Math.cos(a) - z * Math.sin(a), y, x * Math.sin(a) + z * Math.cos(a)];
}

/** An rng that returns the listed values, then `rest` forever. */
function seq(values, rest = 0.5) {
  let i = 0;
  return () => (i < values.length ? values[i++] : rest);
}

/** A deep cavern under a 40-high surface: stone everywhere except an open layer y 21..24 (the floor is y 20). */
function caveWorld(roof = 40) {
  const getBlock = (_q, y, _r) => (y < 0 || y >= WORLD_HEIGHT ? B.AIR : y <= roof && !(y >= 21 && y <= 24) ? B.STONE : B.AIR);
  return {
    getBlock,
    hasChunkAtCell: () => true,
    terrainHeightAt: () => roof,
    isNaturalGround: (q, y, r) => y <= roof && isSolid(getBlock(q, y, r)),
    hasEdit: () => false,
  };
}

/** Yaw that faces from (x, z) toward (tx, tz). */
const yawToward = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** A Watcher summoned at cell (q, r) on the flat ground (feet FEET). */
function summonedAt(world, v, q, r, rng = mulberry32(7)) {
  const w = new Watcher(rng);
  const f = w.summonAt(v, q, FEET, r);
  expect(f).not.toBeNull();
  return { w, f };
}

// ---------------------------------------------------------------------------------------------------------------

describe('rules of sight', () => {
  it('opaque cells and leaves block sight; air, water and glass do not', () => {
    for (const id of [B.STONE, B.OAK_LOG, B.OAK_LEAVES, B.SPRUCE_LEAVES, B.DIRT]) expect(blocksSight(id)).toBe(true);
    for (const id of [B.AIR, B.WATER, B.GLASS]) expect(blocksSight(id)).toBe(false);
    const world = makeFakeWorld({ groundY: GROUND });
    expect(lineOfSight(world.getBlock, 0, 12.6, 0, 0, 13, -40)).toBe(true);
    world.put(0, 12, -20, B.OAK_LEAVES);
    world.put(0, 13, -20, B.OAK_LEAVES);
    const [x] = hexToWorld(0, -20);
    expect(lineOfSight(world.getBlock, x, 12.6, 0, x, 13, -40)).toBe(false);
  });

  it('nightKey: one key from dusk to the next dusk (main bumps `day` at midnight)', () => {
    expect(nightKey(0.85, 1)).toBe(1);
    expect(nightKey(0.1, 2)).toBe(1); // after midnight: the same night
    expect(nightKey(0.5, 2)).toBe(1); // the day after it
    expect(nightKey(0.82, 2)).toBe(2); // the next dusk
  });

  it('deep underground = the eye at least 8 below the generated surface with a roof over it', () => {
    const cave = caveWorld();
    expect(isDeepUnderground(view(cave, { y: 21 }))).toBe(true);
    // Under open sky at the same depth (a pit) it is not.
    const pit = { ...cave, getBlock: (_q, y) => (y > 20 ? B.AIR : B.STONE) };
    expect(isDeepUnderground(view(pit, { y: 21 }))).toBe(false);
    // Just under the surface (a shallow cave) it is not.
    const shallow = caveWorld(26);
    expect(isDeepUnderground(view(shallow, { y: 21 }))).toBe(false);
  });
});

describe('natural appearances (night, deep caves, once a night, ~1 night in 3)', () => {
  it('the per-check chance adds up to one sighting in three over a night (9 real minutes since v0.11)', () => {
    const checks = NIGHT_SECONDS / WATCHER_CHECK_S;
    expect(checks).toBe(108);
    expect(1 - Math.pow(1 - WATCHER_CHECK_CHANCE, checks)).toBeCloseTo(WATCHER_NIGHT_CHANCE, 9);
    // Simulated nights on open ground: about one in three brings a sighting.
    const world = makeFakeWorld({ groundY: GROUND });
    const rng = mulberry32(12345);
    let sightings = 0;
    const NIGHTS = 1500;
    for (let n = 0; n < NIGHTS; n++) {
      const w = new Watcher(rng);
      const v = view(world, { time: 0.85 });
      for (let k = 0; k < checks; k++) {
        if (w.update(WATCHER_CHECK_S, v).appeared) {
          sightings++;
          break;
        }
      }
    }
    expect(sightings / NIGHTS).toBeGreaterThan(0.29);
    expect(sightings / NIGHTS).toBeLessThan(0.38);
  });

  it('never by day on the surface; at night it appears (a roll that comes up is placed at the next check)', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const w = new Watcher(() => 0); // every roll comes up
    const day = view(world, { time: 0.5 });
    for (let k = 0; k < 100; k++) expect(w.update(WATCHER_CHECK_S, day).appeared).toBeNull();
    expect(w.present).toBe(false);
    const night = view(world, { time: 0.95 });
    expect(w.update(WATCHER_CHECK_S - 0.01, night).appeared).toBeNull(); // waits for the check
    const f = w.update(0.02, night).appeared;
    expect(f).not.toBeNull();
    expect(f.kind).toBe('night');
    expect(w.figure).toBe(f);
  });

  it('deep underground it appears at any time, in the cave near the player\'s level', () => {
    const cave = caveWorld();
    const w = new Watcher(mulberry32(3));
    const v = view(cave, { y: 21, time: 0.5 }); // noon
    expect(w.sightingMode(v)).toBe('cave');
    let f = null;
    for (let k = 0; k < 2000 && !f; k++) f = w.update(WATCHER_CHECK_S, v).appeared;
    expect(f).not.toBeNull();
    expect(f.kind).toBe('cave');
    expect(f.y).toBe(21);
    expect(cave.getBlock(f.q, 20, f.r)).toBe(B.STONE);
    expect(f.los).toBe(true);
    // A shallow cave at noon: no.
    const w2 = new Watcher(() => 0);
    expect(w2.sightingMode(view(caveWorld(26), { y: 21, time: 0.5 }))).toBeNull();
  });

  it('at most one at a time, and at most one sighting per in-game night', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const w = new Watcher(() => 0);
    const v = view(world, { time: 0.85, day: 3 });
    const f = w.update(WATCHER_CHECK_S, v).appeared;
    expect(f).not.toBeNull();
    for (let k = 0; k < 20; k++) {
      const ev = w.update(1, v);
      expect(ev.appeared).toBeNull();
      if (!w.present) break;
    }
    expect(w.summon(v)).toBeNull(); // while it is here (or after: summon refuses only while present)
    // Make it vanish (walk up to it), then the rest of the night — and the day after it — bring no other.
    moveTo(v, f.x, f.y, f.z + 10);
    w.update(0.1, v);
    expect(w.present).toBe(false);
    moveTo(v, 0, FEET, 0);
    for (const [time, day] of [[0.9, 3], [0.1, 4], [0.2, 4], [0.5, 4]]) {
      v.time = time;
      v.day = day;
      for (let k = 0; k < 30; k++) expect(w.update(WATCHER_CHECK_S, v).appeared).toBeNull();
    }
    // The next night it may come again.
    v.time = 0.85;
    v.day = 4;
    expect(w.update(WATCHER_CHECK_S, v).appeared).not.toBeNull();
  });

  it('a reload in the same night brings no second sighting (lastNight is saved as watcherNight); the next night still can', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const a = new Watcher(() => 0);
    const v = view(world, { time: 0.85, day: 3 });
    expect(a.lastNight).toBeNull();
    expect(a.update(WATCHER_CHECK_S, v).appeared).not.toBeNull();
    expect(a.lastNight).toBe(3);
    // main saves the world (time, day and the night of the sighting) and the page is reloaded …
    const text = serializeSave({
      version: 2, seed: 1, time: 0.86, day: 3, player: { x: 0, y: FEET, z: 0, yaw: 0, pitch: 0, flying: false },
      hotbar: [1, 2, 3, 4, 5, 6, 7, 8, 9], selected: 0, edits: {}, watcher: a.enabled, watcherNight: a.lastNight,
    });
    const save = deserializeSave(text);
    // … startLoading: a cleared Watcher, then the saved night.
    const b = new Watcher(() => 0);
    b.clear();
    expect(b.setLastNight(save.watcherNight)).toBe(true);
    expect(b.lastNight).toBe(3);
    const v2 = view(world, { time: save.time, day: save.day });
    for (const [time, day] of [[0.86, 3], [0.95, 3], [0.1, 4], [0.24, 4], [0.5, 4], [0.8, 4]]) { // v0.11: sunset 19:30 (0.8125)
      v2.time = time;
      v2.day = day;
      for (let k = 0; k < 30; k++) expect(b.update(WATCHER_CHECK_S, v2).appeared).toBeNull();
    }
    v2.time = 0.82; // the next dusk
    v2.day = 4;
    expect(b.update(WATCHER_CHECK_S, v2).appeared).not.toBeNull();
    expect(b.lastNight).toBe(4);
    // Without it (a save from before the field) the same night could bring another — what a reload used to allow.
    const c = new Watcher(() => 0);
    c.setLastNight(deserializeSave(serializeSave({ ...save, watcherNight: undefined })).watcherNight ?? null);
    v2.time = 0.9;
    v2.day = 3;
    expect(c.update(WATCHER_CHECK_S, v2).appeared).not.toBeNull();
    // Only a whole night number is taken; anything else means "none yet". clear() forgets it.
    for (const bad of [-1, 2.5, '3', NaN, undefined, {}]) {
      const w = new Watcher();
      expect(w.setLastNight(bad)).toBe(false);
      expect(w.lastNight).toBeNull();
    }
    expect(b.setLastNight(null)).toBe(true);
    expect(b.lastNight).toBeNull();
    b.setLastNight(7);
    b.clear();
    expect(b.lastNight).toBeNull();
  });

  it('never while the player\'s head is under water', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const w = new Watcher(() => 0);
    const v = view(world);
    v.player.headInWater = true;
    for (let k = 0; k < 20; k++) expect(w.update(WATCHER_CHECK_S, v).appeared).toBeNull();
  });
});

describe('placement', () => {
  it('0.75–0.95 of the fog distance, toward the edge of the view, standing on solid ground facing the player, in sight', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const tanH = Math.tan(35 * DEG) * (16 / 9); // the fallback view: FOV 70°, 16:9
    for (let seed = 1; seed <= 60; seed++) {
      const w = new Watcher(mulberry32(seed));
      const v = view(world, { yaw: (seed * 0.37) % (2 * Math.PI), fogFar: 80 });
      const spot = w.findSpot(v, false);
      expect(spot).not.toBeNull();
      const dh = Math.hypot(spot.x - v.player.x, spot.z - v.player.z);
      expect(dh).toBeGreaterThanOrEqual(WATCHER_FOG_MIN * 80);
      expect(dh).toBeLessThanOrEqual(WATCHER_FOG_MAX * 80);
      // Aimed at WATCHER_EDGE_MIN … MAX of the half-width (the cell centre is within half a cell of the aim).
      const side = Math.abs(wrap(yawToward(v.player.x, v.player.z, spot.x, spot.z) - v.yaw));
      expect(side).toBeGreaterThan(Math.atan(WATCHER_EDGE_MIN * tanH) - 1.5 / dh);
      expect(side).toBeLessThan(Math.atan(WATCHER_EDGE_MAX * tanH) + 1.5 / dh);
      const [q, r] = worldToHex(spot.x, spot.z);
      expect(isSolid(world.getBlock(q, spot.y - 1, r))).toBe(true);
      for (let y = spot.y; y < spot.y + 3; y++) expect(world.getBlock(q, y, r)).toBe(B.AIR);
      expect(spot.los).toBe(true);
    }
    // The figure faces the player.
    const w = new Watcher(mulberry32(9));
    const v = view(world, { time: 0.9 });
    const f = w.summon(v);
    expect(Math.abs(wrap(f.yaw - yawToward(f.x, f.z, v.player.x, v.player.z)))).toBeLessThan(1e-9);
    expect(f.headYaw).toBe(f.yaw);
  });

  it('never within 30 of the player: a small fog distance (rd 3 → 27.7) leaves no place; a larger one starts at 30', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const w = new Watcher(mulberry32(1));
    expect(w.findSpot(view(world, { fogFar: 27.7 }), false)).toBeNull();
    for (let seed = 1; seed < 40; seed++) {
      const spot = new Watcher(mulberry32(seed)).findSpot(view(world, { fogFar: 40 }), false);
      expect(spot).not.toBeNull();
      expect(Math.hypot(spot.x, spot.y - FEET, spot.z)).toBeGreaterThanOrEqual(WATCHER_MIN_DIST);
      expect(Math.hypot(spot.x, spot.z)).toBeLessThanOrEqual(0.95 * 40);
    }
  });

  it('only in a loaded chunk', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    // Unload every chunk with cq < 0: whatever direction it is aimed, it stands where cq ≥ 0.
    for (let cq = -8; cq < 0; cq++) for (let cr = -8; cr <= 8; cr++) world.unload(cq, cr);
    for (let seed = 1; seed < 40; seed++) {
      const spot = new Watcher(mulberry32(seed)).findSpot(view(world, { x: 1, yaw: Math.PI / 2 }), false); // facing −X
      if (!spot) continue;
      const [q, r] = worldToHex(spot.x, spot.z);
      expect(world.hasChunkAtCell(q, r)).toBe(true);
    }
  });

  it('natural sightings start on screen, toward its edge: the whole figure inside the view with a margin (any window)', () => {
    // Play-test: about half of them appeared off screen (aimed 25°–75° aside while a 16:9 view shows ±51°; the vertical
    // was never looked at).
    const world = makeFakeWorld({ groundY: GROUND });
    const windows = [[undefined, undefined, 70, 16 / 9], [70, 16 / 9], [80, 16 / 9], [70, 4 / 3], [70, 21 / 9], [70, 1]];
    let n = 0;
    for (const [fov, aspect, pf = fov, pa = aspect] of windows) {
      for (const pitch of [0, -25, 15]) {
        for (let seed = 1; seed <= 15; seed++) {
          const v = view(world, { yaw: seed * 0.71, pitch: pitch * DEG, fov, aspect });
          const spot = new Watcher(mulberry32(seed)).findSpot(v, false);
          expect(spot, `fov ${pf} aspect ${pa.toFixed(2)} pitch ${pitch} seed ${seed}`).not.toBeNull(); // open ground
          for (const h of [0, WATCHER_HEIGHT]) { // its feet and the top of its head
            const [sx, sy] = project(v, spot.x, spot.y + h, spot.z, pf, pa);
            expect(Math.abs(sx)).toBeLessThanOrEqual(0.9 + 1e-9);
            expect(Math.abs(sy)).toBeLessThanOrEqual(0.9 + 1e-9);
          }
          const [sx] = project(v, spot.x, spot.y + WATCHER_CENTRE_Y, spot.z, pf, pa);
          expect(Math.abs(sx)).toBeGreaterThan(0.33); // toward the edge, never in the middle
          n++;
        }
      }
    }
    expect(n).toBe(270);
    expect(WATCHER_VIEW_MARGIN).toBe(0.1);
  });

  it('looking down at the ground (the horizon off screen) none starts; the night\'s roll waits for a later check', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const w = new Watcher(() => 0); // every roll comes up
    const v = view(world, { time: 0.9, pitch: -70 * DEG });
    expect(w.findSpot(v, false)).toBeNull();
    for (let k = 0; k < 10; k++) expect(w.update(WATCHER_CHECK_S, v).appeared).toBeNull();
    v.look = lookDirection(0, 0);
    const f = w.update(WATCHER_CHECK_S, v).appeared;
    expect(f).not.toBeNull();
    expect(project(v, f.x, f.y + WATCHER_CENTRE_Y, f.z)).not.toBeNull();
  });

  it('only where it can be seen: never behind walls (play-test) — the roll stays pending and comes once there is a view', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    // A wall all round at hex distance 6, tall enough to hide everything — with or without a gap on the left (west).
    const wall = (gap) => {
      for (let q = -6; q <= 6; q++) {
        for (let r = -6; r <= 6; r++) {
          if (hexLength(q, r) !== 6) continue;
          const [x, z] = hexToWorld(q, r);
          const id = gap && x < -3 && Math.abs(z) < 5 ? B.AIR : B.STONE;
          for (let y = FEET; y < FEET + 12; y++) world.put(q, y, r, id);
        }
      }
    };
    wall(true);
    const v = view(world, { yaw: Math.PI / 2 - 50 * DEG, time: 0.9 }); // facing west-ish: the gap is at the side of the view
    for (let seed = 1; seed <= 20; seed++) {
      const spot = new Watcher(mulberry32(seed)).findSpot(v, false);
      expect(spot).not.toBeNull();
      expect(spot.los).toBe(true);
      expect(lineOfSight(world.getBlock, ...v.eye, spot.x, spot.y + WATCHER_EYE_Y, spot.z) ||
        lineOfSight(world.getBlock, ...v.eye, spot.x, spot.y + WATCHER_CENTRE_Y, spot.z)).toBe(true);
    }
    // Walled in completely: no natural spot at all (it used to come anyway, unseen, and use up the night).
    wall(false);
    expect(new Watcher(mulberry32(5)).findSpot(v, false)).toBeNull();
    const m = mulberry32(3);
    let rolls = 0;
    const w = new Watcher(() => (rolls++ === 0 ? 0 : m())); // the first roll comes up, the later ones (almost) never
    for (let k = 0; k < 12; k++) expect(w.update(WATCHER_CHECK_S, v).appeared).toBeNull();
    wall(true); // … the player breaks through: the same night's roll is placed at the next check, in sight
    const f = w.update(WATCHER_CHECK_S, v).appeared;
    expect(f).toMatchObject({ kind: 'night', los: true });
    // summon (a testing command) prefers a spot in sight, and only walled in falls back to one hidden in the view.
    const s1 = new Watcher(mulberry32(8)).summon(v);
    expect(s1.los).toBe(true);
    wall(false);
    const s2 = new Watcher(mulberry32(8)).summon(v);
    expect(s2).not.toBeNull();
    expect(s2.los).toBe(false);
  });

  it('deep underground too: no cave sighting where it cannot be seen; it waits for a view', () => {
    const base = caveWorld();
    const walls = { on: true };
    // The cave layer is walled off at hex distance 5 around the player while walls.on.
    const getBlock = (q, y, r) => (walls.on && y >= 21 && y <= 24 && hexLength(q, r) === 5 ? B.STONE : base.getBlock(q, y, r));
    const cave = { ...base, getBlock };
    const m = mulberry32(4);
    let rolls = 0;
    const w = new Watcher(() => (rolls++ === 0 ? 0 : m()));
    const v = view(cave, { y: 21, time: 0.5 });
    expect(w.sightingMode(v)).toBe('cave');
    for (let k = 0; k < 12; k++) expect(w.update(WATCHER_CHECK_S, v).appeared).toBeNull();
    walls.on = false;
    const f = w.update(WATCHER_CHECK_S, v).appeared;
    expect(f).toMatchObject({ kind: 'cave', los: true, y: 21 });
  });

  it('summon: any time of day, plainly in view (8–25° off), and it does not use up the night', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    for (let seed = 1; seed <= 30; seed++) {
      const w = new Watcher(mulberry32(seed));
      const v = view(world, { time: 0.5, yaw: 1 });
      const f = w.summon(v);
      expect(f).not.toBeNull();
      expect(f.kind).toBe('summon');
      const dh = Math.hypot(f.x, f.z);
      const side = Math.abs(wrap(yawToward(0, 0, f.x, f.z) - 1));
      expect(side).toBeGreaterThan(WATCHER_SUMMON_SIDE_MIN - 1.5 / dh);
      expect(side).toBeLessThan(WATCHER_SUMMON_SIDE_MAX + 1.5 / dh);
    }
    // In view too: inside the frustum with the margin (the horizon at the top of a downward look), none at all when the
    // horizon is off screen.
    for (let seed = 1; seed <= 20; seed++) {
      const v = view(world, { time: 0.5, yaw: seed, pitch: -25 * DEG });
      const f = new Watcher(mulberry32(seed)).summon(v);
      for (const h of [0, WATCHER_HEIGHT]) {
        const [sx, sy] = project(v, f.x, f.y + h, f.z);
        expect(Math.max(Math.abs(sx), Math.abs(sy))).toBeLessThanOrEqual(0.9 + 1e-9);
      }
    }
    expect(new Watcher(mulberry32(1)).summon(view(world, { time: 0.5, pitch: -70 * DEG }))).toBeNull();
    const w = new Watcher(() => 0);
    const v = view(world, { time: 0.85 });
    w.summon(v);
    moveTo(v, w.figure.x, FEET, w.figure.z + 5);
    w.update(0.1, v); // gone
    moveTo(v, 0, FEET, 0);
    expect(w.update(WATCHER_CHECK_S, v).appeared).not.toBeNull(); // the night's natural sighting is still to come
  });
});

describe('vanishing', () => {
  it('looked straight at (centre within 6°, line of sight) for 0.4 s: gone in a puff', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const v = view(world);
    const { w, f } = summonedAt(world, v, 0, -45);
    lookAt(v, f.x, f.y + WATCHER_CENTRE_Y, f.z);
    for (let k = 0; k < 3; k++) {
      expect(w.update(0.125, v).vanished).toBeNull(); // 0.375 s
    }
    expect(w.figure.gaze).toBeCloseTo(0.375, 9);
    const ev = w.update(0.125, v);
    expect(ev.vanished).toMatchObject({ x: f.x, y: f.y, z: f.z, reason: 'gaze' });
    expect(w.present).toBe(false);
    expect(WATCHER_GAZE_S).toBe(0.4);
  });

  it('5° off still counts; 8° off does not (it stays, on screen); looking away resets the gaze', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const v = view(world);
    const a = summonedAt(world, v, 0, -45);
    lookBeside(v, a.f, 5);
    for (let k = 0; k < 4; k++) a.w.update(0.125, v);
    expect(a.w.present).toBe(false);
    const b = summonedAt(world, v, 0, -45);
    lookBeside(v, b.f, 8);
    for (let k = 0; k < 80; k++) b.w.update(0.125, v); // 10 s
    expect(b.w.present).toBe(true);
    expect(b.w.figure.seen).toBe(true);
    expect(b.w.figure.unseen).toBe(0);
    // 0.375 s, a glance away, 0.375 s: still there.
    lookAt(v, b.f.x, b.f.y + WATCHER_CENTRE_Y, b.f.z);
    for (let k = 0; k < 3; k++) b.w.update(0.125, v);
    lookBeside(v, b.f, 20);
    b.w.update(0.05, v);
    lookAt(v, b.f.x, b.f.y + WATCHER_CENTRE_Y, b.f.z);
    for (let k = 0; k < 3; k++) b.w.update(0.125, v);
    expect(b.w.present).toBe(true);
    b.w.update(0.125, v);
    expect(b.w.present).toBe(false);
  });

  it('"on screen" is the real view: 48° aside in a 16:9 window is on screen (not in 4:3), 40° above its centre is not', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const v = view(world);
    const { w, f } = summonedAt(world, v, 0, -45);
    lookBeside(v, f, 48); // inside a 16:9 view's ±51°, outside the 45° cone that used to stand for the screen
    for (let k = 0; k < 50; k++) w.update(0.1, v);
    expect(w.figure.seen).toBe(true);
    expect(w.figure.unseen).toBe(0);
    v.aspect = 4 / 3; // a 4:3 window shows ±43°
    w.update(0.1, v);
    expect(w.figure.seen).toBe(false);
    v.aspect = 16 / 9;
    w.update(0.1, v);
    expect(w.figure.seen).toBe(true);
    // Looking up 40° above it: inside a 45° cone, but out of the view (±35° vertically at FOV 70°).
    const yaw = yawToward(v.eye[0], v.eye[2], f.x, f.z);
    const pitch = Math.atan2(f.y + WATCHER_CENTRE_Y - v.eye[1], Math.hypot(f.x - v.eye[0], f.z - v.eye[2]));
    v.yaw = yaw;
    v.look = lookDirection(yaw, pitch + 40 * DEG);
    w.update(0.1, v);
    expect(w.figure.seen).toBe(false);
    v.look = lookDirection(yaw, pitch + 30 * DEG); // 30°: on screen
    w.update(0.1, v);
    expect(w.figure.seen).toBe(true);
  });

  it('a wall between: staring at it does nothing, and 30 s unseen it is gone', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const v = view(world);
    const { w, f } = summonedAt(world, v, 0, -45);
    for (let q = -3; q <= 3; q++) for (let y = FEET; y < FEET + 6; y++) world.put(q, y, -20, B.STONE);
    lookAt(v, f.x, f.y + WATCHER_CENTRE_Y, f.z);
    for (let k = 0; k < 29; k++) expect(w.update(1, v).vanished).toBeNull();
    expect(w.figure.gaze).toBe(0);
    expect(w.figure.unseen).toBeCloseTo(29, 9);
    expect(w.update(1, v).vanished).toMatchObject({ reason: 'unseen' });
  });

  it('30 s off screen → gone; on screen (not looked straight at) it stays', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const v = view(world);
    const { w, f } = summonedAt(world, v, 0, -45);
    lookBeside(v, f, 180); // turned away
    for (let k = 0; k < 299; k++) w.update(0.1, v);
    expect(w.present).toBe(true);
    expect(w.figure.unseen).toBeCloseTo(29.9, 6);
    w.update(0.1, v);
    expect(w.present).toBe(false);
    expect(w.events.vanished.reason).toBe('unseen');
    expect(WATCHER_UNSEEN_S).toBe(30);
  });

  it('the player within 20 → gone; at 20.5 it stays', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const v = view(world);
    const { w, f } = summonedAt(world, v, 0, -45);
    lookBeside(v, f, 180);
    moveTo(v, f.x, FEET, f.z + 20.5);
    w.update(0.1, v);
    expect(w.present).toBe(true);
    moveTo(v, f.x, FEET, f.z + WATCHER_NEAR_VANISH - 0.01);
    expect(w.update(0.1, v).vanished).toMatchObject({ reason: 'near' });
  });

  it('never on the update it appears in (even a long one); the next one may', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const w = new Watcher(() => 0);
    const v = view(world, { time: 0.9 });
    const ev = w.update(WATCHER_UNSEEN_S + 10, v); // 40 s at once: the check fires and it appears
    expect(ev.appeared).not.toBeNull();
    expect(ev.vanished).toBeNull();
    expect(w.figure.age).toBe(0);
    lookBeside(v, w.figure, 180);
    expect(w.update(WATCHER_UNSEEN_S + 10, v).vanished).toMatchObject({ reason: 'unseen' });
  });

  it('a natural night sighting fades at dawn; a summoned one does not', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const w = new Watcher(() => 0);
    const v = view(world, { time: 0.18 });
    expect(w.update(WATCHER_CHECK_S, v).appeared).not.toBeNull();
    lookBeside(v, w.figure, 30);
    w.update(0.1, v);
    expect(w.present).toBe(true);
    v.time = 0.2;
    expect(w.update(0.1, v).vanished).toMatchObject({ reason: 'dawn' });
    const s = summonedAt(world, v, 0, -45);
    lookBeside(v, s.f, 30);
    for (let k = 0; k < 10; k++) s.w.update(0.1, v);
    expect(s.w.present).toBe(true);
  });

  it('its chunk unloads → gone without a trace', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const v = view(world);
    const { w, f } = summonedAt(world, v, 0, -45, () => 0); // every trace roll would come up
    world.unload(Math.floor(f.q / 16), Math.floor(f.r / 16));
    expect(w.update(0.1, v).vanished).toEqual({ x: f.x, y: f.y, z: f.z, reason: 'unloaded', trace: null });
  });
});

describe('while it is there: it never moves, attacks or touches anything', () => {
  it('stands still, the player is untouched, no block is written; only its head turns, slowly, within limits', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const v = view(world);
    const { w, f } = summonedAt(world, v, 0, -45);
    const start = { x: f.x, y: f.y, z: f.z, yaw: f.yaw };
    v.player.vx = 1.5;
    v.player.vz = -0.5;
    const writes = world.writes.length;
    let prevHead = f.headYaw;
    // The player walks a wide arc around it, looking past it (never straight at it, never within 20).
    for (let k = 0; k < 400; k++) {
      const a = (k / 400) * Math.PI;
      moveTo(v, f.x + Math.sin(a) * 30, FEET, f.z + Math.cos(a) * 30);
      lookBeside(v, f, 25);
      w.update(1 / 20, v);
      expect(w.present).toBe(true);
      const g = w.figure;
      expect({ x: g.x, y: g.y, z: g.z, yaw: g.yaw }).toEqual(start);
      expect(Math.abs(wrap(g.headYaw - prevHead))).toBeLessThanOrEqual(WATCHER_HEAD_TURN_RATE / 20 + 1e-9);
      expect(Math.abs(wrap(g.headYaw - g.yaw))).toBeLessThanOrEqual(WATCHER_HEAD_MAX_TURN + 1e-9);
      prevHead = g.headYaw;
    }
    // It turned its head as far as it goes toward a player now behind its shoulder.
    expect(Math.abs(wrap(w.figure.headYaw - w.figure.yaw))).toBeCloseTo(WATCHER_HEAD_MAX_TURN, 6);
    expect(v.player.vx).toBe(1.5);
    expect(v.player.vz).toBe(-0.5);
    expect(world.writes.length).toBe(writes);
    // Its update API has nothing to write with: traces come back as a list for main to apply.
    expect('setBlock' in v).toBe(false);
  });

  it('wisps of smoke now and then (every 1.2–3.6 s)', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const v = view(world);
    const { w, f } = summonedAt(world, v, 0, -45);
    lookBeside(v, f, 25);
    let wisps = 0;
    for (let k = 0; k < 200; k++) if (w.update(0.1, v).wisp) wisps++; // 20 s
    expect(wisps).toBeGreaterThanOrEqual(5);
    expect(wisps).toBeLessThanOrEqual(17);
  });
});

describe('the switch', () => {
  it('off removes it at once and nothing comes; summon refuses; on again allows it; switchVersion counts changes', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const w = new Watcher(() => 0);
    const v = view(world, { time: 0.9 });
    expect(w.enabled).toBe(true);
    w.update(WATCHER_CHECK_S, v);
    expect(w.present).toBe(true);
    expect(w.setEnabled(false)).toBe(true);
    expect(w.switchVersion).toBe(1);
    expect(w.present).toBe(false);
    expect(w.setEnabled(false)).toBe(false);
    v.day = 2; // a fresh night
    for (let k = 0; k < 20; k++) expect(w.update(WATCHER_CHECK_S, v).appeared).toBeNull();
    expect(w.summon(v)).toBeNull();
    expect(w.summonAt(v, 0, FEET, -45)).toBeNull();
    expect(w.setEnabled(true)).toBe(true);
    expect(w.switchVersion).toBe(2);
    expect(w.update(WATCHER_CHECK_S, v).appeared).not.toBeNull();
    // clear() (a new world) forgets the figure and the night, keeps the switch.
    w.clear();
    expect(w.present).toBe(false);
    expect(w.enabled).toBe(true);
    expect(w.update(WATCHER_CHECK_S, v).appeared).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------------------------------------------

/** Ring-1 and the non-corner ring-2 cells, like worldgen's canopy. */
const CANOPY = (() => {
  const out = [];
  for (let dq = -2; dq <= 2; dq++) {
    for (let dr = -2; dr <= 2; dr++) {
      const d = hexLength(dq, dr);
      if (d === 0 || d > 2) continue;
      if (d === 2 && (dq === 0 || dr === 0 || dq + dr === 0)) continue;
      out.push([dq, dr]);
    }
  }
  return out;
})();

/** A worldgen-like oak at (q0, r0) as natural terrain (no edits). @returns {{ logs: number[][], leaves: number[][] }} */
function plantTree(world, q0, r0, height = 5) {
  const base = GROUND + 1;
  const top = base + height - 1;
  const logs = [];
  for (let y = base; y <= top; y++) {
    world.put(q0, y, r0, B.OAK_LOG);
    logs.push([q0, y, r0]);
  }
  const cells = [];
  for (const y of [top - 1, top]) for (const [dq, dr] of CANOPY) cells.push([q0 + dq, y, r0 + dr]);
  for (const [dq, dr] of [[0, 0], ...HEX_DIRS]) cells.push([q0 + dq, top + 1, r0 + dr]);
  cells.push([q0, top + 2, r0]);
  const leaves = [];
  for (const [q, y, r] of cells) {
    if (world.getBlock(q, y, r) !== B.AIR) continue;
    world.put(q, y, r, B.OAK_LEAVES);
    leaves.push([q, y, r]);
  }
  return { logs, leaves };
}

function physicsWorld() {
  const world = makeFakeWorld({ groundY: GROUND });
  const fx = { spawns: [] };
  const physics = attachPhysics(world, BlockPhysics, {});
  const spawn = physics.fallers.spawn.bind(physics.fallers);
  physics.fallers.spawn = (id, q, y, r, o) => {
    fx.spawns.push([q, y, r, id]);
    return spawn(id, q, y, r, o);
  };
  return { world, physics, fx };
}

const idle = (p) => p.fallers.count === 0 && p.queued() === 0 && p.seeds.size === 0 && !p.support.busy &&
  p.trees.count === 0 && p.trees.decayCount === 0;

function settle(physics, max = 600) {
  physics.step(1 / 60);
  for (let n = 0; !idle(physics) && n < max; n++) physics.step(1 / 60);
  for (let n = 0; n < 30; n++) physics.step(1 / 60); // and a little longer: nothing may start later
}

/** Apply a trace as main does (World.setBlock, in order). */
function apply(world, trace) {
  for (const [q, y, r, id] of trace.writes) expect(world.setBlock(q, y, r, id)).toBe(true);
}

/** Every non-AIR cell of a box. */
function snapshot(world, q0, q1, y0, y1, r0, r1) {
  const m = new Map();
  for (let q = q0; q <= q1; q++) for (let y = y0; y <= y1; y++) for (let r = r0; r <= r1; r++) m.set(`${q},${y},${r}`, world.getBlock(q, y, r));
  return m;
}

describe('traces', () => {
  it('a third or so of the vanishings leave one, of a random kind', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const rng = mulberry32(99);
    const kinds = new Map();
    let traces = 0;
    const N = 1500;
    for (let k = 0; k < N; k++) {
      const v = view(world);
      const w = new Watcher(rng);
      w.summonAt(v, 0, FEET, -40);
      moveTo(v, w.figure.x, FEET, w.figure.z + 19);
      const t = w.update(0.1, v).vanished.trace;
      if (t) {
        traces++;
        kinds.set(t.kind, (kinds.get(t.kind) ?? 0) + 1);
      }
    }
    expect(WATCHER_TRACE_CHANCE).toBe(0.35);
    expect(traces / N).toBeGreaterThan(0.31);
    expect(traces / N).toBeLessThan(0.39);
    // No tree here: pillars and dead campfires, about half each.
    expect([...kinds.keys()].sort()).toEqual(['deadfire', 'pillar']);
    expect(kinds.get('pillar') / traces).toBeGreaterThan(0.38);
    expect(kinds.get('pillar') / traces).toBeLessThan(0.62);
    expect(TRACE_KINDS).toEqual(['pillar', 'deadfire', 'uprooted']);
  });

  it('pillar: 4–6 obsidian on natural ground where it stood, into AIR only; nothing falls', () => {
    const { world, physics, fx } = physicsWorld();
    const [x, z] = hexToWorld(10, -30);
    const heights = new Set();
    for (let seed = 1; seed <= 30; seed++) {
      const t = planPillar(view(world, { x: 0, z: 0 }), x, FEET, z, mulberry32(seed));
      expect(t.kind).toBe('pillar');
      expect(t.at).toEqual([10, FEET, -30]);
      heights.add(t.writes.length);
      t.writes.forEach(([q, y, r, id], i) => expect([q, y, r, id]).toEqual([10, FEET + i, -30, B.OBSIDIAN]));
    }
    expect([...heights].sort()).toEqual([WATCHER_PILLAR_MIN, 5, WATCHER_PILLAR_MAX]);
    const t = planPillar(view(world), x, FEET, z, mulberry32(4));
    apply(world, t);
    const n = world.writes.length;
    settle(physics);
    expect(world.writes.length).toBe(n);
    expect(fx.spawns).toEqual([]);
    for (const [q, y, r] of t.writes) expect(world.getBlock(q, y, r)).toBe(B.OBSIDIAN);
  });

  it('pillar: not on a built floor, not next to water, never in the player\'s body — it moves nearby', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const [x, z] = hexToWorld(10, -30);
    // The cell it stood on is a plank floor (an edit, not natural ground) …
    world.setBlock(10, GROUND, -30, B.OAK_PLANKS);
    let t = planPillar(view(world), x, FEET, z, mulberry32(1));
    expect(hexLength(t.at[0] - 10, t.at[2] + 30)).toBeGreaterThanOrEqual(1);
    expect(hexLength(t.at[0] - 10, t.at[2] + 30)).toBeLessThanOrEqual(3);
    for (const [q, y, r] of t.writes) expect(world.isNaturalGround(q, y - 1, r) || t.writes.some((c) => c[0] === q && c[1] === y - 1 && c[2] === r)).toBe(true);
    // … water beside it …
    const w2 = makeFakeWorld({ groundY: GROUND });
    w2.put(11, FEET, -30, B.WATER);
    t = planPillar(view(w2), x, FEET, z, mulberry32(1));
    expect(t.at.slice(0, 1).concat(t.at.slice(2))).not.toEqual([10, -30]);
    for (const [q, y, r] of t.writes) for (const [dq, dr] of HEX_DIRS) expect(w2.getBlock(q + dq, y, r + dr)).not.toBe(B.WATER);
    // … the player standing in it.
    const w3 = makeFakeWorld({ groundY: GROUND });
    const v = view(w3, { x, z });
    t = planPillar(v, x, FEET, z, mulberry32(1));
    for (const [q, y, r] of t.writes) expect(playerIntersectsBlock(v.player, q, y, r)).toBe(false);
    expect(traceWritable(v, 10, FEET, -30)).toBe(false);
  });

  it('dead campfire: six cobblestones round an empty centre whose floor is gravel — no lit campfire; nothing falls', () => {
    const { world, physics, fx } = physicsWorld();
    const [x, z] = hexToWorld(10, -30);
    const t = planDeadFire(view(world), x, FEET, z, mulberry32(2));
    expect(t.kind).toBe('deadfire');
    expect(t.at).toEqual([10, GROUND, -30]);
    expect(t.writes).toHaveLength(7);
    for (let j = 0; j < 6; j++) expect(t.writes[j]).toEqual([10 + HEX_DIRS[j][0], FEET, -30 + HEX_DIRS[j][1], B.COBBLESTONE]);
    expect(t.writes[6]).toEqual([10, GROUND, -30, B.GRAVEL]);
    expect(t.writes.some((c) => c[3] === B.CAMPFIRE)).toBe(false);
    apply(world, t);
    const n = world.writes.length;
    settle(physics);
    expect(world.writes.length).toBe(n);
    expect(fx.spawns).toEqual([]);
    expect(world.getBlock(10, GROUND, -30)).toBe(B.GRAVEL); // it does not fall: stone below
    expect(world.getBlock(10, FEET, -30)).toBe(B.AIR);
  });

  it('dead campfire: needs flat natural ground all round (a step or a hole moves it)', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    world.put(11, FEET, -30, B.STONE); // a natural-looking step east of the spot is not "ground at g"
    const [x, z] = hexToWorld(10, -30);
    const t = planDeadFire(view(world), x, FEET, z, mulberry32(2));
    expect(t).not.toBeNull();
    expect(t.at).not.toEqual([10, GROUND, -30]);
    for (const [q, y, r, id] of t.writes) if (id === B.COBBLESTONE) expect(world.getBlock(q, y, r)).toBe(B.AIR);
  });

  it('uprooted: the nearest natural tree within 8 — logs and its leaves gone, the root a hole over dirt; nothing else moves', () => {
    const { world, physics, fx } = physicsWorld();
    const near = plantTree(world, 0, 0);
    const far = plantTree(world, 4, 0); // canopies touch: shared-distance leaves stay with it
    // A player's hut nearby (a plank box on the ground, not touching the tree).
    for (let q = -5; q <= -4; q++) for (let y = FEET; y <= FEET + 2; y++) world.setBlock(q, y, 3, B.OAK_PLANKS);
    settle(physics);
    const [x, z] = hexToWorld(-2, -4);
    const t = planUproot(view(world, { x: 30, z: 30 }), x, FEET, z);
    expect(t.kind).toBe('uprooted');
    expect(t.at).toEqual([0, GROUND, 0]);
    const before = snapshot(world, -8, 10, 0, 22, -8, 8);
    apply(world, t);
    const n = world.writes.length;
    settle(physics);
    expect(world.writes.length).toBe(n); // physics wrote nothing on its own
    expect(fx.spawns).toEqual([]);
    expect(physics.trees.stats.toppled).toBe(0);
    expect(physics.support.stats.crumbled).toBe(0);
    for (const [q, y, r] of near.logs) expect(world.getBlock(q, y, r)).toBe(B.AIR);
    expect(world.getBlock(0, GROUND, 0)).toBe(B.AIR); // the root: a hole …
    expect(world.getBlock(0, GROUND - 1, 0)).toBe(B.DIRT); // … over dirt
    // The other tree is whole, and every cell not written by the trace is as it was.
    for (const [q, y, r] of far.logs) expect(world.getBlock(q, y, r)).toBe(B.OAK_LOG);
    for (const [q, y, r] of far.leaves) expect(world.getBlock(q, y, r)).toBe(B.OAK_LEAVES);
    const written = new Set(t.writes.map(([q, y, r]) => `${q},${y},${r}`));
    for (const [k, id] of before) if (!written.has(k)) expect(world.getBlock(...k.split(',').map(Number))).toBe(id);
    // Of the near tree's leaves, only those as near the other trunk are left.
    for (const [q, y, r] of near.leaves) {
      if (world.getBlock(q, y, r) === B.AIR) continue;
      expect(hexLength(q - 4, r)).toBeLessThanOrEqual(hexLength(q, r));
    }
  });

  it('uprooted: refuses a tree with a build against its trunk (it would bring the build down) — the next one is taken', () => {
    const { world, physics, fx } = physicsWorld();
    plantTree(world, 0, 0);
    world.setBlock(1, FEET + 2, 0, B.OAK_PLANKS); // a plank shelf nailed to the trunk
    world.setBlock(2, FEET + 2, 0, B.OAK_PLANKS);
    settle(physics);
    expect(planUprootAt(view(world, { x: 30, z: 30 }), 0, GROUND, 0)).toBeNull();
    const [x, z] = hexToWorld(0, -3);
    expect(planUproot(view(world, { x: 30, z: 30 }), x, FEET, z)).toBeNull();
    const other = plantTree(world, -5, -2);
    const t = planUproot(view(world, { x: 30, z: 30 }), x, FEET, z);
    expect(t.at).toEqual([-5, GROUND, -2]);
    apply(world, t);
    settle(physics);
    expect(fx.spawns).toEqual([]);
    for (const [q, y, r] of other.logs) expect(world.getBlock(q, y, r)).toBe(B.AIR);
    expect(world.getBlock(1, FEET + 2, 0)).toBe(B.OAK_PLANKS);
    expect(world.getBlock(0, FEET, 0)).toBe(B.OAK_LOG);
  });

  it('uprooted: only natural trees within 8 (an edited trunk, a player\'s log pillar or a far tree are left alone)', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    for (let y = FEET; y < FEET + 5; y++) world.setBlock(0, y, 0, B.OAK_LOG); // a player's pillar of logs
    world.setBlock(0, FEET + 5, 0, B.OAK_LEAVES);
    plantTree(world, 12, 0); // 12 away
    const [x, z] = hexToWorld(0, 0);
    expect(planUproot(view(world, { x: 40, z: 40 }), x, FEET, z)).toBeNull();
    expect(WATCHER_TREE_RANGE).toBe(8);
  });

  it('no trace writes within 16 of the spawn point; planTrace falls back through the kinds and may find none', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    plantTree(world, 2, 0);
    const [x, z] = hexToWorld(0, 0);
    const v = view(world, { x: 40, z: 40, spawn: [x + 3, z] });
    expect(planPillar(v, x, FEET, z, mulberry32(1))).toBeNull();
    expect(planDeadFire(v, x, FEET, z, mulberry32(1))).toBeNull();
    expect(planUproot(v, x, FEET, z)).toBeNull();
    expect(planTrace(v, x, FEET, z, mulberry32(1))).toBeNull();
    expect(WATCHER_SPAWN_CLEAR).toBe(16);
    // Away from spawn the same spot has all three; planTrace takes the kinds in random order.
    const v2 = view(world, { x: 40, z: 40, spawn: [200, 200] });
    const seen = new Set();
    for (let seed = 1; seed <= 40; seed++) seen.add(planTrace(v2, x, FEET, z, mulberry32(seed)).kind);
    expect([...seen].sort()).toEqual(['deadfire', 'pillar', 'uprooted']);
    // Only the uprooting allowed, and no tree: none.
    const bare = view(makeFakeWorld({ groundY: GROUND }), { x: 40, z: 40 });
    expect(planTrace(bare, x, FEET, z, mulberry32(1), ['uprooted'])).toBeNull();
  });

  it('never into a creature\'s cell', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const [x, z] = hexToWorld(10, -30);
    const v = view(world, { occupied: (q, y, r) => q === 10 && r === -30 && y >= FEET && y < FEET + 2 });
    const t = planPillar(v, x, FEET, z, mulberry32(1));
    expect(t.at).not.toEqual([10, FEET, -30]);
  });

  it('a summoned Watcher that vanishes leaves the trace main applies: here, the tree beside it is torn out', () => {
    const { world, physics, fx } = physicsWorld();
    const tree = plantTree(world, 3, -40);
    const v = view(world);
    // Rolls: the wisp timer, then the trace roll (0: yes), then the kind shuffle (uprooted to the front, then kept).
    const w = new Watcher(seq([0.5, 0, 0, 0.99]));
    w.summonAt(v, 0, FEET, -40);
    moveTo(v, w.figure.x, FEET, w.figure.z + 15);
    const gone = w.update(0.1, v).vanished;
    expect(gone.reason).toBe('near');
    expect(gone.trace.kind).toBe('uprooted');
    apply(world, gone.trace);
    settle(physics);
    expect(fx.spawns).toEqual([]);
    for (const [q, y, r] of tree.logs) expect(world.getBlock(q, y, r)).toBe(B.AIR);
    for (const [q, y, r] of tree.leaves) expect(isLeaves(world.getBlock(q, y, r))).toBe(false);
    expect(isLog(world.getBlock(3, FEET, -40))).toBe(false);
  });
});

// Play-test: an uprooting turned a player's block under a tree's root into DIRT (deleting a Rune Block), and obsidian
// pillars filled player-dug shafts. A trace only ever changes untouched natural terrain and natural trees: every cell it
// writes, and every cell it relies on, has no edit.
describe('traces leave whatever the player made alone (play-test)', () => {
  it('uprooted: a player\'s block under the root (a Rune Block, planks) is never turned to dirt — that tree stays', () => {
    for (const id of [B.RUNE_BLOCK, B.OAK_PLANKS]) {
      const world = makeFakeWorld({ groundY: GROUND });
      const tree = plantTree(world, 0, 0);
      expect(world.setBlock(0, GROUND - 1, 0, id)).toBe(true); // the player's block, right under the root
      const v = view(world, { x: 30, z: 30 });
      expect(planUprootAt(v, 0, GROUND, 0)).toBeNull();
      const [x, z] = hexToWorld(0, -3);
      expect(planUproot(v, x, FEET, z)).toBeNull(); // no other tree in range
      expect(planTrace(v, x, FEET, z, mulberry32(1), ['uprooted'])).toBeNull();
      // Another (untouched) tree nearby is taken instead; the player's block and the first tree are left as they were.
      const other = plantTree(world, -5, -2);
      const t = planUproot(v, x, FEET, z);
      expect(t.at).toEqual([-5, GROUND, -2]);
      apply(world, t);
      expect(world.getBlock(0, GROUND - 1, 0)).toBe(id);
      for (const [q, y, r] of tree.logs) expect(world.getBlock(q, y, r)).toBe(B.OAK_LOG);
      for (const [q, y, r] of other.logs) expect(world.getBlock(q, y, r)).toBe(B.AIR);
    }
  });

  it('uprooted: not a tree with a player\'s block against its root, or with gravel the player dropped on its canopy', () => {
    // A plank set into the ground right beside the root (the root would be cut out from under its side) …
    const a = makeFakeWorld({ groundY: GROUND });
    plantTree(a, 0, 0);
    a.setBlock(1, GROUND, 0, B.OAK_PLANKS);
    expect(planUprootAt(view(a, { x: 30, z: 30 }), 0, GROUND, 0)).toBeNull();
    // … or the player's gravel resting on a canopy leaf: tearing the leaf out would drop it.
    const { world, physics, fx } = physicsWorld();
    const tree = plantTree(world, 0, 0);
    const top = Math.max(...tree.leaves.map((c) => c[1]));
    const [lq, , lr] = tree.leaves.find((c) => c[1] === top);
    expect(world.setBlock(lq, top + 1, lr, B.GRAVEL)).toBe(true);
    settle(physics);
    expect(fx.spawns).toEqual([]); // it rests on the leaf
    expect(planUprootAt(view(world, { x: 30, z: 30 }), 0, GROUND, 0)).toBeNull();
  });

  it('pillar: never fills a player-dug shaft (edited AIR) — it stands on untouched ground beside it', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const [x, z] = hexToWorld(10, -30);
    for (let y = GROUND; y >= GROUND - 2; y--) expect(world.setBlock(10, y, -30, B.AIR)).toBe(true); // 3 deep, where it stood
    for (let seed = 1; seed <= 30; seed++) {
      const t = planPillar(view(world), x, FEET, z, mulberry32(seed));
      expect(t).not.toBeNull();
      expect([t.at[0], t.at[2]]).not.toEqual([10, -30]);
      for (const [q, y, r] of t.writes) expect(world.hasEdit(q, y, r)).toBe(false);
      expect(world.isNaturalGround(t.at[0], t.at[1] - 1, t.at[2])).toBe(true);
    }
    // Shafts in every cell within 3 of it: no pillar at all.
    for (let dq = -3; dq <= 3; dq++) {
      for (let dr = -3; dr <= 3; dr++) {
        if (hexLength(dq, dr) > 3) continue;
        for (let y = GROUND; y >= GROUND - 6; y--) world.setBlock(10 + dq, y, -30 + dr, B.AIR);
      }
    }
    expect(planPillar(view(world), x, FEET, z, mulberry32(1))).toBeNull();
  });

  it('dead campfire: never in a pit the player dug, never on a player\'s block', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const [x, z] = hexToWorld(10, -30);
    world.setBlock(10, GROUND, -30, B.AIR); // a seven-cell pit, one deep, where it stood
    for (const [dq, dr] of HEX_DIRS) world.setBlock(10 + dq, GROUND, -30 + dr, B.AIR);
    let t = planDeadFire(view(world), x, FEET, z, mulberry32(2));
    expect(t).not.toBeNull();
    expect(t.at).not.toEqual([10, GROUND - 1, -30]);
    for (const [q, y, r] of t.writes) expect(world.hasEdit(q, y, r)).toBe(false);
    // The player's planks under the cell that would turn to ash: the gravel would rest on them.
    const w2 = makeFakeWorld({ groundY: GROUND });
    w2.setBlock(10, GROUND - 1, -30, B.OAK_PLANKS);
    t = planDeadFire(view(w2), x, FEET, z, mulberry32(2));
    expect(t).not.toBeNull();
    expect(t.at).not.toEqual([10, GROUND, -30]);
    expect(w2.hasEdit(t.at[0], t.at[1] - 1, t.at[2])).toBe(false);
  });

  it('whatever the player dug or built around it, no trace writes an edited cell or stands on one (randomised)', () => {
    const PLAYER_IDS = [B.AIR, B.AIR, B.AIR, B.OAK_PLANKS, B.RUNE_BLOCK, B.STONE, B.GRAVEL, B.OAK_LEAVES, B.OAK_LOG];
    let checked = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const rng = mulberry32(seed);
      const world = makeFakeWorld({ groundY: GROUND });
      for (let k = 0; k < 4; k++) {
        const q = Math.floor(rng() * 13) - 6;
        const r = Math.floor(rng() * 13) - 6;
        if (world.getBlock(q, FEET, r) === B.AIR) plantTree(world, q, r, 4 + Math.floor(rng() * 3));
      }
      for (let k = 0; k < 160; k++) {
        const q = Math.floor(rng() * 15) - 7;
        const r = Math.floor(rng() * 15) - 7;
        const y = GROUND - 4 + Math.floor(rng() * 14);
        world.setBlock(q, y, r, PLAYER_IDS[Math.floor(rng() * PLAYER_IDS.length)]);
      }
      const v = view(world, { x: 60, z: 60 });
      const [x, z] = hexToWorld(Math.floor(rng() * 5) - 2, Math.floor(rng() * 5) - 2);
      for (const kind of TRACE_KINDS) {
        const t = planTrace(v, x, FEET, z, mulberry32(seed * 7), [kind]);
        if (!t) continue;
        checked++;
        const written = new Set(t.writes.map(([q, y, r]) => `${q},${y},${r}`));
        for (const [q, y, r] of t.writes) expect(world.hasEdit(q, y, r), `${kind} writes edited ${q},${y},${r}`).toBe(false);
        const [aq, ay, ar] = t.at;
        if (kind === 'pillar') expect(world.isNaturalGround(aq, ay - 1, ar)).toBe(true);
        if (kind === 'deadfire') expect(world.hasEdit(aq, ay - 1, ar)).toBe(false); // under the ash
        if (kind === 'uprooted') {
          expect(world.hasEdit(aq, ay - 1, ar)).toBe(false); // under the root
          // Nothing the player put there rests on a cell it takes away.
          for (const [q, y, r, id] of t.writes) {
            if (id !== B.AIR || written.has(`${q},${y + 1},${r}`)) continue;
            if (world.getBlock(q, y + 1, r) !== B.AIR) expect(world.hasEdit(q, y + 1, r)).toBe(false);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('review follow-ups', () => {
  it('uprooting never drops what the player set on the canopy through the leaf decay that follows (§40.3, §36.6.1)', () => {
    // A log and gravel the player set on natural canopy leaves. Kept "for another log" (the player's own log), those leaves
    // used to survive the trace and then decay once the trunk was gone, and both blocks fell to the ground.
    const { world, physics } = physicsWorld();
    plantTree(world, 0, 0); // trunk 11 … 15, canopy 14 … 17
    const top = 15;
    physics.asPlayer(() => world.setBlock(1, top + 2, 0, B.OAK_LOG)); // on the leaf (1, top + 1, 0)
    physics.asPlayer(() => world.setBlock(2, top + 1, -1, B.GRAVEL)); // on the leaf (2, top, −1)
    settle(physics);
    expect(world.getBlock(1, top + 2, 0)).toBe(B.OAK_LOG);
    expect(world.getBlock(2, top + 1, -1)).toBe(B.GRAVEL);
    const v = view(world, { x: 60, z: 60 });
    expect(planUprootAt(v, 0, GROUND, 0)).toBeNull(); // that tree is left standing
    // With only the gravel: the leaf under it now belongs to this tree, and something the player placed rests on it.
    const b = physicsWorld();
    plantTree(b.world, 0, 0);
    b.physics.asPlayer(() => b.world.setBlock(2, top + 1, -1, B.GRAVEL));
    settle(b.physics);
    expect(planUprootAt(view(b.world, { x: 60, z: 60 }), 0, GROUND, 0)).toBeNull();
  });

  it('a tree with nothing of the player on it is still uprooted, and nothing else falls afterwards', () => {
    const { world, physics } = physicsWorld();
    plantTree(world, 0, 0);
    plantTree(world, 5, 0); // a neighbour whose canopy leaves stay with it
    physics.asPlayer(() => world.setBlock(9, FEET, 4, B.STONE_BRICKS)); // a build elsewhere
    settle(physics);
    const t = planUprootAt(view(world, { x: 60, z: 60 }), 0, GROUND, 0);
    expect(t).not.toBeNull();
    apply(world, t);
    settle(physics);
    for (let y = GROUND + 1; y <= 15; y++) expect(world.getBlock(5, y, 0)).toBe(B.OAK_LOG); // the neighbour stands
    expect(world.getBlock(9, FEET, 4)).toBe(B.STONE_BRICKS);
  });

  it('while sprinting, "seen" uses the camera\'s real (wider) view: a figure drawn at the edge is not "unseen"', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const w = new Watcher(() => 0.5);
    const v = view(world, { time: 0.9 });
    v.fov = 70; // main: min(camera fov, FOV) — for placement only
    v.viewFov = 80; // the sprint FOV the camera draws with now
    v.aspect = 16 / 9;
    const f = w.summonAt(v, 0, FEET, -40);
    expect(f).not.toBeNull();
    const yawTo = Math.atan2(-(f.x - v.eye[0]), -(f.z - v.eye[2]));
    v.yaw = yawTo + 52 * DEG;
    v.look = lookDirection(v.yaw, 0);
    const ndc = project(v, f.x, f.y + WATCHER_EYE_Y, f.z, 80, 16 / 9);
    expect(Math.abs(ndc[0])).toBeLessThan(1); // drawn on screen by the 80° camera …
    expect(Math.abs(project(v, f.x, f.y + WATCHER_EYE_Y, f.z, 70, 16 / 9)[0])).toBeGreaterThan(1); // … not by a 70° one
    let gone = null;
    for (let t = 0; t < WATCHER_UNSEEN_S + 1 && !gone; t += 0.5) gone = w.update(0.5, v).vanished;
    expect(gone).toBeNull(); // it used to vanish 'unseen' while on screen
    expect(f.seen).toBe(true);
  });

  it('rewinding the clock (`time set` keeps the day) never brings a second sighting in the night the player is in', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const w = new Watcher(() => 0); // every roll comes up
    const v = view(world, { time: 0.875, day: 5 }); // 21:00 on day 5
    v.fov = 70;
    v.aspect = 16 / 9;
    const a = w.update(WATCHER_CHECK_S, v).appeared;
    expect(a).not.toBeNull();
    expect(w.lastNight).toBe(5);
    v.player.x = a.x; // the player walks up to it: gone
    v.player.z = a.z + 10;
    w.update(0.1, v);
    expect(w.present).toBe(false);
    v.player.x = 0;
    v.player.z = 0;
    v.time = 0; // `time set midnight`: 00:00 on day 5 — key 4, the same dark night
    for (let i = 0; i < 4; i++) expect(w.update(WATCHER_CHECK_S, v).appeared).toBeNull();
    expect(w.lastNight).toBe(4); // a remembered night ahead of the clock counts as tonight …
    v.time = 0.85; // … and the next evening (day 5, key 5) may bring one again
    expect(w.update(WATCHER_CHECK_S, v).appeared).not.toBeNull();
  });

  it('a saved night ahead of the clock (a bad save) blocks only tonight, not the nights to come', () => {
    const world = makeFakeWorld({ groundY: GROUND });
    const w = new Watcher(() => 0);
    expect(w.setLastNight(999)).toBe(true);
    const v = view(world, { time: 0.9, day: 3 });
    v.fov = 70;
    v.aspect = 16 / 9;
    expect(w.update(WATCHER_CHECK_S, v).appeared).toBeNull();
    expect(w.lastNight).toBe(3);
    v.day = 4;
    expect(w.update(WATCHER_CHECK_S, v).appeared).not.toBeNull();
  });
});

describe('figure geometry constants', () => {
  it('2.6 tall, eyes near the top, centre at half height', () => {
    expect(WATCHER_HEIGHT).toBeCloseTo(2.6, 9);
    expect(WATCHER_EYE_Y).toBeGreaterThan(WATCHER_HEIGHT - 0.3);
    expect(WATCHER_EYE_Y).toBeLessThan(WATCHER_HEIGHT);
    expect(WATCHER_CENTRE_Y).toBeCloseTo(1.3, 9);
  });
});
