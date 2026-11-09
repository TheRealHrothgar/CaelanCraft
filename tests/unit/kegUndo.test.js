// Unit tests for package B-post's edit to src/blockphysics.js (docs/DESIGN-circuits.md §3.1, §3.6): undo never relights a
// restored scene. The optional PhysicsHooks `isIgnitable(id)` (main → circuitParts.isIgnitable) and `ignitesAt(q, y, r)`
// (main → circuits.wouldIgnite) make undo restore kegs AND every other ignitable cell (powder fuses, charges) last, each as
// its own block, and skip one that a torch, a campfire or a still-powered igniter would light again; the notes say "kegs".
import { describe, it, expect } from 'vitest';
import { BLOCK } from '../../src/blocks.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { makeFakeWorld, attachPhysics } from '../helpers/fixtures.js';

const B = BLOCK;
const GROUND = 10;
const DT = 1 / 60;

/** A keg at the origin with powder fuses two cells either side, blown up, then undone. */
function fuseScene(hooks) {
  const world = makeFakeWorld({ groundY: GROUND, seed: 7 });
  const physics = attachPhysics(world, BlockPhysics, hooks);
  const ex = physics.explosions;
  world.setBlock(0, 11, 0, B.POWDER_KEG);
  world.setBlock(2, 11, 0, B.POWDER_FUSE);
  world.setBlock(-2, 11, 0, B.POWDER_FUSE);
  ex.igniteInPlace(0, 11, 0);
  for (let i = 0; i < 400 && ex.blastCount === 0; i++) physics.step(DT);
  expect(ex.blastCount).toBe(1);
  expect(world.getBlock(2, 11, 0)).toBe(B.AIR);
  expect(world.getBlock(-2, 11, 0)).toBe(B.AIR);
  world.writes.length = 0;
  return { world, physics, ex, res: physics.undo() };
}
const isIgnitable = (id) => id === B.POWDER_FUSE || id === B.POWDER_KEG || id === B.COLLAPSAR_CHARGE;

describe('undo never relights a restored scene (DESIGN-circuits §3.6: the physics hooks isIgnitable / ignitesAt)', () => {
  it('fuse cells come back last, as fuses, except where ignitesAt says they would catch', () => {
    const { world, res } = fuseScene({ isIgnitable, ignitesAt: (q, y, r) => q === -2 && y === 11 && r === 0 });
    expect(res.ok).toBe(true);
    expect(world.getBlock(2, 11, 0)).toBe(B.POWDER_FUSE);
    expect(world.getBlock(-2, 11, 0)).toBe(B.AIR);
    expect(world.getBlock(0, 11, 0)).toBe(B.POWDER_KEG);
    expect(res.message).toContain('(1 keg or fuse next to a fire not given back)');
    const first = world.writes.findIndex((w) => isIgnitable(w.id));
    expect(first).toBeGreaterThan(0);
    expect(world.writes.slice(first).every((w) => isIgnitable(w.id))).toBe(true); // nothing else after the first ignitable
  });

  it('a keg beside a cell where ignitesAt holds is not given back either; plural wording', () => {
    const { world, res } = fuseScene({ isIgnitable, ignitesAt: (q, y) => y === 11 });
    expect(world.getBlock(0, 11, 0)).toBe(B.AIR);
    expect(world.getBlock(2, 11, 0)).toBe(B.AIR);
    expect(res.message).toContain('(3 kegs or fuses next to a fire not given back)');
  });

  it('without the hooks a fuse cell is restored like any block (the defaults: nothing else is ignitable or catches)', () => {
    const { world, res } = fuseScene({});
    expect(world.getBlock(2, 11, 0)).toBe(B.POWDER_FUSE);
    expect(world.getBlock(-2, 11, 0)).toBe(B.POWDER_FUSE);
    expect(world.getBlock(0, 11, 0)).toBe(B.POWDER_KEG);
    expect(res.message).not.toContain('not given back');
  });

  it('the hooks default to nothing ignitable and nothing catching; the status line counts lit kegs', () => {
    const world = makeFakeWorld({ groundY: GROUND, seed: 7 });
    const physics = attachPhysics(world, BlockPhysics, {});
    expect(physics.statusText()).toContain('lit kegs 0');
    expect(physics.statusText()).not.toContain('barrel');
    expect(physics.hooks.isIgnitable(B.POWDER_FUSE)).toBe(false); // the defaults
    expect(physics.hooks.ignitesAt(0, 11, 0)).toBe(false);
  });
});
