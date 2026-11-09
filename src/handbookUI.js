// Caelancraft — the Survival Handbook's two readers, one text (handbook.js) in two skins (docs/DESIGN-survival.md §14):
// - the GUIDE (`#guide`): a clean two-pane reader in the survival palette: the chapter list on the left, one page at a time
//   on the right, .hex-button chrome. Opened from the title screen and the pause menu, in either mode. ↑/↓ chapters,
//   PgUp/PgDn (or ←/→) pages, Esc closes and gives the focus back to whatever had it.
// - the FIELD BOOK (`#handbook`): the `handbook` item, the same chapters as a worn two-page spread: parchment drawn with CSS
//   gradients and a procedural paper-grain canvas (no downloaded images or fonts: a serif system font stack), hand-ruled
//   margins, chapter tabs cut into the page edge, ink tables, tips pencilled into the margin, pages turned with ←/→ or by
//   clicking the page corners. A title page and a table of contents open it; every chapter starts on a left-hand page.
// Either reader replaces the other. While one is open it listens for keydowns on the document itself (like the picker and
// the pack screen); main may also route keydowns to `handleKey`: an event is handled once whichever way it arrives.
//
// DOM module (+ pure helpers, tested). Imports: handbook (the chapters). Every DOM access goes through `doc` and happens
// inside a function, so this file imports in Node. None of the inherited Creative menu chrome (§11): buttons are
// .hex-button, or the field book's own paper tabs and corners.
import { buildChapters, inlineParts } from './handbook.js';

/** @typedef {import('./handbook.js').Chapter} Chapter */
/** @typedef {import('./handbook.js').Block} Block */

const SVG_NS = 'http://www.w3.org/2000/svg';
const HIDDEN = 'hidden';
/** Below this window width the field book shows one page at a time. */
export const SINGLE_PAGE_BELOW_PX = 900;

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

/** @param {number} a uint32 seed @returns {() => number} uniform in [0, 1) (mulberry32, as tiles.js) */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The field book's paper grain: RGBA pixels laid over the parchment gradient with `mix-blend-mode: multiply`. Transparent
 * paper with fine speckle, short laid fibres, a few foxing spots (age stains) and darkened, thumbed edges. Deterministic.
 * @param {number} w @param {number} h @param {number} [seed=1]
 * @returns {Uint8ClampedArray} w·h·4 bytes, alpha ≤ 110
 */
export function paintPaperGrain(w, h, seed = 1) {
  const W = Math.max(1, Math.floor(w));
  const H = Math.max(1, Math.floor(h));
  const px = new Uint8ClampedArray(W * H * 4);
  const rnd = mulberry32((seed * 2654435761) >>> 0);
  /** Darken pixel (x, y) toward brown by `a` (0..255 alpha, composited). */
  const ink = (x, y, a, r = 92, g = 60, b = 30) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    const old = px[i + 3];
    const na = Math.min(110, old + a * (1 - old / 255));
    const t = na > 0 ? a / na : 0;
    px[i] = px[i] + (r - px[i]) * t;
    px[i + 1] = px[i + 1] + (g - px[i + 1]) * t;
    px[i + 2] = px[i + 2] + (b - px[i + 2]) * t;
    px[i + 3] = na;
  };
  // speckle
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (rnd() < 0.09) ink(x, y, 5 + rnd() * 14);
  // laid fibres: short, mostly horizontal strokes
  const fibres = Math.round((W * H) / 220);
  for (let f = 0; f < fibres; f++) {
    let x = rnd() * W;
    let y = rnd() * H;
    const len = 4 + rnd() * 12;
    const ang = (rnd() - 0.5) * 0.7;
    const a = 6 + rnd() * 16;
    for (let s = 0; s < len; s++) {
      ink(Math.floor(x), Math.floor(y), a);
      x += Math.cos(ang);
      y += Math.sin(ang);
    }
  }
  // foxing: soft round stains
  const spots = 5 + Math.floor(rnd() * 5);
  for (let s = 0; s < spots; s++) {
    const cx = rnd() * W;
    const cy = rnd() * H;
    const rad = 3 + rnd() * Math.min(W, H) * 0.05;
    for (let y = Math.floor(cy - rad); y <= cy + rad; y++) {
      for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
        const d = Math.hypot(x - cx, y - cy) / rad;
        if (d < 1) ink(x, y, (1 - d) * (1 - d) * 26, 140, 92, 40);
      }
    }
  }
  // thumbed, darkened edges
  const edge = Math.max(4, Math.round(Math.min(W, H) * 0.06));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.min(x, y, W - 1 - x, H - 1 - y);
      if (d < edge) ink(x, y, ((edge - d) / edge) ** 2 * 46, 110, 70, 30);
    }
  }
  return px;
}

