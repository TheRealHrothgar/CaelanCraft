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
 * @property {Uint8Array}   [light]    2 per vertex (§62): sky level · 17, block level · 17 (0..255, normalised in the shader);
 *                                     the mesher always writes it, hand-made MeshData may leave it out (read as open sky)
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
 * @property {number} [landSpeed]   (v0.9 survival, DESIGN-survival §9.3) the fastest downward speed (m/s, ≥ 0) at which the body
 *                                  landed during the last stepPlayer (0 without a landing); survival.step reads it, then sets it to 0
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
 * @property {boolean} [noExitJump]  in water, jump paddles up (SWIM_UP_SPEED) but never gives SWIM_EXIT_JUMP at a wall
 * @property {number} [speedFactor]  (v0.9 survival) multiplies the horizontal target speed when not flying, clamped to 0..1;
 *                              absent = 1 (main sets survival.status.moveFactor while Survival is active)
 */

/**
 * @typedef {Object} SkyState  Colours are [r,g,b] floats 0..1 in sRGB.
 * @property {number} time
 * @property {number} solar  v0.11 (§68): solar time — sunrise 0.25, sunset 0.75 — the sky and the stars run on
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

// ---- Survival (docs/DESIGN-survival.md §5, §9.6; CONTRACTS §42–§49 once merged) ----

/**
 * One pack, basket or belongings slot's contents (§5.2). Items with a durability never stack (n = 1); two stacks merge only
 * when they have the same key, no `d`, and the stack size allows.
 * @typedef {Object} ItemStack
 * @property {string} k   item key (items.js)
 * @property {number} n   count, an integer 1..stackSize(k)
 * @property {number} [d] durability left, an integer 1..maxDurability(k); absent = new (full). Only on items with a durability.
 */

/**
 * @typedef {Object} ToolDef
 * @property {string} type        one of items.TOOL_TYPES ('hammer', 'axe', 'shovel', 'knife', 'pick', 'spear', 'sword',
 *                                'firestarter', 'crucible', 'mold')
 * @property {number} tier        0..6, index into items.TIER_NAMES / TIER_SPEED
 * @property {number} durability  uses when new
 * @property {number} power       damage one hit deals a mob
 */

/**
 * What eating or drinking one item does (§4.5).
 * @typedef {Object} FoodDef
 * @property {number} satiation   added to satiation (shown as Nourishment); may be negative
 * @property {number} hydration   added to hydration; may be negative (salty or dry food)
 * @property {number} sick        chance 0..1 of falling Sick
 * @property {number} useS        seconds RMB is held to eat or drink one
 * @property {number} [temp]      instant change of body temperature, °C (snow −0.2)
 * @property {string} [returns]   item key given back after use (the clay pot)
 * @property {number} [spoilS]    mean seconds per item before it goes bad; absent = never spoils
 * @property {string} [spoilsTo]  v0.14 (§76 water): the item key a spoiled one turns INTO (a Pot of Water → a Pot of Tainted
 *                                Water); absent = a spoiled item is lost
 */

/**
 * A worn item (§3.2, §5.3).
 * @typedef {Object} WearDef
 * @property {'head'|'body'|'feet'} slot   one of items.WEAR_SLOT_NAMES
 * @property {number} insulation  I, in °C of felt temperature
 * @property {number} sunShade    0..1: the share of the sun term the item shades (the largest worn value counts)
 */

/**
 * One item of the registry (items.js). Exactly the field of its kind is present: `block` (kind 'block'), `tool`, `food`,
 * `heal` or `wear`.
 * @typedef {Object} ItemDef
 * @property {string} key       unique lower_snake key; saves store keys, never numbers
 * @property {string} name      display name
 * @property {'block'|'material'|'food'|'heal'|'wear'|'tool'} kind
 * @property {number} stack     stack size: 64 for block items, 1 for tools and clothes
 * @property {number} [block]   block id the item places (the bush items place their picked variant)
 * @property {ToolDef} [tool]
 * @property {FoodDef} [food]
 * @property {{hp: number, rate: number, useS: number}} [heal]   bandage: HP queued, paid out at rate HP/s; useS to apply
 * @property {WearDef} [wear]
 * @property {string[]} [tags]  the items.TAGS this item belongs to
 */

