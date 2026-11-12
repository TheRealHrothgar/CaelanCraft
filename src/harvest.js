// Caelancraft — harvesting in Survival: what each block needs and gives (BLOCK_RULES), break times, drops, picking and
// tapping with R, the regrowth of picked bushes, mob drops and tool power. Pure: every roll takes `random` ([0, 1)).
// See docs/DESIGN-survival.md §6 and §4.2–§4.3 (CONTRACTS §44 once merged).
//
// Drops are written as GROUPS. Each group gives at most one BRANCH: the first whose condition holds (a group whose only
// branch has a condition gives nothing when it fails). An item in a branch is a fixed count or an inclusive range, may
// have a chance `p`, and may be `natural`: given only when the cell had no edit before the break (main checks
// `!world.hasEdit(q, y, r)` BEFORE writing AIR). Conditions: the selected tool's type ('shovel', 'knife', 'axe', 'pick') or
// 'knifeInPack' (a knife of tier ≥ 2 anywhere in the pack).
import { REGROW_MEAN_S, MAX_REGROW_TRACKED, SEA_LEVEL } from './config.js';
import { BLOCK, BLOCK_COUNT, getBlockDef, FLINT_SHARE } from './blocks.js';
import { TIER_NAMES, TIER_SPEED, itemForBlock } from './items.js';
import { forEachEditedCell } from './coords.js';

/** @typedef {import('./types.js').ItemStack} ItemStack */
/** @typedef {import('./types.js').ToolDef} ToolDef */

/**
 * @typedef {Object} DropItem
 * @property {string} k                 item key
 * @property {number|number[]} n      a count, or an inclusive [min, max] range rolled uniformly
 * @property {number} [p]               chance 0..1 (absent: always)
 * @property {boolean} [natural]        only from a cell that had no edit before the break
 * @property {boolean} [deep]           only from a cell at y ≤ SEA_LEVEL − DEEP_BELOW_SEA (v0.10: cave saltpetre)
 */
/** @typedef {{ if: string|null, items: DropItem[] }} DropBranch */
/** @typedef {DropBranch[]} DropGroup */
/**
 * @typedef {Object} BlockRule
 * @property {number} h            seconds by hand
 * @property {string|null} tool    the preferred tool type ('shovel', 'axe', 'pick', 'knife'), null when none is faster
 * @property {number} tier         the minimum tier of that tool; 0 = bare hands allowed
 * @property {DropGroup[]} drops
 */
/**
 * @typedef {{ natural?: boolean, knifeInPack?: boolean, deep?: boolean, decided?: Record<string, boolean> }} DropContext
 * `deep`: isDeep(y) of the cell; `decided[key]`: a chance item's outcome fixed by the caller (not rolled: §70 flint)
 */

/** v0.14 (§76): the chance that digging a cell of wild gravel gives a Flint. */
export const GRAVEL_FLINT_P = 0.12;
/** Breaking with the head under water takes this many times longer (§6.1). */
export const UNDERWATER_DIG_FACTOR = 2.5;
/** No block breaks faster than this (s). */
export const MIN_BREAK_S = 0.05;
/** v0.10 (DESIGN-circuits §8.1): saltpetre crusts only on cave walls this far below sea level or deeper. */
export const DEEP_BELOW_SEA = 14;
/** @param {number} y @returns {boolean} a cell at this height counts as `deep` for drops */
export function isDeep(y) {
  return Number.isFinite(y) && y <= SEA_LEVEL - DEEP_BELOW_SEA;
}

const B = BLOCK;
/** Placeholder for the block's own item, resolved per id (`itemForBlock`). */
const SELF = '@self';

/**
 * @param {string} k @param {number|number[]} [n=1] a count or [min, max] @param {{p?: number, natural?: boolean}} [opts]
 * @returns {DropItem}
 */
function drop(k, n = 1, opts = {}) {
  return { k, n, ...opts };
}
/** A group that always gives these. @param {...DropItem} items @returns {DropGroup} */
function always(...items) {
  return [{ if: null, items }];
}
/** @param {string|null} cond @param {...DropItem} items @returns {DropBranch} */
function when(cond, ...items) {
  return { if: cond, items };
}
const SELF_DROPS = Object.freeze([always(drop(SELF))]);
const natural = { natural: true };

