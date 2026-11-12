// Unit tests for src/cooking.js — the seven fire spots of a campfire and the fuel of Survival-placed fires
// (docs/DESIGN-survival.md §4.4, §9.6, §10 C).
import { describe, it, expect, vi } from 'vitest';
import { FIRE_SPOTS, MAX_FIRE_SLOTS, CAMPFIRE_FUEL_START_S, CAMPFIRE_FUEL_MAX_S, FUEL_STICK_S, FUEL_LOG_S } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { ITEMS } from '../../src/items.js';
import {
  FIRE_TRANSFORMS, SKEWER_FOODS, CENTRE_POTS, SKEWER_SPOTS, EMBERS_SPOT, SKEWER_ANGLES, spotKind, isSkewerFood, isCentrePot,
  spotAccepts, hasCooked, fuelSeconds, formatFuel, fireKey, parseCellKey, normalizeFiresJSON, fireHint, FireSlots,
} from '../../src/cooking.js';

const F = [3, 64, -5]; // a fire cell
const always = () => true;
const never = () => false;

/** Step `seconds` in steps of dt with every fire burning and loaded. */
function burn(slots, seconds, dt = 0.5, isBurning = always, isLoaded = always) {
  const burntOut = [];
  for (let i = 0; i < Math.round(seconds / dt); i++) burntOut.push(...slots.step(dt, isBurning, isLoaded).burntOut);
  return burntOut;
}

/** The keys on the spots of fire F (null for empty). */
function spots(slots, at = F) {
  const v = slots.view(...at);
  return v ? v.spots.map((s) => (s ? s.k : null)) : null;
}