/**
 * Fire spots and fuel of every tracked campfire / fire pit (cooking.js FireSlots; §4.4, §9.6), keyed `"q,y,r"`. `s` has
 * FIRE_SPOTS (7) entries: 0..5 the skewers, 6 the embers; `t` is the seconds the item has cooked. `f` is the fuel left in
 * seconds (0..CAMPFIRE_FUEL_MAX_S); absent = the fire burns forever. An entry with no items and no `f` is not written.
 * @typedef {Record<string, { s: ({ k: string, t: number }|null)[], f?: number }>} FireSlotsJSON
 */

/**
 * The frozen or live survival state (§1.4, §9.6), canonical key order as listed; numbers rounded to 3 decimal places.
 * @typedef {Object} SurvivalJSON
 * @property {number} health      0..100
 * @property {number} satiation   0..100 (shown as Nourishment)
 * @property {number} hydration   0..100
 * @property {number} temp        body temperature, 25..45 °C
 * @property {number} breath      0..20 s
 * @property {number} wet         0..1
 * @property {number} sick        seconds of sickness left, 0..600
 * @property {number} heal        pending bandage healing, 0..50 HP
 * @property {number} healRate    its payout rate, 0..5 HP/s
 * @property {[number, number, number]|null} spawn   the Sleeping Hide cell [q, y, r] to wake at, or null
 * @property {number} deaths      an integer ≥ 0
 * @property {string} [dead]      the cause of death while the death screen is up (§2.4 cause keys); absent = alive
 * @property {(ItemStack|null)[]} pack   PACK_SLOTS (27) entries
 * @property {(ItemStack|null)[]} wear   WEAR_SLOTS (3) entries: head, body, feet
 * @property {FireSlotsJSON} fires
 * @property {{ k: string, n: number, d?: number, a?: number, x: number, y: number, z: number }[]} [loose]  v0.10 (CONTRACTS §60, §63) the items lying
 *   loose in the world; absent = none
 */

/**
 * Wicker baskets and belongings (containers.js; §5.6, §9.6), keyed `"q,y,r"`. `slots` holds at most BASKET_SLOTS (basket)
 * or REMAINS_SLOTS (remains) entries.
 * @typedef {Record<string, { kind: 'basket'|'remains', slots: (ItemStack|null)[] }>} ContainersJSON
 */

/**
 * @typedef {Object} SaveData
 * @property {2|3} version            3 when `gen` ≥ 2 or `survival` is present (v0.9, DESIGN-survival §1.4), else 2
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
 * @property {boolean} [zombies]       optional (§39) the world's zombies switch; absent = on
 * @property {boolean} [watcher]       optional (§40) the world's Hollow Watcher switch; absent = on
 * @property {number} [watcherNight]  optional (§40.1) the night (watcher.nightKey) of the world's last natural Watcher
 *   sighting, a whole number ≥ 0; absent = none yet (or a save from before the field)
 * @property {number} [gen]           optional (v0.9) the world generator version, an integer ≥ 2 (≤ GEN_LATEST); absent = 1,
 *   today's terrain
 * @property {'creative'|'survival'} [mode]   optional (v0.9) written once the world has a survival state; absent = creative
 * @property {SurvivalJSON} [survival]        optional (v0.9) the frozen or live survival state; absent = never in Survival
 * @property {ContainersJSON} [containers]    optional (v0.9) baskets and belongings; absent = none
 * @property {boolean} [blackholes]   optional (DESIGN-circuits §6.4) the world's black-holes switch; anything but false = on
 * @property {boolean} [circuits]     optional (DESIGN-circuits §6.4) the world's circuits switch; anything but false = on
 * @property {CircuitPartsJSON} [circuitParts]  optional (DESIGN-circuits §6.4) configured circuit parts; absent = none
 * @property {{name?: string, createdAt?: number, lastPlayed?: number}} [meta]
 *   optional (§41) the save slot's world name and times (ms since the epoch); storage.loadSlot always fills all three
 */

// ---- Powder, circuits and black holes v2 (docs/DESIGN-circuits.md §6; CONTRACTS §50–§58 once merged) ----

