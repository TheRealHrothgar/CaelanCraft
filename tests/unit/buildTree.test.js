// §94 the build tree (src/buildTree.js): what to gather and build, workplace by workplace, from the Work Stump to the Lab.
import { describe, it, expect } from 'vitest';
import {
  TREE_STATIONS, TREE_LANES, buildTreeModel, layoutTree, treeStates, columnProgress, gatherOf, toolItemFor, makerOf, placeId,
  TREE_PLACE_Y, TREE_HEAD_H, CIRCUIT_KEYS, CIRCUIT_STATIONS, isCircuitKey, revealTree, revealedTree, moreId,
} from '../../src/buildTree.js';
import { RECIPES, STATION_BLOCKS } from '../../src/crafting.js';
import { ITEMS, ITEM_KEYS as ITEM_KEYS_ALL, TAGS, itemForBlock } from '../../src/items.js';

const model = buildTreeModel();
const node = (id) => model.byId.get(id);
const column = (id) => TREE_STATIONS[node(id).column];

describe('the build tree model (§94)', () => {
  it('has a column per workplace in the order they are reached, each headed by its workplace', () => {
    expect(TREE_STATIONS).toEqual(['stump', 'kiln', 'bloomery', 'forge', 'workbench', 'lab']);
    expect(TREE_LANES).toEqual(['gather', 'build']);
    TREE_STATIONS.forEach((s, c) => {
      const place = node(placeId(s));
      expect(place, s).toBeDefined();
      expect(place.lane).toBe('place');
      expect(place.column).toBe(c);
      expect(place.icon).toBe(itemForBlock(STATION_BLOCKS[s]));
      expect(place.recipe).toBe(makerOf(place.icon).id);
    });
    expect(node('@lab').how).toBe('at the Workbench');
    expect(node('@stump').how).toBe('by hand');
  });

  it('the first column is the way to the Work Stump: a log (an axe fells it), rocks, a stick, cord, the hammerstone and axe', () => {
    const first = model.nodes.filter((n) => n.column === 0).map((n) => n.id).sort();
    expect(first).toEqual(['#log', '@stump', 'cord', 'hammerstone', 'plant_fibre', 'rock', 'stick', 'stone_axe'].sort());
    // §94: a stone tool is a rock head lashed to a stick with cord, knapped with a hammerstone
    for (const dep of ['rock', 'stick', 'cord', 'hammerstone']) expect(model.edges).toContainEqual([dep, 'stone_axe']);
    expect(node('hammerstone')).toMatchObject({ lane: 'build', station: 'hand' });
    expect(node('#log')).toMatchObject({ lane: 'gather', label: 'Any Log', tool: 'stone_axe', how: 'with a Stone Axe' });
    expect(node('rock')).toMatchObject({ lane: 'gather', how: 'picked up', tool: null });
    expect(node('stone_axe')).toMatchObject({ lane: 'build', station: 'hand', how: 'by hand' });
  });

  it('the flint tools sit after the stump, made at it (§94); the elementary circuit parts at the Workbench, before the Lab', () => {
    for (const k of ['flint_pick', 'flint_knife', 'flint_axe']) {
      expect(node(k), k).toMatchObject({ lane: 'build', station: 'stump', how: 'at the Work Stump' });
      expect(node(k).column).toBeGreaterThan(0);
    }
    expect(node('voltaic_battery')).toMatchObject({ lane: 'build', station: 'workbench', column: TREE_STATIONS.indexOf('lab') });
    expect(node('@lab').unlocks.sort()).toEqual(RECIPES.filter((r) => r.station === 'lab').map((r) => r.outputs[0].k).sort());
  });

  it('§100 the bow: no workplace needs it, so the Work Stump shows the stave and the bow among the first six things it unlocks', () => {
    // the head of a column draws its first 6 unlocks as icons (packUI), so the bow is seen as soon as the stump is
    const unlocks = node('@stump').unlocks;
    expect(unlocks.slice(0, 6)).toEqual(expect.arrayContaining(['bow_stave', 'bow']));
    expect(unlocks.indexOf('bow')).toBe(unlocks.indexOf('bow_stave') + 1);
    // what it takes is in the tree already: sticks and cord on the way to the stump, the flint knife on the way on
    for (const k of ['stick', 'cord', 'flint_knife']) expect(model.byId.has(k), k).toBe(true);
    expect(toolItemFor('knife', 2)).toBe('flint_knife');
    expect(toolItemFor('bow', 2)).toBe('bow');
    // neither is a node: the tree is the road to the workplaces; the arrows are made by hand, so no column lists them
    for (const k of ['bow', 'bow_stave', 'arrow']) expect(model.byId.has(k), k).toBe(false);
    for (const s of TREE_STATIONS) expect(node(placeId(s)).unlocks, s).not.toContain('arrow');
  });

  it('every node lands in the column of the first workplace that needs it, and every edge runs from an earlier or equal column', () => {
    for (const [from, to] of model.edges) {
      expect(model.byId.has(from), from).toBe(true);
      expect(model.byId.has(to), to).toBe(true);
      expect(node(from).column, `${from} → ${to}`).toBeLessThanOrEqual(node(to).column);
    }
    // a workplace is never an edge (where a thing is made is its colour: `station`); its own recipe is its `needs`
    expect(model.edges.filter(([a, b]) => a.startsWith('@') || b.startsWith('@'))).toEqual([]);
    for (const s of TREE_STATIONS) {
      const place = node(placeId(s));
      const rec = makerOf(place.icon);
      const want = [
        ...rec.inputs.map((inp) => ({ id: 'tag' in inp ? `#${inp.tag}` : TAGS.log.includes(inp.k) ? '#log' : inp.k, n: inp.n })),
        ...rec.tools.map((tl) => ({ id: toolItemFor(tl.type, tl.tier), n: 0 })),
      ];
      expect(place.needs, s).toEqual(want);
      for (const { id } of place.needs) expect(node(id).column, `${id} for ${s}`).toBeLessThanOrEqual(place.column);
    }
    expect(node('@lab').needs).toContainEqual({ id: 'voltaic_battery', n: 1 });
    expect(node('fired_brick')).toMatchObject({ station: 'kiln', how: 'at the Kiln' });
    expect(column('fired_brick')).toBe('bloomery');
  });

  it('raw materials say how they are got, and which tool that takes, with that tool in the tree', () => {
    expect(gatherOf('rock')).toMatchObject({ how: 'picked up', tool: null, picked: true });
    expect(gatherOf('coal')).toEqual({ how: 'with a Flint Pick', tool: 'flint_pick' });
    expect(gatherOf('cassiterite').tool).toBe('copper_pick'); // tin ore wants copper
    expect(gatherOf('hematite').tool).toBe('bronze_pick'); // iron ore wants bronze
    expect(gatherOf('rawhide')).toEqual({ how: 'from animals', tool: null });
    expect(gatherOf('copper_wire').how).not.toBe('by hand'); // a wire set down and taken up is no source
    for (const n of model.nodes.filter((x) => x.lane === 'gather')) {
      expect(n.how, n.id).not.toBe('');
      if (n.tool !== null) {
        expect(model.byId.has(n.tool), n.id).toBe(true);
        expect(model.edges).toContainEqual([n.tool, n.id]);
      }
    }
    // sticks lie about: gathered, though the stump can split them; charcoal is the Kiln's
    expect(node('stick').lane).toBe('gather');
    expect(node('charcoal')).toMatchObject({ lane: 'build', station: 'kiln' });
    // the salt crust is boiled out of seawater on a campfire
    expect(node('salt_pot').how).toBe('on a campfire');
    expect(model.edges).toContainEqual(['pot_seawater', 'salt_pot']);
  });

  it('a tool need is met by the lowest tool of its kind that is good enough', () => {
    expect(toolItemFor('hammer', 1)).toBe('hammerstone');
    expect(toolItemFor('hammer', 3)).toBe('copper_hammer');
    expect(toolItemFor('hammer', 5)).toBe('iron_hammer');
    expect(toolItemFor('knife', 2)).toBe('flint_knife');
    expect(toolItemFor('crucible', 0)).toBe('crucible');
    expect(toolItemFor('wand', 1)).toBeNull();
  });
});

