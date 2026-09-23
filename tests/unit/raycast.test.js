// Tests for src/raycast.js — CONTRACTS.md §11, cases adapted from docs/PLAN-build.md §2.7.
import { describe, it, expect } from 'vitest';
import { WORLD_HEIGHT } from '../../src/config.js';
import { FACE_PX, FACE_NX, FACE_PY, FACE_NY, FACE_PZ, FACE_NZ, FACE_NORMALS } from '../../src/coords.js';
import { BLOCK, isTargetable } from '../../src/blocks.js';
import { makeGetBlock } from '../../tests/helpers/fixtures.js';
import { raycastVoxel } from '../../src/raycast.js';

const { AIR, STONE, WATER, GLASS, OAK_LEAVES } = BLOCK;

/** getBlock over a sparse world plus a call counter and an integer-coordinate assertion. */
function countingWorld(map) {
  const inner = makeGetBlock(map);
  const calls = [];
  const getBlock = (x, y, z) => {
    calls.push([x, y, z]);
    return inner(x, y, z);
  };
  return { getBlock, calls };
}

const emptyWorld = makeGetBlock({});

describe('raycastVoxel — basic hits', () => {
  it('hits STONE at (3,0,0) from (0.5,0.5,0.5) along +X at distance 2.5 through the -X face', () => {
    const getBlock = makeGetBlock({ '3,0,0': STONE });
    const hit = raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 0, 0, 10);
    expect(hit).not.toBeNull();
    expect(hit).toEqual({
      x: 3, y: 0, z: 0,
      face: FACE_NX,
      nx: -1, ny: 0, nz: 0,
      distance: 2.5,
      blockId: STONE,
    });
    // The adjacent (placement) cell is hit + normal.
    expect([hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz]).toEqual([2, 0, 0]);
  });

  it('returns exactly the RaycastHit keys', () => {
    const hit = raycastVoxel(makeGetBlock({ '3,0,0': STONE }), 0.5, 0.5, 0.5, 1, 0, 0, 10);
    expect(Object.keys(hit).sort()).toEqual(['blockId', 'distance', 'face', 'nx', 'ny', 'nz', 'x', 'y', 'z']);
  });

  it('reports the actual block id it stopped on', () => {
    const hit = raycastVoxel(makeGetBlock({ '3,0,0': GLASS }), 0.5, 0.5, 0.5, 1, 0, 0, 10);
    expect(hit.blockId).toBe(GLASS);
    const hit2 = raycastVoxel(makeGetBlock({ '3,0,0': OAK_LEAVES }), 0.5, 0.5, 0.5, 1, 0, 0, 10);
    expect(hit2.blockId).toBe(OAK_LEAVES);
  });

  it('hits along -Y with normal [0,1,0] (top face) at distance 2.5', () => {
    // PLAN §2.7 case 4 shifted up so the target stays inside the world's height range.
    const getBlock = makeGetBlock({ '0,7,0': STONE });
    const hit = raycastVoxel(getBlock, 0.5, 10.5, 0.5, 0, -1, 0, 10);
    expect(hit).toMatchObject({ x: 0, y: 7, z: 0, face: FACE_PY, nx: 0, ny: 1, nz: 0, blockId: STONE });
    expect(hit.distance).toBeCloseTo(2.5, 12);
  });

  it('off-grid diagonal: origin (0.2,0.5,0.7), dir norm(1,0,0.5), STONE at (2,0,1) → entered through -X face', () => {
    const getBlock = makeGetBlock({ '2,0,1': STONE });
    const len = Math.hypot(1, 0, 0.5);
    const hit = raycastVoxel(getBlock, 0.2, 0.5, 0.7, 1 / len, 0, 0.5 / len, 10);
    expect(hit).toMatchObject({ x: 2, y: 0, z: 1, face: FACE_NX, nx: -1, ny: 0, nz: 0, blockId: STONE });
    // Distance to the plane x = 2 along the normalised direction.
    expect(hit.distance).toBeCloseTo((2 - 0.2) / (1 / len), 12);
  });

  it('distance is measured along the normalised ray for an oblique direction', () => {
    const getBlock = makeGetBlock({ '4,2,0': STONE });
    // Direction (2,1,0): reaches x=4 after travelling t where 0.5 + t*(2/√5) = 4 → y = 0.5 + t/√5 = 2.25 → cell y 2.
    const hit = raycastVoxel(getBlock, 0.5, 0.5, 0.5, 2, 1, 0, 10);
    expect(hit).toMatchObject({ x: 4, y: 2, z: 0, face: FACE_NX });
    expect(hit.distance).toBeCloseTo(3.5 / (2 / Math.sqrt(5)), 12);
  });
});

