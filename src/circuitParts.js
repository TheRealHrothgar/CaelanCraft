// Caelancraft — the circuit part table: every Powder-and-circuits block's role, terminals, numbers, history line and tip,
// the flame / ignitable / control / earth predicates, the hex connection rules, input faces and radio wavelengths.
// docs/DESIGN-circuits.md §1.5, §4.2–§4.6, §4.8, §4.13, §6.2.1 (CONTRACTS §50 once merged). PURE: no DOM, no three, no time,
// no Math.random.
//
// The user named the "linstock" of the design a Torch (key `torch`, block TORCH): a pitch torch whose flame always burns.
// Every Linstock rule applies to it unchanged.
import {
  BATTERY_V, BLASTER_V, SELENIUM_MAX_V, LAMP_MIN_V, COIL_MIN_V, IGNITER_MIN_V, LAMP_AMPS, BELL_AMPS, IGNITER_AMPS, COIL_AMPS,
  RADIO_CHANNELS, RADIO_BASE_M, RADIO_STEP_M,
} from './config.js';
import { BLOCK, BLOCKS } from './blocks.js';
import { FACE_NORMALS, FACE_OPPOSITE, SIDE_FACE_COUNT } from './hex.js';

/** @typedef {import('./types.js').PartDef} PartDef */

/** The four wire kinds: three signal insulations and the earth (ground) conductor. */
export const WIRE_KINDS = Object.freeze(['copper', 'brown', 'white', 'earth']);

/** The input face of a relay, timer or coherer that has no store entry (W): §4.8 "defaults without an entry". */
export const DEFAULT_INPUT_FACE = 3;

/** The store fields a part may save, in their canonical JSON order (§4.8, §6.4): label, then the kind's own fields. */
const LABEL = 'l';

/** The device tips are normative text (§4.13). */
const TIP = Object.freeze({
  copper: 'Current flowing through a wire loses a little voltage in every cell (V = I × R). More lamps on one wire draw more ' +
    'current, and they all get dimmer. With nothing switched on, the whole wire sits at the battery\'s voltage.',
  braid: 'Brown means live and green-and-yellow means earth: today\'s wiring colours. Insulation lets two circuits run side by ' +
    'side; join them on a Terminal Board.',
  earth: 'Green and yellow means earth. Devices on wooden floors need a path to the ground: run this down to natural soil or ' +
    'stone.',
  terminal: 'A board of brass binding posts: every wire screwed to it is joined, whatever its insulation.',
  battery: 'Volta\'s pile (1800): each copper–tin pair gives about half a volt; twelve make six. Stack batteries to add volts ' +
    '(series); wire them side by side to last longer (parallel). It tires, then runs down.',
  blaster: 'Push the plunger: a hand-spun magneto makes a short 24 V pulse, enough to fire an igniter far away. Quarries and ' +
    'mines used these.',
  selenium: 'Fritts\' selenium panel (1883): six cells under see-through gold leaf, about half a volt each, make up to 3 V in ' +
    'open sun and none at night. Too weak for a lamp, enough for a relay.',
  switch: 'The classic laboratory switch: a copper blade bridges the gap. On a hex, cells on neighbouring faces touch each ' +
    'other, so run the wires out of opposite faces.',
  button: 'A momentary switch: closed only while you hold it down. An NC button is the opposite: it opens while held, which ' +
    'makes a stop button.',
  timer: 'A wound spring runs the clock; when it runs down, its contacts close. Pulse closes for a second, Hold stays closed, ' +
    'Repeat makes a clock.',
  relay: 'Joseph Henry\'s relay (1835): a weak current in the coil pulls an iron arm that closes a second circuit with its own ' +
    'battery. Keep that battery away from the input face. NC contacts open when the coil pulls.',
  igniter: 'A thin wire glows red-hot when current flows (at least 3 V) and lights the powder beside it. It draws a lot of ' +
    'current, so keep its wire short.',
  lamp: 'A carbon filament glows when current heats it (Swan and Edison, 1879). A dim lamp means a long wire, a shared wire ' +
    'or a tired battery.',
  bell: 'Its magnet pulls the hammer, which breaks the circuit, springs back and closes it again: a relay that interrupts ' +
    'itself.',
  tx: 'A spark jumping a gap sends a radio wave (Marconi, 1895). Tune it to a wavelength; a receiver on the same wavelength ' +
    'hears it. 600 m was the distress wavelength.',
  rx: 'Iron filings in a glass tube cling together when a radio wave arrives and let current through. A second wave cannot ' +
    'open it; only a tap can.',
  fuse: 'Safety fuse: a thread of black powder sealed in tarred twine (Bickford, 1831). It burns at a steady speed, about ' +
    '1 cm a second in real life, even under water, and is used up. Ours burns 2.5 cells a second.',
  // The Linstock's tip, rewritten for the Torch the user asked for (DESIGN-circuits, the user-decision note).
  torch: 'Pitch torches (resin-soaked fibre on a staff) lit fuses and slow match for centuries; a gunner\'s linstock held ' +
    'slow match the same way. Fuses, kegs and charges set beside it catch at once.',
  keg: 'Black powder is 75 % saltpetre, 15 % charcoal and 10 % sulfur. When the flame reaches the powder, it goes off at ' +
    'once. Kegs were hooped with copper or wood, never iron, so a knock could not strike a spark.',
  charge: 'In the 1960s, before John Wheeler\'s name "black hole" caught on (1967), astronomers spoke of collapsars. A fuse, ' +
    'an igniter or a radio pulse sets this one off; then walk straight away.',
});

