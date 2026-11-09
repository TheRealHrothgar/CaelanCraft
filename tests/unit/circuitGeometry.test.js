// circuitGeometry.js — the knob-and-tube wiring, earth cords, powder fuses, binding posts and ground clamps
// (wireSegments), and the pose of every overlay (overlayPose). docs/DESIGN-circuits.md §4.5, §4.11, §6.2.7, §7 C.
// The geometry view is a fake (package C does not need B's engine).
import { describe, it, expect } from 'vitest';
import {
  wireSegments, overlayPose, fuseKink, torchAxis, SEGMENT_STRIDE, KNOB_STRIDE, KNOB_KIND, SEGMENT_COLOURS, COLOUR,
  WIRE_Y, WIRE_W, KNOB_H, TUBE_LEN, EARTH_Y, EARTH_W, EARTH_PIECE, FUSE_Y, FUSE_W, FUSE_KINK, FRAY_LEN, POST_W,
  POST_PROUD, POST_Y, POST_SPREAD, CLAMP_H, BLADE_OPEN_RAD, BLADE_LEN, BLADE_HINGE_X, CAP_TRAVEL, HAND_LEN, ARM_TILT,
  PLUNGER_UP, PLUNGER_DOWN, HAMMER_JITTER, BULB_ALPHA, TORCH_LEN, TORCH_LEAN, CHAR_W, FUSE_AT_BUNG, GLOW, MAX_POSES,
} from '../../src/circuitGeometry.js';
import { BLOCK } from '../../src/blocks.js';
import { packCell } from '../../src/coords.js';
import { hexToWorld, FACE_NORMALS } from '../../src/hex.js';
import { CIRCUIT_DRAW_RANGE } from '../../src/config.js';

const B = BLOCK;
const key = (q, y, r) => `${q},${y},${r}`;

/** A Map-backed geometry view: set(q, y, r, id, inputFace?), ground(q, y, r). cellsNear lists every cell. */
function fakeWorld() {
  const cells = new Map();
  const faces = new Map();
  const grounded = new Set();
  const w = {
    cells,
    set(q, y, r, id, f) {
      cells.set(key(q, y, r), id);
      if (f !== undefined) faces.set(key(q, y, r), f);
      return w;
    },
    ground(q, y, r) {
      grounded.add(key(q, y, r));
      return w;
    },
    view: {
      cellsNear: () => [...cells.keys()].map((k) => packCell(...k.split(',').map(Number))),
      get: (q, y, r) => cells.get(key(q, y, r)) ?? B.AIR,
      inputFace: (q, y, r) => faces.get(key(q, y, r)) ?? 3,
      grounded: (q, y, r) => grounded.has(key(q, y, r)),
    },
  };
  return w;
}

function build(w, x = 0, y = 0.5, z = 0, range = 64, out) {
  return wireSegments(w.view, x, y, z, range, out);
}
function segs(out) {
  const s = [];
  for (let i = 0; i < out.seg.count; i++) {
    const d = out.seg.data.subarray(i * SEGMENT_STRIDE, (i + 1) * SEGMENT_STRIDE);
    s.push({ x0: d[0], y0: d[1], z0: d[2], x1: d[3], y1: d[4], z1: d[5], w: d[6], c: d[7] });
  }
  return s;
}
function knobs(out, kind) {
  const k = [];
  for (let i = 0; i < out.knob.count; i++) {
    const d = out.knob.data.subarray(i * KNOB_STRIDE, (i + 1) * KNOB_STRIDE);
    if (kind === undefined || d[3] === kind) k.push({ x: d[0], y: d[1], z: d[2], kind: d[3], len: d[4] });
  }
  return k;
}
/** Segments starting at the centre of cell (q, r) at height y. */
function from(list, q, r, y) {
  const [x, z] = hexToWorld(q, r);
  return list.filter((s) => Math.abs(s.x0 - x) < 1e-5 && Math.abs(s.z0 - z) < 1e-5 && Math.abs(s.y0 - y) < 1e-5);
}
const close = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;

/** @returns {{ hue: number, sat: number }} */
function hs(hex) {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) h = ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  return { hue: h, sat: max === 0 ? 0 : d / max };
}

