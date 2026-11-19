// Tests for src/plantAtlas.js (the painted plant atlas), src/plantKit.js (what plants are built of) and the
// ?scene=plants screenshot aid — CONTRACTS §105.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PLANT_ATLAS_W, PLANT_ATLAS_H, PLANT_ATLAS_PAD, PLANT_ATLAS_MIPS, PLANT_UV_OFFSET, plantAtlasLayout, plantPictureKeys,
  plantRect, paintPlantAtlas, plantAtlasMips, plantUV, PLANT_CARD_TOP,
} from '../../src/plantAtlas.js';
import {
  Plant, PLANT_LOD_NEAR, PLANT_LOD_FAR, PLANT_STRIDE, leafGeo, ribbonGeo, curve, discGeo, frame, dirAt,
} from '../../src/plantKit.js';
import { KIT_MODEL_IDS, plantMesh, plantVariants, PLANT_LOD_NEAR as NEAR, PLANT_LOD_FAR as FAR } from '../../src/plantModels.js';
import { BLOCK, BLOCKS } from '../../src/blocks.js';
import {
  parseParams, readSceneParam, PLANT_SCENE_ROWS, PLANT_SCENE_AHEAD, PLANT_SCENE_ROW_GAP, PLANT_SCENE_COL_GAP, plantSceneCells,
} from '../../src/diagnostics.js';
import { hexToWorld } from '../../src/hex.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

describe('the plant atlas (plantAtlas.js)', () => {
  it('every picture has its own rectangle inside the atlas, a gutter apart from every other', () => {
    const L = plantAtlasLayout();
    expect([L.width, L.height]).toEqual([PLANT_ATLAS_W, PLANT_ATLAS_H]);
    const keys = plantPictureKeys();
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(L.rects).sort()).toEqual([...keys].sort());
    const rects = keys.map((k) => plantRect(k));
    for (const [x, y, w, h] of rects) {
      expect(x >= PLANT_ATLAS_PAD && y >= PLANT_ATLAS_PAD).toBe(true);
      expect(x + w + PLANT_ATLAS_PAD <= PLANT_ATLAS_W && y + h + PLANT_ATLAS_PAD <= PLANT_ATLAS_H).toBe(true);
      expect(y + h + PLANT_ATLAS_PAD).toBeLessThanOrEqual(PLANT_CARD_TOP); // above the far cards' grid (§105.3)
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const [ax, ay, aw, ah] = rects[i];
        const [bx, by, bw, bh] = rects[j];
        const apart = ax + aw + PLANT_ATLAS_PAD <= bx || bx + bw + PLANT_ATLAS_PAD <= ax || ay + ah + PLANT_ATLAS_PAD <= by || by + bh + PLANT_ATLAS_PAD <= ay;
        expect(apart, `${keys[i]} / ${keys[j]}`).toBe(true);
      }
    }
    expect(() => plantRect('no such picture')).toThrow(RangeError);
  });

  it('every picture is painted from by some model, and every picture a model names is in the atlas', () => {
    const used = new Set();
    for (const id of KIT_MODEL_IDS) {
      const n = id === BLOCK.LOOSE_STONES ? 3 : plantVariants(id);
      for (let v = 0; v < n; v++) for (const lod of [NEAR, FAR]) for (const k of /** @type {*} */ (plantMesh(id, lod, v)).keys) used.add(k);
    }
    for (const k of used) expect(plantPictureKeys(), k).toContain(k);
    for (const k of plantPictureKeys()) expect(used.has(k), `${k} is painted but no model uses it`).toBe(true);
  });

  it('paints the same image every time: solid pictures opaque everywhere, cut-outs only fully opaque or fully clear', () => {
    const img = paintPlantAtlas();
    expect(img.data.length).toBe(PLANT_ATLAS_W * PLANT_ATLAS_H * 4);
    expect(paintPlantAtlas()).toBe(img); // cached
    const L = plantAtlasLayout();
    for (const key of plantPictureKeys()) {
      const [x0, y0, w, h] = plantRect(key);
      let clear = 0;
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const a = img.data[(y * img.width + x) * 4 + 3];
          if (L.cut.has(key)) expect(a === 0 || a === 255, key).toBe(true);
          else expect(a, key).toBe(255);
          if (a === 0) clear++;
        }
      }
      if (L.cut.has(key)) {
        expect(clear, key).toBeGreaterThan(0); // a real cut-out …
        expect(clear / (w * h), key).toBeLessThan(0.97); // … with something in it
        // its clear texels carry a colour (no black fringe when filtered)
        let dark = 0;
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
          const i = (y * img.width + x) * 4;
          if (img.data[i + 3] === 0 && img.data[i] + img.data[i + 1] + img.data[i + 2] === 0) dark++;
        }
        expect(dark / Math.max(1, clear), key).toBeLessThan(0.05);
      }
    }
    // the gutter repeats the picture's edge
    const [x, y] = plantRect('bark');
    const at = (px, py) => [...img.data.slice((py * img.width + px) * 4, (py * img.width + px) * 4 + 4)];
    expect(at(x - 1, y)).toEqual(at(x, y));
  });

  it('its mip chain: PLANT_ATLAS_MIPS levels, each half the last; a cut-out thins with distance but does not vanish', () => {
    const mips = plantAtlasMips();
    expect(mips).toHaveLength(PLANT_ATLAS_MIPS);
    mips.forEach((m, l) => {
      expect(m.width).toBe(PLANT_ATLAS_W >> l);
      expect(m.height).toBe(PLANT_ATLAS_H >> l);
      expect(m.data.length).toBe(m.width * m.height * 4);
    });
    // one opaque texel among four clear ones survives one level down (alpha between the mean and the most opaque)
    const tiny = { width: 2, height: 2, data: new Uint8ClampedArray([200, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) };
    const two = plantAtlasMips(/** @type {*} */ ({ ...tiny, width: 4, height: 4, data: new Uint8ClampedArray(64).map((_, i) => (i < 4 ? [200, 0, 0, 255][i] : 0)) }));
    expect(two[1].data[3]).toBeGreaterThan(127); // passes the alpha test
    expect(two[1].data[0]).toBe(200); // keeps its colour (alpha-weighted)
    void tiny;
  });

  it('plantUV: a point of a picture, fv up from its bottom row, in atlas uvs (v down the image)', () => {
    const [x, y, w, h] = plantRect('honey.leaf0');
    expect(plantUV('honey.leaf0', 0, 0)).toEqual([x / PLANT_ATLAS_W, (y + h) / PLANT_ATLAS_H]);
    expect(plantUV('honey.leaf0', 1, 1)).toEqual([(x + w) / PLANT_ATLAS_W, y / PLANT_ATLAS_H]);
    expect(PLANT_UV_OFFSET).toBeGreaterThanOrEqual(2); // past the block atlas's [0, 1] by a whole unit
  });
});