/**
 * One row of the circuit part table (circuitParts.PARTS, DESIGN-circuits §4.2). `wire`, `volts`, `vMin` and `amps` are
 * present only on the parts they describe.
 * @typedef {Object} PartDef
 * @property {number} id        the block id
 * @property {string} key       stable save string: the store kind `k` (§4.8)
 * @property {'wire'|'junction'|'source'|'contact'|'load'|'fuse'|'flame'|'ignitable'} role
 * @property {string} [wire]    'copper', 'brown', 'white' or 'earth' (wires only)
 * @property {number} [volts]   a source's output (a selenium panel's in full sun)
 * @property {number} [vMin]    a load's (or input's) minimum voltage
 * @property {number} [amps]    a load's (or input's) current: both its share of the wire drop and its battery drain (§4.4)
 * @property {boolean} input    has one input face (relay coil, timer start, coherer tapper), which is never a contact terminal
 * @property {boolean} earth    needs earth to work: sources, loads and inputs
 * @property {boolean} control  right-click operates it (§4.9)
 * @property {readonly string[]} fields  the store fields saved for it, in JSON order (§4.8); [] = no store entry
 * @property {string} origin    the real thing, one line
 * @property {string} tip       the teaching line (§4.13), at most 240 characters
 */

/**
 * The settings and saved state of one configured circuit part (circuitStore.js, DESIGN-circuits §4.8). Only the fields of its
 * kind are present; `k` is always its PartDef.key.
 * @typedef {Object} PartState
 * @property {string} key       `"q,y,r"`
 * @property {number} q
 * @property {number} y
 * @property {number} r
 * @property {string} k         the part's kind (PartDef.key)
 * @property {string} l         label, '' = none (≤ MAX_PART_LABEL_CHARS)
 * @property {boolean} [on]     switch closed / timer hold latched / receiver latched closed
 * @property {boolean} [nc]     normally closed (push button, relay)
 * @property {number} [f]       input face 0..6 (timer, relay, receiver)
 * @property {number} [s]       timer delay, TIMER_MIN_S..TIMER_MAX_S in 0.5 s steps
 * @property {string} [m]       timer 'pulse'|'hold'|'repeat'; receiver 'pulse'|'latch'
 * @property {boolean} [run]    a repeat timer is running
 * @property {number} [ch]      radio channel 1..RADIO_CHANNELS
 * @property {number} [c]       battery charge, amp-seconds 0..BATTERY_CAPACITY
 */

/**
 * Saved circuit parts (DESIGN-circuits §6.4): canonical `"q,y,r"` keys; each entry holds `k` and then its non-default fields
 * only, in the order k, l, on, nc, f, s, m, run, ch, c. `s` is rounded to 0.5 steps, `c` to an integer.
 * @typedef {Record<string, { k: string, l?: string, on?: boolean, nc?: boolean, f?: number, s?: number, m?: string,
 *   run?: boolean, ch?: number, c?: number }>} CircuitPartsJSON
 */

/**
 * One moving or lit bit of a circuit part, drawn by circuitRenderer (circuits.overlays, DESIGN-circuits §4.11).
 * @typedef {Object} OverlayItem
 * @property {'blade'|'cap'|'hand'|'arm'|'plunger'|'hammer'|'bulb'|'glow'|'staff'} type
 * @property {number} q
 * @property {number} y
 * @property {number} r
 * @property {number} a         the type's first parameter (an angle, a travel, a brightness, …)
 * @property {number} b         its second parameter
 * @property {'lamp'|'igniter'|'ember'|'spark'|'coherer'|'charge'|'fuse'} [glow]   which glow (type 'glow')
 * @property {'torch'|'filament'|'char'} [staff]   which thin boxes (type 'staff'; the design's 'linstock', renamed with the
 *                                  part: DESIGN-circuits' user-decision note)
 */

/**
 * A black-hole event (blackholes.drainEvents, DESIGN-circuits §6.2.4): a phase change of one hole, with its centre.
 * @typedef {Object} BlackHoleEvent
 * @property {'arm'|'flash'|'implode'|'formed'|'collapsed'|'cancelled'} type
 * @property {number} q
 * @property {number} y
 * @property {number} r
 * @property {number} cx        centre, world units
 * @property {number} cy
 * @property {number} cz
 */