describe('wireSegments: knob-and-tube signal wiring (§4.11)', () => {
  it('a straight run: a knob per cell and a wire from each knob\'s groove to the faces it joins or attaches through', () => {
    const w = fakeWorld().set(0, 0, 0, B.VOLTAIC_BATTERY).set(4, 0, 0, B.FILAMENT_LAMP);
    for (let q = 1; q <= 3; q++) w.set(q, 0, 0, B.COPPER_WIRE);
    const out = build(w);
    const k = knobs(out);
    expect(k).toHaveLength(3);
    expect(k.map((n) => [n.x, n.y, n.z, n.kind, n.len])).toEqual([1, 2, 3].map((q) => [q, 0, 0, KNOB_KIND.KNOB, KNOB_H].map(Math.fround)));
    const s = segs(out);
    expect(s).toHaveLength(6);
    for (const g of s) {
      expect(close(g.y0, WIRE_Y) && close(g.y1, WIRE_Y)).toBe(true);
      expect(close(g.w, WIRE_W)).toBe(true);
      expect(g.c).toBe(COLOUR.COPPER);
      expect(close(Math.abs(g.x1 - g.x0), 0.5) && close(g.z0, 0) && close(g.z1, 0)).toBe(true);
    }
    // Continuous from the battery's face (0.5) to the lamp's face (3.5), each half from a knob to a face midpoint.
    const spans = s.map((g) => [Math.min(g.x0, g.x1), Math.max(g.x0, g.x1)]).sort((a, b) => a[0] - b[0]);
    expect(spans.map(([a, b]) => [a, b])).toEqual([[0.5, 1], [1, 1.5], [1.5, 2], [2, 2.5], [2.5, 3], [3, 3.5]]);
  });

  it('a T (three arms on faces two apart) and a six-way star (neighbouring ring cells touch, so they join too)', () => {
    const t = fakeWorld().set(0, 0, 0, B.BROWN_WIRE).set(1, 0, 0, B.BROWN_WIRE).set(-1, 0, 1, B.BROWN_WIRE).set(0, 0, -1, B.BROWN_WIRE);
    const ot = build(t);
    expect(knobs(ot, KNOB_KIND.KNOB)).toHaveLength(4);
    const st = segs(ot);
    expect(st).toHaveLength(6);
    expect(from(st, 0, 0, WIRE_Y)).toHaveLength(3);
    for (const [q, r] of [[1, 0], [-1, 1], [0, -1]]) expect(from(st, q, r, WIRE_Y)).toHaveLength(1);
    expect(st.every((g) => g.c === COLOUR.BROWN)).toBe(true);

    const star = fakeWorld().set(0, 0, 0, B.WHITE_WIRE);
    const ring = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
    for (const [q, r] of ring) star.set(q, 0, r, B.WHITE_WIRE);
    const os = build(star);
    expect(knobs(os, KNOB_KIND.KNOB)).toHaveLength(7);
    const ss = segs(os);
    expect(from(ss, 0, 0, WIRE_Y)).toHaveLength(6);
    for (const [q, r] of ring) expect(from(ss, q, r, WIRE_Y)).toHaveLength(3);
    expect(ss).toHaveLength(24);
    // Every centre half ends at its face midpoint.
    for (const g of from(ss, 0, 0, WIRE_Y)) expect(close(Math.hypot(g.x1, g.z1), 0.5)).toBe(true);
  });

  it('a riser is a porcelain tube from the lower knob\'s groove to the knob above, drawn once', () => {
    const w = fakeWorld().set(2, 5, -3, B.COPPER_WIRE).set(2, 6, -3, B.COPPER_WIRE);
    const out = build(w, 2, 5.5, -2.6);
    expect(segs(out)).toHaveLength(0);
    expect(knobs(out, KNOB_KIND.KNOB)).toHaveLength(2);
    const tubes = knobs(out, KNOB_KIND.TUBE);
    expect(tubes).toHaveLength(1);
    const [x, z] = hexToWorld(2, -3);
    expect([tubes[0].x, tubes[0].y, tubes[0].z, tubes[0].len]).toEqual([x, 5 + WIRE_Y, z, TUBE_LEN].map(Math.fround));
  });

  it('a wire under a device: no tube to a source or load (its bottom is the earth terminal), a tube to a board or contact', () => {
    for (const [id, tube] of [[B.FILAMENT_LAMP, 0], [B.VOLTAIC_BATTERY, 0], [B.TERMINAL_BOARD, 1], [B.KNIFE_SWITCH, 1],
      [B.RELAY, 1], [B.TORCH, 0], [B.POWDER_KEG, 0]]) {
      const out = build(fakeWorld().set(0, 0, 0, B.COPPER_WIRE).set(0, 1, 0, id));
      expect(knobs(out, KNOB_KIND.TUBE), `${id}`).toHaveLength(tube);
      expect(knobs(out, KNOB_KIND.KNOB)).toHaveLength(1);
      expect(segs(out)).toHaveLength(0);
    }
    // A wire lying on a device's top is attached through that top: its knob sits on it, nothing else is drawn.
    const on = build(fakeWorld().set(0, 1, 0, B.COPPER_WIRE).set(0, 0, 0, B.VOLTAIC_BATTERY));
    expect(knobs(on)).toHaveLength(1);
    expect(segs(on)).toHaveLength(0);
  });

  it('follows §4.5: same kinds join, colours meet only on a terminal board, contacts (taken as closed) and input faces connect', () => {
    expect(segs(build(fakeWorld().set(0, 0, 0, B.COPPER_WIRE).set(1, 0, 0, B.BROWN_WIRE)))).toHaveLength(0);
    const board = segs(build(fakeWorld().set(0, 0, 0, B.COPPER_WIRE).set(1, 0, 0, B.TERMINAL_BOARD).set(2, 0, 0, B.BROWN_WIRE)));
    expect(board.map((g) => g.c).sort()).toEqual([COLOUR.COPPER, COLOUR.BROWN]);
    for (const id of [B.KNIFE_SWITCH, B.PUSH_BUTTON, B.CLOCKWORK_TIMER, B.RELAY, B.COHERER_RECEIVER, B.IGNITER,
      B.SPARK_TRANSMITTER, B.SELENIUM_PANEL, B.BLASTING_MACHINE, B.ELECTRIC_BELL]) {
      expect(segs(build(fakeWorld().set(0, 0, 0, B.COPPER_WIRE).set(1, 0, 0, id, 3))), `${id}`).toHaveLength(1);
    }
    // A relay's input face attaches; its other faces are contact terminals: a wire on either side reaches it.
    const relay = fakeWorld().set(1, 0, 0, B.RELAY, 3).set(0, 0, 0, B.COPPER_WIRE).set(2, 0, 0, B.WHITE_WIRE);
    expect(segs(build(relay))).toHaveLength(2);
    // Nothing that is not a conductor or a device's live face draws a wire: fuses, torches, kegs, charges, earth wire, a
    // campfire, ordinary blocks.
    for (const id of [B.POWDER_FUSE, B.TORCH, B.POWDER_KEG, B.COLLAPSAR_CHARGE, B.EARTH_WIRE, B.CAMPFIRE, B.STONE]) {
      const s = segs(build(fakeWorld().set(0, 0, 0, B.COPPER_WIRE).set(1, 0, 0, id)));
      expect(s.filter((g) => g.c === COLOUR.COPPER), `${id}`).toHaveLength(0);
    }
  });

  it('draws no terminal dots: the only knobs are one per signal-wire cell, plus tubes, binding posts and ground clamps', () => {
    const w = fakeWorld();
    let wires = 0;
    for (let q = 0; q < 12; q++) {
      for (let r = 0; r < 6; r++) {
        const n = (q * 7 + r * 13) % 9;
        const id = [B.COPPER_WIRE, B.BROWN_WIRE, B.WHITE_WIRE, B.EARTH_WIRE, B.VOLTAIC_BATTERY, B.FILAMENT_LAMP, B.RELAY,
          B.TERMINAL_BOARD, B.POWDER_FUSE][n];
        w.set(q, 0, r, id, 0);
        if (n < 3) wires++;
      }
    }
    const out = build(w, 6, 0.5, 2);
    const ids = [...w.cells.values()];
    expect(knobs(out, KNOB_KIND.KNOB)).toHaveLength(wires);
    expect(knobs(out, KNOB_KIND.POST)).toHaveLength(2 * ids.filter((id) => id === B.RELAY).length);
    expect(knobs(out, KNOB_KIND.TUBE)).toHaveLength(0);
    expect(knobs(out, KNOB_KIND.CLAMP)).toHaveLength(0);
    expect(out.knob.count).toBe(wires + 2 * ids.filter((id) => id === B.RELAY).length);
  });

  it('signal wire colours are copper, brown and white — never red, blue, green or yellow; the earth is green and yellow', () => {
    for (const i of [COLOUR.COPPER, COLOUR.BROWN, COLOUR.WHITE]) {
      const { hue, sat } = hs(SEGMENT_COLOURS[i]);
      if (sat < 0.3) continue;
      expect(hue > 12 && hue < 40, `colour ${i} hue ${hue}`).toBe(true);
    }
    expect(SEGMENT_COLOURS.slice(0, 3)).toEqual([0xc8743a, 0x6b4226, 0xe8e2d0]);
    expect([SEGMENT_COLOURS[COLOUR.EARTH_GREEN], SEGMENT_COLOURS[COLOUR.EARTH_YELLOW]]).toEqual([0x3f9f3f, 0xe0c43a]);
    expect(SEGMENT_COLOURS).toHaveLength(10);
  });
});

