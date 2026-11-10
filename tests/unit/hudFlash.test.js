// Unit tests for the black hole's screen flash in src/hud.js (DESIGN-circuits §6.2.16): the pure flashStep (the 0.75 cap, at
// most one start per 0.5 s — so never more than two in any second —, the (1 − t/0.6)² decay) and, on a fake DOM built from
// index.html, #flash-overlay: created before the crosshair, opacity in 1/32 steps, the DOM touched only on a change.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHUD, flashStep, createFlashState } from '../../src/hud.js';
import { BLACK_HOLE_SCREEN_FLASH_MAX, BLACK_HOLE_SCREEN_FLASH_GAP_S, BLACK_HOLE_SCREEN_FLASH_S } from '../../src/config.js';
import { DEFAULT_HOTBAR } from '../../src/blocks.js';
import { documentFromHTML } from '../helpers/fakeDom.js';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const atlas = /** @type {any} */ ({ width: 256, height: 256 });

describe('flashStep (pure)', () => {
  it('the constants: at most 0.75, starts at least 0.5 s apart, a 0.6 s fade', () => {
    expect(BLACK_HOLE_SCREEN_FLASH_MAX).toBe(0.75);
    expect(BLACK_HOLE_SCREEN_FLASH_GAP_S).toBe(0.5);
    expect(BLACK_HOLE_SCREEN_FLASH_S).toBe(0.6);
    expect(createFlashState()).toEqual({ level: 0, sinceStart: Infinity });
  });

  it('a trigger starts a flash at its level, capped at 0.75, shown at full strength on its first frame', () => {
    const s = createFlashState();
    expect(flashStep(s, 1 / 60, null)).toBe(0);
    expect(flashStep(s, 1 / 60, { level: 0.4 })).toBe(0.4);
    const t = createFlashState();
    expect(flashStep(t, 1 / 60, { level: 3 })).toBe(BLACK_HOLE_SCREEN_FLASH_MAX);
    expect(t.sinceStart).toBe(0);
    // nothing for a zero, negative or garbage trigger
    for (const level of [0, -1, NaN]) expect(flashStep(createFlashState(), 0.016, { level })).toBe(0);
  });

  it('it fades on the (1 − t/0.6)² curve and is dark from 0.6 s', () => {
    const s = createFlashState();
    flashStep(s, 0, { level: 0.75 });
    let t = 0;
    for (let i = 1; i <= 40; i++) {
      const dt = 1 / 60;
      t += dt;
      const level = flashStep(s, dt, null);
      const want = t < 0.6 ? 0.75 * (1 - t / 0.6) ** 2 : 0;
      expect(level, `t = ${t.toFixed(3)}`).toBeCloseTo(want < 1e-4 ? 0 : want, 6);
    }
    expect(flashStep(s, 0.1, null)).toBe(0);
    // big steps follow the same curve
    const b = createFlashState();
    flashStep(b, 0, { level: 0.6 });
    expect(flashStep(b, 0.3, null)).toBeCloseTo(0.6 * 0.25, 9);
    expect(flashStep(b, 0.15, null)).toBeCloseTo(0.6 * (1 - 0.45 / 0.6) ** 2, 9);
    expect(flashStep(b, 1, null)).toBe(0);
  });

  it('at most one start per 0.5 s: triggers inside the gap are ignored; never more than two starts in any second', () => {
    const s = createFlashState();
    const dt = 1 / 60;
    /** @type {number[]} */
    const starts = [];
    let now = 0;
    for (let i = 0; i < 600; i++) { // 10 s of a trigger every frame
      now += dt;
      const before = s.sinceStart;
      flashStep(s, dt, { level: 1 });
      if (s.sinceStart === 0 && before !== 0) starts.push(now);
    }
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(0.5 - 1e-9);
    for (const t0 of starts) expect(starts.filter((t) => t >= t0 && t < t0 + 1).length).toBeLessThanOrEqual(2);
    expect(starts.length).toBeGreaterThanOrEqual(19);
    // a trigger 0.3 s after a start does nothing; 0.5 s after, it restarts
    const g = createFlashState();
    flashStep(g, 0, { level: 0.5 });
    const faded = flashStep(g, 0.3, { level: 0.75 });
    expect(faded).toBeCloseTo(0.5 * 0.25, 9);
    expect(g.sinceStart).toBeCloseTo(0.3, 9);
    expect(flashStep(g, 0.2, { level: 0.75 })).toBe(0.75);
    expect(g.sinceStart).toBe(0);
  });

  it('a weaker trigger never dims a brighter flash in progress', () => {
    const s = createFlashState();
    flashStep(s, 0, { level: 0.75 });
    const level = flashStep(s, 0.5, { level: 0.01 }); // the gap has passed: a start, but at the brighter level
    expect(level).toBeCloseTo(0.75 * (1 - 0.5 / 0.6) ** 2, 9);
    expect(s.sinceStart).toBe(0);
  });
});

describe('hud.setFlashOverlay', () => {
  function setup() {
    const doc = documentFromHTML(html);
    const hud = createHUD(/** @type {any} */ (doc), atlas);
    hud.setHotbar([...DEFAULT_HOTBAR], 0);
    return { doc, hud, $: (id) => /** @type {any} */ (doc.getElementById(id)) };
  }

  it('#flash-overlay is created in #hud right before the crosshair, hidden, white', () => {
    const { $ } = setup();
    const el = $('flash-overlay');
    expect(el).toBeTruthy();
    expect(el.parentNode).toBe($('hud'));
    const kids = $('hud').children;
    expect(kids.indexOf(el)).toBe(kids.indexOf($('crosshair')) - 1);
    expect(el.classList.contains('hidden')).toBe(true);
    expect(el.classList.contains('white')).toBe(true);
  });

  it('opacity in 1/32 steps, hidden at 0; the DOM is touched only when the step or the kind changes', () => {
    const { doc, hud, $ } = setup();
    const el = $('flash-overlay');
    hud.setFlashOverlay(0.5);
    expect(el.style.opacity).toBe('0.5');
    expect(el.classList.contains('hidden')).toBe(false);
    hud.setFlashOverlay(0.7);
    expect(el.style.opacity).toBe(String(Math.round(0.7 * 32) / 32));
    const w = doc.writes;
    hud.setFlashOverlay(0.69); // the same 1/32 step (22/32)
    hud.setFlashOverlay(Math.round(0.7 * 32) / 32);
    expect(doc.writes).toBe(w);
    hud.setFlashOverlay(0.7, 'void');
    expect(doc.writes).toBeGreaterThan(w);
    expect(el.classList.contains('void')).toBe(true);
    expect(el.classList.contains('white')).toBe(false);
    hud.setFlashOverlay(0, 'void');
    expect(el.classList.contains('hidden')).toBe(true);
    hud.setFlashOverlay(2, 'white');
    expect(el.style.opacity).toBe('1');
    hud.setFlashOverlay(NaN);
    expect(el.classList.contains('hidden')).toBe(true);
  });

  it('the styles: white is the radial gradient, void is #0b0908', () => {
    const css = readFileSync(fileURLToPath(new URL('../../src/styles.css', import.meta.url)), 'utf8');
    expect(css).toContain('#flash-overlay.white{background:radial-gradient(circle,rgba(255,255,255,1) 0,rgba(250,248,244,.9) 60%,rgba(240,236,230,.75) 100%)}');
    expect(css).toContain('#flash-overlay.void{background:#0b0908}');
  });
});
