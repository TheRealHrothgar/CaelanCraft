// Caelancraft — animal models (three): cattle, sheep, horses and wolves (CONTRACTS §69), and the game of the harder
// land (v0.14, §76 fauna): deer, rabbits, pheasants, wild turkeys, bears and fish.
//
// Chunky boxes coloured per vertex, like the pig and the zombie (zombieRenderer.boxesGeometry): each species is a body
// (trunk, head and features merged) and four legs that swing from the hip with `walkPhase`, diagonal pairs together. The
// models face −Z with their origin at the feet, so a rotation of `animal.yaw` about +Y matches yawToForward.
// Variants are their own bodies: a shorn sheep is thin and pink-grey, a tame horse wears a saddle and a blanket, a tame
// wolf a red collar. All animals share the InstancedMeshes (per species: a body or its variant, and the legs), and an
// animal with `hurt > 0` is drawn on the red-flash twins. An animal's optional `renderScale` / `renderSpin` draw a black
// hole's shrinking, spinning ghost (infall.js), like the pigs' and the zombies'.
//
// v0.14 (§76 fauna). Each new kind is told from the others by ONE bold feature that reads from far off: a stag's
// antlers (the deer's `alt` body), a rabbit's upright ears and cotton tail, a pheasant's long barred tail, a turkey's
// fan, a bear's bulk, a fish's orange fins. A model may also say: `legs` (2 for a bird, 0 for a fish; 4 when absent),
// `hop` (how high the stride bobs: a rabbit bounds), `wiggle` (a fish's body swings with its tail), `wing` (two flat
// wings drawn only in the air, beating with `walkPhase`; the legs are tucked back then), `rear` (the bear's rear-up:
// the body pitches up about its hips by `animal.rear`, the forelegs rise with it and swing when it swipes) and `head`
// (a head of its own, which stays level while the body rears: a rearing bear looks AT the player, not at the sky).
import * as THREE from 'three';
import { boxesGeometry } from './zombieRenderer.js';
import { ANIMAL_MAX, ANIMAL_KINDS, BEAR_SWIPE_S } from './animals.js';
import { compileHidden } from './prewarm.js';

/** @typedef {import('./animals.js').Animal} Animal */

const HURT = 0xff2a2a;
const HURT_INTENSITY = 0.7;
/** A faint glow of their own so they read at night (like the zombies'). */
const NIGHT_GLOW = 0x1a1a1a;
const DARK = 0x2a2420;
const WHITE = 0xf6f2ea;

/**
 * Per species: `legH` the hip height, `legW` the leg's width, `legX` / `legZ` the hips (±x, front −z and back +z), `swing`
 * the stride (rad), `leg` the leg's colours [upper, hoof], and the bodies' boxes [w, h, d, x, y, z, colour, rotZ?].
 */
