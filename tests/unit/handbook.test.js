// Unit tests for src/handbook.js — the Survival Handbook's content (docs/DESIGN-survival.md §14): the chapters, and every
// generated table walked against the game table it restates, so the book can never disagree with the game.
import { describe, it, expect } from 'vitest';
import {
  HANDBOOK_KEY, HANDBOOK_CHAT_LINE, TABLE_ROWS_PER_PAGE, TABLE_SOURCES, CLIMATE_EXAMPLES, FALL_EXAMPLES, DANGER_NAMES,
  buildChapters, chapterIds, ensureHandbook, inlineParts, plainText, fmtNum, fmtSigned, fmtPct, fmtTemp, fmtDuration,
  fmtDurationLong, fmtClock, listJoin, numWord, describeDrops, recipeInputs, recipeInputsProse, recipeOutputs, recipeTools,
  toolNeedLabel, firstDayKit, fallSpeedForCells, climateExample, exampleBreakSeconds, temperatureBands,
} from '../../src/handbook.js';
import { ITEMS, ITEM_KEYS, TIER_NAMES, TIER_SPEED, itemName, isItemKey } from '../../src/items.js';
import { RECIPES, STATION_IDS, STATION_NAMES, inputLabel } from '../../src/crafting.js';
import { BLOCK_RULES, MOB_DROPS, PICKABLE, breakSeconds, ruleFor } from '../../src/harvest.js';
import { HEAT_SOURCES } from '../../src/climate.js';
import { RATES, DAMAGE_CAUSES, SOFT_LANDING, fallDamage } from '../../src/vitals.js';
import { FIRE_TRANSFORMS } from '../../src/cooking.js';
import { BLOCK, getBlockDef } from '../../src/blocks.js';
import { HOTBAR_SIZE, PACK_SLOTS } from '../../src/config.js';
import { Pack, KEEP_ON_DEATH, slotClick } from '../../src/inventory.js';
import { Survival } from '../../src/survival.js';

const CHAPTERS = buildChapters();
const KINDS = ['h', 'p', 'tip', 'warn', 'list', 'table', 'figure'];

/** Every block of the book, with where it is. */
function* blocks() {
  for (const c of CHAPTERS) {
    for (let p = 0; p < c.pages.length; p++) for (const b of c.pages[p]) yield { chapter: c, page: p, block: b };
  }
}
/** Every part of a generated table, joined: { rows, keys, parts }. @param {string} id */
function tableById(id) {
  const parts = [...blocks()].map((x) => x.block).filter((b) => b.kind === 'table' && b.id === id);
  if (!parts.length) throw new Error(`no table ${id}`);
  return { parts, head: parts[0].head, rows: parts.flatMap((b) => b.rows), keys: parts.flatMap((b) => b.keys), source: parts[0].source };
}
/** The row of a table whose key is `key`. */
function rowOf(t, key) {
  const i = t.keys.indexOf(key);
  if (i < 0) throw new Error(`no row ${String(key)}`);
  return t.rows[i];
}
/** All the book's text (prose, lists, notes) as one string, marks removed. */
function allProse() {
  const out = [];
  for (const { block: b } of blocks()) {
    if ('text' in b) out.push(plainText(b.text));
    if (b.kind === 'list') out.push(...b.items.map(plainText));
  }
  return out.join('\n');
}