/** @type {(BlockRule|null)[]} */
const rules = new Array(BLOCK_COUNT).fill(null);

/**
 * @param {number[]} ids @param {number} h @param {string|null} tool @param {number} tier
 * @param {ReadonlyArray<DropGroup>} drops ('@self' becomes each id's own item)
 */
function set(ids, h, tool, tier, drops) {
  for (const id of ids) {
    const self = itemForBlock(id);
    const resolved = drops.map((group) =>
      group.map((br) => ({
        if: br.if,
        items: br.items.map((it) => {
          if (it.k !== SELF) return { ...it };
          if (self === null) throw new Error(`harvest: block ${id} drops itself but has no item`);
          return { ...it, k: self };
        }),
      })),
    );
    rules[id] = { h, tool, tier, drops: resolved };
  }
}

// ---- §6.3, row by row ----
set([B.DIRT], 0.9, 'shovel', 0, SELF_DROPS);
set([B.GRASS_BLOCK], 1.0, 'shovel', 0, [[when('shovel', drop(SELF)), when(null, drop('dirt'), drop('plant_fibre', 1, { p: 0.2, ...natural }))]]);
set([B.SNOWY_GRASS], 1.0, 'shovel', 0, [[when('shovel', drop(SELF)), when(null, drop('dirt'), drop('snow', 1, natural))]]);
set([B.SAND, B.RED_SAND], 0.8, 'shovel', 0, SELF_DROPS);
// v0.14 (§76): digging WILD gravel sometimes turns up a Flint (GRAVEL_FLINT_P), with or without a shovel — this is where
// most flint comes from. Gravel you put down yourself, or that fell, gives none, so it cannot be dug over and over.
// FLINT_GRAVEL is v0.13's withdrawn block: the same rule (its gravel is plain gravel).
set([B.GRAVEL, B.FLINT_GRAVEL], 1.2, 'shovel', 0, [
  [when('shovel', drop('gravel')), when(null, drop('rock', 2))], always(drop('flint', 1, { p: GRAVEL_FLINT_P, ...natural })),
]);
set([B.CLAY], 1.4, 'shovel', 0, [always(drop('clay_lump', 6))]);
set([B.SNOW_BLOCK], 0.5, 'shovel', 0, [always(drop('snow', 6))]);
set([B.ICE], 1.0, 'pick', 0, [[when('pick', drop('ice_chunk', 2)), when(null, drop('ice_chunk', 1))]]);
set([B.PACKED_ICE], 2.0, 'pick', 2, [always(drop('ice_chunk', 3))]);
set([B.LOOSE_STONES], 0.2, null, 0, [always(drop('rock', [1, 2])), always(drop('flint', 1, { p: FLINT_SHARE, ...natural }))]);
set([B.FALLEN_BRANCHES], 0.2, null, 0, [always(drop('stick', [2, 3]))]);
// Leaves: only an axe lops them (self, and a stick from untouched leaves); by hand they give nothing but the odd nut.
const LOP = [when('axe', drop(SELF), drop('stick', 1, natural))];
set([B.OAK_LEAVES], 0.4, 'axe', 0, [LOP, always(drop('acorns', 1, { p: 0.08, ...natural }))]);
set([B.SPRUCE_LEAVES], 0.4, 'axe', 0, [LOP, always(drop('pine_nuts', 1, { p: 0.08, ...natural }))]);
set([B.BIRCH_LEAVES], 0.4, 'axe', 0, [LOP]);
// Wild plants: a shovel digs the plant up (its item places the picked variant, which must regrow).
set([B.HONEYBERRY_BUSH], 0.5, 'shovel', 0, [[when('shovel', drop('honeyberry_bush'))], always(drop('honeyberries', [2, 4])), always(drop('stick', [1, 2]))]);
set([B.HONEYBERRY_BUSH_BARE], 0.5, 'shovel', 0, [[when('shovel', drop('honeyberry_bush'))], always(drop('stick', [1, 2]))]);
set([B.PRICKLY_PEAR], 0.5, 'shovel', 0, [
  [when('shovel', drop('prickly_pear'))],
  [when('knifeInPack', drop('cactus_fruit', [1, 2])), when(null, drop('unpeeled_cactus_fruit', [1, 2]))],
]);
set([B.PRICKLY_PEAR_BARE], 0.5, 'shovel', 0, [[when('shovel', drop('prickly_pear'))]]);
set([B.TUSSOCK], 0.2, 'knife', 0, [[when('shovel', drop(SELF)), when('knife', drop('plant_fibre', [2, 3])), when(null, drop('plant_fibre', [1, 2]))]]);
set([B.CATTAILS], 0.3, 'knife', 0, [[
  when('shovel', drop(SELF)),
  when('knife', drop('plant_fibre', 3), drop('cattail_root', 1, { p: 0.5 })),
  when(null, drop('plant_fibre', 2), drop('cattail_root', 1, { p: 0.3 })),
]]);
set([B.TUBER_PLANT], 0.4, 'shovel', 0, [[
  when('shovel', drop('wild_tuber', [2, 3]), drop('plant_fibre', 1)),
  when(null, drop('wild_tuber', 1), drop('plant_fibre', 1)),
]]);
// v0.14 (§76 flora): the wild plants of generation 3. R picks each of them (PICKABLE below); breaking one by hand gives
// what a pick gives and destroys the plant. A shovel digs up more roots, and lifts a thicket, a bush or a Healwort whole
// (its item places the picked variant, which must regrow). Breaking a Healwort by hand is the mistake to avoid.
set([B.HONEYCAP_MUSHROOM], 0.2, null, 0, [always(drop('honeycap', [1, 2]))]);
set([B.FRECKLECAP_MUSHROOM], 0.2, null, 0, [always(drop('frecklecap', [1, 2]))]);
set([B.ONION_PLANT], 0.4, 'shovel', 0, [[when('shovel', drop('wild_onion', [2, 3])), when(null, drop('wild_onion', [1, 2]))]]);
set([B.CARROT_PLANT], 0.4, 'shovel', 0, [[when('shovel', drop('wild_carrot', [1, 2])), when(null, drop('wild_carrot', 1))]]);
set([B.HAZEL_THICKET], 0.6, 'shovel', 0, [[when('shovel', drop('hazel_thicket'))], always(drop('hazelnuts', [1, 3])), always(drop('stick', [2, 3]))]);
set([B.HAZEL_THICKET_BARE], 0.6, 'shovel', 0, [[when('shovel', drop('hazel_thicket'))], always(drop('stick', [2, 3]))]);
set([B.CRAB_APPLE_BUSH], 0.6, 'shovel', 0, [[when('shovel', drop('crab_apple_bush'))], always(drop('crab_apple', [2, 3])), always(drop('stick', [1, 2]))]);
set([B.CRAB_APPLE_BUSH_BARE], 0.6, 'shovel', 0, [[when('shovel', drop('crab_apple_bush'))], always(drop('stick', [1, 2]))]);
set([B.HEALWORT_PLANT], 0.3, 'shovel', 0, [[when('shovel', drop('healwort_plant'))], always(drop('healwort', 1))]);
set([B.HEALWORT_PLANT_BARE], 0.3, 'shovel', 0, [[when('shovel', drop('healwort_plant'))]]);
// Wood
set([B.OAK_LOG, B.SPRUCE_LOG], 3.0, 'axe', 1, SELF_DROPS);
set([B.BIRCH_LOG], 3.0, 'axe', 1, [always(drop(SELF)), always(drop('birch_bark', 1, { p: 0.5, ...natural }))]);
set([B.OAK_PLANKS, B.SPRUCE_PLANKS, B.BIRCH_PLANKS], 2.0, 'axe', 1, SELF_DROPS);
set([B.BOOKSHELF], 1.5, 'axe', 1, SELF_DROPS);
set([B.WORK_STUMP], 2.5, 'axe', 1, SELF_DROPS);
set([B.WORKBENCH], 3.0, 'axe', 1, SELF_DROPS); // v0.11 (CONTRACTS §67)
set([B.SNARE, B.SNARE_BAITED, B.SNARE_SPRUNG], 0.3, null, 0, SELF_DROPS); // §69: any state gives the Snare back
set([B.WICKER_BASKET], 0.8, 'axe', 0, SELF_DROPS); // + its contents (containers.js)
set([B.POWDER_KEG], 2.0, 'axe', 1, SELF_DROPS); // the BLAST_BARREL row, under its new name
set([B.PUMPKIN], 1.0, 'axe', 0, SELF_DROPS);
// Soft blocks a knife cuts
const WOOLS = [
  B.WOOL_WHITE, B.WOOL_RED, B.WOOL_ORANGE, B.WOOL_YELLOW, B.WOOL_LIME, B.WOOL_GREEN, B.WOOL_CYAN, B.WOOL_LIGHT_BLUE,
  B.WOOL_BLUE, B.WOOL_PURPLE, B.WOOL_MAGENTA, B.WOOL_PINK, B.WOOL_BROWN, B.WOOL_BLACK, B.WOOL_GRAY, B.WOOL_LIGHT_GRAY,
];
set([B.HAY_BALE, ...WOOLS, B.HONEYCOMB_BLOCK], 0.8, 'knife', 0, SELF_DROPS);
set([B.SLEEPING_HIDE], 0.5, 'knife', 0, SELF_DROPS);
// Containers and fires: their contents and fire spots are released by containers.js / cooking.js, not dropped here.
set([B.REMAINS], 0.3, null, 0, []);
set([B.CAMPFIRE], 0.5, null, 0, [always(drop('rock', 4))]);
set([B.FIRE_PIT], 0.5, null, 0, [always(drop('rock', 4)), always(drop('charcoal', 1))]);
set([B.GLASS], 0.5, null, 0, [always(drop('glass_shards', [1, 2]))]);
set([B.GLOWSTONE], 1.0, 'pick', 0, SELF_DROPS);
set([B.BLACK_HOLE], 1.0, null, 0, []);
set([B.KILN], 3.0, 'pick', 0, SELF_DROPS);
set([B.BLOOMERY], 4.0, 'pick', 2, SELF_DROPS);
set([B.FORGE], 5.0, 'pick', 2, SELF_DROPS);
// Rock: no stone pick exists, so a flint pick is the first way in.
set([B.STONE], 3.0, 'pick', 2, [
  always(drop('rock', 2)),
  always(drop('saltpetre', 1, { p: 0.06, deep: true, ...natural })), // v0.10 (DESIGN-circuits §8.1): cave saltpetre
]);
set([B.COBBLESTONE, B.MOSSY_COBBLESTONE, B.STONE_BRICKS, B.MOSSY_STONE_BRICKS, B.BRICKS], 3.0, 'pick', 2, SELF_DROPS);
set([B.GRANITE, B.DIORITE, B.ANDESITE, B.SLATE], 3.5, 'pick', 2, SELF_DROPS);
set([B.SANDSTONE], 2.0, 'pick', 2, SELF_DROPS);
set([B.OBSIDIAN], 2.5, 'pick', 2, [always(drop('obsidian_shard', [2, 3]))]);
set([B.RUNE_BLOCK], 2.0, 'pick', 2, SELF_DROPS); // its script is lost, as today
// Ores
set([B.COAL_ORE], 3.5, 'pick', 2, [always(drop('coal', [1, 2])), always(drop('pyrite', 1, { p: 0.25, ...natural }))]);
set([B.COPPER_ORE], 4.0, 'pick', 2, [always(drop('malachite', [1, 2]))]);
set([B.TIN_ORE], 4.0, 'pick', 3, [always(drop('cassiterite', 1)), always(drop('cassiterite', 1, { p: 0.25 }))]);
set([B.IRON_ORE], 5.0, 'pick', 4, [always(drop('hematite', [1, 2]))]);
set([B.GOLD_ORE], 5.0, 'pick', 4, [always(drop('gold_nugget', [1, 2]))]);
set([B.DIAMOND_ORE], 4.0, 'pick', 2, [always(drop('rough_gem', 1))]);
// Storage blocks come apart with any pick.
set([B.COAL_BLOCK], 4.0, 'pick', 2, SELF_DROPS);
set([B.COPPER_BLOCK, B.GOLD_BLOCK, B.DIAMOND_BLOCK], 5.0, 'pick', 2, SELF_DROPS);
set([B.IRON_BLOCK], 6.0, 'pick', 2, SELF_DROPS);
// v0.10 circuits (DESIGN-circuits §8.3): every part comes away whole. (A battery's charge is not carried yet: KNOWN-ISSUES.)
set([B.COPPER_WIRE, B.BROWN_WIRE, B.WHITE_WIRE, B.EARTH_WIRE, B.POWDER_FUSE], 0.2, null, 0, SELF_DROPS);
set([B.TORCH], 0.3, null, 0, SELF_DROPS);
set([B.TERMINAL_BOARD, B.RELAY, B.BLASTING_MACHINE, B.SPARK_TRANSMITTER, B.CLOCKWORK_TIMER, B.FILAMENT_LAMP], 1.0, 'axe', 0, SELF_DROPS);
set([B.VOLTAIC_BATTERY], 1.0, 'axe', 0, SELF_DROPS);
set([B.KNIFE_SWITCH, B.PUSH_BUTTON, B.ELECTRIC_BELL, B.IGNITER], 1.2, 'pick', 0, SELF_DROPS);
set([B.SELENIUM_PANEL, B.COHERER_RECEIVER], 0.6, null, 0, SELF_DROPS);
set([B.COLLAPSAR_CHARGE], 1.5, 'pick', 0, SELF_DROPS); // Creative-made only, but it can be taken up in Survival (§8.2)
// BEDROCK, AIR and the water family keep the null rule: unbreakable.

