// src/fishing.js — §106 the Fishing Rod: the cast, the float on the water, a fish that comes to it, nibbles and bites,
// the hook; and the spear's limit — it catches a fish only in shallow water (the user: "spear still works for shallow
// streams"), while in deep water a startled fish dives out of its reach.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BLOCK } from '../../src/blocks.js';
import { hexToWorld, hexLength, worldToHex } from '../../src/hex.js';
import { Animals, fishDepth, fishWater, FISH_SHALLOW, FISH_DIVE } from '../../src/animals.js';
import { seededRng } from '../../src/pigs.js';
import {
  FishingLine, ROD_KEY, CAST_FULL_S, CAST_SPEED_MIN, CAST_SPEED_FULL, BITE_RADIUS, BITE_WAIT, NIBBLE_S, HOOK_WINDOW_S,
  LINE_MAX, QUIET_HINT_S, castSpeed, castVelocity, spearReaches, floatSurface, lineCurve, lineSlack,
} from '../../src/fishing.js';
import { drawOf } from '../../src/looseItems.js';
import { getItem, ITEMS } from '../../src/items.js';
import { RECIPES } from '../../src/crafting.js';
import { heldItemGeometry, rodHeldArt, ROD_HELD_SIZE, HELD_ROD_PIXEL, HELD_PIXEL } from '../../src/heldItem.js';

const B = BLOCK;
const GROUND = 10;

/**
 * Flat grass at GROUND − 1 with a pond of radius 4 round (0, 0): `deep` cells of water in it (its bed at GROUND − deep),
 * its surface in the cell GROUND − 1.
 */
function pond(deep = 1, radius = 4) {
  return (q, y, r) => {
    if (hexLength(q, r) <= radius && y >= GROUND - deep && y <= GROUND - 1) return B.WATER;
    return y < GROUND - 1 ? B.STONE : y === GROUND - 1 ? B.GRASS_BLOCK : B.AIR;
  };
}

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const shore = () => {
  const [x, z] = hexToWorld(7, 0); // on the grass, east of the pond
  return { x, y: GROUND, z };
};
/** A line floating at the pond's middle, as a cast would leave it. */
function floating(gb, rng = seededRng(3)) {
  const line = new FishingLine(rng);
  const [x, z] = hexToWorld(0, 0);
  line.cast(x, GROUND + 1, z, 0, -1, 0);
  let ev = null;
  for (let i = 0; i < 60 && !ev; i++) ev = line.step(1 / 30, { getBlock: gb, player: shore(), fish: [] });
  expect(ev).toBe('splash');
  return line;
}

