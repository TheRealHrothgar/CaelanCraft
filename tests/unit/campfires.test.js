// Unit tests for src/campfires.js and the campfire's block / mesher / pig rules (CONTRACTS §32).
import { describe, it, expect } from 'vitest';
import { BLOCK, BLOCKS, TILE, getFaceTile, isSolid, isOpaque, isPlaceable, isBreakable, isTargetable, isMeshed, FACE_TOP } from '../../src/blocks.js';
import { CAMPFIRE_MAX_TRACKED, CAMPFIRE_RETRACK_DISTANCE, CAMPFIRE_RETRACK_BATCH } from '../../src/config.js';
import { Campfires, campfireKey, flicker, scorchPlayer, wouldDouseCampfire } from '../../src/campfires.js';
import { createPlayer } from '../../src/physics.js';
import { forEachEditedCell, localIndex, chunkKey } from '../../src/coords.js';
import { hexToWorld } from '../../src/hex.js';
import { buildChunkMesh } from '../../src/mesher.js';
import { World } from '../../src/world.js';
import { Pigs, seededRng } from '../../src/pigs.js';
import { makeChunkDataGetter, setWorldBlock, countFaces, flatWorldGen } from '../helpers/fixtures.js';

const B = BLOCK;

describe('campfire block', () => {
  it('is a placeable, breakable, targetable, non-solid block drawn by its own model', () => {
    const d = BLOCKS[B.CAMPFIRE];
    expect(d.name).toBe('campfire');
    expect(d.displayName).toBe('Campfire');
    expect(isSolid(B.CAMPFIRE)).toBe(false);
    expect(isOpaque(B.CAMPFIRE)).toBe(false);
    expect(isPlaceable(B.CAMPFIRE)).toBe(true);
    expect(isBreakable(B.CAMPFIRE)).toBe(true);
    expect(isTargetable(B.CAMPFIRE)).toBe(true);
    expect(isMeshed(B.CAMPFIRE)).toBe(false);
    expect(getFaceTile(B.CAMPFIRE, 0)).toBe(TILE.CAMPFIRE_SIDE);
    expect(getFaceTile(B.CAMPFIRE, FACE_TOP)).toBe(TILE.CAMPFIRE_TOP);
    // Every other block is meshed as before, except the black hole and the circuit parts but the keg (DESIGN-circuits
    // §1.1–§1.2: the thin parts, and the 14 device models of the "fun and simple" redo), which vortexRenderer and
    // circuitRenderer draw.
    expect(BLOCKS.filter((b) => !b.meshed).map((b) => b.name)).toEqual([
      'black_hole', 'campfire', 'collapsar_charge', 'powder_fuse', 'torch', 'copper_wire', 'brown_wire', 'white_wire',
      'earth_wire', 'terminal_board', 'voltaic_battery', 'blasting_machine', 'selenium_panel', 'knife_switch', 'push_button',
      'clockwork_timer', 'relay', 'igniter', 'filament_lamp', 'electric_bell', 'spark_transmitter', 'coherer_receiver',
    ]);
  });
  it('the mesher skips the campfire cell but still draws the ground under it', () => {
    const chunks = new Map();
    setWorldBlock(chunks, 4, 10, 4, B.STONE);
    const ground = countFaces(buildChunkMesh(0, 0, makeChunkDataGetter(chunks)));
    setWorldBlock(chunks, 4, 11, 4, B.CAMPFIRE);
    expect(countFaces(buildChunkMesh(0, 0, makeChunkDataGetter(chunks)))).toBe(ground);
    // A solid block in the same place would hide the ground's top and add its own seven faces.
    setWorldBlock(chunks, 4, 11, 4, B.STONE);
    expect(countFaces(buildChunkMesh(0, 0, makeChunkDataGetter(chunks)))).toBe(ground - 1 + 7);
  });
});

