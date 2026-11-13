// Caelancraft — animals: cattle, sheep, horses and wolves (PURE; CONTRACTS §69), and the game of the harder land
// (v0.14, §76 fauna): deer, rabbits, pheasants, wild turkeys, bears and the fish of the streams.
//
// An animal is a body (physics.createBody) driven through the same stepPlayer physics as the player, the pigs and the
// zombies, so it slides along honeycomb walls, hops one-cell ledges, swims and takes part in resolveBodies.
//
// They are wary: a wild animal that notices the player (within its species' `notice` distance — much less when the
// player sneaks, more when sprinting) runs until it is `calm` distance away, and the herd runs with it. Since §88 they
// live in the world: populations.js keeps them, wakes them near the player and puts them to sleep far away (this class
// is the LIVE list only), and they are born — none appears out of nowhere and none despawns. Getting one takes work:
//   - stalk it (sneak), or throw a spear or a dart (looseItems);
//   - hold out food it likes (`lure`): it does not flee and comes up to you (unless you sprint);
//   - set a Snare: an animal that steps into one is held for TRAP_HOLD_S; a baited snare draws animals from BAIT_RANGE.
// Cattle and sheep give meat, hide and wool (a sheep can also be sheared, and its fleece grows back). Horses, wolves and
// (§88) cattle and sheep are TAMED by feeding: a tame horse waits where it is left and can be ridden (`ride`), a tame wolf
// follows the player and bites the zombies near it, tame cattle and sheep stay where they are left and follow the food
// in your hand (into a pen). Tame animals never flee. Every animal has a sex and an age (`sex`, `born`, `size`, §88).
//
// v0.14 (§76 fauna). None of the new kinds is lured or tamed; each is its own kind of work:
//   - deer: herds in forest and plains, the wariest animal on land — they notice from far and bolt fast and far;
//   - rabbits: small, quick, and they zig-zag as they run: hard to hit, a natural catch for a Snare;
//   - pheasants and wild turkeys: on the ground almost always. Spooked, a pheasant FLUSHES (it bursts into the air and
//     flies off low and fast, landing well away), a turkey darts off at a run after a short flapping glide. Left in
//     peace, the hens lay Ground Nests (eggs);
//   - the bear: solitary, and it does not run. Come too close and it REARS and growls (the warning: back away); stay,
//     come closer, or hurt it, and it CHARGES and mauls. It gives up after a chase;
//   - fish: in stream water, never out of it (they do not use stepPlayer at all). They dart away from a player who
//     comes near; only a spear, thrust or thrown, catches one.
import {
  GRAVITY, WALK_SPEED, SPRINT_SPEED, WARY_SNEAK_FACTOR, WARY_SPRINT_FACTOR, WARY_VIEW_HALF_ANGLE, WARY_BEHIND_FACTOR, GROUND_ACCEL,
  FLY_SPEED, PLAYER_HEIGHT,
} from './config.js';
import { createBody, stepPlayer, findFreeY, isFreeAt, isSwimWater, shouldPaddle, settleFloat } from './physics.js';
import { hexToWorld, worldToHex } from './hex.js';
import { yawToForward, isBehind } from './coords.js';
import { BLOCK, BIOME, isSolid, isLiquid, waterSurfaceHeight } from './blocks.js';
import { fireAhead, shoreYaw, isOpen, wrapAngle, SWIM_REAIM_S, PLANT_LURE } from './pigs.js';

export { PLANT_LURE };

/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */
/** @typedef {import('./types.js').PlayerState} PlayerState */

const TWO_PI = Math.PI * 2;


/** What a wolf comes to: meat, raw or roast. */
export const MEAT_LURE = Object.freeze([
  'raw_pork', 'roast_pork', 'raw_beef', 'roast_beef', 'raw_mutton', 'roast_mutton',
  // v0.14 (§76 fauna): the game meats too
  'raw_venison', 'roast_venison', 'raw_rabbit', 'roast_rabbit', 'raw_fowl', 'roast_fowl', 'raw_bear', 'roast_bear',
]);
/** v0.14 (§76 fauna): what the game animals come to — nothing. They are neither lured nor tamed. */
export const NO_LURE = Object.freeze(/** @type {string[]} */ ([]));

/**
 * The species. `radius` / `height` / `mass` the body; `health` hit points; `notice` how near (m) a walking player may
 * come before it runs, `fleeScale` (× WALK_SPEED, or × SPRINT_SPEED with `fleeSprint`) how fast; `turn` rad/s; `herd`
 * the natural group size [min, max]; `lure` the food it comes to and is fed; `tame` the feeds that tame it (0: never).
 *
 * v0.14 (§76 fauna), all optional: `pool` which spawn pool it belongs to ('herd' when absent; 'small' the small game,
 * 'fish'); `calm` its own CALM_FACTOR (how far it bolts); `zigzag` it swerves as it runs; `flush` what a spooked bird
 * does ('fly': FLUSH_S in the air at `cruise` m above the ground; 'glide': a short one); `nests` it lays Ground Nests;
 * `predator` it does not run — it warns and charges (the bear; `notice` is then how near a walking player may come
 * before it rears); `snare: false` a snare neither holds nor draws it; `water` it lives in water and never leaves it;
 * `pad` extra reach (m) of its crosshair target; `alarm` its own HERD_ALARM. (§88: `herd` is a group's size in the
 * guide's words; `despawn` went with despawning.)
 */
export const SPECIES = Object.freeze({
  // §88: cattle and sheep are tamed by three feeds (livestock), as horses and wolves always were
  cow: Object.freeze({ name: 'Cow', radius: 0.44, height: 1.3, mass: 2.4, health: 10, notice: 9, fleeScale: 1.0, fleeSprint: false, turn: 3.2, herd: Object.freeze([1, 3]), lure: PLANT_LURE, tame: 3, voice: 'moo' }),
  sheep: Object.freeze({ name: 'Sheep', radius: 0.36, height: 0.95, mass: 0.9, health: 6, notice: 10, fleeScale: 1.1, fleeSprint: false, turn: 4, herd: Object.freeze([1, 3]), lure: PLANT_LURE, tame: 3, voice: 'baa' }),
  horse: Object.freeze({ name: 'Horse', radius: 0.44, height: 1.55, mass: 2.6, health: 12, notice: 13, fleeScale: 1.45, fleeSprint: true, turn: 3.5, herd: Object.freeze([1, 2]), lure: PLANT_LURE, tame: 3, voice: 'neigh' }),
  wolf: Object.freeze({ name: 'Wolf', radius: 0.3, height: 0.8, mass: 0.8, health: 8, notice: 11, fleeScale: 1.15, fleeSprint: true, turn: 5, herd: Object.freeze([1, 2]), lure: MEAT_LURE, tame: 3, voice: 'woof' }),
  // v0.14 (§76 fauna)
  deer: Object.freeze({ name: 'Deer', radius: 0.36, height: 1.25, mass: 1.4, health: 8, notice: 16, fleeScale: 1.3, fleeSprint: true, turn: 4.5, herd: Object.freeze([2, 3]), lure: NO_LURE, tame: 0, voice: 'bleat', calm: 2.5 }),
  rabbit: Object.freeze({ name: 'Rabbit', radius: 0.18, height: 0.4, mass: 0.25, health: 2, notice: 8, fleeScale: 1.3, fleeSprint: true, turn: 9, herd: Object.freeze([1, 2]), lure: NO_LURE, tame: 0, voice: 'squeak', pool: 'small', zigzag: true }),
  pheasant: Object.freeze({ name: 'Pheasant', radius: 0.2, height: 0.5, mass: 0.3, health: 2, notice: 7, fleeScale: 1, fleeSprint: true, turn: 7, herd: Object.freeze([1, 3]), lure: NO_LURE, tame: 0, voice: 'cackle', pool: 'small', flush: 'fly', cruise: 2.6, nests: true }),
  turkey: Object.freeze({ name: 'Wild Turkey', radius: 0.28, height: 0.8, mass: 0.7, health: 4, notice: 9, fleeScale: 1.2, fleeSprint: true, turn: 6, herd: Object.freeze([1, 3]), lure: NO_LURE, tame: 0, voice: 'gobble', pool: 'small', flush: 'glide', cruise: 0.9, nests: true }),
  bear: Object.freeze({ name: 'Bear', radius: 0.48, height: 1.45, mass: 4, health: 30, notice: 9, fleeScale: 1.1, fleeSprint: true, turn: 3.6, herd: Object.freeze([1, 1]), lure: NO_LURE, tame: 0, voice: 'grunt', predator: true, snare: false }),
  fish: Object.freeze({ name: 'Fish', radius: 0.16, height: 0.2, mass: 0.1, health: 2, notice: 4.5, fleeScale: 1, fleeSprint: false, turn: 10, herd: Object.freeze([1, 3]), lure: NO_LURE, tame: 0, voice: 'plop', pool: 'fish', water: true, snare: false, pad: 0.14, alarm: 4 }),
});
/** @typedef {'cow'|'sheep'|'horse'|'wolf'|'deer'|'rabbit'|'pheasant'|'turkey'|'bear'|'fish'} AnimalKind */
export const ANIMAL_KINDS = Object.freeze(/** @type {AnimalKind[]} */ (Object.keys(SPECIES)));

/**
 * At most this many LIVE animals (24 until v0.14, 40 until §88; populations.LIVE_MAX keeps the animals and the pigs
 * together to it, the rest sleep in their zones).
 */
export const ANIMAL_MAX = 64;
/** §88: an animal spawned with no age of its own (summon, an older save) is this many game days old: grown, every kind. */
export const ADULT_AGE = 100;
/** A sneaking player is noticed at this share of `notice`; a sprinting one from this much farther. */
export const SNEAK_NOTICE = WARY_SNEAK_FACTOR;
export const SPRINT_NOTICE = WARY_SPRINT_FACTOR;
/**
 * Stalking (v0.16): an animal sees VIEW_HALF_ANGLE to either side of where it faces. A sneaking player in the blind arc
 * at its back is noticed at BEHIND_NOTICE of the sneaking distance — until the animal turns its head.
 */
export const VIEW_HALF_ANGLE = WARY_VIEW_HALF_ANGLE;
export const BEHIND_NOTICE = WARY_BEHIND_FACTOR;
/** It runs until the player is this many times `notice` away. */
export const CALM_FACTOR = 2.2;
/** A hit makes it (and its herd within HERD_ALARM) run for at least this long (s). */
export const HIT_FLEE_S = 6;
export const HERD_ALARM = 12;
/** Fed cattle and sheep stay calm (they do not flee) this long (s). */
export const FED_CALM_S = 40;
/** A lured animal comes from this far (m) and stops this close. */
export const LURE_RANGE = 11;
export const LURE_STOP = 2.2;
/** The hurt flash; hits during it are ignored. Knockback (m/s) and hop. */
export const ANIMAL_HURT_S = 0.5;
export const ANIMAL_KNOCKBACK = 4.5;
/** A sheared sheep's fleece is back after this long (s). Shearing gives SHEAR_WOOL[0]..[1] wool. */
export const SHEAR_REGROW_S = 300;
export const SHEAR_WOOL = Object.freeze([1, 2]);
/** A milked cow gives milk again after this long (s). */
export const MILK_REGROW_S = 240;

