// Caelancraft — Three.js renderer. Implements src/CONTRACTS.md §17.
//
// Owns: the WebGLRenderer, scene, camera, the three shared chunk materials, one Mesh per non-empty
// layer per chunk, lights, fog, the sky dome (+ sun/moon sprites and stars), the block highlight and
// the Survival dig trace (docs/DESIGN-survival.md §9.9: the targeted cell's hex outline drawn in honey
// as you dig — there are no crack textures).
// Nothing here touches WebGL or the DOM at import time — only createRenderer() does.
//
// Colour spaces (SPEC-engine §2/§3): every SkyState colour is sRGB, so it enters Three via
// `Color.setRGB(r, g, b, SRGBColorSpace)` and is stored in the linear working space. The sky-dome
// ShaderMaterial therefore ends its fragment shader with `#include <colorspace_fragment>` so its
// output is converted exactly like the fog/lights of the Lambert materials (otherwise the dome
// horizon would not match the fog colour).
//
// DESIGN NOTE (adjudicated, see CONTRACTS §17): SPEC-gameplay §6 (referenced by CONTRACTS §17 "sun/moon sprites ... per §6") prescribes
// `depthTest:false` for the sun/moon sprites. Three's SpriteMaterial defaults to `transparent:true`, which
// puts the sprite in the transparent pass AFTER every chunk mesh; with the depth test off the 60-block sun
// square is then composited over hills, tree canopies and player-built walls near sunrise/sunset. The
// prescribed `renderOrder −1` only has its evident intent (drawn before the terrain, overdrawn by it) when
// the sprite is in the OPAQUE pass, so this file keeps every §6 parameter verbatim and additionally sets
// `transparent:false` + `alphaTest:0.5` (a parameter §6 does not constrain). Recommended spec amendment:
// simply say `depthTest:true, depthWrite:false` — the dome and stars do not write depth, so that also works.
//
// Light (CONTRACTS §62, lightShader.js): the three chunk materials read the meshes' `caelLight` attribute (sky and block
// levels per vertex); every other lit material reads the light volume around the camera, which render() keeps filled
// from the light field main hands setLightField (world.light). setSky feeds `caelDaylight`; the sun, moon and sky
// lights keep their computeSky intensities, scaled in the shader by the sky level's brightness.

import * as THREE from 'three';
import {
  FOV,
  CAMERA_NEAR,
  CAMERA_FAR,
  MAX_PIXEL_RATIO,
  RENDER_DISTANCE,
  FOG_FAR_CHUNK_MARGIN,
  LIGHT_VOLUME_RECENTRE,
  LIGHT_VOLUME_MIN_S,
} from './config.js';
import { CHUNK_RING_INRADIUS, HEX_CORNERS, HEX_SIZE, chunkOrigin, hexToWorld, hexLength, worldToHex } from './hex.js';
import { LIGHT_ATTRIBUTE, applyChunkLight, installObjectLighting, lightVolume } from './lightShader.js';
import { compileHidden } from './prewarm.js';

/** @typedef {import('./types.js').MeshData} MeshData */
/** @typedef {import('./types.js').ChunkMeshData} ChunkMeshData */
/** @typedef {import('./types.js').RaycastHit} RaycastHit */
/** @typedef {import('./types.js').SkyState} SkyState */
/**
 * The renderer's view of the light (light.js LightEngine satisfies it).
 * @typedef {{ version: number, fillVolume: (q0: number, r0: number, n: number, out: Uint8Array) => void }} LightField
 */

/**
 * @typedef {Object} Renderer
 * @property {{ renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera }} three
 * @property {(key: string, cq: number, cr: number, meshData: ChunkMeshData|null|undefined) => void} setChunkMesh
 * @property {(key: string) => void} removeChunkMesh
 * @property {(x: number, y: number, z: number, yaw: number, pitch: number) => void} setCamera
 * @property {(fov: number) => void} setFov
 * @property {() => Promise<void>} prewarm   compile the highlight, dig trace and chunk programs now (§72)
 * @property {(hit: RaycastHit|null|undefined) => void} setHighlight
 * @property {(hit: {q: number, y: number, r: number}|null|undefined, p: number) => void} setDigProgress
 *   Survival hold-to-dig feedback (DESIGN-survival §9.9): traces the first 2·ceil(12·p) line vertices of the cell's
 *   hex outline (6 vertical + 6 top edges, clockwise from the north corner) in honey; hidden for a null hit or p ≤ 0
 * @property {(sky: SkyState) => void} setSky
 * @property {(on: boolean) => void} setUnderwater
 * @property {(chunks: number) => void} setRenderDistance
 * @property {(width: number, height: number) => void} resize
 * @property {() => void} render
 * @property {() => { chunkMeshes: number, triangles: number, drawCalls: number, geometries: number }} getStats
 * @property {(field: LightField|null) => void} setLightField  where the light volume for everything but the chunks
 *   comes from (§62: world.light); null → everything outside the chunks reads open sky
 * @property {() => void} onContextRestored  assignable hook (additive to CONTRACTS §17): fired after a WebGL
 *   context loss/restore, once every chunk mesh has been dropped — the owner must re-mesh (see buildLayerGeometry)
 * @property {() => void} dispose
 */

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Underwater fog (SPEC-gameplay §7): colour #204A8C, near 1, far 22, light ×0.7. */
export const UNDERWATER_FOG_COLOR = 0x204a8c;
export const UNDERWATER_FOG_NEAR = 1;
export const UNDERWATER_FOG_FAR = 22;
export const UNDERWATER_LIGHT_FACTOR = 0.7;

