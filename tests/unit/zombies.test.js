// Unit tests for src/zombies.js — zombie spawning, AI (wander / chase / attack), daylight, hits, campfires, water,
// black holes and bodies (CONTRACTS §39).
import { describe, it, expect } from 'vitest';
import { BLOCK } from '../../src/blocks.js';
import {
  ZOMBIE_MAX, ZOMBIE_RADIUS, ZOMBIE_HEIGHT, ZOMBIE_HITS, ZOMBIE_HURT_S, ZOMBIE_BURN_S, ZOMBIE_REACH,
  ZOMBIE_ATTACK_COOLDOWN_S, ZOMBIE_HIT_PUSH, ZOMBIE_HIT_LIFT, ZOMBIE_FIRE_FEAR, ZOMBIE_SPAWN_MIN, ZOMBIE_SPAWN_MAX,
  ZOMBIE_SPAWN_FIRE_CLEAR, ZOMBIE_DESPAWN_DIST, ZOMBIE_KO_KNOCK, ZOMBIE_MAX_DROP, WALK_SPEED, BLAST_RADIUS,
  BLAST_IMPULSE, ZOMBIE_SOUND_RANGE,
} from '../../src/config.js';
import { Zombies, openSky, zombieVolume, loudestVolume } from '../../src/zombies.js';
import { seededRng, wrapAngle } from '../../src/pigs.js';
import { createPlayer, createBody, isFreeAt, stepPlayer } from '../../src/physics.js';
import { hexToWorld, worldToHex, hexLength } from '../../src/hex.js';
import { BlackHoles } from '../../src/blackholes.js';
import { resolveBodies } from '../../src/bodies.js';

const B = BLOCK;
const GROUND = 10;
/** Flat grass world: stone below GROUND − 1, grass at GROUND − 1, air above. */
const flat = (_q, y) => (y < GROUND - 1 ? B.STONE : y === GROUND - 1 ? B.GRASS_BLOCK : B.AIR);
const loaded = () => true;
const DT = 1 / 60;

/** A night-time world view around a player (natural spawning off unless `spawning`). */
function view(getBlock, player, extra = {}) {
  return { getBlock, isLoaded: loaded, player, isDay: false, ...extra };
}

/** Spawning hooks for a flat, fully loaded world with no edits. */
function spawnHooks(getBlock = flat, ground = GROUND - 1) {
  return {
    isLoadedCell: () => true,
    groundHeight: () => ground,
    isNaturalGround: (q, y, r) => y === ground && getBlock(q, y, r) !== B.AIR,
    columnEdited: () => false,
  };
}

function run(zombies, world, seconds, each) {
  for (let f = 0; f < seconds * 60; f++) {
    const ev = zombies.update(DT, world);
    if (each && each(ev, f) === false) return f;
  }
  return -1;
}

const standing = (x, z, y = GROUND) => {
  const p = createPlayer(x, y, z);
  p.onGround = true;
  return p;
};

describe('Zombies.spawn / remove / switch', () => {
  it('spawns a player-sized body, refuses beyond ZOMBIE_MAX, non-finite input and while switched off', () => {
    const zs = new Zombies(seededRng(1));
    const a = zs.spawn(1, GROUND, 2, 0.5);
    expect(a).toMatchObject({ x: 1, y: GROUND, z: 2, yaw: 0.5, mode: 'idle', hurt: 0, hits: 0, radius: ZOMBIE_RADIUS, height: ZOMBIE_HEIGHT });
    expect(a.radius).toBeLessThan(0.289); // HEX_SIZE / 2: fits through the player's one-cell doorways
    expect(ZOMBIE_HEIGHT).toBeLessThan(2); // … two cells high
    expect(zs.spawn(NaN, 0, 0)).toBeNull();
    for (let i = 1; i < ZOMBIE_MAX; i++) zs.spawn(i, GROUND, 0);
    expect(zs.size).toBe(ZOMBIE_MAX);
    expect(zs.spawn(0, GROUND, 0)).toBeNull();
    expect(zs.remove(a)).toBe(true);
    expect(zs.remove(a)).toBe(false);
    const v = zs.switchVersion;
    expect(zs.setEnabled(false)).toBe(true);
    expect(zs.size).toBe(0); // off removes them all
    expect(zs.switchVersion).toBe(v + 1);
    expect(zs.setEnabled(false)).toBe(false);
    expect(zs.spawn(0, GROUND, 0)).toBeNull();
    expect(zs.setEnabled(true)).toBe(true);
    expect(zs.spawn(0, GROUND, 0)).not.toBeNull();
  });
  it('a zombie fits through a one-cell gap in a two-high wall, like the player', () => {
    // A wall along the row r = 0 (two high) with the cell q = 0 open: the doorway.
    const getBlock = (q, y, r) => (r === 0 && q !== 0 && y >= GROUND && y < GROUND + 2 ? B.STONE : flat(q, y, r));
    const zs = new Zombies(seededRng(2));
    const [sx, sz] = hexToWorld(0, 3);
    const zb = zs.spawn(sx, GROUND, sz);
    const player = standing(...hexToWorld(0, -4));
    const world = view(getBlock, player);
    run(zs, world, 15, () => !(zb.z < hexToWorld(0, -1)[1]));
    expect(zb.z).toBeLessThan(hexToWorld(0, -1)[1]); // through the doorway
    expect(isFreeAt(getBlock, zb.x, zb.y, zb.z, ZOMBIE_RADIUS, ZOMBIE_HEIGHT)).toBe(true);
  });
});

