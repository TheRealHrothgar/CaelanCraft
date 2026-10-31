// Caelancraft — hexagonal-prism cell geometry. See src/CONTRACTS.md §0 and §4a. Pure.
//
// The world is a honeycomb: every cell is a vertical hexagonal prism (pointy-top in the XZ plane, i.e.
// corners point along ±Z) of height 1 and width 1 across the flats. Cells are addressed with axial
// coordinates (q, r) plus the integer height y. The hex lattice is regular in world space:
//
//   centre(q, r) = (x, z) = (q + r/2, r·√3/2)
//
// so rows (fixed r) run along +X one unit apart and consecutive rows are √3/2 apart in Z, each shifted by
// half a cell. The six side faces are numbered 0..5 counter-clockwise (seen from +Y with +X right and +Z
// down), face j having outward normal (cos 60°j, sin 60°j) in (x, z); face 6 is the top (+Y) and face 7 the
// bottom (−Y). Side face j spans corners j and j+1, where corner k sits at angle 60°k − 30°.
import { CHUNK_SIZE } from './config.js';

export const SQRT3 = Math.sqrt(3);
/** Circumradius: centre → corner. Chosen so the cell is exactly 1 wide across the flats. */
export const HEX_SIZE = 1 / SQRT3;
/** Inradius: centre → edge midpoint. */
export const HEX_INRADIUS = 0.5;
/** World-Z distance between consecutive rows (r and r + 1). */
export const HEX_ROW_SPACING = SQRT3 / 2;
/** Footprint area of one cell (√3/2 ≈ 0.866). */
export const HEX_AREA = (3 * SQRT3) / 2 * HEX_SIZE * HEX_SIZE;

export const SIDE_FACE_COUNT = 6;
export const FACE_TOP = 6;
export const FACE_BOTTOM = 7;
export const FACE_COUNT = 8;

/** Axial offsets of the six side neighbours, index = side face. */
export const HEX_DIRS = Object.freeze([
  Object.freeze([1, 0]),
  Object.freeze([0, 1]),
  Object.freeze([-1, 1]),
  Object.freeze([-1, 0]),
  Object.freeze([0, -1]),
  Object.freeze([1, -1]),
]);

/** Face on the far side: side faces rotate by 3, top ↔ bottom. */
export const FACE_OPPOSITE = Object.freeze([3, 4, 5, 0, 1, 2, 7, 6]);

/** Human-readable face names, index = face. */
export const FACE_NAMES = Object.freeze(['E', 'SE', 'SW', 'W', 'NW', 'NE', 'top', 'bottom']);

/**
 * Outward unit normal of every face as [nx, ny, nz]. Side normals are exact (cos/sin of multiples of 60°),
 * which also makes them equal to the world offset of the corresponding HEX_DIRS entry.
 * @type {readonly (readonly number[])[]}
 */
export const FACE_NORMALS = Object.freeze([
  Object.freeze([1, 0, 0]),
  Object.freeze([0.5, 0, HEX_ROW_SPACING]),
  Object.freeze([-0.5, 0, HEX_ROW_SPACING]),
  Object.freeze([-1, 0, 0]),
  Object.freeze([-0.5, 0, -HEX_ROW_SPACING]),
  Object.freeze([0.5, 0, -HEX_ROW_SPACING]),
  Object.freeze([0, 1, 0]),
  Object.freeze([0, -1, 0]),
]);

/**
 * Corner offsets from the cell centre as [dx, dz]; corner k is at angle 60°k − 30°.
 * @type {readonly (readonly number[])[]}
 */
export const HEX_CORNERS = Object.freeze([
  Object.freeze([0.5, -HEX_SIZE / 2]),
  Object.freeze([0.5, HEX_SIZE / 2]),
  Object.freeze([0, HEX_SIZE]),
  Object.freeze([-0.5, HEX_SIZE / 2]),
  Object.freeze([-0.5, -HEX_SIZE / 2]),
  Object.freeze([0, -HEX_SIZE]),
]);

/** Angle of the fixed key light for FACE_SHADE: 15°, deliberately NOT a multiple of 30° so no two side faces share a shade. */
export const SHADE_KEY_ANGLE = Math.PI / 12;

