// §93.9 water in brickwork: a hex partly under bricks with one open space left is a BRICK_GAP that water stands in; water
// crosses a face only where open pieces meet; a pool reaches into the gaps beside it and is held at the brick face.
import { describe, it, expect } from 'vitest';
import { World } from '../../src/world.js';
import { BlockPhysics } from '../../src/blockphysics.js';
import { BLOCK, isWater, isWaterSource, isSolid } from '../../src/blocks.js';
import {
  holdsWater, waterCrossesFace, waterCrossesLayer, hexesOfBrick, bricksOfHex, fullPieceMask,
  PIECE_NW, PIECE_NE, PIECE_SW, PIECE_SE, PIECE_TOP, PIECE_MID, PIECE_BOT, BRICK_DEPTH,
} from '../../src/bricks.js';
import { HEX_DIRS, HEX_SIZE, hexToWorld } from '../../src/hex.js';
import { buildChunkMesh } from '../../src/mesher.js';
import { serializeSave, deserializeSave } from '../../src/storage.js';
import { flatWorldGen } from '../helpers/fixtures.js';

const B = BLOCK;
const GROUND = 20;
const Y = GROUND; // the layer the tests dig out and build in (stone below it is the floor)

/** A loaded flat world (stone up to y = 20) round the origin, with block physics wired as main wires it. */
function setup() {
  const world = new World({ seed: 1, renderDistance: 2, worldGen: flatWorldGen(GROUND), now: () => 0 });
  for (let k = 0; k < 40; k++) world.update(0, 0, Infinity);
  const physics = new BlockPhysics(world, {});
  world.onBlockChange = (q, y, r, prev, next) => physics.onBlockChange(q, y, r, prev, next);
  world.onCoverChange = (q, y, r) => physics.onCoverChange(q, y, r);
  return { world, physics };
}

function run(physics, n) {
  for (let i = 0; i < n; i++) physics.tick();
}

/** Dig layer Y out over the cells whose centre lies in x ∈ [x0, x1], z ∈ [z0, z1]. */
function dig(world, x0, x1, z0, z1) {
  for (let r = Math.floor(z0 / 0.866) - 1; r <= Math.ceil(z1 / 0.866) + 1; r++) {
    for (let q = Math.floor(x0 - r / 2) - 1; q <= Math.ceil(x1 - r / 2) + 1; q++) {
      const [x, z] = hexToWorld(q, r);
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) world.setBlock(q, Y, r, B.AIR);
    }
  }
}

/** Every cell of layer Y whose centre lies in the box, as [q, r]. */
function cellsIn(x0, x1, z0, z1) {
  const out = [];
  for (let r = Math.floor(z0 / 0.866) - 1; r <= Math.ceil(z1 / 0.866) + 1; r++) {
    for (let q = Math.floor(x0 - r / 2) - 1; q <= Math.ceil(x1 - r / 2) + 1; q++) {
      const [x, z] = hexToWorld(q, r);
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) out.push([q, r]);
    }
  }
  return out;
}

const s = BRICK_DEPTH;

describe('the geometry of water in brickwork (§93.9)', () => {
  it('a hex holds water unless it is all brick or its open pieces meet at a point only', () => {
    for (let cover = 0; cover < 16; cover++) {
      const open = 15 & ~cover;
      const split = open === (PIECE_NW | PIECE_SE) || open === (PIECE_NE | PIECE_SW);
      expect(holdsWater(cover, 0)).toBe(open !== 0 && !split);
    }
    for (let cover = 0; cover < 8; cover++) {
      const open = 7 & ~cover;
      expect(holdsWater(cover, 1)).toBe(open !== 0 && open !== (PIECE_TOP | PIECE_BOT));
    }
  });

  it('both sides of a face a brick spans agree, so a face is closed from either side', () => {
    // For every brick and every face between two hexes it touches or borders, covering it closes the face both ways.
    for (let n = -6; n < 6; n++) {
      for (let i = -3; i < 3; i++) {
        const pieces = new Map(hexesOfBrick(i, n).map(([q, r, bit]) => [`${q},${r}`, bit]));
        for (const [q, r, bit] of hexesOfBrick(i, n)) {
          for (let j = 0; j < 6; j++) {
            const nq = q + HEX_DIRS[j][0];
            const nr = r + HEX_DIRS[j][1];
            const theirs = pieces.get(`${nq},${nr}`) ?? 0;
            const mine = bit;
            // closed exactly when neither side has an open piece on the face
            const ab = waterCrossesFace(mine, r, j, theirs, nr);
            const ba = waterCrossesFace(theirs, nr, (j + 3) % 6, mine, r);
            expect(ab).toBe(ba);
          }
        }
      }
    }
    // the seam of an odd row's E face: either middle brick alone closes it
    expect(waterCrossesFace(PIECE_MID, 1, 0, 0, 1)).toBe(false);
    expect(waterCrossesFace(0, 1, 0, PIECE_MID, 1)).toBe(false);
    expect(waterCrossesFace(PIECE_TOP | PIECE_BOT, 1, 0, 0, 1)).toBe(true); // only the middle meets that face
    expect(waterCrossesFace(PIECE_TOP, 1, 0, 0, 1)).toBe(true);
    // an even row's E face is closed only when both its quarters are
    expect(waterCrossesFace(PIECE_NE, 0, 0, PIECE_NW, 0)).toBe(true);
    expect(waterCrossesFace(PIECE_NE | PIECE_SE, 0, 0, PIECE_NW | PIECE_SW, 0)).toBe(false);
    // layers: open pieces must overlap
    expect(waterCrossesLayer(PIECE_NW | PIECE_NE, PIECE_SW | PIECE_SE, 0)).toBe(false);
    expect(waterCrossesLayer(PIECE_NW, PIECE_SW | PIECE_SE, 0)).toBe(true);
    expect(waterCrossesLayer(0, fullPieceMask(1), 1)).toBe(false);
  });
});

