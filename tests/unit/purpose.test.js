// purpose.js — one line on what each tool, workplace and key part is for (CONTRACTS §77), checked against the rules it names.
import { describe, it, expect } from 'vitest';
import { PURPOSE, PURPOSE_MAX, purposeOf } from '../../src/purpose.js';
import { ITEMS, ITEM_KEYS, isItemKey, getItem } from '../../src/items.js';
import { BLOCK } from '../../src/blocks.js';
import { BLOCK_RULES, canHarvest } from '../../src/harvest.js';
import { RECIPES, STATION_BLOCKS, getRecipe, listRecipes } from '../../src/crafting.js';
import { Pack } from '../../src/inventory.js';

const tool = (key) => getItem(key).tool;
const needs = (recipeId, type, tier) => getRecipe(recipeId).tools.some((t) => t.type === type && t.tier === tier);

describe('PURPOSE: a line for everything in the build tree', () => {
  it('every tool has one; every key is a real item; every line is one short sentence or two', () => {
    const tools = ITEM_KEYS.filter((k) => ITEMS[k].tool);
    for (const k of tools) expect(purposeOf(k), k).not.toBe('');
    for (const [k, line] of Object.entries(PURPOSE)) {
      expect(isItemKey(k), k).toBe(true);
      expect(line.length, k).toBeLessThanOrEqual(PURPOSE_MAX);
      expect(line.length, k).toBeGreaterThan(8);
      expect(/^[A-Z].*\.$/.test(line), `${k}: "${line}"`).toBe(true);
      expect(line).not.toMatch(/\s{2,}|_/); // plain words: no item keys
    }
    for (const station of Object.values(STATION_BLOCKS)) {
      const key = ITEM_KEYS.find((k) => ITEMS[k].block === station);
      expect(purposeOf(key), key).toMatch(/^Workplace: /);
    }
    expect(purposeOf('rock')).toBe('');
    expect(purposeOf(null)).toBe('');
    expect(purposeOf('toString')).toBe('');
  });

  it('each pick line names what that pick opens, and the rules agree', () => {
    const opens = [
      ['flint_pick', [BLOCK.STONE, BLOCK.COAL_ORE, BLOCK.COPPER_ORE], /rock, coal and copper ore/],
      ['copper_pick', [BLOCK.TIN_ORE], /tin ore/],
      ['bronze_pick', [BLOCK.IRON_ORE], /iron ore/],
      ['iron_pick', [BLOCK.GOLD_ORE], /gold ore/],
      ['steel_pick', [BLOCK.DIAMOND_ORE], /gems/],
    ];
    const picks = opens.map(([k]) => k);
    opens.forEach(([key, ids, words], i) => {
      expect(PURPOSE[key]).toMatch(words);
      for (const id of ids) {
        expect(BLOCK_RULES[id].tier, key).toBe(tool(key).tier); // exactly this pick's tier …
        expect(canHarvest(id, tool(key))).toBe(true);
        if (i > 0) expect(canHarvest(id, tool(picks[i - 1])), `${picks[i - 1]} must not open it`).toBe(false); // … and not the one before
      }
    });
    expect(canHarvest(BLOCK.STONE, null)).toBe(false);
  });

  it('the other gates the lines name are real', () => {
    // the wooden shovel digs clay, and nothing less does
    expect(PURPOSE.wooden_shovel).toMatch(/clay/);
    expect(canHarvest(BLOCK.CLAY, null)).toBe(false);
    expect(canHarvest(BLOCK.CLAY, tool('wooden_shovel'))).toBe(true);
    expect(getRecipe('kiln').inputs.some((i) => i.k === 'clay_lump')).toBe(true);
    // the stone hammer knaps every flint tool
    expect(PURPOSE.stone_hammer).toMatch(/flint/);
    for (const id of ['flint_knife', 'flint_axe', 'flint_pick', 'flint_shovel', 'flint_spear']) expect(needs(id, 'hammer', 1), id).toBe(true);
    // the stone axe: logs and the Work Stump
    expect(PURPOSE.stone_axe).toMatch(/Work Stump/);
    expect(needs('work_stump', 'axe', 1)).toBe(true);
    expect(canHarvest(BLOCK.OAK_LOG, null)).toBe(false);
    expect(canHarvest(BLOCK.OAK_LOG, tool('stone_axe'))).toBe(true);
    // the flint axe: planks; the flint knife: leather
    expect(PURPOSE.flint_axe).toMatch(/planks/);
    expect(needs('oak_planks', 'axe', 2)).toBe(true);
    expect(PURPOSE.flint_knife).toMatch(/leather/);
    expect(needs('leather', 'knife', 2)).toBe(true);
    // the hammers: copper draws wire, bronze works iron, iron forges steel and builds the Workbench, steel sets gems
    expect(PURPOSE.copper_hammer).toMatch(/copper wire/);
    expect(needs('copper_wire', 'hammer', 3)).toBe(true);
    expect(needs('stone_bricks', 'hammer', 3)).toBe(true);
    expect(PURPOSE.bronze_hammer).toMatch(/wrought iron/);
    expect(needs('wrought_iron', 'hammer', 4)).toBe(true);
    expect(PURPOSE.iron_hammer).toMatch(/steel/);
    expect(needs('steel_bar', 'hammer', 5)).toBe(true);
    expect(needs('workbench', 'hammer', 5)).toBe(true);
    expect(PURPOSE.steel_hammer).toMatch(/Diamond Block/);
    expect(needs('diamond_block', 'hammer', 6)).toBe(true);
    // casting: the crucible alloys bronze and, with the mold, casts copper and bronze
    expect(needs('bronze_ingot', 'crucible', 0)).toBe(true);
    expect(needs('copper_pick', 'mold', 0)).toBe(true);
    expect(needs('bronze_sword', 'crucible', 0)).toBe(true);
    // the fire drill lights the campfire and the torch
    expect(needs('campfire', 'firestarter', 0)).toBe(true);
    expect(needs('torch', 'firestarter', 0)).toBe(true);
    // the bellows build the Bloomery and the Forge
    for (const id of ['bloomery', 'forge']) expect(getRecipe(id).inputs.some((i) => i.k === 'bellows'), id).toBe(true);
    // charcoal: the only fuel of the bloomery and the forge
    for (const r of RECIPES.filter((x) => x.station === 'forge' || x.station === 'bloomery')) {
      expect(r.inputs.some((i) => i.tag === 'fuel' || i.k === 'coal'), r.id).toBe(false);
    }
  });

  it('coal is the gate to the metal ages: smelting and casting copper and bronze burn coal, never charcoal', () => {
    const smelt = ['copper_ingot', 'tin_ingot', 'bronze_ingot', 'copper_block', 'gold_block',
      ...RECIPES.filter((r) => /^(copper|bronze)_(knife|shovel|axe|hammer|pick|sword)$/.test(r.id)).map((r) => r.id)];
    expect(smelt).toHaveLength(16);
    for (const id of smelt) {
      const r = getRecipe(id);
      expect(r.station, id).toBe('kiln');
      expect(r.inputs.some((i) => i.k === 'coal'), id).toBe(true);
      expect(r.inputs.some((i) => i.tag === 'fuel' || i.k === 'charcoal'), id).toBe(false);
    }
    // firing clay still takes any fuel, so the Kiln works before coal is found
    for (const id of ['clay_pot', 'fired_brick', 'crucible', 'casting_mold']) expect(getRecipe(id).inputs.some((i) => i.tag === 'fuel'), id).toBe(true);
    expect(canHarvest(BLOCK.COAL_ORE, tool('flint_pick'))).toBe(true);
    expect(canHarvest(BLOCK.COAL_ORE, tool('stone_axe'))).toBe(false);
  });

  it('the Making panel gets the line with each recipe', () => {
    const views = listRecipes(new Pack(), {}, {});
    const by = new Map(views.map((v) => [v.id, v]));
    expect(by.get('stone_hammer').purpose).toBe(PURPOSE.stone_hammer);
    expect(by.get('copper_pick').purpose).toBe(PURPOSE.copper_pick);
    expect(by.get('kiln').purpose).toBe(PURPOSE.kiln);
    expect(by.get('cobblestone').purpose).toBe('');
    for (const v of views) expect(typeof v.purpose).toBe('string');
    // every recipe that makes a tool carries a line
    for (const v of views) if (ITEMS[v.out.k].tool) expect(v.purpose, v.id).not.toBe('');
  });
});
