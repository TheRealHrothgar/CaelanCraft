// The tool progression stone → flint → copper → bronze → iron → steel, walked end to end against the pure modules with a
// real Pack and CraftQueue (CONTRACTS §43–§47, DESIGN-survival §6–§7, the Handbook's Ages chapter). From the Survival
// play-test (review lens: progression); the last block holds the fixes that test found.
import { describe, it, expect } from 'vitest';
import { BLOCK } from '../../src/blocks.js';
import { Pack } from '../../src/inventory.js';
import { getItem, TIER_SPEED } from '../../src/items.js';
import { breakSeconds, rollDrops, harvestHint, canHarvest } from '../../src/harvest.js';
import { CraftQueue, findStations, listRecipes, getRecipe } from '../../src/crafting.js';
import { STATION_RANGE, STATION_WORK_RANGE, PACK_SLOTS } from '../../src/config.js';
import { interactKind } from '../../src/survivalControl.js';
import { makeGetBlock } from '../helpers/fixtures.js';

const tool = (k) => getItem(k).tool;
const rnd = () => 0.999; // no chance drops, the MAXIMUM of every range
const lucky = () => 0.0; // every chance drop, the MINIMUM of every range

/** Run `q` until every lane is empty (or `maxS` passes). Collects events. */
function runLane(q, pack, world, feet, maxS = 10_000) {
  const ev = { done: [], failed: [], broke: [], lost: [], messages: [] };
  let t = 0;
  while (q.size > 0 && t < maxS) {
    const e = q.step(1, pack, world, feet);
    for (const k of Object.keys(ev)) ev[k].push(...e[k]);
    t += 1;
  }
  return { ev, t };
}

function make(q, pack, stations, id, times = 1) {
  const res = q.enqueue(id, times, pack, stations);
  if (!res.ok) throw new Error(`enqueue ${id}: ${res.message}`);
  return res;
}

