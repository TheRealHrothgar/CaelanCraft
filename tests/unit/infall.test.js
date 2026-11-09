// Unit tests for src/infall.js — eaten blocks and swallowed mobs spiralling into a vortex (DESIGN-circuits §2.6–§2.7,
// §6.2.5, §7 A).
import { describe, it, expect } from 'vitest';
import { BLOCK } from '../../src/blocks.js';
import {
  INFALL_VIEW_RANGE, MAX_INFALL_BLOCKS, MAX_INFALL_MOBS, INFALL_MIN_S, INFALL_MAX_S, INFALL_MOB_S, VORTEX_EVENT_R,
  VORTEX_SPIRAL_K, PIG_HEIGHT,
} from '../../src/config.js';
import { Infall, infallDuration, infallPose, TEAR, MIN_RHO0, END_SCALE, MOB_END_SCALE } from '../../src/infall.js';
import { BlackHoles } from '../../src/blackholes.js';
import { hexToWorld } from '../../src/hex.js';
import { createBody } from '../../src/physics.js';

const B = BLOCK;
/** An eat record for cell (q, y, r) eaten by the hole at (hq, hy, hr). */
function rec(q, y, r, id = B.STONE, hq = 0, hy = 10, hr = 0) {
  const [cx, cz] = hexToWorld(hq, hr);
  return { q, y, r, id, cx, cy: hy + 0.5, cz };
}
/** Items pushed by renderItems. */
function items(inf) {
  const out = [];
  inf.renderItems((id, x, y, z, rx, ry, rz, scale) => out.push({ id, x, y, z, rx, ry, rz, scale }));
  return out;
}
const EYE = [0, 12, 0];

describe('infallDuration', () => {
  it('D = clamp(0.25 + ρ0^1.5 / 3.6 + 0.1·|h0|, 0.6, 2.4)', () => {
    expect(infallDuration(2, 0)).toBeCloseTo(0.25 + 2 ** 1.5 / 3.6, 12);
    expect(infallDuration(3, -1)).toBeCloseTo(0.25 + 3 ** 1.5 / 3.6 + 0.1, 12);
    expect(infallDuration(0.6, 0)).toBe(INFALL_MIN_S); // 0.38 → clamped up
    expect(infallDuration(8, 3)).toBe(INFALL_MAX_S); // 3.68 → clamped down
    expect([INFALL_MIN_S, INFALL_MAX_S]).toEqual([0.6, 2.4]);
  });
});

