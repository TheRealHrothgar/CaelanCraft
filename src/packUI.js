// Caelancraft — the Pack & Making screen (E in Survival): the pack's rosette, the zig-zag hotbar strip, the wear chain, the
// discard hex, a basket's rosette, and the Making panel (station tabs, a search box, recipe cards as mini rosettes, the
// lanes) with its BUILD TREE (§94: buildTree.js, drawn over the screen: what to gather and build to reach each workplace).
// See docs/DESIGN-survival.md §5.4 and §9.8 ("packUI.js"); CONTRACTS §48 once merged.
//
// DOM module (+ pure geometry and label helpers, tested). Imports: config, items, itemIcons (the §9.1 import graph).
// Clicks are forwarded raw through the callbacks: ALL item logic lives in main, survivalControl and inventory.js
// (slotClick). This module only draws the view it is given (survivalControl.buildPackView) and reports what was clicked.
//
// Geometry: the pack screen uses FLAT-top hexes, so a hex chain runs straight down (the wear chain) and a row of cells
// zig-zags half a cell up and down (the hotbar strip, §5.4). Axial (q, r) → pixel: x = 1.5·s·q, y = √3·s·(r + q/2).
import { PACK_SLOTS, HOTBAR_SIZE, WEAR_SLOTS } from './config.js';
import { ITEMS, ITEM_KEYS, TAGS, itemName, maxDurability, stackSize, WEAR_SLOT_NAMES } from './items.js';
import { purposeOf } from './purpose.js';
import {
  buildTreeModel, layoutTree, treeStates, columnProgress, revealTree, revealedTree, placeId,
} from './buildTree.js';

/** The Survival Handbook's item key (§14; handbook.js HANDBOOK_KEY): right-click on it, or "Read", fires onRead. */
const HANDBOOK_ITEM = 'handbook';

/** @typedef {import('./types.js').ItemStack} ItemStack */
/** @typedef {import('./itemIcons.js').ItemIcons} ItemIcons */

/**
 * One recipe as crafting.listRecipes describes it (§9.8).
 * @typedef {Object} RecipeView
 * @property {string} id
 * @property {string} station  'hand' | 'stump' | 'kiln' | 'bloomery' | 'forge' | 'workbench' | 'lab'
 * @property {{k: string, n: number}} out
 * @property {Array<{k?: string, tag?: string, label: string, need: number, have: number}>} inputs
 * @property {Array<{type: string, tier: number, label: string, ok: boolean}>} tools
 * @property {number} seconds
 * @property {boolean} craftable
 * @property {boolean} stationOk
 * @property {string} [purpose]  one line on what the output is for ('' or absent: none; CONTRACTS §77)
 */

/**
 * What the screen shows (built by survivalControl.buildPackView).
 * @typedef {Object} PackView
 * @property {(ItemStack|null)[]} slots      PACK_SLOTS: 0–8 the hotbar strip, 9–26 the rosette
 * @property {(ItemStack|null)[]} wear       WEAR_SLOTS: head, body, feet
 * @property {number} selected               the selected hotbar slot
 * @property {ItemStack|null} cursor         the stack on the mouse
 * @property {{area: string, index: number}|null} [hover]   a hover to show when the mouse is over no cell
 * @property {{title: string, slots: (ItemStack|null)[]}|null} container   an open basket (replaces the Making panel)
 * @property {Array<{id: string, label: string, near: boolean}>} stations
 * @property {string} tab                    'all' or a station id
 * @property {RecipeView[]} recipes
 * @property {Array<{station: string, jobs: Array<{name: string, progress: number, waiting: boolean|string}>}>} lanes
 * @property {{text: string, error?: boolean}|null} [message]  the screen's own feedback line (.pack-message under the
 *   hotbar strip): the Handbook's refusal, a Make result — the HUD's target hint is not drawn while the pack is open
 * @property {string[]} [ready]  the ids of every recipe (whatever the tab) that could be started now (§94: the build tree)
 * @property {string[]} [had]    (§94.4) every item key that has ever entered the pack in this world (survival.had): the build
 *   tree shows what has been had, what could be made now and what is one step on (absent: only what is carried counts)
 * @property {boolean} [circuits]  (§94.4) the world's circuits switch (absent: on); off, the tree has no circuits and no Lab
 */

/**
 * @typedef {Object} PackUICallbacks  All optional.
 * @property {(area: 'pack'|'wear'|'container', index: number, button: 0|2, shift: boolean) => void} [onSlot]
 * @property {() => void} [onDiscard]
 * @property {(recipeId: string, times: number) => void} [onMake]
 * @property {(lane: string, i: number) => void} [onCancelJob]
 * @property {(tab: string) => void} [onTab]   a station id or 'all'
 * @property {() => void} [onClose]           Esc, E or the close hex
 * @property {() => void} [onRead]            §14: right-click on the handbook's slot (empty cursor) or the "Read" button
 *   beside the Pack heading: main closes the pack and opens the field book
 */

// ---- geometry (pure) -----------------------------------------------------------------------------------------------

/** Axial directions of a flat-top hex grid, named by where they point on screen. */
const DIR = Object.freeze({ N: [0, -1], NE: [1, -1], SE: [1, 0], S: [0, 1], SW: [-1, 1], NW: [-1, 0] });
/** Walking a ring clockwise from its top cell (the N corner): along these, k steps each. */
const RING_WALK = [DIR.SE, DIR.S, DIR.SW, DIR.NW, DIR.N, DIR.NE];

/**
 * The cells of a rosette around a centre hex, centre excluded: ring 1 (6 cells), then ring 2 (12), …, each clockwise from
 * the top (§5.4). Pure.
 * @param {number} rings
 * @returns {Array<[number, number]>} axial [q, r]
 */
export function rosetteCells(rings) {
  /** @type {Array<[number, number]>} */
  const out = [];
  const n = Math.max(0, Math.floor(Number(rings) || 0));
  for (let k = 1; k <= n; k++) {
    let q = 0;
    let r = -k;
    for (const [dq, dr] of RING_WALK) {
      for (let i = 0; i < k; i++) {
        out.push([q, r]);
        q += dq;
        r += dr;
      }
    }
  }
  return out;
}

/** How many rings a rosette needs for `slots` cells (6, 18, 36, …). @param {number} slots */
export function ringsFor(slots) {
  let k = 0;
  while (3 * k * (k + 1) < slots) k++;
  return k;
}

/** Flat-top axial → pixel centre for cell circumradius s. @returns {[number, number]} */
export function hexToPixel(q, r, s) {
  return [1.5 * s * q, Math.sqrt(3) * s * (r + q / 2)];
}

/**
 * The hotbar strip's cells: `n` flat-top hexes side by side, every other one half a cell lower (a zig-zag). Pixel centres
 * relative to the first cell. Pure.
 * @param {number} n @param {number} s
 * @returns {Array<[number, number]>}
 */
export function stripCells(n, s) {
  /** @type {Array<[number, number]>} */
  const out = [];
  for (let i = 0; i < n; i++) out.push([1.5 * s * i, (i & 1) ? (Math.sqrt(3) * s) / 2 : 0]);
  return out;
}

// ---- labels (pure) -------------------------------------------------------------------------------------------------

/** Station tabs: id and label, in order. */
export const STATION_TABS = Object.freeze([
  Object.freeze(['all', 'All']), Object.freeze(['hand', 'Hands']), Object.freeze(['stump', 'Stump']),
  Object.freeze(['kiln', 'Kiln']), Object.freeze(['bloomery', 'Bloomery']), Object.freeze(['forge', 'Forge']),
  Object.freeze(['workbench', 'Bench']), Object.freeze(['lab', 'Lab']),
]);
/** Full names of the workplaces (§7.1), for hints and lane rows. */
export const STATION_NAMES = Object.freeze({ hand: 'Hands', stump: 'Work Stump', kiln: 'Kiln', bloomery: 'Bloomery', forge: 'Forge', workbench: 'Workbench', lab: 'Lab' });

/** @param {string} id @returns {string} the tab label ('All', 'Hands', 'Stump', …); unknown ids as given */
export function tabLabel(id) {
  const t = STATION_TABS.find(([k]) => k === id);
  return t ? t[1] : String(id);
}

/** @param {string} station @returns {string} 'Hands', 'Work Stump', 'Kiln', … */
export function stationName(station) {
  return Object.hasOwn(STATION_NAMES, station) ? STATION_NAMES[station] : String(station);
}

/**
 * The hint on a recipe whose workplace is not near (§7.2): "build a Kiln nearby" ('' for hand recipes).
 * @param {string} station
 */
export function stationHint(station) {
  if (station === 'hand') return '';
  return `build a ${stationName(station)} nearby`;
}

/**
 * Seconds for people: "3 s", "45 s", "1:05", "20:00".
 * @param {number} s
 */
