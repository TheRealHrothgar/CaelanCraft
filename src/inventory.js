// Caelancraft — the survival pack: 27 slots (0..8 the hotbar strip, 9..26 the rosette) and 3 worn items, the stack rules,
// the pack screen's mouse rules (`slotClick`) and stateless spoilage. Pure. See docs/DESIGN-survival.md §5.2–§5.4 and
// §4.5 (CONTRACTS §43 once merged).
//
// Stacks (`ItemStack = { k, n, d? }`) are treated as values: the pack never changes a stack object in place, it puts a
// new one in the slot. So `export()`, a pack-screen view or a caller may keep a stack it was given without seeing it change
// underneath. `version` goes up on every change (main autosaves on it and the HUD redraws on it).
//
// `Pack` also implements PackOps, the narrow surface crafting.js uses (count, countTag, take, takeTag, canGive, give,
// hasTool, useTool), so crafting imports no inventory code.
import { PACK_SLOTS, WEAR_SLOTS, HOTBAR_SIZE } from './config.js';
import { TAGS, WEAR_SLOT_NAMES, canonicalItemKey, getItem, isItemKey, itemName, stackSize, maxDurability } from './items.js';

/** @typedef {import('./types.js').ItemStack} ItemStack */
/** @typedef {import('./types.js').ToolDef} ToolDef */
/** @typedef {import('./types.js').ItemDef} ItemDef */

/**
 * Items that stay with you (§14.2, the Survival Handbook): `dumpAll()` (death) leaves them in the pack, and the pack screen
 * never lets one go: the discard hex and a basket refuse it (the cursor keeps it), and closing the screen with one on the
 * cursor never leaves it behind.
 */
export const KEEP_ON_DEATH = Object.freeze(['handbook']);
/** What `slotClick` reports (`result.refused`) when it refuses to let a KEEP_ON_DEATH item go. */
export const KEEP_REFUSED = 'The handbook stays with you.';

/** @param {ItemStack|null|undefined} s @returns {boolean} a stack of an item that stays with you */
export function isKept(s) {
  return !!s && KEEP_ON_DEATH.includes(s.k);
}

// ---------------------------------------------------------------------------------------------------------------------
// Stack helpers

/**
 * A new stack. `d` (durability left) is set only when given; absent means new (full).
 * @param {string} k @param {number} [n=1] @param {number} [d]
 * @returns {ItemStack}
 */
export function makeStack(k, n = 1, d) {
  return d === undefined ? { k, n } : { k, n, d };
}

/** @param {ItemStack|null|undefined} s @returns {ItemStack|null} a copy (only k, n and d), or null */
export function copyStack(s) {
  if (!s) return null;
  return s.d === undefined ? { k: s.k, n: s.n } : { k: s.k, n: s.n, d: s.d };
}

/** @param {ItemStack} s @param {number} n @returns {ItemStack} the same item (and durability) with count n */
function withCount(s, n) {
  return s.d === undefined ? { k: s.k, n } : { k: s.k, n, d: s.d };
}

/**
 * Two stacks merge when they hold the same key and neither carries a durability (§5.2); whether there is room is a
 * separate question (`stackSize`).
 * @param {ItemStack|null} a @param {ItemStack|null} b
 */
export function canMerge(a, b) {
  return !!a && !!b && a.k === b.k && a.d === undefined && b.d === undefined;
}

/** "3 Rock" — a stack as chat text ("Pack full: 2 Rock left behind"). @param {ItemStack} s */
export function stackLabel(s) {
  return `${s.n} ${itemName(s.k)}`;
}

/** @param {ItemStack|null} s @returns {number} durability left: `d`, or the full durability when absent; 0 = none */
export function durabilityLeft(s) {
  if (!s) return 0;
  const max = maxDurability(s.k);
  return max === 0 ? 0 : (s.d ?? max);
}

