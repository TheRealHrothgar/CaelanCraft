// controls.js in touch mode (CONTRACTS §95, docs/DESIGN-multiplayer.md §5): the virtual lock and the virtual input the
// on-screen controls feed. The desktop path (a real pointer lock) must not change.
import { describe, it, expect } from 'vitest';
import { createControls } from '../../src/controls.js';
import { MOUSE_SENSITIVITY, PITCH_LIMIT } from '../../src/config.js';

/** A canvas, a document and a window as plain EventTargets (pointer lock is a property the test sets). */
function setup() {
  const win = new EventTarget();
  const doc = /** @type {any} */ (new EventTarget());
  doc.defaultView = win;
  doc.pointerLockElement = null;
  doc.visibilityState = 'visible';
  const canvas = /** @type {any} */ (new EventTarget());
  let requests = 0;
  canvas.requestPointerLock = () => {
    requests++;
  };
  doc.exitPointerLock = () => {
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  const controls = createControls(canvas, doc);
  /** @type {boolean[]} */
  const changes = [];
  controls.onLockChange = (locked) => changes.push(locked);
  return { win, doc, canvas, controls, changes, requests: () => requests };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const key = (type, code, extra = {}) => Object.assign(new Event(type), { code, key: '', repeat: false, ...extra });
const mouse = (type, props) => Object.assign(new Event(type), props);

/** Touch mode on and the virtual lock held (as enterPlaying leaves it). */
async function touchLocked() {
  const s = setup();
  s.controls.setTouchMode(true);
  s.controls.lock();
  await tick();
  s.changes.length = 0;
  return s;
}

describe('controls: desktop is unchanged', () => {
  it('starts in desktop mode; lock() requests a real pointer lock; virtual input needs that lock', () => {
    const { controls, canvas, doc, requests } = setup();
    expect(controls.touchMode).toBe(false);
    controls.lock();
    expect(requests()).toBe(1);
    expect(controls.locked).toBe(false);
    controls.virtualKey('KeyR', true);
    expect(controls.consumePressed('KeyR')).toBe(false); // not locked: ignored, like a real key
    doc.pointerLockElement = canvas;
    doc.dispatchEvent(new Event('pointerlockchange'));
    expect(controls.locked).toBe(true);
    doc.dispatchEvent(key('keydown', 'KeyW'));
    expect(controls.getInput().forward).toBe(1);
    doc.dispatchEvent(mouse('mousemove', { movementX: 10, movementY: 0 }));
    expect(controls.yaw).toBeCloseTo(-10 * MOUSE_SENSITIVITY, 9);
  });
});

describe('controls: touch mode and the virtual lock', () => {
  it('lock() and unlock() set the lock at once and report it a microtask later; no real lock is requested', async () => {
    const { controls, changes, requests } = setup();
    controls.setTouchMode(true);
    expect(controls.touchMode).toBe(true);
    controls.lock();
    expect(requests()).toBe(0);
    expect(controls.locked).toBe(true);
    expect(changes).toEqual([]);
    await tick();
    expect(changes).toEqual([true]);
    controls.unlock();
    expect(controls.locked).toBe(false);
    await tick();
    expect(changes).toEqual([true, false]);
    controls.unlock();
    await tick();
    expect(changes).toEqual([true, false]); // no change, no report
  });

  it('the window losing focus or the page being hidden lets go of the lock (main pauses, as on a desktop)', async () => {
    const s = await touchLocked();
    s.win.dispatchEvent(new Event('blur'));
    await tick();
    expect(s.controls.locked).toBe(false);
    expect(s.changes).toEqual([false]);
    s.controls.lock();
    await tick();
    s.doc.visibilityState = 'hidden';
    s.doc.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(s.changes).toEqual([false, true, false]);
  });

  it('a hidden page in DESKTOP mode does nothing new (the real lock handles itself)', async () => {
    const { controls, doc, changes } = setup();
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(changes).toEqual([]);
    expect(controls.locked).toBe(false);
  });

  it('mouse look is off in touch mode (a tap\'s compatibility mousemove never turns the view)', async () => {
    const { controls, doc } = await touchLocked();
    doc.dispatchEvent(mouse('mousemove', { movementX: 50, movementY: 20 }));
    expect(controls.yaw).toBe(0);
    expect(controls.pitch).toBe(0);
  });

  it('a hardware keyboard still plays while the virtual lock is held', async () => {
    const { controls, doc } = await touchLocked();
    doc.dispatchEvent(key('keydown', 'KeyE'));
    expect(controls.consumePressed('KeyE')).toBe(true);
  });

  it('switching touch mode off goes back to the real lock', async () => {
    const { controls, requests } = await touchLocked();
    controls.setTouchMode(false);
    expect(controls.locked).toBe(false);
    controls.lock();
    expect(requests()).toBe(1);
  });
});

describe('controls: the virtual input', () => {
  it('virtualKey is a keydown / keyup: held, one queued edge, and KeyF toggles flight', async () => {
    const { controls } = await touchLocked();
    controls.virtualKey('KeyR', true);
    expect(controls.isDown('KeyR')).toBe(true);
    expect(controls.consumePressed('KeyR')).toBe(true);
    expect(controls.consumePressed('KeyR')).toBe(false);
    controls.virtualKey('KeyR', false);
    expect(controls.isDown('KeyR')).toBe(false);
    controls.virtualKey('KeyF', true);
    controls.virtualKey('KeyF', false);
    expect(controls.consumeFlyToggle()).toBe(true);
    controls.virtualKey('ShiftLeft', true);
    expect(controls.getInput().sneak).toBe(true);
  });

  it('virtualButton is a mouse button on the canvas: held and pressed edges', async () => {
    const { controls } = await touchLocked();
    controls.virtualButton(0, true);
    let m = controls.consumeMouse();
    expect([m.left, m.leftPressed]).toEqual([true, true]);
    m = controls.consumeMouse();
    expect([m.left, m.leftPressed]).toEqual([true, false]);
    controls.virtualButton(0, false);
    controls.virtualButton(2, true);
    m = controls.consumeMouse();
    expect([m.left, m.right, m.rightPressed]).toEqual([false, true, true]);
    controls.virtualButton(2, false);
    controls.virtualButton(1, true);
    expect(controls.consumeMouse().middlePressed).toBe(true);
  });

  it('virtualLook turns the view by radians; pitch is clamped', async () => {
    const { controls } = await touchLocked();
    controls.virtualLook(0.3, -0.2);
    expect(controls.yaw).toBeCloseTo(0.3, 12);
    expect(controls.pitch).toBeCloseTo(-0.2, 12);
    controls.virtualLook(0, 10);
    expect(controls.pitch).toBe(PITCH_LIMIT);
    controls.virtualLook(Number.NaN, Number.NaN);
    expect(controls.pitch).toBe(PITCH_LIMIT);
  });

  it('setVirtualMove: analog forward / strafe where no key moves; keys win; sprint only forward', async () => {
    const { controls, doc } = await touchLocked();
    controls.setVirtualMove(0.5, -0.25, true);
    let inp = controls.getInput();
    expect([inp.forward, inp.strafe, inp.sprint]).toEqual([0.5, -0.25, true]);
    expect(controls.isSprinting()).toBe(true);
    controls.setVirtualMove(-0.5, 0, true);
    expect(controls.getInput().sprint).toBe(false);
    controls.setVirtualMove(3, -3, false);
    inp = controls.getInput();
    expect([inp.forward, inp.strafe]).toEqual([1, -1]);
    controls.setVirtualMove(0.4, 0.4, false);
    doc.dispatchEvent(key('keydown', 'KeyS'));
    inp = controls.getInput();
    expect([inp.forward, inp.strafe]).toEqual([-1, 0.4]);
  });

  it('setVirtualJump is a held jump', async () => {
    const { controls } = await touchLocked();
    controls.setVirtualJump(true);
    expect(controls.getInput().jump).toBe(true);
    controls.setVirtualJump(false);
    expect(controls.getInput().jump).toBe(false);
  });

  it('nothing virtual is taken while unlocked or disabled; disabling clears it; releases always count', async () => {
    const s = setup();
    s.controls.setTouchMode(true);
    s.controls.setVirtualMove(1, 0, true);
    s.controls.setVirtualJump(true);
    s.controls.virtualLook(1, 1);
    s.controls.virtualButton(0, true);
    expect(s.controls.getInput().forward).toBe(0);
    expect(s.controls.getInput().jump).toBe(false);
    expect(s.controls.yaw).toBe(0);
    expect(s.controls.consumeMouse().leftPressed).toBe(false);
    s.controls.lock();
    await tick();
    s.controls.setVirtualMove(1, 0, false);
    s.controls.setVirtualJump(true);
    s.controls.virtualButton(0, true);
    s.controls.setEnabled(false);
    const inp = s.controls.getInput();
    expect([inp.forward, inp.jump]).toEqual([0, false]);
    expect(s.controls.consumeMouse().left).toBe(false);
    s.controls.setEnabled(true);
    s.controls.virtualKey('KeyR', true);
    s.controls.unlock();
    await tick();
    expect(s.controls.isDown('KeyR')).toBe(false); // the lock change cleared it
  });

  it('dispose removes the visibility listener too', async () => {
    const { controls, doc, changes } = await touchLocked();
    controls.dispose();
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(changes).toEqual([]);
  });
});
