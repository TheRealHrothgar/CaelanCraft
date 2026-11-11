// Caelancraft — light: per-cell SKY and BLOCK light levels. See src/CONTRACTS.md §62. Pure.
//
// Every lit chunk carries `chunk.light`, a Uint8Array(CHUNK_VOLUME) indexed exactly like `chunk.blocks` (coords.localIndex),
// one byte per cell: `sky << 4 | block`, both 0..LIGHT_MAX. `chunk.lightTop` (Uint8Array(CHUNK_AREA), column index) is the
// lowest y of the column's unbroken run of sky-15 cells from the top of the world (WORLD_HEIGHT when the top cell is dark).
//
// Propagation is a breadth-first flood over a cell's 8 neighbours (6 hex sides, up, down). Entering a cell costs
// max(1, LIGHT_OPACITY[id]) levels; an opaque cell (opacity LIGHT_MAX) takes no light at all. Sky light additionally
// falls straight down at full strength: from a sky-15 cell into the cell below it costs nothing when that cell has opacity
// 0 (air, glass, plants), so open columns are 15 from the top of the world to the first opaque or dimming cell. Leaves,
// water and ice have opacity 1: no free fall through them, so a canopy or a lake darkens what lies below. Emitters
// (LIGHT_EMISSION: glowstone, campfire, torch) hold their level in their own cell — opaque or not — and spread it.
//
// When a chunk is lit (World._generate) its light is computed from its own blocks plus its LOADED, lit hex-adjacent
// neighbours: a column pass for the sky, then one flood seeded only where light can actually move (a lit cell beside a
// darker see-through one) — inside the chunk, and in both directions across every border with a loaded neighbour, which
// the flood may change too. An unloaded neighbour counts as nothing at all (no cells, no light). Adding a chunk can then
// only ADD light anywhere, so loading never needs the removal pass; light that should arrive from a chunk that is not
// loaded yet arrives (and re-meshes what it reaches) when that chunk loads.
//
// Block edits are batched: World.setBlock calls noteChange(chunk, li) and World.update calls flush() once per frame,
// which darkens every changed cell (the standard removal flood with the old levels, collecting the cells whose light came
// from elsewhere), re-seeds emitters and the changed cells' neighbours, and floods again. Every operation returns the
// chunks whose meshes may show the change: the chunk of every changed cell and, for a cell on a chunk border, the chunks
// across that border (their faces sample it).
import { CHUNK_SIZE, WORLD_HEIGHT, CHUNK_VOLUME, CHUNK_AREA, LIGHT_MAX, LIGHT_CURVE_K,
  GLOWSTONE_LIGHT, CAMPFIRE_LIGHT, TORCH_LIGHT, LEAVES_LIGHT_OPACITY, WATER_LIGHT_OPACITY, ICE_LIGHT_OPACITY } from './config.js';
import { HEX_DIRS, worldToHex } from './hex.js';
import { BLOCK, isOpaque, isLeaves, isWater } from './blocks.js';

/** @typedef {import('./chunk.js').Chunk} Chunk */

/** Packed light of a cell open to the sky with no block light: what unloaded space and missing light arrays read as. */
export const FULL_SKY = LIGHT_MAX << 4;

/** LIGHT_OPACITY[id]: levels lost entering a cell of `id` beyond the 1 every step costs; LIGHT_MAX = blocks light. */
export const LIGHT_OPACITY = new Uint8Array(256);
/** LIGHT_EMISSION[id]: block light the cell itself gives off. */
export const LIGHT_EMISSION = new Uint8Array(256);
for (let id = 0; id < 256; id++) {
  if (isOpaque(id)) LIGHT_OPACITY[id] = LIGHT_MAX;
  else if (isLeaves(id)) LIGHT_OPACITY[id] = LEAVES_LIGHT_OPACITY;
  else if (isWater(id)) LIGHT_OPACITY[id] = WATER_LIGHT_OPACITY;
  else if (id === BLOCK.ICE) LIGHT_OPACITY[id] = ICE_LIGHT_OPACITY;
}
LIGHT_EMISSION[BLOCK.GLOWSTONE] = GLOWSTONE_LIGHT;
LIGHT_EMISSION[BLOCK.CAMPFIRE] = CAMPFIRE_LIGHT;
LIGHT_EMISSION[BLOCK.TORCH] = TORCH_LIGHT;

/** @returns {number} light opacity of block `id` (0 clear … LIGHT_MAX opaque) */
export function lightOpacity(id) {
  return LIGHT_OPACITY[id & 255];
}

/** @returns {number} block light given off by block `id` */
export function lightEmission(id) {
  return LIGHT_EMISSION[id & 255];
}

/** @returns {number} the sky level of a packed light byte */
export function skyLevel(packed) {
  return packed >> 4;
}

