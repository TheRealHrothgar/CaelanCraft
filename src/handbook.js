// Caelancraft — the Survival Handbook's content: eleven chapters of hand-written prose, and every table that restates game
// data GENERATED from the game's own tables (recipes, tool tiers, block rules, food values, climate, damage, the animals,
// the zombie kinds, throws), so the book can never disagree with the game. The numbers the prose quotes about the game
// are read from its constants and recipes too (a few real-world figures and rough distances aside). Pure: no DOM. See
// docs/DESIGN-survival.md §14 and CONTRACTS §43, §48 and §73.
//
// One text, two books: handbookUI.js draws these chapters as the clean Guide (title screen and pause menu) and as the
// rustic field book (the `handbook` item). A chapter is `{ id, title, short, icon, pages }`; a page is a list of blocks:
//   { kind: 'h', text }                            a heading
//   { kind: 'p', text }                            a paragraph
//   { kind: 'tip', text } | { kind: 'warn', text } a tip / a warning (the field book pencils them into its margin)
//   { kind: 'list', items, ordered }               a list; `ordered` lists are steps
//   { kind: 'table', id, caption, head, rows, keys, source, part, parts }
//       `rows` are lists of plain-text cells. A generated table names its `source` (the game table it restates) and gives
//       each row's source key in `keys` (a recipe id, an item key, a block id, a damage cause …); a hand-written one has
//       `source: null`. A long table is split over pages: each part keeps the table's `id`, with `part` / `parts`.
//   { kind: 'figure', figure, caption, data }      a drawing ('fire-spots', 'ages', 'bands'), drawn by handbookUI as SVG
// Text in h, p, tip, warn and list items may carry two marks (inlineParts): *emphasis* and [Key] (a key cap). Table cells
// are plain text.
//
// Imports are read-only data and pure functions: config, blocks, items, crafting, harvest, climate, daynight, vitals,
// cooking, and the constants of zombies, animals, looseItems and survivalControl.
import {
  DAY_LENGTH_SECONDS, SUNRISE_TIME, SUNSET_TIME, DAYTIME_SECONDS, NIGHT_SECONDS, START_TIME, HOTBAR_SIZE, PACK_SLOTS,
  STATION_RANGE, STATION_WORK_RANGE, MAX_CRAFT_JOBS,
  CAMPFIRE_FUEL_START_S, CAMPFIRE_FUEL_MAX_S, FUEL_STICK_S, FUEL_LOG_S, RELIGHT_HOLD_S, GULP_GAP_S, TAP_HOLD_S,
  PIG_HEALTH, PIG_NOTICE, ZOMBIE_DAMAGE, ZOMBIE_SIGHT, ZOMBIE_CHASE_MAX_RISE, ZOMBIE_MAX_DROP, ZOMBIE_SPAWN_MIN, ZOMBIE_FIRE_FEAR,
  ZOMBIE_SPAWN_FIRE_CLEAR, FIRE_BURN_DAMAGE,
  CRUSH_DAMAGE_PER_CELL, BREATH_MAX_S, REGROW_MEAN_S, GRAVITY, MAX_SUBSTEP_DT, TERMINAL_VELOCITY,
  BODY_TEMP_NORMAL, BASKET_SLOTS, REACH, CAMPFIRE_LIGHT, TORCH_LIGHT,
} from './config.js';
import { BLOCK, BIOME, BIOME_NAMES, FLINT_SHARE, getBlockDef } from './blocks.js';
import { ITEMS, ITEM_KEYS, TIER_NAMES, TIER_SPEED, getItem, itemName } from './items.js';
import { RECIPES, STATION_IDS, STATION_NAMES, STATION_BLOCKS, getRecipe, inputLabel } from './crafting.js';
import {
  BLOCK_RULES, PICKABLE, HAND_GATHER, MOB_DROPS, breakSeconds, ruleFor, toolPower, UNDERWATER_DIG_FACTOR, DEEP_BELOW_SEA,
} from './harvest.js';
import {
  HEAT_SOURCES, DIURNAL_AMPLITUDE, DIURNAL_PEAK_T, ALTITUDE_LAPSE, ALTITUDE_REF_Y, SUN_HEAT, SHELTER_HEAT, SHELTER_BELOW,
  ACTIVITY_HEAT, GROUND_CHILL, WET_CHILL, WET_INSULATION_LOSS, WET_DRY_S, INSULATION_HOT_FROM, COMFORT_LOW, COMFORT_HIGH,
  feltTemperature, bodyTarget, heatAt,
} from './climate.js';
import { realSecondsBetween } from './daynight.js';
import { RATES, DAMAGE_CAUSES, SOFT_LANDING, fallDamage, tempBand } from './vitals.js';
import { FIRE_TRANSFORMS, SKEWER_SPOTS } from './cooking.js';
import {
  ZOMBIE_KINDS, KIND_STATS, RUNNER_P, HORDE_SIZE, HORDE_RADIUS, HORDE_CHECK_S, ALPHA_CONVERT_P, ALPHA_MAX, ALPHA_RALLY, CLIMB,
  WALKER_WAKE_RANGE, PROVOKE_S, DAWN_BURROW_MIN_S, DAWN_BURROW_RAND_S, DAY_ALPHA_FACTOR, DAY_ALPHA_DAMAGE,
} from './zombies.js';
import {
  SPECIES, ANIMAL_KINDS, SNEAK_NOTICE, SPRINT_NOTICE, HERD_WEIGHTS, HERD_MIN, HERD_MAX, HIT_FLEE_S, FED_CALM_S, LURE_RANGE,
  SHEAR_REGROW_S, SHEAR_WOOL, MILK_REGROW_S, TRAP_HOLD_S, TRAP_IMMUNE_S, BAIT_RANGE, WOLF_GUARD, WOLF_BITE, WOLF_BITE_S,
  HOME_RANGE, RIDE_SCALE, RIDE_LEAP,
} from './animals.js';
import {
  throwOf, STONE_KEYS, DART_KEYS, DART_BREAK_P, LOOSE_DESPAWN_S, LOOSE_BLINK_S, COLLECT_RADIUS,
} from './looseItems.js';
import { RELIGHT_STICKS } from './survivalControl.js';

/** @typedef {import('./types.js').ItemStack} ItemStack */

/** The handbook's item key (items.js registers it). */
export const HANDBOOK_KEY = 'handbook';
/** The sentence main adds to §1.2's "Survival: you carry nothing …" chat line when a survival state begins (§14.2). */
export const HANDBOOK_CHAT_LINE = 'Your handbook is in the last hotbar slot — hold it and press R to read.';
/** A generated table longer than this is split over several pages (each part as even as possible). */
export const TABLE_ROWS_PER_PAGE = 10;

/**
 * @typedef {{ kind: 'h'|'p'|'tip'|'warn', text: string }} TextBlock
 * @typedef {{ kind: 'list', items: string[], ordered: boolean, start?: number }} ListBlock  `start`: a numbered list cut over two pages carries on
 * @typedef {{ kind: 'table', id: string, caption: string, head: string[], rows: string[][], keys: (string|number)[],
 *   source: string|null, part: number, parts: number }} TableBlock
 * @typedef {{ kind: 'figure', figure: 'fire-spots'|'ages'|'bands', caption: string, data: any }} FigureBlock
 * @typedef {TextBlock|ListBlock|TableBlock|FigureBlock} Block
 * @typedef {{ id: string, title: string, short: string, icon: string, pages: Block[][] }} Chapter
 */

// ---------------------------------------------------------------------------------------------------------------------
// Formatting (pure, exported for tests)
// ---------------------------------------------------------------------------------------------------------------------

/** A number for people: at most `digits` decimals, trailing zeros dropped, a real minus sign (−). */
export function fmtNum(n, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  const f = 10 ** digits;
  const r = Math.round(n * f) / f + 0;
  const s = String(Math.abs(r));
  return r < 0 ? `−${s}` : s;
}

/** "+8", "−4", "0". */
export function fmtSigned(n, digits = 2) {
  return n > 0 ? `+${fmtNum(n, digits)}` : fmtNum(n, digits);
}

/** A chance 0..1 as "5 %" (one decimal below 1 %). */
export function fmtPct(p) {
  const v = p * 100;
  return `${fmtNum(v, v < 1 ? 1 : 0)} %`;
}

/** °C with one decimal kept ("34.7 °C", "−11.2 °C", "37.0 °C"). */
export function fmtTemp(t) {
  const r = Math.round(t * 10) / 10 + 0;
  const s = Math.abs(r).toFixed(1);
  return `${r < 0 ? '−' : ''}${s} °C`;
}

/** A duration for people: "40 s", "5 min", "4½ min", "1 min 40 s". */
export function fmtDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  if (rest === 0) return `${m} min`;
  if (rest === 30) return `${m}½ min`;
  return `${m} min ${rest} s`;
}

/** A duration in words, for prose: "40 seconds", "5 minutes", "4½ minutes", "a minute". */
export function fmtDurationLong(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} seconds`;
  const half = Math.round(s / 30) / 2;
  if (half === 1) return 'a minute';
  return `${Number.isInteger(half) ? half : `${Math.floor(half)}½`} minutes`;
}

/** A small count in words for prose ("seven"), digits beyond twelve. */
export function numWord(n) {
  const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  return Number.isInteger(n) && n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
}

/** A day fraction as a clock time: 0.3 → "07:12". */
export function fmtClock(t) {
  const mins = Math.round((((t % 1) + 1) % 1) * 24 * 60);
  return `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/** A drop count: 2 → "2 ", [1, 2] → "1–2 ", 1 → "". */
function countPrefix(n) {
  if (Array.isArray(n)) return `${n[0]}–${n[1]} `;
  return n > 1 ? `${n} ` : '';
}

/** "Fuel ×2" style: a key's display name with its count when more than one. */
function nameTimes(k, n) {
  return n > 1 ? `${itemName(k)} ×${n}` : itemName(k);
}

/** @param {string} s */
function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Split marked-up text into runs: plain text, `*emphasis*` and `[Key]` key caps. An unmatched mark stays as text.
 * @param {string} text
 * @returns {Array<{ t: 'text'|'em'|'key', s: string }>}
 */
export function inlineParts(text) {
  /** @type {Array<{ t: 'text'|'em'|'key', s: string }>} */
  const out = [];
  const re = /\*([^*\n]+)\*|\[([^\]\n]{1,14})\]/g;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) out.push({ t: 'text', s: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { t: 'em', s: m[1] } : { t: 'key', s: m[2] });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: 'text', s: text.slice(last) });
  return out;
}

/** @param {string} text @returns {string} the text without its marks (what a reader sees) */
export function plainText(text) {
  return inlineParts(text).map((p) => p.s).join('');
}

// ---------------------------------------------------------------------------------------------------------------------
// Readers of the game's tables
// ---------------------------------------------------------------------------------------------------------------------

/** Every tool item, in ITEM_KEYS order. */
const TOOL_KEYS = ITEM_KEYS.filter((k) => ITEMS[k].kind === 'tool');

/**
 * The cheapest tool item that satisfies a requirement, written "Stone Hammer+" when better ones of its kind exist ("+" =
 * that tool or any better one), plain for tier-0 kit and for the best of its kind.
 * @param {string} type @param {number} tier
 */
export function toolNeedLabel(type, tier) {
  const fits = TOOL_KEYS.filter((k) => ITEMS[k].tool?.type === type && /** @type {any} */ (ITEMS[k].tool).tier >= tier);
  if (fits.length === 0) return `${type} ${tier}`;
  fits.sort((a, b) => /** @type {any} */ (ITEMS[a].tool).tier - /** @type {any} */ (ITEMS[b].tool).tier);
  const best = fits[0];
  const better = fits.some((k) => /** @type {any} */ (ITEMS[k].tool).tier > /** @type {any} */ (ITEMS[best].tool).tier);
  return better ? `${itemName(best)}+` : itemName(best);
}

/** @param {{k?: string, tag?: string, n: number}} inp */
function inputText(inp) {
  return `${inp.n > 1 ? `${inp.n} ` : ''}${inputLabel(/** @type {any} */ (inp))}`;
}

/** A recipe's inputs: "2 Knapping Stone + Stick + 2 Cord". @param {import('./crafting.js').Recipe} rec */
export function recipeInputs(rec) {
  return rec.inputs.map(inputText).join(' + ');
}

/** Countable items whose prose plural is the name + 's' ("6 Sticks"); everything else is a mass noun ("9 Rock"). */
const COUNTABLE = /(Stick|Lump|Ingot|Brick|Rag|Chunk|Nugget|Gem|Pot|Bar)$/;
/** How a `#tag` reads in prose: [one, many]. */
const TAG_PROSE = Object.freeze({
  log: ['a log', 'logs'], planks: ['a plank', 'planks'], fuel: ['fuel', 'fuel'], tinder: ['tinder', 'tinder'],
  knapstone: ['a knapping stone', 'knapping stones'], sand: ['sand', 'sand'],
});

/** One recipe input in prose: "6 Sticks", "a log", "2 fuel". @param {{k?: string, tag?: string, n: number}} inp */
function proseInput(inp) {
  if (inp.tag !== undefined) {
    const [one, many] = TAG_PROSE[inp.tag] ?? [inputLabel(/** @type {any} */ (inp)), inputLabel(/** @type {any} */ (inp))];
    return inp.n > 1 ? `${inp.n} ${many}` : one;
  }
  const name = itemName(/** @type {string} */ (inp.k));
  if (inp.n <= 1) return name;
  return `${inp.n} ${COUNTABLE.test(name) ? `${name}s` : name}`;
}

