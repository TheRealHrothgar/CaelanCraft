// Caelancraft — main.js: boot, state machine and the game loop. See src/CONTRACTS.md §23.
//
// DOM glue. Nothing touches `window` / `document` at module top level: `boot()` runs only when both exist,
// so the module also imports cleanly under Node (the integration harness drives the pure modules directly).
//
// States: title → loading → clickToPlay → playing ⇄ paused, playing ⇄ picker.
// Every frame is one requestAnimationFrame callback: the simulation (input, physics, clock, streaming,
// raycast) runs only while `playing`; rendering, HUD and stats run in every state that has a player.
//
// v0.8 block physics (CONTRACTS §33–§38): one BlockPhysics per world. stepPlaying runs input & interaction → player
// → black holes → pigs → blockPhysics.step (tick, fallers, trees, lit barrels, blasts) → campfires → resolveBodies
// (player, pigs, lit barrels) → unstick player → runes → streaming; renderFrame syncs the falling-block renderer,
// the particles, the explosion light and the camera shake.
//
// v0.9 Survival (CONTRACTS §42–§49, docs/DESIGN-survival.md §9.5): one Survival, Pack, Containers, FireSlots, Regrowth,
// Tapped and CraftQueue per session, re-loaded from every save. "In Survival" (SV) is `survival.inSurvival`; "Survival
// active" (S) is `survival.active` (in Survival and alive) and gates every survival step. Three more states: PACK (the
// Pack & Making screen), BOOK (the rustic Handbook, §14) — the world keeps running under both — and DEAD (the death
// screen; nothing steps). Death is deferred: damage only sets `pendingDeath`, and `die()` runs at the frame's checkpoints
// (after black holes, after campfires, after the survival step, after the runes). A mode switch is queued
// (`pendingModeSwitch`) and applied at the top of the next frame, never inside a command, a hook or a step.
//
// v0.10 circuits, powder kegs and black holes v2 (CONTRACTS §50–§58, docs/DESIGN-circuits.md §6.6): one Circuits per world
// on the session's CircuitStore; right-click operates controls (Shift places) through the ControlLatch; the R key runs
// the part's own action, then a rune, then the pocket key, then the keg explanation (rKeyStep); a keg burns in place and a
// left-click snuffs it; a Collapsar Charge is set off by a fuse, a torch, an igniter, a campfire or a blast, and its hole
// flashes, implodes and forms a vortex that eats blocks (infall.js draws them spiralling in). One more state, DEVICE (the
// device panel): Creative freezes the world under it, Survival keeps stepping.
import {
  CHUNK_SIZE, RENDER_DISTANCE, LOADING_BUDGET_MS, REACH, BREAK_REPEAT_S, PLACE_REPEAT_S, MAX_FRAME_DT, FOV,
  SPRINT_FOV, START_TIME, AUTOSAVE_INTERVAL_S, HOTBAR_SIZE, VERSION, GAME_SECONDS_PER_DAY, PLAYER_HEIGHT,
  PIG_NATURAL_COUNT, CAMPFIRE_MODEL_RANGE, CAMPFIRE_MAX_MODELS, CAMPFIRE_CRACKLE_RANGE, CAMPFIRE_CRACKLES_PER_S,
  BLACK_HOLE_MAX_TRACKED, BLACK_HOLE_SWALLOW_LINE_S,
  PHYSICS_SOUND_RANGE, BOOM_SOUND_RANGE, SPLASH_MIN_INTERVAL_S, HISS_MIN_INTERVAL_S, FIZZLE_MIN_INTERVAL_S,
  ZOMBIE_HEIGHT, GEN_LATEST, PIG_MAX, LAMP_LIGHT_MIN, LAMP_LIGHT_MAX, CAMPFIRE_FUEL_START_S, CAMPFIRE_FUEL_MAX_S, ATTACK_REPEAT_S, GULP_GAP_S,
  PIG_REPOP_CHECK_S, PIG_REPOP_TARGET, PIG_REPOP_RADIUS, PIG_REPOP_MIN, PIG_REPOP_MAX, ZOMBIE_DAMAGE, FIRE_BURN_DAMAGE,
  FALL_SAFE_SPEED, INTRO_LINE_MS, PACK_MESSAGE_S,
  ZOMBIE_MAX, MAX_INFALL_MOBS, VORTEX_MODEL_RANGE, VORTEX_MAX_MODELS, VORTEX_MAX_CORES, VORTEX_PARTICLES_PER_S,
  VORTEX_PARTICLE_HOLES, CIRCUIT_DRAW_RANGE, CIRCUIT_OVERLAY_RANGE, BLACK_HOLE_SCREEN_FLASH_RANGE, BLACK_HOLE_SCREEN_FLASH_MAX,
  WORLD_HEIGHT,
} from './config.js';
import { inHeightRange, yawToForward } from './coords.js';
import { faceNeighbor, hexDiscCount, hexLength, hexToWorld, worldToHex } from './hex.js';
import {
  BLOCK, BIOME, DEFAULT_HOTBAR, getBlockDef, isBreakable, isPlaceable, isReplaceable, isSolid, isTargetable,
  isWaterSource, isWater, isMeshed, isLiquid, flintAt,
} from './blocks.js';
import { normalizeSeed } from './noise.js';
import { World } from './world.js';
import { raycastHex } from './raycast.js';
import {
  createPlayer, stepPlayer, getEyeHeight, playerIntersectsBlock, isFreeAt, findFreeY, supportingCells,
} from './physics.js';
import { advanceTime, computeSky, createSkyState, isDayTime, sunDirection } from './daynight.js';
import {
  SAVE_VERSION, listSlots, loadSlot, saveSlot, deleteSlot, renameSlot, duplicateSlot, migrateLegacySave, storageUsage,
  normalizeWorldName, defaultWorldName,
} from './storage.js';
import { createAtlasCanvas, createAtlasTexture, makeSunCanvas, makeMoonCanvas } from './atlas.js';
import { createRenderer, fogRangeForRenderDistance } from './renderer.js';
import { createControls } from './controls.js';
import { createHUD, createFlashState, flashStep } from './hud.js';
import { createMenus } from './menus.js';
import { createAudio } from './audio.js';
import {
  MoveSounds, Ambience, ANIMAL_VOICES as ANIMAL_SOUNDS, ambientCall, sampleSurroundings, loadAmbiencePref, saveAmbiencePref,
  FIRE_RANGE,
} from './worldSounds.js';
import { createSoundTest } from './soundTest.js';
import { RuneStore, RuneRunner, runeKey, SOURCE } from './runes.js';
import { BlackHoles, columnHasEdits, PHASE } from './blackholes.js';
import { Infall } from './infall.js';
import { createVortexRenderer } from './vortexRenderer.js';
import { CircuitStore, parsePartKey } from './circuitStore.js';
import { Circuits } from './circuits.js';
import { isControl, isIgnitable, isPart, partOf, partTip, inputFaceFromYaw, wavelengthOf } from './circuitParts.js';
import { wireSegments } from './circuitGeometry.js';
import { createCircuitRenderer } from './circuitRenderer.js';
import { createDevicePanel } from './devicePanel.js';
import { Pigs } from './pigs.js';
import { resolveBodies, detachBody } from './bodies.js';
import { Campfires, scorchPlayer, wouldDouseCampfire } from './campfires.js';
import { createCampfireRenderer } from './campfireRenderer.js';
import { createPigRenderer } from './pigRenderer.js';
import { Animals, SPECIES, SADDLE_Y, WOLF_BITE, TRAP_HOLD_S, ANIMAL_MAX, BEAR_DAMAGE } from './animals.js';
import { createAnimalRenderer } from './animalRenderer.js';
import { Zombies, zombieVolume as zombieVolumeFor, loudestVolume, openSky, statsOf, damageOf, SOUND_ROAR } from './zombies.js';
import { Survival, deathTitle, BELONGINGS_KEPT, BELONGINGS_LOST, SICK_MESSAGE, BOIL_TIP } from './survival.js';
import { Pack, slotClick, returnCursor, isKept, KEEP_REFUSED } from './inventory.js';
import { Containers } from './containers.js';
import {
  breakSeconds, rollDrops, harvestHint, handGatherHint, canHarvest, pick, Tapped, Regrowth, rollMobDrops, ripeOf, isDeep,
} from './harvest.js';
import {
  DigState, UseState, interactKind, chooseBelongingsCell, buildPackView, useActionOf, placeRefusal, strikeKind, handKeyOf,
  wearsFromDigging, wearsFromStriking, HINT, KNIFE_TIER, waterKind, waterHint, WATER_POTS,
} from './survivalControl.js';
import { waterQualityAt } from './fluids.js';
import { CraftQueue, findStations, listRecipes } from './crafting.js';
import { FireSlots, fireHint, isSkewerFood, isCentrePot } from './cooking.js';
import { heatSource, heatAt, groundChillOf, isSaltyBiome, bodyTarget, CHEST_HEIGHT, HEAT_SOURCES } from './climate.js';
import { softLandingFactor, knockDamage, crushDamage } from './vitals.js';
import { getItem, itemName, itemForBlock, maxDurability } from './items.js';
import { createPackUI, demoPackView } from './packUI.js';
import { createItemIcons, iconBlockFor } from './itemIcons.js';
import { createLooseItemRenderer } from './looseItemRenderer.js';
import {
  LooseItems, throwOf, dartBreakP, DROP_SPEED, SOUND_THROW, SOUND_PICKUP, SOUND_THUNK, LOOSE_BLOCK_SCALE,
  blinkHidden,
} from './looseItems.js';
import { createZombieRenderer } from './zombieRenderer.js';
import { Watcher, WATCHER_HEIGHT } from './watcher.js';
import { createWatcherRenderer } from './watcherRenderer.js';
import { BlockPhysics } from './blockphysics.js';
import { createFallingRenderer } from './fallingRenderer.js';
import { createParticles } from './particles.js';
import { createConsole } from './console.js';
import { createRuneEditor } from './runeEditor.js';
import { HANDBOOK_KEY, HANDBOOK_CHAT_LINE, buildChapters, ensureHandbook } from './handbook.js';
import { createHandbookUI } from './handbookUI.js';
import {
  parseParams, installErrorCapture, installDebugHandle, updateDebugHandle, buildDebugText, runSmokeTest, circuitSceneWrites,
  CIRCUIT_SCENE_ROWS, SCENE_ROW_GAP,
} from './diagnostics.js';

/** @typedef {import('./types.js').PlayerState} PlayerState */
/** @typedef {import('./types.js').RaycastHit} RaycastHit */
/** @typedef {import('./types.js').SaveData} SaveData */
/** @typedef {import('./types.js').GameContext} GameContext */
/** @typedef {import('./types.js').ItemStack} ItemStack */

/** The Survival Handbook's item key (§14.4; handbook.js owns it, re-exported for the tests and drivers). */
export { HANDBOOK_KEY };

// ---------------------------------------------------------------------------------------------
// Constants (main-only tuning; everything shared lives in config.js)
// ---------------------------------------------------------------------------------------------

export const STATE = Object.freeze({
  TITLE: 'title',
  LOADING: 'loading',
  CLICK_TO_PLAY: 'clickToPlay',
  PLAYING: 'playing',
  PAUSED: 'paused',
  PICKER: 'picker',
  CONSOLE: 'console',
  EDITOR: 'editor',
  // v0.9 Survival (§49): the Pack & Making screen and the rustic Handbook keep the world running; the death screen does not.
  PACK: 'pack',
  BOOK: 'book',
  DEAD: 'dead',
  // v0.10 circuits (§57): the device panel. Creative freezes the world under it (as the rune editor does); Survival keeps
  // it running (as PACK does), so the panel is never a pause button.
  DEVICE: 'device',
});

/** Loading progress is reported over the hex disc of chunks within distance 2 of the spawn chunk (19 chunks). */
export const LOADING_RADIUS = 2;
export const LOADING_TOTAL = hexDiscCount(LOADING_RADIUS); // 19
/** KeyboardEvent.code of the hotbar keys, index = slot (precomputed: the loop runs every frame). */
const DIGIT_CODES = Object.freeze(Array.from({ length: HOTBAR_SIZE }, (_, i) => `Digit${i + 1}`));
/** Frames after which loading proceeds even if a chunk of the loading disc could not be meshed (never expected). */
const LOADING_MAX_FRAMES = 1800;
/** Sprint FOV eases 70 → 80 over this many seconds (SPEC-gameplay §4). */
export const FOV_EASE_S = 0.15;
/** Stats / debug handle refresh period. */
const STATS_INTERVAL_S = 0.25;
/** Player movement (blocks) that counts as "moved" for the autosave rule. */
const AUTOSAVE_MOVE_EPS = 1e-3;
const CANVAS_ID = 'game-canvas';
/** After closing a modal, pointer lock must be back within this long or the click-to-play overlay is shown. */
const RELOCK_CHECK_MS = 300;
/** Physics sound names (PhysicsHooks.sound) → Audio method. Missing methods are silently skipped. */
const PHYSICS_SOUND_METHODS = Object.freeze({
  thud: 'playThud', splash: 'playSplash', boom: 'playBoom', hiss: 'playHiss', creak: 'playCreak', fizzle: 'playFizzle',
  crackle: 'playCrackle',
});
/** Minimum seconds between two physics sounds of the same name. */
const PHYSICS_SOUND_GAP_S = Object.freeze({ splash: SPLASH_MIN_INTERVAL_S, hiss: HISS_MIN_INTERVAL_S, fizzle: FIZZLE_MIN_INTERVAL_S });
/** The one-time chat line for a world saved before block physics existed (collapse starts off for it). */
export const OLD_WORLD_PHYSICS_NOTE = 'New: block physics! Collapse is off for this older world — turn it on in Esc → Physics';
/** The red screen-edge flash after a zombie's strike fades out over this long (s, §39). */
const HURT_FLASH_S = 0.45;
/** WATER selected: the crosshair also stops on water sources (left-click removes one). */
const hitTargetOrWaterSource = (id) => isTargetable(id) || isWaterSource(id);

// ---- Survival (v0.9, CONTRACTS §49) ----
/** The survival `waterHit` ray stops at any water cell (§4.2: R drinks or fills from it). */
const hitTargetOrWater = (id) => isTargetable(id) || isWater(id);
/** The climate and the nearby workplaces are sampled this often (s, §3.1, §7.1). */
export const CLIMATE_SAMPLE_S = 0.5;
/** Feet below this height: death by `void` (§2.4); the belongings are lost. */
export const VOID_Y = -32;
/** At most one fire scorch per this many seconds (§2.4). */
export const FIRE_SCORCH_GAP_S = 0.5;
/** At most one hurt sound per this many seconds (§2.4). */
export const HURT_SOUND_GAP_S = 0.3;
/** Holding R repeats a put, a feed or a gulp this often (§4.4). */
export const R_REPEAT_S = 0.25;
/** A burning campfire within this many cells of the feet doubles regeneration while standing still (§2.3). */
export const NEAR_FIRE_CELLS = 4;
/** Biomes where a new survival state also points the way to green land (§1.2). */
export const HARSH_BIOMES = Object.freeze([BIOME.DESERT, BIOME.SNOWY, BIOME.MOUNTAINS, BIOME.SNOWY_PEAKS]);
/** Ground a repopulating pig may spawn on in Survival (§4.3). */
export const SURVIVAL_PIG_GROUND = Object.freeze([BLOCK.GRASS_BLOCK, BLOCK.SNOWY_GRASS]);
/** The §1.2 chat line for a new survival state, and the Handbook's addition (§14.2). */
export const SURVIVAL_INTRO = 'Survival: you carry nothing. Loose stones give rock and flint, fallen branches give sticks, '
  + 'tussock gives fibre. Drink fresh water with R.';
export const HANDBOOK_INTRO = HANDBOOK_CHAT_LINE;
export const UPGRADED_NOTE = 'Survival resources have come to this world.';
export const MODE_PARAM_IGNORED = '?mode=survival ignored: this older world needs the in-game upgrade (Esc → Mode)';
export const SURVIVAL_NEEDS_GEN2 = 'mode: survival needs generation 2; loaded in Creative';
/** The pause menu's upgrade question (§1.3). */
export const UPGRADE_CONFIRM = Object.freeze({
  title: 'Bring survival resources into this world?',
  detail: 'Copper, tin, clay, wild plants, ponds and new trees will appear wherever the land is untouched — near your builds too. '
    + 'This cannot be undone.',
  yes: 'Bring them',
  no: 'Cancel',
});
/** States in which the world steps (§9.5: PLAYING, and PACK / BOOK with the controls disabled). */
const SIMULATING_STATES = new Set([STATE.PLAYING, STATE.PACK, STATE.BOOK]);
/** States in which a queued mode switch is applied (§1.1: playing or paused; an open console or editor is closed first). */
const MODE_SWITCH_STATES = new Set([STATE.PLAYING, STATE.PAUSED, STATE.CONSOLE, STATE.EDITOR]);

/**
 * @param {string} state
 * @param {boolean} [inSurvival]  the device panel (STATE.DEVICE) runs the world only in Survival (CONTRACTS §57)
 * @returns {boolean} the world steps in this state (§9.5)
 */
export function stateSimulates(state, inSurvival = false) {
  if (state === STATE.DEVICE) return Boolean(inSurvival);
  return SIMULATING_STATES.has(state);
}

/**
 * The screen die() closes first (§2.5 step 1, CONTRACTS §57): every state but PLAYING in which Survival's world keeps
 * stepping is a screen open over a world that can kill the player — the pack screen, the field book and the device panel.
 * Leaving one open over the death screen strands it: after Wake up its close paths no longer apply, and the device panel's
 * key capture swallows every key.
 * @param {string} state
 * @returns {'pack'|'book'|'device'|null}
 */
export function screenClosedOnDeath(state) {
  if (state === STATE.PACK) return 'pack';
  if (state === STATE.BOOK) return 'book';
  if (state === STATE.DEVICE) return 'device';
  return null;
}

/**
 * The generator version a loading world gets (§1.3, §9.5): a save's `gen` (absent → 1); a new world GEN_LATEST unless the
 * New World form's "Survival resources" box was cleared.
 * @param {SaveData|null} restoring
 * @param {{ survivalResources?: boolean }} [opts]
 * @returns {number}
 */
export function loadingGen(restoring, opts) {
  if (restoring) return Number.isInteger(restoring.gen) && restoring.gen >= 1 ? restoring.gen : 1;
  return opts && opts.survivalResources === false ? 1 : GEN_LATEST;
}

/**
 * The mode a loading world starts in (§1.3): the save's `mode` (absent → Creative), but Creative with a warning when it says
 * Survival on a world below generation 2 (only possible by hand-editing; the pause menu then offers the upgrade).
 * @param {SaveData|null} restoring
 * @param {number} gen
 * @returns {{ mode: 'creative'|'survival', warning: string|null }}
 */
export function loadingMode(restoring, gen) {
  const mode = restoring && restoring.mode === 'survival' ? 'survival' : 'creative';
  if (mode === 'survival' && !(gen >= 2)) return { mode: 'creative', warning: SURVIVAL_NEEDS_GEN2 };
  return { mode, warning: null };
}

/**
 * What `?mode=` does to the first world the page loads (§1.1). Creative always applies. Survival applies to a new slot (it is
 * generated with GEN_LATEST), to any world under ?nosave (its generation may be raised: nothing is saved) and to a world
 * already at generation 2; an older saved world is loaded as it is, with the MODE_PARAM_IGNORED warning.
 * @param {'creative'|'survival'|null} mode
 * @param {{ save: SaveData|null, nosave: boolean }} ctx  `save`: the slot's save being restored (null: a new world)
 * @returns {{ apply: boolean, raiseGen: boolean, warning: string|null }}
 */
export function modeParamPlan(mode, ctx) {
  if (mode !== 'creative' && mode !== 'survival') return { apply: false, raiseGen: false, warning: null };
  if (mode === 'creative' || !ctx.save) return { apply: true, raiseGen: false, warning: null };
  const gen = loadingGen(ctx.save);
  if (gen >= 2) return { apply: true, raiseGen: false, warning: null };
  if (ctx.nosave) return { apply: true, raiseGen: true, warning: null };
  return { apply: false, raiseGen: false, warning: MODE_PARAM_IGNORED };
}

/**
 * Use up `?mode=` (§1.1: the first world only): its value, and `params.mode` is null from then on.
 * @param {{ mode?: 'creative'|'survival'|null }} params
 * @returns {'creative'|'survival'|null}
 */
export function consumeModeParam(params) {
  const mode = params.mode === 'creative' || params.mode === 'survival' ? params.mode : null;
  params.mode = null;
  return mode;
}

/**
 * Where a world goes once loaded (§2.5 step 6): a save left on the death screen goes back to it — never to click-to-play
 * (z 35, above the death screen) or straight to play; else playing with ?autoplay / ?smoke, otherwise click-to-play.
 * @param {{ dead: boolean, autoplay: boolean }} s
 * @returns {string} a STATE value
 */
export function stateAfterLoading(s) {
  if (s.dead) return STATE.DEAD;
  return s.autoplay ? STATE.PLAYING : STATE.CLICK_TO_PLAY;
}

/**
 * The pause menu's Physics row and Undo button (menus.PhysicsMenuState): in Survival Undo is disabled (§1.5).
 * @param {{ exportSwitches(): any, canUndo: boolean, lastEvent: {kind: string}|null }|null} blockPhysics
 * @param {boolean} inSurvival
 */
export function physicsMenuStateFor(blockPhysics, inSurvival) {
  if (!blockPhysics) return null;
  return {
    switches: blockPhysics.exportSwitches(),
    canUndo: blockPhysics.canUndo,
    undoKind: blockPhysics.lastEvent ? blockPhysics.lastEvent.kind : undefined,
    survival: Boolean(inSurvival),
  };
}

/**
 * The four survival save fields (§1.4, §9.5 buildSaveData). A world that never entered Survival writes none of them, so its
 * save stays version 2 and byte-identical to before.
 * @param {{ gen: number, survival: Survival, pack: Pack, fireSlots: FireSlots, containers: Containers, loose?: LooseItems }} s
 * @returns {{ gen?: number, mode?: 'creative'|'survival', survival?: object, containers?: object }}
 */
export function survivalSaveFields(s) {
  /** @type {*} */
  const out = {};
  if (s.gen >= 2) out.gen = s.gen;
  if (s.survival.hasState) {
    out.mode = s.survival.mode;
    out.survival = { ...s.survival.export(), ...s.pack.export(), fires: s.fireSlots.export() };
    // v0.10 (§60): the items lying loose in the world, only when there are any
    const loose = s.loose ? s.loose.serialize() : [];
    if (loose.length > 0) out.survival.loose = loose;
  }
  if (s.containers.size > 0) out.containers = s.containers.export();
  return out;
}

/**
 * The death screen's three lines (§2.5). `cell` is where the belongings were left (null: lost); `carried` is false when there
 * was nothing to leave.
 * @param {string} cause
 * @param {[number, number, number]|null} cell
 * @param {boolean} [carried=true]
 * @returns {{ title: string, detail: string, where: string }}
 */
export function deathScreenText(cause, cell, carried = true) {
  const title = deathTitle(cause);
  if (!carried) return { title, detail: 'You carried nothing.', where: '' };
  if (!cell) return { title, detail: BELONGINGS_LOST, where: '' };
  return { title, detail: BELONGINGS_KEPT, where: `Your belongings lie at q ${cell[0]}, r ${cell[2]}, height ${cell[1]}.` };
}

/** A knock on the player is a blast when an explosion went off during the physics step, else a toppled log (§2.4). */
export function knockCause(blastsBefore, blastsAfter) {
  return blastsAfter !== blastsBefore ? 'blast' : 'log';
}

/**
 * The cold fire pit's crosshair hint (§4.4, §9.5): `pit_take` offers what is on it; `pit_relight` and `pit_hint` carry their own
 * hint from `interactKind` (`HINT.pit`, or what the relight still lacks: `Cold Fire Pit · relight needs 1 more stick`).
 * @param {import('./survivalControl.js').InteractAction} act
 * @param {string} status what the pit holds (`fireHint`), '' when nothing
 */
export function pitHintText(act, status) {
  if (act.kind === 'pit_take') return `Cold Fire Pit${status ? ` · ${status}` : ''} · R: take`;
  return act.hint || HINT.pit;
}

/** Whole cells unstickPlayer lifted the player (crush damage, §2.4): at least 1 for any lift. */
export function cellsLifted(fromY, toY) {
  return Math.max(1, Math.ceil(toY - fromY - 1e-6));
}

/** "2 Rock and 1 Flint" for stacks. @param {ReadonlyArray<{k: string, n: number}>} stacks */
export function stacksText(stacks) {
  const parts = stacks.map((s) => `${s.n} ${itemName(s.k, s.n)}`);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "Pack full: 2 Rock left behind" (§5.3). */
export function leftBehindText(stacks) {
  return `Pack full: ${stacksText(stacks)} left behind`;
}

/**
 * "1 Raw Pork went bad.", "1 Honeyberry went bad." (§4.5; items.SINGULAR_NAMES). v0.14 (§76 water): an item that spoils INTO
 * another (`food.spoilsTo`: a Pot of Water left standing) says what it became — "1 Pot of Water stood too long: now Pot of
 * Tainted Water." — after the plain line when both happened in the same second.
 */
export function spoiledText(stacks) {
  const gone = stacks.filter((s) => !getItem(s.k)?.food?.spoilsTo);
  const lines = gone.length > 0 ? [`${stacksText(gone)} went bad.`] : [];
  for (const s of stacks) {
    const to = getItem(s.k)?.food?.spoilsTo;
    if (to) lines.push(`${stacksText([s])} stood too long: now ${itemName(to, s.n)}.`);
  }
  return lines.join(' ');
}

/** The `pack list` text (§9.7): one line per non-empty slot, "3: Flint Pick (51/90)", then the worn items. */
export function packListText(pack) {
  const lines = [];
  const line = (label, s) => {
    const max = maxDurability(s.k);
    const wear = max ? ` (${s.d ?? max}/${max})` : '';
    lines.push(`${label}: ${s.n > 1 ? `${s.n} ` : ''}${itemName(s.k)}${wear}`);
  };
  pack.slots.forEach((s, i) => { if (s) line(String(i + 1), s); });
  const wearNames = ['head', 'body', 'feet'];
  pack.wear.forEach((s, i) => { if (s) line(`worn on ${wearNames[i]}`, s); });
  return lines.join('\n');
}

/**
 * The console's `pack add <item> [count]` (§9.7): stacks in one piece, tools one at a time (they never stack), and the
 * Handbook (§14.2: a second copy cannot be made) only when the pack has none — through `ensureHandbook`, so it lands in the
 * last hotbar slot. Pure: used by main's CommandContext.survival and tested directly.
 * @param {Pack} pack
 * @param {string} key  an item key (resolved by commands.js)
 * @param {number} n    1..PACK_ADD_MAX
 * @returns {ItemStack[]|{ n: number, refused: string }|null} what did not fit (null when everything fit); `refused` when nothing
 *   was added on purpose
 */
export function consolePackAdd(pack, key, n) {
  let left = Math.floor(n);
  if (key === HANDBOOK_KEY) {
    if (left > 1) return { n: left, refused: 'one handbook is enough' };
    if (ensureHandbook(pack)) return null;
    const has = (/** @type {ItemStack|null} */ s) => !!s && s.k === HANDBOOK_KEY;
    return { n: left, refused: pack.slots.some(has) || pack.wear.some(has) ? 'the pack already has a handbook' : 'the pack is full' };
  }
  /** @type {ItemStack[]} */
  const over = [];
  while (left > 0) {
    const part = getItem(key)?.tool ? 1 : left;
    const o = pack.add({ k: key, n: part });
    left -= part;
    if (o) over.push(o);
  }
  return over.length ? over : null;
}

/** The console's `pack clear` (§9.7): everything out, then the Handbook back in its slot (§14.2). @param {Pack} pack */
export function consolePackClear(pack) {
  pack.clear();
  ensureHandbook(pack);
}

/**
 * The §1.2 chat lines for a survival state that has just begun: the intro (plus the Handbook's sentence when one was given)
 * and, in a harsh biome, where green land lies.
 * @param {number} biome  the feet column's biome
 * @param {[number, number]|null} green  the [q, r] of world.findSurvivalSpawn()
 * @param {boolean} handbookGiven
 * @returns {string[]}
 */
export function survivalIntroLines(biome, green, handbookGiven) {
  const lines = [handbookGiven ? `${SURVIVAL_INTRO} ${HANDBOOK_INTRO}` : SURVIVAL_INTRO];
  if (HARSH_BIOMES.includes(biome) && green) lines.push(`This land is harsh: green land lies near q ${green[0]}, r ${green[1]}.`);
  return lines;
}

/**
 * What the climate sees where the player stands (§3.1): the feet column's biome and climate noise, open sky over the eye
 * (zombies.openSky: leaves and glass count as cover), underground (no open sky and the column's surface ≥ 4 cells above the
 * eye cell) and the ground chill of the cell under the feet. Heat and nearFire are filled in by main.
 * @param {{ columnAt(q: number, r: number): {height: number, biome: number, temperature: number}, getBlock: Function }} world
 * @param {PlayerState} player
 * @param {(getBlock: Function, q: number, y: number, r: number) => boolean} [openSkyFn]
 * @returns {{ biome: number, climateT: number, openSky: boolean, underground: boolean, groundChill: number, heat: number,
 *   nearFire: boolean }}
 */
export function sampleClimate(world, player, openSkyFn = openSky) {
  const [q, r] = worldToHex(player.x, player.z);
  const col = world.columnAt(q, r);
  const eyeY = player.y + getEyeHeight(player);
  const sky = openSkyFn(world.getBlock, q, Math.ceil(eyeY), r);
  const underground = !sky && col.height >= Math.floor(eyeY) + 4;
  const ground = world.getBlock(q, Math.floor(player.y - 1e-3), r);
  return {
    biome: col.biome,
    climateT: col.temperature,
    openSky: sky,
    underground,
    groundChill: groundChillOf(ground),
    heat: 0,
    nearFire: false,
  };
}

/**
 * Project a world point to window pixels with a three.js camera's matrices (last render), for the pickup tokens (§9.8).
 * @returns {{x: number, y: number}|null} null behind the camera or without matrices
 */
export function projectToScreen(camera, x, y, z, width, height) {
  const vi = camera && camera.matrixWorldInverse ? camera.matrixWorldInverse.elements : null;
  const p = camera && camera.projectionMatrix ? camera.projectionMatrix.elements : null;
  if (!vi || !p || !Number.isFinite(x + y + z)) return null;
  const vx = vi[0] * x + vi[4] * y + vi[8] * z + vi[12];
  const vy = vi[1] * x + vi[5] * y + vi[9] * z + vi[13];
  const vz = vi[2] * x + vi[6] * y + vi[10] * z + vi[14];
  const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12];
  const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13];
  const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
  if (!(cw > 1e-6)) return null;
  return { x: ((cx / cw + 1) / 2) * width, y: ((1 - cy / cw) / 2) * height };
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers (exported for tests / reuse)
// ---------------------------------------------------------------------------------------------

/**
 * Seed for a new world: empty → random 31-bit integer, otherwise normalizeSeed(trimmed text).
 * @param {string|null|undefined} text
 * @param {() => number} [random]  [0,1) source (Math.random by default; injectable for tests)
 * @returns {number} uint32
 */
export function seedFromInput(text, random = Math.random) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed === '') return Math.floor(random() * 2 ** 31);
  return normalizeSeed(trimmed);
}

/**
 * The red toast for a save that failed (§41): storage.saveSlot's `reason` → text. A full storage asks for a world to be
 * deleted (all six slots share the browser's ~5 MB); the slot's previous save is untouched either way.
 * @param {string|undefined} reason
 */
/**
 * The title screen's line after quitting a world whose save failed (§41): why, and whether an older save of it is
 * still there (`hasSave`: the slot held a save before this session's failure).
 * @param {string} name @param {string|undefined} reason  storage.saveSlot's reason @param {boolean} hasSave
 */
export function quitUnsavedMessage(name, reason, hasSave) {
  const kept = hasSave ? ' Its last save is kept.' : ' It had never been saved, so it is gone.';
  if (reason === 'quota') return `“${name}” was not saved: storage is full.${kept} Delete a world to make room.`;
  if (reason === 'unavailable') return `“${name}” was not saved: this browser is not letting the game store anything.${kept}`;
  return `“${name}” was not saved.${kept}`;
}

export function saveFailMessage(reason) {
  if (reason === 'quota') return 'Save failed: storage full — delete a world on the Worlds screen to make room';
  if (reason === 'unavailable') return 'Save failed: this browser is not letting the game store anything';
  return 'Save failed';
}

/**
 * The Worlds-screen status line after a failed Rename / Duplicate (storage.SlotResult `reason`).
 * @param {'rename'|'duplicate'} action @param {string|undefined} reason
 */
export function worldsFailMessage(action, reason) {
  if (reason === 'quota') {
    return action === 'duplicate'
      ? 'Not enough storage to copy this world — delete a world first'
      : 'Not enough storage to rename this world — delete a world first';
  }
  if (reason === 'full') return 'No empty slot to copy into — delete a world first';
  if (reason === 'damaged') return 'That world is damaged and cannot be changed';
  if (reason === 'empty') return 'That slot is empty now';
  return action === 'duplicate' ? 'Could not copy the world' : 'Could not rename the world';
}

/**
 * Hotbar slot after `notches` wheel steps (+1 = scrolled down = next slot), wrapping.
 * @param {number} selected @param {number} notches
 */
export function wheelSlot(selected, notches) {
  const n = HOTBAR_SIZE;
  return ((((selected + notches) % n) + n) % n);
}

/**
 * Chunks the loading screen waits for: the hex disc of radius LOADING_RADIUS around the spawn chunk, shrunk
 * to the render ring when ?rd= is smaller (chunks outside the render distance are never meshed, so they
 * could never count as done).
 * @param {number} renderDistance
 * @returns {{ radius: number, total: number }}
 */
export function loadingRing(renderDistance) {
  const radius = Math.max(0, Math.min(LOADING_RADIUS, Math.floor(renderDistance)));
  return { radius, total: hexDiscCount(radius) };
}

/**
 * Move `fov` toward `target` at the sprint easing rate.
 * @param {number} fov @param {number} target @param {number} dt
 */
export function easeFov(fov, target, dt) {
  const rate = Math.abs(SPRINT_FOV - FOV) / FOV_EASE_S;
  const maxStep = rate * Math.max(0, dt);
  const diff = target - fov;
  if (Math.abs(diff) <= maxStep) return target;
  return fov + Math.sign(diff) * maxStep;
}

/**
 * @returns {number[]} a valid 9-slot hotbar copy (falls back to DEFAULT_HOTBAR). v0.10 (DESIGN-circuits §2.10): a slot holding
 * BLACK_HOLE (66, no longer placeable) holds COLLAPSAR_CHARGE.
 */
export function hotbarFrom(list) {
  if (Array.isArray(list) && list.length === HOTBAR_SIZE && list.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
    return list.map((v) => (v === BLOCK.BLACK_HOLE ? BLOCK.COLLAPSAR_CHARGE : v));
  }
  return DEFAULT_HOTBAR.slice();
}

/** @returns {number} a valid slot index (0..8) or 0 */
function slotFrom(v) {
  return Number.isInteger(v) && v >= 0 && v < HOTBAR_SIZE ? v : 0;
}

/** Wrap a day fraction into [0,1); non-finite → START_TIME. */
function wrapTime(t) {
  if (!Number.isFinite(t)) return START_TIME;
  return t - Math.floor(t);
}

// ---------------------------------------------------------------------------------------------
// Circuits, powder kegs and black holes v2 (v0.10, CONTRACTS §55, §58, docs/DESIGN-circuits.md §4.9, §6.6): the pure parts of
// main's wiring, exported so the harness and tests/integration/circuits.test.js run main's own rules and hooks.
// ---------------------------------------------------------------------------------------------

/** The R key on a keg with no Spark Transmitter selected (§3.3): said at most once per KEG_EXPLAIN_GAP_S. */
export const KEG_EXPLAIN = 'Powder kegs need a flame: lay a Powder Fuse to it and light that with the R key, or wire an Igniter. '
  + 'Shift+R key on a part tells you more.';
/** The same for a Collapsar Charge (the design gives the keg's line for both; a charge also answers to the radio). */
export const CHARGE_EXPLAIN = 'A Collapsar Charge is set off from afar: lay a Powder Fuse to it and light that with the R key, '
  + 'wire an Igniter, or send a wave to a Coherer Receiver. Shift+R key on a part tells you more.';
