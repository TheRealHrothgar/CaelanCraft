// Caelancraft — the collapsar visuals (three): arming glow, implosion shell, black core, shadow with its beamed photon
// ring and the lensed far side of the disk, and the dark two-arm spiral disk whose bright dashes stream inward.
// See docs/DESIGN-circuits.md §2.4 and §6.2.6 (CONTRACTS §54 once integrated).
//
// Every element is ONE InstancedMesh for all holes, so the vortices cost 4 draw calls in all however many are visible:
//   core       a 24-segment black sphere, radius VORTEX_CORE_R (MeshBasicMaterial, fogged), popping in when a vortex forms
//   billboard  a camera-facing VORTEX_BILLBOARD-square quad: the shadow (2.6× the core: light bends around it), the photon
//              ring (brighter on the limb whose disk motion approaches you: relativistic beaming) and, for `full` views,
//              the lensed band (the far side of the disk bent over and under the shadow, strongest edge-on)
//   disk       RingGeometry(0.5, 3.4) laid flat: two stationary dark arms along the inflow spiral, dashes sliding inward
//              at the particles' speed, thin glowing lanes between the arms (blackbody: deep red → white-hot)
//   shell      a glowing icosphere: the white-hot arming glow, the FLASH bloom and the collapsing IMPLODE shell
// Cores and billboards are drawn for every view (up to VORTEX_MAX_CORES); disks and shells only for `full` views.
// Instances are placed by a per-instance `aCentre` attribute (the core uses its instance matrix), so every mesh has
// `frustumCulled = false`; the billboard, disk and shell use renderOrder 2 (after the translucent chunk layer).
//
// The palette is blackbody (soot, deep red, orange, white): no hue between 250° and 300° anywhere. The shaders mirror
// vortexMath.js term for term (diskArms, diskFlow, beamVector, bandSense), which is where the directions are tested.
//
// Settled here (the design leaves them open), and tuned against headless-Chrome screenshots of every phase:
// - Draw order. The billboard is drawn before the disk (both transparent, renderOrder 2, equal depth: three keeps
//   creation order), so the disk's near half crosses in front of the shadow, as in the real images. The disk's far half
//   must not: its shader finds where the ray to each fragment crosses the shadow's plane (the billboard's plane through
//   the centre) and fades a fragment behind that plane by the shadow's own alpha there, eased across the plane.
// - CONTRACT-ISSUE: §2.3 FLASH draws the charge copy "under the arming glow", while §2.4.4 draws the shell only in ARM
//   and IMPLODE. The shell also draws the FLASH bloom (a soft white ball around the swelling copy); the arming glow sits
//   on the charge's top face, where its lens holds the pinprick (centred in the cell, the opaque block hid it).
// - CONTRACT-ISSUE: the §2.4.3 disk shader is "normative in intent"; its constants are tuned so the vortex reads BLACK:
//   broader arms (smoothstep 0.12–0.8, not 0.2–0.85; vortexMath.diskArms matches), lanes pow(1 − a, 8) instead of 6 and
//   fading out before the rim, a throat darkening toward the core, and lanes opaque enough that the ground or sky never
//   tints them (semi-transparent red over sky or sand read pink). The arms, dashes, directions and speeds are unchanged.
// - CONTRACT-ISSUE: the lensed band (§2.4.2) is a thin arc (r 0.86–1.45, ru 0.9–2.4) weighted over the top of the
//   shadow (under it from below), at (1 − |v.y|)^1.5 rather than sqrt: the full-width band looked like a target's rings
//   from above.
// - Colours are written in sRGB and the shaders skip colorspace_fragment (see vec3Of).
import * as THREE from 'three';
import { VORTEX_BILLBOARD, VORTEX_CORE_R, VORTEX_MAX_CORES, VORTEX_SPIRAL_K } from './config.js';
import { flowPhase, DISK_INNER_R, DISK_OUTER_R } from './vortexMath.js';

/** @typedef {import('./types.js').VortexView} VortexView */

const INITIAL_CAPACITY = 16;
const MAX_CAPACITY = VORTEX_MAX_CORES;
const TAU = Math.PI * 2;
/** prewarm's hidden instance for the core: a speck far below the world. */
const WARM_MATRIX = new THREE.Matrix4().makeTranslation(0, -1e4, 0).multiply(new THREE.Matrix4().makeScale(1e-6, 1e-6, 1e-6));