describe('the ore gates and break times (§6.3, handbook §5)', () => {
  it('each ore needs exactly the pick of the age before it, and the hint names it', () => {
    expect(canHarvest(BLOCK.STONE, tool('stone_axe'))).toBe(false);
    expect(canHarvest(BLOCK.STONE, tool('flint_pick'))).toBe(true);
    expect(canHarvest(BLOCK.COPPER_ORE, tool('flint_pick'))).toBe(true);
    expect(canHarvest(BLOCK.COAL_ORE, tool('flint_pick'))).toBe(true);
    expect(canHarvest(BLOCK.TIN_ORE, tool('flint_pick'))).toBe(false);
    expect(canHarvest(BLOCK.TIN_ORE, tool('copper_pick'))).toBe(true);
    expect(canHarvest(BLOCK.IRON_ORE, tool('copper_pick'))).toBe(false);
    expect(canHarvest(BLOCK.IRON_ORE, tool('bronze_pick'))).toBe(true);
    // v0.14 (§77): the iron pick opens gold and the steel pick gems, so every pick opens something
    expect(canHarvest(BLOCK.GOLD_ORE, tool('bronze_pick'))).toBe(false);
    expect(canHarvest(BLOCK.GOLD_ORE, tool('iron_pick'))).toBe(true);
    expect(canHarvest(BLOCK.DIAMOND_ORE, tool('iron_pick'))).toBe(false);
    expect(canHarvest(BLOCK.DIAMOND_ORE, tool('steel_pick'))).toBe(true);
    expect(canHarvest(BLOCK.OBSIDIAN, tool('flint_pick'))).toBe(true); // volcanic glass knaps like flint: it stays early
    expect(harvestHint(BLOCK.TIN_ORE)).toBe('Tin Ore · needs a copper pick or better');
    expect(harvestHint(BLOCK.IRON_ORE)).toBe('Iron Ore · needs a bronze pick or better');
    expect(harvestHint(BLOCK.GOLD_ORE)).toBe('Gold Ore · needs an iron pick or better');
    expect(harvestHint(BLOCK.DIAMOND_ORE)).toBe('Diamond Ore · needs a steel pick or better');
    // … and clay needs a shovel: the Wooden Shovel is what gates the Kiln
    expect(canHarvest(BLOCK.CLAY, null)).toBe(false);
    expect(canHarvest(BLOCK.CLAY, tool('stone_axe'))).toBe(false);
    expect(canHarvest(BLOCK.CLAY, tool('wooden_shovel'))).toBe(true);
    expect(harvestHint(BLOCK.CLAY)).toBe('Clay · needs a wooden shovel or better');
    // a hammer, shovel or axe of a high tier never stands in for the pick
    expect(canHarvest(BLOCK.STONE, tool('steel_axe'))).toBe(false);
    expect(canHarvest(BLOCK.IRON_ORE, tool('steel_hammer'))).toBe(false);
  });

  it('break times match the handbook examples', () => {
    expect(breakSeconds(BLOCK.STONE, tool('flint_pick'))).toBeCloseTo(1.5);
    expect(breakSeconds(BLOCK.STONE, tool('bronze_pick'))).toBeCloseTo(3 / 3.4);
    expect(breakSeconds(BLOCK.IRON_ORE, tool('bronze_pick'))).toBeCloseTo(5 / 3.4);
    expect(breakSeconds(BLOCK.OBSIDIAN, tool('flint_pick'))).toBeCloseTo(1.25);
    expect(breakSeconds(BLOCK.OAK_LOG, tool('steel_axe'))).toBeCloseTo(0.5);
    expect(breakSeconds(BLOCK.OAK_LOG, tool('stone_axe'))).toBeCloseTo(2);
    expect(breakSeconds(BLOCK.DIRT, tool('wooden_shovel'))).toBeCloseTo(0.6);
    expect(breakSeconds(BLOCK.COPPER_ORE, tool('flint_pick'))).toBeCloseTo(2);
    expect(breakSeconds(BLOCK.TIN_ORE, tool('copper_pick'))).toBeCloseTo(4 / 2.6);
    expect(TIER_SPEED).toEqual([1, 1.5, 2, 2.6, 3.4, 4.5, 6]);
  });

  it('ore drops: malachite 1–2, cassiterite 1 (+25 %), hematite 1–2; natural does not matter for ores', () => {
    expect(rollDrops(BLOCK.COPPER_ORE, tool('flint_pick'), { natural: false }, rnd)).toEqual([{ k: 'malachite', n: 2 }]);
    expect(rollDrops(BLOCK.COPPER_ORE, tool('flint_pick'), { natural: true }, lucky)).toEqual([{ k: 'malachite', n: 1 }]);
    expect(rollDrops(BLOCK.TIN_ORE, tool('copper_pick'), { natural: false }, rnd)).toEqual([{ k: 'cassiterite', n: 1 }]);
    expect(rollDrops(BLOCK.TIN_ORE, tool('copper_pick'), { natural: false }, lucky)).toEqual([{ k: 'cassiterite', n: 2 }]);
    expect(rollDrops(BLOCK.IRON_ORE, tool('bronze_pick'), { natural: false }, lucky)).toEqual([{ k: 'hematite', n: 1 }]);
    expect(rollDrops(BLOCK.TIN_ORE, tool('flint_pick'), { natural: true }, lucky)).toEqual([]);
  });
});

