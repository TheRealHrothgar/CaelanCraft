// Unit tests for src/physics.js — written from src/CONTRACTS.md §12 and docs/PLAN-build.md §2.8.
// Note: SWIM_EXIT_JUMP equals the normal jump (CONTRACTS §12.1) so a swimmer pressing into a bank one block above
// the water surface clears it; the raised-bank climb-out is asserted below.
import { describe, it, expect, vi } from 'vitest';
import {
  PLAYER_WIDTH, PLAYER_HEIGHT, EYE_HEIGHT, SNEAK_EYE_HEIGHT, JUMP_VELOCITY, TERMINAL_VELOCITY,
  WALK_SPEED, SPRINT_SPEED, SNEAK_SPEED, FLY_SPEED, FLY_SPRINT_SPEED, FLY_VERTICAL_SPEED, WATER_MAX_SINK,
  SWIM_UP_SPEED, SWIM_EXIT_JUMP,
  WATER_SPEED_FACTOR, MAX_FRAME_DT, MAX_SUBSTEP_DT, COLLISION_EPS, WORLD_HEIGHT, SEA_LEVEL,
} from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { flatGetBlock, makeGetBlock } from '../helpers/fixtures.js';
import {
  createPlayer, stepPlayer, getEyeHeight, playerAABB, playerIntersectsBlock, findStandingY,
} from '../../src/physics.js';

const DT = 1 / 60;
const HALF = PLAYER_WIDTH / 2;
const GROUND = 4;              // flatGetBlock(4): solid for y <= 4, so feet rest at y = 5
const FEET = GROUND + 1;

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

/** Flat floor up to GROUND plus an infinite solid wall column at x === wallX. */
function floorAndWall(wallX) {
  return (x, y, _z) => (y < 0 || y >= WORLD_HEIGHT ? BLOCK.AIR : y <= GROUND || x === wallX ? BLOCK.STONE : BLOCK.AIR);
}

const speedXZ = (p) => Math.hypot(p.vx, p.vz);

/** A player already settled on the flat floor (so onGround is true and y = FEET + eps). */
function groundedPlayer(x = 0.5, z = 0.5, getBlock = flatGetBlock(GROUND)) {
  const p = createPlayer(x, FEET, z);
  run(p, input(), getBlock, 5);
  expect(p.onGround).toBe(true);
  return p;
}

