// Unit tests for src/physics.js — a vertical cylinder against the honeycomb of hexagonal prisms (CONTRACTS §12).
import { describe, it, expect, vi } from 'vitest';
import {
  PLAYER_WIDTH, PLAYER_HEIGHT, EYE_HEIGHT, SNEAK_EYE_HEIGHT, GRAVITY, JUMP_VELOCITY, TERMINAL_VELOCITY,
  WALK_SPEED, SPRINT_SPEED, SNEAK_SPEED, FLY_SPEED, FLY_SPRINT_SPEED, FLY_VERTICAL_SPEED, WATER_MAX_SINK,
  SWIM_UP_SPEED, SWIM_EXIT_JUMP, WATER_SPEED_FACTOR, WATER_SURFACE_HEIGHT, MAX_FRAME_DT, MAX_SUBSTEP_DT,
  COLLISION_EPS, WORLD_HEIGHT,
} from '../../src/config.js';
import { yawToForward } from '../../src/coords.js';
import {
  HEX_INRADIUS, HEX_SIZE, FACE_NORMALS, SIDE_FACE_COUNT, hexToWorld, worldToHex, hexNeighbor, hexLength,
} from '../../src/hex.js';
import { BLOCK } from '../../src/blocks.js';
import { flatGetBlock } from '../helpers/fixtures.js';
import {
  createPlayer, stepPlayer, getEyeHeight, playerAABB, playerIntersectsBlock, findStandingY, PLAYER_RADIUS,
} from '../../src/physics.js';

const DT = 1 / 60;
const GROUND = 4;          // flatGetBlock(4): solid for y <= 4, so feet rest at y = 5
const FEET = GROUND + 1;
/** Distance between the player centre and a wall cell's centre when resting against its face. */
const REST = HEX_INRADIUS + PLAYER_RADIUS;

/** @returns {import('../../src/types.js').PlayerInput} */
function input(over = {}) {
  return { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0, ...over };
}

/** Step `n` times with a fixed input; optional per-step observer. */
function run(p, inp, getBlock, n, dt = DT, observe) {
  for (let i = 0; i < n; i++) {
    stepPlayer(p, inp, getBlock, dt);
    if (observe) observe(p, i);
  }
  return p;
}

/** Yaw whose forward vector points along the horizontal direction (dx, dz). */
function yawToward(dx, dz) {
  return Math.atan2(-dx, -dz);
}

/** Flat floor up to GROUND plus extra solid cells ("q,y,r" strings → id, STONE by default). */
function floorWith(cells, id = BLOCK.STONE) {
  const set = cells instanceof Map ? cells : new Map([...cells].map((c) => (Array.isArray(c) ? c : [c, id])));
  return (q, y, r) => {
    if (y < 0 || y >= WORLD_HEIGHT) return BLOCK.AIR;
    if (y <= GROUND) return BLOCK.STONE;
    return set.get(`${q},${y},${r}`) ?? BLOCK.AIR;
  };
}

/** A player standing at the centre of cell (q, r) with feet at `y`. */
function playerAtCell(q, r, y = FEET) {
  const [x, z] = hexToWorld(q, r);
  return createPlayer(x, y, z);
}

/** Signed distance from the player centre to the plane of face `j` of the cell centred at (cx, cz). */
function planeDistance(p, cx, cz, j) {
  const n = FACE_NORMALS[j];
  return (p.x - cx) * n[0] + (p.z - cz) * n[2];
}

describe('constants / createPlayer / getEyeHeight', () => {
  it('exports the footprint radius and keeps it below the cell inradius (7-column collider)', () => {
    expect(PLAYER_RADIUS).toBe(PLAYER_WIDTH / 2);
    expect(PLAYER_RADIUS).toBeLessThan(HEX_INRADIUS);
    // Must also fit through the HEX_SIZE-wide throat of a 1-cell passage (two wall corners pinch every shared edge).
    expect(PLAYER_RADIUS).toBeLessThan(HEX_SIZE / 2);
  });

  it('creates a player at the feet position with zeroed velocities and flags', () => {
    const p = createPlayer(1.5, 70, -2.5);
    expect(p).toEqual({
      x: 1.5, y: 70, z: -2.5, vx: 0, vy: 0, vz: 0,
      onGround: false, flying: false, sneaking: false, sprinting: false, inWater: false, headInWater: false, hitWall: false,
    });
  });

  it('eye height follows sneaking unless flying', () => {
    const p = createPlayer(0, 0, 0);
    expect(getEyeHeight(p)).toBe(EYE_HEIGHT);
    p.sneaking = true;
    expect(getEyeHeight(p)).toBe(SNEAK_EYE_HEIGHT);
    p.flying = true;
    expect(getEyeHeight(p)).toBe(EYE_HEIGHT);
  });
});