/**
 * One PartDef, frozen. `wire`, `volts`, `vMin` and `amps` are present only on the parts they describe.
 * @param {{ id: number, key: string, role: PartDef['role'], wire?: string, volts?: number, vMin?: number, amps?: number,
 *   input?: boolean, earth?: boolean, control?: boolean, fields?: string[], origin: string, tip: string }} d
 * @returns {Readonly<PartDef>}
 */
function part(d) {
  return Object.freeze({
    id: d.id,
    key: d.key,
    role: d.role,
    ...(d.wire !== undefined ? { wire: d.wire } : {}),
    ...(d.volts !== undefined ? { volts: d.volts } : {}),
    ...(d.vMin !== undefined ? { vMin: d.vMin } : {}),
    ...(d.amps !== undefined ? { amps: d.amps } : {}),
    input: d.input ?? false,
    earth: d.earth ?? false,
    control: d.control ?? false,
    fields: Object.freeze([...(d.fields ?? [])]),
    origin: d.origin,
    tip: d.tip,
  });
}

const B = BLOCK;

/** Every part, in block-id order of the design's table (§4.2), then the keg and the campfire. */
const PART_LIST = [
  part({ id: B.COLLAPSAR_CHARGE, key: 'charge', role: 'ignitable', fields: [LABEL], origin: 'A fictional collapse device',
    tip: TIP.charge }),
  part({ id: B.POWDER_FUSE, key: 'fuse', role: 'fuse',
    origin: 'Safety fuse (William Bickford, 1831): a black-powder core sealed in tarred, twine-wrapped cord', tip: TIP.fuse }),
  part({ id: B.TORCH, key: 'torch', role: 'flame',
    origin: 'A pitch torch: resin-soaked fibre bound to an ash staff, its flame always burning', tip: TIP.torch }),
  part({ id: B.COPPER_WIRE, key: 'copper_wire', role: 'wire', wire: 'copper',
    origin: 'Bare copper line wire strung on porcelain knobs, as telegraph lines were', tip: TIP.copper }),
  part({ id: B.BROWN_WIRE, key: 'brown_wire', role: 'wire', wire: 'brown', origin: 'Cotton-braided insulated wire',
    tip: TIP.braid }),
  part({ id: B.WHITE_WIRE, key: 'white_wire', role: 'wire', wire: 'white', origin: 'Cotton-braided insulated wire',
    tip: TIP.braid }),
  part({ id: B.EARTH_WIRE, key: 'earth_wire', role: 'wire', wire: 'earth',
    origin: 'A green-and-yellow earth (ground) conductor', tip: TIP.earth }),
  part({ id: B.TERMINAL_BOARD, key: 'terminal', role: 'junction', fields: [LABEL], origin: 'A board of brass binding posts',
    tip: TIP.terminal }),
  part({ id: B.VOLTAIC_BATTERY, key: 'battery', role: 'source', volts: BATTERY_V, earth: true, fields: [LABEL, 'c'],
    origin: 'A Voltaic pile: twelve copper–tin pairs and brine', tip: TIP.battery }),
  part({ id: B.BLASTING_MACHINE, key: 'blaster', role: 'source', volts: BLASTER_V, earth: true, control: true,
    fields: [LABEL], origin: 'A rack-bar magneto exploder (1880s)', tip: TIP.blaster }),
  part({ id: B.SELENIUM_PANEL, key: 'selenium', role: 'source', volts: SELENIUM_MAX_V, earth: true, fields: [LABEL],
    origin: 'A panel of Fritts selenium cells (1883) wired in series', tip: TIP.selenium }),
  part({ id: B.KNIFE_SWITCH, key: 'switch', role: 'contact', control: true, fields: [LABEL, 'on'],
    origin: 'A laboratory knife switch', tip: TIP.switch }),
  part({ id: B.PUSH_BUTTON, key: 'button', role: 'contact', control: true, fields: [LABEL, 'nc'],
    origin: 'A momentary push switch, normally open or normally closed', tip: TIP.button }),
  // The three contacts with an input face are also a load on it (§4.2 "two roles in one cell"): the timer's start latch
  // draws nothing, the relay coil and the coherer's electric tapper 0.5 A. Each input needs earth (§4.6: "the relay is
  // earthed", "needs earth"), so their `earth` is true although §4.2's field table says "sources and loads".
  part({ id: B.CLOCKWORK_TIMER, key: 'timer', role: 'contact', vMin: COIL_MIN_V, amps: 0, input: true, earth: true,
    control: true, fields: [LABEL, 'on', 'f', 's', 'm', 'run'], origin: 'A spring-wound clockwork time switch',
    tip: TIP.timer }),
  part({ id: B.RELAY, key: 'relay', role: 'contact', vMin: COIL_MIN_V, amps: COIL_AMPS, input: true, earth: true,
    fields: [LABEL, 'nc', 'f'], origin: 'Joseph Henry\'s electromagnetic relay (1835)', tip: TIP.relay }),
  part({ id: B.IGNITER, key: 'igniter', role: 'load', vMin: IGNITER_MIN_V, amps: IGNITER_AMPS, earth: true, fields: [LABEL],
    origin: 'A hot-wire (bridgewire) igniter', tip: TIP.igniter }),
  part({ id: B.FILAMENT_LAMP, key: 'lamp', role: 'load', vMin: LAMP_MIN_V, amps: LAMP_AMPS, earth: true, fields: [LABEL],
    origin: 'A carbon-filament lamp (Swan and Edison, 1879)', tip: TIP.lamp }),
  part({ id: B.ELECTRIC_BELL, key: 'bell', role: 'load', vMin: COIL_MIN_V, amps: BELL_AMPS, earth: true, fields: [LABEL],
    origin: 'A trembler bell with a steel gong', tip: TIP.bell }),
  part({ id: B.SPARK_TRANSMITTER, key: 'tx', role: 'load', vMin: COIL_MIN_V, amps: COIL_AMPS, earth: true, control: true,
    fields: [LABEL, 'ch'], origin: 'Marconi\'s spark-gap transmitter (1895)', tip: TIP.tx }),
  part({ id: B.COHERER_RECEIVER, key: 'rx', role: 'contact', vMin: COIL_MIN_V, amps: COIL_AMPS, input: true, earth: true,
    fields: [LABEL, 'on', 'f', 'm', 'ch'], origin: 'A coherer with a local relay and an electric tapper', tip: TIP.rx }),
  part({ id: B.POWDER_KEG, key: 'keg', role: 'ignitable', origin: 'A copper-hooped keg of black powder', tip: TIP.keg }),
  // Not a part (isPart is false; partTip, partOrigin and partByKey ignore it): indexed only so the flame rule can find it.
  part({ id: B.CAMPFIRE, key: 'campfire', role: 'flame', origin: '', tip: '' }),
];

