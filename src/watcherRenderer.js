// Caelancraft — the Hollow Watcher's figure (three). See src/CONTRACTS.md §40.4 and §104.
//
// Built from the world's own cell shape, and hollow, in the hex-faceted look (watcherModel.js, pure: its geometry and its
// painted stone): a floating stack of RING_COUNT open hexagonal bands (thin chamfered walls, axis vertical, pointy-top
// like the cells), widest in the middle, with gaps between them you can see through; each turns very slowly its own way
// and bobs a few centimetres. On top a hex LANTERN — a heavier chamfered band top and bottom, six slim tapered posts,
// open sides, a faceted crystal glowing dimly inside — holds the only bright features: two small cyan lights side by side
// inside its front, unlit and fog-free (MeshBasicMaterial, fog: false), each with a soft additive glow sprite that keeps a
// few pixels' size however far away it stands, so they read through fog and darkness. No legs, no arms, no face: under
// the lowest ring a thin wisp of dark smoke (three shrinking, fading hex tubes) trails to the ground. Material: weathered
// ash-grey stone painted on its own 256² atlas (linear filtering, mipmaps), split by thin cracks that glow cyan and pulse
// slowly: the emissive map is the model's glow image (the stone dimmed, its cracks bright cyan), so the cracks shine and
// by night the stone stays faintly pale, not black.
// ONE group of a handful of meshes (one figure), origin at the feet (the cell floor), facing −Z: translate · rotateY(yaw)
// like the zombies; the lantern turns on its own (headYaw − yaw) and tilts (headPitch).
// prewarm() pays every shader cost while the game loads (like campfireRenderer / fallingRenderer): it compiles the
// programs against the real scene and has every part draw once, hidden, in the first rendered frame.
import * as THREE from 'three';
import { WATCHER_EYE_Y } from './watcher.js';
import {
  watcherModel, RING_COUNT, RING_R, RING_WALL, RING_H, RING_GAP, RING_BASE_Y, NECK_GAP, HEAD_Y, LANTERN_H, MODEL_HEIGHT,
  LANTERN_R, LANTERN_RIM_H, LANTERN_WALL, POST_R, CORE_R, CORE_H, CORE_Y, SMOKE, RING_CHAMFER,
} from './watcherModel.js';

export {
  RING_COUNT, RING_R, RING_WALL, RING_H, RING_GAP, RING_BASE_Y, NECK_GAP, HEAD_Y, LANTERN_H, MODEL_HEIGHT, LANTERN_R,
  LANTERN_RIM_H, LANTERN_WALL, POST_R, CORE_R, CORE_H, CORE_Y, SMOKE, RING_CHAMFER,
};

/** @typedef {import('./watcher.js').WatcherFigure} WatcherFigure */

const TWO_PI = Math.PI * 2;

/** Each ring's turn at time 0 (rad) and its own slow turn rate (rad/s), alternating directions. */
export const RING_PHASE = Object.freeze([0, 0.33, 0.12, 0.47, 0.21]);
export const RING_SPIN = Object.freeze([0.045, -0.03, 0.02, -0.035, 0.05]);
/** The rings bob ±RING_BOB (m) over RING_BOB_S seconds, each RING_BOB_STEP rad behind the one below. */
export const RING_BOB = 0.02;
export const RING_BOB_S = 5.5;
export const RING_BOB_STEP = 1.1;
/**
 * The crystal's dim glow: unlit, fogged and translucent with normal blending — a faint teal light in the dark, a muted
 * teal crystal by day (additive would turn it into a bright pale panel against the daytime sky, outshining the lights).
 */
export const CORE_COLOR = 0x0f4c55;
export const CORE_OPACITY = 0.55;
/** The two lights: small pointy-top hexagons (circumradius EYE_R) at (±EYE_X, WATCHER_EYE_Y), inside the front window. */
export const EYE_X = 0.045;
export const EYE_R = 0.021;
/** Their depth: behind the lantern's front plane (z = −LANTERN_R·cos 30°), in front of the core. */
export const EYE_Z = -0.14;
export const EYE_COLOR = 0x7ff8ff;
export const GLOW_COLOR = 0x39d8f0;
/** A glow sprite is at least this wide (m) … */
export const GLOW_MIN = 0.16;
/** … and this wide per metre of distance (≈ 6 px at 720p), so the lights never shrink below a few pixels. */
export const GLOW_PER_M = 0.012;

