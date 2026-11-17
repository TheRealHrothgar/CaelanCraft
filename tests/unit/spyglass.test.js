// Tests for the Spyglass (CONTRACTS §103): whether one is carried (Survival and Creative), the narrowed field of view and
// the slowed look, the hold, the wheel and the kept zoom, the console's `zoom` (on a server too), the touch Zoom button and
// the hints per screen, the eyepiece under the touch controls and the HUD, Place on a latched control, and main's wiring
// (read from the source: main needs a browser).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Spyglass, carriesSpyglass, zoomedFov, zoomLookScale, wheelZoom, parseZoomArg, zoomLabel, glassPlace, glassHint,
  serverZoomLine, SPYGLASS_KEY, ZOOM_KEY, ZOOM_LEVELS, ZOOM_DEFAULT, ZOOM_EASE, SPYGLASS_NEEDED,
} from '../../src/spyglass.js';
import { ControlLatch, rightMouseStep } from '../../src/main.js';
import { executeCommand, parseLine, COMMANDS } from '../../src/commands.js';
import { createControls, GAME_KEYS } from '../../src/controls.js';
import { TOUCH_BUTTONS, TOP_BUTTONS, topButtonShown, createTouchUI, touchWords } from '../../src/touchControls.js';
import { createHUD } from '../../src/hud.js';
import { Pack } from '../../src/inventory.js';
import { MOUSE_SENSITIVITY, FOV, HOTBAR_SIZE } from '../../src/config.js';
import { DEFAULT_HOTBAR } from '../../src/blocks.js';
import { getItem } from '../../src/items.js';
import { isItemPick, normalizePick } from '../../src/creativePicks.js';
import { parseParams, readZoomParam } from '../../src/diagnostics.js';
import { documentFromHTML, fire } from '../helpers/fakeDom.js';

const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const DT = 1 / 60;

/** `seconds` of frames. @param {Spyglass} g */
function frames(g, seconds, input) {
  for (let t = 0; t < seconds; t += DT) g.step(DT, input);
}

describe('§103 the gate: a Spyglass carried', () => {
  it('Survival: anywhere in the pack; Creative: an item pick on the Creative hotbar', () => {
    const pack = new Pack();
    expect(carriesSpyglass({ survival: true, count: (k) => pack.count(k) })).toBe(false);
    pack.give('spyglass', 1);
    expect(pack.count(SPYGLASS_KEY)).toBe(1);
    expect(carriesSpyglass({ survival: true, count: (k) => pack.count(k) })).toBe(true);
    // a Creative hotbar holds picks: block ids and item keys (§98); a Spyglass among them is carried
    const hotbar = [...DEFAULT_HOTBAR];
    expect(carriesSpyglass({ survival: false, hotbar })).toBe(false);
    hotbar[4] = 'spyglass';
    expect(isItemPick('spyglass')).toBe(true);
    expect(normalizePick('spyglass')).toBe('spyglass');
    expect(carriesSpyglass({ survival: false, hotbar })).toBe(true);
    // the Creative hotbar does not count in Survival, nor the pack in Creative
    expect(carriesSpyglass({ survival: true, count: () => 0, hotbar })).toBe(false);
    expect(carriesSpyglass({ survival: false, count: () => 1, hotbar: [] })).toBe(false);
    expect(carriesSpyglass(/** @type {*} */ (null))).toBe(false);
    expect(getItem(SPYGLASS_KEY)?.stack).toBe(1);
  });

  it('not carried, nothing lasts: neither Z held nor the kept zoom', () => {
    const g = new Spyglass();
    g.step(DT, { carried: false, held: true });
    expect(g.looking).toBe(false);
    g.lock(8);
    g.step(DT, { carried: false, held: false });
    expect(g.locked).toBe(false);
    frames(g, 1, { carried: false, held: true });
    expect(g.shown).toBe(1);
    expect(g.handHidden).toBe(false);
  });
});

