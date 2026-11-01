// Unit tests for src/raycast.js — ray casting through the honeycomb of hexagonal prisms (CONTRACTS §11).
import { describe, it, expect } from 'vitest';
import { WORLD_HEIGHT } from '../../src/config.js';
import {
  HEX_DIRS, HEX_CORNERS, HEX_INRADIUS, HEX_SIZE, FACE_NORMALS, FACE_OPPOSITE, FACE_TOP, FACE_BOTTOM, SIDE_FACE_COUNT,
  hexToWorld, worldToHex, hexDistance, hexLength, hexNeighbor, hexSignedDistance,
} from '../../src/hex.js';
import { BLOCK, isTargetable } from '../../src/blocks.js';
import { makeGetBlock, flatGetBlock } from '../helpers/fixtures.js';
import { raycastHex, UNBOUNDED_ITERATION_CAP } from '../../src/raycast.js';

const EPS = 1e-9;
const FLOOR = 5; // flatGetBlock(5): solid for y <= 5, top face at y = 6

/** getBlock over a Set of "q,y,r" strings (STONE), AIR elsewhere. */
function sceneOf(cells, id = BLOCK.STONE) {
  const map = new Map();
  for (const c of cells) map.set(c, id);
  return makeGetBlock(map);
}

/** Wrap a getBlock so every queried cell is recorded in order. */
function recording(getBlock) {
  const cells = [];
  const fn = (q, y, r) => {
    cells.push([q, y, r]);
    return getBlock(q, y, r);
  };
  return { fn, cells };
}

/** Deterministic PRNG for property tests. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Yaw/pitch-free unit vector from spherical angles. */
function dirFrom(theta, phi) {
  return [Math.cos(phi) * Math.cos(theta), Math.sin(phi), Math.cos(phi) * Math.sin(theta)];
}

function expectNoNegativeZero(hit) {
  for (const k of ['distance', 'nx', 'ny', 'nz']) {
    expect(Object.is(hit[k], -0), `${k} is -0`).toBe(false);
  }
}

describe('argument handling', () => {
  const floor = flatGetBlock(FLOOR);

  it('returns null for a zero or non-finite direction / origin', () => {
    expect(raycastHex(floor, 0, 10, 0, 0, 0, 0, 20)).toBeNull();
    expect(raycastHex(floor, 0, 10, 0, NaN, -1, 0, 20)).toBeNull();
    expect(raycastHex(floor, 0, 10, 0, 0, -Infinity, 0, 20)).toBeNull();
    expect(raycastHex(floor, NaN, 10, 0, 0, -1, 0, 20)).toBeNull();
    expect(raycastHex(floor, 0, Infinity, 0, 0, -1, 0, 20)).toBeNull();
  });

  it('reports face -1, zero normal and distance 0 when the origin is already inside a targetable cell', () => {
    const [x, z] = hexToWorld(3, -2);
    const hit = raycastHex(floor, x + 0.1, 2.5, z - 0.1, 0, 1, 0, 20);
    expect(hit).toEqual({ q: 3, y: 2, r: -2, face: -1, nx: 0, ny: 0, nz: 0, distance: 0, blockId: BLOCK.STONE });
    expectNoNegativeZero(hit);
  });

  it('normalises the direction: d and 3d give identical hits', () => {
    const a = raycastHex(floor, 0.2, 9.3, 0.1, 0.3, -1, 0.2, 20);
    const b = raycastHex(floor, 0.2, 9.3, 0.1, 0.9, -3, 0.6, 20);
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
  });

  it('hits exactly at maxDistance (inclusive) and misses just beyond it', () => {
    const [x, z] = hexToWorld(0, 0);
    const d = 10.5 - (FLOOR + 1); // 4.5
    expect(raycastHex(floor, x, 10.5, z, 0, -1, 0, d)).not.toBeNull();
    expect(raycastHex(floor, x, 10.5, z, 0, -1, 0, d - 1e-6)).toBeNull();
    expect(raycastHex(floor, x, 10.5, z, 0, -1, 0, 0)).toBeNull();
  });

  it('water is not targetable by default; a custom isHit can target it', () => {
    const water = flatGetBlock(FLOOR, BLOCK.WATER);
    expect(raycastHex(water, 0, 10.5, 0, 0, -1, 0, 20)).toBeNull();
    const hit = raycastHex(water, 0, 10.5, 0, 0, -1, 0, 20, (id) => id === BLOCK.WATER);
    expect(hit).not.toBeNull();
    expect(hit.blockId).toBe(BLOCK.WATER);
    expect(hit.y).toBe(FLOOR);
    expect(hit.face).toBe(FACE_TOP);
    // and the default predicate is exactly isTargetable
    expect(raycastHex(water, 0, 10.5, 0, 0, -1, 0, 20, isTargetable)).toBeNull();
  });
});

