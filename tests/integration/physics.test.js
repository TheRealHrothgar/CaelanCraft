// Block-physics integration — every feature at once (CONTRACTS §33–§38). Node only: no Three.js, no DOM.
//
// The unit tests check each feature module against stubs of the others; these check what only shows up when water,
// falling blocks, collapse, trees and explosives run together through ONE BlockPhysics: water flowing into a crater,
// a blast felling a tree away from it, sand and builds on a crater rim coming down, a pile of burning barrels caught
// by a collapse, one undo per action, saving in the middle of all of it (the live world untouched, the save reloading
// into a world that carries on), 200 barrels lit once, and the four switches plus `physics off`.
// Map-backed fake worlds (tests/helpers/fixtures.js) unless a real World (streaming, saving) matters.
import { describe, it, expect } from 'vitest';
import { BARREL_FUSE_S, CHUNK_SIZE, MAX_TOTAL_EDITS } from '../../src/config.js';
import { chunkKey, localIndex } from '../../src/coords.js';
import { BLOCK, isWater, isLog, isLeaves, isFallThrough } from '../../src/blocks.js';
import { HEX_DIRS, hexLength, hexToWorld } from '../../src/hex.js';
import { createPlayer } from '../../src/physics.js';
import { World } from '../../src/world.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { serializeSave, deserializeSave } from '../../src/storage.js';
import { makeFakeWorld, attachPhysics, flatWorldGen } from '../helpers/fixtures.js';

const B = BLOCK;
const GROUND = 10; // natural stone for y ≤ 10
const DT = 1 / 60;

/** Recording hooks; `bodies` / `player` from opts. */
function makeHooks(opts = {}) {
  const fx = { said: [], sounds: [], particles: [], knocks: [] };
  const bodies = opts.bodies ?? [];
  const hooks = {
    say: (text) => fx.said.push(text),
    sound: (name, x, y, z, v) => fx.sounds.push({ name, x, y, z, v }),
    particles: (kind, x, y, z, count) => fx.particles.push({ kind, x, y, z, count }),
    bodies: () => bodies,
    player: () => opts.player ?? null,
    knock: (body, vx, vy, vz, fromX, fromZ) => {
      fx.knocks.push({ body, vx, vy, vz, fromX, fromZ });
      body.vx += vx;
      body.vy += vy;
      body.vz += vz;
      body.onGround = false;
    },
  };
  return { hooks, fx };
}

/** A fake world (natural stone up to GROUND) with every physics feature attached. */
function scene(opts = {}) {
  const world = makeFakeWorld({ groundY: opts.groundY ?? GROUND, seed: opts.seed ?? 7 });
  const { hooks, fx } = makeHooks(opts);
  const physics = attachPhysics(world, BlockPhysics, hooks);
  return { world, physics, fx, ex: physics.explosions };
}

/** Nothing physics would still do on its own (water included). */
function idle(p) {
  return p.fallers.count === 0 && p.fallers.tumblerCount === 0 && p.queued() === 0 && p.seeds.size === 0 &&
    !p.support.busy && p.trees.count === 0 && p.trees.decayCount === 0 && p.explosions.litCount === 0;
}

/** Step frames until idle (or a cap). @returns {number} frames stepped */
function settle(physics, max = 4000) {
  let n = 0;
  physics.step(DT);
  while (!idle(physics) && n < max) {
    physics.step(DT);
    n++;
  }
  return n;
}

/** Step until `cond()` (or a cap). @returns {number} frames */
function stepUntil(physics, cond, max = 2000) {
  let n = 0;
  while (!cond() && n < max) {
    physics.step(DT);
    n++;
  }
  return n;
}

/** Cells within hex distance `radius` of (q, r). */
function disc(q, r, radius) {
  const out = [];
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) out.push([q + dq, r + dr]);
  }
  return out;
}

/** Every cell of a box as [q, y, r, id], skipping AIR unless `withAir`. */
function scan(world, q0, q1, y0, y1, r0, r1, withAir = false) {
  const out = [];
  for (let q = q0; q <= q1; q++) {
    for (let y = y0; y <= y1; y++) {
      for (let r = r0; r <= r1; r++) {
        const id = world.getBlock(q, y, r);
        if (withAir || id !== B.AIR) out.push([q, y, r, id]);
      }
    }
  }
  return out;
}

const countWhere = (world, pred, box) => scan(world, ...box, true).filter((c) => pred(c[3])).length;

/**
 * A worldgen-like oak: logs base..top in one column, a canopy on the two top levels, a cap above — as terrain on a
 * fake world (`put`), as edits on a real World.
 */
