// Unit tests for src/circuitParts.js — docs/DESIGN-circuits.md §1.5, §4.2–§4.6, §4.8, §4.13, §6.2.1 and the K0 list of §7.
// Block ids are written as BLOCK.X (§1.3: only wave0.test.js may hold a numeric block id).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BLOCK, BLOCKS, UNLOADED, BLOCK_ALIASES, LAYER_CUTOUT, isMeshed, isOpaque, isSolid } from '../../src/blocks.js';
import { FACE_OPPOSITE, FACE_NORMALS } from '../../src/hex.js';
import * as C from '../../src/config.js';
import {
  WIRE_KINDS, PARTS, partOf, partByKey, isPart, isFlame, isIgnitable, isControl, isEarth, buildEarthTable, signalKind,
  conductorAccepts, joins, liveFaces, sidesTouch, DEFAULT_INPUT_FACE, inputFaceFromYaw, wavelengthOf, parseChannel, partTip,
  partOrigin,
} from '../../src/circuitParts.js';

const B = BLOCK;
const ALL_IDS = Array.from({ length: 256 }, (_, i) => i);
const JUNK = [-1, 256, 1.5, NaN, Infinity, '97', '__proto__', 'length', null, undefined, {}];
const ROLES = ['wire', 'junction', 'source', 'contact', 'load', 'fuse', 'flame', 'ignitable'];
/** The store fields of §4.8, in their canonical JSON order (§6.4). */
const STORE_FIELDS = ['l', 'on', 'nc', 'f', 's', 'm', 'run', 'ch', 'c'];

/** The 20 new blocks (§1.2), in id order. */
const NEW_KEYS = [
  'COLLAPSAR_CHARGE', 'POWDER_FUSE', 'TORCH', 'COPPER_WIRE', 'BROWN_WIRE', 'WHITE_WIRE', 'EARTH_WIRE', 'TERMINAL_BOARD',
  'VOLTAIC_BATTERY', 'BLASTING_MACHINE', 'SELENIUM_PANEL', 'KNIFE_SWITCH', 'PUSH_BUTTON', 'CLOCKWORK_TIMER', 'RELAY',
  'IGNITER', 'FILAMENT_LAMP', 'ELECTRIC_BELL', 'SPARK_TRANSMITTER', 'COHERER_RECEIVER',
];
const NEW_IDS = NEW_KEYS.map((k) => B[k]);
const THIN_KEYS = ['POWDER_FUSE', 'TORCH', 'COPPER_WIRE', 'BROWN_WIRE', 'WHITE_WIRE', 'EARTH_WIRE'];
const CAB_KEYS = NEW_KEYS.filter((k) => !THIN_KEYS.includes(k));

/**
 * The part table of §4.2 (Linstock → Torch, by the user's decision), with the §4.8 store fields: [BLOCK key, PartDef minus
 * id, origin and tip]. `input`, `earth` and `control` default to false and `fields` to [].
 */
const TABLE = [
  ['COLLAPSAR_CHARGE', { key: 'charge', role: 'ignitable', fields: ['l'] }],
  ['POWDER_FUSE', { key: 'fuse', role: 'fuse' }],
  ['TORCH', { key: 'torch', role: 'flame' }],
  ['COPPER_WIRE', { key: 'copper_wire', role: 'wire', wire: 'copper' }],
  ['BROWN_WIRE', { key: 'brown_wire', role: 'wire', wire: 'brown' }],
  ['WHITE_WIRE', { key: 'white_wire', role: 'wire', wire: 'white' }],
  ['EARTH_WIRE', { key: 'earth_wire', role: 'wire', wire: 'earth' }],
  ['TERMINAL_BOARD', { key: 'terminal', role: 'junction', fields: ['l'] }],
  ['VOLTAIC_BATTERY', { key: 'battery', role: 'source', volts: 6, earth: true, fields: ['l', 'c'] }],
  ['BLASTING_MACHINE', { key: 'blaster', role: 'source', volts: 24, earth: true, control: true, fields: ['l'] }],
  ['SELENIUM_PANEL', { key: 'selenium', role: 'source', volts: 3, earth: true, fields: ['l'] }],
  ['KNIFE_SWITCH', { key: 'switch', role: 'contact', control: true, fields: ['l', 'on'] }],
  ['PUSH_BUTTON', { key: 'button', role: 'contact', control: true, fields: ['l', 'nc'] }],
  ['CLOCKWORK_TIMER', {
    key: 'timer', role: 'contact', vMin: 2.5, amps: 0, input: true, earth: true, control: true,
    fields: ['l', 'on', 'f', 's', 'm', 'run'],
  }],
  ['RELAY', { key: 'relay', role: 'contact', vMin: 2.5, amps: 0.5, input: true, earth: true, fields: ['l', 'nc', 'f'] }],
  ['IGNITER', { key: 'igniter', role: 'load', vMin: 3, amps: 2, earth: true, fields: ['l'] }],
  ['FILAMENT_LAMP', { key: 'lamp', role: 'load', vMin: 1.5, amps: 1, earth: true, fields: ['l'] }],
  ['ELECTRIC_BELL', { key: 'bell', role: 'load', vMin: 2.5, amps: 1, earth: true, fields: ['l'] }],
  ['SPARK_TRANSMITTER', { key: 'tx', role: 'load', vMin: 2.5, amps: 0.5, earth: true, control: true, fields: ['l', 'ch'] }],
  ['COHERER_RECEIVER', {
    key: 'rx', role: 'contact', vMin: 2.5, amps: 0.5, input: true, earth: true, fields: ['l', 'on', 'f', 'm', 'ch'],
  }],
  ['POWDER_KEG', { key: 'keg', role: 'ignitable' }],
  ['CAMPFIRE', { key: 'campfire', role: 'flame' }],
];