/**
 * Per-face shade multiplier applied on top of the lights (index = face). Side shades come from a fixed key
 * light at SHADE_KEY_ANGLE (0.8 + 0.1·(n · key), rounded to 3 dp) so all six sides read as distinct planes
 * — a key on a face bisector would give adjacent faces identical shades; top is brightest, bottom darkest.
 */
export const FACE_SHADE = Object.freeze(
  FACE_NORMALS.map((n, f) => {
    if (f === FACE_TOP) return 1.0;
    if (f === FACE_BOTTOM) return 0.55;
    const kx = Math.cos(SHADE_KEY_ANGLE);
    const kz = Math.sin(SHADE_KEY_ANGLE);
    return Math.round((0.8 + 0.1 * (n[0] * kx + n[2] * kz)) * 1000) / 1000;
  }),
);

/** World distance between the centres of adjacent chunks (the chunk lattice is itself hexagonal). */
export const CHUNK_SPACING = CHUNK_SIZE;
/** Inradius of the hexagon formed by the chunks at chunk-hex-distance 1 (per ring): 16·√3/2. */
export const CHUNK_RING_INRADIUS = CHUNK_SIZE * HEX_ROW_SPACING;

// ---------------------------------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------------------------------

/** @returns {[number, number]} world [x, z] of the centre of cell (q, r) */
export function hexToWorld(q, r) {
  return [q + r * 0.5, r * HEX_ROW_SPACING];
}

/** @returns {[number, number]} fractional axial [qf, rf] of world point (x, z) */
export function worldToHexFrac(x, z) {
  const rf = z / HEX_ROW_SPACING;
  return [x - rf * 0.5, rf];
}

/**
 * Round fractional axial coordinates to the containing cell (cube rounding: the component with the
 * largest rounding error is recomputed from the other two). Results are never −0.
 * @returns {[number, number]}
 */
export function hexRound(qf, rf) {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return [q + 0, r + 0];
}

/** @returns {[number, number]} integer axial [q, r] of the cell containing world point (x, z) */
export function worldToHex(x, z) {
  const rf = z / HEX_ROW_SPACING;
  return hexRound(x - rf * 0.5, rf);
}

/** Hex (Manhattan-on-cube) distance of an axial offset. */
export function hexLength(dq, dr) {
  const a = dq < 0 ? -dq : dq;
  const b = dr < 0 ? -dr : dr;
  const c = dq + dr < 0 ? -(dq + dr) : dq + dr;
  return a > b ? (a > c ? a : c) : b > c ? b : c;
}

/** Hex distance between two cells. */
export function hexDistance(q1, r1, q2, r2) {
  return hexLength(q1 - q2, r1 - r2);
}

/** Squared world distance between the centres of cells (0,0) and (dq, dr): dq² + dq·dr + dr². */
export function hexNormSq(dq, dr) {
  return dq * dq + dq * dr + dr * dr;
}

/** @returns {[number, number]} the neighbour across side face j (0..5) */
export function hexNeighbor(q, r, j) {
  const d = HEX_DIRS[j];
  return [q + d[0], r + d[1]];
}

/**
 * Cell on the far side of `face` (0..7) of cell (q, y, r).
 * @returns {[number, number, number]} [q, y, r]
 */
export function faceNeighbor(q, y, r, face) {
  if (face === FACE_TOP) return [q, y + 1, r];
  if (face === FACE_BOTTOM) return [q, y - 1, r];
  const d = HEX_DIRS[face];
  return [q + d[0], y, r + d[1]];
}

/**
 * Number of cells within hex distance `radius` of a cell (1, 7, 19, 37, ...).
 */
export function hexDiscCount(radius) {
  return 3 * radius * radius + 3 * radius + 1;
}

/**
 * World [x, z] of the centre of local cell (0, 0) of chunk (cq, cr): the mesh / position origin of a chunk.
 * @returns {[number, number]}
 */
export function chunkOrigin(cq, cr) {
  return hexToWorld(cq * CHUNK_SIZE, cr * CHUNK_SIZE);
}

// ---------------------------------------------------------------------------------------------------
// Point / circle vs hexagon
// ---------------------------------------------------------------------------------------------------

const EDGE_LEN_SQ = HEX_SIZE * HEX_SIZE;