describe('the cast', () => {
  it('a longer draw casts farther: from CAST_SPEED_MIN to CAST_SPEED_FULL, lifted over the look', () => {
    expect(castSpeed(0)).toBe(CAST_SPEED_MIN);
    expect(castSpeed(1)).toBe(CAST_SPEED_FULL);
    expect(castSpeed(5)).toBe(CAST_SPEED_FULL);
    expect(castSpeed(NaN)).toBe(CAST_SPEED_MIN);
    const [vx, vy, vz] = castVelocity(1, 0, 0, 1, 0.5, 0);
    expect(vx).toBeCloseTo(CAST_SPEED_FULL + 0.5);
    expect(vy).toBeGreaterThan(0);
    expect(vz).toBe(0);
  });

  it('the rod is a tool of its own type, drawn like a throw (CAST_FULL_S to a full cast) and made at the stump', () => {
    const def = getItem(ROD_KEY);
    expect(def?.tool?.type).toBe('rod');
    expect(drawOf(ROD_KEY)).toEqual({ bow: false, rod: true, shoots: null, base: null, fullS: CAST_FULL_S });
    const rec = RECIPES.find((r) => r.id === ROD_KEY);
    expect(rec?.station).toBe('stump');
    expect(Object.keys(ITEMS)).toContain(ROD_KEY);
  });

  it('a full cast from the bank lands on the pond 8–14 m out, and floats on its surface', () => {
    const gb = pond(2, 12);
    const line = new FishingLine(seededRng(1));
    const [x0, z0] = hexToWorld(14, 0);
    const p = { x: x0, y: GROUND, z: z0 };
    const [vx, vy, vz] = castVelocity(-1, 0.2, 0, 1);
    line.cast(x0, GROUND + 1.6, z0, vx, vy, vz);
    let ev = null;
    for (let i = 0; i < 200 && line.state === 'flying'; i++) ev = line.step(1 / 60, { getBlock: gb, player: p, fish: [] }) ?? ev;
    expect(ev).toBe('splash');
    expect(line.onWater).toBe(true);
    const d = Math.hypot(line.x - x0, line.z - z0);
    expect(d).toBeGreaterThan(8);
    expect(d).toBeLessThan(15);
    expect(line.y).toBeCloseTo(floatSurface(gb, line.x, line.y, line.z));
  });

  it('cast onto land, the float lies there; reeled, it comes in', () => {
    const gb = pond(1);
    const line = new FishingLine(seededRng(2));
    const [x, z] = hexToWorld(8, 0);
    line.cast(x, GROUND + 1, z, 0, -2, 0);
    let ev = null;
    for (let i = 0; i < 60 && line.state === 'flying'; i++) ev = line.step(1 / 60, { getBlock: gb, player: shore(), fish: [] }) ?? ev;
    expect(ev).toBe('land');
    expect(line.state).toBe('ground');
    expect(line.y).toBeCloseTo(GROUND, 1);
    expect(line.reel()).toEqual({ result: 'reeled', fish: null });
    expect(line.out).toBe(false);
  });
});

describe('the bite', () => {
  it('a fish near the float comes to it, nibbles, bites; Place in the window hooks it', () => {
    const gb = pond(2);
    const line = floating(gb);
    const [fx, fz] = hexToWorld(2, 0);
    const fish = { x: fx, y: GROUND - 0.5, z: fz, mode: 'idle' };
    const env = { getBlock: gb, player: shore(), fish: [fish] };
    const seen = [];
    let t = 0;
    while (t < 40 && line.state !== 'bite') {
      const b = line.bait();
      if (b) {
        // the fish swims to the float as animals.js does for `floatAt`
        const dx = b.x - fish.x;
        const dz = b.z - fish.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.01) {
          const s = Math.min(d, 0.7 * 0.1);
          fish.x += (dx / d) * s;
          fish.z += (dz / d) * s;
        }
      }
      const ev = line.step(0.1, env);
      if (ev) seen.push(ev);
      if (!seen.includes(line.state)) seen.push(line.state);
      t += 0.1;
    }
    expect(line.state).toBe('bite');
    expect(seen).toContain('coming');
    expect(seen).toContain('nibble');
    expect(seen).toContain('bite');
    expect(line.dip).toBe(1);
    expect(t).toBeLessThan(BITE_WAIT[1] + 10 + NIBBLE_S[1] + 1);
    const r = line.reel();
    expect(r.result).toBe('caught');
    expect(r.fish).toBe(fish);
    expect(line.out).toBe(false);
  });

  it('a bite let pass and the fish is gone ("escaped"); Place while it only nibbles pulls the float from it', () => {
    const gb = pond(2);
    const [x, z] = hexToWorld(0, 0);
    const fish = { x, y: GROUND - 0.5, z, mode: 'idle' };
    const env = { getBlock: gb, player: shore(), fish: [fish] };
    const line = floating(gb);
    let ev = null;
    for (let i = 0; i < 400 && ev !== 'escaped'; i++) {
      const e = line.step(0.05, env);
      if (e === 'bite') expect(line.state).toBe('bite');
      if (e) ev = e;
    }
    expect(ev).toBe('escaped');
    expect(line.fish).toBe(fish); // handed to main to send off
    line.step(0.05, env);
    expect(line.fish).toBe(null);
    const again = floating(gb, seededRng(9));
    for (let i = 0; i < 400 && again.state !== 'nibble'; i++) again.step(0.05, env);
    expect(again.state).toBe('nibble');
    expect(again.reel()).toEqual({ result: 'spooked', fish });
    expect(HOOK_WINDOW_S).toBeGreaterThan(0.5);
  });

  it('a darting fish never comes; with no fish near the float waits, and the quiet hint comes after QUIET_HINT_S', () => {
    const gb = pond(2);
    const line = floating(gb);
    const [fx, fz] = hexToWorld(1, 0);
    const darting = { x: fx, y: GROUND - 0.5, z: fz, mode: 'flee' };
    const far = { x: fx + BITE_RADIUS + 3, y: GROUND - 0.5, z: fz, mode: 'idle' };
    for (let t = 0; t < QUIET_HINT_S + 1; t += 0.25) {
      expect(line.step(0.25, { getBlock: gb, player: shore(), fish: [darting, far] })).toBe(null);
      expect(line.state).toBe('float');
    }
    expect(line.quiet).toBeGreaterThanOrEqual(QUIET_HINT_S);
  });

  it('the line comes in past LINE_MAX, and the float lies on the bed of a pond let dry', () => {
    let wet = true;
    const gb0 = pond(1);
    const gb = (q, y, r) => (!wet && gb0(q, y, r) === B.WATER ? B.AIR : gb0(q, y, r));
    const line = floating(gb);
    wet = false;
    line.step(0.1, { getBlock: gb, player: shore(), fish: [] });
    expect(line.state).toBe('ground');
    const far = { x: line.x + LINE_MAX + 1, y: GROUND, z: line.z };
    expect(line.step(0.1, { getBlock: gb, player: far, fish: [] })).toBe('snap');
    expect(line.out).toBe(false);
  });

  it('the line sags between the tip and the float, and is drawn tight on a bite', () => {
    const pts = lineCurve([0, 2, 0], [10, 0, 0], 7, 1);
    expect(pts.length).toBe(21);
    expect([pts[0], pts[1], pts[2]]).toEqual([0, 2, 0]);
    expect([pts[18], pts[19], pts[20]]).toEqual([10, 0, 0]);
    const sag = (i) => (2 - (2 * i) / 6) - pts[i * 3 + 1]; // below the straight line
    expect(sag(4)).toBeCloseTo(1); // the most, two thirds of the way out
    expect(sag(1)).toBeLessThan(0.2); // hardly any by the tip
    expect(lineSlack(10)).toBeGreaterThan(lineSlack(10, true));
  });
});