/**
 * One hole as vortexRenderer draws it (blackholes.vortexViews, DESIGN-circuits §6.2.4), nearest first.
 * @typedef {Object} VortexView
 * @property {number} cx
 * @property {number} cy
 * @property {number} cz
 * @property {number} phase     blackholes.PHASE: 0 ARM, 1 FLASH, 2 IMPLODE, 3 VORTEX
 * @property {number} s         progress through the phase, 0..1
 * @property {number} strength  1, or 0.2 for an inert hole or while black holes are switched off
 * @property {number} seed      0..1, a hash of the cell key
 * @property {number} age       seconds since arming began (Infinity for a hole loaded as a vortex)
 * @property {boolean} full     among the nearest maxFull: drawn with its disk, shell and lensed band
 */

/**
 * What the device panel shows for one part (circuits.panelView, DESIGN-circuits §4.10, §6.2.15).
 * @typedef {Object} DevicePanelView
 * @property {string} key       `"q,y,r"`
 * @property {string} k         the part's kind (PartDef.key)
 * @property {number} id        the block id
 * @property {string} title     the part's display name
 * @property {string} coords    the cell, as printed
 * @property {string} label
 * @property {string[]} readout  live lines: volts, current, earth, diagnostic, state
 * @property {{ s?: number, m?: string, f?: number, nc?: boolean, ch?: number, on?: boolean, c?: number }} fields
 * @property {('start'|'stop'|'send'|'tap'|'refill')[]} actions
 * @property {string} origin    the real thing (PartDef.origin)
 * @property {string} about     the tip (PartDef.tip)
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
 * @property {import('./blockphysics.js').BlockPhysics|null} [physics]  v0.8 block physics (null before a world exists)
 * @property {import('./zombies.js').Zombies} [zombies]
 * @property {import('./watcher.js').Watcher} [watcher]
 * v0.9 Survival (CONTRACTS §49; DESIGN-survival §9.5 / §9.10): the live objects, and one-frame drivers for the smoke test.
 * @property {import('./survival.js').Survival} [survival]  the mode and the vitals (one per session)
 * @property {import('./inventory.js').Pack} [pack]           the Survival pack (one per session; reloaded from every save)
 * @property {(mode: 'creative'|'survival') => void} [setMode]  queue a mode switch (applied at the top of the next frame)
 * @property {() => ('creative'|'survival')} [getMode]
 * @property {'creative'|'survival'|null} [urlMode]  `?mode=` as the page was opened with (null when absent or consumed)
 * @property {(i: number) => void} [selectSlot]      select hotbar slot 0–8
 * @property {() => void} [interact]                 one press of R on the current target (both modes)
 * @property {(dt: number) => (object|null)} [digTargeted]  one frame of holding LMB on the target in Survival (the real dig path)
 * @property {(dt: number) => ({ progress: number|null }|null)} [useSelected]  one frame of holding RMB with the selected item in Survival
 * v0.10 circuits and black holes (CONTRACTS §58; DESIGN-circuits §6.6–§6.7): the live objects, drivers and the scenes.
 * @property {import('./circuits.js').Circuits|null} [circuits]  the world's circuit engine (null before a world exists)
 * @property {import('./circuitStore.js').CircuitStore} [circuitStore]  the configured parts (one per session)
 * @property {import('./blackholes.js').BlackHoles} [blackHoles]
 * @property {import('./infall.js').Infall} [infall]  eaten blocks and swallowed mobs spiralling in
 * @property {(pressed: boolean, dt?: number) => (string|null)} [rightClick]  one frame of right-click on the target (the latch)
 * @property {() => void} [rightRelease]             let go of the right mouse button
 * @property {() => void} [editTarget]               the Shift+R key on the target: the device panel or the rune editor
 * @property {(q: number, y: number, r: number) => void} [openDevicePanel]
 * @property {() => void} [closeDevicePanel]
 * @property {'vortex'|'circuits'|null} [urlScene]  `?scene=` as the page was opened with
 * @property {(name: string, delay?: number) => { ok: boolean, message: string, named?: Record<string, number[]> }} [buildScene]
 * @property {Record<string, number[]>|null} [sceneCells]  the named cells of the last scene built
 * @property {() => number} [circuitSegments]       wire segments drawn (the F3 circuits line)
 */

export {};