describe('infallPose — the normative kinematics', () => {
  it('at s = 0 the pose is the cell itself: its centre, unrotated, full size', () => {
    for (const [rho0, theta0, h0] of [[2, 0.3, 0], [3.4, -2, 1], [1, 2.5, -2]]) {
      const p = infallPose(0, rho0, theta0, h0);
      expect(p.x).toBeCloseTo(rho0 * Math.cos(theta0), 12);
      expect(p.z).toBeCloseTo(rho0 * Math.sin(theta0), 12);
      expect(p.y).toBeCloseTo(h0, 12);
      expect([p.rx, p.ry, p.rz]).toEqual([0, 0, 0]);
      expect(p.scale).toBe(1);
      expect(p.done).toBe(false);
    }
  });
  it('during the tear (s < 0.1) the block lifts 0.8·s and stays on its radius', () => {
    const p = infallPose(0.05, 2, 1, 0.5);
    expect(p.y).toBeCloseTo(0.5 + 0.04, 12);
    expect(p.rho).toBeCloseTo(2, 12);
    expect(p.u).toBe(0);
  });
  it('after the tear ρ falls with a RISING radial speed, θ − θ0 = K·ln(ρ0/ρ), h → 0 and the scale ends at 0.15', () => {
    const rho0 = 3;
    const theta0 = 0.7;
    const h0 = 1.5;
    let lastRho = rho0;
    let lastSpeed = 0;
    let p;
    const N = 400;
    for (let i = 1; i <= N; i++) {
      const s = TEAR + ((1 - TEAR) * i) / N;
      p = infallPose(s, rho0, theta0, h0);
      if (p.done) break;
      const speed = lastRho - p.rho;
      expect(speed).toBeGreaterThan(0);
      expect(speed).toBeGreaterThanOrEqual(lastSpeed - 1e-12); // accelerating plunge
      lastSpeed = speed;
      lastRho = p.rho;
      expect(p.theta - theta0).toBeCloseTo(VORTEX_SPIRAL_K * Math.log(rho0 / p.rho), 9);
      expect(Math.hypot(p.x, p.z)).toBeCloseTo(p.rho, 9);
      expect(Math.atan2(p.z, p.x)).toBeCloseTo(Math.atan2(Math.sin(p.theta), Math.cos(p.theta)), 9);
      expect(p.ry).toBeCloseTo(p.theta + Math.PI / 2, 9);
      expect(p.rx).toBeCloseTo(0.35 * Math.sin(7 * p.u), 9);
      expect(p.rz).toBeCloseTo(6 * p.u * p.u, 9);
    }
    // Just before the end: near the core, near the disk plane, at the end scale.
    const end = infallPose(TEAR + (1 - TEAR) * (1 - (VORTEX_EVENT_R / rho0) ** 1.5) - 1e-9, rho0, theta0, h0);
    expect(end.done).toBe(false);
    expect(end.rho).toBeCloseTo(VORTEX_EVENT_R, 6);
    expect(Math.abs(end.y)).toBeLessThan(0.05 * h0);
    expect(end.scale).toBeCloseTo(END_SCALE, 6);
    expect(END_SCALE).toBe(0.15);
  });
  it('a block from ρ0 = 4 turns 1.16 times on the way in, from 2: 0.79, from 1: 0.43 (§2.6)', () => {
    const turns = (rho0) => (VORTEX_SPIRAL_K * Math.log(rho0 / VORTEX_EVENT_R)) / (2 * Math.PI);
    expect(turns(4)).toBeCloseTo(1.16, 2);
    expect(turns(2)).toBeCloseTo(0.79, 2);
    expect(turns(1)).toBeCloseTo(0.42, 1);
  });
  it('done at ρ ≤ 0.45 (before s = 1) or at s = 1; the h0 never overshoots the plane', () => {
    const at = TEAR + (1 - TEAR) * (1 - (VORTEX_EVENT_R / 2) ** 1.5);
    expect(infallPose(at - 1e-6, 2, 0, 0).done).toBe(false);
    expect(infallPose(at + 1e-6, 2, 0, 0).done).toBe(true);
    expect(infallPose(1, 2, 0, 0).done).toBe(true);
    for (let s = 0; s <= 1; s += 0.01) {
      const p = infallPose(s, 2, 0, -2);
      expect(p.y).toBeLessThanOrEqual(0.08 + 1e-12);
      expect(Number.isFinite(p.x + p.y + p.z + p.rx + p.ry + p.rz + p.scale)).toBe(true);
    }
  });
});

