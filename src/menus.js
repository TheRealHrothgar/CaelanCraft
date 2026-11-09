// Caelancraft — title (with the Worlds panel) / loading / click-to-play / pause / block-picker screens.
// See src/CONTRACTS.md §20, §41 and docs/SPEC-gameplay.md §5.1–§5.5.
// v0.9 Survival (docs/DESIGN-survival.md §9.8; CONTRACTS §48 once merged): the pause menu's `[ Creative | Survival ]` mode
// switch, Undo disabled in Survival, the death screen (a honeycomb closing ring by ring, "Wake up"), a general
// `confirm()` on the old delete dialog, the New World form's "Survival resources" checkbox and "· Survival" on Worlds rows.
// §14: a Guide button on the title screen (under the controls sheet) and in the pause menu → callbacks.onGuide(from).
// Circuits (docs/DESIGN-circuits.md §5, §6.2.14, §6.2.17; CONTRACTS §56 once merged): the block picker is pickerUI.js's
// honeycomb (this module binds its elements and delegates showPicker / hidePicker / isPickerOpen, so main's API is unchanged);
// the pause menu's Devices row `[ Circuits: On | Off ]` `[ Black holes: On | Off ]`; the reworded controls sheet (§4.9).
//
// DOM module. Every DOM access goes through the `doc` handed to createMenus and happens inside a
// function, so this file can be imported in Node. Imports: config, blocks, atlas, storage (world names only; per the
// import graph), pickerUI. The Worlds panel never touches storage itself: main lists the slots and acts on the callbacks.
import { MAX_WORLD_NAME_CHARS } from './config.js';
import { TILE } from './blocks.js';
import { makeTiledBackgroundDataURL, drawTitleLogo } from './atlas.js';
import { defaultWorldName } from './storage.js';
import { createPickerUI, PICKER_ICON_PX } from './pickerUI.js';

/** Edge length of the block-picker icon canvases, in CSS pixels (CONTRACTS §20); pickerUI.js owns it now. */
export { PICKER_ICON_PX };

/** The 18 title-screen splash strings from docs/SPEC-gameplay.md §5.4, verbatim. */
export const SPLASHES = Object.freeze([
  'Caelan approved!',
  'Hand-crafted by Caelan!',
  'Caelan was here',
  'Caelancraft: now in 3D!',
  'Now with 100% more hexagons!',
  'Zero textures downloaded!',
  'Procedurally generated!',
  "Don't dig straight down!",
  'Diamonds are down there somewhere',
  'Infinite* (*until your RAM runs out)',
  'Powered by Three.js!',
  'Punch trees!',
  'Also try sleeping!',
  'Built in a browser!',
  'Double-tap space to fly!',
  'No creepers were harmed',
  'Shift to sneak, E for blocks',
  "It's a feature!",
]);

/**
 * Controls cheat-sheet rows (docs/SPEC-gameplay.md §4), rendered as one `<kbd>` + one `<span>` per row
 * into the two-column `.controls-sheet` grids (#title-controls, #pause-controls). Still 17 rows; RMB, R and Shift R carry
 * the circuits wording merged with survival's (DESIGN-circuits §4.9, §7.1): keys are written in full ("R key", "Shift+R
 * key", "right-click"), never a bare "R:". The two long rows wrap onto a second line (styles.css: the description column
 * is 58ch wide).
 * @type {ReadonlyArray<readonly [string, string]>}
 */
export const CONTROLS_SHEET = Object.freeze([
  Object.freeze(['W A S D', 'Move (arrow keys work too)']),
  Object.freeze(['Mouse', 'Look around']),
  Object.freeze(['Space', 'Jump · fly up']),
  Object.freeze(['Shift', 'Sneak · fly down']),
  Object.freeze(['W W', 'Double-tap: sprint (while W is held)']),
  Object.freeze(['Space Space', 'Double-tap: fly (or F) · Creative']),
  Object.freeze(['LMB', 'Break block (hold) · Survival: hold to dig']),
  Object.freeze(['RMB', 'Place · right-click works switches, timers, plungers (Shift: place) · Survival: use the item in hand']),
  Object.freeze(['MMB', 'Pick the targeted block into the hotbar']),
  Object.freeze(['1–9', 'Select hotbar slot (or scroll wheel)']),
  Object.freeze(['E', 'Blocks · Survival: pack & making']),
  Object.freeze(['T  /', 'Command console (/ starts a command)']),
  Object.freeze(['R', 'R key: use a switch, timer, fuse, radio key or rune · Survival: fire, water, plants, basket']),
  Object.freeze(['Shift R', 'Shift+R key: settings of the targeted device or Rune Block']),
  Object.freeze(['Esc', 'Pause · close menus']),
  Object.freeze(['F3', 'Toggle the debug overlay']),
  Object.freeze(['M', 'Mute / unmute sound']),
]);

// ---- Worlds panel text (pure, §41) ------------------------------------------------------------------

const KB = 1024;
const MB = 1024 * 1024;

/**
 * A stored size for people: "512 B", "37 KB", "1.2 MB", "5 MB" (one decimal from 1 MB on, a trailing ".0" dropped).
 * @param {number} n  characters (≈ bytes: saves are ASCII JSON)
 */
export function formatBytes(n) {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < KB) return `${Math.round(v)} B`;
  if (v < MB) return `${Math.min(1023, Math.max(1, Math.round(v / KB)))} KB`;
  return `${(v / MB).toFixed(1).replace(/\.0$/, '')} MB`;
}

function plural(n, unit) {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/**
 * When a world was last played, relative to `now`: "just now", "5 minutes ago", "2 hours ago", "yesterday",
 * "3 days ago", "2 months ago", "1 year ago"; '' when unknown (0 or not a number). A time in the future reads "just now".
 * @param {number} ts  ms since the epoch
 * @param {number} now  ms since the epoch
 */
export function formatLastPlayed(ts, now) {
  if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(now)) return '';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return 'just now';
  const min = Math.floor(s / 60);
  if (min < 60) return plural(min, 'minute');
  const h = Math.floor(min / 60);
  if (h < 24) return plural(h, 'hour');
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return plural(d, 'day');
  if (d < 365) return plural(Math.max(1, Math.floor(d / 30)), 'month');
  return plural(Math.floor(d / 365), 'year');
}

/**
 * The second line of a Worlds row: "Seed 1234 · played 2 hours ago · 37 KB" (the played part only when known), with
 * " · Survival" appended for a world in Survival (`info.mode`, §9.6), "Can't be read · 12 KB" for a damaged slot,
 * "No world yet" for an empty one.
 * @param {import('./storage.js').SlotInfo & { mode?: string }} info
 * @param {number} now
 */
export function slotDetailText(info, now) {
  if (!info || info.status === 'empty') return 'No world yet';
  if (info.status === 'damaged') return `Can't be read · ${formatBytes(info.bytes)}`;
  const parts = [`Seed ${info.seed}`];
  const played = formatLastPlayed(info.lastPlayed, now);
  if (played) parts.push(`played ${played}`);
  parts.push(formatBytes(info.bytes));
  if (info.mode === 'survival') parts.push('Survival'); // §9.8: the Worlds row says which worlds are in Survival
  return parts.join(' · ');
}

