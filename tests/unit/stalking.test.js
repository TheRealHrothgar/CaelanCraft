// Unit tests for §100 stalking (src/animals.js): stillness and suspicion, line of sight and cover, and the wind. The
// user: "when you sneak up behind and the animal turns to face you, it should be less likely to spook if the player stays
// still"; "Stalking works better when there's no line of sight"; "Hunting upwind should confer a sneak penalty."
import { describe, it, expect } from 'vitest';
import { BLOCK } from '../../src/blocks.js';
import { createPlayer } from '../../src/physics.js';
import { worldToHex } from '../../src/hex.js';
import { seededRng } from '../../src/pigs.js';
import {
  Animals, SPECIES, SNEAK_NOTICE, BEHIND_NOTICE, COVER_NOTICE, SCENT_UPWIND, SCENT_DOWNWIND, SIGHT_RANGE, SIGHT_CHECK_S,
  SUSPECT_RISE, SUSPECT_WATCH, SUSPECT_SETTLE, SUSPECT_CALM, STILL_SPEED, SIGHT_PLANTS, TALL_PLANT_COVER, noticeRange,
  scentOf, scentFactor, lineOfSight, canSee, blocksSight,
} from '../../src/animals.js';
import { windAt, scentToward } from '../../src/wind.js';

const B = BLOCK;
const GROUND = 10;
const DT = 1 / 30;

/** Flat grass at GROUND − 1; `extra` "q,y,r" → id. */
function flatWorld(extra = new Map()) {
  return (q, y, r) => extra.get(`${q},${y},${r}`) ?? (y < GROUND - 1 ? B.STONE : y === GROUND - 1 ? B.GRASS_BLOCK : B.AIR);
}
const standing = (x, z, more = {}) => Object.assign(createPlayer(x, GROUND, z), { onGround: true }, more);
const view = (getBlock, player, more = {}) => ({ getBlock, isLoaded: () => true, player, heldKey: null, ...more });
/** A wind blowing toward +x (from the west) at `strength`. */
const eastward = (strength) => ({ dir: Math.PI / 2, x: 1, z: 0, strength, speed: strength * 12, gust: 0 });
/** A deer at the origin facing −z (yaw 0), still. */
function deerAt(seed = 5, yaw = 0) {
  const as = new Animals(seededRng(seed));
  const a = as.spawn('deer', 0, GROUND, 0, yaw);
  a.targetYaw = yaw;
  a.timer = 100; // it does not wander off during the test
  return [as, a];
}
/** A wall of logs two high across the column at z between the deer and a player at −z (cells at r = rWall). */
function wallWorld(rWall) {
  const extra = new Map();
  for (let q = -12; q <= 12; q++) for (let y = GROUND; y <= GROUND + 2; y++) extra.set(`${q},${y},${rWall}`, B.OAK_LOG);
  return flatWorld(extra);
}