function plantTree(world, q0, r0, height = 6) {
  const put = world.put ? (q, y, r, id) => world.put(q, y, r, id) : (q, y, r, id) => world.setBlock(q, y, r, id);
  const base = GROUND + 1;
  const top = base + height - 1;
  for (let y = base; y <= top; y++) put(q0, y, r0, B.OAK_LOG);
  for (const y of [top - 1, top]) {
    for (const [q, r] of disc(q0, r0, 2)) {
      const d = hexLength(q - q0, r - r0);
      if (d === 0) continue;
      if (d === 2 && (q === q0 || r === r0 || q - q0 + r - r0 === 0)) continue;
      put(q, y, r, B.OAK_LEAVES);
    }
  }
  for (const [dq, dr] of [[0, 0], ...HEX_DIRS]) put(q0 + dq, top + 1, r0 + dr, B.OAK_LEAVES);
  return { base, top };
}

/** Light the barrel at the cell and step until it (and anything it chains into) has gone off. */
function blow(physics, q, y, r) {
  const ex = physics.explosions;
  const before = ex.blastCount;
  expect(ex.lightAt(q, y, r)).toBe(true);
  stepUntil(physics, () => ex.blastCount > before);
  expect(ex.blastCount).toBeGreaterThan(before);
  return ex.lastBlast;
}

describe('water and explosions', () => {
  it('water flows into a crater blasted next to a pond, stays below the pond surface, and one undo fills it all back in', () => {
    const { world, physics } = scene();
    // A pond of sources sunk into the plain (y 9..10 around (5, 0)), walled by stone: it cannot spread before the blast.
    const pond = [];
    for (const [q, r] of disc(5, 0, 2)) for (const y of [9, 10]) pond.push([q, y, r]);
    for (const [q, y, r] of pond) world.put(q, y, r, B.WATER);
    world.setBlock(1, 11, 0, B.BLAST_BARREL);
    const blast = blow(physics, 1, 11, 0);
    expect(blast.destroyed).toBeGreaterThan(40);
    for (const [q, y, r] of pond) expect(world.getBlock(q, y, r)).toBe(B.WATER); // blast-proof
    expect(world.getBlock(2, 10, 0)).toBe(B.AIR); // the crater reaches the pond's edge

    settle(physics);
    const box = [-5, 9, 0, GROUND + 4, -5, 5];
    const wet = scan(world, ...box).filter((c) => isWater(c[3]) && !pond.some((p) => p[0] === c[0] && p[1] === c[1] && p[2] === c[2]));
    expect(wet.length).toBeGreaterThan(10); // the crater flooded
    expect(wet.every((c) => c[1] <= 10)).toBe(true); // never above the pond's surface level
    expect(world.getBlock(1, 9, 0)).not.toBe(B.AIR); // the bottom of the crater is under water
    expect(isWater(world.getBlock(1, 9, 0))).toBe(true);

    const res = physics.undo();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('undid the explosion');
    expect(res.message).not.toContain('changed since'); // the flooded cells were filled back in too
    settle(physics);
    for (const [q, r] of disc(1, 0, 4)) {
      for (let y = 1; y <= GROUND; y++) {
        if (pond.some((p) => p[0] === q && p[1] === y && p[2] === r)) continue;
        expect(world.getBlock(q, y, r), `${q},${y},${r}`).toBe(B.STONE);
      }
    }
    for (const [q, y, r] of pond) expect(world.getBlock(q, y, r)).toBe(B.WATER);
    expect(world.getBlock(1, 11, 0)).toBe(B.BLAST_BARREL); // the barrel is refunded
    expect(world.editCount).toBe(1); // only the barrel: every crater and water edit pruned away
  });

  it('a lit barrel shoved over a pond drops in and goes out; the barrel sinks to the bottom as a block', () => {
    const { world, physics, ex, fx } = scene();
    for (const [q, r] of disc(4, 0, 1)) for (const y of [8, 9, 10]) world.put(q, y, r, B.WATER);
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    expect(ex.lightAt(0, 11, 0)).toBe(true);
    const b = ex.lit[0].tumbler.body;
    [b.x, b.z] = hexToWorld(4, 0); // shoved out over the water
    b.y = 11.5;
    b.onGround = false;
    stepUntil(physics, () => ex.lit.length === 0, 120);
    expect(ex.lit.length).toBe(0);
    expect(fx.sounds.some((s) => s.name === 'fizzle')).toBe(true);
    expect(fx.particles.some((p) => p.kind === 'steam')).toBe(true);
    settle(physics);
    expect(ex.blastCount).toBe(0);
    expect(world.getBlock(4, 8, 0)).toBe(B.BLAST_BARREL); // sank through the sources (water is fall-through, §35.6)
    expect(countWhere(world, (id) => id === B.BLAST_BARREL, [-2, 6, 0, 14, -3, 3])).toBe(1);
  });
});