describe('playerAABB / playerIntersectsBlock', () => {
  it('builds the bounding box of the cylinder around the feet position and reuses `out`', () => {
    const p = createPlayer(10, 20, -30);
    const out = {};
    expect(playerAABB(p, out)).toBe(out);
    expect(out).toEqual({
      minX: 10 - PLAYER_RADIUS, maxX: 10 + PLAYER_RADIUS,
      minY: 20, maxY: 20 + PLAYER_HEIGHT,
      minZ: -30 - PLAYER_RADIUS, maxZ: -30 + PLAYER_RADIUS,
    });
  });

  it('intersects the cells its own column overlaps in height, strictly', () => {
    const p = playerAtCell(0, 0, FEET);
    expect(playerIntersectsBlock(p, 0, FEET, 0)).toBe(true);
    expect(playerIntersectsBlock(p, 0, FEET + 1, 0)).toBe(true);
    expect(playerIntersectsBlock(p, 0, FEET - 1, 0)).toBe(false); // the cell it stands on (touching)
    expect(playerIntersectsBlock(p, 0, Math.ceil(FEET + PLAYER_HEIGHT), 0)).toBe(false); // above the head
  });

  it('does not intersect a neighbouring column from the cell centre; strict at exactly PLAYER_RADIUS from the face', () => {
    for (let j = 0; j < SIDE_FACE_COUNT; j++) {
      const [nq, nr] = hexNeighbor(0, 0, j);
      const n = FACE_NORMALS[j];
      const p = playerAtCell(0, 0);
      expect(playerIntersectsBlock(p, nq, FEET, nr), `centre, dir ${j}`).toBe(false);
      // Move toward the neighbour until the circle touches its face plane (distance 1 - REST): a hair short
      // of touching is not an intersection, a hair past it is (exact touching is float-ambiguous).
      const touch = 1 - REST;
      p.x = n[0] * (touch - 1e-7);
      p.z = n[2] * (touch - 1e-7);
      expect(playerIntersectsBlock(p, nq, FEET, nr), `touching, dir ${j}`).toBe(false);
      p.x = n[0] * (touch + 1e-7);
      p.z = n[2] * (touch + 1e-7);
      expect(playerIntersectsBlock(p, nq, FEET, nr), `overlapping, dir ${j}`).toBe(true);
    }
  });

  it('handles rows with the half-cell offset and negative coordinates', () => {
    // Cell (-3, -4) and its SE neighbour (-3, -3) are one row apart and offset by half a cell in x.
    const p = playerAtCell(-3, -4);
    const [cx, cz] = hexToWorld(-3, -4);
    const [nx2, nz2] = hexToWorld(-3, -3);
    expect(nx2 - cx).toBeCloseTo(0.5, 12);
    expect(nz2 - cz).toBeCloseTo(Math.sqrt(3) / 2, 12);
    expect(playerIntersectsBlock(p, -3, FEET, -3)).toBe(false);
    p.x = cx + (nx2 - cx) * 0.25;
    p.z = cz + (nz2 - cz) * 0.25; // 0.25 along the centre line: face plane is 0.25 away, < PLAYER_RADIUS
    expect(playerIntersectsBlock(p, -3, FEET, -3)).toBe(true);
    expect(playerIntersectsBlock(p, -3, FEET, -4)).toBe(true);
    expect(playerIntersectsBlock(p, -2, FEET, -4)).toBe(false);
  });
});