/**
 * @typedef {Object} HexContact
 * @property {number} depth  how far a circle of the given radius penetrates the hexagon (> 0 when overlapping)
 * @property {number} nx     unit push direction (from the hexagon toward the circle centre)
 * @property {number} nz
 */

/**
 * Signed distance from world point (px, pz) to the hexagon centred at (hx, hz): negative inside (distance to
 * the nearest edge line), zero on the boundary, positive outside (distance to the nearest edge segment).
 */
export function hexSignedDistance(hx, hz, px, pz) {
  const dx = px - hx;
  const dz = pz - hz;
  let maxS = -Infinity;
  for (let j = 0; j < SIDE_FACE_COUNT; j++) {
    const n = FACE_NORMALS[j];
    const s = dx * n[0] + dz * n[2] - HEX_INRADIUS;
    if (s > maxS) maxS = s;
  }
  if (maxS <= 0) return maxS;
  return Math.sqrt(closestBoundaryDistSq(dx, dz, null));
}

/**
 * Squared distance from (dx, dz) (relative to the hexagon centre) to the nearest point of the hexagon's
 * boundary; when `out` is given, also writes that point to out.x / out.z.
 */
function closestBoundaryDistSq(dx, dz, out) {
  let best = Infinity;
  let bx = 0;
  let bz = 0;
  for (let j = 0; j < SIDE_FACE_COUNT; j++) {
    const a = HEX_CORNERS[j];
    const b = HEX_CORNERS[j === 5 ? 0 : j + 1];
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    let t = ((dx - a[0]) * ex + (dz - a[1]) * ez) / EDGE_LEN_SQ;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const qx = a[0] + ex * t;
    const qz = a[1] + ez * t;
    const ddx = dx - qx;
    const ddz = dz - qz;
    const d2 = ddx * ddx + ddz * ddz;
    if (d2 < best) {
      best = d2;
      bx = qx;
      bz = qz;
    }
  }
  if (out) {
    out.x = bx;
    out.z = bz;
  }
  return best;
}

/** @returns {boolean} world point (px, pz) lies inside or on the boundary of cell (q, r) */
export function hexContains(q, r, px, pz) {
  const [hx, hz] = hexToWorld(q, r);
  return hexSignedDistance(hx, hz, px, pz) <= 1e-9;
}

/** scratch for hexCircleContact */
const scratchPoint = { x: 0, z: 0 };

/**
 * Test a circle (centre (px, pz), `radius`) against the hexagon centred at (hx, hz). Overlap is STRICT:
 * a circle merely touching the boundary does not count. On overlap `out.depth` (> 0) and the unit push
 * direction `out.nx/out.nz` (pointing from the hexagon toward the circle) are written.
 * @param {HexContact} out
 * @returns {boolean} true when the circle overlaps the hexagon
 */
export function hexCircleContact(hx, hz, px, pz, radius, out) {
  const dx = px - hx;
  const dz = pz - hz;
  let maxS = -Infinity;
  let jMax = 0;
  for (let j = 0; j < SIDE_FACE_COUNT; j++) {
    const n = FACE_NORMALS[j];
    const s = dx * n[0] + dz * n[2] - HEX_INRADIUS;
    if (s > maxS) {
      maxS = s;
      jMax = j;
    }
  }
  if (maxS <= 0) {
    // Centre inside: push out through the nearest edge.
    out.depth = radius - maxS;
    out.nx = FACE_NORMALS[jMax][0];
    out.nz = FACE_NORMALS[jMax][2];
    return true;
  }
  // Decide strictness on the depth itself so `true` always comes with depth > 0 (a squared-distance test can
  // round one ulp below r² while sqrt rounds back to exactly r for an exactly tangent circle).
  const d2 = closestBoundaryDistSq(dx, dz, scratchPoint);
  const dist = Math.sqrt(d2);
  const depth = radius - dist;
  if (depth <= 0) return false;
  if (dist > 1e-9) {
    out.nx = (dx - scratchPoint.x) / dist;
    out.nz = (dz - scratchPoint.z) / dist;
  } else {
    out.nx = FACE_NORMALS[jMax][0];
    out.nz = FACE_NORMALS[jMax][2];
  }
  out.depth = depth;
  return true;
}