describe('Zombies.update — wandering', () => {
  it('lands and wanders on flat ground when nobody is around', () => {
    const zs = new Zombies(seededRng(7));
    const zb = zs.spawn(0, GROUND + 3, 0);
    run(zs, view(flat, null), 30);
    expect(zb.y).toBeCloseTo(GROUND, 3);
    expect(zb.onGround).toBe(true);
    expect(Math.hypot(zb.x, zb.z)).toBeGreaterThan(0.5);
    expect(Math.hypot(zb.x, zb.z)).toBeLessThan(60);
  });
  it('never wanders off a drop deeper than ZOMBIE_MAX_DROP cells, but does wander down one that deep', () => {
    // A plateau (radius 5) whose top is `drop` cells above the plain around it.
    const plateau = (drop) => (q, y, r) => (y < (hexLength(q, r) <= 5 ? GROUND + drop : GROUND) ? B.STONE : B.AIR);
    let down = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const top = GROUND + ZOMBIE_MAX_DROP + 1; // one cell too deep
      const zs = new Zombies(seededRng(seed));
      const zb = zs.spawn(0, top, 0);
      run(zs, view(plateau(ZOMBIE_MAX_DROP + 1), null), 60);
      expect(zb.y, `seed ${seed}`).toBeCloseTo(top, 3);
      const ok = new Zombies(seededRng(seed));
      const oz = ok.spawn(0, GROUND + ZOMBIE_MAX_DROP, 0);
      run(ok, view(plateau(ZOMBIE_MAX_DROP), null), 60);
      if (oz.y < GROUND + 0.5) down++;
    }
    expect(down).toBeGreaterThanOrEqual(1); // a drop of exactly ZOMBIE_MAX_DROP is walked off
  });
  it('reports ambient groans now and then', () => {
    const zs = new Zombies(seededRng(11));
    zs.spawn(0, GROUND, 0);
    let groans = 0;
    run(zs, view(flat, null), 60, (ev) => {
      groans += ev.groans.length;
    });
    expect(groans).toBeGreaterThanOrEqual(3);
    expect(groans).toBeLessThanOrEqual(12);
  });
  it('freezes zombies in unloaded chunks and removes ones that fall out of the world', () => {
    const zs = new Zombies(seededRng(3));
    const frozen = zs.spawn(30, GROUND + 5, 0);
    zs.spawn(0, -15, 0);
    run(zs, { getBlock: () => B.AIR, isLoaded: (x) => x < 20, player: null }, 2);
    expect(frozen.y).toBe(GROUND + 5);
    expect(zs.list).toEqual([frozen]);
  });
});

