// CONTRACTS §102 — the Compass: the item and its recipe at the Forge, its picture, purpose, picker entry, handbook lines
// and place in the build tree; whether one is carried (compass.js); north's bearing on the HUD's dial; the N on the vane
// (hud.setNorth, styles.css); and main's wiring.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMPASS_KEY, compassCarried, northAngle, northDeg, northView } from '../../src/compass.js';
import { vaneAngle, vaneView } from '../../src/windDrawn.js';
import { ITEMS, ITEM_KEYS, getItem, stackSize, maxDurability, blockForItem, resolveItem, itemName } from '../../src/items.js';
import { getRecipe, listRecipes, RECIPES } from '../../src/crafting.js';
import { Pack, slotClick, returnCursor } from '../../src/inventory.js';
import { paintItem, hasItemArt, toolArtOf, ITEM_ART_KEYS } from '../../src/itemArt.js';
import { purposeOf, PURPOSE_MAX } from '../../src/purpose.js';
import { PICKER_ITEM_SECTIONS, buildPickerModel, searchBlocks, blurbFor } from '../../src/pickerModel.js';
import { buildChapters, plainText } from '../../src/handbook.js';
import { buildTreeModel, placeId } from '../../src/buildTree.js';
import { isItemPick, normalizePick } from '../../src/creativePicks.js';
import { readHoldParam } from '../../src/diagnostics.js';
import { cameraPose } from '../../src/viewCamera.js';
import {
  createHUD, VANE_BOX, COMPASS_BOX, NORTH_LETTER_R, NORTH_LETTER_SIZE, NORTH_TICK, northLetterAt,
} from '../../src/hud.js';
import { documentFromHTML } from '../helpers/fakeDom.js';

const read = (path) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

/** A stack in pack slot `i` of a fresh pack. @param {Array<[number, string, number?]>} stacks */
function packWith(stacks) {
  const pack = new Pack();
  for (const [i, k, n = 1] of stacks) pack.setSlot(i, { k, n });
  return pack;
}

// ---------------------------------------------------------------------------------------------------------------------

