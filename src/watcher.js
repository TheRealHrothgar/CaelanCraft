// Caelancraft — the Hollow Watcher: a rare, silent figure at the edge of the fog. See src/CONTRACTS.md §40. Pure (no DOM,
// no three).
//
// The Watcher is Caelancraft's own legend: a floating stack of hollow hex rings of ash-grey stone with glowing cyan
// cracks, a hex lantern for a head with two small cyan lights that shine through fog and darkness, and a wisp of smoke
// where legs would be (watcherRenderer.js). It is not a creature that lives in the world — it is a SIGHTING. At most one exists,
// only at night (or deep underground, where the sky cannot be seen), at most once per in-game night, and roughly one
// night in three. It appears standing still and facing the player far away, at 0.75–0.95 of the fog distance, on solid
// ground in a loaded chunk, never closer than WATCHER_MIN_DIST — and only where the player can see it: on screen
// (inside the camera's view, toward its edge: something at the corner of the eye) with line of sight. When there is no
// such place the night's roll waits for a later check instead of being spent on a sighting nobody could see.
//
// It never moves, never attacks and never touches a block while it is there: it only turns its head, slowly, to keep
// watching. It is gone in a puff of dark smoke the moment the player looks straight at it (its centre within
// WATCHER_GAZE_CONE of the view direction, with line of sight) for WATCHER_GAZE_S, comes within WATCHER_NEAR_VANISH of
// it, or has not had it on screen for WATCHER_UNSEEN_S — never on the frame it appears. Sometimes it leaves one trace
// where it stood: a lone obsidian pillar, a dead campfire ring, or the nearest natural tree torn out by the roots. A
// trace is a plain list of block writes main applies with World.setBlock (ordinary world edits — saved like any other,
// not a block-physics event); planTrace only proposes writes that cannot bring anything else down, and only ever
// changes untouched natural terrain and natural trees: never a cell the player edited, never one resting on such a cell.
//
// Nothing about the figure is saved; the world keeps only the per-world switch (`enabled`) and the night of the last
// natural sighting (`lastNight`, so a reload cannot bring a second one that night).
import { WORLD_HEIGHT, NIGHT_SECONDS, FOV, TREE_MAX_CELLS, SUNSET_TIME } from './config.js';
import { HEX_DIRS, hexToWorld, worldToHex } from './hex.js';
import { BLOCK, isSolid, isOpaque, isLeaves, isLog, isLiquid } from './blocks.js';
import { raycastHex } from './raycast.js';
import { playerIntersectsBlock } from './physics.js';
import { isDayTime } from './daynight.js';
import { isLoadBearing } from './support.js';

/** @typedef {import('./types.js').GetBlockFn} GetBlockFn */
/** @typedef {import('./types.js').PlayerState} PlayerState */

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

// ---- tunables (the Watcher's own; nothing else reads them) ------------------------------------------------------
/** The figure's height (m): the smoke wisp, the stack of rings, the lantern. Standing needs three AIR cells. */
export const WATCHER_HEIGHT = 2.6;
/** Its eyes, above its feet (m): the renderer puts them here; the gaze and line-of-sight tests aim at them too. */
export const WATCHER_EYE_Y = 2.38;
/** Its centre above its feet (m): what "looking straight at it" measures. */
export const WATCHER_CENTRE_Y = WATCHER_HEIGHT / 2;
/** Never appears closer to the player than this (3D, m). */
export const WATCHER_MIN_DIST = 30;
/** It appears between these fractions of the fog distance (the renderer's fog far). */
export const WATCHER_FOG_MIN = 0.75;
export const WATCHER_FOG_MAX = 0.95;
/** The player within this (3D, feet to feet) → it vanishes. */
export const WATCHER_NEAR_VANISH = 20;
/** Looking straight at it: its centre within this angle of the view direction, with line of sight … */
export const WATCHER_GAZE_CONE = 6 * DEG;
/** … for this long (s, continuously) → it vanishes. */
export const WATCHER_GAZE_S = 0.4;
/**
 * A sighting starts with the whole figure (feet to the top of its head) inside the view shrunk by this fraction of the
 * half-width and half-height — on screen, never cut by its edge. ("On screen" while it is there: its eyes or centre
 * inside the view itself.)
 */
export const WATCHER_VIEW_MARGIN = 0.1;
/** The view when WatcherWorld does not say: config FOV (70°, vertical) in a 16:9 window. */
export const WATCHER_DEFAULT_ASPECT = 16 / 9;
/** Not on screen for this long (s) → it vanishes. */
export const WATCHER_UNSEEN_S = 30;
/** A natural appearance is rolled this often (s) while one may happen. */
export const WATCHER_CHECK_S = 5;
/** Chance that a whole night (NIGHT_SECONDS, 10 real minutes since v0.11) brings a sighting. */
export const WATCHER_NIGHT_CHANCE = 1 / 3;
/** Per-check chance: 1 − (1 − NIGHT_CHANCE)^(CHECK_S / night length), so a night of checks adds up to NIGHT_CHANCE. */
export const WATCHER_CHECK_CHANCE = 1 - Math.pow(1 - WATCHER_NIGHT_CHANCE, WATCHER_CHECK_S / NIGHT_SECONDS);
/** Columns tried per placement. */
export const WATCHER_PLACE_TRIES = 24;
/**
 * Natural appearances are aimed this far out from the middle of the screen (fractions of its half-width, at the
 * horizon) — toward the edge of the view, the corner of the eye: ~26°–47° aside in a 16:9 window at FOV 70°.
 */