/** Snares: a caught animal is held this long (s), then breaks free and cannot be caught again for TRAP_IMMUNE_S. */
export const TRAP_HOLD_S = 90;
export const TRAP_IMMUNE_S = 20;
/** A baited snare draws calm animals from this many cells; they look for one every BAIT_CHECK_S. */
export const BAIT_RANGE = 7;
export const BAIT_CHECK_S = 2;

/** A tame wolf: follows beyond FOLLOW_NEAR, runs beyond FOLLOW_RUN, is brought back beyond FOLLOW_TELEPORT (m). */
export const FOLLOW_NEAR = 3.5;
export const FOLLOW_RUN = 9;
export const FOLLOW_TELEPORT = 32;
/** It goes for a zombie within WOLF_GUARD (m) of it, bites within WOLF_BITE_REACH every WOLF_BITE_S for WOLF_BITE power. */
export const WOLF_GUARD = 9;
export const WOLF_BITE_REACH = 1.25;
export const WOLF_BITE_S = 1;
export const WOLF_BITE = 2;
/** A tame horse (§88: any kept animal) left alone wanders at most this far (m) from where it was left. */
export const HOME_RANGE = 4;
/** §88: a young animal heads back to its mother when it is more than this far (m) from her. */
export const YOUNG_KEEP = 3;

/** Riding: the saddle is this far above the horse's feet; ridden, the horse's body is this much taller (the rider). */
export const SADDLE_Y = 1.15;
export const RIDER_HEIGHT = 1.25;
/** A ridden horse moves at × this of the walking (or, sprinting, the sprint) speed, and leaps this many cells on Space. */
export const RIDE_SCALE = 1.55;
export const RIDE_LEAP = 2.2;

/**
 * Species weights by biome (index = BIOME id); a biome with no weights holds none of them. Until §88 a natural herd was
 * picked by these near the player (HERD_CHANCE and friends, and despawning beyond DESPAWN_DIST: retired); now a zone's
 * carrying capacity reads them (populations.suitability: a kind's weight over its best weight anywhere).
 */
export const HERD_WEIGHTS = Object.freeze({
  // v0.14 (§76 fauna): deer, the bear and the small game (rabbit, pheasant, turkey) joined each land's table. A kind is
  // weighed only against the others of its own pool (poolOf): herds and small game appear independently.
  [BIOME.PLAINS]: Object.freeze({ cow: 3, sheep: 3, horse: 1.5, deer: 2, rabbit: 3, pheasant: 2, turkey: 1 }),
  [BIOME.FOREST]: Object.freeze({ wolf: 2, sheep: 1, cow: 1, deer: 4, bear: 0.5, rabbit: 2, pheasant: 1.5, turkey: 2.5 }),
  [BIOME.MOUNTAINS]: Object.freeze({ sheep: 3, wolf: 1, bear: 0.6, rabbit: 1 }),
  [BIOME.SNOWY]: Object.freeze({ wolf: 2, sheep: 0.5, bear: 0.6, rabbit: 1 }),
});

// ---- v0.14 (§76 fauna): the game of the harder land -----------------------------------------------------------------

/** @typedef {'herd'|'small'|'fish'} SpawnPool */
/**
 * The pool a kind belongs to: 'herd' (the big animals), 'small' (rabbits and the birds) or 'fish'. The guide weighs a
 * kind's lands against the others of its own pool. @returns {SpawnPool}
 */
export function poolOf(kind) {
  return (isAnimalKind(kind) && /** @type {*} */ (SPECIES[kind]).pool) || 'herd';
}

/** A running rabbit swerves ZIG_ANGLE (rad) to one side of straight away, and changes side every ZIG_S[0]..[1] seconds. */
export const ZIG_ANGLE = 0.7;
export const ZIG_S = Object.freeze([0.3, 0.6]);

/**
 * A flushed pheasant is in the air FLUSH_S[0]..[1] seconds, a turkey's glide lasts TURKEY_GLIDE_S; both fly at
 * config.FLY_SPEED, climbing at up to FLUSH_CLIMB and sinking at up to FLUSH_SINK (m/s) toward their species' `cruise`
 * height above the ground. Over deep water a bird stays up for up to FLUSH_OVER_WATER_S more. Wings beat WING_BEAT rad/s.
 */
export const FLUSH_S = Object.freeze([2.4, 3.2]);
export const TURKEY_GLIDE_S = 0.9;
/** How fast a bird flies (m/s): physics moves a flying body at config.FLY_SPEED — about twice the player's sprint. */
export const FLUSH_SPEED = FLY_SPEED;
export const FLUSH_CLIMB = 6.5;
export const FLUSH_SINK = 3.5;
export const FLUSH_OVER_WATER_S = 2.5;
export const WING_BEAT = 26;

/**
 * Ground nests: every grown wild hen (§88: the female pheasants and turkeys; until then NEST_HEN_P 0.5 of the birds, by a
 * coin toss). A hen left in peace lays a nest where she stands — the first NEST_FIRST_S[0]..[1] after she woke (a flock
 * that is scared off at once leaves none), then every NEST_EVERY_S[0]..[1] — unless the player is within NEST_PRIVACY
 * (m) or a nest with eggs lies within NEST_SPACING cells. An EMPTY nest that near is laid in again instead. A try that
 * fails comes back in NEST_RETRY_S. The eggs do not hatch: birds are born like every other kind (populations.js).
 */
export const NEST_FIRST_S = Object.freeze([60, 180]);
export const NEST_EVERY_S = Object.freeze([240, 420]);
export const NEST_RETRY_S = 30;
export const NEST_PRIVACY = 10;
export const NEST_SPACING = 6;

/**
 * The bear. It ignores a player beyond its warning distance (bearRange: its `notice`, by the sneak / sprint factors,
 * never less than BEAR_CHARGE_DIST + BEAR_SNEAK_MARGIN). Inside it the bear REARS and growls for BEAR_WARN_S: a player
 * who is BEAR_BACK_OFF times that distance away by then is left alone. One who is not — or who comes within
 * BEAR_CHARGE_DIST, or hurts it — is CHARGED: it runs at them for BEAR_CHASE_S (a blow starts the count again), mauls
 * within BEAR_REACH every BEAR_MAUL_S (main: BEAR_DAMAGE health; here: a throw of BEAR_PUSH m/s and BEAR_LIFT up), and
 * gives up when the time is out or the player is BEAR_GIVE_UP away; then it leaves the player alone for BEAR_REST_S.
 * After a maul it gathers itself for BEAR_RECOVER_S before it moves again: it is only a little faster than a sprint, so
 * that pause is what lets a player who turns and runs get away with ONE maul — while one who stays in reach is mauled
 * again every BEAR_MAUL_S.
 */
export const BEAR_WARN_S = 2.5;
export const BEAR_BACK_OFF = 1.35;
export const BEAR_CHARGE_DIST = 3.5;
export const BEAR_SNEAK_MARGIN = 1.5;
export const BEAR_CHASE_S = 9;
export const BEAR_GIVE_UP = 24;
export const BEAR_REST_S = 8;
export const BEAR_REACH = 1.7;
export const BEAR_MAUL_S = 1.4;
export const BEAR_RECOVER_S = 1;
export const BEAR_DAMAGE = 18;
export const BEAR_PUSH = 8;
export const BEAR_LIFT = 5;
/** The swipe's pose lasts BEAR_SWIPE_S; the rear-up eases in and out at REAR_RATE per second; a blow moves a bear only BEAR_KNOCK of ANIMAL_KNOCKBACK. */
export const BEAR_SWIPE_S = 0.4;
export const REAR_RATE = 5;
export const BEAR_KNOCK = 0.35;

/**
 * Fish. They swim only where the water is at least FISH_MIN_WATER deep, FISH_UNDER below its surface (fishDepth: their
 * body is just under it and the back fin cuts the surface, which is how a fish is spotted from the bank), at
 * FISH_CRUISE (m/s); a player within their notice makes the school dart at FISH_DART for FISH_DART_S, then hold still for
 * FISH_REST_S before it can dart again. Since §88 fish belong to their stream or pond (a zone's fish, populations.js):
 * the schools that appeared round the player (FISH_CHECK_S, FISH_CHANCE and the rest) are retired.
 */
export const FISH_MIN_WATER = 0.3;
export const FISH_UNDER = 0.24;
export const FISH_CRUISE = 0.9;
export const FISH_DART = 5.5;
export const FISH_DART_S = 1.1;
export const FISH_REST_S = 1.5;