describe('the Compass: an item made at the Forge from iron', () => {
  it('is a plain item: "Compass", stack 1, no tool and no durability (it never wears), places nothing', () => {
    expect(COMPASS_KEY).toBe('compass');
    expect(getItem('compass')).toEqual({ key: 'compass', name: 'Compass', kind: 'material', stack: 1 });
    expect(stackSize('compass')).toBe(1);
    expect(maxDurability('compass')).toBe(0);
    expect(ITEMS.compass.tool).toBeUndefined();
    expect(blockForItem('compass')).toBe(-1);
    expect(resolveItem('Compass')).toEqual({ key: 'compass' });
    expect(itemName('compass', 1)).toBe('Compass'); // one compass is "a Compass", never "a Compas"
    // the last of the materials, before the food
    const materials = ITEM_KEYS.filter((k) => ITEMS[k].kind === 'material');
    expect(materials[materials.length - 1]).toBe('compass');
  });

  it('the recipe: at the Forge, a Wrought Iron Bar (the needle), a Copper Ingot (the case) and Glass Shards (the face), with a Bronze Hammer, 20 s', () => {
    const rec = getRecipe('compass');
    expect(rec).toEqual({
      id: 'compass', station: 'forge',
      inputs: [{ k: 'wrought_iron', n: 1 }, { k: 'copper_ingot', n: 1 }, { k: 'glass_shards', n: 1 }],
      outputs: [{ k: 'compass', n: 1 }],
      tools: [{ type: 'hammer', tier: 4 }],
      seconds: 20,
    });
    // like the other forge work: the iron tools want the same hammer
    expect(getRecipe('iron_pick').tools).toEqual(rec.tools);
    // it requires iron: wrought iron comes only from the Bloomery's bloom
    expect(RECIPES.filter((r) => r.outputs.some((o) => o.k === 'wrought_iron')).map((r) => r.station)).toEqual(['bloomery']);
    expect(RECIPES.filter((r) => r.outputs.some((o) => o.k === 'compass'))).toEqual([rec]);
  });

  it('can be made at a Forge with the inputs and a hammer; not without the Forge, the iron or the hammer', () => {
    const forge = { forge: [0, 64, 0] };
    const view = (pack, stations) => listRecipes(pack, stations, { station: 'forge' }).find((v) => v.id === 'compass');
    const full = packWith([[0, 'wrought_iron'], [1, 'copper_ingot'], [2, 'glass_shards'], [3, 'bronze_hammer']]);
    expect(view(full, forge)?.craftable).toBe(true);
    expect(view(full, forge)?.purpose).toBe(purposeOf('compass'));
    expect(view(full, {})?.craftable).toBe(false);
    expect(view(full, {})?.hint).toBe('build a Forge nearby');
    expect(view(packWith([[1, 'copper_ingot'], [2, 'glass_shards'], [3, 'bronze_hammer']]), forge)?.craftable).toBe(false);
    expect(view(packWith([[0, 'wrought_iron'], [1, 'copper_ingot'], [2, 'glass_shards'], [3, 'copper_hammer']]), forge)?.craftable).toBe(false);
  });

  it('its picture: a round copper case, a glass face and a red-and-white needle, painted the same every time', () => {
    expect(hasItemArt('compass')).toBe(true);
    expect(toolArtOf('compass')).toBeNull();
    expect(ITEM_ART_KEYS).toContain('compass');
    const px = paintItem('compass');
    expect(paintItem('compass')).toEqual(px);
    const at = (x, y) => {
      const i = (y * 16 + x) * 4;
      return px[i + 3] ? (px[i] << 16) | (px[i + 1] << 8) | px[i + 2] : null;
    };
    const all = [];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) all.push(at(x, y));
    // not the magenta 'missing' checker
    expect(all).not.toContain(0xff00ff);
    // the case is round: the corners are clear and the middle row is solid from rim to rim
    for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15]]) expect(at(x, y), `${x},${y}`).toBeNull();
    for (let x = 1; x <= 14; x++) expect(at(x, 8), `x ${x}`).not.toBeNull();
    // a red north half (up and right of the pivot) and a white south half (down and left)
    const red = (c) => c !== null && ((c >> 16) & 255) > 200 && ((c >> 8) & 255) < 120 && (c & 255) < 110;
    const white = (c) => c !== null && ((c >> 16) & 255) > 235 && ((c >> 8) & 255) > 235 && (c & 255) > 225;
    expect(red(at(10, 6)) && red(at(9, 7))).toBe(true);
    expect(white(at(6, 10)) && white(at(7, 9))).toBe(true);
    // a copper case and a bluish glass face
    expect(all.filter((c) => c === 0xc8743a).length).toBeGreaterThan(10);
    const glass = all.filter((c) => c !== null && (c & 255) > ((c >> 16) & 255) + 40);
    expect(glass.length).toBeGreaterThan(30);
  });

  it('a purpose line, the Creative picker (Tools) and a search by "north"', () => {
    expect(purposeOf('compass')).toBe('Carry it, and the wind vane shows north.');
    expect(purposeOf('compass').length).toBeLessThanOrEqual(PURPOSE_MAX);
    const tools = PICKER_ITEM_SECTIONS.find((s) => s.id === 'tools');
    expect(tools?.items).toContain('compass');
    const model = buildPickerModel();
    expect(model.info.get('compass')?.section).toBe('tools');
    for (const q of ['compass', 'north', 'needle', 'direction']) expect(searchBlocks(model, q), q).toContain('compass');
    expect(blurbFor('compass')).toBe(purposeOf('compass'));
    // a Creative hotbar can hold it (§98), and ?hold=compass puts it there
    expect(isItemPick('compass')).toBe(true);
    expect(normalizePick('compass')).toBe('compass');
    expect(readHoldParam(new URLSearchParams('hold=Compass'))).toBe('compass');
  });

  it('the handbook: the Forge makes it (from its recipe) and the wind page says what the N is', () => {
    const chapters = buildChapters();
    const pageWith = (heading) => {
      for (const c of chapters) for (const page of c.pages) if (page.some((b) => b.kind === 'h' && b.text === heading)) return page;
      throw new Error(heading);
    };
    const words = (page) => page.flatMap((b) => ('text' in b ? [plainText(b.text)] : b.kind === 'list' ? b.items.map(plainText) : [])).join('\n');
    const iron = words(pageWith('Iron and steel'));
    expect(iron).toContain('The Forge also makes a Compass, an iron needle in a copper case under glass (Wrought Iron Bar, Copper Ingot and Glass Shards).');
    expect(iron).toContain('Carry it anywhere in your pack, and an N on the wind vane at the top of the screen shows where north lies.');
    expect(words(pageWith('The wind'))).toContain('With a Compass in your pack, an N on the dial shows where north lies.');
    // and it is in the Forge's recipe table
    const forgeRows = chapters.flatMap((c) => c.pages.flat()).filter((b) => b.kind === 'table' && b.id === 'recipes-forge')
      .flatMap((t) => t.rows);
    expect(forgeRows.some((r) => r[0] === 'Compass')).toBe(true);
  });

  it('the build tree picks it up from the recipe: the Forge unlocks it', () => {
    const model = buildTreeModel();
    expect(model.byId.get(placeId('forge'))?.unlocks).toContain('compass');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('carried or not (compass.compassCarried)', () => {
  it('Survival: anywhere in the pack — the hotbar row or the rest of it; not otherwise', () => {
    for (const slot of [0, 4, 8, 9, 17, 26]) {
      expect(compassCarried(true, packWith([[slot, 'compass']]).slots, null), `slot ${slot}`).toBe(true);
    }
    expect(compassCarried(true, new Pack().slots, null)).toBe(false);
    expect(compassCarried(true, packWith([[0, 'wrought_iron'], [5, 'copper_ingot'], [9, 'glass_shards']]).slots, null)).toBe(false);
    // worn slots are not pack slots: nothing a compass could be in
    const worn = new Pack();
    worn.setWear(0, { k: 'compass', n: 1 });
    expect(compassCarried(true, worn.slots, null)).toBe(false);
    // the Creative hotbar does not count in Survival
    expect(compassCarried(true, new Pack().slots, ['compass'])).toBe(false);
    expect(compassCarried(true, null, null)).toBe(false);
  });

  it('Survival: a compass on the pack screen\'s cursor, being moved from slot to slot, is still carried', () => {
    const pack = packWith([[12, 'compass']]);
    const session = { pack, cursor: null, container: null };
    expect(compassCarried(true, pack.slots, null, session.cursor)).toBe(true);
    slotClick(session, 'pack', 12, 0, false); // picked up: the slot is empty, the stack is on the cursor
    expect(pack.slots[12]).toBeNull();
    expect(session.cursor).toEqual({ k: 'compass', n: 1 });
    expect(compassCarried(true, pack.slots, null)).toBe(false); // the slots alone no longer hold it
    expect(compassCarried(true, pack.slots, null, session.cursor)).toBe(true); // the N stays
    slotClick(session, 'pack', 3, 0, false); // put down on the hotbar row
    expect(session.cursor).toBeNull();
    expect(compassCarried(true, pack.slots, null, session.cursor)).toBe(true);
    // closing the screen with it on the cursor puts it back in the pack
    slotClick(session, 'pack', 3, 0, false);
    expect(returnCursor(session)).toBeNull();
    expect(compassCarried(true, pack.slots, null, session.cursor)).toBe(true);
    // any other stack on the cursor is not a compass; and the cursor is not read in Creative
    expect(compassCarried(true, new Pack().slots, null, { k: 'wrought_iron', n: 1 })).toBe(false);
    expect(compassCarried(true, null, null, { k: 'compass', n: 1 })).toBe(true);
    expect(compassCarried(false, null, [1, 2, 3], { k: 'compass', n: 1 })).toBe(false);
  });

  it('Creative (and a server, which is Creative): when a hotbar slot holds the compass item pick', () => {
    expect(compassCarried(false, null, [1, 2, 'compass', 4, 5, 6, 7, 8, 9])).toBe(true);
    expect(compassCarried(false, null, ['iron_pick', 3, 0, 0, 0, 0, 0, 0, 'compass'])).toBe(true);
    expect(compassCarried(false, null, [1, 2, 3, 'iron_pick', 0, 0, 0, 0, 0])).toBe(false);
    expect(compassCarried(false, null, null)).toBe(false);
    // the Survival pack does not count in Creative
    expect(compassCarried(false, packWith([[0, 'compass']]).slots, [1, 2, 3])).toBe(false);
  });

  it('northView: the bearing while one is carried, null (no N) when none is', () => {
    expect(northView(false, 0)).toBeNull();
    expect(northView(false, 1.2)).toBeNull();
    expect(northView(true, 0)).toBe(0);
    expect(northView(true, -Math.PI / 2)).toBe(270);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("north's bearing on the dial, relative to where the player looks (north is −z)", () => {
  // the player looks along (−sin yaw, −cos yaw): yaw 0 looks toward −z, north
  it('facing north the N is at the top; facing east (+x) it is on the left; facing west on the right; facing south at the bottom', () => {
    expect(northAngle(0)).toBeCloseTo(0, 12);
    expect(northDeg(0)).toBe(0);
    // facing east: the look is +x, so yaw = −π/2
    expect(-Math.sin(-Math.PI / 2)).toBe(1);
    expect(-Math.cos(-Math.PI / 2)).toBeCloseTo(0, 12);
    expect(northAngle(-Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 12);
    expect(northDeg(-Math.PI / 2)).toBe(270); // the left of the dial
    expect(northDeg(Math.PI / 2)).toBe(90); // facing west: the right
    expect(northDeg(Math.PI)).toBe(180); // facing south: the bottom
    expect(northAngle(Math.PI)).toBe(Math.PI);
    expect(northAngle(-Math.PI)).toBe(Math.PI); // (−π, π]
    expect(northDeg(2 * Math.PI + 0.1)).toBe(6); // yaw keeps growing as the player spins: it wraps
    expect(northDeg(NaN)).toBe(0);
  });

  it('it is where a wind blowing north would point: the same frame as the wind vane, fixed to the world as the player turns', () => {
    const northward = { dir: Math.PI, x: 0, z: -1, strength: 0.5, speed: 6, gust: 0 };
    for (const yaw of [0, 0.4, 1.3, -2.2, 3.1, 7.5]) {
      expect(northAngle(yaw), `yaw ${yaw}`).toBeCloseTo(vaneAngle(northward, yaw), 9);
      expect(northDeg(yaw), `yaw ${yaw}`).toBe(vaneView(northward, yaw).angle);
      for (const d of [0.1, 0.8]) {
        // turning right (yaw decreases) turns the N left by as much
        const delta = northAngle(yaw - d) - northAngle(yaw);
        expect(Math.atan2(Math.sin(delta), Math.cos(delta))).toBeCloseTo(-d, 9);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('the N on the vane (hud.setNorth, styles.css)', () => {
  function page(html = read('index.html')) {
    const doc = documentFromHTML(html);
    const hud = createHUD(/** @type {*} */ (doc), /** @type {*} */ ({ width: 256, height: 256 }));
    return { doc, hud, el: /** @type {any} */ (doc.getElementById('wind-indicator')) };
  }
  const EAST_BREEZE = { dir: Math.PI / 2, x: 1, z: 0, strength: 0.5, speed: 6, gust: 0 };

  it('appears with a compass and disappears without one: the plain vane is exactly as it was', () => {
    const { hud, el } = page();
    hud.setWind(vaneView(EAST_BREEZE, 0));
    const svg = el.querySelector('svg.wind-vane');
    const plain = [svg.getAttribute('viewBox'), svg.getAttribute('width'), svg.getAttribute('height'), svg.children.length];
    expect(plain).toEqual([VANE_BOX.view, String(VANE_BOX.px), String(VANE_BOX.px), plain[3]]);
    hud.setNorth(null);
    expect(el.querySelector('.wind-north')).toBeNull();
    expect(el.classList.contains('wind-compass')).toBe(false);

    hud.setNorth(0); // facing north
    expect(el.classList.contains('wind-compass')).toBe(true);
    expect([svg.getAttribute('viewBox'), svg.getAttribute('width')]).toEqual([COMPASS_BOX.view, String(COMPASS_BOX.px)]);
    const letter = el.querySelector('.wind-north-letter');
    expect(letter.textContent).toBe('N');
    expect(letter.getAttribute('font-size')).toBe(String(NORTH_LETTER_SIZE));
    expect(letter.getAttribute('x')).toBe('0');
    expect(Number(letter.getAttribute('y'))).toBeLessThan(0); // the top of the dial
    expect(el.querySelector('.wind-north-tick').getAttribute('transform')).toBe('rotate(0)');
    // under the arrow, so the arrow is never hidden by it
    const kids = svg.children;
    expect(kids.indexOf(el.querySelector('.wind-north'))).toBeLessThan(kids.indexOf(el.querySelector('.wind-arrow')));

    hud.setNorth(270); // facing east: on the left
    expect(Number(letter.getAttribute('x'))).toBeCloseTo(-NORTH_LETTER_R, 1);
    expect(el.querySelector('.wind-north-tick').getAttribute('transform')).toBe('rotate(270)');

    hud.setNorth(null); // the compass is gone
    expect(el.querySelector('.wind-north')).toBeNull();
    expect(el.classList.contains('wind-compass')).toBe(false);
    expect([svg.getAttribute('viewBox'), svg.getAttribute('width'), svg.getAttribute('height'), svg.children.length]).toEqual(plain);

    hud.setNorth(180); // back again, at the bottom
    expect(el.querySelectorAll('.wind-north-letter')).toHaveLength(1);
    expect(Number(el.querySelector('.wind-north-letter').getAttribute('y'))).toBeGreaterThan(0);
    // the wind's own drawing is untouched by it
    expect(el.querySelector('.wind-arrow').getAttribute('transform')).toBe('rotate(90) scale(0.86)');
    hud.dispose();
  });

  it('the N stands upright at its bearing, its capital centred NORTH_LETTER_R out; the tick runs inside the ring', () => {
    expect(northLetterAt(0)).toEqual([0, Math.round((-NORTH_LETTER_R + 0.35 * NORTH_LETTER_SIZE) * 100) / 100]);
    for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const [x, y] = northLetterAt(deg);
      const cy = y - 0.35 * NORTH_LETTER_SIZE; // the capital's centre
      expect(Math.hypot(x, cy), `${deg}`).toBeCloseTo(NORTH_LETTER_R, 1);
      expect(Math.atan2(x, -cy) * (180 / Math.PI), `${deg}`).toBeCloseTo(deg > 180 ? deg - 360 : deg, 0);
      // the whole letter stays inside the dial (and the capsule's round end): its far corner within the viewBox's half
      // (a bold capital N: about 0.64 em of ink across, 0.72 em tall)
      const corner = Math.hypot(Math.abs(x) + 0.32 * NORTH_LETTER_SIZE, Math.abs(cy) + 0.36 * NORTH_LETTER_SIZE);
      expect(corner, `${deg}`).toBeLessThanOrEqual(-Number(COMPASS_BOX.view.split(' ')[0]));
    }
    expect(NORTH_TICK[1]).toBeLessThanOrEqual(10.5); // the wind's ring
    expect(NORTH_TICK[0]).toBeGreaterThan(0);
  });

  it('the DOM is touched only when the bearing, or whether a compass is carried, changes', () => {
    const { doc, hud } = page();
    hud.setWind(vaneView(EAST_BREEZE, 0));
    hud.setNorth(northView(true, 0.3));
    let w = doc.writes;
    for (let i = 0; i < 50; i++) hud.setNorth(northView(true, 0.3 + i * 1e-5)); // a turn too small to see
    expect(doc.writes).toBe(w);
    hud.setNorth(northView(true, 0.4));
    expect(doc.writes).toBeGreaterThan(w);
    hud.setNorth(null);
    w = doc.writes;
    for (let i = 0; i < 10; i++) hud.setNorth(northView(false, i));
    expect(doc.writes).toBe(w);
    hud.dispose();
  });

  it('a page without the indicator still works (it is made), and the N may come before the wind does', () => {
    const { doc, hud } = page(read('index.html').replace(/\s*<div id="wind-indicator"[^>]*><\/div>/, ''));
    hud.setNorth(90);
    const el = /** @type {any} */ (doc.getElementById('wind-indicator'));
    expect(el.querySelector('.wind-north-letter').textContent).toBe('N');
    expect(el.classList.contains('hidden')).toBe(true); // still hidden until the wind is told
    hud.setWind(vaneView(EAST_BREEZE, 0));
    expect(el.classList.contains('hidden')).toBe(false);
    expect(el.querySelectorAll('.wind-north')).toHaveLength(1);
    hud.dispose();
  });

  it('the stylesheet: the capsule grows for the bigger dial; a white N outlined dark, a red tick', () => {
    const css = read('src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (sel) => {
      const m = new RegExp(`(?:^|[}\\s])${sel.replace(/[.#()]/g, '\\$&')}\\{([^}]*)\\}`).exec(css);
      expect(m, sel).toBeTruthy();
      return Object.fromEntries(m[1].split(';').filter((d) => d.trim()).map((d) => d.split(/:(.*)/).slice(0, 2).map((x) => x.trim())));
    };
    const grown = rule('.wind-indicator.wind-compass');
    expect(parseFloat(grown.height)).toBe(COMPASS_BOX.px + 2); // the dial and the 1 px rim of the capsule
    expect(parseFloat(rule('.wind-indicator').height)).toBe(VANE_BOX.px + 2); // as it was without one
    const letter = rule('.wind-north-letter');
    expect(letter.fill).toBe('#fff');
    expect(letter['paint-order']).toBe('stroke');
    expect(letter['font-weight']).toBe('800');
    expect(rule('.wind-north-tick').stroke).toMatch(/^#ff/);
    // the capsule's glass and its places (desktop, Survival, touch) are §101's, unchanged
    expect(rule('#hud.survival .wind-indicator').top).toBe('28px');
    expect(css).toMatch(/html\.touch \.wind-indicator\{top:calc\(6px/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("main's wiring: read from the source, since main needs a browser", () => {
  const main = read('src/main.js');
  it('every frame after the vane, the HUD is told whether a compass is carried and where north lies', () => {
    const at = main.indexOf('  function stepWeather(');
    const step = main.slice(at, main.indexOf('\n  }\n', at));
    expect(step).toContain('hud.setNorth(northView(compassCarried(SV, pack.slots, hotbar, packSession.cursor), viewYaw));');
    expect(step.indexOf('hud.setWind(')).toBeLessThan(step.indexOf('hud.setNorth('));
    // the N and the wind's arrow share one frame: the view on screen, not the avatar's facing
    expect(step).toContain('function stepWeather(dt, live, eyeY, viewYaw) {');
    expect(step).toContain('hud.setWind(vaneView(wind, viewYaw, vaneNow));');
    expect(step).not.toContain('controls.yaw');
    expect(main).toContain("import { compassCarried, northView } from './compass.js';");
    // SV is Survival; on a server the game is Creative (the hotbar's rule)
    expect(step).toContain('const SV = survival.inSurvival;');
  });

  it("the view's yaw is the camera's (viewCamera), worked out before the weather each frame", () => {
    const at = main.indexOf('  function renderFrame(');
    const frame = main.slice(at, main.indexOf('\n  }\n', at));
    const camAt = frame.indexOf('const cam = viewCamera(dt, eyeY);');
    expect(camAt).toBeGreaterThan(0);
    const weatherAt = frame.indexOf('stepWeather(dt, live, eyeY, cam.yaw)');
    expect(weatherAt).toBeGreaterThan(camAt);
    expect(main.match(/stepWeather\(/g)).toHaveLength(2); // the one definition and the one call
  });
});

describe("the dial follows the view on screen (§91's views)", () => {
  it('first person and behind: north as from the avatar; the Front view looks back, so north turns by 180°', () => {
    for (const yaw of [0, -Math.PI / 2, 0.7, 2.9, -2.4]) {
      const first = cameraPose(0, 0, 0, yaw, 0.2, 'first', 0).yaw;
      const behind = cameraPose(0, 0, 0, yaw, 0.2, 'behind', 4).yaw;
      const front = cameraPose(0, 0, 0, yaw, 0.2, 'front', 4).yaw;
      expect(northDeg(first), `yaw ${yaw}`).toBe(northDeg(yaw));
      expect(northDeg(behind), `yaw ${yaw}`).toBe(northDeg(yaw));
      expect(northDeg(front), `yaw ${yaw}`).toBe((northDeg(yaw) + 180) % 360);
    }
    // the avatar facing east (yaw −π/2) in the Front view: the camera looks west, so north is on the dial's right
    expect(northDeg(cameraPose(0, 0, 0, -Math.PI / 2, 0, 'front', 4).yaw)).toBe(90);
  });
});
