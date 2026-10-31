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

// Time / saving / UI
export const DAY_LENGTH_SECONDS = 600;
export const START_TIME = 0.30;                     // 07:12
export const AUTOSAVE_INTERVAL_S = 30;
export const HOTBAR_SIZE = 9;
