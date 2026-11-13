// Caelancraft — the Sound Test screen (v0.16, CONTRACTS §82): every sound of the game in one list, each with a button
// that plays it, so a person can listen and judge. Five headings: Digging and placing, Footsteps and movement, Animals
// and zombies, Ambience (scenes that run the real ambience engine for a made-up place: day, night, by a stream, rain…) and
// Other (the sounds the game had before the sound bank).
//
// Opened from the pause menu's Sound row (`#btn-sound-test`) or with `?ui=sounds` (main opens it at once, over the title
// screen: no world is needed). Esc or Close shuts it and gives the focus back. The row's other button (`#btn-ambience`)
// is the Ambience switch: this module shows its state and reports clicks; main applies and stores it.
//
// DOM module (+ the pure SOUND_SECTIONS catalogue, tested). Every DOM access goes through `doc` and happens inside a
// function, so this file imports in Node. Plain chrome in the survival palette: text buttons, no icons.
import { BIOME, SOUND_GROUPS } from './blocks.js';
import { SOUND_NAMES } from './circuitSounds.js';
import { materialSound } from './soundBank.js';
import { Ambience, ANIMAL_VOICES, STRIDE_M } from './worldSounds.js';
import { SOUND_ROAR } from './zombies.js';
import { SOUND_THROW, SOUND_PICKUP, SOUND_THUNK } from './looseItems.js';
import { WALK_SPEED, CAMPFIRE_CRACKLES_PER_S } from './config.js';

const HIDDEN = 'hidden';
/** Screens the Sound Test can open over, made `inert` while it is open (as the Guide does). */
export const INERT_BENEATH = Object.freeze(['title-screen', 'pause-menu']);
/** A "walk" button plays this many steps at the walking cadence. */
export const WALK_STEPS = 4;
export const WALK_STEP_MS = Math.round((STRIDE_M / WALK_SPEED) * 1000);
/** The ambience scenes tick this often. */
export const SCENE_TICK_MS = 50;
/**
 * A press while the audio is still waking (the first one after ?ui=sounds: a browser starts audio only on a gesture, and
 * takes a moment) plays this much later, so the first sound asked for is heard too.
 */
export const WAKE_MS = 150;

/**
 * One button of the Sound Test. It plays `method(...args)` on the audio object and / or `recipe` (a bank or circuit
 * recipe name, or a recipe object) at `volume`, then each of `also`; `times` > 1 repeats the lot every `everyMs`.
 * @typedef {Object} SoundItem
 * @property {string} label
 * @property {string} [method]
 * @property {any[]} [args]
 * @property {string|object} [recipe]   a recipe name or a recipe (circuitSounds.SoundRecipe)
 * @property {number} [volume]
 * @property {{ recipe: string, volume?: number }[]} [also]
 * @property {number} [times]
 * @property {number} [everyMs]
 */
/** @typedef {{ label: string, items: SoundItem[] }} SoundRow */
/** @typedef {{ id: string, title: string, hint: string, rows: SoundRow[] }} SoundSection */

const title = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** @param {string} label @param {string|object} recipe @param {number} [volume] @returns {SoundItem} */
const one = (label, recipe, volume) => (volume === undefined ? { label, recipe } : { label, recipe, volume });

/**
 * An ambience scene: a made-up place the real ambience engine is run for.
 * @typedef {{ id: string, label: string, sample: import('./worldSounds.js').AmbienceSample, crackle?: boolean }} AmbienceScene
 */
const PLACE = Object.freeze({ biome: BIOME.PLAINS, openSky: true, underground: false, trees: 0.25, grass: 1, streamDist: Infinity, fireDist: Infinity, y: 66 });
/** @type {ReadonlyArray<AmbienceScene>} */
export const AMBIENCE_SCENES = Object.freeze([
  { id: 'day', label: 'Day', sample: { ...PLACE, daylight: 1, trees: 0.5 } },
  { id: 'night', label: 'Night', sample: { ...PLACE, daylight: 0 } },
  { id: 'stream', label: 'By a stream', sample: { ...PLACE, daylight: 1, biome: BIOME.FOREST, trees: 1, streamDist: 1.5 } },
  { id: 'fire', label: 'By a campfire at night', sample: { ...PLACE, daylight: 0, fireDist: 1.5 }, crackle: true },
  { id: 'mountain', label: 'On a mountain', sample: { ...PLACE, daylight: 1, biome: BIOME.SNOWY_PEAKS, trees: 0, grass: 0, y: 112 } },
  { id: 'cave', label: 'Underground', sample: { ...PLACE, daylight: 1, openSky: false, underground: true, trees: 0, grass: 0, y: 30 } },
  // §84: a heavy shower at the edge of the woods: the rain's loop, drops on the leaves, far thunder now and then; no birds
  { id: 'rain', label: 'Rain', sample: { ...PLACE, daylight: 0.8, biome: BIOME.FOREST, trees: 0.5, rain: 0.9 } },
]);

