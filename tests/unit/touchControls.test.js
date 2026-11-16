// The touch controls (touchControls.js, CONTRACTS §95, docs/DESIGN-multiplayer.md §5): touch-mode detection, the stick and
// look maths, TouchPad driving a real controls object, and the DOM layer on the fake DOM.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  readTouchParam, touchModeFor, detectTouchMode, stickVector, lookDelta, hotbarCode, TouchPad, createTouchUI,
  TOUCH_BUTTONS, PAD_BUTTONS, TOP_BUTTONS, STICK_RADIUS, STICK_DEAD, TOUCH_LOOK_SENSITIVITY, TOUCH_RENDER_DISTANCE,
  STICK_ZONE,
} from '../../src/touchControls.js';
import { createControls, GAME_KEYS } from '../../src/controls.js';
import { HOTBAR_SIZE, RENDER_DISTANCE } from '../../src/config.js';
import { documentFromHTML, fire } from '../helpers/fakeDom.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');

/** A real controls object in touch mode with the virtual lock held (as play leaves it). */
async function lockedControls() {
  const doc = /** @type {any} */ (new EventTarget());
  doc.pointerLockElement = null;
  const canvas = new EventTarget();
  const controls = createControls(canvas, doc);
  controls.setTouchMode(true);
  controls.lock();
  await tick();
  return controls;
}

describe('touch mode detection', () => {
  it('?touch= forces it on or off; anything else detects', () => {
    for (const s of ['?touch=1', '?touch', '?touch=true', '?touch=ON', '?a=1&touch=yes']) expect(readTouchParam(s)).toBe(true);
    for (const s of ['?touch=0', '?touch=false', '?touch=off', '?touch=No']) expect(readTouchParam(s)).toBe(false);
    for (const s of ['', '?seed=1', '?touch=maybe', null, undefined]) expect(readTouchParam(s)).toBe(null);
    expect(readTouchParam(new URLSearchParams('touch=1'))).toBe(true);
  });

  it('a coarse primary pointer, or touch points with no fine pointer (iPadOS says "MacIntel"), is touch; a PC is not', () => {
    expect(touchModeFor({ coarse: true, fine: false, maxTouchPoints: 5 })).toBe(true); // an iPad, a phone
    expect(touchModeFor({ coarse: false, fine: false, maxTouchPoints: 5 })).toBe(true); // iPadOS reporting no coarse pointer
    expect(touchModeFor({ coarse: false, fine: true, maxTouchPoints: 10 })).toBe(false); // a touch-screen laptop
    expect(touchModeFor({ coarse: false, fine: true, maxTouchPoints: 0 })).toBe(false); // a desktop
    expect(touchModeFor({ coarse: false, fine: false, maxTouchPoints: 1 })).toBe(false);
    expect(touchModeFor({ param: true, coarse: false, fine: true, maxTouchPoints: 0 })).toBe(true);
    expect(touchModeFor({ param: false, coarse: true, fine: false, maxTouchPoints: 5 })).toBe(false);
    expect(touchModeFor({ param: null, coarse: true })).toBe(true);
  });

  it('detectTouchMode reads ?touch, matchMedia and maxTouchPoints; anything missing or throwing is absent', () => {
    const win = (search, media, points) => ({
      location: { search },
      matchMedia: (q) => ({ matches: !!media[q] }),
      navigator: { maxTouchPoints: points, platform: 'MacIntel' },
    });
    expect(detectTouchMode(win('', { '(pointer: coarse)': true }, 5))).toBe(true);
    expect(detectTouchMode(win('', {}, 5))).toBe(true);
    expect(detectTouchMode(win('', { '(any-pointer: fine)': true }, 5))).toBe(false);
    expect(detectTouchMode(win('?touch=1', { '(any-pointer: fine)': true }, 0))).toBe(true);
    expect(detectTouchMode(win('?touch=0', { '(pointer: coarse)': true }, 5))).toBe(false);
    expect(detectTouchMode({ matchMedia: () => { throw new Error('no'); }, navigator: {} })).toBe(false);
    expect(detectTouchMode({})).toBe(false);
    expect(detectTouchMode(null)).toBe(false);
  });

  it('a touch device starts at view distance 4, shorter than the desktop default', () => {
    expect(TOUCH_RENDER_DISTANCE).toBe(4);
    expect(TOUCH_RENDER_DISTANCE).toBeLessThan(RENDER_DISTANCE);
  });
});

