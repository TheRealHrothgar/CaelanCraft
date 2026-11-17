# Caelancraft — Characters, creatures and plants: the hex-faceted look (DRAFT v1, 2026-11-16)

## 1. Why

The user: "The characters, mobs, and NPCs are too blocky (and dare I say, Minecraft-y). This isn't a clone of Minecraft and
I want richer details and textures while sticking to simplified affine geometric spirit of Caelancraft. This a big
refactor touching pretty much everything: avatars, mobs, creatures, plants, etc." And: "the hand that is shown outreached
as well needs to be more subdued and slightly more world realistic with equipped tooling and actions on display (but not
ostentatiously so)."

Today every avatar, zombie, animal and plant is a few boxes wrapped in pixel art at 32 texels a metre (plants 16): the
cube silhouette and the chunky pixels are what read as "Minecraft".

## 2. Decisions (taken with the user)

- **Style A, hex-faceted, everywhere.** An art-direction pilot (`gallery.html`, `src/modelKit.js`, `src/paintKit.js`,
  `src/pilotModels.js`) compared today's models with two shape languages over the same painted textures: A hex-faceted
  and B soft-chamfer. The user chose A for everything: limbs, torsos and animal bodies are tapered **hexagonal columns
  with flat facets**, joined by chamfered pieces, with wedges and hex pyramids for noses, ears, snouts, horns, tails and
  hair locks. It is the honeycomb world's own shape language, brought to its creatures.
- **Before rollout**, a second pilot pass fixes the three weak spots the user named: heads less boxy (a faceted head
  loft: cranium, cheeks, jaw, a front face plane), better hair (layered, swept, faceted locks per avatar), plants less
  like boulders (whorls and tiers of faceted leaf cards with gaps, not solid lumps).
- **Richer textures, still painted in code.** No assets are downloaded. Textures are painted by `paintKit.js` at about 3×
  today's density (bodies 96 px/m, faces 160 px/m), with soft top-down shading, baked shadow toward joints, cloth weave,
  denim, knit, fur and wool strokes, bark, leaf veins, seams, hems and stitching; faces with irises, catchlights, brows and
  a soft mouth. Linear filtering with mipmaps (not nearest).
- **Pilot passes 2–3** (`gallery.html?row=hair|head|plant`): heads are faceted lofts with a front face plane; hair is
  silhouette-first — Caelan a poofy faceted MASS (never locks: "his actual hair is poofy"), the others a scalp cap plus a
  few big clumps that flow one way. The user's picks: **Caelan C2 tousled** (a taller mop, higher at the front), **Brayden
  B1 side sweep**, **Annabelle A1 long waves**. Caelan's skin is a mild olive (light #ead0b0, mid #dab894), not tan;
  shaded facets stay warm (a small warm fill), never grey. Plants are branches carrying tiers of hexagonal leaf cards with
  gaps and a lower skirt; past ~16 m a cheap leafy version (~236 tris), never a ball.
- **Kept:** fun, readable and cheerful; zombies spooky without being frightening (people-like, narrow eye slits in
  sunken hollows, no gore, nothing red); the joints and animations of today's rigs; the gameplay sizes (colliders,
  eyes, reach) — only the look changes.
- **The first-person hand** is smaller and lower in the view: a sleeve cuff and a real hand (palm, thumb, curled
  fingers) gripping the tool; the action is a wrist-led chop driven by the existing swing, visible but quiet.

## 3. The kit

- `modelKit.js` (PURE, typed arrays): n-gon prisms and lofts (6 sides by default; elliptical; taper and shear per ring;
  flat facets), chamfered boxes (box UVs), wedges and pyramids, transforms, merges. Every part is a closed, outward-wound
  mesh.
- `paintKit.js` (PURE, RGBA): seeded painters and a padded atlas packer; one 256×256 atlas per model.
- One geometry per bone over one atlas: each family keeps its rig and hangs kit parts from its joints.

## 4. Budgets

| model | today | hex-faceted (pilot) |
|---|---|---|
| an avatar | 180 tris, ~9 draws | ~1,600 tris, 1 draw per bone group, 256² atlas |
| a zombie | 108 tris | walker ~1,230, runner ~1,290, alpha ~1,300 tris (phase 2, done): instanced per part, 5 draws a kind; a 256² atlas + glow each |
| the Watcher | ~500 tris, block-atlas tiles | ~830 tris, its own 256² stone atlas + glow (phase 2, done) |
| an animal | ~200 tris, colours per vertex | shipped (phase 3): 426–788 tris a whole animal (the fish 134), every kind and the pig on ONE shared 1024² atlas, 1 draw per part group (trunk, head, legs) |
| a bush in the chunk mesh | ~100 tris | ~1,100 tris near, today's model past ~16 m |
| a bush, as built (phase 4) | — | 1,224 near · 130 far (16–48 m) · 4 (crossed picture) beyond; the tussock 66 · 11 · 4 |
| the first-person hand | 608 tris | ~430 tris + the held slab |

