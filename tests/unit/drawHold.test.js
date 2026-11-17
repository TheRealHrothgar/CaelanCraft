// Unit tests for §100.2's draw (src/main.js DrawHold, PURE): Place held with a spear, a dart or a bow draws back and the
// release throws; a screen over the running world (the pack, the field book, Survival's device panel) lets the draw go
// without a throw; and while the control latch holds a control that Place pressed, the hold is the latch's (§4.9).
// Then main's draw path (read from the source, since main needs a browser), and the seam with §99.4's target hint: a
// spear, a dart or a bow in hand says how it is thrown before the tool's words for the block in reach.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DrawHold, ControlLatch, rightMouseStep, throwHintFirst, digSlowHint } from '../../src/main.js';
import { drawFraction, DART_KEYS } from '../../src/looseItems.js';
import { DigState } from '../../src/survivalControl.js';
import { canHarvest, harvestHint, handGatherHint, breakSeconds } from '../../src/harvest.js';
import { getItem } from '../../src/items.js';
import { BLOCK } from '../../src/blocks.js';

const FRAME = 1 / 60;

/** A DrawEnv: a Flint Spear in hand, in play, on nothing in particular. */
const envOf = (more = {}) => ({
  key: 'flint_spear', draws: true, playing: true, control: false, noArrows: false, latched: false, ...more,
});
const PRESS = { rightPressed: true, right: true };
const HELD = { rightPressed: false, right: true };
const UP = { rightPressed: false, right: false };

/** Press, then hold `frames` frames; returns the env and what each frame did. */
function drawFor(d, frames, env = envOf()) {
  const did = [d.step(PRESS, FRAME, env)];
  for (let i = 0; i < frames; i++) did.push(d.step(HELD, FRAME, env));
  return { env, did };
}