describe('handbook: the chapters (§14.1)', () => {
  it('ten chapters in the order of §14.1, every one with pages, every page with blocks', () => {
    expect(chapterIds()).toEqual(['first-day', 'water', 'food', 'warmth', 'ages', 'making', 'dangers', 'death', 'controls', 'modes']);
    expect(CHAPTERS.map((c) => c.title)).toEqual(['Your first day', 'Water', 'Food and fire', 'Warm and cool', 'Tools and the ages',
      'Workplaces and making', 'Dangers', 'Death and waking', 'Controls', 'Creative and Survival']);
    for (const c of CHAPTERS) {
      expect(c.pages.length, c.id).toBeGreaterThan(0);
      expect(typeof c.short === 'string' && c.short.length > 0 && c.short.length <= 8, `${c.id} tab label`).toBe(true);
      expect(typeof c.icon, c.id).toBe('string');
      for (const page of c.pages) expect(page.length, c.id).toBeGreaterThan(0);
      // every chapter has some prose of its own, not only tables
      expect(c.pages.flat().some((b) => b.kind === 'p' || b.kind === 'list'), c.id).toBe(true);
    }
  });

  it('is built once and deeply frozen', () => {
    expect(buildChapters()).toBe(CHAPTERS);
    expect(Object.isFrozen(CHAPTERS)).toBe(true);
    for (const { block } of blocks()) expect(Object.isFrozen(block)).toBe(true);
    expect(Object.isFrozen(CHAPTERS[0].pages[0])).toBe(true);
  });

  it('every block is well formed', () => {
    for (const { chapter, block: b } of blocks()) {
      const at = `${chapter.id}: ${b.kind}`;
      expect(KINDS, at).toContain(b.kind);
      if ('text' in b) expect(typeof b.text === 'string' && b.text.trim().length > 0, at).toBe(true);
      if (b.kind === 'list') {
        expect(b.items.length, at).toBeGreaterThan(0);
        expect(typeof b.ordered, at).toBe('boolean');
      }
      if (b.kind === 'table') {
        expect(b.rows.length, `${at} ${b.id}`).toBeGreaterThan(0);
        expect(b.rows.length, `${at} ${b.id}`).toBeLessThanOrEqual(TABLE_ROWS_PER_PAGE);
        expect(b.keys).toHaveLength(b.rows.length);
        for (const row of b.rows) {
          expect(row, `${b.id}`).toHaveLength(b.head.length);
          for (const cell of row) expect(typeof cell, b.id).toBe('string');
        }
        expect(b.part >= 1 && b.part <= b.parts, b.id).toBe(true);
        if (b.source !== null) expect(TABLE_SOURCES, b.id).toContain(b.source);
      }
      if (b.kind === 'figure') expect(['fire-spots', 'ages', 'bands'], at).toContain(b.figure);
    }
  });

  it('marks are balanced: every * and [ in prose belongs to a mark, and nothing reads "undefined" or "NaN"', () => {
    for (const { chapter, block: b } of blocks()) {
      const texts = 'text' in b ? [b.text] : b.kind === 'list' ? b.items : [];
      for (const t of texts) {
        const shown = plainText(t);
        expect(shown.includes('*'), `${chapter.id}: ${t}`).toBe(false);
        expect(/\[|\]/.test(shown), `${chapter.id}: ${t}`).toBe(false);
      }
    }
    const everything = JSON.stringify(CHAPTERS);
    expect(everything).not.toMatch(/undefined|NaN|\[object|Infinity/);
  });

  it('table ids are unique per table and their parts are consecutive and complete', () => {
    /** @type {Map<string, number[]>} */
    const parts = new Map();
    for (const { block: b } of blocks()) {
      if (b.kind !== 'table') continue;
      if (!parts.has(b.id)) parts.set(b.id, []);
      parts.get(b.id).push(b.part);
      expect(b.caption.length).toBeGreaterThan(0);
    }
    for (const [id, list] of parts) {
      expect(list, id).toEqual(list.map((_, i) => i + 1));
    }
    // even splits: Hands (37 recipes) in four pages of 10, 9, 9, 9
    expect(tableById('recipes-hand').parts.map((p) => p.rows.length)).toEqual([10, 9, 9, 9]);
  });

  it('teaches the real survival ideas the design asks for', () => {
    const text = allProse();
    for (const idea of [/[Ss]alt water makes thirst worse/, /Wet skin/, /Charcoal.*hotter/, /one part tin in 8/, /Boil before you drink/,
      /never leaves you/, /There is no stone pick/]) {
      expect(text).toMatch(idea);
    }
    // our own words: Nourishment, never "satiation"; no "crafting table", "furnace", "chest" or "bed"
    expect(text).not.toMatch(/satiation|crafting table|furnace|\bchest\b|\bbed\b/i);
    expect(text).toMatch(/Nourishment/);
  });
});

describe('handbook: generated tables match the game (§14.1)', () => {
  it('recipes by workplace: every recipe once, in RECIPES order, with its inputs, tools and time', () => {
    for (const station of STATION_IDS) {
      const t = tableById(`recipes-${station}`);
      const recs = RECIPES.filter((r) => r.station === station);
      expect(t.source).toBe('recipes');
      expect(t.keys).toEqual(recs.map((r) => r.id));
      for (const rec of recs) {
        const [makes, from, tools, time] = rowOf(t, rec.id);
        expect(makes.startsWith(itemName(rec.outputs[0].k)), rec.id).toBe(true);
        if (rec.outputs[0].n > 1) expect(makes, rec.id).toContain(`×${rec.outputs[0].n}`);
        for (const extra of rec.outputs.slice(1)) expect(makes, rec.id).toContain(itemName(extra.k));
        for (const inp of rec.inputs) expect(from, rec.id).toContain(`${inp.n > 1 ? `${inp.n} ` : ''}${inputLabel(inp)}`);
        expect(from.split(' + ')).toHaveLength(rec.inputs.length);
        expect(time).toBe(`${rec.seconds} s`);
        expect(tools === '—' ? 0 : tools.split(', ').length, rec.id).toBe(rec.tools.length);
        for (const need of rec.tools) {
          // the named tool qualifies: right type, tier ≥ the need
          const named = ITEM_KEYS.find((k) => ITEMS[k].kind === 'tool' && tools.includes(itemName(k)) && ITEMS[k].tool.type === need.type);
          expect(named, `${rec.id} ${need.type}`).toBeTruthy();
          expect(ITEMS[named].tool.tier).toBeGreaterThanOrEqual(need.tier);
        }
      }
    }
    // 89 recipes in all (37 / 12 / 21 / 4 / 15)
    expect(STATION_IDS.map((s) => tableById(`recipes-${s}`).rows.length)).toEqual([37, 12, 21, 4, 15]);
  });

  it('tool labels name the cheapest tool that qualifies, "+" when better ones exist', () => {
    expect(toolNeedLabel('hammer', 1)).toBe('Hammerstone+');
    expect(toolNeedLabel('axe', 1)).toBe('Stone Chopper+');
    expect(toolNeedLabel('knife', 2)).toBe('Flint Knife+');
    expect(toolNeedLabel('hammer', 4)).toBe('Bronze Hammer+');
    expect(toolNeedLabel('hammer', 6)).toBe('Steel Hammer');
    expect(toolNeedLabel('crucible', 0)).toBe('Crucible');
    expect(toolNeedLabel('firestarter', 0)).toBe('Fire Drill');
  });

  it('the ages: every tool in its tier\'s row, with the tier speed and its durability range', () => {
    const t = tableById('ages');
    expect(t.keys).toEqual([1, 2, 3, 4, 5, 6]);
    for (const tier of [1, 2, 3, 4, 5, 6]) {
      const [age, speed, tools, lasts] = rowOf(t, tier);
      expect(age.toLowerCase()).toBe(TIER_NAMES[tier]);
      expect(speed).toBe(`×${TIER_SPEED[tier]}`);
      const keys = ITEM_KEYS.filter((k) => ITEMS[k].tool?.tier === tier);
      expect(tools.split(', ')).toEqual(keys.map(itemName));
      const d = keys.map((k) => ITEMS[k].tool.durability);
      expect(lasts).toBe(Math.min(...d) === Math.max(...d) ? `${d[0]} uses` : `${Math.min(...d)}–${Math.max(...d)} uses`);
    }
  });

  it('what needs which tool: every block with a tier requirement in exactly its (tool, tier) row', () => {
    const t = tableById('needs');
    const seen = new Map();
    BLOCK_RULES.forEach((rule, id) => {
      if (!rule || rule.tier === 0) return;
      const row = rowOf(t, `${rule.tool}:${rule.tier}`);
      expect(row[0]).toBe(`${rule.tool[0].toUpperCase()}${rule.tool.slice(1)}, ${TIER_NAMES[rule.tier]} or better`);
      expect(row[2].split(', '), getBlockDef(id).name).toContain(getBlockDef(id).displayName);
      seen.set(getBlockDef(id).displayName, (seen.get(getBlockDef(id).displayName) ?? new Set()).add(`${rule.tool}:${rule.tier}`));
    });
    for (const [name, rows] of seen) expect(rows.size, name).toBe(1);
    // the gating chain of §7.4: flint → copper ore; copper → tin; bronze → iron and gold
    expect(rowOf(t, 'pick:2')[2]).toContain('Copper Ore');
    expect(rowOf(t, 'pick:3')[2]).toBe('Tin Ore');
    expect(rowOf(t, 'pick:4')[2]).toBe('Iron Ore, Gold Ore');
    expect(rowOf(t, 'pick:2')[1]).toBe('Flint Pick');
  });

  it('the figures carry the game\'s data: the ages chain (§7.4), the body-temperature bands, the seven fire spots', () => {
    const figs = [...blocks()].map((x) => x.block).filter((b) => b.kind === 'figure');
    const ages = figs.find((f) => f.figure === 'ages').data;
    expect(ages.map((a) => a.name)).toEqual(['Hand', 'Stone', 'Flint', 'Copper', 'Bronze', 'Iron', 'Steel']);
    expect(ages[1].opens).toEqual(['logs']);
    expect(ages[2].opens.slice(0, 2)).toEqual(['stone', 'copper']); // the flint pick opens stone and copper first
    expect(ages[3].opens).toEqual(['tin']);
    expect(ages[4].opens).toEqual(['iron', 'gold']);
    for (const a of ages) expect(a.opens.length).toBeLessThanOrEqual(4);
    const bands = figs.find((f) => f.figure === 'bands').data;
    expect(bands.map((b) => b.label)).toEqual(temperatureBands().map((b) => b.label));
    expect(figs.find((f) => f.figure === 'fire-spots').data).toEqual({ skewers: 6, embers: 1 });
  });

  it('break times are harvest.breakSeconds with the right kind of tool of each age', () => {
    const t = tableById('break');
    for (const id of t.keys) {
      const row = rowOf(t, id);
      expect(row[0]).toBe(getBlockDef(id).displayName);
      for (let tier = 0; tier <= 6; tier++) {
        const s = exampleBreakSeconds(id, tier);
        const cell = row[tier + 1];
        if (s === null) expect(cell).toBe('—');
        else if (s === Infinity) expect(cell).toBe('✕');
        else expect(Number(cell)).toBeCloseTo(s, 2);
      }
    }
    // the §6.3 example times
    expect(rowOf(t, BLOCK.DIRT)[1]).toBe('0.9');
    expect(rowOf(t, BLOCK.OAK_LOG)[2]).toBe('2');
    expect(rowOf(t, BLOCK.STONE)[3]).toBe('1.5');
    expect(rowOf(t, BLOCK.IRON_ORE)[5]).toBe('1.47');
    expect(rowOf(t, BLOCK.OBSIDIAN)[3]).toBe('1.25');
    expect(rowOf(t, BLOCK.STONE)[2]).toBe('—'); // there is no stone pick
    expect(exampleBreakSeconds(BLOCK.STONE, 2)).toBe(breakSeconds(BLOCK.STONE, ITEMS.flint_pick.tool));
  });

  it('food values come from ITEMS: every food once, its numbers, sickness and spoiling', () => {
    const t = tableById('food');
    const foods = ITEM_KEYS.filter((k) => ITEMS[k].kind === 'food');
    expect(t.keys).toEqual(foods);
    for (const k of foods) {
      const f = ITEMS[k].food;
      const [name, nour, hyd, sick, bad] = rowOf(t, k);
      expect(name).toBe(itemName(k));
      expect(nour).toBe(fmtSigned(f.satiation));
      expect(hyd).toBe(fmtSigned(f.hydration));
      expect(sick).toBe(f.sick > 0 ? fmtPct(f.sick) : '—');
      expect(bad).toBe(f.spoilS ? `~${fmtDuration(f.spoilS)}` : 'keeps');
    }
    expect(rowOf(t, 'roast_pork')).toEqual(['Roast Pork', '+30', '−2', '—', '~40 min']);
    expect(rowOf(t, 'raw_pork')[3]).toBe('30 %');
  });

  it('drinks, fire transforms, heat sources, clothes and bandages come from their tables', () => {
    const drinks = tableById('drinks');
    expect(drinks.keys).toEqual(ITEM_KEYS.filter((k) => ITEMS[k].food?.returns));
    expect(rowOf(drinks, 'pot_seawater').slice(1)).toEqual(['−10', '0', 'salty']);
    expect(rowOf(drinks, 'pot_water')[3]).toBe('3 % sick');

    const fire = tableById('fire');
    expect(fire.keys).toEqual(Object.keys(FIRE_TRANSFORMS));
    for (const [k, tr] of Object.entries(FIRE_TRANSFORMS)) {
      expect(rowOf(fire, k)).toEqual([itemName(k), itemName(tr.to), `${tr.seconds} s`, tr.spot === 'skewer' ? 'a skewer' : 'the embers']);
    }
    const embers = tableById('embers');
    expect(embers.keys).toEqual(Object.keys(FIRE_TRANSFORMS).filter((k) => FIRE_TRANSFORMS[k].spot === 'centre'));

    const heat = tableById('heat');
    expect(heat.keys).toEqual(Object.keys(HEAT_SOURCES));
    for (const [k, s] of Object.entries(HEAT_SOURCES)) {
      const row = rowOf(heat, k);
      expect(row[1]).toBe(`+${s.heat} °C`);
      expect(row[2]).toBe(`${s.radius} cells`);
    }

    const clothes = tableById('clothes');
    expect(clothes.keys).toEqual(ITEM_KEYS.filter((k) => ITEMS[k].kind === 'wear'));
    for (const k of clothes.keys) {
      const w = ITEMS[k].wear;
      const row = rowOf(clothes, k);
      expect(row[2]).toBe(w.insulation ? `+${w.insulation} °C` : '—');
      const rec = RECIPES.find((r) => r.outputs[0].k === k);
      expect(row[4]).toBe(`${STATION_NAMES[rec.station]}: ${recipeInputs(rec)}`);
    }

    const bandages = tableById('bandages');
    for (const k of bandages.keys) {
      const hl = ITEMS[k].heal;
      expect(rowOf(bandages, k).slice(1, 3)).toEqual([`${hl.hp} HP`, `${fmtNum(hl.rate)} HP/s`]);
    }
  });

  it('the workplaces table: what builds each workplace, and its heat while working', () => {
    const t = tableById('workplaces');
    expect(t.keys).toEqual(['stump', 'kiln', 'bloomery', 'forge']);
    expect(rowOf(t, 'kiln')).toEqual(['Kiln', '8 Clay Lump + 6 Rock', '+12 °C, 4 cells']);
    expect(rowOf(t, 'stump')[1]).toBe('Any Log (Stone Chopper+)');
    expect(rowOf(t, 'forge')[1]).toContain('24 Fired Brick');
  });

  it('the climate rows are climate.js, and match the §3.4 worked examples (±0.2 °C)', () => {
    // [air, felt, target] from DESIGN-survival §3.4 (water rows: the water temperature as "air")
    const DOC = {
      'plains-noon': [18, 21.5, 37], 'plains-night': [6, 6, 35.8], 'plains-roof': [6, 9, 36.7], 'desert-noon': [39, 42.5, 39.5],
      'desert-sprint': [39, 46.5, 40.3], 'desert-night': [15, 15, 37], 'snowy-noon': [0.8, 2.3, 34.7],
      'snowy-night': [-11.2, -13.2, 30.0], 'snowy-leather': [-11.2, -3.2, 33.0], 'snowy-fire': [null, 8.0, 36.4],
      'plains-water': [null, 12, 33.8], 'snowy-water': [null, 3, 30.2], 'plains-cave': [12, 12, 37], 'snowy-cave': [-5.2, -2.2, 33.3],
      'desert-cave': [27, 27, 37],
    };
    expect(CLIMATE_EXAMPLES.map((e) => e.id)).toEqual(Object.keys(DOC));
    for (const e of CLIMATE_EXAMPLES) {
      const c = climateExample(e);
      const [air, felt, target] = DOC[e.id];
      if (air !== null) expect(Math.abs(c.air - air), `${e.id} air`).toBeLessThanOrEqual(0.2);
      expect(Math.abs(c.felt - felt), `${e.id} felt`).toBeLessThanOrEqual(0.2);
      expect(Math.abs(c.target - target), `${e.id} target`).toBeLessThanOrEqual(0.2);
    }
    const t = { ...tableById('climate-open') };
    const w = tableById('climate-water');
    for (const [table, list] of [[t, t.keys], [w, w.keys]]) {
      for (const id of list) {
        const c = climateExample(CLIMATE_EXAMPLES.find((e) => e.id === id));
        const row = rowOf(table, id);
        expect(row[3]).toBe(fmtTemp(c.felt));
        expect(row[4].startsWith(fmtTemp(c.target))).toBe(true);
        if (c.band) expect(row[4]).toContain(c.band);
      }
    }
    expect(rowOf(t, 'snowy-night')[4]).toBe('30.0 °C · Hypothermic');
    expect(rowOf(t, 'desert-noon')[4]).toBe('39.5 °C · Hot');
  });

  it('the body-temperature bands come from vitals.RATES', () => {
    const t = tableById('bands');
    const bands = temperatureBands();
    expect(t.keys).toEqual(bands.map((b) => b.label));
    expect(rowOf(t, 'Comfortable')[1]).toBe(`${RATES.CHILLED}–${RATES.HOT} °C`);
    expect(rowOf(t, 'Freezing')[2]).toContain(`${RATES.FREEZING_DPS} HP/s`);
    expect(rowOf(t, 'Hypothermic')[1]).toBe(`below ${RATES.HYPOTHERMIC} °C`);
    expect(rowOf(t, 'Heatstroke')[1]).toBe(`${RATES.HEATSTROKE} °C and up`);
    // contiguous: each band starts where the colder one ends
    const sorted = [...bands].sort((a, b) => a.from - b.from);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].from).toBe(sorted[i - 1].to);
  });

  it('every damage source of vitals.DAMAGE_CAUSES has a row (the console\'s "command" aside), with its numbers', () => {
    const t = tableById('dangers');
    expect(t.keys).toEqual(DAMAGE_CAUSES.filter((c) => c !== 'command'));
    for (const c of t.keys) {
      const [name, harm, avoid] = rowOf(t, c);
      expect(name).toBe(DANGER_NAMES[c]);
      expect(harm.length, c).toBeGreaterThan(0);
      expect(avoid.length, c).toBeGreaterThan(0);
    }
    expect(rowOf(t, 'drown')[1]).toContain(`${RATES.DROWN_DPS} HP/s`);
    expect(rowOf(t, 'zombie')[1]).toBe('8 HP a strike');
    expect(rowOf(t, 'starve')[1]).toContain(String(RATES.STARVE_DPS));
    expect(rowOf(t, 'thirst')[1]).toContain(String(RATES.THIRST_DPS));
    expect(rowOf(t, 'sick')[1]).toContain(`never below ${RATES.SICK_FLOOR} HP`);
    expect(rowOf(t, 'fall')[1]).toBe('from 4 cells up, rising fast; 22 cells kill');
    expect(rowOf(t, 'blackhole')[1]).toContain('lost');
  });

  it('falls use the real integrator: §2.4\'s speeds and damage', () => {
    // DESIGN-survival §2.4: cells → [v, HP]
    const DOC = { 3: [13.07, 0], 4: [14.93, 2.7], 5: [16.8, 8.6], 6: [18.2, 13.5], 8: [21.0, 24.5], 10: [23.8, 37.0],
      15: [28.93, 64.1], 20: [33.6, 93.3], 21: [34.07, 96.5], 22: [35.0, 102.9] };
    expect([...FALL_EXAMPLES]).toEqual(Object.keys(DOC).map(Number));
    for (const [d, [v, hp]] of Object.entries(DOC)) {
      expect(fallSpeedForCells(Number(d))).toBeCloseTo(v, 1);
      expect(fallDamage(fallSpeedForCells(Number(d)))).toBeCloseTo(hp, 0);
    }
    const t = tableById('fall');
    expect(rowOf(t, 3)[2]).toBe('none');
    expect(rowOf(t, 10)).toEqual(['10', '23.8 m/s', '37 HP']);
    expect(rowOf(t, 22)[2]).toBe('102.9 HP');
  });

  it('soft landings group vitals.SOFT_LANDING by factor', () => {
    const t = tableById('soft');
    const factors = [...new Set(Object.values(SOFT_LANDING))].sort((a, b) => a - b);
    expect(t.keys).toEqual(factors);
    expect(rowOf(t, 0.4)).toEqual(['Snow Block', '40 %']);
    expect(rowOf(t, 0.7)[0]).toBe('Wool (any colour)');
    expect(rowOf(t, 0.6)[0]).toContain('Hay Bale');
  });

  it('the warning tags and the waking values come from RATES', () => {
    const s = tableById('status');
    expect(rowOf(s, 'Hungry')[1]).toBe(`Nourishment below ${RATES.HUNGRY}`);
    expect(rowOf(s, 'Parched')[1]).toBe(`Hydration below ${RATES.PARCHED}`);
    expect(rowOf(s, 'Drowning')[2]).toBe(`${RATES.DROWN_DPS} HP/s`);
    const w = tableById('wake');
    expect(rowOf(w, 'Health').slice(1)).toEqual([String(RATES.NEW_HEALTH), String(RATES.WAKE_HEALTH)]);
    expect(rowOf(w, 'Nourishment')[2]).toBe(`at least ${RATES.WAKE_MIN_STAT}`);
  });

  it('the first-day kit is §7.5: 9 rock, 4 flint, 11 fibre, 8 sticks, 28 s of hand jobs', () => {
    const kit = firstDayKit();
    expect([kit.rock, kit.knapstone, kit.fibre, kit.sticks, kit.seconds, kit.cords]).toEqual([9, 4, 11, 8, 28, 5]);
    const t = tableById('kit');
    expect(t.keys).toEqual(['hammerstone', 'stone_chopper', 'cord', 'flint_knife', 'flint_axe', 'flint_pick', 'fire_drill', 'campfire']);
    expect(rowOf(t, 'cord')).toEqual(['Cord ×5', '10 Plant Fibre', '—', '5 s']);
    expect(allProse()).toContain('In all: 9 Rock, 4 Flint, 11 Plant Fibre and 8 Sticks, and 28 seconds of hand jobs.');
  });

  it('gathering rows describe PICKABLE (for what R picks) and BLOCK_RULES drops, and say how: R, or hold LMB', () => {
    const t = tableById('gather');
    for (const id of t.keys) {
      const row = rowOf(t, id);
      const picked = Object.hasOwn(PICKABLE, id);
      expect(row[2]).toBe(describeDrops(picked ? PICKABLE[id].drops : ruleFor(id).drops));
      // play-test: "break it" never told a new player which button; the crosshair hint (harvest.handGatherHint) says the same
      expect(row[1].startsWith(picked ? 'R, or hold LMB' : 'hold LMB to ')).toBe(true);
    }
    expect(rowOf(t, BLOCK.TUSSOCK)[1]).toBe('hold LMB to pull it (a knife is faster)');
    expect(rowOf(t, BLOCK.GRAVEL)[1]).toBe('hold LMB to dig it (a spade is faster)');
    expect(rowOf(t, BLOCK.OAK_LEAVES)[1]).toBe('hold LMB to break it (an axe is faster)');
    expect(allProse()).toContain('hold the left mouse button on it until it breaks');
    expect(rowOf(t, BLOCK.LOOSE_STONES)[2]).toBe('1–2 Rock · Flint (50 %, wild only)');
    expect(rowOf(t, BLOCK.TUSSOCK)[2]).toBe('with a spade: Tussock Grass; with a knife: 2–3 Plant Fibre; otherwise: 1–2 Plant Fibre');
  });

  it('the striking-power table groups the tools by power, with hits for a pig and a zombie', () => {
    const t = tableById('power');
    expect(rowOf(t, 'hand')[2]).toBe('never: only shoves');
    const powers = [...new Set(ITEM_KEYS.filter((k) => ITEMS[k].kind === 'tool').map((k) => ITEMS[k].tool.power))].sort((a, b) => a - b);
    expect(t.keys.slice(1)).toEqual(powers);
    expect(rowOf(t, 2)[0]).toContain('Stone Chopper');
    expect(rowOf(t, 2).slice(2)).toEqual(['3', '2']); // a chopper: three blows for a pig (§4.3)
    expect(rowOf(t, 3)[0]).toContain('Flint Spear');
    expect(rowOf(t, 3)[2]).toBe('2');
    expect(describeDrops(MOB_DROPS.pig, true)).toBe('2–3 Raw Pork, Rawhide and Pig Fat (60 %)');
  });
});

