// Unit tests for src/devicePanel.js (DESIGN-circuits §4.10, §6.2.15): the pure helpers panelFields (which controls each kind
// shows: the timer's presets, the wavelength dial with its distress mark, the push button's NO | NC, the receiver's
// Pulse | Latch …) and clampSetting, with views from the real engine (circuits.panelView); then the panel itself on a fake
// DOM: rounded .cc-btn buttons and the icon on a rounded square (no icons on hexagons), onChange / onAction, the label's
// debounce, refresh, and Done / Esc / Enter / the Shift+R key.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  panelFields, clampSetting, readoutPairs, createDevicePanel, TIMER_PRESETS, ACTION_LABELS, LABEL_DEBOUNCE_MS, FACE_NAMES,
  PANEL_ICON_PX,
} from '../../src/devicePanel.js';
import { BLOCK } from '../../src/blocks.js';
import { BATTERY_CAPACITY, MAX_PART_LABEL_CHARS, RADIO_DISTRESS_CH, TIMER_MAX_S, TIMER_MIN_S } from '../../src/config.js';
import { partTip, partOrigin } from '../../src/circuitParts.js';
import { makeCircuitWorld, FLOOR } from '../helpers/circuitWorld.js';
import { documentFromHTML, fire } from '../helpers/fakeDom.js';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