describe('Zombies.update — chase and attack', () => {
  it('walks at the player a little slower than the player walks, then strikes once a second', () => {
    const zs = new Zombies(seededRng(4));
    const [x, z] = hexToWorld(0, 0);
    const zb = zs.spawn(x, GROUND, z, 0);
    const player = standing(x + 12, z);
    const world = view(flat, player);
    let maxSpeed = 0;
    const first = run(zs, world, 10, (ev) => {
      maxSpeed = Math.max(maxSpeed, Math.hypot(zb.vx, zb.vz));
      return ev.attacks.length === 0;
    });
    expect(first).toBeGreaterThan(0);
    expect(zb.mode).toBe('chase');
    expect(maxSpeed).toBeGreaterThan(0.7 * WALK_SPEED);
    expect(maxSpeed).toBeLessThan(WALK_SPEED);
    expect(Math.hypot(player.x - zb.x, player.z - zb.z)).toBeLessThanOrEqual(ZOMBIE_REACH);
    // The strike knocked the player straight away from the zombie and up (no damage: velocity only).
    expect(Math.hypot(player.vx, player.vz)).toBeCloseTo(ZOMBIE_HIT_PUSH, 6);
    expect(player.vy).toBeGreaterThanOrEqual(ZOMBIE_HIT_LIFT);
    expect((player.x - zb.x) * player.vx + (player.z - zb.z) * player.vz).toBeGreaterThan(0);
  });
  it('the cooldown: a player pinned against it is struck once per ZOMBIE_ATTACK_COOLDOWN_S', () => {
    const zs = new Zombies(seededRng(5));
    const zb = zs.spawn(0, GROUND, 0, 0);
    const player = standing(0.8, 0); // within reach; never moved by this test
    const times = [];
    run(zs, view(flat, player), 5.5, (ev, f) => {
      if (ev.attacks.length) times.push(f / 60);
      player.x = zb.x + 0.8;
      player.z = zb.z;
      player.vx = player.vy = player.vz = 0;
    });
    expect(times.length).toBeGreaterThanOrEqual(5);
    expect(times.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(ZOMBIE_ATTACK_COOLDOWN_S - 1e-9);
  });
  it('never strikes through a wall, nor a player whose height range it does not overlap', () => {
    const zs = new Zombies(seededRng(6));
    const zb = zs.spawn(0, GROUND, 0);
    const p = standing(1.2, 0);
    expect(zs._canReach(zb, p, flat)).toBe(true);
    const [wq, wr] = worldToHex(0.6, 0);
    const walled = (q, y, r) => (q === wq && r === wr && y === GROUND + 1 ? B.STONE : flat(q, y, r));
    expect(zs._canReach(zb, p, walled)).toBe(false);
    expect(zs._canReach(zb, standing(1.2, 0, GROUND + ZOMBIE_HEIGHT + 0.01), flat)).toBe(false); // standing on its head
    expect(zs._canReach(zb, standing(ZOMBIE_REACH + 0.05, 0), flat)).toBe(false);
  });
  it('never strikes a player riding it: sunk a few mm into its head, with or without the ride link (play-test PB-6)', () => {
    const zs = new Zombies(seededRng(6));
    const zb = zs.spawn(0, GROUND, 0);
    const rider = standing(0.05, 0, GROUND + ZOMBIE_HEIGHT - 0.008); // gravity sank it before body resolution lifts it
    expect(zs._canReach(zb, rider, flat)).toBe(false); // the landing frame: no link yet, inside the overlap tolerance
    rider.carrier = zb;
    rider.y = GROUND + ZOMBIE_HEIGHT - 0.05;
    expect(zs._canReach(zb, rider, flat)).toBe(false); // riding
    // Riding for 10 s in main's order — stepPlayer (the rider sinks), zombies.update (the attack test), then
    // resolveBodies (the rider is lifted back): never struck.
    const IDLE = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };
    const p = standing(0.05, 0, GROUND + ZOMBIE_HEIGHT + 0.5);
    let strikes = 0;
    stepPlayer(p, IDLE, flat, DT);
    run(zs, view(flat, p), 10, (ev) => {
      strikes += ev.attacks.length;
      resolveBodies([p, zb], flat);
      stepPlayer(p, IDLE, flat, DT);
    });
    expect(p.carrier).toBe(zb);
    expect(strikes).toBe(0);
  });
  it('does not chase a flying player or one far above it, and loses interest beyond ZOMBIE_SIGHT', () => {
    const zs = new Zombies(seededRng(8));
    const zb = zs.spawn(0, GROUND, 0);
    const flyer = standing(6, 0, GROUND + 3);
    flyer.flying = true;
    run(zs, view(flat, flyer), 3);
    expect(zb.mode).not.toBe('chase');
    const high = standing(6, 0, GROUND + 8);
    run(zs, view(flat, high), 3);
    expect(zb.mode).not.toBe('chase');
    const far = standing(zb.x + 30, zb.z);
    run(zs, view(flat, far), 3);
    expect(zb.mode).not.toBe('chase');
    const near = standing(zb.x + 10, zb.z);
    run(zs, view(flat, near), 0.5);
    expect(zb.mode).toBe('chase');
  });
  it('hops a one-cell ledge to get at the player', () => {
    // Raised ground (one cell) for q ≥ 3.
    const getBlock = (q, y, r) => (q >= 3 && y === GROUND ? B.STONE : flat(q, y, r));
    const zs = new Zombies(seededRng(9));
    const zb = zs.spawn(...[hexToWorld(0, 0)[0], GROUND, hexToWorld(0, 0)[1]], -Math.PI / 2);
    const player = standing(hexToWorld(8, 0)[0], 0, GROUND + 1);
    let reached = false;
    run(zs, view(getBlock, player), 10, (ev) => {
      reached ||= ev.attacks.length > 0;
      return !reached;
    });
    expect(reached).toBe(true);
    expect(zb.y).toBeCloseTo(GROUND + 1, 2);
  });
  it('works its way around a wall between it and the player', () => {
    // A two-high wall across the line, q = 3 for r in −3..3 (too high to hop).
    const getBlock = (q, y, r) => (q === 3 && r >= -3 && r <= 3 && y >= GROUND && y < GROUND + 2 ? B.STONE : flat(q, y, r));
    let hits = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const zs = new Zombies(seededRng(seed));
      const [x, z] = hexToWorld(0, 0);
      zs.spawn(x, GROUND, z, -Math.PI / 2);
      const player = standing(hexToWorld(7, 0)[0], hexToWorld(7, 0)[1]);
      let reached = false;
      run(zs, view(getBlock, player), 30, (ev) => {
        reached ||= ev.attacks.length > 0;
        return !reached;
      });
      if (reached) hits++;
    }
    expect(hits).toBeGreaterThanOrEqual(3);
  });
  it('follows the player down a cliff of ZOMBIE_MAX_DROP cells or less, never off a deeper one', () => {
    // The boundary both ways: a drop of exactly ZOMBIE_MAX_DROP is followed, ZOMBIE_MAX_DROP + 1 is not.
    for (const [drop, follows] of [[ZOMBIE_MAX_DROP + 2, false], [ZOMBIE_MAX_DROP + 1, false], [ZOMBIE_MAX_DROP, true], [2, true]]) {
      const top = GROUND + drop;
      const getBlock = (q, y) => (y < (q <= 0 ? top : GROUND) ? B.STONE : B.AIR);
      const zs = new Zombies(seededRng(drop));
      const [x, z] = hexToWorld(-3, 0);
      const zb = zs.spawn(x, top, z, -Math.PI / 2);
      const player = standing(hexToWorld(4, 0)[0], 0);
      run(zs, view(getBlock, player), 20);
      expect(zb.y < top - 0.5, `drop ${drop}`).toBe(follows);
    }
  });
});

