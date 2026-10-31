// hex.js — hexagonal-prism cell geometry: coordinates, face tables and circle/point-vs-hexagon helpers.
import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE } from '../../src/config.js';
import {
  SQRT3, HEX_SIZE, HEX_INRADIUS, HEX_ROW_SPACING, HEX_AREA, SIDE_FACE_COUNT, FACE_TOP, FACE_BOTTOM, FACE_COUNT,
  HEX_DIRS, FACE_OPPOSITE, FACE_NAMES, FACE_NORMALS, HEX_CORNERS, FACE_SHADE, SHADE_KEY_ANGLE, CHUNK_SPACING, CHUNK_RING_INRADIUS,
  hexToWorld, worldToHexFrac, hexRound, worldToHex, hexLength, hexDistance, hexNormSq, hexNeighbor, faceNeighbor,
  hexDiscCount, chunkOrigin, hexSignedDistance, hexContains, hexCircleContact,
} from '../../src/hex.js';

/** Deterministic LCG so the "random" sweeps are reproducible. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Expect a number to be +0 or a plain integer, never -0 (Object.is distinguishes them, as does toEqual). */
function expectCleanInt(v) {
  expect(Number.isInteger(v)).toBe(true);
  expect(Object.is(v, -0)).toBe(false);
}

const hyp = (x, z) => Math.hypot(x, z);

describe('constants', () => {
  it('describe a pointy-top hexagon that is exactly 1 wide across the flats', () => {
    expect(SQRT3).toBeCloseTo(Math.sqrt(3), 15);
    expect(HEX_INRADIUS).toBe(0.5);
    expect(HEX_SIZE).toBeCloseTo(1 / Math.sqrt(3), 15);
    expect(HEX_SIZE * SQRT3 / 2).toBeCloseTo(HEX_INRADIUS, 15); // inradius = circumradius·√3/2
    expect(HEX_ROW_SPACING).toBeCloseTo(Math.sqrt(3) / 2, 15);
    expect(HEX_ROW_SPACING).toBeCloseTo(1.5 * HEX_SIZE, 15); // rows are 1.5 circumradii apart
    expect(HEX_AREA).toBeCloseTo(Math.sqrt(3) / 2, 15);
    expect(HEX_AREA).toBeCloseTo(1 * HEX_ROW_SPACING, 15); // one cell per (1 × row-spacing) of lattice area
  });

  it('face indexing: six sides then top and bottom', () => {
    expect(SIDE_FACE_COUNT).toBe(6);
    expect(FACE_TOP).toBe(6);
    expect(FACE_BOTTOM).toBe(7);
    expect(FACE_COUNT).toBe(8);
    expect(HEX_DIRS).toHaveLength(6);
    expect(FACE_NORMALS).toHaveLength(8);
    expect(FACE_OPPOSITE).toHaveLength(8);
    expect(FACE_NAMES).toHaveLength(8);
    expect(FACE_SHADE).toHaveLength(8);
    expect(HEX_CORNERS).toHaveLength(6);
    expect(new Set(FACE_NAMES).size).toBe(8);
    expect(FACE_NAMES[FACE_TOP]).toBe('top');
    expect(FACE_NAMES[FACE_BOTTOM]).toBe('bottom');
  });

  it('tables are frozen', () => {
    expect(Object.isFrozen(HEX_DIRS)).toBe(true);
    expect(Object.isFrozen(HEX_DIRS[0])).toBe(true);
    expect(Object.isFrozen(FACE_NORMALS)).toBe(true);
    expect(Object.isFrozen(FACE_NORMALS[0])).toBe(true);
    expect(Object.isFrozen(HEX_CORNERS)).toBe(true);
    expect(Object.isFrozen(FACE_OPPOSITE)).toBe(true);
    expect(Object.isFrozen(FACE_SHADE)).toBe(true);
  });

  it('chunk lattice constants', () => {
    expect(CHUNK_SPACING).toBe(CHUNK_SIZE);
    expect(CHUNK_RING_INRADIUS).toBeCloseTo(CHUNK_SIZE * Math.sqrt(3) / 2, 12);
    // Adjacent chunk origins really are CHUNK_SPACING apart in world space, in every direction.
    for (let j = 0; j < 6; j++) {
      const [oq, or] = HEX_DIRS[j];
      const [x, z] = chunkOrigin(oq, or);
      expect(hyp(x, z)).toBeCloseTo(CHUNK_SPACING, 12);
    }
  });
});