describe('vertical rays', () => {
  const floor = flatGetBlock(FLOOR);

  it('straight down from a cell centre hits the floor top face at exactly the right distance', () => {
    for (const [q, r] of [[0, 0], [5, -3], [-7, 2], [-13, -9], [40, 17]]) {
      const [x, z] = hexToWorld(q, r);
      const hit = raycastHex(floor, x, 10.5, z, 0, -1, 0, 20);
      expect(hit).not.toBeNull();
      expect([hit.q, hit.y, hit.r]).toEqual([q, FLOOR, r]);
      expect(hit.face).toBe(FACE_TOP);
      expect([hit.nx, hit.ny, hit.nz]).toEqual([0, 1, 0]);
      expect(Math.abs(hit.distance - 4.5)).toBeLessThan(EPS);
      expect(hit.blockId).toBe(BLOCK.STONE);
      expectNoNegativeZero(hit);
    }
  });

  it('straight down from an off-centre point still hits the cell that contains the point', () => {
    const [x, z] = hexToWorld(2, 1);
    const hit = raycastHex(floor, x + 0.45, 7.25, z - 0.2, 0, -1, 0, 20);
    expect([hit.q, hit.y, hit.r]).toEqual([2, FLOOR, 1]);
    expect(Math.abs(hit.distance - 1.25)).toBeLessThan(EPS);
  });

  it('straight up hits a ceiling cell on its bottom face', () => {
    const ceiling = sceneOf(['0,8,0', '-4,8,6']);
    for (const [q, r] of [[0, 0], [-4, 6]]) {
      const [x, z] = hexToWorld(q, r);
      const hit = raycastHex(ceiling, x, 3.5, z, 0, 1, 0, 20);
      expect([hit.q, hit.y, hit.r]).toEqual([q, 8, r]);
      expect(hit.face).toBe(FACE_BOTTOM);
      expect([hit.nx, hit.ny, hit.nz]).toEqual([0, -1, 0]);
      expect(Math.abs(hit.distance - 4.5)).toBeLessThan(EPS);
      expectNoNegativeZero(hit);
    }
  });

  it('an oblique ray onto the floor lands on a top face at the plane y = FLOOR + 1', () => {
    const o = [0.1, 9.7, -0.2];
    const d = [0.3, -1, 0.2];
    const hit = raycastHex(floor, o[0], o[1], o[2], d[0], d[1], d[2], 30);
    expect(hit).not.toBeNull();
    expect(hit.face).toBe(FACE_TOP);
    expect(hit.y).toBe(FLOOR);
    const len = Math.hypot(d[0], d[1], d[2]);
    const py = o[1] + (d[1] / len) * hit.distance;
    expect(Math.abs(py - (FLOOR + 1))).toBeLessThan(1e-9);
    const px = o[0] + (d[0] / len) * hit.distance;
    const pz = o[2] + (d[2] / len) * hit.distance;
    const [hx, hz] = hexToWorld(hit.q, hit.r);
    expect(hexSignedDistance(hx, hz, px, pz)).toBeLessThanOrEqual(1e-9);
  });
});

