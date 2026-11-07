// Caelancraft — every numeric constant and tuning knob. No logic lives here.
// Units: blocks (metres), seconds, radians. See src/CONTRACTS.md §2.

export const VERSION = '0.2.0';

// World (cells are hexagonal prisms addressed by axial (q, r) + y; see src/hex.js)
export const CHUNK_SIZE = 16;                       // q and r extent of a chunk, in cells
export const WORLD_HEIGHT = 128;                    // Y extent; valid block y is 0..127
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;  // 256
export const CHUNK_VOLUME = CHUNK_AREA * WORLD_HEIGHT; // 32768
export const SEA_LEVEL = 62;                        // highest y that is WATER in oceans
export const MIN_TERRAIN_HEIGHT = 40;
export const MAX_TERRAIN_HEIGHT = WORLD_HEIGHT - 10; // 118; leaves room for trees

// Streaming
export const RENDER_DISTANCE = 7;                   // default mesh radius in chunks (hex distance); ?rd= overrides
export const DATA_RADIUS_EXTRA = 1;                 // chunks generated beyond the mesh radius (hex distance)
export const UNLOAD_RADIUS_EXTRA = 3;               // chunks kept beyond the mesh radius before unloading
export const BUILD_BUDGET_MS = 6;                   // world.update() stops starting new jobs after this
export const MAX_BUILDS_PER_UPDATE = 6;             // hard cap per update regardless of time
export const LOADING_BUDGET_MS = 50;                // per-frame budget during the loading screen

// Interaction
export const REACH = 5;                             // raycast max distance from the eye, blocks
export const BREAK_REPEAT_S = 0.25;                 // hold-to-repeat interval for breaking
export const PLACE_REPEAT_S = 0.2;                  // hold-to-repeat interval for placing

// Atlas / UV contract
export const ATLAS_TILE_PX = 16;
export const ATLAS_TILES_PER_ROW = 16;
export const ATLAS_SIZE_PX = ATLAS_TILE_PX * ATLAS_TILES_PER_ROW; // 256
export const TILE_UV = 1 / ATLAS_TILES_PER_ROW;     // 0.0625
export const UV_INSET = 1 / 4096;                   // 1/16 texel; kills boundary bleed

// Mesher
export const WATER_SURFACE_HEIGHT = 0.875;          // top of a water block with non-water above
export const AO_CURVE = [0.45, 0.65, 0.82, 1.0];    // index = vertexAO value 0..3
// Per-face shade lives in hex.js (FACE_SHADE) because it derives from the hex face normals.
export const TOP_UV_SCALE = Math.sqrt(3) / 2;       // hexagon top/bottom faces are inscribed in the tile (corner-to-corner = tile height)
export const FOG_FAR_CHUNK_MARGIN = -1;             // fog far = (renderDistance + margin) * CHUNK_RING_INRADIUS. Negative because the mesh
                                                    // disc is keyed by chunk ORIGIN cells while a footprint extends 16·√3 toward (+1,+1): the
                                                    // nearest unmeshed cell can be as close as (rd − 1) rings (tight analytic bound)

// Player / physics
export const PLAYER_WIDTH = 0.56;                   // cylinder diameter; must stay < HEX_SIZE (0.577): every 1-cell passage is pinched to one
                                                    // edge length by the two wall corners flanking it, and < 2 * HEX_INRADIUS (7-column collider)
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;
export const SNEAK_EYE_HEIGHT = 1.27;
export const GRAVITY = -28;
export const JUMP_VELOCITY = 8.7;                   // discrete (semi-implicit Euler, h=1/60) apex ≈ 1.28 blocks; analytic 1.35
export const TERMINAL_VELOCITY = -60;
export const WALK_SPEED = 4.317;
export const SPRINT_SPEED = 5.612;
export const SNEAK_SPEED = 1.31;
export const FLY_SPEED = 10.8;
export const FLY_SPRINT_SPEED = 21.6;
export const FLY_VERTICAL_SPEED = 7.5;
export const GROUND_ACCEL = 20;                     // 1/s, exponential approach rate on ground / flying
export const AIR_ACCEL = 4;
export const WATER_ACCEL = 6;
export const WATER_GRAVITY = -6;
export const WATER_MAX_SINK = -3;
export const SWIM_UP_SPEED = 3.5;
export const SWIM_EXIT_JUMP = 8.7;                  // vy when swimming into a wall with jump held; must clear a bank 1 block above the water surface
export const WATER_SPEED_FACTOR = 0.5;
export const MAX_SUBSTEP_DT = 1 / 60;
export const MAX_FRAME_DT = 0.1;                    // clamp rAF dt (tab hidden, GC spikes)
export const COLLISION_EPS = 1e-5;