describe('Zombies.update — daylight', () => {
  it('under open sky by day it smoulders and burns away after ZOMBIE_BURN_S', () => {
    const zs = new Zombies(seededRng(12));
    const zb = zs.spawn(0, GROUND, 0);
    let ignitedAt = -1;
    let burnedAt = -1;
    run(zs, { getBlock: flat, isLoaded: loaded, player: null, isDay: true }, 8, (ev, f) => {
      if (ev.ignited.includes(zb)) ignitedAt = f / 60;
      if (ev.burned.includes(zb)) burnedAt = f / 60;
      if (ignitedAt >= 0 && burnedAt < 0) expect(zb.smoking).toBe(true);
      return burnedAt < 0;
    });
    expect(ignitedAt).toBeGreaterThanOrEqual(0);
    expect(ignitedAt).toBeLessThan(0.1);
    expect(burnedAt - ignitedAt).toBeCloseTo(ZOMBIE_BURN_S, 1);
    expect(zs.size).toBe(0);
  });
  it('in shade (any solid cell above, however high) or in water it survives the day; at night nothing burns', () => {
    const roofed = (q, y, r) => (y === GROUND + 20 ? B.OAK_LEAVES : flat(q, y, r));
    expect(openSky(roofed, 0, GROUND + 2, 0)).toBe(false);
    expect(openSky(flat, 0, GROUND + 2, 0)).toBe(true);
    const zs = new Zombies(seededRng(13));
    const zb = zs.spawn(0, GROUND, 0);
    run(zs, { getBlock: roofed, isLoaded: loaded, player: null, isDay: true }, 12);
    expect(zs.list).toEqual([zb]);
    expect(zb.smoking).toBe(false);
    const night = new Zombies(seededRng(14));
    const nz = night.spawn(0, GROUND, 0);
    run(night, view(flat, null), 12);
    expect(night.list).toEqual([nz]);
    expect(nz.burn).toBe(0);
    // A lake: swimming, it is not exposed.
    const lake = (q, y) => (y < GROUND - 4 ? B.STONE : y < GROUND ? B.WATER : B.AIR);
    const wet = new Zombies(seededRng(15));
    const wz = wet.spawn(0, GROUND - 2, 0);
    run(wet, { getBlock: lake, isLoaded: loaded, player: null, isDay: true }, 8);
    expect(wet.list).toEqual([wz]);
  });
  it('a zombie in shade catches fire once it walks out into the light', () => {
    // A roof over q ≤ 0 only; the player stands in the sun to lure it out.
    const getBlock = (q, y, r) => (q <= 0 && y === GROUND + 4 ? B.STONE : flat(q, y, r));
    const zs = new Zombies(seededRng(16));
    const [x, z] = hexToWorld(-3, 0);
    const zb = zs.spawn(x, GROUND, z, -Math.PI / 2);
    const player = standing(hexToWorld(5, 0)[0], 0);
    let ignited = false;
    run(zs, { getBlock, isLoaded: loaded, player, isDay: true }, 10, (ev) => {
      ignited ||= ev.ignited.includes(zb);
      return !ignited;
    });
    expect(ignited).toBe(true);
    expect(worldToHex(zb.x, zb.z)[0]).toBeGreaterThan(0);
  });
});