describe('the stick', () => {
  const R = STICK_RADIUS;

  it('a resting thumb (the dead zone) moves nothing', () => {
    const v = stickVector(R * STICK_DEAD * 0.9, 0);
    expect([v.forward, v.strafe, v.sprint]).toEqual([0, 0, false]);
    expect(stickVector(0, 0).forward).toBe(0);
  });

  it('the push grows from the dead zone to full at the rim; up the screen is forward, right is right', () => {
    const half = stickVector(0, -R / 2);
    const expected = (R / 2 - R * STICK_DEAD) / (R - R * STICK_DEAD);
    expect(half.forward).toBeCloseTo(expected, 9);
    expect(half.strafe).toBeCloseTo(0, 9);
    expect(half.sprint).toBe(false);
    const right = stickVector(R, 0);
    expect(right.strafe).toBeCloseTo(1, 9);
    expect(right.forward).toBeCloseTo(0, 9);
    const back = stickVector(0, R);
    expect(back.forward).toBeCloseTo(-1, 9);
    expect(back.sprint).toBe(false);
  });

  it('pushed ahead to the rim it sprints at full speed; a sideways push to the rim does not', () => {
    const v = stickVector(0, -R);
    expect(v.sprint).toBe(true);
    expect(v.forward).toBeCloseTo(1, 9);
    const diag = stickVector(R * Math.cos(Math.PI / 4), -R * Math.sin(Math.PI / 4)); // 45° off ahead
    expect(diag.sprint).toBe(true);
    expect(Math.hypot(diag.forward, diag.strafe)).toBeCloseTo(1, 9);
    const wide = stickVector(R * Math.cos(Math.PI / 6), -R * Math.sin(Math.PI / 6)); // 60° off ahead
    expect(wide.sprint).toBe(false);
    expect(stickVector(0, -R * 0.8).sprint).toBe(false);
  });

  it('the knob stays on the rim when the thumb goes past it; the output object is reused', () => {
    const out = { forward: 0, strafe: 0, sprint: false, knobX: 0, knobY: 0 };
    const v = stickVector(3 * R, 4 * R, R, out);
    expect(v).toBe(out);
    expect(Math.hypot(v.knobX, v.knobY)).toBeCloseTo(R, 9);
    expect(v.knobX / v.knobY).toBeCloseTo(3 / 4, 9);
    expect(stickVector(Number.NaN, Infinity).forward).toBe(0);
  });
});

describe('the look and the hotbar', () => {
  it('dragging right turns right and dragging up looks up, as the mouse does; no inertia', () => {
    const [yaw, pitch] = lookDelta(100, -40);
    expect(yaw).toBeCloseTo(-100 * TOUCH_LOOK_SENSITIVITY, 12);
    expect(pitch).toBeCloseTo(40 * TOUCH_LOOK_SENSITIVITY, 12);
    expect(lookDelta(0, 0)).toEqual([0, 0]);
    expect(lookDelta(Number.NaN, 0)).toEqual([0, 0]);
    // a 590-px drag across half of an iPad turns about half a turn, neither twitchy nor sluggish
    expect(590 * TOUCH_LOOK_SENSITIVITY).toBeGreaterThan(2.5);
    expect(590 * TOUCH_LOOK_SENSITIVITY).toBeLessThan(3.5);
  });

  it('a tapped hotbar slot is that slot\'s digit key', () => {
    expect(hotbarCode(0)).toBe('Digit1');
    expect(hotbarCode('8')).toBe('Digit9');
    expect(hotbarCode(HOTBAR_SIZE)).toBe(null);
    expect(hotbarCode(-1)).toBe(null);
    expect(hotbarCode('x')).toBe(null);
    expect(hotbarCode(undefined)).toBe(null);
  });
});