describe('§100.2 DrawHold — hold Place to draw, let go to throw', () => {
  it('a press starts the draw, holding counts up, letting go releases it at drawFraction(held)', () => {
    const d = new DrawHold();
    const { env, did } = drawFor(d, 30);
    expect(did[0]).toBe('start');
    expect(did.slice(1).every((x) => x === 'hold')).toBe(true);
    expect(d.on).toBe(true);
    expect(d.held).toBeCloseTo(30 * FRAME, 9);
    expect(d.step(UP, FRAME, env)).toBe('release');
    expect(d.f).toBeCloseTo(drawFraction(30 * FRAME), 9);
    expect(d.on).toBe(false);
    expect(d.step(UP, FRAME, env)).toBe('idle'); // nothing more is thrown
  });

  it('a slow frame never swallows a throw: there is no clock, only the frames\' dt', () => {
    // a busy machine (or a chunk being built) holds the release frame back: it is still a throw, at the draw it had
    const d = new DrawHold();
    const { env } = drawFor(d, 36);
    expect(d.step(UP, 0.4, env)).toBe('release');
    expect(d.f).toBeCloseTo(drawFraction(36 * FRAME), 9);
    // and a slow frame while held counts as the time it took (main clamps a frame's dt to MAX_FRAME_DT)
    drawFor(d, 0);
    expect(d.step(HELD, 0.25, env)).toBe('hold');
    expect(d.held).toBeCloseTo(0.25, 9);
    expect(d.step(UP, 0.4, env)).toBe('release');
  });

  it('a screen that keeps the world running (the pack, the field book, a device panel) lets the draw go without a throw', () => {
    // Frame N: RMB held. Frame N+1: E opens the pack (its frame returns early). Frame N+2: the world steps under the pack
    // with the mouse cleared (controls.setEnabled(false)): that is no release.
    const d = new DrawHold();
    const { env } = drawFor(d, 40);
    env.playing = false;
    expect(d.step(UP, FRAME, env)).toBe('cancel');
    expect(d.on).toBe(false);
    for (let i = 0; i < 30; i++) expect(d.step(UP, FRAME, env)).toBe('cancel'); // under the pack, frame after frame
    // back to playing: the mouse is still up, nothing is thrown
    env.playing = true;
    expect(d.step(UP, FRAME, env)).toBe('idle');
  });

  it('cancel() (main: a menu that freezes the world, a lost pointer lock; resetSurvivalInput) forgets it: no throw on return', () => {
    // the pause menu's frames do not step the world at all: drawStep never sees them, so setState cancels the draw
    const d = new DrawHold();
    const { env } = drawFor(d, 20);
    d.cancel();
    expect([d.on, d.held]).toEqual([false, 0]);
    expect(d.step(UP, FRAME, env)).toBe('idle'); // the first frame back, Place up
  });

  it('a changed hand cancels; a bow with no arrows does not draw; nothing in hand that draws is not the draw\'s', () => {
    const d = new DrawHold();
    const { env } = drawFor(d, 10);
    env.key = 'flint_dart';
    expect(d.step(HELD, FRAME, env)).toBe('cancel');
    expect(d.on).toBe(false);
    expect(d.step(PRESS, FRAME, envOf({ key: 'bow', noArrows: true }))).toBe('noArrows');
    expect(d.on).toBe(false);
    expect(d.step(PRESS, FRAME, envOf({ key: 'stone_axe', draws: false }))).toBe(null);
    expect(d.step(PRESS, FRAME, envOf({ key: null, draws: true }))).toBe(null);
    // a death mid-draw (draws false: survival.dead) drops it too
    drawFor(d, 10);
    expect(d.step(HELD, FRAME, envOf({ draws: false }))).toBe(null);
    expect(d.on).toBe(false);
  });

  it('Creative: with a spear in hand, holding Place on a Push Button keeps it held (the control latch)', () => {
    // main's Creative frame: `if (!drawStep(mouse, dt)) rightMouseStep(controlLatch, …); else if (!mouse.right) release()`
    const d = new DrawHold();
    const latch = new ControlLatch();
    const button = { q: 3, y: 64, r: 4, blockId: 1, face: 0 };
    const calls = { operate: 0, hold: 0, place: 0 };
    const latchEnv = {
      isControl: () => true,
      operate: () => calls.operate++,
      hold: () => calls.hold++,
      place: () => calls.place++,
    };
    const frame = (mouse) => {
      const env = envOf({ control: mouse.rightPressed, latched: latch.on });
      const did = d.step(mouse, FRAME, env);
      if (did === null) rightMouseStep(latch, mouse, button, false, FRAME, latchEnv);
      else if (!mouse.right) latch.release();
      return did;
    };
    expect(frame(PRESS)).toBe(null); // the press is the control's
    expect(calls.operate).toBe(1);
    expect(latch.on).toBe(true);
    for (let i = 1; i <= 20; i++) frame(HELD);
    expect(calls.hold).toBe(20); // every held frame keeps the button pressed (circuits.hold)
    expect(d.on).toBe(false); // and nothing was drawn
    frame(UP);
    expect(latch.on).toBe(false);
    expect(calls.place).toBe(0);
    // with the latch off, a held Place with nothing drawn is still the draw's (nothing is placed)
    expect(d.step(HELD, FRAME, envOf())).toBe('idle');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// main's draw path: main needs a browser, so its wiring is read from the source (as harness.test.js does for §99).

const main = readFileSync(fileURLToPath(new URL('../../src/main.js', import.meta.url)), 'utf8');
/** @param {string} head  the function's first line, as main writes it @returns {string} its body */
const body = (head) => {
  const at = main.indexOf(head);
  expect(at, head).toBeGreaterThan(0);
  return main.slice(at, main.indexOf('\n  }\n', at));
};

describe('§100.2 main\'s draw path', () => {
  it('only frames of play draw or throw: leaving STATE.PLAYING and resetting the Survival input cancel the draw', () => {
    // a menu that freezes the world (pause, a lost pointer lock, the picker, the console, death) never steps drawStep, so
    // without this the first frame back, Place up, would throw
    expect(body('  function setState(s) {')).toMatch(/if \(s !== STATE\.PLAYING\) \{[^}]*draw\.cancel\(\);/);
    expect(body('  function resetSurvivalInput() {')).toContain('draw.cancel();');
    const step = body('  function drawStep(mouse, dt) {');
    expect(step).toContain('e.playing = /** @type {string} */ (state) === STATE.PLAYING;');
    expect(step).toContain('e.draws = !!d && !survival.dead;');
    expect(step).toContain('e.latched = controlLatch.on;');
    expect(step).toContain("else if (did === 'release' && d && key) drawRelease(d, key, draw.f);");
    // no clock: a slow frame never swallows a throw
    expect(step).not.toMatch(/now\(\)/);
    expect(main).not.toContain('DRAW_STALE_MS');
    expect(main).not.toContain("'stale'");
  });

  it('everything that shows the draw reads the one DrawHold: the pose, the ring, the zoom, the hint and the others\' view', () => {
    // §91.3 / §96.2: the draw's pose for the avatar and, on a server, POSE_DRAWING in the pose flags (the old `drawState`
    // name, left behind by a merge, threw on every pose sent to a server)
    expect(main).not.toMatch(/\bdrawState\b/);
    expect(main).toContain('mi.draw = draw.on ? drawFraction(draw.held) : 0;');
    expect(main).toContain('if (draw.on) flags |= POSE_DRAWING;');
    expect(body('  function drawRing() {')).toContain('return draw.on ? Math.max(0.02, drawFraction(draw.held)) : null;');
    expect(main).toContain('fov = easeFov(fov, draw.on ? wantFov * (1 - DRAW_ZOOM * drawFraction(draw.held)) : wantFov, dt);');
    expect(body('  function actionProgress() {')).toContain('if (draw.on) return drawRing();');
  });

  it('every Place goes through drawStep: Survival after the control latch and the Handbook, Creative before its place', () => {
    const right = body('  function survivalRight(mouse, dt) {');
    const latch = right.indexOf('controlLatch.press(hit, shift, latchEnv)');
    const book = right.indexOf('openBook()');
    const drawn = right.indexOf('if (drawStep(mouse, dt)) {');
    expect(latch).toBeGreaterThan(0);
    expect(book).toBeGreaterThan(latch);
    expect(drawn).toBeGreaterThan(book);
    expect(drawn).toBeLessThan(right.indexOf('const act = useActionOf(stack);'));
    // Creative's frame and the debug handle's rightClick: the draw first, else the control latch or the place
    expect(main).toContain('if (!drawStep(mouse, dt)) rightMouseStep(controlLatch, mouse, hit, shift, dt, latchEnv);\n'
      + '      else if (!mouse.right) controlLatch.release();');
    expect(main).toContain("if (drawStep(mouse, dt)) return 'draw'; // §100\n      return rightMouseStep(controlLatch, mouse, hit, shift, dt, latchEnv);");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The seam of §99.4 and §100.2: the target hint with a spear, a dart or a bow in hand.

describe('§99.4 × §100.2: the throw\'s words come before the tool\'s for the block in reach, unless it is dug', () => {
  const tool = (k) => /** @type {*} */ (getItem(k)).tool ?? null;
  const at = (blockId) => ({ q: 0, y: 10, r: 0, blockId });

  it('throwHintFirst: a spear, a dart or a bow in hand and no dig under way', () => {
    const idle = new DigState();
    for (const k of ['flint_spear', ...DART_KEYS, 'bow']) expect(throwHintFirst(idle, k), k).toBe(true);
    for (const k of ['stone_pick', 'stone_axe', 'arrow', 'stick', null]) expect(throwHintFirst(idle, k), String(k)).toBe(false);
    const dig = new DigState();
    dig.step(FRAME, at(BLOCK.DIRT), true, breakSeconds(BLOCK.DIRT, tool('flint_spear')), 'flint_spear');
    expect(dig.active).toBe(true);
    expect(throwHintFirst(dig, 'flint_spear')).toBe(false); // digging: the block's words again
  });

  it('without it the hand\'s words would hide the throw on nearly all the ground in reach', () => {
    const spear = tool('flint_spear');
    const bow = tool('bow');
    // the tool gate: a spear or a bow is no block's own tool
    for (const id of [BLOCK.STONE, BLOCK.OAK_LOG, BLOCK.BIRCH_LOG]) {
      for (const t of [spear, bow]) {
        expect(canHarvest(id, t), String(id)).toBe(false);
        expect(harvestHint(id), String(id)).toMatch(/ · needs /);
      }
    }
    // the bare-hand words
    expect(handGatherHint(BLOCK.TUSSOCK)).toBe('Tussock Grass · hold LMB: pull');
    // and, while it is dug, the slow word (§99.4: only then)
    const dig = new DigState();
    dig.step(FRAME, at(BLOCK.DIRT), true, breakSeconds(BLOCK.DIRT, spear), 'flint_spear');
    expect(digSlowHint(dig, at(BLOCK.DIRT), spear)).toBe('Dirt · slow — a shovel digs much faster');
  });

  it('main asks it after a burning keg and a crop and before the tool gate, the bare-hand, wrong-ground and slow words', () => {
    const hint = body('  function survivalHintText() {');
    expect(hint).toContain('const throwFirst = throwHintFirst(digState, heldItemKey());');
    const first = hint.indexOf('if (throwFirst) return blockHintText() ?? drawHintText();'); // a keg, a control, a rune: theirs
    expect(first).toBeGreaterThan(hint.indexOf('const throwFirst = '));
    expect(first).toBeGreaterThan(hint.indexOf('burningKegHint(h,'));
    expect(first).toBeGreaterThan(hint.indexOf('if (crop) return cropHintText(h, crop);'));
    for (const later of ['harvestHint(h.blockId)', 'handGatherHint(h.blockId)', 'wrongGroundHint(', 'digSlowHint(digState, h, tool)']) {
      expect(hint.indexOf(later), later).toBeGreaterThan(first);
    }
    // a brick likewise; while drawing, how to let go comes before all of it
    expect(hint).toContain('} else if (brickHit && !throwFirst) {');
    expect(hint.indexOf('if (draw.on) return drawHintText();')).toBeLessThan(hint.indexOf('const act = interactAction();'));
    expect(hint.trimEnd().endsWith('return blockHintText() ?? drawHintText(); // §100: what is in hand is thrown by holding Place')).toBe(true);
  });
});