describe('wireSegments: earth wire (§4.4, §4.11)', () => {
  it('lies on the floor as striped cord (alternating 0.25 pieces) with no knobs; a clamp only where the cell is grounded', () => {
    const w = fakeWorld().set(0, 0, 0, B.EARTH_WIRE).set(1, 0, 0, B.EARTH_WIRE).set(2, 0, 0, B.EARTH_WIRE).ground(0, 0, 0);
    const out = build(w);
    expect(knobs(out, KNOB_KIND.KNOB)).toHaveLength(0);
    const clamps = knobs(out, KNOB_KIND.CLAMP);
    expect(clamps).toHaveLength(1);
    expect([clamps[0].x, clamps[0].y, clamps[0].z, clamps[0].len]).toEqual([0, 0, 0, CLAMP_H].map(Math.fround));
    const s = segs(out).sort((a, b) => Math.min(a.x0, a.x1) - Math.min(b.x0, b.x1));
    expect(s).toHaveLength(8);
    for (const g of s) {
      expect(close(g.y0, EARTH_Y) && close(g.y1, EARTH_Y) && close(g.w, EARTH_W)).toBe(true);
      expect(close(Math.abs(g.x1 - g.x0), EARTH_PIECE)).toBe(true);
    }
    // From x = 0 to 2 the stripes alternate across cell boundaries: G Y G Y G Y G Y.
    expect(s.map((g) => g.c)).toEqual([3, 4, 3, 4, 3, 4, 3, 4]);
  });

  it('straps to a device that needs earth through a side face; a lone cell is a short stub; a riser joins an earth wire above', () => {
    const strap = segs(build(fakeWorld().set(0, 0, 0, B.EARTH_WIRE).set(1, 0, 0, B.VOLTAIC_BATTERY)));
    expect(strap).toHaveLength(2);
    expect(close(Math.max(...strap.map((g) => Math.max(g.x0, g.x1))), 0.5)).toBe(true);
    const lone = segs(build(fakeWorld().set(0, 0, 0, B.EARTH_WIRE).set(1, 0, 0, B.TERMINAL_BOARD)));
    expect(lone).toHaveLength(2);
    expect(close(Math.min(...lone.map((g) => g.x0)), -0.2) && close(Math.max(...lone.map((g) => g.x1)), 0.2)).toBe(true);
    const riser = segs(build(fakeWorld().set(0, 0, 0, B.EARTH_WIRE).set(0, 1, 0, B.EARTH_WIRE)));
    expect(riser).toHaveLength(4);
    expect(riser.every((g) => close(g.x0, 0) && close(g.x1, 0) && g.y1 > g.y0)).toBe(true);
    expect(close(Math.min(...riser.map((g) => g.y0)), EARTH_Y) && close(Math.max(...riser.map((g) => g.y1)), 1 + EARTH_Y)).toBe(true);
    // Nothing reaches a signal wire from an earth wire, or the other way round.
    const mixed = segs(build(fakeWorld().set(0, 0, 0, B.EARTH_WIRE).set(1, 0, 0, B.COPPER_WIRE)));
    expect(mixed.filter((g) => g.c === COLOUR.COPPER)).toHaveLength(0);
  });
});