const COW = 0x8b5a3c;
const SHEEP = 0xf3f0e7;
const HORSE = 0x9c5a2e;
const WOLF = 0x8c9096;
// v0.14 (§76 fauna)
const DEER = 0xb5834e;
const RABBIT = 0x9a8468;
const COPPER = 0xb5622a;
const TURKEY = 0x4a3a2c;
const BEAR = 0x6a4628;
const BEAR_DARK = 0x3a2618;
const FISH = 0xf0a23c;
const FIN = 0x7a2e16;
export const MODELS = Object.freeze({
  cow: {
    legH: 0.55, legW: 0.15, legX: 0.2, legZ: [-0.4, 0.4], swing: 0.45, leg: [COW, DARK],
    body: [
      [0.62, 0.6, 1.15, 0, 0.85, 0, COW],
      [0.3, 0.3, 0.02, 0.17, 0.92, -0.585, WHITE], [0.02, 0.34, 0.4, 0.315, 0.9, 0.1, WHITE], [0.02, 0.3, 0.34, -0.315, 0.86, -0.2, WHITE],
      [0.34, 0.02, 0.4, 0.05, 1.155, 0.2, WHITE], // white patches
      [0.38, 0.4, 0.42, 0, 1.0, -0.76, COW], // head
      [0.3, 0.2, 0.14, 0, 0.88, -1.0, 0xe9b3a4], // muzzle
      [0.06, 0.05, 0.02, -0.08, 0.88, -1.075, DARK], [0.06, 0.05, 0.02, 0.08, 0.88, -1.075, DARK], // nostrils
      [0.07, 0.07, 0.02, -0.12, 1.08, -0.975, DARK], [0.07, 0.07, 0.02, 0.12, 1.08, -0.975, DARK], // eyes
      [0.1, 0.07, 0.07, -0.23, 1.22, -0.72, 0xefe6d2], [0.1, 0.07, 0.07, 0.23, 1.22, -0.72, 0xefe6d2], // horns
      [0.1, 0.06, 0.1, -0.24, 1.08, -0.7, COW], [0.1, 0.06, 0.1, 0.24, 1.08, -0.7, COW], // ears
      [0.3, 0.1, 0.3, 0, 0.52, 0.25, 0xe9b3a4], // udder
      [0.06, 0.4, 0.06, 0, 0.9, 0.6, COW], [0.09, 0.1, 0.09, 0, 0.66, 0.6, DARK], // tail
    ],
  },
  sheep: {
    legH: 0.42, legW: 0.11, legX: 0.17, legZ: [-0.27, 0.27], swing: 0.55, leg: [0x4a443e, DARK],
    body: [
      [0.62, 0.56, 0.88, 0, 0.68, 0.02, SHEEP],
      [0.5, 0.1, 0.7, 0, 0.99, 0.02, 0xfffdf6], // the fleece's top
      [0.28, 0.3, 0.3, 0, 0.8, -0.56, 0x4a443e], // head
      [0.3, 0.12, 0.22, 0, 0.98, -0.5, SHEEP], // woolly cap
      [0.05, 0.05, 0.02, -0.08, 0.84, -0.715, WHITE], [0.05, 0.05, 0.02, 0.08, 0.84, -0.715, WHITE], // eyes
      [0.1, 0.05, 0.08, -0.18, 0.84, -0.5, 0x4a443e], [0.1, 0.05, 0.08, 0.18, 0.84, -0.5, 0x4a443e], // ears
      [0.12, 0.12, 0.1, 0, 0.72, 0.48, SHEEP], // tail
    ],
    alt: [
      [0.4, 0.4, 0.78, 0, 0.62, 0.02, 0xdccbbd],
      [0.28, 0.3, 0.3, 0, 0.8, -0.52, 0x4a443e],
      [0.05, 0.05, 0.02, -0.08, 0.84, -0.675, WHITE], [0.05, 0.05, 0.02, 0.08, 0.84, -0.675, WHITE],
      [0.1, 0.05, 0.08, -0.18, 0.84, -0.46, 0x4a443e], [0.1, 0.05, 0.08, 0.18, 0.84, -0.46, 0x4a443e],
      [0.08, 0.08, 0.08, 0, 0.66, 0.43, 0xdccbbd],
    ],
  },
  horse: {
    legH: 0.9, legW: 0.14, legX: 0.17, legZ: [-0.48, 0.48], swing: 0.6, leg: [HORSE, DARK],
    body: horseBody(false),
    alt: horseBody(true),
  },
  wolf: {
    legH: 0.4, legW: 0.1, legX: 0.12, legZ: [-0.28, 0.28], swing: 0.7, leg: [WOLF, 0x5c6066],
    body: wolfBody(false),
    alt: wolfBody(true),
  },
  // ---- v0.14 (§76 fauna) ----
  // Slim and long-legged, a long neck, big ears, a white rump; the stag (`alt`) carries antlers and a darker neck.
  deer: {
    legH: 0.68, legW: 0.1, legX: 0.13, legZ: [-0.36, 0.36], swing: 0.7, leg: [DEER, 0x3a2a1c],
    body: deerBody(false),
    alt: deerBody(true),
  },
  // Small and round, with ears as tall as its body and a white cotton tail; it bounds (`hop`).
  rabbit: {
    legH: 0.12, legW: 0.07, legX: 0.08, legZ: [-0.1, 0.13], swing: 0.9, leg: [RABBIT, 0xcfc2ac], hop: 0.1,
    body: [
      [0.2, 0.2, 0.3, 0, 0.22, 0.02, RABBIT],
      [0.24, 0.22, 0.18, 0, 0.23, 0.13, RABBIT], // haunches
      [0.16, 0.04, 0.26, 0, 0.115, 0.03, 0xd8cbb4], // belly
      [0.16, 0.16, 0.16, 0, 0.34, -0.19, RABBIT], // head
      [0.05, 0.24, 0.04, -0.045, 0.53, -0.15, RABBIT], [0.05, 0.24, 0.04, 0.045, 0.53, -0.15, RABBIT], // ears
      [0.03, 0.18, 0.01, -0.045, 0.53, -0.172, 0xe6b0a8], [0.03, 0.18, 0.01, 0.045, 0.53, -0.172, 0xe6b0a8], // their pink insides
      [0.05, 0.03, 0.02, 0, 0.33, -0.275, 0xd98a8a], // nose
      [0.02, 0.04, 0.04, -0.085, 0.37, -0.21, DARK], [0.02, 0.04, 0.04, 0.085, 0.37, -0.21, DARK], // eyes
      [0.1, 0.1, 0.07, 0, 0.27, 0.25, WHITE], // cotton tail
    ],
  },
  // Copper body, a dark green head over a white ring, red cheeks, and a barred tail longer than the bird.
  pheasant: {
    legs: 2, legH: 0.16, legW: 0.035, legX: 0.06, legZ: [0.02], swing: 0.9, leg: [0x9a8a64, 0x6a5a3a],
    wing: { pivot: [0.09, 0.33, 0], len: 0.36, chord: 0.22, flap: 0.95, colour: 0x8a4a22, tip: 0xd9b27a },
    body: [
      [0.18, 0.18, 0.34, 0, 0.26, 0.02, COPPER],
      [0.16, 0.16, 0.1, 0, 0.27, -0.17, 0x9a4a22], // breast
      [0.02, 0.12, 0.26, -0.095, 0.28, 0.04, 0x8a4a22], [0.02, 0.12, 0.26, 0.095, 0.28, 0.04, 0x8a4a22], // folded wings
      [0.08, 0.14, 0.08, 0, 0.4, -0.2, 0x1f5a48], // neck
      [0.095, 0.035, 0.095, 0, 0.345, -0.2, WHITE], // the white ring
      [0.1, 0.1, 0.12, 0, 0.49, -0.22, 0x1f5a48], // head
      [0.012, 0.07, 0.07, -0.052, 0.49, -0.235, 0xc8322a], [0.012, 0.07, 0.07, 0.052, 0.49, -0.235, 0xc8322a], // red cheeks
      [0.03, 0.03, 0.06, 0, 0.48, -0.31, 0xe6d9a8], // beak
      [0.08, 0.05, 0.28, 0, 0.3, 0.32, 0xc9a56a], [0.06, 0.04, 0.3, 0, 0.34, 0.6, 0xc9a56a], // the long tail, in two steps
      [0.085, 0.055, 0.035, 0, 0.3, 0.26, 0x5a3a1c], [0.085, 0.055, 0.035, 0, 0.3, 0.4, 0x5a3a1c], // its dark bars
      [0.065, 0.045, 0.035, 0, 0.34, 0.54, 0x5a3a1c], [0.065, 0.045, 0.035, 0, 0.34, 0.68, 0x5a3a1c],
    ],
  },
  // A big dark bird with a bare blue-grey head, a red wattle and a tail fanned upright behind it.
  turkey: {
    legs: 2, legH: 0.3, legW: 0.05, legX: 0.09, legZ: [0.02], swing: 0.8, leg: [0xb08a6a, 0x8a6a4a],
    wing: { pivot: [0.17, 0.62, 0.02], len: 0.4, chord: 0.3, flap: 0.8, colour: 0x7a5a36, tip: 0xe8dcc4 },
    body: [
      [0.34, 0.34, 0.42, 0, 0.5, 0.02, TURKEY],
      [0.3, 0.3, 0.14, 0, 0.5, -0.22, 0x3a2c22], // breast
      [0.02, 0.2, 0.3, -0.18, 0.52, 0.04, 0x7a5a36], [0.02, 0.2, 0.3, 0.18, 0.52, 0.04, 0x7a5a36], // bronze wings
      [0.09, 0.22, 0.09, 0, 0.74, -0.24, 0xb84a3a], // the bare red neck
      [0.11, 0.11, 0.13, 0, 0.88, -0.26, 0x8fa8c0], // the blue-grey head
      [0.04, 0.04, 0.07, 0, 0.87, -0.355, 0xe0c878], // beak
      [0.04, 0.12, 0.04, 0, 0.8, -0.33, 0xc8322a], // wattle
      [0.02, 0.03, 0.03, -0.057, 0.9, -0.28, DARK], [0.02, 0.03, 0.03, 0.057, 0.9, -0.28, DARK], // eyes
      // the fan: a stepped half-round plate standing behind the body and well out round it, banded pale near its
      // edge and tipped white
      [0.6, 0.16, 0.04, 0, 0.5, 0.27, 0x6e4e2e], [0.92, 0.3, 0.04, 0, 0.73, 0.27, 0x6e4e2e], [0.76, 0.12, 0.04, 0, 0.94, 0.27, 0x6e4e2e],
      [0.52, 0.08, 0.04, 0, 1.04, 0.27, 0x6e4e2e],
      [0.96, 0.06, 0.045, 0, 0.85, 0.27, 0xc9a56a], [0.8, 0.05, 0.045, 0, 0.975, 0.27, 0xc9a56a], // the pale band
      [0.56, 0.04, 0.045, 0, 1.06, 0.27, 0xf0e8d8], [0.05, 0.3, 0.045, -0.47, 0.73, 0.27, 0xf0e8d8], [0.05, 0.3, 0.045, 0.47, 0.73, 0.27, 0xf0e8d8], // white tips
    ],
  },
  // Bulk: bigger than a cow in every way — a trunk more than twice as wide as a deer's on thick dark legs, a pale
  // grizzled hump over the shoulders, a broad head with round ears and a pale muzzle.
  bear: {
    legH: 0.6, legW: 0.26, legX: 0.27, legZ: [-0.5, 0.5], swing: 0.5, leg: [BEAR_DARK, 0x241810],
    rear: { y: 0.75, z: 0.48, angle: 1.2, arms: 0.55, swipe: 1.1 },
    body: [
      [0.86, 0.74, 1.45, 0, 0.97, 0.02, BEAR],
      [0.74, 0.18, 0.62, 0, 1.42, -0.32, 0x86643c], // the shoulder hump, grizzled
      [0.7, 0.04, 0.7, 0, 1.36, 0.36, 0x7a5832], // the same pale fur along its back
      [0.56, 0.04, 0.66, 0, 0.585, -0.3, 0x9a7646], // a pale chest: under it on all fours, facing you when it rears
      [0.14, 0.12, 0.08, 0, 1.1, 0.78, BEAR_DARK], // tail
    ],
    // the head turns at the neck (`pivot`) and stays `level` (the share of the body's pitch it takes back)
    head: {
      pivot: [0, 1.1, -0.66], level: 0.9,
      boxes: [
        [0.52, 0.46, 0.44, 0, 1.12, -0.92, BEAR],
        [0.26, 0.22, 0.2, 0, 1.02, -1.22, 0xc2a06e], // muzzle
        [0.12, 0.08, 0.03, 0, 1.09, -1.33, DARK], // nose
        [0.07, 0.06, 0.02, -0.14, 1.22, -1.145, DARK], [0.07, 0.06, 0.02, 0.14, 1.22, -1.145, DARK], // eyes
        [0.14, 0.12, 0.08, -0.21, 1.4, -0.86, BEAR_DARK], [0.14, 0.12, 0.08, 0.21, 1.4, -0.86, BEAR_DARK], // round ears
      ],
    },
  },
  // A small golden fish with a pale stripe down its back and dark red fins. It is seen from above and through blue
  // water, so its BACK is its brightest part (a silver-blue fish all but vanished there). No legs; it wiggles.
  fish: {
    legs: 0, legH: 0, legW: 0, legX: 0, legZ: [0], swing: 0, leg: [FISH, FISH], wiggle: 0.3,
    body: [
      [0.14, 0.15, 0.4, 0, 0.1, 0, FISH],
      [0.07, 0.03, 0.36, 0, 0.19, 0, 0xffe2a0], // the pale stripe down its back
      [0.1, 0.03, 0.3, 0, 0.02, 0, 0xf6ecd8], // belly
      [0.13, 0.13, 0.12, 0, 0.1, -0.25, 0xd9822a], // head
      [0.02, 0.03, 0.03, -0.067, 0.13, -0.26, DARK], [0.02, 0.03, 0.03, 0.067, 0.13, -0.26, DARK], // eyes
      [0.04, 0.22, 0.14, 0, 0.115, 0.27, FIN], // tail fin
      [0.035, 0.13, 0.14, 0, 0.265, 0.03, FIN], // the back fin: tall enough to cut the surface (animals.FISH_UNDER)
      [0.2, 0.02, 0.07, 0, 0.06, -0.1, FIN], // side fins
    ],
  },
});