export const WATCHER_EDGE_MIN = 0.4;
export const WATCHER_EDGE_MAX = 0.85;
/** `summon watcher`: this far either side on screen (rad, at the horizon) — plainly in view, never dead centre. */
export const WATCHER_SUMMON_SIDE_MIN = 8 * DEG;
export const WATCHER_SUMMON_SIDE_MAX = 25 * DEG;
/** Deep underground: the player's eye at least this far below the generated surface of its column, and no sky above. */
export const WATCHER_CAVE_DEPTH = 8;
/** A cave appearance stands within this many cells (up or down) of the player's feet level. */
export const WATCHER_CAVE_SPAN = 8;
/** The head turns toward the player at this rate (rad/s) … */
export const WATCHER_HEAD_TURN_RATE = 0.6;
/** … at most this far from where the body faces (rad), and tilts up or down at most this much (rad). */
export const WATCHER_HEAD_MAX_TURN = 1.3;
export const WATCHER_HEAD_MAX_PITCH = 0.35;
/** A faint wisp of dark smoke every MIN … MAX seconds. */
export const WATCHER_WISP_MIN_S = 1.2;
export const WATCHER_WISP_MAX_S = 3.6;
/** Chance that a vanishing leaves a trace. */
export const WATCHER_TRACE_CHANCE = 0.35;
/** Traces are looked for in the cell it stood in and up to this many rings around it … */
export const WATCHER_TRACE_NEAR = 3;
/** … the uprooted tree is the nearest natural one within this (horizontal, m) … */
export const WATCHER_TREE_RANGE = 8;
/** … and no trace writes within this (horizontal, m) of the world's spawn point. */
export const WATCHER_SPAWN_CLEAR = 16;
/** Obsidian pillar heights (cells). */
export const WATCHER_PILLAR_MIN = 4;
export const WATCHER_PILLAR_MAX = 6;
/** An uprootable tree has a trunk of MIN … MAX logs in one column (worldgen grows 4–6). */
export const WATCHER_TRUNK_MIN = 3;
export const WATCHER_TRUNK_MAX = 8;
/** Its leaves: within this hex distance of the trunk, from the top log − 1 to the top log + 3. */
export const WATCHER_LEAF_RADIUS = 2;

/** The three traces, in the order a tie would pick them. */
export const TRACE_KINDS = Object.freeze(/** @type {const} */ (['pillar', 'deadfire', 'uprooted']));

/**
 * @typedef {Object} WatcherFigure
 * @property {number} x       feet, world (the centre of its cell)
 * @property {number} y
 * @property {number} z
 * @property {number} q       its cell
 * @property {number} r
 * @property {number} yaw     where the body faces (toward the player when it appeared; it never turns)
 * @property {number} headYaw   where the head faces (world yaw; turns slowly toward the player)
 * @property {number} headPitch head tilt (+ looks up)
 * @property {'night'|'cave'|'summon'} kind
 * @property {boolean} los    the player had line of sight to it when it appeared
 * @property {number} age     seconds since it appeared (updates after the one it appeared in)
 * @property {number} gaze    seconds the player has been looking straight at it
 * @property {number} unseen  seconds since it was last on screen
 * @property {boolean} seen   on screen with line of sight in the last update
 * @property {number} wispIn  seconds to the next smoke wisp
 */

/**
 * @typedef {Object} WatcherTrace
 * @property {'pillar'|'deadfire'|'uprooted'} kind
 * @property {[number, number, number]} at          the trace's anchor cell (pillar base / fire centre floor / tree root)
 * @property {[number, number, number, number][]} writes   [q, y, r, id] in the order main must apply them
 */

/**
 * @typedef {Object} WatcherVanish
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {'gaze'|'near'|'unseen'|'dawn'|'unloaded'} reason
 * @property {WatcherTrace|null} trace
 */

/**
 * @typedef {Object} WatcherEvents  what one update did (the object is reused)
 * @property {WatcherFigure|null} appeared
 * @property {WatcherVanish|null} vanished
 * @property {boolean} wisp       a faint smoke wisp is due at the figure
 */

/**
 * @typedef {Object} WatcherWorld
 * @property {GetBlockFn} getBlock
 * @property {(q: number, r: number) => boolean} isLoadedCell
 * @property {(q: number, r: number) => number} groundHeight          generated terrain height (top solid cell), −1 unloaded
 * @property {(q: number, y: number, r: number) => boolean} isNaturalGround   untouched terrain (World.isNaturalGround)
 * @property {(q: number, y: number, r: number) => boolean} hasEdit          the cell has a recorded edit (World.hasEdit);
 *   without it no trace is made (nothing can be shown to be untouched)
 * @property {(q: number, y: number, r: number) => boolean} [occupied]       a creature's body is in the cell (traces avoid it)
 * @property {PlayerState|null} player
 * @property {[number, number, number]} eye     the camera position
 * @property {[number, number, number]} look    unit view direction
 * @property {number} yaw                       the view yaw (placement directions are measured from it)
 * @property {number} [fov]                     the vertical FOV a sighting must START inside (degrees; config FOV when
 *                                              absent): main passes min(camera fov, FOV), so the sprint's wider view ends
 *                                              with the spot still on screen
 * @property {number} [viewFov]                 the camera's real vertical FOV now (degrees; `fov` when absent): what is on
 *                                              screen while it is there (seen / unseen, §40.2)
 * @property {number} [aspect]                  the camera's width / height (WATCHER_DEFAULT_ASPECT when absent)
 * @property {number} time                      day fraction (daynight)
 * @property {number} day                       main's day counter (bumped at midnight)
 * @property {number} fogFar                    the renderer's normal fog far (m)
 * @property {[number, number]|null} [spawn]    world spawn (x, z): no trace writes within WATCHER_SPAWN_CLEAR of it
 */

/** Yaw that faces from (x, z) toward (tx, tz): yawToForward(yaw) = (−sin, −cos). */
function yawToward(x, z, tx, tz) {
  return Math.atan2(-(tx - x), -(tz - z));
}

/** Wrap an angle into (−π, π]. */
function wrapAngle(a) {
  const w = a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
  return w === -Math.PI ? Math.PI : w;
}

/** Move `from` toward `to` by at most `step`. */
function approach(from, to, step) {
  const d = to - from;
  return Math.abs(d) <= step ? to : from + Math.sign(d) * step;
}

/**
 * The in-game night a moment belongs to: dusk of day N up to dusk of day N + 1 (the night and the day after it) is
 * night N. main's `day` is bumped at midnight, so t ≥ SUNSET_TIME (19:30 since v0.11) → `day`, earlier → `day − 1`.
 * @param {number} time  day fraction
 * @param {number} day
 * @returns {number}
 */
export function nightKey(time, day) {
  const t = time - Math.floor(time);
  return t >= SUNSET_TIME ? day : day - 1;
}

/** Sight is blocked by opaque cells and by leaves (glass, water and air let it through). */
export function blocksSight(id) {
  return isOpaque(id) || isLeaves(id);
}

/**
 * No opaque cell (or leaves) between (ex, ey, ez) and (tx, ty, tz). The last 0.35 m before the target is not looked at
 * (the target point is inside the figure's own, empty cell).
 * @param {GetBlockFn} getBlock
 * @returns {boolean}
 */
