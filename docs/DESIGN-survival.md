# Caelancraft Survival — design v2 (v0.9)

This is the brief for building **Survival mode**. Several agents build it in parallel (§10), then one integration pass wires it
into `main.js`. Once merged, the normative parts move into `src/CONTRACTS.md` §42–§49 (§10.9). Until then, **this document is
the contract** for the survival code. Where it disagrees with CONTRACTS on something CONTRACTS already covers, CONTRACTS wins:
add a `// CONTRACT-ISSUE:` comment and tell the integrator. The reason behind a non-obvious rule is given in *italics*.

v2 applies the three reviews (realism and fun, originality, technical). What changed, and the few places where a review was not
followed to the letter, are listed in **§13 Decisions**.

The user asked for:
- realistic survival: health, falling, drowning, hunger, thirst, and hot and cold temperature;
- water and food from plants, trees and mobs, with meat cooked on a campfire;
- crafting and tools along a primitive-technology path: stone → flint → copper → bronze → iron → steel (iron and charcoal
  in a special forge);
- a Creative/Survival toggle in the pause menu and a console command. The mode is saved per world and can be flipped at any time.
  **Existing worlds and Creative keep working exactly as today.**

Conventions:
- All CONTRACTS §0 rules hold. Rates are per **real second** (`dt`).
- One game day is `DAY_LENGTH_SECONDS` = 600 s, so one game hour is 25 s. A new world starts at 07:12 (`START_TIME` 0.30), and
  the first dusk (18:00) comes 270 s later.
- Temperatures are in °C. "HP" means health points. "Cell" means a hex prism (q, y, r).
- **"In Survival"** (`SV`) means the world's mode is `'survival'`, dead or alive. It drives every UI and input branch.
- **"Survival active"** (`S`) means in Survival and not dead. It gates the stepping of vitals, the craft lanes, fires, fuel,
  regrowth, spoilage and repopulation. Every survival system is frozen otherwise (CONTRACTS pitfall 28: nothing catches up on a
  backlog).
- The stat stored as `satiation` is shown to the player as **Nourishment** everywhere (HUD, F3, chat, commands, chips). The
  internal key stays `satiation`, so the save format is unaffected.

=====================================================================================================================
## 0. The shape of it

| | Creative (unchanged) | Survival |
|---|---|---|
| Blocks | Infinite, from the block picker (E) | Gathered and made; carried in the **Pack** (27 hex slots: a 9-slot hotbar strip and an 18-slot rosette) |
| Breaking | Instant, repeats while held | **Hold to dig**: time = hardness ÷ tool speed; some blocks need a tool tier; **drops** go to the pack |
| Placing | Infinite | Uses 1 from the selected stack |
| Right mouse | Place | **Use the item in hand**: place a block, eat, drink, bandage, wear |
| R | Rune / barrel | Also: drink water (with anything in hand), fill a pot, pick, tend a campfire, tap a birch, open a basket, set a Sleeping Hide, take back your belongings |
| E | Block picker | **Pack & Making** screen |
| Flight | F / double Space | None |
| Body | None | Health, Nourishment, Hydration, Body temperature, Breath (§2–§3) |
| Hazards | Push you around | Also deal damage (§2.4) |
| Death | — | **Your Belongings** stay where you fell; you wake at your Sleeping Hide or in green land near the world spawn |

The world gains a survival layer, generated only in "generation 2" worlds (§1.3, §8):
- copper and tin ores;
- clay beds;
- wild plants: honeyberry bushes, tussock grass, cattails, wild tubers and prickly pear;
- ground litter: **loose stones** (rock and flint) and **fallen branches** (sticks);
- small fresh-water **hex ponds**;
- shingle, scree and till gravel;
- spruce and birch trees.

Pigs can be hunted in Survival, and they repopulate.

Making has no grid. It is a list of recipes, filtered by what you carry and which **workplaces** are near:
- your hands;
- a Work Stump;
- a Kiln;
- a Bloomery;
- the Forge.

Each workplace has its own **lane**, so the kiln, the bloomery and your hands can all work at once (§7.2).

Cooking happens **on the campfire itself**, on six skewers and in the embers (§4.4). A campfire made in Survival needs fuel.

=====================================================================================================================
## 1. Modes, switching and the save

### 1.1 The switch
- **Pause menu.** A new `Mode` row holds a two-segment switch, `[ Creative | Survival ]` (`#btn-mode`). The active half is
  filled in honey #e8b04a and carries `aria-pressed="true"`. Clicking the other half asks to switch; Resume then continues in
  the new mode.
- **Console.** `mode [creative|survival]` (§9.7). It is **console-only**: a rune script cannot run it.
- **URL.** `?mode=creative|survival` applies only to the **first** world the page loads, and only together with `?autoplay` or
  `?smoke`. After use, `params.mode` is set to null, so worlds opened later from the Worlds panel are never touched. The URL
  never raises an old world's generation unless the slot is new or `?nosave` is set; otherwise main logs
  `?mode=survival ignored: this older world needs the in-game upgrade (Esc → Mode)` and loads the world as it is.
- **New worlds** start in Creative, as today. The mode is per world.
- **Every switch is queued.** The pause menu, the command and the URL all call `requestMode(mode)`, which only sets
  `pendingModeSwitch = { mode }`. Main applies it at the top of the next frame while the state is PLAYING or PAUSED, after
  closing the console and the rune editor (§9.5). *Switching or upgrading from inside a command or a frame would replace the
  world mid-step.*

### 1.2 What switching does

**Creative → Survival**
1. If the world is generation 1 (§1.3), upgrade it first.
2. If the world has no survival state yet, begin one:
   - Health 100, Nourishment 80, Hydration 80, body 37.0 °C, Breath 20 s;
   - an empty pack.
   - Say once in chat: *"Survival: you carry nothing. Loose stones give rock and flint, fallen branches give sticks, tussock
     gives fibre. Drink fresh water with R."*
   - If the feet biome is DESERT, SNOWY, MOUNTAINS or SNOWY_PEAKS, also say *"This land is harsh: green land lies near q <q>,
     r <r>."*, using `world.findSurvivalSpawn()` (§2.5).
3. Otherwise the earlier survival state comes back exactly as it was left.
4. Flying turns off. `fallGrace` is set, so the first landing after the switch does no damage.
5. The HUD swaps the creative hotbar for the hex survival hotbar and shows the vitals.
6. The pause menu's `Undo` button is disabled (§1.5).

**Survival → Creative**
- The survival state (vitals, pack, worn items, fire spots and fuel, Sleeping Hide) is **frozen and kept** in the save for the
  next switch.
- The creative hotbar (`hotbar`, unchanged since the last time in Creative) comes back.
- *No items move between the two inventories. The world itself is shared, so Creative building is visible, and harvestable,
  in Survival.*

**While dead** the death screen is modal and the mode cannot be switched.

### 1.3 Generation 2: survival resources and old worlds
Survival resources are worldgen changes (§8), and worldgen changes rewrite untouched terrain. They are therefore gated:
- **`gen` save field.** Absent means generation 1, which is today's terrain, byte for byte. `gen: 2` turns the survival
  resources on.
- **New worlds.** The New World form gains a checkbox, **"Survival resources (wild plants, ponds, copper and tin)"**, checked by
  default. Checked creates the world with `GEN_LATEST = 2`; unchecked with generation 1. *New worlds look different in either
  mode when it is checked (tussock, ponds, spruce and birch, loose stones); the checkbox lets a Creative builder keep today's
  land, and README says so.*
- **Old worlds stay generation 1** until they are first switched to Survival. At that point:
  - **Pause menu:** a confirm dialog asks *"Bring survival resources into this world?"* with the detail *"Copper, tin, clay,
    wild plants, ponds and new trees will appear wherever the land is untouched — near your builds too. This cannot be undone."*
    The buttons are `Bring them` and `Cancel`.
  - **Console (`mode survival`):** no dialog. *Typing the command is already the explicit choice.*
  - **URL:** only under the rules of §1.1.
  - **Upgrade** (main, exactly):
    ```js
    const data = buildSaveData();
    data.gen = 2; data.mode = 'survival'; data.player.flying = false;
    if (!params.nosave) saveSlot(currentSlot, data);
    startLoading(world.seed, data);
    ```
    The loading screen shows briefly. *`gen` and `mode` reach the store together, so no crash can leave a Survival world on
    generation 1.*
  - **After loading:** chat says *"Survival resources have come to this world."*
- **A save with `mode: 'survival'` and no `gen` ≥ 2** (only possible by hand-editing) loads in Creative with the warning
  `mode: survival needs generation 2; loaded in Creative`. The pause menu's Survival half then offers the upgrade as usual.
- *A world that stays in Creative never changes, which keeps the promise that existing worlds keep working exactly as today.*

### 1.4 Save fields and version
These are written after `watcherNight` and before `meta`, in this order: `gen`, `mode`, `survival`, `containers`. Exact
validation is in §9.6.
- `gen`: an integer ≥ 2. It is written only when ≥ 2; absent means 1.
- `mode`: `'creative' | 'survival'`. It is written **only once the world has a survival state**; absent means Creative.
- `survival`: the frozen or live survival state: vitals, pack, worn items, Sleeping Hide, deaths, fire spots and fuel, and the
  death flag (§9.6).
- `containers`: wicker baskets and belongings, keyed by cell. It is written only when non-empty.
- **Version.** `serializeSave` writes `version: 3` when `gen` ≥ 2 or a `survival` object is present, and `version: 2`
  otherwise. *An older client (v0.8 in another tab, or a rollback) reads version 3 as unloadable and shows the slot as damaged,
  which it never overwrites, instead of silently dropping the pack and regenerating gen-1 terrain under gen-2 edits.*
- *A Creative world that never entered Survival writes none of these and stays version 2, so it serialises byte-identically to
  before (tested).*

### 1.5 Undo in Survival
The pause menu's physics `Undo` (CONTRACTS §33.8) restores every cell an event wrote. In Survival that would duplicate whatever
the player mined from a toppled tree or a collapse. So while `SV`, `#btn-undo-physics` is disabled with the label
`Undo (not in Survival)`, and `onUndoPhysics` refuses.

=====================================================================================================================
## 2. The body

### 2.1 Stats

| Stat (internal key) | Shown as | Range | New state | On waking | What it is |
|---|---|---|---|---|---|
| health | Health | 0–100 HP | 100 | 60 | 0 = death |
| satiation | Nourishment | 0–100 | 80 | max(current, 50) | How fed you are |
| hydration | Hydration | 0–100 | 80 | max(current, 50) | How watered you are |
| temp | Body temperature | 25–45 °C | 37.0 | 37.0 | Core temperature; drifts toward a target (§3) |
| breath | Breath | 0–20 s | 20 | 20 | Drains while the eye is under water or buried; refills at `BREATH_REFILL_PER_S` = 5 /s |
| wet | Wet | 0–1 | 0 | 0 | After swimming; makes you feel colder |
| sick | Sick | 0–600 s left | 0 | 0 | Stomach sickness (§4.5) |
| heal | — | 0–50 HP pending | 0 | 0 | Pending bandage healing |

*Waking values: never wake into a starvation loop, and never with full health either.*

### 2.2 Drain
Per second:
```
satiation −= 0.0556 × activity × coldFactor × sickFactor       (100 → 0 in 30 min at rest: 3 game days)
hydration −= 0.0833 × activity × heatFactor × sickFactor       (100 → 0 in 20 min at rest: 2 game days)
breath     = (headInWater || buried) ? max(0, breath − dt) : min(BREATH_MAX_S, breath + BREATH_REFILL_PER_S·dt)
```
- **`activity`** is the **largest** of the factors that apply this frame:

  | State | activity |
  |---|---|
  | Standing still | 1.0 |
  | Walking (horizontal speed > 0.5 m/s) | 1.4 |
  | Breaking (dig progress advanced this frame) | 1.8 |
  | Swimming (`inWater`) | 2.2 |
  | Sprinting | 2.5 |

- **Factors.** Felt temperature is defined in §3.
  - `heatFactor` = `min(2.5, 1 + max(0, felt − 26) / 8)`
  - `coldFactor` = `min(2, 1 + max(0, 12 − felt) / 12)`
  - `sickFactor` = 1.6 while sick, else 1
- **`heatFactor` and `coldFactor` are the only temperature terms.** The Hot and Chilled statuses (§2.3) stop regeneration and
  nothing else; they never multiply the drain again.
- **Pinned rates** (tested): desert noon at rest, felt 42.5 → heatFactor 2.5 → hydration −0.208 /s (80 → 0 in 6.4 min). The
  worst stack, sprinting in desert noon while sick, is 0.0833 × 2.5 × 2.5 × 1.6 = 0.83 /s.
- *A normal active day (activity ≈ 1.5) costs about 50 Nourishment and 75 Hydration: two cooked meals and two and a half pots
  of water.*

### 2.3 Regeneration and status

**Regeneration.** Health rises by **0.12 HP/s**, but only when all of these hold:
- satiation ≥ 50;
- hydration ≥ 50;
- body temperature 35.5–38.5 °C;
- not sick;
- breath > 0.

Each HP healed costs 0.25 satiation. Regeneration doubles while you have stood still for ≥ 3 s with a burning campfire within 4.

**Bandages.**
- A Fibre Bandage queues 15 HP and a Rag Bandage queues 25 HP into `heal`. The total is capped at 50.
- Queued healing is paid out at 1.5 HP/s (fibre) or 2.5 HP/s (rag), whatever the other conditions.

**Status labels, slowness and sprinting.** `statusOf(v)` returns:
- `canSprint`;
- `moveFactor`: the product of the slow factors below, never under 0.6;
- `regen`;
- the labels.

The HUD shows the labels (§9.8).

| Condition | Label | Effect |
|---|---|---|
| satiation < 25 | Hungry | No regeneration |
| satiation < 10 | Starving | No sprint, slow ×0.9 |
| satiation = 0 | Starving | 0.35 HP/s |
| hydration < 25 | Thirsty | No regeneration |
| hydration < 10 | Parched | No sprint, slow ×0.9 |
| hydration = 0 | Parched | 0.7 HP/s |
| health < 20 | Wounded | Slow ×0.9 |
| body ≥ 41 | Heatstroke | 1.5 HP/s, no sprint, slow ×0.8 |
| body 40–41 | Overheating | 0.4 HP/s, no sprint, slow ×0.9 |
| body 38.5–40 | Hot | No regeneration |
| body 34–35.5 | Chilled | No regeneration |
| body 33–34 | Cold | No sprint, slow ×0.9 |
| body 31–33 | Freezing | 0.4 HP/s, no sprint, slow ×0.85 |
| body < 31 | Hypothermic | 1.5 HP/s, slow ×0.75 |
| breath = 0, head under water | Drowning | 8 HP/s |
| breath = 0, buried | Smothering | 8 HP/s |
| sick > 0 | Sick | 0.15 HP/s (never below 10 HP), no regeneration |
| wet > 0.2 | Wet | — (shown only; colder, §3) |

Main applies the result:
- `input.sprint = input.sprint && status.canSprint`;
- `input.speedFactor = status.moveFactor` (physics §9.3).

### 2.4 Damage sources (every one)

| Cause key | Source | Amount | Hook |
|---|---|---|---|
| `fall` | Landing at impact speed v (m/s) | `FALL_DAMAGE_K·(v² − FALL_SAFE_SPEED²)` = `0.1·(v² − 13.5²)` when v > 13.5, × soft-landing factor | `player.landSpeed` (physics, §9.3), consumed by `survival.step` |
| `drown` | Breath 0 with the head under water | 8 HP/s | `headInWater` |
| `buried` | Breath 0 with the eye inside a solid cell and no free space within 3 above | 8 HP/s | `unstickPlayer` (§9.5) |
| `crush` | Falling ground (sand, gravel, a collapse) fills the player's cell | `CRUSH_DAMAGE_PER_CELL` = 6 × cells lifted | `unstickPlayer` (§9.5) |
| `fire` | Scorched by stepping into a campfire | 4 HP per scorch (at most one per 0.5 s) | `stepCampfires` → `scorchPlayer` |
| `zombie` | A zombie's strike | `ZOMBIE_DAMAGE` = 8 per strike (push unchanged) | `stepZombies` `ev.attacks` |
| `blast` / `log` | A blast or a toppled log | `6·max(0, dv − 5)`, dv = impulse speed | `physicsHooks.knock` player branch → `pendingKnock` |
| `blackhole` | Swallowed by a black hole | Death; belongings lost | `stepBlackHoles` |
| `starve` / `thirst` | Stat at 0 | 0.35 / 0.7 HP/s | `vitals` |
| `cold` / `heat` | Body temperature | 0.4 or 1.5 HP/s | `vitals` |
| `sick` | Sickness | 0.15 HP/s, floor 10 HP (never kills) | `vitals` |
| `void` | Feet below y = −32 | Death; belongings lost | `stepSurvival` |
| `command` | `vitals health 0` | — | commands → `pendingDeath` |

Notes on the table:
- **Fall.**
  - **Impact speeds** come from the real integrator: `stepPlayer` is semi-implicit Euler at 1/60 s, so a fall of d cells lands at
    `v = 28·n/60`, where n is the first step with `28·n(n+1)/7200 ≥ d`. With the safe speed 13.5 m/s:

    | Cells fallen | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 15 | 20 | 21 | 22 |
    |---|---|---|---|---|---|---|---|---|---|---|---|
    | v (m/s) | 13.07 | 14.93 | 16.80 | 18.20 | 21.00 | 23.80 | 26.13 | 28.93 | 33.60 | 34.07 | 35.00 |
    | HP lost | 0 | 4.1 | 10.0 | 14.9 | 25.9 | 38.4 | 50.1 | 65.5 | 94.7 | 97.8 | 104.3 |

    So 3 cells is safe, 21 cells leaves about 2 HP from full health, and 22 cells kills. *The safe speed is 13.5, not 13, because
    the integrator lands a 3-cell drop at 13.07 m/s.*
  - **Water** cushions completely, because physics cuts a fall to −3 m/s in swim-depth water. Wading water does not.
  - **Soft landings.** The factor is the **softest** over the cells under the feet (`physics.supportingCells(player, getBlock)`)
    when the player lands. *The factors follow how much each surface gives.*

    | Block landed on | Factor |
    |---|---|
    | SNOW_BLOCK | 0.4 |
    | OAK/SPRUCE/BIRCH_LEAVES | 0.6 |
    | HAY_BALE | 0.6 |
    | WOOL_* | 0.7 |
    | SLEEPING_HIDE | 0.9 |
    | Anything else | 1 |
  - **No damage** when `fallGrace` is set; the first landing clears it. Grace is set by a switch to Survival, by loading a
    Survival world, and by every `game.teleport`: waking, black-hole return, `tp`/`tpw` and rune teleports.
  - **Landing on a mob counts.** `bodies.standOn` also records `landSpeed`.
  - `survival.step` reads `player.landSpeed` and then sets it to 0 (**consume semantics**), so a stale value is never applied
    twice, even on a frame where `stepPlayer` was skipped for an unloaded chunk.
- **Blast or log:** the impulse is `|Δv| = hypot(vx, vy, vz)`.
  - A blast at its centre gives |Δv| ≈ 17, so 72 HP. At its radius it gives about 30 HP.
  - A toppling log gives 6.4, so 8.4 HP.
  - **Choosing the cause.** The knock hook runs inside `_blast`, before `explosions.lastBlast` and `blastCount` are updated, so
    the hook only records `pendingKnock = max(pendingKnock, |Δv|)`. Main then compares `blastCount` before and after
    `blockPhysics.step` (§9.5): changed → `'blast'`, else `'log'`.
- **Crush and buried.** `unstickPlayer` lifts the player out of a cell that has filled in.
  - When it lifts the player in Survival, on a frame that is not a teleport frame, with no `fallGrace` and no `log` or `blast`
    damage this frame: `hurt(6 × cellsLifted, 'crush')`.
  - When `findFreeY` returns null (buried more than 3 deep) and the eye cell is solid, `buried` is true for that frame: breath
    drains as under water, and at breath 0 the player takes 8 HP/s with cause `buried`.
- **Damage feedback:**
  - Each instant hit sets `hurtFlash = min(1, 0.4 + dmg/20)` and plays `audio.playHurt`, at most once per 0.3 s.
  - Damage over time pulses the flash at 0.4 with a soft hurt sound for every 3 HP lost.

### 2.5 Death and waking
**Death is deferred.** `hurt(amount, cause)` only applies damage. If it kills, it sets `pendingDeath ??= cause`. Main checks
`pendingDeath` at fixed points in the frame (after `stepBlackHoles`, after `stepCampfires`, after `stepSurvival`, after
`runner.update`; §9.5) and only there calls `die(pendingDeath)`, then returns from the frame. Commands set `pendingDeath`
through `ctx.survival`. *`die()` is never called from a physics hook, an explosion, a rune or a command, so no world write or save
happens in the middle of another system's step.*

**`die(cause)`, in order:**
1. **Close the pack screen** if it is open: the cursor stack goes back with `pack.add` (overflow is lost), then `packUI.close()`.
2. **Belongings.** Every pack and worn stack (at most 30) goes into **Your Belongings** (`REMAINS` block, §8.1):
   - `survivalControl.chooseBelongingsCell(getBlock, q, y, r)` picks the cell. It starts at the feet cell and first scans down to
     the first cell that stands on a solid one (at most 8 cells), so a death in mid-air leaves the belongings on the ground.
     It tries that cell, then up to 3 cells above it, then its 6 side neighbours;
   - the first cell that `isReplaceable` (AIR or a liquid) takes it, written with `world.setBlock`;
   - the contents go into `containers` (§5.6). *A death bypasses `MAX_CONTAINERS`.*
   - if no cell fits, or the cause is `blackhole` or `void`, the items are **lost**.
3. **State.**
   - `survival.dead = cause`, `deaths++`;
   - clear the craft lanes and the dig and use state;
   - `setState(STATE.DEAD)` before `controls.unlock()` (pitfall 24);
   - `menus.showDeath(title, detail, where)`;
   - `audio.playDeath()`;
   - `doSave(false)`.
4. **Death screen title** by cause:

   | Cause | Title |
   |---|---|
   | fall | "The ground came up too fast." |
   | drown | "The water closed over you." |
   | buried | "Buried alive." |
   | crush | "Crushed under falling ground." |
   | fire | "The fire took you." |
   | zombie | "A zombie brought you down." |
   | blast | "Caught in a blast." |
   | log | "Crushed by a falling tree." |
   | blackhole | "Swallowed by a black hole." |
   | starve | "Your strength gave out." |
   | thirst | "You died of thirst." |
   | cold | "The cold took you." |
   | heat | "The heat took you." |
   | void | "You slipped beneath the bedrock." |
   | command | "You collapsed." |

   The detail line is *"Your belongings lie where you fell."* or *"Your belongings are lost."* When they were kept, a third line
   gives the place: *"Your belongings lie at q 120, r −40, height 63."*
