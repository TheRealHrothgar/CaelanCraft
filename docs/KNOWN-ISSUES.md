# Known issues (v0.8, PR #3; v0.9 Survival items at the end — S2–S4 fixed in the post-merge follow-up; v0.10 circuits: C1–C9)

Problems found by play-testing and review. Each one was reproduced independently by a second agent before it was
listed. File and line references in the open tables are from commit c47ce0b, the build the play-test ran on. That build
is the pushed branch plus the unshipped Hollow Watcher, minus save slots, so line numbers can be off by a few. All the
bugs and glitches are fixed now (first table), and so is everything that held the Hollow Watcher back (its section). The visual,
performance and save-slot items below are still open.

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
| V1 | **Pigs and zombies float above water** with their feet at or above the surface; they look like they stand on it. | Mobs paddle up on every in-water frame (pigs.js:421, zombies.js:359 → physics.js:359), which launches them clear of the surface. | Paddle only while a float point (≈ 0.45 up the body) is under water, so they sit partly submerged. |
| V2 | **Pig heads go through walls and other pigs** when pressed against something. | The model reaches 0.77 ahead of centre; the collider is a 0.42 cylinder (pigRenderer.js:113). | Shorten the model, or stop fleeing/pushed pigs facing a solid cell. (B5 made the head clickable; it still clips.) |

## Performance

| # | Problem | Cause | Suggested fix |
|---|---------|-------|---------------|
| P1 | **0.7–1.9 s freeze the first time the crosshair lands on a block** in a new world. | The block-highlight material is compiled on first draw (renderer.js:445); loading doesn't pre-warm it. The chunk cutout (leaves) program is not pre-warmed either: it compiles the first time trees come into view (seen in the Watcher review). | Add `renderer.prewarm` (compile plus one hidden draw for the highlight and the chunk materials) and call it while loading. |
| P2 | **The first zombie of a session freezes the game** (up to several seconds on this machine). | zombieRenderer has no pre-warm (zombieRenderer.js:142). | Add `zombieRenderer.prewarm` like `fallingRenderer.prewarm` and call it while loading. |
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
