// Caelancraft — every numeric constant and tuning knob. No logic lives here.
// Units: blocks (metres), seconds, radians. See src/CONTRACTS.md §2.

export const VERSION = '0.10.0';

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
export const INTRO_LINE_MS = 20000;                 // the Survival intro lines (the only pointer to the Handbook) stay this long

// Body-to-body physics (CONTRACTS §31)
export const PLAYER_MASS = 1;
export const BODY_PASSES = 3;                       // pair-separation sweeps per frame (chains of touching bodies settle)

// Campfires (CONTRACTS §32)
export const CAMPFIRE_MAX_TRACKED = 1024;           // fires scanned per frame; past this, the ones nearest the player are tracked (the rest still burn)
export const CAMPFIRE_RETRACK_DISTANCE = 8;         // past the cap, the tracked set is re-picked after the player moves this far
export const CAMPFIRE_RETRACK_BATCH = 16384;        // fires a re-pick examines per frame at most (it finishes over several frames)
export const CAMPFIRE_MODEL_RANGE = 64;             // world units from the camera within which campfires get a model
export const CAMPFIRE_MAX_MODELS = 48;              // nearest-first
export const CAMPFIRE_LIGHTS = 4;                   // pooled point lights, given to the nearest lit models (constant count: no shader rebuilds)
export const CAMPFIRE_LIGHT_FADE_S = 0.25;          // a pooled light fades out before it moves to another fire, then fades in
export const CAMPFIRE_LIGHT_HYSTERESIS = 0.5;       // a lit fire keeps its light until an unlit one is this much nearer
export const CAMPFIRE_LIGHT_INTENSITY = 6;          // PointLight intensity before flicker
export const CAMPFIRE_LIGHT_RANGE = 14;             // PointLight distance (light reaches zero there)
export const CAMPFIRE_CRACKLE_RANGE = 10;           // crackles are audible within this distance, fading linearly
export const CAMPFIRE_CRACKLES_PER_S = 5;           // average crackle rate at the fire

// Black holes (CONTRACTS §29)
export const BLACK_HOLE_PULL_RADIUS = 10;           // world units from the hole's centre where the pull acts
export const BLACK_HOLE_PULL_STRENGTH = 120;        // m/s² at the centre, falling off as (1 − d/R)². Physics turns a pull into a drift of
                                                    // pull / GROUND_ACCEL in every mode and at any frame rate (§12), which falls below WALK_SPEED
                                                    // ≈ 1.25 units from a hole on the floor: walking, hopping, sprinting or flying away escapes
                                                    // from 1.5 units out; standing still never does
export const BLACK_HOLE_EAT_RADIUS = 4;             // cells whose centre is within this distance of the hole can be swallowed
export const BLACK_HOLE_EAT_INTERVAL_S = 0.2;       // one eating round per interval (shared clock): each hole swallows at most one cell a round
export const BLACK_HOLE_MAX_EATS_PER_FRAME = 64;    // across all holes; a safety bound on setBlock calls (re-meshing is bounded by the next line)
export const BLACK_HOLE_MAX_EAT_CHUNKS_PER_FRAME = 1; // distinct chunks one frame's eats may dirty (World.update re-meshes each at once, §9.1
                                                    // step 2); the frame's first eat always goes, even when it dirties several at a chunk border
export const BLACK_HOLE_MAX_TRACKED = 256;          // holes beyond this are inert (no pull, eating or swallowing) until others are broken
export const BLACK_HOLE_RESPAWN_RINGS = 32;         // cell rings around the world spawn searched for a respawn point out of every hole's reach
                                                    // (a 256-hole cluster at spawn needs ~20; one search costs ~1 ms, ~10–30 ms when holes carpet it all)
export const BLACK_HOLE_SWALLOW_LINE_S = 2;         // the "swallowed" chat line and sound repeat at most this often

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