/** The tips are normative text (§4.13); the Torch's is the Linstock's rewritten for the torch (the user-decision note). */
const TIPS = {
  COPPER_WIRE: 'Current flowing through a wire loses a little voltage in every cell (V = I × R). More lamps on one wire draw more current, and they all get dimmer. With nothing switched on, the whole wire sits at the battery\'s voltage.',
  BROWN_WIRE: 'Brown means live and green-and-yellow means earth: today\'s wiring colours. Insulation lets two circuits run side by side; join them on a Terminal Board.',
  WHITE_WIRE: 'Brown means live and green-and-yellow means earth: today\'s wiring colours. Insulation lets two circuits run side by side; join them on a Terminal Board.',
  EARTH_WIRE: 'Green and yellow means earth. Devices on wooden floors need a path to the ground: run this down to natural soil or stone.',
  TERMINAL_BOARD: 'A board of brass binding posts: every wire screwed to it is joined, whatever its insulation.',
  VOLTAIC_BATTERY: 'Volta\'s pile (1800): each copper–tin pair gives about half a volt; twelve make six. Stack batteries to add volts (series); wire them side by side to last longer (parallel). It tires, then runs down.',
  BLASTING_MACHINE: 'Push the plunger: a hand-spun magneto makes a short 24 V pulse, enough to fire an igniter far away. Quarries and mines used these.',
  SELENIUM_PANEL: 'Fritts\' selenium panel (1883): six cells under see-through gold leaf, about half a volt each, make up to 3 V in open sun and none at night. Too weak for a lamp, enough for a relay.',
  KNIFE_SWITCH: 'The classic laboratory switch: a copper blade bridges the gap. On a hex, cells on neighbouring faces touch each other, so run the wires out of opposite faces.',
  PUSH_BUTTON: 'A momentary switch: closed only while you hold it down. An NC button is the opposite: it opens while held, which makes a stop button.',
  CLOCKWORK_TIMER: 'A wound spring runs the clock; when it runs down, its contacts close. Pulse closes for a second, Hold stays closed, Repeat makes a clock.',
  RELAY: 'Joseph Henry\'s relay (1835): a weak current in the coil pulls an iron arm that closes a second circuit with its own battery. Keep that battery away from the input face. NC contacts open when the coil pulls.',
  IGNITER: 'A thin wire glows red-hot when current flows (at least 3 V) and lights the powder beside it. It draws a lot of current, so keep its wire short.',
  FILAMENT_LAMP: 'A carbon filament glows when current heats it (Swan and Edison, 1879). A dim lamp means a long wire, a shared wire or a tired battery.',
  ELECTRIC_BELL: 'Its magnet pulls the hammer, which breaks the circuit, springs back and closes it again: a relay that interrupts itself.',
  SPARK_TRANSMITTER: 'A spark jumping a gap sends a radio wave (Marconi, 1895). Tune it to a wavelength; a receiver on the same wavelength hears it. 600 m was the distress wavelength.',
  COHERER_RECEIVER: 'Iron filings in a glass tube cling together when a radio wave arrives and let current through. A second wave cannot open it; only a tap can.',
  POWDER_FUSE: 'Safety fuse: a thread of black powder sealed in tarred twine (Bickford, 1831). It burns at a steady speed, about 1 cm a second in real life, even under water, and is used up. Ours burns 2.5 cells a second.',
  POWDER_KEG: 'Black powder is 75 % saltpetre, 15 % charcoal and 10 % sulfur. When the flame reaches the powder, it goes off at once. Kegs were hooped with copper or wood, never iron, so a knock could not strike a spark.',
  COLLAPSAR_CHARGE: 'In the 1960s, before John Wheeler\'s name "black hole" caught on (1967), astronomers spoke of collapsars. A fuse, an igniter or a radio pulse sets this one off; then walk straight away.',
};

/** The parts (isPart): the 20 new blocks and the keg. */
const PART_IDS = [...NEW_IDS, B.POWDER_KEG];