describe('raycastVoxel — maxDistance', () => {
  const getBlock = makeGetBlock({ '3,0,0': STONE });

  it('returns null when the hit is beyond maxDistance', () => {
    expect(raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 0, 0, 2)).toBeNull();
  });

  it('boundary: 2.5 - 1e-6 → null, 2.5 exactly → hit (inclusive), 2.5 + 1e-6 → hit', () => {
    expect(raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 0, 0, 2.5 - 1e-6)).toBeNull();
    expect(raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 0, 0, 2.5)).toMatchObject({ x: 3, distance: 2.5 });
    expect(raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 0, 0, 2.5 + 1e-6)).toMatchObject({ x: 3, distance: 2.5 });
  });

  it('maxDistance 0 still reports a start-inside hit but nothing else', () => {
    expect(raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 0, 0, 0)).toBeNull();
    expect(raycastVoxel(getBlock, 3.5, 0.5, 0.5, 1, 0, 0, 0)).toMatchObject({ x: 3, face: -1, distance: 0 });
  });

  it('does not probe cells beyond maxDistance', () => {
    const { getBlock: gb, calls } = countingWorld({});
    raycastVoxel(gb, 0.5, 0.5, 0.5, 1, 0, 0, 2);
    // Start cell + cells entered at t = 0.5, 1.5 (t = 2.5 exceeds maxDistance and is never probed).
    expect(calls.length).toBe(3);
    for (const [x] of calls) expect(x).toBeLessThanOrEqual(2);
  });
});