describe('the plant kit (plantKit.js)', () => {
  it('a leaf card is two folded halves, four triangles (a diamond two), its stalk at the origin and its tip up +y', () => {
    const hex = leafGeo('hex', 0.2, 0.1);
    expect(hex.index.length / 3).toBe(4);
    expect(leafGeo('diamond', 0.2, 0.1).index.length / 3).toBe(2);
    let top = 0;
    for (let v = 0; v < hex.positions.length; v += 3) top = Math.max(top, hex.positions[v + 1]);
    expect(top).toBeCloseTo(0.2, 6);
    // the two halves face apart a little (the fold), both toward +z
    const n0 = [hex.normals[0], hex.normals[1], hex.normals[2]];
    const nl = [hex.normals[hex.normals.length - 3], hex.normals[hex.normals.length - 2], hex.normals[hex.normals.length - 1]];
    expect(n0[2]).toBeGreaterThan(0.5);
    expect(nl[2]).toBeGreaterThan(0.5);
    expect(Math.abs(n0[0] - nl[0])).toBeGreaterThan(0.1);
  });

  it('a curve bends evenly toward its side; a ribbon along it tapers to a point; a disc faces up', () => {
    const { pts } = curve([0, 0, 0], [0, 1, 0], [1, 0, 0], 1, Math.PI / 2, 4);
    expect(pts).toHaveLength(5);
    expect(pts[4][0]).toBeGreaterThan(0.4); // it bent toward +x
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    expect(len).toBeCloseTo(1, 6);
    const blade = ribbonGeo(pts, pts.map(() => [0, 0, 1]), [0.05, 0.04, 0.03, 0.02, 0]);
    expect(blade.index.length / 3).toBe(7); // three quads and the tip's triangle
    const d = discGeo(0.1, 6, 0.01);
    expect(d.index.length / 3).toBe(6);
    for (let v = 0; v < d.normals.length; v += 3) expect(d.normals[v + 1]).toBeGreaterThan(0.9);
  });

  it('frame never collapses: a part laid straight up with an upward hint still gets a whole frame', () => {
    const M = frame([0, 0, 0], [0, 1, 0], [0, 1, 0]);
    const x = [M[0], M[1], M[2]];
    const z = [M[8], M[9], M[10]];
    expect(Math.hypot(...x)).toBeCloseTo(1, 6);
    expect(Math.hypot(...z)).toBeCloseTo(1, 6);
    expect(Math.abs(x[0] * z[0] + x[1] * z[1] + x[2] * z[2])).toBeLessThan(1e-6);
  });

  it('far away a whorl keeps about a third of its leaves, bigger; a stem three sides; fruit goes from a picked plant', () => {
    const build = (lod, bare) => {
      const k = new Plant(lod, bare, 7);
      k.stem([0, 0, 0], [0, 0.3, 0], 0.02, 0.015, 'bark');
      k.whorl([0, 0.3, 0], 9, 0.15, 0.08, 0.3, 0, ['honey.leaf0']);
      k.gem([0, 0.2, 0.1], [0, -1, 0], 0.02, 0.04, 'honey.berry', { fruit: true });
      return k.compile();
    };
    const near = build(PLANT_LOD_NEAR, false);
    const far = build(PLANT_LOD_FAR, false);
    const bare = build(PLANT_LOD_NEAR, true);
    expect(near.tris).toBeGreaterThan(far.tris * 2);
    expect(bare.keys).not.toContain('honey.berry');
    expect(near.keys).toContain('honey.berry');
    expect(near.data.length).toBe(near.verts * PLANT_STRIDE);
    // a leaf never droops into the ground
    const k = new Plant(PLANT_LOD_NEAR, false, 1);
    k.leaf([0, 0.02, 0], dirAt(0, -1.2), 0.2, 0.1, 'honey.leaf0');
    const low = k.compile();
    for (let v = 0; v < low.verts; v++) expect(low.data[v * PLANT_STRIDE + 1]).toBeGreaterThanOrEqual(0);
  });
});

