# Caelancraft block physics — design v2 (v0.8)

v1 was critiqued by three independent reviewers who measured it against the real code (scripts under the session
scratchpad `review-measure/`, `review-perf/`, `review-gameplay/`). v2 adopts their fixes; the reason for each non-obvious
rule is given in *italics*. When built, the normative parts move into `src/CONTRACTS.md` §33–§37.

Grid: pointy-top hexagonal prisms (q, y, r); a cell has 8 neighbours (6 sides `HEX_DIRS` + above + below). Features the
user asked for: **falling sand & gravel**, **falling trees**, **flowing water**, **collapsing structures**, **explosives**.

=====================================================================================================================
## 0. Ids, flags and constants

Blocks (appended; v2 saves keep their ids): `WATER_FLOW_1 … WATER_FLOW_6` = 68…73, `WATER_FALL` = 74,
`BLAST_BARREL` = 75 → `BLOCK_COUNT = 76`. Tiles: `BARREL_SIDE` = 75, `BARREL_TOP` = 76.
- Water family (WATER 7, FLOW_1..6, FALL): `liquid: true, solid: false, opaque: false, layer TRANSLUCENT, breakable:
  false`; FLOW/FALL `placeable: false` (picker keeps WATER only), tiles = WATER. `waterLevel(id)`: WATER → 7 (source),
  FALL → 7, FLOW_k → k, otherwise 0. `isWater(id)`, `isWaterSource(id)` (WATER only).
  *Reach 6 gives a 127-cell hexagonal puddle (reach 7 would be 169, wider than squares' 113).*
- `BlockDef.gravity`: SAND, RED_SAND, GRAVEL.
- BLAST_BARREL "Blast Barrel": solid, opaque, placeable, breakable, sound wood, tiles side/top (staves, two dark iron
  bands, a red hazard hexagon; lid with a short fuse). Original look — this is not a Minecraft copy.
- `UNLOADED = 255` sentinel returned by `World.peekBlock` for cells in unloaded chunks (255 is never a block id).

All tunables live in `config.js` under "Block physics (CONTRACTS §33–§37)"; numbers below are the defaults.

=====================================================================================================================
## 1. World changes (`world.js`)

1. **Edit pruning + running count.** `world.origins: Map<chunkKey, Map<localIndex, originalId>>`. `setBlock` records the
   cell's pre-edit id the first time it is edited (the `prev` it already reads); when a later write sets the cell back
   to its origin, the edit (and origin) is deleted. `_generate` records origins for imported edits (the generated id
   before the saved id is applied). `world.editCount` is an O(1) running count of edit entries (replace the loop).
   *Drained water and refilled holes then cost nothing in the save; the save stops growing without bound.*
2. **Lazy re-meshing.** `setBlock(q, y, r, id, lazy = false)`. A lazy write marks the affected chunks dirty with
   `chunk.lazy = true` unless they are already dirty non-lazily (non-lazy always wins). `update()` step 2 re-meshes
   non-lazy dirty chunks at once (unchanged behaviour for player edits, commands, runes); then lazy dirty chunks,
   nearest to the player first, until `LAZY_MESH_BUDGET_MS = 4` has elapsed — always at least one per update.
   Physics, black holes and explosions write lazily. *A chunk re-mesh costs 3–9 ms p50 (13–30 ms p90); world.update
   re-meshing every dirty chunk every frame is the real frame-time hazard, not the number of writes.*
3. **`onChunkGenerated(cq, cr)`** assignable hook, fired at the end of `_generate` (after saved edits are applied).
4. **`isNaturalGround(q, y, r)`**: chunk loaded, the cell has no edit, `y ≤ chunk.heights[column]`, and the block is
   solid. *Untouched terrain is never collapsed, so a support search ends as soon as it touches natural ground: checks
   cost the size of the build, not of the terrain (FIFO BFS on terrain hit its cap on ~100% of removals).*
5. **`peekBlock(q, y, r)`**: like getBlock but returns UNLOADED for cells in unloaded chunks (AIR above/below the world).

=====================================================================================================================
## 2. Scheduler core (`src/blockphysics.js`, PURE)

`new BlockPhysics(world, hooks)`; main owns one per world.
- **Tick.** Fixed `PHYSICS_TICK_S = 0.05`; `step(dt)` runs **at most one** tick per frame (below 20 fps physics runs in
  slow motion instead of doubling its load) and drops leftover time beyond one tick.
- **Queues.** One FIFO ring per delay class — `fall` (1 tick), `water` (`WATER_TICKS = 5`), `misc` (1 tick) — of
  numerically packed cell keys (`packCell(q, y, r)`: q, r offset into 21 bits each, y in 7 bits; one double, like
  world.js `packId`) with a `Map<packed, dueTick>` for dedupe. Each ring is sorted by construction: pop from the head
  while `due ≤ now` and the tick's budget lasts; leftovers simply stay at the head (no re-bucketing).
- **Budgets per tick.** Time: `PHYSICS_TICK_BUDGET_MS = 3` (checked every 32 updates / 256 search visits);
  count backstop `MAX_CELL_UPDATES_PER_TICK = 256`; support search `MAX_SUPPORT_VISITS_PER_TICK = 8192`.
  *(Review pass, §10.10: the clock is also read after any update that wrote ≥ 32 cells, the rings share the budget fairly,
  and every part of the support work — not just its DFS — stops on the deadline.)*
- **Writes.** Rules write through `ctx.write(q, y, r, id)` → `'ok' | 'failed' | 'capped'`: a lazy `world.setBlock`;
  `'capped'` when the write would add a NEW edit entry while `world.editCount ≥ MAX_TOTAL_EDITS` (physics pauses
  water spreading and explosions stop breaking blocks; one chat line via `hooks.say`). *No chunk cap: lazy meshing
  bounds frame cost; the old per-tick chunk cap refused chunk-corner cells forever.*
- **Unloaded neighbours.** Rules read through `world.peekBlock`. An update that sees UNLOADED in a cell it needs is
  **parked** under that chunk key (not dropped); `onChunkGenerated` re-queues parked updates for that chunk and
  re-seeds the chunk's edited physics-active cells (non-source water and their neighbours, gravity blocks with a
  fall-through cell below, barrels next to a campfire). *Physics must survive streaming and reloads.*
