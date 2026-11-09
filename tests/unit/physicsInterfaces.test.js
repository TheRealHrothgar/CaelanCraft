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

// v0.9 survival (docs/DESIGN-survival.md §9.3–§9.4): the body's public surface, so main (package I), commands (C) and the
// screens (E) built in parallel stay plug-compatible with D. SHAPES only; behaviour is in vitals / climate / survival tests.
describe('survival body interfaces (DESIGN-survival §9.3, §9.4)', () => {
  /** Declared parameters before the first default (Function.length) never exceed the documented arity. */
  const arity = (fn, n, label) => {
    expect(typeof fn, label).toBe('function');
    expect(fn.length, `${label} arity`).toBeLessThanOrEqual(n);
  };

  it('physics, pigs and zombies', async () => {
    const physics = await import('../../src/physics.js');
    arity(physics.stepPlayer, 4, 'stepPlayer');
    const { Pigs } = await import('../../src/pigs.js');
    const { Zombies } = await import('../../src/zombies.js');
    arity(Pigs.prototype.wound, 4, 'Pigs.wound');
    arity(Pigs.prototype.pruneFar, 4, 'Pigs.pruneFar');
    arity(Pigs.prototype.spawnNatural, 9, 'Pigs.spawnNatural');
    arity(Pigs.prototype.hit, 4, 'Pigs.hit');
    arity(Zombies.prototype.hit, 4, 'Zombies.hit');
  });

  it('climate.js', async () => {
    const c = await import('../../src/climate.js');
    for (const [fn, n] of [['baseTemperature', 2], ['airTemperature', 5], ['waterTemperature', 2], ['sunFactor', 1],
      ['heatAt', 4], ['feltTemperature', 1], ['bodyTarget', 2], ['isSaltyBiome', 1]]) arity(c[fn], n, fn);
    expect(c.BIOME_SHIFT).toBeDefined();
    expect(c.DIURNAL_AMPLITUDE).toBeDefined();
    expect(Object.keys(c.HEAT_SOURCES)).toEqual(['campfire', 'kiln', 'bloomery', 'forge']);
  });

  it('vitals.js', async () => {
    const v = await import('../../src/vitals.js');
    expect(typeof v.RATES).toBe('object');
    for (const [fn, n] of [['createVitals', 0], ['statusOf', 2], ['stepVitals', 4], ['softLandingFactor', 1],
      ['fallDamage', 2], ['knockDamage', 1], ['eatFood', 3], ['queueHeal', 3]]) arity(v[fn], n, fn);
    expect(Object.keys(v.createVitals())).toEqual(['health', 'satiation', 'hydration', 'temp', 'breath', 'wet', 'sick', 'heal',
      'healRate', 'stillFor']);
    expect(Object.keys(v.statusOf(v.createVitals()))).toEqual(['canSprint', 'moveFactor', 'regen', 'labels']);
    const res = v.stepVitals(v.createVitals(), 0.1, { activity: 1, felt: 20 }, () => 0.5);
    expect(Object.keys(res)).toEqual(['damage', 'total']);
  });

  it('survival.js: the Survival class', async () => {
    const { Survival } = await import('../../src/survival.js');
    const s = new Survival();
    for (const k of ['mode', 'hasState', 'switchVersion', 'vitals', 'spawn', 'deaths', 'dead', 'fallGrace']) {
      expect(s, k).toHaveProperty(k);
    }
    for (const k of ['inSurvival', 'active', 'status']) {
      expect(typeof Object.getOwnPropertyDescriptor(Survival.prototype, k)?.get, k).toBe('function');
    }
    for (const [fn, n] of [['setMode', 1], ['begin', 0], ['step', 2], ['damage', 2], ['eat', 2], ['drink', 2], ['bandage', 1],
      ['respawn', 0], ['export', 0], ['import', 1]]) arity(Survival.prototype[fn], n, `Survival.${fn}`);
    s.setMode('survival');
    const ev = s.step(0.1, { player: null, climate: {}, time: 0.5 });
    expect(Object.keys(ev)).toEqual(expect.arrayContaining(['damage', 'causes', 'died', 'felt', 'air']));
  });
});
