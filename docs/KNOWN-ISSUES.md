# Known issues (v0.8, PR #3; v0.9 Survival items at the end)

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

## Survival (v0.9) — open items from the integration

| # | Problem | Cause | Suggested fix |
|---|---------|-------|---------------|
| S1 | **The inherited menus still look like Minecraft's.** The title, pause and block-picker screens keep `.mc-button`'s grey #6f6f6f bevel, the #c6c6c6 picker with its #404040 title and the rotating yellow splash text. Every new Survival screen uses the honey palette and `.hex-button` (DESIGN-survival §11), so the two looks now sit side by side. | Restyling the existing screens would change how Creative looks, which v0.9 promised not to do. | **The user's call.** Proposed follow-up: move the title, pause and picker screens onto the survival palette (#1c1a24 / honey #e8b04a / ember #d0582a) and `.hex-button`, drop the splash text's rotating yellow, and re-shoot the Creative screenshots. |
| S2 | **The Handbook is wired against its API, not its code.** Package H (`handbook.js`, `handbookUI.js`, the Guide button, the `handbook` item) was built in parallel. main picks the two modules up with an eager `import.meta.glob` and guards every call, so until H is merged the Guide button does nothing, no Handbook is given, and R / RMB with nothing to read show "The handbook cannot be opened in this build". | Parallel packages (DESIGN-survival §14.3–§14.4). | After H merges: replace the glob in main.js with static imports, then check the Guide from the title and pause menus, R and RMB on the item, `onRead` from the pack screen, closing the field book on damage, and `ensureHandbook` after a new state and after waking. |
| S3 | **`types.js`'s GameContext typedef lacks the v0.9 members** (`survival`, `pack`, `setMode`, `getMode`, `urlMode`, `selectSlot`, `interact`, `digTargeted`, `useSelected`). | types.js belongs to W0; main types its `game` object with an index signature meanwhile. | Add them to the typedef (CONTRACTS §49 lists them). |
| S4 | **The console `undo` still undoes in Survival.** The pause menu's Undo is disabled in Survival (§1.5), but `undo` in the console calls `physics.undo()` in any mode, which can duplicate mined debris. | commands.js was not asked to refuse it (DESIGN-survival §9.7). | Make `undo` fail with `not in Survival` when `ctx.survival.mode === 'survival'`, like `fly` and `give`. |
| S5 | **A Survival world listed by a v0.8 tab loses its "· Survival" label** in the Worlds list until it is saved again. | An older tab rewrites the shared slot index without the `mode` field (the world itself loads correctly). | None needed beyond a resave; noted for completeness. |
| S6 | **Four timing tests fail when the machine is busy** (they pass run alone): worldgen "generates a warm chunk in ≤ 8 ms" and its generation-2 twin, mesher "meshes a real chunk in under 25 ms", campfires "100 000 fires". | They measure wall-clock time; other sessions' processes on this machine skew them. | Run them alone before believing a failure; consider a CI-only budget multiplier. |
| S7 | **Closing the pack screen or the field book with `Esc` (or `E`) may fall back to click-to-play.** | Esc is not a user activation, so the pointer-lock request can be refused (the same as the picker, console and editor; CONTRACTS §23). | None (by design); a click resumes. |

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

## Refuted (not issues)

The play-test skeptics refuted 7 reports:
- player leaves deleted by tree fall (intended: leaves within 3 of a felled trunk decay)
- a log holding another tree up
- a floating ring from wide player-built canopies
- undo leaving a hovering tree
- zombies popping into view
- blink of just-landed sand
- a dead fountain after Water off/on (it's the same bug as G3)
