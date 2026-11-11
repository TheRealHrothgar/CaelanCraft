// Unit tests for the survival HUD in src/hud.js (docs/DESIGN-survival.md §9.8): the pure helpers (vitalsKey rounding, breath
// edges, the temperature trend and gauge, chip colours, wear, the job chip) and, on a fake DOM built from index.html, that
// each setter touches the DOM only when its rounded value changes, the survival hotbar, the action ring and pickups.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createHUD, vitalsKey, breathEdges, BREATH_EDGES, airBodyTarget, tempTrend, tempGaugeLevel, chipKind, wearFraction, wearLevel,
  countText, jobChipText, hexCorners, TEMP_GAUGE_MIN, TEMP_GAUGE_MAX, PICKUP_FLY_MS, MAX_PICKUP_TOKENS,
} from '../../src/hud.js';
import { BREATH_MAX_S, HOTBAR_SIZE, CHAT_LINE_MS, INTRO_LINE_MS } from '../../src/config.js';
import { DEFAULT_HOTBAR } from '../../src/blocks.js';
import { documentFromHTML } from '../helpers/fakeDom.js';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const atlas = /** @type {any} */ ({ width: 256, height: 256 });
const V = { health: 80, satiation: 60, hydration: 55, temp: 37, felt: 20, breath: BREATH_MAX_S, labels: [] };

