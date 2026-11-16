# Caelancraft — Work that costs, hunting that rewards patience, and the wind (DRAFT v1, 2026-11-16)

The user (verbatim, 2026-11-16):

> I can't really tell the difference in terms of time/energy expended when mining dirt and wood by hand, with stone, or
> flint. Digging by hand should be a long, energy sapping process. Cutting a tree down with a stone axe should also be
> labor intensive and impact axe durability significantly. Flint is better, and so. The difference along each era should
> be noticeable and a strong motivator to level up.
>
> Fish seem to appear and disappear spontaneously in small pond or stream.
>
> Need a bow and arrow in the progression.
>
> Unclear how throwing a spear is supposed to work.
>
> Sneaking on animals: when you sneak up behind and the animal turns to face you, it should be less likely to spook if
> the player stays still.
>
> Also, I want to introduce line of sight and cover in the stalking process. Stalking works better when there's no line
> of sight.
>
> Let's also introduce wind direction and strength as a visual indicator. This affects stalking. Hunting upwind should
> confer a sneak penalty. It should also affect graphics (flag furling, rain direction, etc.) and can later affect
> sailing.
>
> Also, let's remove the option to craft 5x of items that don't stack in the inventory (hammerstone, tools, etc.)

## 1. Work costs time, food, water and the tool (the "eras")

- **Time.** Each era must feel clearly faster than the last.
  - Hand digging is slow: dirt by hand takes several seconds, not under one.
  - Felling with a stone axe is real labour: a log takes many seconds.
  - Flint is clearly better, and each later metal better again.
  - The tier speeds and the blocks' hardness are retuned together, and every number is tabled in CONTRACTS.
- **Energy.** Breaking by hand or with a crude tool drains nourishment and water faster, and adds fatigue, the more crude
  the tool (a bare hand most). It is felt in the vitals within a few minutes of digging.
- **Wear.** A tool loses durability per block in proportion to the block's hardness over the tool's tier: a stone axe
  fells only a few logs before it breaks; a flint axe several times as many.
- **Feedback.** The player can tell: the target hint names the cost ("Oak Log · slow with a stone axe"), working hard
  shows (breath, a status chip), and the handbook's tables say how much faster the next era is.
- **Making ×5** is offered only for outputs that stack; a tool, the hammerstone and anything with stack 1 makes one at
  a time.

## 2. Hunting

- **Fish belong to their water.** A pond's or a stream's fish stay in it: they are not created in view or removed in
  view. They appear only out of sight or underwater, and a water body holds no more fish than its size allows.
- **Throwing a spear is learnable:**
  - With a spear or a dart in hand, holding **Place** draws back: a draw ring, a slight steadying of the view.
  - Releasing throws, harder the longer you held, up to full.
  - The hint says so ("Hold Place to throw").
  - G still throws at once.
  - It works the same on a tablet: Place.
- **The bow:**
  - A bow is made at the Work Stump from a stave and cord. Arrows are a stick, a flint point and a feather, a few at a
    time.
  - Hold Place to draw and release to shoot, using arrows from the pack. A full draw flies far and fast.
  - Arrows can be picked up again, with a chance to break.
  - The bow wears. Damage sits between the dart and the spear, at much longer range.
  - The handbook and the build tree show it.
- **Stalking:**
  - **Stillness:** an animal that turns and looks at a crouching player who stays still grows suspicious, but does not
    bolt at once. It stares and settles if the player keeps still; any movement while watched spooks it.
  - **Line of sight and cover:** an animal that cannot see the player (terrain, trunks, leaves and tall plants between
    them) notices only by sound and scent, at a much shorter distance.
  - **Wind:** the player's scent travels downwind. Upwind of an animal (the wind blowing from the player to it) the
    player is noticed much farther away; downwind, a little nearer. It is scaled by the wind's strength
    (`wind.scentToward`).

## 3. The wind (`src/wind.js`, PURE)

- `windAt(seed, worldSeconds, shower)` → `{ dir, x, z, strength 0..1, speed m/s, gust }`. It is deterministic from the
  world's seed and clock, like the weather, so every player on a server feels the same wind with nothing on the wire.
- The prevailing direction wanders over game hours, the strength swells over minutes and rises in showers, and gusts
  come and go over seconds.
- `scentToward(wind, player, animal)` is +1 when the player is upwind of the animal, −1 downwind.
  `windFromWord`, `windWord` give the plain words ("a light breeze from the west").
- **Drawn:**
  - a small wind indicator on the HUD (direction and strength);
  - the rain slants downwind;
  - the campfire's smoke drifts downwind;
  - a craftable pennant on a pole streams out, flutters, or hangs limp with the strength.
  - Later, sailing.