export function lineOfSight(getBlock, ex, ey, ez, tx, ty, tz) {
  const dx = tx - ex;
  const dy = ty - ey;
  const dz = tz - ez;
  const d = Math.hypot(dx, dy, dz);
  if (!(d > 0.35)) return true;
  return raycastHex(getBlock, ex, ey, ez, dx / d, dy / d, dz / d, d - 0.35, blocksSight) === null;
}

/**
 * The view's half-extents as tangents: [tan(half the horizontal FOV), tan(half the vertical FOV)], from `world.fov`
 * (vertical, degrees) and `world.aspect`, with config FOV and WATCHER_DEFAULT_ASPECT standing in for missing or unusable
 * values; `fovDeg` overrides `world.fov` (the seen test uses the camera's real `viewFov`). @param {WatcherWorld} world
 * @param {number} [fovDeg] @returns {[number, number]}
 */
export function viewTangents(world, fovDeg = world.fov) {
  const fov = fovDeg > 0 && fovDeg < 180 ? fovDeg : FOV;
  const aspect = world.aspect > 0 && Number.isFinite(world.aspect) ? world.aspect : WATCHER_DEFAULT_ASPECT;
  const tanV = Math.tan((fov * DEG) / 2);
  return [tanV * aspect, tanV];
}

/**
 * Where world point (x, y, z) is on screen, as the camera at `world.eye` looking along `world.look` (no roll — main's
 * camera is rotated (pitch, yaw, 0) in order 'YXZ') draws it: `out` = [sx, sy], its offsets from the middle of the
 * screen as fractions of the half-width and half-height (+x right, +y up; |s| ≤ 1 on screen). False (out untouched)
 * when the point is not in front of the eye. @param {WatcherWorld} world @param {number[]} out @returns {boolean}
 */
export function screenPos(world, x, y, z, out, fovDeg = world.fov) {
  const e = world.eye;
  const f = world.look;
  const dx = x - e[0];
  const dy = y - e[1];
  const dz = z - e[2];
  const depth = dx * f[0] + dy * f[1] + dz * f[2];
  if (!(depth > 1e-6)) return false;
  // right = look × world up, flattened; straight up or down the view yaw gives it.
  const h = Math.hypot(f[0], f[2]);
  const rx = h > 1e-9 ? -f[2] / h : Math.cos(world.yaw);
  const rz = h > 1e-9 ? f[0] / h : -Math.sin(world.yaw);
  // up = right × look
  const ux = -rz * f[1];
  const uy = rz * f[0] - rx * f[2];
  const uz = rx * f[1];
  const [tanH, tanV] = viewTangents(world, fovDeg);
  out[0] = (dx * rx + dz * rz) / (depth * tanH);
  out[1] = (dx * ux + dy * uy + dz * uz) / (depth * tanV);
  return true;
}

const scratchScreen = [0, 0];

/**
 * World point (x, y, z) is on screen, inside the view shrunk by `margin` (a fraction of its half-width and
 * half-height), for a camera of vertical FOV `fovDeg` (default `world.fov`). @param {WatcherWorld} world @returns {boolean}
 */
export function inView(world, x, y, z, margin = 0, fovDeg = world.fov) {
  if (!screenPos(world, x, y, z, scratchScreen, fovDeg)) return false;
  const lim = 1 - margin;
  return Math.abs(scratchScreen[0]) <= lim && Math.abs(scratchScreen[1]) <= lim;
}

/** A solid cell somewhere above y0 in column (q, r) (the sky is hidden). */
function roofAbove(getBlock, q, y0, r) {
  for (let y = Math.max(0, y0); y < WORLD_HEIGHT; y++) if (isSolid(getBlock(q, y, r))) return true;
  return false;
}

/**
 * Deep underground: the player's eye is at least WATCHER_CAVE_DEPTH below the generated surface of its column and
 * a solid cell hides the sky above it.
 * @param {WatcherWorld} world
 * @returns {boolean}
 */
export function isDeepUnderground(world) {
  const p = world.player;
  if (!p || !world.eye) return false;
  const [q, r] = worldToHex(p.x, p.z);
  const h = world.groundHeight(q, r);
  if (!(h >= 0)) return false;
  const eyeY = world.eye[1];
  if (eyeY > h + 1 - WATCHER_CAVE_DEPTH) return false;
  return roofAbove(world.getBlock, q, Math.floor(eyeY) + 1, r);
}

/** A cell the figure can stand on: solid, not leaves, not liquid. */
function standable(id) {
  return isSolid(id) && !isLeaves(id) && !isLiquid(id);
}

/** Three AIR cells from y up (room for WATCHER_HEIGHT). */
function roomAt(getBlock, q, y, r) {
  return y + 3 <= WORLD_HEIGHT && getBlock(q, y, r) === BLOCK.AIR && getBlock(q, y + 1, r) === BLOCK.AIR && getBlock(q, y + 2, r) === BLOCK.AIR;
}

/**
 * Feet height of a surface spot in column (q, r): the highest standable cell from 8 above the generated surface down
 * to 6 below it with three AIR cells on it. @returns {number|null}
 */
export function surfaceFeetY(world, q, r) {
  const h = world.groundHeight(q, r);
  if (!(h >= 0)) return null;
  const getBlock = world.getBlock;
  for (let y = Math.min(h + 8, WORLD_HEIGHT - 4); y >= Math.max(0, h - 6); y--) {
    if (standable(getBlock(q, y, r))) return roomAt(getBlock, q, y + 1, r) ? y + 1 : null;
  }
  return null;
}

/**
 * Feet height of a cave spot in column (q, r) near the player's feet level `fy`: the nearest level (fy, fy + 1, fy − 1,
 * fy + 2, …, within WATCHER_CAVE_SPAN) with a standable floor and three AIR cells on it. @returns {number|null}
 */