describe('PARTS and partOf (§4.2)', () => {
  it('holds exactly the 20 new ids, the Powder Keg and the Campfire (as a flame), each matching the §4.2 / §4.8 table', () => {
    expect(TABLE.map(([k]) => k)).toEqual([...NEW_KEYS, 'POWDER_KEG', 'CAMPFIRE']);
    expect(Object.keys(PARTS).map(Number).sort((a, b) => a - b)).toEqual(TABLE.map(([k]) => B[k]).sort((a, b) => a - b));
    for (const [blockKey, row] of TABLE) {
      const id = B[blockKey];
      expect(PARTS[id], blockKey).toEqual({
        id, input: false, earth: false, control: false, fields: [], ...row,
        origin: expect.any(String), tip: expect.any(String),
      });
      expect(partOf(id), blockKey).toBe(PARTS[id]);
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(PARTS)).toBe(true);
    for (const def of Object.values(PARTS)) {
      expect(Object.isFrozen(def), def.key).toBe(true);
      expect(Object.isFrozen(def.fields), def.key).toBe(true);
    }
    expect(Object.isFrozen(WIRE_KINDS)).toBe(true);
    expect(() => {
      PARTS[B.RELAY].vMin = 0;
    }).toThrow();
  });

  it('every new id has a PartDef; keys are unique; roles are valid; every part has an origin', () => {
    for (const id of NEW_IDS) expect(partOf(id), BLOCKS[id].name).not.toBeNull();
    const defs = Object.values(PARTS);
    expect(new Set(defs.map((d) => d.key)).size).toBe(defs.length);
    for (const d of defs) {
      expect(ROLES, d.key).toContain(d.role);
      expect(d.key, d.key).toMatch(/^[a-z][a-z_]*$/);
    }
    for (const id of PART_IDS) {
      expect(partOf(id).origin.length, BLOCKS[id].name).toBeGreaterThan(0);
      expect(partOf(id).origin, BLOCKS[id].name).toBe(partOf(id).origin.trim());
    }
  });

  it('optional fields appear only where they mean something: wire on wires, volts on sources, vMin and amps on loads and inputs', () => {
    for (const d of Object.values(PARTS)) {
      expect('wire' in d, d.key).toBe(d.role === 'wire');
      if (d.role === 'wire') expect(WIRE_KINDS, d.key).toContain(d.wire);
      expect('volts' in d, d.key).toBe(d.role === 'source');
      const loadLike = d.role === 'load' || d.input;
      expect('vMin' in d && 'amps' in d, d.key).toBe(loadLike);
      expect(('vMin' in d) === ('amps' in d), d.key).toBe(true);
      // Inputs are contacts; only sources, loads and inputs need earth.
      if (d.input) expect(d.role, d.key).toBe('contact');
      expect(d.earth, d.key).toBe(d.role === 'source' || loadLike);
    }
    // Every wire kind is used exactly once.
    expect(Object.values(PARTS).filter((d) => d.role === 'wire').map((d) => d.wire)).toEqual([...WIRE_KINDS]);
  });

  it('the numbers come from config (§4.2 constants)', () => {
    expect(partOf(B.VOLTAIC_BATTERY).volts).toBe(C.BATTERY_V);
    expect(partOf(B.BLASTING_MACHINE).volts).toBe(C.BLASTER_V);
    expect(partOf(B.SELENIUM_PANEL).volts).toBe(C.SELENIUM_MAX_V);
    expect([partOf(B.FILAMENT_LAMP).vMin, partOf(B.FILAMENT_LAMP).amps]).toEqual([C.LAMP_MIN_V, C.LAMP_AMPS]);
    expect([partOf(B.IGNITER).vMin, partOf(B.IGNITER).amps]).toEqual([C.IGNITER_MIN_V, C.IGNITER_AMPS]);
    expect([partOf(B.ELECTRIC_BELL).vMin, partOf(B.ELECTRIC_BELL).amps]).toEqual([C.COIL_MIN_V, C.BELL_AMPS]);
    for (const k of ['RELAY', 'SPARK_TRANSMITTER', 'COHERER_RECEIVER']) {
      expect([partOf(B[k]).vMin, partOf(B[k]).amps], k).toEqual([C.COIL_MIN_V, C.COIL_AMPS]);
    }
    expect([partOf(B.CLOCKWORK_TIMER).vMin, partOf(B.CLOCKWORK_TIMER).amps]).toEqual([C.COIL_MIN_V, 0]); // a mechanical latch
  });

  it('fields lists only §4.8 store fields, in canonical order; every device (cabinet) has a label and nothing else does', () => {
    for (const d of Object.values(PARTS)) {
      for (const f of d.fields) expect(STORE_FIELDS, `${d.key}.${f}`).toContain(f);
      const order = d.fields.map((f) => STORE_FIELDS.indexOf(f));
      expect(order, d.key).toEqual([...order].sort((a, b) => a - b));
      expect(new Set(d.fields).size, d.key).toBe(d.fields.length);
    }
    const labelled = Object.values(PARTS).filter((d) => d.fields.includes('l')).map((d) => d.id).sort((a, b) => a - b);
    expect(labelled).toEqual(CAB_KEYS.map((k) => B[k]).sort((a, b) => a - b));
    // The input face is stored exactly for the parts with an input.
    for (const d of Object.values(PARTS)) expect(d.fields.includes('f'), d.key).toBe(d.input);
    // nc only on the button and the relay (§7 B); ch only on the radio pair; c only on the battery.
    const holders = (f) => Object.values(PARTS).filter((d) => d.fields.includes(f)).map((d) => d.key).sort();
    expect(holders('nc')).toEqual(['button', 'relay']);
    expect(holders('ch')).toEqual(['rx', 'tx']);
    expect(holders('c')).toEqual(['battery']);
    expect(holders('on')).toEqual(['rx', 'switch', 'timer']);
    expect(holders('m')).toEqual(['rx', 'timer']);
    expect(holders('s')).toEqual(['timer']);
    expect(holders('run')).toEqual(['timer']);
  });

  it('partOf is null for every other id, UNLOADED and garbage', () => {
    const indexed = new Set(TABLE.map(([k]) => B[k]));
    for (const id of ALL_IDS) if (!indexed.has(id)) expect(partOf(id), String(id)).toBeNull();
    expect(partOf(UNLOADED)).toBeNull();
    for (const bad of JUNK) expect(partOf(bad), String(bad)).toBeNull();
  });

  it('partByKey maps every store kind back to its part; the campfire and unknown kinds give null', () => {
    for (const id of PART_IDS) expect(partByKey(partOf(id).key), BLOCKS[id].name).toBe(partOf(id));
    expect(partByKey('campfire')).toBeNull();
    for (const bad of ['', 'linstock', 'blast_barrel', 'Battery', 'toString', '__proto__', 'constructor', 7, null, undefined, {}]) {
      expect(partByKey(bad), String(bad)).toBeNull();
    }
  });

  it('isPart is exactly the 20 new blocks and the Powder Keg (the Campfire is only indexed as a flame)', () => {
    expect(ALL_IDS.filter(isPart)).toEqual([...PART_IDS].sort((a, b) => a - b));
    expect(isPart(B.CAMPFIRE)).toBe(false);
    for (const bad of JUNK) expect(isPart(bad), String(bad)).toBe(false);
  });

  it('the Torch is the design\'s Linstock under the user\'s name: key torch, a flame, block "Torch"', () => {
    const torch = partOf(B.TORCH);
    expect([torch.key, torch.role, torch.fields.length]).toEqual(['torch', 'flame', 0]);
    expect([BLOCKS[B.TORCH].name, BLOCKS[B.TORCH].displayName]).toEqual(['torch', 'Torch']);
    expect(torch.tip).toMatch(/torch/i);
    expect(torch.tip).toMatch(/slow match/);
    expect(torch.origin).toMatch(/pitch torch/);
    expect(partByKey('linstock')).toBeNull();
  });
});