5. **`Wake up`** (`#btn-wake`):
   - apply the waking values (§2.1);
   - choose the waking place:
     - **Sleeping Hide.** If `survival.spawn` is set and its chunk is not loaded, call `world.update(x, z)` in a loop until
       `world.hasChunkAtCell(q, r)`, bounded to 200 ms (the death screen hides the hitch). If the cell is then
       `SLEEPING_HIDE` and `findFreeY(getBlock, x, z, hideY + 1, 3)` finds room, wake on it. If the chunk is still unloaded,
       trust `survival.spawn` and wake at (x, hideY + 1, z).
     - **Otherwise** wake at `blackHoles.respawnPoint(world.findSurvivalSpawn(), blackHoleWorld)`. *Black holes can reach the
       spawn, and a harsh world spawn would repeat the same death.*
   - `world.findSurvivalSpawn()` (A, pure, cached per world) walks the same `SPAWN_STEP` spiral as `findSpawn` but accepts only
     PLAINS or FOREST columns with height ≥ SEA_LEVEL + 2. It falls back to `findSpawn()`. `findSpawn` and Creative are
     unchanged.
   - set `fallGrace`, hide the screen, `enterPlayingFromModal()`.
6. **Reload.** When a loaded save has `survival.dead` set, `finishLoading` calls `setState(STATE.DEAD)` and
   `menus.showDeath(...)`, and skips both `showClickToPlay` and the autoplay `enterPlaying`. `enterPlaying()` returns early while
   `survival.dead` is set. *Otherwise the click-to-play overlay (z 35, above the death screen) would let a dead player play with
   Creative controls.*

**Your Belongings.** R on them moves everything that fits into your pack; overflow stays inside. When R empties them, main
writes AIR. Breaking them releases the contents the same way. They never decay.

=====================================================================================================================
## 3. Temperature

### 3.1 Air temperature where you stand (`climate.js`)

**Inputs.** Main samples these every 0.5 s, together with the stations (§9.5):
- `col = world.columnAt(q, r)` → `{ height, biome, temperature }` (A adds it to world.js; it wraps `worldGen.getColumn`).
  `T = col.temperature` is raw noise in −1..1.
- `openSky = zombies.openSky(world.getBlock, q, Math.ceil(eyeY), r)`. Leaves and glass count as cover.
- `underground = !openSky && col.height ≥ eyeCellY + 4`.

**Base temperature** (daily mean at sea level):
```
base = 12 + 22·T                     (−10 … 34 °C)
DESERT: +4   SNOWY: −4   OCEAN, BEACH: base = (base + 16) / 2      (the sea evens it out)
```

**Diurnal swing.** It peaks at 14:00 (t = 0.5833):
```
diurnal = A[biome] · cos(2π·(t − 0.5833))
A[biome]: OCEAN 2, BEACH 3, PLAINS 6, FOREST 5, DESERT 12, SNOWY 6, MOUNTAINS 7, SNOWY_PEAKS 7
```

**Altitude.**
```
altitude = −0.25 · max(0, feetY − 64)
```

**Air temperature** combines them:
```
air = underground ? base : base + diurnal + altitude
```
*A cave sits at the local yearly mean: cool in the desert, still freezing under snowy land. It has no day and night.*

### 3.2 Felt temperature
Felt temperature is what drives the body:
```
felt = air
     + sun        4·sunFactor(t)·(1 − sunShade)     only under open sky, 06:00–18:00; sunFactor = sin(π·(t − 0.25)/0.5)
     + shelter    +3 when there is no open sky and air < 10   (underground too)
     + heat       Σ sources (below), capped at +30
     + insulation I·(1 − 0.6·w), w = clamp((air − 15)/10, 0, 1)    (heavy clothes trap heat in hot weather)
     + activity   walking +1, breaking +2, swimming +2, sprinting +4   (the largest of those that apply)
     + ground     −2 standing on SNOW_BLOCK, SNOWY_GRASS, ICE or PACKED_ICE
     − 6·wet,     and while wet the insulation counts × (1 − 0.5·wet)
```

**Heat sources.** Each contributes `heat·(1 − d/radius)²` for d < radius. d is measured from the player's chest (feet + 1).

| Source | heat °C | radius | When |
|---|---|---|---|
| Campfire | 20 | 6 | While it burns (every CAMPFIRE cell; a cold FIRE_PIT gives nothing), measured to fire.y + 0.3 |
| Kiln | 12 | 4 | While that kiln's lane runs a job (§7.2) |
| Bloomery | 16 | 4 | While that bloomery's lane runs a job |
| Forge | 22 | 5 | While the forge's lane runs a job |

**In water** (`inWater`) the formula changes:
- `felt = waterTemp + 0.25·I + 2`, where `waterTemp = clamp(base − 2, 1, 26)`. Water has no diurnal swing.
- The comfort floor becomes 20 instead of 10, and the cold slope 0.4 instead of 0.3.
- *Water draws heat away about 25 times faster than air.*

**Wet.** `wet` = 1 while in water. Once out, it decays by `(1 + heat/5) · (openSky && day ? 2 : 1) / 90` per second.

### 3.3 Body temperature
```
target = felt < 10 ? 37 − 0.3·(10 − felt)        (in water: felt < 20 ? 37 − 0.4·(20 − felt))
       : felt > 30 ? 37 + 0.2·(felt − 30)
       : 37
temp += (target − temp) · dt / τ,   τ = 120 s moving away from 37, 40 s moving back toward 37; in water τ × 0.3
temp clamped to 25…45
```
The effects are in the §2.3 table. Snow eaten: −0.2 °C at once. *Melting 100 g of snow takes about 33 kJ, which is 0.2 °C of
a 70 kg body.*

### 3.4 Worked examples
Every row: feet at y = 64 (altitude 0), unclothed (I = 0), standing still, open sky unless noted. Snowy rows stand on snowy grass
(ground −2). D's tests assert **air, felt and target** (±0.2 °C) only; the outcome column is for reading.

| Where | When | Air | Felt | Target body | Outcome |
|---|---|---|---|---|---|
| Plains (T 0) | 14:00 | 18 | 21.5 | 37 | Comfortable |
| Plains | 02:00 | 6 | 6 (roof: 9) | 35.8 (36.7) | Comfortable: plains nights are cool, not dangerous |
| Desert (T 0.5) | 14:00 | 39 | 42.5 (sprint 46.5) | 39.5 (40.3) | Hot; sprinting brings Overheating |
| Desert | 02:00 | 15 | 15 | 37 | Fine |
| Snowy (T −0.6) | 14:00 | 0.8 | 2.3 | 34.7 | Chilled |
| Snowy | 02:00 | −11.2 | −13.2 | 30.0 | Freezing from ~1.7 min; dead at ~4.5 min |
| Snowy + leather (I 10) | 02:00 | −11.2 | −3.2 | 33.0 | Cold, no damage (just above Freezing) |
| … + campfire 1.5 away | 02:00 | — | 8.0 | 36.4 | Fine |
| Plains water | any | — | 12 (water 10) | 33.8 | Cold quickly (τ 36 s) |
| Snowy water | any | — | 3 (water 1) | 30.2 | Freezing in ~30 s; dead at ~2.2 min |
| Plains cave | any | 12 | 12 | 37 | A refuge |
| Snowy cave | any | −5.2 | −2.2 (shelter +3) | 33.3 | Cold, but no damage |
| Desert cave | any | 27 | 27 | 37 | A refuge from noon |

=====================================================================================================================
## 4. Water and food

### 4.1 Fresh and salt water
- **Salt water:** any water cell (source or flowing) whose column biome is **OCEAN or BEACH**, by `world.getBiome(q, r)`.
- **Fresh water:** all other water. In practice that is generation-2 **hex ponds** (§8.4), player- or command-placed water, and
  water that seeps inland.
- *Every sea-level water body is OCEAN/BEACH by construction, so the seas are salty. Water that seeps one cell inland through a
  breach counts as fresh: that is the real "beach well" technique, and it is intended.*
- Ice and snow are fresh.
- **Hint text:** `Fresh water · R: drink`, `Sea water (salty) · R: drink`, and with an empty Clay Pot selected
  `… · R: fill the pot`.

### 4.2 Drinking and carrying
**Aiming at water.** In Survival, with the eye out of water, main casts a **second ray** every frame:
`waterHit = raycastHex(world.getBlock, eye, dir, REACH, id => isTargetable(id) || isWater(id))`. R and the target hint use
`waterHit` when it hits water nearer than the normal `hit` (or `hit` is null). LMB and RMB keep using `hit`, so water is never
dug or placed against, and the block highlight never outlines water. *A first-day pack fills all nine hotbar slots within
minutes; drinking must not depend on an empty hand.*

**By hand.** R on water drinks a gulp, **whatever is in your hand** (except an empty Clay Pot, which fills instead). While your
head is under water, R drinks the water you are in, with anything in hand.
- Fresh: **+8 hydration** per gulp, with a 1 % chance of **Sick** (§4.5).
- Salt: **−4 hydration** and the chat line *"Salt water only makes you thirstier."* (throttled to once per 5 s).
- One gulp per `GULP_GAP_S` (0.5 s).
- *Early game you must drink unboiled water by hand; a small risk teaches you to boil without making the first day miserable.*

**Pots.** R on water with an empty **Clay Pot** selected fills it:
- fresh → **Pot of Water**;
- salt → **Pot of Seawater**.

Hold right mouse to drink a pot. It takes 1.0 s and gives back the Clay Pot.

| Pot | Hydration | Risk |
|---|---|---|
| Pot of Water | +30 | 3 % Sick |
| Pot of Boiled Water | +30 | Safe |
| Pot of Seawater | −10 | Salty message |
| Pot of Birch Sap | +25 (and +2 Nourishment) | Safe |

**Boiling.** Put a pot in the embers of a burning campfire (§4.4):
- Pot of Water → Pot of Boiled Water in 15 s;
- Pot of Seawater → **Salt-crusted Pot** in 30 s. Scraping it at hand gives Salt + a Clay Pot. *Boiling never makes the sea
  drinkable, but it does yield salt.*
- Snow and ice: Clay Pot + 3 Snow (or + 2 Ice Chunks) makes a **Pot of Snow**, which boils to Pot of Boiled Water in 25 s.
  *This is fresh water in snowy lands.*

**From a tree: birch sap.** R on a BIRCH_LOG with an empty Clay Pot selected and a knife of tier ≥ 2 anywhere in the pack starts
a **tap**: hold R for `TAP_HOLD_S` (4 s) while the action ring fills. It gives a **Pot of Birch Sap** and costs the knife 1 wear.
- Each log cell can be tapped once per game day. `harvest.Tapped` remembers `"q,y,r" → day` (not saved).
- Hints: `Birch Log · R: tap sap (needs a knife and an empty pot)`; when tapped today, `Birch Log · tapped today`.
- *Tapping birch is the textbook way to drink from a tree, and it gives birch a use beyond bark.*

### 4.3 Food sources
**Wild plants** are new blocks from generation-2 worldgen, listed in §8:
- Honeyberry Bush;
- Prickly Pear;
- Wild Tuber Plant;
- Cattails.

**Picking.** R on a ripe Honeyberry Bush or Prickly Pear picks it:
- Honeyberry Bush → 2–4 Honeyberries;
- Prickly Pear → 1–2 **Unpeeled Cactus Fruit**, or 1–2 Cactus Fruit when a knife of tier ≥ 2 is in the pack. Unpeeled fruit is
  singed on a campfire skewer (6 s) or peeled at hand with a knife (`peel_cactus_fruit`). *Burning or peeling off the glochids
  is how the fruit is really eaten.*

A picked plant turns into its *Picked* variant and **regrows** (§6.5).

**Ground litter** (picked with R or broken by hand, §6.3): Loose Stones give rock and sometimes flint; Fallen Branches give
sticks.

**Trees** (drops are in §6.3):
- oak leaves sometimes drop Acorns. Raw acorns are bitter; **leaching** them in a pot of water removes the tannins
  (`leached_acorns`), and roasting leached acorns makes them better still;
- spruce leaves drop Pine Nuts;
- birch logs give Birch Bark (tinder), and birch gives **sap** (§4.2).

*Oak does not drop apples. That is a well-known trope we avoid.*

**Pigs.**
- **Health:** in Survival a pig has `PIG_HEALTH` = 5.
- **Bare hands never wound a pig.** A bare-hand hit calls `pigs.hit` (a shove; the pig flees). Any held tool wounds it with its
  power (§5.1): a Stone Chopper (2) kills in three hits, a Flint Spear (3) in two.
- **Drops**, straight into the pack: Raw Pork 2–3, Rawhide 1, Pig Fat 1 (60 %).
- **On death** the pig is removed with a grey-pink dust puff and a squeal. No gore.
- **Repopulation** (Survival active only), every `PIG_REPOP_CHECK_S` = 150 s in daylight:
  1. If `pigs.size ≥ PIG_MAX`, remove at most one pig: the one farthest from the player whose chunk is **not** loaded and
     whose distance is > 2·`PIG_REPOP_RADIUS` (128). *Pigs left behind would otherwise fill the cap for good.*
  2. If fewer than `PIG_REPOP_TARGET` = 3 pigs are within `PIG_REPOP_RADIUS` = 64 of the player, call
     `pigs.spawnNatural(2, pq, pr, seed ^ (day·7919 + n), getBlock, isLoadedCell, 24, 48, SURVIVAL_PIG_GROUND)`.
     `SURVIVAL_PIG_GROUND` = [GRASS_BLOCK, SNOWY_GRASS], so snowy land has meat and hide too. `n` counts the attempts.
- *Creative pigs still never die, and Creative pig spawning still uses grass only.*

**Zombies** knocked out by the player in Survival drop a Grave Rag (50 %). Rags are boiled before they make bandages.

### 4.4 Cooking: fire spots
Every CAMPFIRE cell has **`FIRE_SPOTS` = 7 fire spots** (`cooking.js`, class `FireSlots`):
- **Spots 0–5 are green-wood skewers**, one planted at each of the six corner stones that `campfireRenderer` already draws
  (angle 60k − 90°, radius 0.72·HEX_SIZE), leaning about 35° inward. Each holds **one** food item (raw_pork, wild_tuber,
  cattail_root, leached_acorns or unpeeled_cactus_fruit). Kinds may mix, and each spot has its own timer.
- **Spot 6 is the embers** at the centre. It holds **one pot** (pot_water, pot_seawater, pot_snow or greenware_pot).

**R on a burning campfire** (Survival), in order:
1. The selected item is a skewer food → **put one** on the free skewer nearest the facing direction.
2. The selected item is a centre pot → put it in the embers if spot 6 is free.
3. The selected item is a stick or a `#log` → **feed** it (below).
4. Otherwise → **take** every spot whose item has finished at least one transform, or everything when none has. Whatever does
   not fit stays on the fire.
5. With nothing to do: the hint `Campfire · hold food or a pot and press R`.

Holding R repeats the put or feed every 0.25 s.

**Cooking.** A spot item cooks while its fire burns and its chunk is loaded. Transforms chain per spot: roast pork left on a
skewer chars after 40 more seconds.

**Fuel** (Survival only; *a fire that never needs tending is the most visible unrealism, and solves cold, cooking and the zombie
safe zone for good*):
- A campfire **placed while in Survival** starts with `fuel` = `CAMPFIRE_FUEL_START_S` = 300 s (half a game day).
- Feeding adds `FUEL_STICK_S` = 40 s per stick and `FUEL_LOG_S` = 300 s per log, up to `CAMPFIRE_FUEL_MAX_S` = 1200 s. At the cap
  the hint says `The fire is fully fed`. *Six sticks (one split log) give 240 s, less than the log itself.*
- Fuel counts down only while Survival is active and the fire's chunk is loaded.
- At 0, `FireSlots.step` reports the fire as burnt out and main writes **FIRE_PIT** ("Cold Fire Pit", §8.1) with
  `world.setBlock`. A fire pit gives no heat, no light, no smoke and no zombie safe zone (campfires.js tracks CAMPFIRE only). The
  spot items stay on the pit, frozen; R on the pit takes them.
- **Relighting.** R on an empty FIRE_PIT with a Fire Drill in the pack, 1 `#tinder` and 3 sticks: hold R for
  `RELIGHT_HOLD_S` (3 s). It takes the tinder and sticks, costs the drill 1 wear, writes CAMPFIRE with `playerSetBlock`, and
  starts the fuel at 300 s. Hint: `Cold Fire Pit · hold R to relight (drill, tinder, 3 sticks)`.
- **Fires with no fuel entry** — placed in Creative, or from before v0.9 — burn forever, as today. Feeding them does nothing and
  shows `This fire needs no fuel`. *A Creative player's decorative fires are never turned into cold pits by a visit in
  Survival.*

**What you see:**
- Target hint: `Campfire · 3 roasting (next 14 s) · 2 done · fuel 4:10 · R: take`. The fuel part is left out for a fire with
  no fuel entry.
- In the world, `campfireRenderer` draws a skewer on each occupied corner, a chunk of food at its tip coloured by progress, and
  the pot in the embers (§9.9). Smoke wisps rise over meat and steam over pots (particles). Items on a cold pit are not drawn.
- A soft sizzle is heard within 6 cells.

**When the fire goes.** If a campfire or fire pit is broken, doused or popped, whatever is on its spots is lost, unless the player
broke it in Survival; then the spots go into the pack. A burn-out (CAMPFIRE → FIRE_PIT) and a relight (FIRE_PIT → CAMPFIRE)
keep the spots.

**`FIRE_TRANSFORMS`** (key → result, seconds, spot kind):

| Item | Becomes | s | Spot | | Item | Becomes | s | Spot |
|---|---|---|---|---|---|---|---|---|
| raw_pork | roast_pork | 20 | skewer | | pot_water | pot_boiled | 15 | centre |
| roast_pork | charred_meat | 40 | skewer | | pot_seawater | salt_pot | 30 | centre |
| wild_tuber | baked_tuber | 25 | skewer | | pot_snow | pot_boiled | 25 | centre |
| cattail_root | roasted_cattail_root | 15 | skewer | | greenware_pot | clay_pot | 60 | centre |
| leached_acorns | roasted_acorns | 15 | skewer | | | | | |
| unpeeled_cactus_fruit | cactus_fruit | 6 | skewer | | | | | |

*A pot fired in the campfire (pit firing) is the realistic first pottery, so you need no kiln for your first pot. Logs are fuel,
not food for the fire: an open fire burns wood to ash, and charcoal needs the smothered burn of the Kiln (§7.3).*

### 4.5 Eating, food values, sickness, spoilage
**Using food.** Hold right mouse with food selected. It takes `useS` seconds (shown on the action ring), then applies and uses
up 1. Releasing early cancels. Keep holding and the next one starts after `USE_REPEAT_GAP_S` (0.25 s). Stats are capped at
100; hydration never goes below 0.

| Item | Nourishment | Hydration | Sick chance | useS | Spoils (mean s) | Note |
|---|---|---|---|---|---|---|
| honeyberries | 4 | 2 | — | 0.8 | 1800 | |
| acorns | 2 | −2 | — | 1.0 | — | Bitter raw (tannins) |
| leached_acorns | 3 | 0 | — | 1.0 | — | |
| roasted_acorns | 5 | 0 | — | 1.0 | — | |
| pine_nuts | 4 | 0 | — | 1.0 | — | |
| wild_tuber | 4 | 1 | 5 % | 1.2 | — | |
| baked_tuber | 12 | 0 | — | 1.2 | — | |
| cattail_root | 3 | 1 | — | 1.0 | — | |
| roasted_cattail_root | 8 | 0 | — | 1.0 | — | |
| cactus_fruit | 3 | 8 | — | 1.0 | — | Desert water |
| raw_pork | 6 | 0 | 30 % | 1.4 | 1200 | |
| roast_pork | 30 | −2 | — | 1.6 | 2400 | |
| charred_meat | 6 | −4 | — | 1.4 | — | |
| salted_pork | 18 | −6 | — | 1.4 | — | Keeps; no fire needed |
| pig_fat | 6 | −2 | 10 % | 1.2 | — | |
| snow | 0 | 3 | — | 0.6 | — | Body −0.2 °C |
| pot_water / pot_boiled / pot_seawater | 0 | +30 / +30 / −10 | 3 % / — / — | 1.0 | — | Returns clay_pot |
| pot_sap | 2 | 25 | — | 1.0 | — | Returns clay_pot |

**Sick.** Lasts 45 s (repeat cases add up, capped at 600 s). While sick:
- satiation and hydration drain ×1.6;
- −0.15 HP/s, but never below 10 HP;
- no regeneration.

The chat says *"Your stomach turns."* *Sickness punishes, but it never kills on its own.*

**Spoilage (stateless).** While Survival is active, once per second, each perishable stack in the pack, and in every basket or
belongings entry whose chunk is loaded, loses 1 item with probability `min(1, n·dt / spoilS)` (`food.spoilS`, table above).
For the pack the chat says *"1 Raw Pork went bad."* (throttled to once per 2 s). *There is no per-stack freshness state, so
stacking, saving and the UI are unaffected, and salted pork now has a reason to exist.*

=====================================================================================================================
## 5. Items and the pack

### 5.1 The item registry (`src/items.js`, Wave 0)
Every item has a unique lower_snake **key**. Saves store keys, never numbers.

**Block items.**
- Every block with `placeable: true` **except WATER** has a block item. Its key is the block `name`, its display name the
  block's, and its stack is **64**.
- `itemForBlock(HONEYBERRY_BUSH)` and `itemForBlock(HONEYBERRY_BUSH_BARE)` are both `'honeyberry_bush'`. The same holds for the
  prickly pear.
- The `honeyberry_bush` and `prickly_pear` items **place their Picked variant**: `ItemDef.block` is `HONEYBERRY_BUSH_BARE` /
  `PRICKLY_PEAR_BARE`. *A transplanted bush must take root, so digging up and replanting cannot farm infinite berries. It
  regrows normally.*
- LOOSE_STONES, FALLEN_BRANCHES, FIRE_PIT and REMAINS are not placeable and have no block item.

**Non-block items:**