export const SKY_DOME_RADIUS = 500;
export const SUN_DISTANCE = 400;
export const SUN_SPRITE_SCALE = 60;
export const STAR_COUNT = 600;
export const STAR_RADIUS = 490;
export const HIGHLIGHT_SIZE = 1.002;
/** Dig trace (DESIGN-survival §9.9): honey #e8b04a, drawn after the black highlight (renderOrder 2). */
export const DIG_TRACE_COLOR = 0xe8b04a;
export const DIG_TRACE_RENDER_ORDER = 3;
/** The trace's line segments: the highlight prism's 6 vertical and 6 top edges. */
export const DIG_TRACE_SEGMENTS = 12;
/**
 * The hex corners (hex.HEX_CORNERS indices) in trace order: clockwise as seen from above with north (−Z) up and east
 * (+X) right, starting at the north corner (corner 5, at −Z). That is the order of increasing corner angle 60°k − 30°.
 */
// CONTRACT-ISSUE: DESIGN-survival §9.9 says the trace runs "clockwise from the north corner" without a frame, and
// CONTRACTS §0 calls this same direction (increasing face/corner index, E → SE → …) "counter-clockwise seen from +Y with
// +X right and +Z down", although on that very picture (and on screen when the player looks down facing north) it turns
// clockwise. The trace follows what the player sees: clockwise on a north-up top view. Reverse this list (5, 4, 3, …)
// if the integrator reads "clockwise" in CONTRACTS' wording instead.
export const DIG_TRACE_CORNER_ORDER = Object.freeze([5, 0, 1, 2, 3, 4]);
/** Sun glow strength added by the sky dome shader at full daylight. */
export const SKY_GLOW = 1.0;

/** Sun/moon sprites are hidden once this far below the horizon (unit-direction y). */
const HORIZON_HIDE_Y = -0.12;

/** Ground colour of the hemisphere light = fog colour scaled by this (bounce light is darker). */
const HEMI_GROUND_FACTOR = 0.45;

/** Sky-dome shaders — SPEC-gameplay §6 verbatim, plus the output colour-space conversion (see header). */
export const SKY_VERTEX_SHADER = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = normalize(wp.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const SKY_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uGlow;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(uZenith, uHorizon, pow(1.0 - h, 3.0));
  // Soft atmospheric glow around the sun: a wide low-power halo plus a tight bright core.
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * uGlow * (0.35 * pow(s, 8.0) + 0.5 * pow(s, 64.0));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/**
 * Sky used until the first setSky() call (≈ the noon keyframe of SPEC-gameplay §6), so render()
 * before the day/night module has run still produces a sane frame.
 * @type {SkyState}
 */
export const DEFAULT_SKY = Object.freeze({
  time: 0.5,
  isDay: true,
  sunDir: /** @type {[number, number, number]} */ ([0, 0.9701, 0.2425]),
  sunColor: /** @type {[number, number, number]} */ ([1.0, 0.9725, 0.9176]),
  sunIntensity: 2.0,
  hemiIntensity: 1.4,
  zenithColor: /** @type {[number, number, number]} */ ([0.4275, 0.6549, 1.0]),
  horizonColor: /** @type {[number, number, number]} */ ([0.749, 0.8627, 1.0]),
  fogColor: /** @type {[number, number, number]} */ ([0.7137, 0.8275, 0.9686]),
  daylight: 1,
  stars: 0,
});

// ---------------------------------------------------------------------------------------------
// Small pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------

/**
 * Fog distances for a render distance in chunks. The meshed region is a hexagon of chunks whose inradius is
 * CHUNK_RING_INRADIUS per ring, so far = (chunks + FOG_FAR_CHUNK_MARGIN) * CHUNK_RING_INRADIUS keeps the fog
 * inside the geometry; near = far * 0.55.
 * @param {number} chunks
 * @returns {{ near: number, far: number }}
 */
export function fogRangeForRenderDistance(chunks) {
  const rd = Number.isFinite(chunks) ? Math.max(1, chunks) : RENDER_DISTANCE;
  const far = Math.max(CHUNK_RING_INRADIUS, (rd + FOG_FAR_CHUNK_MARGIN) * CHUNK_RING_INRADIUS);
  return { near: far * 0.55, far };
}

/**
 * Deterministic PRNG (mulberry32) so the star field is identical on every run. Private copy —
 * the renderer must not depend on noise.js and never calls Math.random.
 * @param {number} seed uint32
 * @returns {() => number} in [0, 1)
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Positions of `count` stars distributed uniformly over a sphere of `radius`.
 * @param {number} count
 * @param {number} radius
 * @param {number} [seed]
 * @returns {Float32Array} 3 floats per star
 */
export function generateStarPositions(count, radius, seed = 0xc0ffee) {
  const rng = mulberry32(seed);
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const y = rng() * 2 - 1; // uniform in [-1, 1) → uniform on the sphere
    const theta = rng() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    out[i * 3] = Math.cos(theta) * r * radius;
    out[i * 3 + 1] = y * radius;
    out[i * 3 + 2] = Math.sin(theta) * r * radius;
  }
  return out;
}

