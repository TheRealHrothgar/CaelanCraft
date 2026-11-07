// Unit tests for src/trees.js — the tree test (logs only, ≤ 2 adjacent columns, leaf ownership), the topple (direction,
// shake + rod dynamics, collision against non-leaf solids, impact into column fallers lying on the ground, knocked
// bodies), leaf decay, the 4-at-once queue, saving and undo (CONTRACTS §36.3–§36.6) — on the Map-backed fake world, and
// on real worldgen forests (cutting the bottom log fells ~every tree).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { TREE_MAX_TOPPLING, TREE_QUEUE_GAP_S, TREE_SHAKE_S, TREE_MAX_CELLS } from '../../src/config.js';
import { BLOCK, BIOME, isLog, isLeaves } from '../../src/blocks.js';
import { FACE_NORMALS, HEX_DIRS, hexLength, hexToWorld } from '../../src/hex.js';
import { createPlayer, playerIntersectsBlock } from '../../src/physics.js';
import { World } from '../../src/world.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { tiltEuler, shakeAngle } from '../../src/trees.js';
import { makeFakeWorld, attachPhysics } from '../helpers/fixtures.js';

const B = BLOCK;
const GROUND = 10; // natural ground for y ≤ 10; trees stand on it from y = 11

function setup(opts = {}) {
  const world = makeFakeWorld({ groundY: GROUND, seed: opts.seed });
  const fx = { sounds: [], particles: [], spawns: [] };
  const hooks = {
    sound: (name, x, y, z, v) => fx.sounds.push({ name, x, y, z, v }),
    particles: (kind, x, y, z, count, o) => fx.particles.push({ kind, x, y, z, count, o }),
    ...opts.hooks,
  };
  const physics = attachPhysics(world, BlockPhysics, hooks);
  const spawn = physics.fallers.spawn.bind(physics.fallers);
  physics.fallers.spawn = (id, q, y, r, o) => {
    fx.spawns.push([q, y, r, id]);
    return spawn(id, q, y, r, o);
  };
  return { world, physics, fx };
}

/** Ring-1 and the non-corner ring-2 cells (12), like worldgen's canopy. */
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

/**
 * A worldgen-like oak at column (q0, r0): logs base..base+height−1, leaves on the two top log levels (12 each), a
 * 7-cell layer above and one crown cell — placed as terrain (no edits, no hooks). @returns {{ top, leaves }}
 */
function plantTree(world, q0, r0, { base = GROUND + 1, height = 5, log = B.OAK_LOG, leaf = B.OAK_LEAVES } = {}) {
  const top = base + height - 1;
  for (let y = base; y <= top; y++) world.put(q0, y, r0, log);
  const cells = [];
  for (const y of [top - 1, top]) for (const [dq, dr] of CANOPY) cells.push([q0 + dq, y, r0 + dr]);
  for (const [dq, dr] of [[0, 0], ...HEX_DIRS]) cells.push([q0 + dq, top + 1, r0 + dr]);
  cells.push([q0, top + 2, r0]);
  let leaves = 0;
  for (const [q, y, r] of cells) {
    if (world.getBlock(q, y, r) !== B.AIR) continue;
    world.put(q, y, r, leaf);
    leaves++;
  }
  return { top, leaves };
}

const idle = (p) => p.fallers.count === 0 && p.queued() === 0 && p.seeds.size === 0 && !p.support.busy &&
  p.trees.count === 0 && p.trees.decayCount === 0;

function settle(physics, max = 3000) {
  let n = 0;
  physics.step(1 / 60);
  while (!idle(physics) && n < max) {
    physics.step(1 / 60);
    n++;
  }
  return n;
}

/** [q, y, r, id] of every log / leaf in a box. */
function scan(world, pred, q0, q1, y0, y1, r0, r1) {
  const out = [];
  for (let q = q0; q <= q1; q++) for (let y = y0; y <= y1; y++) for (let r = r0; r <= r1; r++) {
    const id = world.getBlock(q, y, r);
    if (pred(id)) out.push([q, y, r, id]);
  }
  return out;
}

