// Caelancraft — where the circuit parts are drawn: the static knob-and-tube wiring, earth cords and powder fuses
// (`wireSegments`), every device as a small chunky 3D model standing in its cell (`wireSegments`' body records, from
// `MODELS`), and the pose of every moving or lit bit (`overlayPose`). docs/DESIGN-circuits.md §4.5, §4.11, §6.2.7 (CONTRACTS
// §53 once merged). circuitRenderer.js turns these records into instance matrices.
//
// PURE: no DOM, no three, no time, no Math.random. Everything is a function of its arguments, so a rebuild draws exactly
// what the last one drew (the fuse kinks come from hash3 of the cell).
//
// Positions are world coordinates: a cell (q, y, r) spans [y, y + 1) and its centre is hexToWorld(q, r) (CONTRACTS §0).
// A side face f's midpoint is the centre plus 0.5·FACE_NORMALS[f] (the hex inradius is 0.5).
//
// ---- The devices (the user's "fun and simple" redo) ---------------------------------------------------------------------
// The 14 devices are not hex cabinets any more: each is a few bold primitive shapes — a fat glass bulb on a wooden foot, a
// stubby teal battery with a copper cap and a "+", a lever switch with a red knob, a big red push button, a blue twin-bell
// alarm clock, a copper-coil relay, a wooden plunger box, a tilted brass dish of round selenium cells, a round board of
// binding posts, a ceramic igniter pot, a red alarm bell, a red-brown spark set with a tall antenna, a blue receiver with
// a glass coherer tube, and a black collapsar sphere with a glowing seam. Their blocks are solid but not opaque and not
// meshed (blocks.js), so the cell still collides and targets as a whole cell while the terrain draws the faces round it.
// MODELS holds each model in its own frame: the origin on the cell's floor centre, +y up, its FRONT along local +x. A relay,
// timer or coherer is turned so its front faces its input face (the side its coil current comes in by, which main sets
// toward the player at placement); every other device keeps the fixed turn 0 (front east). A model part is one instance
// of a unit shape in one batch (BATCHES): the renderer keeps one InstancedMesh per batch for the static models and one
// per batch for the moving bits, so every device costs no draw call of its own.
// The moving bits (the switch's lever, the button's cap, the clock's hand, the relay's armature, the plunger, the bell's
// striker, the lamp's filament and warm core, the glows) are overlays (below) and are drawn within the overlay range only;
// each device's silhouette is static, so a far device never loses its shape.
//
// ---- The static records (wireSegments) --------------------------------------------------------------------------
// seg:  [x0, y0, z0, x1, y1, z1, width, colourIndex] × count — a square-section bar from one end to the other.
// knob: [x, y, z, kind, length] × count — (x, y, z) is the centre of the item's BASE and `length` its height along +y:
//       kind 0 a porcelain knob (a hex spool KNOB_W wide, KNOB_H tall, its groove at WIRE_Y), 1 a porcelain tube (TUBE_W
//       square, a vertical join), 2 a brass post (POST_W hex stud: a device's binding post, or the stud a wire is screwed
//       to where it meets a device), 3 a copper ground clamp (where an earth-wire cell passes the earth walk, and where an
//       earth cord meets a device).
// body: [x, y, z, rx, ry, rz, sx, sy, sz, colour, batch] × count — one device-model part (a Pose without alpha).
// turn: [q, y, r, face] × count — the input face every relay, timer and coherer in range is turned toward, so the renderer
//       can turn its moving bits the same way (overlayPose's `face`).
// Signal wires (copper, brown, white) are knob-and-tube wiring: a knob at every cell centre on the floor, and a wire at the
// groove height from the knob to the midpoint of every side face the cell is joined (§4.5 `joins`) or attached (a source or
// load's live face, or a relay / timer / coherer's input face) through; a join through the top is a porcelain tube up to
// the knob above. There is no terminal dot. Earth wires lie on the floor as green-and-yellow striped cord, with no knobs.
// A wire, earth cord or fuse that reaches a device carries on into the device's cell as a short LEAD from the shared face
// to the model's foot (MODELS[id].foot), ending on a brass stud (a copper clamp for an earth cord), so wires visibly plug in.
// The Powder Fuse is a round cord with a seeded sideways kink in every half-segment; a cell joined on one side only (or on
// none) carries on across the cell and ends in a frayed grey tuft at its far face, so a fuse is cord from edge to edge.
//
// ---- The overlays (overlayPose) -----------------------------------------------------------------------------------
// circuits.overlays() (package B) lists `{ type, q, y, r, a, b, glow?, staff? }`. §4.11 names the types but not what `a`
// and `b` carry, so this module fixes it (the integrator maps the engine's items onto it if B chose otherwise):
// CONTRACT-ISSUE: §4.11 / §6.2.3 leave the meaning of OverlayItem.a and .b per type open; overlayPose reads them as below.
//   blade    a: how closed the knife switch is, 0 open (the lever raised BLADE_OPEN_RAD) … 1 closed (down in the jaws).
//            The renderer eases a change over BLADE_EASE_S, so the engine may send 0/1.
//   cap      a: pressed 0/1 (the cap sinks CAP_TRAVEL); b: 1 for a normally-closed button (a black cap), else red.
//   hand     a: the fraction of the delay left, left / s (the hand stands at 2π·a, clockwise from 12 on the clock's face);
//            b: 1 while the timer is holding (the hand turns honey), else 0.
//   arm      a: pulled 0..1 (the armature tilts ARM_TILT·a down onto the coil: energised or pushed by hand); b: 1 for NC
//            contacts (a white flag on the armature).
//   plunger  a: travel 0..1, 0 cocked (the T-handle PLUNGER_UP above the box) … 1 pushed home (PLUNGER_DOWN).
//   hammer   a: ringing 0/1 (the striker jitters ±HAMMER_JITTER at HAMMER_HZ and "ring" dashes flash round the bell).
//   bulb     a: the lamp's brightness 0..1 (a warm core fills the glass; nothing at 0).
//   glow     per `glow`: 'lamp' a = brightness (size GLOW.lamp.size + 0.55·a, alpha a); 'igniter' a = heat 0..1 (its coil
//            glows too); 'ember' (the torch's flame) a = strength 0..1; 'spark' (transmitter) and 'coherer' a = what is left
//            of the flash, 1 → 0; 'charge' a = strength (twinkles by itself); 'fuse' a = the burnt fraction of the cell (the
//            spark rides the burn front) and b = the face the flame came in by (−1 lit in place), or b = FUSE_AT_BUNG (or
//            the engine's −2) for a keg burning in place (the spark sits on its bung). A non-finite `a` reads as 1.
//   staff    per `staff`: 'torch' (the design's 'linstock' is accepted too; a, b unused) the leaning pitch torch, whose
//            flame is the 'ember' glow; 'filament' a = brightness (the lamp's supports and carbon loop); 'char' a = the burnt
//            fraction and b = the face the flame came in by (−1 lit in place). The entry half of a fuse cell burns over the
//            first half of a, the exit half over the second (§4.3), and the char follows the same kinks as the cord.
// A pose is `{ x, y, z, rx, ry, rz, sx, sy, sz, colour, alpha, batch }`: the centre of a unit shape (BATCHES: a box, a hex
// prism, a cylinder, a ball, a bell or, for glows, a camera-facing quad sx wide and sy tall — sy > 1.2·sx draws a flame),
// scaled by (sx, sy, sz) and then rotated by the Euler angles (rx, ry, rz) in three's 'YXZ' order; `colour` is 0xRRGGBB,
// `alpha` 0..1 and `batch` an index into BATCHES (which mesh draws it).
import { CIRCUIT_DRAW_RANGE } from './config.js';
import { BLOCK } from './blocks.js';
import { HEX_DIRS, FACE_NORMALS, FACE_OPPOSITE, FACE_TOP, FACE_BOTTOM, SIDE_FACE_COUNT, hexToWorld } from './hex.js';
import { hash3 } from './noise.js';
// CONTRACT-ISSUE: §6.1's import graph gives circuitGeometry config, blocks, hex, noise and circuitParts, but
// geometryView().cellsNear returns packCells (§6.2.3), which only coords.unpackCell decodes; coords (→ config) is added.
import { unpackCell } from './coords.js';
import { partOf, signalKind, joins, liveFaces, DEFAULT_INPUT_FACE } from './circuitParts.js';

/** @typedef {import('./types.js').OverlayItem} OverlayItem */

/**
 * The view of the circuit index that wireSegments reads (circuits.geometryView(), §6.2.3).
 * @typedef {Object} GeometryView
 * @property {(x: number, y: number, z: number, range: number) => ArrayLike<number>} cellsNear  packCells of the indexed cells
 * @property {(q: number, y: number, r: number) => number} get        the block id there (anything that is not a part is ignored)
 * @property {(q: number, y: number, r: number) => number} inputFace  a relay / timer / coherer's input face (store `f`)
 * @property {(q: number, y: number, r: number) => boolean} grounded  an earth-wire cell that passes the earth walk (§4.4)
 */

/**
 * The output buffers of wireSegments (main keeps one and reuses it; the arrays grow by doubling). `body` and `turn` are
 * added to a reused object that lacks them.
 * @typedef {{ seg: { data: Float32Array, count: number }, knob: { data: Float32Array, count: number },
 *   body?: { data: Float32Array, count: number }, turn?: { data: Float32Array, count: number } }} WireGeometry
 */

/**
 * One pose (see the header).
 * @typedef {{ x: number, y: number, z: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number,
 *   colour: number, alpha: number, batch: number }} Pose
 */

/** Floats per segment record: x0, y0, z0, x1, y1, z1, width, colourIndex. */
export const SEGMENT_STRIDE = 8;
/** Floats per knob record: x, y, z (the base centre), kind, length. */
export const KNOB_STRIDE = 5;
/** Floats per body record: x, y, z, rx, ry, rz, sx, sy, sz, colour, batch. */
export const BODY_STRIDE = 11;
/** Floats per turn record: q, y, r, face. */
export const TURN_STRIDE = 4;
/** Knob record kinds. */
export const KNOB_KIND = Object.freeze({ KNOB: 0, TUBE: 1, POST: 2, CLAMP: 3 });

