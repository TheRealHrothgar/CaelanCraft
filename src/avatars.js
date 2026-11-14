// Caelancraft — the avatars (PURE data: no three, no DOM). See src/CONTRACTS.md §91.
//
// An avatar is only how the player LOOKS: every one has the same collider and eye (PLAYER_HEIGHT, PLAYER_WIDTH,
// EYE_HEIGHT), so none plays differently. Each is DATA — body proportions in skin texels (AVATAR_TEXEL metres each), a hair
// style, an outfit kind and a palette — so that new avatars, skins and wardrobes are new entries here, not new code:
// avatarSkin.js paints any entry, avatarRenderer.js builds and animates any entry.
//
// The look is the terrain's and the zombies': a few plain boxes wrapped in chunky pixel art, cheerful and readable at a
// glance. Every box is { w, h, d } texels: w across (model x), h tall (y), d deep (z); the model faces −Z.
//   Caelan    — a young boy of medium height, athletic and tapered (broad shoulders, a narrower waist), olive skin,
//               dirty-blonde poofy hair with tufts that stick out, green-blue-grey eyes; a green tee, jeans, sneakers.
//   Brayden   — a tall, slender boy (long legs and arms, narrow shoulders), fair skin, silky auburn hair swept to one side,
//               brown eyes; a blue tee with a pocket, khaki trousers, brown shoes.
//   Annabelle — a taller, sturdily built girl (solid shoulders and hips), golden-blonde long wavy hair down her back,
//               blue eyes; a rose dress with a white collar, sash and hem, white socks, red shoes.
import { AVATAR_TEXEL } from './config.js';

/** @typedef {{ w: number, h: number, d: number }} BoxDims  texels */
/**
 * A box placed relative to the bottom centre of the head (texels: x to the model's right, y up, z toward its back), turned
 * `rz` about z and `rx` about x (radians).
 * @typedef {BoxDims & { x: number, y: number, z: number, rx?: number, rz?: number }} PlacedBox
 */
/**
 * @typedef {Object} AvatarBody
 * @property {BoxDims} head
 * @property {BoxDims} chest     the upper torso, shoulder to shoulder
 * @property {BoxDims} waist     the lower torso (narrower for a tapered build)
 * @property {BoxDims} leg
 * @property {number} legGap     texels between the legs
 * @property {BoxDims} upperArm  shoulder to elbow
 * @property {BoxDims} foreArm   elbow to fingertips …
 * @property {number} hand       … whose last `hand` rows are the hand
 */
/**
 * @typedef {Object} AvatarHair
 * @property {'poofy'|'silky'|'longWavy'} style
 * @property {BoxDims & { y: number }} box   the hair layer round the head, its bottom `y` texels up the head (centred on it)
 * @property {PlacedBox[]} [tufts]           poofy: tufts that stick out (the hair layer's own small boxes)
 * @property {BoxDims & { top: number }} [back]  long hair: a panel down the back whose top is `top` texels above the
 *                                           shoulders (it hangs from the torso, behind the hair layer)
 */
/**
 * @typedef {Object} AvatarOutfit
 * @property {'tee'|'dress'} kind
 * @property {number[]} top          the tee's or the dress's cloth: [light, mid, dark]
 * @property {number} trim           collar, hem and the like
 * @property {'stripe'|'pocket'|'collar'} detail  the one thing on the front: a stripe across the chest, a pocket, a round collar
 * @property {number} sleeve         texels of the upper arm the sleeve covers
 * @property {number[]} [bottom]     tee: the trousers: [light, mid, dark]
 * @property {number} [sash]         dress: the band round the waist
 * @property {BoxDims} [skirt]       dress: the skirt, a flared box over the upper legs
 * @property {number} [skirtUp]      dress: how far the skirt reaches up the waist (texels)
 * @property {number} [socks]        dress: sock colour
 * @property {number[]} shoes        [upper, sole] (+ an accent for sneakers)
 */
