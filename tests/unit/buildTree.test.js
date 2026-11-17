// §94 the build tree (src/buildTree.js): what to gather and build, workplace by workplace, from the Work Stump to the Lab.
import { describe, it, expect } from 'vitest';
import {
  TREE_STATIONS, TREE_LANES, buildTreeModel, layoutTree, treeStates, columnProgress, gatherOf, toolItemFor, makerOf, placeId,
  TREE_PLACE_Y, TREE_HEAD_H,
} from '../../src/buildTree.js';
import { RECIPES, STATION_BLOCKS } from '../../src/crafting.js';
import { ITEMS, TAGS, itemForBlock } from '../../src/items.js';

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

  it('§100 the bows: no workplace needs them, so each shows among what its workplace unlocks; the arrows by their workplaces', () => {
    // the head of a column draws its first 6 unlocks as icons (packUI), so the Crude Bow is seen as soon as the stump is
    const unlocks = node('@stump').unlocks;
    expect(unlocks.slice(0, 6)).toEqual(expect.arrayContaining(['crude_bow', 'bow_stave']));
    expect(unlocks.indexOf('bow_stave')).toBe(unlocks.indexOf('crude_bow') + 1);
    // what it takes is in the tree already: cord on the way to the stump, the flint knife on the way on (the sapling is
    // gathered by hand, from leaves)
    for (const k of ['stick', 'cord', 'flint_knife']) expect(model.byId.has(k), k).toBe(true);
    expect(toolItemFor('knife', 2)).toBe('flint_knife');
    expect(toolItemFor('bow', 2)).toBe('crude_bow');
    expect(toolItemFor('bow', 3)).toBe('recurve_bow');
    expect(toolItemFor('knife', 3)).toBe('copper_knife');
    // the Treated Stave and the cast arrows at the Kiln, the forged ones at the Forge, the Recurve Bow and (§103) the
    // Spyglass at the Workbench
    expect(node('@kiln').unlocks).toEqual(expect.arrayContaining(['treated_stave', 'copper_arrow', 'bronze_arrow']));
    expect(node('@forge').unlocks).toEqual(expect.arrayContaining(['iron_arrow', 'steel_arrow']));
    expect(node('@workbench').unlocks).toEqual(expect.arrayContaining(['recurve_bow', 'spyglass']));
    // none is a node: the tree is the road to the workplaces; the stone and flint arrows are made by hand, so no column lists them
    for (const k of ['crude_bow', 'recurve_bow', 'bow_stave', 'treated_stave', 'sapling', 'spyglass', 'flint_arrow']) expect(model.byId.has(k), k).toBe(false);
    for (const s of TREE_STATIONS) for (const k of ['stone_arrow', 'flint_arrow']) expect(node(placeId(s)).unlocks, s).not.toContain(k);
    // where a sapling comes from, if it is asked: picked up (a hazel thicket's), with no tool
    expect(gatherOf('sapling')).toMatchObject({ tool: null });
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
