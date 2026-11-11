// Unit tests for the Worlds panel's pure text helpers (src/menus.js), main's save-failure messages and the ?slot URL
// parameter — see src/CONTRACTS.md §41, §20, §22 and §23. The DOM side is checked in a real browser (screenshots).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  formatBytes, formatLastPlayed, slotDetailText, usageLabel, usageLevel, deleteConfirmText, latestSlot,
  createMenus, SURVIVAL_RESOURCES_LABEL,
} from '../../src/menus.js';
import { documentFromHTML, fire } from '../helpers/fakeDom.js';
import { saveFailMessage, worldsFailMessage, quitUnsavedMessage } from '../../src/main.js';
import { parseParams } from '../../src/diagnostics.js';
import { STORAGE_QUOTA_ESTIMATE } from '../../src/storage.js';

const NOW = 1_750_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const world = (slot, extra = {}) => ({
  slot, status: 'world', name: `World ${slot}`, seed: 1000 + slot, createdAt: NOW - DAY, lastPlayed: NOW - HOUR, bytes: 40_000,
  legacy: false, ...extra,
});
const empty = (slot) => ({ slot, status: 'empty', name: '', seed: null, createdAt: 0, lastPlayed: 0, bytes: 0, legacy: false });
const damaged = (slot) => ({ ...empty(slot), status: 'damaged', bytes: 900 });

describe('Worlds panel text', () => {
  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1500)).toBe('1 KB');
    expect(formatBytes(37 * 1024)).toBe('37 KB');
    expect(formatBytes(1024 * 1024 - 1)).toBe('1023 KB');
    expect(formatBytes(1.24 * 1024 * 1024)).toBe('1.2 MB');
    expect(formatBytes(STORAGE_QUOTA_ESTIMATE)).toBe('5 MB');
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
  });

  it('formatLastPlayed reads like a person would say it', () => {
    expect(formatLastPlayed(NOW - 5_000, NOW)).toBe('just now');
    expect(formatLastPlayed(NOW + 50_000, NOW)).toBe('just now'); // clock moved back
    expect(formatLastPlayed(NOW - MIN, NOW)).toBe('1 minute ago');
    expect(formatLastPlayed(NOW - 59 * MIN, NOW)).toBe('59 minutes ago');
    expect(formatLastPlayed(NOW - HOUR, NOW)).toBe('1 hour ago');
    expect(formatLastPlayed(NOW - 2 * HOUR - 5 * MIN, NOW)).toBe('2 hours ago');
    expect(formatLastPlayed(NOW - 30 * HOUR, NOW)).toBe('yesterday');
    expect(formatLastPlayed(NOW - 3 * DAY, NOW)).toBe('3 days ago');
    expect(formatLastPlayed(NOW - 45 * DAY, NOW)).toBe('1 month ago');
    expect(formatLastPlayed(NOW - 200 * DAY, NOW)).toBe('6 months ago');
    expect(formatLastPlayed(NOW - 800 * DAY, NOW)).toBe('2 years ago');
    expect(formatLastPlayed(0, NOW)).toBe('');
    expect(formatLastPlayed(NaN, NOW)).toBe('');
  });

  it('a row\'s detail line: seed, last played (when known), size; damaged and empty slots say so', () => {
    expect(slotDetailText(world(2, { lastPlayed: NOW - 2 * HOUR, bytes: 37 * 1024 }), NOW)).toBe('Seed 1002 · played 2 hours ago · 37 KB');
    expect(slotDetailText(world(2, { lastPlayed: 0, bytes: 600 }), NOW)).toBe('Seed 1002 · 600 B');
    expect(slotDetailText(damaged(3), NOW)).toBe("Can't be read · 900 B");
    expect(slotDetailText(empty(4), NOW)).toBe('No world yet');
  });

  it('usage line and bar level', () => {
    expect(usageLabel({ used: 1.24 * 1024 * 1024, quota: STORAGE_QUOTA_ESTIMATE, fraction: 0.248 })).toBe('1.2 MB of ~5 MB (25%)');
    expect(usageLabel({ used: 0, quota: STORAGE_QUOTA_ESTIMATE, fraction: 0 })).toBe('0 B of ~5 MB (0%)');
    expect(usageLevel(0.5)).toBe('');
    expect(usageLevel(0.8)).toBe('warn');
    expect(usageLevel(0.95)).toBe('full');
  });

  it('the delete dialog names the world', () => {
    expect(deleteConfirmText(world(3, { name: 'Castle' }))).toEqual({
      title: 'Delete “Castle”?', detail: 'Slot 3 · seed 1003. This cannot be undone.',
    });
    expect(deleteConfirmText(damaged(5)).title).toBe('Delete the damaged world in slot 5?');
  });

  it('latestSlot is the most recently played world (0 when none)', () => {
    expect(latestSlot([world(1, { lastPlayed: 10 }), empty(2), world(3, { lastPlayed: 30 }), damaged(4)])).toBe(3);
    expect(latestSlot([empty(1), damaged(2)])).toBe(0);
    expect(latestSlot(null)).toBe(0);
  });
});