/** @template T @param {T} o @returns {T} */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** Index = block id (BLOCK_COUNT entries): the block's rule, or null when it cannot be broken in Survival. */
export const BLOCK_RULES = deepFreeze(rules);

/** @param {number} id @returns {BlockRule|null} */
export function ruleFor(id) {
  return Number.isInteger(id) && id >= 0 && id < BLOCK_RULES.length ? BLOCK_RULES[id] : null;
}

/**
 * Whether `tool` (the selected item's ToolDef, or null for the hand) may break block `id` at all (§6.1).
 * @param {number} id @param {ToolDef|null} tool
 */
export function canHarvest(id, tool) {
  const rule = ruleFor(id);
  if (!rule) return false;
  return rule.tier === 0 || (!!tool && tool.type === rule.tool && tool.tier >= rule.tier);
}

/**
 * Seconds to break block `id` (§6.1): `max(0.05, h / speed) × (underwater ? 2.5 : 1)`, speed = TIER_SPEED[tier] with
 * the rule's tool type, else 1. Infinity when it cannot be broken (null rule, or the tier requirement is not met).
 * @param {number} id @param {ToolDef|null} tool @param {boolean} [underwater] player.headInWater
 */
export function breakSeconds(id, tool, underwater = false) {
  if (!canHarvest(id, tool)) return Infinity;
  const rule = /** @type {BlockRule} */ (ruleFor(id));
  const speed = tool && tool.type === rule.tool ? TIER_SPEED[tool.tier] : 1;
  return Math.max(MIN_BREAK_S, rule.h / speed) * (underwater ? UNDERWATER_DIG_FACTOR : 1);
}

