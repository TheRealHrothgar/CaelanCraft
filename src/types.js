// Caelancraft — shared JSDoc typedefs. This module has no runtime exports.
// Import in JSDoc as: /** @typedef {import('./types.js').MeshData} MeshData */

/** @typedef {number} BlockId   Integer 0..255 stored in a Uint8Array. 0 is AIR. */
/** @typedef {string} ChunkKey  `${cx},${cz}` from coords.chunkKey(). */
/** @typedef {0|1|2|3|4|5|6|7} FaceIndex  0..5 side faces (E, SE, SW, W, NW, NE), 6 top (+Y), 7 bottom (−Y) */
/** @typedef {0|1|2} RenderLayer  0 opaque, 1 cutout (leaves, glass), 2 translucent (water) */
/** @typedef {[number, number, number]} Vec3 */

/**
 * Block lookup over INTEGER hex cell coordinates (axial q, height y, axial r). MUST return AIR (0) for
 * y < 0, y >= WORLD_HEIGHT, or unloaded chunks. Never throws.
 * @typedef {(q: number, y: number, r: number) => BlockId} GetBlockFn
 */

/**
 * @typedef {Object} ChunkData
 * @property {Uint8Array} blocks   length CHUNK_VOLUME, index = coords.localIndex(lq, ly, lr)
 * @property {Uint8Array} biomes   length CHUNK_AREA, index = coords.columnIndex(lq, lr), values = BIOME ids
 * @property {Uint8Array} heights  length CHUNK_AREA, same index; terrain height (y of top solid block, before trees)
 */

/** Returns chunk data or null/undefined when not loaded (treated as all AIR).
 * @typedef {(cq: number, cr: number) => (ChunkData|null|undefined)} GetChunkDataFn */

/**
 * @typedef {Object} MeshData  Triangle list, CCW front faces, chunk-LOCAL positions (relative to hex.chunkOrigin).
 * @property {Float32Array} positions  3 per vertex; x in [-0.5, 24.5], y in [0,128], z in [-0.58, 13.86+0.58]
 * @property {Float32Array} normals    3 per vertex, unit face normals (hex.FACE_NORMALS)
 * @property {Float32Array} uvs        2 per vertex, atlas UVs (flipY = false convention)
 * @property {Float32Array} colors     3 per vertex, 0..1 = tint * FACE_SHADE * AO_CURVE
 * @property {Uint32Array}  indices    6 per side quad, 18 per hexagonal top/bottom face
 * @property {number} vertexCount
 * @property {number} indexCount
 * @property {number} faceCount      faces emitted (sides and hexagons alike)
 */

/**
 * @typedef {Object} ChunkMeshData  A layer is null when it has zero faces.
 * @property {MeshData|null} opaque
 * @property {MeshData|null} cutout
 * @property {MeshData|null} translucent
 */

/**
 * @typedef {Object} RaycastHit
 * @property {number} q  axial q of the hit cell
 * @property {number} y  integer height of the hit cell
 * @property {number} r  axial r of the hit cell
 * @property {FaceIndex|-1} face   face entered; -1 when the ray origin was already inside a hit block
 * @property {number} nx  outward unit normal of the entered face (0,0,0 when face === -1)
 * @property {number} ny
 * @property {number} nz
 * @property {number} distance  along the normalised ray, in blocks (0 when face === -1)
 * @property {BlockId} blockId
 */

/**
 * @typedef {Object} ColumnInfo
 * @property {number} height       terrain height (y of the top solid block before trees)
 * @property {number} biome        BIOME id
 * @property {number} temperature  raw noise -1..1
 * @property {number} humidity     raw noise -1..1
 */

/**
 * @typedef {Object} WorldGen
 * @property {number} seed  normalised uint32
 * @property {(q: number, r: number) => ColumnInfo} getColumn
 * @property {(cq: number, cr: number) => ChunkData} generateChunk
 */

/**
 * @typedef {Object} PlayerState  Position is the bottom-centre of the collision cylinder (feet).
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} vx
 * @property {number} vy
 * @property {number} vz
 * @property {boolean} onGround
 * @property {boolean} flying
 * @property {boolean} sneaking
 * @property {boolean} sprinting
 * @property {boolean} inWater      swimming: the water at the feet is deeper than WADE_DEPTH, or the chest is under a surface (v0.8)
 * @property {boolean} headInWater  eye point is below a water surface
 * @property {boolean} hitWall      horizontal collision happened in the last substep
 * @property {number} [radius]      body footprint radius (mobs; absent = PLAYER_WIDTH / 2), at most MAX_BODY_RADIUS
 * @property {number} [height]      body height (mobs; absent = PLAYER_HEIGHT)
 * @property {number} [mass]        relative mass for body-body pushes (absent = PLAYER_MASS)
 * @property {PlayerState|null} [carrier]   the body this one stood on at the end of last frame (bodies.js, §31)
 * @property {number[]} [carrierAt]  that carrier's feet [x, y, z] then
 * @property {string} [group]       resolveBodies never pairs two bodies of the same group (v0.8 lit barrels)
 */