// Camera / controls
export const FOV = 70;
export const SPRINT_FOV = 80;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 1000;
export const MOUSE_SENSITIVITY = 0.002;             // radians per pixel
export const PITCH_LIMIT = Math.PI / 2 - 0.002;     // about ±89.9°
export const MAX_PIXEL_RATIO = 2;
export const DOUBLE_TAP_MS = 250;                   // double-tap W → sprint
export const DOUBLE_TAP_SPACE_MS = 300;             // double-tap Space → toggle fly

// Commands and Rune Blocks (CONTRACTS §26–§27)
export const GAME_SECONDS_PER_DAY = 86400;          // `time add` counts game seconds: 86400 per in-game day
export const MAX_FILL_CELLS = 32768;                // cells one area command (fill / hexfill / hexring) may address
export const MAX_TOTAL_EDITS = 300000;              // area commands refuse when the world's recorded edits would exceed this (~2.3 MB of save JSON)
export const MAX_CELLS_PER_FRAME = 4096;            // area-command cells written per frame across all scripts
export const MAX_AREA_CHUNKS_PER_FRAME = 2;         // chunk columns one area job may write per frame (bounds the re-mesh hitch for thin fills)
export const MAX_COMMANDS_PER_FRAME = 64;           // script commands executed per frame across all scripts
export const MAX_RUNNING_SCRIPTS = 64;
export const MAX_CHAIN_HOPS = 32;                   // backstop; the once-per-activation wave rule is the real loop guard
export const CHAIN_DELAY_S = 0.1;                   // delay between a script finishing and its neighbours starting
export const MAX_RUNES = 1024;                      // rune blocks with a stored script/settings
export const MAX_RUNE_SCRIPT_CHARS = 4096;
export const MAX_RUNE_SCRIPT_LINES = 128;
export const MAX_RUNE_LABEL_CHARS = 32;
export const WAIT_MIN_S = 0.05;
export const WAIT_MAX_S = 600;
export const REPEAT_MIN_S = 0.25;
export const REPEAT_MAX_S = 3600;
export const STEP_COOLDOWN_MAX_S = 3600;
export const AREA_MAX_RADIUS = 64;                  // parse-level sanity bound for hexfill / hexring radius
export const AREA_MAX_HEIGHT = 128;                 // parse-level sanity bound for hexfill / hexring height
export const MAX_CONSOLE_LINES = 200;               // console scrollback
export const CONSOLE_HISTORY = 50;                  // typed lines remembered for ↑/↓ (memory only)
export const CHAT_LINES = 6;                        // HUD chat-log lines shown at once
export const CHAT_LINE_MS = 6000;                   // a chat-log line fades after this long

// Body-to-body physics (CONTRACTS §31)
export const PLAYER_MASS = 1;
export const BODY_PASSES = 3;                       // pair-separation sweeps per frame (chains of touching bodies settle)

