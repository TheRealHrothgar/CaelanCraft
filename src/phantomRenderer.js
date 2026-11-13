// Caelancraft — the figure seen at the edge of sight by someone who has been awake too long (three). See
// src/CONTRACTS.md §87 and sleep.js (TiredFx decides when and where it is, and how faint).
//
// It is drawing only: a still, dark, see-through shape of three plain boxes — legs, a body, a head — with no face, no
// eyes and no arms out. It never moves, it is in no list of mobs, nothing can target or strike it, and it does nothing.
// ONE group of three meshes sharing one unlit, fogged, transparent material; hidden while there is no figure. Origin at
// the feet, turned to face the player it was made for (translate · rotateY(yaw), like the zombies).
// prewarm() pays the shader cost while the game loads (prewarm.compileHidden), like the other renderers.
import * as THREE from 'three';
import { compileHidden } from './prewarm.js';
import { FIGURE_HEIGHT } from './sleep.js';

/** The shape's colour: near black, a little blue. */
export const PHANTOM_COLOR = 0x0c0b12;
/** Its three boxes, feet up: [name, width, height, depth]. Their heights add up to sleep.FIGURE_HEIGHT. */
export const PHANTOM_PARTS = Object.freeze([
  Object.freeze(['legs', 0.4, 0.8, 0.24]),
  Object.freeze(['body', 0.52, 0.66, 0.28]),
  Object.freeze(['head', 0.34, 0.34, 0.34]),
]);

/**
 * @param {import('three').Scene} scene
 * @returns {{ group: import('three').Group, material: import('three').MeshBasicMaterial,
 *   sync(figure: import('./sleep.js').Phantom|null): void,
 *   prewarm(webgl: *, camera: *): Promise<void>, dispose(): void }}
 */
export function createPhantomRenderer(scene) {
  const group = new THREE.Group();
  group.name = 'phantom';
  group.visible = false;
  const material = new THREE.MeshBasicMaterial({ color: PHANTOM_COLOR, transparent: true, opacity: 0, depthWrite: false });
  let y = 0;
  for (const [name, w, h, d] of PHANTOM_PARTS) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(/** @type {number} */ (w), /** @type {number} */ (h), /** @type {number} */ (d)), material);
    mesh.name = /** @type {string} */ (name);
    mesh.position.y = y + /** @type {number} */ (h) / 2;
    mesh.renderOrder = 2;
    y += /** @type {number} */ (h);
    group.add(mesh);
  }
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
    sync,
    prewarm: (webgl, camera) => compileHidden([group], webgl, camera, scene),
    dispose() {
      scene.remove(group);
      for (const mesh of group.children) /** @type {import('three').Mesh} */ (mesh).geometry.dispose();
      material.dispose();
    },
  };
}

/** The whole shape's height (the sum of its parts): sleep.FIGURE_HEIGHT. */
export const PHANTOM_HEIGHT = FIGURE_HEIGHT;
