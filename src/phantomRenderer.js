// Caelancraft — the figure seen at the edge of sight by someone who has been awake too long (three). See
// src/CONTRACTS.md §87 and §104, and sleep.js (TiredFx decides when and where it is, and how faint).
//
// It is drawing only: a still, dark, see-through PERSON-SHAPED shadow in the hex-faceted look of the world's figures
// (figureKit.js): tapered hexagonal legs, a body with sloping shoulders, arms hanging at its sides a little out from it,
// a faceted head with a plain mass of hair on a neck — with no face, no eyes and no arms out. It never moves, it is in no
// list of mobs, nothing can target or strike it, and it does nothing.
// ONE geometry drawn twice in one group: first `phantom-depth`, writing only depth, then `phantom`, an unlit, fogged,
// transparent colour drawn only where it is the nearest surface — so where its parts overlap (an arm before the body)
// it stays one even shadow instead of darkening. Both draw after every other transparent thing (PHANTOM_ORDER), so its
// depth hides nothing drawn later. Hidden while there is no figure. Origin at the feet, turned to face the
// player it was made for (translate · rotateY(yaw), like the zombies). prewarm() pays the shader cost while the game
// loads (prewarm.compileHidden), like the other renderers.
import * as THREE from 'three';
import { compileHidden } from './prewarm.js';
import { FIGURE_HEIGHT } from './sleep.js';
import { loft, merge, transform, translation, compose, mul, triangleCount, bounds } from './modelKit.js';
import { headGeo, hairMass, hairline } from './figureKit.js';

/** The shape's colour: near black, a little blue. */
export const PHANTOM_COLOR = 0x0c0b12;
/** Its parts, feet up: [name, from, to] (heights over its feet, m). The last reaches sleep.FIGURE_HEIGHT. */
export const PHANTOM_PARTS = Object.freeze(/** @type {ReadonlyArray<readonly [string, number, number]>} */ ([
  Object.freeze(['legs', 0, 0.84]),
  Object.freeze(['body', 0.8, 1.44]),
  Object.freeze(['head', 1.44, FIGURE_HEIGHT]),
]));

/**
 * Its draw order: after every transparent effect (the particles, the rain and snow at 3, the campfire's flames and
 * smoke up to 10, the Watcher's glow at 3), so the depth its pre-pass writes clips nothing drawn after it — however
 * faint the figure is.
 */
export const PHANTOM_ORDER = Object.freeze({ depth: 20, shape: 21 });

/** Its head, chin to crown ([height share, width, depth, forward shift]): a grown-up's, the jaw fuller than a child's. */
const PHANTOM_HEAD = Object.freeze([
  [0, 0.6, 0.6, -0.03], [0.14, 0.82, 0.8, -0.02], [0.32, 0.95, 0.93, -0.006], [0.54, 1, 0.97, 0],
  [0.73, 1.01, 1, 0.004], [0.865, 1, 1.04, 0.016], [0.96, 0.8, 0.86, 0.022], [1, 0.45, 0.5, 0.02],
]);

/** Its shoulders: each arm's joint from the middle and over the feet, and how far an arm hangs out from the body. */
const SHOULDER_X = 0.185;
const SHOULDER_DROP = 0.09;
const ARM_OUT = 0.12;

/**
 * The figure's geometry (PURE: modelKit typed arrays): two tapered hex legs, a body narrowing to sloping shoulders, two
 * arms hanging from them angled a little out (daylight between arm and body: it has armpits, not one slab), a thick
 * neck and a faceted head under a plain mass of hair that rounds its crown (its top at FIGURE_HEIGHT). No face, no eyes.
 * @returns {import('./modelKit.js').Geo}
 */
