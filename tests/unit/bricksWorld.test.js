import { describe, it, expect } from 'vitest';
import { World } from '../../src/world.js';
import { BLOCK, isTargetable, isSolid, isReplaceable, isOpaque, isBrickShadow } from '../../src/blocks.js';
import { hexesOfBrick, bricksOfHex, BRICK_DEPTH, BrickGrid } from '../../src/bricks.js';
import { buildBrickMesh } from '../../src/brickmesher.js';
import { createPlayer, stepPlayer, PLAYER_RADIUS } from '../../src/physics.js';
import { serializeSave, deserializeSave } from '../../src/storage.js';
import { flatWorldGen, countFaces } from '../helpers/fixtures.js';

const s = BRICK_DEPTH;
const GROUND = 20;

/** A loaded flat world (stone up to y = 20) round the origin. */
function flatWorld(extra = {}) {
  const w = new World({ seed: 1, renderDistance: 2, worldGen: flatWorldGen(GROUND), now: () => 0, ...extra });
  for (let k = 0; k < 40; k++) w.update(0, 0, Infinity);
  return w;
}

describe('bricks in the world: shadows (§93.3)', () => {
  it('a brick shadows exactly the hexes it touches, with its pieces', () => {
    const w = flatWorld();
    const y = GROUND + 1;
    for (const [i, n] of [[0, 0], [0, 1], [0, 2]]) {
      expect(w.brickBlocker(i, y, n)).toBeNull();
      expect(w.setBrick(i, y, n, BLOCK.OAK_PLANKS)).toBe(true);
      for (const [q, r, bit] of hexesOfBrick(i, n)) {
        expect(isBrickShadow(w.getBlock(q, y, r))).toBe(true);
        expect(w.coverAt(q, y, r) & bit).toBe(bit);
        expect(w.coverAt(q, y, r) & (bit << 4)).toBe(bit << 4); // planks are opaque
      }
    }
    // the three bricks of column 0 cover all of hex (0, 1): its top point, its middle and its bottom point
    expect(w.getBlock(0, y, 1)).toBe(BLOCK.BRICK_FILL);
    expect(w.getBlock(0, y, 0)).toBe(BLOCK.BRICK_SHADOW); // only its south-east quarter
    expect(w.editCount).toBe(0); // shadows are never edits
  });

  it('the shadow is solid, not targetable, not replaceable, and see-through; FILL also opaque', () => {
    for (const id of [BLOCK.BRICK_SHADOW, BLOCK.BRICK_FILL]) {
      expect(isSolid(id)).toBe(true);
      expect(isTargetable(id)).toBe(false);
      expect(isReplaceable(id)).toBe(false);
      expect(isBrickShadow(id)).toBe(true);
    }
    expect(isOpaque(BLOCK.BRICK_SHADOW)).toBe(false);
    expect(isOpaque(BLOCK.BRICK_FILL)).toBe(true);
  });

  it('a hex covered entirely by opaque bricks is BRICK_FILL, by any glass BRICK_SHADOW', () => {
    const w = flatWorld();
    const y = GROUND + 1;
    const q = 1;
    const r = 1; // an odd row: three bricks cover it
    for (const [i, n] of bricksOfHex(q, r)) w.setBrick(i, y, n, BLOCK.STONE_BRICKS);
    expect(w.getBlock(q, y, r)).toBe(BLOCK.BRICK_FILL);
    const [i0, n0] = bricksOfHex(q, r)[1];
    w.setBrick(i0, y, n0, BLOCK.GLASS); // a glass middle: the cell is no longer all opaque
    expect(w.getBlock(q, y, r)).toBe(BLOCK.BRICK_SHADOW);
    w.setBrick(i0, y, n0, BLOCK.AIR);
    expect(w.getBlock(q, y, r)).toBe(BLOCK.BRICK_SHADOW); // the two points are still brick
    for (const [i, n] of bricksOfHex(q, r)) w.setBrick(i, y, n, BLOCK.AIR);
    expect(w.getBlock(q, y, r)).toBe(BLOCK.AIR);
    expect(w.coverAt(q, y, r)).toBe(0);
  });

  it('nothing writes over a shadow but the bricks', () => {
    const w = flatWorld();
    const y = GROUND + 1;
    w.setBrick(0, y, 1, BLOCK.OAK_PLANKS);
    expect(w.setBlock(0, y, 1, BLOCK.STONE)).toBe(false);
    expect(w.setBlock(0, y, 1, BLOCK.AIR)).toBe(false);
    expect(w.setBlock(0, y, 0, BLOCK.BRICK_SHADOW)).toBe(false); // and no block is written as one
    expect(w.getBlock(0, y, 1)).toBe(BLOCK.BRICK_SHADOW);
  });

  it('brickBlocker names why a brick cannot go somewhere', () => {
    const w = flatWorld();
    expect(w.brickBlocker(0, GROUND, 0)).toBe('blocked'); // inside the stone
    expect(w.brickBlocker(0, -1, 0)).toBe('height');
    expect(w.brickBlocker(0, 999, 0)).toBe('height');
    expect(w.brickBlocker(9999, GROUND + 1, 0)).toBe('unloaded');
    w.setBrick(0, GROUND + 1, 0, BLOCK.OAK_PLANKS);
    expect(w.brickBlocker(0, GROUND + 1, 0)).toBe('brick');
    expect(w.brickBlocker(1, GROUND + 1, 0)).toBeNull(); // shares a hex with the first brick: fine
  });

  it('a brick displaces water and records the cell as AIR, so a reload agrees', () => {
    const w = flatWorld();
    const y = GROUND + 1;
    expect(w.setBlock(0, y, 1, BLOCK.WATER)).toBe(true);
    expect(w.brickBlocker(0, y, 1)).toBeNull();
    w.setBrick(0, y, 1, BLOCK.OAK_PLANKS);
    expect(w.getBlock(0, y, 1)).toBe(BLOCK.BRICK_SHADOW);
    expect(w.hasEdit(0, y, 1)).toBe(false); // back to its generated AIR: no edit left
    w.setBrick(0, y, 1, BLOCK.AIR);
    expect(w.getBlock(0, y, 1)).toBe(BLOCK.AIR);
  });

  it('a chunk generated again gets its shadows back from the bricks', () => {
    const w = flatWorld();
    const y = GROUND + 2;
    w.setBrick(3, y, 5, BLOCK.BRICKS);
    const touched = hexesOfBrick(3, 5);
    w.dispose();
    for (let k = 0; k < 40; k++) w.update(0, 0, Infinity);
    for (const [q, r] of touched) expect(w.getBlock(q, y, r)).toBe(BLOCK.BRICK_SHADOW);
    expect(w.bricks.getBlock(3, y, 5)).toBe(BLOCK.BRICKS);
  });

  it('update() meshes the visible brick chunks and drops emptied ones', () => {
    const w = flatWorld();
    const meshed = [];
    const unloaded = [];
    w.onBrickMesh = (key, ci, cn, m) => meshed.push([key, m ? countFaces(m) : 0]);
    w.onBrickUnload = (key) => unloaded.push(key);
    w.setBrick(2, GROUND + 1, 2, BLOCK.OAK_PLANKS);
    w.update(0, 0, Infinity);
    expect(meshed.at(-1)).toEqual(['0,0', 5]); // the bottom face sits on the stone: culled
    w.setBrick(2, GROUND + 1, 2, BLOCK.AIR);
    w.update(0, 0, Infinity);
    expect(unloaded).toEqual(['0,0']);
    expect(w.bricks.chunks.size).toBe(0);
  });
});