/** The voices and the snare's snap (audio.playRecipe data). Gentle, short, never startling. */
export const SOUNDS = Object.freeze({
  moo: Object.freeze({ dur: 0.9, gain: 0.3, layers: [{ type: 'saw', f0: 150, f1: 118, lp: 620, gain: 0.7, attack: 0.12, decay: 0.75 }, { type: 'sine', f0: 300, f1: 236, gain: 0.25, attack: 0.12, decay: 0.7 }] }),
  baa: Object.freeze({ dur: 0.55, gain: 0.26, layers: [{ type: 'saw', f0: 430, f1: 380, lp: 1500, gain: 0.6, attack: 0.04, decay: 0.48, lfoHz: 13, lfoDepth: 0.55 }] }),
  neigh: Object.freeze({ dur: 0.8, gain: 0.26, layers: [{ type: 'saw', f0: 880, f1: 420, lp: 2200, gain: 0.55, attack: 0.05, decay: 0.7, lfoHz: 11, lfoDepth: 0.5 }] }),
  woof: Object.freeze({ dur: 0.22, gain: 0.3, layers: [{ type: 'saw', f0: 260, f1: 170, lp: 900, gain: 0.7, attack: 0.01, decay: 0.18 }, { type: 'noise', f0: 0, bp: 700, q: 1.5, gain: 0.3, attack: 0.01, decay: 0.12 }] }),
  whine: Object.freeze({ dur: 0.35, gain: 0.22, layers: [{ type: 'sine', f0: 700, f1: 980, gain: 0.6, attack: 0.05, decay: 0.28 }] }),
  snare: Object.freeze({ dur: 0.18, gain: 0.4, layers: [{ type: 'noise', f0: 0, hp: 1800, gain: 0.7, attack: 0.002, decay: 0.08 }, { type: 'sine', f0: 520, f1: 240, gain: 0.4, attack: 0.002, decay: 0.14 }] }),
  tame: Object.freeze({ dur: 0.5, gain: 0.25, layers: [{ type: 'sine', f0: 523, f1: 523, gain: 0.5, attack: 0.01, decay: 0.2 }, { type: 'sine', f0: 784, f1: 784, gain: 0.5, attack: 0.01, decay: 0.3, delay: 0.14 }] }),
  // v0.14 (§76 fauna): a deer's bleat, a rabbit's squeak, a pheasant's two-note cackle, a turkey's gobble, a fish's plop;
  // the bear's grunt (in passing), growl (the warning: low and long, so it is heard in time) and roar (the charge); and
  // the whirr of wings when a bird flushes.
  bleat: Object.freeze({ dur: 0.4, gain: 0.24, layers: [{ type: 'saw', f0: 560, f1: 430, lp: 1500, gain: 0.6, attack: 0.03, decay: 0.34, lfoHz: 9, lfoDepth: 0.3 }] }),
  squeak: Object.freeze({ dur: 0.14, gain: 0.16, layers: [{ type: 'sine', f0: 1500, f1: 2200, gain: 0.6, attack: 0.01, decay: 0.11 }] }),
  cackle: Object.freeze({ dur: 0.42, gain: 0.24, layers: [{ type: 'saw', f0: 980, f1: 760, lp: 2600, gain: 0.55, attack: 0.005, decay: 0.12 }, { type: 'saw', f0: 820, f1: 620, lp: 2400, gain: 0.5, attack: 0.005, decay: 0.16, delay: 0.17 }] }),
  gobble: Object.freeze({ dur: 0.6, gain: 0.26, layers: [{ type: 'saw', f0: 620, f1: 330, lp: 1700, gain: 0.6, attack: 0.02, decay: 0.52, lfoHz: 17, lfoDepth: 0.8 }] }),
  grunt: Object.freeze({ dur: 0.45, gain: 0.26, layers: [{ type: 'saw', f0: 96, f1: 74, lp: 340, gain: 0.8, attack: 0.05, decay: 0.36 }] }),
  growl: Object.freeze({ dur: 1.3, gain: 0.36, layers: [{ type: 'saw', f0: 84, f1: 66, lp: 420, gain: 0.8, attack: 0.15, decay: 1.05, lfoHz: 21, lfoDepth: 0.45 }, { type: 'noise', f0: 0, lp: 500, gain: 0.25, attack: 0.15, decay: 0.9 }] }),
  roar: Object.freeze({ dur: 0.9, gain: 0.4, layers: [{ type: 'saw', f0: 150, f1: 88, lp: 700, gain: 0.8, attack: 0.06, decay: 0.78, lfoHz: 14, lfoDepth: 0.3 }, { type: 'noise', f0: 0, bp: 500, q: 0.8, gain: 0.3, attack: 0.05, decay: 0.6 }] }),
  plop: Object.freeze({ dur: 0.16, gain: 0.16, layers: [{ type: 'sine', f0: 520, f1: 210, gain: 0.6, attack: 0.004, decay: 0.12 }, { type: 'noise', f0: 0, hp: 1500, gain: 0.2, attack: 0.002, decay: 0.05 }] }),
  flush: Object.freeze({ dur: 0.7, gain: 0.3, layers: [{ type: 'noise', f0: 0, bp: [900, 500], q: 1.2, gain: 0.8, attack: 0.02, decay: 0.62, lfoHz: 19, lfoDepth: 0.85 }] }),
});

/**
 * @typedef {PlayerState & {
 *   id: number, kind: AnimalKind, yaw: number, targetYaw: number,
 *   mode: 'idle'|'walk'|'flee'|'lure'|'bait'|'follow'|'hunt'|'warn'|'charge',
 *   timer: number, hurt: number, health: number, walkPhase: number, voiceIn: number,
 *   tamed: boolean, trust: number, calm: number, shorn: number, milked: number, sitting: boolean, ridden: boolean,
 *   homeX: number, homeZ: number, trapped: number, trapT: number, trapCell: [number, number, number]|null, immune: number,
 *   baitIn: number, baitX: number, baitZ: number, biteIn: number, side: 1|-1, speedScale: number, wallSinceAim: boolean,
 *   variant: number, air: number, zigIn: number, nestIn: number,
 *   rear: number, warn: number, chase: number, rest: number, maulIn: number, swipe: number,
 *   sex: 'f'|'m', born: number, size: number, restUntil: number, fedAt: number, habBits: number, habAt: number,
 * }} Animal
 * §88 (populations.js): `sex`; `born` the game day it was born; `size` its size, YOUNG_SCALE..1 (below 1: young; its
 * body's radius and height are scaled with it); `restUntil` the game day a mother may breed again; `fedAt` the game day
 * it was last fed by hand; `habBits` / `habAt` what it found within FEED_RANGE (1 food, 2 water) and when.
 * v0.14 (§76 fauna): `variant` 1 = a stag (antlers; saved); `air` > 0 the seconds a flushed bird still flies, < 0 it
 * is coming down, 0 on the ground; `zigIn` until a rabbit's next swerve; `nestIn` until a hen's next nest (Infinity:
 * it never lays); the bear's
 * `rear` 0..1 (how far it has reared up, for the model), `warn` the seconds it has warned, `chase` the seconds of charge
 * left, `rest` the seconds it leaves the player alone, `maulIn` until it can maul again, `swipe` the swipe's pose time.
 */

/**
 * @typedef {Object} AnimalWorld
 * @property {GetBlockFn} getBlock
 * @property {(x: number, z: number) => boolean} isLoaded
 * @property {PlayerState|null} [player]      whom the wild ones run from and the tame wolves follow (null: nobody)
 * @property {string|null} [heldKey]          the item in the player's hand (a lure?)
 * @property {ReadonlyArray<PlayerState>} [threats]  the zombies a tame wolf goes for
 * @property {(x: number, y: number, z: number, out: [number, number, number]) => *} [pullAt]
 * @property {() => boolean} [hasCampfires]
 * @property {(q: number, r: number) => number} [getBiome]            natural herds need this and the next three
 * @property {(q: number, r: number) => number} [groundHeight]
 * @property {(q: number, y: number, r: number) => boolean} [isNaturalGround]
 * @property {(q: number, r: number) => boolean} [isLoadedCell]
 * @property {(q: number, r: number) => boolean} [streamAt]   v0.14: the column is on a generated stream (fish appear there)
 */

/**
 * What one update did, for main's sounds, blocks and effects. The arrays are reused by the next update.
 * @typedef {Object} AnimalEvents
 * @property {Animal[]} voices      ambient calls due
 * @property {Animal[]} startled    started to run from the player this frame
 * @property {{ animal: Animal, cell: [number, number, number] }[]} caught   stepped into a snare (main springs the block)
 * @property {{ cell: [number, number, number], escaped: boolean }[]} freed  a snare let go (main resets the block)
 * @property {{ wolf: Animal, target: * }[]} bites   a tame wolf bit a threat (main applies it)
 * @property {number} despawned     fish whose water was gone (a death without a blow)
 * @property {Animal[]} flushed     v0.14 (§76 fauna): birds that took to the air this frame (main: the whirr of wings)
 * @property {Animal[]} warned      bears that reared up this frame (main: the growl)
 * @property {Animal[]} charged     bears that began a charge this frame (main: the roar)
 * @property {Animal[]} mauls       bears that mauled the player this frame (main: BEAR_DAMAGE each; the throw is done here)
 * @property {{ cell: [number, number, number], refill: boolean }[]} laid   a hen laid a nest in this cell (main writes
 *   GROUND_NEST there: into AIR, or — `refill` — over the GROUND_NEST_EMPTY that is there)
 */

/** Ray (origin o, unit direction d) against an upright cylinder at feet (cx, y0, cz): entry distance, or −1. */
function rayCylinder(ox, oy, oz, dx, dy, dz, cx, y0, cz, radius, height) {
  const px = ox - cx;
  const pz = oz - cz;
  const y1 = y0 + height;
  const r2 = radius * radius;
  let best = Infinity;
  const a = dx * dx + dz * dz;
  if (a > 1e-12) {
    const b = px * dx + pz * dz;
    const disc = b * b - a * (px * px + pz * pz - r2);
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      const y = oy + dy * t;
      if (t >= 0 && y >= y0 && y <= y1) best = t;
    }
  }
  if (Math.abs(dy) > 1e-12) {
    for (const yc of [y0, y1]) {
      const t = (yc - oy) / dy;
      if (!(t >= 0 && t < best)) continue;
      const hx = px + dx * t;
      const hz = pz + dz * t;
      if (hx * hx + hz * hz <= r2) best = t;
    }
  }
  return best === Infinity ? -1 : best;
}

/** Yaw that faces from (x, z) toward (tx, tz): yawToForward(yaw) = (−sin, −cos). */
function yawToward(x, z, tx, tz) {
  return Math.atan2(-(tx - x), -(tz - z));
}

/** @param {*} kind @returns {kind is AnimalKind} */
export function isAnimalKind(kind) {
  return typeof kind === 'string' && Object.hasOwn(SPECIES, kind);
}

/**
 * Whether the player stands where `a` cannot see: in the arc at its back, beyond VIEW_HALF_ANGLE from where it faces.
 * False when either position (or the animal's heading) is not known.
 * @param {{ x?: number, z?: number, yaw?: number }} a @param {{ x?: number, z?: number }} player
 * @returns {boolean}
 */
export function blindTo(a, player) {
  if (!Number.isFinite(a.x) || !Number.isFinite(a.z) || !Number.isFinite(player.x) || !Number.isFinite(player.z)) return false;
  return isBehind(/** @type {number} */ (a.yaw), /** @type {number} */ (player.x) - /** @type {number} */ (a.x),
    /** @type {number} */ (player.z) - /** @type {number} */ (a.z), VIEW_HALF_ANGLE);
}

/**
 * How near the player may come before `a` runs (m): its species' `notice`, less for a sneaker — half of that again for
 * one who sneaks up from behind (blindTo) — and more for a sprinter.
 */
export function noticeRange(a, player) {
  const n = SPECIES[a.kind].notice;
  if (player.sneaking) return n * SNEAK_NOTICE * (blindTo(a, player) ? BEHIND_NOTICE : 1);
  if (player.sprinting) return n * SPRINT_NOTICE;
  return n;
}

/**
 * v0.14 (§76 fauna): how near the player may come before a bear rears up (m): noticeRange, but never so near that the
 * warning would come inside the distance at which it charges at once (a sneaking player is warned too).
 */
export function bearRange(a, player) {
  return Math.max(noticeRange(a, player), BEAR_CHARGE_DIST + BEAR_SNEAK_MARGIN);
}

/**
 * v0.14 (§76 fauna): where a fish swims in column (q, r) near height y — the feet height that keeps it FISH_UNDER below
 * the water surface, never lower than just above the bed — or NaN when there is no water at that height (one cell up or
 * down counts: a stream steps) or it is shallower than FISH_MIN_WATER. Fish only ever move to where this is a number,
 * which is what keeps them in the water.
 * @param {GetBlockFn} getBlock @param {number} q @param {number} r @param {number} y @returns {number}
 */
export function fishDepth(getBlock, q, r, y) {
  let cy = Math.floor(y);
  if (!isLiquid(getBlock(q, cy, r))) {
    if (isLiquid(getBlock(q, cy + 1, r))) cy += 1;
    else if (isLiquid(getBlock(q, cy - 1, r))) cy -= 1;
    else return NaN;
  }
  let top = cy;
  while (top - cy < 8 && isLiquid(getBlock(q, top + 1, r))) top++;
  let bottom = cy;
  while (cy - bottom < 8 && isLiquid(getBlock(q, bottom - 1, r))) bottom--;
  const surface = top + waterSurfaceHeight(getBlock(q, top, r), getBlock(q, top + 1, r));
  if (surface - bottom < FISH_MIN_WATER) return NaN;
  return Math.max(bottom + 0.06, surface - FISH_UNDER);
}

