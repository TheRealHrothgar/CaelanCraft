// Caelancraft — the build tree (CONTRACTS §94): what a survivor gathers and builds, workplace by workplace, to reach every
// workplace from the Work Stump to the Lab. PURE (no DOM): packUI.js draws it, its state from the pack screen's view.
//
// The tree has one COLUMN per workplace, in the order they are reached (Work Stump, Kiln, Bloomery, Forge, Workbench,
// Lab), headed by the workplace itself (what it is built from, what it unlocks), and two LANES under it:
//   - 'gather': raw materials, nothing makes them (rock, a log, flint, clay, ore, hide); each says how it is got and which
//     tool that takes (a log wants an axe, coal a flint pick, tin ore a copper pick);
//   - 'build': what is made on the way (tools, parts, materials), each with the workplace that makes it (`station`).
// An item sits in the column of the FIRST workplace whose making needs it (through any chain of inputs and tools), so the
// tree reads left to right as a road map: everything in a column is what it takes to build that column's workplace.
// Edges run from each input and tool to what it makes, and from a gathering tool to what it gathers. A WORKPLACE is never
// an edge or a level: where a thing is made is its `station`, which the screen shows as colour (§94.5); a workplace's own
// recipe is its `needs`.
//
// The tree REVEALS itself as the player goes (§94.4, `revealTree`): what has been had, what could be made now and what is
// one step on from those are shown; everything deeper is counted, not drawn. With the world's circuits switched off the
// circuit parts, the devices and the Lab are not in the tree at all (`buildTreeModel({ circuits: false })`).
import { BLOCK_RULES, PICKABLE, MOB_DROPS } from './harvest.js';
import { ITEMS, ITEM_KEYS, TAGS, itemName, itemForBlock } from './items.js';
import { RECIPES, STATION_IDS, STATION_BLOCKS, STATION_NAMES, TAG_LABELS } from './crafting.js';
import { getBlockDef } from './blocks.js';
import { FIRE_TRANSFORMS } from './cooking.js';
import { PARTS } from './circuitParts.js';

/** @typedef {import('./crafting.js').Recipe} Recipe */

/** The workplaces in the order a survivor reaches them: one column each. */
export const TREE_STATIONS = Object.freeze(STATION_IDS.filter((s) => s !== 'hand'));

/** The circuit parts' roles (circuitParts.PARTS): what carries, stores, switches or uses electricity. */
const ELECTRIC_ROLES = new Set(['wire', 'junction', 'source', 'contact', 'load']);

/**
 * §94.4: the items the tree leaves out while the world's circuits are off (DESIGN-circuits made them): every electric part
 * (the four wires, the Terminal Board, the Voltaic Battery, the switches, the devices: PARTS whose role carries
 * electricity), the materials only they are made of (carbon filament, selenium, iron filings) and the Lab. Black powder,
 * the fuse, the torch and the keg are not circuits: they burn. Sorted.
 */
export const CIRCUIT_KEYS = Object.freeze([...new Set([
  ...Object.values(PARTS).filter((p) => ELECTRIC_ROLES.has(p.role)).map((p) => itemForBlock(p.id)).filter((k) => k !== null),
  'carbon_filament', 'selenium', 'iron_filings', 'lab',
])].sort());
const CIRCUIT_SET = new Set(CIRCUIT_KEYS);
/** §94.4: the workplaces that are circuits (their column goes while the circuits are off). */
export const CIRCUIT_STATIONS = Object.freeze(['lab']);

/** @param {string} k @returns {boolean} item `k` is a circuit part, device or material (CIRCUIT_KEYS) */
export function isCircuitKey(k) {
  return CIRCUIT_SET.has(k);
}

/** The lanes under the column heads, top to bottom (a workplace node, lane 'place', heads its column). */
export const TREE_LANES = Object.freeze(['gather', 'build']);