describe('Zombies.hit / knock — the player fights back', () => {
  it('each hit knocks it back with a red flash; hits during the flash are ignored; ZOMBIE_HITS knock it out', () => {
    const zs = new Zombies(seededRng(17));
    const zb = zs.spawn(2, GROUND, 0);
    for (let n = 1; n < ZOMBIE_HITS; n++) {
      expect(zs.hit(zb, 0, 0)).toBe('hit');
      expect(zb.hits).toBe(n);
      expect(zb.hurt).toBe(ZOMBIE_HURT_S);
      expect(zb.vx).toBeGreaterThan(0); // away from the hitter at x = 0
      expect(zs.hit(zb, 0, 0)).toBeNull(); // still flashing
      run(zs, view(flat, null), ZOMBIE_HURT_S + 0.05);
      expect(zb.hurt).toBe(0);
    }
    expect(zs.hit(zb, 0, 0)).toBe('ko');
    expect(zs.size).toBe(0);
  });
  it('a stunned zombie does not strike', () => {
    const zs = new Zombies(seededRng(18));
    const zb = zs.spawn(0, GROUND, 0);
    zs.hit(zb, -1, 0);
    zb.vx = zb.vy = zb.vz = 0;
    const player = standing(zb.x + 0.9, 0);
    let early = 0;
    run(zs, view(flat, player), ZOMBIE_HURT_S - 0.05, (ev) => {
      early += ev.attacks.length;
    });
    expect(early).toBe(0);
  });
  it('a blast within about its radius knocks it out; a weaker knock flings it and counts as a hit', () => {
    const zs = new Zombies(seededRng(19));
    const a = zs.spawn(0, GROUND, 0);
    const b = zs.spawn(5, GROUND, 0);
    // explosions._impulse at distance d: BLAST_IMPULSE·(1 − d/2R); ZOMBIE_KO_KNOCK is met inside ~R.
    const at = (d) => BLAST_IMPULSE * (1 - d / (2 * BLAST_RADIUS));
    expect(at(BLAST_RADIUS * 0.8)).toBeGreaterThan(ZOMBIE_KO_KNOCK);
    expect(at(BLAST_RADIUS * 1.3)).toBeLessThan(ZOMBIE_KO_KNOCK);
    expect(zs.knock(a, at(BLAST_RADIUS * 0.8), 0, 0)).toBe('ko');
    expect(zs.knock(b, 4, 5, 0)).toBe('hit'); // a landing log (TREE_KNOCK_SPEED, TREE_KNOCK_UP)
    expect(b.vx).toBe(4);
    expect(b.hits).toBe(1);
    expect(zs.list).toEqual([b]);
  });
  it('raycast hits the nearest zombie cylinder within maxDist', () => {
    const zs = new Zombies(seededRng(20));
    zs.spawn(0, GROUND, -5);
    const near = zs.spawn(0, GROUND, -3);
    const hit = zs.raycast(0, GROUND + 1.6, 0, 0, 0, -1, 10);
    expect(hit.zombie).toBe(near);
    expect(hit.distance).toBeCloseTo(3 - 0.3, 6);
    expect(zs.raycast(0, GROUND + 1.6, 0, 0, 0, -1, 2)).toBeNull();
    expect(zs.raycast(0, GROUND + 2.5, 0, 0, 0, -1, 10)).toBeNull(); // over its head
    const down = zs.raycast(0, GROUND + 5, -3, 0, -1, 0, 10); // looking down on it
    expect(down.distance).toBeCloseTo(5 - ZOMBIE_HEIGHT, 6);
  });
});