describe('the spear and deep water', () => {
  it('a spear reaches a fish in a stream (one cell) but not in a pond two cells deep', () => {
    const [x, z] = hexToWorld(0, 0);
    const shallow = pond(1);
    const deep = pond(2);
    const y1 = fishDepth(shallow, 0, 0, GROUND - 0.5);
    const y2 = fishDepth(deep, 0, 0, GROUND - 0.5);
    expect(spearReaches(shallow, { x, y: y1, z, height: 0.2 })).toBe(true);
    expect(spearReaches(deep, { x, y: y2, z, height: 0.2 })).toBe(false);
    const w1 = /** @type {*} */ (fishWater(shallow, 0, 0, GROUND - 0.5));
    expect(w1.surface - w1.bed).toBeLessThanOrEqual(FISH_SHALLOW);
  });

  it('startled in deep water a fish dives to FISH_DIVE under the surface, and rises again once calm', () => {
    const gb = pond(3);
    const animals = new Animals(seededRng(5));
    const [x0, z0] = hexToWorld(0, 0);
    const swim = fishDepth(gb, 0, 0, GROUND - 0.5);
    const a = animals.spawn('fish', x0, swim, z0);
    expect(animals.wound(/** @type {*} */ (a), 0, x0 + 3, z0)).toBe('hit');
    const env = { getBlock: gb, isLoaded: () => true, player: null, heldKey: null };
    let low = swim;
    for (let i = 0; i < 20; i++) {
      animals.update(0.05, env);
      low = Math.min(low, a.y);
    }
    const w = /** @type {*} */ (fishWater(gb, ...worldToHex(a.x, a.z), a.y + a.height / 2));
    expect(low).toBeLessThan(swim - 0.5);
    expect(low).toBeGreaterThanOrEqual(w.surface - FISH_DIVE - 0.05);
    for (let i = 0; i < 200; i++) animals.update(0.05, env);
    expect(a.mode).not.toBe('flee');
    expect(a.y).toBeCloseTo(fishDepth(gb, ...worldToHex(a.x, a.z), a.y + a.height / 2), 1);
  });

  it('in a stream a startled fish stays at the surface (a spear still catches it there)', () => {
    const gb = pond(1);
    const animals = new Animals(seededRng(6));
    const [x0, z0] = hexToWorld(0, 0);
    const swim = fishDepth(gb, 0, 0, GROUND - 0.5);
    const a = animals.spawn('fish', x0, swim, z0);
    animals.wound(/** @type {*} */ (a), 0, x0 + 3, z0);
    const env = { getBlock: gb, isLoaded: () => true, player: null, heldKey: null };
    for (let i = 0; i < 20; i++) {
      animals.update(0.05, env);
      expect(a.y).toBeGreaterThan(swim - 0.1);
    }
  });

  it('a fish with floatAt set swims to the float and holds there', () => {
    const gb = pond(2);
    const animals = new Animals(seededRng(7));
    const [x0, z0] = hexToWorld(-2, 0);
    const [tx, tz] = hexToWorld(2, 0);
    const a = animals.spawn('fish', x0, fishDepth(gb, -2, 0, GROUND - 0.5), z0);
    a.floatAt = { x: tx, z: tz };
    const env = { getBlock: gb, isLoaded: () => true, player: null, heldKey: null };
    for (let i = 0; i < 300; i++) animals.update(0.05, env);
    expect(Math.hypot(a.x - tx, a.z - tz)).toBeLessThan(0.45);
  });
});

