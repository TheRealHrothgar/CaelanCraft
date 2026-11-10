# Caelancraft Circuits — design v2 (black holes, powder kegs, circuits, creative inventory)

> **User decision (overrides this document):** the user asked for *torches* by name, so the part this document calls the
> **Linstock** is named **Torch** — key `torch`, block `TORCH`, display name "Torch", search words "torch", "linstock", "slow match".
> It is a pitch torch: resin-soaked fibre bound to an ash staff, its flame always burning (a small flame sprite, no area light — the
> game has no block lighting yet). Every rule, number, tile slot and test written here for the Linstock applies to the Torch unchanged;
> wherever the text says Linstock / linstock / LINSTOCK, read Torch / torch / TORCH. Its history tip becomes the torch's (pitch torches
> lit fuses and slow match for centuries; a gunner's linstock held slow match the same way).


This is the brief for building four linked features **in parallel**, in separate worktrees, followed by one integration pass
in `main.js` (§7). Until it is merged, **this document is the contract** for the new code. Its normative parts then move into
`src/CONTRACTS.md` §50–§58 (§6.8). Where it disagrees with something CONTRACTS already covers, CONTRACTS wins: add a
`// CONTRACT-ISSUE:` comment and tell the integrator. Reasons for non-obvious rules are given in *italics*.

v2 applies the three reviews (realism and fun, originality, technical). What changed, where the reviews disagreed, and the few
items not applied are listed in **§11**.

**What the user asked for**, in their words:
> "Can we make the blackholes look and act cool? Like a spiraling black vortex which sucks blocks and mobs in. The activation of
> the block should be via switch or fuse, allowing the block to be remotely or timer activated (need circuits). It does not
> deploy activated. When activated, the block emits a brilliant flash of light followed by an implosion animation followed by a
> spiraling black vortex which sucks in nearby objects in a spiral trajectory. Animations should show the blocks being sucked in.
> Starting circuitry should be simple, educational, and real-world accurate: mechanical (torches, one-time powder fuses), and
> electrical (ignition switches, timers, conductors, batteries and power sources, repeaters, splitters, etc.).
> In the creative inventory, we should also group and expand similar blocks and make the inventory scrollable."
>
> "Similar activation needed for explosive barrels (call them powder kegs, please). Right now, the screen prompts for a right
> click to activate but this is blocked by the place command on the same binding. We need to have fuse, switch, or circuit
> activation."