describe('explosions, collapse and trees', () => {
  it('a blast that cuts a trunk fells the tree AWAY from the blast, and its logs end lying on the ground', () => {
    const { world, physics } = scene();
    plantTree(world, 5, 0, 7);
    world.setBlock(2, 11, 0, B.BLAST_BARREL); // 3 west of the trunk: the crater takes its lowest logs
    blow(physics, 2, 11, 0);
    expect(world.getBlock(5, 11, 0)).toBe(B.AIR);
    stepUntil(physics, () => physics.trees.count > 0, 30);
    expect(physics.trees.count).toBe(1);
    const job = physics.trees.jobs[0];
    const [dq, dr] = HEX_DIRS[job.dir];
    const [dx, dz] = hexToWorld(dq, dr);
    expect(dx).toBeGreaterThan(0.9); // away from the blast (x = 2) — the trunk is at x = 5
    expect(Math.abs(dz)).toBeLessThan(0.1);
    settle(physics);
    const logs = scan(world, -2, 16, 0, 20, -6, 6).filter((c) => isLog(c[3]));
    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(logs.every((c) => c[0] >= 5)).toBe(true); // all of it fell east
    expect(logs.every((c) => c[1] <= GROUND + 2)).toBe(true); // lying down, not standing
    expect(physics.lastEvent.kind).toBe('explosion'); // the felled tree records into the blast
  });

  it('sand on the crater rim falls into the crater; a deck on a pillar the blast cut crumbles; one undo restores everything', () => {
    const { world, physics, fx } = scene();
    // A sand mound west of the barrel, a plank deck on one stone pillar east of it.
    const sand = [];
    for (const [q, r] of disc(-3, 0, 1)) for (let y = 11; y <= 13; y++) sand.push([q, y, r]);
    for (const [q, y, r] of sand) world.setBlock(q, y, r, B.SAND);
    const deck = [];
    for (let y = 11; y <= 14; y++) world.setBlock(3, y, 0, B.STONE);
    for (const [q, r] of disc(4, 0, 1)) {
      world.setBlock(q, 15, r, B.OAK_PLANKS);
      deck.push([q, 15, r]);
    }
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    const box = [-8, 8, 0, 20, -6, 6];
    const before = scan(world, ...box, true);
    const editsBefore = world.editCount;
    const blast = blow(physics, 0, 11, 0);
    expect(world.getBlock(3, 11, 0)).toBe(B.AIR); // the pillar's foot is gone
    settle(physics);

    // Sand: nothing hangs over a fall-through cell, and some of it went down into the crater.
    const sandNow = scan(world, ...box).filter((c) => c[3] === B.SAND);
    expect(sandNow.every((c) => !isFallThrough(world.getBlock(c[0], c[1] - 1, c[2])))).toBe(true);
    expect(sandNow.some((c) => c[1] <= GROUND)).toBe(true);
    // The deck and what is left of the pillar came down: no plank above y = 12.
    const planks = scan(world, ...box).filter((c) => c[3] === B.OAK_PLANKS);
    expect(planks.every((c) => c[1] <= 12)).toBe(true);
    expect(physics.support.stats.crumbled).toBeGreaterThanOrEqual(1);
    expect(fx.said.some((s) => s.startsWith('Builds must touch the ground'))).toBe(true);
    expect(physics.lastEvent.kind).toBe('explosion');
    expect(physics.lastEvent.id).toBe(blast.event);

    const res = physics.undo();
    expect(res.ok).toBe(true);
    settle(physics);
    // Everything the blast and its collapse moved is back; sand that the GRAVITY rule moved (not part of the event)
    // is the one exception the contracts allow (§38.3), so compare everything but sand cells.
    const after = scan(world, ...box, true);
    let diff = 0;
    for (let i = 0; i < before.length; i++) {
      const was = before[i][3];
      const now = after[i][3];
      if (was === now || was === B.SAND || now === B.SAND) continue;
      diff++;
    }
    expect(diff).toBe(0);
    for (const [q, y, r] of deck) expect(world.getBlock(q, y, r)).toBe(B.OAK_PLANKS);
    for (let y = 11; y <= 14; y++) expect(world.getBlock(3, y, 0)).toBe(B.STONE);
    expect(world.getBlock(0, 11, 0)).toBe(B.BLAST_BARREL);
    expect(world.editCount).toBeGreaterThanOrEqual(editsBefore - sand.length);
  });

  it('barrels the blast set burning on a platform it cut hang where they are and go off together (a collapse never defuses them)', () => {
    const { world, physics, ex } = scene();
    // A one-high stone pillar east of the lighter, a stone platform on it, seven barrels on the platform.
    world.setBlock(2, 11, 0, B.STONE);
    for (const [q, r] of disc(2, 0, 1)) world.setBlock(q, 12, r, B.STONE);
    const pile = disc(2, 0, 1).map(([q, r]) => [q, 13, r]);
    for (const [q, y, r] of pile) world.setBlock(q, y, r, B.BLAST_BARREL);
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    blow(physics, 0, 11, 0);
    expect(world.getBlock(2, 11, 0)).toBe(B.AIR); // the pillar is gone
    const burning = [...ex.timers.values()].map((t) => [t.q, t.y, t.r]);
    expect(burning.length).toBeGreaterThanOrEqual(3); // most of the pile caught fire
    const blasts = [];
    let seen = ex.blastCount;
    for (let i = 0; i < 90; i++) {
      physics.step(DT);
      if (ex.blastCount !== seen) {
        seen = ex.blastCount;
        blasts.push({ ...ex.lastBlast });
      }
      // While they burn they stay put, even though what held them up has crumbled away.
      for (const [q, y, r] of burning) if (ex.isBurning(q, y, r)) expect(world.getBlock(q, y, r)).toBe(B.BLAST_BARREL);
    }
    expect(physics.support.stats.floating).toBeGreaterThan(0); // the collapse search did find them hanging
    expect(blasts.length).toBeGreaterThanOrEqual(1);
    expect(blasts[0].barrels).toBe(burning.length); // every burning barrel went off, together
    expect(blasts[0].y).toBeCloseTo(13.5, 5); // where they hung
    settle(physics);
    const wentOff = blasts.reduce((n, b) => n + b.barrels, 0);
    expect(countWhere(world, (id) => id === B.BLAST_BARREL, [-4, 4, 0, 20, -4, 4]) + wentOff).toBe(pile.length);
  });

  it('a hung burning barrel that stops burning without going off falls after all; saved while it hangs, it is saved where it would land', () => {
    const { world, physics, ex } = scene();
    world.setBlock(2, 11, 0, B.STONE);
    for (const [q, r] of disc(2, 0, 1)) world.setBlock(q, 12, r, B.STONE);
    const pile = disc(2, 0, 1).map(([q, r]) => [q, 13, r]);
    for (const [q, y, r] of pile) world.setBlock(q, y, r, B.BLAST_BARREL);
    world.setBlock(0, 11, 0, B.BLAST_BARREL);
    blow(physics, 0, 11, 0);
    stepUntil(physics, () => [...ex.timers.values()].some((t) => t.hung), 10);
    const hung = [...ex.timers.values()].filter((t) => t.hung);
    expect(hung.length).toBeGreaterThan(0);
    const floating = (getId, q, y, r) => isFallThrough(getId(q, y - 1, r));
    expect(hung.some((t) => floating(world.getBlock, t.q, t.y, t.r))).toBe(true); // really hanging over the crater

    // Saved now: no barrel of the save hangs over a fall-through cell (the overlay drops hung ones down their column).
    const saved = physics.exportEdits();
    const savedId = (q, y, r) => {
      const cq = Math.floor(q / CHUNK_SIZE);
      const cr = Math.floor(r / CHUNK_SIZE);
      const pairs = saved[chunkKey(cq, cr)] ?? [];
      const li = localIndex(q - cq * CHUNK_SIZE, y, r - cr * CHUNK_SIZE);
      for (let i = 0; i < pairs.length; i += 2) if (pairs[i] === li) return pairs[i + 1];
      return world.originAt(q, y, r);
    };
    for (const t of hung) expect(savedId(t.q, t.y, t.r)).toBe(B.AIR);
    for (const [q, y, r] of scan(world, -4, 6, 0, 16, -4, 4, true).map((c) => c.slice(0, 3))) {
      if (savedId(q, y, r) === B.BLAST_BARREL) expect(floating(savedId, q, y, r), `${q},${y},${r}`).toBe(false);
    }
    expect(world.getBlock(hung[0].q, hung[0].y, hung[0].r)).toBe(B.BLAST_BARREL); // the live world is untouched

    // Live: switching explosions off puts the fuses out; the hung barrels get their support check and come down.
    physics.setSwitch('explosions', false);
    expect(ex.timers.size).toBe(0);
    settle(physics);
    const barrels = scan(world, -4, 6, 0, 16, -4, 4).filter((c) => c[3] === B.BLAST_BARREL);
    expect(barrels.length).toBeGreaterThan(0);
    for (const [q, y, r] of barrels) expect(floating(world.getBlock, q, y, r), `${q},${y},${r}`).toBe(false);
  });
});