describe('predicates (§4.3, §4.9)', () => {
  it('isFlame is exactly CAMPFIRE and TORCH; isIgnitable exactly the fuse, the keg and the charge', () => {
    expect(ALL_IDS.filter(isFlame)).toEqual([B.CAMPFIRE, B.TORCH].sort((a, b) => a - b));
    expect(ALL_IDS.filter(isIgnitable)).toEqual([B.POWDER_KEG, B.COLLAPSAR_CHARGE, B.POWDER_FUSE].sort((a, b) => a - b));
    for (const f of [isFlame, isIgnitable]) for (const bad of [UNLOADED, ...JUNK]) expect(f(bad), `${f.name}(${String(bad)})`).toBe(false);
  });

  it('isControl is exactly the switch, the button, the timer, the transmitter and the blasting machine', () => {
    const controls = [B.KNIFE_SWITCH, B.PUSH_BUTTON, B.CLOCKWORK_TIMER, B.SPARK_TRANSMITTER, B.BLASTING_MACHINE];
    expect(ALL_IDS.filter(isControl)).toEqual([...controls].sort((a, b) => a - b));
    for (const bad of [UNLOADED, ...JUNK]) expect(isControl(bad), String(bad)).toBe(false);
  });

  it('the predicates agree with the table: flame role ↔ isFlame, control flag ↔ isControl, fuse or ignitable role ↔ isIgnitable', () => {
    for (const d of Object.values(PARTS)) {
      expect(isFlame(d.id), d.key).toBe(d.role === 'flame');
      expect(isControl(d.id), d.key).toBe(d.control);
      expect(isIgnitable(d.id), d.key).toBe(d.role === 'fuse' || d.role === 'ignitable');
    }
  });

  it('signalKind names the three signal insulations; the Earth Wire and everything else are null', () => {
    expect(signalKind(B.COPPER_WIRE)).toBe('copper');
    expect(signalKind(B.BROWN_WIRE)).toBe('brown');
    expect(signalKind(B.WHITE_WIRE)).toBe('white');
    const withKind = ALL_IDS.filter((id) => signalKind(id) !== null);
    expect(withKind).toEqual([B.COPPER_WIRE, B.BROWN_WIRE, B.WHITE_WIRE]);
    for (const bad of [B.EARTH_WIRE, B.TERMINAL_BOARD, B.AIR, UNLOADED, ...JUNK]) expect(signalKind(bad), String(bad)).toBeNull();
  });
});

