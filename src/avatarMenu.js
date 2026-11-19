// Caelancraft — the Avatar chooser (DOM). See src/CONTRACTS.md §91.
//
// "Who do you want to be?": one card per avatar on a plain ROUNDED SQUARE (never a hexagon badge), each with a portrait
// of its head and shoulders — the avatar's own model drawn once by the game's renderer (avatarRenderer.renderAvatarPortraits,
// handed in as opts.portrait) — and its name; the chosen one is lit in honey. Opened from the title screen (`#btn-avatar-title`, beside the Survival Guide button) and from the pause
// menu (`#btn-avatar-pause`, in its "You" row); both buttons say who is chosen. A click or Enter / Space on a card chooses
// it (opts.onChoose: main stores it and swaps the model at once); the arrow keys move between the cards; Done, Esc or a
// click on the dimmed backdrop closes it and gives the focus back. The pause menu's View button reports clicks
// (opts.onView); main switches the view and calls setView with its label.
//
// DOM module. Every DOM access goes through `doc` and happens inside a function, so this file imports in Node.
import { AVATARS, avatarById } from './avatars.js';

const HIDDEN = 'hidden';
/** Screens the chooser can open over, made `inert` while it is open (as the Guide and the Sound Test do). */
export const INERT_BENEATH = Object.freeze(['title-screen', 'pause-menu']);
/** The portraits' size on screen (CSS pixels). */
export const PORTRAIT_PX = 120;

/** @typedef {{ width: number, height: number, data: Uint8ClampedArray }} Picture  RGBA, sRGB, row 0 at the top */

/** The text of the buttons that open the chooser. @param {string} id @returns {string} */
export function avatarButtonLabel(id) {
  return `Avatar: ${avatarById(id).displayName}`;
}

/**
 * @typedef {Object} AvatarMenuOptions
 * @property {string} current                    the chosen avatar's id
 * @property {(id: string) => void} [onChoose]   a card was chosen
 * @property {() => void} [onView]               the pause menu's View button was clicked
 * @property {string} [viewLabel]                that button's text
 * @property {(id: string) => Picture|null} [portrait]  an avatar's portrait (asked for when the chooser is first opened;
 *   none: the card shows its plain background)
 */

/**
 * @param {Document} doc
 * @param {AvatarMenuOptions} opts
 */
