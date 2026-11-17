// Caelancraft — the avatars (PURE data: no three, no DOM). See src/CONTRACTS.md §91.
//
// An avatar is only how the player LOOKS: every one has the same collider and eye (PLAYER_HEIGHT, PLAYER_WIDTH,
// EYE_HEIGHT), so none plays differently. Each is DATA — a build in metres (legs, hips, torso, neck, arms), a faceted head,
// a hair style and its cut, hands, an outfit and a palette — so that new avatars, skins and wardrobes are new entries here,
// not new code: avatarModel.js builds and paints any entry, avatarRenderer.js draws and animates any entry.
//
// The look is the honeycomb's own (docs/DESIGN-characters.md, style A): tapered HEXAGONAL columns with flat facets for
// limbs and torsos, a faceted head with a flat face plane, hair as a mass or a cap with big swept clumps, chamfered hands
// and shoes, every part wrapped in a painted 256² atlas (cloth weave, denim, knit, stitching, a face with irises and
// catchlights). Cheerful and readable at a glance. The model faces −Z with its feet at the origin; it is drawn at `scale`
// of its build, so that the top of its hair is `height`.
//   Caelan    — a young boy of medium height, athletic and tapered, a MILD OLIVE skin, a dirty-blonde POOFY mop (cut C2,
//               tousled: taller, higher at the front), green-blue-grey eyes, a few freckles; a green long-sleeved tee with
//               a white stripe, its sleeves pushed up to a knit cuff, jeans with a belt, white sneakers with a red flash.
//   Brayden   — a tall, slender boy (long legs and arms, narrow shoulders), fair skin, SILKY auburn hair in a side sweep (B1),
//               brown eyes; a blue tee with a pocket, khaki trousers, brown leather lace-ups.
//   Annabelle — a taller, sturdily built girl, fair skin, golden-blonde LONG WAVY hair (A1: a fringe, a framing lock each
//               side, a curtain of waves down her back), blue eyes with lashes; a rose dress with puffed sleeves, a round
//               white collar, a sash with a bow at the back, a pleated skirt with a white hem, white socks, red strap shoes.

/**
 * The avatar's build, in metres of its BUILD (drawn at `scale`): the model faces −Z, its feet at the origin, x to its right.
 * @typedef {Object} AvatarBody
 * @property {number} legX      each leg's middle from the middle
 * @property {number} ankle     the leg's lower end over the ground (the shoe under it)
 * @property {{ rx: number, rz: number, len: number }} leg  half its width and depth; ankle to hip (the hip joint is its top)
 * @property {{ y0: number, y1: number, rx: number, rz: number }} hips  the seat of the trousers (or a dress's waist)
 * @property {{ y0: number, h: number, rx: number, rz: number }} torso
 * @property {{ y0: number, y1: number, r: number }} neck
 * @property {number[]} shoulder  the right shoulder joint [x, y, z] (the left one mirrors it)
 * @property {number[]} elbow     the right elbow at rest
 * @property {number[]} wrist     the right wrist at rest
 * @property {{ rx: number, rz: number }} upper  the upper arm's section
 * @property {{ rx: number, rz: number }} fore   the forearm's
 */
/**
 * The faceted head (figureKit.js), metres, built from the chin up.
 * @typedef {Object} AvatarHead
 * @property {number} y      the chin, over the feet
 * @property {number} h      chin to crown
 * @property {number} rx     half its width
 * @property {number} rz     half its depth
 * @property {number} eyeAt  the eyes' height, a share of h
 * @property {number} eyeX   each eye's middle from the middle of the face
 * @property {number} eyeW   an eye's width
 * @property {number} mouthAt
 * @property {number} noseAt  the middle of the nose
 * @property {ReadonlyArray<ReadonlyArray<number>>} [shape]  its profile (ROUND_HEAD, OVAL_HEAD; default figureKit.KID_HEAD)
 */
/**
 * @typedef {Object} AvatarHair
 * @property {'poofy'|'silky'|'longWavy'} style  poofy: one faceted MASS (never locks); silky and longWavy: a scalp cap and
 *   big clumps lying on it
 * @property {string} cut      the style's cut (avatarModel.HAIR_CUTS): poofy C1 | C2, silky B1 | B2, longWavy A1 | A2
 * @property {number} crown    how far the hair stands over the top of the head (metres of the build)
 */
/**
 * @typedef {Object} AvatarHands
 * @property {number[]} palm     [w, h, d] the palm and the back of the hand (a chamfered block)
 * @property {number[]} fingers  [w, h, d] the fingers held together (a chamfered block, curled in)
 * @property {number[]} thumb    [w, h, d] the thumb (a wedge)
 */
/**
 * @typedef {Object} AvatarShoes
 * @property {'sneaker'|'laceup'|'strap'} style
 * @property {number[]} size    [w, h, d] metres
 * @property {number[]} colors  [upper, sole] (+ the flash on a sneaker's sides)
 */
