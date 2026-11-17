// Unit tests for §100.2's draw (src/main.js DrawHold, PURE): Place held with a spear, a dart or a bow draws back and the
// release throws; a screen over the running world (the pack, the field book, Survival's device panel) lets the draw go
// without a throw; and while the control latch holds a control that Place pressed, the hold is the latch's (§4.9).
import { describe, it, expect } from 'vitest';
import { DrawHold, DRAW_STALE_MS, ControlLatch, rightMouseStep } from '../../src/main.js';
import { drawFraction } from '../../src/looseItems.js';

const FRAME = 1 / 60;
const FRAME_MS = 1000 / 60;

/** A DrawEnv: a Flint Spear in hand, in play, on nothing in particular. */
const envOf = (more = {}) => ({
  key: 'flint_spear', draws: true, playing: true, control: false, noArrows: false, latched: false, now: 0, ...more,
});
const PRESS = { rightPressed: true, right: true };
const HELD = { rightPressed: false, right: true };
const UP = { rightPressed: false, right: false };

/** Press, then hold `frames` frames; returns the env (its clock at the last frame) and what each frame did. */
function drawFor(d, frames, env = envOf()) {
  const did = [d.step(PRESS, FRAME, env)];
  for (let i = 0; i < frames; i++) {
    env.now += FRAME_MS;
    did.push(d.step(HELD, FRAME, env));
  }
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
    env.now += FRAME_MS;
    expect(d.step(UP, FRAME, env)).toBe('release');
    expect(d.f).toBeCloseTo(drawFraction(30 * FRAME), 9);
    expect(d.on).toBe(false);
    expect(d.step(UP, FRAME, env)).toBe('idle'); // nothing more is thrown
  });

  it('a screen that keeps the world running (the pack, the field book, a device panel) lets the draw go without a throw', () => {
    // Frame N: RMB held. Frame N+1: E opens the pack (its frame returns early). Frame N+2: the world steps under the pack
    // with the mouse cleared (controls.setEnabled(false)): that is no release.
    const d = new DrawHold();
    const { env } = drawFor(d, 40);
    env.now += 2 * FRAME_MS; // well inside DRAW_STALE_MS: only the screen tells this frame from a real release
    expect(2 * FRAME_MS).toBeLessThan(DRAW_STALE_MS);
    env.playing = false;
    expect(d.step(UP, FRAME, env)).toBe('cancel');
    expect(d.on).toBe(false);
    // back to playing: the mouse is still up, nothing is thrown
    env.playing = true;
    env.now += FRAME_MS;
    expect(d.step(UP, FRAME, env)).toBe('idle');
  });

  it('a draw left longer than DRAW_STALE_MS (a menu froze the world) is let go without a throw', () => {
    const d = new DrawHold();
    const { env } = drawFor(d, 20);
    env.now += DRAW_STALE_MS + 1;
    expect(d.step(UP, FRAME, env)).toBe('stale');
    expect(d.on).toBe(false);
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
    const frame = (mouse, now) => {
      const env = envOf({ control: mouse.rightPressed, latched: latch.on, now });
      const did = d.step(mouse, FRAME, env);
      if (did === null) rightMouseStep(latch, mouse, button, false, FRAME, latchEnv);
      else if (!mouse.right) latch.release();
      return did;
    };
    expect(frame(PRESS, 0)).toBe(null); // the press is the control's
    expect(calls.operate).toBe(1);
    expect(latch.on).toBe(true);
    for (let i = 1; i <= 20; i++) frame(HELD, i * FRAME_MS);
    expect(calls.hold).toBe(20); // every held frame keeps the button pressed (circuits.hold)
    expect(d.on).toBe(false); // and nothing was drawn
    frame(UP, 21 * FRAME_MS);
    expect(latch.on).toBe(false);
    expect(calls.place).toBe(0);
    // with the latch off, a held Place with nothing drawn is still the draw's (nothing is placed)
    expect(d.step(HELD, FRAME, envOf())).toBe('idle');
  });
});
