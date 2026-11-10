// Caelancraft — survival containers: wicker baskets and "Your Belongings", keyed by cell. Pure. See
// docs/DESIGN-survival.md §5.6, §2.5 and §9.6 (CONTRACTS §43 once merged).
//
// A container is a block (WICKER_BASKET or REMAINS) plus an entry here, keyed "q,y,r" like runes and campfires. Main keeps
// the store in step through World.onBlockChange:
// - placing a basket creates an empty basket entry (in Creative too, so a later Survival visit finds an empty basket),
//   unless MAX_CONTAINERS entries exist already: that basket has no storage;
// - when a container cell changes to anything else, its entry is removed and its stacks are RELEASED (returned). Main
//   puts them into the pack when the player broke the cell in Survival (its `releaseToPack` flag), otherwise they are lost;
// - belongings are made only by a death (`addRemains`), which always gets its entry, beyond the cap.
//
// Entries in memory: `{ kind, q, y, r, slots }`; a basket always has BASKET_SLOTS slots, belongings at most REMAINS_SLOTS.
// Stacks are values (see inventory.js): change a slot by replacing it, then call `touch()`.
import { BASKET_SLOTS, REMAINS_SLOTS, MAX_CONTAINERS } from './config.js';
import { BLOCK } from './blocks.js';
import { copyStack, stackProblem, spoilSlots, countsToStacks, aggregateStacks, withCurrentKey } from './inventory.js';

/** @typedef {import('./types.js').ItemStack} ItemStack */
/** @typedef {import('./types.js').ContainersJSON} ContainersJSON */

/**
 * @typedef {Object} ContainerEntry
 * @property {'basket'|'remains'} kind
 * @property {number} q
 * @property {number} y
 * @property {number} r
 * @property {(ItemStack|null)[]} slots
 */

/** The two kinds: their block, slot count and the title of their rosette. */
export const CONTAINER_KINDS = Object.freeze({
  basket: Object.freeze({ block: BLOCK.WICKER_BASKET, slots: BASKET_SLOTS, title: 'Wicker Basket' }),
  remains: Object.freeze({ block: BLOCK.REMAINS, slots: REMAINS_SLOTS, title: 'Your Belongings' }),
});

/** "q,y,r" */
export function containerKey(q, y, r) {
  return `${q},${y},${r}`;
}

const KEY_RE = /^(-?\d+),(-?\d+),(-?\d+)$/;

/** Inverse of containerKey. @param {string} key @returns {[number, number, number]|null} null when malformed */
export function parseContainerKey(key) {
  const m = typeof key === 'string' ? KEY_RE.exec(key) : null;
  if (!m) return null;
  const out = /** @type {[number, number, number]} */ ([Number(m[1]), Number(m[2]), Number(m[3])]);
  return out.every(Number.isSafeInteger) ? out : null;
}

/** @param {ContainerEntry} e @returns {boolean} */
function entryHasItems(e) {
  return e.slots.some((s) => s !== null);
}

export class Containers {
  constructor() {
    /** @type {Map<string, ContainerEntry>} key "q,y,r" → entry */
    this.entries = new Map();
    /** Bumped on every change (main autosaves on it). */
    this.version = 0;
  }

  /** Number of entries (main writes `containers` into the save only when this is non-zero). */
  get size() {
    return this.entries.size;
  }

  /** Mark the store changed (after replacing slots of an entry in place, e.g. by inventory.slotClick). */
  touch() {
    this.version++;
  }

  /** @returns {ContainerEntry|null} the live entry at the cell */
  get(q, y, r) {
    return this.entries.get(containerKey(q, y, r)) ?? null;
  }

  /** @returns {boolean} the cell has an entry holding at least one stack (Creative refuses to break it, §5.5) */
  hasItems(q, y, r) {
    const e = this.get(q, y, r);
    return !!e && entryHasItems(e);
  }

  /** @returns {ItemStack[]} copies of the entry's stacks in slot order (empty when there is no entry) */
  contents(q, y, r) {
    const e = this.get(q, y, r);
    return e ? /** @type {ItemStack[]} */ (e.slots.filter((s) => s !== null).map(copyStack)) : [];
  }

  /** @returns {string} the rosette title for an entry kind */
  static title(kind) {
    return CONTAINER_KINDS[kind]?.title ?? '?';
  }

  /**
   * The basket entry at a WICKER_BASKET cell, creating an empty one when it has none and the cap allows (for a basket
   * whose entry was never made or not saved). Never replaces a belongings entry.
   * @returns {ContainerEntry|null} null when the cap is reached (the basket has no storage)
   */
  ensureBasket(q, y, r) {
    const key = containerKey(q, y, r);
    const had = this.entries.get(key);
    if (had) return had.kind === 'basket' ? had : null;
    if (this.entries.size >= MAX_CONTAINERS) return null;
    /** @type {ContainerEntry} */
    const e = { kind: 'basket', q, y, r, slots: new Array(BASKET_SLOTS).fill(null) };
    this.entries.set(key, e);
    this.version++;
    return e;
  }

  /**
   * World.onBlockChange (main calls it for every write). A cell holding an entry that changes to anything but the entry's
   * block loses its entry, and the stacks come back; a cell that becomes WICKER_BASKET gets an empty basket entry.
   * @returns {ItemStack[]} the released stacks (slot order); main gives them to the pack when the player broke the cell in
   *   Survival, else they are lost
   */
  onBlockChange(q, y, r, prev, next) {
    if (prev === next) return [];
    const key = containerKey(q, y, r);
    const e = this.entries.get(key);
    /** @type {ItemStack[]} */
    let released = [];
    if (e && CONTAINER_KINDS[e.kind].block !== next) {
      released = /** @type {ItemStack[]} */ (e.slots.filter((s) => s !== null));
      this.entries.delete(key);
      this.version++;
    }
    if (next === BLOCK.WICKER_BASKET) this.ensureBasket(q, y, r);
    return released;
  }