describe('brick mesher (§93.4)', () => {
  const ctx = (g, hex = () => BLOCK.AIR) => ({ getBrick: g.getBlock, getHex: hex, lightAt: () => 0xf0 });

  it('a lone brick has six faces, two neighbours share theirs, glass culls only against glass', () => {
    const g = new BrickGrid();
    g.setBlock(3, 30, 3, BLOCK.OAK_PLANKS);
    expect(countFaces(buildBrickMesh(g.getChunk(0, 0), ctx(g)))).toBe(6);
    g.setBlock(3, 30, 4, BLOCK.OAK_PLANKS);
    expect(countFaces(buildBrickMesh(g.getChunk(0, 0), ctx(g)))).toBe(10);
    g.setBlock(3, 30, 4, BLOCK.GLASS);
    const m = buildBrickMesh(g.getChunk(0, 0), ctx(g));
    expect(m.cutout.faceCount).toBe(5); // the glass face toward the planks is culled (planks are opaque)…
    expect(m.opaque.faceCount).toBe(6); // …the planks still show their face toward the glass
  });

  it('positions are chunk-local and the brick depth deep; light comes from the hex field', () => {
    const g = new BrickGrid();
    g.setBlock(17, 5, 25, BLOCK.STONE_BRICKS); // chunk (1, 1), local (1, 5, 1)
    const m = buildBrickMesh(g.getChunk(1, 1), { getBrick: g.getBlock, getHex: () => BLOCK.AIR, lightAt: () => (7 << 4) | 3 });
    const p = m.opaque.positions;
    const zs = [];
    for (let k = 2; k < p.length; k += 3) zs.push(p[k]);
    expect(Math.min(...zs)).toBeCloseTo(s, 5);
    expect(Math.max(...zs)).toBeCloseTo(2 * s, 5);
    expect(m.opaque.light[0]).toBe(7 * 17);
    expect(m.opaque.light[1]).toBe(3 * 17);
  });

  it('a face against a brick cell buried in opaque terrain is culled', () => {
    const g = new BrickGrid();
    g.setBlock(0, 10, 1, BLOCK.OAK_PLANKS); // a middle-row brick
    const stoneEverywhereBelow = (q, y) => (y < 10 ? BLOCK.STONE : BLOCK.AIR);
    expect(countFaces(buildBrickMesh(g.getChunk(0, 0), ctx(g, stoneEverywhereBelow)))).toBe(5);
  });
});