describe('the cooking tables', () => {
  it('FIRE_TRANSFORMS is exactly §4.4 (result, seconds, spot kind) and names only real items', () => {
    expect(FIRE_TRANSFORMS).toEqual({
      raw_pork: { to: 'roast_pork', seconds: 20, spot: 'skewer' },
      roast_pork: { to: 'charred_meat', seconds: 40, spot: 'skewer' },
      raw_beef: { to: 'roast_beef', seconds: 24, spot: 'skewer' },
      roast_beef: { to: 'charred_meat', seconds: 40, spot: 'skewer' },
      raw_mutton: { to: 'roast_mutton', seconds: 18, spot: 'skewer' },
      roast_mutton: { to: 'charred_meat', seconds: 40, spot: 'skewer' },
      wild_tuber: { to: 'baked_tuber', seconds: 25, spot: 'skewer' },
      cattail_root: { to: 'roasted_cattail_root', seconds: 15, spot: 'skewer' },
      leached_acorns: { to: 'roasted_acorns', seconds: 15, spot: 'skewer' },
      unpeeled_cactus_fruit: { to: 'cactus_fruit', seconds: 6, spot: 'skewer' },
      pot_water: { to: 'pot_boiled', seconds: 15, spot: 'centre' },
      pot_tainted: { to: 'pot_boiled', seconds: 15, spot: 'centre' }, // §76 water: boiling cures taint
      pot_seawater: { to: 'salt_pot', seconds: 30, spot: 'centre' },
      pot_snow: { to: 'pot_boiled', seconds: 25, spot: 'centre' },
      greenware_pot: { to: 'clay_pot', seconds: 60, spot: 'centre' },
      // v0.14 (§76 flora)
      honeycap: { to: 'roasted_honeycap', seconds: 15, spot: 'skewer' },
      frecklecap: { to: 'roasted_frecklecap', seconds: 15, spot: 'skewer' },
      wild_onion: { to: 'roasted_onion', seconds: 15, spot: 'skewer' },
      wild_carrot: { to: 'roasted_carrot', seconds: 20, spot: 'skewer' },
      hazelnuts: { to: 'roasted_hazelnuts', seconds: 12, spot: 'skewer' },
      crab_apple: { to: 'baked_crab_apple', seconds: 18, spot: 'skewer' },
    });
    for (const [k, t] of Object.entries(FIRE_TRANSFORMS)) {
      expect(Object.hasOwn(ITEMS, k), k).toBe(true);
      expect(Object.hasOwn(ITEMS, t.to), t.to).toBe(true);
    }
    expect(Object.isFrozen(FIRE_TRANSFORMS) && Object.isFrozen(FIRE_TRANSFORMS.raw_pork)).toBe(true);
    // logs are fuel, not food for the fire
    expect(Object.keys(FIRE_TRANSFORMS).some((k) => k.endsWith('_log'))).toBe(false);
  });

  it('skewers take the five skewer foods, the embers the four pots; seven spots, six skewers on the corner stones', () => {
    expect(FIRE_SPOTS).toBe(7);
    expect(SKEWER_SPOTS).toBe(6);
    expect(EMBERS_SPOT).toBe(6);
    expect(SKEWER_FOODS).toEqual(['raw_pork', 'raw_beef', 'raw_mutton', 'wild_tuber', 'cattail_root', 'leached_acorns', 'unpeeled_cactus_fruit',
      'honeycap', 'frecklecap', 'wild_onion', 'wild_carrot', 'hazelnuts', 'crab_apple']); // v0.14 (§76 flora)
    expect(CENTRE_POTS).toEqual(['pot_water', 'pot_seawater', 'pot_snow', 'greenware_pot', 'pot_tainted']); // + §76 water
    for (const k of SKEWER_FOODS) expect(FIRE_TRANSFORMS[k].spot).toBe('skewer');
    for (const k of CENTRE_POTS) expect(FIRE_TRANSFORMS[k].spot).toBe('centre');
    expect([0, 1, 2, 3, 4, 5, 6].map(spotKind)).toEqual(['skewer', 'skewer', 'skewer', 'skewer', 'skewer', 'skewer', 'centre']);
    expect(isSkewerFood('raw_pork') && !isSkewerFood('roast_pork') && !isSkewerFood('pot_water')).toBe(true);
    expect(isCentrePot('greenware_pot') && !isCentrePot('clay_pot') && !isCentrePot('raw_pork')).toBe(true);
    // the corner stones the campfire renderer draws: corner k at 60k − 90°
    SKEWER_ANGLES.forEach((a, k) => expect(a).toBeCloseTo(((60 * k - 90) * Math.PI) / 180, 12));
  });

  it('spotAccepts: what can be put on a spot and what the fire makes of it; hasCooked tells finished items apart', () => {
    for (const k of ['raw_pork', 'roast_pork', 'charred_meat', 'baked_tuber', 'cactus_fruit', 'roasted_acorns']) expect(spotAccepts(0, k), k).toBe(true);
    for (const k of ['pot_water', 'pot_boiled', 'salt_pot', 'clay_pot', 'greenware_pot', 'pot_snow']) {
      expect(spotAccepts(6, k), k).toBe(true);
      expect(spotAccepts(3, k), k).toBe(false);
    }
    for (const k of ['raw_pork', 'baked_tuber']) expect(spotAccepts(6, k)).toBe(false);
    for (const k of ['rock', 'oak_log', '__proto__', 'constructor', '']) expect(spotAccepts(0, k) || spotAccepts(6, k), k).toBe(false);
    expect(hasCooked('raw_pork')).toBe(false);
    expect(hasCooked('pot_water')).toBe(false);
    expect(hasCooked('roast_pork')).toBe(true); // finished once, still chars
    expect(hasCooked('clay_pot')).toBe(true);
  });

  it('fuel values, the fuel clock and cell keys', () => {
    expect(fuelSeconds('stick')).toBe(FUEL_STICK_S);
    for (const k of ['oak_log', 'spruce_log', 'birch_log']) expect(fuelSeconds(k)).toBe(FUEL_LOG_S);
    for (const k of ['oak_planks', 'coal', 'charcoal', 'rock', '__proto__']) expect(fuelSeconds(k), k).toBe(0);
    expect(6 * FUEL_STICK_S).toBeLessThan(FUEL_LOG_S); // splitting a log never beats burning it
    expect(formatFuel(250)).toBe('4:10');
    expect(formatFuel(0)).toBe('0:00');
    expect(formatFuel(59.2)).toBe('1:00');
    expect(formatFuel(1200)).toBe('20:00');
    expect(formatFuel(NaN)).toBe('0:00');
    expect(fireKey(-1, 0, 5)).toBe('-1,0,5');
    expect(parseCellKey('-1,0,5')).toEqual([-1, 0, 5]);
    expect(parseCellKey('01,2,-0')).toEqual([1, 2, 0]);
    expect(Object.is(parseCellKey('0,2,-0')[2], 0)).toBe(true);
    for (const bad of ['1,2', '1,2,3,4', 'a,b,c', '1.5,2,3', '1,128,3', '1,-1,3', ' 1,2,3', '', null, undefined]) expect(parseCellKey(bad), String(bad)).toBeNull();
  });
});