export function createAvatarMenu(doc, opts) {
  const state = {
    current: avatarById(opts.current).id,
    open: false,
    built: false,
    disposed: false,
    /** @type {HTMLElement|null} */
    returnFocus: null,
    /** @type {Set<string>} */
    madeInert: new Set(),
  };
  /** @type {Array<[EventTarget, string, EventListener, boolean]>} */
  const listeners = [];
  /** @type {{ root?: HTMLElement, cards?: HTMLElement[], done?: HTMLElement }} */
  const el = {};
  const btnTitle = doc.getElementById('btn-avatar-title');
  const btnPause = doc.getElementById('btn-avatar-pause');
  const btnView = doc.getElementById('btn-view');

  function on(target, type, fn, capture = false) {
    if (!target) return;
    target.addEventListener(type, fn, capture);
    listeners.push([target, type, fn, capture]);
  }

  /** @param {string} tag @param {string} [className] @param {string} [text] */
  function make(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Paint a portrait on a canvas, one pixel a pixel (CSS scales it to PORTRAIT_PX). */
  function drawPortrait(canvas, pic) {
    canvas.width = pic.width;
    canvas.height = pic.height;
    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!ctx || typeof ctx.createImageData !== 'function') return;
    const img = ctx.createImageData(pic.width, pic.height);
    img.data.set(pic.data);
    ctx.putImageData(img, 0, 0);
  }

  function build() {
    if (state.built) return;
    state.built = true;
    let root = doc.getElementById('avatar-chooser');
    if (!root) {
      root = make('div', `layer ${HIDDEN}`);
      root.id = 'avatar-chooser';
      (doc.body || doc.documentElement).appendChild(root);
    }
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'avatar-title');
    while (root.firstChild) root.removeChild(root.firstChild);
    el.root = root;
    const panel = make('div', 'av-panel');
    root.appendChild(panel);
    const title = make('h2', 'av-title', 'Who do you want to be?');
    title.id = 'avatar-title';
    panel.appendChild(title);
    const row = make('div', 'av-cards');
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-labelledby', 'avatar-title');
    panel.appendChild(row);
    /** @param {string} id @returns {Picture|null} */
    const portraitOf = (id) => {
      if (typeof opts.portrait !== 'function') return null;
      try {
        return opts.portrait(id);
      } catch (err) {
        console.warn('[avatars] portrait unavailable:', err);
        return null;
      }
    };
    el.cards = AVATARS.map((def) => {
      const card = make('button', 'av-card');
      card.setAttribute('type', 'button');
      card.setAttribute('role', 'radio');
      card.dataset.avatar = def.id;
      const canvas = make('canvas', 'av-portrait');
      canvas.setAttribute('aria-hidden', 'true');
      const pic = portraitOf(def.id);
      if (pic) drawPortrait(canvas, pic);
      card.appendChild(canvas);
      card.appendChild(make('span', 'av-name', def.displayName));
      card.appendChild(make('span', 'av-blurb', def.blurb));
      on(card, 'click', () => choose(def.id));
      row.appendChild(card);
      return card;
    });
    const foot = make('div', 'av-foot');
    foot.appendChild(make('span', 'av-hint', 'Click a friend to play as them · ← → to pick · V in the game: see yourself'));
    el.done = make('button', 'hex-button av-done', 'Done');
    el.done.setAttribute('type', 'button');
    el.done.setAttribute('aria-label', 'Done (Esc)');
    on(el.done, 'click', () => close());
    foot.appendChild(el.done);
    panel.appendChild(foot);
    on(root, 'mousedown', (e) => {
      if (/** @type {Event} */ (e).target === root) close(); // a click on the dimmed backdrop
    });
    showChosen();
  }

  function showChosen() {
    for (const card of el.cards ?? []) {
      const chosen = card.dataset.avatar === state.current;
      card.classList.toggle('chosen', chosen);
      card.setAttribute('aria-checked', chosen ? 'true' : 'false');
      card.setAttribute('tabindex', chosen ? '0' : '-1');
    }
    const label = avatarButtonLabel(state.current);
    if (btnTitle) btnTitle.textContent = label;
    if (btnPause) btnPause.textContent = label;
  }

  /** @param {string} id */
  function choose(id) {
    const next = avatarById(id).id;
    const changed = next !== state.current;
    state.current = next;
    showChosen();
    if (changed && typeof opts.onChoose === 'function') opts.onChoose(next);
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

  /** @param {boolean} inert */
  function setInertBeneath(inert) {
    for (const id of INERT_BENEATH) {
      const under = doc.getElementById(id);
      if (!under) continue;
      if (inert) {
        if (under.hasAttribute('inert')) continue;
        under.setAttribute('inert', '');
        state.madeInert.add(id);
      } else if (state.madeInert.has(id)) {
        under.removeAttribute('inert');
        state.madeInert.delete(id);
      }
    }
  }

  /** @param {KeyboardEvent} e */
  function onDocKey(e) {
    if (handleKey(e) && typeof e.stopPropagation === 'function') e.stopPropagation();
  }

  function open() {
    if (state.disposed || state.open) return;
    const a = /** @type {HTMLElement|null} */ (doc.activeElement);
    state.returnFocus = a && a !== doc.body && typeof a.focus === 'function' ? a : null;
    build();
    const root = /** @type {HTMLElement} */ (el.root);
    const titleScreen = doc.getElementById('title-screen');
    root.classList.toggle('over-title', !!titleScreen && !titleScreen.classList.contains(HIDDEN));
    showChosen();
    root.classList.remove(HIDDEN);
    state.open = true;
    setInertBeneath(true);
    doc.addEventListener('keydown', onDocKey, true);
    focusEl((el.cards ?? []).find((c) => c.dataset.avatar === state.current));
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    /** @type {HTMLElement} */ (el.root).classList.add(HIDDEN);
    setInertBeneath(false);
    doc.removeEventListener('keydown', onDocKey, true);
    const back = state.returnFocus;
    state.returnFocus = null;
    if (back && (back.isConnected ?? true)) focusEl(back);
  }

  /**
   * A keydown while the chooser is open: Esc closes it; ← → (and ↑ ↓) choose the card beside the chosen one; Enter or
   * Space on a card chooses it (a button's own click).
   * @param {KeyboardEvent} e
   * @returns {boolean} the key was the chooser's
   */
  function handleKey(e) {
    if (!state.open || !e || e.ctrlKey || e.metaKey || e.altKey) return false;
    const key = e.key;
    if (key === 'Escape' || key === 'Esc' || e.code === 'Escape') {
      if (!e.repeat) close();
      if (typeof e.preventDefault === 'function') e.preventDefault();
      return true;
    }
    const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return false;
    const ids = AVATARS.map((a) => a.id);
    const i = ids.indexOf(state.current);
    const next = ids[(i + step + ids.length) % ids.length];
    choose(next);
    focusEl((el.cards ?? []).find((c) => c.dataset.avatar === next));
    if (typeof e.preventDefault === 'function') e.preventDefault();
    return true;
  }

  /** Show who is chosen (main, after loading the preference or a ?avatar=). @param {string} id */
  function setCurrent(id) {
    state.current = avatarById(id).id;
    showChosen();
  }

  /** The pause menu's View button's text. @param {string} label */
  function setView(label) {
    if (btnView) btnView.textContent = `View: ${label}`;
  }

  on(btnTitle, 'click', () => open());
  on(btnPause, 'click', () => open());
  on(btnView, 'click', () => {
    if (typeof opts.onView === 'function') opts.onView();
  });
  showChosen();
  if (opts.viewLabel) setView(opts.viewLabel);

  function dispose() {
    if (state.disposed) return;
    close();
    state.disposed = true;
    for (const [target, type, fn, capture] of listeners) target.removeEventListener(type, fn, capture);
    listeners.length = 0;
    if (el.root) {
      el.root.classList.add(HIDDEN);
      while (el.root.firstChild) el.root.removeChild(el.root.firstChild);
    }
  }

  return { open, close, isOpen: () => state.open, current: () => state.current, setCurrent, setView, handleKey, dispose };
}