describe('isEarth (§4.4)', () => {
  /** The ground, by name (§4.4). */
  const EARTH = [
    'stone', 'dirt', 'grass_block', 'snowy_grass', 'sand', 'red_sand', 'gravel', 'flint_gravel', 'clay', 'cobblestone', 'mossy_cobblestone',
    'stone_bricks', 'mossy_stone_bricks', 'bricks', 'granite', 'diorite', 'andesite', 'slate', 'sandstone', 'bedrock',
    'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'copper_ore', 'tin_ore', 'coal_block', 'iron_block', 'gold_block',
    'copper_block',
  ];
  /** Insulators (§4.4): never earth. */
  const INSULATORS = [
    'oak_log', 'spruce_log', 'birch_log', 'oak_planks', 'spruce_planks', 'birch_planks', 'bookshelf',
    'oak_leaves', 'spruce_leaves', 'birch_leaves', 'glass', 'ice', 'packed_ice', 'snow_block', 'hay_bale', 'pumpkin',
    'honeycomb_block', 'obsidian', 'diamond_block', 'glowstone',
    ...BLOCKS.filter((b) => b.name.startsWith('wool_')).map((b) => b.name),
  ];
  const idOf = new Map(BLOCKS.map((b) => [b.name, b.id]));
  const isWaterFamily = (b) => b.name === 'water' || b.name === 'water_fall' || b.name.startsWith('water_flow_') || b.name === 'tainted_water';

  it('is true for every ground block of the list (all exist with survival merged) and for the whole water family', () => {
    for (const name of EARTH) {
      expect(idOf.has(name), name).toBe(true);
      expect(isEarth(idOf.get(name)), name).toBe(true);
    }
    const water = BLOCKS.filter(isWaterFamily).map((b) => b.id);
    expect(water).toHaveLength(9); // + Tainted Water (§76 water)
    for (const id of water) expect(isEarth(id), BLOCKS[id].name).toBe(true);
    // Nothing else is earth.
    const expected = [...EARTH.map((n) => idOf.get(n)), ...water].sort((a, b) => a - b);
    expect(ALL_IDS.filter(isEarth)).toEqual(expected);
  });

  it('is false for every insulator listed, every circuit part, and AIR, UNLOADED and garbage', () => {
    expect(INSULATORS.filter((n) => n.startsWith('wool_'))).toHaveLength(16);
    for (const name of INSULATORS) {
      expect(idOf.has(name), name).toBe(true);
      expect(isEarth(idOf.get(name)), name).toBe(false);
    }
    for (const id of [...PART_IDS, B.CAMPFIRE, B.AIR, B.RUNE_BLOCK, B.BLACK_HOLE]) expect(isEarth(id), BLOCKS[id].name).toBe(false);
    for (const bad of [UNLOADED, ...JUNK]) expect(isEarth(bad), String(bad)).toBe(false);
  });

  it('buildEarthTable works from names, with or without survival\'s blocks (a fake BLOCKS lacking the ores)', () => {
    const noSurvival = BLOCKS.filter((b) => b.id < B.COPPER_ORE);
    expect(noSurvival.some((b) => b.name === 'copper_ore' || b.name === 'tin_ore')).toBe(false);
    const t = buildEarthTable(noSurvival);
    expect(t).toBeInstanceOf(Uint8Array);
    expect(t.length).toBe(256);
    const earthIds = ALL_IDS.filter((id) => t[id] === 1);
    expect(earthIds).toEqual(ALL_IDS.filter((id) => isEarth(id) && id < B.COPPER_ORE));
    // A stand-in list with other ids: names decide, unknown names and bad entries are skipped.
    const fake = buildEarthTable([
      { id: 3, name: 'stone' }, { id: 9, name: 'oak_planks' }, { id: 200, name: 'copper_ore' }, { id: 7, name: 'not_a_block' },
      null, { id: 300, name: 'dirt' }, { id: -1, name: 'sand' },
    ]);
    expect(ALL_IDS.filter((id) => fake[id] === 1)).toEqual([3, 200]);
    expect(buildEarthTable([]).every((v) => v === 0)).toBe(true);
  });
});