// Campfires (CONTRACTS §32)
export const CAMPFIRE_MAX_TRACKED = 1024;           // campfires beyond this are inert (no model, light or sound) until others go
export const CAMPFIRE_MODEL_RANGE = 64;             // world units from the camera within which campfires get a model
export const CAMPFIRE_MAX_MODELS = 48;              // nearest-first
export const CAMPFIRE_LIGHTS = 4;                   // pooled point lights, given to the nearest lit models (constant count: no shader rebuilds)
export const CAMPFIRE_LIGHT_INTENSITY = 6;          // PointLight intensity before flicker
export const CAMPFIRE_LIGHT_RANGE = 14;             // PointLight distance (light reaches zero there)
export const CAMPFIRE_CRACKLE_RANGE = 10;           // crackles are audible within this distance, fading linearly
export const CAMPFIRE_CRACKLES_PER_S = 5;           // average crackle rate at the fire

// Black holes (CONTRACTS §29)
export const BLACK_HOLE_PULL_RADIUS = 10;           // world units from the hole's centre where the pull acts
export const BLACK_HOLE_PULL_STRENGTH = 120;        // m/s² at the centre, falling off as (1 − d/R)²; ground walking escapes beyond ~1.5 units
export const BLACK_HOLE_EAT_RADIUS = 4;             // cells whose centre is within this distance of the hole can be swallowed
export const BLACK_HOLE_EAT_INTERVAL_S = 0.2;       // each hole swallows at most one cell per interval
export const BLACK_HOLE_MAX_EATS_PER_FRAME = 4;     // across all holes (each eat re-meshes a chunk)
export const BLACK_HOLE_MAX_TRACKED = 256;          // holes beyond this are inert until others are broken

// Pigs (CONTRACTS §30)
export const PIG_MAX = 32;                          // pigs in a world; summon refuses beyond this
export const PIG_NATURAL_COUNT = 5;                 // pigs placed on grass near spawn in a world that has never had any
export const PIG_RADIUS = 0.42;                     // body cylinder (collisions, pushing and ray targeting); ≤ MAX_BODY_RADIUS
export const PIG_HEIGHT = 0.9;                      // fits under a one-cell overhang; too wide for one-cell tunnels
export const PIG_MASS = 0.7;                        // relative to PLAYER_MASS: the player shoves pigs more than they shove back
export const PIG_KNOCKBACK = 5;                     // m/s horizontal kick when hit, plus a small hop
export const PIG_HURT_S = 0.5;                      // red flash; hits during it are ignored
export const PIG_FLEE_S = 3;                        // run away after being hit
export const PIG_TURN_RATE = 4;                     // rad/s

