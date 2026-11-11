// Survival — the first day, played on paper (docs/DESIGN-survival.md §7.5; §10 "I" test 2). Pure modules only, in the order
// main.js runs them (CONTRACTS §49): a Map-backed plains world with loose stones, gravel tops, tussock and an oak canopy;
// hands gather the first-day kit; the hand lane makes it; a flint pick cuts stone; a full hotbar still drinks at a pond;
// pork roasts on a skewer while the fire burns down to a cold pit; a 25-cell fall kills through pendingDeath, the
// belongings hold everything, and waking gives the waking values.
import { describe, it, expect, beforeAll } from 'vitest';
import { CAMPFIRE_FUEL_START_S, HOTBAR_SIZE } from '../../src/config.js';
import { BLOCK, BIOME, isSolid } from '../../src/blocks.js';
import { hexToWorld, worldToHex } from '../../src/hex.js';
import { mulberry32 } from '../../src/noise.js';
import { createPlayer, stepPlayer } from '../../src/physics.js';
import { getItem } from '../../src/items.js';
import { Pack } from '../../src/inventory.js';
import { Containers } from '../../src/containers.js';
import { breakSeconds, rollDrops, pick } from '../../src/harvest.js';
import { DigState, HINT, interactKind, chooseBelongingsCell, handKeyOf } from '../../src/survivalControl.js';
import { CraftQueue, getRecipe } from '../../src/crafting.js';
import { FireSlots } from '../../src/cooking.js';
import { Survival } from '../../src/survival.js';
import { deathScreenText, pitHintText, spoiledText, stacksText } from '../../src/main.js';
import { blockParticleColor } from '../../src/particles.js';

const B = BLOCK;
const GROUND = 63; // grass surface; litter and plants stand at y = 64
const FRAME = 1 / 60;
const IDLE = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };
const PLAINS_NOON = { biome: BIOME.PLAINS, climateT: 0, openSky: true, underground: false, groundChill: 0 };

/** A Map-backed world: stone under grass at GROUND everywhere, plus what the test puts there. */
function makeWorld() {
  const cells = new Map();
  const edits = new Set();
  const key = (q, y, r) => `${q},${y},${r}`;
  const getBlock = (q, y, r) => {
    if (y < 0) return B.AIR;
    const v = cells.get(key(q, y, r));
    if (v !== undefined) return v;
    return y < GROUND ? B.STONE : y === GROUND ? B.GRASS_BLOCK : B.AIR;
  };
  return {
    getBlock,
    /** terrain (no edit) */
    put: (q, y, r, id) => cells.set(key(q, y, r), id),
    /** a player / game write (an edit, like World.setBlock) */
    setBlock: (q, y, r, id) => {
      cells.set(key(q, y, r), id);
      edits.add(key(q, y, r));
      return true;
    },
    hasEdit: (q, y, r) => edits.has(key(q, y, r)),
  };
}

/** The tool in a pack slot (the selected hand). */
const toolIn = (pack, i) => pack.toolAt(i);
/** The first slot holding `key` (to select it). */
const slotOf = (pack, key) => pack.slots.findIndex((s) => s && s.k === key);