describe('undo of a collapse and of a falling tree', () => {
  it('the player cuts a pillar: the bridge deck crumbles and one undo restores it; then nothing is left to undo', () => {
    const { world, physics } = scene();
    for (let y = 11; y <= 14; y++) world.setBlock(0, y, 0, B.STONE);
    for (let q = 0; q <= 6; q++) world.setBlock(q, 15, 0, B.OAK_PLANKS);
    physics.asPlayer(() => world.setBlock(0, 11, 0, B.AIR));
    settle(physics);
    expect(world.getBlock(3, 15, 0)).toBe(B.AIR);
    expect(physics.lastEvent.kind).toBe('collapse');
    const res = physics.undo();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('undid the collapse');
    for (let q = 0; q <= 6; q++) expect(world.getBlock(q, 15, 0)).toBe(B.OAK_PLANKS);
    for (let y = 12; y <= 14; y++) expect(world.getBlock(0, y, 0)).toBe(B.STONE);
    expect(world.getBlock(0, 11, 0)).toBe(B.AIR); // the player's own cut stays
    expect(physics.undo().ok).toBe(false);
    settle(physics);
    expect(world.getBlock(3, 15, 0)).toBe(B.OAK_PLANKS); // restored quietly: no new collapse
  });

  it('the player fells a tree: undo after it landed stands it back up, leaves included', () => {
    const { world, physics } = scene();
    plantTree(world, 0, 0, 5);
    const box = [-6, 6, 0, 20, -6, 6];
    const before = scan(world, ...box).filter((c) => isLog(c[3]) || isLeaves(c[3]));
    const [x, z] = hexToWorld(0, 0);
    physics.withCause({ kind: 'player', x: x - 4, y: GROUND + 1, z }, () => world.setBlock(0, GROUND + 1, 0, B.AIR));
    settle(physics);
    expect(physics.lastEvent.kind).toBe('falling tree');
    expect(world.getBlock(0, GROUND + 3, 0)).toBe(B.AIR);
    const res = physics.undo();
    expect(res.ok).toBe(true);
    settle(physics);
    const after = scan(world, ...box).filter((c) => isLog(c[3]) || isLeaves(c[3]));
    // Every log and leaf is back where it stood, except the bottom log the player cut.
    const key = (c) => c.join(',');
    expect(new Set(after.map(key))).toEqual(new Set(before.filter((c) => !(c[0] === 0 && c[1] === GROUND + 1 && c[2] === 0)).map(key)));
  });
});