export const KEG_EXPLAIN_GAP_S = 4;
/** The Creative swallow's chat line (§2.7), throttled by BLACK_HOLE_SWALLOW_LINE_S. */
export const SWALLOWED_LINE = 'You were swallowed by a black hole!';
/** Seconds between two device-panel refreshes while the world runs under it (Survival, §4.10). */
export const DEVICE_REFRESH_S = 0.25;
/** The wiring is rebuilt when the circuits' geometryVersion changes or the eye moved this far since the last build (§6.6). */
export const CIRCUIT_REBUILD_MOVE = 16;
/** Burnt-out fuse cells alone (circuits.burnVersion) rebuild the wiring at most this often (s); their chars cover the cords. */
export const FUSE_REBUILD_S = 1;

/**
 * Is a wiring rebuild due this frame (§6.6)? A part added or removed (circuits.geometryVersion) or the eye moving
 * CIRCUIT_REBUILD_MOVE rebuilds at once; fuse cells that burnt out (circuits.burnVersion) at most every FUSE_REBUILD_S —
 * a rebuild near a big wired area costs 10–20 ms, and a fuse burns out a cell every 0.4 s (a fuse fill dozens a tick).
 * @param {{ geometry: number, burn: number, at: number }} built  the versions and the time of the last build
 * @param {number} geometryVersion @param {number} burnVersion @param {boolean} moved @param {number} t  seconds
 * @returns {boolean}
 */
export function wiringRebuildDue(built, geometryVersion, burnVersion, moved, t) {
  if (moved || geometryVersion !== built.geometry) return true;
  return burnVersion !== built.burn && !(t - built.at < FUSE_REBUILD_S);
}
/** Black-hole events of one type that get sound, flash and particles in one frame, nearest first (§6.6 step 7). */
export const BH_EVENTS_PER_TYPE = 4;
/** The drone plays for the nearest vortex within this many units (§2.11). */
export const DRONE_RANGE = 24;
/** Vortices within this many units of the eye stream particles (§2.4.5). */
export const VORTEX_PARTICLE_RANGE = 48;
/** The void flash of a Creative swallow (§2.7). */
export const VOID_FLASH_LEVEL = 0.75;

/**
 * The R key acts on this part by itself (§4.9 step 1): the controls, the Relay's armature, the Coherer's tapper and the
 * Powder Fuse. Kegs and charges have no R action (the R key explains them, or sends the pocket key).
 * @param {number} id
 */
export function hasRAction(id) {
  return isControl(id) || id === BLOCK.RELAY || id === BLOCK.COHERER_RECEIVER || id === BLOCK.POWDER_FUSE;
}

/**
 * The Powder Keg's crosshair hint (§3.3).
 * @param {boolean} explosionsOn  block physics exists and its explosions switch is on
 * @param {boolean} burning        it burns in place (explosions.isBurning)
 */
export function kegHintText(explosionsOn, burning) {
  if (!explosionsOn) return 'Powder Keg (explosions are off)';
  return burning ? 'Powder Keg · burning! left-click: pinch out the fuse' : 'Powder Keg · light it with a fuse, a torch or an igniter';
}

/**
 * The R key in Creative (§4.9), in order: (1) the targeted part's own R action (circuits.interact 'r' — it ACTS when it
 * returns a result); (2) a Rune Block; (3) the pocket key when the selected slot holds a Spark Transmitter, whatever else is
 * targeted (a keg or a charge included: sending at the keg you want to set off is the point of a remote); (4) a keg or a
 * charge: the explanation. Survival runs the same steps through survivalControl.interactKind's `circuit` and `pocket` kinds.
 * @param {RaycastHit|null} h
 * @param {{ circuits: { interact(q: number, y: number, r: number, via: 'r'|'use'): *}|null, pocketSelected: boolean }} env
 * @returns {{ kind: 'part', res: { ok: boolean, message?: string, channel?: number } }|{ kind: 'rune'|'pocket'|'explain' }|null}
 */
export function rKeyStep(h, env) {
  if (h && env.circuits) {
    const res = env.circuits.interact(h.q, h.y, h.r, 'r');
    if (res) return { kind: 'part', res };
  }
  if (h && h.blockId === BLOCK.RUNE_BLOCK) return { kind: 'rune' };
  if (env.pocketSelected) return { kind: 'pocket' };
  if (h && (h.blockId === BLOCK.POWDER_KEG || h.blockId === BLOCK.COLLAPSAR_CHARGE)) return { kind: 'explain' };
  return null;
}

/**
 * The R key's explanation on a keg or a charge (§3.3): its line, or null while the last one (at `lastAt`) is younger than
 * KEG_EXPLAIN_GAP_S. Times in seconds.
 * @param {number} id  BLOCK.POWDER_KEG or BLOCK.COLLAPSAR_CHARGE
 */
export function explainLine(id, lastAt, now) {
  if (now - lastAt < KEG_EXPLAIN_GAP_S) return null;
  return id === BLOCK.COLLAPSAR_CHARGE ? CHARGE_EXPLAIN : KEG_EXPLAIN;
}

/**
 * A left-click (or a Survival left press) on this hit pinches a keg's fuse out instead of breaking it (§3.2): a Powder Keg
 * burning in place.
 * @param {RaycastHit|null} h
 * @param {{ isBurning(q: number, y: number, r: number): boolean }|null|undefined} explosions
 */
export function snuffsKeg(h, explosions) {
  return !!h && h.blockId === BLOCK.POWDER_KEG && !!explosions && explosions.isBurning(h.q, h.y, h.r);
}

/**
 * The hint for a Powder Keg burning in place under the crosshair, or null. Survival shows it BEFORE any tool requirement:
 * a keg lit by a campfire or `ignite` must say how to put it out, not which axe would break it (the snuff needs no tool).
 * @param {RaycastHit|null} h
 * @param {{ isBurning(q: number, y: number, r: number): boolean }|null|undefined} explosions
 * @returns {string|null}
 */
export function burningKegHint(h, explosions) {
  return snuffsKeg(h, explosions) ? kegHintText(true, true) : null;
}

/**
 * The device panel's part changed under it (a blast, a vortex, a setblock): main closes the panel (§4.10).
 * @param {string|null} deviceKey  the panel's "q,y,r"
 */
export function panelCellChanged(deviceKey, q, y, r, prev, next) {
  if (deviceKey === null || prev === next) return false;
  const c = parsePartKey(deviceKey);
  return !!c && c[0] === q && c[1] === y && c[2] === r;
}

/**
 * The control latch (§4.9): a right-click PRESS on a control (no Shift) operates it and latches; while the button stays
 * down the hold-repeat does nothing (no place, no second toggle, no survival use) except keep a Push Button pressed while
 * the crosshair stays on the cell it pressed. *Without it, holding right-click on a switch for PLACE_REPEAT_S would toggle it
 * and then start placing blocks on it: the user's complaint again.*
 */
export class ControlLatch {
  constructor() {
    /** right-click went down on a control and has not come up yet */
    this.on = false;
    this.q = 0;
    this.y = 0;
    this.r = 0;
    /** seconds toward the next hold-repeat place (Creative) */
    this.repeat = 0;
  }

  /** Forget the latch (the button came up, a modal opened, a new world). */
  release() {
    this.on = false;
    this.repeat = 0;
  }

  /**
   * The press: a control under the crosshair (no Shift) is operated and latched.
   * @param {RaycastHit|null} hit @param {boolean} shift
   * @param {{ isControl(id: number): boolean, operate(h: RaycastHit): void }} env
   * @returns {boolean} it was a control: nothing is placed or used
   */
  press(hit, shift, env) {
    if (!hit || shift || !env.isControl(hit.blockId)) return false;
    env.operate(hit);
    this.on = true;
    this.q = hit.q;
    this.y = hit.y;
    this.r = hit.r;
    return true;
  }

  /**
   * The button is still down after the press frame: while latched, keep the pressed cell held (circuits.hold) as long as
   * the crosshair stays on it.
   * @param {RaycastHit|null} hit
   * @param {{ hold(h: RaycastHit): void }} env
   * @returns {boolean} latched (the caller neither places nor uses)
   */
  holding(hit, env) {
    if (!this.on) return false;
    if (hit && hit.q === this.q && hit.y === this.y && hit.r === this.r) env.hold(hit);
    return true;
  }
}

/** The hold-repeat never places against a control without Shift (§4.9). */
export function repeatBlocked(hit, shift, isControlFn) {
  return !!hit && !shift && isControlFn(hit.blockId);
}

/**
 * One frame of the right mouse button in Creative (§6.6 step 4): press → operate a control or place; held → the latch, or
 * the place repeat every PLACE_REPEAT_S (never against a control without Shift); up → release.
 * @param {ControlLatch} latch
 * @param {{ rightPressed: boolean, right: boolean }} mouse
 * @param {RaycastHit|null} hit
 * @param {boolean} shift
 * @param {number} dt
 * @param {{ isControl(id: number): boolean, operate(h: RaycastHit): void, hold(h: RaycastHit): void, place(): * }} env
 * @returns {'operate'|'place'|'hold'|null} what this frame did
 */
export function rightMouseStep(latch, mouse, hit, shift, dt, env) {
  if (mouse.rightPressed) {
    latch.repeat = 0;
    if (latch.press(hit, shift, env)) return 'operate';
    env.place();
    return 'place';
  }
  if (mouse.right) {
    if (latch.holding(hit, env)) return 'hold';
    if (repeatBlocked(hit, shift, env.isControl)) return null;
    latch.repeat += dt;
    if (latch.repeat < PLACE_REPEAT_S) return null;
    latch.repeat -= PLACE_REPEAT_S;
    env.place();
    return 'place';
  }
  latch.release();
  return null;
}

/**
 * One frame of the left mouse button in Creative (§23, DESIGN-circuits §3.2): a press breaks the target — or pinches out a
 * keg burning in place — and holding repeats the break every BREAK_REPEAT_S. A snuff holds the repeat off until the button
 * is released: otherwise the hold would break the keg it had just saved, 0.25 s later.
 * @param {{ held: number, snuffed: boolean }} st  main's, kept between frames
 * @param {{ leftPressed: boolean, left: boolean }} mouse
 * @param {number} dt
 * @param {{ snuffs(): boolean, act(): void }} env  snuffs: the target is a keg burning in place; act: main's breakTargeted
 * @returns {'snuff'|'break'|null} what this frame did
 */
export function leftMouseStep(st, mouse, dt, env) {
  if (mouse.leftPressed) {
    st.held = 0;
    st.snuffed = env.snuffs();
    env.act();
    return st.snuffed ? 'snuff' : 'break';
  }
  if (!mouse.left) {
    st.held = 0;
    st.snuffed = false;
    return null;
  }
  if (st.snuffed) return null;
  st.held += dt;
  if (st.held < BREAK_REPEAT_S) return null;
  st.held -= BREAK_REPEAT_S;
  st.snuffed = env.snuffs();
  env.act();
  return st.snuffed ? 'snuff' : 'break';
}

/**
 * The white screen flash of a charge going off (§2.4.6): min(MAX, 0.75·(1 − d/48)·facing·cover), facing = 0.35 + 0.65·max(0,
 * dot(view, toHole)), cover 0.35 when the line of sight is blocked. 0 beyond BLACK_HOLE_SCREEN_FLASH_RANGE.
 * @param {number} d          eye → centre distance
 * @param {number} facingDot  dot(view direction, unit eye → centre)
 * @param {boolean} covered   a block hides the centre from the eye
 */
export function screenFlashLevel(d, facingDot, covered) {
  if (!(d < BLACK_HOLE_SCREEN_FLASH_RANGE)) return 0;
  const facing = 0.35 + 0.65 * Math.max(0, Number.isFinite(facingDot) ? facingDot : 0);
  const level = 0.75 * (1 - Math.max(0, d) / BLACK_HOLE_SCREEN_FLASH_RANGE) * facing * (covered ? 0.35 : 1);
  return Math.min(BLACK_HOLE_SCREEN_FLASH_MAX, Math.max(0, level));
}

/** Selenium daylight 0..1 at a time of day (§6.6): the sun's height over 0.5, clamped. */
export function daylightAt(time, tmp = [0, 0, 0]) {
  return Math.max(0, Math.min(1, sunDirection(time, tmp)[1] / 0.5));
}

/**
 * The world view black holes act on (§6.6): eats are lazy writes; `place` writes a charge's BLACK_HOLE (lazy or not, as
 * blackholes.js asks).
 * @param {() => World} w  the live world
 */
export function makeBlackHoleWorld(w) {
  return {
    getBlock: (q, y, r) => w().getBlock(q, y, r),
    setBlock: (q, y, r, id) => w().setBlock(q, y, r, id, true),
    place: (q, y, r, id, lazy) => w().setBlock(q, y, r, id, lazy),
    isLoaded: (q, r) => w().hasChunkAtCell(q, r),
    surfaceHeight: (q, r) => w().getSurfaceHeight(q, r),
    hasEdits: (q, r) => columnHasEdits(w().edits, q, r),
  };
}

/**
 * main's CircuitHooks (§6.6; CONTRACT-ISSUE in circuits.js: igniteKeg forwards the fuse, so `ignite` keeps its 3 s keg, and
 * chargeArming drives the `collapsing!` hint).
 * @param {{ world: () => World, physics: () => (BlockPhysics|null), blackHoles: BlackHoles, blackHoleWorld: *,
 *   daylight: () => number, now: () => number, sound?: Function, particles?: Function, say?: Function }} env
 * @returns {import('./circuits.js').CircuitHooks}
 */
export function makeCircuitHooks(env) {
  const w = env.world;
  const noPhysics = { ok: false, message: 'block physics is not available' };
  return {
    peek: (q, y, r) => w().peekBlock(q, y, r),
    setBlock: (q, y, r, id) => w().setBlock(q, y, r, id, true),
    isLoaded: (q, r) => w().hasChunkAtCell(q, r),
    isEdit: (q, y, r) => w().hasEdit(q, y, r),
    now: env.now,
    igniteKeg: (q, y, r, fuse) => {
      const p = env.physics();
      return p ? p.explosions.igniteInPlace(q, y, r, fuse) : noPhysics;
    },
    activateCharge: (q, y, r) => env.blackHoles.activate(q, y, r, env.blackHoleWorld),
    kegBurning: (q, y, r) => {
      const p = env.physics();
      return !!p && p.explosions.isBurning(q, y, r);
    },
    chargeArming: (q, y, r) => env.blackHoles.isArming(q, y, r),
    daylight: env.daylight,
    sound: (name, x, y, z, v) => {
      if (env.sound) env.sound(name, x, y, z, v);
    },
    particles: (kind, x, y, z, n, o) => {
      if (env.particles) env.particles(kind, x, y, z, n, o);
    },
    say: (text) => {
      if (env.say) env.say(text);
    },
  };
}

/**
 * The PhysicsHooks of DESIGN-circuits §3.6 (undo never relights a restored scene) and of CONTRACTS §55 (undo gives a blasted
 * part back with its settings).
 * @param {() => (Circuits|null)} getCircuits
 */
