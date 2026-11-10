// Unit tests for src/crafting.js — the recipe table, findStations, the recipe list and the craft lanes
// (docs/DESIGN-survival.md §7, §10 C). The pack is a Map-backed fake of PackOps (inventory.js is another package's file).
import { describe, it, expect, vi } from 'vitest';
import { MAX_CRAFT_JOBS, STATION_RANGE, STATION_WORK_RANGE } from '../../src/config.js';
import { BLOCK, UNLOADED } from '../../src/blocks.js';
import { ITEMS, TAGS, TOOL_TYPES, TIER_NAMES, getItem, maxDurability } from '../../src/items.js';
import {
  RECIPES, STATION_IDS, STATION_BLOCKS, STATION_NAMES, TAG_LABELS, getRecipe, recipeName, stationOfBlock, findStations,
  listRecipes, inputLabel, toolLabel, CraftQueue,
} from '../../src/crafting.js';
import { makeGetBlock } from '../helpers/fixtures.js';
import { Pack } from '../../src/inventory.js';
import { PACK_SLOTS } from '../../src/config.js';

// ---------------------------------------------------------------------------------------------
// helpers

/**
 * Map-backed PackOps: plain items by count, tools as separate entries with durability `d`. `full` makes canGive and give
 * refuse everything (a pack with no room). Every call is logged in `log`.
 */
class FakePack {
  /** @param {Record<string, number>} [items] @param {(string|{k: string, d: number})[]} [tools] */
  constructor(items = {}, tools = []) {
    /** @type {Map<string, number>} */
    this.items = new Map();
    for (const [k, n] of Object.entries(items)) this.items.set(k, n);
    /** @type {{k: string, d: number}[]} */
    this.tools = tools.map((t) => (typeof t === 'string' ? { k: t, d: maxDurability(t) } : { ...t }));
    this.full = false;
    /** @type {unknown[][]} */
    this.log = [];
  }

  count(k) {
    if (getItem(k)?.tool) return this.tools.filter((t) => t.k === k).length;
    return this.items.get(k) ?? 0;
  }

  countTag(tag) {
    return TAGS[tag].reduce((s, m) => s + this.count(m), 0);
  }

  take(k, n) {
    const have = this.count(k);
    if (have < n) throw new Error(`FakePack.take(${k}, ${n}): only ${have}`);
    if (have === n) this.items.delete(k);
    else this.items.set(k, have - n);
    this.log.push(['take', k, n]);
  }

  takeTag(tag, n) {
    for (const m of TAGS[tag]) {
      const t = Math.min(n, this.count(m));
      if (t > 0) this.take(m, t);
      n -= t;
    }
  }

  canGive() {
    return !this.full;
  }

  give(k, n) {
    if (this.full) return n;
    if (getItem(k)?.tool) for (let i = 0; i < n; i++) this.tools.push({ k, d: maxDurability(k) });
    else this.items.set(k, this.count(k) + n);
    this.log.push(['give', k, n]);
    return 0;
  }

  _qualifying(type, minTier) {
    return this.tools.filter((t) => getItem(t.k).tool.type === type && getItem(t.k).tool.tier >= minTier);
  }

  hasTool(type, minTier) {
    return this._qualifying(type, minTier).length > 0;
  }

  useTool(type, minTier) {
    const q = this._qualifying(type, minTier).sort((a, b) => getItem(a.k).tool.tier - getItem(b.k).tool.tier || a.d - b.d);
    if (q.length === 0) return null;
    const t = q[0];
    t.d--;
    this.log.push(['wear', t.k]);
    if (t.d <= 0) {
      this.tools.splice(this.tools.indexOf(t), 1);
      return { key: t.k, broke: true };
    }
    return { key: t.k, broke: false };
  }

  /** Every plain item left, as an object (tools excluded). */
  snapshot() {
    return Object.fromEntries([...this.items].filter(([, n]) => n > 0).sort());
  }
}

const KILN_AT = /** @type {[number, number, number]} */ ([2, 10, 0]);
const STUMP_AT = /** @type {[number, number, number]} */ ([-1, 10, 1]);
const PLAYER = /** @type {[number, number, number]} */ ([0, 10, 0]);

/** A world function that holds a kiln and a stump at KILN_AT / STUMP_AT (and AIR elsewhere). */
function stationWorld(extra = {}) {
  return makeGetBlock({ [KILN_AT.join(',')]: BLOCK.KILN, [STUMP_AT.join(',')]: BLOCK.WORK_STUMP, ...extra });
}

/** Run `seconds` of lane time in steps of `dt`. */
function run(queue, pack, seconds, opts = {}) {
  const { dt = 0.1, check = stationWorld(), player = PLAYER } = opts;
  const events = { done: [], failed: [], broke: [], lost: [], messages: [] };
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    const ev = queue.step(dt, pack, check, player);
    for (const k of Object.keys(events)) events[k].push(...ev[k]);
  }
  return events;
}

const isBlockItem = (k) => ITEMS[k].kind === 'block';

// ---------------------------------------------------------------------------------------------