describe('falling and landing', () => {
  const floor = flatGetBlock(GROUND);

  it('lands from 3 above the floor at FEET + COLLISION_EPS with vy 0 and onGround, never penetrating', () => {
    const p = playerAtCell(2, -1, FEET + 3);
    run(p, input(), floor, 120, DT, (q) => expect(q.y).toBeGreaterThanOrEqual(FEET));
    expect(p.y).toBeCloseTo(FEET + COLLISION_EPS, 9);
    expect(p.vy).toBe(0);
    expect(p.onGround).toBe(true);
    const [x, z] = hexToWorld(2, -1);
    expect(p.x).toBe(x);
    expect(p.z).toBe(z);
  });

  it('300 idle ticks keep a standing player exactly in place', () => {
    const p = playerAtCell(0, 0, FEET + 1);
    run(p, input(), floor, 60);
    const { x, y, z } = p;
    run(p, input(), floor, 300);
    expect(p.x).toBe(x);
    expect(p.y).toBe(y);
    expect(p.z).toBe(z);
    expect(p.onGround).toBe(true);
  });

  it('lands even when the footprint straddles a cell boundary (neighbour column supports it)', () => {
    // Centre of cell (0,0) moved 0.45 toward its east neighbour: the circle overlaps both columns.
    const p = createPlayer(0.45, FEET + 2, 0);
    const get = (q, y, r) => (y < 0 || y >= WORLD_HEIGHT ? BLOCK.AIR : y <= GROUND && q === 1 && r === 0 ? BLOCK.STONE : BLOCK.AIR);
    run(p, input(), get, 120);
    expect(p.onGround).toBe(true);
    expect(p.y).toBeCloseTo(FEET + COLLISION_EPS, 9);
  });

  it('free fall is clamped to TERMINAL_VELOCITY', () => {
    const p = createPlayer(0, WORLD_HEIGHT - 2, 0);
    run(p, input(), () => BLOCK.AIR, 300);
    expect(p.vy).toBeCloseTo(TERMINAL_VELOCITY, 9);
  });

  it('walking off the edge of a single supporting cell leaves the ground', () => {
    const get = (q, y, r) => (y < 0 || y >= WORLD_HEIGHT ? BLOCK.AIR : y <= GROUND && q === 0 && r === 0 ? BLOCK.STONE : BLOCK.AIR);
    const p = playerAtCell(0, 0, FEET);
    run(p, input(), get, 10);
    expect(p.onGround).toBe(true);
    run(p, input({ forward: 1, yaw: yawToward(1, 0) }), get, 90);
    expect(p.onGround).toBe(false);
    expect(p.y).toBeLessThan(FEET);
  });
});

describe('walls', () => {
  it('stops against a wall cell in each of the six side directions at REST from its centre, hitWall, no velocity into it', () => {
    for (let j = 0; j < SIDE_FACE_COUNT; j++) {
      const [wq, wr] = hexNeighbor(0, 0, j);
      const [wx, wz] = hexToWorld(wq, wr);
      const get = floorWith([`${wq},${FEET},${wr}`, `${wq},${FEET + 1},${wr}`]);
      const n = FACE_NORMALS[j];
      const p = playerAtCell(0, 0);
      const inp = input({ forward: 1, yaw: yawToward(n[0], n[2]) });
      let sawWall = false;
      run(p, inp, get, 120, DT, (q) => {
        sawWall = sawWall || q.hitWall;
      });
      expect(sawWall, `dir ${j}`).toBe(true);
      expect(p.hitWall).toBe(true);
      // Resting against the face: plane distance = -(HEX_INRADIUS + PLAYER_RADIUS) (minus the resting gap).
      const dist = planeDistance(p, wx, wz, (j + 3) % 6);
      expect(Math.abs(dist - REST)).toBeLessThan(2e-4);
      // No velocity into the wall, (practically) none along it either.
      expect(Math.abs(p.vx * n[0] + p.vz * n[2])).toBeLessThan(1e-6);
      expect(Math.hypot(p.vx, p.vz)).toBeLessThan(1e-3);
      expect(p.onGround).toBe(true);
      expect(p.y).toBeCloseTo(FEET + COLLISION_EPS, 9);
    }
  });

  it('removes only the normal velocity component so the player slides along the face', () => {
    const get = floorWith([`1,${FEET},0`, `1,${FEET + 1},0`]); // east neighbour: face plane x = 0.5
    const p = playerAtCell(0, 0);
    const inp = input({ forward: 1, yaw: yawToward(1, 1) }); // diagonal: +X and +Z
    let first = null;
    run(p, inp, get, 60, DT, (q) => {
      if (first === null && q.hitWall) first = { x: q.x, z: q.z, vx: q.vx, vz: q.vz };
    });
    expect(first).not.toBeNull();
    expect(first.x).toBeLessThanOrEqual(HEX_INRADIUS - PLAYER_RADIUS + 1e-9);
    expect(first.x).toBeGreaterThan(HEX_INRADIUS - PLAYER_RADIUS - 1e-3);
    expect(Math.abs(first.vx)).toBeLessThan(1e-6);
    expect(first.vz).toBeGreaterThan(0.5);
    // Keeps moving +Z afterwards.
    expect(p.z).toBeGreaterThan(first.z + 0.2);
  });

  it('a wall only at head height still blocks; a cell above the head does not', () => {
    const headOnly = floorWith([`1,${FEET + 1},0`]);
    const p = playerAtCell(0, 0);
    run(p, input({ forward: 1, yaw: yawToward(1, 0) }), headOnly, 120);
    expect(p.hitWall).toBe(true);
    expect(p.x).toBeCloseTo(1 - REST, 3);

    const aboveHead = floorWith([`1,${Math.ceil(FEET + PLAYER_HEIGHT)},0`]);
    const p2 = playerAtCell(0, 0);
    run(p2, input({ forward: 1, yaw: yawToward(1, 0) }), aboveHead, 120);
    expect(p2.hitWall).toBe(false);
    expect(p2.x).toBeGreaterThan(1.5);
  });

  it('walls at negative coordinates, approached from the far side', () => {
    const q0 = -5;
    const r0 = -8;
    const [wq, wr] = hexNeighbor(q0, r0, 3); // west neighbour
    const [wx, wz] = hexToWorld(wq, wr);
    const get = floorWith([`${wq},${FEET},${wr}`, `${wq},${FEET + 1},${wr}`]);
    const p = playerAtCell(q0, r0);
    run(p, input({ forward: 1, yaw: yawToward(-1, 0) }), get, 120);
    expect(p.hitWall).toBe(true);
    expect(p.x - wx).toBeCloseTo(REST, 3);
    expect(p.z - wz).toBeCloseTo(0, 6);
  });

  it('walking away from the wall clears hitWall', () => {
    const get = floorWith([`1,${FEET},0`, `1,${FEET + 1},0`]);
    const p = playerAtCell(0, 0);
    run(p, input({ forward: 1, yaw: yawToward(1, 0) }), get, 60);
    expect(p.hitWall).toBe(true);
    run(p, input({ forward: -1, yaw: yawToward(1, 0) }), get, 5);
    expect(p.hitWall).toBe(false);
  });

  it('a player placed inside a solid cell is pushed out of it', () => {
    const get = floorWith([`0,${FEET},0`, `0,${FEET + 1},0`]);
    // Grounded: the vertical pass runs first and pops the player onto the top of the two-cell pillar.
    const p = createPlayer(0.1, FEET, 0.05);
    run(p, input({ forward: 1, yaw: yawToward(1, 0) }), get, 5);
    expect(playerIntersectsBlock(p, 0, FEET, 0)).toBe(false);
    expect(playerIntersectsBlock(p, 0, FEET + 1, 0)).toBe(false);
    expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    // Hovering (no vertical motion): the horizontal pass pushes the footprint out through the nearest face.
    const f = createPlayer(0.1, FEET, 0.05);
    f.flying = true;
    let pushed = false;
    run(f, input({ forward: 1, yaw: yawToward(1, 0) }), get, 5, DT, (s) => {
      pushed = pushed || s.hitWall;
    });
    const [q, r] = worldToHex(f.x, f.z);
    expect(q === 0 && r === 0).toBe(false);
    expect(playerIntersectsBlock(f, 0, FEET, 0)).toBe(false);
    expect(playerIntersectsBlock(f, 0, FEET + 1, 0)).toBe(false);
    expect(pushed).toBe(true); // the push-out step counts as a wall contact
  });
});

