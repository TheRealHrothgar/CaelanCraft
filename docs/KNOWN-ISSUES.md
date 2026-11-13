# Known issues (v0.8, PR #3; v0.9 Survival items at the end — S2–S4 fixed in the post-merge follow-up; v0.10 circuits: C1–C9; v0.12 backlog pass at the very end)

Problems found by play-testing and review. Each one was reproduced independently by a second agent before it was
listed. File and line references in the open tables are from commit c47ce0b, the build the play-test ran on. That build
is the pushed branch plus the unshipped Hollow Watcher, minus save slots, so line numbers can be off by a few. All the
bugs and glitches are fixed now (first table), and so is everything that held the Hollow Watcher back (its section). The
v0.12 backlog pass (CONTRACTS §72) closed V1, P1, P2 and the four save-slot items; what is still open is listed once more,
in one place, in the last section.

Severity: **bug** = wrong behaviour or lost state; **glitch** = wrong but recoverable; **visual**; **perf** = frame
hitch; **polish**.

## Fixed since the play-test

Every bug and glitch below now has a regression test that fails on the old code, and CONTRACTS.md describes the new rule.

| # | Problem | Fix | Commit |
|---|---------|-----|--------|
| B1 | A cut saved before its collapse check ran never came down after a reload. | At save time, pending support work (queued seeds, unflushed area removals, a batch still searching) runs as one batch of a scratch solver that reads the save overlay, and what it collapses is saved fallen (CONTRACTS §36.6.4). | 0d01e17 |
| B2 | A pig carried above y = 128 disappeared on save. | `Pigs.export` and `validatePigsJSON` clamp y to `WORLD_HEIGHT` instead of dropping the pig. | fdc4ea7 |
| B3 | A lit Blast Barrel under sand rose up through the pile. | Explosions tracks the cell each lit barrel rests in (`occupiesCell`); fallers treat it as solid, so sand piles on top. When the barrel leaves, the pile falls in (§34.2.2, §37.4.5). | e3a6cea |
| B4 | Pigs climbed out of a walled pool by riding each other. | A pig that can't hop swims up without the exit wall jump (`input.noExitJump`). | 9759242 |
| B5 | Clicking a pig's head from the side broke the block behind it. | `Pigs.raycast` also tests `PIG_HEAD_BOX` (head, snout, ears), turned with the pig. | 77811ab |
| B6 | A zombie hit a player standing on its head. | No strike on its own rider; the player's feet must be more than 0.1 below the zombie's top. | fdc4ea7 |
| G1 | Landing sand lifted bodies up through a 1–2-thick roof. | `liftFreeY` lifts layer by layer and stops at the first solid layer (the block breaks if there's no room). | fc05409 |
| G2 | Blocks placed on a half-fallen crumble floated forever after save + reload. | The save-time search (B1) also re-searches each crumble's watched cells. | 0d01e17 |
| G3 | Saving with Water off deleted all flowing water. | While Water is off, flow/fall cells are saved as they stand. | c15a9c6 |
| G4 | Floating sand built with Falling off stayed up when Falling was switched back on. | Switching Falling on runs the gravity reseeder over loaded chunks. | c15a9c6 |
| G5 | A canopy whose logs were removed without a topple floated forever. | When a support batch ends, the hanging-leaves test runs on the log cells it removed (natural leaves only). | ed292d3 |
| G6 | A felled log lying on another tree's canopy hung in mid-air once that tree fell. | A load-bearing cell resting on leaves no longer holds them, and a decaying leaf seeds support for the block on it. | ed292d3 |
| G7 | A tree chopped at eye level didn't knock zombies; they were lifted onto the trunk. | The knock tests each log's drop path down to its landing cell. | 4313b2a |
| G8 | Many campfires breaking at once played up to 256 full-volume sounds in one frame. | `playBreak` takes a volume with the distance falloff, and only the loudest break of a frame plays. | fdc4ea7 |
| V3 | The Undo button said "Undo Last Physics Event" after a falling tree. | It compares with the real kind, `'falling tree'`. | 61de012 |
| L1 | `ignite` on a lit barrel said "there is no blast barrel there". | It says "already burning". | 8643e1b |
| L2 | Version labels still said v0.7. | Bumped to 0.8.0 / v0.8 everywhere. | 15fb69b |

## Visual

| # | Problem | Cause | Suggested fix |
|---|---------|-------|---------------|
| V1 | ~~Pigs and zombies float above water with their feet at or above the surface.~~ | Fixed in v0.12: mobs paddle only while their float point (0.45 of their height) is under water, and settle back to that line (`physics.shouldPaddle` / `settleFloat`, CONTRACTS §72). Measured in game: sheep, cow, wolf and walker ride 44–45% submerged, steady to 3 cm. | — |
| V2 | **Pig heads go through walls and other pigs** when pressed against something. | The model reaches 0.77 ahead of centre; the collider is a 0.42 cylinder (pigRenderer.js:113). | Shorten the model, or stop fleeing/pushed pigs facing a solid cell. (B5 made the head clickable; it still clips.) |

## Performance

| # | Problem | Cause | Suggested fix |
|---|---------|-------|---------------|
| P1 | ~~0.7–1.9 s freeze the first time the crosshair lands on a block in a new world.~~ | Fixed in v0.12: `renderer.prewarm()` compiles the highlight, the dig trace and the three chunk materials while loading (CONTRACTS §72). | — |
| P2 | ~~The first zombie of a session freezes the game.~~ | Fixed in v0.12: `zombieRenderer.prewarm`, and the same for pigs and the new animals, called while loading. | — |
| P3 | **After a big sand fill, other sand waits 2–10 s before falling.** | The fill's column releases fill the fall queue ahead of the player's dig; ~70% of queued updates are no-ops (blockphysics.js:1103/1131). | A priority lane for player-caused falls, and don't queue a released column's own cells. |
| P4 | **Leaf decay after a fall re-draws a chunk almost every frame for ~1.4 s** (15–35 ms frames when several trees fall). | Each decaying leaf is a separate lazy write at a random time (trees.js:667/685). | Use coalesced writes (`physics.coalesceMesh`) or decay in 3–4 waves. |

## Polish

Nothing open (L1 and L2 are fixed, see above).

## Survival (v0.9) — fixed since the integration

| # | Problem | Fix |
|---|---------|-----|
| S2 | **The Handbook was wired against its API, not its code** (an eager `import.meta.glob` with every call guarded, from when package H was built in parallel). | main.js imports `handbook.js` / `handbookUI.js` statically; the guards, the duplicate `read` fallback and the "cannot be opened in this build" hint are gone. The flows were checked in Chrome: the Guide from the title and pause menus, R and RMB with the Handbook, "Read" from the pack screen, the field book closing on damage, the Handbook in slot 8 when Survival begins and back after waking (CONTRACTS §43, §48, §49). |
| S3 | **`types.js`'s GameContext typedef lacked the v0.9 members.** | Added (`survival`, `pack`, `setMode`, `getMode`, `urlMode`, `selectSlot`, `interact`, `digTargeted`, `useSelected`, plus `physics`, `zombies`, `watcher`); CONTRACTS §3. |
| S4 | **The console `undo` still undid in Survival** (could duplicate mined debris). | `undo` fails `not in Survival`, like `fly` (CONTRACTS §26.4, §33.8). Also: `pack add handbook` no longer mints a second copy (it gives one only when the pack has none) and `pack clear` gives the Handbook back. |

## Survival (v0.9) — fixed after the play-test

Found by the Survival play-test (five lenses, each finding checked by a skeptic); every fix has a regression test that fails on the
code before it (tests/integration/survivalBody.test.js, toolLadder.test.js and the unit suites named).

| # | Problem | Fix |
|---|---------|-----|
| P1 | **Falling sand, gravel and collapses never crushed the player** (6 HP per cell promised by §45 and the Handbook): the landing lifted the player inside `blockPhysics.step`, so `unstickPlayer` found nothing to lift. | A `lifted(body, cells)` physics hook from `_placeLanded`; main sums the player's lifts into `pendingCrush` and hurts right after the step under the same guards (CONTRACTS §33.7, §34.3, §45, §47). |
| P2 | **Field-book pages overflowed and scrolled** (the gathering table lost its last three rows below the fold at 1280×720), and every right-hand page with a margin note had a horizontal scrollbar. | Pages are re-paged to their measured height on open and on resize (`fitChapterPages`, tables split "(continued)"); `.hb-columns` hides horizontal overflow, table heads wrap, the book grows to 760 px on tall windows (§48). Round 2: the measure judges every table's width too (the five-column "Food and drink" beside its "Goes bad" note was still 370 px in 317 and scrolled sideways); the food table's pages carry no note and "Goes bad" is explained under "Spoilage and salt". The contents page, not re-paged, is compact below a 600 px viewport (it scrolled at 800×600). |
| P3 | **A workplace 4–5 cells away opened Making with every card greyed "build a Kiln nearby"** (R reaches 5, Making counts a workplace as near within 3). | `interactKind` returns `station_far` with `Kiln · step within 3 cells to work here`; R does nothing (§44). |
| P4 | **The kiln kit (crucible, mold, fire drill) and the spear wore out while digging** when selected. | A dig wears only digging tools (`wearsFromDigging`); blows wear everything but the kit (§47, Handbook "Wear"). |
| P5 | **A plain jump off a 2-cell ledge cost 0.54 HP** with the full hurt flash. | `FALL_SAFE_SPEED` 13.5 → 14.0; 3 cells and the 2-cell hop are safe, 4 cells hurts 2.7, 22 still kills (§45, DESIGN §2.4 table, decision 17). |
| P6 | **Dying buried lost every belonging** (only AIR or a liquid could take the REMAINS). | `chooseBelongingsCell` falls back to the first solid, non-bedrock candidate: the heap replaces the block that killed you (§49, DESIGN §2.5). |
| P7 | **The pack screen never showed the Handbook's refusal** (or a Make result): the HUD hint and the save toast lie under the screen. | The screen's own `.pack-message` line (`packSay`, 3 s) carries refusals and Make results (§48). |
| P8 | **A v0.8 client listed a version-3 Survival save as a normal world** through the shared slot index (and its `?autoplay` boot saved a fresh gen-1 world over it). | A version-3 document's index entry is written as `{ damaged: true, bytes, hash }`; v0.9 parses such slots and lists them as the worlds they are (§41.1, §42). This also closes S5 below. |
| P9 | **Tussock, gravel, tubers and cattails gave no crosshair hint** while their neighbours said "R: pick" (R is not their action — the skeptic refuted the bug, the wording was still unclear). | `Tussock Grass · hold LMB: pull`, `Gravel · hold LMB: dig` crosshair hints; the Handbook's step 1 and gathering table say "hold the left mouse button" (§48). |
| P10 | The Survival intro — the only pointer to the Handbook — faded after 6 s. | The intro lines live `INTRO_LINE_MS` 20 s (`addChatLine(text, isError, ms)`). |
| P11 | A cold pit's hint did not say what the relight lacked. | `Cold Fire Pit · relight needs a fire drill and 1 more stick` (`relightMissing`, §44). Round 2: main's `pitHintText` now shows that hint (it fell back to the generic relight hint, so the HUD never named the missing piece). |
| P12 | "needs a iron hammer or better". | `withArticle` in crafting and harvest hints. |
| P13 | A recipe that gives back the slot it takes (scrape_salt, pot_snow, leached_acorns, rag_bandage) waited "Pack full" for ever in a full pack. | `Pack.canExchange(takes, gives)`: room is judged after the inputs are taken (§43, §44). |
| P14 | A lethal hit while reading the field book resumed play (pointer lock, audio) before `die()` ran. | `hurt()` returns on a lethal hit; `die()` closes the book itself (§49). |
| P15 | The Making panel wrapped below the fold at 1024-wide windows. | `.pack-right` is `flex: 1 1 320px`, 300–520 px (§48). |
| P16 | Tab escaped the Guide and the field book onto the title screen's controls. | `#title-screen` and `#pause-menu` are `inert` while a reader is open (§48). |
| P17 | "1 Honeyberries went bad." | `itemName(key, 1)` → `SINGULAR_NAMES` ("1 Honeyberry went bad."). |

Left as found, on purpose:

- **Nothing points to fresh water** (the nearest pond is 16–66 cells from spawn) and the harsh-biome line gives bare cell
  coordinates. A direction line needs a pond scan over `worldGen.pondAt` and a bearing helper: a design addition, not a fix.
- **× 5 queues more tool-using jobs than the tool has uses left**; the extra ones fail at completion with nothing lost. Counting
  uses across queued jobs is a reservation change in `enqueue`; the failure lines already say why.
- **A fire dying at night gives no low-fuel chat warning.** The pit hint now names what is missing (P11); a "burning low" line
  needs a per-fire flag in `FireSlots.step`.

## Survival (v0.9) — open items from the integration

| # | Problem | Cause | Suggested fix |
|---|---------|-------|---------------|
| S1 | **The inherited menus still look like Minecraft's.** The title, pause and block-picker screens keep `.mc-button`'s grey #6f6f6f bevel, the #c6c6c6 picker with its #404040 title and the rotating yellow splash text. Every new Survival screen uses the honey palette and `.hex-button` (DESIGN-survival §11), so the two looks now sit side by side. | Restyling the existing screens would change how Creative looks, which v0.9 promised not to do. | **The user's call.** Proposed follow-up: move the title, pause and picker screens onto the survival palette (#1c1a24 / honey #e8b04a / ember #d0582a) and `.hex-button`, drop the splash text's rotating yellow, and re-shoot the Creative screenshots. |
| S5 | ~~A Survival world listed by a v0.8 tab loses its "· Survival" label in the Worlds list until it is saved again.~~ | Fixed with P8: a version-3 slot is always parsed, so the label never depended on the index. | — |
| S6 | **Four timing tests fail when the machine is busy** (they pass run alone): worldgen "generates a warm chunk in ≤ 8 ms" and its generation-2 twin, mesher "meshes a real chunk in under 25 ms", campfires "100 000 fires". | They measure wall-clock time; other sessions' processes on this machine skew them. | Run them alone before believing a failure; consider a CI-only budget multiplier. |
| S7 | **Closing the pack screen or the field book with `Esc` (or `E`) may fall back to click-to-play.** | Esc is not a user activation, so the pointer-lock request can be refused (the same as the picker, console and editor; CONTRACTS §23). | None (by design); a click resumes. |

## Circuits, powder kegs and black holes v2 (v0.10) — open items from the integration

| # | Problem | Cause | Suggested fix |
|---|---------|-------|---------------|
| C1 | **Thin parts block water.** A Powder Fuse, a Torch or a wire is a block id in its cell, so flowing water treats it like any non-water block and stops there instead of washing it away. | The six THIN parts are non-solid but not fall-through for fluids.js (DESIGN-circuits §1.1). | Let water flow into a thin part's cell and wash it away (dropping it in Survival), as Minecraft-like games do with torches. Needs a fluids.js rule change. |
| C2 | **Every wire placed and every burnt fuse cell re-meshes 1–4 chunks.** | `World.setBlock` marks the chunks around any change dirty, even when both ids are unmeshed (AIR ↔ a thin part). Long fuse burns eat the lazy re-mesh budget. | DESIGN-circuits §7.1's request to survival A: skip `_markDirtyAround` when prev and next are both AIR or unmeshed non-opaque ids. |
| C3 | **A Voltaic Battery's charge is not carried in Survival.** Breaking a battery gives a full one back, and the §8.2 "battery refill" recipe is not in. | Survival's ItemDef has no durability on block items yet (DESIGN-circuits §8.3: `d` = the charge, stack 1). | Allow `durability` on the battery's block item; write `c = d` on placing, read it back on breaking; add the refill recipe. |
| C4 | **perf. Huge networks are slow to rebuild, and the tick budget cannot split one**: an 8100-cell network takes about 150 ms on this loaded WSL machine, and an 8192-cell network rebuilt every tick (a relay buzzer, or a 0.5 s repeat timer, on a big terminal-board field or a long line) costs 10–20 ms a tick on an idle one — a hitch every tick while it runs. | The BFS is bound by Map lookups with large packed keys (about 300 ns a `Map.get` here). The 2 ms budget is checked between networks (CONTRACTS §52), so a network once started is finished in that tick; circuitsBudget.test.js's oscillator test only proves the check, with a fake clock. | A per-chunk typed-array index (B's report); or a BFS and solve that resume across ticks (keeping the old voltages until the new solve is done); or a lower `MAX_NETWORK_CELLS` (about 2000 fits the budget here) with the truncation line saying so. |
| C5 | **The Collapsar Charge's screen flash is fixed at 0.6 s in a void swallow** (the design says 0.5 s for the void flash). | Both flashes share hud.flashStep's (1 − t/0.6)² fade. | Give flashStep a per-kind length if anyone notices. |
| C6 | **Undo's look-ahead settles the whole dirty queue.** To see whether a restored igniter is still powered, `circuits.wouldIgnite` first solves every waiting cell as settling (no edge fires), so any other circuit changed in the same frame as an undo also settles instead of firing. | Undo restores cells in one go and the engine only rebuilds networks at its tick. | In practice undo runs from the pause menu, where nothing else is changing. A per-network look-ahead would be exact. |
| C7 | **A network that reaches an unloaded chunk is frozen whole** (by design, DESIGN-circuits §4.7 and adjudication 12): a switch beside the player does nothing to the lamp beside it while the line runs on past the unload radius (about 160 cells at render distance 7, less at a lower `?rd`). Its hints and panel now say `waiting: the circuit reaches an unloaded area`. | Solving the loaded part alone would let walking away until a coil's battery unloads fire a dead-man circuit. | Split long lines with a relay near the player (the coil side may freeze; the contact side stays live), or raise the design question with its owner. |
| C8 | **visual. The 3D device models (the art redo) change three things.** A device no longer shades a Selenium Panel below it; a device swallowed by a vortex vanishes without a spiralling copy; a block or a body resting on a short device sits at the full cell top, a little above the model (the battery is full height, so piles touch). | Devices are solid but not opaque and not meshed (CONTRACTS §50): only opaque blocks shade, infall skips unmeshed blocks (as for wires and campfires), and collision is per cell. | Shade with `solid` instead of `opaque` for the panel; give infall a model copy through `circuitRenderer.syncMoving` (it already draws moving device copies); per-model collision heights. |
| C9 | **visual. A burnt-out fuse cell's cord stays in the drawn wiring for up to 1 s**, under a full char overlay. | Rebuilding the wiring costs 10–20 ms near a big wired area, so cells that only burnt out rebuild it at most every `FUSE_REBUILD_S` (main.wiringRebuildDue); the char covers the stale cord meanwhile. | Per-chunk wiring buffers, so a burnt cell rebuilds only its chunk. |