describe('§103 the view through it: the field of view and the look', () => {
  it('zoomedFov: everything `zoom` times bigger — the tangent of the half-angle divided by the power', () => {
    for (const fov of [FOV, 60, 90]) {
      for (const z of ZOOM_LEVELS) {
        const f = zoomedFov(fov, z);
        expect(Math.tan((f * Math.PI) / 360), `${fov} ${z}`).toBeCloseTo(Math.tan((fov * Math.PI) / 360) / z, 12);
        expect(f).toBeLessThan(fov);
      }
      expect(zoomedFov(fov, 1)).toBe(fov);
      expect(zoomedFov(fov, 0.5)).toBe(fov);
    }
    expect(zoomedFov(70, 4)).toBeCloseTo(19.86, 2);
    expect(zoomedFov(70, 8)).toBeLessThan(zoomedFov(70, 4));
  });

  it('the look slows by the power: 1 / zoom', () => {
    expect(ZOOM_LEVELS.map(zoomLookScale)).toEqual([0.5, 0.25, 0.125]);
    expect(zoomLookScale(1)).toBe(1);
    expect(zoomLookScale(NaN)).toBe(1);
  });

  it('held, the view narrows smoothly to the power (default 4×), the look slows with it, the eyepiece darkens, the hand goes', () => {
    expect(ZOOM_DEFAULT).toBe(4);
    const g = new Spyglass();
    expect([g.zoom, g.shown, g.fov(FOV), g.lookScale(), g.vignette(), g.handHidden]).toEqual([4, 1, FOV, 1, 0, false]);
    g.step(DT, { carried: true, held: true });
    expect(g.looking).toBe(true);
    expect(g.handHidden).toBe(true); // at once
    expect(g.shown).toBeGreaterThan(1);
    expect(g.shown).toBeLessThan(4); // smoothly, not a jump
    const fovs = [];
    for (let i = 0; i < 30; i++) {
      g.step(DT, { carried: true, held: true });
      fovs.push(g.fov(FOV));
    }
    for (let i = 1; i < fovs.length; i++) expect(fovs[i]).toBeLessThanOrEqual(fovs[i - 1]); // narrowing all the way
    frames(g, 1, { carried: true, held: true });
    expect(g.shown).toBe(4);
    expect(g.fov(FOV)).toBeCloseTo(zoomedFov(FOV, 4), 12);
    expect(g.lookScale()).toBe(0.25);
    expect(g.vignette()).toBe(1);
    // let go: back to the plain view, and the hand
    g.step(DT, { carried: true, held: false });
    expect(g.looking).toBe(false);
    expect(g.handHidden).toBe(true); // still closing up
    frames(g, 1, { carried: true, held: false });
    expect([g.shown, g.fov(FOV), g.lookScale(), g.vignette(), g.handHidden]).toEqual([1, FOV, 1, 0, false]);
    expect(ZOOM_EASE).toBeGreaterThan(5); // settled well inside a second
  });

  it('the wheel while looking: up is closer, down farther, 2× 4× 8×, stopping at the ends; not looking it is the hotbar\'s', () => {
    expect(wheelZoom(4, -1)).toBe(8);
    expect(wheelZoom(4, 1)).toBe(2);
    expect(wheelZoom(8, -1)).toBe(8);
    expect(wheelZoom(2, 3)).toBe(2);
    expect(wheelZoom(2, -2)).toBe(8);
    expect(wheelZoom(3, 0)).toBe(4); // not a level: the default
    const g = new Spyglass();
    expect(g.wheel(-1)).toBe(false); // not looking: the hotbar takes it
    expect(g.zoom).toBe(4);
    g.step(DT, { carried: true, held: true });
    expect(g.wheel(-1)).toBe(true);
    expect(g.zoom).toBe(8);
    frames(g, 1, { carried: true, held: true });
    expect(g.lookScale()).toBe(0.125);
    expect(g.wheel(1)).toBe(true);
    expect(g.wheel(1)).toBe(true);
    expect(g.zoom).toBe(2);
    expect(g.wheel(0)).toBe(false);
  });

  it('kept up (the zoom command, the Zoom button): it stays with nothing held until unlocked; toggle; reset', () => {
    const g = new Spyglass();
    expect(g.lock(8)).toBe(8);
    frames(g, 1, { carried: true, held: false });
    expect(g.looking).toBe(true);
    expect(g.shown).toBe(8);
    expect(g.lock(null)).toBe(8); // the power it has
    expect(g.lock(/** @type {*} */ (3))).toBe(8); // not a power: unchanged
    expect(g.unlock()).toBe(true);
    expect(g.unlock()).toBe(false);
    expect(g.toggle()).toBe(true);
    expect(g.toggle()).toBe(false);
    g.lock(8);
    frames(g, 1, { carried: true, held: true });
    g.reset(); // leaving a world (main's resetSpyglass): at rest at once, at the power it starts at
    expect([g.locked, g.held, g.shown, g.zoom, g.lookScale(), g.vignette(), g.handHidden]).toEqual([false, false, 1, ZOOM_DEFAULT, 1, 0, false]);
  });

  it('the tablet\'s Zoom button (no wheel there): up at 2×, a tap a power closer, down after 8×', () => {
    const g = new Spyglass();
    const taps = [];
    for (let i = 0; i < 5; i++) {
      taps.push(g.button());
      frames(g, 0.5, { carried: true, held: false });
      taps.push(g.locked ? g.shown : 0);
    }
    expect(taps).toEqual([2, 2, 4, 4, 8, 8, 0, 0, 2, 2]); // and round again
    // kept up by the console at 8×: the next tap puts it down
    g.unlock();
    g.lock(8);
    expect(g.button()).toBe(0);
    expect(g.locked).toBe(false);
  });
});