describe('sub-stepping / no tunnelling', () => {
  it('a terminal-velocity fall with dt = 0.5 never passes through the floor', () => {
    const floor = flatGetBlock(GROUND);
    const p = createPlayer(0.2, 100, -0.1);
    p.vy = TERMINAL_VELOCITY;
    run(p, input(), floor, 40, 0.5, (q) => expect(q.y).toBeGreaterThanOrEqual(FEET));
    expect(p.onGround).toBe(true);
    expect(p.y).toBeCloseTo(FEET + COLLISION_EPS, 9);
  });

  it('flying at sprint speed into a one-cell-thick wall with dt = 0.5 never ends up past it', () => {
    // Wall: every cell with q === 3 (a zigzag line one cell thick); the player at z ≈ 0 meets cell (3, 0).
    const get = (q, y, r) => (y < 0 || y >= WORLD_HEIGHT ? BLOCK.AIR : q === 3 && Math.abs(r) <= 3 ? BLOCK.STONE : BLOCK.AIR);
    const p = createPlayer(0, 40, 0);
    p.flying = true;
    const inp = input({ forward: 1, sprint: true, yaw: yawToward(1, 0) });
    run(p, inp, get, 60, 0.5, (q) => expect(q.x).toBeLessThan(3 - HEX_INRADIUS));
    expect(p.hitWall).toBe(true);
    expect(p.x).toBeCloseTo(3 - REST, 3);
    expect(p.flying).toBe(true);
  });

  it('clamps dt to MAX_FRAME_DT and splits it into equal substeps', () => {
    const floor = flatGetBlock(GROUND);
    const a = playerAtCell(0, 0, FEET);
    const b = playerAtCell(0, 0, FEET);
    run(a, input({ forward: 1 }), floor, 1, 5); // clamped to MAX_FRAME_DT
    run(b, input({ forward: 1 }), floor, Math.round(MAX_FRAME_DT / MAX_SUBSTEP_DT), MAX_SUBSTEP_DT);
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(a.z).toBeCloseTo(b.z, 9);
    expect(a.vz).toBeCloseTo(b.vz, 9);
  });
});