describe('the ?scene=plants screenshot aid (diagnostics.js, main.js, README)', () => {
  it('?scene=plants and ?ahead= are read; every plant, picked plant, crop and piece of litter is in the scene once', () => {
    expect(readSceneParam(new URLSearchParams('scene=Plants'))).toBe('plants');
    expect(parseParams('?scene=plants&ahead=8').ahead).toBe(8);
    expect(parseParams('?scene=plants&ahead=-4').ahead).toBe(-4);
    expect(parseParams('?scene=plants&ahead=900').ahead).toBe(60);
    expect(parseParams('?scene=plants').ahead).toBeNull();
    const ids = PLANT_SCENE_ROWS.flat();
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual([...KIT_MODEL_IDS].filter((id) => !BLOCKS[id].name.startsWith('planted_') || id === BLOCK.PLANTED_CARROT).sort((a, b) => a - b));
    for (const row of PLANT_SCENE_ROWS) expect(row.length).toBeLessThanOrEqual(6);
  });

  it('plantSceneCells: the rows ahead of the player, centred on the line of sight, each plant on its own column', () => {
    const [px, pz] = hexToWorld(10, 10);
    const cells = plantSceneCells(px, pz, 0, -1);
    expect(cells).toHaveLength(PLANT_SCENE_ROWS.flat().length);
    expect(new Set(cells.map((c) => `${c.q},${c.r}`)).size).toBe(cells.length);
    // the first row stands PLANT_SCENE_AHEAD ahead (−z), the last PLANT_SCENE_ROW_GAP per row farther
    const z = (c) => hexToWorld(c.q, c.r)[1];
    const first = cells.filter((c) => PLANT_SCENE_ROWS[0].includes(c.id));
    for (const c of first) expect(Math.abs(pz - z(c) - PLANT_SCENE_AHEAD)).toBeLessThan(1);
    const last = cells.filter((c) => PLANT_SCENE_ROWS[PLANT_SCENE_ROWS.length - 1].includes(c.id));
    for (const c of last) expect(Math.abs(pz - z(c) - PLANT_SCENE_AHEAD - (PLANT_SCENE_ROWS.length - 1) * PLANT_SCENE_ROW_GAP)).toBeLessThan(1);
    // a row is centred: as much of it to the left as to the right
    const xs = first.map((c) => hexToWorld(c.q, c.r)[0] - px);
    expect(Math.abs(Math.max(...xs) + Math.min(...xs))).toBeLessThan(PLANT_SCENE_COL_GAP);
    // the prickly pear stands on sand, the rest on grass
    expect(cells.find((c) => c.id === BLOCK.PRICKLY_PEAR)?.under).toBe(BLOCK.SAND);
    expect(cells.find((c) => c.id === BLOCK.FERN)?.under).toBe(BLOCK.GRASS_BLOCK);
  });

  it('main builds it, and the README lists it', () => {
    const main = read('src/main.js');
    expect(main).toContain("if (name === 'plants') return buildPlantScene(fx, fz, feet);");
    expect(main).toContain('plantSceneCells(player.x, player.z, fx, fz, params.ahead ?? PLANT_SCENE_AHEAD)');
    expect(read('README.md')).toContain('`?scene=plants`');
  });
});