/**
 * @typedef {Object} AvatarPalette
 * @property {number[]} skin   [light, mid, dark, deep]
 * @property {number[]} hair   [highlight, light, mid, dark]
 * @property {number[]} eyes   [iris, deep]
 * @property {number} brows
 * @property {number} mouth
 * @property {number} blush
 * @property {boolean} [lashes]  a dark lash above the outer corner of each eye
 */
/**
 * @typedef {Object} AvatarDef
 * @property {string} id
 * @property {string} displayName
 * @property {string} blurb        one short line for the chooser
 * @property {number} height       metres, feet to the top of the hair (avatarHeight(def) to within a texel)
 * @property {AvatarBody} body
 * @property {AvatarHair} hair
 * @property {AvatarOutfit} outfit
 * @property {AvatarPalette} palette
 */

const freezeDeep = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) freezeDeep(v);
  return Object.freeze(o);
};

/** The avatars, in the chooser's order. @type {ReadonlyArray<AvatarDef>} */
export const AVATARS = freezeDeep([
  {
    id: 'caelan',
    displayName: 'Caelan',
    blurb: 'Medium height, athletic',
    height: 1.625,
    body: {
      head: { w: 14, h: 14, d: 14 },
      chest: { w: 18, h: 10, d: 9 },
      waist: { w: 14, h: 7, d: 8 },
      leg: { w: 7, h: 19, d: 7 },
      legGap: 0,
      upperArm: { w: 5, h: 9, d: 5 },
      foreArm: { w: 5, h: 11, d: 5 },
      hand: 3,
    },
    hair: {
      style: 'poofy',
      box: { w: 18, h: 12, d: 18, y: 4 },
      tufts: [
        { w: 4, h: 3, d: 4, x: -4.5, y: 16.6, z: -2, rz: 0.35 },
        { w: 4, h: 3, d: 4, x: 3.5, y: 16.8, z: 1, rz: -0.3 },
        { w: 4, h: 3, d: 4, x: -1, y: 16.4, z: 5.5, rx: 0.4 },
        { w: 3, h: 3, d: 4, x: 9.2, y: 12.5, z: 3, rz: -0.5 },
        { w: 3, h: 3, d: 4, x: -9.2, y: 12.8, z: 2, rz: 0.5 },
      ],
    },
    outfit: {
      kind: 'tee',
      top: [0x5fbf63, 0x46a24e, 0x347f3c],
      trim: 0xf3f0e4,
      detail: 'stripe',
      sleeve: 5,
      bottom: [0x5a7cb4, 0x42639b, 0x31497a],
      shoes: [0xefeee8, 0x8f908c, 0xd2473a],
    },
    palette: {
      skin: [0xd5b086, 0xc49c6e, 0xab845b, 0x8e6b48],
      hair: [0xdcc386, 0xc6a86a, 0xab8e54, 0x87693a],
      eyes: [0x6e958f, 0x41605b],
      brows: 0x7d6036,
      mouth: 0x9c4b40,
      blush: 0xd29778,
    },
  },
  {
    id: 'brayden',
    displayName: 'Brayden',
    blurb: 'Tall and slender',
    height: 1.781,
    body: {
      head: { w: 13, h: 13, d: 13 },
      chest: { w: 15, h: 10, d: 7 },
      waist: { w: 13, h: 8, d: 7 },
      leg: { w: 6, h: 25, d: 6 },
      legGap: 1,
      upperArm: { w: 4, h: 11, d: 4 },
      foreArm: { w: 4, h: 12, d: 4 },
      hand: 3,
    },
    hair: {
      style: 'silky',
      box: { w: 15, h: 11, d: 15, y: 3 },
    },
    outfit: {
      kind: 'tee',
      top: [0x4f7fcf, 0x3866b3, 0x284c8c],
      trim: 0xe9e5d8,
      detail: 'pocket',
      sleeve: 6,
      bottom: [0xcbb88c, 0xb4a176, 0x938361],
      shoes: [0x6c4629, 0x3f2a1a],
    },
    palette: {
      skin: [0xfae3d2, 0xf1cfb8, 0xdeb49b, 0xc6977c],
      hair: [0xc8703f, 0xab562d, 0x8e4221, 0x6c3017],
      eyes: [0x7a4d29, 0x472b14],
      brows: 0x6c3017,
      mouth: 0xb15f58,
      blush: 0xf1b2a2,
    },
  },
  {
    id: 'annabelle',
    displayName: 'Annabelle',
    blurb: 'Taller and strong',
    height: 1.719,
    body: {
      head: { w: 14, h: 14, d: 14 },
      chest: { w: 18, h: 11, d: 10 },
      waist: { w: 16, h: 8, d: 9 },
      leg: { w: 7, h: 21, d: 7 },
      legGap: 2,
      upperArm: { w: 5, h: 10, d: 5 },
      foreArm: { w: 5, h: 11, d: 5 },
      hand: 3,
    },
    hair: {
      style: 'longWavy',
      box: { w: 16, h: 13, d: 16, y: 2 },
      back: { w: 16, h: 18, d: 3, top: 6 },
    },
    outfit: {
      kind: 'dress',
      top: [0xf38ca8, 0xe26c8d, 0xc14f71],
      trim: 0xfbf7f0,
      detail: 'collar',
      sleeve: 4,
      sash: 0xfbf7f0,
      skirt: { w: 18, h: 10, d: 13 },
      skirtUp: 2,
      socks: 0xfbf7f0,
      shoes: [0xb53a33, 0x5a2420],
    },
    palette: {
      skin: [0xfce2cb, 0xf4cdb0, 0xe2b494, 0xca9978],
      hair: [0xfbe293, 0xf1c962, 0xdcab40, 0xb98a2b],
      eyes: [0x3f82d8, 0x2a58a0],
      brows: 0xb98a2b,
      mouth: 0xc95a66,
      blush: 0xf5a9a0,
      lashes: true,
    },
  },
]);

