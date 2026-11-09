// Caelancraft — where the circuit parts are drawn: the static knob-and-tube wiring, earth cords, powder fuses, binding posts
// and ground clamps (`wireSegments`), and the pose of every moving or lit overlay (`overlayPose`). docs/DESIGN-circuits.md
// §4.5, §4.11, §6.2.7 (CONTRACTS §53 once merged). circuitRenderer.js turns these records into instance matrices.
//
// PURE: no DOM, no three, no time, no Math.random. Everything is a function of its arguments, so a rebuild draws exactly
// what the last one drew (the fuse kinks come from hash3 of the cell).
//
// Positions are world coordinates: a cell (q, y, r) spans [y, y + 1) and its centre is hexToWorld(q, r) (CONTRACTS §0).
// A side face f's midpoint is the centre plus 0.5·FACE_NORMALS[f] (the hex inradius is 0.5).
//
// ---- The static records (wireSegments) --------------------------------------------------------------------------
// seg:  [x0, y0, z0, x1, y1, z1, width, colourIndex] × count — a square-section bar from one end to the other.
// knob: [x, y, z, kind, length] × count — (x, y, z) is the centre of the item's BASE and `length` its height along +y:
//       kind 0 a porcelain knob (a hex spool KNOB_W wide, KNOB_H tall, its groove at WIRE_Y), 1 a porcelain tube (TUBE_W
//       square, a vertical join), 2 a brass binding post (POST_W hex stud, POST_PROUD proud of its face), 3 a copper ground
//       clamp (where an earth-wire cell passes the earth walk).
// Signal wires (copper, brown, white) are knob-and-tube wiring: a knob at every cell centre on the floor, and a wire at the
// groove height from the knob to the midpoint of every side face the cell is joined (§4.5 `joins`) or attached (a source or
// load's live face, or a relay / timer / coherer's input face) through; a join through the top is a porcelain tube up to
// the knob above. There is no terminal dot. Earth wires lie on the floor as green-and-yellow striped cord, with no knobs.
// The Powder Fuse is a round cord with a seeded sideways kink in every half-segment; a cell joined on one side only (or on
// none) carries on across the cell and ends in a frayed grey tuft at its far face, so a fuse is cord from edge to edge.
//
// ---- The overlays (overlayPose) -----------------------------------------------------------------------------------
// circuits.overlays() (package B) lists `{ type, q, y, r, a, b, glow?, staff? }`. §4.11 names the types but not what `a`
// and `b` carry, so this module fixes it (the integrator maps the engine's items onto it if B chose otherwise):
// CONTRACT-ISSUE: §4.11 / §6.2.3 leave the meaning of OverlayItem.a and .b per type open; overlayPose reads them as below.
//   blade    a: how closed the knife switch is, 0 open (the blade raised 65°) … 1 closed (down in the jaws). The renderer
//            eases a change over BLADE_EASE_S, so the engine may send 0/1.
//   cap      a: pressed 0/1 (the cap sinks CAP_TRAVEL); b: 1 for a normally-closed button (a dark cap), else 0.
//   hand     a: the fraction of the delay left, left / s (the hand stands at 2π·a, clockwise from north); b: 1 while the
//            timer is holding (the hand turns honey), else 0.
//   arm      a: pulled 0..1 (the armature tilts ARM_TILT·a toward the coils: energised or pushed by hand); b: 1 for NC
//            contacts (a white flag on top).
//   plunger  a: travel 0..1, 0 cocked (the T-handle at +0.6 above the top) … 1 pushed home (+0.1).
//   hammer   a: ringing 0/1 (the striker jitters ±HAMMER_JITTER at HAMMER_HZ).
//   bulb     a: the lamp's brightness 0..1 (warms the glass a little).
//   glow     per `glow`: 'lamp' a = brightness (size 0.2 + 0.4·a, alpha a); 'igniter' a = heat 0..1; 'ember' (the torch's
//            flame) a = strength 0..1; 'spark' (transmitter) and 'coherer' a = what is left of the flash, 1 → 0; 'charge'
//            a = strength (twinkles by itself); 'fuse' a = the burnt fraction of the cell (the spark rides the burn front)
//            and b = the face the flame came in by (−1 lit in place), or b = FUSE_AT_BUNG for a keg burning in place (the
//            spark sits on its bung). A non-finite `a` reads as 1.
//   staff    per `staff`: 'torch' (the design's 'linstock' is accepted too; a, b unused) the leaning pitch torch, whose
//            flame is the 'ember' glow; 'filament' a = brightness; 'char' a = the burnt fraction and b = the face the flame
//            came in by (−1 lit in place). The entry half of a fuse cell burns over the first half of a, the exit half over
//            the second (§4.3), and the char follows the same kinks as the cord.
// A pose is `{ x, y, z, rx, ry, rz, sx, sy, sz, colour, alpha }`: the centre of a unit shape (a box, a hex prism or, for
// glows, a camera-facing quad sx wide and sy tall — sy > 1.2·sx draws a flame), scaled by (sx, sy, sz) and then rotated by
// the Euler angles (rx, ry, rz) in three's 'YXZ' order; `colour` is 0xRRGGBB and `alpha` 0..1.
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
 * The output buffers of wireSegments (main keeps one and reuses it; the arrays grow by doubling).
 * @typedef {{ seg: { data: Float32Array, count: number }, knob: { data: Float32Array, count: number } }} WireGeometry
 */