describe('FireSlots: putting and taking', () => {
  it('puts one item per call on the right kind of spot; mixed kinds share a fire', () => {
    const fs = new FireSlots();
    expect(fs.put(...F, 'raw_pork', 0)).toBeGreaterThanOrEqual(0);
    expect(fs.put(...F, 'pot_water', 0)).toBe(EMBERS_SPOT);
    expect(fs.put(...F, 'wild_tuber', 0)).toBeLessThan(SKEWER_SPOTS);
    expect(fs.put(...F, 'pot_snow', 0)).toBe(-1); // the embers hold one pot
    for (const k of ['rock', 'roast_pork', 'clay_pot', 'oak_log', 'cactus_fruit', '__proto__']) expect(fs.put(...F, k, 0), k).toBe(-1);
    expect(spots(fs).filter(Boolean).sort()).toEqual(['pot_water', 'raw_pork', 'wild_tuber']);
    for (let i = 0; i < 4; i++) expect(fs.put(...F, 'cattail_root', 0)).toBeGreaterThanOrEqual(0);
    expect(fs.put(...F, 'raw_pork', 0)).toBe(-1); // six skewers full
    expect(fs.canPut(...F, 'raw_pork')).toBe(false);
    expect(fs.canPut(...F, 'pot_water')).toBe(false);
    expect(fs.canPut(...[0, 64, 0], 'raw_pork')).toBe(true);
    expect(fs.canPut(...[0, 64, 0], 'rock')).toBe(false);
    expect(fs.hasItems(...F)).toBe(true);
    expect(fs.has(...F)).toBe(true);
    expect(fs.hasItems(0, 64, 0)).toBe(false);
  });

  it('a skewer food goes on the free skewer nearest the facing direction (ties: the lower index)', () => {
    const fs = new FireSlots();
    // facing straight at corner 2 (60·2 − 90 = 30°)
    expect(fs.put(...F, 'raw_pork', (30 * Math.PI) / 180)).toBe(2);
    // corner 2 is taken: 30° is equally far from corners 1 (−30°) and 3 (90°) → the lower index
    expect(fs.put(...F, 'raw_pork', (30 * Math.PI) / 180)).toBe(1);
    expect(fs.put(...F, 'raw_pork', (30 * Math.PI) / 180)).toBe(3);
    // angles wrap: 200° is nearest corner 5 (210°)
    expect(fs.put(...F, 'raw_pork', (200 * Math.PI) / 180)).toBe(5);
    expect(fs.put(...F, 'raw_pork', (-160 * Math.PI) / 180)).toBe(4); // −160° ≡ 200°: 5 is taken, 4 (150°) is next
    // no facing: the lowest free skewer
    expect(fs.put(...F, 'raw_pork')).toBe(0);
  });

  it('each spot keeps its own timer; transforms chain (raw → roast → charred) and keep the extra seconds', () => {
    const fs = new FireSlots();
    const pork = fs.put(...F, 'raw_pork', 0);
    burn(fs, 10);
    const tuber = fs.put(...F, 'wild_tuber', 0);
    burn(fs, 10);
    let v = fs.view(...F);
    expect(v.spots[pork]).toEqual({ k: 'roast_pork', progress: 0, secondsLeft: 40, next: 'charred_meat' });
    expect(v.spots[tuber]).toMatchObject({ k: 'wild_tuber', next: 'baked_tuber' });
    expect(v.spots[tuber].progress).toBeCloseTo(10 / 25);
    expect(v.spots[tuber].secondsLeft).toBeCloseTo(15);
    // one big step: the rest of the seconds carries into the next transform
    fs.step(45, always, always);
    v = fs.view(...F);
    expect(v.spots[pork]).toEqual({ k: 'charred_meat', progress: 1, secondsLeft: 0, next: null });
    expect(v.spots[tuber]).toEqual({ k: 'baked_tuber', progress: 1, secondsLeft: 0, next: null });
    // a raw item cooked 25 s in one step is roast pork with 5 s toward charring
    const fs2 = new FireSlots();
    fs2.put(...F, 'raw_pork', 0);
    fs2.step(25, null, null);
    expect(fs2.view(...F).spots.find(Boolean)).toEqual({ k: 'roast_pork', progress: 5 / 40, secondsLeft: 35, next: 'charred_meat' });
  });

  it('pots boil and fire in the embers: water, seawater to salt, snow, greenware to a clay pot', () => {
    for (const [pot, seconds, result] of [['pot_water', 15, 'pot_boiled'], ['pot_seawater', 30, 'salt_pot'], ['pot_snow', 25, 'pot_boiled'], ['greenware_pot', 60, 'clay_pot']]) {
      const fs = new FireSlots();
      fs.put(...F, pot, 0);
      burn(fs, seconds - 1);
      expect(spots(fs)[6], pot).toBe(pot);
      burn(fs, 1);
      expect(spots(fs)[6], pot).toBe(result);
    }
  });

  it('takeReady takes the finished spots only, or everything when none has finished; what `give` refuses stays', () => {
    const fs = new FireSlots();
    fs.put(...F, 'raw_pork', 0);
    fs.put(...F, 'pot_water', 0);
    burn(fs, 5);
    expect(fs.takeReady(...F).map((s) => s.k).sort()).toEqual(['pot_water', 'raw_pork']); // nothing done: take all
    expect(fs.has(...F)).toBe(false);
    fs.put(...F, 'raw_pork', 0);
    fs.put(...F, 'cactus_fruit', 0); // not a skewer food: refused
    fs.put(...F, 'unpeeled_cactus_fruit', 0);
    fs.put(...F, 'pot_water', 0);
    burn(fs, 7); // the cactus fruit (6 s) is done; pork (20 s) and the pot (15 s) are not
    expect(fs.takeReady(...F)).toEqual([{ k: 'cactus_fruit', n: 1 }]);
    burn(fs, 15);
    // the pork (done) and the boiled pot (done): the pack only has room for the pork
    const give = vi.fn((k) => k !== 'pot_boiled');
    expect(fs.takeReady(...F, give)).toEqual([{ k: 'roast_pork', n: 1 }]);
    expect(give).toHaveBeenCalledTimes(2);
    expect(spots(fs).filter(Boolean)).toEqual(['pot_boiled']);
    expect(fs.takeReady(...F, () => false)).toEqual([]);
    expect(fs.takeReady(0, 0, 0)).toEqual([]);
    const v = fs.version;
    expect(fs.takeReady(...F)).toEqual([{ k: 'pot_boiled', n: 1 }]);
    expect(fs.version).toBeGreaterThan(v);
    expect(fs.size).toBe(0); // an empty fire without fuel keeps no entry
  });
});