describe('the whole ladder, scripted with a real Pack and CraftQueue', () => {
  // A flat world: ground at y 63, the player's feet at (0, 64, 0). Stations are placed beside the player.
  const cells = new Map();
  const world = makeGetBlock(cells, BLOCK.AIR);
  const feet = [0, 64, 0];
  const put = (q, y, r, id) => cells.set(`${q},${y},${r}`, id);
  const stationsNow = () => findStations(world, feet[0], feet[1], feet[2]);

  it('walks from bare hands to a steel pick; every gate is passed only with the tool of the age before', () => {
    const pack = new Pack();
    const q = new CraftQueue();

    // 1. Hands: what the first day gathers (worst rolls: loose stones 1 rock, flint only when lucky)
    expect(rollDrops(BLOCK.LOOSE_STONES, null, { natural: true }, lucky)).toEqual([{ k: 'rock', n: 1 }, { k: 'flint', n: 1 }]);
    expect(rollDrops(BLOCK.LOOSE_STONES, null, { natural: false }, lucky)).toEqual([{ k: 'rock', n: 1 }]); // placed and re-dug: no flint
    expect(rollDrops(BLOCK.FALLEN_BRANCHES, null, {}, rnd)).toEqual([{ k: 'stick', n: 3 }]);
    expect(rollDrops(BLOCK.TUSSOCK, null, {}, lucky)).toEqual([{ k: 'plant_fibre', n: 1 }]);
    expect(rollDrops(BLOCK.GRAVEL, null, {}, rnd)).toEqual([{ k: 'rock', n: 2 }]);
    pack.add({ k: 'rock', n: 9 });
    pack.add({ k: 'flint', n: 4 });
    pack.add({ k: 'plant_fibre', n: 11 });
    pack.add({ k: 'stick', n: 8 });

    // 2. Stone, flint
    expect(q.enqueue('stone_axe', 1, pack, stationsNow()).ok).toBe(false); // needs a hammer first
    make(q, pack, stationsNow(), 'stone_hammer');
    runLane(q, pack, world, feet);
    make(q, pack, stationsNow(), 'cord', 5);
    make(q, pack, stationsNow(), 'stone_axe');
    runLane(q, pack, world, feet);
    expect(q.enqueue('flint_pick', 1, pack, stationsNow()).ok).toBe(true);
    make(q, pack, stationsNow(), 'flint_axe');
    make(q, pack, stationsNow(), 'flint_knife');
    runLane(q, pack, world, feet);
    expect(pack.hasTool('pick', 2)).toBe(true);
    expect(pack.hasTool('axe', 2)).toBe(true);
    expect(pack.count('flint')).toBe(0);
    expect(pack.count('rock')).toBe(6); // 1 stone hammer + 2 chopper

    // 3. Wood: a log needs axe ≥ 1; the stump is a hand recipe
    expect(canHarvest(BLOCK.OAK_LOG, null)).toBe(false);
    expect(canHarvest(BLOCK.OAK_LOG, tool('stone_axe'))).toBe(true);
    pack.add({ k: 'oak_log', n: 20 });
    expect(q.enqueue('split_sticks', 1, pack, stationsNow()).message).toContain('build a Work Stump nearby');
    make(q, pack, stationsNow(), 'work_stump');
    runLane(q, pack, world, feet);
    expect(pack.count('work_stump')).toBe(1);
    put(2, 64, 0, BLOCK.WORK_STUMP);
    pack.take('work_stump', 1);
    expect(stationsNow().stump).toEqual([2, 64, 0]);
    expect(q.enqueue('oak_planks', 1, pack, stationsNow()).ok).toBe(true); // flint axe (tier 2)
    make(q, pack, stationsNow(), 'split_sticks', 2);
    runLane(q, pack, world, feet);
    expect(pack.count('oak_planks')).toBe(3);
    expect(pack.count('stick')).toBeGreaterThanOrEqual(12);

    // 4. Clay and the Kiln (a hand recipe, no tool) — but clay needs a shovel, and the first shovel needs the axe (§77)
    expect(rollDrops(BLOCK.CLAY, null, {}, rnd)).toEqual([]);
    make(q, pack, stationsNow(), 'wooden_shovel');
    runLane(q, pack, world, feet);
    expect(pack.hasTool('shovel', 1)).toBe(true);
    expect(rollDrops(BLOCK.CLAY, tool('wooden_shovel'), {}, rnd)).toEqual([{ k: 'clay_lump', n: 6 }]);
    pack.add({ k: 'clay_lump', n: 32 });
    pack.add({ k: 'rock', n: 10 });
    make(q, pack, stationsNow(), 'kiln');
    make(q, pack, stationsNow(), 'greenware_crucible');
    make(q, pack, stationsNow(), 'greenware_mold');
    make(q, pack, stationsNow(), 'green_brick', 5);
    runLane(q, pack, world, feet);
    expect(pack.count('kiln')).toBe(1);
    expect(pack.count('green_brick')).toBe(15);
    put(-2, 64, 0, BLOCK.KILN);
    pack.take('kiln', 1);
    expect(stationsNow().kiln).toEqual([-2, 64, 0]);

    // 5. Charcoal (no other fuel), the crucible and the mold (fuel)
    expect(q.enqueue('crucible', 1, pack, stationsNow()).message).toContain('missing Fuel');
    make(q, pack, stationsNow(), 'charcoal'); // 6 logs → 8 charcoal in 40 s
    const ch = runLane(q, pack, world, feet);
    expect(ch.t).toBe(40);
    expect(pack.count('charcoal')).toBe(8);
    make(q, pack, stationsNow(), 'crucible');
    make(q, pack, stationsNow(), 'casting_mold');
    runLane(q, pack, world, feet);
    expect(pack.hasTool('crucible', 0)).toBe(true);
    expect(pack.hasTool('mold', 0)).toBe(true);
    expect(pack.count('charcoal')).toBe(6);

    // 6. Copper: ore with the flint pick, 2 malachite + 2 COAL → ingot (§77: charcoal will not smelt ore); the copper pick
    // is cast with crucible + mold
    expect(canHarvest(BLOCK.COPPER_ORE, tool('flint_pick'))).toBe(true);
    expect(canHarvest(BLOCK.COAL_ORE, tool('flint_pick'))).toBe(true);
    pack.add({ k: 'malachite', n: 20 });
    expect(pack.count('charcoal')).toBe(6);
    expect(q.enqueue('copper_ingot', 1, pack, stationsNow()).message).toContain('missing Coal'); // charcoal alone is no use
    pack.add({ k: 'coal', n: 30 });
    expect(q.enqueue('copper_pick', 1, pack, stationsNow()).message).toContain('missing Copper Ingot');
    make(q, pack, stationsNow(), 'copper_ingot', 5);
    runLane(q, pack, world, feet);
    expect(pack.count('copper_ingot')).toBe(5);
    expect(pack.count('coal')).toBe(20); // 2 coal an ingot; the charcoal is untouched
    expect(pack.count('charcoal')).toBe(6);
    make(q, pack, stationsNow(), 'copper_pick');
    const cast = runLane(q, pack, world, feet);
    expect(cast.t).toBe(25);
    expect(pack.hasTool('pick', 3)).toBe(true);
    expect(pack.slots.find((s) => s && s.k === 'crucible').d).toBe(19); // 1 wear each
    expect(pack.slots.find((s) => s && s.k === 'casting_mold').d).toBe(11);
    expect(pack.count('copper_ingot')).toBe(3);

    // 7. Bronze: tin needs the copper pick; 7 : 1 in the crucible → 8
    expect(canHarvest(BLOCK.TIN_ORE, tool('copper_pick'))).toBe(true);
    pack.add({ k: 'cassiterite', n: 2 });
    pack.add({ k: 'malachite', n: 8 });
    make(q, pack, stationsNow(), 'tin_ingot');
    make(q, pack, stationsNow(), 'copper_ingot', 4);
    runLane(q, pack, world, feet);
    expect(pack.count('copper_ingot')).toBe(7);
    expect(pack.count('tin_ingot')).toBe(1);
    make(q, pack, stationsNow(), 'bronze_ingot');
    const br = runLane(q, pack, world, feet);
    expect(br.t).toBe(45);
    expect(pack.count('bronze_ingot')).toBe(8);
    expect(pack.count('copper_ingot')).toBe(0);
    make(q, pack, stationsNow(), 'bronze_pick'); // 2 + 2 sticks
    make(q, pack, stationsNow(), 'bronze_hammer'); // 2 + 1 stick
    runLane(q, pack, world, feet);
    expect(pack.hasTool('pick', 4)).toBe(true);
    expect(pack.hasTool('hammer', 4)).toBe(true);
    expect(pack.count('bronze_ingot')).toBe(4);

    // 8. Iron ore needs the bronze pick. The Bloomery: 18 fired brick + 3 clay + bellows (leather, planks, knife ≥ 2)
    expect(canHarvest(BLOCK.IRON_ORE, tool('bronze_pick'))).toBe(true);
    pack.add({ k: 'green_brick', n: 30 }); // 45 in all → 7 batches of 6 = 42 fired
    make(q, pack, stationsNow(), 'fired_brick', 5);
    runLane(q, pack, world, feet);
    make(q, pack, stationsNow(), 'fired_brick', 2);
    runLane(q, pack, world, feet);
    expect(pack.count('fired_brick')).toBe(42);
    pack.add({ k: 'rawhide', n: 3 });
    pack.add({ k: 'pig_fat', n: 3 });
    make(q, pack, stationsNow(), 'leather', 3);
    runLane(q, pack, world, feet);
    expect(pack.count('leather')).toBe(3);
    expect(q.enqueue('bellows', 1, pack, stationsNow()).ok).toBe(true);
    runLane(q, pack, world, feet);
    expect(pack.count('bellows')).toBe(1);
    expect(q.enqueue('forge', 1, pack, stationsNow()).message).toContain('missing Wrought Iron Bar');
    make(q, pack, stationsNow(), 'bloomery');
    runLane(q, pack, world, feet);
    expect(pack.count('bloomery')).toBe(1);
    expect(pack.count('bellows')).toBe(0);
    put(0, 64, 2, BLOCK.BLOOMERY);
    pack.take('bloomery', 1);
    expect(stationsNow().bloomery).toEqual([0, 64, 2]);

    // 9. Blooms and wrought iron (bronze hammer); charcoal only
    pack.add({ k: 'hematite', n: 12 });
    pack.take('coal', pack.count('coal'));
    expect(pack.count('charcoal')).toBe(4); // 7 brick batches burnt the last 5 coal, then 2 charcoal
    pack.add({ k: 'charcoal', n: 30 });
    make(q, pack, stationsNow(), 'iron_bloom', 4);
    runLane(q, pack, world, feet);
    expect(pack.count('iron_bloom')).toBe(4);
    make(q, pack, stationsNow(), 'wrought_iron', 4);
    runLane(q, pack, world, feet);
    expect(pack.count('wrought_iron')).toBe(4);
    expect(pack.slots.find((s) => s && s.k === 'bronze_hammer').d).toBe(316);

    // 10. The Forge: 24 bricks + 3 wrought iron + bellows (a second bellows: 3 more leather, 3 planks, a cord)
    pack.add({ k: 'rawhide', n: 3 });
    pack.add({ k: 'pig_fat', n: 3 });
    pack.add({ k: 'plant_fibre', n: 2 });
    make(q, pack, stationsNow(), 'leather', 3);
    make(q, pack, stationsNow(), 'oak_planks');
    make(q, pack, stationsNow(), 'cord');
    runLane(q, pack, world, feet);
    make(q, pack, stationsNow(), 'bellows');
    runLane(q, pack, world, feet);
    make(q, pack, stationsNow(), 'forge');
    runLane(q, pack, world, feet);
    expect(pack.count('forge')).toBe(1);
    expect(pack.count('wrought_iron')).toBe(1);
    expect(pack.count('fired_brick')).toBe(0);
    put(0, 64, -2, BLOCK.FORGE);
    pack.take('forge', 1);
    expect(stationsNow().forge).toEqual([0, 64, -2]);

    // 11. Iron tools need hammer ≥ 4; steel needs hammer ≥ 5 (the iron hammer); steel tools likewise
    pack.add({ k: 'wrought_iron', n: 8 });
    expect(q.enqueue('steel_bar', 1, pack, stationsNow()).message).toContain('needs an iron hammer or better');
    make(q, pack, stationsNow(), 'iron_hammer');
    runLane(q, pack, world, feet);
    expect(pack.hasTool('hammer', 5)).toBe(true);
    make(q, pack, stationsNow(), 'steel_bar', 2);
    runLane(q, pack, world, feet);
    expect(pack.count('steel_bar')).toBe(2);
    make(q, pack, stationsNow(), 'steel_pick');
    runLane(q, pack, world, feet);
    expect(pack.hasTool('pick', 6)).toBe(true);
    // the iron hammer, not the bronze one, is the one worn by the steel jobs (lowest qualifying tier)
    expect(pack.slots.find((s) => s && s.k === 'iron_hammer').d).toBe(597);
    expect(breakSeconds(BLOCK.IRON_ORE, tool('steel_pick'))).toBeCloseTo(5 / 6);
  });

  it('lanes: a kiln job waits past 16 cells and resumes; the hand lane never waits; a broken kiln fails its job and keeps the inputs', () => {
    const pack = new Pack();
    const q = new CraftQueue();
    pack.add({ k: 'oak_log', n: 12 });
    pack.add({ k: 'plant_fibre', n: 4 });
    put(-2, 64, 0, BLOCK.KILN);
    const st = findStations(world, 0, 64, 0);
    expect(st.kiln).toEqual([-2, 64, 0]);
    make(q, pack, st, 'charcoal');
    make(q, pack, st, 'cord');
    const far = [STATION_WORK_RANGE + 1, 64, 0]; // hexDistance from (-2, 0) = 19 > 16
    let e = q.step(5, pack, world, far);
    expect(q.lanes().find((l) => l.station === 'kiln').jobs[0]).toMatchObject({ waiting: true, reason: 'Kiln too far', progress: 0 });
    expect(e.done.map((d) => d.id)).toEqual(['cord']);
    const edge = [STATION_WORK_RANGE - 2, 64, 0]; // distance 16: still working
    q.step(10, pack, world, edge);
    expect(q.lanes()[0].jobs[0]).toMatchObject({ waiting: false, secondsLeft: 30 });
    cells.set('-2,64,0', BLOCK.AIR);
    e = q.step(1, pack, world, [0, 64, 0]);
    expect(e.messages).toEqual(["Couldn't make Charcoal: the Kiln is gone."]);
    expect(pack.count('oak_log')).toBe(12); // nothing was taken
    cells.set('-2,64,0', BLOCK.KILN);
  });

  it('the recipe list doubles as the tech tree: far stations greyed with a hint, craftable first', () => {
    const pack = new Pack();
    pack.add({ k: 'rock', n: 2 });
    const views = listRecipes(pack, { hand: true }, {});
    expect(views[0].id).toBe('stone_hammer');
    expect(views[0].craftable).toBe(true);
    const forge = views.find((v) => v.id === 'steel_bar');
    expect(forge.stationOk).toBe(false);
    expect(forge.hint).toBe('build a Forge nearby');
    expect(findStations(world, STATION_RANGE + 1 + 2, 64, 0).kiln).toBeUndefined();
  });
});