// Block physics (CONTRACTS §33–§38, docs/DESIGN-physics.md). Scheduler core (§33):
export const PHYSICS_TICK_S = 0.05;                 // fixed tick; step(dt) runs at most ONE tick per frame (slow motion below 20 fps)
export const WATER_TICKS = 5;                       // delay (ticks) of the `water` ring; `fall` and `misc` use 1
export const PHYSICS_TICK_BUDGET_MS = 3;            // time budget per tick (checked every 32 cell updates / 256 support visits)
export const MAX_CELL_UPDATES_PER_TICK = 256;       // count backstop per tick across all rings
export const MAX_SUPPORT_VISITS_PER_TICK = 8192;    // support-search visits per tick (the search resumes next tick)
export const SUPPORT_STARVE_TICKS = 4;              // a pending collapse starved by full fall / misc rings this many ticks in a row …
export const SUPPORT_STARVED_VISITS = 256;          // … gets a step of this many visits anyway (CONTRACTS §33.1.3)
export const MAX_PARKED_UPDATES = 65536;            // updates waiting for an unloaded chunk; beyond this they are dropped (re-seeding covers them)
export const MAX_PENDING_SUPPORT_SEEDS = 4096;      // queued support-seed records; beyond this new records are dropped
export const UNDO_WINDOW_S = 60;                    // the last physics event can be undone this long after it began
export const UNDO_MAX_CELLS = 65536;                // cells one event records for undo (beyond: recorded partially)
export const LAZY_MESH_BUDGET_MS = 4;               // world.update(): lazy (physics) re-meshes per call, nearest first, at least one
// Falling blocks (§34)
export const MAX_FALLING = 1024;                    // column fallers in flight; beyond this (the lowest) cells settle instantly
export const MAX_TUMBLING = 64;                     // tumbling entities (debris, lit barrels); extra debris becomes dust
export const MAX_COLUMN_FALL = 128;                 // gravity blocks one gravity update releases from a column (bottom first)
export const FALLER_RADIUS = 0.45;                  // tumbling body radius (< HEX_INRADIUS); column fallers are exact cells
export const FALLER_HEIGHT = 0.98;
export const TUMBLE_SUBSTEP = 0.9;                  // displaceBody substeps keep |Δ| ≤ this (no tunnelling through 1-cell walls)
export const TUMBLE_AIR_DRAG = 0.98;                // velocity × this^(60·dt)
export const TUMBLE_GROUND_FRICTION = 0.8;          // horizontal velocity × this^(60·dt) while a tumbler rests on the ground
export const LANDING_DUST_PER_FRAME = 16;           // landings per frame that emit dust (the rest land silently)
// Effects
export const PARTICLE_CAPACITY = 2048;              // one THREE.Points system; the oldest particle is overwritten
export const PHYSICS_SOUND_RANGE = 24;              // thud / splash / hiss / creak audible within this distance (linear fade)
export const BOOM_SOUND_RANGE = 96;
export const SPLASH_MIN_INTERVAL_S = 0.4;           // throttles for repeated physics sounds
export const HISS_MIN_INTERVAL_S = 0.4;
// Flowing water (§35, fluids.js)
export const WATER_CURRENT = 6;                     // m/s² push toward the lowest-level side neighbour in FLOW cells
export const DRAIN_MAX_RADIUS = 16;                 // `drain [radius]`
export const DRAIN_DEFAULT_RADIUS = 8;
export const WATER_SOURCE_NEIGHBOURS = 3;           // a flowing / falling cell with this many WATER side-neighbours (and a floor) becomes a source;
                                                    // 2 would let two adjacent sources fill a lake (they share two neighbours on a hex grid)
