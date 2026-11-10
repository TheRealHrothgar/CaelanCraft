// Tests for src/looseItems.js — drops flying to the player, throws and drops (CONTRACTS §60).
import { describe, it, expect } from 'vitest';
import {
  LooseItems, PICKUP_RADIUS, PICKUP_CHEST, POP_S, ITEM_RADIUS, THROW_HOLD_S, COLLECT_RADIUS, HOME_MAX_S, GHOST_MAX,
  throwOf, THROW_ROCK, THROW_DART, THROW_SPEAR, THROW_CHUCK,
} from '../../src/looseItems.js';
import { normalizeLooseJSON, normalizeSurvivalJSON } from '../../src/storage.js';
import { executeCommand, parseLine, COMMANDS } from '../../src/commands.js';

const exec = (ctx, line) => executeCommand(/** @type {*} */ (parseLine(line)), /** @type {*} */ (ctx));

const DT = 1 / 60;
/** A flat floor: solid below y = 10. */
const floorAt = (h) => (x, y) => y < h;

/** An env with a player standing at (px, 10, pz) on a floor at 10, recording what is collected and hit. */
function makeEnv(opts = {}) {
  const got = [];
  const hits = [];
  const env = {
    solid: opts.solid ?? floorAt(10),
    player: opts.player === undefined ? { x: 0, y: 10, z: 0 } : opts.player,
    collect: (it) => {
      got.push({ ...it.s, at: Math.hypot(it.x - env.player.x, it.y - env.player.y - PICKUP_CHEST, it.z - env.player.z) });
      return opts.full ? { ...it.s } : null;
    },
    room: () => !opts.full,
    hitMob: opts.hitMob,
    onHit: (it, mob) => {
      hits.push({ power: it.power, mob });
      return opts.breaks ?? false;
    },
  };
  if (opts.loaded) env.loaded = opts.loaded;
  return { env, got, hits };
}

function run(loose, env, seconds) {
  for (let t = 0; t < seconds; t += DT) loose.step(DT, env);
}

describe('looseItems — a drop flies to the player and enters the pack at the threshold', () => {
  it('pops out of the cell, homes, and is collected only once it is within PICKUP_RADIUS of the chest', () => {
    const loose = new LooseItems(() => 0.5);
    const { env, got } = makeEnv();
    loose.spawnDrop({ k: 'rock', n: 2 }, 4, 10.5, 0);
    expect(loose.list[0].mode).toBe('pop');
    expect(loose.inFlight()).toEqual([{ k: 'rock', n: 2 }]);
    // nothing collected during the hop, nor in the first frames of the flight
    run(loose, env, POP_S + 0.05);
    expect(got).toEqual([]);
    expect(loose.list[0].mode).toBe('home');
    let frames = 0;
    while (loose.count > 0 && frames < 600) {
      const before = got.length;
      loose.step(DT, env);
      frames++;
      if (got.length === before) {
        // still flying: never inside the threshold without having been collected
        const it = loose.list[0];
        if (it) expect(Math.hypot(it.x, it.y - 10 - PICKUP_CHEST, it.z)).toBeGreaterThan(PICKUP_RADIUS);
      }
    }
    expect(got).toHaveLength(1);
    expect(got[0].k).toBe('rock');
    expect(got[0].n).toBe(2);
    expect(got[0].at).toBeLessThanOrEqual(PICKUP_RADIUS + 1e-9);
    expect(loose.count).toBe(0);
    expect(loose.inFlight()).toEqual([]);
    expect(frames).toBeLessThan(60); // about a second at most for a 4 m flight
  });

  it('follows a moving player and never orbits: after HOME_MAX_S it is collected wherever it is', () => {
    const loose = new LooseItems(() => 0.5);
    const { env, got } = makeEnv();
    loose.spawnDrop({ k: 'stick', n: 1 }, 2, 10.5, 0);
    for (let t = 0; t < POP_S + HOME_MAX_S + 0.2 && loose.count > 0; t += DT) {
      env.player.x -= 40 * DT; // running away faster than HOME_MAX
      loose.step(DT, env);
    }
    expect(got).toHaveLength(1);
  });

  it('a full pack: what is left drops at the feet, waits THROW_HOLD_S, and flies again only when there is room', () => {
    const loose = new LooseItems(() => 0.5);
    const full = makeEnv({ full: true });
    loose.spawnDrop({ k: 'rock', n: 3 }, 2, 10.5, 0);
    run(loose, full.env, 1.5);
    expect(full.got.length).toBe(1); // one try at the threshold
    expect(loose.count).toBe(1);
    expect(loose.list[0].mode).toBe('rest');
    expect(loose.inFlight()).toEqual([]);
    run(loose, full.env, 2);
    expect(full.got.length).toBe(1); // no room: it stays on the ground
    const roomy = makeEnv();
    roomy.env.player = full.env.player;
    run(loose, roomy.env, 1);
    expect(roomy.got.map((g) => g.n)).toEqual([3]);
    expect(loose.count).toBe(0);
  });

  it('nobody to collect (the player is dead, or Creative): a real drop falls and rests instead', () => {
    const loose = new LooseItems(() => 0.5);
    const { env, got } = makeEnv({ player: null });
    loose.spawnDrop({ k: 'rock', n: 1 }, 2, 10.5, 0);
    run(loose, env, 2);
    expect(got).toEqual([]);
    expect(loose.list[0].mode).toBe('rest');
    expect(loose.list[0].y).toBeCloseTo(10 + ITEM_RADIUS, 6);
  });

  it('a ghost (Creative) is the animation only: never collected, gone at the threshold; ghosts are capped', () => {
    const loose = new LooseItems(() => 0.5);
    const { env, got } = makeEnv();
    loose.spawnDrop({ k: 'dirt', n: 1 }, 3, 10.5, 0, { block: 3, ghost: true });
    expect(loose.inFlight()).toEqual([]);
    env.collect = null; // Creative passes no collect
    run(loose, env, 1);
    expect(got).toEqual([]);
    expect(loose.count).toBe(0);
    for (let i = 0; i < GHOST_MAX + 5; i++) loose.spawnDrop({ k: 'dirt', n: 1 }, 3, 10.5, 0, { ghost: true });
    expect(loose.count).toBe(GHOST_MAX);
  });

  it('release() drops every homing item where it is (death); ghosts lying still fade', () => {
    const loose = new LooseItems(() => 0.5);
    const { env } = makeEnv();
    loose.spawnDrop({ k: 'rock', n: 1 }, 4, 12, 0);
    loose.spawnDrop({ k: 'dirt', n: 1 }, 4, 12, 0, { ghost: true });
    run(loose, env, POP_S + 0.05);
    loose.release();
    expect(loose.list.map((it) => it.mode)).toEqual(['fly']);
    expect(loose.list[0].hold).toBe(THROW_HOLD_S);
  });
});