// ---- the stone and its cracks -------------------------------------------------------------------------------------
/**
 * The stone's self-light: emissive white × the model's glow image (the stone at WATCHER_SELF_LIGHT of its brightness, so
 * by night it still reads as pale stone, and its cracks bright cyan), at intensity CRACK_GLOW · (1 ± CRACK_PULSE) over
 * CRACK_PULSE_S seconds.
 */
export const CRACK_GLOW = 0.75;
export const CRACK_PULSE = 0.35;
export const CRACK_PULSE_S = 6.5;

// ---- the smoke wisp -----------------------------------------------------------------------------------------------
/** The wisp turns slowly as one (rad/s). */
export const SMOKE_SPIN = 0.3;

// ---- pre-warm -----------------------------------------------------------------------------------------------------
/** prewarm's hidden draw: the whole group micro-scaled, far below the world (clipped; still a real draw call). */
export const WARM_Y = -1e4;
export const WARM_SCALE = 1e-6;

/**
 * @typedef {Object} WatcherRenderer
 * @property {(figure: WatcherFigure|null, camX: number, camY: number, camZ: number, time: number) => void} sync
 *   draw the figure (null hides it); the camera position sizes the light glows, `time` (s) drives the rings, the
 *   smoke and the crack pulse
 * @property {() => boolean} visible             the figure was drawn by the last sync
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm  compile its programs now and draw every part
 *   once, hidden, in the next rendered frame (call it once every light of the scene exists)
 * @property {() => number} warmPending          parts that still owe prewarm's hidden draw
 * @property {() => void} dispose
 * @property {THREE.Group} group                 the figure (for tests and diagnostics)
 * @property {THREE.Group} head                  the head pivot (turns with headYaw − yaw, tilts with headPitch)
 * @property {THREE.Mesh[]} rings                bottom to top
 * @property {THREE.Mesh} lantern                the lantern's frame (rims and posts)
 * @property {THREE.Mesh} core                   the lantern's dim inner glow
 * @property {THREE.Mesh} smoke                  the wisp under the rings
 * @property {THREE.Mesh[]} eyes                 the two lights
 * @property {THREE.Sprite[]} glows
 */

// ---- geometry -----------------------------------------------------------------------------------------------------

/**
 * A kit geometry as a BufferGeometry; with `alpha`, a colour attribute (white, that alpha per vertex).
 * @param {import('./modelKit.js').Geo} g @param {Float32Array} [alpha]
 */
function bufferOf(g, alpha) {
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
  if (alpha) {
    const c = new Float32Array(alpha.length * 4);
    for (let i = 0; i < alpha.length; i++) c.set([1, 1, 1, alpha[i]], i * 4);
    out.setAttribute('color', new THREE.BufferAttribute(c, 4));
  }
  out.setIndex(new THREE.BufferAttribute(g.index, 1));
  out.computeBoundingSphere();
  return out;
}