describe('§103 Z and the look in controls.js', () => {
  it('Z is a game key; setLookScale slows the mouse look and the touch look, clamped', () => {
    expect(ZOOM_KEY).toBe('KeyZ');
    expect(GAME_KEYS.has(ZOOM_KEY)).toBe(true);
    const doc = /** @type {any} */ (new EventTarget());
    const canvas = new EventTarget();
    doc.pointerLockElement = canvas;
    const controls = createControls(canvas, doc);
    const move = (dx) => {
      const e = new Event('mousemove');
      Object.assign(e, { movementX: dx, movementY: 0 });
      doc.dispatchEvent(e);
    };
    expect(controls.lookScale).toBe(1);
    move(100);
    expect(controls.yaw).toBeCloseTo(-100 * MOUSE_SENSITIVITY, 12);
    controls.yaw = 0;
    controls.setLookScale(0.25);
    expect(controls.lookScale).toBe(0.25);
    move(100);
    expect(controls.yaw).toBeCloseTo(-25 * MOUSE_SENSITIVITY, 12);
    controls.yaw = 0;
    controls.virtualLook(0.4, 0);
    expect(controls.yaw).toBeCloseTo(0.1, 12);
    controls.setLookScale(5);
    expect(controls.lookScale).toBe(1);
    controls.setLookScale(0);
    expect(controls.lookScale).toBe(0.01);
    controls.setLookScale(NaN);
    expect(controls.lookScale).toBe(1);
    controls.dispose();
  });
});

