// Caelancraft — the vortex's shapes and directions, in plain JavaScript (DESIGN-circuits §2.4, §6.2.6). Pure.
//
// vortexRenderer's shaders draw the disk's two dark arms, its inward-streaming dashes, the beamed photon ring and the
// lensed far side of the disk. The GLSL mirrors these functions term for term, so the directions that matter — the
// dashes slide INWARD at the particles' speed, and moving inward along an arm turns the same way as pullAt's swirl —
// are unit-tested here rather than eyeballed in a screenshot.
//
// Angles follow CONTRACTS §0: θ = atan2(z − cz, x − cx), measured from +X toward +Z, exactly as in pullAt, so +θ is
// the swirl's sense (−vz, 0, vx).
import { VORTEX_SPIRAL_K, VORTEX_FLOW_RATE } from './config.js';

const TAU = Math.PI * 2;

/** The disk ring's radii (RingGeometry inner and outer, world units). */
export const DISK_INNER_R = 0.5;
export const DISK_OUTER_R = 3.4;
/** The photon-ring flare when a vortex forms lasts this long (§2.3: "a 0.25 s photon-ring flare"). */
export const FORM_FLARE_S = 0.25;

/** GLSL smoothstep. */
export function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * The flow's dash phase, the disk shader's `uPhase`: (VORTEX_FLOW_RATE · t · (enabled ? 1 : 0.1)) mod 2π, in [0, 2π).
 * vortexRenderer accumulates it frame by frame (`phase += flowPhase(dt, enabled)`), so switching black holes off
 * slows the dashes to a tenth without a jump.
 * @param {number} t seconds
 * @param {boolean} enabled the per-world `blackholes` switch
 */
export function flowPhase(t, enabled) {
  const p = (VORTEX_FLOW_RATE * t * (enabled ? 1 : 0.1)) % TAU;
  return p < 0 ? p + TAU : p;
}

/**
 * The two stationary trailing arms: 1 on an arm, 0 in the lanes between them. Arm crests satisfy
 * 2·(θ + 2π·seed) + 2·K·ln ρ = π/2 (mod 2π), so dθ/d ln ρ = −K along a crest: moving inward turns +θ. The smoothstep
 * edges are 0.12–0.8 (§2.4.3 wrote 0.2–0.85): broader arms, thinner lanes, a blacker vortex (vortexRenderer's notes).
 * @param {number} rho distance from the centre in the disk plane
 * @param {number} theta atan2(z − cz, x − cx)
 * @param {number} seed 0..1
 */
export function diskArms(rho, theta, seed = 0) {
  return smoothstep(0.12, 0.8, 0.5 + 0.5 * Math.sin(2 * (theta + TAU * seed) + 2 * VORTEX_SPIRAL_K * Math.log(rho)));
}

/**
 * The dashes: 0.5 + 0.5·sin(5·ρ^1.5 + uPhase). A crest keeps 5·ρ^1.5 + uPhase constant, so as uPhase grows at
 * VORTEX_FLOW_RATE (9 rad/s) the crest's radius falls at dρ/dt = −9 / (7.5·√ρ) = −1.2/√ρ: the particles' inflow
 * speed (§6.2.10).
 * @param {number} rho
 * @param {number} uPhase flowPhase(t, …)
 */
export function diskFlow(rho, uPhase) {
  return 0.5 + 0.5 * Math.sin(5 * Math.pow(rho, 1.5) + uPhase);
}

/**
 * The disk's darkness `a` (§2.4.3) at a point (x, z) relative to the hole's centre, at time t (black holes on):
 * arms × mix(0.45, 1, flow). The disk shader draws `a` as black (the vortex darkens what is behind it) and lights
 * only the lanes between the arms.
 * @param {number} x
 * @param {number} z
 * @param {number} t seconds
 * @param {number} [seed]
 */
export function diskPattern(x, z, t, seed = 0) {
  const rho = Math.hypot(x, z);
  if (!(rho > 0)) return 0;
  const arms = diskArms(rho, Math.atan2(z, x), seed);
  const flow = diskFlow(rho, flowPhase(t, true));
  return arms * (0.45 + 0.55 * flow);
}

/**
 * The beamed limb's direction on screen (§2.4.2): v = normalize(centre − eye), bWorld = (−v.z, 0, v.x) — the limb
 * whose +θ disk motion points at the camera — and bScreen = (bWorld·right, bWorld·up). It depends only on the view,
 * never on time, and has length 0 seen from straight above or below.
 * @param {ArrayLike<number>} eye [x, y, z]
 * @param {ArrayLike<number>} centre [x, y, z]
 * @param {ArrayLike<number>} right the camera's right unit vector (world)
 * @param {ArrayLike<number>} up the camera's up unit vector (world)
 * @param {number[]} [out]
 * @returns {number[]} out = [x, y]
 */
export function beamVector(eye, centre, right, up, out = [0, 0]) {
  const vx = centre[0] - eye[0];
  const vy = centre[1] - eye[1];
  const vz = centre[2] - eye[2];
  const len = Math.hypot(vx, vy, vz);
  if (!(len > 0)) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  const bx = -vz / len; // v = (centre − eye) / len; bWorld = (−v.z, 0, v.x)
  const bz = vx / len;
  out[0] = bx * right[0] + bz * right[2];
  out[1] = bx * up[0] + bz * up[2];
  return out;
}

/**
 * The lensed band's rotation sense: +1 when the eye is above the disk plane (or on it), −1 below.
 * @param {number} eyeY
 * @param {number} cy the hole centre's y
 */
export function bandSense(eyeY, cy) {
  return eyeY >= cy ? 1 : -1;
}