describe('the first day (§7.5)', () => {
  const rng = mulberry32(20261109);
  const world = makeWorld();
  const pack = new Pack();
  const store = new Containers(); // what is set aside (the surplus beyond the kit)
  const queue = new CraftQueue();
  const survival = new Survival();
  let gatherSeconds = 0;

  // The start: 20 loose stones, 3 gravel tops and 12 tussocks around (0, 0), and an oak canopy of 8 leaves overhead.
  beforeAll(() => {
    for (let i = 0; i < 20; i++) world.put(i - 10, GROUND + 1, 4, B.LOOSE_STONES);
    for (let i = 0; i < 3; i++) world.put(i, GROUND, -4, B.GRAVEL);
    for (let i = 0; i < 12; i++) world.put(i - 6, GROUND + 1, 7, B.TUSSOCK);
    for (let i = 0; i < 8; i++) world.put(i - 4, GROUND + 5, -7, B.OAK_LEAVES);
    survival.setMode('survival');
  });

  /** §6.4 R on a loose stone: natural before the write, room checked, the picked block written, the drops given. */
  function pickAt(q, y, r) {
    const id = world.getBlock(q, y, r);
    const res = pick(id, { natural: !world.hasEdit(q, y, r), knifeInPack: pack.hasTool('knife', 2) }, rng);
    expect(pack.canGive(res.drops)).toBe(true);
    world.setBlock(q, y, r, res.to);
    pack.addAll(res.drops);
  }

  /** §6.1 hold to dig with the selected slot, frame by frame, then the finishing order. @returns {number} seconds held */
  function digAt(q, y, r, selected) {
    const dig = new DigState();
    const id = world.getBlock(q, y, r);
    const stack = pack.slots[selected] ?? null;
    const tool = stack ? toolIn(pack, selected) : null;
    const need = breakSeconds(id, tool, false);
    expect(Number.isFinite(need)).toBe(true);
    let held = 0;
    for (let f = 0; f < 600; f++) {
      held += FRAME;
      const res = dig.step(FRAME, { q, y, r, id }, true, need, handKeyOf(selected, stack));
      if (!res.done) continue;
      const natural = !world.hasEdit(q, y, r); // BEFORE the break (§6.1 step 1)
      const drops = rollDrops(id, tool, { natural, knifeInPack: pack.hasTool('knife', 2) }, rng);
      expect(pack.canGive(drops)).toBe(true);
      world.setBlock(q, y, r, B.AIR);
      pack.addAll(drops);
      if (tool) pack.damage(selected, 1);
      return held;
    }
    throw new Error('the dig never finished');
  }

  /** Queue `times` of a hand recipe and run the hand lane for exactly its time. @returns {string[]} the jobs done, in order */
  function make(id, times = 1) {
    const res = queue.enqueue(id, times, pack, { hand: true });
    expect(res.ok, res.message).toBe(true);
    expect(res.queued).toBe(times);
    const ev = queue.step(getRecipe(id).seconds * times, pack, null, [0, GROUND + 1, 0]);
    expect(ev.failed).toEqual([]);
    expect(queue.size).toBe(0); // done in exactly its own time: nothing waits
    return ev.done.map((d) => d.id);
  }

  const made = [];

  it('hands gather rock, flint and fibre from loose stones, gravel tops and tussock', () => {
    for (let i = 0; i < 20; i++) pickAt(i - 10, GROUND + 1, 4);
    for (let i = 0; i < 3; i++) gatherSeconds += digAt(i, GROUND, -4, HOTBAR_SIZE - 1);
    for (let i = 0; i < 12; i++) gatherSeconds += digAt(i - 6, GROUND + 1, 7, HOTBAR_SIZE - 1);
    expect(pack.count('rock')).toBeGreaterThanOrEqual(9);
    expect(pack.countTag('knapstone')).toBeGreaterThanOrEqual(4);
    expect(pack.count('plant_fibre')).toBeGreaterThanOrEqual(11);
    // Gravel by hand is 1.2 s a cell, tussock 0.2 s (§6.3): 6 s of digging, give or take a frame a cell.
    expect(gatherSeconds).toBeGreaterThanOrEqual(3 * 1.2 + 12 * 0.2 - 1e-9);
    expect(gatherSeconds).toBeLessThan(3 * 1.2 + 12 * 0.2 + 15 * FRAME + 1e-9);
    // Everything beyond the kit's 9 rock, 4 knapstone and 11 fibre is set aside, so "nothing left over" can be checked.
    store.ensureBasket(0, GROUND + 1, -1);
    const aside = [['rock', pack.count('rock') - 9], ['flint', pack.count('flint') - 4], ['plant_fibre', pack.count('plant_fibre') - 11]];
    for (const [k, n] of aside) {
      pack.take(k, n);
      store.get(0, GROUND + 1, -1).slots.push({ k, n });
    }
    expect([pack.count('rock'), pack.count('flint'), pack.count('plant_fibre'), pack.count('stick')]).toEqual([9, 4, 11, 0]);
  });

  it('a stone hammer, then a stone axe that lops 8 leaves for 8 sticks', () => {
    made.push(...make('stone_hammer'));
    made.push(...make('stone_axe'));
    const chopper = slotOf(pack, 'stone_axe');
    let lop = 0;
    for (let i = 0; i < 8; i++) lop += digAt(i - 4, GROUND + 5, -7, chopper);
    expect(lop / 8).toBeCloseTo(0.4 / 1.5, 1); // 0.27 s a leaf (§7.5)
    expect(pack.count('stick')).toBe(8);
    // The lopped leaves (and the odd acorn, 8 % a natural leaf) are not kit materials: set them aside too.
    expect(pack.count('oak_leaves')).toBe(8);
    pack.take('oak_leaves', 8);
    pack.take('acorns', pack.count('acorns'));
  });

  it('9 rock, 4 knapstone, 11 fibre and 8 sticks make the whole kit in 28 s of hand jobs, with nothing left over', () => {
    made.push(...make('cord', 5));
    made.push(...make('flint_knife'));
    made.push(...make('flint_axe'));
    made.push(...make('flint_pick'));
    made.push(...make('fire_drill'));
    made.push(...make('campfire'));
    expect(made).toEqual([
      'stone_hammer', 'stone_axe', 'cord', 'cord', 'cord', 'cord', 'cord', 'flint_knife', 'flint_axe', 'flint_pick',
      'fire_drill', 'campfire',
    ]);
    const handSeconds = made.reduce((s, id) => s + getRecipe(id).seconds, 0);
    expect(handSeconds).toBe(28);
    for (const k of ['rock', 'flint', 'obsidian_shard', 'plant_fibre', 'cord', 'stick', 'birch_bark']) expect(pack.count(k), k).toBe(0);
    const kit = pack.slots.filter(Boolean).map((s) => s.k).sort();
    expect(kit).toEqual(['campfire', 'fire_drill', 'flint_axe', 'flint_knife', 'flint_pick', 'stone_hammer', 'stone_axe'].sort());
    // The tools that were needed took their wear: the stone hammer struck 4 times (stone axe, knife, axe, pick).
    expect(pack.slots[slotOf(pack, 'stone_hammer')].d).toBe(getItem('stone_hammer').tool.durability - 4);
  });

  it('the flint pick cuts a STONE cell in 1.5 s (§6.3)', () => {
    const pickSlot = slotOf(pack, 'flint_pick');
    expect(breakSeconds(B.STONE, toolIn(pack, pickSlot), false)).toBeCloseTo(1.5, 10);
    const before = pack.count('rock');
    const held = digAt(0, GROUND - 1, 2, pickSlot);
    expect(held).toBeGreaterThanOrEqual(1.5 - 1e-9);
    expect(held).toBeLessThan(1.5 + 2 * FRAME);
    expect(pack.count('rock')).toBe(before + 2);
    expect(world.getBlock(0, GROUND - 1, 2)).toBe(B.AIR);
  });

  it('drinks at a fake pond with all nine hotbar slots full (§4.2: R needs no empty hand)', () => {
    for (let i = 0; i < HOTBAR_SIZE; i++) if (!pack.slots[i]) pack.setSlot(i, { k: 'honeyberries', n: 3 });
    expect(pack.slots.slice(0, HOTBAR_SIZE).every(Boolean)).toBe(true);
    // A pond cell 2 away in front of the pond floor (the normal hit, 3 away): the water ray is nearer.
    const water = { q: 3, y: GROUND, r: 0, blockId: B.WATER, distance: 2 };
    const floor = { q: 3, y: GROUND - 1, r: 0, blockId: B.CLAY, distance: 3 };
    survival.vitals.hydration = 50;
    for (let sel = 0; sel < HOTBAR_SIZE; sel++) {
      const act = interactKind({ hit: floor, waterHit: water, selectedKey: pack.slots[sel].k, pack, salty: () => false });
      expect(act.kind, pack.slots[sel].k).toBe('drink');
      expect(act.salty).toBe(false);
    }
    expect(survival.drink(false, () => 0.99)).toBe('');
    expect(survival.vitals.hydration).toBe(58);
    expect(survival.drink(true, () => 0.99)).toBe('Salt water only makes you thirstier.');
    expect(survival.vitals.hydration).toBe(54);
  });

  it('pork roasts on a skewer; the fire burns its 300 s down to a cold pit that keeps what is on it (§4.4)', () => {
    const fires = new FireSlots();
    const at = [5, GROUND + 1, 5];
    world.setBlock(...at, B.CAMPFIRE);
    fires.light(...at, CAMPFIRE_FUEL_START_S); // placed in Survival: 300 s of fuel
    const burning = (q, y, r) => world.getBlock(q, y, r) === B.CAMPFIRE;
    const loaded = () => true;
    const [fx, fz] = hexToWorld(at[0], at[2]);
    expect(fires.put(...at, 'raw_pork', Math.atan2(0 - fz, 0 - fx))).toBeGreaterThanOrEqual(0);
    let t = 0;
    const run = (seconds) => {
      const out = [];
      for (let i = 0; i < Math.round(seconds / 0.5); i++) {
        const ev = fires.step(0.5, burning, loaded);
        t += 0.5;
        for (const cell of ev.burntOut) {
          out.push([t, cell]);
          const prev = world.getBlock(...cell);
          world.setBlock(...cell, B.FIRE_PIT); // main writes the pit (a plain write) …
          fires.onBlockChange(...cell, prev, B.FIRE_PIT); // … and onBlockChange keeps the spots
        }
      }
      return out;
    };
    run(20);
    expect(fires.view(...at).spots.filter(Boolean).map((s) => s.k)).toEqual(['roast_pork']);
    expect(fires.takeReady(...at)).toEqual([{ k: 'roast_pork', n: 1 }]);
    run(200); // t = 220
    expect(fires.put(...at, 'raw_pork', 0)).toBeGreaterThanOrEqual(0);
    expect(run(79)).toEqual([]); // t = 299: still burning
    const out = run(1);
    expect(out).toEqual([[300, at]]); // burnt out exactly once, at 300 s
    expect(world.getBlock(...at)).toBe(B.FIRE_PIT);
    expect(run(60)).toEqual([]); // a pit never burns out again, and nothing cooks on it
    expect(fires.view(...at).spots.filter(Boolean).map((s) => s.k)).toEqual(['charred_meat']); // roast at 240, charred at 280
    const act = interactKind({ hit: { q: at[0], y: at[1], r: at[2], blockId: B.FIRE_PIT }, selectedKey: null, pack, fireView: (q, y, r) => fires.view(q, y, r) });
    expect(act.kind).toBe('pit_take');
  });

  it('a 25-cell fall kills through pendingDeath; the belongings hold everything; waking gives the waking values', () => {
    const getBlock = world.getBlock;
    const [x, z] = hexToWorld(20, 20);
    const player = createPlayer(x, GROUND + 1, z);
    let pendingDeath = null;
    const env = { player, softFactor: 1, climate: PLAINS_NOON, time: 0.5, random: () => 0.99 };
    // Standing first clears the fall grace a survival state starts with (any landing does).
    for (let i = 0; i < 5; i++) {
      stepPlayer(player, IDLE, getBlock, FRAME);
      survival.step(FRAME, env);
    }
    expect(survival.fallGrace).toBe(false);
    survival.vitals.health = 100;
    survival.vitals.satiation = 40;
    survival.vitals.hydration = 70;
    player.y = GROUND + 1 + 25;
    player.onGround = false;
    for (let f = 0; f < 600 && pendingDeath === null; f++) {
      stepPlayer(player, IDLE, getBlock, FRAME);
      const ev = survival.step(FRAME, env); // landSpeed is consumed here
      if (ev.died) pendingDeath ??= ev.died; // main: the death waits for the checkpoint
    }
    expect(pendingDeath).toBe('fall');
    expect(survival.dead).toBe('fall');
    expect(survival.active).toBe(false);
    expect(player.landSpeed).toBe(0); // consumed
    const atDeath = { satiation: survival.vitals.satiation, hydration: survival.vitals.hydration };
    expect(atDeath.satiation).toBeLessThan(50); // the fall took a few seconds of drain
    expect(atDeath.hydration).toBeGreaterThan(50);

    // die('fall') at the checkpoint: every stack into Your Belongings.
    const carried = pack.export();
    const total = (stacks) => {
      const m = new Map();
      for (const s of stacks) if (s) m.set(s.k, (m.get(s.k) ?? 0) + s.n);
      return m;
    };
    const before = total([...carried.pack, ...carried.wear]);
    const stacks = pack.dumpAll();
    const [fq, fr] = worldToHex(player.x, player.z);
    const cell = chooseBelongingsCell(getBlock, fq, Math.floor(player.y + 1e-3), fr);
    expect(cell).toEqual([fq, GROUND + 1, fr]); // on the ground where the player fell
    expect(isSolid(getBlock(cell[0], cell[1] - 1, cell[2]))).toBe(true);
    world.setBlock(...cell, B.REMAINS);
    const remains = new Containers();
    expect(remains.addRemains(...cell, stacks)).toEqual([]);
    expect(total(remains.contents(...cell))).toEqual(before);
    expect(pack.isEmpty()).toBe(true);
    const text = deathScreenText('fall', cell);
    expect(text.title).toBe('The ground came up too fast.');
    expect(text.detail).toBe('Your belongings lie where you fell.');
    expect(text.where).toBe(`Your belongings lie at q ${cell[0]}, r ${cell[2]}, height ${cell[1]}.`);

    // Wake up (§2.1 waking values).
    survival.respawn();
    expect(survival.dead).toBe(null);
    expect(survival.active).toBe(true);
    expect(survival.fallGrace).toBe(true);
    const v = survival.vitals;
    // Health 60; Nourishment and Hydration at least 50 (never a starvation loop), kept when higher; 37 °C, full breath.
    expect([v.health, v.satiation, v.hydration, v.temp, v.breath, v.wet, v.sick, v.heal])
      .toEqual([60, 50, atDeath.hydration, 37, 20, 0, 0, 0]);
    // R on the belongings takes everything back.
    const back = remains.takeAll(...cell, pack);
    expect(back.empty).toBe(true);
    expect(total(pack.export().pack)).toEqual(total([...carried.pack]));
  });
});