describe('§103 the console: zoom [2|4|8|off]', () => {
  const exec = (ctx, line) => {
    const cmd = parseLine(line);
    return 'name' in /** @type {*} */ (cmd) ? executeCommand(/** @type {*} */ (cmd), /** @type {*} */ (ctx)) : cmd;
  };
  /** A context whose Spyglass is `carried` (a live Spyglass behind it, as main's). */
  const ctxWith = (carried) => {
    const g = new Spyglass();
    return { g, ctx: { spyglass: { carried: () => carried, lock: (z) => g.lock(z), unlock: () => g.unlock() } } };
  };

  it('is listed in help, console only, its usage `zoom [2|4|8|off]`', () => {
    const spec = COMMANDS.find((c) => c.name === 'zoom');
    expect(spec).toMatchObject({ usage: 'zoom [2|4|8|off]', args: ['choice:2|4|8|off'], min: 0, consoleOnly: true });
    expect(exec({}, 'help').message).toContain(`${spec.usage}  — ${spec.summary}`);
    expect(exec({}, 'help zoom').message).toContain('Spyglass');
  });

  it('with a Spyglass: keeps it up at that power (alone: the power it has); off puts it down', () => {
    const { g, ctx } = ctxWith(true);
    expect(exec(ctx, 'zoom 8')).toEqual({ ok: true, message: 'looking through the Spyglass at 8×: zoom off, Esc or a menu ends it; the wheel changes it' });
    expect(g.locked).toBe(true);
    expect(g.zoom).toBe(8);
    expect(exec(ctx, 'zoom').message).toContain('8×');
    expect(exec(ctx, 'ZOOM 2').ok).toBe(true);
    expect(g.zoom).toBe(2);
    expect(exec(ctx, 'zoom off')).toEqual({ ok: true, message: 'zoom off' });
    expect(g.locked).toBe(false);
    expect(exec(ctx, 'zoom off')).toEqual({ ok: true, message: 'the zoom is already off' });
  });

  it('without one it answers "You need a spyglass" and nothing changes; a bad power and a rune script are refused', () => {
    const { g, ctx } = ctxWith(false);
    for (const line of ['zoom', 'zoom 4']) {
      const res = exec(ctx, line);
      expect(res.ok, line).toBe(false);
      expect(res.message, line).toBe(`zoom: ${SPYGLASS_NEEDED} — usage: zoom [2|4|8|off]`);
    }
    expect(SPYGLASS_NEEDED).toBe('You need a spyglass');
    expect(g.locked).toBe(false);
    expect(exec(ctx, 'zoom off').ok).toBe(true); // putting nothing down is harmless
    expect(exec(ctx, 'zoom 3').message).toBe('zoom: expected one of 2, 4, 8, off, got "3" — usage: zoom [2|4|8|off]');
    expect(exec({ ...ctx, running: {} }, 'zoom 4').message).toMatch(/only valid in the console/);
    expect(exec({}, 'zoom 4').message).toMatch(/nothing to look through/);
  });

  it('parseZoomArg and zoomLabel', () => {
    expect([parseZoomArg('2'), parseZoomArg('4x'), parseZoomArg('8×'), parseZoomArg('OFF'), parseZoomArg(undefined), parseZoomArg('')])
      .toEqual([{ zoom: 2 }, { zoom: 4 }, { zoom: 8 }, { off: true }, { zoom: null }, { zoom: null }]);
    expect([parseZoomArg('3'), parseZoomArg('far')]).toEqual([null, null]);
    expect(zoomLabel(4)).toBe('4×');
  });
});