/**
 * The field book's pages, in order: a title page and the contents, then every chapter's pages, each chapter starting on a
 * left-hand (even) page (a blank "notes" page fills the gap), and a final blank page so the last spread is whole.
 * @param {readonly Chapter[]} chapters
 * @returns {{ pages: Array<{ type: 'title'|'contents'|'blank'|'chapter', chapter?: number, page?: number }>,
 *   start: Record<string, number> }} `start`: chapter id → its first page index
 */
export function bookPages(chapters) {
  /** @type {Array<{ type: 'title'|'contents'|'blank'|'chapter', chapter?: number, page?: number }>} */
  const pages = [{ type: 'title' }, { type: 'contents' }];
  /** @type {Record<string, number>} */
  const start = {};
  chapters.forEach((c, ci) => {
    if (pages.length % 2 === 1) pages.push({ type: 'blank', chapter: ci - 1 });
    start[c.id] = pages.length;
    c.pages.forEach((_, pi) => pages.push({ type: 'chapter', chapter: ci, page: pi }));
  });
  if (pages.length % 2 === 1) pages.push({ type: 'blank', chapter: chapters.length - 1 });
  return { pages, start };
}

/** The printed page number of book page `i` (the title and contents pages have none). @param {number} i */
export function folioOf(i) {
  return i >= 2 ? String(i - 1) : '';
}