describe('§100 stalking — the notice distance with cover and wind', () => {
  it('cover gives COVER_NOTICE of it (the blind arc when less); the wind scales it by scentFactor', () => {
    const n = SPECIES.deer.notice;
    const deer = { kind: 'deer', x: 0, z: 0, yaw: 0 };
    const front = { x: 0, z: -5, sneaking: true };
    const behind = { x: 0, z: 5, sneaking: true };
    expect(COVER_NOTICE).toBe(0.45);
    expect(noticeRange(deer, front, { hidden: false, scent: 0 })).toBeCloseTo(n * SNEAK_NOTICE, 9);
    expect(noticeRange(deer, front, { hidden: true, scent: 0 })).toBeCloseTo(n * SNEAK_NOTICE * COVER_NOTICE, 9);
    expect(noticeRange(deer, behind, { hidden: true, scent: 0 })).toBeCloseTo(n * SNEAK_NOTICE * Math.min(BEHIND_NOTICE, COVER_NOTICE), 9);
    // cover muffles a walker too (sound only), but it is heard much farther than a crouching one
    expect(noticeRange(deer, { x: 0, z: -5 }, { hidden: true })).toBeCloseTo(n * COVER_NOTICE, 9);
    // the wind: ×1.8 straight upwind at full strength, ×0.85 straight downwind
    expect([SCENT_UPWIND, SCENT_DOWNWIND]).toEqual([0.8, 0.15]);
    expect(scentFactor(1)).toBeCloseTo(1.8, 9);
    expect(scentFactor(-1)).toBeCloseTo(0.85, 9);
    expect(scentFactor(0)).toBe(1);
    expect(noticeRange(deer, front, { scent: 1 })).toBeCloseTo(n * SNEAK_NOTICE * 1.8, 9);
    // scent works without sight: hidden and upwind
    expect(noticeRange(deer, front, { hidden: true, scent: 1 })).toBeCloseTo(n * SNEAK_NOTICE * COVER_NOTICE * 1.8, 9);
    // without a sense the old distances stand
    expect(noticeRange(deer, front)).toBeCloseTo(n * SNEAK_NOTICE, 9);
  });

  it('scentOf is wind.scentToward × strength: + with the player upwind of the animal, − downwind, 0 calm', () => {
    const player = { x: -10, z: 0 };
    const animal = { x: 0, z: 0 };
    expect(scentOf(eastward(1), player, animal)).toBeCloseTo(1, 9); // the wind blows from the player to the animal
    expect(scentOf(eastward(0.5), player, animal)).toBeCloseTo(0.5, 9);
    expect(scentOf(eastward(1), { x: 10, z: 0 }, animal)).toBeCloseTo(-1, 9); // downwind: the hunter's side
    expect(scentOf(eastward(1), { x: 0, z: 10 }, animal)).toBeCloseTo(0, 9); // across the wind
    expect(scentOf(null, player, animal)).toBe(0);
    // the real wind: the same as scentToward × strength
    const w = windAt(42, 1234);
    expect(scentOf(w, player, animal)).toBeCloseTo(scentToward(w, -10, 0, 0, 0) * w.strength, 12);
  });
});