describe('the recipe table (§7.3)', () => {
  it('has 115 recipes with unique ids: 44 at hand, 23 at the stump, 25 at the kiln, 5 at the bloomery and 18 at the forge', () => {
    // §7.3's 89, plus DESIGN-circuits §8.2's 25 (6 at hand, 11 at the stump, 4 at the kiln, 1 at the bloomery, 3 at the forge)
    expect(RECIPES).toHaveLength(115); // + the flint dart (CONTRACTS §60)
    const ids = RECIPES.map((r) => r.id);
    expect(new Set(ids).size).toBe(115);
    const by = {};
    for (const r of RECIPES) by[r.station] = (by[r.station] ?? 0) + 1;
    expect(by).toEqual({ hand: 44, stump: 23, kiln: 25, bloomery: 5, forge: 18 });
    // listed station by station, in lane order
    const order = RECIPES.map((r) => STATION_IDS.indexOf(r.station));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('every input key, tag, output key and tool type exists; counts, tiers and seconds are sane', () => {
    for (const r of RECIPES) {
      expect(STATION_IDS, r.id).toContain(r.station);
      expect(r.inputs.length, r.id).toBeGreaterThan(0);
      for (const inp of r.inputs) {
        if ('tag' in inp) expect(Object.hasOwn(TAGS, inp.tag), `${r.id} #${inp.tag}`).toBe(true);
        else expect(Object.hasOwn(ITEMS, inp.k), `${r.id} ${inp.k}`).toBe(true);
        expect(Number.isInteger(inp.n) && inp.n >= 1, r.id).toBe(true);
      }
      expect(r.outputs.length, r.id).toBeGreaterThan(0);
      for (const out of r.outputs) {
        expect(Object.hasOwn(ITEMS, out.k), `${r.id} → ${out.k}`).toBe(true);
        expect(out.n, r.id).toBeGreaterThanOrEqual(1);
        expect(out.n, `${r.id} fits one stack`).toBeLessThanOrEqual(ITEMS[out.k].stack);
      }
      for (const t of r.tools) {
        expect(TOOL_TYPES, r.id).toContain(t.type);
        expect(t.tier >= 0 && t.tier < TIER_NAMES.length, r.id).toBe(true);
      }
      expect(r.seconds, r.id).toBeGreaterThan(0);
      expect(Object.isFrozen(r) && Object.isFrozen(r.inputs) && Object.isFrozen(r.outputs) && Object.isFrozen(r.tools)).toBe(true);
    }
    expect(Object.isFrozen(RECIPES)).toBe(true);
  });

  it('no recipe that outputs a block item takes 4 or 9 of any one input (the fingerprints of a square grid)', () => {
    const blockRecipes = RECIPES.filter((r) => r.outputs.some((o) => isBlockItem(o.k)));
    expect(blockRecipes.map((r) => r.id).sort()).toEqual([
      'bloomery', 'bricks', 'campfire', 'clay', 'coal_block', 'cobblestone', 'copper_block', 'diamond_block', 'forge',
      'glass', 'remelt_glass', 'gold_block', 'hay_bale', 'ice', 'iron_block', 'kiln', 'birch_planks', 'oak_planks', 'sleeping_hide', 'snow_block',
      'spruce_planks', 'stone_bricks', 'wicker_basket', 'work_stump',
      // DESIGN-circuits §8.2: every circuit part but the Collapsar Charge (Creative only), and the keg
      'powder_fuse', 'torch', 'white_wire', 'brown_wire', 'earth_wire', 'selenium_panel', 'copper_wire', 'powder_keg',
      'terminal_board', 'voltaic_battery', 'knife_switch', 'push_button', 'relay', 'spark_transmitter', 'coherer_receiver', 'igniter',
      'filament_lamp', 'blasting_machine', 'clockwork_timer', 'electric_bell',
    ].sort());
    for (const r of blockRecipes) for (const inp of r.inputs) expect([4, 9], `${r.id}: ${inp.n}`).not.toContain(inp.n);
    // packing many of one thing into a block uses 3, 6 or 7 (12 for loose fibre)
    for (const id of ['cobblestone', 'clay', 'snow_block', 'ice', 'coal_block', 'copper_block', 'gold_block', 'iron_block', 'diamond_block', 'hay_bale']) {
      expect([3, 6, 7, 12], id).toContain(getRecipe(id).inputs[0].n);
    }
  });

  it('matches the §7.3 rows exactly (spot checks across every station)', () => {
    const row = (id) => {
      const r = getRecipe(id);
      return { station: r.station, inputs: r.inputs, outputs: r.outputs, tools: r.tools, seconds: r.seconds };
    };
    expect(row('cord')).toEqual({ station: 'hand', inputs: [{ k: 'plant_fibre', n: 2 }], outputs: [{ k: 'cord', n: 1 }], tools: [], seconds: 1 });
    expect(row('flint_pick')).toEqual({
      station: 'hand', inputs: [{ tag: 'knapstone', n: 2 }, { k: 'stick', n: 1 }, { k: 'cord', n: 2 }],
      outputs: [{ k: 'flint_pick', n: 1 }], tools: [{ type: 'hammer', tier: 1 }], seconds: 5,
    });
    expect(row('campfire')).toEqual({
      station: 'hand', inputs: [{ k: 'rock', n: 6 }, { k: 'stick', n: 3 }, { tag: 'tinder', n: 1 }],
      outputs: [{ k: 'campfire', n: 1 }], tools: [{ type: 'firestarter', tier: 0 }], seconds: 5,
    });
    expect(row('rag_bandage').outputs).toEqual([{ k: 'rag_bandage', n: 1 }, { k: 'clay_pot', n: 1 }]);
    expect(row('leached_acorns')).toMatchObject({ inputs: [{ k: 'acorns', n: 6 }, { k: 'pot_water', n: 1 }], outputs: [{ k: 'leached_acorns', n: 6 }, { k: 'clay_pot', n: 1 }] });
    expect(row('scrape_salt').outputs).toEqual([{ k: 'salt', n: 1 }, { k: 'clay_pot', n: 1 }]);
    expect(row('bloomery').inputs).toEqual([{ k: 'fired_brick', n: 18 }, { k: 'clay_lump', n: 3 }, { k: 'bellows', n: 1 }]);
    expect(row('forge')).toMatchObject({ inputs: [{ k: 'fired_brick', n: 24 }, { k: 'wrought_iron', n: 3 }, { k: 'bellows', n: 1 }], seconds: 15 });
    expect(row('split_sticks')).toEqual({ station: 'stump', inputs: [{ tag: 'log', n: 1 }], outputs: [{ k: 'stick', n: 6 }], tools: [{ type: 'axe', tier: 1 }], seconds: 3 });
    expect(row('oak_planks')).toMatchObject({ inputs: [{ k: 'oak_log', n: 1 }], outputs: [{ k: 'oak_planks', n: 3 }], tools: [{ type: 'axe', tier: 2 }] });
    expect(row('bellows').inputs).toEqual([{ k: 'leather', n: 3 }, { tag: 'planks', n: 3 }, { k: 'cord', n: 1 }]);
    expect(row('stone_bricks').tools).toEqual([{ type: 'hammer', tier: 3 }]);
    expect(row('charcoal')).toEqual({ station: 'kiln', inputs: [{ tag: 'log', n: 6 }], outputs: [{ k: 'charcoal', n: 8 }], tools: [], seconds: 40 });
    expect(row('bronze_ingot')).toEqual({
      station: 'kiln', inputs: [{ k: 'copper_ingot', n: 7 }, { k: 'tin_ingot', n: 1 }, { tag: 'fuel', n: 3 }],
      outputs: [{ k: 'bronze_ingot', n: 8 }], tools: [{ type: 'crucible', tier: 0 }], seconds: 45,
    });
    expect(row('iron_bloom')).toEqual({ station: 'bloomery', inputs: [{ k: 'hematite', n: 3 }, { k: 'charcoal', n: 4 }], outputs: [{ k: 'iron_bloom', n: 1 }], tools: [], seconds: 40 });
    expect(row('glass').inputs).toEqual([{ tag: 'sand', n: 2 }, { k: 'salt', n: 1 }, { k: 'charcoal', n: 1 }]);
    expect(row('steel_bar')).toEqual({ station: 'forge', inputs: [{ k: 'wrought_iron', n: 1 }, { k: 'charcoal', n: 2 }], outputs: [{ k: 'steel_bar', n: 1 }], tools: [{ type: 'hammer', tier: 5 }], seconds: 45 });
    expect(row('diamond_block')).toEqual({ station: 'forge', inputs: [{ k: 'rough_gem', n: 7 }], outputs: [{ k: 'diamond_block', n: 1 }], tools: [{ type: 'hammer', tier: 6 }], seconds: 20 });
  });

  it('metal tools: id = item key, N metal and S sticks by tool, the right fuel, tools and seconds per station', () => {
    const NS = { knife: [1, 1], spade: [1, 1], axe: [2, 1], hammer: [2, 1], pick: [2, 2], sword: [3, 1] };
    const metals = {
      copper: { station: 'kiln', ingot: 'copper_ingot', fuel: { tag: 'fuel', n: 1 }, tools: [{ type: 'crucible', tier: 0 }, { type: 'mold', tier: 0 }], s: 25, kinds: ['knife', 'spade', 'axe', 'hammer', 'pick'] },
      bronze: { station: 'kiln', ingot: 'bronze_ingot', fuel: { tag: 'fuel', n: 1 }, tools: [{ type: 'crucible', tier: 0 }, { type: 'mold', tier: 0 }], s: 30, kinds: Object.keys(NS) },
      iron: { station: 'forge', ingot: 'wrought_iron', fuel: { k: 'charcoal', n: 1 }, tools: [{ type: 'hammer', tier: 4 }], s: 30, kinds: Object.keys(NS) },
      steel: { station: 'forge', ingot: 'steel_bar', fuel: { k: 'charcoal', n: 1 }, tools: [{ type: 'hammer', tier: 5 }], s: 40, kinds: Object.keys(NS) },
    };
    let count = 0;
    for (const [metal, m] of Object.entries(metals)) {
      for (const kind of m.kinds) {
        const id = `${metal}_${kind}`;
        const r = getRecipe(id);
        expect(r, id).not.toBeNull();
        expect(r.outputs).toEqual([{ k: id, n: 1 }]);
        expect(r.station).toBe(m.station);
        expect(r.inputs).toEqual([{ k: m.ingot, n: NS[kind][0] }, { k: 'stick', n: NS[kind][1] }, m.fuel]);
        expect(r.tools).toEqual(m.tools);
        expect(r.seconds).toBe(m.s);
        count++;
      }
    }
    expect(count).toBe(23);
    expect(getRecipe('copper_sword')).toBeNull(); // there is no copper sword
  });

  it('every tool item is made by some recipe (the tech tree has no dead ends)', () => {
    const made = new Set(RECIPES.flatMap((r) => r.outputs.map((o) => o.k)));
    for (const [k, def] of Object.entries(ITEMS)) if (def.kind === 'tool') expect(made.has(k), k).toBe(true);
  });

  it('lookups are safe: getRecipe on garbage, recipeName, station helpers', () => {
    for (const bad of ['nope', '', '__proto__', 'constructor', 'toString', null, undefined, 42]) expect(getRecipe(/** @type {any} */ (bad))).toBeNull();
    expect(recipeName(getRecipe('copper_ingot'))).toBe('Copper Ingot');
    expect(recipeName(getRecipe('pot_snow_ice'))).toBe('Pot of Snow');
    expect(STATION_IDS).toEqual(['hand', 'stump', 'kiln', 'bloomery', 'forge']);
    expect(STATION_BLOCKS).toEqual({ stump: BLOCK.WORK_STUMP, kiln: BLOCK.KILN, bloomery: BLOCK.BLOOMERY, forge: BLOCK.FORGE });
    expect(STATION_NAMES).toEqual({ hand: 'Hands', stump: 'Work Stump', kiln: 'Kiln', bloomery: 'Bloomery', forge: 'Forge' });
    expect(stationOfBlock(BLOCK.KILN)).toBe('kiln');
    expect(stationOfBlock(BLOCK.WORK_STUMP)).toBe('stump');
    expect(stationOfBlock(BLOCK.STONE)).toBeNull();
    expect(stationOfBlock(BLOCK.AIR)).toBeNull();
  });

  it('labels: inputs by item name or tag label, tools by tier and type', () => {
    expect(inputLabel({ k: 'plant_fibre', n: 2 })).toBe('Plant Fibre');
    for (const tag of Object.keys(TAGS)) expect(typeof TAG_LABELS[tag]).toBe('string');
    expect(inputLabel({ tag: 'fuel', n: 1 })).toBe('Fuel');
    expect(inputLabel({ tag: 'knapstone', n: 1 })).toBe('Knapping Stone');
    expect(toolLabel('hammer', 1)).toBe('stone hammer or better');
    expect(toolLabel('knife', 2)).toBe('flint knife or better');
    expect(toolLabel('hammer', 6)).toBe('steel hammer');
    expect(toolLabel('firestarter', 0)).toBe('fire drill');
    expect(toolLabel('crucible', 0)).toBe('crucible');
    expect(toolLabel('mold', 0)).toBe('casting mold');
  });
});

describe('the first day (§7.5): the starting kit', () => {
  it('9 rock, 4 knapstone, 11 plant fibre and 8 sticks make the whole kit in 28 s of hand jobs, with nothing left over', () => {
    const pack = new FakePack({ rock: 9, flint: 4, plant_fibre: 11, stick: 8 });
    const q = new CraftQueue();
    const order = ['hammerstone', 'stone_chopper', 'cord', 'flint_knife', 'flint_axe', 'flint_pick', 'fire_drill', 'campfire'];
    let seconds = 0;
    for (const id of order) {
      const times = id === 'cord' ? 5 : 1;
      const res = q.enqueue(id, times, pack, { hand: true });
      expect(res.ok, `${id}: ${res.message}`).toBe(true);
      expect(res.queued).toBe(times);
      seconds += getRecipe(id).seconds * times;
      // each job runs before the next is queued: the tools it needs only exist once the previous jobs are done
      const ev = run(q, pack, getRecipe(id).seconds * times + 0.0001, { dt: 0.25 });
      expect(ev.failed).toEqual([]);
      expect(q.size).toBe(0);
    }
    expect(seconds).toBe(28);
    expect(pack.snapshot()).toEqual({ campfire: 1 });
    expect(pack.tools.map((t) => t.k).sort()).toEqual(['fire_drill', 'flint_axe', 'flint_knife', 'flint_pick', 'hammerstone', 'stone_chopper']);
    // the hammerstone knapped 4 things (chopper, knife, axe, pick); the drill lit one fire
    expect(pack.tools.find((t) => t.k === 'hammerstone').d).toBe(60 - 4);
    expect(pack.tools.find((t) => t.k === 'fire_drill').d).toBe(8 - 1);
  });
});

describe('findStations', () => {
  it('returns { hand: true } alone when no workplace is near', () => {
    expect(findStations(makeGetBlock({}), 0, 10, 0)).toEqual({ hand: true });
  });

  it('finds each kind within hex distance 3 and |dy| ≤ 2 of the feet cell, and nothing beyond', () => {
    expect(STATION_RANGE).toBe(3);
    const near = makeGetBlock({ '3,12,0': BLOCK.KILN, '0,8,-3': BLOCK.FORGE, '-2,10,2': BLOCK.WORK_STUMP, '1,11,-3': BLOCK.BLOOMERY });
    expect(findStations(near, 0, 10, 0)).toEqual({ hand: true, kiln: [3, 12, 0], forge: [0, 8, -3], stump: [-2, 10, 2], bloomery: [1, 11, -3] });
    // hex distance 4 (q 4, or q 2 r 2), or 3 cells up / down: out of range
    const far = makeGetBlock({ '4,10,0': BLOCK.KILN, '2,10,2': BLOCK.FORGE, '0,13,0': BLOCK.WORK_STUMP, '0,7,1': BLOCK.BLOOMERY });
    expect(findStations(far, 0, 10, 0)).toEqual({ hand: true });
  });

  it('keeps the nearest of each kind: hex distance first, then |dy|', () => {
    const two = makeGetBlock({ '3,10,0': BLOCK.KILN, '1,10,0': BLOCK.KILN, '0,12,-2': BLOCK.FORGE, '0,11,-2': BLOCK.FORGE });
    expect(findStations(two, 0, 10, 0)).toEqual({ hand: true, kiln: [1, 10, 0], forge: [0, 11, -2] });
  });

  it('works at negative coordinates and reads exactly 37 columns × 5 heights (none outside the world)', () => {
    const getBlock = vi.fn(makeGetBlock({ '-101,49,-198': BLOCK.KILN }));
    expect(findStations(getBlock, -100, 50, -200)).toEqual({ hand: true, kiln: [-101, 49, -198] });
    expect(getBlock).toHaveBeenCalledTimes(37 * 5);
    const low = vi.fn(makeGetBlock({}));
    findStations(low, 0, 0, 0);
    expect(low).toHaveBeenCalledTimes(37 * 3);
    for (const call of low.mock.calls) expect(call[1]).toBeGreaterThanOrEqual(0);
  });
});

describe('listRecipes', () => {
  it('sorts craftable first, then by missing input units, then in recipe order', () => {
    const pack = new FakePack({ plant_fibre: 2, rock: 1 });
    const list = listRecipes(pack, { hand: true });
    expect(list).toHaveLength(115);
    expect(list.slice(0, 2).map((r) => r.id)).toEqual(['cord', 'hammerstone']);
    expect(list.filter((r) => r.craftable).map((r) => r.id)).toEqual(['cord', 'hammerstone']);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      if (a.craftable !== b.craftable) expect(a.craftable).toBe(true);
      else if (a.missing !== b.missing) expect(a.missing).toBeLessThan(b.missing);
      else expect(RECIPES.findIndex((r) => r.id === a.id)).toBeLessThan(RECIPES.findIndex((r) => r.id === b.id));
    }
    // one rock short of a chopper (and no hammer yet), one fibre short of a bandage: the "1 missing" group in table order
    const ones = list.filter((r) => !r.craftable && r.missing === 1).map((r) => r.id);
    expect(ones.slice(0, 3)).toEqual(['stone_chopper', 'digging_stick', 'work_stump']);
    expect(ones).toContain('stone_chopper');
    expect(ones).toContain('fibre_bandage');
    expect(ones.indexOf('stone_chopper')).toBeLessThan(ones.indexOf('fibre_bandage'));
  });

  it('describes inputs (have / need, tags summed over members), tools and the station', () => {
    const pack = new FakePack({ oak_log: 2, birch_log: 3, rock: 2 }, ['flint_axe']);
    const list = listRecipes(pack, { hand: true, stump: STUMP_AT });
    const stump = list.find((r) => r.id === 'work_stump');
    expect(stump).toMatchObject({
      station: 'hand', out: { k: 'work_stump', n: 1 }, outputs: [{ k: 'work_stump', n: 1 }], seconds: 4, craftable: true, stationOk: true, missing: 0, hint: '',
      inputs: [{ tag: 'log', label: 'Any Log', need: 1, have: 5 }],
      tools: [{ type: 'axe', tier: 1, label: 'stone axe or better', ok: true }],
    });
    const chopper = list.find((r) => r.id === 'stone_chopper');
    expect(chopper).toMatchObject({ craftable: false, missing: 0, inputs: [{ k: 'rock', label: 'Rock', need: 2, have: 2 }], tools: [{ type: 'hammer', ok: false }] });
    const charcoal = list.find((r) => r.id === 'charcoal');
    expect(charcoal).toMatchObject({ stationOk: false, craftable: false, hint: 'build a Kiln nearby', missing: 1 });
    const planks = list.find((r) => r.id === 'birch_planks');
    expect(planks).toMatchObject({ station: 'stump', stationOk: true, craftable: true, out: { k: 'birch_planks', n: 3 } });
  });

  it('a station that is not near keeps its recipes listed (greyed) but never craftable', () => {
    const pack = new FakePack({ greenware_pot: 1, coal: 1 });
    const without = listRecipes(pack, { hand: true }).find((r) => r.id === 'clay_pot');
    expect(without).toMatchObject({ stationOk: false, craftable: false, missing: 0, hint: 'build a Kiln nearby' });
    const withKiln = listRecipes(pack, { hand: true, kiln: KILN_AT }).find((r) => r.id === 'clay_pot');
    expect(withKiln).toMatchObject({ stationOk: true, craftable: true, hint: '' });
    expect(listRecipes(pack, null).find((r) => r.id === 'cord')).toMatchObject({ stationOk: true });
    expect(listRecipes(pack, { hand: true, kiln: /** @type {any} */ ('nope') }).find((r) => r.id === 'clay_pot').stationOk).toBe(false);
  });

  it('filters by station, and counts what queued jobs reserve as gone', () => {
    const pack = new FakePack({ plant_fibre: 4 });
    expect(listRecipes(pack, { hand: true }, { station: 'kiln' }).map((r) => r.station)).toEqual(new Array(25).fill('kiln'));
    expect(listRecipes(pack, { hand: true }, { station: 'all' })).toHaveLength(115);
    const q = new CraftQueue();
    expect(q.enqueue('fibre_bandage', 1, pack, { hand: true }).ok).toBe(true); // reserves 3 of the 4 fibre
    const cord = listRecipes(pack, { hand: true }, { queue: q }).find((r) => r.id === 'cord');
    expect(cord).toMatchObject({ craftable: false, missing: 1, inputs: [{ k: 'plant_fibre', need: 2, have: 1 }] });
    expect(listRecipes(pack, { hand: true }).find((r) => r.id === 'cord').craftable).toBe(true);
  });
});

describe('CraftQueue: queueing', () => {
  it('queues a hand job; it completes atomically: inputs taken, tools worn and outputs given only at the end', () => {
    const pack = new FakePack({ rock: 3 }, ['hammerstone']);
    const q = new CraftQueue();
    const v0 = q.version;
    expect(q.enqueue('stone_chopper', 1, pack, { hand: true })).toEqual({ ok: true, message: 'Making Stone Chopper', queued: 1 });
    expect(q.version).toBeGreaterThan(v0);
    expect(q.size).toBe(1);
    let ev = q.step(2.9, pack, null, PLAYER);
    expect(ev.done).toEqual([]);
    expect(pack.count('rock')).toBe(3); // nothing taken while it works
    ev = q.step(0.2, pack, null, PLAYER);
    expect(ev.done).toEqual([{ station: 'hand', id: 'stone_chopper', outputs: [{ k: 'stone_chopper', n: 1 }] }]);
    expect(pack.count('rock')).toBe(1);
    expect(pack.count('stone_chopper')).toBe(1);
    expect(pack.tools.find((t) => t.k === 'hammerstone').d).toBe(59);
    expect(pack.log).toEqual([['take', 'rock', 2], ['wear', 'hammerstone'], ['give', 'stone_chopper', 1]]);
    expect(q.size).toBe(0);
  });

  it('refuses unknown recipes, missing tools, missing inputs and a station that is not near (range 3)', () => {
    const pack = new FakePack({ rock: 2, greenware_pot: 1, coal: 1 });
    const q = new CraftQueue();
    expect(q.enqueue('nope', 1, pack, { hand: true })).toEqual({ ok: false, message: 'unknown recipe "nope"', queued: 0 });
    expect(q.enqueue('stone_chopper', 1, pack, { hand: true })).toEqual({ ok: false, message: "Can't make Stone Chopper: needs a stone hammer or better", queued: 0 });
    expect(q.enqueue('kiln', 1, pack, { hand: true })).toEqual({ ok: false, message: "Can't make Kiln: missing Clay Lump, Rock", queued: 0 });
    expect(q.enqueue('clay_pot', 1, pack, { hand: true })).toEqual({ ok: false, message: "Can't make Clay Pot: build a Kiln nearby", queued: 0 });
    // the station must be in the findStations result, i.e. within STATION_RANGE of the feet
    const nearKiln = findStations(stationWorld(), ...PLAYER);
    expect(nearKiln.kiln).toEqual(KILN_AT);
    const farKiln = findStations(stationWorld(), 6, 10, 0);
    expect(farKiln.kiln).toBeUndefined();
    expect(q.enqueue('clay_pot', 1, pack, farKiln).ok).toBe(false);
    expect(q.enqueue('clay_pot', 1, pack, nearKiln)).toEqual({ ok: true, message: 'Making Clay Pot', queued: 1 });
    expect(q.jobs()[0].at).toEqual(KILN_AT);
    expect(q.size).toBe(1);
  });

  it('×5 queues as many as the pack holds inputs for, and says why not more; MAX_CRAFT_JOBS caps all lanes', () => {
    const pack = new FakePack({ plant_fibre: 7 });
    const q = new CraftQueue();
    expect(q.enqueue('cord', 5, pack, { hand: true })).toEqual({ ok: true, message: 'Making 3 × Cord; no more: missing Plant Fibre', queued: 3 });
    expect(q.enqueue('cord', 1, pack, { hand: true })).toEqual({ ok: false, message: "Can't make Cord: missing Plant Fibre", queued: 0 });
    const big = new FakePack({ plant_fibre: 100 });
    const q2 = new CraftQueue();
    expect(q2.enqueue('cord', 5, big, { hand: true }).queued).toBe(5);
    expect(q2.enqueue('cord', 5, big, { hand: true })).toEqual({ ok: true, message: 'Making 3 × Cord; no more: the lanes are full (8 jobs)', queued: 3 });
    expect(q2.size).toBe(MAX_CRAFT_JOBS);
    expect(q2.enqueue('cord', 1, big, { hand: true }).ok).toBe(false);
    // odd `times` values
    const q3 = new CraftQueue();
    expect(q3.enqueue('cord', 0, big, { hand: true }).queued).toBe(1);
    expect(q3.enqueue('cord', NaN, big, { hand: true }).queued).toBe(1);
    expect(q3.enqueue('cord', 2.7, big, { hand: true }).queued).toBe(2);
    expect(q3.enqueue('cord', 99, big, { hand: true }).queued).toBe(MAX_CRAFT_JOBS - 4);
  });

  it('reserves the inputs of every queued job in every lane, exact keys first and then tags (members in TAGS order)', () => {
    // 7 coal + 1 charcoal: a kiln job's #fuel queued BEFORE a Coal Block (7 coal) still fits, because the exact coal is
    // allocated first and the fuel tag then takes the charcoal.
    const pack = new FakePack({ coal: 7, charcoal: 1, greenware_pot: 2 });
    const q = new CraftQueue();
    const st = { hand: true, kiln: KILN_AT };
    expect(q.enqueue('clay_pot', 1, pack, st).ok).toBe(true);
    expect(q.enqueue('coal_block', 1, pack, st).ok).toBe(true);
    // a second pot needs a third fuel: none is left for it across the two lanes
    expect(q.enqueue('clay_pot', 1, pack, st)).toEqual({ ok: false, message: "Can't make Clay Pot: missing Fuel", queued: 0 });
    // and the coal block (hand lane) finishes first, then the pot takes the charcoal: nothing fails
    const ev = run(q, pack, 16);
    expect(ev.failed).toEqual([]);
    expect(ev.done.map((d) => d.id)).toEqual(['coal_block', 'clay_pot']);
    expect(pack.snapshot()).toEqual({ clay_pot: 1, coal_block: 1, greenware_pot: 1 });
  });

  it('at completion a tag input takes what the queue left it, not an exact key a later job reserved', () => {
    // The kiln job completes FIRST (the coal block waits behind 16 s of hand jobs), and must burn the charcoal: taking the
    // first #fuel member (coal) would leave the coal block one short.
    const pack = new FakePack({ coal: 7, charcoal: 1, greenware_pot: 1, plant_fibre: 22, cord: 2 });
    const q = new CraftQueue();
    const st = { hand: true, kiln: KILN_AT };
    expect(q.enqueue('clay_pot', 1, pack, st).ok).toBe(true); // 15 s in the kiln lane
    expect(q.enqueue('grass_cape', 1, pack, st).ok).toBe(true); // 10 s in the hand lane
    expect(q.enqueue('hay_bale', 1, pack, st).ok).toBe(true); // 6 s more
    expect(q.enqueue('coal_block', 1, pack, st).ok).toBe(true); // then 2 s
    let ev = run(q, pack, 15.05);
    expect(ev.done.map((d) => d.id)).toEqual(['grass_cape', 'clay_pot']);
    expect(pack.count('charcoal')).toBe(0);
    expect(pack.count('coal')).toBe(7);
    ev = run(q, pack, 3);
    expect(ev.failed).toEqual([]);
    expect(ev.done.map((d) => d.id)).toEqual(['hay_bale', 'coal_block']);
    expect(pack.snapshot()).toEqual({ clay_pot: 1, coal_block: 1, grass_cape: 1, hay_bale: 1 });
  });

  it('when the pack changed so the whole queue no longer fits, a completing job still takes what it alone can', () => {
    const pack = new FakePack({ coal: 7, charcoal: 1, greenware_pot: 1, plant_fibre: 22, cord: 2 });
    const q = new CraftQueue();
    const st = { hand: true, kiln: KILN_AT };
    q.enqueue('clay_pot', 1, pack, st);
    q.enqueue('grass_cape', 1, pack, st);
    q.enqueue('hay_bale', 1, pack, st);
    q.enqueue('coal_block', 1, pack, st);
    pack.take('charcoal', 1); // the player dropped the charcoal
    const ev = run(q, pack, 15.05);
    expect(ev.failed).toEqual([]);
    expect(pack.count('clay_pot')).toBe(1);
    expect(pack.count('coal')).toBe(6); // the pot burnt a coal after all
    const later = run(q, pack, 3);
    expect(later.messages).toEqual(["Couldn't make Block of Coal: missing Coal."]);
  });
});

describe('CraftQueue: the lanes run side by side', () => {
  it('every lane\'s head job runs at the same time; leftover time flows into the next job of the lane', () => {
    const pack = new FakePack({ plant_fibre: 10, greenware_pot: 1, coal: 1, rawhide: 1, pig_fat: 1 }, ['flint_knife']);
    const q = new CraftQueue();
    const st = { hand: true, kiln: KILN_AT, stump: STUMP_AT };
    q.enqueue('clay_pot', 1, pack, st); // kiln 15 s
    q.enqueue('leather', 1, pack, st); // stump 8 s
    q.enqueue('cord', 5, pack, st); // hand 5 × 1 s
    const lanes = q.lanes();
    expect(lanes.map((l) => l.station)).toEqual(['hand', 'stump', 'kiln']);
    expect(lanes[0].jobs).toHaveLength(5);
    let ev = q.step(2.5, pack, stationWorld(), PLAYER);
    expect(ev.done.map((d) => d.id)).toEqual(['cord', 'cord']);
    ev = q.step(2.5, pack, stationWorld(), PLAYER); // 5 s: the other three cords are done
    expect(ev.done.map((d) => d.id)).toEqual(['cord', 'cord', 'cord']);
    expect(q.lanes().map((l) => l.station)).toEqual(['stump', 'kiln']);
    expect(q.lanes()[1].jobs[0]).toMatchObject({ id: 'clay_pot', name: 'Clay Pot', progress: 5 / 15, secondsLeft: 10, waiting: false, reason: '' });
    ev = q.step(3, pack, stationWorld(), PLAYER);
    expect(ev.done.map((d) => d.id)).toEqual(['leather']);
    ev = q.step(7, pack, stationWorld(), PLAYER);
    expect(ev.done.map((d) => d.id)).toEqual(['clay_pot']);
    expect(pack.snapshot()).toEqual({ clay_pot: 1, cord: 5, leather: 1 });
    expect(pack.tools[0].d).toBe(69); // the knife cut the leather
  });

  it('a waiting job blocks only the jobs behind it in its own lane; the station must stay within 16 cells (any height)', () => {
    expect(STATION_WORK_RANGE).toBe(16);
    const pack = new FakePack({ greenware_pot: 2, coal: 2, plant_fibre: 2 });
    const q = new CraftQueue();
    q.enqueue('clay_pot', 2, pack, { hand: true, kiln: KILN_AT });
    q.enqueue('cord', 1, pack, { hand: true });
    // walk away: hex distance 17 from the kiln (q 2 → q 19)
    const far = /** @type {[number, number, number]} */ ([19, 10, 0]);
    let ev = q.step(5, pack, stationWorld(), far);
    expect(ev.done.map((d) => d.id)).toEqual(['cord']); // the hand lane never waits
    expect(q.lanes()[0].jobs.map((j) => [j.reason, j.progress])).toEqual([['Kiln too far', 0], ['', 0]]);
    expect(q.chipText()).toBe('Kiln · Clay Pot · Kiln too far');
    // 16 away, 40 cells below: it works again
    const edge = /** @type {[number, number, number]} */ ([18, 50, 0]);
    ev = q.step(15, pack, stationWorld(), edge);
    expect(ev.done.map((d) => d.id)).toEqual(['clay_pot']);
    expect(q.lanes()[0].jobs[0]).toMatchObject({ waiting: false, progress: 0 });
    // no player cell at all: waiting
    q.step(5, pack, stationWorld(), null);
    expect(q.lanes()[0].jobs[0]).toMatchObject({ waiting: true, reason: 'Kiln too far', progress: 0 });
  });

  it('a station in an unloaded chunk waits; a station whose block is gone fails its job (and the next one there)', () => {
    const pack = new FakePack({ greenware_pot: 2, coal: 2 });
    const q = new CraftQueue();
    q.enqueue('clay_pot', 2, pack, { hand: true, kiln: KILN_AT });
    q.step(5, pack, () => UNLOADED, PLAYER);
    expect(q.lanes()[0].jobs[0]).toMatchObject({ waiting: true, progress: 0 });
    q.step(5, pack, () => /** @type {any} */ (undefined), PLAYER);
    expect(q.lanes()[0].jobs[0]).toMatchObject({ waiting: true, progress: 0 });
    q.step(5, pack, stationWorld(), PLAYER);
    expect(q.lanes()[0].jobs[0].progress).toBeCloseTo(5 / 15);
    const gone = makeGetBlock({ [KILN_AT.join(',')]: BLOCK.COBBLESTONE });
    const ev = q.step(1, pack, gone, PLAYER);
    expect(ev.messages).toEqual(["Couldn't make Clay Pot: the Kiln is gone.", "Couldn't make Clay Pot: the Kiln is gone."]);
    expect(ev.failed.map((f) => f.station)).toEqual(['kiln', 'kiln']);
    expect(q.size).toBe(0);
    expect(pack.snapshot()).toEqual({ coal: 2, greenware_pot: 2 }); // nothing was taken
  });

  it('a finished job waits while the pack cannot take the outputs, and completes as soon as there is room', () => {
    const pack = new FakePack({ plant_fibre: 4 });
    const q = new CraftQueue();
    q.enqueue('cord', 2, pack, { hand: true });
    pack.full = true;
    let ev = run(q, pack, 3);
    expect(ev.done).toEqual([]);
    expect(q.lanes()[0].jobs[0]).toMatchObject({ waiting: true, reason: 'Pack full', progress: 1, secondsLeft: 0 });
    expect(q.lanes()[0].jobs[1]).toMatchObject({ progress: 0 }); // blocked behind it
    expect(q.chipText()).toBe('Hands · Cord · Pack full');
    expect(pack.count('plant_fibre')).toBe(4);
    pack.full = false;
    ev = q.step(0, pack, null, PLAYER); // no time needed: it was done
    expect(ev.done.map((d) => d.id)).toEqual(['cord']);
    ev = run(q, pack, 1.05);
    expect(ev.done.map((d) => d.id)).toEqual(['cord']);
    expect(pack.snapshot()).toEqual({ cord: 2 });
  });

  it('fails a job whose inputs or tools went missing, taking nothing, and goes on with the next', () => {
    const pack = new FakePack({ plant_fibre: 4, rock: 2 }, ['hammerstone']);
    const q = new CraftQueue();
    q.enqueue('cord', 1, pack, { hand: true });
    q.enqueue('stone_chopper', 1, pack, { hand: true });
    q.enqueue('cord', 1, pack, { hand: true });
    pack.take('plant_fibre', 3); // dropped on the floor
    pack.tools.length = 0; // and the hammerstone with it
    const ev = run(q, pack, 6);
    expect(ev.messages).toEqual([
      "Couldn't make Cord: missing Plant Fibre.",
      "Couldn't make Stone Chopper: missing a stone hammer or better.",
      "Couldn't make Cord: missing Plant Fibre.",
    ]);
    expect(ev.failed.map((f) => f.id)).toEqual(['cord', 'stone_chopper', 'cord']);
    expect(pack.snapshot()).toEqual({ plant_fibre: 1, rock: 2 });
    expect(q.size).toBe(0);
  });

  it('wears every listed tool once per completed job, and reports the tools that broke', () => {
    const pack = new FakePack({ copper_ingot: 2, stick: 2, coal: 1 }, [{ k: 'crucible', d: 1 }, { k: 'casting_mold', d: 5 }]);
    const q = new CraftQueue();
    expect(q.enqueue('copper_pick', 1, pack, { hand: true, kiln: KILN_AT }).ok).toBe(true);
    const ev = run(q, pack, 25.05);
    expect(ev.done.map((d) => d.id)).toEqual(['copper_pick']);
    expect(ev.broke).toEqual(['crucible']);
    expect(pack.tools.map((t) => [t.k, t.d])).toEqual([['casting_mold', 4], ['copper_pick', 160]]);
    // the lowest qualifying tier is used: a flint knife before a copper knife
    const p2 = new FakePack({ unpeeled_cactus_fruit: 1 }, ['copper_knife', 'flint_knife']);
    const q2 = new CraftQueue();
    q2.enqueue('peel_cactus_fruit', 1, p2, { hand: true });
    run(q2, p2, 1.05);
    expect(p2.tools.map((t) => [t.k, t.d])).toEqual([['copper_knife', 140], ['flint_knife', 69]]);
  });

  it('gives multiple outputs; what `give` cannot place is reported as lost', () => {
    const pack = new FakePack({ salt_pot: 1 });
    const q = new CraftQueue();
    q.enqueue('scrape_salt', 1, pack, { hand: true });
    run(q, pack, 1.05);
    expect(pack.snapshot()).toEqual({ clay_pot: 1, salt: 1 });
    const leaky = new FakePack({ salt_pot: 1 });
    leaky.give = (k, n) => (k === 'clay_pot' ? n : 0);
    const q2 = new CraftQueue();
    q2.enqueue('scrape_salt', 1, leaky, { hand: true });
    const ev = run(q2, leaky, 1.05);
    expect(ev.lost).toEqual([{ k: 'clay_pot', n: 1 }]);
  });

  it('a bad dt never moves a job', () => {
    const pack = new FakePack({ plant_fibre: 2 });
    const q = new CraftQueue();
    q.enqueue('cord', 1, pack, { hand: true });
    for (const dt of [NaN, -1, -Infinity, Infinity, 0]) q.step(dt, pack, null, PLAYER);
    expect(q.lanes()[0].jobs[0].progress).toBe(0);
  });
});

describe('CraftQueue: cancel, clear, chip, lanes, version', () => {
  it('cancel removes one job (nothing to refund); bad lanes and indices are refused', () => {
    const pack = new FakePack({ plant_fibre: 6 });
    const q = new CraftQueue();
    q.enqueue('cord', 3, pack, { hand: true });
    const v = q.version;
    expect(q.cancel('hand', 1)).toBe(true);
    expect(q.version).toBeGreaterThan(v);
    expect(q.lanes()[0].jobs).toHaveLength(2);
    for (const [lane, i] of [['hand', 2], ['hand', -1], ['hand', 0.5], ['kiln', 0], ['nope', 0], ['__proto__', 0]]) {
      expect(q.cancel(/** @type {any} */ (lane), /** @type {any} */ (i)), `${lane} ${i}`).toBe(false);
    }
    expect(pack.count('plant_fibre')).toBe(6);
    // a cancelled job's reservation is freed
    expect(q.enqueue('cord', 1, pack, { hand: true }).ok).toBe(true);
    q.clear();
    expect(q.size).toBe(0);
    expect(q.lanes()).toEqual([]);
    expect(q.chipText()).toBeNull();
    const v2 = q.version;
    q.clear();
    expect(q.version).toBe(v2);
  });

  it('the job chip shows the soonest-finishing running job, with +N for the other busy lanes', () => {
    const pack = new FakePack({ plant_fibre: 12, greenware_pot: 1, coal: 1, malachite: 2, charcoal: 2 });
    const q = new CraftQueue();
    expect(q.chipText()).toBeNull();
    q.enqueue('hay_bale', 1, pack, { hand: true }); // 6 s
    expect(q.chipText()).toBe('Hands · Hay Bale 6 s');
    q.enqueue('clay_pot', 1, pack, { hand: true, kiln: KILN_AT }); // 15 s
    q.step(0.5, pack, stationWorld(), PLAYER);
    expect(q.chipText()).toBe('Hands · Hay Bale 6 s +1');
    q.step(5.6, pack, stationWorld(), PLAYER);
    expect(q.chipText()).toBe('Kiln · Clay Pot 9 s');
  });

  it('jobs() is the queue order across lanes; lanes() lists busy lanes in station order', () => {
    const pack = new FakePack({ plant_fibre: 4, greenware_pot: 1, coal: 1 });
    const q = new CraftQueue();
    q.enqueue('clay_pot', 1, pack, { hand: true, kiln: KILN_AT });
    q.enqueue('cord', 2, pack, { hand: true });
    expect(q.jobs().map((j) => j.recipe.id)).toEqual(['clay_pot', 'cord', 'cord']);
    expect(q.lanes().map((l) => [l.station, l.label, l.jobs.length])).toEqual([['hand', 'Hands', 2], ['kiln', 'Kiln', 1]]);
  });

  it('version moves when what the screen shows changes (5 % steps, whole seconds, waiting), not on every tiny step', () => {
    const pack = new FakePack({ greenware_pot: 1, coal: 1 });
    const q = new CraftQueue();
    q.enqueue('clay_pot', 1, pack, { hand: true, kiln: KILN_AT });
    const v0 = q.version;
    let bumps = 0;
    let last = v0;
    for (let i = 0; i < 1510; i++) {
      q.step(0.01, pack, stationWorld(), PLAYER);
      if (q.version !== last) {
        bumps++;
        last = q.version;
      }
    }
    expect(bumps).toBeGreaterThan(15); // the progress bar moves …
    expect(bumps).toBeLessThan(60); // … but far fewer than 1500 times
    expect(pack.count('clay_pot')).toBe(1);
  });
});

describe('play-test fixes (progression lens)', () => {
  it('tool labels take the right article: "needs an iron hammer or better", not "a iron hammer"', () => {
    const pack = new Pack();
    pack.add({ k: 'wrought_iron', n: 8 });
    pack.add({ k: 'charcoal', n: 8 });
    const q = new CraftQueue();
    expect(q.enqueue('stone_chopper', 1, pack, { hand: true }).message).toBe("Can't make Stone Chopper: needs a stone hammer or better");
    pack.add({ k: 'bronze_hammer', n: 1 });
    const res = q.enqueue('steel_bar', 1, pack, { hand: true, forge: [0, 64, 2] });
    expect(res.ok).toBe(false);
    expect(res.message).toBe("Can't make Steel Bar: needs an iron hammer or better");
    // the same article when a job fails at completion because its tool is gone
    pack.add({ k: 'rock', n: 3 });
    pack.add({ k: 'plant_fibre', n: 4 });
    pack.add({ k: 'cord', n: 1 });
    pack.add({ k: 'stick', n: 1 });
    pack.setSlot(20, { k: 'iron_hammer', n: 1 });
    expect(q.enqueue('stone_chopper', 1, pack, { hand: true }).ok).toBe(true);
    pack.setSlot(20, null);
    pack.take('bronze_hammer', 1); // no hammer of any kind is left
    const ev = q.step(100, pack, null, [0, 64, 0]);
    expect(ev.messages).toEqual(["Couldn't make Stone Chopper: missing a stone hammer or better."]);
  });

  it('"Pack full" is judged after the inputs are taken: a recipe that frees its own slot completes in a full pack', () => {
    // play-test: scrape_salt (Salt-crusted Pot → Salt + Clay Pot) sat at 100 % with "Pack full" for ever
    const pack = new Pack();
    for (let i = 0; i < PACK_SLOTS; i++) pack.setSlot(i, { k: i === 0 ? 'salt_pot' : i === 1 ? 'salt' : 'hammerstone', n: 1 });
    const q = new CraftQueue();
    expect(q.enqueue('scrape_salt', 1, pack, { hand: true }).ok).toBe(true);
    const e = q.step(60, pack, null, [0, 64, 0]);
    expect(e.done.map((d) => d.id)).toEqual(['scrape_salt']);
    expect(e.lost).toEqual([]);
    expect(pack.count('salt_pot')).toBe(0);
    expect(pack.count('salt')).toBe(2);
    expect(pack.count('clay_pot')).toBe(1);
    // a pack with truly no room still waits: the rock stack keeps its slot after one rock is taken, the hammerstone needs its own
    const full = new Pack();
    for (let i = 0; i < PACK_SLOTS; i++) full.setSlot(i, { k: i === 0 ? 'rock' : 'hammerstone', n: i === 0 ? 3 : 1 });
    const q2 = new CraftQueue();
    expect(q2.enqueue('hammerstone', 1, full, { hand: true }).ok).toBe(true);
    q2.step(60, full, null, [0, 64, 0]);
    expect(q2.lanes()[0].jobs[0]).toMatchObject({ waiting: true, reason: 'Pack full' });
    expect(full.count('rock')).toBe(3);
    // a single rock in that slot: taking it frees the slot and the job completes
    full.setSlot(0, { k: 'rock', n: 1 });
    q2.step(1, full, null, [0, 64, 0]);
    expect(q2.size).toBe(0);
    expect(full.count('hammerstone')).toBe(PACK_SLOTS);
    // a PackOps without canExchange (a Map-backed fake) still works through canGive
    const plain = {
      count: () => 9, countTag: () => 9, take: () => 0, takeTag: () => 0, canGive: () => false, give: () => 0, hasTool: () => true, useTool: () => null,
    };
    const q3 = new CraftQueue();
    expect(q3.enqueue('cord', 1, /** @type {any} */ (plain), { hand: true }).ok).toBe(true);
    q3.step(60, /** @type {any} */ (plain), null, [0, 64, 0]);
    expect(q3.lanes()[0].jobs[0]).toMatchObject({ waiting: true, reason: 'Pack full' });
  });
});
