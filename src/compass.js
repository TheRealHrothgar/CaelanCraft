// Caelancraft — the Compass (CONTRACTS §102). PURE: no DOM, no three, no imports.
//
// The user: "compass: require iron. When in the inventory, a N indicator displays on the player's HUD." The Compass is
// made at the Forge (crafting.js) and does nothing in the hand: carried, it puts north on the HUD's wind vane
// (hud.setNorth) — an N on the dial's rim at the bearing of north from where the player looks, turning as they turn.
// North is the world's −z, as everywhere in the game (wind.js windFromWord; yaw 0 faces north, and east is +x).

/** The Compass's item key (items.js: a material, stack 1; it never wears). */
export const COMPASS_KEY = 'compass';

/**
 * Is a compass carried? In Survival: a stack of it in any pack slot (the hotbar row is pack slots 0–8, so it counts
 * too; the worn slots are not pack slots and never hold one). In Creative — and on a server, which is Creative — a slot
 * of the Creative hotbar holds the compass's item pick (CONTRACTS §98).
 * @param {boolean} survival  the player is in Survival
 * @param {ReadonlyArray<{ k: string }|null|undefined>|null|undefined} packSlots  Pack.slots (read in Survival only)
 * @param {ReadonlyArray<number|string|null|undefined>|null|undefined} hotbar  Creative's hotbar (read in Creative only)
 * @returns {boolean}
 */
export function compassCarried(survival, packSlots, hotbar) {
  if (survival) {
    if (!packSlots) return false;
    for (let i = 0; i < packSlots.length; i++) {
      const s = packSlots[i];
      if (s && s.k === COMPASS_KEY) return true;
    }
    return false;
  }
  if (!hotbar) return false;
  for (let i = 0; i < hotbar.length; i++) if (hotbar[i] === COMPASS_KEY) return true;
  return false;
}

/**
 * Where north lies on the HUD's dial, seen from where the player looks: radians clockwise from the top of the dial (the
 * way the player faces), in (−π, π]. The player looks along (−sin yaw, −cos yaw); north (0, −1) is cos yaw of the way
 * ahead and sin yaw of the way to their right (cos yaw, −sin yaw), so the bearing is yaw itself, wrapped. Facing north
 * (yaw 0) it is at the top; facing east (yaw −π/2) on the left; facing south at the bottom. It turns by −d when the
 * player turns right by d: it stays fixed to the world, like the wind's arrow (windDrawn.vaneAngle).
 * @param {number} yaw  controls.yaw
 * @returns {number}
 */
export function northAngle(yaw) {
  const y = Number.isFinite(yaw) ? yaw : 0;
  const a = Math.atan2(Math.sin(y), Math.cos(y));
  return a <= -Math.PI ? Math.PI : a;
}

/**
 * northAngle in whole degrees, 0..359 (what hud.setNorth draws: the HUD redraws only when the N would visibly move).
 * @param {number} yaw @returns {number}
 */
export function northDeg(yaw) {
  const d = Math.round((northAngle(yaw) * 180) / Math.PI);
  return ((d % 360) + 360) % 360;
}

/**
 * What main hands hud.setNorth each frame: north's bearing on the dial in whole degrees while a compass is carried, null
 * (no N) when none is.
 * @param {boolean} carried  compassCarried(...) @param {number} yaw
 * @returns {number|null}
 */
export function northView(carried, yaw) {
  return carried ? northDeg(yaw) : null;
}