/**
 * The usage line under the Worlds list: "1.2 MB of ~5 MB (24%)".
 * @param {{ used: number, quota: number, fraction: number }} usage
 */
export function usageLabel(usage) {
  const u = usage || { used: 0, quota: 0, fraction: 0 };
  const pct = Math.round(Math.min(1, Math.max(0, Number(u.fraction) || 0)) * 100);
  return `${formatBytes(u.used)} of ~${formatBytes(u.quota)} (${pct}%)`;
}

/** Usage bar colour class: '' below 75 %, 'warn' below 90 %, 'full' from 90 %. @param {number} fraction */
export function usageLevel(fraction) {
  return fraction >= 0.9 ? 'full' : fraction >= 0.75 ? 'warn' : '';
}

/**
 * The delete dialog's two lines for a slot, naming the world.
 * @param {import('./storage.js').SlotInfo} info
 * @returns {{ title: string, detail: string }}
 */
export function deleteConfirmText(info) {
  if (info.status === 'damaged') {
    return { title: `Delete the damaged world in slot ${info.slot}?`, detail: 'Its save cannot be read. This cannot be undone.' };
  }
  return { title: `Delete “${info.name}”?`, detail: `Slot ${info.slot} · seed ${info.seed}. This cannot be undone.` };
}

/** The slot of the most recently played world (0 when there is none): its row is marked and its Play button focused. */
export function latestSlot(slots) {
  let best = 0;
  let bestTs = -1;
  for (const s of slots || []) {
    if (s && s.status === 'world' && s.lastPlayed > bestTs) {
      best = s.slot;
      bestTs = s.lastPlayed;
    }
  }
  return best;
}

/** #btn-quit labels (§41): normally, and after a Save & Quit whose save failed. */
export const QUIT_LABEL = 'Save & Quit';
export const QUIT_UNSAVED_LABEL = 'Quit Without Saving';

/** The New World form's checkbox (§1.3): checked creates the world with GEN_LATEST, unchecked with generation 1. */
export const SURVIVAL_RESOURCES_LABEL = 'Survival resources (wild plants, ponds, copper and tin)';
/** The two game modes, in the switch's order. */
export const GAME_MODES = Object.freeze(['creative', 'survival']);
/** The death screen's button and link (§2.5). */
export const WAKE_LABEL = 'Wake up';
export const DEATH_QUIT_LABEL = 'Save & quit';
/**
 * The honeycomb mask behind the death screen (§9.8): pointy-top cells of circumradius DEATH_COMB_CELL over a viewBox
 * DEATH_COMB_RINGS cells wide each side of the centre (sliced to cover the window), and the time it takes to close.
 */
export const DEATH_COMB_RINGS = 11;
export const DEATH_COMB_CELL = 44;
export const DEATH_COMB_CLOSE_S = 1.2;
/** One ring's fade; the outermost ring starts first, the centre last, all done by DEATH_COMB_CLOSE_S. */
export const DEATH_COMB_FADE_S = 0.3;
/** The viewBox's height over its width (wider than 16:9 is cropped at the sides, taller at the top and bottom). */
const DEATH_COMB_ASPECT = 0.6;

/**
 * Half the width and height of the death comb's viewBox. Pure.
 * @param {number} [rings=DEATH_COMB_RINGS] @param {number} [size=DEATH_COMB_CELL]
 * @returns {[number, number]}
 */
export function deathCombExtent(rings = DEATH_COMB_RINGS, size = DEATH_COMB_CELL) {
  const halfW = Math.ceil(Math.sqrt(3) * size * (rings + 0.5));
  return [halfW, Math.ceil(halfW * DEATH_COMB_ASPECT)];
}

/**
 * Cells of the death screen's honeycomb: every pointy-top cell (circumradius `size`, centred on 0,0) that touches the
 * viewBox (deathCombExtent), each with its ring (hex distance from the centre cell) and its animation delay: the outermost
 * ring darkens first and the centre last, so the mask closes in over DEATH_COMB_CLOSE_S. Pure.
 * @param {number} [rings=DEATH_COMB_RINGS] @param {number} [size=DEATH_COMB_CELL]
 * @returns {{ x: number, y: number, ring: number, delay: number }[]}
 */
export function deathCombCells(rings = DEATH_COMB_RINGS, size = DEATH_COMB_CELL) {
  const [halfW, halfH] = deathCombExtent(rings, size);
  const colW = Math.sqrt(3) * size;
  const rowH = 1.5 * size;
  const rMax = Math.ceil(halfH / rowH) + 1;
  /** @type {{ x: number, y: number, ring: number, delay: number }[]} */
  const out = [];
  for (let r = -rMax; r <= rMax; r++) {
    const qMin = Math.floor(-halfW / colW - r / 2) - 1;
    const qMax = Math.ceil(halfW / colW - r / 2) + 1;
    for (let q = qMin; q <= qMax; q++) {
      const x = colW * (q + r / 2);
      const y = rowH * r;
      if (Math.abs(x) > halfW + size || Math.abs(y) > halfH + size) continue;
      out.push({ x, y, ring: Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)), delay: 0 });
    }
  }
  const maxRing = out.reduce((m, c) => Math.max(m, c.ring), 0);
  const span = DEATH_COMB_CLOSE_S - DEATH_COMB_FADE_S;
  for (const c of out) c.delay = maxRing > 0 ? Math.round(((maxRing - c.ring) / maxRing) * span * 1000) / 1000 : 0;
  return out;
}

/**
 * The pause menu's Devices switches (DESIGN-circuits §6.2.17): the world's Circuits and Black holes switches, each two halves
 * of one hexagon like survival's Mode switch: [name, the On half's label, IDS keys of the group, the On and the Off half,
 * the callback].
 */
export const DEVICE_SWITCHES = Object.freeze([
  Object.freeze(['circuits', 'Circuits: On', 'btnCircuits', 'btnCircuitsOn', 'btnCircuitsOff', 'onSetCircuits']),
  Object.freeze(['blackholes', 'Black holes: On', 'btnBlackholes', 'btnBlackholesOn', 'btnBlackholesOff', 'onSetBlackHoles']),
]);