/**
 * Every sound of the game under the Sound Test's five headings.
 * @type {ReadonlyArray<SoundSection>}
 */
export const SOUND_SECTIONS = Object.freeze([
  {
    id: 'materials',
    title: 'Digging and placing',
    hint: 'Each material has its own break, dig tick and place. Press again for another take: pitch and grain differ a little every time.',
    rows: SOUND_GROUPS.map((g) => ({
      label: title(g),
      items: [
        { label: 'Break', method: 'playBreak', args: [g] },
        { label: 'Dig', method: 'playDig', args: [g, 0.35], times: 3, everyMs: 250 },
        { label: 'Place', method: 'playPlace', args: [g] },
      ],
    })),
  },
  {
    id: 'movement',
    title: 'Footsteps and movement',
    hint: `A walk is ${WALK_STEPS} steps at walking pace. Steps follow the ground under the feet; sneaking is quieter.`,
    rows: [
      {
        label: 'Walk on',
        items: SOUND_GROUPS.filter((g) => g !== 'water').map((g) => ({ label: title(g), recipe: materialSound('step', g), volume: 0.8, times: WALK_STEPS, everyMs: WALK_STEP_MS })),
      },
      {
        label: 'Sneak, sprint',
        items: [
          { label: 'Sneak on grass', recipe: 'stepGrass', volume: 0.35, times: 3, everyMs: 760 },
          { label: 'Sprint on stone', recipe: 'stepStone', volume: 1, times: 5, everyMs: 380 },
        ],
      },
      {
        label: 'Jump, land',
        items: [
          one('Jump', 'jump', 0.7),
          { label: 'Land from a jump', recipe: 'stepGrass', volume: 0.65, also: [{ recipe: 'landThud', volume: 0.37 }] },
          { label: 'Land from a height', recipe: 'stepStone', volume: 0.95, also: [{ recipe: 'landThud', volume: 0.9 }] },
        ],
      },
      {
        label: 'Water',
        items: [
          { label: 'Wade', recipe: materialSound('step', 'water'), volume: 0.8, times: WALK_STEPS, everyMs: WALK_STEP_MS * 2 },
          { label: 'Swim', recipe: 'swim', volume: 0.85, times: 3, everyMs: 880 },
          { label: 'Swim under water', recipe: 'swimUnder', volume: 0.85, times: 3, everyMs: 880 },
          one('Splash in', 'splashIn', 0.8),
          one('Climb out', 'splashOut', 0.8),
        ],
      },
    ],
  },
  {
    id: 'voices',
    title: 'Animals and zombies',
    hint: 'Most animals have two or three calls; each press picks another.',
    rows: [
      {
        label: 'Farm',
        items: [
          { label: 'Pig', method: 'playOink', args: [1] },
          { label: 'Pig, hit', method: 'playSqueal', args: [1] },
          one('Cow', ANIMAL_VOICES.moo),
          one('Sheep', ANIMAL_VOICES.baa),
          one('Horse', ANIMAL_VOICES.neigh),
        ],
      },
      {
        label: 'Wolf',
        items: [one('Bark', ANIMAL_VOICES.woof), one('Whine', ANIMAL_VOICES.whine), one('Howl (night)', 'wolfHowl')],
      },
      {
        label: 'Wild',
        items: [
          one('Deer', ANIMAL_VOICES.bleat),
          one('Rabbit', ANIMAL_VOICES.squeak),
          one('Pheasant', ANIMAL_VOICES.cackle),
          one('Wild turkey', ANIMAL_VOICES.gobble),
          one('Wings taking off', ANIMAL_VOICES.flush),
          one('Fish', ANIMAL_VOICES.plop),
        ],
      },
      {
        label: 'Bear',
        items: [one('Grunt', ANIMAL_VOICES.grunt), one('Growl (warning)', ANIMAL_VOICES.growl), one('Roar (charge)', ANIMAL_VOICES.roar)],
      },
      {
        label: 'Zombie',
        items: [
          { label: 'Groan', method: 'playGroan', args: [1] },
          { label: 'Hit', method: 'playZombieHurt', args: [1] },
          { label: 'Down', method: 'playZombieDown', args: [1] },
        ],
      },
    ],
  },
  {
    id: 'ambience',
    title: 'Ambience',
    hint: 'A scene runs the game\'s own ambience for a made-up place until you press Off. It is meant to be quiet: well under the other sounds.',
    rows: [
      // the scene buttons are added by the screen (AMBIENCE_SCENES)
      {
        label: 'Birds',
        items: [
          one('Tit', 'birdTit'), one('Warbler', 'birdWarbler'), one('Finch', 'birdFinch'), one('Blackbird', 'birdBlackbird'),
          one('Sparrow', 'birdSparrow'), one('Dove', 'birdDove'),
        ],
      },
      {
        label: 'Small sounds',
        items: [
          { label: 'Cricket', recipe: 'cricketChirp', times: 5, everyMs: 620 },
          { label: 'Fire crackle', method: 'playCrackle', args: [1], times: 6, everyMs: 210 },
          { label: 'Stream bubbles', recipe: 'streamBlip', times: 5, everyMs: 330 },
          { label: 'Rain on leaves', recipe: 'rainPatter', times: 6, everyMs: 280 },
          one('Far thunder', 'thunderRoll'),
        ],
      },
    ],
  },
  {
    id: 'other',
    title: 'Other',
    hint: 'The sounds the game already had. They were not changed.',
    rows: [
      {
        label: 'Player',
        items: [
          { label: 'Click', method: 'playClick' },
          { label: 'Hurt', method: 'playHurt', args: [1] },
          { label: 'Death', method: 'playDeath', args: [1] },
          { label: 'Eat', method: 'playEat', args: [1] },
          { label: 'Drink', method: 'playDrink', args: [1] },
          { label: 'Pick', method: 'playPick', args: [1] },
          { label: 'Make', method: 'playCraft', args: [1] },
          { label: 'Tool breaks', method: 'playToolBreak', args: [1] },
          { label: 'Sizzle', method: 'playSizzle', args: [1] },
          one('Throw', SOUND_THROW, 0.7),
          one('Pick up', SOUND_PICKUP, 0.6),
          one('Thunk', SOUND_THUNK, 0.8),
        ],
      },
      {
        label: 'World',
        items: [
          { label: 'Block lands', method: 'playThud', args: [1] },
          { label: 'Water flows', method: 'playSplash', args: [1] },
          { label: 'Tree creaks', method: 'playCreak', args: [1] },
          { label: 'Fuse hiss', method: 'playHiss', args: [1] },
          { label: 'Fizzle', method: 'playFizzle', args: [1] },
          { label: 'Blast', method: 'playBoom', args: [1] },
          { label: 'Watcher vanishes', method: 'playWatcherVanish', args: [1] },
          one('Alpha zombie', SOUND_ROAR),
          one('Snare', ANIMAL_VOICES.snare),
          one('Tamed', ANIMAL_VOICES.tame),
        ],
      },
      {
        label: 'Circuits and black holes',
        items: SOUND_NAMES.filter((n) => n !== 'bhDrone').map((n) => one(n, n)),
      },
    ],
  },
]);

