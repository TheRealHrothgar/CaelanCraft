// Unit tests for src/handbookUI.js — the Survival Handbook's two readers (docs/DESIGN-survival.md §14): the Guide (title
// screen and pause menu) and the field book (the `handbook` item). The readers run on a fake DOM built from index.html
// (tests/helpers/fakeDom.js), with the real menus for the Guide buttons.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHandbookUI, paintPaperGrain, bookPages, folioOf, keepUnits, GLYPHS, SINGLE_PAGE_BELOW_PX } from '../../src/handbookUI.js';
import { buildChapters } from '../../src/handbook.js';
import { createMenus } from '../../src/menus.js';
import { documentFromHTML, fire } from '../helpers/fakeDom.js';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const CHAPTERS = buildChapters();

/** @param {object} [opts] */
function setup(opts = {}) {
  const doc = documentFromHTML(html);
  const onClose = vi.fn();
  const ui = createHandbookUI(/** @type {any} */ (doc), { onClose, ...opts });
  const $ = (id) => /** @type {any} */ (doc.getElementById(id));
  return { doc, ui, onClose, $, guide: $('guide'), book: $('handbook') };
}
/** A keydown the way a browser hands it to listeners. */
function key(code, extra = {}) {
  return { type: 'keydown', code, key: code, repeat: false, ...extra };
}
/** Dispatch a keydown on the document (the readers' own listener). */
function press(doc, code, extra) {
  const e = key(code, extra);
  doc.dispatch(e);
  return e;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('pure helpers', () => {
  it('paintPaperGrain: deterministic, translucent brown grain, darker at the thumbed edges', () => {
    const a = paintPaperGrain(120, 160, 7);
    expect(a).toBeInstanceOf(Uint8ClampedArray);
    expect(a.length).toBe(120 * 160 * 4);
    expect(Buffer.from(a).equals(Buffer.from(paintPaperGrain(120, 160, 7)))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(paintPaperGrain(120, 160, 8)))).toBe(false);
    let maxA = 0;
    let marked = 0;
    for (let i = 3; i < a.length; i += 4) {
      maxA = Math.max(maxA, a[i]);
      if (a[i] > 0) {
        marked++;
        expect(a[i - 3] >= a[i - 1], 'brown: red ≥ blue').toBe(true);
      }
    }
    expect(maxA).toBeLessThanOrEqual(110);
    expect(marked / (120 * 160)).toBeGreaterThan(0.1);
    expect(marked / (120 * 160)).toBeLessThan(1);
    const alphaAt = (x, y) => a[(y * 120 + x) * 4 + 3];
    let edge = 0;
    let mid = 0;
    for (let y = 40; y < 120; y++) {
      edge += alphaAt(0, y) + alphaAt(119, y);
      mid += alphaAt(59, y) + alphaAt(60, y);
    }
    expect(edge).toBeGreaterThan(mid * 2);
    expect(paintPaperGrain(0, 0)).toHaveLength(4); // degenerate sizes stay valid
  });

  it('bookPages: a title page and contents, every chapter on a left-hand page, an even count', () => {
    const { pages, start } = bookPages(CHAPTERS);
    expect(pages[0]).toEqual({ type: 'title' });
    expect(pages[1]).toEqual({ type: 'contents' });
    expect(pages.length % 2).toBe(0);
    for (const c of CHAPTERS) {
      expect(start[c.id] % 2, c.id).toBe(0);
      expect(pages[start[c.id]]).toEqual({ type: 'chapter', chapter: CHAPTERS.indexOf(c), page: 0 });
    }
    const chapterPages = pages.filter((p) => p.type === 'chapter');
    expect(chapterPages).toHaveLength(CHAPTERS.reduce((s, c) => s + c.pages.length, 0));
    expect(pages.every((p) => ['title', 'contents', 'chapter', 'blank'].includes(p.type))).toBe(true);
    expect([folioOf(0), folioOf(1), folioOf(2), folioOf(9)]).toEqual(['', '', '1', '8']);
  });

  it('keepUnits glues numbers to their units (no-break space), and nothing else', () => {
    const NB = ' ';
    expect(keepUnits('−11.2 °C')).toBe(`−11.2${NB}°C`);
    expect(keepUnits('50 % and 8 HP/s, 6 HP, 40 s, 5 min, 6 cells, 60 uses, 13.1 m/s')).toBe(
      `50${NB}% and 8${NB}HP/s, 6${NB}HP, 40${NB}s, 5${NB}min, 6${NB}cells, 60${NB}uses, 13.1${NB}m/s`);
    expect(keepUnits('6 Sticks and 3 sticks, 2 Rock, 3 seconds')).toBe(`6 Sticks and 3 sticks, 2 Rock, 3${NB}seconds`);
  });

  it('every chapter icon has a glyph', () => {
    for (const c of CHAPTERS) expect(GLYPHS[c.icon], c.icon).toMatch(/^M/);
  });
});