describe('handbook: formatting', () => {
  it('numbers, signs, percentages, temperatures, durations and clock times', () => {
    expect([fmtNum(0.12), fmtNum(1.5), fmtNum(2), fmtNum(-4), fmtNum(1.4666, 2), fmtNum(NaN)]).toEqual(['0.12', '1.5', '2', '−4', '1.47', '—']);
    expect([fmtSigned(8), fmtSigned(-10), fmtSigned(0)]).toEqual(['+8', '−10', '0']);
    expect([fmtPct(0.5), fmtPct(0.03), fmtPct(0.005)]).toEqual(['50 %', '3 %', '0.5 %']);
    expect([fmtTemp(37), fmtTemp(-11.24), fmtTemp(34.68)]).toEqual(['37.0 °C', '−11.2 °C', '34.7 °C']);
    expect([fmtDuration(40), fmtDuration(300), fmtDuration(270), fmtDuration(100)]).toEqual(['40 s', '5 min', '4½ min', '1 min 40 s']);
    expect([fmtDurationLong(270), fmtDurationLong(1200), fmtDurationLong(60), fmtDurationLong(25)]).toEqual(['4½ minutes', '20 minutes', 'a minute', '25 seconds']);
    expect([fmtClock(0.3), fmtClock(0.75), fmtClock(0)]).toEqual(['07:12', '18:00', '00:00']);
    expect([listJoin([]), listJoin(['a']), listJoin(['a', 'b']), listJoin(['a', 'b', 'c'])]).toEqual(['', 'a', 'a and b', 'a, b and c']);
    expect([numWord(7), numWord(6), numWord(0), numWord(12), numWord(13), numWord(1.5)]).toEqual(['seven', 'six', 'no', 'twelve', '13', '1.5']);
  });

  it('inline marks: *emphasis* and [Key] caps', () => {
    expect(inlineParts('Press [R] to *read* it.')).toEqual([
      { t: 'text', s: 'Press ' }, { t: 'key', s: 'R' }, { t: 'text', s: ' to ' }, { t: 'em', s: 'read' }, { t: 'text', s: ' it.' },
    ]);
    expect(inlineParts('plain')).toEqual([{ t: 'text', s: 'plain' }]);
    expect(plainText('Hold [RMB] for *Leather*')).toBe('Hold RMB for Leather');
    expect(inlineParts('a * b')).toEqual([{ t: 'text', s: 'a * b' }]); // an unmatched mark stays text
  });

  it('recipe text helpers', () => {
    const rec = (id) => RECIPES.find((r) => r.id === id);
    expect(recipeInputs(rec('flint_pick'))).toBe('2 Knapping Stone + Stick + 2 Cord');
    expect(recipeInputsProse(rec('sleeping_hide'))).toBe('2 Leather, 6 Plant Fibre and 6 Sticks');
    expect(recipeInputsProse(rec('work_stump'))).toBe('a log');
    expect(recipeOutputs(rec('charcoal'))).toBe('Charcoal ×8');
    expect(recipeOutputs(rec('rag_bandage'))).toBe('Rag Bandage (+ Clay Pot back)');
    expect(recipeTools(rec('copper_pick'))).toBe('Crucible, Casting Mold');
    expect(recipeTools(rec('cord'))).toBe('');
  });
});