/**
 * The instanced batches: one unit shape in one material each. Unit shapes are centred on their origin, 1 across and 1
 * tall: `box` a cube, `hex` a hex prism (circumradius 0.5, corners on ±z, like the cells), `cyl` a round cylinder along +y,
 * `ball` a sphere, `bell` a bell (BELL_PROFILE: rim 1 across at the bottom, mouth open downward), `quad` a camera-facing
 * square. Materials: `solid` lit like the world, `glass` clear (GLASS_ALPHA), `lit` unlit (it shines at night: hot
 * filaments, the collapsar's seam), `glow` additive light.
 */
export const BATCHES = Object.freeze([
  Object.freeze({ name: 'box', shape: 'box', mat: 'solid' }),
  Object.freeze({ name: 'hex', shape: 'hex', mat: 'solid' }),
  Object.freeze({ name: 'cyl', shape: 'cyl', mat: 'solid' }),
  Object.freeze({ name: 'ball', shape: 'ball', mat: 'solid' }),
  Object.freeze({ name: 'bell', shape: 'bell', mat: 'solid' }),
  Object.freeze({ name: 'glass', shape: 'ball', mat: 'glass' }),
  Object.freeze({ name: 'lit', shape: 'ball', mat: 'lit' }),
  Object.freeze({ name: 'lit-box', shape: 'box', mat: 'lit' }),
  Object.freeze({ name: 'glow', shape: 'quad', mat: 'glow' }),
]);
/** Indices into BATCHES. */
export const BATCH = Object.freeze({ BOX: 0, HEX: 1, CYL: 2, BALL: 3, BELL: 4, GLASS: 5, LIT: 6, LIT_BOX: 7, GLOW: 8 });
/**
 * The bell's outline as [radius, height] pairs for a lathe, in the unit bell's own frame before centring (rim radius 0.5
 * at height 0, crown at 1): down the inside from the crown to the rim, then up the outside, so it is a closed shell whose
 * mouth shows its inside from below.
 */
export const BELL_PROFILE = Object.freeze([
  [0, 0.8], [0.18, 0.76], [0.27, 0.58], [0.31, 0.32], [0.38, 0.12], [0.45, 0.02],
  [0.5, 0], [0.5, 0.05], [0.42, 0.14], [0.36, 0.34], [0.33, 0.6], [0.26, 0.84], [0.14, 0.97], [0, 1],
].map((p) => Object.freeze(p)));
/** The glass's opacity (the lamp's bulb, the coherer's tube). */
export const GLASS_ALPHA = 0.35;
/** The overlay bulb's old name: the glass alpha. */
export const BULB_ALPHA = GLASS_ALPHA;
/** Devices are drawn within this of the eye (or the wiring's range, if larger): past the fog at the default view. */
export const DEVICE_DRAW_RANGE = 96;

/**
 * Segment colours by index (0xRRGGBB, §1.4 / §4.11): copper, brown, white, earth green, earth yellow, fuse cord, the fuse's
 * frayed tuft, porcelain, brass, the copper ground clamp. No signal wire is red, blue, green or yellow.
 */
export const SEGMENT_COLOURS = Object.freeze([
  0xc8743a, 0x6b4226, 0xe8e2d0, 0x3f9f3f, 0xe0c43a, 0x2b2420, 0x8a8478, 0xe8e4da, 0xb08d3a, 0xb0683a,
]);
/** Indices into SEGMENT_COLOURS. */
export const COLOUR = Object.freeze({
  COPPER: 0, BROWN: 1, WHITE: 2, EARTH_GREEN: 3, EARTH_YELLOW: 4, FUSE: 5, FRAY: 6, PORCELAIN: 7, BRASS: 8, CLAMP: 9,
});
/** The porcelain knob's groove (a darker band round its waist, where the wire is tied). */
export const KNOB_GROOVE_COLOUR = 0xb8b2a6;

// ---- Static geometry (§4.11) --------------------------------------------------------------------------------------
/** The wire runs from the knob's groove at this height above the cell floor. */
export const WIRE_Y = 0.1;
export const WIRE_W = 0.03;
export const KNOB_W = 0.14;
export const KNOB_H = 0.12;
export const TUBE_W = 0.08;
/** A tube runs from the groove of one knob to the groove of the knob above. */
export const TUBE_LEN = 1;
export const EARTH_Y = 0.025;
export const EARTH_W = 0.05;
/** The earth cord's stripes: alternating green and yellow pieces this long. */
export const EARTH_PIECE = 0.25;
export const FUSE_Y = 0.04;
export const FUSE_W = 0.08;
/** Each fuse half-segment is bent sideways by a seeded kink within ±FUSE_KINK. */
export const FUSE_KINK = 0.06;
/** The frayed tuft at a fuse cell's free end. */
export const FRAY_LEN = 0.14;
export const POST_W = 0.06;
/** A relay, timer or coherer's two binding posts: this tall, this far either side of its input face's axis. */
export const POST_H = 0.14;
export const POST_SPREAD = 0.12;
/** The brass stud a signal lead ends on: as tall as the wire is high, plus a little. */
export const STUD_H = 0.12;
export const CLAMP_W = 0.12;
export const CLAMP_H = 0.05;

const FUSE_SEED = 0x46757365; // 'Fuse'
const TORCH_SEED = 0x546f7263; // 'Torc'
const CHARGE_SEED = 0x43686172; // 'Char'
const TWO_PI = Math.PI * 2;
const SIXTH = Math.PI / 3;

/** @returns {number} v clamped to [0, 1]; a non-finite v reads as `dflt` */
function unit(v, dflt = 1) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : dflt;
}

/**
 * The sideways kink of a fuse cell's half-segment toward face `face`: a seeded offset in [−FUSE_KINK, FUSE_KINK], the same
 * on every rebuild.
 * @returns {number}
 */
export function fuseKink(q, y, r, face) {
  return ((hash3(q, y, r, FUSE_SEED + face) / 4294967296) * 2 - 1) * FUSE_KINK;
}

/** @returns {Float32Array} `a` when it holds `n` floats, else a larger copy (doubling) */
function grow(a, n) {
  if (a.length >= n) return a;
  let len = Math.max(64, a.length);
  while (len < n) len *= 2;
  const b = new Float32Array(len);
  b.set(a);
  return b;
}

/** Append one segment record. */
function seg(out, x0, y0, z0, x1, y1, z1, width, colour) {
  const s = out.seg;
  const o = s.count * SEGMENT_STRIDE;
  s.data = grow(s.data, o + SEGMENT_STRIDE);
  const d = s.data;
  d[o] = x0;
  d[o + 1] = y0;
  d[o + 2] = z0;
  d[o + 3] = x1;
  d[o + 4] = y1;
  d[o + 5] = z1;
  d[o + 6] = width;
  d[o + 7] = colour;
  s.count++;
}

/** Append one knob record. */
function knob(out, x, y, z, kind, length) {
  const k = out.knob;
  const o = k.count * KNOB_STRIDE;
  k.data = grow(k.data, o + KNOB_STRIDE);
  const d = k.data;
  d[o] = x;
  d[o + 1] = y;
  d[o + 2] = z;
  d[o + 3] = kind;
  d[o + 4] = length;
  k.count++;
}

/** Append one body record. */
function body(out, x, y, z, rx, ry, rz, sx, sy, sz, colour, batch) {
  const b = out.body;
  const o = b.count * BODY_STRIDE;
  b.data = grow(b.data, o + BODY_STRIDE);
  const d = b.data;
  d[o] = x;
  d[o + 1] = y;
  d[o + 2] = z;
  d[o + 3] = rx;
  d[o + 4] = ry;
  d[o + 5] = rz;
  d[o + 6] = sx;
  d[o + 7] = sy;
  d[o + 8] = sz;
  d[o + 9] = colour;
  d[o + 10] = batch;
  b.count++;
}

/** Append one turn record. */
function turn(out, q, y, r, face) {
  const t = out.turn;
  const o = t.count * TURN_STRIDE;
  t.data = grow(t.data, o + TURN_STRIDE);
  const d = t.data;
  d[o] = q;
  d[o + 1] = y;
  d[o + 2] = r;
  d[o + 3] = face;
  t.count++;
}

/** @returns {number} the input face to use for a part at (q, y, r): the view's, when it is 0..6 */
function inputOf(view, id, q, y, r) {
  const p = partOf(id);
  if (!p || !p.input) return DEFAULT_INPUT_FACE;
  const f = view.inputFace(q, y, r);
  return Number.isInteger(f) && f >= 0 && f <= 6 ? f : DEFAULT_INPUT_FACE;
}

/**
 * Whether a signal wire (id) at (q, y, r) connects through its `face` to the cell beyond: joined to a conductor (§4.5 edge
 * rule, contacts taken as closed — the wiring does not move when a switch opens), or attached to a device's live face.
 */
function wireConnects(view, id, q, y, r, face, nq, ny, nr) {
  const nid = view.get(nq, ny, nr);
  const np = partOf(nid);
  if (!np || nid === BLOCK.CAMPFIRE) return false;
  const nIn = inputOf(view, nid, nq, ny, nr);
  if (joins(id, face, DEFAULT_INPUT_FACE, nid, nIn)) return true;
  return liveFaces(nid, nIn).includes(FACE_OPPOSITE[face]);
}

/** The cell beyond `face` of (q, y, r), written into `outCell` as [q, y, r] (hex.faceNeighbor without the allocation). */
function across(q, y, r, face, outCell) {
  if (face === FACE_TOP || face === FACE_BOTTOM) {
    outCell[0] = q;
    outCell[1] = face === FACE_TOP ? y + 1 : y - 1;
    outCell[2] = r;
  } else {
    outCell[0] = q + HEX_DIRS[face][0];
    outCell[1] = y;
    outCell[2] = r + HEX_DIRS[face][1];
  }
  return outCell;
}

/** A signal wire cell: its knob, a wire to every connected side face, a tube up through a connected top. */
function signalWire(view, out, id, q, y, r, wx, wz, colour, cell) {
  knob(out, wx, y, wz, KNOB_KIND.KNOB, KNOB_H);
  const wy = y + WIRE_Y;
  for (let f = 0; f <= FACE_TOP; f++) {
    across(q, y, r, f, cell);
    if (!wireConnects(view, id, q, y, r, f, cell[0], cell[1], cell[2])) continue;
    if (f === FACE_TOP) {
      knob(out, wx, wy, wz, KNOB_KIND.TUBE, TUBE_LEN);
      continue;
    }
    const n = FACE_NORMALS[f];
    seg(out, wx, wy, wz, wx + 0.5 * n[0], wy, wz + 0.5 * n[2], WIRE_W, colour);
  }
}