describe('looseItems — throw and drop', () => {
  it('throwOf: rocks sting (1), darts (2) and spears (4) hurt more; anything else is chucked a short way', () => {
    expect(throwOf('rock')).toBe(THROW_ROCK);
    expect(throwOf('flint')).toBe(THROW_ROCK);
    expect(throwOf('flint_dart')).toBe(THROW_DART);
    expect(throwOf('flint_spear')).toBe(THROW_SPEAR);
    expect(throwOf('cobblestone')).toBe(THROW_CHUCK);
    expect(throwOf('stick')).toBe(THROW_CHUCK);
    expect(THROW_ROCK.power).toBeGreaterThan(0);
    expect(THROW_DART.power).toBeGreaterThan(THROW_ROCK.power);
    expect(THROW_SPEAR.power).toBeGreaterThan(THROW_ROCK.power);
    expect(THROW_CHUCK.power).toBe(0);
    expect(THROW_CHUCK.speed).toBeLessThan(THROW_ROCK.speed);
  });

  it('a chucked block flies a short way, lands on the floor, and is not collected for THROW_HOLD_S', () => {
    const loose = new LooseItems(() => 0.5);
    const { env, got } = makeEnv({ player: { x: 0, y: 10, z: 0 } });
    loose.launch({ k: 'cobblestone', n: 1 }, 0, 11.5, 0, THROW_CHUCK.speed, 1.5, 0, { block: 4 });
    run(loose, env, 3);
    const it = loose.list[0];
    expect(it.mode).toBe('rest');
    expect(it.y).toBeCloseTo(10 + ITEM_RADIUS, 6);
    expect(it.x).toBeGreaterThan(COLLECT_RADIUS); // out of reach: not picked straight back up
    expect(it.x).toBeLessThan(8); // a short way
    expect(got).toEqual([]);
  });

  it('a dropped item is not picked straight back up: only once the player has stepped away and comes back', () => {
    const loose = new LooseItems(() => 0.5);
    const { env, got } = makeEnv();
    loose.launch({ k: 'stick', n: 5 }, 0.3, 11.1, 0, 1, 1.5, 0);
    run(loose, env, THROW_HOLD_S + 2);
    expect(loose.list[0].mode).toBe('rest');
    expect(got).toEqual([]); // standing by it all along
    env.player.x = -3; // step away …
    run(loose, env, 0.2);
    env.player.x = 0; // … and back
    run(loose, env, 1);
    expect(got.map((g) => g.n)).toEqual([5]);
    // a drop from a dig that the full pack turned away is the same: collected once there is room and the hold is over
  });

  it('a projectile hits the first mob on its path once, with its power; a broken dart is gone', () => {
    const mob = { name: 'zombie' };
    const hitMob = (x0, y0, z0, x1) => (x0 < 5 && x1 >= 5 ? mob : null);
    const loose = new LooseItems(() => 0.5);
    const { env, hits } = makeEnv({ hitMob, player: { x: -50, y: 10, z: 0 } });
    loose.launch({ k: 'rock', n: 1 }, 0, 11.5, 0, THROW_ROCK.speed, 1, 0, { power: THROW_ROCK.power });
    run(loose, env, 2);
    expect(hits).toEqual([{ power: 1, mob }]);
    expect(loose.list[0].power).toBe(0);
    expect(loose.list[0].x).toBeLessThan(6); // bounced off it
    const darts = new LooseItems(() => 0.5);
    const broken = makeEnv({ hitMob, breaks: true, player: { x: -50, y: 10, z: 0 } });
    darts.launch({ k: 'flint_dart', n: 1 }, 0, 11.5, 0, THROW_DART.speed, 1, 0, { power: THROW_DART.power });
    run(darts, broken.env, 1);
    expect(broken.hits).toEqual([{ power: 2, mob }]);
    expect(darts.count).toBe(0);
  });

  it('a chucked item (power 0) and a slow projectile hurt nothing; a wall stops the power', () => {
    let tested = 0;
    const hitMob = () => {
      tested++;
      return { name: 'pig' };
    };
    const loose = new LooseItems(() => 0.5);
    const { env, hits } = makeEnv({ hitMob });
    loose.launch({ k: 'dirt', n: 1 }, 0, 11.5, 0, 6, 1, 0);
    // rolled along the floor: never as fast as HIT_MIN_SPEED, and its power is spent when it lands
    loose.launch({ k: 'rock', n: 1 }, 0, 10 + ITEM_RADIUS + 0.01, 0, 2, 0, 0, { power: 1 });
    run(loose, env, 1);
    expect(hits).toEqual([]);
    expect(tested).toBe(0);
    const walled = new LooseItems(() => 0.5);
    const w = makeEnv({ solid: (x, y) => y < 10 || x > 3, hitMob: (x0, y0, z0, x1) => (x1 > 4 ? { name: 'behind' } : null) });
    walled.launch({ k: 'rock', n: 1 }, 0, 11.5, 0, 13, 0, 0, { power: 1 });
    run(walled, w.env, 2);
    expect(w.hits).toEqual([]);
    expect(walled.list[0].x).toBeLessThan(3);
  });

  it('a mob killed by a throw may give drops during the step: they are kept', () => {
    const loose = new LooseItems(() => 0.5);
    const { env } = makeEnv({ hitMob: (x0, y0, z0, x1) => (x0 < 3 && x1 >= 3 ? {} : null), player: { x: -50, y: 10, z: 0 } });
    env.onHit = () => {
      loose.spawnDrop({ k: 'raw_pork', n: 2 }, 3, 10.5, 0);
      return false;
    };
    loose.launch({ k: 'flint_spear', n: 1, d: 30 }, 0, 11.5, 0, 17, 0, 0, { power: 4 });
    loose.step(0.25, env);
    expect(loose.list.map((it) => it.s.k).sort()).toEqual(['flint_spear', 'raw_pork']);
  });

  it('a resting item falls when the cell under it goes; one in an unloaded chunk waits frozen', () => {
    let floor = 10;
    const loose = new LooseItems(() => 0.5);
    const { env } = makeEnv({ solid: (x, y) => y < floor, player: { x: -50, y: 0, z: 0 } });
    loose.launch({ k: 'rock', n: 1 }, 0, 10.5, 0, 0, 0, 0);
    run(loose, env, 1);
    expect(loose.list[0].mode).toBe('rest');
    floor = 7;
    run(loose, env, 2);
    expect(loose.list[0].y).toBeCloseTo(7 + ITEM_RADIUS, 6);
    const frozen = new LooseItems(() => 0.5);
    const f = makeEnv({ solid: () => false, loaded: () => false });
    frozen.launch({ k: 'rock', n: 1 }, 0, 10.5, 0, 0, 0, 0);
    run(frozen, f.env, 3);
    expect(frozen.list[0].y).toBe(10.5);
  });
});

