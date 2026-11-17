// Caelancraft — what each thing in the build tree is FOR (PURE). See src/CONTRACTS.md §77.
//
// One short line per tool, workplace and key part, shown beside its recipe in the Making panel: what it does and what it
// unlocks. The lines name the game's real gates (which ore a pick opens, which job a hammer is needed for), and the tests
// check each named gate against BLOCK_RULES and RECIPES, so a line cannot drift from the rules.

/** The longest a purpose line may be (characters): it has to fit one line of a recipe card. */
export const PURPOSE_MAX = 64;

/** Item key → its one-line purpose. Every tool has one (a test checks). */
export const PURPOSE = Object.freeze({
  // ---- stone and wood
  hammerstone: 'Knaps flint: every flint tool is struck with it.',
  stone_axe: 'Fells trees and lops leaves. Needed for the Work Stump.',
  wooden_shovel: 'Digs clay, which builds the Kiln. Digs earth faster.',
  // ---- flint
  flint_knife: 'Cuts hide into leather, shears sheep, peels cactus fruit.',
  flint_axe: 'Splits logs into planks. Fells faster than stone.',
  flint_pick: 'Your first way into stone: rock, coal and copper ore.',
  flint_shovel: 'Digs faster and lasts longer than wood.',
  flint_spear: 'The hunting weapon: thrust it or throw it.',
  // ---- the bows and the arrows (§100)
  sapling: 'A springy young shoot: strung with cord, a Crude Bow.',
  crude_bow: 'Shoots any arrow. Hold to draw, let go to shoot.',
  bow_stave: 'Fire-hardened in the Kiln, it becomes a Treated Stave.',
  treated_stave: 'Backed with rawhide at the Workbench: a Recurve Bow.',
  recurve_bow: 'Shoots faster, farther and truer than the Crude Bow.',
  stone_arrow: 'Shot from a bow. A stone head often breaks on a hit.',
  flint_arrow: 'Shot from a bow. Pick it up again after a miss.',
  copper_arrow: 'Hits like flint, and breaks far less often.',
  bronze_arrow: 'Hits harder than copper, and seldom breaks.',
  iron_arrow: 'Hits harder than bronze. Most can be shot again.',
  steel_arrow: 'The hardest-hitting arrow. It hardly ever breaks.',
  // ---- seeing far (§103)
  spyglass: 'Carry it to see far: hold Z to look through it.',
  // ---- copper
  copper_knife: 'Cuts deeper and lasts longer than flint.',
  copper_axe: 'Fells faster and lasts longer than flint.',
  copper_pick: 'Mines tin ore, the other half of bronze.',
  copper_shovel: 'Digs faster and lasts longer than flint.',
  copper_hammer: 'Draws copper wire and dresses stone bricks.',
  // ---- bronze
  bronze_knife: 'Lasts longer than copper.',
  bronze_axe: 'Hits harder and fells faster than copper.',
  bronze_pick: 'Mines iron ore.',
  bronze_shovel: 'Digs faster and lasts longer than copper.',
  bronze_hammer: 'Beats an iron bloom into wrought iron.',
  bronze_sword: 'Your first true weapon.',
  // ---- iron
  iron_knife: 'Cuts deepest. Lasts longer than bronze.',
  iron_axe: 'Fells faster and lasts longer than bronze.',
  iron_pick: 'Mines gold ore.',
  iron_shovel: 'Digs faster and lasts longer than bronze.',
  iron_hammer: 'Forges steel, and builds the Workbench.',
  iron_sword: 'Hits harder than bronze.',
  // ---- steel
  steel_knife: 'The longest-lasting knife.',
  steel_axe: 'The best axe, and a fierce weapon.',
  steel_pick: 'Mines gems. The fastest pick.',
  steel_shovel: 'The fastest shovel.',
  steel_hammer: 'Sets gems into a Diamond Block.',
  steel_sword: 'The best weapon.',
  // ---- fire and casting
  fire_drill: 'Lights a campfire or a torch.',
  crucible: 'Holds molten metal: needed to alloy bronze and to cast.',
  casting_mold: 'Shapes molten copper and bronze into tools.',
  // ---- workplaces
  work_stump: 'Workplace: flint tools, the bow, planks, leather, powder, wire.',
  kiln: 'Workplace: fires clay, burns charcoal, smelts copper and bronze.',
  bloomery: 'Workplace: smelts iron and melts glass.',
  forge: 'Workplace: iron and steel tools.',
  workbench: 'Workplace: circuit parts, recurve bows, spyglasses, the Lab.',
  lab: 'Workplace: the advanced electrical devices.',
  // ---- key parts
  cord: 'Binds every hafted tool.',
  campfire: 'Warmth, cooked food, boiled water, safety at night.',
  snare: 'Holds a wild animal that steps into it.',
  bellows: 'Needed to build the Bloomery and the Forge.',
  clay_pot: 'Carries water. Boil it on a fire to make it safe.',
  charcoal: 'Fuel for clay, and the only fuel for iron and steel.',
  torch: 'Light you can carry and set down.',
  sleeping_hide: 'A bedroll: sleep on it, and wake here after dying.',
  wicker_basket: 'Storage you can set down.',
  // ---- a place to stay (§85)
  well: 'Water all year, a few pots a day. Dig it into earth.',
  rain_barrel: 'Catches rain. Stores 3 pots of water that never spoil.',
  grass_bed: 'A poor place to sleep. Better than none.',
  bed: 'The best sleep: you heal most and need the fewest hours.',
  // ---- the wind (§101)
  pennant: 'Shows the wind. Stalk game with the wind in your face.',
  // ---- finding the way (§102)
  compass: 'Carry it, and the wind vane shows north.',
});

/**
 * @param {string|null|undefined} key  an item key
 * @returns {string} its one-line purpose, '' when it has none
 */
export function purposeOf(key) {
  return typeof key === 'string' && Object.hasOwn(PURPOSE, key) ? /** @type {Record<string, string>} */ (PURPOSE)[key] : '';
}