describe('horizontal rays', () => {
  it('along each side normal from a cell centre hits the neighbour at distance 1 - HEX_INRADIUS through the opposite face', () => {
    for (let j = 0; j < SIDE_FACE_COUNT; j++) {
      const [nq, nr] = hexNeighbor(0, 0, j);
      const get = sceneOf([`${nq},5,${nr}`]);
      const n = FACE_NORMALS[j];
      const hit = raycastHex(get, 0, 5.5, 0, n[0], 0, n[2], 10);
      expect(hit, `direction ${j}`).not.toBeNull();
      expect([hit.q, hit.y, hit.r]).toEqual([nq, 5, nr]);
      expect(hit.face).toBe(FACE_OPPOSITE[j]);
      const en = FACE_NORMALS[hit.face];
      expect(hit.nx).toBeCloseTo(en[0], 12);
      expect(hit.ny).toBe(0);
      expect(hit.nz).toBeCloseTo(en[2], 12);
      expect(Math.abs(hit.distance - (1 - HEX_INRADIUS))).toBeLessThan(EPS);
      expectNoNegativeZero(hit);
    }
  });

  it('the n-th cell along a side direction is hit at distance n - HEX_INRADIUS', () => {
    for (let j = 0; j < SIDE_FACE_COUNT; j++) {
      for (const n of [2, 3, 7]) {
        const q = HEX_DIRS[j][0] * n;
        const r = HEX_DIRS[j][1] * n;
        const get = sceneOf([`${q},5,${r}`]);
        const d = FACE_NORMALS[j];
        const hit = raycastHex(get, 0, 5.5, 0, d[0], 0, d[2], 20);
        expect(hit, `direction ${j}, n ${n}`).not.toBeNull();
        expect([hit.q, hit.y, hit.r]).toEqual([q, 5, r]);
        expect(Math.abs(hit.distance - (n - HEX_INRADIUS))).toBeLessThan(1e-9);
        expect(hit.face).toBe(FACE_OPPOSITE[j]);
      }
    }
  });

  it('works from negative coordinates and from an off-centre origin', () => {
    const [x, z] = hexToWorld(-7, -9);
    const [nq, nr] = hexNeighbor(-7, -9, 3); // west
    const get = sceneOf([`${nq},3,${nr}`]);
    const hit = raycastHex(get, x + 0.1, 3.2, z + 0.05, -1, 0, 0, 10);
    expect([hit.q, hit.y, hit.r]).toEqual([nq, 3, nr]);
    expect(hit.face).toBe(0); // entered through the neighbour's east face
    expect(Math.abs(hit.distance - (1 - HEX_INRADIUS + 0.1))).toBeLessThan(EPS);
  });

  it('an origin exactly on a face plane heading out through it hits the neighbour at distance +0', () => {
    const get = sceneOf(['1,5,0']);
    const hit = raycastHex(get, HEX_INRADIUS, 5.5, 0, 1, 0, 0, 10);
    expect([hit.q, hit.y, hit.r]).toEqual([1, 5, 0]);
    expect(hit.distance).toBe(0);
    expectNoNegativeZero(hit);
  });
});