export function formatSeconds(s) {
  const v = Math.max(0, Math.ceil((Number(s) || 0) - 1e-9));
  if (v < 60) return `${v} s`;
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

/** An input's "have/need" (have capped at 999). @param {number} have @param {number} need */
export function haveNeedText(have, need) {
  return `${Math.min(999, Math.max(0, Math.floor(Number(have) || 0)))}/${Math.max(0, Math.floor(Number(need) || 0))}`;
}

/** @param {number} have @param {number} need @returns {'ok'|'short'} green or red */
export function haveNeedLevel(have, need) {
  return (Number(have) || 0) >= (Number(need) || 0) ? 'ok' : 'short';
}

/** A slot's count: the number when more than one, else ''. @param {ItemStack|null|undefined} stack */
export function countLabel(stack) {
  return stack && stack.n > 1 ? String(stack.n) : '';
}

/**
 * Durability for people: "45/90" for a tool (a new one shows full), '' for an item that never wears.
 * @param {ItemStack|null|undefined} stack
 */
export function durabilityText(stack) {
  if (!stack) return '';
  const max = maxDurability(stack.k);
  if (!(max > 0)) return '';
  const d = stack.d === undefined || stack.d === null ? max : Math.max(0, Math.min(max, Math.floor(stack.d)));
  return `${d}/${max}`;
}

/** Durability left as a fraction; null when the stack shows no wear (empty, never wears, or new). */
export function wearFraction(stack) {
  if (!stack || stack.d === undefined || stack.d === null) return null;
  const max = maxDurability(stack.k);
  return max > 0 ? Math.max(0, Math.min(1, stack.d / max)) : null;
}

/**
 * The info line under the rosette for the hovered (or cursor) stack: "Rock ×12", "Flint Axe · 45/90", "Pot of Water".
 * @param {ItemStack|null|undefined} stack
 */
export function stackTitle(stack) {
  if (!stack) return '';
  const dur = durabilityText(stack);
  return `${itemName(stack.k)}${stack.n > 1 ? ` ×${stack.n}` : ''}${dur ? ` · ${dur}` : ''}`;
}

/** A recipe card's title: the output's name, "×n" when it makes more than one. @param {{k: string, n: number}} out */
export function recipeTitle(out) {
  if (!out) return '';
  return `${itemName(out.k)}${out.n > 1 ? ` ×${out.n}` : ''}`;
}

/** How many the second Make button queues (×5). */
export const MAKE_MANY = 5;

/**
 * §99: whether a recipe card offers ×5 — only when what it makes stacks in the pack. A tool, the hammerstone, the bellows
 * and anything else of stack 1 is made one at a time. @param {{k: string, n: number}} out
 */
export function makesMany(out) {
  return !!out && stackSize(out.k) > 1;
}

/**
 * A lane job's state: "waiting" (or the reason main gives, e.g. "Kiln too far"), else its progress "40%".
 * @param {{progress: number, waiting: boolean|string}} job
 */
export function jobStatusText(job) {
  if (!job) return '';
  if (job.waiting) return typeof job.waiting === 'string' ? job.waiting : 'waiting';
  return `${Math.round(Math.max(0, Math.min(1, Number(job.progress) || 0)) * 100)}%`;
}

/** A required tool's chip: "axe≥1" (the RecipeView's own label wins). @param {{type: string, tier: number, label?: string}} t */
export function toolLabel(t) {
  if (!t) return '';
  return t.label || `${t.type}≥${t.tier}`;
}

/** @type {Map<string, string>|null} */
let toolIconCache = null;
/**
 * The item whose icon stands for a required tool: the cheapest (lowest-tier) tool of that type that qualifies. Pure.
 * @param {string} type @param {number} tier
 * @returns {string|null}
 */
export function toolIconKey(type, tier) {
  toolIconCache ||= new Map();
  const id = `${type}:${tier}`;
  if (toolIconCache.has(id)) return /** @type {string} */ (toolIconCache.get(id));
  let best = null;
  let bestTier = Infinity;
  for (const key of ITEM_KEYS) {
    const t = ITEMS[key].tool;
    if (t && t.type === type && t.tier >= tier && t.tier < bestTier) {
      best = key;
      bestTier = t.tier;
    }
  }
  toolIconCache.set(id, best);
  return best;
}

/**
 * §94: what a recipe is found by in the Making search — its output's name, every input (and a tag's members), its tools,
 * its workplace and what it is for — lower case. @param {RecipeView} r @returns {string}
 */
export function recipeSearchText(r) {
  const words = [itemName(r.out.k), r.out.k.replace(/_/g, ' '), stationName(r.station), r.purpose || ''];
  for (const inp of r.inputs || []) {
    if (inp.label) words.push(inp.label);
    if (inp.k) words.push(itemName(inp.k));
    if (inp.tag && Object.hasOwn(TAGS, inp.tag)) for (const k of TAGS[inp.tag]) words.push(itemName(k));
  }
  for (const tl of r.tools || []) words.push(toolLabel(tl));
  return words.join(' | ').toLowerCase();
}

/**
 * §94: the recipes whose search text holds every word of `query` (any order, any case; an empty query keeps them all).
 * @param {RecipeView[]} recipes @param {string} query @returns {RecipeView[]}
 */
export function searchRecipes(recipes, query) {
  const list = Array.isArray(recipes) ? recipes : [];
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return list.slice();
  return list.filter((r) => {
    const text = recipeSearchText(r);
    return words.every((w) => text.includes(w));
  });
}

/**
 * §94: what the build tree needs to know, from the screen's view: what is carried (pack, worn, on the mouse), which
 * recipes could start now (`view.ready`) and which workplaces are near. @param {PackView} view
 * @returns {import('./buildTree.js').TreeFacts}
 */
export function treeFactsFromView(view) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const s of [...(view.slots || []), ...(view.wear || []), view.cursor]) if (s && s.k) counts.set(s.k, (counts.get(s.k) ?? 0) + (s.n || 1));
  const ready = new Set(view.ready || []);
  const near = new Set((view.stations || []).filter((s) => s.near).map((s) => s.id));
  return {
    count: (k) => counts.get(k) ?? 0,
    hasTool: (type, tier) => [...counts.keys()].some((k) => {
      const tool = ITEMS[k] && ITEMS[k].tool;
      return !!tool && tool.type === type && tool.tier >= tier;
    }),
    canMake: (id) => ready.has(id),
    near: (s) => near.has(s),
  };
}

/**
 * §94.4: what the build tree's drawing depends on — its columns, the nodes shown, the workplaces in sight, the columns
 * reached, the hidden counts and the unlocks shown. The screen draws the tree again only when this changes (pure).
 * @param {import('./buildTree.js').TreeModel} model @param {import('./buildTree.js').TreeReveal} reveal @returns {string}
 */
export function revealSignature(model, reveal) {
  return [model.stations.join(','), [...reveal.shown].sort().join(','), [...reveal.open].sort().join(','),
    reveal.reached.map((r) => (r ? 1 : 0)).join(''), reveal.hidden.join(','), reveal.unlocks.map((u) => u.join(',')).join(';')].join('|');
}

/** The recipes a tab lists: all of them, or those of one station (order kept). @param {RecipeView[]} recipes @param {string} tab */
export function filterRecipes(recipes, tab) {
  const list = Array.isArray(recipes) ? recipes : [];
  return !tab || tab === 'all' ? list.slice() : list.filter((r) => r.station === tab);
}

/** Mini-rosette positions on a recipe card: tools from the lower-right hex on, inputs from the top (§9.8). */
const CARD_TOOL_ORDER = ['SE', 'S', 'SW', 'NW', 'NE', 'N'];
const CARD_INPUT_ORDER = ['N', 'NE', 'NW', 'SW', 'S', 'SE'];

/**
 * Where a recipe card puts its inputs and tools on the ring around the output (pure): tools first take the lower-right
 * hex (then S, …), inputs fill the ring from the top. Anything beyond six is left off the ring (it is still in the card's
 * text).
 * @param {number} inputs @param {number} tools
 * @returns {{ inputs: string[], tools: string[] }} ring position names
 */
export function cardLayout(inputs, tools) {
  const used = new Set();
  const t = [];
  for (let i = 0; i < tools && t.length < 6; i++) {
    const pos = CARD_TOOL_ORDER.find((p) => !used.has(p));
    if (!pos) break;
    used.add(pos);
    t.push(pos);
  }
  const ins = [];
  for (let i = 0; i < inputs; i++) {
    const pos = CARD_INPUT_ORDER.find((p) => !used.has(p));
    if (!pos) break;
    used.add(pos);
    ins.push(pos);
  }
  return { inputs: ins, tools: t };
}

// ---- a demo view (the ?ui=pack story for screenshots; pure) ---------------------------------------------------------

/**
 * A full, plausible PackView for screenshots and development (`?ui=pack`): a mid-game pack, a hat, the Making panel with a
 * mix of craftable, short and far recipes, and two busy lanes. With `{ basket: true }` a basket's rosette replaces Making.
 * @param {{ basket?: boolean, tab?: string }} [opts]
 * @returns {PackView}
 */
