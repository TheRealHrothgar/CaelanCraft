// §97 Glass — the menus' and the tablet controls' look (src/styles.css), the touch buttons' words for the keys in hints
// (touchControls.touchWords, hud.setHintWords), the pause menu on a server, and when a dropped connection is joined again
// (net.shouldRejoin).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { touchWords, TOUCH_BUTTONS, PAD_BUTTONS, TOP_BUTTONS } from '../../src/touchControls.js';
import { createHUD } from '../../src/hud.js';
import { shouldRejoin, REJOIN_TRIES } from '../../src/net.js';
import { REPLACED_REASON } from '../../src/protocol.js';
import { HINT } from '../../src/survivalControl.js';
import { documentFromHTML } from '../helpers/fakeDom.js';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('../../src/styles.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule as [selector list, declarations]. */
function rules() {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m; (m = re.exec(css)); ) out.push([m[1].trim(), m[2]]);
  return out;
}

describe('the touch buttons say what they do', () => {
  it('Jump, Mine, Place, Action, Crouch, Drop; Menu, Pack, Camera, Chat (no Fly: a double tap of Jump)', () => {
    expect(PAD_BUTTONS.map((id) => TOUCH_BUTTONS[id].label)).toEqual(['Jump', 'Mine', 'Place', 'Action', 'Crouch', 'Drop']);
    expect(TOP_BUTTONS.map((id) => TOUCH_BUTTONS[id].label)).toEqual(['Menu', 'Pack', 'Camera', 'Chat']);
  });

  it('a hint written for the keyboard reads in those words', () => {
    expect(touchWords(HINT.basket)).toBe('Wicker Basket · Action: open');
    expect(touchWords(HINT.pit)).toBe('Cold Fire Pit · hold Action to relight (drill, tinder, 3 sticks)');
    expect(touchWords(HINT.fuseNeedsDrill)).toBe('Powder Fuse · needs a Fire Drill (Action button)');
    expect(touchWords('Clockwork Timer · R run · Shift+R edit')).toBe('Clockwork Timer · Action run · Crouch + Action edit');
    expect(touchWords('Shift+R key on a part tells you more.')).toBe('Crouch + Action on a part tells you more.');
    expect(touchWords('hold LMB to dig, RMB to eat')).toBe('hold Mine to dig, Place to eat');
    expect(touchWords('right-click a lever (Shift+right-click places)')).toBe('Place a lever (Crouch + Place places)');
    // §100.2: no button throws at once, so the G clause is left out (the draw is how a tablet throws)
    expect(touchWords('Flint Spear · Hold RMB to throw · G: throw at once')).toBe('Flint Spear · Hold Place to throw');
    expect(touchWords('A · G: one thing · B')).toBe('A · B');
    expect(touchWords('Bow · Hold RMB to draw, let go to shoot')).toBe('Bow · Hold Place to draw, let go to shoot');
  });

  it('leaves words that only contain an R alone', () => {
    for (const s of ['Rain Barrel', 'Relay · Rune Block', 'Iron Ore', 'R2D2', 'Brayden']) expect(touchWords(s)).toBe(s);
  });

  it('the HUD passes every hint through the filter it is given, and back', () => {
    const doc = documentFromHTML(html);
    const hud = createHUD(/** @type {any} */ (doc), /** @type {any} */ ({ width: 256, height: 256 }));
    const hint = /** @type {any} */ (doc.getElementById('target-hint'));
    hud.setTargetHint(HINT.read);
    expect(hint.textContent).toBe('Handbook · R: read');
    hud.setHintWords(touchWords);
    hud.setTargetHint(HINT.read); // the same text: drawn again in the new words
    expect(hint.textContent).toBe('Handbook · Action: read');
    hud.setHintWords(null);
    hud.setTargetHint(HINT.read);
    expect(hint.textContent).toBe('Handbook · R: read');
  });
});

describe('the glass (styles.css §97)', () => {
  it('every backdrop-filter has the -webkit- twin Safari reads, with the same literal value', () => {
    const glass = rules().filter(([, d]) => /(^|;)\s*backdrop-filter:/.test(d));
    expect(glass.length).toBeGreaterThan(8);
    for (const [sel, d] of glass) {
      const plain = /(?:^|;)\s*backdrop-filter:([^;]*)/.exec(d)[1].trim();
      const webkit = /-webkit-backdrop-filter:([^;]*)/.exec(d);
      expect(webkit, sel).not.toBeNull();
      expect(webkit[1].trim(), sel).toBe(plain);
      expect(plain, sel).not.toMatch(/var\(/); // a custom property does not resolve inside the prefixed one
    }
  });

  it('defines its tokens once, on :root', () => {
    const root = rules().filter(([s]) => s === ':root');
    expect(root).toHaveLength(1);
    for (const t of ['--ui-font', '--glass-panel', '--glass-control', '--glass-rim', '--honey']) expect(root[0][1]).toContain(`${t}:`);
  });

  it('falls back to a solid tint without backdrop-filter and under Reduce transparency', () => {
    expect(css).toMatch(/@supports not \(\(backdrop-filter:blur\(1px\)\) or \(-webkit-backdrop-filter:blur\(1px\)\)\)/);
    expect(css).toMatch(/@media \(prefers-reduced-transparency:reduce\)/);
  });

  it('on a server the pause menu offers only what the player decides', () => {
    const hidden = rules().find(([s, d]) => s.includes('html.on-server #pause-physics') && /display:none/.test(d));
    expect(hidden).toBeDefined();
    for (const id of ['btn-save', 'btn-stop-runes', 'pause-physics', 'btn-undo-physics', 'pause-creatures', 'pause-mode', 'pause-devices', 'pause-seed']) {
      expect(hidden[0]).toContain(`html.on-server #${id}`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('id="pause-players"');
    expect(rules().some(([s, d]) => s === 'html.on-server #pause-players' && /display:block/.test(d))).toBe(true);
  });

  it('a tablet shows no key sheet', () => {
    expect(rules().some(([s, d]) => s === 'html.touch #pause-controls,html.touch #title-controls' && /display:none/.test(d))).toBe(true);
  });
});

describe('joining again after the connection dropped (§97.4)', () => {
  const playing = { refused: false, inWorld: true, tries: 0 };

  it('a connection that dropped while playing is joined again, a few times', () => {
    expect(shouldRejoin('the server closed the connection', playing)).toBe(true);
    expect(shouldRejoin('could not reach the server', { ...playing, inWorld: false, tries: 1 })).toBe(true);
    expect(shouldRejoin('could not reach the server', { ...playing, inWorld: false, tries: REJOIN_TRIES })).toBe(false);
  });

  it('never after a refusal, a join from elsewhere, or a first join that failed', () => {
    expect(shouldRejoin('the server is full (8 players)', { ...playing, refused: true })).toBe(false);
    expect(shouldRejoin(REPLACED_REASON, playing)).toBe(false);
    expect(shouldRejoin('could not reach the server', { ...playing, inWorld: false })).toBe(false);
  });
});