// -----------------------------------------------------------------------------------------------------------------------
// saving

/** A converged real World over flat stone with physics attached. */
function realScene(opts = {}) {
  const world = new World({ seed: 3, renderDistance: 1, worldGen: flatWorldGen(GROUND), now: () => 0, edits: opts.edits });
  const player = createPlayer(0.5, GROUND + 1, -20);
  const { hooks, fx } = makeHooks({ bodies: [player], player });
  const physics = attachPhysics(world, BlockPhysics, hooks);
  if (opts.switches) physics.importSwitches(opts.switches); // as main does from the save, before any chunk generates
  for (let i = 0; i < 500; i++) {
    const r = world.update(player.x, player.z, Infinity);
    if (r.pendingGen === 0 && r.pendingMesh === 0) break;
  }
  return { world, physics, fx, player };
}

/** A plain copy of World.edits (chunk key → [localIndex, id] pairs, sorted). */
function editsCopy(world) {
  const out = {};
  for (const [k, m] of world.edits) out[k] = [...m.entries()].sort((a, b) => a[0] - b[0]);
  return out;
}

describe('saving in the middle of everything', () => {
  it('exportEdits never touches the live world; the save holds no flowing water, settled blocks and barrels, and reloads into a world that carries on', () => {
    const { world, physics } = realScene();
    const ex = physics.explosions;
    // A water source on a stone plinth (it runs off on all sides), a tree, a sand column, two barrels.
    world.setBlock(-6, 11, 0, B.STONE);
    world.setBlock(-6, 12, 0, B.WATER);
    plantTree(world, 6, 6, 5);
    world.setBlock(0, 11, 6, B.BLAST_BARREL);
    world.setBlock(2, 11, 6, B.BLAST_BARREL);
    ex.lightAt(0, 11, 6);
    for (let i = 0; i < 150; i++) physics.step(DT); // 2.5 s of the fuse gone; water running
    for (let y = 20; y <= 23; y++) world.setBlock(0, y, -6, B.SAND); // over air: it starts to fall
    physics.withCause({ kind: 'player', x: 0, y: GROUND + 1, z: 0 }, () => world.setBlock(6, GROUND + 1, 6, B.AIR));
    stepUntil(physics, () => ex.blastCount === 1, 120); // the barrel goes off: debris, the other one burning in place
    for (let i = 0; i < 12; i++) physics.step(DT);
    // Mid-everything:
    expect(physics.fallers.count).toBeGreaterThan(0); // sand (and maybe crater rim pieces) in the air
    expect(physics.fallers.tumblerCount).toBeGreaterThan(0); // debris
    expect(physics.trees.count).toBe(1); // the tree on its way down
    expect(ex.timers.size).toBe(1); // the second barrel burning in place
    const flowing = countWhere(world, (id) => isWater(id) && id !== B.WATER, [-16, 8, 0, 14, -8, 8]);
    expect(flowing).toBeGreaterThan(0);

    const editsBefore = JSON.stringify(editsCopy(world));
    const countBefore = world.editCount;
    const versionBefore = world.editVersion;
    const state = JSON.stringify([physics.fallers.count, physics.fallers.tumblerCount, physics.trees.count, ex.litCount, physics.queued()]);
    const saved = physics.exportEdits();
    expect(JSON.stringify(physics.exportEdits())).toBe(JSON.stringify(saved)); // idempotent
    expect(JSON.stringify(editsCopy(world))).toBe(editsBefore);
    expect(world.editCount).toBe(countBefore);
    expect(world.editVersion).toBe(versionBefore);
    expect(JSON.stringify([physics.fallers.count, physics.fallers.tumblerCount, physics.trees.count, ex.litCount, physics.queued()])).toBe(state);

    // The save itself: no flowing / falling water; through storage and back.
    for (const pairs of Object.values(saved)) for (let i = 1; i < pairs.length; i += 2) expect(pairs[i] >= B.WATER_FLOW_1 && pairs[i] <= B.WATER_FALL).toBe(false);
    const text = serializeSave({ seed: 3, time: 0.5, day: 0, player: { x: 0.5, y: 11, z: -20, yaw: 0, pitch: 0 }, edits: saved, physics: physics.exportSwitches() });
    const data = deserializeSave(text);
    expect(data).not.toBeNull();

    // The live world carries on to the end.
    settle(physics);
    expect(ex.blastCount).toBe(2);

    // Reload: the falling things were saved where they come to rest, the barrel as a plain (unlit) barrel.
    const re = realScene({ edits: data.edits });
    const box = [-16, 16, 0, 30, -10, 14];
    const rs = scan(re.world, ...box);
    expect(rs.filter((c) => c[3] === B.SAND).length).toBe(4);
    expect(rs.filter((c) => c[3] === B.SAND).every((c) => !isFallThrough(re.world.getBlock(c[0], c[1] - 1, c[2])))).toBe(true);
    expect(rs.filter((c) => c[3] === B.BLAST_BARREL).length).toBe(1);
    expect(re.physics.explosions.litCount).toBe(0);
    const logs = rs.filter((c) => isLog(c[3]));
    expect(logs.length).toBe(4); // five logs, the bottom one cut
    expect(logs.every((c) => c[1] <= GROUND + 3)).toBe(true); // saved from its pose, dropped to the ground
    // Water re-flows from the saved source once its chunk loads (flow itself is never saved).
    expect(re.world.getBlock(-6, 12, 0)).toBe(B.WATER);
    settle(re.physics);
    expect(countWhere(re.world, (id) => isWater(id) && id !== B.WATER, [-16, 8, 0, 14, -8, 8])).toBeGreaterThan(0);
    expect(re.physics.explosions.blastCount).toBe(0); // nothing went off by itself after the reload
  });
});