/** @param {boolean} tame a saddle and a blanket */
function horseBody(tame) {
  const MANE = 0x3a2414;
  const boxes = [
    [0.5, 0.55, 1.3, 0, 1.17, 0, HORSE],
    [0.26, 0.62, 0.32, 0, 1.6, -0.6, HORSE], // neck
    [0.24, 0.26, 0.5, 0, 1.86, -0.86, HORSE], // head
    [0.2, 0.16, 0.14, 0, 1.8, -1.14, 0x6e3e1e], // muzzle
    [0.06, 0.06, 0.02, -0.125, 1.92, -0.8, DARK], [0.06, 0.06, 0.02, 0.125, 1.92, -0.8, DARK], // eyes (on the sides)
    [0.06, 0.12, 0.06, -0.08, 2.04, -0.68, HORSE], [0.06, 0.12, 0.06, 0.08, 2.04, -0.68, HORSE], // ears
    [0.08, 0.6, 0.12, 0, 1.68, -0.42, MANE], [0.1, 0.1, 0.2, 0, 2.0, -0.78, MANE], // mane and forelock
    [0.1, 0.55, 0.1, 0, 1.0, 0.68, MANE], // tail
    [0.08, 0.14, 0.02, 0, 1.9, -1.115, WHITE], // a blaze
  ];
  if (tame) {
    boxes.push([0.54, 0.06, 0.6, 0, 1.47, 0.02, 0xc0392b]); // blanket
    boxes.push([0.4, 0.1, 0.42, 0, 1.53, 0.02, 0x6e3e1e]); // saddle
    boxes.push([0.4, 0.12, 0.06, 0, 1.6, 0.22, 0x5a301a]); // cantle
  }
  return boxes;
}

