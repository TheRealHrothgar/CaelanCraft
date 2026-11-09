# Known issues (v0.8, PR #3)

Open problems found by play-testing and review that are **not fixed yet**. Each one was reproduced
independently by a second agent before it was listed. File and line references are from commit c47ce0b, the build
the play-test ran on. That build is the pushed branch plus the unshipped Hollow Watcher, minus save slots, so line
numbers can be off by a few.

Severity: **bug** = wrong behaviour or lost state; **glitch** = wrong but recoverable; **visual**; **perf** = frame
hitch; **polish**.

## Bugs

| # | Problem | Cause | Suggested fix |
|---|---------|-------|---------------|
| B1 | **A cut saved before its collapse check runs never comes down.** After a reload the build hangs forever, and later breaks count it as "already floating". | `support.settleInto` (support.js:482) saves only crumbles and open collapse batches; queued seeds and area batches (`physics.seeds`, `_areaRemoved`) are ignored by `exportEdits` (blockphysics.js:1249). | At save time, finish pending support work against the save overlay (same DFS, overlay reads) and write the result as fallen. |
| B2 | **A pig carried above y = 128 disappears on save** (e.g. on a flying player's head). | `validatePigsJSON` drops `y > WORLD_HEIGHT` (pigs.js:678); `Pigs.export` doesn't clamp. | Clamp y to `WORLD_HEIGHT` on export/validate instead of dropping. |
| B3 | **A lit Blast Barrel under sand rises through the pile** and explodes on top, breaking only the sand. | Lighting turns the cell to AIR; sand falls into the lit barrel's cell; the landing lift pushes the barrel body up one cell per frame (explosions.js:282, fallingblocks.js landing). | Treat lit-barrel bodies as occupied when fallers land: stack the sand on top instead of in the barrel's cell. |
| B4 | **Pigs climb out of a walled pool by riding each other:** 3 of 4 pigs escape. | Swimming pigs still do the SWIM_EXIT_JUMP wall jump while carrying a rider (pigs.js:421 → physics.js:359); the carry lifts the rider over the wall. | Let a pig that can't hop use plain swim-up instead of the exit jump (e.g. an `input.noExitJump` flag). |
| B5 | **Clicking a pig's head from the side breaks the block behind it.** | The ray only tests the 0.42-radius collision cylinder (pigs.js:581); the model's head and snout stick out to 0.77. | Ray-test a yaw-aligned box around the head/snout (or the whole model). |
| B6 | **A zombie hits a player standing on its head** about once a second, so you can't ride one. | `_canReach` (zombies.js:624) runs before body resolution, so a rider sunk a few mm counts as overlapping. | Skip the attack when `player.carrier === zombie`; require overlap beyond a 0.1 tolerance. |

## Glitches

| # | Problem | Cause | Suggested fix |
|---|---------|-------|---------------|
| G1 | **Landing sand lifts the player, a pig or a zombie up through a 1–2-thick solid roof.** | The landing lift uses `findFreeY` (fallingblocks.js:620), which tests each height alone and never checks the cells in between. | Lift layer by layer and stop at the first solid layer; break the block if there's no room. |
| G2 | **Blocks placed on a half-fallen crumble float forever after save + reload** (live play brings them down). | `settleInto` ignores the crumble's `watch` set (support.js:241/485). | At save time, re-check the watched cells against the overlay and drop what floats. |
| G3 | **Saving with Water switched off deletes all flowing water;** switching it back on leaves the sources dry. | Saves always drop flow/fall cells (blockphysics.js:403); the water reseeder is skipped while water is off (blockphysics.js:950); `fluids.onSwitch` does nothing (fluids.js:422). | While water is off, save flow/fall cells as they are (frozen), so a reload matches the live world. |
| G4 | **Floating sand built with Falling off stays up when it's switched back on,** then falls on its own after you walk away and back, or reload. | The gravity reseeder runs on chunk load (blockphysics.js:1428) but not when the switch turns back on. | When Falling is switched on, run the gravity reseeder over loaded chunks, so live play and reload agree. |
| G5 | **A canopy is left floating forever** when its logs are removed without a topple (chopping top-down, a blast, an area cut). | Leaf decay only starts from a topple or a crumble (trees.js:296, support.js:1257). | After a support batch handles log removals, run `trees.decayHangingLeaves` on them. |
| G6 | **A felled log that lands on another tree's canopy hangs in mid-air** after that tree is felled. | The stray log claims the leaf under it, and the decay rules count it as support (trees.js:209/587/636). | Don't count a block resting *on* a leaf as holding it; re-seed support when a leaf under a block decays. |
| G7 | **A tree chopped at eye level doesn't knock zombies;** they're just lifted onto the trunk. | Knock-back tests the logs' rotated pose at pivot height, not where they land (trees.js:515). | Test knocks along each log's drop path down to its landing cell. |
| G8 | **Many campfires breaking at once play up to 256 full-volume sounds in one frame.** | Each broken campfire calls `break:wood` (fallingblocks.js:521); `playPhysicsSound` drops the distance volume for `break:*` (main.js:612). | Give `playBreak` a volume, apply the distance falloff, and keep only the loudest break per frame. |

## Visual

| # | Problem | Cause | Suggested fix |
|---|---------|-------|---------------|
| V1 | **Pigs and zombies float above water** with their feet at or above the surface; they look like they stand on it. | Mobs paddle up on every in-water frame (pigs.js:421, zombies.js:359 → physics.js:359), which launches them clear of the surface. | Paddle only while a float point (≈ 0.45 up the body) is under water, so they sit partly submerged. |
| V2 | **Pig heads go through walls and other pigs** when pressed against something. | The model reaches 0.77 ahead of centre; the collider is a 0.42 cylinder (pigRenderer.js:113). | Shorten the model, or stop fleeing/pushed pigs facing a solid cell. Fix together with B5. |
| V3 | **The Undo button says "Undo Last Physics Event" after a falling tree.** | menus.js:151 checks `kind === 'tree'`; the event kind is `'falling tree'` (support.js:1124). | Compare with `'falling tree'`; fix the two JSDoc comments that say `'tree'`. |

## Performance

| # | Problem | Cause | Suggested fix |
|---|---------|-------|---------------|
| P1 | **0.7–1.9 s freeze the first time the crosshair lands on a block** in a new world. | The block-highlight material is compiled on first draw (renderer.js:445); loading doesn't pre-warm it. | Add `renderer.prewarm` (compile plus one hidden draw) and call it while loading. |
| P2 | **The first zombie of a session freezes the game** (up to several seconds on this machine). | zombieRenderer has no pre-warm (zombieRenderer.js:142). | Add `zombieRenderer.prewarm` like `fallingRenderer.prewarm` and call it while loading. |
| P3 | **After a big sand fill, other sand waits 2–10 s before falling.** | The fill's column releases fill the fall queue ahead of the player's dig; ~70% of queued updates are no-ops (blockphysics.js:1103/1131). | A priority lane for player-caused falls, and don't queue a released column's own cells. |
| P4 | **Leaf decay after a fall re-draws a chunk almost every frame for ~1.4 s** (15–35 ms frames when several trees fall). | Each decaying leaf is a separate lazy write at a random time (trees.js:667/685). | Use coalesced writes (`physics.coalesceMesh`) or decay in 3–4 waves. |

## Polish

| # | Problem | Suggested fix |
|---|---------|---------------|
| L1 | `ignite` on a barrel that's already lit says "there is no blast barrel there" (explosions.js:254). | Check lit barrel entities at that cell first and say "already burning". |
| L2 | Version labels still say v0.7 (config.js:4, package.json, package-lock.json, index.html footer, CONTRACTS, wave0 test). | Bump all of them to 0.8.0 / v0.8 together. |

## Save slots (minor, from the save-slot check)

- **Wrong "Quit Without Saving" message:** it always says "storage full, its last save is kept", even for a world that was never saved or when storage is blocked. Build the message from the actual failure reason.
- **Footer covers buttons:** in short windows the title footer sits over the Worlds-row buttons and blocks clicks. Give `#title-footer` `pointer-events: none`, or move it into the page flow.
- **Invisible names:** names made only of invisible characters get past the "no empty names" rule, and bidi control characters garble names. Strip `\p{Cf}`, treat an invisible-only name as empty, and display names with `unicode-bidi: isolate`.
- **Damaged slot turns saving off:** `?autoplay` on a damaged slot turns saving off for the whole session, including healthy worlds played afterwards, and blames `?nosave`. Limit the no-save flag to that one slot.

## Smaller leftovers from earlier rounds

- **Overlapping crumbles:** many crumbles at once cost about 2× more than before the crumble rework.
- **Waterfall drain cost:** draining a tall, dense waterfall curtain costs about 2× more, from the column walk in the `water-floor` trigger.
- **Rare lost sand fall:** a queued sand fall over a cave cell that was filled and dug out again just before a save is lost on reload (documented in CONTRACTS §33.4.3).
- **Zombie safe-zone edge:** a hopping player at the edge of a campfire's safe zone can still be struck, because zone membership uses the player's current height. §39.1 step 7 also understates the zone (most of ring 4 is inside).
- **Pig crowd overlap:** under a sustained pull (e.g. a floating black hole with swallowing off), the body push caps leave pig crowds overlapping.
- **Timing tests:** worldgen "warm chunk ≤ 8 ms", mesher "real chunk < 25 ms" and campfires "100 000 fires … stalls a frame" fail when the full suite runs in parallel on a busy machine, and pass when run alone.

## Not shipped: the Hollow Watcher

An original spooky figure, built as our own legend instead of "Herobrine" (a Minecraft character). It is **not in
PR #3**. Its code is on the local branch `worktree-wf_6c9efe31-dfa-4` (merged locally as `old-watcher-merge`). Its behaviour
checked out (about one sighting every three nights, vanishes when looked at or approached, traces trigger no
collapses), but it is held back because:

- **Originality:** the look reads as Minecraft's Enderman (a tall, thin, black humanoid with purple speckles and glowing
  eyes). The planned redesign is a floating stack of hollow hex rings with a hex lantern head (two cyan lights), a smoke
  wisp instead of legs, and ash-grey stone with cyan cracks. It was stopped before it finished.
- **Traces overwrite player builds:** an uprooting turned a player block under a root into dirt and deleted a Rune
  Block; pillars fill player-dug shafts.
- **Pre-warm:** shader pre-warm doesn't work, so the first sighting compiles 3 programs mid-game.
- **Second sighting:** a reload allows a second sighting in the same in-game night.
- **Off-screen sightings:** about half of natural sightings appear off screen (25–75° to the side).
- **Cave sightings:** these never had line of sight, so the figure is invisible but still uses up the night.

## Refuted (not issues)

The play-test skeptics refuted 7 reports:
- player leaves deleted by tree fall (intended: leaves within 3 of a felled trunk decay)
- a log holding another tree up
- a floating ring from wide player-built canopies
- undo leaving a hovering tree
- zombies popping into view
- blink of just-landed sand
- a dead fountain after Water off/on (it's the same bug as G3)
