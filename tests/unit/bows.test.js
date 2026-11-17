// Tests for the bows and the arrows of every age (CONTRACTS §100.6): the arrows' powers and how often they are
// picked up again (seeded), the two bows' draw, speed, spread and arc, the arrow a bow takes from the pack (and in
// Creative), the bow's hint, main's wiring of the shot (read from the source: main needs a browser), the sapling and where
// it comes from, and old saves' Bow, Arrow and darts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LooseItems, ARROW_KEYS, ARROW_PREFERENCE, ARROWS, DEFAULT_ARROW, METAL_MISS_KEEP, BOWS, arrowOf, bowOf, hitBreakP,
  missBreakP, pickArrow, bowShot, spreadDir, drawOf, drawFraction, DRAW_SPEED_MIN, DRAW_SPEED_FULL, DRAW_POWER_MIN,
  ITEM_GRAVITY, THROW_CHUCK, throwOf, bowArrowFrom, bowHint, NO_ARROWS_HINT,
} from '../../src/looseItems.js';
import { touchWords } from '../../src/touchControls.js';
import { ITEMS, getItem, maxDurability, canonicalItemKey } from '../../src/items.js';
import { BLOCK } from '../../src/blocks.js';
import { rollDrops, pick, SAPLING_LEAF_P, SAPLING_HAZEL_P } from '../../src/harvest.js';
import { normalizeSurvivalJSON } from '../../src/storage.js';
import { Pack } from '../../src/inventory.js';
import { normalizePick } from '../../src/creativePicks.js';
import { heldWielded, heldItemGeometry } from '../../src/heldItem.js';
import { PACK_SLOTS } from '../../src/config.js';
import { seededRandom } from '../helpers/offlineAudio.js';

const DT = 1 / 60;
const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');

/** An env: a floor below y = `floor`, nobody to collect, a mob at x ≥ `mobX` (or none), counting hits and breaks. */
function env({ floor = 10, mobX = Infinity, wall = Infinity } = {}) {
  const out = { hits: 0, broke: { hit: 0, miss: 0 } };
  const e = {
    solid: (x, y) => y < floor || x > wall,
    player: null,
    collect: null,
    hitMob: (x0, y0, z0, x1) => (x0 < mobX && x1 >= mobX ? { name: 'deer' } : null),
    onHit: () => {
      out.hits++;
      return false;
    },
    onBreak: (/** @type {*} */ _it, /** @type {'hit'|'miss'} */ why) => {
      out.broke[why]++;
    },
  };
  return { e, out };
}

/**
 * Shoot `n` arrows of `key` (power `power`) along +x from (0, 11, 0), in volleys of 100 (under LOOSE_MAX) drawing on one
 * seeded stream; return how many are left lying.
 */
function shoot(key, n, { seed = 7, mobX = Infinity, ghost = false, power = 3, wall = Infinity } = {}) {
  const random = seededRandom(seed);
  const { e, out } = env({ mobX, wall });
  let left = 0;
  for (let done = 0; done < n; done += 100) {
    const loose = new LooseItems(random);
    for (let i = done; i < Math.min(n, done + 100); i++) loose.launch({ k: key, n: 1 }, 0, 11, 0, 30, 1, 0, { power, ghost, gravity: 0.5 });
    for (let t = 0; t < 3; t += DT) loose.step(DT, e);
    left += loose.list.length; // (a ghost fades once it lies still: only its breaks are looked at)
  }
  return { left, out };
}