/**
 * Line vertices of the dig trace to draw at progress `p` (DESIGN-survival §9.9): 2·ceil(12·p), p clamped to 0..1;
 * anything that is not a finite number draws nothing.
 * @param {number} p
 * @returns {number} 0..2·DIG_TRACE_SEGMENTS, always even
 */
export function digTraceVertexCount(p) {
  const t = typeof p === 'number' && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
  return 2 * Math.ceil(DIG_TRACE_SEGMENTS * t);
}

/**
 * Vertex positions of the dig trace, relative to (hexToWorld(q, r), cell y): the 18-edge highlight prism's 6 vertical
 * and 6 top edges (same corners at HEX_SIZE·HIGHLIGHT_SIZE, same height HIGHLIGHT_SIZE centred on y + 0.5), ordered
 * as the trace is drawn — for each corner of DIG_TRACE_CORNER_ORDER: its vertical edge bottom → top, then the top
 * edge to the next corner. So a partial draw range climbs the north corner first and walks the rim clockwise.
 * @returns {Float32Array} DIG_TRACE_SEGMENTS · 2 vertices · 3 floats
 */
export function digTracePositions() {
  const out = new Float32Array(DIG_TRACE_SEGMENTS * 2 * 3);
  const bottom = 0.5 - HIGHLIGHT_SIZE / 2;
  const top = 0.5 + HIGHLIGHT_SIZE / 2;
  let o = 0;
  const vertex = (/** @type {number} */ corner, /** @type {number} */ y) => {
    out[o++] = HEX_CORNERS[corner][0] * HIGHLIGHT_SIZE;
    out[o++] = y;
    out[o++] = HEX_CORNERS[corner][1] * HIGHLIGHT_SIZE;
  };
  const n = DIG_TRACE_CORNER_ORDER.length;
  for (let i = 0; i < n; i++) {
    const c = DIG_TRACE_CORNER_ORDER[i];
    const next = DIG_TRACE_CORNER_ORDER[(i + 1) % n];
    vertex(c, bottom); // vertical edge at this corner
    vertex(c, top);
    vertex(c, top); // top edge to the next corner clockwise
    vertex(next, top);
  }
  return out;
}

/**
 * True when a MeshData layer has something to draw.
 * @param {MeshData|null|undefined} layer
 * @returns {layer is MeshData}
 */
export function isDrawableLayer(layer) {
  if (!layer) return false;
  const vc = layer.vertexCount ?? (layer.positions ? layer.positions.length / 3 : 0);
  const ic = layer.indices ? layer.indices.length : 0;
  return vc > 0 && ic > 0 && !!layer.positions && !!layer.normals && !!layer.uvs && !!layer.colors;
}

/**
 * BufferAttribute.onUpload callback: drop the CPU copy once the data is on the GPU. Three keeps
 * `attribute.array` alive after `gl.bufferData` by default; nothing in Caelancraft reads it afterwards
 * (the bounding sphere is computed once below, block picking is the voxel raycast, and a re-mesh replaces
 * the whole geometry), so keeping it would mirror every uploaded vertex buffer in JS memory
 * (~400 KB per chunk, ~90 MB at the default render distance, ~450 MB at ?rd=16).
 * `count` / `itemSize` are stored properties and stay valid; `this.array = null` only makes the attribute
 * unusable for a RE-upload, which is why createRenderer() drops all chunk meshes on `webglcontextrestored`.
 * @this {THREE.BufferAttribute}
 */
function releaseCpuArray() {
  this.array = /** @type {*} */ (null);
}

/**
 * Build a BufferGeometry from a MeshData's typed arrays (no copies: the arrays are adopted; when a
 * growable buffer is longer than vertexCount/faceCount a subarray view is used). Every attribute
 * releases its CPU array right after the first GPU upload (see releaseCpuArray).
 * @param {MeshData} layer
 * @returns {THREE.BufferGeometry}
 */