describe('wireSegments: powder fuse (§4.11)', () => {
  it('a round cord at FUSE_Y, each half kinked sideways by a seeded ±FUSE_KINK, the same on every rebuild', () => {
    const w = fakeWorld();
    for (let q = -3; q <= 3; q++) w.set(q, 4, 2, B.POWDER_FUSE);
    const a = build(w, 0, 4.5, 2);
    const b = build(w, 0, 4.5, 2);
    expect(Array.from(a.seg.data.subarray(0, a.seg.count * SEGMENT_STRIDE))).toEqual(Array.from(b.seg.data.subarray(0, b.seg.count * SEGMENT_STRIDE)));
    const s = segs(a);
    const cord = s.filter((g) => g.c === COLOUR.FUSE);
    expect(cord.every((g) => close(g.y0, 4 + FUSE_Y) && close(g.y1, 4 + FUSE_Y) && close(g.w, FUSE_W))).toBe(true);
    // The middle cell (0, 4, 2): two halves of two pieces each; the kink point lies off the straight line by fuseKink.
    const [cx, cz] = hexToWorld(0, 2);
    const mid = from(cord, 0, 2, 4 + FUSE_Y);
    expect(mid).toHaveLength(2);
    for (const g of mid) {
      const f = g.x1 > cx ? 0 : 3;
      const k = fuseKink(0, 4, 2, f);
      expect(Math.abs(k)).toBeLessThanOrEqual(FUSE_KINK);
      const n = FACE_NORMALS[f];
      expect(close(g.x1, cx + 0.25 * n[0] - n[2] * k, 1e-4) && close(g.z1, cz + 0.25 * n[2] + n[0] * k, 1e-4)).toBe(true);
    }
    // The kinks differ between cells (seeded per cell) but stay within ±FUSE_KINK everywhere.
    const kinks = [];
    for (let q = -40; q < 40; q++) for (let f = 0; f < 6; f++) kinks.push(fuseKink(q, 7, -q, f));
    expect(Math.max(...kinks.map(Math.abs))).toBeLessThanOrEqual(FUSE_KINK);
    expect(new Set(kinks.map((k) => k.toFixed(6))).size).toBeGreaterThan(400);
    // Neighbouring halves meet at the shared face midpoint.
    const ends = cord.filter((g) => close(Math.abs(g.z1 - cz), 0, 1e-4) && close(Math.abs(g.x1 - Math.round(g.x1 * 2) / 2), 0, 1e-4));
    expect(ends.length).toBeGreaterThan(0);
  });

  it('a cell with one join carries on across and ends in a frayed grey tuft at its far side; a lone cell is cord end to end', () => {
    const w = fakeWorld().set(0, 0, 0, B.POWDER_FUSE).set(1, 0, 0, B.POWDER_FUSE).set(2, 0, 0, B.POWDER_FUSE);
    const s = segs(build(w));
    const tufts = s.filter((g) => g.c === COLOUR.FRAY);
    expect(tufts).toHaveLength(6); // three strands at each end
    // The west end frays toward the west, out to its west face; the east end toward the east; the middle not at all.
    const west = tufts.filter((g) => g.x1 < 0);
    const east = tufts.filter((g) => g.x1 > 2);
    expect(west).toHaveLength(3);
    expect(east).toHaveLength(3);
    const thick = tufts.filter((g) => g.w > FUSE_W);
    expect(thick).toHaveLength(2);
    for (const g of thick) {
      expect(close(Math.hypot(g.x1 - g.x0, g.z1 - g.z0), FRAY_LEN)).toBe(true);
      expect(close(Math.abs(g.x1 - Math.round(g.x1)), 0.5, 1e-5) || close(Math.abs(g.x1), 0.5, 1e-5)).toBe(true); // reaches the face
    }
    expect(Math.min(...west.map((g) => g.x1))).toBeGreaterThan(-0.5 - 1e-6);
    // The middle's 2 halves; at each end, the joined half, the free half to the tuft, and 3 strands.
    expect(s).toHaveLength(2 * 2 + 2 * (2 + 2 + 3));
    // The free half's cord stops FRAY_LEN short of the face, where the tuft starts.
    const freeEnd = s.filter((g) => g.c === COLOUR.FUSE && close(Math.abs(g.x1), 0.5 - FRAY_LEN));
    expect(freeEnd).toHaveLength(1);

    const lone = segs(build(fakeWorld().set(0, 0, 0, B.POWDER_FUSE)));
    const cord = lone.filter((g) => g.c === COLOUR.FUSE);
    expect(cord).toHaveLength(4);
    expect(close(Math.min(...cord.map((g) => Math.min(g.x0, g.x1))), -0.5)).toBe(true);
    expect(lone.filter((g) => g.c === COLOUR.FRAY).every((g) => g.x1 > 0)).toBe(true);
    expect(lone.filter((g) => g.c === COLOUR.FRAY)).toHaveLength(3);
  });

  it('runs into a keg or a collapsar charge beside it, rises to a fuse above, and ignores other blocks', () => {
    for (const id of [B.POWDER_KEG, B.COLLAPSAR_CHARGE]) {
      const s = segs(build(fakeWorld().set(0, 0, 0, B.POWDER_FUSE).set(1, 0, 0, id)));
      const cord = s.filter((g) => g.c === COLOUR.FUSE);
      expect(cord).toHaveLength(4); // the half into the keg and the free half
      expect(close(Math.max(...cord.map((g) => g.x1)), 0.5)).toBe(true);
      expect(s.filter((g) => g.c === COLOUR.FRAY).every((g) => g.x1 < 0)).toBe(true);
    }
    const up = segs(build(fakeWorld().set(0, 0, 0, B.POWDER_FUSE).set(0, 1, 0, B.POWDER_FUSE)));
    const riser = up.filter((g) => g.c === COLOUR.FUSE && g.y1 > g.y0 + 0.5);
    expect(riser).toHaveLength(1);
    expect([riser[0].y0, riser[0].y1]).toEqual([FUSE_Y, 1 + FUSE_Y].map(Math.fround));
    expect(up.filter((g) => g.c === COLOUR.FRAY && g.x1 > 0)).toHaveLength(6); // each cell's one join is vertical: fray east
    const other = segs(build(fakeWorld().set(0, 0, 0, B.POWDER_FUSE).set(1, 0, 0, B.COPPER_WIRE).set(-1, 0, 0, B.TORCH)));
    expect(other.filter((g) => g.c === COLOUR.FUSE)).toHaveLength(4); // a lone cell: west half and free east half
  });
});