## Save slots (minor, from the save-slot check) — all fixed in v0.12

- ~~Wrong "Quit Without Saving" message.~~ `quitUnsavedMessage` now builds it from the real failure reason and says whether an earlier save is kept.
- ~~Footer covers buttons.~~ `#title-footer` has `pointer-events: none`.
- ~~Invisible names.~~ `cleanWorldName` strips `\p{Cf}`, so an invisible-only name is empty; names are shown with `unicode-bidi: isolate`.
- ~~Damaged slot turns saving off.~~ The protection now covers only the world `?autoplay` opened; choosing a world on the Worlds screen switches saving back on, and the toast no longer blames `?nosave`.

## Smaller leftovers from earlier rounds

- **Overlapping crumbles:** many crumbles at once cost about 2× more than before the crumble rework.
- **Waterfall drain cost:** draining a tall, dense waterfall curtain costs about 2× more, from the column walk in the `water-floor` trigger.
- **Rare lost sand fall:** a queued sand fall over a cave cell that was filled and dug out again just before a save is lost on reload (documented in CONTRACTS §33.4.3).
- **Zombie safe-zone edge:** a hopping player at the edge of a campfire's safe zone can still be struck, because zone membership uses the player's current height. §39.1 step 7 also understates the zone (most of ring 4 is inside).
- **Pig crowd overlap:** under a sustained pull (e.g. a floating black hole with swallowing off), the body push caps leave pig crowds overlapping.
- **Timing tests:** worldgen "warm chunk ≤ 8 ms", mesher "real chunk < 25 ms" and campfires "100 000 fires … stalls a frame" fail when the full suite runs in parallel on a busy machine, and pass when run alone.
- **Faller over a crumble at save time** (found by reading the code while fixing B1; not reproduced): `fallers.settleInto` runs before `support.settleInto`, so a non-gravity block in flight above a crumble still coming down is saved on top of the hanging cells. Those cells are then saved fallen, which leaves that block floating after a reload. Sand is fine, because the gravity reseeder drops it on load.