/**
 * @typedef {Object} TreeNode
 * @property {string} id          an item key, `#tag` for "any of a tag", or `@station` for a workplace
 * @property {'gather'|'build'|'place'} lane
 * @property {number} column      index into TREE_STATIONS
 * @property {string} label       "Flint Pick", "Any Log", "Kiln"
 * @property {string} icon        the item key its picture is drawn from
 * @property {string|null} recipe the recipe that makes it (build and place), else null
 * @property {string|null} station where that recipe is made ('hand', 'stump', …), else null
 * @property {string} how         one short line: "by hand", "at the Kiln", "with a Flint Pick", "from animals"
 * @property {string|null} tool   gather: the key of the tool node it takes to get it, else null
 * @property {number} depth       how many making steps lie under it (0 for raw), for ordering within a lane
 * @property {string[]} unlocks   place: the outputs this workplace makes that are not in the tree, in recipe order
 * @property {Array<{ id: string, n: number }>} needs   place: its recipe — the nodes it takes, how many (0 for a tool)
 * @property {boolean} [reached]  place, in a revealed tree (`revealedTree`): its column is reached (false: a dim head)
 * @property {boolean} [veiled]   place, in a revealed tree: its workplace is not in sight yet, so what it unlocks is not shown
 * @property {number} [more]      the "N more to discover" marker of a revealed column (id `?station`): how many are hidden
 */

/**
 * @typedef {Object} TreeModel
 * @property {TreeNode[]} nodes                   in column, then lane, then depth order
 * @property {Map<string, TreeNode>} byId
 * @property {Array<[string, string]>} edges      [from, to]: what is needed → what needs it
 * @property {ReadonlyArray<string>} stations     the workplaces of its columns, in order (a node's `column` indexes it)
 */

/** The workplace node id of a station. @param {string} s */
export function placeId(s) {
  return `@${s}`;
}

/** @type {Map<string, Recipe>} output key → the first recipe that makes it (table order) */
const MAKER = new Map();
for (const rec of RECIPES) for (const out of rec.outputs.slice(0, 1)) if (!MAKER.has(out.k)) MAKER.set(out.k, rec);

/** Items that are one member of a raw tag stand for the tag ("Any Log", not "Oak Log"). */
const TAG_OF = new Map(['log', 'sand', 'wool'].flatMap((tag) => TAGS[tag].map((k) => [k, `#${tag}`])));

/** @type {Map<string, string>} what a campfire turns into `k` (the pot of seawater it boils into a salt crust) */
const COOKED_FROM = new Map();
for (const [from, tr] of Object.entries(FIRE_TRANSFORMS)) if (!COOKED_FROM.has(tr.to)) COOKED_FROM.set(tr.to, from);

/** @param {string} k @returns {Recipe|null} the recipe the tree follows for item `k` */
export function makerOf(k) {
  return MAKER.get(k) ?? null;
}

/**
 * The lowest tool item that meets a recipe's tool need: of that type, tier `tier` or better, the lowest tier (ties: item
 * order). @param {string} type @param {number} tier @returns {string|null}
 */
export function toolItemFor(type, tier) {
  let best = null;
  let bestTier = Infinity;
  for (const k of ITEM_KEYS) {
    const t = ITEMS[k].tool;
    if (!t || t.type !== type || t.tier < tier) continue;
    if (t.tier < bestTier) {
      best = k;
      bestTier = t.tier;
    }
  }
  return best;
}

/**
 * How raw item `k` is got (§94 gather lane): `{ how, tool, picked }` — `tool` the tool item that it takes (of the easiest
 * source), null when bare hands (or a weapon) will do; `picked` when it lies about to be picked up with R (sticks, rocks).
 * Sources: what R picks, what a block breaks into (never a made block giving itself back, like a wire), what an animal
 * gives. @param {string} k @returns {{ how: string, tool: string|null, picked?: boolean }}
 */