/** Element ids in index.html this module binds to (property name → id). */
const IDS = Object.freeze({
  titleScreen: 'title-screen',
  titleLogo: 'title-logo',
  splashText: 'splash-text',
  worldsList: 'worlds-list',
  worldsCount: 'worlds-count',
  usageBar: 'usage-bar',
  usageFill: 'usage-fill',
  usageText: 'usage-text',
  worldsMessage: 'worlds-message',
  confirmDialog: 'confirm-dialog',
  confirmText: 'confirm-text',
  confirmDetail: 'confirm-detail',
  confirmYes: 'confirm-yes',
  confirmNo: 'confirm-no',
  titleControls: 'title-controls',
  btnGuideTitle: 'btn-guide-title',
  loadingScreen: 'loading-screen',
  loadingBar: 'loading-bar',
  loadingText: 'loading-text',
  clickToPlay: 'click-to-play',
  pauseMenu: 'pause-menu',
  btnResume: 'btn-resume',
  btnSave: 'btn-save',
  btnStopRunes: 'btn-stop-runes',
  btnQuit: 'btn-quit',
  pauseWorld: 'pause-world',
  pauseSeed: 'pause-seed',
  btnPhysFalling: 'btn-phys-falling',
  btnPhysWater: 'btn-phys-water',
  btnPhysCollapse: 'btn-phys-collapse',
  btnPhysExplosions: 'btn-phys-explosions',
  btnUndoPhysics: 'btn-undo-physics',
  btnZombies: 'btn-zombies',
  btnMode: 'btn-mode',
  btnModeCreative: 'btn-mode-creative',
  btnModeSurvival: 'btn-mode-survival',
  pauseControls: 'pause-controls',
  btnGuidePause: 'btn-guide-pause',
  deathScreen: 'death-screen',
  deathComb: 'death-comb',
  deathTitle: 'death-title',
  deathDetail: 'death-detail',
  deathWhere: 'death-where',
  btnWake: 'btn-wake',
  btnDeathQuit: 'btn-death-quit',
  btnCircuits: 'btn-circuits',
  btnCircuitsOn: 'btn-circuits-on',
  btnCircuitsOff: 'btn-circuits-off',
  btnBlackholes: 'btn-blackholes',
  btnBlackholesOn: 'btn-blackholes-on',
  btnBlackholesOff: 'btn-blackholes-off',
  blockPicker: 'block-picker',
  pickerGrid: 'picker-grid',
  pickerName: 'picker-name',
  pickerSearch: 'picker-search',
  pickerShowAll: 'picker-showall',
  pickerRail: 'picker-rail',
  pickerScroll: 'picker-scroll',
  pickerBlurb: 'picker-blurb',
});

/**
 * @typedef {Object} MenusCallbacks  All optional; missing callbacks are simply not fired.
 * @property {(slot: number) => void} [onPlayWorld]   Worlds panel: Play on a filled slot
 * @property {(slot: number, name: string, seedText: string, opts: { survivalResources: boolean }) => void} [onNewWorld]
 *   the New World form of an empty slot (name and seed text untrimmed; main normalises both); `survivalResources` is the
 *   form's checkbox (§1.3: checked → GEN_LATEST, unchecked → generation 1)
 * @property {(slot: number, name: string) => void} [onRenameWorld]
 * @property {(slot: number) => void} [onDuplicateWorld]
 * @property {(slot: number) => void} [onDeleteWorld]   fired only after the delete dialog was confirmed
 * @property {() => void} [onResume]
 * @property {() => void} [onSave]
 * @property {() => void} [onStopRunes]   pause-menu "Stop All Rune Scripts"
 * @property {(name: string) => void} [onPhysicsToggle]  pause-menu Physics row: 'falling' | 'water' | 'collapse' | 'explosions'
 * @property {() => void} [onUndoPhysics]  pause-menu "Undo" (the last explosion / collapse / falling tree)
 * @property {() => void} [onZombiesToggle]  pause-menu Creatures row: the world's Zombies switch (§39)
 * @property {(mode: 'creative'|'survival') => void} [onModeSelect]  pause-menu Mode switch: fired only by the inactive half
 * @property {() => void} [onWake]        death screen "Wake up"
 * @property {() => void} [onDeathQuit]   death screen "Save & quit" (main saves, then quits)
 * @property {() => void} [onQuit]
 * @property {(from: 'title'|'pause') => void} [onGuide]  the Guide button on the title screen or in the pause menu (§14):
 *   main opens handbookUI.openGuide(); the screen underneath stays and comes back when the Guide closes
 * @property {() => void} [onClickToPlay]
 * @property {(blockId: number, slot: number|null) => void} [onPickBlock]  slot 0..8 for Digit1-9 or a drop on the hotbar
 *   (the picker stays open), null for a click / Enter (main closes it)
 * @property {() => void} [onPickerClose]
 * @property {(on: boolean) => void} [onSetCircuits]    pause-menu Devices row: the world's Circuits switch; fired only by the
 *   inactive half (DESIGN-circuits §6.2.17)
 * @property {(on: boolean) => void} [onSetBlackHoles]  the Devices row's Black holes switch, likewise
 */

/**
 * What the Worlds panel shows besides the slots.
 * @typedef {Object} WorldsOptions
 * @property {number} [now]            ms since the epoch, for "played 2 hours ago" (default Date.now())
 * @property {{ used: number, quota: number, fraction: number }} [usage]   storage.storageUsage(slots)
 * @property {boolean} [readOnly]      ?nosave: Rename / Duplicate / Delete are disabled (New World and Play still work)
 * @property {string|null} [defaultSeed]  prefills the New World form's seed field (?seed=)
 * @property {string} [message]        status line under the list ('' clears it)
 * @property {boolean} [isError]       … shown in red
 * @property {number} [focusSlot]      focus this row's first button after rendering (default: the last played world's
 *                                     Play, else the first New World)
 */

/**
 * @typedef {Object} Menus
 * @property {(slots: import('./storage.js').SlotInfo[], opts?: WorldsOptions) => void} showTitle
 * @property {(slots: import('./storage.js').SlotInfo[], opts?: WorldsOptions) => void} setWorlds   re-render the panel only
 * @property {(text: string, isError?: boolean) => void} showWorldsMessage
 * @property {() => boolean} isConfirmOpen
 * @property {() => void} hideTitle
 * @property {(done: number, total: number) => void} showLoading
 * @property {() => void} hideLoading
 * @property {() => void} showClickToPlay
 * @property {() => void} hideClickToPlay
 * @property {(seed: number|string, physics?: PhysicsMenuState, worldName?: string) => void} showPause
 * @property {(physics: PhysicsMenuState) => void} setPhysicsState   refresh the Physics row and the Undo button
 * @property {(on: boolean) => void} setZombiesState   refresh the Zombies toggle (§39)
 * @property {() => void} hidePause
 * @property {(on: boolean) => void} setQuitUnsaved   #btn-quit: "Save & Quit" / "Quit Without Saving" (after a failed save)
 * @property {(hotbar: number[], selected: number) => void} showPicker
 * @property {() => void} hidePicker
 * @property {() => boolean} isPickerOpen
 * @property {() => string} getSeedInput   the open New World form's seed text ('' when no form is open)
 * @property {(mode: 'creative'|'survival') => void} setModeState   the Mode switch: the active half filled, aria-pressed
 * @property {() => 'creative'|'survival'} getModeState
 * @property {(opts?: ConfirmOptions) => Promise<boolean>} confirm   ask on #confirm-dialog; false on No / Esc / the backdrop /
 *   hidePause / showTitle / another question
 * @property {(title: string, detail: string, where?: string) => void} showDeath   the death screen (§2.5); `where` is the
 *   belongings line, hidden when empty
 * @property {() => void} hideDeath
 * @property {() => boolean} isDeathOpen
 * @property {(sw: { circuits?: boolean, blackholes?: boolean }) => void} setDeviceSwitches   the Devices row: each switch's
 *   active half filled in honey with aria-pressed="true" (a missing key keeps its state)
 * @property {() => { circuits: boolean, blackholes: boolean }} getDeviceSwitches
 * @property {() => void} dispose
 */

/**
 * A question for confirm().
 * @typedef {Object} ConfirmOptions
 * @property {string} [title]
 * @property {string} [detail]
 * @property {string} [yes='OK']       #confirm-yes's text
 * @property {string} [no='Cancel']    #confirm-no's text
 * @property {boolean} [danger=false]  #confirm-yes in the danger colour
 */

