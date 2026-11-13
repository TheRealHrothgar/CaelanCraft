// src/soundTest.js — the Sound Test screen (CONTRACTS §82): every sound of the game under five headings, each with a
// button that plays it, ambience scenes that run the real ambience engine, opened from the pause menu's Sound row or with
// ?ui=sounds. The screen runs on a fake DOM built from index.html (tests/helpers/fakeDom.js) with a recording stand-in
// for the audio player, and once with the game's real audio code on the offline renderer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createSoundTest, SOUND_SECTIONS, AMBIENCE_SCENES, INERT_BENEATH, WALK_STEPS, WALK_STEP_MS, SCENE_TICK_MS, WAKE_MS,
} from '../../src/soundTest.js';
import { SOUND_BANK, BANK_NAMES, AMBIENCE_LOOPS, BIRD_SONGS, materialSound } from '../../src/soundBank.js';
import { SOUND_RECIPES, SOUND_NAMES } from '../../src/circuitSounds.js';
import { SOUND_GROUPS } from '../../src/blocks.js';
import { ambienceTargets, THUNDER_FROM } from '../../src/worldSounds.js';
import { createAudio } from '../../src/audio.js';
import { parseParams } from '../../src/diagnostics.js';
import { documentFromHTML, fire } from '../helpers/fakeDom.js';
import { OfflineContext, measure, seededRandom } from '../helpers/offlineAudio.js';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('../../src/styles.css', import.meta.url)), 'utf8');
const ITEMS = SOUND_SECTIONS.flatMap((s) => s.rows.flatMap((r) => r.items));

/** An audio player that records every call (any play* method, playRecipe, loops). */
function recorder(muted = false) {
  const calls = [];
  const loops = {};
  const base = {
    calls,
    loops,
    muted,
    resumed: 0,
    resume() {
      base.resumed++;
    },
    setMuted(b) {
      base.muted = b;
    },
    playRecipe(recipe, volume = 1) {
      calls.push(['playRecipe', recipe, volume]);
    },
    startLoop(name) {
      const h = { name, volume: 0, rate: 1, set(v, r = 1) { h.volume = v; h.rate = r; }, stop() { h.volume = 0; } };
      loops[name] = h;
      return h;
    },
  };
  return new Proxy(base, {
    get(target, key) {
      if (key in target || typeof key !== 'string' || !key.startsWith('play')) return target[key];
      return (...args) => calls.push([key, ...args]);
    },
  });
}