- **Triggers** (`onBlockChange(q, y, r, prev, next)`, forwarded by main for every change from any source):
  - the cell **above** a cell that became fall-through → `fall` ring (gravity blocks drop, campfires break);
  - a gravity block placed over a fall-through cell → `fall` ring;
  - water involved (prev or next is water, or the cell became fall-through/solid next to water) → the cell and its
    water/air neighbours → `water` ring (`WATER_FALL` columns use the `fall` ring: they move 1 cell per tick);
  - a campfire or barrel placed next to the other → `misc` ring (ignition);
  - a **support seed** (§5) when a load-bearing cell was removed, unless the write came from physics' own crumble /
    topple / explosion (those queue one boundary search themselves) or from an area command (seeds are collected and
    searched once when the runner has no active area jobs — `hooks.areaJobsActive()`).
- **Feature switches** (saved per world, §8): `falling`, `water`, `collapse`, `explosions`; plus `paused` (console
  `physics off`). A disabled feature *drops* its triggers instead of queueing them, so switching it back on never
  collapses or floods anything after the fact.

=====================================================================================================================
## 3. Falling blocks (`src/fallingblocks.js`, PURE) and rendering

**Gravity rule** (`fall` ring): a gravity block over a fall-through cell (AIR, non-source water, FALL/FLOW, CAMPFIRE —
*not* UNLOADED) is removed and becomes a faller; the cell above is triggered so a sand column drops together. A
CAMPFIRE over a fall-through cell breaks (smoke puff). *v1 left campfires hanging.*

**Column fallers** (sand, gravel, crumble pieces, settling logs): typed arrays (id, q, r, y, vy); per frame
`vy += GRAVITY·dt` (≥ TERMINAL_VELOCITY), then a **swept** step down the column checking every cell between the old and
new bottom — exact because radius 0.45 < HEX_INRADIUS. Land on the first non-fall-through cell. `MAX_FALLING = 1024`
(beyond → settle instantly). y < 0 → removed. *displaceBody costs 13 ms for 1024 entities and tunnels at low fps; the
column integrator costs 0.18 ms and cannot tunnel.*

**Tumbling entities** (explosion debris, lit barrels): bodies (`createBody`, radius 0.45, height 0.98) moved with
`displaceBody` in substeps of |Δ| ≤ 0.9, air drag `0.98^(60·dt)`; `MAX_TUMBLING = 64` (extra debris becomes dust).
Debris vanishes in a dust puff when it lands (*no litter*); lit barrels never "land" (they rest as bodies until the fuse
ends — *v1 silently defused them*).

**Landing a column faller** into cell C (non-fall-through below):
- C intersects the player or a pig → lift that body with `findFreeY(…, floor(y)+1, 3, its size)`; if there is no room,
  **break** the block (dust) instead of placing it. *Otherwise stepPlayer shoves an entombed player up through rock at 2
  cells per frame.*
- otherwise `ctx.write(C, id)` (a liquid or campfire there is crushed); `'capped'`/`'failed'` → break with dust.
- `audio.playThud` (one per frame, nearest), dust particles.

**Saving never mutates the live world.** `fallers.settleInto(editsCopy, peek)` writes each faller's landing cell (a
column drop over an overlay of the copy) into the exported edits; lit barrels are saved as BLAST_BARREL at their cell;
toppling trees save their logs dropped from their current pose. The live simulation keeps running.

**Rendering** (`src/fallingRenderer.js`, three): `InstancedMesh` per (block id, layer) from `mesher.buildCellMesh(id)`
(exists) with chunk-style materials on the atlas texture; capacity doubles; `frustumCulled = false` (*an InstancedMesh's
bounding sphere is computed once and goes stale*). One API for every moving cell: `sync(items)` where an item is
`{ id, x, y, z, rx, ry, rz }` (centre + rotation). Lit barrels pulse (scale 1 ± 0.04 at 4 Hz, faster near the end).
**Particles** (`src/particles.js`, three): ONE `THREE.Points` system, capacity 2048, oldest overwritten — dust (block's
average colour), leaves, smoke, sparks; one draw call whatever the load.