describe('flicker', () => {
  it('stays within [0.75, 1.25], averages ~1, varies, and is deterministic per seed', () => {
    let sum = 0;
    let lo = Infinity;
    let hi = -Infinity;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const v = flicker(i * 0.01, 1.3);
      sum += v;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThanOrEqual(0.75);
    expect(hi).toBeLessThanOrEqual(1.25);
    expect(hi - lo).toBeGreaterThan(0.2);
    expect(sum / N).toBeCloseTo(1, 2);
    expect(flicker(3.7, 2)).toBe(flicker(3.7, 2));
    expect(flicker(3.7, 2)).not.toBe(flicker(3.7, 4));
  });
});

describe('Campfires tracking', () => {
  it('follows onBlockChange and stores the cell floor centre', () => {
    const c = new Campfires();
    c.onBlockChange(2, 30, -1, B.AIR, B.CAMPFIRE);
    expect(c.size).toBe(1);
    const [x, z] = hexToWorld(2, -1);
    expect(c.fires.get(campfireKey(2, 30, -1))).toMatchObject({ q: 2, y: 30, r: -1, x, z });
    expect(c.has(2, 30, -1)).toBe(true);
    c.onBlockChange(2, 30, -1, B.CAMPFIRE, B.AIR);
    expect(c.size).toBe(0);
    c.onBlockChange(0, 0, 0, B.AIR, B.STONE);
    expect(c.size).toBe(0);
  });
  it('caps the tracked set at CAMPFIRE_MAX_TRACKED', () => {
    const c = new Campfires();
    for (let i = 0; i < CAMPFIRE_MAX_TRACKED + 3; i++) c.add(i, 5, 0);
    expect(c.size).toBe(CAMPFIRE_MAX_TRACKED);
    expect(c.total).toBe(CAMPFIRE_MAX_TRACKED + 3);
    expect(c.refused.size).toBe(3);
  });
  it('a fire refused at the cap is tracked once a tracked one goes (regression: they stayed inert until reload)', () => {
    const c = new Campfires();
    for (let i = 0; i < CAMPFIRE_MAX_TRACKED + 2; i++) c.onBlockChange(i, 5, 0, B.AIR, B.CAMPFIRE);
    const late = CAMPFIRE_MAX_TRACKED + 1;
    expect(c.has(late, 5, 0)).toBe(false);
    // Every tracked fire goes, as in the play-test (break them all).
    for (let i = 0; i < CAMPFIRE_MAX_TRACKED; i++) c.onBlockChange(i, 5, 0, B.CAMPFIRE, B.AIR);
    expect(c.size).toBe(0);
    expect(c.retrack(0, 5, 0)).toBe(true);
    expect(c.size).toBe(2);
    expect(c.has(late, 5, 0)).toBe(true);
    expect(c.refused.size).toBe(0);
    // Nothing is refused any more: retrack is a no-op.
    expect(c.retrack(500, 5, 0)).toBe(false);
    // A refused cell that is broken is forgotten (never tracked later).
    for (let i = 0; i < CAMPFIRE_MAX_TRACKED + 1; i++) c.add(1000 + i, 5, 0);
    expect(c.refused.size).toBe(1);
    expect(c.remove(1000 + CAMPFIRE_MAX_TRACKED, 5, 0)).toBe(true);
    expect(c.total).toBe(c.size);
  });
  it('past the cap, retrack keeps the fires nearest the player tracked, so the near ones always have a model', () => {
    const c = new Campfires();
    const N = CAMPFIRE_MAX_TRACKED + 200;
    for (let i = 0; i < N; i++) c.add(i, 5, 0); // a line of fires along +x; the last 200 are refused
    const [farX] = hexToWorld(N - 1, 0);
    // Standing at the far (refused) end: before a retrack none of the near fires is tracked.
    expect(c.nearest(farX, 5.3, 0, 10)).toEqual([]);
    expect(c.retrack(farX, 5.3, 0)).toBe(true);
    expect(c.size).toBe(CAMPFIRE_MAX_TRACKED);
    expect(c.has(N - 1, 5, 0)).toBe(true);
    expect(c.has(0, 5, 0)).toBe(false); // the farthest went to `refused`
    expect(c.nearest(farX, 5.3, 0, 10).map((n) => n.fire.q)).toContain(N - 1);
    // Moving less than CAMPFIRE_RETRACK_DISTANCE does nothing; moving that far rebuilds around the new spot.
    expect(c.retrack(farX - (CAMPFIRE_RETRACK_DISTANCE - 0.5), 5.3, 0)).toBe(false);
    expect(c.retrack(0, 5.3, 0)).toBe(true);
    expect(c.has(0, 5, 0)).toBe(true);
    expect(c.has(N - 1, 5, 0)).toBe(false);
    // A refusal makes the next retrack rebuild even without moving: a fire placed by the player gets tracked.
    const [nx] = hexToWorld(-1, 0);
    c.add(-1, 5, 0);
    expect(c.has(-1, 5, 0)).toBe(false);
    expect(c.retrack(0, 5.3, 0)).toBe(true);
    expect(c.has(-1, 5, 0)).toBe(true);
    expect(nx).toBeLessThan(0);
    expect(c.total).toBe(N + 1);
  });
  it('loadFromEdits past the cap remembers the rest and the first retrack picks the nearest', () => {
    const w = new World({ worldGen: flatWorldGen(10), renderDistance: 1 });
    w.update(0, 0, 1e9);
    let n = 0;
    for (let q = -8; q <= 8 && n < CAMPFIRE_MAX_TRACKED + 10; q++) {
      for (let r = -8; r <= 8 && n < CAMPFIRE_MAX_TRACKED + 10; r++) {
        for (let y = 11; y < 17 && n < CAMPFIRE_MAX_TRACKED + 10; y++) if (w.setBlock(q, y, r, B.CAMPFIRE)) n++;
      }
    }
    expect(n).toBe(CAMPFIRE_MAX_TRACKED + 10);
    const c = new Campfires();
    c.loadFromEdits(w.edits);
    expect(c.size).toBe(CAMPFIRE_MAX_TRACKED);
    expect(c.total).toBe(n);
    expect(c.retrack(0, 11.3, 0)).toBe(true);
    expect(c.has(0, 11, 0)).toBe(true);
  });
  describe('retrack cost (regression: every re-pick sorted every known fire — 35 ms at 25k fires, seconds at 300k)', () => {
    /** A field of `n` fires on 4 layers around the origin, added in a scrambled order (after `first`, if given). */
    function field(n, first = null) {
      const side = Math.ceil(Math.sqrt(n / 4));
      const cells = [];
      for (let y = 0; y < 4; y++) for (let q = -side; q < side; q++) for (let r = -side; r < side; r++) cells.push([q, 60 + y, r]);
      let s = 7;
      for (let i = cells.length - 1; i > 0; i--) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        const j = s % (i + 1);
        [cells[i], cells[j]] = [cells[j], cells[i]];
      }
      const c = new Campfires();
      if (first) c.add(...first);
      for (let i = 0; c.total < n; i++) c.add(...cells[i]);
      return { c, side };
    }
    /** The CAMPFIRE_MAX_TRACKED nearest by a full sort, ties by key: what the tracked set must equal. */
    function nearestKeys(c, x, y, z) {
      const all = [...c.fires.values(), ...c.refused.values()];
      const d = all.map((f) => (f.x - x) ** 2 + (f.y + 0.3 - y) ** 2 + (f.z - z) ** 2);
      const order = all.map((_, i) => i).sort((a, b) => d[a] - d[b] || (all[a].key < all[b].key ? -1 : 1));
      return order.slice(0, CAMPFIRE_MAX_TRACKED).map((i) => all[i].key).sort();
    }
    const trackedKeys = (c) => [...c.fires.keys()].sort();
    /** Call retrack at (x, y, z) until it finishes a re-pick; returns the number of calls. */
    function settle(c, x, y, z) {
      for (let calls = 1; calls < 1000; calls++) if (c.retrack(x, y, z)) return calls;
      throw new Error('retrack never finished');
    }

    it('a re-pick visits at most CAMPFIRE_RETRACK_BATCH fires a call and still ends on exactly the nearest set', () => {
      const N = 3 * CAMPFIRE_RETRACK_BATCH + 500;
      const { c } = field(N);
      expect(c.total).toBe(N);
      // The first call starts the re-pick but cannot finish it: the tracked set is untouched until the last batch.
      const before = trackedKeys(c);
      expect(c.retrack(0, 61.3, 0)).toBe(false);
      expect(trackedKeys(c)).toEqual(before);
      expect(1 + settle(c, 0, 61.3, 0)).toBe(Math.ceil(N / CAMPFIRE_RETRACK_BATCH));
      expect(trackedKeys(c)).toEqual(nearestKeys(c, 0, 61.3, 0));
      // Moving on: the next re-pick (bounded by the last one's farthest kept fire) is exact too, and deterministic.
      for (const [x, z] of [[9, 0], [9, 9.5], [-12, 3], [40, -40]]) {
        settle(c, x, 62.1, z);
        expect(trackedKeys(c)).toEqual(nearestKeys(c, x, 62.1, z));
      }
      // Standing still afterwards costs nothing.
      expect(c.retrack(40, 62.1, -40)).toBe(false);
    });

    it('ties at the cut are broken by key, whatever order the fires were placed in, as the full sort did', () => {
      // A row of CAMPFIRE_MAX_TRACKED + 1 fires centred on the player: q = ±H are exactly as far, and only one fits.
      const H = CAMPFIRE_MAX_TRACKED / 2;
      for (const order of [1, -1]) {
        const c = new Campfires();
        for (let i = -H; i <= H; i++) c.add(order * i, 10, 0);
        settle(c, 0, 10.3, 0);
        expect(c.has(-H, 10, 0)).toBe(true); // "-512,10,0" < "512,10,0"
        expect(c.has(H, 10, 0)).toBe(false);
        expect(trackedKeys(c)).toEqual(nearestKeys(c, 0, 10.3, 0));
      }
    });

    it('fires added or removed while a re-pick is under way: added ones are seen, removed ones are not kept, and it ends exact', () => {
      const N = 3 * CAMPFIRE_RETRACK_BATCH + 10;
      // The fire at the player's spot is the first one placed, so the first batch puts it in the re-pick's heap.
      const { c, side } = field(N, [0, 61, 0]);
      expect(c.retrack(0, 61.3, 0)).toBe(false); // under way: one batch walked
      // A fire placed right next to the player (unless the field has it already) and one far away, both after the
      // walked part: seen by this re-pick.
      c.add(1, 61, 0);
      expect(c.add(side * 3, 61, 0)).toBe(false); // refused: the cap is full
      // Broken mid-way: the nearest fire (kept by the walk so far; the far one just added is swapped into its slot and
      // offered at once) and a refused one.
      expect(c.remove(0, 61, 0)).toBe(true);
      const someRefused = c.refused.values().next().value;
      expect(c.remove(someRefused.q, someRefused.y, someRefused.r)).toBe(true);
      // The walk finishes on schedule, keeps the nearest fires that still exist (one short: the broken one is not kept)
      // and asks for another re-pick, which ends exactly on the nearest set.
      expect(settle(c, 0, 61.3, 0)).toBe(Math.ceil(c.total / CAMPFIRE_RETRACK_BATCH) - 1);
      expect(c.size).toBe(CAMPFIRE_MAX_TRACKED - 1);
      expect(c.has(1, 61, 0)).toBe(true);
      expect(c.has(0, 61, 0)).toBe(false);
      const want = new Set(nearestKeys(c, 0, 61.3, 0));
      expect(trackedKeys(c).filter((k) => !want.has(k))).toEqual([]);
      settle(c, 0, 61.3, 0);
      expect(c.size).toBe(CAMPFIRE_MAX_TRACKED);
      expect(trackedKeys(c)).toEqual(nearestKeys(c, 0, 61.3, 0));
      expect(c.refused.has(campfireKey(side * 3, 61, 0))).toBe(true);
    });

    it('with 100 000 fires no retrack call stalls a frame (each one does a bounded batch)', () => {
      const { c, side } = field(100000);
      settle(c, -side, 61.3, 0);
      const times = [];
      let rebuilt = 0;
      // Fly across the field at 10 m/s, one call per 60 Hz frame.
      for (let px = -side; px < side; px += 10 / 60) {
        const t0 = performance.now();
        if (c.retrack(px, 61.3, 0)) rebuilt++;
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      expect(rebuilt).toBeGreaterThan(10);
      // The old full sort took ~180 ms per re-pick here. Generous bounds for a loaded machine.
      expect(times[Math.floor(times.length * 0.99)]).toBeLessThan(12);
      expect(times[times.length - 1]).toBeLessThan(40);
    });
  });

  it('gives neighbouring fires different flicker phases', () => {
    const c = new Campfires();
    c.add(0, 10, 0);
    c.add(1, 10, 0);
    const [a, b] = [...c.fires.values()];
    expect(a.seed).not.toBe(b.seed);
    expect(a.seed).toBeGreaterThanOrEqual(0);
    expect(a.seed).toBeLessThan(Math.PI * 2);
  });
  it('nearest returns fires within range, nearest first, limited', () => {
    const c = new Campfires();
    c.add(0, 10, 0);
    c.add(5, 10, 0);
    c.add(2, 10, 0);
    c.add(40, 10, 0);
    const near = c.nearest(0, 10.3, 0, 10);
    expect(near.map((n) => n.fire.q)).toEqual([0, 2, 5]);
    expect(near[0].dist).toBeCloseTo(0, 9);
    expect(c.nearest(0, 10.3, 0, 10, 2).map((n) => n.fire.q)).toEqual([0, 2]);
  });
  it('loadFromEdits (via forEachEditedCell) restores campfires from a saved world', () => {
    const w = new World({ worldGen: flatWorldGen(10), renderDistance: 1 });
    w.update(0, 0, 1e9);
    w.setBlock(-3, 11, 2, B.CAMPFIRE);
    w.setBlock(1, 11, 1, B.STONE);
    const w2 = new World({ worldGen: flatWorldGen(10), renderDistance: 1, edits: w.exportEdits() });
    const c = new Campfires();
    c.add(50, 50, 50);
    c.loadFromEdits(w2.edits);
    expect([...c.fires.keys()]).toEqual(['-3,11,2']);
  });
  it('forEachEditedCell skips malformed chunk keys and other ids', () => {
    const edits = new Map([
      [chunkKey(1, -1), new Map([[localIndex(2, 7, 3), B.CAMPFIRE], [localIndex(0, 0, 0), B.DIRT]])],
      ['nonsense', new Map([[0, B.CAMPFIRE]])],
    ]);
    const seen = [];
    forEachEditedCell(edits, B.CAMPFIRE, (q, y, r) => seen.push([q, y, r]));
    expect(seen).toEqual([[16 + 2, 7, -16 + 3]]);
  });
});