describe('save failure messages (main)', () => {
  it('a full storage says so and suggests deleting a world', () => {
    expect(saveFailMessage('quota')).toMatch(/storage full/);
    expect(saveFailMessage('quota')).toMatch(/delete a world/);
    expect(saveFailMessage('error')).toBe('Save failed');
    // KNOWN-ISSUES (save slots): the line after quitting unsaved says why, and whether an older save is still there
    expect(quitUnsavedMessage('Castle', 'quota', true)).toBe('“Castle” was not saved: storage is full. Its last save is kept. Delete a world to make room.');
    expect(quitUnsavedMessage('Castle', 'quota', false)).toMatch(/never been saved, so it is gone/);
    expect(quitUnsavedMessage('Castle', 'unavailable', false)).toMatch(/not letting the game store anything/);
    expect(quitUnsavedMessage('Castle', 'unavailable', false)).not.toMatch(/storage is full|last save is kept/);
    expect(quitUnsavedMessage('Castle', undefined, true)).toBe('“Castle” was not saved. Its last save is kept.');
    expect(saveFailMessage(undefined)).toBe('Save failed');
    expect(worldsFailMessage('duplicate', 'quota')).toMatch(/delete a world/);
    expect(worldsFailMessage('duplicate', 'full')).toMatch(/No empty slot/);
    expect(worldsFailMessage('rename', 'damaged')).toMatch(/damaged/);
  });
});

describe('?slot=N', () => {
  it('accepts 1..6 only', () => {
    expect(parseParams('').slot).toBeNull();
    expect(parseParams('?slot=1').slot).toBe(1);
    expect(parseParams('?autoplay=1&slot=6').slot).toBe(6);
    for (const bad of ['0', '7', '2.5', 'two', '', '-1']) expect(parseParams(`?slot=${bad}`).slot, bad).toBeNull();
  });
});

describe('Worlds panel: Survival (DESIGN-survival §9.8)', () => {
  it('a world in Survival says so at the end of its detail line; Creative worlds read as before', () => {
    expect(slotDetailText(world(2, { lastPlayed: NOW - 2 * HOUR, bytes: 37 * 1024, mode: 'survival' }), NOW))
      .toBe('Seed 1002 · played 2 hours ago · 37 KB · Survival');
    expect(slotDetailText(world(2, { lastPlayed: 0, bytes: 600, mode: 'survival' }), NOW)).toBe('Seed 1002 · 600 B · Survival');
    expect(slotDetailText(world(2, { lastPlayed: 0, bytes: 600, mode: 'creative' }), NOW)).toBe('Seed 1002 · 600 B');
    expect(slotDetailText(world(2, { lastPlayed: 0, bytes: 600 }), NOW)).toBe('Seed 1002 · 600 B');
    expect(slotDetailText({ ...damaged(3), mode: 'survival' }, NOW)).toBe("Can't be read · 900 B");
  });

  /** The menus on a fake DOM built from index.html, with the title showing these slots. */
  function titleWith(slots, callbacks) {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // no real canvas for the atlas helpers
    const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
    const doc = documentFromHTML(html);
    const menus = createMenus(/** @type {any} */ (doc), /** @type {any} */ ({}), callbacks);
    menus.showTitle(slots, { now: NOW });
    return { doc, menus, list: /** @type {any} */ (doc.getElementById('worlds-list')) };
  }

  it('the row shows the Survival detail', () => {
    const { list } = titleWith([world(1, { mode: 'survival', lastPlayed: 0, bytes: 600 }), empty(2)], {});
    expect(list.querySelector('li[data-slot="1"] .slot-detail').textContent).toBe('Seed 1001 · 600 B · Survival');
    vi.restoreAllMocks();
  });

  it('the New World form has the "Survival resources" checkbox, checked by default, and its value reaches onNewWorld', () => {
    const onNewWorld = vi.fn();
    const { list } = titleWith([world(1), empty(2), empty(3)], { onNewWorld });
    list.querySelector('li[data-slot="2"] button[data-action="new"]').click();
    const form = list.querySelector('form.slot-form');
    const box = form.querySelector('input.slot-survival-input');
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(true);
    expect(form.querySelector('label.slot-check').textContent).toBe(SURVIVAL_RESOURCES_LABEL);
    expect(SURVIVAL_RESOURCES_LABEL).toBe('Survival resources (wild plants, ponds, copper and tin)');
    fire(form, 'submit');
    expect(onNewWorld).toHaveBeenLastCalledWith(2, 'World 2', '', { survivalResources: true });
    // cleared: generation 1, today's land
    list.querySelector('li[data-slot="3"] button[data-action="new"]').click();
    const form3 = list.querySelector('form.slot-form');
    form3.querySelector('input.slot-survival-input').checked = false;
    form3.querySelector('.slot-name-input').value = 'Flatlands';
    fire(form3, 'submit');
    expect(onNewWorld).toHaveBeenLastCalledWith(3, 'Flatlands', '', { survivalResources: false });
    vi.restoreAllMocks();
  });

  it('Rename has no checkbox', () => {
    const { list } = titleWith([world(1), empty(2)], {});
    list.querySelector('li[data-slot="1"] button[data-action="rename"]').click();
    expect(list.querySelector('form.slot-form .slot-survival-input')).toBeNull();
    vi.restoreAllMocks();
  });
});