/** @param {boolean} tame a red collar */
function wolfBody(tame) {
  const PALE = 0xc9ccd0;
  const boxes = [
    [0.36, 0.36, 0.86, 0, 0.58, 0, WOLF],
    [0.3, 0.16, 0.6, 0, 0.44, 0.02, PALE], // belly
    [0.32, 0.3, 0.3, 0, 0.74, -0.52, WOLF], // head
    [0.16, 0.14, 0.22, 0, 0.68, -0.76, PALE], // snout
    [0.07, 0.05, 0.03, 0, 0.72, -0.875, DARK], // nose
    [0.06, 0.05, 0.02, -0.09, 0.8, -0.675, 0xf2c14a], [0.06, 0.05, 0.02, 0.09, 0.8, -0.675, 0xf2c14a], // amber eyes
    [0.08, 0.14, 0.06, -0.11, 0.95, -0.46, WOLF], [0.08, 0.14, 0.06, 0.11, 0.95, -0.46, WOLF], // ears
    [0.13, 0.13, 0.42, 0, 0.66, 0.6, WOLF], [0.1, 0.1, 0.12, 0, 0.68, 0.84, PALE], // tail
  ];
  if (tame) boxes.push([0.36, 0.08, 0.08, 0, 0.72, -0.34, 0xd9342b]);
  return boxes;
}