/** The ids, in order. */
export const AVATAR_IDS = Object.freeze(AVATARS.map((a) => a.id));
/** The avatar a new player has. */
export const DEFAULT_AVATAR = 'caelan';
/** localStorage key of the chosen avatar: a per-player preference, the same for every world (§91). */
export const AVATAR_PREF_KEY = 'caelancraft:v2:avatar';

/**
 * An avatar id from anything: one of AVATAR_IDS (case-insensitive, trimmed), else null.
 * @param {*} v
 * @returns {string|null}
 */
export function normalizeAvatarId(v) {
  if (typeof v !== 'string') return null;
  const id = v.trim().toLowerCase();
  return AVATAR_IDS.includes(id) ? id : null;
}

/**
 * @param {string} id
 * @returns {AvatarDef} that avatar, or the default one for an unknown id
 */
export function avatarById(id) {
  return AVATARS.find((a) => a.id === id) ?? /** @type {AvatarDef} */ (AVATARS.find((a) => a.id === DEFAULT_AVATAR));
}

/**
 * The avatar's height from its boxes: legs, waist, chest and the top of its head or its hair layer (tufts excepted).
 * @param {AvatarDef} def
 * @returns {number} metres
 */
export function avatarHeight(def) {
  const b = def.body;
  const head = Math.max(b.head.h, def.hair.box.y + def.hair.box.h);
  return (b.leg.h + b.waist.h + b.chest.h + head) * AVATAR_TEXEL;
}

/**
 * The stored avatar (DEFAULT_AVATAR when there is none, it is unknown, or the store cannot be read).
 * @param {{ getItem(k: string): string|null }|null|undefined} storage
 * @returns {string}
 */
export function loadAvatarPref(storage) {
  try {
    return (storage && normalizeAvatarId(storage.getItem(AVATAR_PREF_KEY))) || DEFAULT_AVATAR;
  } catch {
    return DEFAULT_AVATAR;
  }
}

/**
 * Keep the chosen avatar (nothing for an unknown id; a full or blocked store keeps it for this visit only).
 * @param {{ setItem(k: string, v: string): void }|null|undefined} storage
 * @param {string} id
 * @returns {boolean} it was stored
 */
export function saveAvatarPref(storage, id) {
  const ok = normalizeAvatarId(id);
  if (!storage || !ok) return false;
  try {
    storage.setItem(AVATAR_PREF_KEY, ok);
    return true;
  } catch {
    return false;
  }
}