/**
 * A saved stack with an old item key (items.ITEM_ALIASES: `black_hole`, `blast_barrel`) as a copy under its current key
 * (DESIGN-circuits §8.3); anything else is returned unchanged.
 * @param {any} s
 */
export function withCurrentKey(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s) || typeof s.k !== 'string') return s;
  const k = canonicalItemKey(s.k);
  return k === s.k ? s : { ...s, k };
}

/**
 * Why a stack is not valid, or null when it is (§5.2, the reasons of DESIGN-survival §9.6).
 * @param {any} s
 * @param {number} [wearSlot] when given, the stack must be a wear item for that wear slot (0 head, 1 body, 2 feet)
 * @returns {string|null}
 */
export function stackProblem(s, wearSlot) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not an item stack';
  if (!isItemKey(s.k)) return `unknown item "${String(s.k)}"`;
  const max = stackSize(s.k);
  if (!Number.isInteger(s.n) || s.n < 1 || s.n > max) return `count is not 1–${max}`;
  if (s.d !== undefined) {
    const dMax = maxDurability(s.k);
    if (dMax === 0) return `${s.k} has no durability`;
    if (!Number.isInteger(s.d) || s.d < 1 || s.d > dMax) return `durability is not 1–${dMax}`;
  }
  if (wearSlot !== undefined) {
    const wear = getItem(s.k)?.wear;
    if (!wear) return 'a wear slot holds a non-wear item';
    if (wear.slot !== WEAR_SLOT_NAMES[wearSlot]) return `a ${wear.slot} item in the ${WEAR_SLOT_NAMES[wearSlot]} slot`;
  }
  return null;
}

/**
 * Put as much of `stack` as fits into `slots[i]` for i in `order`: first merged into same-key stacks, then into empty
 * slots, in that order (§5.3). Writes new stack objects into `slots`; never touches `stack`.
 * @param {(ItemStack|null)[]} slots
 * @param {ItemStack} stack
 * @param {ArrayLike<number>} order slot indices to try, in order
 * @returns {number} how many did not fit
 */
export function fitStack(slots, stack, order) {
  const max = stackSize(stack.k);
  let left = stack.n;
  if (max === 0 || !(left > 0)) return Math.max(0, left || 0);
  if (stack.d === undefined) {
    for (let j = 0; j < order.length && left > 0; j++) {
      const i = order[j];
      const s = slots[i];
      if (s && s.k === stack.k && s.d === undefined && s.n < max) {
        const put = Math.min(max - s.n, left);
        slots[i] = { k: s.k, n: s.n + put };
        left -= put;
      }
    }
  }
  for (let j = 0; j < order.length && left > 0; j++) {
    const i = order[j];
    if (slots[i]) continue;
    const put = Math.min(max, left);
    slots[i] = withCount(stack, put);
    left -= put;
  }
  return left;
}

/** @param {number} from @param {number} to (exclusive) @returns {number[]} */
function range(from, to) {
  const out = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
}

/** Slot order for adding: 0 → 26, so new finds land in the hotbar first. */
const ADD_ORDER = Object.freeze(range(0, PACK_SLOTS));
const HOTBAR_ORDER = Object.freeze(range(0, HOTBAR_SIZE));
const ROSETTE_ORDER = Object.freeze(range(HOTBAR_SIZE, PACK_SLOTS));

/**
 * Stateless spoilage (§4.5) over one slot array: each perishable stack (`food.spoilS`) loses 1 item with probability
 * `min(1, n·dt / spoilS)`. Exactly one `random()` per perishable stack, in slot order; none for anything else.
 * v0.14 (§76 water): a food with `spoilsTo` does not vanish — the spoiled item TURNS INTO that item (a Pot of Water left
 * standing becomes a Pot of Tainted Water). A stack of one turns where it lies; from a bigger stack the turned item is put
 * with `fitStack` (a stack of its kind, else the first empty slot of this array) and, when there is no room for it, nothing
 * spoils this time. The roll, its probability and the one-`random()`-per-perishable-stack rule are unchanged.
 * @param {(ItemStack|null)[]} slots   changed in place (new stack objects)
 * @param {number} dt seconds
 * @param {() => number} random [0, 1)
 * @param {Map<string, number>} spoiled  key → count that went bad (added to; the ORIGINAL key, also for one that turned)
 * @param {(key: string) => ({ food?: import('./types.js').FoodDef }|null)} [itemOf]  the item registry (items.getItem;
 *   a test's stand-in)
 * @returns {boolean} whether anything spoiled
 */