/**
 * The part table, by block id: the 20 circuit blocks, the Powder Keg and (as a flame only) the Campfire. Frozen.
 * @type {Readonly<Record<number, Readonly<PartDef>>>}
 */
export const PARTS = Object.freeze(Object.fromEntries(PART_LIST.map((p) => [p.id, p])));

/** @type {(Readonly<PartDef>|null)[]} 256 entries, index = block id */
const BY_ID = new Array(256).fill(null);
for (const p of PART_LIST) BY_ID[p.id] = p;
/** @type {Map<string, Readonly<PartDef>>} store kind → part (the campfire is not a part) */
const BY_KEY = new Map(PART_LIST.filter((p) => p.id !== B.CAMPFIRE).map((p) => [p.key, p]));

/** @returns {Uint8Array} 256 entries, 1 for each listed id */
function table(ids) {
  const t = new Uint8Array(256);
  for (const id of ids) t[id] = 1;
  return t;
}

/**
 * @returns {boolean} `id` is a block id 0..255 (a number: a typed array would read the string '97' as index 97) whose entry
 *   in `t` is set
 */
function inTable(t, id) {
  return (id & 255) === id && t[id] === 1;
}
const PART_IDS = table(PART_LIST.filter((p) => p.id !== B.CAMPFIRE).map((p) => p.id));
const FLAME_IDS = table([B.CAMPFIRE, B.TORCH]);
const IGNITABLE_IDS = table([B.POWDER_FUSE, B.POWDER_KEG, B.COLLAPSAR_CHARGE]);
const CONTROL_IDS = table(PART_LIST.filter((p) => p.control).map((p) => p.id));