/** v0.14 (§76 fauna). @param {boolean} stag antlers, and a darker, thicker neck */
function deerBody(stag) {
  const PALE = 0xe6d3b0;
  const ANTLER = 0xd9c9a0;
  const boxes = [
    [0.36, 0.38, 0.95, 0, 0.87, 0, DEER],
    [0.3, 0.06, 0.8, 0, 0.675, 0, PALE], // belly
    [0.12, 0.02, 0.8, 0, 1.07, 0, 0x8a5e34], // the dark line down its back
    [0.18, 0.5, 0.2, 0, 1.2, -0.48, DEER], // the long neck
    [0.14, 0.16, 0.02, 0, 1.2, -0.585, WHITE], // throat patch
    [0.2, 0.2, 0.34, 0, 1.46, -0.62, DEER], // head
    [0.14, 0.12, 0.14, 0, 1.42, -0.84, 0xd9bf98], // muzzle
    [0.08, 0.06, 0.02, 0, 1.44, -0.915, DARK], // nose
    [0.02, 0.06, 0.06, -0.105, 1.5, -0.66, DARK], [0.02, 0.06, 0.06, 0.105, 1.5, -0.66, DARK], // eyes (on the sides)
    [0.07, 0.18, 0.1, -0.16, 1.6, -0.5, DEER, 0.5], [0.07, 0.18, 0.1, 0.16, 1.6, -0.5, DEER, -0.5], // big ears, held out
    [0.28, 0.22, 0.02, 0, 0.93, 0.485, WHITE], // the white rump
    [0.1, 0.16, 0.08, 0, 0.98, 0.5, WHITE], // tail
  ];
  if (stag) {
    boxes.push([0.22, 0.34, 0.24, 0, 1.12, -0.48, 0x8a5e34]); // the neck's mane
    for (const s of [-1, 1]) {
      boxes.push([0.08, 0.46, 0.08, s * 0.15, 1.78, -0.56, ANTLER, -s * 0.4]); // the beam, leaning out
      boxes.push([0.07, 0.26, 0.07, s * 0.33, 1.94, -0.56, ANTLER, -s * 1.0]); // an outer tine
      boxes.push([0.07, 0.24, 0.07, s * 0.24, 2.08, -0.56, ANTLER, -s * 0.1]); // the top tine
      boxes.push([0.07, 0.07, 0.22, s * 0.11, 1.66, -0.7, ANTLER]); // the brow tine, pointing forward
    }
  }
  return boxes;
}