/** The engine's view of a part standing alone at (0, FLOOR, 0). @param {number} id @param {boolean} [creative=true] */
function viewOf(id, creative = true, settings = null) {
  const env = makeCircuitWorld();
  env.put(0, 0, id);
  if (settings) env.circuits.applySettings(0, FLOOR, 0, settings);
  env.ticks(2);
  return /** @type {import('../../src/types.js').DevicePanelView} */ (env.circuits.panelView(0, FLOOR, 0, creative));
}
const kinds = (fields) => fields.map((f) => (f.kind === 'action' ? `action:${f.action}` : `${f.kind}:${/** @type {*} */ (f).field}`));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('panelFields: which controls each kind shows, in order (§4.10)', () => {
  it('Clockwork Timer: label, delay, the preset chips 5 · 10 · 15 · 30 s · 1 · 5 min, Pulse | Hold | Repeat, the input face, Start', () => {
    const f = panelFields(viewOf(BLOCK.CLOCKWORK_TIMER));
    expect(kinds(f)).toEqual(['label:l', 'number:s', 'presets:s', 'segmented:m', 'face:f', 'action:start']);
    const num = /** @type {*} */ (f[1]);
    expect([num.value, num.min, num.max, num.step]).toEqual([5, TIMER_MIN_S, TIMER_MAX_S, 0.5]);
    expect(/** @type {*} */ (f[2]).options.map((o) => o.label)).toEqual(['5 s', '10 s', '15 s', '30 s', '1 min', '5 min']);
    expect(/** @type {*} */ (f[2]).options.map((o) => o.value)).toEqual([5, 10, 15, 30, 60, 300]);
    expect(TIMER_PRESETS).toHaveLength(6);
    expect(/** @type {*} */ (f[3]).options.map((o) => o.label)).toEqual(['Pulse', 'Hold', 'Repeat']);
    expect(/** @type {*} */ (f[3]).value).toBe('pulse');
    expect(/** @type {*} */ (f[4]).value).toBe(3); // the default input face (W)
    expect(/** @type {*} */ (f[5]).label).toBe('Start');
  });

  it('a running timer offers Stop; its settings come from the store', () => {
    const env = makeCircuitWorld();
    env.put(0, 0, BLOCK.CLOCKWORK_TIMER);
    env.circuits.applySettings(0, FLOOR, 0, { s: 30, m: 'repeat', f: 6 });
    env.circuits.timerAt(0, FLOOR, 0, 'start');
    env.ticks(1);
    const f = panelFields(/** @type {*} */ (env.circuits.panelView(0, FLOOR, 0, true)));
    expect(f.map((x) => /** @type {*} */ (x).value)).toEqual(['', 30, 30, 'repeat', 6, undefined]);
    expect(f[f.length - 1]).toEqual({ kind: 'action', action: 'stop', label: 'Stop' });
  });

  it('Push Button: label and NO | NC; Relay: NO | NC and the input face', () => {
    const button = panelFields(viewOf(BLOCK.PUSH_BUTTON));
    expect(kinds(button)).toEqual(['label:l', 'segmented:nc']);
    expect(/** @type {*} */ (button[1]).options).toEqual([{ value: false, label: 'NO' }, { value: true, label: 'NC' }]);
    expect(/** @type {*} */ (button[1]).value).toBe(false);
    expect(/** @type {*} */ (panelFields(viewOf(BLOCK.PUSH_BUTTON, true, { nc: true }))[1]).value).toBe(true);
    expect(kinds(panelFields(viewOf(BLOCK.RELAY)))).toEqual(['label:l', 'segmented:nc', 'face:f']);
  });

  it('Spark Transmitter: the wavelength dial (16 buttons 300…1050 m, 600 m marked distress) and Send', () => {
    const f = panelFields(viewOf(BLOCK.SPARK_TRANSMITTER));
    expect(kinds(f)).toEqual(['label:l', 'dial:ch', 'action:send']);
    const dial = /** @type {*} */ (f[1]);
    expect(dial.options).toHaveLength(16);
    expect(dial.options.map((o) => o.label)).toEqual(['300', '350', '400', '450', '500', '550', '600', '650', '700', '750', '800',
      '850', '900', '950', '1000', '1050']);
    expect(dial.options.filter((o) => o.distress).map((o) => o.label)).toEqual(['600']);
    expect(dial.options[RADIO_DISTRESS_CH - 1].distress).toBe(true);
    expect(dial.value).toBe(1);
  });

  it('Coherer Receiver: the dial, Pulse | Latch, the tapper\'s input face and Tap', () => {
    const f = panelFields(viewOf(BLOCK.COHERER_RECEIVER, true, { m: 'latch', ch: 7 }));
    expect(kinds(f)).toEqual(['label:l', 'dial:ch', 'segmented:m', 'face:f', 'action:tap']);
    expect(/** @type {*} */ (f[2]).options.map((o) => o.label)).toEqual(['Pulse', 'Latch']);
    expect(/** @type {*} */ (f[2]).value).toBe('latch');
    expect(/** @type {*} */ (f[1]).value).toBe(7);
  });

  it('Knife Switch: Open | Closed; Battery: the charge bar, and Refill in Creative only', () => {
    const sw = panelFields(viewOf(BLOCK.KNIFE_SWITCH, true, { on: true }));
    expect(kinds(sw)).toEqual(['label:l', 'segmented:on']);
    expect(/** @type {*} */ (sw[1]).options.map((o) => o.label)).toEqual(['Open', 'Closed']);
    expect(/** @type {*} */ (sw[1]).value).toBe(true);
    const creative = panelFields(viewOf(BLOCK.VOLTAIC_BATTERY, true));
    expect(kinds(creative)).toEqual(['label:l', 'charge:c', 'action:refill']);
    expect(creative[1]).toMatchObject({ value: BATTERY_CAPACITY, percent: 100, volts: '6 V' });
    expect(kinds(panelFields(viewOf(BLOCK.VOLTAIC_BATTERY, false)))).toEqual(['label:l', 'charge:c']);
    // a tired battery: the bar and its volts follow the charge
    const v = { ...viewOf(BLOCK.VOLTAIC_BATTERY, false), fields: { c: 450 } };
    expect(panelFields(v)[1]).toMatchObject({ percent: 12, volts: '5.25 V' });
  });

  it('others show the label only; wires, fuses and the torch show nothing but "About"', () => {
    for (const id of [BLOCK.IGNITER, BLOCK.FILAMENT_LAMP, BLOCK.ELECTRIC_BELL, BLOCK.TERMINAL_BOARD, BLOCK.SELENIUM_PANEL,
      BLOCK.BLASTING_MACHINE, BLOCK.COLLAPSAR_CHARGE]) {
      expect(kinds(panelFields(viewOf(id))), String(id)).toEqual(['label:l']);
    }
    for (const id of [BLOCK.COPPER_WIRE, BLOCK.BROWN_WIRE, BLOCK.WHITE_WIRE, BLOCK.EARTH_WIRE, BLOCK.POWDER_FUSE, BLOCK.TORCH]) {
      expect(panelFields(viewOf(id)), String(id)).toEqual([]);
    }
    expect(panelFields(/** @type {*} */ (null))).toEqual([]);
  });
});

