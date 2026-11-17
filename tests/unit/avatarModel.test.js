// avatarModel.js (PURE): the avatars' hex-faceted models, bone by bone over one painted atlas, and the first-person hand
// (CONTRACTS §91.2, §91.4).
import { describe, it, expect } from 'vitest';
import {
  buildAvatarModel, avatarModel, restGeometry, restPlacements, hairGaps, paintAvatar, fpHandFrame, fpStroke, fpHandModel,
  fpDrawnItem, fpClearShift, AVATAR_BONES, AVATAR_ATLAS, HAIR_CUTS, FP_HAND, HEAD_PIVOT,
} from '../../src/avatarModel.js';
import { bounds, triangleCount, mul } from '../../src/modelKit.js';
import { touchClusterRect } from '../../src/touchControls.js';
import { AVATARS, avatarById, avatarHeight } from '../../src/avatars.js';
import { heldItemGeometry } from '../../src/heldItem.js';
import { PLAYER_HEIGHT, FOV } from '../../src/config.js';

/** Edges whose way round is not matched by one the other way (0: a closed surface, every triangle wound alike). */
function unmatchedEdges(g) {
  const key = (i) => `${g.positions[i * 3].toFixed(5)},${g.positions[i * 3 + 1].toFixed(5)},${g.positions[i * 3 + 2].toFixed(5)}`;
  const count = new Map();
  for (let t = 0; t < g.index.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = key(g.index[t + e]);
      const b = key(g.index[t + ((e + 1) % 3)]);
      if (a !== b) count.set(`${a}|${b}`, (count.get(`${a}|${b}`) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [k, n] of count) {
    const [a, b] = k.split('|');
    if ((count.get(`${b}|${a}`) ?? 0) !== n) bad++;
  }
  return bad;
}
/** The signed volume (positive: wound outward). */
function volume(g) {
  let v = 0;
  const p = g.positions;
  for (let t = 0; t < g.index.length; t += 3) {
    const [i, j, k] = [g.index[t] * 3, g.index[t + 1] * 3, g.index[t + 2] * 3];
    v += p[i] * (p[j + 1] * p[k + 2] - p[j + 2] * p[k + 1]) - p[i + 1] * (p[j] * p[k + 2] - p[j + 2] * p[k]) + p[i + 2] * (p[j] * p[k + 1] - p[j + 1] * p[k]);
  }
  return v / 6;
}
/** A point through a column-major matrix. */
const apply = (M, v) => [0, 1, 2].map((a) => M[a] * v[0] + M[4 + a] * v[1] + M[8 + a] * v[2] + M[12 + a]);

describe('the avatars\' models', () => {
  const models = AVATARS.map((def) => buildAvatarModel(def, { parts: true }));

  it('every part of every avatar is a closed solid wound outward', () => {
    for (const m of models) {
      expect(m.parts && m.parts.length, m.id).toBeGreaterThan(20);
      for (const p of /** @type {NonNullable<typeof m.parts>} */ (m.parts)) {
        expect(unmatchedEdges(p.geo), `${m.id} ${p.bone} ${p.key}`).toBe(0);
        expect(volume(p.geo), `${m.id} ${p.bone} ${p.key}`).toBeGreaterThan(0);
      }
      // and so is every bone's geometry as a whole
      for (const b of AVATAR_BONES) {
        const g = m.bones[b];
        if (!g) continue;
        expect(unmatchedEdges(g), `${m.id} ${b}`).toBe(0);
        expect(volume(g), `${m.id} ${b}`).toBeGreaterThan(0);
      }
    }
  });

  it('one geometry per bone: hips, torso, head, each leg, upper arm and forearm (long hair has its own back-hair bone)', () => {
    for (const m of models) {
      for (const b of ['hips', 'torso', 'head', 'legL', 'legR', 'upperL', 'upperR', 'foreL', 'foreR']) {
        expect(m.bones[b] && triangleCount(m.bones[b]), `${m.id} ${b}`).toBeGreaterThan(20);
      }
      expect(!!m.bones.hairBack, m.id).toBe(m.id === 'annabelle');
      // every part hangs from the bone it belongs to: the hair on the head, the shoes on the legs, the hands on the forearms
      const keys = (bone) => new Set((m.parts ?? []).filter((p) => p.bone === bone).map((p) => p.key));
      expect(keys('head').has('head')).toBe(true);
      expect([...keys('head')].some((k) => k.startsWith('hair'))).toBe(true);
      expect(keys('legR').has('shoe') && keys('foreR').has('hand') && keys('torso').has('neck')).toBe(true);
    }
  });

  it('stays within budget (about 1.4k–2.1k triangles, one 256² atlas each) with valid uvs and unit normals', () => {
    for (const m of models) {
      expect(m.tris, m.id).toBeGreaterThan(1200);
      expect(m.tris, m.id).toBeLessThan(2300);
      expect(m.atlas).toEqual([AVATAR_ATLAS, AVATAR_ATLAS]);
      expect(m.image.data.length).toBe(AVATAR_ATLAS * AVATAR_ATLAS * 4);
      expect(m.texels).toBeGreaterThan(20000);
      for (const b of AVATAR_BONES) {
        const g = m.bones[b];
        if (!g) continue;
        expect(g.uvs.every((u) => u >= 0 && u <= 1), `${m.id} ${b}`).toBe(true);
        for (let i = 0; i < g.normals.length; i += 3) expect(Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2])).toBeCloseTo(1, 4);
      }
      expect(m.hairTris, m.id).toBeLessThanOrEqual(900);
    }
  });

  it('stands on its feet, as tall as the avatar (its hair\'s top), Brayden the tallest, Caelan the shortest', () => {
    const tops = {};
    for (const m of models) {
      const def = avatarById(m.id);
      const b = bounds(restGeometry(m));
      expect(b.min[1], m.id).toBeGreaterThan(-0.001);
      expect(b.min[1], m.id).toBeLessThan(0.001);
      expect(b.max[1], m.id).toBeCloseTo(avatarHeight(def), 2);
      expect(m.rig.height, m.id).toBeCloseTo(b.max[1], 6);
      expect(b.max[1], m.id).toBeLessThanOrEqual(PLAYER_HEIGHT);
      expect(b.max[0] - b.min[0], m.id).toBeLessThan(0.8);
      tops[m.id] = b.max[1];
    }
    expect(tops.brayden).toBeGreaterThan(tops.annabelle);
    expect(tops.annabelle).toBeGreaterThan(tops.caelan);
  });

  it('the rig: hips at the top of the legs, shoulders over the torso, the head\'s pivot at its jaw, the grip below the elbow', () => {
    for (const m of models) {
      const def = avatarById(m.id);
      const k = def.scale;
      const r = m.rig;
      expect(r.hipY).toBeCloseTo((def.body.ankle + def.body.leg.len) * k, 9);
      expect(r.hipY + r.shoulder[1]).toBeCloseTo(def.body.shoulder[1] * k, 9);
      expect(r.hipY + r.head[1]).toBeCloseTo((def.head.y + HEAD_PIVOT * def.head.h) * k, 9);
      expect(r.elbow[1]).toBeLessThan(-0.15);
      expect(r.grip[1]).toBeLessThan(-0.2); // the fist is a forearm's length under the elbow …
      expect(r.grip[2]).toBeLessThan(0); // … a little ahead of it
      expect(r.lieY).toBeGreaterThan(0.1);
      expect(r.lieY).toBeLessThan(0.25);
      // the bones' rest places put the right fist where the rig says
      const place = restPlacements(r);
      expect(place.foreR[13]).toBeCloseTo(r.hipY + r.shoulder[1] + r.elbow[1], 9);
    }
  });

  it('paints the same atlas every time, a different one for each avatar', () => {
    const a = paintAvatar(AVATARS[2]).pack().atlas.img.data;
    const b = paintAvatar(AVATARS[2]).pack().atlas.img.data;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(models[0].image.data).equals(Buffer.from(models[1].image.data))).toBe(false);
  });

  it('builds once per definition (shared by every renderer)', () => {
    expect(avatarModel(AVATARS[1])).toBe(avatarModel(AVATARS[1]));
    expect(avatarModel(AVATARS[1])).not.toBe(avatarModel(AVATARS[0]));
  });

  it('two hair cuts per style, every one within 900 triangles and none letting the skull show; a wrong cut is refused', () => {
    for (const def of AVATARS) {
      const cuts = Object.keys(HAIR_CUTS).filter((c) => HAIR_CUTS[c].style === def.hair.style);
      expect(cuts, def.id).toHaveLength(2);
      for (const cut of cuts) {
        const m = buildAvatarModel(def, { cut });
        expect(m.cut).toBe(cut);
        expect(m.hairTris).toBeGreaterThan(100);
        expect(m.hairTris).toBeLessThanOrEqual(900);
        expect(hairGaps(def, cut), `${def.id} ${cut}`).toBe(0);
      }
    }
    expect(() => buildAvatarModel(AVATARS[0], { cut: 'B1' })).toThrow(RangeError);
    expect(() => buildAvatarModel(AVATARS[0], { cut: 'Z9' })).toThrow(RangeError);
  });

  it('long hair reaches far down the back; Brayden\'s stays short', () => {
    const lowestBehind = (m) => {
      const def = avatarById(m.id);
      const g = restGeometry(m);
      let lo = Infinity;
      for (let i = 0; i < g.positions.length; i += 3) {
        if (g.positions[i + 2] > def.head.rz * def.scale + 0.02 && g.positions[i + 1] > 0.9) lo = Math.min(lo, g.positions[i + 1]);
      }
      return lo;
    };
    const [, brayden, annabelle] = models;
    expect(lowestBehind(annabelle)).toBeLessThan(AVATARS[2].head.y * AVATARS[2].scale - 0.25);
    expect(lowestBehind(brayden)).toBeGreaterThan(AVATARS[1].head.y * AVATARS[1].scale - 0.15);
  });
});