// Zombies (CONTRACTS §39): night mobs, never saved; the per-world on/off switch is.
export const ZOMBIE_MAX = 16;                       // alive at once; natural spawning and summon stop there
export const ZOMBIE_RADIUS = 0.27;                  // body cylinder: just under PLAYER_RADIUS, so it fits the player's 1-cell, 2-high doorways
export const ZOMBIE_HEIGHT = 1.9;                   // feet 0.56 + torso 0.76 + head 0.58
export const ZOMBIE_MASS = 1.2;                     // a little heavier than the player (PLAYER_MASS 1)
export const ZOMBIE_TARGET_RADIUS = 0.3;            // ray-target cylinder: the drawn torso's corner radius
export const ZOMBIE_CHASE_SPEED = 0.7;              // forward input while chasing: 0.7 × WALK_SPEED ≈ 3.0 m/s (the player walks 4.3; v0.11 §68, was 0.82)
export const ZOMBIE_TURN_RATE = 3.5;                // rad/s
export const ZOMBIE_SIGHT = 24;                     // chases a player within this distance …
export const ZOMBIE_CHASE_MAX_RISE = 5;             // … unless flying or more than this many units above its feet
export const ZOMBIE_MAX_DROP = 3;                   // walks down a drop of this many cells, never off a deeper one
export const ZOMBIE_REACH = 1.3;                    // horizontal centre distance of an attack (heights overlapping, no wall between)
export const ZOMBIE_REACH_OVERLAP = 0.1;            // the player's feet must be this far below the zombie's top (not standing on it)
export const ZOMBIE_ATTACK_COOLDOWN_S = 1;
export const ZOMBIE_HIT_PUSH = 6;                   // m/s horizontal knockback on the player …
export const ZOMBIE_HIT_LIFT = 4;                   // … plus this upward (no damage: there is no health)
export const ZOMBIE_HITS = 4;                       // player hits that knock a zombie out
export const ZOMBIE_KNOCKBACK = 6.5;                // m/s horizontal kick when the player hits it …
export const ZOMBIE_KNOCK_LIFT = 4.5;               // … plus a hop
export const ZOMBIE_HURT_S = 0.45;                  // red flash and stun; hits during it are ignored
export const ZOMBIE_KO_KNOCK = 9;                   // a knock (blast) at least this fast knocks it out: about the blast radius R
export const ZOMBIE_BURN_S = 4;                     // seconds under open daylight before it burns away
export const ZOMBIE_FIRE_FEAR = 4;                  // a campfire's safe zone (from y + 1): zombies keep out, nobody in it is struck …
export const ZOMBIE_SPAWN_FIRE_CLEAR = 8;           // … and never spawns within this of one
export const ZOMBIE_SPAWN_MIN = 16;                 // natural spawns: horizontal distance from the player, min …
export const ZOMBIE_SPAWN_MAX = 40;                 // … and max
export const ZOMBIE_SPAWN_INTERVAL_MIN_S = 14;      // one spawn attempt (1–2 zombies) every 14–36 s at night: as many a night
export const ZOMBIE_SPAWN_INTERVAL_MAX_S = 36;      // as before v0.11 (§68: 8–20 s over 5 min), spread over the 9-minute night
export const ZOMBIE_SPAWN_TRIES = 12;               // columns tried per attempt
export const ZOMBIE_DESPAWN_DIST = 80;              // farther than this from the player: gone
export const ZOMBIE_SOUND_RANGE = 24;               // groans and knock-outs fade out linearly by this distance