describe('§100 the arrows: six ages, power by the head', () => {
  it('stone, flint, copper, bronze, iron and steel: power 2, 3, 3, 4, 5, 6', () => {
    expect(ARROW_KEYS).toEqual(['stone_arrow', 'flint_arrow', 'copper_arrow', 'bronze_arrow', 'iron_arrow', 'steel_arrow']);
    expect(ARROW_KEYS.map((k) => ARROWS[k].power)).toEqual([2, 3, 3, 4, 5, 6]);
    expect(ARROW_KEYS.map((k) => ARROWS[k].head)).toEqual(['stone', 'flint', 'copper', 'bronze', 'iron', 'steel']);
    for (const k of ARROW_KEYS) {
      expect(getItem(k)?.kind, k).toBe('material');
      expect(arrowOf(k), k).toBe(ARROWS[k]);
    }
    for (const k of ['rock', 'flint_spear', 'crude_bow', 'arrow', null, 'nope']) expect(arrowOf(k), String(k)).toBe(null);
    expect(DEFAULT_ARROW).toBe('flint_arrow');
  });

  it('the chance an arrow is kept: a hit 35 %, 50 %, 70 %, 75 %, 85 %, 90 %; a miss 85 %, 90 %, then 97 % for any metal', () => {
    expect(ARROW_KEYS.map((k) => ARROWS[k].hitKeep)).toEqual([0.35, 0.5, 0.7, 0.75, 0.85, 0.9]);
    expect(ARROW_KEYS.map((k) => ARROWS[k].missKeep)).toEqual([0.85, 0.9, METAL_MISS_KEEP, METAL_MISS_KEEP, METAL_MISS_KEEP, METAL_MISS_KEEP]);
    expect(METAL_MISS_KEEP).toBe(0.97);
    expect(ARROW_KEYS.map(hitBreakP)).toEqual([0.65, 0.5, 0.3, 0.25, 0.15, 0.1]);
    expect(ARROW_KEYS.map(missBreakP)).toEqual([0.15, 0.1, 0.03, 0.03, 0.03, 0.03]);
    // metal keeps better than stone and flint, both ways; each age at least as well as the one before
    for (let i = 1; i < ARROW_KEYS.length; i++) {
      expect(ARROWS[ARROW_KEYS[i]].hitKeep).toBeGreaterThan(ARROWS[ARROW_KEYS[i - 1]].hitKeep);
      expect(ARROWS[ARROW_KEYS[i]].missKeep).toBeGreaterThanOrEqual(ARROWS[ARROW_KEYS[i - 1]].missKeep);
    }
    for (const k of ['rock', 'flint_spear', 'stick']) expect([hitBreakP(k), missBreakP(k)], k).toEqual([0, 0]);
  });

  it('seeded: a hit keeps about hitKeep of the arrows (the broken ones are gone, onBreak told)', () => {
    const N = 600;
    for (const k of ARROW_KEYS) {
      const { left, out } = shoot(k, N, { mobX: 4 });
      expect(out.hits, k).toBe(N);
      expect(out.broke.hit + left, k).toBe(N);
      expect(out.broke.miss, k).toBe(0); // a hit spends the arrow's power: it does not roll again when it lands
      expect(Math.abs(left / N - ARROWS[k].hitKeep), `${k}: ${left}/${N}`).toBeLessThan(0.06);
    }
    // repeatable: the same seed, the same arrows
    expect(shoot('stone_arrow', 200, { mobX: 4, seed: 3 }).left).toBe(shoot('stone_arrow', 200, { mobX: 4, seed: 3 }).left);
  });

  it('seeded: a miss that lands keeps about missKeep (the ground or a wall); a metal head hardly ever shatters', () => {
    const N = 800;
    for (const k of ARROW_KEYS) {
      const { left, out } = shoot(k, N);
      expect(out.hits, k).toBe(0);
      expect(out.broke.miss + left, k).toBe(N);
      expect(Math.abs(left / N - ARROWS[k].missKeep), `${k}: ${left}/${N}`).toBeLessThan(0.04);
    }
    const walled = shoot('flint_arrow', N, { wall: 3 });
    expect(Math.abs(walled.left / N - ARROWS.flint_arrow.missKeep)).toBeLessThan(0.04);
    expect(shoot('steel_arrow', N).left).toBeGreaterThan(shoot('stone_arrow', N).left);
  });

  it('nothing else rolls: a ghost (Creative) arrow, an arrow chucked by hand (power 0), a spear or a rock always lands whole', () => {
    expect(shoot('stone_arrow', 300, { mobX: 4, ghost: true }).out.broke).toEqual({ hit: 0, miss: 0 });
    expect(shoot('stone_arrow', 300, { ghost: true }).out.broke).toEqual({ hit: 0, miss: 0 });
    expect(shoot('stone_arrow', 300, { power: 0 })).toMatchObject({ left: 300, out: { broke: { hit: 0, miss: 0 } } });
    for (const k of ['rock', 'flint_spear']) expect(shoot(k, 200, { mobX: 4 }).left, k).toBe(200);
    // by hand (G) an arrow is only chucked: no power, so it never hits or breaks
    for (const k of ARROW_KEYS) expect(throwOf(k), k).toBe(THROW_CHUCK);
  });
});