export function gatherOf(k) {
  /** @param {ReadonlyArray<ReadonlyArray<{ items: ReadonlyArray<{ k: string }> }>>} groups */
  const gives = (groups) => groups.some((g) => g.some((br) => br.items.some((it) => it.k === k)));
  for (const p of Object.values(PICKABLE)) if (gives(p.drops)) return { how: 'picked up', tool: null, picked: true };
  let best = null;
  for (let id = 0; id < BLOCK_RULES.length; id++) {
    const rule = BLOCK_RULES[id];
    if (!rule || !gives(rule.drops)) continue;
    if (k === itemForBlock(id) && MAKER.has(k)) continue; // a made thing set down and taken up again is no source
    const need = rule.tier > 0 && rule.tool ? { type: rule.tool, tier: rule.tier } : null;
    if (need === null) return { how: 'by hand', tool: null };
    if (best === null || need.tier < best.tier) best = need;
  }
  if (best !== null) {
    const tool = toolItemFor(best.type, best.tier);
    return { how: tool ? `with a ${itemName(tool)}` : 'with a tool', tool };
  }
  for (const groups of Object.values(MOB_DROPS)) if (gives(groups)) return { how: 'from animals', tool: null };
  if (k === 'pot_seawater') return { how: 'fill a Clay Pot at the sea', tool: 'clay_pot' };
  return { how: 'found in the world', tool: null };
}

/** @param {string} tag @returns {boolean} every member of the tag is made by a recipe (Any Planks), so the tag is built */
function tagIsBuilt(tag) {
  return TAGS[tag].every((k) => MAKER.has(k));
}

/**
 * The build tree (pure, the same every call): see the header. `circuits: false` (the world's circuits are off, §94.4)
 * leaves out every circuit key and the Lab's column: nothing is followed through them, and no workplace unlocks one. A
 * workplace's `needs` stay its whole recipe (the Workbench is still built with copper wire, which then has no node).
 * @param {{ circuits?: boolean }} [opts]
 * @returns {TreeModel}
 */