describe('FireSlots: burning, fuel and burn-out', () => {
  it('nothing cooks on a cold pit or in an unloaded chunk, and the fuel stands still there', () => {
    const fs = new FireSlots();
    fs.light(...F, CAMPFIRE_FUEL_START_S);
    fs.put(...F, 'raw_pork', 0);
    burn(fs, 30, 0.5, never, always); // a pit: not burning
    burn(fs, 30, 0.5, always, never); // unloaded
    expect(fs.view(...F).spots[fs.view(...F).spots.findIndex(Boolean)]).toMatchObject({ k: 'raw_pork', progress: 0 });
    expect(fs.fuel(...F)).toBe(CAMPFIRE_FUEL_START_S);
    const isBurning = vi.fn(() => true);
    const isLoaded = vi.fn(() => true);
    fs.step(1, isBurning, isLoaded);
    expect(isBurning).toHaveBeenCalledWith(...F);
    expect(isLoaded).toHaveBeenCalledWith(F[0], F[2]);
  });

  it('fuel: light starts it, sticks and logs feed it up to the cap ("full"), a fire without fuel is "untracked"', () => {
    const fs = new FireSlots();
    expect(fs.addFuel(...F, FUEL_STICK_S)).toBe('untracked'); // no entry at all
    fs.put(...F, 'raw_pork', 0);
    expect(fs.addFuel(...F, FUEL_STICK_S)).toBe('untracked'); // items but no fuel: burns forever
    expect(fs.fuel(...F)).toBeNull();
    expect(fs.light(...F, CAMPFIRE_FUEL_START_S)).toBe(true);
    expect(fs.fuel(...F)).toBe(300);
    expect(fs.addFuel(...F, FUEL_STICK_S)).toBe('ok');
    expect(fs.fuel(...F)).toBe(340);
    expect(fs.addFuel(...F, FUEL_LOG_S)).toBe('ok');
    expect(fs.addFuel(...F, FUEL_LOG_S)).toBe('ok');
    expect(fs.addFuel(...F, FUEL_LOG_S)).toBe('ok'); // 1240 → clamped
    expect(fs.fuel(...F)).toBe(CAMPFIRE_FUEL_MAX_S);
    expect(fs.addFuel(...F, FUEL_STICK_S)).toBe('full');
    expect(fs.fuel(...F)).toBe(CAMPFIRE_FUEL_MAX_S);
    expect(fs.addFuel(...F, NaN)).toBe('full');
    fs.light(...F, 5000);
    expect(fs.fuel(...F)).toBe(CAMPFIRE_FUEL_MAX_S);
    fs.light(...F, -3);
    expect(fs.fuel(...F)).toBe(0);
  });

  it('counts down only when stepped (there is no clock), and only on burning loaded fires', () => {
    const fs = new FireSlots();
    fs.light(...F, 300);
    expect(fs.fuel(...F)).toBe(300);
    burn(fs, 100);
    expect(fs.fuel(...F)).toBeCloseTo(200);
    for (const dt of [0, -5, NaN, Infinity]) fs.step(dt, always, always);
    expect(fs.fuel(...F)).toBeCloseTo(200);
  });

  it('a burn-out is reported once; food cooks only for the fuel there was', () => {
    const fs = new FireSlots();
    fs.light(...F, 10);
    fs.put(...F, 'raw_pork', 0);
    expect(burn(fs, 6)).toEqual([]);
    const v = fs.version;
    expect(fs.step(30, always, always).burntOut).toEqual([F]);
    expect(fs.version).toBeGreaterThan(v);
    expect(fs.view(...F).spots.find(Boolean)).toMatchObject({ k: 'raw_pork', secondsLeft: 10 }); // cooked 10 s in all
    expect(burn(fs, 20)).toEqual([]); // still a CAMPFIRE (main has not written the pit yet): never reported twice
    expect(fs.view(...F).spots.find(Boolean).secondsLeft).toBe(10);
    // feeding it brings it back
    expect(fs.addFuel(...F, FUEL_STICK_S)).toBe('ok');
    expect(fs.step(50, always, always).burntOut).toEqual([F]);
  });

  it('a fire whose fuel already stood at 0 (a load) is reported on its first step', () => {
    const fs = new FireSlots();
    fs.load({ [F.join(',')]: { s: [null, null, null, null, null, null, null], f: 0 } });
    expect(fs.step(0.1, always, always).burntOut).toEqual([F]);
    expect(fs.step(0.1, always, always).burntOut).toEqual([]);
  });

  it('reports `cooking`: the items still cooking on burning fires', () => {
    const fs = new FireSlots();
    fs.put(...F, 'raw_pork', 0);
    fs.put(...F, 'unpeeled_cactus_fruit', 0);
    fs.put(0, 64, 0, 'pot_water', 0);
    expect(fs.step(1, always, always).cooking).toBe(3);
    expect(fs.step(6, always, always).cooking).toBe(2); // the cactus fruit is done
    expect(fs.step(1, (q) => q === 0, always).cooking).toBe(1);
  });

  it('version moves on puts, takes, fuel and transforms — not on the fuel countdown alone', () => {
    const fs = new FireSlots();
    let v = fs.version;
    fs.light(...F, 100);
    expect(fs.version).toBeGreaterThan(v);
    v = fs.version;
    burn(fs, 10);
    expect(fs.version).toBe(v);
    fs.put(...F, 'unpeeled_cactus_fruit', 0);
    expect(fs.version).toBeGreaterThan(v);
    v = fs.version;
    burn(fs, 6);
    expect(fs.version).toBeGreaterThan(v); // the fruit was singed
  });
});

