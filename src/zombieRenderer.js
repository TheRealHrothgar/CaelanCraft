// Caelancraft — zombie models (three). See src/CONTRACTS.md §39.
//
// A zombie is four blocks: two feet side by side, a torso standing on them and a head on top. Each block is a small
// hexagonal prism — the world's cell shape, scaled — turned so a flat side faces forward (the face needs a front
// face). The model is built facing −Z with its origin at the feet, so a rotation of `zombie.yaw` about +Y matches
// yawToForward, like the pigs. Every part is textured from the block atlas (tiles.js zombie_* tiles): the face on the
// head's front side only, rotting skin and hair on its other sides and top, a torn shirt on the torso and ragged
// trousers with shoes on the feet.
//
// All zombies share three InstancedMeshes (feet ×2 per zombie, torso, head), so any number of zombies costs 3 draw
// calls; their twins with a red emissive (a zombie with `hurt > 0`) or an ember glow (smouldering in daylight) only
// draw while one flashes or burns. The feet swing from the hip with `walkPhase`, the torso sways and leans into a
// chase and lurches after an attack (`swing`), and the head lolls by its own `tilt`. A zombie's optional
// `renderScale` (default 1) and `renderSpin` (default 0, extra yaw) draw a black hole's shrinking, spinning ghost
// (infall.js, DESIGN-circuits §6.2.13); without them the output is exactly as before.
import * as THREE from 'three';
import { ZOMBIE_MAX, ATLAS_TILES_PER_ROW, UV_INSET } from './config.js';
import { TILE } from './blocks.js';
import { SWING_S } from './zombies.js';

/** @typedef {import('./zombies.js').Zombie} Zombie */

/** Part sizes (world units): circumradius R (the hexagon's corner radius; its side length too) and height. */
export const FOOT_R = 0.145;
export const FOOT_H = 0.56;
/** The feet's centres, either side of the middle: together they are as wide as the torso (4·FOOT_R + gap ≈ 2·TORSO_R). */
export const FOOT_X = 0.152;
export const TORSO_R = 0.3;
export const TORSO_H = 0.76;
export const HEAD_R = 0.28;
export const HEAD_H = 0.58;
/** FOOT_H + TORSO_H + HEAD_H = ZOMBIE_HEIGHT (1.9). */
export const MODEL_HEIGHT = FOOT_H + TORSO_H + HEAD_H;

/** Side face 4 (corners 4 → 5, normal −Z) is the front with corners at 60°·k from +X toward +Z. */
const FRONT_FACE = 4;
/** Self-light of the normal material, multiplied by the texture (emissiveMap). */
export const NIGHT_GLOW = 0x8c8c8c;
const HURT = 0xff2a2a;
const HURT_INTENSITY = 1.6;
const EMBER = 0xff6a1a;
const EMBER_INTENSITY = 0.9;
const SOOT = 0x8a7c72;
const FOOT_SWING = 0.55;
const CHASE_LEAN = -0.14;
const WALK_LEAN = -0.05;
const LURCH = -0.32;

/**
 * @typedef {Object} ZombieRenderer
 * @property {(zombies: Zombie[]) => void} sync   draw the given zombies (position, yaw, animation, hurt / burn glow)
 * @property {() => number} count                 zombies drawn by the last sync
 * @property {() => void} dispose
 * @property {THREE.Group} group                  the instanced meshes (for tests and diagnostics)
 */

/** A body's model scale: its `renderScale` when a positive number, else 1 (pigRenderer's rule). */
function renderScaleOf(body) {
  const s = body.renderScale;
  return typeof s === 'number' && s > 0 && Number.isFinite(s) ? s : 1;
}

/** A body's extra yaw: its `renderSpin` when a finite number, else 0. */
function renderSpinOf(body) {
  const s = body.renderSpin;
  return typeof s === 'number' && Number.isFinite(s) ? s : 0;
}

/**
 * @typedef {{ front: number, sides: number, top: number, bottom: number }} PrismTiles  atlas tiles of a prism's faces
 */

/** [u0, v0, u1, v1] of atlas tile `t` (flipY = false: v grows down the image), inset against bleeding. */
function tileRect(t) {
  const n = ATLAS_TILES_PER_ROW;
  const tx = t % n;
  const ty = Math.floor(t / n);
  return [(tx / n) + UV_INSET, (ty / n) + UV_INSET, ((tx + 1) / n) - UV_INSET, ((ty + 1) / n) - UV_INSET];
}