/**
 * One overlay pose (see the header).
 * @typedef {{ x: number, y: number, z: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number,
 *   colour: number, alpha: number }} Pose
 */

/** Floats per segment record: x0, y0, z0, x1, y1, z1, width, colourIndex. */
export const SEGMENT_STRIDE = 8;
/** Floats per knob record: x, y, z (the base centre), kind, length. */
export const KNOB_STRIDE = 5;
/** Knob record kinds. */
export const KNOB_KIND = Object.freeze({ KNOB: 0, TUBE: 1, POST: 2, CLAMP: 3 });

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
export const POST_PROUD = 0.01;
/** Binding posts sit this high on a side input face, this far either side of its middle. */
export const POST_Y = 0.55;
export const POST_SPREAD = 0.12;
export const CLAMP_W = 0.12;
export const CLAMP_H = 0.05;

const FUSE_SEED = 0x46757365; // 'Fuse'
const TORCH_SEED = 0x546f7263; // 'Torc'
const CHARGE_SEED = 0x43686172; // 'Char'
const TWO_PI = Math.PI * 2;

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

/** A relay, timer or coherer's two brass binding posts on its input face (a side face, or the top). */
function bindingPosts(view, out, id, q, y, r, wx, wz) {
  const f = inputOf(view, id, q, y, r);
  if (f === FACE_TOP) {
    const by = y + 1 + POST_PROUD - POST_W;
    knob(out, wx - POST_SPREAD, by, wz, KNOB_KIND.POST, POST_W);
    knob(out, wx + POST_SPREAD, by, wz, KNOB_KIND.POST, POST_W);
    return;
  }
  const n = FACE_NORMALS[f];
  // The stud's centre sits POST_W/2 − POST_PROUD inside the face, so POST_PROUD of it stands out.
  const out0 = 0.5 + POST_PROUD - POST_W / 2;
  const px = wx + out0 * n[0];
  const pz = wz + out0 * n[2];
  const by = y + POST_Y - POST_W / 2;
  knob(out, px - n[2] * POST_SPREAD, by, pz + n[0] * POST_SPREAD, KNOB_KIND.POST, POST_W);
  knob(out, px + n[2] * POST_SPREAD, by, pz - n[0] * POST_SPREAD, KNOB_KIND.POST, POST_W);
}

const CELL = [0, 0, 0];
const NEIGH = [0, 0, 0];