describe('FireSlots: block changes', () => {
  it('spots are kept across CAMPFIRE → FIRE_PIT (burn-out) and FIRE_PIT → CAMPFIRE (relight); the pit has no fuel', () => {
    const fs = new FireSlots();
    fs.light(...F, 20);
    fs.put(...F, 'raw_pork', 0);
    fs.put(...F, 'pot_water', 0);
    expect(fs.step(25, always, always).burntOut).toEqual([F]);
    expect(fs.onBlockChange(...F, BLOCK.CAMPFIRE, BLOCK.FIRE_PIT)).toEqual([]);
    expect(spots(fs).filter(Boolean).sort()).toEqual(['pot_boiled', 'roast_pork']);
    expect(fs.fuel(...F)).toBeNull();
    // a cold pit: nothing cooks (main says it is not burning)
    burn(fs, 100, 1, never);
    expect(fs.view(...F).spots.find(Boolean)).toMatchObject({ k: 'roast_pork', progress: 0 });
    // relight: main writes CAMPFIRE, then lights it
    expect(fs.onBlockChange(...F, BLOCK.FIRE_PIT, BLOCK.CAMPFIRE)).toEqual([]);
    expect(fs.light(...F, CAMPFIRE_FUEL_START_S)).toBe(true);
    expect(fs.fuel(...F)).toBe(300);
    expect(spots(fs).filter(Boolean).sort()).toEqual(['pot_boiled', 'roast_pork']);
    // an empty fire that burns out leaves no entry once it is a pit
    const empty = new FireSlots();
    empty.light(...F, 1);
    empty.step(2, always, always);
    empty.onBlockChange(...F, BLOCK.CAMPFIRE, BLOCK.FIRE_PIT);
    expect(empty.size).toBe(0);
  });

  it('anything else releases the items (to the pack when the player broke it in Survival; main decides)', () => {
    for (const [prev, next] of [[BLOCK.CAMPFIRE, BLOCK.AIR], [BLOCK.FIRE_PIT, BLOCK.AIR], [BLOCK.CAMPFIRE, BLOCK.WATER], [BLOCK.FIRE_PIT, BLOCK.SAND]]) {
      const fs = new FireSlots();
      fs.light(...F, 300);
      fs.put(...F, 'raw_pork', 0);
      fs.put(...F, 'greenware_pot', 0);
      const v = fs.version;
      expect(fs.onBlockChange(...F, prev, next)).toEqual([{ k: 'raw_pork', n: 1 }, { k: 'greenware_pot', n: 1 }]);
      expect(fs.has(...F)).toBe(false);
      expect(fs.version).toBeGreaterThan(v);
    }
    const fs = new FireSlots();
    expect(fs.onBlockChange(...F, BLOCK.CAMPFIRE, BLOCK.AIR)).toEqual([]); // nothing tracked
    // a stray entry never passes to a fire placed later in that cell
    fs.put(...F, 'raw_pork', 0);
    expect(fs.onBlockChange(...F, BLOCK.AIR, BLOCK.CAMPFIRE)).toEqual([{ k: 'raw_pork', n: 1 }]);
    expect(fs.has(...F)).toBe(false);
  });

  it('works at negative coordinates and keeps fires apart', () => {
    const fs = new FireSlots();
    fs.put(-1, 0, -1, 'raw_pork', 0);
    fs.put(1, 0, 1, 'pot_snow', 0);
    expect(spots(fs, [-1, 0, -1]).filter(Boolean)).toEqual(['raw_pork']);
    expect(spots(fs, [1, 0, 1])[6]).toBe('pot_snow');
    expect(fs.view(0, 0, 0)).toBeNull();
  });

  it('caps the fires holding something at MAX_FIRE_SLOTS (a fire beyond it burns forever, untracked)', () => {
    const fs = new FireSlots();
    for (let i = 0; i < MAX_FIRE_SLOTS; i++) expect(fs.light(i, 10, 0, 300)).toBe(true);
    expect(fs.light(9999, 10, 0, 300)).toBe(false);
    expect(fs.put(9999, 10, 0, 'raw_pork', 0)).toBe(-1);
    expect(fs.canPut(9999, 10, 0, 'raw_pork')).toBe(false);
    expect(fs.put(5, 10, 0, 'raw_pork', 0)).toBeGreaterThanOrEqual(0); // tracked fires still take food
    expect(fs.addFuel(9999, 10, 0, 40)).toBe('untracked');
    fs.onBlockChange(5, 10, 0, BLOCK.CAMPFIRE, BLOCK.AIR);
    expect(fs.light(9999, 10, 0, 300)).toBe(true);
  });
});