/** @returns {number} the block level of a packed light byte */
export function blockLevel(packed) {
  return packed & 15;
}

/**
 * Brightness of a light level, 0..1: x / (1 + K·(1 − x)) with x = level / LIGHT_MAX — 1 at 15, 0 at 0, about 0.5 at
 * 12, 0.18 at 7. The shaders (lightShader.js caelCurve) evaluate the same curve on the interpolated level.
 * @param {number} level 0..LIGHT_MAX (fractions allowed)
 * @returns {number}
 */
export function lightBrightness(level) {
  const x = Math.min(1, Math.max(0, level / LIGHT_MAX));
  return x / (1 + LIGHT_CURVE_K * (1 - x));
}

const CHUNK_SHIFT = 15; // CHUNK_VOLUME = 2^15: queue entry = slot << 15 | localIndex
const LOCAL_MASK = CHUNK_VOLUME - 1;
const TOP_Y = WORLD_HEIGHT - 1;
if (CHUNK_VOLUME !== 1 << CHUNK_SHIFT || CHUNK_SIZE !== 16 || WORLD_HEIGHT !== 128) {
  throw new Error('light.js assumes 16 × 128 × 16 chunks (localIndex = lq << 11 | lr << 7 | y)');
}
const DQ = new Int8Array(6);
const DR = new Int8Array(6);
for (let j = 0; j < 6; j++) {
  DQ[j] = HEX_DIRS[j][0];
  DR[j] = HEX_DIRS[j][1];
}

/** Growable FIFO of queue entries with an optional level per entry (the removal floods carry the old level). */
class LightQueue {
  constructor(capacity = 4096) {
    this.cells = new Int32Array(capacity);
    this.levels = new Uint8Array(capacity);
    this.head = 0;
    this.tail = 0;
  }

  push(entry, level = 0) {
    if (this.tail === this.cells.length) this._grow();
    this.cells[this.tail] = entry;
    this.levels[this.tail] = level;
    this.tail++;
  }

  _grow() {
    const live = this.tail - this.head;
    if (this.head > 0 && live < this.cells.length / 2) {
      this.cells.copyWithin(0, this.head, this.tail);
      this.levels.copyWithin(0, this.head, this.tail);
    } else {
      const cells = new Int32Array(this.cells.length * 2);
      cells.set(this.cells.subarray(this.head, this.tail));
      const levels = new Uint8Array(this.levels.length * 2);
      levels.set(this.levels.subarray(this.head, this.tail));
      this.cells = cells;
      this.levels = levels;
    }
    this.head = 0;
    this.tail = live;
  }

  clear() {
    this.head = 0;
    this.tail = 0;
  }
}

/** Scratch: the lowest lit y of each column after the column pass (WORLD_HEIGHT when none). */
const lowLit = new Uint8Array(CHUNK_AREA);

/**
 * @typedef {Object} LightSource  What the engine reads chunks through (World satisfies it).
 * @property {(cq: number, cr: number) => (Chunk|null|undefined)} getChunkData
 */

export class LightEngine {
  /** @param {LightSource} source */
  constructor(source) {
    this._source = source;
    /** @type {(Chunk|null)[]} slot → lit chunk (queue entries name chunks by slot) */
    this._slots = [];
    /** @type {number[]} free slots */
    this._free = [];
    this._sky = new LightQueue();
    this._block = new LightQueue();
    this._skyDark = new LightQueue();
    this._blockDark = new LightQueue();
    /** @type {Chunk[]} chunks touched by the current operation */
    this._changed = [];
    this._mark = 0;
    /** @type {(Chunk|number)[]} pending edits: chunk, localIndex pairs (flush() processes them) */
    this._pending = [];
    /** bumps whenever any stored level changes (the renderer's light volume refreshes on it) */
    this.version = 0;
    /**
     * v0.11 (CONTRACTS §72): extra emitters by cell, on top of a block's own light — a lit Filament Lamp. "cq,cr" → (local
     * index → level). A lit chunk points at its own map through `chunk.lightExtra` (null when it has none); the entries
     * outlive the chunk, so a lamp left burning is lit again when its chunk comes back.
     * @type {Map<string, Map<number, number>>}
     */
    this._extra = new Map();
  }

