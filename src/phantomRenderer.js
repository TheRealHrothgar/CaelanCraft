// Caelancraft — the figure seen at the edge of sight by someone who has been awake too long (three). See
// src/CONTRACTS.md §87 and §102, and sleep.js (TiredFx decides when and where it is, and how faint).
//
// It is drawing only: a still, dark, see-through PERSON-SHAPED shadow in the hex-faceted look of the world's figures
// (figureKit.js): tapered hexagonal legs, a body, arms hanging at its sides, a faceted head on a thin neck — with no face,
// no eyes and no arms out. It never moves, it is in no list of mobs, nothing can target or strike it, and it does nothing.
// ONE geometry drawn twice in one group: first `phantom-depth`, writing only depth, then `phantom`, an unlit, fogged,
// transparent colour drawn only where it is the nearest surface — so where its parts overlap (an arm before the body)
// it stays one even shadow instead of darkening. Hidden while there is no figure. Origin at the feet, turned to face the
// player it was made for (translate · rotateY(yaw), like the zombies). prewarm() pays the shader cost while the game
// loads (prewarm.compileHidden), like the other renderers.
import * as THREE from 'three';
import { compileHidden } from './prewarm.js';
import { FIGURE_HEIGHT } from './sleep.js';
import { loft, merge, transform, translation, compose, mul, triangleCount } from './modelKit.js';
import { headGeo, KID_HEAD } from './figureKit.js';

/** The shape's colour: near black, a little blue. */
export const PHANTOM_COLOR = 0x0c0b12;
/** Its parts, feet up: [name, from, to] (heights over its feet, m). The last reaches sleep.FIGURE_HEIGHT. */
export const PHANTOM_PARTS = Object.freeze(/** @type {ReadonlyArray<readonly [string, number, number]>} */ ([
  Object.freeze(['legs', 0, 0.84]),
  Object.freeze(['body', 0.8, 1.44]),
  Object.freeze(['head', 1.44, FIGURE_HEIGHT]),
]));

/**
 * The figure's geometry (PURE: modelKit typed arrays): two tapered hex legs, a body narrowing to the shoulders, two arms
 * hanging a little out from them, a neck and a faceted head (its crown at FIGURE_HEIGHT). No face, no eyes.
 * @returns {import('./modelKit.js').Geo}
 */
export function phantomGeometry() {
  const [, , legTop] = PHANTOM_PARTS[0];
  const [, bodyY0, bodyY1] = PHANTOM_PARTS[1];
  const [, headY0, headY1] = PHANTOM_PARTS[2];
  const parts = [];
  for (const side of [-1, 1]) {
    parts.push(transform(loft({ sides: 6, rx: 0.075, rz: 0.08, rings: [{ y: 0, sx: 0.7 }, { y: 0.45, sx: 0.82 }, { y: legTop + 0.02, sx: 1 }] }), translation(side * 0.1, 0, 0)));
    // the arm, hanging from its shoulder a little out from the body
    parts.push(transform(loft({ sides: 6, rx: 0.05, rz: 0.048, rings: [{ y: 0, sx: 0.8 }, { y: 0.3, sx: 0.9 }, { y: 0.62, sx: 1.05 }, { y: 0.66, sx: 0.6 }] }),
      mul(translation(side * 0.215, bodyY1 - 0.1 - 0.62, 0.01), compose({ r: [0, 0, side * 0.05] }))));
  }
  const bh = bodyY1 - bodyY0;
  parts.push(transform(loft({
    sides: 6, rx: 0.19, rz: 0.12,
    rings: [{ y: 0, sx: 0.92 }, { y: 0.2 * bh, sx: 0.9 }, { y: 0.62 * bh, sx: 1 }, { y: 0.86 * bh, sx: 1.02 }, { y: bh - 0.03, sx: 0.66, sz: 0.72 }],
  }), translation(0, bodyY0, 0)));
  parts.push(transform(loft({ sides: 6, rx: 0.045, rings: [{ y: 0 }, { y: 0.1, sx: 0.92 }], caps: false }), translation(0, bodyY1 - 0.06, 0)));
  const H = { y: 0, h: headY1 - headY0 - 0.02, rx: 0.14, rz: 0.15, eyeAt: 0.5, eyeX: 0.05, eyeW: 0.06, mouthAt: 0.2, noseAt: 0.36 };
  parts.push(transform(headGeo(H, KID_HEAD), translation(0, headY0 + 0.02, 0)));
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
  depth.renderOrder = 2;
  const shape = new THREE.Mesh(geometry, material);
  shape.name = 'phantom-shape';
  shape.renderOrder = 3;
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