/**
 * @param {number} id
 * @returns {Readonly<PartDef>|null} the id's PartDef (the Campfire's flame entry included), or null
 */
export function partOf(id) {
  return (id & 255) === id ? BY_ID[id] : null;
}

/**
 * The part saved under a store kind `k` (store validation maps `k` to its block id through this).
 * @param {string} k
 * @returns {Readonly<PartDef>|null} null for unknown kinds and for 'campfire', which is not a part
 */
export function partByKey(k) {
  return (typeof k === 'string' && BY_KEY.get(k)) || null;
}

/** @returns {boolean} a circuit part: the 20 new blocks and the Powder Keg (not the Campfire) */
export function isPart(id) {
  return inTable(PART_IDS, id);
}

/** @returns {boolean} CAMPFIRE or TORCH: lights the ignitables beside it (§4.3) */
export function isFlame(id) {
  return inTable(FLAME_IDS, id);
}

/** @returns {boolean} POWDER_FUSE, POWDER_KEG or COLLAPSAR_CHARGE: lit by a flame, a fuse or an igniter (§4.3) */
export function isIgnitable(id) {
  return inTable(IGNITABLE_IDS, id);
}

/** @returns {boolean} KNIFE_SWITCH, PUSH_BUTTON, CLOCKWORK_TIMER, SPARK_TRANSMITTER or BLASTING_MACHINE: right-click operates it */
export function isControl(id) {
  return inTable(CONTROL_IDS, id);
}

/**
 * The ground (§4.4), by block name. Insulators are never on it: wood, leaves, wool, glass, ice, packed ice, snow, hay,
 * pumpkin, honeycomb, obsidian, diamond, glowstone and every circuit part. Names that do not exist are skipped, so the table
 * builds with or without survival's ores.
 */
const EARTH_NAMES = Object.freeze([
  'stone', 'dirt', 'grass_block', 'snowy_grass', 'sand', 'red_sand', 'gravel', 'flint_gravel', 'clay', 'cobblestone', 'mossy_cobblestone',
  'stone_bricks', 'mossy_stone_bricks', 'bricks', 'granite', 'diorite', 'andesite', 'slate', 'sandstone', 'bedrock',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'copper_ore', 'tin_ore',
  'coal_block', 'iron_block', 'gold_block', 'copper_block',
  'water', 'water_flow_1', 'water_flow_2', 'water_flow_3', 'water_flow_4', 'water_flow_5', 'water_flow_6', 'water_fall',
  'tainted_water', // v0.14 (§76 water): the second water source conducts like the first
  'water_low', 'water_shallow', 'tainted_water_low', 'tainted_water_shallow', // §83: so does standing water of any depth
]);

/**
 * Build the 256-entry earth table from a block list (§4.4): 1 for every block whose `name` is on the ground list. isEarth
 * uses the table built from BLOCKS at load.
 * CONTRACT-ISSUE: §6.2.1 lists only isEarth, but §7 K0 asks for a test that the table "builds with a fake BLOCKS that lacks
 * survival's ores", which needs the builder itself: K0 exports it (an addition, nothing else changes).
 * @param {ReadonlyArray<{ id: number, name: string }>} blocks  BLOCKS, or a test's stand-in
 * @returns {Uint8Array}
 */