/** Two striped earth-cord pieces from (x, y, z) along unit (dx, dy, dz): `first` colour nearest the start. */
function earthHalf(out, x, y, z, dx, dy, dz, first) {
  const second = first === COLOUR.EARTH_GREEN ? COLOUR.EARTH_YELLOW : COLOUR.EARTH_GREEN;
  const p = EARTH_PIECE;
  seg(out, x, y, z, x + dx * p, y + dy * p, z + dz * p, EARTH_W, first);
  seg(out, x + dx * p, y + dy * p, z + dz * p, x + dx * 2 * p, y + dy * 2 * p, z + dz * 2 * p, EARTH_W, second);
}

/**
 * An earth-wire cell: striped cord on the floor to every side face that touches another earth wire or a device that needs
 * earth (a ground strap), up through the top to an earth wire above, a short stub when it joins nothing, and a copper
 * ground clamp when the cell passes the earth walk. Halves toward faces 0–2 start green at the centre and halves toward
 * 3–5 start yellow, so a straight run alternates evenly across cell boundaries.
 */
function earthWire(view, out, q, y, r, wx, wz, cell) {
  const ey = y + EARTH_Y;
  let joined = 0;
  for (let f = 0; f <= FACE_TOP; f++) {
    across(q, y, r, f, cell);
    const nid = view.get(cell[0], cell[1], cell[2]);
    const np = partOf(nid);
    if (!np || nid === BLOCK.CAMPFIRE) continue;
    const earthCord = np.role === 'wire' && np.wire === 'earth';
    if (f === FACE_TOP) {
      if (!earthCord) continue;
      joined++;
      earthHalf(out, wx, ey, wz, 0, 1, 0, COLOUR.EARTH_GREEN);
      earthHalf(out, wx, ey + 0.5, wz, 0, 1, 0, COLOUR.EARTH_GREEN);
      continue;
    }
    if (!earthCord && !np.earth) continue;
    joined++;
    const n = FACE_NORMALS[f];
    earthHalf(out, wx, ey, wz, n[0], 0, n[2], f < 3 ? COLOUR.EARTH_GREEN : COLOUR.EARTH_YELLOW);
  }
  // A join down to an earth wire below needs nothing here: that cell's riser reaches this floor.
  across(q, y, r, FACE_BOTTOM, cell);
  const below = partOf(view.get(cell[0], cell[1], cell[2]));
  if (below && below.role === 'wire' && below.wire === 'earth') joined++;
  if (joined === 0) {
    seg(out, wx - 0.2, ey, wz, wx, ey, wz, EARTH_W, COLOUR.EARTH_YELLOW);
    seg(out, wx, ey, wz, wx + 0.2, ey, wz, EARTH_W, COLOUR.EARTH_GREEN);
  }
  if (view.grounded(q, y, r)) knob(out, wx, y, wz, KNOB_KIND.CLAMP, CLAMP_H);
}

/**
 * The kink point of a fuse half-segment from the centre (cx, cz) toward side face f: the middle of the half, pushed
 * sideways (perpendicular, in the floor plane) by fuseKink. Writes [x, z] into `o`.
 */
function kinkPoint(q, y, r, f, cx, cz, o) {
  const n = FACE_NORMALS[f];
  const k = fuseKink(q, y, r, f);
  o[0] = cx + 0.25 * n[0] - n[2] * k;
  o[1] = cz + 0.25 * n[2] + n[0] * k;
  return o;
}

const KP = [0, 0];

/** A frayed grey tuft from (x, y, z) along the floor direction (dx, dz): one thick strand and two splayed thin ones. */
function fray(out, x, y, z, dx, dz) {
  seg(out, x, y, z, x + dx * FRAY_LEN, y, z + dz * FRAY_LEN, FUSE_W * 1.1, COLOUR.FRAY);
  for (const s of [-0.55, 0.55]) {
    const c = Math.cos(s);
    const n = Math.sin(s);
    const ex = dx * c - dz * n;
    const ez = dx * n + dz * c;
    seg(out, x + dx * 0.05, y, z + dz * 0.05, x + ex * FRAY_LEN * 1.15, y, z + ez * FRAY_LEN * 1.15, FUSE_W * 0.4, COLOUR.FRAY);
  }
}

/** A kinked cord half from the centre toward side face f, all the way to its midpoint. */
function fuseHalf(out, q, y, r, wx, wz, fy, f) {
  const n = FACE_NORMALS[f];
  kinkPoint(q, y, r, f, wx, wz, KP);
  seg(out, wx, fy, wz, KP[0], fy, KP[1], FUSE_W, COLOUR.FUSE);
  seg(out, KP[0], fy, KP[1], wx + 0.5 * n[0], fy, wz + 0.5 * n[2], FUSE_W, COLOUR.FUSE);
}

/**
 * The free end of a fuse: the cord carries on from the centre toward side face f (kinked like any half) and stops
 * FRAY_LEN short of the face, where the frayed tuft takes over and reaches the face — so the cell is crossed by cord
 * end to end, and the char of a fuse lit from that side (§4.11) lies on it.
 */
function fuseFreeEnd(out, q, y, r, wx, wz, fy, f) {
  const n = FACE_NORMALS[f];
  const reach = 0.5 - FRAY_LEN;
  kinkPoint(q, y, r, f, wx, wz, KP);
  seg(out, wx, fy, wz, KP[0], fy, KP[1], FUSE_W, COLOUR.FUSE);
  seg(out, KP[0], fy, KP[1], wx + reach * n[0], fy, wz + reach * n[2], FUSE_W, COLOUR.FUSE);
  fray(out, wx + reach * n[0], fy, wz + reach * n[2], n[0], n[2]);
}

/**
 * A Powder Fuse cell: a kinked cord half to every side face that touches another fuse cell, a keg or a collapsar charge,
 * and a straight riser to a fuse above. A cell that joins only one neighbour carries on across to the opposite side and
 * ends there in a frayed grey tuft; a cell that joins none is a cord across the cell from west to east, frayed at the east.
 * (A cell whose one join is vertical frays toward the east.)
 */