describe('player and water rules', () => {
  const GROUND = 10;
  const fireAt = (fq, fr) => (q, y, r) => (y < GROUND ? B.STONE : y === GROUND && q === fq && r === fr ? B.CAMPFIRE : B.AIR);
  it('scorchPlayer bounces a walking player out of ANY campfire cell — no tracker involved (regression: none tracked → no burn)', () => {
    const [fx, fz] = hexToWorld(3, -2);
    const p = createPlayer(fx + 0.15, GROUND, fz + 0.1);
    p.onGround = true;
    expect(scorchPlayer(p, fireAt(3, -2), () => [1, 0])).toBe(true);
    const d = Math.hypot(0.15, 0.1);
    expect(p.vx).toBeCloseTo((0.15 / d) * 5, 9);
    expect(p.vz).toBeCloseTo((0.1 / d) * 5, 9);
    expect(p.vy).toBeGreaterThanOrEqual(5);
    expect(p.onGround).toBe(false);
    // Dead centre: along the given direction.
    const c = createPlayer(fx, GROUND, fz);
    expect(scorchPlayer(c, fireAt(3, -2), () => [0, -1])).toBe(true);
    expect([c.vx, c.vz]).toEqual([0, -5]);
    // Flying, or feet in another cell: nothing.
    const f = createPlayer(fx, GROUND, fz);
    f.flying = true;
    expect(scorchPlayer(f, fireAt(3, -2), () => [1, 0])).toBe(false);
    expect(scorchPlayer(createPlayer(fx, GROUND + 1, fz), fireAt(3, -2), () => [1, 0])).toBe(false);
    expect(scorchPlayer(createPlayer(fx + 1, GROUND, fz), fireAt(3, -2), () => [1, 0])).toBe(false);
  });
  it('wouldDouseCampfire: no campfire into or under water, no water on a campfire; beside water is fine', () => {
    const cells = new Map([
      [campfireKey(0, 11, 0), B.WATER], // a pool cell
      [campfireKey(1, 12, 0), B.WATER], // water over an air cell
      [campfireKey(5, 11, 5), B.CAMPFIRE],
    ]);
    const get = (q, y, r) => cells.get(campfireKey(q, y, r)) ?? (y <= 10 ? B.STONE : B.AIR);
    expect(wouldDouseCampfire(get, B.CAMPFIRE, 0, 11, 0)).toBe(true); // into water
    expect(wouldDouseCampfire(get, B.CAMPFIRE, 1, 11, 0)).toBe(true); // under water
    expect(wouldDouseCampfire(get, B.CAMPFIRE, 2, 11, 0)).toBe(false); // beside the pool
    expect(wouldDouseCampfire(get, B.CAMPFIRE, 0, 12, 0)).toBe(false); // on top of the pool's water cell
    expect(wouldDouseCampfire(get, B.WATER, 5, 12, 5)).toBe(true); // water poured on a campfire
    expect(wouldDouseCampfire(get, B.WATER, 6, 11, 5)).toBe(false); // water beside it
    expect(wouldDouseCampfire(get, B.WATER, 5, 10, 5)).toBe(false); // water under it
    expect(wouldDouseCampfire(get, B.STONE, 0, 11, 0)).toBe(false); // other blocks still replace water
    expect(wouldDouseCampfire(get, B.STONE, 5, 12, 5)).toBe(false);
  });
});

