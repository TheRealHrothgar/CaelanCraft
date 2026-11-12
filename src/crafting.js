// Caelancraft — Making: the recipe table, the workplaces near the player, the recipe list and the craft lanes. Pure.
// See docs/DESIGN-survival.md §7 (CONTRACTS §46 once merged).
//
// Making has no grid. A recipe is made at a workplace ("station"): your hands, a Work Stump, a Kiln, a Bloomery or the Forge.
// Each station has its own LANE of jobs; the head job of every lane runs at the same time as the others, and a waiting job
// only blocks the jobs behind it in its own lane. Inputs are taken (and tools worn) only when a job completes, so the lanes
// never need saving or refunding: they are not saved, and a reload or a death simply drops them.
//
// The pack is reached only through the PackOps interface below (inventory.js `Pack` implements it), so this module imports
// no inventory code and tests drive it with a Map-backed fake.
import { MAX_CRAFT_JOBS, STATION_RANGE, STATION_WORK_RANGE, WORLD_HEIGHT } from './config.js';
import { BLOCK, UNLOADED } from './blocks.js';
import { hexDistance, hexLength } from './hex.js';
import { TAGS, TIER_NAMES, TOOL_TYPES, isItemKey, itemName } from './items.js';
import { purposeOf } from './purpose.js';

/** @typedef {import('./types.js').ItemStack} ItemStack */

/**
 * What crafting needs from the pack (inventory.js `Pack` implements it; §10 B).
 * @typedef {Object} PackOps
 * @property {(key: string) => number} count                  items of that key in the pack (worn items excluded)
 * @property {(tag: string) => number} countTag               items of the tag's members
 * @property {(key: string, n: number) => unknown} take        removes n of that key (callers check count first)
 * @property {(tag: string, n: number) => unknown} takeTag     removes n of the tag's members, in TAGS order
 * @property {(stacks: {k: string, n: number}[]) => boolean} canGive   all of them would fit
 * @property {(takes: Iterable<[string, number]>, gives: {k: string, n: number}[]) => boolean} [canExchange]   all of
 *   `gives` would fit once `takes` ([key, n] pairs) are removed (inventory.js Pack has it; `canGive(gives)` otherwise)
 * @property {(key: string, n: number) => number} give         adds n; returns how many did not fit
 * @property {(type: string, minTier: number) => boolean} hasTool
 * @property {(type: string, minTier: number) => ({key: string, broke: boolean}|null)} useTool   1 wear on the qualifying
 *   tool with the lowest tier (ties: the least durability left)
 */

/** @typedef {{ k: string, n: number }} KeyInput   an exact item */
/** @typedef {{ tag: string, n: number }} TagInput  any member of an items.TAGS tag, taken in TAGS order */
/** @typedef {{ type: string, tier: number }} ToolNeed   a tool of that type, tier `tier` or better */

/**
 * @typedef {Object} Recipe
 * @property {string} id                    unique; a metal tool's recipe id is its item key
 * @property {'hand'|'stump'|'kiln'|'bloomery'|'forge'} station
 * @property {(KeyInput|TagInput)[]} inputs  consumed when the job completes
 * @property {{k: string, n: number}[]} outputs   outputs[0] names the job
 * @property {ToolNeed[]} tools             each takes 1 wear per completed job ([] when none)
 * @property {number} seconds
 */

// ---------------------------------------------------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------------------------------------------------

/** Every station id, in lane order (the order of the Making panel's tabs after `All`). */
export const STATION_IDS = Object.freeze(['hand', 'stump', 'kiln', 'bloomery', 'forge', 'workbench']);

/** Station id → the block that is that workplace (`hand` has none: it is always there). */
export const STATION_BLOCKS = Object.freeze({
  stump: BLOCK.WORK_STUMP,
  kiln: BLOCK.KILN,
  bloomery: BLOCK.BLOOMERY,
  forge: BLOCK.FORGE,
  workbench: BLOCK.WORKBENCH, // v0.11 (CONTRACTS §67)
});

/** Station id → its name in chips, hints and messages ("Kiln too far", "build a Work Stump nearby"). */
export const STATION_NAMES = Object.freeze({
  hand: 'Hands',
  stump: 'Work Stump',
  kiln: 'Kiln',
  bloomery: 'Bloomery',
  forge: 'Forge',
  workbench: 'Workbench',
});

/** @type {Map<number, string>} workplace block id → station id */
const STATION_OF_BLOCK = new Map(Object.entries(STATION_BLOCKS).map(([s, id]) => [id, s]));

/** @param {number} blockId @returns {string|null} the station that block is, or null */
export function stationOfBlock(blockId) {
  return STATION_OF_BLOCK.get(blockId) ?? null;
}

/**
 * The workplaces near the player's feet cell (q, y, r): every cell within hex distance STATION_RANGE (37 columns) and
 * |dy| ≤ 2 is looked at, and the nearest of each kind is kept (smallest hex distance, then smallest |dy|, then the first
 * in scan order). `hand` is always there.
 * @param {(q: number, y: number, r: number) => number} getBlock
 * @param {number} q
 * @param {number} y
 * @param {number} r
 * @returns {{ hand: true, stump?: [number, number, number], kiln?: [number, number, number],
 *   bloomery?: [number, number, number], forge?: [number, number, number] }}
 */
