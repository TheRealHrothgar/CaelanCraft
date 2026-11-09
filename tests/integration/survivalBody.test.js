// The body and its dangers through the real integrator and the real block physics (CONTRACTS §45, §47; DESIGN-survival
// §2.4–§2.5): falls, crushing by falling ground, and where a death leaves the belongings. Each test states what the
// Handbook promises the player; they came out of the Survival play-test (review lens: body).
import { describe, it, expect } from 'vitest';
import { FALL_SAFE_SPEED, CRUSH_DAMAGE_PER_CELL } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { hexToWorld } from '../../src/hex.js';
import { createPlayer, stepPlayer, isFreeAt, findFreeY } from '../../src/physics.js';
import { fallDamage, crushDamage } from '../../src/vitals.js';
import { Survival } from '../../src/survival.js';
import { chooseBelongingsCell } from '../../src/survivalControl.js';
import { cellsLifted } from '../../src/main.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { makeFakeWorld, attachPhysics } from '../helpers/fixtures.js';

const B = BLOCK;
const FRAME = 1 / 60;
const IDLE = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };
const GROUND = 63;
const flat = (_q, y) => (y < 0 ? B.AIR : y <= GROUND ? B.STONE : B.AIR);

/** Drop a player from `cells` above the ground (at rest, or after a jump) and return the landing speed the integrator records. */
function dropSpeed(cells, jump = false) {
  const [x, z] = hexToWorld(5, 5);
  const p = createPlayer(x, GROUND + 1 + cells, z);
  // Stand on a temporary ledge first so a jump starts from the ground like a real one.
  const ledge = (q, y, r) => (y === GROUND + cells ? B.STONE : flat(q, y, r));
  for (let i = 0; i < 10; i++) stepPlayer(p, IDLE, ledge, FRAME);
  expect(p.onGround).toBe(true);
  if (jump) stepPlayer(p, { ...IDLE, jump: true }, flat, FRAME); // the ledge is gone: the jump leaves it
  let best = 0;
  for (let f = 0; f < 600; f++) {
    stepPlayer(p, IDLE, flat, FRAME);
    if (p.landSpeed > best) best = p.landSpeed;
    if (p.onGround && p.y < GROUND + 1.5) break;
  }
  return best;
}

describe('falls (§2.4): 3 cells safe, a hop off a 2-cell ledge safe, 4 cells hurts, 22 kills', () => {
  it('a plain drop matches the Handbook\'s table', () => {
    expect(fallDamage(dropSpeed(3))).toBe(0);
    expect(fallDamage(dropSpeed(4))).toBeGreaterThan(2);
    expect(fallDamage(dropSpeed(4))).toBeLessThan(4);
    expect(fallDamage(dropSpeed(21))).toBeLessThan(100);
    expect(fallDamage(dropSpeed(22))).toBeGreaterThanOrEqual(100);
  });

  it('a jump down from a 2-cell ledge is harmless (play-test: at a safe speed of 13.5 it cost 0.54 HP with the full hurt flash)', () => {
    const v = dropSpeed(2, true);
    expect(v).toBeGreaterThan(13.5); // the jump adds to the fall: faster than a 3-cell drop …
    expect(v).toBeLessThan(FALL_SAFE_SPEED); // … and still under the safe speed
    expect(fallDamage(v)).toBe(0);
    expect(fallDamage(dropSpeed(1, true))).toBe(0);
  });
});