describe('support work still pending at a save (play-test B1)', () => {
  /** A cobblestone pillar at (0, 0) holding a 7-plank beam at y 20 east of it. */
  function beam(world) {
    for (let y = 11; y <= 19; y++) world.setBlock(0, y, 0, B.COBBLESTONE);
    for (let q = 0; q <= 6; q++) world.setBlock(q, 20, 0, B.OAK_PLANKS);
  }
  const cells = (world) => {
    const out = [];
    for (let q = 0; q <= 6; q++) for (let y = 11; y <= 20; y++) out.push(world.getBlock(q, y, 0));
    return out;
  };

  it('a cut saved before its support search ran comes down on reload, as it does live', () => {
    const { world, physics } = realScene();
    beam(world);
    settle(physics);
    physics.asPlayer(() => world.setBlock(0, 15, 0, B.AIR)); // its seed waits for the next tick
    expect(physics.seeds.size).toBe(1);
    const saved = physics.exportEdits();
    expect(physics.seeds.size).toBe(1); // saving took nothing from the live queue
    expect(world.getBlock(3, 20, 0)).toBe(B.OAK_PLANKS);
    settle(physics);
    expect(world.getBlock(3, 20, 0)).toBe(B.AIR);
    const re = realScene({ edits: saved });
    settle(re.physics);
    expect(re.world.getBlock(3, 20, 0)).toBe(B.AIR); // it used to hang there for good
    expect(cells(re.world)).toEqual(cells(world));
  });

  it('removals an area command collected (not flushed yet) are searched at the save too', () => {
    const { world, physics } = realScene();
    beam(world);
    settle(physics);
    let area = true;
    physics.hooks.areaJobsActive = () => area;
    world.setBlock(0, 15, 0, B.AIR); // a `fill … air` still running
    expect(physics.areaSeedCount).toBe(1);
    const saved = physics.exportEdits();
    area = false;
    stepUntil(physics, () => physics.areaSeedCount === 0, 60); // flushed into a seed at the next tick
    settle(physics);
    expect(world.getBlock(3, 20, 0)).toBe(B.AIR);
    const re = realScene({ edits: saved });
    settle(re.physics);
    expect(cells(re.world)).toEqual(cells(world));
  });

  it('a build that already floated before the cut stays up in the save, as it does live', () => {
    const { world, physics } = realScene();
    for (let q = 0; q <= 6; q++) world.setBlock(q, 30, 0, B.OAK_PLANKS); // a sky beam on nothing
    settle(physics);
    physics.asPlayer(() => world.setBlock(3, 30, 0, B.AIR));
    const saved = physics.exportEdits();
    settle(physics);
    expect(world.getBlock(1, 30, 0)).toBe(B.OAK_PLANKS);
    const re = realScene({ edits: saved });
    settle(re.physics);
    expect([0, 1, 2, 4, 5, 6].map((q) => re.world.getBlock(q, 30, 0))).toEqual(Array(6).fill(B.OAK_PLANKS));
  });
});