| Kind | Key (Display Name) — stack |
|---|---|
| material | rock (Rock) 64 · flint (Flint) 32 · obsidian_shard (Obsidian Shard) 32 · stick (Stick) 64 · plant_fibre (Plant Fibre) 64 · cord (Cord) 32 · birch_bark (Birch Bark) 32 · clay_lump (Clay Lump) 32 · coal (Coal) 32 · charcoal (Charcoal) 32 · malachite (Malachite) 32 · cassiterite (Cassiterite) 32 · hematite (Hematite) 32 · gold_nugget (Gold Nugget) 32 · rough_gem (Rough Gem) 16 · copper_ingot (Copper Ingot) 32 · tin_ingot (Tin Ingot) 32 · bronze_ingot (Bronze Ingot) 32 · iron_bloom (Iron Bloom) 16 · wrought_iron (Wrought Iron Bar) 32 · steel_bar (Steel Bar) 32 · rawhide (Rawhide) 16 · leather (Leather) 16 · salt (Salt) 32 · ice_chunk (Ice Chunk) 32 · grave_rag (Grave Rag) 32 · glass_shards (Glass Shards) 32 · unpeeled_cactus_fruit (Unpeeled Cactus Fruit) 16 · greenware_pot (Greenware Pot) 8 · green_brick (Green Brick) 32 · fired_brick (Fired Brick) 32 · greenware_crucible (Greenware Crucible) 4 · greenware_mold (Greenware Mold) 4 · bellows (Bellows) 1 · clay_pot (Clay Pot) 8 · salt_pot (Salt-crusted Pot) 1 · pot_snow (Pot of Snow) 1 |
| food | honeyberries (Honeyberries) 32 · acorns (Acorns) 32 · leached_acorns (Leached Acorns) 32 · roasted_acorns (Roasted Acorns) 32 · pine_nuts (Pine Nuts) 32 · wild_tuber (Wild Tuber) 16 · baked_tuber (Baked Tuber) 16 · cattail_root (Cattail Root) 16 · roasted_cattail_root (Roasted Cattail Root) 16 · cactus_fruit (Cactus Fruit) 16 · raw_pork (Raw Pork) 16 · roast_pork (Roast Pork) 16 · charred_meat (Charred Meat) 16 · salted_pork (Salted Pork) 16 · pig_fat (Pig Fat) 16 · snow (Snow) 32 · pot_water (Pot of Water) 1 · pot_boiled (Pot of Boiled Water) 1 · pot_seawater (Pot of Seawater) 1 · pot_sap (Pot of Birch Sap) 1 |
| heal | fibre_bandage (Fibre Bandage) 8 — 15 HP at 1.5 HP/s, useS 1.5 · rag_bandage (Rag Bandage) 8 — 25 HP at 2.5 HP/s, useS 1.5 |
| wear | straw_hat (Straw Hat) head, I 0, sunShade 0.5 · leather_hood (Leather Hood) head, I 2 · grass_cape (Grass Cape) body, I 2 · leather_coat (Leather Coat) body, I 6 · hide_shoes (Grass-lined Shoes) feet, I 2 — all stack 1 |
| tool | Below — all stack 1, carry `d` (durability left) |

`pot_snow` is a material: you cannot drink it; it is only boiled (§4.4). `unpeeled_cactus_fruit` is a material: it is singed or
peeled first.

**Tools.** `ToolDef = { type, tier, durability, power }`.
- **Tiers:** `TIER_NAMES = ['hand','stone','flint','copper','bronze','iron','steel']`.
- **Speeds:** `TIER_SPEED = [1, 1.5, 2, 2.6, 3.4, 4.5, 6]`.
- **Power** is the damage a hit deals to a mob. Bare hands deal 1 to zombies and only shove pigs (§4.3).

| Tier | Item keys (type) | Durability | Power |
|---|---|---|---|
| 1 stone | hammerstone (hammer), stone_chopper (axe), digging_stick (spade) | 60, 40, 40 | 1, 2, 1 |
| 2 flint | flint_knife (knife), flint_axe, flint_pick, flint_spade, flint_spear (spear) | 70, 90, 90, 90, 60 | 1, 2, 1, 1, 3 |
| 3 copper | copper_knife, copper_axe, copper_pick, copper_spade, copper_hammer | 140, 160, 160, 160, 160 | 2, 2, 1, 1, 1 |
| 4 bronze | bronze_knife, bronze_axe, bronze_pick, bronze_spade, bronze_hammer, bronze_sword | 260, 320 ×4, 280 | 2, 3, 1, 1, 1, 3 |
| 5 iron | iron_knife, iron_axe, iron_pick, iron_spade, iron_hammer, iron_sword | 500, 600 ×4, 550 | 3, 3, 1, 1, 1, 4 |
| 6 steel | steel_knife, steel_axe, steel_pick, steel_spade, steel_hammer, steel_sword | 1000, 1200 ×4, 1100 | 3, 4, 1, 1, 1, 5 |
| 0 | fire_drill (firestarter) · crucible (crucible) · casting_mold (mold) | 8 · 20 · 12 | 1 |

Display names are "Hammerstone", "Stone Chopper", "Digging Stick", "Flint Knife", …, "Steel Sword", "Fire Drill", "Crucible"
and "Casting Mold". *A hammerstone is the fist-sized cobble every knapper strikes flint with: flint cannot be shaped without
one, so the stone tier is a real step.*

**Tags** (`TAGS`). A tag is taken from its members in the order listed:
- `log`: oak_log, spruce_log, birch_log;
- `planks`: oak_planks, spruce_planks, birch_planks;
- `fuel`: coal, then charcoal (*keep charcoal for iron*);
- `tinder`: birch_bark, plant_fibre;
- `knapstone`: flint, obsidian_shard (*obsidian is volcanic glass, knapped like flint*);
- `sand`: sand, red_sand.

**`ItemDef`:**
```
{ key, name, kind: 'block'|'material'|'food'|'heal'|'wear'|'tool', stack, block?, tool?, food?: {satiation, hydration, sick, useS,
temp?, returns?, spoilS?}, heal?: {hp, rate, useS}, wear?: {slot, insulation, sunShade}, tags? }
```

### 5.2 Stacks
`ItemStack = { k: string, n: integer ≥ 1, d?: integer ≥ 1 }`.
- `d` (durability left) exists only on items with a durability. When absent, the item is new (full).
- Items with a durability never stack: their stack size is 1.
- Two stacks merge when they have the same `k`, no `d`, and the stack size allows.

### 5.3 The pack (`src/inventory.js`, class `Pack`)
**Layout.**
- `PACK_SLOTS` = 27; slots 0–8 are the **hotbar** (the existing `HOTBAR_SIZE` = 9), slots 9–26 the rosette (§5.4).
- `WEAR_SLOTS` = 3: head, body, feet.

**Adding** (`add`):
1. Merge into existing same-key stacks, slot 0 → 26.
2. Fill empty slots, 0 → 26 (the hotbar first, so new finds are at hand).
3. Overflow is returned. Main then says *"Pack full: 2 Rock left behind"*, throttled to once per 2 s.

**Taking** (`take`, `takeTag`) works backwards from slot 26 to 0, so the hotbar keeps its things longest.

**Tools.**
- **Required tool** (`useTool(type, minTier)`): the qualifying tool with the lowest tier is used; ties go to the least `d` left.
- **Wear:** a tool loses 1 durability:
  - for each block broken while it is selected (whatever the block);
  - for each mob hit;
  - for each completed recipe that requires it;
  - for each tap (knife) or relight (fire drill).
- **Breaking:** at 0 it breaks. Chat says *"Your Flint Axe broke."* and `audio.playToolBreak()` plays.
- *Using a pick on dirt wears it. Choosing the right tool matters, as it does in reality.*

**Spoilage.** `pack.spoil(dt, random) → ItemStack[]` (what went bad) applies §4.5 to the pack. Containers have the same method.

**Placing in Survival** works like Creative's rules (§23), with the selected stack's item as the block (its `block` id), and
`pack.consume(selected, 1)` on success. A selected stack that is not a block item does not place. **A pop-off block** (a plant or
a campfire, `isPopOff`) placed over a cell that is not solid is refused with the hint `needs solid ground`, and nothing is
consumed. *Otherwise the falling trigger pops it on the next tick and the item is simply destroyed.* A campfire placed in
Survival starts its fuel (§4.4).

**Middle mouse in Survival** only selects a hotbar slot that holds the targeted block's item. It never conjures one.

**Wearing.** RMB on a wear item swaps it with the worn one. In the pack screen it can also be dragged into its wear slot.
- `pack.insulation()` is the sum of the worn items' `I`.
- `pack.sunShade()` is the largest worn `sunShade`.

### 5.4 The Pack & Making screen (E, §9.8)
**Opening and closing.** E opens it (state `PACK`). Esc or E closes it. R on a basket or a workplace opens it focused on that
basket or workplace. **The world keeps running while it is open** (§9.5): lanes progress, fires cook, vitals drain and zombies
still come.

**Layout: a rosette, not rows.**
- Pack slots 9–26 are a **rosette around a centre hex**: ring 1 is slots 9–14 (6 cells) and ring 2 is slots 15–26 (12 cells),
  each clockwise from the top.
- The **centre hex is not a slot**: it shows the hovered (or cursor) item's icon, name and durability.
- The **hotbar** (slots 0–8) is a 9-cell zig-zag strip under the rosette (cells alternately half a cell up and down), outlined
  in honey.
- The three **wear hexes** form a short chain at the rosette's left (head, body, feet, top to bottom), and the red **discard
  hex** sits bottom-left.
- A **basket** (`BASKET_SLOTS` = 18, also 6 + 12) opens as a **second rosette beside the pack**, replacing the Making panel
  while it is open. It is never stacked above the pack.
- `packUI` exports the pure `rosetteCells(rings) → [q, r][]` (centre excluded, ring by ring, clockwise from the top), with
  ordering tests.

**Mouse rules.** Implemented as the **pure** `slotClick(session, area, index, button, shift)` in inventory.js; the DOM only
forwards clicks. The geometry above never changes these rules.
- **Left click**, empty cursor: pick up the whole stack.
- **Left click**, with a cursor stack:
  - empty slot → put it all;
  - same key → merge up to the stack size, leaving the rest on the cursor;
  - different key → swap.
- **Right click**, empty cursor: pick up half, rounded up.
- **Right click**, with a cursor stack: put 1 into an empty or same-key slot.
- **Wear slots** accept only wear items for that slot.
- **Shift + left** quick-moves:
  - pack → open container, else hotbar ↔ rest of the pack;
  - container → pack;
  - wear → pack.
- **Discard hex** (`area 'discard'`): the cursor stack is destroyed.
- **Closing** with a cursor stack calls `pack.add`. Overflow is lost with the "left behind" message.

*There are no item entities in the world in v1 (§12): everything goes to the pack.*

### 5.5 Creative and switching
- The **creative picker and hotbar are unchanged**: unlimited, block ids, saved in `hotbar` as today.
- The **survival pack is separate** and lives in `survival.pack` / `survival.wear`.
- Neither inventory is ever converted into the other (§1.2).
- `selected` (the hotbar index) is shared by both modes.
- **Survival things are safe from Creative.** In Creative, `breakTargeted` refuses to break a WICKER_BASKET or REMAINS cell
  that `containers.hasItems(q, y, r)`, or a CAMPFIRE or FIRE_PIT whose spots hold anything, with the hint
  `Holds survival items · switch to Survival to empty it`. *Creative breaking is instant; one stray click must not delete a
  Survival player's belongings.*

### 5.6 Containers (`src/containers.js`, class `Containers`)
| Kind | Block | Slots | How it is made | R |
|---|---|---|---|---|
| `basket` | WICKER_BASKET | 18 | Crafted | Opens the pack screen with the basket's rosette beside the pack |
| `remains` | REMAINS ("Your Belongings") | Up to 30 | Death (§2.5) | Takes everything that fits into the pack; when emptied, main writes AIR |

Rules:
- **Placing a basket** (`onBlockChange` with next = WICKER_BASKET) creates an empty basket entry. *In Creative too, so a
  later Survival visit finds an empty basket.*