describe('createPlayer / getEyeHeight', () => {
  it('creates a player at the feet position with zeroed velocities and flags', () => {
    const p = createPlayer(1.5, 70, -2.5);
    expect(p).toMatchObject({
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
  it('builds the AABB around the feet position and reuses `out`', () => {
    const p = createPlayer(0.5, 5, -0.5);
    const out = {};
    const box = playerAABB(p, out);
    expect(box).toBe(out);
    expect(box.minX).toBeCloseTo(0.5 - HALF, 12);
    expect(box.maxX).toBeCloseTo(0.5 + HALF, 12);
    expect(box.minY).toBe(5);
    expect(box.maxY).toBeCloseTo(5 + PLAYER_HEIGHT, 12);
    expect(box.minZ).toBeCloseTo(-0.5 - HALF, 12);
    expect(box.maxZ).toBeCloseTo(-0.5 + HALF, 12);
    expect(playerAABB(p)).toEqual(box);
  });

  it('uses strict overlap (touching faces do not intersect)', () => {
    const p = createPlayer(0.5, 5, 0.5);
    expect(playerIntersectsBlock(p, 0, 5, 0)).toBe(true);
    expect(playerIntersectsBlock(p, 0, 6, 0)).toBe(true);   // [6,7) overlaps [5,6.8)
    expect(playerIntersectsBlock(p, 0, 4, 0)).toBe(false);  // block top at 5 touches feet at 5
    expect(playerIntersectsBlock(p, 0, 7, 0)).toBe(false);  // head at 6.8 < 7
    expect(playerIntersectsBlock(p, 1, 5, 0)).toBe(false);  // maxX 0.8 < 1
    expect(playerIntersectsBlock(p, -1, 5, 0)).toBe(false); // minX 0.2 > 0
    expect(playerIntersectsBlock(p, 0, 5, 1)).toBe(false);
  });

  it('handles negative coordinates', () => {
    const p = createPlayer(-0.5, 5, -0.5);
    expect(playerIntersectsBlock(p, -1, 5, -1)).toBe(true);
    expect(playerIntersectsBlock(p, 0, 5, 0)).toBe(false);
    expect(playerIntersectsBlock(p, -1, 6, -1)).toBe(true);
    // straddling a cell boundary: x in [-0.3, 0.3] overlaps cells -1 and 0
    const q = createPlayer(0, 5, 0);
    expect(playerIntersectsBlock(q, -1, 5, -1)).toBe(true);
    expect(playerIntersectsBlock(q, 0, 5, 0)).toBe(true);
  });
});

describe('falling and landing', () => {
  it('lands from y=10 onto flatGetBlock(4) at y≈5, vy 0, onGround, never penetrates', () => {
    const gb = flatGetBlock(GROUND);
    const p = createPlayer(0.5, 10, 0.5);
    let steps = 0;
    while (!p.onGround && steps < 600) {
      stepPlayer(p, input(), gb, DT);
      steps++;
      expect(p.y).toBeGreaterThanOrEqual(FEET); // never inside the floor
    }
    expect(p.onGround).toBe(true);
    expect(steps).toBeLessThan(600);
    expect(p.y).toBeCloseTo(FEET, 4);
    expect(p.y).toBeGreaterThanOrEqual(FEET);
    expect(p.vy).toBe(0);
  });

  it('stays put on the ground for 300 more steps (no sinking, no jitter)', () => {
    const p = groundedPlayer();
    const y0 = p.y;
    run(p, input(), flatGetBlock(GROUND), 300, DT, (q) => {
      expect(q.onGround).toBe(true);
      expect(q.y).toBeCloseTo(FEET, 4);
      expect(q.y).toBeGreaterThanOrEqual(FEET);
      expect(q.vy).toBe(0);
      expect(q.x).toBe(0.5);
      expect(q.z).toBe(0.5);
    });
    expect(p.y).toBe(y0);
  });

  it('respects terminal velocity after 5 s of free fall', () => {
    const gb = () => BLOCK.AIR;
    const p = createPlayer(0.5, 1000, 0.5);
    run(p, input(), gb, 300, DT, (q) => {
      expect(q.vy).toBeGreaterThanOrEqual(TERMINAL_VELOCITY);
    });
    expect(p.vy).toBe(TERMINAL_VELOCITY);
    expect(p.onGround).toBe(false);
  });

  it('walking off a ledge leaves the ground and falls', () => {
    // floor only where x < 2
    const gb = (x, y) => (y >= 0 && y <= GROUND && x < 2 ? BLOCK.STONE : BLOCK.AIR);
    const p = groundedPlayer(0.5, 0.5, gb);
    run(p, input({ strafe: 1 }), gb, 120); // +X for 2 s
    expect(p.onGround).toBe(false);
    expect(p.y).toBeLessThan(FEET - 1);
    expect(p.x).toBeGreaterThan(2 + HALF);
  });
});

describe('walls', () => {
  it('walking into a wall at x=3 stops at x≈3-0.3 with vx 0, hitWall, and no z push', () => {
    const gb = floorAndWall(3);
    const p = groundedPlayer(1.5, 0.5, gb);
    run(p, input({ strafe: 1 }), gb, 120, DT, (q) => {
      expect(q.x).toBeLessThanOrEqual(3 - HALF);
    });
    expect(p.x).toBeCloseTo(3 - HALF, 4);
    expect(p.vx).toBe(0);
    expect(p.hitWall).toBe(true);
    expect(p.z).toBe(0.5);
    expect(p.vz).toBe(0);
    expect(p.onGround).toBe(true);
  });

  it('facing the wall via yaw (yaw = -π/2 faces +X) also stops at the wall', () => {
    const gb = floorAndWall(3);
    const p = groundedPlayer(1.5, 0.5, gb);
    run(p, input({ forward: 1, yaw: -Math.PI / 2 }), gb, 120);
    expect(p.x).toBeCloseTo(3 - HALF, 4);
    expect(p.vx).toBe(0);
    expect(p.z).toBeCloseTo(0.5, 6);
  });

  it('wall slide: diagonal into the wall clamps x while z keeps increasing', () => {
    const gb = floorAndWall(3);
    const p = groundedPlayer(2.5, 0.5, gb);
    let lastZ = p.z;
    run(p, input({ forward: -1, strafe: 1 }), gb, 120, DT, (q, i) => {
      if (i > 5) expect(q.z).toBeGreaterThan(lastZ);
      lastZ = q.z;
    });
    expect(p.x).toBeCloseTo(3 - HALF, 4);
    expect(p.vx).toBe(0);
    expect(p.z).toBeGreaterThan(3);
    expect(p.vz).toBeGreaterThan(0);
    expect(p.hitWall).toBe(true);
  });

  it('walking away from the wall clears hitWall', () => {
    const gb = floorAndWall(3);
    const p = groundedPlayer(2.5, 0.5, gb);
    run(p, input({ strafe: 1 }), gb, 30);
    expect(p.hitWall).toBe(true);
    run(p, input({ strafe: -1 }), gb, 30);
    expect(p.hitWall).toBe(false);
    expect(p.x).toBeLessThan(2.5);
  });

  it('wall from the negative side and at negative coordinates', () => {
    // wall column at x = -4, floor below; player at x = -2.5 walking -X
    const gb = floorAndWall(-4);
    const p = groundedPlayer(-2.5, -7.5, gb);
    run(p, input({ strafe: -1 }), gb, 120);
    expect(p.x).toBeCloseTo(-4 + 1 + HALF, 4);
    expect(p.vx).toBe(0);
    expect(p.z).toBe(-7.5);
  });

  it('Z walls work too', () => {
    const gb = (_x, y, z) => (y >= 0 && (y <= GROUND || z === -3) ? BLOCK.STONE : BLOCK.AIR);
    const p = groundedPlayer(0.5, -0.5, gb);
    run(p, input({ forward: 1 }), gb, 120); // yaw 0 → -Z
    expect(p.z).toBeCloseTo(-3 + 1 + HALF, 4);
    expect(p.vz).toBe(0);
    expect(p.hitWall).toBe(true);
    expect(p.x).toBe(0.5);
  });
});

describe('sub-stepping / no tunnelling', () => {
  it('does not tunnel through a one-block floor at terminal velocity with dt = 0.5', () => {
    const gb = (_x, y) => (y === GROUND ? BLOCK.STONE : BLOCK.AIR);
    const p = createPlayer(0.5, 100, 0.5);
    for (let i = 0; i < 60; i++) {
      stepPlayer(p, input(), gb, 0.5);
      expect(p.y).toBeGreaterThanOrEqual(FEET);
    }
    expect(p.onGround).toBe(true);
    expect(p.y).toBeCloseTo(FEET, 4);
  });

  it('does not tunnel through a one-block wall while flying at sprint speed with dt = 0.5', () => {
    const gb = (x, y) => (y >= 0 && x === 3 ? BLOCK.STONE : BLOCK.AIR);
    const p = createPlayer(-20.5, 10, 0.5);
    p.flying = true;
    for (let i = 0; i < 40; i++) {
      stepPlayer(p, input({ strafe: 1, forward: 1, sprint: true, yaw: -Math.PI / 2 }), gb, 0.5);
      expect(p.x).toBeLessThanOrEqual(3 - HALF);
    }
    expect(p.x).toBeCloseTo(3 - HALF, 4);
    expect(p.flying).toBe(true);
  });

  it('clamps dt to MAX_FRAME_DT and splits into equal substeps', () => {
    const gb = flatGetBlock(GROUND);
    const a = createPlayer(0.5, 50, 0.5);
    const b = createPlayer(0.5, 50, 0.5);
    stepPlayer(a, input(), gb, 5);              // clamped to 0.1 = 6 substeps of 1/60
    run(b, input(), gb, 6, MAX_SUBSTEP_DT);     // six explicit 1/60 steps
    expect(a.y).toBeCloseTo(b.y, 9);
    expect(a.vy).toBeCloseTo(b.vy, 9);
    // 0.1 s of free fall from rest: ~0.5*28*0.01 = 0.14 blocks (semi-implicit → slightly more)
    expect(50 - a.y).toBeGreaterThan(0.1);
    expect(50 - a.y).toBeLessThan(0.2);
    expect(MAX_FRAME_DT / MAX_SUBSTEP_DT).toBe(6);
  });
});

describe('jumping', () => {
  function jumpApex(dt) {
    const gb = flatGetBlock(GROUND);
    const p = groundedPlayer();
    const y0 = p.y;
    let apex = y0;
    stepPlayer(p, input({ jump: true }), gb, dt);
    expect(p.vy).toBeGreaterThan(0);
    expect(p.onGround).toBe(false);
    let steps = 0;
    while (!p.onGround && steps < 2000) {
      apex = Math.max(apex, p.y);
      stepPlayer(p, input(), gb, dt);
      steps++;
    }
    expect(p.onGround).toBe(true);
    expect(p.y).toBeCloseTo(FEET, 4);
    return apex - y0;
  }

  // Semi-implicit Euler at h = 1/60 with JUMP_VELOCITY 8.7 gives a discrete apex of about 1.28 blocks
  // (analytic 1.35); PLAN-build §2.8 item 7 requires [1.2, 1.6].
  it('jump height at 60 Hz is within [1.2, 1.6] blocks', () => {
    const h = jumpApex(DT);
    expect(h).toBeGreaterThanOrEqual(1.2);
    expect(h).toBeLessThanOrEqual(1.6);
  });

  it('jump height converges into [1.2, 1.6] with finer steps', () => {
    const h = jumpApex(1 / 240);
    expect(h).toBeGreaterThanOrEqual(1.2);
    expect(h).toBeLessThanOrEqual(1.6);
    const analytic = (JUMP_VELOCITY ** 2) / (2 * 28);
    expect(Math.abs(h - analytic)).toBeLessThan(0.05);
  });

  it('cannot double jump: holding jump mid-air never increases vy', () => {
    const gb = flatGetBlock(GROUND);
    const p = groundedPlayer();
    stepPlayer(p, input({ jump: true }), gb, DT);
    let prevVy = p.vy;
    let apex = p.y;
    while (!p.onGround) {
      stepPlayer(p, input({ jump: true }), gb, DT);
      if (!p.onGround) expect(p.vy).toBeLessThan(prevVy);
      prevVy = p.vy;
      apex = Math.max(apex, p.y);
    }
    expect(apex - FEET).toBeLessThan(1.6);
  });

  it('holding jump on the ground bunny-hops (re-jumps after landing)', () => {
    const gb = flatGetBlock(GROUND);
    const p = groundedPlayer();
    let launches = 0;
    let wasGround = true;
    run(p, input({ jump: true }), gb, 300, DT, (q) => {
      if (wasGround && !q.onGround) launches++;
      wasGround = q.onGround;
    });
    expect(launches).toBeGreaterThanOrEqual(3);
  });

  it('ceiling stops the head below y=7 and the player comes back down (no sticking)', () => {
    const gb = (_x, y) => (y >= 0 && (y <= GROUND || y === 7) ? BLOCK.STONE : BLOCK.AIR);
    const p = groundedPlayer(0.5, 0.5, gb);
    stepPlayer(p, input({ jump: true }), gb, DT);
    let hitCeiling = false;
    let steps = 0;
    while (!p.onGround && steps < 600) {
      stepPlayer(p, input(), gb, DT);
      steps++;
      expect(p.y + PLAYER_HEIGHT).toBeLessThanOrEqual(7);
      if (Math.abs(p.y + PLAYER_HEIGHT - 7) < 1e-3) hitCeiling = true;
    }
    expect(hitCeiling).toBe(true);
    expect(p.onGround).toBe(true);
    expect(steps).toBeLessThan(120); // back within 2 s
    expect(p.y).toBeCloseTo(FEET, 4);
  });
});

describe('flying', () => {
  it('has no drift with no input and does not fall', () => {
    const p = createPlayer(0.5, 10, 0.5);
    p.flying = true;
    run(p, input(), flatGetBlock(GROUND), 120);
    expect(p.x).toBe(0.5);
    expect(p.y).toBe(10);
    expect(p.z).toBe(0.5);
    expect(p.vy).toBe(0);
    expect(p.flying).toBe(true);
    expect(p.onGround).toBe(false);
  });

  it('ascends at FLY_VERTICAL_SPEED with jump and descends with sneak', () => {
    const p = createPlayer(0.5, 10, 0.5);
    p.flying = true;
    run(p, input({ jump: true }), () => BLOCK.AIR, 60);
    expect(p.vy).toBeCloseTo(FLY_VERTICAL_SPEED, 3);
    expect(p.y).toBeGreaterThan(15);
    expect(p.sneaking).toBe(false);
    const y1 = p.y;
    run(p, input({ sneak: true }), () => BLOCK.AIR, 60);
    expect(p.vy).toBeCloseTo(-FLY_VERTICAL_SPEED, 3);
    expect(p.y).toBeLessThan(y1);
    expect(p.sneaking).toBe(false); // sneak does not crouch while flying
    expect(getEyeHeight(p)).toBe(EYE_HEIGHT);
  });

  it('moves horizontally at FLY_SPEED, and FLY_SPRINT_SPEED when sprinting forward (§12.1 step 2)', () => {
    const air = () => BLOCK.AIR;
    // plain forward → FLY_SPEED
    const p = createPlayer(0.5, 10, 0.5);
    p.flying = true;
    run(p, input({ forward: 1 }), air, 120);
    expect(p.sprinting).toBe(false);
    expect(Math.abs(speedXZ(p) - FLY_SPEED) / FLY_SPEED).toBeLessThan(0.01);
    expect(p.y).toBe(10);
    // forward + sprint → FLY_SPRINT_SPEED (2x)
    const q = createPlayer(0.5, 10, 0.5);
    q.flying = true;
    run(q, input({ forward: 1, sprint: true }), air, 120);
    expect(q.sprinting).toBe(true);
    expect(Math.abs(speedXZ(q) - FLY_SPRINT_SPEED) / FLY_SPRINT_SPEED).toBeLessThan(0.01);
    expect(FLY_SPRINT_SPEED).toBeGreaterThan(FLY_SPEED);
    // sprint requires forward input: strafing with sprint held stays at FLY_SPEED
    const r = createPlayer(0.5, 10, 0.5);
    r.flying = true;
    run(r, input({ strafe: 1, sprint: true }), air, 120);
    expect(r.sprinting).toBe(false);
    expect(Math.abs(speedXZ(r) - FLY_SPEED) / FLY_SPEED).toBeLessThan(0.01);
    // sneak while flying never crouches, so it cannot cancel sprint
    const t = createPlayer(0.5, 10, 0.5);
    t.flying = true;
    run(t, input({ forward: 1, sprint: true, sneak: true }), air, 120);
    expect(t.sneaking).toBe(false);
    expect(t.sprinting).toBe(true);
    expect(Math.abs(speedXZ(t) - FLY_SPRINT_SPEED) / FLY_SPRINT_SPEED).toBeLessThan(0.01);
  });

  it('still collides with walls and keeps flying', () => {
    const gb = floorAndWall(3);
    const p = createPlayer(1.5, 10, 0.5);
    p.flying = true;
    run(p, input({ strafe: 1 }), gb, 120);
    expect(p.x).toBeCloseTo(3 - HALF, 4);
    expect(p.vx).toBe(0);
    expect(p.hitWall).toBe(true);
    expect(p.flying).toBe(true);
    expect(p.y).toBe(10);
  });

  it('landing on the ground while descending ends flight', () => {
    const gb = flatGetBlock(GROUND);
    const p = createPlayer(0.5, 8, 0.5);
    p.flying = true;
    let steps = 0;
    while (p.flying && steps < 600) {
      stepPlayer(p, input({ sneak: true }), gb, DT);
      steps++;
    }
    expect(p.flying).toBe(false);
    expect(p.onGround).toBe(true);
    expect(p.y).toBeCloseTo(FEET, 4);
    expect(p.vy).toBe(0);
    // afterwards gravity applies normally
    run(p, input(), gb, 30);
    expect(p.onGround).toBe(true);
    expect(p.flying).toBe(false);
  });

  it('a ceiling stops ascent without ending flight', () => {
    const gb = (_x, y) => (y >= 0 && (y <= GROUND || y === 12) ? BLOCK.STONE : BLOCK.AIR);
    const p = createPlayer(0.5, 8, 0.5);
    p.flying = true;
    run(p, input({ jump: true }), gb, 120);
    expect(p.y + PLAYER_HEIGHT).toBeLessThanOrEqual(12);
    expect(p.y + PLAYER_HEIGHT).toBeCloseTo(12, 4);
    expect(p.flying).toBe(true);
  });
});

describe('swimming', () => {
  /** stone up to GROUND, water from GROUND+1 to `top` inclusive, air above. */
  const water = (top) => (_x, y) => (y < 0 ? BLOCK.AIR : y <= GROUND ? BLOCK.STONE : y <= top ? BLOCK.WATER : BLOCK.AIR);

  it('sets inWater / headInWater and caps sink speed at WATER_MAX_SINK', () => {
    const gb = water(40);
    const p = createPlayer(0.5, 30, 0.5);
    let headSamples = 0;
    for (let i = 0; i < 120; i++) {
      stepPlayer(p, input(), gb, DT);
      expect(p.vy).toBeGreaterThanOrEqual(WATER_MAX_SINK);
      expect(p.inWater).toBe(true);
      // Deep under water (water above the eye cell) the head is submerged at every fractional height.
      expect(p.headInWater).toBe(true);
      headSamples++;
    }
    expect(headSamples).toBe(120);
    expect(p.vy).toBe(WATER_MAX_SINK);
    expect(p.y).toBeLessThan(30);
    expect(p.y).toBeGreaterThan(30 - 3 * 2 - 0.1);
  });

  it('holding jump rises at SWIM_UP_SPEED', () => {
    const gb = water(40);
    const p = createPlayer(0.5, 20, 0.5);
    run(p, input({ jump: true }), gb, 60);
    expect(p.vy).toBe(SWIM_UP_SPEED);
    expect(p.y).toBeCloseTo(20 + SWIM_UP_SPEED, 3);
  });

  it('headInWater is false when the eye is above the surface of the top water block', () => {
    const gb = water(20); // water top face at y = 20.875
    // eye = y + 1.62 → put the eye at 20.9 (above surface) → y = 19.28; feet/chest are still in water
    const p = createPlayer(0.5, 19.28, 0.5);
    stepPlayer(p, input({ jump: true }), gb, DT);
    expect(p.inWater).toBe(true);
    expect(p.headInWater).toBe(false);
    // and true when the eye is below the surface in the same block
    const q = createPlayer(0.5, 19.0, 0.5);
    stepPlayer(q, input({ jump: true }), gb, DT);
    expect(q.headInWater).toBe(true);
  });

  it('headInWater stays true deep under water at any fractional eye height (regression)', () => {
    const gb = water(40);
    for (const frac of [0.0, 0.3, 0.7, 0.875, 0.9, 0.99]) {
      // eye cell 25 (water above at 26): y = 25 + frac - EYE_HEIGHT
      const p = createPlayer(0.5, 25 + frac - EYE_HEIGHT, 0.5);
      stepPlayer(p, input({ jump: true }), gb, DT); // jump keeps y from sinking before the sample
      expect(p.headInWater, `frac=${frac}`).toBe(true);
    }
    // but in the topmost water block (air above), the top 1/8 is above the lowered surface
    const top = water(20);
    const above = createPlayer(0.5, 20 + 0.9 - EYE_HEIGHT, 0.5);
    stepPlayer(above, input({ jump: true }), top, DT);
    expect(above.headInWater).toBe(false);
    const below = createPlayer(0.5, 20 + 0.8 - EYE_HEIGHT, 0.5);
    stepPlayer(below, input({ jump: true }), top, DT);
    expect(below.headInWater).toBe(true);
  });

  it('lands softly on the bottom and stands there', () => {
    const gb = water(40);
    const p = createPlayer(0.5, 8, 0.5);
    run(p, input(), gb, 300);
    expect(p.onGround).toBe(true);
    expect(p.y).toBeCloseTo(FEET, 4);
    expect(p.inWater).toBe(true);
  });

  it('halves horizontal speed in water', () => {
    const gb = water(40);
    const p = createPlayer(0.5, 20, 0.5);
    run(p, input({ forward: 1, jump: true }), gb, 120); // jump keeps us in the column at a known depth
    expect(speedXZ(p)).toBeCloseTo(WALK_SPEED * WATER_SPEED_FACTOR, 2);
    expect(p.vz).toBeLessThan(0);
  });

  /**
   * Worldgen-shaped shoreline (docs/SPEC-gameplay.md §3, §7): an ocean column (stone floor at `floor`, WATER up to
   * SEA_LEVEL) west of a beach column whose top SAND block is at `bankTop - 1`, so the bank's top face is at `bankTop`.
   * The natural 1-block shore is a beach column of height SEA_LEVEL (top face SEA_LEVEL + 1).
   */
  const shore = (bankTop, floor = SEA_LEVEL - 4) => (x, y) => {
    if (y < 0) return BLOCK.AIR;
    if (x >= 3) return y <= bankTop - 1 ? BLOCK.SAND : BLOCK.AIR;
    return y <= floor ? BLOCK.STONE : y <= SEA_LEVEL ? BLOCK.WATER : BLOCK.AIR;
  };

  it.each([
    ['at DT', DT],
    ['at 144 Hz', 1 / 144],
    ['at a 10 Hz frame (MAX_FRAME_DT substeps)', 0.1],
  ])('climbs out of deep water onto a natural 1-block shore with Space held (%s)', (_label, dt) => {
    // SPEC-gameplay §7: "against a 1-block shore with Space held the player climbs out".
    const bankTop = SEA_LEVEL + 1;
    const gb = shore(bankTop);
    const p = createPlayer(1.5, SEA_LEVEL - 3, 0.5); // feet in deep water, well below the surface
    let out = false;
    run(p, input({ strafe: 1, jump: true }), gb, 400, dt, (q) => {
      out ||= q.x > 3 + HALF && q.onGround && !q.inWater;
    });
    expect(out, 'player never stood on the bank').toBe(true);
    expect(p.x).toBeGreaterThan(3 + HALF);
    expect(p.inWater).toBe(false);
    // once ashore the player walks east on top of the bank and never dips back below its top face
    expect(p.y).toBeGreaterThanOrEqual(bankTop);
  });

  it('climbs out onto a bank whose block sits directly above the top water block (top face SEA_LEVEL + 2)', () => {
    // SWIM_EXIT_JUMP equals the normal jump (CONTRACTS §12.1), so the feet clear a bank one block above the water surface.
    const bankTop = SEA_LEVEL + 2;
    const gb = shore(bankTop);
    const p = createPlayer(1.5, SEA_LEVEL - 3, 0.5);
    let out = false;
    run(p, input({ strafe: 1, jump: true }), gb, 600, DT, (q) => {
      out ||= q.x > 3 + HALF && q.onGround && !q.inWater;
    });
    expect(out, 'player never stood on the raised bank').toBe(true);
    expect(p.y).toBeGreaterThanOrEqual(bankTop);
  });

  it('swimming into a wall with jump held assigns vy = SWIM_EXIT_JUMP (§12.1 step 3 rule, not climb-out coverage)', () => {
    // This checks the contract's assignment rule only; the climb-out behaviour is covered by the shore tests above.
    const gb = (x, y) => (y < 0 ? BLOCK.AIR : y <= GROUND || x === 3 ? BLOCK.STONE : y <= 40 ? BLOCK.WATER : BLOCK.AIR);
    const p = createPlayer(1.5, 6, 0.5);
    run(p, input({ strafe: 1, jump: true }), gb, 90);
    expect(p.inWater).toBe(true);
    expect(p.hitWall).toBe(true);
    expect(p.x).toBeCloseTo(3 - HALF, 4);
    expect(p.vy).toBe(SWIM_EXIT_JUMP);
    // without the wall contact the same input only gives SWIM_UP_SPEED
    const q = createPlayer(-10.5, 6, 0.5);
    run(q, input({ strafe: 1, jump: true }), gb, 30);
    expect(q.hitWall).toBe(false);
    expect(q.vy).toBe(SWIM_UP_SPEED);
  });

  it('flying is unaffected by water', () => {
    const gb = water(40);
    const p = createPlayer(0.5, 20, 0.5);
    p.flying = true;
    run(p, input({ forward: 1 }), gb, 120);
    expect(p.inWater).toBe(true);
    expect(p.y).toBe(20);
    expect(speedXZ(p)).toBeCloseTo(FLY_SPEED, 2); // not halved by WATER_SPEED_FACTOR
  });
});

describe('horizontal movement', () => {
  const gb = flatGetBlock(GROUND);

  it.each([
    ['walk', {}, WALK_SPEED],
    ['sprint', { sprint: true }, SPRINT_SPEED],
    ['sneak', { sneak: true }, SNEAK_SPEED],
    ['sneak beats sprint', { sneak: true, sprint: true }, SNEAK_SPEED],
  ])('%s speed within 5%% after 2 s', (_name, over, target) => {
    const p = groundedPlayer();
    run(p, input({ forward: 1, ...over }), gb, 120);
    const s = speedXZ(p);
    expect(Math.abs(s - target) / target).toBeLessThan(0.05);
    expect(p.onGround).toBe(true);
  });

  it('sprint requires forward input; sneak wins over sprint', () => {
    const p = groundedPlayer();
    stepPlayer(p, input({ forward: 1, sprint: true }), gb, DT);
    expect(p.sprinting).toBe(true);
    stepPlayer(p, input({ strafe: 1, sprint: true }), gb, DT);
    expect(p.sprinting).toBe(false);
    stepPlayer(p, input({ forward: 1, sprint: true, sneak: true }), gb, DT);
    expect(p.sprinting).toBe(false);
    expect(p.sneaking).toBe(true);
    expect(getEyeHeight(p)).toBe(SNEAK_EYE_HEIGHT);
  });

  it('stops within 0.5 s after releasing input', () => {
    const p = groundedPlayer();
    run(p, input({ forward: 1 }), gb, 120);
    run(p, input(), gb, 30);
    expect(speedXZ(p)).toBeLessThan(0.05);
  });

  it('diagonal input is normalised (no faster than straight)', () => {
    const p = groundedPlayer();
    run(p, input({ forward: 1, strafe: 1 }), gb, 120);
    expect(speedXZ(p)).toBeCloseTo(WALK_SPEED, 3);
    expect(Math.abs(p.vx)).toBeCloseTo(Math.abs(p.vz), 6);
  });

  it('yaw 0 moves toward -Z; yaw π/2 moves toward -X; strafe +1 at yaw 0 moves +X', () => {
    const a = groundedPlayer();
    run(a, input({ forward: 1, yaw: 0 }), gb, 60);
    expect(a.z).toBeLessThan(0.5 - 3);
    expect(a.x).toBe(0.5);

    const b = groundedPlayer();
    run(b, input({ forward: 1, yaw: Math.PI / 2 }), gb, 60);
    expect(b.x).toBeLessThan(0.5 - 3);
    expect(b.z).toBeCloseTo(0.5, 6);

    const c = groundedPlayer();
    run(c, input({ strafe: 1, yaw: 0 }), gb, 60);
    expect(c.x).toBeGreaterThan(0.5 + 3);
    expect(c.z).toBe(0.5);

    const d = groundedPlayer();
    run(d, input({ forward: -1, yaw: 0 }), gb, 60);
    expect(d.z).toBeGreaterThan(0.5 + 3);
  });

  it('air control is weaker than ground control', () => {
    const grounded = groundedPlayer();
    run(grounded, input({ forward: 1 }), gb, 6);
    const airborne = createPlayer(0.5, 50, 0.5);
    run(airborne, input({ forward: 1 }), () => BLOCK.AIR, 6);
    expect(speedXZ(airborne)).toBeLessThan(speedXZ(grounded) * 0.5);
    expect(speedXZ(airborne)).toBeGreaterThan(0);
  });
});

describe('robustness', () => {
  it('dt = 5 does not explode (clamped) and leaves finite state', () => {
    const gb = flatGetBlock(GROUND);
    const p = createPlayer(0.5, 10, 0.5);
    stepPlayer(p, input({ forward: 1 }), gb, 5);
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz']) expect(Number.isFinite(p[k])).toBe(true);
    expect(p.y).toBeLessThan(10);
    expect(p.y).toBeGreaterThan(9.5);
    run(p, input(), gb, 20, 5);
    expect(p.onGround).toBe(true);
    expect(p.y).toBeCloseTo(FEET, 4);
  });

  it('ignores non-positive or NaN dt', () => {
    const gb = flatGetBlock(GROUND);
    const p = createPlayer(0.5, 10, 0.5);
    stepPlayer(p, input({ forward: 1 }), gb, 0);
    stepPlayer(p, input({ forward: 1 }), gb, -1);
    stepPlayer(p, input({ forward: 1 }), gb, NaN);
    expect(p).toMatchObject({ x: 0.5, y: 10, z: 0.5, vx: 0, vy: 0, vz: 0 });
  });

  it('sanitises NaN state and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const gb = flatGetBlock(GROUND);
      const p = createPlayer(0.5, 10, 0.5);
      p.vx = NaN;
      p.vy = Infinity;
      stepPlayer(p, input(), gb, DT);
      for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz']) expect(Number.isFinite(p[k])).toBe(true);
      p.x = NaN;
      stepPlayer(p, input(), gb, DT);
      for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz']) expect(Number.isFinite(p[k])).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('tolerates a partial input object', () => {
    const gb = flatGetBlock(GROUND);
    const p = groundedPlayer();
    // @ts-ignore deliberately incomplete
    run(p, { yaw: 0 }, gb, 10);
    expect(p.onGround).toBe(true);
    expect(p.x).toBe(0.5);
  });

  it('only ever calls getBlock with integer arguments (including at negative coordinates)', () => {
    const calls = [];
    const bad = [];
    const base = floorAndWall(-6);
    const gb = (x, y, z) => {
      calls.push(1);
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) bad.push([x, y, z]);
      return base(x, y, z);
    };
    const p = createPlayer(-3.3, 9.7, -7.9);
    run(p, input({ forward: 1, strafe: -1, jump: true, yaw: 0.7 }), gb, 120);
    run(p, input({ forward: -1, sneak: true, yaw: -2.1 }), gb, 60, 0.05);
    p.flying = true;
    run(p, input({ jump: true, strafe: 1, yaw: 3 }), gb, 60);
    expect(calls.length).toBeGreaterThan(0);
    expect(bad).toEqual([]);
    for (const k of ['x', 'y', 'z']) expect(Number.isFinite(p[k])).toBe(true);
  });

  it('uses the standard COLLISION_EPS resting gap', () => {
    const p = groundedPlayer();
    expect(p.y - FEET).toBeCloseTo(COLLISION_EPS, 9);
  });
});

describe('findStandingY', () => {
  it('finds the first standable y scanning down', () => {
    expect(findStandingY(flatGetBlock(GROUND), 0.5, 0.5, 100)).toBe(FEET);
    expect(findStandingY(flatGetBlock(GROUND), -12.7, 33.2, 100)).toBe(FEET);
    expect(findStandingY(flatGetBlock(GROUND), 0, 0, WORLD_HEIGHT + 50)).toBe(FEET);
  });

  it('skips gaps that are too low for the player', () => {
    // solid at y=4 and y=6: y=5 has a block at y+1, so the first valid standing y is 7
    const gb = (_x, y) => (y === 4 || y === 6 ? BLOCK.STONE : BLOCK.AIR);
    expect(findStandingY(gb, 0.5, 0.5, 100)).toBe(7);
    // starting below the upper slab: 5 is invalid (6 solid), 4 invalid (standing inside 4) → keep scanning → null
    expect(findStandingY(gb, 0.5, 0.5, 5)).toBe(null);
  });

  it('returns null when there is nothing to stand on', () => {
    expect(findStandingY(() => BLOCK.AIR, 0.5, 0.5, 100)).toBe(null);
    expect(findStandingY(() => BLOCK.STONE, 0.5, 0.5, 100)).toBe(null);
  });

  it('treats liquids as not standable', () => {
    const map = makeGetBlock({ '0,4,0': BLOCK.STONE, '0,5,0': BLOCK.WATER, '0,6,0': BLOCK.WATER });
    // water at 5 and 6 is not solid, so standing y = 5 (on the stone at 4)
    expect(findStandingY(map, 0.5, 0.5, 20)).toBe(5);
    const onlyWater = makeGetBlock({ '0,4,0': BLOCK.WATER });
    expect(findStandingY(onlyWater, 0.5, 0.5, 20)).toBe(null);
  });
});