describe('pigs and fire', () => {
  const GROUND = 10;
  it('a wandering pig never walks into a campfire', () => {
    // A ring of campfires at hex distance 3 around the pig.
    const fire = (q, r) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) === 3;
    const getBlock = (q, y, r) => (y < GROUND ? B.STONE : y === GROUND && fire(q, r) ? B.CAMPFIRE : B.AIR);
    for (let seed = 1; seed <= 4; seed++) {
      const pigs = new Pigs(seededRng(seed));
      pigs.spawn(0, GROUND, 0);
      for (let i = 0; i < 60 * 40; i++) {
        pigs.update(1 / 60, { getBlock, isLoaded: () => true });
        expect(pigs.scorched, `seed ${seed}`).toEqual([]);
      }
    }
  });
  it('a pig standing in a campfire yelps and jumps out, away from it', () => {
    const getBlock = (q, y, r) => (y < GROUND ? B.STONE : y === GROUND && q === 0 && r === 0 ? B.CAMPFIRE : B.AIR);
    const pigs = new Pigs(seededRng(1));
    const pig = pigs.spawn(0.2, GROUND, 0);
    pigs.update(1 / 60, { getBlock, isLoaded: () => true });
    expect(pigs.scorched).toEqual([pig]);
    expect(pig.vx).toBeGreaterThan(0);
    expect(pig.vy).toBeGreaterThan(0);
    expect(pig.mode).toBe('flee');
    for (let i = 0; i < 120; i++) pigs.update(1 / 60, { getBlock, isLoaded: () => true });
    expect(Math.hypot(pig.x, pig.z)).toBeGreaterThan(0.9);
  });
});