describe('§103 the touch Zoom button', () => {
  it('in the top bar, a hook; shown only while a Spyglass is carried', () => {
    expect(TOUCH_BUTTONS.zoom).toEqual({ label: 'Zoom', kind: 'hook', hook: 'onZoom' });
    expect(TOP_BUTTONS[TOP_BUTTONS.length - 1]).toBe('zoom');
    expect(topButtonShown('zoom', { playing: true, zoom: true })).toBe(true);
    expect(topButtonShown('zoom', { playing: true, zoom: false })).toBe(false);
    expect(topButtonShown('zoom', { playing: true })).toBe(false);
    expect(topButtonShown('zoom', null)).toBe(false);
    for (const id of TOP_BUTTONS.filter((b) => b !== 'zoom')) expect(topButtonShown(id, { playing: true }), id).toBe(true);
  });

  it('on the page: hidden without a Spyglass, shown with one, lit while kept up; a tap calls onZoom', async () => {
    const html = `<canvas id="game-canvas"></canvas><div id="hud"><div id="hotbar">${Array.from({ length: HOTBAR_SIZE }, (_, i) => `<div class="hotbar-slot" data-slot="${i}"></div>`).join('')}</div></div>
      <div id="click-to-play" class="layer hidden"><div class="ctp-text">Click to play</div></div>`;
    const doc = documentFromHTML(html);
    const controls = createControls(doc.getElementById('game-canvas'), doc);
    controls.setTouchMode(true);
    controls.lock();
    await tick();
    let zooms = 0;
    const ui = createTouchUI(/** @type {any} */ (doc), controls, { onZoom: () => zooms++ });
    const zoom = /** @type {any} */ (doc.querySelector('[data-touch="zoom"]'));
    expect(zoom.textContent).toBe('Zoom');
    ui.update({ playing: true, survival: true });
    expect(zoom.classList.contains('hidden')).toBe(true);
    ui.update({ playing: true, survival: true, zoom: true });
    expect(zoom.classList.contains('hidden')).toBe(false);
    expect(zoom.classList.contains('on')).toBe(false);
    fire(zoom, 'pointerdown', { pointerId: 3, clientX: 200, clientY: 20 });
    fire(zoom, 'pointerup', { pointerId: 3 });
    expect(zooms).toBe(1);
    ui.update({ playing: true, survival: true, zoom: true, zoomOn: true });
    expect(zoom.classList.contains('on')).toBe(true);
    expect(zoom.classList.contains('hidden')).toBe(false); // the button that puts the glass down is there while it is up
    ui.update({ playing: true, survival: false, zoom: false });
    expect(zoom.classList.contains('hidden')).toBe(true);
    ui.dispose();
  });

  it('a hint for the keyboard names the Zoom button on a tablet', () => {
    expect(touchWords('Spyglass · Hold RMB or Z to look through it')).toBe('Spyglass · Hold Place, or tap Zoom, to look through it');
    expect(read('src/main.js')).toContain('return glassHint(spyglass, touchOn);');
  });

  it('the hints say what each screen has: the wheel on a keyboard, the Zoom button on a tablet (never a wheel there)', () => {
    const g = new Spyglass();
    expect(glassHint(g, false)).toBe('Spyglass · Hold RMB or Z to look through it');
    expect(glassHint(g, true)).toBe('Spyglass · Hold RMB or Z to look through it'); // touchWords rewrites it
    g.step(DT, { carried: true, held: true });
    expect(glassHint(g, false)).toBe('Spyglass 4× · scroll: closer or farther');
    expect(glassHint(g, true)).toBe('Spyglass 4×'); // Place holds it: no wheel to name
    g.step(DT, { carried: true, held: false });
    g.button();
    expect(glassHint(g, true)).toBe('Spyglass 2× · tap Zoom: closer');
    g.button();
    g.button();
    expect(glassHint(g, true)).toBe('Spyglass 8× · tap Zoom to put it down');
    for (const touch of [true, false]) {
      for (const z of ZOOM_LEVELS) {
        g.lock(z);
        const words = touchWords(glassHint(g, touch));
        expect(/scroll|wheel|\bZ\b|RMB/.test(words), `${touch} ${z}`).toBe(!touch);
      }
    }
  });

  it('the purpose line names no key (it shows in the pack and the picker on a tablet too)', () => {
    const purpose = read('src/purpose.js');
    const line = /spyglass: '([^']*)'/.exec(purpose)?.[1] ?? '';
    expect(line).toBe('Carry it, and look through it to see far.');
    expect(/\b(Z|RMB|LMB|scroll|wheel)\b/.test(line)).toBe(false);
  });

  it('main tells it: zoom while a Spyglass is carried, zoomOn while the zoom is kept up; the tap toggles it', () => {
    const main = read('src/main.js');
    expect(main).toContain('touchView.zoom = spyglassCarried();');
    expect(main).toContain('touchView.zoomOn = spyglass.locked;');
    expect(main).toMatch(/onZoom: \(\) => \{\s*if \(spyglassCarried\(\)\) spyglass\.button\(\);/);
  });
});

