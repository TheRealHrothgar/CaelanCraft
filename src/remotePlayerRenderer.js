// Caelancraft — the other players on a server (docs/DESIGN-multiplayer.md §4 phase 1): each one drawn as their avatar,
// animated from their interpolated pose (AvatarMotion, as the player's own model), with their name above the head.
//
// One avatar renderer per remote player (each shows one model at a time): a family's few players cost a few small
// textures. Built when a player first appears, disposed when they leave.
import * as THREE from 'three';
import { createAvatarRenderer } from './avatarRenderer.js';
import { AvatarMotion } from './avatarMotion.js';
import { PLAYER_HEIGHT } from './config.js';
import { POSE_FLYING, POSE_SNEAKING, POSE_ON_GROUND, POSE_SWIMMING, POSE_DRAWING } from './protocol.js';

/** The name tag's height above the feet (m). */
const TAG_Y = PLAYER_HEIGHT + 0.45;
/** The name tag's size in the world (m). */
const TAG_W = 1.6;
const TAG_H = 0.4;

/** The name tag's type: the menus' rounded face (§97). */
const TAG_FONT = '600 32px ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif';

/**
 * A name tag: white words on a capsule of dark glass with a light rim (the menus' look, §97), always facing the camera.
 * @param {Document} doc @param {string} name
 */
function makeTag(doc, name) {
  const canvas = doc.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  if (g) {
    g.font = TAG_FONT;
    const w = Math.min(250, g.measureText(name).width + 36);
    const x = (256 - w) / 2;
    const capsule = () => {
      g.beginPath();
      if (typeof g.roundRect === 'function') g.roundRect(x, 9, w, 46, 23);
      else g.rect(x, 9, w, 46);
    };
    capsule();
    g.fillStyle = 'rgba(20, 22, 32, 0.55)';
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    g.stroke();
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name, 128, 33, 230);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(TAG_W, TAG_H, 1);
  sprite.name = 'remote-player-tag';
  return { sprite, dispose: () => { map.dispose(); material.dispose(); } };
}

/**
 * @param {THREE.Scene} scene
 * @param {Document} doc
 */
export function createRemotePlayerRenderer(scene, doc) {
  /**
   * @type {Map<number, { avatar: import('./avatarRenderer.js').AvatarRenderer, avatarId: string, motion: AvatarMotion,
   *   tag: ReturnType<typeof makeTag>, name: string, swings: number, held: string|null }>}
   */
  const shown = new Map();
  /** @type {import('./avatarMotion.js').MotionInput} */
  const input = {
    yaw: 0, pitch: 0, vx: 0, vz: 0, onGround: true, sneaking: false, swimming: false, flying: false, riding: false, sleeping: false,
    draw: 0,
  };

  function remove(id) {
    const e = shown.get(id);
    if (!e) return;
    e.avatar.dispose();
    scene.remove(e.tag.sprite);
    e.tag.dispose();
    shown.delete(id);
  }

  /**
   * Draw every remote player at local time `t` (s), their motion stepped by `dt` (0 while the world is frozen).
   * @param {import('./net.js').RemotePlayers} remotes @param {number} t @param {number} dt
   */
  function sync(remotes, t, dt) {
    const live = new Set();
    for (const rp of remotes.list()) {
      const pose = remotes.sample(rp.id, t);
      if (!pose) continue;
      live.add(rp.id);
      let e = shown.get(rp.id);
      if (e && e.name !== rp.name) {
        remove(rp.id);
        e = undefined;
      }
      if (!e) {
        const avatar = createAvatarRenderer(scene, { avatar: rp.avatar }); // only their avatar's figure is built
        const tag = makeTag(doc, rp.name);
        scene.add(tag.sprite);
        const motion = new AvatarMotion();
        motion.reset(pose.yaw);
        e = { avatar, avatarId: rp.avatar, motion, tag, name: rp.name, swings: rp.swings, held: null };
        shown.set(rp.id, e);
      }
      if (e.avatarId !== rp.avatar) {
        e.avatar.setAvatar(rp.avatar);
        e.avatarId = rp.avatar;
      }
      if (rp.held !== e.held) { // §98: what they hold, in their avatar's hand
        e.held = rp.held;
        e.avatar.setHeld(rp.held);
      }
      if (rp.swings !== e.swings) {
        e.swings = rp.swings;
        e.motion.swing();
      }
      input.yaw = pose.yaw;
      input.pitch = pose.pitch;
      input.vx = pose.vx;
      input.vz = pose.vz;
      input.onGround = (pose.flags & POSE_ON_GROUND) !== 0;
      input.sneaking = (pose.flags & POSE_SNEAKING) !== 0;
      input.flying = (pose.flags & POSE_FLYING) !== 0;
      input.swimming = (pose.flags & POSE_SWIMMING) !== 0;
      input.draw = (pose.flags & POSE_DRAWING) !== 0 ? 1 : 0; // §100: the motion brings the arms up at a draw's pace
      e.motion.step(dt, input);
      e.avatar.sync({ x: pose.x, y: pose.y, z: pose.z, pose: e.motion.pose, showModel: true, showArm: false, camera: null });
      e.tag.sprite.position.set(pose.x, pose.y + TAG_Y - e.motion.pose.hipDrop, pose.z);
    }
    for (const id of [...shown.keys()]) if (!live.has(id)) remove(id);
  }

  function clear() {
    for (const id of [...shown.keys()]) remove(id);
  }

  return { sync, clear, dispose: clear, count: () => shown.size };
}
