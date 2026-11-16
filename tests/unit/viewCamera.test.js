// The view modes, the third-person boom (viewCamera.js) and the avatar's motion (avatarMotion.js). CONTRACTS §91.
import { describe, it, expect } from 'vitest';
import {
  VIEW_MODES, VIEW_LABELS, VIEW_PREF_KEY, normalizeViewMode, nextViewMode, isThirdPerson, loadViewPref, saveViewPref,
  blocksCamera, lookVector, boomDirection, boomLength, easeBoom, cameraPose,
} from '../../src/viewCamera.js';
import { AvatarMotion, wrapAngle, LEG_SWING, SWING_REACH, DRAW_BACK, FP_DRAW_DROP } from '../../src/avatarMotion.js';
import { GAME_KEYS } from '../../src/controls.js';
import { parseParams } from '../../src/diagnostics.js';
import { BLOCK } from '../../src/blocks.js';
import { worldToHex, hexToWorld } from '../../src/hex.js';
import {
  VIEW_BOOM_LENGTH, VIEW_BOOM_MARGIN, VIEW_BOOM_EASE, AVATAR_HEAD_YAW_MAX, AVATAR_HEAD_PITCH_MAX, AVATAR_SWING_S,
  AVATAR_STRIDE_M, WALK_SPEED,
} from '../../src/config.js';

/** A world of air with the given solid cells ("q,y,r"). */
function worldWith(cells, id = BLOCK.STONE) {
  const set = new Set(cells);
  return (q, y, r) => (set.has(`${q},${y},${r}`) ? id : BLOCK.AIR);
}
/** The cell containing a world point. */
const cellAt = (x, y, z) => {
  const [q, r] = worldToHex(x, z);
  return `${q},${Math.floor(y)},${r}`;
};
const EYE = [0.2, 70.6, 0.3];

describe('view modes (V)', () => {
  it('V cycles first → behind → front → first; labels name each', () => {
    expect(VIEW_MODES).toEqual(['first', 'behind', 'front']);
    expect(nextViewMode('first')).toBe('behind');
    expect(nextViewMode('behind')).toBe('front');
    expect(nextViewMode('front')).toBe('first');
    expect(VIEW_LABELS).toEqual({ first: 'First person view', behind: 'Third person view', front: 'Front view' });
    expect([isThirdPerson('first'), isThirdPerson('behind'), isThirdPerson('front')]).toEqual([false, true, true]);
    expect(GAME_KEYS.has('KeyV')).toBe(true);
  });

  it('normalizeViewMode: the three names in any case, "third" is behind, anything else null', () => {
    expect(normalizeViewMode('FIRST')).toBe('first');
    expect(normalizeViewMode(' third ')).toBe('behind');
    expect(normalizeViewMode('front')).toBe('front');
    for (const bad of ['', 'top', null, 3]) expect(normalizeViewMode(bad)).toBeNull();
  });

  it('the screenshot aids: ?view=, ?avatar= and ?ui=avatars', () => {
    expect(parseParams('?view=third').view).toBe('behind');
    expect(parseParams('?view=Front').view).toBe('front');
    expect(parseParams('?view=nope').view).toBeNull();
    expect(parseParams('?avatar=Annabelle').avatar).toBe('annabelle');
    expect(parseParams('?avatar=steve').avatar).toBeNull();
    expect(parseParams('').avatarMenu).toBe(false);
    expect(parseParams('?ui=avatars').avatarMenu).toBe(true);
    expect(parseParams('?ui=avatars').ui).toBeNull(); // not one of the ?autoplay ui aids
    // ?hold=<item>: an item that is not a block, any case; anything else null
    expect(parseParams('?hold=iron_pick').hold).toBe('iron_pick');
    expect(parseParams('?hold=Steel_Sword').hold).toBe('steel_sword');
    for (const bad of ['', 'stone', 'grass', 'nonsense', '7']) expect(parseParams(`?hold=${bad}`).hold, bad).toBeNull();
    expect(parseParams('').hold).toBeNull();
  });

  it('the mode is a stored preference: first person by default; first person removes the key', () => {
    const m = new Map();
    const s = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
    expect(VIEW_PREF_KEY).toBe('caelancraft:v2:view');
    expect(loadViewPref(s)).toBe('first');
    expect(saveViewPref(s, 'front')).toBe(true);
    expect(m.get(VIEW_PREF_KEY)).toBe('front');
    expect(loadViewPref(s)).toBe('front');
    expect(saveViewPref(s, 'first')).toBe(true);
    expect(m.has(VIEW_PREF_KEY)).toBe(false);
    expect(saveViewPref(s, 'nope')).toBe(false);
    expect(loadViewPref(null)).toBe('first');
    const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
    expect(loadViewPref(bad)).toBe('first');
    expect(saveViewPref(bad, 'front')).toBe(false);
  });
});