## The Hollow Watcher: shipped after a redesign

An original night "sighting" (CONTRACTS §40), built as our own legend instead of "Herobrine" (a Minecraft character). Its
first version was held back for the reasons below. All are fixed in the version on PR #3, and an independent review
(originality, behaviour, rendering, each finding checked by a skeptic) found nothing left. The first version stays only on
the local branches `worktree-wf_6c9efe31-dfa-4` and `old-watcher-merge`; it was never pushed.

| Was | Now |
|-----|-----|
| **Originality:** the look read as Minecraft's Enderman (a tall thin black humanoid, purple specks, glowing eyes). | A floating stack of five hollow hex rings of ash-grey stone with glowing cyan cracks, a caged hex lantern head with two cyan lights, and a smoke wisp instead of legs. Nothing humanoid, black or purple. The review compared it with Minecraft's mobs and other well-known game characters and found no match. No game has a character called "Hollow Watcher". |
| **Traces overwrote player builds** (dirt under a root, a deleted Rune Block, pillars in dug shafts). | A trace only changes untouched natural terrain and natural trees. Every cell it writes or relies on must have no edit, and it mirrors the leaf decay that follows an uprooting (0 side effects in 113 real-terrain uprootings with random player edits). |
| **Pre-warm didn't work:** the first sighting compiled 3 programs mid-game. | It is pre-warmed after the campfire and explosion lights exist, plus one hidden first-frame draw. The first sighting now compiles none (measured in Chrome). |
| **A reload allowed a second sighting** the same night. | The night of the last sighting is saved (`watcherNight`). A remembered night ahead of the clock counts as tonight. |
| **About half the sightings started off screen.** | A sighting starts inside the real camera view (toward its edge, checked horizontally and vertically). "Seen" uses the camera's real FOV, so it is wider while sprinting. |
| **Cave sightings had no line of sight** but used up the night. | A natural sighting needs line of sight; otherwise the night's roll waits for a later check. |