/** Cut the bottom log of the tree at (q, r) with `cause` (default: a player standing 6 west of it). */
function cut(physics, world, q, r, cause) {
  const [x, z] = hexToWorld(q, r);
  physics.withCause(cause ?? { kind: 'player', x: x - 6, y: GROUND + 1, z }, () => world.setBlock(q, GROUND + 1, r, B.AIR));
}

describe('tree test', () => {
  it('a trunk of ≥ 3 logs in one column is a tree: logs lowest first, its leaves, the cut cell and the pivot', () => {
    const { world, physics } = setup();
    const { leaves } = plantTree(world, 0, 0);
    expect(leaves).toBe(32);
    const logs = [12, 13, 14, 15].map((y) => [0, y, 0, B.OAK_LOG]).reverse();
    const tree = physics.trees.test({ cells: logs, cause: { kind: 'world' }, event: 0 });
    expect(tree.logs.map((c) => c[1])).toEqual([12, 13, 14, 15]);
    expect(tree.leaves.length).toBe(32);
    expect(tree.leaves.every((c) => isLeaves(c[3]))).toBe(true);
    expect(tree.cut).toEqual([0, 11, 0]);
    expect(tree.pivot).toEqual([0, 12, 0]);
  });

  it('two adjacent columns are a tree; three columns, separated columns, < 3 logs, or other blocks are not', () => {
    const { physics } = setup();
    const test = (cells) => physics.trees.test({ cells, cause: { kind: 'world' }, event: 0 });
    expect(test([[0, 12, 0, B.OAK_LOG], [0, 13, 0, B.OAK_LOG], [1, 13, 0, B.BIRCH_LOG]])).not.toBeNull();
    expect(test([[0, 12, 0, B.OAK_LOG], [1, 12, 0, B.OAK_LOG], [2, 12, 0, B.OAK_LOG]])).toBeNull();
    expect(test([[0, 12, 0, B.OAK_LOG], [0, 13, 0, B.OAK_LOG], [2, 13, 0, B.OAK_LOG]])).toBeNull();
    expect(test([[0, 12, 0, B.OAK_LOG], [0, 13, 0, B.OAK_LOG]])).toBeNull();
    expect(test([[0, 12, 0, B.OAK_LOG], [0, 13, 0, B.OAK_LOG], [0, 14, 0, B.OAK_PLANKS]])).toBeNull();
    const tall = [];
    for (let y = 1; y <= TREE_MAX_CELLS + 1; y++) tall.push([0, y % 120, Math.floor(y / 120), B.OAK_LOG]);
    expect(test(tall)).toBeNull();
  });

  it('leaf ownership: a leaf nearer another trunk is that tree’s; ties go to the tree being tested', () => {
    const { world, physics } = setup();
    plantTree(world, 0, 0);
    plantTree(world, 3, 0); // 3 apart, like the closest worldgen trees: the canopies overlap
    const logs = [12, 13, 14, 15].map((y) => [0, y, 0, B.OAK_LOG]);
    const tree = physics.trees.test({ cells: logs, cause: { kind: 'world' }, event: 0 });
    const has = (q, r) => tree.leaves.some((c) => c[0] === q && c[2] === r && c[1] === 14);
    expect(world.getBlock(2, 14, 0)).toBe(B.OAK_LEAVES);
    expect(has(2, 0)).toBe(false); // distance 2 from this trunk, 1 from the other: the other tree's
    expect(has(2, -1)).toBe(true); // distance 2 from both: ours
    expect(has(1, 1)).toBe(true);
    expect(has(1, 0)).toBe(true);
    expect(tree.leaves.every((c) => hexLength(c[0], c[2]) <= 2)).toBe(true);
  });
});