describe('HEX_DIRS and FACE_NORMALS', () => {
  it('side normals are unit, 60° apart in order, and equal the world offset of the matching direction', () => {
    for (let j = 0; j < 6; j++) {
      const n = FACE_NORMALS[j];
      expect(n).toHaveLength(3);
      expect(n[1]).toBe(0);
      expect(hyp(n[0], n[2])).toBeCloseTo(1, 15);
      expect(n[0]).toBeCloseTo(Math.cos((Math.PI / 3) * j), 14);
      expect(n[2]).toBeCloseTo(Math.sin((Math.PI / 3) * j), 14);
      const [dq, dr] = HEX_DIRS[j];
      const [wx, wz] = hexToWorld(dq, dr);
      expect(wx).toBeCloseTo(n[0], 15);
      expect(wz).toBeCloseTo(n[2], 15);
      // consecutive normals are 60° apart
      const m = FACE_NORMALS[(j + 1) % 6];
      expect(n[0] * m[0] + n[2] * m[2]).toBeCloseTo(0.5, 15);
    }
    expect(FACE_NORMALS[FACE_TOP]).toEqual([0, 1, 0]);
    expect(FACE_NORMALS[FACE_BOTTOM]).toEqual([0, -1, 0]);
  });

  it('the six directions are distinct, unit hex length, and sum to zero', () => {
    const seen = new Set();
    let sq = 0;
    let sr = 0;
    for (const [dq, dr] of HEX_DIRS) {
      expect(Number.isInteger(dq) && Number.isInteger(dr)).toBe(true);
      expect(hexLength(dq, dr)).toBe(1);
      seen.add(`${dq},${dr}`);
      sq += dq;
      sr += dr;
    }
    expect(seen.size).toBe(6);
    expect(sq).toBe(0);
    expect(sr).toBe(0);
    // specific layout: E, SE, SW, W, NW, NE
    expect(HEX_DIRS[0]).toEqual([1, 0]);
    expect(HEX_DIRS[3]).toEqual([-1, 0]);
    expect(HEX_DIRS[1]).toEqual([0, 1]);
    expect(HEX_DIRS[4]).toEqual([0, -1]);
  });

  it('FACE_OPPOSITE is an involution that negates directions and normals', () => {
    for (let f = 0; f < FACE_COUNT; f++) {
      const o = FACE_OPPOSITE[f];
      expect(o).not.toBe(f);
      expect(FACE_OPPOSITE[o]).toBe(f);
      for (let k = 0; k < 3; k++) expect(FACE_NORMALS[o][k]).toBeCloseTo(-FACE_NORMALS[f][k], 15);
      if (f < 6) {
        expect(o).toBe((f + 3) % 6);
        expect(HEX_DIRS[o][0]).toBe(-HEX_DIRS[f][0] + 0); // + 0: a negated 0 is -0
        expect(HEX_DIRS[o][1]).toBe(-HEX_DIRS[f][1] + 0);
      }
    }
    expect(FACE_OPPOSITE[FACE_TOP]).toBe(FACE_BOTTOM);
    expect(FACE_OPPOSITE[FACE_BOTTOM]).toBe(FACE_TOP);
  });
});

describe('HEX_CORNERS', () => {
  it('corner k is at the circumradius at angle 60°k − 30°', () => {
    for (let k = 0; k < 6; k++) {
      const [cx, cz] = HEX_CORNERS[k];
      expect(hyp(cx, cz)).toBeCloseTo(HEX_SIZE, 15);
      const a = (Math.PI / 3) * k - Math.PI / 6;
      expect(cx).toBeCloseTo(HEX_SIZE * Math.cos(a), 14);
      expect(cz).toBeCloseTo(HEX_SIZE * Math.sin(a), 14);
    }
    // pointy along ±Z: corners 2 and 5 sit on the z axis
    expect(HEX_CORNERS[2][0]).toBe(0);
    expect(HEX_CORNERS[5][0]).toBe(0);
    expect(HEX_CORNERS[2][1]).toBeCloseTo(HEX_SIZE, 15);
    expect(HEX_CORNERS[5][1]).toBeCloseTo(-HEX_SIZE, 15);
    // 1 wide across the flats
    expect(HEX_CORNERS[0][0]).toBe(0.5);
    expect(HEX_CORNERS[3][0]).toBe(-0.5);
  });

  it('side j spans corners j and j+1: edge length HEX_SIZE, midpoint on the face normal at the inradius', () => {
    for (let j = 0; j < 6; j++) {
      const a = HEX_CORNERS[j];
      const b = HEX_CORNERS[(j + 1) % 6];
      expect(hyp(b[0] - a[0], b[1] - a[1])).toBeCloseTo(HEX_SIZE, 15);
      const mx = (a[0] + b[0]) / 2;
      const mz = (a[1] + b[1]) / 2;
      const n = FACE_NORMALS[j];
      expect(mx).toBeCloseTo(n[0] * HEX_INRADIUS, 15);
      expect(mz).toBeCloseTo(n[2] * HEX_INRADIUS, 15);
      // both corners lie on the face plane  (p · n = inradius)
      expect(a[0] * n[0] + a[1] * n[2]).toBeCloseTo(HEX_INRADIUS, 15);
      expect(b[0] * n[0] + b[1] * n[2]).toBeCloseTo(HEX_INRADIUS, 15);
      // and strictly inside every other face plane
      for (let i = 0; i < 6; i++) {
        if (i === j) continue;
        const m = FACE_NORMALS[i];
        const sa = a[0] * m[0] + a[1] * m[2];
        const sb = b[0] * m[0] + b[1] * m[2];
        expect(sa).toBeLessThanOrEqual(HEX_INRADIUS + 1e-15);
        expect(sb).toBeLessThanOrEqual(HEX_INRADIUS + 1e-15);
      }
    }
  });

  it('corners go around with increasing angle (CCW seen from +Y with +Z down the screen)', () => {
    for (let k = 0; k < 6; k++) {
      const a = HEX_CORNERS[k];
      const b = HEX_CORNERS[(k + 1) % 6];
      // 2D cross product a × b > 0 ⇔ b is at a larger angle than a
      expect(a[0] * b[1] - a[1] * b[0]).toBeGreaterThan(0);
    }
  });
});