describe('wireSegments: binding posts, range and buffers', () => {
  it('relays, timers and coherers carry two brass posts on their input face, POST_PROUD proud of it', () => {
    for (const id of [B.RELAY, B.CLOCKWORK_TIMER, B.COHERER_RECEIVER]) {
      for (const f of [0, 1, 2, 3, 4, 5]) {
        const out = build(fakeWorld().set(0, 0, 0, id, f));
        const posts = knobs(out, KNOB_KIND.POST);
        expect(posts, `${id} face ${f}`).toHaveLength(2);
        const n = FACE_NORMALS[f];
        for (const p of posts) {
          const along = p.x * n[0] + p.z * n[2];
          expect(close(along + POST_W / 2, 0.5 + POST_PROUD, 1e-5)).toBe(true);
          expect(close(p.y, POST_Y - POST_W / 2) && close(p.len, POST_W)).toBe(true);
        }
        const across = posts.map((p) => -p.x * n[2] + p.z * n[0]).sort((a, b) => a - b);
        expect(close(across[0], -POST_SPREAD, 1e-5) && close(across[1], POST_SPREAD, 1e-5)).toBe(true);
      }
      const topPosts = knobs(build(fakeWorld().set(0, 0, 0, id, 6)), KNOB_KIND.POST);
      expect(topPosts).toHaveLength(2);
      for (const p of topPosts) expect(close(p.y + p.len, 1 + POST_PROUD)).toBe(true);
      // Without a stored face, the default (W) is used.
      const def = knobs(wireSegments({ ...fakeWorld().set(0, 0, 0, id).view, inputFace: () => undefined }, 0, 0, 0, 64), KNOB_KIND.POST);
      expect(def.every((p) => p.x < -0.4)).toBe(true);
    }
    for (const id of [B.KNIFE_SWITCH, B.PUSH_BUTTON, B.IGNITER, B.VOLTAIC_BATTERY]) {
      expect(build(fakeWorld().set(0, 0, 0, id)).knob.count, `${id}`).toBe(0);
    }
  });

  it('draws only the cells within range of the eye (default CIRCUIT_DRAW_RANGE)', () => {
    const w = fakeWorld().set(0, 0, 0, B.COPPER_WIRE).set(30, 0, 0, B.COPPER_WIRE).set(100, 0, 0, B.COPPER_WIRE);
    expect(build(w, 0, 0.5, 0, 10).knob.count).toBe(1);
    expect(build(w, 0, 0.5, 0, 40).knob.count).toBe(2);
    expect(build(w, 0, 0.5, 0, 200).knob.count).toBe(3);
    expect(wireSegments(w.view, 0, 0.5, 0, NaN).knob.count).toBe(CIRCUIT_DRAW_RANGE >= 100 ? 3 : 2);
    expect(build(w, 100, 0.5, 0, 10).knob.count).toBe(1);
  });

  it('reuses and grows the output buffers; a missing view gives nothing', () => {
    const w = fakeWorld();
    for (let q = 0; q < 200; q++) w.set(q, 0, 0, B.COPPER_WIRE);
    const out = { seg: { data: new Float32Array(8), count: 99 }, knob: { data: new Float32Array(5), count: 99 } };
    const r = wireSegments(w.view, 100, 0.5, 0, 200, out);
    expect(r).toBe(out);
    expect(out.knob.count).toBe(200);
    expect(out.seg.count).toBe(2 * 198 + 2);
    expect(out.seg.data.length).toBeGreaterThanOrEqual(out.seg.count * SEGMENT_STRIDE);
    const again = wireSegments(fakeWorld().view, 0, 0, 0, 64, out);
    expect(again.seg.count + again.knob.count).toBe(0);
    expect(wireSegments(null, 0, 0, 0, 64, out).seg.count).toBe(0);
  });
});

