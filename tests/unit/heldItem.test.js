// heldItem.js (PURE): the item in hand, extruded from its pixel art into a slab one pixel thick, held as its pixels say.
import { describe, it, expect } from 'vitest';
import {
  extrudeItemArt, heldGrip, heldItemGeometry, heldItemShown, heldWielded, srgbByteToLinear,
  HELD_PIXEL, HELD_LUMP_SCALE, HELD_GRIP_IN,
} from '../../src/heldItem.js';
import { ITEM_ART_KEYS, ITEM_ART_SIZE, paintItem, toolArtOf } from '../../src/itemArt.js';
import { ITEMS, ITEM_KEYS } from '../../src/items.js';
import { ARROW_KEYS } from '../../src/looseItems.js';

/** A size × size picture with these solid pixels ([x, y, r, g, b]); everything else clear. */
function art(size, pixels) {
  const px = new Uint8ClampedArray(size * size * 4);
  for (const [x, y, r = 200, g = 100, b = 50] of pixels) px.set([r, g, b, 255], (y * size + x) * 4);
  return px;
}

const quadsOf = (slab) => slab.positions.length / 18;
const vert = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];

/** The slab's faults: triangles that wind against their normal, and edges not shared by exactly one opposite pair. */
function slabFaults(slab) {
  const faults = [];
  const n = slab.positions.length / 9;
  const key = (p) => p.map((v) => Math.round(v * 1e5)).join(',');
  /** @type {Map<string, number>} directed edge → count */
  const edges = new Map();
  for (let t = 0; t < n; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => vert(slab.positions, t * 3 + k));
    const nn = vert(slab.normals, t * 3);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (cross[0] * nn[0] + cross[1] * nn[1] + cross[2] * nn[2] <= 0) faults.push(`triangle ${t} winds against its normal`);
    if (Math.abs(Math.hypot(...nn) - 1) > 1e-6) faults.push(`triangle ${t} normal not unit`);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = `${key(p)}>${key(q)}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  // a closed, consistently wound surface: each directed edge's reverse appears as often as it does (a quad's own
  // diagonal is one such pair)
  for (const [k, count] of edges) {
    const [p, q] = k.split('>');
    if ((edges.get(`${q}>${p}`) ?? 0) !== count) faults.push(`open edge ${k}`);
  }
  return faults;
}

describe('extrudeItemArt', () => {
  it('a single pixel is a closed cube of 6 quads, one pixel on a side, its grip point at the origin', () => {
    const slab = extrudeItemArt(art(8, [[3, 4]]), 8, { pixel: 0.1, grip: [3.5, 4.5] });
    expect(quadsOf(slab)).toBe(6);
    expect(slab.positions.length).toBe(6 * 6 * 3);
    expect(slab.normals.length).toBe(slab.positions.length);
    expect(slab.colors.length).toBe(slab.positions.length);
    for (let i = 0; i < slab.positions.length; i++) expect(Math.abs(slab.positions[i])).toBeCloseTo(0.05, 6);
    // one quad (6 vertices) facing each way
    const facing = new Map();
    for (let i = 0; i < slab.normals.length / 3; i++) {
      const k = vert(slab.normals, i).map((v) => Math.round(v)).join(',');
      facing.set(k, (facing.get(k) ?? 0) + 1);
    }
    expect([...facing.keys()].sort()).toEqual(['-1,0,0', '0,-1,0', '0,0,-1', '0,0,1', '0,1,0', '1,0,0']);
    expect([...facing.values()]).toEqual([6, 6, 6, 6, 6, 6]);
    expect(slabFaults(slab)).toEqual([]);
  });

  it('two neighbouring pixels share no inner side faces (across or down), and stay closed', () => {
    for (const pair of [[[2, 2], [3, 2]], [[2, 2], [2, 3]]]) {
      const slab = extrudeItemArt(art(6, pair), 6, { pixel: 1, grip: [0, 0] });
      expect(quadsOf(slab)).toBe(10); // 2 fronts, 2 backs, 6 sides
      expect(slabFaults(slab)).toEqual([]);
      // no side face on the plane between them
      const across = pair[1][0] !== pair[0][0];
      const plane = across ? 3 : -3; // x = 3 between columns 2 and 3; y = −3 between rows 2 and 3
      for (let i = 0; i < slab.normals.length / 3; i++) {
        const nn = vert(slab.normals, i);
        const p = vert(slab.positions, i);
        const sideNormal = across ? Math.abs(nn[0]) : Math.abs(nn[1]);
        const onPlane = across ? Math.abs(p[0] - plane) < 1e-9 : Math.abs(p[1] - plane) < 1e-9;
        expect(sideNormal > 0.5 && onPlane, `vertex ${i}`).toBe(false);
      }
    }
    // a pixel diagonal to another still has all its sides
    expect(quadsOf(extrudeItemArt(art(6, [[2, 2], [3, 3]]), 6))).toBe(12);
    // the picture's edge counts as empty
    expect(quadsOf(extrudeItemArt(art(2, [[0, 0], [1, 0], [0, 1], [1, 1]]), 2))).toBe(4 * 2 + 8);
  });

  it('the picture stands upright (row 0 at the top), one pixel thick; turn spins it about the grip', () => {
    const slab = extrudeItemArt(art(4, [[1, 0], [1, 1]]), 4, { pixel: 0.5, grip: [1.5, 2] });
    let minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < slab.positions.length / 3; i++) {
      const [, y, z] = vert(slab.positions, i);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    expect([minY, maxY]).toEqual([0, 1]); // rows 0–1 stand on the grip at row 2
    expect([minZ, maxZ]).toEqual([-0.25, 0.25]);
    const turned = extrudeItemArt(art(4, [[1, 0], [1, 1]]), 4, { pixel: 0.5, grip: [1.5, 2], turn: Math.PI / 2 });
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < turned.positions.length / 3; i++) {
      minX = Math.min(minX, turned.positions[i * 3]);
      maxX = Math.max(maxX, turned.positions[i * 3]);
    }
    expect(minX).toBeCloseTo(-1, 9); // a quarter turn counter-clockwise: up becomes left
    expect(maxX).toBeCloseTo(0, 9);
    expect(slabFaults(turned)).toEqual([]);
  });

  it('colours are the pixels\' sRGB bytes made linear, on every vertex of the pixel', () => {
    expect(srgbByteToLinear(0)).toBe(0);
    expect(srgbByteToLinear(255)).toBeCloseTo(1, 6);
    expect(srgbByteToLinear(128)).toBeCloseTo(0.2158605, 5);
    expect(srgbByteToLinear(10)).toBeCloseTo(10 / 255 / 12.92, 9);
    const slab = extrudeItemArt(art(3, [[1, 1, 255, 128, 0]]), 3);
    for (let i = 0; i < slab.colors.length / 3; i++) {
      const [r, g, b] = vert(slab.colors, i);
      expect(r).toBeCloseTo(1, 6);
      expect(g).toBeCloseTo(0.2158605, 5);
      expect(b).toBe(0);
    }
  });

  it('only pixels with alpha over 127 are solid; an empty picture gives empty arrays', () => {
    const px = art(4, [[0, 0], [2, 2]]);
    px[(2 * 4 + 2) * 4 + 3] = 127;
    expect(quadsOf(extrudeItemArt(px, 4))).toBe(6);
    const empty = extrudeItemArt(new Uint8ClampedArray(16 * 16 * 4), 16);
    expect(empty.positions.length).toBe(0);
    expect(empty.normals.length).toBe(0);
    expect(empty.colors.length).toBe(0);
    expect(heldGrip(new Uint8ClampedArray(16 * 16 * 4), 16, { wielded: true })).toEqual({
      style: 'lump', grip: [8, 8], turn: 0, pixel: HELD_PIXEL * HELD_LUMP_SCALE,
    });
  });
});

describe('how a picture is held (heldGrip)', () => {
  it('a hafted picture is gripped HELD_GRIP_IN pixels in from the end of its haft, its bulk turned straight ahead', () => {
    // a T: a 2-wide haft (rows 4–15) under a 10-wide head (rows 0–3)
    const pixels = [];
    for (let y = 0; y < 4; y++) for (let x = 3; x < 13; x++) pixels.push([x, y]);
    for (let y = 4; y < 16; y++) for (const x of [7, 8]) pixels.push([x, y]);
    const tee = art(16, pixels);
    const up = heldGrip(tee, 16, { wielded: true });
    expect(up).toEqual({ style: 'tool', grip: [8, 16 - HELD_GRIP_IN], turn: 0, pixel: HELD_PIXEL });
    // the same picture held by its other end (a shovel's handle is at the top): turned end over end
    const flipped = heldGrip(tee, 16, { wielded: true, handleTop: true });
    expect(flipped.style).toBe('lump'); // the head is no haft
    // not wielded: held at the middle of its pixels, smaller
    const lump = heldGrip(tee, 16, { wielded: false });
    expect(lump.style).toBe('lump');
    expect(lump.grip[0]).toBeCloseTo(8, 9);
    expect(lump.pixel).toBeCloseTo(HELD_PIXEL * HELD_LUMP_SCALE, 12);
    // and its grip lands at the origin of the slab
    const slab = extrudeItemArt(tee, 16, up);
    let minY = Infinity;
    for (let i = 0; i < slab.positions.length / 3; i++) minY = Math.min(minY, slab.positions[i * 3 + 1]);
    expect(minY).toBeCloseTo(-HELD_GRIP_IN * HELD_PIXEL, 6); // the haft's end shows under the grip
  });

  it('a diagonal haft is turned along itself; a haft at the top is turned end over end', () => {
    const diag = [];
    for (let i = 0; i < 14; i++) diag.push([i + 1, 14 - i], [i + 1, 13 - i]);
    const d = heldGrip(art(16, diag), 16, { wielded: true });
    expect(d.style).toBe('tool');
    expect(d.turn).toBeGreaterThan(0.6); // counter-clockwise: the up-and-right shaft turned to straight up
    expect(d.turn).toBeLessThan(0.95);
    const stick = [];
    for (let y = 0; y < 16; y++) stick.push([7, y], [8, y]);
    for (let y = 10; y < 16; y++) for (let x = 4; x < 12; x++) stick.push([x, y]); // a blade at the bottom
    const s = heldGrip(art(16, stick), 16, { wielded: true, handleTop: true });
    expect(s.style).toBe('tool');
    expect(s.grip).toEqual([8, HELD_GRIP_IN]);
    expect(Math.abs(s.turn)).toBeCloseTo(Math.PI, 9);
  });
});

describe('the item in hand (every item)', () => {
  const NON_BLOCK = ITEM_KEYS.filter((k) => ITEMS[k].kind !== 'block');
  const BLOCKS = ITEM_KEYS.filter((k) => ITEMS[k].kind === 'block');
  /** Tools with a haft (itemArt.test: everything but the hammerstone and the tier-0 kit) and (§100) the arrows. */
  const HAFTED = ITEM_KEYS.filter((k) => (ITEMS[k].tool && k !== 'hammerstone' && ITEMS[k].tool.tier > 0) || ARROW_KEYS.includes(k));

  it('is shown for non-block items with art; block items, unknown keys and null show nothing', () => {
    for (const k of NON_BLOCK) expect(heldItemShown(k), k).toBe(true);
    expect(BLOCKS.length).toBeGreaterThan(10);
    for (const k of BLOCKS) expect(heldItemShown(k), k).toBe(false);
    for (const k of [null, undefined, '', 'nonsense', 'black_hole', 42]) expect(heldItemShown(/** @type {*} */ (k))).toBe(false);
    expect(heldItemGeometry('stone')).toBe(null);
    expect(heldItemGeometry(null)).toBe(null);
    expect(heldWielded('iron_pick')).toBe(true);
    expect(heldWielded('flint_arrow')).toBe(true);
    expect(heldWielded('honeyberries')).toBe(false);
  });

  it('every key with art makes a closed slab within half a metre of the hand', () => {
    const faults = [];
    for (const k of ITEM_ART_KEYS) {
      const g = heldItemGeometry(k);
      if (!g) { faults.push(`${k}: nothing`); continue; }
      if (g.positions.length === 0 || g.positions.length % 18 !== 0) faults.push(`${k}: ${g.positions.length} floats`);
      let far = 0;
      for (let i = 0; i < g.positions.length; i++) {
        if (!Number.isFinite(g.positions[i]) || !Number.isFinite(g.colors[i])) faults.push(`${k}: not finite at ${i}`);
        if (g.colors[i] < 0 || g.colors[i] > 1) faults.push(`${k}: colour out of range at ${i}`);
        far = Math.max(far, Math.abs(g.positions[i]));
      }
      if (far > 0.5 || far < 0.02) faults.push(`${k}: reaches ${far} m`);
      const bad = slabFaults(g);
      if (bad.length) faults.push(`${k}: ${bad[0]} (+${bad.length - 1})`);
    }
    expect(faults).toEqual([]);
  });

  it('the pixels say how it is held: hafted tools and arrows by the haft, everything else in the fist', () => {
    const faults = [];
    for (const k of ITEM_ART_KEYS) {
      const g = /** @type {NonNullable<ReturnType<typeof heldItemGeometry>>} */ (heldItemGeometry(k));
      const want = HAFTED.includes(k) ? 'tool' : 'lump';
      if (g.style !== want) faults.push(`${k}: ${g.style}, not ${want}`);
      if (g.style === 'lump' && (g.turn !== 0 || g.pixel !== HELD_PIXEL * HELD_LUMP_SCALE)) faults.push(`${k}: lump turned or full size`);
      if (g.style !== 'tool') continue;
      // the grip is on the picture (in the haft)
      const px = paintItem(k);
      const [u, v] = g.grip.map(Math.floor);
      if (px[(v * ITEM_ART_SIZE + u) * 4 + 3] <= 127) faults.push(`${k}: grip ${g.grip} off the picture`);
      const type = toolArtOf(k)?.[0];
      if (type === 'shovel') {
        if (Math.abs(Math.abs(g.turn) - Math.PI) > 0.1) faults.push(`${k}: a shovel not turned end over end (${g.turn})`);
      } else if (Math.abs(g.turn) > 0.35 || Math.abs(g.grip[0] - 8) > 0.6) {
        faults.push(`${k}: an upright tool held at ${g.grip}, turned ${g.turn}`);
      }
    }
    expect(faults).toEqual([]);
    // the art is deterministic, so the slab is too
    expect(heldItemGeometry('iron_pick')?.positions).toEqual(heldItemGeometry('iron_pick')?.positions);
  });

  it('§100 each bow is gripped at its wrapped handle, bottom middle, its limbs and string straight ahead; an arrow by its nock', () => {
    for (const k of ['crude_bow', 'recurve_bow']) {
      expect(heldWielded(k), k).toBe(true);
      const bow = /** @type {NonNullable<ReturnType<typeof heldItemGeometry>>} */ (heldItemGeometry(k));
      expect(bow.style, k).toBe('tool');
      expect(bow.pixel, k).toBe(HELD_PIXEL);
      expect(bow.turn, k).toBe(0); // the picture is mirror-symmetric: its bulk lies straight above the grip
      expect(bow.grip[0], k).toBe(8);
      // the hand closes on the wrap (rows 9–11), not on the string or a limb
      const [, v] = bow.grip.map(Math.floor);
      expect(v, k).toBeGreaterThanOrEqual(9);
      expect(v, k).toBeLessThanOrEqual(11);
    }
    // an arrow is held by its shaft near the nock, pointing straight ahead; the staves and the sapling in the fist
    for (const k of ARROW_KEYS) {
      const a = /** @type {NonNullable<ReturnType<typeof heldItemGeometry>>} */ (heldItemGeometry(k));
      expect(a.style, k).toBe('tool');
      expect(Math.abs(a.turn), k).toBeLessThan(0.1);
      expect(Math.abs(a.grip[0] - 7.5), k).toBeLessThan(0.6);
    }
    for (const k of ['bow_stave', 'treated_stave', 'sapling', 'spyglass']) expect(heldItemGeometry(k)?.style, k).toBe('lump');
    expect(heldGrip(paintItem('flint_arrow'), ITEM_ART_SIZE, { wielded: false }).style).toBe('lump');
  });
});