  /**
   * Give cell (q, y, r) its own light `level` (0..LIGHT_MAX) on top of whatever its block emits; 0 takes it away. The
   * change is re-lit at the next flush() (World.update), like an edit.
   * @returns {boolean} true when the level changed
   */
  setEmitter(q, y, r, level) {
    if (!Number.isInteger(q) || !Number.isInteger(r) || !(y >= 0 && y < WORLD_HEIGHT)) return false;
    const lv = Math.max(0, Math.min(LIGHT_MAX, Math.floor(level) || 0));
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    const li = ((q - cq * CHUNK_SIZE) << 11) | ((r - cr * CHUNK_SIZE) << 7) | y;
    const key = `${cq},${cr}`;
    let m = this._extra.get(key) ?? null;
    if ((m ? m.get(li) ?? 0 : 0) === lv) return false;
    if (lv === 0) {
      /** @type {Map<number, number>} */ (m).delete(li);
      if (/** @type {Map<number, number>} */ (m).size === 0) {
        this._extra.delete(key);
        m = null;
      }
    } else {
      if (!m) {
        m = new Map();
        this._extra.set(key, m);
      }
      m.set(li, lv);
    }
    const chunk = this._lit(cq, cr);
    if (chunk) {
      /** @type {*} */ (chunk).lightExtra = m;
      this.noteChange(chunk, li);
    }
    return true;
  }

  /** @returns {number} the extra light given to cell (q, y, r) by setEmitter (0: none) */
  emitterAt(q, y, r) {
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    const m = this._extra.get(`${cq},${cr}`);
    return m ? m.get(((q - cq * CHUNK_SIZE) << 11) | ((r - cr * CHUNK_SIZE) << 7) | y) ?? 0 : 0;
  }

  /** @returns {boolean} edits are waiting for flush() */
  get hasPending() {
    return this._pending.length > 0;
  }

  /** @returns {number} chunks currently lit */
  get chunkCount() {
    return this._slots.length - this._free.length;
  }

  // -------------------------------------------------------------------------------------------
  // queries

  /**
   * Packed light (sky << 4 | block) at cell (q, y, r): FULL_SKY above the world and wherever no lit chunk is loaded,
   * 0 below it. Pending edits are not applied (World.lightAt flushes first).
   * @returns {number}
   */
  get(q, y, r) {
    y = Math.floor(y);
    if (!(y < WORLD_HEIGHT)) return y >= WORLD_HEIGHT ? FULL_SKY : 0; // NaN → 0
    if (y < 0) return 0;
    q = Math.floor(q);
    r = Math.floor(r);
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    const chunk = this._lit(cq, cr);
    if (chunk === null) return FULL_SKY;
    return chunk.light[((q - cq * CHUNK_SIZE) << 11) | ((r - cr * CHUNK_SIZE) << 7) | y];
  }

  /** @returns {number} sky level at cell (q, y, r) */
  skyAt(q, y, r) {
    return this.get(q, y, r) >> 4;
  }

  /** @returns {number} block level at cell (q, y, r) */
  blockAt(q, y, r) {
    return this.get(q, y, r) & 15;
  }

  /** @returns {number} packed light of the cell containing WORLD point (x, y, z); FULL_SKY for non-finite input */
  sampleWorld(x, y, z) {
    if (!Number.isFinite(x + y + z)) return FULL_SKY;
    const [q, r] = worldToHex(x, z);
    return this.get(q, Math.floor(y), r);
  }

