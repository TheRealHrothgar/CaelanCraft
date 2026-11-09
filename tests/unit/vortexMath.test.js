// Unit tests for src/vortexMath.js — the vortex shaders' shapes and directions in plain JS (DESIGN-circuits §2.4,
// §6.2.6, §7 A): the dashes stream inward at the particles' speed, the arms turn the same way as pullAt's swirl, the
// photon ring is beamed toward the approaching limb.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { VORTEX_FLOW_RATE, VORTEX_SPIRAL_K, VORTEX_INFLOW } from '../../src/config.js';
import {
  diskPattern, diskArms, diskFlow, flowPhase, beamVector, bandSense, smoothstep, DISK_INNER_R, DISK_OUTER_R,
} from '../../src/vortexMath.js';
import { BlackHoles } from '../../src/blackholes.js';

/** The local maximum of f(r) within ±half of r0, by a fine scan. */
function crestNear(f, r0, half = 0.25) {
  let best = r0;
  let bestV = -Infinity;
  for (let r = r0 - half; r <= r0 + half; r += 1e-4) {
    const v = f(r);
    if (v > bestV) {
      bestV = v;
      best = r;
    }
  }
  return best;
}

describe('flowPhase', () => {
  it('uPhase = (VORTEX_FLOW_RATE · t) mod 2π, a tenth of the rate when switched off', () => {
    expect(VORTEX_FLOW_RATE).toBe(9);
    expect(flowPhase(0, true)).toBe(0);
    expect(flowPhase(0.1, true)).toBeCloseTo(0.9, 12);
    expect(flowPhase(0.1, false)).toBeCloseTo(0.09, 12);
    expect(flowPhase(1, true)).toBeCloseTo(9 - 2 * Math.PI, 12);
    for (const t of [3, 17.25, 1e4]) {
      const p = flowPhase(t, true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(2 * Math.PI);
    }
    expect(flowPhase(-0.1, true)).toBeCloseTo(2 * Math.PI - 0.9, 12);
  });
});

describe('diskPattern', () => {
  it('is arms × mix(0.45, 1, flow), 0 at the centre, within 0..1', () => {
    for (const [x, z, t, seed] of [[1, 0.5, 0, 0], [-2, 2, 1.3, 0.25], [0.3, -3, 7, 0.9]]) {
      const rho = Math.hypot(x, z);
      const a = diskArms(rho, Math.atan2(z, x), seed) * (0.45 + 0.55 * diskFlow(rho, flowPhase(t, true)));
      expect(diskPattern(x, z, t, seed)).toBeCloseTo(a, 12);
    }
    expect(diskPattern(0, 0, 1)).toBe(0);
    for (let i = 0; i < 200; i++) {
      const v = diskPattern(Math.cos(i) * (0.5 + i / 70), Math.sin(i * 1.3) * 3, i * 0.05, (i % 7) / 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect([DISK_INNER_R, DISK_OUTER_R]).toEqual([0.5, 3.4]);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
  });
  it('at a fixed angle, a dash crest slides INWARD over time at dρ/dt ≈ −1.2/√ρ (the particles’ inflow)', () => {
    for (const r0 of [1, 2, 3]) {
      const dt = 0.004;
      const crest0 = crestNear((r) => diskFlow(r, flowPhase(5, true)), r0);
      const crest1 = crestNear((r) => diskFlow(r, flowPhase(5 + dt, true)), crest0, 0.05);
      const speed = (crest1 - crest0) / dt;
      expect(speed, `ρ ≈ ${r0}`).toBeLessThan(0);
      expect(speed).toBeCloseTo(-VORTEX_INFLOW / Math.sqrt(crest0), 1);
    }
  });
  it('the full pattern shows the same: on an arm crest (arms = 1) its maximum moves inward', () => {
    // On the arm crest curve 2θ + 2K·ln ρ = π/2 the arms term is 1, so diskPattern = 0.45 + 0.55·flow there.
    const onArm = (r, t) => {
      const th = Math.PI / 4 - VORTEX_SPIRAL_K * Math.log(r);
      return diskPattern(r * Math.cos(th), r * Math.sin(th), t);
    };
    const r0 = crestNear((r) => onArm(r, 2), 2);
    const r1 = crestNear((r) => onArm(r, 2.02), r0, 0.1);
    expect(r1).toBeLessThan(r0);
    expect((r1 - r0) / 0.02).toBeCloseTo(-VORTEX_INFLOW / Math.sqrt(r0), 0);
  });
  it('moving inward along an arm crest INCREASES θ — the same sense as pullAt’s swirl (−vz, 0, vx)', () => {
    // The crest angle at each radius (one of the two arms), by scanning θ.
    const crestTheta = (rho, near) => {
      let best = near;
      let bestV = -1;
      for (let th = near - 0.6; th <= near + 0.6; th += 1e-4) {
        const v = Math.sin(2 * th + 2 * VORTEX_SPIRAL_K * Math.log(rho)); // the arms' carrier: its peak is the crest
        if (v > bestV) {
          bestV = v;
          best = th;
        }
      }
      return best;
    };
    let th = Math.PI / 4 - VORTEX_SPIRAL_K * Math.log(3);
    let prev = th;
    for (let rho = 2.9; rho >= 0.6; rho -= 0.1) {
      th = crestTheta(rho, prev);
      expect(th).toBeGreaterThan(prev);
      expect(diskArms(rho, th)).toBe(1);
      prev = th;
    }
    // pullAt's tangential part at the same kind of point turns +θ as well.
    const holes = new BlackHoles();
    holes.add(0, 0, 0); // centre (0, 0.5, 0)
    const [x, z] = [2 * Math.cos(1), 2 * Math.sin(1)];
    const [ax, , az] = holes.pullAt(x, 0.5, z);
    expect(ax * -z + az * x).toBeGreaterThan(0); // positive along (−vz, vx): +θ
    // dθ/d ln ρ along the arm is −K: half a turn needs only ln ρ to fall by π/K.
    expect(VORTEX_SPIRAL_K).toBeCloseTo(4 / VORTEX_INFLOW, 2);
  });
});

describe('beamVector', () => {
  /** Camera basis (right, up) for an eye looking at `target`. */
  function basis(eye, target) {
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(...eye);
    cam.lookAt(...target);
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    return { right: [e[0], e[1], e[2]], up: [e[4], e[5], e[6]] };
  }
  it('points at the limb whose +θ disk motion approaches the camera', () => {
    for (const eye of [[0, 0.5, -10], [7, 2, 3], [-4, -1, -6], [0.5, 4, 9]]) {
      const c = [0, 0, 0];
      const { right, up } = basis(eye, c);
      const [bx, by] = beamVector(eye, c, right, up);
      expect(Math.hypot(bx, by)).toBeGreaterThan(0.1);
      // The disk point on that limb: centre + (right·bx + up·by) projected onto the disk plane, at radius 2.
      let px = right[0] * bx + up[0] * by;
      let pz = right[2] * bx + up[2] * by;
      const len = Math.hypot(px, pz);
      px = (2 * px) / len;
      pz = (2 * pz) / len;
      const th = Math.atan2(pz, px);
      const vel = [-Math.sin(th), Math.cos(th)]; // +θ motion
      const toEye = [eye[0] - px, eye[2] - pz];
      expect(vel[0] * toEye[0] + vel[1] * toEye[1], `eye ${eye}`).toBeGreaterThan(0);
    }
  });
  it('never depends on time (no time input; the same view gives the same vector) and is 0 from straight above or below', () => {
    const eye = [3, 2, -8];
    const { right, up } = basis(eye, [0, 0, 0]);
    const a = beamVector(eye, [0, 0, 0], right, up, [0, 0]);
    expect(beamVector(eye, [0, 0, 0], right, up)).toEqual(a);
    const top = basis([0, 10, 0.0001], [0, 0, 0]);
    expect(Math.hypot(...beamVector([0, 10, 0], [0, 0, 0], top.right, top.up))).toBeLessThan(1e-9);
    expect(Math.hypot(...beamVector([0, -10, 0], [0, 0, 0], top.right, top.up))).toBeLessThan(1e-9);
    expect(beamVector([1, 1, 1], [1, 1, 1], top.right, top.up)).toEqual([0, 0]);
  });
});

describe('bandSense', () => {
  it('+1 above the disk plane (or on it), −1 below', () => {
    expect(bandSense(12, 10.5)).toBe(1);
    expect(bandSense(10.5, 10.5)).toBe(1);
    expect(bandSense(9, 10.5)).toBe(-1);
  });
});