describe('jumping and ceilings', () => {
  const floor = flatGetBlock(GROUND);

  it('jump apex at 60 Hz is within [1.2, 1.4] cells; cannot jump again while airborne', () => {
    const p = playerAtCell(0, 0, FEET);
    run(p, input(), floor, 10);
    let apex = 0;
    let risingAgain = false;
    let lastVy = 0;
    run(p, input({ jump: true }), floor, 120, DT, (q) => {
      apex = Math.max(apex, q.y - FEET);
      if (!q.onGround && lastVy < 0 && q.vy > lastVy + GRAVITY * DT + 1e-6) risingAgain = true;
      lastVy = q.vy;
    });
    expect(apex).toBeGreaterThanOrEqual(1.2);
    expect(apex).toBeLessThanOrEqual(1.4);
    expect(risingAgain).toBe(false);
    expect(JUMP_VELOCITY).toBeGreaterThan(0);
  });

  it('a ceiling two cells above the floor stops the head at nearestMin - PLAYER_HEIGHT - COLLISION_EPS', () => {
    const ceilY = FEET + 2;
    const cells = [`0,${ceilY},0`];
    for (let j = 0; j < 6; j++) {
      const [q, r] = hexNeighbor(0, 0, j);
      cells.push(`${q},${ceilY},${r}`);
    }
    const get = floorWith(cells);
    const p = playerAtCell(0, 0, FEET);
    run(p, input(), get, 5);
    let maxY = -Infinity;
    run(p, input({ jump: true }), get, 90, DT, (q) => {
      maxY = Math.max(maxY, q.y);
    });
    const limit = ceilY - PLAYER_HEIGHT - COLLISION_EPS;
    expect(maxY).toBeLessThanOrEqual(limit + 1e-9);
    expect(maxY).toBeGreaterThan(limit - 1e-3);
    expect(p.y).toBeCloseTo(FEET + COLLISION_EPS, 6); // came back down and is standing again
  });
});

describe('flying', () => {
  const floor = flatGetBlock(GROUND);

  it('hovers without input, ascends with jump and descends with sneak at FLY_VERTICAL_SPEED', () => {
    const p = playerAtCell(0, 0, FEET + 5);
    p.flying = true;
    run(p, input(), floor, 60);
    expect(p.y).toBeCloseTo(FEET + 5, 9);
    run(p, input({ jump: true }), floor, 60);
    expect(p.vy).toBeCloseTo(FLY_VERTICAL_SPEED, 3);
    run(p, input({ sneak: true }), floor, 60);
    expect(p.vy).toBeCloseTo(-FLY_VERTICAL_SPEED, 3);
    expect(p.sneaking).toBe(false); // sneak does not count as sneaking while flying
  });

  it('moves at FLY_SPEED, and FLY_SPRINT_SPEED when sprinting forward', () => {
    const p = playerAtCell(0, 0, FEET + 5);
    p.flying = true;
    run(p, input({ forward: 1 }), floor, 120);
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(FLY_SPEED, 3);
    run(p, input({ forward: 1, sprint: true }), floor, 120);
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(FLY_SPRINT_SPEED, 3);
  });

  it('landing while descending ends flight', () => {
    const p = playerAtCell(0, 0, FEET + 3);
    p.flying = true;
    run(p, input({ sneak: true }), floor, 120);
    expect(p.flying).toBe(false);
    expect(p.onGround).toBe(true);
    expect(p.y).toBeCloseTo(FEET + COLLISION_EPS, 9);
  });
});