function fuseCell(view, out, q, y, r, wx, wz, cell) {
  const fy = y + FUSE_Y;
  let joined = 0;
  let only = -1;
  for (let f = 0; f <= FACE_BOTTOM; f++) {
    across(q, y, r, f, cell);
    const nid = view.get(cell[0], cell[1], cell[2]);
    const fuse = nid === BLOCK.POWDER_FUSE;
    const side = f < SIDE_FACE_COUNT;
    if (!fuse && !(side && (nid === BLOCK.POWDER_KEG || nid === BLOCK.COLLAPSAR_CHARGE))) continue;
    joined++;
    only = f;
    if (f === FACE_TOP) seg(out, wx, fy, wz, wx, fy + 1, wz, FUSE_W, COLOUR.FUSE);
    if (side) fuseHalf(out, q, y, r, wx, wz, fy, f);
  }
  if (joined === 0) {
    fuseHalf(out, q, y, r, wx, wz, fy, 3);
    fuseFreeEnd(out, q, y, r, wx, wz, fy, 0);
  } else if (joined === 1) {
    fuseFreeEnd(out, q, y, r, wx, wz, fy, only < SIDE_FACE_COUNT ? FACE_OPPOSITE[only] : 0);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The device models
// ---------------------------------------------------------------------------------------------------------------

/** Model colours (0xRRGGBB): cheerful, readable, and never violet (no hue 250°–300°). */
export const PAL = Object.freeze({
  wood: 0xa8743e, woodDark: 0x6e4524, woodLight: 0xc89058, oak: 0xc28b52,
  brass: 0xd2a845, brassDark: 0x9a7628, copper: 0xd9843f, copperDark: 0xa85a26, copperLight: 0xeea765,
  iron: 0x3c4248, ironLight: 0x6a727a, ebonite: 0x26282b, slate: 0x3e4a56, charcoal: 0x34383e,
  cream: 0xf3e6c4, porcelain: 0xeee8da, red: 0xe0402a, teal: 0x2f9e8f, tealDark: 0x1f6e64, sky: 0x3a86d4,
  navy: 0x35609a, navyDark: 0x264670, mahogany: 0x9a4a2c, mahoganyDark: 0x6e3220, bellRed: 0xd23c2c, terracotta: 0xc8642a,
  black: 0x24262c, seam: 0xffa040, pinprick: 0xfff4e0, glass: 0xe6f2ff, cell: 0x2a4a8a, coil: 0x4a4040,
  filings: 0x707070, tick: 0x2b2b2b, band: 0x2e3238, plus: 0xf5c542,
});

/** Where the lamp's bulb sits (its centre), the glows and the warm core follow it. */
export const BULB_Y = 0.6;
export const BULB_D = 0.56;

/**
 * One model part: [batch, x, y, z, sx, sy, sz, colour, rx, ry, rz] — the centre of a unit shape in the model's frame.
 * @returns {ReadonlyArray<number>}
 */
function P(batch, x, y, z, sx, sy, sz, colour, rx = 0, ry = 0, rz = 0) {
  return Object.freeze([batch, x, y, z, sx, sy, sz, colour, rx, ry, rz]);
}
const { BOX, CYL, BALL, BELL, GLASS, LIT } = BATCH;
const ALONG_X = Math.PI / 2; // rz that lays a cylinder (axis +y) along x
const ALONG_Z = Math.PI / 2; // rx that lays a cylinder along z

/** A box from (x0, y0) to (x1, y1) in the model's x-y plane at depth z, `t` thick and `w` deep. */
function bar(batch, x0, y0, x1, y1, z, t, w, colour) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return P(batch, (x0 + x1) / 2, (y0 + y1) / 2, z, Math.hypot(dx, dy), t, w, colour, 0, 0, Math.atan2(dy, dx));
}

/** The six round selenium discs: a rosette on a dish tilted SELENIUM_TILT toward the model's front. */
const SELENIUM_TILT = 0.6;
const SELENIUM_C = [0, 0.36, 0];
/** A point on the selenium dish: (u along its tilted x, h above its plane, v along z) → the model frame. */
function onDish(u, h, v) {
  const c = Math.cos(-SELENIUM_TILT);
  const s = Math.sin(-SELENIUM_TILT);
  return [SELENIUM_C[0] + u * c - h * s, SELENIUM_C[1] + u * s + h * c, SELENIUM_C[2] + v];
}

/** The igniter's coil: a zigzag of thin wire between its two posts (points in the model's x-y plane, z = 0). */
const IGNITER_COIL = Object.freeze([[-0.12, 0.43], [-0.06, 0.37], [0, 0.43], [0.06, 0.37], [0.12, 0.43]]);
/** The igniter's coil centre, where its glow sits. */
const IGNITER_Y = 0.4;

/**
 * Every device's model (the header): `parts` (P records), its `foot` on the floor ({ r } a disc or { hx, hz } a rectangle,
 * in the model's frame: where a lead from a neighbouring wire ends), `top` (the height its top-face binding posts stand on,
 * input parts only) and `topPosts` (their [x, z] in the model's frame).
 * @type {Readonly<Record<number, { parts: ReadonlyArray<ReadonlyArray<number>>, foot: { r?: number, hx?: number, hz?: number },
 *   top?: number, topPosts?: ReadonlyArray<ReadonlyArray<number>> }>>}
 */
export const MODELS = Object.freeze({
  // A little black sphere on an iron cradle, girdled by a glowing amber seam, its white pinprick on the crown.
  [BLOCK.COLLAPSAR_CHARGE]: {
    foot: { r: 0.21 },
    parts: [
      P(CYL, 0, 0.05, 0, 0.42, 0.1, 0.42, PAL.iron),
      P(BALL, 0, 0.4, 0, 0.64, 0.64, 0.64, PAL.black),
      P(LIT, 0, 0.4, 0, 0.67, 0.065, 0.67, PAL.seam),
      P(LIT, 0, 0.72, 0, 0.05, 0.05, 0.05, PAL.pinprick),
    ],
  },
  // A round oak board with six brass binding posts (black knobs), one toward each side face, round a brass bus ring.
  [BLOCK.TERMINAL_BOARD]: {
    foot: { r: 0.42 },
    parts: [
      P(CYL, 0, 0.02, 0, 0.84, 0.04, 0.84, PAL.woodDark),
      P(CYL, 0, 0.08, 0, 0.8, 0.08, 0.8, PAL.wood),
      P(CYL, 0, 0.13, 0, 0.2, 0.02, 0.2, PAL.brass),
      ...[0, 1, 2, 3, 4, 5].flatMap((k) => {
        const x = 0.26 * Math.cos(k * SIXTH);
        const z = 0.26 * Math.sin(k * SIXTH);
        return [P(CYL, x, 0.19, z, 0.08, 0.14, 0.08, PAL.brass), P(CYL, x, 0.29, z, 0.15, 0.07, 0.15, PAL.ebonite)];
      }),
    ],
  },
  // A stubby teal battery, a dark band with a yellow "+" on four sides, a copper cap and nub. Full height: a pile stacks
  // nub to foot.
  [BLOCK.VOLTAIC_BATTERY]: {
    foot: { r: 0.28 },
    parts: [
      P(CYL, 0, 0.02, 0, 0.56, 0.04, 0.56, PAL.tealDark),
      P(CYL, 0, 0.45, 0, 0.56, 0.82, 0.56, PAL.teal),
      P(CYL, 0, 0.44, 0, 0.576, 0.28, 0.576, PAL.band),
      ...[0, 1, 2, 3].flatMap((k) => {
        const a = (k * Math.PI) / 2;
        const x = 0.292 * Math.cos(a);
        const z = 0.292 * Math.sin(a);
        return [P(BOX, x, 0.44, z, 0.03, 0.045, 0.15, PAL.plus, 0, -a), P(BOX, x, 0.44, z, 0.03, 0.15, 0.045, PAL.plus, 0, -a)];
      }),
      P(CYL, 0, 0.885, 0, 0.42, 0.05, 0.42, PAL.copper),
      P(CYL, 0, 0.955, 0, 0.18, 0.09, 0.18, PAL.copperLight),
    ],
  },
  // A wooden plunger box with two dark straps and a brass plate front and back; the T-handle plunger is an overlay.
  [BLOCK.BLASTING_MACHINE]: {
    foot: { hx: 0.3, hz: 0.22 },
    parts: [
      P(BOX, 0, 0.25, 0, 0.6, 0.5, 0.44, PAL.wood),
      P(BOX, 0.2, 0.255, 0, 0.06, 0.51, 0.46, PAL.woodDark),
      P(BOX, -0.2, 0.255, 0, 0.06, 0.51, 0.46, PAL.woodDark),
      P(BOX, 0.305, 0.28, 0, 0.02, 0.14, 0.2, PAL.brass),
      P(BOX, -0.305, 0.28, 0, 0.02, 0.14, 0.2, PAL.brass),
      P(CYL, 0, 0.52, 0, 0.16, 0.04, 0.16, PAL.brass),
    ],
  },
  // A brass dish on a post, tilted to the sky, holding six round blue-black selenium cells in a hex rosette.
  [BLOCK.SELENIUM_PANEL]: {
    foot: { r: 0.3 },
    parts: [
      P(CYL, 0, 0.03, 0, 0.6, 0.06, 0.6, PAL.wood),
      P(BOX, 0, 0.17, 0, 0.08, 0.22, 0.08, PAL.iron),
      P(CYL, ...onDish(0, 0, 0), 0.72, 0.04, 0.72, PAL.brass, 0, 0, -SELENIUM_TILT),
      P(BALL, ...onDish(0, 0.03, 0), 0.08, 0.05, 0.08, PAL.brassDark, 0, 0, -SELENIUM_TILT),
      ...[0, 1, 2, 3, 4, 5].map((k) => {
        const a = k * SIXTH + SIXTH / 2;
        return P(CYL, ...onDish(0.2 * Math.cos(a), 0.03, 0.2 * Math.sin(a)), 0.17, 0.02, 0.17, PAL.cell, 0, 0, -SELENIUM_TILT);
      }),
    ],
  },
  // A slate base with brass hinge cheeks (west) and jaws (east) and two terminal nuts; the copper lever is an overlay.
  [BLOCK.KNIFE_SWITCH]: {
    foot: { hx: 0.39, hz: 0.2 },
    parts: [
      P(BOX, 0, 0.05, 0, 0.78, 0.1, 0.4, PAL.slate),
      P(CYL, -0.34, 0.12, 0, 0.08, 0.04, 0.08, PAL.brass),
      P(CYL, 0.34, 0.12, 0, 0.08, 0.04, 0.08, PAL.brass),
      P(BOX, -0.24, 0.18, 0.055, 0.08, 0.16, 0.03, PAL.brass),
      P(BOX, -0.24, 0.18, -0.055, 0.08, 0.16, 0.03, PAL.brass),
      P(BOX, 0.24, 0.17, 0.05, 0.1, 0.14, 0.03, PAL.brass),
      P(BOX, 0.24, 0.17, -0.05, 0.1, 0.14, 0.03, PAL.brass),
    ],
  },
  // A round charcoal base with a brass collar; the big red (NC: black) cap is an overlay.
  [BLOCK.PUSH_BUTTON]: {
    foot: { r: 0.3 },
    parts: [
      P(CYL, 0, 0.11, 0, 0.6, 0.22, 0.6, PAL.charcoal),
      P(CYL, 0, 0.24, 0, 0.48, 0.04, 0.48, PAL.brass),
    ],
  },
  // A blue twin-bell alarm clock on a wooden plinth, its cream face (with four ticks and a brass hub) to the front, a
  // winding key behind; the hand is an overlay.
  [BLOCK.CLOCKWORK_TIMER]: {
    foot: { hx: 0.16, hz: 0.25 },
    top: 0.74,
    topPosts: [[-0.06, 0], [0.06, 0]],
    parts: [
      P(BOX, 0, 0.025, 0, 0.32, 0.05, 0.5, PAL.wood),
      P(CYL, 0, 0.12, 0.15, 0.07, 0.16, 0.07, PAL.brass),
      P(CYL, 0, 0.12, -0.15, 0.07, 0.16, 0.07, PAL.brass),
      P(CYL, 0, 0.44, 0, 0.6, 0.2, 0.6, PAL.sky, 0, 0, ALONG_X),
      P(CYL, 0.1, 0.44, 0, 0.56, 0.03, 0.56, PAL.brass, 0, 0, ALONG_X),
      P(CYL, 0.112, 0.44, 0, 0.48, 0.02, 0.48, PAL.cream, 0, 0, ALONG_X),
      P(BOX, 0.124, 0.62, 0, 0.01, 0.06, 0.025, PAL.tick),
      P(BOX, 0.124, 0.26, 0, 0.01, 0.06, 0.025, PAL.tick),
      P(BOX, 0.124, 0.44, 0.18, 0.01, 0.025, 0.06, PAL.tick),
      P(BOX, 0.124, 0.44, -0.18, 0.01, 0.025, 0.06, PAL.tick),
      P(BALL, 0.13, 0.44, 0, 0.05, 0.05, 0.05, PAL.brass),
      P(BELL, 0, 0.75, 0.16, 0.2, 0.13, 0.2, PAL.brass, 0.45),
      P(BELL, 0, 0.75, -0.16, 0.2, 0.13, 0.2, PAL.brass, -0.45),
      P(CYL, -0.13, 0.44, 0, 0.04, 0.06, 0.04, PAL.brass, 0, 0, ALONG_X),
      P(BOX, -0.165, 0.44, 0, 0.02, 0.1, 0.16, PAL.brass),
    ],
  },
  // An oak base with a fat copper coil (iron pole pieces, two darker windings) at the front and the armature's brass
  // pivot bracket at the back; the steel armature is an overlay.
  [BLOCK.RELAY]: {
    foot: { hx: 0.33, hz: 0.22 },
    top: 0.52,
    topPosts: [[0.1, 0.15], [0.1, -0.15]],
    parts: [
      P(BOX, 0, 0.04, 0, 0.66, 0.08, 0.44, PAL.oak),
      P(CYL, 0.1, 0.1, 0, 0.34, 0.04, 0.34, PAL.iron),
      P(CYL, 0.1, 0.26, 0, 0.3, 0.28, 0.3, PAL.copper),
      P(CYL, 0.1, 0.2, 0, 0.312, 0.02, 0.312, PAL.copperDark),
      P(CYL, 0.1, 0.32, 0, 0.312, 0.02, 0.312, PAL.copperDark),
      P(CYL, 0.1, 0.42, 0, 0.34, 0.04, 0.34, PAL.iron),
      P(BOX, -0.24, 0.29, 0, 0.06, 0.42, 0.16, PAL.brass),
      P(BOX, -0.3, 0.14, 0, 0.06, 0.12, 0.1, PAL.brass),
    ],
  },
  // A cream ceramic pot with a terracotta rim and a dark mouth, two brass posts and a thin coil between them (it glows
  // when powered: an overlay).
  [BLOCK.IGNITER]: {
    foot: { r: 0.22 },
    parts: [
      P(CYL, 0, 0.15, 0, 0.44, 0.3, 0.44, PAL.porcelain),
      P(CYL, 0, 0.31, 0, 0.47, 0.04, 0.47, PAL.terracotta),
      P(CYL, 0, 0.334, 0, 0.36, 0.01, 0.36, 0x3a2a22),
      P(CYL, -0.12, 0.38, 0, 0.05, 0.1, 0.05, PAL.brass),
      P(CYL, 0.12, 0.38, 0, 0.05, 0.1, 0.05, PAL.brass),
      ...IGNITER_COIL.slice(1).map(([x1, y1], k) => bar(BOX, IGNITER_COIL[k][0], IGNITER_COIL[k][1], x1, y1, 0, 0.018, 0.018, PAL.coil)),
    ],
  },
  // A fat round glass bulb in a brass socket on a round wooden foot; the filament, the warm core and the glow are overlays.
  [BLOCK.FILAMENT_LAMP]: {
    foot: { r: 0.31 },
    parts: [
      P(CYL, 0, 0.05, 0, 0.62, 0.1, 0.62, PAL.wood),
      P(CYL, 0, 0.12, 0, 0.5, 0.04, 0.5, PAL.woodDark),
      P(CYL, 0, 0.24, 0, 0.24, 0.2, 0.24, PAL.brass),
      P(CYL, 0, 0.2, 0, 0.256, 0.025, 0.256, PAL.brassDark),
      P(CYL, 0, 0.27, 0, 0.256, 0.025, 0.256, PAL.brassDark),
      P(GLASS, 0, BULB_Y, 0, BULB_D, BULB_D, BULB_D, PAL.glass),
    ],
  },
  // A red alarm bell on a brass post over a dark round base, with its electromagnet pair at the west; the striker is an
  // overlay.
  [BLOCK.ELECTRIC_BELL]: {
    foot: { r: 0.42 },
    parts: [
      P(CYL, 0, 0.04, 0, 0.84, 0.08, 0.84, PAL.woodDark),
      P(CYL, 0, 0.17, 0, 0.08, 0.18, 0.08, PAL.brass),
      P(BELL, 0, 0.45, 0, 0.6, 0.4, 0.6, PAL.bellRed),
      P(BALL, 0, 0.66, 0, 0.08, 0.06, 0.08, PAL.brass),
      P(CYL, -0.33, 0.15, 0.07, 0.09, 0.14, 0.09, PAL.ebonite),
      P(CYL, -0.33, 0.15, -0.07, 0.09, 0.14, 0.09, PAL.ebonite),
      P(BOX, -0.4, 0.08, 0, 0.04, 0.08, 0.06, PAL.brass),
    ],
  },
  // A red-brown box with a Morse key at the front, two brass spark balls and a tall whippy antenna with a red tip.
  [BLOCK.SPARK_TRANSMITTER]: {
    foot: { hx: 0.28, hz: 0.21 },
    parts: [
      P(BOX, 0, 0.18, 0, 0.56, 0.36, 0.42, PAL.mahogany),
      P(BOX, 0, 0.37, 0, 0.5, 0.02, 0.36, PAL.mahoganyDark),
      P(BOX, 0.12, 0.39, 0.08, 0.2, 0.02, 0.09, PAL.brass),
      P(BOX, 0.13, 0.42, 0.08, 0.24, 0.025, 0.04, PAL.ebonite, 0, 0, 0.12),
      P(CYL, 0.245, 0.45, 0.08, 0.08, 0.04, 0.08, PAL.ebonite),
      P(CYL, -0.02, 0.42, -0.1, 0.03, 0.1, 0.03, PAL.brass),
      P(CYL, 0.12, 0.42, -0.1, 0.03, 0.1, 0.03, PAL.brass),
      P(BALL, -0.02, 0.49, -0.1, 0.09, 0.09, 0.09, PAL.brass),
      P(BALL, 0.12, 0.49, -0.1, 0.09, 0.09, 0.09, PAL.brass),
      P(CYL, -0.2, 0.53, 0.12, 0.04, 0.34, 0.04, PAL.iron),
      bar(CYL, -0.2, 0.7, -0.17, 0.97, 0.12, 0.028, 0.028, PAL.iron),
      P(BALL, -0.168, 0.98, 0.12, 0.08, 0.08, 0.08, PAL.red),
    ],
  },
  // A blue box with a glass coherer tube (brass caps, grey filings) across its lid, a cream tuning dial at the front and a
  // short antenna with a brass ball.
  [BLOCK.COHERER_RECEIVER]: {
    foot: { hx: 0.28, hz: 0.21 },
    top: 0.34,
    topPosts: [[0.18, 0.1], [0.18, -0.1]],
    parts: [
      P(BOX, 0, 0.16, 0, 0.56, 0.32, 0.42, PAL.navy),
      P(BOX, 0, 0.33, 0, 0.5, 0.02, 0.36, PAL.navyDark),
      P(BOX, 0, 0.37, 0.17, 0.05, 0.08, 0.05, PAL.brass),
      P(BOX, 0, 0.37, -0.17, 0.05, 0.08, 0.05, PAL.brass),
      P(CYL, 0, 0.43, 0.17, 0.14, 0.05, 0.14, PAL.brass, ALONG_Z),
      P(CYL, 0, 0.43, -0.17, 0.14, 0.05, 0.14, PAL.brass, ALONG_Z),
      P(BOX, 0, 0.405, 0, 0.05, 0.03, 0.2, PAL.filings),
      P(GLASS, 0, 0.43, 0, 0.14, 0.14, 0.36, PAL.glass),
      P(CYL, 0.285, 0.18, 0, 0.17, 0.02, 0.17, PAL.cream, 0, 0, ALONG_X),
      P(BOX, 0.296, 0.21, 0, 0.004, 0.06, 0.012, PAL.tick),
      P(CYL, -0.2, 0.58, 0.12, 0.03, 0.5, 0.03, PAL.iron),
      P(BALL, -0.2, 0.84, 0.12, 0.07, 0.07, 0.07, PAL.brass),
    ],
  },
});

/** The block ids that have a model (the 14 devices). */
export const MODEL_IDS = Object.freeze(Object.keys(MODELS).map(Number).sort((a, b) => a - b));

/** @returns {boolean} the block is a device drawn as a model */
export function hasModel(id) {
  return Object.hasOwn(MODELS, id);
}

/** @returns {number} the yaw a model is turned by for input face `face` (0 for none or the top) */
export function faceYaw(face) {
  return Number.isInteger(face) && face >= 0 && face < SIDE_FACE_COUNT ? -face * SIXTH : 0;
}

/**
 * How far from the cell's centre a lead from side face f meets the model's foot, for a model turned by `yaw`.
 * @returns {number}
 */
function skin(foot, f, yaw) {
  if (foot.r !== undefined) return foot.r;
  const a = f * SIXTH + yaw; // the face's direction in the model's frame
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  return Math.min(c > 1e-6 ? foot.hx / c : Infinity, s > 1e-6 ? foot.hz / s : Infinity);
}

/** The earth-cord pieces of a lead from (x0, z0) to (x1, z1) at height y, starting with colour `first`. */
function earthLead(out, x0, z0, x1, z1, y, first) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  let c = first;
  for (let s = 0; s < len - 1e-6; s += EARTH_PIECE) {
    const e = Math.min(len, s + EARTH_PIECE);
    seg(out, x0 + ((x1 - x0) * s) / len, y, z0 + ((z1 - z0) * s) / len, x0 + ((x1 - x0) * e) / len, y, z0 + ((z1 - z0) * e) / len,
      EARTH_W, c);
    c = c === COLOUR.EARTH_GREEN ? COLOUR.EARTH_YELLOW : COLOUR.EARTH_GREEN;
  }
}