/**
 * sRGB hex → GLSL vec3 literal, IN sRGB. Unlike the project's other ShaderMaterials these shaders do not end with
 * colorspace_fragment: their light is premultiplied by its coverage, and the blend happens in the framebuffer's (sRGB)
 * space, so converting a premultiplied value would brighten every faint glow (a 30 % lane would land near 58 %).
 */
function vec3Of(hex) {
  const c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => (v / 255).toFixed(5));
  return `vec3(${c[0]}, ${c[1]}, ${c[2]})`;
}

// Palette (sRGB, §2.4): the ring #ffd9a0 → white; the disk's lanes deep red → orange → white-hot; the shell white →
// #b03a1a.
const RING_WARM = vec3Of(0xffd9a0);
const DISK_RED = vec3Of(0x8c1f0d); // (0.55, 0.12, 0.05) of §2.4.3, as sRGB
const DISK_ORANGE = vec3Of(0xff7a1e);
const DISK_HOT = vec3Of(0xffe4bc); // (1.0, 0.85, 0.65), a little whiter
const SHELL_RED = vec3Of(0xb03a1a);
const ARM_WARM = vec3Of(0xffd8a8);

/** GLSL shared by the billboard's band and the disk: vortexMath.diskArms / diskFlow. */
const PATTERN = /* glsl */ `
#define VX_K ${VORTEX_SPIRAL_K.toFixed(4)}
float vxArms(float ru, float th, float seed) {
  return smoothstep(0.12, 0.8, 0.5 + 0.5 * sin(2.0 * (th + 6.2832 * seed) + 2.0 * VX_K * log(ru)));
}
float vxFlow(float ru, float phase) {
  return 0.5 + 0.5 * sin(5.0 * pow(ru, 1.5) + phase);
}
// Blackbody: deep red far out, orange, white-hot at the inner edge (heat 0..1).
vec3 vxGlow(float heat) {
  return heat < 0.5 ? mix(${DISK_RED}, ${DISK_ORANGE}, heat * 2.0) : mix(${DISK_ORANGE}, ${DISK_HOT}, heat * 2.0 - 1.0);
}
// The disk at radius ru, angle th: x = how dark (0..1, alpha), y = how much the fiery lanes glow.
vec2 vxDisk(float ru, float th, float seed, float phase) {
  float arms = vxArms(ru, th, seed);
  float a = arms * mix(0.45, 1.0, vxFlow(ru, phase));
  float heat = 1.0 - smoothstep(0.55, 2.4, ru);
  // A whirlpool's throat: the whole disk darkens toward the core, and the arms are near black.
  float throat = 0.32 + 0.5 * (1.0 - smoothstep(0.5, 3.0, ru));
  float dark = min(0.97, throat + 0.75 * a);
  // Thin glowing lanes between the arms (the gas between them), hotter toward the inner edge; they die out before the
  // rim, which stays dark smoke (a faint red glow over a bright sky or sand would read as pink).
  float lane = pow(1.0 - a, 8.0) * (0.2 + 0.8 * heat) * (1.0 - smoothstep(2.0, 3.0, ru));
  return vec2(dark, lane);
}
`;