export function buildTreeModel(opts = {}) {
  const circuits = opts.circuits !== false;
  /** @param {string} k @returns {boolean} the tree leaves `k` out */
  const skip = (k) => !circuits && CIRCUIT_SET.has(k);
  const stations = circuits ? TREE_STATIONS : Object.freeze(TREE_STATIONS.filter((s) => !CIRCUIT_STATIONS.includes(s)));
  /** @type {Map<string, TreeNode>} */
  const byId = new Map();
  /** @type {Array<[string, string]>} */
  const edges = [];
  const edgeKeys = new Set();
  const edge = (from, to) => {
    const key = `${from}>${to}`;
    if (from === to || edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push([from, to]);
  };
  const stationCol = (s) => TREE_STATIONS.indexOf(s);

  /**
   * Place `id` (needed by the workplace of `column`) and everything under it; @returns {number} its depth.
   * @param {string} id @param {number} column
   */
  function visit(id, column) {
    const known = byId.get(id);
    if (known) return known.depth;
    if (id.startsWith('#')) {
      const tag = id.slice(1);
      const first = TAGS[tag][0];
      if (tagIsBuilt(tag)) {
        const node = add(id, 'build', column, TAG_LABELS[tag] ?? tag, first, makerOf(first));
        node.depth = visitRecipe(id, /** @type {Recipe} */ (makerOf(first)), column) + 1;
        return node.depth;
      }
      // a raw tag: gathered from its easiest member
      let g = null;
      for (const k of TAGS[tag]) {
        if (MAKER.has(k)) continue;
        const gk = gatherOf(k);
        if (g === null || (g.tool !== null && gk.tool === null)) g = gk;
      }
      const node = add(id, 'gather', column, TAG_LABELS[tag] ?? tag, first, null);
      gatherInto(node, g ?? { how: 'found in the world', tool: null }, column);
      return 0;
    }
    const alias = TAG_OF.get(id);
    if (alias !== undefined) return visit(alias, column);
    const rec = makerOf(id);
    const g = gatherOf(id);
    // a thing that lies about to be picked up is gathered, even when a workplace can also make it (sticks)
    if (rec === null || g.picked === true) {
      const cooked = rec === null ? COOKED_FROM.get(id) : undefined;
      if (cooked !== undefined) {
        // made on a campfire (a salt crust boiled out of seawater)
        const node = add(id, 'build', column, itemName(id), id, null);
        node.how = 'on a campfire';
        node.depth = Math.max(visit(cooked, column), visit('campfire', column)) + 1;
        edge(cooked, id);
        edge('campfire', id);
        return node.depth;
      }
      const node = add(id, 'gather', column, itemName(id), id, null);
      gatherInto(node, g, column);
      return 0;
    }
    const node = add(id, 'build', column, itemName(id), id, rec);
    node.depth = visitRecipe(id, rec, column) + 1;
    return node.depth;
  }

  /**
   * The inputs and tools of `rec` under node `id`: edges into it, or (a workplace) its `needs`.
   * @returns {number} the deepest input's depth
   */
  function visitRecipe(id, rec, column) {
    const node = /** @type {TreeNode} */ (byId.get(id));
    const into = (dep, n) => {
      if (node.lane === 'place') node.needs.push({ id: dep, n });
      else edge(dep, id);
    };
    let depth = 0;
    for (const inp of rec.inputs) {
      const dep = 'tag' in inp ? `#${inp.tag}` : TAG_OF.get(inp.k) ?? inp.k;
      if (skip(dep)) {
        // a circuit while the circuits are off: no node, no edge; a workplace's recipe still names it
        if (node.lane === 'place') node.needs.push({ id: dep, n: inp.n });
        continue;
      }
      depth = Math.max(depth, visit(dep, column));
      into(dep, inp.n);
    }
    for (const t of rec.tools) {
      const tool = toolItemFor(t.type, t.tier);
      if (tool === null) continue;
      depth = Math.max(depth, visit(tool, column));
      into(tool, 0);
    }
    return depth;
  }

  /** @param {TreeNode} node @param {{ how: string, tool: string|null }} g @param {number} column */
  function gatherInto(node, g, column) {
    node.how = g.how;
    if (g.tool !== null) {
      node.tool = g.tool;
      visit(g.tool, column);
      edge(g.tool, node.id);
    }
  }

  /**
   * @param {string} id @param {'gather'|'build'|'place'} lane @param {number} column @param {string} label @param {string} icon
   * @param {Recipe|null} rec @returns {TreeNode}
   */
  function add(id, lane, column, label, icon, rec) {
    /** @type {TreeNode} */
    const node = {
      id, lane, column, label, icon, recipe: rec ? rec.id : null, station: rec ? rec.station : null,
      how: rec ? (rec.station === 'hand' ? 'by hand' : `at the ${STATION_NAMES[rec.station]}`) : '', tool: null, depth: 0, unlocks: [],
      needs: [],
    };
    byId.set(id, node);
    return node;
  }

  // The workplaces, in order: each one's making (and all under it) lands in its own column.
  stations.forEach((s, column) => {
    const key = itemForBlock(STATION_BLOCKS[s]) ?? getBlockDef(STATION_BLOCKS[s]).name;
    const rec = /** @type {Recipe} */ (makerOf(key));
    const node = add(placeId(s), 'place', column, STATION_NAMES[s], key, rec);
    node.depth = visitRecipe(placeId(s), rec, column) + 1;
  });
  // What each workplace unlocks beyond the tree
  for (const s of stations) {
    const node = /** @type {TreeNode} */ (byId.get(placeId(s)));
    node.unlocks = [...new Set(RECIPES.filter((r) => r.station === s && !byId.has(r.outputs[0].k) && !byId.has(placeId(stationOfOutput(r))))
      .map((r) => r.outputs[0].k).filter((k) => !skip(k)))];
  }

  const nodes = [...byId.values()].sort((a, b) => a.column - b.column || TREE_LANES.indexOf(a.lane) - TREE_LANES.indexOf(b.lane)
    || a.depth - b.depth || stationCol(a.station ?? 'hand') - stationCol(b.station ?? 'hand'));
  return { nodes, byId, edges, stations };
}

/** The station a recipe's output IS (the Lab is made at the Workbench), or '' when it is not a workplace. */
function stationOfOutput(rec) {
  const k = rec.outputs[0].k;
  for (const s of TREE_STATIONS) if (itemForBlock(STATION_BLOCKS[s]) === k) return s;
  return '';
}

// ---------------------------------------------------------------------------------------------------------------------
// state: what the player has, can make now, or has still to get
// ---------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} TreeFacts  what the pack screen knows (survivalControl.buildPackView's PackView, boiled down)
 * @property {(k: string) => number} count            items of key `k` carried
 * @property {(type: string, tier: number) => boolean} hasTool   a tool of that type, that tier or better, is carried
 * @property {(recipeId: string) => boolean} canMake   the recipe could be started now (inputs, tools, workplace near)
 * @property {(station: string) => boolean} near       that workplace is near
 */

/**
 * The state of every node: 'have' (carried, or a workplace near), 'ready' (makeable right now), 'gather' (raw, not
 * carried), 'locked' (not makeable yet). @param {TreeModel} model @param {TreeFacts} facts @returns {Map<string, string>}
 */
export function treeStates(model, facts) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const node of model.nodes) {
    let state;
    if (node.more !== undefined) state = 'more'; // a revealed column's "N more to discover"
    else if (node.lane === 'place') {
      const s = node.id.slice(1);
      state = facts.near(s) || facts.count(node.icon) > 0 ? 'have' : node.recipe && facts.canMake(node.recipe) ? 'ready' : 'locked';
    } else {
      const have = node.id.startsWith('#')
        ? TAGS[node.id.slice(1)].some((k) => facts.count(k) > 0)
        : ITEMS[node.id]?.tool ? facts.hasTool(ITEMS[node.id].tool.type, ITEMS[node.id].tool.tier) : facts.count(node.id) > 0;
      if (have) state = 'have';
      else if (node.lane === 'gather') state = 'gather';
      else state = node.recipe && facts.canMake(node.recipe) ? 'ready' : 'locked';
    }
    out.set(node.id, state);
  }
  return out;
}