/**
 * @typedef {Object} AvatarOutfit
 * @property {'tee'|'dress'} kind
 * @property {number[]} top          the tee's or the dress's cloth: [light, mid, dark]
 * @property {number} trim           collar, hem and the like
 * @property {'stripe'|'pocket'|'collar'} detail  the one thing on the front: a stripe across the chest, a pocket, a round collar
 * @property {number} sleeve         the share of the upper arm the sleeve covers (1: all of it)
 * @property {number} [puff]         a short sleeve standing out this much (×)
 * @property {number} [cuffAt]       a long sleeve pushed up: its cuff, a share of the forearm from the wrist (on the model
 *   and on the first-person forearm; without it the forearm is bare in both)
 * @property {number[]} [bottom]     tee: the trousers: [light, mid, dark]
 * @property {'denim'|'cloth'} [fabric]  tee: the trousers' cloth
 * @property {number} [belt]         tee: the belt
 * @property {number} [sash]         dress: the band round the waist and its bow
 * @property {{ y0: number, y1: number, r0: number, r1: number }} [skirt]  dress: a pleated skirt, waist (y0, r0) to hem (y1, r1)
 * @property {{ color: number, up: number }} [socks]  dress: socks up this share of the leg
 * @property {AvatarShoes} shoes
 */
/**
 * @typedef {Object} AvatarPalette
 * @property {number[]} skin   [light, mid, dark, deep]
 * @property {number[]} hair   [highlight, light, mid, dark]
 * @property {number[]} eyes   [iris, deep]
 * @property {number} brows
 * @property {number} mouth
 * @property {number} blush
 * @property {boolean} [lashes]    a dark lash flicking out of the outer corner of each eye
 * @property {boolean} [freckles]  a few across the cheeks
 */
/**
 * @typedef {Object} AvatarDef
 * @property {string} id
 * @property {string} displayName
 * @property {string} blurb        one short line for the chooser
 * @property {number} height       metres, feet to the top of the hair (avatarHeight(def) to within 1/32 m)
 * @property {number} scale        the model is drawn at this share of its build
 * @property {AvatarBody} body
 * @property {AvatarHead} head
 * @property {AvatarHair} hair
 * @property {AvatarHands} hands
 * @property {AvatarOutfit} outfit
 * @property {AvatarPalette} palette
 */

const freezeDeep = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) freezeDeep(v);
  return Object.freeze(o);
};

/** A child's hands (every avatar's, for now). */
const KID_HANDS = { palm: [0.042, 0.08, 0.08], fingers: [0.036, 0.062, 0.074], thumb: [0.028, 0.055, 0.026] };

/** The avatars, in the chooser's order. @type {ReadonlyArray<AvatarDef>} */
/**
 * Head profiles, chin to crown: [height share, width, depth, forward shift (m)] per ring (figureKit.KID_HEAD's form; an
 * avatar without one has KID_HEAD). ROUND_HEAD: a wide chin and jaw, full cheeks, widest low — a round face. OVAL_HEAD: a
 * narrow chin and a long jaw, widest high — a long oval face.
 */
export const ROUND_HEAD = Object.freeze([
  [0, 0.66, 0.68, -0.032], [0.11, 0.9, 0.9, -0.018], [0.28, 1.01, 0.96, -0.006], [0.5, 1.04, 0.99, 0],
  [0.71, 1.03, 1.01, 0.004], [0.86, 0.98, 1.03, 0.016], [0.955, 0.8, 0.86, 0.022], [1, 0.5, 0.54, 0.02],
].map((r) => Object.freeze(r)));
export const OVAL_HEAD = Object.freeze([
  [0, 0.36, 0.46, -0.036], [0.15, 0.64, 0.74, -0.022], [0.36, 0.88, 0.9, -0.006], [0.58, 0.97, 0.96, 0],
  [0.76, 0.98, 0.99, 0.004], [0.885, 0.93, 1.02, 0.016], [0.965, 0.74, 0.84, 0.02], [1, 0.4, 0.46, 0.02],
].map((r) => Object.freeze(r)));