describe('raycastVoxel — empty world and termination', () => {
  it('returns null quickly in an empty world with maxDistance 1000', () => {
    // Warm the JIT first; the deterministic iteration-cap test below is the real "quickly" guarantee, this
    // wall-clock bound is deliberately loose so it does not flake when vitest workers share the CPU.
    expect(raycastVoxel(emptyWorld, 0.5, 64.5, 0.5, 1, 0, 0, 1000)).toBeNull();
    const t0 = performance.now();
    expect(raycastVoxel(emptyWorld, 0.5, 64.5, 0.5, 1, 0, 0, 1000)).toBeNull();
    expect(raycastVoxel(emptyWorld, 0.5, 64.5, 0.5, 1, 0, 1, 1000)).toBeNull();
    expect(raycastVoxel(emptyWorld, 0.5, 64.5, 0.5, 0.3, 0.001, -0.7, 1000)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('never exceeds the iteration cap ceil(maxDistance*3)+3 (plus the start-cell probe)', () => {
    const { getBlock, calls } = countingWorld({});
    // A fully diagonal ray maximises boundary crossings per unit distance.
    raycastVoxel(getBlock, 0.5, 60.5, 0.5, 1, 0.01, 1, 40);
    expect(calls.length).toBeLessThanOrEqual(Math.ceil(40 * 3) + 3 + 1);
    // ≈ √2 crossings per block for this direction, so we should still have walked the whole ray.
    expect(calls.length).toBeGreaterThan(40);
  });

  it('exits early when the ray leaves the top of the world going up', () => {
    const { getBlock, calls } = countingWorld({});
    expect(raycastVoxel(getBlock, 0.5, WORLD_HEIGHT - 1.5, 0.5, 0, 1, 0, 1000)).toBeNull();
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it('exits early when the ray leaves the bottom of the world going down', () => {
    const { getBlock, calls } = countingWorld({});
    expect(raycastVoxel(getBlock, 0.5, 1.5, 0.5, 0, -1, 0, 1000)).toBeNull();
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it('exits early when starting above the world and moving horizontally or upward', () => {
    const up = countingWorld({});
    expect(raycastVoxel(up.getBlock, 0.5, WORLD_HEIGHT + 2.5, 0.5, 0.3, 0.1, 0.2, 1000)).toBeNull();
    expect(up.calls.length).toBeLessThanOrEqual(2);
    const flat = countingWorld({});
    expect(raycastVoxel(flat.getBlock, 0.5, WORLD_HEIGHT + 2.5, 0.5, 1, 0, 0, 1000)).toBeNull();
    expect(flat.calls.length).toBeLessThanOrEqual(2);
  });

  it('exits early when starting below the world and moving horizontally or downward', () => {
    const down = countingWorld({});
    expect(raycastVoxel(down.getBlock, 0.5, -2.5, 0.5, 0.3, -0.1, 0.2, 1000)).toBeNull();
    expect(down.calls.length).toBeLessThanOrEqual(2);
    const flat = countingWorld({});
    expect(raycastVoxel(flat.getBlock, 0.5, -2.5, 0.5, 0, 0, -1, 1000)).toBeNull();
    expect(flat.calls.length).toBeLessThanOrEqual(2);
  });

  it('a ray from above the world going down still hits terrain inside it', () => {
    const { getBlock, calls } = countingWorld({ '0,100,0': STONE });
    const hit = raycastVoxel(getBlock, 0.5, WORLD_HEIGHT + 2.5, 0.5, 0, -1, 0, 1000);
    expect(hit).toMatchObject({ x: 0, y: 100, z: 0, face: FACE_PY, ny: 1 });
    expect(hit.distance).toBeCloseTo(WORLD_HEIGHT + 2.5 - 101, 12);
    expect(calls.length).toBeLessThanOrEqual(WORLD_HEIGHT + 3 - 100 + 1);
  });

  it('a ray from below the world going up still hits terrain inside it', () => {
    const hit = raycastVoxel(makeGetBlock({ '0,5,0': STONE }), 0.5, -3.5, 0.5, 0, 1, 0, 1000);
    expect(hit).toMatchObject({ x: 0, y: 5, z: 0, face: FACE_NY, ny: -1 });
    expect(hit.distance).toBeCloseTo(8.5, 12);
  });

  it('terminates for a non-finite maxDistance instead of looping forever', () => {
    expect(raycastVoxel(emptyWorld, 0.5, 64.5, 0.5, 1, 0, 0, Infinity)).toBeNull();
    expect(raycastVoxel(emptyWorld, 0.5, 64.5, 0.5, 1, 0, 0, NaN)).toBeNull();
    expect(raycastVoxel(makeGetBlock({ '3,64,0': STONE }), 0.5, 64.5, 0.5, 1, 0, 0, Infinity))
      .toMatchObject({ x: 3, y: 64, z: 0, distance: 2.5 });
  });

  it('returns null for non-finite origin or direction components', () => {
    const getBlock = makeGetBlock({ '3,0,0': STONE });
    expect(raycastVoxel(getBlock, NaN, 0.5, 0.5, 1, 0, 0, 10)).toBeNull();
    expect(raycastVoxel(getBlock, 0.5, 0.5, 0.5, NaN, 0, 0, 10)).toBeNull();
    expect(raycastVoxel(getBlock, 0.5, 0.5, 0.5, Infinity, 0, 0, 10)).toBeNull();
  });
});

describe('raycastVoxel — all six faces', () => {
  const target = [10, 10, 10];
  const getBlock = makeGetBlock({ '10,10,10': STONE });
  const cases = [
    { face: FACE_PX, origin: [13.5, 10.5, 10.5], dir: [-1, 0, 0] },
    { face: FACE_NX, origin: [7.5, 10.5, 10.5], dir: [1, 0, 0] },
    { face: FACE_PY, origin: [10.5, 13.5, 10.5], dir: [0, -1, 0] },
    { face: FACE_NY, origin: [10.5, 7.5, 10.5], dir: [0, 1, 0] },
    { face: FACE_PZ, origin: [10.5, 10.5, 13.5], dir: [0, 0, -1] },
    { face: FACE_NZ, origin: [10.5, 10.5, 7.5], dir: [0, 0, 1] },
  ];
  for (const c of cases) {
    it(`face ${c.face} has normal ${JSON.stringify(FACE_NORMALS[c.face])}`, () => {
      const hit = raycastVoxel(getBlock, ...c.origin, ...c.dir, 5);
      expect(hit).not.toBeNull();
      expect([hit.x, hit.y, hit.z]).toEqual(target);
      expect(hit.face).toBe(c.face);
      expect([hit.nx, hit.ny, hit.nz]).toEqual(FACE_NORMALS[c.face]);
      expect(hit.distance).toBeCloseTo(2.5, 12);
      // Normal points back toward the origin.
      expect(hit.nx * c.dir[0] + hit.ny * c.dir[1] + hit.nz * c.dir[2]).toBe(-1);
    });
  }

  it('oblique ray entering a top face reports FACE_PY', () => {
    const hit = raycastVoxel(getBlock, 9.5, 13.5, 9.5, 0.3, -1, 0.3, 10);
    expect(hit).toMatchObject({ x: 10, y: 10, z: 10, face: FACE_PY, nx: 0, ny: 1, nz: 0 });
  });
});

describe('raycastVoxel — negative coordinates', () => {
  it('floors negative origins correctly: (-0.5,0.5,0.5) along -X hits (-3,0,0) at 1.5', () => {
    const getBlock = makeGetBlock({ '-3,0,0': STONE });
    const hit = raycastVoxel(getBlock, -0.5, 0.5, 0.5, -1, 0, 0, 10);
    expect(hit).toEqual({ x: -3, y: 0, z: 0, face: FACE_PX, nx: 1, ny: 0, nz: 0, distance: 1.5, blockId: STONE });
  });

  it('works entirely in negative X/Z space along +X', () => {
    const getBlock = makeGetBlock({ '-5,3,-9': STONE });
    // floor(-8.5) = -9 on z; the -X face of x = -5 is at -5, i.e. 3.5 blocks from -8.5.
    const hit = raycastVoxel(getBlock, -8.5, 3.5, -8.5, 1, 0, 0, 10);
    expect(hit).toMatchObject({ x: -5, y: 3, z: -9, face: FACE_NX, distance: 3.5 });
  });

  it('works along -Z into negative Z', () => {
    const getBlock = makeGetBlock({ '-1,0,-4': STONE });
    const hit = raycastVoxel(getBlock, -0.25, 0.5, -0.5, 0, 0, -1, 10);
    expect(hit).toMatchObject({ x: -1, y: 0, z: -4, face: FACE_PZ, nz: 1 });
    expect(hit.distance).toBeCloseTo(2.5, 12);
  });

  it('only ever calls getBlock with integer coordinates (negative and positive)', () => {
    const { getBlock, calls } = countingWorld({});
    raycastVoxel(getBlock, -0.3, 12.7, -5.1, -0.4, -0.2, 0.9, 30);
    expect(calls.length).toBeGreaterThan(5);
    for (const [x, y, z] of calls) {
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
      expect(Number.isInteger(z)).toBe(true);
    }
    // Consecutive probes differ by exactly one step on exactly one axis.
    for (let i = 1; i < calls.length; i++) {
      const d = Math.abs(calls[i][0] - calls[i - 1][0]) + Math.abs(calls[i][1] - calls[i - 1][1]) + Math.abs(calls[i][2] - calls[i - 1][2]);
      expect(d).toBe(1);
    }
  });
});

describe('raycastVoxel — start inside a hit block', () => {
  it('returns face -1, zero normal, distance 0 and the block id', () => {
    const getBlock = makeGetBlock({ '3,0,0': STONE });
    const hit = raycastVoxel(getBlock, 3.5, 0.5, 0.5, 1, 0, 0, 10);
    expect(hit).toEqual({ x: 3, y: 0, z: 0, face: -1, nx: 0, ny: 0, nz: 0, distance: 0, blockId: STONE });
  });

  it('does not probe any further cell when starting inside', () => {
    const { getBlock, calls } = countingWorld({ '3,0,0': STONE });
    raycastVoxel(getBlock, 3.5, 0.5, 0.5, 1, 0, 0, 10);
    expect(calls).toEqual([[3, 0, 0]]);
  });

  it('starting inside with negative coordinates', () => {
    const getBlock = makeGetBlock({ '-1,0,-1': STONE });
    const hit = raycastVoxel(getBlock, -0.01, 0.99, -0.99, 0, 1, 0, 10);
    expect(hit).toMatchObject({ x: -1, y: 0, z: -1, face: -1, distance: 0 });
  });

  it('starting inside WATER with isTargetable is NOT a start hit', () => {
    const getBlock = makeGetBlock({ '0,0,0': WATER, '3,0,0': STONE });
    const hit = raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 0, 0, 10);
    expect(hit).toMatchObject({ x: 3, face: FACE_NX, distance: 2.5 });
  });
});

describe('raycastVoxel — isHit filter', () => {
  const getBlock = makeGetBlock({ '1,0,0': WATER, '2,0,0': WATER, '3,0,0': STONE });

  it('passes through WATER to the STONE behind it with the default isTargetable', () => {
    const hit = raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 0, 0, 10);
    expect(hit).toMatchObject({ x: 3, y: 0, z: 0, face: FACE_NX, distance: 2.5, blockId: STONE });
  });

  it('explicitly passing isTargetable behaves the same as the default', () => {
    const hit = raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 0, 0, 10, isTargetable);
    expect(hit).toMatchObject({ x: 3, distance: 2.5, blockId: STONE });
  });

  it('a custom isHit that accepts liquids stops on the first WATER cell', () => {
    const hit = raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 0, 0, 10, (id) => id !== AIR);
    expect(hit).toMatchObject({ x: 1, y: 0, z: 0, face: FACE_NX, distance: 0.5, blockId: WATER });
  });

  it('a custom isHit that rejects everything yields null', () => {
    expect(raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 0, 0, 10, () => false)).toBeNull();
  });

  it('isHit receives the raw block id returned by getBlock', () => {
    const seen = [];
    raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 0, 0, 10, (id) => { seen.push(id); return id === STONE; });
    expect(seen).toEqual([AIR, WATER, WATER, STONE]);
  });
});

describe('raycastVoxel — direction handling', () => {
  const getBlock = makeGetBlock({ '3,0,0': STONE });

  it('normalises an unnormalised direction; distance is in blocks along the unit ray', () => {
    const hit = raycastVoxel(getBlock, 0.5, 0.5, 0.5, 10, 0, 0, 10);
    expect(hit).toMatchObject({ x: 3, y: 0, z: 0, face: FACE_NX, distance: 2.5 });
    const tiny = raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1e-3, 0, 0, 10);
    expect(tiny).toMatchObject({ x: 3, distance: 2.5 });
  });

  it('maxDistance applies to the normalised ray, not the raw direction length', () => {
    expect(raycastVoxel(getBlock, 0.5, 0.5, 0.5, 100, 0, 0, 2)).toBeNull();
  });

  it('zero direction → null, even when starting inside a hit block', () => {
    expect(raycastVoxel(getBlock, 0.5, 0.5, 0.5, 0, 0, 0, 10)).toBeNull();
    expect(raycastVoxel(getBlock, 3.5, 0.5, 0.5, 0, 0, 0, 10)).toBeNull();
    expect(raycastVoxel(getBlock, 0.5, 0.5, 0.5, 0, -0, 0, 10)).toBeNull();
  });

  it('origin exactly on a cell boundary moving negative enters the neighbour at distance 0 (never -0)', () => {
    const gb = makeGetBlock({ '2,0,0': STONE });
    const hit = raycastVoxel(gb, 3, 0.5, 0.5, -1, 0, 0, 10);
    expect(hit).toMatchObject({ x: 2, y: 0, z: 0, face: FACE_PX, nx: 1 });
    expect(hit.distance).toBe(0);
    expect(Object.is(hit.distance, -0)).toBe(false);
  });

  it('origin exactly on a cell boundary moving positive stays in its own cell first', () => {
    const gb = makeGetBlock({ '3,0,0': STONE, '4,0,0': STONE });
    const hit = raycastVoxel(gb, 3, 0.5, 0.5, 1, 0, 0, 10);
    // floor(3) = 3 → we start inside the STONE at x = 3.
    expect(hit).toMatchObject({ x: 3, face: -1, distance: 0 });
  });
});