/** Run overlayPose and return copies of the poses. */
function poses(item, t = 0) {
  const out = [];
  const n = overlayPose(item, t, out);
  return out.slice(0, n).map((p) => ({ ...p }));
}
const at = (type, extra = {}) => ({ type, q: 3, y: 10, r: -2, a: 0, b: 0, ...extra });
const [CX, CZ] = hexToWorld(3, -2);
const TOP = 11;

describe('overlayPose (§4.11)', () => {
  it('blade: hinged on the top\'s west, flat in the jaws when closed and raised 65° when open', () => {
    const closed = poses(at('blade', { a: 1 }));
    expect(closed).toHaveLength(6);
    expect(closed[0].rz).toBe(0);
    expect(close(closed[0].x, CX + BLADE_HINGE_X + BLADE_LEN / 2) && close(closed[0].sx, BLADE_LEN)).toBe(true);
    const open = poses(at('blade', { a: 0 }));
    expect(close(open[0].rz, BLADE_OPEN_RAD)).toBe(true);
    expect(close(BLADE_OPEN_RAD, (65 * Math.PI) / 180)).toBe(true);
    // The hinge end stays put: centre − half the blade along its angle is the hinge.
    for (const p of [closed[0], open[0], poses(at('blade', { a: 0.5 }))[0]]) {
      expect(close(p.x - Math.cos(p.rz) * BLADE_LEN / 2, CX + BLADE_HINGE_X) && close(p.y - Math.sin(p.rz) * BLADE_LEN / 2, TOP + 0.08)).toBe(true);
    }
    expect(open[0].y).toBeGreaterThan(closed[0].y + 0.15);
    expect(open[1].y).toBeGreaterThan(open[0].y); // the handle at the raised free end
    expect(close(poses(at('blade', { a: 0.5 }))[0].rz, BLADE_OPEN_RAD / 2)).toBe(true);
    expect(closed.slice(2).map((p) => p.x)).toEqual(open.slice(2).map((p) => p.x)); // the hinge cheeks and jaws stay put
  });

  it('cap: sinks CAP_TRAVEL while pressed; an NC button\'s cap is dark', () => {
    const up = poses(at('cap'));
    const down = poses(at('cap', { a: 1 }));
    expect(close(up[0].y - down[0].y, CAP_TRAVEL)).toBe(true);
    expect(close(CAP_TRAVEL, 0.05)).toBe(true);
    expect(poses(at('cap', { b: 1 }))[0].colour).not.toBe(up[0].colour);
    expect(up[0].y).toBeGreaterThan(TOP);
  });

  it('hand: points at 2π·(left / s), clockwise from north; honey while holding', () => {
    const dirOf = (p) => [Math.cos(-p.ry), Math.sin(-p.ry)];
    const north = poses(at('hand', { a: 0 }))[0];
    expect(close(north.x, CX) && close(north.z, CZ - HAND_LEN / 2)).toBe(true);
    const east = poses(at('hand', { a: 0.25 }))[0];
    expect(close(east.x, CX + HAND_LEN / 2) && close(east.z, CZ)).toBe(true);
    const south = poses(at('hand', { a: 0.5 }))[0];
    expect(close(south.z, CZ + HAND_LEN / 2)).toBe(true);
    const sevenTenths = poses(at('hand', { a: 0.7 }))[0];
    const [dx, dz] = dirOf(sevenTenths);
    const want = 2 * Math.PI * 0.7;
    expect(close(dx * HAND_LEN / 2, sevenTenths.x - CX) && close(dz * HAND_LEN / 2, sevenTenths.z - CZ)).toBe(true);
    expect(close(Math.sin(want) * HAND_LEN / 2, sevenTenths.x - CX) && close(-Math.cos(want) * HAND_LEN / 2, sevenTenths.z - CZ)).toBe(true);
    expect(poses(at('hand', { a: 0.3, b: 1 }))[0].colour).toBe(0xe8b04a);
    expect(east.colour).not.toBe(0xe8b04a);
  });

  it('arm: the armature tilts 12° when energised or pushed; the NC flag only on NC relays', () => {
    expect(poses(at('arm'))[0].rz).toBe(0);
    expect(close(poses(at('arm', { a: 1 }))[0].rz, ARM_TILT)).toBe(true);
    expect(close(ARM_TILT, (12 * Math.PI) / 180)).toBe(true);
    expect(poses(at('arm', { b: 1 }))).toHaveLength(poses(at('arm')).length + 1);
  });

  it('plunger: the T-handle travels from +0.6 above the top (cocked) to +0.1 (pushed home)', () => {
    const up = poses(at('plunger'));
    const down = poses(at('plunger', { a: 1 }));
    expect(close(up[0].sy, PLUNGER_UP) && close(down[0].sy, PLUNGER_DOWN)).toBe(true);
    expect(close(up[1].y, TOP + PLUNGER_UP + 0.035) && close(down[1].y, TOP + PLUNGER_DOWN + 0.035)).toBe(true);
    expect(close(poses(at('plunger', { a: 0.5 }))[1].y, TOP + 0.35 + 0.035)).toBe(true);
  });

  it('hammer: still when silent; jitters within ±10° at 15 Hz while ringing', () => {
    const still = [0, 0.01, 0.02, 0.033].map((t) => poses(at('hammer'), t)[0].ry);
    expect(new Set(still).size).toBe(1);
    const base = still[0];
    const ring = [];
    for (let k = 0; k < 40; k++) ring.push(poses(at('hammer', { a: 1 }), k / 600)[0].ry);
    for (const ry of ring) expect(Math.abs(ry - base)).toBeLessThanOrEqual(HAMMER_JITTER + 1e-9);
    expect(Math.max(...ring) - Math.min(...ring)).toBeGreaterThan(HAMMER_JITTER * 1.5);
    // 15 Hz: the pose repeats after 1/15 s.
    expect(close(poses(at('hammer', { a: 1 }), 0.013)[0].ry, poses(at('hammer', { a: 1 }), 0.013 + 1 / 15)[0].ry)).toBe(true);
  });

  it('bulb: clear glass (alpha 0.35) in two stacked hex prisms — a narrow neck under a wide body — and a tip pip', () => {
    const b = poses(at('bulb'));
    expect(b).toHaveLength(3);
    expect(b.every((p) => p.alpha === BULB_ALPHA)).toBe(true);
    expect(b[0].sx).toBeLessThan(b[1].sx);
    expect(b[0].y).toBeLessThan(b[1].y);
    expect(b[2].y).toBeGreaterThan(b[1].y + b[1].sy / 2 - 0.01);
    expect(b[0].y - b[0].sy / 2).toBeGreaterThanOrEqual(TOP - 1e-9);
  });

  it('glow sizes and colours (§4.11); a dark lamp or a spent flash draws nothing', () => {
    const lamp = poses(at('glow', { glow: 'lamp', a: 0.5 }));
    expect(lamp).toHaveLength(1);
    expect(close(lamp[0].sx, 0.2 + 0.4 * 0.5) && lamp[0].alpha === 0.5 && lamp[0].colour === 0xffd27a).toBe(true);
    expect(poses(at('glow', { glow: 'lamp', a: 0 }))).toHaveLength(0);
    const sizes = { igniter: [0.35, 0xff4a1a], spark: [0.6, 0xcfe4ff], coherer: [0.25, 0x9fd0ff], charge: [0.12, 0xf4f1ea], fuse: [0.22, 0xffcf6a] };
    for (const [kind, [size, colour]] of Object.entries(sizes)) {
      const p = poses(at('glow', { glow: kind, a: 1, b: -1 }), 1.3);
      expect(p.length, kind).toBeGreaterThanOrEqual(1);
      expect(close(p[0].sx, size) && p[0].colour === colour && p[0].sy <= p[0].sx * 1.2, kind).toBe(true);
      expect(p[0].alpha).toBeGreaterThan(0);
      expect(GLOW[kind].size).toBe(size);
    }
    expect(poses(at('glow', { glow: 'spark', a: 0 }))).toHaveLength(0);
    expect(poses(at('glow', { glow: 'coherer', a: 0 }))).toHaveLength(0);
    // The torch's flame: 0.10 wide, taller than wide (drawn as a tongue of flame), with a dim halo.
    const ember = poses(at('glow', { glow: 'ember', a: 1 }), 2);
    expect(ember).toHaveLength(2);
    expect(close(ember[0].sx, 0.1) && ember[0].sy > 1.2 * ember[0].sx && ember[0].colour === 0xff7a2a).toBe(true);
    expect(ember[1].alpha).toBeLessThan(ember[0].alpha);
    // The charge twinkles irregularly but never goes out.
    const tw = [];
    for (let k = 0; k < 200; k++) tw.push(poses(at('glow', { glow: 'charge', a: 1 }), k * 0.05)[0].alpha);
    expect(Math.min(...tw)).toBeGreaterThan(0.3);
    expect(Math.max(...tw) - Math.min(...tw)).toBeGreaterThan(0.3);
    expect(poses(at('glow', { glow: 'bogus', a: 1 }))).toHaveLength(0);
  });

  it('the fuse spark rides the burn front: from the entry face to the centre over the first half, on out over the second', () => {
    const p0 = poses(at('glow', { glow: 'fuse', a: 0, b: 3 }))[0];
    expect(close(p0.x, CX - 0.5) && close(p0.z, CZ)).toBe(true);
    const half = poses(at('glow', { glow: 'fuse', a: 0.5, b: 3 }))[0];
    expect(close(half.x, CX, 1e-6) && close(half.z, CZ, 1e-6)).toBe(true);
    const end = poses(at('glow', { glow: 'fuse', a: 1, b: 3 }))[0];
    expect(close(end.x, CX + 0.5) && close(end.z, CZ)).toBe(true);
    expect(close(p0.y, 10 + FUSE_Y + 0.05)).toBe(true);
    const inPlace = poses(at('glow', { glow: 'fuse', a: 0.4, b: -1 }))[0];
    expect(close(inPlace.x, CX) && close(inPlace.z, CZ)).toBe(true);
    const bung = poses(at('glow', { glow: 'fuse', a: 1, b: FUSE_AT_BUNG }))[0];
    expect(close(bung.x, CX) && close(bung.z, CZ) && bung.y > TOP).toBe(true);
  });

  it('the torch leans 12° in a seeded direction, full height, and its flame sits on its head', () => {
    const s = poses(at('staff', { staff: 'torch' }));
    expect(s).toHaveLength(6);
    const ax = torchAxis(3, 10, -2);
    expect(close(Math.hypot(ax[2], ax[3], ax[4]), 1)).toBe(true);
    expect(close(Math.acos(ax[3]), TORCH_LEAN)).toBe(true);
    for (const p of s) {
      expect(close(p.rz, -TORCH_LEAN) && close(p.ry, -ax[5])).toBe(true);
      // The piece's centre lies on the axis.
      const m = (p.y - 10) / ax[3];
      expect(close(p.x, ax[0] + ax[2] * m) && close(p.z, ax[1] + ax[4] * m)).toBe(true);
    }
    const tipS = Math.max(...s.map((p) => (p.y - 10) / ax[3] + p.sy / 2));
    expect(close(tipS, TORCH_LEN)).toBe(true);
    expect(s[0].y - s[0].sy / 2 * ax[3]).toBeCloseTo(10, 5); // the iron foot stands on the floor
    // The head stands near the middle of the cell, wherever it leans.
    const head = TORCH_LEN;
    expect(Math.hypot(ax[0] + ax[2] * head - CX, ax[1] + ax[4] * head - CZ)).toBeLessThan(0.2);
    const flame = poses(at('glow', { glow: 'ember', a: 1 }), 0)[0];
    const fs = (flame.y - 10) / ax[3];
    expect(fs).toBeGreaterThan(TORCH_LEN);
    expect(close(flame.x, ax[0] + ax[2] * fs, 1e-6) && close(flame.z, ax[1] + ax[4] * fs, 1e-6)).toBe(true);
    // Seeded: the same cell leans the same way every time; cells differ.
    expect(torchAxis(3, 10, -2)).toEqual(ax);
    const dirs = new Set();
    for (let q = 0; q < 30; q++) dirs.add(torchAxis(q, 1, q).at(5).toFixed(3));
    expect(dirs.size).toBeGreaterThan(25);
  });

  it('char covers the burnt fraction of a fuse cell along its path; the filament glows with the lamp', () => {
    expect(poses(at('staff', { staff: 'char', a: 0, b: 3 }))).toHaveLength(0);
    const length = (ps) => ps.reduce((s, p) => s + p.sx, 0);
    const full = poses(at('staff', { staff: 'char', a: 1, b: 3 }));
    expect(full).toHaveLength(4);
    // The entry half burns over the first half of the cell's time and ends at the centre; the exit half over the second.
    const half = poses(at('staff', { staff: 'char', a: 0.5, b: 3 }));
    expect(half).toHaveLength(2);
    const last = half[1];
    expect(close(last.x + Math.cos(-last.ry) * last.sx / 2, CX, 1e-6) && close(last.z + Math.sin(-last.ry) * last.sx / 2, CZ, 1e-6)).toBe(true);
    const quarter = poses(at('staff', { staff: 'char', a: 0.25, b: 3 }));
    expect(close(length(quarter), length(half) / 2, 1e-6)).toBe(true);
    const threeQuarters = poses(at('staff', { staff: 'char', a: 0.75, b: 3 }));
    expect(close(length(threeQuarters) - length(half), (length(full) - length(half)) / 2, 1e-6)).toBe(true);
    expect(full.every((p) => close(p.sz, CHAR_W) && p.y > 10 + FUSE_Y + FUSE_W / 2 && p.colour === 0x5a5650)).toBe(true);
    expect(length(full)).toBeGreaterThanOrEqual(1); // entry face to the opposite face, kinked
    // The first piece starts at the entry face.
    const p = full[0];
    const sx = p.x - Math.cos(-p.ry) * p.sx / 2;
    expect(close(sx, CX - 0.5, 1e-6)).toBe(true);
    const lit = poses(at('staff', { staff: 'char', a: 0.5, b: -1 }));
    expect(lit).toHaveLength(1);
    expect(close(lit[0].x, CX) && lit[0].sx > CHAR_W).toBe(true);
    const cold = poses(at('staff', { staff: 'filament', a: 0 }));
    const hot = poses(at('staff', { staff: 'filament', a: 1 }));
    expect(cold).toHaveLength(3);
    expect(cold[0].colour).toBe(0x2a2622);
    expect(hot[0].colour).toBe(0xffe6a8);
  });

  it('writes nothing for unknown types or bad cells, never more than MAX_POSES, and reuses its pose objects', () => {
    expect(poses({ type: 'nope', q: 0, y: 0, r: 0, a: 0, b: 0 })).toHaveLength(0);
    expect(poses(at('blade', { q: NaN }))).toHaveLength(0);
    expect(overlayPose(null, 0, [])).toBe(0);
    const out = [];
    for (const type of Object.keys(MAX_POSES)) {
      for (const extra of [{ a: 1, b: 1 }, { a: 0, b: 0 }, { glow: 'ember', a: 1 }, { staff: 'torch' }, { glow: 'lamp', a: 1 }, { staff: 'char', a: 1, b: 2 }]) {
        expect(overlayPose(at(type, extra), 0.4, out)).toBeLessThanOrEqual(MAX_POSES[type]);
      }
    }
    const first = out[0];
    overlayPose(at('cap'), 0, out);
    expect(out[0]).toBe(first);
  });
});