export function spoilSlots(slots, dt, random, spoiled, itemOf = getItem) {
  if (!(dt > 0)) return false;
  let changed = false;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s) continue;
    const food = itemOf(s.k)?.food;
    const spoilS = food?.spoilS;
    if (!spoilS) continue;
    if (random() < Math.min(1, (s.n * dt) / spoilS)) {
      const to = food.spoilsTo;
      if (to === undefined) {
        slots[i] = s.n > 1 ? withCount(s, s.n - 1) : null;
      } else if (s.n === 1) {
        slots[i] = { k: to, n: 1 };
      } else {
        // one of several turns: it needs a place of its own in this slot array, or the stack stays good for now
        slots[i] = withCount(s, s.n - 1);
        if (fitStack(slots, { k: to, n: 1 }, range(0, slots.length)) > 0) {
          slots[i] = s;
          continue;
        }
      }
      spoiled.set(s.k, (spoiled.get(s.k) ?? 0) + 1);
      changed = true;
    }
  }
  return changed;
}

/** @param {Map<string, number>} counts @returns {ItemStack[]} one stack per key, in insertion order */
export function countsToStacks(counts) {
  return [...counts].map(([k, n]) => ({ k, n }));
}

/**
 * Add stacks together by key (and durability): `[{rock,1},{rock,2}]` → `[{rock,3}]`. Order of first appearance.
 * @param {Iterable<ItemStack>} stacks @returns {ItemStack[]}
 */