/** How fast the legs go: radians of walkPhase per metre walked (3.6 when a kind is not listed). Small legs go faster. */
const STRIDE_RATE = /** @type {Record<string, number>} */ (Object.freeze({ horse: 2.4, cow: 2.4, bear: 2.4, deer: 2.8, rabbit: 5.5, pheasant: 7, turkey: 5 }));

/** How far down a flying bird looks for the ground (cells). */
const FLIGHT_LOOK_DOWN = 16;
/**
 * The height of what lies under (x, z) at or below y: the top of the first solid cell or the surface of the first
 * water, looking down FLIGHT_LOOK_DOWN cells (y − FLIGHT_LOOK_DOWN when there is nothing). `out.water` says which.
 * @param {GetBlockFn} getBlock @param {{ water: boolean }} out @returns {number}
 */
function groundBelow(getBlock, x, y, z, out) {
  const [q, r] = worldToHex(x, z);
  const y0 = Math.floor(y);
  out.water = false;
  for (let cy = y0; cy >= y0 - FLIGHT_LOOK_DOWN && cy >= 0; cy--) {
    const id = getBlock(q, cy, r);
    if (isSolid(id)) return cy + 1;
    if (isLiquid(id)) {
      out.water = true;
      return cy + 1;
    }
  }
  return y - FLIGHT_LOOK_DOWN;
}

