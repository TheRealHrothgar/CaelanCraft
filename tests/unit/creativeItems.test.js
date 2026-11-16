// §98 Every item in Creative: what a hotbar slot may hold (creativePicks.js), saves that keep item picks (storage.js), the
// HUD drawing them, main's hotbarFrom, and the held item on the wire (protocol.cleanHeld, the server, RemotePlayers).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isItemPick, isHotbarPick, normalizePick, pickItemKey, pickName } from '../../src/creativePicks.js';
import { BLOCK, DEFAULT_HOTBAR } from '../../src/blocks.js';
import { ITEMS, getItem } from '../../src/items.js';
import { SAVE_VERSION, serializeSave, deserializeSave } from '../../src/storage.js';
import { createHUD } from '../../src/hud.js';
import { hotbarFrom } from '../../src/main.js';
import { cleanHeld, decode, PROTOCOL_VERSION } from '../../src/protocol.js';
import { RemotePlayers } from '../../src/net.js';
import { ServerGame } from '../../server/game.js';
import { documentFromHTML } from '../helpers/fakeDom.js';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

describe('a Creative hotbar slot: a block id or an item that is not a block', () => {
  it('tells item picks from blocks', () => {
    expect(isItemPick('iron_pick')).toBe(true);
    expect(isItemPick('steel_sword')).toBe(true);
    expect(isItemPick('honeyberries')).toBe(true);
    expect(isItemPick('oak_planks')).toBe(false); // a block's item stays a block id
    expect(isItemPick('no_such_item')).toBe(false);
    expect(isItemPick(BLOCK.STONE)).toBe(false);
    expect(isHotbarPick(BLOCK.STONE)).toBe(true);
    expect(isHotbarPick(BLOCK.AIR)).toBe(true);
    expect(isHotbarPick(256)).toBe(false);
    expect(isHotbarPick(1.5)).toBe(false);
  });

  it('every item that is not a block is a pick, with a name and itself as the item in hand', () => {
    const items = Object.values(ITEMS).filter((d) => d.kind !== 'block');
    expect(items.length).toBeGreaterThan(100);
    for (const d of items) {
      expect(isItemPick(d.key)).toBe(true);
      expect(pickItemKey(d.key)).toBe(d.key);
      expect(pickName(d.key)).toBe(d.name);
    }
  });

  it('a block pick holds its item; AIR holds nothing', () => {
    expect(pickItemKey(BLOCK.OAK_PLANKS)).toBe('oak_planks');
    expect(pickItemKey(BLOCK.AIR)).toBeNull();
    expect(pickName(BLOCK.OAK_PLANKS)).toBe('Oak Planks');
  });

  it('reads an old key under its new name', () => {
    expect(normalizePick('stone_hammer')).toBe('hammerstone');
    expect(normalizePick('nonsense')).toBeNull();
    expect(normalizePick(BLOCK.GLASS)).toBe(BLOCK.GLASS);
  });

  it('main restores a hotbar with items (and refuses a broken one)', () => {
    const bar = [...DEFAULT_HOTBAR];
    bar[2] = 'iron_pick';
    bar[3] = 'stone_hammer';
    expect(hotbarFrom(bar)).toEqual([...DEFAULT_HOTBAR.slice(0, 2), 'iron_pick', 'hammerstone', ...DEFAULT_HOTBAR.slice(4)]);
    bar[4] = 'not_an_item';
    expect(hotbarFrom(bar)).toEqual([...DEFAULT_HOTBAR]);
  });
});

describe('saves keep item picks', () => {
  const save = (hotbar) => ({
    version: SAVE_VERSION, seed: 1, time: 0.3, day: 1, player: { x: 0.5, y: 70, z: 0.5, yaw: 0, pitch: 0, flying: false },
    hotbar, selected: 0, edits: {},
  });

  it('round-trips a hotbar with tools in it', () => {
    const bar = [...DEFAULT_HOTBAR];
    bar[0] = 'steel_sword';
    bar[8] = 'flint_spear';
    const back = deserializeSave(serializeSave(save(bar)));
    expect(back.data ? back.data.hotbar : back.hotbar).toEqual(bar);
  });

  it('an unknown item makes the hotbar the default (as any bad slot did)', () => {
    const bar = [...DEFAULT_HOTBAR];
    bar[0] = 'mystery';
    const parsed = JSON.parse(serializeSave(save(bar)));
    expect(parsed.hotbar).not.toContain('mystery');
  });
});

describe('the HUD draws an item in a Creative slot', () => {
  it('draws its picture (not a block) and remembers it', () => {
    const doc = documentFromHTML(html);
    const hud = createHUD(/** @type {any} */ (doc), /** @type {any} */ ({ width: 256, height: 256 }));
    const bar = [...DEFAULT_HOTBAR];
    bar[1] = 'iron_pick';
    expect(() => hud.setHotbar(bar, 1)).not.toThrow();
    hud.setHotbar(bar, 1); // unchanged: nothing redrawn
    bar[1] = 'not_an_item'; // anything else is an empty slot
    expect(() => hud.setHotbar(bar, 1)).not.toThrow();
  });
});

describe('what each player holds reaches the others', () => {
  it('cleanHeld keeps an item key and nothing else', () => {
    expect(cleanHeld('steel_sword')).toBe('steel_sword');
    expect(cleanHeld('oak_planks')).toBe('oak_planks');
    expect(cleanHeld(null)).toBeNull();
    expect(cleanHeld('<script>')).toBeNull();
    expect(cleanHeld('x'.repeat(60))).toBeNull();
    expect(cleanHeld('no_such_item')).toBeNull();
    expect(cleanHeld(5)).toBeNull();
  });

  it('the server tells the others when it changes, and a newcomer what everyone holds', () => {
    const game = new ServerGame({ name: 't', seed: 9 });
    const sock = () => {
      const s = { sent: [], send: (t) => s.sent.push(decode(t)), close() {} };
      return s;
    };
    const a = sock();
    const b = sock();
    const hello = (token) => ({ t: 'hello', v: PROTOCOL_VERSION, name: token, avatar: 'caelan', token: `token-${token}-1` });
    const pa = game.join(a, hello('aaaa'));
    game.join(b, hello('bbbb'));
    b.sent.length = 0;
    game.onMessage(pa, { t: 'held', item: 'steel_sword' });
    game.onMessage(pa, { t: 'held', item: 'steel_sword' }); // no change: nothing sent
    game.onMessage(pa, { t: 'held', item: '<bad>' }); // an empty hand
    expect(b.sent).toEqual([{ t: 'held', id: pa.id, item: 'steel_sword' }, { t: 'held', id: pa.id, item: null }]);
    expect(a.sent.some((m) => m.t === 'held')).toBe(false);
    game.onMessage(pa, { t: 'held', item: 'flint_spear' });
    const c = sock();
    game.join(c, hello('cccc'));
    expect(c.sent[0].players.find((p) => p.id === pa.id).held).toBe('flint_spear');
  });

  it('RemotePlayers keeps each one’s held item', () => {
    const rp = new RemotePlayers();
    rp.join({ id: 3, name: 'Brayden', avatar: 'brayden', pose: null, held: 'iron_pick' }, 0);
    expect(rp.list()[0].held).toBe('iron_pick');
    rp.setHeld(3, 'bronze_sword');
    expect(rp.list()[0].held).toBe('bronze_sword');
    rp.setHeld(3, 42);
    expect(rp.list()[0].held).toBeNull();
    rp.setHeld(99, 'iron_pick'); // nobody: ignored
    expect(getItem('bronze_sword')).not.toBeNull();
  });
});