describe('Infall — eaten blocks', () => {
  it('a flight starts exactly on the cell and is removed at the core with a `gone` point there', () => {
    const inf = new Infall(() => 0.5);
    const r = rec(3, 10, 0);
    expect(inf.addBlock(r, ...EYE)).toBe(true);
    expect(inf.size).toBe(1);
    expect(inf.blocks).toBe(1);
    const [px, pz] = hexToWorld(3, 0);
    expect(items(inf)).toEqual([{ id: B.STONE, x: px, y: 10.5, z: pz, rx: 0, ry: 0, rz: 0, scale: 1 }]);
    const D = infallDuration(3, 0);
    let t = 0;
    let gone = null;
    while (t < D + 0.1) {
      const res = inf.step(1 / 60);
      t += 1 / 60;
      if (res.gone.length) {
        gone = [...res.gone];
        break;
      }
      const [it] = items(inf);
      expect(it.scale).toBeGreaterThan(0);
    }
    expect(gone).toEqual([r.cx, r.cy, r.cz]);
    expect(t).toBeLessThanOrEqual(D + 1e-9);
    expect(inf.size).toBe(0);
    expect(items(inf)).toEqual([]);
  });
  it('the tear shudders (±0.03) but is still at the cell at s = 0, and the copy spirals the +θ way', () => {
    const inf = new Infall(() => 0.5);
    inf.addBlock(rec(2, 10, 0), ...EYE);
    const [px] = hexToWorld(2, 0);
    inf.step(0.02);
    const [a] = items(inf);
    expect(Math.abs(a.x - px)).toBeLessThanOrEqual(0.03 + 1e-9);
    let last = 0;
    let unwrapped = 0;
    for (let i = 0; i < 40; i++) {
      inf.step(1 / 60);
      const its = items(inf);
      if (!its.length) break;
      const th = Math.atan2(its[0].z, its[0].x);
      let d = th - last;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      if (i > 6) unwrapped += d;
      last = th;
    }
    expect(unwrapped).toBeGreaterThan(0.5);
  });
  it('a cell straight above the core (ρ0 = 0) still swirls in: ρ0 is clamped to 0.6 at a seeded angle', () => {
    const inf = new Infall(() => 0.25); // θ0 = π/2
    inf.addBlock(rec(0, 13, 0), ...EYE); // 3 cells above the hole
    const [s0] = items(inf);
    expect([s0.x, s0.z]).toEqual(hexToWorld(0, 0)); // the tear starts on the cell itself
    inf.step(infallDuration(MIN_RHO0, 3) * TEAR);
    const [s1] = items(inf);
    expect(Math.hypot(s1.x, s1.z)).toBeCloseTo(MIN_RHO0, 1); // on the clamped radius once the tear is over
    let maxTurn = 0;
    for (let i = 0; i < 200; i++) {
      inf.step(1 / 120);
      const its = items(inf);
      if (!its.length) break;
      maxTurn = Math.max(maxTurn, Math.atan2(its[0].z, its[0].x) - Math.PI / 2);
    }
    expect(maxTurn).toBeGreaterThan(0.3);
  });
  it('skips cells farther than INFALL_VIEW_RANGE from the eye, unmeshed ids, and records without a centre', () => {
    const inf = new Infall();
    const [fx, fz] = hexToWorld(INFALL_VIEW_RANGE + 5, 0);
    expect(inf.addBlock(rec(INFALL_VIEW_RANGE + 5, 10, 0, B.STONE, INFALL_VIEW_RANGE + 6), 0, 10.5, 0)).toBe(false);
    expect(inf.addBlock(rec(INFALL_VIEW_RANGE + 5, 10, 0, B.STONE, INFALL_VIEW_RANGE + 6), fx - 10, 10.5, fz)).toBe(true);
    for (const id of [B.CAMPFIRE, B.BLACK_HOLE, B.TORCH, B.COPPER_WIRE, B.POWDER_FUSE]) expect(inf.addBlock(rec(1, 10, 0, id), ...EYE), String(id)).toBe(false);
    expect(inf.addBlock({ q: 1, y: 10, r: 0, id: B.STONE }, ...EYE)).toBe(false); // a v0.5 record: no centre
    expect(inf.addBlock(rec(1, 10, 0, B.COLLAPSAR_CHARGE), ...EYE)).toBe(true); // cabinets are meshed
    expect(inf.size).toBe(2);
  });
  it(`at ${MAX_INFALL_BLOCKS} flights the oldest finishes at once (its gone point comes with the next step)`, () => {
    const inf = new Infall(() => 0.5);
    for (let i = 0; i < MAX_INFALL_BLOCKS; i++) inf.addBlock(rec(3, 10 + (i % 4), 0, B.STONE, 0, 10, 0), ...EYE);
    // One more, eaten by another hole (centre (30, 10.5, 0)): the oldest stone flight finishes at once.
    expect(inf.addBlock(rec(32, 10, 0, B.DIRT, 30, 10, 0), 30, 12, 0)).toBe(true);
    expect(inf.blocks).toBe(MAX_INFALL_BLOCKS);
    expect(items(inf).filter((i) => i.id === B.DIRT)).toHaveLength(1);
    expect(items(inf).filter((i) => i.id === B.STONE)).toHaveLength(MAX_INFALL_BLOCKS - 1);
    const res = inf.step(0);
    expect(res.gone).toEqual([0, 10.5, 0]); // the oldest's core, reported by the next step
    expect(inf.step(0).gone).toEqual([]);
  });
  it('dt = 0 freezes; clear() drops everything without reporting', () => {
    const inf = new Infall(() => 0.5);
    inf.addBlock(rec(2, 10, 0), ...EYE);
    inf.step(0.2);
    const a = items(inf)[0];
    inf.step(0);
    expect(items(inf)[0]).toEqual(a);
    inf.step(-1);
    expect(items(inf)[0]).toEqual(a);
    inf.clear();
    expect(inf.size).toBe(0);
    expect(inf.step(1).gone).toEqual([]);
  });
  it('works with the eat records of a real BlackHoles.update', () => {
    const cells = new Map([['1,10,0', B.STONE], ['0,9,0', B.SAND]]);
    const holes = new BlackHoles();
    holes.add(0, 10, 0);
    const world = {
      getBlock: (q, y, r) => cells.get(`${q},${y},${r}`) ?? B.AIR,
      setBlock: (q, y, r, id) => (id === B.AIR ? cells.delete(`${q},${y},${r}`) : cells.set(`${q},${y},${r}`, id), true),
      isLoaded: () => true,
    };
    const inf = new Infall(() => 0.5);
    let added = 0;
    for (let i = 0; i < 10; i++) for (const e of holes.update(0.2, world)) added += inf.addBlock(e, ...EYE) ? 1 : 0;
    expect(added).toBe(2);
    expect(items(inf).map((i) => i.id).sort()).toEqual([B.STONE, B.SAND].sort());
  });
});