describe('the first-person hand', () => {
  const t = Math.tan(((FOV / 2) * Math.PI) / 180);
  /** where a camera-space point lands in the view: −1..1 across (aspect 16:10) and up */
  const ndc = (p) => [p[0] / -p[2] / (t * 1.6), p[1] / -p[2] / t];

  it('its tunables are one frozen constant: the fist low at the right, ahead of the eye; a chop and a bob', () => {
    expect(Object.isFrozen(FP_HAND)).toBe(true);
    const [x, y] = ndc(FP_HAND.grip);
    expect(x).toBeGreaterThan(0.2); // right of the middle …
    expect(x).toBeLessThan(0.7);
    expect(y).toBeLessThan(-0.4); // … in the lower part of the view …
    expect(y).toBeGreaterThan(-0.9); // … but not off it
    expect(FP_HAND.grip[2]).toBeLessThan(-0.3);
    expect(FP_HAND.toolScale).toBeLessThan(0.7); // a modest tool: seen from half a metre
    expect(FP_HAND.handScale).toBeLessThanOrEqual(1);
    for (const k of ['swingArm', 'swingWrist', 'deviate', 'deviateEmpty', 'bob', 'forearm']) expect(Number.isFinite(FP_HAND[k]), k).toBe(true);
  });

  it('shows the fist, the wrist and a pushed-up sleeve\'s cuff on screen', () => {
    const f = fpHandFrame(0);
    for (const def of AVATARS.filter((a) => a.outfit.cuffAt)) {
      const cuff = apply(f.arm, [0.004, 0, 0.045 + 0.235 * /** @type {number} */ (def.outfit.cuffAt)]);
      const [x, y] = ndc(cuff);
      expect(x, def.id).toBeLessThan(1);
      expect(y, def.id).toBeGreaterThan(-1);
    }
    const [fx, fy] = ndc(apply(f.hand, [0, 0, 0]));
    expect(fx).toBeGreaterThan(0);
    expect(fy).toBeLessThan(-0.3);
  });

  it('its forearm is dressed as the model\'s: a pushed-up sleeve past its cuff, bare under a short sleeve', () => {
    for (const def of AVATARS) {
      const s = paintAvatar(def).pack();
      const img = s.atlas.img;
      /** the hue of a row of a skin's strip (its mean colour's share of each channel; row 0: the elbow's end) */
      const row = (key, y) => {
        const [rx, ry, rw] = /** @type {*} */ (s.entries.get(key)).jobs[0].rect;
        const sum = [0, 0, 0];
        for (let x = 0; x < rw; x++) for (let c = 0; c < 3; c++) sum[c] += img.data[((ry + y) * img.width + rx + x) * 4 + c];
        return sum.map((v) => v / (sum[0] + sum[1] + sum[2]));
      };
      const rows = (key) => /** @type {*} */ (s.entries.get(key)).jobs[0].rect[3];
      // cloth at the elbow's end: its hue is not the skin's at the wrist (shading at a joint keeps the hue)
      const clothed = (key) => {
        const elbow = row(key, 0);
        const wrist = row(key, rows(key) - 1);
        return Math.hypot(elbow[0] - wrist[0], elbow[1] - wrist[1], elbow[2] - wrist[2]) > 0.05;
      };
      expect(clothed('fpArm'), def.id).toBe(clothed('foreArm')); // the two drawings of the forearm agree …
      expect(clothed('fpArm'), def.id).toBe(Boolean(def.outfit.cuffAt)); // … a sleeve only where it is pushed up
      // a cuff ring only on a pushed-up sleeve
      expect(s.entries.has('cuff'), def.id).toBe(Boolean(def.outfit.cuffAt));
    }
  });

  it('§100 the draw: a bow comes up before the eye, upright, never edge-on on the way; a throw is cocked high, its point ahead', () => {
    const m = avatarModel(AVATARS[0]);
    const rest = fpHandFrame(0);
    /** how squarely the item's picture faces the eye (1: face on, 0: edge on) */
    const facing = (hand) => {
      const it = mul(hand, m.fp.tool);
      const z = [it[8], it[9], it[10]];
      const p = [it[12], it[13], it[14]];
      return Math.abs(z[0] * p[0] + z[1] * p[1] + z[2] * p[2]) / Math.hypot(...z) / Math.hypot(...p);
    };
    const fist = (f) => [f.hand[12], f.hand[13], f.hand[14]];
    const dist = (p) => Math.hypot(p[0], p[1], p[2]);
    for (const bow of [true, false]) {
      const full = fpHandFrame(0, false, 1, bow);
      // pulled up and back toward the eye, still at the right
      expect(fist(full)[1], `bow ${bow}`).toBeGreaterThan(fist(rest)[1] + 0.05);
      expect(dist(fist(full)), `bow ${bow}`).toBeLessThan(dist(fist(rest)) - 0.05);
      expect(ndc(fist(full))[0], `bow ${bow}`).toBeGreaterThan(0.15);
      // the forearm still leaves the view at the lower right (its way to the elbow: right and down)
      expect(full.arm[8], `bow ${bow}`).toBeGreaterThan(0.25);
      expect(full.arm[9], `bow ${bow}`).toBeLessThan(-0.1);
      // the held item where fpDrawnItem puts it; between, the frames are blended (the fist on the line between)
      const item = fpDrawnItem(bow);
      const at = mul(full.hand, m.fp.tool);
      for (const c of [0, 4, 8]) {
        const n = Math.hypot(at[c], at[c + 1], at[c + 2]);
        for (let k = 0; k < 3; k++) expect(at[c + k] / n, `bow ${bow} axis ${c}`).toBeCloseTo(item[c + k], 6);
      }
      const half = fist(fpHandFrame(0, false, 0.5, bow));
      for (let k = 0; k < 3; k++) expect(half[k]).toBeCloseTo((fist(rest)[k] + fist(full)[k]) / 2, 1);
      // an empty hand draws nothing
      expect(Array.from(fpHandFrame(0, true, 1, bow).arm)).toEqual(Array.from(fpHandFrame(0, true).arm));
    }
    // the bow: at rest it leans away like a tool; drawn, its limbs (the picture's x) stand in the view's plane, canted no
    // more than FP_HAND.drawBow.cant from upright, and it faces the eye squarely; never edge-on on the way up
    const bowAt = (d) => mul(fpHandFrame(0, false, d, true).hand, m.fp.tool);
    const limbs = (M) => [M[0], M[1], M[2]].map((v) => v / Math.hypot(M[0], M[1], M[2]));
    expect(Math.abs(limbs(bowAt(0))[2])).toBeGreaterThan(0.2);
    expect(Math.abs(limbs(bowAt(1))[2])).toBeLessThan(0.05);
    expect(Math.atan2(Math.abs(limbs(bowAt(1))[0]), Math.abs(limbs(bowAt(1))[1]))).toBeLessThan(FP_HAND.drawBow.cant + 0.05);
    expect(facing(fpHandFrame(0, false, 1, true).hand)).toBeGreaterThan(0.85);
    for (let d = 0; d <= 1.0001; d += 0.05) expect(facing(fpHandFrame(0, false, d, true).hand), `draw ${d}`).toBeGreaterThan(0.5);
    // the throw: its length (the picture's +y) ahead and up, its face turned to the eye at full draw
    const spear = mul(fpHandFrame(0, false, 1, false).hand, m.fp.tool);
    const len = Math.hypot(spear[4], spear[5], spear[6]);
    expect(spear[6] / len).toBeLessThan(-0.6);
    expect(spear[5] / len).toBeGreaterThan(0.15);
    expect(facing(fpHandFrame(0, false, 1, false).hand)).toBeGreaterThan(0.6);
  });

  it('§95 on a tablet the fist keeps clear of the right cluster of buttons, landscape or portrait; a desktop is untouched', () => {
    for (const [w, h] of [[1024, 768], [768, 1024], [1180, 820], [1366, 1024], [820, 1180]]) {
      const box = touchClusterRect(w, h);
      const clear = { left: (2 * box.left) / w - 1, top: 1 - (2 * box.top) / h };
      const aspect = w / h;
      const dx = fpClearShift(clear, aspect, FOV);
      const g = FP_HAND.grip;
      const t = Math.tan(((FOV / 2) * Math.PI) / 180);
      // the fist's centre on the screen (CSS px), with the move
      const sx = ((((g[0] + dx) / -g[2]) / (t * aspect) + 1) / 2) * w;
      const sy = ((1 - (g[1] / -g[2]) / t) / 2) * h;
      const inside = sx >= box.left && sx <= box.right && sy >= box.top && sy <= box.bottom;
      expect(inside, `${w}x${h}`).toBe(false);
      expect(sx, `${w}x${h}`).toBeLessThan(box.left); // left of it (never pushed off the bottom)
      expect(sx, `${w}x${h}`).toBeGreaterThan(w / 2); // still right of the middle
      expect(sy, `${w}x${h}`).toBeGreaterThan(h / 2); // still low
      // without the move the fist would sit among the buttons (or the move is not needed)
      const bare = ((g[0] / -g[2] / (t * aspect) + 1) / 2) * w;
      if (dx < 0) expect(bare, `${w}x${h}`).toBeGreaterThan(box.left - ((FP_HAND.touchGap * w) / 2) - 1);
    }
    expect(fpClearShift(null, 1.6, FOV)).toBe(0); // a desktop
    expect(fpClearShift({ left: 0.95, top: -0.2 }, 1.6, FOV)).toBe(0); // buttons far off at the edge: nothing to do
  });

  it('the chop: wrist-led, the fist coming down and ahead, back at rest after the swing', () => {
    const rest = fpHandFrame(0);
    const low = fpHandFrame(1);
    expect(low.hand[13]).toBeLessThan(rest.hand[13]);
    expect(low.hand[14]).toBeLessThan(rest.hand[14]);
    expect(low.hand[6]).toBeLessThan(rest.hand[6]); // the haft tips forward (its +y gains −z)
    // the wrist does more of it than the forearm: the haft turns further than the forearm does
    const turn = (M, N, c) => Math.acos(Math.max(-1, Math.min(1, M[c] * N[c] + M[c + 1] * N[c + 1] + M[c + 2] * N[c + 2])));
    expect(turn(rest.hand, low.hand, 4)).toBeGreaterThan(turn(rest.arm, low.arm, 8));
    // quiet: the fist moves less than a tenth of a metre
    expect(Math.hypot(low.hand[12] - rest.hand[12], low.hand[13] - rest.hand[13], low.hand[14] - rest.hand[14])).toBeLessThan(0.1);
    expect(fpStroke(-1)).toBe(0);
    expect(fpStroke(0)).toBe(0);
    expect(fpStroke(0.3)).toBeGreaterThan(0.9);
    expect(fpStroke(1)).toBe(0);
    // an empty hand is held with a straighter wrist
    expect(fpHandFrame(0, true).hand[6]).not.toBeCloseTo(rest.hand[6], 3);
  });

  it('its parts are closed, over the avatar\'s atlas; the fist grips (fingers round the haft) or opens', () => {
    for (const def of AVATARS) {
      const m = avatarModel(def);
      for (const k of ['arm', 'grip', 'relaxed']) {
        expect(unmatchedEdges(m.fp[k]), `${def.id} ${k}`).toBe(0);
        expect(volume(m.fp[k]), `${def.id} ${k}`).toBeGreaterThan(0);
        expect(m.fp[k].uvs.every((u) => u >= 0 && u <= 1)).toBe(true);
      }
      expect(triangleCount(m.fp.arm) + triangleCount(m.fp.grip)).toBeLessThan(500);
      // gripping: the fingertips come back round the haft (behind its line, +z); open: they stay ahead of it (−z)
      const tipZ = (g) => {
        let z = -Infinity;
        for (let i = 0; i < g.positions.length; i += 3) if (g.positions[i] < -0.01) z = Math.max(z, g.positions[i + 2]);
        return z;
      };
      expect(tipZ(m.fp.grip)).toBeGreaterThan(0.01);
      expect(tipZ(m.fp.relaxed)).toBeLessThan(tipZ(m.fp.grip));
    }
  });

  it('holds a tool at the fist, its haft along the hand and up out of it, its picture turned toward the eye', () => {
    const m = avatarModel(AVATARS[0]);
    const model = fpHandModel(AVATARS[0]);
    const f = fpHandFrame(0);
    for (let k = 12; k < 15; k++) expect(model.tool[k]).toBeCloseTo(f.hand[k], 9); // the slab's grip is the fist
    expect(m.fp.tool[5]).toBeGreaterThan(0.3); // its +y runs along the haft (the hand's +y)
    const slab = /** @type {NonNullable<ReturnType<typeof heldItemGeometry>>} */ (heldItemGeometry('iron_pick'));
    let top = [0, 0, 0];
    for (let i = 0; i < slab.positions.length; i += 3) if (slab.positions[i + 1] > top[1]) top = [slab.positions[i], slab.positions[i + 1], slab.positions[i + 2]];
    const head = ndc(apply(model.tool, top));
    expect(head[1]).toBeLessThan(0); // the pick's head stays in the lower half of the view: visible but quiet
    expect(head[1]).toBeGreaterThan(ndc(apply(f.hand, [0, 0, 0]))[1]); // above the fist
    // a lump stands at the fist facing the eye
    const lump = apply(f.hand, apply(m.fp.lump, [0, 0, 0]));
    expect(Math.hypot(lump[0] - f.hand[12], lump[1] - f.hand[13], lump[2] - f.hand[14])).toBeLessThan(0.1);
  });
});