describe('topple', () => {
  it('shakes (creak), falls as a rod in ≈ 1.2 s away from the player, and ends lying on the ground', () => {
    const { world, physics, fx } = setup();
    plantTree(world, 0, 0);
    cut(physics, world, 0, 0); // the player stands 6 west: it falls east
    physics.tick();
    expect(physics.support.stats.toppled).toBe(1);
    expect(physics.lastEvent.kind).toBe('falling tree');
    expect(physics.trees.count).toBe(1);
    expect(physics.trees.jobs[0]).toMatchObject({ dir: 0, phase: 'shake', logs: 4, cells: 36 });
    expect(fx.sounds.filter((s) => s.name === 'creak')).toHaveLength(1);
    // The tree is out of the world at once: logs and leaves.
    expect(scan(world, (id) => isLog(id) || isLeaves(id), -3, 3, 11, 20, -3, 3)).toHaveLength(0);
    // Drawn while it falls: 36 cells, the tilt grows monotonically after the shake.
    expect(physics.renderItems().count).toBe(36);
    let t = 0;
    let last = 0;
    while (physics.trees.count > 0 && t < 3) {
      physics.step(1 / 60);
      t += 1 / 60;
      const j = physics.trees.jobs[0];
      if (j && j.phase === 'fall') {
        expect(j.theta).toBeGreaterThanOrEqual(last);
        last = j.theta;
      }
    }
    expect(t).toBeGreaterThan(0.8);
    expect(t).toBeLessThan(1.6);
    expect(physics.trees.stats.impacts).toBe(1);
    expect(fx.particles.filter((p) => p.kind === 'leaves').length).toBeGreaterThanOrEqual(32);
    expect(fx.sounds.some((s) => s.name === 'thud')).toBe(true);
    settle(physics);
    const logs = scan(world, isLog, -3, 6, 11, 20, -3, 3);
    expect(logs).toHaveLength(4);
    expect(logs.every((c) => c[1] === GROUND + 1 && c[2] === 0)).toBe(true); // lying on the ground, along +x
    expect(logs.map((c) => c[0]).sort()).toEqual([1, 2, 3, 4]);
    expect(scan(world, isLeaves, -3, 6, 11, 20, -3, 3)).toHaveLength(0);
  });

  it('falls away from a blast; with no cause nearby, in a seeded random direction', () => {
    const dirs = [];
    for (const [cause, expected] of [[{ kind: 'explosion', x: 0.5, y: 12, z: 5 }, 4], [{ kind: 'explosion', x: 3, y: 12, z: -2 }, 2]]) {
      const { world, physics } = setup();
      plantTree(world, 0, 0);
      cut(physics, world, 0, 0, cause);
      physics.tick();
      // a blast south (+z) of the trunk, a little east → it falls NW (4); a blast north-east → SW (2)
      expect(physics.trees.jobs[0].dir).toBe(expected);
    }
    for (let k = 0; k < 2; k++) {
      const { world, physics } = setup({ seed: 77 });
      plantTree(world, 0, 0);
      cut(physics, world, 0, 0, { kind: 'world' });
      physics.tick();
      dirs.push(physics.trees.jobs[0].dir);
    }
    expect(dirs[0]).toBe(dirs[1]);
    expect(dirs[0]).toBeGreaterThanOrEqual(0);
    expect(dirs[0]).toBeLessThan(6);
  });

  it('a solid in the way stops it early (logs pile against it, never inside)', () => {
    const { world, physics, fx } = setup();
    plantTree(world, 0, 0);
    for (let y = 11; y <= 16; y++) world.setBlock(3, y, 0, B.STONE); // a wall east of the trunk
    cut(physics, world, 0, 0);
    physics.tick();
    let maxTheta = 0;
    for (let i = 0; i < 300 && physics.trees.count > 0; i++) {
      physics.step(1 / 60);
      if (physics.trees.count > 0) maxTheta = Math.max(maxTheta, physics.trees.jobs[0].theta);
    }
    expect(physics.trees.stats.impacts).toBe(1);
    expect(maxTheta).toBeGreaterThan(0.5);
    expect(maxTheta).toBeLessThan(1.0); // stopped well before lying flat
    expect(fx.spawns.every(([q]) => q < 3)).toBe(true);
    settle(physics);
    for (let y = 11; y <= 16; y++) expect(world.getBlock(3, y, 0)).toBe(B.STONE);
    expect(scan(world, isLog, -3, 6, 11, 20, -3, 3)).toHaveLength(4);
  });

  it("passes through another tree's leaves (canopy-linked trees): the other tree stands, the cut one lies flat", () => {
    const { world, physics, fx } = setup();
    plantTree(world, 0, 0);
    plantTree(world, 4, -1); // its canopy reaches into the fall path (q 3, r 0), its trunk is beside it
    const otherLeaf = world.getBlock(3, 14, 0);
    expect(otherLeaf).toBe(B.OAK_LEAVES);
    cut(physics, world, 0, 0);
    physics.tick();
    expect(physics.support.stats.toppled).toBe(1); // leaves do not carry: the touching canopy held nothing up
    expect(world.getBlock(3, 14, 0)).toBe(B.OAK_LEAVES); // not this tree's
    let maxTheta = 0;
    for (let i = 0; i < 300 && physics.trees.count > 0; i++) {
      physics.step(1 / 60);
      if (physics.trees.count > 0) maxTheta = Math.max(maxTheta, physics.trees.jobs[0].theta);
    }
    expect(maxTheta).toBeGreaterThan(1.4);
    expect(fx.spawns.every(([, y]) => y === GROUND + 2)).toBe(true); // it lay flat (θ = π/2) before turning to fallers
    expect(Math.max(...fx.spawns.map(([q]) => q))).toBeGreaterThanOrEqual(3);
    settle(physics);
    for (let y = 11; y <= 15; y++) expect(world.getBlock(4, y, -1)).toBe(B.OAK_LOG); // the other tree stands
    expect(world.getBlock(3, 14, 0)).toBe(B.OAK_LEAVES);
  });

  it('knocks a body near a landing log away and never buries it', () => {
    const [x0, z0] = hexToWorld(0, 0);
    const player = createPlayer(x0 + 2.5, GROUND + 1, z0);
    const { world, physics } = setup({ hooks: { bodies: () => [player], player: () => player } });
    plantTree(world, 0, 0);
    cut(physics, world, 0, 0, { kind: 'explosion', x: x0 - 4, y: 12, z: z0 }); // falls east, onto the player
    for (let i = 0; i < 200 && physics.trees.stats.impacts === 0; i++) physics.step(1 / 60);
    expect(physics.trees.stats.impacts).toBe(1);
    expect(player.vy).toBeGreaterThanOrEqual(5);
    expect(player.vx).toBeGreaterThan(0);
    settle(physics);
    for (const [q, y, r] of scan(world, isLog, -3, 6, 11, 20, -3, 3)) expect(playerIntersectsBlock(player, q, y, r)).toBe(false);
  });

  it('at most TREE_MAX_TOPPLING fall at once; the rest wait (drawn standing) and start TREE_QUEUE_GAP_S apart', () => {
    const { world, physics } = setup();
    const n = TREE_MAX_TOPPLING + 2;
    for (let i = 0; i < n; i++) plantTree(world, i * 10, 0);
    for (let i = 0; i < n; i++) cut(physics, world, i * 10, 0);
    physics.tick();
    expect(physics.trees.count).toBe(n);
    expect(physics.trees.jobs.filter((j) => j.phase === 'queued')).toHaveLength(2);
    expect(physics.renderItems().count).toBe(36 * n);
    expect(physics.lastEvent.kind).toBe('falling tree');
    const started = [];
    let t = 0;
    let waiting = 2;
    while (physics.trees.count > 0 && t < 10) {
      physics.step(1 / 60);
      t += 1 / 60;
      const q = physics.trees.jobs.filter((j) => j.phase === 'queued').length;
      if (q < waiting) {
        started.push(t);
        waiting = q;
      }
    }
    expect(physics.trees.stats.impacts).toBe(n);
    expect(started).toHaveLength(2);
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(TREE_QUEUE_GAP_S - 1e-9);
    settle(physics);
    expect(scan(world, isLog, -3, n * 10 + 6, 11, 20, -3, 3)).toHaveLength(4 * n);
  });

  it('leaves left with no log within 3 decay over ~1 s; leaves near another trunk stay', () => {
    const { world, physics, fx } = setup();
    plantTree(world, 0, 0);
    world.put(-3, 14, 0, B.OAK_LEAVES); // beyond the tree's own leaves (distance 3), no other log near: decays
    plantTree(world, 0, 6);
    world.put(0, 14, 3, B.OAK_LEAVES); // distance 3 from both trunks: the other one keeps it
    cut(physics, world, 0, 0);
    physics.tick();
    expect(physics.trees.decayCount).toBe(1);
    const before = fx.particles.length;
    for (let i = 0; i < 70; i++) physics.step(1 / 60);
    expect(world.getBlock(-3, 14, 0)).toBe(B.AIR);
    expect(physics.trees.stats.decayed).toBe(1);
    expect(fx.particles.slice(before).some((p) => p.kind === 'leaves')).toBe(true);
    expect(world.getBlock(0, 14, 3)).toBe(B.OAK_LEAVES);
  });
});

