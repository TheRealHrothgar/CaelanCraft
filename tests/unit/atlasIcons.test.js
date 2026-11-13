// atlas.drawBlockIcon's flat icons (docs/DESIGN-circuits.md §1.5, §7 C): a block with `icon: 'flat'` (the six thin circuit
// parts and, since the user's "fun and simple" redo, the 14 device models) is drawn as its TOP tile, unskewed, fitted to
// the icon square with nearest-neighbour scaling — one drawImage, no side faces and no hexagon. Every 'prism' block draws
// exactly as before. A fake 2D context records the calls.
import { describe, it, expect } from 'vitest';
import { drawBlockIcon, iconTopCorner, tileOrigin, ICON_BASE_SIZE } from '../../src/atlas.js';
import { BLOCK, BLOCKS, TILE, getFaceTile, FACE_TOP } from '../../src/blocks.js';
import { ATLAS_TILE_PX } from '../../src/config.js';

const THIN = [BLOCK.POWDER_FUSE, BLOCK.TORCH, BLOCK.COPPER_WIRE, BLOCK.BROWN_WIRE, BLOCK.WHITE_WIRE, BLOCK.EARTH_WIRE];
const DEVICES = [
  BLOCK.COLLAPSAR_CHARGE, BLOCK.TERMINAL_BOARD, BLOCK.VOLTAIC_BATTERY, BLOCK.BLASTING_MACHINE, BLOCK.SELENIUM_PANEL,
  BLOCK.KNIFE_SWITCH, BLOCK.PUSH_BUTTON, BLOCK.CLOCKWORK_TIMER, BLOCK.RELAY, BLOCK.IGNITER, BLOCK.FILAMENT_LAMP,
  BLOCK.ELECTRIC_BELL, BLOCK.SPARK_TRANSMITTER, BLOCK.COHERER_RECEIVER,
];
const FLAT = [...THIN, ...DEVICES];
/** The wild plants (sprites) and the ground litter (decals) also show their picture as a flat icon. */
const SPRITES = [78, 79, 80, 81, 82, 83, 84, 92, 93, 116, 117, 118, // + the three snares (§69)
  121, 132, // + the two ground nests (§76 fauna)
  122, 123, 124, 125, 126, 127, 128, 129, 130, 131, // + the ten plants of v0.14 (§76 flora)
  ...Array.from({ length: 18 }, (_, i) => 133 + i), // + the nine planted blocks and the nine sprouts (§80 farming)
  151, 152, 153, 154, 155, 156, 157, 158]; // + the eight plants that are not food (§81)
const atlas = { width: 256, height: 256, kind: 'atlas' };