export function demoPackView(opts = {}) {
  /** @type {(ItemStack|null)[]} */
  const slots = Array(PACK_SLOTS).fill(null);
  const put = (i, k, n = 1, d) => { slots[i] = d === undefined ? { k, n } : { k, n, d }; };
  put(0, 'flint_pick', 1, 51); put(1, 'flint_axe', 1, 18); put(2, 'stone_axe'); put(3, 'roast_pork', 3);
  put(4, 'pot_boiled'); put(5, 'campfire', 2); put(6, 'rock', 23); put(7, 'stick', 14); put(8, 'flint_knife', 1, 9);
  put(9, 'plant_fibre', 31); put(10, 'cord', 4); put(11, 'flint', 3); put(12, 'clay_lump', 12); put(13, 'honeyberries', 9);
  put(14, 'oak_log', 6); put(15, 'raw_pork', 2); put(16, 'rawhide', 1); put(17, 'pig_fat', 1); put(19, 'malachite', 5);
  put(20, 'coal', 7); put(22, 'greenware_pot', 2); put(23, 'fibre_bandage', 2); put(25, 'birch_bark', 6); put(26, 'dirt', 40);
  put(24, HANDBOOK_ITEM); // §14: every survival pack carries the handbook
  const recipe = (id, station, out, inputs, tools, seconds, stationOk = true) => {
    const ins = inputs.map(([k, need, have, tag]) => (tag ? { tag, label: `#${tag}`, need, have } : { k, label: itemName(k), need, have }));
    const tl = tools.map(([type, tier, ok]) => ({ type, tier, label: `${type}≥${tier}`, ok }));
    const craftable = stationOk && ins.every((i) => i.have >= i.need) && tl.every((t) => t.ok);
    return { id, station, out, inputs: ins, tools: tl, seconds, craftable, stationOk, purpose: purposeOf(out.k) };
  };
  const recipes = [
    recipe('cord', 'hand', { k: 'cord', n: 1 }, [['plant_fibre', 2, 31]], [], 1),
    recipe('flint_spear', 'stump', { k: 'flint_spear', n: 1 }, [[null, 1, 3, 'knapstone'], ['stick', 2, 14], ['cord', 1, 4]], [['hammer', 1, false]], 3),
    recipe('campfire', 'hand', { k: 'campfire', n: 1 }, [['rock', 6, 23], ['stick', 3, 14], [null, 1, 37, 'tinder']], [['firestarter', 0, false]], 5),
    recipe('greenware_pot', 'hand', { k: 'greenware_pot', n: 1 }, [['clay_lump', 3, 12]], [], 4),
    recipe('leather', 'stump', { k: 'leather', n: 1 }, [['rawhide', 1, 1], ['pig_fat', 1, 1]], [['knife', 2, true]], 8),
    recipe('split_sticks', 'stump', { k: 'stick', n: 6 }, [[null, 1, 6, 'log']], [['axe', 1, true]], 3),
    recipe('kiln', 'hand', { k: 'kiln', n: 1 }, [['clay_lump', 8, 12], ['rock', 6, 23]], [], 8),
    recipe('charcoal', 'kiln', { k: 'charcoal', n: 8 }, [[null, 6, 6, 'log']], [], 40, false),
    recipe('copper_pick', 'kiln', { k: 'copper_pick', n: 1 }, [['copper_ingot', 2, 0], ['stick', 2, 14], [null, 1, 7, 'fuel']],
      [['crucible', 0, false], ['mold', 0, false]], 25, false),
    recipe('iron_bloom', 'bloomery', { k: 'iron_bloom', n: 1 }, [['hematite', 3, 0], ['charcoal', 4, 0]], [], 40, false),
  ];
  return {
    slots,
    wear: [{ k: 'straw_hat', n: 1 }, null, null],
    selected: 0,
    cursor: null,
    hover: null,
    container: opts.basket
      ? { title: 'Wicker Basket', slots: [{ k: 'wild_tuber', n: 7 }, null, { k: 'acorns', n: 18 }, null, null, { k: 'salt', n: 2 },
        ...Array(12).fill(null)] }
      : null,
    stations: [
      { id: 'hand', label: 'Hands', near: true }, { id: 'stump', label: 'Stump', near: true }, { id: 'kiln', label: 'Kiln', near: false },
      { id: 'bloomery', label: 'Bloomery', near: false }, { id: 'forge', label: 'Forge', near: false },
      { id: 'workbench', label: 'Bench', near: false },
      { id: 'lab', label: 'Lab', near: false },
    ],
    tab: opts.tab || 'all',
    recipes,
    ready: recipes.filter((r) => r.craftable && r.stationOk).map((r) => r.id),
    lanes: [
      { station: 'hand', jobs: [{ name: 'Cord', progress: 0.4, waiting: false }, { name: 'Greenware Pot', progress: 0, waiting: false }] },
      { station: 'kiln', jobs: [{ name: 'Clay Pot', progress: 0.65, waiting: 'Kiln too far' }] },
    ],
  };
}

// ---- the DOM ------------------------------------------------------------------------------------------------------

/** Pack cells: flat-top hexes of circumradius CELL_S (60×52 px). */
export const CELL_S = 30;
/** Recipe cards' mini rosettes: flat-top hexes of circumradius CARD_S (34×29 px). */
export const CARD_S = 17;
const SQRT3 = Math.sqrt(3);
const SVG_NS = 'http://www.w3.org/2000/svg';
const HIDDEN = 'hidden';

/** Flat-top hex polygon points in a w×h box (for the wear outline), clockwise from the left corner. */
function flatHexPoints(w, h, inset) {
  const x0 = inset;
  const x1 = w - inset;
  const y0 = inset;
  const y1 = h - inset;
  const qx = (x1 - x0) / 4;
  return [[x0, h / 2], [x0 + qx, y0], [x1 - qx, y0], [x1, h / 2], [x1 - qx, y1], [x0 + qx, y1]]
    .map(([x, y]) => `${+x.toFixed(2)},${+y.toFixed(2)}`).join(' ');
}

/**
 * @typedef {Object} PackUI
 * @property {(view: PackView) => void} open
 * @property {(view: PackView) => void} refresh   redraws only what changed; a no-op while closed
 * @property {() => void} close
 * @property {() => boolean} isOpen
 * @property {() => void} dispose
 * @property {() => void} openTree     (§94) show the build tree over the screen (built the first time)
 * @property {() => void} closeTree    back to Making
 * @property {() => boolean} isTreeOpen
 * @property {(text: string) => void} setQuery   put text in the Making search box
 */

/**
 * @param {Document} doc
 * @param {ItemIcons} itemIcons   from itemIcons.createItemIcons
 * @param {PackUICallbacks} [callbacks]
 * @returns {PackUI}
 */