export function aggregateStacks(stacks) {
  /** @type {Map<string, ItemStack>} */
  const byKey = new Map();
  for (const s of stacks) {
    if (!s || !(s.n > 0)) continue;
    const id = s.d === undefined ? s.k : `${s.k}#${s.d}`;
    const had = byKey.get(id);
    byKey.set(id, had ? withCount(had, had.n + s.n) : copyStack(s));
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------------------------------------------------
// The pack

/**
 * PackOps: what crafting.js (and the fire and tap actions) need from a pack (DESIGN-survival §10 "B"). `Pack` implements
 * it; tests of other modules may fake it with a Map.
 * @typedef {Object} PackOps
 * @property {(key: string) => number} count
 * @property {(tag: string) => number} countTag
 * @property {(key: string, n: number) => number} take             how many were taken (from slot 26 back to 0)
 * @property {(tag: string, n: number) => number} takeTag          members in TAGS order
 * @property {(list: Iterable<{k: string, n: number}>) => boolean} canGive   all of them fit together
 * @property {(key: string, n: number) => number} give             how many did not fit
 * @property {(type: string, minTier: number) => boolean} hasTool
 * @property {(type: string, minTier: number) => ({key: string, broke: boolean}|null)} useTool  1 wear on the lowest tier
 */

/**
 * The survival pack (§5.3): `slots` (PACK_SLOTS; 0..HOTBAR_SIZE−1 the hotbar) and `wear` (head, body, feet).
 * Read `slots` / `wear` freely; change them only through the methods (or call `touch()` after an in-place change).
 */
export class Pack {
  constructor() {
    /** @type {(ItemStack|null)[]} */
    this.slots = new Array(PACK_SLOTS).fill(null);
    /** @type {(ItemStack|null)[]} */
    this.wear = new Array(WEAR_SLOTS).fill(null);
    /** Bumped on every change. */
    this.version = 0;
  }

  /** Mark the pack changed (after writing `slots` / `wear` directly). */
  touch() {
    this.version++;
  }

  /** @param {number} i @returns {ItemStack|null} */
  get(i) {
    return this.slots[i] ?? null;
  }

  /** @param {number} i @returns {ItemDef|null} the item in slot i */
  item(i) {
    const s = this.slots[i];
    return s ? getItem(s.k) : null;
  }

  /** @param {number} i @returns {ToolDef|null} the tool in slot i (the hand, when i is the selected slot), or null */
  toolAt(i) {
    return this.item(i)?.tool ?? null;
  }

  /** Replace slot i (no rules applied). @param {number} i @param {ItemStack|null} s */
  setSlot(i, s) {
    if (!(i >= 0 && i < PACK_SLOTS)) return;
    this.slots[i] = copyStack(s);
    this.version++;
  }

  /** Replace wear slot i (no rules applied). @param {number} i @param {ItemStack|null} s */
  setWear(i, s) {
    if (!(i >= 0 && i < WEAR_SLOTS)) return;
    this.wear[i] = copyStack(s);
    this.version++;
  }

  /** @returns {boolean} no stack in any slot or wear slot */
  isEmpty() {
    return this.slots.every((s) => s === null) && this.wear.every((s) => s === null);
  }

  /** Empty every slot and wear slot. */
  clear() {
    this.slots.fill(null);
    this.wear.fill(null);
    this.version++;
  }

  /**
   * Add a stack (§5.3): merged into same-key stacks 0 → 26, then into empty slots 0 → 26. An unknown key fits nowhere.
   * @param {ItemStack} stack (not changed)
   * @returns {ItemStack|null} what did not fit (same key and durability), or null
   */
  add(stack) {
    if (!stack || !(stack.n > 0)) return null;
    const left = fitStack(this.slots, stack, ADD_ORDER);
    if (left !== stack.n) this.version++;
    return left > 0 ? withCount(stack, left) : null;
  }

  /** @param {Iterable<ItemStack>} stacks @returns {ItemStack[]} what did not fit, one entry per stack that overflowed */
  addAll(stacks) {
    const over = [];
    for (const s of stacks) {
      const o = this.add(s);
      if (o) over.push(o);
    }
    return over;
  }

  /** PackOps: add n new items of `key`. @param {string} key @param {number} n @returns {number} how many did not fit */
  give(key, n) {
    if (!(n > 0)) return 0;
    return this.add({ k: key, n: Math.floor(n) })?.n ?? 0;
  }

  /**
   * PackOps: would every one of these fit, all together? Nothing changes.
   * @param {Iterable<{k: string, n: number, d?: number}>} list
   */
  canGive(list) {
    const slots = this.slots.slice();
    for (const s of list) {
      if (!s || !(s.n > 0)) continue;
      if (fitStack(slots, s, ADD_ORDER) > 0) return false;
    }
    return true;
  }

  /**
   * PackOps: would every one of `gives` fit once `takes` are removed? The copy loses the takes in the order `take` would
   * (slot 26 → 0, worn items untouched), then the gives are fitted as `add` would. Nothing changes.
   * @param {Iterable<[string, number]>} takes  [key, n] pairs (a crafting allocation's `takes`)
   * @param {Iterable<{k: string, n: number, d?: number}>} gives
   */
  canExchange(takes, gives) {
    const slots = this.slots.slice();
    for (const [key, n] of takes) {
      let left = Math.floor(n);
      for (let i = slots.length - 1; i >= 0 && left > 0; i--) {
        const s = slots[i];
        if (!s || s.k !== key) continue;
        const put = Math.min(s.n, left);
        left -= put;
        slots[i] = put === s.n ? null : { ...s, n: s.n - put };
      }
    }
    for (const s of gives) {
      if (!s || !(s.n > 0)) continue;
      if (fitStack(slots, s, ADD_ORDER) > 0) return false;
    }
    return true;
  }

  /** PackOps: how many of `key` the pack slots hold (worn items do not count). @param {string} key */
  count(key) {
    let n = 0;
    for (const s of this.slots) if (s && s.k === key) n += s.n;
    return n;
  }

  /** PackOps: how many members of `tag` the pack slots hold. @param {string} tag */
  countTag(tag) {
    const members = Object.hasOwn(TAGS, tag) ? TAGS[tag] : [];
    let n = 0;
    for (const k of members) n += this.count(k);
    return n;
  }

  /**
   * PackOps: remove up to n of `key`, from slot 26 back to 0 (the hotbar keeps its things longest).
   * @param {string} key @param {number} n @returns {number} how many were taken
   */
  take(key, n) {
    let left = Math.floor(n);
    if (!(left > 0)) return 0;
    for (let i = PACK_SLOTS - 1; i >= 0 && left > 0; i--) {
      const s = this.slots[i];
      if (!s || s.k !== key) continue;
      const t = Math.min(s.n, left);
      this.slots[i] = s.n > t ? withCount(s, s.n - t) : null;
      left -= t;
    }
    const taken = Math.floor(n) - left;
    if (taken > 0) this.version++;
    return taken;
  }

  /**
   * PackOps: remove up to n members of `tag`, member by member in TAGS order (each from slot 26 back to 0).
   * @param {string} tag @param {number} n @returns {number} how many were taken
   */
  takeTag(tag, n) {
    const want = Math.floor(n);
    if (!(want > 0)) return 0;
    const members = Object.hasOwn(TAGS, tag) ? TAGS[tag] : [];
    let left = want;
    for (const k of members) {
      if (left <= 0) break;
      left -= this.take(k, left);
    }
    return want - left;
  }

  /**
   * The slot of the tool `useTool` would use: type `type`, tier ≥ minTier, the lowest tier, ties to the least durability
   * left, then to the higher slot.
   * @param {string} type @param {number} minTier @returns {number} slot index, or −1
   */
  findTool(type, minTier) {
    let best = -1;
    let bestTier = Infinity;
    let bestD = Infinity;
    for (let i = PACK_SLOTS - 1; i >= 0; i--) {
      const s = this.slots[i];
      if (!s) continue;
      const tool = getItem(s.k)?.tool;
      if (!tool || tool.type !== type || tool.tier < minTier) continue;
      const d = s.d ?? tool.durability;
      if (tool.tier < bestTier || (tool.tier === bestTier && d < bestD)) {
        best = i;
        bestTier = tool.tier;
        bestD = d;
      }
    }
    return best;
  }

  /** PackOps: a tool of `type` with tier ≥ minTier is in the pack. @param {string} type @param {number} minTier */
  hasTool(type, minTier) {
    return this.findTool(type, minTier) >= 0;
  }

  /**
   * PackOps: wear the required tool once (§5.3: the lowest qualifying tier, ties to the least durability left).
   * @param {string} type @param {number} minTier
   * @returns {{key: string, broke: boolean}|null} null when no tool qualifies
   */
  useTool(type, minTier) {
    const i = this.findTool(type, minTier);
    return i < 0 ? null : this.damage(i, 1);
  }

  /**
   * Wear the item in slot i by n (a tool loses 1 per block broken while selected, per mob hit, …). At 0 it breaks and the
   * slot empties.
   * @param {number} i @param {number} [n=1]
   * @returns {{key: string, broke: boolean}|null} null when slot i holds nothing with a durability
   */
  damage(i, n = 1) {
    const s = this.slots[i];
    if (!s) return null;
    const max = maxDurability(s.k);
    if (max === 0) return null;
    const wear = Math.max(0, Math.floor(n) || 0);
    if (wear === 0) return { key: s.k, broke: false };
    const d = (s.d ?? max) - wear;
    this.slots[i] = d > 0 ? { k: s.k, n: 1, d } : null;
    this.version++;
    return { key: s.k, broke: d <= 0 };
  }

  /**
   * Use up n items of slot i (placing a block, eating).
   * @param {number} i @param {number} [n=1] @returns {number} how many were used up
   */
  consume(i, n = 1) {
    const s = this.slots[i];
    const want = Math.floor(n);
    if (!s || !(want > 0)) return 0;
    const t = Math.min(want, s.n);
    this.slots[i] = s.n > t ? withCount(s, s.n - t) : null;
    this.version++;
    return t;
  }

  /**
   * Wear the item in slot i (RMB on a wear item): it swaps with whatever is worn in its wear slot.
   * @param {number} i @returns {boolean} false when slot i holds no wear item
   */
  equip(i) {
    const s = this.slots[i];
    const wear = s ? getItem(s.k)?.wear : null;
    if (!s || !wear) return false;
    const w = WEAR_SLOT_NAMES.indexOf(wear.slot);
    this.slots[i] = this.wear[w];
    this.wear[w] = s;
    this.version++;
    return true;
  }

  /**
   * Take off the item worn in wear slot w, into the pack (add order). Nothing changes when the pack has no room.
   * @param {number} w @returns {boolean} whether it moved
   */
  unequip(w) {
    const s = this.wear[w];
    if (!s || !this.canGive([s])) return false;
    this.wear[w] = null;
    this.add(s);
    return true;
  }

  /** @returns {number} the sum of the worn items' insulation I (°C) */
  insulation() {
    let sum = 0;
    for (const s of this.wear) if (s) sum += getItem(s.k)?.wear?.insulation ?? 0;
    return sum;
  }

  /** @returns {number} the largest worn sunShade (0..1); 0 when nothing shades */
  sunShade() {
    let best = 0;
    for (const s of this.wear) if (s) best = Math.max(best, getItem(s.k)?.wear?.sunShade ?? 0);
    return best;
  }

  /**
   * Empty the pack and the wear slots (death, §2.5), except the KEEP_ON_DEATH items (§14.2), which stay in their slots.
   * @returns {ItemStack[]} every other stack: slots 0 → 26, then head, body, feet (at most PACK_SLOTS + WEAR_SLOTS)
   */
  dumpAll() {
    const out = [];
    for (const list of [this.slots, this.wear]) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s || isKept(s)) continue;
        out.push(s);
        list[i] = null;
      }
    }
    if (out.length) this.version++;
    return out;
  }

  /**
   * Spoilage (§4.5) over the pack slots. Call once a second with dt = 1 while Survival is active.
   * @param {number} dt @param {() => number} random
   * @returns {ItemStack[]} what went bad, one stack per key (for "1 Raw Pork went bad.")
   */
  spoil(dt, random) {
    const spoiled = new Map();
    if (spoilSlots(this.slots, dt, random, spoiled)) this.version++;
    return countsToStacks(spoiled);
  }

  /**
   * Middle mouse in Survival (§5.3): the first hotbar slot holding `key`; it never conjures one.
   * @param {string|null} key @returns {number} 0..HOTBAR_SIZE−1, or −1
   */
  hotbarSlotOf(key) {
    if (!key) return -1;
    for (const i of HOTBAR_ORDER) if (this.slots[i]?.k === key) return i;
    return -1;
  }

  /** @returns {{pack: (ItemStack|null)[], wear: (ItemStack|null)[]}} copies, for SurvivalJSON */
  export() {
    return { pack: this.slots.map(copyStack), wear: this.wear.map(copyStack) };
  }

  /**
   * Replace the contents from `{ pack, wear }` (a SurvivalJSON works too); null or garbage gives an empty pack. Invalid
   * stacks become null (the storage layer validates and warns first; this only keeps the pack sound).
   * @param {any} json
   * @returns {string[]} one line per repair (`pack[3]: unknown item "x", dropped`)
   */
  load(json) {
    this.slots.fill(null);
    this.wear.fill(null);
    this.version++;
    const warnings = [];
    if (!json || typeof json !== 'object') return warnings;
    /** @param {any} arr @param {(ItemStack|null)[]} into @param {string} name @param {boolean} isWear */
    const fill = (arr, into, name, isWear) => {
      if (arr === undefined || arr === null) return;
      if (!Array.isArray(arr)) {
        warnings.push(`${name}: not a list, emptied`);
        return;
      }
      if (arr.length !== into.length) warnings.push(`${name}: ${arr.length} slots, not ${into.length}`);
      for (let i = 0; i < into.length && i < arr.length; i++) {
        const raw = withCurrentKey(arr[i]);
        if (raw === null || raw === undefined) continue;
        const why = stackProblem(raw, isWear ? i : undefined);
        if (why) warnings.push(`${name}[${i}]: ${why}, dropped`);
        else into[i] = copyStack(raw);
      }
    };
    fill(json.pack, this.slots, 'pack', false);
    fill(json.wear, this.wear, 'wear', true);
    return warnings;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The pack screen's mouse rules (§5.4). The DOM only forwards clicks; this is all of the item logic.

/**
 * @typedef {Object} SlotSession
 * @property {Pack} pack
 * @property {ItemStack|null} cursor            the stack on the mouse; slotClick replaces it
 * @property {(ItemStack|null)[]|null} [container]  the open basket's slots (changed in place), or null when none is open
 */

/**
 * @typedef {Object} SlotClickResult
 * @property {boolean} changed       anything changed (pack, container or cursor)
 * @property {boolean} container     the container's slots changed (main then calls `containers.touch()`)
 * @property {ItemStack|null} discarded  the stack the discard hex destroyed
 * @property {string} [refused]      set (to KEEP_REFUSED) when the click would have let a KEEP_ON_DEATH item go: dropped on
 *   the discard hex or put into a basket. Nothing changed; main shows it as a hint or chat line.
 */

/** @param {ItemStack} s @param {number} w @returns {boolean} a stack of a wear item for wear slot w */
function fitsWearSlot(s, w) {
  return getItem(s.k)?.wear?.slot === WEAR_SLOT_NAMES[w];
}

/**
 * One click in the pack screen (§5.4):
 * - left, empty cursor: pick up the whole stack;
 * - left with a cursor: into an empty slot, put it all; on the same key (no durability), merge up to the stack size and keep
 *   the rest; otherwise swap;
 * - right, empty cursor: pick up half, rounded up;
 * - right with a cursor: put 1 into an empty or same-key slot;
 * - wear slots accept only wear items for that slot;
 * - shift + left quick-moves: pack → the open container, else hotbar ↔ the rosette; container → pack; wear → pack;
 * - `area 'discard'`: the cursor stack is destroyed;
 * - a KEEP_ON_DEATH item (the handbook, §14.2) is never destroyed nor put into a container: those clicks change nothing
 *   and report `refused`.
 * @param {SlotSession} session  changed in place
 * @param {'pack'|'wear'|'container'|'discard'} area
 * @param {number} index
 * @param {number} button 0 left, 2 right
 * @param {boolean} shift
 * @returns {SlotClickResult}
 */
export function slotClick(session, area, index, button, shift) {
  /** @type {SlotClickResult} */
  const res = { changed: false, container: false, discarded: null };
  const { pack } = session;
  /** @returns {SlotClickResult} the refusal of a KEEP_ON_DEATH item (nothing changes) */
  const refuse = () => {
    res.refused = KEEP_REFUSED;
    return res;
  };
  if (area === 'discard') {
    if (isKept(session.cursor)) return refuse();
    if (session.cursor) {
      res.discarded = session.cursor;
      session.cursor = null;
      res.changed = true;
    }
    return res;
  }

  /** @type {(ItemStack|null)[]|null} */
  let slots;
  if (area === 'pack') slots = pack.slots;
  else if (area === 'wear') slots = pack.wear;
  else if (area === 'container') slots = session.container ?? null;
  else return res;
  if (!slots || !Number.isInteger(index) || index < 0 || index >= slots.length) return res;

  const accepts = (/** @type {ItemStack} */ s) => area !== 'wear' || fitsWearSlot(s, index);
  const setAt = (/** @type {ItemStack|null} */ s) => {
    slots[index] = s;
    res.changed = true;
    if (area === 'container') res.container = true;
    else pack.touch();
  };
  const cur = session.cursor;
  const here = slots[index] ?? null;
  // The handbook stays with you (§14.2): it never goes into a basket, by click or by shift-click.
  if (area === 'container' && isKept(cur) && !(button === 0 && shift)) return refuse();

  if (button === 0 && shift) {
    if (!here) return res;
    /** @type {(ItemStack|null)[]} */
    let into;
    /** @type {ArrayLike<number>} */
    let order;
    if (area === 'pack' && session.container) {
      if (isKept(here)) return refuse();
      into = session.container;
      order = range(0, into.length);
    } else if (area === 'pack') {
      into = pack.slots;
      order = index < HOTBAR_SIZE ? ROSETTE_ORDER : HOTBAR_ORDER;
    } else {
      into = pack.slots; // container → pack, wear → pack
      order = ADD_ORDER;
    }
    const left = fitStack(into, here, order);
    if (left === here.n) return res;
    if (into === session.container) res.container = true;
    else pack.touch();
    setAt(left > 0 ? withCount(here, left) : null);
    return res;
  }

  if (button === 0) {
    if (!cur) {
      if (!here) return res;
      session.cursor = here;
      setAt(null);
      return res;
    }
    if (!accepts(cur)) return res;
    if (!here) {
      session.cursor = null;
      setAt(cur);
      return res;
    }
    if (canMerge(here, cur)) {
      const put = Math.min(stackSize(here.k) - here.n, cur.n);
      if (put <= 0) return res;
      session.cursor = cur.n > put ? withCount(cur, cur.n - put) : null;
      setAt(withCount(here, here.n + put));
      return res;
    }
    session.cursor = here;
    setAt(cur);
    return res;
  }

  if (button === 2) {
    if (!cur) {
      if (!here) return res;
      const half = Math.ceil(here.n / 2);
      session.cursor = withCount(here, half);
      setAt(here.n > half ? withCount(here, here.n - half) : null);
      return res;
    }
    if (!accepts(cur)) return res;
    if (!here) {
      session.cursor = cur.n > 1 ? withCount(cur, cur.n - 1) : null;
      setAt(withCount(cur, 1));
      return res;
    }
    if (canMerge(here, cur) && here.n < stackSize(here.k)) {
      session.cursor = cur.n > 1 ? withCount(cur, cur.n - 1) : null;
      setAt(withCount(here, here.n + 1));
    }
    return res;
  }
  return res;
}

/**
 * Closing the pack screen with a stack on the cursor (§5.4): it goes back with `pack.add`. A KEEP_ON_DEATH item that no
 * longer fits displaces the last other stack instead (§14.2), so the handbook is never what is lost.
 * @param {SlotSession} session  its cursor is cleared
 * @returns {ItemStack|null} what did not fit (lost, with the "left behind" message)
 */
export function returnCursor(session) {
  const cur = session.cursor;
  session.cursor = null;
  if (!cur) return null;
  const left = session.pack.add(cur);
  if (!left || !isKept(left)) return left;
  // A KEEP_ON_DEATH item is never the one left behind (§14.2): when the pack filled up meanwhile (a job finished while it
  // was on the cursor), it takes the last slot holding anything else, and that stack is what is left behind instead.
  const slots = session.pack.slots;
  for (let i = slots.length - 1; i >= 0; i--) {
    const s = slots[i];
    if (s && !isKept(s)) {
      session.pack.setSlot(i, left);
      return s;
    }
  }
  return left;
}