describe('Zombies — campfires are safe zones', () => {
  const [fq, fr] = [0, 0];
  const withFire = (q, y, r) => (q === fq && r === fr && y === GROUND ? B.CAMPFIRE : flat(q, y, r));
  const [fx, fz] = hexToWorld(fq, fr);
  const nearestFire = (x, y, z, maxDist, out) => {
    const d = Math.hypot(x - fx, y - GROUND, z - fz);
    if (d > maxDist) return Infinity;
    out[0] = fx;
    out[1] = GROUND;
    out[2] = fz;
    return d;
  };
  it('a zombie chasing a player who stands by a campfire stays out of ZOMBIE_FIRE_FEAR and never reaches them', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const zs = new Zombies(seededRng(seed));
      const zb = zs.spawn(fx + 12, GROUND, fz + seed);
      const player = standing(fx + 1.2, fz);
      let closest = Infinity;
      let attacks = 0;
      run(zs, view(withFire, player, { nearestFire, hasCampfires: () => true }), 30, (ev) => {
        attacks += ev.attacks.length;
        closest = Math.min(closest, Math.hypot(zb.x - fx, zb.z - fz));
        player.x = fx + 1.2;
        player.z = fz;
      });
      expect(attacks, `seed ${seed}`).toBe(0);
      expect(closest, `seed ${seed}`).toBeGreaterThan(ZOMBIE_FIRE_FEAR - 1.2);
    }
  });
  // On the fire's level the zone (ZOMBIE_FIRE_FEAR, measured from y + 1 to the floor centre) reaches this far out.
  const ZONE = Math.sqrt(ZOMBIE_FIRE_FEAR ** 2 - 1);
  const fireView = (player) => view(withFire, player, { nearestFire, hasCampfires: () => true });
  it('a crowd from every side never strikes a player two cells from a campfire; they keep to the edge of its zone', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const zs = new Zombies(seededRng(seed));
      const [px, pz] = hexToWorld(fq + 2, fr);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + 0.2;
        zs.spawn(px + Math.cos(a) * 10, GROUND, pz + Math.sin(a) * 10);
      }
      const player = standing(px, pz);
      let closest = Infinity;
      let attacks = 0;
      run(zs, fireView(player), 30, (ev) => {
        attacks += ev.attacks.length;
        resolveBodies([player, ...zs.list], withFire); // they jostle each other as in the game
        player.x = px;
        player.z = pz;
        player.vx = player.vz = 0;
        for (const zb of zs.list) closest = Math.min(closest, Math.hypot(zb.x - fx, zb.z - fz));
      });
      expect(attacks, `seed ${seed}`).toBe(0);
      expect(closest, `seed ${seed}`).toBeGreaterThan(ZONE - 0.3);
    }
  });
  it('a zombie inside a zone never strikes, even pressed against a player outside it, and turns away from the fire', () => {
    // The zombie 3 from the fire (inside), the player 1.1 farther out (outside): in reach.
    for (let seed = 1; seed <= 3; seed++) {
      const zs = new Zombies(seededRng(seed));
      const zb = zs.spawn(fx + 3, GROUND, fz, Math.PI / 2); // facing the fire
      const player = standing(fx + 4.1, fz);
      expect(Math.hypot(player.x - fx, 1, player.z - fz)).toBeGreaterThan(ZOMBIE_FIRE_FEAR);
      let attacks = 0;
      run(zs, fireView(player), 3, (ev) => {
        attacks += ev.attacks.length;
        zb.x = fx + 3;
        zb.z = fz;
        player.x = fx + 4.1;
        player.z = fz;
        player.vx = player.vy = player.vz = 0;
      });
      expect(attacks, `seed ${seed}`).toBe(0);
      expect(zb.mode).toBe('avoid');
      expect(Math.abs(wrapAngle(zb.targetYaw + Math.PI / 2))).toBeLessThan(1e-6); // straight away: toward +x
    }
    // The same pair with no fire: struck within the first cooldown.
    const zs = new Zombies(seededRng(1));
    zs.spawn(3, GROUND, 0);
    let attacks = 0;
    run(zs, view(flat, standing(4.1, 0)), 1.5, (ev) => {
      attacks += ev.attacks.length;
    });
    expect(attacks).toBeGreaterThan(0);
  });
  it('a player inside a zone is never struck, even by a zombie just outside it; out of the zone the strikes resume', () => {
    for (const [px, struck] of [[fx + 3.3, false], [fx + 5.2, true]]) {
      const zs = new Zombies(seededRng(4));
      const zb = zs.spawn(px + 1.1, GROUND, fz, Math.PI / 2);
      const player = standing(px, fz);
      expect(Math.hypot(zb.x - fx, 1, zb.z - fz)).toBeGreaterThan(ZOMBIE_FIRE_FEAR); // the zombie is outside
      let attacks = 0;
      run(zs, fireView(player), 3, (ev) => {
        attacks += ev.attacks.length;
        zb.x = px + 1.1;
        zb.z = fz;
        player.x = px;
        player.z = fz;
        player.vx = player.vy = player.vz = 0;
      });
      expect(attacks > 0, `player at ${px}`).toBe(struck);
    }
  });
  it('a zombie summoned inside a zone walks out of it', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const zs = new Zombies(seededRng(seed));
      const zb = zs.spawn(fx - 1.5, GROUND, fz + 0.4, seed);
      run(zs, fireView(null), 4);
      expect(Math.hypot(zb.x - fx, zb.z - fz), `seed ${seed}`).toBeGreaterThan(ZONE);
    }
  });
  it('a wandering zombie never steps into a campfire cell', () => {
    const fires = (q, y, r) => ((q + 2 * r) % 5 === 0 && y === GROUND ? B.CAMPFIRE : flat(q, y, r));
    const zs = new Zombies(seededRng(21));
    const zb = zs.spawn(...[hexToWorld(1, 0)[0], GROUND, hexToWorld(1, 0)[1]]);
    let scorched = 0;
    run(zs, view(fires, null), 60, (ev) => {
      scorched += ev.scorched.length + ev.knockedOut.length;
    });
    expect(scorched).toBe(0);
    expect(zs.list).toEqual([zb]);
  });
  it('a zombie standing in a campfire hops out and takes a hit (the last one knocks it out)', () => {
    const zs = new Zombies(seededRng(22));
    const zb = zs.spawn(fx + 0.1, GROUND, fz);
    zb.hits = ZOMBIE_HITS - 2;
    const ev = zs.update(DT, view(withFire, null));
    expect(ev.scorched).toEqual([zb]);
    expect(zb.vy).toBeGreaterThan(0);
    zb.x = fx;
    zb.y = GROUND;
    zb.z = fz;
    zb.hurt = 0;
    const ev2 = zs.update(DT, view(withFire, null));
    expect(ev2.knockedOut).toEqual([zb]);
    expect(zs.size).toBe(0);
  });
});