/**
 * A hexagonal prism of circumradius R from y0 to y0 + h, corners at angles 60°·k from +X toward +Z (so side face 4,
 * corners 4 → 5, faces −Z), with flat normals and atlas UVs: each side face shows a whole tile upright as seen from
 * outside (u = 0 at corner k + 1, v = 0 at the top), the caps an inscribed hexagon (+Z down the tile).
 * @param {number} R
 * @param {number} h
 * @param {number} y0
 * @param {PrismTiles} tiles
 * @returns {THREE.BufferGeometry}  6·4 + 2·7 vertices, 6·2 + 2·6 triangles
 */
export function hexPrismGeometry(R, h, y0, tiles) {
  /** @type {number[]} */
  const pos = [];
  /** @type {number[]} */
  const nor = [];
  /** @type {number[]} */
  const uv = [];
  /** @type {number[]} */
  const idx = [];
  const cx = [];
  const cz = [];
  for (let k = 0; k < 6; k++) {
    cx.push(R * Math.cos((Math.PI / 3) * k));
    cz.push(R * Math.sin((Math.PI / 3) * k));
  }
  const y1 = y0 + h;
  for (let j = 0; j < 6; j++) {
    const a = j;
    const b = (j + 1) % 6;
    const ang = (Math.PI / 3) * j + Math.PI / 6;
    const nx = Math.cos(ang);
    const nz = Math.sin(ang);
    const [u0, v0, u1, v1] = tileRect(j === FRONT_FACE ? tiles.front : tiles.sides);
    const base = pos.length / 3;
    // A: corner b top (u0, v0); B: corner a top (u1, v0); C: corner a bottom (u1, v1); D: corner b bottom (u0, v1)
    pos.push(cx[b], y1, cz[b], cx[a], y1, cz[a], cx[a], y0, cz[a], cx[b], y0, cz[b]);
    uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    for (let i = 0; i < 4; i++) nor.push(nx, 0, nz);
    idx.push(base, base + 3, base + 2, base, base + 2, base + 1); // counter-clockwise seen from outside
  }
  for (const top of [true, false]) {
    const [u0, v0, u1, v1] = tileRect(top ? tiles.top : tiles.bottom);
    const y = top ? y1 : y0;
    const base = pos.length / 3;
    const mapU = (x) => u0 + (u1 - u0) * (0.5 + x / (2 * R));
    const mapV = (z) => v0 + (v1 - v0) * (0.5 + z / (2 * R));
    pos.push(0, y, 0);
    uv.push(mapU(0), mapV(0));
    nor.push(0, top ? 1 : -1, 0);
    for (let k = 0; k < 6; k++) {
      pos.push(cx[k], y, cz[k]);
      uv.push(mapU(cx[k]), mapV(cz[k]));
      nor.push(0, top ? 1 : -1, 0);
    }
    for (let k = 0; k < 6; k++) {
      const p = base + 1 + k;
      const q = base + 1 + ((k + 1) % 6);
      if (top) idx.push(base, q, p);
      else idx.push(base, p, q);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * @param {THREE.Scene} scene
 * @param {THREE.Texture|null} atlasTexture  the block atlas (zombie_* tiles); null draws untextured (tests)
 * @param {number} [capacity=ZOMBIE_MAX]     most zombies drawn (main: ZOMBIE_MAX + MAX_INFALL_MOBS, for ghosts)
 * @returns {ZombieRenderer}
 */
export function createZombieRenderer(scene, atlasTexture, capacity = ZOMBIE_MAX) {
  const geos = {
    // Feet hang from the hip: y from −FOOT_H to 0, so a rotation about x swings them.
    foot: hexPrismGeometry(FOOT_R, FOOT_H, -FOOT_H, { front: TILE.ZOMBIE_TROUSERS, sides: TILE.ZOMBIE_TROUSERS, top: TILE.ZOMBIE_TROUSERS, bottom: TILE.ZOMBIE_SOLE }),
    torso: hexPrismGeometry(TORSO_R, TORSO_H, 0, { front: TILE.ZOMBIE_SHIRT, sides: TILE.ZOMBIE_SHIRT, top: TILE.ZOMBIE_SHIRT, bottom: TILE.ZOMBIE_SHIRT }),
    head: hexPrismGeometry(HEAD_R, HEAD_H, 0, { front: TILE.ZOMBIE_FACE, sides: TILE.ZOMBIE_HEAD_SIDE, top: TILE.ZOMBIE_SCALP, bottom: TILE.ZOMBIE_HEAD_SIDE }),
  };
  const map = atlasTexture ?? null;
  const mats = {
    // A faint glow of their own texture (emissiveMap = the atlas) keeps them readable on a moonlit night, when they
    // are about; by day it is lost in the sunlight.
    base: new THREE.MeshLambertMaterial({ map, color: 0xffffff, emissive: NIGHT_GLOW, emissiveMap: map }),
    // The hit flash: a red glow through the texture, so the face still shows (a flat red would hide it at night).
    hurt: new THREE.MeshLambertMaterial({ map, color: 0xffffff, emissive: HURT, emissiveIntensity: HURT_INTENSITY, emissiveMap: map }),
    // Smouldering: sooty, with an ember glow that follows the texture (emissiveMap) rather than flattening it.
    burn: new THREE.MeshLambertMaterial({ map, color: SOOT, emissive: EMBER, emissiveIntensity: EMBER_INTENSITY, emissiveMap: map }),
  };
  const group = new THREE.Group();
  group.name = 'zombies';
  const instanced = (geo, mat, n, name) => {
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // instances move every frame
    mesh.count = 0;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  };
  /** @type {Record<'base'|'hurt'|'burn', { feet: THREE.InstancedMesh, torso: THREE.InstancedMesh, head: THREE.InstancedMesh }>} */
  const sets = /** @type {*} */ ({});
  for (const kind of /** @type {const} */ (['base', 'hurt', 'burn'])) {
    const suffix = kind === 'base' ? '' : `-${kind}`;
    sets[kind] = {
      feet: instanced(geos.foot, mats[kind], capacity * 2, `zombie-feet${suffix}`),
      torso: instanced(geos.torso, mats[kind], capacity, `zombie-torso${suffix}`),
      head: instanced(geos.head, mats[kind], capacity, `zombie-head${suffix}`),
    };
  }
  scene.add(group);

  const bodyM = new THREE.Matrix4();
  const partM = new THREE.Matrix4();
  const torsoM = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const q = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  const counts = { base: 0, hurt: 0, burn: 0 };
  let drawn = 0;

  /** @param {Zombie[]} zombies */
  function sync(zombies) {
    const n = Math.min(zombies.length, capacity);
    counts.base = 0;
    counts.hurt = 0;
    counts.burn = 0;
    for (let i = 0; i < n; i++) {
      const zb = zombies[i];
      const kind = zb.hurt > 0 ? 'hurt' : zb.smoking ? 'burn' : 'base';
      const set = sets[kind];
      const slot = counts[kind]++;
      const s = renderScaleOf(zb);
      bodyM.compose(at.set(zb.x, zb.y, zb.z), q.setFromAxisAngle(UP, zb.yaw + renderSpinOf(zb)), scl.set(s, s, s));
      const phase = zb.walkPhase || 0;
      const swingK = zb.swing > 0 ? zb.swing / SWING_S : 0;
      // Feet: swing from the hip in opposite phase.
      const swing = Math.sin(phase) * FOOT_SWING;
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -1 : 1;
        partM.multiplyMatrices(bodyM, tmp.makeTranslation(side * FOOT_X, FOOT_H, 0)).multiply(rot.makeRotationX(side * swing));
        set.feet.setMatrixAt(slot * 2 + k, partM);
      }
      // Torso: on the hips, leaning forward (more in a chase, a lurch after an attack), swaying with the stride.
      const lean = (zb.mode === 'chase' ? CHASE_LEAN : WALK_LEAN) + LURCH * Math.sin(Math.PI * swingK);
      torsoM.multiplyMatrices(bodyM, tmp.makeTranslation(0, FOOT_H, 0))
        .multiply(rot.makeRotationX(lean))
        .multiply(tmp.makeRotationZ(Math.sin(phase) * 0.06));
      set.torso.setMatrixAt(slot, torsoM);
      // Head: on the shoulders, lolling to its own side and nodding with the stride.
      partM.multiplyMatrices(torsoM, tmp.makeTranslation(0, TORSO_H, 0))
        .multiply(rot.makeRotationZ((zb.tilt || 0) + Math.sin(phase * 0.5) * 0.04))
        .multiply(tmp.makeRotationX(Math.cos(phase) * 0.05));
      set.head.setMatrixAt(slot, partM);
    }
    const setCount = (mesh, count) => {
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) mesh.instanceMatrix.needsUpdate = true;
    };
    for (const kind of /** @type {const} */ (['base', 'hurt', 'burn'])) {
      setCount(sets[kind].feet, counts[kind] * 2);
      setCount(sets[kind].torso, counts[kind]);
      setCount(sets[kind].head, counts[kind]);
    }
    drawn = n;
  }

  function dispose() {
    scene.remove(group);
    for (const set of Object.values(sets)) for (const mesh of Object.values(set)) mesh.dispose();
    for (const g of Object.values(geos)) g.dispose();
    for (const m of Object.values(mats)) m.dispose();
    drawn = 0;
  }

  return { sync, count: () => drawn, dispose, group };
}