describe('FACE_SHADE', () => {
  it('is in (0, 1], brightest on top, darkest below, and every side face has its own shade', () => {
    for (const s of FACE_SHADE) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect(FACE_SHADE[FACE_TOP]).toBe(1);
    expect(Math.min(...FACE_SHADE)).toBe(FACE_SHADE[FACE_BOTTOM]);
    for (let j = 0; j < 6; j++) {
      expect(FACE_SHADE[j]).toBeLessThan(FACE_SHADE[FACE_TOP]);
      expect(FACE_SHADE[j]).toBeGreaterThan(FACE_SHADE[FACE_BOTTOM]);
    }
    // Key light at SHADE_KEY_ANGLE (15°, not a face bisector): all six side shades are distinct, so adjacent
    // faces of a prism never read as one flat plane; face 0 (E) is nearest the key and brightest, face 3 (W) darkest.
    const sides = FACE_SHADE.slice(0, SIDE_FACE_COUNT);
    expect(new Set(sides).size).toBe(SIDE_FACE_COUNT);
    for (let j = 0; j < SIDE_FACE_COUNT; j++) {
      expect(sides[j]).not.toBe(sides[(j + 1) % SIDE_FACE_COUNT]);
      const expected = Math.round((0.8 + 0.1 * Math.cos((Math.PI / 3) * j - SHADE_KEY_ANGLE)) * 1000) / 1000;
      expect(sides[j]).toBeCloseTo(expected, 12);
    }
    expect(SHADE_KEY_ANGLE % (Math.PI / 6)).not.toBeCloseTo(0, 12);
    expect(Math.max(...sides)).toBe(sides[0]);
    expect(Math.min(...sides)).toBe(sides[3]);
  });
});

