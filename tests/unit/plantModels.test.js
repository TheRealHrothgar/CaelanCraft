// Tests for src/plantModels.js — every plant as a hex-faceted kit model on the plant atlas, in three levels of detail
// (CONTRACTS §102), and the furniture's box models (§85).
import { describe, it, expect } from 'vitest';
import {
  BLOCK, BLOCKS, PLANT_IDS, FARM_IDS, FURNITURE_MODEL_IDS, CROP_ROWS, getBlockShape, getFaceTile, tileToUV,
} from '../../src/blocks.js';
import {
  KIT_MODEL_IDS, PLANT_LOD_NEAR, PLANT_LOD_FAR, PLANT_LOD_CARD, PLANT_STRIDE, LOOSE_STONES_FLINT, isKitModel, plantMesh,
  plantVariants, buildPlantModel, FURNITURE_MODELS, BOX_QUAD_STRIDE, compileBoxModel, furnitureModel,
} from '../../src/plantModels.js';
import { plantRect, PLANT_ATLAS_W, PLANT_ATLAS_H } from '../../src/plantAtlas.js';

const B = BLOCK;
const name = (id) => BLOCKS[id].name;
const LITTER = [B.LOOSE_STONES, B.FALLEN_BRANCHES, B.GROUND_NEST, B.GROUND_NEST_EMPTY];
/** The plants proper: wild plants and the farm's blocks (not litter). */
const PLANTS = KIT_MODEL_IDS.filter((id) => !LITTER.includes(id));

/** The vertices of a compiled model: position, normal, uv, shade, its picture, fruit. */
function vertsOf(m) {
  const out = [];
  for (let v = 0; v < m.verts; v++) {
    const o = v * PLANT_STRIDE;
    out.push({
      p: [m.data[o], m.data[o + 1], m.data[o + 2]], n: [m.data[o + 3], m.data[o + 4], m.data[o + 5]],
      uv: [m.data[o + 6], m.data[o + 7]], shade: m.data[o + 8], key: m.keys[m.vkey[v]], fruit: m.vfruit[v] === 1,
    });
  }
  return out;
}
const variants = (id) => (id === B.LOOSE_STONES ? [0, 1, LOOSE_STONES_FLINT] : [...Array(plantVariants(id)).keys()]);