/**
 * The target hint for a block that needs a better tool (§6.1): `Iron Ore · needs a bronze pick or better`.
 * @param {number} id @returns {string|null} null when bare hands may break it (or nothing can)
 */
export function harvestHint(id) {
  const rule = ruleFor(id);
  if (!rule || rule.tier === 0) return null;
  return `${getBlockDef(id).displayName} · needs ${withArticle(`${TIER_NAMES[rule.tier]} ${rule.tool}`)} or better`;
}

/** "a bronze pick", "an iron hammer". @param {string} noun */
export function withArticle(noun) {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

/** Tool types that wear on a block they break (§6.1 step 6); a spear or sword wears only on blows, the kiln kit never digs. */
export const DIG_TOOL_TYPES = Object.freeze(new Set(['axe', 'shovel', 'pick', 'knife', 'hammer']));

/**
 * The bare-hand gathering targets the Handbook names that R does NOT pick (§6.2: tussock, cattails, the tuber plant,
 * gravel, clay): their crosshair hint tells a new player to hold the left mouse button, the way the neighbouring loose
 * stones say `R: pick`. The verb is the Handbook's: plants are pulled, ground is dug.
 * @type {Readonly<Record<number, string>>}
 */
export const HAND_GATHER = Object.freeze({
  [B.TUSSOCK]: 'pull', [B.CATTAILS]: 'pull', [B.TUBER_PLANT]: 'pull', [B.GRAVEL]: 'dig', [B.FLINT_GRAVEL]: 'dig', [B.CLAY]: 'dig',
});

/**
 * The target hint for a bare-hand gathering target that is broken, not picked (§6.1): `Tussock Grass · hold LMB: pull`,
 * `Gravel · hold LMB: dig`. Null for every other block (ordinary digging has no hint, as in Creative).
 * @param {number} id @returns {string|null}
 */
export function handGatherHint(id) {
  if (!Number.isInteger(id) || !Object.hasOwn(HAND_GATHER, id)) return null;
  return `${getBlockDef(id).displayName} · hold LMB: ${HAND_GATHER[id]}`;
}

/** @param {string|null} cond @param {ToolDef|null} tool @param {DropContext} ctx */
function holds(cond, tool, ctx) {
  if (cond === null) return true;
  if (cond === 'knifeInPack') return !!ctx.knifeInPack;
  return !!tool && tool.type === cond;
}

/** @param {number|number[]} n @param {() => number} random */
function rollCount(n, random) {
  if (typeof n === 'number') return n;
  const [a, b] = n;
  return Math.min(b, a + Math.floor(random() * (b - a + 1)));
}

/**
 * Roll drop groups. Per item: skipped (no roll) when `natural` and the cell was edited; then one roll for `p`; then one
 * for a range. Aggregated by key, in order of first appearance.
 * @param {ReadonlyArray<DropGroup>} groups @param {ToolDef|null} tool @param {DropContext} ctx @param {() => number} random
 * @returns {ItemStack[]}
 */
export function rollGroups(groups, tool, ctx, random) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const group of groups) {
    const br = group.find((b) => holds(b.if, tool, ctx));
    if (!br) continue;
    for (const it of br.items) {
      if (it.natural && !ctx.natural) continue;
      if (it.deep && !ctx.deep) continue;
      // A chance the caller has already decided (`ctx.decided[key]`: the flint the player can see in loose stones, §70)
      // is not rolled again.
      const decided = ctx.decided && Object.hasOwn(ctx.decided, it.k) ? ctx.decided[it.k] : undefined;
      if (it.p !== undefined && (decided !== undefined ? !decided : !(random() < it.p))) continue;
      const n = rollCount(it.n, random);
      if (n > 0) out.set(it.k, (out.get(it.k) ?? 0) + n);
    }
  }
  return [...out].map(([k, n]) => ({ k, n }));
}