Design note: at sighting distances (30–80 m) the two lights merge into one cyan point; they separate only up close.

## Fixed in the circuits review follow-up (v0.10)

Found by the circuits review (two lenses and a skeptic each); each fix has a regression test that fails on the code before it.
- **Settling under the tick budget** (HIGH, pitfall 37): a settling pass cut short by the budget dropped the cells it had not
  reached, so on a reload an energised NC dead-man relay's igniter kept the closed-contact power of the first pass and its
  refire clock lit the keg. Settling passes now keep their unreached cells, waiting settling marks go to the front of the
  dirty FIFO, and whole-world settles dirty relays first (circuitsBudget.test.js).
- **Dying with the device panel open** (HIGH): the panel stayed up after Wake up and its key capture swallowed every key.
  die() closes it (`screenClosedOnDeath`), and `closeDevicePanel` closes a panel still showing in any state.
- Undo gives blasted parts back with their settings (an NC relay stays NC, a timer keeps its delay and face).
- Survival: a keg burning in place hints how to put it out, not which axe breaks it.
- Switching circuits on, a reload and a stream-in no longer light a fuse, keg or charge laid against a Torch meanwhile (or
  refused while black holes or explosions were off): the flame rule acts on block changes only.
- Worked examples 2 and 5 built walking east: a timer, relay or coherer placed against its battery takes a free input face, and
  a source left on an input face is named in the hint and the panel.
- A burning fuse no longer rebuilds all the wiring within 64 units once per burnt cell (at most once a second, C9).
- Smaller: the earth hint for a device on a wire or a terminal board; `?scene=circuits` rows a blast apart; the controls sheet
  names push buttons (as §4.9 does); holding the left button on a burning keg in Creative no longer breaks it after the snuff;
  a relay buzzer keeps buzzing after a reload (it never left settling); the art redo's moving device copies (the collapsar's
  swelling copy) are drawn; overlays reach 64 units, like the wiring.

## Refuted (not issues)

