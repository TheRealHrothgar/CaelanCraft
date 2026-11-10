// circuitGeometry.js — the knob-and-tube wiring, earth cords, powder fuses, binding posts and ground clamps
// (wireSegments), and the pose of every overlay (overlayPose). docs/DESIGN-circuits.md §4.5, §4.11, §6.2.7, §7 C.
// The geometry view is a fake (package C does not need B's engine).
import { describe, it, expect } from 'vitest';
import {
  wireSegments, overlayPose, modelPoses, hasModel, fuseKink, torchAxis, SEGMENT_STRIDE, KNOB_STRIDE, BODY_STRIDE, TURN_STRIDE,
  KNOB_KIND, SEGMENT_COLOURS, COLOUR, WIRE_Y, WIRE_W, KNOB_H, TUBE_LEN, EARTH_Y, EARTH_W, EARTH_PIECE, FUSE_Y, FUSE_W, FUSE_KINK,
  FRAY_LEN, POST_W, POST_H, POST_SPREAD, STUD_H, CLAMP_H, BLADE_OPEN_RAD, BLADE_LEN, BLADE_HINGE_X, BLADE_Y, CAP_TRAVEL, CAP_Y,
  HAND_LEN, HAND_HUB, ARM_TILT, ARM_PIVOT, ARM_LEN, PLUNGER_UP, PLUNGER_DOWN, PLUNGER_BASE, HAMMER_JITTER, RING_BLINK_HZ,
  BULB_ALPHA, GLASS_ALPHA, BULB_Y, BULB_D, TORCH_LEN, TORCH_LEAN, CHAR_W, FUSE_AT_BUNG, GLOW, MAX_POSES, MODELS, MODEL_IDS, PAL,
  BATCHES, BATCH, DEVICE_DRAW_RANGE,
} from '../../src/circuitGeometry.js';
import { partOf } from '../../src/circuitParts.js';
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
/** The body records as poses. */
function bodies(out) {
  const b = [];
  for (let i = 0; i < out.body.count; i++) {
    const d = out.body.data.subarray(i * BODY_STRIDE, (i + 1) * BODY_STRIDE);
    b.push({ x: d[0], y: d[1], z: d[2], rx: d[3], ry: d[4], rz: d[5], sx: d[6], sy: d[7], sz: d[8], colour: d[9], batch: d[10] });
  }
  return b;
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
    const k = knobs(out, KNOB_KIND.KNOB);
    expect(k).toHaveLength(3);
    expect(k.map((n) => [n.x, n.y, n.z, n.kind, n.len])).toEqual([1, 2, 3].map((q) => [q, 0, 0, KNOB_KIND.KNOB, KNOB_H].map(Math.fround)));
    const s = segs(out);
    expect(s).toHaveLength(8); // six halves in the wire cells and a lead into each device
    for (const g of s) {
      expect(close(g.y0, WIRE_Y) && close(g.y1, WIRE_Y)).toBe(true);
      expect(close(g.w, WIRE_W)).toBe(true);
      expect(g.c).toBe(COLOUR.COPPER);
      expect(close(g.z0, 0) && close(g.z1, 0)).toBe(true);
    }
    // Continuous from the battery's foot to the lamp's foot: each half from a knob to a face midpoint, and a lead from the
    // device's face on to its foot, where it is screwed to a brass stud.
    const rb = MODELS[B.VOLTAIC_BATTERY].foot.r;
    const rl = MODELS[B.FILAMENT_LAMP].foot.r;
    const spans = s.map((g) => [Math.min(g.x0, g.x1), Math.max(g.x0, g.x1)]).sort((a, b) => a[0] - b[0]);
    const want = [[rb, 0.5], [0.5, 1], [1, 1.5], [1.5, 2], [2, 2.5], [2.5, 3], [3, 3.5], [3.5, 4 - rl]];
    spans.forEach(([a, b], i) => expect(close(a, want[i][0]) && close(b, want[i][1]), `span ${i}`).toBe(true));
    const studs = knobs(out, KNOB_KIND.POST);
    expect(studs).toHaveLength(2);
    expect(studs.map((p) => p.x).sort((a, b) => a - b).map((x) => Math.round(x * 100) / 100))
      .toEqual([rb + POST_W / 2, 4 - rl - POST_W / 2].map((x) => Math.round(x * 100) / 100));
    expect(studs.every((p) => p.y === 0 && close(p.len, STUD_H))).toBe(true);
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
    expect([...from(board, 0, 0, WIRE_Y), ...from(board, 2, 0, WIRE_Y)].map((g) => g.c).sort()).toEqual([COLOUR.COPPER, COLOUR.BROWN]);
    expect(board.map((g) => g.c).sort()).toEqual([COLOUR.COPPER, COLOUR.COPPER, COLOUR.BROWN, COLOUR.BROWN]); // + the leads
    for (const id of [B.KNIFE_SWITCH, B.PUSH_BUTTON, B.CLOCKWORK_TIMER, B.RELAY, B.COHERER_RECEIVER, B.IGNITER,
      B.SPARK_TRANSMITTER, B.SELENIUM_PANEL, B.BLASTING_MACHINE, B.ELECTRIC_BELL]) {
      const s = segs(build(fakeWorld().set(0, 0, 0, B.COPPER_WIRE).set(1, 0, 0, id, 3)));
      expect(from(s, 0, 0, WIRE_Y), `${id}`).toHaveLength(1);
      expect(s, `${id}`).toHaveLength(2); // and its lead from the device's face to its foot
    }
    // A relay's input face attaches; its other faces are contact terminals: a wire on either side reaches it.
    const relay = fakeWorld().set(1, 0, 0, B.RELAY, 3).set(0, 0, 0, B.COPPER_WIRE).set(2, 0, 0, B.WHITE_WIRE);
    const rs = segs(build(relay));
    expect(from(rs, 0, 0, WIRE_Y)).toHaveLength(1);
    expect(from(rs, 2, 0, WIRE_Y)).toHaveLength(1);
    expect(rs).toHaveLength(4);
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
    expect(knobs(out, KNOB_KIND.KNOB)).toHaveLength(wires);
    expect(knobs(out, KNOB_KIND.TUBE)).toHaveLength(0);
    // Every post (a relay's binding posts, a lead's stud) and clamp (an earth lead's) stands in a device's cell, never on a
    // wire: a wire cell has its knob and nothing else.
    const deviceCells = [...w.cells].filter(([, id]) => MODELS[id]).map(([k]) => hexToWorld(...k.split(',').map(Number).filter((_, i) => i !== 1)));
    for (const p of [...knobs(out, KNOB_KIND.POST), ...knobs(out, KNOB_KIND.CLAMP)]) {
      expect(deviceCells.some(([x, z]) => Math.hypot(p.x - x, p.z - z) < 0.5), `post at ${p.x}, ${p.z}`).toBe(true);
    }
    const relays = [...w.cells.values()].filter((id) => id === B.RELAY).length;
    expect(knobs(out, KNOB_KIND.POST).length).toBeGreaterThanOrEqual(2 * relays);
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
    const strapOut = build(fakeWorld().set(0, 0, 0, B.EARTH_WIRE).set(1, 0, 0, B.VOLTAIC_BATTERY));
    const strap = segs(strapOut);
    const own = strap.filter((g) => Math.max(g.x0, g.x1) <= 0.5 + 1e-6);
    expect(own).toHaveLength(2);
    expect(close(Math.max(...own.map((g) => Math.max(g.x0, g.x1))), 0.5)).toBe(true);
    // The battery's lead carries the stripes on from its face to its foot, where a copper clamp holds it.
    const lead = strap.filter((g) => Math.min(g.x0, g.x1) >= 0.5 - 1e-6);
    expect(lead).toHaveLength(1);
    expect(close(Math.max(lead[0].x0, lead[0].x1), 1 - MODELS[B.VOLTAIC_BATTERY].foot.r)).toBe(true);
    expect(lead[0].c).not.toBe(own.sort((a, b) => a.x0 - b.x0).at(-1).c);
    expect(knobs(strapOut, KNOB_KIND.CLAMP)).toHaveLength(1);
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
      const cord = s.filter((g) => g.c === COLOUR.FUSE && Math.max(g.x0, g.x1) <= 0.5 + 1e-6);
      expect(cord).toHaveLength(4); // the half into the keg and the free half
      expect(close(Math.max(...cord.map((g) => g.x1)), 0.5)).toBe(true);
      expect(s.filter((g) => g.c === COLOUR.FRAY).every((g) => g.x1 < 0)).toBe(true);
      // The keg is a full prism; the charge is a model, so the cord carries on as a lead to its cradle.
      const lead = s.filter((g) => g.c === COLOUR.FUSE && Math.min(g.x0, g.x1) >= 0.5 - 1e-6);
      expect(lead, `${id}`).toHaveLength(id === B.COLLAPSAR_CHARGE ? 1 : 0);
      if (lead.length) expect(close(Math.max(lead[0].x0, lead[0].x1), 1 - MODELS[B.COLLAPSAR_CHARGE].foot.r)).toBe(true);
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

describe('wireSegments: device models, binding posts, range and buffers', () => {
  it('every device draws its model: one body record per part, in its cell, in a known batch, never violet', () => {
    expect(MODEL_IDS).toEqual([B.COLLAPSAR_CHARGE, ...Array.from({ length: 13 }, (_, i) => B.TERMINAL_BOARD + i)]);
    for (const id of MODEL_IDS) {
      const out = build(fakeWorld().set(3, 10, -2, id), 0, 10.5, 0);
      const b = bodies(out);
      expect(b, `${id}`).toHaveLength(MODELS[id].parts.length);
      expect(b.length, `${id}`).toBeGreaterThanOrEqual(2); // a few bold parts …
      expect(b.length, `${id}`).toBeLessThanOrEqual(16); // … never a detailed engraving
      const [cx, cz] = hexToWorld(3, -2);
      for (const p of b) {
        expect(Number.isInteger(p.batch) && p.batch >= 0 && p.batch < BATCHES.length && p.batch !== BATCH.GLOW, `${id}`).toBe(true);
        // Inside its own cell: within the hex inradius of the centre, between the floor and the cell's top.
        const reach = Math.hypot(p.x - cx, p.z - cz) + Math.max(p.sx, p.sz) / 2 * 0.9;
        expect(reach, `${id} part at ${p.x - cx}, ${p.z - cz}`).toBeLessThanOrEqual(0.5);
        expect(p.y - p.sy / 2, `${id}`).toBeGreaterThanOrEqual(10 - 1e-6);
        expect(p.y, `${id}`).toBeLessThanOrEqual(11);
        const { hue, sat } = hs(p.colour);
        expect(sat > 0.15 && hue >= 250 && hue <= 300, `${id} colour ${p.colour.toString(16)}`).toBe(false);
      }
      // A device's own records are its model, and modelPoses gives the same parts.
      const ps = [];
      expect(modelPoses(id, ps, cx, 10, cz, 0)).toBe(b.length);
      if (!partOf(id).input) ps.forEach((p, i) => expect(close(p.x, b[i].x) && close(p.y, b[i].y) && close(p.z, b[i].z)).toBe(true));
      expect(out.knob.count + out.seg.count, `${id}`).toBe(partOf(id).input ? 2 : 0); // a lone device: its binding posts only
    }
    expect(hasModel(B.POWDER_KEG) || hasModel(B.COPPER_WIRE) || hasModel(B.TORCH) || hasModel(B.STONE)).toBe(false);
    expect(modelPoses(B.POWDER_KEG, [])).toBe(0);
  });

  it('the battery is full height (a pile stacks nub to foot), the lamp holds a glass bulb, the charge a lit seam', () => {
    const top = (id) => Math.max(...bodies(build(fakeWorld().set(0, 0, 0, id))).map((p) => p.y + p.sy / 2));
    expect(top(B.VOLTAIC_BATTERY)).toBeCloseTo(1, 6);
    const lamp = bodies(build(fakeWorld().set(0, 0, 0, B.FILAMENT_LAMP)));
    expect(lamp.filter((p) => p.batch === BATCH.GLASS)).toHaveLength(1);
    expect(lamp.find((p) => p.batch === BATCH.GLASS).y).toBeCloseTo(BULB_Y, 6);
    const charge = bodies(build(fakeWorld().set(0, 0, 0, B.COLLAPSAR_CHARGE)));
    expect(charge.filter((p) => p.batch === BATCH.LIT).length).toBeGreaterThanOrEqual(1);
    expect(charge.some((p) => p.batch === BATCH.BALL && p.colour === PAL.black)).toBe(true);
    expect(bodies(build(fakeWorld().set(0, 0, 0, B.ELECTRIC_BELL))).some((p) => p.batch === BATCH.BELL)).toBe(true);
  });

  it('relays, timers and coherers are turned toward their input face, with two brass posts at its foot (on top for the top face)', () => {
    for (const id of [B.RELAY, B.CLOCKWORK_TIMER, B.COHERER_RECEIVER]) {
      const foot = MODELS[id].foot;
      const front = (foot.r ?? foot.hx) + POST_W / 2;
      for (const f of [0, 1, 2, 3, 4, 5]) {
        const out = build(fakeWorld().set(0, 0, 0, id, f));
        const posts = knobs(out, KNOB_KIND.POST);
        expect(posts, `${id} face ${f}`).toHaveLength(2);
        const n = FACE_NORMALS[f];
        for (const p of posts) {
          expect(close(p.x * n[0] + p.z * n[2], front, 1e-5) && p.y === 0 && close(p.len, POST_H)).toBe(true);
        }
        const across = posts.map((p) => -p.x * n[2] + p.z * n[0]).sort((a, b) => a - b);
        expect(close(across[0], -POST_SPREAD, 1e-5) && close(across[1], POST_SPREAD, 1e-5)).toBe(true);
        // The turn record, and the model turned by −60°·f: its parts are face 0's, rotated about the cell's axis.
        expect([...out.turn.data.subarray(0, TURN_STRIDE)]).toEqual([0, 0, 0, f]);
        const base = bodies(build(fakeWorld().set(0, 0, 0, id, 0)));
        const turned = bodies(out);
        const a = -f * (Math.PI / 3);
        turned.forEach((p, i) => {
          const q = base[i];
          expect(close(p.x, Math.cos(a) * q.x + Math.sin(a) * q.z, 1e-5) && close(p.z, -Math.sin(a) * q.x + Math.cos(a) * q.z, 1e-5)).toBe(true);
          expect(close(p.ry, q.ry + a, 1e-6)).toBe(true);
        });
      }
      const topPosts = knobs(build(fakeWorld().set(0, 0, 0, id, 6)), KNOB_KIND.POST);
      expect(topPosts).toHaveLength(2);
      for (const p of topPosts) expect(close(p.y, MODELS[id].top)).toBe(true);
      // Without a stored face, the default (W) is used.
      const def = knobs(wireSegments({ ...fakeWorld().set(0, 0, 0, id).view, inputFace: () => undefined }, 0, 0, 0, 64), KNOB_KIND.POST);
      expect(def.every((p) => p.x < -0.15)).toBe(true);
    }
    for (const id of [B.KNIFE_SWITCH, B.PUSH_BUTTON, B.IGNITER, B.VOLTAIC_BATTERY]) {
      const out = build(fakeWorld().set(0, 0, 0, id));
      expect(out.knob.count + out.turn.count, `${id}`).toBe(0);
    }
  });

  it('draws only the cells within range of the eye (default CIRCUIT_DRAW_RANGE), devices out to DEVICE_DRAW_RANGE', () => {
    const w = fakeWorld().set(0, 0, 0, B.COPPER_WIRE).set(30, 0, 0, B.COPPER_WIRE).set(100, 0, 0, B.COPPER_WIRE);
    expect(build(w, 0, 0.5, 0, 10).knob.count).toBe(1);
    expect(build(w, 0, 0.5, 0, 40).knob.count).toBe(2);
    expect(build(w, 0, 0.5, 0, 200).knob.count).toBe(3);
    expect(wireSegments(w.view, 0, 0.5, 0, NaN).knob.count).toBe(CIRCUIT_DRAW_RANGE >= 100 ? 3 : 2);
    expect(build(w, 100, 0.5, 0, 10).knob.count).toBe(1);
    const d = fakeWorld().set(0, 0, 0, B.VOLTAIC_BATTERY).set(DEVICE_DRAW_RANGE - 4, 0, 0, B.FILAMENT_LAMP).set(DEVICE_DRAW_RANGE + 8, 0, 0, B.RELAY);
    const n = MODELS[B.VOLTAIC_BATTERY].parts.length + MODELS[B.FILAMENT_LAMP].parts.length;
    expect(build(d, 0, 0.5, 0, CIRCUIT_DRAW_RANGE).body.count).toBe(n);
    expect(build(d, 0, 0.5, 0, 500).body.count).toBe(n + MODELS[B.RELAY].parts.length);
    expect(DEVICE_DRAW_RANGE).toBeGreaterThanOrEqual(CIRCUIT_DRAW_RANGE);
  });

  it('reuses and grows the output buffers (adding body and turn to an old one); a missing view gives nothing', () => {
    const w = fakeWorld();
    for (let q = 0; q < 200; q++) w.set(q, 0, 0, B.COPPER_WIRE);
    const out = { seg: { data: new Float32Array(8), count: 99 }, knob: { data: new Float32Array(5), count: 99 } };
    const r = wireSegments(w.view, 100, 0.5, 0, 200, out);
    expect(r).toBe(out);
    expect(out.knob.count).toBe(200);
    expect(out.seg.count).toBe(2 * 198 + 2);
    expect(out.seg.data.length).toBeGreaterThanOrEqual(out.seg.count * SEGMENT_STRIDE);
    expect(out.body.count + out.turn.count).toBe(0);
    for (let q = 0; q < 50; q++) w.set(q, 1, 0, B.RELAY, q % 6);
    wireSegments(w.view, 25, 1.5, 0, 200, out);
    expect(out.body.count).toBe(50 * MODELS[B.RELAY].parts.length);
    expect(out.body.data.length).toBeGreaterThanOrEqual(out.body.count * BODY_STRIDE);
    expect(out.turn.count).toBe(50);
    const again = wireSegments(fakeWorld().view, 0, 0, 0, 64, out);
    expect(again.seg.count + again.knob.count + again.body.count + again.turn.count).toBe(0);
    expect(wireSegments(null, 0, 0, 0, 64, out).seg.count).toBe(0);
  });
});

/** Run overlayPose and return copies of the poses. */
function poses(item, t = 0, face) {
  const out = [];
  const n = overlayPose(item, t, out, face);
  return out.slice(0, n).map((p) => ({ ...p }));
}
const at = (type, extra = {}) => ({ type, q: 3, y: 10, r: -2, a: 0, b: 0, ...extra });
const [CX, CZ] = hexToWorld(3, -2);
/** The top of the cell (a keg's lid, where a keg burning in place shows its spark). */
const TOP = 11;

describe('overlayPose (§4.11)', () => {
  it('blade: the copper lever, hinged at the west cheeks, down in the jaws when closed and raised 65° when open, red knob up', () => {
    const closed = poses(at('blade', { a: 1 }));
    expect(closed).toHaveLength(3);
    expect(closed.map((p) => p.batch)).toEqual([BATCH.BOX, BATCH.CYL, BATCH.BALL]);
    expect(closed[0].rz).toBe(0);
    expect(close(closed[0].x, CX + BLADE_HINGE_X + BLADE_LEN / 2) && close(closed[0].sx, BLADE_LEN)).toBe(true);
    const open = poses(at('blade', { a: 0 }));
    expect(close(open[0].rz, BLADE_OPEN_RAD)).toBe(true);
    expect(close(BLADE_OPEN_RAD, (65 * Math.PI) / 180)).toBe(true);
    // The hinge end stays put: centre − half the lever along its angle is the hinge.
    for (const p of [closed[0], open[0], poses(at('blade', { a: 0.5 }))[0]]) {
      expect(close(p.x - Math.cos(p.rz) * BLADE_LEN / 2, CX + BLADE_HINGE_X) && close(p.y - Math.sin(p.rz) * BLADE_LEN / 2, 10 + BLADE_Y)).toBe(true);
    }
    expect(open[0].y).toBeGreaterThan(closed[0].y + 0.15);
    expect(open[2].y).toBeGreaterThan(open[0].y); // the knob rides the raised free end
    expect(closed[2].y).toBeGreaterThan(closed[0].y + 0.1); // and stands up from it when closed
    expect(closed[2].colour).toBe(PAL.red);
    expect(close(poses(at('blade', { a: 0.5 }))[0].rz, BLADE_OPEN_RAD / 2)).toBe(true);
  });

  it('cap: a big round cap that sinks CAP_TRAVEL while pressed; red, or black for an NC button', () => {
    const up = poses(at('cap'));
    const down = poses(at('cap', { a: 1 }));
    expect(up.map((p) => p.batch)).toEqual([BATCH.CYL, BATCH.BALL]);
    expect(close(up[0].y - down[0].y, CAP_TRAVEL) && close(up[1].y - down[1].y, CAP_TRAVEL)).toBe(true);
    expect(close(CAP_TRAVEL, 0.05)).toBe(true);
    expect(up[0].colour).toBe(PAL.red);
    expect(poses(at('cap', { b: 1 }))[0].colour).not.toBe(up[0].colour);
    expect(down[0].y - down[0].sy / 2).toBeGreaterThanOrEqual(10 + CAP_Y - CAP_TRAVEL - 1e-9); // on its collar
    expect(up[0].sx).toBeGreaterThan(0.3); // big
  });

  it('hand: on the clock\'s upright face, turned with the timer; 12 o\'clock up, clockwise seen from the front; honey while holding', () => {
    const [hx, hy] = HAND_HUB;
    // Face 0: the front is +x, so 3 o'clock (the viewer's right) is −z.
    const up = poses(at('hand', { a: 0 }), 0, 0)[0];
    expect(close(up.x, CX + hx) && close(up.y, 10 + hy + HAND_LEN / 2) && close(up.z, CZ)).toBe(true);
    const three = poses(at('hand', { a: 0.25 }), 0, 0)[0];
    expect(close(three.y, 10 + hy, 1e-9) && close(three.z, CZ - HAND_LEN / 2)).toBe(true);
    const six = poses(at('hand', { a: 0.5 }), 0, 0)[0];
    expect(close(six.y, 10 + hy - HAND_LEN / 2)).toBe(true);
    // The hand's long axis is its direction: Rx(−2πa) turns +y to (0, cos, −sin).
    const p = poses(at('hand', { a: 0.7 }), 0, 0)[0];
    const phi = 2 * Math.PI * 0.7;
    expect(close(p.rx, -phi) && close(p.y - 10 - hy, Math.cos(phi) * HAND_LEN / 2) && close(p.z - CZ, -Math.sin(phi) * HAND_LEN / 2)).toBe(true);
    // Face 3 (the default): the clock faces −x, and 3 o'clock is +z.
    const back = poses(at('hand', { a: 0.25 }), 0, 3)[0];
    expect(close(back.x, CX - hx) && close(back.z, CZ + HAND_LEN / 2)).toBe(true);
    expect(poses(at('hand', { a: 0.25 }), 0)[0]).toEqual(back); // a missing face is the default
    expect(poses(at('hand', { a: 0.3, b: 1 }))[0].colour).toBe(0xe8b04a);
    expect(three.colour).not.toBe(0xe8b04a);
  });

  it('arm: the armature tilts 12° down onto the coil when energised or pushed, turned with the relay; NC relays carry a flag', () => {
    expect(close(poses(at('arm'), 0, 0)[0].rz, 0)).toBe(true);
    expect(close(poses(at('arm', { a: 1 }), 0, 0)[0].rz, -ARM_TILT)).toBe(true);
    expect(close(ARM_TILT, (12 * Math.PI) / 180)).toBe(true);
    // Face 0: it reaches from its pivot at the back over the coil at the front (+x); pulled, its front end drops.
    const rest = poses(at('arm'), 0, 0)[0];
    const pulled = poses(at('arm', { a: 1 }), 0, 0)[0];
    expect(close(rest.x, CX + ARM_PIVOT[0] + ARM_LEN / 2) && close(rest.y, 10 + ARM_PIVOT[1])).toBe(true);
    expect(pulled.y).toBeLessThan(rest.y);
    // Face 3 turns it half round.
    expect(close(poses(at('arm'), 0, 3)[0].x, CX - ARM_PIVOT[0] - ARM_LEN / 2)).toBe(true);
    expect(poses(at('arm', { b: 1 }))).toHaveLength(poses(at('arm')).length + 1);
  });

  it('plunger: the T-handle travels from PLUNGER_UP above the bushing (cocked) to PLUNGER_DOWN (pushed home)', () => {
    const up = poses(at('plunger'));
    const down = poses(at('plunger', { a: 1 }));
    expect(up.map((p) => p.batch)).toEqual([BATCH.CYL, BATCH.CYL, BATCH.BALL, BATCH.BALL]);
    expect(close(up[0].sy, PLUNGER_UP) && close(down[0].sy, PLUNGER_DOWN)).toBe(true);
    expect(close(up[1].y, 10 + PLUNGER_BASE + PLUNGER_UP + 0.045) && close(down[1].y, 10 + PLUNGER_BASE + PLUNGER_DOWN + 0.045)).toBe(true);
    expect(up[1].y + 0.05).toBeLessThanOrEqual(11); // the cocked handle stays inside the cell
    expect(close(poses(at('plunger', { a: 0.5 }))[0].sy, (PLUNGER_UP + PLUNGER_DOWN) / 2)).toBe(true);
  });

  it('hammer: still when silent; jitters within ±10° at 15 Hz while ringing, with flashing "ring" dashes round the bell', () => {
    const still = [0, 0.01, 0.02, 0.033].map((t) => poses(at('hammer'), t)[0].rz);
    expect(new Set(still).size).toBe(1);
    expect(poses(at('hammer'), 0.05)).toHaveLength(2);
    const base = still[0];
    const ring = [];
    for (let k = 0; k < 40; k++) ring.push(poses(at('hammer', { a: 1 }), k / 600)[0].rz);
    for (const rz of ring) expect(Math.abs(rz - base)).toBeLessThanOrEqual(HAMMER_JITTER + 1e-9);
    expect(Math.max(...ring) - Math.min(...ring)).toBeGreaterThan(HAMMER_JITTER * 1.5);
    // 15 Hz: the pose repeats after 1/15 s.
    expect(close(poses(at('hammer', { a: 1 }), 0.013)[0].rz, poses(at('hammer', { a: 1 }), 0.013 + 1 / 15)[0].rz)).toBe(true);
    // The dashes: six unlit yellow bars, on 60 % of each 1/RING_BLINK_HZ period.
    const on = poses(at('hammer', { a: 1 }), 0.1 / RING_BLINK_HZ);
    expect(on).toHaveLength(8);
    expect(on.slice(2).every((p) => p.batch === BATCH.LIT_BOX)).toBe(true);
    expect(poses(at('hammer', { a: 1 }), 0.8 / RING_BLINK_HZ)).toHaveLength(2);
  });

  it('bulb: a dark lamp shows its clear glass only; a lit one fills it with a warm unlit core, brighter as it brightens', () => {
    expect(poses(at('bulb', { a: 0 }))).toHaveLength(0);
    const dim = poses(at('bulb', { a: 0.2 }));
    const full = poses(at('bulb', { a: 1 }));
    expect(full).toHaveLength(1);
    expect(full[0].batch).toBe(BATCH.LIT);
    expect(close(full[0].y, 10 + BULB_Y) && full[0].sx < BULB_D).toBe(true);
    const lum = (c) => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255);
    expect(lum(full[0].colour)).toBeGreaterThan(lum(dim[0].colour));
    expect(BULB_ALPHA).toBe(GLASS_ALPHA);
  });

  it('glow sizes and colours (§4.11); a dark lamp or a spent flash draws nothing; a hot igniter\'s coil glows too', () => {
    const lamp = poses(at('glow', { glow: 'lamp', a: 0.5 }));
    expect(lamp).toHaveLength(1);
    expect(close(lamp[0].sx, GLOW.lamp.size + 0.55 * 0.5) && lamp[0].alpha === 0.5 && lamp[0].colour === 0xffd27a).toBe(true);
    expect(close(lamp[0].y, 10 + BULB_Y)).toBe(true);
    expect(poses(at('glow', { glow: 'lamp', a: 0 }))).toHaveLength(0);
    const sizes = { spark: [0.6, 0xcfe4ff], coherer: [0.35, 0x9fd0ff], charge: [0.14, 0xf4f1ea], fuse: [0.22, 0xffcf6a] };
    for (const [kind, [size, colour]] of Object.entries(sizes)) {
      const p = poses(at('glow', { glow: kind, a: 1, b: -1 }), 1.3);
      expect(p.length, kind).toBeGreaterThanOrEqual(1);
      expect(p[0].batch, kind).toBe(BATCH.GLOW);
      expect(close(p[0].sx, size) && p[0].colour === colour && p[0].sy <= p[0].sx * 1.2, kind).toBe(true);
      expect(p[0].alpha).toBeGreaterThan(0);
      expect(GLOW[kind].size).toBe(size);
    }
    const ig = poses(at('glow', { glow: 'igniter', a: 1 }), 0.4);
    expect(ig).toHaveLength(5);
    expect(ig.slice(0, 4).every((p) => p.batch === BATCH.LIT_BOX)).toBe(true);
    expect(ig[4].batch === BATCH.GLOW && close(ig[4].sx, GLOW.igniter.size) && ig[4].colour === 0xff4a1a).toBe(true);
    expect(poses(at('glow', { glow: 'igniter', a: 0 }))).toHaveLength(0);
    expect(poses(at('glow', { glow: 'spark', a: 0 }))).toHaveLength(0);
    expect(poses(at('glow', { glow: 'coherer', a: 0 }))).toHaveLength(0);
    // The torch's flame: 0.10 wide, taller than wide (drawn as a tongue of flame), with a dim halo.
    const ember = poses(at('glow', { glow: 'ember', a: 1 }), 2);
    expect(ember).toHaveLength(2);
    expect(close(ember[0].sx, 0.1) && ember[0].sy > 1.2 * ember[0].sx && ember[0].colour === 0xff7a2a).toBe(true);
    expect(ember[1].alpha).toBeLessThan(ember[0].alpha);
    // The charge twinkles irregularly on the sphere's crown but never goes out.
    const tw = [];
    for (let k = 0; k < 200; k++) tw.push(poses(at('glow', { glow: 'charge', a: 1 }), k * 0.05)[0].alpha);
    expect(Math.min(...tw)).toBeGreaterThan(0.3);
    expect(Math.max(...tw) - Math.min(...tw)).toBeGreaterThan(0.3);
    const crown = Math.max(...bodies(build(fakeWorld().set(3, 10, -2, B.COLLAPSAR_CHARGE), 0, 10.5, 0))
      .filter((p) => p.batch === BATCH.BALL).map((p) => p.y + p.sy / 2));
    expect(Math.abs(poses(at('glow', { glow: 'charge', a: 1 }))[0].y - crown)).toBeLessThan(0.03);
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
    expect(cold).toHaveLength(5); // two supports and a three-piece carbon loop, inside the bulb, unlit (they glow)
    expect(cold.every((p) => p.batch === BATCH.LIT_BOX)).toBe(true);
    for (const p of cold) expect(Math.hypot(p.x - CX, p.y - 10 - BULB_Y, p.z - CZ)).toBeLessThan(BULB_D / 2);
    expect(cold[2].colour).toBe(0x2a2622);
    expect(hot[2].colour).toBe(0xffe6a8);
    expect(hot[0].colour).toBe(cold[0].colour); // the supports do not glow
  });

  it('writes nothing for unknown types or bad cells, never more than MAX_POSES, and reuses its pose objects', () => {
    expect(poses({ type: 'nope', q: 0, y: 0, r: 0, a: 0, b: 0 })).toHaveLength(0);
    expect(poses(at('blade', { q: NaN }))).toHaveLength(0);
    expect(overlayPose(null, 0, [])).toBe(0);
    const out = [];
    for (const type of Object.keys(MAX_POSES)) {
      for (const extra of [{ a: 1, b: 1 }, { a: 0, b: 0 }, { glow: 'ember', a: 1 }, { staff: 'torch' }, { glow: 'lamp', a: 1 },
        { staff: 'char', a: 1, b: 2 }, { glow: 'igniter', a: 1 }, { staff: 'filament', a: 1 }]) {
        for (const t of [0, 0.4, 0.05]) expect(overlayPose(at(type, extra), t, out, 2)).toBeLessThanOrEqual(MAX_POSES[type]);
      }
    }
    const first = out[0];
    overlayPose(at('cap'), 0, out);
    expect(out[0]).toBe(first);
  });
});