export function createPackUI(doc, itemIcons, callbacks = {}) {
  if (!doc || typeof doc.createElement !== 'function') throw new TypeError('createPackUI: a Document is required');

  /** @type {Array<[EventTarget, string, EventListener]>} */
  const listeners = [];
  /** @param {EventTarget} target @param {string} type @param {EventListener} fn */
  function on(target, type, fn) {
    target.addEventListener(type, fn);
    listeners.push([target, type, fn]);
  }
  /** Invoke an optional callback by name. */
  function fire(name, ...args) {
    const fn = callbacks ? callbacks[name] : undefined;
    if (typeof fn === 'function') fn(...args);
  }
  /** @param {string} tag @param {string} [className] @param {string} [text] */
  function make(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  /** @param {Element} node */
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---- the layer (index.html has #pack-screen; created when missing)
  let root = doc.getElementById('pack-screen');
  if (!root) {
    root = make('div', `layer ${HIDDEN}`);
    root.id = 'pack-screen';
    (doc.body || doc.documentElement).appendChild(root);
  }
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Pack and Making');

  const state = {
    open: false,
    built: false,
    keysAttached: false,
    disposed: false,
    /** @type {PackView|null} */
    view: null,
    /** @type {{area: string, index: number}|null} the cell under the mouse */
    hover: null,
    infoSig: '\u0000',
    messageSig: '\u0000',
    cursorSig: '\u0000',
    containerSize: -1,
    tabsSig: '',
    listSig: '',
    lanesSig: '',
    /** the mouse's last client position (off screen until it is known) */
    mouseX: -1000,
    mouseY: -1000,
    /** §94: the Making search box's text */
    query: '',
    /** §94: the build tree is shown over the screen */
    treeOpen: false,
  };

  /** @typedef {{ el: HTMLElement, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D|null, count: HTMLElement,
   *   wear: Element|null, wearLine: Element|null, label: HTMLElement|null, sig: string, iconKey: string|null }} Cell */
  /** @type {Record<string, Cell[]>} */
  const cellsByArea = { pack: [], wear: [], container: [] };

  /** @type {Record<string, HTMLElement>} */
  const parts = {};
  /** §94: the Making search box @type {HTMLInputElement|null} */
  let searchBox = null;

  /**
   * One hex cell.
   * @param {string} area @param {number} index @param {number} x @param {number} y  centre in the parent's px
   * @param {number} iconPx @param {string} [extraClass]
   */
  function makeCell(area, index, x, y, iconPx = 32, extraClass = '') {
    const el = /** @type {HTMLElement} */ (make('div', `pack-cell${extraClass ? ' ' + extraClass : ''}`));
    el.dataset.area = area;
    el.dataset.index = String(index);
    el.style.left = `${Math.round(x - CELL_S)}px`;
    el.style.top = `${Math.round(y - (SQRT3 * CELL_S) / 2)}px`;
    const canvas = /** @type {HTMLCanvasElement} */ (make('canvas', 'cell-icon'));
    canvas.width = iconPx;
    canvas.height = iconPx;
    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (ctx) ctx.imageSmoothingEnabled = false;
    el.appendChild(canvas);
    const count = /** @type {HTMLElement} */ (make('span', 'cell-count'));
    el.appendChild(count);
    /** @type {Element|null} */
    let wear = null;
    /** @type {Element|null} */
    let wearLine = null;
    if (typeof doc.createElementNS === 'function') {
      const w = 2 * CELL_S;
      const h = Math.round(SQRT3 * CELL_S);
      wear = doc.createElementNS(SVG_NS, 'svg');
      wear.setAttribute('class', `cell-wear ${HIDDEN}`);
      wear.setAttribute('viewBox', `0 0 ${w} ${h}`);
      wearLine = doc.createElementNS(SVG_NS, 'polygon');
      wearLine.setAttribute('points', flatHexPoints(w, h, 4));
      wearLine.setAttribute('pathLength', '100');
      wear.appendChild(wearLine);
      el.appendChild(wear);
    }
    /** @type {Cell} */
    const cell = { el, canvas, ctx, count, wear, wearLine, label: null, sig: '\u0000', iconKey: null };
    return cell;
  }

  /** Draw a stack into a cell (only what changed). @param {Cell} cell @param {ItemStack|null} stack */
  function paintCell(cell, stack) {
    const sig = stack ? `${stack.k}|${stack.n}|${stack.d ?? ''}` : '';
    if (sig === cell.sig) return;
    cell.sig = sig;
    const key = stack ? stack.k : null;
    if (key !== cell.iconKey) {
      cell.iconKey = key;
      if (cell.ctx) {
        try {
          itemIcons.draw(cell.ctx, key, cell.canvas.width);
        } catch {
          // a failed icon leaves the cell blank; the name still shows on hover
        }
      }
    }
    cell.el.classList.toggle('filled', Boolean(stack));
    cell.count.textContent = countLabel(stack);
    if (cell.label) cell.label.classList.toggle(HIDDEN, Boolean(stack));
    const f = wearFraction(stack);
    if (cell.wear) {
      cell.wear.setAttribute('class', f === null ? `cell-wear ${HIDDEN}` : `cell-wear ${f > 0.5 ? 'good' : f >= 0.25 ? 'worn' : 'low'}`);
      if (f !== null && cell.wearLine) cell.wearLine.setAttribute('stroke-dasharray', `${Math.max(1, Math.round(f * 100))} 100`);
    }
    cell.el.title = stackTitle(stack);
  }

  /**
   * Lay out a rosette board: cells around a centre, positioned inside `board` (sized to fit).
   * @param {HTMLElement} board @param {string} area @param {number} count @param {Cell[]} into
   * @returns {{ cx: number, cy: number }} the centre hex's pixel centre
   */
  function buildRosette(board, area, count, into) {
    const rings = ringsFor(count);
    const cells = rosetteCells(rings).slice(0, count);
    const half = rings * 1.5 * CELL_S + CELL_S;
    const halfH = (rings + 0.5) * SQRT3 * CELL_S;
    const cx = Math.ceil(half);
    const cy = Math.ceil(halfH);
    board.style.width = `${2 * cx}px`;
    board.style.height = `${2 * cy}px`;
    cells.forEach(([q, r], i) => {
      const [x, y] = hexToPixel(q, r, CELL_S);
      const cell = makeCell(area, i, cx + x, cy + y);
      board.appendChild(cell.el);
      into.push(cell);
    });
    return { cx, cy };
  }

  function build() {
    if (state.built) return;
    state.built = true;
    clear(root);
    const panel = make('div', 'pack-panel');
    root.appendChild(panel);

    const close = /** @type {HTMLButtonElement} */ (make('button', 'hex-button pack-close', '✕'));
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the pack (E or Esc)');
    on(close, 'click', () => fire('onClose'));
    panel.appendChild(close);

    // left: the pack board (wear chain, discard hex, rosette, centre info), the info line, the hotbar strip
    const left = make('div', 'pack-left');
    panel.appendChild(left);
    const heading = make('div', 'pack-heading pack-heading-row');
    heading.appendChild(make('span', '', 'Pack'));
    // §14: the handbook's "Read" action (right-clicking its slot does the same); shown while the pack holds it
    const read = /** @type {HTMLButtonElement} */ (make('button', `hex-button pack-read ${HIDDEN}`, 'Read the handbook'));
    read.type = 'button';
    read.title = 'Open the Survival Handbook (or right-click it)';
    on(read, 'click', () => fire('onRead'));
    heading.appendChild(read);
    parts.read = read;
    left.appendChild(heading);
    const board = /** @type {HTMLElement} */ (make('div', 'pack-board'));
    left.appendChild(board);
    const rosette = /** @type {HTMLElement} */ (make('div', 'pack-rosette'));
    board.appendChild(rosette);
    /** @type {Cell[]} */
    const packCells = Array(PACK_SLOTS);
    /** @type {Cell[]} */
    const ringCells = [];
    const { cx, cy } = buildRosette(rosette, 'pack', PACK_SLOTS - HOTBAR_SIZE, ringCells);
    // the rosette cells are pack slots 9..26
    ringCells.forEach((cell, i) => {
      cell.el.dataset.index = String(HOTBAR_SIZE + i);
      packCells[HOTBAR_SIZE + i] = cell;
    });
    // the centre info hex (not a slot)
    const centre = makeCell('info', -1, cx, cy, 40, 'pack-centre');
    centre.el.removeAttribute('data-area');
    rosette.appendChild(centre.el);
    parts.centre = centre.el;
    parts.centreCell = /** @type {any} */ (centre);
    // the wear chain at the rosette's left, head to feet, and the red discard hex below it
    const chain = /** @type {HTMLElement} */ (make('div', 'pack-wear'));
    board.insertBefore(chain, rosette);
    const chainW = 2 * CELL_S;
    const step = SQRT3 * CELL_S;
    chain.style.width = `${chainW}px`;
    chain.style.height = `${Math.round(2 * cy)}px`;
    for (let i = 0; i < WEAR_SLOTS; i++) {
      const cell = makeCell('wear', i, CELL_S, cy + (i - 1) * step, 32, 'wear-slot');
      const name = WEAR_SLOT_NAMES[i] || '';
      cell.label = /** @type {HTMLElement} */ (make('span', 'cell-label', name ? name[0].toUpperCase() + name.slice(1) : ''));
      cell.el.appendChild(cell.label);
      cell.el.setAttribute('aria-label', `${name} slot`);
      chain.appendChild(cell.el);
      cellsByArea.wear.push(cell);
    }
    const discard = makeCell('discard', 0, CELL_S, cy + 2.6 * step, 24, 'discard');
    discard.el.title = 'Discard: drop the stack on the mouse here to destroy it';
    discard.el.setAttribute('aria-label', 'Discard');
    discard.el.appendChild(make('span', 'cell-label', 'Discard'));
    chain.appendChild(discard.el);
    chain.style.height = `${Math.round(cy + 3.1 * step)}px`;

    const info = make('div', 'pack-info', '');
    left.appendChild(info);
    parts.info = /** @type {HTMLElement} */ (info);

    // the hotbar strip: slots 0..8, a zig-zag outlined in honey
    const strip = /** @type {HTMLElement} */ (make('div', 'pack-strip'));
    left.appendChild(strip);
    const sc = stripCells(HOTBAR_SIZE, CELL_S);
    strip.style.width = `${Math.round(sc[sc.length - 1][0] + 2 * CELL_S)}px`;
    strip.style.height = `${Math.round(SQRT3 * CELL_S * 1.5)}px`;
    sc.forEach(([x, y], i) => {
      const cell = makeCell('pack', i, CELL_S + x, (SQRT3 * CELL_S) / 2 + y, 32, 'hotbar-cell');
      cell.el.appendChild(make('span', 'cell-key', String(i + 1)));
      strip.appendChild(cell.el);
      packCells[i] = cell;
    });
    cellsByArea.pack = packCells;

    // right: Making (tabs, recipes, lanes) or a basket's rosette
    const right = make('div', 'pack-right');
    panel.appendChild(right);
    const making = make('div', 'making');
    right.appendChild(making);
    // §94: the heading carries the search box and the build tree's button
    const mhead = make('div', 'pack-heading pack-heading-row making-head');
    mhead.appendChild(make('span', '', 'Making'));
    const search = /** @type {HTMLInputElement} */ (make('input', 'making-search'));
    search.type = 'search';
    search.placeholder = 'Search: name, input, workplace';
    search.setAttribute('aria-label', 'Search the recipes');
    search.spellcheck = false;
    search.autocomplete = 'off';
    mhead.appendChild(search);
    searchBox = search;
    const treeBtn = /** @type {HTMLButtonElement} */ (make('button', 'hex-button pack-read tree-open', 'Build tree'));
    treeBtn.type = 'button';
    treeBtn.title = 'What to gather and build to reach each workplace';
    mhead.appendChild(treeBtn);
    making.appendChild(mhead);
    on(search, 'input', () => setQuery(search.value, true));
    on(search, 'keydown', (e) => {
      const ke = /** @type {KeyboardEvent} */ (e);
      // typing never reaches the screen's own keys (E closes the pack); Esc clears the box first, then closes as usual
      if (ke.key === 'Escape' || ke.code === 'Escape') {
        if (search.value !== '') {
          ke.preventDefault();
          ke.stopPropagation();
          setQuery('', false);
        }
        return;
      }
      ke.stopPropagation();
    });
    on(treeBtn, 'click', () => openTree());
    parts.making = /** @type {HTMLElement} */ (making);
    parts.tabs = /** @type {HTMLElement} */ (make('div', 'making-tabs'));
    parts.tabs.setAttribute('role', 'tablist');
    making.appendChild(parts.tabs);
    parts.list = /** @type {HTMLElement} */ (make('div', 'recipe-list'));
    making.appendChild(parts.list);
    parts.lanes = /** @type {HTMLElement} */ (make('div', 'lanes'));
    making.appendChild(parts.lanes);
    // §94: the build tree, over the whole panel (built the first time it is opened)
    const tree = make('div', `build-tree ${HIDDEN}`);
    tree.setAttribute('role', 'region');
    tree.setAttribute('aria-label', 'Build tree');
    root.appendChild(tree);
    parts.tree = /** @type {HTMLElement} */ (tree);
    // one set of delegated listeners for the tree too: it is drawn again as it grows (§94.4), never adding any
    on(tree, 'click', onTreeClick);
    on(tree, 'mouseover', (e) => hotNode(closestWith(e.target, 'data-node')));
    on(tree, 'mouseleave', () => hotNode(null));
    const box = make('div', `container-panel ${HIDDEN}`);
    right.appendChild(box);
    parts.box = /** @type {HTMLElement} */ (box);
    parts.boxTitle = /** @type {HTMLElement} */ (make('div', 'pack-heading', ''));
    box.appendChild(parts.boxTitle);
    parts.boxBoard = /** @type {HTMLElement} */ (make('div', 'pack-rosette container-rosette'));
    box.appendChild(parts.boxBoard);

    // the stack on the mouse
    const cursor = makeCell('cursor', -1, CELL_S, (SQRT3 * CELL_S) / 2, 32, 'pack-cursor');
    cursor.el.removeAttribute('data-area');
    cursor.el.classList.add(HIDDEN);
    root.appendChild(cursor.el);
    parts.cursor = cursor.el;
    parts.cursorCell = /** @type {any} */ (cursor);
    parts.message = /** @type {HTMLElement} */ (make('div', 'pack-message', ''));
    parts.message.setAttribute('role', 'status');
    left.appendChild(parts.message);
    parts.hint = /** @type {HTMLElement} */ (make('div', 'pack-hint',
      'Click: take / put · right-click: half / one · shift-click: move · E / Esc: close'));
    left.appendChild(parts.hint);

    // one set of delegated listeners for every cell
    on(root, 'mousedown', onMouseDown);
    on(root, 'contextmenu', (e) => e.preventDefault());
    on(root, 'mouseover', onMouseOver);
    on(root, 'mouseleave', () => setHover(null));
    on(root, 'mousemove', onMouseMove);
    on(parts.tabs, 'click', (e) => {
      const btn = closestWith(e.target, 'data-tab');
      if (btn) fire('onTab', btn.getAttribute('data-tab'));
    });
    on(parts.list, 'click', (e) => {
      const btn = closestWith(e.target, 'data-make');
      if (btn && !btn.hasAttribute('disabled')) fire('onMake', btn.getAttribute('data-make'), Number(btn.getAttribute('data-times')) || 1);
    });
    on(parts.lanes, 'click', (e) => {
      const btn = closestWith(e.target, 'data-lane');
      if (btn) fire('onCancelJob', btn.getAttribute('data-lane'), Number(btn.getAttribute('data-job')));
    });
  }

  /** The nearest ancestor (or self) carrying `attr`. @param {EventTarget|null} t @param {string} attr */
  function closestWith(t, attr) {
    for (let n = /** @type {any} */ (t); n && n !== root && typeof n.hasAttribute === 'function'; n = n.parentNode) {
      if (n.hasAttribute(attr)) return /** @type {HTMLElement} */ (n);
    }
    return null;
  }

  /** @param {MouseEvent} e */
  function onMouseDown(e) {
    noteMouse(e);
    const cell = closestWith(e.target, 'data-area');
    if (!cell) return;
    const area = cell.getAttribute('data-area');
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    if (area === 'discard') {
      if (e.button === 0) fire('onDiscard');
      return;
    }
    if (area !== 'pack' && area !== 'wear' && area !== 'container') return;
    const index = Number(cell.getAttribute('data-index'));
    // §14: right-click on the handbook (with nothing on the cursor) reads it instead of picking it up
    if (e.button === 2 && stackAt({ area, index })?.k === HANDBOOK_ITEM && !state.view?.cursor) {
      fire('onRead');
      return;
    }
    fire('onSlot', area, index, e.button === 2 ? 2 : 0, Boolean(e.shiftKey));
  }

  /** @param {MouseEvent} e */
  function onMouseOver(e) {
    const cell = closestWith(e.target, 'data-area');
    const area = cell ? cell.getAttribute('data-area') : null;
    setHover(cell && area !== 'discard' ? { area: /** @type {string} */ (area), index: Number(cell.getAttribute('data-index')) } : null);
  }

  /** @param {MouseEvent} e */
  function onMouseMove(e) {
    noteMouse(e);
    if (parts.cursor && !parts.cursor.classList.contains(HIDDEN)) placeCursor();
  }

  /** Remember where the mouse is, so a stack picked up shows under it at once. @param {MouseEvent} e */
  function noteMouse(e) {
    if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
      state.mouseX = e.clientX;
      state.mouseY = e.clientY;
    }
  }

  /** The cursor stack's hex, centred on the mouse. */
  function placeCursor() {
    if (!parts.cursor) return;
    parts.cursor.style.transform = `translate(${Math.round(state.mouseX - CELL_S)}px, ${Math.round(state.mouseY - (SQRT3 * CELL_S) / 2)}px)`;
  }

  /** @param {{area: string, index: number}|null} h */
  function setHover(h) {
    const same = (h === null && state.hover === null) || (h && state.hover && h.area === state.hover.area && h.index === state.hover.index);
    if (same) return;
    state.hover = h;
    renderInfo();
  }

  /** @param {{area: string, index: number}|null|undefined} h @returns {ItemStack|null} */
  function stackAt(h) {
    const v = state.view;
    if (!h || !v) return null;
    if (h.area === 'pack') return (v.slots && v.slots[h.index]) || null;
    if (h.area === 'wear') return (v.wear && v.wear[h.index]) || null;
    if (h.area === 'container') return (v.container && v.container.slots && v.container.slots[h.index]) || null;
    return null;
  }

  // CONTRACT-ISSUE: §5.4 has the centre hex show "the hovered (or cursor) item's icon, name and durability". A 60 px
  // rosette cell cannot hold a name like "Roasted Cattail Root", so the centre hex shows the icon (with the wear outline
  // for durability) and the line right under the rosette (.pack-info) gives the name and "45/90".
  /** The centre hex and the info line: the hovered stack, else the cursor's. */
  function renderInfo() {
    const v = state.view;
    const stack = stackAt(state.hover) || stackAt(v && v.hover) || (v && v.cursor) || null;
    const sig = stack ? `${stack.k}|${stack.n}|${stack.d ?? ''}` : '';
    if (sig === state.infoSig) return;
    state.infoSig = sig;
    const centre = /** @type {any} */ (parts.centreCell);
    if (centre) paintCell(centre, stack);
    if (parts.info) {
      parts.info.textContent = stack ? stackTitle(stack) : '';
      parts.info.classList.toggle('empty', !stack);
    }
  }

  /** The screen's feedback line (a refusal, a Make result); empty when the view carries none. */
  function renderMessage() {
    const m = state.view && state.view.message;
    const text = m && m.text ? String(m.text) : '';
    const sig = `${text}|${m && m.error ? 1 : 0}`;
    if (sig === state.messageSig) return;
    state.messageSig = sig;
    if (!parts.message) return;
    parts.message.textContent = text;
    parts.message.classList.toggle('error', !!(m && m.error && text));
  }

  function renderCursor() {
    const v = state.view;
    const stack = (v && v.cursor) || null;
    const sig = stack ? `${stack.k}|${stack.n}|${stack.d ?? ''}` : '';
    if (sig === state.cursorSig) return;
    state.cursorSig = sig;
    paintCell(/** @type {any} */ (parts.cursorCell), stack);
    parts.cursor.classList.toggle(HIDDEN, !stack);
    if (stack) placeCursor();
  }

  function renderSlots() {
    const v = /** @type {PackView} */ (state.view);
    const slots = Array.isArray(v.slots) ? v.slots : [];
    cellsByArea.pack.forEach((cell, i) => {
      paintCell(cell, slots[i] || null);
      if (i < HOTBAR_SIZE) cell.el.classList.toggle('selected', i === v.selected);
    });
    const wear = Array.isArray(v.wear) ? v.wear : [];
    cellsByArea.wear.forEach((cell, i) => paintCell(cell, wear[i] || null));
    if (parts.read) parts.read.classList.toggle(HIDDEN, !slots.some((s) => s && s.k === HANDBOOK_ITEM));
  }

  function renderContainer() {
    const v = /** @type {PackView} */ (state.view);
    const box = v.container;
    parts.making.classList.toggle(HIDDEN, Boolean(box));
    parts.box.classList.toggle(HIDDEN, !box);
    if (!box) return;
    const slots = Array.isArray(box.slots) ? box.slots : [];
    if (slots.length !== state.containerSize) {
      state.containerSize = slots.length;
      clear(parts.boxBoard);
      cellsByArea.container = [];
      const { cx, cy } = buildRosette(parts.boxBoard, 'container', slots.length, cellsByArea.container);
      // the centre hex is not a slot: it shows the basket itself
      const centre = makeCell('info', -1, cx, cy, 40, 'pack-centre');
      centre.el.removeAttribute('data-area');
      parts.boxBoard.appendChild(centre.el);
      paintCell(centre, { k: 'wicker_basket', n: 1 });
      centre.el.title = '';
    }
    if (parts.boxTitle.textContent !== String(box.title || '')) parts.boxTitle.textContent = String(box.title || '');
    cellsByArea.container.forEach((cell, i) => paintCell(cell, slots[i] || null));
  }

  function renderTabs() {
    const v = /** @type {PackView} */ (state.view);
    const stations = Array.isArray(v.stations) && v.stations.length
      ? v.stations : STATION_TABS.slice(1).map(([id, label]) => ({ id, label, near: id === 'hand' }));
    const tabs = [{ id: 'all', label: 'All', near: true }, ...stations];
    const sig = tabs.map((t) => `${t.id}:${t.label}:${t.near ? 1 : 0}`).join(',') + `|${v.tab}`;
    if (sig === state.tabsSig) return;
    state.tabsSig = sig;
    clear(parts.tabs);
    for (const t of tabs) {
      const b = /** @type {HTMLButtonElement} */ (make('button', 'making-tab', t.label || tabLabel(t.id)));
      b.type = 'button';
      b.setAttribute('data-tab', t.id);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', t.id === (v.tab || 'all') ? 'true' : 'false');
      if (t.id === (v.tab || 'all')) b.classList.add('active');
      if (!t.near) {
        b.classList.add('far');
        b.title = stationHint(t.id);
      }
      parts.tabs.appendChild(b);
    }
  }

  /** @type {Map<string, {card: HTMLElement, sig: string, badges: HTMLElement[], tools: HTMLElement[], make: HTMLElement,
   *   make5: HTMLElement|null, meta: HTMLElement}>} */
  const cards = new Map();

  /** A card's fixed parts (they never change for a recipe id). @param {RecipeView} r */
  function staticSig(r) {
    return `${r.station}|${r.out.k}:${r.out.n}|${r.inputs.map((i) => `${i.k || '#' + i.tag}:${i.need}`).join(',')}|`
      + `${(r.tools || []).map((t) => `${t.type}${t.tier}`).join(',')}|${r.seconds}|${r.purpose || ''}`;
  }

  /** A mini rosette cell on a card. @param {string} pos @param {string|null} key @param {number} iconPx @param {string} cls */
  function cardHex(pos, key, iconPx, cls) {
    const [q, r] = pos === 'C' ? [0, 0] : DIR[pos];
    const [x, y] = hexToPixel(q, r, CARD_S);
    const cx = 2.5 * CARD_S;
    const cy = 1.5 * SQRT3 * CARD_S;
    const el = /** @type {HTMLElement} */ (make('div', `card-hex ${cls}`));
    el.style.left = `${Math.round(cx + x - CARD_S)}px`;
    el.style.top = `${Math.round(cy + y - (SQRT3 * CARD_S) / 2)}px`;
    if (key) {
      try {
        el.appendChild(itemIcons.canvas(key, iconPx));
      } catch {
        // no icon: the card's text still names it
      }
    }
    return el;
  }

  /** @param {RecipeView} r */
  function buildCard(r) {
    const card = /** @type {HTMLElement} */ (make('div', 'recipe-card'));
    card.setAttribute('data-recipe', r.id);
    const ros = /** @type {HTMLElement} */ (make('div', 'card-rosette'));
    card.appendChild(ros);
    const layout = cardLayout(r.inputs.length, (r.tools || []).length);
    const out = cardHex('C', r.out.k, 20, 'card-out');
    if (r.out.n > 1) out.appendChild(make('span', 'card-n', `×${r.out.n}`));
    ros.appendChild(out);
    /** @type {HTMLElement[]} */
    const badges = [];
    r.inputs.forEach((inp, i) => {
      if (i >= layout.inputs.length) return;
      const key = inp.k || (inp.tag && Object.hasOwn(TAGS, inp.tag) ? TAGS[inp.tag][0] : null);
      const hex = cardHex(layout.inputs[i], key, 16, 'card-in');
      hex.title = inp.label || (inp.k ? itemName(inp.k) : `any ${inp.tag}`);
      const badge = /** @type {HTMLElement} */ (make('span', 'card-badge'));
      hex.appendChild(badge);
      badges.push(badge);
      ros.appendChild(hex);
    });
    /** @type {HTMLElement[]} */
    const tools = [];
    (r.tools || []).forEach((t, i) => {
      if (i >= layout.tools.length) return;
      const hex = cardHex(layout.tools[i], toolIconKey(t.type, t.tier), 16, 'card-tool');
      hex.title = `needs ${toolLabel(t)}`;
      hex.appendChild(make('span', 'card-tier', `≥${t.tier}`));
      tools.push(hex);
      ros.appendChild(hex);
    });
    const side = make('div', 'card-side');
    card.appendChild(side);
    side.appendChild(make('div', 'card-name', recipeTitle(r.out)));
    // §77: what it is for, on its own line (the whole line again as a tooltip: a narrow card cuts it short)
    if (r.purpose) {
      const why = /** @type {HTMLElement} */ (make('div', 'card-purpose', r.purpose));
      why.title = r.purpose;
      side.appendChild(why);
    }
    const meta = /** @type {HTMLElement} */ (make('div', 'card-meta', ''));
    side.appendChild(meta);
    const buttons = make('div', 'card-buttons');
    side.appendChild(buttons);
    const btn = (label, times) => {
      const b = /** @type {HTMLButtonElement} */ (make('button', 'hex-button card-make', label));
      b.type = 'button';
      b.setAttribute('data-make', r.id);
      b.setAttribute('data-times', String(times));
      buttons.appendChild(b);
      return b;
    };
    const makeBtn = btn('Make', 1);
    // §99: ×5 only for what stacks; a tool is made one at a time
    const make5 = makesMany(r.out) ? btn(`×${MAKE_MANY}`, MAKE_MANY) : null;
    make5?.setAttribute('aria-label', `Make ${MAKE_MANY} ${recipeTitle(r.out)}`);
    return { card, sig: staticSig(r), badges, tools, make: makeBtn, make5, meta };
  }

  function renderRecipes() {
    const v = /** @type {PackView} */ (state.view);
    if (v.container) return;
    const list = searchRecipes(filterRecipes(v.recipes, v.tab), state.query);
    /** @type {HTMLElement[]} */
    const order = [];
    for (const r of list) {
      if (!r || !r.id || !r.out) continue;
      let entry = cards.get(r.id);
      if (!entry || entry.sig !== staticSig(r)) {
        entry = buildCard(r);
        cards.set(r.id, entry);
      }
      // the dynamic parts: have/need, tools ok, craftable, near
      r.inputs.forEach((inp, i) => {
        const badge = entry.badges[i];
        if (!badge) return;
        const text = haveNeedText(inp.have, inp.need);
        if (badge.textContent !== text) badge.textContent = text;
        const level = haveNeedLevel(inp.have, inp.need);
        badge.classList.toggle('ok', level === 'ok');
        badge.classList.toggle('short', level === 'short');
      });
      (r.tools || []).forEach((t, i) => {
        const hex = entry.tools[i];
        if (!hex) return;
        hex.classList.toggle('ok', Boolean(t.ok));
        hex.classList.toggle('short', !t.ok);
      });
      const meta = `${formatSeconds(r.seconds)}${r.stationOk ? '' : ` · ${stationHint(r.station)}`}`;
      if (entry.meta.textContent !== meta) entry.meta.textContent = meta;
      entry.card.classList.toggle('craftable', Boolean(r.craftable));
      entry.card.classList.toggle('far', !r.stationOk);
      const disabled = !r.craftable || !r.stationOk;
      for (const b of [entry.make, entry.make5]) {
        if (!b) continue;
        if (disabled) b.setAttribute('disabled', '');
        else b.removeAttribute('disabled');
      }
      order.push(entry.card);
    }
    // put the cards in order, touching the list only when it differs
    const current = Array.from(parts.list.children);
    const empty = state.query.trim() ? `Nothing here matches “${state.query.trim()}”` : 'Nothing to make here yet';
    const same = order.length
      ? current.length === order.length && current.every((c, i) => c === order[i])
      : current.length === 1 && current[0].textContent === empty;
    if (!same) {
      clear(parts.list);
      for (const c of order) parts.list.appendChild(c);
      if (!order.length) parts.list.appendChild(make('div', 'recipe-empty', empty));
    }
  }

  /**
   * §94: the search box's text. Typing into an empty box shows every workplace's recipes (the tab goes back to All; a tab
   * clicked while searching narrows it). @param {string} text @param {boolean} typed
   */
  function setQuery(text, typed) {
    const was = state.query;
    state.query = String(text ?? '');
    if (searchBox && searchBox.value !== state.query) searchBox.value = state.query;
    if (typed && !was.trim() && state.query.trim() && state.view && state.view.tab && state.view.tab !== 'all') fire('onTab', 'all');
    if (state.view && !state.view.container) renderRecipes();
  }

  // ---- §94: the build tree ------------------------------------------------------------------------------------------

  /** @type {{ model: import('./buildTree.js').TreeModel, full: import('./buildTree.js').TreeModel,
   *   layout: ReturnType<typeof layoutTree>, nodes: Map<string, HTMLElement>,
   *   edges: Array<{ el: Element, from: string, to: string }>, heads: HTMLElement[], sig: string }|null} */
  let treeParts = null;
  /** §94.4: the whole tree with the circuits on and with them off, each built the first time it is wanted */
  /** @type {Map<boolean, import('./buildTree.js').TreeModel>} */
  const treeModels = new Map();
  /** @param {boolean} circuits */
  function treeModelFor(circuits) {
    let m = treeModels.get(circuits);
    if (!m) {
      m = buildTreeModel({ circuits });
      treeModels.set(circuits, m);
    }
    return m;
  }
  /** Room on the left for the lane names. */
  const TREE_LEFT = 92;
  const LANE_NAMES = Object.freeze({ gather: ['Gather', 'raw materials'], build: ['Build', 'tools and parts'] });
  /** The colour key of a node: the workplace that makes it ('hand' by hand or on a fire), 'gather' for raw things. */
  const wsOf = (node) => (node.lane === 'place' ? node.id.slice(1) : node.lane === 'gather' ? 'gather' : node.station || 'hand');

  /** A hex with a state ring (the outer hex) round a fill in the colour of where it is made, holding its icon. */
  function treeHex(icon, ws, px) {
    const hex = make('div', 'tree-hex');
    const fill = make('div', `tree-fill ws-${ws}`);
    try {
      fill.appendChild(itemIcons.canvas(icon, px));
    } catch {
      // no icon: the label still names it
    }
    hex.appendChild(fill);
    return hex;
  }

  /** A strip of small icons with counts ("×3"; a tool needed is marked "tool"). */
  function iconStrip(cls, entries) {
    const strip = make('div', cls);
    for (const { icon, label, n, ws } of entries) {
      const cell = make('span', `tree-mini ws-${ws}`);
      try {
        cell.appendChild(itemIcons.canvas(icon, 16));
      } catch {
        // no icon
      }
      if (n > 1) cell.appendChild(make('b', '', `×${n}`));
      cell.title = n > 0 ? `${n} ${label}` : `${label} (a tool)`;
      strip.appendChild(cell);
    }
    return strip;
  }

  /**
   * Draw the tree the player sees (§94.4: `model` is revealedTree of `full`), keeping the scroll where it was.
   * @param {import('./buildTree.js').TreeModel} full @param {import('./buildTree.js').TreeModel} model @param {string} sig
   */
  function buildTreeView(full, model, sig) {
    const layout = layoutTree(model);
    const box = parts.tree;
    const oldScroll = box.querySelector('.tree-scroll');
    const scrollAt = oldScroll ? [oldScroll.scrollLeft, oldScroll.scrollTop] : null;
    clear(box);
    const head = make('div', 'tree-head');
    head.appendChild(make('div', 'pack-heading', 'Build tree'));
    head.appendChild(make('div', 'tree-sub', 'Gather the raw materials and build the parts in a column to set up the workplace at its head. The next steps show as you go. A colour is where a thing is made. Click anything to find its recipes.'));
    const back = /** @type {HTMLButtonElement} */ (make('button', 'hex-button pack-read tree-close', '✕ Making'));
    back.type = 'button';
    back.setAttribute('aria-label', 'Back to Making (Esc)');
    back.setAttribute('data-tree-close', ''); // the tree's delegated click (onTreeClick)
    head.appendChild(back);
    // the keys: the workplaces' colours, then the states' rings
    const legend = make('div', 'tree-legend');
    legend.appendChild(make('span', 'tree-key ws-gather', 'Gathered'));
    for (const s of ['hand', ...model.stations]) legend.appendChild(make('span', `tree-key ws-${s}`, s === 'hand' ? 'By hand' : stationName(s)));
    legend.appendChild(make('span', 'tree-legend-gap', ''));
    for (const [st, label] of [['have', 'have it'], ['ready', 'can make now'], ['gather', 'to gather'], ['locked', 'not yet'], ['more', 'still to discover']]) {
      legend.appendChild(make('span', `tree-ring tree-${st}`, label));
    }
    head.appendChild(legend);
    box.appendChild(head);
    const scroll = make('div', 'tree-scroll');
    box.appendChild(scroll);
    const canvas = /** @type {HTMLElement} */ (make('div', 'tree-canvas'));
    canvas.style.width = `${layout.width + TREE_LEFT}px`;
    canvas.style.height = `${layout.height}px`;
    scroll.appendChild(canvas);
    // the columns: one per workplace, tinted with its colour, its head (a banner) more strongly; a column not reached yet
    // (§94.4) is dim
    /** @type {HTMLElement[]} */
    const heads = [];
    layout.columns.forEach((col, c) => {
      const s = model.stations[c];
      const headNode = model.byId.get(placeId(s));
      const reached = headNode?.reached !== false;
      // a column whose workplace is not in sight yet has a dim banner, even when early things in it show (§94.4)
      const veiled = headNode?.veiled === true;
      const stripe = /** @type {HTMLElement} */ (make('div', `tree-col ws-${s}${reached ? '' : ' unreached'}${veiled ? ' veiled' : ''}`));
      stripe.style.left = `${TREE_LEFT + col.x - 10}px`;
      stripe.style.width = `${col.w + 20}px`;
      const banner = /** @type {HTMLElement} */ (make('div', `tree-banner ws-${s}`));
      banner.style.height = `${layout.lanes[0].y - 8}px`;
      stripe.appendChild(banner);
      canvas.appendChild(stripe);
      const h = /** @type {HTMLElement} */ (make('div', 'tree-col-head', ''));
      h.style.left = `${TREE_LEFT + col.x + col.w - 64}px`;
      h.appendChild(make('span', 'tree-col-count', ''));
      canvas.appendChild(h);
      heads.push(h);
    });
    // the lanes under the heads, named on the left (the heads' own name: Workplace)
    const workplaceName = make('div', 'tree-lane-name tree-head-name', 'Workplace');
    workplaceName.appendChild(make('small', '', 'built from · unlocks'));
    canvas.appendChild(workplaceName);
    for (const lane of layout.lanes) {
      const band = /** @type {HTMLElement} */ (make('div', `tree-lane tree-lane-${lane.lane}`));
      band.style.top = `${lane.y - 8}px`;
      band.style.height = `${lane.h + 16}px`;
      const [name, sub] = LANE_NAMES[lane.lane];
      const label = make('div', 'tree-lane-name', name);
      label.appendChild(make('small', '', sub));
      band.appendChild(label);
      canvas.appendChild(band);
    }
    // the edges, under the nodes, in the colour of where the thing they lead into is made (only between shown nodes)
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'tree-edges');
    svg.setAttribute('width', String(layout.width + TREE_LEFT));
    svg.setAttribute('height', String(layout.height));
    canvas.appendChild(svg);
    /** @type {Array<{ el: Element, from: string, to: string }>} */
    const edges = [];
    for (const [from, to] of model.edges) {
      const a = layout.pos.get(from);
      const b = layout.pos.get(to);
      const target = model.byId.get(to);
      if (!a || !b || !target) continue;
      const [x1, y1] = [a[0] + TREE_LEFT, a[1]];
      const [x2, y2] = [b[0] + TREE_LEFT, b[1]];
      const dy = Math.max(30, Math.abs(y2 - y1) * 0.5);
      const down = y2 >= y1 ? 1 : -1;
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', `M${x1} ${y1} C${x1} ${y1 + down * dy} ${x2} ${y2 - down * dy} ${x2} ${y2}`);
      // a link between columns is drawn only while one of its ends is under the mouse (else the tree is a tangle)
      const far = model.byId.get(from)?.column !== target.column;
      path.setAttribute('class', `tree-edge ws-${wsOf(target)}${far ? ' far' : ''}`);
      svg.appendChild(path);
      edges.push({ el: path, from, to });
    }
    // the nodes; a workplace heads its column with its recipe and what it unlocks
    /** @type {Map<string, HTMLElement>} */
    const nodes = new Map();
    // a workplace's needs: shown or hidden, each is a node of the whole tree (with the circuits off it names none)
    const strip = (ids) => ids.map(({ id, n }) => {
      const nd = model.byId.get(id) ?? full.byId.get(id);
      return { icon: nd ? nd.icon : id, label: nd ? nd.label : itemName(id), n, ws: nd ? wsOf(nd) : 'hand' };
    });
    for (const node of model.nodes) {
      const at = layout.pos.get(node.id);
      if (!at) continue;
      const place = node.lane === 'place';
      const more = node.more !== undefined;
      // a workplace not in sight yet is a dim head (§94.4): its name and what it needs
      const el = /** @type {HTMLElement} */ (make('div', `tree-node tree-node-${more ? 'more' : node.lane}${place && node.veiled ? ' veiled' : ''}`));
      el.style.left = `${at[0] + TREE_LEFT}px`;
      el.style.top = `${at[1]}px`;
      el.setAttribute('data-node', node.id);
      if (more) {
        // §94.4: what is still hidden in this column, counted
        const hex = make('div', 'tree-hex');
        hex.appendChild(make('div', `tree-fill tree-fill-more ws-${model.stations[node.column]}`, '?'));
        el.appendChild(hex);
        el.appendChild(make('div', 'tree-label', `${node.more} more`));
        el.appendChild(make('div', 'tree-how', 'to discover'));
        el.title = `${node.label}: they show once you are a step away`;
        canvas.appendChild(el);
        nodes.set(node.id, el);
        continue;
      }
      el.appendChild(treeHex(node.icon, wsOf(node), place ? 32 : 24));
      el.appendChild(make('div', 'tree-label', node.label));
      el.appendChild(make('div', 'tree-how', place ? `built ${node.how}` : node.how));
      const nUnlocks = node.unlocks.length;
      el.title = place
        ? `${node.label}: built ${node.how} from ${node.needs.map(({ id, n }) => `${n > 0 ? `${n} ` : ''}${full.byId.get(id)?.label ?? itemName(id)}`).join(', ')}.${nUnlocks > 0 ? ` Unlocks ${nUnlocks} more recipe${nUnlocks === 1 ? '' : 's'}.` : ''}`
        : `${node.label}: ${node.how}`;
      if (place) {
        el.appendChild(iconStrip('tree-needs', strip(node.needs)));
        // what it unlocks that is shown (§94.4a: had, makeable now or a step away; the rest is in the column's count)
        if (nUnlocks > 0) {
          const extra = node.unlocks.length > 6 ? node.unlocks.length - 6 : 0;
          const unlocks = iconStrip('tree-unlocks', node.unlocks.slice(0, 6).map((k) => ({ icon: k, label: itemName(k), n: 1, ws: wsOf(node) })));
          unlocks.insertBefore(make('span', 'tree-unlock-word', 'unlocks'), unlocks.firstChild);
          if (extra) unlocks.appendChild(make('span', 'tree-more', `+${extra}`));
          el.appendChild(unlocks);
        }
      }
      canvas.appendChild(el);
      nodes.set(node.id, el);
    }
    if (scrollAt) {
      scroll.scrollLeft = scrollAt[0];
      scroll.scrollTop = scrollAt[1];
    }
    treeParts = { model, full, layout, nodes, edges, heads, sig };
  }

  /**
   * A click in the tree (delegated, once): "✕ Making" goes back; a node closes the tree and searches the list for its
   * recipes, what makes it and what it goes into (a workplace by its name: its own recipes too); a "more" marker does
   * nothing. @param {Event} e
   */
  function onTreeClick(e) {
    if (closestWith(e.target, 'data-tree-close')) {
      closeTree();
      return;
    }
    const el = closestWith(e.target, 'data-node');
    if (!el || !treeParts) return;
    const node = treeParts.model.byId.get(/** @type {string} */ (el.getAttribute('data-node')));
    if (!node || node.more !== undefined) return;
    closeTree();
    setQuery(node.lane === 'place' ? node.label : itemName(node.icon), false);
    if (state.view && state.view.tab !== 'all') fire('onTab', 'all');
  }

  /** Light up the edges of the node under the mouse (and the nodes at their other ends). @param {HTMLElement|null} el */
  function hotNode(el) {
    if (!treeParts) return;
    const id = el ? el.getAttribute('data-node') : null;
    const near = new Set();
    for (const e of treeParts.edges) {
      const hot = id !== null && (e.from === id || e.to === id);
      e.el.classList.toggle('hot', hot);
      if (hot) near.add(e.from === id ? e.to : e.from);
    }
    for (const [nid, n] of treeParts.nodes) n.classList.toggle('near', near.has(nid));
  }

  /**
   * The tree from the current view: what is revealed (§94.4: `view.had`, the circuits switch `view.circuits`; drawn again
   * only when that changes), then every node's state, every edge (lit when what it carries is had), the columns.
   */
  function renderTree() {
    if (!state.treeOpen || !state.view || !parts.tree) return;
    const view = state.view;
    const full = treeModelFor(view.circuits !== false);
    const facts = treeFactsFromView(view);
    const states = treeStates(full, facts);
    const reveal = revealTree(full, { states, had: Array.isArray(view.had) ? view.had : [], canMake: facts.canMake });
    const sig = revealSignature(full, reveal);
    if (!treeParts || treeParts.sig !== sig) buildTreeView(full, revealedTree(full, reveal), sig);
    const tp = /** @type {NonNullable<typeof treeParts>} */ (treeParts);
    for (const [id, el] of tp.nodes) {
      const s = id.startsWith('?') ? 'more' : states.get(id) || 'locked';
      if (el.getAttribute('data-state') !== s) el.setAttribute('data-state', s);
    }
    // lit: what you have, leading on to what you do not have yet (the next steps); both ends had: done, quiet
    for (const e of tp.edges) {
      const fromHave = states.get(e.from) === 'have';
      const toHave = states.get(e.to) === 'have';
      e.el.classList.toggle('live', fromHave && !toHave);
      e.el.classList.toggle('done', fromHave && toHave);
    }
    columnProgress(full, states).forEach((p, c) => {
      const head = tp.heads[c];
      if (!head) return;
      head.classList.toggle('built', p.built);
      const count = /** @type {HTMLElement} */ (head.lastChild);
      const text = p.built ? 'set up ✓' : `${p.done} / ${p.total}`;
      if (count.textContent !== text) count.textContent = text;
    });
  }

  function openTree() {
    if (!parts.tree) return;
    state.treeOpen = true;
    parts.tree.classList.remove(HIDDEN);
    renderTree();
  }

  function closeTree() {
    state.treeOpen = false;
    if (parts.tree) parts.tree.classList.add(HIDDEN);
    hotNode(null);
  }

  /** @returns {boolean} the build tree is shown */
  function isTreeOpen() {
    return state.treeOpen;
  }

  function renderLanes() {
    const v = /** @type {PackView} */ (state.view);
    const lanes = (Array.isArray(v.lanes) ? v.lanes : []).filter((l) => l && Array.isArray(l.jobs) && l.jobs.length);
    const sig = lanes.map((l) => `${l.station}:${l.jobs.map((j) => `${j.name}/${jobStatusText(j)}`).join(';')}`).join('|');
    if (sig === state.lanesSig) return;
    state.lanesSig = sig;
    clear(parts.lanes);
    for (const lane of lanes) {
      const row = make('div', 'lane-row');
      row.setAttribute('data-station', lane.station);
      row.appendChild(make('span', 'lane-name', stationName(lane.station)));
      lane.jobs.forEach((job, i) => {
        const chip = make('span', `lane-job${job.waiting ? ' waiting' : ''}${i === 0 ? ' head' : ''}`);
        chip.appendChild(make('span', 'job-name', String(job.name || '')));
        const bar = make('span', 'job-bar');
        const fill = /** @type {HTMLElement} */ (make('span', 'job-fill'));
        fill.style.width = `${Math.round(Math.max(0, Math.min(1, Number(job.progress) || 0)) * 100)}%`;
        bar.appendChild(fill);
        chip.appendChild(bar);
        chip.appendChild(make('span', 'job-status', jobStatusText(job)));
        const x = /** @type {HTMLButtonElement} */ (make('button', 'job-cancel', '✕'));
        x.type = 'button';
        x.setAttribute('data-lane', lane.station);
        x.setAttribute('data-job', String(i));
        x.setAttribute('aria-label', `Cancel ${job.name}`);
        chip.appendChild(x);
        row.appendChild(chip);
      });
      parts.lanes.appendChild(row);
    }
  }

  function render() {
    if (!state.view) return;
    renderSlots();
    renderContainer();
    renderTabs();
    renderRecipes();
    renderLanes();
    renderInfo();
    renderMessage();
    renderCursor();
    renderTree();
  }

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.code || (e.key === 'Escape' || e.key === 'Esc' ? 'Escape' : e.key === 'e' || e.key === 'E' ? 'KeyE' : '');
    if (code === 'Escape' && state.treeOpen) {
      e.preventDefault();
      closeTree(); // §94: Esc goes back from the build tree to Making first
      return;
    }
    if (code === 'Escape' || code === 'KeyE') {
      e.preventDefault();
      fire('onClose');
    }
  }

  /** @param {PackView} view */
  function open(view) {
    if (state.disposed) return;
    build();
    state.view = view || null;
    state.infoSig = '\u0000';
    state.messageSig = '\u0000';
    render();
    state.open = true;
    root.classList.remove(HIDDEN);
    if (!state.keysAttached) {
      state.keysAttached = true;
      doc.addEventListener('keydown', onKeyDown);
    }
  }

  /** @param {PackView} view */
  function refresh(view) {
    if (!state.open || state.disposed) return;
    state.view = view || state.view;
    render();
  }

  function close() {
    state.open = false;
    state.hover = null;
    closeTree();
    root.classList.add(HIDDEN);
    if (parts.cursor) parts.cursor.classList.add(HIDDEN);
    state.cursorSig = '\u0000';
    if (state.keysAttached) {
      state.keysAttached = false;
      doc.removeEventListener('keydown', onKeyDown);
    }
  }

  function isOpen() {
    return state.open;
  }

  function dispose() {
    if (state.disposed) return;
    close();
    state.disposed = true;
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners.length = 0;
    cards.clear();
    treeParts = null;
    clear(root);
    state.built = false;
  }

  return { open, refresh, close, isOpen, dispose, openTree, closeTree, isTreeOpen, setQuery: (text) => setQuery(text, false) };
}