export const WADE_DEPTH = 0.4;                      // a body swims only where the water surface is more than this above its feet (or its chest is under)
export const WADE_SPEED_FACTOR = 0.85;              // horizontal speed in shallower water (wading: walking, jumping, no swim mode)
// Collapsing structures and trees (§36, support.js / trees.js)
export const SUPPORT_LIMIT = 8192;                  // a search that visits this many cells counts as supported
export const TREE_MAX_CELLS = 400;                  // larger floating components crumble instead of toppling
export const TREE_MAX_TOPPLING = 4;                 // trees toppling at once; more wait in a queue
export const TREE_QUEUE_GAP_S = 0.3;
export const TREE_SHAKE_S = 0.15;
export const TREE_THETA0 = 0.12;                    // initial tilt (rad) of the rod model θ'' = (3g / 2h)·sin θ
export const TREE_CAUSE_RANGE = 16;                 // the player within this distance sets the topple direction
// (collapse / trees feature, CONTRACTS §36.3–§36.6)
export const TREE_LEAF_RADIUS = 2;                  // tree test: its leaves lie within this hex distance of its log columns …
export const TREE_LEAF_ABOVE = 3;                   // … from the lowest floating log up to the top log + this
export const TREE_MAX_QUEUED = 64;                  // trees waiting for a topple slot; beyond this a floating tree crumbles
export const TREE_SHAKE_ANGLE = 0.035;              // ±2° wobble during the TREE_SHAKE_S shake (which also eases in TREE_THETA0)
export const TREE_SHAKE_WOBBLES = 3;                // whole wobbles in one shake (ends exactly at TREE_THETA0)
export const TREE_SUBSTEP_S = 1 / 120;              // rod integration / collision substep (the top log moves ≤ ~0.15 per substep)
export const TREE_KNOCK_RADIUS = 1.2;               // bodies this close to a landing log are knocked away …
export const TREE_KNOCK_SPEED = 4;                  // … at this horizontal speed (m/s) …
export const TREE_KNOCK_UP = 5;                     // … plus this upward speed
export const TREE_LEAF_PARTICLES = 96;              // leaf-burst particles per toppled tree (spread over its leaves)
export const LEAF_DECAY_RANGE = 3;                  // a leaf with no log within this (hex distance and |dy|) decays after a topple
export const LEAF_DECAY_S = 1;                      // decaying leaves disappear at random times within this
// Explosives (§37, explosions.js)
export const BARREL_FUSE_S = 3;
export const MAX_LIT_BARRELS = 32;                  // lit barrel entities; beyond this they burn as fuse timers in place
export const MAX_EXPLOSIONS_PER_FRAME = 1;
export const MAX_DEBRIS = 16;                       // destroyed cells that fly as tumbling debris per blast
export const BLAST_RADIUS = 3.5;                    // one barrel; a merged chain of n barrels: BLAST_RADIUS·cbrt(n) capped at BLAST_MAX_RADIUS
export const BLAST_MAX_RADIUS = 8;
export const BLAST_CHAIN_WINDOW_S = 0.5;            // fuses expiring within this of the earliest, and within BLAST_CHAIN_DISTANCE of it, merge
export const BLAST_CHAIN_DISTANCE = 8;
export const BLAST_IMPULSE = 16;                    // m/s at the centre, falling off linearly to 0 at 2R
export const BLAST_MIN_UP = 6;                      // at least this much of the impulse is upward
export const BLAST_SHAKE_RANGE = 24;                // camera shake within this distance
export const BLAST_FLASH_S = 0.25;
// Explosives, as built (§37): fuse timers, crater edge, debris, effects
export const BARREL_TIMER_FUSE_MIN_S = 0.3;         // a barrel caught in a blast burns in place for MIN … MAX seconds (seeded)
export const BARREL_TIMER_FUSE_MAX_S = 0.8;
export const MAX_FUSE_TIMERS = 4096;                // barrels burning in place; beyond this a barrel caught in a blast stays unlit
export const BARREL_HISS_S = 0.4;                   // the lit barrel nearest the player hisses this often
export const BARREL_PULSE_SCALE = 0.04;             // lit barrels are drawn at scale 1 ± this …
export const BARREL_PULSE_HZ = 4;                   // … at this rate, rising to 3× over the last second of the fuse
export const BLAST_JITTER = 0.5;                    // a cell breaks when its centre is within R + jitter, jitter ∈ ±this (seeded per cell and blast)
export const DEBRIS_SPEED_MIN = 6;                  // debris flies outward at MIN … MAX m/s …
export const DEBRIS_SPEED_MAX = 10;
export const DEBRIS_UP_MIN = 4;                     // … and upward at MIN … MAX m/s …
export const DEBRIS_UP_MAX = 8;
export const DEBRIS_SPIN = 9;                       // … spinning up to this many rad/s about each axis
export const BLAST_DUST_CELLS = 48;                 // destroyed cells (beyond the debris) that puff dust; the rest vanish silently
export const BLAST_FLASH_INTENSITY = 90;            // explosion PointLight peak for a one-barrel blast (× R / BLAST_RADIUS), fading over BLAST_FLASH_S
export const BLAST_SHAKE_S = 0.6;                   // camera shake duration …
export const BLAST_SHAKE_AMPLITUDE = 0.16;          // … and amplitude (m) at the blast for one barrel (× √(R / BLAST_RADIUS)), fading to 0 at BLAST_SHAKE_RANGE

// Time / saving / UI
export const DAY_LENGTH_SECONDS = 600;
export const START_TIME = 0.30;                     // 07:12
export const AUTOSAVE_INTERVAL_S = 30;
export const HOTBAR_SIZE = 9;
