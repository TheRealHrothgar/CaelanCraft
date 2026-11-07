// The feature modules' public surface (docs/DESIGN-physics.md §10 "Interfaces"): every method the scheduler, main.js
// and commands.js call exists with its final arity, so features built in parallel stay plug-compatible. This checks
// SHAPES, not behaviour — implementations replace the stubs' bodies, never their signatures.
import { describe, it, expect } from 'vitest';
import { BLOCK } from '../../src/blocks.js';
import { BlockPhysics, SaveOverlay } from '../../src/blockphysics.js';
import { isLoadBearing, isSelfAnchored, isAnchorCell } from '../../src/support.js';
import { makeFakeWorld, attachPhysics } from '../helpers/fixtures.js';

const SURFACE = {
  fallers: ['spawn:5', 'crumble:2', 'settleNow:5', 'spawnTumbler:8', 'removeTumbler:1', 'cancelEvent:1', 'step:1', 'renderItems:1', 'settleInto:1', 'reset:0'],
  fluids: ['drain:4', 'currentAt:4', 'reset:0', 'onSwitch:1'],
  support: ['step:3', 'reset:0', 'onSwitch:1'],
  trees: ['test:1', 'topple:3', 'step:1', 'renderItems:1', 'settleInto:1', 'cancelEvent:1', 'reset:0', 'onSwitch:1'],
  explosions: ['lightAt:3', 'ignite:3', 'isBurning:3', 'hangBurning:3', 'raycast:7', 'snuff:1', 'step:1', 'renderItems:1', 'bodies:1', 'settleInto:1', 'cancelEvent:1', 'flash:1', 'shakeOffset:4', 'reset:0', 'onSwitch:1'],
};

describe('feature module interfaces', () => {
  const world = makeFakeWorld({ groundY: 10 });
  const physics = attachPhysics(world, BlockPhysics);

  for (const [name, methods] of Object.entries(SURFACE)) {
    it(`${name} exposes ${methods.map((m) => m.split(':')[0]).join(', ')}`, () => {
      const mod = physics[name];
      expect(mod.physics).toBe(physics);
      for (const m of methods) {
        const [fn, arity] = m.split(':');
        expect(typeof mod[fn], `${name}.${fn}`).toBe('function');
        // Declared parameters before the first default (Function.length) never exceed the documented arity.
        expect(mod[fn].length, `${name}.${fn} arity`).toBeLessThanOrEqual(Number(arity));
      }
    });
  }

  it('counters exist and every entity hook is safe to call on an idle world', () => {
    expect(physics.fallers.count).toBe(0);
    expect(physics.fallers.tumblerCount).toBe(0);
    expect(physics.trees.count).toBe(0);
    expect(physics.explosions.litCount).toBe(0);
    expect(typeof physics.support.busy).toBe('boolean');
    expect(physics.explosions.flash({ x: 0, y: 0, z: 0, intensity: 9 }).intensity).toBe(0);
    expect(physics.explosions.shakeOffset(0, 0, 0, [1, 2, 3])).toEqual([0, 0, 0]);
    expect(physics.fluids.currentAt(0, 11, 0, [1, 2, 3])).toEqual([0, 0, 0]);
    expect(physics.explosions.raycast(0, 12, 0, 0, 0, -1, 5)).toBeNull();
    expect(physics.bodies([])).toEqual([]);
    expect(physics.renderItems().count).toBe(0);
    const ov = new SaveOverlay(world);
    physics.trees.settleInto(ov);
    physics.explosions.settleInto(ov);
    expect(ov.cells.size).toBe(0);
  });

  it('load-bearing / self-anchored / anchor predicates (support.js)', () => {
    expect(isLoadBearing(BLOCK.STONE)).toBe(true);
    expect(isLoadBearing(BLOCK.SAND)).toBe(true); // resting gravity blocks carry
    expect(isLoadBearing(BLOCK.GLASS)).toBe(true);
    for (const id of [BLOCK.OAK_LEAVES, BLOCK.SPRUCE_LEAVES, BLOCK.BIRCH_LEAVES, BLOCK.RUNE_BLOCK, BLOCK.BLACK_HOLE,
      BLOCK.CAMPFIRE, BLOCK.WATER, BLOCK.WATER_FLOW_2, BLOCK.AIR, 255]) {
      expect(isLoadBearing(id), String(id)).toBe(false);
    }
    expect(isSelfAnchored(BLOCK.RUNE_BLOCK) && isSelfAnchored(BLOCK.BLACK_HOLE)).toBe(true);
    expect(isSelfAnchored(BLOCK.STONE)).toBe(false);
    expect(isAnchorCell(world, 0, 0, 0)).toBe(true);
    expect(isAnchorCell(world, 0, 5, 0)).toBe(true); // untouched terrain
    world.setBlock(0, 20, 0, BLOCK.STONE);
    expect(isAnchorCell(world, 0, 20, 0)).toBe(false); // a build
  });
});