describe('saving and undo', () => {
  it('saving mid-fall writes the logs dropped from their current pose into the copy; the world is untouched', () => {
    const { world, physics } = setup();
    plantTree(world, 0, 0);
    cut(physics, world, 0, 0);
    physics.tick();
    for (let i = 0; i < 40; i++) physics.step(1 / 60);
    expect(physics.trees.jobs[0].phase).toBe('fall');
    const edits = physics.exportEdits();
    let logs = 0;
    const cells = [];
    for (const arr of Object.values(edits)) for (let i = 0; i < arr.length; i += 2) if (arr[i + 1] === B.OAK_LOG) logs++;
    for (let q = -3; q <= 6; q++) for (let y = 11; y <= 20; y++) for (let r = -3; r <= 3; r++) if (isLog(world.getBlock(q, y, r))) cells.push([q, y, r]);
    expect(logs).toBe(4);
    expect(cells).toHaveLength(0); // still in the air
    expect(physics.trees.count).toBe(1);
  });

  it('undo mid-fall drops the falling tree and puts it back; after landing it lifts the logs off the ground', () => {
    for (const frames of [30, 400]) {
      const { world, physics } = setup();
      plantTree(world, 0, 0);
      const before = scan(world, (id) => isLog(id) || isLeaves(id), -3, 6, 11, 20, -3, 3);
      cut(physics, world, 0, 0);
      physics.tick();
      for (let i = 0; i < frames; i++) physics.step(1 / 60);
      const res = physics.undo();
      expect(res.ok).toBe(true);
      expect(res.message).toContain('falling tree');
      expect(physics.trees.count).toBe(0);
      const after = scan(world, (id) => isLog(id) || isLeaves(id), -3, 6, 11, 20, -3, 3);
      expect(after).toEqual(before.filter(([q, y, r]) => !(q === 0 && y === GROUND + 1 && r === 0))); // all but the cut log
    }
  });
});