The iPad matters: a crowd of zombies and a field of bushes are where the triangles add up, so zombies stay instanced
and plants get a level of detail.

## 5. Phases

0. **Pilot passes 2–3** (heads, hair, plants), reviewed and picked by the user. Done.
1. **Avatars and the first-person hand.** The three avatars' data grows hair, head and hand parts (`avatars.js`); the
   renderer builds them from the kit over a painted atlas; the chooser's portraits come from it; the held item (§98.4)
   sits in the new fist; remote players get the same models. Done (CONTRACTS §91, §98.4): `avatarModel.js` and `figureKit.js`
   build any avatar bone by bone; the first-person hand is `FP_HAND`; `avatarSkin.js` and the box models are gone.
2. **Zombies, the Watcher, the phantom.** Repainted atlases with the night-glow layer in step; instanced per part. Done
   (CONTRACTS §104): `zombieModel.js` builds the walker, the runner (leaner) and the alpha (bigger, heavier, a long coat)
   part by part from the kit — gaunt faceted heads with a heavy brow wedge over narrow slits, hair as a scalp cap on each
   kind's own skull plus a few clumps flowing one way (never a helmet or a crown of spikes), ragged painted clothes with
   see-through torn hems, a shirt tint marked in the atlas (on the cloth and on its night glow, so a crowd differs by night
   too), a glow image that is the atlas dimmed (clothes still read at night) with faint eyes that are never red, shining as
   at night wherever the sky does not reach; a pale hit flash, never red; `zombieRenderer.js` keeps its API, its
   instancing (one mesh per part and kind: a crowd of 24 is 15 draws, ~30k tris, ~0.1 ms of CPU a frame) and every pose.
   The Watcher (`watcherModel.js`) is chamfered hollow hex bands, a lantern round a faceted crystal and painted stone with
   glowing cracks; the figure at the edge of sight is a dark person-shaped shadow from the kit (sloping shoulders, arms
   clear of the body, a head with a plain mass of hair), drawn after every transparent effect. Screenshot aids:
   `?scene=zombies|crowd|watcher|phantom`.
3. **Pigs and animals.** Every species, sex, shorn, tame and young variant from the kit, textured. Done (CONTRACTS §69.1):
   `animalModels.js` builds the ten kinds of animals.js and the pig — hexagonal barrels whose rings swell and pinch,
   tapered legs with hocks, hooves, paws and trotters, faceted heads with a ridge down the nose and a painted muzzle,
   wedge and pyramid ears, swept horns, the ram's curl and the stag's antlers, manes, tails, feathered wings, the tom's fan,
   fins — over one painted 1024² atlas (hair strokes with direction, patches and spots, wool in lit puffs over a lumpy
   fleece that reads as six puffs end on, stubble, a bird's plumage of single overlapping feathers with a folded wing on
   each flank, scales). The heads graze while an animal stands idle and come UP while it stares at a crouching hunter (§100); the young
   are larger-headed and rounder (a fawn spotted); a tame cow, ewe, wolf or pig wears a collar, a bell or a ribbon; a
   snared one a loop of cord; the bull a ring in his nose. Lit like the avatars (the light volume and the warm fill).
   `?scene=animals` / `?scene=animal-variants` / `?scene=animal-close` stage them in the game for screenshots (the last the
   sheep and the birds up close); `gallery.html?row=fauna` lines
   them up through the game's own renderers.
4. **Plants.** Model plants in the chunk mesher with per-vertex atlas UVs and a plant atlas, with a level of detail.
   Done (CONTRACTS §105): every wild plant, picked plant, crop stage (a seedbed, and a sprout of each crop's own kind) and
   piece of ground litter is a kit model (`plantKit.js`, `plantModels.js`) painted from one 1024 × 256 plant atlas
   (`plantAtlas.js`: leaf veins, bark, berries with a bloom, petals, florets, spines), drawn in the chunk's cutout layer
   beside the block atlas (one material, a second sampler; light, fog and the per-cell turn kept). Each plant its own
   leaf and arrangement — shrubs of branches and twigs carrying sprays and whorls of hexagonal leaf cards with gaps and a
   skirt to the ground (no solid core: a ball of leaves was what the user rejected), fern and carrot fronds as cut-outs
   on bending strips, cattail spikes, flax stalks with blue flowers, daisies and thistle heads, an aloe rosette of thick
   wedges, faceted mushroom caps, faceted stones and sticks. Levels of detail per chunk by distance (16 / 48 m): the full
   model; the same recipe thinned to about a tenth for a bush (still leafy); the tile as two crossed pictures beyond;
   re-meshed on crossing a ring under a budget. `?scene=plants` and the dev page `plants.html` show them; the furniture
   (well, barrel, beds) keeps its box models for phase 5.
5. **Everything else that is a creature or a figure** (loose items, the campfire's cook pots if they read blocky,
   items in hand on the model) and a last pass on budgets on an iPad.

Each phase lands with its tests, screenshots in the gallery (Today | new) and a CONTRACTS section.