describe('a gap in brickwork in the world (§93.9)', () => {
  it('takes water, gives it back as the gap, and refuses blocks; the edit says AIR', () => {
    const { world } = setup();
    const y = GROUND + 1;
    world.setBrick(0, y, 0, B.STONE_BRICKS); // the SE quarter of (0, 0), the SW of (1, 0), the top point of (0, 1)
    expect(world.getBlock(0, y, 0)).toBe(B.BRICK_GAP);
    expect(isSolid(B.BRICK_GAP)).toBe(true); // to everything but water
    expect(world.setBlock(0, y, 0, B.STONE)).toBe(false);
    expect(world.setBlock(0, y, 0, B.WATER)).toBe(true);
    expect(world.getBlock(0, y, 0)).toBe(B.WATER);
    expect(world.exportEdits()['0,0']).toBeDefined();
    expect(world.setBlock(0, y, 0, B.SAND)).toBe(false); // no block goes where bricks are
    expect(world.setBlock(0, y, 0, B.AIR)).toBe(true);
    expect(world.getBlock(0, y, 0)).toBe(B.BRICK_GAP);
    expect(world.hasEdit(0, y, 0)).toBe(false); // back to generated AIR
    expect(world.setBlock(0, y, 0, B.BRICK_GAP)).toBe(false); // (already the gap)
    expect(world.setBlock(5, y, 5, B.BRICK_GAP)).toBe(false); // never written where no brick is
  });

  it('a brick keeps the water it is set in when the rest of the hex is one space, displaces it when not', () => {
    const { world } = setup();
    const y = GROUND + 1;
    const [[iT, nT], [iM, nM], [iB, nB]] = bricksOfHex(0, 1); // the odd hex (0, 1): its top point, middle, bottom point
    world.setBlock(0, y, 1, B.WATER);
    world.setBrick(iT, y, nT, B.STONE_BRICKS);
    expect(world.getBlock(0, y, 1)).toBe(B.WATER); // middle and bottom open
    world.setBrick(iB, y, nB, B.STONE_BRICKS);
    expect(world.getBlock(0, y, 1)).toBe(B.WATER); // the middle open
    world.setBrick(iT, y, nT, B.AIR);
    world.setBrick(iM, y, nM, B.STONE_BRICKS);
    expect(world.getBlock(0, y, 1)).toBe(B.WATER); // the top point open
    world.setBrick(iB, y, nB, B.AIR); // both points open, the middle brick between them: they meet nowhere
    expect(world.getBlock(0, y, 1)).toBe(B.BRICK_SHADOW);
    expect(world.hasEdit(0, y, 1)).toBe(false); // the water was recorded away to AIR, its generated id
    world.setBrick(iM, y, nM, B.AIR);
    expect(world.getBlock(0, y, 1)).toBe(B.AIR);
  });

  it('water in a gap is saved as water and comes back into the gap', () => {
    const { world } = setup();
    const y = GROUND + 1;
    world.setBrick(3, y, 3, B.BRICKS); // the SE quarter of (2, 2), the SW of (3, 2), the top point of (2, 3)
    const [q, r] = hexesOfBrick(3, 3)[0];
    world.setBlock(q, y, r, B.WATER);
    const save = deserializeSave(serializeSave({
      seed: 1, time: 0.3, day: 2, player: { x: 0, y: 30, z: 0, yaw: 0, pitch: 0, flying: false },
      edits: world.exportEdits(), bricks: world.bricks.export(),
    }));
    const back = new World({ seed: 1, renderDistance: 2, worldGen: flatWorldGen(GROUND), now: () => 0, edits: save.edits, bricks: save.bricks });
    for (let k = 0; k < 40; k++) back.update(0, 0, Infinity);
    expect(back.getBlock(q, y, r)).toBe(B.WATER);
    for (const [qq, rr] of hexesOfBrick(3, 3).slice(1)) expect(back.getBlock(qq, y, rr)).toBe(B.BRICK_GAP);
  });
});