describe('rotation helpers', () => {
  it("tiltEuler matches three.js: Euler 'YXZ' of a rotation by θ about a horizontal axis", () => {
    const v = new THREE.Vector3();
    for (let j = 0; j < 6; j++) {
      const [dx, , dz] = FACE_NORMALS[j];
      for (const theta of [0, 0.1, 0.7, 1.2, Math.PI / 2, -0.03]) {
        const [rx, ry, rz] = tiltEuler(dz, -dx, theta);
        const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
        v.set(0, 1, 0).applyMatrix4(m); // the trunk's axis tips toward the fall direction
        expect(v.x).toBeCloseTo(dx * Math.sin(theta), 9);
        expect(v.y).toBeCloseTo(Math.cos(theta), 9);
        expect(v.z).toBeCloseTo(dz * Math.sin(theta), 9);
        const axis = new THREE.Vector3(dz, 0, -dx);
        const ref = new THREE.Vector3(0.3, -0.2, 0.9).applyAxisAngle(axis, theta);
        v.set(0.3, -0.2, 0.9).applyMatrix4(m);
        expect(v.distanceTo(ref)).toBeLessThan(1e-9);
      }
    }
  });

  it('the shake eases into TREE_THETA0 within ±2° wobbles', () => {
    expect(shakeAngle(0)).toBe(0);
    expect(shakeAngle(TREE_SHAKE_S)).toBeCloseTo(0.12, 9);
    for (let t = 0; t <= TREE_SHAKE_S; t += 0.005) expect(Math.abs(shakeAngle(t))).toBeLessThan(0.12 + 0.036);
  });
});