/**
 * How far along each column is: the share of its nodes in state 'have' (0..1), and whether its workplace is there.
 * @param {TreeModel} model @param {Map<string, string>} states
 * @returns {Array<{ station: string, done: number, total: number, built: boolean }>}
 */
export function columnProgress(model, states) {
  return (model.stations ?? TREE_STATIONS).map((s, column) => {
    const nodes = model.nodes.filter((n) => n.column === column && n.more === undefined);
    const done = nodes.filter((n) => states.get(n.id) === 'have').length;
    return { station: s, done, total: nodes.length, built: states.get(placeId(s)) === 'have' };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// the reveal (§94.4): what the player has had, can make now, or is one step from; the rest is counted, not drawn
// ---------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} TreeReveal
 * @property {Set<string>} shown      the gather and build nodes shown
 * @property {Set<string>} open       the workplaces in sight: had, makeable now or one step away (their unlocks are shown)
 * @property {boolean[]} reached      per column: anything in it has been had, or something in it could be made, or its
 *   workplace is in sight; an unreached column shows only its head, dim (its name and what it needs)
 * @property {number[]} hidden        per column: how many of its gather and build nodes are not shown
 */

/**
 * Which nodes the player sees (pure). A node is SHOWN when
 *   - it has been HAD: its key is in `had` (every item that has ever entered the pack in this world, survival.had), or it
 *     is had now (`states` 'have'); a tag by any member, a tool by any tool of its kind as good or better, a workplace by
 *     its block item (made, or carried) or by being near;
 *   - or it could be got NOW: makeable now (`states` 'ready'), or raw and its gathering tool (if any) had;
 *   - or it is ONE STEP away: every input and tool of its recipe is had or could be got now, and its workplace is had or
 *     could be built (its recipe all had or got now, where it is built had); a raw thing whose tool could be made now;
 * and its column is REACHED (see TreeReveal). Everything else is hidden; each column counts its hidden ones.
 * @param {TreeModel} model
 * @param {{ states: Map<string, string>, had?: Iterable<string> }} input   `states` from treeStates(model, …)
 * @returns {TreeReveal}
 */
export function revealTree(model, input) {
  const states = input.states;
  const hadKeys = input.had instanceof Set ? input.had : new Set(input.had ?? []);
  /** @type {Map<string, number>} tool type → the best tier had */
  const bestTier = new Map();
  for (const k of hadKeys) {
    const t = ITEMS[k]?.tool;
    if (t && (bestTier.get(t.type) ?? -1) < t.tier) bestTier.set(t.type, t.tier);
  }
  /** @param {TreeNode} n */
  const hadNode = (n) => {
    if (states.get(n.id) === 'have') return true;
    if (n.lane === 'place') return hadKeys.has(n.icon);
    if (n.id.startsWith('#')) return TAGS[n.id.slice(1)].some((k) => hadKeys.has(k));
    const t = ITEMS[n.id]?.tool;
    return t ? (bestTier.get(t.type) ?? -1) >= t.tier : hadKeys.has(n.id);
  };
  /** @type {Map<string, boolean>} */
  const had = new Map(model.nodes.map((n) => [n.id, hadNode(n)]));
  /** @param {string} id a node, or a need with no node (a circuit the tree leaves out): had by its key */
  const hadId = (id) => had.get(id) ?? hadKeys.has(id);
  /** @param {TreeNode} n had, or could be got now */
  const nowNode = (n) => had.get(n.id) || states.get(n.id) === 'ready' || (n.lane === 'gather' && (n.tool === null || hadId(n.tool)));
  /** @param {string} id */
  const nowId = (id) => {
    const n = model.byId.get(id);
    return n ? nowNode(n) : hadKeys.has(id);
  };
  /** @type {Map<string, string[]>} node → what goes into it (its recipe's inputs and tools; a raw thing's tool) */
  const into = new Map();
  for (const [from, to] of model.edges) {
    const list = into.get(to);
    if (list) list.push(from);
    else into.set(to, [from]);
  }
  /** @param {string|null} s @returns {boolean} the workplace `s` is had or could be built */
  const placeOk = (s) => {
    if (!s || s === 'hand') return true;
    const p = model.byId.get(placeId(s));
    if (!p) return false; // not in this tree (the Lab while the circuits are off)
    if (nowNode(p)) return true;
    return p.needs.every(({ id }) => nowId(id)) && (!p.station || p.station === 'hand' || hadId(placeId(p.station)));
  };
  /** @param {TreeNode} n */
  const oneStep = (n) => {
    if (n.lane === 'place') return placeOk(n.id.slice(1));
    if (n.lane === 'gather') return n.tool !== null && nowId(n.tool);
    return (into.get(n.id) ?? []).every(nowId) && placeOk(n.station);
  };
  /** @type {Set<string>} */
  const candidate = new Set(model.nodes.filter((n) => nowNode(n) || oneStep(n)).map((n) => n.id));
  const stations = model.stations ?? TREE_STATIONS;
  const reached = stations.map((_, c) => model.nodes.some((n) => n.column === c
    && (had.get(n.id) || (n.lane !== 'gather' && candidate.has(n.id)))));
  const shown = new Set(model.nodes.filter((n) => n.lane !== 'place' && reached[n.column] && candidate.has(n.id)).map((n) => n.id));
  const open = new Set(model.nodes.filter((n) => n.lane === 'place' && candidate.has(n.id)).map((n) => n.id));
  const hidden = stations.map((_, c) => model.nodes.filter((n) => n.column === c && n.lane !== 'place' && !shown.has(n.id)).length);
  return { shown, open, reached, hidden };
}

/** The id of a revealed column's "N more to discover" marker. @param {string} s */
export function moreId(s) {
  return `?${s}`;
}

/**
 * The tree as the player sees it (pure): every column's head (marked `reached` and `veiled`), the shown nodes, and after
 * them in the build lane a marker `?station` counting the hidden ones (`more`); only the edges between two shown nodes.
 * @param {TreeModel} model @param {TreeReveal} reveal @returns {TreeModel}
 */
export function revealedTree(model, reveal) {
  /** @type {TreeNode[]} */
  const nodes = [];
  const stations = model.stations ?? TREE_STATIONS;
  stations.forEach((s, c) => {
    const head = /** @type {TreeNode} */ (model.byId.get(placeId(s)));
    nodes.push({ ...head, reached: reveal.reached[c], veiled: !reveal.open.has(head.id) });
    for (const n of model.nodes) if (n.column === c && n.lane !== 'place' && reveal.shown.has(n.id)) nodes.push(n);
    const more = reveal.hidden[c];
    if (more > 0) {
      nodes.push({
        id: moreId(s), lane: 'build', column: c, label: `${more} more to discover`, icon: '', recipe: null, station: null,
        how: '', tool: null, depth: 0, unlocks: [], needs: [], more,
      });
    }
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = model.edges.filter(([a, b]) => byId.has(a) && byId.has(b));
  return { nodes, byId, edges, stations };
}

// ---------------------------------------------------------------------------------------------------------------------
// layout (pure): pixel positions for packUI
// ---------------------------------------------------------------------------------------------------------------------

/** Node pitch (px) inside a lane, nodes per row in a column's lane, lane gaps, column gap. */
export const TREE_CELL_W = 108;
export const TREE_CELL_H = 82;
/** The column head: the workplace's hex, its name, what it is built from and what it unlocks. */
export const TREE_HEAD_H = 150;
/** Where in the head the workplace's hex is centred. */
export const TREE_PLACE_Y = 40;
/** At most this many rows a lane in any column (a column grows wider instead), and at most TREE_MAX_PER_ROW across. */
export const TREE_MAX_ROWS = 3;
export const TREE_MAX_PER_ROW = 5;
const COL_GAP = 36;
const LANE_GAP = 14;

/**
 * Where every node goes: columns side by side, each `perRow` nodes wide, each headed by its workplace; the lanes are bands
 * across the whole tree under the heads, each as tall as its fullest column, so a lane reads straight across. Positions
 * are node centres.
 * @param {TreeModel} model
 * @returns {{ width: number, height: number, pos: Map<string, [number, number]>,
 *   columns: Array<{ x: number, w: number }>, lanes: Array<{ lane: string, y: number, h: number }> }}
 */
export function layoutTree(model) {
  const stations = model.stations ?? TREE_STATIONS;
  const cols = stations.map((_, c) => TREE_LANES.map((lane) => model.nodes.filter((n) => n.column === c && n.lane === lane)));
  const perRow = cols.map((lanes) => Math.min(TREE_MAX_PER_ROW, Math.max(2, ...lanes.map((l) => Math.ceil(l.length / TREE_MAX_ROWS)))));
  const rows = TREE_LANES.map((_, li) => Math.max(1, ...cols.map((lanes, c) => Math.ceil(lanes[li].length / perRow[c]))));
  /** @type {Array<{ lane: string, y: number, h: number }>} */
  const lanes = [];
  let y = TREE_HEAD_H;
  TREE_LANES.forEach((lane, li) => {
    const h = rows[li] * TREE_CELL_H;
    lanes.push({ lane, y, h });
    y += h + LANE_GAP;
  });
  const height = y - LANE_GAP + 12;
  /** @type {Array<{ x: number, w: number }>} */
  const columns = [];
  let x = 12;
  for (let c = 0; c < cols.length; c++) {
    const w = perRow[c] * TREE_CELL_W;
    columns.push({ x, w });
    x += w + COL_GAP;
  }
  const width = x - COL_GAP + 12;
  /** @type {Map<string, [number, number]>} */
  const pos = new Map();
  cols.forEach((laneNodes, c) => {
    laneNodes.forEach((list, li) => {
      const n = list.length;
      list.forEach((node, i) => {
        const row = Math.floor(i / perRow[c]);
        const inRow = Math.min(perRow[c], n - row * perRow[c]);
        const k = i - row * perRow[c];
        // centre a short row in its column
        const px = columns[c].x + (columns[c].w - inRow * TREE_CELL_W) / 2 + (k + 0.5) * TREE_CELL_W;
        const py = lanes[li].y + (row + 0.5) * TREE_CELL_H;
        pos.set(node.id, [Math.round(px), Math.round(py)]);
      });
    });
    pos.set(placeId(stations[c]), [Math.round(columns[c].x + columns[c].w / 2), TREE_PLACE_Y]);
  });
  return { width, height, pos, columns, lanes };
}