describe('hexToWorld / worldToHexFrac / worldToHex', () => {
  it('lays the lattice out as rows along +X, HEX_ROW_SPACING apart, each shifted half a cell', () => {
    expect(hexToWorld(0, 0)).toEqual([0, 0]);
    expect(hexToWorld(1, 0)).toEqual([1, 0]);
    expect(hexToWorld(-3, 0)).toEqual([-3, 0]);
    const [x1, z1] = hexToWorld(0, 1);
    expect(x1).toBe(0.5);
    expect(z1).toBeCloseTo(HEX_ROW_SPACING, 15);
    const [x2, z2] = hexToWorld(0, -2);
    expect(x2).toBe(-1);
    expect(z2).toBeCloseTo(-2 * HEX_ROW_SPACING, 15);
    const [x3, z3] = hexToWorld(5, 3);
    expect(x3).toBe(6.5);
    expect(z3).toBeCloseTo(3 * HEX_ROW_SPACING, 15);
  });

  it('every pair of neighbouring cells is exactly 1 apart; non-neighbours are further', () => {
    for (let q = -3; q <= 3; q++) {
      for (let r = -3; r <= 3; r++) {
        const [x, z] = hexToWorld(q, r);
        for (let dq = -2; dq <= 2; dq++) {
          for (let dr = -2; dr <= 2; dr++) {
            if (dq === 0 && dr === 0) continue;
            const [x2, z2] = hexToWorld(q + dq, r + dr);
            const d = hyp(x2 - x, z2 - z);
            if (hexLength(dq, dr) === 1) expect(d).toBeCloseTo(1, 12);
            else expect(d).toBeGreaterThan(1.7);
          }
        }
      }
    }
  });

  it('worldToHexFrac inverts hexToWorld exactly on cell centres', () => {
    for (let q = -20; q <= 20; q += 3) {
      for (let r = -20; r <= 20; r += 4) {
        const [x, z] = hexToWorld(q, r);
        const [qf, rf] = worldToHexFrac(x, z);
        expect(qf).toBeCloseTo(q, 12);
        expect(rf).toBeCloseTo(r, 12);
      }
    }
  });

  it('round-trips the centre of every cell in a large window, with clean integers (never -0)', () => {
    for (let q = -40; q <= 40; q++) {
      for (let r = -40; r <= 40; r++) {
        const [x, z] = hexToWorld(q, r);
        const [q2, r2] = worldToHex(x, z);
        expect(q2).toBe(q);
        expect(r2).toBe(r);
        expectCleanInt(q2);
        expectCleanInt(r2);
      }
    }
  });

  it('every point strictly inside a cell (incl. near edges and corners) maps back to that cell', () => {
    const rnd = lcg(0xbeef);
    // Points just inside every corner and every edge midpoint, plus random interior points.
    const probes = [];
    for (let k = 0; k < 6; k++) {
      const c = HEX_CORNERS[k];
      probes.push([c[0] * 0.999, c[1] * 0.999]);
      probes.push([c[0] * 0.9, c[1] * 0.9]);
      const n = FACE_NORMALS[k];
      probes.push([n[0] * HEX_INRADIUS * 0.999, n[2] * HEX_INRADIUS * 0.999]);
      probes.push([n[0] * HEX_INRADIUS * 0.5, n[2] * HEX_INRADIUS * 0.5]);
    }
    for (let i = 0; i < 64; i++) {
      // uniform in the bounding box, kept only when inside the hexagon
      const px = rnd() - 0.5;
      const pz = (rnd() * 2 - 1) * HEX_SIZE;
      if (hexSignedDistance(0, 0, px, pz) < -1e-6) probes.push([px, pz]);
    }
    expect(probes.length).toBeGreaterThan(40);
    for (let q = -9; q <= 9; q += 3) {
      for (let r = -9; r <= 9; r += 3) {
        const [cx, cz] = hexToWorld(q, r);
        for (const [dx, dz] of probes) {
          const got = worldToHex(cx + dx, cz + dz);
          expect(got, `cell ${q},${r} probe ${dx},${dz}`).toEqual([q, r]);
          expectCleanInt(got[0]);
          expectCleanInt(got[1]);
        }
      }
    }
  });

  it('worldToHex picks the nearest centre: the result is always the cell that contains the point', () => {
    const rnd = lcg(42);
    for (let i = 0; i < 2000; i++) {
      const x = (rnd() - 0.5) * 200;
      const z = (rnd() - 0.5) * 200;
      const [q, r] = worldToHex(x, z);
      expectCleanInt(q);
      expectCleanInt(r);
      expect(hexContains(q, r, x, z)).toBe(true);
      // ...and no neighbour is strictly closer
      const [cx, cz] = hexToWorld(q, r);
      const d0 = hyp(x - cx, z - cz);
      for (const [dq, dr] of HEX_DIRS) {
        const [nx, nz] = hexToWorld(q + dq, r + dr);
        expect(hyp(x - nx, z - nz)).toBeGreaterThanOrEqual(d0 - 1e-9);
      }
    }
  });

  it('is continuous across row boundaries (no gaps or overlaps along a line through the lattice)', () => {
    // Walk along z at a fixed x; consecutive cells must always be hex-adjacent or identical.
    let prev = worldToHex(0.3, -10);
    for (let z = -10; z <= 10; z += 0.01) {
      const cur = worldToHex(0.3, z);
      expect(hexDistance(prev[0], prev[1], cur[0], cur[1])).toBeLessThanOrEqual(1);
      prev = cur;
    }
    prev = worldToHex(-10, 0.2);
    for (let x = -10; x <= 10; x += 0.01) {
      const cur = worldToHex(x, 0.2);
      expect(hexDistance(prev[0], prev[1], cur[0], cur[1])).toBeLessThanOrEqual(1);
      prev = cur;
    }
  });
});

describe('hexRound', () => {
  it('returns integers already given, and never -0', () => {
    expect(hexRound(0, 0)).toEqual([0, 0]);
    expect(hexRound(-3, 7)).toEqual([-3, 7]);
    const [q, r] = hexRound(-0.2, 0.1);
    expectCleanInt(q);
    expectCleanInt(r);
    expect(Object.is(hexRound(-0.4, -0.0)[0], -0)).toBe(false);
    expect(Object.is(hexRound(0, -0.4)[1], -0)).toBe(false);
  });

  it('recomputes the component with the largest rounding error (naive per-axis rounding would be wrong)', () => {
    // (0.49, 0.1): per-axis rounding says (0,0), but s = -0.59 rounds to -1 and dq = 0.49 is the largest
    // error, so q = -r - s = 1. In world space the point (0.54, 0.087) is indeed nearer to cell (1,0).
    expect(hexRound(0.49, 0.1)).toEqual([1, 0]);
    // (0.3, 0.49): dr is largest → r = -q - s = 0 - (-1) = 1
    expect(hexRound(0.3, 0.49)).toEqual([0, 1]);
    // (0.3, 0.3): s = -0.6 → -1, ds = 0.4 is the largest → nothing changes (s is implicit) → (0,0)
    expect(hexRound(0.3, 0.3)).toEqual([0, 0]);
    expect(hexRound(-0.49, -0.1)).toEqual([-1, 0]);
  });

  it('agrees with the nearest-centre definition for random fractional inputs', () => {
    const rnd = lcg(7);
    for (let i = 0; i < 2000; i++) {
      const qf = (rnd() - 0.5) * 60;
      const rf = (rnd() - 0.5) * 60;
      const [q, r] = hexRound(qf, rf);
      // Convert to world and verify no neighbour centre is closer.
      const [x, z] = hexToWorld(qf, rf);
      const [cx, cz] = hexToWorld(q, r);
      const d0 = hyp(x - cx, z - cz);
      for (const [dq, dr] of HEX_DIRS) {
        const [nx, nz] = hexToWorld(q + dq, r + dr);
        expect(hyp(x - nx, z - nz)).toBeGreaterThanOrEqual(d0 - 1e-9);
      }
      expect(d0).toBeLessThanOrEqual(HEX_SIZE + 1e-9);
    }
  });

  it('is deterministic on exact ties (points on an edge or a corner)', () => {
    // Midpoint of the edge between (0,0) and (1,0) is world (0.5, 0): a tie between those two cells.
    const [q, r] = worldToHex(0.5, 0);
    expect([q, r]).toSatisfy((v) => (v[0] === 0 && v[1] === 0) || (v[0] === 1 && v[1] === 0));
    // Calling again gives the same answer, and so does the equivalent fractional input.
    expect(worldToHex(0.5, 0)).toEqual([q, r]);
    expect(hexRound(...worldToHexFrac(0.5, 0))).toEqual([q, r]);
    // Corner shared by (0,0), (1,0) and (0,1): world (0.5, HEX_SIZE/2) → one of the three, consistently.
    const corner = worldToHex(0.5, HEX_SIZE / 2);
    expect(hexDistance(0, 0, corner[0], corner[1])).toBeLessThanOrEqual(1);
    expect(hexDistance(1, 0, corner[0], corner[1])).toBeLessThanOrEqual(1);
    expect(hexDistance(0, 1, corner[0], corner[1])).toBeLessThanOrEqual(1);
    expect(worldToHex(0.5, HEX_SIZE / 2)).toEqual(corner);
  });
});