/**
 * A device cell: its model (body records, turned toward its input face if it has one), a lead from every wire, earth cord
 * or fuse that reaches it (to its foot, on a brass stud or a copper clamp), and for a relay, timer or coherer two brass
 * binding posts on its input side (on its top for the top face) and a turn record.
 */
function deviceCell(view, out, id, q, y, r, wx, wz, cell) {
  const m = MODELS[id];
  const p = /** @type {*} */ (partOf(id));
  const inFace = p.input ? inputOf(view, id, q, y, r) : -1;
  const yaw = faceYaw(inFace);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  if (p.input) turn(out, q, y, r, inFace);
  for (const [batch, lx, ly, lz, sx, sy, sz, colour, rx, ry, rz] of m.parts) {
    body(out, wx + c * lx + s * lz, y + ly, wz - s * lx + c * lz, rx, ry + yaw, rz, sx, sy, sz, colour, batch);
  }
  for (let f = 0; f < SIDE_FACE_COUNT; f++) {
    across(q, y, r, f, cell);
    const nid = view.get(cell[0], cell[1], cell[2]);
    const n = FACE_NORMALS[f];
    const d = skin(m.foot, f, yaw);
    if (!(d < 0.5)) continue;
    const mx = wx + 0.5 * n[0];
    const mz = wz + 0.5 * n[2];
    const ex = wx + d * n[0];
    const ez = wz + d * n[2];
    const kind = signalKind(nid);
    if (kind && wireConnects(view, nid, cell[0], cell[1], cell[2], FACE_OPPOSITE[f], q, y, r)) {
      seg(out, mx, y + WIRE_Y, mz, ex, y + WIRE_Y, ez, WIRE_W, COLOUR[kind.toUpperCase()]);
      // The input face has its binding posts instead of a stud.
      if (f !== inFace) knob(out, ex + n[0] * POST_W * 0.5, y, ez + n[2] * POST_W * 0.5, KNOB_KIND.POST, STUD_H);
    } else if (nid === BLOCK.EARTH_WIRE && p.earth) {
      // Carry the neighbour's stripes on: its half toward us ended with the colour opposite the one it started with.
      const F = FACE_OPPOSITE[f];
      earthLead(out, mx, mz, ex, ez, y + EARTH_Y, F < 3 ? COLOUR.EARTH_GREEN : COLOUR.EARTH_YELLOW);
      knob(out, ex + n[0] * CLAMP_W * 0.5, y, ez + n[2] * CLAMP_W * 0.5, KNOB_KIND.CLAMP, CLAMP_H);
    } else if (nid === BLOCK.POWDER_FUSE && id === BLOCK.COLLAPSAR_CHARGE) {
      seg(out, mx, y + FUSE_Y, mz, ex, y + FUSE_Y, ez, FUSE_W, COLOUR.FUSE);
    }
  }
  if (!p.input) return;
  if (inFace === FACE_TOP) {
    for (const [px, pz] of /** @type {ReadonlyArray<ReadonlyArray<number>>} */ (m.topPosts)) {
      knob(out, wx + px, y + /** @type {number} */ (m.top), wz + pz, KNOB_KIND.POST, POST_H);
    }
    return;
  }
  const n = FACE_NORMALS[inFace];
  const d = skin(m.foot, inFace, yaw) + POST_W * 0.5;
  for (const side of [-1, 1]) {
    knob(out, wx + d * n[0] - side * n[2] * POST_SPREAD, y, wz + d * n[2] + side * n[0] * POST_SPREAD, KNOB_KIND.POST, POST_H);
  }
}