describe('§100 stalking — line of sight and cover', () => {
  it('solid blocks, trunks and leaves hide; glass does not; tall plants hide what is low behind them', () => {
    expect(blocksSight(B.OAK_LOG)).toBe(true);
    expect(blocksSight(B.OAK_LEAVES)).toBe(true);
    expect(blocksSight(B.STONE)).toBe(true);
    expect(blocksSight(B.GLASS)).toBe(false);
    expect(blocksSight(B.AIR)).toBe(false);
    for (const id of [B.CATTAILS, B.TUSSOCK, B.HONEYBERRY_BUSH, B.HAZEL_THICKET, B.FERN]) expect(SIGHT_PLANTS.has(id)).toBe(true);
    expect(SIGHT_PLANTS.has(B.MEADOW_DAISIES)).toBe(false);
    const clear = flatWorld();
    expect(lineOfSight(clear, 0, GROUND + 1, 0, 0, GROUND + 1, -8)).toBe(true);
    const [mq, mr] = worldToHex(0, -4);
    for (const id of [B.OAK_LOG, B.OAK_LEAVES, B.STONE]) {
      const gb = flatWorld(new Map([[`${mq},${GROUND + 1},${mr}`, id]]));
      expect(lineOfSight(gb, 0, GROUND + 1.2, 0, 0, GROUND + 1.2, -8), `block ${id}`).toBe(false);
    }
    expect(lineOfSight(flatWorld(new Map([[`${mq},${GROUND + 1},${mr}`, B.GLASS]])), 0, GROUND + 1.2, 0, 0, GROUND + 1.2, -8)).toBe(true);
    // a bush in the ground cell: it hides a line through it and up to TALL_PLANT_COVER above it, not higher
    const bush = flatWorld(new Map([[`${mq},${GROUND},${mr}`, B.HONEYBERRY_BUSH]]));
    expect(lineOfSight(bush, 0, GROUND + 0.7, 0, 0, GROUND + 0.7, -8)).toBe(false);
    expect(lineOfSight(bush, 0, GROUND + 1 + TALL_PLANT_COVER - 0.1, 0, 0, GROUND + 1 + TALL_PLANT_COVER - 0.1, -8)).toBe(false);
    expect(lineOfSight(bush, 0, GROUND + 1 + TALL_PLANT_COVER + 0.2, 0, 0, GROUND + 1 + TALL_PLANT_COVER + 0.2, -8)).toBe(true);
    // the plant the animal stands in does not blind it
    const own = flatWorld(new Map([[`0,${GROUND},0`, B.TUSSOCK]]));
    expect(lineOfSight(own, 0, GROUND + 1, 0, 0, GROUND + 1, -8)).toBe(true);
  });

  it('canSee: a crouching hunter behind a bush is hidden; standing up, their head shows over it', () => {
    const [, a] = deerAt();
    const [q, r] = worldToHex(0, -5); // the cattails just in front of the hunter at −6
    const gb = flatWorld(new Map([[`${q},${GROUND},${r}`, B.CATTAILS]]));
    expect(canSee(gb, a, standing(0, -6, { sneaking: true }))).toBe(false);
    expect(canSee(gb, a, standing(0, -6))).toBe(true);
    expect(canSee(flatWorld(), a, standing(0, -6, { sneaking: true }))).toBe(true);
  });

  it('an animal looks for the player every SIGHT_CHECK_S, and only within SIGHT_RANGE', () => {
    const gb = wallWorld(worldToHex(0, -3)[1]);
    const [as, a] = deerAt();
    a.senseIn = 0;
    const p = standing(0, -8, { sneaking: true });
    as.update(DT, view(gb, p));
    expect(a.hidden).toBe(true);
    expect(a.senseIn).toBeCloseTo(SIGHT_CHECK_S, 9);
    // the wall is gone: it notices only at its next look
    const open = flatWorld();
    as.update(DT, view(open, p));
    expect(a.hidden).toBe(true);
    for (let t = 0; t < SIGHT_CHECK_S + DT; t += DT) as.update(DT, view(open, p));
    expect(a.hidden).toBe(false);
    // beyond SIGHT_RANGE it does not look at all
    const [bs, b] = deerAt();
    b.senseIn = 0;
    bs.update(DT, view(wallWorld(worldToHex(0, -20)[1]), standing(0, -(SIGHT_RANGE + 5), { sneaking: true })));
    expect(b.hidden).toBe(false);
  });

  it('behind cover a crouching hunter comes far nearer than in the open', () => {
    const n = SPECIES.deer.notice * SNEAK_NOTICE; // 6.4
    const d = n * 0.7; // 4.5 m: inside the open distance, outside the covered one (2.9)
    expect(d).toBeGreaterThan(n * COVER_NOTICE);
    // in the open, moving: it grows suspicious and stares
    const [as, a] = deerAt();
    const p = standing(0, -d, { sneaking: true, vz: 0.5 });
    for (let i = 0; i < 30; i++) as.update(DT, view(flatWorld(), p));
    expect(['watch', 'flee']).toContain(a.mode);
    // behind a wall of logs: nothing at all
    const [bs, b] = deerAt();
    b.senseIn = 0;
    const gb = wallWorld(worldToHex(0, -2)[1]);
    for (let i = 0; i < 60; i++) bs.update(DT, view(gb, p));
    expect(b.mode).not.toBe('flee');
    expect(b.mode).not.toBe('watch');
    expect(b.suspicion).toBe(0);
  });
});