function setup(opts = {}) {
  const doc = documentFromHTML(html);
  const audio = opts.audio ?? recorder(opts.muted);
  const onAmbience = vi.fn();
  const ui = createSoundTest(/** @type {any} */ (doc), audio, { win: globalThis, random: seededRandom(4), onAmbience, ...opts.ui });
  const $ = (id) => /** @type {any} */ (doc.getElementById(id));
  const root = () => $('sound-test');
  /** The button with this label inside the row with this label (or anywhere). */
  const button = (label, row) => {
    const rows = root().querySelectorAll('.snd-row');
    for (const r of rows) {
      if (row && r.querySelector('.snd-label').textContent !== row) continue;
      const b = r.querySelectorAll('button').find((x) => x.textContent === label);
      if (b) return b;
    }
    throw new Error(`no button ${row ?? ''} / ${label}`);
  };
  return { doc, audio, ui, onAmbience, $, root, button };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the catalogue: every sound has a button (§82)', () => {
  it('five headings, in the order the sounds were asked for, then Other', () => {
    expect(SOUND_SECTIONS.map((s) => s.title)).toEqual(['Digging and placing', 'Footsteps and movement', 'Animals and zombies', 'Ambience', 'Other']);
    expect(SOUND_SECTIONS.map((s) => s.id)).toEqual(['materials', 'movement', 'voices', 'ambience', 'other']);
    for (const s of SOUND_SECTIONS) {
      expect(s.hint.length, s.id).toBeGreaterThan(20);
      expect(s.hint, s.id).toMatch(/\.$/); // a plain sentence
      for (const r of s.rows) {
        expect(r.label.length, s.id).toBeGreaterThan(0);
        expect(r.items.length, `${s.id} / ${r.label}`).toBeGreaterThan(0);
      }
    }
    expect(SOUND_SECTIONS[0].rows.map((r) => r.label.toLowerCase())).toEqual([...SOUND_GROUPS]);
    for (const r of SOUND_SECTIONS[0].rows) expect(r.items.map((i) => i.label)).toEqual(['Break', 'Dig', 'Place']);
  });

  it('every item is well formed: a label, and a method the audio player has or a recipe that exists', () => {
    const real = createAudio({ AudioContextClass: OfflineContext });
    const labels = new Set();
    for (const s of SOUND_SECTIONS) {
      for (const r of s.rows) {
        for (const item of r.items) {
          const where = `${s.id} / ${r.label} / ${item.label}`;
          expect(typeof item.label === 'string' && item.label.length > 0, where).toBe(true);
          expect(labels.has(`${r.label}/${item.label}`), `${where}: twice`).toBe(false);
          labels.add(`${r.label}/${item.label}`);
          expect(Boolean(item.method) || Boolean(item.recipe), where).toBe(true);
          if (item.method) expect(typeof real[item.method], where).toBe('function');
          for (const recipe of [item.recipe, ...(item.also ?? []).map((a) => a.recipe)].filter(Boolean)) {
            if (typeof recipe === 'string') expect(SOUND_BANK[recipe] ?? SOUND_RECIPES[recipe], `${where}: ${recipe}`).toBeTruthy();
            else expect(Array.isArray(recipe.layers) || Array.isArray(recipe.variants), where).toBe(true);
          }
          if (item.volume !== undefined) expect(item.volume > 0 && item.volume <= 1, where).toBe(true);
          if (item.times !== undefined) expect(Number.isInteger(item.times) && item.times >= 2 && item.times <= 8 && item.everyMs >= 150, where).toBe(true);
        }
      }
    }
  });

  it('every bank sound can be heard from the screen: by a button, or (the loops: three of the place, and §84 the rain) in a scene', () => {
    const byMethod = {
      playOink: 'pigOink', playSqueal: 'pigSqueal', playGroan: 'zombieGroan', playZombieHurt: 'zombieHurt', playZombieDown: 'zombieDown',
      playCrackle: 'fireCrackle',
    };
    const heard = new Set();
    for (const item of ITEMS) {
      if (item.method === 'playBreak' || item.method === 'playDig' || item.method === 'playPlace') {
        heard.add(materialSound(item.method.slice(4).toLowerCase(), item.args[0]));
      } else if (byMethod[item.method]) {
        heard.add(byMethod[item.method]);
      }
      for (const recipe of [item.recipe, ...(item.also ?? []).map((a) => a.recipe)].filter(Boolean)) {
        const name = typeof recipe === 'string' ? recipe : BANK_NAMES.find((n) => SOUND_BANK[n] === recipe);
        if (name) heard.add(name);
      }
    }
    const loops = { ambWind: 'wind', ambStream: 'stream', ambFire: 'fire', ambRain: 'rain' };
    expect(Object.keys(loops)).toEqual([...AMBIENCE_LOOPS]);
    for (const name of AMBIENCE_LOOPS) {
      if (AMBIENCE_SCENES.some((s) => ambienceTargets(s.sample)[loops[name]] > 0.3)) heard.add(name);
    }
    expect(BANK_NAMES.filter((n) => !heard.has(n))).toEqual([]);
  });

  it('every play method of the audio player and every circuit sound has a button under some heading', () => {
    const real = createAudio({ AudioContextClass: OfflineContext });
    const methods = Object.keys(real).filter((k) => k.startsWith('play') && k !== 'playRecipe');
    const used = new Set(ITEMS.map((i) => i.method).filter(Boolean));
    expect(methods.filter((m) => !used.has(m))).toEqual([]);
    const recipes = new Set(ITEMS.map((i) => i.recipe).filter((r) => typeof r === 'string'));
    expect(SOUND_NAMES.filter((n) => n !== 'bhDrone' && !recipes.has(n))).toEqual([]);
    // the old sounds are under Other; the reworked ones are not
    const other = SOUND_SECTIONS.find((s) => s.id === 'other').rows.flatMap((r) => r.items);
    for (const m of ['playClick', 'playThud', 'playBoom', 'playHurt', 'playEat', 'playCraft', 'playWatcherVanish']) expect(other.some((i) => i.method === m), m).toBe(true);
    for (const m of ['playBreak', 'playDig', 'playPlace', 'playOink', 'playGroan', 'playCrackle']) expect(other.some((i) => i.method === m), m).toBe(false);
  });

  it('the scenes: day, night and by a stream, and a few more; each makes its own part of the ambience heard', () => {
    expect(AMBIENCE_SCENES.map((s) => s.id).slice(0, 3)).toEqual(['day', 'night', 'stream']);
    const t = Object.fromEntries(AMBIENCE_SCENES.map((s) => [s.id, ambienceTargets(s.sample)]));
    expect(t.day.birds).toBeGreaterThan(0.5);
    expect(t.day.crickets).toBe(0);
    expect(t.night.crickets).toBe(1);
    expect(t.night.birds).toBe(0);
    expect(t.stream.stream).toBeGreaterThan(0.7);
    expect(t.stream.birds).toBe(1);
    expect(t.fire.fire).toBeGreaterThan(0.7);
    expect(t.mountain.wind).toBeGreaterThan(t.day.wind * 1.5);
    expect(t.cave.wind).toBeLessThan(0.06);
    expect(t.cave.birds).toBe(0);
    expect(WALK_STEPS).toBeGreaterThanOrEqual(3);
    expect(WALK_STEP_MS).toBeGreaterThan(400); // two steps a second
    expect(WALK_STEP_MS).toBeLessThan(600);
  });

  it('the Rain scene (CONTRACTS §84): a heavy shower at the edge of the woods: the rain\'s loop, no birds, leaves and thunder', () => {
    const scene = AMBIENCE_SCENES.find((s) => s.id === 'rain');
    expect(scene.label).toBe('Rain');
    expect(AMBIENCE_SCENES[AMBIENCE_SCENES.length - 1]).toBe(scene); // after the scenes that were there
    const t = ambienceTargets(scene.sample);
    expect(t.rain).toBeGreaterThan(0.9);
    expect(t.birds).toBe(0);
    expect(scene.sample.rain).toBeGreaterThanOrEqual(THUNDER_FROM); // heavy enough for far thunder now and then
    expect(scene.sample.trees).toBeGreaterThan(0); // and for the drops on the leaves
    // every other scene is dry, as it was
    for (const s of AMBIENCE_SCENES) if (s !== scene) expect(ambienceTargets(s.sample).rain, s.id).toBe(0);
    const small = SOUND_SECTIONS.find((s) => s.id === 'ambience').rows.find((r) => r.label === 'Small sounds').items;
    expect(small.map((i) => i.label).slice(-2)).toEqual(['Rain on leaves', 'Far thunder']);
    expect(small.map((i) => i.recipe).slice(-2)).toEqual(['rainPatter', 'thunderRoll']);
  });
});

