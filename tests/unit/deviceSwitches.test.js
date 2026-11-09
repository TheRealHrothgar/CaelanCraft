// Unit tests for the pause menu's Devices row in src/menus.js (DESIGN-circuits §6.2.17): two survival-style .hex-button
// two-segment switches, [ Circuits: On | Off ] and [ Black holes: On | Off ], after survival's Mode row; the active half
// filled with aria-pressed="true"; only the inactive half fires its callback; never .mc-button. And the reworded controls
// sheet (§4.9, §7.1).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMenus, DEVICE_SWITCHES, CONTROLS_SHEET } from '../../src/menus.js';
import { documentFromHTML, fire } from '../helpers/fakeDom.js';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const atlas = /** @type {any} */ ({ width: 256, height: 256 });

/** @param {Record<string, Function>} [callbacks] */
function setup(callbacks = {}) {
  const doc = documentFromHTML(html);
  const menus = createMenus(/** @type {any} */ (doc), atlas, /** @type {any} */ (callbacks));
  return { doc, menus, $: (id) => /** @type {any} */ (doc.getElementById(id)) };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the Devices row', () => {
  it('#pause-devices.physics-row, labelled Devices, right after survival\'s #pause-mode; the Guide stays above Save & Quit', () => {
    const { $ } = setup();
    const row = $('pause-devices');
    expect(row.classList.contains('physics-row')).toBe(true);
    expect(row.querySelector('.physics-label').textContent).toBe('Devices');
    const panel = row.parentNode;
    expect(panel.children.indexOf(row)).toBe(panel.children.indexOf($('pause-mode')) + 1);
    expect(panel.children.indexOf($('btn-guide-pause'))).toBe(panel.children.indexOf($('btn-quit')) - 1);
    expect(row.children.slice(1).map((g) => g.id)).toEqual(['btn-circuits', 'btn-blackholes']);
  });

  it('two halves each, .hex-button, never .mc-button; the On half carries the name', () => {
    const { $ } = setup();
    expect($('btn-circuits').children.map((b) => b.id)).toEqual(['btn-circuits-on', 'btn-circuits-off']);
    expect($('btn-blackholes').children.map((b) => b.id)).toEqual(['btn-blackholes-on', 'btn-blackholes-off']);
    expect([$('btn-circuits-on'), $('btn-circuits-off'), $('btn-blackholes-on'), $('btn-blackholes-off')].map((b) => b.textContent))
      .toEqual(['Circuits: On', 'Off', 'Black holes: On', 'Off']);
    for (const id of ['btn-circuits-on', 'btn-circuits-off', 'btn-blackholes-on', 'btn-blackholes-off']) {
      expect($(id).classList.contains('hex-button'), id).toBe(true);
      expect($(id).classList.contains('mode-half'), id).toBe(true);
      expect($(id).classList.contains('mc-button'), id).toBe(false);
    }
    expect($('pause-devices').querySelectorAll('.mc-button')).toHaveLength(0);
    expect(DEVICE_SWITCHES.map((s) => s[0])).toEqual(['circuits', 'blackholes']);
  });

  it('the active half is filled (class active) with aria-pressed; setDeviceSwitches moves it; a missing key keeps its switch', () => {
    const { menus, $ } = setup();
    const pressed = () => ['btn-circuits-on', 'btn-circuits-off', 'btn-blackholes-on', 'btn-blackholes-off']
      .map((id) => $(id).getAttribute('aria-pressed'));
    expect(menus.getDeviceSwitches()).toEqual({ circuits: true, blackholes: true });
    expect(pressed()).toEqual(['true', 'false', 'true', 'false']);
    menus.setDeviceSwitches({ circuits: false, blackholes: true });
    expect(pressed()).toEqual(['false', 'true', 'true', 'false']);
    expect($('btn-circuits-off').classList.contains('active')).toBe(true);
    expect($('btn-circuits-on').classList.contains('active')).toBe(false);
    expect($('btn-circuits').dataset.on).toBe('false');
    menus.setDeviceSwitches({ blackholes: false });
    expect(menus.getDeviceSwitches()).toEqual({ circuits: false, blackholes: false });
    expect(pressed()).toEqual(['false', 'true', 'false', 'true']);
    menus.setDeviceSwitches(/** @type {any} */ ({ circuits: 'yes' }));
    expect(menus.getDeviceSwitches().circuits).toBe(false);
  });

  it('callbacks come only from the inactive half: onSetCircuits(on) and onSetBlackHoles(on)', () => {
    const onSetCircuits = vi.fn();
    const onSetBlackHoles = vi.fn();
    const { menus, $ } = setup({ onSetCircuits, onSetBlackHoles });
    menus.showPause(7);
    fire($('btn-circuits-on'), 'click'); // already on
    expect(onSetCircuits).not.toHaveBeenCalled();
    fire($('btn-circuits-off'), 'click');
    expect(onSetCircuits).toHaveBeenLastCalledWith(false);
    // main applies it and calls setDeviceSwitches; until then the halves stay as they were
    expect($('btn-circuits-on').getAttribute('aria-pressed')).toBe('true');
    menus.setDeviceSwitches({ circuits: false });
    fire($('btn-circuits-off'), 'click');
    expect(onSetCircuits).toHaveBeenCalledTimes(1);
    fire($('btn-circuits-on'), 'click');
    expect(onSetCircuits).toHaveBeenLastCalledWith(true);
    fire($('btn-blackholes-off'), 'click');
    expect(onSetBlackHoles).toHaveBeenLastCalledWith(false);
    expect(onSetBlackHoles).toHaveBeenCalledTimes(1);
  });

  it('without the callbacks the halves do nothing (and throw nothing)', () => {
    const { $ } = setup();
    expect(() => fire($('btn-blackholes-off'), 'click')).not.toThrow();
  });
});

describe('the controls sheet (§4.9, §7.1)', () => {
  it('17 rows; RMB, R and Shift R carry the merged circuits wording; keys are written in full', () => {
    expect(CONTROLS_SHEET).toHaveLength(17);
    const row = (k) => CONTROLS_SHEET.find(([key]) => key === k)?.[1];
    expect(row('RMB')).toBe('Place · right-click works switches, timers, plungers (Shift: place) · Survival: use the item in hand');
    expect(row('R')).toBe('R key: use a switch, timer, fuse, radio key or rune · Survival: fire, water, plants, basket');
    expect(row('Shift R')).toBe('Shift+R key: settings of the targeted device or Rune Block');
    expect(row('E')).toBe('Blocks · Survival: pack & making');
    for (const [, text] of CONTROLS_SHEET) {
      expect(text).not.toContain('[R]');
      expect(text).not.toMatch(/(^|[^+\w])R:/);
    }
  });
});