const CELL = [0, 0, 0];
const NEIGH = [0, 0, 0];

/**
 * Build the static circuit geometry within range of (x, y, z) (§4.11): segment records for every wire, earth cord, fuse and
 * lead, knob records for knobs, tubes, binding posts, studs and ground clamps, body records for every device model and turn
 * records for the relays, timers and coherers. A wire or fuse cell is drawn when its centre is within `range` (default
 * CIRCUIT_DRAW_RANGE) of the point, a device within the larger of `range` and DEVICE_DRAW_RANGE, in the order
 * view.cellsNear lists them.
 * @param {GeometryView} view
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} range
 * @param {WireGeometry} [out]  reused (its counts are reset); a fresh one when omitted
 * @returns {WireGeometry}
 */
export function wireSegments(view, x, y, z, range, out) {
  const o = out ?? { seg: { data: new Float32Array(64 * SEGMENT_STRIDE), count: 0 }, knob: { data: new Float32Array(64 * KNOB_STRIDE), count: 0 } };
  if (!o.body) o.body = { data: new Float32Array(64 * BODY_STRIDE), count: 0 };
  if (!o.turn) o.turn = { data: new Float32Array(16 * TURN_STRIDE), count: 0 };
  o.seg.count = 0;
  o.knob.count = 0;
  o.body.count = 0;
  o.turn.count = 0;
  if (!view) return o;
  const R = Number.isFinite(range) && range >= 0 ? range : CIRCUIT_DRAW_RANGE;
  const RD = Math.max(R, DEVICE_DRAW_RANGE);
  const cells = view.cellsNear(x, y, z, RD);
  for (let i = 0; i < cells.length; i++) {
    unpackCell(cells[i], CELL);
    const q = CELL[0];
    const cy = CELL[1];
    const r = CELL[2];
    const [wx, wz] = hexToWorld(q, r);
    const dx = wx - x;
    const dy = cy + 0.5 - y;
    const dz = wz - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > RD * RD) continue;
    const id = view.get(q, cy, r);
    const p = partOf(id);
    if (!p) continue;
    if (hasModel(id)) {
      deviceCell(view, o, id, q, cy, r, wx, wz, NEIGH);
      continue;
    }
    if (d2 > R * R) continue;
    const kind = signalKind(id);
    if (kind) signalWire(view, o, id, q, cy, r, wx, wz, COLOUR[kind.toUpperCase()], NEIGH);
    else if (p.role === 'wire') earthWire(view, o, q, cy, r, wx, wz, NEIGH);
    else if (id === BLOCK.POWDER_FUSE) fuseCell(view, o, q, cy, r, wx, wz, NEIGH);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------------------------
// Overlays (§4.11)
// ---------------------------------------------------------------------------------------------------------------

/** The knife switch's lever: open angle, length, hinge (on the model's west, over the hinge cheeks) and easing. */
export const BLADE_OPEN_RAD = (65 * Math.PI) / 180;
export const BLADE_LEN = 0.48;
export const BLADE_EASE_S = 0.12;
export const BLADE_HINGE_X = -0.24;
export const BLADE_Y = 0.2;
/** The push button's cap: its travel, and the collar it stands on. */
export const CAP_TRAVEL = 0.05;
export const CAP_Y = 0.26;
/** The clock's hand: its length, and the hub on the clock's face it turns about (model frame). */
export const HAND_LEN = 0.19;
export const HAND_HUB = Object.freeze([0.13, 0.44, 0]);
/** The relay's armature: its tilt when pulled, its pivot (model frame) and length. */
export const ARM_TILT = (12 * Math.PI) / 180;
export const ARM_PIVOT = Object.freeze([-0.24, 0.52]);
export const ARM_LEN = 0.5;
/** The plunger: the T-handle's height above the box's bushing, cocked and pushed home; the bushing's top. */
export const PLUNGER_UP = 0.36;
export const PLUNGER_DOWN = 0.04;
export const PLUNGER_BASE = 0.54;
/** The bell's striker: its jitter while ringing, its pivot and its ball's rest point (model frame). */
export const HAMMER_JITTER = (10 * Math.PI) / 180;
export const HAMMER_HZ = 15;
export const HAMMER_PIVOT = Object.freeze([-0.4, 0.1]);
export const HAMMER_BALL = Object.freeze([-0.325, 0.3]);
/** The "ring" dashes round a ringing bell flash at this rate (on 60 % of each period). */
export const RING_BLINK_HZ = 4;
/** The torch: its length along the shaft and its lean from the vertical (in a seeded direction). */
export const TORCH_LEN = 0.95;
export const TORCH_LEAN = (12 * Math.PI) / 180;
export const CHAR_W = 0.12;
/** glow 'fuse' with this `b`: a keg burning in place (the spark sits on its bung). The engine's −2 means the same. */
export const FUSE_AT_BUNG = 8;

/** Glow colours and base sizes (§4.11). */
export const GLOW = Object.freeze({
  lamp: Object.freeze({ colour: 0xffd27a, size: 0.35 }),
  igniter: Object.freeze({ colour: 0xff4a1a, size: 0.45 }),
  ember: Object.freeze({ colour: 0xff7a2a, size: 0.1 }),
  spark: Object.freeze({ colour: 0xcfe4ff, size: 0.6 }),
  coherer: Object.freeze({ colour: 0x9fd0ff, size: 0.35 }),
  charge: Object.freeze({ colour: 0xf4f1ea, size: 0.14 }),
  fuse: Object.freeze({ colour: 0xffcf6a, size: 0.22 }),
});

const COL = Object.freeze({
  copper: 0xd9843f, ebonite: 0x26282b, knob: 0xe0402a, brass: 0xd2a845, red: 0xe0402a, black: 0x26282b,
  hand: 0x222426, honey: 0xe8b04a, steel: 0x8a9098, handle: 0x5a3820, armature: 0x9aa2aa, flag: 0xf4f0e6,
  ring: 0xffe680, coreDim: 0x8a6a30, coreHot: 0xffe9a0, carbon: 0x2a2622, carbonHot: 0xffe6a8, support: 0x8a8a86,
  coilHot: 0xff8a3a, ash: 0xc9a46a, torchIron: 0x3a3d42, pitch: 0x2b2420, twine: 0xb8a77a, char: 0x5a5650,
  emberHalo: 0xff9a40,
});

/** @returns {Pose} out[i], created when missing */
function slot(out, i) {
  let p = out[i];
  if (!p) {
    p = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, colour: 0xffffff, alpha: 1, batch: 0 };
    out[i] = p;
  }
  return p;
}

/** Write pose i (world coordinates) and return i + 1. */
function pose(out, i, batch, x, y, z, rx, ry, rz, sx, sy, sz, colour, alpha = 1) {
  const p = slot(out, i);
  p.x = x;
  p.y = y;
  p.z = z;
  p.rx = rx;
  p.ry = ry;
  p.rz = rz;
  p.sx = sx;
  p.sy = sy;
  p.sz = sz;
  p.colour = colour;
  p.alpha = alpha;
  p.batch = batch;
  return i + 1;
}

// The model frame of the item being posed: its cell's floor centre and its turn (local writes go through `lp`).
let FX = 0;
let FY = 0;
let FZ = 0;
let FYAW = 0;
let FC = 1;
let FS = 0;

function frame(cx, y, cz, yaw) {
  FX = cx;
  FY = y;
  FZ = cz;
  FYAW = yaw;
  FC = Math.cos(yaw);
  FS = Math.sin(yaw);
}

/** Write pose i from the model frame (see frame) and return i + 1. */
function lp(out, i, batch, lx, ly, lz, sx, sy, sz, colour, rx = 0, ry = 0, rz = 0, alpha = 1) {
  return pose(out, i, batch, FX + FC * lx + FS * lz, FY + ly, FZ - FS * lx + FC * lz, rx, ry + FYAW, rz, sx, sy, sz, colour, alpha);
}

/** A model-frame box (or other batch) from (x0, y0) to (x1, y1) in the x-y plane at depth z. Returns i + 1. */
function lbar(out, i, batch, x0, y0, x1, y1, z, t, w, colour) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return lp(out, i, batch, (x0 + x1) / 2, (y0 + y1) / 2, z, Math.hypot(dx, dy), t, w, colour, 0, 0, Math.atan2(dy, dx));
}

/** A floor-plane box from (x0, z0) to (x1, z1) at height y (world): its pose (centre, ry, length). Returns i + 1. */
function flatBar(out, i, x0, z0, x1, z1, y, w, h, colour) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  return pose(out, i, BATCH.BOX, (x0 + x1) / 2, y, (z0 + z1) / 2, 0, -Math.atan2(dz, dx), 0, len, h, w, colour);
}