describe('the rod in hand', () => {
  it('is a long pole held by its butt (no line: the line is drawn from its tip), and its tip is known', () => {
    const art = rodHeldArt();
    expect(art.length).toBe(ROD_HELD_SIZE * ROD_HELD_SIZE * 4);
    const g = /** @type {*} */ (heldItemGeometry(ROD_KEY));
    expect(g.style).toBe('tool');
    expect(g.pixel).toBe(HELD_ROD_PIXEL);
    expect(HELD_ROD_PIXEL).toBeGreaterThan(HELD_PIXEL);
    // the tip stands about a metre up the pole from the hand
    expect(g.tip[1]).toBeGreaterThan(0.9);
    expect(Math.abs(g.tip[0])).toBeLessThan(0.1);
    // any other item's tip is the top of its picture
    const spear = /** @type {*} */ (heldItemGeometry('flint_spear'));
    expect(spear.tip[1]).toBeGreaterThan(0.2);
    expect(spear.tip[1]).toBeLessThan(0.5);
  });
});

describe('main wires it', () => {
  const main = read('../../src/main.js');
  it('Place with the line out reels, the cast goes through the draw, the line comes in with the hand and on resets', () => {
    expect(main).toContain('if (rodPlace(mouse)) return true;');
    expect(main).toContain('if (d.rod) {\n      castLine(f);');
    expect(main).toMatch(/function stepFishing[\s\S]*heldItemKey\(\) !== ROD_KEY[\s\S]*resetFishing\(\)/);
    expect(main).toMatch(/function resetSurvivalInput\(\) \{[\s\S]{0,200}resetFishing\(\)/);
    expect(main).toContain('stepFishing(dt);');
    expect(main).toContain('syncFishing(fxTime);');
    expect(main).toContain('const t = avatarRenderer.heldTip(!third);'); // the line starts at the rod in hand
    expect(main).not.toContain('PROBE');
  });
  it('a spear catches a fish only in shallow water, struck or thrown', () => {
    expect(main).toContain('const tooDeep = !isBodyAnimal(a) && !spearOnly && !spearReaches(world.getBlock, a);');
    expect(main).toContain('const counts = isBodyAnimal(a) || (spear && !deep);');
  });
});