describe('Zombies — natural spawning', () => {
  it('spawns only at night, on natural ground ZOMBIE_SPAWN_MIN–MAX from the player, at most ZOMBIE_MAX', () => {
    const zs = new Zombies(seededRng(23));
    const player = standing(0, 0);
    player.flying = true; // keep them from crowding in (spawning does not care)
    const world = { ...view(flat, player), ...spawnHooks() };
    let spawned = 0;
    for (let f = 0; f < 60 * 60 * 6; f++) {
      const ev = zs.update(0.05, world);
      for (const zb of ev.spawned) {
        spawned++;
        const d = Math.hypot(zb.x - player.x, zb.z - player.z);
        expect(d).toBeGreaterThanOrEqual(ZOMBIE_SPAWN_MIN);
        expect(d).toBeLessThanOrEqual(ZOMBIE_SPAWN_MAX + 1);
        expect(zb.y).toBeCloseTo(GROUND, 3);
      }
      expect(zs.size).toBeLessThanOrEqual(ZOMBIE_MAX);
    }
    expect(spawned).toBeGreaterThanOrEqual(ZOMBIE_MAX);
    expect(zs.size).toBe(ZOMBIE_MAX);
  });
  it('spawns a few per minute', () => {
    const zs = new Zombies(seededRng(24));
    const player = standing(0, 0);
    player.flying = true;
    const world = { ...view(flat, player), ...spawnHooks() };
    let spawned = 0;
    for (let f = 0; f < 3 * 60 * 20; f++) spawned += zs.update(0.05, world).spawned.length; // 3 minutes
    expect(spawned).toBeGreaterThanOrEqual(6);
    expect(spawned).toBeLessThanOrEqual(ZOMBIE_MAX);
  });
  it('never by day, never while switched off, never without a player', () => {
    for (const [isDay, on, hasPlayer] of [[true, true, true], [false, false, true], [false, true, false]]) {
      const zs = new Zombies(seededRng(25));
      zs.setEnabled(on);
      const player = hasPlayer ? standing(0, 0) : null;
      const world = { ...view(flat, player), ...spawnHooks(), isDay };
      for (let f = 0; f < 60 * 20; f++) zs.update(0.05, world);
      expect(zs.size).toBe(0);
    }
  });
  it('spawnHeightAt: not under water, in unloaded or edited columns, on player blocks, or near a campfire', () => {
    const zs = new Zombies(seededRng(26));
    const ok = { getBlock: flat, isLoaded: loaded, ...spawnHooks() };
    expect(zs.spawnHeightAt(ok, 20, 0)).toBe(GROUND);
    const sea = (q, y) => (y < GROUND - 4 ? B.STONE : y < GROUND + 2 ? B.WATER : B.AIR);
    expect(zs.spawnHeightAt({ ...ok, getBlock: sea, ...spawnHooks(sea, GROUND - 5) }, 20, 0)).toBeNull();
    expect(zs.spawnHeightAt({ ...ok, isLoadedCell: () => false }, 20, 0)).toBeNull();
    expect(zs.spawnHeightAt({ ...ok, columnEdited: (q) => q === 20 }, 20, 0)).toBeNull();
    expect(zs.spawnHeightAt({ ...ok, isNaturalGround: () => false }, 20, 0)).toBeNull();
    const tree = (q, y, r) => (q === 20 && r === 0 && y === GROUND ? B.OAK_LOG : flat(q, y, r));
    expect(zs.spawnHeightAt({ ...ok, getBlock: tree }, 20, 0)).toBeNull();
    const [cx, cz] = hexToWorld(20, 0);
    const fireAt = (dist) => (x, y, z, maxDist, out) => {
      out[0] = cx + dist;
      out[1] = GROUND;
      out[2] = cz;
      return dist <= maxDist ? dist : Infinity;
    };
    expect(zs.spawnHeightAt({ ...ok, nearestFire: fireAt(ZOMBIE_SPAWN_FIRE_CLEAR - 0.5) }, 20, 0)).toBeNull();
    expect(zs.spawnHeightAt({ ...ok, nearestFire: fireAt(ZOMBIE_SPAWN_FIRE_CLEAR + 0.5) }, 20, 0)).toBe(GROUND);
  });
  it(`despawns zombies farther than ZOMBIE_DESPAWN_DIST (${ZOMBIE_DESPAWN_DIST}) from the player`, () => {
    const zs = new Zombies(seededRng(27));
    const near = zs.spawn(10, GROUND, 0);
    zs.spawn(ZOMBIE_DESPAWN_DIST + 5, GROUND, 0);
    const ev = zs.update(DT, view(flat, standing(0, 0)));
    expect(ev.despawned).toBe(1);
    expect(zs.list).toEqual([near]);
  });
});