describe('the third-person boom', () => {
  it('runs back along the look (behind) or forward along it (front); none in first person', () => {
    const look = lookVector(0.3, -0.2);
    expect(Math.hypot(...look)).toBeCloseTo(1, 12);
    expect(lookVector(0, 0)).toEqual([-0, 0, -1]); // yaw 0 faces −Z
    expect(boomDirection(0.3, -0.2, 'behind')).toEqual(look.map((v) => -v));
    expect(boomDirection(0.3, -0.2, 'front')).toEqual(look);
    expect(boomDirection(0.3, -0.2, 'first')).toBeNull();
  });

  it('in open air the boom is its full length; in first person it is 0', () => {
    const air = worldWith([]);
    expect(boomLength(air, ...EYE, 1.1, -0.3, 'behind')).toBe(VIEW_BOOM_LENGTH);
    expect(boomLength(air, ...EYE, 1.1, -0.3, 'front')).toBe(VIEW_BOOM_LENGTH);
    expect(boomLength(air, ...EYE, 1.1, -0.3, 'first')).toBe(0);
    expect(blocksCamera(BLOCK.STONE)).toBe(true);
    expect(blocksCamera(BLOCK.AIR)).toBe(false);
    expect(blocksCamera(BLOCK.GLASS)).toBe(true); // solid, if see-through: the camera never goes into it
  });

  it('a wall behind stops it short by the margin; a wall in front only matters in the front view', () => {
    // looking along −Z (yaw 0, level): behind is +Z
    const [ex, ey, ez] = EYE;
    const wallZ = 2.4; // a cell 2.4 behind the eye
    const wall = [];
    for (let dx = -3; dx <= 3; dx++) for (let dy = -2; dy <= 2; dy++) wall.push(cellAt(ex + dx * 0.5, ey + dy, ez + wallZ));
    const get = worldWith(wall);
    const b = boomLength(get, ex, ey, ez, 0, 0, 'behind');
    expect(b).toBeLessThan(wallZ - VIEW_BOOM_MARGIN + 0.05);
    expect(b).toBeGreaterThan(wallZ - 1 - VIEW_BOOM_MARGIN); // the wall's cell begins within a cell of wallZ
    expect(boomLength(get, ex, ey, ez, 0, 0, 'front')).toBe(VIEW_BOOM_LENGTH);
    // turned round (yaw π: looking +Z) the same wall is in front
    expect(boomLength(get, ex, ey, ez, Math.PI, 0, 'front')).toBeCloseTo(b, 6);
  });

  it('a block just beside the boom (inside the camera\'s square) shortens it; one well clear does not', () => {
    // the boom runs along +Z from the eye (looking −Z); one cell 3 m back, its centre 0.62 to the side: the centre ray
    // passes outside the hexagon (half a cell across the flats), the ray to the camera square's right-hand corners does not
    const [cx, cz] = hexToWorld(2, 4);
    const ex = cx - 0.62;
    const ey = 70.6;
    const ez = cz - 3;
    const nearX = worldWith([`2,70,4`]);
    const centreOnly = boomLength(nearX, ex, ey, ez, 0, 0, 'behind', { spread: 0 });
    const withSpread = boomLength(nearX, ex, ey, ez, 0, 0, 'behind');
    expect(centreOnly).toBe(VIEW_BOOM_LENGTH); // the centre ray alone slips past it
    expect(withSpread).toBeLessThan(VIEW_BOOM_LENGTH);
    const far = worldWith([cellAt(ex + 2.5, ey, ez + 3)]);
    expect(boomLength(far, ex, ey, ez, 0, 0, 'behind')).toBe(VIEW_BOOM_LENGTH);
  });

  it('a block right behind the camera point (within the margin) also pulls it in; never below 0', () => {
    const [ex, ey, ez] = EYE;
    const get = worldWith([cellAt(ex, ey, ez + VIEW_BOOM_LENGTH + 0.6)]);
    expect(boomLength(get, ex, ey, ez, 0, 0, 'behind')).toBeLessThanOrEqual(VIEW_BOOM_LENGTH);
    const inside = worldWith([cellAt(ex, ey, ez)]);
    expect(boomLength(inside, ex, ey, ez, 0, 0, 'behind')).toBe(0);
  });

  it('easeBoom snaps in and eases out (monotonic, never past the target)', () => {
    expect(easeBoom(4, 1.5, 0.016)).toBe(1.5);
    expect(easeBoom(NaN, 3, 0.016)).toBe(3);
    let b = 0.5;
    const seen = [];
    for (let i = 0; i < 200; i++) {
      b = easeBoom(b, 4, 1 / 60);
      seen.push(b);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[0]).toBeLessThan(0.5 + (4 - 0.5) * (VIEW_BOOM_EASE / 60) + 1e-9);
    expect(seen.at(-1)).toBe(4);
    expect(Math.max(...seen)).toBeLessThanOrEqual(4);
  });

  it('cameraPose: the eye in first person; behind along −look keeping the look; in front along +look looking back', () => {
    const [ex, ey, ez] = EYE;
    const yaw = 0.7;
    const pitch = -0.3;
    const look = lookVector(yaw, pitch);
    const first = cameraPose(ex, ey, ez, yaw, pitch, 'first', 4);
    expect([first.x, first.y, first.z, first.yaw, first.pitch]).toEqual([ex, ey, ez, yaw, pitch]);
    const behind = cameraPose(ex, ey, ez, yaw, pitch, 'behind', 3);
    expect(behind.x).toBeCloseTo(ex - look[0] * 3, 12);
    expect(behind.y).toBeCloseTo(ey - look[1] * 3, 12);
    expect(behind.z).toBeCloseTo(ez - look[2] * 3, 12);
    expect([behind.yaw, behind.pitch]).toEqual([yaw, pitch]);
    const front = cameraPose(ex, ey, ez, yaw, pitch, 'front', 3);
    expect(front.x).toBeCloseTo(ex + look[0] * 3, 12);
    expect(front.z).toBeCloseTo(ez + look[2] * 3, 12);
    expect(front.pitch).toBe(-pitch);
    // looking back at the eye: the camera's own look points from it to the eye
    const back = lookVector(front.yaw, front.pitch);
    for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(-look[k], 12);
    expect(Math.abs(front.yaw)).toBeLessThanOrEqual(Math.PI);
  });
});