describe('§100 the bows: the Crude Bow and the Recurve Bow', () => {
  it('the stats: draw 1 s / 1.2 s, 28 / 42 m/s at full draw, a 3° / 0.8° cone, 0.6 / 0.5 of gravity', () => {
    expect(BOWS).toEqual({
      crude_bow: { drawS: 1.0, speed: 28, spreadDeg: 3, gravity: 0.6 },
      recurve_bow: { drawS: 1.2, speed: 42, spreadDeg: 0.8, gravity: 0.5 },
    });
    for (const k of Object.keys(BOWS)) {
      expect(ITEMS[k].tool?.type, k).toBe('bow');
      expect(bowOf(k), k).toBe(BOWS[k]);
      expect(drawOf(k)?.fullS, k).toBe(BOWS[k].drawS);
    }
    expect([maxDurability('crude_bow'), maxDurability('recurve_bow')]).toEqual([60, 220]);
    expect(bowOf('flint_spear')).toBe(null);
  });

  it('bowShot: the bow\'s speed at full draw, the draw\'s shares below it as for a throw; the arrow\'s power; the spread in radians', () => {
    for (const [bow, b] of Object.entries(BOWS)) {
      for (const arrow of ARROW_KEYS) {
        const full = bowShot(bow, arrow, 1);
        expect(full.speed, `${bow} ${arrow}`).toBe(b.speed);
        expect(full.power, `${bow} ${arrow}`).toBe(ARROWS[arrow].power);
        expect(full.gravity).toBe(b.gravity);
        expect(full.spread).toBeCloseTo((b.spreadDeg * Math.PI) / 180, 12);
        const tap = bowShot(bow, arrow, 0);
        expect(tap.speed).toBeCloseTo((b.speed * DRAW_SPEED_MIN) / DRAW_SPEED_FULL, 1);
        expect(tap.power).toBeCloseTo(ARROWS[arrow].power * DRAW_POWER_MIN, 6);
        const half = bowShot(bow, arrow, 0.5);
        expect(half.speed).toBeGreaterThan(tap.speed);
        expect(half.speed).toBeLessThan(full.speed);
      }
    }
    // the recurve is faster, flatter and truer with the same arrow; its power is the arrow's either way
    const crude = bowShot('crude_bow', 'iron_arrow', 1);
    const recurve = bowShot('recurve_bow', 'iron_arrow', 1);
    expect(recurve.speed).toBeGreaterThan(crude.speed);
    expect(recurve.gravity).toBeLessThan(crude.gravity);
    expect(recurve.spread).toBeLessThan(crude.spread);
    expect(recurve.power).toBe(crude.power);
    // unknown bows and arrows: a Crude Bow's shot of a Flint Arrow
    expect(bowShot('nope', 'nope', 1)).toEqual(bowShot('crude_bow', 'flint_arrow', 1));
  });

  it('the draw: full at the bow\'s own time — the recurve takes longer to draw', () => {
    expect(drawFraction(1, BOWS.crude_bow.drawS)).toBe(1);
    expect(drawFraction(1, BOWS.recurve_bow.drawS)).toBeCloseTo(1 / 1.2, 9);
    expect(drawFraction(1.2, BOWS.recurve_bow.drawS)).toBe(1);
  });

  it('spreadDir: every shot within the bow\'s cone round the aim, filling it; no spread is the aim itself', () => {
    const random = seededRandom(11);
    const aims = [[0, 0, -1], [0.6, 0.2, -0.77], [0, 1, 0], [1, 0, 0]];
    for (const [bow, b] of Object.entries(BOWS)) {
      const cone = (b.spreadDeg * Math.PI) / 180;
      for (const a of aims) {
        const len = Math.hypot(...a);
        let widest = 0;
        const sum = [0, 0, 0];
        for (let i = 0; i < 2000; i++) {
          const d = spreadDir(a[0], a[1], a[2], cone, random);
          expect(Math.hypot(...d)).toBeCloseTo(1, 9);
          const cos = (d[0] * a[0] + d[1] * a[1] + d[2] * a[2]) / len;
          const angle = Math.acos(Math.min(1, cos));
          if (angle > widest) widest = angle;
          for (let j = 0; j < 3; j++) sum[j] += d[j];
        }
        expect(widest, `${bow} ${a}`).toBeLessThanOrEqual(cone + 1e-9);
        expect(widest, `${bow} ${a}`).toBeGreaterThan(cone * 0.95); // it reaches the rim
        // the mean shot is the aim (no lean to one side)
        const m = Math.hypot(...sum);
        const meanCos = (sum[0] * a[0] + sum[1] * a[1] + sum[2] * a[2]) / (m * len);
        expect(Math.acos(Math.min(1, meanCos))).toBeLessThan(cone * 0.08);
      }
    }
    expect(spreadDir(0, 0, -2, 0, Math.random)).toEqual([0, 0, -1]);
  });

  it('the recurve\'s arrow flies farther on the same aim: its speed and its flatter arc', () => {
    /** How far an arrow shot 5° up from 1.5 m above flat ground lands, at full draw. */
    const reach = (bow) => {
      const shot = bowShot(bow, 'flint_arrow', 1);
      const loose = new LooseItems(() => 0.99); // never breaks
      const { e } = env({ floor: 0 });
      const up = (5 * Math.PI) / 180;
      const it = loose.launch({ k: 'flint_arrow', n: 1 }, 0, 1.5, 0, Math.cos(up) * shot.speed, Math.sin(up) * shot.speed, 0, { power: shot.power, gravity: shot.gravity });
      for (let t = 0; t < 6 && it.vy !== 0 && it.mode === 'fly'; t += DT) loose.step(DT, e);
      return it.x;
    };
    const crude = reach('crude_bow');
    const recurve = reach('recurve_bow');
    expect(crude).toBeGreaterThan(15);
    expect(recurve).toBeGreaterThan(crude * 1.6);
    // gravity in flight is the bow's share of ITEM_GRAVITY
    expect(ITEM_GRAVITY).toBeLessThan(0);
  });
});