describe('clampSetting: the store\'s rules (circuitStore.normalizePart)', () => {
  it('clamps and rounds; gives the default for an invalid value; undefined for a field the kind lacks', () => {
    expect(clampSetting('timer', 's', 0.2)).toBe(TIMER_MIN_S);
    expect(clampSetting('timer', 's', 99999)).toBe(TIMER_MAX_S);
    expect(clampSetting('timer', 's', 7.3)).toBe(7.5);
    expect(clampSetting('timer', 's', 'soon')).toBe(5); // invalid → the default delay
    expect(clampSetting('timer', 'm', 'repeat')).toBe('repeat');
    expect(clampSetting('timer', 'm', 'latch')).toBe('pulse'); // not a timer mode
    expect(clampSetting('rx', 'm', 'latch')).toBe('latch');
    expect(clampSetting('tx', 'ch', 0)).toBe(1);
    expect(clampSetting('tx', 'ch', 40)).toBe(16);
    expect(clampSetting('tx', 'ch', 6.6)).toBe(7);
    expect(clampSetting('relay', 'f', 9)).toBe(6);
    expect(clampSetting('relay', 'f', -2)).toBe(0);
    expect(clampSetting('battery', 'c', 1e9)).toBe(BATTERY_CAPACITY);
    expect(clampSetting('switch', 'l', '  Front door that is far too long a label  ')).toBe('Front door that is far t'.trim());
    expect(clampSetting('switch', 'l', 'x'.repeat(40))).toHaveLength(MAX_PART_LABEL_CHARS);
    expect(clampSetting('button', 'nc', true)).toBe(true);
    expect(clampSetting('switch', 'nc', true)).toBeUndefined(); // a knife switch has no NC
    expect(clampSetting('copper_wire', 'l', 'x')).toBeUndefined(); // wires have no settings
    expect(clampSetting('nope', 's', 5)).toBeUndefined();
  });
});

describe('readoutPairs', () => {
  it('splits "Label: value" lines and keeps the others whole', () => {
    expect(readoutPairs(['Volts: 4.75 V', 'Earthed: no — run an Earth Wire down', '0 V: join it to the battery with a wire']))
      .toEqual([['Volts', '4.75 V'], ['Earthed', 'no — run an Earth Wire down'], ['', '0 V: join it to the battery with a wire']]);
    expect(readoutPairs(/** @type {*} */ (null))).toEqual([]);
  });
});