describe('the build tree state (§94)', () => {
  const facts = (have = {}, ready = [], near = []) => ({
    count: (k) => have[k] ?? 0,
    hasTool: (type, tier) => Object.keys(have).some((k) => ITEMS[k]?.tool && ITEMS[k].tool.type === type && ITEMS[k].tool.tier >= tier),
    canMake: (id) => ready.includes(id),
    near: (s) => near.includes(s),
  });

  it('have, ready, gather, locked', () => {
    const states = treeStates(model, facts({ rock: 3, flint_pick: 1, oak_log: 2 }, ['hammerstone'], []));
    expect(states.get('rock')).toBe('have');
    expect(states.get('#log')).toBe('have'); // any member of the tag
    expect(states.get('hammerstone')).toBe('ready');
    expect(states.get('stone_axe')).toBe('locked');
    expect(states.get('plant_fibre')).toBe('gather');
    expect(states.get('flint_knife')).toBe('locked');
    expect(states.get('flint_axe')).toBe('locked');
    // a better tool counts: a copper pick is a flint pick and more
    expect(treeStates(model, facts({ copper_pick: 1 })).get('flint_pick')).toBe('have');
    // a workplace near (or carried) is had
    expect(treeStates(model, facts({}, [], ['kiln'])).get('@kiln')).toBe('have');
    expect(treeStates(model, facts({ work_stump: 1 })).get('@stump')).toBe('have');
    expect(treeStates(model, facts({}, ['work_stump'])).get('@stump')).toBe('ready');
  });

  it('columns count what is had, and know when their workplace is there', () => {
    const states = treeStates(model, facts({ rock: 1, oak_log: 1, hammerstone: 1, stone_axe: 1, stick: 1, cord: 1, plant_fibre: 1 }, [], ['stump']));
    const p = columnProgress(model, states);
    expect(p.map((c) => c.station)).toEqual(TREE_STATIONS);
    expect(p[0]).toEqual({ station: 'stump', done: 8, total: 8, built: true });
    expect(p[5].built).toBe(false);
  });
});