describe('hexLength / hexDistance / hexNormSq', () => {
  it('hexLength is max(|dq|, |dr|, |dq+dr|)', () => {
    expect(hexLength(0, 0)).toBe(0);
    expect(hexLength(1, 0)).toBe(1);
    expect(hexLength(0, -1)).toBe(1);
    expect(hexLength(1, -1)).toBe(1);
    expect(hexLength(1, 1)).toBe(2);
    expect(hexLength(-1, -1)).toBe(2);
    expect(hexLength(2, -1)).toBe(2);
    expect(hexLength(3, -5)).toBe(5);
    expect(hexLength(-4, 7)).toBe(7);
    expect(hexLength(4, 4)).toBe(8);
    for (let dq = -6; dq <= 6; dq++) {
      for (let dr = -6; dr <= 6; dr++) {
        expect(hexLength(dq, dr)).toBe(Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)));
        expect(hexLength(dq, dr)).toBe(hexLength(-dq + 0, -dr + 0)); // + 0: a negated 0 is -0
      }
    }
  });

  it('hexDistance is a metric: symmetric, zero iff equal, triangle inequality', () => {
    const pts = [[0, 0], [3, -1], [-2, 5], [7, 7], [-4, -4], [1, 2]];
    for (const a of pts) {
      for (const b of pts) {
        const d = hexDistance(a[0], a[1], b[0], b[1]);
        expect(d).toBe(hexDistance(b[0], b[1], a[0], a[1]));
        expect(d === 0).toBe(a[0] === b[0] && a[1] === b[1]);
        for (const c of pts) {
          expect(d).toBeLessThanOrEqual(hexDistance(a[0], a[1], c[0], c[1]) + hexDistance(c[0], c[1], b[0], b[1]));
        }
      }
    }
  });

  it('hex distance equals the number of steps along HEX_DIRS needed to connect two cells', () => {
    // BFS on the hex graph from the origin, compared with hexLength.
    const R = 5;
    const dist = new Map([['0,0', 0]]);
    let frontier = [[0, 0]];
    for (let d = 1; d <= R; d++) {
      const next = [];
      for (const [q, r] of frontier) {
        for (const [dq, dr] of HEX_DIRS) {
          const k = `${q + dq},${r + dr}`;
          if (!dist.has(k)) {
            dist.set(k, d);
            next.push([q + dq, r + dr]);
          }
        }
      }
      frontier = next;
    }
    for (const [k, d] of dist) {
      const [q, r] = k.split(',').map(Number);
      expect(hexLength(q, r)).toBe(d);
    }
    expect(dist.size).toBe(hexDiscCount(R));
  });

  it('hexNormSq is the squared world distance between cell centres', () => {
    for (let dq = -5; dq <= 5; dq++) {
      for (let dr = -5; dr <= 5; dr++) {
        const [x, z] = hexToWorld(dq, dr);
        expect(hexNormSq(dq, dr)).toBeCloseTo(x * x + z * z, 10);
      }
    }
    expect(hexNormSq(1, 0)).toBe(1);
    expect(hexNormSq(1, 1)).toBe(3);
    expect(hexNormSq(2, -1)).toBe(3);
  });
});