/**
 * Build the static wiring within `range` of (x, y, z) (§4.11): segment records for every wire, earth cord and fuse, knob
 * records for knobs, tubes, binding posts and ground clamps. A cell is drawn when its centre is within `range` (default
 * CIRCUIT_DRAW_RANGE) of the point, in the order view.cellsNear lists it.
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
  o.seg.count = 0;
  o.knob.count = 0;
  if (!view) return o;
  const R = Number.isFinite(range) && range >= 0 ? range : CIRCUIT_DRAW_RANGE;
  const cells = view.cellsNear(x, y, z, R);
  for (let i = 0; i < cells.length; i++) {
    unpackCell(cells[i], CELL);
    const q = CELL[0];
    const cy = CELL[1];
    const r = CELL[2];
    const [wx, wz] = hexToWorld(q, r);
    const dx = wx - x;
    const dy = cy + 0.5 - y;
    const dz = wz - z;
    if (dx * dx + dy * dy + dz * dz > R * R) continue;
    const id = view.get(q, cy, r);
    const p = partOf(id);
    if (!p) continue;
    const kind = signalKind(id);
    if (kind) signalWire(view, o, id, q, cy, r, wx, wz, COLOUR[kind.toUpperCase()], NEIGH);
    else if (p.role === 'wire') earthWire(view, o, q, cy, r, wx, wz, NEIGH);
    else if (id === BLOCK.POWDER_FUSE) fuseCell(view, o, q, cy, r, wx, wz, NEIGH);
    else if (p.input) bindingPosts(view, o, id, q, cy, r, wx, wz);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------------------------
// Overlays (§4.11)
// ---------------------------------------------------------------------------------------------------------------

/** The knife-switch blade: open angle, length and section (x × y × z), hinge and jaw positions from the top's centre. */
export const BLADE_OPEN_RAD = (65 * Math.PI) / 180;
export const BLADE_LEN = 0.5;
export const BLADE_EASE_S = 0.12;
/** The hinge sits on the top's west, BLADE_LEN west of the jaws (switch_top's brass cheeks and jaws). */
export const BLADE_HINGE_X = -0.25;
export const BLADE_Y = 0.08;
export const CAP_TRAVEL = 0.05;
export const HAND_LEN = 0.3;
export const ARM_TILT = (12 * Math.PI) / 180;
export const PLUNGER_UP = 0.6;
export const PLUNGER_DOWN = 0.1;
export const HAMMER_JITTER = (10 * Math.PI) / 180;
export const HAMMER_HZ = 15;
export const BULB_ALPHA = 0.35;
/** The torch: its length along the shaft and its lean from the vertical (in a seeded direction). */
export const TORCH_LEN = 0.95;
export const TORCH_LEAN = (12 * Math.PI) / 180;
export const CHAR_W = 0.12;
/** glow 'fuse' with this `b`: a keg burning in place (the spark sits on its bung). */
export const FUSE_AT_BUNG = 8;

/** Glow colours and sizes (§4.11). */
export const GLOW = Object.freeze({
  lamp: Object.freeze({ colour: 0xffd27a, size: 0.2 }),
  igniter: Object.freeze({ colour: 0xff4a1a, size: 0.35 }),
  ember: Object.freeze({ colour: 0xff7a2a, size: 0.1 }),
  spark: Object.freeze({ colour: 0xcfe4ff, size: 0.6 }),
  coherer: Object.freeze({ colour: 0x9fd0ff, size: 0.25 }),
  charge: Object.freeze({ colour: 0xf4f1ea, size: 0.12 }),
  fuse: Object.freeze({ colour: 0xffcf6a, size: 0.22 }),
});

const COL = Object.freeze({
  copper: 0xc8743a, ebonite: 0x2a2622, brass: 0xb08d3a, brassLight: 0xd8b860, ivory: 0xe8e2d0, iron: 0x2e3034,
  ironPlate: 0x4a4d52, honey: 0xe8b04a, steel: 0x5a5e64, handle: 0x6b4a2a, magnet: 0x1e1c1a, glass: 0xf4f0e8,
  glassWarm: 0xfff0c0, carbon: 0x2a2622, carbonHot: 0xffe6a8, ash: 0xc9a46a, torchIron: 0x3a3d42, pitch: 0x2b2420,
  twine: 0xb8a77a, char: 0x5a5650, porcelain: 0xe8e4da, emberHalo: 0xff9a40,
});

/** @returns {Pose} out[i], created when missing */
function slot(out, i) {
  let p = out[i];
  if (!p) {
    p = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, colour: 0xffffff, alpha: 1 };
    out[i] = p;
  }
  return p;
}

/** Write pose i and return i + 1. */
function pose(out, i, x, y, z, rx, ry, rz, sx, sy, sz, colour, alpha = 1) {
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
  return i + 1;
}