describe('the avatar\'s motion (avatarMotion.js)', () => {
  const still = (over = {}) => ({ yaw: 0, pitch: 0, vx: 0, vz: 0, onGround: true, ...over });

  it('the head turns first; the body follows with a lag and never lets the head turn past its limit', () => {
    const m = new AvatarMotion();
    m.step(1 / 60, still());
    let p = m.step(1 / 60, still({ yaw: 0.5 }));
    expect(p.headYaw).toBeGreaterThan(0.4); // the head is nearly there at once
    expect(Math.abs(wrapAngle(p.bodyYaw + p.headYaw - 0.5))).toBeLessThan(1e-9);
    for (let i = 0; i < 120; i++) p = m.step(1 / 60, still({ yaw: 0.5 }));
    expect(Math.abs(p.headYaw)).toBeLessThan(0.01); // two seconds on, the body has caught up
    p = m.step(1 / 60, still({ yaw: 0.5 + 2.5 }));
    expect(Math.abs(p.headYaw)).toBeCloseTo(AVATAR_HEAD_YAW_MAX, 9);
    expect(wrapAngle(p.bodyYaw + p.headYaw - (0.5 + 2.5))).toBeCloseTo(0, 9);
  });

  it('the head nods with the look, clamped', () => {
    const m = new AvatarMotion();
    expect(m.step(1 / 60, still({ pitch: 0.3 })).headPitch).toBeCloseTo(0.3, 9);
    expect(m.step(1 / 60, still({ pitch: 1.5 })).headPitch).toBeCloseTo(AVATAR_HEAD_PITCH_MAX, 9);
    expect(m.step(1 / 60, still({ pitch: -1.5 })).headPitch).toBeCloseTo(-AVATAR_HEAD_PITCH_MAX, 9);
  });

  it('a walk cycle scaled by the speed: the phase runs with the distance, legs and arms swing against each other', () => {
    const m = new AvatarMotion();
    let p = m.step(1 / 60, still());
    for (let i = 0; i < 60; i++) p = m.step(1 / 60, still());
    expect(Math.abs(p.legSwing)).toBeLessThan(1e-9); // standing still: no stride
    const phase0 = m.phase;
    let maxLeg = 0;
    for (let i = 0; i < 120; i++) {
      p = m.step(1 / 60, still({ vz: -WALK_SPEED }));
      maxLeg = Math.max(maxLeg, Math.abs(p.legSwing));
      if (Math.abs(p.legSwing) > 0.05) expect(Math.sign(p.armSwing)).toBe(-Math.sign(p.legSwing));
    }
    expect(maxLeg).toBeGreaterThan(LEG_SWING * 0.8);
    expect(maxLeg).toBeLessThanOrEqual(LEG_SWING + 1e-9);
    // 2 s at walking pace: the phase moved π per stride
    const travelled = ((m.phase - phase0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    expect(travelled).toBeCloseTo(((WALK_SPEED * 2 * Math.PI) / AVATAR_STRIDE_M) % (2 * Math.PI), 6);
    // a slow walk swings less
    const slow = new AvatarMotion();
    let maxSlow = 0;
    for (let i = 0; i < 120; i++) maxSlow = Math.max(maxSlow, Math.abs(slow.step(1 / 60, still({ vx: 1 })).legSwing));
    expect(maxSlow).toBeLessThan(maxLeg * 0.5);
  });

  it('a swing of the right arm lasts AVATAR_SWING_S and is highest along the way; then the arm is back', () => {
    const m = new AvatarMotion();
    m.step(1 / 60, still());
    m.swing();
    expect(m.swinging).toBe(true);
    let top = 0;
    let p = m.pose;
    for (let t = 0; t < AVATAR_SWING_S + 0.05; t += 1 / 60) {
      p = m.step(1 / 60, still());
      top = Math.max(top, p.reachR);
      if (m.swinging) expect(p.fpSwing).toBeGreaterThanOrEqual(0);
    }
    expect(top).toBeGreaterThan(SWING_REACH * 0.95);
    expect(m.swinging).toBe(false);
    expect(p.reachR).toBe(0);
    expect(p.fpSwing).toBe(-1);
  });

  it('§100: a draw pulls the right arm back (DRAW_BACK at full) and sinks the first-person arm; let go, it is back', () => {
    const m = new AvatarMotion();
    const rest = { ...m.step(1 / 60, still()) };
    let p = m.step(1 / 60, still({ draw: 1 }));
    expect(p.reachR).toBeCloseTo(-DRAW_BACK, 9);
    expect(p.fpBobY).toBeCloseTo(rest.fpBobY - FP_DRAW_DROP, 2);
    p = m.step(1 / 60, still({ draw: 0.5 }));
    expect(p.reachR).toBeCloseTo(-DRAW_BACK / 2, 9);
    p = m.step(1 / 60, still());
    expect(p.reachR).toBe(0);
  });

  it('sneaking crouches (leaning forward, hips lower); riding sits with the legs forward; asleep it lies on its back', () => {
    const m = new AvatarMotion();
    let p = m.pose;
    for (let i = 0; i < 60; i++) p = m.step(1 / 60, still({ sneaking: true }));
    expect(p.lean).toBeLessThan(-0.4);
    expect(p.hipDrop).toBeGreaterThan(0.05);
    const r = new AvatarMotion();
    p = r.step(1 / 60, still({ riding: true }));
    expect(p.ride).toBe(1);
    expect(p.legRaise).toBeGreaterThan(1);
    const s = new AvatarMotion();
    for (let i = 0; i < 240; i++) p = s.step(1 / 60, still({ sleeping: true }));
    expect(p.bodyPitch).toBeCloseTo(Math.PI / 2, 2);
    expect(p.lie).toBeGreaterThan(0.99);
    const w = new AvatarMotion();
    for (let i = 0; i < 120; i++) p = w.step(1 / 60, still({ swimming: true, onGround: false, vz: -2 }));
    expect(p.bodyPitch).toBeLessThan(-0.8); // swimming: tipped forward
  });

  it('dt 0 (a paused world) changes nothing; reset faces the body to the look', () => {
    const m = new AvatarMotion();
    for (let i = 0; i < 30; i++) m.step(1 / 60, still({ vz: -WALK_SPEED }));
    const before = JSON.stringify(m.pose);
    const after = JSON.stringify(m.step(0, still({ vz: -WALK_SPEED })));
    expect(after).toBe(before);
    m.reset(1.2);
    expect(m.step(0, still({ yaw: 1.2 })).headYaw).toBeCloseTo(0, 12);
    expect(m.walk).toBe(0);
  });
});