  /**
   * R on belongings (§2.5): move every stack that fits into the pack; whatever does not fit stays inside.
   * @param {{ add(stack: ItemStack): ItemStack|null }} pack
   * @returns {{ moved: ItemStack[], empty: boolean }} what went into the pack (by key), and whether the entry is now empty
   *   (main then writes AIR). A cell with no entry is empty.
   */
  takeAll(q, y, r, pack) {
    const e = this.get(q, y, r);
    if (!e) return { moved: [], empty: true };
    /** @type {ItemStack[]} */
    const moved = [];
    let changed = false;
    for (let i = 0; i < e.slots.length; i++) {
      const s = e.slots[i];
      if (!s) continue;
      const over = pack.add(s);
      if (over && over.n === s.n) continue;
      changed = true;
      moved.push({ ...copyStack(s), n: s.n - (over ? over.n : 0) });
      e.slots[i] = over;
    }
    if (changed) this.version++;
    return { moved: aggregateStacks(moved), empty: !entryHasItems(e) };
  }

  /**
   * A death's belongings (§2.5): a REMAINS entry with these stacks (the first REMAINS_SLOTS of them), beyond the cap.
   * Any entry already at the cell is replaced and its stacks are returned.
   * @param {ItemStack[]} stacks
   * @returns {ItemStack[]} stacks that did not go in (beyond REMAINS_SLOTS, or an old entry's)
   */
  addRemains(q, y, r, stacks) {
    const key = containerKey(q, y, r);
    const old = this.entries.get(key);
    /** @type {ItemStack[]} */
    const lost = old ? /** @type {ItemStack[]} */ (old.slots.filter((s) => s !== null)) : [];
    const kept = [];
    for (const s of stacks) {
      if (!s) continue;
      if (kept.length < REMAINS_SLOTS) kept.push(copyStack(s));
      else lost.push(s);
    }
    this.entries.set(key, { kind: 'remains', q, y, r, slots: kept });
    this.version++;
    return lost;
  }

  /**
   * Spoilage (§4.5) in every entry whose chunk is loaded. Call once a second (dt = 1) while Survival is active.
   * @param {number} dt @param {() => number} random
   * @param {(q: number, r: number) => boolean} isLoadedCell
   * @returns {ItemStack[]} what went bad, one stack per key
   */
  spoil(dt, random, isLoadedCell) {
    const spoiled = new Map();
    let changed = false;
    for (const e of this.entries.values()) {
      if (!isLoadedCell(e.q, e.r)) continue;
      if (spoilSlots(e.slots, dt, random, spoiled)) changed = true;
    }
    if (changed) this.version++;
    return countsToStacks(spoiled);
  }

  clear() {
    if (this.entries.size) this.version++;
    this.entries.clear();
  }

  /**
   * @returns {ContainersJSON} every entry (empty baskets too, so they keep their storage), keys sorted by (q, y, r);
   *   slot copies with nulls kept
   */
  export() {
    const list = [...this.entries.values()].sort((a, b) => a.q - b.q || a.y - b.y || a.r - b.r);
    /** @type {ContainersJSON} */
    const out = {};
    for (const e of list) out[containerKey(e.q, e.y, e.r)] = { kind: e.kind, slots: e.slots.map(copyStack) };
    return out;
  }

  /**
   * Replace the store from a ContainersJSON (null or garbage → empty). Malformed keys, unknown kinds, too many slots and
   * baskets beyond MAX_CONTAINERS are dropped; bad stacks become null. (storage.js also checks the cells against the
   * edits; this only keeps the store sound.)
   * @param {any} json
   * @returns {string[]} one line per repair
   */
  load(json) {
    this.entries.clear();
    this.version++;
    const warnings = [];
    if (!json || typeof json !== 'object' || Array.isArray(json)) return warnings;
    let baskets = 0;
    for (const [key, raw] of Object.entries(json)) {
      const cell = parseContainerKey(key);
      const spec = raw && typeof raw === 'object' && Object.hasOwn(CONTAINER_KINDS, raw.kind) ? CONTAINER_KINDS[raw.kind] : null;
      if (!cell) warnings.push(`containers[${key}]: malformed key, dropped`);
      else if (!spec) warnings.push(`containers[${key}]: unknown kind, dropped`);
      else if (!Array.isArray(raw.slots) || raw.slots.length > spec.slots) warnings.push(`containers[${key}]: bad slots, dropped`);
      else if (raw.kind === 'basket' && baskets >= MAX_CONTAINERS) warnings.push(`containers[${key}]: too many containers, dropped`);
      else {
        const slots = raw.kind === 'basket' ? new Array(BASKET_SLOTS).fill(null) : new Array(raw.slots.length).fill(null);
        raw.slots.forEach((/** @type {any} */ s0, /** @type {number} */ i) => {
          if (s0 === null || s0 === undefined) return;
          const s = withCurrentKey(s0); // v0.10: an old `black_hole` / `blast_barrel` stack keeps its place
          const why = stackProblem(s);
          if (why) warnings.push(`containers[${key}][${i}]: ${why}, dropped`);
          else slots[i] = copyStack(s);
        });
        if (raw.kind === 'basket') baskets++;
        const [q, y, r] = cell;
        this.entries.set(containerKey(q, y, r), { kind: raw.kind, q, y, r, slots });
      }
    }
    return warnings;
  }
}