/**
 * What breaking block `id` gives (§6.3). `ctx.natural` must be computed before the break (`!world.hasEdit`).
 * @param {number} id @param {ToolDef|null} tool the selected tool (null: hand)
 * @param {DropContext} ctx @param {() => number} random
 * @returns {ItemStack[]} by key; empty when the block cannot be harvested with that tool
 */
export function rollDrops(id, tool, ctx, random) {
  if (!canHarvest(id, tool)) return [];
  return rollGroups(/** @type {BlockRule} */ (ruleFor(id)).drops, tool, ctx ?? {}, random);
}

// ---- Picking with R (§6.4) ----

/**
 * Block id → what R does to it: the block it becomes and the drop groups (§6.4).
 * @type {Readonly<Record<number, { to: number, drops: DropGroup[] }>>}
 */
export const PICKABLE = deepFreeze({
  [B.HONEYBERRY_BUSH]: { to: B.HONEYBERRY_BUSH_BARE, drops: [always(drop('honeyberries', [2, 4]))] },
  [B.PRICKLY_PEAR]: {
    to: B.PRICKLY_PEAR_BARE,
    drops: [[when('knifeInPack', drop('cactus_fruit', [1, 2])), when(null, drop('unpeeled_cactus_fruit', [1, 2]))]],
  },
  [B.LOOSE_STONES]: { to: B.AIR, drops: [always(drop('rock', [1, 2])), always(drop('flint', 1, { p: FLINT_SHARE, ...natural }))] },
  [B.FALLEN_BRANCHES]: { to: B.AIR, drops: [always(drop('stick', [2, 3]))] },
  // v0.14 (§76 flora): mushrooms and roots come away whole; a thicket, a bush and a Healwort stay, picked, and regrow
  [B.HONEYCAP_MUSHROOM]: { to: B.AIR, drops: [always(drop('honeycap', [1, 2]))] },
  [B.FRECKLECAP_MUSHROOM]: { to: B.AIR, drops: [always(drop('frecklecap', [1, 2]))] },
  [B.ONION_PLANT]: { to: B.AIR, drops: [always(drop('wild_onion', [1, 2]))] },
  [B.CARROT_PLANT]: { to: B.AIR, drops: [always(drop('wild_carrot', 1))] },
  [B.HAZEL_THICKET]: { to: B.HAZEL_THICKET_BARE, drops: [always(drop('hazelnuts', [1, 3]))] },
  [B.CRAB_APPLE_BUSH]: { to: B.CRAB_APPLE_BUSH_BARE, drops: [always(drop('crab_apple', [2, 3]))] },
  [B.HEALWORT_PLANT]: { to: B.HEALWORT_PLANT_BARE, drops: [always(drop('healwort', 1))] },
});