describe('what the play-test found and the fixes (progression lens)', () => {
  it('a workplace within R\'s reach but beyond STATION_RANGE is not opened: the crosshair says to step closer', () => {
    // findStations counts a kiln as near within STATION_RANGE 3 of the feet; R reaches REACH 5
    const cells = new Map([['4,64,0', BLOCK.KILN]]);
    const world = makeGetBlock(cells, BLOCK.AIR);
    const stations = findStations(world, 0, 64, 0);
    expect(stations.kiln).toBeUndefined();
    const ctx = {
      hit: { q: 4, y: 64, r: 0, blockId: BLOCK.KILN, distance: 4 }, waterHit: null, headInWater: false, selectedKey: null,
      pack: new Pack(), stationNear: (s) => !!stations[s],
    };
    expect(interactKind(ctx)).toMatchObject({ kind: 'station_far', station: 'kiln', hint: 'Kiln · step within 3 cells to work here' });
    const nearer = findStations(world, 2, 64, 0);
    expect(nearer.kiln).toEqual([4, 64, 0]);
    expect(interactKind({ ...ctx, stationNear: (s) => !!nearer[s] })).toMatchObject({ kind: 'station', hint: 'Kiln · R: open Making' });
  });

  it('a recipe that frees its own slot (scrape_salt) completes in a full pack instead of waiting "Pack full" for ever', () => {
    const pack = new Pack();
    for (let i = 0; i < PACK_SLOTS; i++) pack.setSlot(i, { k: i === 0 ? 'salt_pot' : i === 1 ? 'salt' : 'stone_hammer', n: 1 });
    const q = new CraftQueue();
    expect(q.enqueue('scrape_salt', 1, pack, { hand: true }).ok).toBe(true);
    const e = q.step(60, pack, null, [0, 64, 0]);
    expect(e.done.map((d) => d.id)).toEqual(['scrape_salt']);
    expect(pack.count('salt_pot')).toBe(0);
    expect(pack.count('clay_pot')).toBe(1);
    expect(pack.count('salt')).toBe(2);
  });

  it('× 5 queues more jobs than a tool on its last use can finish; the extra ones fail at completion with nothing lost (left as is)', () => {
    const pack = new Pack();
    pack.add({ k: 'clay_lump', n: 9 });
    pack.add({ k: 'plant_fibre', n: 20 });
    pack.add({ k: 'rock', n: 10 });
    pack.setSlot(5, { k: 'stone_hammer', n: 1, d: 1 }); // one use left
    const q = new CraftQueue();
    const res = q.enqueue('stone_axe', 5, pack, { hand: true });
    expect(res.queued).toBe(5);
    const e = q.step(100, pack, null, [0, 64, 0]);
    expect(e.done.length).toBe(1);
    expect(e.broke).toEqual(['stone_hammer']);
    expect(e.failed.length).toBe(4);
    expect(e.messages[0]).toBe("Couldn't make Stone Axe: missing a stone hammer or better.");
    expect(pack.count('rock')).toBe(8); // only the finished job took its inputs
  });

  it('enqueue × 5 of a recipe whose inputs are tags takes the right reservation (6 #log charcoal twice from 12 logs)', () => {
    const pack = new Pack();
    pack.add({ k: 'oak_log', n: 6 });
    pack.add({ k: 'birch_log', n: 6 });
    const q = new CraftQueue();
    const res = q.enqueue('charcoal', 5, pack, { hand: true, kiln: [-2, 64, 0] });
    expect(res.queued).toBe(2);
    expect(res.message).toContain('no more: missing Any Log');
  });

  it('a Kiln breaks by hand (pick tier 0) and gives itself back; a Bloomery or Forge needs a flint pick', () => {
    expect(canHarvest(BLOCK.KILN, null)).toBe(true);
    expect(rollDrops(BLOCK.KILN, null, {}, rnd)).toEqual([{ k: 'kiln', n: 1 }]);
    expect(canHarvest(BLOCK.BLOOMERY, null)).toBe(false);
    expect(canHarvest(BLOCK.BLOOMERY, tool('flint_pick'))).toBe(true);
    expect(rollDrops(BLOCK.FORGE, tool('flint_pick'), {}, rnd)).toEqual([{ k: 'forge', n: 1 }]);
    expect(breakSeconds(BLOCK.KILN, null)).toBe(3);
    expect(breakSeconds(BLOCK.KILN, tool('flint_pick'))).toBe(1.5);
  });

  it('useTool picks the lowest qualifying tier, so a copper hammer in the pack is spared when a stone hammer will do', () => {
    const pack = new Pack();
    pack.add({ k: 'copper_hammer', n: 1 });
    pack.add({ k: 'stone_hammer', n: 1 });
    expect(pack.useTool('hammer', 1)).toEqual({ key: 'stone_hammer', broke: false });
    expect(pack.useTool('hammer', 3)).toEqual({ key: 'copper_hammer', broke: false });
  });

  it('stone_bricks at the stump needs a copper hammer (tier 3) — a bronze hammer qualifies', () => {
    const rec = getRecipe('stone_bricks');
    expect(rec.tools).toEqual([{ type: 'hammer', tier: 3 }]);
  });
});