describe('Infall — mob ghosts', () => {
  const pigBody = (x, y, z) => Object.assign(createBody(x, y, z, { radius: 0.42, height: PIG_HEIGHT, mass: 0.7 }), { yaw: 0.4, walkPhase: 0, hurt: 0 });
  it('a ghost shrinks (renderScale 1 → 0.1), spins (renderSpin) and spirals in over INFALL_MOB_S, then is reported in mobsDone', () => {
    const inf = new Infall(() => 0.5);
    const [cx, cz] = hexToWorld(0, 0);
    const pig = pigBody(cx + 2.5, 10, cz);
    expect(inf.addMob('pig', pig, cx, 10.5, cz)).toBe(true);
    expect(inf.mobs).toBe(1);
    expect(pig.renderScale).toBe(1);
    expect(pig.renderSpin).toBe(0);
    expect(pig.x).toBeCloseTo(cx + 2.5, 9);
    expect(pig.y).toBeCloseTo(10, 9); // its feet stay where they were at the start
    expect(inf.ghosts('pig')).toEqual([pig]);
    expect(inf.ghosts('zombie')).toEqual([]);
    const list = ['someone'];
    expect(inf.ghosts('pig', list)).toEqual(['someone', pig]); // appends (main: pigs.list + ghosts)
    let lastScale = 1;
    let lastSpin = 0;
    let done = null;
    let t = 0;
    while (t < INFALL_MOB_S + 0.1) {
      const res = inf.step(1 / 60);
      t += 1 / 60;
      if (res.mobsDone.length) {
        done = { ...res.mobsDone[0], gone: [...res.gone] };
        break;
      }
      expect(pig.renderScale).toBeLessThanOrEqual(lastScale + 1e-12);
      expect(pig.renderSpin).toBeGreaterThanOrEqual(lastSpin);
      lastScale = pig.renderScale;
      lastSpin = pig.renderSpin;
    }
    expect(done.kind).toBe('pig');
    expect(done.body).toBe(pig);
    expect(done.gone).toEqual([cx, 10.5, cz]);
    expect(t).toBeLessThanOrEqual(INFALL_MOB_S + 1e-9);
    expect(lastScale).toBeLessThan(0.3);
    expect(lastScale).toBeGreaterThanOrEqual(MOB_END_SCALE);
    expect(lastSpin).toBeGreaterThan(1);
    expect(inf.ghosts('pig')).toEqual([]);
  });
  it(`at most ${MAX_INFALL_MOBS} ghosts; a body is never a ghost twice; zombies are kept apart from pigs`, () => {
    const inf = new Infall(() => 0.5);
    const zb = pigBody(3, 10, 0);
    expect(inf.addMob('zombie', zb, 0, 10.5, 0)).toBe(true);
    expect(inf.addMob('zombie', zb, 0, 10.5, 0)).toBe(false);
    for (let i = 1; i < MAX_INFALL_MOBS; i++) expect(inf.addMob('pig', pigBody(3 + i, 10, 0), 0, 10.5, 0)).toBe(true);
    expect(inf.addMob('pig', pigBody(2, 10, 0), 0, 10.5, 0)).toBe(false);
    expect(inf.ghosts('zombie')).toEqual([zb]);
    expect(inf.ghosts('pig')).toHaveLength(MAX_INFALL_MOBS - 1);
    expect(inf.size).toBe(MAX_INFALL_MOBS);
  });
  it('a mob standing on the core still swirls in, and its velocity is held at zero', () => {
    const inf = new Infall(() => 0);
    const pig = pigBody(0, 10, 0);
    pig.vx = 3;
    inf.addMob('pig', pig, 0, 10.5, 0);
    expect(pig.vx).toBe(0);
    inf.step(0.3);
    expect(Math.hypot(pig.x, pig.z)).toBeLessThan(MIN_RHO0);
    expect(Math.hypot(pig.x, pig.z)).toBeGreaterThan(0.2);
  });
});
