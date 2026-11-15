import { describe, it, expect } from 'vitest';
import {
  BRICK_DEPTH, BRICK_CHUNK_I, BRICK_CHUNK_N, BRICK_CHUNK_VOLUME, hexesOfBrick, bricksOfHex, facePieces, fullPieceMask,
  isEvenRow, worldToBrick, brickLocalIndex, brickIndexToLocal, BrickGrid, normalizeBricksJSON, brickChunksOfHexChunk,
  raycastBricks, brickCircleContact, cylinderIntersectsBrick, BRICK_FACE_SHADE, parseBrickChunkKey,
  PIECE_NW, PIECE_NE, PIECE_SW, PIECE_SE, PIECE_TOP, PIECE_MID, PIECE_BOT,
} from '../../src/bricks.js';
import { HEX_SIZE, HEX_ROW_SPACING, HEX_CORNERS, HEX_AREA, FACE_SHADE, hexToWorld } from '../../src/hex.js';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';

const s = BRICK_DEPTH;

// ---- polygon helpers (exact clipping, no rasters) ---------------------------------------------------
function hexPoly(q, r) {
  const [cx, cz] = hexToWorld(q, r);
  return HEX_CORNERS.map(([dx, dz]) => [cx + dx, cz + dz]);
}
function clip(poly, px, pz, nx, nz) {
  const out = [];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    const fa = (a[0] - px) * nx + (a[1] - pz) * nz;
    const fb = (b[0] - px) * nx + (b[1] - pz) * nz;
    if (fa <= 1e-12) out.push(a);
    if ((fa < -1e-12 && fb > 1e-12) || (fa > 1e-12 && fb < -1e-12)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
function clipRect(poly, x0, z0, x1, z1) {
  return [[x0, 0, -1, 0], [x1, 0, 1, 0], [0, z0, 0, -1], [0, z1, 0, 1]].reduce((p, [px, pz, nx, nz]) => clip(p, px, pz, nx, nz), poly);
}
function area(p) {
  if (p.length < 3) return 0;
  let a = 0;
  for (let k = 0; k < p.length; k++) {
    const [x, z] = p[k];
    const [x2, z2] = p[(k + 1) % p.length];
    a += x * z2 - x2 * z;
  }
  return Math.abs(a) / 2;
}
const brickRect = (i, n) => [i, n * s, i + 1, (n + 1) * s];
/** The polygon of piece `bit` of hex (q, r). */
function piecePoly(q, r, bit) {
  const [cx, cz] = hexToWorld(q, r);
  const H = hexPoly(q, r);
  if (isEvenRow(r)) {
    const west = bit === PIECE_NW || bit === PIECE_SW;
    const north = bit === PIECE_NW || bit === PIECE_NE;
    return clip(clip(H, cx, cz, west ? 1 : -1, 0), cx, cz, 0, north ? 1 : -1);
  }
  if (bit === PIECE_TOP) return clip(H, cx, cz - s / 2, 0, 1);
  if (bit === PIECE_BOT) return clip(H, cx, cz + s / 2, 0, -1);
  return clip(clip(H, cx, cz - s / 2, 0, -1), cx, cz + s / 2, 0, 1);
}
/** Every hex that the brick column overlaps with positive area, by exact clipping. */
function overlapsByClipping(i, n) {
  const [x0, z0, x1, z1] = brickRect(i, n);
  const out = [];
  const r0 = Math.floor(z0 / HEX_ROW_SPACING) - 2;
  const r1 = Math.ceil(z1 / HEX_ROW_SPACING) + 2;
  for (let r = r0; r <= r1; r++) {
    for (let q = Math.floor(x0 - r / 2) - 2; q <= Math.ceil(x1 - r / 2) + 2; q++) {
      const a = area(clipRect(hexPoly(q, r), x0, z0, x1, z1));
      if (a > 1e-9) out.push([q, r, a]);
    }
  }
  return out;
}

describe('brick geometry (§93.1)', () => {
  it('is 1 wide and half a hex point-to-point deep', () => {
    expect(s).toBeCloseTo(1 / Math.sqrt(3), 12);
    expect(s).toBe(HEX_SIZE);
    expect(3 * s).toBeCloseTo(2 * HEX_ROW_SPACING, 12); // 3 brick rows = 2 hex rows
    expect(BRICK_CHUNK_N * s).toBeCloseTo(CHUNK_SIZE * HEX_ROW_SPACING, 9); // a brick chunk is a hex chunk deep
  });

  it('hexesOfBrick names exactly the hexes the brick overlaps, each with exactly the claimed piece', () => {
    let checked = 0;
    for (let n = -9; n <= 9; n++) {
      for (let i = -6; i <= 6; i++) {
        const claimed = hexesOfBrick(i, n);
        const real = overlapsByClipping(i, n);
        expect(claimed.length).toBe(real.length);
        const [x0, z0, x1, z1] = brickRect(i, n);
        let total = 0;
        for (const [q, r, bit] of claimed) {
          const hit = real.find(([rq, rr]) => rq === q && rr === r);
          expect(hit, `brick ${i},${n} hex ${q},${r}`).toBeDefined();
          const piece = piecePoly(q, r, bit);
          // the overlap IS the piece: same area, and the piece lies inside the brick
          expect(hit[2]).toBeCloseTo(area(piece), 9);
          expect(area(clipRect(piece, x0, z0, x1, z1))).toBeCloseTo(area(piece), 9);
          total += hit[2];
          checked++;
        }
        expect(total).toBeCloseTo(s, 9); // the pieces tile the brick
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('bricksOfHex is the inverse: the pieces tile the hex, one brick per piece', () => {
    for (let r = -7; r <= 7; r++) {
      for (let q = -5; q <= 5; q++) {
        const list = bricksOfHex(q, r);
        expect(list.length).toBe(isEvenRow(r) ? 4 : 3);
        let mask = 0;
        let total = 0;
        for (const [i, n, bit] of list) {
          expect(mask & bit).toBe(0);
          mask |= bit;
          expect(hexesOfBrick(i, n).some(([hq, hr, hb]) => hq === q && hr === r && hb === bit)).toBe(true);
          total += area(piecePoly(q, r, bit));
        }
        expect(mask).toBe(fullPieceMask(r));
        expect(total).toBeCloseTo(HEX_AREA, 9);
      }
    }
  });

  it('a middle-row brick lies inside one hex: the hex minus its two points', () => {
    for (const [i, n] of [[0, 1], [3, 4], [-2, -2], [5, -5]]) {
      const list = hexesOfBrick(i, n);
      expect(list.length).toBe(1);
      expect(list[0][2]).toBe(PIECE_MID);
    }
  });

  it('facePieces names the piece(s) each side face lies in', () => {
    for (const r of [0, 1, -1, -2]) {
      const H = hexPoly(0, r);
      for (let j = 0; j < 6; j++) {
        const a = H[j];
        const b = H[(j + 1) % 6];
        const bits = facePieces(r, j);
        for (const t of [0.1, 0.3, 0.7, 0.9]) {
          const x = a[0] + (b[0] - a[0]) * t;
          const z = a[1] + (b[1] - a[1]) * t;
          // the point lies on the boundary of one of the claimed pieces
          const pieces = [1, 2, 4, 8].filter((bit) => bits & bit).map((bit) => piecePoly(0, r, bit));
          const inOne = pieces.some((P) => P.some((v, k) => {
            const w = P[(k + 1) % P.length];
            const cr = (w[0] - v[0]) * (z - v[1]) - (w[1] - v[1]) * (x - v[0]);
            const tt = ((x - v[0]) * (w[0] - v[0]) + (z - v[1]) * (w[1] - v[1])) / ((w[0] - v[0]) ** 2 + (w[1] - v[1]) ** 2);
            return Math.abs(cr) < 1e-9 && tt >= -1e-9 && tt <= 1 + 1e-9;
          }));
          expect(inOne, `row ${r} face ${j} t ${t}`).toBe(true);
        }
      }
    }
  });

  it('brick faces are shaded like hex faces (±X = E / W)', () => {
    expect(BRICK_FACE_SHADE[0]).toBe(FACE_SHADE[0]);
    expect(BRICK_FACE_SHADE[1]).toBe(FACE_SHADE[3]);
    expect(BRICK_FACE_SHADE[2]).toBe(1);
    expect(BRICK_FACE_SHADE[3]).toBe(0.55);
    expect(BRICK_FACE_SHADE[4]).toBeGreaterThan(BRICK_FACE_SHADE[5]);
  });

  it('worldToBrick floors in both axes, negatives too', () => {
    expect(worldToBrick(0.5, 0.1)).toEqual([0, 0]);
    expect(worldToBrick(-0.1, -0.1)).toEqual([-1, -1]);
    expect(worldToBrick(2, 3 * s + 1e-9)).toEqual([2, 3]);
  });

  it('brickChunksOfHexChunk lists every brick chunk a hex chunk touches', () => {
    for (const [cq, cr] of [[0, 0], [-1, 0], [2, -3], [-2, 1], [5, 5]]) {
      const listed = new Set(brickChunksOfHexChunk(cq, cr).map(([a, b]) => `${a},${b}`));
      for (let lq = 0; lq < CHUNK_SIZE; lq++) {
        for (let lr = 0; lr < CHUNK_SIZE; lr++) {
          for (const [i, n] of bricksOfHex(cq * CHUNK_SIZE + lq, cr * CHUNK_SIZE + lr)) {
            const key = `${Math.floor(i / BRICK_CHUNK_I)},${Math.floor(n / BRICK_CHUNK_N)}`;
            expect(listed.has(key), `hex chunk ${cq},${cr} needs brick chunk ${key}`).toBe(true);
          }
        }
      }
    }
  });
});

describe('BrickGrid (§93.2)', () => {
  it('stores, reads and removes bricks at negative coordinates', () => {
    const g = new BrickGrid();
    expect(g.getBlock(-3, 10, -7)).toBe(BLOCK.AIR);
    expect(g.setBlock(-3, 10, -7, BLOCK.OAK_PLANKS)).toBe(true);
    expect(g.getBlock(-3, 10, -7)).toBe(BLOCK.OAK_PLANKS);
    expect(g.getBlock(-3, 11, -7)).toBe(BLOCK.AIR);
    expect(g.setBlock(-3, 10, -7, BLOCK.OAK_PLANKS)).toBe(false); // unchanged
    expect(g.count).toBe(1);
    expect(g.setBlock(-3, 10, -7, BLOCK.AIR)).toBe(true);
    expect(g.count).toBe(0);
    expect(g.pruneEmpty()).toEqual([brickKeyOf(-3, -7)]);
    expect(g.chunks.size).toBe(0);
  });

  it('refuses out-of-range writes and never allocates a chunk to erase nothing', () => {
    const g = new BrickGrid();
    expect(g.setBlock(0, -1, 0, BLOCK.STONE)).toBe(false);
    expect(g.setBlock(0, WORLD_HEIGHT, 0, BLOCK.STONE)).toBe(false);
    expect(g.setBlock(0, 5, 0, 255)).toBe(false);
    expect(g.setBlock(0.5, 5, 0, BLOCK.STONE)).toBe(false);
    expect(g.setBlock(0, 5, 0, BLOCK.AIR)).toBe(false);
    expect(g.chunks.size).toBe(0);
  });

  it('local indices round-trip', () => {
    for (const [li, y, ln] of [[0, 0, 0], [15, 127, 23], [7, 64, 11]]) {
      expect(brickIndexToLocal(brickLocalIndex(li, y, ln))).toEqual([li, y, ln]);
    }
    expect(brickLocalIndex(15, 127, 23)).toBe(BRICK_CHUNK_VOLUME - 1);
  });

  it('exports, validates and loads (round trip)', () => {
    const g = new BrickGrid();
    g.setBlock(0, 5, 0, BLOCK.OAK_PLANKS);
    g.setBlock(-1, 6, 25, BLOCK.GLASS);
    g.setBlock(17, 7, -1, BLOCK.STONE_BRICKS);
    const json = g.export();
    expect(Object.keys(json)).toEqual(['-1,1', '0,0', '1,-1']);
    const h = new BrickGrid();
    expect(h.load(JSON.parse(JSON.stringify(json)))).toEqual([]);
    expect(h.list()).toEqual(g.list());
  });

  it('normalizeBricksJSON drops what a save cannot hold', () => {
    const { bricks, warnings } = normalizeBricksJSON({
      '0,0': [0, 5, 1, 0, 2, 255, BRICK_CHUNK_VOLUME, 5, 3, 5.5, 4],
      'x,1': [0, 5],
      '1,1': 'nope',
      '2,2': [7, 9, 7, 10],
    });
    expect(bricks).toEqual({ '0,0': [0, 5], '2,2': [7, 10] });
    expect(warnings.length).toBe(3);
    expect(normalizeBricksJSON(null)).toEqual({ bricks: {}, warnings: [] });
    expect(normalizeBricksJSON([1]).warnings.length).toBe(1);
    expect(parseBrickChunkKey(' 1,2')).toEqual([NaN, NaN]);
  });
});

function brickKeyOf(i, n) {
  return `${Math.floor(i / BRICK_CHUNK_I)},${Math.floor(n / BRICK_CHUNK_N)}`;
}

describe('raycastBricks (§93.5)', () => {
  const one = (i, y, n) => (bi, by, bn) => (bi === i && by === y && bn === n ? BLOCK.STONE : BLOCK.AIR);

  it('hits the west face from the west at the exact distance', () => {
    const hit = raycastBricks(one(3, 0, 1), 0.5, 0.5, 1.5 * s, 1, 0, 0, 10);
    expect(hit).toMatchObject({ i: 3, y: 0, n: 1, face: 1, nx: -1, ny: 0, nz: 0 });
    expect(hit.distance).toBeCloseTo(2.5, 12);
    expect(hit.px).toBeCloseTo(3, 12);
  });

  it('steps in brick depths along Z and reports the north face', () => {
    const hit = raycastBricks(one(0, 0, 4), 0.5, 0.5, 0.5 * s, 0, 0, 1, 10);
    expect(hit).toMatchObject({ i: 0, n: 4, face: 5, nz: -1 });
    expect(hit.distance).toBeCloseTo(3.5 * s, 12);
  });

  it('hits tops from above, respects maxDistance, starts inside, rejects zero rays', () => {
    const top = raycastBricks(one(0, 2, 0), 0.5, 6.5, 0.5 * s, 0, -1, 0, 10);
    expect(top).toMatchObject({ y: 2, face: 2, ny: 1 });
    expect(top.distance).toBeCloseTo(3.5, 12);
    expect(raycastBricks(one(0, 2, 0), 0.5, 6.5, 0.5 * s, 0, -1, 0, 3)).toBeNull();
    expect(raycastBricks(one(0, 2, 0), 0.5, 2.5, 0.5 * s, 1, 0, 0, 3)).toMatchObject({ face: -1, distance: 0 });
    expect(raycastBricks(one(0, 2, 0), 0, 0, 0, 0, 0, 0, 3)).toBeNull();
  });

  it('walks a long diagonal without missing the target', () => {
    const target = one(7, 3, 9);
    const [tx, ty, tz] = [7.5, 3.5, 9.5 * s];
    const [ox, oy, oz] = [-2.3, 0.7, -1.1];
    const hit = raycastBricks(target, ox, oy, oz, tx - ox, ty - oy, tz - oz, 30);
    expect(hit).toMatchObject({ i: 7, y: 3, n: 9 });
  });
});

describe('brick contact (§93.6)', () => {
  it('pushes a circle out of a brick through the nearest side', () => {
    const out = { depth: 0, nx: 0, nz: 0 };
    expect(brickCircleContact(0, 0, 1.2, 0.5 * s, 0.28, out)).toBe(true);
    expect(out.depth).toBeCloseTo(0.08, 12);
    expect([out.nx, out.nz]).toEqual([1, 0]);
    expect(brickCircleContact(0, 0, 0.5, s + 0.27, 0.28, out)).toBe(true);
    expect([out.nx, out.nz]).toEqual([0, 1]);
    expect(brickCircleContact(0, 0, 1.3, s + 0.3, 0.28, out)).toBe(false);
    expect(brickCircleContact(0, 0, 0.5, 0.01, 0.28, out)).toBe(true); // centre inside: out through the north side
    expect(out.nz).toBe(-1);
  });

  it('a player (0.56 wide) fits a gap one brick deep between two walls along X', () => {
    // walls in rows 0 and 2; row 1 (one brick deep, 0.577) is free: a cylinder centred in it touches neither
    const zc = 1.5 * s;
    expect(cylinderIntersectsBrick(0.5, 0, zc, 0.28, 1.8, 0, 0, 0)).toBe(false);
    expect(cylinderIntersectsBrick(0.5, 0, zc, 0.28, 1.8, 0, 0, 2)).toBe(false);
    expect(cylinderIntersectsBrick(0.5, 0, zc, 0.28, 1.8, 0, 2, 0)).toBe(false); // above the head (1.8 < 2)
    expect(cylinderIntersectsBrick(0.5, 0, zc, 0.28, 1.8, 0, 1, 0)).toBe(false);
  });
});