describe('the buttons', () => {
  it('every button maps to a game key main reads, a mouse button, the jump, the sneak or a hook', () => {
    expect([...PAD_BUTTONS, ...TOP_BUTTONS].sort()).toEqual(Object.keys(TOUCH_BUTTONS).sort());
    for (const b of Object.values(TOUCH_BUTTONS)) {
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.label.length).toBeLessThanOrEqual(6); // short words, no icons
      if (b.kind === 'key' || b.kind === 'sneak') expect(GAME_KEYS.has(/** @type {string} */ (b.code))).toBe(true);
      if (b.kind === 'mouse') expect([0, 1, 2]).toContain(b.button);
    }
    expect(TOUCH_BUTTONS.dig.button).toBe(0);
    expect(TOUCH_BUTTONS.place.button).toBe(2);
    expect(TOUCH_BUTTONS.act.code).toBe('KeyR');
    expect(TOUCH_BUTTONS.drop.code).toBe('KeyQ');
    expect(TOUCH_BUTTONS.fly.code).toBe('KeyF');
    expect(TOUCH_BUTTONS.pack.code).toBe('KeyE');
    expect(TOUCH_BUTTONS.pause.hook).toBe('onPause');
  });
});

describe('TouchPad drives the controls', () => {
  const W = 1180;
  const ZONE = W * STICK_ZONE;

  it('a thumb on the left takes the stick: analog walking, and sprint at the rim; lifting stops', async () => {
    const controls = await lockedControls();
    const pad = new TouchPad(controls);
    expect(pad.down(1, 150, 600, ZONE)).toBe('stick');
    expect(controls.getInput().forward).toBe(0);
    pad.move(1, 150 + 30, 600);
    const inp = controls.getInput();
    expect(inp.strafe).toBeCloseTo((30 - STICK_RADIUS * STICK_DEAD) / (STICK_RADIUS * (1 - STICK_DEAD)), 9);
    expect(inp.forward).toBeCloseTo(0, 9);
    pad.move(1, 150, 600 - STICK_RADIUS - 20);
    expect(controls.getInput().forward).toBeCloseTo(1, 9);
    expect(controls.getInput().sprint).toBe(true);
    expect(pad.up(1)).toBe('stick');
    expect(controls.getInput().forward).toBe(0);
    expect(controls.getInput().sprint).toBe(false);
  });

  it('a finger on the right drags the look', async () => {
    const controls = await lockedControls();
    const pad = new TouchPad(controls);
    expect(pad.down(2, 900, 400, ZONE)).toBe('look');
    pad.move(2, 950, 380);
    expect(controls.yaw).toBeCloseTo(-50 * TOUCH_LOOK_SENSITIVITY, 12);
    expect(controls.pitch).toBeCloseTo(20 * TOUCH_LOOK_SENSITIVITY, 12);
    pad.move(2, 950, 380); // no movement, no turn
    expect(controls.yaw).toBeCloseTo(-50 * TOUCH_LOOK_SENSITIVITY, 12);
    pad.up(2);
    pad.move(2, 1000, 380); // lifted: ignored
    expect(controls.yaw).toBeCloseTo(-50 * TOUCH_LOOK_SENSITIVITY, 12);
  });

  it('multi-touch: move, look and hold Dig at once', async () => {
    const controls = await lockedControls();
    const pad = new TouchPad(controls);
    expect(pad.down(1, 120, 600, ZONE)).toBe('stick');
    expect(pad.down(2, 800, 300, ZONE)).toBe('look');
    expect(pad.down(3, 1050, 700, ZONE, 'dig')).toBe('button');
    pad.move(1, 120, 600 - 40);
    pad.move(2, 780, 300);
    const inp = controls.getInput();
    expect(inp.forward).toBeGreaterThan(0.5);
    expect(controls.yaw).toBeGreaterThan(0);
    const m = controls.consumeMouse();
    expect([m.left, m.leftPressed]).toEqual([true, true]);
    expect(controls.consumeMouse().left).toBe(true); // still held
    pad.up(3);
    expect(controls.consumeMouse().left).toBe(false);
    expect(controls.getInput().forward).toBeGreaterThan(0.5); // the stick is untouched by the lift
  });

  it('a second thumb on the left looks; a third free finger is ignored', async () => {
    const controls = await lockedControls();
    const pad = new TouchPad(controls);
    expect(pad.down(1, 100, 600, ZONE)).toBe('stick');
    expect(pad.down(2, 200, 300, ZONE)).toBe('look');
    expect(pad.down(3, 900, 300, ZONE)).toBe(null);
    pad.move(3, 1000, 300);
    expect(controls.yaw).toBe(0);
  });

  it('Jump is held; Dig and Place hold mouse buttons; R, Drop, Fly, Pack, View and Chat are key presses', async () => {
    const controls = await lockedControls();
    let paused = 0;
    const pad = new TouchPad(controls, { onPause: () => paused++ });
    const tap = (id, pid = 9) => {
      pad.down(pid, 1000, 700, ZONE, id);
      pad.up(pid);
    };
    pad.down(5, 1100, 700, ZONE, 'jump');
    expect(controls.getInput().jump).toBe(true);
    pad.up(5);
    expect(controls.getInput().jump).toBe(false);
    pad.down(6, 1000, 600, ZONE, 'place');
    expect(controls.consumeMouse().rightPressed).toBe(true);
    pad.up(6);
    expect(controls.consumeMouse().right).toBe(false);
    pad.down(7, 1000, 600, ZONE, 'act');
    expect(controls.isDown('KeyR')).toBe(true); // held R repeats a put / a gulp (§4.4)
    expect(controls.consumePressed('KeyR')).toBe(true);
    pad.up(7);
    expect(controls.isDown('KeyR')).toBe(false);
    tap('drop');
    expect(controls.consumePressed('KeyQ')).toBe(true);
    tap('fly');
    expect(controls.consumeFlyToggle()).toBe(true);
    tap('pack');
    expect(controls.consumePressed('KeyE')).toBe(true);
    tap('view');
    expect(controls.consumePressed('KeyV')).toBe(true);
    tap('chat');
    expect(controls.consumePressed('KeyT')).toBe(true);
    tap('pause');
    expect(paused).toBe(1);
  });

  it('Sneak is a toggle on the ground (it is also the Shift of Shift+R and Shift+Q)', async () => {
    const controls = await lockedControls();
    const pad = new TouchPad(controls);
    pad.down(1, 1000, 600, ZONE, 'sneak');
    pad.up(1);
    expect(pad.sneakOn).toBe(true);
    expect(controls.getInput().sneak).toBe(true);
    expect(controls.isDown('ShiftLeft')).toBe(true);
    pad.down(2, 1000, 600, ZONE, 'drop');
    expect(controls.consumePressed('KeyQ')).toBe(true); // main reads Shift+Q: the whole stack
    pad.up(2);
    pad.down(1, 1000, 600, ZONE, 'sneak');
    pad.up(1);
    expect(pad.sneakOn).toBe(false);
    expect(controls.getInput().sneak).toBe(false);
  });

  it('flying, Sneak is held to go down, and taking off clears the latch', async () => {
    const controls = await lockedControls();
    const pad = new TouchPad(controls);
    pad.down(1, 1000, 600, ZONE, 'sneak');
    pad.up(1);
    expect(controls.getInput().sneak).toBe(true);
    pad.frame(true); // took off
    expect(pad.sneakOn).toBe(false);
    expect(controls.getInput().sneak).toBe(false);
    pad.down(1, 1000, 600, ZONE, 'sneak');
    expect(controls.getInput().sneak).toBe(true);
    pad.up(1);
    expect(controls.getInput().sneak).toBe(false);
    expect(pad.sneakOn).toBe(false);
  });

  it('frame() asserts again what a cleared controls state forgot: the latch, the stick, a held Jump', async () => {
    const controls = await lockedControls();
    const pad = new TouchPad(controls);
    pad.down(1, 1000, 600, ZONE, 'sneak');
    pad.up(1);
    pad.down(2, 100, 600, ZONE);
    pad.move(2, 100, 520);
    pad.down(3, 1100, 700, ZONE, 'jump');
    controls.setEnabled(false); // a menu opened and closed
    controls.setEnabled(true);
    expect(controls.getInput().sneak).toBe(false);
    pad.frame(false);
    const inp = controls.getInput();
    expect([inp.sneak, inp.jump, inp.forward > 0.9]).toEqual([true, true, true]);
  });

  it('a second finger on a held button does nothing; reset() lets go of everything', async () => {
    const controls = await lockedControls();
    const pad = new TouchPad(controls);
    expect(pad.down(1, 1000, 700, ZONE, 'dig')).toBe('button');
    expect(pad.down(2, 1000, 700, ZONE, 'dig')).toBe(null);
    pad.up(2);
    expect(controls.consumeMouse().left).toBe(true);
    pad.down(3, 100, 600, ZONE);
    pad.move(3, 100, 540);
    pad.reset();
    expect(controls.consumeMouse().left).toBe(false);
    expect(controls.getInput().forward).toBe(0);
    expect(pad.pointers.size).toBe(0);
    expect(pad.held.size).toBe(0);
  });

  it('every touch calls onTouch (main wakes a sleeper with it); unknown buttons are ignored', async () => {
    const controls = await lockedControls();
    let touches = 0;
    const pad = new TouchPad(controls, { onTouch: () => touches++ });
    pad.down(1, 100, 100, ZONE);
    pad.down(2, 1000, 100, ZONE, 'nope');
    expect(touches).toBe(2);
    expect(pad.pointers.size).toBe(1);
  });

  it('while the controls are not taking input (a menu), nothing reaches the game', async () => {
    const controls = await lockedControls();
    controls.setEnabled(false);
    const pad = new TouchPad(controls);
    pad.down(1, 1000, 700, ZONE, 'dig');
    pad.down(2, 900, 300, ZONE);
    pad.move(2, 1000, 300);
    expect(controls.consumeMouse().leftPressed).toBe(false);
    expect(controls.yaw).toBe(0);
  });
});