=====================================================================================================================
## 4. Flowing water (`src/fluids.js`, PURE rule called by the scheduler)

Definitions: `E(id)` effective level = 7 for WATER, k for FLOW_k, and for FALL the level of the water pouring in at the top
of its column (7 under a source, k under FLOW_k). *Spreads-sideways(n)* ⇔ n is water and the cell below n is **solid, or a
WATER source** (never over FALL/FLOW/AIR). *This one predicate is the v1 blocker fix: v1 let every mid-column fall cell
spread, and one source on a 10-high plateau filled 9,673 cells instead of 637.* *A fall keeping its level is the slope fix
(v0.8 review): with E(FALL) = 7 every 1-high step restarted a full disc, and one source on a hillside wet 4–10k cells down
to the sea; now a stream loses a level per cell of sideways travel and stops within 6 cells of its source (148 cells on
seed 7's hilltop), while a source poured over a drop still lands at full strength.*

Update of a water-family cell W, or of an AIR/CAMPFIRE cell next to water (`water` ring; FALL cells via `fall`):
1. **Source** (WATER): never changes by itself.
2. **Falling:** if the cell above is water → W should be FALL.
3. **Fed level:** otherwise `L' = max(E(n) − 1)` over side neighbours n that *spread sideways*; `L' ≤ 0` → AIR.
   (So every level is exactly what its feeders would write; removing a source drains its flow in ≤ 6 steps.)
4. **Infinite source:** a FLOW cell with **≥ 3** WATER side-neighbours and solid-or-WATER below becomes WATER.
   *With ≥ 2, two adjacent sources on a hex grid filled a radius-40 disc (two sources share two neighbours).*
   A FLOW / FALL cell that was generated as WATER becomes WATER too (natural water heals; the save does the same).
   *With only the ≥ 3 rule a drained patch of sea over an uneven seabed stalled: the surface ring stood on FALL, the bottom
   ring touched sand — a permanent crater that a reload filled in.*
5. Write the new state if it differs (`ctx.write`, lazy). Neighbours re-trigger through onBlockChange.
6. **Downward:** a water cell whose below is AIR/CAMPFIRE/FLOW writes FALL below (a FALL below a FALL is a no-op).
Water entering a campfire cell puts it out (hiss + steam particles). Lit barrels touching water go out (§7).

**Wading vs swimming** (physics.js): the water surface of a cell is `y + h(id, above)` with h = 1 if water is above,
0.875 for WATER/FALL otherwise, `k/7 · 0.875` for FLOW_k. A body is `inWater` only when the surface in its feet column is
above `feet + 0.4` or its chest cell is water; `headInWater` uses the same surface. Shallower water is wading: speed ×0.85,
no swim mode. Pigs avoid only water they would swim in. *A level-1 film made the whole yard a slow-swim zone.*
**Currents:** bodies in FLOW cells get `WATER_CURRENT = 6 m/s²` toward the lowest-level side neighbour (down in FALL),
summed into the existing `pullX/Y/Z` input (pigs through `pigWorld.pullAt`).

**Mesher:** surfaces per the h() above. Top faces of liquids with topY < 1 are always emitted (even under a solid —
*v1 showed no surface in low caves*). Between two water cells: no top/bottom faces; a side face only for the part of the
higher surface above the lower one (`emitSide` gains `bottomY`). Same-family culling uses `isWater` on both sides.
(Smooth per-corner heights and scrolling flow UVs are a follow-up, not v0.8.)

**Taking water away:** while WATER is the selected hotbar block, the crosshair ray also hits water and left-click removes
a WATER source (the flow drains by itself); console/rune `drain [radius ≤ 16]` sets every water cell in range to AIR.

**Saving:** FLOW_k and FALL are not saved: `exportEdits` copies map them to AIR, or drop the edit when the cell's origin
is AIR; on load the re-seed hook resumes flow from the sources. *A cave breach otherwise writes tens of thousands of
permanent edits.*

=====================================================================================================================
## 5. Collapsing structures (`src/support.js`, PURE)

**Load-bearing** = solid and not leaves (leaves never carry load — §6), including gravity blocks *resting* in place.
**Anchors** = `world.isNaturalGround`, BEDROCK, y = 0. **Self-anchored, non-bearing**: RUNE_BLOCK, BLACK_HOLE (they never
fall — rune scripts would be lost — but they hold nothing up). CAMPFIRE, liquids, AIR: not load-bearing.

**Seeds.** Removing a load-bearing cell C (from any source except physics' own batched removals and area jobs, see §2)
seeds its load-bearing neighbours. Seeds are deduped (numeric keys) and a seed that is no longer load-bearing is skipped.
Player-caused seeds go to a priority lane.

**Search.** All seeds of a tick run as ONE multi-source search with a shared memo: a **lowest-y-first** DFS (pop the
neighbour below first, then sides, then above) over load-bearing cells. A search *succeeds* (supported) on reaching an
anchor, an UNLOADED cell, a cell already proven supported this tick, or `SUPPORT_LIMIT = 8192` visited cells; success marks
every cell it visited as supported (so a later seed meeting them stops — *v1's shared visited set without verdicts judged
connected parts floating*). Budget `MAX_SUPPORT_VISITS_PER_TICK`; an unfinished search resumes next tick.

**Disconnected-by-this-removal rule.** A floating component found from C's seeds collapses ONLY if C was supported:
at least one of C's other neighbour components was proven supported, or C itself touched an anchor. If every neighbour
component floats, the build already floated on purpose (old saves, command builds, physics-off builds) — leave it.
There is no check on placement. *v1's checkPlaced would wipe old sky bases the first time the kid touched them.*

**Collapse.** A floating component → is it a **tree** (§6)? → topple. Otherwise it **crumbles**: every cell becomes a
column faller, lowest first; beyond MAX_FALLING the LOWEST cells settle instantly and the top ones animate (*v1 landed the
pile upside-down*). Gravity blocks and campfires on top follow through the normal triggers. Rune blocks / black holes
in it stay put. First collapse in a world → chat tip "Builds must touch the ground! (Esc → Physics to turn collapse off)".

=====================================================================================================================
## 6. Falling trees (`src/trees.js`, PURE simulation; drawn by fallingRenderer)

**Logs carry, leaves don't.** The support search never steps from a leaf into a log (leaves aren't load-bearing), so a
canopy touching another tree or a hillside no longer holds a cut trunk up. *Measured: 21–43% of forest trees would not
fall in v1; with this rule 1571/1571 topple.*

**Tree test** for a floating component: all its logs lie in ≤ 2 adjacent (q, r) columns, and it has ≥ 3 logs. Its
**leaves** = leaf cells within hex distance ≤ 2 of those columns, from the lowest log's y to top log y + 3, whose nearest
log column is this tree's (ties → this tree). Anything else (a log cabin) crumbles.

**Topple.** Pivot = top centre of the cut cell (the cell below the lowest floating log). Direction = the hex side
direction closest to "away from the cause": the player if within 16 units, else away from the explosion centre, else
seeded random. 0.15 s shake (±2°) + `audio.playCreak`, then rod dynamics `θ'' = (3g / 2h)·sin θ` (g = |GRAVITY|) from
θ₀ = 0.12 (≈ 1.2 s total). Each frame the rotated centre of every LOG is tested against load-bearing solids that are not
the tree's own cells (leaves of other trees do not stop it); stop at first contact or θ = π/2.
**Impact:** leaves burst into leaf particles; every log becomes a column faller at its rotated position (snapped to
that cell; if it is not free, the next free cell toward the pivot), so the trunk ends up lying on the ground; bodies
within 1.2 of a landing log are knocked (4 m/s away, vy 5); `audio.playThud`. Leaves left within 3 of no log anymore
**decay**: removed over ~1 s with leaf particles (they never become falling leaf blocks). Max 4 toppling at once; extra
trees wait in a queue (0.3 s apart) instead of crumbling. Cells ≤ 400 per tree (more → crumble).

=====================================================================================================================
## 7. Explosives (`src/explosions.js`, PURE)

**Lighting** a BLAST_BARREL: (a) R on it (target hint "R: light"); (b) a CAMPFIRE in its 8-neighbourhood (`misc` rule);
(c) console / rune `ignite q y r`. These become **lit barrel entities** (tumbling bodies, fuse `BARREL_FUSE_S = 3`,
`MAX_LIT_BARRELS = 32`, beyond → fuse timers); they hiss (`playHiss` every 0.4 s), pulse, take part in `resolveBodies`
against the player and pigs only (no barrel–barrel pairs — *300 barrel bodies cost 25–137 ms per frame*), and can be
**snuffed**: left-click a lit barrel (ray-target its body like pigs) → back to a barrel block with a fizzle; touching
water also snuffs it. (d) Barrels caught in a blast are lit as **fuse timers** in place (`Map<cell, seconds>`, 0.3–0.8 s),
not entities.

**Merged chains.** Every frame, all fuses that expire within the next 0.5 s of the earliest one, and lie within 8 of it,
go off as ONE blast centred at their mean, radius `3.5 · cbrt(n)` capped at 8 (*a pile is a bigger boom, not minutes of
stutter*). `MAX_EXPLOSIONS_PER_FRAME = 1`.

**Blast** (centre c, radius R):
- cells with centre distance ≤ `R + jitter(cell)` (seeded ±0.5) are destroyed unless protected: AIR, liquids, BEDROCK,
  OBSIDIAN (*blast-proof, so a kid can build a test bunker*), RUNE_BLOCK, BLACK_HOLE; barrels inside → fuse timers;
  campfires break; writes lazy through `ctx.write` (`'capped'` → stop breaking);
- up to `MAX_DEBRIS = 16` destroyed cells fly as tumbling debris (outward 6–10 m/s, up 4–8, spin) that vanish in dust on
  landing; the rest burst into dust particles;
- bodies within 2R (player, pigs, lit barrels): impulse `16·(1 − d/2R)` m/s away, with ≥ 6 m/s of it upward (*else
  GROUND_ACCEL wipes horizontal knockback in 0.1 s*); pigs squeal + flee; falling/tumbling entities in range are pushed too;
- ONE support search seeded from the load-bearing cells on the crater rim (shared memo), with "away from the blast" as
  the topple direction for trees it fells;
- effects: a dedicated explosion PointLight (constant light count) flashing ~0.25 s, smoke + spark particles,
  `audio.playBoom(volume)`, camera shake within 24 units (main offsets the camera).

=====================================================================================================================
## 8. Safety, controls and saving

- **Physics switches**, saved per world in an optional save field `physics: { falling, water, collapse, explosions }`
  (all true for new worlds). Worlds saved before v0.8 (field absent) start with **collapse off** and everything else on,
  plus a one-time chat line "New: block physics! Collapse is off for this older world — turn it on in Esc → Physics".
  Pause menu gets a "Physics" row of four toggle buttons; console `physics [falling|water|collapse|explosions] on|off`,
  `physics off|on` (pause/resume all, not saved), `physics status` (counts: queued updates, fallers, edits, lit barrels).
- **Undo** the last physics *event* (explosion, collapse, tree) within 60 s: each event records the cells it changed
  (cell, previous id, id it wrote) and the cells its fallers/logs later landed in; `undo` (console) or the pause-menu
  button restores every recorded cell whose current id is still what the event wrote, removes that event's entities still
  in flight, and refunds lit barrels. Only the most recent event (one level). Chat confirms what was restored.
- Saving: §3 (fallers settled into a copy), §4 (no flow/fall edits), lit barrels saved as barrels, fuse timers dropped,
  `physics` field written. The live world is never modified by a save.

=====================================================================================================================
## 9. Integration (`main.js`, `commands.js`, `audio.js`, `pigs.js`, `physics.js`)

`stepPlaying` order: input & interaction → player physics → black holes → pigs → **blockPhysics.step(dt) → fallers /
trees / lit barrels step → explosions** → campfires → `resolveBodies([player, pigs…, lit barrels…])` → **unstick player**
(if the player overlaps a solid cell: `findFreeY(…, floor(y)+1, 3)`) → runes → streaming. `renderFrame` syncs
fallingRenderer, particles and the explosion light/shake. R on a barrel lights it; left-click on a lit barrel snuffs it;
WATER selected → ray hits water. Commands: `physics …`, `ignite q y r`, `drain [r]`, `undo`. Audio: `playThud`,
`playBoom`, `playHiss`, `playCreak`, `playSplash` (water starting to flow near the player, throttled). Black holes,
campfires and runes keep working; black-hole eats are lazy writes and seed support searches like any removal.

Module dependency rule: fluids/support/trees/explosions/fallingblocks are PURE and only talk to the world through the
narrow interfaces above, so each is unit-testable on a Map-backed fake world.

=====================================================================================================================
## 10. Interfaces (built in the core commit — what the feature agents plug into)

The core (§0–§3, §8, §9) is built; `src/CONTRACTS.md` §33–§37 is the normative reference, this section is the guide.
**Rule of thumb: a feature only edits its own module (+ its own tests); everything below is already wired to the stub's
final signature.** Shared files a feature may still need: water → `mesher.js`, `physics.js` (wading / surfaces, §4) and
maybe `pigs.js`; explosions → `audio.js` (`playBoom`, `playHiss`, `playFizzle` — main calls `audio[method]` only when it
exists), `bodies.js` if barrel–barrel pairs must be skipped; trees → `audio.js` (`playCreak`). Constants for every feature
are already in `config.js` ("Block physics").

### 10.1 What a feature gets
`physics` (BlockPhysics, one per world) is handed to the feature's constructor; `physics.ctx` (RuleContext) to every rule:
- `ctx.peek(q, y, r)` → id or `UNLOADED` (255). On UNLOADED for a cell you need: `return ctx.park()` (the update waits for that
  chunk and re-runs when it is generated).
- `ctx.write(q, y, r, id)` / `ctx.writeQuiet(…)` → `'ok' | 'failed' | 'capped'`. Lazy; recorded into the open undo event; quiet
  = no support seed (use it for batched removals that queue ONE boundary search via `physics.seedSupport`). `'capped'` = the
  world hit MAX_TOTAL_EDITS: stop spreading / breaking (the chat line is already said).
- `ctx.schedule(ring, q, y, r, delay?)`, `ctx.random()` (seeded — never Math.random), `ctx.now()` / `ctx.deadline` (tick budget),
  `ctx.say(text)`, `ctx.sound(name, x, y, z, volume)` (main applies distance falloff and throttles), `ctx.particles(kind, x, y, z,
  count, opts)` (`'dust' | 'leaves' | 'smoke' | 'sparks' | 'steam'`, `opts { id?, color?, spread?, speed?, vx?, vy?, vz? }`),
  `ctx.hooks.knock(body, vx, vy, vz, fromX, fromZ)`, `ctx.hooks.bodies()` (player + pigs), `ctx.hooks.player()`.
- `ctx.fallers` (§10.4), `ctx.trees`, `ctx.explosions`, `ctx.support`, `ctx.fluids` — the sibling modules (call them only
  through the signatures below; they may still be stubs while you work).
- Registry: `physics.registerRule(name, { ring | rings, feature, ids, update(ctx, q, y, r, id) })`, `physics.addTrigger(name,
  feature, fn(q, y, r, prev, next, mode))`, `physics.addReseeder(name, feature, ids, fn(ctx, q, y, r, id))`; built-in triggers /
  reseeders 'gravity', 'water', 'ignite' (§2) can be replaced by name.
- Events (undo): `physics.beginEvent(kind, cause)` … `endEvent()` around a batch; things you spawn meanwhile carry
  `physics.openEventId`; later writes for that event go through `physics.enterEvent(id)` / `exitEvent(token)`. Implement
  `cancelEvent(id)` to drop your in-flight entities of event `id` (and refund lit barrels).
- Causes: `{ kind: 'player' | 'explosion' | 'area' | 'world' | 'physics', x?, y?, z? }`; `physics.withCause(cause, fn)`.
- Test helpers (`tests/helpers/fixtures.js`): `makeFakeWorld({ groundY })` (Map-backed World surface with `unload` / `load` /
  `put` / `writes`) and `attachPhysics(world, BlockPhysics, hooks)`. `tests/unit/physicsInterfaces.test.js` pins the method
  names and arities below — keep it green.

### 10.2 Water — `src/fluids.js`, class `Fluids` (stub)
- Constructor registers ONE rule: `{ rings: ['water', 'fall'], feature: 'water', ids: [AIR, CAMPFIRE, WATER, WATER_FLOW_1..6,
  WATER_FALL], update }` implementing §4 steps 1–6 with `ctx.write`. The scheduler already queues (trigger 'water'): every changed
  cell that involves water, or whose fall-through-ness / solidity changed next to water, plus its water/air/campfire neighbours —
  falling water and non-source cells with water above in `fall` (1 tick), the rest in `water` (WATER_TICKS). Reseeder 'water'
  wakes edited FLOW/FALL cells and the open neighbours of edited sources when a chunk loads.
- `drain(q, y, r, radius) → { ok, message }` (command `drain [radius]`, centre = player or rune cell, radius already checked).
- `currentAt(x, y, z, out) → out` m/s² for a body whose feet are at y − 0.1 (summed into the player's and pigs' pull input).
- Already done for you: FLOW/FALL saving (dropped when the origin is AIR, else AIR), WATER-selected crosshair hitting sources and
  left-click removing one, `playSplash` (call `ctx.sound('splash', x, y, z)`; throttled), steam particles kind.
- Yours elsewhere: `mesher.js` surfaces / culling (§4 Mesher), `physics.js` wading / swimming / `headInWater` (§4), pigs
  avoiding deep water. Note: worldgen water is WATER sources only; isFallThrough(WATER) is false (sand rests on sources).

### 10.3 Collapse — `src/support.js`, class `SupportSolver` (stub; predicates final)
- `step(ctx, seeds, maxVisits) → visits`: called each tick (after fall/misc rings, before water) while collapse is on and
  `seeds.size > 0 || busy`. Pull with `seeds.shift()` → `SupportSeed { cells: [q,y,r][], removed: [q, y, r, prevId,
  wasAnchor 0|1][], cause, priority, event, tick }` (priority lane first; cells already pending in an earlier seed are left out of
  later ones). Keep search state across ticks and report `busy`; check `ctx.now() >= ctx.deadline` every 256 visits.
- Use `isLoadBearing(id)`, `isSelfAnchored(id)`, `isAnchorCell(world, q, y, r)` (y = 0, bedrock, `world.isNaturalGround`),
  `ctx.peek` (UNLOADED counts as supported).
- On a floating component: `physics.beginEvent('collapse', seed.cause)`; `const tree = ctx.trees.test(component)`; if `tree &&
  ctx.trees.topple(tree, component, { cause, event })` done, else `ctx.fallers.crumble(cells, { event })` (removes them quietly,
  lowest first; rune blocks / black holes must be left out of `cells`); `physics.endEvent()`; then
  `physics.seedSupport(boundaryCells, { cause })` if the removal exposes more. `FloatingComponent = { cells: [q, y, r, id][],
  cause, event }`. First collapse → `ctx.say('Builds must touch the ground! (Esc → Physics to turn collapse off)')`.
- Seeds come from: player / command / rune / black-hole removals (one SupportSeed each; player ones `priority`), area commands
  (ONE seed per batch, cause `area`, `removed` lists every removal), `physics.seedSupport` from blasts. Physics' own gravity
  falls seed too (one seed per released column since the review pass, §10.10); quiet writes never do.

### 10.4 Falling blocks API used by the features — `physics.fallers` (built)
- `spawn(id, q, y, r, { vy, event })` — a column faller (the cell is not touched; remove the block first if it is in the world).
- `crumble(cells, { event })` → n — removes (quietly) and drops cells lowest first; beyond MAX_FALLING the lowest settle instantly.
- `settleNow(id, q, y, r, { event })` — instant drop with the landing rules (never buries a body; capped → dust).
- `spawnTumbler(id, x, y, z, vx, vy, vz, { spin: [wx, wy, wz], persistent, event, data })` → Tumbler | null (null at
  MAX_TUMBLING → emit dust instead). `removeTumbler(t)`. A tumbler has `body` (PlayerState-like, radius 0.45, height 0.98),
  rotation `rx, ry, rz`, `scale` (pulse it), `data` (your payload). Non-persistent tumblers vanish in dust on landing.

### 10.5 Trees — `src/trees.js`, class `Trees` (stub)
- `test(component) → TreeInfo | null` with `TreeInfo = { logs: [q,y,r,id][], leaves: [q,y,r,id][], cut: [q,y,r], pivot: [x,y,z] }`
  (§6 tree test; `isLog` / `isLeaves` are in blocks.js). `topple(tree, component, { cause, event }) → boolean` (false → the caller
  crumbles): remove the tree's cells with `ctx.writeQuiet` (inside the caller's event), animate, and on impact
  `ctx.fallers.spawn(logId, q, y, r, { event })` per log; leaves → `ctx.particles('leaves', …, { id })`; knock bodies with
  `ctx.hooks.knock`; `ctx.sound('creak' | 'thud', …)`.
