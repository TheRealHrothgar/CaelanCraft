// Caelancraft — what a Creative hotbar slot holds (CONTRACTS §98). PURE.
//
// A "pick" is a BLOCK ID (a number, as the Creative hotbar always held) or the KEY of an item that is not a block (a
// string: a tool, a weapon, food, a material, clothes, a bandage), so a Creative player can hold every item of the game.
// Blocks stay numbers (old saves read unchanged); a block's item is never stored as its key.
import { BLOCK, getBlockDef } from './blocks.js';
import { getItem, itemName, itemForBlock, canonicalItemKey } from './items.js';

/** @typedef {number|string} Pick */

/** @param {unknown} v @returns {v is string} the key of an item that is not a block */
export function isItemPick(v) {
  if (typeof v !== 'string') return false;
  const def = getItem(v);
  return !!def && def.kind !== 'block';
}

/** @param {unknown} v @returns {v is Pick} a block id (0..255; AIR is an empty slot) or an item pick */
export function isHotbarPick(v) {
  return (Number.isInteger(v) && /** @type {number} */ (v) >= 0 && /** @type {number} */ (v) <= 255) || isItemPick(v);
}

/**
 * A pick as a save (or the wire) carries it, made current: an old item key under its new name (§64 aliases); null when
 * it is no pick at all.
 * @param {unknown} v @returns {Pick|null}
 */
export function normalizePick(v) {
  const c = typeof v === 'string' ? canonicalItemKey(v) : v;
  return isHotbarPick(c) ? /** @type {Pick} */ (c) : null;
}

/** @param {Pick} v @returns {string|null} the item in hand for this pick (a block's item; null for AIR) */
export function pickItemKey(v) {
  if (typeof v === 'string') return isItemPick(v) ? v : null;
  return Number.isInteger(v) && v !== BLOCK.AIR ? itemForBlock(v) : null;
}

/** @param {Pick} v @returns {string} its display name ("Iron Pick", "Oak Planks") */
export function pickName(v) {
  return typeof v === 'string' ? itemName(v) : getBlockDef(v).displayName;
}

/** @param {Pick} v @returns {boolean} an empty slot */
export function isEmptyPick(v) {
  return v === BLOCK.AIR || v === null || v === undefined;
}