/**
 * What the pause menu shows about block physics.
 * @typedef {Object} PhysicsMenuState
 * @property {{ falling: boolean, water: boolean, collapse: boolean, explosions: boolean }} switches
 * @property {boolean} canUndo
 * @property {string} [undoKind]   'explosion' | 'collapse' | 'falling tree' … (button label)
 * @property {boolean} [survival]  v0.9 §1.5: in Survival, Undo is disabled ("Undo (not in Survival)")
 */

/** Physics row buttons: switch name, label, IDS key. */
export const PHYSICS_TOGGLES = Object.freeze([
  Object.freeze(['falling', 'Falling', 'btnPhysFalling']),
  Object.freeze(['water', 'Water', 'btnPhysWater']),
  Object.freeze(['collapse', 'Collapse', 'btnPhysCollapse']),
  Object.freeze(['explosions', 'Explosions', 'btnPhysExplosions']),
]);

/**
 * Undo button label for an event kind ('' / undefined: nothing to undo). In Survival (§1.5) Undo would duplicate what the
 * player mined from a toppled tree or a collapse, so it reads "Undo (not in Survival)" whatever there is to undo.
 * @param {boolean} canUndo @param {string} [kind] @param {boolean} [survival=false]
 */
export function undoButtonLabel(canUndo, kind, survival = false) {
  if (survival) return 'Undo (not in Survival)';
  if (!canUndo) return 'Undo (nothing to undo)';
  const what = kind === 'explosion' ? 'Explosion' : kind === 'falling tree' ? 'Falling Tree' : kind === 'collapse' ? 'Collapse' : 'Physics Event';
  return `Undo Last ${what}`;
}

/**
 * Look up every element in `IDS`; fail fast with one clear message listing everything that is missing.
 * The markup is static and owned by index.html, so a missing id is a build error, not a runtime condition.
 * @param {Document} doc
 * @returns {Record<keyof typeof IDS, HTMLElement>}
 */
function bindElements(doc) {
  /** @type {Record<string, HTMLElement>} */
  const out = {};
  const missing = [];
  for (const name of Object.keys(IDS)) {
    const id = IDS[/** @type {keyof typeof IDS} */ (name)];
    const el = doc.getElementById(id);
    if (el) out[name] = el;
    else missing.push('#' + id);
  }
  if (missing.length) throw new Error(`menus: missing DOM element(s): ${missing.join(', ')}`);
  return /** @type {Record<keyof typeof IDS, HTMLElement>} */ (out);
}

/** Remove every child of `el` (works on every DOM implementation, unlike replaceChildren). */
function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * Create the menu controller bound to the ids in index.html.
 *
 * Decorative atlas work (dirt background, logo, picker icons) is wrapped so that a failure there is
 * reported with `console.warn` once and never prevents a screen from showing: a game with a plain title
 * screen beats a game that cannot start.
 *
 * @param {Document} doc
 * @param {HTMLCanvasElement} atlasCanvas  from atlas.createAtlasCanvas()
 * @param {MenusCallbacks} [callbacks]
 * @returns {Menus}
 */