/** A 2D context stand-in: every method call as [name, ...args], and the state each drawImage saw. */
function fakeContext() {
  const calls = [];
  const state = { imageSmoothingEnabled: true, globalCompositeOperation: 'source-over', fillStyle: '#000' };
  const stack = [];
  const ctx = {
    calls,
    get imageSmoothingEnabled() {
      return state.imageSmoothingEnabled;
    },
    set imageSmoothingEnabled(v) {
      state.imageSmoothingEnabled = v;
      calls.push(['set imageSmoothingEnabled', v]);
    },
    get globalCompositeOperation() {
      return state.globalCompositeOperation;
    },
    set globalCompositeOperation(v) {
      state.globalCompositeOperation = v;
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v) {
      state.fillStyle = v;
      calls.push(['set fillStyle', v]);
    },
    save() {
      stack.push({ ...state });
      calls.push(['save']);
    },
    restore() {
      Object.assign(state, stack.pop());
      calls.push(['restore']);
    },
    drawImage(...args) {
      calls.push(['drawImage', ...args, { smoothing: state.imageSmoothingEnabled }]);
    },
  };
  for (const m of ['setTransform', 'clearRect', 'fillRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'clip']) {
    ctx[m] = (...args) => calls.push([m, ...args]);
  }
  return ctx;
}
const named = (calls, name) => calls.filter((c) => c[0] === name);

describe('flat block icons (§1.5)', () => {
  it('exactly the six thin parts, the 14 devices, the 7 plants and the 2 litters are flat; every other block (the keg too) keeps the prism icon', () => {
    expect(BLOCKS.filter((b) => b.icon === 'flat').map((b) => b.id).sort((a, b) => a - b)).toEqual([...FLAT, ...SPRITES].sort((a, b) => a - b));
    expect(BLOCKS[BLOCK.POWDER_KEG].icon).toBe('prism');
    expect(BLOCKS.every((b) => b.icon === 'flat' || b.icon === 'prism')).toBe(true);
  });

  for (const size of [16, 32, 48, 64]) {
    it(`a flat icon at ${size} px is one nearest-neighbour drawImage of the top tile over the whole square, no side faces`, () => {
      for (const id of FLAT) {
        const ctx = fakeContext();
        drawBlockIcon(ctx, atlas, id, size);
        const draws = named(ctx.calls, 'drawImage');
        expect(draws, BLOCKS[id].name).toHaveLength(1);
        const [sx, sy] = tileOrigin(getFaceTile(id, FACE_TOP));
        expect(draws[0].slice(1, 10)).toEqual([atlas, sx, sy, ATLAS_TILE_PX, ATLAS_TILE_PX, 0, 0, size, size]);
        expect(draws[0][10].smoothing).toBe(false);
        // No prism: no clip to the hexagon, no shading of side faces, no skewing transform.
        for (const m of ['clip', 'beginPath', 'fillRect']) expect(named(ctx.calls, m), m).toHaveLength(0);
        expect(named(ctx.calls, 'setTransform')).toEqual([['setTransform', 1, 0, 0, 1, 0, 0]]);
        // The square is cleared first, and the context state is restored.
        expect(ctx.calls[2]).toEqual(['clearRect', 0, 0, size, size]);
        expect(named(ctx.calls, 'save')).toHaveLength(named(ctx.calls, 'restore').length);
        expect(ctx.imageSmoothingEnabled).toBe(true);
      }
    });
  }

  it('draws the fuse, torch, wire and device pictures from their own atlas cells', () => {
    const want = {
      [BLOCK.POWDER_FUSE]: TILE.POWDER_FUSE, [BLOCK.TORCH]: TILE.TORCH, [BLOCK.COPPER_WIRE]: TILE.COPPER_WIRE,
      [BLOCK.BROWN_WIRE]: TILE.BROWN_WIRE, [BLOCK.WHITE_WIRE]: TILE.WHITE_WIRE, [BLOCK.EARTH_WIRE]: TILE.EARTH_WIRE,
      [BLOCK.COLLAPSAR_CHARGE]: TILE.COLLAPSAR_TOP, [BLOCK.TERMINAL_BOARD]: TILE.TERMINAL_TOP,
      [BLOCK.VOLTAIC_BATTERY]: TILE.BATTERY_TOP, [BLOCK.BLASTING_MACHINE]: TILE.BLASTER_TOP,
      [BLOCK.SELENIUM_PANEL]: TILE.SELENIUM_TOP, [BLOCK.KNIFE_SWITCH]: TILE.SWITCH_TOP, [BLOCK.PUSH_BUTTON]: TILE.BUTTON_TOP,
      [BLOCK.CLOCKWORK_TIMER]: TILE.TIMER_TOP, [BLOCK.RELAY]: TILE.RELAY_TOP, [BLOCK.IGNITER]: TILE.IGNITER_TOP,
      [BLOCK.FILAMENT_LAMP]: TILE.LAMP_TOP, [BLOCK.ELECTRIC_BELL]: TILE.BELL_TOP,
      [BLOCK.SPARK_TRANSMITTER]: TILE.TX_TOP, [BLOCK.COHERER_RECEIVER]: TILE.RX_TOP,
    };
    for (const id of FLAT) {
      const ctx = fakeContext();
      drawBlockIcon(ctx, atlas, id, 32);
      expect(named(ctx.calls, 'drawImage')[0].slice(2, 4)).toEqual(tileOrigin(want[id]));
    }
  });
});

describe('prism block icons are unchanged', () => {
  /** The prism's two side quads, exactly as atlas.js has always mapped them (CONTRACTS §16). */
  function sideMatrix(kLeft, kRight, s) {
    const [lx, ly] = iconTopCorner(kLeft);
    const [rx, ry] = iconTopCorner(kRight);
    return [(rx - lx) / 16, (ry - ly) / 16, 0, 14 / 16, lx, ly].map((v) => v * s);
  }

  for (const size of [32, 64]) {
    it(`every prism block at ${size} px: two shaded side faces (SW, SE) and the top clipped to the hexagon`, () => {
      const s = size / ICON_BASE_SIZE;
      for (const def of BLOCKS) {
        if (def.icon !== 'prism' || def.id === BLOCK.AIR) continue;
        const ctx = fakeContext();
        drawBlockIcon(ctx, atlas, def.id, size);
        const draws = named(ctx.calls, 'drawImage');
        expect(draws, def.name).toHaveLength(3);
        expect(draws[0].slice(2, 4)).toEqual(tileOrigin(getFaceTile(def.id, 2)));
        expect(draws[1].slice(2, 4)).toEqual(tileOrigin(getFaceTile(def.id, 1)));
        expect(draws[2].slice(2, 4)).toEqual(tileOrigin(getFaceTile(def.id, FACE_TOP)));
        for (const d of draws) expect(d.slice(4, 10)).toEqual([16, 16, 0, 0, 16, 16]);
        const transforms = named(ctx.calls, 'setTransform').map((c) => c.slice(1));
        expect(transforms[0]).toEqual([1, 0, 0, 1, 0, 0]);
        expect(transforms[1]).toEqual(sideMatrix(3, 2, s));
        expect(transforms[2]).toEqual(sideMatrix(2, 1, s));
        expect(transforms[3]).toEqual([s, 0, 0, s, 0, 0]);
        expect(transforms[4]).toEqual([(26 / 16) * s, 0, 0, s, 3 * s, s]);
        expect(named(ctx.calls, 'set fillStyle').map((c) => c[1])).toEqual(['rgba(0,0,0,0.2)', 'rgba(0,0,0,0.4)']);
        expect(named(ctx.calls, 'clip')).toHaveLength(1);
        expect(named(ctx.calls, 'lineTo')).toHaveLength(5);
      }
    });
  }

  it('AIR, an unknown id and a bad size still leave the square blank', () => {
    for (const id of [BLOCK.AIR, 999, -3]) {
      const ctx = fakeContext();
      drawBlockIcon(ctx, atlas, id, 32);
      expect(named(ctx.calls, 'drawImage')).toHaveLength(0);
      expect(named(ctx.calls, 'clearRect')).toHaveLength(1);
    }
    for (const size of [0, -5, NaN, Infinity]) {
      const ctx = fakeContext();
      drawBlockIcon(ctx, atlas, BLOCK.COPPER_WIRE, size);
      expect(ctx.calls).toHaveLength(0);
    }
  });
});