/**
 * @typedef {Object} SoundTest
 * @property {() => void} open
 * @property {() => void} close
 * @property {() => boolean} isOpen
 * @property {(on: boolean) => void} setAmbience   show the Ambience switch's state on `#btn-ambience`
 * @property {(e: KeyboardEvent) => boolean} handleKey
 * @property {() => string|null} scene             the ambience scene running, or null
 * @property {() => void} dispose
 */

/**
 * @param {Document} doc
 * @param {any} audio  the game's Audio (audio.createAudio)
 * @param {{ ambienceOn?: boolean, onAmbience?: (on: boolean) => void, win?: any, random?: () => number }} [opts]
 * @returns {SoundTest}
 */
export function createSoundTest(doc, audio, opts = {}) {
  if (!doc || typeof doc.createElement !== 'function') throw new TypeError('createSoundTest: a Document is required');
  const win = opts.win ?? doc.defaultView ?? globalThis;
  const random = typeof opts.random === 'function' ? opts.random : Math.random;

  /** @type {Array<[EventTarget, string, EventListener, boolean]>} */
  const listeners = [];
  /** @param {any} target @param {string} type @param {(e: any) => void} fn @param {boolean} [capture] */
  function on(target, type, fn, capture = false) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, capture);
    listeners.push([target, type, fn, capture]);
  }
  /** @param {string} tag @param {string} [className] @param {string} [text] @returns {HTMLElement} */
  function make(tag, className, text) {
    const node = /** @type {HTMLElement} */ (doc.createElement(tag));
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  /** @param {string} className @param {string} text @returns {HTMLButtonElement} */
  function button(className, text) {
    const b = /** @type {HTMLButtonElement} */ (make('button', className, text));
    b.type = 'button';
    return b;
  }

  const state = {
    open: false,
    built: false,
    disposed: false,
    ambienceOn: opts.ambienceOn !== false,
    /** @type {string|null} */
    scene: null,
    /** @type {any} */
    sceneTimer: null,
    sceneAt: 0,
    /** @type {Set<any>} pending repeats of a button (walks, dig ticks) */
    timers: new Set(),
    /** @type {Set<string>} */
    madeInert: new Set(),
    /** @type {HTMLElement|null} */
    returnFocus: null,
  };
  /** @type {Ambience|null} the screen's own ambience engine (the game's is silent while the game is paused) */
  let preview = null;
  /** @type {Record<string, any>} */
  const el = {};

  const btnOpen = doc.getElementById('btn-sound-test');
  const btnAmbience = doc.getElementById('btn-ambience');

  // ---- playing ----------------------------------------------------------------------------------------------------

  function resume() {
    try {
      if (audio && typeof audio.resume === 'function') audio.resume(); // a click is the gesture browsers ask for
    } catch {
      /* sound is a nicety */
    }
  }

  /** @param {SoundItem} item */
  function playOnce(item) {
    try {
      if (item.method && typeof audio[item.method] === 'function') audio[item.method](...(item.args ?? []));
      if (item.recipe) audio.playRecipe(item.recipe, item.volume ?? 1);
      for (const a of item.also ?? []) audio.playRecipe(a.recipe, a.volume ?? 1);
    } catch {
      /* never out of a click handler */
    }
  }

  /** @param {number} ms @param {() => void} fn */
  function later(ms, fn) {
    if (typeof win.setTimeout !== 'function') return;
    const id = win.setTimeout(() => {
      state.timers.delete(id);
      if (state.open) fn();
    }, ms);
    state.timers.add(id);
  }

  /** @param {SoundItem} item */
  function play(item) {
    resume();
    const start = () => {
      playOnce(item);
      for (let k = 1; k < (item.times ?? 1); k++) later(k * (item.everyMs ?? 300), () => playOnce(item));
    };
    if (audio && audio.running === false && typeof win.setTimeout === 'function') later(WAKE_MS, start);
    else start();
  }

  // ---- ambience scenes --------------------------------------------------------------------------------------------

  function now() {
    return win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now();
  }

  function tickScene() {
    const scene = AMBIENCE_SCENES.find((s) => s.id === state.scene);
    if (!scene || !preview) return;
    const t = now();
    const dt = Math.min(0.25, Math.max(0.001, (t - state.sceneAt) / 1000));
    state.sceneAt = t;
    try {
      preview.update(dt, scene.sample);
      if (scene.crackle && random() < CAMPFIRE_CRACKLES_PER_S * dt) audio.playCrackle(0.5 + 0.5 * random());
    } catch {
      /* never out of a timer */
    }
  }

  /** Start a scene (or stop them all with null). @param {string|null} id */
  function setScene(id) {
    const scene = AMBIENCE_SCENES.find((s) => s.id === id) ?? null;
    state.scene = scene ? scene.id : null;
    if (scene) {
      resume();
      if (!preview) preview = new Ambience(audio, { random });
      state.sceneAt = now();
      if (state.sceneTimer === null && typeof win.setInterval === 'function') state.sceneTimer = win.setInterval(tickScene, SCENE_TICK_MS);
    } else {
      if (state.sceneTimer !== null && typeof win.clearInterval === 'function') win.clearInterval(state.sceneTimer);
      state.sceneTimer = null;
      if (preview) preview.stop();
    }
    for (const b of el.sceneButtons ?? []) b.setAttribute('aria-pressed', b.dataset.scene === (state.scene ?? 'off') ? 'true' : 'false');
  }

  // ---- the screen -------------------------------------------------------------------------------------------------

  function build() {
    if (state.built) return;
    state.built = true;
    let root = doc.getElementById('sound-test');
    if (!root) {
      root = make('div', `layer ${HIDDEN}`);
      root.id = 'sound-test';
      (doc.body || doc.documentElement).appendChild(root);
    }
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Sound Test');
    while (root.firstChild) root.removeChild(root.firstChild);
    el.root = root;

    const panel = make('div', 'snd-panel');
    root.appendChild(panel);
    const head = make('div', 'snd-head');
    panel.appendChild(head);
    const h = make('h2', 'snd-title', 'Sound Test');
    h.id = 'sound-test-title';
    head.appendChild(h);
    el.muted = make('span', 'snd-muted');
    head.appendChild(el.muted);
    el.unmute = button('text-link snd-unmute', 'Turn sound on');
    head.appendChild(el.unmute);
    on(el.unmute, 'click', () => {
      if (audio && typeof audio.setMuted === 'function') audio.setMuted(false);
      resume();
      showMuted();
    });
    el.close = button('hex-button snd-close', 'Close');
    el.close.setAttribute('aria-label', 'Close the Sound Test (Esc)');
    head.appendChild(el.close);
    on(el.close, 'click', () => close());

    const body = make('div', 'snd-body');
    panel.appendChild(body);
    el.body = body;
    el.sceneButtons = [];
    for (const section of SOUND_SECTIONS) {
      const sec = make('section', 'snd-section');
      sec.dataset.section = section.id;
      sec.appendChild(make('h3', 'snd-heading', section.title));
      sec.appendChild(make('p', 'snd-hint', section.hint));
      if (section.id === 'ambience') {
        const row = make('div', 'snd-row');
        row.appendChild(make('span', 'snd-label', 'Scene'));
        const group = make('div', 'snd-buttons');
        for (const scene of [...AMBIENCE_SCENES, { id: 'off', label: 'Off' }]) {
          const b = button('snd-btn snd-scene', scene.label);
          b.dataset.scene = scene.id;
          b.setAttribute('aria-pressed', scene.id === 'off' ? 'true' : 'false');
          on(b, 'click', () => setScene(scene.id === 'off' ? null : scene.id));
          group.appendChild(b);
          el.sceneButtons.push(b);
        }
        row.appendChild(group);
        sec.appendChild(row);
      }
      for (const r of section.rows) {
        const row = make('div', 'snd-row');
        row.appendChild(make('span', 'snd-label', r.label));
        const group = make('div', 'snd-buttons');
        for (const item of r.items) {
          const b = button('snd-btn', item.label);
          on(b, 'click', () => play(item));
          group.appendChild(b);
        }
        row.appendChild(group);
        sec.appendChild(row);
      }
      body.appendChild(sec);
    }
    on(root, 'mousedown', (e) => {
      if (e.target === root) close(); // a click on the dimmed backdrop
    });
  }

  function showMuted() {
    const muted = Boolean(audio && audio.muted);
    el.muted.textContent = muted ? 'Sound is muted.' : '';
    el.unmute.classList.toggle(HIDDEN, !muted);
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
    const titleScreen = doc.getElementById('title-screen');
    el.root.classList.toggle('over-title', !!titleScreen && !titleScreen.classList.contains(HIDDEN));
    showMuted();
    el.root.classList.remove(HIDDEN);
    state.open = true;
    setInertBeneath(true);
    doc.addEventListener('keydown', onDocKey, true);
    resume();
    focusEl(el.close);
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    setScene(null);
    for (const id of state.timers) if (typeof win.clearTimeout === 'function') win.clearTimeout(id);
    state.timers.clear();
    el.root.classList.add(HIDDEN);
    setInertBeneath(false);
    doc.removeEventListener('keydown', onDocKey, true);
    const back = state.returnFocus;
    state.returnFocus = null;
    if (back && (back.isConnected ?? true)) focusEl(back);
  }

  /**
   * A keydown while the screen is open: Esc closes it.
   * @param {KeyboardEvent} e
   * @returns {boolean} the key was the screen's
   */
  function handleKey(e) {
    if (!state.open || !e || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.code !== 'Escape' && e.key !== 'Escape' && e.key !== 'Esc') return false;
    if (!e.repeat) close();
    if (typeof e.preventDefault === 'function') e.preventDefault();
    return true;
  }

  /** @param {boolean} isOn */
  function setAmbience(isOn) {
    state.ambienceOn = Boolean(isOn);
    if (!btnAmbience) return;
    btnAmbience.textContent = `Ambience: ${state.ambienceOn ? 'On' : 'Off'}`;
    btnAmbience.setAttribute('aria-pressed', state.ambienceOn ? 'true' : 'false');
  }

  on(btnOpen, 'click', () => open());
  on(btnAmbience, 'click', () => {
    setAmbience(!state.ambienceOn);
    if (typeof opts.onAmbience === 'function') opts.onAmbience(state.ambienceOn);
  });
  setAmbience(state.ambienceOn);

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

  return { open, close, isOpen: () => state.open, setAmbience, handleKey, scene: () => state.scene, dispose };
}