/** "a, b and c" (or "a, b or c"). @param {string[]} parts @param {string} [word='and'] */
export function listJoin(parts, word = 'and') {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} ${word} ${parts[parts.length - 1]}`;
}

/** A recipe's inputs in prose: "2 Leather, 6 Plant Fibre and 6 Sticks". @param {import('./crafting.js').Recipe} rec */
export function recipeInputsProse(rec) {
  return listJoin(rec.inputs.map(proseInput));
}

/** A recipe's outputs: "Charcoal ×8", "Rag Bandage (+ Clay Pot back)". @param {import('./crafting.js').Recipe} rec */
export function recipeOutputs(rec) {
  const [first, ...rest] = rec.outputs;
  const extra = rest.map((o) => nameTimes(o.k, o.n)).join(', ');
  return nameTimes(first.k, first.n) + (extra ? ` (+ ${extra} back)` : '');
}

/** A recipe's tools: "Stone Hammer+", "Crucible, Casting Mold", "" for none. @param {import('./crafting.js').Recipe} rec */
export function recipeTools(rec) {
  return rec.tools.map((t) => toolNeedLabel(t.type, t.tier)).join(', ');
}

/** "with a shovel", "with a knife in your pack", "otherwise". */
function conditionText(cond) {
  if (cond === null) return 'otherwise';
  if (cond === 'knifeInPack') return 'with a knife in your pack';
  return `with ${/^[aeiou]/.test(cond) ? 'an' : 'a'} ${cond}`;
}

/**
 * One drop: "1–2 Rock", "Flint (50 %, wild only)". `seen[key]` replaces a chance the game does not roll with what the
 * player sees instead ("Flint (if a dark nodule shows, wild only)").
 * @param {import('./harvest.js').DropItem} it @param {Readonly<Record<string, string>>|null} [seen]
 */
function dropText(it, seen = null) {
  const notes = [];
  if (it.p !== undefined) notes.push(seen && Object.hasOwn(seen, it.k) ? seen[it.k] : fmtPct(it.p));
  if (it.natural) notes.push('wild only');
  return `${countPrefix(it.n)}${itemName(it.k)}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

/**
 * Loose Stones (CONTRACTS §70): the flint is not a roll but what the column shows (blocks.flintAt), so the gathering
 * table says how to tell instead of quoting FLINT_SHARE as a chance.
 */
export const FLINT_SEEN = Object.freeze({ flint: 'if a dark nodule shows' });

/**
 * Drop groups as text (§6.3's notation in words): each group gives at most one branch, the first whose condition holds.
 * `[[shovel → bush], [always → berries 2–4]]` → "with a shovel: Honeyberry Bush · 2–4 Honeyberries".
 * @param {ReadonlyArray<import('./harvest.js').DropGroup>} groups
 * @param {boolean} [prose=false] join the groups as a sentence ("2–3 Raw Pork, Rawhide and Pig Fat (60 %)")
 * @param {Readonly<Record<string, string>>|null} [seen=null] chances shown as what the player sees (dropText)
 * @returns {string} '' when nothing drops
 */
export function describeDrops(groups, prose = false, seen = null) {
  const parts = [];
  for (const group of groups) {
    const branches = group.map((br) => {
      const items = br.items.map((it) => dropText(it, seen)).join(' + ') || 'nothing';
      if (group.length === 1 && br.if === null) return items;
      return `${conditionText(br.if)}: ${items}`;
    });
    parts.push(branches.join('; '));
  }
  return prose ? listJoin(parts) : parts.join(' · ');
}

/** The first tool item of a type and tier (the "ages" columns), or null. */
function toolOf(type, tier) {
  return TOOL_KEYS.find((k) => ITEMS[k].tool?.type === type && ITEMS[k].tool?.tier === tier) ?? null;
}

/** Unique display names of the blocks whose rule needs exactly (tool, tier), ores first, then by block id. */
function blocksNeeding(tool, tier) {
  const ids = [];
  BLOCK_RULES.forEach((rule, id) => {
    if (rule && rule.tool === tool && rule.tier === tier) ids.push(id);
  });
  const names = [...new Set(ids.map((id) => getBlockDef(id).displayName))];
  const ore = names.filter((n) => / Ore$/.test(n));
  return [...ore, ...names.filter((n) => !/ Ore$/.test(n))];
}