**Survival** (`docs/DESIGN-survival.md` v2 with §14, the Handbook) is being designed at the same time. This document never
changes it. The places where the two meet are listed here:
- block and tile ids: §1.3;
- shared files and their merge order: §7.1 (checked against survival's §10 package list);
- the R key and the right mouse button in Survival: §4.9;
- recipes for every new block: §8.
Survival owns CONTRACTS §42–§49 (its §10.9), so this work starts at **§50**.

Conventions:
- Every CONTRACTS §0 rule holds:
  - pure modules never touch the DOM, three, time or `Math.random`;
  - rates are per **real second** (`dt`);
  - negative coordinates work everywhere.
- A **cell** is a hex prism (q, y, r). Faces use `hex.js` numbering: 0 E (+1, 0), 1 SE (0, +1), 2 SW (−1, +1), 3 W (−1, 0),
  4 NW (0, −1), 5 NE (+1, −1), 6 top, 7 bottom. `FACE_OPPOSITE = [3, 4, 5, 0, 1, 2, 7, 6]`. Layouts in this document give
  cells as axial `(q, r)` at one height unless a `y` is written.
- **On a hex, the two cells on neighbouring side faces of any cell touch each other** (faces f and f+1 mod 6). Every layout
  rule and worked example below is written with that in mind (§4.5).
- A **part** is any block listed in the part table `PARTS` (`src/circuitParts.js`, §4.2). Keys are `"q,y,r"`, as for runes.
- **Working ids** 140–159 (blocks) and the tile ids 160–194 are this document's names for the new blocks; §1.3 maps them to
  the final ids.
- **Keys and buttons in player-facing text** are always written in full, in one form: `R key`, `Shift+R key`,
  `right-click`, `left-click`. *The user read "R: light" as "right click".* A styles/hints test asserts that no
  player-facing string contains a bare `[R]` or matches `/(^|[^+\w])R:/` (§5.10).

=====================================================================================================================
## 0. The shape of it

| The user asked for | What we build |
|---|---|
| Black holes that do not deploy active | The picker gives a dormant **Collapsar Charge** (§2.1). `BLACK_HOLE` is now only the active vortex: it is not placeable, and old saves keep theirs active |
| Activation by switch or fuse, remote or timed | A charge is set off by a burning **Powder Fuse**, a powered **Igniter** (any switch, timer, relay or radio receiver can feed it), a **Linstock** or campfire placed beside it, or a blast (§2.2) |
| A brilliant flash, then an implosion, then a spiralling black vortex | ARM 0.4 s → FLASH 0.3 s (a scene light, a white screen flash and a crack) → IMPLODE 1.2 s (the charge swells and crumples, a shell of light collapses, particles rush in, the lens pinches) → VORTEX (a black core, a lensing shadow with a photon ring and the lensed far side of the disk, a dark two-arm spiral disk whose bright dashes stream inward, streaming particles and a drone) (§2.3–§2.4) |
| Blocks and mobs sucked in on spiral paths | `pullAt` gains a tangential term, so bodies drift in on a logarithmic spiral (half a turn from 8 units in). Every eaten block visibly tears loose and spirals in along the disk's own arms, shrinking, as an instanced copy. Swallowed pigs and zombies shrink and spiral in (§2.5–§2.7) |
| "Powder kegs", and no more confusing right-click prompt | `Blast Barrel` becomes **Powder Keg** everywhere the player sees it. Saves and scripts keep working. A keg is lit only by a fuse, a linstock, an igniter, a campfire, a blast or `ignite`, never by a key press on the keg itself, and it **burns in place**: when a fuse or igniter flame reaches the powder it goes off a quarter-second later. Right-click places blocks, as always, except on a switch, button, timer, radio key or plunger, which it operates (Shift+right-click still places) (§3, §4.9) |
| Mechanical circuits: torches and one-time powder fuses | **Linstock** (a gunner's smouldering slow match on a staff; the search finds it under "torch") and the **Powder Fuse** (Bickford's safety fuse: it burns at 2.5 cells/s, branches, lights what it reaches and is used up) (§4.3) |
| Electrical circuits: switches, timers, conductors, batteries and sources, repeaters, splitters | A **single-wire, earth-return** circuit that obeys **Ohm's law**: each wire cell loses volts in proportion to the current flowing, batteries add up when stacked and tire before they die, and real parts do the work (§4.2–§4.7):<br>• conductors: bare copper on porcelain knobs, brown and white braided wire, earth wire, and the Terminal Board;<br>• sources: Voltaic Battery (stackable into a pile), Blasting Machine (plunger magneto), Selenium Panel;<br>• controls: Knife Switch, Push Button, Clockwork Timer, Relay (the historical repeater);<br>• outputs: Igniter, Filament Lamp, Electric Bell;<br>• radio: Spark Transmitter and Coherer Receiver on 16 wavelengths, plus a pocket key |
| Simple and educational | Ground-standing devices just work. Every part has a one-line tip that teaches the real idea, shown in the picker, on first placement and in the device panel. Looking at any wire reads its voltage, like a multimeter, and an unloaded wire reads the full battery voltage, as a real one does. Hints name the mistake when a build is wired wrong (§4.5, §4.13). Wires never glow |
| A grouped, expandable, scrollable creative inventory | A honeycomb picker with sections and a section rail. **Families** (Wool ×16, Logs, Planks, Ores, Radio…) open as drawers below their row. It scrolls by wheel, scrollbar, drag on empty space and keyboard. It has a search box with aliases, drag-to-hotbar and slot badges, in the survival honey palette (§5) |

=====================================================================================================================
## 1. Names, ids and tiles

### 1.1 Renames and changed flags
| Today | Becomes | Code identifiers | Saves and scripts |
|---|---|---|---|
| `BLAST_BARREL` 75 "Blast Barrel", name `blast_barrel` | **"Powder Keg"**, name `powder_keg` | `BLOCK.POWDER_KEG = 75` is the canonical key. `BLOCK.BLAST_BARREL = 75` stays as a **deprecated alias** with the same id. Every other code name stays: `LIT_BARREL_GROUP`, `BARREL_*` config, `TILE.BARREL_SIDE/TOP`, the `Explosions` members | Saves store ids, so they are unchanged. `BLOCK_ALIASES.blast_barrel` (§1.5) keeps `setblock … blast_barrel` in rune scripts working |
| `BLACK_HOLE` 66 "Black Hole", placeable, meshed | Same id, name and display name. **`placeable: false`, `meshed: false`**: the vortex is drawn by `vortexRenderer` (§2.4) and is no longer in the picker | — | Old `edits` holding 66 load as **active vortices** (§2.10). An old `hotbar` slot holding 66 becomes `COLLAPSAR_CHARGE` (main's `hotbarFrom`) |

*Renaming the 175 `BLAST_BARREL` references in explosions, blockphysics, support and their tests would touch files that
survival's package A owns and gain nothing the player sees. The alias keeps every existing reference compiling; new code
writes `POWDER_KEG`.* The `wave0.test.js` check `BLOCK[name.toUpperCase()] === id` holds through `POWDER_KEG`. The three
player-visible "barrel" strings inside `blockphysics.js` change in a small post-merge edit (§3.1, §7.1).

### 1.2 New blocks (working ids 140–159)

Flag shorthands:
- **THIN** = `solid: false, opaque: false, layer: LAYER_CUTOUT, cullSame: false, meshed: false, icon: 'flat'`, with tiles
  `(CIRCUIT_CLEAR, <picture>, CIRCUIT_CLEAR)`. The part is drawn by `circuitRenderer` (§4.11); its picture tile only draws
  the icon.
- **CAB** = a "cabinet": a solid, opaque, meshed full prism, `def` defaults. *Every device sits in a hex cabinet with its
  working part on top. The moving or lit bits (blade, dial hand, plunger, bulb, glow) are overlays from `circuitRenderer`, so
  a state change never re-meshes a chunk.*

| Working id | `BLOCK` key | name / displayName | Flags | Tiles (side, top, bottom = top) | Sound |
|---|---|---|---|---|---|
| 140 | COLLAPSAR_CHARGE | collapsar_charge / Collapsar Charge | CAB | COLLAPSAR_SIDE, COLLAPSAR_TOP | glass |
| 141 | POWDER_FUSE | powder_fuse / Powder Fuse | THIN | POWDER_FUSE | cloth |
| 142 | LINSTOCK | linstock / Linstock | THIN | LINSTOCK | wood |
| 143 | COPPER_WIRE | copper_wire / Copper Wire | THIN | COPPER_WIRE | cloth |
| 144 | BROWN_WIRE | brown_wire / Brown Wire | THIN | BROWN_WIRE | cloth |
| 145 | WHITE_WIRE | white_wire / White Wire | THIN | WHITE_WIRE | cloth |
| 146 | EARTH_WIRE | earth_wire / Earth Wire | THIN | EARTH_WIRE | cloth |
| 147 | TERMINAL_BOARD | terminal_board / Terminal Board | CAB | TERMINAL_SIDE, TERMINAL_TOP | wood |
| 148 | VOLTAIC_BATTERY | voltaic_battery / Voltaic Battery | CAB | BATTERY_SIDE, BATTERY_TOP | wood |
| 149 | BLASTING_MACHINE | blasting_machine / Blasting Machine | CAB | BLASTER_SIDE, BLASTER_TOP | wood |
| 150 | SELENIUM_PANEL | selenium_panel / Selenium Panel | CAB | SELENIUM_SIDE, SELENIUM_TOP | glass |
| 151 | KNIFE_SWITCH | knife_switch / Knife Switch | CAB | SWITCH_SIDE, SWITCH_TOP | stone |
| 152 | PUSH_BUTTON | push_button / Push Button | CAB | BUTTON_SIDE, BUTTON_TOP | stone |
| 153 | CLOCKWORK_TIMER | clockwork_timer / Clockwork Timer | CAB | TIMER_SIDE, TIMER_TOP | wood |
| 154 | RELAY | relay / Relay | CAB | RELAY_SIDE, RELAY_TOP | wood |
| 155 | IGNITER | igniter / Igniter | CAB | IGNITER_SIDE, IGNITER_TOP | stone |
| 156 | FILAMENT_LAMP | filament_lamp / Filament Lamp | CAB (opaque cabinet; the glass bulb is an overlay, §4.11) | LAMP_SIDE, LAMP_TOP | wood |
| 157 | ELECTRIC_BELL | electric_bell / Electric Bell | CAB | BELL_SIDE, BELL_TOP | stone |
| 158 | SPARK_TRANSMITTER | spark_transmitter / Spark Transmitter | CAB | TX_SIDE, TX_TOP | wood |
| 159 | COHERER_RECEIVER | coherer_receiver / Coherer Receiver | CAB | RX_SIDE, RX_TOP | glass |

All 20 are breakable and placeable, have no gravity and do not fall through.

Physics of the two shapes:
- **THIN parts** are walk-through and not load-bearing (`isLoadBearing` needs `solid`). They hang where they are put: *a wire
  strung across a gap is a real thing*. Sand rests on them, as survival §8.1 accepts for plants. A cell holds one id, so a
  thin part also **blocks water** like any block (fluids flow only into AIR and CAMPFIRE): a copper wire dams a stream. This
  is listed in §10 and KNOWN-ISSUES.
- **CABs** are ordinary solid, load-bearing blocks, so a collapse crumbles them like any other block. Their store entry is
  then dropped (§4.8). *No `support.js` change.*

### 1.3 Final ids
Block ids must stay dense: `commands.resolveBlock` walks `BLOCKS`, and `wave0.test.js` requires `BLOCKS[i].id === i`. So the
working ids are **renumbered when K0 lands** (§7):

  **final id = BLOCK_COUNT at that moment + (working id − 140)**

- Survival v2 pins its blocks at **76–94** with `BLOCK_COUNT = 95` (its §8.1, W0). If survival's W0 has merged first
  (recommended), the new blocks take **95–114** and `BLOCK_COUNT = 115`.
- Otherwise they take 76–95, and survival renumbers.

**Nothing but `wave0.test.js` may contain a numeric block id**; code and the other tests use `BLOCK.X`. Tile ids are sparse,
so 160–194 are final as written. Survival uses tiles **77–104** (`TILE_NAMES` count 115 after its W0) and the creatures use
240–252; 160–194 is clear of both.

### 1.4 New tiles (`TILE` keys; 35 tiles, ids 160–194)
| Id | Key | Id | Key | Id | Key | Id | Key |
|---|---|---|---|---|---|---|---|
| 160 | CIRCUIT_CLEAR | 169 | TERMINAL_SIDE | 178 | SWITCH_TOP | 187 | LAMP_SIDE |
| 161 | COLLAPSAR_SIDE | 170 | TERMINAL_TOP | 179 | BUTTON_SIDE | 188 | LAMP_TOP |
| 162 | COLLAPSAR_TOP | 171 | BATTERY_SIDE | 180 | BUTTON_TOP | 189 | BELL_SIDE |
| 163 | POWDER_FUSE | 172 | BATTERY_TOP | 181 | TIMER_SIDE | 190 | BELL_TOP |
| 164 | LINSTOCK | 173 | BLASTER_SIDE | 182 | TIMER_TOP | 191 | TX_SIDE |
| 165 | COPPER_WIRE | 174 | BLASTER_TOP | 183 | RELAY_SIDE | 192 | TX_TOP |
| 166 | BROWN_WIRE | 175 | SELENIUM_SIDE | 184 | RELAY_TOP | 193 | RX_SIDE |
| 167 | WHITE_WIRE | 176 | SELENIUM_TOP | 185 | IGNITER_SIDE | 194 | RX_TOP |
| 168 | EARTH_WIRE | 177 | SWITCH_SIDE | 186 | IGNITER_TOP | | |

`TILE_IDS` grows by 35: from 87 to 122 without survival, or from 115 to 150 with it.

**The keg's two existing tiles** (75 `barrel_side`, 76 `barrel_top`) keep their ids and names, but their painters move into
`circuitTiles.js` and are repainted (§3.5). *So the keg's look is ours to change without editing survival A's `tiles.js`
beyond the spread lines.*

**Art**: procedural recipes in the new `src/circuitTiles.js`, original designs of real objects, alpha 255 except where
noted. **No collapsar, vortex or circuit asset uses a hue between 250° and 300°** (violet), and no signal wire is red, blue,
green or yellow (tested, §7 C).
- `CIRCUIT_CLEAR`: every pixel alpha 0.
- **Flat pictures** (used as a flat icon, §1.5): alpha 0 background.
  - `POWDER_FUSE`: a coiled dark tarred cord (#2b2420) with a pale twine wrap (#b8a77a) and a frayed, powder-grey end.
  - `LINSTOCK`: a leaning ash staff with an iron spike foot and a dark-iron (#3a3d42) forked serpent head holding the slow
    match sideways, its ember (#ff7a2a / #ffd27a) beside the fork; a coil of grey match (#8a8478) wound on the shaft.
  - Wires: a loose coil with a cut end:
    - copper: bare #c8743a with #8a4a22 shading, wound on a white porcelain knob (#e8e4da);
    - brown: cotton braid #6b4226 with a #4a2c18 diagonal braid;
    - white: cotton braid #e8e2d0 with a #b8b2a6 braid;
    - earth: green #3f9f3f with yellow #e0c43a spiral stripes.
- **Cabinets**: six identical sides, so no side tile can show orientation. Each side tile shows the cabinet's material; each
  top tile shows the working face from above. **No circuit part shows visible gears.**

  | Part | Side tile | Top tile |
  |---|---|---|
  | Collapsar Charge | Tachylite (basalt glass) #1a1b18 with a faint #2c2e26 sheen, a dull steel band #6f757c and brass rivets #b08d3a | A black lens holding one white pinprick |
  | Terminal Board | Varnished oak with two brass screw terminals | A board of brass binding posts in a hex ring |
  | Voltaic Battery | A slatted crate, through whose gaps show glass jars holding copper and tin plates | Jar mouths with copper terminals |
  | Blasting Machine | A varnished oak box with a blank brass plate and a leather carrying strap (no red, no lettering) | A plunger bushing |
  | Selenium Panel | A lacquered wood case with a brass ring | Six round grey-black selenium discs (#3a3436) in a hex rosette, each under a 25 % gold-leaf sheen (#c9a85a) inside a brass collector ring, joined in series by brass strips, with two terminal screws. No grid |
  | Knife Switch | A slate base | Slate with two brass jaws and a hinge post (the blade is an overlay) |
  | Push Button | Brass, on slate | A brass ring (the cap is an overlay) |
  | Clockwork Timer | A walnut case (#5a3a24) with a brass winding arbor and a keyhole, like a 19th-century time switch | A cream enamel dial with 12 hex ticks (the hand is an overlay) |
  | Relay | An oak base showing copper coil windings | The armature and contact springs |
  | Igniter | Glazed ceramic with a mica window | A ceramic plate with a coiled bridgewire |
  | Filament Lamp | Oak | A porcelain top with a brass socket (the glass bulb is an overlay) |
  | Electric Bell | A dark-oak backboard | A bright steel gong (#c8ccd2, highlight #eef0f2), nickel-plated as real bells were; the trembler is an overlay |
  | Spark Transmitter | An oak box showing an induction coil | Two brass spark balls and a Morse key |
  | Coherer Receiver | A dark box | A glass tube with grey filings and brass end caps |

  *These are designs of real objects, chosen to look unlike any block in another game (§9).*

### 1.5 `blocks.js` additions (K0)
- **`BlockDef.icon`**: `'prism'` (default) or `'flat'`. `drawBlockIcon` (atlas.js, package C) draws a `'flat'` block's TOP
  tile as an unskewed 2D picture, fitted to the icon square with nearest-neighbour scaling. *A wire drawn as a hex prism with
  transparent sides reads as nothing.*
- **`BLOCK_ALIASES`**: `Object.freeze({ blast_barrel: BLOCK.POWDER_KEG })`. `resolveBlock` consults it right after the
  exact-name pass and accepts a display-name alias too (`blast barrel`).
- **`PICKER_ORDER`**:
  - removes `BLACK_HOLE`;
  - adds the 20 new ids before `RUNE_BLOCK`, in table order;
  - keeps `RUNE_BLOCK` and then `WATER` last.

  It stays the flat list of every placeable block: survival's `ITEM_KEYS` and the `blocks` command use it. The picker's
  *layout* comes from `pickerModel.js` (§5). *Removing BLACK_HOLE drops `black_hole` from survival's ITEM_KEYS; §8.3 adds
  the item alias that keeps old packs valid.*
- **`DEFAULT_HOTBAR`** is unchanged.
- **Predicates** live in `circuitParts.js`, not `blocks.js`: `partOf`, `isFlame`, `isIgnitable`, `isControl`, `isEarth`. *This
  keeps K0's edit to `blocks.js`, which survival's W0 edits too, as small as possible.*

=====================================================================================================================
## 2. Black holes, redesigned

### 2.1 Two blocks
- **Collapsar Charge** (`COLLAPSAR_CHARGE`) is the dormant device. It is a plain solid block: no pull, no eating. *In the
  1960s, before John Wheeler's name "black hole" caught on (1967), astronomers spoke of collapsars or frozen stars; the name
  teaches that, and it is ours.* It is placed from the picker, `setblock` or `fill`. Breaking it simply removes it.
- **Black Hole** (`BLACK_HOLE`, 66) is the active vortex. A cell becomes one only by activation, `setblock`/`fill … black_hole`,
  or an old save.

### 2.2 What sets a charge off
A charge is set off by any of these:
1. a burning Powder Fuse that **finishes** in a cell next to it (any of the 8 faces, §4.3);
2. a powered Igniter next to it: on the rising edge, and again every `IGNITER_REFIRE_S` while it stays powered (§4.6);
3. a **flame** next to it: a Linstock or Campfire placed beside it, or the charge placed beside one (§4.3);
4. a blast whose cell loop reaches it. `explosions._blast` calls `this.onCharge(q, y, r)`, which main sets to
   `blackHoles.activate`, instead of destroying the cell (§3.4);
5. `ignite q y r` in the console or a rune (§6.5).

Things that never set it off:
- the R key, either mouse button, or a hand on it. The R key explains instead, or sends the pocket key when a Spark
  Transmitter is selected (§4.9).
- Water.
- A vortex eating it: it is swallowed like any block.

`BlackHoles.activate(q, y, r, world) → { ok, message }` refuses when:

| Condition | Message |
|---|---|
| The switch is off | `black holes are off — turn them on with \`blackholes on\`` |
| The cell is not loaded | `cell (q, y, r) is not loaded` |
| The cell is not a charge | `there is no collapsar charge at (q, y, r)` |
| It is already arming | `the charge at (q, y, r) is already collapsing` (returned with `quiet: true`, so an igniter's refire says nothing) |

Otherwise it starts **arming** and returns `ok` with `the collapsar charge at (q, y, r) is collapsing`. Past the 256-hole cap the
new hole is inert, as today (§29), and main's existing chat line says so.

### 2.3 The sequence
The phase is derived from `age`, the seconds since arming began. Ages advance in `update(dt)`, so pausing freezes them.

| Phase | Starts | Length | What happens | Pull × | Eats | Swallows |
|---|---|---|---|---|---|---|
| **ARM** | 0 | `BLACK_HOLE_ARM_S` 0.4 s | The charge is still a block. The pinprick in its lens swells to white-hot (vortexRenderer's arming glow over the cell), and a rising whine plays (`bhArm`). **Breaking the charge now cancels.** | 0 | no | no |
| **FLASH** | 0.4 | `BLACK_HOLE_FLASH_S` 0.3 s | `update` writes `BLACK_HOLE` into the cell, only if it still holds the charge: non-lazily for the first 2 such writes per `update`, lazily for the rest (*a fuse setting off 20 charges in one tick must not re-mesh 80 chunks in one frame; the charge copy below hides the delay*). The hole records `fromCharge = true`. **The charge copy** is drawn from now on (u = phase progress): scale `1 + 0.1·sin(π·u)`, a swell, under the arming glow. **The scene light**: the shared PointLight at the centre, warm white `BLACK_HOLE_FLASH_COLOR` #fff4e6, intensity `BLACK_HOLE_FLASH_INTENSITY·(1 − u)²` with peak 220. **The screen flash** (§2.4.6). A crack (`bhFlash`). 24 white `sparks` thrown outward. | 0 | no | no |
| **IMPLODE** | 0.7 | `BLACK_HOLE_IMPLODE_S` 1.2 s | **What collapses** (s = phase progress 0→1):<br>1. The charge copy: scale `max(0.01, 1 − s/0.7)`, spinning faster (`ry` += 14·s² rad, `rx` tilt to 0.6); it is no longer pushed once its scale reaches 0.01 (*fallingRenderer treats a scale ≤ 0 as 1*).<br>2. A shell of light: an additive sphere whose radius falls from 3.2 to 0.3 by ease-in-cubic, white turning deep red #b03a1a.<br>3. 64 `infall` particles on a 3.0–3.6 **sphere**, rushing straight in and arriving at about s = 0.95 (§6.2.10).<br>The camera pinches (§2.4.6). A swell plays and ends in a deep thoom (`bhImplode`). At s = 1 the core pops in with a 0.25 s photon-ring flare, and the event `formed` fires. | s² | no | no |
| **VORTEX** | 1.9 | forever | The vortex look (§2.4); streaming particles; a drone (§2.11). Pull with swirl (§2.5); eating (§2.6); swallowing (§2.7). | 1 | yes | yes |

**Not saved.** Phases are transient, like keg fuses.
- A reload during ARM leaves a dormant charge: nothing has happened yet.
- A reload during FLASH or IMPLODE gives a full vortex at once: the cell is already `BLACK_HOLE`.

**How each source of a hole starts:**
- A hole added by `onBlockChange` (activation, `setblock`, a rune, `fill`) starts at **FLASH** with `age = ARM_S`. So
  `setblock … black_hole` also flashes and implodes. It is drawn with a charge copy only when `prev === COLLAPSAR_CHARGE`
  (`fromCharge`).
- A hole added by `loadFromEdits`, or by `add(q, y, r)` with no phase, starts at **VORTEX**. *Survival's pig and zombie tests
  call `holes.add` and expect an immediate pull; they must stay green unchanged.*

### 2.4 The look (`src/vortexRenderer.js`, three, and `src/vortexMath.js`, pure; package A)
One renderer draws every collapsar visual except the dormant twinkle, which is circuitRenderer's (§4.11). Each element is
**instanced**, so the renderer costs **4 draw calls in all**, however many holes are visible. The pure helpers that the shaders
mirror live in `vortexMath.js`, so the shapes and directions are unit-tested (§6.2.6).

**The palette is blackbody** (heat colours: soot, deep red, orange, white), as in real black-hole images. *No violet: that is
another game's portal palette.*

1. **Core.** An `InstancedMesh` of a 24-segment sphere, radius `VORTEX_CORE_R` 0.3, `MeshBasicMaterial` black, fogged.
2. **Shadow, photon ring and the lensed disk.** One camera-facing quad per hole, `VORTEX_BILLBOARD` **3.6 × 3.6**. It uses a
   `ShaderMaterial` with **premultiplied-alpha blending**: `CustomBlending`, src `OneFactor`, dst `OneMinusSrcAlphaFactor`,
   `depthWrite: false`. With r the distance from the quad centre in world units and q̂ the fragment's unit direction on screen:
   - **the shadow** is alpha `0.92·(1 − smoothstep(0.7, 0.86, r))`, black. *The shadow is 2.6 times the core's radius, as
     for a real black hole: light bends around it.*
   - **the photon ring** is an additive rgb band at r 0.74–0.80, colour #ffd9a0 → #ffffff, with gain `1 + 0.6·dot(q̂, bScreen)`.
     In the vertex shader, `v = normalize(centre − cameraPos)`, `bWorld = (−v.z, 0, v.x)` (the limb whose +θ disk motion
     points at the camera; its length falls to 0 seen from straight above), and `bScreen = (dot(bWorld, camRight),
     dot(bWorld, camUp))`. *This is relativistic beaming: the side moving toward you is brighter. It does not drift with
     time, because the approaching side is fixed for a given view.*
   - **the lensed disk** is an annulus at r 0.85–1.7 carrying the same two dark arms and inward-streaming dashes as the disk
     (item 3), drawn in screen angle φ with a rotation sense σ = +1 when the eye is above the disk plane and −1 below
     (`bandSense`), alpha `0.85·sqrt(1 − |v.y|)·strength`, in the disk's glow colours. *Gravity bends light from the far side
     of the disk over and under the shadow (Luminet's 1979 image; Interstellar). It is strongest edge-on, which is the usual
     view from the ground, and fades when you look straight down, where the real disk takes over.* The shadow keeps its own
     alpha inside r 0.8.
   - *True screen-space lensing needs a render-target copy of the frame each frame; rejected for cost.*
3. **The disk.** An `InstancedMesh` of `RingGeometry(0.5, 3.4, 96, 1)`, rotated flat (−π/2 about x) at the centre. It uses
   premultiplied blending, `side: DoubleSide` and `depthWrite: false`. The vertex shader passes the **world** position as a
   varying, so the angle is θ = atan2(z − cz, x − cx), exactly as in `pullAt` (*RingGeometry's local +y maps to world −z, so
   an angle taken from local coordinates would spin the disk against everything else*). **Fragment shader, normative in
   intent:**
   ```glsl
   // ru = distance from the centre in the disk plane (0.5..3.4); th = atan(vWorld.z - c.z, vWorld.x - c.x)
   // per instance: seed (0..1), strength. Uniform uPhase = (VORTEX_FLOW_RATE 9 · t) mod 2π, accumulated on the CPU.
   float lr   = log(ru);
   float arms = smoothstep(0.2, 0.85, 0.5 + 0.5 * sin(2.0 * (th + 6.2832 * seed) + 2.0 * VORTEX_SPIRAL_K * lr));
                // two stationary trailing arms = the flow's streamlines: pitch atan(1/3.33) ≈ 17°, about one turn each
   float flow = 0.5 + 0.5 * sin(5.0 * pow(ru, 1.5) + uPhase);
                // dashes sliding inward at dr/dt = −1.2/√r, the particles' speed (§6.2.10)
   float a    = arms * mix(0.45, 1.0, flow);
   float fade = 1.0 - smoothstep(2.6, 3.4, ru);                  // soft outer edge
   float heat = 1.0 - smoothstep(0.55, 2.4, ru);                 // the inner edge is hotter
   float dark = a * fade * 0.9;                                  // the BLACK vortex: alpha darkens what is behind it
   float rim  = pow(1.0 - a, 6.0) * fade * (0.35 + 0.65 * heat); // thin glowing lanes between the arms
   vec3  glow = mix(vec3(0.55, 0.12, 0.05), vec3(1.0, 0.85, 0.65), heat);   // deep red → white-hot
   gl_FragColor = vec4(glow * rim * strength, max(dark, rim * 0.5) * strength); // premultiplied
   if (gl_FragColor.a < 0.01) discard;
   ```
   **One spiral everywhere.** `VORTEX_SPIRAL_K` 3.33 is dθ/d ln ρ of the streaming particles (4/1.2, §6.2.10). The arm crests
   follow that spiral, the dashes slide inward at the particles' speed, and where a dash crosses an arm the bright blob moves
   inward and gains +θ at 4·ρ^−1.5 rad/s: material spiralling into a drain, in the same sense as `pullAt`'s swirl. Swallowed
   blocks ride the same spiral (§2.6). *No two-layer flow-map cross-fade: stationary arms with moving dashes never wind up.*
   *The user asked for a **black** vortex, so the arms darken the world rather than glow. Only the lanes between the arms
   and the inner edge emit light, which reads as a dark whirlpool rimmed with fire.*
4. **Implosion shell and arming glow.** Both share one `InstancedMesh` of an `IcosahedronGeometry(1, 2)` with additive
   blending and a fresnel rim, scaled per instance. Only holes in ARM or IMPLODE are drawn. The arming glow is a white-hot
   point swelling from the pinprick; the shell runs white → #b03a1a.
5. **Streaming particles.** These use `particles.emitOrbit` (§6.2.10).
   - The nearest `VORTEX_PARTICLE_HOLES` 4 vortices within 48 units each emit `VORTEX_PARTICLES_PER_S` 40/s.
   - Particles start on ρ 2.5–4.5 and h ±0.6 and spiral in along the disk's rotation, from soot #2e2620 far out to #ffc890
     near the core. Each one's life is set at emission so that it reaches the core (§6.2.10), where it dies at ρ < 0.45.
6. **Screen and camera** (main):
   - **White flash.** `hud.setFlashOverlay(level, 'white')` (§6.2.16), neutral white. At FLASH start,
     `level = min(BLACK_HOLE_SCREEN_FLASH_MAX 0.75, 0.75·(1 − d/48)·facing·cover)`, where
     `facing = 0.35 + 0.65·max(0, dot(viewDir, toHole))` and `cover` is 0.35 when a `raycastHex` from the eye to the centre is
     blocked (cast once per activation), else 1. It fades as `(1 − t/0.6)²`. **At most one screen-flash start per
     `BLACK_HOLE_SCREEN_FLASH_GAP_S` 0.5 s**, game-wide: a later FLASH inside that window only raises the scene light and plays
     its sound. *A flash behind a hill or behind you should not blind you, and a chain of charges must stay under 3 flashes
     per second (WCAG 2.3.1).* The pure `flashStep` helper is tested (§7 D).
   - **Pinch.** During IMPLODE, the FOV changes by `−BLACK_HOLE_PINCH_DEG (8)·(1 − d/24)·sin(π·s)`.
   - **Stretch.** Within the pull radius of the nearest vortex, `+BLACK_HOLE_STRETCH_DEG (4)·(1 − d/10)²`.
   - **Shake.** `blackHoles.cameraFx` adds 0.05 m at 9 Hz during IMPLODE, falling off over 24 units. Main sums it with the
     blast shake.
   - **The flash light.** `fallingRenderer.setFlash(x, y, z, intensity, color)` gains a colour argument (§6.2.12). Main
     passes the brighter of `explosions.flash` and `blackHoles.flash`. *There is one light, and the light count is part of
     every shader key.*

**Budget.**
- **Cores and billboards** (cheap and small) are drawn for every tracked hole **and every inert hole** within
  `VORTEX_MODEL_RANGE` 128 (inert at strength 0.2), up to `VORTEX_MAX_CORES` 256 instances, nearest first. *A hole is now an
  unmeshed block; without this, hole 17 and every inert hole would be invisible yet still targetable and deadly.*
- **Disks, shells and the lensed band** are drawn only for the nearest `VORTEX_MAX_MODELS` 16 (`full` views, §6.2.4).
- 4 draw calls in all. Every InstancedMesh sets `frustumCulled = false` (*instances are placed by a custom `aCentre`
  attribute, so three's bounds would be wrong*), and the billboard, disk and shell use `renderOrder` 2, after the
  translucent chunk layer, so they sort stably against water.
- *Fill rate*: a disk 6.8 units wide can fill the screen when you stand at the rim, and the billboard is 3.6 units. The disk
  shader is about 24 ALU ops with an early `discard`, the billboard about 30; together they cost less than one fogged chunk
  layer. `prewarm(webgl, camera)` compiles all four programs at load, after the lights exist (main's prewarm block, §6.6).

### 2.5 Pull on spiral trajectories (`pullAt`, normative)
For each hole with strength factor k_p (phase × switch, §2.3) and body offset v = body − centre, with d = |v|,
ρ = hypot(vx, vz) and 0 < d < R:
```
g       = BLACK_HOLE_PULL_STRENGTH · (1 − d/R)² · k_p                 // unchanged radial magnitude (120 m/s² at the centre)
radial  = −g · v / d
swirl   = BLACK_HOLE_SWIRL (1.6) · g · min(1, ρ / BLACK_HOLE_SWIRL_CORE (1.5))
tangent = ρ > 1e-6 ? (−vz, 0, vx) / ρ : 0                              // +θ about +y, θ = atan2(vz, vx)
out += radial + swirl · tangent
```
**What this does** (measured with the real `stepPlayer` at 30, 60 and 144 Hz).
- Physics already turns a pull into a drift: `pull / GROUND_ACCEL`, §12. So a body standing still drifts in along a
  logarithmic spiral whose path makes about 58° with the radius (atan 1.6). From 8 units in to 1.5 it sweeps about
  3.3 rad, more than half a turn, over about 7 s. *At 0.8 it swept only 1.5 rad: walking mobs curved in rather than visibly
  spiralled.*
- The radial part is unchanged, so the time to fall is unchanged. **Escaping**: a player who keeps steering straight away
  from the hole escapes from 1.5 units in every mode (walk, hop, sprint, fly). On a **fixed heading** the swirl carries you
  sideways back into the pull: walking and flying are caught from up to 2.5 units, and every mode escapes from 3. *This replaces §29's
  "escape by walking from 1.5 units", which the swirl makes false; the hint and tip say "walk straight away".*
- The swirl fades inside 1.5 units, so the last plunge is straight and nothing orbits the core forever.
- Pigs and zombies sample `world.pullAt`, so they spiral too, with no change to `pigs.js` or `zombies.js`. Survival owns
  both, and neither is touched.

### 2.6 Swallowed blocks, visibly spiralling in (`src/infall.js`, pure; package A)
**The eat record.** `BlackHoles.update` still eats one cell per hole per 0.2 s within radius 4, nearest first, with every
§29 budget. Each record now also carries the eating hole's centre: `{ q, y, r, id, cx, cy, cz }`.

**Adding an animation.** Main calls `infall.addBlock(rec, eyeX, eyeY, eyeZ)` for every record. The call adds an animation
only when all of these hold:
- the cell centre is within `INFALL_VIEW_RANGE` 48 of the eye;
- `isMeshed(id)`;
- there are fewer than `MAX_INFALL_BLOCKS` 96 animations. When full, the **oldest** animation finishes at once.

**Kinematics** (normative; s = t/D; ρe = `VORTEX_EVENT_R` 0.45; K = `VORTEX_SPIRAL_K` 3.33):
```
P0 = cell centre; ρ0 = hypot(P0.x − cx, P0.z − cz); θ0 = atan2(P0.z − cz, P0.x − cx); h0 = P0.y − cy
if ρ0 < 0.6: ρ0 = 0.6 and θ0 = a seeded angle          // a cell straight above or below the core still swirls in
D  = clamp(0.25 + ρ0^1.5 / 3.6 + 0.1·|h0|, INFALL_MIN_S 0.6, INFALL_MAX_S 2.4)
tear (s < 0.1): position = P0 + (jitter ±0.03 at 30 Hz, +0.8·s in y)          // it shudders and lifts as it tears loose
u  = clamp((s − 0.1) / 0.9, 0, 1)
ρ  = ρ0 · (1 − u)^(2/3)          // an accelerating plunge: dρ/dt ∝ −1/√ρ, like the particles
θ  = θ0 + K · ln(ρ0 / ρ)          // rides the disk's arms, in the swirl's +θ sense
h  = h0 · (1 − u)²                // settles onto the disk plane before it reaches the core
scale = 0.15 + 0.85 · smoothstep(ρe, min(ρ0, 2.5), ρ);  ry = θ + π/2;  rx = 0.35·sin(7u);  rz = 6·u²
        (plus a per-item seeded initial tilt)
ρ ≤ ρe or s ≥ 1 → removed; it reports a `gone` point at the core (main emits 3 `infall` particles there)
```
A block from ρ0 = 4 turns 1.16 times on the way in, from 2 turns 0.79 times, and from 1 turns 0.43 times.

**Drawing.** `infall.renderItems(push)` pushes `RenderItem`s into the **existing** `fallingRenderer`: main appends them after
`blockPhysics.renderItems()` (§6.6). *Never a second fallingRenderer: each one adds a PointLight.*

**The real cell.** The eaten cell is written lazily, so the chunk may show it for a frame or two after the copy appears. The
copy starts exactly on it, so the two read as one block tearing free.

### 2.7 Swallowed mobs and the player
- **Pigs and zombies.** When `swallowing(mob)` returns a hole, main removes the mob as today, then calls
  `infall.addMob(kind, mob, hole)`, keeping the mob object as a **ghost**. At most `MAX_INFALL_MOBS` 8 ghosts exist; past
  that, the mob is removed with no ghost.
  - A ghost follows the same kinematics with D = `INFALL_MOB_S` 1.2 s and no tear. Each frame its x, y, z and yaw are
    written, plus `renderScale` (1 → 0.1) and `renderSpin`.
  - Main passes `pigs.list` plus pig ghosts to `pigRenderer.sync`, and the same for zombies. The two renderers are created
    with capacity `PIG_MAX + MAX_INFALL_MOBS` and `ZOMBIE_MAX + MAX_INFALL_MOBS`, so a ghost is never dropped from a full
    list.
  - `pigRenderer` and `zombieRenderer` honour the optional `renderScale` (default 1) and `renderSpin` (an extra yaw, default
    0) (§6.2.13).
  - The squeal, and `zombieGone(zb, 'ko')`'s puff, play at the **end** of the ghost, not the start.
- **The player in Creative** is teleported to `respawnPoint` as today. In the same frame:
  - `hud.setFlashOverlay(0.75, 'void')` (near-black #0b0908, fading over 0.5 s);
  - `bhSwallow` (a falling whoosh) instead of the glass break;
  - the chat line `You were swallowed by a black hole!`, throttled as today.
- **The player in Survival** dies (`pendingDeath ??= 'blackhole'`, survival §9.5 step 7), unchanged.

### 2.8 Lifetime, switching off, breaking
- **Lifetime.** A vortex is **permanent**. Once every cell in its ball has been eaten, it keeps spinning and pulling. *A real
  black hole does not fade on a human time scale, and a hole that vanished on its own would surprise builders.* It never
  grows.
- **Breaking.** A vortex is breakable, as today: a left click on the core cell, within reach. That is the off switch. The
  hole is removed through `onBlockChange` and fires the event `collapsed`. Main then emits 24 `infall` particles bursting
  *outward* and plays `bhCollapse`, a short reversed thoom.
- **The per-world switch `blackholes`** (saved, §6.4; console `blackholes on|off`; pause-menu switch, §6.2.17). When it is off:
  - `pullAt` returns 0;
  - `update` eats nothing;
  - `swallowing` returns null;
  - `activate` refuses;
  - arming charges are cancelled, so they stay dormant;
  - holes in FLASH or IMPLODE jump straight to VORTEX;
  - vortices are drawn at strength 0.2, and `uPhase` advances at a tenth of its rate.

  *The same pattern as `zombies` and `watcher`.* Today there is no such switch; "swallowing off" exists only as wording in
  KNOWN-ISSUES.
- **Circuits cannot switch a vortex off.** *Activation is one-way, like setting off powder.*
- **Undo.** Eats, activation and breaking are not undoable, as today. Black holes are blast-proof, so a blast's undo never
  touches one.

### 2.9 Safety rules
- **`canSwallow`** stays false for AIR, liquids, BEDROCK, RUNE_BLOCK and BLACK_HOLE.
  - Circuit parts, charges and kegs are swallowed like any block. A part's store entry is dropped (§4.8). A swallowed keg
    does not explode, as today.
- **No spawn guard.** `respawnPoint` already searches 32 rings for a spot out of every hole's reach, so a vortex at the
  world spawn cannot trap the player.
- **The player cannot be swallowed** during ARM, FLASH or IMPLODE, because swallowing needs VORTEX. With pull × s² ramping
  over 1.2 s, a player standing next to a charge that goes off has about 1.5 s to get clear by walking straight away. In
  Creative the worst case is a teleport home.
- **`placeSelected`** refuses a `COLLAPSAR_CHARGE` that would intersect the player. It is solid, so the solid rule already
  covers it. The `BLACK_HOLE` branch becomes dead code: the block is not placeable.

### 2.10 Old saves
| Saved | Loads as |
|---|---|
| Edits holding `BLACK_HOLE` | Active vortices at VORTEX: no flash, full pull and eating. They are drawn by the new renderer, since the block is now unmeshed |
| `hotbar` holding 66 | That slot holds `COLLAPSAR_CHARGE` (`hotbarFrom` maps it) |
| A save without `blackholes` | On |
| Rune scripts `setblock … black_hole` | Still work: an instant vortex, which now flashes and implodes (with no charge copy) |
| `give black_hole` | Fails: `a black hole cannot be held — give collapsar_charge and set it off` |

### 2.11 Sound (recipes in `circuitSounds.js`, §6.2.11)
| Name | When | Recipe |
|---|---|---|
| `bhArm` | ARM start | A sine rising 180 → 900 Hz over 0.4 s, with filtered noise rising 300 → 2500 Hz, gain 0.35 |
| `bhFlash` | FLASH start | A noise burst through a 3 kHz high-pass for 0.08 s, then a sine 2400 → 300 Hz over 0.25 s, gain 0.8 |
| `bhImplode` | IMPLODE start | Noise with a lowpass rising 200 → 4000 Hz over 1.1 s (a reversed swell), ending in a thoom of 0.7 s: a sine 55 → 28 Hz, a second sine 110 → 56 Hz at half its gain, and a 20 ms noise thump through a 300 Hz lowpass. Gain 0.9 |
| `bhCollapse` | Broken | A sine 28 → 70 Hz over 0.4 s with a 2× partial (56 → 140 Hz) at half gain, plus a 0.2 s noise puff |
| `bhSwallow` | The player is swallowed | Noise through a bandpass falling 1800 → 200 Hz over 0.6 s |
| `bhDrone` (loop) | Always, at the nearest vortex within 24 units | Sines at 38 Hz and 57 Hz, plus partials at 114 Hz (gain 0.4) and 171 Hz (gain 0.25), with a 0.3 Hz amplitude LFO, plus a "wind" of noise through a 400 Hz bandpass. The volume is `0.5·(1 − d/24)`; the pitch rises 10 % within 3 units. One voice in all |

*Laptop and phone speakers roll off below about 100–150 Hz, so every low sound carries a partial above that; the
missing-fundamental effect keeps the drone's pitch at 57 Hz.* Range and volume follow `PHYSICS_SOUND_RANGE` 24, except
`bhFlash` and `bhImplode`, which carry `BOOM_SOUND_RANGE` 96.

=====================================================================================================================
## 3. Powder kegs

### 3.1 What changes for the player
- **Names.** Every player-visible "Blast Barrel" or "barrel" becomes "Powder Keg" or "keg":
  - the display name, the crosshair hints, the controls sheet, chat lines and console messages;
  - the three strings in `blockphysics.js` (survival A's file, changed by B in a post-merge edit, §7.1): the undo notes
    `(N barrels next to a campfire not given back)` → `(N kegs or fuses next to a fire not given back)` and
    `(N barrels found no room)` → `(N kegs found no room)`, and the `physics status` field `lit barrels` → `lit kegs`;
  - README, CONTRACTS §37 wording, and KNOWN-ISSUES (new entries; history rows stay as written).
- **Lighting.** The R key on a keg **no longer lights it**. *The prompt "R: light" was read as "right click", which places a
  block instead, and the user asked for fuse, switch or circuit activation.* There is no manual "light it in your hand"
  option: the manual way is the R key on a Powder Fuse laid to the keg (§4.3), which is what blasters did.
- **It burns where it stands.** A keg never turns into a tumbling, swelling entity in play any more (§3.2).

### 3.2 How a keg is lit now
Every way of lighting a keg makes it **burn in place** (`explosions.igniteInPlace`, §3.4): the block stays, sparks rise from
its bung, and it goes off when its fuse ends.

| Cause | Fuse | Why |
|---|---|---|
| A Powder Fuse finishing next to it (§4.3) | `KEG_DIRECT_FUSE_S` 0.25 s | *When the flame reaches the powder, the keg goes off. Fuse length and the clockwork timer are the timing devices* |
| A powered Igniter firing next to it (§4.6) | 0.25 s | *"Push the plunger, BOOM"* |
| A Linstock beside it (circuits' flame queue, §4.3) | 0.25 s | |
| A Campfire beside it (today's `ignite` trigger, reseeder and rule; the rule now calls `igniteInPlace`) | `BARREL_FUSE_S` 3 s | *A fire set beside a keg gives you time to react* |
| `ignite q y r` | 3 s | The same |
| A blast reaching it | today's 0.3–0.8 s fuse timers, unchanged | |

- **Putting it out.** A left-click on a keg that burns in place **pinches its fuse out and keeps the keg**
  (`explosions.snuff`). *In practice only the 3 s fuses can be caught.* In Survival a left press does the same, with no dig.
- **Unchanged:** kegs going off together merge into one chain blast, which undo restores; a collapse leaves a burning keg
  hanging until it goes off (`hangBurning`); the `explosions` switch; saving burning kegs as kegs.
- **The lit-keg entity** (`_light`'s tumbler) is no longer reached by any game path. It stays in `explosions.js` for its
  tests and is documented as "programmatic lighting" (`lightAt`). Its hint (`lit keg · left-click: put it out`) stays for
  completeness.

### 3.3 Hints, messages and the R key
| Situation | Text |
|---|---|
| Looking at a keg | `Powder Keg · light it with a fuse, a linstock or an igniter` |
| A keg, explosions off | `Powder Keg (explosions are off)` |
| A keg burning in place | `Powder Keg · burning! left-click: pinch out the fuse` |
| A lit keg entity | `lit keg · left-click: put it out` |
| The R key on a keg, no Spark Transmitter selected (chat, at most once per 4 s) | `Powder kegs need a flame: lay a Powder Fuse to it and light that with the R key, or wire an Igniter. Shift+R key on a part tells you more.` |
| `ignite` messages (explosions.js) | `there is no powder keg at (q, y, r)` · `the keg at (q, y, r) is already burning` · `lit the powder keg at (q, y, r) — 3 s fuse` |
| CONTROLS_SHEET row R | §4.9 |

### 3.4 `explosions.js` changes (package B)
1. **Messages.** The strings above. Tests asserting the old strings are updated: `explosions.test.js` around L139–146 and
   `commands.test.js` around L1025.
2. **`igniteInPlace(q, y, r, fuse = KEG_DIRECT_FUSE_S) → { ok, message, quiet? }`.** Refuses with today's messages when
   explosions are off, the cell is unloaded or holds no keg. A keg already burning returns `{ ok: false, quiet: true }`
   (*an igniter refires every 0.5 s; it must not shorten or chat*). Otherwise `_addTimer(q, y, r, fuse, 0)`, a `hiss` and 6
   `sparks` at the bung, and `ok`. The existing per-frame timer sparks (`MAX_TIMER_SPARKS_PER_FRAME`) draw the burning.
3. **`ignite(q, y, r)`** (the command) becomes `igniteInPlace(q, y, r, BARREL_FUSE_S)`, with the `3 s fuse` message.
4. **`_igniteRule`** (a campfire beside a keg) calls `igniteInPlace(q, y, r, BARREL_FUSE_S)` instead of `_light`.
5. **`snuff(q, y, r) → boolean`.** Removes a burning-in-place timer (running `_unhang` for a hung one), plays a short `hiss`
   at volume 0.3 and returns true. False when the keg is not burning in place.
6. **`onCharge`.** `this.onCharge = null` is set by main to `(q, y, r) => blackHoles.activate(q, y, r, blackHoleWorld)`.
   - In `_blast`'s **scan loop** (around L761), before `if (isBlastProof(id)) continue;`, a `COLLAPSAR_CHARGE` inside the
     same `radius + jitter` test is pushed to a `charges` list and skipped. After the write loop, `onCharge(q, y, r)` is
     called for each. *If the check went in the write loop, the blast-proof test would already have filtered the charge
     out, and blasts would never set charges off.*
   - `BLAST_PROOF_IDS` gains `COLLAPSAR_CHARGE`, so a charge is never destroyed.
7. **Undo give-back.** `cancelEvent(id, writeBarrel)` skips a keg for which the physics hook `ignitesAt(q, y, r)` (§3.6)
   is true, counting it in `burnt`.
8. **`lightAt`** is no longer called by main. It is kept (tests use it) and documented as "programmatic lighting".

### 3.5 The keg's look (package K0 moves, package C repaints)
- **K0** moves `paintBarrelSide` and `paintBarrelTop`, unchanged and with their doc comments, from `tiles.js` into
  `circuitTiles.js`, whose `CIRCUIT_RECIPES` then holds `barrel_side` and `barrel_top`. `tiles.js` drops its two `RECIPES`
  lines and gets them through the spread (§6.2.9). *Survival A owns `tiles.js` and never touches these painters, so the
  hunks are disjoint.*
- **C** repaints them:
  - **`barrel_side`**: the same staves, with **copper hoops** (#b0683a, highlight row #d08a52) in place of the iron bands,
    and a burnt-in maker's brand (a #3a2412 hex outline with three dots) in place of the red hazard hexagon and "!".
    *Powder kegs were hooped with wood or copper, never iron, so a knock could not strike a spark.*
  - **`barrel_top`**: the plank lid with a copper rim and an **unlit** wooden bung with a dark cord stub; no ember. A keg
    burning in place is shown by circuitRenderer's `glow: 'fuse'` at the bung (§4.11) and explosions' sparks.

### 3.6 Undo never relights a restored scene (B's post-merge edit to `blockphysics.js`)
*blockphysics' undo already refuses to restore a keg beside a CAMPFIRE, which would light at once and blow the restored scene
up a second time (§33.8.4). A Linstock, a still-powered Igniter (it refires every 0.5 s) and a fuse cell restored beside a
flame do the same.*
- `PhysicsHooks` gains two optional hooks: `isIgnitable(id)` (main → `circuitParts.isIgnitable`) and `ignitesAt(q, y, r)`
  (main → `circuits.wouldIgnite`: a flame neighbour or a powered igniter neighbour).
- Undo's restore-last list takes `prev === BLAST_BARREL || hooks.isIgnitable?.(prev)`, and writes each with its own `prev`
  id. A cell is skipped (counted in the note) when `_hasNeighbour(CAMPFIRE) || hooks.ignitesAt?.(q, y, r)`.
- Integration test: the quarry wired to a battery through a closed switch; after the blast, undo restores no keg or fuse
  beside the igniter.

=====================================================================================================================
## 4. Circuits

### 4.1 Principles
1. **Real parts, real rules, small numbers.** Every part is a real 19th-century device with a short history tip. The physics
   is simplified honestly:
   - Ohm's law: every wire cell loses volts **in proportion to the current** flowing through it, so adding loads dims every
     load on that wire, and an idle wire reads the full source voltage;
   - a return path through the earth;
   - batteries that add up when stacked, tire, and run down;
   - relays that need their own local battery.
2. **It works the obvious way first.** A battery and a lamp standing on the ground, joined by wire, light up. The lessons
   (earth, voltage drop, series and parallel, relays) appear only when a build needs them, and the hint then says exactly
   why, including when a layout touches where it should not (§4.5).
3. **Hex-native.** A part touches up to 8 neighbours: 6 sides, top and bottom. Wires join every same-kind neighbour, so a
   junction is free. Insulation colours keep neighbouring circuits apart. Cells on neighbouring faces touch, so wires run in
   and out of a device through faces at least two apart.
4. **No glowing wires, no 0–15 power levels, no inverter torches.** You see electricity the way you do in life: a lamp lights,
   a bell rings, and a meter (the crosshair readout) shows volts.

### 4.2 The parts (`PARTS` in `src/circuitParts.js`; K0)
`partOf(id) → PartDef | null`. The fields of a `PartDef`:

| Field | Meaning |
|---|---|
| `id` | The block id |
| `key` | Stable save string: the store kind `k` (§4.8) |
| `role` | `'wire'`, `'junction'`, `'source'`, `'contact'`, `'load'`, `'fuse'`, `'flame'` or `'ignitable'` |
| `wire?` | `'copper'`, `'brown'`, `'white'` or `'earth'` |
| `volts?` | A source's output |
| `vMin?` | A load's (or input's) minimum voltage |
| `amps?` | A load's (or input's) current, which is both its share of the wire drop and its battery drain (§4.4) |
| `input` | Has one input face (relay coil, timer start, coherer tapper) |
| `earth` | Needs earth: sources and loads |
| `control` | Right-click operates it (§4.9) |
| `fields` | The store fields saved for it (§4.8); `[]` = no store entry |
| `origin` | The real thing, one line (the "Real thing" column below; the Guide prints it) |
| `tip` | The teaching line (§4.13) |

| Part (key) | Real thing | Role | State | You operate it by | Settings (Shift+R key) |
|---|---|---|---|---|---|
| Copper Wire `copper_wire` | Bare copper line wire strung on porcelain knobs, as telegraph lines were | wire | — | — | — |
| Brown Wire `brown_wire`, White Wire `white_wire` | Cotton-braided insulated wire | wire | — | — | — |
| Earth Wire `earth_wire` | A green-and-yellow earth (ground) conductor | wire (earth graph only) | — | — | — |
| Terminal Board `terminal` | A board of brass binding posts | junction | — | — | label |
| Voltaic Battery `battery` | A Voltaic pile: twelve copper–tin pairs and brine | source, 6 V, tiring below 25 % | charge c | — | label · Refill (Creative) |
| Blasting Machine `blaster` | A rack-bar magneto exploder (1880s) | source, 24 V pulse 1 s | plunger | **right-click** or **R key**: plunge | label |
| Selenium Panel `selenium` | A panel of Fritts selenium cells (1883) wired in series | source, 0–3 V by daylight | — | — | label |
| Knife Switch `switch` | A laboratory knife switch | contact | on/off (saved) | **right-click** or **R key**: toggle | label |
| Push Button `button` | A momentary push switch, normally open or normally closed | contact | pressed | **hold right-click** (or the R key) | NO/NC, label |
| Clockwork Timer `timer` | A spring-wound clockwork time switch | contact plus an input face (start) | idle/running/closed | **right-click** or **R key**: wind and start, or stop | delay 0.5–3600 s, mode pulse/hold/repeat, input face, label |
| Relay `relay` | Joseph Henry's electromagnetic relay (1835) | contact plus an input face (coil) | energised | **R key**: push the armature by hand | NO/NC, input face, label |
| Igniter `igniter` | A hot-wire (bridgewire) igniter | load, 3 V, 2 A | hot | — | label |
| Filament Lamp `lamp` | A carbon-filament lamp (Swan and Edison, 1879) | load, 1.5 V (full at 6 V), 1 A | brightness | — | label |
| Electric Bell `bell` | A trembler bell with a steel gong | load, 2.5 V, 1 A | ringing | — | label |
| Spark Transmitter `tx` | Marconi's spark-gap transmitter (1895) | load, 2.5 V, 0.5 A (a rising edge sends) | flash | **right-click** or **R key**: its Morse key sends | wavelength, label |
| Coherer Receiver `rx` | A coherer with a local relay and an electric tapper | contact plus an input face (tapper) | closed | **R key**: tap | wavelength, mode pulse/latch, input face, label |
| Powder Fuse `fuse` | Safety fuse (William Bickford, 1831): a black-powder core sealed in tarred, twine-wrapped cord | fuse | burning | **R key**: light it here | — |
| Linstock `linstock` | A gunner's staff holding smouldering slow match (cord soaked in saltpetre) | flame | always smouldering | — | — |
| Powder Keg `keg` (id 75) | A copper-hooped keg of black powder | ignitable | burning (explosions.js) | — | — |
| Collapsar Charge `charge` | A fictional collapse device | ignitable | arming (blackholes.js) | — | label |

**Two roles in one cell.** The Relay, the Clockwork Timer and the Coherer Receiver are `role: 'contact'` with `input: true`, so
they are **also a load on their input face**:
- the relay coil: `vMin` 2.5, 0.5 A;
- the timer start: `vMin` 2.5, 0 A (a mechanical latch);
- the coherer's electric tapper: `vMin` 2.5, 0.5 A.

That input face is never a contact terminal (§4.5).

**`PARTS` and CAMPFIRE.** `PARTS` also holds a `flame` entry for CAMPFIRE, so the flame rule can index it. `isPart(CAMPFIRE)`
is false, and `hintFor` and `interact` return null for it.

**Constants** (config.js, §6.3):

| Constant | Value |
|---|---|
| `BATTERY_V` / `BATTERY_EMPTY_V` | 6 / 4.5 (the voltage just before empty) |
| `BATTERY_KNEE` | 0.25 of capacity: below it the voltage falls |
| `MAX_PILE` | 4 batteries (24 V) |
| `BLASTER_V` | 24 |
| `SELENIUM_MAX_V` | 3 |
| `LAMP_MIN_V`, `LAMP_FULL_V` | 1.5, 6 |
| `COIL_MIN_V` (relay coil, bell, transmitter, timer start, tapper) | 2.5 |
| `IGNITER_MIN_V` | 3 |
| `LAMP_AMPS`, `BELL_AMPS`, `IGNITER_AMPS`, `COIL_AMPS` | 1, 1, 2, 0.5 |
| `WIRE_OHMS` | 0.0625 Ω per wire cell |
| `VOLT_UNIT` | 0.0625 V: every voltage is a whole number of units, so the solver uses a bucket queue |

### 4.3 Mechanical: the Powder Fuse and the Linstock
**Flames and ignitables.**
- **Flames** (`isFlame`): CAMPFIRE and LINSTOCK. *A powered igniter acts like a flame only on its own firings (§4.6). A
  burning fuse lights only on finishing, below.*
- **Ignitables** (`isIgnitable`): POWDER_FUSE, POWDER_KEG and COLLAPSAR_CHARGE.

**The flame rule.** A flame and an ignitable that are face-neighbours (8 faces) light the ignitable. The rule runs through
the **flame queue** in `Circuits` (pure; drained once per circuit tick, §4.7):
- **Trigger** (`onBlockChange`, bookkeeping only):
  - `next` is a flame → queue each ignitable neighbour;
  - `next` is an ignitable with a flame neighbour → queue it.
  - CAMPFIRE next to POWDER_KEG is left to today's `ignite` trigger and rule (now in place, §3.4), so it is never lit twice.
- **Load and stream-in.** `loadFromEdits` and `onChunkLoaded` queue every indexed ignitable that has a flame neighbour. Every
  part and flame is an edit, because worldgen emits none of them.
- **Drain.** A queued cell whose chunk is not loaded stays queued (at most `MAX_FLAME_QUEUE` 4096; beyond that it is dropped,
  and stream-in re-queues it). Otherwise the cell is dispatched by id:

  | Id | Dispatched to |
  |---|---|
  | Fuse | `lightFuse(q, y, r, fromFace)` |
  | Keg | `hooks.igniteKeg(q, y, r)`, which is `explosions.igniteInPlace(q, y, r)` (0.25 s) |
  | Charge | `hooks.activateCharge(q, y, r)` |

**The Powder Fuse** (Bickford's safety fuse).
- **Lighting.** A fuse cell is lit by:
  - a flame neighbour;
  - a neighbouring fuse cell that finishes burning;
  - an igniter firing next to it;
  - **the R key on the fuse cell** (Creative: always; Survival: §8.3);
  - `ignite q y r`.

  It is **not** lit by the R key or a click anywhere else, by water or by a vortex.
- **Burning.** `burning: Map<packCell, { t, from }>`, where `t` is the seconds left (starting at `FUSE_CELL_S` 0.4) and `from`
  is the face the flame came in by (−1 = lit in place).
  - Each tick: `t −= CIRCUIT_TICK_S`, **only while the cell's chunk is loaded**.
  - At `t ≤ 0` the cell **finishes**:
    1. if it is no longer POWDER_FUSE, drop the entry (someone cut the fuse);
    2. otherwise add it to **`spent: Set<packCell>`** and queue a lazy write of AIR (deferred, §4.7). The write emits
       smoke and sparks at the cell, at most `MAX_FUSE_PUFFS_PER_TICK` 24 puffs per tick;
    3. then, for every face neighbour: an unlit, unspent fuse starts burning with `from = FACE_OPPOSITE[f]`; a keg goes to
       `igniteKeg`; a charge goes to `activateCharge`.
  - `lightFuse` refuses a spent cell; a cell leaves `spent` when its block changes (the AIR write or anything else). *A
    finished cell waiting behind the write cap would otherwise be relit by its neighbour, and a large fuse fill would burn
    back and forth for ever.*
  - So a fuse burns at **2.5 cells/s**, lights all its branches at once, and **is used up**.
- **Cutting.** Breaking a burning cell cuts the fuse. Its trigger drops the entry, so the flame stops there.
- **Water.** Water around a fuse does not put it out. *Bickford's safety fuse was tarred so that it burned underwater;
  miners relied on that.* Like every thin part, a fuse cell holds no water and blocks its flow (§1.2).
- **Limits.**
  - At most `MAX_BURNING_FUSES` 2048 cells burn at once. A fuse that would start beyond that waits in the flame queue.
  - At most `MAX_CIRCUIT_WRITES_PER_TICK` 32 burnt-fuse writes per tick; the rest finish on the next tick.
  - Only the nearest `MAX_FUSE_SPARK_CELLS` 16 burning cells emit spark particles each tick (*the particle ring is shared
    with blasts and vortices*).
  - Burning is **not saved**: on reload a half-burnt trail is simply a shorter fuse, like keg fuses (§37.4.2).
- **The spark.** The visible spark (§4.11) runs from the `from` face edge to the centre over the first half of `t`, then out
  along every other connection over the second half. The burnt part is covered by `char` overlays.
- **Sound.** One `fuseHiss` every 0.4 s at the burning cell nearest the player. It reuses `audio.playHiss` at volume 0.5.

**The Linstock.** A THIN flame that is always lit: a smouldering slow match held on a gunner's staff.
- It lights neighbouring ignitables **at once** (the flame rule).
- Drawn (§4.11): a full-height staff leaning 12° with an iron spike foot and a forked serpent head holding the match
  sideways, its dim ember beside the fork, and one thin smoke wisp every 1.5 s while within 32 units. No flame particles, no
  light.
- It needs no fuel and never goes out. *Survival may later give it a burn time (§8.3).*
- It is not a power source and has no logic.

### 4.4 The electrical model: one wire out, the earth back
*Every real circuit is a loop. The first long-distance telegraphs (Steinheil, 1838) used a **single wire** and let the ground
carry the current back, and cars still use the chassis the same way.* Caelancraft does the same.

**Terminals.**
- A device's **earth terminal** is its bottom face plus any face touching an Earth Wire (a ground strap).
- Its **live terminals** are the remaining faces 0–6 (for an input, only the input face).
- A face touching an Earth Wire never attaches a signal conductor. *So a ground strap can never short a live terminal.*

**A device is earthed** (`earthed(q, y, r)`, cached per device) when any of these holds:
1. **its column reaches the ground**: walking down from the block below, through at most `EARTH_WALK_CELLS` 8 cells of
   **earth** (`isEarth`), it reaches a natural (non-edit) earth block, or the bottom of the world. A placed earth block
   passes the walk on; anything else stops it. *A dirt block on a sky platform is not the ground, and the hint says so:
   `not earthed: this dirt is not connected to the ground`;*
2. an earth terminal touches an EARTH_WIRE cell whose **earth net is grounded**: an earth net is a connected set of
   earth-wire cells, and it is grounded when any of its cells passes the walk of rule 1;
3. it is a battery in a **pile** (below) whose bottom battery is earthed.

`isEarth` is a 256-entry table built at load **from block names through `BLOCKS`**, skipping names that do not exist (so it
works with or without survival's blocks): stone, dirt, grass_block, snowy_grass, sand, red_sand, gravel, clay, cobblestone,
mossy_cobblestone, stone_bricks, mossy_stone_bricks, bricks, granite, diorite, andesite, slate, sandstone, bedrock, the ores
(coal, iron, gold, diamond, and survival's copper and tin), coal_block (as rock), iron_block, gold_block, copper_block, and
every water-family id. Metal blocks therefore conduct to earth only when they sit on it.

These are **insulators**, so they are never earth:
- wood: logs, planks, bookshelf;
- leaves, wool, glass, ice, packed ice, snow, hay, pumpkin, honeycomb;
- obsidian (volcanic glass) and DIAMOND_BLOCK (diamond is an insulator);
- glowstone;
- every circuit part (except a battery in a pile, rule 3).

- **Every source and load must be earthed** to work. An unearthed one shows `· not earthed` in its hint, with the reason.
  On first placement the tip line explains why (§4.13).
- **Earth is one big conductor.** Any earthed device returns to any other. *This is how the telegraph model works. Following
  current through the soil cell by cell would cost a search per device and teach nothing more.*
- **No short circuits** in v1: wires connect only as in §4.5, so a live wire can never touch earth (§10).

**Volts: Ohm's law.**
- A network's **current** is `I_net = Σ amps` over the earthed loads attached to it (lamp 1, bell 1, igniter 2, relay coil
  0.5, transmitter 0.5, tapper 0.5, timer start 0). A load counts **whether or not it reaches its vMin**: a cold filament
  still conducts. So `I_net` depends only on the layout, and there is no feedback. A load attached to two networks counts on
  both.
- **Every wire cell drops `WIRE_OHMS × ⌈I_net⌉`**, the current counted in whole amps, rounded up: one `VOLT_UNIT` per amp.
  Terminal boards and closed contacts drop nothing.
- With **no load** (`I_net = 0`) the whole network sits at the source voltage: the multimeter reads 6 V all along an open
  line, as a real one does.

| Source | Load(s) at the end of one wire | Volts lost per cell | Longest run |
|---|---|---|---|
| Battery 6 V | one lamp (1 A, needs 1.5 V) | 0.0625 | 72 cells |
| Battery 6 V | one relay coil (0.5 A, 2.5 V) | 0.0625 | 56 cells |
| Battery 6 V | one bell (1 A, 2.5 V) | 0.0625 | 56 cells |
| Battery 6 V | one igniter (2 A, 3 V) | 0.125 | 24 cells |
| Battery 6 V | three lamps (3 A) | 0.1875 | 24 cells |
| A pile of two batteries, 12 V | one igniter | 0.125 | 72 cells |
| Blasting Machine 24 V | one igniter | 0.125 | 168 cells |
| Selenium Panel 3 V | one relay coil | 0.0625 | 8 cells |

*Copper's resistance is small but real; at our scale long runs and heavy loads need a pile, a relay or the 24 V blasting
machine, which is exactly the lesson telegraph engineers learned.*

**Charge.** A battery holds `BATTERY_CAPACITY` 3600 amp-seconds, so one lamp burns for an hour of real time (six game days).
- **Discharge.** For c > 0, `V(c) = floorToUnit(6 × (0.75 + 0.25 × min(1, c / (BATTERY_KNEE × BATTERY_CAPACITY))))`: a flat
  6 V down to 25 %, then falling to 4.5 V at empty, then 0. The battery is marked dirty whenever the rounded value changes
  (24 times in a discharge). *So a tired battery really does dim a lamp: on 20 cells of wire a lamp falls from brightness
  0.72 (4.75 V) to 0.39 (3.25 V).*
- **Who pays.** Each tick, an active network draws `I_net × CIRCUIT_TICK_S` from the sources that give it its **highest**
  voltage, split equally among them (batteries side by side are in parallel: the same voltage, longer life). A source in a
  pile charges its share to **every** battery from the bottom up to it (in series the same current flows through every
  cell). Selenium panels and the blasting machine never drain or charge anything.
- **When a battery is empty** it stops being a source, and every battery above it in a pile reads 0.
- **Refilling.** A battery is refilled with fresh plates: the Creative "Refill" button (§4.10), or a Survival recipe (§8).
  *Voltaic and Leclanché cells are primary cells; they are not recharged.*

**Piles (series).**
- A Voltaic Battery standing **directly on** a charged battery adds to it: the live faces of the k-th battery of a pile carry
  `Σ V_i(c_i)` for i ≤ k. At most `MAX_PILE` 4 high (24 V); a fifth reads `· pile too tall (4 at most)` and does nothing.
- Only the bottom battery needs earth. A flat battery makes every battery above it read 0.
- *Volta's own pile was a series stack: "add a cell to get more volts" is the oldest circuit lesson. Side by side on one
  network they stay in parallel.*

### 4.5 Connections on the hex (normative)
**Conductor cells** are wires (signal kinds), terminal boards and **closed** contacts. Each conductor cell is a node of a
signal network.

**Edges.** Two face-neighbouring conductor cells A and B (A's face f, B's face `FACE_OPPOSITE[f]`) are joined when **both
accept** the shared face and, if both are wires, they are **the same kind**.

| Cell | Accepts |
|---|---|
| A wire (copper, brown or white) | All 8 faces |
| A terminal board | All 8 faces, with any signal wire kind |
| A closed contact | All 8 faces **except** its input face (relay, timer, coherer) |
| An open contact | Nothing: it is not a conductor at all |
| An earth wire | Never a signal node. It joins only other earth wires, in the separate earth graph |

**Attachments** (devices that are not nodes):
- A **source** attaches to each neighbouring conductor through its live faces.
- A **load** attaches through its live faces (faces 0–6 not touching an earth wire, or only the input face for an input).
- **Devices never join each other directly**: a wire, a Terminal Board or a closed contact must be between them, as real
  terminals need a conductor. (The one exception is a battery standing on a battery, which makes a pile, §4.4.) *A lamp set
  against a battery stays dark, and its hint says `· 0 V: join it to the battery with a wire`.*

**Neighbouring faces touch.** The two cells on neighbouring side faces of any cell (f and f+1 mod 6) are face-neighbours of
each other. So:
- wire coming into a switch on W and leaving on SW or NW joins the two runs directly, and the switch does nothing;
- a relay's local battery on a face next to its input face touches the incoming wire and holds its own coil on.

The rule of thumb, printed in the Knife Switch and Relay tips: **run wires in and out of a device through faces at least two
apart (opposite is best), or use brown on one side and white on the other.** Every worked example (§4.14) names its faces.

**Diagnostics** (`hintFor` and `probe`; cheap, because every node already has a `netId` and a `seg`, §4.7):
- **Bypassed contact.** An open contact touching two or more conductor cells that all lie in one `seg` (joined by wire and
  terminal boards alone, not through another contact), or a source touching the contact that also attaches directly to one
  of those segs: `Knife Switch · bypassed: the wires on either side touch — run them out of opposite faces, or use brown on
  one side and white on the other`. *A start button bridged by its relay's own contacts (the latch, §4.14) is not flagged:
  that bridge passes through a contact.*
- **Self-fed relay.** A relay (or coherer) whose input network has a source that also touches one of its contact faces:
  `Relay · its own battery feeds the coil — move the battery away from the input face`.
- **Load against a source.** A load with no conductor attached and a source face-adjacent: `· 0 V: join it to the battery
  with a wire`.

**Splitting and joining.**
- Any wire cell with three or more same-kind neighbours is a split: the network is one node set, so current reaches every
  branch.
- A **Terminal Board** joins different colours (the "splitter/joiner").
- *Real circuits branch at any joint; a hex cell has room for six.*

**Drawing** follows the same rules (§4.11): a wire runs from its cell's knob toward each face it is joined or attached
through.

### 4.6 Each part's rules
**Sources** (active only while earthed):

| Source | Rule |
|---|---|
| Voltaic Battery | `V(c)` (§4.4), and in a pile the sum of the batteries below it |
| Blasting Machine | Right-click or the R key **plunges**: 24 V for `BLASTER_PULSE_S` 1.0 s, then 0. The handle rises again over `BLASTER_RESET_S` 1.5 s, and a plunge during the reset is refused (`the handle is still rising`). Never driven by a circuit: *a blasting machine is the human in the loop* |
| Selenium Panel | `3·clamp(1.5·daylight, 0, 1)` V, rounded down to a whole `VOLT_UNIT`. `daylight = hooks.daylight()` (main: `clamp(sunDirection(time)[1] / 0.5, 0, 1)`), × 1 when the sky above is open, else × 0. **Open sky** is the engine's own test: every cell above the panel up to `WORLD_HEIGHT` is non-opaque (`isOpaque` false), so a panel under glass works. Re-evaluated every 20 ticks (1 s); a change makes the cell dirty |

**Contacts** (conductors while closed):

| Contact | When it is closed |
|---|---|
| Knife Switch | While `on` (store, default off). Right-click, the R key or `switch … on/off/toggle` flips it |
| Push Button | A momentary switch: **normally open** (default) it is closed while it is pressed; with `nc` set (normally closed) it is open while pressed. A press (right-click or the R key) holds it for at least `BUTTON_PULSE_S` 0.3 s; **while the operating button stays held on the same Push Button**, main refreshes it every frame (`circuits.hold`), and it releases `BUTTON_RELEASE_S` 0.1 s after you let go. `switch … press` gives one 0.3 s press |
| Relay | While `energised XOR nc`, applied `RELAY_DELAY_TICKS` 1 tick (50 ms) after the coil changes. The coil, on the input face `f`, is energised while its live voltage is ≥ 2.5 and the relay is earthed. **The R key pushes the armature by hand**, as a real relay's test lever does: the contacts act as if energised while the R key is held on it, or for `RELAY_HAND_S` 0.5 s on a press. NO/NC is set only in the device panel. *A relay is wired NO or NC; a poke does not change that* |
| Coherer Receiver | **pulse** mode (default): closed for `RADIO_PULSE_S` 1 s after a matching signal arrives (applied 1 tick after the send), then tapped open by its own trembler, as Marconi's receiver was. **latch** mode: closes on a matching signal and **stays closed until tapped**: the R key, or a rising edge of ≥ 2.5 V on its tapper input face `f` (the electric tapper; 0.5 A; needs earth). *A radio wave can only make the filings cling; a second wave cannot open it, only a tap can* |
| Clockwork Timer | See below |

**The Clockwork Timer.**
- **Settings.** `s` (delay) is 0.5–3600 s in 0.5 s steps, default 5. `m` (mode) is `pulse` (default), `hold` or `repeat`.
- **Starting.** It starts (winds) on right-click, the R key, `timer … start`, or a **rising edge** of ≥ 2.5 V on its input face
  (needs earth; draws nothing).
- **Running.** It counts down `s`, frozen while its chunk is unloaded. At zero:
  - `pulse`: closed for `TIMER_PULSE_S` 1 s, then idle;
  - `hold`: closed until right-click, the R key or `timer … stop` (`on` saved);
  - `repeat`: a clock of period `s`. Each period it is **closed for c = clamp(⌊(s/2) / CIRCUIT_TICK_S⌋ · CIRCUIT_TICK_S,
    CIRCUIT_TICK_S, TIMER_PULSE_S) and open for s − c**. So s = 0.5 gives 0.25 s closed and 0.25 s open, s = 1 gives 0.5 / 0.5,
    and s ≥ 2 gives 1 s closed. Every period has exactly one rising edge. `run` is saved, so a clock restarts on load.
- **Stopping.** Right-click or the R key on a running timer **stops** it (idle, open).
- **The dial.** A running timer's hand shows `left / s` (§4.11).

**Loads** (powered while earthed and their live V ≥ `vMin`):

| Load | Rule |
|---|---|
| Filament Lamp | Brightness `clamp((V − 1.5) / 4.5, 0, 1)`. *A dim lamp tells you the wire is long, the wire is shared, or the battery is tired* |
| Electric Bell | Rings while powered: `bellRing` every 0.12 s, throttled to the nearest ringing bell within 24 units; the trembler hammer jitters |
| Igniter | Fires on the **rising edge**, then every `IGNITER_REFIRE_S` 0.5 s while powered. Each firing lights all 8 neighbours: a fuse is lit, a keg goes to `igniteKeg` (0.25 s; a keg already burning is silently left alone), a charge goes to `activateCharge`. It glows red while powered (`hot`) |
| Spark Transmitter | **Sends** on a rising edge on any live face (0.5 A), on the R key, or on right-click. *Its own small spark-coil cell powers the spark, so it needs no battery to send by hand and never runs down in v1 (§10).* |

**Radio wavelengths.** The 16 channels are named by wavelength, as spark-era operators tuned: channel i (1–16) is
`300 + 50·(i − 1)` m, from 300 m to 1050 m. **600 m** (channel 7) is marked `distress`: the 500 kHz maritime calling
wavelength from 1906. The store keeps the index `ch`; hints, the panel and chat print `400 m`. Default: channel 1 (300 m).

**What a send does.**
- **Reach.** It reaches every Coherer Receiver on the **same wavelength** whose cell centre is within `RADIO_RANGE` 160 units
  (3D) of the transmitter and whose chunk is loaded.
- **Arrival.** The receivers change state on the **next** tick.
- **Repeats.** A transmitter sends at most once per tick.
- **Feedback.** It flashes for 0.15 s and plays `sparkZap`.
- **Remote on and off.** Receiver A (300 m, latch) drives the load; receiver B (350 m, pulse) feeds A's tapper input. Send
  300 m to switch on, 350 m to switch off.

**The pocket key** is true remote activation with no wiring.
- **Sending.** When the selected hotbar slot holds SPARK_TRANSMITTER and the targeted cell has no R action of its own
  (§4.9; a keg or a charge has none), the R key sends on the **pocket wavelength** from the player's position.
- **The pocket wavelength** belongs to the session (main, not saved). It is the wavelength of the last transmitter you
  configured, sent from or targeted, default 300 m. Selecting the slot toasts `Pocket key · 400 m · R key: send`.
- **From commands.** `radio <channel>` sends from the player, or from the rune's cell in a script.

**Ignitions.** The ignition hooks (`igniteKeg`, `activateCharge`) return `{ ok, message, quiet? }`. A refusal (explosions off,
black holes off) does nothing more, except one chat line per cause per 4 s: `the igniter at (…) has nothing to light:
explosions are off`. A `quiet` refusal (already burning or arming) says nothing.

### 4.7 Simulation (normative)
**The tick.** One `CIRCUIT_TICK_S` = **0.05 s** tick. `Circuits.step(dt)` accumulates time and runs **at most 2 ticks** per
call; any leftover beyond 1 tick is dropped. *As in block physics, a slow frame plays slower rather than catching up. 50 ms
is close to a real relay's operate time.*
- Nothing runs while the per-world `circuits` switch is off.
- Main calls `step` while PLAYING, and in survival's PACK state and in `STATE.DEVICE` **in Survival**, which also step the
  world (§4.10). So the console, the picker, the device panel in Creative and pause freeze circuits.

**Each tick, in order:**
1. **Clocks.** Advance every running clock by one tick (loaded cells only): button presses, relay hand-pushes, timer
   countdowns and pulses, blaster pulses and resets, receiver pulses, igniter refire timers. A clock crossing its deadline
   changes its part's state now and marks the cell **dirty**. Contact changes scheduled for this tick (relay delay, radio
   arrival) apply here too, and mark dirty.
2. **Fuses.** Advance the burning cells (§4.3). Finishing produces deferred writes and ignitions.
3. **The flame queue.** Drain it (§4.3), adding deferred ignitions.
4. **Selenium**, every 20th tick.
5. **Networks.** Rebuild every network touched by a dirty cell, within the budget.
   - A dirty conductor rebuilds its network.
   - A dirty source or load rebuilds the networks of its neighbouring conductors, and is evaluated again itself.
   - Then every load attached to a rebuilt network, plus every dirty load, is evaluated.
   - Its new state is compared with the old one, and **edges act** (unless the network is settling, below):
     - a relay coil change schedules the contact flip at tick + 1;
     - an igniter's rising edge queues its ignitions;
     - a transmitter's rising edge schedules receivers at tick + 1;
     - a timer start begins its countdown; a tapper's rising edge taps its coherer;
     - a bell turning on or off sets its ringing flag;
     - a lamp brightness change updates its overlay.
6. **Deferred effects.** Apply the deferred writes (fuse cells → AIR, lazy, through `hooks.setBlock`, at most
   `MAX_CIRCUIT_WRITES_PER_TICK` 32) and ignitions (at most `MAX_IGNITIONS_PER_TICK` 32; the rest wait).
7. **Drain.** Each **active network** has its `I_net` cached at step 5, so drain needs no rebuild. `I_net × CIRCUIT_TICK_S`
   is taken from its paying batteries in loaded chunks (§4.4). A battery whose rounded voltage changes, or that crosses 0,
   is marked dirty. The store's `c` is updated in place, and `store.version` bumps only when a battery crosses a whole
   percent.
8. **Unload check**, every 20th tick. Any network or scheduled clock with a cell in an unloaded chunk is **frozen** (below).

**Settling: loading never fires anything.** Cells dirtied by `loadFromEdits`, `onChunkLoaded` or `setEnabled(true)`, and every
network whose BFS meets an unloaded cell (`partial`), are solved with **`settling = true`**:
- selenium is evaluated at once;
- a relay's (or coherer's tapper's) contacts take the coil's settled state **at once**, with no `RELAY_DELAY`; the contact
  networks this changes are solved in the same settling pass, at most `MAX_SETTLE_PASSES` 4 passes or until no contact
  changes;
- **edge actions are not taken** (igniter fire, transmitter send, timer start, tap, bell sound): each load's previous state
  is simply set to its current one. A powered igniter starts its refire clock from 0.
- **Frozen networks.** A network that gains a cell in an unloaded chunk keeps its last solved voltages and load states, takes
  no edges and drains nothing until all its chunks are loaded again; then it is solved settling.

*Relay energisation and daylight are not saved. Without settling, a dead-man circuit (an energised NC relay holding an
igniter off) or a dusk circuit would fire its igniter just from reloading the world or walking to the edge of its chunk.*

**No loops inside a tick.** Solving a network only reads the index and writes voltages; every state change happens at a tick
boundary. So:
- a relay wired to its own coil buzzes, toggling every tick: 10 Hz, like a trembler;
- a timer feeding itself is a clock with a period of at least 0.5 s;
- nothing can recurse.

**Budgets.**

| Limit | Value | Beyond it |
|---|---|---|
| `MAX_CIRCUIT_VISITS_PER_TICK` | 6000 cell visits, checked **between** networks (a network once started is finished) | The remaining dirty cells wait, FIFO, for the next tick |
| `CIRCUIT_TICK_BUDGET_MS` | 2 ms per tick, measured with `hooks.now()` and checked between networks (*the BlockPhysics `ctx.deadline` pattern*) | The same |
| `MAX_NETWORK_CELLS` | 8192 per network | Truncated: the rest read 0 V. Chat once per network: `This circuit is larger than 8192 cells; split it with relays.` |
| `MAX_CONTACT_CHANGES_PER_TICK` | 1024 | Changes slip to the next tick |

**The solver**, one network at a time (Dial's algorithm):
1. BFS over the conductor graph (§4.5) from the dirty cell. **Neighbour lookups go through the `cells` index**, not world
   peeks: a neighbour not in the index is not a part. A neighbour in an unloaded chunk (`hooks.isLoaded`, cached per BFS)
   ends that branch and marks the network `partial`. Collect the nodes and assign `netId`; union-find over the
   wire–wire and wire–board edges gives each node a `seg` (§4.5 diagnostics).
2. For each node and face, find the attached sources (active ones only) and loads (earthed ones).
3. `I_net` = Σ amps of the attached loads; `w = ⌈I_net⌉` units per wire cell.
4. Voltages are whole `VOLT_UNIT`s. A **bucket queue** runs from the highest source voltage down:
   - seed each node next to a source with **`units − (isWire(node) ? w : 0)`**, so every wire cell, the first one included,
     drops `w`;
   - pop the highest node; each graph neighbour m gets `v − (isWire(m) ? w : 0)` if that is higher than its current value
     (never below 0);
   - a 0-cost neighbour is pushed into the same bucket.

   This is O(nodes + edges + buckets). Values are stored in an `Int16Array` per network.
5. Record `{ id, nodes, units, sources, loads, batteries, amps, partial, truncated }`.

`voltageAt(q, y, r)` reads the node's units × `VOLT_UNIT`, or 0. A load reads the highest value among the nodes it attaches
to.

**Index and lifecycle.**
- **The index.** `cells: Map<packCell, id>` holds every part cell, keg cell and flame cell, with
  `byChunk: Map<chunkKey, Set<packCell>>` beside it. It is built by `loadFromEdits`, which walks `world.edits` once and keeps
  ids for which `partOf(id)` or `isFlame(id)` holds.
- **`onBlockChange(q, y, r, prev, next)`** is bookkeeping only. It:
  - updates the index, and removes the cell from `spent`;
  - creates or drops the store entry: a pristine entry is free; a `prev` part leaving deletes its entry;
  - marks the cell and its 8 neighbours dirty;
  - **marks dirty every indexed earth-needing part or earth-wire cell in the 9 cells above it** (`(q, y+1..y+9, r)`): their
    earth walk may have changed, and an earth wire's change dirties its whole earth net;
  - queues flame candidates.

  *It runs inside `World.setBlock`; doing work there would recurse into writes.*
- **`onChunkLoaded(cq, cr)`** marks every indexed cell of that chunk dirty for settling, re-queues its flame candidates and
  resumes its clocks.
- **`stats().ms`** is measured with `hooks.now`. *A pure module never reads a clock itself.*

### 4.8 State: `CircuitStore` (`src/circuitStore.js`, pure; package B)
A world-level side table, modelled on `RuneStore`: it survives chunk unloads and its entries are created on demand. **Only
non-default fields are saved.** A pristine entry is never written and does not count toward the cap. The saved kind `k` is
always the part's `PartDef.key`, and the fields it may hold are its `PartDef.fields`.

| Kind (`k`) | Fields and defaults | Saved when |
|---|---|---|
| `switch` | `on` false | on |
| `button` | `nc` false | nc, or a label |
| `timer` | `s` 5, `m` 'pulse', `f` 3, `run` false (repeat running), `on` false (hold latched) | any non-default |
| `relay` | `nc` false, `f` 3 | any non-default |
| `tx` | `ch` 1 | ch ≠ 1 |
| `rx` | `ch` 1, `m` 'pulse' or 'latch', `f` 3, `on` false (latched closed) | any non-default |
| `battery` | `c` = BATTERY_CAPACITY | c < capacity |
| every device kind (also `terminal`, `blaster`, `selenium`, `igniter`, `lamp`, `bell`, `charge`) | `l` label '' (≤ `MAX_PART_LABEL_CHARS` 24) | label set |

- **The input face.** `f` is set at placement: the side face pointing back toward the player, the face of `FACE_NORMALS[0..5]`
  with the largest dot product with `(sin yaw, 0, cos yaw)` (`inputFaceFromYaw(yaw)` in circuitParts). The device panel can
  rotate it through 0–6.
- **Defaults without an entry.** Parts written by `setblock`/`fill` have no entry until changed: `f` 3, `s` 5, etc. *So `fill`
  needs no special case, unlike rune blocks.*
- **Caps.** At most `MAX_CIRCUIT_PARTS` 4096 non-pristine entries. `set` past the cap returns null; the hint and panel then
  say `too many configured devices in this world`, and the device works with defaults.
- **Not saved:** burning fuses and `spent`, button presses and hand-pushes, receiver pulses, running `pulse`/`hold`
  countdowns, blaster pulses, relay energisation, lamp brightness and radio in flight. All of these are rebuilt (settling,
  §4.7) or idle after a reload. *As with keg fuses.*
- **Removal.** When a part's cell changes to anything else (broken, blasted, swallowed, crumbled, replaced), its entry is
  deleted. **Undo** of a blast restores the block with **default settings**. *Tombstones would also resurrect settings for a
  player who broke and re-placed a timer on purpose; not worth it.*
- **Saving.** See §6.4. Keys are canonical `"q,y,r"`. Validation drops entries whose cell in the repaired `edits` is not that
  kind's block (orphans), mapping `k` to its block id through `PARTS`.

API: §6.2.2.

### 4.9 Controls, hints and the two R keys
**Right mouse button** (`placeSelected`):
- On a **control** (`isControl`: Knife Switch, Push Button, Clockwork Timer, Spark Transmitter, Blasting Machine), **without
  Shift**, the **press** operates the control: `circuits.interact(q, y, r, 'use')`, and nothing is placed.
- **The control latch.** That press sets main's `rightOnControl`. While it is set, the hold-repeat path does nothing (and
  survival's `UseState` is not stepped) until the button is released; the only thing a hold does is keep a Push Button
  pressed (`circuits.hold`, §4.6) while the crosshair stays on it. The hold-repeat path also **never places against an
  `isControl` target without Shift**. *Without the latch, holding right-click on a switch for 0.2 s (`PLACE_REPEAT_S`) would
  toggle it and then start placing blocks on it: the user's complaint again.*
- **Shift+right-click** places against a control as usual.
- Everything else places, as today.
- *This is what the user expected right-click to do. Controls are the only blocks where a "use" beats "place", so a builder
  extending a wire or a fuse never fights it.*

**The R key** (`interactTarget`), in order:
1. `circuits.interact(q, y, r, 'r')` returns a result for any part with an R action of its own:
   - controls: as right-click (a held R key also keeps a Push Button pressed);
   - Relay: push the armature by hand (held, or 0.5 s);
   - Coherer: tap;
   - Powder Fuse: light it.
2. A Rune Block: as today.
3. The pocket key (§4.6), when the selected slot holds SPARK_TRANSMITTER: sends, **whatever is targeted otherwise**,
   including a keg or a charge. *Sending at the very keg you want to set off is the main use of a remote.*
4. A keg or a charge: the explanation line (§3.3), at most once per 4 s.

**The Shift+R key** (`editTarget`):
- on any part: the **device panel** (§4.10). For wires, fuses and the linstock it shows only "About";
- on a Rune Block: the rune editor, as today.

**Survival** (for survival's integrator; survival §9.4–§9.5 and §14.2):
- **`interactKind`.** `circuits.interact(…, 'r')` on the **targeted** cell (parts with their own R action) joins the hit-based
  steps, after the workplace step (7) and before the water steps. *Target-first, like every other survival R step.*
  - The selected-item steps follow in order: the Handbook (survival §14.2), then the pocket key (§4.6).
  - The last step, "today's barrel and rune behaviour", becomes "rune, then the keg or charge explanation" (kegs no longer
    light on the R key).
- **`survivalRight`** checks `isControl` (and no Shift) on the press before "use the item in hand", including the Handbook's
  read-on-RMB, and honours `rightOnControl`: a press on a control never starts a `UseState` hold or a place repeat.
- **`survivalLeft`**: a left press on a keg burning in place snuffs it (§3.2) instead of digging.

**Crosshair hints** (`circuits.hintFor(q, y, r)`):
- A device's label, when set, is prefixed: `Front door · Push Button · …`.
- The `· not earthed` suffix (with its reason) replaces the reading on any source or load without earth.
- A §4.5 diagnostic replaces the reading when it applies.
- **Volts in hints** are rounded to two decimals and trailing zeros dropped (`5.44 V`, `2.25 V`, `6 V`). `volts` prints the
  exact value (`5.4375 V`). Every voltage is a whole number of `VOLT_UNIT`s.

| Part | Hint |
|---|---|
| Wire (any signal kind) | `Copper Wire · 4.75 V` / `· 0 V` (no source reaches it) |
| Earth Wire | `Earth Wire · grounded` / `Earth Wire · not grounded: run it down to soil or stone` |
| Terminal Board | `Terminal Board · joins every wire colour · 4.75 V` |
| Battery | `Voltaic Battery · 6 V · 87 %` / `· 5.25 V · 12 % (tired)` / `· flat` / `· pile of 2 · 12 V · 87 %` |
| Blasting Machine | `Blasting Machine · right-click: push the plunger (24 V for 1 s)` / `· handle rising…` |
| Selenium Panel | `Selenium Panel · 2.25 V in daylight` / `· dark` / `· shaded: it needs open sky` |
| Knife Switch | `Knife Switch · open · right-click: close it` / `· closed · right-click: open it` |
| Push Button | `Push Button · hold right-click to press` / `Push Button (NC) · hold right-click to open` |
| Clockwork Timer | `Clockwork Timer · 10 s pulse · right-click: wind and start · Shift+R key: set` / `· 7.2 s left · right-click: stop` / `· holding · right-click: reset` |
| Relay | `Relay · coil 4.5 V · contacts closed (NO) · R key: push armature · Shift+R key: settings` |
| Igniter | `Igniter · 5 V · hot!` / `· 2.25 V (fires at 3 V)` |
| Filament Lamp | `Filament Lamp · 5.25 V · lit` / `· 1 V (needs 1.5 V)` |
| Electric Bell | `Electric Bell · ringing` / `· 0 V` |
| Spark Transmitter | `Spark Transmitter · 400 m · right-click: send · Shift+R key: wavelength` |
| Coherer Receiver | `Coherer Receiver · 400 m · pulse · R key: tap · Shift+R key: settings` |
| Powder Fuse | `Powder Fuse · R key: light it here` / `· burning · left-click: cut it` |
| Linstock | `Linstock · smouldering: lights fuses, kegs and charges beside it` |
| Collapsar Charge | `Collapsar Charge · dormant · set it off from afar: fuse, igniter or radio` / `· collapsing!` |
| Black Hole | `Black Hole · walk straight away · left-click: break its core` |

**`CONTROLS_SHEET`** keeps its 17 rows (tested); these rows are reworded (survival's merged texts are in §7.1):
- RMB: `Place block · right-click works switches, buttons, timers, plungers (Shift: place)`;
- R: `R key: use a switch, timer, fuse, radio key or rune`;
- Shift R: `Shift+R key: settings of the targeted device or Rune Block`.

### 4.10 The device panel (`src/devicePanel.js`, DOM; package D)
- **Opening.** The Shift+R key on a part opens `#device-panel`, at z 24: the rune editor's layer; the two are never open
  together. Main uses a new state `STATE.DEVICE`: controls are disabled and the pointer unlocked, and the modal state is set
  **before** `controls.unlock()` (pitfall 24).
  - **In Creative** the simulation freezes, as in the rune editor.
  - **In Survival** the world keeps stepping, as in survival's PACK state (controls disabled, the player stands still).
    *Otherwise the panel would be a pause button in Survival.*
- **Look.** The survival palette: dark #1c1a24, honey #e8b04a, ember #d0582a, text #f3ead8. Every button and segmented control
  is survival's **`.hex-button`** (and its chip style, if survival defines one); the panel's own class `.cc-panel` is used only
  for the container. **Never `.mc-button` or `.picker-panel`** (tested). *One button family across the device panel, the pack
  screen and the Guide.*
- **Contents**, top to bottom:
  1. **Header**: the part's icon (48 px), name, coordinates, and a **label** field (≤ 24 characters).
  2. **Live readout**: volts on the live face(s), current on its network, earthed yes/no (with the reason), the §4.5
     diagnostic if any, and state (open/closed, energised, ringing, charge % and volts).
  3. **Settings** by kind:
     - **Timer**:
       - a delay number input (0.5–3600, step 0.5) and preset hex chips `5 · 10 · 15 · 30 s · 1 · 5 min`, like a
         time-switch dial;
       - a mode segmented control `Pulse | Hold | Repeat`;
       - an **input face** picker: a small SVG hex of 6 side wedges plus a "top" dot, with the current face in honey;
       - Start/Stop.
     - **Relay**: `NO | NC` and the input face picker.
     - **Push Button**: `NO | NC`.
     - **Transmitter**: a wavelength dial of 16 small hex buttons in two rows of 8, labelled `300`…`1050` m, the 600 m one
       marked `distress`; and `Send`.
     - **Receiver**: the wavelength dial, `Pulse | Latch`, the input face picker (the tapper), and `Tap`.
     - **Switch**: `Open | Closed`.
     - **Battery**: a charge bar with volts, and `Refill`. Refill is Creative only; in Survival it is hidden.
     - **Others**: label only.
  4. **"About"**: the part's real-world origin and tip (§4.13), in honey italic.
  5. **Done** (Esc, Enter in a field, or the Shift+R key).
- **Data flow.** Every change goes straight to main through `onChange(key, partial)`, which calls
  `circuits.applySettings(...)`, as the rune editor does. Buttons send `onAction(key, action)`.
- **Stale views.** `refresh(view)` keeps the panel in step. If the cell stops being that part while the panel is open (a
  blast, a vortex, a `setblock`), main closes it.
- **API**: §6.2.15.

### 4.11 Visuals (`src/circuitGeometry.js` pure, `src/circuitRenderer.js` three; package C)
**Static geometry** (wires, fuses, knobs and binding posts) is rebuilt only when `circuits.geometryVersion` changes or the
player moves 16 units.
- `circuitGeometry.wireSegments(view, x, y, z, range, out)` → `Float32Array` segment records
  `[x0, y0, z0, x1, y1, z1, width, colour]` plus **knob** records `[x, y, z, kind]` for every wire and fuse cell within
  `CIRCUIT_DRAW_RANGE` 64. **Signal wires are drawn as knob-and-tube wiring** (real practice, 1880–1930):
  - every copper, brown or white wire cell has a white porcelain **knob** at its centre on the floor: a hex spool 0.14 wide
    and 0.12 tall, #e8e4da, with a #b8b2a6 groove;
  - the wire runs straight from the knob's groove at y + 0.10 to the midpoint of each side face it joins or attaches
    through, at that height (width 0.03);
  - a vertical join is a porcelain **tube** (0.08 square, #e8e4da) from y + 0.10 to y + 1.10, with the wire inside;
  - there is **no terminal dot**: the knob is always there;
  - every relay, timer and coherer has two brass **binding posts** (0.06 hex studs, #b08d3a) on its input face, 0.01 proud.
    *The real terminals of a coil, and no arrow.*
- **The Earth Wire** lies on the floor with no knobs, as a green-and-yellow striped cord (alternating 0.25-unit pieces, width
  0.05), with a small copper ground clamp where its cell passes the earth walk (§4.4).
- **The Powder Fuse** is a round cord, not a strip: 0.08 wide at y + 0.04. Each half-segment is bent by a seeded ±0.06
  sideways kink (`hash3` of the cell), so it reads as cord laid by hand, and a cell with one join ends in a frayed grey tuft.
  The kink is the same on every rebuild.
- `circuitRenderer` draws the segments with **one** `InstancedMesh` of a unit box, scaled per instance, and the knobs, tubes
  and posts with **one** `InstancedMesh` of a hex prism, both `MeshLambertMaterial` with instance colours. *Lit like the
  world; at night wires are dark, as they should be.*
- A burning fuse's burnt part is covered by `char` overlays (below). A burnt cell disappears with its block, through the
  geometry rebuild when its AIR write lands.

**Dynamic overlays** come from `circuits.overlays(x, y, z, range, out)` (pure) once per frame: at most 512 items within 48
units, each `{ type, q, y, r, a, b }`. They are drawn with **9 InstancedMeshes**, so the renderer costs **≤ 11 draw calls in
all**:

| Type | Drawn as |
|---|---|
| `blade` | The knife-switch blade: a 0.5 × 0.06 × 0.08 copper bar hinged at the top's west, at 0° (closed) or 65° (open), easing over 0.12 s |
| `cap` | The push-button cap, 0.05 lower while pressed |
| `hand` | The timer hand, angle = 2π·(left / s); the hand is honey when holding |
| `arm` | The relay armature, tilted 12° when energised (or pushed by hand), with an `NC` flag on top |
| `plunger` | A rack bar and a T-handle, from the top +0.6 when cocked down to +0.1 |
| `hammer` | The bell's trembler beside the gong: a black electromagnet pair and a brass striker arm, jittering ±10° at 15 Hz while ringing |
| `bulb` | The lamp's clear pear-shaped glass on its socket: two stacked hex prisms, alpha 0.35, with a hairpin carbon filament and the tip pip |
| `glow` | Additive camera-facing quads with a per-instance colour and size:<br>• lamp filament: #ffd27a, size 0.2 + 0.4·b, alpha b, inside the bulb;<br>• igniter: #ff4a1a, 0.35;<br>• linstock ember: #ff7a2a, 0.10, a dim flicker, beside the fork;<br>• transmitter spark: #cfe4ff, 0.6, for 0.15 s;<br>• receiver tube: #9fd0ff, 0.25, for 0.3 s;<br>• dormant charge: the pinprick, #f4f1ea, 0.12, an irregular seeded twinkle;<br>• fuse spark: #ffcf6a, 0.22, at the burn front, plus 1 `sparks` particle per tick for the nearest 16 burning cells;<br>• a keg burning in place: `fuse` at the bung (`hooks.kegBurning`) |
| `staff` | Thin boxes: the linstock (a 0.95-tall shaft leaning 12° in a seeded direction, an iron spike foot, the forked serpent head #3a3d42, a coil of grey match #8a8478 on the shaft), the lamp's filament, and `char`: ash-grey #5a5650 boxes 0.12 wide, 0.005 above a burning fuse, covering its burnt fraction |

- Every InstancedMesh sets `frustumCulled = false` (*their bounds are computed once and go stale*).
- `prewarm(webgl, camera)` compiles everything at load. The renderer **never** adds a light: lamps do not light their
  surroundings in v1 (no block-light engine; §10).

### 4.12 Sounds (recipes in `circuitSounds.js`, §6.2.11)
| Name | Recipe | When |
|---|---|---|
| `switchClack` | 15 ms noise through a 2.5 kHz bandpass + a 0.05 s sine at 180 Hz | knife switch |
| `buttonClick` | 10 ms click, 3 kHz | button down and up |
| `relayClick` | 6 ms click, 4 kHz, gain 0.2 | each relay change (throttled to 0.05 s, nearest) |
| `timerWind` | 6 ratchet clicks over 0.3 s | start |
| `timerTick` | a 2 ms click every 0.5 s while running | nearest running timer within 12 units |
| `timerDing` | sines at 1320 Hz and 1980 Hz, 0.6 s decay | the countdown ends |
| `bellRing` | sines at 950 Hz, 1430 Hz and 2600 Hz, 0.25 s decay, struck every 0.12 s | ringing |
| `sparkZap` | 40 ms of white noise through a 6 kHz high-pass + a 30 ms 120 Hz buzz | send |
| `plunger` | a falling sawtooth 400 → 80 Hz over 0.3 s through a lowpass (the magneto spin), then a thunk | plunge |
| `igniterPop` | a 20 ms crackle | first firing |
| `fuseLight` | a short hiss | a fuse lit in place |

Volumes fall off over `PHYSICS_SOUND_RANGE` 24, and every sound is throttled per name.

### 4.13 Teaching
Each part has a `tip`. It appears:
- under the name in the picker;
- as the device panel's "About";
- **once per session** in chat the first time that part is placed, prefixed `Tip —`.

**The Guide.** Survival §14 adds a **Guide** (a tutorial reader on the title and pause menus, in both modes) whose tables are
generated from game data. Once it lands, package H or the integrator adds one chapter, **"Powder and circuits"**, generated
from `PARTS` (name, `origin`, tip), the §4.14 worked examples, the reach table of §4.4, and the black-hole sequence of §2.3,
with one line on the look: *"The dark shadow is 2.6 times wider than the hole itself: light bends around it."*
*`handbook.js` is H's file, so this is a follow-up, not one of our packages; the data is ready in `circuitParts.js`.*

The tips are normative text; each is one or two sentences, at most 240 characters (tested):

| Part | Tip |
|---|---|
| Copper Wire | Current flowing through a wire loses a little voltage in every cell (V = I × R). More lamps on one wire draw more current, and they all get dimmer. With nothing switched on, the whole wire sits at the battery's voltage. |
| Brown / White Wire | Brown means live and green-and-yellow means earth: today's wiring colours. Insulation lets two circuits run side by side; join them on a Terminal Board. |
| Earth Wire | Green and yellow means earth. Devices on wooden floors need a path to the ground: run this down to natural soil or stone. |
| Terminal Board | A board of brass binding posts: every wire screwed to it is joined, whatever its insulation. |
| Voltaic Battery | Volta's pile (1800): each copper–tin pair gives about half a volt; twelve make six. Stack batteries to add volts (series); wire them side by side to last longer (parallel). It tires, then runs down. |
| Blasting Machine | Push the plunger: a hand-spun magneto makes a short 24 V pulse, enough to fire an igniter far away. Quarries and mines used these. |
| Selenium Panel | Fritts' selenium panel (1883): six cells under see-through gold leaf, about half a volt each, make up to 3 V in open sun and none at night. Too weak for a lamp, enough for a relay. |
| Knife Switch | The classic laboratory switch: a copper blade bridges the gap. On a hex, cells on neighbouring faces touch each other, so run the wires out of opposite faces. |
| Push Button | A momentary switch: closed only while you hold it down. An NC button is the opposite: it opens while held, which makes a stop button. |
| Clockwork Timer | A wound spring runs the clock; when it runs down, its contacts close. Pulse closes for a second, Hold stays closed, Repeat makes a clock. |
| Relay | Joseph Henry's relay (1835): a weak current in the coil pulls an iron arm that closes a second circuit with its own battery. Keep that battery away from the input face. NC contacts open when the coil pulls. |
| Igniter | A thin wire glows red-hot when current flows (at least 3 V) and lights the powder beside it. It draws a lot of current, so keep its wire short. |
| Filament Lamp | A carbon filament glows when current heats it (Swan and Edison, 1879). A dim lamp means a long wire, a shared wire or a tired battery. |
| Electric Bell | Its magnet pulls the hammer, which breaks the circuit, springs back and closes it again: a relay that interrupts itself. |
| Spark Transmitter | A spark jumping a gap sends a radio wave (Marconi, 1895). Tune it to a wavelength; a receiver on the same wavelength hears it. 600 m was the distress wavelength. |
| Coherer Receiver | Iron filings in a glass tube cling together when a radio wave arrives and let current through. A second wave cannot open it; only a tap can. |
| Powder Fuse | Safety fuse: a thread of black powder sealed in tarred twine (Bickford, 1831). It burns at a steady speed, about 1 cm a second in real life, even under water, and is used up. Ours burns 2.5 cells a second. |
| Linstock | A gunner's staff holding smouldering slow match: cord soaked in saltpetre. Fuses, kegs and charges set beside it catch at once. |
| Powder Keg | Black powder is 75 % saltpetre, 15 % charcoal and 10 % sulfur. When the flame reaches the powder, it goes off at once. Kegs were hooped with copper or wood, never iron, so a knock could not strike a spark. |
| Collapsar Charge | In the 1960s, before John Wheeler's name "black hole" caught on (1967), astronomers spoke of collapsars. A fuse, an igniter or a radio pulse sets this one off; then walk straight away. |

*No glowing wire, power numbers 0–15 or comparator-style UI: the readout is volts, and the voltage is something you measure,
as in a real workshop.*

### 4.14 Worked examples (these become integration tests, §7 I-2)
Every layout is at one height, on soil or stone, with open sky, unless it says otherwise. Cells are axial `(q, r)`; "on its
W face" means the neighbouring cell in that direction. Cells not listed are AIR. Volts assume full batteries.

1. **Doorbell.**
   ```
   Battery (0,0) · Copper Wire (1,0)…(6,0) · Push Button (7,0) · Copper Wire (8,0)…(10,0) · Electric Bell (11,0)
   ```
   The wire enters the button on its W face and leaves on its E face. Hold right-click on the button: the bell gets
   `6 − 9 × 0.0625 = 5.44 V` (1 A, so one unit per cell) and **rings for as long as you hold it**, plus 0.1 s. Released, the
   battery's side reads 6 V all along (no current, no drop) and the bell's side 0 V.
2. **Timed charge.**
   ```
   Battery (0,0) · Clockwork Timer (1,0), input face SE (unused) · Copper Wire (2,0)…(5,0) · Igniter (6,0) · Collapsar Charge (7,0)
   ```
   The battery touches the timer's W face, the wire its E face. Set 30 s pulse and right-click the timer: after 30 s the
   igniter gets `6 − 4 × 0.125 = 5.5 V` (2 A) and fires. The charge arms, flashes, implodes and forms a vortex 1.9 s later.
3. **Too far.**
   ```
   Battery (0,0) · Copper Wire (1,0)…(30,0) · Igniter (31,0) · Powder Keg (32,0)
   ```
   The igniter gets `6 − 30 × 0.125 = 2.25 V` and does not fire. Its hint reads `Igniter · 2.25 V (fires at 3 V)`.
   - **Fix 1, a pile.** Stand a second Voltaic Battery on top of the first (`(0,0)` at y + 1) and put one Copper Wire cell on
     top of (1,0), so the run touches the upper battery: the pile gives 12 V, and the igniter gets
     `12 − 31 × 0.125 = 8.13 V`. (The lower battery still touches the run, but the solver keeps the higher voltage.)
   - **Fix 2, a relay** (the telegraph way). Replace wire (21,0) with a Relay, input face W, NO; remove wire (22,0)…(30,0)
     and the igniter; put a fresh Battery at (21,1) on the relay's **SE** face; lay Copper Wire (22,−1)…(31,−1) out of its
     **NE** face to an Igniter at (32,−1) with the keg at (33,−1). The coil gets `6 − 20 × 0.0625 = 4.75 V` (0.5 A) and pulls
     in; the igniter gets `6 − 10 × 0.125 = 4.75 V` and fires. *SE and NE are the only pair of the relay's faces that touch
     neither each other nor the input face's wire.*
4. **Quarry.**
   ```
   Blasting Machine (0,0) · Copper Wire (1,0)…(120,0) · Igniter (121,0), all on rock
   Powder Kegs on the igniter's E (122,0), SE (121,1), SW (120,1), NW (121,−1), NE (122,−1) and on top (121,0) at y + 1
   ```
   The igniter's bottom is the earth it needs and its W face carries the wire, so 6 kegs is the most that can touch it.
   Plunging gives `24 − 120 × 0.125 = 9 V`: the 6 kegs burn in place for 0.25 s and go off as **one blast** of radius
   `3.5·∛6 ≈ 6.4`. Kegs further away are caught by it and follow 0.3–0.8 s later in the same undo event.
5. **Radio.**
   ```
   Battery (0,0) · Coherer Receiver (1,0), 400 m, pulse, tapper input face NW (unused) · Copper Wire (2,0) (3,0) · Igniter (4,0) · Powder Keg (5,0)
   ```
   From 100 cells away, select a Spark Transmitter set to 400 m and press the R key (even while looking at the keg): the
   receiver closes one tick later, the igniter gets `6 − 2 × 0.125 = 5.75 V`, and the keg goes off 0.25 s after that.
6. **Fuse and linstock.**
   ```
   Powder Keg (0,0) · Powder Fuse (1,0)…(20,0) · then place a Linstock at (21,0)
   ```
   The fuse burns for 8 s (20 × 0.4); the keg lights and goes off at about 8.25 s; the fuse cells are gone.
7. **Dusk lamp.**
   ```
   Selenium Panel (0,0) · Copper Wire (1,0) · Relay (2,0), input face W, NC · Voltaic Battery (3,0) on the relay's E face ·
   Filament Lamp (2,1) on the relay's SE face · the relay's SW (1,1) and NW (2,−1) stay empty
   ```
   The battery and the lamp touch each other but, as devices, do not join (§4.5); both attach to the relay's contacts. By
   day the coil gets `3 − 0.0625 = 2.94 V`, so the NC contacts are open and the lamp is off. When daylight drops below about
   0.57 the coil releases and the lamp lights at 6 V.
8. **Wooden house.**
   ```
   On oak planks: Battery (0,0) · Copper Wire (1,0) · Filament Lamp (2,0)
   ```
   Both show `not earthed: wood does not conduct — run an Earth Wire down to the ground`. Lay Earth Wire at (0,1) (the
   battery's SE face) and (1,1) (the lamp's SW face), take up the plank under (0,1) and put Earth Wire there, on the dirt:
   the earth net is grounded, both are earthed, and the lamp lights at `6 − 0.0625 = 5.94 V`.
9. **Three lamps on one wire** (Ohm's law).
   ```
   Battery (0,0) · Copper Wire (1,0)…(30,0) · Filament Lamps at (31,0), (30,1) and (31,−1)
   ```
   Three lamps draw 3 A: `6 − 30 × 0.1875 = 0.38 V`, all dark. Break one: `6 − 30 × 0.125 = 2.25 V`, two dim lamps. Break
   another: `6 − 30 × 0.0625 = 4.13 V`, one lamp lit. *The fix is a shorter wire, a pile, or a wire of its own for each lamp.*
10. **Two-key firing** (switches in series = AND).
    ```
    Battery (0,0) · Knife Switch A (1,0) · Copper Wire (2,0) (3,0) · Knife Switch B (4,0) · Copper Wire (5,0) (6,0) · Igniter (7,0) · Powder Keg (8,0)
    ```
    The igniter fires (`6 − 4 × 0.125 = 5.5 V`) only when both switches are closed: the real two-person rule in blasting.
11. **Two doorbell buttons** (buttons in parallel = OR).
    ```
    Battery (0,0) · Copper Wire (1,0) (2,0) (2,1) (2,2) · Push Button A (3,0) · Push Button B (3,2) ·
    Copper Wire (4,0) (4,1) (4,2) · Electric Bell (5,1) · (3,1) stays empty
    ```
    Either button rings the bell (`6 − 4 × 0.0625 = 5.75 V` through A).
12. **Start/stop latch** (circuit memory with a relay).
    ```
    Relay R (0,0), input face W, NO · Brown Wire (−1,0) (−1,1) (−1,2) · Filament Lamp (−2,1) ·
    Copper Wire (1,0) (1,1) (1,2) · Push Button "Start" (0,2) · Push Button "Stop" (2,0), NC · Battery (3,0) ·
    (0,1) stays empty
    ```
    The battery feeds the copper side through Stop. Press Start: the brown side is powered, the coil pulls in, and one tick
    later R's own contacts (E to SW) join the two sides, so the lamp stays lit (`6 − 2 × 0.125 = 5.75 V`; the coil reads
    5.63 V) after Start is released. Press Stop: the coil drops and the latch opens. *A relay holding itself in was how lifts
    and motors were started, long before chips.*

=====================================================================================================================
## 5. The creative inventory (block picker)

### 5.1 What it is
- **Opening.** E opens it, as today.
- **Layout.** A honeycomb of pointy-top hex cells, in **sections** with a **section rail**. Large sets of near-identical
  blocks are **families**: one tile each, which opens a **drawer band** below its row.
- **Scrolling.** The body scrolls by mouse wheel, scrollbar, dragging on empty space and keyboard.
- **Search.** A search box filters everything, aliases included.
- **Placing in the hotbar.** By click, by digit, or by dragging a block onto a hotbar slot.
- **Look.** The survival palette. *Survival §11 left the restyle of the inherited light-grey picker to the user. The user
  has now asked for this inventory to be redesigned, and the brief asks for it to look like the survival pack screen.
  Only the picker changes; the title screen keeps its look, and the pause menu only gains survival-style switches (§6.2.17).*

### 5.2 Sections and families (`PICKER_SECTIONS` in `src/pickerModel.js`)
The tables name blocks by **`name` string** and resolve them through `BLOCKS`; unknown names are skipped. *So the model works
with or without survival's blocks, in either merge order.* Any placeable block that no section names goes to a final
**"Other"** section, which is hidden when empty. *A new block can therefore never vanish from the picker.*

| Section (rail icon) | Families (members) · singles, in order |
|---|---|
| **Stone** (stone) | *Stone & Cobble* (stone, cobblestone, mossy_cobblestone, stone_bricks, mossy_stone_bricks) · *Rock* (granite, diorite, andesite, slate, sandstone) · bricks · obsidian |
| **Earth** (grass_block) | *Soil* (dirt, grass_block, snowy_grass, clay) · *Sand & Gravel* (sand, red_sand, gravel) · *Snow & Ice* (snow_block, ice, packed_ice) · *Wild Plants* (tussock, cattails, tuber_plant, honeyberry_bush, prickly_pear) · hay_bale · pumpkin |
| **Wood** (oak_log) | *Logs* (oak_log, spruce_log, birch_log) · *Planks* (oak_planks, spruce_planks, birch_planks) · *Leaves* (oak_leaves, spruce_leaves, birch_leaves) · bookshelf |
| **Ores & Metals** (iron_ore) | *Ores* (coal_ore, iron_ore, gold_ore, diamond_ore, copper_ore, tin_ore) · *Metal & Coal Blocks* (coal_block, iron_block, gold_block, diamond_block, copper_block) · honeycomb_block |
| **Colour** (wool_red) | *Wool* (the 16, in today's light-to-dark order) |
| **Glass & Light** (glass) | glass · glowstone |
| **Camp & Crafts** (campfire) | campfire · *Workplaces* (work_stump, kiln, bloomery, forge) · wicker_basket · sleeping_hide |
| **Black Powder** (powder_keg) | powder_keg · powder_fuse · linstock |
| **Circuits** (voltaic_battery) | **starter parts first:** voltaic_battery · copper_wire · knife_switch · push_button · igniter · filament_lamp · then blasting_machine · electric_bell · relay · clockwork_timer · *Radio* (spark_transmitter, coherer_receiver) · selenium_panel · *Insulated & Earth Wire* (brown_wire, white_wire, earth_wire) · terminal_board |
| **Exotic** (collapsar_charge) | collapsar_charge · rune_block |
| **Liquids** (water) | water |

*A beginner meets the six parts of the first circuit before anything else.*

**Family rules.**
- A family with fewer than 2 resolved members is shown as a single.
- A **family tile** shows three member icons fanned in a stack (composited once at build time), a count badge (`16`) and a
  ▸ chevron. **No +/− glyphs.**
- Hovering it shows `Wool · 16 colours — click to open` in the name line.

**Search aliases** (`PICKER_ALIASES`, by name):

| Block | Aliases |
|---|---|
| linstock | torch, slow match, match |
| powder_keg | barrel, explosive, gunpowder, bomb, keg |
| powder_fuse | safety fuse, fuse, cord |
| collapsar_charge | black hole, singularity, vortex |
| copper_wire | cable, conductor, wire |
| brown_wire, white_wire | insulated, cable, wire |
| terminal_board | junction, junction box, splitter, joiner |
| relay | repeater |
| knife_switch | lever, toggle, ignition switch |
| push_button | button, doorbell |
| clockwork_timer | clock, delay, time switch |
| spark_transmitter | radio, remote, wireless |
| coherer_receiver | radio, remote, wireless |
| blasting_machine | detonator, plunger, exploder, ignition |
| igniter | electric match, detonator |
| voltaic_battery | power, cell, power source, pile |
| selenium_panel | selenium cell, solar, photocell, daylight |
| filament_lamp | light, bulb |

*Typing "torch" finds the Linstock, which answers the user's word without using another game's item name; "ignition
switch", "power source" and "detonator" find the parts the user named.*

### 5.3 Expanding
- **Opening.** Clicking a family tile, or Enter/Space/→ on it, opens its **drawer**: a honey-edged band inserted directly
  below the honeycomb row that holds the tile, laid out with the same columns. **Members never flow inline** after the tile;
  they appear only in the drawer band (tested). *Collapsible groups that expand in place inside a square grid are another
  game's creative inventory (§9).*
- **One drawer at a time.** Opening another closes the first. The family tile shows ▾ and gets `.open`.
- **Closing.** Clicking the tile again, or ← / Backspace from inside the drawer, closes it and returns focus to the tile.
- **Memory.** The open family is remembered for the session, not saved.
- **Show all** (a checkbox in the header) flattens every family into its section, members in place. It is remembered for
  the session.

### 5.4 Layout and scrolling
- **Panel.** `#block-picker` stays at z 20 with the dim backdrop. `.picker-panel` is a flex column:
  - width `min(980px, calc(100vw − 48px))`;
  - `max-height: max(180px, calc(100vh − 8vh − 72px))`, so the 72 px hotbar clearance is unchanged and tested.
- **Head** (fixed): the title "Blocks", `#picker-search`, and the Show all toggle.
- **Body** (`.picker-body`, flex row, `flex: 1 1 auto; min-height: 0`):
  - **`#picker-rail`**: a 40 px column of the 11 section buttons (28 px hexes with icons). A click scrolls the section header
    to the top (`scrollTo({ behavior: 'smooth' })`). The button of the section at the top of the view gets `.current`.
  - **`#picker-scroll`**: `overflow-y: auto; overscroll-behavior: contain`, with a slim honey scrollbar
    (`scrollbar-color: #e8b04a #2a2633`). It holds `#picker-grid`.
- **Foot** (fixed): `#picker-name`, `#picker-blurb` (the tip or family line) and `.picker-hint`.
- **Honeycomb.** Cells are 56 × 64 px pointy-top hexes (`clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)`)
  with a 48 px icon (the existing 64 px canvas scaled down).
  - Rows are 50 px apart (−14 px overlap); every odd row is indented 29 px.
  - Columns: `cols = max(4, floor((scrollWidth − 29) / 58))`, recomputed on open and on `resize`.
- **Section headers** are sticky (`position: sticky; top: 0`): 18 px honey small-caps text with a thin rule, over a row
  background of #1c1a24.
- **Scrolling inputs.**
  - The wheel and the scrollbar are native. *The canvas's wheel listener only exists on the canvas.*
  - **Drag to scroll**: a pointerdown on empty scroll background (not a cell) followed by movement scrolls by −dy, with a
    `grabbing` cursor. A drag of more than 6 px suppresses the click.
  - The keyboard is covered in §5.7.
- **At 1280 × 720** the scroll region is about 470 px tall (9 honeycomb rows), and the whole collapsed picker is about
  950 px. *It scrolls by design, and the rail makes the jump to any section one click.*

### 5.5 Search
- **`#picker-search`.** A `type=search` field with placeholder `Search blocks  ( / )`. `/` focuses it while the picker is open
  and focus is not already in it.
- **Matching** is a case-insensitive substring over:
  - `displayName`;
  - `name`, with `_` read as a space;
  - the family name and the section title;
  - `PICKER_ALIASES`.
- **Results.** A non-empty query replaces the sections with one flat honeycomb of matches, in section order, with families
  flattened. No matches shows `No blocks match "…"`.
- **Keys in the field.**
  - Enter puts the **first match** in the selected slot and closes the picker.
  - Esc with text clears the field; Esc when it is empty closes the picker.
  - **KeyE and the digits type into the field.** `onPickerKeyDown` ignores events whose target is the search input, except
    Esc, Enter, ↓ and Tab. ↓ moves focus to the first result.

### 5.6 Putting blocks in the hotbar
These rules are unchanged:
- **Click** on a block: `onPickBlock(id, null)`, which puts it in the selected slot, clicks and **closes** the picker.
- **1–9** while a block is hovered or focused: `onPickBlock(id, slot)`. The picker stays open.

These are new:
- **Drag.** A pointerdown on a block followed by more than 6 px of movement starts a drag. A 40 px ghost icon follows the
  pointer, and the hotbar slot under the pointer (found with `elementFromPoint`) highlights. Release over `.hotbar-slot`
  calls `onPickBlock(id, slot)` and keeps the picker open; release anywhere else cancels.
  - *Pointer events, not HTML5 drag-and-drop: the latter is unreliable with canvases and clip-paths.*
- **Badges.** A block that is already in the hotbar shows its slot number (a 14 px honey badge, top right). The block in the
  selected slot gets a honey ring. *Today's `.in-hotbar` / `data-slot` hooks finally get CSS.*
- **Recent.** A **Recent** row (the last 9 distinct blocks picked this session, newest first) sits above the first section
  and is hidden when empty.

`menus.js`'s public picker API is **unchanged**: `showPicker(hotbar, selected)`, `hidePicker()`, `isPickerOpen()`, and the
callbacks `onPickBlock(id, slot | null)` and `onPickerClose()`. So main needs no change for the picker.

### 5.7 Keyboard (while the picker is open)
| Key | Action |
|---|---|
| Tab / Shift+Tab | Native order: search → Show all → rail → cells (roving tabindex: one cell is tabbable) |
| ← / → | Previous/next cell in reading order, wrapping across rows. On a family tile, → opens it. Inside a drawer, ← on its first cell closes it |
| ↑ / ↓ | The cell in the row above/below whose centre x is nearest (honeycomb-aware, `navigate` in pickerModel) |
| PageUp / PageDown | ± the number of rows that fit in the scroll region |
| Home / End | First/last cell |
| Enter | A block: put it in the selected slot and close. A family: open or close it |
| Space | A family: open or close it. A block: as Enter |
| 1–9 | Put the focused or hovered block in that slot (stays open) |
| / | Focus search |
| E, Esc | Close (Esc first clears a non-empty search) |

The focused cell scrolls into view (`block: 'nearest'`).

### 5.8 Look
| Element | Style |
|---|---|
| Panel | #1c1a24 with a 3 px honey #e8b04a border, a 2 px black outer ring and 12 px padding |
| Text | #f3ead8 |
| Cells | Fill #2a2633; on hover an inner honey hex (a `::before` at inset 2 px, since an outline cannot follow a clip-path); `.selected` a honey fill ring; focus a 2 px white inner hex |
| Family tiles | Like cells, plus the fan, the badge and ▸ |
| Drawer | Background #241f2e with honey left and right edges |
| Title | Honey, 16 px bold |
| Hint | #b9ad95, 12 px |

*No square grid, no grey bevel, no +/− glyphs and no tabs along the top: the honeycomb, the rail and the drawer bands are
ours (§9).* `?ui=picker` still opens it for screenshots.

### 5.9 DOM (index.html, package D)
```html
<div id="block-picker" class="layer hidden">
  <div class="picker-panel" role="dialog" aria-label="Blocks">
    <div class="picker-head">
      <div class="picker-title">Blocks</div>
      <input id="picker-search" type="search" placeholder="Search blocks  ( / )" autocomplete="off" spellcheck="false">
      <label class="picker-showall"><input id="picker-showall" type="checkbox"> Show all</label>
    </div>
    <div class="picker-body">
      <nav id="picker-rail" aria-label="Sections"></nav>
      <div id="picker-scroll"><div id="picker-grid" role="grid"></div></div>
    </div>
    <div class="picker-foot">
      <div id="picker-name">&nbsp;</div>
      <div id="picker-blurb"></div>
      <div class="picker-hint">Click: selected slot · 1–9: that slot · drag onto the hotbar · ▸ opens a family · / search · E / Esc: close</div>
    </div>
  </div>
</div>
```
menus.js keeps the IDS `blockPicker`, `pickerGrid` and `pickerName`, and adds `pickerSearch`, `pickerShowAll`,
`pickerRail`, `pickerScroll` and `pickerBlurb`, all checked by `bindElements`. The picker DOM code moves out of menus.js into
`src/pickerUI.js`, and menus.js delegates (§6.2.14).

### 5.10 Tests to change or add
- **`wave0.test.js`** (K0):
  - `PICKER_ORDER` now has 86 entries (99 with survival's 80) and equals the sorted placeable ids;
  - BLACK_HOLE is absent and not placeable;
  - RUNE_BLOCK is right before WATER, which is last;
  - POWDER_KEG still follows CAMPFIRE (the old "barrel follows campfire" test);
  - the new blocks' flags;
  - `BLOCK.BLAST_BARREL === BLOCK.POWDER_KEG`;
  - the barrel `name` and `displayName` assertions at L261–262.
- **`styles.test.js`** (D):
  - **remove** the "whole grid shows without scrolling at 622 px" test (L184–192), which is now false by design;
  - keep "the panel ends above the hotbar for heights 274–1440" and "the panel is a flex column";
  - add: `#picker-scroll` has `overflow-y: auto` and `min-height` ≥ 64 px (one row);
  - add: `.picker-body` has `flex: 1 1 auto` and `min-height: 0`;
  - add: the head and foot fit in the 180 px minimum panel with one row;
  - add: z-orders (picker 20, device panel 24);
  - add: `#device-panel`, the picker, `#btn-circuits` and `#btn-blackholes` contain no `.mc-button` (the ids join survival's
    "no `.mc-button`" assertion); every button in `#device-panel` carries `.hex-button`;
  - add: **no player-facing string** (hints from a `hintFor` sample over every part, `CONTROLS_SHEET`, the toasts and chat
    lines of §3.3 and §4.6) contains a bare `[R]` or matches `/(^|[^+\w])R:/`;
  - keep `CONTROLS_SHEET.length === 17`.
- **New `pickerModel.test.js`** (D), pure:
  - every placeable block appears exactly once across sections (families and singles), with and without a fake survival
    `BLOCKS` list;
  - unknown names are skipped; "Other" collects the leftovers; single-member families collapse to singles;
  - the Circuits section starts with the six starter parts, in order;
  - `search`: aliases (`torch` → linstock, `black hole` → collapsar_charge, `barrel` → powder_keg, `ignition switch` →
    knife_switch, `detonator` → blasting_machine and igniter), case, underscores; families flattened;
  - `layout(entries, cols, openFamily, showAll)`: row lengths alternate `cols`/`cols − 1`; the drawer row comes right after
    the family's row; **an open family's members appear only in its `drawerOf` row**; headers come first in each section;
  - `navigate`: ←/→ wrap, ↑/↓ by nearest x across indented rows, Home/End, PageDown by n;
  - the Recent list: dedupe, cap 9, newest first.

=====================================================================================================================
## 6. Architecture

### 6.1 Modules
| File | Kind | Package | Purpose |
|---|---|---|---|
| `src/circuitParts.js` | PURE (new) | K0 | `PARTS`, predicates, connection rules, input face from yaw, wavelengths, tips |
| `src/circuitTiles.js` | PURE painters (new) | K0 placeholders and the moved keg painters → C art | The 35 tile recipes, the keg's two, and their names |
| `src/circuitStore.js` | PURE (new) | B | The side table (§4.8) and its JSON |
| `src/circuits.js` | PURE (new) | B | The engine (§4.3–§4.7) |
| `src/explosions.js` | PURE | B | §3.4 |
| `src/storage.js` | PURE | B | §6.4 |
| `src/commands.js` | PURE | B | §6.5, `BLOCK_ALIASES` in `resolveBlock` |
| `src/blockphysics.js` | PURE | B, **post-merge only** | 3 strings and the two undo hooks (§3.1, §3.6); survival A owns the file |
| `src/blackholes.js` | PURE | A | §2 |
| `src/infall.js` | PURE (new) | A | §2.6–§2.7 |
| `src/vortexMath.js` | PURE (new) | A | `diskPattern`, `beamVector`, `bandSense`, `flowPhase`: the JS mirrors of the vortex shaders |
| `src/vortexRenderer.js` | three (new) | A | §2.4 |
| `src/particles.js` | three | A | `emitOrbit`, kind `infall` |
| `src/fallingRenderer.js` | three | A | `setFlash` colour |
| `src/pigRenderer.js`, `src/zombieRenderer.js` | three | A | `renderScale`, `renderSpin`, capacity |
| `src/circuitGeometry.js` | PURE (new) | C | Wire segments, knobs and overlay poses |
| `src/circuitRenderer.js` | three (new) | C | §4.11 |
| `src/circuitSounds.js` | PURE data (new) | C | Sound recipes (§2.11, §4.12) |
| `src/audio.js` | WebAudio | C | `playRecipe`, `startLoop` |
| `src/atlas.js` | DOM | C | Flat icons (§1.5) |
| `src/pickerModel.js` | PURE (new) | D | Sections, families, search, layout, navigation |
| `src/pickerUI.js` | DOM (new) | D | The picker DOM |
| `src/devicePanel.js` | DOM (new) | D | §4.10 |
| `src/menus.js`, `src/hud.js`, `index.html`, `src/styles.css` | DOM | D | Picker delegation, pause switches, controls sheet, flash overlay |
| `src/main.js`, `src/diagnostics.js`, `src/CONTRACTS.md`, `README.md`, `docs/*` | — | I | §6.6–§6.8 |

**Import graph additions** (acyclic; CONTRACTS §1):
```
circuitParts    → config, blocks, hex
circuitTiles    → (nothing)
tiles           → … + circuitTiles
circuitStore    → config, blocks, coords, circuitParts
circuits        → config, blocks, coords, hex, noise, circuitParts, circuitStore
infall          → config
vortexMath      → config
blackholes      → … (as today) + config constants
vortexRenderer  → three, config, vortexMath
circuitGeometry → config, blocks, hex, noise, circuitParts
circuitRenderer → three, config, circuitGeometry
circuitSounds   → (nothing)
pickerModel     → blocks, circuitParts
pickerUI        → config, blocks, atlas, pickerModel
devicePanel     → config, circuitParts
menus           → … + pickerUI
storage         → … + circuitStore
explosions      → … (unchanged imports; uses BLOCK.COLLAPSAR_CHARGE and KEG_DIRECT_FUSE_S)
```

### 6.2 APIs (normative)

**6.2.1 `circuitParts.js`.**
```js
export const WIRE_KINDS = Object.freeze(['copper', 'brown', 'white', 'earth']);
/** @typedef {{ id, key, role: 'wire'|'junction'|'source'|'contact'|'load'|'fuse'|'flame'|'ignitable', wire?: string,
 *  volts?: number, vMin?: number, amps?: number, input: boolean, earth: boolean, control: boolean,
 *  fields: string[], origin: string, tip: string }} PartDef */
export const PARTS;                          // Readonly<Record<number, PartDef>>: the 20 new ids + POWDER_KEG (+ CAMPFIRE as a flame)
export function partOf(id)                   // PartDef | null
export function partByKey(k)                 // PartDef | null (store validation maps k → id)
export function isPart(id)                   // a circuit part (not CAMPFIRE)
export function isFlame(id)                  // CAMPFIRE, LINSTOCK
export function isIgnitable(id)              // POWDER_FUSE, POWDER_KEG, COLLAPSAR_CHARGE
export function isControl(id)                // KNIFE_SWITCH, PUSH_BUTTON, CLOCKWORK_TIMER, SPARK_TRANSMITTER, BLASTING_MACHINE
export function isEarth(id)                  // §4.4 list, built from names through BLOCKS (256-entry table; UNLOADED → false)
export function signalKind(id)               // 'copper'|'brown'|'white'|null (earth wire → null)
export function conductorAccepts(id, face, inputFace)   // static: wires/boards all faces; contacts all but inputFace
export function joins(idA, faceA, inputA, idB, inputB)  // §4.5 edge rule (assumes contacts closed; the engine checks state)
export function liveFaces(id, inputFace)     // sources/loads: [0..6], inputs: [inputFace]; the engine removes faces touching earth wire
export function sidesTouch(fA, fB)           // true when side faces fA and fB are neighbours (|fA − fB| mod 6 ∈ {1, 5})
export const DEFAULT_INPUT_FACE = 3;
export function inputFaceFromYaw(yaw)        // 0..5 (§4.8)
export function wavelengthOf(ch)             // 300 + 50·(ch − 1) metres
export function parseChannel(token)          // '3' | '400m' | '400 m' → 1..16 | null
export function partTip(id); export function partOrigin(id)   // '' for non-parts
```

**6.2.2 `circuitStore.js`.**
```js
/** PartState = { key, q, y, r, k, l: string, on?: boolean, nc?: boolean, f?: number, s?: number, m?: string,
 *  run?: boolean, ch?: number, c?: number } — only the fields of its kind (§4.8); k is always PartDef.key */
export function partKey(q, y, r)                       // "q,y,r"
export function parsePartKey(key)                      // [q, y, r] | null (strict, like parseRuneKey)
export function defaultPart(k)                         // fresh defaults for a kind
export function normalizePart(k, raw)                  // clamp/round every field; unknown fields dropped
export function partToJSON(state)                      // non-default fields + k; null when pristine
export function normalizePartsJSON(json)               // { parts, warnings }: canonical keys, cap MAX_CIRCUIT_PARTS
export function validatePartsJSON(json, edits, perChunk?)
   // + orphans. Builds Map<chunkKey, Map<localIndex, id>> from `edits` ONCE (or reuses deserializeSave's per-chunk map)
   // and checks each entry in O(1): the cell's id must be partByKey(k).id. Never a scan of the chunk per entry.
export class CircuitStore {
  version; size                                        // size = non-pristine entries
  get(key)                                             // PartState | undefined
  ensure(q, y, r, k)                                   // pristine entry (free; not counted until it changes)
  set(q, y, r, k, partial)                             // PartState | null (null: past the cap)
  delete(key)
  replaceAll(json)                                     // version = 0
  export()                                             // CircuitPartsJSON, keys sorted, pristine omitted
  clear()
}
```

**6.2.3 `circuits.js`.**
```js
/** CircuitHooks = { peek(q,y,r) → id|UNLOADED, setBlock(q,y,r,id) → boolean (lazy), isLoaded(q,r) → boolean,
 *   isEdit(q,y,r) → boolean (the cell is in world.edits: the earth walk), now() → ms (budget and stats only),
 *   igniteKeg(q,y,r) → {ok,message,quiet?}, activateCharge(q,y,r) → {ok,message,quiet?}, kegBurning(q,y,r) → boolean,
 *   daylight() → 0..1, sound(name,x,y,z,volume), particles(kind,x,y,z,count,opts), say(text) }
 *  OverlayItem = { type: 'blade'|'cap'|'hand'|'arm'|'plunger'|'hammer'|'bulb'|'glow'|'staff', q, y, r, a: number, b: number,
 *   glow?: 'lamp'|'igniter'|'ember'|'spark'|'coherer'|'charge'|'fuse', staff?: 'linstock'|'filament'|'char' } */
export class Circuits {
  constructor(store, hooks)
  enabled; switchVersion; geometryVersion; tickCount
  setEnabled(on)                         // off: no ticks, no flame dispatch; on: everything dirty again, settling
  loadFromEdits(edits)                   // §4.7 index; dirties everything for settling; queues flame candidates
  onBlockChange(q, y, r, prev, next)     // bookkeeping only (§4.7)
  onChunkLoaded(cq, cr)                  // dirties the chunk's cells for settling
  step(dt)                               // ≤ 2 ticks
  interact(q, y, r, via /* 'r'|'use' */) // → { ok, message?, channel? } | null (null: no circuit action here)
  hold(q, y, r)                          // main, every frame the operating button stays held on a Push Button (or the R key on a relay)
  pocketSend(ch, x, y, z)                // → { ok, message }
  ignite(q, y, r)                        // fuse / keg (3 s) / charge dispatch → { ok, message }
  wouldIgnite(q, y, r)                   // a flame neighbour or a powered igniter neighbour (blockphysics' undo, §3.6)
  switchAt(q, y, r, mode)                // 'on'|'off'|'toggle'|'press' → { ok, message }
  timerAt(q, y, r, cmd, mode)            // cmd 'start'|'stop'|seconds; mode optional → { ok, message }
  radio(ch, x, y, z)                     // → { ok, message: 'sent on 400 m: 2 receivers in range' }
  setInputFace(q, y, r, face)
  applySettings(q, y, r, partial)        // validated through normalizePart → PartState | null
  refill(q, y, r)                        // battery → full; boolean
  panelView(q, y, r, creative)           // DevicePanelView | null (§6.2.15)
  probe(q, y, r)                         // { volts, amps, earthed, earthReason, state: string,
                                         //   diag: 'bypassed'|'self-fed'|'no-wire'|null,
                                         //   net: { cells, sources, loads, partial, truncated } | null }
  hintFor(q, y, r)                       // §4.9 text | null
  overlays(x, y, z, range, out)          // OverlayItem[] (≤ 512, nearest first)
  geometryView()                         // { cellsNear(x,y,z,range) → number[] packCells, get(q,y,r) → id, inputFace(q,y,r),
                                         //   grounded(q,y,r) → boolean (earth-wire clamps) }
  burningAt(q, y, r)                     // { t, from } | null
  stats()                                // { cells, parts, networks, active, frozen, burning, timers, scheduled, dirty, visits, ms }
  reset(); clear()
}
```

**6.2.4 `blackholes.js` (v2; the §29 API plus the following).**
```js
export const PHASE = Object.freeze({ ARM: 0, FLASH: 1, IMPLODE: 2, VORTEX: 3 });
// BlackHole gains: age (s since arming; Infinity once VORTEX is reached by loading), phase, seed (hash of the key, 0..1),
// fromCharge (prev was COLLAPSAR_CHARGE)
class BlackHoles {
  enabled; switchVersion
  setEnabled(on)                                  // §2.8
  add(q, y, r, phase = PHASE.VORTEX)              // FLASH → age = BLACK_HOLE_ARM_S
  activate(q, y, r, world)                        // §2.2 → { ok, message, quiet? }; world needs getBlock, isLoaded
  get busy()                                      // arming or events pending (main steps even with size 0)
  update(dt, world)                               // + ages, arming (world.place(q,y,r,BLACK_HOLE) when ARM ends and the cell
                                                  //   still holds the charge: non-lazy for the first 2 per update, then lazy);
                                                  //   EatRecord = { q, y, r, id, cx, cy, cz }
  drainEvents(out)                                // BlackHoleEvent[] { type: 'arm'|'flash'|'implode'|'formed'|'collapsed'|'cancelled',
                                                  //   q, y, r, cx, cy, cz }, then clears
  flash(out)                                      // { x, y, z, intensity }: the brightest hole in FLASH (0: none)
  cameraFx(x, y, z, out)                          // { fov, sx, sy, sz } (§2.4.6)
  vortexViews(x, y, z, range, maxFull, maxCores, out)
                                                  // { cx, cy, cz, phase, s, strength, seed, age, full }[] nearest first: tracked
                                                  //   holes, arming charges (phase ARM) and inert holes (strength 0.2); the
                                                  //   nearest maxFull get full = true. Inert holes are scanned only when the
                                                  //   inert set changes or the eye moves 8 units (a cached nearest list)
  renderItems(push)                               // the charge copy from FLASH start through IMPLODE, for fromCharge holes (§2.3);
                                                  //   never an item with scale ≤ 0
  status()                                        // 'black holes on · 3 active (1 forming), 0 inert'
  list(x, y, z, n = 8)                            // string[]: the n nearest, with cell, phase and distance
}
```
`world` for `update`, `activate` and `respawnPoint` is main's `blackHoleWorld`, which gains `place(q, y, r, id, lazy)`.

**6.2.5 `infall.js`.**
```js
export function infallDuration(rho0, h0)                    // D (§2.6)
export function infallPose(s, rho0, theta0, h0, out)        // { x, z (relative), y, scale, rx, ry, rz, done }; pure kinematics
export class Infall {
  constructor(random)
  addBlock(rec, eyeX, eyeY, eyeZ)                            // boolean
  addMob(kind /* 'pig'|'zombie' */, body, cx, cy, cz)        // boolean; writes renderScale / renderSpin on the body each step
  step(dt)                                                   // → { gone: number[] (x,y,z triples), mobsDone: { kind, body }[] }
  renderItems(push)
  ghosts(kind, out)                                          // the ghost bodies of that kind
  size; clear()
}
```

**6.2.6 `vortexMath.js` and `vortexRenderer.js`.**
```js
// vortexMath (pure; the shaders mirror these exactly)
export function diskPattern(x, z, t, seed = 0)     // the disk's darkness a (§2.4.3) at a point relative to the centre
export function flowPhase(t, enabled)              // uPhase = (VORTEX_FLOW_RATE · t · (enabled ? 1 : 0.1)) mod 2π
export function beamVector(eye, centre, right, up, out)   // bScreen (§2.4.2): [x, y], length 0 seen from straight above
export function bandSense(eyeY, cy)                // +1 above the disk plane, −1 below
```
`createVortexRenderer(scene) → { sync(views, t, eye), prewarm(webgl, camera) → Promise, count(), dispose() }`
- 4 InstancedMeshes (core, billboard, disk, shell), initial capacity 16, doubling, at most 256 for core and billboard.
- Per-instance attributes: `aCentre` (vec3) and `aParams` (vec4: seed, s, strength, phase), plus `aFull` on the billboard.
- Uniforms: `uPhase` from `flowPhase`, `uTime` for the arming twinkle and the IMPLODE shell only.
- `frustumCulled = false` on all four; `renderOrder` 2 on the billboard, disk and shell.

**6.2.7 `circuitGeometry.js`.**
```js
export const SEGMENT_STRIDE = 8;           // x0, y0, z0, x1, y1, z1, width, colourIndex
export const KNOB_STRIDE = 5;              // x, y, z, kind (0 knob, 1 tube, 2 binding post, 3 ground clamp), length
export const SEGMENT_COLOURS;              // [copper, brown, white, earthGreen, earthYellow, fuse, fray, porcelain, brass, clamp]
export function wireSegments(view, x, y, z, range, out /* { seg: {data, count}, knob: {data, count} } */)
export function overlayPose(item, t, out)  // Matrix-free pose(s) { x, y, z, rx, ry, rz, sx, sy, sz, colour, alpha } per OverlayItem
```

**6.2.8 `circuitRenderer.js`.**
`createCircuitRenderer(scene) → { setGeometry(out), syncOverlays(items, t, dt), prewarm(webgl, camera) → Promise, count(), dispose() }`
- One segment InstancedMesh, one knob InstancedMesh and 9 overlay InstancedMeshes (≤ 11 draw calls), all with
  `frustumCulled = false`.
- It never adds a light.

**6.2.9 `circuitTiles.js`.** It exports `CIRCUIT_TILE_NAMES` (`{ 160: 'circuit_clear', … }`) and `CIRCUIT_RECIPES`
(`{ name: (px, rng) => void }`, the same painter signature as tiles.js), which also holds `barrel_side` and `barrel_top`
(§3.5). tiles.js spreads `CIRCUIT_TILE_NAMES` into `TILE_NAMES` and `CIRCUIT_RECIPES` **last** into `RECIPES`, and drops its
own two barrel painters. Those are its only edits. **`tiles.test.js`' "every other tile is alpha 255 everywhere" exempts every
id in `CIRCUIT_TILE_NAMES`** (the flat pictures and `CIRCUIT_CLEAR` are alpha 0 by design); `circuitTiles.test.js` owns their
alpha rules.

**6.2.10 `particles.js`.**
- `emitOrbit(kind, cx, cy, cz, count, { rMin, rMax, hMax = 0.6, spin = 1, inward = 1, radial = false, spherical = false,
  color, hot })`.
- **The kind `infall`** has every field `emit` reads, so the plain `gone` and `collapsed` bursts work:
  `{ life: [1.5, 3], speed: 0.6, up: [0, 0.4], gravity: 0, drag: 1.5, size: [0.06, 0.12], growth: -0.3, alpha: 0.9,
  color: [0.18, 0.15, 0.13], jitter: 0.08 }`.
- **Arrays.** Orbit particles keep `orbit` (Uint8Array) plus `oCx, oCy, oCz, rho, theta, height, h0, rho0` (Float32Array) at
  capacity 2048.
- **At emission** an orbit particle's life is set so that it reaches the core:
  `life = (ρ0^1.5 − 0.45^1.5) / (1.8·inward) + 0.3` s.
- **Each update:**
  ```
  rho    -= 1.2 · inward · dt / √rho
  theta  += min(12, 4 · spin · rho^−1.5) · dt     (radial: theta fixed)
  height  = spherical ? h0 · rho / rho0 : height · exp(−2.5 dt)
  size    = baseSize · (0.6 + 0.4 · min(1, rho / 2))        (no age growth)
  ```
  Position = centre + (rho·cos θ, height, rho·sin θ). Alpha rises and the colour moves from `color` toward `hot` as rho
  falls below 1.5. The particle dies at rho < 0.45.
- **The implosion burst** (§2.3): `emitOrbit('infall', c, 64, { rMin: 3.0, rMax: 3.6, hMax: 3.3, spherical: true,
  radial: true, inward: 2.8, color: white, hot: #b03a1a })`. It arrives in about 1.15 s, just before the core pops.
- **The vortex stream**: `{ rMin: 2.5, rMax: 4.5, hMax: 0.6, color: #2e2620, hot: #ffc890 }`.
- `PARTICLE_KINDS` gains `'infall'`.
- **`emit` sets `orbit[i] = 0`** on every slot it writes. *The ring recycles slots; a smoke particle written into an old orbit
  slot would otherwise spiral around a stale centre.*

**6.2.11 `circuitSounds.js` and `audio.js`.**
- **Recipe schema** (pure data):
  ```
  { dur, gain, layers: [{ type: 'noise'|'sine'|'saw'|'square', f0, f1?, lp?, hp?, bp?, q?, gain, delay?, attack?, decay,
    lfoHz?, lfoDepth? }], repeat?: { every, count } }
  ```
- `SOUND_RECIPES` holds every name in §2.11 and §4.12.
- **audio.js** gains:
  - `playRecipe(recipeOrName, volume = 1)`: one voice per layer, all within `MAX_VOICES`, no-op while muted;
  - `startLoop(recipe) → { set(volume, rate), stop() }`: one persistent voice, a no-op handle without WebAudio. Volume 0
    suspends it, and it counts toward `MAX_VOICES` while audible.
- main maps names to `playRecipe` through its distance falloff, as `playPhysicsSound` does.

**6.2.12 `fallingRenderer.js`.** `setFlash(x, y, z, intensity, color = 0xffd49a)`. The light's colour is set only when it
changes.

**6.2.13 `pigRenderer.js` / `zombieRenderer.js`.** A body's optional `renderScale` (default 1) multiplies the model scale,
and its optional `renderSpin` (default 0) adds to its yaw. With neither field set, the output is unchanged (tested). Both
take an optional capacity (main passes `PIG_MAX + MAX_INFALL_MOBS` and `ZOMBIE_MAX + MAX_INFALL_MOBS`).

**6.2.14 `pickerModel.js`, `pickerUI.js`, `menus.js`.**
```js
// pickerModel (pure)
export const PICKER_SECTIONS;                // §5.2, by name
export const PICKER_ALIASES;                 // §5.2
export function buildPickerModel(blocks = BLOCKS)   // { sections: [{ id, title, iconId, entries }], families: Map<string, Family> }
                                                    // Entry = { type: 'block', id } | { type: 'family', key, name, ids }
export function searchBlocks(model, query)          // block ids, section order
export function layoutPicker(model, { cols, openFamily, showAll, query, recent })   // Row[]
   // Row = { kind: 'header', section } | { kind: 'cells', cells: Entry[], indent: boolean, drawerOf: string|null }
export function navigate(rows, index, key, pageRows)  // the next focus index (§5.7)
export function pushRecent(recent, id, max = 9)       // new array
export function blurbFor(id)                          // partTip(id) or ''
// pickerUI (DOM)
export function createPickerUI(doc, els, atlasCanvas, callbacks /* onPick(id, slot|null), onClose() */)
   // → { show(hotbar, selected), hide(), isOpen(), dispose() }
```
menus.js builds `pickerUI` once and maps `showPicker`, `hidePicker` and `isPickerOpen` onto it. Its old picker functions
(`buildPickerGrid`, `markHotbar`, `onPickerKeyDown` and the rest) move into pickerUI.

**6.2.15 `devicePanel.js`.**
```js
export function createDevicePanel(doc, callbacks /* onChange(key, partial), onAction(key, action), onClose() */)
   // → { open(view), refresh(view), close(), isOpen(), getKey(), dispose() }
// DevicePanelView = { key, k, id, title, coords, label, readout: string[], fields: { s?, m?, f?, nc?, ch?, on?, c? },
//   actions: ('start'|'stop'|'send'|'tap'|'refill')[], origin: string, about: string }
export function panelFields(view)            // pure: which controls to show, in order (tested)
export function clampSetting(k, field, value) // pure: delegates to circuitStore.normalizePart rules
```

**6.2.16 `hud.js`.**
- `setFlashOverlay(level, kind /* 'white'|'void' */)` drives `#flash-overlay`, created inside `#hud` before the crosshair
  when index.html has none, as `#hurt-overlay` is.
  - White: neutral, `radial-gradient(circle, rgba(255,255,255,1) 0, rgba(250,248,244,.9) 60%, rgba(240,236,230,.75) 100%)`.
  - Void: #0b0908.
- It touches the DOM only on 1/32 steps.
- **`flashStep(state, dt, trigger) → level`** (pure, exported). `state = { level, sinceStart }`. A trigger `{ level }` starts a
  flash only when `sinceStart ≥ BLACK_HOLE_SCREEN_FLASH_GAP_S`, and the level is capped at `BLACK_HOLE_SCREEN_FLASH_MAX`;
  otherwise it is ignored. Then the level decays on the `(1 − t/0.6)²` curve. Tests: the cap, the gap (at most 2 starts in
  any 1 s), the decay.

**6.2.17 `menus.js` additions.**
- A pause row `#pause-devices.physics-row`, labelled "Devices", **after survival's `#pause-mode` row** (after Creatures when
  survival's row is absent). It holds two survival-style **`.hex-button` two-segment switches**, `#btn-circuits`
  `[ Circuits: On | Off ]` and `#btn-blackholes` `[ Black holes: On | Off ]`, built like survival's mode switch: halves
  `#btn-circuits-on`/`-off` and `#btn-blackholes-on`/`-off`, the active half filled honey with `aria-pressed="true"`, the
  inactive half firing the callback. **Never `.mc-button`.**
- Callbacks `onSetCircuits(on)` and `onSetBlackHoles(on)`, plus `setDeviceSwitches({ circuits, blackholes })`.
- `CONTROLS_SHEET` rows as in §4.9.

**6.2.18 `storage.js`.** §6.4. **`commands.js`.** §6.5.

### 6.3 `config.js` additions (K0)
```js
// ---- Circuits (§50–§53)
export const CIRCUIT_TICK_S = 0.05, VOLT_UNIT = 0.0625, WIRE_OHMS = 0.0625;
export const BATTERY_V = 6, BATTERY_EMPTY_V = 4.5, BATTERY_KNEE = 0.25, MAX_PILE = 4, BLASTER_V = 24, SELENIUM_MAX_V = 3;
export const LAMP_MIN_V = 1.5, LAMP_FULL_V = 6, COIL_MIN_V = 2.5, IGNITER_MIN_V = 3;
export const LAMP_AMPS = 1, BELL_AMPS = 1, IGNITER_AMPS = 2, COIL_AMPS = 0.5, BATTERY_CAPACITY = 3600;
export const EARTH_WALK_CELLS = 8;
export const IGNITER_REFIRE_S = 0.5, RELAY_DELAY_TICKS = 1, RELAY_HAND_S = 0.5, BUTTON_PULSE_S = 0.3, BUTTON_RELEASE_S = 0.1;
export const BLASTER_PULSE_S = 1, BLASTER_RESET_S = 1.5;
export const TIMER_MIN_S = 0.5, TIMER_MAX_S = 3600, TIMER_DEFAULT_S = 5, TIMER_PULSE_S = 1;
export const RADIO_CHANNELS = 16, RADIO_BASE_M = 300, RADIO_STEP_M = 50, RADIO_DISTRESS_CH = 7, RADIO_RANGE = 160, RADIO_PULSE_S = 1;
export const FUSE_CELL_S = 0.4, MAX_BURNING_FUSES = 2048, MAX_FLAME_QUEUE = 4096, KEG_DIRECT_FUSE_S = 0.25;
export const MAX_FUSE_SPARK_CELLS = 16, MAX_FUSE_PUFFS_PER_TICK = 24;
export const MAX_CIRCUIT_PARTS = 4096, MAX_PART_LABEL_CHARS = 24;
export const MAX_CIRCUIT_VISITS_PER_TICK = 6000, CIRCUIT_TICK_BUDGET_MS = 2, MAX_NETWORK_CELLS = 8192;
export const MAX_CONTACT_CHANGES_PER_TICK = 1024, MAX_SETTLE_PASSES = 4;
export const MAX_CIRCUIT_WRITES_PER_TICK = 32, MAX_IGNITIONS_PER_TICK = 32;
export const CIRCUIT_DRAW_RANGE = 64, CIRCUIT_OVERLAY_RANGE = 48, MAX_CIRCUIT_OVERLAYS = 512;
// ---- Black holes v2 (§54)
export const BLACK_HOLE_ARM_S = 0.4, BLACK_HOLE_FLASH_S = 0.3, BLACK_HOLE_IMPLODE_S = 1.2;
export const BLACK_HOLE_SWIRL = 1.6, BLACK_HOLE_SWIRL_CORE = 1.5;
export const BLACK_HOLE_FLASH_INTENSITY = 220, BLACK_HOLE_FLASH_COLOR = 0xfff4e6;
export const BLACK_HOLE_SCREEN_FLASH_RANGE = 48, BLACK_HOLE_SCREEN_FLASH_S = 0.6;
export const BLACK_HOLE_SCREEN_FLASH_MAX = 0.75, BLACK_HOLE_SCREEN_FLASH_GAP_S = 0.5;
export const BLACK_HOLE_PINCH_DEG = 8, BLACK_HOLE_PINCH_RANGE = 24, BLACK_HOLE_STRETCH_DEG = 4;
export const VORTEX_MODEL_RANGE = 128, VORTEX_MAX_MODELS = 16, VORTEX_MAX_CORES = 256;
export const VORTEX_PARTICLES_PER_S = 40, VORTEX_PARTICLE_HOLES = 4;
export const VORTEX_SPIRAL_K = 3.33, VORTEX_INFLOW = 1.2, VORTEX_FLOW_RATE = 9;
export const VORTEX_BILLBOARD = 3.6, VORTEX_CORE_R = 0.3, VORTEX_EVENT_R = 0.45;
export const MAX_INFALL_BLOCKS = 96, MAX_INFALL_MOBS = 8, INFALL_VIEW_RANGE = 48;
export const INFALL_MIN_S = 0.6, INFALL_MAX_S = 2.4, INFALL_MOB_S = 1.2;
```
`types.js` gains these typedefs: `PartDef`, `PartState`, `CircuitPartsJSON`, `OverlayItem`, `BlackHoleEvent`, `VortexView`
and `DevicePanelView`. `SaveData` gains `blackholes?: boolean`, `circuits?: boolean` and `circuitParts?: CircuitPartsJSON`.

### 6.4 Save format (B, storage.js; CONTRACTS §14 amendment)
**What `serializeSave` writes.** The three fields go **after survival's `containers` and before `meta`**:

| Field | Written when | On load |
|---|---|---|
| `blackholes` | Whenever given; anything but `false` is on (the `zombies` rule) | Absent means on |
| `circuits` | The same | The same |
| `circuitParts` | Only when `normalizePartsJSON` leaves it non-empty | Absent means no configured parts |

So the key order with every field present is `…, watcher, watcherNight, gen, mode, survival, containers, blackholes,
circuits, circuitParts, meta`.

**`CircuitPartsJSON`** is `{ "q,y,r": { k, l?, on?, nc?, f?, s?, m?, run?, ch?, c? } }`.
- Keys are canonical; `k` is the part's `PartDef.key`.
- Each entry holds `k` plus its non-default fields only, in that order.
- Numbers are rounded: `s` to 0.5 steps, `c` to an integer.

**What `deserializeSave` repairs.** It never returns null for these fields. Each repair adds a warning:

| Field | Problem | Warning | Repair |
|---|---|---|---|
| `blackholes` / `circuits` | Not a boolean | `blackholes: not a boolean, treated as on` | Dropped (on) |
| `circuitParts` | Not an object | `circuitParts: not an object, ignored` | Dropped |
| An entry | Malformed key | `circuitParts["…"]: not a cell key, dropped` | Dropped |
| An entry | Unknown `k` | `circuitParts[q,y,r]: unknown kind "x", dropped` | Dropped |
| An entry | The cell is not that kind's block in the repaired `edits` | `circuitParts[q,y,r]: no <kind> there, dropped` | Dropped (orphan) |
| An entry | A bad field | `circuitParts[q,y,r].s: invalid, reset` | Default |
| The field | More than `MAX_CIRCUIT_PARTS` entries | `circuitParts: more than 4096 entries, the rest dropped` | Cut, in key order |

The orphan check uses one `Map<chunkKey, Map<localIndex, id>>` built once from the repaired `edits` (or deserializeSave's own
per-chunk map): **O(1) per entry**. *Modelling it on `runes.hasRuneEdit`, which scans a chunk's whole edit list per entry, would
be O(10⁸) at load for 4096 parts.*

**Version.** `SAVE_VERSION` is unchanged. These are optional fields, and an older client ignores unknown fields.
- An older client (v0.8) shows the new blocks as **missing-texture ghost cells** (it meshes unknown ids with the MISSING
  tile; they are non-solid, unbreakable and targetable), keeps their edits, and drops `circuitParts` if it saves.
- *Survival's version 3 bump exists for its own reasons (its §1.4).*

**Rename, duplicate and migrate** round-trip all three fields. They re-serialise the parsed document.

### 6.5 Console commands (B, commands.js; CONTRACTS §26.4)
| Command | Args | Behaviour |
|---|---|---|
| `ignite q y r` (changed) | `cell ×3` | Lights the keg (3 s in place), fuse or charge in that cell, through `ctx.circuits.ignite`. Fails with `there is nothing to light at (q, y, r) — a powder keg, powder fuse or collapsar charge`, or with the hook's message. Without `ctx.circuits`, it falls back to `ctx.physics.explosions.ignite` |
| `switch q y r [on\|off\|toggle\|press]` | `cell ×3`, `choice` (default `toggle`; `press` for buttons) | `knife switch at (q, y, r): closed` / `push button pressed` / `there is no switch or button at …` |
| `timer q y r [start\|stop\|<seconds>] [pulse\|hold\|repeat]` | `cell ×3`, `word`, `choice`, min 3 | 3 args: status (`timer at (…): 10 s pulse, 7.2 s left`). Seconds: set (clamped 0.5–3600) |
| `radio <channel>` | `word`: `1`–`16` or a wavelength `300m`–`1050m` (`parseChannel`) | Sends from the player, or from the rune's cell in a script: `sent on 400 m: 2 receivers in range` |
| `volts q y r` | `cell ×3` | The multimeter: `5.4375 V · earthed · network: 31 cells, 1 source, 2 loads, 2 A` / `(q, y, r) is not part of a circuit`, plus any §4.5 diagnostic |
| `circuits [status\|on\|off]` | `choice`, min 0 | Status: `circuits on · 214 parts, 12 networks, 3 fuses burning, 2 timers running`. On/off: the per-world switch, saved |
| `blackholes [status\|on\|off\|list]` | `choice`, min 0 | Status: `ctx.blackHoles.status()`. On/off: the switch, saved. List: `ctx.blackHoles.list(player)` |

Other command changes:
- **`give black_hole`** fails with `a black hole cannot be held — give collapsar_charge and set it off`.
- **`resolveBlock`** consults `BLOCK_ALIASES` after the exact-name pass.
- **Area jobs** need no special case (§4.8).
- **Scripts.** None of these is `consoleOnly` or `scriptOnly`: runes can drive circuits. *That is the bridge from rune logic
  to devices.*

**`CommandContext` gains:**
```
circuits?:   { enabled, setEnabled(on), ignite, switchAt, timerAt, radio, probe, stats }
blackHoles?: { enabled, setEnabled(on), status() → string, list(x, y, z) → string[] }   // BlackHoles itself (§6.2.4)
```

### 6.6 `main.js` wiring (Integration)
**New objects and state.**
- Session objects:
  - `circuitStore` (outlives worlds, like `runeStore`);
  - `infall`;
  - `vortexRenderer`, `circuitRenderer`, `devicePanel`;
  - `droneLoop`, `pocketChannel = 1`, `tipsShown: Set`, `flashState`, `flashKind`, `rightOnControl = false`,
    `heldControl` (the cell a held button or R key is keeping pressed, or null).
- Per world: `circuits`, which is null until `startLoading`.
- `STATE.DEVICE = 'device'` and `deviceKey`.

**Renderers.** Create `vortexRenderer` and `circuitRenderer` right after `fallingRenderer` and `particles`, and **prewarm them
after the falling renderer**, once every light exists (the existing prewarm block). Create `pigRenderer` and
`zombieRenderer` with the larger capacities (§6.2.13).

**`circuitHooks`:**
```js
peek: (q, y, r) => world.peekBlock(q, y, r),
setBlock: (q, y, r, id) => world.setBlock(q, y, r, id, true),
isLoaded: (q, r) => world.hasChunkAtCell(q, r),
isEdit: (q, y, r) => cellIsEdited(world.edits, q, y, r),        // chunkKey + localIndex lookup in world.edits
now: () => performance.now(),
igniteKeg: (q, y, r) => blockPhysics ? blockPhysics.explosions.igniteInPlace(q, y, r) : { ok: false, message: 'block physics is not available' },
activateCharge: (q, y, r) => blackHoles.activate(q, y, r, blackHoleWorld),
kegBurning: (q, y, r) => !!blockPhysics && blockPhysics.explosions.isBurning(q, y, r),
daylight: () => Math.max(0, Math.min(1, sunDirection(time, sunTmp)[1] / 0.5)),
sound: (name, x, y, z, v) => playCircuitSound(name, x, y, z, v),
particles: (kind, x, y, z, n, o) => particles.emit(kind, x, y, z, n, o),
say: (text) => logLine(text),
```
`blackHoleWorld` gains `place: (q, y, r, id, lazy) => world.setBlock(q, y, r, id, lazy)`.

**`PhysicsHooks`** (passed to `BlockPhysics`, §3.6) gain `isIgnitable: (id) => isIgnitable(id)` and
`ignitesAt: (q, y, r) => !!circuits && circuits.wouldIgnite(q, y, r)`.

**`onBlockChanged`** runs, in order:
1. `blackHoles`;
2. `campfires`;
3. runes (as today);
4. **`circuits.onBlockChange`**;
5. if `state === STATE.DEVICE` and the changed cell is the panel's: `closeDevicePanel()`;
6. survival's trackers (its §9.5);
7. `blockPhysics`, last.

**`startLoading`.**
- After `BlockPhysics` exists: `blockPhysics.explosions.onCharge = (q, y, r) => blackHoles.activate(q, y, r, blackHoleWorld)`.
- `circuitStore.replaceAll(restoring?.circuitParts ?? null)` and `circuits = new Circuits(circuitStore, circuitHooks)`.
- The switches: `circuits.setEnabled(restoring?.circuits !== false)` and
  `blackHoles.setEnabled(restoring?.blackholes !== false)`.
- `blackHoles.loadFromEdits(world.edits)` as today, then `circuits.loadFromEdits(world.edits)` (settling, §4.7).
- `world.onChunkGenerated` also calls `circuits.onChunkLoaded(cq, cr)`.
- `hotbarFrom` maps `BLACK_HOLE` to `COLLAPSAR_CHARGE`.

**`stepPlaying`** (survival's additions, its §9.5, slot in where it says):
1. **Modal keys** (E, T, /), the digits, F3, M and the wheel: unchanged.
2. **The R key and the Shift+R key** as in §4.9.
   - The Shift+R key on a part opens the device panel (`openDevicePanel(q, y, r)`): set `STATE.DEVICE`, then
     `controls.setEnabled(false)` and `controls.unlock()`, then `devicePanel.open(circuits.panelView(q, y, r, !SV))`.
   - A held R key on the Push Button or Relay it pressed calls `circuits.hold(q, y, r)` each frame while the crosshair stays
     on that cell.
   - Return if the state changed.
3. **The left mouse button**: as today, except that a press on a keg burning in place calls `explosions.snuff` instead of
   breaking it (§3.2).
4. **The right mouse button.**
   ```js
   const shift = controls.isDown('ShiftLeft') || controls.isDown('ShiftRight');
   if (mouse.rightPressed) {
     const h = hit;
     if (h && !shift && circuits && isControl(h.blockId)) { operateControl(h); rightOnControl = true; heldControl = h; }
     else placeSelected();
     placeHeld = 0;
   } else if (mouse.right) {
     if (rightOnControl) {                                  // the control latch: a hold never places or re-operates
       if (heldControl && hit && sameCell(hit, heldControl)) circuits.hold(hit.q, hit.y, hit.r);
     } else if (!(hit && !shift && isControl(hit.blockId))) { /* hold-repeat: placeSelected() at PLACE_REPEAT_S */ }
   } else { rightOnControl = false; heldControl = null; }
   ```
   `operateControl(h)` calls `circuits.interact(h.q, h.y, h.r, 'use')`, logs any message and updates `pocketChannel` from a
   transmitter. In Survival, `survivalRight` gets the same latch (§4.9).
5. **`placeSelected`**, after a successful place:
   - a part with `input`: `circuits.setInputFace(tq, ty, tr, inputFaceFromYaw(controls.yaw))`;
   - the first placement this session of each part key: `logLine('Tip — ' + tip)`.
6. **Pull, current and `stepPlayer`**, as today. The swirl lives in `pullAt`.
7. **`stepBlackHoles(dt)`.** It runs when `blackHoles.size > 0 || blackHoles.busy`.
   - A swallowed player: Creative → teleport, void flash, `bhSwallow`, the chat line; Survival → `pendingDeath`.
   - The inert warning, as today.
   - `update` → for each eat record, `infall.addBlock(rec, eye)` plus at most one crunch per frame, as today.
   - `drainEvents` → effects:

     | Event | Effects |
     |---|---|
     | `arm` | The `bhArm` sound |
     | `flash` | A screen-flash trigger through `flashStep` (line of sight, facing, the 0.5 s gap; §2.4.6), `bhFlash`, 24 white sparks |
     | `implode` | `bhImplode`, the spherical inward `emitOrbit` burst of 64 (§6.2.10) |
     | `formed` | A ring flare (vortexRenderer handles it from the phase); nothing more |
     | `collapsed` | An outward burst, `bhCollapse` |
     | `cancelled` | Nothing |

     Only the nearest 4 events of each type per frame get sound, flash and particles.
   - Vortex particle emission: per-hole rate accumulators for the 4 nearest VORTEX holes within 48 units.
8. **`stepPigs` / `stepZombies`.** A swallowed mob becomes `infall.addMob(kind, mob, hole.cx, hole.cy, hole.cz)`, and the
   squeal or KO puff is deferred to `mobsDone`.
9. **`stepWatcher`, `stepBlockPhysics`, `stepCampfires`**: as today (plus survival's).
10. **`stepCircuits(dt)`.** `if (circuits) circuits.step(dt)`. Then `infall.step(dt)`:
    - `gone` → 3 `infall` particles each;
    - `mobsDone` → `audio.playSqueal()` / `zombieGone(zb, 'ko')`.
11. **Then as today**: bodies, `unstickPlayer`, the clock, `runner.update`, `world.update`, `updateHit`, `autosaveTick`.
    `autosaveTick` also saves when `circuitStore.version`, `circuits.switchVersion` or `blackHoles.switchVersion` changed.

**`stepFrame`.** `STATE.DEVICE` runs `stepPlaying(dt)` with controls disabled **in Survival** (like survival's PACK); in
Creative it steps nothing.

**`renderFrame`.**
- **Moving blocks.** Build the item list for `fallingRenderer.sync`: the `blockPhysics.renderItems()` items by reference into
  a main-owned reused array, then `blackHoles.renderItems(push)` and `infall.renderItems(push)` through a main-owned pooled
  `push`.
- **Light, shake and FOV.**
  - Take the brighter of `explosions.flash` and `blackHoles.flash`, and call `fallingRenderer.setFlash(…, colour)`.
  - Shake = `explosions.shakeOffset` + `blackHoles.cameraFx` (sx, sy, sz).
  - `renderer.setFov(fov + camFx.fov)`.
- **Vortices.** `vortexRenderer.sync(blackHoles.vortexViews(eye…, VORTEX_MODEL_RANGE, VORTEX_MAX_MODELS, VORTEX_MAX_CORES,
  viewsTmp), fxTime, eye)`.
- **Circuits.**
  - Call `circuitRenderer.setGeometry(circuitGeometry.wireSegments(circuits.geometryView(), eye…, CIRCUIT_DRAW_RANGE, geoTmp))`
    when `geometryVersion` changed or the player moved 16 units since the last build.
  - Call `circuitRenderer.syncOverlays(circuits.overlays(eye…, CIRCUIT_OVERLAY_RANGE, ovTmp), fxTime, dt)` every frame.
- **Mobs.** `pigRenderer.sync(pigs.list` + pig ghosts`)` and `zombieRenderer.sync(…)` likewise, through reused scratch
  arrays.
- **Screen flash.** `hud.setFlashOverlay(flashStep(flashState, dt, null), flashKind)`.
- **Drone.** `droneLoop.set(volume, rate)` for the nearest VORTEX within 24 units, or 0.
- **`targetHintText`.**
  1. lit keg (entity);
  2. zombie;
  3. a part (`circuits.hintFor`);
  4. keg (§3.3, including "burning in place");
  5. black hole;
  6. rune.

**The device panel.**
- `onChange(key, partial)` → `circuits.applySettings`, then `devicePanel.refresh(view)`.
- `onAction` → `start`/`stop` (`timerAt`), `send` (`radio` from the cell; this also sets `pocketChannel`), `tap`
  (`interact 'r'`), `refill`. Each is followed by a refresh.
- `onClose` → `closeDevicePanel()` → `enterPlayingFromModal()`.

**`CommandContext`** gains `circuits` and `blackHoles` (§6.5).

**`buildSaveData`** adds `blackholes: blackHoles.enabled`, `circuits: circuits ? circuits.enabled : true` and
`circuitParts: circuitStore.export()`.

**`quitToTitle` / `dispose`:**
- `circuits = null`, `circuitStore.clear()`, `infall.clear()`;
- `devicePanel.close()`, `vortexRenderer.sync([], 0, eye)`, `circuitRenderer.setGeometry(null)`;
- `droneLoop.set(0)` and `dispose`.

**Debug handle.** It adds `circuits`, `circuitStore`, `blackHoles` and `infall`.

### 6.7 Diagnostics (Integration)
- **F3 lines** (shown when there is something to report):
  ```
  Circuits: 214 cells · 31 parts · 12 nets (4 active, 0 frozen) · 3 fuses burning · 2 timers · 0.4 ms/tick · 1.1k segments
  Black holes: 3 (1 forming) · 0 inert · infall 12 blocks / 1 mob
  ```
- **URL parameters.**
  - `?ui=device` opens the device panel on a demo timer view.
  - `?scene=vortex` places a Collapsar Charge 8 cells in front of spawn after loading and sets it off 2 s later.
  - `?scene=circuits` builds the §4.14 doorbell (1), timed keg (2, with a keg in place of the charge) and dusk lamp (7),
    with their named cells offset in front of spawn (`diagnostics.readSceneParam`; main writes the cells with
    `world.setBlock` and sets the input faces).

  These exist for the Windows Chrome screenshots (§7, I).
- **Smoke.**
  - `?scene=vortex`: screenshots at 0.5 s, 1.2 s and 3 s after the trigger, then assert `blackHoles.size === 1`.
  - `?scene=circuits`: press the doorbell button through `game` and assert the bell's `probe().state === 'ringing'`.

### 6.8 CONTRACTS sections (I writes them from this document)
| Section | Title | Content |
|---|---|---|
| §50 | Circuit parts | `circuitParts.js`, blocks and tiles (§1), the part table, earth, terminals and the connection rules (§4.2, §4.4, §4.5) |
| §51 | `circuitStore.js` | The side table, `circuitParts` save field, validation (§4.8, §6.4) |
| §52 | `circuits.js` | Mechanical (§4.3), electrical (§4.4, §4.6), the tick, settling and solver (§4.7), hooks, hints, diagnostics, teaching text (§4.13) |
| §53 | Circuit look and sound | `circuitGeometry`, `circuitRenderer`, `circuitTiles`, `circuitSounds`, audio's `playRecipe` / `startLoop`, flat icons (§1.5, §4.11, §4.12) |
| §54 | Black holes v2 | Amends §29: Collapsar Charge, activation, phases, swirl and escape, switch, events; `infall.js`, `vortexMath.js`, `vortexRenderer.js`, `emitOrbit` (§2) |
| §55 | Powder kegs | Amends §37: names, burning in place, snuffing, lighting without the R key, `onCharge`, the undo hooks (§3) |
| §56 | Creative inventory | Amends §20: `pickerModel.js`, `pickerUI.js` (§5) |
| §57 | Device panel | `devicePanel.js`, `STATE.DEVICE` (§4.10) |
| §58 | Circuits integration | Frame order, the R key / RMB / Shift+R key, the control latch, commands, saving, diagnostics (§4.9, §6.5–§6.7) |

**Amendments:**

| Section | Change |
|---|---|
| §1 | The files table and the import graph |
| §5 | The new blocks and tiles, `icon`, `BLOCK_ALIASES`, the `POWDER_KEG` alias, BLACK_HOLE unplaceable and unmeshed, PICKER_ORDER |
| §14 | The three save fields |
| §16 | Flat icons; the keg's tiles live in `circuitTiles.js` |
| §19–§23 | The HUD flash overlay, the picker, the pause switches, `STATE.DEVICE`, controls |
| §26 | The new and changed commands |
| §29 | → §54 (the escape rule changes, §2.5) |
| §33.8.4 | Undo's ignitable check uses `ignitesAt` (§3.6) |
| §34.4 | `setFlash` colour |
| §34.5 | `emitOrbit`, `infall` |
| §37 | → §55 |
| §25 | New pitfalls, below |

**New pitfalls:**
- **32.** Never put circuit state in block ids: a relay that toggles 10 times a second would re-mesh its chunk 10 times a
  second. State lives in `CircuitStore` or in the engine, and is drawn by overlays.
- **33.** `Circuits.onBlockChange` and `BlackHoles.onBlockChange` do bookkeeping only. A write from inside them recurses into
  `World.setBlock`.
- **34.** Wires never glow. Show electricity with lamps, bells and the volts readout.
- **35.** There is one PointLight for flashes: share it (`setFlash` colour), and never add a renderer that adds a light
  without re-running the prewarm order.
- **36.** Loading never fires anything: cells that load, and networks that span an unloaded chunk, are solved settling, with
  no edge actions (§4.7).
- **37.** On a hex, cells on neighbouring side faces touch. Any rule or test about "the two sides" of a device must name its
  faces (§4.5).

=====================================================================================================================
## 7. Work packages

**Merge order:**
1. **K0** first (after survival's W0 when it is ready, §1.3);
2. then **A, B, C, D** in parallel, in any order. While they run, each file belongs to exactly one package;
3. then **B-post**, the small post-merge edit to `blockphysics.js` (after survival A has merged);
4. then **I**.

When a package needs something that does not exist yet, it codes against this document and tests with fakes. It never edits
another package's file. A `// CONTRACT-ISSUE:` comment flags any disagreement.

**Hand-overs.** `circuitTiles.js` changes hands sequentially: K0 writes placeholders and moves the keg's two painters in, then
C owns it.

### 7.1 Files that survival's packages also touch (the integrator's sequencing)
*Re-checked against `docs/DESIGN-survival.md` v2 (§8.1, §9.1, §10 and §14.3): W0 owns config, types, blocks, items and parts
of tiles and styles; A owns tiles, worldgen, world, fallingblocks and blockphysics; B owns inventory, harvest, containers and
survivalControl; C owns crafting, cooking, storage and commands; D owns vitals, climate, survival, physics, bodies, pigs and
zombies; E owns hud, menus, packUI, itemIcons, itemArt, index.html and styles; F owns renderer, campfireRenderer and audio;
H (the Handbook) owns handbook, handbookUI and small parts of items, itemArt, survivalControl, inventory, index.html and
styles. Survival's ids are blocks 76–94 (`BLOCK_COUNT` 95), tiles 77–104 (`TILE_NAMES` 115), `PICKER_ORDER` 80.*

| File | Survival | Ours | How to merge |
|---|---|---|---|
| `src/blocks.js`, `src/config.js`, `src/types.js` | W0 | K0 | **Survival W0 first**, then K0 appends: ids 95–114 (§1.3), new config sections, new typedefs. K0 re-runs the PICKER_ORDER and count tests with survival's 13 blocks present |
| `src/tiles.js`, `tests/unit/tiles.test.js` | W0, then A | K0: the two spread lines, the removal of the two barrel painters and their `RECIPES` lines (moved to circuitTiles, §3.5), the count, and the exemption of every `CIRCUIT_TILE_NAMES` id from "alpha 255 everywhere" | K0 after W0. Survival A's art edits touch neither the spread lines nor the barrel painters |
| `tests/unit/wave0.test.js` | W0 | K0 | Whoever lands second updates `BLOCK_COUNT`, `TILE_IDS` and the PICKER_ORDER counts |
| `index.html`, `src/styles.css`, `src/menus.js`, `src/hud.js`, `tests/unit/styles.test.js` | W0 (the `#picker-grid` width), then E | D | **D replaces the whole picker block** of index.html, styles.css and styles.test.js, superseding W0's 980 px edit (D keeps 980 px as the panel width). D **uses survival E's `.hex-button`** for the device panel and the pause switches; if E has not merged when D starts, D adds a minimal `.hex-button` rule marked `/* survival E's — dedupe on merge */`. D's `#pause-devices` row goes after E's `#pause-mode`. D's ids join E's "no `.mc-button`" assertion. E's pack screen, vitals, death screen and Mode row are otherwise disjoint. The `CONTROLS_SHEET` rows both reword are merged as below |
| `index.html`, `src/styles.css` (again) | H, the Handbook (survival §14.3): the Guide button on the title and pause menus, two reader roots, its own CSS section | D | Disjoint additions. The pause menu gains the Guide button (H), the Mode switch (E) and the Devices switches (D); keep Guide above "Save & Quit", then Mode, then Devices after Creatures |
| `src/storage.js`, `src/commands.js`, `tests/unit/storage.test.js`, `tests/unit/commands.test.js`, `tests/unit/saveSlots.test.js` | C | B | Additive. Our fields go after `containers`; survival's key-order test gains `blackholes, circuits, circuitParts` before `meta`. The command tables append; `ignite`'s summary changes |
| `src/audio.js`, audio tests | F | C | Additive: two primitives, no new `play*` methods |
| `src/blockphysics.js` (and the strings in `tests/unit/blockphysics.test.js`, if any) | A | **B-post** (after survival A merges): the 3 strings (§3.1) and the 2 optional hooks in `PhysicsHooks` and undo (§3.6) | A small, mechanical edit to A's merged file; nothing else in it changes |
| `src/world.js` | A | — (a request, not an edit) | *Ask survival A for a fast path:* `setBlock` skips `_markDirtyAround` when prev and next are both AIR or unmeshed non-opaque ids (a wire placed, a fuse burnt). *Such a change cannot alter any chunk mesh; without it every wire placement and burnt fuse cell re-meshes 1–4 chunks and eats the lazy budget during long burns.* Until then it is a known cost |
| `src/survivalControl.js` | B (and H) | — | Survival's integrator adds the circuits R step and the keg explanation to `interactKind`, and the control latch to `UseState`'s caller (§4.9). Our I lists the exact steps in CONTRACTS §58 |
| `src/items.js` | W0 (and H) | — | Survival's `ITEM_ALIASES` gains `black_hole: 'collapsar_charge'` (and `blast_barrel: 'powder_keg'` if survival ships first, §8.3) |
| `src/campfireRenderer.js` | F | — | Not touched in v1 (lamps lending the campfire lights is deferred, §10) |
| `src/main.js`, `src/diagnostics.js`, `src/CONTRACTS.md`, `README.md`, `docs/KNOWN-ISSUES.md`, the version bump | I | I | One integrator merges both, or ours runs after survival's I. The version becomes the next minor (0.10.0 after survival's 0.9.0) |
| `src/explosions.js`, `src/blackholes.js`, `src/particles.js`, `src/fallingRenderer.js`, `src/pigRenderer.js`, `src/zombieRenderer.js`, `src/atlas.js` | — | ours | No conflict |
| `src/support.js`, `src/fallingblocks.js`, `src/pigs.js`, `src/zombies.js`, `src/physics.js`, `src/bodies.js`, `src/fluids.js` | A, D | **not touched** | — |

**Merged `CONTROLS_SHEET` texts** (still 17 rows):

| Key | Text |
|---|---|
| RMB | `Place · right-click works switches, timers, plungers (Shift: place) · Survival: use the item in hand` |
| R | `R key: use a switch, timer, fuse, radio key or rune · Survival: fire, water, plants, basket` |
| E | `Blocks · Survival: pack & making` (survival's) |
| Shift R | `Shift+R key: settings of the targeted device or Rune Block` |

### K0 — Shared contracts (the lead; mechanical; about half a day)
- **Owns:**
  - `src/blocks.js` (§1.1, §1.2, §1.5), `src/config.js` (§6.3), `src/types.js` (§6.3);
  - in `src/tiles.js`, only the spread lines and the removal of the two barrel painters (§3.5);
  - `src/circuitTiles.js` (placeholders: a flat colour derived from each tile name; `CIRCUIT_CLEAR` and the flat pictures'
    alpha-0 background are real at once; the two keg painters moved in unchanged);
  - `src/circuitParts.js` (complete);
  - `tests/unit/wave0.test.js`, `tests/unit/tiles.test.js` (counts and the `CIRCUIT_TILE_NAMES` exemption), and the new
    `tests/unit/circuitParts.test.js`.
- **Delivers.** §1 and §6.2.1, exactly. Every existing test stays green, apart from the ones K0 itself updates (§5.10).
- **Tests** (`circuitParts.test.js`):
  - every new id has a `PartDef`; keys are unique; roles are valid; every part has an `origin`, and `fields` lists only
    §4.8 fields;
  - `isFlame`, `isIgnitable` and `isControl` are exactly their sets;
  - `isEarth` is true for every block in §4.4's list that exists and false for every insulator listed; it builds with a fake
    `BLOCKS` that lacks survival's ores;
  - `joins` covers the §4.5 table case by case (same/different kinds, terminal board, closed contact, input face, earth
    wire);
  - `liveFaces`; `sidesTouch` for all 36 pairs;
  - `inputFaceFromYaw` at the six face directions and the halfway boundaries;
  - `wavelengthOf` (1 → 300, 7 → 600, 16 → 1050) and `parseChannel` (`3`, `400m`, `400 m`, bad tokens);
  - every tip is non-empty and at most 240 characters;
  - THIN blocks have `meshed: false` and `icon: 'flat'`; CABs (the lamp included) are meshed opaque prisms;
  - `BLOCK_ALIASES.blast_barrel === BLOCK.POWDER_KEG`.

### A — Black holes and the vortex
- **Owns:** `src/blackholes.js`, `src/infall.js` (new), `src/vortexMath.js` (new), `src/vortexRenderer.js` (new),
  `src/particles.js`, `src/fallingRenderer.js`, `src/pigRenderer.js`, `src/zombieRenderer.js`. The tests
  `blackholes.test.js`, `infall.test.js` (new), `vortexMath.test.js` (new), `vortexRenderer.test.js` (new),
  `physicsRender.test.js`, `pigRenderer.test.js` and `zombieRenderer.test.js`.
- **Interfaces:** §2, §6.2.4–§6.2.6, §6.2.10, §6.2.12, §6.2.13.
- **May stub:** nothing. It needs only K0.
- **Existing tests to change** in `blackholes.test.js`:
  - the cases that create holes through `world.setBlock → onBlockChange` (around L211–330) now start at FLASH and eat
    nothing for 1.5 s: switch their setup to `holes.add()` (VORTEX), or step `ARM_S + FLASH_S + IMPLODE_S` first;
  - eat records now carry `cx, cy, cz`: use `toMatchObject` instead of `toEqual({ q, y, r, id })`;
  - the L44 "is placeable" assertion is inverted;
  - **the escape helper** (L502–534): re-aim `yaw = atan2(−(p.x − cx), −(p.z − cz))` every frame, and keep "escapes from 1.5
    units in every mode at 30, 60 and 144 Hz"; add "a fixed heading from 3 units escapes in every mode" and "a fixed heading
    walking from 1.5 units is swallowed".
- **Tests:**
  - **`pullAt`:**
    - the radial component is unchanged; the tangential component is `SWIRL·g·min(1, ρ/1.5)`, perpendicular, in the +θ
      sense;
    - two opposite holes still cancel;
    - strength 0 in ARM and FLASH, s² in IMPLODE, 0 when switched off;
    - a still body spirals in (its angle about the hole changes monotonically), **sweeps at least 2.4 rad between ρ = 8 and
      ρ = 1.5**, and is swallowed. Run this through real `stepPlayer`, like the existing "drags a walking player in" test.
  - **Phases:**
    - `add()` defaults to VORTEX;
    - `onBlockChange` adds at FLASH with age = ARM_S, and sets `fromCharge` only when prev was a charge;
    - ages advance only in `update`;
    - eating and swallowing happen only in VORTEX;
    - `loadFromEdits` gives VORTEX.
  - **`activate`:**
    - every refusal message; the arming refusal is `quiet`;
    - arming lasts exactly 0.4 s, then **one** `place(…, BLACK_HOLE)`; with 3 charges ending ARM in one update, the first 2
      are non-lazy and the third lazy;
    - breaking the charge during arming cancels (event `cancelled`), and so does the switch going off;
    - a second activate is refused.
  - **Events and effects:**
    - the event order `arm → flash → implode → formed`, and `collapsed` when a vortex cell is broken;
    - the `flash()` curve, colour and position;
    - `cameraFx` pinch shape and range;
    - eat records carry `cx, cy, cz`;
    - `vortexViews` is nearest-first, marks the nearest `maxFull` as `full`, includes arming charges and inert holes (at
      0.2), and caps cores at `maxCores`;
    - **`renderItems`** returns the charge copy on every frame from FLASH start through IMPLODE for a `fromCharge` hole
      (swelling in FLASH), none for a `setblock` hole, and never an item with scale ≤ 0;
    - `status()` and `list()` strings.
  - **`infall`:**
    - `infallPose` at s = 0 is the cell centre (the tear jitter is 0 at s = 0);
    - after the tear, ρ falls with a **rising** radial speed, `θ − θ0 = K·ln(ρ0/ρ)`, h tends to 0, and scale ends at 0.15;
    - a cell straight above the core (ρ0 = 0) still swirls (ρ0 clamped to 0.6);
    - removal at ρ ≤ 0.45 or s = 1; the D formula and its clamps;
    - the 96 cap finishes the oldest; outside 48 units, nothing is added; `meshed: false` ids are skipped;
    - mob ghosts get `renderScale` and `renderSpin` and are reported in `mobsDone`.
  - **`vortexMath`:**
    - `diskPattern`: at a fixed angle, the radius of a dash crest **falls** over time at about 1.2/√r;
    - along an arm crest, moving inward **increases** θ, the same sign as `pullAt`'s tangent (−vz, 0, vx);
    - `beamVector` points at the approaching limb, does not change with time, and has length 0 from straight above;
    - `bandSense` and `flowPhase` (a tenth of the rate when off).
  - **`vortexRenderer`** (stub scene, like `campfireRenderer.test.js`):
    - 4 meshes; instance counts follow the views (cores and billboards for every view up to 256; disks and shells only
      for `full` views; the shell only for ARM/IMPLODE);
    - **the billboard is 3.6 units**; `frustumCulled === false` on all four; `renderOrder` 2 on the billboard, disk and
      shell;
    - the strength attribute; dispose; prewarm resolves.
  - **`particles`:**
    - orbit particles spiral in (ρ falls, θ rises), **reach ρ < 0.45 before their life ends** from every start radius,
      die below 0.45 and respect capacity; `spherical` keeps `height = h0·ρ/ρ0`;
    - the implosion burst arrives in 1.15 ± 0.1 s;
    - `PARTICLE_KINDS` includes `infall`, and a plain `emit('infall', …)` gives finite positions;
    - **an orbit slot overwritten by `emit` moves ballistically**;
    - `emit` otherwise behaves exactly as before.
  - **`fallingRenderer.setFlash`** colour.
  - **Mob renderers.** `renderScale` and `renderSpin` are honoured, their absence gives the old output, and the capacity
    argument holds `PIG_MAX + 8` bodies.
  - **Survival's tests.** `pigs.test.js` and `zombies.test.js` (which use `BlackHoles`) still pass **unchanged**.

### B — The circuit engine, explosions, saving and commands
- **Owns:** `src/circuitStore.js` and `src/circuits.js` (new), `src/explosions.js`, `src/storage.js`, `src/commands.js`. The
  tests `circuitStore.test.js`, `circuits.test.js` and `circuitsBudget.test.js` (new), `explosions.test.js`,
  `storage.test.js`, `saveSlots.test.js` and `commands.test.js`. **B-post** (after survival A merges): the `blockphysics.js`
  edit of §3.1 and §3.6, with any string assertions in survival's `blockphysics.test.js`.
- **Interfaces:** §3.4, §3.6, §4, §6.2.2, §6.2.3, §6.4, §6.5.
- **May stub:** a Map-backed fake world (peek/setBlock/isLoaded/isEdit), fake hooks that record calls, a fake clock for
  `now`, and a fake `ctx.circuits` and `ctx.blackHoles` for commands.
- **Tests:**
  - **`circuitStore`:**
    - defaults per kind; pristine entries are not saved or counted; ensure/set/delete; the cap;
    - `normalizePart` clamps (`s` 0.5–3600 in 0.5 steps, `ch` 1–16, `c` 0–capacity, `f` 0–6, `m` per kind — `rx` takes
      `pulse`/`latch`, label ≤ 24 characters, trimmed; `nc` only for button and relay);
    - export is sorted; `validatePartsJSON` drops orphans and wrong kinds **using one per-chunk map** (a spy proves no
      per-entry scan); `replaceAll` resets `version`.
  - **`circuits`**, against the fake world:
    - each of the 12 worked examples of §4.14, **built cell by cell with the named faces**, with the exact volts and
      timings;
    - **the solver's first-cell rule**: Battery → 1 Copper Wire → Lamp reads 5.9375 V; Battery → 1 Copper Wire → Igniter
      reads 5.875 V; an idle wire with no load reads 6 V on every cell;
    - **Ohm's law**: `I_net` counts every attached earthed load whatever its voltage; one, two and three lamps on one wire;
      an unearthed load adds nothing; the reach table of §4.4 row by row;
    - **batteries**: the discharge knee (6 V down to 25 %, 4.5 V just before empty, 0 when flat), the dirty marks at each
      unit step, the `(tired)` hint; the drain split among the highest-voltage sources; **piles**: 2 high = 12 V, the
      bottom alone needs earth, a flat bottom kills the pile, a fifth is inert, a load fed at height 2 drains both;
      `store.version` bumps only on whole percents; no drain while unloaded or frozen;
    - connections: the whole §4.5 table, in a world; devices never join directly (a lamp against a battery reads 0 V and
      the `no-wire` diagnostic);
    - **diagnostics**: a knife switch fed on W and leaving on SW is `bypassed`; the same switch leaving on E is not; the
      latch's Start button is not flagged while latched; a battery beside the switch that also touches the far wire is
      flagged; a relay with its battery on the face next to its input is `self-fed`;
    - earth: insulators; the walk (a dirt block on a sky platform is not earthed; three placed stone blocks on natural
      ground are; nine are not; y at the world's bottom is); earth-wire nets grounded and not; a ground strap on a side
      face is an earth terminal and attaches no signal wire; **digging the dirt under the only grounded earth-wire cell
      makes the lamp read `not earthed` on the next tick**;
    - the solver:
      - multi-source voltages; 0-cost terminal boards and contacts; `seg` ids;
      - truncation at `MAX_NETWORK_CELLS`, with one message;
      - the visit budget carrying dirty cells to the next tick;
    - **settling**: reload a world holding an energised NC relay guarding Battery → Igniter → keg: the keg is not lit; the
      same with the coil's battery in a chunk that loads later; a dusk circuit loaded at noon does not flash its lamp; a
      network that gains an unloaded cell freezes (no edges, no drain) and settles when it loads again;
    - ticks:
      - the relay delay is exactly 1 tick (50 ms); a self-wired relay toggles every tick;
      - the relay's R-key hand push (held, and 0.5 s);
      - radio arrives on the next tick, with range and wavelength filters;
      - timer pulse, hold and repeat, including **repeat at s = 0.5 giving exactly one rising edge every 10 ticks**, s = 1
        giving 0.5 / 0.5, and `run` saved;
      - the push button: held for 2 s it stays closed 2 s (+ 0.1 s); a click gives 0.3 s; NC inverts;
      - the coherer: pulse auto-taps after 1 s; latch stays closed through a second signal and opens on the R key or a
        tapper rising edge;
      - the blaster's pulse and its reset refusal;
      - selenium by daylight, under glass (open) and under stone (shaded);
    - fuses:
      - 0.4 s per cell; branching; cutting;
      - deferred AIR writes at most 32 per tick; **a 12×12×4 fuse fill burns out completely with each cell lit once**
        (`spent`);
      - spark and puff caps;
      - kegs and charges lit through the hooks; an igniter refiring on a burning keg is silent;
      - frozen while unloaded; the cap;
    - flames:
      - a linstock next to a fuse, keg or charge; a campfire next to a fuse;
      - campfire + keg is **not** dispatched (left to explosions' rule);
      - `loadFromEdits` and `onChunkLoaded` queue; unloaded cells park;
    - `wouldIgnite`;
    - `onBlockChange` calls no hook;
    - `hintFor` and `probe` strings for every part (the hint strings also feed D's no-bare-R test); `overlays` contents;
      `interact` and `hold` per part; `pocketSend`; `setEnabled(false)` freezes everything.
  - **`circuitsBudget.test.js`** (like `physicsBudget.test.js`): a fake clock advancing per visit stops starting networks
    after 2 ms; `stats().ms` comes from `hooks.now`; an 8192-cell relay oscillator stays within the budget per tick.
  - **`explosions`:**
    - the new messages;
    - `igniteInPlace`: 0.25 s by default, 3 s for `ignite` and the campfire rule, no entity, quiet on a burning keg;
    - `snuff`: keeps the keg, unhangs a hung one;
    - `onCharge` is called for each charge in a blast's reach, from the scan loop, and the charge cell is never written;
    - a charge is blast-proof otherwise;
    - `cancelEvent` skips kegs for which `ignitesAt` holds;
    - the rest of the existing suite stays green; the tests that pinned the campfire → entity path now expect a timer in
      place.
  - **`storage`:**
    - every row of §6.4;
    - the fields are absent unless given; round trips;
    - the key order with survival's fields present (use a literal object);
    - rename, duplicate and migrate keep the fields.
  - **`commands`:**
    - every command against the fakes; `radio 3` and `radio 400m`;
    - the `ignite` dispatch and its fallback;
    - `give black_hole`; the `blast_barrel` alias;
    - the table invariants (unique names; `usage` starts with the name).

### C — Circuit look and sound
- **Owns:** `src/circuitTiles.js` (from K0 onward), `src/circuitGeometry.js` and `src/circuitRenderer.js` (new),
  `src/circuitSounds.js` (new), `src/audio.js`, `src/atlas.js`. The tests `circuitTiles.test.js`,
  `circuitGeometry.test.js`, `circuitRenderer.test.js`, `circuitSounds.test.js` (all new) and `atlasIcons.test.js` (new).
- **Interfaces:** §1.4, §1.5, §2.11, §3.5, §4.11, §4.12, §6.2.7–§6.2.9, §6.2.11.
- **May stub:** a fake `geometryView` and fake overlay item lists. It does not need B's engine.
- **Tests:**
  - **Tiles.**
    - Every `CIRCUIT_TILE_NAMES` entry has a recipe, `CIRCUIT_RECIPES` holds exactly those names plus `barrel_side` and
      `barrel_top`, and the output is deterministic.
    - `CIRCUIT_CLEAR` is all alpha 0.
    - The flat pictures have alpha-0 corners and at least 40 opaque pixels.
    - The cabinet tiles and both keg tiles are alpha 255 everywhere.
    - All 37 tiles differ pairwise, and `barrel_side` differs from its old painter's output.
    - **No collapsar or circuit tile has an opaque pixel with a hue of 250–300°** at saturation above 0.15.
    - `barrel_top` has no ember-coloured pixels.
  - **Geometry.**
    - Segment and knob counts and endpoints for a straight run, a T, a six-way star, a riser (a tube), a wire under a
      device, and earth-wire stripes with a clamp only on a grounded cell.
    - **No terminal dots**; the knob count equals the number of signal-wire cells.
    - The fuse kink is identical on every rebuild and within ±0.06; a one-join fuse cell has a frayed end.
    - The binding posts of relays, timers and coherers on their input faces.
    - The range filter.
    - `overlayPose` for each type: blade angles, the hand angle as `left / s`, the plunger travel, the bulb, the trembler
      jitter, glow sizes, the linstock's lean, and `char` covering the burnt fraction.
  - **Renderer** (stub three):
    - 1 segment mesh, 1 knob mesh and 9 overlay meshes; instance counts; `frustumCulled === false` on all;
    - **no `PointLight` is ever added**;
    - dispose; prewarm.
  - **Sounds.**
    - Every recipe fits the schema; `bhImplode`, `bhDrone` and `bhCollapse` each have a layer at or above 100 Hz.
    - `playRecipe` and `startLoop` exist and never throw with a stub AudioContext. They are no-ops while muted, and the
      voice limit holds.
  - **Atlas.** For `icon: 'flat'`, a fake 2D context sees exactly one `drawImage` of the top tile and no side faces; prism
    icons are unchanged.

### D — Screens: the picker, the device panel, the HUD and menus
- **Owns:** `src/pickerModel.js`, `src/pickerUI.js` and `src/devicePanel.js` (new); `src/menus.js`, `src/hud.js`,
  `index.html` and `src/styles.css`. The tests `pickerModel.test.js` and `devicePanel.test.js` (new, pure helpers only),
  `styles.test.js`, `worldsMenu.test.js` (the controls sheet, if it is pinned there) and `trees.test.js`'s `menus.js`
  import (it must still resolve).
- **Interfaces:** §4.9 (the CONTROLS_SHEET rows; the hints are B's and main's), §4.10, §5, §6.2.14–§6.2.17.
- **May stub:** a demo `DevicePanelView` for `?ui=device`, and fake part tips through `circuitParts` (K0 is real).
- **Tests:**
  - §5.10, including the no-bare-R test over B's hint samples (a fixture list until B lands);
  - `devicePanel.panelFields` for each kind (the push button's `NO | NC`, the receiver's `Pulse | Latch`, the wavelength
    dial's labels and the distress mark), and `clampSetting`;
  - `hud`'s flash overlay: the 1/32 quantisation and **`flashStep`** (the 0.75 cap, at most one start per 0.5 s, the
    decay);
  - the `menus` pause switches: halves, `aria-pressed`, callbacks only from the inactive half, `.hex-button` and no
    `.mc-button` (worldsMenu-style fake elements);
  - **the picker keeps its public API**: `showPicker`, `hidePicker`, `isPickerOpen`, `onPickBlock(id, slot)` and
    `onPickerClose`.

### I — Integration (last)
- **Owns:** `src/main.js`, `src/diagnostics.js`, `src/CONTRACTS.md` (§50–§58 and the amendments, §6.8), `README.md` and
  `docs/*` (KNOWN-ISSUES entries — among them thin parts blocking water, and the `world.js` re-mesh cost if survival A has
  not added the fast path — plus this document's deviations).
  - The version bump: `config.VERSION`, `package.json`, `package-lock.json`, the title footer in index.html, and
    `wave0.test.js`'s version line.
  - `tests/integration/harness.test.js` and `boomUndo.test.js` (its strings), plus the new
    `tests/integration/circuits.test.js`.
- **Delivers:** §4.9, §6.6, §6.7.
- **Tests:**
  1. **`circuits.test.js`.** A real `World` (as `physics.test.js` does), `BlockPhysics`, `BlackHoles` and `Circuits`, wired
     exactly like main's hooks, with the §4.14 layouts cell for cell:
     - the timed charge (example 2) all the way to a vortex: phases, the eaten records and infall items appearing;
     - the quarry (example 4): the 6 kegs merge into one blast 0.25 s after the plunge, and its undo restores the kegs
       and gives the igniter back with defaults;
     - the quarry wired to a battery through a closed switch instead: undo restores **no** keg or fuse beside the still
       powered igniter (§3.6);
     - the radio (example 5) across 100 cells, with the keg targeted while sending;
     - the fuse and linstock (example 6), booming at about 8.25 s;
     - save → `serializeSave` → `deserializeSave` → reload: the parts, switches, a hold-latched timer, a latched coherer
       and a repeat clock are restored, and a burning fuse is not;
     - **settling**: save with an energised NC relay guarding Battery → Igniter → keg; reload; the keg is not lit;
     - an old v0.8 save with `BLACK_HOLE` edits and hotbar 66 loads as a vortex, with the slot holding the charge.
  2. **Harness.**
     - The R key on a keg does not light it, and logs the explanation once; with a Spark Transmitter selected it sends.
     - Right-click on a knife switch toggles it and places nothing.
     - **Holding right-click for 1 s on a knife switch toggles it once and places nothing.**
     - Holding right-click on the doorbell's button for 2 s rings the bell for 2 s.
     - Shift+right-click places against a switch.
     - A left-click on a keg burning in place (lit by `ignite`) snuffs it and keeps the keg.
     - The Shift+R key on a timer opens `STATE.DEVICE`. In Creative the world is frozen and a console-less `setblock` of the
       timer's cell (through the debug handle) closes the panel; in Survival a blast removing the timer closes it.
     - Survival's harness expectations still hold.
  3. **Smoke** (Windows Chrome from WSL2, per the project's notes):
     - `?scene=vortex`: screenshots of the flash, the implosion and the vortex, from the ground and from above (the lensed
       band and the disk arms);
     - `?scene=circuits`: the lamp lit, the doorbell, the timer dial, the knob-and-tube wiring;
     - `?ui=picker` with the Circuits section and the Radio drawer open, and a search for "torch";
     - `?ui=device`.

     Kill every spawned browser and server afterwards.

=====================================================================================================================
## 8. What our blocks need in Survival (for survival's later build)

### 8.1 New materials (item keys; stack 32 unless noted)
| Key (name) | Source | Why it is real |
|---|---|---|
| `pyrite` (Pyrite) | COAL_ORE drop, p 0.25, `natural` | Pyrite ("fool's gold") nodules are common in coal seams |
| `sulfur` (Sulfur) | Kiln: `3 pyrite + #fuel → 2 sulfur` (25 s) | Roasting pyrite drives sulfur off (FeS₂ → FeS + S). This was the main sulfur source before volcanic imports |
| `selenium` (Selenium) 16 | Kiln: `6 pyrite + 2 #fuel → 3 sulfur + selenium` (40 s) | Berzelius discovered selenium (1817) in the residue of sulfuric acid made from pyrite |
| `saltpetre` (Saltpetre) | STONE drop with a pick, p 0.06, `natural`, **only at y ≤ SEA_LEVEL − 14** (a new `deep` condition in `harvest.rollDrops`) | Cave saltpetre: nitrate crusts on cave walls. Mammoth Cave was mined for it in 1812 |
| `black_powder` (Black Powder) | Work Stump: `6 saltpetre + sulfur + charcoal → 6 black_powder` (hammer ≥ 1, 8 s) | 6 : 1 : 1 is close to the classic 75 : 15 : 10. It is ground damp in a mortar, which is why it cannot go off at the stump |
| `carbon_filament` (Carbon Filament) | Kiln: `3 plant_fibre + #fuel → 3 carbon_filament` (15 s) | Swan's carbonised cotton thread; Edison's carbonised bamboo |
| `iron_filings` (Iron Filings) | Work Stump: `wrought_iron → 6 iron_filings` (hammer ≥ 4, 6 s) | Filed iron, the coherer's filling |

### 8.2 Recipes for every new block
Every recipe follows survival §7.2. No block-making recipe takes 4 or 9 of any one input.

| Block | Station | Inputs → output | Tools | s |
|---|---|---|---|---|
| Powder Keg (`powder_keg`) | stump | 6 black_powder + 3 #planks + copper_ingot (hammered into hoops) → powder_keg | axe ≥ 1, hammer ≥ 3 | 8 |
| Powder Fuse | hand | black_powder + 3 cord → 6 powder_fuse | | 4 |
| Linstock | hand | 2 stick + 2 cord + saltpetre → linstock (the slow match is cord soaked in saltpetre) | firestarter ≥ 0 | 3 |
| Copper Wire | stump | copper_ingot → 3 copper_wire (hammered and drawn) | hammer ≥ 3 | 6 |
| White Wire | hand | 6 copper_wire + 6 plant_fibre → 6 white_wire (fibre braid) | | 5 |
| Brown Wire | hand | 6 copper_wire + 6 plant_fibre + acorns → 6 brown_wire (an oak-tannin dyed braid) | | 6 |
| Earth Wire | hand | 6 copper_wire + 6 plant_fibre + malachite → 6 earth_wire (green braid) | | 6 |
| Terminal Board | stump | #planks + 3 copper_wire + copper_ingot → terminal_board | knife ≥ 2 | 6 |
| Voltaic Battery | stump | 6 copper_ingot + 6 tin_ingot + 6 plant_fibre + pot_seawater → voltaic_battery + clay_pot (12 copper–tin pairs, brine-soaked fibre) | hammer ≥ 3 | 12 |
| Battery refill | stump | voltaic_battery (any charge) + 3 tin_ingot + pot_seawater → voltaic_battery (full) + clay_pot (*the tin is the fuel*) | hammer ≥ 3 | 8 |
| Blasting Machine | forge | 2 steel_bar (magnetised; folded into the recipe) + 12 copper_wire + 3 #planks + stick → blasting_machine | hammer ≥ 5 | 30 |
| Selenium Panel | hand | selenium + glass + 3 copper_wire + #planks → selenium_panel | | 8 |
| Knife Switch | stump | 3 rock (slate base) + copper_ingot + 2 copper_wire → knife_switch | hammer ≥ 3 | 6 |
| Push Button | stump | rock + bronze_ingot + 2 copper_wire → push_button | hammer ≥ 3 | 5 |
| Clockwork Timer | forge | steel_bar (spring) + 3 bronze_ingot (wheels) + glass + 2 copper_wire + #planks (case) → clockwork_timer | hammer ≥ 5 | 30 |
| Relay | stump | wrought_iron + 6 copper_wire + #planks → relay | hammer ≥ 4 | 10 |
| Igniter | kiln | clay_lump + wrought_iron + 2 copper_wire + #fuel → igniter (an iron bridgewire in fired ceramic) | | 15 |
| Filament Lamp | bloomery | glass + 3 carbon_filament + copper_wire + #planks → filament_lamp (sealed hot) | | 20 |
| Electric Bell | forge | steel_bar (the gong) + relay + #planks → electric_bell | hammer ≥ 4 | 15 |
| Spark Transmitter | stump | relay + 12 copper_wire + 2 bronze_ingot + voltaic_battery → spark_transmitter | hammer ≥ 3 | 15 |
| Coherer Receiver | stump | glass + 6 iron_filings + relay + 2 copper_wire → coherer_receiver | hammer ≥ 3 | 12 |
| Collapsar Charge | — | **Creative only**: no recipe. *Nothing real makes one.* A Creative-placed charge broken in Survival drops its item, so it can be used there | | |

### 8.3 Survival rules for our blocks
- **`BLOCK_RULES` rows:**

  | Blocks | Time | Tool | Tier | Drops |
  |---|---|---|---|---|
  | the four wires, POWDER_FUSE | 0.2 s | — | 0 | self |
  | LINSTOCK | 0.3 s | — | 0 | self |
  | TERMINAL_BOARD, RELAY, BLASTING_MACHINE, SPARK_TRANSMITTER, CLOCKWORK_TIMER, FILAMENT_LAMP | 1.0 s | axe | 0 | self |
  | VOLTAIC_BATTERY | 1.0 s | axe | 0 | self, **with `d` = its charge** |
  | KNIFE_SWITCH, PUSH_BUTTON, ELECTRIC_BELL, IGNITER | 1.2 s | pick | 0 | self |
  | SELENIUM_PANEL, COHERER_RECEIVER | 0.6 s | — | 0 | self |
  | COLLAPSAR_CHARGE | 1.5 s | pick | 0 | self |

  POWDER_KEG keeps the BLAST_BARREL row.
- **Battery items** carry their charge as `d`: stack 1, maximum `BATTERY_CAPACITY`.
  - This needs survival's `ItemDef` to allow a `durability` on a block item, not only on tools.
  - Placing writes `c = d` into the store; breaking reads it back.
- **The R key on a fuse** lights it only with a `fire_drill` in the pack (1 wear). The hint is
  `Powder Fuse · needs a Fire Drill (R key)`.
- **The R key and RMB** follow §4.9: circuits join survival's hit-based `interactKind` steps, the keg explanation moves to the
  last step, `survivalRight` gets the `isControl` check and the control latch, and `survivalLeft` snuffs a keg burning in
  place.
- **Item key aliases** in survival's pack validation (`items.js`): `ITEM_ALIASES = { black_hole: 'collapsar_charge' }`
  always (*removing BLACK_HOLE from PICKER_ORDER drops it from `ITEM_KEYS`*), plus `blast_barrel: 'powder_keg'` if survival
  ships before the keg rename.
- **Unchanged rules.** A swallowed player dies (survival §2.4); a keg blast deals `blast` damage. Neither changes.
- **Data closure** (survival's I-1). Every new material above has a source and a use: pyrite → sulfur and selenium;
  saltpetre → black powder and linstock; black powder → keg and fuse; selenium → panel; carbon filament → lamp;
  iron filings → coherer. Acorns, malachite and the ingots are survival's own.

=====================================================================================================================
## 9. Originality

| Element | Closest existing game | How ours differs |
|---|---|---|
| Electrical model | Minecraft's redstone power: a source seeds 15, each block subtracts 1 whatever is connected, and one line powers any number of blocks at full strength | **Ohm's law**: the drop per wire cell is current × resistance, so adding loads dims every load on that wire, and an idle wire reads the full source voltage. A single wire with earth return: nothing works without earth. Volts, amps and a discharge curve are things you measure |
| Wire drawing | Redstone dust: a flat floor strip to each joined side, with a dot at ends and junctions | **Knob-and-tube wiring** (1880–1930): a porcelain knob in every cell, the wire strung between knobs at knob height, porcelain tubes for risers, no dots. The fuse is a kinked hand-laid cord |
| Wire colours | Terraria's red/blue/green/yellow wires; Factorio's copper cable with red and green wires; RedPower 2 / Project Red insulated wire joined through a junction | Bare copper, **brown** and **white** cotton braid (today's live colour and old cloth wire) and a green-and-yellow earth that does a different job. No red, blue, green or yellow signal wire. Colours join only on a **Terminal Board** of brass binding posts |
| Junction | Terraria's Junction Box | The Terminal Board, a real board of binding posts; it joins every colour |
| Timers | Terraria's 1-, 3- and 5-second timers | A walnut-cased Clockwork Timer with any delay from 0.5 s to an hour, presets like a time-switch dial (5 · 10 · 15 · 30 s · 1 · 5 min), pulse, hold and repeat |
| Detonator | Terraria's Detonator; the cartoon box with a red band | The Blasting Machine: a varnished oak rack-bar magneto with a brass plate, 24 V for one second, never driven by a circuit |
| Explosive | Minecraft's TNT: a red lettered block that becomes a swelling, pushable entity | The Powder Keg: a copper-hooped staved keg with a burnt-in brand, **never lit by hand**, that burns where it stands and goes off when the flame reaches the powder; chain blasts merge (§37) |
| "Torch" | Minecraft's torch and redstone torch (light, inverter, power source) | The Linstock: a full-height leaning staff with a serpent-head fork holding the match sideways, no flame and no light. It lights powder and nothing else |
| Inversion | The redstone-torch NOT gate | A relay's normally-closed contact, or an NC push button, as real control panels do it |
| Repeater | Minecraft's repeater (a diode with a 1–4 tick delay and locking) | The Relay: galvanic isolation, a local battery restores the voltage, NO/NC, a hand-push test lever. Delays come from a Clockwork Timer counted in seconds. The input face shows two brass binding posts, not an arrow |
| Comparator, observer, hopper clocks | Minecraft | None |
| Lever and button | Minecraft's lever and stone or wood buttons | A Knife Switch (a visible copper blade on slate) and a brass Push Button, NO or NC, closed for as long as it is held |
| Lamp | Minecraft's Redstone Lamp and Copper Bulb (a glass-and-metal block that lights) | An opaque oak cabinet with a porcelain top, carrying a clear pear-shaped glass bulb with a hairpin carbon filament |
| Bell | Minecraft's gold Bell | A steel gong on a dark-oak backboard with a visible trembler: an electromagnet pair and a striker arm |
| Clockwork | Create's brass casing and visible cogs | A walnut case with a winding arbor and keyhole; no circuit part shows gears |
| Fuse trail | Cartoons and Bomberman fuses; Minecraft has no placeable fuse | Bickford's safety fuse: it branches to all 8 hex neighbours, burns at a fixed stated speed, survives water and is used up |
| Radio | "Wireless redstone" mods (numbered frequencies) | Marconi's spark transmitter and a coherer receiver, tuned by **wavelength** (300–1050 m, with the 600 m distress wavelength). A wave can only close a coherer; a tap opens it. A pocket key works from the hotbar |
| Daylight sensor | Minecraft's Daylight Detector (a gridded plate, power 0–15) and its dusk-lamp build | A Selenium Panel: six round selenium discs under gold leaf in a hex rosette, no grid, 0–3 V that needs a relay to switch anything. It teaches photovoltaics |
| Black hole | Black-hole blocks in mods (instant, spherical suction); Avaritia's Gaping Void; Minecraft's violet portal particles drifting inward | Placed dormant as a Collapsar Charge and set off from afar. ARM → FLASH → IMPLODE → VORTEX in a **blackbody palette** (soot, deep red, white-hot; no violet), a two-arm dark spiral disk whose dashes stream inward, a lensed far side and a beamed photon ring, blocks visibly spiralling in along the same spiral, and a hex eating ball |
| Creative inventory | Minecraft Java's tabbed square grid with a search tab; **Bedrock's** category column with collapsible groups that expand in place in a square grid (+/−) | A honeycomb with sticky sections and a hex section rail that **scrolls** to a section (never switches pages); a family opens as a separate honey **drawer band** below its row (members never flow inline), shown as a fan of three icons with a count badge; no +/− glyphs; drag-to-hotbar, slot badges, and aliases such as "torch" |
| Pause-menu switches | Minecraft's grey toggle buttons | Survival's two-segment honey `.hex-button` switches |
| Multimeter | Probe items in tech mods | The crosshair reads volts on any wire, with no item, and names a miswired part |
| Tick | Minecraft's 0.1 s redstone tick and 1-tick repeater | A 50 ms circuit tick, close to a real relay's operate time |

**Names.** Every name is real history or craft: Linstock, Powder Keg, Black Powder, Powder Fuse (safety fuse), Knife Switch,
Push Button, Clockwork Timer, Relay, Voltaic Battery, Selenium Panel, Blasting Machine, Spark Transmitter, Coherer, Filament
Lamp, Terminal Board, Brown Wire and Earth Wire. "Collapsar" is the astronomers' 1960s word for a black hole. Nothing is named
after another game's item list.

=====================================================================================================================
## 10. Not in v1, and why
- **Short circuits and overcurrent heating** (and a lamp burning out above 9 V). These need wire–earth contact rules, a
  per-wire current and a broken-part state. *The connection rules make a short impossible, which keeps the first model
  simple.*
- **Lamps that light their surroundings.** There is no block-light engine (CONTRACTS §5, glowstone). **Planned follow-up**:
  the nearest 4 among lit lamps and campfires share the 4 pooled campfire PointLights (lamp intensity 3·b, range 10, colour
  #ffd27a), which needs one optional `extraLights` argument on `campfireRenderer.sync`. *That file is survival F's while F
  changes `sync`'s signature, so it waits for both to merge; no new light, so no shader key changes.* Pitfall 35 then gains
  "lamps borrow the campfire pool".
- **Sensors:** a railway treadle (step-on) and a tripwire. *Runes already offer step-on; a circuit sensor is the natural next
  part.*
- **Wires on walls and ceilings.** A wire always sits on the floor of its cell (and rises through tubes). Side-mounted runs
  need per-cell orientation.
- **Thin parts popping off** when their floor goes: by design they hang (*a wire strung across a gap is real*). Survival's
  `isPopOff` could add it with one line in blocks.js if play-testing wants it.
- **Thin parts and water.** A cell holds one id, so a wire, fuse or linstock cell blocks water like any block (a copper wire
  dams a stream). Water flowing into such a cell would destroy the part, which is worse. Listed in KNOWN-ISSUES.
- **Tumblers, burning kegs and debris feeling the vortex.** `fallingblocks.js` belongs to survival's package A.
- **Vortex growth and Hawking evaporation.** A hole that changes on its own would surprise builders.
- **Circuits triggering Rune Blocks** (a `power` rune trigger). Runes can already drive circuits through commands; the
  reverse needs a rune-editor checkbox.
- **The transmitter's cell running down; recharging batteries; a linstock burn time.**
- **Saving burning fuses, running pulse/hold countdowns, relay energisation or radio in flight.** These are transient, like
  keg fuses; settling (§4.7) rebuilds them without firing anything.

=====================================================================================================================
## 11. Decisions

### 11.1 Product decisions (the points the user may want to change)
1. **"Torch" is the Linstock.** It is the real igniter of black powder, and it respects survival's no-"torch" rule (its §11).
   Searching "torch" finds it.
2. **BLACK_HOLE is no longer placeable**, and the picker gives the Collapsar Charge. Old holes stay active; old hotbar slots
   become charges; `setblock … black_hole` still makes an instant vortex, with the flash.
3. **The R key no longer lights kegs or charges, and nothing lights a keg by hand.** Right-click operates controls;
   Shift+right-click places against them; the R key also operates controls, lights fuses, pushes relay armatures, taps
   coherers, runs runes and sends the pocket key. Every hint names the key or the button in full.
4. **Kegs burn in place.** A fuse, linstock or igniter sets one off 0.25 s after the flame reaches it; a campfire or `ignite`
   gives 3 s, and a left-click pinches that fuse out.
5. **A vortex is permanent until broken.** There is a per-world `blackholes` switch, and circuits cannot switch a vortex off.
6. **The picker is restyled in the survival honey palette.** Survival §11 left this to the user; this request is the user
   asking for the inventory redesign. Only the picker changes; the pause menu gains survival-style switches beside
   survival's own.
7. **The Collapsar Charge is Creative-only in Survival.** No real-world recipe exists. *An endgame recipe (diamond block,
   obsidian, black powder) is easy to add if the user wants one.*
8. **Contracts start at §50**, because survival v2 owns §42–§49.
9. **Electrical devices must stand on the ground, or touch a grounded Earth Wire.** This is the real single-wire telegraph
   model. On the ground it is invisible; on wooden floors or sky platforms the hint says what to do. *Rejected: no return
   path at all (not accurate); two-wire circuits (twice the wiring for every device).*
10. **Ohm's law, counted in whole amps.** The drop per wire cell is 0.0625 V per amp, the current rounded up to a whole amp.
    *Exact half-amp steps would need a 0.03125 V unit and twice the buckets for no visible gain.*
11. **Batteries run down:** 3600 amp-seconds, about an hour of one lamp, tiring below 25 %. They stack into piles of up to 4.
    There is a Creative "Refill" button and a Survival refill recipe.
12. **The keg's code keeps `BLAST_BARREL`** as an alias of `POWDER_KEG`. *This avoids churning files that survival owns.*
13. **The fuse burns at 2.5 cells/s**, faster than life, and its tip says so.
14. **A blast sets off a Collapsar Charge** rather than destroying it. Swallowing one only removes it.
15. **Renamed parts**: Red Wire → Brown Wire, Junction Box → Terminal Board, Selenium Cell → Selenium Panel (it is six cells
    in series). Coherer toggle mode → latch mode.

### 11.2 How the three reviews were resolved
Every must-fix is applied. Every should-fix is applied. The nice items are applied except one (below). Where the reviews
disagreed:
1. **The current-dependent drop.** Realism proposed `L = min(4, ⌈Σ draw⌉)` at 0.0625 V per unit; originality proposed a
   separate `amps` table at 0.125 Ω. Merged: **one quantity, `amps`, is both a load's share of the wire drop and its battery
   drain** (*physically the same current*), at 0.0625 Ω per cell, counted in whole amps; realism's reach table holds exactly
   (72 / 56 / 24 / 24 / 168 cells). Realism's **cap of 4 is not applied**: *it is not physics, and the lesson "too many lamps
   on one wire go dark" is the one we want; separate runs fix it.* Originality's "two lamps" example became the
   three-lamp example 9.
2. **The solver's first cell** (technical) and the Ohm's-law change land together: every wire cell, the first included,
   drops `w` units.
3. **Keg ignition.** Realism wanted 0.25 s in place for circuit flames but kept the 3 s entity for the campfire and
   `ignite`; originality wanted every keg to burn in place with no entity. Merged: **every path burns in place** (no
   swelling entity in play), 0.25 s for fuse, linstock and igniter, 3 s for the campfire and `ignite`, with originality's
   left-click snuff. The entity code stays for its tests.
4. **A lamp against a battery.** Technical suggested "beside a battery, both on the ground, lights"; realism (must-fix)
   said devices never join directly. **Realism's rule is applied**: it removes the Dusk lamp's hidden path and a special
   case from the solver.
5. **Selenium's look.** Realism wanted radial gold-leaf fingers; originality a round disc under gold leaf with no grid.
   Merged: **six round discs under gold leaf in a hex rosette**, which is Fritts' method, shows the six cells in series,
   and avoids a grid.
6. **The keg's hoops.** Realism's recipe used split-wood hoops; originality's tile used copper. **Copper** in both (its tip
   says copper or wood).
7. **The screen-flash gap.** Realism 0.5 s, technical 0.4 s: **0.5 s** (at most 2 flashes a second).
8. **The repeat timer.** Realism's and technical's closed-time rules agree; written in ticks.
9. **The tick.** Originality's 0.05 s tick (nice) is applied together with technical's budget: **6000 visits and 2 ms per
   tick**, checked between networks, with BFS through the index.
10. **Quarry kegs.** Technical said 8, realism 6: **6** (the bottom is the earth and one face carries the wire).
11. **The swirl and the escape rule.** Realism's 1.6 is applied, and technical's escape wording is re-measured for 1.6 with
    the real `stepPlayer`: steering away escapes from 1.5 units in every mode; a fixed heading escapes from 3.
12. **Settling** (technical, for loads) is extended to networks that span an unloaded chunk (frozen until whole). *Otherwise
    walking away until a coil's battery unloads would fire the same dead-man circuit.*
13. **Undo's ignitable check** (technical, for kegs) is extended to fuse cells, which a restored linstock would relight.

**Not applied:**
- **Lamps lending the campfire PointLights** (realism, nice). Deferred, with the exact plan in §10: it needs an edit to
  survival F's `campfireRenderer.sync` while F is changing that signature, and it would be the only reason for package C to
  wait on survival F.

**Rejected designs:**

| Rejected | Why |
|---|---|
| Block ids per state (switch on/off and so on) | Re-meshing; pitfall 32 |
| A per-cell metadata byte | The chunk format change would ripple through world, storage and mesher |
| Running circuits on BlockPhysics rings | `CellRing` assumes one delay per ring, and `blockphysics.js` is survival A's file |
| Power levels 0–15, or a fixed drop per cell | Minecraft's model, and it is not physics |
| Glowing wires, floor strips with dots | Redstone's look, and not real |
| Screen-space lensing | A full-frame copy every frame |
| A second fallingRenderer for infall | One more light in every shader key |
| A two-layer flow-map disk | It made the arms stream outward and pulse; stationary arms with inward dashes are exact and cheaper |
| Toggle-mode coherers, R-key NO/NC flips | Not how the real devices work (§4.6) |

=====================================================================================================================
## 12. As built (v0.10; the integrator's notes)
The normative description is now `src/CONTRACTS.md` §50–§58. Where the build differs from this document:
- **Torch** for Linstock everywhere (the user's decision at the top).
- **Pitfalls** §6.8's 32–37 are CONTRACTS pitfalls 33–38 (survival had taken 32).
- **Overlays.** `OverlayItem.a / .b` follow circuitGeometry's header (C), which the engine (B) now emits: blade a = closed,
  cap b = NC, plunger a = travel (0 cocked), a keg's bung glow b = `FUSE_AT_BUNG` 8.
- **Hooks.** `igniteKeg(q, y, r, fuse)` forwards the fuse (`ignite` keeps its 3 s keg); `chargeArming` is a new hook
  (`blackHoles.isArming`) for the `collapsing!` hint.
- **Undo's look-ahead** (§3.6): `circuits.wouldIgnite` solves the waiting dirty cells settling before it reads an igniter, so a
  restored igniter whose circuit survived counts as powered (§7 I's quarry on a battery and a closed switch; KNOWN-ISSUES C6).
- **The R key on a charge** says its own line (a charge also answers to the radio); the keg's is §3.3's.
- **Survival** (§8): every part has its harvest row and its recipe (25 recipes, 114 in all), the 7 materials have icons, and
  `pyrite` / `saltpetre` drop as §8.1 says (`deep` is a new drop flag). Not yet: a battery's charge as item durability and the
  refill recipe (KNOWN-ISSUES C3). In Survival, R on a part is interactKind step 7b (`circuit`, or `fuse_hint` without a Fire
  Drill) and the pocket key step 10b; right-click's control latch sits at the top of `survivalRight`.
- **Scenes.** `?scene=circuits` builds four rows: §4.14 examples 1, 2 (with a keg), 10 with one key, and 7.
- **A–D's adjudicated CONTRACT-ISSUEs** (vortex shader tuning, extra import edges, the device panel's atlas argument, the snuff
  overload and the rest) are recorded in CONTRACTS §50–§57.