- `step(dt)`, `renderItems(push)` with `push(id, x, y, z, rx, ry, rz, scale)` (cell centre, Euler 'YXZ'), `settleInto(overlay)`
  (`overlay.peek / overlay.set` — logs dropped from the current pose), `cancelEvent(id)`, `count`, `reset()`, `onSwitch(on)`.

### 10.6 Explosives — `src/explosions.js`, class `Explosions` (stub)
- Constructor registers `'ignite'` on `misc`, feature 'explosions', ids [BLAST_BARREL]; the scheduler already queues barrels
  next to campfires (trigger + reseeder 'ignite').
- main calls: `lightAt(q, y, r) → boolean` (R on a targeted barrel, inside `asPlayer`), `raycast(ox, oy, oz, dx, dy, dz, maxDist)
  → { target, distance } | null` (lit barrels, every frame; a hit takes the crosshair), `snuff(target) → boolean` (left-click),
  `bodies(out)` (lit barrel bodies into resolveBodies — currently ALL pairs; skip barrel–barrel in bodies.js if needed),
  `flash(out) → { x, y, z, intensity }` (drives the one PointLight), `shakeOffset(x, y, z, out) → [dx, dy, dz]` (camera),
  `step(dt)` (from physics.step after fallers and trees), `renderItems(push)`, `settleInto(overlay)` (lit barrels → BLAST_BARREL),
  `cancelEvent(id)` (undo: remove / refund), `litCount`, `reset()`, `onSwitch(on)` (off: put lit barrels out).