describe('the build tree layout (§94)', () => {
  const layout = layoutTree(model);
  it('puts every node once, inside its column and its lane (a workplace in its column\'s head), never two on one spot', () => {
    const seen = new Set();
    for (const n of model.nodes) {
      const at = layout.pos.get(n.id);
      expect(at, n.id).toBeDefined();
      const key = at.join(',');
      expect(seen.has(key), n.id).toBe(false);
      seen.add(key);
      const col = layout.columns[n.column];
      expect(at[0]).toBeGreaterThan(col.x);
      expect(at[0]).toBeLessThan(col.x + col.w);
      if (n.lane === 'place') {
        expect(at).toEqual([Math.round(col.x + col.w / 2), TREE_PLACE_Y]);
        continue;
      }
      const lane = layout.lanes[TREE_LANES.indexOf(n.lane)];
      expect(at[1]).toBeGreaterThan(lane.y);
      expect(at[1]).toBeLessThan(lane.y + lane.h);
    }
  });
  it('lanes run top to bottom (gather, build, workplace), columns left to right, and the whole fits a laptop screen in height', () => {
    expect(layout.lanes.map((l) => l.lane)).toEqual(TREE_LANES);
    expect(layout.lanes[0].y).toBe(TREE_HEAD_H);
    for (let i = 1; i < layout.lanes.length; i++) expect(layout.lanes[i].y).toBeGreaterThan(layout.lanes[i - 1].y + layout.lanes[i - 1].h - 1);
    for (let i = 1; i < layout.columns.length; i++) expect(layout.columns[i].x).toBeGreaterThan(layout.columns[i - 1].x + layout.columns[i - 1].w);
    expect(layout.height).toBeLessThanOrEqual(640);
    expect(layout.width).toBe(layout.columns.at(-1).x + layout.columns.at(-1).w + 12);
  });
  it('is the same every time (pure)', () => {
    const again = layoutTree(buildTreeModel());
    expect([...again.pos]).toEqual([...layout.pos]);
    expect(buildTreeModel().edges).toEqual(model.edges);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// §94.4: the circuits switch, and the tree revealing itself
// ---------------------------------------------------------------------------------------------------------------------

/** TreeFacts from what is carried (`have`), the recipes that could start (`ready`) and the workplaces near (`near`). */
const factsOf = (have = {}, ready = [], near = []) => ({
  count: (k) => have[k] ?? 0,
  hasTool: (type, tier) => Object.keys(have).some((k) => ITEMS[k]?.tool && ITEMS[k].tool.type === type && ITEMS[k].tool.tier >= tier),
  canMake: (id) => ready.includes(id),
  near: (s) => near.includes(s),
});
/** The reveal of `m` for a player carrying `have` (all of it had) and having had `had` besides. */
const revealFor = (m, { have = {}, ready = [], near = [], had = [] } = {}) => {
  const states = treeStates(m, factsOf(have, ready, near));
  return revealTree(m, { states, had: [...Object.keys(have), ...had] });
};
const shownIn = (m, rv, s) => m.nodes.filter((n) => n.column === m.stations.indexOf(s) && rv.shown.has(n.id)).map((n) => n.id).sort();
const everything = () => Object.fromEntries(ITEM_KEYS_ALL.map((k) => [k, 1]));

describe('the build tree with the circuits off (§94.4)', () => {
  const off = buildTreeModel({ circuits: false });
  it('the circuit keys: every electric part, the materials only they take, and the Lab; what burns is not a circuit', () => {
    expect(CIRCUIT_KEYS).toEqual(['blasting_machine', 'brown_wire', 'carbon_filament', 'clockwork_timer', 'coherer_receiver',
      'copper_wire', 'earth_wire', 'electric_bell', 'filament_lamp', 'igniter', 'iron_filings', 'knife_switch', 'lab', 'push_button',
      'relay', 'selenium', 'selenium_panel', 'spark_transmitter', 'terminal_board', 'voltaic_battery', 'white_wire']);
    for (const k of ['black_powder', 'powder_fuse', 'powder_keg', 'torch', 'sulfur', 'saltpetre', 'campfire', 'collapsar_charge']) {
      expect(isCircuitKey(k), k).toBe(false);
    }
    for (const k of CIRCUIT_KEYS) expect(ITEMS[k], k).toBeDefined();
    // everything made at the Workbench and the Lab is a circuit part or device (or the Lab itself)
    for (const r of RECIPES.filter((x) => x.station === 'workbench' || x.station === 'lab')) expect(isCircuitKey(r.outputs[0].k), r.id).toBe(true);
    expect(CIRCUIT_STATIONS).toEqual(['lab']);
  });

  it('has no Lab column, no circuit node, edge or unlock; the default (on) tree is the whole one', () => {
    expect(off.stations).toEqual(['stump', 'kiln', 'bloomery', 'forge', 'workbench']);
    expect(model.stations).toEqual(TREE_STATIONS);
    expect(buildTreeModel({ circuits: true }).edges).toEqual(model.edges);
    expect(off.byId.has('@lab')).toBe(false);
    for (const n of off.nodes) {
      expect(isCircuitKey(n.id), n.id).toBe(false);
      expect(n.column).toBeLessThan(off.stations.length);
      for (const k of n.unlocks) expect(isCircuitKey(k), `${n.id} unlocks ${k}`).toBe(false);
    }
    for (const [a, b] of off.edges) expect(isCircuitKey(a) || isCircuitKey(b), `${a} → ${b}`).toBe(false);
    // only reached through circuits: the copper wire, the copper hammer that draws it, the battery and the Lab
    expect(model.nodes.filter((n) => !off.byId.has(n.id)).map((n) => n.id).sort()).toEqual(['@lab', 'copper_hammer', 'copper_wire', 'voltaic_battery']);
    expect(off.byId.get('@workbench').unlocks).toEqual([]); // it makes nothing else yet
    expect(off.byId.get('@stump').unlocks).toEqual(expect.arrayContaining(['black_powder', 'powder_keg']));
    expect(off.byId.get('@stump').unlocks).not.toContain('iron_filings');
    // a workplace's recipe stays whole: the Workbench is still built with copper wire (an icon, with no node)
    expect(off.byId.get('@workbench').needs).toEqual(model.byId.get('@workbench').needs);
    expect(off.byId.get('@workbench').needs).toContainEqual({ id: 'copper_wire', n: 12 });
  });

  it('lays out in its five columns, and everything had shows none of the circuits', () => {
    const rv = revealFor(off, { have: everything(), near: [...off.stations] });
    const t = revealedTree(off, rv);
    expect(rv.hidden).toEqual([0, 0, 0, 0, 0]);
    expect(t.nodes.length).toBe(off.nodes.length);
    for (const n of t.nodes) expect(isCircuitKey(n.id), n.id).toBe(false);
    const layout = layoutTree(t);
    expect(layout.columns).toHaveLength(5);
    expect(layout.height).toBeLessThanOrEqual(640);
  });
});

describe('the build tree reveals itself (§94.4)', () => {
  it('at the start of a world only the first steps show: what lies about, and cord and the hammerstone from it', () => {
    const rv = revealFor(model, { have: { handbook: 1 } });
    expect([...rv.shown].sort()).toEqual(['cord', 'hammerstone', 'plant_fibre', 'rock', 'stick']);
    expect(rv.reached).toEqual([true, false, false, false, false, false]);
    expect(rv.open.size).toBe(0);
    // every column counts what is still hidden
    expect(rv.hidden[0]).toBe(2); // the stone axe and a log
    TREE_STATIONS.forEach((s, c) => {
      const all = model.nodes.filter((n) => n.column === c && n.lane !== 'place').length;
      expect(rv.hidden[c] + model.nodes.filter((n) => n.column === c && rv.shown.has(n.id)).length, s).toBe(all);
    });
    // what lies about in a column not reached yet (flint, rawhide, sand) waits for its column
    for (const k of ['#knapstone', 'rawhide', '#sand', '#tinder']) expect(rv.shown.has(k), k).toBe(false);
  });

  it('after gathering: the stone axe (its rocks, stick and cord to hand), and the fire drill opens the campfire\'s column', () => {
    const rv = revealFor(model, { have: { rock: 5, stick: 4, plant_fibre: 6 }, ready: ['cord', 'hammerstone'] });
    expect(shownIn(model, rv, 'stump')).toEqual(['cord', 'hammerstone', 'plant_fibre', 'rock', 'stick', 'stone_axe']);
    expect(rv.shown.has('#log')).toBe(false); // it takes an axe nobody has yet
    expect(rv.reached[TREE_STATIONS.indexOf('workbench')]).toBe(true);
    expect(shownIn(model, rv, 'workbench')).toEqual(['#sand', '#tinder', 'fire_drill']);
    // made the cord and the hammerstone: the axe is makeable, so a log is a step away, and the wooden shovel
    const on = revealFor(model, { have: { rock: 5, stick: 4, cord: 2, hammerstone: 1 }, ready: ['stone_axe'] });
    expect(on.shown.has('#log')).toBe(true);
    expect(on.hidden[0]).toBe(0);
    expect(shownIn(model, on, 'kiln')).toEqual(['wooden_shovel']);
    // what has been had stays shown with nothing carried
    const later = revealFor(model, { had: ['rock', 'stick', 'plant_fibre', 'cord', 'hammerstone', 'stone_axe'] });
    for (const k of ['stone_axe', 'cord', '#log', 'wooden_shovel']) expect(later.shown.has(k), k).toBe(true);
  });

  it('after building the Work Stump: what is made at it comes into sight (the flint tools), and the stump is set up', () => {
    const had = ['rock', 'stick', 'plant_fibre', 'cord', 'hammerstone', 'stone_axe', 'oak_log', 'flint', 'work_stump'];
    const before = revealFor(model, { had: ['rock', 'stick', 'plant_fibre', 'cord', 'hammerstone'] });
    expect(before.shown.has('flint_knife')).toBe(false); // the stump is not in sight yet (no axe had, so no log)
    expect(before.open.has('@stump')).toBe(false);
    const axe = revealFor(model, { had: ['rock', 'stick', 'plant_fibre', 'cord', 'hammerstone', 'stone_axe'] });
    expect(axe.open.has('@stump')).toBe(true); // an axe had: a log can be got, so the stump is a step away
    const rv = revealFor(model, { had, near: ['stump'] });
    expect(rv.open.has('@stump')).toBe(true);
    expect(rv.reached[TREE_STATIONS.indexOf('bloomery')]).toBe(true);
    for (const k of ['flint_knife', 'flint_axe', 'flint_pick', '#knapstone']) expect(rv.shown.has(k), k).toBe(true);
    expect(rv.shown.has('leather')).toBe(false); // it wants the flint knife, which is only in sight
    expect(rv.shown.has('wooden_shovel')).toBe(true);
    expect(rv.shown.has('fired_brick')).toBe(false);
    // the Forge and the Lab are dim heads still (the Workbench's column is open: the fire drill is in it)
    expect(rv.reached.slice(3)).toEqual([false, true, false]);
    expect(rv.shown.has('fire_drill')).toBe(true);
  });

  it('a tool counts as had when a better one of its kind was; a tag by any member; a workplace by being near', () => {
    const rv = revealFor(model, { had: ['copper_axe', 'birch_log'] });
    expect(rv.shown.has('stone_axe')).toBe(true); // had: a copper axe is a stone axe and more
    expect(rv.shown.has('#log')).toBe(true); // a birch log is any log
    const near = revealFor(model, { near: ['kiln'] });
    expect(near.open.has('@kiln')).toBe(true);
    expect(near.reached[1]).toBe(true);
  });

  it('the revealed tree: every head (reached or dim, unlocks veiled), the shown nodes, a "more" marker, no edge to a hidden node', () => {
    const rv = revealFor(model, { have: { rock: 5, stick: 4, plant_fibre: 6 }, ready: ['cord', 'hammerstone'] });
    const t = revealedTree(model, rv);
    expect(t.stations).toEqual(TREE_STATIONS);
    for (const s of TREE_STATIONS) expect(t.byId.has(placeId(s)), s).toBe(true);
    expect(t.byId.get('@stump')).toMatchObject({ reached: true, veiled: true });
    expect(t.byId.get('@forge')).toMatchObject({ reached: false, veiled: true, needs: model.byId.get('@forge').needs });
    expect(t.byId.get(moreId('stump'))).toMatchObject({ lane: 'build', column: 0, more: 1, label: '1 more to discover' });
    expect(t.byId.get(moreId('forge')).more).toBe(17);
    expect(t.nodes.filter((n) => n.more !== undefined).length).toBe(rv.hidden.filter((h) => h > 0).length);
    // edges only between two shown nodes: the cord leads to the stone axe, never to the hidden flint tools
    for (const [a, b] of t.edges) {
      expect(t.byId.has(a) && t.byId.has(b), `${a} → ${b}`).toBe(true);
      expect(a.startsWith('?') || b.startsWith('?')).toBe(false);
    }
    expect(t.edges).toContainEqual(['cord', 'stone_axe']);
    expect(t.edges.some(([a, b]) => a === 'cord' && b === 'flint_knife')).toBe(false);
    // a shown node whose only uses are hidden has no edge at all (the fire drill: the campfire is not in sight yet)
    expect(t.byId.has('fire_drill')).toBe(true);
    expect(t.edges.filter(([a]) => a === 'fire_drill')).toEqual([]);
    // the shared model is not changed
    expect(model.byId.get('@stump').reached).toBeUndefined();
    // the marker has its own state; progress counts the column without it
    expect(treeStates(t, factsOf()).get(moreId('stump'))).toBe('more');
    expect(columnProgress(t, new Map()).map((p) => p.total)).toEqual(TREE_STATIONS.map((_, c) => t.nodes.filter((n) => n.column === c && n.more === undefined).length));
    // laid out: every shown node once, inside its column, the marker in the build lane
    const layout = layoutTree(t);
    const seen = new Set();
    for (const n of t.nodes) {
      const at = layout.pos.get(n.id);
      expect(at, n.id).toBeDefined();
      expect(seen.has(at.join(',')), n.id).toBe(false);
      seen.add(at.join(','));
      expect(at[0]).toBeGreaterThan(layout.columns[n.column].x);
      expect(at[0]).toBeLessThan(layout.columns[n.column].x + layout.columns[n.column].w);
    }
    const build = layout.lanes[TREE_LANES.indexOf('build')];
    const mark = layout.pos.get(moreId('stump'));
    expect(mark[1]).toBeGreaterThan(build.y);
    expect(mark[1]).toBeLessThan(build.y + build.h);
  });

  it('with everything had, nothing is hidden and the revealed tree is the whole tree', () => {
    const rv = revealFor(model, { have: everything(), near: [...TREE_STATIONS] });
    expect(rv.hidden).toEqual(TREE_STATIONS.map(() => 0));
    expect(rv.reached.every(Boolean)).toBe(true);
    const t = revealedTree(model, rv);
    expect(t.nodes.map((n) => n.id).sort()).toEqual(model.nodes.map((n) => n.id).sort());
    expect(t.edges).toEqual(model.edges);
    for (const s of TREE_STATIONS) expect(t.byId.get(placeId(s)).veiled, s).toBe(false);
  });
});
