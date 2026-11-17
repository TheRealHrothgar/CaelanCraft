// Tests for the Spyglass (CONTRACTS §103): whether one is carried (Survival and Creative), the narrowed field of view and
// the slowed look, the hold, the wheel and the kept zoom, the console's `zoom`, the touch Zoom button, the eyepiece on the
// HUD, and main's wiring (read from the source: main needs a browser).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Spyglass, carriesSpyglass, zoomedFov, zoomLookScale, wheelZoom, parseZoomArg, zoomLabel, SPYGLASS_KEY, ZOOM_KEY,
  ZOOM_LEVELS, ZOOM_DEFAULT, ZOOM_EASE, SPYGLASS_NEEDED,
} from '../../src/spyglass.js';
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
    g.lock();
    g.reset();
    expect([g.locked, g.held, g.shown]).toEqual([false, false, 1]);
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
    ui.update({ playing: true, survival: false, zoom: false });
    expect(zoom.classList.contains('hidden')).toBe(true);
    ui.dispose();
  });

  it('a hint for the keyboard names the Zoom button on a tablet', () => {
    expect(touchWords('Spyglass · Hold RMB or Z to look through it')).toBe('Spyglass · Hold Place, or tap Zoom, to look through it');
    expect(read('src/main.js')).toContain("return 'Spyglass · Hold RMB or Z to look through it';");
  });

  it('main tells it: zoom while a Spyglass is carried, zoomOn while the zoom is kept up; the tap toggles it', () => {
    const main = read('src/main.js');
    expect(main).toContain('touchView.zoom = spyglassCarried();');
    expect(main).toContain('touchView.zoomOn = spyglass.locked;');
    expect(main).toMatch(/onZoom: \(\) => \{\s*if \(spyglassCarried\(\)\) spyglass\.toggle\(\);/);
  });
});

describe('§103 the eyepiece on the HUD', () => {
  const html = read('index.html');
  it('a round dark vignette under the crosshair and the hints, its power at the foot; hidden at nothing', () => {
    const doc = documentFromHTML(html);
    const hud = createHUD(/** @type {any} */ (doc), /** @type {any} */ ({ width: 256, height: 256 }));
    const el = /** @type {any} */ (doc.getElementById('spyglass-overlay'));
    expect(el).not.toBe(null);
    expect(el.parentNode).toBe(doc.getElementById('hud'));
    expect(el.parentNode.firstChild).toBe(el); // first in #hud: the crosshair, the hints and the hotbar draw over it
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
});