export class Animals {
  /** @param {() => number} [rng] uniform [0, 1) */
  constructor(rng = Math.random) {
    /** @type {Animal[]} */
    this.list = [];
    this._rng = rng;
    this._nextId = 1;
    /** §88: the world clock in game days (populations.Fauna keeps it): a feed is stamped with it, a spawn is born before it */
    this.now = 0;
    /** @type {AnimalEvents} */
    this.events = {
      voices: [], startled: [], caught: [], freed: [], bites: [], despawned: 0,
      flushed: [], warned: [], charged: [], mauls: [], laid: [],
    };
    /** how many entries of the carried event lists the last update reported (update drops those first) */
    this._seen = { freed: 0, flushed: 0, charged: 0 };
    /** scratch for groundBelow */
    this._under = { water: false };
    /** @type {[number, number, number]} */
    this._pull = [0, 0, 0];
    this._fires = true;
    this._input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0, pullX: 0, pullY: 0, pullZ: 0, speedFactor: 1 };
  }

  get size() {
    return this.list.length;
  }

  clear() {
    this.list.length = 0;
  }

  /**
   * Add an animal of `kind` standing at feet (x, y, z), of `sex` (§88; a female unless told), grown (ADULT_AGE game days
   * old). @returns {Animal|null} null at ANIMAL_MAX, for an unknown kind or a non-finite position
   */
  spawn(kind, x, y, z, yaw = 0, sex = 'f') {
    if (!isAnimalKind(kind) || this.list.length >= ANIMAL_MAX || !Number.isFinite(x + y + z + yaw)) return null;
    const sp = SPECIES[kind];
    const a = /** @type {Animal} */ (Object.assign(createBody(x, y, z, { radius: sp.radius, height: sp.height, mass: sp.mass }), {
      id: this._nextId++,
      kind,
      yaw: wrapAngle(yaw),
      targetYaw: wrapAngle(yaw),
      mode: 'idle',
      timer: 0.5 + this._rng() * 2,
      hurt: 0,
      health: sp.health,
      walkPhase: 0,
      voiceIn: 6 + this._rng() * 20,
      tamed: false,
      trust: 0,
      calm: 0,
      shorn: 0,
      milked: 0,
      sitting: false,
      ridden: false,
      homeX: x,
      homeZ: z,
      trapped: 0,
      trapT: 0,
      trapCell: null,
      immune: 0,
      baitIn: this._rng() * BAIT_CHECK_S,
      baitX: NaN,
      baitZ: NaN,
      biteIn: 0,
      side: this._rng() < 0.5 ? 1 : -1,
      speedScale: 1,
      wallSinceAim: false,
      // v0.14 (§76 fauna): 1 = a stag (§88: a male deer; kept for the old `animals` field and older code)
      variant: kind === 'deer' && sex === 'm' ? 1 : 0,
      air: 0,
      zigIn: 0,
      // a hen's time to her first nest; Infinity for a cock (or a kind) that never lays (and for a chick: _layNest)
      nestIn: /** @type {*} */ (sp).nests && sex !== 'm' ? NEST_FIRST_S[0] + this._rng() * (NEST_FIRST_S[1] - NEST_FIRST_S[0]) : Infinity,
      rear: 0,
      warn: 0,
      chase: 0,
      rest: 0,
      maulIn: 0,
      swipe: 0,
      // §88
      sex: sex === 'm' ? 'm' : 'f',
      born: this.now - ADULT_AGE,
      size: 1,
      restUntil: -Infinity,
      fedAt: -Infinity,
      habBits: -1,
      habAt: -Infinity,
    }));
    this.list.push(a);
    return a;
  }

  /**
   * §88: take an animal out of the live list as it goes to sleep (populations.Fauna.sleep): unlike `remove`, a snare
   * that holds it stays sprung (it is still held while it sleeps). @returns {boolean} it was in the list
   */
  detach(a) {
    const i = this.list.indexOf(a);
    if (i < 0) return false;
    this.list.splice(i, 1);
    return true;
  }

  /** @returns {boolean} true when it was in the list */
  remove(a) {
    const i = this.list.indexOf(a);
    if (i < 0) return false;
    if (a.trapCell) this.events.freed.push({ cell: a.trapCell, escaped: false });
    a.trapCell = null;
    this.list.splice(i, 1);
    return true;
  }

  /**
   * Every live animal: snares, AI, physics (§88: none appears or goes here; populations.js wakes and puts them to sleep).
   * @param {number} dt
   * @param {AnimalWorld} world
   * @returns {AnimalEvents} this.events (reused; `freed` may already hold what remove() queued since the last update)
   */
  update(dt, world) {
    const ev = this.events;
    ev.voices.length = 0;
    ev.startled.length = 0;
    ev.caught.length = 0;
    ev.bites.length = 0;
    ev.despawned = 0;
    ev.warned.length = 0;
    ev.mauls.length = 0;
    ev.laid.length = 0;
    // `freed`, `flushed` and `charged` can also be queued BETWEEN updates (remove() frees a snare; wound() flushes a
    // bird and provokes a bear): those are reported by this update. What the last update already reported goes — it
    // used to stay in `freed` for good, so a snare that had once let go was reset again the moment it next caught.
    ev.freed.splice(0, this._seen.freed);
    ev.flushed.splice(0, this._seen.flushed);
    ev.charged.splice(0, this._seen.charged);
    if (!(dt > 0)) return this._reported(ev);
    const player = world.player ?? null;
    const getBlock = world.getBlock;
    this._fires = world.hasCampfires ? !!world.hasCampfires() : true;

    const input = this._input;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const a = this.list[i];
      const sp = /** @type {*} */ (SPECIES[a.kind]);
      if (a.y < -16) {
        this.remove(a);
        continue;
      }
      if (!world.isLoaded(a.x, a.z)) continue; // frozen until its chunk is back (§88: and soon asleep)
      if (a.hurt > 0) a.hurt = Math.max(0, a.hurt - dt);
      if (a.calm > 0) a.calm = Math.max(0, a.calm - dt);
      if (a.shorn > 0) a.shorn = Math.max(0, a.shorn - dt);
      if (a.milked > 0) a.milked = Math.max(0, a.milked - dt);
      if (a.immune > 0) a.immune = Math.max(0, a.immune - dt);
      if (a.biteIn > 0) a.biteIn -= dt;
      a.voiceIn -= dt;
      if (a.voiceIn <= 0) {
        a.voiceIn = 14 + this._rng() * 30;
        ev.voices.push(a);
      }
      if (a.ridden) continue; // ride() moves it

      // v0.14 (§76 fauna): a fish swims by its own rule (never through stepPlayer) and is gone when its water is.
      if (sp.water) {
        if (!this._fish(a, dt, world, player, ev)) {
          this.list.splice(i, 1);
          ev.despawned++;
        }
        continue;
      }
      if (sp.predator) {
        if (a.rest > 0) a.rest = Math.max(0, a.rest - dt);
        if (a.maulIn > 0) a.maulIn = Math.max(0, a.maulIn - dt);
        if (a.swipe > 0) a.swipe = Math.max(0, a.swipe - dt);
        // the rear-up eases in while it warns and out again afterwards (the model reads `rear`)
        a.rear += ((a.mode === 'warn' ? 1 : 0) - a.rear) * (1 - Math.exp(-REAR_RATE * dt));
      }

      // Held by a snare: it struggles on the spot until the time is up, or the snare is gone.
      if (a.trapped > 0) {
        a.trapped -= dt;
        a.trapT += dt;
        const c = /** @type {[number, number, number]} */ (a.trapCell);
        const gone = a.trapT > 0.25 && getBlock(c[0], c[1], c[2]) !== BLOCK.SNARE_SPRUNG;
        if (a.trapped <= 0 || gone) {
          this._release(a, !gone);
        } else {
          const [cx, cz] = hexToWorld(c[0], c[2]);
          a.x = cx;
          a.z = cz;
          a.vx = 0;
          a.vz = 0;
          a.walkPhase = (a.walkPhase + dt * 9) % TWO_PI; // it struggles
          a.yaw = wrapAngle(a.yaw + Math.sin(a.trapT * 5) * dt * 1.5);
          continue;
        }
      }

      this._unstick(a, getBlock);
      const gait = this._think(a, dt, world, player, ev);

      const dYaw = wrapAngle(a.targetYaw - a.yaw);
      const maxTurn = sp.turn * dt;
      a.yaw = wrapAngle(a.yaw + Math.max(-maxTurn, Math.min(maxTurn, dYaw)));
      const moving = gait !== 'stand' && a.hurt <= 0.25 && Math.abs(wrapAngle(a.targetYaw - a.yaw)) < 1.2;
      input.forward = moving ? 1 : 0;
      input.sneak = moving && gait === 'amble';
      input.sprint = moving && gait === 'run' && sp.fleeSprint;
      a.speedScale = gait === 'run' ? sp.fleeScale : gait === 'trot' ? 0.75 : 1;
      const ledge = moving && a.hitWall && this._ledgeAhead(a, getBlock);
      input.jump = shouldPaddle(getBlock, a) || (!a.inWater && ledge);
      input.yaw = a.yaw;
      if (world.pullAt) {
        world.pullAt(a.x, a.y + 0.5, a.z, this._pull);
        input.pullX = this._pull[0];
        input.pullY = this._pull[1];
        input.pullZ = this._pull[2];
      } else {
        input.pullX = 0;
        input.pullY = 0;
        input.pullZ = 0;
      }
      // v0.14 (§76 fauna): a flushed bird is in the air — it flies instead of walking
      if (a.air !== 0) this._steerFlight(a, dt, getBlock, input);
      const x0 = a.x;
      const z0 = a.z;
      stepPlayer(a, input, getBlock, dt);
      settleFloat(getBlock, a, dt);
      a.sneaking = false;
      a.sprinting = false;
      if (a.hitWall) a.wallSinceAim = true;
      if (a.air !== 0) {
        a.walkPhase = (a.walkPhase + dt * WING_BEAT) % TWO_PI; // the wings beat
        if (!a.flying) a.air = 0; // it touched down (stepPlayer ends a flight on landing)
      } else {
        this._stride(a, x0, z0, dt);
      }
      // v0.14: a hen left in peace lays a nest now and then (§88: a grown one)
      if (sp.nests && !a.tamed && !(a.size < 1)) {
        a.nestIn -= dt;
        if (a.nestIn <= 0) {
          const laid = this._layNest(a, world, player, ev);
          a.nestIn = laid ? NEST_EVERY_S[0] + this._rng() * (NEST_EVERY_S[1] - NEST_EVERY_S[0]) : NEST_RETRY_S;
        }
      }

      // A snare underfoot catches a wild animal (not a bear: it is too strong for a noose of cord).
      if (!a.tamed && a.immune <= 0 && sp.snare !== false) {
        const [q, r] = worldToHex(a.x, a.z);
        const y = Math.floor(a.y + 0.05);
        const id = getBlock(q, y, r);
        if (id === BLOCK.SNARE || id === BLOCK.SNARE_BAITED) {
          a.trapped = TRAP_HOLD_S;
          a.trapT = 0;
          a.trapCell = [q, y, r];
          a.mode = 'idle';
          ev.caught.push({ animal: a, cell: [q, y, r] });
        }
      }
    }
    return this._reported(ev);
  }

  /** Remember how much of the carried event lists this update reports (see update). @param {AnimalEvents} ev */
  _reported(ev) {
    this._seen.freed = ev.freed.length;
    this._seen.flushed = ev.flushed.length;
    this._seen.charged = ev.charged.length;
    return ev;
  }

  /** The legs: walkPhase advances with the distance walked and settles straight when standing. */
  _stride(a, x0, z0, dt) {
    const stride = Math.hypot(a.x - x0, a.z - z0);
    a.walkPhase = (a.walkPhase + stride * (STRIDE_RATE[a.kind] ?? 3.6)) % TWO_PI;
    if (stride < 0.2 * dt) {
      const straight = Math.round(a.walkPhase / Math.PI) * Math.PI;
      a.walkPhase += (straight - a.walkPhase) * (1 - Math.exp(-10 * dt));
    }
  }

  /** A snare lets go: the animal runs (when it broke free by itself) and cannot be caught for TRAP_IMMUNE_S. */
  _release(a, escaped) {
    if (a.trapCell) this.events.freed.push({ cell: a.trapCell, escaped });
    a.trapCell = null;
    a.trapped = 0;
    a.immune = TRAP_IMMUNE_S;
    if (!a.tamed) {
      a.mode = 'flee';
      a.timer = HIT_FLEE_S;
      a.targetYaw = wrapAngle(a.yaw + Math.PI * (0.5 + this._rng()));
    }
  }

  /**
   * AI. @returns {'stand'|'amble'|'trot'|'walk'|'run'} how it moves this frame
   * @param {Animal} a @param {number} dt @param {AnimalWorld} world @param {PlayerState|null} player @param {AnimalEvents} ev
   */
  _think(a, dt, world, player, ev) {
    const getBlock = world.getBlock;
    a.timer -= dt;
    if (a.inWater) return this._swim(a, getBlock);
    if (a.tamed) return a.kind === 'wolf' ? this._tameWolf(a, dt, world, player, ev) : this._kept(a, world, player);

    // v0.14 (§76 fauna): in the air a bird holds the line it took when it flushed.
    if (a.air !== 0) return 'run';
    const p = player && !player.flying ? player : null;
    const d = p ? Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z) : Infinity;
    const sp = /** @type {*} */ (SPECIES[a.kind]);
    // v0.14: the bear does not run from the player — it warns, and charges.
    if (sp.predator) return this._bear(a, dt, getBlock, p, d, ev);
    const lured = p !== null && !p.sprinting && typeof world.heldKey === 'string' && sp.lure.includes(world.heldKey);

    // Running: until the player is far enough (and any hit's time is up).
    if (a.mode === 'flee') {
      const calmAt = sp.notice * (sp.calm ?? CALM_FACTOR); // v0.14: deer bolt farther than the rest
      const far = d > calmAt;
      if ((far && a.timer <= 0) || (lured && a.timer <= 0 && d > LURE_STOP)) {
        a.mode = 'idle';
        a.timer = 1 + this._rng() * 2;
      } else {
        if (sp.zigzag) {
          // v0.14: a rabbit swerves from side to side as it runs
          a.zigIn -= dt;
          if (a.zigIn <= 0) {
            a.side = a.side > 0 ? -1 : 1;
            a.zigIn = ZIG_S[0] + this._rng() * (ZIG_S[1] - ZIG_S[0]);
          }
        }
        if (p && d < calmAt) this._aimAway(a, p.x, p.z);
        this._steerSafe(a, getBlock);
        return 'run';
      }
    }
    // The player comes too near: run (unless it is fed, lured, or the player holds its food).
    if (p && a.calm <= 0 && !lured && d < noticeRange(a, p)) {
      this._startle(a, p.x, p.z, ev);
      return 'run';
    }
    // Lured: it comes up to the food in the player's hand.
    if (lured && d <= LURE_RANGE) {
      a.mode = 'lure';
      a.targetYaw = yawToward(a.x, a.z, /** @type {PlayerState} */ (p).x, /** @type {PlayerState} */ (p).z);
      if (d <= LURE_STOP) return 'stand';
      return a.onGround && !this._safeAhead(a, getBlock) ? 'stand' : 'trot';
    }
    if (a.mode === 'lure') {
      a.mode = 'idle';
      a.timer = 1;
    }
    // A baited snare nearby: it wanders over.
    a.baitIn -= dt;
    if (a.baitIn <= 0 && sp.snare !== false) {
      a.baitIn = BAIT_CHECK_S;
      this._findBait(a, getBlock);
    }
    if (Number.isFinite(a.baitX) && a.immune <= 0) {
      a.mode = 'bait';
      a.targetYaw = yawToward(a.x, a.z, a.baitX, a.baitZ);
      return a.onGround && !this._safeAhead(a, getBlock) ? 'stand' : 'amble';
    }
    if (a.mode === 'bait') {
      a.mode = 'idle';
      a.timer = 1;
    }
    return this._wander(a, getBlock);
  }

  /**
   * idle ↔ wander, like a pig; a walker stops at an edge, water, a wall or a fire. §88: a young one keeps by its mother
   * (the nearest grown female of its kind): it heads for her whenever it is more than YOUNG_KEEP away.
   * @returns {'stand'|'amble'}
   */
  _wander(a, getBlock) {
    if (a.size < 1 && !a.tamed) {
      const mother = this._nearestKin(a, true);
      if (mother && Math.hypot(mother.x - a.x, mother.z - a.z) > YOUNG_KEEP) {
        a.mode = 'walk';
        a.timer = Math.max(a.timer, 0.5);
        a.targetYaw = yawToward(a.x, a.z, mother.x, mother.z);
      }
    }
    if (a.timer <= 0) {
      if (a.mode === 'idle') {
        a.mode = 'walk';
        a.targetYaw = wrapAngle(a.yaw + (this._rng() * 2 - 1) * Math.PI);
        // The herd keeps together: half the time it heads for the nearest of its kind that has drifted away.
        const mate = this._nearestKin(a);
        if (mate && this._rng() < 0.5 && Math.hypot(mate.x - a.x, mate.z - a.z) > 5) a.targetYaw = yawToward(a.x, a.z, mate.x, mate.z);
        a.timer = 1.5 + this._rng() * 4;
      } else {
        a.mode = 'idle';
        a.timer = 2 + this._rng() * 6;
      }
    }
    if (a.mode !== 'walk') return 'stand';
    if (a.onGround && !this._safeAhead(a, getBlock)) {
      a.mode = 'idle';
      a.timer = 0.5 + this._rng();
      a.targetYaw = wrapAngle(a.yaw + Math.PI * (0.5 + this._rng()));
      return 'stand';
    }
    return 'amble';
  }

  /** Swimming: head for the nearest bank it can climb, like a pig. */
  _swim(a, getBlock) {
    const due = a.mode !== 'walk' || a.timer <= 0 || a.timer > SWIM_REAIM_S;
    a.mode = 'walk';
    if (due) {
      a.timer = SWIM_REAIM_S;
      const shore = shoreYaw(getBlock, a.x, a.y, a.z);
      if (shore !== null) a.targetYaw = shore;
      else if (a.wallSinceAim) a.targetYaw = wrapAngle(a.yaw + (this._rng() * 2 - 1) * Math.PI * 0.75);
      a.wallSinceAim = false;
    }
    return 'walk';
  }

  /**
   * §88: a tame animal that is not a wolf (a horse, cattle, sheep): it follows the food it likes in the player's hand
   * (the lure: up to LURE_STOP, and where it ends up is its new home — the way into a pen), else it grazes within
   * HOME_RANGE of home (_tameHorse). It never runs.
   * @param {Animal} a @param {AnimalWorld} world @param {PlayerState|null} player
   * @returns {'stand'|'amble'|'trot'|'walk'|'run'}
   */
  _kept(a, world, player) {
    const p = player && !player.flying ? player : null;
    const sp = SPECIES[a.kind];
    const lured = p !== null && !p.sprinting && typeof world.heldKey === 'string' && sp.lure.includes(world.heldKey)
      && Math.hypot(p.x - a.x, p.z - a.z) <= LURE_RANGE;
    if (lured) {
      a.mode = 'lure';
      a.targetYaw = yawToward(a.x, a.z, /** @type {PlayerState} */ (p).x, /** @type {PlayerState} */ (p).z);
      a.homeX = a.x;
      a.homeZ = a.z;
      if (Math.hypot(/** @type {PlayerState} */ (p).x - a.x, /** @type {PlayerState} */ (p).z - a.z) <= LURE_STOP) return 'stand';
      return a.onGround && !this._safeAhead(a, world.getBlock) ? 'stand' : 'trot';
    }
    if (a.mode === 'lure') {
      a.mode = 'idle';
      a.timer = 1;
    }
    return this._tameHorse(a, world.getBlock);
  }

  /**
   * A tame horse (§88: any kept animal) left alone: it grazes within HOME_RANGE of where it was left.
   * @returns {'stand'|'amble'}
   */
  _tameHorse(a, getBlock) {
    const dh = Math.hypot(a.homeX - a.x, a.homeZ - a.z);
    if (dh > HOME_RANGE) {
      a.mode = 'walk';
      a.timer = 1;
      a.targetYaw = yawToward(a.x, a.z, a.homeX, a.homeZ);
      return a.onGround && !this._safeAhead(a, getBlock) ? 'stand' : 'amble';
    }
    return this._wander(a, getBlock);
  }

  /**
   * A tame wolf: sits where told; else goes for a zombie near it, or keeps by the player.
   * @returns {'stand'|'amble'|'trot'|'walk'|'run'}
   */
  _tameWolf(a, dt, world, player, ev) {
    const getBlock = world.getBlock;
    if (a.sitting || !player) {
      a.mode = 'idle';
      return 'stand';
    }
    const dp = Math.hypot(player.x - a.x, player.z - a.z);
    if (dp > FOLLOW_TELEPORT) {
      // Left behind: it turns up beside the player, where there is room.
      const [q, r] = worldToHex(player.x + 1.2 * a.side, player.z);
      const [x, z] = hexToWorld(q, r);
      const fy = findFreeY(getBlock, x, z, Math.max(0, Math.floor(player.y)), 2, a.radius, a.height);
      if (fy !== null) {
        a.x = x;
        a.y = fy;
        a.z = z;
        a.vx = a.vy = a.vz = 0;
      }
      return 'stand';
    }
    // A zombie near: go for it.
    let target = null;
    let best = WOLF_GUARD;
    for (const t of world.threats ?? []) {
      const d = Math.hypot(t.x - a.x, t.y - a.y, t.z - a.z);
      if (d < best && Math.hypot(t.x - player.x, t.z - player.z) < WOLF_GUARD * 2) {
        best = d;
        target = t;
      }
    }
    if (target) {
      a.mode = 'hunt';
      a.targetYaw = yawToward(a.x, a.z, target.x, target.z);
      if (best <= WOLF_BITE_REACH) {
        if (a.biteIn <= 0) {
          a.biteIn = WOLF_BITE_S;
          ev.bites.push({ wolf: a, target });
        }
        return 'stand';
      }
      return a.onGround && !this._safeAhead(a, getBlock) ? 'stand' : 'run';
    }
    if (dp > FOLLOW_NEAR) {
      a.mode = 'follow';
      a.targetYaw = yawToward(a.x, a.z, player.x, player.z);
      if (a.onGround && !this._safeAhead(a, getBlock)) return 'stand';
      return dp > FOLLOW_RUN ? 'run' : 'walk';
    }
    a.mode = 'idle';
    a.targetYaw = yawToward(a.x, a.z, player.x, player.z);
    return 'stand';
  }

  /** It notices the player and runs; the herd within HERD_ALARM runs with it. */
  _startle(a, fromX, fromZ, ev, seconds = 0) {
    const sp = /** @type {*} */ (SPECIES[a.kind]);
    const alarm = sp.alarm ?? HERD_ALARM;
    for (const o of this.list) {
      if (o.kind !== a.kind || o.tamed || o.trapped > 0 || o.ridden) continue;
      if (o !== a && Math.hypot(o.x - a.x, o.z - a.z) > alarm) continue;
      const left = o.mode === 'flee' ? Math.max(0, o.timer) : 0;
      if (o.mode !== 'flee' && ev) ev.startled.push(o);
      o.mode = 'flee';
      o.timer = Math.max(left, seconds, 1);
      o.calm = 0;
      this._aimAway(o, fromX, fromZ);
      // v0.14 (§76 fauna): a spooked bird on the ground takes to the air — a pheasant flies off, a turkey glides a
      // little way and runs on. (Queued on this.events: a blow between two updates flushes a bird too.)
      if (sp.flush && o.air === 0 && !o.inWater) {
        o.air = sp.flush === 'fly' ? FLUSH_S[0] + this._rng() * (FLUSH_S[1] - FLUSH_S[0]) : TURKEY_GLIDE_S;
        this.events.flushed.push(o);
      }
    }
  }

  /** Head straight away from (x, z), a little to its own side so a herd fans out (a rabbit: ZIG_ANGLE to its side). */
  _aimAway(a, x, z) {
    const off = /** @type {*} */ (SPECIES[a.kind]).zigzag ? ZIG_ANGLE : 0.25;
    a.targetYaw = wrapAngle(yawToward(a.x, a.z, x, z) + Math.PI + a.side * off);
  }

  // ---- v0.14 (§76 fauna): flight, nests, the bear, fish -------------------------------------------------------------

  /**
   * One frame of a flushed bird's flight, written into `input` before stepPlayer: the body flies (physics `flying`: no
   * gravity, config.FLY_SPEED along its yaw) and its height is steered through the vertical pull — toward its species'
   * `cruise` height over whatever lies below while `air` lasts, then down until it lands (stepPlayer ends the flight
   * when it touches the ground). A wall or a trunk ahead is climbed over; water ends the flight (it swims ashore).
   * It bursts UP first: it only flies forward once it has turned to its line (a bird that faced the player when it was
   * spooked rises on the spot and wheels round, instead of flying at them).
   */
  _steerFlight(a, dt, getBlock, input) {
    if (a.inWater) {
      a.flying = false;
      a.air = 0;
      return;
    }
    const sp = /** @type {*} */ (SPECIES[a.kind]);
    a.air -= dt;
    if (a.air === 0) a.air = -1e-6; // 0 means "on the ground": keep it flying until it lands
    a.flying = true;
    input.forward = Math.abs(wrapAngle(a.targetYaw - a.yaw)) < 1.2 ? 1 : 0;
    input.sneak = false;
    input.sprint = false;
    input.jump = false;
    const under = this._under;
    const ground = groundBelow(getBlock, a.x, a.y, a.z, under);
    let vy;
    if (a.hitWall) vy = FLUSH_CLIMB;
    else if (a.air > 0 || (under.water && a.air > -FLUSH_OVER_WATER_S)) vy = Math.max(-FLUSH_SINK, Math.min(FLUSH_CLIMB, (ground + sp.cruise - a.y) * 4));
    else vy = -FLUSH_SINK;
    // physics turns a flying body's pull into a target speed of pull / GROUND_ACCEL
    input.pullY += vy * GROUND_ACCEL;
  }

  /**
   * A hen's try at a nest: only a calm bird on the ground, in an empty cell with solid ground under it, with nobody
   * within NEST_PRIVACY. An empty nest within NEST_SPACING cells is laid in again; a full one that near means no new nest.
   * @returns {boolean} it laid (the cell is queued in `ev.laid`; main writes the block)
   */
  _layNest(a, world, player, ev) {
    if (a.air !== 0 || a.trapped > 0 || !a.onGround || a.inWater || (a.mode !== 'idle' && a.mode !== 'walk')) return false;
    if (player && Math.hypot(player.x - a.x, player.z - a.z) < NEST_PRIVACY) return false;
    const getBlock = world.getBlock;
    const [q0, r0] = worldToHex(a.x, a.z);
    const y0 = Math.floor(a.y + 0.05);
    /** @type {[number, number, number]|null} */
    let empty = null;
    for (let dq = -NEST_SPACING; dq <= NEST_SPACING; dq++) {
      for (let dr = Math.max(-NEST_SPACING, -dq - NEST_SPACING); dr <= Math.min(NEST_SPACING, -dq + NEST_SPACING); dr++) {
        for (let dy = -1; dy <= 1; dy++) {
          const id = getBlock(q0 + dq, y0 + dy, r0 + dr);
          if (id === BLOCK.GROUND_NEST) return false;
          if (id === BLOCK.GROUND_NEST_EMPTY && !empty) empty = [q0 + dq, y0 + dy, r0 + dr];
        }
      }
    }
    if (empty) {
      ev.laid.push({ cell: empty, refill: true });
      return true;
    }
    if (getBlock(q0, y0, r0) !== BLOCK.AIR || !isSolid(getBlock(q0, y0 - 1, r0))) return false;
    ev.laid.push({ cell: [q0, y0, r0], refill: false });
    return true;
  }

  /**
   * The bear's mind (see the BEAR_* constants): wander → warn (rear up, growl) → charge → give up and rest.
   * @param {Animal} a @param {number} dt @param {GetBlockFn} getBlock @param {PlayerState|null} p the player on foot
   * @param {number} d the distance to them @param {AnimalEvents} ev
   * @returns {'stand'|'amble'|'run'}
   */
  _bear(a, dt, getBlock, p, d, ev) {
    if (a.mode === 'charge') {
      a.chase -= dt;
      if (!p || a.chase <= 0 || d > BEAR_GIVE_UP) {
        // It gives up: it turns away and leaves the player alone for a while.
        a.mode = 'idle';
        a.timer = 1.5 + this._rng() * 2;
        a.rest = BEAR_REST_S;
        a.chase = 0;
        return 'stand';
      }
      a.targetYaw = yawToward(a.x, a.z, p.x, p.z);
      if (this._inReach(a, p, getBlock)) {
        if (a.maulIn <= 0) this._maul(a, p, ev);
        return 'stand';
      }
      // it has just mauled: it gathers itself before it comes on again (the moment to run)
      if (a.maulIn > BEAR_MAUL_S - BEAR_RECOVER_S) return 'stand';
      return a.onGround && !this._safeAhead(a, getBlock) ? 'stand' : 'run';
    }
    if (!p || a.rest > 0) {
      if (a.mode === 'warn') {
        a.mode = 'idle';
        a.timer = 1;
      }
      return this._wander(a, getBlock);
    }
    const range = bearRange(a, p);
    if (a.mode === 'warn') {
      a.warn += dt;
      a.targetYaw = yawToward(a.x, a.z, p.x, p.z);
      if (d < BEAR_CHARGE_DIST) {
        this._provoke(a);
      } else if (a.warn >= BEAR_WARN_S) {
        // The warning is over: a player who has backed away is left alone; one who has not is charged.
        if (d < range * BEAR_BACK_OFF) {
          this._provoke(a);
        } else {
          a.mode = 'idle';
          a.timer = 1 + this._rng() * 2;
        }
      }
      return 'stand';
    }
    if (d < range) {
      a.mode = 'warn';
      a.warn = 0;
      a.targetYaw = yawToward(a.x, a.z, p.x, p.z);
      ev.warned.push(a);
      return 'stand';
    }
    return this._wander(a, getBlock);
  }

  /** The bear charges (queued on this.events: a blow between two updates provokes it too). A blow starts the chase again. */
  _provoke(a) {
    if (a.mode !== 'charge') this.events.charged.push(a);
    a.mode = 'charge';
    a.chase = BEAR_CHASE_S;
    a.rest = 0;
    a.warn = 0;
  }

  /** The player is within the bear's reach: BEAR_REACH away, at its height, with no wall between them. */
  _inReach(a, p, getBlock) {
    const dx = p.x - a.x;
    const dz = p.z - a.z;
    if (dx * dx + dz * dz > BEAR_REACH * BEAR_REACH) return false;
    if (!(a.y < p.y + (p.height ?? PLAYER_HEIGHT) && p.y < a.y + a.height + 0.3)) return false;
    const cy = Math.floor((a.y + p.y) / 2 + 1);
    for (let k = 1; k <= 2; k++) {
      const [q, r] = worldToHex(a.x + (dx * k) / 3, a.z + (dz * k) / 3);
      if (isSolid(getBlock(q, cy, r))) return false;
    }
    return true;
  }

  /** The maul: the player is thrown BEAR_PUSH away and BEAR_LIFT up (main takes BEAR_DAMAGE health for `ev.mauls`). */
  _maul(a, p, ev) {
    let dx = p.x - a.x;
    let dz = p.z - a.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) [dx, dz] = yawToForward(a.yaw);
    else {
      dx /= d;
      dz /= d;
    }
    p.vx = dx * BEAR_PUSH;
    p.vz = dz * BEAR_PUSH;
    p.vy = Math.max(p.vy, BEAR_LIFT);
    p.onGround = false;
    a.maulIn = BEAR_MAUL_S;
    a.swipe = BEAR_SWIPE_S;
    ev.mauls.push(a);
  }

  /**
   * One frame of a fish. It keeps to the water: it only ever moves to a point where fishDepth is a number, turning
   * aside (or holding still, cornered) where the water ends. @returns {boolean} false when its own cell has no water
   * left for it (it is gone)
   */
  _fish(a, dt, world, player, ev) {
    const getBlock = world.getBlock;
    const sp = SPECIES[a.kind];
    const [q, r] = worldToHex(a.x, a.z);
    const depth = fishDepth(getBlock, q, r, a.y + a.height / 2);
    if (Number.isNaN(depth)) return false;
    a.y += (depth - a.y) * (1 - Math.exp(-8 * dt)); // a stream steps down: it eases to the new level
    a.vy = 0;
    a.inWater = true;
    a.onGround = false;
    a.timer -= dt;
    const p = player && !player.flying ? player : null;
    const d = p ? Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z) : Infinity;
    let speed = 0;
    if (a.mode === 'flee' && a.timer <= 0) {
      // The dart is over: it holds still, wary, before it can dart again.
      a.mode = 'idle';
      a.timer = FISH_REST_S + this._rng();
      a.calm = FISH_REST_S;
    }
    if (a.mode !== 'flee' && p && a.calm <= 0 && d < noticeRange(a, p)) this._startle(a, p.x, p.z, ev, FISH_DART_S);
    if (a.mode === 'flee') {
      speed = FISH_DART;
    } else {
      if (a.timer <= 0) {
        if (a.mode === 'idle') {
          a.mode = 'walk';
          a.targetYaw = wrapAngle(a.yaw + (this._rng() * 2 - 1) * Math.PI);
          const mate = this._nearestKin(a); // the school keeps together
          if (mate && this._rng() < 0.6 && Math.hypot(mate.x - a.x, mate.z - a.z) > 2) a.targetYaw = yawToward(a.x, a.z, mate.x, mate.z);
          a.timer = 1 + this._rng() * 3;
        } else {
          a.mode = 'idle';
          a.timer = 1 + this._rng() * 3;
        }
      }
      if (a.mode === 'walk') speed = FISH_CRUISE;
    }
    if (speed > 0 && !this._fishWay(a, a.targetYaw, getBlock)) {
      // Water ends that way: swing to the nearest heading that stays in it, or hold still.
      let found = false;
      for (const turn of [0.6, -0.6, 1.2, -1.2, 1.9, -1.9, 2.6, -2.6, Math.PI]) {
        const yaw = wrapAngle(a.targetYaw + turn * a.side);
        if (this._fishWay(a, yaw, getBlock)) {
          a.targetYaw = yaw;
          found = true;
          break;
        }
      }
      if (!found) speed = 0;
    }
    const dYaw = wrapAngle(a.targetYaw - a.yaw);
    const maxTurn = sp.turn * dt;
    a.yaw = wrapAngle(a.yaw + Math.max(-maxTurn, Math.min(maxTurn, dYaw)));
    let moved = 0;
    if (speed > 0 && Math.abs(wrapAngle(a.targetYaw - a.yaw)) < 1.2 && this._fishWay(a, a.yaw, getBlock)) {
      const [fx, fz] = yawToForward(a.yaw);
      a.x += fx * speed * dt;
      a.z += fz * speed * dt;
      moved = speed;
    }
    a.vx = 0;
    a.vz = 0;
    a.walkPhase = (a.walkPhase + dt * (3 + moved * 4)) % TWO_PI; // the tail beats, faster when it darts
    return true;
  }

  /** There is water for a fish a body's length ahead of `a` along `yaw` (and so along the whole step it takes). */
  _fishWay(a, yaw, getBlock) {
    const [fx, fz] = yawToForward(yaw);
    const lead = a.radius + 0.22;
    const [q, r] = worldToHex(a.x + fx * lead, a.z + fz * lead);
    return !Number.isNaN(fishDepth(getBlock, q, r, a.y + a.height / 2));
  }

  /**
   * Where a fish may be put in column (q, r): its swim height in the water lying on the generated ground, or NaN (§88:
   * where a zone's fish wake, populations.js). @param {{ getBlock: GetBlockFn, groundHeight: (q: number, r: number) => number }} world
   */
  fishSpotAt(world, q, r) {
    const h = world.groundHeight(q, r);
    if (!(h >= 0)) return NaN;
    const getBlock = world.getBlock;
    // the stream's water lies in the bed: on the generated height or a cell or two under it
    for (let y = h + 1; y >= h - 3; y--) {
      if (isLiquid(getBlock(q, y, r))) return fishDepth(getBlock, q, r, y);
    }
    return NaN;
  }

  /** Running at an edge, water, a wall or a fire: swing to the clearer side instead of stopping. */
  _steerSafe(a, getBlock) {
    if (!a.onGround || this._safeAt(a, a.targetYaw, getBlock)) return;
    for (const turn of [0.7, -0.7, 1.4, -1.4, 2.2, -2.2]) {
      const yaw = wrapAngle(a.targetYaw + turn * a.side);
      if (this._safeAt(a, yaw, getBlock)) {
        a.targetYaw = yaw;
        return;
      }
    }
  }

  /** The nearest other animal of its kind (§88 `mother`: the nearest grown female), or null. */
  _nearestKin(a, mother = false) {
    let best = null;
    let bd = Infinity;
    for (const o of this.list) {
      if (o === a || o.kind !== a.kind) continue;
      if (mother && (o.sex !== 'f' || o.size < 1)) continue;
      const d = Math.hypot(o.x - a.x, o.z - a.z);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  /** Look for the nearest baited snare within BAIT_RANGE cells (feet level ±1); remember its centre, or forget. */
  _findBait(a, getBlock) {
    a.baitX = NaN;
    a.baitZ = NaN;
    const [q0, r0] = worldToHex(a.x, a.z);
    const y0 = Math.floor(a.y + 0.05);
    let bd = Infinity;
    for (let dq = -BAIT_RANGE; dq <= BAIT_RANGE; dq++) {
      for (let dr = Math.max(-BAIT_RANGE, -dq - BAIT_RANGE); dr <= Math.min(BAIT_RANGE, -dq + BAIT_RANGE); dr++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (getBlock(q0 + dq, y0 + dy, r0 + dr) !== BLOCK.SNARE_BAITED) continue;
          const [x, z] = hexToWorld(q0 + dq, r0 + dr);
          const d = Math.hypot(x - a.x, z - a.z);
          if (d < bd) {
            bd = d;
            a.baitX = x;
            a.baitZ = z;
          }
        }
      }
    }
  }

  /** @returns {[number, number, number]} the cell 0.8 ahead along `yaw`, and the feet level */
  _aheadCell(a, yaw = a.yaw) {
    const [fx, fz] = yawToForward(yaw);
    const [q, r] = worldToHex(a.x + fx * (a.radius + 0.5), a.z + fz * (a.radius + 0.5));
    return [q, r, Math.floor(a.y + 0.01)];
  }

  /** The way along `yaw` is no water to swim in, no fire, has ground within two cells below, and no wall but a hop. */
  _safeAt(a, yaw, getBlock) {
    const [q, r, fy] = this._aheadCell(a, yaw);
    if (isSwimWater(getBlock, q, fy, r)) return false;
    if (this._fires && fireAhead(getBlock, a.x, a.z, yaw, fy)) return false;
    if (isSolid(getBlock(q, fy, r))) return isOpen(getBlock(q, fy + 1, r)) && isOpen(getBlock(q, fy + 2, r));
    return isSolid(getBlock(q, fy - 1, r)) || isSolid(getBlock(q, fy - 2, r));
  }

  _safeAhead(a, getBlock) {
    return this._safeAt(a, a.yaw, getBlock);
  }

  /** A one-cell ledge straight ahead with room on top. */
  _ledgeAhead(a, getBlock) {
    const [q, r, fy] = this._aheadCell(a);
    return isSolid(getBlock(q, fy, r)) && isOpen(getBlock(q, fy + 1, r));
  }

  /** A block placed into it: lift it to the first free height within three cells. */
  _unstick(a, getBlock) {
    if (isFreeAt(getBlock, a.x, a.y, a.z, a.radius, a.height)) return;
    const fy = findFreeY(getBlock, a.x, a.z, Math.floor(a.y) + 1, 3, a.radius, a.height);
    if (fy !== null) {
      a.y = fy;
      a.vy = 0;
    }
  }

  /**
   * A blow of `power` from (fromX, fromZ): ignored (null) while it still flashes; else health −= power. At 0 it is removed
   * ('dead'); else it is knocked back, flashes, and it and its herd run ('hit'). A snared animal takes the blow in place.
   * @returns {'hit'|'dead'|null}
   */
  wound(a, power, fromX, fromZ) {
    if (a.hurt > 0 || !this.list.includes(a)) return null;
    const p = typeof power === 'number' && power > 0 && Number.isFinite(power) ? power : 0;
    a.health -= p;
    if (a.health <= 0) {
      this.remove(a);
      return 'dead';
    }
    a.hurt = ANIMAL_HURT_S;
    const sp = /** @type {*} */ (SPECIES[a.kind]);
    if (sp.water) {
      // v0.14 (§76 fauna): a fish is not knocked about (it stays in its water); it and its school dart off
      this._startle(a, fromX, fromZ, null, FISH_DART_S);
      return 'hit';
    }
    if (!(a.trapped > 0) && !a.ridden) {
      let dx = a.x - fromX;
      let dz = a.z - fromZ;
      const d = Math.hypot(dx, dz) || 1;
      dx /= d;
      dz /= d;
      if (sp.predator) {
        // v0.14: a blow barely moves a bear, and it does not run: it charges
        a.vx = dx * ANIMAL_KNOCKBACK * BEAR_KNOCK;
        a.vz = dz * ANIMAL_KNOCKBACK * BEAR_KNOCK;
        this._provoke(a);
        return 'hit';
      }
      a.vx = dx * ANIMAL_KNOCKBACK;
      a.vz = dz * ANIMAL_KNOCKBACK;
      a.vy = Math.max(a.vy, 4);
      a.onGround = false;
      if (!a.tamed) this._startle(a, fromX, fromZ, null, HIT_FLEE_S);
    }
    return 'hit';
  }

  /**
   * Feed it `key` (R with the food in hand, within reach). It calms down for FED_CALM_S and gains trust; at its species'
   * `tame` feeds (horses, wolves and, §88, cattle and sheep) it is tamed. §88: a feed is stamped (`fedAt`, game days):
   * food for breeding for populations.FED_DAYS. @returns {{ ok: boolean, tamed?: boolean, calmed?: boolean }}
   */
  feed(a, key) {
    const sp = SPECIES[a.kind];
    if (!sp.lure.includes(key) || !this.list.includes(a)) return { ok: false };
    a.fedAt = this.now;
    if (a.tamed) {
      a.health = Math.min(sp.health, a.health + 3); // food heals a tame animal
      return { ok: true };
    }
    a.calm = FED_CALM_S;
    if (a.mode === 'flee') {
      a.mode = 'idle';
      a.timer = 1;
    }
    if (sp.tame <= 0) return { ok: true, calmed: true };
    a.trust += 1;
    if (a.trust < sp.tame) return { ok: true, calmed: true };
    a.tamed = true;
    a.calm = 0;
    a.homeX = a.x;
    a.homeZ = a.z;
    if (a.trapped > 0) this._release(a, false);
    return { ok: true, tamed: true };
  }

  /**
   * Milk a cow into an empty clay pot: true when it gave milk (a cow that was milked less than MILK_REGROW_S ago, or
   * anything that is not a cow, gives none).
   */
  milk(a) {
    // §88: a grown cow, not a bull or a calf
    if (a.kind !== 'cow' || a.sex === 'm' || a.size < 1 || a.milked > 0 || !this.list.includes(a)) return false;
    a.milked = MILK_REGROW_S;
    return true;
  }

  /** Shear a sheep that has its fleece: SHEAR_WOOL wool, and it grows back in SHEAR_REGROW_S. @returns {number} wool */
  shear(a) {
    if (a.kind !== 'sheep' || a.size < 1 || a.shorn > 0 || !this.list.includes(a)) return 0; // §88: not a lamb
    a.shorn = SHEAR_REGROW_S;
    return SHEAR_WOOL[0] + Math.floor(this._rng() * (SHEAR_WOOL[1] - SHEAR_WOOL[0] + 1));
  }

  /** Mount a tame horse: it is taller by RIDER_HEIGHT while ridden (it cannot pass where its rider could not). */
  mount(a) {
    if (a.kind !== 'horse' || !a.tamed || a.ridden || a.size < 1 || !this.list.includes(a)) return false; // §88: not a foal
    a.ridden = true;
    a.height = SPECIES.horse.height + RIDER_HEIGHT;
    a.mode = 'idle';
    return true;
  }

  /** Get off: the horse waits around here. */
  dismount(a) {
    if (!a.ridden) return;
    a.ridden = false;
    a.height = SPECIES.horse.height;
    a.homeX = a.x;
    a.homeZ = a.z;
    a.mode = 'idle';
    a.timer = 2;
    a.speedScale = 1;
  }

  /**
   * One step of a ridden horse, driven by the rider's input (forward / strafe / sprint / jump and the look yaw): RIDE_SCALE
   * times the walking or sprinting speed, hopping one-cell ledges by itself and leaping RIDE_LEAP cells on jump.
   * @param {Animal} a
   * @param {{ forward?: number, strafe?: number, sprint?: boolean, jump?: boolean, yaw?: number, pullX?: number, pullY?: number, pullZ?: number }} input
   * @param {GetBlockFn} getBlock
   * @param {number} dt
   */
  ride(a, input, getBlock, dt) {
    if (!a.ridden || !(dt > 0)) return;
    const inp = this._input;
    const fwd = input.forward || 0;
    inp.forward = fwd;
    inp.strafe = (input.strafe || 0) * 0.6;
    inp.sneak = false;
    inp.sprint = !!input.sprint && fwd > 0;
    inp.yaw = input.yaw || 0;
    inp.pullX = input.pullX || 0;
    inp.pullY = input.pullY || 0;
    inp.pullZ = input.pullZ || 0;
    a.yaw = wrapAngle(inp.yaw);
    a.targetYaw = a.yaw;
    a.speedScale = RIDE_SCALE;
    const ledge = fwd > 0 && a.hitWall && this._ledgeAhead(a, getBlock);
    inp.jump = a.inWater || ledge;
    if (input.jump && a.onGround && !a.inWater) {
      a.vy = Math.sqrt(2 * -GRAVITY * RIDE_LEAP);
      a.onGround = false;
    }
    const x0 = a.x;
    const z0 = a.z;
    stepPlayer(a, inp, getBlock, dt);
    a.sneaking = false;
    a.sprinting = false;
    this._stride(a, x0, z0, dt);
  }

  /**
   * Nearest animal whose body cylinder the ray (origin o, unit direction d) enters within maxDist.
   * @returns {{ animal: Animal, distance: number }|null}
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = null;
    let bestT = maxDist;
    for (const a of this.list) {
      if (a.ridden) continue;
      // v0.14: a species' `pad` widens its target all round (a small fish under water would else be a pixel to aim at)
      const pad = /** @type {*} */ (SPECIES[a.kind]).pad ?? 0;
      const t = rayCylinder(ox, oy, oz, dx, dy, dz, a.x, a.y - pad, a.z, a.radius + 0.06 + pad, a.height + 2 * pad);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = a;
      }
    }
    return best ? { animal: best, distance: bestT } : null;
  }

  /** The feet y an animal may appear at in column (q, r): loaded, natural ground, two open cells above, room. Else null. */
  spawnHeightAt(world, q, r, sp) {
    if (!world.isLoadedCell || !world.groundHeight || !world.isNaturalGround) return null;
    if (!world.isLoadedCell(q, r)) return null;
    const h = world.groundHeight(q, r);
    if (!(h >= 0) || !world.isNaturalGround(q, h, r)) return null;
    const getBlock = world.getBlock;
    if (getBlock(q, h, r) !== BLOCK.GRASS_BLOCK && getBlock(q, h, r) !== BLOCK.SNOWY_GRASS) return null;
    if (getBlock(q, h + 1, r) !== BLOCK.AIR || getBlock(q, h + 2, r) !== BLOCK.AIR) return null;
    const [x, z] = hexToWorld(q, r);
    return isFreeAt(getBlock, x, h + 1, z, sp.radius, sp.height) ? h + 1 : null;
  }

  /** For the save: every animal (ridden ones as standing). */
  export() {
    return this.list.map((a) => {
      /** @type {*} */
      const o = { k: a.kind, x: round2(a.x), y: round2(a.y), z: round2(a.z), yaw: round2(a.yaw), h: round2(a.health) };
      if (a.tamed) o.t = 1;
      else if (a.trust > 0) o.tr = a.trust;
      if (a.shorn > 0) o.s = Math.ceil(a.shorn);
      if (a.milked > 0) o.m = Math.ceil(a.milked);
      if (a.sitting) o.sit = 1;
      if (a.trapped > 0 && a.trapCell) {
        o.tp = Math.ceil(a.trapped);
        o.tc = [a.trapCell[0], a.trapCell[1], a.trapCell[2]];
      }
      if (a.kind === 'deer' && a.sex === 'm') o.v = 1; // v0.14: a stag stays a stag (§88: a male deer)
      return o;
    });
  }

  /** Put saved animals back (validateAnimalsJSON's form). */
  load(list) {
    this.clear();
    this.events.freed.length = 0;
    this.events.flushed.length = 0;
    this.events.charged.length = 0;
    this._reported(this.events);
    const { animals } = validateAnimalsJSON(list);
    for (const o of animals) {
      const a = this.spawn(/** @type {AnimalKind} */ (o.k), o.x, o.y, o.z, o.yaw, o.v === 1 ? 'm' : 'f');
      if (!a) break;
      a.health = o.h;
      a.tamed = o.t === 1;
      a.trust = o.tr ?? 0;
      a.shorn = o.s ?? 0;
      a.milked = o.m ?? 0;
      a.sitting = o.sit === 1;
      if (o.tp && o.tc) {
        a.trapped = o.tp;
        a.trapT = 1;
        a.trapCell = [o.tc[0], o.tc[1], o.tc[2]];
      }
    }
  }
}