/**
 * A brick box on layer Y: walls along x at brick rows nA and nB (= nA + 9), along z at columns 1 and 10, the ground dug out
 * round it, every open cell inside it a source. @returns {{ world, physics, inside: (q, r) => boolean }}
 */
function brickBox(nA) {
  const { world, physics } = setup();
  const nB = nA + 9;
  dig(world, -3, 15, -3, 16);
  const put = (i, n) => {
    const why = world.brickBlocker(i, Y, n);
    if (why !== null && why !== 'brick') throw new Error(`brick ${i},${n}: ${why}`);
    world.setBrick(i, Y, n, B.STONE_BRICKS);
  };
  for (let i = 1; i <= 10; i++) {
    put(i, nA);
    put(i, nB);
  }
  for (let n = nA; n <= nB; n++) {
    put(1, n);
    put(10, n);
  }
  const inside = (q, r) => {
    const [x, z] = hexToWorld(q, r);
    return x > 2 && x < 10 && z > (nA + 1) * s && z < nB * s;
  };
  for (const [q, r] of cellsIn(2.2, 9.8, (nA + 1.5) * s, (nB - 0.5) * s)) {
    if (world.getBlock(q, Y, r) === B.AIR) world.setBlock(q, Y, r, B.WATER);
  }
  return { world, physics, inside, nA, nB };
}

/** The cells of layer Y round the box (centre at least a hex outside its walls) that hold water. */
function wetOutside(world, nA, nB) {
  return cellsIn(-3, 15, -3, 16).filter(([q, r]) => {
    const [x, z] = hexToWorld(q, r);
    const out = x < 0.5 || x > 11.5 || z < (nA - 1) * s || z > (nB + 2) * s;
    return out && isWater(world.getBlock(q, Y, r));
  });
}

describe('water held by brick walls (§93.9)', () => {
  for (const nA of [3, 4, 5]) {
    it(`a brick box holds its pool with walls in brick row ${nA % 3} of 3, and the pool reaches into the walls' gaps`, () => {
      const { world, physics, nB, inside } = brickBox(nA);
      run(physics, 400);
      expect(wetOutside(world, nA, nB)).toEqual([]);
      // every gap that opens on to the pool (an open face toward a cell inside the box) holds the pool's water
      let gaps = 0;
      let wetGaps = 0;
      for (const [q, r] of cellsIn(0, 12, (nA - 2) * s, (nB + 3) * s)) {
        const cover = world.coverAt(q, Y, r) & 15;
        if (cover === 0 || !holdsWater(cover, r)) continue;
        const opens = HEX_DIRS.some(([dq, dr], j) => inside(q + dq, r + dr) && (world.coverAt(q + dq, Y, r + dr) & 15) === 0
          && waterCrossesFace(cover, r, j, 0, r + dr));
        if (!opens) continue;
        gaps++;
        if (isWaterSource(world.getBlock(q, Y, r))) wetGaps++;
      }
      expect(gaps).toBeGreaterThan(0);
      expect(wetGaps).toBe(gaps);
    });
  }

  it('a brick taken out of the wall lets the pool out through the gap, and it runs dry (§83 law 2)', () => {
    const { world, physics, nA, nB, inside } = brickBox(3);
    run(physics, 300);
    expect(wetOutside(world, nA, nB)).toEqual([]);
    world.setBrick(5, Y, nA, B.AIR); // a hole one brick wide in the north wall
    run(physics, 20);
    expect(wetOutside(world, nA, nB).length).toBeGreaterThan(0);
    run(physics, 400);
    expect(cellsIn(2, 10, (nA + 1) * s, nB * s).filter(([q, r]) => inside(q, r) && isWaterSource(world.getBlock(q, Y, r)))).toEqual([]);
  });
});

