// Caelancraft — Three.js renderer. Implements src/CONTRACTS.md §17.
//
// Owns: the WebGLRenderer, scene, camera, the three shared chunk materials, one Mesh per non-empty
// layer per chunk, lights, fog, the sky dome (+ sun/moon sprites and stars) and the block highlight.
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

import * as THREE from 'three';
import {
  CHUNK_SIZE,
  FOV,
  CAMERA_NEAR,
  CAMERA_FAR,
  MAX_PIXEL_RATIO,
  RENDER_DISTANCE,
} from './config.js';

/** @typedef {import('./types.js').MeshData} MeshData */
/** @typedef {import('./types.js').ChunkMeshData} ChunkMeshData */
/** @typedef {import('./types.js').RaycastHit} RaycastHit */
/** @typedef {import('./types.js').SkyState} SkyState */

/**
 * @typedef {Object} Renderer
 * @property {{ renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera }} three
 * @property {(key: string, cx: number, cz: number, meshData: ChunkMeshData|null|undefined) => void} setChunkMesh
 * @property {(key: string) => void} removeChunkMesh
 * @property {(x: number, y: number, z: number, yaw: number, pitch: number) => void} setCamera
 * @property {(fov: number) => void} setFov
 * @property {(hit: RaycastHit|null|undefined) => void} setHighlight
 * @property {(sky: SkyState) => void} setSky
 * @property {(on: boolean) => void} setUnderwater
 * @property {(chunks: number) => void} setRenderDistance
 * @property {(width: number, height: number) => void} resize
 * @property {() => void} render
 * @property {() => { chunkMeshes: number, triangles: number, drawCalls: number, geometries: number }} getStats
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
varying vec3 vDir;
void main() {
  float h = clamp(vDir.y, 0.0, 1.0);
  gl_FragColor = vec4(mix(uZenith, uHorizon, pow(1.0 - h, 3.0)), 1.0);
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
 * Fog distances for a render distance in chunks: far = (chunks - 0.5) * 16, near = far * 0.55.
 * @param {number} chunks
 * @returns {{ near: number, far: number }}
 */
export function fogRangeForRenderDistance(chunks) {
  const rd = Number.isFinite(chunks) ? Math.max(1, chunks) : RENDER_DISTANCE;
  const far = Math.max(CHUNK_SIZE, (rd - 0.5) * CHUNK_SIZE);
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
  const indexCount = layer.faceCount > 0 ? layer.faceCount * 6 : layer.indices.length;

  const positions = trimTyped(layer.positions, vertexCount * 3);
  const normals = trimTyped(layer.normals, vertexCount * 3);
  const uvs = trimTyped(layer.uvs, vertexCount * 2);
  const colors = trimTyped(layer.colors, vertexCount * 3);
  const indices = trimTyped(layer.indices, indexCount);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
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
 * @template {Float32Array|Uint32Array} T
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
    new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(currentPixelRatio());
  renderer.setSize(width, height, false);
  // outputColorSpace is left at its default (SRGBColorSpace) — SPEC-engine §2.

  // --- Scene & camera -------------------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(FOV, width / height, CAMERA_NEAR, CAMERA_FAR);
  camera.rotation.order = 'YXZ';
  camera.position.set(0, 80, 0);

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

  // --- Block highlight ------------------------------------------------------------------------
  const highlightBox = new THREE.BoxGeometry(HIGHLIGHT_SIZE, HIGHLIGHT_SIZE, HIGHLIGHT_SIZE);
  const highlightGeometry = new THREE.EdgesGeometry(highlightBox);
  highlightBox.dispose();
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

    setChunkMesh(key, cx, cz, meshData) {
      removeMeshesForKey(key);
      if (!meshData) return;

      /** @type {THREE.Mesh[]|null} */
      let meshes = null;
      for (let layer = 0; layer < 3; layer++) {
        const data = meshData[layerNames[layer]];
        if (!isDrawableLayer(data)) continue;
        const geometry = buildLayerGeometry(data);
        const mesh = new THREE.Mesh(geometry, layerMaterials[layer]);
        mesh.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
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

    setHighlight(hit) {
      if (!hit) {
        highlight.visible = false;
        return;
      }
      highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      highlight.visible = true;
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
      const starOpacity = Math.min(1, Math.max(0, sky.stars || 0));
      starMaterial.opacity = starOpacity;
      stars.visible = starOpacity > 0.001;
      // Stars rotate with the sun angle φ = (t − 0.25)·2π about Z (the sun's orbit plane is XY).
      stars.rotation.z = (sky.time - 0.25) * Math.PI * 2;
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
      renderer.render(scene, camera);
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
      scene.remove(skyDome, stars, sunSprite, moonSprite, highlight, dirLight, dirLight.target, hemiLight);
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
