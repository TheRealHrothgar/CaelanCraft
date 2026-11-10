// Caelancraft — the pictures of loose items (three). See src/CONTRACTS.md §60.
//
// A loose item drawn as a block (a dug cell, a block item) goes through fallingRenderer as a small spinning cell; every
// other item (a rock, a stick, a dart, a spear) is a camera-facing Sprite of its item icon, one SpriteMaterial per key
// (a CanvasTexture of itemIcons.canvas, nearest-neighbour, alphaTest 0.5 like the cutout chunks). Sprites are pooled.
import * as THREE from 'three';

/** World size of an item picture (m). */
export const SPRITE_SIZE = 0.38;
/** Icon canvas size the textures are cut from (px). */
const ICON_PX = 32;

/**
 * @typedef {Object} LooseItemRenderer
 * @property {(items: ReadonlyArray<import('./looseItems.js').LooseItem>, time: number, skip: (it: *) => boolean) => void} sync
 *   draw every item `skip` does not take (main draws those as blocks)
 * @property {() => number} count   sprites drawn by the last sync
 * @property {() => void} dispose
 */

/**
 * @param {THREE.Scene} scene
 * @param {{ canvas(key: string|null, size?: number): HTMLCanvasElement }} icons  itemIcons
 * @returns {LooseItemRenderer}
 */
export function createLooseItemRenderer(scene, icons) {
  const group = new THREE.Group();
  group.name = 'loose-items';
  scene.add(group);
  /** @type {Map<string, THREE.SpriteMaterial>} */
  const materials = new Map();
  /** @type {THREE.Sprite[]} */
  const pool = [];
  let drawn = 0;

  /** @param {string} key */
  function materialOf(key) {
    let m = materials.get(key);
    if (m) return m;
    const tex = new THREE.CanvasTexture(icons.canvas(key, ICON_PX));
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    m = new THREE.SpriteMaterial({ map: tex, alphaTest: 0.5, transparent: false });
    materials.set(key, m);
    return m;
  }

  return {
    sync(items, time, skip) {
      let n = 0;
      for (const it of items) {
        if (skip(it)) continue;
        let sp = pool[n];
        if (!sp) {
          sp = new THREE.Sprite(materialOf(it.s.k));
          sp.scale.set(SPRITE_SIZE, SPRITE_SIZE, 1);
          pool.push(sp);
          group.add(sp);
        }
        const m = materialOf(it.s.k);
        if (sp.material !== m) sp.material = m;
        // A resting item bobs a little so it reads as something to pick up.
        const bob = it.mode === 'rest' ? 0.05 + 0.05 * Math.sin(time * 3 + it.spin) : 0;
        sp.position.set(it.x, it.y + bob + 0.06, it.z);
        sp.visible = true;
        n++;
      }
      for (let i = n; i < pool.length; i++) pool[i].visible = false;
      drawn = n;
    },
    count: () => drawn,
    dispose() {
      scene.remove(group);
      for (const m of materials.values()) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
      materials.clear();
      pool.length = 0;
    },
  };
}