describe('crush (§2.4): falling ground that fills your cell lifts you and costs 6 HP per cell', () => {
  /**
   * Main's frame order around a landing: `blockPhysics.step` (the faller lands and lifts the body itself, reporting it
   * through the `lifted` hook), the crush from that report, then `unstickPlayer` (a lift for blocks written by anything
   * else). Returns the crush damage dealt and whether the lift was seen at all.
   */
  function landOnPlayer(id, column = [30]) {
    const world = makeFakeWorld({ groundY: 10 });
    let p;
    let pendingCrush = 0;
    const physics = attachPhysics(world, BlockPhysics, {
      bodies: () => [p],
      player: () => p,
      lifted: (body, cells) => { if (body === p) pendingCrush += cells; },
    });
    const [x, z] = hexToWorld(0, 0);
    p = createPlayer(x + 0.3, 11 + 1e-5, z);
    const survival = new Survival();
    survival.setMode('survival');
    survival.fallGrace = false;
    for (const y of column) physics.fallers.spawn(id, 0, y, 0);
    let crush = 0;
    let unstickLifts = 0;
    for (let f = 0; f < 2000 && (physics.fallers.count > 0 || physics.queued() > 0); f++) {
      stepPlayer(p, IDLE, world.getBlock, FRAME);
      physics.step(FRAME); // main: stepBlockPhysics — the faller lands here
      if (pendingCrush > 0 && survival.active && !survival.fallGrace) {
        const dmg = crushDamage(pendingCrush);
        survival.damage(dmg, 'crush');
        crush += dmg;
      }
      pendingCrush = 0;
      // main: unstickPlayer() — for a block written into the player by anything but a landing
      if (!isFreeAt(world.getBlock, p.x, p.y, p.z)) {
        const fy = findFreeY(world.getBlock, p.x, p.z, Math.floor(p.y) + 1, 3);
        if (fy !== null) {
          unstickLifts += cellsLifted(p.y, fy);
          p.y = fy;
        }
      }
    }
    return { world, p, crush, unstickLifts, health: survival.vitals.health };
  }

  it('sand landing in the player\'s cell deals one cell of crush damage (play-test: the lift happened inside the physics step, so unstickPlayer saw nothing and no damage was ever dealt)', () => {
    const r = landOnPlayer(B.SAND);
    expect(r.world.getBlock(0, 11, 0)).toBe(B.SAND); // the sand filled the cell the feet were in …
    expect(r.p.y).toBeGreaterThanOrEqual(12); // … and the player now stands on it
    expect(r.unstickLifts).toBe(0); // unstickPlayer never sees the lift …
    expect(r.crush).toBe(CRUSH_DAMAGE_PER_CELL); // … the landing reports it instead
    expect(r.health).toBeCloseTo(100 - CRUSH_DAMAGE_PER_CELL, 6);
  });

  it('gravel too; a column of three deals three cells\' worth', () => {
    expect(landOnPlayer(B.GRAVEL).crush).toBe(CRUSH_DAMAGE_PER_CELL);
    const r = landOnPlayer(B.SAND, [30, 32, 34]);
    expect(r.p.y).toBeGreaterThanOrEqual(14);
    expect(r.crush).toBe(3 * CRUSH_DAMAGE_PER_CELL);
  });

  it('a body with no room is not crushed: the block breaks into dust instead (§34.3) and no lift is reported', () => {
    const world = makeFakeWorld({ groundY: 10 });
    let p;
    const lifted = [];
    const physics = attachPhysics(world, BlockPhysics, { bodies: () => [p], player: () => p, lifted: (b, c) => lifted.push(c) });
    const [x, z] = hexToWorld(0, 0);
    p = createPlayer(x + 0.3, 11 + 1e-5, z);
    for (let y = 12; y <= 17; y++) world.setBlock(1, y, 0, B.STONE); // the player also overlaps column (1, 0)
    for (let y = 13; y <= 17; y++) world.setBlock(0, y, 0, B.STONE);
    physics.fallers.spawn(B.SAND, 0, 12, 0);
    for (let f = 0; f < 600 && (physics.fallers.count > 0 || physics.queued() > 0); f++) physics.step(FRAME);
    expect(world.getBlock(0, 11, 0)).toBe(B.AIR);
    expect(lifted).toEqual([]);
    expect(p.y).toBeCloseTo(11, 3);
  });
});

describe('belongings (§2.5)', () => {
  it('dying buried alive (a solid cell all round) still leaves Your Belongings: the heap replaces the block in the feet cell (play-test: every belonging was lost)', () => {
    const solid = () => B.STONE;
    expect(chooseBelongingsCell(solid, 10, 40, 10)).toEqual([10, 40, 10]);
    // bedrock is never replaced: the cell above the feet takes the heap
    const onBedrock = (_q, y) => (y === 40 ? B.BEDROCK : B.STONE);
    expect(chooseBelongingsCell(onBedrock, 10, 40, 10)).toEqual([10, 41, 10]);
    // a free cell is still preferred over a solid one
    const gap = (q, y, r) => (q === 11 && y === 40 && r === 10 ? B.AIR : B.STONE);
    expect(chooseBelongingsCell(gap, 10, 40, 10)).toEqual([11, 40, 10]);
  });
});