describe('the kit models (plantModels.js, CONTRACTS §102)', () => {
  it('every wild plant, every farm block and the ground litter has a kit model; the furniture keeps its box model', () => {
    const expected = [...PLANT_IDS, ...FARM_IDS, ...LITTER].sort((a, b) => a - b);
    expect([...KIT_MODEL_IDS]).toEqual(expected);
    for (const id of KIT_MODEL_IDS) {
      expect(isKitModel(id), name(id)).toBe(true);
      expect(['model', 'litter']).toContain(getBlockShape(id));
      expect(BLOCKS[id].icon, name(id)).toBe('flat'); // the Pack keeps its picture
      expect(plantVariants(id), name(id)).toBeGreaterThanOrEqual(1);
      expect(plantVariants(id), name(id)).toBeLessThanOrEqual(3);
      for (const lod of [PLANT_LOD_NEAR, PLANT_LOD_FAR, PLANT_LOD_CARD]) expect(plantMesh(id, lod, 0), name(id)).not.toBeNull();
    }
    for (const id of FURNITURE_MODEL_IDS) {
      expect(isKitModel(id)).toBe(false);
      expect(getBlockShape(id)).toBe('model');
      expect(furnitureModel(id)).toBeInstanceOf(Float32Array);
    }
    expect(Object.keys(FURNITURE_MODELS).map(Number)).toEqual([...FURNITURE_MODEL_IDS]);
    expect(plantMesh(B.STONE, PLANT_LOD_NEAR)).toBeNull();
    expect(isKitModel(B.SNARE)).toBe(false);
  });

  it('every model is well formed: unit normals, indices in range, uvs inside the pictures it names, a shade in (0, 1]', () => {
    for (const id of KIT_MODEL_IDS) {
      for (const v of variants(id)) {
        for (const lod of [PLANT_LOD_NEAR, PLANT_LOD_FAR]) {
          const m = /** @type {*} */ (plantMesh(id, lod, v));
          expect(m.block, name(id)).toBe(false);
          expect(m.data.length).toBe(m.verts * PLANT_STRIDE);
          expect(m.index.length).toBe(m.tris * 3);
          expect(m.index.every((i) => i < m.verts)).toBe(true);
          for (const x of vertsOf(m)) {
            expect(Math.hypot(...x.n), name(id)).toBeCloseTo(1, 4);
            expect(x.shade > 0 && x.shade <= 1, name(id)).toBe(true);
            const [rx, ry, rw, rh] = plantRect(x.key);
            const u = x.uv[0] * PLANT_ATLAS_W;
            const vv = x.uv[1] * PLANT_ATLAS_H;
            expect(u >= rx - 1e-3 && u <= rx + rw + 1e-3 && vv >= ry - 1e-3 && vv <= ry + rh + 1e-3, `${name(id)} ${x.key}`).toBe(true);
          }
        }
      }
    }
  });

  it('a plant stands on the floor inside its cell: real height, real width, never through the cell\'s roof', () => {
    for (const id of KIT_MODEL_IDS) {
      for (const v of variants(id)) {
        const m = /** @type {*} */ (plantMesh(id, PLANT_LOD_NEAR, v));
        const ps = vertsOf(m).map((x) => x.p);
        const lo = Math.min(...ps.map((p) => p[1]));
        expect(lo, name(id)).toBeGreaterThanOrEqual(0);
        expect(lo, name(id)).toBeLessThan(0.03);
        expect(m.height, name(id)).toBeLessThanOrEqual(0.95); // × MODEL_SCALE_MAX 1.05 it still fits under the roof
        expect(m.reach, name(id)).toBeLessThanOrEqual(0.58); // the cell is 0.5 to its flats, 0.577 to its corners
        const wide = (k) => Math.max(...ps.map((p) => p[k])) - Math.min(...ps.map((p) => p[k]));
        if (PLANTS.includes(id)) {
          expect(m.height, name(id)).toBeGreaterThan(0.13); // a 3D thing, not a picture on the floor
          expect(Math.max(wide(0), wide(2)), name(id)).toBeGreaterThan(0.18);
        } else {
          expect(m.height, name(id)).toBeGreaterThan(0.08); // litter lies low, but stands up off the ground
          expect(Math.max(wide(0), wide(2)), name(id)).toBeGreaterThan(0.3);
        }
      }
    }
  });

  it('the budgets: a bush about a thousand triangles near and a tenth of that far, the grass that grows everywhere tiny, the card four', () => {
    for (const id of KIT_MODEL_IDS) {
      for (const v of variants(id)) {
        const near = /** @type {*} */ (plantMesh(id, PLANT_LOD_NEAR, v));
        const far = /** @type {*} */ (plantMesh(id, PLANT_LOD_FAR, v));
        expect(near.tris, name(id)).toBeLessThanOrEqual(1400);
        expect(far.tris, name(id)).toBeLessThanOrEqual(near.tris);
        expect(far.tris, name(id)).toBeLessThanOrEqual(260);
      }
    }
    for (const id of [B.HONEYBERRY_BUSH, B.NIGHTSHADE_BUSH, B.HAZEL_THICKET, B.CRAB_APPLE_BUSH]) {
      const near = /** @type {*} */ (plantMesh(id, PLANT_LOD_NEAR, 0));
      const far = /** @type {*} */ (plantMesh(id, PLANT_LOD_FAR, 0));
      expect(near.tris, name(id)).toBeGreaterThan(800); // a full bush of leaf cards …
      expect(near.tris / far.tris, name(id)).toBeGreaterThan(5); // … and its leafy far version far cheaper
    }
    expect(/** @type {*} */ (plantMesh(B.TUSSOCK, PLANT_LOD_NEAR, 0)).tris).toBeLessThanOrEqual(80);
    expect(/** @type {*} */ (plantMesh(B.TUSSOCK, PLANT_LOD_FAR, 0)).tris).toBeLessThanOrEqual(12);
    for (const id of [B.FERN, B.MEADOW_DAISIES]) expect(/** @type {*} */ (plantMesh(id, PLANT_LOD_NEAR, 0)).tris, name(id)).toBeLessThanOrEqual(160);
  });

  it('far away a plant is still leafy — never a ball: its leaves reach as wide as the near plant\'s', () => {
    for (const id of [B.HONEYBERRY_BUSH, B.HAZEL_THICKET, B.CRAB_APPLE_BUSH, B.FERN, B.TUSSOCK]) {
      const near = /** @type {*} */ (plantMesh(id, PLANT_LOD_NEAR, 0));
      const far = /** @type {*} */ (plantMesh(id, PLANT_LOD_FAR, 0));
      expect(far.reach / near.reach, name(id)).toBeGreaterThan(0.8);
      expect(far.height / near.height, name(id)).toBeGreaterThan(0.8);
      // its leaves are cards (no solid lump stands for them)
      const leafy = vertsOf(far).filter((x) => /leaf|frond|blade/.test(x.key)).length;
      expect(leafy / far.verts, name(id)).toBeGreaterThan(0.4);
    }
  });

  it('the card is two crossed pictures of the block\'s own tile, from the block atlas, as tall as the plant', () => {
    for (const id of PLANT_IDS) {
      const card = /** @type {*} */ (plantMesh(id, PLANT_LOD_CARD, 0));
      const near = /** @type {*} */ (plantMesh(id, PLANT_LOD_NEAR, 0));
      expect(card.block, name(id)).toBe(true);
      expect(card.tris).toBe(4);
      const [u0, v0, u1, v1] = tileToUV(getFaceTile(id, 6));
      for (const x of vertsOf(card)) expect(x.uv[0] >= u0 - 1e-6 && x.uv[0] <= u1 + 1e-6 && x.uv[1] >= v0 - 1e-6 && x.uv[1] <= v1 + 1e-6).toBe(true);
      expect(card.height, name(id)).toBeGreaterThanOrEqual(near.height - 1e-6); // the picture's plant as tall as the model
    }
    // the litter and the farm keep their FAR model in the far distance
    for (const id of [...LITTER, ...FARM_IDS]) expect(plantMesh(id, PLANT_LOD_CARD, 0), name(id)).toBe(plantMesh(id, PLANT_LOD_FAR, 0));
  });

  it('a picked plant is the same plant less its fruit, vertex for vertex; picked, the Nightshade is the picked Honeyberry', () => {
    const pairs = [
      [B.HAZEL_THICKET, B.HAZEL_THICKET_BARE], [B.CRAB_APPLE_BUSH, B.CRAB_APPLE_BUSH_BARE], [B.HEALWORT_PLANT, B.HEALWORT_PLANT_BARE],
      [B.PRICKLY_PEAR, B.PRICKLY_PEAR_BARE], [B.HONEYBERRY_BUSH, B.HONEYBERRY_BUSH_BARE], [B.NIGHTSHADE_BUSH, B.NIGHTSHADE_BUSH_BARE],
      [B.GROUND_NEST, B.GROUND_NEST_EMPTY],
    ];
    for (const [full, bare] of pairs) {
      expect(plantVariants(bare)).toBe(plantVariants(full));
      for (const v of variants(full)) {
        for (const lod of [PLANT_LOD_NEAR, PLANT_LOD_FAR]) {
          const f = vertsOf(/** @type {*} */ (plantMesh(full, lod, v)));
          const b = vertsOf(/** @type {*} */ (plantMesh(bare, lod, v)));
          const fruit = f.filter((x) => x.fruit);
          expect(fruit.length, name(full)).toBeGreaterThan(0);
          expect(b.some((x) => x.fruit), name(bare)).toBe(false);
          // what is left is the fruiting plant's other vertices, in the same places, in the same order
          const rest = f.filter((x) => !x.fruit);
          expect(b.length, name(bare)).toBe(rest.length);
          b.forEach((x, i) => expect(x.p.map((c) => c.toFixed(5)), name(bare)).toEqual(rest[i].p.map((c) => c.toFixed(5))));
        }
      }
    }
    for (const v of [0, 1]) {
      expect([.../** @type {*} */ (plantMesh(B.NIGHTSHADE_BUSH_BARE, PLANT_LOD_NEAR, v)).data]).toEqual([.../** @type {*} */ (plantMesh(B.HONEYBERRY_BUSH_BARE, PLANT_LOD_NEAR, v)).data]);
    }
  });

  it('the farm: every planted seed is the one seedbed; every sprout is a seedling of its own crop on the same mound', () => {
    const bed = /** @type {*} */ (plantMesh(B.PLANTED_CARROT, PLANT_LOD_NEAR, 0));
    const sprouts = CROP_ROWS.map(([KEY]) => /** @type {*} */ (plantMesh(B[`${KEY}_SPROUT`], PLANT_LOD_NEAR, 0)));
    for (const [KEY] of CROP_ROWS) expect([.../** @type {*} */ (plantMesh(B[`PLANTED_${KEY}`], PLANT_LOD_NEAR, 0)).data]).toEqual([...bed.data]);
    expect(bed.keys).toEqual(expect.arrayContaining(['earth', 'earth.furrow', 'twig', 'rag']));
    // nine sprouts, nine different seedlings, every one on the mound
    const mound = (m) => vertsOf(m).filter((x) => x.key.startsWith('earth')).map((x) => x.p.map((c) => c.toFixed(5)).join()).join(';');
    expect(new Set(sprouts.map(mound)).size).toBe(1); // the same mound under every one …
    expect(mound(sprouts[0])).toBe(mound(bed));
    expect(new Set(sprouts.map((m) => m.keys.join())).size).toBeGreaterThanOrEqual(7); // … then its own leaves
    for (const m of sprouts) {
      expect(m.keys).toContain('earth');
      expect(m.height).toBeGreaterThan(0.18);
    }
    // each sprout grows its own crop's leaves
    const sprout = (KEY) => /** @type {*} */ (plantMesh(B[`${KEY}_SPROUT`], PLANT_LOD_NEAR, 0)).keys;
    expect(sprout('CARROT')).toContain('carrot.frond');
    expect(sprout('ONION')).toContain('onion.leaf');
    expect(sprout('HONEYBERRY')).toEqual(expect.arrayContaining(['honey.leaf0']));
    expect(sprout('HAZEL')).toEqual(expect.arrayContaining(['hazel.leaf0']));
    expect(sprout('HEALWORT')).toEqual(expect.arrayContaining(['heal.leaf0']));
    expect(sprout('PRICKLY_PEAR')).toContain('pear.pad');
    expect(sprout('CATTAILS')).toContain('cattail.leaf');
  });

  it('variants differ, and every model is built the same way every time', () => {
    for (const id of [B.TUSSOCK, B.FERN, B.HONEYBERRY_BUSH]) {
      const a = /** @type {*} */ (plantMesh(id, PLANT_LOD_NEAR, 0));
      const b = /** @type {*} */ (plantMesh(id, PLANT_LOD_NEAR, 1));
      expect([...a.data].join()).not.toBe([...b.data].join());
      const again = /** @type {*} */ (buildPlantModel(id, PLANT_LOD_NEAR, 0));
      expect([...again.data]).toEqual([...a.data]);
    }
    // the flint stones show the flint picture, the plain ones none
    expect(/** @type {*} */ (plantMesh(B.LOOSE_STONES, PLANT_LOD_NEAR, LOOSE_STONES_FLINT)).keys).toContain('flint');
    expect(/** @type {*} */ (plantMesh(B.LOOSE_STONES, PLANT_LOD_NEAR, 0)).keys).not.toContain('flint');
    // a variant number wraps into the model's count
    expect(plantMesh(B.FERN, PLANT_LOD_NEAR, 3)).toBe(plantMesh(B.FERN, PLANT_LOD_NEAR, 0));
  });
});