/** Premultiplied output fades into the fog (both the light and the darkening): the fog chunk's factor, applied as (1 − f). */
const FOG_PREMULTIPLIED = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float vxFog = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float vxFog = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  gl_FragColor *= 1.0 - vxFog;
#endif
`;

const BILLBOARD_VERTEX = /* glsl */ `
attribute vec3 aCentre;
attribute vec4 aParams;   // seed, s, strength, phase
attribute float aFull;
varying vec2 vLocal;      // world units from the centre, along the camera's right and up
varying vec4 vParams;
varying float vFull;
varying vec2 vBeam;       // vortexMath.beamVector
varying float vSense;     // vortexMath.bandSense
varying float vEdge;      // (1 − |v.y|)^1.5: the lensed band is strongest edge-on, faint from above
#include <fog_pars_vertex>
void main() {
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vLocal = position.xy;
  vec3 world = aCentre + camRight * position.x + camUp * position.y;
  vec3 v = normalize(aCentre - cameraPosition);
  vec3 bWorld = vec3(-v.z, 0.0, v.x);
  vBeam = vec2(dot(bWorld, camRight), dot(bWorld, camUp));
  vSense = cameraPosition.y >= aCentre.y ? 1.0 : -1.0;
  vEdge = pow(max(0.0, 1.0 - abs(v.y)), 1.5);
  vParams = aParams;
  vFull = aFull;
  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const BILLBOARD_FRAGMENT = /* glsl */ `
uniform float uPhase;
varying vec2 vLocal;
varying vec4 vParams;
varying float vFull;
varying vec2 vBeam;
varying float vSense;
varying float vEdge;
#include <fog_pars_fragment>
${PATTERN}
void main() {
  float seed = vParams.x;
  float s = vParams.y;
  float strength = vParams.z;
  float phase = vParams.w;
  // The shadow appears as the implosion ends; the photon ring flares for 0.25 s when the core pops in (VORTEX s 0 → 1).
  float vis = phase > 2.5 ? 1.0 : (phase > 1.5 ? smoothstep(0.72, 1.0, s) : 0.0);
  float r = length(vLocal);
  if (vis <= 0.0 || r > 1.8) discard;
  vec2 q = r > 1e-4 ? vLocal / r : vec2(0.0, 1.0);
  float flare = phase > 2.5 ? 1.0 - s : 0.0;
  float weak = 0.55 + 0.45 * strength;
  // 1. The shadow.
  float a = 0.92 * (1.0 - smoothstep(0.7, 0.86, r)) * vis * weak;
  // 2. The photon ring, beamed toward the approaching limb.
  float ring = smoothstep(0.72, 0.75, r) * (1.0 - smoothstep(0.775, 0.81, r));
  float beam = dot(q, vBeam);
  vec3 ringColor = mix(${RING_WARM}, vec3(1.0), clamp(0.5 + 0.5 * beam, 0.0, 1.0));
  vec3 rgb = ringColor * ring * (1.0 + 0.6 * beam) * (0.8 + 3.0 * flare) * strength * vis;
  a = max(a, ring * 0.6 * vis); // the ring is light on black, never on the world behind
  // 3. The lensed far side of the disk: the same arms and inward dashes, in screen angle, bent over the shadow — mostly
  //    over its top seen from above the disk (under it from below), and strongest edge-on.
  if (vFull > 0.5) {
    float env = smoothstep(0.8, 0.9, r) * (1.0 - smoothstep(1.12, 1.45, r));
    float over = mix(0.35, 1.0, smoothstep(-0.3, 0.7, q.y * vSense));
    float k = 0.85 * vEdge * strength * vis * env * over;
    if (k > 0.002) {
      float phi = atan(q.y, q.x) * vSense;
      float ru = mix(0.9, 2.4, clamp((r - 0.86) / 0.5, 0.0, 1.0));
      vec2 d = vxDisk(ru, phi, seed, uPhase);
      vec3 glow = vxGlow(min(1.0, 0.25 + (1.0 - smoothstep(0.55, 2.4, ru))));
      rgb += glow * d.y * k * (1.0 + 0.4 * beam) * (1.0 - a);
      a += min(1.0, max(d.x, d.y) * 1.1) * k * (1.0 - a);
    }
  }
  if (a < 0.004 && max(rgb.r, max(rgb.g, rgb.b)) < 0.004) discard;
  gl_FragColor = vec4(rgb, a);
  ${FOG_PREMULTIPLIED}
}
`;

const DISK_VERTEX = /* glsl */ `
attribute vec3 aCentre;
attribute vec4 aParams;
varying vec3 vRel;        // world offset from the centre (the disk is flat: y = 0)
varying vec3 vCentre;
varying vec4 vParams;
#include <fog_pars_vertex>
void main() {
  vRel = position;
  vCentre = aCentre;
  vParams = aParams;
  vec4 mvPosition = viewMatrix * vec4(aCentre + position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const DISK_FRAGMENT = /* glsl */ `
uniform float uPhase;
varying vec3 vRel;
varying vec3 vCentre;
varying vec4 vParams;
#include <fog_pars_fragment>
${PATTERN}
void main() {
  float seed = vParams.x;
  float s = vParams.y;
  float strength = vParams.z;
  float phase = vParams.w;
  // The disk spins up out of the implosion: it grows outward from the core over its last 45 %.
  float grow = phase > 2.5 ? 1.0 : smoothstep(0.55, 1.0, s);
  float ru = length(vRel.xz);                      // θ from WORLD coordinates, exactly as pullAt measures it
  float reach = mix(0.6, 3.5, grow);
  if (grow <= 0.0 || ru > reach) discard;
  float th = atan(vRel.z, vRel.x);
  float fade = (1.0 - smoothstep(2.5, 3.4, ru)) * (1.0 - smoothstep(reach - 0.5, reach, ru)) * smoothstep(0.5, 0.56, ru);
  vec2 d = vxDisk(ru, th, seed, uPhase) * fade;    // the BLACK vortex: it darkens what is behind it …
  vec3 glow = vxGlow(1.0 - smoothstep(0.55, 2.4, ru));
  // … and only its lanes emit light, opaque enough that the world behind never tints them.
  gl_FragColor = vec4(glow * d.y * 1.35 * strength, max(d.x, d.y * 0.95) * strength);   // premultiplied (it glows)
  // The far half, behind the shadow's plane, is hidden by the shadow (drawn before, so it must be undone here).
  vec3 fwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 toP = vCentre + vRel - cameraPosition;
  float depthP = dot(toP, fwd);
  float depthC = dot(vCentre - cameraPosition, fwd);
  float behind = smoothstep(-0.15, 0.15, depthP - depthC); // eased across the plane: no hard cut through the shadow
  if (behind > 0.0 && depthP > 1e-4) {
    float rb = length(cameraPosition + toP * (depthC / depthP) - vCentre);
    float vis = phase > 2.5 ? 1.0 : smoothstep(0.72, 1.0, s);
    gl_FragColor *= 1.0 - behind * 0.92 * (1.0 - smoothstep(0.7, 0.86, rb)) * vis * (0.55 + 0.45 * strength);
  }
  if (gl_FragColor.a < 0.01) discard;
  ${FOG_PREMULTIPLIED}
}
`;

const SHELL_VERTEX = /* glsl */ `
attribute vec3 aCentre;
attribute vec4 aParams;
varying vec3 vNormal;
varying vec3 vView;
varying vec4 vParams;
#include <fog_pars_vertex>
float shellRadius(float phase, float s) {
  if (phase < 0.5) return 0.08 + 0.52 * s * s;          // ARM: the pinprick in the lens swells to white-hot
  if (phase < 1.5) return 0.85 + 1.5 * sqrt(s);         // FLASH: a white bloom over the swelling charge
  return 3.2 + (0.3 - 3.2) * s * s * s;                 // IMPLODE: the shell of light collapses, ease-in-cubic
}
void main() {
  float rad = shellRadius(aParams.w, aParams.y);
  // The arming glow sits on the charge's top face, where its lens holds the pinprick; the rest at the centre.
  vec3 world = aCentre + vec3(0.0, aParams.w < 0.5 ? 0.5 : 0.0, 0.0) + position * rad;
  vNormal = normalize(position);
  vView = cameraPosition - world;
  vParams = aParams;
  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const SHELL_FRAGMENT = /* glsl */ `
uniform float uTime;
varying vec3 vNormal;
varying vec3 vView;
varying vec4 vParams;
#include <fog_pars_fragment>
void main() {
  float seed = vParams.x;
  float s = vParams.y;
  float strength = vParams.z;
  float phase = vParams.w;
  float facing = abs(dot(normalize(vNormal), normalize(vView)));
  float fres = 1.0 - facing;
  vec3 color;
  float I;
  if (phase < 0.5) {
    float twinkle = 0.82 + 0.18 * sin(uTime * 47.0 + seed * 40.0) * sin(uTime * 13.0 + seed * 9.0);
    I = (0.6 + 1.4 * s * s) * pow(facing, 1.2) * twinkle;
    color = mix(${ARM_WARM}, vec3(1.0), s);
  } else if (phase < 1.5) {
    float k = 1.0 - s;
    I = 2.4 * k * k * pow(facing, 2.5); // soft to the limb: no faceted edge
    color = vec3(1.0, 0.96, 0.9);
  } else {
    // A rim of light just inside the limb, fading to nothing at the limb itself (no faceted outline).
    I = (0.08 + 1.5 * pow(fres, 2.5)) * smoothstep(0.0, 0.22, facing) * (0.5 + 0.5 * s);
    color = mix(vec3(1.0), ${SHELL_RED}, smoothstep(0.0, 0.8, s));
  }
  // Premultiplied: the light adds, and the deep-red shell also covers part of what is behind it (red light merely added
  // to a blue sky reads pink). The white arming glow and flash stay nearly additive.
  float cover = phase > 1.5 ? 0.75 * smoothstep(0.2, 0.9, s) : 0.1;
  gl_FragColor = vec4(color * I * strength, min(1.0, I) * cover * strength);
  ${FOG_PREMULTIPLIED}
}
`;

/**
 * @typedef {Object} VortexRenderer
 * @property {(views: VortexView[], t: number, eye?: ArrayLike<number>) => void} sync   draw these views (nearest
 *   first, blackHoles.vortexViews); t is the effect clock in seconds (uTime; uPhase advances by its change)
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm  compile the four programs now
 * @property {() => number} count       views drawn by the last sync
 * @property {() => void} dispose
 * @property {THREE.Group} group        the four meshes (tests, diagnostics)
 */

/**
 * @typedef {Object} Layer  one InstancedMesh and its per-instance attributes, regrown by doubling
 * @property {string} name
 * @property {THREE.BufferGeometry} base   the shared shape
 * @property {THREE.Material} material
 * @property {[string, number][]} attrs     per-instance attributes: name, item size
 * @property {number} renderOrder
 * @property {number} cap
 * @property {THREE.InstancedMesh} mesh
 * @property {Record<string, THREE.InstancedBufferAttribute>} buffers
 */

/**
 * @param {THREE.Scene} scene
 * @returns {VortexRenderer}
 */
export function createVortexRenderer(scene) {
  const group = new THREE.Group();
  group.name = 'vortices';
  scene.add(group);
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uPhase: { value: 0 }, uTime: { value: 0 } }]);
  const premultiplied = {
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    premultipliedAlpha: true,
    fog: true,
  };

  const coreGeo = new THREE.SphereGeometry(1, 24, 16);
  const billboardGeo = new THREE.PlaneGeometry(VORTEX_BILLBOARD, VORTEX_BILLBOARD);
  const diskGeo = new THREE.RingGeometry(DISK_INNER_R, DISK_OUTER_R, 96, 1);
  diskGeo.rotateX(-Math.PI / 2); // flat; θ is taken from world x, z in the shader (RingGeometry's local +y → world −z)
  // CONTRACT-ISSUE: §2.4.4 says IcosahedronGeometry(1, 2); at the shell's 3.2-unit start its silhouette shows facets up
  // close, so detail 3 (1280 triangles; at most 16 shells are drawn).
  const shellGeo = new THREE.IcosahedronGeometry(1, 3);

  const coreMat = new THREE.MeshBasicMaterial({ color: 0x000000, fog: true });
  const billboardMat = new THREE.ShaderMaterial({
    uniforms, vertexShader: BILLBOARD_VERTEX, fragmentShader: BILLBOARD_FRAGMENT, ...premultiplied, depthWrite: false,
  });
  const diskMat = new THREE.ShaderMaterial({
    uniforms, vertexShader: DISK_VERTEX, fragmentShader: DISK_FRAGMENT, ...premultiplied,
    depthWrite: false, side: THREE.DoubleSide,
  });
  diskMat.forceSinglePass = true; // one draw call (three draws a transparent DoubleSide material in two passes)
  // CONTRACT-ISSUE: §2.4.4 says additive blending; premultiplied (light added, plus a little cover as it reddens) keeps
  // the late shell deep red over a blue sky instead of pink. Early in ARM and FLASH it is nearly additive.
  const shellMat = new THREE.ShaderMaterial({
    uniforms, vertexShader: SHELL_VERTEX, fragmentShader: SHELL_FRAGMENT, ...premultiplied, depthWrite: false,
  });

  /** Meshes that still owe their hidden warm-up draw (prewarm). */
  const warming = new Set();
  /** @type {Layer[]} in draw order: core (opaque), billboard, disk (its near half over the shadow), shell */
  const layers = [
    makeLayer('vortex-core', coreGeo, coreMat, [], 0),
    makeLayer('vortex-billboard', billboardGeo, billboardMat, [['aCentre', 3], ['aParams', 4], ['aFull', 1]], 2),
    makeLayer('vortex-disk', diskGeo, diskMat, [['aCentre', 3], ['aParams', 4]], 2),
    makeLayer('vortex-shell', shellGeo, shellMat, [['aCentre', 3], ['aParams', 4]], 2),
  ];
  const [core, billboard, disk, shell] = layers;

  /** @returns {Layer} */
  function makeLayer(name, base, material, attrs, renderOrder) {
    /** @type {Layer} */
    const layer = { name, base, material, attrs, renderOrder, cap: 0, mesh: /** @type {*} */ (null), buffers: {} };
    grow(layer, INITIAL_CAPACITY);
    return layer;
  }

  /**
   * Give `layer` room for `need` instances (doubling from INITIAL_CAPACITY, at most MAX_CAPACITY). The mesh itself is
   * kept and given a bigger geometry and instance matrix: three draws equal-depth transparent objects in creation (id)
   * order, so a new mesh would change the billboard → disk → shell order that the disk's far-half mask relies on.
   */
  function grow(layer, need) {
    let cap = Math.max(layer.cap, INITIAL_CAPACITY);
    while (cap < need && cap < MAX_CAPACITY) cap *= 2;
    cap = Math.min(cap, MAX_CAPACITY);
    if (cap === layer.cap) return;
    const geometry = layer.base.clone();
    layer.buffers = {};
    for (const [attr, size] of layer.attrs) {
      const buf = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
      buf.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(attr, buf);
      layer.buffers[attr] = buf;
    }
    let mesh = layer.mesh;
    if (mesh) {
      const oldGeometry = mesh.geometry;
      mesh.geometry = geometry;
      oldGeometry.dispose();
      mesh.dispose(); // frees the old instance-matrix buffer; three re-attaches its listener on the next draw
      mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    } else {
      mesh = new THREE.InstancedMesh(geometry, layer.material, cap);
      mesh.name = layer.name;
      mesh.frustumCulled = false; // placed by aCentre (and moving): three's bounds would be wrong
      mesh.renderOrder = layer.renderOrder;
      mesh.count = 0;
      mesh.visible = false;
      mesh.userData.n = 0;
      const self = mesh;
      mesh.onAfterRender = () => {
        if (!warming.delete(self)) return;
        if (self.userData.n === 0) {
          self.count = 0;
          self.visible = false;
        }
      };
      group.add(mesh);
      layer.mesh = mesh;
    }
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    layer.cap = cap;
  }

  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  let drawn = 0;
  let lastT = NaN;
  let phase = 0;

  /** The core's pop-in when a vortex forms (an ease-out-back over the 0.25 s flare); 0 before VORTEX. */
  function corePop(v) {
    if (v.phase !== 3) return 0;
    const s = Math.min(1, Math.max(0, v.s));
    const c = 1.70158;
    const k = s - 1;
    return 1 + (c + 1) * k * k * k + c * k * k;
  }

  /** Write one view's centre and params into a layer's attributes at slot i. */
  function put(layer, i, v) {
    const c = layer.buffers.aCentre.array;
    c[i * 3] = v.cx;
    c[i * 3 + 1] = v.cy;
    c[i * 3 + 2] = v.cz;
    const p = layer.buffers.aParams.array;
    p[i * 4] = v.seed;
    p[i * 4 + 1] = v.s;
    p[i * 4 + 2] = v.strength;
    p[i * 4 + 3] = v.phase;
  }

  function finish(layer, n) {
    const mesh = layer.mesh;
    mesh.userData.n = n;
    if (warming.has(mesh)) {
      if (n === 0) return; // still owes its hidden warm-up draw
      warming.delete(mesh);
    }
    mesh.count = n;
    mesh.visible = n > 0;
    if (n === 0) return;
    if (layer === core) mesh.instanceMatrix.needsUpdate = true;
    for (const buf of Object.values(layer.buffers)) {
      buf.needsUpdate = true;
      buf.clearUpdateRanges();
      buf.addUpdateRange(0, n * buf.itemSize);
    }
  }

  /**
   * @param {VortexView[]} views
   * @param {number} t
   * @param {ArrayLike<number>} [_eye] unused: the shaders read the camera
   */
  function sync(views, t, _eye) {
    const list = Array.isArray(views) ? views : [];
    const n = Math.min(list.length, MAX_CAPACITY);
    let full = 0;
    let shells = 0;
    let on = n === 0;
    for (let i = 0; i < n; i++) {
      const v = list[i];
      if (v.strength > 0.5) on = true;
      if (!v.full) continue;
      if (v.phase >= 2) full++; // the disk shows from the implosion on
      if (v.phase < 3) shells++;
    }
    if (n > core.cap) grow(core, n);
    if (n > billboard.cap) grow(billboard, n);
    if (full > disk.cap) grow(disk, full);
    if (shells > shell.cap) grow(shell, shells);
    // uPhase advances by the clock's change, a tenth as fast while black holes are switched off (vortexMath.flowPhase).
    const dt = Number.isFinite(t) && Number.isFinite(lastT) ? Math.min(0.25, Math.max(0, t - lastT)) : 0;
    lastT = Number.isFinite(t) ? t : lastT;
    phase = (phase + flowPhase(dt, on)) % TAU;
    uniforms.uPhase.value = phase;
    uniforms.uTime.value = Number.isFinite(t) ? t % 3600 : 0;
    let nd = 0;
    let ns = 0;
    quat.identity();
    const aFull = billboard.buffers.aFull.array;
    for (let i = 0; i < n; i++) {
      const v = list[i];
      const r = VORTEX_CORE_R * corePop(v);
      pos.set(v.cx, v.cy, v.cz);
      scl.set(r, r, r);
      m4.compose(pos, quat, scl);
      core.mesh.setMatrixAt(i, m4);
      put(billboard, i, v);
      aFull[i] = v.full ? 1 : 0;
      if (v.full && v.phase >= 2 && nd < disk.cap) put(disk, nd++, v);
      if (v.full && v.phase < 3 && ns < shell.cap) put(shell, ns++, v);
    }
    finish(core, n);
    finish(billboard, n);
    finish(disk, nd);
    finish(shell, ns);
    drawn = n;
  }

  /**
   * Compile the four programs while the game loads (after every light exists, CONTRACTS §32.2), and draw one hidden
   * instance of each in the next rendered frame (some drivers only finish a program on its first draw): a core speck
   * far below the world and zero-strength instances the shaders discard. sync keeps them until each mesh has been
   * drawn once or has instances of its own. Never throws.
   * @param {*} webgl a THREE.WebGLRenderer (anything without compile/compileAsync only gets the warm-up draw)
   * @param {THREE.Camera} camera
   * @returns {Promise<void>}
   */
  function prewarm(webgl, camera) {
    for (const layer of layers) {
      const mesh = layer.mesh;
      if (mesh.userData.n > 0) continue;
      if (layer === core) {
        mesh.setMatrixAt(0, WARM_MATRIX);
        mesh.instanceMatrix.needsUpdate = true;
      } else {
        put(layer, 0, { cx: 0, cy: -1e4, cz: 0, seed: 0, s: 0, strength: 0, phase: 0 });
        for (const buf of Object.values(layer.buffers)) buf.needsUpdate = true;
      }
      mesh.count = 1;
      mesh.visible = true;
      warming.add(mesh);
    }
    const meshes = layers.map((l) => l.mesh);
    try {
      if (webgl && typeof webgl.compileAsync === 'function') {
        return Promise.all(meshes.map((m) => webgl.compileAsync(m, camera, scene))).then(() => {}, () => {});
      }
      if (webgl && typeof webgl.compile === 'function') for (const m of meshes) webgl.compile(m, camera, scene);
    } catch {
      // A failed compile only brings back the one-off compile on first use.
    }
    return Promise.resolve();
  }

  function dispose() {
    warming.clear();
    scene.remove(group);
    for (const layer of layers) {
      group.remove(layer.mesh);
      layer.mesh.geometry.dispose();
      layer.mesh.dispose();
      layer.base.dispose();
      layer.material.dispose();
    }
    drawn = 0;
  }

  return { sync, prewarm, count: () => drawn, dispose, group };
}
