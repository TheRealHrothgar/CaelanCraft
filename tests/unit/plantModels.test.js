// Tests for src/plantModels.js — the wild plants as small 3D models (CONTRACTS §78).
import { describe, it, expect } from 'vitest';
import { BLOCK, BLOCKS, TILE, PLANT_IDS, FARM_IDS, FURNITURE_MODEL_IDS, getBlockShape, getFaceTile } from '../../src/blocks.js';
import { FACE_TOP } from '../../src/hex.js';
import { paintTile } from '../../src/tiles.js';
import {
  PLANT_MODELS, PLANT_QUAD_STRIDE, PLANT_TEXELS, CARD_NORMAL_LIFT, compilePlantModel, plantModel, plantModelTile,
} from '../../src/plantModels.js';

const B = BLOCK;
const IDS = Object.keys(PLANT_MODELS).map(Number);
const name = (id) => BLOCKS[id].name;

/** The quads of a compiled model: corners [x, y, z], their texels [u, v], the normal and the shade. */
function quadsOf(model) {
  const out = [];
  for (let o = 0; o < model.length; o += PLANT_QUAD_STRIDE) {
    const p = [];
    const uv = [];
    for (let v = 0; v < 4; v++) {
      p.push([model[o + v * 5], model[o + v * 5 + 1], model[o + v * 5 + 2]]);
      uv.push([model[o + v * 5 + 3], model[o + v * 5 + 4]]);
    }
    out.push({ p, uv, n: [model[o + 20], model[o + 21], model[o + 22]], shade: model[o + 23] });
  }
  return out;
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** The share of opaque texels in the rectangle of `tile` a quad is cut from. */
function opaqueShare(tile, uv) {
  const us = uv.map((t) => t[0]);
  const vs = uv.map((t) => t[1]);
  let seen = 0;
  let total = 0;
  for (let y = Math.min(...vs); y < Math.max(...vs); y++) {
    for (let x = Math.min(...us); x < Math.max(...us); x++) {
      total++;
      if (tile[(y * 16 + x) * 4 + 3] === 255) seen++;
    }
  }
  return seen / total;
}

describe('the plant models (plantModels.js, CONTRACTS §78)', () => {
  it("every 'model' block has a model and every model is such a block's: the 25 wild plants (§81: eight more), the 18 farm blocks (§80) and the 8 pieces of furniture (§85)", () => {
    const shaped = BLOCKS.filter((d) => d.shape === 'model').map((d) => d.id);
    expect(shaped).toEqual(IDS);
    expect(IDS).toHaveLength(51);
    expect(IDS).toEqual([
      B.HONEYBERRY_BUSH, B.HONEYBERRY_BUSH_BARE, B.TUSSOCK, B.CATTAILS, B.TUBER_PLANT, B.PRICKLY_PEAR, B.PRICKLY_PEAR_BARE,
      B.HONEYCAP_MUSHROOM, B.FRECKLECAP_MUSHROOM, B.ONION_PLANT, B.CARROT_PLANT, B.HAZEL_THICKET, B.HAZEL_THICKET_BARE,
      B.CRAB_APPLE_BUSH, B.CRAB_APPLE_BUSH_BARE, B.HEALWORT_PLANT, B.HEALWORT_PLANT_BARE,
      ...FARM_IDS, // the nine planted blocks, then the nine sprouts
      B.FERN, B.MEADOW_DAISIES, B.THISTLE, B.HEMLOCK, B.NIGHTSHADE_BUSH, B.NIGHTSHADE_BUSH_BARE, B.FLAX, B.ALOE, // §81
      B.WELL, B.WELL_DRAWN, B.RAIN_BARREL, B.RAIN_BARREL_1, B.RAIN_BARREL_2, B.RAIN_BARREL_3, B.GRASS_BED, B.BED, // §85
    ]);
    expect([...PLANT_IDS, ...FARM_IDS, ...FURNITURE_MODEL_IDS].sort((a, b) => a - b)).toEqual(IDS);
    for (const id of IDS) {
      expect(getBlockShape(id), name(id)).toBe('model');
      expect(BLOCKS[id].icon, name(id)).toBe('flat'); // the Pack keeps the picture the model is cut from
      const m = plantModel(id);
      expect(m, name(id)).toBeInstanceOf(Float32Array);
      expect(/** @type {Float32Array} */ (m).length % PLANT_QUAD_STRIDE, name(id)).toBe(0);
    }
    expect(plantModel(B.STONE)).toBeNull();
    expect(plantModel(B.LOOSE_STONES)).toBeNull();
    expect(plantModelTile(B.STONE)).toBeNull();
  });

  it('a model stands on the floor inside its cell: real height, real width, never taller than the cell', () => {
    for (const id of IDS) {
      const quads = quadsOf(plantModel(id));
      let lo = Infinity;
      let hi = -Infinity;
      let reach = 0;
      let wide = [Infinity, -Infinity, Infinity, -Infinity];
      for (const q of quads) {
        for (const [x, y, z] of q.p) {
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
          reach = Math.max(reach, Math.hypot(x, z));
          wide = [Math.min(wide[0], x), Math.max(wide[1], x), Math.min(wide[2], z), Math.max(wide[3], z)];
        }
      }
      expect(lo, name(id)).toBeCloseTo(0, 5);
      expect(hi, name(id)).toBeGreaterThan(0.3); // a 3D thing, not a picture on the floor
      expect(hi, name(id)).toBeLessThanOrEqual(0.95); // × MODEL_SCALE_MAX 1.05 it still fits under the cell's roof
      expect(reach, name(id)).toBeLessThanOrEqual(0.54); // the cell is 0.5 to its flats, 0.577 to its corners
      // depth as well as width: at least 0.3 m both ways (the old sprites had none)
      expect(wide[1] - wide[0], name(id)).toBeGreaterThan(0.3);
      expect(wide[3] - wide[2], name(id)).toBeGreaterThan(0.3);
    }
  });

  it('every quad is well formed: a unit normal its winding agrees with, whole texels of the tile, a shade', () => {
    for (const id of IDS) {
      for (const q of quadsOf(plantModel(id))) {
        expect(Math.hypot(...q.n), name(id)).toBeCloseTo(1, 5);
        // counter-clockwise seen from the normal's side: the two-sided cutout material lights that side with it
        expect(dot(cross(sub(q.p[1], q.p[0]), sub(q.p[3], q.p[0])), q.n), name(id)).toBeGreaterThan(0);
        for (const [u, v] of q.uv) {
          expect(Number.isInteger(u) && Number.isInteger(v), name(id)).toBe(true);
          expect(u >= 0 && u <= 16 && v >= 0 && v <= 16, name(id)).toBe(true);
        }
        // a rectangle of texels: corner 0 bottom-left, 1 bottom-right, 2 top-right, 3 top-left (v runs down)
        expect([q.uv[0][0], q.uv[1][1], q.uv[2][0], q.uv[3][1]], name(id)).toEqual([q.uv[3][0], q.uv[0][1], q.uv[1][0], q.uv[2][1]]);
        expect(q.uv[1][0], name(id)).toBeGreaterThan(q.uv[0][0]);
        expect(q.uv[0][1], name(id)).toBeGreaterThan(q.uv[3][1]);
        expect(q.shade, name(id)).toBeGreaterThan(0);
        expect(q.shade, name(id)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('every face shows the plant: cut from texels its tile really paints (no invisible parts, solid boxes mostly solid)', () => {
    for (const id of IDS) {
      const tile = paintTile(plantModelTile(id) ?? getFaceTile(id, FACE_TOP));
      let solid = 0;
      const quads = quadsOf(plantModel(id));
      for (const q of quads) {
        const share = opaqueShare(tile, q.uv);
        expect(share, `${name(id)} ${JSON.stringify(q.uv)}`).toBeGreaterThan(0.3);
        if (share === 1) solid++;
      }
      // most of a model is solid colour; only the leaf cards (and a ragged bush face) are cut-outs
      expect(solid / quads.length, name(id)).toBeGreaterThanOrEqual(0.3);
    }
  });

  it('a picked plant is the same model less its fruit, cut from the picked tile', () => {
    for (const [full, bare] of [
      [B.HAZEL_THICKET, B.HAZEL_THICKET_BARE], [B.CRAB_APPLE_BUSH, B.CRAB_APPLE_BUSH_BARE], [B.HEALWORT_PLANT, B.HEALWORT_PLANT_BARE],
      [B.PRICKLY_PEAR, B.PRICKLY_PEAR_BARE], [B.HONEYBERRY_BUSH, B.HONEYBERRY_BUSH_BARE],
      [B.NIGHTSHADE_BUSH, B.NIGHTSHADE_BUSH_BARE], // §81
    ]) {
      const f = quadsOf(plantModel(full));
      const b = quadsOf(plantModel(bare));
      expect(b.length, name(bare)).toBeLessThan(f.length);
      expect(f.length - b.length, name(bare)).toBeGreaterThanOrEqual(20); // four or more fruit, each a box
      // every quad of the picked plant is a quad of the fruiting one, in the same place
      const key = (q) => q.p.flat().map((c) => c.toFixed(4)).join(',');
      const places = new Set(f.map(key));
      for (const q of b) expect(places.has(key(q)), name(bare)).toBe(true);
      expect(PLANT_MODELS[bare].bare).toBe(true);
      expect(PLANT_MODELS[full].bare).toBeUndefined();
    }
    // the picked honeyberry is cut from the berry-free corner of the BUSH's picture (its own is too sparse to wrap a box)
    // §81: so is the picked Nightshade — it is the picked Honeyberry, quad for quad (the two bushes are the same leaves)
    expect(plantModelTile(B.HONEYBERRY_BUSH_BARE)).toBe(TILE.HONEYBERRY_BUSH);
    expect(plantModelTile(B.NIGHTSHADE_BUSH_BARE)).toBe(TILE.HONEYBERRY_BUSH);
    expect([...plantModel(B.NIGHTSHADE_BUSH_BARE)]).toEqual([...plantModel(B.HONEYBERRY_BUSH_BARE)]);
    const BARE_BUSHES = [B.HONEYBERRY_BUSH_BARE, B.NIGHTSHADE_BUSH_BARE];
    // §85: the well, the rain barrel and the bed are cut from skins of their own (their tile is a picture for the Pack);
    // the grass bed, like a plant, from its own picture
    const SKINNED = { [B.WELL]: TILE.WELL_SKIN, [B.WELL_DRAWN]: TILE.WELL_SKIN, [B.BED]: TILE.BED_SKIN,
      ...Object.fromEntries([B.RAIN_BARREL, B.RAIN_BARREL_1, B.RAIN_BARREL_2, B.RAIN_BARREL_3].map((id) => [id, TILE.RAIN_BARREL_SKIN])) };
    for (const id of IDS) if (!BARE_BUSHES.includes(id)) expect(plantModelTile(id), name(id)).toBe(SKINNED[id] ?? null);
    const violet = (r, g, b) => r > g + 40 && b > g + 70;
    const bush = paintTile(TILE.HONEYBERRY_BUSH);
    for (const q of BARE_BUSHES.flatMap((id) => quadsOf(plantModel(id)))) {
      const us = q.uv.map((t) => t[0]);
      const vs = q.uv.map((t) => t[1]);
      for (let y = Math.min(...vs); y < Math.max(...vs); y++) {
        for (let x = Math.min(...us); x < Math.max(...us); x++) {
          const i = (y * 16 + x) * 4;
          expect(bush[i + 2] > bush[i + 1] + 25 || violet(bush[i], bush[i + 1], bush[i + 2]), `texel ${x},${y}`).toBe(false); // no berry blue
        }
      }
    }
  });

  it('the models stay cheap: the grass that grows everywhere a handful of quads, the rest under eighty', () => {
    const count = (id) => /** @type {Float32Array} */ (plantModel(id)).length / PLANT_QUAD_STRIDE;
    expect(count(B.TUSSOCK)).toBeLessThanOrEqual(12);
    for (const id of IDS) {
      expect(count(id), name(id)).toBeGreaterThanOrEqual(9);
      expect(count(id), name(id)).toBeLessThanOrEqual(80);
    }
  });

  it('compilePlantModel: a box is five faces (six with an underside, four with nothing on top), a card one, in metres', () => {
    const side = /** @type {[number, number, number, number]} */ ([2, 3, 4, 5]);
    const one = (part) => quadsOf(compilePlantModel([part]));
    const b = one({ kind: 'box', at: [0, 0, 0], size: [4, 8, 2], side });
    expect(b).toHaveLength(5);
    expect(b.map((q) => q.n.map(Math.round))).toEqual([[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0]]);
    expect(b[0].p).toEqual([[-0.125, 0, 0.0625], [0.125, 0, 0.0625], [0.125, 0.5, 0.0625], [-0.125, 0.5, 0.0625]]);
    expect(b[0].uv).toEqual([[2, 8], [6, 8], [6, 3], [2, 3]]);
    expect(PLANT_TEXELS).toBe(16);
    expect(one({ kind: 'box', at: [0, 0, 0], size: [4, 8, 2], side, top: null })).toHaveLength(4);
    const u = one({ kind: 'box', at: [0, 4, 0], size: [4, 8, 2], side, under: [0, 0, 1, 1] });
    expect(u).toHaveLength(6);
    expect(u[5].n.map(Math.round)).toEqual([0, -1, 0]);
    expect(u[5].uv[3]).toEqual([0, 0]);
    expect(u[0].p[0][1]).toBeCloseTo(0.25, 6);
    // a card: one picture across z, its top narrowed by `taper`; leaning, its normal is flattened toward a wall's
    const c = one({ kind: 'card', at: [0, 0, 0], size: [4, 8], side, taper: 0.5 });
    expect(c).toHaveLength(1);
    expect(c[0].p).toEqual([[0, 0, -0.125], [0, 0, 0.125], [0, 0.5, 0.0625], [0, 0.5, -0.0625]]);
    expect(c[0].n.map((v) => v + 0)).toEqual([-1, 0, 0]);
    const lean = one({ kind: 'card', at: [0, 0, 0], size: [4, 8], side, lean: Math.PI / 4 })[0];
    expect(lean.p[2][0]).toBeCloseTo(0.5 * Math.SQRT1_2, 6); // its top tips toward +x
    expect(lean.p[2][1]).toBeCloseTo(0.5 * Math.SQRT1_2, 6);
    expect(lean.n[1] / -lean.n[0]).toBeCloseTo(CARD_NORMAL_LIFT, 5);
    // yaw turns a part's +x to (cos yaw, −sin yaw); a group carries its members with it; fruit drops off a bare plant
    const g = one({ kind: 'group', at: [8, 0, 0], yaw: -Math.PI / 2, parts: [{ kind: 'box', at: [2, 0, 0], size: [2, 2, 2], side, fruit: true }] });
    const mid = [0, 1, 2].map((k) => g.flatMap((q) => q.p).reduce((s, p) => s + p[k], 0) / 20);
    expect(mid[0]).toBeCloseTo(0.5, 5);
    expect(mid[2]).toBeCloseTo(0.125, 5);
    expect(compilePlantModel([{ kind: 'box', at: [0, 0, 0], size: [2, 2, 2], side, fruit: true }], true)).toHaveLength(0);
  });
});