export function buildLayerGeometry(layer) {
  const vertexCount = layer.vertexCount > 0 ? layer.vertexCount : layer.positions.length / 3;
  const indexCount = layer.indexCount > 0 ? layer.indexCount : layer.indices.length;

  const positions = trimTyped(layer.positions, vertexCount * 3);
  const normals = trimTyped(layer.normals, vertexCount * 3);
  const uvs = trimTyped(layer.uvs, vertexCount * 2);
  const colors = trimTyped(layer.colors, vertexCount * 3);
  const indices = trimTyped(layer.indices, indexCount);
  // §62: sky·17, block·17 per vertex (normalised in the shader). A layer without it reads as open sky (15, 0).
  let light = layer.light instanceof Uint8Array && layer.light.length >= vertexCount * 2 ? trimTyped(layer.light, vertexCount * 2) : null;
  if (light === null) {
    light = new Uint8Array(vertexCount * 2);
    for (let i = 0; i < light.length; i += 2) light[i] = 255;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute(LIGHT_ATTRIBUTE, new THREE.BufferAttribute(light, 2, true));
  // Uint32 indices are always fine: WebGL2 is guaranteed (SPEC-engine §11, CONTRACTS §25.15).
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // Needs the position array, so it must run BEFORE the arrays can be released by the first upload.
  geometry.computeBoundingSphere();
  for (const name in geometry.attributes) {
    /** @type {THREE.BufferAttribute} */ (geometry.attributes[name]).onUpload(releaseCpuArray);
  }
  /** @type {THREE.BufferAttribute} */ (geometry.index).onUpload(releaseCpuArray);
  return geometry;
}

/**
 * @template {Float32Array|Uint32Array|Uint8Array} T
 * @param {T} arr
 * @param {number} length
 * @returns {T}
 */
function trimTyped(arr, length) {
  return arr.length > length ? /** @type {T} */ (arr.subarray(0, length)) : arr;
}

/**
 * Configure a CanvasTexture for a pixel-art sprite (sun/moon): nearest filtering, no mipmaps, sRGB.
 * @param {*} canvas
 * @returns {THREE.CanvasTexture}
 */
function makeSpriteTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------------------------
// createRenderer
// ---------------------------------------------------------------------------------------------

/**
 * Pixel ratio the drawing buffer should use right now: `devicePixelRatio` capped at MAX_PIXEL_RATIO
 * (the GPU fill-rate knob), 1 when the global is absent (Node/tests).
 * @returns {number}
 */
function currentPixelRatio() {
  const dpr = globalThis.devicePixelRatio;
  return Math.min(typeof dpr === 'number' && dpr > 0 ? dpr : 1, MAX_PIXEL_RATIO);
}

/**
 * Create the game renderer bound to `canvas`.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {THREE.Texture} atlasTexture  from atlas.createAtlasTexture(); shared by the three chunk materials, never disposed here
 * @param {{ sunCanvas?: *, moonCanvas?: *, renderDistance?: number, webglRenderer?: * }} [opts]
 *        `sunCanvas`/`moonCanvas`: 32×32 canvases from atlas.makeSunCanvas/makeMoonCanvas (plain coloured squares
 *        are used when absent). `renderDistance`: initial fog range (default RENDER_DISTANCE).
 *        `webglRenderer`: test-only injection of a pre-built renderer-like object (setPixelRatio/setSize/render/info/dispose).
 * @returns {Renderer}
 */
export function createRenderer(canvas, atlasTexture, opts = {}) {
  const width = Math.max(1, (canvas && (canvas.clientWidth || canvas.width)) || 1);
  const height = Math.max(1, (canvas && (canvas.clientHeight || canvas.height)) || 1);

  // --- WebGL renderer -------------------------------------------------------------------------
  /** @type {THREE.WebGLRenderer} */
  const renderer =
    opts.webglRenderer ||
    new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(currentPixelRatio());
  renderer.setSize(width, height, false);
  // outputColorSpace is left at its default (SRGBColorSpace) — SPEC-engine §2.

  // --- Scene & camera -------------------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(FOV, width / height, CAMERA_NEAR, CAMERA_FAR);
  camera.rotation.order = 'YXZ';
  camera.position.set(0, 80, 0);

  // --- Light (§62): every other lit material reads the light volume (a Material.prototype hook, installed once) ----
  installObjectLighting();
  const volume = lightVolume();
  /** @type {LightField|null} */
  let lightField = null;
  let volumeVersion = -1;
  let volumeAt = -Infinity;

  // --- Shared chunk materials (never disposed on chunk removal) ------------------------------
  const opaqueMaterial = new THREE.MeshLambertMaterial({ map: atlasTexture, vertexColors: true });
  const cutoutMaterial = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    vertexColors: true,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  });
  const translucentMaterial = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  /** Layer order matches RenderLayer: 0 opaque, 1 cutout, 2 translucent. */
  const layerMaterials = [opaqueMaterial, cutoutMaterial, translucentMaterial];
  for (const m of layerMaterials) applyChunkLight(m);
  const layerRenderOrder = [0, 0, 1];
  const layerNames = /** @type {const} */ (['opaque', 'cutout', 'translucent']);

  // --- Chunk meshes ---------------------------------------------------------------------------
  /** @type {Map<string, THREE.Mesh[]>} */
  const chunkMeshes = new Map();
  let chunkMeshCount = 0;

  // --- Lights ---------------------------------------------------------------------------------
  const dirLight = new THREE.DirectionalLight(0xffffff, DEFAULT_SKY.sunIntensity);
  dirLight.position.set(0, 200, 0);
  dirLight.target.position.set(0, 0, 0);
  scene.add(dirLight);
  scene.add(dirLight.target);
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, DEFAULT_SKY.hemiIntensity);
  scene.add(hemiLight);

  // --- Fog ------------------------------------------------------------------------------------
  const initialRange = fogRangeForRenderDistance(opts.renderDistance ?? RENDER_DISTANCE);
  let normalFogNear = initialRange.near;
  let normalFogFar = initialRange.far;
  const fog = new THREE.Fog(0x000000, normalFogNear, normalFogFar);
  scene.fog = fog;
  /** Last sky fog colour (linear working space), restored when leaving the water. */
  const skyFogColor = new THREE.Color(0x000000);
  const underwaterColor = new THREE.Color(UNDERWATER_FOG_COLOR);
  let underwater = false;

  // --- Sky dome -------------------------------------------------------------------------------
  const skyGeometry = new THREE.SphereGeometry(SKY_DOME_RADIUS, 16, 8);
  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(0x6da7ff) },
      uHorizon: { value: new THREE.Color(0xbfdcff) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0xfff3d0) },
      uGlow: { value: 0 },
    },
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: SKY_FRAGMENT_SHADER,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const skyDome = new THREE.Mesh(skyGeometry, skyMaterial);
  skyDome.renderOrder = -3;
  skyDome.frustumCulled = false;
  skyDome.name = 'skyDome';
  scene.add(skyDome);

  // --- Sun & moon sprites ---------------------------------------------------------------------
  /** @type {THREE.CanvasTexture[]} textures we own and must dispose */
  const ownedTextures = [];

  /**
   * @param {*} sourceCanvas
   * @param {number} fallbackColor
   * @param {string} name
   */
  function makeCelestialSprite(sourceCanvas, fallbackColor, name) {
    // §6 verbatim: depthTest:false, depthWrite:false, fog:false, renderOrder −1. `transparent:false` (Three's
    // SpriteMaterial default is true) keeps the sprite in the OPAQUE pass so renderOrder −1 draws it after the
    // dome (−3) but BEFORE every chunk mesh (0), which then overdraws it wherever terrain is in front — the
    // sun sets behind hills instead of shining through them (see the design note in the file header).
    // The sun/moon canvases are hard-edged pixel art on an alpha-0 background, so alphaTest 0.5 discards
    // exactly the transparent border; with blending off nothing else would hide it.
    /** @type {THREE.SpriteMaterialParameters} */
    const params = { depthTest: false, depthWrite: false, fog: false, transparent: false, alphaTest: 0.5 };
    if (sourceCanvas) {
      const tex = makeSpriteTexture(sourceCanvas);
      ownedTextures.push(tex);
      params.map = tex;
    } else {
      params.color = fallbackColor;
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial(params));
    sprite.scale.set(SUN_SPRITE_SCALE, SUN_SPRITE_SCALE, 1);
    sprite.renderOrder = -1;
    sprite.frustumCulled = false;
    sprite.name = name;
    scene.add(sprite);
    return sprite;
  }
  const sunSprite = makeCelestialSprite(opts.sunCanvas, 0xfff3a0, 'sun');
  const moonSprite = makeCelestialSprite(opts.moonCanvas, 0xdde2f0, 'moon');

  // --- Stars ----------------------------------------------------------------------------------
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(generateStarPositions(STAR_COUNT, STAR_RADIUS), 3),
  );
  const starMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 2,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.renderOrder = -2;
  stars.frustumCulled = false;
  stars.visible = false;
  stars.name = 'stars';
  scene.add(stars);

  // --- Block highlight: the 18 edges of a hexagonal prism, slightly larger than a cell ---------
  // CylinderGeometry with 6 radial segments puts its first corner at +Z, exactly like hex.HEX_CORNERS
  // (pointy along ±Z), so the wireframe lines up with the cell it outlines.
  const highlightPrism = new THREE.CylinderGeometry(HEX_SIZE * HIGHLIGHT_SIZE, HEX_SIZE * HIGHLIGHT_SIZE, HIGHLIGHT_SIZE, 6, 1);
  const highlightGeometry = new THREE.EdgesGeometry(highlightPrism);
  highlightPrism.dispose();
  const highlightMaterial = new THREE.LineBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.4,
  });
  const highlight = new THREE.LineSegments(highlightGeometry, highlightMaterial);
  highlight.renderOrder = 2;
  highlight.visible = false;
  highlight.name = 'highlight';
  scene.add(highlight);

  // --- Dig trace (Survival): the highlight prism's outline traced in honey as a cell is dug -----------
  // Transparent like the highlight so both sit in the transparent pass, where renderOrder 3 draws the trace after
  // the black outline (renderOrder 2); the edges coincide, so the honey covers the black where it has been traced.
  /** @returns {THREE.BufferGeometry} */
  function buildDigTraceGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(digTracePositions(), 3));
    g.computeBoundingSphere();
    return g;
  }
  const digTraceMaterial = new THREE.LineBasicMaterial({
    color: DIG_TRACE_COLOR,
    transparent: true,
    opacity: 1,
  });
  const digTrace = new THREE.LineSegments(buildDigTraceGeometry(), digTraceMaterial);
  digTrace.renderOrder = DIG_TRACE_RENDER_ORDER;
  digTrace.geometry.setDrawRange(0, 0);
  digTrace.visible = false;
  digTrace.name = 'digTrace';
  scene.add(digTrace);

  // --- Per-frame scratch state (allocation-free hot paths) -----------------------------------
  /** Unit direction toward the SUN itself (not the active light), from the last setSky. */
  const trueSunDir = new THREE.Vector3(
    DEFAULT_SKY.sunDir[0],
    DEFAULT_SKY.sunDir[1],
    DEFAULT_SKY.sunDir[2],
  );
  let lastSunIntensity = DEFAULT_SKY.sunIntensity;
  let lastHemiIntensity = DEFAULT_SKY.hemiIntensity;
  let disposed = false;

  // --- WebGL context loss --------------------------------------------------------------------------
  // Three re-creates every GPU buffer from `attribute.array` after a context restore, but chunk attributes
  // release that array after their first upload (releaseCpuArray). Drop the chunk meshes here — before the
  // next render() would trip over the null arrays — and ask the owner to re-mesh via onContextRestored.
  // Registered after Three's own listener (WebGLRenderer constructor), so Three's re-init has already run.
  const contextCanvas = canvas && typeof canvas.addEventListener === 'function' ? canvas : null;
  function onContextRestored() {
    if (disposed) return;
    for (const key of Array.from(chunkMeshes.keys())) removeMeshesForKey(key);
    // The dig trace gets a fresh geometry (same draw range) so nothing of it refers to the lost context's buffers.
    const oldTrace = digTrace.geometry;
    const freshTrace = buildDigTraceGeometry();
    freshTrace.setDrawRange(oldTrace.drawRange.start, oldTrace.drawRange.count);
    digTrace.geometry = freshTrace;
    oldTrace.dispose();
    api.onContextRestored();
  }
  if (contextCanvas) contextCanvas.addEventListener('webglcontextrestored', onContextRestored, false);

  /** Re-anchor everything that follows the camera (dome, stars, sun, moon). */
  function updateSkyPositions() {
    const p = camera.position;
    skyDome.position.copy(p);
    stars.position.copy(p);
    sunSprite.position.set(
      p.x + trueSunDir.x * SUN_DISTANCE,
      p.y + trueSunDir.y * SUN_DISTANCE,
      p.z + trueSunDir.z * SUN_DISTANCE,
    );
    moonSprite.position.set(
      p.x - trueSunDir.x * SUN_DISTANCE,
      p.y - trueSunDir.y * SUN_DISTANCE,
      p.z - trueSunDir.z * SUN_DISTANCE,
    );
    sunSprite.visible = trueSunDir.y > HORIZON_HIDE_Y;
    moonSprite.visible = -trueSunDir.y > HORIZON_HIDE_Y;
  }

  /**
   * Keep the light volume (§62) centred on the camera: refill it when the camera has moved LIGHT_VOLUME_RECENTRE cells
   * from its centre, or — at most every LIGHT_VOLUME_MIN_S — when the light field changed.
   */
  function updateLightVolume() {
    const info = volume.uniforms.caelVolInfo.value;
    if (lightField === null) {
      info.w = 0;
      return;
    }
    const half = volume.size / 2;
    const [cq, cr] = worldToHex(camera.position.x, camera.position.z);
    const moved = info.w === 0 || hexLength(cq - (info.x + half), cr - (info.y + half)) >= LIGHT_VOLUME_RECENTRE;
    const clock = globalThis.performance;
    const now = clock && typeof clock.now === 'function' ? clock.now() / 1000 : Date.now() / 1000;
    if (!moved && (lightField.version === volumeVersion || now - volumeAt < LIGHT_VOLUME_MIN_S)) return;
    const q0 = moved ? cq - half : info.x;
    const r0 = moved ? cr - half : info.y;
    lightField.fillVolume(q0, r0, volume.size, volume.data);
    volume.texture.needsUpdate = true;
    volumeVersion = lightField.version;
    volumeAt = now;
    info.set(q0, r0, volume.size, 1);
  }

  /** Apply light intensities, dimmed ×0.7 while underwater (SPEC-gameplay §7). */
  function applyLightIntensities() {
    const k = underwater ? UNDERWATER_LIGHT_FACTOR : 1;
    dirLight.intensity = lastSunIntensity * k;
    hemiLight.intensity = lastHemiIntensity * k;
  }

  /** Apply the fog range + colour and background for the current underwater state. */
  function applyFog() {
    if (underwater) {
      fog.color.copy(underwaterColor);
      fog.near = UNDERWATER_FOG_NEAR;
      fog.far = UNDERWATER_FOG_FAR;
      /** @type {THREE.Color} */ (scene.background).copy(underwaterColor);
    } else {
      fog.color.copy(skyFogColor);
      fog.near = normalFogNear;
      fog.far = normalFogFar;
      /** @type {THREE.Color} */ (scene.background).copy(skyFogColor);
    }
  }

  /**
   * Remove and dispose every mesh registered under `key`. Materials are shared and kept.
   * @param {string} key
   * @returns {boolean} true when something was removed
   */
  function removeMeshesForKey(key) {
    const meshes = chunkMeshes.get(key);
    if (!meshes) return false;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      scene.remove(mesh);
      mesh.geometry.dispose();
    }
    chunkMeshCount -= meshes.length;
    chunkMeshes.delete(key);
    return true;
  }

  // --- Public API -----------------------------------------------------------------------------

  /** @type {Renderer} */
  const api = {
    three: { renderer, scene, camera },

    setChunkMesh(key, cq, cr, meshData) {
      removeMeshesForKey(key);
      if (!meshData) return;

      /** @type {THREE.Mesh[]|null} */
      let meshes = null;
      for (let layer = 0; layer < 3; layer++) {
        const data = meshData[layerNames[layer]];
        if (!isDrawableLayer(data)) continue;
        const geometry = buildLayerGeometry(data);
        const mesh = new THREE.Mesh(geometry, layerMaterials[layer]);
        const origin = chunkOrigin(cq, cr);
        mesh.position.set(origin[0], 0, origin[1]);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.renderOrder = layerRenderOrder[layer];
        mesh.name = `chunk:${key}:${layerNames[layer]}`;
        scene.add(mesh);
        (meshes || (meshes = [])).push(mesh);
      }
      if (meshes) {
        chunkMeshes.set(key, meshes);
        chunkMeshCount += meshes.length;
      }
    },

    removeChunkMesh(key) {
      removeMeshesForKey(key);
    },

    setCamera(x, y, z, yaw, pitch) {
      camera.position.set(x, y, z);
      camera.rotation.set(pitch, yaw, 0); // order is 'YXZ' (set once above)
      updateSkyPositions();
    },

    setFov(fov) {
      if (!Number.isFinite(fov) || fov <= 0 || fov >= 180) return;
      if (camera.fov !== fov) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
    },

    /**
     * Compile the block highlight's, the dig trace's and the three chunk materials' programs while the game loads, so the
     * first block under the crosshair and the first trees in view do not freeze it (KNOWN-ISSUES P1; CONTRACTS §72).
     * @returns {Promise<void>}
     */
    prewarm() {
      // one hidden triangle with a chunk layer's attributes (position, normal, uv, colour, light)
      const warmGeometry = buildLayerGeometry({
        positions: new Float32Array(9), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), uvs: new Float32Array(6),
        colors: new Float32Array(9).fill(1), indices: new Uint32Array([0, 1, 2]), vertexCount: 3, indexCount: 3, faceCount: 1,
      });
      const warm = layerMaterials.map((m) => {
        const mesh = new THREE.Mesh(warmGeometry, m);
        mesh.frustumCulled = false;
        scene.add(mesh);
        return mesh;
      });
      const done = compileHidden([highlight, digTrace, ...warm], renderer, camera, scene);
      for (const mesh of warm) scene.remove(mesh);
      done.then(() => warmGeometry.dispose());
      return done;
    },

    setHighlight(hit) {
      if (!hit) {
        highlight.visible = false;
        return;
      }
      const centre = hexToWorld(hit.q, hit.r);
      highlight.position.set(centre[0], hit.y + 0.5, centre[1]);
      highlight.visible = true;
    },

    setDigProgress(hit, p) {
      const count = hit ? digTraceVertexCount(p) : 0;
      digTrace.geometry.setDrawRange(0, count);
      if (count === 0) {
        digTrace.visible = false;
        return;
      }
      const centre = hexToWorld(hit.q, hit.r);
      digTrace.position.set(centre[0], hit.y, centre[1]);
      digTrace.visible = true;
    },

    setSky(sky) {
      if (!sky) return;
      const sunColor = sky.sunColor;
      const zenith = sky.zenithColor;
      const horizon = sky.horizonColor;
      const fogColor = sky.fogColor;

      // Directional light follows the ACTIVE light (sun by day, moon by night) — sky.sunDir already is.
      const d = sky.sunDir;
      dirLight.position.set(d[0] * 200, d[1] * 200, d[2] * 200);
      dirLight.color.setRGB(sunColor[0], sunColor[1], sunColor[2], THREE.SRGBColorSpace);
      lastSunIntensity = Math.max(0, sky.sunIntensity);
      lastHemiIntensity = Math.max(0, sky.hemiIntensity);
      applyLightIntensities();
      // §62: block light washes out under the open sky by day.
      volume.uniforms.caelDaylight.value = Math.min(1, Math.max(0, sky.daylight || 0));

      // Hemisphere: sky = horizon colour, ground = darkened fog colour.
      hemiLight.color.setRGB(horizon[0], horizon[1], horizon[2], THREE.SRGBColorSpace);
      hemiLight.groundColor.setRGB(
        fogColor[0] * HEMI_GROUND_FACTOR,
        fogColor[1] * HEMI_GROUND_FACTOR,
        fogColor[2] * HEMI_GROUND_FACTOR,
        THREE.SRGBColorSpace,
      );

      // Sky dome gradient.
      skyMaterial.uniforms.uZenith.value.setRGB(zenith[0], zenith[1], zenith[2], THREE.SRGBColorSpace);
      skyMaterial.uniforms.uHorizon.value.setRGB(horizon[0], horizon[1], horizon[2], THREE.SRGBColorSpace);

      // Fog + background (underwater overrides both until setUnderwater(false)).
      skyFogColor.setRGB(fogColor[0], fogColor[1], fogColor[2], THREE.SRGBColorSpace);
      applyFog();

      // Sun/moon/stars: the sprites need the direction of the sun ITSELF.
      const sign = sky.isDay ? 1 : -1;
      trueSunDir.set(d[0] * sign, d[1] * sign, d[2] * sign);
      // Sky glow follows the sun and fades out with the daylight.
      skyMaterial.uniforms.uSunDir.value.copy(trueSunDir);
      skyMaterial.uniforms.uSunColor.value.setRGB(sunColor[0], sunColor[1], sunColor[2], THREE.SRGBColorSpace);
      skyMaterial.uniforms.uGlow.value = SKY_GLOW * Math.min(1, Math.max(0, sky.daylight || 0));
      const starOpacity = Math.min(1, Math.max(0, sky.stars || 0));
      starMaterial.opacity = starOpacity;
      stars.visible = starOpacity > 0.001;
      // Stars rotate with the sun angle φ = (t − 0.25)·2π about Z (the sun's orbit plane is XY).
      stars.rotation.z = ((sky.solar ?? sky.time) - 0.25) * Math.PI * 2; // solar time (§68)
      updateSkyPositions();
    },

    setUnderwater(on) {
      const next = !!on;
      if (next === underwater) return;
      underwater = next;
      applyFog();
      applyLightIntensities();
    },

    setRenderDistance(chunks) {
      const range = fogRangeForRenderDistance(chunks);
      normalFogNear = range.near;
      normalFogFar = range.far;
      applyFog();
    },

    resize(width, height) {
      const w = Math.max(1, Math.floor(width) || 1);
      const h = Math.max(1, Math.floor(height) || 1);
      // Re-read devicePixelRatio: dragging the window to a monitor with a different scale factor (or
      // changing browser zoom) fires 'resize' with a new DPR, and WebGLRenderer.setSize scales the drawing
      // buffer by its cached ratio. setPixelRatio must come first — it re-applies the PREVIOUS size.
      renderer.setPixelRatio(currentPixelRatio());
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },

    render() {
      if (disposed) return;
      updateLightVolume();
      renderer.render(scene, camera);
    },

    setLightField(field) {
      lightField = field && typeof field.fillVolume === 'function' ? field : null;
      volumeVersion = -1;
      volumeAt = -Infinity;
      volume.uniforms.caelVolInfo.value.w = 0;
    },

    getStats() {
      const info = renderer.info;
      return {
        chunkMeshes: chunkMeshCount,
        triangles: info && info.render ? info.render.triangles : 0,
        drawCalls: info && info.render ? info.render.calls : 0,
        geometries: info && info.memory ? info.memory.geometries : 0,
      };
    },

    onContextRestored() {},

    dispose() {
      if (disposed) return;
      disposed = true;
      if (contextCanvas) contextCanvas.removeEventListener('webglcontextrestored', onContextRestored, false);
      for (const key of Array.from(chunkMeshes.keys())) removeMeshesForKey(key);
      scene.remove(skyDome, stars, sunSprite, moonSprite, highlight, digTrace, dirLight, dirLight.target, hemiLight);
      skyGeometry.dispose();
      skyMaterial.dispose();
      starGeometry.dispose();
      starMaterial.dispose();
      sunSprite.material.dispose();
      moonSprite.material.dispose();
      for (const tex of ownedTextures) tex.dispose();
      ownedTextures.length = 0;
      highlightGeometry.dispose();
      highlightMaterial.dispose();
      digTrace.geometry.dispose();
      digTraceMaterial.dispose();
      // The three chunk materials are owned by this renderer (the atlas texture is NOT — atlas.js owns it).
      opaqueMaterial.dispose();
      cutoutMaterial.dispose();
      translucentMaterial.dispose();
      dirLight.dispose();
      hemiLight.dispose();
      if (typeof renderer.dispose === 'function') renderer.dispose();
    },
  };

  // Initial state: a sane daytime sky so a frame rendered before the first setSky() looks right.
  api.setSky(DEFAULT_SKY);
  updateSkyPositions();

  return api;
}
