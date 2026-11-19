// Tests for src/plantModels.js — every plant as a hex-faceted kit model on the plant atlas, in three levels of detail
// (CONTRACTS §105), and the furniture's box models (§85).
import { describe, it, expect } from 'vitest';
import {
  BLOCK, BLOCKS, PLANT_IDS, FARM_IDS, FURNITURE_MODEL_IDS, CROP_ROWS, getBlockShape,
} from '../../src/blocks.js';
import {
  KIT_MODEL_IDS, PLANT_LOD_NEAR, PLANT_LOD_FAR, PLANT_LOD_CARD, PLANT_STRIDE, LOOSE_STONES_FLINT, isKitModel, plantMesh,
  plantVariants, buildPlantModel, FURNITURE_MODELS, BOX_QUAD_STRIDE, compileBoxModel, furnitureModel, plantCardSlot,
  plantAtlasImage, cardLightRatio,
} from '../../src/plantModels.js';
import {
  plantRect, plantCardRect, paintPlantAtlas, PLANT_ATLAS_W, PLANT_ATLAS_H, PLANT_CARD_SLOTS, PLANT_CARD_PX, PLANT_CARD_TOP,
  PLANT_ATLAS_PAD,
} from '../../src/plantAtlas.js';
import { FAR_LEAF_LONGER, FAR_LEAF_WIDER, farLeafGrowth } from '../../src/plantKit.js';

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