- Command `ignite q y r` → `ignite(q, y, r) → { ok, message }` (cell resolved, y and loading checked).
- Lit barrels: `ctx.fallers.spawnTumbler(BLOCK.BLAST_BARREL, x, y, z, vx, vy, vz, { persistent: true, data })` (drawn
  automatically; set `tumbler.scale` for the pulse; remove with `removeTumbler`). Blast: `physics.beginEvent('explosion',
  { kind: 'explosion', x, y, z })`, `ctx.writeQuiet` per destroyed cell (stop on `'capped'`), debris tumblers, rim seeds via
  `physics.seedSupport(rim, { cause })`, `endEvent()`; `ctx.sound('boom', …)` (BOOM_SOUND_RANGE), `ctx.particles('smoke' |
  'sparks', …)`, `ctx.hooks.knock(body, …)` (pigs also flee + squeal).

### 10.7 Deviations of the core from §0–§9 (and why)
1. **A gravity column drops in ONE update** (bottom first, same tick, same speed) instead of one trigger per cell a tick apart —
   per-cell triggering made a column "unzip" from the bottom; §3 asks for it to drop together.
2. **Fallers are processed lowest-first** (kept sorted with an insertion sort, linear when nearly sorted). With arbitrary order a
   stack landing in one frame could swap or break blocks (found by the 1056-cell crumble test).