export function findStations(getBlock, q, y, r) {
  /** @type {*} */
  const out = { hand: true };
  /** @type {Record<string, number>} */
  const best = {};
  for (let dq = -STATION_RANGE; dq <= STATION_RANGE; dq++) {
    for (let dr = -STATION_RANGE; dr <= STATION_RANGE; dr++) {
      const d = hexLength(dq, dr);
      if (d > STATION_RANGE) continue;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= WORLD_HEIGHT) continue;
        const station = STATION_OF_BLOCK.get(getBlock(q + dq, yy, r + dr));
        if (station === undefined) continue;
        const score = d * 8 + Math.abs(dy);
        if (!(station in best) || score < best[station]) {
          best[station] = score;
          out[station] = [q + dq, yy, r + dr];
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The recipe table (§7.3): 37 at hand, 12 at the stump, 21 at the kiln, 4 at the bloomery and 15 at the forge; then the
// v0.10 circuit parts and their materials (DESIGN-circuits §8.2): 6 more at hand, 11 at the stump, 4 at the kiln, 1 at the
// bloomery and 3 at the forge (114 in all).
// ---------------------------------------------------------------------------------------------------------------------

/** "2 #knapstone + stick + 2 cord" → [{tag:'knapstone',n:2}, {k:'stick',n:1}, {k:'cord',n:2}]. */
function parseItems(text) {
  return text.split('+').map((part) => {
    const m = /^\s*(?:(\d+)\s+)?(#?)([a-z_]+)\s*$/.exec(part);
    if (!m) throw new Error(`crafting: bad item list "${text}"`);
    const n = m[1] === undefined ? 1 : Number(m[1]);
    return m[2] ? { tag: m[3], n } : { k: m[3], n };
  });
}

/** "hammer 1, crucible 0" → [{type:'hammer',tier:1}, {type:'crucible',tier:0}]; '' → []. */
function parseTools(text) {
  if (!text) return [];
  return text.split(',').map((part) => {
    const [type, tier] = part.trim().split(/\s+/);
    return { type, tier: Number(tier) };
  });
}

/** Metal tool amounts (§7.3): [tool, metal N, sticks S]. */
const METAL_TOOLS = Object.freeze([['knife', 1, 1], ['shovel', 1, 1], ['axe', 2, 1], ['hammer', 2, 1], ['pick', 2, 2], ['sword', 3, 1]]);

/** @returns {Array<[string, string, string, string, string, number]>} the metal tool rows of one station */
function metalToolRows(station, metal, ingot, tools, extra, toolsText, seconds) {
  return METAL_TOOLS.filter(([t]) => tools.includes(t)).map(([t, n, s]) => [
    `${metal}_${t}`, station, `${n} ${ingot} + ${s} stick + ${extra}`, `${metal}_${t}`, toolsText, seconds,
  ]);
}

/** [id, station, inputs, outputs, tools, seconds], in the order of §7.3. */
const RECIPE_ROWS = [
  // ---- Hand (37)
  ['cord', 'hand', '2 plant_fibre', 'cord', '', 1],
  ['stone_hammer', 'hand', 'rock', 'stone_hammer', '', 1],
  ['stone_axe', 'hand', '2 rock', 'stone_axe', 'hammer 1', 3],
  ['wooden_shovel', 'hand', 'stick', 'wooden_shovel', 'axe 1', 2],
  ['flint_knife', 'hand', '#knapstone + stick + cord', 'flint_knife', 'hammer 1', 3],
  ['flint_axe', 'hand', '#knapstone + stick + cord', 'flint_axe', 'hammer 1', 4],
  ['flint_pick', 'hand', '2 #knapstone + stick + 2 cord', 'flint_pick', 'hammer 1', 5],
  ['flint_shovel', 'hand', '#knapstone + stick + cord', 'flint_shovel', 'hammer 1', 4],
  ['flint_spear', 'hand', '#knapstone + 2 stick + cord', 'flint_spear', 'hammer 1', 3],
  ['flint_dart', 'hand', 'flint + stick + plant_fibre', '4 flint_dart', 'hammer 1', 2],
  ['fire_drill', 'hand', '2 stick + cord', 'fire_drill', '', 2],
  ['snare', 'hand', '2 cord + 3 stick', 'snare', '', 3], // v0.11 (CONTRACTS §69): a noose on a bent stick
  ['campfire', 'hand', '6 rock + 3 stick + #tinder', 'campfire', 'firestarter 0', 5],
  ['cobblestone', 'hand', '6 rock', 'cobblestone', '', 2],
  ['clay', 'hand', '6 clay_lump', 'clay', '', 2],
  ['greenware_pot', 'hand', '3 clay_lump', 'greenware_pot', '', 4],
  ['green_brick', 'hand', '3 clay_lump', '3 green_brick', '', 2],
  ['greenware_crucible', 'hand', '3 clay_lump', 'greenware_crucible', '', 4],
  ['greenware_mold', 'hand', '3 clay_lump', 'greenware_mold', '', 3],
  ['kiln', 'hand', '8 clay_lump + 6 rock', 'kiln', '', 8],
  ['work_stump', 'hand', '#log', 'work_stump', 'axe 1', 4],
  ['straw_hat', 'hand', '6 plant_fibre', 'straw_hat', '', 6],
  ['grass_cape', 'hand', '10 plant_fibre + 2 cord', 'grass_cape', '', 10],
  ['fibre_bandage', 'hand', '3 plant_fibre', 'fibre_bandage', '', 2],
  ['rag_bandage', 'hand', '2 grave_rag + pot_boiled', 'rag_bandage + clay_pot', '', 2], // a rag from a corpse is boiled first
  ['wicker_basket', 'hand', '6 stick + 12 plant_fibre', 'wicker_basket', '', 8],
  ['hay_bale', 'hand', '12 plant_fibre', 'hay_bale', '', 6],
  ['pot_snow', 'hand', 'clay_pot + 3 snow', 'pot_snow', '', 1],
  ['pot_snow_ice', 'hand', 'clay_pot + 2 ice_chunk', 'pot_snow', '', 1],
  ['scrape_salt', 'hand', 'salt_pot', 'salt + clay_pot', '', 1],
  ['salted_pork', 'hand', 'raw_pork + salt', 'salted_pork', '', 2],
  ['leached_acorns', 'hand', '6 acorns + pot_water', '6 leached_acorns + clay_pot', '', 2],
  ['peel_cactus_fruit', 'hand', 'unpeeled_cactus_fruit', 'cactus_fruit', 'knife 2', 1],
  ['pot_healwort_tea', 'hand', 'healwort + pot_boiled', 'pot_healwort_tea', '', 2], // v0.14 (§76 flora): steeped, not boiled
  ['snow_block', 'hand', '6 snow', 'snow_block', '', 1],
  ['ice', 'hand', '3 ice_chunk', 'ice', '', 1],
  ['coal_block', 'hand', '7 coal', 'coal_block', '', 2],
  ['bricks', 'hand', '6 fired_brick + clay_lump', 'bricks', '', 3],
  ['bloomery', 'hand', '18 fired_brick + 3 clay_lump + bellows', 'bloomery', '', 12],
  ['forge', 'hand', '24 fired_brick + 3 wrought_iron + bellows', 'forge', '', 15],
  // v0.10 circuits (DESIGN-circuits §8.2): the fuse, the torch (slow match is cord soaked in saltpetre), the braided wires
  // and the selenium panel
  ['powder_fuse', 'hand', 'black_powder + 3 cord', '6 powder_fuse', '', 4],
  ['torch', 'hand', '2 stick + 2 cord + saltpetre', 'torch', 'firestarter 0', 3],
  ['white_wire', 'hand', '6 copper_wire + 6 plant_fibre', '6 white_wire', '', 5],
  ['brown_wire', 'hand', '6 copper_wire + 6 plant_fibre + acorns', '6 brown_wire', '', 6], // an oak-tannin dyed braid
  ['earth_wire', 'hand', '6 copper_wire + 6 plant_fibre + malachite', '6 earth_wire', '', 6], // the green braid
  // v0.11 (CONTRACTS §67): the Workbench itself — steel, glass, drawn copper and tin: it comes after the Forge
  ['workbench', 'hand', '5 #planks + 2 steel_bar + 2 glass + 12 copper_wire + 2 tin_ingot', 'workbench', 'hammer 5', 20],
  // v0.14 (§76 fauna): what feathers are for — the Flint Dart with a feathered flight (faster, harder, tougher)
  ['fletched_dart', 'hand', 'flint + stick + 2 feather + plant_fibre', '4 fletched_dart', 'hammer 1', 3],
  // ---- Work Stump (12); riving a log into sticks is real work: there is no planks-to-sticks shortcut
  ['oak_planks', 'stump', 'oak_log', '3 oak_planks', 'axe 2', 3],
  ['spruce_planks', 'stump', 'spruce_log', '3 spruce_planks', 'axe 2', 3],
  ['birch_planks', 'stump', 'birch_log', '3 birch_planks', 'axe 2', 3],
  ['split_sticks', 'stump', '#log', '6 stick', 'axe 1', 3],
  ['leather', 'stump', 'rawhide + pig_fat', 'leather', 'knife 2', 8],
  ['leather_salt', 'stump', 'rawhide + salt', 'leather', 'knife 2', 8],
  ['leather_hood', 'stump', '2 leather + cord', 'leather_hood', 'knife 2', 6],
  ['leather_coat', 'stump', '5 leather + 2 cord', 'leather_coat', 'knife 2', 12],
  ['hide_shoes', 'stump', '2 leather + 2 plant_fibre + cord', 'hide_shoes', 'knife 2', 6],
  ['sleeping_hide', 'stump', '2 leather + 6 plant_fibre + 6 stick', 'sleeping_hide', 'knife 2', 8],
  ['bellows', 'stump', '3 leather + 3 #planks + cord', 'bellows', 'knife 2', 10],
  ['stone_bricks', 'stump', '6 rock', 'stone_bricks', 'hammer 3', 4],
  // v0.10 circuits (§8.2): black powder is ground damp in a mortar, which is why it cannot go off at the stump
  ['black_powder', 'stump', '6 saltpetre + sulfur + charcoal', '6 black_powder', 'hammer 1', 8],
  ['iron_filings', 'stump', 'wrought_iron', '6 iron_filings', 'hammer 4', 6],
  ['copper_wire', 'stump', 'copper_ingot', '3 copper_wire', 'hammer 3', 6], // hammered and drawn
  ['powder_keg', 'stump', '6 black_powder + 3 #planks + copper_ingot', 'powder_keg', 'axe 1, hammer 3', 8], // copper hoops
  ['terminal_board', 'stump', '#planks + 3 copper_wire + copper_ingot', 'terminal_board', 'knife 2', 6],
  ['voltaic_battery', 'stump', '6 copper_ingot + 6 tin_ingot + 6 plant_fibre + pot_seawater', 'voltaic_battery + clay_pot', 'hammer 3', 12],
  ['knife_switch', 'stump', '3 rock + copper_ingot + 2 copper_wire', 'knife_switch', 'hammer 3', 6], // a slate base
  ['push_button', 'stump', 'rock + bronze_ingot + 2 copper_wire', 'push_button', 'hammer 3', 5],
  // ---- Kiln (21; every recipe burns fuel — in the charcoal job the logs themselves smoulder)
  ['charcoal', 'kiln', '6 #log', '8 charcoal', '', 40],
  ['clay_pot', 'kiln', 'greenware_pot + #fuel', 'clay_pot', '', 15],
  ['fired_brick', 'kiln', '6 green_brick + #fuel', '6 fired_brick', '', 30],
  ['crucible', 'kiln', 'greenware_crucible + #fuel', 'crucible', '', 25],
  ['casting_mold', 'kiln', 'greenware_mold + #fuel', 'casting_mold', '', 20],
  // v0.14 (§77): smelting ore and melting metal burn COAL — charcoal fires clay but does not get a kiln hot enough for
  // ore, so coal (a flint pick's work) is the gate to the metal ages. Iron and steel still want charcoal (the forge).
  ['copper_ingot', 'kiln', '2 malachite + 2 coal', 'copper_ingot', '', 30],
  ['tin_ingot', 'kiln', '2 cassiterite + coal', 'tin_ingot', '', 20],
  ['bronze_ingot', 'kiln', '7 copper_ingot + tin_ingot + 3 coal', '8 bronze_ingot', 'crucible 0', 45], // 7 : 1, 12.5 % tin
  ['copper_block', 'kiln', '7 copper_ingot + coal', 'copper_block', 'crucible 0', 30],
  ['gold_block', 'kiln', '7 gold_nugget + 2 coal', 'gold_block', 'crucible 0', 40],
  // casting a tool remelts ingots, so it needs the crucible as well as the mold
  ...metalToolRows('kiln', 'copper', 'copper_ingot', ['knife', 'shovel', 'axe', 'hammer', 'pick'], 'coal', 'crucible 0, mold 0', 25),
  ...metalToolRows('kiln', 'bronze', 'bronze_ingot', ['knife', 'shovel', 'axe', 'hammer', 'pick', 'sword'], 'coal', 'crucible 0, mold 0', 30),
  // v0.10 circuits (§8.2): roasting pyrite drives sulfur off (FeS₂ → FeS + S); its residue held Berzelius's selenium (1817)
  ['sulfur', 'kiln', '3 pyrite + #fuel', '2 sulfur', '', 25],
  ['selenium', 'kiln', '6 pyrite + 2 #fuel', '3 sulfur + selenium', '', 40],
  ['carbon_filament', 'kiln', '3 plant_fibre + #fuel', '3 carbon_filament', '', 15], // Swan's carbonised thread
  // ---- Bloomery (4); salt is the flux that lets sand melt
  ['iron_bloom', 'bloomery', '3 hematite + 4 charcoal', 'iron_bloom', '', 40],
  ['wrought_iron', 'bloomery', 'iron_bloom + charcoal', 'wrought_iron', 'hammer 4', 25],
  ['glass', 'bloomery', '2 #sand + salt + charcoal', 'glass', '', 25],
  ['remelt_glass', 'bloomery', '3 glass_shards + charcoal', 'glass', '', 15],
  // v0.10 circuits (§8.2): the lamp's glass is sealed hot
  ['filament_lamp', 'bloomery', 'glass + 3 carbon_filament + copper_wire + #planks', 'filament_lamp', '', 20],
  // ---- Forge (15; charcoal only: carbon matters for iron)
  ...metalToolRows('forge', 'iron', 'wrought_iron', ['knife', 'shovel', 'axe', 'hammer', 'pick', 'sword'], 'charcoal', 'hammer 4', 30),
  ['steel_bar', 'forge', 'wrought_iron + 2 charcoal', 'steel_bar', 'hammer 5', 45],
  ...metalToolRows('forge', 'steel', 'steel_bar', ['knife', 'shovel', 'axe', 'hammer', 'pick', 'sword'], 'charcoal', 'hammer 5', 40),
  ['iron_block', 'forge', '7 wrought_iron', 'iron_block', 'hammer 4', 20],
  ['diamond_block', 'forge', '7 rough_gem', 'diamond_block', 'hammer 6', 20],
  // v0.10 circuits (§8.2): the magneto, the clock spring and the bell's gong are steel. The Collapsar Charge has no recipe:
  // nothing real makes one
  // ---- Workbench (v0.11, CONTRACTS §67): the advanced devices, each built on the elementary parts made at the stump
  ['relay', 'workbench', 'knife_switch + wrought_iron + 6 copper_wire', 'relay', 'hammer 4', 10],
  ['selenium_panel', 'workbench', 'terminal_board + selenium + glass + 3 copper_wire', 'selenium_panel', '', 8],
  ['igniter', 'workbench', 'terminal_board + carbon_filament + 2 copper_wire + fired_brick', 'igniter', '', 15], // a bridgewire
  ['clockwork_timer', 'workbench', 'terminal_board + steel_bar + 3 bronze_ingot + glass', 'clockwork_timer', 'hammer 5', 30],
  ['electric_bell', 'workbench', 'push_button + relay + steel_bar', 'electric_bell', 'hammer 4', 15],
  ['blasting_machine', 'workbench', 'push_button + terminal_board + 2 steel_bar + 12 copper_wire', 'blasting_machine', 'hammer 5', 30],
  ['spark_transmitter', 'workbench', 'push_button + relay + voltaic_battery + 12 copper_wire + 2 bronze_ingot', 'spark_transmitter', 'hammer 3', 15],
  ['coherer_receiver', 'workbench', 'relay + terminal_board + glass + 6 iron_filings', 'coherer_receiver', 'hammer 3', 12],
];

/** @returns {Recipe} a checked, frozen recipe (throws on a typo, so a bad table fails at import) */
function makeRecipe([id, station, inputs, outputs, tools, seconds]) {
  /** @type {Recipe} */
  const rec = { id, station, inputs: parseItems(inputs), outputs: parseItems(outputs), tools: parseTools(tools), seconds };
  if (!STATION_IDS.includes(station)) throw new Error(`crafting: recipe ${id} has an unknown station ${station}`);
  for (const inp of rec.inputs) {
    if ('tag' in inp ? !Object.hasOwn(TAGS, inp.tag) : !isItemKey(inp.k)) throw new Error(`crafting: recipe ${id} has an unknown input`);
  }
  for (const out of rec.outputs) {
    if (!('k' in out) || !isItemKey(out.k)) throw new Error(`crafting: recipe ${id} has an unknown output`);
  }
  for (const t of rec.tools) {
    if (!TOOL_TYPES.includes(t.type) || !Number.isInteger(t.tier)) throw new Error(`crafting: recipe ${id} has a bad tool`);
  }
  for (const part of [rec.inputs, rec.outputs, rec.tools]) for (const o of part) Object.freeze(o);
  Object.freeze(rec.inputs);
  Object.freeze(rec.outputs);
  Object.freeze(rec.tools);
  return Object.freeze(rec);
}

/** Every recipe, in table order (hand, stump, kiln, bloomery, forge). @type {readonly Recipe[]} */
export const RECIPES = Object.freeze(RECIPE_ROWS.map(makeRecipe));

/** @type {Map<string, Recipe>} */
const RECIPE_BY_ID = new Map();
/** @type {Map<string, number>} recipe id → its index in RECIPES (the list's last sort key) */
const RECIPE_ORDER = new Map();
RECIPES.forEach((rec, i) => {
  if (RECIPE_BY_ID.has(rec.id)) throw new Error(`crafting: duplicate recipe id ${rec.id}`);
  RECIPE_BY_ID.set(rec.id, rec);
  RECIPE_ORDER.set(rec.id, i);
});

/** @param {string} id @returns {Recipe|null} */
export function getRecipe(id) {
  return (typeof id === 'string' && RECIPE_BY_ID.get(id)) || null;
}

/** @param {Recipe} rec @returns {string} what the job is called: its first output's display name ("Copper Ingot") */
export function recipeName(rec) {
  return itemName(rec.outputs[0].k);
}

/** Every exact key a recipe input can draw on: the exact inputs and every tag member (the reservation's counters). */
const INPUT_KEYS = Object.freeze([...new Set(RECIPES.flatMap((rec) => rec.inputs.flatMap((i) => ('tag' in i ? TAGS[i.tag] : [i.k]))))]);

// ---------------------------------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------------------------------

/** How a `#tag` input is written in the recipe list and in messages. */
export const TAG_LABELS = Object.freeze({
  log: 'Any Log',
  planks: 'Any Planks',
  fuel: 'Fuel',
  tinder: 'Tinder',
  knapstone: 'Knapping Stone',
  sand: 'Any Sand',
});

/** Tier-0 kit is named by its item, not "a hand crucible". */
const KIT_LABELS = Object.freeze({ firestarter: 'fire drill', crucible: 'crucible', mold: 'casting mold' });

/** @param {KeyInput|TagInput} inp @returns {string} "Plant Fibre", "Fuel", … */
export function inputLabel(inp) {
  return 'tag' in inp ? TAG_LABELS[inp.tag] ?? `#${inp.tag}` : itemName(inp.k);
}

/** "a stone hammer or better", "an iron hammer or better". @param {string} label a toolLabel */
export function withArticle(label) {
  return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`;
}

/**
 * @param {string} type @param {number} tier
 * @returns {string} "flint knife or better", "steel hammer" (nothing is better), "fire drill" (tier-0 kit)
 */
export function toolLabel(type, tier) {
  if (Object.hasOwn(KIT_LABELS, type) && tier <= 0) return KIT_LABELS[type];
  const t = Math.max(0, Math.min(TIER_NAMES.length - 1, tier));
  return `${TIER_NAMES[t]} ${type}${t < TIER_NAMES.length - 1 ? ' or better' : ''}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reservation: exact keys for every job first, then tags from what remains (members in TAGS order)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The pack's count of every key the recipe inputs can draw on.
 * @param {PackOps} pack
 * @returns {Map<string, number>}
 */
function packCounts(pack) {
  /** @type {Map<string, number>} */
  const avail = new Map();
  for (const k of INPUT_KEYS) {
    const n = Number(pack.count(k));
    avail.set(k, Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  }
  return avail;
}

/**
 * Allocate the inputs of `list` (in order) from `avail` (mutated): first the exact keys of EVERY recipe, then the tags of
 * every recipe from what remains, each tag taking its members in TAGS order. A recipe that falls short takes what there is.
 * @param {readonly Recipe[]} list
 * @param {Map<string, number>} avail
 * @returns {{ short: number[], takes: [string, number][] }[]}   per recipe: the shortfall per input, what it takes
 */
function allocate(list, avail) {
  const res = list.map((rec) => ({ short: rec.inputs.map(() => 0), takes: /** @type {[string, number][]} */ ([]) }));
  const takeFrom = (j, k, want) => {
    const have = avail.get(k) ?? 0;
    const t = Math.min(have, want);
    if (t > 0) {
      avail.set(k, have - t);
      res[j].takes.push([k, t]);
    }
    return t;
  };
  list.forEach((rec, j) => rec.inputs.forEach((inp, i) => {
    if ('k' in inp) res[j].short[i] = inp.n - takeFrom(j, inp.k, inp.n);
  }));
  list.forEach((rec, j) => rec.inputs.forEach((inp, i) => {
    if (!('tag' in inp)) return;
    let need = inp.n;
    for (const m of TAGS[inp.tag]) if (need > 0) need -= takeFrom(j, m, need);
    res[j].short[i] = need;
  }));
  return res;
}

/** @returns {string[]} the labels of every input that falls short, each once, in recipe order */
function shortLabels(list, alloc) {
  const out = new Set();
  list.forEach((rec, j) => rec.inputs.forEach((inp, i) => {
    if (alloc[j].short[i] > 0) out.add(inputLabel(inp));
  }));
  return [...out];
}

/** @returns {string[]} labels of the recipe's tools the pack lacks */
function missingTools(rec, pack) {
  return rec.tools.filter((t) => !pack.hasTool(t.type, t.tier)).map((t) => toolLabel(t.type, t.tier));
}

/** @returns {boolean} `p` is a cell [q, y, r] of integers */
function isCell(p) {
  return Array.isArray(p) && p.length === 3 && p.every((v) => Number.isInteger(v));
}

// ---------------------------------------------------------------------------------------------------------------------
// The recipe list
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One recipe as the Making panel shows it (§9.8).
 * @typedef {Object} RecipeView
 * @property {string} id
 * @property {string} station
 * @property {{k: string, n: number}} out          the main output (outputs[0])
 * @property {{k: string, n: number}[]} outputs    every output
 * @property {{k?: string, tag?: string, label: string, need: number, have: number}[]} inputs
 *   `have`: what the pack holds of it (a tag: of all its members), less what the queued jobs reserve
 * @property {{type: string, tier: number, label: string, ok: boolean}[]} tools
 * @property {number} seconds
 * @property {boolean} craftable   the station is near, the inputs (after the queue's reservations) and the tools are there
 * @property {boolean} stationOk   the station is near (hands always are)
 * @property {number} missing      input units still missing (the second sort key)
 * @property {string} hint         '' or "build a Kiln nearby" when the station is not near
 * @property {string} purpose      one line on what the output is for, '' when purpose.js has none (CONTRACTS §77)
 */

/**
 * The recipe list, sorted: craftable now first, then by the number of missing input units, then in recipe order.
 * Recipes for a station that is not near stay listed (greyed, with `hint`): the list doubles as the tech tree.
 * @param {PackOps} pack
 * @param {{ stump?: unknown, kiln?: unknown, bloomery?: unknown, forge?: unknown }|null} stations   a findStations result
 * @param {{ station?: string, queue?: CraftQueue|null }} [opts]   `station`: only that station's recipes ('all' or
 *   absent: every recipe); `queue`: the inputs its jobs reserve are not available to the list
 * @returns {RecipeView[]}
 */
export function listRecipes(pack, stations, opts = {}) {
  const tab = opts && typeof opts.station === 'string' ? opts.station : 'all';
  const avail = packCounts(pack);
  if (opts && opts.queue) {
    const queued = opts.queue.jobs().map((j) => j.recipe);
    allocate(queued, avail);
  }
  /** @type {RecipeView[]} */
  const views = [];
  for (const rec of RECIPES) {
    if (tab !== 'all' && rec.station !== tab) continue;
    const stationOk = rec.station === 'hand' || isCell(stations && /** @type {*} */ (stations)[rec.station]);
    const inputs = rec.inputs.map((inp) => {
      const have = 'tag' in inp ? TAGS[inp.tag].reduce((s, m) => s + (avail.get(m) ?? 0), 0) : avail.get(inp.k) ?? 0;
      return 'tag' in inp
        ? { tag: inp.tag, label: inputLabel(inp), need: inp.n, have }
        : { k: inp.k, label: inputLabel(inp), need: inp.n, have };
    });
    const [alloc] = allocate([rec], new Map(avail));
    const missing = alloc.short.reduce((s, v) => s + v, 0);
    const tools = rec.tools.map((t) => ({ type: t.type, tier: t.tier, label: toolLabel(t.type, t.tier), ok: Boolean(pack.hasTool(t.type, t.tier)) }));
    views.push({
      id: rec.id,
      station: rec.station,
      out: { ...rec.outputs[0] },
      outputs: rec.outputs.map((o) => ({ ...o })),
      inputs,
      tools,
      seconds: rec.seconds,
      craftable: stationOk && missing === 0 && tools.every((t) => t.ok),
      stationOk,
      missing,
      hint: stationOk ? '' : `build a ${STATION_NAMES[rec.station]} nearby`,
      // §77: what the thing is for, one line ('' when purpose.js says nothing about it)
      purpose: purposeOf(rec.outputs[0].k),
    });
  }
  views.sort((a, b) => (Number(b.craftable) - Number(a.craftable)) || (a.missing - b.missing)
    || (/** @type {number} */ (RECIPE_ORDER.get(a.id)) - /** @type {number} */ (RECIPE_ORDER.get(b.id))));
  return views;
}

// ---------------------------------------------------------------------------------------------------------------------
// The lanes
// ---------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} CraftJob
 * @property {number} seq          queue order across every lane (the reservation order)
 * @property {Recipe} recipe
 * @property {string} station
 * @property {[number, number, number]|null} at   the station's cell when it was queued (hand jobs: null)
 * @property {number} t            seconds worked
 * @property {string} reason       '' while it runs (or has not started); why it waits ("Kiln too far", "Pack full")
 * @property {string} shown        internal: what the UI last saw (version bumps only when it changes)
 */

/**
 * What one `step` did. `messages` are the chat lines for the failed jobs; `broke` lists tools that broke (main says
 * "Your Flint Axe broke." and plays the snap); `done` drives `audio.playCraft()`; `lost` is anything `give` could not place.
 * @typedef {Object} CraftEvents
 * @property {{ station: string, id: string, outputs: {k: string, n: number}[] }[]} done
 * @property {{ station: string, id: string, message: string }[]} failed
 * @property {string[]} broke
 * @property {{k: string, n: number}[]} lost
 * @property {string[]} messages
 */

/** One lane per station; each lane's head job runs alongside the others (§7.2). */
export class CraftQueue {
  constructor() {
    /** @type {Map<string, CraftJob[]>} */
    this._lanes = new Map(STATION_IDS.map((s) => [s, []]));
    this._seq = 0;
    /** bumped whenever what the pack screen or the job chip shows changes */
    this.version = 0;
  }

  /** @returns {number} jobs across all lanes */
  get size() {
    let n = 0;
    for (const lane of this._lanes.values()) n += lane.length;
    return n;
  }

  /** @returns {CraftJob[]} every job in queue order (the order inputs are reserved in) */
  jobs() {
    const all = [];
    for (const lane of this._lanes.values()) all.push(...lane);
    return all.sort((a, b) => a.seq - b.seq);
  }

  /**
   * Queue `times` jobs of a recipe (the ×5 button passes 5; as many as fit are queued). Each job needs: its station near
   * (`stations`, a findStations result; the job remembers that cell), room under MAX_CRAFT_JOBS, the required tools in
   * the pack, and the inputs of EVERY queued job in every lane plus this one (exact keys first, then tags).
   * @param {string} recipeId
   * @param {number} times
   * @param {PackOps} pack
   * @param {Record<string, unknown>|null} stations
   * @returns {{ ok: boolean, message: string, queued: number }}
   */
  enqueue(recipeId, times, pack, stations) {
    const rec = getRecipe(recipeId);
    if (!rec) return { ok: false, message: `unknown recipe "${recipeId}"`, queued: 0 };
    const name = recipeName(rec);
    const want = Math.max(1, Math.min(MAX_CRAFT_JOBS, Number.isFinite(times) ? Math.floor(times) : 1));
    /** @type {[number, number, number]|null} */
    let at = null;
    if (rec.station !== 'hand') {
      const pos = stations ? stations[rec.station] : null;
      if (!isCell(pos)) return { ok: false, message: `Can't make ${name}: build a ${STATION_NAMES[rec.station]} nearby`, queued: 0 };
      at = /** @type {[number, number, number]} */ ([.../** @type {number[]} */ (pos)]);
    }
    let queued = 0;
    let reason = '';
    while (queued < want) {
      if (this.size >= MAX_CRAFT_JOBS) {
        reason = `the lanes are full (${MAX_CRAFT_JOBS} jobs)`;
        break;
      }
      const tools = missingTools(rec, pack);
      if (tools.length) {
        reason = `needs ${tools.map(withArticle).join(' and ')}`;
        break;
      }
      const list = [...this.jobs().map((j) => j.recipe), rec];
      const alloc = allocate(list, packCounts(pack));
      const short = shortLabels(list, alloc);
      if (short.length) {
        reason = `missing ${short.join(', ')}`;
        break;
      }
      const lane = /** @type {CraftJob[]} */ (this._lanes.get(rec.station));
      lane.push({ seq: ++this._seq, recipe: rec, station: rec.station, at: at && [at[0], at[1], at[2]], t: 0, reason: '', shown: '' });
      queued++;
    }
    if (queued === 0) return { ok: false, message: `Can't make ${name}: ${reason}`, queued: 0 };
    this.version++;
    const what = queued === 1 ? name : `${queued} × ${name}`;
    return { ok: true, message: queued < want ? `Making ${what}; no more: ${reason}` : `Making ${what}`, queued };
  }

  /**
   * Advance every lane by dt (call only while Survival is active). A lane's head job works while its station cell still
   * holds the station block (`stationCheck`, e.g. world.peekBlock: UNLOADED or a non-integer reads as "not loaded") and
   * lies within hex distance STATION_WORK_RANGE of the player's feet column, at any height; otherwise it waits
   * ("Kiln too far"). Hand jobs never wait for range. A station whose block is gone fails its job. When a job's time is up
   * it completes atomically: it waits while the pack cannot take the outputs ("Pack full"), fails when inputs or tools are
   * missing, else takes the inputs, wears each tool once and gives the outputs. Time left over flows into the next job.
   * CONTRACT-ISSUE: DESIGN-survival §9.5 calls the third argument `stationsByLane`, §10 C `stationCheck`; a findStations
   * result only covers STATION_RANGE (3), not the 16-cell work range, so this takes a block reader (main: world.peekBlock).
   * @param {number} dt
   * @param {PackOps} pack
   * @param {((q: number, y: number, r: number) => number)|null} stationCheck
   * @param {[number, number, number]|null} playerCell   the feet cell [q, y, r]
   * @returns {CraftEvents}
   */
  step(dt, pack, stationCheck, playerCell) {
    /** @type {CraftEvents} */
    const ev = { done: [], failed: [], broke: [], lost: [], messages: [] };
    const span = Number.isFinite(dt) && dt > 0 ? dt : 0;
    for (const [station, lane] of this._lanes) {
      let left = span;
      while (lane.length > 0) {
        const job = lane[0];
        if (job.at) {
          const [sq, sy, sr] = job.at;
          const near = isCell(playerCell) && hexDistance(sq, sr, playerCell[0], playerCell[2]) <= STATION_WORK_RANGE;
          const id = near ? (stationCheck ? stationCheck(sq, sy, sr) : STATION_BLOCKS[station]) : UNLOADED;
          if (!near || id === UNLOADED || !Number.isInteger(id)) {
            this._show(job, `${STATION_NAMES[station]} too far`);
            break;
          }
          if (id !== STATION_BLOCKS[station]) {
            this._fail(lane, ev, `the ${STATION_NAMES[station]} is gone`);
            continue;
          }
        }
        const need = job.recipe.seconds - job.t;
        if (need > left) {
          job.t += left;
          this._show(job, '');
          break;
        }
        job.t = job.recipe.seconds;
        left -= Math.max(0, need);
        const res = this._complete(job, pack, ev);
        if (res === 'wait') {
          this._show(job, 'Pack full');
          break;
        }
        if (res === 'failed') continue;
        lane.shift();
        this.version++;
      }
    }
    return ev;
  }

  /** Drop the lane's head job with "Couldn't make X: <why>." */
  _fail(lane, ev, why) {
    const job = /** @type {CraftJob} */ (lane.shift());
    const message = `Couldn't make ${recipeName(job.recipe)}: ${why}.`;
    ev.failed.push({ station: job.station, id: job.recipe.id, message });
    ev.messages.push(message);
    this.version++;
  }

  /** @returns {'done'|'wait'|'failed'} */
  _complete(job, pack, ev) {
    const rec = job.recipe;
    // Take what the queue-wide reservation gives this job, so a tag input never eats an exact key that a job queued later
    // reserved (7 coal for a Coal Block, while a kiln job's #fuel takes the charcoal); when the pack changed so much that
    // the whole queue no longer fits, the job takes what it alone can.
    const all = this.jobs();
    const joint = allocate(all.map((j) => j.recipe), packCounts(pack))[all.indexOf(job)];
    const alloc = joint && joint.short.every((v) => v === 0) ? joint : allocate([rec], packCounts(pack))[0];
    const outputs = rec.outputs.map((o) => ({ k: o.k, n: o.n }));
    // "Pack full" is judged on the pack as it will be once the inputs are taken, so a recipe that gives back the slot it
    // empties (scrape_salt: Salt-crusted Pot → Salt + Clay Pot) completes in a full pack (play-test).
    const fits = typeof pack.canExchange === 'function' ? pack.canExchange(alloc.takes, outputs) : pack.canGive(outputs);
    if (!fits) return 'wait';
    const missing = shortLabels([rec], [alloc]).concat(missingTools(rec, pack).map(withArticle));
    if (missing.length) {
      this._fail(/** @type {CraftJob[]} */ (this._lanes.get(job.station)), ev, `missing ${missing.join(', ')}`);
      return 'failed';
    }
    for (const [k, n] of alloc.takes) pack.take(k, n);
    for (const t of rec.tools) {
      const used = pack.useTool(t.type, t.tier);
      if (used && used.broke) ev.broke.push(used.key);
    }
    for (const o of rec.outputs) {
      const left = Number(pack.give(o.k, o.n)) || 0;
      if (left > 0) ev.lost.push({ k: o.k, n: left });
    }
    ev.done.push({ station: job.station, id: rec.id, outputs: rec.outputs.map((o) => ({ ...o })) });
    return 'done';
  }

  /** Record what the job shows now (waiting reason, whole seconds left, progress in 5 % steps); bump version on change. */
  _show(job, reason) {
    job.reason = reason;
    const left = Math.max(0, job.recipe.seconds - job.t);
    const shown = `${reason}|${Math.ceil(left)}|${Math.floor((job.t / job.recipe.seconds) * 20)}`;
    if (shown !== job.shown) {
      job.shown = shown;
      this.version++;
    }
  }

  /**
   * Remove job `i` of a lane (nothing to refund: inputs are only taken on completion).
   * @param {string} lane  station id
   * @param {number} i
   * @returns {boolean} a job was removed
   */
  cancel(lane, i) {
    const jobs = this._lanes.get(lane);
    if (!jobs || !Number.isInteger(i) || i < 0 || i >= jobs.length) return false;
    jobs.splice(i, 1);
    this.version++;
    return true;
  }

  /**
   * The busy lanes, in station order, for the pack screen.
   * @returns {{ station: string, label: string, jobs: { id: string, name: string, progress: number, secondsLeft: number,
   *   waiting: boolean, reason: string }[] }[]}
   */
  lanes() {
    const out = [];
    for (const [station, lane] of this._lanes) {
      if (lane.length === 0) continue;
      out.push({
        station,
        label: STATION_NAMES[station],
        jobs: lane.map((job) => ({
          id: job.recipe.id,
          name: recipeName(job.recipe),
          progress: Math.min(1, job.t / job.recipe.seconds),
          secondsLeft: Math.max(0, job.recipe.seconds - job.t),
          waiting: job.reason !== '',
          reason: job.reason,
        })),
      });
    }
    return out;
  }

  /**
   * The HUD job chip: the running head job that finishes soonest ("Kiln · Copper Ingot 12 s"), else the first waiting
   * one ("Kiln · Charcoal · Kiln too far"), with " +2" when two more lanes are busy. null when every lane is empty.
   * @returns {string|null}
   */
  chipText() {
    let best = null;
    let bestLeft = Infinity;
    let busy = 0;
    for (const [station, lane] of this._lanes) {
      if (lane.length === 0) continue;
      busy++;
      const job = lane[0];
      const left = job.reason ? Infinity : Math.max(0, job.recipe.seconds - job.t);
      if (best === null || left < bestLeft) {
        best = { station, job };
        bestLeft = left;
      }
    }
    if (best === null) return null;
    const { station, job } = best;
    const head = `${STATION_NAMES[station]} · ${recipeName(job.recipe)}`;
    const text = job.reason ? `${head} · ${job.reason}` : `${head} ${Math.ceil(bestLeft)} s`;
    return busy > 1 ? `${text} +${busy - 1}` : text;
  }

  /** Drop every job (a reload, a death, a mode switch). */
  clear() {
    if (this.size === 0) return;
    for (const lane of this._lanes.values()) lane.length = 0;
    this.version++;
  }
}