describe('switched-off features across a save (play-test G3 / G4)', () => {
  const box = [-16, 8, 0, 14, -8, 8];
  const flowCells = (world) => countWhere(world, (id) => isWater(id) && id !== B.WATER, box);
  it('Water off: the frozen flow is saved as it stands, so a reload matches live play (and turning it on keeps it)', () => {
    const { world, physics } = realScene();
    world.setBlock(-6, 11, 0, B.STONE);
    world.setBlock(-6, 12, 0, B.WATER);
    settle(physics);
    const live = flowCells(world);
    expect(live).toBeGreaterThan(20);
    physics.setSwitch('water', false);
    const saved = physics.exportEdits();
    const re = realScene({ edits: saved, switches: physics.exportSwitches() });
    settle(re.physics);
    expect(flowCells(re.world)).toBe(live); // was 0: the save dropped all flow and nothing re-flowed it
    re.physics.setSwitch('water', true);
    settle(re.physics);
    expect(flowCells(re.world)).toBe(live); // switching on acts on nothing after the fact, live or reloaded
  });
  it('Falling off → on: sand left hanging while it was off falls when it is switched on, as it does on a reload', () => {
    const { world, physics } = realScene();
    physics.setSwitch('falling', false);
    for (let y = 20; y <= 22; y++) world.setBlock(3, y, 3, B.SAND);
    settle(physics);
    expect(world.getBlock(3, 20, 3)).toBe(B.SAND); // floating while off
    const saved = physics.exportEdits();
    physics.setSwitch('falling', true);
    settle(physics);
    const liveCol = [11, 12, 13, 20, 21, 22].map((y) => world.getBlock(3, y, 3));
    expect(liveCol).toEqual([B.SAND, B.SAND, B.SAND, B.AIR, B.AIR, B.AIR]); // was still hanging until a stream-in / reload
    const re = realScene({ edits: saved, switches: { ...physics.exportSwitches(), falling: true } });
    settle(re.physics);
    expect([11, 12, 13, 20, 21, 22].map((y) => re.world.getBlock(3, y, 3))).toEqual(liveCol);
  });
  it('Explosions off → on: a keg laid beside a campfire meanwhile stays unlit — live, after a reload and after a stream-in', () => {
    const { world, physics } = realScene();
    physics.setSwitch('explosions', false);
    world.setBlock(0, 11, 0, B.CAMPFIRE);
    world.setBlock(1, 11, 0, B.POWDER_KEG);
    for (let i = 0; i < 240; i++) physics.step(DT);
    physics.setSwitch('explosions', true);
    for (let i = 0; i < 300; i++) physics.step(DT);
    expect(physics.explosions.blastCount).toBe(0); // switching on acts on nothing after the fact …
    expect(world.getBlock(1, 11, 0)).toBe(B.POWDER_KEG);
    const re = realScene({ edits: physics.exportEdits(), switches: physics.exportSwitches() });
    for (let i = 0; i < 300; i++) re.physics.step(DT);
    expect(re.physics.explosions.blastCount).toBe(0); // … nor does a reload (CONTRACTS pitfall 37: loading never lights) …
    expect(re.physics.explosions.litCount).toBe(0);
    expect(re.world.getBlock(1, 11, 0)).toBe(B.POWDER_KEG);
    re.physics.onChunkGenerated(0, 0); // … nor its chunk streaming in again
    for (let i = 0; i < 300; i++) re.physics.step(DT);
    expect(re.physics.explosions.blastCount).toBe(0);
    expect(re.world.getBlock(1, 11, 0)).toBe(B.POWDER_KEG);
    re.world.setBlock(0, 11, 0, B.AIR); // a new change beside it does light it: the campfire put back
    re.world.setBlock(0, 11, 0, B.CAMPFIRE);
    expect(stepUntil(re.physics, () => re.physics.explosions.isBurning(1, 11, 0), 60)).toBeLessThan(60);
  });
});

// -----------------------------------------------------------------------------------------------------------------------
// many barrels, switches

describe('200 barrels lit once', () => {
  it('go off as a few merged booms, leave no barrel and no burning fuse, and keep every frame bounded', () => {
    const { world, physics, ex } = scene({ groundY: 30 });
    const cells = [];
    for (const [q, r] of disc(0, 0, 5)) for (const y of [31, 32, 33]) cells.push([q, y, r]);
    cells.length = 200;
    for (const [q, y, r] of cells) world.setBlock(q, y, r, B.BLAST_BARREL);
    const [lq, ly, lr] = cells.reduce((a, c) => (c[1] === 31 && hexLength(c[0], c[2]) > hexLength(a[0], a[2]) ? c : a));
    expect(ex.lightAt(lq, ly, lr)).toBe(true); // one at the edge of the bottom layer
    const blasts = [];
    let worst = 0;
    let seen = 0;
    for (let i = 0; i < 60 * 20 && (i < 10 || !idle(physics)); i++) {
      const t0 = performance.now();
      physics.step(DT);
      worst = Math.max(worst, performance.now() - t0);
      if (ex.blastCount !== seen) {
        seen = ex.blastCount;
        blasts.push({ ...ex.lastBlast });
      }
    }
    settle(physics);
    expect(countWhere(world, (id) => id === B.BLAST_BARREL, [-12, 12, 20, 40, -12, 12])).toBe(0);
    expect(ex.litCount).toBe(0);
    expect(blasts.length).toBeGreaterThanOrEqual(2);
    expect(blasts.length).toBeLessThanOrEqual(8); // merged: a few big booms, not 200
    expect(blasts.reduce((n, b) => n + b.barrels, 0)).toBe(200);
    expect(world.editCount).toBeLessThan(MAX_TOTAL_EDITS);
    expect(worst).toBeLessThan(400); // generous for a loaded test machine; measured ~20–60 ms
  });
});