describe('swimming', () => {
  const POOL_TOP = FEET + 2; // water cells FEET..POOL_TOP in the pool columns; surface at POOL_TOP + WATER_SURFACE_HEIGHT
  /** Flat floor; water in the column (0,0) and its neighbours from FEET up to `top`. */
  function pool(top = POOL_TOP, extra = []) {
    return (q, y, r) => {
      if (y < 0 || y >= WORLD_HEIGHT) return BLOCK.AIR;
      if (y <= GROUND) return BLOCK.STONE;
      for (const c of extra) if (c[0] === q && c[1] === y && c[2] === r) return BLOCK.STONE;
      if (y <= top && hexLength(q, r) <= 1) return BLOCK.WATER;
      return BLOCK.AIR;
    };
  }

  it('sets inWater / headInWater on the pool floor and sinks no faster than WATER_MAX_SINK', () => {
    const deep = pool(FEET + 20);
    const p = playerAtCell(0, 0, FEET + 15);
    run(p, input(), deep, 60);
    expect(p.inWater).toBe(true);
    expect(p.headInWater).toBe(true);
    expect(p.vy).toBeCloseTo(WATER_MAX_SINK, 9);
    run(p, input(), deep, 600);
    expect(p.onGround).toBe(true);
    expect(p.y).toBeCloseTo(FEET + COLLISION_EPS, 9);
  });

  it('headInWater honours the lowered surface of the topmost water cell', () => {
    const get = pool();
    const p = playerAtCell(0, 0, FEET);
    p.flying = true; // hold still at chosen heights
    const surface = POOL_TOP + WATER_SURFACE_HEIGHT;
    p.y = surface - EYE_HEIGHT - 0.01;
    run(p, input(), get, 1);
    expect(p.headInWater).toBe(true);
    p.y = surface - EYE_HEIGHT + 0.01;
    run(p, input(), get, 1);
    expect(p.headInWater).toBe(false);
    expect(p.inWater).toBe(true); // feet are still in the water
  });

  it('holding jump swims up at SWIM_UP_SPEED, and SWIM_EXIT_JUMP when pressed against a wall', () => {
    const deep = pool(FEET + 20);
    const p = playerAtCell(0, 0, FEET + 5);
    run(p, input({ jump: true }), deep, 5);
    expect(p.vy).toBeCloseTo(SWIM_UP_SPEED, 9);

    const withWall = pool(FEET + 20, [[1, FEET + 5, 0], [1, FEET + 6, 0], [1, FEET + 7, 0]]);
    const p2 = playerAtCell(0, 0, FEET + 5);
    p2.flying = false;
    let exitJump = false;
    run(p2, input({ forward: 1, jump: true, yaw: yawToward(1, 0) }), withWall, 30, DT, (q) => {
      if (q.hitWall && Math.abs(q.vy - SWIM_EXIT_JUMP) < 1e-9) exitJump = true;
    });
    expect(exitJump).toBe(true);
    expect(SWIM_EXIT_JUMP).toBeGreaterThan(SWIM_UP_SPEED);
  });

  it('halves horizontal speed in water; flying is unaffected by water', () => {
    const deep = pool(FEET + 20);
    const p = playerAtCell(0, 0, FEET);
    // Walk within the pool's footprint: tiny back-and-forth keeps it inside the 7 water columns.
    run(p, input({ forward: 1 }), deep, 30);
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(WALK_SPEED * WATER_SPEED_FACTOR, 2);
    const f = playerAtCell(0, 0, FEET + 5);
    f.flying = true;
    run(f, input(), deep, 60);
    expect(f.y).toBeCloseTo(FEET + 5, 9);
    expect(f.inWater).toBe(true);
  });
});

describe('horizontal movement', () => {
  const floor = flatGetBlock(GROUND);

  it('reaches WALK / SPRINT / SNEAK speeds; sprint needs forward input and sneak wins', () => {
    const p = playerAtCell(0, 0, FEET);
    run(p, input({ forward: 1 }), floor, 120);
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(WALK_SPEED, 3);
    expect(p.sprinting).toBe(false);
    run(p, input({ forward: 1, sprint: true }), floor, 120);
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(SPRINT_SPEED, 3);
    expect(p.sprinting).toBe(true);
    run(p, input({ strafe: 1, sprint: true }), floor, 120);
    expect(p.sprinting).toBe(false);
    run(p, input({ forward: 1, sprint: true, sneak: true }), floor, 120);
    expect(p.sneaking).toBe(true);
    expect(p.sprinting).toBe(false);
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(SNEAK_SPEED, 3);
  });

  it('yaw 0 moves toward -Z, yaw π/2 toward -X, strafe +1 at yaw 0 toward +X; diagonal input is normalised', () => {
    const a = run(playerAtCell(0, 0), input({ forward: 1, yaw: 0 }), floor, 60);
    expect(a.z).toBeLessThan(-1);
    expect(Math.abs(a.x)).toBeLessThan(1e-9);
    const b = run(playerAtCell(0, 0), input({ forward: 1, yaw: Math.PI / 2 }), floor, 60);
    expect(b.x).toBeLessThan(-1);
    expect(Math.abs(b.z)).toBeLessThan(1e-6);
    const c = run(playerAtCell(0, 0), input({ strafe: 1, yaw: 0 }), floor, 60);
    expect(c.x).toBeGreaterThan(1);
    const d = run(playerAtCell(0, 0), input({ forward: 1, strafe: 1 }), floor, 120);
    expect(Math.hypot(d.vx, d.vz)).toBeCloseTo(WALK_SPEED, 3);
    expect(yawToForward(0)[1]).toBe(-1);
  });

  it('stops within 0.5 s after releasing input; air control is weaker than ground control', () => {
    const p = run(playerAtCell(0, 0), input({ forward: 1 }), floor, 120);
    run(p, input(), floor, 30);
    expect(Math.hypot(p.vx, p.vz)).toBeLessThan(1e-3);
    const ground = run(playerAtCell(0, 0), input({ forward: 1 }), floor, 3);
    const air = playerAtCell(0, 0, FEET + 20);
    run(air, input({ forward: 1 }), () => BLOCK.AIR, 3);
    expect(Math.hypot(air.vx, air.vz)).toBeLessThan(Math.hypot(ground.vx, ground.vz));
  });
});