3. **A landing cell that is not free** moves the block up ≤ 4 cells, else it breaks — robustness for blocks placed into a falling
   block's path.
4. **`physics off` still queues triggers** (nothing is lost; resuming continues) and freezes particles too.
5. **Water ring choice**: an open (or flowing) cell with water directly above goes to the `fall` ring like FALL itself, so a
   waterfall advances one cell per tick from its first cell.
6. **Re-seeding sources**: §2 lists "non-source water and their neighbours", §4 says sources must re-flow on load — both: edited
   sources wake their open neighbours.
7. **Support seeds carry their removals** (`removed: [q, y, r, prevId, wasAnchor]`) so the solver can apply the
   disconnected-by-this-removal rule (§5); `wasAnchor` uses `world.originAt` / `terrainHeightAt` (new small World methods).
8. **Undo** writes back quietly (no support seeds), lazily and past the edit cap; the 60 s window is measured in play time.
9. **World** also DROPS a saved edit equal to its generated id when the chunk generates (a free prune), and gained `hasEdit`,
   `originAt`, `terrainHeightAt`; `peekBlock` returns AIR (not UNLOADED) for a NaN y, like getBlock.
10. **main / commands are pre-wired for every feature** (WATER ray + source removal, currents, R to light, crosshair on lit
    barrels, snuff, flash light, camera shake, `ignite`, `drain`, `knock` hook) against the stubs, so features do not edit main.