describe('§103 the eyepiece on the HUD', () => {
  const html = read('index.html');
  it('a round dark vignette under the crosshair and the hints, its power at the foot; hidden at nothing', () => {
    const doc = documentFromHTML(html);
    const hud = createHUD(/** @type {any} */ (doc), /** @type {any} */ ({ width: 256, height: 256 }));
    const el = /** @type {any} */ (doc.getElementById('spyglass-overlay'));
    const hudEl = /** @type {any} */ (doc.getElementById('hud'));
    expect(el).not.toBe(null);
    // its own layer, just before #hud: not inside the HUD (whose z-index would lift it over the touch controls)
    expect(el.parentNode).toBe(hudEl.parentNode);
    expect(hudEl.contains(el)).toBe(false);
    const sibs = Array.from(el.parentNode.childNodes);
    expect(sibs.indexOf(el)).toBe(sibs.indexOf(hudEl) - 1);
    expect(el.classList.contains('hidden')).toBe(true);
    hud.setSpyglass({ amount: 1, zoom: 4 });
    expect(el.classList.contains('hidden')).toBe(false);
    expect(el.style.opacity).toBe('1');
    expect(el.querySelector('.spyglass-power').textContent).toBe('4×');
    hud.setSpyglass({ amount: 0.5, zoom: 8 });
    expect(el.style.opacity).toBe('0.5');
    expect(el.querySelector('.spyglass-power').textContent).toBe('8×');
    hud.setSpyglass(null);
    expect(el.classList.contains('hidden')).toBe(true);
    // a round eyepiece in the stylesheet
    const css = read('src/styles.css');
    expect(css).toMatch(/#spyglass-overlay\{[^}]*radial-gradient\(circle closest-side/);
    expect(css).toMatch(/#spyglass-overlay\{[^}]*pointer-events:none/);
  });

  it('on a tablet it lies under the touch controls: the top bar (Menu, the Zoom button), the stick and the buttons stay in sight', async () => {
    const css = read('src/styles.css');
    const z = (sel) => Number(new RegExp(`(?:^|\\n)${sel}\\{[^}]*z-index:(\\d+)`).exec(css)?.[1]);
    expect(css).toMatch(/#spyglass-overlay\{position:fixed;inset:0;/);
    expect(z('#spyglass-overlay')).toBeLessThan(z('#touch-ui'));
    expect(z('#touch-ui')).toBeLessThan(z('#hud')); // and the crosshair, the hints and the hotbar over both
    expect(z('#spyglass-overlay')).toBeGreaterThan(0); // over the canvas (z 0)
    // on the page: the eyepiece is in no layer that holds the touch controls or the HUD
    const doc = documentFromHTML(html);
    const hud = createHUD(/** @type {any} */ (doc), /** @type {any} */ ({ width: 256, height: 256 }));
    const controls = createControls(doc.getElementById('game-canvas'), doc);
    controls.setTouchMode(true);
    controls.lock();
    await tick();
    const ui = createTouchUI(/** @type {any} */ (doc), controls, {});
    hud.setSpyglass({ amount: 1, zoom: 4 });
    ui.update({ playing: true, survival: true, zoom: true, zoomOn: true });
    const el = /** @type {any} */ (doc.getElementById('spyglass-overlay'));
    const touchEl = /** @type {any} */ (doc.getElementById('touch-ui'));
    const zoomBtn = /** @type {any} */ (doc.querySelector('[data-touch="zoom"]'));
    expect(el.classList.contains('hidden')).toBe(false);
    expect(touchEl.contains(el) || el.contains(touchEl)).toBe(false);
    expect(doc.getElementById('hud').contains(el)).toBe(false);
    expect(zoomBtn.classList.contains('hidden')).toBe(false);
    ui.dispose();
    controls.dispose();
  });
});

describe('§103 the screenshot aid: ?zoom=2|4|8', () => {
  it('parses the power; main looks through a carried Spyglass at it once the world has loaded', () => {
    expect([parseParams('?zoom=4').zoom, parseParams('?zoom=8x').zoom, parseParams('?zoom=2×').zoom]).toEqual([4, 8, 2]);
    expect([parseParams('?zoom=3').zoom, parseParams('?zoom=off').zoom, parseParams('').zoom]).toEqual([null, null, null]);
    expect(readZoomParam(new URLSearchParams('zoom=8'))).toBe(8);
    expect(read('src/main.js')).toContain('if (params.zoom && spyglassCarried()) spyglass.lock(params.zoom);');
  });
});

describe('§103 main\'s wiring (read from the source)', () => {
  const main = read('src/main.js');
  it('Z held, or Place with the glass in hand, looks; the view, the look, the hand and the eyepiece follow it', () => {
    expect(main).toContain('controls.isDown(ZOOM_KEY) || (glassPlaceHeld && heldItemKey() === SPYGLASS_KEY)');
    expect(main).toContain('spyglass.step(dt, { carried: spyglassCarried(), held });');
    expect(main).toContain('controls.setLookScale(spyglass.lookScale());');
    expect(main).toContain('renderer.setFov(spyglass.fov(fov) + camFx.fov);');
    expect(main).toContain('!spyglass.handHidden');
    expect(main).toContain("hud.setSpyglass(dark > 0 ? { amount: dark, zoom: spyglass.zoom } : null);");
    // the wheel steps the power while it is up; else it picks the slot
    expect(main).toContain('if (mouse.wheel !== 0 && !spyglass.wheel(mouse.wheel)) selectSlot(wheelSlot(selected, mouse.wheel));');
    // Esc or a menu puts the kept zoom down; the console (where zoom is typed) keeps it
    expect(main).toContain('if (s !== STATE.PLAYING && s !== STATE.CONSOLE) spyglass.unlock();');
    // the console's zoom reaches it
    expect(main).toContain('spyglass: { carried: () => spyglassCarried(), lock: (z) => spyglass.lock(z), unlock: () => spyglass.unlock() },');
    // Survival: anywhere in the pack; Creative: the Creative hotbar
    expect(main).toContain('carriesSpyglass({ survival: survival.inSurvival, count: (k) => pack.count(k), hotbar })');
  });

  it('leaving a world puts the glass down at once: no eyepiece, slowed look or last power in the next world', () => {
    const quit = /function quitToTitle\([^)]*\) \{([\s\S]*?)\n {2}\}\n/.exec(main)?.[1] ?? '';
    expect(quit).toContain('resetSpyglass();');
    const reset = /function resetSpyglass\(\) \{([\s\S]*?)\n {2}\}\n/.exec(main)?.[1] ?? '';
    for (const call of ['spyglass.reset();', 'glassPlaceHeld = false;', 'controls.setLookScale(1);', 'hud.setSpyglass(null);']) {
      expect(reset, call).toContain(call);
    }
  });

  it('Place with the glass in hand goes through glassPlace, told when the control latch holds a control', () => {
    const step = /function glassPlaceStep\(mouse\) \{([\s\S]*?)\n {2}\}\n/.exec(main)?.[1] ?? '';
    expect(step).toMatch(/glassPlace\(\{[^}]*latched: controlLatch\.on/);
    expect(step).toContain('glassPlaceHeld = g.held;');
    expect(step).toContain('return g.mine;');
    // the Creative frame: the glass first, then the draw, then the control latch and placing
    expect(main).toContain('if (!glassPlaceStep(mouse) && !drawStep(mouse, dt)) rightMouseStep(controlLatch, mouse, hit, shift, dt, latchEnv);');
  });
});

describe('§103 Place on a circuit control with the glass in hand (Creative): the control keeps the hold', () => {
  const PRESS = { rightPressed: true, right: true };
  const HELD = { rightPressed: false, right: true };
  const UP = { rightPressed: false, right: false };

  it('glassPlace: not in hand, on a control press, or while the latch holds one, Place is not the glass\'s', () => {
    const base = { inHand: true, rightPressed: false, right: true, control: false, latched: false };
    expect(glassPlace(base)).toEqual({ mine: true, held: true });
    expect(glassPlace({ ...base, right: false })).toEqual({ mine: true, held: false });
    expect(glassPlace({ ...base, inHand: false })).toEqual({ mine: false, held: false });
    expect(glassPlace({ ...base, rightPressed: true, control: true })).toEqual({ mine: false, held: false });
    expect(glassPlace({ ...base, rightPressed: true })).toEqual({ mine: true, held: true }); // a press on nothing: it looks
    expect(glassPlace({ ...base, latched: true })).toEqual({ mine: false, held: false });
  });

  it('holding Place on a Push Button keeps it pressed every frame, and the glass never comes up', () => {
    // main's Creative frame: `if (!glassPlaceStep(mouse) && !drawStep(mouse, dt)) rightMouseStep(controlLatch, …)`; with
    // the Spyglass in hand drawStep draws nothing, so it is false
    const latch = new ControlLatch();
    const g = new Spyglass();
    const button = { q: 3, y: 64, r: 4, blockId: 1, face: 0 };
    const calls = { operate: 0, hold: 0, place: 0 };
    const env = { isControl: () => true, operate: () => calls.operate++, hold: () => calls.hold++, place: () => calls.place++ };
    const frame = (mouse) => {
      const p = glassPlace({ inHand: true, rightPressed: mouse.rightPressed, right: mouse.right, control: mouse.rightPressed, latched: latch.on });
      if (!p.mine) rightMouseStep(latch, mouse, button, false, DT, env);
      else if (!mouse.right) latch.release();
      g.step(DT, { carried: true, held: p.held });
    };
    frame(PRESS);
    expect(calls.operate).toBe(1);
    expect(latch.on).toBe(true);
    for (let i = 0; i < 30; i++) frame(HELD);
    expect(calls.hold).toBe(30); // circuits.hold every held frame: the button stays pressed
    expect(g.looking).toBe(false); // and the view never zoomed
    expect(g.shown).toBe(1);
    frame(UP);
    expect(latch.on).toBe(false);
    expect(calls.place).toBe(0);
    // off the control, Place held looks through it as before
    const away = glassPlace({ inHand: true, rightPressed: true, right: true, control: false, latched: latch.on });
    expect(away).toEqual({ mine: true, held: true });
  });
});

describe('§103 the zoom command on a server', () => {
  it('serverZoomLine: /zoom always runs here; without the slash a whole zoom command; anything else is said', () => {
    expect(serverZoomLine('zoom 4')).toBe('zoom 4');
    expect(serverZoomLine('  Zoom 8x ')).toBe('zoom 8x');
    expect(serverZoomLine('zoom')).toBe('zoom');
    expect(serverZoomLine('zoom off')).toBe('zoom off');
    expect(serverZoomLine('/zoom 4')).toBe('zoom 4');
    expect(serverZoomLine('/zoom 3')).toBe('zoom 3'); // its mistake gets the usage, not the chat
    expect(serverZoomLine('/ZOOM')).toBe('zoom');
    for (const chat of ['zoom zoom!', 'zoom in on that', 'zoomed', 'hello', '/give rock', 'look zoom 4', '', 'zoom 3']) {
      expect(serverZoomLine(chat), chat).toBe(null);
    }
  });

  it('runs on a server as in a world of one: the line reaches the command (with and without a Spyglass)', () => {
    const run = (carried, line) => {
      const g = new Spyglass();
      const ctx = { spyglass: { carried: () => carried, lock: (z) => g.lock(z), unlock: () => g.unlock() } };
      const local = serverZoomLine(line);
      const cmd = parseLine(/** @type {string} */ (local));
      return { g, res: executeCommand(/** @type {*} */ (cmd), /** @type {*} */ (ctx)) };
    };
    const a = run(true, '/zoom 8');
    expect(a.res.ok).toBe(true);
    expect([a.g.locked, a.g.zoom]).toEqual([true, 8]);
    const b = run(false, 'zoom 4');
    expect(b.res).toEqual({ ok: false, message: `zoom: ${SPYGLASS_NEEDED} — usage: zoom [2|4|8|off]` });
  });

  it('main: on a server the zoom line runs here before the chat and the "Commands are off" refusal', () => {
    const main = read('src/main.js');
    const onLine = /onLine: \(line\) => \{([\s\S]*?)\n {6}\},/.exec(main)?.[1] ?? '';
    const local = onLine.indexOf('const local = serverZoomLine(line);');
    expect(local).toBeGreaterThan(0);
    expect(onLine).toContain('if (local !== null) return runner ? runner.runConsoleLine(local)');
    expect(local).toBeLessThan(onLine.indexOf("'Commands are off on a server'"));
    expect(local).toBeLessThan(onLine.indexOf('net.sendChat(line)'));
    expect(onLine.indexOf('if (net)')).toBeLessThan(local);
  });
});