/**
 * @typedef {Object} PlayerInput
 * @property {number} forward   -1, 0 or 1  (W = +1, S = -1)
 * @property {number} strafe    -1, 0 or 1  (D = +1, A = -1)
 * @property {boolean} jump     Space (fly: ascend)
 * @property {boolean} sneak    Shift (fly: descend)
 * @property {boolean} sprint
 * @property {number} yaw       radians; yaw 0 faces -Z, positive turns left
 * @property {number} [pullX]   optional external acceleration in m/s² (black holes), felt every substep as a drift of
 *                              pull / GROUND_ACCEL in every mode (CONTRACTS §12)
 * @property {number} [pullY]
 * @property {number} [pullZ]
 */

/**
 * @typedef {Object} SkyState  Colours are [r,g,b] floats 0..1 in sRGB.
 * @property {number} time
 * @property {boolean} isDay
 * @property {Vec3} sunDir          unit vector toward the active light (sun by day, moon by night)
 * @property {Vec3} sunColor
 * @property {number} sunIntensity  DirectionalLight intensity (physical units)
 * @property {number} hemiIntensity HemisphereLight intensity
 * @property {Vec3} zenithColor
 * @property {Vec3} horizonColor
 * @property {Vec3} fogColor
 * @property {number} daylight      0..1
 * @property {number} stars         0..1 star opacity
 */

/** @typedef {Record<ChunkKey, number[]>} EditsJSON  flat pairs [localIndex0, id0, localIndex1, id1, ...] */

/**
 * Script and trigger settings of one Rune Block (runes.js). Stored outside the chunk arrays, keyed `${q},${y},${r}`.
 * @typedef {Object} Rune
 * @property {number} q
 * @property {number} y
 * @property {number} r
 * @property {string} key             `${q},${y},${r}`
 * @property {string} script          ≤ MAX_RUNE_SCRIPT_CHARS chars, ≤ MAX_RUNE_SCRIPT_LINES lines
 * @property {string} label           ≤ MAX_RUNE_LABEL_CHARS chars ('' = none)
 * @property {boolean} enabled        master switch for every trigger (default true)
 * @property {boolean} interact       runs on R (default true)
 * @property {boolean} stepOn         runs when the player steps onto it
 * @property {number} stepCooldown    seconds between two step-on firings (anti-bounce), 0..3600
 * @property {boolean} repeat         re-runs every repeatInterval seconds while its chunk is loaded
 * @property {number} repeatInterval  seconds, 0.25..3600
 * @property {boolean} chain          when the script finishes, triggers the rune blocks across all 8 faces
 */

/** Serialised runes: only non-default fields per entry, keys sorted by (q, y, r).
 * @typedef {Record<string, Partial<Rune>>} RunesJSON */

/**
 * @typedef {Object} SaveData
 * @property {2} version
 * @property {number} seed
 * @property {number} time            0..1 day fraction
 * @property {number} day
 * @property {{x:number, y:number, z:number, yaw:number, pitch:number, flying:boolean}} player
 * @property {number[]} hotbar        length 9, BlockIds
 * @property {number} selected        0..8
 * @property {EditsJSON} edits
 * @property {RunesJSON} [runes]      optional; absent/empty when the world has no customised rune blocks
 * @property {Object[]} [pigs]        optional (v0.5); absent = the world never had pigs
 * @property {{falling:boolean, water:boolean, collapse:boolean, explosions:boolean}} [physics]
 *   optional (v0.8) block-physics switches; absent = saved before v0.8 (main starts it with collapse off)
 */

/**
 * @typedef {Object} SmokeResult
 * @property {boolean} done
 * @property {boolean} ok
 * @property {number} frames
 * @property {number} chunksLoaded
 * @property {number} drawCalls
 * @property {boolean} playerGrounded
 * @property {boolean} breakPlaceRoundTrip
 * @property {string} webgl
 * @property {string[]} errors
 * @property {string[]} steps
 */

/**
 * @typedef {Object} GameContext  Handed to diagnostics by main.js.
 * @property {import('./world.js').World} world
 * @property {PlayerState} player
 * @property {*} controls
 * @property {*} renderer
 * @property {*} hud
 * @property {() => number} getTime
 * @property {(t: number) => void} setTime
 * @property {() => (RaycastHit|null)} getHit
 * @property {() => boolean} breakTargeted
 * @property {() => boolean} placeSelected
 * @property {(x: number, y: number, z: number) => void} teleport
 * @property {(yaw: number, pitch: number) => void} setLook
 * @property {() => string} getState
 * @property {(dt: number) => void} [stepFrame]  one simulation + render step (used when rAF is unavailable/starved)
 * @property {(line: string) => ({ ok: boolean, message: string }|null)} [runCommand]  execute one console line (null before a world exists)
 * @property {import('./runes.js').RuneStore} [runes]
 * @property {import('./runes.js').RuneRunner|null} [runner]
 */

export {};