describe('robustness', () => {
  const floor = flatGetBlock(GROUND);

  it('ignores non-positive or NaN dt and clamps huge dt', () => {
    const p = playerAtCell(0, 0, FEET + 1);
    const before = { ...p };
    stepPlayer(p, input(), floor, 0);
    stepPlayer(p, input(), floor, -1);
    stepPlayer(p, input(), floor, NaN);
    expect(p).toEqual(before);
    stepPlayer(p, input({ forward: 1 }), floor, 5);
    expect(Number.isFinite(p.x + p.y + p.z + p.vx + p.vy + p.vz)).toBe(true);
    expect(Math.hypot(p.x, p.z)).toBeLessThan(WALK_SPEED * MAX_FRAME_DT + 1e-9);
  });

  it('sanitises non-finite state and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = playerAtCell(0, 0, FEET);
      p.vx = NaN;
      stepPlayer(p, input(), floor, DT);
      expect(Number.isFinite(p.vx)).toBe(true);
      p.y = Infinity;
      stepPlayer(p, input(), floor, DT);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('tolerates a partial input object', () => {
    const p = playerAtCell(0, 0, FEET);
    expect(() => stepPlayer(p, /** @type {*} */ ({}), floor, DT)).not.toThrow();
    expect(() => stepPlayer(p, /** @type {*} */ ({ forward: 1 }), floor, DT)).not.toThrow();
  });

  it('only ever calls getBlock with integer cell coordinates, including at negative positions', () => {
    const seen = [];
    const get = (q, y, r) => {
      seen.push([q, y, r]);
      return flatGetBlock(GROUND)(q, y, r);
    };
    const p = playerAtCell(-11, -7, FEET + 2);
    run(p, input({ forward: 1, strafe: -1, yaw: 2.3 }), get, 60);
    expect(seen.length).toBeGreaterThan(0);
    for (const [q, y, r] of seen) {
      expect(Number.isInteger(q) && Number.isInteger(y) && Number.isInteger(r)).toBe(true);
    }
  });
});

describe('findStandingY', () => {
  it('scans down in the cell under the world point, not the floored coordinates', () => {
    // Cell (0,1) — centre (0.5, √3/2) — carries a pillar up to y = 8; cell (0,0) only has the floor.
    const pillar = [];
    for (let y = FEET; y <= 8; y++) pillar.push(`0,${y},1`);
    const get = floorWith(pillar);
    const [px, pz] = hexToWorld(0, 1);
    expect(findStandingY(get, px, pz, 20)).toBe(9);
    // (0.3, 0.5) floors to (0, 0) but lies in cell (0, 1).
    expect(worldToHex(0.3, 0.5)).toEqual([0, 1]);
    expect(findStandingY(get, 0.3, 0.5, 20)).toBe(9);
    const [cx, cz] = hexToWorld(0, 0);
    expect(findStandingY(get, cx, cz, 20)).toBe(FEET);
  });

  it('skips gaps too low for the player and returns null when nothing is standable or input is non-finite', () => {
    // Floor, a slab at FEET+1 (one-cell gap above the floor) and open air above the slab.
    const get = floorWith([`0,${FEET + 1},0`]);
    const [cx, cz] = hexToWorld(0, 0);
    expect(findStandingY(get, cx, cz, 20)).toBe(FEET + 2);
    expect(findStandingY(() => BLOCK.AIR, cx, cz, 20)).toBeNull();
    expect(findStandingY(get, cx, cz, NaN)).toBeNull();
    expect(findStandingY(get, NaN, cz, 20)).toBeNull();
    expect(findStandingY(get, cx, cz, WORLD_HEIGHT + 50)).toBe(FEET + 2); // fromY is clamped into the world
  });

  it('treats liquids as not standable', () => {
    expect(findStandingY(flatGetBlock(GROUND, BLOCK.WATER), 0, 0, 20)).toBeNull();
    const [cx, cz] = hexToWorld(3, -2);
    expect(findStandingY(flatGetBlock(GROUND), cx, cz, 20)).toBe(FEET);
  });
});

// ---------------------------------------------------------------------------------------------
// Regression: 1-cell-wide passages (review finding). Every shared edge between corridor cells is a throat of
// width HEX_SIZE pinched by the two wall corners flanking it. Before the fix, the alternating MTV pushes at a
// throat did not converge, moveHorizontal returned with a residual overlap, and the next vertical sweep turned
// that residual into a snap onto (or through) the wall: y jumped 2 cells per substep up tall walls, or 1.8 cells
// into the floor while jumping. The player must now simply walk along the corridor at floor height.
describe('1-cell-wide corridors (throats)', () => {
  const END = 40;
  /** A straight corridor of AIR cells (q, 0), q ∈ [-3, END], cut through solid rock `wallTop` cells high over a floor at GROUND. */
  function corridor(wallTop) {
    return (q, y, r) => {
      if (y < 0 || y >= WORLD_HEIGHT) return BLOCK.AIR;
      if (y <= GROUND) return BLOCK.STONE;
      if (r === 0 && q >= -3 && q <= END) return BLOCK.AIR;
      return y <= wallTop ? BLOCK.STONE : BLOCK.AIR;
    };
  }
  /** True when the player's footprint overlaps any solid cell of its height range in the 7 candidate columns. */
  function insideSolid(p, get) {
    const [q0, r0] = worldToHex(p.x, p.z);
    const cols = [[q0, r0]];
    for (let j = 0; j < SIDE_FACE_COUNT; j++) cols.push(hexNeighbor(q0, r0, j));
    for (const [q, r] of cols) {
      for (let y = Math.floor(p.y); y <= Math.ceil(p.y + PLAYER_HEIGHT) - 1; y++) {
        if (get(q, y, r) === BLOCK.STONE && playerIntersectsBlock(p, q, y, r)) return true;
      }
    }
    return false;
  }

  for (const wallTop of [WORLD_HEIGHT - 1, GROUND + 2, GROUND + 1]) {
    it(`walks the length of a corridor with ${wallTop - GROUND}-high walls at floor height, never inside a wall`, () => {
      const get = corridor(wallTop);
      const p = createPlayer(0, FEET, 0);
      run(p, input(), get, 5);
      const inp = input({ forward: 1, yaw: yawToward(1, 0) });
      let maxY = -Infinity;
      run(p, inp, get, 900, DT, (q) => {
        maxY = Math.max(maxY, q.y);
        expect(insideSolid(q, get)).toBe(false);
      });
      // Floor height only: no hop onto the wall, no climb, no sink.
      expect(maxY).toBeLessThan(FEET + 1e-3);
      expect(p.y).toBeGreaterThanOrEqual(FEET);
      // Threaded many throats: well past the start, stopped by the end wall and nothing else.
      expect(p.x).toBeGreaterThan(END - 2);
      expect(p.x).toBeLessThan(END + HEX_INRADIUS);
    });
  }

  it('jumping while squeezing into a throat never puts the feet below the floor', () => {
    const get = corridor(WORLD_HEIGHT - 1);
    const p = createPlayer(0, FEET, 0);
    run(p, input(), get, 5);
    const inp = input({ forward: 1, jump: true, yaw: yawToward(1, 0) });
    let minY = Infinity;
    run(p, inp, get, 600, DT, (q) => {
      minY = Math.min(minY, q.y);
      expect(insideSolid(q, get)).toBe(false);
    });
    expect(minY).toBeGreaterThanOrEqual(FEET - 1e-9);
    expect(p.x).toBeGreaterThan(5);
  });

  it('walking into a dead-end throat whose far side is closed stops cleanly (move refused, no residual)', () => {
    // Corridor cell (0,0) only; everything else solid above the floor: the player can rattle against the
    // cell's six corners but must never end a step overlapping a wall or leave the floor.
    const get = (q, y, r) => (y <= GROUND ? BLOCK.STONE : y >= WORLD_HEIGHT ? BLOCK.AIR : (q === 0 && r === 0 ? BLOCK.AIR : BLOCK.STONE));
    const p = createPlayer(0, FEET, 0);
    run(p, input(), get, 5);
    for (let j = 0; j < SIDE_FACE_COUNT; j++) {
      const n = FACE_NORMALS[j];
      const inp = input({ forward: 1, yaw: yawToward(n[0], n[2]) });
      run(p, inp, get, 120, DT, (q) => {
        expect(insideSolid(q, get)).toBe(false);
        expect(q.y).toBeGreaterThanOrEqual(FEET);
        expect(q.y).toBeLessThan(FEET + 1e-3);
      });
      expect(hexLength(...worldToHex(p.x, p.z))).toBe(0);
    }
  });
});