/** A floor-plane box from (x0, z0) to (x1, z1) at height y: its pose (centre, ry, length). Returns i + 1. */
function flatBar(out, i, x0, z0, x1, z1, y, w, h, colour, alpha = 1) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  return pose(out, i, (x0 + x1) / 2, y, (z0 + z1) / 2, 0, -Math.atan2(dz, dx), 0, len, h, w, colour, alpha);
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
  return pose(out, i, AX[0] + AX[2] * m, y + AX[3] * m, AX[1] + AX[4] * m, 0, -AX[5], -TORCH_LEAN, w, s1 - s0, w, colour);
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

/**
 * The pose(s) of one overlay item at time `t` (seconds; animations only: the hammer's jitter, the flickers and the
 * charge's twinkle), written into `out[0..n-1]` (pose objects are created on first use and reused). See the header for
 * what each type reads from `a` and `b`. An item of unknown type writes nothing.
 * @param {OverlayItem} item
 * @param {number} t
 * @param {Pose[]} out
 * @returns {number} n, the number of poses written
 */
export function overlayPose(item, t, out) {
  if (!item) return 0;
  const { q, y, r } = item;
  if (!Number.isFinite(q) || !Number.isFinite(y) || !Number.isFinite(r)) return 0;
  const [cx, cz] = hexToWorld(q, r);
  const top = y + 1;
  const time = Number.isFinite(t) ? t : 0;
  let i = 0;
  switch (item.type) {
    case 'blade': {
      const th = BLADE_OPEN_RAD * (1 - unit(item.a, 0));
      const hx = cx + BLADE_HINGE_X;
      const hy = top + BLADE_Y;
      const c = Math.cos(th);
      const s = Math.sin(th);
      // The blade, hinged at its west end; its ebonite handle stands up from the free end.
      i = pose(out, i, hx + c * BLADE_LEN * 0.5, hy + s * BLADE_LEN * 0.5, cz, 0, 0, th, BLADE_LEN, 0.06, 0.08, COL.copper);
      i = pose(out, i, hx + c * (BLADE_LEN - 0.04) - s * 0.07, hy + s * (BLADE_LEN - 0.04) + c * 0.07, cz, 0, 0, th,
        0.05, 0.12, 0.05, COL.ebonite);
      // The fixed brass hinge cheeks and jaws either side of the blade's path.
      for (const side of [-1, 1]) {
        i = pose(out, i, hx, top + 0.05, cz + side * 0.07, 0, 0, 0, 0.08, 0.1, 0.03, COL.brass);
        i = pose(out, i, cx - BLADE_HINGE_X, top + 0.05, cz + side * 0.065, 0, 0, 0, 0.1, 0.1, 0.025, COL.brassLight);
      }
      return i;
    }
    case 'cap': {
      const down = unit(item.a, 0) * CAP_TRAVEL;
      const colour = item.b === 1 ? COL.ebonite : COL.ivory;
      i = pose(out, i, cx, top + 0.05 - down, cz, 0, 0, 0, 0.26, 0.1, 0.26, colour);
      i = pose(out, i, cx, top + 0.115 - down, cz, 0, 0, 0, 0.18, 0.03, 0.18, colour === COL.ivory ? 0xf6f2e6 : 0x3a3632);
      return i;
    }
    case 'hand': {
      const phi = TWO_PI * unit(item.a, 0);
      const dx = Math.sin(phi);
      const dz = -Math.cos(phi);
      const colour = item.b === 1 ? COL.honey : COL.iron;
      i = flatBar(out, i, cx, cz, cx + dx * HAND_LEN, cz + dz * HAND_LEN, top + 0.012, 0.035, 0.012, colour);
      i = flatBar(out, i, cx, cz, cx - dx * 0.08, cz - dz * 0.08, top + 0.012, 0.05, 0.012, colour);
      i = pose(out, i, cx, top + 0.018, cz, 0, 0, 0, 0.07, 0.02, 0.07, COL.brass);
      return i;
    }
    case 'arm': {
      // The armature: a lever pivoted on the east over the contact springs, carrying an iron bar across the two coil
      // poles on the west; pulled (or pushed by hand) the bar drops ARM_TILT onto the poles.
      const tilt = ARM_TILT * unit(item.a, 0);
      const c = Math.cos(tilt);
      const s = Math.sin(tilt);
      const px0 = cx + 0.27;
      const py0 = top + 0.17;
      const len = 0.5;
      i = pose(out, i, px0 - c * len * 0.5, py0 - s * len * 0.5, cz, 0, 0, tilt, len, 0.03, 0.06, COL.ironPlate);
      i = pose(out, i, px0 - c * 0.45, py0 - s * 0.45, cz, 0, 0, tilt, 0.12, 0.04, 0.6, COL.ironPlate);
      for (const side of [-1, 1]) {
        i = pose(out, i, px0, top + 0.085, cz + side * 0.05, 0, 0, 0, 0.05, 0.17, 0.03, COL.brass);
        i = pose(out, i, cx - 0.18, top + 0.03, cz + side * 0.22, 0, 0, 0, 0.16, 0.06, 0.16, COL.copper);
      }
      if (item.b === 1) i = pose(out, i, px0, py0 + 0.08, cz, 0, 0, 0, 0.1, 0.1, 0.02, COL.porcelain);
      return i;
    }
    case 'plunger': {
      const h = PLUNGER_UP - (PLUNGER_UP - PLUNGER_DOWN) * unit(item.a, 0);
      i = pose(out, i, cx, top + h / 2, cz, 0, 0, 0, 0.07, h, 0.07, COL.steel);
      i = pose(out, i, cx, top + h + 0.035, cz, 0, 0, 0, 0.55, 0.07, 0.08, COL.handle);
      for (const side of [-1, 1]) i = pose(out, i, cx + side * 0.28, top + h + 0.035, cz, 0, 0, 0, 0.05, 0.08, 0.09, COL.brass);
      return i;
    }
    case 'hammer': {
      // The trembler on the south-west, its striker reaching for the gong's rim (bell_top's gong sits north-east).
      const pvx = cx - 0.3;
      const pvz = cz + 0.34;
      const gx = cx + 0.087;
      const gz = cz - 0.072;
      const base = Math.atan2(gz - pvz, gx - pvx);
      const j = item.a > 0 ? HAMMER_JITTER * Math.sin(TWO_PI * HAMMER_HZ * time) : 0;
      const ang = base + j;
      const ex = pvx + Math.cos(ang) * 0.24;
      const ez = pvz + Math.sin(ang) * 0.24;
      i = flatBar(out, i, pvx, pvz, ex, ez, top + 0.07, 0.025, 0.025, COL.brass);
      i = pose(out, i, ex, top + 0.07, ez, 0, -ang, 0, 0.06, 0.06, 0.06, COL.brassLight);
      // The electromagnet pair behind the pivot, across the arm.
      const nx = -Math.sin(base);
      const nz = Math.cos(base);
      const bx = pvx - Math.cos(base) * 0.05;
      const bz = pvz - Math.sin(base) * 0.05;
      for (const side of [-1, 1]) {
        i = pose(out, i, bx + nx * side * 0.06, top + 0.07, bz + nz * side * 0.06, 0, -base, 0, 0.08, 0.14, 0.08, COL.magnet);
      }
      return i;
    }
    case 'bulb': {
      const colour = mixHex(COL.glass, COL.glassWarm, unit(item.a, 0));
      i = pose(out, i, cx, top + 0.05, cz, 0, 0, 0, 0.14, 0.1, 0.14, colour, BULB_ALPHA);
      i = pose(out, i, cx, top + 0.25, cz, 0, 0, 0, 0.3, 0.3, 0.3, colour, BULB_ALPHA);
      i = pose(out, i, cx, top + 0.42, cz, 0, 0, 0, 0.04, 0.04, 0.04, colour, BULB_ALPHA);
      return i;
    }
    case 'glow':
      return glowPose(item, q, y, r, cx, cz, top, time, out);
    case 'staff':
      return staffPose(item, q, y, r, cx, cz, top, out);
    default:
      return 0;
  }
}