describe('handbook: the item (§14.2)', () => {
  it('HANDBOOK_KEY is a registered item that stays with you; the chat line names the last hotbar slot', () => {
    expect(HANDBOOK_KEY).toBe('handbook');
    expect(isItemKey(HANDBOOK_KEY)).toBe(true);
    expect(KEEP_ON_DEATH).toContain(HANDBOOK_KEY);
    expect(HANDBOOK_CHAT_LINE).toMatch(/last hotbar slot.*R to read/);
    // no recipe makes or takes it: a second copy cannot be made
    for (const r of RECIPES) {
      expect(r.outputs.some((o) => o.k === HANDBOOK_KEY), r.id).toBe(false);
      expect(r.inputs.some((i) => i.k === HANDBOOK_KEY), r.id).toBe(false);
    }
    expect(ITEMS.handbook.food).toBeUndefined(); // never spoils
  });

  it('begin: a new survival state\'s pack gets the handbook in slot 8, the last hotbar slot', () => {
    const s = new Survival();
    expect(s.setMode('survival')).toBe(true); // begin()
    const pack = new Pack();
    const v = pack.version;
    expect(ensureHandbook(pack)).toBe(true);
    expect(HOTBAR_SIZE - 1).toBe(8);
    expect(pack.slots[8]).toEqual({ k: 'handbook', n: 1 });
    expect(pack.slots.filter(Boolean)).toHaveLength(1);
    expect(pack.version).toBeGreaterThan(v);
    expect(ensureHandbook(pack)).toBe(false); // never a second copy
    expect(pack.count('handbook')).toBe(1);
  });

  it('death keeps it; waking gives it back if it was somehow lost (last free slot)', () => {
    const pack = new Pack();
    ensureHandbook(pack);
    pack.add({ k: 'rock', n: 12 });
    pack.add({ k: 'flint_pick', n: 1, d: 40 });
    const dumped = pack.dumpAll();
    expect(dumped.map((s) => s.k)).toEqual(['rock', 'flint_pick']);
    expect(pack.slots[8]).toEqual({ k: 'handbook', n: 1 });
    expect(ensureHandbook(pack)).toBe(false); // wake: still there, nothing to give
    // lost some other way (a console "pack clear"): waking puts one back, slot 8 when it is free …
    pack.clear();
    expect(ensureHandbook(pack)).toBe(true);
    expect(pack.slots[8]?.k).toBe('handbook');
    // … else the last empty slot
    pack.clear();
    pack.setSlot(8, { k: 'stick', n: 3 });
    pack.setSlot(26, { k: 'rock', n: 1 });
    expect(ensureHandbook(pack)).toBe(true);
    expect(pack.slots[25]?.k).toBe('handbook');
    // a full pack: nothing given
    const full = new Pack();
    for (let i = 0; i < PACK_SLOTS; i++) full.setSlot(i, { k: 'rock', n: 64 });
    expect(ensureHandbook(full)).toBe(false);
    // not a pack
    expect(ensureHandbook(/** @type {any} */ (null))).toBe(false);
    // a plain { slots, version } works too
    const plain = { slots: new Array(PACK_SLOTS).fill(null), version: 0 };
    expect(ensureHandbook(plain, 3)).toBe(true);
    expect(plain.slots[3]).toEqual({ k: 'handbook', n: 1 });
    expect(plain.version).toBe(1);
  });

  it('discard refuses it', () => {
    const pack = new Pack();
    ensureHandbook(pack);
    const session = { pack, cursor: null, container: null };
    slotClick(session, 'pack', 8, 0, false); // pick it up
    expect(session.cursor).toEqual({ k: 'handbook', n: 1 });
    const res = slotClick(session, 'discard', 0, 0, false);
    expect(res.refused).toBe('The handbook stays with you.');
    expect(res.changed).toBe(false);
    expect(session.cursor).toEqual({ k: 'handbook', n: 1 });
  });
});