describe('player against bricks (§93.6)', () => {
  const ground = (q, y) => (y <= 9 ? BLOCK.STONE : BLOCK.AIR);

  it('stops a radius short of a brick wall face and slides along it', () => {
    const g = new BrickGrid();
    for (let i = -5; i <= 5; i++) for (let y = 10; y <= 12; y++) g.setBlock(i, y, 6, BLOCK.STONE_BRICKS);
    const p = createPlayer(0.5, 10, 2 * s);
    p.onGround = true;
    for (let k = 0; k < 120; k++) stepPlayer(p, { forward: 1, strafe: 0, yaw: Math.PI }, ground, 1 / 60, g.getBlock);
    expect(p.z).toBeCloseTo(6 * s - PLAYER_RADIUS, 4);
    expect(p.hitWall).toBe(true);
  });

  it('stands on a brick floor and fits a passage one brick deep', () => {
    const g = new BrickGrid();
    for (let i = -3; i <= 3; i++) for (let n = -3; n <= 3; n++) g.setBlock(i, 12, n, BLOCK.OAK_PLANKS);
    const p = createPlayer(0.3, 15, 0.2);
    for (let k = 0; k < 120; k++) stepPlayer(p, { forward: 0, strafe: 0, yaw: 0 }, () => BLOCK.AIR, 1 / 60, g.getBlock);
    expect(p.y).toBeCloseTo(13, 3);
    expect(p.onGround).toBe(true);
    const c = new BrickGrid();
    for (let i = -2; i <= 12; i++) for (let y = 10; y <= 12; y++) {
      c.setBlock(i, y, 0, BLOCK.BRICKS);
      c.setBlock(i, y, 2, BLOCK.BRICKS);
    }
    const w = createPlayer(0, 10, 1.5 * s);
    w.onGround = true;
    for (let k = 0; k < 120; k++) stepPlayer(w, { forward: 0, strafe: 1, yaw: 0 }, ground, 1 / 60, c.getBlock);
    expect(w.x).toBeGreaterThan(8);
  });

  it('with exact bricks the shadows are passed through; without (mobs) they are solid', () => {
    const shadowAt = (q, y, r) => (y <= 9 ? BLOCK.STONE : y === 10 && q === 1 && r === 0 ? BLOCK.BRICK_SHADOW : BLOCK.AIR);
    const exact = createPlayer(0, 10, 0);
    exact.onGround = true;
    const mob = createPlayer(0, 10, 0);
    mob.onGround = true;
    for (let k = 0; k < 60; k++) {
      stepPlayer(exact, { forward: 0, strafe: 1, yaw: 0 }, shadowAt, 1 / 60, new BrickGrid().getBlock);
      stepPlayer(mob, { forward: 0, strafe: 1, yaw: 0 }, shadowAt, 1 / 60);
    }
    expect(exact.x).toBeGreaterThan(1.5); // walked through the shadow cell (there is no brick)
    expect(mob.x).toBeLessThan(0.5 - PLAYER_RADIUS + 1e-6); // stopped at the shadow hex
  });
});

describe('bricks in saves (§93.8)', () => {
  const base = { seed: 7, time: 0.3, day: 2, player: { x: 0, y: 30, z: 0, yaw: 0, pitch: 0, flying: false }, edits: {} };

  it('round-trips through serializeSave / deserializeSave and rebuilds the world', () => {
    const w = flatWorld();
    w.setBrick(1, GROUND + 1, 1, BLOCK.OAK_PLANKS);
    w.setBrick(-4, GROUND + 3, -9, BLOCK.GLASS);
    const text = serializeSave({ ...base, bricks: w.bricks.export() });
    const save = deserializeSave(text);
    expect(save.bricks).toEqual(w.bricks.export());
    const w2 = flatWorld({ bricks: save.bricks });
    expect(w2.bricks.list()).toEqual(w.bricks.list());
    for (const [q, r] of hexesOfBrick(1, 1)) expect(w2.getBlock(q, GROUND + 1, r)).toBe(BLOCK.BRICK_SHADOW);
  });

  it('a world without bricks serialises exactly as before (no field)', () => {
    expect(serializeSave({ ...base, bricks: {} })).toBe(serializeSave(base));
    expect(JSON.parse(serializeSave(base))).not.toHaveProperty('bricks');
  });
});