export function buildEarthTable(blocks) {
  const names = new Set(EARTH_NAMES);
  const t = new Uint8Array(256);
  for (const b of blocks) if (b && names.has(b.name) && (b.id & 255) === b.id) t[b.id] = 1;
  return t;
}
const EARTH_IDS = buildEarthTable(BLOCKS);

/** @returns {boolean} a block that conducts to earth (soil, rock, ores, metal blocks, water); UNLOADED → false */
export function isEarth(id) {
  return inTable(EARTH_IDS, id);
}

/** @returns {'copper'|'brown'|'white'|null} a signal wire's kind; null for the Earth Wire and everything else */
export function signalKind(id) {
  const p = partOf(id);
  return p && p.role === 'wire' && p.wire !== 'earth' ? /** @type {'copper'|'brown'|'white'} */ (p.wire) : null;
}

/** @returns {number} `f` when it is a valid input face (0..6), else DEFAULT_INPUT_FACE */
function inputFaceOf(f) {
  return Number.isInteger(f) && f >= 0 && f <= 6 ? f : DEFAULT_INPUT_FACE;
}

/**
 * Whether a conductor cell accepts a signal edge through `face` (§4.5, static: a contact is taken as closed, the engine checks
 * its state). Signal wires and terminal boards: all 8 faces. Contacts: all 8 faces except the input face of a relay, timer
 * or coherer. Earth wires, sources, loads and everything else: none.
 * @param {number} id
 * @param {number} face        0..7
 * @param {number} [inputFace] the cell's input face (store `f`); anything but 0..6 means DEFAULT_INPUT_FACE
 * @returns {boolean}
 */
export function conductorAccepts(id, face, inputFace) {
  const p = partOf(id);
  if (!p || !Number.isInteger(face) || face < 0 || face > 7) return false;
  if (p.role === 'wire') return p.wire !== 'earth';
  if (p.role === 'junction') return true;
  if (p.role === 'contact') return !p.input || face !== inputFaceOf(inputFace);
  return false;
}

/**
 * The §4.5 edge rule: cell A and the cell B across A's face `faceA` (B's face FACE_OPPOSITE[faceA]) are joined when both
 * accept the shared face and, if both are signal wires, they are the same kind. Contacts are taken as closed.
 * @param {number} idA
 * @param {number} faceA   0..7
 * @param {number} inputA  A's input face (ignored unless A is a relay, timer or coherer)
 * @param {number} idB
 * @param {number} inputB  B's input face
 * @returns {boolean}
 */
export function joins(idA, faceA, inputA, idB, inputB) {
  if (!conductorAccepts(idA, faceA, inputA)) return false;
  if (!conductorAccepts(idB, FACE_OPPOSITE[faceA], inputB)) return false;
  const kindA = signalKind(idA);
  const kindB = signalKind(idB);
  return kindA === null || kindB === null || kindA === kindB;
}

const NO_FACES = Object.freeze(/** @type {number[]} */ ([]));
const ALL_LIVE_FACES = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
const ONE_FACE = Object.freeze([0, 1, 2, 3, 4, 5, 6].map((f) => Object.freeze([f])));

/**
 * A device's live terminals before earth straps are taken off (§4.4): a source or load uses faces 0..6 (its bottom is the
 * earth terminal); a relay, timer or coherer only its input face; anything else none. The engine removes the faces that
 * touch an Earth Wire. The arrays are shared and frozen.
 * @param {number} id
 * @param {number} [inputFace]  anything but 0..6 means DEFAULT_INPUT_FACE
 * @returns {readonly number[]}
 */
export function liveFaces(id, inputFace) {
  const p = partOf(id);
  if (!p) return NO_FACES;
  if (p.input) return ONE_FACE[inputFaceOf(inputFace)];
  return p.role === 'source' || p.role === 'load' ? ALL_LIVE_FACES : NO_FACES;
}

/**
 * On a hex the cells on neighbouring side faces of a cell touch each other (§4.5): true when side faces fA and fB are
 * neighbours, |fA − fB| mod 6 ∈ {1, 5}. Equal faces, the top and the bottom never touch this way.
 * @returns {boolean}
 */