describe('§100 stalking — stillness and suspicion', () => {
  it('a still crouching hunter it turns to see is stared at, not run from; it settles if they keep still', () => {
    expect([SUSPECT_WATCH, SUSPECT_SETTLE, SUSPECT_CALM]).toEqual([0.3, 0.1, 0.1]);
    const [as, a] = deerAt(5, Math.PI); // facing +z, away from the hunter at −z
    const p = standing(0, -4, { sneaking: true });
    as.update(DT, view(flatWorld(), p));
    expect(a.mode).not.toBe('watch'); // it cannot see them (its back is to them) and they make no sound
    // it turns round
    a.yaw = 0;
    a.targetYaw = 0;
    as.update(DT, view(flatWorld(), p));
    expect(a.mode).toBe('watch');
    const x0 = a.x;
    const z0 = a.z;
    // it stands and stares while they keep still, then settles (head down) in about (WATCH − CALM) / SETTLE seconds
    let t = 0;
    while (a.mode === 'watch' && t < 10) {
      as.update(DT, view(flatWorld(), p));
      t += DT;
    }
    expect(a.mode).not.toBe('flee');
    expect(t).toBeGreaterThan((SUSPECT_WATCH - SUSPECT_CALM) / SUSPECT_SETTLE - 0.2);
    expect(t).toBeLessThan((SUSPECT_WATCH - SUSPECT_CALM) / SUSPECT_SETTLE + 0.3);
    expect(Math.hypot(a.x - x0, a.z - z0)).toBeLessThan(0.05); // it did not move while it stared
    expect(a.accepted).toBe(true);
    // the still shape is accepted: it does not stare again while they keep still
    for (let i = 0; i < 30; i++) as.update(DT, view(flatWorld(), p));
    expect(a.mode).not.toBe('watch');
    expect(a.mode).not.toBe('flee');
  });

  it('any movement it sees while it stares spooks it', () => {
    const [as, a] = deerAt();
    const p = standing(0, -4, { sneaking: true });
    as.update(DT, view(flatWorld(), p));
    expect(a.mode).toBe('watch');
    p.vx = STILL_SPEED * 2;
    as.update(DT, view(flatWorld(), p));
    expect(a.mode).toBe('flee');
  });

  it('moving while it grazes raises its suspicion (faster nearer); it looks up at SUSPECT_WATCH; freeze, and it settles', () => {
    const [as, a] = deerAt();
    a.accepted = true; // it has already settled on the hunter's shape
    const p = standing(0, -5, { sneaking: true, vz: 0.6 });
    const range = noticeRange(a, p, a);
    as.update(DT, view(flatWorld(), p));
    expect(a.suspicion).toBeCloseTo(SUSPECT_RISE * (2 - 5 / range) * DT, 6);
    let i = 0;
    while (a.mode !== 'watch' && i++ < 60) as.update(DT, view(flatWorld(), p));
    expect(a.mode).toBe('watch');
    expect(a.suspicion).toBeGreaterThanOrEqual(SUSPECT_WATCH);
    p.vz = 0; // freeze
    for (let k = 0; k < 120 && a.mode === 'watch'; k++) as.update(DT, view(flatWorld(), p));
    expect(a.mode).not.toBe('flee');
    expect(a.mode).not.toBe('watch');
  });

  it('a hunter it cannot see who keeps moving near is heard: its suspicion reaches 1 and it bolts', () => {
    const [as, a] = deerAt(9, Math.PI); // its back to the hunter
    const p = standing(0, -2, { sneaking: true, vz: -0.5 });
    let i = 0;
    while (a.mode !== 'flee' && i++ < 200) {
      a.yaw = Math.PI; // keep it from turning round: only the suspicion can send it off
      as.update(DT, view(flatWorld(), p));
    }
    expect(a.mode).toBe('flee');
  });

  it('a walker inside the distance is run from at once, as before', () => {
    const [as, a] = deerAt();
    as.update(DT, view(flatWorld(), standing(0, -10)));
    expect(a.mode).toBe('flee');
  });
});

describe('§100 stalking — the wind', () => {
  it('upwind a crouching hunter is noticed farther than the plain distance; downwind they come a little nearer', () => {
    const n = SPECIES.deer.notice * SNEAK_NOTICE; // 6.4
    // the hunter west of the deer; the wind blows east (from them to it) at full strength: upwind
    const up = n * 1.5; // 9.6 m: beyond the plain distance, inside × 1.8
    const [as, a] = deerAt(5, Math.PI / 2); // facing −x, toward the hunter
    as.update(DT, view(flatWorld(), standing(-up, 0, { sneaking: true }), { wind: eastward(1) }));
    expect(a.scent).toBeCloseTo(1, 9);
    expect(a.mode).toBe('watch');
    // the same hunter with no wind: not noticed
    const [bs, b] = deerAt(5, Math.PI / 2);
    bs.update(DT, view(flatWorld(), standing(-up, 0, { sneaking: true })));
    expect(b.mode).not.toBe('watch');
    // downwind (the wind blowing from the deer to the hunter): a step inside the plain distance is not noticed
    const down = n * 0.9;
    const [cs, c] = deerAt(5, -Math.PI / 2); // facing +x, toward a hunter east of it
    cs.update(DT, view(flatWorld(), standing(down, 0, { sneaking: true }), { wind: eastward(1) }));
    expect(c.scent).toBeCloseTo(-1, 9);
    expect(c.mode).not.toBe('watch');
    expect(down).toBeGreaterThan(n * (1 - SCENT_DOWNWIND));
  });
});