- **When a container cell changes to anything else**, its entry is removed and the stacks are **released**:
  - into the pack when the player broke it in Survival (main's `releaseToPack` flag around the break);
  - otherwise (blast, collapse, black hole, command) they are lost. Creative breaking is refused while it holds items (§5.5).
- **Limits:** at most `MAX_CONTAINERS` = 1024 entries. Placing a basket beyond that leaves it without storage
  (`Basket · too many containers in this world`). **A death always gets its entry**, beyond the limit.
- **Saving:** entries are saved in `containers` and validated against `edits` the way runes are (§9.6).

=====================================================================================================================
## 6. Harvesting: tools, tiers, break times, drops

### 6.1 Break time
`harvest.breakSeconds(id, tool, underwater)`:
```
rule = BLOCK_RULES[id]                      // null → unbreakable (bedrock, water family)
if rule.tier > 0 and !(tool && tool.type === rule.tool && tool.tier >= rule.tier) → Infinity   // cannot
speed = tool && tool.type === rule.tool ? TIER_SPEED[tool.tier] : 1
seconds = max(0.05, rule.h / speed) × (underwater ? 2.5 : 1)          // underwater = player.headInWater
```
**Holding to dig** (`survivalControl.DigState`, §9.5). Holding LMB on the same cell (q, y, r) and the same block id accumulates
`t`. Any of these resets it:
- a different cell or id;
- releasing the button;
- the hand changing (another slot, or the tool breaking);
- a modal opening.

**Feedback.** While digging:
- **Dig trace.** `renderer.setDigProgress(hit, t/need)` traces the cell's hex outline in honey as you dig (§9.9). *There are no
  crack textures.*
- **Action ring.** The hex ring around the crosshair fills with `t/need`.
- **Every `DIG_TICK_S`** (0.25 s): `audio.playDig(soundGroup, 0.35)` and 3 `dust` particles coloured by the block
  (`{ id }`) at the hit face.

**Finishing** (when `t ≥ need`), in this order:
1. `const natural = !world.hasEdit(q, y, r);` — **before** the break. *The AIR write records an edit, so checking afterwards
   would make every natural drop impossible, and with it all flint.*
2. `const drops = harvest.rollDrops(id, tool, { natural, knifeInPack }, random);`
3. If `!pack.canGive(drops)`: the block is **not** broken, the hint says `Pack full`, and the dig stays complete (it finishes
   as soon as there is room and the button is still held).
4. Break the cell with `playerSetBlock(…, AIR)` inside `releaseToPack = true`.
5. `playBreak`; give the drops (each flies to its slot as a hex token, §9.8).
6. The selected tool takes 1 wear.

**When a block cannot be harvested** (`need = Infinity`):
- the hint reads `Iron Ore · needs a bronze pick or better`;
- holding LMB plays a dull `playDig(group, 0.15)` every 0.5 s and nothing else happens.

**Mobs.** LMB on a pig or zombie strikes on the press. Holding repeats every `ATTACK_REPEAT_S` = 0.55 s. *That is longer than
`PIG_HURT_S` (0.5) and `ZOMBIE_HURT_S` (0.45), so no repeat lands inside an invulnerability window by rounding.*
- **Zombies:** `zombies.hit(zb, x, z, power)` (bare hands: power 1).
- **Pigs:** with a tool selected, `pigs.wound(pig, power, x, z)`; bare-handed, `pigs.hit(pig, x, z)` only.
- Each hit that lands costs the selected tool 1 wear. **Lit barrels**: a click snuffs them, as today.

### 6.2 The first tools
1. **Bare hands** can break dirt, sand, gravel, clay, snow, leaves, plants, ground litter and glass:
   - **loose stones** → 1–2 Rock and a 50 % chance of Flint (natural cells only);
   - **fallen branches** → 2–3 Sticks;
   - gravel → 2 Rock;
   - tussock → 1–2 Plant Fibre.
2. **Hand-made at once:** Cord (2 fibre) and a **Hammerstone** (1 rock). With the hammerstone: the **Stone Chopper** (2 rock, an
   axe of tier 1, which fells trees and lops branches) and the knapped flint tools — Knife, Axe, Spade, Spear and **Flint Pick**
   (tier 2: stone, coal, copper ore, obsidian and gems). Also the Fire Drill.
3. **Felling:** a log needs an axe of at least tier 1. Stone needs a pick of at least tier 2. *There is no stone pick, so a
   flint pick is the first way into rock, as in prehistory.*

### 6.3 `BLOCK_RULES`
Columns:
- **h** = seconds by hand;
- **tool** = the preferred type;
- **tier** = the minimum tier with that tool (0 = hands allowed).

**Drops notation.** Drops are written as groups separated by `·`. Each group gives at most one **branch**, the first whose
condition holds: `spade → …; knife → …; else → …`. A group with no condition always gives. Conditions:
- a tool type (`spade`, `knife`, `axe`, `pick`) — the selected tool has that type;
- `knife in pack` — a knife of tier ≥ 2 is anywhere in the pack;
- `natural` (on an item) — only if the cell had no edit **before** the break (§6.1). *Chance drops come only from untouched
  cells, so placing a block and digging it again cannot farm them.*

`[a,b]` is a uniform integer range; `p` is a chance. "Self" means the block's own item.

`harvest.rollDrops(id, tool, { natural, knifeInPack }, random) → ItemStack[]` (aggregated by key).

| Blocks | h | tool | tier | Drops |
|---|---|---|---|---|
| DIRT | 0.9 | spade | 0 | self |
| GRASS_BLOCK | 1.0 | spade | 0 | spade → self; else → dirt + plant_fibre p 0.2 natural |
| SNOWY_GRASS | 1.0 | spade | 0 | spade → self; else → dirt + snow 1 natural |
| SAND, RED_SAND | 0.8 | spade | 0 | self |
| GRAVEL | 1.2 | spade | 0 | spade → self; else → rock 2 |
| CLAY | 1.4 | spade | 0 | clay_lump 6 |
| SNOW_BLOCK | 0.5 | spade | 0 | snow 6 |
| ICE | 1.0 | pick | 0 | pick → ice_chunk 2; else → ice_chunk 1 |
| PACKED_ICE | 2.0 | pick | 2 | ice_chunk 3 |
| LOOSE_STONES | 0.2 | — | 0 | rock [1,2] · flint p 0.5 natural |
| FALLEN_BRANCHES | 0.2 | — | 0 | stick [2,3] |
| OAK_LEAVES, SPRUCE_LEAVES, BIRCH_LEAVES | 0.4 | axe | 0 | axe → self + stick 1 natural; else → nothing · oak: acorns p 0.08 natural · spruce: pine_nuts p 0.08 natural |
| HONEYBERRY_BUSH | 0.5 | spade | 0 | spade → honeyberry_bush · honeyberries [2,4] · stick [1,2] |
| HONEYBERRY_BUSH_BARE | 0.5 | spade | 0 | spade → honeyberry_bush · stick [1,2] |
| PRICKLY_PEAR | 0.5 | spade | 0 | spade → prickly_pear · knife in pack → cactus_fruit [1,2]; else → unpeeled_cactus_fruit [1,2] |
| PRICKLY_PEAR_BARE | 0.5 | spade | 0 | spade → prickly_pear |
| TUSSOCK | 0.2 | knife | 0 | spade → self; knife → plant_fibre [2,3]; else → plant_fibre [1,2] |
| CATTAILS | 0.3 | knife | 0 | spade → self; knife → plant_fibre 3 + cattail_root p 0.5; else → plant_fibre 2 + cattail_root p 0.3 |
| TUBER_PLANT | 0.4 | spade | 0 | spade → wild_tuber [2,3] + plant_fibre 1; else → wild_tuber 1 + plant_fibre 1 |
| OAK_LOG, SPRUCE_LOG | 3.0 | axe | 1 | self |
| BIRCH_LOG | 3.0 | axe | 1 | self · birch_bark p 0.5 natural |
| *_PLANKS, BOOKSHELF | 2.0 / 1.5 | axe | 1 | self |
| WORK_STUMP | 2.5 | axe | 1 | self |
| WICKER_BASKET | 0.8 | axe | 0 | self (+ contents, §5.6) |
| BLAST_BARREL, PUMPKIN | 2.0 / 1.0 | axe | 1 / 0 | self |
| HAY_BALE, WOOL_* (16), HONEYCOMB_BLOCK, SLEEPING_HIDE | 0.8 / 0.8 / 0.8 / 0.5 | knife | 0 | self |
| REMAINS | 0.3 | — | 0 | contents (§5.6) |
| CAMPFIRE | 0.5 | — | 0 | rock 4 (+ spots) |
| FIRE_PIT | 0.5 | — | 0 | rock 4 · charcoal 1 (+ spots) |
| GLASS | 0.5 | — | 0 | glass_shards [1,2] |
| GLOWSTONE | 1.0 | pick | 0 | self |
| BLACK_HOLE | 1.0 | — | 0 | nothing |
| KILN | 3.0 | pick | 0 | self |
| BLOOMERY, FORGE | 4.0 / 5.0 | pick | 2 | self |
| STONE | 3.0 | pick | 2 | rock 2 · flint p 0.05 natural |
| COBBLESTONE, MOSSY_COBBLESTONE, STONE_BRICKS, MOSSY_STONE_BRICKS, BRICKS | 3.0 | pick | 2 | self |
| GRANITE, DIORITE, ANDESITE, SLATE | 3.5 | pick | 2 | self |
| SANDSTONE | 2.0 | pick | 2 | self |
| OBSIDIAN | 2.5 | pick | 2 | obsidian_shard [2,3] |
| RUNE_BLOCK | 2.0 | pick | 2 | self (its script is lost, as today) |
| COAL_ORE | 3.5 | pick | 2 | coal [1,2] |
| COPPER_ORE | 4.0 | pick | 2 | malachite [1,2] |
| TIN_ORE | 4.0 | pick | 3 | cassiterite 1 · cassiterite p 0.25 |
| IRON_ORE | 5.0 | pick | 4 | hematite [1,2] |
| GOLD_ORE | 5.0 | pick | 4 | gold_nugget [1,2] |
| DIAMOND_ORE | 4.0 | pick | 2 | rough_gem 1 |
| COAL_BLOCK, COPPER_BLOCK, GOLD_BLOCK, IRON_BLOCK, DIAMOND_BLOCK | 4.0 / 5.0 / 5.0 / 6.0 / 5.0 | pick | 2 | self |
| BEDROCK, WATER family | — | — | — | unbreakable (`null` rule) |

*Obsidian is brittle volcanic glass, and gems sit in soft host rock: any pick that cuts stone breaks them. A packed storage
block comes apart with any pick. The Hollow Watcher's obsidian pillars (watcher.js) are therefore ordinary rock in Survival;
obsidian's blast-proofing is unchanged.*

**Example times:**

| Block | Tool | Time |
|---|---|---|
| Dirt | Hand | 0.9 s |
| Dirt | Digging stick | 0.6 s |
| Log | Stone chopper | 2.0 s |
| Log | Flint axe | 1.5 s |
| Log | Steel axe | 0.5 s |
| Stone | Flint pick | 1.5 s |
| Stone | Bronze pick | 0.88 s |
| Iron ore | Bronze pick | 1.47 s |
| Obsidian | Flint pick | 1.25 s |

**Mob drops** (`MOB_DROPS`) go straight into the pack:
- pig: raw_pork [2,3], rawhide 1, pig_fat p 0.6;
- zombie (knocked out by the player): grave_rag p 0.5.

### 6.4 Picking and tapping (R)
`PICKABLE` table (`harvest.pick(id, { natural, knifeInPack }, random)` → `{ to, drops } | null`):
- HONEYBERRY_BUSH → HONEYBERRY_BUSH_BARE, honeyberries [2,4];
- PRICKLY_PEAR → PRICKLY_PEAR_BARE, knife in pack → cactus_fruit [1,2]; else → unpeeled_cactus_fruit [1,2];
- LOOSE_STONES → AIR, rock [1,2] · flint p 0.5 natural;
- FALLEN_BRANCHES → AIR, stick [2,3].

Main computes `natural` before the write, checks `pack.canGive(drops)` (else the hint `Pack full`), writes `to` with
`playerSetBlock`, adds the drops, plays `audio.playPick()` and emits 4 `leaves` particles (`dust` for stones).

**Tapping.** `harvest.tap(id, selectedKey, knifeInPack) → { gives: 'pot_sap', takes: 'clay_pot', wears: 'knife' } | null`
(BIRCH_LOG only). `new harvest.Tapped()` has `canTap(key, day)`, `mark(key, day)` and `clear()`; it is not saved.

### 6.5 Regrowth
`harvest.Regrowth` tracks every HONEYBERRY_BUSH_BARE / PRICKLY_PEAR_BARE cell, at most `MAX_REGROW_TRACKED` = 4096:
- `onBlockChange`;
- `loadFromEdits(world.edits)` (bare bushes are always edits);
- `clear()`.

**Stepping** (Survival active only): main accumulates `dt` and calls `step(1, random, isLoadedCell)` once per second. It returns
the cells to regrow. Each tracked cell in a loaded chunk regrows with probability `1 / REGROW_MEAN_S` per step (600 s: one game
day on average). Main writes the ripe id lazily (`world.setBlock(q, y, r, ripe, true)`). *Writing back the generated id prunes
the edit, so regrown wild bushes cost no save space.*

Loose stones, fallen branches and plants that were broken do not come back.

=====================================================================================================================
## 7. Making

### 7.1 Workplaces
| Station id | Block | Made by | Hot while working |
|---|---|---|---|
| `hand` | — (always) | — | no |
| `stump` | WORK_STUMP "Work Stump" | hand: 1 log, needs an axe tier 1 | no |
| `kiln` | KILN "Kiln" | hand: 8 clay_lump + 6 rock | yes (12 °C, r 4) |
| `bloomery` | BLOOMERY "Bloomery" | hand: 18 fired_brick + 3 clay_lump + 1 bellows | yes (16 °C, r 4) |
| `forge` | FORGE "Forge" | hand: 24 fired_brick + 3 wrought_iron + 1 bellows | yes (22 °C, r 5) |

*A bloomery reaches iron-smelting heat only with forced air, so it needs bellows too; leather gains a mid-game use.*

A workplace is **near** when its block lies within hex distance `STATION_RANGE` = 3 of the player's feet cell and within
|dy| ≤ 2. `crafting.findStations(getBlock, q, y, r)` scans those 37 columns × 5 heights and returns
`{ hand: true, stump?: [q,y,r], kiln?: [q,y,r], bloomery?: [q,y,r], forge?: [q,y,r] }` (the nearest of each). Main refreshes it
every 0.5 s and when the pack screen opens, and feeds the positions to `climate.heatAt`.

### 7.2 Rules
**Recipes.** `Recipe = { id, station, inputs: [{k|tag, n}], outputs: [{k, n}], tools?: [{type, tier}], seconds }`.

**Packing counts.** A recipe that packs many of one thing into a block uses **3, 6 or 7** — a hex's axes, its sides, or a
rosette of one centre and six — or **12**, a second ring, for loose fibre; it **never uses 4 or 9**. *4 and 9 are the fingerprints of a 2×2 and 3×3 grid.* No recipe in
§7.3 reproduces another game's recipe.

**Lanes.** Each station has its own lane: `hand`, `stump`, `kiln`, `bloomery`, `forge`. The first job of every lane runs at the
same time as the others. A waiting job blocks only the jobs behind it in its own lane, never another lane or the hand lane.
*One serial queue meant about 100 real minutes standing beside stations to reach steel, and a waiting kiln job blocked an
emergency bandage.*

**Queueing** (`CraftQueue.enqueue`). A job can be queued when:
- its station is **near** (`STATION_RANGE`); the job remembers that station's cell as `at` (hand jobs have none);
- the pack holds the inputs of **every queued job in every lane plus this one** (reservation check);
- the pack holds the required tools.

**Reservation allocation.** For the list `[...queued, new]` in queue order, first allocate exact keys for all jobs, then tags
from what remains, taking tag members in `TAGS` order.

Limits and buttons:
- At most `MAX_CRAFT_JOBS` = 8 jobs across all lanes.
- The ×5 button queues up to 5.

**Running.**
- A lane's head job advances while its station cell still holds that station block and lies within hex distance
  `STATION_WORK_RANGE` = 16 of the player's feet column, at any height. Otherwise it is *waiting* (`Kiln too far`).
  *You can tend a fire, fetch water or dig clay while the kiln works.*
- Hand jobs never wait for range.
- If the station block is gone, the job fails: *"Couldn't make Charcoal: the Kiln is gone."*
- The lanes keep running with the pack screen open or closed. The HUD job chip shows the job that finishes soonest,
  `Kiln · Copper Ingot 12 s`, with `+2` when two more lanes are busy.

**Completing.** When a job's timer ends, it completes atomically:
1. If the pack cannot take the outputs (`canGive`), it waits (`Pack full`).
2. If the inputs or tools are missing, it fails and is dropped: *"Couldn't make Copper Ingot: missing Malachite."*
3. Otherwise it takes the inputs, uses the tools (1 wear each, which may break them), gives the outputs and calls
   `audio.playCraft()`.

*Inputs are consumed only on completion, so the lanes never need saving or refunding. They are not saved: a reload or a death
simply drops them, and nothing is lost.*

**Recipe list order:**
1. craftable now;
2. then by the number of missing input units;
3. then recipe order.

Recipes for a station that is not near are listed greyed with `build a Kiln nearby`. *The list doubles as the tech tree, so you
always see what comes next.*

### 7.3 Recipes
Notation:
- `#tag` means any member of that tag;
- tools are written `axe≥1`, meaning an axe of tier 1 or better; every listed tool takes 1 wear per completed job;
- the last column is seconds.

**Hand** (37)

| id | inputs → outputs | tools | s |
|---|---|---|---|
| cord | 2 plant_fibre → cord | | 1 |
| hammerstone | rock → hammerstone | | 1 |
| stone_chopper | 2 rock → stone_chopper | hammer≥1 | 3 |
| digging_stick | stick → digging_stick | axe≥1 | 2 |
| flint_knife | #knapstone + stick + cord → flint_knife | hammer≥1 | 3 |
| flint_axe | #knapstone + stick + cord → flint_axe | hammer≥1 | 4 |
| flint_pick | 2 #knapstone + stick + 2 cord → flint_pick | hammer≥1 | 5 |
| flint_spade | #knapstone + stick + cord → flint_spade | hammer≥1 | 4 |
| flint_spear | #knapstone + 2 stick + cord → flint_spear | hammer≥1 | 3 |
| fire_drill | 2 stick + cord → fire_drill | | 2 |
| campfire | 6 rock + 3 stick + #tinder → campfire | firestarter≥0 | 5 |
| cobblestone | 6 rock → cobblestone | | 2 |
| clay | 6 clay_lump → clay | | 2 |
| greenware_pot | 3 clay_lump → greenware_pot | | 4 |
| green_brick | 3 clay_lump → 3 green_brick | | 2 |
| greenware_crucible | 3 clay_lump → greenware_crucible | | 4 |
| greenware_mold | 3 clay_lump → greenware_mold | | 3 |
| kiln | 8 clay_lump + 6 rock → kiln | | 8 |
| work_stump | #log → work_stump | axe≥1 | 4 |
| straw_hat | 6 plant_fibre → straw_hat | | 6 |
| grass_cape | 10 plant_fibre + 2 cord → grass_cape | | 10 |
| fibre_bandage | 3 plant_fibre → fibre_bandage | | 2 |
| rag_bandage | 2 grave_rag + pot_boiled → rag_bandage + clay_pot | | 2 |
| wicker_basket | 6 stick + 12 plant_fibre → wicker_basket | | 8 |
| hay_bale | 12 plant_fibre → hay_bale | | 6 |
| pot_snow | clay_pot + 3 snow → pot_snow | | 1 |
| pot_snow_ice | clay_pot + 2 ice_chunk → pot_snow | | 1 |
| scrape_salt | salt_pot → salt + clay_pot | | 1 |
| salted_pork | raw_pork + salt → salted_pork | | 2 |
| leached_acorns | 6 acorns + pot_water → 6 leached_acorns + clay_pot | | 2 |
| peel_cactus_fruit | unpeeled_cactus_fruit → cactus_fruit | knife≥2 | 1 |
| snow_block | 6 snow → snow_block | | 1 |
| ice | 3 ice_chunk → ice | | 1 |
| coal_block | 7 coal → coal_block | | 2 |
| bricks | 6 fired_brick + clay_lump → bricks | | 3 |
| bloomery | 18 fired_brick + 3 clay_lump + bellows → bloomery | | 12 |
| forge | 24 fired_brick + 3 wrought_iron + bellows → forge | | 15 |

*Boiling the rags first: a rag from a corpse is septic.*

**Work Stump** (12)

| id | inputs → outputs | tools | s |
|---|---|---|---|
| oak_planks / spruce_planks / birch_planks | 1 matching log → 3 planks | axe≥2 | 3 |
| split_sticks | #log → 6 stick | axe≥1 | 3 |
| leather | rawhide + pig_fat → leather | knife≥2 | 8 |
| leather_salt | rawhide + salt → leather | knife≥2 | 8 |
| leather_hood | 2 leather + cord → leather_hood | knife≥2 | 6 |
| leather_coat | 5 leather + 2 cord → leather_coat | knife≥2 | 12 |
| hide_shoes | 2 leather + 2 plant_fibre + cord → hide_shoes | knife≥2 | 6 |
| sleeping_hide | 2 leather + 6 plant_fibre + 6 stick → sleeping_hide | knife≥2 | 8 |
| bellows | 3 leather + 3 #planks + cord → bellows | knife≥2 | 10 |
| stone_bricks | 6 rock → stone_bricks | hammer≥3 | 4 |

*Riving a log into sticks is real work at a stump; there is no planks-to-sticks shortcut.*

**Kiln** (21; every recipe burns fuel)

| id | inputs → outputs | tools | s |
|---|---|---|---|
| charcoal | 6 #log → 8 charcoal | | 40 |
| clay_pot | greenware_pot + #fuel → clay_pot | | 15 |
| fired_brick | 6 green_brick + #fuel → 6 fired_brick | | 30 |
| crucible | greenware_crucible + #fuel → crucible | | 25 |
| casting_mold | greenware_mold + #fuel → casting_mold | | 20 |
| copper_ingot | 2 malachite + 2 #fuel → copper_ingot | | 30 |
| tin_ingot | 2 cassiterite + #fuel → tin_ingot | | 20 |
| bronze_ingot | 7 copper_ingot + tin_ingot + 3 #fuel → 8 bronze_ingot | crucible | 45 |
| copper_block | 7 copper_ingot + #fuel → copper_block | crucible | 30 |
| gold_block | 7 gold_nugget + 2 #fuel → gold_block | crucible | 40 |
| copper_{knife,spade,axe,hammer,pick} | N copper_ingot + S stick + #fuel | crucible, mold | 25 |
| bronze_{knife,spade,axe,hammer,pick,sword} | N bronze_ingot + S stick + #fuel | crucible, mold | 30 |

*In the charcoal job the logs themselves smoulder; it takes no other fuel. Bronze is 7 : 1, 12.5 % tin, the classic tool
bronze; a full bronze kit (11 ingots) is two batches. Casting a tool remelts ingots, so it needs the crucible as well as the
mold.*

**Bloomery** (4)

| id | inputs → outputs | tools | s |
|---|---|---|---|
| iron_bloom | 3 hematite + 4 charcoal → iron_bloom | | 40 |
| wrought_iron | iron_bloom + charcoal → wrought_iron | hammer≥4 | 25 |
| glass | 2 #sand + salt + charcoal → glass | | 25 |
| remelt_glass | 3 glass_shards + charcoal → glass | | 15 |

*Sand alone needs about 1 700 °C, far beyond a pottery kiln; salt acts as the flux.*

**Forge** (15; charcoal only: *carbon matters for iron*)

| id | inputs → outputs | tools | s |
|---|---|---|---|
| iron_{knife,spade,axe,hammer,pick,sword} | N wrought_iron + S stick + charcoal | hammer≥4 | 30 |
| steel_bar | wrought_iron + 2 charcoal → steel_bar | hammer≥5 | 45 |
| steel_{knife,spade,axe,hammer,pick,sword} | N steel_bar + S stick + charcoal | hammer≥5 | 40 |
| iron_block | 7 wrought_iron → iron_block | hammer≥4 | 20 |
| diamond_block | 7 rough_gem → diamond_block | hammer≥6 | 20 |

**Metal tool amounts.** In the table rows above, N is the metal and S the sticks:

| Tool | N | S |
|---|---|---|
| knife | 1 | 1 |
| spade | 1 | 1 |
| axe | 2 | 1 |
| hammer | 2 | 1 |
| pick | 2 | 2 |
| sword | 3 | 1 |

Each metal tool recipe's id is its item key, for example `copper_pick`. There are **89 recipes**: 37 at hand, 12 at the stump,
21 at the kiln, 4 at the bloomery and 15 at the forge. Ids are unique (tested).

**How long the metal ages take.** With lanes and the 16-cell work range, the minimal path from the first bloom to a steel kit
(16 wrought iron, about 110 charcoal in 14 kiln jobs) is roughly 30 minutes of lane time, spread over three lanes that run while
the player gathers ore, fuel and food nearby.

### 7.4 The progression, and why each gate is real
1. **Hands.** Loose stones give rock and flint, fallen branches give sticks, tussock gives fibre. Bushes, ponds, birch sap and
   nuts give food and water.
2. **Stone, flint and fire.**
   - Tools: **Hammerstone → Stone Chopper → knapped flint tools** (knife, axe, spade, spear and **pick**). *Flint is knapped
     with a hammerstone; there is no way around the stone step.*
   - Fire: the Fire Drill, then a campfire, for warmth, cooking and boiling. It must be fed.
3. **Wood, hide and clay.**
   - The Work Stump: planks, split sticks, leather, clothing, the Sleeping Hide and bellows.
   - Clay from pond beds and coasts makes greenware pots, pit-fired in the campfire, and then a Kiln.
4. **Copper.**
   - A flint pick mines Copper Ore (malachite) and coal.
   - The Kiln makes charcoal, smelts copper ingots, and casts copper tools in a crucible and a fired mold.
5. **Bronze.** A **copper pick** is needed for Tin Ore (cassiterite). Then 7 copper + 1 tin in a crucible makes 8 bronze, and
   bronze tools follow.
6. **Iron.**
   - A **bronze pick** is needed for Iron Ore (hematite).
   - Fired bricks and bellows build a **Bloomery**, which turns hematite and charcoal into an iron bloom.
   - A **bronze hammer** shingles the bloom into Wrought Iron.
7. **Steel.**
   - The Forge is built from bricks, a wrought-iron anvil and leather bellows. It makes iron tools with a bronze hammer.
   - An **iron hammer** then lets the Forge turn wrought iron and charcoal into **Steel**, then steel tools.
   - Steel brings speed (`TIER_SPEED` 6) and durability, not exclusive blocks. *Obsidian and gems need only a flint pick.*

### 7.5 A first day, as playtested on paper
**The starting kit**, counted: Hammerstone, Stone Chopper, Flint Knife, Flint Axe, Flint Pick, Fire Drill and a Campfire need
**9 rock, 4 knapstone, 11 plant fibre** (5 cord and 1 tinder) **and 8 sticks**, and 28 s of hand jobs. The flint spade and spear
(2 more flint) can wait for day two.

Times are real time from a new world's 07:12 start (1 game hour = 25 s), on plains:
- **0:00 (07:12), spawn.** Pull 8 tussocks (0.2 s each, about 12 fibre). On the way, pick up loose stones and dig 3 gravel tops
  by hand (1.2 s each): about 10 rock and 1–2 flint, all within 10 cells.
- **1:00 (09:36).** Hammerstone, Stone Chopper and 5 Cord (9 s of hand jobs, made while walking). Lop 8 leaf cells with the
  chopper (0.27 s each) for 8 sticks.
- **1:00–2:30.** Walk a 15-cell circle for more loose stones. Plains hold about 1.2 % of them, so ≈ 9 lie within 15 cells: about
  4 flint in all. Eat honeyberries on the way, and drink at a pond by hand.
- **2:30 (13:12).** Flint knife, axe and pick (12 s); a fire drill and a campfire beside the pond (7 s). The fire starts with
  300 s of fuel, enough until 01:12.
- **3:00–4:30 (14:24–18:00).** The chopper kills a pig in three hits; two pork on the skewers roast in 20 s. Fell a tree with
  the flint axe (1.5 s a log) and make a Work Stump. Dig clay at the pond bed (6 lumps a cell) and set a greenware pot in the
  embers (60 s).
- **Dusk, 4:30 (18:00).** Zombies come, so stay inside the fire's 4-cell safe zone (§39, unchanged). Feed it one log (+300 s),
  which carries it past the next noon. Plains nights are cool but comfortable by the fire.

Integration test I-2 (§10) is built from these counts and times.

=====================================================================================================================
## 8. Blocks, tiles and world generation 2

### 8.1 New blocks (ids 76–94, appended; `BLOCK_COUNT = 95`)

| id | `BLOCK` key | name / displayName | Flags (beyond `def` defaults) | tiles(side, top, bottom) | Placeable |
|---|---|---|---|---|---|
| 76 | COPPER_ORE | copper_ore / Copper Ore | sound stone | COPPER_ORE | yes |
| 77 | TIN_ORE | tin_ore / Tin Ore | sound stone | TIN_ORE | yes |
| 78 | HONEYBERRY_BUSH | honeyberry_bush / Honeyberry Bush | PLANT | HONEYBERRY_BUSH | yes |
| 79 | HONEYBERRY_BUSH_BARE | honeyberry_bush_bare / Picked Honeyberry Bush | PLANT | HONEYBERRY_BUSH_BARE | **no** |
| 80 | TUSSOCK | tussock / Tussock Grass | PLANT, sound grass | TUSSOCK, PLANT_TOP_CLEAR, PLANT_TOP_CLEAR | yes |
| 81 | CATTAILS | cattails / Cattails | PLANT, sound grass | CATTAILS_SIDE, CATTAILS_TOP | yes |
| 82 | TUBER_PLANT | tuber_plant / Wild Tuber Plant | PLANT, sound grass | TUBER_PLANT, PLANT_TOP_CLEAR, PLANT_TOP_CLEAR | yes |
| 83 | PRICKLY_PEAR | prickly_pear / Prickly Pear | PLANT | PRICKLY_PEAR | yes |
| 84 | PRICKLY_PEAR_BARE | prickly_pear_bare / Picked Prickly Pear | PLANT | PRICKLY_PEAR_BARE | **no** |
| 85 | WORK_STUMP | work_stump / Work Stump | sound wood | STUMP_SIDE, STUMP_TOP, OAK_LOG_END | yes |
| 86 | KILN | kiln / Kiln | sound stone | KILN_SIDE, KILN_TOP | yes |
| 87 | BLOOMERY | bloomery / Bloomery | sound stone | BLOOMERY_SIDE, BLOOMERY_TOP | yes |
| 88 | FORGE | forge / Forge | sound stone | FORGE_SIDE, FORGE_TOP | yes |
| 89 | WICKER_BASKET | wicker_basket / Wicker Basket | sound wood | BASKET_SIDE, BASKET_TOP | yes |
| 90 | SLEEPING_HIDE | sleeping_hide / Sleeping Hide | sound cloth | HIDE_SIDE, HIDE_TOP | yes |
| 91 | REMAINS | remains / Your Belongings | PLANT flags, sound cloth | REMAINS_SIDE, REMAINS_TOP | **no** |
| 92 | LOOSE_STONES | loose_stones / Loose Stones | PLANT flags, sound stone | LOOSE_STONES, PLANT_TOP_CLEAR, PLANT_TOP_CLEAR | **no** |
| 93 | FALLEN_BRANCHES | fallen_branches / Fallen Branches | PLANT flags, sound wood | FALLEN_BRANCHES, PLANT_TOP_CLEAR, PLANT_TOP_CLEAR | **no** |
| 94 | FIRE_PIT | fire_pit / Cold Fire Pit | PLANT flags, sound stone | FIRE_PIT_SIDE, PLANT_TOP_CLEAR, PLANT_TOP_CLEAR | **no** |

**PLANT** = `solid: false, opaque: false, layer: LAYER_CUTOUT, cullSame: false, soundGroup: 'leaves'` unless a sound is given.
"PLANT flags" means the same flags on a block that is not a plant.
- **Physics:** these blocks are walk-through and not load-bearing (`isLoadBearing` already needs `solid`).
- **Placing:** they are **not** replaceable, so a block cannot be placed into one; break it first.
- **Falling blocks:** they are not fall-through, so sand rests on them. *Changing `isFallThrough` would ripple through fluids,
  explosions and fallers; that is not worth it for v1.*
- **Short blocks' tops.** The mesher draws the top hexagon at y + 1 toward AIR, so a short plant's art there would float as a
  mat a whole cell up. TUSSOCK, TUBER_PLANT, LOOSE_STONES, FALLEN_BRANCHES and FIRE_PIT therefore use the all-transparent
  `PLANT_TOP_CLEAR` for top and bottom.
- **FIRE_PIT** is a meshed cutout block: campfires.js, the campfire renderer and the zombie safe zone never see it.

**`PICKER_ORDER`** inserts the 13 placeable ids into their groups (80 in all); RUNE_BLOCK and WATER stay last:
- "minerals": COPPER_ORE and TIN_ORE right after DIAMOND_ORE;
- "earth": TUSSOCK, CATTAILS, TUBER_PLANT, HONEYBERRY_BUSH, PRICKLY_PEAR right after PUMPKIN;
- "special": WORK_STUMP, KILN, BLOOMERY, FORGE, WICKER_BASKET, SLEEPING_HIDE right before CAMPFIRE.

**New predicates and lists** (blocks.js):
- `isPlant(id)`: the 7 PLANT ids (78–84), `PLANT_IDS`;
- `isLitter(id)`: LOOSE_STONES, FALLEN_BRANCHES;
- `isPopOff(id)`: CAMPFIRE, FIRE_PIT, `isPlant` or `isLitter`, `POP_OFF_IDS` (11 ids). It breaks when the cell below becomes
  fall-through (§8.5);
- `isStation(id)`: WORK_STUMP, KILN, BLOOMERY, FORGE;
- `isContainerBlock(id)`: WICKER_BASKET, REMAINS.

**New tiles 77–104** (`TILE` keys; tile ids are free per §16):

| Tile id | Key | Tile id | Key | Tile id | Key | Tile id | Key |
|---|---|---|---|---|---|---|---|
| 77 | COPPER_ORE | 84 | TUBER_PLANT | 91 | BLOOMERY_SIDE | 98 | HIDE_TOP |
| 78 | TIN_ORE | 85 | PRICKLY_PEAR | 92 | BLOOMERY_TOP | 99 | REMAINS_SIDE |
| 79 | HONEYBERRY_BUSH | 86 | PRICKLY_PEAR_BARE | 93 | FORGE_SIDE | 100 | REMAINS_TOP |
| 80 | HONEYBERRY_BUSH_BARE | 87 | STUMP_SIDE | 94 | FORGE_TOP | 101 | PLANT_TOP_CLEAR |
| 81 | TUSSOCK | 88 | STUMP_TOP | 95 | BASKET_SIDE | 102 | LOOSE_STONES |
| 82 | CATTAILS_SIDE | 89 | KILN_SIDE | 96 | BASKET_TOP | 103 | FALLEN_BRANCHES |
| 83 | CATTAILS_TOP | 90 | KILN_TOP | 97 | HIDE_SIDE | 104 | FIRE_PIT_SIDE |

`TILE_IDS` grows from 87 to **115**. The atlas comment "Reserved tiles (27–254)" is corrected. *There are no crack-stage
tiles: digging progress is traced on the cell outline (§9.9).*

### 8.2 Tile art (procedural recipes in tiles.js; original designs)
All tiles use alpha 255 except where noted (alpha 0 means fully transparent).

**Ores** (on `paintOre`):
- **Copper Ore:** stone with **malachite**-green banded blobs (#2f8f5b / #1f6b43 / highlight #6fd39a) and 2–3 copper-orange
  specks (#c8743a).
- **Tin Ore:** stone with dark brown-black **cassiterite** crystals (#2a211c / #4a3a30) and single-pixel white glints.

**Plants and litter.** These are full prisms; the art makes them read as plants. Transparent space is alpha 0. *A side tile
whose upper rows are transparent makes a short plant out of a full cell.*

| Tile | Art |
|---|---|
| Honeyberry Bush | Like `paintLeaves`, but a deeper blue-green, with 6–8 clusters of **elongated dusky-blue berries** (#3b4a8a / #5b6bb0) with a pale bloom (#9aa6d6) |
| Honeyberry Bush (Picked) | The same bush, sparser, no berries |
| Tussock | Vertical blades in rows 4–15, straw-green fading to yellow tips; about 45 % alpha 0 |
| Cattails (side) | Stalks with brown cattail heads in rows 1–4 |
| Cattails (top) | Only sparse leaf tips; mostly alpha 0 |
| Wild Tuber Plant | A low leafy rosette in rows 9–15; rows 0–8 alpha 0 |
| Prickly Pear | Oval pads (#5d8f3a) with spine dots and red-yellow fruit; the picked tile has no fruit |
| Loose Stones | Rows 11–15: a low scatter of grey and ochre pebbles with one dark flint nodule; rows 0–10 alpha 0 |
| Fallen Branches | Rows 12–15: two or three crossed brown sticks with pale lichen flecks; rows 0–11 alpha 0 |
| Fire Pit (side) | Rows 10–15: a ring of grey stones with charred stick ends and pale ash between them; rows 0–9 alpha 0 |
| Plant top (clear) | Every pixel alpha 0 |

**Workplaces and other blocks:**

| Block | Side | Top |
|---|---|---|
| Work Stump | Bark with a pale axe notch | Growth rings scored with chop marks |
| Kiln | Clay-orange coil courses with a dark arched mouth and an ember line | A smoke vent |
| Bloomery | A tall brick stack with dark slag dribbles and a tuyère hole | A throat full of charcoal with a dim glow |
| Forge | A brick hearth with a coal-glow opening | A dark iron **hexagonal** anvil face on bricks |
| Wicker Basket | A diagonal straw weave | A lid with a cord knot |
| Sleeping Hide | A low hide edge with stake heads along it | A hide pegged out at six corner stakes: a hexagon |
| Your Belongings | A hide-wrapped heap tied in a **hex knot**, with a tall marker stick carrying a **honey-coloured hex tag** at the top rows (visible from about 20 cells); background alpha 0 | The marker's tag seen from above: a small honey hex knot at the centre; the rest alpha 0 (*the top face sits a cell up, so it must stay small*) |

### 8.3 Generation 2 (`createWorldGen(seed, { gen = 1 })`)
With `gen: 1` (the default) output is **byte-identical to today**: no caller or test changes. Generation 2 adds the following,
in this order inside `generateChunk`:
1. **Ores.** Rows appended after the existing six, so `oi` values 0–5 and every existing vein are unchanged.
   `ORE_TABLE_GEN2` holds:
   - `{ COPPER_ORE, attempts 10, y 30–80, size 4–8 }`;
   - `{ TIN_ORE, attempts 4, y 20–64, size 3–6 }`;
   - `{ CLAY, attempts 3, y 52–62, size 6–12, replaces: [SAND, GRAVEL, DIRT] }`.

   `placeOreCell` gains the optional `replaces` set (default `[STONE]`). *Copper sits high enough to show in cliffs; tin is
   rarer and deeper; clay sits under coasts and ponds.*
2. **Ponds**, before trees (§8.4).
3. **Trees** (`placeTrees`):
   - **Species.** `SNOWY` → spruce. `FOREST` → birch when `((hsh >>> 24) & 3) === 0`, else oak. Everything else → oak. *Mind
     the parentheses: `x & 3 === 0` parses as `x & false`.*
   - **Stamping.** `stampTree(blocks, …, logId, leafId)`; generation 1 passes oak.
   - **`treeTrunkAt(kq, kr)`** is exactly the gen-1 acceptance test (hash jitter, `TREE_DENSITY` roll, height ≥ SEA_LEVEL + 2,
     room for the canopy), factored out of `placeTrees`. **It never consults `pondAt`.** Ponds reject trunks (§8.4); trees never
     look at ponds, so the two cannot recurse.
4. **Surface pass** (new `placeFlora`).
   - **Which columns.** Each column of the chunk whose generated top (`heights[ci]`) is the expected surface, with AIR above it
     (not a trunk, a pond or a pond-rim plant).
   - **The roll.** One roll, `u = rand3(q, r, FLORA_SALT, s)`, is compared with **cumulative** chances, left to right:

   | Biome (surface) | Gravel top | Loose stones | Fallen branches | Tussock | Tuber | Honeyberry | Other |
   |---|---|---|---|---|---|---|---|
   | PLAINS (grass) | 1.5 % | 1.2 % | 0.5 % | 6 % | 0.8 % | 0.6 % | |
   | FOREST (grass) | 2 % | 1 % | 4 % | 3 % | 0.4 % | 2 % | |
   | SNOWY (snowy grass) | 2 % (till) | 2 % | 1.5 % | 2 % | | 0.5 % | |
   | DESERT (sand) | | 1 % | | | | | prickly pear 0.8 % |
   | BEACH (sand) | 12 % (shingle) | 6 % | | | | | cattails 3 %, only at height 62–63 next to a column of height < 62 |
   | MOUNTAINS (stone top) | 6 % (scree) | 5 % | | | | | |

   - **Where things go.** "Gravel top" replaces the surface block itself with GRAVEL. Plants and litter go at `height + 1`.
   - *Each decision depends only on (seed, q, r) and `getColumn`, so chunks agree across borders.*
   - *Every start biome except desert and the peaks now has rock, flint, sticks and fibre. A plains or forest column has
     about 6–7 flint, expected, within hex distance 20 (1 261 columns).*

**`world.columnAt(q, r)`** (A, world.js) returns `{ height, biome, temperature }` from the generator, for the climate (§3.1).
**`world.findSurvivalSpawn()`** (A) is described in §2.5.

**Performance.** The worldgen performance test (8 ms per chunk) must still pass, and a new case generates a warm **gen-2** chunk
in ≤ 8 ms. Ponds cost at most about 4 candidates × 19 `getColumn` calls per chunk.

### 8.4 Hex ponds (fresh water)
Ponds use a jittered grid like the trees, with `POND_CELL = 20`.
- **Candidate.** Grid cell (kq, kr) gives the centre `(kq·20 + 2 + (h & 7), kr·20 + 2 + ((h >>> 3) & 7))`, with
  `h = hash2(kq, kr, s ^ POND_SALT)`. Let H = `getColumn(centre).height`.
- **It is a pond if:**
  - `((h >>> 8) & 0xffff) / 65536 < 0.5`;
  - the centre biome is PLAINS, FOREST or SNOWY;
  - every column within hex distance 2 has height ≥ H and one of those biomes;
  - no tree trunk lies within hex distance 2 (`treeTrunkAt`, §8.3).
- **What is written.** Each chunk writes its own cells:

  | Columns | Condition | Cell | Becomes |
  |---|---|---|---|
  | Within distance 1 | height == H | y = H | WATER (SNOWY: ICE, a frozen pond) |
  | Within distance 1 | height == H | y = H − 1 | CLAY |
  | At distance 2 | height == H, `(hash3(q, r, POND_SALT, s) & 3) === 0` | y = H + 1 | CATTAILS |
  | At distance 2 | height == H, `(hash3(q, r, POND_SALT, s) & 7) === 1` | y = H + 1 | LOOSE_STONES |

  *Every neighbour of a pond cell at height H is solid at y = H (all columns within distance 2 have height ≥ H), so the water
  never flows. It is natural water to the fluids rule (`originAt` = WATER).*
- `pondAt(q, r)` (pure) returns true for the pond columns.
- Expected spacing is about one pond every ~40 cells in flat plains and forest.

### 8.5 Pop-off blocks (A, physics files)
Plants, litter and fire pits behave as a campfire does today when their floor goes:
- **The rule.** `fallingblocks.GRAVITY_RULE_IDS` adds `POP_OFF_IDS` beyond CAMPFIRE. `_gravityRule` treats `isPopOff(id)` like
  CAMPFIRE: the cell is written AIR.
- **Effects.**
  - A plant gives 6 `leaves` particles (prickly pear: 4 `dust` particles in green) and `'break:leaves'`.
  - Loose stones and a fire pit give 4 grey `dust` particles and `'break:stone'`; fallen branches give `'break:wood'`.
  - A campfire keeps its smoke and `'break:wood'`.
- **Where to make the change.** Replace `id === BLOCK.CAMPFIRE` / `above === BLOCK.CAMPFIRE` with `isPopOff(…)` in the
  `blockphysics` falling trigger (blockphysics.js:1451–1470), and add `...POP_OFF_IDS` to the reseeder's hard-coded id list
  (`[SAND, RED_SAND, GRAVEL, CAMPFIRE, …]`, blockphysics.js:1463), or blocks left hanging at save time float after a reload.
  Only that falling path; the `ignite` trigger stays CAMPFIRE only.
- Popped blocks drop nothing, like campfires.

=====================================================================================================================
## 9. Architecture

### 9.1 Modules

| File | Kind | Package | Purpose |
|---|---|---|---|
| `src/items.js` | PURE | W0 | Item registry, tiers, tags, lookups |
| `src/inventory.js` | PURE | B | `Pack`, `slotClick`, stack helpers, spoilage |
| `src/harvest.js` | PURE | B | `BLOCK_RULES`, break time, drops, picking, tapping, `Regrowth`, `Tapped`, mob drops, tool power |
| `src/containers.js` | PURE | B | Baskets and belongings store |
| `src/survivalControl.js` | PURE | B | The input state machines and choices main would otherwise hand-write (§9.4) |
| `src/crafting.js` | PURE | C | `RECIPES`, `findStations`, `listRecipes`, `CraftQueue` (lanes) |
| `src/cooking.js` | PURE | C | `FIRE_TRANSFORMS`, `FireSlots` (spots and fuel) |
| `src/climate.js` | PURE | D | Air, felt and target temperature; heat sources; salinity |
| `src/vitals.js` | PURE | D | Stat dynamics, status, damage formulas |
| `src/survival.js` | PURE | D | `Survival`: mode, switch version, vitals, step, death/waking, export |
| `src/itemArt.js` | PURE (pixel painters) | E | 16×16 RGBA icon for every non-block item |
| `src/itemIcons.js` | DOM | E | Item icon sheet and drawing (block items via `drawBlockIcon`) |
| `src/packUI.js` | DOM | E | Pack & Making screen (pure geometry helpers exported) |

Import graph additions (acyclic; CONTRACTS §1):
```
items           → config, blocks
inventory       → config, items
harvest         → config, blocks, items
containers      → config, blocks, items
survivalControl → config, blocks, items, harvest
crafting        → config, blocks, hex, items             (labels need itemName and TIER_NAMES; pack access goes through PackOps)
cooking         → config, blocks
climate         → config, blocks
vitals          → config
survival        → config, items, vitals, climate
itemArt         → (nothing)
itemIcons       → config, items, atlas, itemArt
packUI          → config, items, itemIcons
storage         → … + items, cooking                     (fire-spot validation uses FIRE_TRANSFORMS)
commands        → … + items
hud             → … + items, itemIcons
```

### 9.2 Wave 0 (shared, merged before the packages fork)

**`config.js`** gains a "Survival (§42–§49)" section (the existing `HOTBAR_SIZE` = 9 is the pack's hotbar too):
```js
export const GEN_LATEST = 2;
export const PACK_SLOTS = 27, WEAR_SLOTS = 3, BASKET_SLOTS = 18, REMAINS_SLOTS = 30, MAX_CONTAINERS = 1024;
export const FIRE_SPOTS = 7, MAX_FIRE_SLOTS = 256;
export const CAMPFIRE_FUEL_START_S = 300, CAMPFIRE_FUEL_MAX_S = 1200, FUEL_STICK_S = 40, FUEL_LOG_S = 300, RELIGHT_HOLD_S = 3;
export const STATION_RANGE = 3, STATION_WORK_RANGE = 16, MAX_CRAFT_JOBS = 8;
export const STAT_MAX = 100, BREATH_MAX_S = 20, BREATH_REFILL_PER_S = 5;
export const BODY_TEMP_NORMAL = 37, BODY_TEMP_MIN = 25, BODY_TEMP_MAX = 45, SICK_MAX_S = 600, HEAL_MAX = 50;
export const FALL_SAFE_SPEED = 13.5, FALL_DAMAGE_K = 0.1, CRUSH_DAMAGE_PER_CELL = 6;
export const ATTACK_REPEAT_S = 0.55, DIG_TICK_S = 0.25, USE_REPEAT_GAP_S = 0.25, GULP_GAP_S = 0.5, TAP_HOLD_S = 4;
export const PIG_HEALTH = 5, PIG_REPOP_CHECK_S = 150, PIG_REPOP_TARGET = 3, PIG_REPOP_RADIUS = 64, PIG_REPOP_MIN = 24, PIG_REPOP_MAX = 48;
export const ZOMBIE_DAMAGE = 8, FIRE_BURN_DAMAGE = 4;
export const REGROW_MEAN_S = 600, MAX_REGROW_TRACKED = 4096;
```

**`blocks.js`** gains everything in §8.1:
- the ids, BlockDefs, TILE keys and the PICKER_ORDER insertions;
- `BLOCK_COUNT = 95`;
- `PLANT_IDS`, `POP_OFF_IDS` and the predicates `isPlant`, `isLitter`, `isPopOff`, `isStation`, `isContainerBlock`.

**`tiles.js`:**
- `TILE_NAMES` entries for tiles 77–104;
- `RECIPES` entries pointing to a temporary `paintPlaceholder`: a flat, fully opaque colour derived from the tile name, so every
  placeholder differs from every other tile. Package A replaces them.
- `PLANT_TOP_CLEAR` gets its real (trivial) recipe at once: every pixel alpha 0.

**`styles.css` and `tests/unit/styles.test.js`** — only the picker parts, before E takes the files over. Growing PICKER_ORDER
from 67 to 80 would push the reference picker to 7 rows and make it scroll. So:
- `#picker-grid { width: min(980px, calc(100vw - 48px)) }` (15 columns, 6 rows, 380 px ≤ the 420 px max-height);
- the 1280×720 picker test computes `cols = Math.floor((980 + 4) / (60 + 4))`.

**`items.js`.** The whole registry from §5.1, with this API:
```js
export const TIER, TIER_NAMES, TIER_SPEED, TOOL_TYPES, WEAR_SLOT_NAMES /* ['head','body','feet'] */, TAGS;
export const ITEMS;          // Readonly<Record<string, ItemDef>>, block items generated from BLOCKS
export const ITEM_KEYS;      // display order: tools, materials, food, heal, wear, then blocks in PICKER_ORDER order
export function getItem(key)            // ItemDef | null
export function isItemKey(key)          // boolean
export function stackSize(key)          // 0 for unknown keys
export function maxDurability(key)      // 0 = none
export function itemForBlock(blockId)   // key | null
export function blockForItem(key)       // block id to place, or -1
export function hasTag(key, tag)        // boolean
export function itemName(key)           // display name ('?' for unknown)
export function resolveItem(token)      // { key } | { error }: key, or display name with spaces → '_', case-insensitive
```

**`types.js`:**
- new typedefs: `ItemStack`, `ItemDef`, `ToolDef`, `FoodDef`, `WearDef`, `SurvivalJSON`, `ContainersJSON`, `FireSlotsJSON`;
- `SaveData` gains `gen?`, `mode?`, `survival?`, `containers?`;
- `PlayerState` gains `landSpeed?: number`;
- `PlayerInput` gains `speedFactor?: number`.

**Tests:**
- `wave0.test.js`: `BLOCK_COUNT` 95 and PICKER_ORDER 80, with WATER still last and RUNE_BLOCK right before it;
- `tiles.test.js`: `TILE_NAMES` count, now 115; `PLANT_TOP_CLEAR` is exempt from "every other tile is alpha 255 everywhere";
- `styles.test.js`: the picker block only (above);
- new `tests/unit/items.test.js`:
  - keys are unique and lower_snake;
  - no key clashes with another item;
  - stacks are valid (block items 64);
  - tools have `stack` 1 and a durability;
  - every placeable block except WATER has an item, and LOOSE_STONES, FALLEN_BRANCHES, FIRE_PIT and REMAINS have none;
  - tags list only existing keys.

### 9.3 Physics and mobs (D)
**`physics.js`** (§12):
- `stepPlayer` sets `p.landSpeed = 0` on entry, as before.
- In `substep`, when `moveVertical` resolves a downward move, record `p.landSpeed = max(p.landSpeed, −vyBefore)` before zeroing
  `vy`. This happens in every mode.
- The horizontal target speed is multiplied by `input.speedFactor ?? 1` when not flying. It applies after the
  sneak/sprint/water choice; the factor is clamped to 0–1.
- *Pigs and zombies get `landSpeed` too, unused for now.*
- **Consumer rule:** `survival.step` reads `player.landSpeed` and then sets it to 0. Main also zeroes it whenever it sets
  `fallGrace`.

**`bodies.js`.** In `standOn`, when `upper.vy` (before) was below the clamp, record `upper.landSpeed = max(upper.landSpeed || 0,
−vyBefore)`.

**`pigs.js`:**
- `spawn` sets `pig.health = PIG_HEALTH`.
- New `wound(pig, power, fromX, fromZ)` returns `'hit' | 'dead' | null`:
  - `null` while `hurt > 0`;
  - otherwise `health −= power`;
  - at ≤ 0 the pig is removed: `'dead'`;
  - else `this.hit(pig, fromX, fromZ)` runs: `'hit'`.
- `spawnNatural(count, q0, r0, seed, getBlock, isLoadedCell, minDist, maxDist, surfaces = [BLOCK.GRASS_BLOCK])`: the new last
  argument lists the ground ids a pig may spawn on. Existing callers are unchanged.
- New `pruneFar(x, z, isLoadedCell, minDist) → boolean`: removes the one pig farthest from (x, z) whose chunk is not loaded and
  whose distance is > `minDist`; false when none qualifies.
- Health is not saved: pigs heal on reload.
- `hit` is unchanged. *Creative still calls `hit`, so pigs never die there.*

**`zombies.js`:**
- `hit(zb, fromX, fromZ, power = 1)` adds `power` to `hits` (ZOMBIE_HITS is still 4).
- Nothing else changes, including `_strike`'s push. **The damage is applied by main** (§9.5), so zombies.js stays mode-agnostic.
- `openSky` (already exported) is reused by main for the climate (§3.1).

### 9.4 The survival core (D) and the control helpers (B)
**`climate.js`** (D):
```js
export const BIOME_SHIFT, DIURNAL_AMPLITUDE, HEAT_SOURCES /* {campfire:{heat:20,radius:6}, kiln:{12,4}, bloomery:{16,4}, forge:{22,5}} */;
export function baseTemperature(biome, climateT)         // §3.1
export function airTemperature(biome, climateT, feetY, time, underground)   // underground → baseTemperature
export function waterTemperature(biome, climateT)
export function sunFactor(time)                          // 0..1, 0 outside 06:00–18:00
export function heatAt(sources, x, y, z)                 // Iterable<{x,y,z,heat,radius}> → °C, capped at 30
export function feltTemperature(inp)                     // ClimateInput → { air, felt }
export function bodyTarget(felt, inWater)
export function isSaltyBiome(biome)                      // OCEAN or BEACH
/** ClimateInput = { biome, climateT, feetY, time, openSky, underground, inWater, wet, heat, groundChill, insulation, sunShade, activityHeat } */
```

**`vitals.js`** (D):
```js
export const RATES;                    // every number of §2.2–§2.4 by name (SATIATION_DRAIN 0.0556, BREATH_REFILL 5, …)
export function createVitals()         // { health, satiation, hydration, temp, breath, wet, sick, heal, healRate, stillFor }
export function statusOf(v, inp?)     // { canSprint, moveFactor, regen, labels: string[] }  (§2.3 table, label order as listed)
export function stepVitals(v, dt, inp, random)
  // inp = { activity, felt, inWater, headInWater, buried, nearFire, still } → { damage: Record<cause, number>, total }
export function softLandingFactor(ids)           // softest §2.4 factor over the supporting cells' ids
export function fallDamage(speed, factor)        // §2.4
export function knockDamage(dv)                  // §2.4
export function eatFood(v, food, random)         // → { sick: boolean }; applies satiation/hydration/temp, caps
export function queueHeal(v, hp, rate)
```

**`survival.js`** (D):
```js
export class Survival {
  mode            // 'creative' | 'survival'
  hasState        // false until Survival is first entered (or loaded)
  switchVersion   // bumped by setMode (main autosaves on it)
  vitals; spawn /* [q,y,r] | null */; deaths; dead /* cause | null */; fallGrace
  get inSurvival()// mode === 'survival'                 (SV)
  get active()    // mode === 'survival' && !dead        (S)
  get status()    // statusOf(vitals)
  setMode(mode)   // → boolean changed; entering Survival without state calls begin(). Only main's applyModeSwitch calls it.
  begin()         // fresh state (§2.1)
  step(dt, env)   // → SurvivalEvents (below); no-op unless active
  damage(amount, cause)   // → boolean: this damage killed (sets dead = cause)
  eat(key, random)        // food item → { ok, message? }
  drink(salty, random)    // hand gulp → message | ''
  bandage(key)            // → boolean
  respawn()               // §2.1 waking values, dead = null, fallGrace = true
  export()                // → the vitals part of SurvivalJSON (§9.6) — main adds pack, wear, fires
  import(json)            // validated SurvivalJSON (or null → hasState false)
}
/** SurvivalEnv = { player, softFactor, breaking, moving, still, buried, climate: {biome, climateT, openSky, underground,
 *   groundChill}, heat, nearFire, insulation, sunShade, time, random }
 *  SurvivalEvents = { damage: number, causes: string[], died: string|null, felt: number, air: number } */
```

**What `step` does, in order:**
1. Fall: consume `landSpeed` → damage (× `softFactor`), unless `fallGrace`. Any landing clears `fallGrace`.
2. Breath (under water or buried drains; otherwise refills at 5/s).
3. Wet.
4. Felt temperature (`climate`), then body temperature.
5. Drains, regeneration and heal.
6. Damage over time.
7. Death (`died` is reported; main turns it into `pendingDeath`).

*Every number is a named export, so tests can reach them by name.*

**`survivalControl.js`** (B, pure). *main.js is already 2 100 lines; the riskiest survival logic gets unit tests here instead of
being hand-written into it.*
```js
export class DigState {   // §6.1
  step(dt, target /* {q,y,r,id} | null */, held, need, handKey) // → { progress 0..1, done, tick }  (tick every DIG_TICK_S)
  reset()
}
export class UseState {   // hold RMB to eat/drink/bandage/wear; hold R to tap or relight
  step(dt, action /* {kind, key, needS, target?} | null */, held) // → { progress 0..1, done }; repeats after USE_REPEAT_GAP_S
  reset()
}
export function interactKind(c)      // the R priority below → { kind, ... } | null
export function chooseBelongingsCell(getBlock, q, y, r)   // §2.5 → [q,y,r] | null
export function buildPackView(input) // → the packUI view (§9.8), from pack, cursor, container, stations, tab, recipes, lanes
```
**R priority** (`interactKind`, Survival only; the first that applies):
1. hit is CAMPFIRE → `fire_put` (skewer food or centre pot selected and a free spot), `fire_feed` (stick or `#log` selected),
   `fire_take`, else `fire_hint`;
2. hit is FIRE_PIT → `pit_take` when its spots hold anything, else `pit_relight` (drill, tinder and 3 sticks in the pack) or its
   hint;
3. hit is a ripe HONEYBERRY_BUSH, PRICKLY_PEAR, LOOSE_STONES or FALLEN_BRANCHES → `pick`;
4. hit is BIRCH_LOG, an empty clay_pot is selected and a knife ≥ 2 is in the pack → `tap` (hint otherwise);
5. hit is WICKER_BASKET → `basket`; REMAINS → `belongings`;
6. hit is SLEEPING_HIDE → `hide` (remember it as the waking place);
7. hit is a station → `station` (open Making on that tab);
8. `waterHit` is water nearer than `hit` (or `hit` is null) → `fill` with an empty clay_pot selected, else `drink`;
9. the head is under water → `drink_here`;
10. otherwise today's barrel and rune behaviour.

**Tests** (`survivalControl.test.js`): dig reset rules and tick cadence; use repeat and cancel; every R priority case;
`chooseBelongingsCell` in mid-air, on a ledge, in water, boxed in; the pack view's shape.

### 9.5 main.js wiring (Integration)
**New states and objects.**
- States: `STATE.PACK = 'pack'`, `STATE.DEAD = 'dead'`.
- Per-world objects:
  - `survival`, `pack`, `containers`, `fireSlots`, `regrowth`, `tapped`, `craftQueue`;
  - `stations` (the last `findStations` result);
  - `climateSample`;
  - `digState`, `useState` (survivalControl);
  - the flags and slots `releaseToPack`, `pendingDeath`, `pendingKnock`, `pendingModeSwitch`.

**`stepFrame(dt)`.**
- **Top of the frame.** If `pendingModeSwitch` is set and the state is PLAYING or PAUSED, `applyModeSwitch()`:
  `consoleUI.close(); runeEditor.close();` then either `survival.setMode(mode)` (and the §1.2 steps) or, for a generation-1
  world going to Survival, the §1.3 upgrade code, which calls `startLoading` and ends the frame.
- **PLAYING** → `stepPlaying(dt)`.
- **PACK** → `stepPlaying(dt)` as well. Controls are disabled, so `getInput`, `consumePressed` and `consumeMouse` are empty, and
  the player stands still while the world runs. `packUI.refresh(view)` runs whenever `pack.version`, `craftQueue.version` or
  the 0.5 s station refresh changes.
- **DEAD** and the other states: as today (nothing steps).

**`stepPlaying(dt)`**, with `SV = survival.inSurvival` and `S = survival.active`:
1. **Fly toggle:** only if `!SV`.
2. **KeyE:** `SV ? openPack() : openPicker()`.
3. **R:** `SV ? survivalInteract() : today's interactTarget()`. Barrel and rune behave as today in both.
4. **Mouse:**
   - **Creative:** exactly today's code.
   - **Survival:** `survivalLeft(mouse, dt)` handles lit barrel, strike or dig (`digState`). `survivalRight(mouse, dt)` handles
     place (with the PLACE_REPEAT_S hold), or holds to use food, drink, bandage or wear (`useState`). Held R drives `useState`
     for tap and relight.
   - **MMB:** `SV ? selectSlotHolding(hit.blockId) : pickTargeted()`.
5. **Sprint and speed:** `if (S) { input.sprint &&= survival.status.canSprint; input.speedFactor = survival.status.moveFactor }`,
   else `input.speedFactor = 1`.
6. **Physics:** pull, current and `stepPlayer`, as today.
7. **`stepBlackHoles`:** if swallowing and S, `pendingDeath ??= 'blackhole'` (no teleport, no belongings).
   **Check:** `if (pendingDeath) { die(pendingDeath); pendingDeath = null; return; }`
8. **`stepPigs`, `stepZombies`:** `ev.attacks.length > 0 && S` → `hurt(ZOMBIE_DAMAGE · attacks.length, 'zombie')`.
9. **`stepWatcher`, `stepBlockPhysics`:**
   ```js
   const b0 = blockPhysics.explosions.blastCount;
   blockPhysics.step(dt);                       // the knock hook's player branch only records pendingKnock
   if (pendingKnock > 0 && S) hurt(knockDamage(pendingKnock), blockPhysics.explosions.blastCount !== b0 ? 'blast' : 'log');
   pendingKnock = 0;
   ```
10. **`stepCampfires`:** scorch && S → `hurt(FIRE_BURN_DAMAGE, 'fire')`, throttled to 0.5 s. **Check** `pendingDeath`.
11. **Bodies:** `resolveBodies`, then `unstickPlayer`, which now reports `{ lifted, buried }`:
    - `lifted > 0`, S, no `fallGrace`, not a teleport frame, and no `log`/`blast` damage this frame →
      `hurt(CRUSH_DAMAGE_PER_CELL · lifted, 'crush')`;
    - `buried` (findFreeY null and the eye cell solid) goes into the survival env.
    Then the clock.
12. **`if (S) stepSurvival(dt)`:**
    - refresh `climateSample` (`world.columnAt`, `zombies.openSky`, underground) and `stations` every 0.5 s;
    - build `SurvivalEnv` (soft factor from `supportingCells`);
    - `survival.step` → hurt flash, sounds; `died` → `pendingDeath ??= died`;
    - `craftQueue.step(dt, pack, stationsByLane, playerCell)` → messages, sounds, `hud.setJobChip`;
    - `fireSlots.step(dt, isBurning, isLoadedCell)` → burnt-out fires → `world.setBlock(q, y, r, FIRE_PIT)`;
    - once per second: `regrowth.step(…)` → lazy writes; `pack.spoil` and `containers.spoil` → chat lines;
    - pig repopulation every 150 s (§4.3);
    - `if (player.y < −32) pendingDeath ??= 'void'`.
    **Check** `pendingDeath`.
13. **Then as today:** `runner.update` (only while the state is PLAYING), **check** `pendingDeath`, streaming, `updateHit`,
    `autosaveTick`. `autosaveTick` also saves whenever `S` (vitals change all the time), and when `survival.switchVersion`,
    `pack.version`, `containers.version` or `fireSlots.version` changed.

**`hurt(amount, cause)`**: if `!S`, nothing. Otherwise `survival.damage`; if it killed, `pendingDeath ??= cause`; else the flash
and sound. *Never `die()` here.*

**`die(cause)`** is §2.5. It runs only from the checks above.

**`updateHit`.** `hit` is computed as today. In Survival with a dry eye, `waterHit` is computed too (§4.2). Today's
WATER-selected behaviour stays Creative-only.

**`targetHintText`** adds:
- the dig hint (`needs a … or better`) and `Pack full`;
- the water, campfire (spots and fuel), fire pit, bush, litter, birch, basket, belongings (`Your Belongings · R: take back`),
  Sleeping Hide (`Sleeping Hide · R: wake here`) and workplace (`Kiln · R: open Making`) hints;
- in Creative, `Holds survival items · switch to Survival to empty it` on a protected cell (§5.5).

**`breakTargeted`** (Creative) refuses the protected cells of §5.5.

**`onBlockChanged`** (before `blockPhysics`, after the campfires) adds:
- `containers.onBlockChange` → released stacks go to `pack.add` if `releaseToPack`;
- `fireSlots.onBlockChange` → the same routing (kept across CAMPFIRE ↔ FIRE_PIT);
- `regrowth.onBlockChange`.

**`renderFrame`** adds:
- `renderer.setDigProgress(digHit, progress)` (null when not digging);
- `campfireRenderer.sync(near, fxTime, dt, (fire) => fireSlots.view(fire.q, fire.y, fire.r))`;
- `hud.setVitals(...)` and `hud.setActionProgress(...)`;
- `hud.setHotbarStacks(SV ? pack.slots : null, selected, pack.version)`. With null, the HUD falls back to `setHotbar(hotbar)`.
  *No per-frame `slice`.*

**Other functions:**
- **`pause()`** also calls `menus.setModeState(survival.mode)` and passes `survival: SV` in the physics menu state (§1.5).
- **`onModeSelect(mode)`**: a generation-1 world going to Survival first awaits `menus.confirm(...)`; after the `await`, it
  continues only if `state === STATE.PAUSED && world === worldAtAsk`. Then `requestMode(mode)`.
- **`onUndoPhysics`** refuses while SV.
- **`quitToTitle` / `dispose`** clear every survival object, close the pack UI and the death screen, and hide the vitals.

**`startLoading(seed, restoring, opts)`:**
- `gen = restoring ? (restoring.gen ?? 1) : (opts?.survivalResources === false ? 1 : GEN_LATEST)`. The URL may raise it only
  under §1.1's rules.
- `new World({ …, gen })`.
- `survival.import(restoring?.survival ?? null)`; `survival.mode = restoring?.mode ?? 'creative'`, except Creative when the mode
  is `'survival'` and gen < 2 (§1.3). A `'survival'` mode with no (valid) survival object calls `survival.begin()`.
- `pack.load`, `fireSlots.load`, `containers.load(restoring?.containers)`, `regrowth.loadFromEdits(world.edits)`,
  `tapped.clear()`, `craftQueue.clear()`.

**`finishLoading`.**
- If SV: `player.flying = false` (whatever `?fly` says), `fallGrace = true`, `player.landSpeed = 0`.
- If `survival.dead` is set: `setState(STATE.DEAD)`, `menus.showDeath(...)`, and skip `showClickToPlay` and autoplay (§2.5).
- Apply `?mode` under §1.1's rules (first world only, then `params.mode = null`).

**`buildSaveData`** writes:
- `gen: world.gen >= 2 ? world.gen : undefined`;
- `mode: survival.hasState ? survival.mode : undefined`;
- `survival: survival.hasState ? { ...survival.export(), ...pack.export(), fires: fireSlots.export() } : undefined`;
- `containers: containers.size ? containers.export() : undefined`.

**`CommandContext.survival`** (main's implementation): `setMode` calls `requestMode`; `setVital('health', 0)` sets
`pendingDeath ??= 'command'`.

**GameContext (debug handle).** Add `survival`, `pack`, `setMode(mode)` (queues), `getMode()`.

**Smoke test.** The smoke sequence calls `game.setMode('creative')` first when needed and waits one frame.

### 9.6 Save format (C, storage.js)
`serializeSave` writes these after `watcherNight` and before `meta`:
- **`gen`:** when it is an integer ≥ 2.
- **`mode`:** when it is `'creative'` or `'survival'`.
- **`survival`:** when it is an object, canonicalised by `normalizeSurvivalJSON`.
- **`containers`:** when it is non-empty after `normalizeContainersJSON`.
- **`version`:** 3 when `gen` ≥ 2 or `survival` is present, else 2 (§1.4).

`deserializeSave` accepts versions 2 and 3.

`SurvivalJSON` (canonical key order). Numbers are rounded to 3 decimal places.
```
{ health 0–100, satiation 0–100, hydration 0–100, temp 25–45, breath 0–20, wet 0–1, sick 0–600, heal 0–50, healRate 0–5,
  spawn: [q, y, r] | null, deaths: int ≥ 0, dead?: cause-string,
  pack: (ItemStack|null)[27], wear: (ItemStack|null)[3],
  fires: { "q,y,r": { s: ({ k, t ≥ 0 } | null)[7], f?: 0–1200 } } }
```
In `fires`, `s[0..5]` are the skewers and `s[6]` the embers; `f` is the fuel left in seconds (absent: the fire burns forever).
An entry with no items and no `f` is not written.

`ContainersJSON` is `{ "q,y,r": { kind: 'basket'|'remains', slots: (ItemStack|null)[] } }`.

`deserializeSave` **never returns null for these fields**, with one exception: `gen > GEN_LATEST` makes the save unloadable
(`gen 3: made by a newer version of Caelancraft`), like an unknown version. Each other repair is pushed to `warnings`:

| Field | Problem | Warning | Repair |
|---|---|---|---|
| `gen` | Not an integer ≥ 1 | `gen: not a generator version, treated as 1` | Dropped |
| `gen` | 1 | — | Dropped |
| `mode` | Anything else | `mode: not creative or survival, treated as creative` | Dropped |
| `survival` | Non-object | `survival: not an object, ignored` | Dropped |
| `survival.<stat>` | Bad number | `survival.<stat>: invalid, reset` | Fresh value (§2.1) |
| `survival.pack[i]` / `wear[i]` | Bad stack | `survival.pack[i]: <reason>, dropped` | `null` |

The `survival.pack[i]` reasons are:
- unknown item `"x"`;
- count is not 1–`stackSize`;
- durability is not 1–max;
- a wear slot holds a non-wear item, or one for the wrong slot.

Also:
- a wrong pack length is padded or cut, with a warning;
- `fires` entries are dropped when the key is malformed, there are more than `MAX_FIRE_SLOTS`, `s` is not 7 long, or `f` is bad;
  a spot is set to null when its `k` has no `FIRE_TRANSFORMS` entry for that spot's kind (skewer or embers) or `t` is bad;
- **`fires` entries are validated against `edits`** like containers: an entry whose cell is not CAMPFIRE or FIRE_PIT in the
  repaired edits is dropped with `survival.fires[q,y,r]: no campfire there, dropped`. *CAMPFIRE is never generated, so an
  orphan would otherwise cook on nothing, and a campfire later placed there would inherit it.*
- **`containers`** entries are dropped when:
  - the key is malformed;
  - the kind is unknown;
  - there are too many slots (basket 18, remains 30);
  - the cell is not recorded in the repaired `edits` as WICKER_BASKET (basket) or REMAINS (remains). *Same rule as runes'
    orphans.*

  Bad stacks inside an entry become `null`.

**Round trips.** `renameSlot`, `duplicateSlot` and `migrateLegacySave` round-trip all four fields; they already re-serialise the
parsed document.

**Worlds panel.** Both `entryFromData` and `entryFromText` (the index-repair path) record `mode: 'survival'` in the index entry
when the save is in Survival, and `validIndexEntry` keeps it. `SlotInfo.mode?` lets the Worlds panel show "· Survival".

**Tests** (storage.test.js, saveSlots.test.js):
- each field is absent unless given;
- absent reads as the default;
- round trip;
- every warning text above, including the fires-against-edits rule;
- **a Creative save without the fields is byte-identical, and still version 2**;
- version 3 exactly when gen ≥ 2 or survival is present; `gen > GEN_LATEST` is unloadable;
- key order: the last keys are `['watcher','watcherNight','gen','mode','survival','containers','meta']` when all are present;
- rename, duplicate and migrate keep the fields;
- index `mode` from both entry paths.

### 9.7 Console commands (C, commands.js; CONTRACTS §26.4)

| Command | Args | Behaviour |
|---|---|---|
| `mode [creative\|survival]` | `choice:creative\|survival`, min 0, **`consoleOnly: true`** | No args: `mode: survival (Health 87 · Nourishment 64 · Hydration 51 · 36.9 °C)` or `mode: creative`. With an arg: `ctx.survival.setMode(m)` (queued) → `ok(message)`, for example `survival (saved with this world)`, `already creative`, or `adding survival resources to this world: reloading…` |
| `vitals [full\|health\|nourishment\|hydration\|temp\|breath] [value]` | `word`, `num`, min 0 | Prints the stats and labels, or sets one (clamped). `full` restores all. Fails `no survival state in this world (try mode survival)` |
| `pack [list\|add\|clear] [item] [count]` | `choice:list\|add\|clear`, `word`, `int`, min 0 | `list` (the default) prints the non-empty slots. `add <item> [count=1]` uses `resolveItem` and reports `added 12 Rock` or `… (3 did not fit)`. `clear` empties the pack and wear |
| `items [filter]` | `word`, min 0 | Lists the item keys (filtered by substring), 8 per line |

**`consoleOnly`** is a new command flag: `executeCommand` fails `mode is only valid in the console` when `ctx.running` (a rune
script). *A rune's Step-on script could otherwise reload the world under the runner.*

**`CommandContext.survival?`**:
```
{ mode, hasState, setMode(m) → {ok, message}, vitals() → object|null, setVital(name, v) → boolean, restoreVitals(),
packAdd(key, n) → leftover|null, packClear(), packList() → string }
```
`fly` fails in Survival with `not in Survival`. `give` fails in Survival with `in Survival use: pack add <item> [count]`.

**Tests:** the command-table invariants (unique names; `usage` starts with the name; `scriptOnly` is still only stop/wait;
**`consoleOnly` is only `mode`**; no command is both), plus every command against a fake `ctx.survival`, and `mode` refused with
`ctx.running`.

### 9.8 HUD, menus, the pack screen (E)
**Palette and chrome.** Every new survival element uses the pack screen's palette (dark #1c1a24, honey #e8b04a, ember #d0582a)
and a new **`.hex-button`** class. **No new element uses `.mc-button` or `.picker-panel`** (tested).

**Positions.** The HUD keeps `#hotbar` at bottom 8, `#block-toast` at bottom 64 and `#chat-log` at left 8 / bottom 72. New
elements are created in index.html, all hidden in Creative:
- **Vitals as bookends** of the hotbar: `#vitals-left` (Health and Nourishment) just left of the hotbar and `#vitals-right`
  (Hydration and Body temperature) just right of it, each a honeycomb pair of 44 px hex cells.
  - **Health:** a red-ochre fill with a "pulse line" glyph.
  - **Nourishment:** an amber fill with a "seed head" glyph.
  - **Hydration:** a blue fill with a "drop and ripple" glyph.
  - **Body temperature:** a vertical hex gauge, blue → green band → red, with a needle at the body temperature and a small
    ▲/▼ trend for felt vs body.

  Each cell fills bottom-up with its value. Glyphs are inline SVG paths drawn for this game. **No hearts, no drumsticks, no
  bubbles.**
- **Breath is the Health cell's border.** An SVG hex outline around the Health hex, split into its 6 edges, each worth
  `BREATH_MAX_S / 6` ≈ 3.3 s. The edges go dark clockwise from the top while breath drains; at 0 the whole border pulses ember
  red (#d0582a) with the damage. No border at full breath.
- **`#status-chips`:** the labels as small tags above the left bookend, coloured by kind.
- **`#job-chip`:** the soonest job (§7.2), above the right bookend.
- **Pickups are diegetic:** a 16 px hex token of the item flies from the hit point (projected to the screen by main) to its
  hotbar slot, or to a pack glyph at the strip's right end when it landed in the rosette, and the slot pulses once. There is
  no text feed.
- **`#action-ring`:** a hexagonal SVG outline around the crosshair whose stroke fills with progress.
- **The survival hotbar** (`#hotbar.survival`; Creative's hotbar is untouched): pointy-top hex slots, 40×46 px,
  `clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)`. A `.slot-count` (the stack count, shown when > 1),
  and `.slot-wear`: an SVG hex outline whose `stroke-dasharray` is the fraction of durability left, honey above 50 %, ember
  below 25 %, hidden when the tool is new.

**`hud.js` API additions.** Each touches the DOM only when its **rounded** value changes: health, nourishment and hydration to
integers, temperature and felt to 0.1, breath to the edge count `ceil(breath / (BREATH_MAX_S / 6))`.
```js
setSurvivalVisible(on)
export function vitalsKey(v) → string   // pure: the rounded values above; setVitals redraws only when the key changes
setVitals({ health, satiation, hydration, temp, felt, breath, labels })
setHotbarStacks(slots /* pack.slots (27) | null */, selected, version)   // redraws slots 0–8 when version or selected changes
setActionProgress(p /* 0..1 | null */)
setJobChip(text | null)
addPickup(key, n, from /* {x, y} screen px | null */)
```

**`menus.js`:**
- **Mode switch.** `IDS.btnMode` (`#btn-mode` in the `#pause-mode.physics-row` row, after Creatures) is a two-segment switch
  `[ Creative | Survival ]`, halves `#btn-mode-creative` and `#btn-mode-survival`. The active half is filled in honey and has
  `aria-pressed="true"`. Callback `onModeSelect(mode)` (fired only by the inactive half); `setModeState(mode)`.
- **Undo.** `PhysicsMenuState` gains `survival?: boolean`. When true, `#btn-undo-physics` is disabled and `undoButtonLabel`
  returns `Undo (not in Survival)`.
- **Death screen.** `#death-screen` (z 33):
  - no red tint, no "You died!" headline, no score;
  - background #1c1a24 at 85 % behind a CSS honeycomb mask whose cells darken ring by ring over 1.2 s;
  - `#death-title` in honey #e8b04a, `#death-detail`, and `#death-where` (the belongings line, hidden when lost);
  - `#btn-wake` "Wake up" as a `.hex-button`; `#btn-death-quit` as a small text link, "Save & quit".

  API: `showDeath(title, detail, where?)`, `hideDeath()`, callbacks `onWake` and `onDeathQuit` (save, then quit).
- **Confirm.** `confirm({ title, detail, yes, no, danger }) → Promise<boolean>` reuses `#confirm-dialog`. The old `confirmSlot`
  state becomes `pending: { resolve, onYes }`; the world-delete flow moves onto `confirm()`. Every call resets `#confirm-yes`'s
  text and the danger class. `hidePause()` and `showTitle()` resolve a pending confirm with false, so no Promise is left
  hanging.
- **New World form.** A checkbox `Survival resources (wild plants, ponds, copper and tin)`, checked by default.
  `onNewWorld(slot, name, seedText, { survivalResources })`.
- **Controls sheet.** Still 17 rows. These rows are reworded:
  - LMB: `Break block (hold) · Survival: hold to dig`;
  - RMB: `Place block · Survival: use the item in hand`;
  - E: `Blocks · Survival: pack & making`;
  - R: `Use: rune, barrel, fire, water, plants, basket`;
  - Space Space: `Double-tap: fly (or F) · Creative`.
- **Worlds rows** append `· Survival` when `slot.mode === 'survival'`.

**`packUI.js`:**
```js
export function createPackUI(doc, itemIcons, callbacks) → { open(view), refresh(view), close(), isOpen(), dispose() }
export function rosetteCells(rings) → [q, r][]      // pure; ring 1 then ring 2, clockwise from the top, centre excluded
// callbacks: onSlot(area: 'pack'|'wear'|'container', index, button: 0|2, shift), onDiscard(), onMake(recipeId, times),
//            onCancelJob(lane, i), onTab(stationId|'all'), onClose()
// view (built by survivalControl.buildPackView): { slots, wear, selected, cursor, hover, container: { title, slots } | null,
//   stations: [{ id, label, near }], tab, recipes: RecipeView[], lanes: [{ station, jobs: [{ name, progress, waiting }] }] }
```
**Layout.** `#pack-screen` (z 20, the picker's layer; they are never open together) uses dark #1c1a24 with honey #e8b04a
accents.
- **Left side:** the rosette, the centre info hex, the zig-zag hotbar strip, the wear chain and the discard hex (§5.4). A basket
  rosette replaces the Making panel while a basket is open.
- **Right side, the Making panel:**
  - station tabs (`All`, `Hands`, `Stump`, `Kiln`, `Bloomery`, `Forge`); a station that is not near is dimmed;
  - **recipe cards as mini rosettes:** the output hex in the middle, the inputs as hexes on a ring around it, each showing
    `have/need` (green or red), the tool chip on the ring's lower-right hex, then the time and `Make` / `×5`;
  - the lanes, one row per busy station, with progress bars and ✕.
- **The cursor stack** follows the mouse.
- **Keys:** Esc and E close (a document listener while open, like the picker). Clicks are forwarded raw; **all item logic lives
  in main, survivalControl and inventory.js**.

**`RecipeView`** (from `crafting.listRecipes`):
```
{ id, station, out: {k, n}, inputs: [{k?, tag?, label, need, have}], tools: [{type, tier, label, ok}], seconds, craftable, stationOk }
```

**`itemArt.js`.** `paintItem(key) → Uint8ClampedArray(1024)` (16×16 RGBA, a deterministic per-key rng like tiles.js), plus
`ITEM_ART_KEYS`. Unknown keys get the magenta checker. Art rules:
- **Tools are upright**, centred for the pointy-top slot: the haft in columns 7–8, the working end at the top (axe, pick,
  hammer, knife, spear, sword) or at the bottom (spade). The tier shows in the head colour **and** the binding: a cord wrap
  (stone, flint), a cast socket ring (copper, bronze), a forged eye with a rivet pixel (iron, steel). Colours: stone grey,
  flint #3b3f4a with a pale cortex, copper #c8743a, bronze #b08d3a, iron #8a8f96, steel #c9d3dc with a blue glint. The
  hammerstone is a plain cobble with a pale strike scar.
- **Ingots** are **hexagonal bars**.
- **Ores:** mineral lumps in their mineral's colours.
- **Pots:** a hex-rimmed pot; filled pots show a water, sea-green, sap-amber or snow fill.
- **Foods, materials, clothes:** each a small original pictogram (honeyberries are elongated dusky-blue berries).

**`itemIcons.js`.** `createItemIcons(doc, atlasCanvas) → { draw(ctx, key, size), canvas(key, size) }`:
- **block items** call `drawBlockIcon` with `blockForItem` (the ripe bush for the bush items);
- **other items** are blitted from a lazily painted 16-column sheet with nearest-neighbour scaling.

### 9.9 Rendering and sound (F)
**`renderer.setDigProgress(hit | null, p)`.**
- **Mesh:** a `LineSegments` built from the highlight prism's 6 vertical and 6 top edges, ordered clockwise from the north
  corner, in honey #e8b04a, `renderOrder` 3, at `hexToWorld(q, r)` and the cell's y.
- **Progress:** `geometry.setDrawRange(0, 2·ceil(12·p))`, so the cell's outline is traced around the hex as you dig.
- **Disposal and contexts:** hidden for null; disposed in `dispose()` and rebuilt after a context restore.
- *No crack textures and no UV-rewriting overlay.*

**`campfireRenderer.sync(near, t, dt, spotsView?)`.** `spotsView(fire)` returns `fireSlots.view(...)`:
`{ spots: ({ k, progress, secondsLeft, next } | null)[7], fuel }` or null. The renderer maps each key to a kind (meat for pork,
veg for tuber, root, acorns and cactus fruit, pot for every pot).

What is drawn:
- **Skewers** (one InstancedMesh, ≤ 6 per fire): a thin green-wood stick planted at each occupied corner stone, leaning about
  35° inward.
- **Chunks** (one InstancedMesh): a small hex-prism chunk at each skewer tip, with instance colour lerped raw (#d98c8c meat,
  #c9b27a veg) → cooked (#8a5a2b) → burnt (#2a2018).
- **Pot** (one InstancedMesh): a terracotta hex pot in the embers.

This adds 3 InstancedMeshes (12 in all), each included in `prewarm()`.

**`audio.js`.** New procedural sounds (WebAudio noise and oscillators, original):

| Method | Sound |
|---|---|
| `playHurt(v)` | A short low thump plus a filtered breath |
| `playDeath()` | A falling low tone and a muffled thud |
| `playEat()` | 3 crunchy noise ticks |
| `playDrink()` | 2 low gulps (sine pitch drops) |
| `playDig(group, v)` | A short, quiet break-filtered tick (reuses `BREAK_CUTOFF_HZ`) |
| `playCraft()` | A wooden knock plus a soft chime |
| `playToolBreak()` | A snap: a noise burst through a high bandpass |
| `playSizzle(v)` | Hissing noise with a crackle |
| `playPick()` | A leafy rustle |

**Tests:** extend `renderer.test.js` (the dig trace's draw range against p, null hiding it, dispose) and
`campfireRenderer.test.js` (12 meshes, skewer and chunk instances and colours, the pot). The new sounds go in
`tests/unit/survivalAudio.test.js` (methods exist and do not throw with a stub AudioContext).

### 9.10 Diagnostics (Integration)
**Parameters.**
- `?mode=creative|survival` (`readModeParam`; anything else → null), under §1.1's rules.
- `?ui=pack` opens the pack screen for screenshots.

**F3.** When Survival is active, a line after `Mode:`:
```
Survival: HP 87 · Nourishment 64 · Hydration 51 · Breath 20 · body 36.9 °C · felt 12.3 °C (air 9.8) · Chilled
```

**Debug handle.** `refreshHandleRefs` adds `survival` and `pack`.

**Smoke test.** Switches to Creative first (`game.setMode`). An optional survival smoke step, run under `&mode=survival`:
1. `setblock ~ ~-1 ~ stone`, then `pack add flint_pick`;
2. hold-dig the cell below for its break time, then assert the cell is AIR and the pack gained `rock`;
3. `pack add honeyberries`, eat one.

### 9.11 CONTRACTS conventions kept
- Pure modules never touch the DOM, three, time or `Math.random`. They take `random` (`[0,1)`) and `dt` as arguments.
- Every world write goes through `World.setBlock`: regrowth, burn-outs and belongings are lazy or plain writes, and picks,
  breaks and relights go through `playerSetBlock`.
- Modal state is set before `controls.unlock()` (pitfall 24).
- A switched-off feature (Creative, or dead) drops its triggers and never acts on the backlog (pitfall 28): survival `step`,
  `fireSlots.step` (cooking and fuel), `regrowth.step`, spoilage and `craftQueue.step` run only while active.
- No death, mode switch or world reload ever happens inside another system's callback (§2.5, §1.1).
- Negative coordinates work everywhere. Container and fire keys are `"q,y,r"`, like runes and campfires.

=====================================================================================================================
## 10. Work packages

**Merge order:**
1. **W0** first;
2. then **A–F** in parallel (any order). During this phase each file belongs to exactly one package;
3. then **I**.

When a package needs something that does not exist yet, it codes against this document and tests with fakes. It never edits
another package's file. A `// CONTRACT-ISSUE:` comment flags any disagreement. Three files change hands **sequentially**, never
in parallel: W0 edits parts of `tiles.js`, `styles.css` and `styles.test.js` before the fork, then A (tiles) and E (styles)
own them; I's version bump touches W0's and E's files only after every merge.

### W0 — Shared contracts (the lead; small, mechanical; ~half a day)
- **Owns:** `src/config.js`, `src/types.js`, `src/blocks.js`, `src/items.js` (new); in `src/tiles.js` only the `TILE_NAMES`,
  placeholder `RECIPES` and `PLANT_TOP_CLEAR` entries; in `src/styles.css` only the `#picker-grid` rule;
  `tests/unit/wave0.test.js`, `tests/unit/tiles.test.js` (counts and the `PLANT_TOP_CLEAR` exemption), the picker block of
  `tests/unit/styles.test.js`, and `tests/unit/items.test.js` (new).
- **Delivers:** §9.2 exactly. All existing tests stay green.

### A — Land: tiles, worldgen 2, ponds, pop-off blocks
- **Owns:** `src/tiles.js` (from W0 onward), `src/worldgen.js`, `src/world.js`, `src/fallingblocks.js`, `src/blockphysics.js`;
  the tests `worldgen.test.js`, `world.test.js`, `tiles.test.js`, `fallingblocks.test.js`, `blockphysics.test.js`.
- **Interfaces:**
  - `createWorldGen(seed, { gen = 1 })`, which also exports `pondAt(q, r)`, `treeTrunkAt(kq, kr)` and `FLORA_TABLE` (§8.3)
    on the returned generator;
  - `new World({ …, gen })`, `world.gen`, `world.columnAt(q, r)`, `world.findSurvivalSpawn()`.
- **Builds:** the real art for tiles 77–104 (§8.2); §8.3–§8.5.
- **May stub:** nothing.
- **Tests:**
  1. `gen 1` chunks are byte-identical to today (checksum a few chunks before the change and compare);
  2. `gen 2` is deterministic and agrees across chunk borders (generate neighbouring chunks in both orders);
  3. existing veins are unchanged;
  4. copper and tin stay within their y ranges and replace STONE only; clay replaces only sand, gravel and dirt;
  5. plants and litter stand on the right surfaces with AIR above; over a scan, each flora rate is within ±50 % of §8.3;
  6. ponds: every pond cell's side neighbours at H are WATER or solid, and the floor is CLAY; cattails and loose stones ring at
     least one pond of the scan;
  7. no trunk stands in a pond, and `treeTrunkAt` never calls `pondAt` (spy);
  8. spruce in SNOWY, birch in at least one FOREST chunk of the scan;
  9. the 8 ms per chunk performance test holds for gen 1 and for a warm gen-2 chunk;
  10. a plant, loose stones and a fire pit pop when the dirt below is removed; a campfire behaves as before; the reseeder
      lists `POP_OFF_IDS`;
  11. tiles: the new tiles are deterministic, differ from each other, and keep their alpha conventions (`PLANT_TOP_CLEAR` all
      alpha 0; the plant, litter and fire-pit tiles alpha 0 in their stated rows);
  12. `findSurvivalSpawn` returns a PLAINS or FOREST column at height ≥ SEA_LEVEL + 2 when the spiral finds one, falls back to
      `findSpawn` otherwise, and is cached; `findSpawn` is unchanged;
  13. `columnAt` matches `getColumn`.

### B — Pack, harvest and survival controls
- **Owns:** `src/inventory.js`, `src/harvest.js`, `src/containers.js`, `src/survivalControl.js` (all new); the tests
  `inventory.test.js`, `harvest.test.js`, `containers.test.js` and `survivalControl.test.js`.
- **Interfaces:** §5.2–§5.6, §6, §9.4 (`survivalControl`). `Pack` also implements **PackOps** for C:
  ```
  count(key), countTag(tag), take(key,n), takeTag(tag,n), canGive([{k,n}]), give(key,n) → leftover,
  hasTool(type,minTier), useTool(type,minTier) → {key, broke} | null
  ```
  It also exposes `version`, `insulation()`, `sunShade()`, `consume(i, n)`, `damage(i, n)`, `equip(i)`, `dumpAll()`,
  `spoil(dt, random)`, `export()` → `{ pack, wear }` and `load(json)`. `Containers` exposes `onBlockChange`, `hasItems`,
  `takeAll`, `addRemains` (beyond the cap), `spoil(dt, random, isLoadedCell)`, `size`, `version`, `export()` and `load()`.
  `survivalControl` also exports `strikeKind(mob, tool) → { call: 'wound'|'hit', power }`.
- **May stub:** nothing; it depends only on W0.
- **Tests:**
  - add, merge and overflow order; take order; tags;
  - tools never stack; durability and breaking; lowest-tier tool choice;
  - every `slotClick` case in §5.4, including wear-slot rules and discard;
  - `breakSeconds` for each row family and the "cannot" cases;
  - `rollDrops` with a seeded rng: branches and groups, `knife in pack`, aggregation; `natural` comes **from the argument**:
    natural loose stones give flint at about 50 % over 400 seeded rolls, and never when `natural` is false; leaves by hand give
    no stick; plants give `self` only with a spade;
  - every `PICKABLE` row; `tap` and `Tapped` (once per cell per day);
  - Regrowth: track/untrack, the 4096 cap, loadFromEdits, probability over many 1 s steps, unloaded cells frozen;
  - spoilage: rate against `spoilS`, never-spoiling items untouched;
  - Containers: basket created on place; release on change; belongings `takeAll` with overflow; `addRemains` beyond the cap;
    export/load;
  - survivalControl: §9.4's list, and `strikeKind`: bare hands never wound a pig.

### C — Making, fire, saving and commands
- **Owns:** `src/crafting.js`, `src/cooking.js` (new), `src/storage.js`, `src/commands.js`; the tests `crafting.test.js`,
  `cooking.test.js`, `storage.test.js`, `saveSlots.test.js` and `commands.test.js`.
- **Interfaces:** §7 (the full `RECIPES` table and the lanes), §4.4 (`FIRE_TRANSFORMS`, `FireSlots`), §9.6, §9.7.
  - `crafting.js` works through **PackOps** only, so it imports no inventory code.
  - `CraftQueue`: `enqueue(recipeId, times, pack, stations) → { ok, message }`, `step(dt, pack, stationCheck, playerCell) →
    events`, `cancel(lane, i)`, `lanes()`, `clear()`, `version`.
  - `FireSlots`:
    ```
    put(q, y, r, key, facing) → spot | -1           // one item, to the free spot of the right kind nearest the facing
    takeReady(q, y, r) → ItemStack[]                 // finished spots, or everything when none has finished
    hasItems(q, y, r)
    light(q, y, r, fuel)                             // Survival placement and relight
    addFuel(q, y, r, seconds) → 'ok' | 'full' | 'untracked'
    step(dt, isBurning, isLoaded) → { burntOut: [q, y, r][], cooking: number }
    onBlockChange(q, y, r, prev, next) → ItemStack[] // released; kept across CAMPFIRE ↔ FIRE_PIT
    view(q, y, r) → { spots: ({ k, progress, secondsLeft, next } | null)[7], fuel: number | null } | null
    export(), load(json), clear(), version
    ```
- **May stub:** in tests, a Map-backed fake PackOps and a fake `ctx.survival`.
- **Tests:**
  - recipe ids are unique; every recipe's keys and tags exist in `ITEMS`; 89 recipes, 37/12/21/4/15 by station;
  - **no recipe that outputs a block item takes 4 or 9 of any one input**;
  - `findStations` with a fake getBlock (range, dy, the return shape);
  - lanes: run at the same time; a waiting job blocks only its own lane; enqueue needs range 3, running needs range 16; a
    vanished station fails its job; the reservation check across lanes with the exact-then-tags allocation;
  - waiting when the pack is full; failing on missing inputs; tool wear on completion;
  - sorting of `listRecipes`;
  - fire spots: one item per put, to the right spot kind; mixed kinds; per-spot timers and chains (raw → roast → charred);
    the `takeReady` rule; no cooking on a pit; fuel start, feed, cap and `untracked`; countdown only when stepped; a burn-out
    reported once; spots kept across CAMPFIRE ↔ FIRE_PIT and released otherwise; export/load;
  - storage: §9.6;
  - commands: §9.7.

### D — Body: vitals, climate, survival core, physics and mobs
- **Owns:** `src/vitals.js`, `src/climate.js`, `src/survival.js` (new), `src/physics.js`, `src/bodies.js`, `src/pigs.js`,
  `src/zombies.js`; the tests `vitals.test.js`, `climate.test.js`, `survival.test.js` (new), `physics.test.js`,
  `physicsInterfaces.test.js`, `bodies.test.js`, `pigs.test.js` and `zombies.test.js`.
- **Interfaces:** §2, §3, §9.3, §9.4.
- **May stub:** nothing beyond W0.
- **Tests:**
  - every §3.4 row: air, felt and target (±0.2 °C); the underground rule and shelter underground;
  - drain times (100 → 0 in 30 and 20 min at rest); the pinned desert-noon rate (0.208 /s); Hot and Chilled never change the
    drain;
  - activity, heat and cold factors;
  - every threshold row of §2.3 (labels, canSprint, moveFactor);
  - regeneration conditions and cost; bandages;
  - breath: 20 s to empty under water or buried, 4 s to refill; regeneration needs breath > 0; `drown` and `buried` at 8 HP/s;
  - fall damage using `landSpeed` from a real `stepPlayer` drop on a flat getBlock: 3 cells 0; 4 ≈ 4.1; 10 ≈ 38.4; 21
    survives from full health; 22 kills (±1 HP); water cushions; the softest factor over several supporting cells; consume
    semantics (a value is applied once); grace;
  - sickness floor at 10 HP; death, waking values, export/import;
  - physics: `landSpeed` is 0 without a landing; `speedFactor` slows walking but not flying;
  - pigs: `wound` → `'dead'` after 5 power; the invulnerability window; holding attack at `ATTACK_REPEAT_S` for 3 s lands one
    wound per repeat; `spawnNatural` with `surfaces`; `pruneFar`;
  - zombies: `hit` with power 4 is a KO.

### E — Screens: HUD, menus, pack screen, item art
- **Owns:** `src/hud.js`, `src/menus.js`, `src/packUI.js`, `src/itemIcons.js`, `src/itemArt.js` (the last three new),
  `index.html`, `src/styles.css` (after W0); the tests `itemArt.test.js` (new), `packUI.test.js` (new), `survivalMenus.test.js`
  (new), `styles.test.js` (after W0) and `worldsMenu.test.js`.
- **Interfaces:** §9.8.
- **May stub:** in development, a demo view object (keep a `packUI` story under `?ui=pack` for I).
- **Tests:**
  - itemArt: every non-block key in `ITEMS` has art, it is deterministic, and it is not the checker; no tool icon's opaque
    pixels follow the main diagonal (the haft lies in columns 6–9);
  - styles: z-order (pack 20, death 33); the bookends, chips and job chip avoid `#block-toast` and `#chat-log` at 1280×720;
    `#death-screen` and every new survival element contain no `.mc-button` or `.picker-panel`; the survival hotbar's hex
    clip-path;
  - worldsMenu: the `· Survival` detail; the New World checkbox reaches `onNewWorld`;
  - survivalMenus: the mode switch halves and `aria-pressed`; `undoButtonLabel` in Survival; `confirm()` resets its labels and
    resolves false on `hidePause()`;
  - packUI: `rosetteCells` ordering; the label formatters;
  - hud: `vitalsKey` rounding (a change below the rounding never redraws).

### F — Render and sound
- **Owns:** `src/renderer.js`, `src/campfireRenderer.js`, `src/audio.js`; the tests `renderer.test.js`,
  `campfireRenderer.test.js` and `survivalAudio.test.js` (new).
- **Interfaces:** §9.9.
- **May stub:** nothing.
- **Tests:** as listed in §9.9.

### I — Integration (last)
- **Owns:**
  - `src/main.js`, `src/diagnostics.js`, `src/CONTRACTS.md`, `README.md` and `docs/*` (KNOWN-ISSUES and this file's
    deviations);
  - the version bump to **0.9.0**: `config.VERSION`, `package.json`, `package-lock.json`, the title footer `v0.9` in index.html,
    and `wave0.test.js`;
  - `tests/integration/harness.test.js`, `boomUndo.test.js`, plus the new `tests/integration/survival.test.js` and
    `survivalData.test.js`.
- **Delivers:** §9.5, §9.10; a README note that new worlds get survival resources unless the checkbox is cleared, and that old
  worlds change only when switched to Survival; a KNOWN-ISSUES entry for the inherited Minecraft-like chrome (§11).
- **Tests:**
  1. **Data closure** (`survivalData.test.js`): every non-block item has a source (a drop, a pick, a tap, a mob, a recipe
     output or a fire transform) and a use, or is food. Every recipe input is obtainable without a cycle that needs itself.
     Walking the tiers, each tool tier's pick can mine the next tier's ore. From `FLORA_TABLE`, the expected flint within hex
     distance 20 of a PLAINS or FOREST column is ≥ 6.
  2. **First day** (`survival.test.js`, pure modules only), built from §7.5:
     - start from an empty pack in a fake world with loose stones, gravel tops, tussock and leaves;
     - harvest (seeded) the kit and assert that **9 rock, 4 knapstone, 11 plant fibre and 8 sticks** make, in order, the
       hammerstone, the chopper, 5 cord, the flint knife, axe and pick, the fire drill and a campfire, in 28 s of hand jobs,
       with nothing left over;
     - mine a STONE cell with the flint pick in 1.5 s;
     - drink at a fake pond with all nine hotbar slots full;
     - roast pork on a skewer; let the fire burn 300 s into a FIRE_PIT;
     - die from a 25-cell fall through `pendingDeath`: the belongings hold everything, and the waking values match.
  3. **Harness:** a Creative run is unchanged (the existing expectations); a Survival run for 60 simulated seconds keeps the
     vitals in range; lanes keep running in the PACK state; a save with `survival.dead` reloads into DEAD with no click-to-play;
     `mode survival` from a rune fails; `?mode` touches only the first world; Undo is refused in Survival.
  4. **Smoke** (Windows Chrome, per memory): both modes. Screenshots: the vitals bookends, `?ui=pack`, the death screen.

### 10.9 CONTRACTS sections to add (I writes them from this document)

| Section | Title | Content |
|---|---|---|
| §42 | Survival mode | The switch (queued), generation 2 and the upgrade, the save fields (`gen`, `mode`, `survival`, `containers`), version 3, and Creative's guarantees (§1, §9.6) |
| §43 | Items, the pack and containers | `items.js`, `inventory.js`, `containers.js`, spoilage (§5, §4.5) |
| §44 | Harvesting | `harvest.js`: rules, drops, picking, tapping, regrowth, mob drops; `survivalControl.js` (§6, §9.4) |
| §45 | The body | `vitals.js`, `climate.js`, `survival.js`; the physics, bodies, pigs and zombies additions (§2, §3, §9.3–§9.4) |
| §46 | Making and fire | `crafting.js` (lanes), `cooking.js` (spots and fuel) (§4.4, §7) |
| §47 | World generation 2 | New blocks and tiles, ores, flora and litter, ponds, species, pop-off (§8) |
| §48 | Survival screens, rendering and sound | HUD, menus, packUI, itemIcons, itemArt, renderer, campfireRenderer, audio (§9.8–§9.9) |
| §49 | Survival integration | main wiring and frame order, deferred death, commands, diagnostics, smoke (§9.5, §9.7, §9.10) |

**Amendments** to existing sections:

| Section | Change |
|---|---|
| §1 | Table and import graph |
| §5 | Blocks 76–94, tiles 77–104, predicates and id lists |
| §8 | `gen` option, `FLORA_TABLE` |
| §9 | `World({gen})`, `columnAt`, `findSurvivalSpawn` |
| §12 | `landSpeed` (consume semantics), `speedFactor` |
| §14 | New fields; version 3 |
| §19–§23 | HUD, menus, states PACK and DEAD |
| §26 | New commands; the `consoleOnly` flag; `fly` and `give` in Survival |
| §30 | "Pigs never die **in Creative**; in Survival see §45" |
| §32 | Fire spots and fuel (Survival-placed fires only) |
| §33.8 | Undo is disabled in Survival |
| §34 | Pop-off blocks |
| §39 | "No damage" → "no damage in Creative; ZOMBIE_DAMAGE in Survival (main)" |
| §25 | Pitfall 30: "Survival state is frozen in Creative; never convert between the two inventories." Pitfall 31: "Never die, switch mode or reload a world from inside a hook, command or rune; queue it and act at the frame's checkpoints." |

=====================================================================================================================
## 11. Originality

Survival is a genre, and Caelancraft's version must be its own. These rules bind **every** package:
- no recipe that makes a block takes 4 or 9 of an input; packing uses 3, 6, 7 or 12 (§7.2);
- no death message in Minecraft's phrasing, and no "You died!" screen;
- new screens never use `.mc-button` or `.picker-panel`; they use the honey palette and `.hex-button`;
- no square slot grid, no bubble row, no hearts or drumsticks, no crack-stage textures, no diagonal tool icons;
- names come from real history, crafts and species, not from another game's item list.

**What we are, briefly.**
- **No grid crafting.** Making is a recipe list, filtered by your pack and the **workplaces** near you, with a lane per
  workplace. There is no grid, no shaped recipe, and no "crafting table", "furnace", "chest", "bed", "bucket" or "torch". We
  use real historical names: Work Stump, Kiln, Bloomery, Forge, Wicker Basket, Sleeping Hide, Clay Pot.
- **Not like the realism mods.** Primitive-tech mods have knapping grids, percentage alloy windows and anvil mini-games. We have
  none of those: knapping is a plain recipe that needs a hammerstone, bronze is fixed 7 : 1 (12.5 % tin) in a crucible, and the
  hammer is a required tool, not a mini-game. Clay is "greenware" before firing, the potter's word.
- **The look is hexagonal:** the rosette pack, the hex hotbar, the vitals bookends, breath on the Health cell's border, the
  hex dig trace, hexagonal ingots, the Forge's hex anvil face, the hex-knot belongings tag.
- **Our own words.** Nourishment and Hydration; body temperature with a felt-temperature trend; "Spade"; Malachite,
  Cassiterite, Hematite; Rock, Flint, Cord, Hammerstone; "Your Belongings"; "Wake up"; `mode` and `pack add` in the console.
- **Familiar tropes avoided.** Oak does not drop apples; mining stone gives Rock; zombies drop a Grave Rag, which must be boiled;
  there are no golden or diamond tools, and gems and obsidian need only a flint pick.

**Originality checklist.**

| Element | Closest existing game | How ours differs |
|---|---|---|
| Campfire cooking | Minecraft's 4-slot campfire; Valheim's cooking spit | Seven hex spots: six green-wood skewers on the corner stones and one pot in the embers; each item has its own timer; fires need fuel and burn out to a cold pit |
| Packing counts | Minecraft's 2×2 / 3×3 storage recipes (4 and 9) | 3, 6 or 7 (hex axes, sides, rosette); 12 for a hay bale; logs are riven into 6 sticks at a stump, no planks-to-sticks |
| Fall damage and soft landings | Minecraft's hay bale −80 % and bed −50 % | A speed-squared model from the real integrator; factors by how much a surface gives (snow 0.4, leaves and hay 0.6, wool 0.7, hide 0.9) |
| Death screen | Minecraft's "You died!" screen with Respawn / Title Screen | No headline or score; a honeycomb mask closing ring by ring; a cause line in our words; a hex `Wake up` and a small "Save & quit" link; where your belongings lie |
| Breath | Minecraft's row of 10 bubbles | No row: the Health cell's hex border darkens edge by edge |
| Pack screen | Minecraft's inventory and chest rows of 9 | An 18-slot rosette around an info hex, a zig-zag hotbar strip, a wear chain; a basket opens as a second rosette beside it |
| Hotbar | Minecraft's grey square slots and 2 px durability bar | Pointy-top hex slots; durability as a hex outline that drains |
| Dig progress | Minecraft's crack-stage overlay | The cell's hex outline is traced in honey as you dig |
| Tool icons | Minecraft's 45° tools recoloured by tier | Upright tools; tier shown by head colour and the binding (cord wrap, cast socket, forged eye) |
| Respawn point | 7 Days to Die's Bedroll | A Sleeping Hide pegged out at six stakes |
| Death drop | Minecraft's Bundle item; Valheim's tombstone | "Your Belongings": a hide-wrapped heap under a marker stick with a honey hex tag |
| Unfired clay | TerraFirmaCraft's "Unfired …" items | Greenware Pot, Green Brick, Greenware Crucible and Mold |
| Berries | Don't Starve's Berry Bush; Minecraft's sweet berries | Honeyberry (*Lonicera caerulea*), elongated dusky-blue berries, cold-hardy |
| Cactus fruit | Don't Starve's cactus that hurts to pick | No damage: the fruit comes unpeeled and is singed or peeled |
| Early resources | Minecraft's gravel → flint roll and leaves → sticks | Loose Stones and Fallen Branches lie on the ground; leaves give sticks only to an axe |
| Mode toggle | Minecraft's "Game Mode" cycle button | A two-segment `[ Creative \| Survival ]` switch |
| HUD corner | Rust's bottom-right vitals, craft chip and pickup text | Vitals bookend the hotbar; pickups fly to their slot as hex tokens; no text feed |
| Endgame gates | Minecraft's diamond-pick obsidian | Obsidian and gems need a flint pick; steel brings speed and durability |

**Inherited chrome.** The existing title, pause and picker screens already echo Minecraft's look (`.mc-button`'s #6f6f6f bevel,
the #c6c6c6 picker with a #404040 title, the rotating yellow splash text). Restyling them in the honey palette would change how
Creative looks, so it is **the user's decision**, not part of v1: I adds a KNOWN-ISSUES entry and proposes it as a follow-up.

=====================================================================================================================
## 12. Not in v1, and why
- **Item entities** (items lying in the world): everything goes to the pack or your belongings. *Entities need a renderer,
  physics, pick-up and save; belongings cover death, and overflow messages cover the rest.*
- **Weight and fatigue/sleep:** each one adds a stat or per-item state. *Four stats and breath are already a full dashboard.*
  The Sleeping Hide only sets your waking place; it does not skip the night, which the world clock shares.
- **Per-stack freshness:** spoilage is stateless (§4.5), so there are no freshness bars.
- **Farming, more animals and armour:** later. Bushes regrow, and pigs repopulate.
- **Fire spread, and fuel for Creative fires:** fires placed in Creative, and those from older saves, still burn forever
  (CONTRACTS §32); only Survival-placed fires need fuel.
- **Light from fires** in caves: there is no block-light engine (CONTRACTS §5, GLOWSTONE).
- **Weather, rain and seasons:** no weather system exists yet. The climate model (§3) is ready for a weather term.
- **Restyling the inherited menus** (§11): the user's call.

=====================================================================================================================
## 13. Decisions

Every must-fix from the three reviews is applied. The should-fix and nice items are applied too, except where noted here.

**Where reviews overlapped or conflicted:**
1. **Block ids.** Three reviews each proposed id 92 for a different block. Final: LOOSE_STONES 92, FALLEN_BRANCHES 93, FIRE_PIT
   94, `BLOCK_COUNT` 95.
2. **Campfire spots replace both "fire slot" fixes.** The originality review's 7 hex spots supersede the realism review's
   `FIRE_SLOT_MAX` 3 or 6. With logs removed from `FIRE_TRANSFORMS` (realism), the centre spot holds pots only, and logs are
   fuel.
3. **Fuel.** Realism's rule that fires with no fuel entry burn forever is kept over the technical review's "first seen in
   Survival gets 600 s": *a Creative builder's decorative fires must never become cold pits after a visit in Survival.* Feed
   values are stick 40 s and log 300 s (neither review's exact numbers) so that splitting a log into 6 sticks (240 s) never
   beats burning it. FIRE_PIT is a plain meshed block, so campfires.js and the renderer need no change for it, and spot items
   wait on the cold pit until relit or taken.
4. **Charcoal from fires.** Breaking a lit campfire gives rock only; the 1 charcoal comes from a burnt-out FIRE_PIT. *Otherwise
   placing and breaking campfires (2 rock and 3 sticks a cycle) would make charcoal cheaper than the Kiln.*
5. **Birch sap.** Realism's 4 s hold plus the technical review's once-per-log-cell-per-day limit (not saved). *Unlimited taps
   would turn every birch into a pond.*
6. **Flint.** The originality review's Loose Stones are the flint source (gravel gives rock only). To answer both flint-supply
   reviews, the flint chance is 0.5 (not 0.35), loose stones are denser (PLAINS 1.2 %, FOREST 1 %) and also lie in SNOWY (2 %)
   and DESERT (1 %), STONE adds flint p 0.05 as a steady later source, and gravel tops stay (FOREST raised to 2 %, SNOWY 2 % as
   till). The first-day kit needs 4 flint, about 9 loose stones, within 15 cells of a plains spawn.
7. **Leaves.** The originality fix (hand: nothing but nuts; axe: self + 1 stick, natural only) wins over realism's "leaves keep
   knife → self", which was the shears echo. Sticks come from Fallen Branches and, once you have a chopper, from lopping leaves.
8. **Ice packing** uses 3 chunks (originality) rather than 6 (realism); both meet the hex rule, and 3 matches PACKED_ICE's 3
   chunks.
9. **Lanes.** Enqueueing needs `STATION_RANGE` (3); a lane's head job then runs whenever its station is within
   `STATION_WORK_RANGE` (16). This is simpler than "start within 3, continue within 16" and gives the same freedom.
10. **Drinking.** Realism's "any item in hand" is used with the technical review's separate `waterHit` ray, which is cast
    whenever the eye is dry in Survival (not only with an empty hand).
11. **New worlds.** Both technical options: a New World checkbox (checked by default) and a README note.
12. **A save with `mode: 'survival'` but generation 1** (hand-edited only) loads in Creative with a warning, and the pause menu
    offers the upgrade. *No silent terrain rewrite.*
13. **Glass.** Both sand-to-glass and the new cullet remelt are at the Bloomery: a pottery kiln reaches neither temperature
    reliably.
14. **Storage blocks** (coal, copper, gold, iron, diamond) break with any pick, consistent with removing endgame gates.
15. **Station recipes** also avoid 4 and 9 (Bloomery 18 bricks + 3 clay, Forge 24 bricks + 3 wrought iron, bellows 3 planks,
    green bricks 3 at a time, fired bricks 6 a batch), although the rule only binds packing recipes.
16. **Spoilage.** Realism's option 1 (stateless), applied to baskets and belongings in loaded chunks as well as the pack:
    *a wicker basket is not a larder.*
17. **Fall model.** The safe speed is 13.5 m/s, not 13: the real integrator lands a 3-cell drop at 13.07 m/s, which would hurt.
18. **Snowy worked examples** include the −2 ground chill of standing on snowy grass, so the snowy night is Freezing from
    ~1.7 min and fatal at ~4.5 min (the reviews' 2 min / 5.7–6 min assumed no ground term).
19. **`survivalControl.js` belongs to B**, not D: D already owns seven files.
20. **Optional items taken:** the vitals bookends and diegetic pickups (originality), the mini-rosette recipe cards, glass
    shards, leached acorns, boiled rag bandages, Bloomery bellows, copper and bronze tools needing the crucible, snowy pigs,
    stack 64 for block items, and the HUD rounding rules.

**Not applied:**
- **Restyling the existing Minecraft-like menus** (originality, nice): it changes Creative's look, which the user promised to
  keep, so it is left for the user to decide (§11), with a KNOWN-ISSUES entry.

## 14. The Survival Handbook (added by the user after the design review)

The user asked: *"Make sure there's a survival handbook the player can access through the tutorial menu and a rustic looking
version that can be placed in the player's inventory on spawn."* It is built as package **H** after A–F merge (it touches W0's
`items.js`, E's screens and B's `survivalControl.js`), before or alongside I.

### 14.1 One text, two books
- **Content** lives in a new PURE module `src/handbook.js`: `CHAPTERS` = ordered `{ id, title, icon, pages: Page[] }`, a page being
  a list of blocks `{ kind: 'p'|'h'|'tip'|'warn'|'list'|'table'|'figure', … }`. Prose is written by hand; every table that restates
  game data is **generated from the data tables** (`RECIPES` by workplace, tool tiers and what each mines from `BLOCK_RULES`, food
  values from `ITEMS`, the §3.4 climate rows, damage sources), so the book can never disagree with the game. A test walks every
  generated table against its source.
- **Chapters** (in order): *Your first day* (the §7.5 walkthrough as steps), *Water* (fresh vs salt, drinking with R, pots,
  boiling, sickness), *Food and fire* (foraging, hunting pigs, the seven fire spots, fuel, burn-out, spoilage and salting),
  *Warm and cool* (what sets air temperature, felt temperature, clothing, the danger bands), *Tools and the ages* (stone → flint →
  copper → bronze → iron → steel: what each tier needs and unlocks, with the gating ore/tool chain), *Workplaces and making*
  (Work Stump, Kiln, Bloomery, Forge; lanes, ranges, the recipe tables), *Dangers* (every damage source and how to avoid it),
  *Death and waking* (belongings, the Sleeping Hide), *Controls* (R interact, hold LMB dig, RMB place/use, E pack, the hotbar),
  and *Creative and Survival* (the switch, what is kept). Plain, friendly, accurate; teaches real survival ideas where true
  (salt water dehydrates, wet clothes chill, charcoal for high heat, tin bronze).
- **The Guide (tutorial menu)**: a new `Guide` button on the title screen (next to the controls sheet) and in the pause menu opens
  `#guide` — a clean, readable two-pane reader (chapter list + scrollable page), in the survival palette and `.hex-button`
  chrome, usable in Creative too (reading only; nothing to do with the mode). Esc / the close button return to where it was
  opened. Keyboard: ↑/↓ chapters, PgUp/PgDn pages.
- **The rustic Handbook (item)**: item key `handbook` (W0's registry gains it in H: a non-block item, stack 1, never spoils, no
  recipe needed, `never lost`: see 14.2). Its own procedural icon in `itemArt.js` — a small leather-bound book tied with cord, a hex
  burned into the cover. Reading it opens `#handbook`: the SAME chapters drawn as a worn field book — a two-page spread on
  parchment (CSS gradients and a procedural paper-grain canvas, no downloaded images or fonts: a serif system font stack), hand-ruled
  margins, chapter tabs cut into the page edge, ink-style tables, page-turn with ←/→ or clicking the page corners, a pencilled
  "notes" margin where tips sit. The world keeps running while it is open (like the pack screen); taking damage closes it.

### 14.2 Getting and opening it
- **On spawn:** whenever a survival state is begun (§1.2 "begin one": a new Survival world, or the first switch of a world to
  Survival) the pack starts with the Handbook in the LAST hotbar slot (slot 8), not an empty pack. The §1.2 chat line gains
  *"Your handbook is in the last hotbar slot — hold it and press R to read."*
- **Never lost:** death does not put it in Your Belongings; on waking, if the pack has no handbook, one is given back (last free
  slot). It cannot be discarded (the discard action refuses it with a short message) and does not count toward pack fullness checks
  in recipes. A second copy cannot be made.
- **Opening:** with the Handbook selected, **R** opens it when no higher R priority applies (append to `interactKind` as priority 10,
  before "today's barrel and rune behaviour"), and **RMB** (use) opens it at once (no hold). In the pack screen, clicking it opens
  it. The Guide is always available from the menus, in both modes.
- **Interact stays R** in both modes. Hints: `Handbook · R: read`.

### 14.3 Package H
- **Owns:** `src/handbook.js`, `src/handbookUI.js` (new, DOM: both skins), its section of `src/styles.css`, the Guide button and the
  two reader roots in `index.html`, the `handbook` item in `src/items.js` and its art in `src/itemArt.js`, the `read` case in
  `src/survivalControl.js`, the begin/wake/discard rules in `src/inventory.js` / `src/survival.js` where they live after A–F.
- **Tests:** chapters and generated tables match the data; every chapter non-empty; the Guide opens/closes from title and pause
  and restores focus; the rustic reader turns pages, closes on Esc and on damage; the item: begin puts it in slot 8, death keeps it,
  wake restores it, discard refuses it, R and RMB open it; `itemArt` has its icon; styles: z-order above the HUD, below the death
  screen.
- **Wiring (I):** opening/closing from main (R/RMB/pack/menus), closing on damage, the chat line.

### 14.4 Exact API (so H and I can be built in parallel)
```js
// src/handbook.js (PURE; imports items, crafting, harvest, climate/vitals data — read-only)
export const HANDBOOK_KEY = 'handbook';
export function buildChapters() → Chapter[]        // cached; Chapter = { id, title, icon, pages: Block[][] }
export function chapterIds() → string[]
export function ensureHandbook(pack, preferSlot = 8) → boolean   // gives one when the pack has none: preferSlot if empty, else the
                                                                  // last empty slot; false when the pack already has one or is full
// src/inventory.js (H's additions)
export const KEEP_ON_DEATH = ['handbook'];          // Pack.dumpAll() leaves these in the pack; slotClick 'discard' refuses them
                                                    // (cursor kept, result.refused = 'The handbook stays with you.')
// src/survivalControl.js (H's addition)
// interactKind: priority 10 (before null) → { kind: 'read' } when c.selectedKey === 'handbook'
// src/handbookUI.js (DOM)
export function createHandbookUI(doc, { chapters, onClose } = {}) → {
  openGuide(chapterId?), openRustic(chapterId?),   // the Guide (menus) / the field book (item); either replaces the other
  close(), isOpen() → 'guide' | 'rustic' | null,
  handleKey(e) → boolean                            // main routes keydowns here while open (Esc, arrows, PgUp/PgDn)
}
// src/menus.js (H's addition): a Guide button on the title screen and in the pause menu → callbacks.onGuide()
// src/packUI.js (H's addition): right-click (or a "Read" action) on the handbook's slot → callbacks.onRead()
```
**I wires:** `menus.onGuide` → `handbookUI.openGuide()` (both modes; the pause menu stays underneath and comes back on close);
R `{kind:'read'}` and RMB with the handbook selected → `handbookUI.openRustic()`; `packUI.onRead` → close the pack, open the rustic
book; while `handbookUI.isOpen()` keydowns go to `handleKey` first and the pointer is released; survival damage events close a rustic
book; after `survival.begin()` and after every waking `ensureHandbook(pack)`; the §1.2 chat line's handbook sentence.