describe('§100 the arrow a bow takes', () => {
  it('the first in the pack of steel, iron, bronze, copper, flint, stone; none: null', () => {
    expect(ARROW_PREFERENCE).toEqual(['steel_arrow', 'iron_arrow', 'bronze_arrow', 'copper_arrow', 'flint_arrow', 'stone_arrow']);
    const from = (have) => pickArrow((k) => have[k] ?? 0);
    expect(from({})).toBe(null);
    expect(from({ stone_arrow: 9 })).toBe('stone_arrow');
    expect(from({ stone_arrow: 9, flint_arrow: 1 })).toBe('flint_arrow');
    expect(from({ flint_arrow: 3, copper_arrow: 2, steel_arrow: 1 })).toBe('steel_arrow');
    expect(from({ iron_arrow: 0, bronze_arrow: 4 })).toBe('bronze_arrow');
    // from a real pack: counted across all its slots
    const pack = new Pack();
    pack.give('stone_arrow', 20);
    pack.give('iron_arrow', 2);
    expect(pickArrow((k) => pack.count(k))).toBe('iron_arrow');
    pack.take('iron_arrow', 2);
    expect(pickArrow((k) => pack.count(k))).toBe('stone_arrow');
  });

  it('bowArrowFrom: Survival the pack\'s best (none of any age: null); Creative the hotbar\'s best, else a Flint Arrow', () => {
    const pack = new Pack();
    const sv = () => bowArrowFrom({ survival: true, count: (k) => pack.count(k), hotbar: ['steel_arrow'] });
    expect(sv()).toBe(null); // the Creative hotbar never counts in Survival
    for (const k of ARROW_KEYS) {
      const only = new Pack();
      only.give(k, 3);
      // ANY age will do: a pack of only flint or only metal arrows is not "no arrows"
      expect(bowArrowFrom({ survival: true, count: (key) => only.count(key), hotbar: [] }), k).toBe(k);
    }
    pack.give('flint_arrow', 12);
    pack.give('copper_arrow', 1);
    expect(sv()).toBe('copper_arrow');
    // Creative needs none: the best arrow on the hotbar, else DEFAULT_ARROW (a ghost), never null
    const cr = (hotbar) => bowArrowFrom({ survival: false, count: () => 0, hotbar });
    expect(cr([1, 2, 3])).toBe(DEFAULT_ARROW);
    expect(DEFAULT_ARROW).toBe('flint_arrow');
    expect(cr([1, 'stone_arrow', 'bronze_arrow', null])).toBe('bronze_arrow');
    expect(cr(['crude_bow', 'stone_arrow'])).toBe('stone_arrow');
  });

  it('the hint names the bow and the arrow it would shoot, and in Survival how many; none: says so', () => {
    const pack = new Pack();
    pack.give('flint_arrow', 12);
    const count = (k) => pack.count(k);
    expect(bowHint('crude_bow', 'flint_arrow', true, count)).toBe('Crude Bow · Flint Arrows (12) · Hold RMB to draw');
    expect(touchWords(bowHint('crude_bow', 'flint_arrow', true, count))).toBe('Crude Bow · Flint Arrows (12) · Hold Place to draw');
    expect(bowHint('recurve_bow', 'steel_arrow', false, count)).toBe('Recurve Bow · Steel Arrows · Hold RMB to draw');
    expect(bowHint('crude_bow', null, true, count)).toBe('Crude Bow · no arrows in your pack');
    expect(NO_ARROWS_HINT).toBe('No arrows: make them by hand from a stick, a rock or a flint, and a feather');
  });
});