describe('traversal', () => {
  it('rays aimed exactly through a corner (and along shared edges) only ever step to adjacent cells', () => {
    // Everything at hex distance >= 4 from the origin is solid, so every ray eventually hits ring 4.
    const get = (q, y, r) => (y >= 0 && y < WORLD_HEIGHT && hexLength(q, r) >= 4 ? BLOCK.STONE : BLOCK.AIR);
    for (let k = 0; k < 6; k++) {
      const c = HEX_CORNERS[k];
      const len = Math.hypot(c[0], c[1]);
      const rec = recording(get);
      const hit = raycastHex(rec.fn, 0, 5.5, 0, c[0] / len, 0, c[1] / len, 20);
      expect(hit, `corner ${k}`).not.toBeNull();
      expect(hexLength(hit.q, hit.r)).toBe(4);
      expect(hit.y).toBe(5);
      expect(rec.cells.length).toBeGreaterThan(4);
      for (let i = 1; i < rec.cells.length; i++) {
        const [q0, y0, r0] = rec.cells[i - 1];
        const [q1, y1, r1] = rec.cells[i];
        const horizontal = y0 === y1 && hexDistance(q0, r0, q1, r1) === 1;
        const vertical = q0 === q1 && r0 === r1 && Math.abs(y0 - y1) === 1;
        expect(horizontal || vertical, `step ${i}: ${rec.cells[i - 1]} -> ${rec.cells[i]}`).toBe(true);
      }
      // Along a corner direction the ray runs over vertices every HEX_SIZE; the first ring-4 cell is met at
      // its vertex, the fifth one out (e.g. (4,-2) for corner 0), i.e. at exactly 5 · HEX_SIZE.
      expect(hit.distance).toBeCloseTo(5 * HEX_SIZE, 6);
    }
  });

  it('visits every cell a ray passes through (sampled) and never skips one', () => {
    const rng = mulberry32(0xbeef);
    const air = () => BLOCK.AIR;
    for (let trial = 0; trial < 60; trial++) {
      const o = [rng() * 10 - 5, 20 + rng() * 10, rng() * 10 - 5];
      const d = dirFrom(rng() * Math.PI * 2, (rng() - 0.5) * Math.PI * 0.9);
      const rec = recording(air);
      expect(raycastHex(rec.fn, o[0], o[1], o[2], d[0], d[1], d[2], 12)).toBeNull();
      const visited = new Set(rec.cells.map((c) => c.join(',')));
      for (let t = 0; t <= 12; t += 0.0137) {
        const [q, r] = worldToHex(o[0] + d[0] * t, o[2] + d[2] * t);
        const y = Math.floor(o[1] + d[1] * t);
        expect(visited.has(`${q},${y},${r}`), `trial ${trial} t=${t.toFixed(3)} cell ${q},${y},${r}`).toBe(true);
      }
      for (let i = 1; i < rec.cells.length; i++) {
        const [q0, y0, r0] = rec.cells[i - 1];
        const [q1, y1, r1] = rec.cells[i];
        const ok = (y0 === y1 && hexDistance(q0, r0, q1, r1) === 1) || (q0 === q1 && r0 === r1 && Math.abs(y0 - y1) === 1);
        expect(ok).toBe(true);
      }
    }
  });

  it('property: the hit cell contains the ray point just past the hit, the hit point lies on the entered face, and nothing targetable lies in between', () => {
    const rng = mulberry32(0xc0ffee);
    const cells = new Set();
    for (let i = 0; i < 400; i++) {
      const q = Math.floor(rng() * 24) - 12;
      const r = Math.floor(rng() * 24) - 12;
      const y = 3 + Math.floor(rng() * 8);
      cells.add(`${q},${y},${r}`);
    }
    const get = sceneOf(cells);
    let hits = 0;
    for (let trial = 0; trial < 400; trial++) {
      const o = [rng() * 16 - 8, 2 + rng() * 10, rng() * 16 - 8];
      const d = dirFrom(rng() * Math.PI * 2, (rng() - 0.5) * Math.PI * 0.95);
      const hit = raycastHex(get, o[0], o[1], o[2], d[0], d[1], d[2], 14);
      if (!hit) continue;
      hits++;
      expectNoNegativeZero(hit);
      expect(isTargetable(hit.blockId)).toBe(true);
      if (hit.face === -1) {
        expect(hit.distance).toBe(0);
        const [q, r] = worldToHex(o[0], o[2]);
        expect([hit.q, hit.y, hit.r]).toEqual([q, Math.floor(o[1]), r]);
        continue;
      }
      expect(hit.distance).toBeGreaterThan(0);
      expect(hit.distance).toBeLessThanOrEqual(14);
      // Just past the hit the point is inside the reported cell (tolerance for grazing entries).
      const t2 = hit.distance + 1e-6;
      const px = o[0] + d[0] * t2;
      const py = o[1] + d[1] * t2;
      const pz = o[2] + d[2] * t2;
      const [hx, hz] = hexToWorld(hit.q, hit.r);
      expect(hexSignedDistance(hx, hz, px, pz)).toBeLessThanOrEqual(1e-5);
      expect(py).toBeGreaterThanOrEqual(hit.y - 1e-5);
      expect(py).toBeLessThanOrEqual(hit.y + 1 + 1e-5);
      // The hit point lies on the plane of the entered face.
      const t = hit.distance;
      const fx = o[0] + d[0] * t;
      const fy = o[1] + d[1] * t;
      const fz = o[2] + d[2] * t;
      if (hit.face === FACE_TOP) expect(Math.abs(fy - (hit.y + 1))).toBeLessThan(1e-7);
      else if (hit.face === FACE_BOTTOM) expect(Math.abs(fy - hit.y)).toBeLessThan(1e-7);
      else {
        const n = FACE_NORMALS[hit.face];
        expect(Math.abs((fx - hx) * n[0] + (fz - hz) * n[2] - HEX_INRADIUS)).toBeLessThan(1e-7);
        expect(hit.nx).toBe(n[0]);
        expect(hit.nz).toBe(n[2]);
        expect(hit.ny).toBe(0);
      }
      // Nothing targetable strictly before the hit.
      for (let s = 1e-4; s < t - 1e-4; s += 0.0173) {
        const [q, r] = worldToHex(o[0] + d[0] * s, o[2] + d[2] * s);
        const y = Math.floor(o[1] + d[1] * s);
        expect(isTargetable(get(q, y, r)), `trial ${trial}: solid cell before the hit at s=${s}`).toBe(false);
      }
    }
    expect(hits).toBeGreaterThan(50);
  });
});