/** @returns {number} hex a → b by t */
function mixHex(a, b, t) {
  const ch = (s) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * t));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** The glow poses (§4.11's glow row). */
function glowPose(item, q, y, r, cx, cz, top, t, out) {
  const kind = item.glow;
  const a = unit(item.a, 1);
  let i = 0;
  switch (kind) {
    case 'lamp':
      if (a <= 0) return 0;
      return pose(out, i, cx, top + 0.25, cz, 0, 0, 0, GLOW.lamp.size + 0.4 * a, GLOW.lamp.size + 0.4 * a, 1, GLOW.lamp.colour, a);
    case 'igniter':
      if (a <= 0) return 0;
      return pose(out, i, cx, top + 0.03, cz, 0, 0, 0, GLOW.igniter.size, GLOW.igniter.size, 1, GLOW.igniter.colour,
        a * (0.85 + 0.15 * flicker(t, q, y, r, 11)));
    case 'ember': {
      // The torch's flame: a small flickering tongue on the head (sy > 1.2·sx draws a flame), and a dim halo.
      torchAxis(q, y, r, AX);
      const f = 0.75 + 0.25 * flicker(t, q, y, r, 23);
      const tip = TORCH_LEN + 0.07;
      const x = AX[0] + AX[2] * tip;
      const yy = y + AX[3] * tip;
      const z = AX[1] + AX[4] * tip;
      const s = GLOW.ember.size;
      i = pose(out, i, x, yy, z, 0, 0, 0, s, s * (1.8 + 0.25 * f), 1, GLOW.ember.colour, a * f);
      i = pose(out, i, x, yy - 0.02, z, 0, 0, 0, 0.3, 0.3, 1, COL.emberHalo, a * 0.22 * f);
      return i;
    }
    case 'spark':
      if (a <= 0) return 0;
      return pose(out, i, cx, top + 0.06, cz - 0.18, 0, 0, 0, GLOW.spark.size, GLOW.spark.size, 1, GLOW.spark.colour, a);
    case 'coherer':
      if (a <= 0) return 0;
      return pose(out, i, cx, top + 0.04, cz, 0, 0, 0, GLOW.coherer.size, GLOW.coherer.size, 1, GLOW.coherer.colour, a);
    case 'charge': {
      // The pinprick's twinkle: irregular (three seeded sines), never quite out.
      const tw = flicker(t * 0.6, q, y, r, CHARGE_SEED);
      return pose(out, i, cx, top + 0.006, cz, 0, 0, 0, GLOW.charge.size, GLOW.charge.size, 1, GLOW.charge.colour,
        a * (0.35 + 0.65 * tw * tw));
    }
    case 'fuse': {
      const f = 0.8 + 0.2 * flicker(t * 2, q, y, r, 31);
      const s = GLOW.fuse.size;
      if (item.b === FUSE_AT_BUNG) return pose(out, i, cx, top + 0.05, cz, 0, 0, 0, s, s, 1, GLOW.fuse.colour, f);
      const n = fusePath(q, y, r, item.b, PATH, LENS);
      alongPath(n, a, AT);
      return pose(out, i, AT[0], y + FUSE_Y + 0.05, AT[1], 0, 0, 0, s, s, 1, GLOW.fuse.colour, f);
    }
    default:
      return 0;
  }
}

/** The staff poses: the torch, the lamp's filament, the char over a burning fuse. */
function staffPose(item, q, y, r, cx, cz, top, out) {
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
      const colour = mixHex(COL.carbon, COL.carbonHot, unit(item.a, 0));
      i = pose(out, i, cx - 0.03, top + 0.25, cz, 0, 0, 0, 0.012, 0.14, 0.012, colour);
      i = pose(out, i, cx + 0.03, top + 0.25, cz, 0, 0, 0, 0.012, 0.14, 0.012, colour);
      i = pose(out, i, cx, top + 0.32, cz, 0, 0, 0, 0.072, 0.012, 0.012, colour);
      return i;
    }
    case 'char': {
      const u = unit(item.a, 0);
      if (u <= 0) return 0;
      const cy = y + FUSE_Y + FUSE_W / 2 + 0.005 + 0.005;
      const n = fusePath(q, y, r, item.b, PATH, LENS);
      if (n === 1) {
        const s = CHAR_W + 0.3 * u;
        return pose(out, i, cx, cy, cz, 0, 0, 0, s, 0.01, s, COL.char);
      }
      let left = burnt(n, u);
      for (let k = 0; k < n - 1 && left > 1e-6; k++) {
        const t = Math.min(1, left / LENS[k]);
        const x1 = PATH[k][0] + (PATH[k + 1][0] - PATH[k][0]) * t;
        const z1 = PATH[k][1] + (PATH[k + 1][1] - PATH[k][1]) * t;
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
export const MAX_POSES = Object.freeze({ blade: 6, cap: 2, hand: 3, arm: 7, plunger: 4, hammer: 4, bulb: 3, glow: 2, staff: 6 });