/** @returns {number} 0..1, a seeded value per cell */
function cellRand(q, y, r, seed) {
  return hash3(q, y, r, seed) / 4294967296;
}

/**
 * The torch's lean (§4.11: 12° in a seeded direction) as [foot x, foot z, axis x, axis y, axis z, direction φ]. The foot
 * is set back from the centre so the head stands over the middle of the cell.
 * @returns {number[]}
 */
export function torchAxis(q, y, r, o = [0, 0, 0, 0, 0, 0]) {
  const [cx, cz] = hexToWorld(q, r);
  const phi = cellRand(q, y, r, TORCH_SEED) * TWO_PI;
  const s = Math.sin(TORCH_LEAN);
  const half = 0.5 * TORCH_LEN * s;
  o[0] = cx - half * Math.cos(phi);
  o[1] = cz - half * Math.sin(phi);
  o[2] = s * Math.cos(phi);
  o[3] = Math.cos(TORCH_LEAN);
  o[4] = s * Math.sin(phi);
  o[5] = phi;
  return o;
}
const AX = [0, 0, 0, 0, 0, 0];

/** A box along the torch's axis from s0 to s1 (distances from the foot), `w` thick. Returns i + 1. */
function torchPiece(out, i, y, s0, s1, w, colour) {
  const m = (s0 + s1) / 2;
  return pose(out, i, BATCH.BOX, AX[0] + AX[2] * m, y + AX[3] * m, AX[1] + AX[4] * m, 0, -AX[5], -TORCH_LEAN, w, s1 - s0, w, colour);
}

/**
 * The fuse's burn path through a cell, from the flame's entry face `from` (side faces only; anything else starts at the
 * centre) through the centre and on out of the opposite face, following the same kinks as wireSegments. Writes up to 5
 * points [x, z] into `pts` and returns how many, with each leg's length in `lens`.
 */
function fusePath(q, y, r, from, pts, lens) {
  const [cx, cz] = hexToWorld(q, r);
  let n = 0;
  const push = (x, z) => {
    pts[n][0] = x;
    pts[n][1] = z;
    if (n > 0) lens[n - 1] = Math.hypot(x - pts[n - 1][0], z - pts[n - 1][1]);
    n++;
  };
  if (Number.isInteger(from) && from >= 0 && from < SIDE_FACE_COUNT) {
    const nb = FACE_NORMALS[from];
    push(cx + 0.5 * nb[0], cz + 0.5 * nb[2]);
    kinkPoint(q, y, r, from, cx, cz, KP);
    push(KP[0], KP[1]);
    push(cx, cz);
    const o = FACE_OPPOSITE[from];
    const no = FACE_NORMALS[o];
    kinkPoint(q, y, r, o, cx, cz, KP);
    push(KP[0], KP[1]);
    push(cx + 0.5 * no[0], cz + 0.5 * no[2]);
  } else {
    push(cx, cz);
  }
  return n;
}
const PATH = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
const LENS = [0, 0, 0, 0];

/**
 * The distance along the path reached at burn fraction u: the entry half (entry face → centre) takes the first half of the
 * burn and the exit half the second (§4.3: "the first half of t, then … the second half"), each at its own pace.
 */
function burnt(n, u) {
  const first = LENS[0] + LENS[1];
  const second = n === 5 ? LENS[2] + LENS[3] : 0;
  return u <= 0.5 ? 2 * u * first : first + (2 * u - 1) * second;
}

/** The point at burn fraction u (0..1) along the path: [x, z] into `o`. */
function alongPath(n, u, o) {
  if (n === 1) {
    o[0] = PATH[0][0];
    o[1] = PATH[0][1];
    return o;
  }
  let left = burnt(n, u);
  for (let i = 0; i < n - 1; i++) {
    if (left <= LENS[i] || i === n - 2) {
      const t = LENS[i] > 0 ? Math.min(1, left / LENS[i]) : 0;
      o[0] = PATH[i][0] + (PATH[i + 1][0] - PATH[i][0]) * t;
      o[1] = PATH[i][1] + (PATH[i + 1][1] - PATH[i][1]) * t;
      return o;
    }
    left -= LENS[i];
  }
  return o;
}
const AT = [0, 0];

/** @returns {number} a smooth, irregular 0..1 flicker for a cell at time t */
function flicker(t, q, y, r, seed) {
  const s = cellRand(q, y, r, seed) * 100;
  const v = Math.sin(t * 7.3 + s) * 0.5 + Math.sin(t * 13.1 + s * 1.7) * 0.3 + Math.sin(t * 23.7 + s * 2.3) * 0.2;
  return 0.5 + 0.5 * v;
}

/** The item types whose device is turned toward its input face (overlayPose reads `face` for these only). */
const TURNED = Object.freeze({ hand: true, arm: true });

/**
 * The pose(s) of one overlay item at time `t` (seconds; animations only: the striker's jitter, the ring dashes, the
 * flickers and the charge's twinkle), written into `out[0..n-1]` (pose objects are created on first use and reused). See
 * the header for what each type reads from `a` and `b`. `face` is the input face of a relay or timer (the renderer keeps
 * them from wireSegments' turn records), which turns its hand or armature exactly as wireSegments turned its model: a
 * missing face is DEFAULT_INPUT_FACE (as the view reads a part without a store entry), and the top face or a bad one is
 * turn 0. Every other type ignores `face`. An item of unknown type writes nothing.
 * @param {OverlayItem} item
 * @param {number} t
 * @param {Pose[]} out
 * @param {number} [face]
 * @returns {number} n, the number of poses written
 */
export function overlayPose(item, t, out, face) {
  if (!item) return 0;
  const { q, y, r } = item;
  if (!Number.isFinite(q) || !Number.isFinite(y) || !Number.isFinite(r)) return 0;
  const [cx, cz] = hexToWorld(q, r);
  const time = Number.isFinite(t) ? t : 0;
  frame(cx, y, cz, TURNED[item.type] ? faceYaw(face ?? DEFAULT_INPUT_FACE) : 0);
  let i = 0;
  switch (item.type) {
    case 'blade': {
      // The copper lever, hinged between the west cheeks: down in the east jaws when closed, raised when open, with an
      // ebonite stem and a red ball knob standing up from its free end.
      const th = BLADE_OPEN_RAD * (1 - unit(item.a, 0));
      const c = Math.cos(th);
      const s = Math.sin(th);
      const ex = BLADE_HINGE_X + c * BLADE_LEN;
      const ey = BLADE_Y + s * BLADE_LEN;
      i = lp(out, i, BATCH.BOX, BLADE_HINGE_X + c * BLADE_LEN * 0.5, BLADE_Y + s * BLADE_LEN * 0.5, 0, BLADE_LEN, 0.06, 0.08,
        COL.copper, 0, 0, th);
      i = lp(out, i, BATCH.CYL, ex - s * 0.08, ey + c * 0.08, 0, 0.04, 0.14, 0.04, COL.ebonite, 0, 0, th);
      i = lp(out, i, BATCH.BALL, ex - s * 0.17, ey + c * 0.17, 0, 0.12, 0.12, 0.12, COL.knob);
      return i;
    }
    case 'cap': {
      // A big round cap with a domed top: red, or black for a normally-closed button.
      const down = unit(item.a, 0) * CAP_TRAVEL;
      const colour = item.b === 1 ? COL.black : COL.red;
      i = lp(out, i, BATCH.CYL, 0, CAP_Y + 0.05 - down, 0, 0.38, 0.1, 0.38, colour);
      i = lp(out, i, BATCH.BALL, 0, CAP_Y + 0.1 - down, 0, 0.38, 0.16, 0.38, colour);
      return i;
    }
    case 'hand': {
      // On the clock's upright face (front, +x): 12 o'clock is up, and the hand turns clockwise seen from the front.
      const phi = TWO_PI * unit(item.a, 0);
      const dy = Math.cos(phi);
      const dz = -Math.sin(phi);
      const colour = item.b === 1 ? COL.honey : COL.hand;
      const [hx, hy, hz] = HAND_HUB;
      i = lp(out, i, BATCH.BOX, hx, hy + dy * HAND_LEN * 0.5, hz + dz * HAND_LEN * 0.5, 0.012, HAND_LEN, 0.035, colour, -phi);
      i = lp(out, i, BATCH.BOX, hx, hy - dy * 0.03, hz - dz * 0.03, 0.012, 0.06, 0.05, colour, -phi);
      return i;
    }
    case 'arm': {
      // The iron armature on its bracket at the back, reaching over the coil at the front; pulled, it tilts down onto the
      // pole. A brass contact spring rides its tail, and an NC relay carries a white flag.
      const tilt = ARM_TILT * unit(item.a, 0);
      const c = Math.cos(tilt);
      const s = Math.sin(tilt);
      const [px, py] = ARM_PIVOT;
      i = lp(out, i, BATCH.BOX, px + c * ARM_LEN * 0.5, py - s * ARM_LEN * 0.5, 0, ARM_LEN, 0.04, 0.18, COL.armature, 0, 0, -tilt);
      i = lp(out, i, BATCH.BOX, px - c * 0.06, py + s * 0.06, 0, 0.12, 0.02, 0.08, COL.brass, 0, 0, -tilt);
      if (item.b === 1) i = lp(out, i, BATCH.BOX, px + c * 0.2, py - s * 0.2 + 0.07, 0, 0.02, 0.1, 0.08, COL.flag, 0, 0, -tilt);
      return i;
    }
    case 'plunger': {
      const h = PLUNGER_UP - (PLUNGER_UP - PLUNGER_DOWN) * unit(item.a, 0);
      const hy = PLUNGER_BASE + h + 0.045;
      i = lp(out, i, BATCH.CYL, 0, PLUNGER_BASE + h / 2, 0, 0.06, h, 0.06, COL.steel);
      i = lp(out, i, BATCH.CYL, 0, hy, 0, 0.09, 0.5, 0.09, COL.handle, ALONG_Z);
      for (const side of [-1, 1]) i = lp(out, i, BATCH.BALL, 0, hy, side * 0.26, 0.11, 0.11, 0.11, COL.brass);
      return i;
    }
    case 'hammer': {
      // The trembler: a brass arm from its pivot by the magnets to a ball resting on the bell's flank; ringing, it jitters
      // and yellow "ring" dashes flash round the bell.
      const [px, py] = HAMMER_PIVOT;
      const [bx, by] = HAMMER_BALL;
      const base = Math.atan2(by - py, bx - px);
      const len = Math.hypot(bx - px, by - py);
      const ringing = item.a > 0;
      const ang = base + (ringing ? HAMMER_JITTER * Math.sin(TWO_PI * HAMMER_HZ * time) : 0);
      const ex = px + Math.cos(ang) * len;
      const ey = py + Math.sin(ang) * len;
      i = lbar(out, i, BATCH.BOX, px, py, ex, ey, 0, 0.025, 0.025, COL.brass);
      i = lp(out, i, BATCH.BALL, ex, ey, 0, 0.08, 0.08, 0.08, COL.brass);
      if (ringing && (time * RING_BLINK_HZ) % 1 < 0.6) {
        for (let k = 0; k < 6; k++) {
          const a = k * SIXTH + SIXTH / 2;
          i = lp(out, i, BATCH.LIT_BOX, 0.4 * Math.cos(a), 0.55, 0.4 * Math.sin(a), 0.11, 0.022, 0.022, COL.ring, 0, -a, 0.35);
        }
      }
      return i;
    }
    case 'bulb': {
      // The lit lamp's warm core glowing inside the glass (unlit, so it shines at night; the 'lamp' glow haloes it); a dark
      // lamp shows the clear glass only.
      const a = unit(item.a, 0);
      if (a <= 0) return 0;
      const d = BULB_D * 0.62;
      return lp(out, i, BATCH.LIT, 0, BULB_Y, 0, d, d, d, mixHex(COL.coreDim, COL.coreHot, a));
    }
    case 'glow':
      return glowPose(item, q, y, r, cx, cz, time, out);
    case 'staff':
      return staffPose(item, q, y, r, cx, cz, out);
    default:
      return 0;
  }
}