/** Every (tool, tier) a block needs beyond bare hands, by tier then tool. @returns {Array<[string, number]>} */
function toolNeeds() {
  /** @type {Map<string, [string, number]>} */
  const seen = new Map();
  for (const rule of BLOCK_RULES) {
    if (rule && rule.tier > 0 && rule.tool) seen.set(`${rule.tool}:${rule.tier}`, [rule.tool, rule.tier]);
  }
  return [...seen.values()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
}

/** The chance of item `k` in a block's drops (first item found), or 0. */
function dropChance(blockId, k) {
  for (const group of ruleFor(blockId)?.drops ?? []) {
    for (const br of group) for (const it of br.items) if (it.k === k) return it.p ?? 1;
  }
  return 0;
}

/** The first recipe that outputs `k`. */
function recipeMaking(k) {
  return RECIPES.find((r) => r.outputs[0].k === k) ?? null;
}

/**
 * Landing speed after a fall of `cells`, from the real integrator (§2.4): semi-implicit Euler at MAX_SUBSTEP_DT, so after
 * n steps the speed is g·n·dt and the drop g·dt²·n(n+1)/2; the landing step is the first whose drop reaches `cells`.
 * @param {number} cells @returns {number} m/s
 */
export function fallSpeedForCells(cells) {
  const g = Math.abs(GRAVITY);
  const dt = MAX_SUBSTEP_DT;
  let n = 0;
  while ((g * dt * dt * n * (n + 1)) / 2 < cells) n++;
  return Math.min(g * n * dt, Math.abs(TERMINAL_VELOCITY));
}

/** The smallest whole drop (cells) that hurts, and the smallest that kills from full health. */
function fallThresholds() {
  let hurts = 0;
  let kills = 0;
  for (let d = 1; d < 200 && !kills; d++) {
    const hp = fallDamage(fallSpeedForCells(d));
    if (!hurts && hp > 0) hurts = d;
    if (hp >= RATES.NEW_HEALTH) kills = d;
  }
  return { hurts, kills };
}

// ---------------------------------------------------------------------------------------------------------------------
// Block constructors
// ---------------------------------------------------------------------------------------------------------------------

/** @param {string} text @returns {TextBlock} */
const h = (text) => ({ kind: 'h', text });
/** @param {string} text @returns {TextBlock} */
const p = (text) => ({ kind: 'p', text });
/** @param {string} text @returns {TextBlock} */
const tip = (text) => ({ kind: 'tip', text });
/** @param {string} text @returns {TextBlock} */
const warn = (text) => ({ kind: 'warn', text });
/** @param {string[]} items @returns {ListBlock} */
const steps = (items) => ({ kind: 'list', items, ordered: true });
/** @param {string[]} items @returns {ListBlock} */
const bullets = (items) => ({ kind: 'list', items, ordered: false });

/**
 * A table, split into even parts of at most TABLE_ROWS_PER_PAGE rows.
 * @param {{ id: string, caption: string, head: string[], rows: string[][], keys?: (string|number)[], source?: string|null }} t
 * @returns {TableBlock[]} one block per part (one page each)
 */
function table({ id, caption, head, rows, keys, source = null }) {
  const k = keys ?? rows.map((_, i) => i);
  const parts = Math.max(1, Math.ceil(rows.length / TABLE_ROWS_PER_PAGE));
  const base = Math.floor(rows.length / parts);
  const extra = rows.length - base * parts; // the first `extra` parts take one row more
  /** @type {TableBlock[]} */
  const out = [];
  let at = 0;
  for (let i = 0; i < parts; i++) {
    const n = base + (i < extra ? 1 : 0);
    out.push({
      kind: 'table', id, caption: parts > 1 ? `${caption} (${i + 1} of ${parts})` : caption, head,
      rows: rows.slice(at, at + n), keys: k.slice(at, at + n), source, part: i + 1, parts,
    });
    at += n;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The generated tables
// ---------------------------------------------------------------------------------------------------------------------

/** The first-day kit (§7.5), in making order; cord's count is whatever the rest of the kit needs. */
const KIT = ['stone_hammer', 'stone_axe', 'cord', 'flint_knife', 'flint_axe', 'flint_pick', 'fire_drill', 'campfire'];

/**
 * The first-day kit as rows and its totals: raw materials after cord is expanded into fibre (tinder counted as fibre), and
 * the seconds of hand jobs.
 */
export function firstDayKit() {
  const recs = KIT.map((id) => /** @type {import('./crafting.js').Recipe} */ (getRecipe(id)));
  let cords = 0;
  for (const rec of recs) for (const inp of rec.inputs) if ('k' in inp && inp.k === 'cord') cords += inp.n;
  /** @type {Map<string, number>} */
  const raw = new Map();
  const add = (k, n) => raw.set(k, (raw.get(k) ?? 0) + n);
  let seconds = 0;
  const rows = recs.map((rec) => {
    const times = rec.id === 'cord' ? cords : 1;
    seconds += rec.seconds * times;
    for (const inp of rec.inputs) {
      if ('k' in inp && inp.k === 'cord') continue; // counted through the cord row
      const key = 'tag' in inp ? (inp.tag === 'tinder' ? 'plant_fibre' : `#${inp.tag}`) : inp.k;
      add(key, inp.n * times);
    }
    const from = times > 1 ? rec.inputs.map((inp) => inputText({ ...inp, n: inp.n * times })).join(' + ') : recipeInputs(rec);
    return [nameTimes(rec.outputs[0].k, times), from, recipeTools(rec) || '—', `${rec.seconds * times} s`];
  });
  return { rows, keys: [...KIT], cords, seconds, rock: raw.get('rock') ?? 0, knapstone: raw.get('#knapstone') ?? 0,
    fibre: raw.get('plant_fibre') ?? 0, sticks: raw.get('stick') ?? 0 };
}

/** What your hands can gather on the first day, and how (generated from PICKABLE and BLOCK_RULES). */
const GATHER = [
  BLOCK.LOOSE_STONES, BLOCK.FALLEN_BRANCHES, BLOCK.TUSSOCK, BLOCK.GRAVEL, BLOCK.HONEYBERRY_BUSH, BLOCK.PRICKLY_PEAR,
  BLOCK.TUBER_PLANT, BLOCK.CATTAILS, BLOCK.OAK_LEAVES, BLOCK.CLAY,
];

function gatherTable() {
  const rows = GATHER.map((id) => {
    const rule = /** @type {import('./harvest.js').BlockRule} */ (ruleFor(id));
    const picked = Object.hasOwn(PICKABLE, id);
    const verb = Object.hasOwn(HAND_GATHER, id) ? HAND_GATHER[id] : 'break';
    const how = picked ? 'R, or hold LMB' : `hold LMB to ${verb} it${rule.tool ? ` (${/^[aeiou]/.test(rule.tool) ? 'an' : 'a'} ${rule.tool} is faster)` : ''}`;
    return [getBlockDef(id).displayName, how, describeDrops(picked ? PICKABLE[id].drops : rule.drops, false,
      id === BLOCK.LOOSE_STONES ? FLINT_SEEN : null)];
  });
  return table({ id: 'gather', caption: 'Gathering with bare hands', head: ['Find', 'Take it', 'You get'], rows, keys: GATHER,
    source: 'harvest' });
}

function kitTable() {
  const kit = firstDayKit();
  return table({ id: 'kit', caption: 'The first-day kit, made at hand', head: ['Make', 'From', 'Tool', 'Time'], rows: kit.rows,
    keys: kit.keys, source: 'recipes' });
}

/** The pots you drink (food that gives the pot back), from ITEMS. */
function drinksTable() {
  const keys = ITEM_KEYS.filter((k) => ITEMS[k].food?.returns);
  const rows = keys.map((k) => {
    const f = /** @type {import('./types.js').FoodDef} */ (ITEMS[k].food);
    const risk = f.sick > 0 ? `poisons ${fmtPct(f.sick)}` : f.hydration < 0 ? 'salty' : 'safe';
    return [itemName(k), fmtSigned(f.hydration), fmtSigned(f.satiation), risk];
  });
  return table({ id: 'drinks', caption: 'Pots to drink (you keep the pot)', head: ['Pot', 'Hydration', 'Nourishment', 'Risk'],
    rows, keys, source: 'items' });
}

/** FIRE_TRANSFORMS of one spot kind. @param {'skewer'|'centre'|null} spot */
function fireTable(id, caption, spot) {
  const keys = Object.keys(FIRE_TRANSFORMS).filter((k) => spot === null || FIRE_TRANSFORMS[k].spot === spot);
  const rows = keys.map((k) => {
    const t = FIRE_TRANSFORMS[k];
    const row = [itemName(k), itemName(t.to), `${t.seconds} s`];
    if (spot === null) row.push(t.spot === 'skewer' ? 'a skewer' : 'the embers');
    return row;
  });
  const head = spot === null ? ['Put on', 'Becomes', 'Time', 'Where'] : ['Put in', 'Becomes', 'Time'];
  return table({ id, caption, head, rows, keys, source: 'fire' });
}

/** Every food, from ITEMS. */
function foodTable() {
  const keys = ITEM_KEYS.filter((k) => ITEMS[k].kind === 'food');
  const rows = keys.map((k) => {
    const f = /** @type {import('./types.js').FoodDef} */ (ITEMS[k].food);
    return [itemName(k), fmtSigned(f.satiation), fmtSigned(f.hydration), f.sick > 0 ? fmtPct(f.sick) : '—',
      f.spoilS ? `~${fmtDuration(f.spoilS)}` : 'keeps'];
  });
  return table({ id: 'food', caption: 'Food and drink', head: ['Food', 'Nourishment', 'Hydration', 'Poisons', 'Goes bad'],
    rows, keys, source: 'items' });
}

/** The distinct striking powers of the tools, ascending. */
export function toolPowers() {
  return [...new Set(TOOL_KEYS.map((k) => /** @type {any} */ (ITEMS[k].tool).power))].sort((x, y) => x - y);
}

/** Striking power: the tools grouped by their power (how many blows that makes is in the two blows tables). */
function powerTable() {
  /** @type {Map<number, string[]>} */
  const byPower = new Map();
  for (const k of TOOL_KEYS) {
    const power = /** @type {any} */ (ITEMS[k].tool).power;
    if (!byPower.has(power)) byPower.set(power, []);
    /** @type {string[]} */ (byPower.get(power)).push(k);
  }
  const rows = [['Bare hands (against zombies only)', String(toolPower(null))]];
  const keys = /** @type {(string|number)[]} */ (['hand']);
  for (const pw of toolPowers()) {
    const tools = /** @type {string[]} */ (byPower.get(pw));
    rows.push([pw === 1 ? `Every other tool (${tools.length})` : tools.map((k) => itemName(k)).join(', '), String(pw)]);
    keys.push(pw);
  }
  return table({ id: 'power', caption: 'The power of a blow', head: ['In your hand', 'Power'], rows, keys, source: 'items' });
}

/** What you hunt, the weakest first: the pig and every species of animals.js, with the health a blow's power comes off. */
export function huntTargets() {
  const list = [{ key: 'pig', name: 'Pig', points: PIG_HEALTH },
    ...ANIMAL_KINDS.map((k) => ({ key: /** @type {string} */ (k), name: SPECIES[k].name, points: SPECIES[k].health }))];
  return list.sort((x, y) => x.points - y.points);
}

/** The zombie kinds, with the points of power that knock each one out. */
export function zombieTargets() {
  return ZOMBIE_KINDS.map((k) => ({ key: /** @type {string} */ (k), name: cap(k), points: KIND_STATS[k].hits }));
}

/**
 * How many blows a target takes, by the power of the blow: ceil(points / power) for every tool power.
 * @param {string} id @param {string} caption @param {string[]} lead the first two column heads
 * @param {Array<{ key: string, name: string, points: number }>} targets @param {string} source
 */
function blowsTable(id, caption, lead, targets, source) {
  const powers = toolPowers();
  const rows = targets.map((t) => [t.name, String(t.points), ...powers.map((pw) => String(Math.ceil(t.points / pw)))]);
  return table({ id, caption, head: [...lead, ...powers.map((pw) => `Power ${pw}`)], rows, keys: targets.map((t) => t.key), source });
}

/** How a biome reads in prose: "plains", "snowy land", "snowy peaks". @param {number} id */
function biomeWord(id) {
  const name = (BIOME_NAMES[id] ?? '').replace(/_/g, ' ');
  return name === 'snowy' ? 'snowy land' : name;
}

/**
 * Where a species' herds appear: the biomes whose HERD_WEIGHTS give it a weight, the land where a herd is likeliest to be
 * of this kind first. @param {string} kind @returns {number[]} BIOME ids
 */
export function herdBiomes(kind) {
  const share = (/** @type {number} */ b) => {
    const w = /** @type {Record<string, number>} */ (HERD_WEIGHTS[b]);
    const total = Object.values(w).reduce((sum, x) => sum + x, 0);
    return total > 0 ? (w[kind] ?? 0) / total : 0;
  };
  return Object.keys(HERD_WEIGHTS).map(Number).filter((b) => share(b) > 0).sort((x, y) => share(y) - share(x) || x - y);
}

/**
 * What a species comes to, in a few words: "pork, beef or mutton, raw or roast" when every key is a raw or roast meat,
 * else the foods' names ("Wild Tuber, Honeyberries, Tussock Grass or Cattail Root"). @param {ReadonlyArray<string>} lure
 */
export function lureText(lure) {
  if (lure.length > 0 && lure.every((k) => /^(raw|roast)_/.test(k))) {
    const meats = [...new Set(lure.map((k) => k.replace(/^(raw|roast)_/, '')))];
    return `${listJoin(meats, 'or')}, raw or roast`;
  }
  return listJoin(lure.map((k) => itemName(k)), 'or');
}

/** What R does to each animal (hand-written; a test checks every species has a line). `{tame}` is its feeds to tame. */
export const ANIMAL_R = Object.freeze({
  pig: '—',
  cow: 'with an empty Clay Pot in hand: milk',
  sheep: 'with a knife in your pack: shear',
  horse: 'with its food, {tame} times: tame; then ride',
  wolf: 'with its food, {tame} times: tame; then sit or follow',
});

/** The animals: where their herds appear (HERD_WEIGHTS), what a hunt gives (MOB_DROPS) and what R does. */
function animalsTable() {
  const rows = [['Pig', 'grass and snowy grass', describeDrops(MOB_DROPS.pig, true), ANIMAL_R.pig]];
  for (const k of ANIMAL_KINDS) {
    const sp = SPECIES[k];
    rows.push([sp.name, herdBiomes(k).map(biomeWord).join(', '), describeDrops(MOB_DROPS[k], true),
      (ANIMAL_R[k] ?? '—').replace('{tame}', String(sp.tame))]);
  }
  return table({ id: 'animals', caption: 'The animals', head: ['Animal', 'Where', 'Gives', 'Press R'], rows,
    keys: ['pig', ...ANIMAL_KINDS], source: 'animals' });
}

/** How near a walking, sneaking or sprinting player may come before it runs (SPECIES.notice, PIG_NOTICE × the factors). */
function waryTable() {
  const cells = (/** @type {number} */ n) => `${fmtNum(n, 1)} cells`;
  const row = (/** @type {string} */ name, /** @type {number} */ notice) => [name, cells(notice), cells(notice * SNEAK_NOTICE),
    cells(notice * SPRINT_NOTICE)];
  const rows = [row('Pig', PIG_NOTICE), ...ANIMAL_KINDS.map((k) => row(SPECIES[k].name, SPECIES[k].notice))];
  return table({ id: 'wary', caption: 'How near you can come before it runs', head: ['Animal', 'Walking', 'Sneaking', 'Sprinting'],
    rows, keys: ['pig', ...ANIMAL_KINDS], source: 'animals' });
}

/** A zombie kind's strike in HP, at night and in open daylight (they differ only for the alpha). @param {string} kind */
export function zombieStrike(kind) {
  const night = Math.round(ZOMBIE_DAMAGE * KIND_STATS[kind].damage);
  return { night, day: kind === 'alpha' ? Math.round(ZOMBIE_DAMAGE * DAY_ALPHA_DAMAGE) : night };
}

/** The zombie kinds at night, from KIND_STATS and CLIMB: pace, the power that knocks one out, its strike and its leap. */
function zombiesTable() {
  const cellsOf = (/** @type {number} */ n) => `${n} cell${n === 1 ? '' : 's'}`;
  const rows = ZOMBIE_KINDS.map((k) => {
    const st = KIND_STATS[k];
    const strike = zombieStrike(k);
    const climb = CLIMB[k];
    return [cap(k), `${fmtPct(st.chase * st.factor)} of your ${st.sprint ? 'sprint' : 'walk'}`, `${st.hits} power`,
      strike.day === strike.night ? `${strike.night} HP` : `${strike.night} HP (${strike.day} by day)`,
      climb.day === climb.night ? cellsOf(climb.night) : `${cellsOf(climb.night)} (${climb.day} by day)`];
  });
  return table({ id: 'zombies', caption: 'The three kinds of zombie, at night', head: ['Kind', 'Pace', 'Knock-out', 'Strike', 'Leaps'],
    rows, keys: [...ZOMBIE_KINDS], source: 'zombies' });
}

/** What a throw does (looseItems.throwOf): stones, darts, spears, and everything else. */
function throwsTable() {
  const spears = TOOL_KEYS.filter((k) => ITEMS[k].tool?.type === 'spear');
  const kinds = [
    { key: 'stone', what: STONE_KEYS.map((k) => itemName(k)).join(', '), sample: STONE_KEYS[0], after: 'pick it up and throw it again' },
    { key: 'dart', what: DART_KEYS.map((k) => itemName(k)).join(', '), sample: DART_KEYS[0], after: `breaks on ${fmtPct(DART_BREAK_P)} of its hits` },
    { key: 'spear', what: spears.map((k) => itemName(k)).join(', '), sample: spears[0], after: 'loses one use when it hits' },
    { key: 'chuck', what: 'Anything else', sample: 'stick', after: 'no harm done' },
  ].filter((t) => typeof t.sample === 'string');
  const rows = kinds.map((t) => {
    const th = throwOf(t.sample);
    return [t.what, `${th.speed} m/s`, String(th.power), t.after];
  });
  return table({ id: 'throws', caption: 'What a throw does', head: ['Thrown', 'Speed', 'Power', 'Afterwards'], rows,
    keys: kinds.map((t) => t.key), source: 'loose' });
}

/** HEAT_SOURCES. */
function heatTable() {
  const when = { campfire: 'while it burns', kiln: 'while it works', bloomery: 'while it works', forge: 'while it works' };
  const name = { campfire: 'Campfire', kiln: 'Kiln', bloomery: 'Bloomery', forge: 'Forge' };
  const keys = Object.keys(HEAT_SOURCES);
  const rows = keys.map((k) => [name[k] ?? cap(k), `+${HEAT_SOURCES[k].heat} °C`, `${HEAT_SOURCES[k].radius} cells`, when[k] ?? '']);
  return table({ id: 'heat', caption: 'Heat you can stand beside', head: ['Source', 'At the source', 'Reaches', 'When'], rows, keys,
    source: 'climate' });
}

/** Clothing, from ITEMS (wear) and the recipes that make it. */
function clothesTable() {
  const keys = ITEM_KEYS.filter((k) => ITEMS[k].kind === 'wear');
  const rows = keys.map((k) => {
    const w = /** @type {import('./types.js').WearDef} */ (ITEMS[k].wear);
    const rec = recipeMaking(k);
    const made = rec ? `${STATION_NAMES[rec.station]}: ${recipeInputs(rec)}` : '—';
    return [itemName(k), cap(w.slot), w.insulation ? `+${w.insulation} °C` : '—', w.sunShade ? `halves the sun` : '—', made];
  });
  return table({ id: 'clothes', caption: 'Clothing', head: ['Wear', 'Slot', 'Warmth', 'Sun', 'Made at'], rows, keys,
    source: 'items' });
}

/** The body-temperature bands of §2.3, from RATES. */
export function temperatureBands() {
  const R = RATES;
  return [
    { label: 'Heatstroke', from: R.HEATSTROKE, to: Infinity, effect: `${fmtNum(R.HEATSTROKE_DPS)} HP/s, no sprinting, ${fmtPct(1 - R.SLOW_HEATSTROKE)} slower` },
    { label: 'Overheating', from: R.OVERHEATING, to: R.HEATSTROKE, effect: `${fmtNum(R.OVERHEAT_DPS)} HP/s, no sprinting, ${fmtPct(1 - R.SLOW_OVERHEATING)} slower` },
    { label: 'Hot', from: R.HOT, to: R.OVERHEATING, effect: 'no healing' },
    { label: 'Comfortable', from: R.CHILLED, to: R.HOT, effect: 'you heal' },
    { label: 'Chilled', from: R.COLD, to: R.CHILLED, effect: 'no healing' },
    { label: 'Cold', from: R.FREEZING, to: R.COLD, effect: `no sprinting, ${fmtPct(1 - R.SLOW_COLD)} slower` },
    { label: 'Freezing', from: R.HYPOTHERMIC, to: R.FREEZING, effect: `${fmtNum(R.FREEZING_DPS)} HP/s, no sprinting, ${fmtPct(1 - R.SLOW_FREEZING)} slower` },
    { label: 'Hypothermic', from: -Infinity, to: R.HYPOTHERMIC, effect: `${fmtNum(R.HYPOTHERMIA_DPS)} HP/s, no sprinting, ${fmtPct(1 - R.SLOW_HYPOTHERMIC)} slower` },
  ];
}

function bandsTable() {
  const bands = temperatureBands();
  const range = (b) => (b.to === Infinity ? `${fmtNum(b.from)} °C and up` : b.from === -Infinity ? `below ${fmtNum(b.to)} °C`
    : `${fmtNum(b.from)}–${fmtNum(b.to)} °C`);
  return table({ id: 'bands', caption: 'Your body temperature', head: ['Band', 'Body', 'What happens'],
    rows: bands.map((b) => [b.label, range(b), b.effect]), keys: bands.map((b) => b.label), source: 'vitals' });
}

/** Insulation of the three leather pieces (the "in leather" example). */
const LEATHER_I = ['leather_hood', 'leather_coat', 'hide_shoes'].reduce((s, k) => s + (getItem(k)?.wear?.insulation ?? 0), 0);

/**
 * The §3.4 worked examples as climate inputs: feet at height 64, unclothed unless named, standing still; snowy land
 * stands on snowy grass (the ground chill). handbook.test.js recomputes every row with climate.js.
 */
export const CLIMATE_EXAMPLES = Object.freeze([
  { id: 'plains-noon', where: 'Plains', when: '14:00', biome: BIOME.PLAINS, climateT: 0, time: 14 / 24, openSky: true },
  { id: 'plains-night', where: 'Plains', when: '02:00', biome: BIOME.PLAINS, climateT: 0, time: 2 / 24, openSky: true },
  { id: 'plains-roof', where: 'Plains, under a roof', when: '02:00', biome: BIOME.PLAINS, climateT: 0, time: 2 / 24, openSky: false },
  { id: 'desert-noon', where: 'Desert', when: '14:00', biome: BIOME.DESERT, climateT: 0.5, time: 14 / 24, openSky: true },
  { id: 'desert-sprint', where: 'Desert, sprinting', when: '14:00', biome: BIOME.DESERT, climateT: 0.5, time: 14 / 24, openSky: true,
    activityHeat: ACTIVITY_HEAT.sprint },
  { id: 'desert-night', where: 'Desert', when: '02:00', biome: BIOME.DESERT, climateT: 0.5, time: 2 / 24, openSky: true },
  { id: 'snowy-noon', where: 'Snowy land', when: '14:00', biome: BIOME.SNOWY, climateT: -0.6, time: 14 / 24, openSky: true, groundChill: true },
  { id: 'snowy-night', where: 'Snowy land', when: '02:00', biome: BIOME.SNOWY, climateT: -0.6, time: 2 / 24, openSky: true, groundChill: true },
  { id: 'snowy-leather', where: 'Snowy, in leather', when: '02:00', biome: BIOME.SNOWY, climateT: -0.6, time: 2 / 24, openSky: true,
    groundChill: true, insulation: LEATHER_I },
  { id: 'snowy-fire', where: 'Snowy, in leather, a campfire 1.5 cells away', when: '02:00', biome: BIOME.SNOWY, climateT: -0.6,
    time: 2 / 24, openSky: true, groundChill: true, insulation: LEATHER_I, fireDistance: 1.5 },
  { id: 'plains-water', where: 'Swimming in plains', when: 'any time', biome: BIOME.PLAINS, climateT: 0, time: 0.5, openSky: true, inWater: true },
  { id: 'snowy-water', where: 'Swimming in snowy land', when: 'any time', biome: BIOME.SNOWY, climateT: -0.6, time: 0.5, openSky: true,
    inWater: true },
  { id: 'plains-cave', where: 'A cave under plains', when: 'any time', biome: BIOME.PLAINS, climateT: 0, time: 0.5, openSky: false, underground: true },
  { id: 'snowy-cave', where: 'A cave under snowy land', when: 'any time', biome: BIOME.SNOWY, climateT: -0.6, time: 0.5, openSky: false,
    underground: true },
  { id: 'desert-cave', where: 'A cave under the desert', when: 'any time', biome: BIOME.DESERT, climateT: 0.5, time: 0.5, openSky: false,
    underground: true },
].map((e) => Object.freeze(e)));

/**
 * One worked example through climate.js: air, felt and the body temperature it drifts to.
 * @param {any} e a CLIMATE_EXAMPLES entry
 * @returns {{ air: number, felt: number, target: number, band: string|null }}
 */
export function climateExample(e) {
  const heat = e.fireDistance !== undefined
    ? heatAt([{ x: e.fireDistance, y: 0, z: 0, ...HEAT_SOURCES.campfire }], 0, 0, 0) : 0;
  const { air, felt } = feltTemperature({
    biome: e.biome, climateT: e.climateT, feetY: ALTITUDE_REF_Y, time: e.time, openSky: !!e.openSky,
    underground: !!e.underground, inWater: !!e.inWater, wet: 0, heat, groundChill: e.groundChill ? GROUND_CHILL : 0,
    insulation: e.insulation ?? 0, sunShade: 0, activityHeat: e.activityHeat ?? 0,
  });
  const target = bodyTarget(felt, !!e.inWater);
  return { air, felt, target, band: tempBand(target) };
}

function climateTable(id, caption, ids) {
  const list = CLIMATE_EXAMPLES.filter((e) => ids.includes(e.id));
  const rows = list.map((e) => {
    const c = climateExample(e);
    return [e.where, e.when, e.inWater ? `water ${fmtTemp(c.felt - 2)}` : fmtTemp(c.air), fmtTemp(c.felt),
      `${fmtTemp(c.target)}${c.band ? ` · ${c.band}` : ''}`];
  });
  return table({ id, caption, head: ['Where', 'When', 'Air', 'Felt', 'Body drifts to'], rows, keys: list.map((e) => e.id),
    source: 'climate' });
}

/** The ages: tiers 1..6 with their speed, tools and how long they last. */
function agesTable() {
  const tiers = [1, 2, 3, 4, 5, 6];
  const rows = tiers.map((t) => {
    const keys = TOOL_KEYS.filter((k) => ITEMS[k].tool?.tier === t);
    const d = keys.map((k) => /** @type {any} */ (ITEMS[k].tool).durability);
    const lo = Math.min(...d);
    const hi = Math.max(...d);
    return [cap(TIER_NAMES[t]), `×${fmtNum(TIER_SPEED[t])}`, keys.map((k) => itemName(k)).join(', '), lo === hi ? `${lo} uses` : `${lo}–${hi} uses`];
  });
  return table({ id: 'ages', caption: 'The ages of tools', head: ['Age', 'Dig speed', 'Tools', 'Lasts'], rows, keys: tiers,
    source: 'items' });
}

/** Which blocks need a tool of an age, from BLOCK_RULES. */
function needsTable() {
  const needs = toolNeeds();
  const rows = needs.map(([tool, tier]) => [`${cap(tool)}, ${TIER_NAMES[tier]} or better`, toolNeedLabel(tool, tier).replace(/\+$/, ''),
    blocksNeeding(tool, tier).join(', ')]);
  return table({ id: 'needs', caption: 'Blocks that need a tool', head: ['Needs', 'First such tool', 'Blocks'], rows,
    keys: needs.map(([tool, tier]) => `${tool}:${tier}`), source: 'harvest' });
}

/** Blocks shown in the break-time table. */
const BREAK_EXAMPLES = [BLOCK.DIRT, BLOCK.OAK_LOG, BLOCK.STONE, BLOCK.COAL_ORE, BLOCK.COPPER_ORE, BLOCK.TIN_ORE, BLOCK.IRON_ORE, BLOCK.OBSIDIAN];

/** The break time of block `id` with the right type of tool of `tier` (0 = the hand): seconds, Infinity, or null (no tool). */
export function exampleBreakSeconds(id, tier) {
  if (tier === 0) return breakSeconds(id, null);
  const rule = ruleFor(id);
  if (!rule || !rule.tool) return null;
  const key = toolOf(rule.tool, tier);
  return key ? breakSeconds(id, /** @type {any} */ (ITEMS[key].tool)) : null;
}

function breakTable() {
  const tiers = [0, 1, 2, 3, 4, 5, 6];
  const rows = BREAK_EXAMPLES.map((id) => [getBlockDef(id).displayName, ...tiers.map((t) => {
    const s = exampleBreakSeconds(id, t);
    return s === null ? '—' : s === Infinity ? '✕' : fmtNum(s);
  })]);
  return table({ id: 'break', caption: 'Seconds to break, with the right kind of tool', head: ['Block', 'Hand', 'Stone', 'Flint',
    'Copper', 'Bronze', 'Iron', 'Steel'], rows, keys: BREAK_EXAMPLES, source: 'harvest' });
}

/** The workplaces: what builds each, and the heat it gives off while it works. */
function workplacesTable() {
  const ids = STATION_IDS.filter((s) => s !== 'hand');
  const rows = ids.map((s) => {
    const item = getBlockDef(STATION_BLOCKS[s]).name;
    const rec = /** @type {import('./crafting.js').Recipe} */ (recipeMaking(item));
    const tools = recipeTools(rec);
    const heat = HEAT_SOURCES[s] ? `+${HEAT_SOURCES[s].heat} °C, ${HEAT_SOURCES[s].radius} cells` : '—';
    return [STATION_NAMES[s], `${recipeInputs(rec)}${tools ? ` (${tools})` : ''}`, heat];
  });
  return table({ id: 'workplaces', caption: 'Workplaces (made at hand)', head: ['Workplace', 'Built from', 'Heat while working'],
    rows, keys: ids, source: 'recipes' });
}

/** Every recipe of one workplace, from RECIPES. */
function recipeTable(station) {
  const recs = RECIPES.filter((r) => r.station === station);
  const rows = recs.map((r) => [recipeOutputs(r), recipeInputs(r), recipeTools(r) || '—', `${r.seconds} s`]);
  const name = station === 'hand' ? 'Made at hand' : `At the ${STATION_NAMES[station]}`;
  return table({ id: `recipes-${station}`, caption: name, head: ['Makes', 'From', 'Tool', 'Time'], rows, keys: recs.map((r) => r.id),
    source: 'recipes' });
}

/** The status labels (§2.3) from RATES. */
function statusTable() {
  const R = RATES;
  const rows = [
    ['Hungry', `Nourishment below ${R.HUNGRY}`, 'no healing'],
    ['Starving', `Nourishment below ${R.STARVING}`, `no sprinting, ${fmtPct(1 - R.SLOW_STARVING)} slower; at 0, ${fmtNum(R.STARVE_DPS)} HP/s`],
    ['Thirsty', `Hydration below ${R.THIRSTY}`, 'no healing'],
    ['Parched', `Hydration below ${R.PARCHED}`, `no sprinting, ${fmtPct(1 - R.SLOW_PARCHED)} slower; at 0, ${fmtNum(R.THIRST_DPS)} HP/s`],
    ['Wounded', `Health below ${R.WOUNDED}`, `${fmtPct(1 - R.SLOW_WOUNDED)} slower`],
    ['Poisoned', 'after bad food or raw water', `${fmtNum(R.SICK_DPS)} HP/s (never below ${R.SICK_FLOOR}), no healing, hunger and thirst ×${fmtNum(R.SICK_FACTOR)}`],
    ['Wet', 'out of the water', `feels ${WET_CHILL} °C colder until you dry`],
    ['Drowning', 'no breath, head under water', `${fmtNum(R.DROWN_DPS)} HP/s`],
    ['Smothering', 'no breath, buried', `${fmtNum(R.BURIED_DPS)} HP/s`],
  ];
  return table({ id: 'status', caption: 'The warning tags above your vitals', head: ['Tag', 'When', 'What it does'], rows,
    keys: rows.map((r) => r[0]), source: 'vitals' });
}

/** Bandages, from ITEMS (heal) and their recipes. */
function bandageTable() {
  const keys = ITEM_KEYS.filter((k) => ITEMS[k].kind === 'heal');
  const rows = keys.map((k) => {
    const hl = /** @type {{hp: number, rate: number}} */ (ITEMS[k].heal);
    const rec = recipeMaking(k);
    return [itemName(k), `${hl.hp} HP`, `${fmtNum(hl.rate)} HP/s`, rec ? recipeInputs(rec) : '—'];
  });
  return table({ id: 'bandages', caption: 'Bandages', head: ['Bandage', 'Heals', 'Rate', 'Made from'], rows, keys, source: 'items' });
}

/** What hurts, how much and how to avoid it: every DAMAGE_CAUSES key but 'command' (the console). */
export const DANGER_NAMES = Object.freeze({
  fall: 'Falling', drown: 'Drowning', buried: 'Being buried', crush: 'Falling sand and gravel', fire: 'Campfire flames',
  zombie: 'Zombies', blast: 'Powder Kegs', log: 'Falling trees', blackhole: 'Black holes', starve: 'Starving',
  thirst: 'Thirst', cold: 'Cold', heat: 'Heat', sick: 'Poisoning', void: 'The void below the bedrock',
});

/** How to avoid each danger (hand-written; a test checks every cause has one). */
const DANGER_AVOID = Object.freeze({
  fall: 'Climb down; land on snow, leaves, hay or wool; drop into deep water',
  drown: 'Surface before the Health cell\'s border goes dark',
  buried: 'Never dig straight up under sand or gravel',
  crush: 'Step back when you undermine sand or gravel: what falls into your cell lifts you and hurts',
  fire: 'Walk around the flames, not through them',
  zombie: 'Stay by a burning fire at night; fight back with a tool',
  blast: 'Keep well away from a burning keg',
  log: 'Stand to the side when a felled tree topples',
  blackhole: 'Keep away from its pull',
  starve: 'Eat before you are Hungry; keep salted pork',
  thirst: 'Drink at every pond; carry pots of boiled water',
  cold: 'Clothes, shelter, a fire; stay dry',
  heat: 'Shade, a straw hat, caves at noon; walk, don\'t sprint',
  sick: 'Boil water, cook meat; it passes',
  void: 'Do not dig through the bedrock\'s gaps',
});

function dangerTable() {
  const R = RATES;
  const { hurts, kills } = fallThresholds();
  const harm = {
    fall: `from ${hurts} cells up, rising fast; ${kills} cells kill`,
    drown: `${fmtNum(R.DROWN_DPS)} HP/s once ${BREATH_MAX_S} s of breath are gone`,
    buried: `${fmtNum(R.BURIED_DPS)} HP/s once your breath is gone`,
    crush: `${CRUSH_DAMAGE_PER_CELL} HP per cell it lifts you`,
    fire: `${FIRE_BURN_DAMAGE} HP per scorch`,
    zombie: `${zombieStrike('walker').night} HP a strike; an alpha ${zombieStrike('alpha').night}`,
    blast: `${R.KNOCK_K} HP per m/s it throws you beyond ${R.KNOCK_SAFE}`,
    log: `${R.KNOCK_K} HP per m/s it knocks you beyond ${R.KNOCK_SAFE}`,
    blackhole: 'death, and your belongings are lost',
    starve: `${fmtNum(R.STARVE_DPS)} HP/s at Nourishment 0`,
    thirst: `${fmtNum(R.THIRST_DPS)} HP/s at Hydration 0`,
    cold: `${fmtNum(R.FREEZING_DPS)} HP/s Freezing, ${fmtNum(R.HYPOTHERMIA_DPS)} Hypothermic`,
    heat: `${fmtNum(R.OVERHEAT_DPS)} HP/s Overheating, ${fmtNum(R.HEATSTROKE_DPS)} Heatstroke`,
    sick: `${fmtNum(R.SICK_DPS)} HP/s, never below ${R.SICK_FLOOR} HP`,
    void: 'death, and your belongings are lost',
  };
  const keys = DAMAGE_CAUSES.filter((c) => c !== 'command');
  const rows = keys.map((c) => [DANGER_NAMES[c] ?? cap(c), harm[c] ?? '', DANGER_AVOID[c] ?? '']);
  return table({ id: 'dangers', caption: 'Every danger', head: ['Danger', 'Harm', 'Avoid it'], rows, keys, source: 'vitals' });
}

/** Drops shown in the falling table (cells). */
export const FALL_EXAMPLES = Object.freeze([3, 4, 5, 6, 8, 10, 15, 20, 21, 22]);

function fallTable() {
  const rows = FALL_EXAMPLES.map((d) => {
    const v = fallSpeedForCells(d);
    const hp = fallDamage(v);
    return [String(d), `${fmtNum(v, 1)} m/s`, hp > 0 ? `${fmtNum(hp, 1)} HP` : 'none'];
  });
  return table({ id: 'fall', caption: 'Falls onto hard ground', head: ['Cells fallen', 'Landing speed', 'Health lost'], rows,
    keys: [...FALL_EXAMPLES], source: 'vitals' });
}

function softTable() {
  /** @type {Map<number, number[]>} */
  const byFactor = new Map();
  for (const [id, f] of Object.entries(SOFT_LANDING)) {
    if (!byFactor.has(f)) byFactor.set(f, []);
    /** @type {number[]} */ (byFactor.get(f)).push(Number(id));
  }
  const factors = [...byFactor.keys()].sort((a, b) => a - b);
  const rows = factors.map((f) => {
    const ids = /** @type {number[]} */ (byFactor.get(f));
    const wool = ids.filter((id) => getBlockDef(id).name.startsWith('wool_'));
    const names = ids.filter((id) => !wool.includes(id)).map((id) => getBlockDef(id).displayName);
    if (wool.length) names.push(wool.length > 1 ? 'Wool (any colour)' : getBlockDef(wool[0]).displayName);
    return [names.join(', '), fmtPct(f)];
  });
  return table({ id: 'soft', caption: 'Soft landings', head: ['Landing on', 'Damage taken'], rows, keys: factors, source: 'vitals' });
}

function wakeTable() {
  const R = RATES;
  const rows = [
    ['Health', String(R.NEW_HEALTH), String(R.WAKE_HEALTH)],
    ['Nourishment', String(R.NEW_SATIATION), `at least ${R.WAKE_MIN_STAT}`],
    ['Hydration', String(R.NEW_HYDRATION), `at least ${R.WAKE_MIN_STAT}`],
    ['Body temperature', fmtTemp(BODY_TEMP_NORMAL), fmtTemp(BODY_TEMP_NORMAL)],
    ['Breath', `${BREATH_MAX_S} s`, `${BREATH_MAX_S} s`],
  ];
  return table({ id: 'wake', caption: 'How you start', head: ['', 'A new life', 'On waking'], rows, keys: rows.map((r) => r[0]),
    source: 'vitals' });
}

// ---------------------------------------------------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------------------------------------------------

/** The ages figure: each tier and what a tool of that age newly opens (ores for picks, logs for the first axe). */
function agesFigure() {
  const data = [0, 1, 2, 3, 4, 5, 6].map((t) => {
    /** @type {string[]} */
    let opens = [];
    if (t > 0) {
      for (const [tool, tier] of toolNeeds()) {
        if (tier !== t) continue;
        const names = blocksNeeding(tool, tier);
        // the metals of the ladder first (copper, tin, iron, gold), then the rest (coal, gems)
        const rank = (n) => {
          const i = ['copper', 'tin', 'iron', 'gold'].indexOf(n);
          return i < 0 ? 9 : i;
        };
        const ores = names.filter((n) => / Ore$/.test(n)).map((n) => n.replace(/ Ore$/, '').toLowerCase())
          .sort((a, b) => rank(a) - rank(b));
        if (tool === 'pick' && names.includes('Stone')) opens.push('stone');
        opens.push(...ores);
        if (tool === 'axe') opens.push('logs');
      }
    }
    if (t === 0) opens = ['dirt', 'plants', 'litter'];
    return { tier: t, name: cap(TIER_NAMES[t]), opens: opens.slice(0, 4) };
  });
  return { kind: 'figure', figure: 'ages', caption: 'Each age opens the next: what a tool of that age can first break', data };
}

function bandsFigure() {
  return { kind: 'figure', figure: 'bands', caption: 'Body temperature: 37 °C is home', data: temperatureBands()
    .map((b) => ({ label: b.label, from: b.from, to: b.to })) };
}

function fireFigure() {
  return { kind: 'figure', figure: 'fire-spots', caption: 'A campfire from above: six skewers on the corner stones, a pot in the embers',
    data: { skewers: SKEWER_SPOTS, embers: 1 } };
}

// ---------------------------------------------------------------------------------------------------------------------
// The chapters
// ---------------------------------------------------------------------------------------------------------------------

/** The simple circuit parts the Workbench's devices are built on (CONTRACTS §67); a test checks each against RECIPES. */
export const ELEMENTARY_PARTS = Object.freeze(['knife_switch', 'push_button', 'terminal_board', 'voltaic_battery']);

/** The species as a crowd, for prose ("cattle, sheep, horses and wolves"); a test checks every species has a word. */
export const HERD_WORDS = Object.freeze({ cow: 'cattle', sheep: 'sheep', horse: 'horses', wolf: 'wolves' });

/** @returns {Chapter[]} */
function makeChapters() {
  const R = RATES;
  const hour = DAY_LENGTH_SECONDS / 24;
  const hourLine = hour === 60 ? 'One real minute is one game hour' : `One game hour is ${fmtDurationLong(hour)}`;
  const sunrise = fmtClock(SUNRISE_TIME);
  const sunset = fmtClock(SUNSET_TIME);
  const firstLight = realSecondsBetween(START_TIME, SUNSET_TIME);
  const nightLogs = Math.ceil(NIGHT_SECONDS / FUEL_LOG_S);
  const kit = firstDayKit();
  const food = (k) => /** @type {import('./types.js').FoodDef} */ (getItem(k)?.food);
  const rec = (id) => /** @type {import('./crafting.js').Recipe} */ (getRecipe(id));
  const plain = (/** @type {string} */ label) => label.replace(/\+$/, '');
  const satiationRest = 100 / R.SATIATION_DRAIN;
  const hydrationRest = 100 / R.HYDRATION_DRAIN;
  const busy = 1.5; // a day of walking and digging
  const dayFood = Math.round(R.SATIATION_DRAIN * busy * DAY_LENGTH_SECONDS);
  const dayWater = Math.round(R.HYDRATION_DRAIN * busy * DAY_LENGTH_SECONDS);
  const halves = (x) => {
    const v = Math.round(x * 2) / 2;
    return Number.isInteger(v) ? String(v) : `${Math.floor(v)}½`;
  };
  /** A stretch of real time as game days, in words. */
  const gameDays = (seconds) => {
    const d = seconds / DAY_LENGTH_SECONDS;
    if (d < 0.9) return 'less than a game day';
    if (d <= 1.1) return 'about a game day';
    if (d < 1.5) return 'a little over a game day';
    return `about ${halves(d)} game days`;
  };
  const greenware = rec('greenware_pot');
  const bronze = rec('bronze_ingot');
  const copperIn = bronze.inputs.find((i) => 'k' in i && i.k === 'copper_ingot')?.n ?? 0;
  const tinIn = bronze.inputs.find((i) => 'k' in i && i.k === 'tin_ingot')?.n ?? 0;
  const bronzeOut = bronze.outputs[0].n;
  const copperIngot = rec('copper_ingot');
  const charcoal = rec('charcoal');
  const hide = rec('sleeping_hide');
  const basket = rec('wicker_basket');
  const stump = rec('work_stump');
  const splitSticks = rec('split_sticks');
  const workbench = rec('workbench');
  const torch = rec('torch');
  const snare = rec('snare');
  const dartRec = rec('flint_dart');
  /** How many of item `k` recipe `id` takes. */
  const takes = (id, k) => rec(id).inputs.find((i) => 'k' in i && i.k === k)?.n ?? 0;
  const flintOres = blocksNeeding('pick', 2).filter((n) => / Ore$/.test(n));
  const oresAt = (t) => blocksNeeding('pick', t).filter((n) => / Ore$/.test(n)).map((n) => n.toLowerCase()).join(' and ');
  const sticksFromLog = (splitSticks.outputs[0].n) * FUEL_STICK_S;
  const potSick = food('pot_water').sick;
  const milk = food('pot_milk');
  const rawSick = food('raw_pork').sick;
  const roastKeeps = (food('roast_pork').spoilS ?? 0) / (food('raw_pork').spoilS ?? 1);
  const stoneAxeBlows = Math.ceil(PIG_HEALTH / (getItem('stone_axe')?.tool?.power ?? 1));
  const flintShare = FLINT_SHARE === 0.5 ? 'about half of them' : `${fmtPct(FLINT_SHARE)} of them`;
  // animals
  const herdNames = listJoin(ANIMAL_KINDS.map((k) => HERD_WORDS[k] ?? `${SPECIES[k].name.toLowerCase()}s`));
  /** @type {Map<string, string[]>} herd sizes → the species that keep them */
  const bySize = new Map();
  for (const k of ANIMAL_KINDS) {
    const size = `${SPECIES[k].herd[0]}–${SPECIES[k].herd[1]}`;
    bySize.set(size, [...(bySize.get(size) ?? []), HERD_WORDS[k] ?? SPECIES[k].name.toLowerCase()]);
  }
  const herdSizes = [...bySize].map(([size, names]) => `${size} ${listJoin(names, 'or')}`).join(', ');
  const voices = listJoin(ANIMAL_KINDS.map((k) => `a ${SPECIES[k].voice}`), 'or');
  const outOfReach = ANIMAL_KINDS.filter((k) => SPECIES[k].notice * SNEAK_NOTICE > REACH).map((k) => SPECIES[k].name.toLowerCase());
  const reachTip = outOfReach.length
    ? `Your arm reaches ${REACH} cells. Sneaking brings you inside that with every animal but the ${listJoin(outOfReach)}: that one wants a treat.`
    : `Your arm reaches ${REACH} cells, and sneaking brings you inside that with every animal.`;
  /** @type {Map<string, string[]>} what they come to → who comes */
  const byLure = new Map();
  for (const k of ANIMAL_KINDS) {
    const what = lureText(SPECIES[k].lure);
    byLure.set(what, [...(byLure.get(what) ?? []), HERD_WORDS[k] ?? SPECIES[k].name.toLowerCase()]);
  }
  const lureLine = [...byLure].map(([what, who]) => `${listJoin(who)} come to ${what}`).join('; ');
  const tameLine = SPECIES.horse.tame === SPECIES.wolf.tame
    ? `A horse or a wolf is *tamed* by ${numWord(SPECIES.horse.tame)} feeds`
    : `A horse is *tamed* by ${numWord(SPECIES.horse.tame)} feeds, a wolf by ${numWord(SPECIES.wolf.tame)}`;
  const wolfLands = listJoin(herdBiomes('wolf').map(biomeWord));
  const spearKey = TOOL_KEYS.find((k) => ITEMS[k].tool?.type === 'spear') ?? 'flint_spear';
  const rockThrow = throwOf(STONE_KEYS[0]);
  const dartThrow = throwOf(DART_KEYS[0]);
  const spearThrow = throwOf(spearKey);
  // zombies
  const alphaStrike = zombieStrike('alpha');
  const everySeconds = (/** @type {number} */ n) => (n === 1 ? 'every second' : `every ${n} seconds`);
  // the Workbench
  const devices = RECIPES.filter((r) => /** @type {string} */ (r.station) === 'workbench').map((r) => itemName(r.outputs[0].k));

  /** @type {Chapter[]} */
  const chapters = [];
  /** @param {string} id @param {string} title @param {string} short @param {string} icon @param {Block[][]} pages */
  const chapter = (id, title, short, icon, pages) => chapters.push({ id, title, short, icon, pages });

  // ---- 1. Your first day
  chapter('first-day', 'Your first day', 'Day one', 'sun', [
    [
      h('Welcome to the honeycomb'),
      p('In Survival you arrive with an empty pack and this book. Everything else you gather and make yourself: water from ponds, food from bushes and animals, tools knapped from flint, and fire from a drill and a pinch of dry fibre.'),
      p('Four things keep you alive: *Health*, *Nourishment*, *Hydration* and your *body temperature*. They sit beside your hotbar as hex cells. Your breath is the Health cell\'s border: it darkens edge by edge while your head is under water.'),
      p(`${hourLine}: ${fmtDurationLong(DAYTIME_SECONDS)} of daylight, from ${sunrise} to ${sunset}, and ${fmtDurationLong(NIGHT_SECONDS)} of dark. A new world begins at ${fmtClock(START_TIME)}, about ${Math.round(firstLight / 60)} minutes before the zombies come out.`),
      tip('This book never leaves you. Hold it and press [R], or right-click it in your pack, to read it. The *Guide* button on the title screen and in the pause menu shows the same pages.'),
    ],
    [
      h('Before dusk, step by step'),
      steps([
        'Pull *tussock grass* with your bare hands for Plant Fibre: hold the left mouse button on it until it breaks. Eight tussocks give about a dozen.',
        'Look down. *Loose Stones* give Rock, and those with a dark, glossy lump a Flint too. *Fallen Branches* give Sticks. Press [R] on them.',
        'Press [E] and make a *Stone Hammer*, then a *Stone Axe* and some *Cord*. Hand jobs carry on while you walk.',
        'With the Stone Axe in hand, lop leaves for Sticks and fell a tree: logs need an axe.',
        'Knap your flint with the Stone Hammer: a *Flint Knife*, a *Flint Axe* and a *Flint Pick*, your first way into stone.',
        'Make a *Fire Drill*, then build a *Campfire* beside fresh water. Raw water can poison: boil it once you have a pot.',
        `Eat honeyberries as you go. Pigs are shy: sneak up with [Shift], strike ${numWord(stoneAxeBlows)} times with the Stone Axe, and roast the pork.`,
        `Before sunset at ${sunset}, feed the fire a log and stay within ${ZOMBIE_FIRE_FEAR} cells of it.`,
      ]),
    ],
    [
      ...kitTable(),
      p(`In all: ${kit.rock} Rock, ${kit.knapstone} Flint, ${kit.fibre} Plant Fibre and ${kit.sticks} Sticks, and ${kit.seconds} seconds of hand jobs.`),
      tip('A + after a tool means that tool or any better one of its kind. The flint shovel and spear can wait for day two.'),
    ],
    [
      ...gatherTable(),
      tip('*Wild only* means the block must lie where the world put it: one you placed yourself never gives the extra.'),
    ],
    [
      h('Your first night'),
      p(`Night lasts ${fmtDurationLong(NIGHT_SECONDS)}, from ${sunset} to ${sunrise}. A campfire gives warmth (+${HEAT_SOURCES.campfire.heat} °C at the flames, fading over ${HEAT_SOURCES.campfire.radius} cells), light, a place to cook, and a circle of safety: zombies keep ${ZOMBIE_FIRE_FEAR} cells away from a burning fire and never strike anyone inside it.`),
      p(`A fire built in Survival burns for ${fmtDurationLong(CAMPFIRE_FUEL_START_S)}, then goes cold. Feed it with [R]: a stick adds ${FUEL_STICK_S} seconds, a log ${fmtDurationLong(FUEL_LOG_S)}, up to ${fmtDurationLong(CAMPFIRE_FUEL_MAX_S)} in all. ${cap(numWord(nightLogs))} log${nightLogs === 1 ? ' carries' : 's carry'} a fire through the whole night.`),
      p('Plains nights are cool, not dangerous. In snowy land the night can kill: wear what you have and keep close to the fire.'),
      warn(`Morning does not burn the zombies away. A walker dozing in the light wakes if you come within ${WALKER_WAKE_RANGE} cells: look around before you leave the fire.`),
    ],
  ]);

  // ---- 2. Water
  chapter('water', 'Water', 'Water', 'drop', [
    [
      h('Fresh and salt'),
      p(`Water is your most urgent need. Hydration falls from full to nothing in ${fmtDurationLong(Math.round(hydrationRest / 60) * 60)} even at rest: faster when you work, faster still in the heat.`),
      p('The sea and every beach are salt. Ponds inland are fresh: small hex-shaped pools ringed with cattails and loose stones, with clay at the bottom. In snowy land they freeze over.'),
      p(`Salt water makes thirst worse: your body spends more water getting rid of the salt than the sip gave you. A gulp of the sea costs ${-R.GULP_SALT} Hydration.`),
      tip('The hint under your crosshair names it: *Fresh water* or *Sea water (salty)*.'),
    ],
    [
      h('Drinking'),
      p(`Look at water and press [R] to take a gulp, whatever you are holding: ${fmtSigned(R.GULP_FRESH)} Hydration, one gulp every ${GULP_GAP_S} s. With your head under water, [R] drinks where you are.`),
      p(`Raw water is a gamble. A gulp from a pond poisons you ${fmtPct(R.GULP_FRESH_SICK)} of the time (ten gulps in a row: ${fmtPct(1 - (1 - R.GULP_FRESH_SICK) ** 10)}), a Pot of Water ${fmtPct(potSick)}. Water boiled in the embers of a campfire is always safe.`),
      p(`When you are *Poisoned* your stomach turns at once: ${fmtSigned(R.POISON_THIRST)} Hydration and ${fmtSigned(R.POISON_HUNGER)} Nourishment. For the next ${R.SICK_S} seconds you do not heal, hunger and thirst come ${fmtNum(R.SICK_FACTOR)} times as fast, and you lose ${fmtNum(R.SICK_DPS)} HP a second, though never below ${R.SICK_FLOOR} HP. Every new dose adds its time on top.`),
      tip('Boil before you drink, and cook before you eat.'),
    ],
    [
      h('Pots'),
      p(`A *Clay Pot* carries water. Shape a Greenware Pot from ${recipeInputsProse(greenware)} (dig clay at the bottom of a pond), then fire it in the embers of a campfire for ${FIRE_TRANSFORMS.greenware_pot.seconds} s, the oldest way of making pottery, or in a Kiln.`),
      p('With an empty Clay Pot in hand, [R] on water fills it. Hold [RMB] to drink a pot; you keep the empty pot. A cow fills a pot too, with milk: see *Animals*.'),
      ...drinksTable(),
    ],
    [
      h('Boiling'),
      p('Put a pot into the embers at the centre of a burning campfire: press [R] with the pot in hand. Boiling kills what makes raw water bad for you.'),
      ...fireTable('embers', 'In the embers', 'centre'),
      p('Boiling never makes the sea drinkable, but the water leaves its salt behind: scrape the salt-crusted pot (a hand job) for Salt and your pot back. Salt keeps meat and tans hides.'),
      tip(`Snow and ice are fresh. Pack ${takes('pot_snow', 'snow')} Snow or ${takes('pot_snow_ice', 'ice_chunk')} Ice Chunks into a Clay Pot and boil it.`),
    ],
    [
      h('Water from plants'),
      p(`Birch carries a sweet, watery sap. With an empty Clay Pot in hand and a knife in your pack, hold [R] on a birch log for ${TAP_HOLD_S} s to fill a *Pot of Birch Sap*: ${fmtSigned(food('pot_sap').hydration)} Hydration and a little Nourishment. Each log can be tapped once a day.`),
      p(`In the desert the prickly pear's fruit is water: ${fmtSigned(food('cactus_fruit').hydration)} Hydration each. Its fine spines must come off first: peel it with a knife in your pack, or singe it on a skewer for ${FIRE_TRANSFORMS.unpeeled_cactus_fruit.seconds} s.`),
      p(`Eating snow gives only ${fmtSigned(food('snow').hydration)} Hydration and chills you ${fmtNum(-(food('snow').temp ?? 0))} °C: melting it costs body heat. Melt it in a pot instead.`),
    ],
  ]);

  // ---- 3. Food and fire
  chapter('food', 'Food and fire', 'Food', 'flame', [
    [
      h('Hunger'),
      p(`Nourishment falls from full to nothing in ${fmtDurationLong(Math.round(satiationRest / 60) * 60)} at rest, ${gameDays(satiationRest)}, and faster when you work or when the cold makes you burn more. Below ${R.REGEN_MIN_SATIATION} you stop healing; below ${R.HUNGRY} you are Hungry; at 0 you starve.`),
      p(`A busy game day of walking and digging costs about ${dayFood} Nourishment and ${dayWater} Hydration: ${halves(dayFood / food('roast_pork').satiation)} roast pork and ${halves(dayWater / food('pot_boiled').hydration)} pots of water.`),
      p('Hold [RMB] with food in hand to eat; the hex ring round the crosshair shows how long it takes. Keep holding to eat the next one.'),
    ],
    [
      h('Foraging'),
      p(`*Honeyberries* hang on low blue-green bushes: [R] picks a handful. A picked bush regrows in about ${REGROW_MEAN_S === DAY_LENGTH_SECONDS ? 'a game day' : fmtDurationLong(REGROW_MEAN_S)}.`),
      p(`*Wild tubers* grow as low leafy rosettes: a shovel digs up more of them. *Cattails* stand at pond edges: their roots are food, their leaves fibre. Oak leaves sometimes drop *acorns* (${fmtPct(dropChance(BLOCK.OAK_LEAVES, 'acorns'))}), spruce leaves *pine nuts* (${fmtPct(dropChance(BLOCK.SPRUCE_LEAVES, 'pine_nuts'))}).`),
      p(`Raw acorns are bitter with tannins and cost you water. Soak ${takes('leached_acorns', 'acorns')} in a Pot of Water to leach them, then roast them on a skewer.`),
      tip('A dug-up bush has to take root again: it is replanted bare and fruits only after it regrows.'),
    ],
    [
      h('Meat and milk'),
      p('Meat is the richest food there is. Pigs, cattle and sheep give it; the chapter *Animals* tells how to come near them and what a hunt takes.'),
      p(`Raw meat feeds you little and poisons you ${fmtPct(rawSick)} of the time. Roast it on a skewer: Roast Mutton gives ${fmtSigned(food('roast_mutton').satiation)} Nourishment, Roast Pork ${fmtSigned(food('roast_pork').satiation)} and Roast Beef ${fmtSigned(food('roast_beef').satiation)}.`),
      p(`Milk is food and drink in one. A *Pot of Milk* gives ${fmtSigned(milk.satiation)} Nourishment and ${fmtSigned(milk.hydration)} Hydration, never poisons you, and leaves you the pot. Press [R] on a cow with an empty Clay Pot in hand.`),
      tip(`A cow has milk again ${fmtDurationLong(MILK_REGROW_S)} after you milked her.`),
    ],
    [
      h(`The ${numWord(SKEWER_SPOTS + 1)} fire spots`),
      p(`A campfire has ${numWord(SKEWER_SPOTS + 1)} spots: a green-wood skewer at each of its ${numWord(SKEWER_SPOTS)} corner stones, and the embers in the middle. Each skewer holds one piece of food, the embers one pot, and every spot cooks on its own timer.`),
      fireFigure(),
      bullets([
        '[R] with food in hand: onto the free skewer nearest you.',
        '[R] with a pot: into the embers.',
        '[R] with a stick or a log: feed the fire.',
        '[R] with anything else: take what is done (or everything, if nothing is).',
      ]),
    ],
    [
      ...fireTable('fire', 'What the fire does', null),
      warn(`Roast meat left on its skewer chars after another ${FIRE_TRANSFORMS.roast_pork.seconds} s. Take it off in time.`),
    ],
    [
      h('Fuel and the cold pit'),
      p(`A fire built in Survival starts with ${fmtDurationLong(CAMPFIRE_FUEL_START_S)} of fuel. A stick adds ${FUEL_STICK_S} seconds and a log ${fmtDurationLong(FUEL_LOG_S)}, up to ${fmtDurationLong(CAMPFIRE_FUEL_MAX_S)}.`),
      p(`When the fuel runs out the fire goes cold. A *Cold Fire Pit* gives no heat, no light and no safety; whatever was cooking waits on it. To relight it, hold [R] for ${RELIGHT_HOLD_S} s with a Fire Drill, a pinch of tinder and ${RELIGHT_STICKS} Sticks in your pack.`),
      p('Logs are fuel, not food for the fire: an open fire burns wood to ash. Charcoal comes from the slow, airless burn of a Kiln, and one lump from each cold pit you break.'),
      tip(`A log split into sticks gives ${sticksFromLog} s of fuel; burnt whole it gives ${FUEL_LOG_S} s.`),
      tip('Fires lit in Creative burn forever and need no feeding.'),
    ],
    // the food table takes its pages alone: beside a margin note its five columns are wider than the text column (play-test)
    ...foodTable().map((t) => [t]),
    [
      h('Spoilage and salt'),
      p(`Berries and meat go bad in your pack, in baskets and in your belongings. The more of one kind you carry, the sooner one of them turns: carry ten raw pork and one spoils about every ${fmtDurationLong((food('raw_pork').spoilS ?? 0) / 10)}.`),
      tip('Goes bad, in the table: the average time one item lasts. Carry fewer and each lasts longer.'),
      p('*Salted Pork* never spoils and needs no fire: rub Raw Pork with Salt, a hand job. Salt comes from boiling seawater.'),
      tip(`Roast meat keeps ${roastKeeps === 2 ? 'twice' : `${fmtNum(roastKeeps)} times`} as long as raw. Cook what you cannot eat today.`),
    ],
  ]);

  // ---- 4. Warm and cool
  chapter('warmth', 'Warm and cool', 'Warmth', 'thermo', [
    [
      h('Your body\'s heat'),
      p(`Your body likes to sit at ${BODY_TEMP_NORMAL} °C. What you *feel* (the air, the sun, a fire, your clothes, wet skin) pulls it up or down, and slowly: about ${Math.round(R.TAU_AWAY / 60)} minutes to drift away, quicker to come back. In water it changes about ${Math.round(1 / R.WATER_TAU)} times as fast.`),
      p(`Between ${COMFORT_LOW} and ${COMFORT_HIGH} °C felt, your body stays at ${BODY_TEMP_NORMAL} °C. Below ${COMFORT_LOW} °C it is pulled down, above ${COMFORT_HIGH} °C up.`),
      bandsFigure(),
    ],
    [
      h('What sets the air'),
      bullets([
        '*The land.* Deserts are hot and snowy lands cold; the sea evens out the coast.',
        `*The hour.* The warmest time is ${fmtClock(DIURNAL_PEAK_T)}, the coldest ${fmtClock(DIURNAL_PEAK_T + 0.5)}. Deserts swing ±${DIURNAL_AMPLITUDE[BIOME.DESERT]} °C over a day, plains ±${DIURNAL_AMPLITUDE[BIOME.PLAINS]}.`,
        `*Height.* The air cools by ${fmtNum(ALTITUDE_LAPSE)} °C for every cell above height ${ALTITUDE_REF_Y}.`,
        '*Caves* sit at the land\'s daily mean, day and night: a refuge from the desert noon, still freezing under snow.',
      ]),
      tip('The small arrow beside the body-temperature gauge shows which way you are drifting.'),
    ],
    [
      h('What you feel'),
      bullets([
        `*Sun:* up to +${SUN_HEAT} °C at noon under open sky. A straw hat halves it.`,
        `*Shelter:* +${SHELTER_HEAT} °C under a roof when the air is below ${SHELTER_BELOW} °C.`,
        `*Clothes:* their warmth counts in full below ${INSULATION_HOT_FROM} °C, and less in the heat.`,
        `*Work:* walking +${ACTIVITY_HEAT.walk}, digging +${ACTIVITY_HEAT.break}, swimming +${ACTIVITY_HEAT.swim}, sprinting +${ACTIVITY_HEAT.sprint}.`,
        `*Snow or ice underfoot:* ${fmtNum(GROUND_CHILL)} °C.`,
        `*Wet skin:* ${fmtNum(-WET_CHILL)} °C, and wet clothes keep only ${fmtPct(1 - WET_INSULATION_LOSS)} of their warmth.`,
      ]),
      ...heatTable(),
    ],
    [
      ...clothesTable(),
      p('Clothes add their warmth to what you feel. Leather is the warmest: a full set (hood, coat and shoes) turns a deadly snowy night into a merely cold one. In the desert, wear the straw hat and little else.'),
    ],
    [
      h('Wet and cold water'),
      p('Water draws heat from a body about 25 times faster than air of the same temperature. In water you feel the water, not the air, and your body follows it fast.'),
      p(`Out of the water you stay *Wet* for a while: about ${fmtDurationLong(WET_DRY_S)} in the shade, half that in the sun, much less beside a fire. Wet skin feels ${WET_CHILL} °C colder.`),
      warn('Swimming in snowy land is deadly: you start Freezing within half a minute.'),
    ],
    [
      ...climateTable('climate-open', 'Days and nights in the open (standing still, unclothed unless named)',
        ['plains-noon', 'plains-night', 'plains-roof', 'desert-noon', 'desert-sprint', 'desert-night', 'snowy-noon', 'snowy-night',
          'snowy-leather', 'snowy-fire']),
    ],
    [
      ...climateTable('climate-water', 'In water and underground', ['plains-water', 'snowy-water', 'plains-cave', 'snowy-cave', 'desert-cave']),
      p('A cave keeps the land\'s daily mean all day and all night: a cool refuge from the desert sun, and shelter from the worst of a snowy night.'),
    ],
    [
      ...bandsTable(),
      p(`You heal only while your body is between ${R.REGEN_TEMP_MIN} and ${R.REGEN_TEMP_MAX} °C. The cold also makes you hungrier, and the heat thirstier.`),
    ],
  ]);

  // ---- 5. Tools and the ages
  chapter('ages', 'Tools and the ages', 'Ages', 'pick', [
    [
      h('From stone to steel'),
      p('Every tool has a *kind* (axe, pick, shovel, knife, hammer, spear, sword) and an *age*. The right kind breaks its own blocks faster, a later age faster still and for longer, and some blocks need at least a certain age.'),
      agesFigure(),
      p('There is no stone pick: rock is too soft to cut rock. A *Flint Pick* is your first way into stone.'),
    ],
    [...agesTable(), p('Dig speed multiplies how fast the right kind of tool breaks its blocks; bare hands are ×1.')],
    [
      h('Stone and flint'),
      p('The *Stone Hammer* is a fist-sized cobble, the knapper\'s hammer: every flint tool is struck with it. The *Stone Axe* is a sharp-edged cobble, your first axe: it fells trees and lops leaves for sticks.'),
      p(`*Flint* lies among the *Loose Stones* on the ground. Look before you pick: ${flintShare} show a dark, glossy nodule, and those give a Flint. Plain ones never do. Now and then (${fmtPct(dropChance(BLOCK.STONE, 'flint'))}) one turns up in stone you mine.`),
      p('Flint, or obsidian (volcanic glass), knaps into a knife, an axe, a shovel, a spear and a pick. Each needs a stick and cord to haft it.'),
      p(`The Flint Pick breaks stone, ${flintOres.map((n) => n.toLowerCase()).join(', ')} and obsidian.`),
      tip('Obsidian and gems are brittle: any pick that cuts stone breaks them.'),
    ],
    [
      h('Light underground'),
      p('Daylight does not follow you down. A cave, a mine or a room closed in on every side is dark even at noon, and darker the farther you go from the open sky.'),
      p(`A burning *Campfire*, a *Torch* and a lit *Filament Lamp* shine by themselves. Their glow thins out cell by cell: a campfire's is gone ${CAMPFIRE_LIGHT} cells away, a Torch's ${TORCH_LIGHT}. Glowstone, a builder's block from Creative, shines brightest of all.`),
      p(`A Torch is made at hand from ${recipeInputsProse(torch)}, with a ${plain(recipeTools(torch))}. *Saltpetre* crusts on deep stone: ${fmtPct(dropChance(BLOCK.STONE, 'saltpetre'))} of the stone you mine ${DEEP_BELOW_SEA} cells or more below sea level gives some.`),
      tip('Take torches when you dig, and set one at every fork: you will find your way back.'),
      tip('A window of glass or a gap in the roof lets the daylight in.'),
    ],
    [
      h('Copper and bronze'),
      p(`Copper ore is streaked green with *malachite*. A Kiln smelts ${recipeInputsProse(copperIngot)} into a Copper Ingot. Tools are cast: a Crucible remelts the ingots and a Casting Mold shapes them, both fired from greenware in the Kiln.`),
      p(`A *Copper Pick* breaks ${oresAt(3)}: dark grains of *cassiterite*.`),
      p(`*Bronze* is copper hardened with tin: ${copperIn} Copper Ingots and ${tinIn} Tin Ingot make ${bronzeOut} Bronze Ingots, one part tin in ${copperIn + tinIn}, the classic tool bronze of the ancient world.`),
      p(`A *Bronze Pick* breaks ${oresAt(4)}.`),
    ],
    [
      h('Iron and steel'),
      p('Iron never melts in a kiln. A *Bloomery*, a tall brick stack blown with bellows, turns hematite and charcoal into an *iron bloom*: a spongy lump of iron and slag.'),
      p('Hammering the hot bloom drives the slag out: with a Bronze Hammer, the Bloomery makes *Wrought Iron*.'),
      p('The *Forge* works iron into tools with a Bronze Hammer. With an Iron Hammer it folds charcoal\'s carbon into wrought iron: *Steel*, the fastest and toughest of all.'),
      tip('Fuel means coal or charcoal, and coal is used first. Keep your charcoal: the Bloomery and the Forge burn nothing else.'),
    ],
    [...needsTable()],
    [
      ...breakTable(),
      p('✕ means that tool cannot break it at all; — means there is no tool of that kind in that age.'),
    ],
    [
      h('Wear'),
      p('A digging tool (an axe, shovel, pick, knife or hammer) loses one use for every block it breaks, whatever the block, and every blow it lands; a spear or sword wears only on its blows. The hex outline round its slot drains as it wears; at nothing, it breaks.'),
      p('So choose the right tool: a pick wears just as fast on dirt. The kiln kit (fire drill, crucible, casting mold) wears only in the jobs that need it, never by digging with it in hand.'),
      p('When a job needs a tool, the most worn one of the lowest good-enough age is used, so your best tools last.'),
      p(`Breaking a block with your head under water takes ${fmtNum(UNDERWATER_DIG_FACTOR)} times as long.`),
    ],
  ]);

  // ---- 6. Workplaces and making
  chapter('making', 'Workplaces and making', 'Making', 'anvil', [
    [
      h('Making things'),
      p('Press [E] to open your pack and *Making*. There is no crafting grid: the list shows what you can make from what you carry at the workplaces near you, the things you can make right now first. Recipes for workplaces you have not built are greyed out, so the list doubles as your road map.'),
      p(`A workplace counts as near within ${STATION_RANGE} cells (and 2 up or down). Click *Make*, or *×5* for five.`),
      p(`Each workplace (your hands, a Work Stump, a Kiln, a Bloomery, the Forge, the Workbench) has its own *lane*, and all the lanes work at once. A job takes its inputs only when it finishes, so cancelling costs nothing. Up to ${MAX_CRAFT_JOBS} jobs wait in all.`),
      p(`Once started, a job keeps going while you stay within ${STATION_WORK_RANGE} cells of its workplace: tend the fire, fetch water or dig clay while the Kiln works.`),
    ],
    [
      ...workplacesTable(),
      p(`The Work Stump comes first: ${recipeInputsProse(stump)} and an axe. It splits a log into ${splitSticks.outputs[0].n} sticks, cuts planks and works leather. A Kiln, a Bloomery or the Forge at work is a warm place to stand.`),
    ],
    ...recipeTable('hand').map((t) => [t]),
    ...recipeTable('stump').map((t) => [t]),
    ...recipeTable('kiln').map((t) => [t]),
    [
      ...recipeTable('bloomery'),
      p('Sand alone melts at about 1 700 °C, far beyond any kiln. A flux lowers that, and at the Bloomery salt plays the part.'),
    ],
    ...recipeTable('forge').map((t) => [t]),
    [
      h('The Workbench'),
      p(`The *Workbench* comes last of all. It is built at hand from ${recipeInputsProse(workbench)}, with an ${plain(recipeTools(workbench))}: steel from the Forge, glass from the Bloomery, copper wire drawn at the Work Stump and tin smelted in the Kiln.`),
      p(`It is where circuits grow up. The simple parts are made at the Work Stump: the ${listJoin(ELEMENTARY_PARTS.map((k) => itemName(k)))}. The Workbench builds the clever devices on top of them: the ${listJoin(devices)}.`),
      tip('Every device at the Workbench is built on a simple part, so make those first.'),
    ],
    ...recipeTable('workbench').map((t) => [t]),
    [
      h('Why these steps'),
      p(`*Charcoal* is wood baked without air: it burns hotter and cleaner than wood, which is why iron needs it. The Kiln bakes ${recipeInputsProse(charcoal)} into ${charcoal.outputs[0].n} Charcoal.`),
      p('*Green bricks* are raw clay; fired in the Kiln they become the bricks that build the Bloomery and the Forge.'),
      p('*Bellows* force air into the fire: without them no bloomery reaches the heat iron needs. They are made of leather at the Work Stump.'),
      p('*Leather* is rawhide tanned with fat or salt and worked with a knife.'),
    ],
  ]);

  // ---- 7. Animals
  chapter('animals', 'Animals', 'Animals', 'hex', [
    [
      h('Shy herds'),
      p(`Pigs root about on the grass, and ${herdNames} roam the land in small herds: ${herdSizes}. They are few, and they are shy. An animal that notices you runs, and the rest of its herd runs with it.`),
      p(`A herd turns up now and then on wild grass, ${HERD_MIN} to ${HERD_MAX} cells from where you stand, and only while few animals are about. The land decides which kind it is: the table shows where to look.`),
      p(`Listen as you walk. ${cap(voices)} means a herd is near, often before you can see it.`),
      tip('An animal you have tamed never runs away, cannot be hurt by your own blows, and is saved with your world.'),
    ],
    [
      ...animalsTable(),
      p('*Where* lists the lands its herds appear in, the likeliest first. *Gives* is what a hunt brings.'),
    ],
    [
      h('Getting close'),
      p(`How near you may come depends on how you move. *Sneak* with [Shift] and an animal notices you at only ${fmtPct(SNEAK_NOTICE)} of its usual distance. *Sprint* and it spots you from ${fmtPct(SPRINT_NOTICE - 1)} farther off.`),
      ...waryTable(),
      p(reachTip),
    ],
    [
      h('A treat in your hand'),
      p(`Better than stalking: hold out a food the animal likes. It will not run from you, and from ${LURE_RANGE} cells away it trots up and waits beside you. Just do not sprint.`),
      p(`${cap(lureLine)}. A pig comes to nothing: that one you stalk.`),
      p(`Then feed it with [R]. Cattle and sheep stay calm for ${FED_CALM_S} seconds after a mouthful, however close you stand. ${tameLine}.`),
    ],
    [
      h('Hunting'),
      p('Bare hands only shove an animal aside. Any tool in your hand wounds it: every blow takes the tool\'s *power* off the animal\'s health.'),
      ...powerTable(),
      p(`A wounded animal bolts, and its herd with it, for at least ${HIT_FLEE_S} seconds. Be quick.`),
    ],
    [
      ...blowsTable('blows-animals', 'Blows to bring an animal down', ['Animal', 'Health'], huntTargets(), 'animals'),
      p(`You can throw as well, with [G]: a rock counts ${rockThrow.power}, a ${itemName(DART_KEYS[0])} ${dartThrow.power} and a ${itemName(spearKey)} ${spearThrow.power}. ${cap(listJoin(dartRec.inputs.map((i) => `${numWord(i.n)} ${inputLabel(/** @type {any} */ (i))}`)))} make ${numWord(dartRec.outputs[0].n)} ${itemName(dartRec.outputs[0].k)}s at hand, with a ${plain(recipeTools(dartRec))}.`),
      p('What an animal gives flies to you, like anything you dig. Rawhide becomes leather at the Work Stump: clothes, bellows and your Sleeping Hide.'),
    ],
    [
      h('Cattle and sheep'),
      p('Cattle and sheep cannot be tamed, but each gives something again and again.'),
      p(`*Milk.* Press [R] on a cow with an empty Clay Pot in hand for a Pot of Milk: ${fmtSigned(milk.satiation)} Nourishment and ${fmtSigned(milk.hydration)} Hydration. She has more after ${fmtDurationLong(MILK_REGROW_S)}.`),
      p(`*Wool.* Press [R] on a sheep with a knife in your pack. Shearing gives ${SHEAR_WOOL[0]}–${SHEAR_WOOL[1]} ${itemName('wool_white')} and costs the knife one use; the fleece is back in ${fmtDurationLong(SHEAR_REGROW_S)}. Wool is a soft block to build with and to land on.`),
      tip('Hunt them only when you need meat or hide.'),
    ],
    [
      h('Horses'),
      p(`A wild horse spots you from farther off than any other animal, and it outruns you. So bring it a treat: ${lureText(SPECIES.horse.lure)}. Feed it with [R], ${numWord(SPECIES.horse.tame)} times, and it trusts you for good.`),
      p(`Press [R] on your horse to get on. It goes where you look at ${fmtNum(RIDE_SCALE)} times your own pace, walking or sprinting, hops single steps by itself, and leaps a wall ${Math.floor(RIDE_LEAP)} cells high when you press [Space]. [Shift] gets you off.`),
      p(`A tame horse waits for you: it grazes within ${HOME_RANGE} cells of where you left it. If it is hurt, its food heals it.`),
    ],
    [
      h('Wolves'),
      p(`Wolves keep to ${wolfLands}, and a wild one runs from you like any other animal. It comes to ${lureText(SPECIES.wolf.lure)}. Feed it with [R], ${numWord(SPECIES.wolf.tame)} times, and it is yours.`),
      p(`Your wolf follows you, runs to keep up, and finds you again if it is left far behind. It goes for any zombie within ${WOLF_GUARD} cells and bites it: ${WOLF_BITE} power ${everySeconds(WOLF_BITE_S)}.`),
      p('Press [R] on your wolf to tell it to *sit* and wait, and [R] again to *follow*. Meat heals it when it is hurt.'),
      warn('A black hole swallows animals as it swallows everything else. Keep your horse and your wolf well away from one.'),
    ],
    [
      h('Snares'),
      p(`A *Snare* is a noose of cord on a bent stick, made at hand from ${recipeInputsProse(snare)}. Set it on the ground where animals walk.`),
      p(`A wild animal that steps into it, a pig too, is held fast for ${fmtDurationLong(TRAP_HOLD_S)}: time to walk up and feed it, shear it, milk it or hunt it. Then it pulls free, and nothing catches it again for ${TRAP_IMMUNE_S} seconds. The snare sets itself once more, without its bait.`),
      p(`Bait beats luck. Press [R] on a set snare with any food in hand: calm ${herdNames} within ${BAIT_RANGE} cells wander over to it. Keep well back, or you will scare them off.`),
      tip('Feed a snared horse or wolf until it is tame, and it steps out of the noose as your friend.'),
    ],
  ]);

  // ---- 8. Dangers
  chapter('dangers', 'Dangers', 'Dangers', 'hazard', [
    [
      h('Your body\'s warnings'),
      p('Small tags above your vitals warn you before you come to harm. Each pair shows only the worse one.'),
      ...statusTable(),
    ],
    [
      h('Healing'),
      p(`You heal ${fmtNum(R.REGEN)} HP a second while Nourishment and Hydration are at least ${R.REGEN_MIN_SATIATION}, your body is between ${R.REGEN_TEMP_MIN} and ${R.REGEN_TEMP_MAX} °C, you are not Poisoned and you have breath. Each point healed costs ${fmtNum(R.REGEN_COST)} Nourishment. Stand still beside a burning campfire for ${R.REGEN_STILL_S} s and you heal twice as fast.`),
      ...bandageTable(),
      p('A bandage heals whatever your state, even while you are Poisoned. A rag from a zombie is not clean enough to bind a wound until it has been boiled: the Rag Bandage takes a Pot of Boiled Water.'),
    ],
    ...dangerTable().map((t) => [t]),
    [
      ...fallTable(),
      p('Water deep enough to swim in cushions any fall. Wading water does not.'),
    ],
    [
      ...softTable(),
      p('A soft block under your feet takes part of the blow: the softest one you land on counts.'),
      tip('Never dig straight down: the cave below may be deeper than you think.'),
    ],
    [
      h('Zombies'),
      p(`Zombies come up out of the ground only in the dark, from ${sunset} to ${sunrise}: one or two at a time, never nearer than ${ZOMBIE_SPAWN_MIN} cells. One that notices you within ${ZOMBIE_SIGHT} cells comes for you. Each strike costs ${ZOMBIE_DAMAGE} HP and knocks you back. A walker's arms hang until it has seen you, then come up in front.`),
      p(`They keep ${ZOMBIE_FIRE_FEAR} cells away from a burning campfire and never strike anyone inside that circle. None appears within ${ZOMBIE_SPAWN_FIRE_CLEAR} cells of a fire, or in a column you have built in.`),
      p(`A zombie never steps off a drop deeper than ${ZOMBIE_MAX_DROP} cells, and it gives up on anyone standing more than ${ZOMBIE_CHASE_MAX_RISE} cells above it.`),
      tip(`A wall ${CLIMB.walker.night + 1} cells high stops a walker. Runners and the alpha jump higher: the table tells how high.`),
    ],
    [
      h('Three kinds'),
      p(`Most zombies are *walkers*. About one in ${numWord(Math.round(1 / RUNNER_P))} is a *runner*: lean, quick, and easier to knock out.`),
      ...zombiesTable(),
      p(`The *alpha* is rare. When ${numWord(HORDE_SIZE)} or more zombies crowd within ${HORDE_RADIUS} cells of a runner, the runner may rise as the alpha (${fmtPct(ALPHA_CONVERT_P)} ${everySeconds(HORDE_CHECK_S)}; never more than ${numWord(ALPHA_MAX)} at a time). You will hear its deep call and see its amber eyes. Walkers within ${ALPHA_RALLY} cells of it hurry along at your own walking pace. So never let a crowd gather round a runner.`),
    ],
    [
      h('Zombies by day'),
      p('Sunlight does not burn zombies away. Out under the open sky it only weakens them:'),
      bullets([
        `*Walkers* go dormant and stand still, arms hanging. One wakes if you come within ${WALKER_WAKE_RANGE} cells, if you hit it (it stays awake for ${PROVOKE_S} seconds), or if an alpha is near.`,
        `*Runners* only shamble, at a walker's pace, and leap ${CLIMB.runner.day} cell${CLIMB.runner.day === 1 ? '' : 's'} instead of ${CLIMB.runner.night}.`,
        `*The alpha* slows to ${fmtPct(KIND_STATS.alpha.chase * DAY_ALPHA_FACTOR)} of your walk, strikes for ${alphaStrike.day} HP instead of ${alphaStrike.night}, and leaps ${CLIMB.alpha.day} cells instead of ${CLIMB.alpha.night}.`,
      ]),
      p(`A zombie with nobody to chase does not stay out long: after ${DAWN_BURROW_MIN_S} to ${DAWN_BURROW_MIN_S + DAWN_BURROW_RAND_S} seconds of daylight it burrows back into the ground. One that is chasing you stays until it loses you.`),
      warn('Shade keeps a zombie strong: under a tree or a roof it is as dangerous by day as at night.'),
    ],
    [
      h('Fighting back'),
      p(`Every blow takes its power off a zombie, and bare hands count for ${toolPower(null)}. The powers of the tools are listed under *Animals*, in Hunting.`),
      ...blowsTable('blows-zombies', 'Blows to knock a zombie out', ['Zombie', 'Takes'], zombieTargets(), 'zombies'),
      p(`A thrown rock, dart or spear counts as well, and a tame wolf bites for ${WOLF_BITE}. A zombie you knock out may leave a ${describeDrops(MOB_DROPS.zombie, true)}; an alpha has ${numWord(KIND_STATS.alpha.drops)} chances at one.`),
    ],
  ]);

  // ---- 9. Death and waking
  chapter('death', 'Death and waking', 'Death', 'hide', [
    [
      h('When you fall'),
      p('When your health runs out, everything you carry and wear stays where you fell, in a hide bundle tied with a hex knot. A tall marker stick with a honey-coloured hex tag shows the place from about 20 cells away. The death screen tells you where: q, r and height.'),
      p('Walk back and press [R] on *Your Belongings* to take everything back; what does not fit stays inside. They never decay, though food in them still spoils.'),
      warn('Your belongings are lost for good if a black hole swallows you or you fall out beneath the bedrock.'),
      tip('This book stays with you through everything.'),
    ],
    [
      h('Waking'),
      ...wakeTable(),
      p('*Wake up* puts you back on your feet: on your Sleeping Hide if you have one, otherwise in green land (plains or forest) near the world\'s spawn, so a harsh land never kills you twice.'),
      p('Jobs in the making lanes are dropped when you die, but nothing is lost: inputs are only taken when a job finishes.'),
      tip('Your horse waits where you left it. A wolf that was following you finds you again.'),
    ],
    [
      h('The Sleeping Hide'),
      p(`A Sleeping Hide is a hide pegged out at six stakes. Make it at a Work Stump from ${recipeInputsProse(hide)}, with a ${plain(toolNeedLabel('knife', 2))}. Place it, then press [R] on it: from then on you wake there.`),
      p('It does not skip the night (the world\'s clock is shared), but it keeps your camp, your fire and your stores close when things go wrong.'),
      tip(`Keep spare food, a pot and tools in a Wicker Basket (${recipeInputsProse(basket)}; ${BASKET_SLOTS} slots) beside your hide.`),
    ],
  ]);

  // ---- 10. Controls
  chapter('controls', 'Controls', 'Keys', 'keys', [
    [
      ...table({ id: 'keys-move', caption: 'Moving', head: ['Key', 'Does'], rows: [
        ['W A S D', 'walk (arrow keys work too)'],
        ['Space', 'jump; swim up'],
        ['Shift', 'sneak: slow, low, and harder for animals to notice'],
        ['W W', 'double-tap and hold to sprint (hungry, thirsty work)'],
        ['Mouse', 'look around'],
        ['1–9, wheel', 'choose a hotbar slot'],
        ['Esc', 'pause (the Guide is there)'],
        ['T', 'the command console'],
        ['F3', 'the debug overlay'],
        ['M', 'sound on or off'],
      ] }),
    ],
    [
      ...table({ id: 'keys-hands', caption: 'Your hands', head: ['Key', 'Does'], rows: [
        ['Hold LMB', 'dig: a honey outline traces the cell'],
        ['LMB on a mob', 'strike (hold to keep striking)'],
        ['RMB', 'place the block in hand'],
        ['Hold RMB', 'eat, drink a pot, bandage; wear clothes'],
        ['MMB', 'pick the hotbar slot holding that block'],
        ['R', 'use whatever you look at (next page)'],
        ['Q', 'drop one of what you hold (with Shift: the whole stack)'],
        ['G', 'throw one of what you hold where you look'],
        ['E', 'your pack and Making'],
      ] }),
      p('The ring round the crosshair fills while you dig, eat, tap a birch or relight a fire. Let go to stop.'),
    ],
    [
      h('[R] does the nearest useful thing'),
      steps([
        'An animal: feed it what it likes, milk a cow, shear a sheep, ride your horse, or tell your wolf to sit or follow.',
        'A snare: bait it with the food in your hand.',
        'A campfire: put food or a pot on, feed it, or take what is done.',
        'A cold fire pit: take what was left, or relight it.',
        'A ripe bush, a prickly pear, loose stones or branches: pick.',
        'A birch log, with an empty pot in hand: tap its sap.',
        'A basket: open it. Your Belongings: take them back.',
        'A Sleeping Hide: wake here from now on.',
        'A workplace: open Making on its tab.',
        'Water: drink, or fill the empty pot in your hand.',
        'With the handbook in hand: read it.',
      ]),
    ],
    [
      h('Riding'),
      ...table({ id: 'keys-ride', caption: 'On your horse', head: ['Key', 'Does'], rows: [
        ['R', 'get on your tame horse'],
        ['Mouse', 'turn: the horse goes where you look'],
        ['W A S D', 'ride'],
        ['W W', 'double-tap and hold to gallop'],
        ['Space', `leap a wall ${Math.floor(RIDE_LEAP)} cells high`],
        ['Shift', 'get off'],
      ] }),
      p('A horse hops single steps by itself and swims. It waits where you get off.'),
    ],
    [
      h('Dropping and throwing'),
      p('[Q] drops one of the thing in your hand a step ahead of you; hold [Shift] as well and the whole stack goes. [G] throws one where the crosshair points.'),
      ...throwsTable(),
      p('Aim a little high: a throw sinks as it flies. This book can be neither dropped nor thrown.'),
    ],
    [
      h('Things on the ground'),
      p('What you dig, pick or win does not land in your pack at once. It pops out, flies to you, and is yours when it reaches you. A block will not break while your pack has no room for what it gives: the hint says *Pack full*.'),
      p(`Walk within ${fmtNum(COLLECT_RADIUS)} cells of something lying loose and it comes to you, if you have room. A thing you dropped or threw waits until you have stepped away from it once, so it never hops straight back.`),
      p(`Nothing lies there for ever. After ${fmtDurationLong(LOOSE_DESPAWN_S)} on the ground a thing is gone; it blinks for its last ${LOOSE_BLINK_S} seconds to warn you. A burning campfire burns up whatever lands in it.`),
      tip('What you mean to keep belongs in a Wicker Basket, not on the ground.'),
    ],
    [
      h('The pack'),
      p(`Your pack has ${PACK_SLOTS} slots: the ${HOTBAR_SIZE}-slot hotbar strip and a rosette of ${PACK_SLOTS - HOTBAR_SIZE} round a centre hex that shows what you point at. On the left are the clothes you wear (head, body, feet) and the red discard hex.`),
      bullets([
        'Click: pick up a stack, or put it down.',
        'Right-click: pick up half, or put down one.',
        'Shift-click: move between the hotbar and the rosette, or into an open basket.',
        'Put a stack on the discard hex to destroy it.',
        'Right-click the handbook to read it.',
      ]),
      tip('New finds go to the hotbar first. The world keeps running while the pack is open.'),
    ],
  ]);

  // ---- 11. Creative and Survival
  chapter('modes', 'Creative and Survival', 'Modes', 'switch', [
    [
      h('Two ways to play'),
      p('Every world has its own mode. Switch it in the pause menu (*Mode: Creative | Survival*), or type “mode survival” in the console.'),
      p(`The first time a world enters Survival you start fresh: Health ${R.NEW_HEALTH}, Nourishment and Hydration ${R.NEW_SATIATION}, an empty pack and this book. If the land around you is harsh, the chat points you toward green land.`),
      p('Going back to Creative freezes your survival life exactly as it is, and it comes back unchanged next time. Nothing moves between the Creative hotbar and your pack, but the world is shared: what you build in Creative you can harvest in Survival.'),
    ],
    [
      h('Older worlds'),
      p('Worlds made before Survival have no wild plants, ponds, copper or tin. The first time you switch one to Survival you are asked to bring them in: they appear wherever the land is untouched, near your builds too. This cannot be undone.'),
      p('New worlds have them unless you untick *Survival resources* when you create the world.'),
    ],
    [
      h('Good to know'),
      bullets([
        'Fires lit in Creative burn forever; only Survival fires need fuel.',
        'In Creative, [R] tames a horse or a wolf at once, and your blows only shove an animal.',
        'The pause menu\'s Undo is off in Survival: it would hand back what you mined.',
        'Creative will not break a basket, your belongings or a fire that holds survival things.',
        'In the console, “vitals”, “pack” and “items” show your state.',
      ]),
      tip('The Guide is always on the title screen and in the pause menu, in both modes.'),
    ],
  ]);

  return chapters;
}

/** @template T @param {T} o @returns {T} o, deeply frozen */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** @type {readonly Chapter[]|null} */
let cached = null;

/**
 * The handbook's chapters, built once (deeply frozen; the same array every call).
 * @returns {readonly Chapter[]}
 */
export function buildChapters() {
  if (!cached) cached = deepFreeze(makeChapters());
  return cached;
}

/** @returns {string[]} the chapter ids, in order */
export function chapterIds() {
  return buildChapters().map((c) => c.id);
}

/**
 * Give the pack a handbook when it has none (§14.2: a new survival state, and every waking): into `preferSlot` when it is
 * empty, else the last empty slot. Works on a `Pack` (setSlot) or any `{ slots, version }`.
 * @param {{ slots: (ItemStack|null)[], wear?: (ItemStack|null)[], setSlot?: (i: number, s: ItemStack) => void,
 *   touch?: () => void, version?: number }} pack
 * @param {number} [preferSlot=8] the last hotbar slot
 * @returns {boolean} true when one was given; false when the pack already has one (or is full, or not a pack)
 */
export function ensureHandbook(pack, preferSlot = HOTBAR_SIZE - 1) {
  if (!pack || !Array.isArray(pack.slots)) return false;
  const slots = pack.slots;
  const has = (/** @type {any} */ s) => !!s && s.k === HANDBOOK_KEY;
  if (slots.some(has) || (Array.isArray(pack.wear) && pack.wear.some(has))) return false;
  let i = Number.isInteger(preferSlot) && preferSlot >= 0 && preferSlot < slots.length && !slots[preferSlot] ? preferSlot : -1;
  for (let j = slots.length - 1; i < 0 && j >= 0; j--) if (!slots[j]) i = j;
  if (i < 0) return false;
  /** @type {ItemStack} */
  const stack = { k: HANDBOOK_KEY, n: 1 };
  if (typeof pack.setSlot === 'function') pack.setSlot(i, stack);
  else {
    slots[i] = stack;
    if (typeof pack.touch === 'function') pack.touch();
    else if (typeof pack.version === 'number') pack.version++;
  }
  return true;
}

/** Everything a generated table may name as its `source`. */
export const TABLE_SOURCES = Object.freeze(['recipes', 'items', 'harvest', 'fire', 'climate', 'vitals', 'animals', 'zombies', 'loose']);

/** For tests: every block id the book's generated tables read (so a renamed block fails loudly). */
export const BOOK_BLOCKS = Object.freeze([...GATHER, ...BREAK_EXAMPLES, ...Object.values(STATION_BLOCKS)]);