export function physicsCircuitHooks(getCircuits) {
  return {
    isIgnitable: (id) => isIgnitable(id),
    ignitesAt: (q, y, r) => {
      const c = getCircuits();
      return !!c && c.wouldIgnite(q, y, r);
    },
    // Undo gives a blasted circuit part back with its settings (an NC relay stays NC, a timer keeps its delay and face).
    partState: (q, y, r) => {
      const c = getCircuits();
      return c ? c.partSnapshot(q, y, r) : null;
    },
    restorePart: (q, y, r, state) => {
      const c = getCircuits();
      if (c) c.restorePart(q, y, r, state);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------------------------

/**
 * Create and start the game inside `win` / `doc`. Returns a handle with the GameContext and a `dispose()`.
 * Everything that can fail before the first frame (no WebGL, missing DOM ids) is reported to the error
 * banner and re-thrown so the failure is visible in the console too.
 * @param {Window} win
 * @param {Document} doc
 */
export function boot(win, doc) {
  const params = parseParams(win.location ? win.location.search : '');
  const autoplay = params.autoplay || params.smoke;

  // Errors are captured before anything else exists; the reporter falls back to the raw banner element
  // until the HUD has been created.
  /** @type {ReturnType<typeof createHUD>|null} */
  let hud = null;
  const rawBanner = doc.getElementById('error-banner');
  const reportError = (info) => {
    const message = info && typeof info === 'object' ? String(info.message) : String(info);
    if (hud) {
      hud.showError(message);
    } else if (rawBanner) {
      const line = doc.createElement('div');
      line.textContent = message;
      rawBanner.appendChild(line);
      rawBanner.classList.remove('hidden');
    }
  };
  const uninstallErrors = installErrorCapture(win, reportError);

  const canvas = /** @type {HTMLCanvasElement|null} */ (doc.getElementById(CANVAS_ID));
  if (!canvas) {
    reportError({ message: `Caelancraft: #${CANVAS_ID} not found` });
    throw new Error(`#${CANVAS_ID} not found`);
  }

  // ---- subsystems -----------------------------------------------------------------------------------
  let atlasCanvas;
  let atlasTexture;
  let renderer;
  /** @type {import('./fallingRenderer.js').FallingRenderer} */
  let fallingRenderer;
  /** @type {import('./looseItemRenderer.js').LooseItemRenderer} */
  let looseRenderer;
  /** @type {import('./particles.js').Particles} */
  let particles;
  /** @type {import('./pigRenderer.js').PigRenderer} */
  let pigRenderer;
  /** @type {import('./animalRenderer.js').AnimalRenderer} */
  let animalRenderer;
  /** @type {import('./zombieRenderer.js').ZombieRenderer} */
  let zombieRenderer;
  /** @type {import('./watcherRenderer.js').WatcherRenderer} */
  let watcherRenderer;
  /** @type {import('./campfireRenderer.js').CampfireRenderer} */
  let campfireRenderer;
  /** @type {ReturnType<typeof createVortexRenderer>} the black holes' vortices (§2.4) */
  let vortexRenderer;
  /** @type {import('./circuitRenderer.js').CircuitRenderer} the wiring and the circuit overlays (§4.11) */
  let circuitRenderer;
  /** @type {ReturnType<typeof createDevicePanel>} the device panel (§4.10) */
  let devicePanel;
  /** @type {import('./audio.js').LoopHandle} the black hole drone (one voice, §2.11) */
  let droneLoop;
  let controls;
  let menus;
  let audio;
  /** @type {ReturnType<typeof createConsole>} */
  let consoleUI;
  /** @type {ReturnType<typeof createRuneEditor>} */
  let runeEditor;
  /** @type {import('./packUI.js').PackUI} */
  let packUI;
  /** @type {import('./handbookUI.js').HandbookUI} the Handbook readers (§14.4: the Guide and the field book) */
  let handbookUI;
  try {
    atlasCanvas = createAtlasCanvas();
    atlasTexture = createAtlasTexture(atlasCanvas);
    renderer = createRenderer(canvas, atlasTexture, {
      sunCanvas: makeSunCanvas(),
      moonCanvas: makeMoonCanvas(),
      renderDistance: params.rd ?? RENDER_DISTANCE,
    });
    // Room for the swallowed mobs' ghosts on top of the live ones (DESIGN-circuits §2.7): a ghost is never dropped.
    pigRenderer = createPigRenderer(renderer.three.scene, PIG_MAX + MAX_INFALL_MOBS);
    animalRenderer = createAnimalRenderer(renderer.three.scene, ANIMAL_MAX + MAX_INFALL_MOBS); // room for the swallowed ones' ghosts
    zombieRenderer = createZombieRenderer(renderer.three.scene, atlasTexture, ZOMBIE_MAX + MAX_INFALL_MOBS);
    watcherRenderer = createWatcherRenderer(renderer.three.scene, atlasTexture);
    campfireRenderer = createCampfireRenderer(renderer.three.scene, { makeCanvas: () => doc.createElement('canvas') });
    fallingRenderer = createFallingRenderer(renderer.three.scene, atlasTexture);
    looseRenderer = createLooseItemRenderer(renderer.three.scene, createItemIcons(doc, atlasCanvas));
    particles = createParticles(renderer.three.scene);
    // v0.10: the vortices and the circuit wiring (neither adds a light).
    vortexRenderer = createVortexRenderer(renderer.three.scene);
    circuitRenderer = createCircuitRenderer(renderer.three.scene);
    // Pay the shader costs while the game loads (compile now, one hidden draw in the first frame), not on the frame the
    // first fire, fall or dust appears (§32, §34) — and only once every renderer that adds a light exists: the number of
    // PointLights (the campfires' and the explosion flash) is part of every program's key.
    campfireRenderer.prewarm(renderer.three.renderer, renderer.three.camera);
    // KNOWN-ISSUES P1, P2 (CONTRACTS §72): the block highlight, the chunk materials and the mob models too — the first block
    // under the crosshair, the first trees and the first zombie of a session used to freeze the game while they compiled.
    renderer.prewarm();
    zombieRenderer.prewarm(renderer.three.renderer, renderer.three.camera);
    pigRenderer.prewarm(renderer.three.renderer, renderer.three.camera);
    animalRenderer.prewarm(renderer.three.renderer, renderer.three.camera);
    fallingRenderer.prewarm(renderer.three.renderer, renderer.three.camera);
    particles.prewarm(renderer.three.renderer, renderer.three.camera);
    vortexRenderer.prewarm(renderer.three.renderer, renderer.three.camera);
    circuitRenderer.prewarm(renderer.three.renderer, renderer.three.camera);
    // The Watcher's figure too (§40.4) — only now: the scene's lights are part of every program's key, so compiling it
    // before the campfire and explosion PointLights existed built programs the first sighting could not use.
    watcherRenderer.prewarm(renderer.three.renderer, renderer.three.camera);
    hud = createHUD(doc, atlasCanvas);
    controls = createControls(canvas, doc);
    audio = createAudio();
    droneLoop = audio.startLoop('bhDrone');
    consoleUI = createConsole(doc, {
      onLine: (line) => (runner ? runner.runConsoleLine(line) : { ok: false, message: 'no world is loaded' }),
      onClose: () => closeConsole(),
    });
    runeEditor = createRuneEditor(doc, {
      onChange: (key, partial) => {
        const rune = runeStore.get(key);
        if (!rune) return; // the block was removed while the editor was open
        const updated = runeStore.set(rune.q, rune.y, rune.r, partial);
        if (!updated) {
          hud.showSaveToast(`Too many rune blocks (max ${runeStore.max})`, true);
          return;
        }
        // The master switch behaves like `rune q y r off`: a running script of a disabled rune is cancelled.
        if (!updated.enabled && runner) runner.cancel(key);
      },
      onRun: (key) => {
        closeEditor();
        if (!runner) return;
        const res = runner.trigger(key, SOURCE.INTERACT);
        if (!res.ok) logLine(res.reason || 'could not run', true);
      },
      onClose: () => closeEditor(),
    });
    // The device panel (§4.10): every change goes straight to the world's Circuits, as the rune editor's does.
    devicePanel = createDevicePanel(doc, {
      onChange: (key, partial) => devicePanelChange(key, partial),
      onAction: (key, action) => devicePanelAction(key, action),
      onClose: () => closeDevicePanel(),
    }, atlasCanvas);
    // The Pack & Making screen (§5.4, §9.8): clicks are forwarded raw; all item logic is here and in inventory.js.
    packUI = createPackUI(doc, createItemIcons(doc, atlasCanvas), {
      onSlot: (area, index, button, shift) => packSlotClick(area, index, button, shift),
      onDiscard: () => packSlotClick('discard', 0, 0, false),
      onMake: (recipeId, times) => packMake(recipeId, times),
      onCancelJob: (lane, i) => packCancelJob(lane, i),
      onTab: (tab) => packSetTab(tab),
      onClose: () => closePack(),
      onRead: () => packRead(), // §14.4: read the Handbook from its slot
    });
    // The Survival Handbook's two readers (§14.4): the Guide (menus) and the field book (the item), one text.
    handbookUI = createHandbookUI(doc, { chapters: buildChapters(), onClose: () => onBookClosed() });
  } catch (err) {
    reportError({ message: `Caelancraft failed to start: ${err && err.message ? err.message : err}` });
    throw err;
  }

  // ---- v0.16 world sounds (CONTRACTS §82): footsteps and movement, the ambience, the Sound Test ---------------------
  // Everything here is this section's own; the rest of main calls stepWorldSounds (renderFrame), animalCall (stepAnimals)
  // and quietWorldSounds (leaving a world, dispose).

  const moveSounds = new MoveSounds(audio);
  const ambience = new Ambience(audio);
  /** localStorage, or null where there is none (or ?nosave: nothing is kept) */
  const soundPrefs = (() => {
    try {
      return params.nosave ? null : win.localStorage ?? null;
    } catch {
      return null;
    }
  })();
  ambience.setEnabled(loadAmbiencePref(soundPrefs));
  /** The Sound Test screen and the pause menu's Sound row (the Ambience switch, kept between visits). */
  const soundTest = createSoundTest(doc, audio, {
    win,
    ambienceOn: ambience.enabled,
    onAmbience: (on) => {
      ambience.setEnabled(on);
      saveAmbiencePref(soundPrefs, on);
      audio.playClick();
    },
  });
  /** The surroundings are looked at this often (s): a few hundred getBlock calls. */
  const AMBIENCE_SAMPLE_S = 0.5;
  /** States with a world in which the ambience stays quiet: the menus between the player and the world. */
  const AMBIENCE_QUIET_STATES = new Set([STATE.PAUSED, STATE.DEAD, STATE.CLICK_TO_PLAY, STATE.LOADING, STATE.TITLE]);
  /** @type {import('./worldSounds.js').MoveSample} */
  const moveSample = {
    x: 0, y: 0, z: 0, vy: 0, onGround: false, flying: false, sneaking: false, sprinting: false, inWater: false, wading: false,
    headInWater: false, ground: null, riding: false,
  };
  /** @type {import('./worldSounds.js').AmbienceSample} */
  const ambienceSample = {
    daylight: 1, biome: BIOME.PLAINS, openSky: true, underground: false, trees: 0, grass: 0, streamDist: Infinity,
    fireDist: Infinity, y: 0, headInWater: false,
  };
  const soundWorld = {
    getBlock: (q, y, r) => world.getBlock(q, y, r),
    columnAt: (q, r) => world.columnAt(q, r),
    streamAt: (q, r) => {
      const gen = /** @type {{ streamAt?: (q: number, r: number) => boolean }} */ (world.worldGen);
      return typeof gen.streamAt === 'function' ? gen.streamAt(q, r) : false;
    },
  };
  /** @type {number[][]} */
  const soundCells = [];
  let surroundingsIn = 0;

  /**
   * Once a frame (renderFrame): the player's footsteps, jumps, landings and water sounds while the world runs (`live`),
   * and the ambience for where they stand — which fades out in the menus, on the death screen and without a world.
   * @param {number} dt @param {boolean} live  the simulation stepped this frame
   */
  function stepWorldSounds(dt, live) {
    if (!player || !world || survival.dead || AMBIENCE_QUIET_STATES.has(state)) {
      ambience.update(dt, null);
      surroundingsIn = 0;
      return;
    }
    if (live) {
      const [q, r] = worldToHex(player.x, player.z);
      let groundId = world.getBlock(q, Math.floor(player.y - 1e-3), r);
      if (!isSolid(groundId) && player.onGround) {
        const cells = supportingCells(player, world.getBlock, soundCells);
        if (cells.length > 0) groundId = world.getBlock(cells[0][0], cells[0][1], cells[0][2]);
      }
      const s = moveSample;
      s.x = player.x;
      s.y = player.y;
      s.z = player.z;
      s.vy = player.vy;
      s.onGround = player.onGround;
      s.flying = player.flying;
      s.sneaking = player.sneaking;
      s.sprinting = player.sprinting;
      s.inWater = player.inWater;
      s.wading = !player.inWater && isLiquid(world.getBlock(q, Math.floor(player.y + 0.1), r));
      s.headInWater = player.headInWater;
      s.ground = isSolid(groundId) ? getBlockDef(groundId).soundGroup : null;
      s.riding = Boolean(riding);
      moveSounds.update(dt, s);
    }
    const a = ambienceSample;
    surroundingsIn -= dt;
    if (surroundingsIn <= 0) {
      surroundingsIn = AMBIENCE_SAMPLE_S;
      const here = sampleSurroundings(soundWorld, player.x, player.y, player.z, player.y + getEyeHeight(player));
      a.biome = here.biome;
      a.openSky = here.openSky;
      a.underground = here.underground;
      a.trees = here.trees;
      a.grass = here.grass;
      a.streamDist = here.streamDist;
      const fire = campfires.size > 0 ? campfires.nearest(player.x, player.y, player.z, FIRE_RANGE, 1) : [];
      a.fireDist = fire.length > 0 ? fire[0].dist : Infinity;
    }
    a.daylight = sky.daylight;
    a.y = player.y;
    a.headInWater = player.headInWater;
    ambience.update(dt, a);
  }

  /** An animal calls with nothing to prompt it (stepAnimals): its voice by distance — a wolf by night may howl. */
  function animalCall(a) {
    const v = zombieVolume(a) * 0.7;
    if (v > 0) audio.playRecipe(ambientCall(a.kind, SPECIES[a.kind].voice, sky.daylight), v);
  }

  /** Leaving a world (or the page): the ambience stops at once and the steps forget where they were. */
  function quietWorldSounds() {
    ambience.stop();
    moveSounds.reset();
    surroundingsIn = 0;
  }

  // ---- game state -----------------------------------------------------------------------------------
  let state = STATE.TITLE;
  /** @type {World|null} */
  let world = null;
  /** @type {PlayerState|null} */
  let player = null;
  /** @type {RaycastHit|null} */
  let hit = null;
  // Save slots (§41): the old single save moves into slot 1 first (never under ?nosave, which writes nothing).
  if (!params.nosave) {
    const moved = migrateLegacySave();
    if (moved.status !== 'none' && moved.status !== 'migrated') console.warn('Caelancraft: the old save was not moved into a slot yet:', moved);
  }
  /** the save slot (1..SAVE_SLOTS) the live world is saved to */
  let currentSlot = params.slot ?? 1;
  /** storage.saveSlot's reason for the last failed save (quitUnsavedMessage) */
  let lastSaveFailReason = /** @type {string|undefined} */ (undefined);
  /**
   * `params.nosave` was switched on by ?autoplay's own guards (a damaged slot, or a ?seed that is not the slot's), not by
   * the URL: it protects that one world, so choosing a world on the Worlds screen switches saving back on.
   */
  let autoNoSave = false;
  /** the live world's name and creation time, written into every save's `meta` */
  let worldName = defaultWorldName(currentSlot);
  let worldCreatedAt = 0;
  /** a Save & Quit whose save failed: the next one quits without saving (reset on every pause) */
  let quitUnsavedArmed = false;
  /** @type {SaveData|null} save being restored by the current loading step */
  let pendingSave = null;
  /** @type {number[]|null} [x, y, z] the loading screen streams around */
  let loadingCentre = null;
  let loadingFrames = 0;
  let loadingRadius = LOADING_RADIUS;
  let loadingTotal = LOADING_TOTAL;

  let time = START_TIME;
  let day = 1;
  let hotbar = DEFAULT_HOTBAR.slice();
  let selected = 0;

  let fov = FOV;
  /** Creative's left button between frames (leftMouseStep): the repeat clock and "this hold snuffed a keg" */
  const leftHold = { held: 0, snuffed: false };
  let placeHeld = 0;

  let lastTs = NaN;
  let fpsFrames = 0;
  let fpsAccum = 0;
  let statsAccum = 0;
  const stats = {
    fps: 0,
    frameMs: 0,
    day: 1,
    state,
    chunksLoaded: 0,
    chunksDirty: 0,
    chunkMeshes: 0,
    meshesVisible: 0,
    triangles: 0,
    drawCalls: 0,
    geometries: 0,
  };

  // Rune Blocks: the store outlives worlds (replaceAll on load), the runner and command context are per world.
  const runeStore = new RuneStore();
  // Black holes: re-seeded from the world's edits on every load (CONTRACTS §29).
  const blackHoles = new BlackHoles();
  /** @type {[number, number, number]} scratch for the pull on the player */
  const pull = [0, 0, 0];
  /** throttle for the "swallowed" chat line and sound (fxTime seconds) */
  let lastSwallowLineAt = -Infinity;
  /** the "inert black holes" chat line was shown and the inert count has not dropped to 0 since */
  let inertHolesWarned = false;
  // Campfires (CONTRACTS §32): re-seeded from the world's edits on every load, like black holes.
  const campfires = new Campfires();
  /** seconds of animation time for flames and smoke (advances in every state that renders) */
  let fxTime = 0;
  /** throttle for the "too hot" chat line */
  let lastHotLineAt = -Infinity;
  /** throttle for the "water would put the campfire out" chat line */
  let lastDouseLineAt = -Infinity;
  // Pigs (CONTRACTS §30): replaced from the save on every load; natural ones are placed once per world.
  const pigs = new Pigs();
  /** true when the loading world has never had pigs (no `pigs` field in its save) */
  let placeNaturalPigs = false;
  /** @type {import('./types.js').PlayerState[]} scratch list for resolveBodies */
  const bodies = [];
  /** @type {{ pig: import('./pigs.js').Pig, distance: number }|null} pig under the crosshair, closer than `hit` */
  let pigTarget = null;
  /** @type {[number, number, number]} scratch for water currents (fluids.currentAt) */
  const current = [0, 0, 0];
  const pigWorld = {
    getBlock: (q, y, r) => world.getBlock(q, y, r),
    isLoaded: (x, z) => world.hasChunkAt(x, z),
    // Black-hole pull plus the water current at the pig's feet (pigs sample at feet + 0.5).
    pullAt: (x, y, z, out) => {
      blackHoles.pullAt(x, y, z, out);
      if (blockPhysics) {
        blockPhysics.fluids.currentAt(x, y - 0.4, z, current);
        out[0] += current[0];
        out[1] += current[1];
        out[2] += current[2];
      }
      return out;
    },
    // Every CAMPFIRE cell is known to `campfires` (tracked or refused): with none, pigs skip the fire look-ahead.
    hasCampfires: () => campfires.total > 0,
    /** @type {PlayerState|null} whom the pigs run from (§69; stepPigs refreshes it) */
    player: null,
  };
  // Zombies (CONTRACTS §39): night mobs, never saved; the per-world switch is (startLoading sets it from the save).
  const zombies = new Zombies();
  /** @type {{ zombie: import('./zombies.js').Zombie, distance: number }|null} zombie under the crosshair */
  let zombieTarget = null;
  /** the red screen-edge flash after a zombie's strike, 1 → 0 */
  let hurtFlash = 0;
  let savedZombieSwitch = 0;
  /** World view for zombies.update (player and isDay are refreshed every frame by stepZombies). */
  const zombieWorld = {
    getBlock: pigWorld.getBlock,
    isLoaded: pigWorld.isLoaded,
    pullAt: pigWorld.pullAt,
    hasCampfires: pigWorld.hasCampfires,
    /** @type {PlayerState|null} */
    player: null,
    isDay: false,
    nearestFire: (x, y, z, maxDist, out) => nearestCampfire(x, y, z, maxDist, out),
    isLoadedCell: (q, r) => world.hasChunkAtCell(q, r),
    groundHeight: (q, r) => world.terrainHeightAt(q, r),
    isNaturalGround: (q, y, r) => world.isNaturalGround(q, y, r),
    columnEdited: (q, r) => columnHasEdits(world.edits, q, r),
  };
  // Animals (CONTRACTS §69): cattle, sheep, horses and wolves — wary, rare, hunted, snared, and (horses, wolves) tamed.
  const animals = new Animals();
  /** @type {{ animal: import('./animals.js').Animal, distance: number }|null} the animal under the crosshair */
  let animalTarget = null;
  /** @type {import('./animals.js').Animal|null} the tame horse being ridden */
  let riding = null;
  /** Shift as it was last frame while riding (its press gets off) */
  let rideShift = false;
  /** pigs held by a snare → the snare's cell (pigs.js only counts `trapped` down) */
  const snaredPigs = new Map();
  const animalWorld = {
    getBlock: pigWorld.getBlock,
    isLoaded: pigWorld.isLoaded,
    pullAt: pigWorld.pullAt,
    hasCampfires: pigWorld.hasCampfires,
    /** @type {PlayerState|null} */
    player: null,
    /** @type {string|null} */
    heldKey: null,
    get threats() {
      return zombies.list;
    },
    getBiome: (q, r) => world.getBiome(q, r),
    isLoadedCell: (q, r) => world.hasChunkAtCell(q, r),
    groundHeight: (q, r) => world.terrainHeightAt(q, r),
    isNaturalGround: (q, y, r) => world.isNaturalGround(q, y, r),
    // v0.14 (§76 fauna): fish appear in the generated streams (false everywhere in a world without them)
    streamAt: (q, r) => {
      const gen = /** @type {{ streamAt?: (q: number, r: number) => boolean }} */ (world.worldGen);
      return typeof gen.streamAt === 'function' ? gen.streamAt(q, r) : false;
    },
  };
  /** v0.14 (§76 fauna): a fish is in the water, not among the bodies that push, carry and are blown about. */
  const isBodyAnimal = (a) => !(/** @type {*} */ (SPECIES[a.kind]).water);
  // The Hollow Watcher (CONTRACTS §40): a rare sighting, never saved; the per-world switch and the night of its last
  // natural sighting are (startLoading restores both).
  const watcher = new Watcher();
  let savedWatcherSwitch = 0;
  /** watcher.lastNight as last saved: a new sighting autosaves, so a reload cannot bring a second one that night */
  let savedWatcherNight = /** @type {number|null} */ (null);
  /** World view for watcher.update / summon (refreshWatcherWorld fills the player, view, clock and fog every frame). */
  const watcherWorld = {
    getBlock: pigWorld.getBlock,
    isLoadedCell: (q, r) => world.hasChunkAtCell(q, r),
    groundHeight: (q, r) => world.terrainHeightAt(q, r),
    isNaturalGround: (q, y, r) => world.isNaturalGround(q, y, r),
    hasEdit: (q, y, r) => world.hasEdit(q, y, r),
    occupied: (q, y, r) => pigs.list.some((b) => playerIntersectsBlock(b, q, y, r)) || zombies.list.some((b) => playerIntersectsBlock(b, q, y, r)),
    /** @type {PlayerState|null} */
    player: null,
    /** @type {[number, number, number]} */
    eye: [0, 0, 0],
    /** @type {[number, number, number]} */
    look: [0, 0, -1],
    yaw: 0,
    time: 0,
    day: 1,
    fogFar: 0,
    /** the camera's vertical FOV (degrees) and width / height: a sighting must start on screen (§40.1.2) */
    fov: FOV,
    viewFov: FOV,
    aspect: 16 / 9,
    /** @type {[number, number]|null} */
    spawn: null,
  };
  /**
   * World view handed to blackHoles.update, activate and respawnPoint (used once a world exists). Eats are lazy writes
   * (CONTRACTS §9.2); `place` writes a charge's hole (v0.10, §54).
   */
  const blackHoleWorld = makeBlackHoleWorld(() => /** @type {World} */ (world));

  // ---- Circuits, kegs and black holes v2 (v0.10, CONTRACTS §50–§58) ------------------------------------------------
  /** The configured parts: outlives worlds (replaceAll on every load), like the rune store. */
  const circuitStore = new CircuitStore();
  /** @type {Circuits|null} the world's circuit engine, created in startLoading */
  let circuits = null;
  /** Eaten blocks and swallowed mobs spiralling into their hole (§2.6–§2.7). */
  const infall = new Infall();
  /** @type {[number, number, number]} scratch for daylightAt */
  const sunTmp = [0, 0, 0];
  /** The CircuitHooks (§6.6): the live world, block physics and black holes through getters. */
  const circuitHooks = makeCircuitHooks({
    world: () => /** @type {World} */ (world),
    physics: () => blockPhysics,
    blackHoles,
    blackHoleWorld,
    daylight: () => daylightAt(time, sunTmp),
    now: () => now(),
    sound: (name, x, y, z, v) => playCircuitSound(name, x, y, z, v),
    particles: (kind, x, y, z, n, o) => particles.emit(kind, x, y, z, n, o),
    say: (text) => logLine(text),
  });
  /** the session's pocket wavelength (§4.6): the last transmitter configured, sent from or targeted; not saved */
  let pocketChannel = 1;
  /** part keys whose tip was said this session (§4.13: the first placement of each) */
  const tipsShown = new Set();
  /** ?scene= (§6.7): the named cells of the last scene built, and a charge waiting to be set off */
  /** @type {Record<string, [number, number, number]>|null} */
  let sceneNamed = null;
  /** @type {{ q: number, y: number, r: number, at: number }|null} */
  let sceneCharge = null;
  /** the screen flash (§2.4.6, hud.flashStep) and its colour */
  const flashState = createFlashState();
  /** @type {'white'|'void'} */
  let flashKind = 'white';
  /** @type {{ level: number }|null} this frame's screen-flash trigger */
  let flashTrigger = null;
  /** right-click on a control (§4.9) */
  const controlLatch = new ControlLatch();
  /** @type {[number, number, number]|null} the Push Button or Relay a held R key keeps pressed */
  let rHeldCell = null;
  /** fxTime the keg / charge explanation was last said (§3.3: at most once per KEG_EXPLAIN_GAP_S) */
  let kegExplainAt = -Infinity;
  /** @type {string|null} the part the device panel shows ("q,y,r"), null when closed */
  let deviceKey = null;
  let deviceRefreshAccum = 0;
  /** versions as last saved (autosave) */
  let savedPartsVersion = 0;
  let savedCircuitSwitch = 0;
  let savedBlackHoleSwitch = 0;
  /** the wiring as last built: the circuits' geometryVersion and burnVersion, when (fxTime), and the eye it was built around */
  const geoBuilt = { geometry: -1, burn: -1, at: -Infinity };
  const geoEye = [NaN, NaN, NaN];
  /** @type {import('./circuitGeometry.js').WireGeometry} reused by wireSegments */
  const geoTmp = { seg: { data: new Float32Array(0), count: 0 }, knob: { data: new Float32Array(0), count: 0 } };
  /** @type {import('./types.js').OverlayItem[]} reused by circuits.overlays */
  const overlayTmp = [];
  /** @type {import('./types.js').VortexView[]} reused by blackHoles.vortexViews */
  const vortexViewsTmp = [];
  /** @type {import('./types.js').BlackHoleEvent[]} reused by blackHoles.drainEvents */
  const bhEvents = [];
  /** per vortex (hole key): fractional streaming particles owed (§2.4.5) */
  const vortexAcc = new Map();
  /** the moving blocks fallingRenderer draws: block physics' items, then the charge copies, then the infall (a pooled list) */
  /** @type {{ id: number, x: number, y: number, z: number, rx: number, ry: number, rz: number, scale: number }[]} */
  const movingItems = [];
  let movingCount = 0;
  /** blockphysics' positional push (`push(id, x, y, z, rx, ry, rz, scale)`) into movingItems */
  const pushMoving = (id, x, y, z, rx = 0, ry = 0, rz = 0, scale = 1) => {
    let it = movingItems[movingCount];
    if (!it) movingItems[movingCount] = it = { id: 0, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1 };
    it.id = id;
    it.x = x;
    it.y = y;
    it.z = z;
    it.rx = rx;
    it.ry = ry;
    it.rz = rz;
    it.scale = scale;
    movingCount++;
  };
  /** @type {[number, number, number]} the eye this frame (vortexRenderer.sync) */
  const viewEye = [0, 0, 0];
  const bhFlash = { x: 0, y: 0, z: 0, intensity: 0, color: 0 };
  const camFx = { fov: 0, sx: 0, sy: 0, sz: 0 };
  /** scratch: the mobs pigRenderer / zombieRenderer draw (the live ones plus the infall ghosts) */
  const pigDraw = /** @type {*[]} */ ([]);
  const animalDraw = /** @type {*[]} */ ([]);
  const zombieDraw = /** @type {*[]} */ ([]);
  /** what the control latch (right-click on a control, §4.9) operates and holds */
  /** leftMouseStep's view of main (Creative): the target under the crosshair as the frame began */
  const leftEnv = {
    snuffs: () => isBurningKeg(hit),
    act: () => {
      breakTargeted();
    },
  };
  const latchEnv = {
    isControl: (id) => !!circuits && isControl(id),
    operate: (h) => operateControl(h),
    hold: (h) => {
      if (circuits) circuits.hold(h.q, h.y, h.r);
    },
    place: () => placeSelected(),
  };
  /** the rKeyStep environment (refreshed on every press) */
  const rKeyEnv = { circuits: /** @type {Circuits|null} */ (null), pocketSelected: false };

  // Block physics (CONTRACTS §33–§38): one BlockPhysics per world, created in startLoading.
  /** @type {BlockPhysics|null} */
  let blockPhysics = null;
  /** the loading world was saved before v0.8: say OLD_WORLD_PHYSICS_NOTE once it is playable */
  let physicsNotePending = false;
  let savedSwitchVersion = 0;
  /** @type {{ target: *, distance: number }|null} lit barrel under the crosshair (closer than `hit` / a pig) */
  let litTarget = null;
  /** @type {import('./types.js').PlayerState[]} scratch for PhysicsHooks.bodies */
  const physicsBodies = [];
  /** @type {Map<string, number>} physics sound name → fxTime it last played (throttle) */
  const physicsSoundAt = new Map();
  /** loudest squeal of the pigs knocked during this frame's physics step (0 = none); played once after it */
  let knockSqueal = 0;
  /** loudest physics 'break:<group>' of this frame's physics step (volume 0 = none); played once after it */
  let breakVolume = 0;
  let breakGroup = '';
  /** loudest knock-out / burn-out of the zombies gone this frame (0 = none); one playZombieDown after the physics step */
  let zombieDownVolume = 0;
  const flash = { x: 0, y: 0, z: 0, intensity: 0 };
  /** @type {[number, number, number]} camera shake offset this frame */
  const shake = [0, 0, 0];
  /** @type {import('./blockphysics.js').PhysicsHooks} */
  const physicsHooks = {
    say: (text) => logLine(text),
    areaJobsActive: () => !!runner && runner.hasActiveJobs(),
    bodies: () => {
      physicsBodies.length = 0;
      if (player) physicsBodies.push(player);
      if (world) for (const pig of pigs.list) if (world.hasChunkAt(pig.x, pig.z)) physicsBodies.push(pig);
      if (world) for (const a of animals.list) if (isBodyAnimal(a) && world.hasChunkAt(a.x, a.z)) physicsBodies.push(a);
      if (world) for (const zb of zombies.list) if (world.hasChunkAt(zb.x, zb.z)) physicsBodies.push(zb);
      return physicsBodies;
    },
    player: () => player,
    sound: (name, x, y, z, volume) => playPhysicsSound(name, x, y, z, volume),
    particles: (kind, x, y, z, count, opts) => particles.emit(kind, x, y, z, count, opts),
    knock: (body, vx, vy, vz, fromX, fromZ) => {
      // Survival (§2.4): the hook runs inside the blast, so it only records the hardest knock on the player; main turns it
      // into 'blast' or 'log' damage after blockPhysics.step (never a death from inside a hook).
      if (body === player) pendingKnock = Math.max(pendingKnock, Math.hypot(vx, vy, vz) || 0);
      // A zombie near a blast is knocked out (§39); weaker knocks fling it (zombies.knock adds the velocity itself).
      const zb = /** @type {import('./zombies.js').Zombie} */ (body);
      if (body !== player && zombies.list.includes(zb)) {
        if (zombies.knock(zb, vx, vy, vz) === 'ko') zombieGone(zb, 'ko');
        return;
      }
      // A pig flashes, flees and squeals, but gets the same push as every other body (no pigs.hit kick on top); one
      // squeal per frame, the loudest, played after the step (a blast through a herd took every voice from the boom).
      if (body !== player && pigs.list.includes(body)) {
        if (pigs.hit(body, fromX, fromZ, false)) {
          const d = Math.hypot(body.x - player.x, body.y - player.y, body.z - player.z);
          if (d < 16) knockSqueal = Math.max(knockSqueal, 1 - d / 16);
        }
      }
      body.vx += vx;
      body.vy += vy;
      body.vz += vz;
      body.onGround = false;
    },
    lifted: (body, cells) => {
      // Survival (§2.4 crush): a landing block lifted the body inside blockPhysics.step, so unstickPlayer would never
      // see it; record the player's lift and hurt after the step (never a death from inside a hook).
      if (body === player) pendingCrush += cells;
    },
    // v0.10 (DESIGN-circuits §3.6): undo restores kegs, fuses and charges last and never where they would catch at once.
    ...physicsCircuitHooks(() => circuits),
  };
  /** @type {RuneRunner|null} */
  let runner = null;
  /** @type {import('./commands.js').CommandContext|null} */
  let ctx = null;
  /** @type {string|null} rune key open in the editor */
  let editorKey = null;
  let savedRunesVersion = 0;

  let autosaveAccum = 0;
  let savedEditVersion = 0;
  let savedX = NaN;
  let savedY = NaN;
  let savedZ = NaN;

  let smokeStarted = false;
  let disposed = false;
  let rafId = 0;

  const sky = createSkyState();

  // ---- Survival state (v0.9, §9.5; one of each per session, re-loaded from every save) ------------------
  const survival = new Survival();
  const pack = new Pack();
  const containers = new Containers();
  /** v0.10 (§60): drops flying to the player, and items thrown, dropped or lying on the ground */
  const loose = new LooseItems();
  const fireSlots = new FireSlots();
  const regrowth = new Regrowth();
  const tapped = new Tapped();
  const craftQueue = new CraftQueue();
  /** hold LMB to dig (§6.1) */
  const digState = new DigState();
  /** hold RMB to eat, drink, bandage or wear (§4.5) */
  const useState = new UseState();
  /** hold R to tap a birch or relight a fire pit (§4.2, §4.4) */
  const holdState = new UseState();
  /** @type {Record<string, any>} the last crafting.findStations result (refreshed every CLIMATE_SAMPLE_S) */
  let stations = { hand: true };
  let stationsVersion = 0;
  /** @type {ReturnType<typeof sampleClimate>|null} what the climate saw at the last sample */
  let climateSample = null;
  let climateAccum = 0;
  /** true around a Survival break: released container and fire-spot stacks go into the pack (§5.6) */
  let releaseToPack = false;
  /** @type {string|null} the cause of a death to run at the next checkpoint (§2.5) */
  let pendingDeath = null;
  /** the hardest knock on the player during this frame's physics step, |Δv| (§2.4) */
  let pendingKnock = 0;
  /** whole cells landing blocks lifted the player during this frame's physics step (§2.4 crush) */
  let pendingCrush = 0;
  /** @type {{ mode: 'creative'|'survival' }|null} a queued switch (§1.1) */
  let pendingModeSwitch = null;
  /** @type {RaycastHit|null} the second ray that stops at water (§4.2), Survival with a dry eye only */
  let waterHit = null;
  /** dig feedback: the cell being dug, its progress 0..1, and whether the pack was too full to take its drops */
  let digHit = /** @type {RaycastHit|null} */ (null);
  let digProgress = 0;
  let digAdvanced = false;
  let digPackFull = false;
  /** @type {number|null} the action ring's RMB / R-hold progress */
  let useProgress = null;
  let holdProgress = null;
  let attackHeld = 0;
  let rRepeat = 0;
  /** fxTime throttles */
  let gulpAt = -Infinity;
  let scorchAt = -Infinity;
  let hurtSoundAt = -Infinity;
  let leftBehindAt = -Infinity;
  let spoilLineAt = -Infinity;
  let sizzleAt = -Infinity;
  /** seconds toward the next once-a-second survival work (regrowth, spoilage) */
  let survivalSecond = 0;
  let pigRepopAccum = 0;
  let pigRepopTries = 0;
  /** blast or log damage was dealt this frame (no crush damage on top, §2.4) */
  let knockHurtThisFrame = false;
  /** a game.teleport happened since the last unstick check (no crush damage, §2.4) */
  let teleportFrame = false;
  /** @type {string|null} a short-lived target hint ("needs solid ground", "Pack full", …) and when it ends (fxTime) */
  let flashHint = null;
  let flashHintUntil = 0;
  /** @type {{text: string, error: boolean}|null} the pack screen's own feedback line (packSay) and when it ends (fxTime) */
  let packMessage = null;
  let packMessageUntil = 0;
  let packMessageSeq = 0;
  /** the loading world began a survival state (its intro lines are said once it is playable) */
  let survivalBegun = false;
  /** the loading world was just upgraded to generation 2 (UPGRADED_NOTE once playable) */
  let upgradeNotePending = false;
  /** versions as last saved (autosave) */
  let savedSurvivalSwitch = 0;
  let savedPackVersion = 0;
  let savedContainersVersion = 0;
  let savedFiresVersion = 0;
  /** the Pack & Making screen's session (inventory.slotClick), its open container and tab */
  /** @type {{ pack: Pack, cursor: ItemStack|null, container: (ItemStack|null)[]|null }} */
  const packSession = { pack, cursor: null, container: null };
  /** @type {{ q: number, y: number, r: number, entry: any }|null} */
  let packContainer = null;
  let packTab = 'all';
  let packViewKey = '';
  /** `?mode=` as given (the smoke test's optional survival step reads it after params.mode is used up) */
  const urlMode = params.mode ?? null;
  /** scratch */
  const supportScratch = /** @type {number[][]} */ ([]);
  const supportIds = /** @type {number[]} */ ([]);
  const feetCell = /** @type {[number, number, number]} */ ([0, 0, 0]);
  const peekBlockFn = (q, y, r) => world.peekBlock(q, y, r);
  const isLoadedCellFn = (q, r) => !!world && world.hasChunkAtCell(q, r);
  const isBurningFn = (q, y, r) => world.getBlock(q, y, r) === BLOCK.CAMPFIRE;
  const fireSpotKindFn = (key) => (isSkewerFood(key) ? 'skewer' : isCentrePot(key) ? 'centre' : null);
  const spotsViewFn = (fire) => (fireSlots.size > 0 ? fireSlots.view(fire.q, fire.y, fire.r) : null);
  /** the reused interactKind context (§9.4) */
  const interactCtx = {
    hit: /** @type {RaycastHit|null} */ (null),
    waterHit: /** @type {RaycastHit|null} */ (null),
    headInWater: false,
    selectedKey: /** @type {string|null} */ (null),
    pack,
    fireView: (q, y, r) => fireSlots.view(q, y, r),
    fireSpotKind: fireSpotKindFn,
    tappedToday: (q, y, r) => !tapped.canTap(`${q},${y},${r}`, day),
    salty: (q, r) => isSaltyBiome(world.getBiome(q, r)),
    waterQuality: (q, y, r) => waterQualityOf(q, y, r), // §76 water: fresh, salt or tainted
    stationNear: (station) => !!stations[station], // findStations within STATION_RANGE of the feet (§7.2)
    // v0.10 (DESIGN-circuits §4.9, §8.3): parts with an R action of their own join the hit steps, the pocket key the
    // selected-item steps.
    partR: (id) => !!circuits && circuits.enabled && hasRAction(id),
  };
  /** the reused SurvivalEnv (§9.4) */
  const survivalEnv = {
    player: /** @type {PlayerState|null} */ (null),
    softFactor: 1,
    breaking: false,
    buried: false,
    climate: /** @type {*} */ (null),
    heat: 0,
    nearFire: false,
    insulation: 0,
    sunShade: 0,
    time: 0,
    random: Math.random,
  };
  /** the reused HUD vitals view (§9.8) */
  const vitalsView = { health: 0, satiation: 0, hydration: 0, temp: 0, felt: 0, breath: 0, labels: /** @type {string[]} */ ([]), target: 37 };

  // ---- helpers --------------------------------------------------------------------------------------

  /** Live raycast from the eye along the look direction (allocation-free apart from the hit object). */
  function updateHit() {
    if (!world || !player) {
      hit = null;
      waterHit = null;
      pigTarget = null;
      animalTarget = null;
      zombieTarget = null;
      return;
    }
    const yaw = controls.yaw;
    const pitch = controls.pitch;
    const cp = Math.cos(pitch);
    const dx = -Math.sin(yaw) * cp;
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * cp;
    const eyeY = player.y + getEyeHeight(player);
    // With WATER selected the ray also stops on water sources, so left-click can take one away (§35) — but not while
    // the eye is in water itself (the ray would stop at once and nothing in front could be reached).
    const [eq, er] = worldToHex(player.x, player.z);
    const eyeWet = isWater(world.getBlock(eq, Math.floor(eyeY), er));
    const SV = survival.inSurvival;
    // (Creative only: in Survival the hotbar holds pack stacks and water is never a block to take.)
    const isHit = !SV && hotbar[selected] === BLOCK.WATER && !eyeWet ? hitTargetOrWaterSource : undefined;
    hit = raycastHex(world.getBlock, player.x, eyeY, player.z, dx, dy, dz, REACH, isHit);
    // Survival (§4.2): a second ray that stops at water, for R (drink, fill) and the water hint; LMB / RMB keep using `hit`,
    // so water is never dug or placed against and the highlight never outlines it. Only a water cell is kept.
    waterHit = null;
    if (SV && !eyeWet) {
      const w = raycastHex(world.getBlock, player.x, eyeY, player.z, dx, dy, dz, REACH, hitTargetOrWater);
      if (w && isWater(w.blockId)) waterHit = w;
    }
    // A pig in front of the targeted block takes the crosshair (and hides the block highlight).
    pigTarget = pigs.size > 0 ? pigs.raycast(player.x, eyeY, player.z, dx, dy, dz, hit ? hit.distance : REACH) : null;
    if (pigTarget) hit = null;
    // §69: so does an animal (the nearer of the two wins).
    animalTarget = animals.size > 0
      ? animals.raycast(player.x, eyeY, player.z, dx, dy, dz, pigTarget ? pigTarget.distance : hit ? hit.distance : REACH) : null;
    if (animalTarget) {
      hit = null;
      pigTarget = null;
    }
    // A zombie in front of them takes the crosshair from them (§39).
    const mobReach = animalTarget ? animalTarget.distance : pigTarget ? pigTarget.distance : hit ? hit.distance : REACH;
    zombieTarget = zombies.size > 0 ? zombies.raycast(player.x, eyeY, player.z, dx, dy, dz, mobReach) : null;
    if (zombieTarget) {
      hit = null;
      pigTarget = null;
      animalTarget = null;
    }
    // A lit barrel in front of all of them takes it from them (left-click puts it out).
    const reach = zombieTarget ? zombieTarget.distance : mobReach;
    litTarget = blockPhysics ? blockPhysics.explosions.raycast(player.x, eyeY, player.z, dx, dy, dz, reach) : null;
    if (litTarget) {
      hit = null;
      pigTarget = null;
      animalTarget = null;
      zombieTarget = null;
    }
    // A mob or a lit barrel nearer than the water takes R from it too.
    // (v0.14: not a fish — you still drink from, and fill a pot at, the water it swims in.)
    if (waterHit && (litTarget || zombieTarget || pigTarget || (animalTarget && isBodyAnimal(animalTarget.animal)))) waterHit = null;
    // §4.6: looking at a Spark Transmitter tunes the pocket key to it.
    if (hit && hit.blockId === BLOCK.SPARK_TRANSMITTER && circuits) {
      const st = circuitStore.get(`${hit.q},${hit.y},${hit.r}`);
      if (st && Number.isInteger(st.ch)) pocketChannel = /** @type {number} */ (st.ch);
    }
  }

  function selectSlot(i) {
    if (!Number.isInteger(i) || i < 0 || i >= HOTBAR_SIZE) return;
    selected = i;
    hud.setSelected(i);
    // §4.6: a Spark Transmitter in the hand is the pocket key.
    if (pocketSelected()) {
      hud.showBlockToast(`Pocket key · ${wavelengthOf(pocketChannel)} m · R key: send`);
      return;
    }
    if (survival.inSurvival) {
      const s = pack.slots[i];
      if (s) hud.showBlockToast(itemName(s.k));
      return;
    }
    const id = hotbar[i];
    if (id !== BLOCK.AIR) hud.showBlockToast(getBlockDef(id).displayName);
  }

  /** @returns {boolean} the selected slot holds a Spark Transmitter (the pocket key, §4.6) */
  function pocketSelected() {
    if (survival.inSurvival) return selectedKey() === 'spark_transmitter';
    return hotbar[selected] === BLOCK.SPARK_TRANSMITTER;
  }

  /** Put `id` in `slot`, redraw the hotbar and toast the name. */
  function assignSlot(slot, id) {
    hotbar[slot] = id;
    hud.setHotbar(hotbar, selected);
    hud.showBlockToast(getBlockDef(id).displayName);
  }

  /** Console + HUD chat log line (command results, script errors, `say`). */
  function logLine(text, isError = false, ms = undefined) {
    consoleUI.log(text, isError);
    hud.addChatLine(text, isError, ms);
  }

  /**
   * World.onBlockChange: keep the rune store, black holes, campfires, circuits, the device panel, the survival trackers and
   * block physics in step with the world, in that order (DESIGN-circuits §6.6). Bookkeeping only: nothing here writes a
   * block (CONTRACTS pitfall 34).
   */
  function onBlockChanged(q, y, r, prev, next) {
    blackHoles.onBlockChange(q, y, r, prev, next);
    campfires.onBlockChange(q, y, r, prev, next);
    if (next === BLOCK.RUNE_BLOCK && prev !== BLOCK.RUNE_BLOCK) {
      runeStore.ensure(q, y, r);
    } else if (prev === BLOCK.RUNE_BLOCK && next !== BLOCK.RUNE_BLOCK) {
      const key = runeKey(q, y, r);
      if (runner) runner.cancel(key);
      runeStore.delete(key);
      if (state === STATE.EDITOR && editorKey === key) closeEditor();
    }
    if (circuits) circuits.onBlockChange(q, y, r, prev, next);
    // The panel's part is gone (a blast, a vortex, a setblock): close it (§4.10).
    if (state === STATE.DEVICE && panelCellChanged(deviceKey, q, y, r, prev, next)) closeDevicePanel();
    // Survival (§5.6, §4.4, §6.5): containers and fire spots release their stacks when their cell changes (into the pack
    // only when the player broke it in Survival, else they are lost; a burn-out or a relight keeps the spots), and picked
    // bushes are tracked for regrowth. In every mode, so a Creative edit never leaves a stale entry behind.
    const releasedItems = containers.onBlockChange(q, y, r, prev, next);
    const releasedSpots = fireSlots.onBlockChange(q, y, r, prev, next);
    regrowth.onBlockChange(q, y, r, prev, next);
    if (releaseToPack && (releasedItems.length > 0 || releasedSpots.length > 0)) {
      flyFromCell([...releasedItems, ...releasedSpots], q, y, r);
    }
    // Last, so physics triggers see the trackers already updated.
    if (blockPhysics) blockPhysics.onBlockChange(q, y, r, prev, next);
  }

  /**
   * PhysicsHooks.sound: distance falloff from the player (BOOM_SOUND_RANGE for 'boom', PHYSICS_SOUND_RANGE otherwise),
   * per-name throttles, 'break:<group>' → the frame's loudest break (one playBreak after the physics step, with the falloff
   * volume — a collapsing camp or a campfire fill broke up to 256 fires in one tick, each a full-volume sound), other
   * names → audio['play' + Name] when it exists.
   */
  function playPhysicsSound(name, x, y, z, volume = 1) {
    if (!player || typeof name !== 'string' || !Number.isFinite(x + y + z)) return;
    const range = name === 'boom' ? BOOM_SOUND_RANGE : PHYSICS_SOUND_RANGE;
    const d = Math.hypot(x - player.x, y - (player.y + 1), z - player.z);
    if (!(d < range)) return;
    const gap = PHYSICS_SOUND_GAP_S[name];
    if (gap !== undefined) {
      const last = physicsSoundAt.get(name);
      if (last !== undefined && fxTime - last < gap) return;
      physicsSoundAt.set(name, fxTime);
    }
    const v = (Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1) * (1 - d / range);
    if (name.startsWith('break:')) {
      if (v > breakVolume) {
        breakVolume = v;
        breakGroup = name.slice(6);
      }
      return;
    }
    const method = PHYSICS_SOUND_METHODS[name];
    const fn = method ? audio[method] : undefined;
    if (typeof fn === 'function') fn(v);
  }

  /**
   * A circuit or black-hole sound (circuitSounds recipes, §2.11, §4.12) with the physics sounds' distance falloff: 96 units
   * for the charge's crack and implosion, 24 for the rest. `fuseHiss` has no recipe: it is audio.playHiss.
   */
  function playCircuitSound(name, x, y, z, volume = 1) {
    if (!player || typeof name !== 'string' || !Number.isFinite(x + y + z)) return;
    const range = name === 'bhFlash' || name === 'bhImplode' ? BOOM_SOUND_RANGE : PHYSICS_SOUND_RANGE;
    const d = Math.hypot(x - player.x, y - (player.y + 1), z - player.z);
    if (!(d < range)) return;
    const v = (Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1) * (1 - d / range);
    if (name === 'fuseHiss') audio.playHiss(v);
    else audio.playRecipe(name, v);
  }

  /** A block change made BY THE PLAYER (break / place): physics treats its removals as player-caused (priority seeds). */
  function playerSetBlock(q, y, r, id) {
    if (!blockPhysics) return world.setBlock(q, y, r, id);
    return blockPhysics.asPlayer(() => world.setBlock(q, y, r, id));
  }

  /** @returns {import('./menus.js').PhysicsMenuState|null} what the pause menu shows */
  function physicsMenuState() {
    return physicsMenuStateFor(blockPhysics, survival.inSurvival); // §1.5: Undo is off in Survival
  }

  /** The CommandContext handed to the executor (CONTRACTS §26.3); built once the player exists. */
  function buildCommandContext() {
    /** @type {import('./commands.js').CommandContext} */
    const c = {
      world,
      player,
      controls,
      getTime: () => time,
      setTime: (t) => {
        time = wrapTime(t);
      },
      addTime: (gameSeconds) => {
        const nt = time + gameSeconds / GAME_SECONDS_PER_DAY;
        if (nt >= 1) day += Math.floor(nt);
        time = wrapTime(nt);
      },
      get timeFrozen() {
        return params.time != null;
      },
      get hotbar() {
        return hotbar;
      },
      get selected() {
        return selected;
      },
      setHotbarSlot: (slot, id) => assignSlot(slot, id),
      say: (text) => logLine(text),
      teleport: (x, y, z) => game.teleport(x, y, z),
      setFlying: (on) => {
        player.flying = !!on;
        player.vy = 0;
      },
      runes: runeStore,
      pigs,
      zombies,
      watcher,
      get watcherWorld() {
        return refreshWatcherWorld();
      },
      get physics() {
        return blockPhysics ?? undefined;
      },
      runner: /** @type {*} */ (null),
      rune: null,
      running: null,
      get seed() {
        return world.seed;
      },
      survival: survivalCommands,
      // v0.10 (DESIGN-circuits §6.5): switch / timer / radio / volts / circuits / ignite, and blackholes.
      get circuits() {
        return circuits ?? undefined;
      },
      blackHoles,
      hands: { act: (kind, n) => handAction(kind, n) }, // v0.10 (§60): drop / throw
      animals, // §69: summon cow|sheep|horse|wolf (v0.14: and deer, stag, rabbit, pheasant, turkey, bear, fish)
      loose: { despawnNear: (x, y, z, radius) => loose.despawnNear(x, y, z, radius, looseDespawned) }, // §63: despawn
    };
    return c;
  }

  /** CommandContext.survival (§9.7): the commands see the live state; a mode switch is queued, `vitals health 0` deferred. */
  /** @type {import('./commands.js').SurvivalCommands} */
  const survivalCommands = {
    get mode() {
      return survival.mode;
    },
    get hasState() {
      return survival.hasState;
    },
    setMode: (m) => commandSetMode(m),
    vitals: () => (survival.hasState ? { ...survival.vitals, labels: survival.status.labels } : null),
    setVital: (name, v) => {
      const ok = survival.setVital(name, v);
      // Health 0 never kills inside the command: the death waits for the next checkpoint (§2.5, pitfall 31).
      if (ok && name === 'health' && !(survival.vitals.health > 0) && survival.active) pendingDeath ??= 'command';
      return ok;
    },
    restoreVitals: () => {
      survival.restoreVitals();
    },
    packAdd: (key, n) => consolePackAdd(pack, key, n),
    packClear: () => consolePackClear(pack),
    packList: () => packListText(pack),
  };

  /** `mode <m>` from the console (§9.7): queued like the pause menu's switch; the console closes when it is applied. */
  function commandSetMode(m) {
    if (survival.dead) return { ok: false, message: 'not while the death screen is up' };
    if (m === survival.mode && !pendingModeSwitch) return { ok: true, message: `already ${m}` };
    requestMode(m);
    if (m === 'survival' && world && world.gen < 2) return { ok: true, message: 'adding survival resources to this world: reloading…' };
    return { ok: true, message: `${m} (saved with this world)` };
  }

  /**
   * The R key (§4.9, rKeyStep): the targeted part's own action, else a rune block runs (with the Interact trigger), else the
   * pocket key sends, else a keg or a charge explains how it is set off. Kegs never light on the R key any more (§3.1).
   */
  function interactTarget() {
    const h = hit;
    rKeyEnv.circuits = circuits;
    rKeyEnv.pocketSelected = pocketSelected();
    const step = rKeyStep(h, rKeyEnv);
    if (!step) return;
    if (step.kind === 'part') {
      const pr = /** @type {{ kind: 'part', res: { ok: boolean, message?: string, channel?: number } }} */ (step);
      afterPartAction(/** @type {RaycastHit} */ (h), pr.res);
      return;
    }
    if (step.kind === 'pocket') {
      pocketSend();
      return;
    }
    if (step.kind === 'explain') {
      explainKeg(/** @type {RaycastHit} */ (h).blockId);
      return;
    }
    runRuneAt(/** @type {RaycastHit} */ (h));
  }

  /** The R key ran a part's action: its message, the pocket wavelength of a transmitter, and the held-R cell (§4.9). */
  function afterPartAction(h, res) {
    if (res.message) logLine(res.message, !res.ok);
    if (Number.isInteger(res.channel)) pocketChannel = /** @type {number} */ (res.channel);
    // A held R key keeps a Push Button pressed (and a Relay's armature pushed) while the crosshair stays on it.
    rHeldCell = res.ok && (h.blockId === BLOCK.PUSH_BUTTON || h.blockId === BLOCK.RELAY) ? [h.q, h.y, h.r] : null;
  }

  /** Right-click on a control (the control latch, §4.9): operate it; a transmitter sets the pocket wavelength. */
  function operateControl(h) {
    if (!circuits) return;
    const res = circuits.interact(h.q, h.y, h.r, 'use');
    if (!res) return;
    if (res.message) logLine(res.message, !res.ok);
    if (Number.isInteger(res.channel)) pocketChannel = /** @type {number} */ (res.channel);
  }

  /** The pocket key (§4.6): send on the session's wavelength from the player. */
  function pocketSend() {
    if (!circuits || !player) return;
    const res = circuits.pocketSend(pocketChannel, player.x, player.y + 1, player.z);
    logLine(res.message, !res.ok);
    if (res.ok) playCircuitSound('sparkZap', player.x, player.y + 1, player.z, 0.5);
  }

  /** The R key on a keg or a charge (§3.3): how it is really set off, at most once per KEG_EXPLAIN_GAP_S. */
  function explainKeg(id) {
    const line = explainLine(id, kegExplainAt, fxTime);
    if (line === null) return;
    kegExplainAt = fxTime;
    logLine(line);
  }

  /** R on a rune block: run it when it has the Interact trigger (as before v0.10). */
  function runRuneAt(h) {
    if (!runner) return;
    const rune = runeStore.ensure(h.q, h.y, h.r);
    if (rune && !rune.enabled) {
      logLine('this rune block is disabled — Shift+R to edit it');
      return;
    }
    if (rune && !rune.interact) {
      logLine('this rune block has no Interact trigger — Shift+R to edit it');
      return;
    }
    const res = runner.trigger(runeKey(h.q, h.y, h.r), SOURCE.INTERACT);
    if (!res.ok) logLine(res.reason || 'could not run', true);
  }

  /** Shift+R: the device panel of a part (§4.10), or a rune block's editor. */
  function editTarget() {
    const h = hit;
    if (!h) return;
    if (h.blockId === BLOCK.RUNE_BLOCK) {
      openEditorFor(h.q, h.y, h.r);
      return;
    }
    if (circuits && isPart(h.blockId)) openDevicePanel(h.q, h.y, h.r);
  }

  // ---- the device panel (§4.10, CONTRACTS §57) -------------------------------------------------------------------

  /**
   * Open the device panel on the part at (q, y, r). The state is set before unlock() (pitfall 24); Creative freezes the
   * world under it, Survival keeps it running with the controls disabled.
   */
  function openDevicePanel(q, y, r) {
    if (state !== STATE.PLAYING || !circuits) return;
    const view = circuits.panelView(q, y, r, !survival.inSurvival);
    if (!view) return;
    deviceKey = view.key;
    setState(STATE.DEVICE);
    controls.setEnabled(false);
    controls.unlock();
    leftHold.held = 0;
    placeHeld = 0;
    controlLatch.release();
    rHeldCell = null;
    resetSurvivalInput();
    deviceRefreshAccum = 0;
    if (view.k === 'spark_transmitter' && Number.isInteger(view.fields.ch)) pocketChannel = /** @type {number} */ (view.fields.ch);
    devicePanel.open(view);
  }

  /**
   * Close the panel (Done, Esc, Enter, the Shift+R key, or its part is gone) and go back to playing; die() passes
   * `resume` false (the death state follows). Outside STATE.DEVICE a panel still showing is only closed: it must never be
   * left up with its key capture swallowing the game's keys.
   * @param {boolean} [resume]
   */
  function closeDevicePanel(resume = true) {
    const inDevice = state === STATE.DEVICE;
    deviceKey = null;
    if (devicePanel.isOpen()) devicePanel.close();
    if (inDevice && resume) enterPlayingFromModal();
  }

  /** @returns {[number, number, number]|null} the panel's cell */
  function deviceCell(key) {
    return typeof key === 'string' ? parsePartKey(key) : null;
  }

  /** Redraw the panel from the engine. */
  function refreshDevicePanel() {
    if (state !== STATE.DEVICE || !circuits || deviceKey === null) return;
    const c = deviceCell(deviceKey);
    if (!c) return;
    const view = circuits.panelView(c[0], c[1], c[2], !survival.inSurvival);
    if (view) devicePanel.refresh(view);
    else closeDevicePanel();
  }

  /** devicePanel.onChange: a setting, through circuits.applySettings (validated), then a refresh. */
  function devicePanelChange(key, partial) {
    const c = deviceCell(key);
    if (!c || !circuits || state !== STATE.DEVICE) return;
    const st = circuits.applySettings(c[0], c[1], c[2], partial);
    // (null for a part that is gone: the panel flushes its label as it closes)
    if (!st && circuits.panelView(c[0], c[1], c[2], true)) hud.showSaveToast('too many configured devices in this world', true);
    else if (st && st.k === 'spark_transmitter' && Number.isInteger(st.ch)) pocketChannel = /** @type {number} */ (st.ch);
    refreshDevicePanel();
  }

  /** devicePanel.onAction: Start / Stop a timer, Send, Tap, Refill (Creative). */
  function devicePanelAction(key, action) {
    const c = deviceCell(key);
    if (!c || !circuits || state !== STATE.DEVICE) return;
    const [q, y, r] = c;
    /** @type {{ ok: boolean, message?: string }|null} */
    let res = null;
    if (action === 'start' || action === 'stop') res = circuits.timerAt(q, y, r, action);
    else if (action === 'send') {
      const st = circuitStore.get(key);
      const ch = st && Number.isInteger(st.ch) ? /** @type {number} */ (st.ch) : 1;
      const [x, z] = hexToWorld(q, r);
      res = circuits.radio(ch, x, y + 0.5, z);
      pocketChannel = ch;
    } else if (action === 'tap') res = circuits.interact(q, y, r, 'r');
    else if (action === 'refill' && !survival.inSurvival) res = { ok: circuits.refill(q, y, r), message: '' };
    if (res && res.message) logLine(res.message, !res.ok);
    audio.playClick();
    refreshDevicePanel();
  }

  function openEditorFor(q, y, r) {
    openEditor(runeStore.ensure(q, y, r));
  }

  /**
   * Text under the crosshair (§6.6 targetHintText, both modes): a lit keg entity, a zombie, a circuit part, a keg, a black
   * hole, a rune (Survival: §9.5's hints first).
   */
  function targetHintText() {
    if (flashHint !== null) {
      if (fxTime < flashHintUntil) return flashHint;
      flashHint = null;
    }
    if (survival.inSurvival) return survivalHintText();
    if (litTarget) return 'lit keg · left-click: put it out';
    if (zombieTarget) return 'Zombie · click: hit it';
    // §5.5: Creative breaking is instant, so a cell holding survival items is protected (and says why).
    if (hit && isProtectedCell(hit)) return HINT.protectedCell;
    return blockHintText();
  }

  /** The circuit part, Powder Keg, Black Hole and Rune Block hints (both modes, §4.9, §3.3). */
  function blockHintText() {
    const h = hit;
    if (h && h.blockId === BLOCK.POWDER_KEG) {
      const on = !!blockPhysics && blockPhysics.isEnabled('explosions');
      return kegHintText(on, on && blockPhysics.explosions.isBurning(h.q, h.y, h.r));
    }
    if (h && circuits && isPart(h.blockId)) {
      const text = circuits.hintFor(h.q, h.y, h.r);
      if (text) return text;
    }
    if (h && h.blockId === BLOCK.BLACK_HOLE) return 'Black Hole · walk straight away · left-click: break its core';
    if (!h || h.blockId !== BLOCK.RUNE_BLOCK) return null;
    const rune = runeStore.get(runeKey(h.q, h.y, h.r));
    const label = rune && rune.label ? `${rune.label} · ` : '';
    if (rune && !rune.enabled) return `${label}rune block (disabled) · Shift+R edit`;
    const canRun = !rune || rune.interact;
    return `${label}${canRun ? 'R run · ' : ''}Shift+R edit${canRun ? '' : ' (no Interact trigger)'}`;
  }

  /** @returns {boolean} the hit is a Powder Keg burning in place (a left-click snuffs it, §3.2) */
  function isBurningKeg(h) {
    return snuffsKeg(h, blockPhysics ? blockPhysics.explosions : null);
  }

  /** Pinch out the fuse of the keg burning in place under the crosshair and keep the keg (§3.2). @returns {boolean} */
  function snuffTargetedKeg() {
    const h = hit;
    if (!isBurningKeg(h) || !blockPhysics) return false;
    const done = blockPhysics.explosions.snuff(h.q, h.y, h.r);
    updateHit();
    return done;
  }

  /** Break rule (§23). @returns {boolean} */
  function breakTargeted() {
    if (!world || !player) return false;
    if (isBurningKeg(hit)) return snuffTargetedKeg();
    if (litTarget) {
      const snuffed = blockPhysics ? blockPhysics.explosions.snuff(litTarget.target) : false;
      updateHit();
      return snuffed;
    }
    if (zombieTarget) {
      hitZombie(zombieTarget.zombie);
      updateHit();
      return true;
    }
    if (pigTarget) {
      if (pigs.hit(pigTarget.pig, player.x, player.z)) audio.playSqueal();
      return true;
    }
    if (animalTarget) {
      // Creative never wounds: a shove, and a wild one runs.
      if (animals.wound(animalTarget.animal, 0, player.x, player.z)) animalVoice(animalTarget.animal, 1);
      return true;
    }
    const h = hit;
    // A water source is not breakable, but with WATER selected left-click takes it away (the flow drains by itself).
    const takeWater = h && isWaterSource(h.blockId) && hotbar[selected] === BLOCK.WATER; // (a tainted source too: §76)
    if (!h || (!isBreakable(h.blockId) && !takeWater)) return false;
    // §5.5: a basket or belongings holding items, or a fire whose spots hold anything, are kept safe from Creative.
    if (isProtectedCell(h)) {
      showHint(HINT.protectedCell);
      return false;
    }
    if (!playerSetBlock(h.q, h.y, h.r, BLOCK.AIR)) return false;
    audio.playBreak(getBlockDef(h.blockId).soundGroup);
    ghostFromCell(h.blockId, h.q, h.y, h.r); // §60: Creative shows the block flying to the player, nothing more
    updateHit();
    return true;
  }

  /** §5.5: a WICKER_BASKET / REMAINS cell holding items, or a CAMPFIRE / FIRE_PIT whose spots hold anything. */
  function isProtectedCell(h) {
    const id = h.blockId;
    if (id === BLOCK.WICKER_BASKET || id === BLOCK.REMAINS) return containers.hasItems(h.q, h.y, h.r);
    if (id === BLOCK.CAMPFIRE || id === BLOCK.FIRE_PIT) return fireSlots.hasItems(h.q, h.y, h.r);
    return false;
  }

  /** Place rule (§23). @returns {boolean} */
  function placeSelected() {
    if (!world || !player) return false;
    const id = hotbar[selected];
    if (!isPlaceable(id)) return false;
    const cell = placeTarget();
    if (!cell || !placeBlockAt(id, cell)) return false;
    // A freshly placed rune block opens its editor right away (the onBlockChange hook created its entry).
    if (id === BLOCK.RUNE_BLOCK && state === STATE.PLAYING) openEditorFor(cell[0], cell[1], cell[2]);
    partPlaced(id, cell);
    return true;
  }

  /**
   * After a part is placed (§6.6 step 5, both modes): a part with an input face takes the face the player looks toward, and
   * the first placement this session of each part says its tip (§4.13).
   */
  function partPlaced(id, cell) {
    if (!circuits || !isPart(id)) return;
    const def = /** @type {import('./types.js').PartDef} */ (partOf(id));
    if (def.input) {
      // The face back at the player, unless a battery stands there (it would feed nothing): then a free face round from it.
      const face = circuits.placementInputFace(cell[0], cell[1], cell[2], inputFaceFromYaw(controls.yaw));
      circuits.setInputFace(cell[0], cell[1], cell[2], face);
    }
    if (tipsShown.has(def.key)) return;
    tipsShown.add(def.key);
    const tip = partTip(id);
    if (tip) logLine(`Tip — ${tip}`, false, INTRO_LINE_MS);
  }

  /** The cell a placement would fill: across the targeted face, in height range and replaceable; else null. */
  function placeTarget() {
    const h = hit;
    if (!h || h.face < 0) return null;
    const [tq, ty, tr] = faceNeighbor(h.q, h.y, h.r, h.face);
    if (!inHeightRange(ty)) return null;
    if (!isReplaceable(world.getBlock(tq, ty, tr))) return null;
    return [tq, ty, tr];
  }

  /**
   * Place block `id` at `cell` (from placeTarget) under §23's rules: never inside the player (solid, black hole, campfire),
   * never entombing a pig or a zombie, never dousing a campfire. Plays the place sound. @returns {boolean}
   */
  function placeBlockAt(id, cell) {
    const [tq, ty, tr] = cell;
    // A campfire is not solid, but placing one inside yourself would scorch you on the spot. (A black hole is no longer
    // placeable, §2.9; a Collapsar Charge is solid, so the solid rule covers it.)
    if ((isSolid(id) || id === BLOCK.CAMPFIRE) && playerIntersectsBlock(player, tq, ty, tr)) return false;
    if (isSolid(id) && pigs.list.some((pig) => playerIntersectsBlock(pig, tq, ty, tr))) return false; // no entombing pigs
    if (isSolid(id) && animals.list.some((a) => playerIntersectsBlock(a, tq, ty, tr))) return false; // … or animals
    if (isSolid(id) && zombies.list.some((zb) => playerIntersectsBlock(zb, tq, ty, tr))) return false; // … nor zombies
    // A campfire never goes into or under water, and water never goes on a campfire (§32).
    if (wouldDouseCampfire(world.getBlock, id, tq, ty, tr)) {
      if (fxTime - lastDouseLineAt > 2) {
        lastDouseLineAt = fxTime;
        logLine('Water would put the campfire out.');
      }
      return false;
    }
    if (!playerSetBlock(tq, ty, tr, id)) return false;
    audio.playPlace(getBlockDef(id).soundGroup);
    updateHit();
    return true;
  }

  /** Pick rule (middle mouse): select the slot holding the block, else assign it to the selected slot. */
  function pickTargeted() {
    const h = hit;
    if (!h || !isPlaceable(h.blockId)) return false;
    const i = hotbar.indexOf(h.blockId);
    if (i >= 0) selectSlot(i);
    else assignSlot(selected, h.blockId);
    audio.playClick();
    return true;
  }

  // ---- Survival: small helpers (§49) ----------------------------------------------------------------

  /** A short-lived target hint (refusals: "needs solid ground", "Pack full", …). */
  function showHint(text, seconds = 1.6) {
    flashHint = text;
    flashHintUntil = fxTime + seconds;
  }

  /** @returns {ItemStack|null} the selected pack stack */
  function selectedStack() {
    return pack.slots[selected] ?? null;
  }

  /** @returns {string|null} */
  function selectedKey() {
    const s = pack.slots[selected];
    return s ? s.k : null;
  }

  /** @returns {import('./types.js').ToolDef|null} the tool in hand (null: a bare hand or a non-tool item) */
  function selectedTool() {
    return pack.toolAt(selected);
  }

  /** Window pixels of a cell's centre (the pickup tokens fly from there), or null. */
  function screenPointOfCell(q, y, r) {
    if (!player) return null;
    const [x, z] = hexToWorld(q, r);
    return projectToScreen(renderer.three.camera, x, y + 0.5, z, win.innerWidth, win.innerHeight);
  }

  /**
   * Give stacks to the pack (§5.3): each flies to its slot as a hex token from `from`; what does not fit is left behind with
   * one throttled chat line. @returns {ItemStack[]} what did not fit
   */
  function giveStacks(stacks, from = null) {
    /** @type {ItemStack[]} */
    const over = [];
    for (const s of stacks) {
      if (!s || !(s.n > 0)) continue;
      const left = pack.add(s);
      const got = s.n - (left ? left.n : 0);
      if (got > 0) hud.addPickup(s.k, got, from);
      if (left) over.push(left);
    }
    if (over.length > 0) leftBehind(over);
    return over;
  }

  /** "Pack full: 2 Rock left behind" (at most once per 2 s). */
  function leftBehind(stacks) {
    if (fxTime - leftBehindAt < 2) return;
    leftBehindAt = fxTime;
    logLine(leftBehindText(stacks));
  }

  // ---- v0.10 loose items (§60): drops fly to the player; throw and drop ----------------------------------------

  /** The block a loose stack is drawn as (a block item's meshed block: the ripe bush for the bush items), else −1. */
  function looseBlockOf(key) {
    const def = getItem(key);
    if (!def || def.kind !== 'block') return -1;
    const id = iconBlockFor(key);
    return id > 0 && isMeshed(id) ? id : -1;
  }

  /** What a dig, a pick or a kill gives: each stack hops out of (x, y, z) and flies to the player (it enters the pack there). */
  function flyStacks(stacks, x, y, z) {
    for (const s of stacks) if (s && s.n > 0) loose.spawnDrop(s, x, y, z, { block: looseBlockOf(s.k) });
  }

  /** flyStacks from a cell's centre. */
  function flyFromCell(stacks, q, y, r) {
    const [x, z] = hexToWorld(q, r);
    flyStacks(stacks, x, y + 0.5, z);
  }

  /** Creative: the broken block flies to the player as a ghost (nothing is given). */
  function ghostFromCell(id, q, y, r) {
    if (isLiquid(id)) return;
    const key = itemForBlock(id);
    const block = isMeshed(id) ? id : -1;
    if (!key && block < 0) return;
    const [x, z] = hexToWorld(q, r);
    loose.spawnDrop({ k: key ?? '', n: 1 }, x, y + 0.5, z, { block, ghost: true });
  }

  /** Window pixels the HUD token starts from when a loose item reaches the player (just below the crosshair). */
  function pickupFrom() {
    return { x: win.innerWidth / 2, y: win.innerHeight * 0.62 };
  }

  /** A real loose item crossed the player's threshold: into the pack. @returns {ItemStack|null} what did not fit */
  function collectLoose(it) {
    const s = it.s;
    const left = pack.add(s);
    const got = s.n - (left ? left.n : 0);
    if (got > 0) {
      hud.addPickup(s.k, got, pickupFrom());
      audio.playRecipe(SOUND_PICKUP, 0.6);
    }
    if (left) leftBehind([left]);
    return left;
  }

  /** What a knocked-out zombie gives: its drops rolled once, an alpha's three times (§61). */
  function zombieDrops(zb) {
    const out = [];
    for (let i = 0; i < statsOf(zb).drops; i++) out.push(...rollMobDrops('zombie', Math.random));
    return out;
  }

  // ---- Animals (CONTRACTS §69) -----------------------------------------------------------------------------------

  /** The item in the player's hand as a key: the selected pack stack in Survival, the hotbar block's item in Creative. */
  function heldItemKey() {
    if (survival.inSurvival) return selectedKey();
    const id = hotbar[selected];
    return id ? itemForBlock(id) : null;
  }

  /** An animal's call (its species' voice), by distance. */
  function animalVoice(a, scale = 1) {
    const v = zombieVolume(a) * scale;
    if (v > 0) audio.playRecipe(ANIMAL_SOUNDS[SPECIES[a.kind].voice], v);
  }

  /** It is dead: a puff, and (Survival) what it gives flies to the player. */
  function animalDied(a, real) {
    particles.emit('dust', a.x, a.y + a.height * 0.5, a.z, 24, { color: [0.72, 0.62, 0.55], spread: 0.5 });
    animalVoice(a, 1);
    if (real && survival.inSurvival) flyStacks(rollMobDrops(a.kind, Math.random), a.x, a.y + a.height * 0.5, a.z);
    if (riding === a) riding = null;
    if (animalTarget && animalTarget.animal === a) animalTarget = null;
  }

  /** The target hint for an animal. */
  function animalHint(a) {
    const sp = SPECIES[a.kind];
    const snared = a.trapped > 0 ? ' (snared)' : '';
    if (a.tamed) {
      if (a.kind === 'horse') return 'Your Horse · R: ride';
      return `Your Wolf · R: ${a.sitting ? 'follow me' : 'sit'} · feed it meat to heal it`;
    }
    const hunt = selectedTool() ? 'click: hunt it' : 'hunting needs a tool';
    // v0.14 (§76 fauna)
    if (a.kind === 'fish') return selectedTool()?.type === 'spear' ? 'Fish · click: spear it · G: throw the spear' : 'Fish · it takes a spear to catch one';
    if (a.kind === 'bear') {
      if (a.mode === 'charge') return 'Bear · it is charging: run, or fight';
      if (a.mode === 'warn') return 'Bear · it is warning you: back away';
      return `Bear · keep your distance · ${hunt}`;
    }
    if (a.kind === 'deer') return `${a.variant === 1 ? 'Stag' : 'Deer'}${snared} · ${hunt}`;
    if (a.kind === 'horse') return `Horse${snared} · R with a Wild Tuber or Honeyberries: feed it (${a.trust}/${sp.tame} to tame)`;
    if (a.kind === 'wolf') return `Wolf${snared} · R with meat: feed it (${a.trust}/${sp.tame} to tame)`;
    if (a.kind === 'sheep') return `Sheep${snared} · ${hunt} · R with a knife: shear`;
    return `${sp.name}${snared} · ${hunt}${a.kind === 'cow' ? ' · R with a Clay Pot: milk it' : ''}`;
  }

  /** Little hearts over an animal. */
  function animalHearts(a, n = 6) {
    particles.emit('dust', a.x, a.y + a.height + 0.25, a.z, n, { color: [1, 0.42, 0.56], spread: 0.3 });
  }

  /**
   * R on the animal under the crosshair: feed it what it likes (cattle and sheep calm down; a horse or a wolf is tamed
   * after its species' feeds), shear a sheep with a knife, ride a tame horse, tell a tame wolf to sit or follow. In
   * Creative R tames at once. @returns {boolean} handled
   */
  function animalR() {
    if (riding || !animalTarget) return false;
    const a = animalTarget.animal;
    if (!isBodyAnimal(a)) return false; // v0.14: R on a fish is R on the water (drink, fill a pot)
    const sp = SPECIES[a.kind];
    const SV = survival.inSurvival;
    const key = heldItemKey();
    if (key && sp.lure.includes(key) && !(a.tamed && a.health >= sp.health)) {
      const res = animals.feed(a, key);
      if (res.ok) {
        if (SV) pack.consume(selected, 1);
        audio.playEat();
        animalHearts(a, res.tamed ? 14 : 5);
        if (res.tamed) animalTamed(a);
        else if (sp.tame > 0 && !a.tamed) showHint(`${sp.name}: fed ${a.trust} of ${sp.tame}`);
        else if (res.calmed) showHint(`The ${sp.name.toLowerCase()} calms down.`);
        return true;
      }
    }
    if (a.kind === 'cow' && key === 'clay_pot') {
      // §72: an empty clay pot under a cow fills with milk (a milked cow needs a few minutes).
      if (a.milked > 0) showHint('This cow has no more milk for now.');
      else if (animals.milk(a)) {
        if (SV) {
          pack.consume(selected, 1);
          giveToHand('pot_milk');
        }
        audio.playDrink();
        animalVoice(a, 0.6);
        showHint('A Pot of Milk.');
      }
      return true;
    }
    if (a.kind === 'sheep' && !a.tamed) {
      if (SV && !pack.hasTool('knife', KNIFE_TIER)) showHint('Shearing needs a knife.');
      else if (a.shorn > 0) showHint('Its fleece is growing back.');
      else {
        const n = animals.shear(a);
        if (n > 0) {
          audio.playPick();
          if (SV) {
            flyStacks([{ k: 'wool_white', n }], a.x, a.y + 0.6, a.z);
            const used = pack.useTool('knife', KNIFE_TIER);
            if (used && used.broke) toolBroke(used.key);
          }
        }
      }
      return true;
    }
    if (a.tamed && a.kind === 'horse') {
      mountHorse(a);
      return true;
    }
    if (a.tamed && a.kind === 'wolf') {
      a.sitting = !a.sitting;
      showHint(a.sitting ? 'The wolf sits and waits.' : 'The wolf follows you.');
      animalVoice(a, 0.7);
      return true;
    }
    if (!SV && sp.tame > 0) {
      let res = { ok: true, tamed: false };
      for (let i = 0; i < sp.tame && res.ok && !res.tamed; i++) res = animals.feed(a, sp.lure[0]);
      if (res.tamed) {
        animalHearts(a, 14);
        animalTamed(a);
      }
      return true;
    }
    return true; // R on an animal never falls through to the block behind it
  }

  /** A horse or a wolf has just been tamed. */
  function animalTamed(a) {
    audio.playRecipe(ANIMAL_SOUNDS.tame, 0.8);
    logLine(a.kind === 'horse'
      ? 'The horse trusts you. Press R to ride it; Shift gets off, Space jumps. It waits where you leave it.'
      : 'The wolf trusts you. It follows you and bites zombies that come near. R tells it to sit or follow.');
  }

  /** R on a Snare with food in hand baits it (Creative: R toggles the bait). @returns {boolean} handled */
  function snareR() {
    const h = hit;
    if (!h || (h.blockId !== BLOCK.SNARE && h.blockId !== BLOCK.SNARE_BAITED)) return false;
    const SV = survival.inSurvival;
    if (h.blockId === BLOCK.SNARE_BAITED) {
      if (SV) showHint('It is baited already.');
      else playerSetBlock(h.q, h.y, h.r, BLOCK.SNARE);
      return true;
    }
    const key = heldItemKey();
    const food = key ? getItem(key)?.food : null;
    if (SV && !food) {
      showHint('Hold some food and press R to bait the snare.');
      return true;
    }
    if (!playerSetBlock(h.q, h.y, h.r, BLOCK.SNARE_BAITED)) return true;
    if (SV) pack.consume(selected, 1);
    audio.playPick();
    showHint('Baited. Animals nearby will come to it; keep away so you do not scare them.');
    updateHit();
    return true;
  }

  /** Get on a tame horse. */
  function mountHorse(a) {
    if (!animals.mount(a)) return;
    riding = a;
    rideShift = true; // the Shift that may be held now is not a press
    player.flying = false;
    showHint('Riding · Shift: get off · Space: jump · double-tap W: gallop', 3);
    animalVoice(a, 0.8);
  }

  /** Get off: beside the horse where there is room, else on its back. */
  function dismountHorse() {
    const a = riding;
    if (!a) return;
    riding = null;
    animals.dismount(a);
    const [fx, fz] = yawToForward(a.yaw);
    let placed = false;
    for (const [ox, oz] of [[fz, -fx], [-fz, fx], [-fx, -fz]]) {
      const x = a.x + ox * 1.05;
      const z = a.z + oz * 1.05;
      if (!isFreeAt(world.getBlock, x, a.y, z)) continue;
      player.x = x;
      player.y = a.y;
      player.z = z;
      placed = true;
      break;
    }
    if (!placed) player.y = a.y + a.height;
    player.vx = 0;
    player.vy = 0;
    player.vz = 0;
    player.landSpeed = 0;
    if (survival.inSurvival) survival.fallGrace = true;
  }

  /** While riding: Shift gets off; the horse moves by the player's input and carries the player on its back. */
  function stepRide(input, dt) {
    if (!riding) return;
    if (!animals.list.includes(riding)) {
      riding = null;
      return;
    }
    const shift = controls.isDown('ShiftLeft') || controls.isDown('ShiftRight');
    if (shift && !rideShift) {
      dismountHorse();
      rideShift = shift;
      return;
    }
    rideShift = shift;
    const a = riding;
    if (world.hasChunkAt(a.x, a.z)) animals.ride(a, input, world.getBlock, dt);
    player.x = a.x;
    player.y = a.y + SADDLE_Y;
    player.z = a.z;
    player.vx = a.vx;
    player.vy = 0;
    player.vz = a.vz;
    player.onGround = true;
    player.sneaking = false;
    player.landSpeed = 0;
  }

  /** Animals: natural herds, AI and physics; then their calls, the snares and the wolves' bites. */
  function stepAnimals(dt) {
    animalWorld.player = player && !survival.dead ? player : null;
    animalWorld.heldKey = heldItemKey();
    const ev = animals.update(dt, animalWorld);
    for (const a of ev.voices) {
      if (zombieVolume(a) > 0) {
        animalCall(a); // v0.16 (§82): its voice at 0.7, or a wolf's howl by night
        break; // one call a frame at most
      }
    }
    for (const c of ev.caught) {
      world.setBlock(c.cell[0], c.cell[1], c.cell[2], BLOCK.SNARE_SPRUNG);
      snareSprung(c.animal, SPECIES[c.animal.kind].name);
    }
    applyFaunaEvents(ev);
    for (const f of ev.freed) {
      if (world.getBlock(f.cell[0], f.cell[1], f.cell[2]) === BLOCK.SNARE_SPRUNG) world.setBlock(f.cell[0], f.cell[1], f.cell[2], BLOCK.SNARE);
    }
    for (const b of ev.bites) {
      const zb = b.target;
      if (!zombies.list.includes(zb)) continue;
      audio.playRecipe(ANIMAL_SOUNDS.woof, Math.max(0.3, zombieVolume(b.wolf)));
      const res = zombies.hit(zb, b.wolf.x, b.wolf.z, WOLF_BITE);
      if (res === 'ko') {
        zombieGone(zb, 'ko');
        if (survival.inSurvival) flyStacks(zombieDrops(zb), zb.x, zb.y + ZOMBIE_HEIGHT / 2, zb.z);
      } else if (res === 'hit') {
        audio.playZombieHurt(0.6);
      }
    }
    stepSnaredPigs();
    // §72: a black hole swallows animals like pigs — a ghost spirals in, and its call comes at the end (stepInfall).
    if (blackHoles.size === 0) return;
    for (let i = animals.list.length - 1; i >= 0; i--) {
      const a = animals.list[i];
      const hole = blackHoles.swallowing(a);
      if (!hole) continue;
      if (riding === a) dismountHorse(); // the rider is the black hole's own business (stepBlackHoles)
      animals.remove(a); // frees its snare too
      if (animalTarget && animalTarget.animal === a) animalTarget = null;
      if (!infall.addMob('animal', a, hole.cx, hole.cy, hole.cz)) animalVoice(a, 1);
    }
  }

  /** v0.14 (§76 fauna): the bears that have had their warning line said (one line per bear, however often it rears) */
  const bearWarned = new WeakSet();

  /**
   * v0.14 (§76 fauna): what the game animals did this frame — birds flushed (the whirr of wings, a few feathers), a bear
   * reared up (its growl, and the warning line once per bear), charged (its roar) or mauled the player (BEAR_DAMAGE each,
   * cause 'bear'; the throw is animals.js's), a hen laid a nest (the block).
   * @param {import('./animals.js').AnimalEvents} ev
   */
  function applyFaunaEvents(ev) {
    let whirr = 0;
    for (const a of ev.flushed) {
      whirr = Math.max(whirr, zombieVolume(a));
      particles.emit('dust', a.x, a.y + 0.3, a.z, 5, { color: [0.8, 0.62, 0.42], spread: 0.3 });
    }
    if (whirr > 0) audio.playRecipe(ANIMAL_SOUNDS.flush, Math.max(0.35, whirr));
    for (const a of ev.warned) {
      audio.playRecipe(ANIMAL_SOUNDS.growl, Math.max(0.5, zombieVolume(a)));
      if (!bearWarned.has(a)) {
        bearWarned.add(a);
        logLine('A bear rears up and growls at you. Back away, slowly or fast: if you stay it will charge.');
      }
    }
    for (const a of ev.charged) audio.playRecipe(ANIMAL_SOUNDS.roar, Math.max(0.5, zombieVolume(a)));
    if (ev.mauls.length > 0) {
      hurtFlash = 1;
      audio.playThud(1);
      audio.playRecipe(ANIMAL_SOUNDS.growl, 0.8);
      if (survival.active) hurt(BEAR_DAMAGE * ev.mauls.length, 'bear');
    }
    for (const n of ev.laid) {
      const [q, y, r] = n.cell;
      if (!world.hasChunkAtCell(q, r)) continue;
      if (world.getBlock(q, y, r) === (n.refill ? BLOCK.GROUND_NEST_EMPTY : BLOCK.AIR)) world.setBlock(q, y, r, BLOCK.GROUND_NEST);
    }
  }
  /** A snare went off: the snap, a puff, and a line when it is within earshot. */
  function snareSprung(body, name) {
    const v = zombieVolume(body);
    if (v > 0) audio.playRecipe(ANIMAL_SOUNDS.snare, Math.max(0.3, v));
    particles.emit('dust', body.x, body.y + 0.2, body.z, 8, { color: [0.85, 0.78, 0.6], spread: 0.3 });
    logLine(`A snare has caught a ${name.toLowerCase()}. It will hold for about ${Math.round(TRAP_HOLD_S / 60 * 2) / 2} minutes.`);
  }

  /** Pigs and snares: a pig that steps into a set snare is held (pigs.js counts `trapped` down); then the snare resets. */
  function stepSnaredPigs() {
    for (const pig of pigs.list) {
      if (pig.trapped > 0 || pig.snareImmune > fxTime || !world.hasChunkAt(pig.x, pig.z)) continue;
      const [q, r] = worldToHex(pig.x, pig.z);
      const y = Math.floor(pig.y + 0.05);
      const id = world.getBlock(q, y, r);
      if (id !== BLOCK.SNARE && id !== BLOCK.SNARE_BAITED) continue;
      pig.trapped = TRAP_HOLD_S;
      const [cx, cz] = hexToWorld(q, r);
      pig.x = cx;
      pig.z = cz;
      snaredPigs.set(pig, [q, y, r]);
      world.setBlock(q, y, r, BLOCK.SNARE_SPRUNG);
      snareSprung(pig, 'pig');
    }
    for (const [pig, cell] of snaredPigs) {
      const held = pigs.list.includes(pig) && pig.trapped > 0 && world.getBlock(cell[0], cell[1], cell[2]) === BLOCK.SNARE_SPRUNG;
      if (held) continue;
      snaredPigs.delete(pig);
      pig.trapped = 0;
      pig.snareImmune = fxTime + 20;
      if (world.getBlock(cell[0], cell[1], cell[2]) === BLOCK.SNARE_SPRUNG) world.setBlock(cell[0], cell[1], cell[2], BLOCK.SNARE);
    }
  }

  /** The first zombie or pig a thrown item's path (x0 → x1) enters. */
  function looseHitMob(x0, y0, z0, x1, y1, z1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-6)) return null;
    const zh = zombies.raycast(x0, y0, z0, dx / len, dy / len, dz / len, len);
    const ph = pigs.raycast(x0, y0, z0, dx / len, dy / len, dz / len, len);
    const ah = animals.raycast(x0, y0, z0, dx / len, dy / len, dz / len, len);
    const near = Math.min(zh ? zh.distance : Infinity, ph ? ph.distance : Infinity, ah ? ah.distance : Infinity);
    if (zh && zh.distance === near) return { kind: 'zombie', mob: zh.zombie };
    if (ph && ph.distance === near) return { kind: 'pig', mob: ph.pig };
    if (ah) return { kind: 'animal', mob: ah.animal };
    return null;
  }

  /**
   * A thrown item hit a mob with its power: a zombie counts it as hits, a pig is wounded in Survival (shoved in Creative).
   * A dart may break; a spear takes 1 wear. @returns {boolean} the item broke
   */
  function looseOnHit(it, target) {
    const fromX = it.x - it.vx;
    const fromZ = it.z - it.vz;
    const real = survival.inSurvival && !it.ghost;
    audio.playRecipe(SOUND_THUNK, 0.8);
    if (target.kind === 'zombie') {
      const zb = target.mob;
      const res = zombies.hit(zb, fromX, fromZ, it.power);
      if (res === 'ko') {
        zombieGone(zb, 'ko');
        if (real) flyStacks(zombieDrops(zb), zb.x, zb.y + ZOMBIE_HEIGHT / 2, zb.z);
      } else if (res === 'hit') {
        audio.playZombieHurt(1);
      }
    } else if (target.kind === 'animal') {
      const a = target.mob;
      // v0.14 (§76 fauna): only a spear catches a fish — a rock or a dart just scares it off
      const counts = isBodyAnimal(a) || getItem(it.s.k)?.tool?.type === 'spear';
      const res = animals.wound(a, real && !a.tamed && counts ? it.power : 0, fromX, fromZ);
      if (res === 'dead') animalDied(a, real);
      else if (res === 'hit') animalVoice(a, 1);
    } else {
      const pig = target.mob;
      if (real) {
        const res = pigs.wound(pig, it.power, fromX, fromZ);
        if (res === 'dead') {
          particles.emit('dust', pig.x, pig.y + 0.45, pig.z, 22, { color: [0.66, 0.57, 0.57], spread: 0.45 });
          audio.playSqueal(1);
          flyStacks(rollMobDrops('pig', Math.random), pig.x, pig.y + 0.45, pig.z);
        } else if (res === 'hit') {
          audio.playSqueal(1);
        }
      } else if (pigs.hit(pig, fromX, fromZ)) {
        audio.playSqueal();
      }
    }
    if (!real) return false;
    if (Math.random() < dartBreakP(it.s.k)) return true; // (0 for anything that is not a dart)
    const max = maxDurability(it.s.k);
    if (max > 0) {
      const d = (it.s.d ?? max) - 1;
      if (d <= 0) {
        toolBroke(it.s.k);
        return true;
      }
      it.s.d = d;
    }
    return false;
  }

  /** @type {import('./looseItems.js').LooseEnv} */
  const looseEnv = {
    solid: (x, y, z) => {
      if (!world) return false;
      const [q, r] = worldToHex(x, z);
      return isSolid(world.getBlock(q, Math.floor(y), r));
    },
    liquid: (x, y, z) => {
      if (!world) return false;
      const [q, r] = worldToHex(x, z);
      return isLiquid(world.getBlock(q, Math.floor(y), r));
    },
    loaded: (x, z) => Boolean(world && world.hasChunkAt(x, z)),
    player: null,
    collect: collectLoose,
    room: (st) => pack.canGive([...loose.inFlight(), { k: st.k, n: 1 }]),
    hitMob: looseHitMob,
    onHit: looseOnHit,
    onLand: (it, speed) => {
      if (speed > 5 && !it.ghost) audio.playRecipe(SOUND_THUNK, Math.min(0.6, speed / 20));
    },
    // §63: a lit campfire burns what lands in it; a despawn leaves a puff (smoke and a sizzle for the fire).
    burning: (x, y, z) => {
      if (!world) return false;
      const [q, r] = worldToHex(x, z);
      return world.getBlock(q, Math.floor(y), r) === BLOCK.CAMPFIRE;
    },
    onDespawn: looseDespawned,
  };

  /** §63: a loose item despawned: a puff where it was (smoke and a sizzle when it burned). */
  function looseDespawned(it, why) {
    if (why === 'fire') {
      particles.emit('smoke', it.x, it.y + 0.2, it.z, 6, { spread: 0.2 });
      audio.playSizzle(0.5);
    } else if (why === 'time' || why === 'clear') {
      particles.emit('dust', it.x, it.y, it.z, 4, { color: [0.85, 0.85, 0.8], spread: 0.15 });
    }
  }

  /** One step of the loose items: only Survival collects real items; ghosts fly in either mode. */
  function stepLoose(dt) {
    if (loose.count === 0) return;
    looseEnv.player = player && !survival.dead ? player : null;
    looseEnv.collect = survival.inSurvival ? collectLoose : null;
    loose.step(dt, looseEnv);
  }

  /**
   * Q / G and the drop / throw commands (§60): one item (or `n`, or 'all' for a drop) of the selected stack leaves the hand
   * — dropped in front of the feet, or thrown where the crosshair points (throwOf: rocks sting, darts and spears hurt,
   * anything else is chucked a short way). Creative throws a ghost of the hotbar block and takes nothing.
   * @param {'drop'|'throw'} kind
   * @param {number|'all'} n
   * @returns {{ ok: boolean, message: string, loud?: boolean }}
   */
  function handAction(kind, n) {
    if (!world || !player || survival.dead) return { ok: false, message: 'not now' };
    const SV = survival.inSurvival;
    /** @type {ItemStack} */
    let part;
    let block;
    if (SV) {
      const s = pack.slots[selected];
      if (!s) return { ok: false, message: 'nothing in hand' };
      if (isKept(s)) return { ok: false, message: KEEP_REFUSED, loud: true };
      const want = n === 'all' ? s.n : Math.max(1, Math.min(s.n, Math.floor(n)));
      part = { k: s.k, n: want };
      if (s.d !== undefined) part.d = s.d;
      block = looseBlockOf(s.k);
    } else {
      const id = hotbar[selected];
      const key = id ? itemForBlock(id) : null;
      if (!key) return { ok: false, message: 'nothing in hand' };
      part = { k: key, n: 1 };
      block = isMeshed(id) ? id : -1;
    }
    const yaw = controls.yaw;
    const pitch = controls.pitch;
    const cp = Math.cos(pitch);
    const dx = -Math.sin(yaw) * cp;
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * cp;
    const eyeY = player.y + getEyeHeight(player);
    const count = kind === 'throw' ? part.n : 1; // a throw sends its items one by one, a drop lets the stack go at once
    const per = kind === 'throw' ? { ...part, n: 1 } : part;
    for (let i = 0; i < count; i++) {
      let x;
      let y;
      let z;
      let vx;
      let vy;
      let vz;
      let power = 0;
      if (kind === 'throw') {
        const t = throwOf(per.k);
        power = t.power;
        const spread = count > 1 ? 0.06 : 0;
        const ax = dx + (Math.random() - 0.5) * spread;
        const ay = dy + (Math.random() - 0.5) * spread;
        const az = dz + (Math.random() - 0.5) * spread;
        x = player.x + dx * 0.35;
        y = eyeY - 0.1 + dy * 0.35;
        z = player.z + dz * 0.35;
        vx = ax * t.speed + (player.vx || 0);
        vy = ay * t.speed + 1.5;
        vz = az * t.speed + (player.vz || 0);
      } else {
        const fl = Math.hypot(dx, dz) || 1;
        x = player.x + (dx / fl) * 0.35;
        y = player.y + 1.1;
        z = player.z + (dz / fl) * 0.35;
        vx = (dx / fl) * DROP_SPEED;
        vy = 2;
        vz = (dz / fl) * DROP_SPEED;
      }
      if (looseEnv.solid(x, y, z)) {
        x = player.x;
        y = eyeY - 0.1;
        z = player.z;
      }
      loose.launch(per, x, y, z, vx, vy, vz, { block, ghost: !SV, power });
    }
    if (SV) pack.consume(selected, part.n);
    audio.playRecipe(SOUND_THROW, kind === 'throw' ? 0.7 : 0.35);
    const what = `${part.n} ${itemName(part.k)}`;
    return { ok: true, message: kind === 'throw' ? `threw ${what}` : `dropped ${what}` };
  }

  /** Put one `key` into the selected slot when it is empty (a drunk pot comes back into the hand), else anywhere. */
  function giveToHand(key) {
    if (!pack.slots[selected]) pack.setSlot(selected, { k: key, n: 1 });
    else giveStacks([{ k: key, n: 1 }]);
  }

  /** §66: once a session, after raw water poisoned the player: boil it. */
  let boilTipShown = false;
  function boilTip() {
    if (boilTipShown) return;
    boilTipShown = true;
    logLine(BOIL_TIP, false, INTRO_LINE_MS);
  }

  /** "Your Flint Axe broke." and the snap (§5.3). */
  function toolBroke(key) {
    logLine(`Your ${itemName(key)} broke.`);
    audio.playToolBreak();
  }

  /** The selected tool takes 1 wear (a block broken, a mob hit, §5.3); nothing for a bare hand or a non-tool item. */
  /**
   * 1 wear on the selected tool (§6.1 step 6): on a dig only a digging tool wears (axe, shovel, pick, knife, hammer), on a
   * blow everything but the kiln kit — a spear digs nothing and a crucible in the hand must not be used up by digging clay.
   * @param {'dig'|'strike'} how
   */
  function wearSelectedTool(how) {
    const s = pack.slots[selected];
    if (!s || maxDurability(s.k) === 0) return;
    const tool = pack.toolAt(selected);
    if (how === 'dig' ? !wearsFromDigging(tool) : !wearsFromStriking(tool)) return;
    const res = pack.damage(selected, 1);
    if (res && res.broke) toolBroke(res.key);
  }

  // ---- Survival: damage, death and waking (§2.4, §2.5) ----------------------------------------------

  /** Instant damage (§9.5 hurt): only while Survival is active; a lethal one only sets pendingDeath (never die() here). */
  function hurt(amount, cause) {
    if (!survival.active || !(amount > 0)) return;
    if (survival.damage(amount, cause)) {
      pendingDeath ??= cause; // die() closes the book itself without resuming play (no pointer lock under the death screen)
      return;
    }
    hurtFeedback(amount);
    closeRusticBook(); // §14.1: taking damage closes the field book
  }

  /** The hurt flash `min(1, 0.4 + dmg / 20)` and a hurt sound at most once per HURT_SOUND_GAP_S (§2.4). */
  function hurtFeedback(dmg) {
    hurtFlash = Math.max(hurtFlash, Math.min(1, 0.4 + dmg / 20));
    if (fxTime - hurtSoundAt >= HURT_SOUND_GAP_S) {
      hurtSoundAt = fxTime;
      audio.playHurt(1);
    }
  }

  /** A checkpoint (§2.5): run a pending death. @returns {boolean} the player died (the frame must end) */
  function checkDeath() {
    if (pendingDeath === null) return false;
    const cause = pendingDeath;
    pendingDeath = null;
    if (!survival.inSurvival || state === STATE.DEAD || !player) return false;
    die(cause);
    return true;
  }

  /**
   * §2.5 die(cause): close the pack screen, leave Your Belongings, then the death state, screen, sound and a save. Runs only
   * from the frame's checkpoints.
   */
  function die(cause) {
    loose.release(); // §60: what was flying to the player falls where it is
    if (riding) dismountHorse();
    // 1. The screen open over the running world: the pack screen (its cursor stack goes back first; overflow is lost), the
    // field book, or the device panel (its label flushes as it closes; its key capture goes with it).
    const open = screenClosedOnDeath(state);
    if (open === 'pack') closePack(false);
    else if (open === 'book') {
      setState(STATE.PLAYING); // first, so the book's onClose does not try to resume play
      handbookUI.close();
    } else if (open === 'device') closeDevicePanel(false); // still DEVICE: its label flushes; the death state follows
    // 2. The belongings: every pack and worn stack (the Handbook stays, §14.2) into a REMAINS cell — beyond MAX_CONTAINERS.
    const stacks = pack.dumpAll();
    /** @type {[number, number, number]|null} */
    let cell = null;
    if (stacks.length > 0 && cause !== 'blackhole' && cause !== 'void') {
      const [fq, fr] = worldToHex(player.x, player.z);
      const c = chooseBelongingsCell(world.getBlock, fq, Math.floor(player.y + 1e-3), fr);
      if (c && world.hasChunkAtCell(c[0], c[2]) && world.setBlock(c[0], c[1], c[2], BLOCK.REMAINS)) {
        containers.addRemains(c[0], c[1], c[2], stacks);
        cell = c;
      }
    }
    // 3. The state.
    survival.dead = cause;
    if (survival.vitals.health > 0) survival.vitals.health = 0;
    survival.deaths++;
    craftQueue.clear();
    resetSurvivalInput();
    leftHold.held = 0;
    placeHeld = 0;
    setState(STATE.DEAD); // before unlock(): the lock-change handler must not read 'playing' (pitfall 24)
    controls.setEnabled(false);
    controls.unlock();
    hud.setTargetHint(null);
    hud.setActionProgress(null);
    renderer.setDigProgress(null, 0);
    const text = deathScreenText(cause, cell, stacks.length > 0);
    menus.showDeath(text.title, text.detail, text.where || undefined);
    audio.playDeath();
    doSave(false);
  }

  /** The death screen again for a save that was left dead (§2.5 step 6): the nearest belongings are named, if any. */
  function showDeathAfterLoad() {
    const cause = survival.dead ?? 'command';
    /** @type {[number, number, number]|null} */
    let cell = null;
    let best = Infinity;
    for (const e of containers.entries.values()) {
      if (e.kind !== 'remains') continue;
      const [x, z] = hexToWorld(e.q, e.r);
      const d = Math.hypot(x - player.x, e.y - player.y, z - player.z);
      if (d < best) {
        best = d;
        cell = [e.q, e.y, e.r];
      }
    }
    const text = deathScreenText(cause, cell);
    menus.showDeath(text.title, text.detail, text.where || undefined);
  }

  /**
   * "Wake up" (§2.5 step 5): the waking values, then the Sleeping Hide (its chunk loaded for up to 200 ms behind the death
   * screen) or green land near the world spawn, out of black holes' reach; fallGrace; back to playing.
   */
  function wake() {
    if (state !== STATE.DEAD || !world || !player) return;
    survival.respawn();
    ensureHandbook(pack); // §14.2: back if it went missing
    /** @type {number[]|null} */
    let pos = null;
    const sp = survival.spawn;
    if (sp) {
      const [hx, hz] = hexToWorld(sp[0], sp[2]);
      const start = now();
      while (!world.hasChunkAtCell(sp[0], sp[2]) && now() - start < 200) world.update(hx, hz);
      if (!world.hasChunkAtCell(sp[0], sp[2])) {
        pos = [hx, sp[1] + 1, hz]; // still loading: trust the hide
      } else if (world.getBlock(sp[0], sp[1], sp[2]) === BLOCK.SLEEPING_HIDE) {
        const fy = findFreeY(world.getBlock, hx, hz, sp[1] + 1, 3);
        if (fy !== null) pos = [hx, fy, hz];
      } else {
        survival.spawn = null;
        logLine('Your Sleeping Hide is gone.');
      }
    }
    if (!pos) pos = blackHoles.respawnPoint(world.findSurvivalSpawn(), blackHoleWorld);
    game.teleport(pos[0], pos[1], pos[2]); // sets fallGrace and clears landSpeed
    hurtFlash = 0;
    menus.hideDeath();
    enterPlayingFromModal();
    doSave(false);
  }

  /** Forget every in-progress dig, use and hold, and the action ring. */
  function resetSurvivalInput() {
    digState.reset();
    useState.reset();
    holdState.reset();
    digHit = null;
    digProgress = 0;
    digAdvanced = false;
    digPackFull = false;
    useProgress = null;
    holdProgress = null;
    attackHeld = 0;
    rRepeat = 0;
  }

  // ---- Survival: switching modes (§1.1–§1.3) --------------------------------------------------------

  /** Queue a switch (the pause menu, the console and ?mode all come here); applied at the top of the next frame. */
  function requestMode(mode) {
    if (mode !== 'creative' && mode !== 'survival') return;
    pendingModeSwitch = { mode };
  }

  /**
   * Apply the queued switch (§9.5 top of the frame): close an open console or editor, then either switch in place or — a
   * generation-1 world going to Survival — upgrade it, which reloads the world. @returns {boolean} the world was replaced
   */
  function applyModeSwitch() {
    const { mode } = /** @type {{ mode: 'creative'|'survival' }} */ (pendingModeSwitch);
    pendingModeSwitch = null;
    if (!world || !player || survival.dead) return false;
    if (state === STATE.CONSOLE) closeConsole();
    if (state === STATE.EDITOR) closeEditor();
    if (mode === survival.mode) return false;
    if (mode === 'survival' && world.gen < 2) {
      upgradeToGen2();
      return true;
    }
    enterMode(mode);
    return false;
  }

  /** §1.3 the upgrade, exactly: gen and mode reach the store together, then the world reloads from that save. */
  function upgradeToGen2() {
    const data = /** @type {SaveData} */ (buildSaveData());
    data.gen = GEN_LATEST;
    data.mode = 'survival';
    data.player.flying = false;
    if (!params.nosave) {
      const res = saveSlot(currentSlot, data);
      if (!res.ok) hud.showSaveToast(saveFailMessage(res.reason), true);
    }
    upgradeNotePending = true;
    startLoading(world.seed, data);
  }

  /** §1.2 a switch in place: Survival begins (or comes back as it was left) or freezes; the HUD follows next frame. */
  function enterMode(mode) {
    const hadState = survival.hasState;
    if (!survival.setMode(mode)) return;
    if (mode === 'survival') {
      if (!hadState) {
        pack.clear();
        sayBeginLines(ensureHandbook(pack));
      }
      player.flying = false;
      player.landSpeed = 0;
      survival.fallGrace = true;
      climateSample = null;
    } else {
      craftQueue.clear();
      pendingDeath = null;
      if (state === STATE.PACK) closePack();
      loose.release(); // §60: Creative collects nothing; real items wait on the ground for Survival
    }
    resetSurvivalInput();
    updateHit();
    hud.showSaveToast(mode === 'survival' ? 'Survival' : 'Creative');
    if (state === STATE.PAUSED) {
      menus.setModeState(mode);
      menus.setPhysicsState(physicsMenuState());
    }
    doSave(false);
  }

  /** The §1.2 chat lines for a survival state that has just begun (§14.2's Handbook sentence when one was given). */
  function sayBeginLines(handbookGiven) {
    const [q, r] = worldToHex(player.x, player.z);
    const [gx, , gz] = world.findSurvivalSpawn();
    // The intro is the only pointer to the Handbook, so it outlives an ordinary chat line (INTRO_LINE_MS, §1.2).
    for (const line of survivalIntroLines(world.getBiome(q, r), worldToHex(gx, gz), handbookGiven)) logLine(line, false, INTRO_LINE_MS);
  }

  // ---- Survival: the target hint (§9.5 targetHintText) -----------------------------------------------

  /** @returns {import('./survivalControl.js').InteractAction|null} what R would do now (§9.4) */
  function interactAction() {
    interactCtx.hit = hit;
    interactCtx.waterHit = waterHit;
    interactCtx.headInWater = Boolean(player && player.headInWater);
    interactCtx.selectedKey = selectedKey();
    return interactKind(interactCtx); // §14.2 priority 10: with the Handbook in hand and nothing else to do → `read`
  }

  /** @returns {string|null} the Survival target hint */
  function survivalHintText() {
    if (litTarget) return 'lit keg · left-click: put it out';
    if (zombieTarget) return 'Zombie · click: hit it';
    if (pigTarget) return selectedTool() ? 'Pig · click: hunt it' : 'Pig · click: shove it (hunting needs a tool)';
    if (animalTarget) return animalHint(animalTarget.animal);
    if (hit && hit.blockId === BLOCK.SNARE) return 'Snare · R with food in hand: bait it';
    if (hit && hit.blockId === BLOCK.SNARE_BAITED) return 'Baited Snare · animals nearby will come to it';
    if (hit && hit.blockId === BLOCK.SNARE_SPRUNG) return 'Sprung Snare · it holds what it caught for a while';
    // v0.14 (§76 fauna)
    if (hit && hit.blockId === BLOCK.GROUND_NEST_EMPTY) return 'Empty Nest · a hen left in peace lays in it again';
    if (digPackFull && digState.active) return HINT.packFull;
    const act = interactAction();
    if (act) {
      switch (act.kind) {
        case 'fire_put':
        case 'fire_feed':
        case 'fire_take':
        case 'fire_hint':
          return campfireHintText(act);
        case 'pit_take':
        case 'pit_relight':
        case 'pit_hint':
          return pitHintText(act, act.kind === 'pit_take' ? pitStatus(act) : '');
        case 'pick':
          // §70: the loose stones that show a dark flint nodule hold flint, and say so.
          if (act.id === BLOCK.LOOSE_STONES) return flintAt(act.q, act.r) ? 'Loose Stones with Flint · R: pick' : 'Loose Stones · R: pick';
          if (act.id === BLOCK.GROUND_NEST) return 'Ground Nest · R: take the eggs'; // v0.14 (§76 fauna)
          return `${getBlockDef(/** @type {number} */ (act.id)).displayName} · R: pick`;
        case 'read':
          return 'Handbook · R: read';
        case 'drink_here':
          return waterHint(qualityHere(), false);
        default:
          if (act.hint) return act.hint;
      }
    }
    const h = hit;
    if (h) {
      const burning = burningKegHint(h, blockPhysics ? blockPhysics.explosions : null);
      if (burning) return burning; // before the tool requirement: a left press puts it out with any tool or none
      const tool = selectedTool();
      if (!canHarvest(h.blockId, tool)) {
        const need = harvestHint(h.blockId);
        if (need) return need;
      }
      // §6.2: the Handbook's bare-hand targets that R does not pick say how they are taken (`Tussock Grass · hold LMB: pull`)
      const gather = handGatherHint(h.blockId);
      if (gather) return gather;
    }
    return blockHintText();
  }

  /** What a cold pit still holds (`fireHint` of its spots), for `pitHintText`. @param {import('./survivalControl.js').InteractAction} act */
  function pitStatus(act) {
    return fireHint(fireSlots.view(/** @type {number} */ (act.q), /** @type {number} */ (act.y), /** @type {number} */ (act.r)));
  }

  /** `Campfire · 3 roasting (next 14 s) · 2 done · fuel 4:10 · R: take` (§4.4). */
  function campfireHintText(act) {
    const view = fireSlots.view(/** @type {number} */ (act.q), /** @type {number} */ (act.y), /** @type {number} */ (act.r));
    const status = fireHint(view);
    const head = status ? `Campfire · ${status}` : 'Campfire';
    switch (act.kind) {
      case 'fire_put':
        return `${head} · R: ${act.spot === 'skewer' ? 'put it on a skewer' : 'set it in the embers'}`;
      case 'fire_feed': {
        const fuel = view ? view.fuel : null;
        if (fuel === null) return `${head} · ${HINT.noFuel}`;
        if (fuel >= CAMPFIRE_FUEL_MAX_S) return `${head} · ${HINT.fullyFed}`;
        return `${head} · R: feed the fire`;
      }
      case 'fire_take':
        return `${head} · R: take`;
      default:
        return status ? `${head} · hold food or a pot and press R` : HINT.fire;
    }
  }

  /**
   * §76 water: what the water in cell (q, y, r) is to drink — 'tainted' for a Tainted Water source and for flowing or
   * falling water traced back to one (fluids.waterQualityAt), else 'salt' in an OCEAN / BEACH column — but never in the
   * column of a generated stream, which runs fresh across the beach to the sea — else 'fresh'.
   * @returns {import('./survivalControl.js').WaterQuality}
   */
  function waterQualityOf(q, y, r) {
    const salty = isSaltyBiome(world.getBiome(q, r));
    const gen = /** @type {{ streamAt?: (q: number, r: number) => boolean }} */ (world.worldGen); // (a test's generator has none)
    const stream = salty && typeof gen.streamAt === 'function' && gen.streamAt(q, r);
    return waterKind(waterQualityAt(world.getBlock, q, y, r) === 'tainted', salty, stream);
  }

  /** @returns {import('./survivalControl.js').WaterQuality} the water round the player's head (drinking with the head under water) */
  function qualityHere() {
    const [q, r] = worldToHex(player.x, player.z);
    return waterQualityOf(q, Math.floor(player.y + getEyeHeight(player)), r);
  }

  // ---- Survival: R (§9.4 priorities) -----------------------------------------------------------------

  /** R kinds that repeat while R is held (§4.4: put and feed every 0.25 s; gulps are throttled by GULP_GAP_S). */
  const R_REPEATS = new Set(['fire_put', 'fire_feed', 'drink', 'drink_here']);

  /**
   * R in Survival: tap and relight are held (holdState); put, feed and drinking repeat while held; anything else acts on the
   * press. With nothing to do, the rune, then the keg or charge explanation (interactTarget; the parts' own R actions and
   * the pocket key came earlier, as interactKind's `circuit` and `pocket` kinds, DESIGN-circuits §4.9).
   */
  function survivalR(pressed, dt) {
    const held = controls.isDown('KeyR');
    const act = interactAction();
    if (act && (act.kind === 'tap' || act.kind === 'pit_relight')) {
      const use = { kind: act.kind, key: selectedKey(), needS: act.needS ?? 0, target: [act.q, act.y, act.r], repeat: false };
      const res = holdState.step(dt, /** @type {*} */ (use), held || pressed);
      holdProgress = held || pressed ? res.progress : null;
      if (res.done) {
        holdProgress = null;
        doHoldAction(act);
      }
      return;
    }
    holdState.step(dt, null, false);
    holdProgress = null;
    if (pressed) {
      rRepeat = 0;
      if (act) doInteract(act);
      else interactTarget();
    } else if (held && act && R_REPEATS.has(act.kind)) {
      rRepeat += dt;
      if (rRepeat >= R_REPEAT_S) {
        rRepeat -= R_REPEAT_S;
        doInteract(act);
      }
    } else {
      rRepeat = 0;
    }
  }

  /** One R action (§4, §5.6, §6.4, §7.1). */
  function doInteract(act) {
    const { q, y, r } = /** @type {{q: number, y: number, r: number}} */ (act);
    switch (act.kind) {
      case 'fire_put': {
        const [fx, fz] = hexToWorld(q, r);
        const spot = fireSlots.put(q, y, r, act.key, Math.atan2(player.z - fz, player.x - fx));
        if (spot < 0) {
          showHint(HINT.fire);
          return;
        }
        pack.consume(selected, 1);
        audio.playClick();
        return;
      }
      case 'fire_feed': {
        const res = fireSlots.addFuel(q, y, r, act.seconds);
        if (res === 'ok') {
          pack.consume(selected, 1);
          audio.playCrackle(1);
          const [fx, fz] = hexToWorld(q, r);
          particles.emit('sparks', fx, y + 0.4, fz, 6, { speed: 0.4 });
        } else {
          showHint(res === 'full' ? HINT.fullyFed : HINT.noFuel);
        }
        return;
      }
      case 'fire_take':
      case 'pit_take': {
        const from = screenPointOfCell(q, y, r);
        const taken = fireSlots.takeReady(q, y, r, (k) => pack.add({ k, n: 1 }) === null);
        if (taken.length === 0) {
          showHint(HINT.packFull);
          return;
        }
        for (const s of taken) hud.addPickup(s.k, s.n, from);
        audio.playPick();
        return;
      }
      case 'pick':
        pickAt(q, y, r, /** @type {number} */ (act.id));
        return;
      case 'basket':
        if (!containers.ensureBasket(q, y, r)) {
          showHint(HINT.basketFull);
          return;
        }
        openPack({ container: [q, y, r] });
        return;
      case 'belongings': {
        const res = containers.takeAll(q, y, r, pack);
        const from = screenPointOfCell(q, y, r);
        for (const s of res.moved) hud.addPickup(s.k, s.n, from);
        if (res.empty) {
          playerSetBlock(q, y, r, BLOCK.AIR); // emptied: the heap is gone (§2.5)
          audio.playPick();
        } else {
          showHint(res.moved.length ? 'Your pack is full: the rest is still there' : HINT.packFull);
          if (res.moved.length) audio.playPick();
        }
        return;
      }
      case 'hide':
        survival.spawn = [q, y, r];
        logLine('You will wake at this Sleeping Hide.');
        audio.playClick();
        return;
      case 'station':
        openPack({ tab: act.station });
        return;
      case 'station_far':
        return; // the target hint says to step closer (§7.2): Making would only grey every card of that workplace
      case 'fill': {
        if (selectedKey() !== 'clay_pot') return;
        // §76 water: the pot holds what the water is — Pot of Water, Pot of Seawater or Pot of Tainted Water
        const quality = act.quality ?? waterQualityOf(q, y, r);
        pack.consume(selected, 1);
        giveToHand(WATER_POTS[quality]);
        audio.playPick();
        return;
      }
      case 'drink':
      case 'drink_here': {
        if (fxTime - gulpAt < GULP_GAP_S) return;
        gulpAt = fxTime;
        const quality = act.kind === 'drink' ? (act.quality ?? waterQualityOf(q, y, r)) : qualityHere();
        const line = survival.drink(quality, Math.random);
        audio.playDrink();
        if (line) logLine(line);
        if (line === SICK_MESSAGE) boilTip(); // §66: the first raw-water poisoning says how to make water safe
        return;
      }
      case 'read':
        openBook();
        return;
      case 'circuit': {
        // §8.3: a fuse lit by hand wears the Fire Drill once (interactKind only offers it with one in the pack).
        if (!circuits) return;
        const isFuse = world.getBlock(q, y, r) === BLOCK.POWDER_FUSE;
        const res = circuits.interact(q, y, r, 'r');
        if (!res) return;
        afterPartAction(/** @type {RaycastHit} */ (hit ?? { q, y, r, blockId: world.getBlock(q, y, r) }), res);
        if (isFuse && res.ok) {
          const used = pack.useTool('firestarter', 0);
          if (used && used.broke) toolBroke(used.key);
        }
        return;
      }
      case 'pocket':
        pocketSend();
        return;
      default:
        if (act.hint) showHint(act.hint); // fire_hint, pit_hint, tap_hint, fuse_hint
    }
  }

  /** The end of a held R (§4.2 tapping birch sap, §4.4 relighting a fire pit); every condition is checked again. */
  function doHoldAction(act) {
    const { q, y, r } = act;
    if (act.kind === 'tap') {
      const key = `${q},${y},${r}`;
      if (world.getBlock(q, y, r) !== BLOCK.BIRCH_LOG || selectedKey() !== 'clay_pot' || !pack.hasTool('knife', KNIFE_TIER)) return;
      if (!tapped.canTap(key, day)) {
        showHint(HINT.tapped);
        return;
      }
      pack.consume(selected, 1);
      giveToHand('pot_sap');
      const used = pack.useTool('knife', KNIFE_TIER);
      if (used && used.broke) toolBroke(used.key);
      tapped.mark(key, day);
      audio.playDrink();
      return;
    }
    // pit_relight: the drill, 1 tinder and 3 sticks are taken only once the fire is lit.
    if (world.getBlock(q, y, r) !== BLOCK.FIRE_PIT) return;
    if (!pack.hasTool('firestarter', 0) || pack.countTag('tinder') < 1 || pack.count('stick') < 3) {
      showHint(HINT.pit);
      return;
    }
    if (wouldDouseCampfire(world.getBlock, BLOCK.CAMPFIRE, q, y, r) || !playerSetBlock(q, y, r, BLOCK.CAMPFIRE)) return;
    pack.takeTag('tinder', 1);
    pack.take('stick', 3);
    const used = pack.useTool('firestarter', 0);
    if (used && used.broke) toolBroke(used.key);
    fireSlots.light(q, y, r, CAMPFIRE_FUEL_START_S);
    audio.playCrackle(1);
  }

  /** §70: whether loose stones give flint is what the player sees there (blocks.flintAt), not a roll. */
  function flintDecided(id, q, r) {
    return id === BLOCK.LOOSE_STONES ? { flint: flintAt(q, r) } : undefined;
  }

  /** §6.4 picking with R: natural before the write, room checked, the picked block written by the player. */
  function pickAt(q, y, r, id) {
    const natural = !world.hasEdit(q, y, r);
    const res = pick(id, { natural, knifeInPack: pack.hasTool('knife', KNIFE_TIER), decided: flintDecided(id, q, r) }, Math.random);
    if (!res) return;
    if (!pack.canGive([...loose.inFlight(), ...res.drops])) {
      showHint(HINT.packFull);
      return;
    }
    if (!playerSetBlock(q, y, r, res.to)) return;
    flyFromCell(res.drops, q, y, r);
    audio.playPick();
    const [x, z] = hexToWorld(q, r);
    if (id === BLOCK.LOOSE_STONES) particles.emit('dust', x, y + 0.2, z, 4, { color: [0.55, 0.53, 0.5], spread: 0.3 });
    else particles.emit('leaves', x, y + 0.4, z, 4, { id, spread: 0.3 });
    updateHit();
  }

  // ---- Survival: left mouse — strike or hold to dig (§6.1) --------------------------------------------

  function survivalLeft(mouse, dt) {
    digAdvanced = false;
    // §3.2 / §8.3: a left press on a keg burning in place pinches its fuse out (no dig).
    if (isBurningKeg(hit)) {
      digStep(0, false);
      if (mouse.leftPressed) snuffTargetedKeg();
      return;
    }
    if (litTarget) {
      digStep(0, false);
      if (mouse.leftPressed) breakTargeted(); // a click snuffs a lit barrel, as today
      return;
    }
    if (zombieTarget || pigTarget || animalTarget) {
      digStep(0, false);
      if (mouse.leftPressed) {
        attackHeld = 0;
        strike();
      } else if (mouse.left) {
        attackHeld += dt;
        if (attackHeld >= ATTACK_REPEAT_S) {
          attackHeld -= ATTACK_REPEAT_S;
          strike();
        }
      } else {
        attackHeld = 0;
      }
      return;
    }
    attackHeld = 0;
    digStep(dt, mouse.left);
  }

  /**
   * One frame of hold-to-dig on `hit` (§6.1): the dig trace and the ring follow `t / need`; every DIG_TICK_S a dig sound
   * and 3 dust motes at the hit face (a dull sound every 0.5 s for a block the hand cannot break); done → finishDig.
   * @returns {{progress: number, done: boolean, tick: boolean}}
   */
  function digStep(dt, held) {
    const h = hit;
    const stack = selectedStack();
    const tool = selectedTool();
    const need = h ? breakSeconds(h.blockId, tool, Boolean(player.headInWater)) : Infinity;
    const res = digState.step(dt, h, held, need, handKeyOf(selected, stack));
    if (!digState.active) digPackFull = false;
    digHit = digState.active ? h : null;
    digProgress = digState.active ? res.progress : 0;
    if (!h || !held) return res;
    const finite = Number.isFinite(need);
    if (finite && !res.done && dt > 0) digAdvanced = true;
    if (res.tick) {
      audio.playDig(getBlockDef(h.blockId).soundGroup, finite ? 0.35 : 0.15);
      if (finite) {
        const [x, z] = hexToWorld(h.q, h.r);
        particles.emit('dust', x + h.nx * 0.52, h.y + 0.5 + h.ny * 0.52, z + h.nz * 0.52, 3, { id: h.blockId, spread: 0.2 });
      }
    }
    if (res.done) finishDig(h, tool);
    return res;
  }

  /** §6.1 finishing a dig, in order: natural (before the break), drops, room, the break as the player, sound, drops, wear. */
  function finishDig(h, tool) {
    const id = h.blockId;
    const natural = !world.hasEdit(h.q, h.y, h.r);
    const drops = rollDrops(id, tool, { natural, knifeInPack: pack.hasTool('knife', KNIFE_TIER), deep: isDeep(h.y), decided: flintDecided(id, h.q, h.r) }, Math.random);
    // A basket, belongings or a fire also give what they hold (§5.6, §4.4): all of it must fit.
    const held = [...containers.contents(h.q, h.y, h.r)];
    const view = id === BLOCK.CAMPFIRE || id === BLOCK.FIRE_PIT ? fireSlots.view(h.q, h.y, h.r) : null;
    if (view) for (const s of view.spots) if (s) held.push({ k: s.k, n: 1 });
    if (!pack.canGive([...loose.inFlight(), ...drops, ...held])) {
      digPackFull = true; // the dig stays complete and finishes as soon as there is room (§6.1 step 3)
      return;
    }
    let ok;
    releaseToPack = true;
    try {
      ok = playerSetBlock(h.q, h.y, h.r, BLOCK.AIR);
    } finally {
      releaseToPack = false;
    }
    digState.reset();
    digHit = null;
    digProgress = 0;
    digPackFull = false;
    if (!ok) return;
    audio.playBreak(getBlockDef(id).soundGroup);
    flyFromCell(drops, h.q, h.y, h.r);
    wearSelectedTool('dig');
    updateHit();
  }

  /** LMB on a mob (§4.3, §6.1): zombies take the tool's power; pigs are wounded only by a tool, shoved by a hand. */
  function strike() {
    const tool = selectedTool();
    if (zombieTarget) {
      const zb = zombieTarget.zombie;
      const res = zombies.hit(zb, player.x, player.z, strikeKind('zombie', tool).power);
      if (res === 'ko') {
        zombieGone(zb, 'ko');
        flyStacks(zombieDrops(zb), zb.x, zb.y + ZOMBIE_HEIGHT / 2, zb.z);
      } else if (res === 'hit') {
        audio.playZombieHurt(1);
      }
      if (res) wearSelectedTool('strike');
      updateHit();
      return;
    }
    if (animalTarget) {
      const a = animalTarget.animal;
      if (a.tamed) {
        showHint(`Your ${SPECIES[a.kind].name.toLowerCase()} trusts you.`);
        return;
      }
      const ka = strikeKind('pig', tool); // like a pig: only a tool wounds, a bare hand shoves
      // v0.14 (§76 fauna): a fish is caught with a spear's thrust and nothing else (anything else only scares it)
      const spearOnly = !isBodyAnimal(a) && tool?.type !== 'spear';
      if (spearOnly) showHint('A fish is caught with a spear: thrust with it, or throw it (G).');
      const wounds = ka.call === 'wound' && !spearOnly;
      const res = animals.wound(a, wounds ? ka.power : 0, player.x, player.z);
      if (res === 'dead') animalDied(a, true);
      else if (res === 'hit') animalVoice(a, 1);
      if (res && wounds) wearSelectedTool('strike');
      updateHit();
      return;
    }
    if (!pigTarget) return;
    const pig = pigTarget.pig;
    const k = strikeKind('pig', tool);
    if (k.call === 'wound') {
      const res = pigs.wound(pig, k.power, player.x, player.z);
      if (res === 'dead') {
        particles.emit('dust', pig.x, pig.y + 0.45, pig.z, 22, { color: [0.66, 0.57, 0.57], spread: 0.45 });
        audio.playSqueal(1);
        flyStacks(rollMobDrops('pig', Math.random), pig.x, pig.y + 0.45, pig.z);
      } else if (res === 'hit') {
        audio.playSqueal(1);
      }
      if (res) wearSelectedTool('strike');
    } else if (pigs.hit(pig, player.x, player.z)) {
      audio.playSqueal();
    }
    updateHit();
  }

  // ---- Survival: right mouse — place or use the item in hand (§5.3, §4.5) ----------------------------

  function survivalRight(mouse, dt) {
    // §4.9 / §8.3: a press on a control (no Shift) operates it before "use the item in hand" (the Handbook's read-on-RMB
    // too), and while that press is held nothing is used or placed (the control latch).
    const shift = controls.isDown('ShiftLeft') || controls.isDown('ShiftRight');
    if (mouse.rightPressed ? controlLatch.press(hit, shift, latchEnv) : mouse.right && controlLatch.holding(hit, latchEnv)) {
      useState.step(dt, null, false);
      useProgress = null;
      placeHeld = 0;
      return;
    }
    if (!mouse.right) controlLatch.release();
    const stack = selectedStack();
    if (stack && stack.k === HANDBOOK_KEY) {
      useState.step(dt, null, false);
      useProgress = null;
      if (mouse.rightPressed) openBook(); // §14.2: RMB opens it at once, no hold
      return;
    }
    const act = useActionOf(stack);
    if (act && act.kind === 'place') {
      useState.step(dt, null, false);
      useProgress = null;
      if (mouse.rightPressed) {
        survivalPlace();
        placeHeld = 0;
      } else if (mouse.right) {
        if (repeatBlocked(hit, shift, latchEnv.isControl)) return; // never placed against a control without Shift
        placeHeld += dt;
        if (placeHeld >= PLACE_REPEAT_S) {
          placeHeld -= PLACE_REPEAT_S;
          survivalPlace();
        }
      } else {
        placeHeld = 0;
      }
      return;
    }
    placeHeld = 0;
    const use = act ? { kind: act.kind, key: act.key, needS: act.needS, repeat: act.repeat, target: String(selected) } : null;
    const res = useState.step(dt, /** @type {*} */ (use), Boolean(mouse.right));
    useProgress = use && mouse.right ? res.progress : null;
    if (res.done && act) useItem(act);
  }

  /** The end of a held RMB use: eat or drink (a pot comes back into the hand), bandage, or wear. */
  function useItem(act) {
    const s = pack.slots[selected];
    if (!s || s.k !== act.key) return;
    if (act.kind === 'eat' || act.kind === 'drink') {
      const res = survival.eat(act.key, Math.random);
      if (!res.ok) {
        if (res.message) showHint(res.message);
        return;
      }
      pack.consume(selected, 1);
      if (res.returns) giveToHand(res.returns);
      if (act.kind === 'drink') audio.playDrink();
      else audio.playEat();
      if (res.message) logLine(res.message);
      if (res.message === SICK_MESSAGE && (act.key === 'pot_water' || act.key === 'pot_tainted')) boilTip();
    } else if (act.kind === 'bandage') {
      if (!survival.bandage(act.key)) {
        showHint('No more healing can be queued yet');
        return;
      }
      pack.consume(selected, 1);
      audio.playPick();
    } else if (act.kind === 'wear') {
      if (pack.equip(selected)) audio.playClick();
    }
  }

  /** §5.3 placing in Survival: Creative's rules with the stack's block; a pop-off block needs solid ground; uses 1. */
  function survivalPlace() {
    const def = getItem(selectedKey() ?? '');
    if (!def || def.block === undefined) return false;
    const id = def.block;
    const cell = placeTarget();
    if (!cell) return false;
    const refusal = placeRefusal(world.getBlock, id, cell[0], cell[1], cell[2]);
    if (refusal) {
      showHint(refusal);
      return false;
    }
    if (!placeBlockAt(id, cell)) return false;
    pack.consume(selected, 1);
    if (id === BLOCK.CAMPFIRE) fireSlots.light(cell[0], cell[1], cell[2], CAMPFIRE_FUEL_START_S); // §4.4: it needs fuel
    if (id === BLOCK.RUNE_BLOCK && state === STATE.PLAYING) openEditorFor(cell[0], cell[1], cell[2]);
    partPlaced(id, cell);
    return true;
  }

  /** Middle mouse in Survival (§5.3): select a hotbar slot holding the targeted block's item; never conjure one. */
  function selectSlotHolding(h) {
    if (!h) return;
    const i = pack.hotbarSlotOf(itemForBlock(h.blockId));
    if (i < 0) return;
    selectSlot(i);
    audio.playClick();
  }

  /** The action ring (§9.8): the dig, else a held use, else a held R. */
  function actionProgress() {
    if (digProgress > 0) return digProgress;
    if (useProgress !== null) return useProgress;
    if (holdProgress !== null) return holdProgress;
    return null;
  }

  // ---- Survival: the step (§9.5 step 12) -------------------------------------------------------------

  /** Everything that runs only while Survival is active; `buried` comes from unstickPlayer. */
  function stepSurvival(dt, buried) {
    climateAccum += dt;
    if (climateSample === null || climateAccum >= CLIMATE_SAMPLE_S) {
      climateAccum = 0;
      refreshClimate();
    }
    const sample = /** @type {NonNullable<typeof climateSample>} */ (climateSample);
    // The body: soft landings from the cells under the feet (only worth the scan for a hard landing).
    let softFactor = 1;
    if (player.landSpeed > FALL_SAFE_SPEED) {
      supportingCells(player, world.getBlock, supportScratch);
      supportIds.length = 0;
      for (const c of supportScratch) supportIds.push(world.getBlock(c[0], c[1], c[2]));
      softFactor = softLandingFactor(supportIds);
    }
    const env = survivalEnv;
    env.player = player;
    env.softFactor = softFactor;
    env.breaking = digAdvanced;
    env.buried = buried;
    env.climate = sample;
    env.heat = sample.heat;
    env.nearFire = sample.nearFire;
    env.insulation = pack.insulation();
    env.sunShade = pack.sunShade();
    env.time = time;
    const ev = survival.step(dt, /** @type {*} */ (env));
    if (ev.died) pendingDeath ??= ev.died;
    else if (ev.fall > 0) hurtFeedback(ev.fall);
    if (ev.pulse && !ev.died) {
      hurtFlash = Math.max(hurtFlash, 0.4);
      audio.playHurt(0.4);
    }
    if (ev.damage > 0) closeRusticBook();

    // The craft lanes (§7.2): a lane's head job runs while its station is still there within STATION_WORK_RANGE.
    const [fq, fr] = worldToHex(player.x, player.z);
    feetCell[0] = fq;
    feetCell[1] = Math.floor(player.y + 1e-3);
    feetCell[2] = fr;
    if (craftQueue.size > 0) {
      const cev = craftQueue.step(dt, pack, peekBlockFn, feetCell);
      for (const line of cev.messages) logLine(line, true);
      for (const key of cev.broke) toolBroke(key);
      if (cev.done.length > 0) audio.playCraft();
      if (cev.lost.length > 0) leftBehind(cev.lost);
    }

    // Fire spots and fuel (§4.4): a burnt-out fire becomes a cold FIRE_PIT (a plain write; the spots stay on it).
    if (fireSlots.size > 0) {
      const fev = fireSlots.step(dt, isBurningFn, isLoadedCellFn);
      for (const [q, y, r] of fev.burntOut) {
        if (world.getBlock(q, y, r) !== BLOCK.CAMPFIRE) continue;
        world.setBlock(q, y, r, BLOCK.FIRE_PIT);
        const [x, z] = hexToWorld(q, r);
        particles.emit('smoke', x, y + 0.4, z, 10, { spread: 0.3 });
      }
      fireEffects(dt, fev.cooking);
    }

    // Once a second: regrowth (lazy writes of the ripe id), spoilage in the pack and in loaded containers (§4.5, §6.5).
    survivalSecond += dt;
    if (survivalSecond >= 1) {
      survivalSecond = Math.min(survivalSecond - 1, 1);
      for (const c of regrowth.step(1, Math.random, isLoadedCellFn)) {
        if (ripeOf(world.getBlock(c.q, c.y, c.r)) === c.id) world.setBlock(c.q, c.y, c.r, c.id, true);
      }
      const bad = pack.spoil(1, Math.random);
      if (bad.length > 0 && fxTime - spoilLineAt >= 2) {
        spoilLineAt = fxTime;
        logLine(spoiledText(bad));
      }
      containers.spoil(1, Math.random, isLoadedCellFn);
    }

    // Pigs repopulate in daylight (§4.3).
    pigRepopAccum += dt;
    if (pigRepopAccum >= PIG_REPOP_CHECK_S) {
      pigRepopAccum = 0;
      if (isDayTime(time)) repopulatePigs();
    }

    if (player.y < VOID_Y) pendingDeath ??= 'void';
  }

  /** Sample the climate, the heat sources and the workplaces near the player (every CLIMATE_SAMPLE_S, §3.1, §7.1). */
  function refreshClimate() {
    const s = sampleClimate(world, player);
    /** @type {{x: number, y: number, z: number, heat: number, radius: number}[]} */
    const sources = [];
    let nearFire = false;
    if (campfires.size > 0) {
      for (const n of campfires.nearest(player.x, player.y, player.z, HEAT_SOURCES.campfire.radius + 2)) {
        const src = heatSource('campfire', n.fire.q, n.fire.y, n.fire.r);
        if (src) sources.push(src);
        if (n.dist <= NEAR_FIRE_CELLS) nearFire = true;
      }
    }
    // A workplace is hot while its lane runs a job (the lane's head, not waiting).
    const seen = new Set();
    for (const job of craftQueue.jobs()) {
      if (seen.has(job.station)) continue;
      seen.add(job.station);
      if (job.at && job.reason === '' && job.station !== 'stump' && job.station !== 'hand') {
        const src = heatSource(/** @type {*} */ (job.station), job.at[0], job.at[1], job.at[2]);
        if (src) sources.push(src);
      }
    }
    s.heat = heatAt(sources, player.x, player.y + CHEST_HEIGHT, player.z);
    s.nearFire = nearFire;
    climateSample = s;
    const [q, r] = worldToHex(player.x, player.z);
    const next = findStations(world.getBlock, q, Math.floor(player.y + 1e-3), r);
    if (stationsKey(next) !== stationsKey(stations)) {
      stations = next;
      stationsVersion++;
    }
  }

  /** @returns {string} a comparable key of a findStations result */
  function stationsKey(st) {
    return ['stump', 'kiln', 'bloomery', 'forge'].map((k) => (st[k] ? st[k].join(',') : '-')).join('|');
  }

  /** §4.3: prune one far pig at the cap, then bring two more when fewer than PIG_REPOP_TARGET are within reach. */
  function repopulatePigs() {
    if (pigs.size >= PIG_MAX) pigs.pruneFar(player.x, player.z, isLoadedCellFn, 2 * PIG_REPOP_RADIUS);
    let near = 0;
    for (const p of pigs.list) if (Math.hypot(p.x - player.x, p.z - player.z) <= PIG_REPOP_RADIUS) near++;
    if (near >= PIG_REPOP_TARGET || pigs.size >= PIG_MAX) return;
    const [pq, pr] = worldToHex(player.x, player.z);
    pigRepopTries++;
    const seed = (world.seed ^ (day * 7919 + pigRepopTries)) >>> 0;
    pigs.spawnNatural(Math.min(2, PIG_MAX - pigs.size), pq, pr, seed, world.getBlock, isLoadedCellFn, PIG_REPOP_MIN,
      PIG_REPOP_MAX, SURVIVAL_PIG_GROUND);
  }

  /** Smoke over meat, steam over pots and a soft sizzle within 6 cells (§4.4), for the fires near the player. */
  function fireEffects(dt, cooking) {
    if (!(cooking > 0) || campfires.size === 0) return;
    let sizzle = 0;
    for (const n of campfires.nearest(player.x, player.y, player.z, 16, CAMPFIRE_MAX_MODELS)) {
      const view = fireSlots.view(n.fire.q, n.fire.y, n.fire.r);
      if (!view) continue;
      const [x, z] = hexToWorld(n.fire.q, n.fire.r);
      let meat = false;
      let pot = false;
      view.spots.forEach((s, i) => {
        if (!s || s.next === null) return;
        if (i === 6) pot = true;
        else meat = true;
      });
      if (meat && Math.random() < dt * 3) particles.emit('smoke', x, n.fire.y + 0.75, z, 1, { spread: 0.25, color: [0.5, 0.48, 0.46] });
      if (pot && Math.random() < dt * 4) particles.emit('steam', x, n.fire.y + 0.7, z, 1, { spread: 0.1 });
      if ((meat || pot) && n.dist < 6) sizzle = Math.max(sizzle, 1 - n.dist / 6);
    }
    if (sizzle > 0 && fxTime - sizzleAt > 1.2) {
      sizzleAt = fxTime;
      audio.playSizzle(sizzle);
    }
  }

  // ---- Survival: the Pack & Making screen (§5.4, §9.8) ------------------------------------------------

  /**
   * Open the pack screen (E, R on a basket or a workplace). The world keeps running (§9.5): stepFrame steps PACK like PLAYING
   * with the controls disabled.
   * @param {{ container?: [number, number, number], tab?: string }} [opts]
   */
  function openPack(opts = {}) {
    if (state !== STATE.PLAYING || !survival.inSurvival) return;
    setState(STATE.PACK); // before unlock(): the lock-change handler must not read 'playing'
    controls.setEnabled(false);
    controls.unlock();
    leftHold.held = 0;
    placeHeld = 0;
    resetSurvivalInput();
    packSession.cursor = null;
    packSession.container = null;
    packContainer = null;
    packMessage = null;
    if (opts.container) {
      const [q, y, r] = opts.container;
      const entry = containers.get(q, y, r);
      if (entry) {
        packSession.container = entry.slots;
        packContainer = { q, y, r, entry };
      }
    }
    if (opts.tab) packTab = opts.tab;
    refreshClimate(); // the workplaces near the player, now
    packViewKey = packKey();
    packUI.open(packScreenView());
  }

  /** Close the pack screen: the cursor stack goes back (overflow is lost with the message), then back to playing. */
  function closePack(relock = true) {
    if (state !== STATE.PACK) return;
    const left = returnCursor(packSession);
    if (left) leftBehind([left]);
    packSession.container = null;
    packContainer = null;
    packUI.close();
    if (relock) enterPlayingFromModal();
    else setState(STATE.PLAYING);
  }

  /** @returns {import('./survivalControl.js').PackView} */
  function packScreenView() {
    return buildPackView({
      pack,
      selected,
      cursor: packSession.cursor,
      hover: null,
      container: packContainer ? { kind: packContainer.entry.kind, slots: packContainer.entry.slots } : null,
      stations,
      tab: packTab,
      recipes: listRecipes(pack, stations, { queue: craftQueue }),
      lanes: craftQueue.lanes(),
      message: packMessage,
    });
  }

  function packKey() {
    return `${pack.version}|${craftQueue.version}|${containers.version}|${stationsVersion}|${packTab}|${packMessageSeq}`;
  }

  /** Redraw the pack screen when anything it shows changed (or `force`); drops a basket that is no longer there. */
  function refreshPackScreen(force = false) {
    if (state !== STATE.PACK) return;
    if (packMessage && fxTime >= packMessageUntil) {
      packMessage = null;
      packMessageSeq++;
    }
    if (packContainer && containers.get(packContainer.q, packContainer.y, packContainer.r) !== packContainer.entry) {
      packSession.container = null;
      packContainer = null;
      force = true;
    }
    const key = packKey();
    if (!force && key === packViewKey) return;
    packViewKey = key;
    packUI.refresh(packScreenView());
  }

  function packSlotClick(area, index, button, shift) {
    if (state !== STATE.PACK) return;
    const res = /** @type {*} */ (slotClick(packSession, area, index, button, shift));
    if (res.container) containers.touch();
    if (res.refused) packSay(String(res.refused), true); // §14.4: the Handbook refuses the discard hex
    if (res.changed) audio.playClick();
    refreshPackScreen(true);
  }

  /**
   * A line on the pack screen itself for PACK_MESSAGE_S (§9.8): refusals and Make results. The HUD's target hint and
   * save toast are not drawn under the pack screen, so they were never seen there (play-test).
   * @param {string} text @param {boolean} [error]
   */
  function packSay(text, error = false) {
    packMessage = { text, error };
    packMessageUntil = fxTime + PACK_MESSAGE_S;
    packMessageSeq++;
  }

  function packMake(recipeId, times) {
    if (state !== STATE.PACK) return;
    const res = craftQueue.enqueue(recipeId, times, pack, stations);
    packSay(res.message, !res.ok);
    if (res.ok) audio.playClick();
    refreshPackScreen(true);
  }

  function packCancelJob(lane, i) {
    if (state !== STATE.PACK) return;
    if (craftQueue.cancel(lane, i)) audio.playClick();
    refreshPackScreen(true);
  }

  function packSetTab(tab) {
    if (state !== STATE.PACK) return;
    packTab = typeof tab === 'string' ? tab : 'all';
    refreshPackScreen(true);
  }

  /** §14.4 packUI.onRead: close the pack, open the field book. */
  function packRead() {
    if (state !== STATE.PACK) return;
    closePack(false);
    openBook();
  }

  // ---- The Survival Handbook (§14) --------------------------------------------------------------------

  /** Read the rustic Handbook (R or RMB with it in hand, or from the pack screen). The world keeps running. */
  function openBook() {
    if (state !== STATE.PLAYING) return;
    setState(STATE.BOOK); // before unlock()
    controls.setEnabled(false);
    controls.unlock();
    leftHold.held = 0;
    placeHeld = 0;
    resetSurvivalInput();
    handbookUI.openRustic();
  }

  /** handbookUI's onClose: a rustic book read in play goes back to playing; the Guide leaves the menu underneath as it was. */
  function onBookClosed() {
    if (state === STATE.BOOK) enterPlayingFromModal();
  }

  /** Damage closes the field book (§14.1). */
  function closeRusticBook() {
    if (state !== STATE.BOOK) return;
    if (handbookUI.isOpen() === 'rustic') handbookUI.close();
    onBookClosed();
  }

  /** The Guide (menus.onGuide): from the title screen or the pause menu, in both modes; reading only. */
  function openGuide() {
    if (state !== STATE.TITLE && state !== STATE.PAUSED) return;
    handbookUI.openGuide();
  }

  // ---- saving ---------------------------------------------------------------------------------------

  /** @returns {SaveData|null} */
  function buildSaveData() {
    if (!world || !player) return null;
    return {
      version: SAVE_VERSION,
      seed: world.seed,
      time,
      day,
      player: { x: player.x, y: player.y, z: player.z, yaw: controls.yaw, pitch: controls.pitch, flying: player.flying },
      hotbar: hotbar.slice(),
      selected,
      // Never mutates the live world: in-flight fallers are settled into a COPY of the edits, flowing water is left
      // out and lit barrels are saved as barrels (BlockPhysics.exportEdits).
      edits: blockPhysics ? blockPhysics.exportEdits() : world.exportEdits(),
      runes: runeStore.export(),
      pigs: pigs.export(),
      animals: animals.size > 0 ? animals.export() : undefined, // §69: written only when there are any
      physics: blockPhysics ? blockPhysics.exportSwitches() : undefined,
      zombies: zombies.enabled, // the switch only: zombies themselves are never saved (§39)
      watcher: watcher.enabled, // the switch: the Watcher itself is a sighting, never saved (§40) …
      watcherNight: watcher.lastNight ?? undefined, // … and the night of its last natural sighting (none: not written)
      // v0.9 (§1.4): gen, mode, survival and containers, each only when there is something to say (storage orders them).
      ...survivalSaveFields({ gen: world.gen, survival, pack, fireSlots, containers, loose }),
      // v0.10 (DESIGN-circuits §6.4): the two switches and the configured parts (storage orders them after containers).
      blackholes: blackHoles.enabled,
      circuits: circuits ? circuits.enabled : true,
      circuitParts: circuitStore.export(),
      meta: { name: worldName, createdAt: worldCreatedAt, lastPlayed: Date.now() }, // §41: the slot's name and times
    };
  }

  /**
   * Save now, to the current slot only. Skipped under ?nosave. Errors always show the red toast (saveFailMessage: a full
   * storage asks for a world to be deleted); `announce` also shows "World saved".
   * @param {boolean} announce
   * @returns {boolean}
   */
  function doSave(announce) {
    if (params.nosave) {
      if (announce) hud.showSaveToast(autoNoSave ? 'Saving is off for this world (its slot is protected)' : 'Saving disabled (?nosave=1)', true);
      return false;
    }
    const data = buildSaveData();
    if (!data) return false;
    const res = saveSlot(currentSlot, data);
    const ok = res.ok;
    if (ok) {
      savedEditVersion = world.editVersion;
      savedRunesVersion = runeStore.version;
      if (blockPhysics) savedSwitchVersion = blockPhysics.switchVersion;
      savedZombieSwitch = zombies.switchVersion;
      savedWatcherSwitch = watcher.switchVersion;
      savedWatcherNight = watcher.lastNight;
      markSurvivalSaved();
      markCircuitsSaved();
      savedX = player.x;
      savedY = player.y;
      savedZ = player.z;
      autosaveAccum = 0;
      if (announce) hud.showSaveToast('World saved');
    } else {
      lastSaveFailReason = res.reason;
      hud.showSaveToast(saveFailMessage(res.reason), true);
    }
    return ok;
  }

  /** A world chosen on the Worlds screen saves normally again: ?autoplay's protection was for the world it opened. */
  function resumeSaving() {
    if (!autoNoSave) return;
    autoNoSave = false;
    params.nosave = false;
  }

  /** The current slot holds a readable save (so a failed save leaves that one in place). */
  function slotHasSave() {
    const status = listSlots()[currentSlot - 1]?.status;
    return status !== undefined && status !== 'empty' && status !== 'damaged';
  }

  function playerMovedSinceSave() {
    return (
      Math.abs(player.x - savedX) > AUTOSAVE_MOVE_EPS ||
      Math.abs(player.y - savedY) > AUTOSAVE_MOVE_EPS ||
      Math.abs(player.z - savedZ) > AUTOSAVE_MOVE_EPS
    );
  }

  function autosaveTick(dt) {
    if (params.nosave) return;
    autosaveAccum += dt;
    if (autosaveAccum < AUTOSAVE_INTERVAL_S) return;
    autosaveAccum = 0;
    const switchesChanged = (blockPhysics !== null && blockPhysics.switchVersion !== savedSwitchVersion)
      || zombies.switchVersion !== savedZombieSwitch || watcher.switchVersion !== savedWatcherSwitch
      || watcher.lastNight !== savedWatcherNight
      // v0.10 (§6.6 step 11): a configured part, or the circuits / black holes switch
      || circuitStore.version !== savedPartsVersion || blackHoles.switchVersion !== savedBlackHoleSwitch
      || (circuits !== null && circuits.switchVersion !== savedCircuitSwitch);
    // Survival (§9.5 step 13): an active survival saves every interval (the vitals change all the time), and any change of
    // the mode, the pack, the containers or the fire spots saves too.
    const survivalChanged = survival.active || survival.switchVersion !== savedSurvivalSwitch || pack.version !== savedPackVersion
      || containers.version !== savedContainersVersion || fireSlots.version !== savedFiresVersion;
    if (world.editVersion !== savedEditVersion || runeStore.version !== savedRunesVersion || switchesChanged || survivalChanged
      || playerMovedSinceSave()) doSave(false);
  }

  /** Remember the circuit versions a save carried. */
  function markCircuitsSaved() {
    savedPartsVersion = circuitStore.version;
    savedBlackHoleSwitch = blackHoles.switchVersion;
    savedCircuitSwitch = circuits ? circuits.switchVersion : 0;
  }

  /** Remember the survival versions a save carried. */
  function markSurvivalSaved() {
    savedSurvivalSwitch = survival.switchVersion;
    savedPackVersion = pack.version;
    savedContainersVersion = containers.version;
    savedFiresVersion = fireSlots.version;
  }

  /** Save when the page is leaving / hidden while a world is live (any state with a player, click-to-play included). */
  function saveOnLeave() {
    if (!world || !player || state === STATE.TITLE || state === STATE.LOADING) return;
    // The editor pushes typing to the store after a debounce; flush it so the last keystrokes reach this save.
    if (runeEditor.isOpen()) {
      const key = runeEditor.getKey();
      const rune = key ? runeStore.get(key) : undefined;
      if (rune) runeStore.set(rune.q, rune.y, rune.r, runeEditor.getFields());
    }
    doSave(false);
  }

  // ---- state transitions ----------------------------------------------------------------------------

  function setState(s) {
    state = s;
    stats.state = s;
    // A modal (or the title) takes the mouse: a right-click or R key held on a control is let go (§4.9).
    if (s !== STATE.PLAYING) {
      controlLatch.release();
      rHeldCell = null;
    }
  }

  /**
   * The title screen with the Worlds panel.
   * @param {number} [focusSlot]  focus this row (default: the last played world)
   * @param {string} [message]  red status line (a world that could not be saved on quit)
   */
  function showTitle(focusSlot, message = '') {
    setState(STATE.TITLE);
    controls.setEnabled(false);
    menus.hidePause();
    menus.hideLoading();
    menus.hideClickToPlay();
    menus.hidePicker();
    consoleUI.close();
    runeEditor.close();
    editorKey = null;
    if (devicePanel.isOpen()) devicePanel.close();
    deviceKey = null;
    packUI.close();
    menus.hideDeath();
    if (handbookUI.isOpen()) handbookUI.close();
    hud.setPickerOpen(false);
    hud.setUnderwater(false);
    hud.setTargetHint(null);
    hud.setSurvivalVisible(false);
    hud.setActionProgress(null);
    hud.setJobChip(null);
    menus.showTitle(...worldsView({ focusSlot, message, isError: Boolean(message) }));
  }

  /**
   * menus.showTitle / setWorlds arguments: the slots as storage lists them (under ?nosave read-only: no index repair) and
   * the panel options (usage bar, ?seed for the New World form, `extra` for message / focus).
   * @param {import('./menus.js').WorldsOptions} [extra]
   * @returns {[import('./storage.js').SlotInfo[], import('./menus.js').WorldsOptions]}
   */
  function worldsView(extra = {}) {
    const slots = listSlots(undefined, { repair: !params.nosave });
    return [slots, { now: Date.now(), usage: storageUsage(slots), readOnly: params.nosave, defaultSeed: params.seed, ...extra }];
  }

  /** Re-render the Worlds panel after an action (the title stays up). */
  function refreshWorlds(message = '', isError = false, focusSlot = undefined) {
    menus.setWorlds(...worldsView({ message, isError, focusSlot }));
  }

  /** The pause menu's world line: the name, plus a note when nothing is being saved (?nosave, or switched off by autoplay). */
  function pauseWorldLabel() {
    return params.nosave ? `${worldName} · not saving` : worldName;
  }

  /**
   * Build the world and enter the loading screen.
   * @param {number} seed
   * @param {SaveData|null} restoring
   * @param {{ survivalResources?: boolean }} [opts]  a new world: the New World form's checkbox (§1.3)
   */
  function startLoading(seed, restoring, opts = {}) {
    if (world) {
      world.dispose();
      world = null;
    }
    player = null;
    hit = null;
    waterHit = null;
    renderer.setHighlight(null);
    renderer.setDigProgress(null, 0);
    pendingSave = restoring;

    // §1.3: a save keeps its generator version (absent: 1, today's land); a new world gets GEN_LATEST unless the box was
    // cleared. Only an explicit upgrade (or ?mode under §1.1's rules) ever raises it.
    const gen = loadingGen(restoring, opts);
    world = new World({ seed, renderDistance: params.rd ?? RENDER_DISTANCE, edits: restoring ? restoring.edits : undefined, gen });
    world.onChunkMesh = (key, cq, cr, meshData) => renderer.setChunkMesh(key, cq, cr, meshData);
    world.onChunkUnload = (key) => renderer.removeChunkMesh(key);
    renderer.setLightField(world.light); // §62: mobs, items and falling blocks are lit from the world's light
    // Block physics before the first chunk is generated: onChunkGenerated re-seeds edited cells as chunks stream in.
    blockPhysics = new BlockPhysics(world, physicsHooks);
    // A save from before v0.8 has no `physics` field: collapse starts off there (old sky bases must not fall the first
    // time they are touched), everything else on, and the player is told once.
    if (restoring && !restoring.physics) {
      blockPhysics.importSwitches({ collapse: false });
      physicsNotePending = true;
    } else {
      blockPhysics.importSwitches(restoring ? restoring.physics : null);
      physicsNotePending = false;
    }
    savedSwitchVersion = blockPhysics.switchVersion;
    // v0.10: a blast that reaches a Collapsar Charge sets it off instead of destroying it (DESIGN-circuits §3.4.6).
    blockPhysics.explosions.onCharge = (q, y, r) => {
      blackHoles.activate(q, y, r, blackHoleWorld);
    };
    // The circuits (§6.6): the save's configured parts, then the engine, its switch and the black holes' switch.
    circuitStore.replaceAll(restoring && restoring.circuitParts ? restoring.circuitParts : null);
    circuits = new Circuits(circuitStore, circuitHooks);
    circuits.setEnabled(!(restoring && restoring.circuits === false));
    blackHoles.setEnabled(!(restoring && restoring.blackholes === false));
    world.onChunkGenerated = (cq, cr) => {
      blockPhysics.onChunkGenerated(cq, cr);
      if (circuits) circuits.onChunkLoaded(cq, cr); // a loaded chunk's cells are solved settling: loading fires nothing
    };
    world.onBlockChange = onBlockChanged;
    litTarget = null;
    particles.clear();
    fallingRenderer.sync([], 0);
    circuitRenderer.syncMoving(null);
    fallingRenderer.setFlash(0, 0, 0, 0);
    blackHoles.loadFromEdits(world.edits);
    circuits.loadFromEdits(world.edits); // after the holes, settling (§4.7)
    resetCircuitSession();
    campfires.loadFromEdits(world.edits);
    pigs.load(restoring && Array.isArray(restoring.pigs) ? restoring.pigs : []);
    animals.load(restoring ? restoring.animals : null);
    lampLights.clear(); // §72: the new world's light engine starts without extra emitters
    riding = null;
    animalTarget = null;
    snaredPigs.clear();
    placeNaturalPigs = !(restoring && Array.isArray(restoring.pigs));
    pigTarget = null;
    // Zombies are never saved; their switch is (absent — a new world or an older save — means on).
    zombies.clear();
    zombies.setEnabled(!(restoring && restoring.zombies === false));
    savedZombieSwitch = zombies.switchVersion;
    zombieTarget = null;
    hurtFlash = 0;
    // The Watcher: no figure; its switch from the save (absent means on) and the night of its last natural sighting
    // (absent: none), so reloading in the night it came does not bring it again.
    watcher.clear();
    watcher.setEnabled(!(restoring && restoring.watcher === false));
    watcher.setLastNight(restoring && restoring.watcherNight != null ? restoring.watcherNight : null);
    savedWatcherSwitch = watcher.switchVersion;
    savedWatcherNight = watcher.lastNight;
    const spawnPoint = world.findSpawn(); // its traces keep clear of the world's spawn
    watcherWorld.spawn = [spawnPoint[0], spawnPoint[2]];
    // Runes: replace the store with the save's (validated) runes; nothing runs until the player exists.
    if (runner) runner.reset();
    runner = null;
    ctx = null;
    const runeWarnings = runeStore.replaceAll(restoring ? restoring.runes : null);
    for (const w of runeWarnings) console.warn('Caelancraft runes:', w);
    loadSurvival(restoring);
    // After a WebGL context restore the renderer has dropped every chunk mesh (it keeps no CPU copy of the
    // vertex data). Flag the meshed chunks as never-meshed so the budgeted ring walk in world.update()
    // rebuilds them nearest-first over the next frames instead of all at once.
    renderer.onContextRestored = () => {
      if (!world) return;
      for (const c of world.chunks.values()) {
        if (c.meshed) {
          c.dirty = true;
          c.meshed = false;
        }
      }
    };
    renderer.setRenderDistance(world.renderDistance);

    time = restoring ? wrapTime(restoring.time) : START_TIME;
    if (params.time != null) time = params.time;
    day = restoring && Number.isFinite(restoring.day) ? Math.max(1, Math.floor(restoring.day)) : 1;
    hotbar = hotbarFrom(restoring ? restoring.hotbar : null);
    selected = slotFrom(restoring ? restoring.selected : 0);
    hud.setHotbar(hotbar, selected);

    const p = restoring ? restoring.player : null;
    loadingCentre = p ? [p.x, p.y, p.z] : world.findSpawn();
    loadingFrames = 0;
    ({ radius: loadingRadius, total: loadingTotal } = loadingRing(world.renderDistance));

    controls.setEnabled(false);
    menus.hideTitle();
    menus.hideClickToPlay();
    menus.hidePause();
    menus.showLoading(0, loadingTotal);
    setState(STATE.LOADING);
  }

  /**
   * §9.5 startLoading, the survival part: the vitals, the mode (Creative for a hand-edited Survival save below generation 2),
   * a fresh state for a Survival world without one, the pack, fire spots, containers, regrowth; nothing else carries over.
   * @param {SaveData|null} restoring
   */
  function loadSurvival(restoring) {
    survival.import(restoring && restoring.survival ? restoring.survival : null);
    const { mode, warning } = loadingMode(restoring, world.gen);
    if (warning) console.warn(`Caelancraft: ${warning}`);
    survival.mode = mode;
    survivalBegun = false;
    if (mode === 'survival' && !survival.hasState) {
      survival.begin();
      survivalBegun = true;
    }
    const packWarnings = pack.load(survival.hasState && restoring ? restoring.survival : null);
    for (const w of packWarnings) console.warn('Caelancraft pack:', w);
    const fireWarnings = fireSlots.load(restoring && restoring.survival ? restoring.survival.fires : null);
    for (const w of fireWarnings) console.warn('Caelancraft fires:', w);
    const containerWarnings = containers.load(restoring ? restoring.containers : null);
    for (const w of containerWarnings) console.warn('Caelancraft containers:', w);
    loose.load(survival.hasState && restoring && restoring.survival ? restoring.survival.loose : null, looseBlockOf);
    regrowth.loadFromEdits(world.edits);
    tapped.clear();
    craftQueue.clear();
    resetSurvivalInput();
    pendingDeath = null;
    pendingKnock = 0;
    pendingCrush = 0;
    pendingModeSwitch = null;
    releaseToPack = false;
    climateSample = null;
    climateAccum = 0;
    stations = { hand: true };
    stationsVersion++;
    survivalSecond = 0;
    pigRepopAccum = 0;
    pigRepopTries = 0;
    flashHint = null;
    packTab = 'all';
    markSurvivalSaved();
  }

  /** @returns {number} meshed chunks within hex distance loadingRadius of the loading centre's chunk */
  function loadingProgress() {
    const [q, r] = worldToHex(loadingCentre[0], loadingCentre[2]);
    const cq = Math.floor(q / CHUNK_SIZE);
    const cr = Math.floor(r / CHUNK_SIZE);
    let done = 0;
    for (let dq = -loadingRadius; dq <= loadingRadius; dq++) {
      for (let dr = -loadingRadius; dr <= loadingRadius; dr++) {
        if (hexLength(dq, dr) > loadingRadius) continue;
        const c = world.getChunk(cq + dq, cr + dr);
        if (c && c.meshed && !c.dirty) done++;
      }
    }
    return done;
  }

  function stepLoading() {
    const [sx, , sz] = loadingCentre;
    // Spend up to LOADING_BUDGET_MS per frame; update() itself caps at MAX_BUILDS_PER_UPDATE per call.
    const start = now();
    let r;
    do {
      r = world.update(sx, sz, LOADING_BUDGET_MS - (now() - start));
    } while ((r.pendingGen > 0 || r.pendingMesh > 0) && now() - start < LOADING_BUDGET_MS);
    loadingFrames++;

    const done = loadingProgress();
    menus.showLoading(done, loadingTotal);
    // Contract: ready when the spawn chunk is meshed. We additionally wait for the loading disc the progress
    // bar promises (or a generous frame cap) so the player never spawns looking at holes.
    const ringDone = done >= loadingTotal || (r.pendingGen === 0 && r.pendingMesh === 0) || loadingFrames >= LOADING_MAX_FRAMES;
    if (world.isReadyAt(sx, sz) && ringDone) finishLoading();
  }

  function finishLoading() {
    const restoring = pendingSave;
    pendingSave = null;
    const [sx, sy, sz] = loadingCentre;
    player = createPlayer(sx, sy, sz);
    if (restoring && restoring.player) {
      player.flying = Boolean(restoring.player.flying);
      controls.yaw = restoring.player.yaw;
      controls.pitch = restoring.player.pitch;
    } else {
      controls.yaw = Math.PI; // face +Z
      controls.pitch = 0;
    }
    // Debug/screenshot aids: ?yaw= and ?pitch= (degrees) override the initial look direction.
    if (params.yaw != null) controls.yaw = (params.yaw * Math.PI) / 180;
    if (params.pitch != null) controls.pitch = (params.pitch * Math.PI) / 180;
    if (params.fly) player.flying = true;
    // §1.1 ?mode: the first world only (the autoplay boot already decided whether it may apply), then it is used up.
    const urlModeNow = consumeModeParam(params);
    if (urlModeNow && urlModeNow !== survival.mode && !survival.dead && (urlModeNow === 'creative' || world.gen >= 2)) {
      const hadState = survival.hasState;
      survival.setMode(urlModeNow);
      if (urlModeNow === 'survival' && !hadState) survivalBegun = true;
    }
    // §9.5 finishLoading: no flight in Survival (whatever ?fly says), and the first landing does no damage.
    if (survival.inSurvival) {
      player.flying = false;
      player.landSpeed = 0;
      survival.fallGrace = true;
    }

    if (placeNaturalPigs) {
      placeNaturalPigs = false;
      const [pq, pr] = worldToHex(sx, sz);
      pigs.spawnNatural(PIG_NATURAL_COUNT, pq, pr, world.seed, world.getBlock, (q, r) => world.hasChunkAtCell(q, r));
    }

    ctx = buildCommandContext();
    runner = new RuneRunner(runeStore, ctx);
    ctx.runner = runner;
    runner.onLog = (line, isError) => logLine(line, isError);
    runner.onTrigger = (_key, source) => {
      if (source === SOURCE.INTERACT || source === SOURCE.STEP) audio.playClick();
    };
    runner.seedStep();
    if (physicsNotePending) {
      physicsNotePending = false;
      logLine(OLD_WORLD_PHYSICS_NOTE);
    }
    if (upgradeNotePending) {
      upgradeNotePending = false;
      logLine(UPGRADED_NOTE);
    }
    if (survivalBegun) {
      // §1.2 / §14.2: a survival state that has just begun starts with the Handbook in the last hotbar slot.
      survivalBegun = false;
      sayBeginLines(ensureHandbook(pack));
    }

    savedEditVersion = world.editVersion;
    savedRunesVersion = runeStore.version;
    markCircuitsSaved();
    savedX = player.x;
    savedY = player.y;
    savedZ = player.z;
    autosaveAccum = 0;
    if (!restoring) doSave(false); // a new world claims its slot at once (§41); a no-op under ?nosave
    fov = FOV;
    leftHold.held = 0;
    placeHeld = 0;
    updateHit();

    menus.hideLoading();
    // §2.5 step 6: a world saved on the death screen reloads onto it — never into click-to-play (z 35, above it) or play.
    if (stateAfterLoading({ dead: Boolean(survival.dead), autoplay }) === STATE.DEAD) {
      setState(STATE.DEAD);
      controls.setEnabled(false);
      showDeathAfterLoad();
      return;
    }
    if (autoplay) {
      enterPlaying();
      showDebugUi();
      // §6.7: ?scene= for screenshots (the smoke test builds its scene itself, after its own steps).
      if (params.scene && !params.smoke) buildScene(params.scene, 2);
    } else {
      setState(STATE.CLICK_TO_PLAY);
      menus.showClickToPlay();
    }
  }

  /**
   * `?ui=console|editor|picker|pack|device` with autoplay: open the console, place a rune block three cells ahead and open its
   * editor, open the block picker, the pack screen (Survival) or the device panel on a demo Clockwork Timer (screenshots).
   */
  function showDebugUi() {
    if (!params.ui || !runner || !player || params.smoke) return; // a modal would stall the smoke sequence
    if (params.ui === 'picker') {
      openPicker();
      return;
    }
    if (params.ui === 'device') {
      // §6.7: a Clockwork Timer three cells ahead (30 s, repeat, labelled), then its panel.
      const [fx, fz] = yawToForward(controls.yaw);
      const [q, r] = worldToHex(player.x + fx * 3, player.z + fz * 3);
      const y = Math.max(0, Math.floor(player.y) - 1);
      runner.runConsoleLine(`setblock ${q} ${y} ${r} clockwork_timer`);
      if (circuits) circuits.applySettings(q, y, r, { s: 30, m: 'repeat', l: 'Quarry clock' });
      openDevicePanel(q, y, r);
      return;
    }
    if (params.ui === 'pack') {
      // The Pack & Making screen (§9.10): Survival only. Under ?nosave an empty pack is stocked with the screen's demo kit
      // (nothing is saved), so the screenshot shows a lived-in pack.
      if (!survival.inSurvival) return;
      if (params.nosave && pack.slots.every((s) => s === null || s.k === HANDBOOK_KEY)) {
        const demo = demoPackView();
        demo.slots.forEach((s, i) => { if (s && !pack.slots[i]) pack.setSlot(i, s); });
        demo.wear.forEach((s, i) => { if (s) pack.setWear(i, s); });
      }
      openPack();
      return;
    }
    if (params.ui === 'console') {
      openConsole('');
      consoleUI.log(runner.runConsoleLine('help').message);
      return;
    }
    const [fx, fz] = yawToForward(controls.yaw);
    const [q, r] = worldToHex(player.x + fx * 3, player.z + fz * 3);
    const y = Math.max(0, Math.floor(player.y) - 1);
    runner.runConsoleLine(`setblock ${q} ${y} ${r} rune_block`);
    const rune = runeStore.set(q, y, r, { label: 'lift', script: '# runs on R\nsay Going up\nhexring @ @1 @ 2 3 stone_bricks\nwait 1\ntp @ @4 @', stepOn: true, chain: true });
    if (rune) openEditor(rune);
  }

  /**
   * `?scene=` (DESIGN-circuits §6.7): 'vortex' sets off a Collapsar Charge 8 cells ahead (`delay` seconds later), 'circuits'
   * flattens the ground 10 cells ahead and builds the §4.14 worked examples there (diagnostics.circuitSceneWrites).
   * @param {string} name
   * @param {number} [delay]
   * @returns {{ ok: boolean, message: string, named?: Record<string, [number, number, number]> }}
   */
  function buildScene(name, delay = 0) {
    if (!world || !player || !circuits) return { ok: false, message: 'no world is loaded' };
    const [fx, fz] = yawToForward(controls.yaw);
    const feet = Math.floor(player.y + 1e-3);
    if (name === 'vortex') {
      const [q, r] = worldToHex(player.x + fx * 8, player.z + fz * 8);
      let y = Math.min(WORLD_HEIGHT - 1, feet + 8);
      while (y > 1 && !isSolid(world.getBlock(q, y - 1, r))) y--;
      if (!world.setBlock(q, y, r, BLOCK.COLLAPSAR_CHARGE)) return { ok: false, message: `could not place the charge at (${q}, ${y}, ${r})` };
      sceneNamed = { charge: [q, y, r] };
      if (delay > 0) {
        sceneCharge = { q, y, r, at: fxTime + delay };
        return { ok: true, message: `a collapsar charge at (${q}, ${y}, ${r}) goes off in ${delay} s`, named: sceneNamed };
      }
      const res = blackHoles.activate(q, y, r, blackHoleWorld);
      return { ok: res.ok, message: res.message, named: sceneNamed };
    }
    if (name !== 'circuits') return { ok: false, message: `unknown scene "${name}"` };
    const [qa, ra] = worldToHex(player.x + fx * 10, player.z + fz * 10);
    const q0 = qa - 5;
    const r0 = ra - Math.floor(((CIRCUIT_SCENE_ROWS.length - 1) * SCENE_ROW_GAP) / 2);
    const scene = circuitSceneWrites(q0, feet, r0);
    const box = scene.bounds;
    // Flat stone ground under the whole scene (placed stone on natural ground passes the earth walk), open air above.
    for (let q = box.q0 - 2; q <= box.q1 + 2; q++) {
      for (let r = box.r0 - 2; r <= box.r1 + 2; r++) {
        for (let y = feet; y <= feet + 6 && y < WORLD_HEIGHT; y++) if (world.getBlock(q, y, r) !== BLOCK.AIR) world.setBlock(q, y, r, BLOCK.AIR);
        for (let y = feet - 1; y >= Math.max(1, feet - 8); y--) {
          if (isSolid(world.getBlock(q, y, r))) break;
          world.setBlock(q, y, r, BLOCK.STONE);
        }
      }
    }
    for (const [q, y, r, id] of scene.blocks) world.setBlock(q, y, r, id);
    for (const [q, y, r, face] of scene.faces) circuits.setInputFace(q, y, r, face);
    for (const [q, y, r, partial] of scene.settings) circuits.applySettings(q, y, r, partial);
    sceneNamed = scene.named;
    return { ok: true, message: `built the circuit examples at (${q0}, ${feet}, ${r0})`, named: scene.named };
  }

  function enterPlaying() {
    if (survival.dead) return; // §2.5: the death screen is modal; only Wake up leaves it
    menus.hideClickToPlay();
    menus.hidePause();
    setState(STATE.PLAYING);
    controls.setEnabled(true);
    controls.lock();
    audio.resume();
    if (params.smoke && !smokeStarted) {
      smokeStarted = true;
      runSmokeTest(game, win);
    }
  }

  function pause() {
    if (state !== STATE.PLAYING) return;
    setState(STATE.PAUSED);
    controls.setEnabled(false);
    controls.unlock();
    menus.showPause(world.seed, physicsMenuState(), pauseWorldLabel()); // also resets the quit button to "Save & Quit"
    quitUnsavedArmed = false;
    menus.setZombiesState(zombies.enabled);
    menus.setModeState(survival.mode); // §1.1 the Mode switch
    menus.setDeviceSwitches(deviceSwitches()); // v0.10 the Devices row
    doSave(false);
  }

  /** The pause menu's Devices row (§6.2.17). */
  function deviceSwitches() {
    return { circuits: circuits ? circuits.enabled : true, blackholes: blackHoles.enabled };
  }

  function resume() {
    if (state !== STATE.PAUSED) return;
    enterPlaying();
  }

  function openPicker() {
    if (state !== STATE.PLAYING) return;
    setState(STATE.PICKER); // before unlock(): the lock-change handler must not read 'playing'
    controls.setEnabled(false);
    controls.unlock();
    hud.setPickerOpen(true);
    menus.showPicker(hotbar, selected);
    leftHold.held = 0;
    placeHeld = 0;
    controlLatch.release();
  }

  function closePicker() {
    if (state !== STATE.PICKER) return;
    menus.hidePicker();
    hud.setPickerOpen(false);
    enterPlayingFromModal();
  }

  /**
   * Leave a modal (picker / console / editor). Esc is not a user-activation event, so the pointer lock request
   * can be refused; if it is not back shortly, fall into click-to-play instead of a dead "playing" state.
   */
  function enterPlayingFromModal() {
    enterPlaying();
    win.setTimeout(() => {
      if (disposed || state !== STATE.PLAYING || controls.locked) return;
      setState(STATE.CLICK_TO_PLAY);
      controls.setEnabled(false);
      doSave(false); // like pause(): the overlay may sit there for a long time
      menus.showClickToPlay();
    }, RELOCK_CHECK_MS);
  }

  function openConsole(prefill) {
    if (state !== STATE.PLAYING) return;
    setState(STATE.CONSOLE); // before unlock(): the lock-change handler must not read 'playing'
    controls.setEnabled(false);
    controls.unlock();
    consoleUI.open(prefill);
    leftHold.held = 0;
    placeHeld = 0;
  }

  function closeConsole() {
    if (state !== STATE.CONSOLE) return;
    consoleUI.close();
    enterPlayingFromModal();
  }

  /** @param {import('./types.js').Rune} rune */
  function openEditor(rune) {
    if (state !== STATE.PLAYING || !rune) return;
    editorKey = rune.key;
    setState(STATE.EDITOR);
    controls.setEnabled(false);
    controls.unlock();
    runeEditor.open(rune, runner ? runner.getLastRun(rune.key) : null);
    leftHold.held = 0;
    placeHeld = 0;
  }

  function closeEditor() {
    if (state !== STATE.EDITOR) return;
    runeEditor.close();
    editorKey = null;
    enterPlayingFromModal();
  }

  /**
   * Close the world and show the Worlds screen. The caller has saved (or failed to: `message` then says so on the panel).
   * @param {string} [message]  red status line on the Worlds panel
   */
  function quitToTitle(message = '') {
    if (runner) runner.reset();
    runner = null;
    ctx = null;
    runeStore.clear();
    if (world) {
      world.dispose();
      world = null;
    }
    blockPhysics = null;
    litTarget = null;
    particles.clear();
    fallingRenderer.sync([], 0);
    circuitRenderer.syncMoving(null);
    fallingRenderer.setFlash(0, 0, 0, 0);
    zombies.clear();
    zombieTarget = null;
    hurtFlash = 0;
    hud.setHurtFlash(0);
    watcher.clear();
    clearCircuits();
    clearSurvival();
    quietWorldSounds(); // v0.16 (§82)
    player = null;
    hit = null;
    waterHit = null;
    renderer.setHighlight(null);
    showTitle(currentSlot, message); // the Worlds screen, the world just left focused
  }

  /** A new world's circuit session state (startLoading): nothing carries over from the last world but the pocket wavelength. */
  function resetCircuitSession() {
    infall.clear();
    vortexAcc.clear();
    bhEvents.length = 0;
    flashState.level = 0;
    flashState.sinceStart = Infinity;
    flashKind = 'white';
    flashTrigger = null;
    hud.setFlashOverlay(0, 'white');
    controlLatch.release();
    rHeldCell = null;
    kegExplainAt = -Infinity;
    geoBuilt.geometry = -1;
    geoBuilt.at = -Infinity;
    geoEye[0] = NaN;
    if (devicePanel.isOpen()) devicePanel.close();
    deviceKey = null;
    circuitRenderer.setGeometry(null);
    circuitRenderer.syncOverlays([], fxTime, 0);
    vortexRenderer.sync([], fxTime, [0, 0, 0]);
    droneLoop.set(0, 1);
  }

  /** §6.6 quitToTitle / dispose: forget the world's circuits, the configured parts, the infall and every circuit drawing. */
  function clearCircuits() {
    circuits = null;
    circuitStore.clear();
    blackHoles.clear();
    resetCircuitSession();
  }

  /** §9.5 quitToTitle / dispose: forget every survival object and hide its screens and HUD. */
  function clearSurvival() {
    survival.import(null);
    survival.mode = 'creative';
    pack.clear();
    containers.clear();
    fireSlots.clear();
    regrowth.clear();
    tapped.clear();
    craftQueue.clear();
    resetSurvivalInput();
    pendingDeath = null;
    pendingKnock = 0;
    pendingCrush = 0;
    pendingModeSwitch = null;
    packSession.cursor = null;
    packSession.container = null;
    packContainer = null;
    climateSample = null;
    packUI.close();
    menus.hideDeath();
    if (handbookUI.isOpen()) handbookUI.close();
    renderer.setDigProgress(null, 0);
    hud.setSurvivalVisible(false);
    hud.setHotbarStacks(null, selected);
    hud.setActionProgress(null);
    hud.setJobChip(null);
  }

  // ---- menus / hud callbacks ------------------------------------------------------------------------

  menus = createMenus(doc, atlasCanvas, {
    // ---- the Worlds panel (§41): every action works on one slot; nothing is written under ?nosave ----
    onPlayWorld(slot) {
      if (state !== STATE.TITLE) return;
      resumeSaving();
      const data = loadSlot(slot);
      if (!data) {
        refreshWorlds(`World ${slot} could not be loaded`, true, slot); // emptied or damaged meanwhile (another tab)
        return;
      }
      currentSlot = slot;
      worldName = data.meta.name;
      worldCreatedAt = data.meta.createdAt;
      audio.resume();
      startLoading(data.seed, data);
    },
    onNewWorld(slot, name, seedText, opts) {
      if (state !== STATE.TITLE) return;
      resumeSaving();
      if (!params.nosave && listSlots()[slot - 1]?.status !== 'empty') {
        refreshWorlds(`Slot ${slot} is not empty any more`, true, slot);
        return;
      }
      currentSlot = slot;
      worldName = normalizeWorldName(name, slot);
      worldCreatedAt = Date.now();
      audio.resume();
      // §1.3: "Survival resources" checked (the default) → GEN_LATEST, cleared → today's land (generation 1).
      startLoading(seedFromInput(seedText), null, { survivalResources: !(opts && opts.survivalResources === false) });
    },
    onRenameWorld(slot, name) {
      if (state !== STATE.TITLE) return;
      if (params.nosave) {
        refreshWorlds('Saving is off (?nosave=1): worlds cannot be changed', true, slot);
        return;
      }
      const res = renameSlot(slot, name);
      refreshWorlds(res.ok ? `Renamed to “${res.name}”` : worldsFailMessage('rename', res.reason), !res.ok, slot);
    },
    onDuplicateWorld(slot) {
      if (state !== STATE.TITLE) return;
      if (params.nosave) {
        refreshWorlds('Saving is off (?nosave=1): worlds cannot be changed', true, slot);
        return;
      }
      const res = duplicateSlot(slot);
      if (res.ok) refreshWorlds(`Copied to slot ${res.slot} as “${res.name}”`, false, res.slot);
      else refreshWorlds(worldsFailMessage('duplicate', res.reason), true, slot);
    },
    onDeleteWorld(slot) {
      if (state !== STATE.TITLE) return;
      if (params.nosave) {
        refreshWorlds('Saving is off (?nosave=1): worlds cannot be changed', true, slot);
        return;
      }
      const before = listSlots()[slot - 1];
      const what = before && before.status === 'world' ? `“${before.name}”` : `the world in slot ${slot}`;
      if (deleteSlot(slot)) refreshWorlds(`Deleted ${what}`, false, slot);
      else refreshWorlds(`Could not delete ${what}`, true, slot);
    },
    onClickToPlay() {
      if (state !== STATE.CLICK_TO_PLAY) return;
      enterPlaying();
    },
    onResume() {
      resume();
    },
    onSave() {
      if (state !== STATE.PAUSED) return;
      doSave(true);
    },
    onStopRunes() {
      if (!runner) return;
      const n = runner.stopAll();
      hud.showSaveToast(`Stopped ${n} rune script${n === 1 ? '' : 's'}; triggers paused`);
      logLine(`stopall: stopped ${n} script${n === 1 ? '' : 's'}; rune triggers paused (press R on a rune or run resume)`);
    },
    onQuit() {
      if (state !== STATE.PAUSED) return;
      const saved = params.nosave || doSave(false);
      if (!saved && !quitUnsavedArmed) {
        // The red toast says why; the world stays open and the button now reads "Quit Without Saving" (§41).
        quitUnsavedArmed = true;
        menus.setQuitUnsaved(true);
        return;
      }
      quitToTitle(saved ? '' : quitUnsavedMessage(worldName, lastSaveFailReason, slotHasSave()));
    },
    onPhysicsToggle(name) {
      if (state !== STATE.PAUSED || !blockPhysics) return;
      const on = !blockPhysics.isEnabled(name);
      blockPhysics.setSwitch(name, on);
      menus.setPhysicsState(physicsMenuState());
      audio.playClick();
      hud.showSaveToast(`${name[0].toUpperCase()}${name.slice(1)} ${on ? 'on' : 'off'}`);
    },
    onZombiesToggle() {
      if (state !== STATE.PAUSED) return;
      const on = !zombies.enabled;
      zombies.setEnabled(on); // off also removes every zombie
      menus.setZombiesState(on);
      audio.playClick();
      hud.showSaveToast(`Zombies ${on ? 'on' : 'off'}`);
    },
    // ---- v0.10 the pause menu's Devices row (§6.2.17): only the inactive half fires ----
    onSetCircuits(on) {
      if (state !== STATE.PAUSED || !circuits) return;
      circuits.setEnabled(Boolean(on)); // on again: everything is solved settling, nothing fires (pitfall 37)
      menus.setDeviceSwitches(deviceSwitches());
      audio.playClick();
      hud.showSaveToast(`Circuits ${on ? 'on' : 'off'}`);
    },
    onSetBlackHoles(on) {
      if (state !== STATE.PAUSED) return;
      blackHoles.setEnabled(Boolean(on));
      menus.setDeviceSwitches(deviceSwitches());
      audio.playClick();
      hud.showSaveToast(`Black holes ${on ? 'on' : 'off'}`);
    },
    onUndoPhysics() {
      if (state !== STATE.PAUSED || !blockPhysics) return;
      // §1.5: Undo restores every cell an event wrote, which in Survival would duplicate what was mined from the debris.
      if (survival.inSurvival) {
        hud.showSaveToast('Undo is off in Survival', true);
        menus.setPhysicsState(physicsMenuState());
        return;
      }
      const res = blockPhysics.undo();
      // The game is paused (no streaming step): re-mesh the restored chunks now so the menu's backdrop shows the result.
      for (let i = 0; i < 32 && [...world.chunks.values()].some((c) => c.dirty && c.lazy && c.meshed); i++) world.update(player.x, player.z);
      logLine(res.message, !res.ok);
      hud.showSaveToast(res.ok ? `Undone: ${res.restored} block${res.restored === 1 ? '' : 's'} restored` : 'Nothing to undo', !res.ok);
      menus.setPhysicsState(physicsMenuState());
    },
    onPickBlock(blockId, slot) {
      if (state !== STATE.PICKER || !isPlaceable(blockId)) return;
      if (slot === null || slot === undefined) {
        assignSlot(selected, blockId);
        audio.playClick();
        closePicker();
      } else if (Number.isInteger(slot) && slot >= 0 && slot < HOTBAR_SIZE) {
        // Digit while hovering: assign and stay open. (Not re-calling showPicker on purpose: it would clear
        // the hover state, so a second digit press without moving the mouse would be ignored.)
        assignSlot(slot, blockId);
        audio.playClick();
      }
    },
    onPickerClose() {
      closePicker();
    },
    // ---- v0.9 Survival ----
    /** §1.1: the inactive half of the Mode switch. A generation-1 world going to Survival asks first (§1.3). */
    async onModeSelect(mode) {
      if (state !== STATE.PAUSED || !world || (mode !== 'creative' && mode !== 'survival')) return;
      if (mode === survival.mode) return;
      if (mode === 'survival' && world.gen < 2) {
        const worldAtAsk = world;
        const yes = await menus.confirm({ ...UPGRADE_CONFIRM });
        // Anything may have happened while the dialog was up (Resume, Quit, another world): ask again next time.
        if (!yes || state !== STATE.PAUSED || world !== worldAtAsk) return;
      }
      requestMode(mode);
      audio.playClick();
    },
    onWake() {
      wake();
    },
    onDeathQuit() {
      if (state !== STATE.DEAD) return;
      const saved = params.nosave || doSave(false);
      quitToTitle(saved ? '' : quitUnsavedMessage(worldName, lastSaveFailReason, slotHasSave()));
    },
    /** §14.4: the Guide button on the title screen and in the pause menu. */
    onGuide() {
      openGuide();
    },
  });

  hud.onSlotClick = (slot) => {
    if (state !== STATE.PICKER) return;
    if (!Number.isInteger(slot) || slot < 0 || slot >= HOTBAR_SIZE) return;
    selected = slot;
    hud.setSelected(slot);
    menus.showPicker(hotbar, selected);
  };

  controls.onLockChange = (locked) => {
    if (!locked) {
      if (state === STATE.PLAYING) pause();
    } else if (state === STATE.PAUSED) {
      // Lock re-acquired (e.g. a click that slipped past the menu): treat as resume.
      resume();
    } else if (state === STATE.CLICK_TO_PLAY && player) {
      // A lock requested while closing a modal can arrive after the relock fallback showed the overlay.
      enterPlaying();
    }
  };

  // Clicking the canvas while playing without the lock (a failed/expired request) re-requests it.
  const onCanvasMouseDown = () => {
    if (state === STATE.PLAYING && !controls.locked) controls.lock();
  };
  canvas.addEventListener('mousedown', onCanvasMouseDown);

  // ---- game context for diagnostics -----------------------------------------------------------------

  /**
   * v0.9 adds (CONTRACTS §49; types.js's GameContext typedef is W0's and does not list them yet): survival, pack,
   * setMode(mode) (queued), getMode(), urlMode, selectSlot(i), interact(), digTargeted(dt), useSelected(dt).
   * @type {GameContext & { getDay: () => number, dispose: () => void, [key: string]: any }}
   */
  const game = {
    get world() {
      return world;
    },
    get player() {
      return player;
    },
    controls,
    renderer,
    hud,
    getTime: () => time,
    setTime(t) {
      if (Number.isFinite(t)) time = wrapTime(t);
    },
    getDay: () => day,
    getHit: () => hit,
    breakTargeted,
    placeSelected,
    teleport(x, y, z) {
      if (!player || !Number.isFinite(x + y + z)) return;
      player.x = x;
      player.y = y;
      player.z = z;
      player.vx = 0;
      player.vy = 0;
      player.vz = 0;
      player.onGround = false;
      // §2.4: every teleport (waking, a black hole's return, tp / tpw, runes) lands without fall damage, and lifting the
      // player out of the arrival cell is no crush.
      player.landSpeed = 0;
      teleportFrame = true;
      if (survival.inSurvival) survival.fallGrace = true;
      if (riding) {
        animals.dismount(riding); // a teleport leaves the horse behind
        riding = null;
      }
      detachBody(player, pigs.list); // a pig on the player's head (or under its feet) stays behind (§31)
      detachBody(player, zombies.list); // … and so does a zombie
      if (world) world.update(x, z);
      if (runner) runner.seedStep(); // arriving by teleport is not stepping onto a rune
      updateHit();
    },
    setLook(yaw, pitch) {
      if (Number.isFinite(yaw)) controls.yaw = yaw;
      if (Number.isFinite(pitch)) controls.pitch = pitch;
      updateHit();
    },
    getState: () => state,
    stepFrame: (dt) => stepFrame(dt),
    runCommand: (line) => (runner ? runner.runConsoleLine(line) : null),
    get runes() {
      return runeStore;
    },
    get runner() {
      return runner;
    },
    get physics() {
      return blockPhysics;
    },
    zombies,
    watcher,
    // ---- v0.10 circuits and black holes (§6.6 debug handle) ----
    get circuits() {
      return circuits;
    },
    circuitStore,
    blackHoles,
    infall,
    /** One frame of holding right-click on the current target (the real latch path; harness-like drivers). */
    rightClick: (pressed, dt = 0) => {
      if (!player || state !== STATE.PLAYING) return null;
      const mouse = { rightPressed: Boolean(pressed), right: true };
      const shift = controls.isDown('ShiftLeft') || controls.isDown('ShiftRight');
      if (survival.inSurvival) {
        survivalRight(mouse, dt);
        return null;
      }
      return rightMouseStep(controlLatch, mouse, hit, shift, dt, latchEnv);
    },
    /** Let go of the right mouse button. */
    rightRelease: () => controlLatch.release(),
    /** Shift+R on the current target: the device panel or the rune editor. */
    editTarget: () => {
      if (player && state === STATE.PLAYING) editTarget();
    },
    openDevicePanel: (q, y, r) => openDevicePanel(q, y, r),
    closeDevicePanel: () => closeDevicePanel(),
    /** `?scene=` (§6.7) as the page was opened with, the scene builder and its named cells. */
    get urlScene() {
      return params.scene ?? null;
    },
    buildScene: (name, delay) => buildScene(name, delay),
    get sceneCells() {
      return sceneNamed;
    },
    /** Wire segments drawn (the F3 circuits line). */
    circuitSegments: () => geoTmp.seg.count,
    // ---- v0.9 Survival (§9.5 GameContext) ----
    survival,
    pack,
    // ---- v0.10 loose items (§60): the list, and Q / G ----
    animals,
    /** §69: R on the animal under the crosshair (feed, shear, ride, sit), and the horse being ridden. */
    animalR: () => animalR(),
    getRiding: () => riding,
    loose,
    handAction: (kind, n = 1) => handAction(kind, n),
    /** Queue a mode switch (applied at the top of the next frame). */
    setMode(mode) {
      requestMode(mode);
    },
    getMode: () => survival.mode,
    /** `?mode=` as the page was opened with (the smoke test's optional survival step). */
    get urlMode() {
      return urlMode;
    },
    selectSlot: (i) => selectSlot(i),
    /** One press of R on the current target (both modes; screenshot drivers). */
    interact: () => {
      if (!player || state !== STATE.PLAYING) return;
      if (survival.inSurvival) survivalR(true, 0);
      else interactTarget();
    },
    /** One frame of holding LMB on the target in Survival (smoke test): the real dig path. */
    digTargeted: (dt) => (survival.active && player ? digStep(dt, true) : null),
    /** One frame of holding RMB with the selected item in Survival (smoke test): the real use path. */
    useSelected: (dt) => {
      if (!survival.active || !player) return null;
      survivalRight({ right: true, rightPressed: false }, dt);
      return { progress: useProgress };
    },
    dispose,
  };

  installDebugHandle(win, game);

  // ---- per-frame work -------------------------------------------------------------------------------

  function now() {
    return typeof win.performance !== 'undefined' && typeof win.performance.now === 'function'
      ? win.performance.now()
      : Date.now();
  }

  /**
   * Black holes (§6.6 step 7): swallow the player (Creative: back to the nearest point near spawn that no hole can reach,
   * §29, with the void flash; Survival: a death), arm charges, let each vortex eat its neighbourhood (the eaten blocks start
   * their infall), then the phase events' effects and the vortices' streaming particles.
   */
  function stepBlackHoles(dt) {
    if (blackHoles.size === 0 && !blackHoles.busy) return;
    if (blackHoles.size > 0) {
      const swallowed = blackHoles.swallowing(player);
      if (swallowed && survival.active) {
        // Survival (§2.4): swallowed is a death, and the belongings go with you (no teleport; the checkpoint runs die()).
        pendingDeath ??= 'blackhole';
      } else if (swallowed) {
        const [sx, sy, sz] = blackHoles.respawnPoint(world.findSpawn(), blackHoleWorld);
        game.teleport(sx, sy, sz);
        // §2.7: a near-black void flash in the same frame, a falling whoosh and the chat line (throttled as before).
        flashState.level = VOID_FLASH_LEVEL;
        flashState.sinceStart = 0;
        flashKind = 'void';
        if (fxTime - lastSwallowLineAt >= BLACK_HOLE_SWALLOW_LINE_S) {
          lastSwallowLineAt = fxTime;
          logLine(SWALLOWED_LINE);
          audio.playRecipe('bhSwallow', 1);
        }
      }
    }
    if (blackHoles.inert === 0) {
      inertHolesWarned = false;
    } else if (!inertHolesWarned) {
      inertHolesWarned = true;
      logLine(`Only ${BLACK_HOLE_MAX_TRACKED} black holes can be active at once: the rest do nothing until some are broken.`);
    }
    const eaten = blackHoles.update(dt, blackHoleWorld);
    const eyeY = player.y + getEyeHeight(player);
    // One crunch per frame at most, and only for cells the player is near enough to hear; every eaten block spirals in.
    let crunched = false;
    for (const e of eaten) {
      infall.addBlock(e, player.x, eyeY, player.z);
      if (crunched) continue;
      const [ex, ez] = hexToWorld(e.q, e.r);
      if (Math.hypot(ex - player.x, e.y - player.y, ez - player.z) < 16) {
        audio.playBreak(getBlockDef(e.id).soundGroup);
        crunched = true;
      }
    }
    blackHoleEvents(eyeY);
    if (dt > 0) streamVortexParticles(dt, eyeY);
  }

  /**
   * The phase events' effects (§6.6 step 7 table), the nearest BH_EVENTS_PER_TYPE of each type per frame: arm → bhArm;
   * flash → the screen-flash trigger (line of sight, facing, the 0.5 s gap), bhFlash and 24 white sparks; implode → bhImplode
   * and the spherical inward burst; collapsed → an outward burst and bhCollapse. `formed` and `cancelled` need nothing.
   */
  function blackHoleEvents(eyeY) {
    bhEvents.length = 0;
    blackHoles.drainEvents(bhEvents);
    if (bhEvents.length === 0) return;
    const px = player.x;
    const pz = player.z;
    const d2 = (e) => (e.cx - px) ** 2 + (e.cy - eyeY) ** 2 + (e.cz - pz) ** 2;
    if (bhEvents.length > 1) bhEvents.sort((a, b) => d2(a) - d2(b));
    /** @type {Record<string, number>} */
    const done = {};
    for (const e of bhEvents) {
      const n = done[e.type] ?? 0;
      if (n >= BH_EVENTS_PER_TYPE) continue;
      done[e.type] = n + 1;
      switch (e.type) {
        case 'arm':
          playCircuitSound('bhArm', e.cx, e.cy, e.cz, 1);
          break;
        case 'flash': {
          playCircuitSound('bhFlash', e.cx, e.cy, e.cz, 1);
          particles.emit('sparks', e.cx, e.cy, e.cz, 24, { color: [1, 1, 1], speed: 1.2 });
          const level = flashLevelFor(e, eyeY);
          if (level > 0 && (!flashTrigger || level > flashTrigger.level)) flashTrigger = { level };
          break;
        }
        case 'implode':
          playCircuitSound('bhImplode', e.cx, e.cy, e.cz, 1);
          particles.emitOrbit('infall', e.cx, e.cy, e.cz, 64, {
            rMin: 3.0, rMax: 3.6, hMax: 3.3, spherical: true, radial: true, inward: 2.8, color: [1, 1, 1], hot: [0.69, 0.227, 0.102],
          });
          break;
        case 'collapsed':
          playCircuitSound('bhCollapse', e.cx, e.cy, e.cz, 1);
          particles.emit('infall', e.cx, e.cy, e.cz, 24, { speed: 4 });
          break;
        default:
          break; // formed (the renderer flares from the phase), cancelled
      }
    }
    bhEvents.length = 0;
  }

  /** §2.4.6: how bright a charge's FLASH is on screen — distance, facing and one line-of-sight ray. */
  function flashLevelFor(e, eyeY) {
    const dx = e.cx - player.x;
    const dy = e.cy - eyeY;
    const dz = e.cz - player.z;
    const d = Math.hypot(dx, dy, dz);
    if (!(d < BLACK_HOLE_SCREEN_FLASH_RANGE)) return 0;
    const cp = Math.cos(controls.pitch);
    const vx = -Math.sin(controls.yaw) * cp;
    const vy = Math.sin(controls.pitch);
    const vz = -Math.cos(controls.yaw) * cp;
    const dot = d > 1e-6 ? (vx * dx + vy * dy + vz * dz) / d : 1;
    let covered = false;
    if (d > 1.0) {
      // The hole's own cell stops the ray too (it is targetable); only a nearer block hides it.
      const ray = raycastHex(world.getBlock, player.x, eyeY, player.z, dx / d, dy / d, dz / d, d);
      covered = !!ray && !(ray.q === e.q && ray.y === e.y && ray.r === e.r) && ray.distance < d - 0.6;
    }
    return screenFlashLevel(d, dot, covered);
  }

  /** §2.4.5: the nearest VORTEX_PARTICLE_HOLES vortices within VORTEX_PARTICLE_RANGE stream VORTEX_PARTICLES_PER_S each. */
  function streamVortexParticles(dt, eyeY) {
    if (blackHoles.size === 0) {
      if (vortexAcc.size > 0) vortexAcc.clear();
      return;
    }
    /** @type {{ h: *, d: number }[]} */
    const near = [];
    const r2 = VORTEX_PARTICLE_RANGE * VORTEX_PARTICLE_RANGE;
    for (const h of blackHoles.holes.values()) {
      if (h.phase !== PHASE.VORTEX) continue;
      const d = (h.cx - player.x) ** 2 + (h.cy - eyeY) ** 2 + (h.cz - player.z) ** 2;
      if (d > r2) continue;
      if (near.length < VORTEX_PARTICLE_HOLES) near.push({ h, d });
      else {
        let worst = 0;
        for (let i = 1; i < near.length; i++) if (near[i].d > near[worst].d) worst = i;
        if (d < near[worst].d) near[worst] = { h, d };
      }
    }
    if (vortexAcc.size > 4 * VORTEX_PARTICLE_HOLES) vortexAcc.clear();
    if (!blackHoles.enabled) return; // a switched-off vortex barely turns (§2.8): no stream
    for (const { h } of near) {
      const acc = (vortexAcc.get(h.key) ?? 0) + VORTEX_PARTICLES_PER_S * dt;
      const n = Math.floor(acc);
      vortexAcc.set(h.key, acc - n);
      if (n > 0) particles.emitOrbit('infall', h.cx, h.cy, h.cz, n, { rMin: 2.5, rMax: 4.5, hMax: 0.6, color: 0x2e2620, hot: 0xffc890 });
    }
  }

  /**
   * Campfires: a player standing in one is bounced out (away from its centre, with a hop) and told it is hot; nearby
   * fires crackle at random, fading out by CAMPFIRE_CRACKLE_RANGE.
   */
  function stepCampfires(dt) {
    // The burn reads the block, so it holds for every campfire, tracked or not (past CAMPFIRE_MAX_TRACKED).
    // Dead centre: back out the way you came.
    if (scorchPlayer(player, world.getBlock, () => yawToForward(controls.yaw + Math.PI))) {
      if (fxTime - lastHotLineAt > 2) {
        lastHotLineAt = fxTime;
        logLine('Ouch! That campfire is hot.');
      }
      audio.playCrackle(1);
      // Survival (§2.4): a scorch burns, at most once per FIRE_SCORCH_GAP_S.
      if (survival.active && fxTime - scorchAt >= FIRE_SCORCH_GAP_S) {
        scorchAt = fxTime;
        hurt(FIRE_BURN_DAMAGE, 'fire');
      }
    }
    if (campfires.size === 0) return;
    const near = campfires.nearest(player.x, player.y, player.z, CAMPFIRE_CRACKLE_RANGE, 1);
    if (near.length && Math.random() < CAMPFIRE_CRACKLES_PER_S * dt) audio.playCrackle(1 - near[0].dist / CAMPFIRE_CRACKLE_RANGE);
  }

  /** Pigs wander (and feel black holes); ambient oinks fade out by 16 units; a swallowed pig is gone. */
  function stepPigs(dt) {
    if (pigs.size === 0) return;
    pigWorld.player = player && !survival.dead ? player : null;
    const oinks = pigs.update(dt, pigWorld);
    for (const pig of pigs.scorched) {
      const d = Math.hypot(pig.x - player.x, pig.y - player.y, pig.z - player.z);
      if (d < 16) audio.playSqueal(1 - d / 16);
    }
    for (const pig of oinks) {
      const d = Math.hypot(pig.x - player.x, pig.y - player.y, pig.z - player.z);
      if (d < 16) {
        audio.playOink(1 - d / 16);
        break;
      }
    }
    if (blackHoles.size === 0) return;
    for (let i = pigs.list.length - 1; i >= 0; i--) {
      const pig = pigs.list[i];
      const hole = blackHoles.swallowing(pig);
      if (!hole) continue;
      pigs.remove(pig);
      // §2.7: it spirals in as a ghost; the squeal comes at the end of its flight (stepInfall). Past the ghost cap, now.
      if (!infall.addMob('pig', pig, hole.cx, hole.cy, hole.cz)) pigGoneSqueal(pig);
    }
  }

  /** A swallowed pig's squeal, fading out by 16 units. */
  function pigGoneSqueal(pig) {
    const d = Math.hypot(pig.x - player.x, pig.y - player.y, pig.z - player.z);
    if (d < 16) audio.playSqueal(1 - d / 16);
  }

  // ---- zombies (CONTRACTS §39) ----------------------------------------------------------------------

  /** Distance to the nearest tracked campfire's floor centre within maxDist (written to out), else Infinity. */
  function nearestCampfire(x, y, z, maxDist, out) {
    let best = Infinity;
    if (campfires.size === 0) return best;
    for (const fire of campfires.fires.values()) {
      const d = Math.hypot(fire.x - x, fire.y - y, fire.z - z);
      if (d <= maxDist && d < best) {
        best = d;
        out[0] = fire.x;
        out[1] = fire.y;
        out[2] = fire.z;
      }
    }
    return best;
  }

  /** @returns {number} 1 at the player fading to 0 at ZOMBIE_SOUND_RANGE (0 beyond) */
  function zombieVolume(zb) {
    return zombieVolumeFor(zb, player);
  }

  /** A zombie is gone — knocked out ('ko', a dull grey-green puff) or burned away ('burn', ash, smoke and embers). */
  function zombieGone(zb, how) {
    const cy = zb.y + ZOMBIE_HEIGHT / 2;
    if (how === 'burrow') {
      // §68: it sinks back into the ground by day — a puff of soil at its feet, no knock-out sound.
      particles.emit('dust', zb.x, zb.y + 0.3, zb.z, 22, { color: [0.42, 0.32, 0.22], spread: 0.5 });
      if (zombieTarget && zombieTarget.zombie === zb) zombieTarget = null;
      return;
    }
    if (how === 'burn') {
      particles.emit('smoke', zb.x, cy + 0.3, zb.z, 14, { spread: 0.45 });
      particles.emit('sparks', zb.x, cy, zb.z, 10, { speed: 0.35 });
      particles.emit('dust', zb.x, cy, zb.z, 18, { color: [0.24, 0.23, 0.22], spread: 0.4 });
    } else {
      particles.emit('dust', zb.x, cy, zb.z, 28, { color: [0.45, 0.55, 0.38], spread: 0.45 });
      particles.emit('smoke', zb.x, cy, zb.z, 6, { spread: 0.4, color: [0.5, 0.55, 0.47] });
    }
    // One down sound a frame, the loudest (a crowd burning out together at dawn is one voice): played after the step.
    zombieDownVolume = Math.max(zombieDownVolume, zombieVolume(zb));
    if (zombieTarget && zombieTarget.zombie === zb) zombieTarget = null;
  }

  /** The player's left-click on a zombie: knockback and a red flash, or a knock-out on the ZOMBIE_HITS-th hit. */
  function hitZombie(zb) {
    const res = zombies.hit(zb, player.x, player.z);
    if (res === 'ko') zombieGone(zb, 'ko');
    else if (res === 'hit') audio.playZombieHurt(1);
  }

  /**
   * Zombies: natural spawning at night, AI, daylight, attacks (knockback + red flash + thump), groans; smouldering
   * ones smoke; black holes swallow them.
   */
  function stepZombies(dt) {
    zombieWorld.player = player;
    zombieWorld.isDay = isDayTime(time);
    const ev = zombies.update(dt, zombieWorld);
    if (ev.attacks.length > 0) {
      hurtFlash = 1;
      audio.playThud(1);
      // Survival (§2.4): each strike deals ZOMBIE_DAMAGE, an alpha's more (§61, §65; zombies.js stays mode-agnostic).
      if (survival.active) {
        let dmg = 0;
        for (const zb of ev.attacks) dmg += ZOMBIE_DAMAGE * damageOf(zb); // an alpha hits softer by day (§65)
        hurt(Math.round(dmg), 'zombie');
      }
    }
    // §61: a horde raised an alpha.
    for (const zb of ev.alphas) {
      logLine('A runner in the horde has turned alpha: bigger, tougher, and the others follow it.');
      audio.playRecipe(SOUND_ROAR, Math.max(0.35, zombieVolume(zb)));
      particles.emit('dust', zb.x, zb.y + 1, zb.z, 24, { color: [0.4, 0.12, 0.1], spread: 0.6 });
    }
    for (const zb of ev.groans) {
      const v = zombieVolume(zb);
      if (v > 0) {
        audio.playGroan(v);
        break; // one groan a frame at most
      }
    }
    // One hiss and one scorch yelp a frame at most, the loudest (a crowd ignites together at dawn).
    const hiss = loudestVolume(ev.ignited, player);
    if (hiss > 0) audio.playHiss(hiss);
    const yelp = loudestVolume(ev.scorched, player);
    if (yelp > 0) audio.playZombieHurt(yelp);
    for (const zb of ev.burned) zombieGone(zb, 'burn');
    for (const zb of ev.knockedOut) zombieGone(zb, 'ko');
    for (const zb of ev.burrowed) zombieGone(zb, 'burrow');
    for (const zb of zombies.list) {
      if (!zb.smoking) continue;
      // Smoke thickens as it burns; now and then an ember.
      if (Math.random() < dt * (6 + 10 * (zb.burn / 4))) particles.emit('smoke', zb.x, zb.y + 1.2 + Math.random() * 0.7, zb.z, 1, { spread: 0.3 });
      if (Math.random() < dt * 3) particles.emit('sparks', zb.x, zb.y + 1.0, zb.z, 1, { speed: 0.25 });
    }
    if (blackHoles.size === 0) return;
    for (let i = zombies.list.length - 1; i >= 0; i--) {
      const zb = zombies.list[i];
      const hole = blackHoles.swallowing(zb);
      if (!hole) continue;
      zombies.remove(zb);
      // §2.7: a ghost spirals in; the knock-out puff comes at its end (stepInfall). Past the ghost cap, now.
      if (!infall.addMob('zombie', zb, hole.cx, hole.cy, hole.cz)) zombieGone(zb, 'ko');
    }
  }

  /**
   * §6.6 step 10: the circuit tick (≤ 2 per frame), then the infall — every block that reached the core leaves 3 `infall`
   * particles, every ghost that did squeals or puffs.
   */
  function stepCircuits(dt) {
    if (circuits) circuits.step(dt);
    syncLampLight();
    if (infall.size === 0) return;
    const st = infall.step(dt);
    for (let i = 0; i + 2 < st.gone.length; i += 3) particles.emit('infall', st.gone[i], st.gone[i + 1], st.gone[i + 2], 3, { spread: 0.1, speed: 0.4 });
    for (const m of st.mobsDone) {
      if (m.kind === 'pig') pigGoneSqueal(m.body);
      else if (m.kind === 'animal') animalVoice(m.body, 1);
      else zombieGone(m.body, 'ko');
    }
  }

  /** lit lamps as last given to the light engine: "q,y,r" → level (§72) */
  const lampLights = new Map();
  const lampScratch = /** @type {number[]} */ ([]);
  let lampFrame = 0;

  /**
   * §72: every lit Filament Lamp lights its surroundings — LAMP_LIGHT_MIN..LAMP_LIGHT_MAX by its brightness — through an
   * extra emitter on its cell (light.setEmitter); a lamp that goes out, or is gone, loses it. Checked every 6th frame.
   */
  function syncLampLight() {
    if (!world || (lampFrame++ % 6 !== 0)) return;
    const lit = circuits ? circuits.litLamps(lampScratch) : (lampScratch.length = 0, lampScratch);
    if (lit.length === 0 && lampLights.size === 0) return;
    const seen = new Set();
    for (let i = 0; i + 3 < lit.length; i += 4) {
      const key = `${lit[i]},${lit[i + 1]},${lit[i + 2]}`;
      const level = Math.round(LAMP_LIGHT_MIN + (LAMP_LIGHT_MAX - LAMP_LIGHT_MIN) * Math.min(1, lit[i + 3]));
      seen.add(key);
      if (lampLights.get(key) === level) continue;
      lampLights.set(key, level);
      world.light.setEmitter(lit[i], lit[i + 1], lit[i + 2], level);
    }
    for (const key of lampLights.keys()) {
      if (seen.has(key)) continue;
      const [q, y, r] = key.split(',').map(Number);
      world.light.setEmitter(q, y, r, 0);
      lampLights.delete(key);
    }
  }

  // ---- the Hollow Watcher (CONTRACTS §40) ------------------------------------------------------------

  /** Fill watcherWorld with this frame's player, view (camera FOV and window too), clock and fog distance. @returns {typeof watcherWorld} */
  function refreshWatcherWorld() {
    watcherWorld.player = player;
    if (player) {
      watcherWorld.eye[0] = player.x;
      watcherWorld.eye[1] = player.y + getEyeHeight(player);
      watcherWorld.eye[2] = player.z;
    }
    // coords.lookDirection, without the allocation (every frame)
    const cp = Math.cos(controls.pitch);
    watcherWorld.look[0] = -Math.sin(controls.yaw) * cp;
    watcherWorld.look[1] = Math.sin(controls.pitch);
    watcherWorld.look[2] = -Math.cos(controls.yaw) * cp;
    watcherWorld.yaw = controls.yaw;
    // The narrower of the camera's FOV and the walking one: a spot found while the sprint FOV is wider stays on screen
    // when the sprint ends.
    watcherWorld.fov = Math.min(fov, FOV);
    // … but while it is there, what is on screen is the camera's real view (wider while sprinting).
    watcherWorld.viewFov = fov;
    watcherWorld.aspect = renderer.three.camera.aspect;
    watcherWorld.time = time;
    watcherWorld.day = day;
    watcherWorld.fogFar = world ? fogRangeForRenderDistance(world.renderDistance).far : 0;
    return watcherWorld;
  }

  /**
   * The Watcher: natural sightings, its gaze / proximity / unseen vanishing, wisps; when it vanishes a puff of dark
   * smoke, a faint low sound and maybe a trace (plain world edits, applied in order).
   */
  function stepWatcher(dt) {
    const ev = watcher.update(dt, refreshWatcherWorld());
    const f = watcher.figure;
    if (ev.wisp && f) {
      // From the smoke wisp under its rings.
      const y = f.y + 0.1 + Math.random() * 0.6;
      particles.emit('smoke', f.x, y, f.z, 2, { spread: 0.15, speed: 0.4, color: [0.11, 0.11, 0.12] });
    }
    const gone = ev.vanished;
    if (!gone || gone.reason === 'unloaded') return;
    // A column of dark smoke the figure's height (it billows out and up), and a few ash-grey motes that fall.
    for (let h = 0.3; h < WATCHER_HEIGHT; h += 0.45) {
      particles.emit('smoke', gone.x, gone.y + h, gone.z, 8, { spread: 0.4, speed: 1.2, color: [0.07, 0.07, 0.08] });
    }
    particles.emit('dust', gone.x, gone.y + 1.3, gone.z, 18, { spread: 0.5, color: [0.42, 0.42, 0.41] });
    const d = Math.hypot(gone.x - player.x, gone.y - player.y, gone.z - player.z);
    audio.playWatcherVanish(Math.max(0.4, 1 - d / 100));
    if (gone.trace) for (const [q, y, r, id] of gone.trace.writes) world.setBlock(q, y, r, id);
  }

  /** Block physics: ≤ 1 tick, then fallers, toppling trees, lit barrels and blasts (CONTRACTS §33). */
  function stepBlockPhysics(dt) {
    if (blockPhysics) {
      const blasts = blockPhysics.explosions.blastCount;
      blockPhysics.step(dt); // the knock hook's player branch only records pendingKnock
      // Survival (§2.4): the hardest knock of the step hurts once — a blast if one went off, else a toppled log.
      if (pendingKnock > 0 && survival.active) {
        const dmg = knockDamage(pendingKnock);
        if (dmg > 0) {
          knockHurtThisFrame = true;
          hurt(dmg, knockCause(blasts, blockPhysics.explosions.blastCount));
        }
      }
      pendingKnock = 0;
      // §2.4 crush: falling ground (sand, gravel, a collapse) filled the player's cell and lifted them — the same guards
      // as the unstickPlayer lift (not on a teleport frame, under fall grace, or on top of a knock this frame).
      if (pendingCrush > 0 && survival.active && !survival.fallGrace && !teleportFrame && !knockHurtThisFrame) {
        hurt(crushDamage(pendingCrush), 'crush');
      }
      pendingCrush = 0;
    }
    if (breakVolume > 0) {
      audio.playBreak(breakGroup, breakVolume);
      breakVolume = 0;
    }
    if (knockSqueal > 0) {
      audio.playSqueal(knockSqueal);
      knockSqueal = 0;
    }
    if (zombieDownVolume > 0) {
      audio.playZombieDown(zombieDownVolume);
      zombieDownVolume = 0;
    }
  }

  /**
   * A block filled into the player (a command, a landing log, a rune) is never a trap: when the player overlaps a solid
   * cell after everything has moved, lift them to the first free height within three cells.
   * v0.9 (§2.4): reports how many whole cells it lifted (crush damage) and, when there is no room within three cells and
   * the eye cell is solid, `buried` (breath drains as under water).
   * @returns {{ lifted: number, buried: boolean }}
   */
  function unstickPlayer() {
    if (!world.hasChunkAt(player.x, player.z) || isFreeAt(world.getBlock, player.x, player.y, player.z)) return NOT_STUCK;
    const fy = findFreeY(world.getBlock, player.x, player.z, Math.floor(player.y) + 1, 3);
    if (fy === null) {
      const [q, r] = worldToHex(player.x, player.z);
      return { lifted: 0, buried: isSolid(world.getBlock(q, Math.floor(player.y + getEyeHeight(player)), r)) };
    }
    const lifted = cellsLifted(player.y, fy);
    player.y = fy;
    if (player.vy < 0) player.vy = 0;
    return { lifted, buried: false };
  }
  const NOT_STUCK = Object.freeze({ lifted: 0, buried: false });

  /**
   * Input, interaction, physics, clock, streaming and raycast — while playing, and (v0.9, §9.5) under the pack screen and
   * the field book too, with the controls disabled so the player stands still while the world runs.
   */
  function stepPlaying(dt) {
    const SV = survival.inSurvival;
    const st0 = state;
    const input = controls.getInput();
    knockHurtThisFrame = false;

    // Flight is Creative's (§0): in Survival the toggle is consumed and ignored.
    if (controls.consumeFlyToggle() && !SV) {
      player.flying = !player.flying;
      player.vy = 0;
    }
    // Modal keys first, so a key that opens a modal never also acts on the hotbar in the same frame.
    if (controls.consumePressed('KeyE')) {
      if (SV) openPack();
      else openPicker();
      if (state !== st0) return; // the modal's frame still renders below
    }
    if (controls.consumePressed('KeyT')) {
      openConsole('');
      return;
    }
    if (controls.consumePressed('Slash')) {
      openConsole('/');
      return;
    }
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      if (controls.consumePressed(DIGIT_CODES[i])) selectSlot(i);
    }
    if (controls.consumePressed('F3')) hud.toggleDebug();
    if (controls.consumePressed('KeyM')) hud.showSaveToast(audio.toggleMuted() ? 'Sound muted' : 'Sound on');
    // §60: Q drops the item in hand (Shift: the whole stack), G throws one.
    if (controls.consumePressed('KeyQ')) {
      const res = handAction('drop', controls.isDown('ShiftLeft') || controls.isDown('ShiftRight') ? 'all' : 1);
      if (!res.ok && res.loud) logLine(res.message);
    }
    if (controls.consumePressed('KeyG')) {
      const res = handAction('throw', 1);
      if (!res.ok && res.loud) logLine(res.message);
    }

    const mouse = controls.consumeMouse();
    if (mouse.wheel !== 0) selectSlot(wheelSlot(selected, mouse.wheel));

    const rPressed = controls.consumePressed('KeyR');
    const shift = controls.isDown('ShiftLeft') || controls.isDown('ShiftRight');
    // §69: R on an animal or a snare comes first, sneaking or not (you sneak up to feed and to shear).
    if (rPressed && (animalR() || snareR())) {
      // handled
    } else if (rPressed && shift) {
      editTarget(); // a part's device panel (§4.10) or a rune's editor
      if (state !== st0) return;
    } else if (SV) {
      // §9.4 the R priorities, with the parts' own R actions and the pocket key (DESIGN-circuits §4.9).
      survivalR(rPressed, dt);
      if (state !== st0) return;
    } else if (rPressed) {
      interactTarget();
    }
    // §4.9: a held R key keeps the Push Button (or the Relay's armature) it pressed held while the crosshair stays on it.
    if (rHeldCell && !rPressed) {
      const h = hit;
      if (circuits && controls.isDown('KeyR') && h && h.q === rHeldCell[0] && h.y === rHeldCell[1] && h.r === rHeldCell[2]) {
        circuits.hold(h.q, h.y, h.r);
      } else {
        rHeldCell = null;
      }
    }

    // Interaction uses the hit computed at the end of the previous frame (what the highlight showed).
    if (SV) {
      // §6.1 strike or hold to dig; §5.3 / §4.5 place or hold to use; middle mouse only selects (never conjures).
      survivalLeft(mouse, dt);
      if (state !== st0) return;
      survivalRight(mouse, dt);
      if (state !== st0) return;
      if (mouse.middlePressed) selectSlotHolding(hit);
    } else {
      leftMouseStep(leftHold, mouse, dt, leftEnv); // a press breaks (or snuffs a burning keg); held, it repeats
      // §4.9: right-click operates a control (Shift: places against it), with the control latch; else it places.
      rightMouseStep(controlLatch, mouse, hit, shift, dt, latchEnv);
      if (mouse.middlePressed) pickTargeted();
    }

    // §2.3: the body limits sprinting and slows walking (physics §9.3 speedFactor).
    if (survival.active) {
      const status = survival.status;
      input.sprint = input.sprint && status.canSprint;
      input.speedFactor = status.moveFactor;
    } else {
      input.speedFactor = 1;
    }

    // Physics only where terrain exists (getBlock reports AIR in unloaded chunks). Black holes pull on the
    // player's middle; `input` is the controls' reused object, so the pull is written every frame.
    blackHoles.pullAt(player.x, player.y + PLAYER_HEIGHT / 2, player.z, pull);
    if (blockPhysics) blockPhysics.fluids.currentAt(player.x, player.y + 0.1, player.z, current);
    input.pullX = pull[0] + (blockPhysics ? current[0] : 0);
    input.pullY = pull[1] + (blockPhysics ? current[1] : 0);
    input.pullZ = pull[2] + (blockPhysics ? current[2] : 0);
    stepRide(input, dt);
    if (!riding && world.hasChunkAt(player.x, player.z)) stepPlayer(player, input, world.getBlock, dt);
    stepBlackHoles(dt);
    if (checkDeath()) return; // §2.5 checkpoint
    stepPigs(dt);
    stepAnimals(dt);
    stepZombies(dt);
    stepWatcher(dt);
    stepBlockPhysics(dt);
    stepCampfires(dt);
    stepCircuits(dt); // v0.10 (§6.6 step 10): the circuit tick and the infall
    if (sceneCharge && fxTime >= sceneCharge.at) {
      const c = sceneCharge;
      sceneCharge = null;
      const res = blackHoles.activate(c.q, c.y, c.r, blackHoleWorld);
      if (!res.ok) logLine(res.message, true);
    }
    if (checkDeath()) return; // §2.5 checkpoint
    // Bodies collide, push and stand on each other once everything has moved (CONTRACTS §31). Pigs in unloaded
    // chunks are frozen and stay out of it; lit barrels (explosions.js) take part against the player and pigs.
    bodies.length = 0;
    if (!riding) bodies.push(player); // a rider sits in the horse's own (taller) body
    for (const pig of pigs.list) if (world.hasChunkAt(pig.x, pig.z)) bodies.push(pig);
    for (const a of animals.list) if (isBodyAnimal(a) && world.hasChunkAt(a.x, a.z)) bodies.push(a);
    for (const zb of zombies.list) if (world.hasChunkAt(zb.x, zb.z)) bodies.push(zb);
    if (blockPhysics) blockPhysics.bodies(bodies);
    if (bodies.length > 1) resolveBodies(bodies, world.getBlock);
    const stuck = riding ? NOT_STUCK : unstickPlayer();
    stepLoose(dt); // §60: after the bodies moved, so a drop flies at where the player now is
    // §2.4 crush: falling ground lifted the player — not on a teleport frame, under fall grace, or on top of a knock.
    if (stuck.lifted > 0 && survival.active && !survival.fallGrace && !teleportFrame && !knockHurtThisFrame) {
      hurt(crushDamage(stuck.lifted), 'crush');
    }
    teleportFrame = false;

    if (params.time == null) {
      const nt = advanceTime(time, dt);
      if (nt < time) day++;
      time = nt;
    }

    // §9.5 step 12: the body, the lanes, the fires, regrowth, spoilage, pigs — only while Survival is active.
    if (survival.active) {
      stepSurvival(dt, stuck.buried);
      if (checkDeath()) return; // §2.5 checkpoint
    }

    // Rune scripts run after physics (step-on sees where the player landed) and before world.update() so their
    // edits are re-meshed this frame. A modal opened by a script (none today) would stop the loop next frame.
    if (runner && state === STATE.PLAYING) runner.update(dt);
    if (checkDeath()) return; // §2.5 checkpoint (a script's damage)

    world.update(player.x, player.z);
    updateHit();
    autosaveTick(dt);
  }

  /** Camera, sky, highlight, HUD and the draw — every state that has a player. */
  function renderFrame(dt) {
    const eyeY = player.y + getEyeHeight(player);
    const live = stateSimulates(state, survival.inSurvival);
    // Moving cells (block physics' items, then the charge copies and the infall, §6.6), the one flash light (the brighter of
    // a blast and a charge, with its colour) and the camera shake (a blast plus the implosion), then the particles (frozen
    // unless the world runs with physics on: `physics off` freezes its effects in place too).
    movingCount = 0;
    flash.intensity = 0;
    if (blockPhysics) {
      const list = blockPhysics.renderItems();
      for (let i = 0; i < list.count; i++) {
        const it = list.items[i];
        pushMoving(it.id, it.x, it.y, it.z, it.rx, it.ry, it.rz, it.scale);
      }
      blockPhysics.explosions.flash(flash);
      blockPhysics.explosions.shakeOffset(player.x, eyeY, player.z, shake);
    } else {
      shake[0] = 0;
      shake[1] = 0;
      shake[2] = 0;
    }
    blackHoles.renderItems(pushMoving);
    infall.renderItems(pushMoving);
    // §60: loose block items as small spinning cells; every other loose item is a picture (looseRenderer)
    for (const it of loose.list) {
      if (it.block < 0 || blinkHidden(it, fxTime)) continue;
      const bob = it.mode === 'rest' ? 0.04 + 0.04 * Math.sin(fxTime * 3 + it.spin) : 0;
      pushMoving(it.block, it.x, it.y + bob, it.z, 0.3, it.spin, 0.2, LOOSE_BLOCK_SCALE);
    }
    looseRenderer.sync(loose.list, fxTime, (it) => it.block >= 0 || blinkHidden(it, fxTime));
    fallingRenderer.sync(movingItems, movingCount);
    circuitRenderer.syncMoving(movingItems, movingCount); // devices among them as models: the collapsar's copy, debris
    blackHoles.flash(bhFlash);
    if (bhFlash.intensity > flash.intensity) fallingRenderer.setFlash(bhFlash.x, bhFlash.y, bhFlash.z, bhFlash.intensity, bhFlash.color);
    else fallingRenderer.setFlash(flash.x, flash.y, flash.z, flash.intensity);
    blackHoles.cameraFx(player.x, eyeY, player.z, camFx);
    particles.update(state === STATE.PLAYING && !(blockPhysics && blockPhysics.paused) ? dt : 0);
    renderer.setCamera(player.x + shake[0] + camFx.sx, eyeY + shake[1] + camFx.sy, player.z + shake[2] + camFx.sz, controls.yaw, controls.pitch);
    fov = easeFov(fov, player.sprinting && state === STATE.PLAYING ? SPRINT_FOV : FOV, dt);
    renderer.setFov(fov + camFx.fov);
    renderCircuitsAndVortices(dt, eyeY, live);
    renderer.setHighlight(hit);
    const SV = survival.inSurvival;
    // §9.9: the dig trace follows the cell's hex outline in honey as it is dug (hidden when not digging).
    renderer.setDigProgress(SV && digHit && digProgress > 0 ? digHit : null, digProgress);
    // The live mobs plus the swallowed ones still spiralling in (§2.7).
    if (infall.mobs > 0) {
      pigDraw.length = 0;
      for (const p of pigs.list) pigDraw.push(p);
      infall.ghosts('pig', pigDraw);
      zombieDraw.length = 0;
      for (const z of zombies.list) zombieDraw.push(z);
      infall.ghosts('zombie', zombieDraw);
      pigRenderer.sync(pigDraw);
      zombieRenderer.sync(zombieDraw, fxTime, 1 - sky.daylight);
      animalDraw.length = 0;
      for (const a of animals.list) animalDraw.push(a);
      infall.ghosts('animal', animalDraw);
      animalRenderer.sync(animalDraw);
    } else {
      animalRenderer.sync(animals.list);
      pigRenderer.sync(pigs.list);
      zombieRenderer.sync(zombies.list, fxTime, 1 - sky.daylight);
    }
    watcherRenderer.sync(watcher.figure, player.x, eyeY, player.z, fxTime);
    hurtFlash = Math.max(0, hurtFlash - dt / HURT_FLASH_S);
    hud.setHurtFlash(hurtFlash);
    fxTime += dt;
    // Past CAMPFIRE_MAX_TRACKED, keep the tracked fires the ones nearest the player (a no-op otherwise).
    campfires.retrack(player.x, eyeY, player.z);
    if (campfires.size > 0 || !campfireRenderer.idle()) {
      const near = campfires.nearest(player.x, eyeY, player.z, CAMPFIRE_MODEL_RANGE)
        .filter((n) => world.hasChunkAtCell(n.fire.q, n.fire.r))
        .slice(0, CAMPFIRE_MAX_MODELS);
      // §9.9: the skewers, the food on them and the pot in the embers (fire spots, Survival only hold anything).
      campfireRenderer.sync(near, fxTime, dt, spotsViewFn);
    }
    computeSky(time, sky);
    stepWorldSounds(dt, live); // v0.16 (§82): footsteps, movement and the ambience
    renderer.setSky(sky);
    renderer.setUnderwater(player.headInWater);
    hud.setUnderwater(player.headInWater);
    // §9.8: the survival HUD — hex hotbar from the pack (no per-frame copy), vitals bookends, the action ring, the job chip.
    hud.setSurvivalVisible(SV);
    hud.setHotbarStacks(SV ? pack.slots : null, selected, pack.version);
    if (SV) {
      const v = survival.vitals;
      vitalsView.health = v.health;
      vitalsView.satiation = v.satiation;
      vitalsView.hydration = v.hydration;
      vitalsView.temp = v.temp;
      vitalsView.felt = survival.felt;
      vitalsView.breath = v.breath;
      vitalsView.labels = survival.status.labels;
      vitalsView.target = bodyTarget(survival.felt, Boolean(player.inWater));
      hud.setVitals(vitalsView);
      hud.setActionProgress(state === STATE.PLAYING ? actionProgress() : null);
      hud.setJobChip(craftQueue.chipText());
    } else {
      hud.setActionProgress(null);
      hud.setJobChip(null);
    }
    hud.setTargetHint(state === STATE.PLAYING ? targetHintText() : null);
    // The device panel's reading stays live while the world runs under it (Survival, §4.10).
    if (state === STATE.DEVICE && live) {
      deviceRefreshAccum += dt;
      if (deviceRefreshAccum >= DEVICE_REFRESH_S) {
        deviceRefreshAccum = 0;
        refreshDevicePanel();
      }
    }
    if (hud.isDebugVisible()) hud.setDebugText(buildDebugText(game, stats));
    renderer.render();
  }

  /**
   * §6.6 renderFrame: the vortices, the circuit wiring (rebuilt when the circuits' geometry changes or the eye moved
   * CIRCUIT_REBUILD_MOVE units) and overlays, the screen flash and the drone.
   */
  function renderCircuitsAndVortices(dt, eyeY, live) {
    const eye = viewEye;
    eye[0] = player.x;
    eye[1] = eyeY;
    eye[2] = player.z;
    vortexRenderer.sync(blackHoles.vortexViews(player.x, eyeY, player.z, VORTEX_MODEL_RANGE, VORTEX_MAX_MODELS, VORTEX_MAX_CORES,
      vortexViewsTmp), fxTime, eye);
    if (circuits) {
      const moved = !(Math.hypot(player.x - geoEye[0], eyeY - geoEye[1], player.z - geoEye[2]) < CIRCUIT_REBUILD_MOVE);
      if (wiringRebuildDue(geoBuilt, circuits.geometryVersion, circuits.burnVersion, moved, fxTime)) {
        geoBuilt.geometry = circuits.geometryVersion;
        geoBuilt.burn = circuits.burnVersion;
        geoBuilt.at = fxTime;
        geoEye[0] = player.x;
        geoEye[1] = eyeY;
        geoEye[2] = player.z;
        circuitRenderer.setGeometry(wireSegments(circuits.geometryView(), player.x, eyeY, player.z, CIRCUIT_DRAW_RANGE, geoTmp));
        circuits.geometryBuilt(); // the burnt-out cords are gone from it: their chars go too
      }
      // Every frame: the engine also keeps this eye for its nearest-first sparks and sounds.
      circuitRenderer.syncOverlays(circuits.overlays(player.x, eyeY, player.z, CIRCUIT_OVERLAY_RANGE, overlayTmp), fxTime, live ? dt : 0);
    }
    // The screen flash (§2.4.6): this frame's trigger, if any, then the fade.
    const level = flashStep(flashState, live ? dt : 0, flashTrigger);
    if (flashTrigger && flashKind !== 'white' && flashState.sinceStart === 0) flashKind = 'white';
    flashTrigger = null;
    hud.setFlashOverlay(level, flashKind);
    if (level === 0) flashKind = 'white';
    // The drone: the nearest vortex within DRONE_RANGE, its pitch rising 10 % within 3 units (§2.11).
    let dn = Infinity;
    if (blackHoles.size > 0 && live && blackHoles.enabled) {
      for (const h of blackHoles.holes.values()) {
        if (h.phase !== PHASE.VORTEX) continue;
        const d = Math.hypot(h.cx - player.x, h.cy - eyeY, h.cz - player.z);
        if (d < dn) dn = d;
      }
    }
    if (dn < DRONE_RANGE) droneLoop.set(0.5 * (1 - dn / DRONE_RANGE), dn < 3 ? 1.1 : 1);
    else droneLoop.set(0, 1);
  }

  function refreshStats(rawDt) {
    fpsFrames++;
    fpsAccum += rawDt;
    if (fpsAccum >= 1) {
      stats.fps = fpsFrames / fpsAccum;
      stats.frameMs = (fpsAccum * 1000) / fpsFrames;
      fpsFrames = 0;
      fpsAccum = 0;
    }
    statsAccum += rawDt;
    if (statsAccum < STATS_INTERVAL_S) return;
    statsAccum = 0;
    stats.day = day;
    if (world) {
      stats.chunksLoaded = world.chunkCount;
      let dirty = 0;
      for (const c of world.chunks.values()) if (c.dirty && c.meshed) dirty++;
      stats.chunksDirty = dirty;
    } else {
      stats.chunksLoaded = 0;
      stats.chunksDirty = 0;
    }
    const rs = renderer.getStats();
    stats.chunkMeshes = rs.chunkMeshes;
    stats.meshesVisible = rs.chunkMeshes;
    stats.triangles = rs.triangles;
    stats.drawCalls = rs.drawCalls;
    stats.geometries = rs.geometries;
    if (player) updateDebugHandle(win, stats);
  }

  function frame(ts) {
    if (disposed) return;
    rafId = win.requestAnimationFrame(frame); // schedule first so an exception cannot stop the loop
    const t = Number.isFinite(ts) ? ts : now();
    const rawDt = Number.isFinite(lastTs) ? Math.max(0, (t - lastTs) / 1000) : 0;
    lastTs = t;
    stepFrame(rawDt);
  }

  /**
   * One simulation + render step of `rawDt` seconds (clamped to MAX_FRAME_DT). Called by the rAF loop
   * and, via `game.stepFrame`, by the smoke test when rAF is starved (headless Chrome under a
   * virtual-time budget only delivers a handful of animation frames while timers race ahead).
   * @param {number} rawDt
   */
  function stepFrame(rawDt) {
    if (disposed) return;
    const dt = Math.min(Math.max(0, Number.isFinite(rawDt) ? rawDt : 0), MAX_FRAME_DT);

    // §9.5 top of the frame: a queued mode switch (never applied inside a command, a hook or a step). The upgrade of a
    // generation-1 world replaces the world, so that frame ends here.
    if (pendingModeSwitch && MODE_SWITCH_STATES.has(state) && applyModeSwitch()) {
      refreshStats(rawDt);
      return;
    }

    switch (state) {
      case STATE.LOADING:
        stepLoading();
        break;
      case STATE.PLAYING:
      case STATE.PACK: // §9.5: the world keeps running under the pack screen …
      case STATE.BOOK: // … and the field book (§14.1)
        stepPlaying(dt);
        break;
      case STATE.DEVICE: // v0.10 (§57): the device panel runs the world in Survival only
        if (survival.inSurvival) stepPlaying(dt);
        break;
      default:
        break; // title / clickToPlay / paused / picker / console / editor / dead: frozen simulation
    }
    if (state === STATE.PACK) refreshPackScreen();
    if (player) renderFrame(dt);
    refreshStats(rawDt);
  }

  // ---- window events --------------------------------------------------------------------------------

  const onResize = () => renderer.resize(win.innerWidth, win.innerHeight);
  const onPageHide = () => saveOnLeave();
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') saveOnLeave();
  };
  // §14.4: while a Handbook reader is open, keydowns go to it first (Esc, arrows, PgUp / PgDn), before the menus and controls.
  const onBookKeyDown = (/** @type {KeyboardEvent} */ e) => {
    if (!handbookUI.isOpen()) return;
    if (handbookUI.handleKey(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  win.addEventListener('resize', onResize);
  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('beforeunload', onPageHide);
  doc.addEventListener('visibilitychange', onVisibility);
  doc.addEventListener('keydown', onBookKeyDown, true);

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (rafId) win.cancelAnimationFrame(rafId);
    win.removeEventListener('resize', onResize);
    win.removeEventListener('pagehide', onPageHide);
    win.removeEventListener('beforeunload', onPageHide);
    doc.removeEventListener('visibilitychange', onVisibility);
    doc.removeEventListener('keydown', onBookKeyDown, true);
    canvas.removeEventListener('mousedown', onCanvasMouseDown);
    uninstallErrors();
    if (runner) runner.reset();
    runner = null;
    runeStore.clear();
    clearCircuits();
    clearSurvival();
    packUI.dispose();
    devicePanel.dispose();
    droneLoop.stop();
    quietWorldSounds(); // v0.16 (§82)
    soundTest.dispose();
    if (world) world.dispose();
    world = null;
    blockPhysics = null;
    player = null;
    fallingRenderer.dispose();
    particles.dispose();
    vortexRenderer.dispose();
    circuitRenderer.dispose();
    zombieRenderer.dispose();
    zombies.clear();
    watcherRenderer.dispose();
    watcher.clear();
    controls.dispose();
    hud.dispose();
    menus.dispose();
    consoleUI.dispose();
    runeEditor.dispose();
    renderer.dispose();
  }

  // ---- go -------------------------------------------------------------------------------------------

  onResize();
  hud.setHotbar(hotbar, selected);
  if (params.debug) hud.setDebugVisible(true);

  if (autoplay) {
    // Skip the title and play slot ?slot (default 1): ?seed wins, then the slot's seed (whose edits we restore), then a
    // random seed. Under ?nosave nothing is loaded or written.
    const save = params.nosave ? null : loadSlot(currentSlot);
    if (!params.nosave && !save && listSlots()[currentSlot - 1].status === 'damaged') {
      // Never overwrite a damaged save from a URL: the player decides on the Worlds screen.
      params.nosave = true;
      autoNoSave = true;
      console.warn(`Caelancraft: ?autoplay on the damaged slot ${currentSlot} — saving disabled for this session.`);
    }
    let restoring = null;
    let seed;
    if (params.seed != null) {
      seed = normalizeSeed(params.seed);
      if (save && save.seed === seed) {
        restoring = save;
      } else if (save && !params.nosave) {
        // A debugging URL must never clobber the player's saved world: run this seed without saving.
        params.nosave = true;
        autoNoSave = true;
        console.warn('Caelancraft: ?autoplay with a different ?seed than the saved world — saving disabled for this session.');
      }
    } else if (save) {
      seed = save.seed;
      restoring = save;
    } else {
      seed = seedFromInput('');
    }
    if (restoring) {
      worldName = restoring.meta.name;
      worldCreatedAt = restoring.meta.createdAt;
    } else {
      worldCreatedAt = Date.now();
    }
    // §1.1 ?mode: applies to this first world only (finishLoading uses it up). It never raises a saved world's generation
    // unless nothing is being saved; an older saved world loads as it is.
    const plan = modeParamPlan(params.mode, { save: restoring, nosave: params.nosave });
    if (plan.warning) console.warn(`Caelancraft: ${plan.warning}`);
    if (!plan.apply) params.mode = null;
    else if (plan.raiseGen && restoring) restoring = { ...restoring, gen: GEN_LATEST };
    startLoading(seed, restoring);
  } else {
    params.mode = null; // ?mode works only with ?autoplay or ?smoke
    showTitle();
  }
  if (params.soundTest) soundTest.open(); // v0.16 (§82): ?ui=sounds

  rafId = win.requestAnimationFrame(frame);
  console.log(`Caelancraft v${VERSION}`);
  return game;
}

// Browser entry point. Under Node (tests, import checks) neither global exists and nothing runs.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  boot(window, document);
}