/** @param {number} v */
function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * The `animals` save field in canonical form: `[{ k, x, y, z, yaw, h, t?, tr?, s?, sit?, tp?, tc?, v? }]`, at most
 * ANIMAL_MAX; bad entries are dropped with a warning. v0.14 (§76 fauna): the new kinds are entries like any other, `v: 1`
 * marks a stag, and a save from before (four kinds, at most 24) reads exactly as it did. What a bird, a bear or a fish
 * was doing (flying, charging, darting) is not saved: it starts calm. §88: no longer written (the `fauna` field holds
 * every animal); an older save's list is read with these rules and its animals go into their zones. Cattle and sheep may
 * be tame (`t: 1`) since §88.
 * @param {*} raw
 * @returns {{ animals: *[], warnings: string[] }}
 */
export function validateAnimalsJSON(raw) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {*[]} */
  const animals = [];
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) warnings.push('animals: not a list, ignored');
    return { animals, warnings };
  }
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  for (let i = 0; i < raw.length; i++) {
    const o = raw[i];
    const ok = o && typeof o === 'object' && isAnimalKind(o.k) && fin(o.x) && fin(o.y) && fin(o.z);
    if (!ok) {
      warnings.push(`animals[${i}]: invalid, dropped`);
      continue;
    }
    if (animals.length >= ANIMAL_MAX) {
      warnings.push(`animals: more than ${ANIMAL_MAX}, the rest dropped`);
      break;
    }
    const sp = SPECIES[/** @type {AnimalKind} */ (o.k)];
    /** @type {*} */
    const e = { k: o.k, x: round2(o.x), y: round2(o.y), z: round2(o.z), yaw: fin(o.yaw) ? round2(o.yaw) : 0 };
    e.h = fin(o.h) && o.h > 0 ? Math.min(sp.health, round2(o.h)) : sp.health;
    if (o.t === 1 && sp.tame > 0) e.t = 1;
    else if (Number.isInteger(o.tr) && o.tr > 0 && o.tr < sp.tame) e.tr = o.tr;
    if (Number.isInteger(o.s) && o.s > 0 && o.k === 'sheep') e.s = Math.min(SHEAR_REGROW_S, o.s);
    if (Number.isInteger(o.m) && o.m > 0 && o.k === 'cow') e.m = Math.min(MILK_REGROW_S, o.m);
    if (o.sit === 1 && e.t === 1 && o.k === 'wolf') e.sit = 1;
    if (Number.isInteger(o.tp) && o.tp > 0 && Array.isArray(o.tc) && o.tc.length === 3 && o.tc.every(Number.isSafeInteger)) {
      e.tp = Math.min(TRAP_HOLD_S, o.tp);
      e.tc = [o.tc[0], o.tc[1], o.tc[2]];
    }
    if (o.v === 1 && o.k === 'deer') e.v = 1;
    animals.push(e);
  }
  return { animals, warnings };
}

/** The top speed an animal of `kind` runs at (m/s), for the handbook and the tests. */
export function fleeSpeed(kind) {
  const sp = SPECIES[kind];
  return sp.fleeScale * (sp.fleeSprint ? SPRINT_SPEED : WALK_SPEED);
}