describe('FireSlots: export / load / view / hint', () => {
  it('exports the entries in (q, y, r) order, 3 decimals, `f` only with fuel; load restores them exactly', () => {
    const fs = new FireSlots();
    fs.put(5, 1, 0, 'raw_pork', 0);
    fs.light(-2, 70, 9, 300);
    fs.put(-2, 70, 9, 'pot_water', 0);
    fs.step(1 / 3, always, always);
    const json = fs.export();
    expect(Object.keys(json)).toEqual(['-2,70,9', '5,1,0']);
    expect(json['-2,70,9']).toEqual({ s: [null, null, null, null, null, null, { k: 'pot_water', t: 0.333 }], f: 299.667 });
    expect(json['5,1,0'].f).toBeUndefined();
    expect(json['5,1,0'].s.filter(Boolean)).toEqual([{ k: 'raw_pork', t: 0.333 }]);
    const back = new FireSlots();
    const v = back.version;
    expect(back.load(json)).toEqual([]);
    expect(back.version).toBeGreaterThan(v);
    expect(back.export()).toEqual(json);
    expect(normalizeFiresJSON(json).fires).toEqual(json);
    // load replaces what was there
    back.load({});
    expect(back.size).toBe(0);
    expect(back.load('garbage')).toEqual(['fires: not an object, ignored']);
    expect(back.load(null)).toEqual([]);
    fs.clear();
    expect(fs.size).toBe(0);
    expect(fs.export()).toEqual({});
  });

  it('normalizeFiresJSON drops bad entries and empties bad spots, with warnings', () => {
    const s7 = (over = {}) => Object.assign(new Array(7).fill(null), over);
    const raw = {
      'x,1,2': { s: s7() },
      '1,2': { s: s7() },
      '1,999,1': { s: s7() },
      '2,10,2': { s: [null], f: 5 },
      '3,10,3': { s: s7(), f: -1 },
      '4,10,4': { s: s7(), f: 1201 },
      '5,10,5': { s: s7(), f: 'lots' },
      '6,10,6': 'fire',
      '7,10,7': { s: s7({ 0: { k: 'pot_water', t: 1 }, 1: { k: 'roast_pork', t: 2 }, 2: { k: 'raw_pork', t: -1 }, 3: { k: 'nope', t: 0 }, 6: { k: 'raw_pork', t: 0 } }) },
      '8,10,8': { s: s7({ 6: { k: 'pot_boiled', t: 0 } }), f: 12.34567 },
      '9,10,9': { s: s7() }, // empty, no fuel: simply not kept
      '010,10,10': { s: s7({ 0: { k: 'raw_pork', t: 1 } }) },
      '10,10,10': { s: s7({ 1: { k: 'raw_pork', t: 2 } }) }, // same cell: the last write wins
    };
    const { fires, warnings } = normalizeFiresJSON(raw, { prefix: 'survival.fires' });
    expect(Object.keys(fires)).toEqual(['7,10,7', '8,10,8', '10,10,10']);
    expect(fires['7,10,7'].s).toEqual(s7({ 1: { k: 'roast_pork', t: 2 } }));
    expect(fires['8,10,8']).toEqual({ s: s7({ 6: { k: 'pot_boiled', t: 0 } }), f: 12.346 });
    expect(fires['10,10,10'].s).toEqual(s7({ 1: { k: 'raw_pork', t: 2 } }));
    expect(warnings).toEqual([
      'survival.fires: dropped entry with malformed key "x,1,2"',
      'survival.fires: dropped entry with malformed key "1,2"',
      'survival.fires: dropped entry with malformed key "1,999,1"',
      'survival.fires[2,10,2]: not 7 spots, dropped',
      'survival.fires[3,10,3]: bad fuel, dropped',
      'survival.fires[4,10,4]: bad fuel, dropped',
      'survival.fires[5,10,5]: bad fuel, dropped',
      'survival.fires[6,10,6]: not 7 spots, dropped',
      'survival.fires[7,10,7].s[0]: "pot_water" cannot be on a skewer, emptied',
      'survival.fires[7,10,7].s[2]: bad time, emptied',
      'survival.fires[7,10,7].s[3]: "nope" cannot be on a skewer, emptied',
      'survival.fires[7,10,7].s[6]: "raw_pork" cannot be in the embers, emptied',
    ]);
  });

  it('normalizeFiresJSON: the cellOk filter (storage checks the edits) and the MAX_FIRE_SLOTS cap after it', () => {
    const raw = {};
    for (let i = 0; i < MAX_FIRE_SLOTS + 3; i++) raw[`${i},5,0`] = { s: new Array(7).fill(null), f: 10 };
    const cellOk = (q) => q !== 1;
    const { fires, warnings } = normalizeFiresJSON(raw, { prefix: 'survival.fires', cellOk });
    expect(Object.keys(fires)).toHaveLength(MAX_FIRE_SLOTS);
    expect(fires['1,5,0']).toBeUndefined();
    expect(fires[`${MAX_FIRE_SLOTS},5,0`]).toBeDefined(); // the orphan did not count against the cap
    expect(warnings).toEqual(['survival.fires[1,5,0]: no campfire there, dropped', `survival.fires: more than ${MAX_FIRE_SLOTS} fires, 2 dropped`]);
  });

  it('view() describes every spot and the fuel; fireHint reads like the target hint', () => {
    const fs = new FireSlots();
    expect(fs.view(...F)).toBeNull();
    expect(fireHint(null)).toBe('');
    fs.light(...F, 250);
    for (let i = 0; i < 3; i++) fs.put(...F, 'raw_pork', 0);
    fs.step(6, always, always);
    fs.put(...F, 'unpeeled_cactus_fruit', 0);
    fs.put(...F, 'unpeeled_cactus_fruit', 0);
    fs.step(6, always, always);
    const v = fs.view(...F);
    expect(v.fuel).toBeCloseTo(238);
    expect(v.spots).toHaveLength(7);
    expect(v.spots.filter(Boolean)).toHaveLength(5);
    expect(fireHint(v)).toBe('3 roasting (next 8 s) · 2 done · fuel 3:58');
    const plain = new FireSlots();
    plain.put(...F, 'pot_water', 0);
    expect(fireHint(plain.view(...F))).toBe('1 roasting (next 15 s)');
  });
});