describe('§100 main\'s wiring of the bow (read from the source)', () => {
  const main = read('src/main.js');
  const body = (name) => new RegExp(`function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n {2}\\}\\n`).exec(main)?.[1] ?? '';

  it('bowArrow is bowArrowFrom over the pack (Survival) and the Creative hotbar', () => {
    expect(body('bowArrow')).toContain('return bowArrowFrom({ survival: survival.inSurvival, count: (k) => pack.count(k), hotbar });');
  });

  it('the press: no arrow of any age refuses the draw with NO_ARROWS_HINT; the bow\'s own full draw is told', () => {
    const step = body('drawStep');
    expect(step).toContain('e.noArrows = d.bow && bowArrow() === null;');
    expect(step).not.toMatch(/ARROW_KEYS\[/); // not one age only
    expect(step).toContain('e.fullS = d ? d.fullS : DRAW_FULL_S;');
    expect(step).toContain("if (did === 'noArrows') showHint(NO_ARROWS_HINT);");
    expect(step).toContain("else if (did === 'release' && d && key) drawRelease(d, key, draw.f);");
  });

  it('the release: the chosen arrow from the pack, the bow\'s shot of it, its cone and its gravity; the bow wears', () => {
    const rel = body('drawRelease');
    expect(rel).toContain('const arrow = bowArrow();');
    expect(rel).toContain('if (arrow === null || (SV && pack.take(arrow, 1) < 1)) {');
    expect(rel).toContain('({ speed, power, gravity, spread } = bowShot(key, arrow, f));');
    expect(rel).toMatch(/spreadDir\([^;]*, spread, Math\.random\)/);
    expect(rel).toMatch(/loose\.launch\(stack,[\s\S]*ghost: !SV, power, gravity,/);
    expect(rel).toContain('const res = pack.damage(selected, 1);');
  });

  it('the hint is bowHint\'s; the ring, the zoom and the arm follow the bow\'s own draw (draw.share)', () => {
    expect(body('drawHintText')).toContain('if (d.bow) return bowHint(key, bowArrow(), survival.inSurvival, (k) => pack.count(k));');
    expect(main).toContain('const drawShare = () => draw.share;');
    expect(body('drawRing')).toContain('return draw.on ? Math.max(0.02, drawShare()) : null;');
    expect(main).toContain('mi.draw = drawShare();');
    expect(main).toContain('fov = easeFov(fov, draw.on ? wantFov * (1 - DRAW_ZOOM * drawShare()) : wantFov, dt);');
    expect(main).not.toMatch(/drawFraction\(draw\.held\)/); // never against DRAW_FULL_S alone
  });
});

describe('§100 the Sapling', () => {
  const HAND = null;
  const tool = (k) => /** @type {*} */ (ITEMS[k].tool);
  /** How often `fn` (a roll with `random`) gives a sapling, over `n` rolls. */
  const share = (fn, n = 4000, seed = 5) => {
    const random = seededRandom(seed);
    let got = 0;
    for (let i = 0; i < n; i++) if (fn(random).some((s) => s.k === 'sapling')) got++;
    return got / n;
  };

  it('untouched leaves broken by hand or with a knife give one about one time in eight; an axe lops it with the leaves', () => {
    expect(SAPLING_LEAF_P).toBe(0.12);
    for (const id of [BLOCK.OAK_LEAVES, BLOCK.SPRUCE_LEAVES, BLOCK.BIRCH_LEAVES]) {
      expect(Math.abs(share((r) => rollDrops(id, HAND, { natural: true }, r)) - SAPLING_LEAF_P), String(id)).toBeLessThan(0.02);
      expect(Math.abs(share((r) => rollDrops(id, tool('flint_knife'), { natural: true }, r)) - SAPLING_LEAF_P)).toBeLessThan(0.02);
      expect(share((r) => rollDrops(id, tool('stone_axe'), { natural: true }, r), 500)).toBe(0);
      expect(share((r) => rollDrops(id, HAND, { natural: false }, r), 500)).toBe(0); // leaves you put down give none
    }
    // one at a time
    expect(rollDrops(BLOCK.BIRCH_LEAVES, HAND, { natural: true }, () => 0)).toEqual([{ k: 'sapling', n: 1 }]);
  });

  it('a hazel thicket picked with R gives one now and then; a sapling stacks 16 and is the Crude Bow\'s', () => {
    expect(SAPLING_HAZEL_P).toBe(0.2);
    expect(Math.abs(share((r) => /** @type {*} */ (pick(BLOCK.HAZEL_THICKET, {}, r)).drops) - SAPLING_HAZEL_P)).toBeLessThan(0.025);
    expect(getItem('sapling')?.stack).toBe(16);
  });
});

describe('§100 old saves: the Bow, the Arrow and the darts', () => {
  it('a saved pack: the Bow is a Crude Bow (its wear at most 60), the Arrow and both darts Flint Arrows', () => {
    const pack = new Array(PACK_SLOTS).fill(null);
    pack[0] = { k: 'bow', n: 1, d: 80 };
    pack[1] = { k: 'bow', n: 1, d: 25 };
    pack[2] = { k: 'arrow', n: 12 };
    pack[3] = { k: 'flint_dart', n: 16 };
    pack[4] = { k: 'fletched_dart', n: 3 };
    const warnings = [];
    const out = normalizeSurvivalJSON({ pack }, warnings);
    expect(out.pack.slice(0, 5)).toEqual([
      { k: 'crude_bow', n: 1, d: 60 }, { k: 'crude_bow', n: 1, d: 25 }, { k: 'flint_arrow', n: 12 }, { k: 'flint_arrow', n: 16 },
      { k: 'flint_arrow', n: 3 },
    ]);
    expect(warnings.some((w) => /survival\.pack\[0\]/.test(w))).toBe(true); // the shortened wear is noted
    expect(warnings.some((w) => /dropped/.test(w))).toBe(false); // nothing is lost
    // the pack loads the same from raw JSON
    const p = new Pack();
    expect(p.load({ pack, wear: [null, null, null] }).filter((w) => /dropped/.test(w))).toEqual([]);
    expect(p.slots.slice(0, 5)).toEqual(out.pack.slice(0, 5));
    expect(p.count('flint_arrow')).toBe(31);
  });

  it('things lying loose, Creative hotbar picks and typed names read the same way', () => {
    const loose = new LooseItems(() => 0.5);
    expect(loose.load([{ k: 'bow', n: 1, d: 99, x: 0, y: 5, z: 0 }, { k: 'fletched_dart', n: 2, x: 1, y: 5, z: 0 }])).toBe(2);
    expect(loose.list.map((it) => it.s)).toEqual([{ k: 'crude_bow', n: 1, d: 60 }, { k: 'flint_arrow', n: 2 }]);
    expect([normalizePick('bow'), normalizePick('arrow'), normalizePick('flint_dart'), normalizePick('fletched_dart')])
      .toEqual(['crude_bow', 'flint_arrow', 'flint_arrow', 'flint_arrow']);
    expect(canonicalItemKey('bow')).toBe('crude_bow');
  });
});

describe('§100 the bows and the arrows in the hand (heldItem)', () => {
  it('a bow is gripped at its wrapped handle, its limbs straight ahead; an arrow by its nock, point ahead', () => {
    for (const k of ['crude_bow', 'recurve_bow']) {
      const g = /** @type {*} */ (heldItemGeometry(k));
      expect(heldWielded(k), k).toBe(true);
      expect(g.style, k).toBe('tool');
      expect(g.turn, k).toBe(0); // mirror-symmetric pictures
      expect(g.grip[0], k).toBe(8);
    }
    for (const k of ARROW_KEYS) {
      const g = /** @type {*} */ (heldItemGeometry(k));
      expect(heldWielded(k), k).toBe(true); // the darts' heirs, held by the shaft
      expect(g.style, k).toBe('tool');
      expect(Math.abs(g.turn), k).toBeLessThan(0.05); // upright: point straight ahead
      expect(g.grip[1], k).toBeGreaterThan(11); // near the nock at the bottom
    }
    for (const k of ['sapling', 'bow_stave', 'treated_stave', 'spyglass']) expect(heldItemGeometry(k)?.style, k).toBe('lump');
  });
});
