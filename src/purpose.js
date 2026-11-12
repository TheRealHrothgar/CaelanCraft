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
  stone_hammer: 'Knaps flint: every flint tool is struck with it.',
  stone_axe: 'Fells trees and lops leaves. Needed for the Work Stump.',
  wooden_shovel: 'Digs clay, which builds the Kiln. Digs earth faster.',
  // ---- flint
  flint_knife: 'Cuts hide into leather, shears sheep, peels cactus fruit.',
  flint_axe: 'Splits logs into planks. Fells faster than stone.',
  flint_pick: 'Your first way into stone: rock, coal and copper ore.',
  flint_shovel: 'Digs faster and lasts longer than wood.',
  flint_spear: 'The hunting weapon: thrust it or throw it.',
  flint_dart: 'A light thrown weapon for small game.',
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
  work_stump: 'Workplace: planks, sticks, leather and simple parts.',
  kiln: 'Workplace: fires clay, burns charcoal, smelts copper and bronze.',
  bloomery: 'Workplace: smelts iron and melts glass.',
  forge: 'Workplace: iron and steel tools.',
  workbench: 'Workplace: the advanced electrical devices.',
  // ---- key parts
  cord: 'Binds every hafted tool.',
  campfire: 'Warmth, cooked food, boiled water, safety at night.',
  snare: 'Holds a wild animal that steps into it.',
  bellows: 'Needed to build the Bloomery and the Forge.',
  clay_pot: 'Carries water. Boil it on a fire to make it safe.',
  charcoal: 'Fuel for clay, and the only fuel for iron and steel.',
  torch: 'Light you can carry and set down.',
  sleeping_hide: 'Where you wake after dying.',
  wicker_basket: 'Storage you can set down.',
});

/**
 * @param {string|null|undefined} key  an item key
 * @returns {string} its one-line purpose, '' when it has none
 */
export function purposeOf(key) {
  return typeof key === 'string' && Object.hasOwn(PURPOSE, key) ? /** @type {Record<string, string>} */ (PURPOSE)[key] : '';
}
