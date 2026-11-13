// Unit tests for src/handbook.js — the Survival Handbook's content (docs/DESIGN-survival.md §14): the chapters, and every
// generated table walked against the game table it restates, so the book can never disagree with the game.
import { describe, it, expect } from 'vitest';
import { STRIKE_REACH, STRIKE_REACH_MAX } from '../../src/survivalControl.js';
import { LEAN_PATCH_CHANCE, LEAN_PATCH_FILL, PATCH_TABLE_GEN4, HEMLOCK_SHARES, NIGHTSHADE_SHARES } from '../../src/worldgen.js';
import {
  HANDBOOK_KEY, HANDBOOK_CHAT_LINE, TABLE_ROWS_PER_PAGE, TABLE_SOURCES, CLIMATE_EXAMPLES, FALL_EXAMPLES, DANGER_NAMES,
  buildChapters, chapterIds, ensureHandbook, inlineParts, plainText, fmtNum, fmtSigned, fmtPct, fmtTemp, fmtDuration,
  fmtDurationLong, fmtClock, listJoin, numWord, describeDrops, recipeInputs, recipeInputsProse, recipeOutputs, recipeTools,
  toolNeedLabel, firstDayKit, fallSpeedForCells, climateExample, exampleBreakSeconds, temperatureBands,
  FLINT_SEEN, ANIMAL_R, HERD_WORDS, PROSE_KINDS, ELEMENTARY_PARTS, toolPowers, huntTargets, zombieTargets, herdBiomes, lureText, zombieStrike,
  SPREAD_WORDS, patchCaps, PICKED_WORDS,
} from '../../src/handbook.js';
import { ITEMS, ITEM_KEYS, TIER_NAMES, TIER_SPEED, itemName, isItemKey } from '../../src/items.js';
import { RECIPES, STATION_IDS, STATION_NAMES, inputLabel } from '../../src/crafting.js';
import {
  BLOCK_RULES, MOB_DROPS, PICKABLE, DEEP_BELOW_SEA, GRAVEL_FLINT_P, SEED_DROPS, FERN_FIBRE_P, breakSeconds, ruleFor, toolPower, pick, rollDrops,
} from '../../src/harvest.js';
import { HEAT_SOURCES, DIURNAL_PEAK_T } from '../../src/climate.js';
import { RATES, DAMAGE_CAUSES, SOFT_LANDING, fallDamage } from '../../src/vitals.js';
import { FIRE_TRANSFORMS, isSkewerFood } from '../../src/cooking.js';
import { BLOCK, BIOME, FLINT_SHARE, getBlockDef } from '../../src/blocks.js';
import {
  HOTBAR_SIZE, PACK_SLOTS, DAY_LENGTH_SECONDS, SUNRISE_TIME, SUNSET_TIME, DAYTIME_SECONDS, NIGHT_SECONDS, START_TIME, FUEL_LOG_S, REGROW_MEAN_S,
  PIG_HEALTH, PIG_NOTICE, REACH, WALK_SPEED, SPRINT_SPEED, ZOMBIE_DAMAGE, ZOMBIE_HITS, ZOMBIE_SIGHT, ZOMBIE_SPAWN_MIN, ZOMBIE_MAX_DROP,
  ZOMBIE_CHASE_MAX_RISE, ZOMBIE_FIRE_FEAR, GLOWSTONE_LIGHT, CAMPFIRE_LIGHT, TORCH_LIGHT,
} from '../../src/config.js';
import {
  ZOMBIE_KINDS, KIND_STATS, RUNNER_P, HORDE_SIZE, HORDE_RADIUS, HORDE_CHECK_S, ALPHA_CONVERT_P, ALPHA_MAX, ALPHA_RALLY, CLIMB,
  WALKER_WAKE_RANGE, PROVOKE_S, DAWN_BURROW_MIN_S, DAWN_BURROW_RAND_S, DAY_ALPHA_FACTOR, DAY_ALPHA_DAMAGE, gaitOf, damageOf, maxClimb,
} from '../../src/zombies.js';
// §86: zombies and light
import {
  ZOMBIE_SPAWN_LIGHT_MAX, ZOMBIE_DREAD_LIGHT, ALPHA_DREAD_LIGHT, ZOMBIE_SHY_LIGHT, GLARE_SLOW, GLARE_WEAK, GLARE_CLIMB, glareSpeed, strikeDamage,
} from '../../src/zombies.js';
import { zombieLights } from '../../src/handbook.js';
import { LIGHT_EMISSION } from '../../src/light.js';
import { LIGHT_MAX, LAMP_LIGHT_MIN, LAMP_LIGHT_MAX, ZOMBIE_SPAWN_FIRE_CLEAR } from '../../src/config.js';
import {
  SPECIES, ANIMAL_KINDS, SNEAK_NOTICE, SPRINT_NOTICE, BEHIND_NOTICE, VIEW_HALF_ANGLE, HERD_WEIGHTS, HERD_MIN, HERD_MAX, HIT_FLEE_S, FED_CALM_S, LURE_RANGE,
  SHEAR_REGROW_S, SHEAR_WOOL, MILK_REGROW_S, TRAP_HOLD_S, TRAP_IMMUNE_S, BAIT_RANGE, WOLF_GUARD, WOLF_BITE, HOME_RANGE, RIDE_SCALE,
  RIDE_LEAP, fleeSpeed, poolOf, BEAR_DAMAGE, BEAR_WARN_S, BEAR_CHARGE_DIST, BEAR_CHASE_S, BEAR_GIVE_UP,
} from '../../src/animals.js';
import {
  throwOf, STONE_KEYS, DART_KEYS, DART_BREAK_P, LOOSE_DESPAWN_S, LOOSE_BLINK_S, COLLECT_RADIUS, THROW_ROCK, THROW_DART, THROW_SPEAR,
  THROW_CHUCK, THROW_FLETCHED, FLETCHED_BREAK_P, dartBreakP,
} from '../../src/looseItems.js';
import { Pack, KEEP_ON_DEATH, slotClick } from '../../src/inventory.js';
import { BODY_MAX_CELLS, SPILL_STEP_S } from '../../src/fluids.js';
import { CELL_GULPS, POT_GULPS, DRY_MEAN_S, STREAM_DRY_MEAN_S, ROOF_DRY_FACTOR, FILL_MEAN_S } from '../../src/waterBodies.js';
import { Survival } from '../../src/survival.js';
import { RELIGHT_STICKS, waterHint } from '../../src/survivalControl.js';
import {
  CROPS, PLANTABLE, FARM_WATER_REACH, REED_WATER_REACH, SPROUT_MEAN_S, GROW_MEAN_S, SEED_TAKES, SEED_BACK_P, SOIL_EARTH, cropOf, soilWords,
  farmHint,
} from '../../src/farming.js';
import { SPREAD_KINDS, SPREAD_MEAN_S, SPREAD_STEP, SPREAD_RADIUS, SPREAD_RANGE, SPONTANEOUS_MEAN_S } from '../../src/spread.js';
import { RAIN_LANDS } from '../../src/handbook.js';
import {
  YEAR_DAYS, FAIR_START_DAYS, RAINS_DAYS, DRY_DAYS, RAIN_SHARE, SHOWER_MIN_S, SHOWER_MAX_S, RAINS_MAX_DRY_DAYS, LEAF_COVER, SEASON_LINES,
  calendarLine, createWeather, fallsAsSnow,
} from '../../src/weather.js';
import { RAIN_WATERS_S } from '../../src/farming.js';
import { RAIN_DOUSE_MEAN_S } from '../../src/campfires.js';
import { RAIN_WET_S, WET_CHILL, WET_DRY_S, WET_INSULATION_LOSS } from '../../src/climate.js';

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

/** Every table caption, head and cell of the book as one string. */
function allCells() {
  const out = [];
  for (const { block: b } of blocks()) if (b.kind === 'table') out.push(b.caption, ...b.head, ...b.rows.flat());
  return out.join('\n');
}
/** The book's prose cut into sentences (a colon ends one too: lists follow them). */
function sentences() {
  return allProse().split(/\n|(?<=[.!?:])\s+/).filter(Boolean);
}
/** The words of a page's text blocks, and its table rows. */
function pageSize(page) {
  const words = (s) => plainText(s).split(/\s+/).filter(Boolean).length;
  let n = 0;
  let rows = 0;
  for (const b of page) {
    if ('text' in b) n += words(b.text);
    if (b.kind === 'list') n += b.items.reduce((sum, it) => sum + words(it), 0);
    if (b.kind === 'table') rows += b.rows.length;
  }
  return { words: n, rows };
}