/** A painted image as a texture: sRGB, linear filtering with mipmaps. @param {import('./paintKit.js').Img} img */
function paintedTexture(img) {
  const tex = new THREE.DataTexture(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** A soft round glow: white, alpha (1 − r)² over a 32×32 DataTexture (no DOM needed). */
function glowTexture() {
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.min(1, Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2));
      const i = (y * n + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(255 * (1 - r) * (1 - r));
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Ring i's underside above the feet at rest (before bobbing). */
export function ringBaseY(i) {
  return RING_BASE_Y + i * (RING_H + RING_GAP);
}

/**
 * @param {THREE.Scene} scene
 * @param {*} [_atlasTexture]  unused (the figure paints its own stone); kept so main's call stays as it was
 * @returns {WatcherRenderer}
 */
export function createWatcherRenderer(scene, _atlasTexture) {
  const model = watcherModel();
  const map = paintedTexture(model.image);
  const crackMap = paintedTexture(model.glow);
  const glowMap = glowTexture();
  const geos = {
    rings: model.rings.map((g) => bufferOf(g)),
    lantern: bufferOf(model.lantern),
    core: bufferOf(model.core),
    smoke: bufferOf(model.smoke, model.smokeAlpha),
    // A pointy-top hexagon (thetaStart π/2 puts a corner at the top), like the cells.
    eye: new THREE.CircleGeometry(EYE_R, 6, Math.PI / 2),
  };
  const mats = {
    stone: new THREE.MeshLambertMaterial({ map, emissive: 0xffffff, emissiveMap: crackMap, emissiveIntensity: CRACK_GLOW }),
    core: new THREE.MeshBasicMaterial({
      color: CORE_COLOR, transparent: true, opacity: CORE_OPACITY, depthWrite: false,
    }),
    // One colour per tube face at a vertex alpha: blending it over itself is order-independent, so one pass will do.
    smoke: new THREE.MeshBasicMaterial({
      map, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
    }),
    // Unlit and fog-free: the lights keep their colour at any distance and in any darkness.
    eye: new THREE.MeshBasicMaterial({ color: EYE_COLOR, fog: false, side: THREE.DoubleSide }),
    glow: new THREE.SpriteMaterial({
      map: glowMap, color: GLOW_COLOR, fog: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  };

  const group = new THREE.Group();
  group.name = 'watcher';
  group.visible = false;
  /** Every drawable part: the ones prewarm makes draw once. @type {THREE.Object3D[]} */
  const parts = [];
  const add = (obj, name, parent, renderOrder = 0) => {
    obj.name = name;
    obj.renderOrder = renderOrder;
    parent.add(obj);
    parts.push(obj);
    return obj;
  };
  const rings = geos.rings.map((g, i) => add(new THREE.Mesh(g, mats.stone), `watcher-ring-${i}`, group));
  const smoke = add(new THREE.Mesh(geos.smoke, mats.smoke), 'watcher-smoke', group, 1);
  const head = new THREE.Group();
  head.name = 'watcher-head-pivot';
  head.position.set(0, HEAD_Y, 0);
  head.rotation.order = 'YXZ';
  group.add(head);
  const lantern = add(new THREE.Mesh(geos.lantern, mats.stone), 'watcher-lantern', head);
  const core = add(new THREE.Mesh(geos.core, mats.core), 'watcher-core', head, 1);
  /** @type {THREE.Mesh[]} */
  const eyes = [];
  /** @type {THREE.Sprite[]} */
  const glows = [];
  for (const side of [-1, 1]) {
    const eye = add(new THREE.Mesh(geos.eye, mats.eye), side < 0 ? 'watcher-eye-l' : 'watcher-eye-r', head, 2);
    eye.position.set(side * EYE_X, WATCHER_EYE_Y - HEAD_Y, EYE_Z);
    eyes.push(eye);
    const glow = add(new THREE.Sprite(mats.glow), side < 0 ? 'watcher-glow-l' : 'watcher-glow-r', head, 3);
    glow.position.set(side * EYE_X, WATCHER_EYE_Y - HEAD_Y, EYE_Z - 0.01);
    glow.scale.set(GLOW_MIN, GLOW_MIN, 1);
    glows.push(glow);
  }
  scene.add(group);

  let shown = false;
  /** Parts that still owe prewarm's hidden draw. */
  const warming = new Set();
  // three calls onAfterRender right after drawing an object: that part's warm-up draw is done. It goes back to normal
  // frustum culling, and once every part has drawn the speck is hidden again (unless a figure is shown by then).
  for (const p of parts) {
    p.onAfterRender = () => {
      if (!warming.delete(p)) return;
      p.frustumCulled = true;
      if (warming.size === 0 && !shown) {
        group.visible = false;
        group.scale.setScalar(1);
      }
    };
  }

  /** The hidden warm-up pose: the whole group visible as a micro-scaled speck far below the world. */
  function placeWarm() {
    group.visible = true;
    group.position.set(0, WARM_Y, 0);
    group.rotation.set(0, 0, 0);
    group.scale.setScalar(WARM_SCALE);
  }

  const lightWorld = new THREE.Vector3();

  /**
   * @param {WatcherFigure|null} figure
   * @param {number} camX @param {number} camY @param {number} camZ
   * @param {number} time
   */
  function sync(figure, camX, camY, camZ, time) {
    if (!figure) {
      shown = false;
      // Still owing the warm-up draw (main syncs null every frame from the start): keep the speck.
      if (warming.size > 0) placeWarm();
      else group.visible = false;
      return;
    }
    group.visible = true;
    shown = true;
    group.scale.setScalar(1);
    group.position.set(figure.x, figure.y, figure.z);
    group.rotation.set(0, figure.yaw, 0);
    head.rotation.set(figure.headPitch || 0, (figure.headYaw ?? figure.yaw) - figure.yaw, 0);
    const t = Number.isFinite(time) ? time : 0;
    for (let i = 0; i < RING_COUNT; i++) {
      rings[i].rotation.y = RING_PHASE[i] + RING_SPIN[i] * t;
      rings[i].position.y = ringBaseY(i) + RING_BOB * Math.sin((TWO_PI * t) / RING_BOB_S - i * RING_BOB_STEP);
    }
    smoke.rotation.y = SMOKE_SPIN * t;
    // The glow keeps a few pixels' size at any distance.
    lightWorld.set(figure.x, figure.y + WATCHER_EYE_Y, figure.z);
    const d = Number.isFinite(camX + camY + camZ) ? Math.hypot(lightWorld.x - camX, lightWorld.y - camY, lightWorld.z - camZ) : 0;
    const s = Math.max(GLOW_MIN, d * GLOW_PER_M);
    for (const g of glows) g.scale.set(s, s, 1);
    const pulse = Math.sin((TWO_PI * t) / CRACK_PULSE_S);
    mats.stone.emissiveIntensity = CRACK_GLOW * (1 + CRACK_PULSE * pulse);
    mats.core.opacity = CORE_OPACITY * (1 + 0.5 * CRACK_PULSE * pulse);
    mats.glow.opacity = 0.9 + 0.1 * Math.sin(t * 1.7);
  }

  /**
   * Pay every Watcher shader cost while the game loads, not on the frame of the first sighting (as
   * campfireRenderer.prewarm, CONTRACTS §32.2 and §40.4):
   * 1. compile the programs now against the real scene — its lights and fog are part of every program's key, so main
   *    calls this once all of the scene's lights exist (compileAsync — KHR_parallel_shader_compile — when present);
   * 2. have every part (rings, smoke, lantern, core, lights, glow sprites) draw ONCE in the next rendered frame, as a
   *    micro-scaled speck far below the world with frustum culling off, because ANGLE on D3D11 only finishes a program
   *    on its first draw. `sync(null)` keeps the speck until each part has drawn; then it is hidden for good.
   * Never throws.
   * @param {*} webgl a THREE.WebGLRenderer (anything without compile/compileAsync only gets step 2)
   * @param {THREE.Camera} camera
   * @returns {Promise<void>}
   */
  function prewarm(webgl, camera) {
    for (const p of parts) {
      warming.add(p);
      p.frustumCulled = false; // the speck (or a figure out of view) must still be drawn
    }
    if (!shown) placeWarm();
    try {
      if (webgl && typeof webgl.compileAsync === 'function') {
        return Promise.resolve(webgl.compileAsync(group, camera, scene)).then(() => {}, () => {});
      }
      if (webgl && typeof webgl.compile === 'function') webgl.compile(group, camera, scene);
    } catch {
      // A failed compile still leaves step 2 (the warm-up draw compiles the programs in the first frame).
    }
    return Promise.resolve();
  }

  function dispose() {
    warming.clear();
    scene.remove(group);
    for (const g of [...geos.rings, geos.lantern, geos.core, geos.smoke, geos.eye]) g.dispose();
    for (const m of Object.values(mats)) m.dispose();
    glowMap.dispose();
    map.dispose();
    crackMap.dispose();
    shown = false;
  }

  return {
    sync, visible: () => shown, prewarm, warmPending: () => warming.size, dispose, group, head, rings, lantern, core, smoke,
    eyes, glows,
  };
}