// Block physics (CONTRACTS §33–§38, docs/DESIGN-physics.md). Scheduler core (§33):
export const PHYSICS_TICK_S = 0.05;                 // fixed tick; step(dt) runs at most ONE tick per frame (slow motion below 20 fps)
export const WATER_TICKS = 5;                       // delay (ticks) of the `water` ring; `fall` and `misc` use 1
export const PHYSICS_TICK_BUDGET_MS = 3;            // time budget per tick, shared fairly by the rings and the support search (§33.1)
export const MAX_CELL_UPDATES_PER_TICK = 256;       // count backstop per tick across all rings
export const MAX_SUPPORT_VISITS_PER_TICK = 8192;    // support-search visits per tick (the search resumes next tick)
export const SUPPORT_STARVED_VISITS = 256;          // support step when the rings overran the whole tick budget (CONTRACTS §33.1.3)
export const MAX_PARKED_UPDATES = 65536;            // updates waiting for an unloaded chunk; beyond this they are dropped (re-seeding covers them)
export const MAX_PENDING_SUPPORT_SEEDS = 4096;      // queued support-seed records; beyond this new records are dropped
export const UNDO_WINDOW_S = 60;                    // the last physics event can be undone this long after it began
export const UNDO_MAX_CELLS = 65536;                // cells one event records for undo (beyond: recorded partially)
export const LAZY_MESH_BUDGET_MS = 4;               // world.update(): lazy (physics) re-meshes per call, nearest first, at least one
export const LAZY_COALESCE_UPDATES = 20;            // … a chunk dirtied only by a big crumble's instant part: one re-mesh per this many calls
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
export const FIZZLE_MIN_INTERVAL_S = 0.25;          // put-out / fizzling barrels: one 'fizzle' per interval at most
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
// v0.11 (CONTRACTS §68): one real minute is one game hour, and the day is long: 15 hours of daylight, 9 of dark
export const DAY_LENGTH_SECONDS = 1440;             // a whole game day: 24 real minutes
export const DAYLIGHT_HOURS = 15;                   // sunrise to sunset, centred on noon …
export const SUNRISE_TIME = 0.5 - DAYLIGHT_HOURS / 48; // … so the sun rises at 04:30 (0.1875) …
export const SUNSET_TIME = 0.5 + DAYLIGHT_HOURS / 48;  // … and sets at 19:30 (0.8125)
export const DAYTIME_SECONDS = (DAY_LENGTH_SECONDS * DAYLIGHT_HOURS) / 24; // 900: 15 real minutes of daylight
export const NIGHT_SECONDS = DAY_LENGTH_SECONDS - DAYTIME_SECONDS;         // 540: 9 real minutes of dark
export const START_TIME = 0.30;                     // 07:12
export const AUTOSAVE_INTERVAL_S = 30;
export const SAVE_SLOTS = 6;                        // worlds kept side by side, one localStorage key each (§41)
export const MAX_WORLD_NAME_CHARS = 24;             // world names are trimmed and cut to this many characters
export const STORAGE_QUOTA_ESTIMATE = 5 * 1024 * 1024; // characters a site may keep in localStorage in common browsers (~5 MB; the Worlds usage bar)
export const HOTBAR_SIZE = 9;                       // also the survival pack's hotbar: pack slots 0..HOTBAR_SIZE-1

// Survival (§42–§49; docs/DESIGN-survival.md §9.2). Rates are per real second; one game day is DAY_LENGTH_SECONDS.
export const GEN_LATEST = 2;                        // newest world generator: 2 adds the survival resources (absent `gen` = 1, today's land)
// Pack and containers (§5)
export const PACK_SLOTS = 27;                       // 0..8 the hotbar strip, 9..26 the rosette
export const WEAR_SLOTS = 3;                        // head, body, feet
export const BASKET_SLOTS = 18;                     // a wicker basket's rosette (6 + 12)
export const REMAINS_SLOTS = 30;                    // "Your Belongings": every pack and worn stack
export const MAX_CONTAINERS = 1024;                 // basket entries per world (a death always gets its entry beyond this)
// Campfires: fire spots and fuel (§4.4)
export const FIRE_SPOTS = 7;                        // six skewers (0..5) and the embers (6)
export const MAX_FIRE_SLOTS = 256;                  // fires with spot or fuel entries kept in a save
export const CAMPFIRE_FUEL_START_S = 300;           // a campfire placed in Survival (and a relit pit) starts with this much fuel
export const CAMPFIRE_FUEL_MAX_S = 1200;
export const FUEL_STICK_S = 40;                     // fuel per stick fed …
export const FUEL_LOG_S = 300;                      // … and per log (six riven sticks give less than the log)
export const RELIGHT_HOLD_S = 3;                    // hold R this long to relight a cold fire pit
// Making (§7)
export const STATION_RANGE = 3;                     // a workplace is near within this hex distance (|dy| ≤ 2): needed to queue a job
export const PACK_MESSAGE_S = 3;                    // the pack screen's own feedback line (a refusal, a Make result) stays this long
export const STATION_WORK_RANGE = 16;               // a lane's head job runs while its workplace is within this hex distance
export const MAX_CRAFT_JOBS = 8;                    // jobs across all lanes
// The body (§2–§3)
export const STAT_MAX = 100;                        // health, satiation (shown as Nourishment) and hydration
export const BREATH_MAX_S = 20;
export const BREATH_REFILL_PER_S = 5;
export const BODY_TEMP_NORMAL = 37;                 // °C
export const BODY_TEMP_MIN = 25;
export const BODY_TEMP_MAX = 45;
export const SICK_MAX_S = 600;                      // repeat cases of sickness add up to this
export const HEAL_MAX = 50;                         // pending bandage healing
// Damage (§2.4)
export const FALL_SAFE_SPEED = 14.0;                // m/s: a 3-cell drop (13.07) and a jump off a 2-cell ledge (13.70) are safe; 4 cells (14.93) hurts
export const FALL_DAMAGE_K = 0.1;                   // HP = K·(v² − FALL_SAFE_SPEED²) × the soft-landing factor
export const CRUSH_DAMAGE_PER_CELL = 6;             // per cell unstickPlayer lifts the player
// Input timing (§4.2, §4.5, §6)
export const ATTACK_REPEAT_S = 0.55;                // held LMB strikes a mob this often (longer than PIG_HURT_S and ZOMBIE_HURT_S)
export const DIG_TICK_S = 0.25;                     // dig sound and dust cadence
export const USE_REPEAT_GAP_S = 0.25;               // held RMB starts the next eat / drink after this
export const GULP_GAP_S = 0.5;                      // one hand gulp of water per this
export const TAP_HOLD_S = 4;                        // hold R this long to tap a birch
// Mobs in Survival (§4.3, §2.4)
export const PIG_HEALTH = 5;
export const PIG_REPOP_CHECK_S = 150;               // daylight repopulation check interval
export const PIG_REPOP_TARGET = 3;                  // pigs wanted within PIG_REPOP_RADIUS of the player
export const PIG_REPOP_RADIUS = 64;
export const PIG_REPOP_MIN = 24;                    // repopulation spawns this far from the player, min …
export const PIG_REPOP_MAX = 48;                    // … and max
export const ZOMBIE_DAMAGE = 8;                     // HP per zombie strike in Survival (the push is unchanged)
export const FIRE_BURN_DAMAGE = 4;                  // HP per campfire scorch (at most one per 0.5 s)
// Regrowth (§6.5)
export const REGROW_MEAN_S = 600;                   // a picked bush regrows after about 10 real minutes on average
export const MAX_REGROW_TRACKED = 4096;