describe('termination', () => {
  it('stops early once below the world and heading down, or above it heading up', () => {
    const rec = recording(() => BLOCK.AIR);
    expect(raycastHex(rec.fn, 0.3, -5, 0.2, 0.1, -1, 0.1, 1e6)).toBeNull();
    expect(rec.cells.length).toBeLessThan(8);
    const rec2 = recording(() => BLOCK.AIR);
    expect(raycastHex(rec2.fn, 0.3, WORLD_HEIGHT + 3, 0.2, 0.1, 1, 0.1, 1e6)).toBeNull();
    expect(rec2.cells.length).toBeLessThan(8);
  });

  it('a downward ray that exits the bottom of an all-air world returns null', () => {
    expect(raycastHex(() => BLOCK.AIR, 0, 2.5, 0, 0, -1, 0, 100)).toBeNull();
  });

  it('is bounded: Infinity / NaN maxDistance in an all-AIR world return null within the iteration cap', () => {
    const rec = recording(() => BLOCK.AIR);
    expect(raycastHex(rec.fn, 0, 60, 0, 1, 0, 0.3, Infinity)).toBeNull();
    expect(rec.cells.length).toBeLessThanOrEqual(UNBOUNDED_ITERATION_CAP + 1);
    expect(rec.cells.length).toBeGreaterThan(100);
    expect(raycastHex(() => BLOCK.AIR, 0, 60, 0, 1, 0, 0, NaN)).toBeNull();
  });

  it('the finite iteration cap never truncates a ray: a long horizontal ray reaches a cell 1000 cells away', () => {
    const get = sceneOf(['1000,60,0']);
    const hit = raycastHex(get, 0, 60.5, 0, 1, 0, 0, 1001);
    expect(hit).not.toBeNull();
    expect([hit.q, hit.y, hit.r]).toEqual([1000, 60, 0]);
    expect(Math.abs(hit.distance - (1000 - HEX_INRADIUS))).toBeLessThan(1e-6);
  });
});