describe('the Guide (§14.1: title screen and pause menu)', () => {
  it('opens on #guide with the chapter list and the first page; pages and chapters by key; Esc closes', () => {
    const { doc, ui, onClose, guide } = setup();
    expect(guide.classList.contains('hidden')).toBe(true);
    ui.openGuide();
    expect(ui.isOpen()).toBe('guide');
    expect(guide.classList.contains('hidden')).toBe(false);
    const chapters = guide.querySelectorAll('.guide-chapter');
    expect(chapters).toHaveLength(CHAPTERS.length);
    expect(chapters[0].classList.contains('active')).toBe(true);
    expect(guide.querySelector('.guide-content .hb-h').textContent).toBe('Welcome to the honeycomb');
    expect(guide.querySelector('.guide-pos').textContent).toBe(`Page 1 of ${CHAPTERS[0].pages.length}`);
    expect(guide.querySelector('.guide-prev').disabled).toBe(true);
    // PgDn: the next page; ↓: the next chapter; PgUp from a chapter's first page: the last page of the one before
    press(doc, 'PageDown');
    expect(ui.position()).toMatchObject({ chapter: 'first-day', page: 1 });
    press(doc, 'ArrowDown');
    expect(ui.position()).toMatchObject({ chapter: 'water', page: 0 });
    expect(chapters[1].classList.contains('active')).toBe(true);
    press(doc, 'PageUp');
    expect(ui.position()).toMatchObject({ chapter: 'first-day', page: CHAPTERS[0].pages.length - 1 });
    press(doc, 'End');
    expect(ui.position().chapter).toBe('modes');
    press(doc, 'Home');
    expect(ui.position()).toMatchObject({ chapter: 'first-day', page: 0 });
    // clicking a chapter and the Next button
    fire(chapters[4], 'click');
    expect(ui.position()).toMatchObject({ chapter: 'ages', page: 0 });
    fire(guide.querySelector('.guide-next'), 'click');
    expect(ui.position()).toMatchObject({ chapter: 'ages', page: 1 });
    expect(guide.querySelector('.guide-crumb').textContent).toBe(`Tools and the ages · page 2 of ${CHAPTERS[4].pages.length}`);
    const esc = press(doc, 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(ui.isOpen()).toBe(null);
    expect(guide.classList.contains('hidden')).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('guide');
    // it reopens where it was left
    ui.openGuide();
    expect(ui.position()).toMatchObject({ chapter: 'ages', page: 1 });
    ui.openGuide('dangers');
    expect(ui.position()).toMatchObject({ chapter: 'dangers', page: 0 });
  });

  it('the title screen\'s Guide button opens it over the title (z lifted), Esc gives the focus back', () => {
    const { doc, ui, guide, $ } = setup();
    const onGuide = vi.fn(() => ui.openGuide());
    createMenus(/** @type {any} */ (doc), /** @type {any} */ ({ width: 256, height: 256 }), { onGuide });
    const btn = $('btn-guide-title');
    expect($('title-screen').classList.contains('hidden')).toBe(false);
    btn.focus();
    fire(btn, 'click');
    expect(onGuide).toHaveBeenCalledWith('title');
    expect(ui.isOpen()).toBe('guide');
    expect(guide.classList.contains('over-title')).toBe(true);
    expect(doc.activeElement).not.toBe(btn); // the chapter list has the focus while it is open
    press(doc, 'Escape');
    expect(ui.isOpen()).toBe(null);
    expect(doc.activeElement).toBe(btn);
  });

  it('the pause menu\'s Guide button opens it over the pause menu, which stays underneath', () => {
    const { doc, ui, guide, $, onClose } = setup();
    const onGuide = vi.fn(() => ui.openGuide());
    const menus = createMenus(/** @type {any} */ (doc), /** @type {any} */ ({ width: 256, height: 256 }), { onGuide });
    menus.hideTitle();
    menus.showPause(42);
    const btn = $('btn-guide-pause');
    btn.focus();
    fire(btn, 'click');
    expect(onGuide).toHaveBeenCalledWith('pause');
    expect(ui.isOpen()).toBe('guide');
    expect(guide.classList.contains('over-title')).toBe(false);
    expect($('pause-menu').classList.contains('hidden')).toBe(false);
    fire(guide.querySelector('.guide-close'), 'click');
    expect(ui.isOpen()).toBe(null);
    expect(onClose).toHaveBeenCalledWith('guide');
    expect($('pause-menu').classList.contains('hidden')).toBe(false);
    expect(doc.activeElement).toBe(btn);
  });

  it('a click on the dimmed backdrop closes it; a click inside does not', () => {
    const { ui, guide } = setup();
    ui.openGuide();
    fire(guide.querySelector('.guide-content'), 'mousedown');
    expect(ui.isOpen()).toBe('guide');
    fire(guide, 'mousedown');
    expect(ui.isOpen()).toBe(null);
  });

  it('renders every page of every chapter: tips inline as callouts, tables with all their rows', () => {
    const { ui, guide } = setup();
    ui.openGuide();
    CHAPTERS.forEach((c) => {
      ui.openGuide(c.id);
      c.pages.forEach((page, p) => {
        const content = guide.querySelector('.guide-content');
        expect(content.children.length, `${c.id} ${p}`).toBe(page.length);
        const tables = page.filter((b) => b.kind === 'table');
        const rendered = content.querySelectorAll('table.hb-table');
        expect(rendered).toHaveLength(tables.length);
        tables.forEach((t, i) => expect(rendered[i].querySelectorAll('tbody tr')).toHaveLength(t.rows.length));
        expect(content.querySelectorAll('.hb-callout')).toHaveLength(page.filter((b) => b.kind === 'tip' || b.kind === 'warn').length);
        expect(content.querySelectorAll('.hb-figure svg')).toHaveLength(page.filter((b) => b.kind === 'figure').length);
        if (p < c.pages.length - 1) ui.handleKey(/** @type {any} */ (key('PageDown')));
      });
    });
    // key caps and emphasis
    ui.openGuide('first-day');
    expect(guide.querySelector('.guide-content .hb-key').textContent).toBe('R');
    expect(guide.querySelector('.guide-content em')).toBeTruthy();
  });
});

describe('the field book (§14.1: the handbook item)', () => {
  it('opens on #handbook at the title spread; turns two pages with ←/→ and the page corners; Esc closes', () => {
    const { doc, ui, book, onClose } = setup();
    ui.openRustic();
    expect(ui.isOpen()).toBe('rustic');
    expect(book.classList.contains('hidden')).toBe(false);
    const left = book.querySelector('.hb-left');
    const right = book.querySelector('.hb-right');
    expect(left.classList.contains('title-page')).toBe(true);
    expect(book.querySelector('.hb-booktitle').textContent).toBe('Survival Handbook');
    expect(right.classList.contains('contents-page')).toBe(true);
    expect(right.querySelectorAll('.hb-toc-entry')).toHaveLength(CHAPTERS.length);
    expect(left.querySelector('.hb-corner.prev').disabled).toBe(true);
    // the grain canvases are painted once
    for (const c of book.querySelectorAll('canvas.hb-grain')) expect(c.getContext('2d').calls.some(([n]) => n === 'putImageData')).toBe(true);
    press(doc, 'ArrowRight');
    expect(ui.position().spread).toBe(2);
    expect(ui.position().chapter).toBe('first-day');
    expect(left.querySelector('.hb-running').textContent).toBe('Your first day');
    expect(left.querySelector('.hb-h').textContent).toBe('Welcome to the honeycomb');
    expect(left.querySelector('.hb-folio').textContent).toBe('1');
    expect(right.querySelector('.hb-folio').textContent).toBe('2');
    expect(book.querySelector('.hb-spread').classList.contains('turn-next')).toBe(true);
    fire(right.querySelector('.hb-corner.next'), 'click');
    expect(ui.position().spread).toBe(4);
    fire(left.querySelector('.hb-corner.prev'), 'click');
    press(doc, 'ArrowLeft');
    expect(ui.position().spread).toBe(0);
    press(doc, 'ArrowLeft'); // nothing before the title
    expect(ui.position().spread).toBe(0);
    press(doc, 'Escape');
    expect(ui.isOpen()).toBe(null);
    expect(book.classList.contains('hidden')).toBe(true);
    expect(onClose).toHaveBeenCalledWith('rustic');
  });

  it('chapter tabs, the contents and ↑/↓ jump to a chapter\'s first page (always a left-hand page)', () => {
    const { doc, ui, book } = setup();
    const { start } = bookPages(CHAPTERS);
    ui.openRustic();
    const tabs = book.querySelectorAll('.hb-tab');
    expect(tabs.map((t) => t.textContent)).toEqual(CHAPTERS.map((c) => c.short));
    fire(tabs[3], 'click');
    expect(ui.position()).toMatchObject({ spread: start.warmth, chapter: 'warmth' });
    expect(tabs[3].classList.contains('active')).toBe(true);
    expect(book.querySelector('.hb-left .hb-running').textContent).toBe('Warm and cool');
    press(doc, 'ArrowDown');
    expect(ui.position()).toMatchObject({ spread: start.ages, chapter: 'ages' });
    press(doc, 'ArrowUp');
    expect(ui.position().chapter).toBe('warmth');
    press(doc, 'Home');
    expect(ui.position().spread).toBe(0);
    fire(book.querySelector('.hb-toc-entry[data-chapter="death"]'), 'click');
    expect(ui.position()).toMatchObject({ spread: start.death, chapter: 'death' });
    ui.close();
    ui.openRustic('making'); // open at a chapter
    expect(ui.position()).toMatchObject({ spread: start.making, chapter: 'making' });
    ui.close();
    ui.openRustic(); // and it remembers the page
    expect(ui.position().spread).toBe(start.making);
  });

  it('tips and warnings are pencilled into the margin; the last spread cannot turn on', () => {
    const { doc, ui, book } = setup();
    const { pages, start } = bookPages(CHAPTERS);
    ui.openRustic('first-day');
    const left = book.querySelector('.hb-left');
    // first-day page 1 has a tip: it is in the notes column, not in the text
    expect(left.querySelector('.hb-notes .hb-note.hb-tip')).toBeTruthy();
    expect(left.querySelector('.hb-text .hb-tip')).toBeNull();
    expect(left.querySelector('.hb-columns').classList.contains('has-notes')).toBe(true);
    // the recipe tables have no notes: the text takes the whole page
    const kiln = CHAPTERS.find((c) => c.id === 'making').pages.findIndex((p) => p.some((b) => b.kind === 'table' && b.id === 'recipes-kiln'));
    ui.close();
    ui.openRustic('making');
    for (let i = 0; i < Math.floor(kiln / 2); i++) press(doc, 'ArrowRight');
    const shown = [...book.querySelectorAll('.hb-page')].find((pg) => pg.querySelector('table[data-table="recipes-kiln"]'));
    expect(shown).toBeTruthy();
    expect(shown.querySelector('.hb-columns').classList.contains('has-notes')).toBe(false);
    // walk to the end
    for (let i = 0; i < pages.length; i++) press(doc, 'PageDown');
    expect(ui.position().spread).toBe(pages.length - 2);
    expect(book.querySelector('.hb-right .hb-corner.next').disabled).toBe(true);
    expect(start.modes).toBeLessThan(pages.length);
  });

  it('R closes it (the key that opened it); closing on damage is close(); the focus never sits on a button', () => {
    const { doc, ui, book, onClose } = setup();
    ui.openRustic();
    expect(doc.activeElement).toBe(book.querySelector('.hb-book'));
    expect(press(doc, 'KeyR', { repeat: true }).defaultPrevented).toBeFalsy(); // a held R does not
    expect(ui.isOpen()).toBe('rustic');
    press(doc, 'KeyR');
    expect(ui.isOpen()).toBe(null);
    ui.openRustic();
    ui.close(); // main: survival damage closes the field book
    expect(ui.isOpen()).toBe(null);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenLastCalledWith('rustic');
    ui.close(); // closing twice fires nothing more
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('follows the window: resizing below the breakpoint switches to one page at a time', () => {
    const doc = documentFromHTML(html);
    /** @type {Record<string, Function>} */
    const handlers = {};
    doc.defaultView.addEventListener = (type, fn) => { handlers[type] = fn; };
    doc.defaultView.removeEventListener = (type) => { delete handlers[type]; };
    const ui = createHandbookUI(/** @type {any} */ (doc));
    ui.openRustic();
    const bookEl = /** @type {any} */ (doc.querySelector('.hb-book'));
    expect(bookEl.classList.contains('single')).toBe(false);
    doc.defaultView.innerWidth = 700;
    handlers.resize();
    expect(bookEl.classList.contains('single')).toBe(true);
    doc.defaultView.innerWidth = 1280;
    handlers.resize();
    expect(bookEl.classList.contains('single')).toBe(false);
    ui.dispose();
    expect(handlers.resize).toBeUndefined();
  });

  it('a narrow window shows one page at a time and turns one page', () => {
    const { doc, ui, book } = setup();
    doc.defaultView.innerWidth = SINGLE_PAGE_BELOW_PX - 1;
    ui.openRustic();
    expect(book.querySelector('.hb-book').classList.contains('single')).toBe(true);
    press(doc, 'ArrowRight');
    expect(ui.position().spread).toBe(1);
    expect(book.querySelector('.hb-left').classList.contains('contents-page')).toBe(true);
    press(doc, 'ArrowRight');
    expect(ui.position().spread).toBe(2);
  });
});

describe('both readers', () => {
  it('either replaces the other without closing (onClose fires only when the reader closes)', () => {
    const { ui, guide, book, onClose } = setup();
    ui.openRustic();
    ui.openGuide();
    expect(ui.isOpen()).toBe('guide');
    expect(book.classList.contains('hidden')).toBe(true);
    expect(guide.classList.contains('hidden')).toBe(false);
    ui.openRustic();
    expect(ui.isOpen()).toBe('rustic');
    expect(guide.classList.contains('hidden')).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    ui.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('listens on the document only while open; main\'s handleKey and that listener act on an event once', () => {
    const { doc, ui } = setup();
    expect(doc.listenerCount('keydown')).toBe(0);
    ui.openGuide();
    expect(doc.listenerCount('keydown')).toBe(1);
    // main routes the keydown first, then the same event reaches the document listener: one page, not two
    const e = /** @type {any} */ (key('PageDown', { preventDefault() { this.defaultPrevented = true; } }));
    expect(ui.handleKey(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    doc.dispatch(e);
    expect(ui.position().page).toBe(1);
    expect(ui.handleKey(e)).toBe(true); // still reported as the reader's
    // not the reader's keys: Ctrl combinations and keys it does not use
    expect(ui.handleKey(/** @type {any} */ (key('KeyW')))).toBe(false);
    expect(ui.handleKey(/** @type {any} */ (key('Escape', { ctrlKey: true })))).toBe(false);
    expect(ui.handleKey(/** @type {any} */ ({ key: 'Escape' }))).toBe(true); // a key without a code still works
    expect(ui.isOpen()).toBe(null);
    expect(doc.listenerCount('keydown')).toBe(0);
    expect(ui.handleKey(/** @type {any} */ (key('Escape')))).toBe(false); // nothing open: nothing consumed
  });

  it('uses no .mc-button or .picker-panel; the Guide\'s buttons are .hex-button', () => {
    const { ui, guide, book } = setup();
    ui.openGuide();
    ui.openRustic();
    for (const root of [guide, book]) expect(root.querySelectorAll('.mc-button, .picker-panel')).toHaveLength(0);
    for (const b of guide.querySelectorAll('.guide-close, .guide-prev, .guide-next')) expect(b.classList.contains('hex-button')).toBe(true);
    const src = readFileSync(fileURLToPath(new URL('../../src/handbookUI.js', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/mc-button|picker-panel/);
  });

  it('works without its roots in the page (creates them), takes custom chapters, and dispose removes everything', () => {
    const doc = documentFromHTML('<div id="hud"></div>');
    const chapters = [{ id: 'a', title: 'Alpha', short: 'A', icon: 'sun', pages: [[{ kind: 'p', text: 'One *two* [R].' }]] }];
    const ui = createHandbookUI(/** @type {any} */ (doc), { chapters: /** @type {any} */ (chapters) });
    ui.openGuide();
    const guide = /** @type {any} */ (doc.getElementById('guide'));
    expect(guide).toBeTruthy();
    expect(guide.querySelector('.guide-content .hb-p').textContent).toBe('One two R.');
    ui.openRustic();
    expect(doc.getElementById('handbook')).toBeTruthy();
    ui.dispose();
    expect(ui.isOpen()).toBe(null);
    expect(doc.listenerCount('keydown')).toBe(0);
    expect(guide.children).toHaveLength(0);
    ui.openGuide(); // disposed: nothing happens
    expect(ui.isOpen()).toBe(null);
    expect(() => createHandbookUI(/** @type {any} */ (null))).toThrow(TypeError);
  });
});