The play-test skeptics refuted 7 reports:
- player leaves deleted by tree fall (intended: leaves within 3 of a felled trunk decay)
- a log holding another tree up
- a floating ring from wide player-built canopies
- undo leaving a hovering tree
- zombies popping into view
- blink of just-landed sand
- a dead fountain after Water off/on (it's the same bug as G3)

## Still open after the v0.12 backlog pass

Closed in that pass (CONTRACTS §72): V1, P1, P2, the four save-slot items, animals swallowed by black holes, lit Filament
Lamps giving light, and milk. Everything below was looked at and left, with the reason.

| Item | Why it is still open |
|------|----------------------|
| **S1** menus still look like Minecraft's | The user's call: restyling them changes how Creative looks. |
| **V2** pig heads clip into walls and other pigs | Needs a shorter model or a facing rule; cosmetic. |
| **P3** sand waits after a big fill, **P4** leaf decay re-draws a chunk every frame | Both need changes inside the block-physics queues; not attempted. |
| **C1–C9** circuits | Each is a design change in fluids, saves or the solver (see their table); not attempted. |
| **S6** timing tests, **S7** Esc falling back to click-to-play | Machine load, and a browser rule; nothing to fix. |
| The "smaller leftovers" list above | Rare or cosmetic; not attempted. |

Light (v0.11) and loose items (v0.10), new in this list:

- **Burning fuses and powder kegs give no light.** `LightEngine.setEmitter` (§72) would do it; a long fuse burn would then
  re-light a cell every step, on top of C2's re-meshing, so it wants C2 fixed first.
- **A very large crumble (about 7,000 cells) costs one ~24 ms frame** in the light engine's flush.
- **Mobs more than about 32 cells from the player are lit as if under open sky.**
- **A future material with its own `onBeforeCompile` bypasses the light shader hook** (`lightShader.js`); nothing does today.
- **Zombies still decide "under open sky" by walking the column**, not from `world.lightAt`.
- **A thrown item shows no landing marker.**
- **Loose items across a save and reload are covered by unit tests only** (serialize → storage's canonical form → load),
  not by an in-browser reload.

## The harder Survival (v0.14) — open items

From the build of CONTRACTS §76–§77. None blocks play.

- **Tainted water that flows looks like fresh water.** Flowing and falling water share their blocks, so water running out of
  a tainted pond is blue; only the crosshair hint says "Tainted water". A tainted set of flowing blocks would fix the look.
- **Under tainted water the fog and overlay are the ordinary blue.** Generated tainted ponds are one cell deep, so it shows
  only in deeper tainted water made with commands.
- **Streams are short** (median about 28 columns, longest 64 plus a pool) and most end in a hollow, not the sea.
- **Visible coal is sparse**: about one exposed cell a chunk; on the test seed the nearest was 54 cells from spawn.
- **Upgrading an old Creative world to Survival** regenerates its untouched land at the newest generation, so it gains
  streams and tainted ponds. Existing Survival worlds keep generation 2.
- **Nests are not pop-off blocks**: dig the ground from under one and it floats. They never expire.
- **A thrown spear that kills a fish stays on the stream bed.**
- **Balance is untested by a person**: the bear's 18 damage and 1 s recovery, how often hens lay, how many animals appear,
  Healwort's rarity, the Frecklecap's single dose of Poisoned, 12 % flint from gravel.
- **Sounds of the new animals were never heard** (headless runs only); their recipes are checked structurally.
- **Not checked in the running game** (unit tests only): a pot spoiling over time, boiling a tainted pot on a real
  campfire, drinking with the head under water, cave mushrooms, the picked crab apple and cut Healwort, the Healwort tea.
- **Mushrooms, onions and carrots do not regrow**; only the hazel thicket, the crab-apple bush and the Healwort do.
- **The world-generation timing tests** (≤ 8 ms a chunk, four of them now) fail when the machine is busy; best-of-eight
  runs measure 4.9 / 6.0 / 6.0 ms for generations 1 / 2 / 3.


## Wild plants in 3D (v0.15) — open items

From the build of CONTRACTS §78. None blocks play.

- **A plant is confined to its one cell**, so the hazel thicket and the crab apple are waist-high shrubs (0.9 m), not
  small trees. A taller model would poke into whatever is built above it.
- **A wide plant can reach about 0.1 m into the next cell** (0.54 m from the middle × 1.05, plus the nudge): a mushroom
  growing against a cave wall can show a corner of its cap sunk in the rock.
- **The picked Honeyberry is plain dark lumps**, cut from a leafy corner of the bush's picture; its own twiggy picture is
  too sparse to wrap a box.
- **Plants do not sway**, and their faces have no ambient occlusion: only the shade by direction and the darker ground
  contact.
- **Seen in headless screenshots only**; nobody has walked through a meadow of them yet. The chunk-mesh timing test still
  passes (a tussock is 9 quads, it was 3).


## Plants that spread; farming; slower regrowth — open items

From the build of CONTRACTS §80, which was unit-tested only: no browser, no build. None blocks play.

**Not checked in the running game**

- **Planting with R.** The R priority (`interactKind`) and the once-a-second work (`farmSecondOn`) are tested; the glue
  in main.js is not: `plantSeed`, the order of the target hints, the half-second hint cache, `farmStep` on the debug
  handle.
- **The look.** The seedbed and the sprout were seen only in a rough off-line render of their quads, the three seed
  pictures only as enlarged pixels. Nobody has seen them in a meadow, in the Pack or in the hand.
- **The hints and the log line** as the HUD shows them; the puff and the sound when the soil under a crop is dug away.
- **The pace.** A watered seed takes about three game days to a plant and a dry one about eight; a picked bush takes
  two days to fruit again. Whether that feels slow, fair or dull is untested by a person. So are the seed chances
  (50 % and 35 %) and the 80 % and 35 % of seeds that take.
- **Measured off-line on one real generation-3 world** (seed 12345, six game days at the spawn): a farm second costs
  0.07 ms; nine plants were born (five mushrooms on cave stone, two crab apples, a tuber and a carrot on grass); a
  watered Carrot Seed became a plant and a dry one did not take.

**Known limits**

- **A farm grows only while its chunk is loaded**, and wild plants spread only within 48 cells of the player. Walk away
  and both stand still, like a picked bush.
- **A seedbed and a sprout look the same for every crop.** Only the hint tells a planted carrot from a planted hazel.
- **R plants the food in your hand** when you aim at the top of bare soil that suits it: a tuber, a berry, a nut. The
  hint says so first (`Grass Block · R: plant Wild Tuber`), but a careless R costs one. Dug out again, it comes back
  half the time (a Wild Onion as Onion Seeds, a Cactus Fruit unpeeled).
- **With a seed in hand, the wrong-ground hint gives way to the older hints**: on stone it still says
  `Stone · needs a flint pick or better`, on gravel `Gravel · hold LMB: dig`. It shows on sand, snowy grass and the like.
- **Old Survival worlds (generation 2) slowly gain the newer plants**: a plant from nothing can be a carrot, an onion,
  a hazel, a crab apple, a Healwort or, under trees, a mushroom, whatever the land was made with.
- **Water must be level with the soil, or one cell up or down.** A field on a bank two cells above a stream is dry.
  Water that flows out of a tainted pond is tainted here too, and the sea is salt.
- **A crop on soil that is dug away is lost**, seed and all (it pops off like any plant).
- **Animals do not eat crops and nothing tramples them.** There is no hoe, no watering can and no harvest but the
  plant's own.
- **A plant from nothing takes any kind the ground can carry**, whatever the biome: a prickly pear can come up on a
  beach, a healwort is as likely as a carrot. It is rare (one moment in ten game days in the whole range).
- **A small patch fills to its soft maximum and then stands still**: births land within three cells, so every plant of
  the patch still counts all the others. In a forty-day run three onions became eight in five days and stayed eight.
  A patch hardly creeps across the land; new patches start from nothing (seven patches of four plants were 158 plants
  after 300 game days, 2 % of the columns in range).
- **Mushrooms spread in caves as well as under trees**, eight Honeycaps or six Frecklecaps to a patch. Roots and
  mushrooms still do not regrow where they were picked (the older note above); they come back by spreading instead.
- **Every new wild plant is an edit in the save.** At a handful of births a game day this stays small.
- **`setblock … carrot` is now ambiguous** (carrot_plant, carrot_sprout), as `onion` and `tuber` are: type the full
  name.
- **The sprout BLOCK keys are `CARROT_SPROUT` …**, not `SPROUT_CARROT`: a key must be its block's name in capitals.

## The lean Survival (v0.15) — open items

From the build of CONTRACTS §79. None blocks play.

- **Balance is untested by a person**: one food patch in three, herds of 1–3 kept to three near you, a raw gulp
  poisoning one time in five. Each is one constant to change.
- **Worlds made before this keep their land** (generation 3 or older), so they have about three times the wild food of a
  new world. The sparser animals, the riskier raw water, spreading and farming apply to every Survival world.
- **Seen in the running game** (headless): a new world is generation 4 with about half the food plants near spawn that
  the same seed had; R plants a Carrot Seed and the hint reads `Planted Wild Carrot · dry: slow, and it may not take`; of
  twelve carrots planted beside a stream ten grew in eight game days, of twelve on dry ground three did. Not seen: a
  whole season of play, a cattail bed, a bush planted and fruiting.

## Plants that are not food — open items

From the build of CONTRACTS §81 (ferns, daisies, thistles; Hemlock and Nightshade; flax and aloe), which was unit-tested
only: no browser, no build. None blocks play.

**Not checked in the running game**

- **The look, above all.** The seven pictures were judged as enlarged pixels on flat green and sand, and the eight
  models in an off-line software render of their quads (plain lighting, no world round them). Nobody has seen them in
  the real renderer: in a meadow, under trees, at dusk, from eye height and from far off, in the Pack or in the hand.
  The least certain: the **fern** (two tiers of arching fronds on one upright frond can read as a small conifer in the
  picture; its model is a fountain of fronds and reads better), the **thistle's leaves** (thick slabs with pale ends),
  and the **aloe** (blocky leaves that can read as a crystal).
- **Whether the tells can be seen at play distance.** The white flower plates of the Hemlock are large and lie on top,
  so they should show from far; its pale crown and purple-blotched stalk are small. The Nightshade's black berries stand
  on a dark bush: they show by their pale glints and by the purple flowers, which may be too little in poor light.
- **The hints** (`Hemlock · R: pick`, `Nightshade Bush · R: pick`) and the chat line when one is eaten, as the HUD
  shows them; the Aloe Leaf put on with the use button (it goes the bandage's way in main.js, which no test drives).
- **The two Guide pages** in both readers at real window sizes (their word counts are inside the tested page budget).

**Balance: numbers chosen, not play-tested**

- **How much greenery.** Ferns stand on about 5 % of forest columns and daisies on 4 % of plains columns, with a thistle
  on 1 %. Together with the tussock that is one plains column in nine with something growing on it. Whether that is
  "full of plants" or cluttered, and what it costs to walk through and to mesh, is unmeasured in the game. (The
  chunk-mesh timing test still passes; a daisy clump is 30 quads, a fern 29 and a thistle 78, against the tussock's 9.)
- **How often the look-alike.** About half of what looks like a wild carrot is Hemlock (measured 41–51 % by seed); in
  the forest about four bushes in ten are Nightshade, elsewhere about one in six. A patch is never all look-alike.
- **Flax and aloe are rarer than the plants they were sized against, counted as plants.** Their PATCHES are as common
  as asked (flax: as many as the wild onion had in generation 3; aloe: half as many as the prickly pear), but the
  patches are small, so there is one flax plant in about 2 600 plains columns (the onion: one in 800) and one aloe in
  about 900 desert columns (the prickly pear: one in 220). One number each in `PLANT_PATCHES_GEN4` changes it.
- **The Aloe Leaf** heals 6 HP in 4 s after 1 s of use; a plant gives 1–2 leaves and is gone. Whether that is worth a
  walk into the desert is untested. It spreads (four within six cells), and a shovel moves it.
- **Fibre is not scarce on the plains**, where tussock grows on 6 % of the columns: flax (3–4 fibre a plant) is a quick
  bundle, not a need.

**Known limits**

- **Only the newest worlds (generation 4) grow them.** In an older world they appear only as plants from nothing, where
  the spreading rule picks one (a Hemlock, a Nightshade or a flax on grass, an aloe on sand): rarely.
- **A Hemlock Root and Nightshade Berries cannot be put on a skewer.** With one in hand, R on a campfire takes what is
  done instead. That the fire refuses it is itself a hint that it is not food.
- **Once picked, the item's name tells which plant it was** ("Hemlock Root"), as "Frecklecap" does. What has to be
  learned is that the name means poison; the Guide says so and the plant's look shows it.
- **A picked Nightshade and a picked Honeyberry look the same** (one picture, one model). The hint names them.
- **A carrot gives seed, a Hemlock none**; a shovel digs more carrots but lifts a Hemlock whole. A careful player can
  tell them by that as well.
- **The thistle grows on bare mountain stone** (the surface block of that biome), not only on grass.
- **`setblock … nightshade` is ambiguous** (nightshade_bush, nightshade_bush_bare): type the full name.
- **None of the eight can be planted** from an item; a shovel moves a whole plant, and four of them spread by
  themselves. The fern, the daisies and the thistle neither spread nor regrow: dug up, they are gone from that spot.

## Sounds (v0.16) — open items

From the build of CONTRACTS §82 (materials, footsteps, voices, ambience, the Sound Test). None blocks play.

- **No sound has been heard by a person yet.** Nobody who built them could listen. Every sound follows a known
  synthesis recipe and is measured on a rendering of the game's own audio code (length, level, brightness, pitch,
  tremolo, bursts), which shows that a moo is low, long and steady — not that it sounds like a cow. Open the Sound Test
  (Esc → Sound → Sound Test, or `?ui=sounds`) and judge by ear; expect to retune.
- **The screen itself has not been seen in a browser** either: the Sound Test and the pause menu's Sound row were built
  and tested on the fake DOM only. Their layout (a list of about 130 buttons in a 980 × 680 panel that scrolls) is
  unverified.
- **Least sure of, most likely to need retuning:**
  - *The horse's whinny, the turkey's gobble, the pheasant's crow and the sheep's bleat.* A sawtooth through three or
    four band-passes is a crude voice; these four are the most complex calls and the most likely to sound like a
    synthesiser. The whinny falls from 1.5 kHz and may come across as a siren.
  - *The wolf's howl.* A triangle wave with two partials and a slight vibrato: it may sound like a whistle or a
    theremin rather than a throat.
  - *The birds.* Each note is a bare sine. The tit and the warbler are simple and probably pass; the blackbird's
    phrases are made-up melodies and the finch's buzz is a 30 Hz vibrato; any of them may sound like a telephone.
  - *The zombie's groan.* Its level and pitch are set, but whether "uhh" through two formants is spooky, comic or
    merely odd can only be heard.
  - *The stream and the fire's bed.* Bands of noise wobbling at fixed rates may pump like a machine instead of
    babbling or fluttering. The fire's bed is mostly below 400 Hz: small speakers may lose it.
  - *Levels.* Everything is set by A-weighted loudness against the old sounds (a break near −27 dB, the ambience 10 dB
    and more below). The balance was never heard: the ambience may be too faint to notice or too present, and steps
    (two a second for as long as you walk) may tire. `STEP_VOLUME` and the loops' `gain` are the knobs.
  - *Sand, leaves and glass* are bright by nature (2–6 kHz); on harsh speakers they may bite.
  - *Soft thuds* (dirt, grass, cloth, a landing, the rabbit) were moved up out of the bass so that laptop speakers
    play them; on headphones they may sound thin.
- **Mono, no direction.** As before, every sound is mono and only its volume says how far away it is. An animal's call
  does not come from its side; the stream is as loud behind a wall as in the open.
- **What makes no sound still:** other creatures' footsteps, a ridden horse's hooves, the sea (no surf), rain (there
  is none), caves (no echo). Still water is silent by design.
- **The ambience samples the place twice a second** with about 1,500 block reads (`sampleSurroundings`); its cost in a
  running game was not measured.
- **The Ambience switch is on or off**, one for the browser (localStorage), not a volume and not per world. Under
  `?nosave` it is not kept.
- **The tests stand on an emulator of WebAudio** (`tests/helpers/offlineAudio.js`), checked against the specification's
  formulas but not against a browser. A browser's oscillators and filters can differ in small ways.
- **Older documents describe the old sounds:** `docs/SPEC-gameplay.md` §9 and `docs/DESIGN-survival.md` §9.9 still
  speak of one filtered noise burst per break and a dig tick through `BREAK_CUTOFF_HZ`. CONTRACTS §82 is the rule.
- **Found on the way, fixed:** every animal call with a wobble (baa, neigh, bleat, gobble, growl, roar, wings) used to
  end with a click, because the wobble was added to the envelope and did not die away with it. The wobble is a gain
  stage of its own now (§82.1).

## The laws of water; pools that run out — open items

CONTRACTS §83. Built and tested without a browser: nothing below was seen in the running game.

- **It never rains yet.** The water cycle reads the weather through `waterEnv` in `main.js`, and that is a stand-in:
  rain 0, dryness 1. So until the weather is wired in (one object to replace), water only dries and is used up, and
  nothing brings it back. A pond the player stays within 48 cells of loses a depth about every three game days and is
  dry after about nine; a stream after about six. Do not ship this without the rain.
- **Not seen:** how low and shallow water look (a surface at 0.55 and 0.22 of a cell, with the tile of full water), the
  strip between a full pool and a lower one beside it, a pool dropping a depth all at once every 4 s, a source falling
  as a block of water a cell a tick.
- **Not felt:** swimming and wading. Shallow water is waded (walking speed × 0.85). Low water is 0.55 deep and counts
  as deep enough to swim, by the rule that was already there for flowing water of that height (`WADE_DEPTH` 0.4). In
  a pool one cell deep that means half speed and bobbing when you hold jump; it may feel wrong for knee-deep water.
- **A pool is easy to lose.** Any cell beside it that is not a solid block or standing water is a breach, and a breach
  empties the whole pool in 12 s, wherever the hole leads. Three cases a player may not expect: a block put INTO a
  pond and taken out again (the hole fills with flowing water, never with a source); the clay dug from under a pond
  (the water over that cell falls one down and stays there as a well, the rest runs out); a single block of the bank
  dug where the ground beyond is solid (the water has nowhere to go, and still runs out). This is the rule as asked
  for; a kinder one would let water settle into a closed pocket.
- **Creative builds with water change.** A source can no longer hang: fountains and waterfalls made of sources in the
  air fall and spill dry when their chunk loads (an edited source wakes on load). A lasting waterfall now needs the
  sea, a stream, or a reservoir whose surface is more than 128 cells.
- **The sea is a surface of more than 128 cells**, not a place. A large inland lake is therefore salt and endless; a
  natural lake of 128 cells or fewer is a pool: fresh, and it dries. A player-made reservoir of 129 cells is "sea".
- **A pool can stand at two depths at once.** Depth is one of three steps, so pools that join are level only to within
  one of them: a shallow cell joined to a full pond of seven leaves six cells full and two low, a visible step in the
  surface. It lasts until the pool next loses or gains a level: it loses one from its deeper cells and gains one in
  its shallower, and comes out even. This happens in Creative and with commands (water put beside water); in Survival
  pools that meet are almost always a breach instead.
- **Only water near the player changes.** The cycle looks at 48 columns a second within 48 cells of the player, in
  loaded chunks. A pond you never visit stays as it was. A body that reaches into a chunk that is not loaded waits
  (it does not dry, fill, spill or get used up) until the rest loads.
- **A stream can stand at different depths along its length** when its parts were loaded at different times: running
  water does not level. A stream of more than 128 cells is treated in parts.
- **Fish leave a stream that has run shallow** (0.22 is under their 0.3 minimum) and do not come back by themselves
  when it fills; whether they are restocked is the animals' business (§76.4), not checked here.
- **`undo` takes every pool's moves with it.** While an explosion, collapse or fallen tree can be undone (60 s), all
  falling, spilling and levelling of standing water anywhere is recorded with it, so that undo puts a breached pond
  back. A pool that ran out for another reason in that minute is put back too.
- **With the Water switch off nothing falls or spills**, and switching it on again does not wake what was put there
  meanwhile (as before, for flowing water): a change beside it does.
- **The largest pool, 128 cells, takes about 1 ms to drop a depth** (128 block writes in one tick). A pond takes
  0.1–0.3 ms, a second of the cycle 0.05–0.15 ms.
- **The Guide's farming page** (§80, not changed here) still says a crop can be watered by "a channel you dig". From a
  stream that works. From a pond it does not any more: the channel is a breach.
- **Older documents describe the old water:** `docs/DESIGN-physics.md` §4 and CONTRACTS §35.2's list of consequences
  speak of permanent sources. §83 is the rule; §35 carries a note.

## Seasons and rain — open items

From the build of CONTRACTS §84 (the calendar, rain in showers, how it looks and sounds, what it does). None blocks play.

- **Nobody has seen or heard the rain.** It was built without a browser. The streaks, the splashes, the snow, the grey
  sky and the pale sun are geometry and numbers that were tested as such (no drop under a roof, the share that comes
  through leaves, the budget, the colours' direction), never looked at. Expect to retune: the streaks' width (0.028 m),
  length and opacity (0.55); how many there are (480 at the most, within 10 m); the splash, a flat square that may
  read as a tile rather than a ripple; the flakes, which are plain squares; how dark and how grey the sky goes
  (`OVERCAST_*` in weather.js). To look: `__caelancraft.setWeather('rain')` in Survival or Creative, at noon and at
  night, in the open, under a tree, under a roof and in snowy land; `setWeather(null)` gives the real weather back.
- **The rain's sound is unheard**, like every sound (see Sounds above): a loop of filtered noise set as loud as the
  stream, a patter of noise ticks for the leaves, a low roll for far thunder. The Sound Test has a Rain scene and
  buttons for the two one-shots. Least sure of: whether the hiss sounds like rain or like a tap running, and whether
  the thunder is audible at all on small speakers (it lives below 500 Hz).
- **The HUD line has not been seen on a page.** `#calendar-line` sits at the top centre, 11 px bold on a dark strip.
  With F3 open the debug overlay (top left) may run under it on a narrow window.
- **The rain is drawn round the player only** (10 m). There is no curtain of rain in the distance and nothing on the
  far hills: the grey sky and the fog stand in for it. Looking out from deep inside a large hall, the nearest rain may
  be beyond the cylinder and none is seen, though it is heard.
- **A drop knows its own column and nothing else.** It falls straight down, so there is no wind and no slant; a roof's
  edge is a sharp line. A column is looked at again every 2 s, so a roof just built keeps a few drops for that long.
- **Rain makes nothing wet but the player.** No puddles, no darker ground, no water rising: the water itself is
  another piece of work (the `env` of §84.2 is ready for it). Until that lands, the guide's "the land dries out" is
  about the rain only: ponds and streams do not change with the season yet.
- **Creative has no weather.** By design (§42), but it means a world looks different after a switch of mode, and a
  fire or a crop in Creative never feels the rain. One line decides it (`weatherOn` in main.js).
- **Only the nearest fires are rained on** (the tracked ones, 1024 at the most), in loaded chunks. A fire far from the
  player burns through any weather, as it burns through anything else while its chunk is unloaded.
- **A rained-out fire keeps its food and loses its fuel.** It becomes a cold fire pit, like a fire that burnt out:
  relighting costs the fire drill's use, tinder and three sticks. In a long wet spell an open fire cannot be kept at
  all, which is the point, but there is no warning beyond the hint on the fire and the line in the log.
- **Leaves are a third of a roof for everything**: drops, fires, crops and the player. A crop under a tree is still
  "watered by rain"; a player under a tree gets wet three times more slowly. Nothing was play-tested.
- **"Watered by rain" looks at the roofs as they stand now**, not as they stood when it rained: roof a field after a
  shower and it stops counting at once; unroof one and yesterday's rain counts.
- **Wet from rain uses the old drying rule** (§45): 90 s under a roof or at night, half that in the sun, faster beside
  any heat source by 1 + heat / 5 (3.3 times a cell and a half from a campfire). The brief asked for "four times as
  fast by a fire"; the rule that was already there was kept instead of adding a second one.
- **Snow is only a look.** It does not settle, chill, wet or put anything out, and it is silent. Snowy peaks snow as
  snowy land does, at the same share.
- **The weather stops at a biome's edge.** A shower that falls on the plains and not on the desert ends in one step
  across the border; the drops and the sound fade over a few seconds as you cross.
- **Console `time set` moves the weather with the clock**, and `?time=` freezes it. `setDay(n)` on the debug handle
  jumps the calendar; the once-a-day rules that key on the day (tapping birch, the Watcher's night) jump with it.
- **Thunder has no lightning.** A roll now and then in a heavy shower, nothing to see.