  /**
   * Copy the light of an n × n block of columns (q0..q0+n−1, r0..r0+n−1) into `out` (length n·n·WORLD_HEIGHT), laid out
   * `((dq · n) + dr) · WORLD_HEIGHT + y` — a 3D texture of width WORLD_HEIGHT (y), height n (r), depth n (q). Columns
   * without a lit chunk read FULL_SKY.
   * @param {number} q0
   * @param {number} r0
   * @param {number} n
   * @param {Uint8Array} out
   */
  fillVolume(q0, r0, n, out) {
    for (let dq = 0; dq < n; dq++) {
      const q = q0 + dq;
      const cq = Math.floor(q / CHUNK_SIZE);
      const lq = q - cq * CHUNK_SIZE;
      for (let dr = 0; dr < n; dr++) {
        const r = r0 + dr;
        const cr = Math.floor(r / CHUNK_SIZE);
        const o = (dq * n + dr) * WORLD_HEIGHT;
        const chunk = this._lit(cq, cr);
        if (chunk === null) {
          out.fill(FULL_SKY, o, o + WORLD_HEIGHT);
        } else {
          const base = (lq << 11) | ((r - cr * CHUNK_SIZE) << 7);
          out.set(chunk.light.subarray(base, base + WORLD_HEIGHT), o);
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // chunk lifecycle

  /**
   * Light a freshly generated (and registered) chunk: its sky columns, its emitters and the exchange with every loaded,
   * lit hex neighbour. Re-lighting a chunk that is already lit starts over from its blocks.
   * @param {Chunk} chunk
   * @returns {Chunk[]} chunks whose meshes may show changed light (the chunk itself first)
   */
  lightChunk(chunk) {
    this._begin();
    let slot = /** @type {*} */ (chunk).lightSlot;
    if (!(slot >= 0) || this._slots[slot] !== chunk) {
      slot = this._free.length > 0 ? /** @type {number} */ (this._free.pop()) : this._slots.length;
      this._slots[slot] = chunk;
      /** @type {*} */ (chunk).lightSlot = slot;
    }
    const L = new Uint8Array(CHUNK_VOLUME);
    const top = new Uint8Array(CHUNK_AREA);
    chunk.light = L;
    chunk.lightTop = top;
    this._touchChunk(chunk);
    const B = chunk.blocks;
    const OP = LIGHT_OPACITY;
    const EM = LIGHT_EMISSION;
    const sky = this._sky;
    const block = this._block;
    const tag = slot << CHUNK_SHIFT;

    // 1. Sky columns: 15 from the top until the first dimming cell, then losing max(1, opacity) per cell.
    for (let col = 0; col < CHUNK_AREA; col++) {
      const base = col << 7;
      let s = LIGHT_MAX;
      let t = WORLD_HEIGHT;
      let low = WORLD_HEIGHT;
      for (let y = TOP_Y; y >= 0; y--) {
        const op = OP[B[base + y]];
        if (op >= LIGHT_MAX) break;
        s = s === LIGHT_MAX && op === 0 ? LIGHT_MAX : s - (op > 1 ? op : 1);
        if (s <= 0) break;
        L[base + y] = s << 4;
        if (s === LIGHT_MAX) t = y;
        low = y;
      }
      top[col] = t;
      lowLit[col] = low;
    }

    // 2. Emitters: the blocks that glow, then the cells given their own light (setEmitter).
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      const e = EM[B[i]];
      if (e !== 0) {
        L[i] |= e;
        block.push(tag | i);
      }
    }
    const extra = this._extra.get(`${chunk.cq},${chunk.cr}`) ?? null;
    /** @type {*} */ (chunk).lightExtra = extra;
    if (extra) {
      for (const [i, e] of extra) {
        if (e > (L[i] & 15)) {
          L[i] = (L[i] & 0xf0) | e;
          block.push(tag | i);
        }
      }
    }

    // 3. Seeds inside the chunk: a lit cell whose side neighbour (same height) would take more sky light. Above both
    //    columns' sky-15 runs nothing moves, and below the column's lowest lit cell there is no light to give.
    for (let lq = 0; lq < CHUNK_SIZE; lq++) {
      for (let lr = 0; lr < CHUNK_SIZE; lr++) {
        const col = (lq << 4) | lr;
        const base = col << 7;
        let yTop = -1;
        for (let j = 0; j < 6; j++) {
          const nq = lq + DQ[j];
          const nr = lr + DR[j];
          if (nq < 0 || nq >= CHUNK_SIZE || nr < 0 || nr >= CHUNK_SIZE) continue;
          const t = Math.max(top[col], top[(nq << 4) | nr]) - 1;
          if (t > yTop) yTop = t;
        }
        if (yTop > TOP_Y) yTop = TOP_Y;
        for (let y = yTop; y >= lowLit[col]; y--) {
          const s = L[base + y] >> 4;
          if (s <= 1) continue;
          for (let j = 0; j < 6; j++) {
            const nq = lq + DQ[j];
            const nr = lr + DR[j];
            if (nq < 0 || nq >= CHUNK_SIZE || nr < 0 || nr >= CHUNK_SIZE) continue;
            const n = (nq << 11) | (nr << 7) | y;
            const op = OP[B[n]];
            if (op < LIGHT_MAX && s - (op > 1 ? op : 1) > L[n] >> 4) {
              sky.push(tag | base | y);
              break;
            }
          }
        }
      }
    }

    // 4. Exchange with the loaded neighbours, both ways, over every border pair of cells.
    for (let lq = 0; lq < CHUNK_SIZE; lq++) {
      for (let lr = 0; lr < CHUNK_SIZE; lr++) {
        if (lq !== 0 && lq !== CHUNK_SIZE - 1 && lr !== 0 && lr !== CHUNK_SIZE - 1) continue;
        const base = (lq << 11) | (lr << 7);
        for (let j = 0; j < 6; j++) {
          const nq = lq + DQ[j];
          const nr = lr + DR[j];
          if (nq >= 0 && nq < CHUNK_SIZE && nr >= 0 && nr < CHUNK_SIZE) continue;
          const dcq = nq < 0 ? -1 : nq >= CHUNK_SIZE ? 1 : 0;
          const dcr = nr < 0 ? -1 : nr >= CHUNK_SIZE ? 1 : 0;
          const k = this._lit(chunk.cq + dcq, chunk.cr + dcr);
          if (k === null) continue;
          const KL = k.light;
          const KB = k.blocks;
          const kbase = ((nq - dcq * CHUNK_SIZE) << 11) | ((nr - dcr * CHUNK_SIZE) << 7);
          const ktag = /** @type {*} */ (k).lightSlot << CHUNK_SHIFT;
          for (let y = 0; y < WORLD_HEIGHT; y++) {
            const a = L[base + y];
            const b = KL[kbase + y];
            if (a === b) continue;
            const opA = OP[B[base + y]];
            const opB = OP[KB[kbase + y]];
            const costA = opA > 1 ? opA : 1;
            const costB = opB > 1 ? opB : 1;
            const sa = a >> 4;
            const sb = b >> 4;
            if (opB < LIGHT_MAX && sa - costB > sb) sky.push(tag | base | y);
            else if (opA < LIGHT_MAX && sb - costA > sa) sky.push(ktag | kbase | y);
            if (opA < LIGHT_MAX && (b & 15) - costA > (a & 15)) block.push(ktag | kbase | y);
          }
        }
      }
    }

    this._spreadSky();
    this._spreadBlock();
    return this._end();
  }

  /**
   * Forget an unloaded chunk (its light array goes with it). Light it gave its neighbours stays until an edit there
   * re-floods it; the same light comes back when it reloads.
   * @param {Chunk} chunk
   */
  releaseChunk(chunk) {
    const slot = /** @type {*} */ (chunk).lightSlot;
    if (slot >= 0 && this._slots[slot] === chunk) {
      this._slots[slot] = null;
      this._free.push(slot);
    }
    /** @type {*} */ (chunk).lightSlot = -1;
    /** @type {*} */ (chunk).lightExtra = null;
  }

  /** Forget every chunk and every extra emitter (World.dispose). */
  clear() {
    for (const c of this._slots) if (c) /** @type {*} */ (c).lightSlot = -1;
    this._slots.length = 0;
    this._free.length = 0;
    this._pending.length = 0;
    this._extra.clear();
  }

  // -------------------------------------------------------------------------------------------
  // edits

  /**
   * Remember that the block at local index `li` of `chunk` changed (World.setBlock, after the write). flush() updates
   * the light of every remembered cell at once.
   * @param {Chunk} chunk
   * @param {number} li
   */
  noteChange(chunk, li) {
    this._pending.push(chunk, li);
  }

  /**
   * Bring the light up to date with every edit since the last flush.
   * @returns {Chunk[]} chunks whose meshes may show changed light
   */
  flush() {
    const p = this._pending;
    if (p.length === 0) return [];
    this._begin();
    const skyDark = this._skyDark;
    const blockDark = this._blockDark;
    // 1. Darken every changed cell and flood the darkness out, collecting the cells lit from elsewhere.
    for (let k = 0; k < p.length; k += 2) {
      const chunk = /** @type {Chunk} */ (p[k]);
      if (!this._owns(chunk)) continue;
      const li = /** @type {number} */ (p[k + 1]);
      const L = chunk.light;
      const old = L[li];
      if (old === 0) continue;
      L[li] = 0;
      this._touch(chunk, li);
      const e = (/** @type {*} */ (chunk).lightSlot << CHUNK_SHIFT) | li;
      if (old >> 4) skyDark.push(e, old >> 4);
      if (old & 15) blockDark.push(e, old & 15);
    }
    this._unspreadSky();
    this._unspreadBlock();
    // 2. Re-seed: an emitter's own level, the top of the world's sky, and every neighbour (it floods back in).
    const sky = this._sky;
    const block = this._block;
    for (let k = 0; k < p.length; k += 2) {
      const chunk = /** @type {Chunk} */ (p[k]);
      if (!this._owns(chunk)) continue;
      const li = /** @type {number} */ (p[k + 1]);
      const L = chunk.light;
      const id = chunk.blocks[li];
      const tag = /** @type {*} */ (chunk).lightSlot << CHUNK_SHIFT;
      let em = LIGHT_EMISSION[id];
      const X = /** @type {*} */ (chunk).lightExtra;
      if (X) {
        const x = X.get(li);
        if (x > em) em = x;
      }
      if (em > (L[li] & 15)) {
        L[li] = (L[li] & 0xf0) | em;
        this._touch(chunk, li);
        block.push(tag | li);
      }
      const y = li & 127;
      if (y === TOP_Y) {
        const op = LIGHT_OPACITY[id];
        const s = op === 0 ? LIGHT_MAX : op >= LIGHT_MAX ? 0 : LIGHT_MAX - op;
        if (s > L[li] >> 4) {
          L[li] = (L[li] & 15) | (s << 4);
          this._touch(chunk, li);
          sky.push(tag | li);
        }
      } else {
        sky.push(tag | (li + 1));
        block.push(tag | (li + 1));
      }
      if (y > 0) {
        sky.push(tag | (li - 1));
        block.push(tag | (li - 1));
      }
      const lq = li >> 11;
      const lr = (li >> 7) & 15;
      for (let j = 0; j < 6; j++) {
        const e = this._entry(chunk, lq + DQ[j], lr + DR[j], y);
        if (e >= 0) {
          sky.push(e);
          block.push(e);
        }
      }
    }
    this._spreadSky();
    this._spreadBlock();
    // 3. The sky-15 run of every edited column (only a column's own cells can be 15, so no other column's changes).
    for (let k = 0; k < p.length; k += 2) {
      const chunk = /** @type {Chunk} */ (p[k]);
      if (!this._owns(chunk)) continue;
      const li = /** @type {number} */ (p[k + 1]);
      const col = li >> 7;
      const L = chunk.light;
      const base = col << 7;
      let t = WORLD_HEIGHT;
      while (t > 0 && L[base + t - 1] >> 4 === LIGHT_MAX) t--;
      chunk.lightTop[col] = t;
    }
    p.length = 0;
    return this._end();
  }

  // -------------------------------------------------------------------------------------------
  // internals

  /** @returns {Chunk|null} the lit chunk (cq, cr), or null */
  _lit(cq, cr) {
    const c = this._source.getChunkData(cq, cr);
    if (!c || !c.light) return null;
    const slot = /** @type {*} */ (c).lightSlot;
    return slot >= 0 && this._slots[slot] === c ? /** @type {Chunk} */ (c) : null;
  }

  /** @returns {boolean} `chunk` is lit and registered here */
  _owns(chunk) {
    const slot = /** @type {*} */ (chunk).lightSlot;
    return slot >= 0 && this._slots[slot] === chunk && !!chunk.light;
  }

  /**
   * Queue entry of the cell at local (lq, y, lr) relative to `chunk`, where lq / lr may be one step outside it.
   * @returns {number} −1 when that cell's chunk is not lit
   */
  _entry(chunk, lq, lr, y) {
    if (lq >= 0 && lq < CHUNK_SIZE && lr >= 0 && lr < CHUNK_SIZE) {
      return (/** @type {*} */ (chunk).lightSlot << CHUNK_SHIFT) | (lq << 11) | (lr << 7) | y;
    }
    const dcq = lq < 0 ? -1 : lq >= CHUNK_SIZE ? 1 : 0;
    const dcr = lr < 0 ? -1 : lr >= CHUNK_SIZE ? 1 : 0;
    const k = this._lit(chunk.cq + dcq, chunk.cr + dcr);
    if (k === null) return -1;
    return (/** @type {*} */ (k).lightSlot << CHUNK_SHIFT) | ((lq - dcq * CHUNK_SIZE) << 11) | ((lr - dcr * CHUNK_SIZE) << 7) | y;
  }

  _begin() {
    this._mark++;
    this._changed.length = 0;
  }

  /** @returns {Chunk[]} the chunks the operation touched (a fresh array) */
  _end() {
    const out = this._changed.slice();
    this._changed.length = 0;
    if (out.length > 0) this.version++;
    return out;
  }

  _touchChunk(chunk) {
    if (/** @type {*} */ (chunk)._lightMark !== this._mark) {
      /** @type {*} */ (chunk)._lightMark = this._mark;
      this._changed.push(chunk);
    }
  }

  /** A cell's light changed: its chunk, and across a border the chunks whose faces sample it. */
  _touch(chunk, li) {
    this._touchChunk(chunk);
    const lq = li >> 11;
    const lr = (li >> 7) & 15;
    if (lq !== 0 && lq !== CHUNK_SIZE - 1 && lr !== 0 && lr !== CHUNK_SIZE - 1) return;
    for (let j = 0; j < 6; j++) {
      const nq = lq + DQ[j];
      const nr = lr + DR[j];
      if (nq >= 0 && nq < CHUNK_SIZE && nr >= 0 && nr < CHUNK_SIZE) continue;
      const k = this._lit(chunk.cq + (nq < 0 ? -1 : nq >= CHUNK_SIZE ? 1 : 0), chunk.cr + (nr < 0 ? -1 : nr >= CHUNK_SIZE ? 1 : 0));
      if (k !== null) this._touchChunk(k);
    }
  }

  /** Flood sky light from every queued cell. */
  _spreadSky() {
    const q = this._sky;
    const slots = this._slots;
    const OP = LIGHT_OPACITY;
    while (q.head < q.tail) {
      const e = q.cells[q.head++];
      const chunk = slots[e >>> CHUNK_SHIFT];
      if (!chunk) continue;
      const li = e & LOCAL_MASK;
      const L = chunk.light;
      const s = L[li] >> 4;
      if (s <= 1) continue;
      const B = chunk.blocks;
      const tag = e & ~LOCAL_MASK;
      const y = li & 127;
      if (y < TOP_Y) {
        const n = li + 1;
        const op = OP[B[n]];
        if (op < LIGHT_MAX) {
          const c = s - (op > 1 ? op : 1);
          if (c > L[n] >> 4) {
            L[n] = (L[n] & 15) | (c << 4);
            this._touch(chunk, n);
            q.push(tag | n);
          }
        }
      }
      if (y > 0) {
        const n = li - 1;
        const op = OP[B[n]];
        if (op < LIGHT_MAX) {
          const c = s === LIGHT_MAX && op === 0 ? LIGHT_MAX : s - (op > 1 ? op : 1);
          if (c > L[n] >> 4) {
            L[n] = (L[n] & 15) | (c << 4);
            this._touch(chunk, n);
            q.push(tag | n);
          }
        }
      }
      const lq = li >> 11;
      const lr = (li >> 7) & 15;
      for (let j = 0; j < 6; j++) {
        const nq = lq + DQ[j];
        const nr = lr + DR[j];
        let K = chunk;
        let n;
        let ktag = tag;
        if (nq >= 0 && nq < CHUNK_SIZE && nr >= 0 && nr < CHUNK_SIZE) {
          n = (nq << 11) | (nr << 7) | y;
        } else {
          const dcq = nq < 0 ? -1 : nq >= CHUNK_SIZE ? 1 : 0;
          const dcr = nr < 0 ? -1 : nr >= CHUNK_SIZE ? 1 : 0;
          const k = this._lit(chunk.cq + dcq, chunk.cr + dcr);
          if (k === null) continue;
          K = k;
          ktag = /** @type {*} */ (k).lightSlot << CHUNK_SHIFT;
          n = ((nq - dcq * CHUNK_SIZE) << 11) | ((nr - dcr * CHUNK_SIZE) << 7) | y;
        }
        const op = OP[K.blocks[n]];
        if (op >= LIGHT_MAX) continue;
        const KL = K.light;
        const c = s - (op > 1 ? op : 1);
        if (c > KL[n] >> 4) {
          KL[n] = (KL[n] & 15) | (c << 4);
          this._touch(K, n);
          q.push(ktag | n);
        }
      }
    }
    q.clear();
  }

  /** Flood block light from every queued cell. */
  _spreadBlock() {
    const q = this._block;
    const slots = this._slots;
    const OP = LIGHT_OPACITY;
    while (q.head < q.tail) {
      const e = q.cells[q.head++];
      const chunk = slots[e >>> CHUNK_SHIFT];
      if (!chunk) continue;
      const li = e & LOCAL_MASK;
      const L = chunk.light;
      const s = L[li] & 15;
      if (s <= 1) continue;
      const B = chunk.blocks;
      const tag = e & ~LOCAL_MASK;
      const y = li & 127;
      for (let d = 0; d < 2; d++) {
        if (d === 0 ? y >= TOP_Y : y <= 0) continue;
        const n = d === 0 ? li + 1 : li - 1;
        const op = OP[B[n]];
        if (op >= LIGHT_MAX) continue;
        const c = s - (op > 1 ? op : 1);
        if (c > (L[n] & 15)) {
          L[n] = (L[n] & 0xf0) | c;
          this._touch(chunk, n);
          q.push(tag | n);
        }
      }
      const lq = li >> 11;
      const lr = (li >> 7) & 15;
      for (let j = 0; j < 6; j++) {
        const nq = lq + DQ[j];
        const nr = lr + DR[j];
        let K = chunk;
        let n;
        let ktag = tag;
        if (nq >= 0 && nq < CHUNK_SIZE && nr >= 0 && nr < CHUNK_SIZE) {
          n = (nq << 11) | (nr << 7) | y;
        } else {
          const dcq = nq < 0 ? -1 : nq >= CHUNK_SIZE ? 1 : 0;
          const dcr = nr < 0 ? -1 : nr >= CHUNK_SIZE ? 1 : 0;
          const k = this._lit(chunk.cq + dcq, chunk.cr + dcr);
          if (k === null) continue;
          K = k;
          ktag = /** @type {*} */ (k).lightSlot << CHUNK_SHIFT;
          n = ((nq - dcq * CHUNK_SIZE) << 11) | ((nr - dcr * CHUNK_SIZE) << 7) | y;
        }
        const op = OP[K.blocks[n]];
        if (op >= LIGHT_MAX) continue;
        const KL = K.light;
        const c = s - (op > 1 ? op : 1);
        if (c > (KL[n] & 15)) {
          KL[n] = (KL[n] & 0xf0) | c;
          this._touch(K, n);
          q.push(ktag | n);
        }
      }
    }
    q.clear();
  }

  /**
   * The removal flood for sky light: every queued cell lost `level`; a neighbour lit no brighter than that (or a
   * free-falling 15 straight below a lost 15) may have been lit through it, so it goes dark too and floods on; a
   * brighter neighbour is lit from elsewhere and re-seeds the add flood.
   */
  _unspreadSky() {
    const q = this._skyDark;
    const relight = this._sky;
    const slots = this._slots;
    while (q.head < q.tail) {
      const e = q.cells[q.head];
      const old = q.levels[q.head];
      q.head++;
      const chunk = slots[e >>> CHUNK_SHIFT];
      if (!chunk) continue;
      const li = e & LOCAL_MASK;
      const tag = e & ~LOCAL_MASK;
      const y = li & 127;
      for (let d = 0; d < 8; d++) {
        let K = chunk;
        let n;
        let ktag = tag;
        if (d === 6) {
          if (y >= TOP_Y) continue;
          n = li + 1;
        } else if (d === 7) {
          if (y <= 0) continue;
          n = li - 1;
        } else {
          const nq = (li >> 11) + DQ[d];
          const nr = ((li >> 7) & 15) + DR[d];
          if (nq >= 0 && nq < CHUNK_SIZE && nr >= 0 && nr < CHUNK_SIZE) {
            n = (nq << 11) | (nr << 7) | y;
          } else {
            const dcq = nq < 0 ? -1 : nq >= CHUNK_SIZE ? 1 : 0;
            const dcr = nr < 0 ? -1 : nr >= CHUNK_SIZE ? 1 : 0;
            const k = this._lit(chunk.cq + dcq, chunk.cr + dcr);
            if (k === null) continue;
            K = k;
            ktag = /** @type {*} */ (k).lightSlot << CHUNK_SHIFT;
            n = ((nq - dcq * CHUNK_SIZE) << 11) | ((nr - dcr * CHUNK_SIZE) << 7) | y;
          }
        }
        const KL = K.light;
        const l = KL[n] >> 4;
        if (l === 0) continue;
        if (l < old || (d === 7 && old === LIGHT_MAX && l === LIGHT_MAX)) {
          KL[n] &= 15;
          this._touch(K, n);
          q.push(ktag | n, l);
        } else {
          relight.push(ktag | n);
        }
      }
    }
    q.clear();
  }

  /** The removal flood for block light (an emitter keeps its own level and re-seeds). */
  _unspreadBlock() {
    const q = this._blockDark;
    const relight = this._block;
    const slots = this._slots;
    const EM = LIGHT_EMISSION;
    while (q.head < q.tail) {
      const e = q.cells[q.head];
      const old = q.levels[q.head];
      q.head++;
      const chunk = slots[e >>> CHUNK_SHIFT];
      if (!chunk) continue;
      const li = e & LOCAL_MASK;
      const tag = e & ~LOCAL_MASK;
      const y = li & 127;
      for (let d = 0; d < 8; d++) {
        let K = chunk;
        let n;
        let ktag = tag;
        if (d === 6) {
          if (y >= TOP_Y) continue;
          n = li + 1;
        } else if (d === 7) {
          if (y <= 0) continue;
          n = li - 1;
        } else {
          const nq = (li >> 11) + DQ[d];
          const nr = ((li >> 7) & 15) + DR[d];
          if (nq >= 0 && nq < CHUNK_SIZE && nr >= 0 && nr < CHUNK_SIZE) {
            n = (nq << 11) | (nr << 7) | y;
          } else {
            const dcq = nq < 0 ? -1 : nq >= CHUNK_SIZE ? 1 : 0;
            const dcr = nr < 0 ? -1 : nr >= CHUNK_SIZE ? 1 : 0;
            const k = this._lit(chunk.cq + dcq, chunk.cr + dcr);
            if (k === null) continue;
            K = k;
            ktag = /** @type {*} */ (k).lightSlot << CHUNK_SHIFT;
            n = ((nq - dcq * CHUNK_SIZE) << 11) | ((nr - dcr * CHUNK_SIZE) << 7) | y;
          }
        }
        const KL = K.light;
        const l = KL[n] & 15;
        if (l === 0) continue;
        if (l < old) {
          let em = EM[K.blocks[n]];
          const X = /** @type {*} */ (K).lightExtra;
          if (X) {
            const x = X.get(n);
            if (x > em) em = x;
          }
          KL[n] = (KL[n] & 0xf0) | em;
          this._touch(K, n);
          q.push(ktag | n, l);
          if (em > 0) relight.push(ktag | n);
        } else {
          relight.push(ktag | n);
        }
      }
    }
    q.clear();
  }
}