describe('the panel on a fake DOM', () => {
  function setup(view) {
    const doc = documentFromHTML(html);
    const onChange = vi.fn();
    const onAction = vi.fn();
    const onClose = vi.fn();
    const panel = createDevicePanel(/** @type {any} */ (doc), { onChange, onAction, onClose });
    const root = /** @type {any} */ (doc.getElementById('device-panel'));
    if (view) panel.open(view);
    return { doc, panel, root, onChange, onAction, onClose };
  }
  const ALL = [BLOCK.CLOCKWORK_TIMER, BLOCK.RELAY, BLOCK.PUSH_BUTTON, BLOCK.SPARK_TRANSMITTER, BLOCK.COHERER_RECEIVER,
    BLOCK.KNIFE_SWITCH, BLOCK.VOLTAIC_BATTERY, BLOCK.FILAMENT_LAMP, BLOCK.COPPER_WIRE, BLOCK.TORCH, BLOCK.POWDER_KEG];

  it('#device-panel sits in index.html; every button in it is a rounded .cc-btn (never a .hex-button, .mc-button or .picker-panel)', () => {
    for (const id of ALL) {
      const { root, panel } = setup(viewOf(id));
      expect(root.classList.contains('hidden')).toBe(false);
      const buttons = root.querySelectorAll('button');
      expect(buttons.length, String(id)).toBeGreaterThan(0);
      for (const b of buttons) {
        expect(b.classList.contains('cc-btn'), `${id}: ${b.textContent}`).toBe(true);
        expect(b.classList.contains('hex-button'), `${id}: ${b.textContent}`).toBe(false);
        expect(b.getAttribute('type'), `${id}: ${b.textContent}`).toBe('button');
      }
      expect(root.querySelectorAll('.mc-button, .picker-panel, .hex-button'), String(id)).toHaveLength(0);
      expect(root.querySelector('.cc-panel')).toBeTruthy();
      panel.dispose();
    }
    const src = readFileSync(fileURLToPath(new URL('../../src/devicePanel.js', import.meta.url)), 'utf8');
    expect(src.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')).not.toMatch(/mc-button|picker-panel|hex-button/);
  });

  it('the header shows the part\'s 48 px icon on a rounded square box (.cc-icon), not on a hexagon badge', () => {
    const doc = documentFromHTML(html);
    const panel = createDevicePanel(/** @type {any} */ (doc), {}, /** @type {*} */ ({ width: 256, height: 256 }));
    const root = /** @type {any} */ (doc.getElementById('device-panel'));
    panel.open(viewOf(BLOCK.CLOCKWORK_TIMER));
    const box = root.querySelector('.cc-head .cc-icon');
    expect(box).toBeTruthy();
    expect(box.children).toHaveLength(1);
    expect(box.children[0].tagName).toBe('CANVAS');
    expect([box.children[0].width, box.children[0].height]).toEqual([PANEL_ICON_PX, PANEL_ICON_PX]);
    expect(PANEL_ICON_PX).toBe(48);
    panel.dispose();
  });

  it('header, reading, settings, About (the origin and the tip) and Done; a wire shows only About', () => {
    const { root, panel } = setup(viewOf(BLOCK.CLOCKWORK_TIMER));
    expect(root.querySelector('.cc-title').textContent).toBe('Clockwork Timer');
    expect(root.querySelector('.cc-coords').textContent).toBe(`(0, ${FLOOR}, 0)`);
    expect(root.querySelector('.cc-label-input').getAttribute('maxlength')).toBe(String(MAX_PART_LABEL_CHARS));
    expect(root.querySelector('.cc-readout').textContent).toContain('Volts');
    expect(root.querySelector('.cc-about .cc-tip').textContent).toBe(partTip(BLOCK.CLOCKWORK_TIMER));
    expect(root.querySelector('.cc-about .cc-origin').textContent).toBe(partOrigin(BLOCK.CLOCKWORK_TIMER));
    expect(root.querySelector('.cc-done').textContent).toBe('Done');
    expect(root.querySelectorAll('.cc-chip').map((b) => b.textContent)).toEqual(['5 s', '10 s', '15 s', '30 s', '1 min', '5 min']);
    expect(root.querySelector('.cc-chip.active').textContent).toBe('5 s');
    expect(root.querySelectorAll('.cc-face-svg [data-face]')).toHaveLength(7);
    expect(root.querySelector('.cc-wedge.active').getAttribute('data-face')).toBe('3');
    // the input-face diagram: six plain wedges, each side's name just outside it, and a round top in the middle
    expect(root.querySelectorAll('.cc-face-svg .cc-face-name').map((t) => t.textContent)).toEqual(FACE_NAMES.slice(0, 6));
    expect(root.querySelectorAll('.cc-face-svg polygon')).toHaveLength(6);
    expect(root.querySelectorAll('.cc-face-svg circle')).toHaveLength(1);
    // the actions sit in the foot, before Done (always in view); the settings hold none
    expect(root.querySelectorAll('.cc-foot .cc-action').map((b) => b.textContent)).toEqual(['Start']);
    expect(root.querySelector('.cc-settings .cc-action')).toBeNull();
    const foot = root.querySelector('.cc-foot');
    expect(foot.children.map((c) => c.className)).toEqual(['cc-keys', 'cc-actions', 'cc-btn cc-done']);
    panel.open(viewOf(BLOCK.COPPER_WIRE));
    expect(root.querySelector('.cc-readout')).toBeNull();
    expect(root.querySelector('.cc-settings')).toBeNull();
    expect(root.querySelector('.cc-label-input')).toBeNull();
    expect(root.querySelector('.cc-actions')).toBeNull(); // nothing to do: the foot holds Done only
    expect(root.querySelector('.cc-about .cc-tip').textContent).toBe(partTip(BLOCK.COPPER_WIRE));
  });

  it('every control sends onChange(key, partial) with the store\'s field names, and shows it at once', () => {
    const view = viewOf(BLOCK.CLOCKWORK_TIMER);
    const { root, onChange } = setup(view);
    fire(root.querySelectorAll('.cc-chip')[4], 'click');
    expect(onChange).toHaveBeenLastCalledWith(view.key, { s: 60 });
    expect(root.querySelector('.cc-chip.active').textContent).toBe('1 min');
    fire(root.querySelector('.cc-seg-btn[data-value="repeat"]'), 'click');
    expect(onChange).toHaveBeenLastCalledWith(view.key, { m: 'repeat' });
    expect(root.querySelector('.cc-seg-btn[data-value="repeat"]').getAttribute('aria-pressed')).toBe('true');
    fire(root.querySelector('.cc-wedge[data-face="1"] polygon'), 'click');
    expect(onChange).toHaveBeenLastCalledWith(view.key, { f: 1 });
    expect(root.querySelector('.cc-face-caption').textContent).toBe(`${FACE_NAMES[1]} side · north is up`);
    fire(root.querySelector('.cc-wedge.cc-top circle'), 'click');
    expect(onChange).toHaveBeenLastCalledWith(view.key, { f: 6 });
    // the delay field: clamped to the store's grid
    const num = root.querySelector('.cc-number-input');
    num.value = '7.3';
    fire(num, 'change');
    expect(onChange).toHaveBeenLastCalledWith(view.key, { s: 7.5 });
    expect(num.value).toBe('7.5');
    num.value = '';
    fire(num, 'change');
    expect(num.value).toBe('7.5'); // nothing sent for an empty field
    expect(onChange).toHaveBeenCalledTimes(5);
    // the active half again: nothing
    fire(root.querySelector('.cc-seg-btn[data-value="repeat"]'), 'click');
    expect(onChange).toHaveBeenCalledTimes(5);
  });

  it('the dial, the NO | NC and Open | Closed switches, and the action buttons', () => {
    const tx = viewOf(BLOCK.SPARK_TRANSMITTER);
    const a = setup(tx);
    const waves = a.root.querySelectorAll('.cc-wave');
    expect(waves).toHaveLength(16);
    expect(a.root.querySelectorAll('.cc-dial-row').map((r) => r.children.length)).toEqual([8, 8]);
    expect(a.root.querySelector('.cc-wave.distress').textContent).toBe('600');
    fire(waves[6], 'click');
    expect(a.onChange).toHaveBeenLastCalledWith(tx.key, { ch: 7 });
    expect(waves[6].classList.contains('active')).toBe(true);
    fire(a.root.querySelector('.cc-action'), 'click');
    expect(a.onAction).toHaveBeenLastCalledWith(tx.key, 'send');
    expect(a.root.querySelector('.cc-action').textContent).toBe(ACTION_LABELS.send);

    const btn = viewOf(BLOCK.PUSH_BUTTON);
    const b = setup(btn);
    fire(b.root.querySelector('.cc-seg-btn[data-value="true"]'), 'click');
    expect(b.onChange).toHaveBeenLastCalledWith(btn.key, { nc: true });

    const sw = viewOf(BLOCK.KNIFE_SWITCH);
    const c = setup(sw);
    expect(c.root.querySelectorAll('.cc-seg-btn').map((x) => x.textContent)).toEqual(['Open', 'Closed']);
    fire(c.root.querySelector('.cc-seg-btn[data-value="true"]'), 'click');
    expect(c.onChange).toHaveBeenLastCalledWith(sw.key, { on: true });

    const bat = viewOf(BLOCK.VOLTAIC_BATTERY);
    const d = setup(bat);
    expect(d.root.querySelector('.cc-charge-text').textContent).toBe('100 % · 6 V');
    fire(d.root.querySelector('.cc-action-refill'), 'click');
    expect(d.onAction).toHaveBeenLastCalledWith(bat.key, 'refill');
  });

  it('the label: debounced while typing, sent at once on close; Enter in it closes', () => {
    vi.useFakeTimers();
    const view = viewOf(BLOCK.KNIFE_SWITCH);
    const { root, panel, onChange, onClose } = setup(view);
    const input = root.querySelector('.cc-label-input');
    input.focus();
    input.value = 'Front';
    fire(input, 'input');
    input.value = 'Front door';
    fire(input, 'input');
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LABEL_DEBOUNCE_MS + 1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(view.key, { l: 'Front door' });
    input.value = 'Front gate';
    fire(input, 'input');
    fire(input, 'keydown', { key: 'Enter', code: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(view.key, { l: 'Front gate' });
    expect(onClose).toHaveBeenCalledTimes(1);
    panel.close();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(panel.isOpen()).toBe(false);
    expect(root.classList.contains('hidden')).toBe(true);
  });

  it('Done, Esc and the Shift+R key close (the Shift+R key types into a text field instead)', () => {
    const { root, doc, onClose } = setup(viewOf(BLOCK.RELAY));
    fire(root.querySelector('.cc-done'), 'click');
    expect(onClose).toHaveBeenCalledTimes(1);
    doc.dispatch({ type: 'keydown', key: 'Escape', code: 'Escape', target: doc.body });
    expect(onClose).toHaveBeenCalledTimes(2);
    doc.dispatch({ type: 'keydown', key: 'R', code: 'KeyR', shiftKey: true, target: doc.body });
    expect(onClose).toHaveBeenCalledTimes(3);
    const input = root.querySelector('.cc-label-input');
    fire(input, 'keydown', { key: 'R', code: 'KeyR', shiftKey: true });
    expect(onClose).toHaveBeenCalledTimes(3);
    doc.dispatch({ type: 'keydown', key: 'r', code: 'KeyR', target: doc.body }); // R without Shift: nothing
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('←/→ on an input-face picker walk the faces', () => {
    const view = viewOf(BLOCK.RELAY);
    const { root, onChange } = setup(view);
    const svg = root.querySelector('.cc-face-svg');
    fire(svg, 'keydown', { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(view.key, { f: 4 });
    fire(svg, 'keydown', { key: 'ArrowLeft' });
    fire(svg, 'keydown', { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(view.key, { f: 2 });
  });

  it('refresh keeps the panel in step; a view of another cell is ignored; a new action set rebuilds the settings', () => {
    const env = makeCircuitWorld();
    env.put(0, 0, BLOCK.CLOCKWORK_TIMER);
    env.ticks(1);
    const { root, panel } = setup(env.circuits.panelView(0, FLOOR, 0, true));
    expect(root.querySelector('.cc-action').textContent).toBe('Start');
    env.circuits.applySettings(0, FLOOR, 0, { s: 15, m: 'hold' });
    env.circuits.timerAt(0, FLOOR, 0, 'start');
    env.ticks(1);
    panel.refresh(env.circuits.panelView(0, FLOOR, 0, true));
    expect(root.querySelector('.cc-action').textContent).toBe('Stop');
    expect(root.querySelector('.cc-chip.active').textContent).toBe('15 s');
    expect(root.querySelector('.cc-seg-btn.active').textContent).toBe('Hold');
    expect(root.querySelector('.cc-number-input').value).toBe('15');
    panel.refresh({ ...viewOf(BLOCK.RELAY), key: '9,9,9' });
    expect(root.querySelector('.cc-title').textContent).toBe('Clockwork Timer');
    panel.refresh(null);
    expect(panel.getKey()).toBe(`0,${FLOOR},0`);
  });

  it('getKey / isOpen / dispose; the layer is created when index.html has none', () => {
    const { panel, doc } = setup(viewOf(BLOCK.FILAMENT_LAMP));
    expect(panel.isOpen()).toBe(true);
    expect(panel.getKey()).toBe(`0,${FLOOR},0`);
    panel.dispose();
    expect(panel.isOpen()).toBe(false);
    expect(doc.listenerCount('keydown')).toBe(0);

    const bare = documentFromHTML('<div id="hud"></div>');
    const p2 = createDevicePanel(/** @type {any} */ (bare), {});
    expect(bare.getElementById('device-panel')).toBeTruthy();
    p2.open(viewOf(BLOCK.IGNITER));
    expect(bare.getElementById('device-panel').classList.contains('hidden')).toBe(false);
    p2.dispose();
  });
});
