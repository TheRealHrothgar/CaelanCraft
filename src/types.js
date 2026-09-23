// Caelancraft — shared JSDoc typedefs. This module has no runtime exports.
// Import in JSDoc as: /** @typedef {import('./types.js').MeshData} MeshData */

/** @typedef {number} BlockId   Integer 0..255 stored in a Uint8Array. 0 is AIR. */
/** @typedef {string} ChunkKey  `${cx},${cz}` from coords.chunkKey(). */
/** @typedef {0|1|2|3|4|5} FaceIndex  0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z */
/** @typedef {0|1|2} RenderLayer  0 opaque, 1 cutout (leaves, glass), 2 translucent (water) */
/** @typedef {[number, number, number]} Vec3 */

/**
 * Block lookup over INTEGER world block coordinates. MUST return AIR (0) for
 * wy < 0, wy >= WORLD_HEIGHT, or unloaded chunks. Never throws.
 * @typedef {(wx: number, wy: number, wz: number) => BlockId} GetBlockFn
 */

/**
 * @typedef {Object} ChunkData
 * @property {Uint8Array} blocks   length CHUNK_VOLUME, index = coords.localIndex(lx, ly, lz)
 * @property {Uint8Array} biomes   length CHUNK_AREA, index = coords.columnIndex(lx, lz), values = BIOME ids
 * @property {Uint8Array} heights  length CHUNK_AREA, same index; terrain height (y of top solid block, before trees)
 */

/** Returns chunk data or null/undefined when not loaded (treated as all AIR).
 * @typedef {(cx: number, cz: number) => (ChunkData|null|undefined)} GetChunkDataFn */

/**
 * @typedef {Object} MeshData  Triangle list, CCW front faces, chunk-LOCAL positions.
 * @property {Float32Array} positions  3 per vertex; x in [0,16], y in [0,128], z in [0,16]
 * @property {Float32Array} normals    3 per vertex, axis-aligned unit normals
 * @property {Float32Array} uvs        2 per vertex, atlas UVs (flipY = false convention)
 * @property {Float32Array} colors     3 per vertex, 0..1 = FACE_SHADE * AO_CURVE
 * @property {Uint32Array}  indices    6 per quad
 * @property {number} vertexCount
 * @property {number} faceCount
 */

/**
 * @typedef {Object} ChunkMeshData  A layer is null when it has zero faces.
 * @property {MeshData|null} opaque
 * @property {MeshData|null} cutout
 * @property {MeshData|null} translucent
 */

/**
 * @typedef {Object} RaycastHit
 * @property {number} x  integer block x of the hit block
 * @property {number} y
 * @property {number} z
 * @property {FaceIndex|-1} face   face entered; -1 when the ray origin was already inside a hit block
 * @property {number} nx  face normal (0,0,0 when face === -1)
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
 * @property {(wx: number, wz: number) => ColumnInfo} getColumn
 * @property {(cx: number, cz: number) => ChunkData} generateChunk
 */

/**
 * @typedef {Object} PlayerState  Position is the bottom-centre of the AABB (feet).
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
 * @property {boolean} inWater      feet or chest cell is liquid
 * @property {boolean} headInWater  eye point is below a water surface
 * @property {boolean} hitWall      horizontal collision happened in the last substep
 */

/**
 * @typedef {Object} PlayerInput
 * @property {number} forward   -1, 0 or 1  (W = +1, S = -1)
 * @property {number} strafe    -1, 0 or 1  (D = +1, A = -1)
 * @property {boolean} jump     Space (fly: ascend)
 * @property {boolean} sneak    Shift (fly: descend)
 * @property {boolean} sprint
 * @property {number} yaw       radians; yaw 0 faces -Z, positive turns left
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
 * @typedef {Object} SaveData
 * @property {1} version
 * @property {number} seed
 * @property {number} time            0..1 day fraction
 * @property {number} day
 * @property {{x:number, y:number, z:number, yaw:number, pitch:number, flying:boolean}} player
 * @property {number[]} hotbar        length 9, BlockIds
 * @property {number} selected        0..8
 * @property {EditsJSON} edits
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
 */

export {};