/** @returns {number} hex a → b by t */
function mixHex(a, b, t) {
  const ch = (s) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * t));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** The glow poses (§4.11's glow row), from the model frame set by overlayPose (turn 0). */
function glowPose(item, q, y, r, cx, cz, t, out) {
  const kind = item.glow;
  const a = unit(item.a, 1);
  let i = 0;
  switch (kind) {
    case 'lamp': {
      if (a <= 0) return 0;
      const s = GLOW.lamp.size + 0.55 * a;
      return lp(out, i, BATCH.GLOW, 0, BULB_Y, 0, s, s, 1, GLOW.lamp.colour, 0, 0, 0, a);
    }
    case 'igniter': {
      if (a <= 0) return 0;
      // The coil glows orange-hot over its dark wire, under a red halo.
      for (let k = 1; k < IGNITER_COIL.length; k++) {
        const [x0, y0] = IGNITER_COIL[k - 1];
        const [x1, y1] = IGNITER_COIL[k];
        i = lbar(out, i, BATCH.LIT_BOX, x0, y0, x1, y1, 0, 0.024, 0.024, mixHex(COL.carbon, COL.coilHot, a));
      }
      return lp(out, i, BATCH.GLOW, 0, IGNITER_Y, 0, GLOW.igniter.size, GLOW.igniter.size, 1, GLOW.igniter.colour, 0, 0, 0,
        a * (0.85 + 0.15 * flicker(t, q, y, r, 11)));
    }
    case 'ember': {
      // The torch's flame: a small flickering tongue on the head (sy > 1.2·sx draws a flame), and a dim halo.
      torchAxis(q, y, r, AX);
      const f = 0.75 + 0.25 * flicker(t, q, y, r, 23);
      const tip = TORCH_LEN + 0.07;
      const x = AX[0] + AX[2] * tip;
      const yy = y + AX[3] * tip;
      const z = AX[1] + AX[4] * tip;
      const s = GLOW.ember.size;
      i = pose(out, i, BATCH.GLOW, x, yy, z, 0, 0, 0, s, s * (1.8 + 0.25 * f), 1, GLOW.ember.colour, a * f);
      i = pose(out, i, BATCH.GLOW, x, yy - 0.02, z, 0, 0, 0, 0.3, 0.3, 1, COL.emberHalo, a * 0.22 * f);
      return i;
    }
    case 'spark':
      if (a <= 0) return 0;
      return lp(out, i, BATCH.GLOW, 0.05, 0.49, -0.1, GLOW.spark.size, GLOW.spark.size, 1, GLOW.spark.colour, 0, 0, 0, a);
    case 'coherer':
      if (a <= 0) return 0;
      return lp(out, i, BATCH.GLOW, 0, 0.43, 0, GLOW.coherer.size, GLOW.coherer.size, 1, GLOW.coherer.colour, 0, 0, 0, a);
    case 'charge': {
      // The pinprick's twinkle on the sphere's crown: irregular (three seeded sines), never quite out; and a faint amber
      // halo behind the sphere (its middle is hidden by the sphere, so it shows as a rim glow round the seam), breathing.
      const tw = flicker(t * 0.6, q, y, r, CHARGE_SEED);
      i = lp(out, i, BATCH.GLOW, 0, 0.735, 0, GLOW.charge.size, GLOW.charge.size, 1, GLOW.charge.colour, 0, 0, 0,
        a * (0.35 + 0.65 * tw * tw));
      return lp(out, i, BATCH.GLOW, 0, 0.4, 0, 0.95, 0.95, 1, PAL.seam, 0, 0, 0, a * (0.14 + 0.06 * tw));
    }
    case 'fuse': {
      const f = 0.8 + 0.2 * flicker(t * 2, q, y, r, 31);
      const s = GLOW.fuse.size;
      if (item.b === FUSE_AT_BUNG || item.b === -2) return pose(out, i, BATCH.GLOW, cx, y + 1.05, cz, 0, 0, 0, s, s, 1, GLOW.fuse.colour, f);
      const n = fusePath(q, y, r, item.b, PATH, LENS);
      alongPath(n, a, AT);
      return pose(out, i, BATCH.GLOW, AT[0], y + FUSE_Y + 0.05, AT[1], 0, 0, 0, s, s, 1, GLOW.fuse.colour, f);
    }
    default:
      return 0;
  }
}

/** The staff poses: the torch, the lamp's filament, the char over a burning fuse. */
function staffPose(item, q, y, r, cx, cz, out) {
  let i = 0;
  switch (item.staff) {
    case 'torch':
    case 'linstock': {
      torchAxis(q, y, r, AX);
      i = torchPiece(out, i, y, 0, 0.1, 0.03, COL.torchIron);
      i = torchPiece(out, i, y, 0.1, 0.72, 0.045, COL.ash);
      i = torchPiece(out, i, y, 0.7, 0.75, 0.06, COL.torchIron);
      i = torchPiece(out, i, y, 0.75, TORCH_LEN, 0.09, COL.pitch);
      i = torchPiece(out, i, y, 0.78, 0.8, 0.095, COL.twine);
      i = torchPiece(out, i, y, 0.88, 0.9, 0.095, COL.twine);
      return i;
    }
    case 'filament': {
      // Two grey supports up from the socket and a carbon loop between them (unlit, so it glows when hot).
      const colour = mixHex(COL.carbon, COL.carbonHot, unit(item.a, 0));
      i = lp(out, i, BATCH.LIT_BOX, -0.05, 0.46, 0, 0.012, 0.24, 0.012, COL.support);
      i = lp(out, i, BATCH.LIT_BOX, 0.05, 0.46, 0, 0.012, 0.24, 0.012, COL.support);
      i = lbar(out, i, BATCH.LIT_BOX, -0.05, 0.58, -0.03, 0.68, 0, 0.016, 0.016, colour);
      i = lbar(out, i, BATCH.LIT_BOX, -0.03, 0.68, 0.03, 0.68, 0, 0.016, 0.016, colour);
      i = lbar(out, i, BATCH.LIT_BOX, 0.03, 0.68, 0.05, 0.58, 0, 0.016, 0.016, colour);
      return i;
    }
    case 'char': {
      const u = unit(item.a, 0);
      if (u <= 0) return 0;
      const cy = y + FUSE_Y + FUSE_W / 2 + 0.005 + 0.005;
      const n = fusePath(q, y, r, item.b, PATH, LENS);
      if (n === 1) {
        const s = CHAR_W + 0.3 * u;
        return pose(out, i, BATCH.BOX, cx, cy, cz, 0, 0, 0, s, 0.01, s, COL.char);
      }
      let left = burnt(n, u);
      for (let k = 0; k < n - 1 && left > 1e-6; k++) {
        const tt = Math.min(1, left / LENS[k]);
        const x1 = PATH[k][0] + (PATH[k + 1][0] - PATH[k][0]) * tt;
        const z1 = PATH[k][1] + (PATH[k + 1][1] - PATH[k][1]) * tt;
        i = flatBar(out, i, PATH[k][0], PATH[k][1], x1, z1, cy, CHAR_W, 0.01, COL.char);
        left -= LENS[k];
      }
      return i;
    }
    default:
      return 0;
  }
}

/** The most poses overlayPose writes for one item of each type (circuitRenderer sizes its meshes from these). */
export const MAX_POSES = Object.freeze({ blade: 3, cap: 2, hand: 2, arm: 3, plunger: 4, hammer: 8, bulb: 1, glow: 5, staff: 6 });

/**
 * The model of device `id` in its own frame (the header), written into `out[0..n-1]` as poses (batch, centre, Euler,
 * scale, colour; alpha 1) and turned by `yaw` about its floor centre, which sits at (x, y, z). For drawing a device that is
 * not in the static geometry: a moving copy of the block (circuitRenderer.syncMoving).
 * @param {number} id
 * @param {Pose[]} out
 * @param {number} [x]
 * @param {number} [y]
 * @param {number} [z]
 * @param {number} [yaw]
 * @returns {number} n, 0 for an id without a model
 */
export function modelPoses(id, out, x = 0, y = 0, z = 0, yaw = 0) {
  if (!hasModel(id)) return 0;
  frame(x, y, z, yaw);
  let i = 0;
  for (const [batch, lx, ly, lz, sx, sy, sz, colour, rx, ry, rz] of MODELS[id].parts) {
    i = lp(out, i, batch, lx, ly, lz, sx, sy, sz, colour, rx, ry, rz);
  }
  return i;
}