export function caveFeetY(world, q, r, fy) {
  const getBlock = world.getBlock;
  for (let k = 0; k <= 2 * WATCHER_CAVE_SPAN; k++) {
    const y = fy + (k % 2 === 0 ? -(k / 2) : (k + 1) / 2);
    if (y < 1 || y + 3 > WORLD_HEIGHT) continue;
    if (standable(getBlock(q, y - 1, r)) && roomAt(getBlock, q, y, r)) return y;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------------------------------------------

/**
 * The cell has a recorded edit: the player (or something the player set off) changed it, so it is theirs — a placed
 * block, a dug-out hole, a Rune Block. Traces never write such a cell or rest on one. Without `hasEdit` nothing can be
 * shown to be untouched, so every cell counts as edited (no trace at all).
 * @param {WatcherWorld} world
 */
function edited(world, q, y, r) {
  return world.hasEdit ? world.hasEdit(q, y, r) : true;
}

/** Untouched air: AIR that no edit made (not a hole the player dug). */
function untouchedAir(world, q, y, r) {
  return world.getBlock(q, y, r) === BLOCK.AIR && !edited(world, q, y, r);
}

/** Untouched natural ground (World.isNaturalGround already excludes edited cells; this also holds for any WatcherWorld). */
function naturalGround(world, q, y, r) {
  return world.isNaturalGround(q, y, r) && !edited(world, q, y, r);
}

/**
 * A trace may write cell (q, y, r): in height range, loaded, no edit (never anything the player made or dug), not within
 * WATCHER_SPAWN_CLEAR of the spawn point, not in the player's body and not in a creature's.
 * @param {WatcherWorld} world
 */
export function traceWritable(world, q, y, r) {
  if (!(y >= 0 && y < WORLD_HEIGHT) || !world.isLoadedCell(q, r) || edited(world, q, y, r)) return false;
  if (world.spawn) {
    const [x, z] = hexToWorld(q, r);
    if (Math.hypot(x - world.spawn[0], z - world.spawn[1]) < WATCHER_SPAWN_CLEAR) return false;
  }
  if (world.player && playerIntersectsBlock(world.player, q, y, r)) return false;
  if (world.occupied && world.occupied(q, y, r)) return false;
  return true;
}

/** A liquid in one of the 8 neighbours (6 sides, above, below): writing here would move water. */
function wetAround(getBlock, q, y, r) {
  if (isLiquid(getBlock(q, y + 1, r)) || isLiquid(getBlock(q, y - 1, r))) return true;
  for (let j = 0; j < 6; j++) if (isLiquid(getBlock(q + HEX_DIRS[j][0], y, r + HEX_DIRS[j][1]))) return true;
  return false;
}

/**
 * The columns a pillar or a dead campfire may use, nearest first: the figure's own cell, then the rings around it up to
 * WATCHER_TRACE_NEAR (each ring starting at a random corner). Each with the height of its natural ground near the
 * figure's feet: the highest natural-ground cell from fy + 1 down to fy − 4, kept only with untouched AIR on it — the
 * floor of a hole or shaft the player dug (edited AIR) is not open ground.
 * @returns {[number, number, number][]} [q, groundY, r]
 */
function traceColumns(world, x, y, z, rng) {
  const [fq, fr] = worldToHex(x, z);
  const fy = Math.floor(y + 0.01);
  /** @type {[number, number, number][]} */
  const out = [];
  const consider = (q, r) => {
    if (!world.isLoadedCell(q, r)) return;
    for (let g = Math.min(fy + 1, WORLD_HEIGHT - 2); g >= Math.max(0, fy - 4); g--) {
      if (!naturalGround(world, q, g, r)) continue;
      if (untouchedAir(world, q, g + 1, r)) out.push([q, g, r]);
      return;
    }
  };
  consider(fq, fr);
  for (let ring = 1; ring <= WATCHER_TRACE_NEAR; ring++) {
    // Walk the ring (6·ring cells) from a random start.
    /** @type {[number, number][]} */
    const cells = [];
    let q = fq + HEX_DIRS[4][0] * ring;
    let r = fr + HEX_DIRS[4][1] * ring;
    for (let j = 0; j < 6; j++) {
      for (let k = 0; k < ring; k++) {
        cells.push([q, r]);
        q += HEX_DIRS[j][0];
        r += HEX_DIRS[j][1];
      }
    }
    const start = Math.floor(rng() * cells.length);
    for (let i = 0; i < cells.length; i++) {
      const [cq, cr] = cells[(start + i) % cells.length];
      consider(cq, cr);
    }
  }
  return out;
}

/**
 * A lone obsidian pillar WATCHER_PILLAR_MIN … MAX tall on natural ground where it stood (or nearby). Every cell it fills
 * is untouched AIR (never a shaft the player dug), writable and dry; nothing is removed, so nothing can fall.
 * @returns {WatcherTrace|null}
 */
export function planPillar(world, x, y, z, rng) {
  const getBlock = world.getBlock;
  const height = WATCHER_PILLAR_MIN + Math.floor(rng() * (WATCHER_PILLAR_MAX - WATCHER_PILLAR_MIN + 1));
  for (const [q, g, r] of traceColumns(world, x, y, z, rng)) {
    if (g + height >= WORLD_HEIGHT) continue;
    let ok = true;
    for (let i = 1; i <= height && ok; i++) {
      const cy = g + i;
      ok = getBlock(q, cy, r) === BLOCK.AIR && traceWritable(world, q, cy, r) && !wetAround(getBlock, q, cy, r);
    }
    if (!ok) continue;
    /** @type {[number, number, number, number][]} */
    const writes = [];
    for (let i = 1; i <= height; i++) writes.push([q, g + i, r, BLOCK.OBSIDIAN]);
    return { kind: 'pillar', at: [q, g + 1, r], writes };
  }
  return null;
}

/**
 * A dead campfire: six COBBLESTONE cells on flat natural ground around an empty centre cell whose floor turns to GRAVEL
 * (cold ash), not a lit CAMPFIRE. The ring only fills untouched AIR; the gravel replaces a natural ground cell that rests
 * on an unedited solid one (never on a player's block), so nothing falls or loses support. Every AIR cell it needs (two
 * over the centre and over each ring cell) is untouched too: never in a pit the player dug. @returns {WatcherTrace|null}
 */
export function planDeadFire(world, x, y, z, rng) {
  const getBlock = world.getBlock;
  for (const [q, g, r] of traceColumns(world, x, y, z, rng)) {
    if (g < 1 || g + 3 > WORLD_HEIGHT) continue;
    if (!untouchedAir(world, q, g + 2, r) || !standable(getBlock(q, g - 1, r)) || edited(world, q, g - 1, r)) continue;
    if (!traceWritable(world, q, g, r) || wetAround(getBlock, q, g, r)) continue;
    let ok = true;
    for (let j = 0; j < 6 && ok; j++) {
      const nq = q + HEX_DIRS[j][0];
      const nr = r + HEX_DIRS[j][1];
      ok = world.isLoadedCell(nq, nr) && naturalGround(world, nq, g, nr) &&
        untouchedAir(world, nq, g + 1, nr) && untouchedAir(world, nq, g + 2, nr) && traceWritable(world, nq, g + 1, nr) &&
        !wetAround(getBlock, nq, g + 1, nr);
    }
    if (!ok) continue;
    /** @type {[number, number, number, number][]} */
    const writes = [];
    for (let j = 0; j < 6; j++) writes.push([q + HEX_DIRS[j][0], g + 1, r + HEX_DIRS[j][1], BLOCK.COBBLESTONE]);
    writes.push([q, g, r, BLOCK.GRAVEL]);
    return { kind: 'deadfire', at: [q, g, r], writes };
  }
  return null;
}

/** A log cell (any y within ±3 of `ly`) in a column within hex distance `dMax` of (lq, lr), other than column (tq, tr). */
function foreignLogNear(world, lq, ly, lr, dMax, tq, tr) {
  const getBlock = world.getBlock;
  for (let dq = -dMax; dq <= dMax; dq++) {
    for (let dr = -dMax; dr <= dMax; dr++) {
      if (Math.abs(dq + dr) > dMax) continue;
      const q = lq + dq;
      const r = lr + dr;
      if (q === tq && r === tr) continue;
      // Only another NATURAL tree's log keeps a leaf: a log the player placed (or one felled onto the canopy) holds nothing
      // up — keeping the leaf for it would leave it to decay once this trunk is gone (play-test review, §40.3).
      for (let y = ly - 3; y <= ly + 3; y++) if (isLog(getBlock(q, y, r)) && !edited(world, q, y, r)) return true;
    }
  }
  return false;
}

/** The 6 sides, then above and below (trees.js NEIGHBOURS: the leaf-decay flood). */
const DECAY_NEIGHBOURS = Object.freeze([...HEX_DIRS.map(([dq, dr]) => [dq, 0, dr]), [0, 1, 0], [0, -1, 0]]);

/**
 * After an uprooting (`removed`: "q,y,r" keys of every cell it turns to AIR), block physics runs the hanging-leaves test
 * on the removed LOGS (trees.decayHangingLeaves, naturalOnly — CONTRACTS §36.6.1): every cluster of leaves next to them,
 * connected through leaves (≤ TREE_MAX_CELLS), that touches no load-bearing cell — one resting on leaves holds nothing
 * (G6) — and no unloaded cell, decays (its natural leaves). Mirror that on the world as the trace leaves it and report
 * whether every leaf that would decay has nothing but AIR or leaves on it: a player's block, or anything else, resting
 * on a leaf that decays would come down. @returns {boolean}
 */
function keptLeavesStay(world, removed, logs) {
  const getBlock = world.getBlock;
  const after = (q, y, r) => (removed.has(`${q},${y},${r}`) ? BLOCK.AIR : getBlock(q, y, r));
  const holds = (q, y, r) => {
    if (!world.isLoadedCell(q, r)) return true;
    const id = after(q, y, r);
    return isLoadBearing(id) && !(y > 0 && isLeaves(after(q, y - 1, r)));
  };
  /** @type {Set<string>} leaves already judged */
  const judged = new Set();
  for (const [lq, ly, lr] of logs) {
    for (const [dq, dy, dr] of DECAY_NEIGHBOURS) {
      const sq = lq + dq;
      const sy = ly + dy;
      const sr = lr + dr;
      const sk = `${sq},${sy},${sr}`;
      if (!(sy >= 0 && sy < WORLD_HEIGHT) || judged.has(sk) || !world.isLoadedCell(sq, sr) || !isLeaves(after(sq, sy, sr))) continue;
      /** @type {number[][]} */
      const cluster = [[sq, sy, sr]];
      const seen = new Set([sk]);
      let held = false;
      for (let i = 0; i < cluster.length && !held; i++) {
        const [q, y, r] = cluster[i];
        for (const [eq, ey, er] of DECAY_NEIGHBOURS) {
          const nq = q + eq;
          const ny = y + ey;
          const nr = r + er;
          const nk = `${nq},${ny},${nr}`;
          if (!(ny >= 0 && ny < WORLD_HEIGHT) || seen.has(nk)) continue;
          if (holds(nq, ny, nr)) {
            held = true;
            break;
          }
          if (!isLeaves(after(nq, ny, nr))) continue;
          if (cluster.length >= TREE_MAX_CELLS) {
            held = true;
            break;
          }
          seen.add(nk);
          cluster.push([nq, ny, nr]);
        }
      }
      for (const k of seen) judged.add(k);
      if (held) continue;
      for (const [q, y, r] of cluster) {
        if (edited(world, q, y, r)) continue; // a player's leaf never decays (naturalOnly)
        const above = after(q, y + 1, r);
        if (above !== BLOCK.AIR && !isLeaves(above)) return false;
      }
    }
  }
  return true;
}

/**
 * The natural tree whose trunk stands in column (q, r) on natural ground at h, torn out by the roots: its leaves (top
 * down), its logs (top down) and the root cell (the ground it stood in) become AIR and the cell under the root DIRT —
 * a hole where it was. Null unless it is a worldgen-like tree that can go without touching anything the player made: a
 * single column of WATCHER_TRUNK_MIN … MAX unedited logs crowned by leaves; no solid cell against the trunk or the root
 * but natural ground or leaves (no build hangs on it, no other trunk touches it); the root and the cell under it untouched
 * natural ground (a player's block under the root — a Rune Block, a tunnel's ceiling — keeps the whole tree: neither
 * hole nor dirt is made over it); no liquid next to any cell it writes; nothing the player placed resting on a cell it
 * takes away; and every cell writable. Leaves are its own: unedited, within WATCHER_LEAF_RADIUS of the trunk, and not as
 * near another tree's log column (those stay with that tree). @returns {WatcherTrace|null}
 */
export function planUprootAt(world, q, h, r) {
  const getBlock = world.getBlock;
  const base = h + 1;
  if (h < 1 || !naturalGround(world, q, h, r)) return null;
  if (!isLog(getBlock(q, base, r)) || edited(world, q, base, r)) return null;
  let top = base;
  while (top + 1 < WORLD_HEIGHT && isLog(getBlock(q, top + 1, r)) && !edited(world, q, top + 1, r)) top++;
  const trunk = top - base + 1;
  if (trunk < WATCHER_TRUNK_MIN || trunk > WATCHER_TRUNK_MAX || !isLeaves(getBlock(q, top + 1, r))) return null;
  // The root and the trunk: nothing but natural ground, leaves or non-solid cells against them, and dry.
  for (let y = h; y <= top; y++) {
    if (!traceWritable(world, q, y, r)) return null;
    for (let j = 0; j < 6; j++) {
      const nq = q + HEX_DIRS[j][0];
      const nr = r + HEX_DIRS[j][1];
      const id = getBlock(nq, y, nr);
      if (isLiquid(id)) return null;
      if (isSolid(id) && !isLeaves(id) && !naturalGround(world, nq, y, nr)) return null;
    }
  }
  // The cell under the root becomes dirt: it must be untouched natural ground too (never a player's block).
  const under = getBlock(q, h - 1, r);
  if (!standable(under) || !naturalGround(world, q, h - 1, r) || !traceWritable(world, q, h - 1, r)) return null;
  if (wetAround(getBlock, q, h, r)) return null;
  // Its leaves.
  /** @type {[number, number, number][]} */
  const leaves = [];
  const R = WATCHER_LEAF_RADIUS;
  for (let dq = -R; dq <= R; dq++) {
    for (let dr = -R; dr <= R; dr++) {
      const d = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
      if (d > R) continue;
      const lq = q + dq;
      const lr = r + dr;
      if (!world.isLoadedCell(lq, lr)) return null; // part of its canopy is out of reach: leave it standing
      for (let ly = top - 1; ly <= Math.min(top + 3, WORLD_HEIGHT - 1); ly++) {
        if (!isLeaves(getBlock(lq, ly, lr)) || edited(world, lq, ly, lr)) continue;
        if (d > 0 && foreignLogNear(world, lq, ly, lr, d, q, r)) continue;
        if (!traceWritable(world, lq, ly, lr) || wetAround(getBlock, lq, ly, lr)) return null;
        leaves.push([lq, ly, lr]);
      }
    }
  }
  leaves.sort((a, b) => b[1] - a[1] || a[0] - b[0] || a[2] - b[2]);
  /** @type {[number, number, number, number][]} */
  const writes = leaves.map(([lq, ly, lr]) => [lq, ly, lr, BLOCK.AIR]);
  for (let y = top; y >= base; y--) writes.push([q, y, r, BLOCK.AIR]);
  writes.push([q, h, r, BLOCK.AIR]);
  // Nothing the player placed may rest on a cell it takes away (their gravel on a canopy leaf would fall).
  const removed = new Set(writes.map(([wq, wy, wr]) => `${wq},${wy},${wr}`));
  for (const [wq, wy, wr] of writes) {
    if (removed.has(`${wq},${wy + 1},${wr}`) || getBlock(wq, wy + 1, wr) === BLOCK.AIR) continue;
    if (edited(world, wq, wy + 1, wr)) return null;
  }
  // Leaves it keeps must not decay out from under anything once the trunk is gone (block physics runs the hanging-leaves
  // test on removed logs, §36.6.1): simulate that decay and refuse the tree when something would fall.
  const logs = [];
  for (let y = base; y <= top; y++) logs.push([q, y, r]);
  if (!keptLeavesStay(world, removed, logs)) return null;
  if (under !== BLOCK.DIRT) writes.push([q, h - 1, r, BLOCK.DIRT]);
  return { kind: 'uprooted', at: [q, h, r], writes };
}

/**
 * The nearest natural tree within WATCHER_TREE_RANGE (horizontal, from (x, z) to the trunk's centre; ties by q then r)
 * that planUprootAt can take. @returns {WatcherTrace|null}
 */
export function planUproot(world, x, y, z) {
  const [fq, fr] = worldToHex(x, z);
  const n = Math.ceil(WATCHER_TREE_RANGE / (Math.sqrt(3) / 2)) + 1;
  /** @type {[number, number, number, number][]} */
  const trunks = [];
  for (let dq = -n; dq <= n; dq++) {
    for (let dr = -n; dr <= n; dr++) {
      const q = fq + dq;
      const r = fr + dr;
      const [cx, cz] = hexToWorld(q, r);
      const d = Math.hypot(cx - x, cz - z);
      if (d > WATCHER_TREE_RANGE || !world.isLoadedCell(q, r)) continue;
      const h = world.groundHeight(q, r);
      if (h >= 1 && isLog(world.getBlock(q, h + 1, r))) trunks.push([d, q, r, h]);
    }
  }
  trunks.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  for (const [, q, r, h] of trunks) {
    const t = planUprootAt(world, q, h, r);
    if (t) return t;
  }
  return null;
}

/**
 * One trace where a Watcher stood at feet (x, y, z): a random kind of `kinds` first, then the others in random order,
 * the first that can be placed safely. @returns {WatcherTrace|null}
 */
export function planTrace(world, x, y, z, rng, kinds = TRACE_KINDS) {
  const order = kinds.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const kind of order) {
    const t = kind === 'pillar' ? planPillar(world, x, y, z, rng)
      : kind === 'deadfire' ? planDeadFire(world, x, y, z, rng)
        : kind === 'uprooted' ? planUproot(world, x, y, z) : null;
    if (t) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The Watcher
// ---------------------------------------------------------------------------------------------------------------

export class Watcher {
  /** @param {() => number} [rng] uniform [0, 1); Math.random by default */
  constructor(rng = Math.random) {
    this._rng = rng;
    this._enabled = true;
    /** bumped whenever the saved on/off switch changes (main autosaves on it) */
    this.switchVersion = 0;
    /** @type {WatcherFigure|null} */
    this.figure = null;
    /** seconds to the next natural roll */
    this._checkIn = WATCHER_CHECK_S;
    /** a roll came up for night `_dueKey`: try to place it at every check until that night ends */
    this._due = false;
    this._dueKey = NaN;
    /** the night of the last natural sighting (one per night; saved with the world as `watcherNight`, §14) */
    this._lastKey = NaN;
    /** @type {WatcherEvents} */
    this.events = { appeared: null, vanished: null, wisp: false };
  }

  /** The saved per-world switch: off means no Watcher at all (none appears, summon refuses). */
  get enabled() {
    return this._enabled;
  }

  get present() {
    return this.figure !== null;
  }

  /**
   * The night (nightKey) of the last natural sighting, null when there was none since clear(). main saves it with the
   * world (`watcherNight`), so a reload in the same night cannot bring a second one.
   * @returns {number|null}
   */
  get lastNight() {
    return Number.isSafeInteger(this._lastKey) ? this._lastKey : null;
  }

  /**
   * Restore a saved lastNight (main.startLoading, after clear()): a whole night number ≥ 0, or null for none. Anything
   * else is refused and leaves none. @returns {boolean} accepted
   */
  setLastNight(night) {
    const ok = night === null || (Number.isSafeInteger(night) && night >= 0);
    this._lastKey = ok && night !== null ? night : NaN;
    return ok;
  }

  /** Turn the Watcher on or off for this world; off removes it at once (no puff, no trace). @returns {boolean} changed */
  setEnabled(on) {
    const next = !!on;
    if (next === this._enabled) return false;
    this._enabled = next;
    this.switchVersion++;
    if (!next) {
      this.figure = null;
      this._due = false;
    }
    return true;
  }

  /** Forget everything (a new world): no figure, no pending roll, no night used. The switch is kept. */
  clear() {
    this.figure = null;
    this._due = false;
    this._dueKey = NaN;
    this._lastKey = NaN;
    this._checkIn = WATCHER_CHECK_S;
  }

  /**
   * Why a natural sighting may happen now: 'cave' deep underground (any time), 'night' at night, else null. Never while
   * the player's head is under water (the water fog would hide it).
   * @param {WatcherWorld} world
   * @returns {'cave'|'night'|null}
   */
  sightingMode(world) {
    const p = world.player;
    if (!p || p.headInWater) return null;
    if (isDeepUnderground(world)) return 'cave';
    return isDayTime(world.time) ? null : 'night';
  }

  /**
   * A spot for it: a column at a horizontal distance of max(WATCHER_MIN_DIST, FOG_MIN·fogFar) … FOG_MAX·fogFar from the
   * player, aimed `edgeMin … edgeMax` of the screen's half-width either side of its middle (at the horizon), loaded, with
   * room to stand (on the surface, or in a cave near the player's level when `cave`), at least WATCHER_MIN_DIST away in
   * 3D, and on screen: its feet and the top of its head inside the view shrunk by WATCHER_VIEW_MARGIN. The first such
   * spot with line of sight wins. None in sight → null, unless `hiddenOk` (summon): then the first one found, hidden
   * behind something in the view (los false).
   * @param {WatcherWorld} world
   * @param {boolean} cave
   * @param {{ edgeMin?: number, edgeMax?: number, hiddenOk?: boolean }} [opts]
   * @returns {{ x: number, y: number, z: number, los: boolean }|null}
   */
  findSpot(world, cave, { edgeMin = WATCHER_EDGE_MIN, edgeMax = WATCHER_EDGE_MAX, hiddenOk = false } = {}) {
    const p = world.player;
    if (!p || !world.eye || !world.look || !(world.fogFar > 0)) return null;
    const dMin = Math.max(WATCHER_MIN_DIST, WATCHER_FOG_MIN * world.fogFar);
    const dMax = WATCHER_FOG_MAX * world.fogFar;
    if (dMin > dMax) return null;
    const rng = this._rng;
    const fy = Math.floor(p.y + 0.01);
    // A point at the horizon `side` off the view yaw is tan(side) / (cos(pitch) · tanH) of the half-width out.
    const reach = viewTangents(world)[0] * Math.hypot(world.look[0], world.look[2]);
    /** @type {{ x: number, y: number, z: number, los: boolean }|null} */
    let hidden = null;
    for (let k = 0; k < WATCHER_PLACE_TRIES; k++) {
      const sign = rng() < 0.5 ? -1 : 1;
      const side = sign * Math.atan((edgeMin + rng() * (edgeMax - edgeMin)) * reach);
      const d = dMin + rng() * (dMax - dMin);
      const yaw = world.yaw + side;
      const [q, r] = worldToHex(p.x - Math.sin(yaw) * d, p.z - Math.cos(yaw) * d);
      const [x, z] = hexToWorld(q, r);
      const dh = Math.hypot(x - p.x, z - p.z);
      if (dh < dMin || dh > dMax || !world.isLoadedCell(q, r)) continue;
      const y = cave ? caveFeetY(world, q, r, fy) : surfaceFeetY(world, q, r);
      if (y === null || Math.hypot(dh, y - p.y) < WATCHER_MIN_DIST) continue;
      if (!inView(world, x, y, z, WATCHER_VIEW_MARGIN) || !inView(world, x, y + WATCHER_HEIGHT, z, WATCHER_VIEW_MARGIN)) continue;
      const los = this._canSee(world, x, y, z);
      if (los) return { x, y, z, los };
      if (hiddenOk && !hidden) hidden = { x, y, z, los };
    }
    return hidden;
  }

  /**
   * `summon watcher` (a testing command): one at the proper far distance in view — WATCHER_SUMMON_SIDE_MIN … MAX aside
   * on screen (at most the view's own margin), any time of day — in sight when there is such a spot, else the first one
   * hidden behind something in the view (so it can be tried underground too; it then goes after WATCHER_UNSEEN_S like
   * any sighting nobody sees). Refused (null) when off, when one is already here or when nothing in view will do. It
   * does not use up the night's sighting.
   * @param {WatcherWorld} world
   * @returns {WatcherFigure|null}
   */
  summon(world) {
    if (!this._enabled || this.figure || !world.player) return null;
    const tanH = viewTangents(world)[0];
    const lim = 1 - WATCHER_VIEW_MARGIN;
    const spot = this.findSpot(world, isDeepUnderground(world), {
      edgeMin: Math.min(lim, Math.tan(WATCHER_SUMMON_SIDE_MIN) / tanH),
      edgeMax: Math.min(lim, Math.tan(WATCHER_SUMMON_SIDE_MAX) / tanH),
      hiddenOk: true,
    });
    return spot ? this._appear(spot, world, 'summon') : null;
  }

  /**
   * `summon watcher q y r`: one standing with its feet at (cell centre, y). @returns {WatcherFigure|null} null when off
   * or one is already here
   */
  summonAt(world, q, y, r) {
    if (!this._enabled || this.figure || !world.player || !Number.isFinite(q + y + r)) return null;
    const [x, z] = hexToWorld(q, r);
    return this._appear({ x, y, z, los: this._canSee(world, x, y, z) }, world, 'summon');
  }

  /**
   * Natural appearances, then the figure: proximity, dawn, gaze, the unseen timeout, its head and its wisps.
   * @param {number} dt
   * @param {WatcherWorld} world
   * @returns {WatcherEvents} this.events (reused)
   */
  update(dt, world) {
    const ev = this.events;
    ev.appeared = null;
    ev.vanished = null;
    ev.wisp = false;
    if (!(dt > 0) || !world.player) return ev;
    if (this.figure) {
      this._step(this.figure, dt, world);
      return ev;
    }
    if (!this._enabled) return ev;
    const key = nightKey(world.time, Number.isFinite(world.day) ? world.day : 1);
    if (key !== this._dueKey) {
      this._due = false; // a roll that found no spot lapses with its night
      this._dueKey = key;
    }
    // A remembered night AHEAD of the clock (the console's `time set` rewinds the hour but keeps the day; or a bad save)
    // counts as tonight: never a second sighting in the night the player is in, and never a block on the nights to come.
    if (this._lastKey > key) this._lastKey = key;
    const mode = this.sightingMode(world);
    if (!mode || key === this._lastKey) return ev;
    this._checkIn -= dt;
    if (this._checkIn > 0) return ev;
    this._checkIn = WATCHER_CHECK_S;
    if (!this._due) {
      if (!(this._rng() < WATCHER_CHECK_CHANCE)) return ev;
      this._due = true;
    }
    const spot = this.findSpot(world, mode === 'cave');
    if (!spot) return ev; // nowhere on screen and in sight: still due, tried again at the next check of the night
    this._due = false;
    this._lastKey = key;
    ev.appeared = this._appear(spot, world, mode);
    return ev; // never vanishes on the update it appears in
  }

  /** @returns {WatcherFigure} */
  _appear(spot, world, kind) {
    const p = world.player;
    const [q, r] = worldToHex(spot.x, spot.z);
    const yaw = p ? yawToward(spot.x, spot.z, p.x, p.z) : 0;
    /** @type {WatcherFigure} */
    const f = {
      x: spot.x,
      y: spot.y,
      z: spot.z,
      q,
      r,
      yaw,
      headYaw: yaw,
      headPitch: 0,
      kind,
      los: !!spot.los,
      age: 0,
      gaze: 0,
      unseen: 0,
      seen: false,
      wispIn: WATCHER_WISP_MIN_S + this._rng() * (WATCHER_WISP_MAX_S - WATCHER_WISP_MIN_S),
    };
    this.figure = f;
    return f;
  }

  /** Line of sight from the eye to its eyes, or failing that to its centre. */
  _canSee(world, x, y, z) {
    const e = world.eye;
    if (!e) return false;
    return lineOfSight(world.getBlock, e[0], e[1], e[2], x, y + WATCHER_EYE_Y, z) ||
      lineOfSight(world.getBlock, e[0], e[1], e[2], x, y + WATCHER_CENTRE_Y, z);
  }

  /** @param {WatcherFigure} f */
  _step(f, dt, world) {
    const ev = this.events;
    const p = /** @type {PlayerState} */ (world.player);
    f.age += dt;
    if (!world.isLoadedCell(f.q, f.r)) return this._vanish(f, 'unloaded', world);
    if (Math.hypot(f.x - p.x, f.y - p.y, f.z - p.z) <= WATCHER_NEAR_VANISH) return this._vanish(f, 'near', world);
    if (f.kind === 'night' && isDayTime(world.time) && !isDeepUnderground(world)) return this._vanish(f, 'dawn', world);
    // Seen? On screen = its centre or its eyes inside the view (the camera's fov and window) with line of sight to that
    // point — rays only for a point on screen (one or two a frame). Looking straight at it: its centre within the gaze cone.
    const e = world.eye;
    const l = world.look;
    const cx = f.x - e[0];
    const cy = f.y + WATCHER_CENTRE_Y - e[1];
    const cz = f.z - e[2];
    const dist = Math.hypot(cx, cy, cz);
    const cos = dist > 1e-6 ? (cx * l[0] + cy * l[1] + cz * l[2]) / dist : 1;
    const getBlock = world.getBlock;
    const vf = world.viewFov > 0 ? world.viewFov : world.fov; // what the camera draws now (wider while sprinting)
    const centreSeen = (cos >= Math.cos(WATCHER_GAZE_CONE) || inView(world, f.x, f.y + WATCHER_CENTRE_Y, f.z, 0, vf)) &&
      lineOfSight(getBlock, e[0], e[1], e[2], f.x, f.y + WATCHER_CENTRE_Y, f.z);
    const straight = centreSeen && cos >= Math.cos(WATCHER_GAZE_CONE);
    const seen = centreSeen || (inView(world, f.x, f.y + WATCHER_EYE_Y, f.z, 0, vf) &&
      lineOfSight(getBlock, e[0], e[1], e[2], f.x, f.y + WATCHER_EYE_Y, f.z));
    f.seen = seen;
    f.gaze = straight ? f.gaze + dt : 0;
    if (f.gaze >= WATCHER_GAZE_S) return this._vanish(f, 'gaze', world);
    f.unseen = seen ? 0 : f.unseen + dt;
    if (f.unseen >= WATCHER_UNSEEN_S) return this._vanish(f, 'unseen', world);
    // The head follows the player, slowly, never more than WATCHER_HEAD_MAX_TURN from where the body faces.
    const want = wrapAngle(yawToward(f.x, f.z, p.x, p.z) - f.yaw);
    const rel = Math.max(-WATCHER_HEAD_MAX_TURN, Math.min(WATCHER_HEAD_MAX_TURN, want));
    const step = WATCHER_HEAD_TURN_RATE * dt;
    f.headYaw = wrapAngle(f.yaw + approach(wrapAngle(f.headYaw - f.yaw), rel, step));
    const pitch = Math.atan2(e[1] - (f.y + WATCHER_EYE_Y), Math.hypot(e[0] - f.x, e[2] - f.z));
    f.headPitch = approach(f.headPitch, Math.max(-WATCHER_HEAD_MAX_PITCH, Math.min(WATCHER_HEAD_MAX_PITCH, pitch)), step);
    f.wispIn -= dt;
    if (f.wispIn <= 0) {
      ev.wisp = true;
      f.wispIn = WATCHER_WISP_MIN_S + this._rng() * (WATCHER_WISP_MAX_S - WATCHER_WISP_MIN_S);
    }
    return undefined;
  }

  /** Gone: maybe a trace (WATCHER_TRACE_CHANCE; never for 'unloaded'). */
  _vanish(f, reason, world) {
    this.figure = null;
    const trace = reason !== 'unloaded' && this._rng() < WATCHER_TRACE_CHANCE ? planTrace(world, f.x, f.y, f.z, this._rng) : null;
    this.events.vanished = { x: f.x, y: f.y, z: f.z, reason, trace };
    return undefined;
  }
}