describe('raycastVoxel — exact ties are broken x, then y, then z', () => {
  const s = Math.SQRT1_2;

  it('XZ diagonal from a cell centre: visits (1,0,0) before (0,0,1)', () => {
    const both = makeGetBlock({ '1,0,0': STONE, '0,0,1': STONE });
    const hit = raycastVoxel(both, 0.5, 0.5, 0.5, s, 0, s, 10);
    expect(hit).toMatchObject({ x: 1, y: 0, z: 0, face: FACE_NX, nx: -1 });
    expect(hit.distance).toBeCloseTo(0.5 * Math.SQRT2, 12);
  });

  it('XZ diagonal: hits (2,0,1) and never jumps straight to (2,0,2)', () => {
    // Along the exact diagonal the corner cells (1,0,0),(1,0,1),(2,0,1),(2,0,2) are all visited.
    const getBlock = makeGetBlock({ '2,0,1': STONE, '1,0,2': STONE, '2,0,2': STONE });
    const hit = raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 0, 1, 10);
    expect(hit).toMatchObject({ x: 2, y: 0, z: 1, face: FACE_NX, nx: -1, ny: 0, nz: 0 });
    expect(hit.distance).toBeCloseTo(1.5 * Math.SQRT2, 12);

    // Only the far corner is solid: it is reached, but through a Z step (after (2,0,1)), not a diagonal jump.
    const { getBlock: gb, calls } = countingWorld({ '2,0,2': STONE });
    const far = raycastVoxel(gb, 0.5, 0.5, 0.5, 1, 0, 1, 10);
    expect(far).toMatchObject({ x: 2, y: 0, z: 2, face: FACE_NZ });
    expect(calls).toEqual([[0, 0, 0], [1, 0, 0], [1, 0, 1], [2, 0, 1], [2, 0, 2]]);
  });

  it('XYZ diagonal: x wins over y and z', () => {
    const getBlock = makeGetBlock({ '1,0,0': STONE, '0,1,0': STONE, '0,0,1': STONE });
    const hit = raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 1, 1, 10);
    expect(hit).toMatchObject({ x: 1, y: 0, z: 0, face: FACE_NX });
  });

  it('YZ diagonal: y wins over z', () => {
    const getBlock = makeGetBlock({ '0,1,0': STONE, '0,0,1': STONE });
    const hit = raycastVoxel(getBlock, 0.5, 0.5, 0.5, 0, 1, 1, 10);
    expect(hit).toMatchObject({ x: 0, y: 1, z: 0, face: FACE_NY, ny: -1 });
  });

  it('XYZ diagonal visits cells in x, y, z order at every tie and reaches the corner via z', () => {
    const { getBlock, calls } = countingWorld({ '1,1,1': STONE });
    const hit = raycastVoxel(getBlock, 0.5, 0.5, 0.5, 1, 1, 1, 10);
    expect(hit).toMatchObject({ x: 1, y: 1, z: 1, face: FACE_NZ, nx: 0, ny: 0, nz: -1 });
    expect(hit.distance).toBeCloseTo(0.5 * Math.sqrt(3), 12);
    expect(calls).toEqual([[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1]]);
  });

  it('negative diagonal ties also break x first', () => {
    const getBlock = makeGetBlock({ '-1,0,0': STONE, '0,0,-1': STONE });
    const hit = raycastVoxel(getBlock, 0.5, 0.5, 0.5, -1, 0, -1, 10);
    expect(hit).toMatchObject({ x: -1, y: 0, z: 0, face: FACE_PX, nx: 1 });
  });
});