describe('handbook: the chapters (§14.1, CONTRACTS §73)', () => {
  it('twelve chapters: the ten of §14.1 in their order, Animals (§73) after the workplaces, and Seasons and rain (§84) after Water; every one with pages, every page with blocks', () => {
    expect(chapterIds()).toEqual(['first-day', 'water', 'seasons', 'food', 'warmth', 'ages', 'making', 'animals', 'dangers', 'death', 'controls', 'modes']);
    expect(CHAPTERS.map((c) => c.title)).toEqual(['Your first day', 'Water', 'Seasons and rain', 'Food and fire', 'Warm and cool', 'Tools and the ages',
      'Workplaces and making', 'Animals', 'Dangers', 'Death and waking', 'Controls', 'Creative and Survival']);
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

  it('pages stay page-sized: at most 220 words of text, or 110 beside a table; at most 14 table rows on a page', () => {
    // the field book re-pages what does not fit its window (handbookUI fitPage), but a page written to this budget fits
    // the Guide without scrolling and the field book at its full size without a cut
    for (const c of CHAPTERS) {
      c.pages.forEach((page, i) => {
        const { words, rows } = pageSize(page);
        expect(words, `${c.id} page ${i + 1}: words`).toBeLessThanOrEqual(rows > 0 ? 110 : 220);
        expect(rows, `${c.id} page ${i + 1}: rows`).toBeLessThanOrEqual(14);
      });
    }
  });

  it('the tables added in §73 that are five or more columns wide share their page with no margin note', () => {
    // beside a note the text column is 71 % wide (play-test round 2: "Food and drink" scrolled sideways beside "Goes bad")
    for (const id of ['blows-animals', 'blows-zombies', 'zombies']) {
      const page = [...blocks()].find((x) => x.block.kind === 'table' && x.block.id === id);
      expect(tableById(id).head.length, id).toBeGreaterThanOrEqual(5);
      expect(page.chapter.pages[page.page].filter((b) => b.kind === 'tip' || b.kind === 'warn'), id).toEqual([]);
    }
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
    // even splits: Hands (44 recipes with DESIGN-circuits §8.2's six and the dart) in five pages of 9, 9, 9, 9, 8
    expect(tableById('recipes-hand').parts.map((p) => p.rows.length)).toEqual([10, 10, 9, 9, 9]); // 45 with the Snare (§69); 47 with Healwort tea and the Fletched Dart (§76)
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

  it('older pages read their numbers from the recipes too: acorns to leach, snow and ice to a pot, sticks to relight', () => {
    const text = allProse();
    const takes = (id, k) => RECIPES.find((r) => r.id === id).inputs.find((i) => i.k === k).n;
    expect(text).toContain(`Soak ${takes('leached_acorns', 'acorns')} in a Pot of Water to leach them`);
    expect(text).toContain(`Pack ${takes('pot_snow', 'snow')} Snow or ${takes('pot_snow_ice', 'ice_chunk')} Ice Chunks into a Clay Pot`);
    expect(text).toContain(`a pinch of tinder and ${RELIGHT_STICKS} Sticks in your pack`);
    expect([takes('leached_acorns', 'acorns'), takes('pot_snow', 'snow'), takes('pot_snow_ice', 'ice_chunk'), RELIGHT_STICKS]).toEqual([6, 3, 2, 3]);
  });

  it('names things as the game does: the everyday tool names (§64), "Poisoned" (§66), and never an item key', () => {
    const everything = `${allProse()}\n${allCells()}`;
    expect(everything).not.toMatch(/hammerstone|chopper|digging stick|\bspades?\b/i);
    expect(everything).not.toMatch(/\bsick(ness)?\b/i); // the status is Poisoned
    expect(everything).not.toMatch(/[a-z]_[a-z]/); // "stone_hammer" once leaked into a first-day step
    for (const name of ['Stone Hammer', 'Stone Axe', 'Wooden Shovel', 'Flint Shovel']) expect(everything).toContain(name);
    expect(allProse()).toContain('When you are Poisoned');
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
    expect(STATION_IDS.map((s) => tableById(`recipes-${s}`).rows.length)).toEqual([47, 20, 24, 5, 15, 8]); // v0.11: + the Workbench (§67); v0.14: + Healwort tea and the Fletched Dart (§76)
  });

  it('tool labels name the cheapest tool that qualifies, "+" when better ones exist', () => {
    expect(toolNeedLabel('hammer', 1)).toBe('Stone Hammer+');
    expect(toolNeedLabel('axe', 1)).toBe('Stone Axe+');
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
    // the gating chain of §7.4 and §77: flint → copper ore and coal; copper → tin; bronze → iron; iron → gold; steel → gems
    expect(rowOf(t, 'pick:2')[2]).toContain('Copper Ore');
    expect(rowOf(t, 'pick:2')[2]).toContain('Coal Ore');
    expect(rowOf(t, 'pick:3')[2]).toBe('Tin Ore');
    expect(rowOf(t, 'pick:4')[2]).toBe('Iron Ore');
    expect(rowOf(t, 'pick:5')[2]).toBe('Gold Ore');
    expect(rowOf(t, 'pick:6')[2]).toBe('Diamond Ore');
    expect(rowOf(t, 'shovel:1')[2]).toBe('Clay'); // the first shovel opens clay, and with it the Kiln
    expect(rowOf(t, 'pick:2')[1]).toBe('Flint Pick');
  });

  it('the figures carry the game\'s data: the ages chain (§7.4), the body-temperature bands, the seven fire spots', () => {
    const figs = [...blocks()].map((x) => x.block).filter((b) => b.kind === 'figure');
    const ages = figs.find((f) => f.figure === 'ages').data;
    expect(ages.map((a) => a.name)).toEqual(['Hand', 'Stone', 'Flint', 'Copper', 'Bronze', 'Iron', 'Steel']);
    expect(ages[1].opens).toEqual(['logs', 'clay']); // the stone axe and the wooden shovel
    expect(ages[2].opens.slice(0, 2)).toEqual(['stone', 'copper']); // the flint pick opens stone and copper first
    expect(ages[3].opens).toEqual(['tin']);
    expect(ages[4].opens).toEqual(['iron']);
    expect(ages[5].opens).toEqual(['gold']);
    expect(ages[6].opens).toEqual(['diamond']);
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

  it('the food table\'s pages carry no margin note (its five columns do not fit beside one); "Goes bad" is explained with the spoilage prose', () => {
    // play-test round 2: "Food and drink" beside its "Goes bad" tip was 370 px wide in a 317 px column and scrolled sideways
    const food = CHAPTERS.find((c) => c.id === 'food');
    const tablePages = food.pages.filter((pg) => pg.some((b) => b.kind === 'table' && b.id === 'food'));
    expect(tablePages.length).toBeGreaterThan(0);
    for (const pg of tablePages) expect(pg.filter((b) => b.kind === 'tip' || b.kind === 'warn')).toEqual([]);
    const spoilage = food.pages.find((pg) => pg.some((b) => b.kind === 'h' && b.text === 'Spoilage and salt'));
    const goesBad = spoilage.findIndex((b) => b.kind === 'tip' && /^Goes bad/.test(b.text));
    expect(goesBad).toBeGreaterThan(0);
    expect(spoilage[goesBad - 1].kind).toBe('p'); // it follows prose, so it never starts a page alone
  });

  it('drinks, fire transforms, heat sources, clothes and bandages come from their tables', () => {
    const drinks = tableById('drinks');
    expect(drinks.keys).toEqual(ITEM_KEYS.filter((k) => ITEMS[k].food?.returns));
    expect(rowOf(drinks, 'pot_seawater').slice(1)).toEqual(['−10', '0', 'salty']);
    expect(rowOf(drinks, 'pot_water')[3]).toBe('poisons 40 %'); // 20 % from v0.11 (§66) until v0.15 (§79); the status is called Poisoned
    expect(rowOf(drinks, 'pot_water')[3]).toBe(`poisons ${fmtPct(ITEMS.pot_water.food.sick)}`);
    expect(rowOf(drinks, 'pot_boiled')[3]).toBe('safe');
    expect(rowOf(drinks, 'pot_milk')).toEqual(['Pot of Milk', '+20', '+12', 'safe']); // §72

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
    expect(bandages.keys).toEqual(ITEM_KEYS.filter((k) => ITEMS[k].kind === 'heal'));
    expect(bandages.keys).toEqual(['fibre_bandage', 'rag_bandage', 'aloe_leaf']); // §81: the Aloe Leaf heals too
    for (const k of bandages.keys) {
      const hl = ITEMS[k].heal;
      expect(rowOf(bandages, k).slice(1, 3)).toEqual([`${hl.hp} HP`, `${fmtNum(hl.rate)} HP/s`]);
      // a bandage names what it is made from; the leaf has no recipe, and its row says so
      const rec = RECIPES.find((r) => r.outputs[0].k === k);
      expect(rowOf(bandages, k)[3], k).toBe(rec ? recipeInputs(rec) : PICKED_WORDS);
    }
    expect(rowOf(bandages, 'aloe_leaf')).toEqual(['Aloe Leaf', '6 HP', '1.5 HP/s', 'picked, not made']);
    expect(bandages.parts[0].caption).toBe('Bandages and the Aloe Leaf');
  });

  it('the workplaces table: what builds each workplace, and its heat while working', () => {
    const t = tableById('workplaces');
    expect(t.keys).toEqual(['stump', 'kiln', 'bloomery', 'forge', 'workbench']);
    expect(rowOf(t, 'workbench')[1]).toContain('2 Steel Bar');
    expect(rowOf(t, 'kiln')).toEqual(['Kiln', '8 Clay Lump + 6 Rock', '+12 °C, 4 cells']);
    expect(rowOf(t, 'stump')[1]).toBe('Any Log (Stone Axe+)');
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
    expect(rowOf(t, 'zombie')[1]).toBe('8 HP a strike; an alpha 14');
    expect(rowOf(t, 'zombie')[1]).toBe(`${ZOMBIE_DAMAGE} HP a strike; an alpha ${Math.round(ZOMBIE_DAMAGE * KIND_STATS.alpha.damage)}`);
    expect(rowOf(t, 'bear')).toEqual(['Bears', `${BEAR_DAMAGE} HP a maul, and it throws you`,
      'Back away when it rears up and growls; do not strike one unless you mean to finish it']); // v0.14 (§76 fauna)
    expect(rowOf(t, 'sick')[0]).toBe('Poisoning');
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
    expect(t.keys).toEqual(['stone_hammer', 'stone_axe', 'cord', 'flint_knife', 'flint_axe', 'flint_pick', 'fire_drill', 'campfire']);
    expect(rowOf(t, 'cord')).toEqual(['Cord ×5', '10 Plant Fibre', '—', '5 s']);
    expect(allProse()).toContain('In all: 9 Rock, 4 Flint, 11 Plant Fibre and 8 Sticks, and 28 seconds of hand jobs.');
  });

  it('gathering rows describe PICKABLE (for what R picks) and BLOCK_RULES drops, and say how: R, or hold LMB', () => {
    const t = tableById('gather');
    for (const id of t.keys) {
      const row = rowOf(t, id);
      const picked = Object.hasOwn(PICKABLE, id);
      // loose stones: the flint is what the column shows (§70), not a roll, so the row says how to tell
      expect(row[2]).toBe(describeDrops(picked ? PICKABLE[id].drops : ruleFor(id).drops, false, id === BLOCK.LOOSE_STONES ? FLINT_SEEN : null));
      // play-test: "break it" never told a new player which button; the crosshair hint (harvest.handGatherHint) says the same
      expect(row[1].startsWith(picked ? 'R, or hold LMB' : 'hold LMB to ')).toBe(true);
    }
    expect(rowOf(t, BLOCK.TUSSOCK)[1]).toBe('hold LMB to pull it (a knife is faster)');
    expect(rowOf(t, BLOCK.OAK_LEAVES)[1]).toBe('hold LMB to break it (an axe is faster)');
    expect(allProse()).toContain('hold the left mouse button on it until it breaks');
    expect(rowOf(t, BLOCK.LOOSE_STONES)[2]).toBe('1–2 Rock · Flint (if a dark nodule shows, wild only)');
    expect(describeDrops(PICKABLE[BLOCK.LOOSE_STONES].drops)).toBe('1–2 Rock · Flint (6 %, wild only)'); // the rule itself
    expect(allCells()).not.toContain('Flint (6 %'); // the book never quotes it as a chance
    // §76: digging wild gravel is where flint comes from, by hand or with a shovel
    expect(rowOf(t, BLOCK.GRAVEL)[1]).toBe('hold LMB to dig it (a shovel is faster)');
    expect(rowOf(t, BLOCK.GRAVEL)[2]).toBe('with a shovel: Gravel; otherwise: 2 Rock · Flint (12 %, wild only)');
    expect(t.keys).not.toContain(BLOCK.FLINT_GRAVEL);
    expect(rowOf(t, BLOCK.TUSSOCK)[2]).toBe('with a shovel: Tussock Grass; with a knife: 2–3 Plant Fibre; otherwise: 1–2 Plant Fibre');
  });

  it('the striking-power table groups the tools by power; bare hands count against zombies only', () => {
    const t = tableById('power');
    expect(t.head).toEqual(['In your hand', 'Power']);
    expect(rowOf(t, 'hand')).toEqual(['Bare hands (against zombies only)', String(toolPower(null))]);
    expect(allProse()).toContain('Bare hands only shove an animal aside. Any tool in your hand wounds it');
    const tools = ITEM_KEYS.filter((k) => ITEMS[k].kind === 'tool');
    const powers = [...new Set(tools.map((k) => ITEMS[k].tool.power))].sort((x, y) => x - y);
    expect(toolPowers()).toEqual(powers);
    expect(t.keys.slice(1)).toEqual(powers);
    for (const pw of powers) {
      const mine = tools.filter((k) => ITEMS[k].tool.power === pw);
      expect(rowOf(t, pw)[1]).toBe(String(pw));
      if (pw === 1) expect(rowOf(t, pw)[0]).toBe(`Every other tool (${mine.length})`);
      else expect(rowOf(t, pw)[0].split(', ')).toEqual(mine.map((k) => itemName(k)));
    }
    expect(rowOf(t, 2)[0]).toContain('Stone Axe');
    expect(rowOf(t, 3)[0]).toContain('Flint Spear');
    expect(describeDrops(MOB_DROPS.pig, true)).toBe('2–3 Raw Pork, Rawhide and Pig Fat (60 %)');
  });
});

describe('handbook: the game since v0.11 (CONTRACTS §59–§73): the day, zombies, animals, throwing, flint, water, light, the Workbench', () => {
  const text = allProse();
  const sunrise = fmtClock(SUNRISE_TIME);
  const sunset = fmtClock(SUNSET_TIME);
  /** Every item of a block rule's or a pick's drop groups. */
  const dropItems = (groups) => groups.flat().flatMap((br) => br.items);

  it('the day follows config (§68): one real minute is one game hour, 15 of daylight and 9 of dark', () => {
    expect(DAY_LENGTH_SECONDS / 24).toBe(60);
    expect(DAYTIME_SECONDS + NIGHT_SECONDS).toBe(DAY_LENGTH_SECONDS);
    expect(text).toContain(`One real minute is one game hour: ${fmtDurationLong(DAYTIME_SECONDS)} of daylight, from ${sunrise} to ${sunset}, and ${fmtDurationLong(NIGHT_SECONDS)} of dark.`);
    expect(text).toContain('One real minute is one game hour: 15 minutes of daylight, from 04:30 to 19:30, and 9 minutes of dark.');
    expect(text).toContain(`A new world begins at ${fmtClock(START_TIME)}, about ${Math.round(((SUNSET_TIME - START_TIME) * DAY_LENGTH_SECONDS) / 60)} minutes before the zombies come out.`);
    expect(text).toContain(`Night lasts ${fmtDurationLong(NIGHT_SECONDS)}, from ${sunset} to ${sunrise}.`);
    expect(text).toContain(`Before sunset at ${sunset}, feed the fire a log and stay within ${ZOMBIE_FIRE_FEAR} cells of it.`);
    expect(Math.ceil(NIGHT_SECONDS / FUEL_LOG_S)).toBe(2);
    expect(text).toContain('Two logs carry a fire through the whole night.');
    // every clock time the prose names is one the game defines: no 18:00 dusk, no 06:00 dawn
    const known = new Set([sunrise, sunset, fmtClock(START_TIME), fmtClock(DIURNAL_PEAK_T), fmtClock(DIURNAL_PEAK_T + 0.5)]);
    const named = [...text.matchAll(/\b\d\d:\d\d\b/g)].map((m) => m[0]);
    expect(named.length).toBeGreaterThan(5);
    for (const t of named) expect(known.has(t), t).toBe(true);
    // Nourishment at rest lasts 30 minutes against a 24-minute day: no more "about 1 game days"
    expect(text).not.toMatch(/\b1 game days/);
    expect(text).toContain('in 30 minutes at rest, a little over a game day');
    expect(100 / RATES.SATIATION_DRAIN / DAY_LENGTH_SECONDS).toBeGreaterThan(1.1);
    expect(100 / RATES.SATIATION_DRAIN / DAY_LENGTH_SECONDS).toBeLessThan(1.5);
  });

  it('sunlight burns no zombie any more (§65): every sentence that pairs the sun with burning says so', () => {
    expect(text).not.toMatch(/smoulder/i);
    const sunBurn = sentences().filter((s) => /\b(sun|sunlight|dawn|morning|daylight)\b/i.test(s) && /\bburn/i.test(s));
    expect(sunBurn.length).toBeGreaterThanOrEqual(2);
    for (const s of sunBurn) expect(s).toMatch(/does not burn/);
    expect(text).toContain('Sunlight does not burn zombies away.');
    expect(text).toContain(`Morning does not burn the zombies away. A walker dozing in the light wakes if you come within ${WALKER_WAKE_RANGE} cells: look around before you leave the fire.`);
  });

  it('the zombie kinds table is KIND_STATS, CLIMB and the day constants (§61, §65)', () => {
    const t = tableById('zombies');
    expect(t.source).toBe('zombies');
    expect(t.head).toEqual(['Kind', 'Pace', 'Knock-out', 'Strike', 'Leaps']);
    expect(t.keys).toEqual([...ZOMBIE_KINDS]);
    for (const k of ZOMBIE_KINDS) {
      const [name, pace, ko, strike, leap] = rowOf(t, k);
      expect(name.toLowerCase()).toBe(k);
      // the pace is the chase input × the kind's factor, of the player's walk or sprint (zombies.gaitOf at night)
      const gait = gaitOf({ kind: k, daylit: false });
      expect(pace).toBe(`${fmtPct(gait.chase * gait.factor)} of your ${gait.sprint ? 'sprint' : 'walk'}`);
      expect(ko).toBe(`${KIND_STATS[k].hits} power`);
      const night = Math.round(ZOMBIE_DAMAGE * damageOf({ kind: k, daylit: false }));
      const day = Math.round(ZOMBIE_DAMAGE * damageOf({ kind: k, daylit: true }));
      expect(zombieStrike(k)).toEqual({ night, day });
      expect(strike).toBe(day === night ? `${night} HP` : `${night} HP (${day} by day)`);
      const up = maxClimb({ kind: k, daylit: false });
      const upDay = maxClimb({ kind: k, daylit: true });
      expect([up, upDay]).toEqual([CLIMB[k].night, CLIMB[k].day]);
      expect(leap).toBe(upDay === up ? `${up} cell${up === 1 ? '' : 's'}` : `${up} cells (${upDay} by day)`);
    }
    expect(t.rows).toEqual([
      ['Walker', '70 % of your walk', '4 power', '8 HP', '1 cell'],
      ['Runner', '95 % of your sprint', '3 power', '8 HP', '2 cells (1 by day)'],
      ['Alpha', '97 % of your walk', '12 power', '14 HP (10 by day)', '4 cells (2 by day)'],
    ]);
    expect(KIND_STATS.walker.hits).toBe(ZOMBIE_HITS);
    // "of your walk / sprint": a walker is slower than a walking player, a runner than a sprinting one
    expect(KIND_STATS.walker.chase * KIND_STATS.walker.factor * WALK_SPEED).toBeLessThan(WALK_SPEED);
    expect(KIND_STATS.runner.chase * KIND_STATS.runner.factor * SPRINT_SPEED).toBeLessThan(SPRINT_SPEED);
  });

  it('the zombie pages quote the game: night only, the horde and its alpha, dormant by day, the burrow, the leaps', () => {
    expect(text).toContain(`only in the dark, from ${sunset} to ${sunrise}: one or two at a time, never nearer than ${ZOMBIE_SPAWN_MIN} cells.`);
    expect(text).toContain(`One that notices you within ${ZOMBIE_SIGHT} cells comes for you. Each strike costs ${ZOMBIE_DAMAGE} HP and knocks you back.`);
    expect(text).toContain(`a drop deeper than ${ZOMBIE_MAX_DROP} cells, and it gives up on anyone standing more than ${ZOMBIE_CHASE_MAX_RISE} cells above it.`);
    expect(text).toContain(`About one in ${numWord(Math.round(1 / RUNNER_P))} is a runner`);
    expect(text).toContain(`When ${numWord(HORDE_SIZE)} or more zombies crowd within ${HORDE_RADIUS} cells of a runner, the runner may rise as the alpha (${fmtPct(ALPHA_CONVERT_P)} every ${HORDE_CHECK_S} seconds; never more than ${numWord(ALPHA_MAX)} at a time).`);
    expect(text).toContain(`Walkers within ${ALPHA_RALLY} cells of it hurry along at your own walking pace.`);
    expect(gaitOf({ kind: 'walker', daylit: false, rallied: true }).chase).toBe(1); // "your own walking pace"
    expect(text).toContain(`One wakes if you come within ${WALKER_WAKE_RANGE} cells, if you hit it (it stays awake for ${PROVOKE_S} seconds), or if an alpha is near.`);
    // by day a runner shambles at a walker's pace
    expect(gaitOf({ kind: 'runner', daylit: true })).toEqual(gaitOf({ kind: 'walker', daylit: false }));
    expect(text).toContain(`Runners only shamble, at a walker's pace, and leap ${CLIMB.runner.day} cell instead of ${CLIMB.runner.night}.`);
    const alpha = zombieStrike('alpha');
    const dayGait = gaitOf({ kind: 'alpha', daylit: true });
    expect(dayGait.factor).toBe(DAY_ALPHA_FACTOR);
    expect(alpha.day).toBe(Math.round(ZOMBIE_DAMAGE * DAY_ALPHA_DAMAGE));
    expect(text).toContain(`The alpha slows to ${fmtPct(dayGait.chase * dayGait.factor)} of your walk, strikes for ${alpha.day} HP instead of ${alpha.night}, and leaps ${CLIMB.alpha.day} cells instead of ${CLIMB.alpha.night}.`);
    expect(text).toContain(`after ${DAWN_BURROW_MIN_S} to ${DAWN_BURROW_MIN_S + DAWN_BURROW_RAND_S} seconds of daylight it burrows back into the ground.`);
    expect(text).toContain(`A wall ${CLIMB.walker.night + 1} cells high stops a walker.`);
  });

  it('light keeps them off (§86): the lights table is LIGHT_EMISSION and the zombie constants, and the prose quotes them', () => {
    const t = tableById('lights');
    expect(t.source).toBe('zombies');
    expect(t.head).toEqual(['Light', 'Strength', 'Walkers and runners keep', 'None comes up within']);
    const lights = zombieLights();
    expect(t.keys).toEqual(lights.map((l) => l.key));
    // every block the light model lets shine is a row, and the lit Filament Lamp (lit through LightEngine.setEmitter)
    const emitters = [];
    for (let id = 0; id < LIGHT_EMISSION.length; id++) if (LIGHT_EMISSION[id] > 0) emitters.push(id);
    expect(emitters.sort((a, b) => a - b)).toEqual([BLOCK.GLOWSTONE, BLOCK.CAMPFIRE, BLOCK.TORCH]);
    expect([...t.keys].sort()).toEqual([...emitters.map((id) => getBlockDef(id).name), getBlockDef(BLOCK.FILAMENT_LAMP).name].sort());
    for (const l of lights) {
      const fire = l.key === 'campfire';
      const id = BLOCK[l.key.toUpperCase()];
      if (l.key === 'filament_lamp') expect([l.min, l.max]).toEqual([LAMP_LIGHT_MIN, LAMP_LIGHT_MAX]);
      else expect([l.min, l.max], l.key).toEqual([LIGHT_EMISSION[id], LIGHT_EMISSION[id]]);
      // light falls by 1 a cell: lit 10 or more out to (strength − 10) cells, 7 or more out to (strength − 7)
      expect(l.keep, l.key).toBe(Math.max(l.max - ZOMBIE_DREAD_LIGHT, fire ? ZOMBIE_FIRE_FEAR : 0));
      expect(l.clear, l.key).toBe(Math.max(l.max - ZOMBIE_SPAWN_LIGHT_MAX, fire ? ZOMBIE_SPAWN_FIRE_CLEAR : 0));
      const upTo = l.min === l.max ? '' : 'up to ';
      expect(rowOf(t, l.key)).toEqual([l.name, l.min === l.max ? String(l.max) : `${l.min} to ${l.max}`, `${upTo}${l.keep} cells off`, `${upTo}${l.clear} cells`]);
    }
    expect(t.rows).toEqual([
      ['Torch', '13', '3 cells off', '6 cells'],
      ['Filament Lamp, lit', '7 to 14', 'up to 4 cells off', 'up to 7 cells'],
      ['Campfire', '14', '4 cells off', '8 cells'],
      ['Glowstone', '15', '5 cells off', '8 cells'],
    ]);
    expect(lights.map((l) => l.max)).toEqual([...lights.map((l) => l.max)].sort((a, b) => a - b)); // the weakest first
    // a campfire's light and its safe zone agree: 14 − 10 = ZOMBIE_FIRE_FEAR; its spawn rule (8) is wider than its light's (7)
    expect(CAMPFIRE_LIGHT - ZOMBIE_DREAD_LIGHT).toBe(ZOMBIE_FIRE_FEAR);
    expect(ZOMBIE_SPAWN_FIRE_CLEAR).toBeGreaterThan(CAMPFIRE_LIGHT - ZOMBIE_SPAWN_LIGHT_MAX);

    // ---- the prose
    expect(text).toContain('None comes up out of well-lit ground, and no walker or runner steps into strong light. Stand in that light yourself and they leave you alone: they do not even wait at its edge, unless you strike one.');
    expect(text).toContain(`Light loses 1 of its strength with every cell. Walkers and runners will not step where it is ${ZOMBIE_DREAD_LIGHT} or more. None comes up where it is ${ZOMBIE_SPAWN_LIGHT_MAX} or more, and fewer the brighter the ground below that.`);
    // weaker in proportion: a walker in the brightest light it will stand in (one below its dread) …
    const edge = { glare: (ZOMBIE_DREAD_LIGHT - 1) / LIGHT_MAX };
    expect(glareSpeed(edge)).toBeCloseTo(1 - GLARE_SLOW * (9 / 15), 12);
    expect(strikeDamage({ kind: 'walker', ...edge })).toBe(Math.round(ZOMBIE_DAMAGE * (1 - GLARE_WEAK * (9 / 15))));
    expect(text).toContain(`At the edge of a Torch's glow a walker is slowed to ${fmtPct(glareSpeed(edge))} of its pace and strikes for ${strikeDamage({ kind: 'walker', ...edge })} HP instead of ${ZOMBIE_DAMAGE}.`);
    expect(text).toContain('At the edge of a Torch\'s glow a walker is slowed to 70 % of its pace and strikes for 5 HP instead of 8.');
    // … the day leap from the first whole light level at or over GLARE_CLIMB …
    const climbLight = Math.ceil(GLARE_CLIMB * LIGHT_MAX);
    expect(climbLight).toBe(8);
    expect(maxClimb({ kind: 'runner', glare: climbLight / LIGHT_MAX })).toBe(CLIMB.runner.day);
    expect(maxClimb({ kind: 'alpha', glare: (climbLight - 1) / LIGHT_MAX })).toBe(CLIMB.alpha.night);
    expect(text).toContain(`From light ${climbLight} up, runners and the alpha leap only as high as by day.`);
    // … and the alpha beside a Torch, the brightest place it will stand
    expect(TORCH_LIGHT - 1).toBeLessThan(ALPHA_DREAD_LIGHT);
    expect(TORCH_LIGHT).toBeGreaterThanOrEqual(ALPHA_DREAD_LIGHT); // "right up to a Torch", not onto it
    const byTorch = { glare: (TORCH_LIGHT - 1) / LIGHT_MAX };
    const alphaDark = strikeDamage({ kind: 'alpha' });
    expect(alphaDark).toBe(zombieStrike('alpha').night);
    expect(text).toContain(`The alpha fears only light of ${ALPHA_DREAD_LIGHT} or more. It walks right up to a Torch, slowed to ${fmtPct(glareSpeed(byTorch))} of its pace and striking for ${strikeDamage({ kind: 'alpha', ...byTorch })} HP instead of ${alphaDark}. A burning campfire still keeps it ${ZOMBIE_FIRE_FEAR} cells away.`);
    expect(text).toContain('slowed to 60 % of its pace and striking for 6 HP instead of 14.');
    expect(text).toContain(`A zombie with nobody to chase keeps off ground lit ${ZOMBIE_SHY_LIGHT} or more and wanders away into the dark.`);
    // making a home safe: the floor, the walls by kind, torches with no gap between their dread, the campfire
    const torchEvery = 2 * (TORCH_LIGHT - ZOMBIE_DREAD_LIGHT) + 1;
    expect(torchEvery).toBe(7);
    for (let d = 1; d < torchEvery; d++) expect(Math.max(TORCH_LIGHT - d, TORCH_LIGHT - (torchEvery - d)), `cell ${d} between two torches`).toBeGreaterThanOrEqual(ZOMBIE_DREAD_LIGHT);
    expect(text).toContain(`Making a home safe at night. Give it a floor: none comes up in a column you have built in. A wall ${CLIMB.walker.night + 1} cells high stops walkers, ${CLIMB.runner.night + 1} runners and ${CLIMB.alpha.night + 1} the alpha. Stand a Torch every ${torchEvery} cells around the outside, and keep a campfire burning: nobody within ${ZOMBIE_FIRE_FEAR} cells of it is ever struck.`);
    expect(text).toContain('A wall 2 cells high stops walkers, 3 runners and 5 the alpha.');
    expect(text).toContain('Light behind a wall does not count: a Torch protects only the side it shines on. A fire that has burned out protects nothing.');
    // the page with the table keeps to the budget of a page with a table, and carries no margin note
    const page = [...blocks()].find((x) => x.block.kind === 'table' && x.block.id === 'lights');
    expect(page.chapter.id).toBe('dangers');
    expect(page.chapter.pages[page.page].filter((b) => b.kind === 'tip' || b.kind === 'warn')).toEqual([]);
    expect(page.chapter.pages[page.page][0]).toMatchObject({ kind: 'h', text: 'Light keeps them off' });
    expect(page.chapter.pages[page.page + 1][0]).toMatchObject({ kind: 'h', text: 'Weaker in the light' });
  });

  it('the two blows tables divide what a target takes by every tool power', () => {
    const powers = toolPowers();
    const check = (id, targets, lead) => {
      const t = tableById(id);
      expect(t.head).toEqual([...lead, ...powers.map((pw) => `Power ${pw}`)]);
      expect(t.keys).toEqual(targets.map((x) => x.key));
      for (const x of targets) expect(rowOf(t, x.key)).toEqual([x.name, String(x.points), ...powers.map((pw) => String(Math.ceil(x.points / pw)))]);
    };
    check('blows-zombies', zombieTargets(), ['Zombie', 'Takes']);
    check('blows-animals', huntTargets(), ['Animal', 'Health']);
    expect(zombieTargets().map((x) => [x.key, x.points])).toEqual(ZOMBIE_KINDS.map((k) => [k, KIND_STATS[k].hits]));
    expect(Object.fromEntries(huntTargets().map((x) => [x.key, x.points])))
      .toEqual({ pig: PIG_HEALTH, ...Object.fromEntries(ANIMAL_KINDS.map((k) => [k, SPECIES[k].health])) });
    const health = huntTargets().map((x) => x.points);
    expect(health).toEqual([...health].sort((x, y) => x - y)); // the weakest first
    // the pinned examples: a stone axe (power 2) takes three blows for a pig and two for a walker (§4.3); an alpha, twelve punches
    const axe = powers.indexOf(ITEMS.stone_axe.tool.power) + 2;
    expect(rowOf(tableById('blows-animals'), 'pig')[axe]).toBe('3');
    expect(rowOf(tableById('blows-zombies'), 'walker')[axe]).toBe('2');
    expect(rowOf(tableById('blows-zombies'), 'alpha')[2]).toBe('12');
    expect(text).toContain('strike three times with the Stone Axe');
    expect(text).toContain(`bare hands count for ${toolPower(null)}`);
    expect(text).toContain(`a tame wolf bites for ${WOLF_BITE}`);
    expect(text).toContain(`may leave a ${describeDrops(MOB_DROPS.zombie, true)}; an alpha has ${numWord(KIND_STATS.alpha.drops)} chances at one.`);
  });

  it('the animals table is SPECIES, HERD_WEIGHTS and MOB_DROPS (§69)', () => {
    const t = tableById('animals');
    expect(t.source).toBe('animals');
    expect(t.head).toEqual(['Animal', 'Where', 'Gives', 'Press R']);
    expect(t.keys).toEqual(['pig', ...ANIMAL_KINDS]);
    expect(rowOf(t, 'pig')).toEqual(['Pig', 'grass and snowy grass', describeDrops(MOB_DROPS.pig, true), '—']);
    const WORDS = { [BIOME.PLAINS]: 'plains', [BIOME.FOREST]: 'forest', [BIOME.MOUNTAINS]: 'mountains', [BIOME.SNOWY]: 'snowy land' };
    const herdLands = Object.keys(HERD_WEIGHTS).map(Number);
    for (const b of herdLands) expect(typeof WORDS[b], `biome ${b}`).toBe('string'); // every land that grows herds has a word
    // v0.14 (§76 fauna): a kind is weighed against the others of its own pool (herds and small game appear independently)
    const share = (b, k) => (HERD_WEIGHTS[b][k] ?? 0)
      / Object.keys(HERD_WEIGHTS[b]).filter((o) => poolOf(o) === poolOf(k)).reduce((sum, o) => sum + HERD_WEIGHTS[b][o], 0);
    for (const k of ANIMAL_KINDS) {
      const [name, where, gives, r] = rowOf(t, k);
      expect(name).toBe(SPECIES[k].name);
      if (SPECIES[k].water) {
        // fish are not of a land: they appear in the streams, and no HERD_WEIGHTS row names them
        expect([where, gives, r]).toEqual(['streams', describeDrops(MOB_DROPS[k], true), '—']);
        expect(herdLands.some((b) => Object.hasOwn(HERD_WEIGHTS[b], k))).toBe(false);
        continue;
      }
      // exactly the lands whose herds can be of this kind …
      const lands = herdLands.filter((b) => (HERD_WEIGHTS[b][k] ?? 0) > 0);
      expect(lands.length, k).toBeGreaterThan(0);
      expect(where.split(', ').sort()).toEqual(lands.map((b) => WORDS[b]).sort());
      // … the likeliest first: where the largest share of the herds is of this kind
      const order = herdBiomes(k);
      expect([...order].sort()).toEqual([...lands].sort());
      expect(where).toBe(order.map((b) => WORDS[b]).join(', '));
      for (let i = 1; i < order.length; i++) expect(share(order[i - 1], k)).toBeGreaterThanOrEqual(share(order[i], k));
      expect(gives).toBe(describeDrops(MOB_DROPS[k], true));
      expect(typeof ANIMAL_R[k], k).toBe('string');
      expect(r).toBe(ANIMAL_R[k].replace('{tame}', String(SPECIES[k].tame)));
      // only an animal that can be tamed says so, with its number of feeds
      expect(/tame/.test(r), k).toBe(SPECIES[k].tame > 0);
      if (SPECIES[k].tame > 0) expect(r).toContain(`${SPECIES[k].tame} times`);
      expect(typeof HERD_WORDS[k], k).toBe('string');
    }
    expect(rowOf(t, 'cow')).toEqual(['Cow', 'plains, forest', '3–5 Raw Beef and 1–2 Rawhide', 'with an empty Clay Pot in hand: milk']);
    expect(rowOf(t, 'sheep')[2]).toBe('1–2 Raw Mutton and 1–2 White Wool');
    expect(rowOf(t, 'horse')).toEqual(['Horse', 'plains', '1–2 Rawhide', 'with its food, 3 times: tame; then ride']);
    expect(rowOf(t, 'wolf')[1]).toBe('snowy land, forest, mountains');
    // v0.14 (§76 fauna): the game of the harder land
    expect(rowOf(t, 'deer')).toEqual(['Deer', 'forest, plains', '2–3 Raw Venison and Rawhide', '—']);
    expect(rowOf(t, 'rabbit')).toEqual(['Rabbit', 'snowy land, mountains, plains, forest', 'Raw Rabbit and Rawhide (40 %)', '—']);
    expect(rowOf(t, 'pheasant')).toEqual(['Pheasant', 'plains, forest', 'Raw Fowl and 2–4 Feather', '—']);
    expect(rowOf(t, 'turkey')).toEqual(['Wild Turkey', 'forest, plains', '2–3 Raw Fowl and 2–4 Feather', '—']);
    expect(rowOf(t, 'bear')).toEqual(['Bear', 'snowy land, mountains, forest', '6–8 Raw Bear Meat and 2–3 Rawhide', '—']);
    expect(rowOf(t, 'fish')).toEqual(['Fish', 'streams', 'Raw Fish', '—']);
  });

  it('how near you can come: the notice distances walking, sneaking and sprinting; food brings an animal to you', () => {
    const t = tableById('wary');
    expect(t.source).toBe('animals');
    const runners = ANIMAL_KINDS.filter((k) => !SPECIES[k].predator); // v0.14 (§76 fauna): a bear does not run
    expect(runners).toEqual(ANIMAL_KINDS.filter((k) => k !== 'bear'));
    expect(t.keys).toEqual(['pig', ...runners]);
    const cells = (n) => `${fmtNum(n, 1)} cells`;
    // v0.16: a fourth distance — sneaking up from behind, where it cannot see
    expect(t.head).toEqual(['Animal', 'Walking', 'Sneaking', 'From behind', 'Sprinting']);
    expect(rowOf(t, 'pig')).toEqual(['Pig', cells(PIG_NOTICE), cells(PIG_NOTICE * SNEAK_NOTICE), cells(PIG_NOTICE * SNEAK_NOTICE * BEHIND_NOTICE),
      cells(PIG_NOTICE * SPRINT_NOTICE)]);
    for (const k of runners) {
      const n = SPECIES[k].notice;
      expect(rowOf(t, k)).toEqual([SPECIES[k].name, cells(n), cells(n * SNEAK_NOTICE), cells(n * SNEAK_NOTICE * BEHIND_NOTICE), cells(n * SPRINT_NOTICE)]);
    }
    expect(rowOf(t, 'deer')).toEqual(['Deer', '16 cells', '6.4 cells', '3.2 cells', '21.6 cells']); // v0.14: the wariest of all
    expect(rowOf(t, 'horse')).toEqual(['Horse', '13 cells', '5.2 cells', '2.6 cells', '17.6 cells']);
    expect(text).toContain(`An animal sees ahead and to both sides, but not behind: the third of the circle at its back is blind. Sneak up from there and it notices you at ${fmtPct(BEHIND_NOTICE)} of the sneaking distance.`);
    expect([VIEW_HALF_ANGLE, BEHIND_NOTICE]).toEqual([(2 * Math.PI) / 3, 0.5]);
    // from behind, every animal that runs comes within arm's reach: the deer too
    for (const k of runners) expect(SPECIES[k].notice * SNEAK_NOTICE * BEHIND_NOTICE, k).toBeLessThan(REACH);
    expect(text).toContain('sneaking brings you within reach only from straight behind, so stalk one, throw a spear or a dart, or set a snare');
    expect(text).toContain(`an animal notices you at only ${fmtPct(SNEAK_NOTICE)} of its usual distance`);
    expect(text).toContain(`it spots you from ${fmtPct(SPRINT_NOTICE - 1)} farther off`);
    // sneaking brings every animal but the horse and (v0.14, §76 fauna) the deer within reach; the deer is the wariest;
    // the horse outruns a sprinter
    expect(runners.filter((k) => SPECIES[k].notice * SNEAK_NOTICE > REACH)).toEqual(['horse', 'deer']);
    expect(PIG_NOTICE * SNEAK_NOTICE).toBeLessThan(REACH);
    // v0.16: reach depends on what is in the hand; nothing but a thrown weapon reaches a deer from the front
    expect(STRIKE_REACH).toEqual({ hand: 2, knife: 3, hammer: 3, axe: 4, pick: 4, shovel: 4, sword: 5, spear: 6 });
    expect(text).toContain(`A strike reaches only as far as what you hold: bare hands 2 cells, a knife or a hammer 3, an axe, a pick or a shovel 4, a sword 5, a spear 6. Digging, placing and picking reach ${REACH} cells whatever you hold. Sneaking brings you within a spear's reach of every animal but the deer.`);
    expect(text).toContain('A deer stalked from behind lets you come to 3.2 cells: too far for bare hands (2) or a knife (3). It takes an axe, a sword or a spear.');
    expect(SPECIES.deer.notice * SNEAK_NOTICE).toBeGreaterThan(STRIKE_REACH_MAX);
    expect(SPECIES.deer.notice * SNEAK_NOTICE * BEHIND_NOTICE).toBeGreaterThan(STRIKE_REACH.knife);
    expect(SPECIES.deer.notice * SNEAK_NOTICE * BEHIND_NOTICE).toBeLessThan(STRIKE_REACH.axe);
    expect(Math.max(...runners.map((k) => SPECIES[k].notice))).toBe(SPECIES.deer.notice);
    expect(Math.max(...PROSE_KINDS.map((k) => SPECIES[k].notice))).toBe(SPECIES.horse.notice);
    expect(fleeSpeed('horse')).toBeGreaterThan(SPRINT_SPEED);
    expect(text).toContain('A wild horse spots you from far off, and it outruns you.');
    // what they come to
    expect(lureText(SPECIES.wolf.lure)).toBe('pork, beef, mutton, venison, rabbit, fowl or bear, raw or roast'); // v0.14: + the game meats
    expect(lureText(SPECIES.cow.lure)).toBe('Wild Tuber, Honeyberries, Tussock Grass or Cattail Root');
    for (const k of ANIMAL_KINDS) {
      for (const key of SPECIES[k].lure) {
        expect(isItemKey(key), key).toBe(true);
        expect(lureText(SPECIES[k].lure), key).toContain(/^(raw|roast)_/.test(key) ? key.replace(/^(raw|roast)_/, '') : itemName(key));
      }
    }
    expect(text).toContain('Cattle, sheep and horses come to Wild Tuber, Honeyberries, Tussock Grass or Cattail Root; wolves come to pork, beef, mutton, venison, rabbit, fowl or bear, raw or roast.');
    // v0.14 (§76 fauna): the game animals come to nothing and are never tamed; the prose above is about the four that do
    expect(PROSE_KINDS).toEqual(['cow', 'sheep', 'horse', 'wolf']);
    expect(ANIMAL_KINDS.filter((k) => !PROSE_KINDS.includes(k)).every((k) => SPECIES[k].lure.length === 0 && SPECIES[k].tame === 0)).toBe(true);
    expect(text).toContain(`from ${LURE_RANGE} cells away it trots up and waits beside you`);
    expect(text).toContain(`Cattle and sheep stay calm for ${FED_CALM_S} seconds after a mouthful`);
    expect(SPECIES.wolf.tame).toBe(SPECIES.horse.tame);
    expect(text).toContain(`A horse or a wolf is tamed by ${numWord(SPECIES.horse.tame)} feeds.`);
    expect([SPECIES.cow.tame, SPECIES.sheep.tame]).toEqual([0, 0]); // "cannot be tamed"
    expect(text).toContain('Cattle and sheep cannot be tamed');
  });

  it('the animal pages quote the game: herds, hunting, meat and milk, wool, riding, the wolf, snares', () => {
    expect(text).toContain('roam the land in small herds: 1–3 cattle or sheep, 1–2 horses or wolves.'); // v0.15 (§79): sparser
    for (const k of PROSE_KINDS) expect(text).toContain(`${SPECIES[k].herd[0]}–${SPECIES[k].herd[1]} `);
    expect(text).toContain(`${HERD_MIN} to ${HERD_MAX} cells from where you stand`);
    expect(text).toContain('A moo, a baa, a neigh or a woof means a herd is near');
    for (const k of PROSE_KINDS) expect(text.toLowerCase()).toContain(`a ${SPECIES[k].voice}`);
    expect(text).toContain(`for at least ${HIT_FLEE_S} seconds`);
    expect(text).toContain(`a rock counts ${THROW_ROCK.power}, a Flint Dart ${THROW_DART.power} and a Flint Spear ${THROW_SPEAR.power}.`);
    // milk (§72)
    const milk = ITEMS.pot_milk.food;
    expect(milk).toMatchObject({ satiation: 12, hydration: 20, sick: 0, returns: 'clay_pot' });
    expect(text).toContain(`A Pot of Milk gives ${fmtSigned(milk.satiation)} Nourishment and ${fmtSigned(milk.hydration)} Hydration, never poisons you, and leaves you the pot.`);
    expect(text).toContain(`She has more after ${fmtDurationLong(MILK_REGROW_S)}.`);
    expect(text).toContain(`A cow has milk again ${fmtDurationLong(MILK_REGROW_S)} after you milked her.`);
    expect(fmtDurationLong(MILK_REGROW_S)).toBe('4 minutes');
    // wool
    expect(text).toContain(`Shearing gives ${SHEAR_WOOL[0]}–${SHEAR_WOOL[1]} White Wool and costs the knife one use; the fleece is back in ${fmtDurationLong(SHEAR_REGROW_S)}.`);
    // the horse
    expect(text).toContain(`It goes where you look at ${fmtNum(RIDE_SCALE)} times your own pace`);
    expect(text).toContain(`leaps a wall ${Math.floor(RIDE_LEAP)} cells high when you press Space. Shift gets you off.`);
    expect(text).toContain(`it grazes within ${HOME_RANGE} cells of where you left it`);
    // the wolf
    expect(text).toContain(`It goes for any zombie within ${WOLF_GUARD} cells and bites it: ${WOLF_BITE} power every second.`);
    expect(text).toContain('Wolves keep to snowy land, forest and mountains');
    // snares
    const snare = RECIPES.find((r) => r.id === 'snare');
    expect(snare.station).toBe('hand');
    expect(text).toContain(`made at hand from ${recipeInputsProse(snare)}.`);
    expect(text).toContain(`is held fast for ${fmtDurationLong(TRAP_HOLD_S)}`);
    expect(text).toContain(`nothing catches it again for ${TRAP_IMMUNE_S} seconds`);
    expect(text).toContain(`calm cattle, sheep, horses and wolves within ${BAIT_RANGE} cells wander over to it`);
    // black holes take animals as they take pigs
    expect(text).toContain('A black hole swallows animals');
    // meat: one figure for the three raw meats, so they must share it
    for (const k of ['raw_pork', 'raw_beef', 'raw_mutton']) expect(ITEMS[k].food.sick).toBe(ITEMS.raw_pork.food.sick);
    expect(text).toContain(`Raw meat feeds you little and poisons you ${fmtPct(ITEMS.raw_pork.food.sick)} of the time.`);
    const roast = (k) => fmtSigned(ITEMS[k].food.satiation);
    expect(text).toContain(`Roast Mutton gives ${roast('roast_mutton')} Nourishment, Roast Pork ${roast('roast_pork')} and Roast Beef ${roast('roast_beef')}.`);
    expect(ITEMS.roast_pork.food.spoilS).toBe(2 * ITEMS.raw_pork.food.spoilS);
    expect(text).toContain('Roast meat keeps twice as long as raw.');
  });

  it('dropping and throwing (§60, §63): the throws table is throwOf; things on the ground come to you, blink and go', () => {
    const t = tableById('throws');
    expect(t.source).toBe('loose');
    expect(t.keys).toEqual(['stone', 'dart', 'fletched_dart', 'spear', 'chuck']); // v0.14 (§76 fauna): a row per dart
    const spears = ITEM_KEYS.filter((k) => ITEMS[k].tool?.type === 'spear');
    expect(spears.length).toBeGreaterThan(0);
    const names = (keys) => keys.map((k) => itemName(k)).join(', ');
    expect(rowOf(t, 'stone').slice(0, 3)).toEqual([names(STONE_KEYS), `${THROW_ROCK.speed} m/s`, String(THROW_ROCK.power)]);
    expect(DART_KEYS).toEqual(['flint_dart', 'fletched_dart']);
    expect(rowOf(t, 'dart')).toEqual(['Flint Dart', `${THROW_DART.speed} m/s`, String(THROW_DART.power), `breaks on ${fmtPct(DART_BREAK_P)} of its hits`]);
    expect(rowOf(t, 'fletched_dart')).toEqual(['Fletched Dart', `${THROW_FLETCHED.speed} m/s`, String(THROW_FLETCHED.power), `breaks on ${fmtPct(FLETCHED_BREAK_P)} of its hits`]);
    expect([dartBreakP('flint_dart'), dartBreakP('fletched_dart'), dartBreakP('rock')]).toEqual([DART_BREAK_P, FLETCHED_BREAK_P, 0]);
    expect(rowOf(t, 'spear').slice(0, 3)).toEqual([names(spears), `${THROW_SPEAR.speed} m/s`, String(THROW_SPEAR.power)]);
    expect(rowOf(t, 'chuck').slice(0, 3)).toEqual(['Anything else', `${THROW_CHUCK.speed} m/s`, String(THROW_CHUCK.power)]);
    for (const k of STONE_KEYS) expect(throwOf(k)).toBe(THROW_ROCK);
    expect([throwOf('flint_dart'), throwOf('fletched_dart')]).toEqual([THROW_DART, THROW_FLETCHED]);
    expect(THROW_FLETCHED.speed > THROW_DART.speed && THROW_FLETCHED.power > THROW_DART.power && FLETCHED_BREAK_P < DART_BREAK_P).toBe(true);
    for (const k of spears) expect(throwOf(k)).toBe(THROW_SPEAR);
    expect(throwOf('stick')).toBe(THROW_CHUCK);
    expect(t.rows.map((r) => r.slice(0, 3))).toEqual([['Rock, Flint, Obsidian Shard', '13 m/s', '1'], ['Flint Dart', '21 m/s', '2'],
      ['Fletched Dart', '26 m/s', '3'], ['Flint Spear', '17 m/s', '4'], ['Anything else', '6 m/s', '0']]);
    expect(text).toContain(`Walk within ${fmtNum(COLLECT_RADIUS)} cells of something lying loose and it comes to you`);
    expect(text).toContain(`After ${fmtDurationLong(LOOSE_DESPAWN_S)} on the ground a thing is gone; it blinks for its last ${LOOSE_BLINK_S} seconds to warn you.`);
    expect(text).toContain('After 5 minutes on the ground');
    expect(text).toContain('A burning campfire burns up whatever lands in it.');
    expect(text).toContain('It pops out, flies to you, and is yours when it reaches you.');
    // the dart's recipe, in words
    const dart = RECIPES.find((r) => r.id === 'flint_dart');
    expect(dart.inputs.map((i) => [i.k, i.n])).toEqual([['flint', 1], ['stick', 1], ['plant_fibre', 1]]);
    expect(text).toContain(`One Flint, one Stick and one Plant Fibre make ${numWord(dart.outputs[0].n)} Flint Darts at hand, with a Stone Hammer.`);
  });

  it('the controls chapter has Q and G, the riding keys, and R on animals and snares before everything else', () => {
    const keyRow = (t, key) => t.rows.find((r) => r[0] === key);
    const hands = tableById('keys-hands');
    expect(keyRow(hands, 'Q')[1]).toBe('drop one of what you hold (with Shift: the whole stack)');
    expect(keyRow(hands, 'G')[1]).toBe('throw one of what you hold where you look');
    expect(keyRow(tableById('keys-move'), 'Shift')[1]).toMatch(/^sneak: .*animals/);
    const ride = tableById('keys-ride');
    expect(ride.source).toBe(null);
    expect(ride.rows.map((r) => r[0])).toEqual(['R', 'Mouse', 'W A S D', 'W W', 'Space', 'Shift']);
    expect(keyRow(ride, 'Space')[1]).toBe(`leap a wall ${Math.floor(RIDE_LEAP)} cells high`);
    expect(keyRow(ride, 'Shift')[1]).toBe('get off');
    const controls = CHAPTERS.find((c) => c.id === 'controls');
    const rList = controls.pages.flat().find((b) => b.kind === 'list' && b.ordered);
    // main asks animalR() and snareR() before every other R case (§69)
    expect(rList.items[0]).toMatch(/^An animal: .*milk a cow, shear a sheep, ride your horse, .*sit or follow/);
    expect(rList.items[1]).toMatch(/^A snare: bait it/);
    expect(rList.items[2]).toMatch(/^A campfire/);
    expect(rList.items.at(-1)).toMatch(/handbook in hand: read it/);
    expect(text).toContain('Q drops one of the thing in your hand');
    expect(text).toContain('G throws one where the crosshair points.');
    expect(text).toContain('This book can be neither dropped nor thrown.');
  });

  it('flint (§76): digging wild gravel turns it up now and then; a few loose stones show a nodule; never from mined stone', () => {
    expect(dropItems(PICKABLE[BLOCK.LOOSE_STONES].drops).find((it) => it.k === 'flint').p).toBe(FLINT_SHARE);
    expect([FLINT_SHARE, GRAVEL_FLINT_P]).toEqual([0.06, 0.12]);
    expect(dropItems(ruleFor(BLOCK.STONE).drops).find((it) => it.k === 'flint')).toBeUndefined();
    const fromGravel = dropItems(ruleFor(BLOCK.GRAVEL).drops).find((it) => it.k === 'flint');
    expect([fromGravel.n, fromGravel.p, fromGravel.natural]).toEqual([1, GRAVEL_FLINT_P, true]);
    expect(text).toContain(`Flint hides in gravel. Dig wild gravel, by hand or with a shovel, and about one cell in 8 (${fmtPct(GRAVEL_FLINT_P)}) turns up a Flint. Gravel you have put down yourself gives none.`);
    expect(text).toContain(`A few Loose Stones (${fmtPct(FLINT_SHARE)}) show a dark nodule and give one too.`);
    expect(text).toContain('For Flint, dig gravel: now and then a cell turns one up.');
    expect(text).not.toMatch(/Flinty Gravel/);
    expect(text).not.toMatch(/turns up in stone you mine/);
  });

  it('the harder Survival (§76, §77): tainted water and streams, food in bunches, game, the bear, what gates what', () => {
    const R = RATES;
    // water: what it is, what it costs, that it spoils — every number from the rules
    expect(text).toContain('clear blue water is fresh, murky green-brown water is tainted. Most ponds are tainted');
    expect(text).toContain('Streams always run fresh');
    expect(text).toContain(`Tainted water is worse still: ${fmtPct(R.GULP_TAINTED_SICK)} a gulp, ${fmtPct(ITEMS.pot_tainted.food.sick)} a pot.`);
    expect(text).toContain('Tainted water is worse still: 40 % a gulp, 60 % a pot.');
    // v0.15 (§79): raw fresh water is no longer nearly safe, but tainted water stays twice as bad a gulp
    expect(R.GULP_TAINTED_SICK).toBeGreaterThanOrEqual(R.GULP_FRESH_SICK * 2);
    expect(ITEMS.pot_tainted.food.sick).toBeGreaterThan(ITEMS.pot_water.food.sick);
    expect(text).toContain('Water that flows out of a tainted pond is still tainted, though it looks clear.');
    expect(ITEMS.pot_water.food).toMatchObject({ spoilS: 2 * DAY_LENGTH_SECONDS, spoilsTo: 'pot_tainted' });
    expect(text).toContain('A Pot of Water left standing in your pack or a basket turns into a Pot of Tainted Water, on average after about 2 game days.');
    expect(ITEMS.pot_boiled.food.spoilS).toBeUndefined();
    expect(FIRE_TRANSFORMS.pot_tainted).toMatchObject({ to: 'pot_boiled', spot: 'centre' });
    expect(text).toContain('Boiled water keeps for good, and boiling a tainted pot makes it safe.');
    expect(text).not.toMatch(/Ponds inland are fresh/);
    expect(rowOf(tableById('drinks'), 'pot_tainted')[3]).toBe('poisons 60 %');
    // food in bunches: the look-alike is described by its look, and the herb by what it does
    expect(text).toContain('Wild food grows in bunches, and there is not much of it.'); // v0.15 (§79): the lean land
    expect(text).toContain('The newest worlds are leaner still: about one food patch in three is left.');
    expect(LEAN_PATCH_CHANCE * LEAN_PATCH_FILL).toBeCloseTo(0.36, 6);
    expect(text).toContain('The Frecklecap grows among them and looks much the same: its cap is flatter and dotted with pale freckles, its stem thin, with a ring. It always poisons you, and roasting does not help.');
    expect([ITEMS.frecklecap.food.sick, ITEMS.roasted_frecklecap.food.sick, ITEMS.honeycap.food.sick]).toEqual([1, 1, 0]);
    expect(ITEMS.hazelnuts.food.spoilS).toBeUndefined(); // "nuts that never go bad"
    expect([ITEMS.healwort.food.cures, ITEMS.pot_healwort_tea.food.cures]).toEqual([true, true]);
    expect(text).toContain('A leaf ends a poisoning at once; steeped in a Pot of Boiled Water it makes Healwort Tea, which cures and quenches.');
    // game
    expect(text).toContain(`Deer keep to forest and plains in herds of ${SPECIES.deer.herd[0]} to ${SPECIES.deer.herd[1]}.`);
    expect(SPECIES.deer.notice).toBe(Math.max(...ANIMAL_KINDS.filter((k) => poolOf(k) !== 'fish' && !SPECIES[k].predator).map((k) => SPECIES[k].notice))); // "the wariest animal there is"
    expect(text).toContain('a Fletched Dart flies faster, hits harder and breaks less often than a Flint Dart.');
    expect(text).toContain('Only a spear catches one: thrust with it, or throw it with G.');
    expect(text).toContain(`it warns you for ${fmtNum(BEAR_WARN_S)} seconds. If you stay, come within ${fmtNum(BEAR_CHARGE_DIST)} cells of it, or hurt it, it charges`);
    expect(text).toContain(`A maul costs ${BEAR_DAMAGE} HP and throws you.`);
    expect(text).toContain(`It gives up after ${BEAR_CHASE_S} seconds, or once you are ${BEAR_GIVE_UP} cells away.`);
    expect(text).toContain('A bear is the richest kill there is: 6–8 Raw Bear Meat and 2–3 Rawhide.');
    // what gates what
    expect(text).toContain('Clay needs a shovel. The Wooden Shovel will do, and clay builds the Kiln.');
    expect(text).toContain('Smelting and casting copper and bronze burn coal itself: charcoal will not do.');
    expect(text).toContain('A copper pick mines tin, a bronze pick iron, an iron pick gold and a steel pick gems.');
    expect(text).toContain('Streams, tainted ponds, food in bunches and coal seams are part of the land of new worlds only.');
  });

  it('water that runs out (§83): the three depths, what a gulp and a pot cost a pool, sun and rain, breaches, clay, the sea, streams', () => {
    // two pages in the Water chapter, after "Water that stands"
    const water = CHAPTERS.find((c) => c.id === 'water');
    const heads = water.pages.map((page) => page.find((b) => b.kind === 'h')?.text ?? '');
    expect(heads).toEqual(['Fresh, tainted and salt', 'Drinking', 'Pots', 'Boiling', 'Water that stands', 'Water runs out', 'Holding water', 'Water from plants']);
    // the depths, and the hint that names them
    expect(text).toContain('It stands at one of three depths: full, low or shallow. After shallow it is dry. Shallow water is ankle-deep: you walk through it.');
    expect(text).toContain('The hint under your crosshair names it, and says how much is left of a pool: Fresh water · low, Tainted water · shallow, Sea water (salty).');
    expect([waterHint('fresh', false, 2), waterHint('tainted', false, 1), waterHint('salt', false, 3)].map((s) => s.split(' · R:')[0])).toEqual(['Fresh water · low', 'Tainted water · shallow', 'Sea water (salty)']);
    // gulps
    expect(text).toContain(`Each cell of a pool holds ${CELL_GULPS} gulps for each depth, and filling a pot takes ${POT_GULPS} gulps.`);
    expect(text).toContain('Each cell of a pool holds 6 gulps for each depth, and filling a pot takes 4 gulps.');
    expect(text).toContain(`A pond of seven cells gives about ${7 * CELL_GULPS} gulps before it drops a depth and about ${3 * 7 * CELL_GULPS} in all; a single cell gives about ${3 * CELL_GULPS}.`);
    expect(text).toContain('A pond of seven cells gives about 42 gulps before it drops a depth and about 126 in all; a single cell gives about 18.');
    expect(text).toContain('A gulp of the water that flows out of a pool is taken from that pool.');
    // sun and rain
    expect([DRY_MEAN_S, STREAM_DRY_MEAN_S]).toEqual([3 * DAY_LENGTH_SECONDS, 2 * DAY_LENGTH_SECONDS]);
    expect(text).toContain(`In dry weather it loses a depth about every 3 game days; under a roof or in a cave that takes ${numWord(ROOF_DRY_FACTOR)} times as long.`);
    expect(text).toContain('under a roof or in a cave that takes ten times as long.');
    expect(text).toContain(`Rain fills it again: a depth for about every ${fmtDurationLong(FILL_MEAN_S)} of hard rain, up to full.`);
    expect(text).toContain('a depth for about every 6 minutes of hard rain');
    expect(text).toContain('A dry pond takes water again in the rain, but it never grows larger than it was.');
    expect(text).toContain('Streams dwindle the same way: full after rain, a trickle in dry weather, dry in a drought, all but the head. Without rain a stream loses a depth about every 2 game days. Drinking does not lower a stream.');
    expect(text).toContain('The sea never runs out, and it is always salt.');
    expect(text).toContain(`The sea is salt, and so is any lake too big to be a pool: water whose surface is more than ${BODY_MAX_CELLS} cells is sea.`);
    expect(BODY_MAX_CELLS).toBe(128);
    // holding water
    expect(text).toContain('Every side of every cell of a pool must be a solid block or more standing water.');
    expect(text).toContain(`Dig away one block of a pond's bank, or the clay under it, and the pond runs out: it drops a depth every ${SPILL_STEP_S} seconds and is dry in ${3 * SPILL_STEP_S}.`);
    expect(text).toContain('it drops a depth every 4 seconds and is dry in 12.');
    expect(text).toContain('A plant or a torch in the gap does not hold it. A pool two cells deep drains from the top, down to the hole.');
    expect(text).toContain('Water with nothing under it falls until it lands. Water that flows away is lost: flowing water never becomes a pool again.');
    expect(text).toContain(`Clay holds rain. Dig a pit, floor it with Clay and leave it open to the sky. In the rain it takes its first water, shallow; then it fills like any pool. A basin can be many cells, up to ${BODY_MAX_CELLS}, if every cell lies on clay and every wall is whole.`);
    expect(text).toContain('Close a breach at once with any solid block: what ran out is gone, the rest holds.');
    expect(text).not.toMatch(/The sea and every beach are salt/); // (a pool the rain filled on a beach is fresh)
  });

  it('farming and the plants that spread (§80): seeds, ground, water and sky, how long it takes; the soft maxima; regrowth takes two days', () => {
    // slower regrowth: the sentence, and the constant it reads
    expect(REGROW_MEAN_S).toBe(2 * DAY_LENGTH_SECONDS);
    expect(text).toContain('A picked bush fruits again slowly: on average after about 2 game days.');
    expect(text).not.toMatch(/regrows in about/);
    // the two pages follow "Food in bunches" in Food and fire (after §81's two pages on the plants that are not food)
    const heads = CHAPTERS.find((c) => c.id === 'food').pages.map((page) => page.find((b) => b.kind === 'h')?.text ?? null);
    const i = heads.indexOf('Food in bunches');
    expect(heads.slice(i, i + 5)).toEqual(['Food in bunches', 'Know your plants', 'Plants worth knowing', 'Leave some to seed', 'Planting']);

    // Leave some to seed: plants spread from the ones left standing; picked clean, a place stays bare
    expect(text).toContain(`A plant left standing puts up a new one within ${numWord(SPREAD_STEP)} cells of itself.`);
    expect(text).toContain('One that stands alone on open ground does it on average once in about 3 game days.');
    expect(SPREAD_MEAN_S / DAY_LENGTH_SECONDS).toBe(3);
    expect(text).toContain(`A patch is full, and seeds no more, when this many stand within ${numWord(SPREAD_RADIUS)} cells of each other:`);
    expect([numWord(SPREAD_STEP), numWord(SPREAD_RADIUS)]).toEqual(['three', 'six']);
    // §81: flax, the hemlocks, the nightshade bushes and the aloes have a maximum of their own and join the lines
    expect(patchCaps()).toEqual(['Ten: cattails', 'Eight: wild carrots, wild onions, honeycaps or flax', 'Six: wild tubers, frecklecaps or hemlocks',
      'Five: honeyberry bushes or prickly pears', 'Four: hazel thickets, crab apple bushes, nightshade bushes or aloes', 'Three: healworts']);
    expect(Object.keys(SPREAD_WORDS)).toEqual(SPREAD_KINDS.map((k) => k.key)); // every kind has its word
    for (const line of patchCaps()) expect(text).toContain(line);
    // every spreading kind is on exactly one line, the one of its own cap
    for (const k of SPREAD_KINDS) {
      const lines = patchCaps().filter((line) => line.split(': ')[1].split(/, | or /).includes(SPREAD_WORDS[k.key]));
      expect(lines.map((line) => line.split(':')[0].toLowerCase()), k.key).toEqual([numWord(k.cap)]);
    }
    expect(text).toContain(`A plant does come up from nothing, but only once in about 10 game days somewhere within ${SPREAD_RANGE} cells of you.`);
    expect(SPONTANEOUS_MEAN_S / DAY_LENGTH_SECONDS).toBe(10);
    expect(text).toContain('Anything you harvest to the last one does not come back.');
    expect(text).toContain('Mushrooms spread in the shade: on grass or dirt under a tree, and on the stone floor of a cave. Every other plant needs open sky.');
    expect(SPREAD_KINDS.filter((k) => k.shade).map((k) => k.key)).toEqual(['honeycap', 'frecklecap']);
    expect(text).toContain('Take most of a patch and leave a few plants standing.');

    // Planting: what, where, why water and light, how long, that some seeds do not take
    expect(text).toContain(`A picked Wild Carrot or Wild Onion gives 1–2 seeds ${fmtPct(SEED_DROPS.carrot.p)} of the time, a cut Healwort one seed ${fmtPct(SEED_DROPS.healwort.p)} of the time.`);
    expect([SEED_DROPS.carrot.n, SEED_DROPS.onion.n, SEED_DROPS.onion.p, SEED_DROPS.healwort.n]).toEqual([[1, 2], [1, 2], SEED_DROPS.carrot.p, 1]);
    expect(dropItems(PICKABLE[BLOCK.CARROT_PLANT].drops)).toContainEqual(SEED_DROPS.carrot);
    expect(dropItems(PICKABLE[BLOCK.ONION_PLANT].drops)).toContainEqual(SEED_DROPS.onion);
    expect(dropItems(PICKABLE[BLOCK.HEALWORT_PLANT].drops)).toContainEqual(SEED_DROPS.healwort);
    expect(text).toContain('These are planted as they are: Wild Onion, Wild Tuber, Honeyberries, Hazelnuts, Crab Apple, Cactus Fruit, Unpeeled Cactus Fruit and Cattail Root. Mushrooms cannot be planted.');
    // every plantable item is named on the page: a seed of one of the three plants, or one of that list
    const planted = sentences().find((s) => s.startsWith('Wild Onion, Wild Tuber'));
    for (const k of Object.keys(PLANTABLE)) {
      if (/_seeds$/.test(k)) expect(itemName(k), k).toMatch(/^(Carrot|Onion|Healwort) Seeds$/);
      else expect(planted.replace(/\.$/, '').split(/, | and /), k).toContain(itemName(k));
    }
    expect(text).toContain(`Most crops grow in ${soilWords(SOIL_EARTH)}. Cactus Fruit grows in ${soilWords(cropOf('prickly_pear').soil)}, and Cattail Root only with water within ${numWord(REED_WATER_REACH)} cell of it.`);
    expect(text).toContain('Most crops grow in grass or dirt. Cactus Fruit grows in sand or red sand, and Cattail Root only with water within one cell of it.');
    expect(CROPS.filter((c) => c.soil === SOIL_EARTH)).toHaveLength(7);
    expect(text).toContain('A seed needs water and light.');
    expect(text).toContain(`Fresh water within ${numWord(FARM_WATER_REACH)} cells waters it, level with the soil or one step up or down: a stream, a clear pond, a channel you dig.`);
    expect(text).toContain('Tainted water and the sea do not count. It must also see the sky: only leaves or glass may be above it.');
    expect(text).toContain('Watered, a seed sprouts after about a game day on average and is grown about 2 game days later. Dry, that is about 3 game days and about 5 game days.');
    expect([SPROUT_MEAN_S.watered, GROW_MEAN_S.watered, SPROUT_MEAN_S.dry, GROW_MEAN_S.dry].map((s) => s / DAY_LENGTH_SECONDS)).toEqual([1, 2, 3, 5]);
    expect(text).toContain(`Not every seed takes: ${fmtPct(SEED_TAKES.watered)} of the watered ones, ${fmtPct(SEED_TAKES.dry)} of the dry ones.`);
    expect(text).toContain('Not every seed takes: 80 % of the watered ones, 35 % of the dry ones.');
    expect(text).toContain(`A seed dug out by hand comes back ${fmtPct(SEED_BACK_P)} of the time.`);
    // the hint words the page quotes are the hints' own
    expect(text).toContain('Look at what you planted: the hint says watered, dry or needs open sky.');
    const tails = [{ sky: true, watered: true, reed: true }, { sky: true, watered: false, reed: true }, { sky: false, watered: true, reed: true }]
      .map((state) => farmHint(BLOCK.PLANTED_CARROT, state).split(' · ')[1]);
    expect(tails).toEqual(['watered', 'dry: slow, and it may not take', 'needs open sky']);
    expect(text).toContain('A new bush, wild or planted, comes up bare and fruits later.');
  });

  it('the plants that are not food (§81): the two pairs and their tells, what eating one does, the useful plants and their numbers', () => {
    const R = RATES;
    const food = CHAPTERS.find((c) => c.id === 'food');
    const page = (title) => food.pages.find((p) => p.some((b) => b.kind === 'h' && b.text === title));
    const words = (p) => p.flatMap((b) => ('text' in b ? [plainText(b.text)] : [])).join('\n');

    // ---- Know your plants: most plants are not food; the pairs, in words a child can use in the field
    const know = words(page('Know your plants'));
    expect(know).toContain('Most plants are not food.');
    expect(know).toContain('Hemlock looks like the Wild Carrot: the same feathery leaves. A carrot has an orange crown at the soil and no flowers. Hemlock has flat white flower heads, purple blotches on its stem and a pale root.');
    expect(know).toContain('Nightshade looks like the Honeyberry Bush: the same low, dark bush. Honeyberries are long and pale blue. Nightshade berries are round, shiny and black, with small purple flowers among them.');
    // the names the page uses are the blocks' and the items' own
    expect([BLOCK.HEMLOCK, BLOCK.NIGHTSHADE_BUSH, BLOCK.CARROT_PLANT, BLOCK.HONEYBERRY_BUSH].map((id) => getBlockDef(id).displayName))
      .toEqual(['Hemlock', 'Nightshade Bush', 'Wild Carrot Plant', 'Honeyberry Bush']);
    expect([itemName('hemlock_root'), itemName('nightshade_berries'), itemName('healwort')]).toEqual(['Hemlock Root', 'Nightshade Berries', 'Healwort']);
    // what eating one does: always, for SICK_S seconds, not to be roasted away, and Healwort ends it
    expect(know).toContain(`A Hemlock Root or Nightshade Berries poison you every time, like the Frecklecap: you are Poisoned for ${R.SICK_S} seconds. Neither can be roasted. A leaf of Healwort ends the poisoning at once.`);
    expect(know).toContain('you are Poisoned for 45 seconds.');
    expect([ITEMS.hemlock_root.food.sick, ITEMS.nightshade_berries.food.sick, ITEMS.frecklecap.food.sick]).toEqual([1, 1, 1]);
    for (const k of ['hemlock_root', 'nightshade_berries']) {
      expect(FIRE_TRANSFORMS[k], k).toBeUndefined();
      expect(isSkewerFood(k), k).toBe(false);
      expect(RECIPES.some((r) => r.inputs.some((inp) => 'k' in inp && inp.k === k)), k).toBe(false); // nothing is made of it either
    }
    expect(ITEMS.healwort.food.cures).toBe(true);
    // "about half of what looks like a wild carrot is Hemlock": from the generation-4 table — a carrot patch holds the mean
    // share of look-alikes, and there are as many small hemlock patches as carrot patches (worldgenLean.test.js measures
    // it in generated land)
    const row = (key) => PATCH_TABLE_GEN4.find((r) => r.key === key);
    const perPatch = (r) => (r.radius === 1 ? 7 : 19) * r.fill; // the columns of a patch × its fill
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    expect(row('hemlock').chance).toEqual(row('carrot').chance);
    expect(row('hemlock').cell).toBe(row('carrot').cell);
    const mixed = mean(HEMLOCK_SHARES) * perPatch(row('carrot'));
    const hemlockShare = (mixed + perPatch(row('hemlock'))) / (perPatch(row('carrot')) + perPatch(row('hemlock')));
    expect(hemlockShare).toBeGreaterThan(0.45);
    expect(hemlockShare).toBeLessThan(0.6);
    expect(know).toContain('In the newest worlds about half of what looks like a wild carrot is Hemlock, and Nightshade stands among the honeyberries, most of all in the forest.');
    // "most of all in the forest": its own patches grow in the forest only; elsewhere it is only mixed in
    expect(row('nightshade').chance.map((c, b) => (c > 0 ? b : -1)).filter((b) => b >= 0)).toEqual([BIOME.FOREST]);
    expect(row('nightshade').chance[BIOME.FOREST]).toBe(row('honeyberry').chance[BIOME.FOREST]);
    expect(mean(NIGHTSHADE_SHARES)).toBeLessThan(mean(HEMLOCK_SHARES));
    // the hint names the plant and nothing more (main's hint is "<display name> · R: pick")
    expect(know).toContain('The hint under your crosshair names the plant you are looking at. Read it before you pick.');
    // one sentence of real-world sense, as a warning
    const warning = page('Know your plants').find((b) => b.kind === 'warn');
    expect(plainText(warning.text)).toBe('Outdoors, never eat a wild plant unless a grown-up who knows plants says it is safe.');

    // ---- Plants worth knowing: flax for fibre, aloe for a quick heal, and the greenery that is simply there
    const worth = words(page('Plants worth knowing'));
    expect(worth).toContain('Flax stands on the plains in small clumps: slender stems with sky-blue flowers. R pulls one up for 3–4 Plant Fibre; a tussock pulled by hand gives 1–2.');
    expect(pick(BLOCK.FLAX, {}, () => 0)).toEqual({ to: BLOCK.AIR, drops: [{ k: 'plant_fibre', n: 3 }] });
    expect(pick(BLOCK.FLAX, {}, () => 0.999).drops).toEqual([{ k: 'plant_fibre', n: 4 }]);
    expect([rollDrops(BLOCK.TUSSOCK, null, {}, () => 0), rollDrops(BLOCK.TUSSOCK, null, {}, () => 0.999)]).toEqual([[{ k: 'plant_fibre', n: 1 }], [{ k: 'plant_fibre', n: 2 }]]);
    expect(row('flax').chance.map((c, b) => (c > 0 ? b : -1)).filter((b) => b >= 0)).toEqual([BIOME.PLAINS]);
    // what fibre is for: two strands make a Cord, and every flint tool, the Fire Drill and the Snare take cord
    const cord = RECIPES.find((r) => r.id === 'cord');
    expect(cord.inputs).toEqual([{ k: 'plant_fibre', n: 2 }]);
    expect(worth).toContain('Two strands twist into a Cord, and cord binds every flint tool, the Fire Drill and the Snare.');
    const takesCord = (r) => r.inputs.some((inp) => 'k' in inp && inp.k === 'cord');
    const flintTools = ITEM_KEYS.filter((k) => ITEMS[k].tool && TIER_NAMES[ITEMS[k].tool.tier] === 'flint');
    expect(flintTools).toHaveLength(5);
    for (const k of [...flintTools, 'fire_drill', 'snare']) expect(takesCord(RECIPES.find((r) => r.outputs[0].k === k)), k).toBe(true);
    // the aloe: where it grows, what a pick gives, and the heal's three numbers beside the bandage's
    const aloe = ITEMS.aloe_leaf.heal;
    const fibre = ITEMS.fibre_bandage.heal;
    expect(worth).toContain('Aloe grows in the desert: a rosette of thick, pointed leaves with pale teeth. R takes its 1–2 leaves and the plant with them.');
    expect([pick(BLOCK.ALOE, {}, () => 0), pick(BLOCK.ALOE, {}, () => 0.999)]).toEqual([
      { to: BLOCK.AIR, drops: [{ k: 'aloe_leaf', n: 1 }] }, { to: BLOCK.AIR, drops: [{ k: 'aloe_leaf', n: 2 }] }]);
    expect(row('aloe').chance.map((c, b) => (c > 0 ? b : -1)).filter((b) => b >= 0)).toEqual([BIOME.DESERT]);
    expect(worth).toContain(`Hold RMB with an Aloe Leaf in hand: it heals ${aloe.hp} HP at ${fmtNum(aloe.rate)} HP a second and takes ${fmtNum(aloe.useS)} s to put on. A Fibre Bandage heals ${fibre.hp} HP, but it takes ${fmtNum(fibre.useS)} s and has to be made first.`);
    expect(worth).toContain('it heals 6 HP at 1.5 HP a second and takes 1 s to put on. A Fibre Bandage heals 15 HP, but it takes 1.5 s and has to be made first.');
    expect(aloe.hp).toBeLessThan(fibre.hp);
    expect(aloe.useS).toBeLessThan(fibre.useS);
    expect(RECIPES.some((r) => r.outputs.some((o) => o.k === 'aloe_leaf'))).toBe(false); // "has to be made" is the bandage's burden alone
    // both spread, each on its own ground; a shovel lifts either whole
    const kind = (key) => SPREAD_KINDS.find((k) => k.key === key);
    expect(worth).toContain('Both seed themselves like the food plants, flax on grass or dirt and aloe on sand, so leave some standing. A shovel lifts either whole.');
    expect(soilWords(kind('flax').soil)).toBe('grass or dirt');
    expect([...kind('aloe').soil]).toEqual([BLOCK.SAND, BLOCK.RED_SAND]);
    const shovel = { type: 'shovel', tier: 1, durability: 40, power: 1 };
    expect([rollDrops(BLOCK.FLAX, shovel, {}, () => 0), rollDrops(BLOCK.ALOE, shovel, {}, () => 0)]).toEqual([[{ k: 'flax', n: 1 }], [{ k: 'aloe', n: 1 }]]);
    // the greenery: nothing to eat; a fern gives a strand of fibre three times in ten
    expect(worth).toContain(`Ferns under the trees, and meadow daisies and thistles in the open, are simply part of the land: nothing on them is food. A fern pulled up by hand gives a strand of fibre ${fmtPct(FERN_FIBRE_P)} of the time.`);
    expect(worth).toContain('A fern pulled up by hand gives a strand of fibre 30 % of the time.');
    for (const id of [BLOCK.FERN, BLOCK.MEADOW_DAISIES, BLOCK.THISTLE]) {
      const gives = ruleFor(id).drops.flat().flatMap((br) => br.items).map((it) => it.k).filter((k) => ITEMS[k].kind === 'food');
      expect(gives, getBlockDef(id).name).toEqual([]);
      expect(PICKABLE[id], getBlockDef(id).name).toBeUndefined();
    }
    // the look-alikes spread too
    expect(worth).toContain('Hemlock and Nightshade seed themselves too. Near your camp, dig them out before they spread.');
    expect([kind('hemlock').cap, kind('nightshade').cap]).toEqual([6, 4]);
    // … and only the newest worlds grow any of them
    expect(text).toContain('Only their land has Hemlock, Nightshade, flax, aloe, ferns, daisies and thistles from the start.');
    // the healing page names the leaf beside the bandages
    expect(text).toContain('An Aloe Leaf, picked in the desert, works the same way.');
  });

  it('raw water poisons and boiling makes it safe (§66); Poisoned blocks healing, a bandage still works', () => {
    const R = RATES;
    expect(text).toContain(`A gulp of fresh water poisons you ${fmtPct(R.GULP_FRESH_SICK)} of the time (ten gulps in a row: ${fmtPct(1 - (1 - R.GULP_FRESH_SICK) ** 10)}), a Pot of Water ${fmtPct(ITEMS.pot_water.food.sick)}.`);
    expect(text).toContain('poisons you 20 % of the time (ten gulps in a row: 89 %), a Pot of Water 40 %.'); // v0.15 (§79)
    expect(text).toContain(`your stomach turns at once: ${fmtSigned(R.POISON_THIRST)} Hydration and ${fmtSigned(R.POISON_HUNGER)} Nourishment. For the next ${R.SICK_S} seconds you do not heal, hunger and thirst come ${fmtNum(R.SICK_FACTOR)} times as fast, and you lose ${fmtNum(R.SICK_DPS)} HP a second, though never below ${R.SICK_FLOOR} HP.`);
    expect(ITEMS.pot_boiled.food.sick).toBe(0);
    expect(FIRE_TRANSFORMS.pot_water).toMatchObject({ to: 'pot_boiled', spot: 'centre' });
    expect(text).toContain('Water boiled in the embers of a campfire is always safe.');
    expect(rowOf(tableById('status'), 'Poisoned')[2]).toContain('no healing');
    expect(text).toContain(`You heal ${fmtNum(R.REGEN)} HP a second while Nourishment and Hydration are at least ${R.REGEN_MIN_SATIATION}, your body is between ${R.REGEN_TEMP_MIN} and ${R.REGEN_TEMP_MAX} °C, you are not Poisoned and you have breath.`);
    expect(R.REGEN_MIN_HYDRATION).toBe(R.REGEN_MIN_SATIATION); // one figure for both
    expect(R.REGEN_FIRE_MULT).toBe(2); // "twice as fast"
    expect(text).toContain('A bandage heals whatever your state, even while you are Poisoned.');
  });

  it('light (§62): dark underground; campfires, torches and lamps shine; the torch\'s recipe and its saltpetre', () => {
    expect(GLOWSTONE_LIGHT).toBeGreaterThan(CAMPFIRE_LIGHT);
    expect(CAMPFIRE_LIGHT).toBeGreaterThan(TORCH_LIGHT);
    expect(text).toContain('A cave, a mine or a room closed in on every side is dark even at noon');
    expect(text).toContain('A burning Campfire, a Torch and a lit Filament Lamp shine by themselves.');
    expect(text).toContain(`a campfire's is gone ${CAMPFIRE_LIGHT} cells away, a Torch's ${TORCH_LIGHT}.`);
    expect(text).toContain('Glowstone, a builder\'s block from Creative, shines brightest of all.');
    expect(isItemKey('glowstone')).toBe(true);
    expect(RECIPES.some((r) => r.outputs.some((o) => o.k === 'glowstone'))).toBe(false); // … which is why it is a builder's block
    const torch = RECIPES.find((r) => r.id === 'torch');
    expect(torch.station).toBe('hand');
    expect(text).toContain(`A Torch is made at hand from ${recipeInputsProse(torch)}, with a Fire Drill.`);
    const salt = dropItems(ruleFor(BLOCK.STONE).drops).find((it) => it.k === 'saltpetre');
    expect(salt.deep).toBe(true);
    expect(text).toContain(`${fmtPct(salt.p)} of the stone you mine ${DEEP_BELOW_SEA} cells or more below sea level gives some.`);
  });

  it('the Workbench (§67): built last from steel, glass, copper wire and tin; its devices stand on the simple parts', () => {
    const made = (k) => RECIPES.find((r) => r.outputs[0].k === k);
    const bench = RECIPES.find((r) => r.id === 'workbench');
    expect(bench.station).toBe('hand');
    expect(toolNeedLabel(bench.tools[0].type, bench.tools[0].tier)).toBe('Iron Hammer+');
    expect(text).toContain(`It is built at hand from ${recipeInputsProse(bench)}, with an Iron Hammer: steel from the Forge, glass from the Bloomery, copper wire drawn at the Work Stump and tin smelted in the Kiln.`);
    // … and each of those comes from where the sentence says
    expect(bench.inputs.filter((i) => 'k' in i).map((i) => [i.k, made(i.k).station]))
      .toEqual([['steel_bar', 'forge'], ['glass', 'bloomery'], ['copper_wire', 'stump'], ['tin_ingot', 'kiln']]);
    const atBench = RECIPES.filter((r) => r.station === 'workbench');
    const benchMade = new Set(atBench.map((r) => r.outputs[0].k));
    for (const k of ELEMENTARY_PARTS) {
      expect(made(k).station, k).toBe('stump');
      expect(atBench.some((r) => r.inputs.some((i) => i.k === k)), k).toBe(true);
    }
    // every device starts from a simple part, or from a device that does
    for (const r of atBench) expect(ELEMENTARY_PARTS.includes(r.inputs[0].k) || benchMade.has(r.inputs[0].k), r.id).toBe(true);
    expect(text).toContain(`The simple parts are made at the Work Stump: the ${listJoin(ELEMENTARY_PARTS.map((k) => itemName(k)))}.`);
    expect(text).toContain(`The Workbench builds the clever devices on top of them: the ${listJoin(atBench.map((r) => itemName(r.outputs[0].k)))}.`);
    expect(text).toContain('the Forge, the Workbench) has its own lane');
  });
});

describe('handbook: Seasons and rain (CONTRACTS §84)', () => {
  const chapter = CHAPTERS.find((c) => c.id === 'seasons');
  const text = chapter.pages.flat().flatMap((b) => ('text' in b ? [plainText(b.text)] : b.kind === 'list' ? b.items.map(plainText) : [])).join('\n');

  it('its own chapter after Water, four pages: The year, the rain table, What rain does, Living with the seasons', () => {
    expect(chapter).toMatchObject({ title: 'Seasons and rain', short: 'Seasons', icon: 'rain' });
    expect(CHAPTERS.indexOf(chapter)).toBe(CHAPTERS.findIndex((c) => c.id === 'water') + 1);
    expect(chapter.pages).toHaveLength(4);
    expect(chapter.pages.map((page) => page.find((b) => b.kind === 'h')?.text)).toEqual(['The year', undefined, 'What rain does', 'Living with the seasons']);
    expect(chapter.pages[1][0].kind).toBe('table');
    // the water pages are another's to write: this chapter adds none to the Water chapter
    expect(CHAPTERS.find((c) => c.id === 'water').pages.flat().filter((b) => b.kind === 'h').map((b) => b.text)).not.toContain('The year');
  });

  it('the year: 28 days, the rains for 10 and the dry season for 18, a new world on the first day of the rains', () => {
    expect(text).toContain(`A year here is ${YEAR_DAYS} game days.`);
    expect(text).toContain(`The rains are its first ${RAINS_DAYS} days`);
    expect(text).toContain(`The dry season is the other ${DRY_DAYS}`);
    expect([YEAR_DAYS, RAINS_DAYS, DRY_DAYS]).toEqual([28, 10, 18]);
    expect(text).toContain('A new world begins on the first day of the rains, with two fair days before the first shower.');
    expect(FAIR_START_DAYS).toBe(2);
    // how to read the season: the HUD line as the game writes it, the word Rain, and the log's warning
    expect(text).toContain(calendarLine(12));
    expect(text).toContain('Day 12 · The dry season, day 2 of 18');
    expect(text).toContain('it ends with the word Rain');
    expect(text).toContain(`"${SEASON_LINES.ending}"`);
    expect(text).toContain('On the last day of the rains the log warns you');
  });

  it('it teaches the real idea, in plain words: a wet and a dry season, and a year planned around water', () => {
    expect(text).toMatch(/In many parts of the world the year is not summer and winter but a wet season and a dry season\./);
    expect(text).toMatch(/plan their whole year around water/);
    expect(text).toMatch(/travel with the water/);
    expect(text).toMatch(/Fill your pots and boil them: boiled water keeps\./);
    expect(text).toMatch(/Or move on\./);
    expect(text).toMatch(/Build a roof\./);
  });

  it('the rain table is weather.RAIN_SHARE, land by land; the desert\'s dry season says never', () => {
    const t = tableById('rain');
    expect(t.source).toBe('weather');
    expect(TABLE_SOURCES).toContain('weather');
    expect(t.head).toEqual(['Land', 'In the rains', 'In the dry season']);
    expect(t.keys).toEqual(['forest', 'mountains', 'plains', 'snowy', 'desert']);
    expect(t.rows).toEqual(RAIN_LANDS.map((l) => [l.name, fmtPct(RAIN_SHARE[l.biome].rains), RAIN_SHARE[l.biome].dry > 0 ? fmtPct(RAIN_SHARE[l.biome].dry) : 'never']));
    expect(t.rows).toEqual([
      ['Forest', '45 %', '5 %'],
      ['Mountains', '40 %', '5 %'],
      ['Plains, beach and sea', '35 %', '3 %'],
      ['Snowy land (as snow)', '30 %', '5 %'],
      ['Desert', '8 %', 'never'],
    ]);
    // the lands the table folds together do share their numbers, and the snowy one is where it snows
    for (const b of [BIOME.BEACH, BIOME.OCEAN]) expect(RAIN_SHARE[b]).toEqual(RAIN_SHARE[BIOME.PLAINS]);
    expect(RAIN_SHARE[BIOME.SNOWY_PEAKS]).toEqual(RAIN_SHARE[BIOME.SNOWY]);
    expect(RAIN_LANDS.filter((l) => fallsAsSnow(l.biome)).map((l) => l.name)).toEqual(['Snowy land (as snow)']);
  });

  it('showers: one to four game hours; never three days without one in the rains; three or four in a dry season on the plains', () => {
    const hour = DAY_LENGTH_SECONDS / 24;
    expect(text).toContain(`showers of ${numWord(SHOWER_MIN_S / hour)} to ${numWord(SHOWER_MAX_S / hour)} game hours`);
    expect(text).toContain('showers of one to four game hours');
    expect(text).toContain(`${numWord(RAINS_MAX_DRY_DAYS)} days never pass without a shower`);
    expect(text).toContain('In the rains, outside the desert, three days never pass without a shower.');
    expect(text).toContain('the plains get only three or four showers in all');
    // and the weather does what the page says, over twenty years of a world
    const w = createWeather(2026);
    const DAY = DAY_LENGTH_SECONDS;
    for (let y = 0; y < 20; y++) {
      const from = y * YEAR_DAYS * DAY;
      const dry = w.showers(from + RAINS_DAYS * DAY, from + YEAR_DAYS * DAY, BIOME.PLAINS);
      expect([3, 4]).toContain(dry.length);
      let last = from;
      for (const s of w.showers(from, from + RAINS_DAYS * DAY, BIOME.MOUNTAINS)) {
        expect(s.start - last).toBeLessThan(RAINS_MAX_DRY_DAYS * DAY);
        last = s.end;
      }
    }
  });

  it('what rain does, with the game\'s numbers: crops for a day, fires in 30 s, wet in 20 s, 6 °C, dry in 1½ minutes', () => {
    expect(text).toContain(`about a third of the rain (${fmtPct(LEAF_COVER)}) comes through a tree`);
    expect(Math.abs(LEAF_COVER - 1 / 3)).toBeLessThan(0.03);
    expect(text).toContain('A roof stops it: any solid block overhead, glass too.');
    expect(RAIN_WATERS_S).toBe(DAY_LENGTH_SECONDS);
    expect(text).toContain('counts as watered for a game day afterwards, with no pond near');
    expect(text).toContain('Its hint reads watered by rain.');
    expect(farmHint(BLOCK.PLANTED_CARROT, { sky: true, watered: true, reed: true, rain: true })).toMatch(/ · watered by rain$/);
    expect(text).toContain(`goes out in a downpour after about ${RAIN_DOUSE_MEAN_S} seconds`);
    expect(text).toContain('goes out in a downpour after about 30 seconds');
    expect(text).toContain('leaves a cold fire pit to light again');
    expect(text).toContain('A fire under a roof is safe.');
    expect(text).toContain(`you are Wet through in ${RAIN_WET_S} seconds`);
    expect(text).toContain('you are Wet through in 20 seconds');
    expect(text).toContain(`Wet skin feels ${WET_CHILL} °C colder, and wet clothes keep only ${fmtPct(1 - WET_INSULATION_LOSS)} of their warmth.`);
    expect(text).toContain(`Under a roof you dry in ${fmtDurationLong(WET_DRY_S)}, beside a fire much faster.`);
    expect(text).toContain('Under a roof you dry in 1½ minutes');
    expect(text).toContain('Snow wets nothing, waters nothing and puts out no fire.');
  });

  it('living with the seasons: the rains are for planting; the dry season for stored water, a field near water, or moving on', () => {
    expect(text).toContain(`A seed on watered ground sprouts in about a game day and ${numWord(Math.round(SEED_TAKES.watered * 5))} in five take`);
    expect(SPROUT_MEAN_S.watered).toBe(DAY_LENGTH_SECONDS);
    expect(SEED_TAKES.watered * 5).toBe(4);
    expect(text).toContain(`A field more than ${FARM_WATER_REACH} cells from fresh water will be dry ground until a shower passes.`);
    expect(text).toContain('When the log says the rains are ending, you have one day.');
    expect(text).toContain('Leave your field open to the sky: the rain waters it for you.');
  });

  it('the first night is warned: a new world begins in the rains, and an open fire needs a roof', () => {
    const night = CHAPTERS[0].pages.find((page) => page.some((b) => b.kind === 'h' && b.text === 'Your first night'));
    expect(night.filter((b) => b.kind === 'tip').map((b) => plainText(b.text))).toEqual([
      'A new world begins in the rains, but the first two days stay fair. After that, rain puts out a fire under the open sky: set a block or two over your campfire as a roof. See Seasons and rain.',
    ]);
    // the fair start keeps the first two nights dry on every world; it is no idle warning after that: on most worlds it
    // rains during the THIRD night (19:30 to 04:30) on the plains
    const DAY = DAY_LENGTH_SECONDS;
    let firstNights = 0;
    let rainy = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const w = createWeather(seed * 7919);
      if (w.showers(SUNSET_TIME * DAY, (1 + SUNRISE_TIME) * DAY, BIOME.PLAINS).length > 0) firstNights++;
      if (w.showers((1 + SUNSET_TIME) * DAY, (2 + SUNRISE_TIME) * DAY, BIOME.PLAINS).length > 0) firstNights++;
      if (w.showers((2 + SUNSET_TIME) * DAY, (3 + SUNRISE_TIME) * DAY, BIOME.PLAINS).length > 0) rainy++;
    }
    expect(firstNights).toBe(0);
    expect(rainy / 200).toBeGreaterThan(0.8);
  });

  it('the Wet tag says both ways of getting wet', () => {
    expect(rowOf(tableById('status'), 'Wet')).toEqual(['Wet', 'out of the water, or rained on', `feels ${WET_CHILL} °C colder until you dry`]);
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
    expect([listJoin(['a', 'b'], 'or'), listJoin(['a', 'b', 'c'], 'or')]).toEqual(['a or b', 'a, b or c']);
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