describe('the kit models (plantModels.js, CONTRACTS §105)', () => {
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

  it('far away a plant keeps its near size and shape: FAR reach and height within 10 % of NEAR, for every model', () => {
    // the thinned whorls and sprays grow their leaves WIDER rather than longer (farLeafGrowth), a spray keeps its tip's
    // leaf, and a recipe draws its random numbers near and far alike: no plant changes size crossing PLANT_NEAR_M
    const extent = (m) => {
      let r = 0;
      let h = 0;
      for (const x of vertsOf(m)) {
        r = Math.max(r, Math.hypot(x.p[0], x.p[2]));
        h = Math.max(h, x.p[1]);
      }
      return [r, h];
    };
    for (const id of KIT_MODEL_IDS) {
      for (const v of variants(id)) {
        const [rn, hn] = extent(plantMesh(id, PLANT_LOD_NEAR, v));
        const [rf, hf] = extent(plantMesh(id, PLANT_LOD_FAR, v));
        expect(Math.abs(rf / rn - 1), `${name(id)} #${v} reach ${rn.toFixed(2)} → ${rf.toFixed(2)}`).toBeLessThanOrEqual(0.1);
        expect(Math.abs(hf / hn - 1), `${name(id)} #${v} height ${hn.toFixed(2)} → ${hf.toFixed(2)}`).toBeLessThanOrEqual(0.1);
      }
    }
    // a far leaf standing for f near ones: a little longer at most, the rest of their area in its width, never a disc
    expect(farLeafGrowth(1)).toEqual([1, 1]);
    for (const f of [2, 3, 4, 6]) {
      const [gl, gw] = farLeafGrowth(f);
      expect(gl).toBeLessThanOrEqual(FAR_LEAF_LONGER);
      expect(gw).toBeLessThanOrEqual(FAR_LEAF_WIDER);
      expect(gw).toBeGreaterThan(gl);
    }
  });

  it('the card is two crossed pictures of the plant itself, from its own slot of the PLANT atlas, as big as the plant', () => {
    const cardIds = KIT_MODEL_IDS.filter((id) => plantCardSlot(id) >= 0);
    expect(cardIds.length).toBe(PLANT_IDS.length); // every wild plant, ripe or picked
    expect(cardIds.length).toBeLessThanOrEqual(PLANT_CARD_SLOTS);
    expect(new Set(cardIds.map(plantCardSlot)).size).toBe(cardIds.length); // a slot each
    for (const id of cardIds) {
      const card = /** @type {*} */ (plantMesh(id, PLANT_LOD_CARD, 0));
      const near = /** @type {*} */ (plantMesh(id, PLANT_LOD_NEAR, 0));
      expect(card.tris).toBe(4);
      expect(card.verts).toBe(8);
      const [rx, ry, rw, rh] = plantCardRect(plantCardSlot(id));
      for (const x of vertsOf(card)) {
        // plant-atlas uvs (the mesher moves them PLANT_UV_OFFSET along u, so the shader never turns their normal round)
        const u = x.uv[0] * PLANT_ATLAS_W;
        const v = x.uv[1] * PLANT_ATLAS_H;
        expect(u >= rx - 1e-3 && u <= rx + rw + 1e-3 && v >= ry - 1e-3 && v <= ry + rh + 1e-3, name(id)).toBe(true);
        expect(x.n).toEqual([0, 1, 0]); // lit like a top face, from both sides alike
        expect(x.shade).toBe(1); // the picture carries the plant's shade
        expect(x.p[1]).toBeGreaterThanOrEqual(0);
      }
      // the picture's plant is the model's size: as tall (a pixel more) and no wider
      expect(card.height, name(id)).toBeGreaterThanOrEqual(near.height - 1e-6);
      expect(card.height, name(id)).toBeLessThan(near.height * 1.1 + 0.02);
      expect(card.reach, name(id)).toBeLessThanOrEqual(near.reach + 0.03);
      expect(card.reach, name(id)).toBeGreaterThan(near.reach * 0.5);
    }
    // the litter and the farm keep their FAR model in the far distance, and have no card
    for (const id of [...LITTER, ...FARM_IDS]) {
      expect(plantMesh(id, PLANT_LOD_CARD, 0), name(id)).toBe(plantMesh(id, PLANT_LOD_FAR, 0));
      expect(plantCardSlot(id), name(id)).toBe(-1);
    }
    // the slots are a grid of their own below every packed picture, a gutter round each
    for (let i = 0; i < PLANT_CARD_SLOTS; i++) {
      const [x, y, w, h] = plantCardRect(i);
      expect([w, h]).toEqual([PLANT_CARD_PX, PLANT_CARD_PX]);
      expect(y - PLANT_ATLAS_PAD).toBeGreaterThanOrEqual(PLANT_CARD_TOP);
      expect(x + w + PLANT_ATLAS_PAD <= PLANT_ATLAS_W && y + h + PLANT_ATLAS_PAD <= PLANT_ATLAS_H).toBe(true);
    }
    expect(() => plantCardRect(PLANT_CARD_SLOTS)).toThrow(RangeError);
  });

  it('a card\'s picture is the plant painted from the atlas: a leafy cut-out in its own colours, a clear margin round it', () => {
    const img = plantAtlasImage();
    expect(plantAtlasImage()).toBe(img); // cached
    const base = paintPlantAtlas();
    expect(img).not.toBe(base); // the pictures' own image is left as it was …
    const [bx, by, bw, bh] = plantRect('honey.leaf0');
    for (let y = by; y < by + bh; y += 3) {
      for (let x = bx; x < bx + bw; x += 3) expect(img.data[(y * PLANT_ATLAS_W + x) * 4 + 1]).toBe(base.data[(y * PLANT_ATLAS_W + x) * 4 + 1]); // … and copied
    }
    const at = (x, y) => [...img.data.slice((y * PLANT_ATLAS_W + x) * 4, (y * PLANT_ATLAS_W + x) * 4 + 4)];
    for (const id of KIT_MODEL_IDS.filter((i) => plantCardSlot(i) >= 0)) {
      const [x0, y0, w, h] = plantCardRect(plantCardSlot(id));
      let opaque = 0;
      let g = 0;
      let rb = 0;
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const [r, gg, b, a] = at(x, y);
          expect(a === 0 || a === 255, name(id)).toBe(true); // a cut-out, as the alpha test sees it
          if (a === 0) continue;
          opaque++;
          g += gg;
          rb += (r + b) / 2;
        }
      }
      expect(opaque / (w * h), name(id)).toBeGreaterThan(0.015);
      expect(opaque / (w * h), name(id)).toBeLessThan(0.75); // see-through: leaves with gaps, never a solid blob
      // a clear margin round it: the quad's edges never show a frame
      for (let k = 0; k < w; k++) {
        expect(at(x0 + k, y0)[3], name(id)).toBe(0);
        expect(at(x0, y0 + k)[3], name(id)).toBe(0);
        expect(at(x0 + w - 1, y0 + k)[3], name(id)).toBe(0);
      }
      // a green plant's card is green
      if ([B.HONEYBERRY_BUSH, B.HAZEL_THICKET, B.CRAB_APPLE_BUSH, B.FERN, B.TUSSOCK, B.NIGHTSHADE_BUSH].includes(id)) {
        expect(g / opaque, name(id)).toBeGreaterThan(rb / opaque + 15);
      }
    }
    // the light it is baked for: a face looking up is lit as the card is (1), one turned from the sky darker
    expect(cardLightRatio(1)).toBeCloseTo(1, 6);
    expect(cardLightRatio(0)).toBeLessThan(0.75);
    expect(cardLightRatio(-1)).toBeLessThan(cardLightRatio(0));
    expect(cardLightRatio(-1)).toBeGreaterThan(0);
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