/** @param {number} id @returns {boolean} R picks it */
export function isPickable(id) {
  return Number.isInteger(id) && Object.hasOwn(PICKABLE, id);
}

/**
 * R on a ripe bush, a prickly pear or ground litter (§6.4). Main checks `pack.canGive(drops)`, writes `to` with
 * playerSetBlock, then adds the drops.
 * @param {number} id @param {DropContext} ctx @param {() => number} random
 * @returns {{ to: number, drops: ItemStack[] }|null}
 */
export function pick(id, ctx, random) {
  if (!isPickable(id)) return null;
  const p = PICKABLE[id];
  return { to: p.to, drops: rollGroups(p.drops, null, ctx ?? {}, random) };
}

// ---- Tapping birch sap (§4.2) ----

/**
 * R held on a BIRCH_LOG with an empty clay pot selected and a knife (tier ≥ 2) in the pack.
 * @param {number} id @param {string|null} selectedKey @param {boolean} knifeInPack
 * @returns {{ gives: 'pot_sap', takes: 'clay_pot', wears: 'knife' }|null}
 */
export function tap(id, selectedKey, knifeInPack) {
  if (id !== B.BIRCH_LOG || selectedKey !== 'clay_pot' || !knifeInPack) return null;
  return { gives: 'pot_sap', takes: 'clay_pot', wears: 'knife' };
}