export function phantomGeometry() {
  const [, , legTop] = PHANTOM_PARTS[0];
  const [, bodyY0, bodyY1] = PHANTOM_PARTS[1];
  const [, headY0, headY1] = PHANTOM_PARTS[2];
  const parts = [];
  for (const side of [-1, 1]) {
    parts.push(transform(loft({ sides: 6, rx: 0.075, rz: 0.08, rings: [{ y: 0, sx: 0.7 }, { y: 0.45, sx: 0.82 }, { y: legTop + 0.02, sx: 1 }] }), translation(side * 0.1, 0, 0)));
    // the arm, hanging from its shoulder and angled out from the body
    parts.push(transform(loft({ sides: 6, rx: 0.047, rz: 0.046, rings: [{ y: -0.64, sx: 0.8 }, { y: -0.34, sx: 0.88 }, { y: -0.06, sx: 1.05 }, { y: 0.035, sx: 0.55 }] }),
      mul(translation(side * SHOULDER_X, bodyY1 - SHOULDER_DROP, 0.005), compose({ r: [0, 0, side * ARM_OUT] }))));
  }
  const bh = bodyY1 - bodyY0;
  // the body: hips, a narrower waist, the chest, then shoulders that slope in to the neck (never square)
  parts.push(transform(loft({
    sides: 6, rx: 0.165, rz: 0.115,
    rings: [
      { y: 0, sx: 0.94 }, { y: 0.22 * bh, sx: 0.84 }, { y: 0.55 * bh, sx: 0.94 }, { y: 0.76 * bh, sx: 0.98, sz: 1.02 },
      { y: 0.9 * bh, sx: 0.74, sz: 0.84 }, { y: bh - 0.01, sx: 0.44, sz: 0.56 },
    ],
  }), translation(0, bodyY0, 0)));
  parts.push(transform(loft({ sides: 6, rx: 0.058, rz: 0.06, rings: [{ y: 0 }, { y: 0.12, sx: 0.92 }], caps: false }), translation(0, bodyY1 - 0.05, 0)));
  // the head and its hair, placed so the top of the hair is the figure's crown
  const H = { y: 0, h: headY1 - headY0 - 0.05, rx: 0.135, rz: 0.145, eyeAt: 0.5, eyeX: 0.05, eyeW: 0.06, mouthAt: 0.2, noseAt: 0.36 };
  const hair = hairMass(H, PHANTOM_HEAD, {
    around: 10,
    rim: hairline([[0, -24], [60, -8], [100, 4], [140, 16], [180, 22]]),
    off: (yaw, pitch, s) => 0.016 + 0.022 * Math.sin((Math.PI / 2) * Math.min(1, s * 1.4)),
    rings: [0, 0.25, 0.55, 0.8, 1],
  });
  const head = merge([headGeo(H, PHANTOM_HEAD), hair]);
  const top = bounds(head).max[1];
  parts.push(transform(head, translation(0, headY1 - top, 0)));
  return merge(parts);
}

/**
 * @param {import('three').Scene} scene
 * @returns {{ group: import('three').Group, material: import('three').MeshBasicMaterial, tris: number,
 *   sync(figure: import('./sleep.js').Phantom|null): void,
 *   prewarm(webgl: *, camera: *): Promise<void>, dispose(): void }}
 */
export function createPhantomRenderer(scene) {
  const group = new THREE.Group();
  group.name = 'phantom';
  group.visible = false;
  const g = phantomGeometry();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(g.index, 1));
  geometry.computeBoundingSphere();
  // depth first (nothing drawn), then the colour where the figure is the nearest surface: one even shadow
  const depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true, depthWrite: true });
  const material = new THREE.MeshBasicMaterial({ color: PHANTOM_COLOR, transparent: true, opacity: 0, depthWrite: false, depthFunc: THREE.LessEqualDepth });
  const depth = new THREE.Mesh(geometry, depthMaterial);
  depth.name = 'phantom-depth';
  depth.renderOrder = PHANTOM_ORDER.depth;
  const shape = new THREE.Mesh(geometry, material);
  shape.name = 'phantom-shape';
  shape.renderOrder = PHANTOM_ORDER.shape;
  group.add(depth, shape);
  scene.add(group);

  /**
   * Show the figure where it is, as faint as it is; null (or an opacity of nothing) hides it.
   * @param {import('./sleep.js').Phantom|null} figure
   */
  function sync(figure) {
    const alpha = figure ? Math.max(0, Math.min(1, figure.alpha)) : 0;
    if (!figure || !(alpha > 0)) {
      group.visible = false;
      return;
    }
    group.position.set(figure.x, figure.y, figure.z);
    group.rotation.y = figure.yaw;
    material.opacity = alpha;
    group.visible = true;
  }

  return {
    group,
    material,
    tris: triangleCount(g),
    sync,
    prewarm: (webgl, camera) => compileHidden([group], webgl, camera, scene),
    dispose() {
      scene.remove(group);
      geometry.dispose();
      material.dispose();
      depthMaterial.dispose();
    },
  };
}

/** The whole shape's height (its crown): sleep.FIGURE_HEIGHT. */
export const PHANTOM_HEIGHT = FIGURE_HEIGHT;