export const AVATARS = freezeDeep([
  {
    id: 'caelan',
    displayName: 'Caelan',
    blurb: 'Medium height, athletic',
    height: 1.625,
    scale: 0.955,
    body: {
      legX: 0.092, ankle: 0.08, leg: { rx: 0.085, rz: 0.088, len: 0.65 }, hips: { y0: 0.63, y1: 0.85, rx: 0.176, rz: 0.114 },
      torso: { y0: 0.79, h: 0.365, rx: 0.184, rz: 0.118 }, neck: { y0: 1.1, y1: 1.235, r: 0.064 },
      shoulder: [0.222, 1.095, 0.005], elbow: [0.252, 0.845, 0.028], wrist: [0.268, 0.625, -0.03],
      upper: { rx: 0.067, rz: 0.064 }, fore: { rx: 0.066, rz: 0.06 },
    },
    // a round face: broad cheeks and a wide, soft jaw (the user: "Caelan is much more rounded")
    head: {
      y: 1.23, h: 0.355, rx: 0.182, rz: 0.177, eyeAt: 0.52, eyeX: 0.061, eyeW: 0.055, mouthAt: 0.215, noseAt: 0.37,
      shape: ROUND_HEAD,
    },
    hair: { style: 'poofy', cut: 'C2', crown: 0.117 },
    hands: KID_HANDS,
    outfit: {
      kind: 'tee',
      top: [0x5fbf63, 0x46a24e, 0x347f3c],
      trim: 0xf3f0e4,
      detail: 'stripe',
      sleeve: 1,
      cuffAt: 0.45,
      bottom: [0x5a7cb4, 0x42639b, 0x31497a],
      fabric: 'denim',
      belt: 0x6b4a2e,
      shoes: { style: 'sneaker', size: [0.118, 0.09, 0.228], colors: [0xefeee8, 0x8f908c, 0xd2473a] },
    },
    palette: {
      skin: [0xead0b0, 0xdab894, 0xbea27d, 0x9a8764],
      hair: [0xdcc386, 0xc6a86a, 0xab8e54, 0x87693a],
      eyes: [0x6e958f, 0x41605b],
      brows: 0x7d6036,
      mouth: 0x9c4b40,
      blush: 0xd29778,
      freckles: true,
    },
  },
  {
    id: 'brayden',
    displayName: 'Brayden',
    blurb: 'Tall and slender',
    height: 1.781,
    scale: 0.972,
    body: {
      legX: 0.084, ankle: 0.08, leg: { rx: 0.077, rz: 0.08, len: 0.83 }, hips: { y0: 0.82, y1: 1.03, rx: 0.158, rz: 0.104 },
      torso: { y0: 0.97, h: 0.39, rx: 0.166, rz: 0.106 }, neck: { y0: 1.32, y1: 1.45, r: 0.056 },
      shoulder: [0.2, 1.32, 0.005], elbow: [0.224, 1.035, 0.03], wrist: [0.238, 0.775, -0.02],
      upper: { rx: 0.058, rz: 0.056 }, fore: { rx: 0.058, rz: 0.053 },
    },
    // a long oval face: narrow, tall, the jaw tapering to a narrower chin (the user: "an oval long shaped face")
    head: {
      y: 1.405, h: 0.37, rx: 0.147, rz: 0.158, eyeAt: 0.53, eyeX: 0.052, eyeW: 0.049, mouthAt: 0.215, noseAt: 0.38,
      shape: OVAL_HEAD,
    },
    hair: { style: 'silky', cut: 'B1', crown: 0.058 },
    hands: KID_HANDS,
    outfit: {
      kind: 'tee',
      top: [0x4f7fcf, 0x3866b3, 0x284c8c],
      trim: 0xe9e5d8,
      detail: 'pocket',
      sleeve: 0.5,
      puff: 1.14,
      bottom: [0xcbb88c, 0xb4a176, 0x938361],
      fabric: 'cloth',
      belt: 0x4a3424,
      shoes: { style: 'laceup', size: [0.11, 0.085, 0.235], colors: [0x6c4629, 0x3f2a1a] },
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
    scale: 1.009,
    body: {
      legX: 0.098, ankle: 0.075, leg: { rx: 0.088, rz: 0.09, len: 0.7 }, hips: { y0: 0.68, y1: 0.9, rx: 0.19, rz: 0.125 },
      torso: { y0: 0.82, h: 0.4, rx: 0.196, rz: 0.128 }, neck: { y0: 1.18, y1: 1.31, r: 0.064 },
      shoulder: [0.236, 1.185, 0.005], elbow: [0.264, 0.92, 0.03], wrist: [0.28, 0.69, -0.03],
      upper: { rx: 0.07, rz: 0.066 }, fore: { rx: 0.067, rz: 0.06 },
    },
    head: { y: 1.29, h: 0.37, rx: 0.174, rz: 0.176, eyeAt: 0.52, eyeX: 0.059, eyeW: 0.056, mouthAt: 0.215, noseAt: 0.37 },
    hair: { style: 'longWavy', cut: 'A1', crown: 0.043 },
    hands: KID_HANDS,
    outfit: {
      kind: 'dress',
      top: [0xf38ca8, 0xe26c8d, 0xc14f71],
      trim: 0xfbf7f0,
      detail: 'collar',
      sleeve: 0.42,
      puff: 1.42,
      sash: 0xfbf7f0,
      skirt: { y0: 0.9, y1: 0.5, r0: 0.205, r1: 0.31 },
      socks: { color: 0xfbf7f0, up: 0.42 },
      shoes: { style: 'strap', size: [0.115, 0.075, 0.215], colors: [0xb53a33, 0x5a2420] },
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
 * The avatar's height from its build: the top of its head plus its hair's crown, at its scale.
 * @param {AvatarDef} def
 * @returns {number} metres
 */
export function avatarHeight(def) {
  return (def.head.y + def.head.h + def.hair.crown) * def.scale;
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