describe('Zombies — water, black holes and bodies', () => {
  const pond = (R, D) => (q, y, r) => {
    if (hexLength(q, r) <= R && y >= GROUND - D && y < GROUND) return B.WATER;
    return flat(q, y, r);
  };
  it('a zombie dropped in a pond floats and swims for the bank, then climbs out', () => {
    const getBlock = pond(4, 3);
    for (const [q, r, seed] of [[0, 0, 1], [2, -1, 2], [-3, 1, 3]]) {
      const zs = new Zombies(seededRng(seed));
      const [x, z] = hexToWorld(q, r);
      const zb = zs.spawn(x, GROUND - 2.5, z, seed);
      const t = run(zs, view(getBlock, null), 40, () => !(zb.onGround && !zb.inWater && zb.y >= GROUND - 1e-3));
      expect(t, `start ${q},${r}`).toBeGreaterThan(0);
    }
  });
  it('a chasing zombie swims straight at the player across the water', () => {
    const getBlock = pond(8, 3);
    const zs = new Zombies(seededRng(28));
    const [x, z] = hexToWorld(-5, 0);
    const zb = zs.spawn(x, GROUND - 1.5, z);
    const player = standing(hexToWorld(10, 0)[0], 0);
    const x0 = zb.x;
    run(zs, view(getBlock, player), 4);
    expect(zb.mode).toBe('chase');
    expect(zb.x - x0).toBeGreaterThan(3);
  });
  it('water currents and black holes pull through world.pullAt; a hole swallows the zombie', () => {
    const holes = new BlackHoles();
    const [hx, hz] = hexToWorld(0, 0);
    holes.add(0, GROUND, 0);
    const zs = new Zombies(seededRng(29));
    const zb = zs.spawn(hx + 2.5, GROUND, hz);
    let swallowed = false;
    run(zs, view(flat, null, { pullAt: (x, y, z, out) => holes.pullAt(x, y, z, out) }), 6, () => {
      swallowed = holes.swallowing(zb) !== null;
      return !swallowed;
    });
    expect(swallowed).toBe(true);
    const current = new Zombies(seededRng(30));
    const cz = current.spawn(0, GROUND, 0);
    run(current, view(flat, null, { pullAt: (x, y, z, out) => { out[0] = 6; out[1] = 0; out[2] = 0; return out; } }), 2);
    expect(cz.x).toBeGreaterThan(0.4);
  });
  it('pushes and is pushed by the player (resolveBodies), and can be stood on', () => {
    const zs = new Zombies(seededRng(31));
    const zb = zs.spawn(0, GROUND, 0);
    const player = standing(0.3, 0);
    resolveBodies([player, zb], flat);
    expect(Math.hypot(player.x - zb.x, player.z - zb.z)).toBeGreaterThan(0.3);
    const rider = createBody(zb.x, GROUND + ZOMBIE_HEIGHT - 0.05, zb.z, { radius: 0.28, height: 1.8 });
    resolveBodies([rider, zb], flat);
    expect(rider.y).toBeCloseTo(zb.y + ZOMBIE_HEIGHT, 1);
    expect(rider.carrier).toBe(zb);
  });
  it('a zombie standing on or carrying another body never hops (no climbing walls on each other)', () => {
    const ledge = (q, y, r) => (q >= 2 && y === GROUND ? B.STONE : flat(q, y, r));
    for (const ridden of [false, true]) {
      const zs = new Zombies(seededRng(32));
      const [x, z] = hexToWorld(0, 0);
      const zb = zs.spawn(x, GROUND, z, -Math.PI / 2);
      const player = standing(hexToWorld(6, 0)[0], 0, GROUND + 1);
      const other = createBody(0, -50, 0, { radius: 0.3, height: 1 });
      run(zs, view(ledge, player), 5, () => {
        zb.carrier = ridden ? other : null; // as resolveBodies leaves it at the end of every frame
      });
      expect(zb.y > GROUND + 0.5, `ridden: ${ridden}`).toBe(!ridden);
    }
  });
});

describe('Zombies — sounds (main plays each kind at most once a frame, at loudestVolume)', () => {
  it('zombieVolume fades linearly to 0 at ZOMBIE_SOUND_RANGE; loudestVolume is the nearest zombie\'s', () => {
    const at = { x: 0, y: GROUND, z: 0 };
    expect(zombieVolume({ x: 0, y: GROUND, z: 0 }, at)).toBe(1);
    expect(zombieVolume({ x: ZOMBIE_SOUND_RANGE / 4, y: GROUND, z: 0 }, at)).toBeCloseTo(0.75, 12);
    expect(zombieVolume({ x: 0, y: GROUND + ZOMBIE_SOUND_RANGE, z: 0 }, at)).toBe(0);
    expect(loudestVolume([], at)).toBe(0);
    expect(loudestVolume([{ x: 30, y: GROUND, z: 0 }], at)).toBe(0);
    const crowd = [3, 12, 1.5, 20].map((d) => ({ x: d, y: GROUND, z: 0 }));
    expect(loudestVolume(crowd, at)).toBeCloseTo(1 - 1.5 / ZOMBIE_SOUND_RANGE, 12);
  });
  it('a crowd under open sky ignites on one frame at dawn and burns out on one frame: one voice each, the loudest', () => {
    const zs = new Zombies(seededRng(40));
    const player = standing(0, 0);
    player.flying = true; // nobody chases: they stand about where they were put
    for (let k = 0; k < 12; k++) zs.spawn(Math.cos(k) * (2 + k), GROUND, Math.sin(k) * (2 + k));
    run(zs, view(flat, player), 1);
    let ignitedFrames = 0;
    let burnedFrames = 0;
    let most = 0;
    run(zs, { ...view(flat, player), isDay: true }, ZOMBIE_BURN_S + 1, (ev) => {
      for (const list of [ev.ignited, ev.burned]) {
        if (list.length === 0) continue;
        most = Math.max(most, list.length);
        const loudest = Math.max(...list.map((zb) => zombieVolume(zb, player)));
        expect(loudestVolume(list, player)).toBe(loudest);
      }
      if (ev.ignited.length) ignitedFrames++;
      if (ev.burned.length) burnedFrames++;
    });
    expect(zs.size).toBe(0);
    expect(most).toBe(12); // why main must not play one hiss and one down sound per zombie
    expect(ignitedFrames).toBe(1);
    expect(burnedFrames).toBe(1);
  });
});