describe('the furniture\'s box models (§85: compileBoxModel)', () => {
  it('a box is five faces (six with an underside, four with nothing on top), a card one, in metres', () => {
    const side = /** @type {[number, number, number, number]} */ ([2, 3, 4, 5]);
    const one = (part) => {
      const m = compileBoxModel([part]);
      const out = [];
      for (let o = 0; o < m.length; o += BOX_QUAD_STRIDE) out.push({ n: [m[o + 20], m[o + 21], m[o + 22]], y0: m[o + 1] });
      return out;
    };
    const b = one({ kind: 'box', at: [0, 0, 0], size: [4, 8, 2], side });
    expect(b).toHaveLength(5);
    expect(b.map((q) => q.n.map(Math.round))).toEqual([[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0]]);
    expect(one({ kind: 'box', at: [0, 0, 0], size: [4, 8, 2], side, top: null })).toHaveLength(4);
    const u = one({ kind: 'box', at: [0, 4, 0], size: [4, 8, 2], side, under: [0, 0, 1, 1] });
    expect(u).toHaveLength(6);
    expect(u[0].y0).toBeCloseTo(0.25, 6);
    expect(one({ kind: 'card', at: [0, 0, 0], size: [4, 8], side })).toHaveLength(1);
    expect(compileBoxModel([{ kind: 'box', at: [0, 0, 0], size: [2, 2, 2], side, fruit: true }], true)).toHaveLength(0);
  });
});