describe('connections (§4.5)', () => {
  const WIRES = [B.COPPER_WIRE, B.BROWN_WIRE, B.WHITE_WIRE];
  const INPUT_CONTACTS = [B.RELAY, B.CLOCKWORK_TIMER, B.COHERER_RECEIVER];
  const PLAIN_CONTACTS = [B.KNIFE_SWITCH, B.PUSH_BUTTON];
  const NOT_CONDUCTORS = [
    B.EARTH_WIRE, B.VOLTAIC_BATTERY, B.BLASTING_MACHINE, B.SELENIUM_PANEL, B.IGNITER, B.FILAMENT_LAMP, B.ELECTRIC_BELL,
    B.SPARK_TRANSMITTER, B.POWDER_FUSE, B.TORCH, B.POWDER_KEG, B.COLLAPSAR_CHARGE, B.CAMPFIRE, B.STONE, B.AIR, UNLOADED,
  ];
  const FACES = [0, 1, 2, 3, 4, 5, 6, 7];

  it('conductorAccepts: signal wires and terminal boards take all 8 faces, plain contacts too', () => {
    for (const id of [...WIRES, B.TERMINAL_BOARD, ...PLAIN_CONTACTS]) {
      for (const f of FACES) expect(conductorAccepts(id, f, 3), `${BLOCKS[id].name} face ${f}`).toBe(true);
      for (const f of FACES) expect(conductorAccepts(id, f, f), `${BLOCKS[id].name} face ${f} (input ignored)`).toBe(true);
    }
  });

  it('conductorAccepts: a relay, timer or coherer takes every face but its input face (default W)', () => {
    for (const id of INPUT_CONTACTS) {
      for (let input = 0; input <= 6; input++) {
        for (const f of FACES) expect(conductorAccepts(id, f, input), `${BLOCKS[id].name} input ${input} face ${f}`).toBe(f !== input);
      }
      for (const bad of [undefined, null, 7, -1, 1.5, NaN, '0']) {
        for (const f of FACES) {
          expect(conductorAccepts(id, f, bad), `${BLOCKS[id].name} input ${String(bad)} face ${f}`).toBe(f !== DEFAULT_INPUT_FACE);
        }
      }
    }
    expect(DEFAULT_INPUT_FACE).toBe(3);
  });

  it('conductorAccepts: the earth wire, sources, loads, flames, ignitables and blocks are never signal nodes; bad faces never accept', () => {
    for (const id of NOT_CONDUCTORS) for (const f of FACES) expect(conductorAccepts(id, f, 3), `${id} face ${f}`).toBe(false);
    for (const bad of [-1, 8, 1.5, NaN, '0', null, undefined]) expect(conductorAccepts(B.COPPER_WIRE, bad, 3), String(bad)).toBe(false);
  });

  it('joins: two wires join only when they are the same kind, on every face pair', () => {
    for (const a of WIRES) {
      for (const b of WIRES) {
        for (const f of FACES) expect(joins(a, f, 3, b, 3), `${BLOCKS[a].name} ${f} ${BLOCKS[b].name}`).toBe(a === b);
      }
    }
  });

  it('joins: a terminal board joins every signal wire kind and other boards; never an earth wire', () => {
    for (const w of [...WIRES, B.TERMINAL_BOARD]) {
      for (const f of FACES) {
        expect(joins(B.TERMINAL_BOARD, f, 3, w, 3), `board ${f} ${BLOCKS[w].name}`).toBe(true);
        expect(joins(w, f, 3, B.TERMINAL_BOARD, 3), `${BLOCKS[w].name} ${f} board`).toBe(true);
      }
    }
    for (const f of FACES) expect(joins(B.TERMINAL_BOARD, f, 3, B.EARTH_WIRE, 3)).toBe(false);
  });

  it('joins: a closed contact joins any wire kind and boards, except across its input face', () => {
    for (const c of [...PLAIN_CONTACTS, ...INPUT_CONTACTS]) {
      for (const w of [...WIRES, B.TERMINAL_BOARD, B.KNIFE_SWITCH]) {
        for (const f of FACES) {
          // The contact is A, its face f; the wire is across it on FACE_OPPOSITE[f].
          const expected = !(INPUT_CONTACTS.includes(c) && f === 2);
          expect(joins(c, f, 2, w, 3), `${BLOCKS[c].name} (input SW) face ${f} → ${BLOCKS[w].name}`).toBe(expected);
          expect(joins(w, FACE_OPPOSITE[f], 3, c, 2), `${BLOCKS[w].name} → ${BLOCKS[c].name} face ${f}`).toBe(expected);
        }
      }
    }
    // Two relays face to face: joined unless either input face is the shared one.
    expect(joins(B.RELAY, 0, 3, B.RELAY, 1)).toBe(true); // A's E face meets B's W face; inputs W and SE
    expect(joins(B.RELAY, 0, 0, B.RELAY, 1)).toBe(false); // A's input is E
    expect(joins(B.RELAY, 0, 1, B.RELAY, 3)).toBe(false); // B's input is W, the shared face
  });

  it('joins: the earth wire joins nothing in the signal graph, not even another earth wire; devices never join directly', () => {
    for (const f of FACES) {
      for (const w of [...WIRES, B.EARTH_WIRE]) {
        expect(joins(B.EARTH_WIRE, f, 3, w, 3)).toBe(false);
        expect(joins(w, f, 3, B.EARTH_WIRE, 3)).toBe(false);
      }
      // A lamp against a battery, or a battery against a wire, is an attachment at most: never an edge.
      expect(joins(B.VOLTAIC_BATTERY, f, 3, B.FILAMENT_LAMP, 3)).toBe(false);
      expect(joins(B.VOLTAIC_BATTERY, f, 3, B.COPPER_WIRE, 3)).toBe(false);
      expect(joins(B.COPPER_WIRE, f, 3, B.IGNITER, 3)).toBe(false);
      expect(joins(B.POWDER_FUSE, f, 3, B.POWDER_FUSE, 3)).toBe(false);
    }
  });

  it('joins is symmetric across every pair of cells and faces', () => {
    const ids = [...WIRES, B.EARTH_WIRE, B.TERMINAL_BOARD, ...PLAIN_CONTACTS, ...INPUT_CONTACTS, B.VOLTAIC_BATTERY, B.IGNITER];
    for (const a of ids) {
      for (const b of ids) {
        for (const f of FACES) {
          for (const [ia, ib] of [[3, 3], [f, 0], [0, FACE_OPPOSITE[f]], [6, 6]]) {
            expect(joins(a, f, ia, b, ib), `${a} ${f} ${b}`).toBe(joins(b, FACE_OPPOSITE[f], ib, a, ia));
          }
        }
      }
    }
  });

  it('liveFaces: sources and loads use faces 0–6 (the bottom is earth); inputs only their input face; others none', () => {
    const allLive = [B.VOLTAIC_BATTERY, B.BLASTING_MACHINE, B.SELENIUM_PANEL, B.IGNITER, B.FILAMENT_LAMP, B.ELECTRIC_BELL, B.SPARK_TRANSMITTER];
    for (const id of allLive) {
      expect(liveFaces(id, 3), BLOCKS[id].name).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(liveFaces(id), BLOCKS[id].name).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
    for (const id of INPUT_CONTACTS) {
      for (let f = 0; f <= 6; f++) expect(liveFaces(id, f), `${BLOCKS[id].name} ${f}`).toEqual([f]);
      for (const bad of [undefined, 7, -1, 2.5, NaN, '1']) expect(liveFaces(id, bad), String(bad)).toEqual([DEFAULT_INPUT_FACE]);
    }
    for (const id of [...WIRES, B.EARTH_WIRE, B.TERMINAL_BOARD, ...PLAIN_CONTACTS, B.POWDER_FUSE, B.TORCH, B.POWDER_KEG, B.COLLAPSAR_CHARGE,
      B.CAMPFIRE, B.STONE, UNLOADED, -1]) {
      expect(liveFaces(id, 3), String(id)).toEqual([]);
    }
    // Every source, load and input part is covered: the table and liveFaces agree.
    for (const d of Object.values(PARTS)) {
      const live = liveFaces(d.id, 3);
      expect(live.length > 0, d.key).toBe(d.role === 'source' || d.role === 'load' || d.input);
      expect(live.includes(7), d.key).toBe(false);
    }
  });

  it('liveFaces returns shared frozen arrays (no allocation per call)', () => {
    expect(Object.isFrozen(liveFaces(B.FILAMENT_LAMP))).toBe(true);
    expect(liveFaces(B.FILAMENT_LAMP)).toBe(liveFaces(B.VOLTAIC_BATTERY));
    expect(liveFaces(B.RELAY, 4)).toBe(liveFaces(B.CLOCKWORK_TIMER, 4));
    expect(Object.isFrozen(liveFaces(B.STONE))).toBe(true);
  });

  it('sidesTouch: all 36 side-face pairs (neighbours f and f ± 1 mod 6), never the top, bottom or garbage', () => {
    let touching = 0;
    for (let a = 0; a < 6; a++) {
      for (let b = 0; b < 6; b++) {
        const d = (((a - b) % 6) + 6) % 6;
        expect(sidesTouch(a, b), `${a} ${b}`).toBe(d === 1 || d === 5);
        if (sidesTouch(a, b)) touching++;
      }
    }
    expect(touching).toBe(12);
    // The worked examples' face pairs: W–E opposite, W–SW and W–NW touch, SE–NE do not (§4.14 example 3, fix 2).
    expect([sidesTouch(3, 0), sidesTouch(3, 2), sidesTouch(3, 4), sidesTouch(1, 5), sidesTouch(5, 0)]).toEqual([false, true, true, false, true]);
    for (const [a, b] of [[6, 0], [0, 6], [7, 1], [6, 7], [-1, 0], [0, 6.5], [NaN, 1], ['1', 2], [null, 1]]) {
      expect(sidesTouch(a, b), `${String(a)} ${String(b)}`).toBe(false);
    }
  });
});

describe('inputFaceFromYaw (§4.8)', () => {
  /** The yaw whose back direction (sin yaw, 0, cos yaw) is at angle θ from +X toward +Z. */
  const yawFor = (thetaDeg) => ((90 - thetaDeg) * Math.PI) / 180;

  it('looking along each face normal gives that face (the face pointing back at the player)', () => {
    for (let f = 0; f < 6; f++) {
      expect(inputFaceFromYaw(yawFor(60 * f)), `face ${f}`).toBe(f);
      expect(inputFaceFromYaw(yawFor(60 * f) + 2 * Math.PI), `face ${f} + 2π`).toBe(f);
      expect(inputFaceFromYaw(yawFor(60 * f) - 4 * Math.PI), `face ${f} − 4π`).toBe(f);
      // It is the argmax of the dot product with (sin yaw, 0, cos yaw).
      const y = yawFor(60 * f);
      const dots = [0, 1, 2, 3, 4, 5].map((j) => FACE_NORMALS[j][0] * Math.sin(y) + FACE_NORMALS[j][2] * Math.cos(y));
      expect(dots.indexOf(Math.max(...dots))).toBe(f);
    }
    // Walking east to place a relay (yaw −π/2 faces +X): its W face points back at the player.
    expect(inputFaceFromYaw(-Math.PI / 2)).toBe(3);
    // Facing north (yaw 0) or south: the player looks at a hex corner (SE | SW, NW | NE); the lower index wins.
    expect(inputFaceFromYaw(0)).toBe(1);
    expect(inputFaceFromYaw(Math.PI)).toBe(4);
  });

  it('at the halfway boundaries the lower face index wins (5 | 0 gives 0); just off them the nearer face wins', () => {
    for (let k = 0; k < 6; k++) {
      const theta = 30 + 60 * k; // between face k and face k + 1 (mod 6)
      const lower = Math.min(k, (k + 1) % 6);
      expect(inputFaceFromYaw(yawFor(theta)), `boundary ${k}|${(k + 1) % 6}`).toBe(lower);
      expect(inputFaceFromYaw(yawFor(theta - 0.01)), `just toward ${k}`).toBe(k);
      expect(inputFaceFromYaw(yawFor(theta + 0.01)), `just toward ${(k + 1) % 6}`).toBe((k + 1) % 6);
    }
  });

  it('always returns a side face 0..5; a non-finite yaw gives DEFAULT_INPUT_FACE', () => {
    for (let i = 0; i < 720; i++) {
      const f = inputFaceFromYaw((i * Math.PI) / 360 - 2 * Math.PI);
      expect(Number.isInteger(f) && f >= 0 && f <= 5).toBe(true);
    }
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, '0']) expect(inputFaceFromYaw(bad), String(bad)).toBe(DEFAULT_INPUT_FACE);
  });
});