describe('the cold pit\'s crosshair hint (§4.4, §9.5): what interactKind decides is what the HUD shows', () => {
  const pit = { q: 2, y: GROUND + 1, r: 3, blockId: B.FIRE_PIT };
  /** The HUD line main.survivalHintText builds for R on a cold pit, with `holds` in the pack and nothing on the pit. */
  function hintWith(holds) {
    const pack = new Pack();
    pack.addAll(holds);
    const act = interactKind({ hit: pit, selectedKey: null, pack, fireView: () => null });
    return { kind: act.kind, text: pitHintText(act, '') };
  }

  it('names what the relight still lacks (play-test round 2: the HUD showed the generic relight hint whatever the pack held)', () => {
    expect(hintWith([])).toEqual({ kind: 'pit_hint', text: 'Cold Fire Pit · relight needs a fire drill, tinder and 3 more sticks' });
    expect(hintWith([{ k: 'fire_drill', n: 1 }, { k: 'stick', n: 2 }]))
      .toEqual({ kind: 'pit_hint', text: 'Cold Fire Pit · relight needs tinder and 1 more stick' });
    expect(hintWith([{ k: 'fire_drill', n: 1 }, { k: 'stick', n: 2 }, { k: 'plant_fibre', n: 1 }]))
      .toEqual({ kind: 'pit_hint', text: 'Cold Fire Pit · relight needs 1 more stick' });
  });

  it('with the whole kit it is the relight hint itself, and a pit with something on it offers to take it', () => {
    expect(hintWith([{ k: 'fire_drill', n: 1 }, { k: 'stick', n: 3 }, { k: 'plant_fibre', n: 1 }])).toEqual({ kind: 'pit_relight', text: HINT.pit });
    expect(pitHintText({ kind: 'pit_take', q: 2, y: GROUND + 1, r: 3 }, '1 done')).toBe('Cold Fire Pit · 1 done · R: take');
    expect(pitHintText({ kind: 'pit_take', q: 2, y: GROUND + 1, r: 3 }, '')).toBe('Cold Fire Pit · R: take');
  });
});