// ---- Circuits (§50–§53; docs/DESIGN-circuits.md §4, §6.3). Volts are whole VOLT_UNITs; rates per real second.
export const CIRCUIT_TICK_S = 0.05;                 // one circuit tick; Circuits.step(dt) runs at most 2 per call
export const VOLT_UNIT = 0.0625;                    // every voltage is a whole number of these (the solver's bucket queue)
export const WIRE_OHMS = 0.0625;                    // per wire cell: a cell drops WIRE_OHMS × ⌈I_net⌉ volts (one VOLT_UNIT per amp)
export const BATTERY_V = 6;                         // a fresh Voltaic Battery …
export const BATTERY_EMPTY_V = 4.5;                 // … and its voltage just before empty (then 0)
export const BATTERY_KNEE = 0.25;                   // share of BATTERY_CAPACITY below which the voltage falls
export const MAX_PILE = 4;                          // batteries stacked in series (24 V); a fifth does nothing
export const BLASTER_V = 24;                        // the Blasting Machine's pulse
export const SELENIUM_MAX_V = 3;                    // the Selenium Panel in full open sun
export const LAMP_MIN_V = 1.5;                      // a Filament Lamp glows from here …
export const LAMP_FULL_V = 6;                       // … to full brightness here
export const COIL_MIN_V = 2.5;                      // relay coil, bell, transmitter, timer start, coherer tapper
export const IGNITER_MIN_V = 3;
export const LAMP_AMPS = 1;                         // load currents: each is both the load's share of the wire drop and its drain
export const BELL_AMPS = 1;
export const IGNITER_AMPS = 2;
export const COIL_AMPS = 0.5;
export const BATTERY_CAPACITY = 3600;               // amp-seconds: one lamp burns for an hour of real time
export const EARTH_WALK_CELLS = 8;                  // earth cells walked down from below a device to reach natural ground
export const IGNITER_REFIRE_S = 0.5;                // a powered igniter fires on the rising edge, then this often
export const RELAY_DELAY_TICKS = 1;                 // a relay's contacts follow its coil one tick later (50 ms)
export const RELAY_HAND_S = 0.5;                    // the R key pushes a relay's armature for this long on a press
export const BUTTON_PULSE_S = 0.3;                  // a click holds a Push Button at least this long …
export const BUTTON_RELEASE_S = 0.1;                // … and it releases this long after the button is let go
export const BLASTER_PULSE_S = 1;                   // the Blasting Machine gives BLASTER_V for this long …
export const BLASTER_RESET_S = 1.5;                 // … then its handle rises for this long (a plunge is refused meanwhile)
export const TIMER_MIN_S = 0.5;                     // Clockwork Timer delay, in 0.5 s steps
export const TIMER_MAX_S = 3600;
export const TIMER_DEFAULT_S = 5;
export const TIMER_PULSE_S = 1;                     // pulse mode stays closed this long (and repeat at most this long)
export const RADIO_CHANNELS = 16;                   // wavelengths RADIO_BASE_M + RADIO_STEP_M·(channel − 1): 300 m … 1050 m
export const RADIO_BASE_M = 300;
export const RADIO_STEP_M = 50;
export const RADIO_DISTRESS_CH = 7;                 // 600 m, the 1906 maritime distress wavelength
export const RADIO_RANGE = 160;                     // a send reaches receivers whose cell centre is within this (3D)
export const RADIO_PULSE_S = 1;                     // a receiver in pulse mode stays closed this long
export const FUSE_CELL_S = 0.4;                     // a Powder Fuse cell burns this long: 2.5 cells/s
export const MAX_BURNING_FUSES = 2048;              // fuse cells burning at once; more wait in the flame queue
export const MAX_FLAME_QUEUE = 4096;                // queued flame candidates (parked ones wait for their chunk); beyond this dropped
export const KEG_DIRECT_FUSE_S = 0.25;              // a keg lit by a fuse, a torch or an igniter goes off this long after
export const MAX_FUSE_SPARK_CELLS = 16;             // the nearest burning fuse cells that emit spark particles each tick
export const MAX_FUSE_PUFFS_PER_TICK = 24;          // burnt-out fuse cells that puff smoke per tick
export const MAX_CIRCUIT_PARTS = 4096;              // configured (non-pristine) parts a world may save
export const MAX_PART_LABEL_CHARS = 24;
export const MAX_CIRCUIT_VISITS_PER_TICK = 6000;    // cell visits per tick, checked between networks
export const CIRCUIT_TICK_BUDGET_MS = 2;            // time per tick (hooks.now), checked between networks
export const MAX_NETWORK_CELLS = 8192;              // a larger network is truncated (the rest read 0 V)
export const MAX_CONTACT_CHANGES_PER_TICK = 1024;   // more slip to the next tick
export const MAX_SETTLE_PASSES = 4;                 // settling passes over contacts a load or reload changes
export const MAX_CIRCUIT_WRITES_PER_TICK = 32;      // burnt-fuse AIR writes per tick; the rest finish next tick
export const MAX_IGNITIONS_PER_TICK = 32;           // ignitions dispatched per tick; the rest wait
export const CIRCUIT_DRAW_RANGE = 64;               // wires and knobs drawn within this of the eye
export const CIRCUIT_OVERLAY_RANGE = 64;            // moving and lit overlays drawn within this (= the wiring's range) …
export const MAX_CIRCUIT_OVERLAYS = 512;            // … at most this many, nearest first
// ---- Black holes v2 (§54; docs/DESIGN-circuits.md §2)
export const BLACK_HOLE_ARM_S = 0.4;                // ARM: the charge is still a block …
export const BLACK_HOLE_FLASH_S = 0.3;              // … FLASH: the cell becomes BLACK_HOLE, a light and a screen flash …
export const BLACK_HOLE_IMPLODE_S = 1.2;            // … IMPLODE: the pull ramps as s², then VORTEX forever
export const BLACK_HOLE_SWIRL = 1.6;                // tangential pull = SWIRL · radial · min(1, ρ / SWIRL_CORE): a ~58° inward spiral
export const BLACK_HOLE_SWIRL_CORE = 1.5;
export const BLACK_HOLE_FLASH_INTENSITY = 220;      // peak of the shared flash PointLight, fading as (1 − u)²
export const BLACK_HOLE_FLASH_COLOR = 0xfff4e6;     // warm white
export const BLACK_HOLE_SCREEN_FLASH_RANGE = 48;    // the white screen flash fades out by this distance …
export const BLACK_HOLE_SCREEN_FLASH_S = 0.6;       // … over this long …
export const BLACK_HOLE_SCREEN_FLASH_MAX = 0.75;    // … at most this bright …
export const BLACK_HOLE_SCREEN_FLASH_GAP_S = 0.5;   // … and starts at most once per this (WCAG 2.3.1: under 3 flashes a second)
export const BLACK_HOLE_PINCH_DEG = 8;              // FOV pinch during IMPLODE …
export const BLACK_HOLE_PINCH_RANGE = 24;           // … fading out by this distance
export const BLACK_HOLE_STRETCH_DEG = 4;            // FOV stretch inside the nearest vortex's pull radius
export const VORTEX_MODEL_RANGE = 128;              // cores and billboards drawn within this …
export const VORTEX_MAX_MODELS = 16;                // … disks, shells and the lensed band only for the nearest this many …
export const VORTEX_MAX_CORES = 256;                // … and at most this many cores and billboards
export const VORTEX_PARTICLES_PER_S = 40;           // streaming particles per vortex …
export const VORTEX_PARTICLE_HOLES = 4;             // … for the nearest this many vortices
export const VORTEX_SPIRAL_K = 3.33;                // dθ/d ln ρ of the inflow: the disk's arms, the particles and infall blocks
export const VORTEX_INFLOW = 1.2;                   // inflow speed: dρ/dt = −VORTEX_INFLOW / √ρ
export const VORTEX_FLOW_RATE = 9;                  // the disk's dash phase advances this many rad/s
export const VORTEX_BILLBOARD = 3.6;                // the shadow / photon-ring / lensed-band quad, world units square
export const VORTEX_CORE_R = 0.3;                   // the black core's radius
export const VORTEX_EVENT_R = 0.45;                 // particles and infall items vanish inside this radius
export const MAX_INFALL_BLOCKS = 96;                // eaten blocks drawn spiralling in; past this the oldest finishes at once
export const MAX_INFALL_MOBS = 8;                   // swallowed pigs / zombies drawn spiralling in
export const INFALL_VIEW_RANGE = 48;                // eaten blocks farther than this from the eye are not drawn
export const INFALL_MIN_S = 0.6;                    // an eaten block's flight time is clamped to MIN … MAX
export const INFALL_MAX_S = 2.4;
export const INFALL_MOB_S = 1.2;                    // a swallowed mob's flight time
// ---- Light (§62): per-cell SKY and BLOCK light levels 0..LIGHT_MAX, carried into the chunk meshes
export const LIGHT_MAX = 15;                        // a level is 0..15; it drops by max(1, opacity) per step (sky: 0 straight down at 15)
export const GLOWSTONE_LIGHT = 15;                  // emitters' levels (block light)
export const CAMPFIRE_LIGHT = 14;
export const TORCH_LIGHT = 13;
export const LEAVES_LIGHT_OPACITY = 1;              // see-through cells that dim light: no free fall of sky light, max(1, o) per step
export const WATER_LIGHT_OPACITY = 1;
export const ICE_LIGHT_OPACITY = 1;
export const LIGHT_CURVE_K = 3;                     // brightness of level l: x / (1 + K·(1 − x)) with x = l / 15 (1 at 15, 0 at 0)
export const LIGHT_FLOOR = 0.08;                    // irradiance that keeps a pitch-dark cave from being pure black (× (1 − sky brightness))
export const BLOCK_LIGHT_COLOR = [1.0, 0.8, 0.56];  // warm sRGB colour of block light …
export const BLOCK_LIGHT_INTENSITY = 2.4;           // … and its irradiance at level 15 (the noon sun is 2, the sky 1.4)
export const BLOCK_LIGHT_DAY_WASH = 0.6;            // block light × (1 − WASH · daylight · sky brightness): a lamp outdoors at noon barely shows
export const LIGHT_VOLUME_QR = 64;                  // moving things sample a 64 × 64 (q, r) × WORLD_HEIGHT light volume around the camera …
export const LIGHT_VOLUME_RECENTRE = 8;             // … re-centred once the camera is this many cells from its centre …
export const LIGHT_VOLUME_MIN_S = 0.25;             // … and refilled at most this often when the light changes