describe('radio wavelengths (§4.6)', () => {
  it('wavelengthOf: channel i is 300 + 50·(i − 1) metres; 7 is the 600 m distress wavelength', () => {
    expect([wavelengthOf(1), wavelengthOf(7), wavelengthOf(16)]).toEqual([300, 600, 1050]);
    for (let ch = 1; ch <= 16; ch++) expect(wavelengthOf(ch)).toBe(300 + 50 * (ch - 1));
    expect(wavelengthOf(C.RADIO_DISTRESS_CH)).toBe(600);
    // Out-of-range channels clamp; fractions round; anything that is not a number reads as channel 1.
    expect([wavelengthOf(0), wavelengthOf(-3), wavelengthOf(17), wavelengthOf(99), wavelengthOf(2.6)]).toEqual([300, 300, 1050, 1050, 400]);
    for (const bad of [NaN, Infinity, '3', null, undefined]) expect(wavelengthOf(bad), String(bad)).toBe(300);
  });

  it('parseChannel: a channel number 1–16 or a wavelength 300m–1050m on the 50 m grid', () => {
    const good = [
      ['3', 3], ['1', 1], ['16', 16], ['03', 3], [' 7 ', 7], ['400m', 3], ['400 m', 3], ['400M', 3], [' 600 m ', 7],
      ['300m', 1], ['1050m', 16], ['1050 M', 16], [3, 3], [16, 16],
    ];
    for (const [token, ch] of good) expect(parseChannel(token), JSON.stringify(token)).toBe(ch);
    // Every channel round-trips through its wavelength.
    for (let ch = 1; ch <= 16; ch++) {
      expect(parseChannel(String(ch))).toBe(ch);
      expect(parseChannel(`${wavelengthOf(ch)}m`)).toBe(ch);
      expect(parseChannel(`${wavelengthOf(ch)} m`)).toBe(ch);
    }
  });

  it('parseChannel: bad tokens give null', () => {
    const bad = [
      '0', '17', '-1', '+3', '3.0', '1e1', '0x3', '', ' ', 'm', 'abc', '400', '250m', '1100m', '425m', '400mm', '400 km',
      '400 meters', 'm400', '4 00m', '-400m', '3 m', '0m', 0, 17, 1.5, -1, NaN, null, undefined, {}, [], true,
    ];
    for (const token of bad) expect(parseChannel(token), JSON.stringify(token) ?? String(token)).toBeNull();
  });
});