describe('dig dust and pick motes take the block\'s colour (particles.blockParticleColor)', () => {
  it('short blocks with the all-clear top (PLANT_TOP_CLEAR) use their side tile, never black', () => {
    for (const id of [B.TUSSOCK, B.TUBER_PLANT, B.LOOSE_STONES, B.FALLEN_BRANCHES, B.FIRE_PIT]) {
      const c = blockParticleColor(id);
      expect(c[0] + c[1] + c[2], `block ${id}`).toBeGreaterThan(0.15);
    }
    // A block with an opaque top keeps its top colour (grass stays green-tinted, stone grey).
    const grass = blockParticleColor(B.GRASS_BLOCK);
    expect(grass[1]).toBeGreaterThan(grass[0]);
  });
});

describe('chat lines about stacks (§4.5, §5.3)', () => {
  it('one of a plural-named item reads as one: "1 Honeyberry went bad.", "2 Honeyberries and 1 Acorn went bad."', () => {
    expect(spoiledText([{ k: 'honeyberries', n: 1 }])).toBe('1 Honeyberry went bad.');
    expect(spoiledText([{ k: 'honeyberries', n: 2 }, { k: 'acorns', n: 1 }])).toBe('2 Honeyberries and 1 Acorn went bad.');
    expect(spoiledText([{ k: 'raw_pork', n: 1 }])).toBe('1 Raw Pork went bad.');
    expect(stacksText([{ k: 'rock', n: 2 }, { k: 'flint', n: 1 }])).toBe('2 Rock and 1 Flint');
  });
});
