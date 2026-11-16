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
| a zombie | 108 tris | ~930 tris (instanced per part) |
| an animal | ~200 tris, colours per vertex | ~320–470 tris, 256² atlas |
| a bush in the chunk mesh | ~100 tris | ~1,100 tris near, today's model past ~16 m |
| the first-person hand | 608 tris | ~430 tris + the held slab |

The iPad matters: a crowd of zombies and a field of bushes are where the triangles add up, so zombies stay instanced
and plants get a level of detail.

## 5. Phases

0. **Pilot pass 2** (heads, hair, plants), reviewed by the user.
1. **Avatars and the first-person hand.** The three avatars' data grows hair, head and hand parts (`avatars.js`); the
   renderer builds them from the kit over a painted atlas; the chooser's portraits come from it; the held item (§98.4)
   sits in the new fist; remote players get the same models.
2. **Zombies, the Watcher, the phantom.** Repainted atlases with the night-glow layer in step; instanced per part.
3. **Pigs and animals.** Every species, sex, shorn, tame and young variant from the kit, textured.
4. **Plants.** Model plants in the chunk mesher with per-vertex atlas UVs and a plant atlas, with a level of detail.
5. **Everything else that is a creature or a figure** (loose items, the campfire's cook pots if they read blocky,
   items in hand on the model) and a last pass on budgets on an iPad.

Each phase lands with its tests, screenshots in the gallery (Today | new) and a CONTRACTS section.