describe('real worldgen forests', { timeout: 60000 }, () => {
  /** A World for `seed` with the forest found nearest the scan origin generated (chunks within hex distance R + 1). */
  function forest(seed, R) {
    const world = new World({ seed, now: () => 0 });
    let best = [0, 0];
    for (let i = 0; i < 400; i++) {
      const q = (i % 20) * 40 - 400;
      const r = Math.floor(i / 20) * 40 - 400;
      if (world.getBiome(q, r) === BIOME.FOREST) {
        best = [q, r];
        break;
      }
    }
    const pcq = Math.floor(best[0] / 16);
    const pcr = Math.floor(best[1] / 16);
    // Generation only (no meshing): the search reads blocks, the extra ring keeps the trees' neighbours loaded.
    for (let dq = -R - 1; dq <= R + 1; dq++) for (let dr = -R - 1; dr <= R + 1; dr++) if (hexLength(dq, dr) <= R + 1) world._generate(pcq + dq, pcr + dr);
    const physics = attachPhysics(world, BlockPhysics);
    /** @type {number[][]} [q, h, r]: every tree base (a log on the terrain surface) in the inner chunks */
    const trees = [];
    for (let cq = pcq - R; cq <= pcq + R; cq++) for (let cr = pcr - R; cr <= pcr + R; cr++) {
      if (hexLength(cq - pcq, cr - pcr) > R) continue;
      for (let lq = 0; lq < 16; lq++) for (let lr = 0; lr < 16; lr++) {
        const q = cq * 16 + lq;
        const r = cr * 16 + lr;
        const h = world.terrainHeightAt(q, r);
        if (isLog(world.getBlock(q, h + 1, r)) && !isLog(world.getBlock(q, h, r))) trees.push([q, h, r]);
      }
    }
    return { world, physics, trees };
  }

  it('cutting the bottom log topples ~every tree (4 seeds)', () => {
    let total = 0;
    let toppled = 0;
    for (const seed of ['1', 'caelan', '12345', 'honey']) {
      const { world, physics, trees } = forest(seed, 2);
      expect(trees.length, `seed ${seed}`).toBeGreaterThan(30);
      for (const [q, h, r] of trees) {
        const before = physics.support.stats.toppled;
        physics.asPlayer(() => world.setBlock(q, h + 1, r, B.AIR));
        for (let i = 0; i < 3 && (physics.seeds.size > 0 || physics.support.busy); i++) physics.tick();
        if (physics.support.stats.toppled > before) toppled++;
        physics.clear(); // drop it mid-air: the next tree is measured on its own
      }
      total += trees.length;
    }
    expect(toppled / total).toBeGreaterThanOrEqual(0.98);
  }, 60000);

  it('a felled worldgen tree ends as logs on the ground (none lost), with no leaves left hanging around its stump', () => {
    const { world, physics, trees } = forest('caelan', 1);
    const [q, h, r] = trees[Math.floor(trees.length / 2)];
    const logsIn = () => {
      let n = 0;
      for (let dq = -9; dq <= 9; dq++) for (let dr = -9; dr <= 9; dr++) {
        if (hexLength(dq, dr) > 9) continue;
        for (let y = h - 6; y <= h + 12; y++) if (isLog(world.getBlock(q + dq, y, r + dr))) n++;
      }
      return n;
    };
    const before = logsIn();
    physics.asPlayer(() => world.setBlock(q, h + 1, r, B.AIR));
    settle(physics);
    expect(physics.trees.stats.impacts).toBe(1);
    expect(logsIn()).toBe(before - 1);
    let fallen = 0; // logs of the felled trunk now lying away from the stump
    let hanging = 0;
    for (let dq = -2; dq <= 2; dq++) for (let dr = -2; dr <= 2; dr++) {
      if (hexLength(dq, dr) > 2) continue;
      for (let y = h + 2; y <= h + 12; y++) {
        if (!isLeaves(world.getBlock(q + dq, y, r + dr))) continue;
        // a leaf left near the stump must still have a log within 3 (another tree's)
        let near = false;
        for (let a = -3; a <= 3 && !near; a++) for (let b = -3; b <= 3 && !near; b++) {
          if (hexLength(a, b) > 3) continue;
          for (let yy = y - 3; yy <= y + 3 && !near; yy++) if (isLog(world.getBlock(q + dq + a, yy, r + dr + b))) near = true;
        }
        if (!near) hanging++;
      }
    }
    for (const [dq, dr] of HEX_DIRS) for (let k = 2; k <= 6; k++) {
      for (let y = h - 4; y <= h + 4; y++) if (isLog(world.getBlock(q + dq * k, y, r + dr * k))) fallen++;
    }
    expect(hanging).toBe(0);
    expect(fallen).toBeGreaterThan(0);
  }, 30000);
});