function setup() {
  const doc = documentFromHTML(html);
  const hud = createHUD(/** @type {any} */ (doc), atlas);
  hud.setHotbar([...DEFAULT_HOTBAR], 0);
  return { doc, hud, $: (id) => /** @type {any} */ (doc.getElementById(id)) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('vitalsKey: the rounding the HUD redraws on', () => {
  it('health, nourishment and hydration round to integers; temperatures to 0.1; breath to its edge count', () => {
    const k = vitalsKey(V);
    expect(vitalsKey({ ...V, health: 80.4 })).toBe(k);
    expect(vitalsKey({ ...V, health: 79.6 })).toBe(k);
    expect(vitalsKey({ ...V, health: 80.6 })).not.toBe(k);
    expect(vitalsKey({ ...V, satiation: 60.49 })).toBe(k);
    expect(vitalsKey({ ...V, satiation: 59.4 })).not.toBe(k);
    expect(vitalsKey({ ...V, hydration: 55.2 })).toBe(k);
    expect(vitalsKey({ ...V, temp: 37.04 })).toBe(k);
    expect(vitalsKey({ ...V, temp: 37.06 })).not.toBe(k);
    expect(vitalsKey({ ...V, felt: 20.049 })).toBe(k);
    expect(vitalsKey({ ...V, felt: 20.15 })).not.toBe(k);
    expect(vitalsKey({ ...V, breath: 17 })).toBe(k); // still six edges
    expect(vitalsKey({ ...V, breath: 16.6 })).not.toBe(k); // five
    expect(vitalsKey({ ...V, labels: ['Hungry'] })).not.toBe(k);
  });

  it('never tells −0.0 from 0.0, and treats garbage as 0', () => {
    expect(vitalsKey({ ...V, felt: -0.04 })).toBe(vitalsKey({ ...V, felt: 0.04 }));
    expect(vitalsKey({ ...V, health: NaN })).toBe(vitalsKey({ ...V, health: 0 }));
    expect(vitalsKey(/** @type {any} */ (null))).toBe(vitalsKey(/** @type {any} */ ({})));
  });
});

describe('survival HUD helpers', () => {
  it('breathEdges: ceil(breath / (BREATH_MAX_S / 6)), clamped 0..6', () => {
    expect(BREATH_EDGES).toBe(6);
    expect(breathEdges(BREATH_MAX_S)).toBe(6);
    expect(breathEdges(30)).toBe(6);
    expect(breathEdges(BREATH_MAX_S * 5 / 6)).toBe(5);
    expect(breathEdges(BREATH_MAX_S * 5 / 6 + 0.01)).toBe(6);
    expect(breathEdges(10)).toBe(3);
    expect(breathEdges(0.1)).toBe(1);
    expect(breathEdges(0)).toBe(0);
    expect(breathEdges(-3)).toBe(0);
    expect(breathEdges(NaN)).toBe(0);
  });

  it('the body target in air and the ▲/▼ trend (dead band 0.2 °C)', () => {
    expect(airBodyTarget(20)).toBe(37);
    expect(airBodyTarget(10)).toBe(37);
    expect(airBodyTarget(30)).toBe(37);
    expect(airBodyTarget(0)).toBeCloseTo(34, 9);
    expect(airBodyTarget(-13.2)).toBeCloseTo(30.04, 9); // §3.4 snowy night
    expect(airBodyTarget(42.5)).toBeCloseTo(39.5, 9); // §3.4 desert noon
    expect(tempTrend(37, 20)).toBe('');
    expect(tempTrend(37, -13.2)).toBe('down');
    expect(tempTrend(37, 42.5)).toBe('up');
    expect(tempTrend(35, 20)).toBe('up'); // warming back toward 37
    expect(tempTrend(37.1, 20)).toBe('');
    expect(tempTrend(36, 20, 33.8)).toBe('down'); // main's exact target wins (plains water)
  });

  it('the gauge spans TEMP_GAUGE_MIN..MAX', () => {
    expect(tempGaugeLevel(TEMP_GAUGE_MIN)).toBe(0);
    expect(tempGaugeLevel(TEMP_GAUGE_MAX)).toBe(1);
    expect(tempGaugeLevel(25)).toBe(0);
    expect(tempGaugeLevel(45)).toBe(1);
    expect(tempGaugeLevel(37)).toBeCloseTo(0.5, 9);
  });

  it('every §2.3 status label has a chip colour', () => {
    const table = {
      Hungry: 'hunger', Starving: 'hunger', Thirsty: 'thirst', Parched: 'thirst', Wounded: 'hurt', Heatstroke: 'heat',
      Overheating: 'heat', Hot: 'heat', Chilled: 'cold', Cold: 'cold', Freezing: 'cold', Hypothermic: 'cold',
      Drowning: 'breath', Smothering: 'breath', Poisoned: 'sick', Wet: 'wet', // v0.11: Sick → Poisoned (§66)
    };
    for (const [label, kind] of Object.entries(table)) expect(chipKind(label), label).toBe(kind);
    expect(chipKind('Something')).toBe('other');
  });

  it('wear: a fraction only for a worn tool; honey above 50 %, ember below 25 %', () => {
    expect(wearFraction(null)).toBeNull();
    expect(wearFraction({ k: 'rock', n: 5 })).toBeNull();
    expect(wearFraction({ k: 'flint_axe', n: 1 })).toBeNull(); // new: no outline
    expect(wearFraction({ k: 'flint_axe', n: 1, d: 45 })).toBeCloseTo(0.5, 9);
    expect(wearFraction({ k: 'rock', n: 1, d: 3 })).toBeNull(); // never wears
    expect(wearLevel(0.51)).toBe('good');
    expect(wearLevel(0.5)).toBe('worn');
    expect(wearLevel(0.25)).toBe('worn');
    expect(wearLevel(0.24)).toBe('low');
  });

  it('counts, the job chip, and the hex corners', () => {
    expect(countText(null)).toBe('');
    expect(countText({ k: 'rock', n: 1 })).toBe('');
    expect(countText({ k: 'rock', n: 12 })).toBe('12');
    expect(jobChipText('Kiln', 'Copper Ingot', 11.2)).toBe('Kiln · Copper Ingot 12 s');
    expect(jobChipText('Kiln', 'Copper Ingot', 12, 2)).toBe('Kiln · Copper Ingot 12 s +2');
    expect(jobChipText('Hands', 'Cord', 0)).toBe('Hands · Cord 0 s');
    expect(hexCorners(38, 44)).toEqual([[19, 0], [38, 11], [38, 33], [19, 44], [0, 33], [0, 11]]);
  });
});

describe('survival HUD on the page', () => {
  it('Creative is untouched: nothing survival shows until Survival is switched on', () => {
    const { $ } = setup();
    expect($('hotbar').classList.contains('survival')).toBe(false);
    for (const id of ['vitals-left', 'vitals-right', 'status-chips', 'job-chip', 'action-ring']) {
      expect($(id).classList.contains('hidden'), id).toBe(true);
    }
    expect($('vitals-left').children.length).toBe(0); // built lazily
  });

  it('setSurvivalVisible shows the bookends (two cells each) and hides them again', () => {
    const { hud, $ } = setup();
    hud.setSurvivalVisible(true);
    expect($('vitals-left').classList.contains('hidden')).toBe(false);
    expect($('vitals-right').classList.contains('hidden')).toBe(false);
    expect($('vitals-left').children.map((c) => c.getAttribute('class'))).toEqual(['vital vital-health', 'vital vital-satiation']);
    expect($('vitals-right').children.map((c) => c.getAttribute('class'))).toEqual(['vital vital-hydration', 'vital vital-temp']);
    expect($('job-chip').classList.contains('hidden')).toBe(true); // no job yet
    hud.setSurvivalVisible(false);
    expect($('vitals-left').classList.contains('hidden')).toBe(true);
    expect($('hud').classList.contains('survival')).toBe(false);
  });

  it('setVitals redraws only when the rounded values change', () => {
    const { doc, hud, $ } = setup();
    hud.setSurvivalVisible(true);
    hud.setVitals(V);
    const fill = $('vitals-left').querySelector('.vital-health .vital-fill');
    expect(fill.getAttribute('height')).toBe(String(+(44 * 0.8).toFixed(2)));
    const w0 = doc.writes;
    hud.setVitals({ ...V, health: 80.3, temp: 37.02, felt: 19.98, breath: 19.5 });
    expect(doc.writes).toBe(w0); // below the rounding: no DOM write at all
    hud.setVitals({ ...V, health: 79.4 });
    expect(doc.writes).toBeGreaterThan(w0);
    expect(fill.getAttribute('height')).toBe(String(+(44 * 0.79).toFixed(2)));
    expect($('vitals-left').querySelector('.vital-health').getAttribute('aria-label')).toBe('Health 79');
  });

  it('breath darkens the Health border edge by edge, clockwise from the top, and pulses at 0', () => {
    const { hud, $ } = setup();
    hud.setSurvivalVisible(true);
    hud.setVitals(V);
    const group = $('vitals-left').querySelector('.breath');
    const edges = () => $('vitals-left').querySelectorAll('.breath-edge').map((e) => e.getAttribute('class').split(' ')[1]);
    expect(group.getAttribute('class')).toContain('hidden'); // full breath: no border
    hud.setVitals({ ...V, breath: 10 });
    expect(group.getAttribute('class')).toBe('breath');
    expect(edges()).toEqual(['dark', 'dark', 'dark', 'lit', 'lit', 'lit']);
    hud.setVitals({ ...V, breath: 16 });
    expect(edges()).toEqual(['dark', 'lit', 'lit', 'lit', 'lit', 'lit']);
    hud.setVitals({ ...V, breath: 0 });
    expect(group.getAttribute('class')).toBe('breath out');
    expect(edges()).toEqual(Array(6).fill('dark'));
    // the first edge runs from the top corner toward the upper right
    const first = $('vitals-left').querySelector('.breath-edge');
    expect(Number(first.getAttribute('x1'))).toBeCloseTo(19, 1);
    expect(Number(first.getAttribute('x2'))).toBeGreaterThan(30);
  });

  it('the temperature needle and trend; status chips by kind, rebuilt only when the labels change', () => {
    const { doc, hud, $ } = setup();
    hud.setSurvivalVisible(true);
    hud.setVitals({ ...V, temp: 37, felt: -13.2, labels: ['Chilled', 'Wet'] });
    const needle = $('vitals-right').querySelector('.temp-needle');
    expect(needle.getAttribute('transform')).toBe('translate(0 22)');
    expect($('vitals-right').querySelector('.temp-trend').textContent).toBe('▼');
    expect($('status-chips').children.map((c) => [c.textContent, c.getAttribute('class')])).toEqual([
      ['Chilled', 'chip chip-cold'], ['Wet', 'chip chip-wet'],
    ]);
    const chips = $('status-chips').children.slice();
    hud.setVitals({ ...V, temp: 36.9, felt: -13.2, labels: ['Chilled', 'Wet'] });
    expect($('status-chips').children).toEqual(chips); // same labels: the same chip elements
    const w = doc.writes;
    hud.setVitals({ ...V, temp: 36.9, felt: -13.2, labels: ['Chilled', 'Wet'] });
    expect(doc.writes).toBe(w);
    hud.setVitals({ ...V, labels: [] });
    expect($('status-chips').children.length).toBe(0);
    expect($('vitals-right').querySelector('.temp-trend').textContent).toBe('');
  });

  it('the survival hotbar: hex slots with counts and wear outlines, redrawn only for a new version or selection', () => {
    const { doc, hud, $ } = setup();
    const slots = Array(27).fill(null);
    slots[0] = { k: 'flint_axe', n: 1, d: 18 };
    slots[1] = { k: 'rock', n: 23 };
    slots[2] = { k: 'flint_pick', n: 1 };
    hud.setHotbarStacks(slots, 0, 1);
    expect($('hotbar').classList.contains('survival')).toBe(true);
    const slotEls = $('hotbar').querySelectorAll('.hotbar-slot');
    expect(slotEls.length).toBe(HOTBAR_SIZE);
    expect(slotEls[1].querySelector('.slot-count').textContent).toBe('23');
    expect(slotEls[0].querySelector('.slot-count').textContent).toBe('');
    expect(slotEls[0].querySelector('.slot-wear').getAttribute('class')).toBe('slot-wear low'); // 18/90
    expect(slotEls[0].querySelector('.slot-wear polygon').getAttribute('stroke-dasharray')).toBe('20 100');
    expect(slotEls[2].querySelector('.slot-wear').getAttribute('class')).toBe('slot-wear hidden'); // new tool: no outline
    const w = doc.writes;
    slots[1] = { k: 'rock', n: 30 }; // same version: main has not bumped pack.version, so nothing is redrawn
    hud.setHotbarStacks(slots, 0, 1);
    expect(doc.writes).toBe(w);
    hud.setHotbarStacks(slots, 0, 2);
    expect(slotEls[1].querySelector('.slot-count').textContent).toBe('30');
    hud.setHotbarStacks(slots, 2, 2);
    expect(slotEls[2].classList.contains('selected')).toBe(true);
    expect(slotEls[0].classList.contains('selected')).toBe(false);
  });

  it('setHotbarStacks(null) brings Creative\'s hotbar back from the ids setHotbar last gave', () => {
    const { hud, $ } = setup();
    const slots = Array(27).fill(null);
    slots[0] = { k: 'rock', n: 5 };
    hud.setHotbarStacks(slots, 0, 1);
    hud.setHotbar([...DEFAULT_HOTBAR].reverse(), 3); // ignored for drawing while Survival owns the slots
    const slot0 = $('hotbar').querySelector('.hotbar-slot');
    const ctx = slot0.querySelector('canvas').getContext('2d');
    const before = ctx.calls.length;
    hud.setHotbarStacks(null, 3);
    expect($('hotbar').classList.contains('survival')).toBe(false);
    expect(slot0.querySelector('.slot-count').textContent).toBe('');
    expect(ctx.calls.length).toBeGreaterThan(before); // redrawn as a block icon
    expect(hud.getSelected()).toBe(3);
  });

  it('the action ring: hidden for null, a dash for progress, no writes when the percent is unchanged', () => {
    const { doc, hud, $ } = setup();
    hud.setSurvivalVisible(true);
    hud.setActionProgress(null);
    expect($('action-ring').classList.contains('hidden')).toBe(true);
    hud.setActionProgress(0.5);
    expect($('action-ring').classList.contains('hidden')).toBe(false);
    expect($('action-ring').querySelector('.ring-fill').getAttribute('stroke-dasharray')).toBe('50 100');
    const w = doc.writes;
    hud.setActionProgress(0.501);
    expect(doc.writes).toBe(w);
    hud.setActionProgress(null);
    expect($('action-ring').classList.contains('hidden')).toBe(true);
  });

  it('the job chip', () => {
    const { hud, $ } = setup();
    hud.setSurvivalVisible(true);
    hud.setJobChip(jobChipText('Kiln', 'Copper Ingot', 12, 2));
    expect($('job-chip').textContent).toBe('Kiln · Copper Ingot 12 s +2');
    expect($('job-chip').classList.contains('hidden')).toBe(false);
    hud.setJobChip(null);
    expect($('job-chip').classList.contains('hidden')).toBe(true);
  });

  it('a pickup flies a token to the slot holding the item (else the pack glyph), which then pulses', () => {
    vi.useFakeTimers();
    const { hud, $ } = setup();
    const slots = Array(27).fill(null);
    slots[4] = { k: 'flint', n: 2 };
    hud.setHotbarStacks(slots, 0, 1);
    hud.addPickup('flint', 1, { x: 300, y: 200 });
    const layer = $('pickup-layer');
    expect(layer.children.length).toBe(1);
    const token = layer.children[0];
    expect(token.getAttribute('class')).toBe('pickup-token');
    expect(token.style.transform).toMatch(/^translate\(-?\d+px, -?\d+px\) scale\(0\.85\)$/);
    vi.advanceTimersByTime(PICKUP_FLY_MS + 1);
    expect(layer.children.length).toBe(0);
    expect($('hotbar').querySelectorAll('.hotbar-slot')[4].classList.contains('pulse')).toBe(true);
    hud.addPickup('malachite', 2, null); // not in the hotbar: to the pack glyph
    vi.advanceTimersByTime(PICKUP_FLY_MS + 1);
    expect($('pack-glyph').classList.contains('pulse')).toBe(true);
    // a burst never grows the DOM past MAX_PICKUP_TOKENS tokens
    for (let i = 0; i < 30; i++) hud.addPickup('flint', 1, null);
    expect(layer.children.length).toBe(MAX_PICKUP_TOKENS);
    hud.dispose();
    expect(layer.children.length).toBe(0);
  });

  it('pickups do nothing in Creative', () => {
    const { hud, $ } = setup();
    hud.addPickup('rock', 1, null);
    expect($('pickup-layer').children.length).toBe(0);
  });
});

describe('addChatLine with a lifetime (§1.2: the Survival intro lines)', () => {
  it('an ordinary line fades after CHAT_LINE_MS; a line given a lifetime stays that long', () => {
    vi.useFakeTimers();
    const { hud, $ } = setup();
    hud.addChatLine('plain');
    hud.addChatLine('Your handbook is in the last hotbar slot.', false, INTRO_LINE_MS);
    const lines = () => Array.from($('chat-log').children);
    expect(lines().length).toBe(2);
    vi.advanceTimersByTime(CHAT_LINE_MS + 1);
    expect(lines()[0].classList.contains('fade')).toBe(true);
    expect(lines()[1].classList.contains('fade')).toBe(false);
    vi.advanceTimersByTime(INTRO_LINE_MS - CHAT_LINE_MS);
    expect(lines().some((d) => d.textContent.startsWith('Your handbook') && d.classList.contains('fade'))).toBe(true);
    expect(INTRO_LINE_MS).toBeGreaterThanOrEqual(3 * CHAT_LINE_MS);
  });

  it('a bad lifetime falls back to CHAT_LINE_MS', () => {
    vi.useFakeTimers();
    const { hud, $ } = setup();
    hud.addChatLine('x', false, NaN);
    hud.addChatLine('y', false, -5);
    vi.advanceTimersByTime(CHAT_LINE_MS + 1);
    expect(Array.from($('chat-log').children).every((d) => d.classList.contains('fade'))).toBe(true);
  });
});