describe('teaching text (§4.13)', () => {
  it('every part has a non-empty tip of at most 240 characters; the normative tips are word for word', () => {
    for (const id of PART_IDS) {
      const tip = partTip(id);
      expect(tip.length, BLOCKS[id].name).toBeGreaterThan(0);
      expect(tip.length, BLOCKS[id].name).toBeLessThanOrEqual(240);
      expect(tip, BLOCKS[id].name).toBe(tip.trim());
      expect(tip, BLOCKS[id].name).toBe(PARTS[id].tip);
      expect(partOrigin(id), BLOCKS[id].name).toBe(PARTS[id].origin);
    }
    for (const [key, tip] of Object.entries(TIPS)) expect(partTip(B[key]), key).toBe(tip);
    expect(Object.keys(TIPS).length + 1).toBe(PART_IDS.length); // + the Torch's own
  });

  it('player-facing teaching text never writes a key as a bare [R] or "R:" (§5.10)', () => {
    for (const id of PART_IDS) {
      for (const text of [partTip(id), partOrigin(id)]) {
        expect(text, BLOCKS[id].name).not.toContain('[R]');
        expect(text, BLOCKS[id].name).not.toMatch(/(^|[^+\w])R:/);
      }
    }
  });

  it('partTip and partOrigin are empty for the Campfire, other blocks, UNLOADED and garbage', () => {
    for (const id of [B.CAMPFIRE, B.STONE, B.AIR, B.BLACK_HOLE, B.RUNE_BLOCK, UNLOADED, ...JUNK]) {
      expect(partTip(id), String(id)).toBe('');
      expect(partOrigin(id), String(id)).toBe('');
    }
  });
});

describe('the new blocks as parts (§1.2, §1.5)', () => {
  it('THIN parts are unmeshed, walk-through, see-through cutout blocks with a flat icon', () => {
    for (const k of THIN_KEYS) {
      const d = BLOCKS[B[k]];
      expect([d.meshed, d.icon, d.solid, d.opaque, d.layer], k).toEqual([false, 'flat', false, false, LAYER_CUTOUT]);
      expect(isMeshed(B[k]) || isSolid(B[k]), k).toBe(false);
    }
  });

  it('the 14 devices (the design\'s CABs, the lamp included) are solid, unmeshed, see-through 3D models with flat icons', () => {
    // The user's "fun and simple" redo: every device is a small model (circuitGeometry.MODELS), not a hex cabinet. The cell
    // still collides, targets and bears load as a whole (solid); the terrain draws every face round it (not opaque).
    expect(CAB_KEYS).toHaveLength(14);
    expect(CAB_KEYS).toContain('FILAMENT_LAMP');
    for (const k of CAB_KEYS) {
      const d = BLOCKS[B[k]];
      expect([d.meshed, d.icon, d.solid, d.opaque, d.layer], k).toEqual([false, 'flat', true, false, LAYER_CUTOUT]);
      expect(isOpaque(B[k]), k).toBe(false);
    }
  });

  it('BLOCK_ALIASES.blast_barrel is the Powder Keg', () => {
    expect(BLOCK_ALIASES.blast_barrel).toBe(B.POWDER_KEG);
    expect(partOf(BLOCK_ALIASES.blast_barrel).key).toBe('keg');
  });
});

describe('purity and imports (§6.1)', () => {
  it('imports only config, blocks and hex, and reads no clock, randomness or DOM', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/circuitParts.js', import.meta.url)), 'utf8');
    const imports = [...src.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]).sort();
    expect(imports).toEqual(['./blocks.js', './config.js', './hex.js']);
    expect(src).not.toMatch(/Math\.random\(|Date\.now\(|new Date\(|performance\.now\(|document\.|window\./);
  });
});