describe('hexNeighbor / faceNeighbor / hexDiscCount / chunkOrigin', () => {
  it('hexNeighbor applies HEX_DIRS; going there and back returns home', () => {
    for (let j = 0; j < 6; j++) {
      const [q, r] = hexNeighbor(4, -7, j);
      expect([q - 4, r + 7]).toEqual([...HEX_DIRS[j]]);
      expect(hexNeighbor(q, r, FACE_OPPOSITE[j])).toEqual([4, -7]);
      expect(hexDistance(4, -7, q, r)).toBe(1);
    }
  });

  it('faceNeighbor handles sides, top and bottom and is undone by the opposite face', () => {
    for (let f = 0; f < FACE_COUNT; f++) {
      const [q, y, r] = faceNeighbor(2, 10, -3, f);
      if (f === FACE_TOP) expect([q, y, r]).toEqual([2, 11, -3]);
      else if (f === FACE_BOTTOM) expect([q, y, r]).toEqual([2, 9, -3]);
      else {
        expect(y).toBe(10);
        expect([q - 2, r + 3]).toEqual([...HEX_DIRS[f]]);
      }
      expect(faceNeighbor(q, y, r, FACE_OPPOSITE[f])).toEqual([2, 10, -3]);
      // The neighbour's centre is displaced by exactly the face normal.
      const [x0, z0] = hexToWorld(2, -3);
      const [x1, z1] = hexToWorld(q, r);
      expect(x1 - x0).toBeCloseTo(FACE_NORMALS[f][0], 12);
      expect(y - 10).toBe(FACE_NORMALS[f][1]);
      expect(z1 - z0).toBeCloseTo(FACE_NORMALS[f][2], 12);
    }
  });

  it('hexDiscCount is the centred hexagonal number 3n² + 3n + 1 and matches a brute-force count', () => {
    expect(hexDiscCount(0)).toBe(1);
    expect(hexDiscCount(1)).toBe(7);
    expect(hexDiscCount(2)).toBe(19);
    expect(hexDiscCount(3)).toBe(37);
    for (let n = 0; n <= 8; n++) {
      let count = 0;
      for (let dq = -n; dq <= n; dq++) for (let dr = -n; dr <= n; dr++) if (hexLength(dq, dr) <= n) count++;
      expect(hexDiscCount(n)).toBe(count);
    }
  });

  it('chunkOrigin is the centre of local cell (0,0) of the chunk', () => {
    expect(chunkOrigin(0, 0)).toEqual([0, 0]);
    expect(chunkOrigin(1, 0)).toEqual(hexToWorld(CHUNK_SIZE, 0));
    expect(chunkOrigin(-2, 3)).toEqual(hexToWorld(-2 * CHUNK_SIZE, 3 * CHUNK_SIZE));
    const [x, z] = chunkOrigin(0, 1);
    expect(x).toBe(CHUNK_SIZE / 2);
    expect(z).toBeCloseTo(CHUNK_SIZE * HEX_ROW_SPACING, 12);
    // chunk-local cell position + origin == world position of the cell
    for (const [cq, cr, lq, lr] of [[3, -2, 5, 11], [-1, -1, 0, 15], [0, 7, 15, 0]]) {
      const [ox, oz] = chunkOrigin(cq, cr);
      const [lx, lz] = hexToWorld(lq, lr);
      const [wx, wz] = hexToWorld(cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr);
      expect(ox + lx).toBeCloseTo(wx, 10);
      expect(oz + lz).toBeCloseTo(wz, 10);
    }
  });
});

describe('hexSignedDistance / hexContains', () => {
  it('is negative inside (distance to the nearest edge line), zero on the boundary, positive outside', () => {
    expect(hexSignedDistance(0, 0, 0, 0)).toBeCloseTo(-HEX_INRADIUS, 15);
    for (let j = 0; j < 6; j++) {
      const n = FACE_NORMALS[j];
      // halfway to edge j
      expect(hexSignedDistance(0, 0, n[0] * 0.25, n[2] * 0.25)).toBeCloseTo(-0.25, 12);
      // on the edge midpoint
      expect(hexSignedDistance(0, 0, n[0] * HEX_INRADIUS, n[2] * HEX_INRADIUS)).toBeCloseTo(0, 12);
      // beyond the edge midpoint: Euclidean distance to the edge
      expect(hexSignedDistance(0, 0, n[0] * 0.8, n[2] * 0.8)).toBeCloseTo(0.3, 12);
      // on a corner
      const c = HEX_CORNERS[j];
      expect(hexSignedDistance(0, 0, c[0], c[1])).toBeCloseTo(0, 12);
      // beyond a corner, radially: distance to the corner point itself
      expect(hexSignedDistance(0, 0, c[0] * 1.5, c[1] * 1.5)).toBeCloseTo(0.5 * HEX_SIZE, 12);
    }
    // far away
    expect(hexSignedDistance(0, 0, 10, 0)).toBeCloseTo(9.5, 12);
    expect(hexSignedDistance(0, 0, 0, 10)).toBeCloseTo(10 - HEX_SIZE, 12);
  });

  it('translates with the hexagon centre', () => {
    const rnd = lcg(99);
    for (let i = 0; i < 200; i++) {
      const hx = (rnd() - 0.5) * 50;
      const hz = (rnd() - 0.5) * 50;
      const dx = (rnd() - 0.5) * 3;
      const dz = (rnd() - 0.5) * 3;
      expect(hexSignedDistance(hx, hz, hx + dx, hz + dz)).toBeCloseTo(hexSignedDistance(0, 0, dx, dz), 10);
    }
  });

  it('hexContains agrees with worldToHex and includes the boundary', () => {
    expect(hexContains(0, 0, 0, 0)).toBe(true);
    expect(hexContains(0, 0, 0.5, 0)).toBe(true); // on an edge
    expect(hexContains(0, 0, 0, HEX_SIZE)).toBe(true); // on a corner
    expect(hexContains(0, 0, 0.51, 0)).toBe(false);
    expect(hexContains(0, 0, 0, HEX_SIZE + 1e-6)).toBe(false);
    expect(hexContains(3, -2, ...hexToWorld(3, -2))).toBe(true);
    expect(hexContains(3, -2, ...hexToWorld(4, -2))).toBe(false);
    const rnd = lcg(5);
    for (let i = 0; i < 500; i++) {
      const x = (rnd() - 0.5) * 80;
      const z = (rnd() - 0.5) * 80;
      const [q, r] = worldToHex(x, z);
      expect(hexContains(q, r, x, z)).toBe(true);
      // a non-adjacent cell never contains it
      expect(hexContains(q + 2, r, x, z)).toBe(false);
      expect(hexContains(q, r - 2, x, z)).toBe(false);
    }
  });
});