11. Blast barrel bottom face uses the lid tile (two tiles were allotted).

### 10.8 Open questions for the feature owners
- A WATER source is not fall-through, so sand dropped on a lake rests ON the surface (by the letter of §3). Sinking would be
  more Minecraft-like but leaves FALL / air pockets inside oceans that the save turns into AIR edits; decide in §4.
  **Decided (water):** sources ARE fall-through — sand sinks. The pockets heal: the ≥ 3 infinite-source rule also turns FALL with a
  floor back into WATER, and (v0.8 review) any FLOW / FALL in a cell generated as WATER becomes WATER again, so a hole inside a lake
  refills as lake on any floor (and its edits prune away); CONTRACTS §35.2 / §35.6.
- A FLOW / FALL edit whose origin is WATER is saved as AIR (by the letter of §4): it would reload as an air pocket under water.
  Dropping it (reverting to the source) may be better. **Decided (water):** dropped (CONTRACTS §33.9); the 'water' reseeder also
  wakes edited AIR beside water, so a channel dug from the natural sea refills after a reload (CONTRACTS §35.3). The live rule now
  makes the same choice (natural water heals, §35.2 2a), so the world no longer changes on a save + reload.

### 10.9 Integration (the four features merged; normative: CONTRACTS §38)
Found only with everything running together, and how the merge resolved it:
1. **Burning barrels vs. collapse.** A blast lights the barrels around it as fuse timers *and* cuts what holds them up; the rim
   search runs a tick later and crumbled them, and crumbling a barrel cell drops its fuse — a pile landed in the crater as dead
   barrels. Now a collapse leaves a burning barrel where it is (`explosions.hangBurning`) until it goes off 0.3–0.8 s later;
   should it stop burning without going off (water, switch, undo) it gets its own support check, and a save drops it down its
   column. *A pile caught by a blast is one bigger boom, as §7 intends, and nothing is left floating.*