describe('switches and physics off', () => {
  it('each switch stops its feature, and switching it back on never acts on what happened meanwhile', () => {
    const { world, physics, ex } = scene();
    physics.setSwitch('falling', false);
    world.setBlock(0, 14, 0, B.SAND);
    physics.setSwitch('water', false);
    world.setBlock(-5, 11, 0, B.STONE);
    world.setBlock(-5, 12, 0, B.WATER);
    physics.setSwitch('collapse', false);
    for (let y = 11; y <= 13; y++) world.setBlock(5, y, 0, B.STONE);
    world.setBlock(6, 13, 0, B.STONE);
    world.setBlock(5, 11, 0, B.AIR);
    physics.setSwitch('explosions', false);
    world.setBlock(0, 11, 5, B.BLAST_BARREL);
    world.setBlock(1, 11, 5, B.CAMPFIRE);
    expect(ex.lightAt(0, 11, 5)).toBe(false);
    for (let i = 0; i < 120; i++) physics.step(DT);
    for (const f of ['falling', 'water', 'collapse', 'explosions']) physics.setSwitch(f, true);
    settle(physics);
    expect(world.getBlock(0, 14, 0)).toBe(B.SAND); // still hanging
    expect(countWhere(world, isWater, [-10, 0, 8, 14, -5, 5])).toBe(1); // the source alone, no flow
    expect(world.getBlock(5, 12, 0)).toBe(B.STONE); // the cut pillar still stands
    expect(world.getBlock(0, 11, 5)).toBe(B.BLAST_BARREL); // not lit after the fact
    expect(ex.blastCount).toBe(0);
    // Touching them now does act.
    world.setBlock(0, 15, 0, B.GRAVEL);
    world.setBlock(0, 14, 0, B.AIR);
    world.setBlock(0, 14, 0, B.SAND);
    settle(physics);
    expect(world.getBlock(0, 11, 0)).toBe(B.SAND);
    expect(world.getBlock(0, 12, 0)).toBe(B.GRAVEL);
  });

  it('physics off freezes falling sand, flowing water, a toppling tree and a lit fuse; physics on finishes all of them', () => {
    const { world, physics, ex } = scene();
    world.setBlock(0, 20, 0, B.SAND);
    world.setBlock(-6, 11, 0, B.STONE);
    world.setBlock(-6, 12, 0, B.WATER);
    plantTree(world, 8, 0, 5);
    physics.withCause({ kind: 'player', x: 0, y: 11, z: 0 }, () => world.setBlock(8, 11, 0, B.AIR));
    world.setBlock(0, 11, 8, B.BLAST_BARREL);
    ex.lightAt(0, 11, 8);
    for (let i = 0; i < 20; i++) physics.step(DT);
    physics.setPaused(true);
    const box = [-14, 14, 0, 24, -8, 12];
    const frozen = JSON.stringify(scan(world, ...box));
    const fuse = ex.lit[0].fuse;
    expect(fuse).toBeLessThan(BARREL_FUSE_S); // it was burning before the pause
    const fy = physics.fallers.count;
    const theta = physics.trees.jobs.map((j) => j.theta).join();
    for (let i = 0; i < 300; i++) physics.step(DT);
    expect(JSON.stringify(scan(world, ...box))).toBe(frozen);
    expect(ex.lit[0].fuse).toBe(fuse);
    expect(physics.fallers.count).toBe(fy);
    expect(physics.trees.jobs.map((j) => j.theta).join()).toBe(theta);
    // Things done while paused still count once physics runs again.
    world.setBlock(3, 16, 0, B.GRAVEL);
    physics.setPaused(false);
    settle(physics);
    expect(world.getBlock(0, 11, 0)).toBe(B.SAND);
    expect(world.getBlock(3, 11, 0)).toBe(B.GRAVEL);
    expect(countWhere(world, (id) => isWater(id) && id !== B.WATER, [-14, 0, 8, 14, -8, 8])).toBeGreaterThan(0);
    expect(physics.trees.stats.impacts).toBe(1);
    expect(ex.blastCount).toBe(1);
  });
});