describe('hexCircleContact', () => {
  const out = { depth: 0, nx: 0, nz: 0 };
  const R = 0.3;

  it('a circle touching the boundary exactly does NOT overlap (strict), just inside does', () => {
    // approaching edge 0 (normal +X) from outside: boundary at x = 0.5, circle edge at x - R
    expect(hexCircleContact(0, 0, 0.5 + R, 0, R, out)).toBe(false);
    expect(hexCircleContact(0, 0, 0.5 + R + 1e-9, 0, R, out)).toBe(false);
    expect(hexCircleContact(0, 0, 0.5 + R - 1e-6, 0, R, out)).toBe(true);
    expect(out.depth).toBeCloseTo(1e-6, 9);
    expect(out.nx).toBeCloseTo(1, 12);
    expect(out.nz).toBeCloseTo(0, 12);
    // far away
    expect(hexCircleContact(0, 0, 5, 5, R, out)).toBe(false);
  });

  it('outside near an edge: depth = R − distance, push along the edge normal', () => {
    for (let j = 0; j < 6; j++) {
      const n = FACE_NORMALS[j];
      const d = 0.6; // centre 0.6 from the hex centre along the normal → 0.1 outside the edge
      expect(hexCircleContact(0, 0, n[0] * d, n[2] * d, R, out)).toBe(true);
      expect(out.depth).toBeCloseTo(R - 0.1, 12);
      expect(out.nx).toBeCloseTo(n[0], 12);
      expect(out.nz).toBeCloseTo(n[2], 12);
      expect(hyp(out.nx, out.nz)).toBeCloseTo(1, 12);
    }
  });

  it('outside near a corner: push direction points from the corner to the circle centre', () => {
    for (let k = 0; k < 6; k++) {
      const c = HEX_CORNERS[k];
      const len = hyp(c[0], c[1]);
      const ux = c[0] / len;
      const uz = c[1] / len;
      const px = c[0] + ux * 0.2; // 0.2 beyond the corner, radially
      const pz = c[1] + uz * 0.2;
      expect(hexCircleContact(0, 0, px, pz, R, out)).toBe(true);
      expect(out.depth).toBeCloseTo(R - 0.2, 12);
      expect(out.nx).toBeCloseTo(ux, 10);
      expect(out.nz).toBeCloseTo(uz, 10);
    }
  });

  it('centre inside: always overlaps, depth ≥ R, pushes out through the nearest edge', () => {
    expect(hexCircleContact(0, 0, 0, 0, R, out)).toBe(true);
    expect(out.depth).toBeCloseTo(R + HEX_INRADIUS, 12); // dead centre: inradius to any edge
    expect(hyp(out.nx, out.nz)).toBeCloseTo(1, 12);
    for (let j = 0; j < 6; j++) {
      const n = FACE_NORMALS[j];
      // 0.4 along normal j: nearest edge is j, 0.1 away
      expect(hexCircleContact(0, 0, n[0] * 0.4, n[2] * 0.4, R, out)).toBe(true);
      expect(out.depth).toBeCloseTo(R + 0.1, 12);
      expect(out.nx).toBeCloseTo(n[0], 12);
      expect(out.nz).toBeCloseTo(n[2], 12);
    }
    // Pushing by `depth` along the normal leaves the circle exactly touching (no longer overlapping).
    expect(hexCircleContact(0, 0, 0.2, 0.1, R, out)).toBe(true);
    const px = 0.2 + out.nx * out.depth;
    const pz = 0.1 + out.nz * out.depth;
    expect(hexSignedDistance(0, 0, px, pz)).toBeCloseTo(R, 9);
    expect(hexCircleContact(0, 0, px + out.nx * 1e-9, pz + out.nz * 1e-9, R, out)).toBe(false);
  });

  it('the push always separates the circle: after moving by depth the signed distance equals R', () => {
    const rnd = lcg(2024);
    let overlaps = 0;
    for (let i = 0; i < 3000; i++) {
      const hx = (rnd() - 0.5) * 20;
      const hz = (rnd() - 0.5) * 20;
      const px = hx + (rnd() - 0.5) * 2.2;
      const pz = hz + (rnd() - 0.5) * 2.2;
      const r = 0.05 + rnd() * 0.45;
      const sd = hexSignedDistance(hx, hz, px, pz);
      const hit = hexCircleContact(hx, hz, px, pz, r, out);
      expect(hit).toBe(sd < r - 1e-12);
      if (!hit) continue;
      overlaps++;
      expect(out.depth).toBeGreaterThan(0);
      expect(out.depth).toBeCloseTo(r - sd, 9);
      expect(hyp(out.nx, out.nz)).toBeCloseTo(1, 9);
      const qx = px + out.nx * out.depth;
      const qz = pz + out.nz * out.depth;
      expect(hexSignedDistance(hx, hz, qx, qz)).toBeCloseTo(r, 7);
    }
    expect(overlaps).toBeGreaterThan(500);
  });

  it('works with the hexagon translated anywhere', () => {
    const [hx, hz] = hexToWorld(-17, 23);
    expect(hexCircleContact(hx, hz, hx + 0.6, hz, R, out)).toBe(true);
    expect(out.depth).toBeCloseTo(R - 0.1, 10);
    expect(out.nx).toBeCloseTo(1, 10);
    expect(hexCircleContact(hx, hz, hx + 0.81, hz, R, out)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Regression (review finding): strictness must be decided on the depth itself. A squared-distance test can
// round one ulp below r² while sqrt(d2) rounds back to exactly r, reporting an exactly tangent circle as an
// overlap with depth 0.
describe('hexCircleContact — tangency on every face and corner', () => {
  /** Tangent placements can land an ulp either side of the boundary; the invariant is: true ⇒ depth > 0. */
  function expectTangentConsistent(hit, out, label) {
    if (hit) {
      expect(out.depth, label).toBeGreaterThan(0);
      expect(out.depth, label).toBeLessThan(1e-12);
    }
  }
  it('an exactly tangent circle is never a contact with depth 0; a hair inside is a contact, a hair outside is not', () => {
    const out = { depth: 0, nx: 0, nz: 0 };
    for (const radius of [0.3, 0.28, 0.25, 0.5 / 3]) {
      for (let j = 0; j < SIDE_FACE_COUNT; j++) {
        const n = FACE_NORMALS[j];
        const d = HEX_INRADIUS + radius;
        for (const [hx, hz] of [[0, 0], [7.5, 3 * HEX_ROW_SPACING], [-12, -5 * HEX_ROW_SPACING]]) {
          const label = `face ${j} r ${radius} at ${hx},${hz}`;
          out.depth = NaN;
          expectTangentConsistent(hexCircleContact(hx, hz, hx + n[0] * d, hz + n[2] * d, radius, out), out, label);
          expect(hexCircleContact(hx, hz, hx + n[0] * d * (1 + 1e-9), hz + n[2] * d * (1 + 1e-9), radius, out), label).toBe(false);
          expect(hexCircleContact(hx, hz, hx + n[0] * d * (1 - 1e-9), hz + n[2] * d * (1 - 1e-9), radius, out), label).toBe(true);
          expect(out.depth, label).toBeGreaterThan(0);
        }
      }
      for (let k = 0; k < HEX_CORNERS.length; k++) {
        const [cx, cz] = HEX_CORNERS[k];
        const len = Math.hypot(cx, cz);
        const ux = cx / len;
        const uz = cz / len;
        const label = `corner ${k} r ${radius}`;
        out.depth = NaN;
        expectTangentConsistent(hexCircleContact(0, 0, cx + ux * radius, cz + uz * radius, radius, out), out, label);
        expect(hexCircleContact(0, 0, cx + ux * radius * (1 + 1e-9), cz + uz * radius * (1 + 1e-9), radius, out), label).toBe(false);
        expect(hexCircleContact(0, 0, cx + ux * radius * (1 - 1e-9), cz + uz * radius * (1 - 1e-9), radius, out), label).toBe(true);
        expect(out.depth, label).toBeGreaterThan(0);
      }
    }
    // The exact case from the review: tangent to face SW at distance 0.8 with r = 0.3 used to return true with depth 0.
    out.depth = NaN;
    const n2 = FACE_NORMALS[2];
    const hit = hexCircleContact(0, 0, n2[0] * 0.8, n2[2] * 0.8, 0.3, out);
    expect(hit && out.depth === 0).toBe(false);
  });
});