2. **Undo vs. water.** Water that flowed into a crater made those cells "changed since", so undo left pockets of water inside
   the restored ground. Undo now also restores a cell the event made AIR when it holds water. *The crater fills back in.*
3. **Starved collapses.** Waterfalls share the `fall` ring with sand; a long one could fill every tick's budget before the
   support step. A pending collapse now gets a small step (256 visits) after 4 starved ticks. *(Superseded by the fair shares
   of §10.10: the same waterfall also starved the water and misc rings.)*
4. **Two `playCreak`s** (trees and explosives both wrote one): the trees owner's is kept.
5. Tests written against stubbed neighbours that live water now changes (a water source beside a lit barrel puts it out; the
   trigger list) were adjusted, not the behaviour.

### 10.10 Performance pass (v0.8 review: CORE-1, CORE-2, F1, F2, FR-1, FR-2; normative: CONTRACTS §33.1, §33.6.4, §34.1–§34.2, §36.1.4, §36.3)
The review measured frames far beyond the 3 ms tick: one 150–470 ms physics step after a 32 768-cell `fill … air`, area-job
writes ~8× their pre-v0.8 cost, 34–113 ms ticks while a cut sand tower fell, 110–250 ms for an 8 000-cell crumble, and a big
waterfall holding the water and misc rings for ~450 ticks. Only the DFS was budgeted; everything around it was one call.
1. **Area batches carry only their removals.** The collector pushed each removal's load-bearing neighbours (8 reads, a list, a
   Map insert) though the search looks at every removal's neighbours anyway. Now it pushes the removal alone; one chunk lookup
   per write serves the built-in triggers, the water-neighbour check (`peekNeighbours`) and the anchor test.
2. **Every part of a batch is resumable.** Taking seeds in, the start-cell sweep (a cursor over seeds and removals, deduplicated
   by the memo instead of a prebuilt set), writing a big verdict into the memo, the rule's three passes and the collapse all keep
   cursors and stop on the deadline (cheap work is counted and checked every 256 units). *A 30 000-removal batch takes ~10 ticks
   of ≤ 3 ms; what it decides is unchanged.*
3. **Big crumbles come down from the bottom.** A component crumbles 64 cells at a time in (y, q, r) order; the lowest cells
   beyond the faller slots free when it began settle instantly, so the pile keeps its order across slices, and `settleNow` first
   settles the fallers still in flight below it in its column. Its leaves are checked once it is all down; undo stops it, a save
   writes what still hangs as fallen. *The build visibly gives way from below over a second or so instead of freezing a frame.*
4. **Gravity columns.** A column's AIR writes are quiet and queue ONE support seed; the scheduler reads its clock after any
   update that wrote ≥ 32 cells (a tick overruns by at most about one column); many fallers spawned at once are index-sorted
   instead of insertion-sorted (quadratic for columns spawned bottom-up one after another).
5. **Fair shares.** While misc, support or water have work due, the fall ring stops at half the budget (misc at ⅝, support at
   ⅞); fall and misc get the leftovers afterwards, and every ring with due work runs at least 8 updates (or one heavy one). This
   replaces the support-only starvation guard of §10.9.3.
Remaining cost on a shared, loaded machine: single frames of ~5–15 ms when a 4–11 ms GC pause lands in a physics step (packed
cell keys are doubles, so the memo's Sets allocate); fluids' re-queueing of already-settled falling water (two thirds of a
waterfall's fall-ring updates are no-ops) is a fluids.js matter left for that module.