/** Which birch cells were tapped on which game day (each once per day). Not saved. */
export class Tapped {
  constructor() {
    /** @type {Map<string, number>} "q,y,r" → day */
    this.days = new Map();
  }

  /** @param {string} key "q,y,r" @param {number} day the game day @returns {boolean} not yet tapped that day */
  canTap(key, day) {
    return this.days.get(key) !== day;
  }

  /** Remember a tap (and forget taps from other days, which no longer matter). @param {string} key @param {number} day */
  mark(key, day) {
    for (const [k, d] of this.days) if (d !== day) this.days.delete(k);
    this.days.set(key, day);
  }

  clear() {
    this.days.clear();
  }
}

// ---- Regrowth (§6.5) ----

/** Picked variant → the ripe block it regrows into. @type {Readonly<Record<number, number>>} */
export const RIPE_OF = Object.freeze({
  [B.HONEYBERRY_BUSH_BARE]: B.HONEYBERRY_BUSH,
  [B.PRICKLY_PEAR_BARE]: B.PRICKLY_PEAR,
  // v0.14 (§76 flora)
  [B.HAZEL_THICKET_BARE]: B.HAZEL_THICKET,
  [B.CRAB_APPLE_BUSH_BARE]: B.CRAB_APPLE_BUSH,
  [B.HEALWORT_PLANT_BARE]: B.HEALWORT_PLANT,
});
/** The picked ids Regrowth tracks (every key of RIPE_OF). */
const BARE_IDS = Object.freeze(Object.keys(RIPE_OF).map(Number));

/** @param {number} id @returns {number} the ripe id a picked block regrows into, or −1 */
export function ripeOf(id) {
  return Number.isInteger(id) && Object.hasOwn(RIPE_OF, id) ? RIPE_OF[id] : -1;
}

/** @typedef {{ q: number, y: number, r: number, id: number }} RegrowCell  `id` = the ripe block to write */