describe('a channel one brick wide (§93.9)', () => {
  /**
   * The sea west of x = 0 (more than BODY_MAX_CELLS sources); east of it solid brickwork, but a channel one brick wide
   * along brick row 7 (the middles of hex row 5) from x = 0 to 9 and a basin at x 9..14, brick rows 3..12.
   */
  function canal(blocked) {
    const { world, physics } = setup();
    dig(world, -14, 16, -7, 17);
    for (const [q, r] of cellsIn(-14, -0.1, -7, 17)) world.setBlock(q, Y, r, B.WATER);
    const channel = (i, n) => n === 7 && i >= 0 && i <= 8;
    const basin = (i, n) => i >= 9 && i <= 13 && n >= 3 && n <= 12;
    for (let n = -14; n <= 32; n++) {
      for (let i = 0; i <= 15; i++) {
        if ((channel(i, n) && !(blocked && i === 4)) || basin(i, n)) continue;
        if (world.brickBlocker(i, Y, n) === null) world.setBrick(i, Y, n, B.STONE_BRICKS);
      }
    }
    const basinCells = cellsIn(9.6, 13.4, 4 * s, 12 * s);
    return { world, physics, basinCells };
  }

  it('carries water from the sea into a basin', () => {
    const { world, physics, basinCells } = canal(false);
    for (let i = 0; i <= 8; i++) expect(world.getBlock(i - 2, Y, 5)).toBe(B.BRICK_GAP); // the channel: middles of row 5
    run(physics, 500);
    for (let i = 0; i <= 8; i++) expect(isWater(world.getBlock(i - 2, Y, 5))).toBe(true);
    expect(basinCells.some(([q, r]) => isWater(world.getBlock(q, Y, r)))).toBe(true);
  });

  it('a brick across the channel keeps the basin dry; taken out, the water comes through', () => {
    const { world, physics, basinCells } = canal(true);
    run(physics, 500);
    expect(basinCells.filter(([q, r]) => isWater(world.getBlock(q, Y, r)))).toEqual([]);
    expect(isWater(world.getBlock(3 - 2, Y, 5))).toBe(true); // up to the brick
    expect(isWater(world.getBlock(5 - 2, Y, 5))).toBe(false); // and not past it
    world.setBrick(4, Y, 7, B.AIR);
    run(physics, 500);
    expect(basinCells.some(([q, r]) => isWater(world.getBlock(q, Y, r)))).toBe(true);
  });
});

describe('water drawn in brickwork (§93.9)', () => {
  /** Area of the up-facing translucent triangles whose centroid lies within `rad` of world (x, z) (chunk (0, 0) is local). */
  function capArea(mesh, x, z, rad = 0.55) {
    if (!mesh) return 0;
    const { positions: p, normals: nm, indices: ix } = mesh;
    let area = 0;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3;
      const b = ix[t + 1] * 3;
      const c = ix[t + 2] * 3;
      if (nm[a + 1] < 0.9) continue;
      const cx = (p[a] + p[b] + p[c]) / 3;
      const cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
      if (Math.hypot(cx - x, cz - z) > rad) continue;
      const ux = p[b] - p[a];
      const uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a];
      const vz = p[c + 2] - p[a + 2];
      area += Math.abs(ux * vz - uz * vx) / 2;
    }
    return area;
  }
  const HEX_AREA = (3 * Math.sqrt(3) / 2) * HEX_SIZE * HEX_SIZE;

  it('water under a brick quarter draws three quarters of its cap', () => {
    const { world } = setup();
    const y = GROUND + 1;
    world.setBlock(0, y, 0, B.WATER);
    const plain = buildChunkMesh(0, 0, world.getChunkData).translucent;
    expect(capArea(plain, 0, 0)).toBeCloseTo(HEX_AREA, 5);
    world.setBrick(0, y, 0, B.STONE_BRICKS);
    const bricked = buildChunkMesh(0, 0, world.getChunkData).translucent;
    expect(capArea(bricked, 0, 0)).toBeCloseTo(HEX_AREA * 0.75, 5);
  });

  it('a point brickwork leaves beside water is drawn full of it, and the water draws no side toward it', () => {
    const { world } = setup();
    const y = GROUND + 1;
    world.setBrick(0, y, 1, B.STONE_BRICKS); // the middle of (0, 1): its two points are left, a BRICK_SHADOW
    expect(world.getBlock(0, y, 1)).toBe(B.BRICK_SHADOW);
    world.setBlock(0, y, 0, B.WATER); // north-west of (0, 1): beside its top point
    const mesh = buildChunkMesh(0, 0, world.getChunkData).translucent;
    const [x1, z1] = hexToWorld(0, 1);
    const top = capArea(mesh, x1, z1 - HEX_SIZE * 0.66, 0.3);
    expect(top).toBeCloseTo(HEX_SIZE / 4, 5); // the top point's triangle: 1 wide, s/2 deep
    expect(capArea(mesh, x1, z1 + HEX_SIZE * 0.66, 0.3)).toBe(0); // the bottom point has no water beside it
  });
});