describe('the on-screen controls (DOM)', () => {
  const html = `<canvas id="game-canvas"></canvas><div id="hud"><div id="hotbar">${Array.from({ length: HOTBAR_SIZE }, (_, i) => `<div class="hotbar-slot" data-slot="${i}"></div>`).join('')}</div></div>
    <div id="click-to-play" class="layer hidden"><div class="ctp-text">Click to play</div></div><div id="pack-screen"></div>`;

  async function build(hooks = {}) {
    const doc = documentFromHTML(html);
    const controls = createControls(doc.getElementById('game-canvas'), doc);
    controls.setTouchMode(true);
    controls.lock();
    await tick();
    const ui = createTouchUI(/** @type {any} */ (doc), controls, hooks);
    return { doc, controls, ui };
  }
  const btn = (doc, id) => doc.querySelector(`[data-touch="${id}"]`);
  const down = (el, id, x = 1000, y = 600) => fire(el, 'pointerdown', { pointerId: id, clientX: x, clientY: y });
  const up = (el, id) => fire(el, 'pointerup', { pointerId: id });

  it('builds the layer, the buttons (words, no icons) and Back; marks <html>; "Tap to play"', async () => {
    const { doc } = await build();
    const layer = doc.getElementById('touch-ui');
    expect(layer).not.toBe(null);
    expect(layer.classList.contains('hidden')).toBe(true);
    expect(doc.documentElement.classList.contains('touch')).toBe(true);
    for (const id of [...PAD_BUTTONS, ...TOP_BUTTONS]) {
      const b = btn(doc, id);
      expect(b).not.toBe(null);
      expect(b.querySelector('svg')).toBe(null);
      expect(b.querySelector('canvas')).toBe(null);
    }
    expect(doc.getElementById('touch-back').classList.contains('hidden')).toBe(true);
    expect(doc.querySelector('.ctp-text').textContent).toBe('Tap to play');
  });

  it('shows while playing; labels follow the mode; Fly only in Creative; Back on the picker and the console', async () => {
    const { doc, ui } = await build();
    ui.update({ playing: true, survival: false, flying: false });
    expect(doc.getElementById('touch-ui').classList.contains('hidden')).toBe(false);
    expect(btn(doc, 'pack').textContent).toBe('Blocks');
    expect(btn(doc, 'fly').classList.contains('hidden')).toBe(false);
    ui.update({ playing: true, survival: false, flying: true });
    expect(btn(doc, 'fly').classList.contains('on')).toBe(true);
    expect(btn(doc, 'sneak').textContent).toBe('Down');
    ui.update({ playing: true, survival: true, flying: false });
    expect(btn(doc, 'pack').textContent).toBe('Pack');
    expect(btn(doc, 'fly').classList.contains('hidden')).toBe(true);
    expect(btn(doc, 'sneak').textContent).toBe('Sneak');
    ui.update({ playing: false, back: true });
    expect(doc.getElementById('touch-ui').classList.contains('hidden')).toBe(true);
    expect(doc.getElementById('touch-back').classList.contains('hidden')).toBe(false);
  });

  it('pointer events reach the pad: a held Dig shows pressed and holds the left button', async () => {
    const { doc, controls, ui } = await build();
    ui.update({ playing: true, survival: true });
    const dig = btn(doc, 'dig');
    down(dig, 4);
    expect(dig.classList.contains('pressed')).toBe(true);
    expect(controls.consumeMouse().leftPressed).toBe(true);
    up(dig, 4);
    expect(dig.classList.contains('pressed')).toBe(false);
    expect(controls.consumeMouse().left).toBe(false);
  });

  it('the stick appears where the thumb lands and follows it; the look turns the view', async () => {
    const { doc, controls, ui } = await build();
    ui.update({ playing: true, survival: true });
    const layer = doc.getElementById('touch-ui');
    const stick = doc.querySelector('.touch-stick');
    down(layer, 1, 200, 500);
    expect(stick.classList.contains('idle')).toBe(false);
    expect(stick.style.left).toBe('200px');
    expect(stick.style.top).toBe('500px');
    fire(layer, 'pointermove', { pointerId: 1, clientX: 200, clientY: 420 });
    expect(controls.getInput().forward).toBeCloseTo(1, 9);
    expect(stick.classList.contains('sprint')).toBe(true);
    up(layer, 1);
    expect(stick.classList.contains('idle')).toBe(true);
    down(layer, 2, 1000, 300); // right of the middle (the fake window is 1280 wide)
    fire(layer, 'pointermove', { pointerId: 2, clientX: 1100, clientY: 300 });
    expect(controls.yaw).toBeCloseTo(-100 * TOUCH_LOOK_SENSITIVITY, 12);
  });

  it('tapping a hotbar slot selects it; nothing acts while hidden', async () => {
    const { doc, controls, ui } = await build();
    const slot = doc.querySelector('[data-slot="4"]');
    fire(slot, 'pointerdown', { pointerId: 1 });
    expect(controls.consumePressed('Digit5')).toBe(false); // not playing yet
    ui.update({ playing: true, survival: true });
    fire(slot, 'pointerdown', { pointerId: 1 });
    expect(controls.consumePressed('Digit5')).toBe(true);
    down(btn(doc, 'drop'), 3);
    up(btn(doc, 'drop'), 3);
    expect(controls.consumePressed('KeyQ')).toBe(true);
  });

  it('Pause and Back call main; the click after a button\'s tap is swallowed (it would land on what the tap opened)', async () => {
    let paused = 0;
    let backs = 0;
    let touches = 0;
    const { doc, ui } = await build({ onPause: () => paused++, onBack: () => backs++, onTouch: () => touches++ });
    ui.update({ playing: true, survival: true });
    down(btn(doc, 'pause'), 1);
    expect(paused).toBe(1);
    expect(touches).toBe(1);
    up(btn(doc, 'pause'), 1);
    ui.update({ playing: false, back: false });
    const pack = doc.getElementById('pack-screen');
    expect(doc.dispatch({ type: 'click', target: pack })).toBe(false); // swallowed
    expect(doc.dispatch({ type: 'click', target: pack })).toBe(true); // only that one
    ui.update({ playing: false, back: true });
    doc.getElementById('touch-back').click();
    expect(backs).toBe(1);
    // a click on Back is never swallowed, even right after a button's tap whose own click never came
    ui.update({ playing: true, survival: false });
    down(btn(doc, 'pack'), 2);
    up(btn(doc, 'pack'), 2);
    ui.update({ playing: false, back: true });
    expect(doc.dispatch({ type: 'click', target: doc.getElementById('touch-back') })).toBe(true);
  });

  it('hiding lets go of held buttons; dispose removes everything', async () => {
    const { doc, controls, ui } = await build();
    ui.update({ playing: true, survival: true });
    down(btn(doc, 'dig'), 4);
    ui.update({ playing: false });
    expect(controls.consumeMouse().left).toBe(false);
    expect(btn(doc, 'dig').classList.contains('pressed')).toBe(false);
    ui.dispose();
    expect(doc.getElementById('touch-ui')).toBe(null);
    expect(doc.getElementById('touch-back')).toBe(null);
    expect(doc.documentElement.classList.contains('touch')).toBe(false);
    expect(doc.querySelector('.ctp-text').textContent).toBe('Click to play');
    expect(doc.getElementById('hotbar').listenerCount('pointerdown')).toBe(0);
  });
});