/** KeyboardEvent → the code this module cares about ('' for anything else). @param {KeyboardEvent} e */
function keyCode(e) {
  const c = e.code || '';
  if (c) return c;
  switch (e.key) {
    case 'Escape': case 'Esc': return 'Escape';
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': case 'PageUp': case 'PageDown':
    case 'Home': case 'End': return e.key;
    case 'r': case 'R': return 'KeyR';
    default: return '';
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Glyphs (24×24, stroked): one per chapter icon, drawn for this game
// ---------------------------------------------------------------------------------------------------------------------

/** Chapter icon → SVG path data. */
export const GLYPHS = Object.freeze({
  sun: 'M17 12a5 5 0 1 1-10 0a5 5 0 1 1 10 0Z M12 1.5v3 M12 19.5v3 M1.5 12h3 M19.5 12h3 M4.6 4.6l2.1 2.1 M17.3 17.3l2.1 2.1 M4.6 19.4l2.1-2.1 M17.3 6.7l2.1-2.1',
  drop: 'M12 2.5C9 7.5 5.5 10.5 5.5 15a6.5 6.5 0 0 0 13 0c0-4.5-3.5-7.5-6.5-12.5Z M9 15.5a3 3 0 0 0 3 3',
  flame: 'M12 2c1.5 4 6 6.5 6 12a6 6 0 0 1-12 0c0-3 1.5-5 3-6.5.3 2 1.2 3.4 2.3 4.2C11 9 10.8 5.5 12 2Z',
  thermo: 'M10 4.5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0Z M12 9v7',
  pick: 'M3 8.5c5-4.5 13-4.5 18 0 M12 5v16.5',
  anvil: 'M3 7h13c0 2.8 2 4 5 4v1.2h-5.5L14 15h3v3.5H7V15h3l-1-3C5.2 11.5 3 9.8 3 7Z',
  hazard: 'M12 2.2l8.5 4.9v9.8L12 21.8l-8.5-4.9V7.1Z M12 7.5v6.5 M12 16.8v.4',
  hide: 'M12 4.5l6.5 3.75v7.5L12 19.5l-6.5-3.75v-7.5Z M12 1.5v3 M18.5 8.25l2.6-1.5 M18.5 15.75l2.6 1.5 M12 19.5v3 M5.5 15.75l-2.6 1.5 M5.5 8.25l-2.6-1.5',
  keys: 'M3.5 6.5h17v11h-17Z M7 10h.01 M10.5 10h.01 M14 10h.01 M17 10h.01 M7.5 14h9',
  switch: 'M3 12l4-6h4.5v12H7Z M12.5 6H17l4 6-4 6h-4.5',
  hex: 'M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5Z',
});

// ---------------------------------------------------------------------------------------------------------------------
// The readers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} HandbookUI
 * @property {(chapterId?: string) => void} openGuide    the clean Guide (menus); replaces the field book if it is open
 * @property {(chapterId?: string) => void} openRustic   the field book (the item); replaces the Guide if it is open
 * @property {() => void} close                           closes whichever is open (onClose fires once)
 * @property {() => ('guide'|'rustic'|null)} isOpen
 * @property {(e: KeyboardEvent) => boolean} handleKey    Esc, arrows, PgUp/PgDn (R closes the field book); true = consumed
 * @property {() => { mode: 'guide'|'rustic'|null, chapter: string, page: number, spread: number }} position
 * @property {() => void} dispose
 */

/**
 * @param {Document} doc
 * @param {{ chapters?: readonly Chapter[], onClose?: (kind: 'guide'|'rustic') => void }} [opts]
 * @returns {HandbookUI}
 */
export function createHandbookUI(doc, { chapters, onClose } = {}) {
  if (!doc || typeof doc.createElement !== 'function') throw new TypeError('createHandbookUI: a Document is required');
  const book = chapters && chapters.length ? chapters : buildChapters();
  const layout = bookPages(book);

  /** @type {Array<[EventTarget, string, EventListener]>} */
  const listeners = [];
  /** @param {EventTarget} target @param {string} type @param {EventListener} fn */
  function on(target, type, fn) {
    target.addEventListener(type, fn);
    listeners.push([target, type, fn]);
  }
  /** @param {string} tag @param {string} [className] @param {string} [text] @returns {HTMLElement} */
  function make(tag, className, text) {
    const node = /** @type {HTMLElement} */ (doc.createElement(tag));
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  /** @param {string} tag @param {Record<string, string|number>} [attrs] @returns {Element} */
  function svg(tag, attrs = {}) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }
  /** @param {Element} node */
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  /** @param {string} cls @param {string} [text] @param {string} [label] aria-label @returns {HTMLButtonElement} */
  function button(cls, text, label) {
    const b = /** @type {HTMLButtonElement} */ (make('button', cls, text));
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    return b;
  }
  /** @param {string} id @param {string} label */
  function rootFor(id, label) {
    let root = doc.getElementById(id);
    if (!root) {
      root = make('div', `layer ${HIDDEN}`);
      root.id = id;
      (doc.body || doc.documentElement).appendChild(root);
    }
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', label);
    return root;
  }

  const state = {
    /** @type {'guide'|'rustic'|null} */
    mode: null,
    disposed: false,
    keysAttached: false,
    guideBuilt: false,
    rusticBuilt: false,
    /** Guide position */
    gChapter: 0,
    gPage: 0,
    /** Field book position: the first page shown (even in two-page mode) */
    spread: 0,
    perView: 2,
    /** @type {HTMLElement|null} focused before a reader opened; gets the focus back on close */
    returnFocus: null,
  };
  /** Keydown events already acted on (main's route and the document listener may both see one). */
  const handled = new WeakSet();

  /** @type {Record<string, any>} */
  const g = {};
  /** @type {Record<string, any>} */
  const r = {};

  // ---- shared block rendering ---------------------------------------------------------------------------------------

  /** Append marked-up text: *emphasis* and [Key] caps. @param {Element} el @param {string} text */
  function inline(el, text) {
    for (const part of inlineParts(text)) {
      if (part.t === 'text') el.appendChild(doc.createTextNode(part.s));
      else el.appendChild(make(part.t === 'em' ? 'em' : 'kbd', part.t === 'em' ? '' : 'hb-key', part.s));
    }
    return el;
  }

  /** @param {string} name @param {string} [cls] */
  function glyph(name, cls = 'hb-glyph') {
    const s = svg('svg', { viewBox: '0 0 24 24', width: 20, height: 20, class: cls, 'aria-hidden': 'true' });
    s.appendChild(svg('path', { d: GLYPHS[name] ?? GLYPHS.hex }));
    return s;
  }

  /** @param {import('./handbook.js').TableBlock} b */
  function renderTable(b) {
    const wrap = make('div', 'hb-table-wrap');
    const t = make('table', 'hb-table');
    t.dataset.table = b.id;
    const caption = make('caption', '', b.caption);
    t.appendChild(caption);
    const thead = make('thead');
    const hr = make('tr');
    for (const hcell of b.head) hr.appendChild(make('th', '', hcell));
    thead.appendChild(hr);
    t.appendChild(thead);
    const tbody = make('tbody');
    b.rows.forEach((row, i) => {
      const tr = make('tr');
      tr.dataset.key = String(b.keys[i] ?? i);
      for (const cell of row) tr.appendChild(make('td', '', cell));
      tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    wrap.appendChild(t);
    return wrap;
  }

  /** @param {import('./handbook.js').FigureBlock} b */
  function renderFigure(b) {
    const fig = make('figure', `hb-figure fig-${b.figure}`);
    let drawing = null;
    if (b.figure === 'fire-spots') drawing = drawFireSpots(b.data);
    else if (b.figure === 'ages') drawing = drawAges(b.data);
    else if (b.figure === 'bands') drawing = drawBands(b.data);
    if (drawing) fig.appendChild(drawing);
    fig.appendChild(make('figcaption', '', b.caption));
    return fig;
  }

  /** A pointy-top hexagon's points string. */
  function hexPoints(cx, cy, rad, flat = false) {
    const pts = [];
    for (let k = 0; k < 6; k++) {
      const a = ((60 * k + (flat ? 0 : -90)) * Math.PI) / 180;
      pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`);
    }
    return pts.join(' ');
  }

  /** The campfire from above: six corner stones with leaning skewers (numbered), the embers and a pot. */
  function drawFireSpots(data) {
    const n = Math.max(1, Math.min(12, Number(data?.skewers) || 6));
    const s = svg('svg', { viewBox: '0 0 240 200', class: 'fig-svg', role: 'img', 'aria-label': `${n} skewers round a campfire, a pot in the embers` });
    const cx = 120;
    const cy = 100;
    s.appendChild(svg('polygon', { points: hexPoints(cx, cy, 84), class: 'fig-cell' }));
    s.appendChild(svg('circle', { cx, cy, r: 30, class: 'fig-embers' }));
    for (let k = 0; k < n; k++) {
      const a = ((60 * k - 90) * Math.PI) / 180;
      const sx = cx + 66 * Math.cos(a);
      const sy = cy + 66 * Math.sin(a);
      const tx = cx + 40 * Math.cos(a);
      const ty = cy + 40 * Math.sin(a);
      s.appendChild(svg('line', { x1: sx.toFixed(1), y1: sy.toFixed(1), x2: tx.toFixed(1), y2: ty.toFixed(1), class: 'fig-skewer' }));
      s.appendChild(svg('polygon', { points: hexPoints(tx, ty, 6), class: 'fig-food' }));
      s.appendChild(svg('circle', { cx: sx.toFixed(1), cy: sy.toFixed(1), r: 9, class: 'fig-stone' }));
      const label = svg('text', { x: (cx + 92 * Math.cos(a)).toFixed(1), y: (cy + 92 * Math.sin(a) + 4).toFixed(1), class: 'fig-label', 'text-anchor': 'middle' });
      label.textContent = String(k + 1);
      s.appendChild(label);
    }
    s.appendChild(svg('polygon', { points: hexPoints(cx, cy, 13), class: 'fig-pot' }));
    const t = svg('text', { x: cx, y: cy + 4, class: 'fig-label fig-small', 'text-anchor': 'middle' });
    t.textContent = 'pot';
    s.appendChild(t);
    return s;
  }

  /** The ages as a chain of hexes, each with what it first opens. */
  function drawAges(data) {
    const list = Array.isArray(data) ? data : [];
    const step = 80;
    const s = svg('svg', { viewBox: `0 0 ${Math.max(1, list.length) * step + 10} 132`, class: 'fig-svg', role: 'img',
      'aria-label': list.map((d) => d.name).join(', ') });
    list.forEach((d, i) => {
      const x = 45 + i * step;
      if (i > 0) s.appendChild(svg('path', { d: `M${x - 48} 44l6 4-6 4`, class: 'fig-arrow' }));
      s.appendChild(svg('polygon', { points: hexPoints(x, 48, 30), class: `fig-age fig-age-${d.tier}` }));
      const name = svg('text', { x, y: 52, class: 'fig-label fig-age-name', 'text-anchor': 'middle' });
      name.textContent = d.name;
      s.appendChild(name);
      (d.opens.length ? d.opens : ['faster,', 'tougher']).forEach((o, j) => {
        const t = svg('text', { x, y: 96 + j * 13, class: 'fig-label fig-small', 'text-anchor': 'middle' });
        t.textContent = o;
        s.appendChild(t);
      });
    });
    return s;
  }

  /** Body temperature as a banded scale from 29 to 43 °C, 37 °C marked. */
  function drawBands(data) {
    const list = Array.isArray(data) ? data : [];
    const lo = 29;
    const hi = 43;
    const X = (t) => 16 + ((Math.max(lo, Math.min(hi, t)) - lo) / (hi - lo)) * 528;
    const s = svg('svg', { viewBox: '0 0 560 104', class: 'fig-svg', role: 'img', 'aria-label': 'Body temperature bands' });
    const ordered = [...list].sort((a, b) => (a.from ?? -Infinity) - (b.from ?? -Infinity));
    ordered.forEach((b, i) => {
      const x0 = X(b.from ?? lo);
      const x1 = X(b.to ?? hi);
      s.appendChild(svg('rect', { x: x0.toFixed(1), y: 38, width: (x1 - x0).toFixed(1), height: 22, class: `fig-band fig-band-${i}` }));
      const t = svg('text', { x: ((x0 + x1) / 2).toFixed(1), y: i % 2 ? 30 : 16, class: 'fig-label fig-small', 'text-anchor': 'middle' });
      t.textContent = b.label;
      s.appendChild(t);
      if (b.to !== null && b.to !== undefined && Number.isFinite(b.to)) {
        const n = svg('text', { x: x1.toFixed(1), y: 76, class: 'fig-label fig-small', 'text-anchor': 'middle' });
        n.textContent = String(b.to);
        s.appendChild(n);
      }
    });
    s.appendChild(svg('path', { d: `M${X(37).toFixed(1)} 64l-6 22h12Z`, class: 'fig-mark' }));
    const home = svg('text', { x: X(37).toFixed(1), y: 100, class: 'fig-label fig-small', 'text-anchor': 'middle' });
    home.textContent = '37 °C';
    s.appendChild(home);
    return s;
  }

  /**
   * Render a page's blocks. Tips and warnings go to `notes` (the field book's margin) when given, else inline.
   * @param {readonly Block[]} blocks @param {HTMLElement} text @param {HTMLElement|null} notes
   */
  function renderBlocks(blocks, text, notes) {
    for (const b of blocks) {
      if (b.kind === 'h') text.appendChild(inline(make('h3', 'hb-h'), b.text));
      else if (b.kind === 'p') text.appendChild(inline(make('p', 'hb-p'), b.text));
      else if (b.kind === 'tip' || b.kind === 'warn') {
        const label = b.kind === 'tip' ? (notes ? 'note' : 'Tip') : (notes ? 'mind' : 'Careful');
        const box = make(notes ? 'div' : 'aside', `${notes ? 'hb-note' : 'hb-callout'} hb-${b.kind}`);
        box.appendChild(make('span', 'hb-note-label', label));
        inline(box, b.text);
        (notes || text).appendChild(box);
      } else if (b.kind === 'list') {
        const list = make(b.ordered ? 'ol' : 'ul', 'hb-list');
        for (const item of b.items) list.appendChild(inline(make('li'), item));
        text.appendChild(list);
      } else if (b.kind === 'table') text.appendChild(renderTable(b));
      else if (b.kind === 'figure') text.appendChild(renderFigure(b));
    }
  }

  // ---- the Guide ------------------------------------------------------------------------------------------------------

  function buildGuide() {
    if (state.guideBuilt) return;
    state.guideBuilt = true;
    const root = rootFor('guide', 'Survival Guide');
    g.root = root;
    clear(root);
    const panel = make('div', 'guide-panel');
    root.appendChild(panel);
    const head = make('div', 'guide-head');
    panel.appendChild(head);
    const mark = make('span', 'guide-mark');
    mark.appendChild(glyph('hex', 'guide-hex'));
    head.appendChild(mark);
    const title = make('h2', 'guide-title', 'Survival Guide');
    title.id = 'guide-title';
    head.appendChild(title);
    head.appendChild(make('span', 'guide-sub', 'the handbook, clean copy'));
    g.close = button('hex-button guide-close', 'Close', 'Close the Guide (Esc)');
    head.appendChild(g.close);
    on(g.close, 'click', () => close());

    const body = make('div', 'guide-body');
    panel.appendChild(body);
    g.nav = make('nav', 'guide-nav');
    g.nav.setAttribute('aria-label', 'Chapters');
    body.appendChild(g.nav);
    g.chapterButtons = book.map((c, i) => {
      const b = button('guide-chapter', undefined);
      b.dataset.chapter = c.id;
      b.appendChild(glyph(c.icon));
      b.appendChild(make('span', 'guide-chapter-title', c.title));
      b.appendChild(make('span', 'guide-count', String(c.pages.length)));
      b.setAttribute('aria-label', `${c.title}, ${c.pages.length} page${c.pages.length === 1 ? '' : 's'}`);
      on(b, 'click', () => showGuide(i, 0));
      g.nav.appendChild(b);
      return b;
    });
    g.page = make('article', 'guide-page');
    g.page.setAttribute('tabindex', '-1');
    g.page.setAttribute('aria-live', 'polite');
    body.appendChild(g.page);
    g.crumb = make('div', 'guide-crumb');
    g.page.appendChild(g.crumb);
    g.content = make('div', 'guide-content');
    g.page.appendChild(g.content);

    const foot = make('div', 'guide-foot');
    panel.appendChild(foot);
    g.prev = button('hex-button guide-prev', '‹ Previous', 'Previous page (PgUp)');
    g.pos = make('span', 'guide-pos');
    g.next = button('hex-button guide-next', 'Next ›', 'Next page (PgDn)');
    foot.appendChild(g.prev);
    foot.appendChild(g.pos);
    foot.appendChild(g.next);
    foot.appendChild(make('span', 'guide-keys', '↑ ↓ chapters · PgUp PgDn pages · Esc close'));
    on(g.prev, 'click', () => guidePage(-1));
    on(g.next, 'click', () => guidePage(1));
    on(root, 'mousedown', (e) => {
      if (e.target === root) close(); // a click on the dimmed backdrop
    });
  }

  /** Show chapter ci, page pi in the Guide. */
  function showGuide(ci, pi) {
    const c = Math.max(0, Math.min(book.length - 1, ci));
    const pages = book[c].pages;
    const p = Math.max(0, Math.min(pages.length - 1, pi));
    state.gChapter = c;
    state.gPage = p;
    g.chapterButtons.forEach((b, i) => {
      b.classList.toggle('active', i === c);
      if (i === c) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
    clear(g.content);
    renderBlocks(pages[p], g.content, null);
    g.crumb.textContent = `${book[c].title} · page ${p + 1} of ${pages.length}`;
    g.pos.textContent = `Page ${p + 1} of ${pages.length}`;
    const first = c === 0 && p === 0;
    const last = c === book.length - 1 && p === pages.length - 1;
    g.prev.disabled = first;
    g.next.disabled = last;
    g.page.scrollTop = 0;
  }

  /** One page back or on, across chapters. @param {number} d */
  function guidePage(d) {
    let c = state.gChapter;
    let p = state.gPage + d;
    if (p < 0) {
      if (c === 0) return;
      c--;
      p = book[c].pages.length - 1;
    } else if (p >= book[c].pages.length) {
      if (c === book.length - 1) return;
      c++;
      p = 0;
    }
    showGuide(c, p);
  }

  // ---- the field book -------------------------------------------------------------------------------------------------

  /** @param {'left'|'right'} side */
  function buildPage(side) {
    const page = make('div', `hb-page hb-${side}`);
    const grain = /** @type {HTMLCanvasElement} */ (make('canvas', 'hb-grain'));
    grain.width = 240;
    grain.height = 320;
    grain.setAttribute('aria-hidden', 'true');
    page.appendChild(grain);
    const inner = make('div', 'hb-page-inner');
    page.appendChild(inner);
    const running = make('div', 'hb-running');
    inner.appendChild(running);
    const columns = make('div', 'hb-columns');
    inner.appendChild(columns);
    const text = make('div', 'hb-text');
    const notes = make('div', 'hb-notes');
    columns.appendChild(text);
    columns.appendChild(notes);
    const folio = make('div', 'hb-folio');
    page.appendChild(folio);
    // Both corners on both pages: the outer ones turn in a two-page spread (CSS hides the inner pair); a single page in a
    // narrow window uses both of its own.
    const prev = button('hb-corner prev', undefined, 'Turn back a page (←)');
    const next = button('hb-corner next', undefined, 'Turn the page (→)');
    page.appendChild(prev);
    page.appendChild(next);
    on(prev, 'click', () => turn(-1));
    on(next, 'click', () => turn(1));
    return { page, grain, running, columns, text, notes, folio, prev, next, painted: false };
  }

  /** Paint a page's grain once (each side its own seed). */
  function paintGrain(pg, seed) {
    if (pg.painted) return;
    pg.painted = true;
    const ctx = typeof pg.grain.getContext === 'function' ? pg.grain.getContext('2d') : null;
    if (!ctx || typeof ctx.createImageData !== 'function') return;
    try {
      const img = ctx.createImageData(pg.grain.width, pg.grain.height);
      img.data.set(paintPaperGrain(pg.grain.width, pg.grain.height, seed));
      ctx.putImageData(img, 0, 0);
    } catch {
      // the gradient parchment alone still reads as paper
    }
  }

  function buildRustic() {
    if (state.rusticBuilt) return;
    state.rusticBuilt = true;
    const root = rootFor('handbook', 'Survival Handbook');
    r.root = root;
    clear(root);
    const bookEl = make('div', 'hb-book');
    bookEl.setAttribute('tabindex', '-1');
    r.book = bookEl;
    root.appendChild(bookEl);
    r.spread = make('div', 'hb-spread');
    bookEl.appendChild(r.spread);
    r.left = buildPage('left');
    r.right = buildPage('right');
    r.spread.appendChild(r.left.page);
    r.spread.appendChild(make('div', 'hb-gutter'));
    r.spread.appendChild(r.right.page);
    r.tabs = make('div', 'hb-tabs');
    r.tabs.setAttribute('aria-label', 'Chapters');
    bookEl.appendChild(r.tabs);
    r.tabButtons = book.map((c) => {
      const b = button('hb-tab', c.short || c.title, c.title);
      b.dataset.chapter = c.id;
      on(b, 'click', () => goToChapter(c.id));
      r.tabs.appendChild(b);
      return b;
    });
    r.close = button('hb-close', 'Close', 'Close the book (Esc)');
    bookEl.appendChild(r.close);
    on(r.close, 'click', () => close());
    bookEl.appendChild(make('div', 'hb-hint', '← → turn the page · ↑ ↓ chapters · Esc close'));
    on(root, 'mousedown', (e) => {
      if (e.target === root) close();
    });
  }

  /** How many pages the field book shows at once (one in a narrow window). */
  function perView() {
    const w = doc.defaultView?.innerWidth;
    return typeof w === 'number' && w > 0 && w < SINGLE_PAGE_BELOW_PX ? 1 : 2;
  }

  /** Normalise a spread start for the current view. @param {number} i */
  function spreadStart(i) {
    const last = layout.pages.length - 1;
    const v = Math.max(0, Math.min(last, Math.floor(i)));
    return state.perView === 2 ? v - (v % 2) : v;
  }

  /** Fill one page of the field book. */
  function fillPage(pg, index) {
    const entry = layout.pages[index];
    clear(pg.text);
    clear(pg.notes);
    pg.page.classList.toggle(HIDDEN, !entry);
    pg.page.dataset.page = String(index);
    if (!entry) return;
    pg.folio.textContent = folioOf(index);
    pg.page.classList.remove('title-page', 'contents-page', 'blank-page');
    if (entry.type === 'title') {
      pg.page.classList.add('title-page');
      pg.running.textContent = '';
      const t = make('div', 'hb-titleblock');
      const emblem = svg('svg', { viewBox: '0 0 24 24', class: 'hb-emblem', 'aria-hidden': 'true' });
      emblem.appendChild(svg('path', { d: GLYPHS.hex }));
      emblem.appendChild(svg('path', { d: 'M12 7.5l3.9 2.25v4.5L12 16.5l-3.9-2.25v-4.5Z' }));
      t.appendChild(emblem);
      t.appendChild(make('div', 'hb-booktitle', 'Survival Handbook'));
      t.appendChild(make('div', 'hb-booksub', 'a field book for the honeycomb'));
      t.appendChild(make('div', 'hb-bookfoot', 'If found, return to the nearest campfire.'));
      pg.text.appendChild(t);
    } else if (entry.type === 'contents') {
      pg.page.classList.add('contents-page');
      pg.running.textContent = 'Contents';
      const list = make('ol', 'hb-toc');
      book.forEach((c) => {
        const li = make('li');
        const b = button('hb-toc-entry', undefined, `${c.title}, page ${folioOf(layout.start[c.id])}`);
        b.dataset.chapter = c.id;
        b.appendChild(make('span', 'hb-toc-title', c.title));
        b.appendChild(make('span', 'hb-toc-dots'));
        b.appendChild(make('span', 'hb-toc-page', folioOf(layout.start[c.id])));
        on(b, 'click', () => goToChapter(c.id));
        li.appendChild(b);
        list.appendChild(li);
      });
      pg.text.appendChild(list);
    } else if (entry.type === 'blank') {
      pg.page.classList.add('blank-page');
      pg.running.textContent = 'Notes';
    } else {
      const c = book[/** @type {number} */ (entry.chapter)];
      pg.running.textContent = c.title;
      renderBlocks(c.pages[/** @type {number} */ (entry.page)], pg.text, pg.notes);
    }
    pg.columns.classList.toggle('has-notes', pg.notes.children.length > 0);
    pg.columns.scrollTop = 0;
  }

  /** The chapter shown on the current spread (the left page's, or the right page's when the left is not a chapter). */
  function spreadChapter() {
    for (const i of [state.spread, state.spread + 1]) {
      const e = layout.pages[i];
      if (e && e.type === 'chapter') return /** @type {number} */ (e.chapter);
    }
    return -1;
  }

  function renderRustic(direction = 0) {
    state.perView = perView();
    state.spread = spreadStart(state.spread);
    r.book.classList.toggle('single', state.perView === 1);
    fillPage(r.left, state.spread);
    if (state.perView === 2) fillPage(r.right, state.spread + 1);
    paintGrain(r.left, 11);
    paintGrain(r.right, 23);
    const atStart = state.spread === 0;
    const atEnd = state.spread >= spreadStart(layout.pages.length - 1);
    for (const pg of [r.left, r.right]) {
      pg.prev.disabled = atStart;
      pg.next.disabled = atEnd;
    }
    const ch = spreadChapter();
    r.tabButtons.forEach((b, i) => b.classList.toggle('active', i === ch));
    if (direction) {
      r.spread.classList.remove('turn-next', 'turn-prev');
      void r.spread.offsetWidth; // restart the animation
      r.spread.classList.add(direction > 0 ? 'turn-next' : 'turn-prev');
    }
  }

  /** Turn by one view (two pages, or one in a narrow window). @param {number} d */
  function turn(d) {
    const next = spreadStart(state.spread + d * state.perView);
    if (next === state.spread) return;
    state.spread = next;
    renderRustic(d);
  }

  /** @param {string} id */
  function goToChapter(id) {
    if (!Object.hasOwn(layout.start, id)) return;
    if (state.mode === 'guide') {
      showGuide(book.findIndex((c) => c.id === id), 0);
      return;
    }
    const target = spreadStart(layout.start[id]);
    const d = Math.sign(target - state.spread);
    state.spread = target;
    renderRustic(d);
  }

  /** The next / previous chapter in the field book. @param {number} d */
  function rusticChapter(d) {
    const cur = spreadChapter();
    let ci = cur < 0 ? (d > 0 ? 0 : -1) : cur + d;
    if (cur < 0 && d < 0) return;
    ci = Math.max(0, Math.min(book.length - 1, ci));
    goToChapter(book[ci].id);
  }

  // ---- open / close / keys ----------------------------------------------------------------------------------------------

  function attachKeys() {
    if (state.keysAttached) return;
    state.keysAttached = true;
    doc.addEventListener('keydown', onDocKey);
  }
  function detachKeys() {
    if (!state.keysAttached) return;
    state.keysAttached = false;
    doc.removeEventListener('keydown', onDocKey);
  }
  /** @param {KeyboardEvent} e */
  function onDocKey(e) {
    if (handleKey(e) && typeof e.stopPropagation === 'function') e.stopPropagation();
  }

  /** Remember what had the focus (the Guide button), unless a reader already had it. */
  function rememberFocus() {
    if (state.mode) return;
    const a = /** @type {HTMLElement|null} */ (doc.activeElement);
    state.returnFocus = a && a !== doc.body && typeof a.focus === 'function' ? a : null;
  }

  /** @param {HTMLElement|null|undefined} node */
  function focusEl(node) {
    if (!node || typeof node.focus !== 'function') return;
    try {
      node.focus({ preventScroll: true });
    } catch {
      node.focus();
    }
  }

  /** @param {string} [chapterId] */
  function openGuide(chapterId) {
    if (state.disposed) return;
    rememberFocus();
    if (state.mode === 'rustic') r.root.classList.add(HIDDEN);
    buildGuide();
    const title = doc.getElementById('title-screen');
    g.root.classList.toggle('over-title', !!title && !title.classList.contains(HIDDEN));
    const ci = chapterId ? book.findIndex((c) => c.id === chapterId) : -1;
    showGuide(ci >= 0 ? ci : state.gChapter, ci >= 0 ? 0 : state.gPage);
    g.root.classList.remove(HIDDEN);
    state.mode = 'guide';
    attachKeys();
    focusEl(g.chapterButtons[state.gChapter]);
  }

  /** @param {string} [chapterId] */
  function openRustic(chapterId) {
    if (state.disposed) return;
    rememberFocus();
    if (state.mode === 'guide') g.root.classList.add(HIDDEN);
    buildRustic();
    if (chapterId && Object.hasOwn(layout.start, chapterId)) state.spread = layout.start[chapterId];
    state.mode = 'rustic';
    renderRustic(0);
    r.root.classList.remove(HIDDEN);
    attachKeys();
    focusEl(r.book); // not a button: a stray Space or Enter must not close the book
  }

  function close() {
    const was = state.mode;
    if (!was) return;
    state.mode = null;
    if (g.root) g.root.classList.add(HIDDEN);
    if (r.root) r.root.classList.add(HIDDEN);
    detachKeys();
    const back = state.returnFocus;
    state.returnFocus = null;
    if (back && (back.isConnected ?? true)) focusEl(back);
    else {
      const a = /** @type {HTMLElement|null} */ (doc.activeElement);
      if (a && typeof a.blur === 'function' && ((g.root && g.root.contains(a)) || (r.root && r.root.contains(a)))) a.blur();
    }
    if (typeof onClose === 'function') onClose(was);
  }

  /**
   * A keydown while a reader is open. Esc closes; the Guide: ↑/↓ chapters, PgUp/PgDn and ←/→ pages; the field book: ←/→
   * and PgUp/PgDn turn, ↑/↓ chapters, R closes. Each event is handled at most once.
   * @param {KeyboardEvent} e
   * @returns {boolean} the key was the reader's (the caller should not act on it)
   */
  function handleKey(e) {
    if (!state.mode || !e || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (handled.has(e)) return true;
    const code = keyCode(e);
    let did = true;
    if (code === 'Escape') {
      if (e.repeat) return false;
      close();
    } else if (state.mode === 'guide') {
      if (code === 'ArrowUp') showGuide(state.gChapter - 1, 0);
      else if (code === 'ArrowDown') showGuide(state.gChapter + 1, 0);
      else if (code === 'PageUp' || code === 'ArrowLeft') guidePage(-1);
      else if (code === 'PageDown' || code === 'ArrowRight') guidePage(1);
      else if (code === 'Home') showGuide(0, 0);
      else if (code === 'End') showGuide(book.length - 1, 0);
      else did = false;
      if (did && (code === 'ArrowUp' || code === 'ArrowDown' || code === 'Home' || code === 'End')) focusEl(g.chapterButtons[state.gChapter]);
    } else {
      if (code === 'ArrowLeft' || code === 'PageUp') turn(-1);
      else if (code === 'ArrowRight' || code === 'PageDown') turn(1);
      else if (code === 'ArrowUp') rusticChapter(-1);
      else if (code === 'ArrowDown') rusticChapter(1);
      else if (code === 'Home') goToPage(0);
      else if (code === 'KeyR' && !e.repeat) close();
      else did = false;
    }
    if (!did) return false;
    handled.add(e);
    if (typeof e.preventDefault === 'function') e.preventDefault();
    return true;
  }

  /** The spread holding book page i (0: the title spread). @param {number} i */
  function goToPage(i) {
    const d = Math.sign(i - state.spread);
    state.spread = spreadStart(i);
    renderRustic(d);
  }

  function isOpen() {
    return state.mode;
  }

  function position() {
    const chapter = state.mode === 'rustic' ? (book[spreadChapter()]?.id ?? '') : book[state.gChapter].id;
    return { mode: state.mode, chapter, page: state.gPage, spread: state.spread };
  }

  function dispose() {
    if (state.disposed) return;
    state.mode = null;
    detachKeys();
    state.disposed = true;
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners.length = 0;
    for (const root of [g.root, r.root]) {
      if (!root) continue;
      root.classList.add(HIDDEN);
      clear(root);
    }
  }

  return { openGuide, openRustic, close, isOpen, handleKey, position, dispose };
}