/**
 * Tracks picked bushes and pears (at most MAX_REGROW_TRACKED). Main feeds it World.onBlockChange and `loadFromEdits`, and
 * while Survival is active calls `step(1, random, isLoadedCell)` once per second; it writes each returned cell's ripe id
 * lazily (`world.setBlock(q, y, r, id, true)`), which prunes the edit of a wild bush.
 */
export class Regrowth {
  constructor() {
    /** @type {Map<string, RegrowCell>} "q,y,r" → the cell and the ripe id */
    this.cells = new Map();
  }

  get size() {
    return this.cells.size;
  }

  /** @returns {boolean} */
  has(q, y, r) {
    return this.cells.has(`${q},${y},${r}`);
  }

  /** Track a picked cell (no-op when full or already tracked). @param {number} id the picked block id @returns {boolean} tracked */
  track(q, y, r, id) {
    const ripe = ripeOf(id);
    if (ripe < 0) return false;
    const key = `${q},${y},${r}`;
    if (this.cells.has(key)) {
      this.cells.set(key, { q, y, r, id: ripe });
      return true;
    }
    if (this.cells.size >= MAX_REGROW_TRACKED) return false;
    this.cells.set(key, { q, y, r, id: ripe });
    return true;
  }

  /** @returns {boolean} whether it was tracked */
  untrack(q, y, r) {
    return this.cells.delete(`${q},${y},${r}`);
  }

  /** World.onBlockChange. */
  onBlockChange(q, y, r, _prev, next) {
    if (ripeOf(next) >= 0) this.track(q, y, r, next);
    else this.untrack(q, y, r);
  }

  /** Track every picked cell recorded in World.edits (worldgen never emits one, so they are always edits). */
  loadFromEdits(edits) {
    this.clear();
    for (const id of BARE_IDS) forEachEditedCell(edits, id, (q, y, r) => this.track(q, y, r, id));
  }

  clear() {
    this.cells.clear();
  }

  /**
   * Each tracked cell in a loaded chunk regrows with probability `min(1, dt / REGROW_MEAN_S)` (one `random()` per such
   * cell, in tracking order); cells in unloaded chunks are frozen (no roll). Regrown cells stop being tracked.
   * @param {number} dt @param {() => number} random @param {(q: number, r: number) => boolean} isLoadedCell
   * @returns {RegrowCell[]} the cells to write
   */
  step(dt, random, isLoadedCell) {
    /** @type {RegrowCell[]} */
    const out = [];
    if (!(dt > 0)) return out;
    const p = Math.min(1, dt / REGROW_MEAN_S);
    for (const [key, c] of this.cells) {
      if (!isLoadedCell(c.q, c.r)) continue;
      if (random() < p) {
        out.push(c);
        this.cells.delete(key);
      }
    }
    return out;
  }
}

// ---- Mobs (§4.3, §6.3) ----

/** What a mob killed (pig) or knocked out (zombie) by the player gives, straight into the pack. */
export const MOB_DROPS = deepFreeze({
  pig: [always(drop('raw_pork', [2, 3])), always(drop('rawhide', 1)), always(drop('pig_fat', 1, { p: 0.6 }))],
  // v0.11 (CONTRACTS §69)
  cow: [always(drop('raw_beef', [3, 5])), always(drop('rawhide', [1, 2]))],
  sheep: [always(drop('raw_mutton', [1, 2])), always(drop('wool_white', [1, 2]))],
  horse: [always(drop('rawhide', [1, 2]))],
  wolf: [always(drop('rawhide', 1))],
  zombie: [always(drop('grave_rag', 1, { p: 0.5 }))],
});

/** @param {'pig'|'zombie'|'cow'|'sheep'|'horse'|'wolf'} kind @param {() => number} random @returns {ItemStack[]} */
export function rollMobDrops(kind, random) {
  const groups = Object.hasOwn(MOB_DROPS, kind) ? MOB_DROPS[kind] : null;
  return groups ? rollGroups(groups, null, {}, random) : [];
}

/**
 * Damage one hit deals a mob (§5.1): the held tool's power; bare hands (or a non-tool item) deal 1. Pigs are only shoved
 * by bare hands (survivalControl.strikeKind).
 * @param {ToolDef|null} tool
 */
export function toolPower(tool) {
  return tool ? tool.power : 1;
}