describe('looseItems — the save (survival.loose)', () => {
  it('serialize keeps the real items with their wear; load puts them back falling; ghosts and bad entries are not', () => {
    const loose = new LooseItems(() => 0.5);
    loose.launch({ k: 'flint_spear', n: 1, d: 41 }, 1.23456, 12, -3, 0, 0, 0);
    loose.launch({ k: 'rock', n: 7 }, 2, 11, 2, 0, 0, 0);
    loose.spawnDrop({ k: 'dirt', n: 1 }, 0, 11, 0, { ghost: true });
    const saved = loose.serialize();
    expect(saved).toEqual([{ k: 'flint_spear', n: 1, x: 1.235, y: 12, z: -3, d: 41 }, { k: 'rock', n: 7, x: 2, y: 11, z: 2 }]);
    const back = new LooseItems(() => 0.5);
    const n = back.load([...saved, { k: 'nope', n: 1, x: 0, y: 0, z: 0 }, { k: 'rock', n: 0, x: 0, y: 0, z: 0 }, null],
      (k) => (k === 'rock' ? -1 : -1));
    expect(n).toBe(2);
    expect(back.list.map((it) => [it.s.k, it.s.n, it.s.d, it.mode, it.hold])).toEqual([
      ['flint_spear', 1, 41, 'fly', 0], ['rock', 7, undefined, 'fly', 0],
    ]);
    expect(back.load('junk')).toBe(0);
  });

  it('storage keeps survival.loose in canonical form, only when non-empty, and drops bad entries with a warning', () => {
    const w = [];
    expect(normalizeLooseJSON([{ z: 3, y: 2.00049, x: 1, n: 2, k: 'rock' }, { k: 'rock', n: 1.5, x: 0, y: 0, z: 0 },
      { k: 'flint_spear', n: 1, d: 3, x: 0, y: 0, z: Infinity }, { k: 'flint_spear', n: 1, d: 3, x: 0, y: 0, z: 0 }], w))
      .toEqual([{ k: 'rock', n: 2, x: 1, y: 2, z: 3 }, { k: 'flint_spear', n: 1, d: 3, x: 0, y: 0, z: 0 }]);
    expect(w).toEqual(['survival.loose[1]: invalid, dropped', 'survival.loose[2]: invalid, dropped']);
    expect(JSON.stringify(normalizeLooseJSON([{ z: 3, y: 2, x: 1, n: 2, k: 'rock' }]))).toBe('[{"k":"rock","n":2,"x":1,"y":2,"z":3}]');
    const w2 = [];
    expect(normalizeLooseJSON({}, w2)).toEqual([]);
    expect(w2).toEqual(['survival.loose: not a list, ignored']);
    expect('loose' in normalizeSurvivalJSON({ loose: [] })).toBe(false);
    expect('loose' in normalizeSurvivalJSON({})).toBe(false);
    expect(normalizeSurvivalJSON({ loose: [{ k: 'rock', n: 1, x: 0, y: 1, z: 0 }] }).loose).toEqual([{ k: 'rock', n: 1, x: 0, y: 1, z: 0 }]);
  });
});