export function sidesTouch(fA, fB) {
  if (!Number.isInteger(fA) || !Number.isInteger(fB) || fA < 0 || fB < 0 || fA >= SIDE_FACE_COUNT || fB >= SIDE_FACE_COUNT) {
    return false;
  }
  const d = Math.abs(fA - fB);
  return d === 1 || d === 5;
}

/** Ties closer than this go to the lower face index. */
// CONTRACT-ISSUE: §4.8 does not say which face wins a tie, and ties are common: a pointy-top hex has corners along ±Z, so
// a player facing due north (yaw 0) or due south looks straight at a vertical edge (SE | SW, NW | NE). K0 gives a tie to
// the lower face index (5 | 0 → 0), so yaw 0 gives SE (1). Tests and worked examples set their input faces explicitly.
const FACE_TIE_EPS = 1e-9;

/**
 * The input face given to a newly placed relay, timer or coherer (§4.8): the side face pointing back toward the player, i.e.
 * the FACE_NORMALS[0..5] entry with the largest dot product with (sin yaw, 0, cos yaw). At a halfway yaw (looking straight
 * at a vertical edge) the lower face index wins (faces 5 and 0: face 0). A non-finite yaw gives DEFAULT_INPUT_FACE.
 * @param {number} yaw  the player's yaw (0 faces −Z, positive turns left)
 * @returns {number} 0..5
 */
export function inputFaceFromYaw(yaw) {
  if (!Number.isFinite(yaw)) return DEFAULT_INPUT_FACE;
  const dx = Math.sin(yaw);
  const dz = Math.cos(yaw);
  let best = 0;
  let bestDot = -Infinity;
  for (let f = 0; f < SIDE_FACE_COUNT; f++) {
    const n = FACE_NORMALS[f];
    const dot = n[0] * dx + n[2] * dz;
    if (dot > bestDot + FACE_TIE_EPS) {
      best = f;
      bestDot = dot;
    }
  }
  return best;
}

/** @returns {number} ch rounded and clamped to a channel 1..RADIO_CHANNELS; non-numbers → 1 */
function channelOf(ch) {
  if (typeof ch !== 'number' || !Number.isFinite(ch)) return 1;
  return Math.min(RADIO_CHANNELS, Math.max(1, Math.round(ch)));
}

/**
 * A radio channel's wavelength in metres (§4.6): channel i is 300 + 50·(i − 1), 300 m to 1050 m; 600 m (channel 7) is the
 * distress wavelength. `ch` is rounded and clamped to 1..16 first (anything that is not a number reads as channel 1).
 * @param {number} ch
 * @returns {number}
 */
export function wavelengthOf(ch) {
  return RADIO_BASE_M + RADIO_STEP_M * (channelOf(ch) - 1);
}

const CHANNEL_TOKEN = /^(\d{1,3})$/;
const WAVELENGTH_TOKEN = /^(\d{1,5})\s*m$/i;

/**
 * Parse a radio channel the way players and scripts write it (§6.5 `radio`): a channel number '1'…'16', or a wavelength
 * '300m'…'1050m' (a space before the m is allowed, as is a capital M) on the 50 m grid. Surrounding spaces are ignored; a
 * number argument is taken as a channel number.
 * @param {string|number} token
 * @returns {number|null} the channel 1..16, or null
 */
export function parseChannel(token) {
  if (typeof token === 'number') return Number.isInteger(token) && token >= 1 && token <= RADIO_CHANNELS ? token : null;
  if (typeof token !== 'string') return null;
  const s = token.trim();
  let m = CHANNEL_TOKEN.exec(s);
  if (m) {
    const ch = Number(m[1]);
    return ch >= 1 && ch <= RADIO_CHANNELS ? ch : null;
  }
  m = WAVELENGTH_TOKEN.exec(s);
  if (!m) return null;
  const off = Number(m[1]) - RADIO_BASE_M;
  if (off < 0 || off % RADIO_STEP_M !== 0) return null;
  const ch = off / RADIO_STEP_M + 1;
  return ch <= RADIO_CHANNELS ? ch : null;
}

/** @returns {string} the part's teaching line (§4.13); '' for anything that is not a part */
export function partTip(id) {
  return isPart(id) ? BY_ID[id].tip : '';
}

/** @returns {string} the real thing the part is, in one line (§4.2); '' for anything that is not a part */
export function partOrigin(id) {
  return isPart(id) ? BY_ID[id].origin : '';
}