/**
 * @typedef {Object} AnimalRenderer
 * @property {(animals: ReadonlyArray<Animal>) => void} sync   draw the given animals
 * @property {() => number} count
 * @property {() => void} dispose
 * @property {THREE.Group} group
 * @property {(webgl: *, camera: THREE.Camera) => Promise<void>} prewarm
 */

/**
 * Which body an animal is drawn with: its species' `alt` for a shorn sheep, a tame horse, a tame wolf or (v0.14) a stag.
 */
export function bodyVariant(a) {
  if (a.kind === 'sheep') return a.shorn > 0 ? 'alt' : 'body';
  if (a.kind === 'horse' || a.kind === 'wolf') return a.tamed ? 'alt' : 'body';
  if (a.kind === 'deer') return a.variant === 1 ? 'alt' : 'body';
  return 'body';
}

/** How many legs a model walks on (4 when it does not say). @param {*} m */
export function legCount(m) {
  return typeof m.legs === 'number' ? m.legs : 4;
}

/** How far back a flying bird tucks its legs (rad). */
const TUCK = 1.1;

/**
 * @param {THREE.Scene} scene
 * @param {number} [capacity=ANIMAL_MAX]
 * @returns {AnimalRenderer}
 */
export function createAnimalRenderer(scene, capacity = ANIMAL_MAX) {
  const mats = {
    base: new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, emissive: NIGHT_GLOW }),
    hurt: new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, emissive: HURT, emissiveIntensity: HURT_INTENSITY }),
  };
  const group = new THREE.Group();
  group.name = 'animals';
  /** @type {THREE.BufferGeometry[]} */
  const geos = [];
  const instanced = (boxes, mat, n, name) => {
    const geo = boxesGeometry(boxes);
    geos.push(geo);
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  };
  /**
   * @type {Record<string, Record<'base'|'hurt', { body: THREE.InstancedMesh, alt: THREE.InstancedMesh|null,
   *   legs: THREE.InstancedMesh|null, wings: THREE.InstancedMesh|null, head: THREE.InstancedMesh|null }>>}
   */
  const sets = {};
  for (const kind of ANIMAL_KINDS) {
    const m = /** @type {*} */ (MODELS)[kind];
    const nLegs = legCount(m);
    const legBoxes = [
      [m.legW, m.legH - 0.08, m.legW, 0, -(m.legH - 0.08) / 2, 0, m.leg[0]],
      [m.legW + 0.02, 0.08, m.legW + 0.02, 0, -m.legH + 0.04, 0, m.leg[1]],
    ];
    // A wing is a flat board reaching out along +x from its shoulder (the origin), a paler band at its tip.
    const w = m.wing;
    const wingBoxes = w ? [
      [w.len * 0.72, 0.03, w.chord, w.len * 0.36, 0, 0, w.colour],
      [w.len * 0.28, 0.03, w.chord * 0.8, w.len * 0.86, 0, 0, w.tip],
    ] : null;
    sets[kind] = /** @type {*} */ ({});
    for (const state of /** @type {const} */ (['base', 'hurt'])) {
      const suffix = state === 'base' ? '' : '-hurt';
      sets[kind][state] = {
        body: instanced(m.body, mats[state], capacity, `${kind}-body${suffix}`),
        alt: m.alt ? instanced(m.alt, mats[state], capacity, `${kind}-alt${suffix}`) : null,
        legs: nLegs > 0 ? instanced(legBoxes, mats[state], capacity * nLegs, `${kind}-legs${suffix}`) : null,
        wings: wingBoxes ? instanced(wingBoxes, mats[state], capacity * 2, `${kind}-wings${suffix}`) : null,
        head: m.head ? instanced(m.head.boxes, mats[state], capacity, `${kind}-head${suffix}`) : null,
      };
    }
  }
  scene.add(group);

  const feetM = new THREE.Matrix4();
  const bodyM = new THREE.Matrix4();
  const partM = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const q = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  let drawn = 0;

  /** @param {ReadonlyArray<Animal>} animals */
  function sync(animals) {
    for (const kind of ANIMAL_KINDS) {
      for (const state of /** @type {const} */ (['base', 'hurt'])) {
        const s = sets[kind][state];
        s.body.count = 0;
        if (s.alt) s.alt.count = 0;
        if (s.legs) s.legs.count = 0;
        if (s.wings) s.wings.count = 0;
        if (s.head) s.head.count = 0;
      }
    }
    let n = 0;
    for (const a of animals) {
      const kindSets = sets[a.kind];
      if (!kindSets) continue;
      const set = kindSets[a.hurt > 0 ? 'hurt' : 'base'];
      const m = /** @type {*} */ (MODELS)[a.kind];
      const which = bodyVariant(a) === 'alt' && set.alt ? set.alt : set.body;
      if (which.count >= capacity) continue;
      const phase = a.walkPhase || 0;
      const sw = Math.sin(phase);
      // v0.14: in the air (a flushed bird) the wings beat with `walkPhase` and there is no stride
      const flying = typeof a.air === 'number' && a.air !== 0;
      // a little bob with the stride (a rabbit bounds); a snared animal strains from side to side
      const bob = flying ? 0 : Math.abs(sw) * (m.hop ?? 0.025);
      // `renderScale` / `renderSpin` (infall.js): a black hole's shrinking, spinning ghost, as for pigs and zombies.
      const ghost = /** @type {{ renderScale?: number, renderSpin?: number }} */ (a);
      const rs = typeof ghost.renderScale === 'number' && ghost.renderScale > 0 && Number.isFinite(ghost.renderScale) ? ghost.renderScale : 1;
      const spin = typeof ghost.renderSpin === 'number' && Number.isFinite(ghost.renderSpin) ? ghost.renderSpin : 0;
      scl.set(rs, rs, rs);
      const yaw = a.yaw + spin + (m.wiggle ? sw * m.wiggle : 0); // v0.14: a fish's body swings with its tail
      q.setFromAxisAngle(UP, yaw);
      bodyM.compose(at.set(a.x, a.y + bob * rs, a.z), q, scl);
      // v0.14: the bear's rear-up — the body pitches up about its hips, the more the further it has reared
      const rear = m.rear && typeof a.rear === 'number' && a.rear > 0.001 ? Math.min(1, a.rear) : 0;
      if (rear > 0) {
        bodyM.multiply(tmp.makeTranslation(0, m.rear.y, m.rear.z)).multiply(rot.makeRotationX(rear * m.rear.angle))
          .multiply(tmp.makeTranslation(0, -m.rear.y, -m.rear.z));
      }
      which.setMatrixAt(which.count++, bodyM);
      if (set.head) {
        // the head rides on the body but takes most of its pitch back, turning at the neck: it keeps looking ahead
        const h = m.head;
        partM.copy(bodyM);
        if (rear > 0) {
          partM.multiply(tmp.makeTranslation(h.pivot[0], h.pivot[1], h.pivot[2])).multiply(rot.makeRotationX(-rear * m.rear.angle * h.level))
            .multiply(tmp.makeTranslation(-h.pivot[0], -h.pivot[1], -h.pivot[2]));
        }
        set.head.setMatrixAt(set.head.count++, partM);
      }
      feetM.compose(at.set(a.x, a.y, a.z), q, scl);
      const nLegs = legCount(m);
      if (set.legs) {
        for (let k = 0; k < nLegs; k++) {
          const sx = k % 2 === 0 ? -1 : 1;
          const front = nLegs === 2 ? true : k < 2;
          const diag = nLegs === 2 ? sx : (front ? 1 : -1) * sx; // diagonal pairs swing together; a bird's two alternate
          let angle = diag * sw * m.swing;
          if (flying) angle = -TUCK;
          // a reared bear's forelegs hang from its raised shoulders, held forward, and swing down when it swipes
          let base = feetM;
          if (rear > 0 && front) {
            base = bodyM;
            const swipe = typeof a.swipe === 'number' && a.swipe > 0 ? a.swipe / BEAR_SWIPE_S : 0;
            angle = -rear * m.rear.arms + swipe * m.rear.swipe;
          }
          partM.multiplyMatrices(base, tmp.makeTranslation(sx * m.legX, m.legH, front ? m.legZ[0] : m.legZ[1]))
            .multiply(rot.makeRotationX(angle));
          set.legs.setMatrixAt(set.legs.count++, partM);
        }
      }
      if (set.wings && flying) {
        const w = m.wing;
        const flap = Math.sin(phase) * w.flap;
        for (const side of [1, -1]) {
          // the left wing is the right one turned half round, so the same flap raises both tips
          partM.multiplyMatrices(bodyM, tmp.makeTranslation(side * w.pivot[0], w.pivot[1], w.pivot[2]));
          if (side < 0) partM.multiply(rot.makeRotationY(Math.PI));
          partM.multiply(rot.makeRotationZ(flap));
          set.wings.setMatrixAt(set.wings.count++, partM);
        }
      }
      n++;
    }
    for (const kind of ANIMAL_KINDS) {
      for (const state of /** @type {const} */ (['base', 'hurt'])) {
        const s = sets[kind][state];
        for (const mesh of [s.body, s.alt, s.legs, s.wings, s.head]) {
          if (!mesh) continue;
          mesh.visible = mesh.count > 0;
          if (mesh.count > 0) mesh.instanceMatrix.needsUpdate = true;
        }
      }
    }
    drawn = n;
  }

  function dispose() {
    scene.remove(group);
    for (const mesh of group.children) /** @type {THREE.InstancedMesh} */ (mesh).dispose();
    for (const g of geos) g.dispose();
    for (const m of Object.values(mats)) m.dispose();
    drawn = 0;
  }

  /** Compile every animal program while the game loads (prewarm.compileHidden). */
  const prewarm = (webgl, camera) => compileHidden([group], webgl, camera, scene);

  return { sync, count: () => drawn, dispose, group, prewarm };
}