describe('the screen (§82)', () => {
  it('is built when first opened: a dialog with the five headings, a hint under each, and a text button per sound', () => {
    const { ui, root, $ } = setup();
    expect(root().children).toHaveLength(0);
    expect(root().classList.contains('hidden')).toBe(true);
    expect(ui.isOpen()).toBe(false);
    ui.open();
    expect(ui.isOpen()).toBe(true);
    expect(root().classList.contains('hidden')).toBe(false);
    expect(root().getAttribute('role')).toBe('dialog');
    expect(root().getAttribute('aria-modal')).toBe('true');
    expect(root().getAttribute('aria-label')).toBe('Sound Test');
    expect(root().querySelector('.snd-title').textContent).toBe('Sound Test');
    expect(root().querySelectorAll('.snd-heading').map((h) => h.textContent)).toEqual(SOUND_SECTIONS.map((s) => s.title));
    expect(root().querySelectorAll('.snd-hint')).toHaveLength(5);
    const buttons = root().querySelectorAll('.snd-btn');
    expect(buttons).toHaveLength(ITEMS.length + AMBIENCE_SCENES.length + 1);
    expect(buttons.length).toBeGreaterThan(110);
    for (const b of buttons) {
      expect(b.type).toBe('button');
      expect(b.textContent.length).toBeGreaterThan(0);
      expect(b.children).toHaveLength(0); // text only: no icon
    }
    // plain chrome: no Minecraft buttons, no pictures; Close is the survival palette's button
    expect(root().querySelectorAll('.mc-button, .picker-panel, svg, img, canvas')).toHaveLength(0);
    expect(root().querySelector('.snd-close').classList.contains('hex-button')).toBe(true);
    expect($('sound-test-title')).toBeTruthy();
    // a second open changes nothing; the screen is built once
    const first = root().querySelector('.snd-panel');
    ui.open();
    ui.close();
    ui.open();
    expect(root().querySelector('.snd-panel')).toBe(first);
    expect(root().querySelectorAll('.snd-btn')).toHaveLength(buttons.length);
  });

  it('a button plays its sound at once (and wakes the audio: a click is the gesture browsers ask for)', () => {
    const { ui, audio, button } = setup();
    ui.open();
    const woke = audio.resumed;
    fire(button('Break', 'Stone'), 'click');
    expect(audio.calls).toEqual([['playBreak', 'stone']]);
    expect(audio.resumed).toBe(woke + 1);
    fire(button('Place', 'Glass'), 'click');
    fire(button('Cow', 'Farm'), 'click');
    fire(button('Howl (night)'), 'click');
    fire(button('Groan'), 'click');
    fire(button('Blast'), 'click');
    fire(button('bellRing'), 'click');
    expect(audio.calls.slice(1)).toEqual([
      ['playPlace', 'glass'], ['playRecipe', SOUND_BANK.cowMoo, 1], ['playRecipe', 'wolfHowl', 1], ['playGroan', 1], ['playBoom', 1],
      ['playRecipe', 'bellRing', 1],
    ]);
    // a landing is the ground's step and the thump together
    audio.calls.length = 0;
    fire(button('Land from a height'), 'click');
    expect(audio.calls).toEqual([['playRecipe', 'stepStone', 0.95], ['playRecipe', 'landThud', 0.9]]);
  });

  it('the first press after the page loads waits a moment for the audio to wake, so it is heard too', () => {
    const audio = recorder();
    audio.running = false; // as after ?ui=sounds: the context exists but the browser has not started it yet
    const { ui, button } = setup({ audio });
    ui.open();
    fire(button('Cow', 'Farm'), 'click');
    expect(audio.resumed).toBeGreaterThanOrEqual(2); // asked to start, on this gesture
    expect(audio.calls).toEqual([]);
    audio.running = true; // the browser lets it start
    vi.advanceTimersByTime(WAKE_MS + 1);
    expect(audio.calls).toEqual([['playRecipe', SOUND_BANK.cowMoo, 1]]);
    fire(button('Cow', 'Farm'), 'click'); // from then on at once
    expect(audio.calls).toHaveLength(2);
    expect(WAKE_MS).toBeLessThanOrEqual(250);
  });

  it('a walk is four steps at walking pace, a dig three ticks; closing the screen stops what was still to come', () => {
    const { ui, audio, button } = setup();
    ui.open();
    fire(button('Gravel', 'Walk on'), 'click');
    expect(audio.calls).toEqual([['playRecipe', 'stepGravel', 0.8]]);
    vi.advanceTimersByTime(WALK_STEP_MS * (WALK_STEPS - 1) + 5);
    expect(audio.calls).toHaveLength(WALK_STEPS);
    expect(audio.calls.every((c) => c[1] === 'stepGravel')).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(audio.calls).toHaveLength(WALK_STEPS);
    audio.calls.length = 0;
    fire(button('Dig', 'Wood'), 'click');
    vi.advanceTimersByTime(600);
    expect(audio.calls).toEqual([['playDig', 'wood', 0.35], ['playDig', 'wood', 0.35], ['playDig', 'wood', 0.35]]);
    audio.calls.length = 0;
    fire(button('Sand', 'Walk on'), 'click');
    vi.advanceTimersByTime(WALK_STEP_MS + 5);
    expect(audio.calls).toHaveLength(2);
    ui.close();
    vi.advanceTimersByTime(5000);
    expect(audio.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an ambience scene runs the game\'s ambience for a made-up place until Off, another scene, or Close', () => {
    const { ui, audio, button, root } = setup();
    ui.open();
    const scenes = root().querySelectorAll('.snd-scene');
    expect(scenes.map((b) => b.textContent)).toEqual([...AMBIENCE_SCENES.map((s) => s.label), 'Off']);
    const pressed = () => scenes.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
    expect(pressed()).toEqual(['Off']);
    expect(ui.scene()).toBeNull();
    fire(button('Day', 'Scene'), 'click');
    expect(pressed()).toEqual(['Day']);
    expect(ui.scene()).toBe('day');
    vi.advanceTimersByTime(30000);
    expect(audio.loops.ambWind.volume).toBeGreaterThan(0.1);
    expect(audio.loops.ambStream.volume).toBe(0);
    const birds = audio.calls.filter((c) => c[0] === 'playRecipe' && BIRD_SONGS.includes(c[1]));
    expect(birds.length).toBeGreaterThan(2);
    expect(audio.calls.every((c) => c[0] === 'playRecipe' && BIRD_SONGS.includes(c[1]))).toBe(true);
    // by a stream: the water comes up
    fire(button('By a stream', 'Scene'), 'click');
    expect(pressed()).toEqual(['By a stream']);
    vi.advanceTimersByTime(8000);
    expect(audio.loops.ambStream.volume).toBeGreaterThan(0.6);
    expect(audio.calls.some((c) => c[1] === 'streamBlip')).toBe(true);
    // night: crickets, no birds
    audio.calls.length = 0;
    fire(button('Night', 'Scene'), 'click');
    vi.advanceTimersByTime(20000);
    expect(audio.calls.filter((c) => c[1] === 'cricketChirp').length).toBeGreaterThan(5);
    expect(audio.calls.slice(-10).some((c) => BIRD_SONGS.includes(c[1]))).toBe(false);
    // the campfire: its bed and its crackles
    audio.calls.length = 0;
    fire(button('By a campfire at night', 'Scene'), 'click');
    vi.advanceTimersByTime(6000);
    expect(audio.loops.ambFire.volume).toBeGreaterThan(0.6);
    expect(audio.calls.filter((c) => c[0] === 'playCrackle').length).toBeGreaterThan(10);
    // Off: silence at once, the ticking stops
    fire(button('Off', 'Scene'), 'click');
    expect(pressed()).toEqual(['Off']);
    for (const h of Object.values(audio.loops)) expect(h.volume).toBe(0);
    const n = audio.calls.length;
    vi.advanceTimersByTime(10000);
    expect(audio.calls.length).toBe(n);
    expect(vi.getTimerCount()).toBe(0);
    // closing the screen stops a running scene too
    fire(button('On a mountain', 'Scene'), 'click');
    vi.advanceTimersByTime(4000);
    expect(audio.loops.ambWind.volume).toBeGreaterThan(0.3);
    ui.close();
    expect(ui.scene()).toBeNull();
    for (const h of Object.values(audio.loops)) expect(h.volume).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(SCENE_TICK_MS).toBeLessThanOrEqual(100);
  });

  it('Esc and Close shut it; the focus goes back to the button that opened it; nothing else reacts to that Esc', () => {
    const { ui, doc, $, root } = setup();
    $('btn-sound-test').focus();
    fire($('btn-sound-test'), 'click');
    expect(ui.isOpen()).toBe(true);
    expect(doc.activeElement).toBe(root().querySelector('.snd-close'));
    const other = { type: 'keydown', code: 'KeyW', key: 'w' };
    doc.dispatch(other);
    expect(ui.isOpen()).toBe(true);
    expect(other.defaultPrevented).toBeUndefined();
    const esc = { type: 'keydown', code: 'Escape', key: 'Escape' };
    doc.dispatch(esc);
    expect(ui.isOpen()).toBe(false);
    expect(esc.defaultPrevented).toBe(true);
    expect(root().classList.contains('hidden')).toBe(true);
    expect(doc.activeElement).toBe($('btn-sound-test'));
    expect(doc.listenerCount('keydown')).toBe(0); // it listens only while open
    // closed: keys are not its business
    expect(ui.handleKey({ code: 'Escape', key: 'Escape' })).toBe(false);
    ui.open();
    expect(ui.handleKey({ code: 'Escape', key: 'Escape', ctrlKey: true })).toBe(false);
    expect(ui.handleKey({ code: 'Escape', key: 'Escape', repeat: true, preventDefault() {} })).toBe(true); // held: swallowed, not acted on
    expect(ui.isOpen()).toBe(true);
    fire(root().querySelector('.snd-close'), 'click');
    expect(ui.isOpen()).toBe(false);
    ui.open();
    fire(root(), 'mousedown'); // the dimmed backdrop
    expect(ui.isOpen()).toBe(false);
    ui.open();
    fire(root().querySelector('.snd-panel'), 'mousedown'); // inside the panel: stays
    expect(ui.isOpen()).toBe(true);
  });

  it('the screens beneath are inert while it is open, and it lies over the title screen when opened there', () => {
    const { ui, $, root } = setup();
    expect(INERT_BENEATH).toEqual(['title-screen', 'pause-menu']);
    ui.open(); // index.html starts on the title screen
    expect(root().classList.contains('over-title')).toBe(true);
    for (const id of INERT_BENEATH) expect($(id).hasAttribute('inert'), id).toBe(true);
    ui.close();
    for (const id of INERT_BENEATH) expect($(id).hasAttribute('inert'), id).toBe(false);
    $('title-screen').classList.add('hidden');
    $('pause-menu').setAttribute('inert', ''); // someone else's (the confirm dialog): not ours to free
    ui.open();
    expect(root().classList.contains('over-title')).toBe(false);
    ui.close();
    expect($('pause-menu').hasAttribute('inert')).toBe(true);
  });

  it('says when the sound is muted and offers to turn it on', () => {
    const { ui, audio, root } = setup({ muted: true });
    ui.open();
    expect(root().querySelector('.snd-muted').textContent).toBe('Sound is muted.');
    const unmute = root().querySelector('.snd-unmute');
    expect(unmute.classList.contains('hidden')).toBe(false);
    fire(unmute, 'click');
    expect(audio.muted).toBe(false);
    expect(root().querySelector('.snd-muted').textContent).toBe('');
    expect(unmute.classList.contains('hidden')).toBe(true);
    const plain = setup();
    plain.ui.open();
    expect(plain.root().querySelector('.snd-unmute').classList.contains('hidden')).toBe(true);
  });

  it('dispose closes it, empties it and lets go of every listener; a broken audio player never throws out of a click', () => {
    const { ui, doc, $, root } = setup();
    ui.open();
    ui.dispose();
    expect(ui.isOpen()).toBe(false);
    expect(root().children).toHaveLength(0);
    expect(doc.listenerCount('keydown')).toBe(0);
    expect($('btn-sound-test').listenerCount('click')).toBe(0);
    expect($('btn-ambience').listenerCount('click')).toBe(0);
    ui.open();
    expect(ui.isOpen()).toBe(false);
    expect(() => ui.dispose()).not.toThrow();
    const bad = setup({ audio: { resume() { throw new Error('no'); }, playRecipe() { throw new Error('no'); }, playBreak() { throw new Error('no'); }, startLoop() { throw new Error('no'); } } });
    bad.ui.open();
    expect(() => fire(bad.button('Break', 'Stone'), 'click')).not.toThrow();
    expect(() => fire(bad.button('Cow'), 'click')).not.toThrow();
    expect(() => createSoundTest(null, recorder())).toThrow(TypeError);
  });
});

describe('the pause menu\'s Sound row (§82)', () => {
  it('sits between the physics Undo and Creatures: a label, the Ambience switch and the Sound Test button, both .hex-button', () => {
    const { $ } = setup();
    const row = $('pause-sound');
    const panel = row.parentNode;
    expect(row.classList.contains('physics-row')).toBe(true);
    expect(row.querySelector('.physics-label').textContent).toBe('Sound');
    expect(panel.children.indexOf(row)).toBe(panel.children.indexOf($('btn-undo-physics')) + 1);
    expect(panel.children.indexOf(row)).toBe(panel.children.indexOf($('pause-creatures')) - 1);
    expect(row.querySelectorAll('button').map((b) => b.id)).toEqual(['btn-ambience', 'btn-sound-test']);
    for (const id of ['btn-ambience', 'btn-sound-test']) {
      expect($(id).classList.contains('hex-button'), id).toBe(true);
      expect($(id).classList.contains('mc-button'), id).toBe(false);
      expect($(id).getAttribute('type'), id).toBe('button');
      expect($(id).children, id).toHaveLength(0); // words only
    }
    expect($('btn-sound-test').textContent).toBe('Sound Test');
  });

  it('the Ambience switch shows its state and reports each click; main applies and stores it', () => {
    const { $, onAmbience, ui } = setup();
    const b = $('btn-ambience');
    expect(b.textContent).toBe('Ambience: On');
    expect(b.getAttribute('aria-pressed')).toBe('true');
    fire(b, 'click');
    expect(b.textContent).toBe('Ambience: Off');
    expect(b.getAttribute('aria-pressed')).toBe('false');
    expect(onAmbience).toHaveBeenLastCalledWith(false);
    fire(b, 'click');
    expect(b.textContent).toBe('Ambience: On');
    expect(onAmbience).toHaveBeenLastCalledWith(true);
    expect(onAmbience).toHaveBeenCalledTimes(2);
    ui.setAmbience(false); // main can set it without a click (nothing is reported back)
    expect(b.textContent).toBe('Ambience: Off');
    expect(onAmbience).toHaveBeenCalledTimes(2);
    const off = setup({ ui: { ambienceOn: false } });
    expect(off.$('btn-ambience').textContent).toBe('Ambience: Off');
    expect(off.$('btn-ambience').getAttribute('aria-pressed')).toBe('false');
  });

  it('styles: over the pause menu, under the death screen, over the title screen; the module makes no Minecraft chrome', () => {
    const z = (sel) => Number(new RegExp(`${sel.replace(/[.#]/g, '\\$&')}\\{[^}]*z-index:(\\d+)`).exec(css)[1]);
    expect(z('#sound-test')).toBeGreaterThan(z('#pause-menu'));
    expect(z('#sound-test')).toBeLessThan(z('#death-screen'));
    expect(z('#sound-test.over-title')).toBeGreaterThan(z('#title-screen'));
    expect(css).toMatch(/\.snd-body\{[^}]*overflow-y:auto/); // a long list scrolls inside the panel
    expect(css).toMatch(/\.sound-button\[aria-pressed="false"\]\{/);
    const src = readFileSync(fileURLToPath(new URL('../../src/soundTest.js', import.meta.url)), 'utf8');
    expect(src.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')).not.toMatch(/mc-button|picker-panel|createElementNS|<svg|<img/);
  });

  it('?ui=sounds asks for the screen at once: no ?autoplay, no world, and it is not one of the screenshot aids', () => {
    expect(parseParams('?ui=sounds').soundTest).toBe(true);
    expect(parseParams('?ui=Sounds').soundTest).toBe(true);
    expect(parseParams('?ui=sounds').ui).toBeNull();
    expect(parseParams('?ui=pack').soundTest).toBe(false);
    expect(parseParams('?autoplay=1&ui=pack').ui).toBe('pack');
    expect(parseParams('').soundTest).toBe(false);
    expect(parseParams('?ui=sound').soundTest).toBe(false);
  });
});

describe('the screen on the game\'s real audio code (§82)', () => {
  it('every button makes sound without an error; a minute of pressing them all never clips', () => {
    vi.useRealTimers();
    const real = Math.random;
    Math.random = seededRandom(31);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const audio = createAudio({ AudioContextClass: OfflineContext });
      const doc = documentFromHTML(html);
      const ui = createSoundTest(/** @type {any} */ (doc), audio, { win: {}, random: seededRandom(4) }); // no timers: one take per press
      ui.open(); // wakes the audio
      const ctx = /** @type {any} */ (OfflineContext.last);
      expect(ctx).toBeTruthy();
      const buttons = /** @type {any} */ (doc.getElementById('sound-test')).querySelectorAll('.snd-btn').filter((b) => !b.classList.contains('snd-scene'));
      expect(buttons).toHaveLength(ITEMS.length);
      let peak = 0;
      for (const b of buttons) {
        const before = ctx.nodes.length;
        fire(b, 'click');
        expect(ctx.nodes.length, b.textContent).toBeGreaterThan(before);
        const m = measure(ctx.render(0.5));
        expect(m.peak, b.textContent).toBeGreaterThan(0.001);
        peak = Math.max(peak, m.peak);
      }
      expect(peak).toBeLessThan(0.95); // the loudest of the old sounds (the black-hole flash, the blast) are the top
      expect(warn).not.toHaveBeenCalled();
    } finally {
      Math.random = real;
    }
  });
});