export function createMenus(doc, atlasCanvas, callbacks = {}) {
  const el = bindElements(doc);

  const state = {
    /** @type {import('./storage.js').SlotInfo[]} the slots the Worlds panel shows */
    worlds: [],
    /** @type {WorldsOptions} */
    worldsOpts: {},
    /** @type {{ slot: number, mode: 'new'|'rename' }|null} the one open inline form */
    editing: null,
    worldsRenders: 0,
    /** @type {{ resolve: ((answer: boolean) => void)|null, onYes: (() => void)|null }|null} the open question (§9.8) */
    pending: null,
    /** @type {HTMLElement|null} focused before the dialog opened (gets focus back on Cancel) */
    confirmReturn: null,
    /** @type {'creative'|'survival'} the Mode switch's active half */
    mode: 'creative',
    deathOpen: false,
    deathCombBuilt: false,
    lastSplash: -1,
    backgroundApplied: false,
    /** the Devices row (DESIGN-circuits §6.2.17) */
    devices: { circuits: true, blackholes: true },
    disposed: false,
  };

  /** @type {Array<[EventTarget, string, EventListener]>} static listeners removed by dispose() */
  const listeners = [];
  /** @type {Set<string>} */
  const warned = new Set();

  // ---- small helpers -------------------------------------------------------------------------------

  /** @param {EventTarget} target @param {string} type @param {EventListener} fn */
  function on(target, type, fn) {
    target.addEventListener(type, fn);
    listeners.push([target, type, fn]);
  }

  /** Invoke an optional callback by name. */
  function fire(name, ...args) {
    const fn = callbacks ? callbacks[name] : undefined;
    if (typeof fn === 'function') fn(...args);
  }

  /**
   * Run decorative work; on failure warn once per `what` and return null.
   * @template T @param {() => T} fn @param {string} what @returns {T|null}
   */
  function safe(fn, what) {
    try {
      return fn();
    } catch (err) {
      if (!warned.has(what)) {
        warned.add(what);
        console.warn(`[menus] ${what} unavailable:`, err);
      }
      return null;
    }
  }

  const show = (node) => node.classList.remove('hidden');
  const hide = (node) => node.classList.add('hidden');

  /** Focus without scrolling the page (where supported). @param {HTMLElement|null|undefined} node */
  function focusEl(node) {
    if (!node || typeof node.focus !== 'function') return;
    try {
      node.focus({ preventScroll: true });
    } catch {
      node.focus();
    }
  }

  // ---- shared visuals ------------------------------------------------------------------------------

  /** Random splash, never the same one twice in a row (when there is a choice). */
  function pickSplash() {
    const n = SPLASHES.length;
    if (n === 0) return '';
    let i = Math.floor(Math.random() * n);
    if (i === state.lastSplash && n > 1) i = (i + 1) % n;
    state.lastSplash = i;
    return SPLASHES[i];
  }

  /**
   * Apply the tiled dirt background to the title and loading screens. Encoding the PNG once is enough:
   * the atlas never changes. Also called from showLoading so autoplay/smoke runs that skip the title
   * still get the background.
   */
  function ensureBackground() {
    if (state.backgroundApplied) return;
    state.backgroundApplied = true;
    const url = safe(() => makeTiledBackgroundDataURL(atlasCanvas, TILE.DIRT), 'dirt background');
    if (typeof url === 'string' && url.length > 0) {
      const css = `url("${url}")`;
      el.titleScreen.style.backgroundImage = css;
      el.loadingScreen.style.backgroundImage = css;
    }
  }

  /** Render CONTROLS_SHEET into a `.controls-sheet` grid as alternating <kbd>/<span> children. */
  function renderControlsSheet(container) {
    clearChildren(container);
    for (let i = 0; i < CONTROLS_SHEET.length; i++) {
      const [keys, description] = CONTROLS_SHEET[i];
      const kbd = doc.createElement('kbd');
      kbd.textContent = keys;
      const span = doc.createElement('span');
      span.textContent = description;
      container.appendChild(kbd);
      container.appendChild(span);
    }
  }

  function renderControlsSheets() {
    renderControlsSheet(el.titleControls);
    renderControlsSheet(el.pauseControls);
  }

  // ---- title ---------------------------------------------------------------------------------------

  /**
   * @param {import('./storage.js').SlotInfo[]} slots
   * @param {WorldsOptions} [opts]
   */
  function showTitle(slots, opts = {}) {
    el.splashText.textContent = pickSplash();
    ensureBackground();
    safe(() => drawTitleLogo(el.titleLogo, atlasCanvas), 'title logo');
    renderControlsSheets();
    state.editing = null;
    closeConfirm(false); // a pending confirm() resolves false
    show(el.titleScreen);
    setWorlds(slots, opts);
  }

  function hideTitle() {
    state.editing = null;
    closeConfirm(false);
    hide(el.titleScreen);
    // A focused (now invisible) text input or button would keep swallowing keystrokes in some browsers.
    const active = /** @type {HTMLElement|null} */ (doc.activeElement);
    if (active && el.titleScreen.contains(active) && typeof active.blur === 'function') active.blur();
  }

  /** The open New World form's seed text ('' when no form is open). */
  function getSeedInput() {
    const input = /** @type {HTMLInputElement|null} */ (el.worldsList.querySelector('.slot-seed-input'));
    return input && typeof input.value === 'string' ? input.value : '';
  }

  // ---- Worlds panel (§41) ------------------------------------------------------------------------------

  /** `<tag class=…>text</tag>` @param {string} tag @param {string} className @param {string} [text] */
  function make(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * A row button; `data-action` / `data-slot` route its click through the list's one delegated listener.
   * @param {string} label @param {string} action @param {number} slot @param {string} [aria] @param {boolean} [disabled]
   */
  function slotButton(label, action, slot, aria, disabled = false) {
    const b = /** @type {HTMLButtonElement} */ (make('button', 'mc-button slot-btn', label));
    b.type = 'button';
    b.dataset.action = action;
    b.dataset.slot = String(slot);
    if (aria) b.setAttribute('aria-label', aria);
    if (action === 'delete') b.classList.add('danger');
    if (disabled) {
      b.disabled = true;
      b.title = 'Saving is off (?nosave=1)';
    }
    return b;
  }

  /** `<label for=id>text</label><input id=id …>` inside one wrapper label-pair span. */
  function field(labelText, id, className, value, placeholder) {
    const wrap = make('span', 'slot-field');
    const label = /** @type {HTMLLabelElement} */ (make('label', '', labelText));
    label.htmlFor = id;
    const input = /** @type {HTMLInputElement} */ (make('input', className));
    input.id = id;
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = value;
    if (placeholder) input.placeholder = placeholder;
    wrap.appendChild(label);
    wrap.appendChild(input);
    return { wrap, input };
  }

  /** The inline New World / Rename form that replaces a row's text and buttons. */
  function buildForm(info, mode) {
    const form = /** @type {HTMLFormElement} */ (make('form', 'slot-form'));
    form.noValidate = true;
    form.dataset.slot = String(info.slot);
    form.dataset.mode = mode;
    const name = field('Name', 'world-name-input', 'slot-name-input', mode === 'rename' ? info.name : defaultWorldName(info.slot));
    name.input.maxLength = MAX_WORLD_NAME_CHARS;
    form.appendChild(name.wrap);
    if (mode === 'new') {
      const seed = state.worldsOpts.defaultSeed;
      form.appendChild(field('Seed', 'seed-input', 'slot-seed-input', seed == null ? '' : String(seed), 'random').wrap);
      // §1.3: new worlds get the survival resources unless this is cleared
      const check = /** @type {HTMLLabelElement} */ (make('label', 'slot-check'));
      const box = /** @type {HTMLInputElement} */ (make('input', 'slot-survival-input'));
      box.type = 'checkbox';
      box.id = 'survival-resources-input';
      box.checked = true;
      box.setAttribute('checked', '');
      check.appendChild(box);
      check.appendChild(make('span', '', SURVIVAL_RESOURCES_LABEL));
      form.appendChild(check);
    }
    const buttons = make('span', 'slot-form-buttons');
    const submit = /** @type {HTMLButtonElement} */ (make('button', 'mc-button slot-btn', mode === 'new' ? 'Create' : 'Save'));
    submit.type = 'submit';
    buttons.appendChild(submit);
    buttons.appendChild(slotButton('Cancel', 'cancel', info.slot));
    form.appendChild(buttons);
    return form;
  }

  /** One `li.world-slot` of the list. */
  function buildRow(info, latest, canDuplicate, readOnly) {
    const li = make('li', `world-slot ${info.status}${info.slot === latest ? ' latest' : ''}`);
    li.dataset.slot = String(info.slot);
    li.appendChild(make('div', 'slot-num', String(info.slot)));
    const editing = state.editing && state.editing.slot === info.slot ? state.editing.mode : null;
    if (editing) {
      li.classList.add('editing');
      li.appendChild(buildForm(info, editing));
      return li;
    }
    const body = make('div', 'slot-body');
    const title = info.status === 'world' ? info.name : info.status === 'damaged' ? 'Damaged world' : 'Empty';
    const name = make('div', 'slot-name', title);
    if (info.status === 'world') name.title = info.name;
    body.appendChild(name);
    body.appendChild(make('div', 'slot-detail', slotDetailText(info, state.worldsOpts.now ?? Date.now())));
    li.appendChild(body);
    const actions = make('div', 'slot-actions');
    if (info.status === 'world') {
      actions.appendChild(slotButton('Play', 'play', info.slot, `Play ${info.name}`));
      actions.appendChild(slotButton('Rename', 'rename', info.slot, `Rename ${info.name}`, readOnly));
      if (canDuplicate) actions.appendChild(slotButton('Duplicate', 'duplicate', info.slot, `Duplicate ${info.name}`, readOnly));
      actions.appendChild(slotButton('Delete', 'delete', info.slot, `Delete ${info.name}`, readOnly));
    } else if (info.status === 'damaged') {
      actions.appendChild(slotButton('Delete', 'delete', info.slot, `Delete the damaged world in slot ${info.slot}`, readOnly));
    } else {
      actions.appendChild(slotButton('New World', 'new', info.slot, `New world in slot ${info.slot}`));
    }
    li.appendChild(actions);
    return li;
  }

  /** The row element of `slot`, or null. */
  function rowOf(slot) {
    return /** @type {HTMLElement|null} */ (el.worldsList.querySelector(`li[data-slot="${slot}"]`));
  }

  /** Focus a row's first enabled control (a form's name field, else its first button). */
  function focusRow(slot) {
    const row = rowOf(slot);
    if (!row) return false;
    const input = /** @type {HTMLInputElement|null} */ (row.querySelector('.slot-name-input'));
    if (input) {
      focusEl(input);
      if (typeof input.select === 'function') input.select();
      return true;
    }
    const btn = /** @type {HTMLElement|null} */ (row.querySelector('button:not([disabled])'));
    focusEl(btn);
    return Boolean(btn);
  }

  /** Re-render the list, the count and the usage bar from state. */
  function renderWorlds() {
    state.worldsRenders++;
    const slots = state.worlds;
    const o = state.worldsOpts;
    const latest = latestSlot(slots);
    const canDuplicate = slots.some((s) => s.status === 'empty');
    clearChildren(el.worldsList);
    for (const info of slots) el.worldsList.appendChild(buildRow(info, latest, canDuplicate, Boolean(o.readOnly)));
    const used = slots.filter((s) => s.status !== 'empty').length;
    el.worldsCount.textContent = `${used} of ${slots.length} slots used${o.readOnly ? ' · saving off' : ''}`;
    const usage = o.usage || { used: 0, quota: 0, fraction: 0 };
    const fraction = Math.min(1, Math.max(0, Number(usage.fraction) || 0));
    el.usageFill.style.width = `${(fraction * 100).toFixed(1)}%`;
    el.usageFill.classList.remove('warn', 'full');
    const level = usageLevel(fraction);
    if (level) el.usageFill.classList.add(level);
    el.usageText.textContent = usageLabel(usage);
    el.usageBar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    el.usageBar.setAttribute('aria-valuetext', el.usageText.textContent);
  }

  /**
   * Show these slots in the Worlds panel (keeps the title as it is).
   * @param {import('./storage.js').SlotInfo[]} slots
   * @param {WorldsOptions} [opts]
   */
  function setWorlds(slots, opts = {}) {
    state.worlds = Array.isArray(slots) ? slots.slice() : [];
    state.worldsOpts = { ...opts };
    if (state.editing) {
      // a form stays open only while its slot still fits it (another tab may have changed the slot)
      const info = state.worlds.find((s) => s.slot === state.editing.slot);
      const want = state.editing.mode === 'new' ? 'empty' : 'world';
      if (!info || info.status !== want) state.editing = null;
    }
    renderWorlds();
    showWorldsMessage(opts.message || '', Boolean(opts.isError));
    if (el.titleScreen.classList.contains('hidden') || state.pending) return;
    if (opts.focusSlot && focusRow(opts.focusSlot)) return;
    const latest = latestSlot(state.worlds);
    const empty = state.worlds.find((s) => s.status === 'empty');
    focusRow(latest || (empty ? empty.slot : 1));
  }

  /** The status line under the list ('' clears it). @param {string} text @param {boolean} [isError] */
  function showWorldsMessage(text, isError = false) {
    el.worldsMessage.textContent = text || '';
    el.worldsMessage.classList.toggle('error', Boolean(text) && Boolean(isError));
  }

  /** Open (or switch to) the inline form of `slot`. @param {number} slot @param {'new'|'rename'} mode */
  function openForm(slot, mode) {
    state.editing = { slot, mode };
    renderWorlds();
    focusRow(slot);
  }

  function cancelForm() {
    const slot = state.editing ? state.editing.slot : 0;
    state.editing = null;
    renderWorlds();
    if (slot) focusRow(slot);
  }

  /** @param {HTMLFormElement} form */
  function submitForm(form) {
    const slot = Number(form.dataset.slot);
    const mode = form.dataset.mode;
    const nameInput = /** @type {HTMLInputElement|null} */ (form.querySelector('.slot-name-input'));
    const seedInput = /** @type {HTMLInputElement|null} */ (form.querySelector('.slot-seed-input'));
    const box = /** @type {HTMLInputElement|null} */ (form.querySelector('.slot-survival-input'));
    const name = nameInput ? nameInput.value : '';
    const seed = seedInput ? seedInput.value : '';
    const survivalResources = box ? Boolean(box.checked) : true;
    state.editing = null;
    const renders = state.worldsRenders;
    if (mode === 'new') fire('onNewWorld', slot, name, seed, { survivalResources });
    else fire('onRenameWorld', slot, name);
    // Nobody re-rendered (no callback, or the title stays up without a refresh): close the form here.
    if (state.worldsRenders === renders && !el.titleScreen.classList.contains('hidden')) {
      renderWorlds();
      focusRow(slot);
    }
  }

  /**
   * Put a question on #confirm-dialog. Every call resets #confirm-yes's text and danger class and #confirm-no's text; a
   * question still open is answered "no" first. `onYes` runs synchronously on Yes (the delete flow), before `resolve`.
   * @param {ConfirmOptions} opts @param {((answer: boolean) => void)|null} resolve @param {(() => void)|null} onYes
   */
  function openDialog(opts, resolve, onYes) {
    if (state.pending) settle(false, false);
    const o = opts || {};
    el.confirmText.textContent = o.title == null ? '' : String(o.title);
    el.confirmDetail.textContent = o.detail == null ? '' : String(o.detail);
    el.confirmYes.textContent = o.yes == null ? 'OK' : String(o.yes);
    el.confirmNo.textContent = o.no == null ? 'Cancel' : String(o.no);
    el.confirmYes.classList.toggle('danger', Boolean(o.danger));
    state.pending = { resolve, onYes };
    state.confirmReturn = /** @type {HTMLElement|null} */ (doc.activeElement);
    show(el.confirmDialog);
    focusEl(el.confirmNo);
  }

  /**
   * Answer the open question (if any) and close the dialog.
   * @param {boolean} answer @param {boolean} restoreFocus  give the focus back to what had it (Cancel / Esc)
   */
  function settle(answer, restoreFocus) {
    const pending = state.pending;
    const back = state.confirmReturn;
    state.pending = null;
    state.confirmReturn = null;
    if (!el.confirmDialog.classList.contains('hidden')) hide(el.confirmDialog);
    if (restoreFocus && back && (el.titleScreen.contains(back) || el.pauseMenu.contains(back))) focusEl(back);
    if (!pending) return;
    if (answer && pending.onYes) pending.onYes();
    if (pending.resolve) pending.resolve(answer);
  }

  /**
   * Ask a yes / no question on the in-game dialog (§9.8). Resolves true on Yes; false on No, Esc, a click on the backdrop,
   * hidePause(), showTitle() or a newer question, so no Promise is ever left hanging.
   * @param {ConfirmOptions} [opts]
   * @returns {Promise<boolean>}
   */
  function confirm(opts = {}) {
    if (state.disposed) return Promise.resolve(false);
    return new Promise((resolve) => openDialog(opts, resolve, null));
  }

  /** The delete dialog for `slot`, naming its world; Cancel has the focus. */
  function openConfirm(slot) {
    const info = state.worlds.find((s) => s.slot === slot);
    if (!info || info.status === 'empty') return;
    const text = deleteConfirmText(info);
    openDialog({ title: text.title, detail: text.detail, yes: 'Delete', no: 'Cancel', danger: true }, null,
      () => fire('onDeleteWorld', slot));
  }

  /** @param {boolean} restoreFocus  give the focus back to what had it (Cancel / Esc) */
  function closeConfirm(restoreFocus) {
    settle(false, restoreFocus);
  }

  function isConfirmOpen() {
    return state.pending !== null;
  }

  on(el.worldsList, 'click', (e) => {
    const target = /** @type {HTMLElement|null} */ (e.target);
    const btn = target && typeof target.closest === 'function' ? /** @type {HTMLButtonElement|null} */ (target.closest('button[data-action]')) : null;
    if (!btn || btn.disabled) return;
    const slot = Number(btn.dataset.slot);
    switch (btn.dataset.action) {
      case 'play':
        fire('onPlayWorld', slot);
        break;
      case 'new':
        openForm(slot, 'new');
        break;
      case 'rename':
        openForm(slot, 'rename');
        break;
      case 'duplicate':
        fire('onDuplicateWorld', slot);
        break;
      case 'delete':
        openConfirm(slot);
        break;
      case 'cancel':
        cancelForm();
        break;
      default:
        break;
    }
  });
  on(el.worldsList, 'submit', (e) => {
    e.preventDefault();
    submitForm(/** @type {HTMLFormElement} */ (e.target));
  });
  on(el.worldsList, 'keydown', (/** @type {KeyboardEvent} */ e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const key = e.key;
    if ((key === 'Escape' || key === 'Esc') && state.editing) {
      e.preventDefault();
      e.stopPropagation();
      cancelForm();
      return;
    }
    // Arrow keys walk the rows' buttons: up / down to the same button (or the nearest) of the row above / below,
    // left / right along a row. Text fields keep their arrows.
    if (target.tagName !== 'BUTTON' || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return;
    const row = /** @type {HTMLElement|null} */ (target.closest('li.world-slot'));
    if (!row) return;
    const buttons = (r) => Array.from(r.querySelectorAll('button:not([disabled])'));
    const own = buttons(row);
    const i = own.indexOf(target);
    let next = null;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      next = own[i + (key === 'ArrowRight' ? 1 : -1)] || null;
    } else {
      const rows = Array.from(el.worldsList.querySelectorAll('li.world-slot'));
      const j = rows.indexOf(row) + (key === 'ArrowDown' ? 1 : -1);
      if (j >= 0 && j < rows.length) {
        const other = buttons(rows[j]);
        next = other[Math.min(Math.max(0, i), other.length - 1)] || null;
      }
    }
    if (next) {
      e.preventDefault();
      focusEl(/** @type {HTMLElement} */ (next));
    }
  });

  on(el.confirmYes, 'click', () => settle(true, false));
  on(el.confirmNo, 'click', () => closeConfirm(true));
  on(el.confirmDialog, 'click', (e) => {
    if (e.target === el.confirmDialog) closeConfirm(true); // a click on the dimmed backdrop cancels
  });
  on(el.confirmDialog, 'keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      closeConfirm(true);
    } else if (e.key === 'Tab') {
      // keep the focus on the dialog's two buttons
      e.preventDefault();
      focusEl(doc.activeElement === el.confirmNo ? el.confirmYes : el.confirmNo);
    }
  });

  // ---- loading -------------------------------------------------------------------------------------

  function showLoading(done, total) {
    ensureBackground();
    const t = Number.isFinite(total) && total > 0 ? total : 0;
    const d = Number.isFinite(done) && done > 0 ? Math.min(done, t) : 0;
    const pct = t > 0 ? (d / t) * 100 : 0;
    el.loadingBar.style.width = `${pct}%`;
    el.loadingText.textContent = `${d} / ${t} chunks`;
    show(el.loadingScreen);
  }

  function hideLoading() {
    hide(el.loadingScreen);
  }

  // ---- click to play -------------------------------------------------------------------------------

  function showClickToPlay() {
    show(el.clickToPlay);
  }

  function hideClickToPlay() {
    hide(el.clickToPlay);
  }

  on(el.clickToPlay, 'click', () => fire('onClickToPlay'));

  // ---- pause ---------------------------------------------------------------------------------------

  /** @param {number|string} seed @param {PhysicsMenuState} [physics] @param {string} [worldName]  shown under the title */
  function showPause(seed, physics, worldName) {
    el.pauseWorld.textContent = typeof worldName === 'string' ? worldName : '';
    el.pauseWorld.classList.toggle('hidden', !worldName);
    setQuitUnsaved(false);
    el.pauseSeed.textContent = `Seed: ${seed}`;
    if (physics) setPhysicsState(physics);
    show(el.pauseMenu);
  }

  /** @param {PhysicsMenuState} physics */
  function setPhysicsState(physics) {
    if (!physics || !physics.switches) return;
    for (const [name, label, key] of PHYSICS_TOGGLES) {
      const btn = el[/** @type {keyof typeof IDS} */ (key)];
      const on = physics.switches[name] !== false;
      btn.textContent = `${label}: ${on ? 'ON' : 'OFF'}`;
      btn.classList.toggle('off', !on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const undo = /** @type {HTMLButtonElement} */ (el.btnUndoPhysics);
    const survival = Boolean(physics.survival);
    undo.textContent = undoButtonLabel(physics.canUndo, physics.undoKind, survival);
    undo.disabled = survival || !physics.canUndo;
  }

  function hidePause() {
    if (state.pending) closeConfirm(false); // a question asked from the pause menu resolves false
    hide(el.pauseMenu);
  }

  /**
   * §41: #btn-quit reads "Save & Quit", or "Quit Without Saving" (class `danger`) after a Save & Quit whose save failed.
   * @param {boolean} on
   */
  function setQuitUnsaved(on) {
    el.btnQuit.textContent = on ? QUIT_UNSAVED_LABEL : QUIT_LABEL;
    el.btnQuit.classList.toggle('danger', Boolean(on));
  }

  /** The Creatures row's Zombies toggle (§39): "Zombies: ON|OFF", class `off`, aria-pressed. @param {boolean} on */
  function setZombiesState(on) {
    const btn = el.btnZombies;
    btn.textContent = `Zombies: ${on ? 'ON' : 'OFF'}`;
    btn.classList.toggle('off', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  on(el.btnZombies, 'click', () => fire('onZombiesToggle'));

  on(el.btnResume, 'click', () => fire('onResume'));
  on(el.btnSave, 'click', () => fire('onSave'));
  on(el.btnStopRunes, 'click', () => fire('onStopRunes'));
  for (const [name, , key] of PHYSICS_TOGGLES) {
    on(el[/** @type {keyof typeof IDS} */ (key)], 'click', () => fire('onPhysicsToggle', name));
  }
  on(el.btnUndoPhysics, 'click', () => {
    if (!/** @type {HTMLButtonElement} */ (el.btnUndoPhysics).disabled) fire('onUndoPhysics');
  });

  // ---- the Mode switch (§1.1, §9.8) -----------------------------------------------------------------------

  /**
   * `[ Creative | Survival ]`: the active half is filled in honey and carries aria-pressed="true".
   * @param {'creative'|'survival'} mode
   */
  function setModeState(mode) {
    state.mode = mode === 'survival' ? 'survival' : 'creative';
    for (const [m, key] of [['creative', 'btnModeCreative'], ['survival', 'btnModeSurvival']]) {
      const btn = el[/** @type {keyof typeof IDS} */ (key)];
      const active = state.mode === m;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    el.btnMode.dataset.mode = state.mode;
  }

  function getModeState() {
    return state.mode;
  }

  for (const [m, key] of [['creative', 'btnModeCreative'], ['survival', 'btnModeSurvival']]) {
    // only the inactive half asks to switch; main queues the switch (requestMode) and applies it next frame
    on(el[/** @type {keyof typeof IDS} */ (key)], 'click', () => {
      if (state.mode !== m) fire('onModeSelect', m);
    });
  }

  // ---- death screen (§2.5, §9.8) ---------------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** The honeycomb mask: one SVG of hex cells grouped by ring, each ring darkening after its delay. */
  function buildDeathComb() {
    if (state.deathCombBuilt || typeof doc.createElementNS !== 'function') return;
    state.deathCombBuilt = true;
    const svg = el.deathComb;
    clearChildren(svg);
    const size = DEATH_COMB_CELL;
    const [halfW, halfH] = deathCombExtent(DEATH_COMB_RINGS, size);
    svg.setAttribute('viewBox', `${-halfW} ${-halfH} ${2 * halfW} ${2 * halfH}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    const corners = [];
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k - Math.PI / 2;
      corners.push([(size - 1.2) * Math.cos(a), (size - 1.2) * Math.sin(a)]); // thin gaps: the comb's cells read
    }
    /** @type {Map<number, Element>} */
    const groups = new Map();
    for (const cell of deathCombCells(DEATH_COMB_RINGS, size)) {
      let g = groups.get(cell.ring);
      if (!g) {
        g = doc.createElementNS(SVG_NS, 'g');
        g.setAttribute('class', 'comb-ring');
        g.setAttribute('style', `animation-delay:${cell.delay}s`);
        g.setAttribute('data-ring', String(cell.ring));
        groups.set(cell.ring, g);
      }
      const poly = doc.createElementNS(SVG_NS, 'polygon');
      poly.setAttribute('points', corners.map(([x, y]) => `${+(cell.x + x).toFixed(1)},${+(cell.y + y).toFixed(1)}`).join(' '));
      g.appendChild(poly);
    }
    for (const ring of [...groups.keys()].sort((a, b) => b - a)) svg.appendChild(/** @type {Element} */ (groups.get(ring)));
  }

  /**
   * Show the death screen: no headline, no score; the cause line in honey, the detail, and where the belongings lie
   * (hidden when they were lost). The honeycomb closes in again on every call.
   * @param {string} title @param {string} detail @param {string} [where]
   */
  function showDeath(title, detail, where) {
    if (state.disposed) return;
    buildDeathComb();
    el.deathTitle.textContent = title == null ? '' : String(title);
    el.deathDetail.textContent = detail == null ? '' : String(detail);
    el.deathWhere.textContent = where ? String(where) : '';
    el.deathWhere.classList.toggle('hidden', !where);
    // restart the closing animation
    el.deathScreen.classList.remove('closing');
    void el.deathScreen.offsetWidth;
    el.deathScreen.classList.add('closing');
    state.deathOpen = true;
    show(el.deathScreen);
    focusEl(el.btnWake);
  }

  function hideDeath() {
    state.deathOpen = false;
    el.deathScreen.classList.remove('closing');
    hide(el.deathScreen);
    const active = /** @type {HTMLElement|null} */ (doc.activeElement);
    if (active && el.deathScreen.contains(active) && typeof active.blur === 'function') active.blur();
  }

  function isDeathOpen() {
    return state.deathOpen;
  }

  on(el.btnWake, 'click', () => fire('onWake'));
  on(el.btnDeathQuit, 'click', () => fire('onDeathQuit'));
  on(el.btnQuit, 'click', () => fire('onQuit'));
  // §14: the Survival Guide (the handbook's clean copy), in both modes
  on(el.btnGuideTitle, 'click', () => fire('onGuide', 'title'));
  on(el.btnGuidePause, 'click', () => fire('onGuide', 'pause'));

  // ---- the Devices row (DESIGN-circuits §6.2.17) ---------------------------------------------------------

  /**
   * The Circuits and Black holes switches: each one's active half filled in honey with aria-pressed="true"; only the inactive
   * half fires its callback. A key missing from `sw` keeps that switch as it is.
   * @param {{ circuits?: boolean, blackholes?: boolean }} sw
   */
  function setDeviceSwitches(sw) {
    const o = /** @type {Record<string, unknown>} */ (sw || {});
    for (const [name, , groupKey, onKey, offKey] of DEVICE_SWITCHES) {
      const which = /** @type {'circuits'|'blackholes'} */ (name);
      if (typeof o[which] === 'boolean') state.devices[which] = /** @type {boolean} */ (o[which]);
      const isOn = state.devices[which];
      for (const [key, half] of [[onKey, true], [offKey, false]]) {
        const btn = el[/** @type {keyof typeof IDS} */ (key)];
        const active = half === isOn;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      el[/** @type {keyof typeof IDS} */ (groupKey)].dataset.on = isOn ? 'true' : 'false';
    }
  }

  function getDeviceSwitches() {
    return { circuits: state.devices.circuits, blackholes: state.devices.blackholes };
  }

  for (const [name, , , onKey, offKey, callback] of DEVICE_SWITCHES) {
    for (const [key, half] of [[onKey, true], [offKey, false]]) {
      // only the inactive half asks to switch; main applies it and calls setDeviceSwitches
      on(el[/** @type {keyof typeof IDS} */ (key)], 'click', () => {
        if (state.devices[/** @type {'circuits'|'blackholes'} */ (name)] !== half) fire(callback, half);
      });
    }
  }

  // ---- block picker (pickerUI.js, DESIGN-circuits §5) ------------------------------------------------------

  const picker = createPickerUI(doc, {
    blockPicker: el.blockPicker,
    pickerGrid: el.pickerGrid,
    pickerName: el.pickerName,
    pickerBlurb: el.pickerBlurb,
    pickerSearch: el.pickerSearch,
    pickerShowAll: el.pickerShowAll,
    pickerRail: el.pickerRail,
    pickerScroll: el.pickerScroll,
  }, atlasCanvas, {
    onPick: (id, slot) => fire('onPickBlock', id, slot),
    onClose: () => fire('onPickerClose'),
  });

  /** @param {number[]} hotbar @param {number} selected */
  function showPicker(hotbar, selected) {
    if (state.disposed) return;
    picker.show(hotbar, selected);
  }

  function hidePicker() {
    picker.hide();
  }

  function isPickerOpen() {
    return picker.isOpen();
  }

  // ---- lifecycle -----------------------------------------------------------------------------------

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    picker.dispose();
    for (let i = 0; i < listeners.length; i++) {
      const [target, type, fn] = listeners[i];
      target.removeEventListener(type, fn);
    }
    listeners.length = 0;
    clearChildren(el.worldsList);
    state.editing = null;
    if (state.pending) {
      const pending = state.pending;
      state.pending = null;
      if (pending.resolve) pending.resolve(false);
    }
    state.confirmReturn = null;
    state.deathOpen = false;
  }

  // Static content that does not depend on showTitle: the pause-menu cheat sheet (autoplay/smoke runs never call showTitle
  // but can still pause). The picker built its rail above; its honeycomb is laid out when it opens (it measures its width).
  renderControlsSheets();
  setModeState('creative'); // new worlds start in Creative; main calls setModeState(survival.mode) on every pause
  setDeviceSwitches({ circuits: true, blackholes: true }); // main calls setDeviceSwitches with the world's switches on pause

  return {
    showTitle,
    setWorlds,
    showWorldsMessage,
    isConfirmOpen,
    hideTitle,
    showLoading,
    hideLoading,
    showClickToPlay,
    hideClickToPlay,
    showPause,
    hidePause,
    setQuitUnsaved,
    setPhysicsState,
    setZombiesState,
    showPicker,
    hidePicker,
    isPickerOpen,
    getSeedInput,
    setModeState,
    getModeState,
    confirm,
    showDeath,
    hideDeath,
    isDeathOpen,
    setDeviceSwitches,
    getDeviceSwitches,
    dispose,
  };
}
