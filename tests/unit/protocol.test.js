// src/protocol.js — the multiplayer wire format (docs/DESIGN-multiplayer.md §3): the decoder and the cleaners that turn
// whatever arrives into well-formed values or null.
import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION, MAX_NAME, MAX_CHAT, POSE_FLYING, POSE_SWING, encode, decode, cleanName, cleanChat, cleanPose, packPose,
  unpackPose, cleanCell, cleanBrick, unflatten4,
} from '../../src/protocol.js';
import { WORLD_HEIGHT } from '../../src/config.js';

describe('encode / decode', () => {
  it('round-trips a message', () => {
    const m = { t: 'set', q: 1, y: 2, r: -3, id: 4 };
    expect(decode(encode(m))).toEqual(m);
  });

  it('refuses what is not an object with a string type', () => {
    for (const text of ['', 'nope', '42', '"s"', 'null', '[1,2]', '{"x":1}', '{"t":5}', '{"t":null}']) expect(decode(text)).toBeNull();
    expect(decode(/** @type {any} */ (42))).toBeNull();
    expect(decode(undefined)).toBeNull();
  });

  it('drops a message longer than the limit unread', () => {
    const text = encode({ t: 'chat', text: 'x'.repeat(100) });
    expect(decode(text, text.length)).not.toBeNull();
    expect(decode(text, text.length - 1)).toBeNull();
  });

  it('has a version', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
  });
});

describe('cleanName / cleanChat', () => {
  it('keeps a plain name', () => {
    expect(cleanName('Caelan')).toBe('Caelan');
    expect(cleanName('  Dad  ')).toBe('Dad');
  });

  it('removes control characters and angle brackets, and cuts to MAX_NAME', () => {
    expect(cleanName('<b>Bob</b>')).toBe('bBob/b');
    expect(cleanName('a\u0000b\nc')).toBe('abc');
    expect(cleanName('x'.repeat(50))).toHaveLength(MAX_NAME);
  });

  it('falls back when nothing is left', () => {
    expect(cleanName('', 'Player')).toBe('Player');
    expect(cleanName('   ')).toBe('Player');
    expect(cleanName(42, 'Fallback')).toBe('Fallback');
    expect(cleanName(null, '')).toBe('');
  });

  it('chat: control characters become spaces, trimmed, cut to MAX_CHAT', () => {
    expect(cleanChat('hi\tthere')).toBe('hi there');
    expect(cleanChat('  ')).toBe('');
    expect(cleanChat('x'.repeat(500))).toHaveLength(MAX_CHAT);
    expect(cleanChat({})).toBe('');
  });
});

describe('poses', () => {
  const ok = { x: 1.5, y: 70, z: -2.25, yaw: 1, pitch: 0.5, flags: POSE_FLYING, vx: 2, vz: -1 };

  it('accepts a sound pose', () => {
    expect(cleanPose(ok)).toEqual(ok);
  });

  it('refuses a pose with a missing or absurd number', () => {
    expect(cleanPose(null)).toBeNull();
    expect(cleanPose({ ...ok, x: NaN })).toBeNull();
    expect(cleanPose({ ...ok, y: undefined })).toBeNull();
    expect(cleanPose({ ...ok, z: Infinity })).toBeNull();
    expect(cleanPose({ ...ok, x: 1e9 })).toBeNull();
    expect(cleanPose({ ...ok, y: -100 })).toBeNull();
    expect(cleanPose({ ...ok, y: WORLD_HEIGHT + 1000 })).toBeNull();
    expect(cleanPose({ ...ok, yaw: '1' })).toBeNull();
  });

  it('wraps the yaw, clamps the pitch and the speed, masks the flags', () => {
    const p = cleanPose({ ...ok, yaw: -Math.PI / 2, pitch: 5, vx: 1000, vz: NaN, flags: 0xffff });
    expect(p.yaw).toBeCloseTo(1.5 * Math.PI);
    expect(p.pitch).toBeCloseTo(Math.PI / 2);
    expect(p.vx).toBe(100);
    expect(p.vz).toBe(0);
    expect(p.flags).toBe(31);
    expect(cleanPose({ ...ok, flags: 1.5 }).flags).toBe(0);
  });

  it('packs to a short array and back (3 decimals)', () => {
    const a = packPose(7, { ...ok, x: 1.23456, flags: POSE_SWING });
    expect(a).toEqual([7, 1.235, 70, -2.25, 1, 0.5, POSE_SWING, 2, -1]);
    expect(unpackPose(a)).toEqual({ id: 7, x: 1.235, y: 70, z: -2.25, yaw: 1, pitch: 0.5, flags: POSE_SWING, vx: 2, vz: -1 });
  });

  it('refuses a malformed packed pose', () => {
    expect(unpackPose(null)).toBeNull();
    expect(unpackPose([1, 2, 3])).toBeNull();
    expect(unpackPose([1.5, 0, 70, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(unpackPose([1, NaN, 70, 0, 0, 0, 0, 0, 0])).toBeNull();
  });
});

describe('cells and bricks', () => {
  it('cleanCell: integers, y inside the world, an id byte', () => {
    expect(cleanCell({ q: 1, y: 2, r: 3, id: 4, extra: 1 })).toEqual({ q: 1, y: 2, r: 3, id: 4 });
    expect(cleanCell({ q: 1.5, y: 2, r: 3, id: 4 })).toBeNull();
    expect(cleanCell({ q: 1, y: -1, r: 3, id: 4 })).toBeNull();
    expect(cleanCell({ q: 1, y: WORLD_HEIGHT, r: 3, id: 4 })).toBeNull();
    expect(cleanCell({ q: 1, y: 2, r: 3, id: 256 })).toBeNull();
    expect(cleanCell({ q: 1e8, y: 2, r: 3, id: 4 })).toBeNull();
    expect(cleanCell(null)).toBeNull();
  });

  it('cleanBrick: the same rules on (i, y, n)', () => {
    expect(cleanBrick({ i: -4, y: 60, n: 9, id: 12 })).toEqual({ i: -4, y: 60, n: 9, id: 12 });
    expect(cleanBrick({ i: -4, y: 60, n: '9', id: 12 })).toBeNull();
    expect(cleanBrick({ i: -4, y: 60, n: 9, id: -1 })).toBeNull();
  });

  it('unflatten4 keeps the sound quadruples and skips the rest', () => {
    expect(unflatten4([1, 2, 3, 4, 5, 6, 7, 8])).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
    expect(unflatten4([1, 2, 3, 4, 5, -1, 7, 8, 9, 10])).toEqual([[1, 2, 3, 4]]);
    expect(unflatten4([1, 2, 3, 999])).toEqual([]);
    expect(unflatten4('nope')).toEqual([]);
  });
});