describe('the page on an iPad', () => {
  const index = read('index.html');
  const css = read('src/styles.css');

  it('index.html: no zoom, full screen under the notch, a home-screen web app with a manifest and an icon', () => {
    expect(index).toContain('content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"');
    expect(index).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');
    expect(index).toMatch(/<meta name="apple-mobile-web-app-status-bar-style" content="[\w-]+">/);
    expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(index).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
  });

  it('the manifest opens full screen in landscape; its icons exist as PNGs', () => {
    const m = JSON.parse(read('public/manifest.webmanifest'));
    expect(m.display).toBe('fullscreen');
    expect(m.orientation).toBe('landscape');
    expect(m.icons.length).toBeGreaterThan(0);
    const png = (p) => readFileSync(fileURLToPath(new URL(`../../public/${p}`, import.meta.url)));
    for (const icon of m.icons) expect([...png(icon.src).subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
    const apple = png('apple-touch-icon.png');
    expect(apple.readUInt32BE(16)).toBe(180);
  });

  it('styles: the canvas and the touch layer never scroll or zoom; buttons are big enough for a thumb; safe areas', () => {
    expect(css).toMatch(/#game-canvas\{touch-action:none/);
    expect(css).toMatch(/#touch-ui\{[^}]*touch-action:none/);
    const btnRule = /\.touch-btn\{([^}]*)\}/.exec(css)[1];
    expect(Number(/width:(\d+)px/.exec(btnRule)[1])).toBeGreaterThanOrEqual(64);
    expect(Number(/height:(\d+)px/.exec(btnRule)[1])).toBeGreaterThanOrEqual(64);
    for (const id of ['jump', 'dig', 'place']) {
      const m = new RegExp(`\\.tb-${id}\\{[^}]*width:(\\d+)px`).exec(css);
      expect(Number(m[1])).toBeGreaterThanOrEqual(64);
    }
    expect(css).toMatch(/\.touch-pad\{[^}]*env\(safe-area-inset-right/);
    expect(css).toMatch(/\.touch-top\{[^}]*env\(safe-area-inset-top/);
    expect(css).toMatch(/html\.touch #hotbar\{pointer-events:auto/);
  });
});