describe('commands — drop and throw (console only)', () => {
  const ctx = (log) => ({ hands: { act: (kind, n) => (log.push([kind, n]), { ok: true, message: `${kind} ${n}` }) } });
  it('drop [count|all] and throw [count] pass the count to the hands; bad counts fail', () => {
    const log = [];
    expect(exec(ctx(log), 'drop')).toEqual({ ok: true, message: 'drop 1' });
    expect(exec(ctx(log), 'drop all').ok).toBe(true);
    expect(exec(ctx(log), 'drop 12').ok).toBe(true);
    expect(exec(ctx(log), 'throw').ok).toBe(true);
    expect(exec(ctx(log), 'throw 3').ok).toBe(true);
    expect(log).toEqual([['drop', 1], ['drop', 'all'], ['drop', 12], ['throw', 1], ['throw', 3]]);
    expect(exec(ctx(log), 'throw all').ok).toBe(false);
    expect(exec(ctx(log), 'throw 17').ok).toBe(false);
    expect(exec(ctx(log), 'drop 0').ok).toBe(false);
    expect(exec({}, 'drop').ok).toBe(false);
    expect(COMMANDS.filter((c) => c.name === 'drop' || c.name === 'throw').every((c) => c.consoleOnly)).toBe(true);
  });
});
