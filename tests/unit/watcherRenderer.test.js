// watcherRenderer.js, the watcher_* tiles and playWatcherVanish (CONTRACTS §40) — Node only (three core objects work
// without WebGL; a fake AudioContext records the voices).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  createWatcherRenderer, MODEL_HEIGHT, HEAD_Y, RING_COUNT, RING_R, RING_WALL, RING_H, RING_GAP, RING_BASE_Y, RING_SPIN,
  RING_BOB, NECK_GAP, LANTERN_H, LANTERN_R, LANTERN_RIM_H, LANTERN_WALL, POST_R, CORE_R, CORE_Y, CORE_H, EYE_X, EYE_R,
  EYE_COLOR, GLOW_MIN, GLOW_PER_M, CRACK_GLOW, CRACK_PULSE, CRACK_PULSE_S, SMOKE, WARM_Y, ringBaseY,
} from '../../src/watcherRenderer.js';
import { createFallingRenderer } from '../../src/fallingRenderer.js';
import { WATCHER_HEIGHT, WATCHER_EYE_Y, WATCHER_CENTRE_Y } from '../../src/watcher.js';
import { ATLAS_TILES_PER_ROW, TILE_UV } from '../../src/config.js';
import { TILE, tileToUV } from '../../src/blocks.js';
import { paintTile, averageColor, TILE_NAMES } from '../../src/tiles.js';
import { createAudio } from '../../src/audio.js';

const COS30 = Math.cos(Math.PI / 6);
const figure = (x, y, z, extra = {}) => ({ x, y, z, q: 0, r: 0, yaw: 0, headYaw: 0, headPitch: 0, kind: 'summon', ...extra });
const worldPos = (o) => {
  o.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
};
/** Every drawable part (meshes and sprites) of the figure. */
const partsOf = (r) => {
  const out = [];
  r.group.traverse((o) => { if (o.isMesh || o.isSprite) out.push(o); });
  return out;
};
/** What a ray from (x, y, z) along `dir` hits on the figure, nearest first, as part names. */
const hits = (r, from, dir) => {
  r.group.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(...from), new THREE.Vector3(...dir).normalize());
  const meshes = partsOf(r).filter((o) => o.isMesh); // (a Sprite needs a camera to be ray-tested)
  return ray.intersectObjects(meshes, false).map((h) => h.object.name);
};

describe('the Hollow Watcher model', () => {
  it('a floating stack of hollow hex rings under a hex lantern, smoke below — no limbs; the heights add up to 2.6', () => {
    expect(RING_COUNT).toBeGreaterThanOrEqual(4);
    expect(RING_COUNT).toBeLessThanOrEqual(5);
    expect(HEAD_Y).toBeCloseTo(RING_BASE_Y + RING_COUNT * RING_H + (RING_COUNT - 1) * RING_GAP + NECK_GAP, 9);
    expect(MODEL_HEIGHT).toBeCloseTo(HEAD_Y + LANTERN_H, 9);
    expect(MODEL_HEIGHT).toBeCloseTo(WATCHER_HEIGHT, 9);
    // It floats: the lowest ring hovers 0.5–0.9 above its feet, with open gaps between the rings.
    expect(RING_BASE_Y).toBeGreaterThanOrEqual(0.5);
    expect(RING_BASE_Y).toBeLessThanOrEqual(0.9);
    expect(RING_GAP).toBeGreaterThan(2 * RING_BOB + 0.05);
    // Widest in the middle, narrowing toward the top and the bottom.
    const mid = RING_R.indexOf(Math.max(...RING_R));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(RING_COUNT - 1);
    for (let i = 0; i < mid; i++) expect(RING_R[i]).toBeLessThan(RING_R[i + 1]);
    for (let i = mid; i < RING_COUNT - 1; i++) expect(RING_R[i]).toBeGreaterThan(RING_R[i + 1]);
    // Its centre (what the gaze test aims at) is on the middle ring.
    expect(ringBaseY(mid)).toBeLessThanOrEqual(WATCHER_CENTRE_Y);
    expect(ringBaseY(mid) + RING_H).toBeGreaterThanOrEqual(WATCHER_CENTRE_Y);

    const scene = new THREE.Scene();
    const r = createWatcherRenderer(scene, null);
    const names = partsOf(r).map((o) => o.name).sort();
    expect(names).toEqual([
      'watcher-core', 'watcher-eye-l', 'watcher-eye-r', 'watcher-glow-l', 'watcher-glow-r', 'watcher-lantern',
      ...RING_R.map((_, i) => `watcher-ring-${i}`), 'watcher-smoke',
    ]);
    for (const n of names) expect(n).not.toMatch(/leg|arm|torso|neck|hand|foot|tail/); // nothing humanoid
    expect(names.length).toBeLessThanOrEqual(12); // one figure: a handful of draw calls
    expect(r.rings).toHaveLength(RING_COUNT);
    expect([r.lantern.name, r.core.name, r.smoke.name]).toEqual(['watcher-lantern', 'watcher-core', 'watcher-smoke']);

    r.sync(figure(5, 20, -3), 5, 21.6, 30, 0);
    for (const e of r.eyes) expect(worldPos(e).y).toBeCloseTo(20 + WATCHER_EYE_Y, 6);
    const box = new THREE.Box3().setFromObject(r.group);
    expect(box.max.y).toBeCloseTo(20 + WATCHER_HEIGHT, 6);
    expect(box.min.y).toBeGreaterThanOrEqual(20); // the smoke reaches down to its feet …
    expect(box.min.y).toBeLessThan(20.05); // … and no further
    const ring0 = new THREE.Box3().setFromObject(r.rings[0]);
    expect(ring0.min.y - 20).toBeCloseTo(RING_BASE_Y, 1);
    r.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it('every ring is an open hex frame: a thin six-sided wall, pointy-top like the cells, empty in the middle', () => {
    const scene = new THREE.Scene();
    const r = createWatcherRenderer(scene, null);
    r.rings.forEach((ring, i) => {
      const R = RING_R[i];
      const pos = ring.geometry.getAttribute('position');
      const radii = [];
      for (let k = 0; k < pos.count; k++) radii.push(Math.hypot(pos.getX(k), pos.getZ(k)));
      expect(Math.max(...radii)).toBeCloseTo(R, 6); // the outer corners
      // Hollow: no vertex nearer the axis than the inner wall's corners (a thin wall, no cap across the middle).
      expect(Math.min(...radii)).toBeCloseTo(R - RING_WALL / COS30, 6);
      expect(RING_WALL).toBeLessThan(R / 4);
      // Six outer walls 60° apart; at rest the corners point along ±Z like the world's cells (flats face ±X).
      const nor = ring.geometry.getAttribute('normal');
      const outer = new Set();
      for (let k = 0; k < nor.count; k++) {
        if (nor.getY(k) !== 0) continue;
        const px = pos.getX(k);
        const pz = pos.getZ(k);
        if (nor.getX(k) * px + nor.getZ(k) * pz <= 0) continue; // inner wall
        outer.add(Math.round((Math.atan2(nor.getZ(k), nor.getX(k)) * 180) / Math.PI + 360) % 360);
      }
      expect([...outer].sort((a, b) => a - b)).toEqual([0, 60, 120, 180, 240, 300]);
    });
    // You can see through it: straight down the axis, and across the gap between two rings.
    r.sync(figure(0, 0, 0), 0, 1.6, -30, 0);
    expect(hits(r, [0, -5, 0], [0, 1, 0]).filter((n) => n.startsWith('watcher-ring'))).toEqual([]);
    const gapY = ringBaseY(1) + RING_H + RING_GAP / 2;
    expect(hits(r, [0, gapY, -10], [0, 0, 1])).toEqual([]);
    // … while a ray at a ring's height meets its front wall, then its back wall.
    expect(hits(r, [0, ringBaseY(2) + RING_H / 2, -10], [0, 0, 1])).toEqual(['watcher-ring-2', 'watcher-ring-2']);
    r.dispose();
  });

  it('the head is a hex lantern: heavier rims, six slim posts, open sides, a dim inner glow behind the two lights', () => {
    const scene = new THREE.Scene();
    const r = createWatcherRenderer(scene, null);
    expect(LANTERN_WALL).toBeGreaterThan(RING_WALL); // heavier than the body's rings
    expect(POST_R).toBeLessThan(LANTERN_WALL / 2); // slim
    expect(LANTERN_RIM_H * 2).toBeLessThan(LANTERN_H / 3); // mostly open
    r.sync(figure(0, 0, 0), 0, 1.6, -30, 0);
    r.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(r.lantern);
    expect(box.min.y).toBeCloseTo(HEAD_Y, 6);
    expect(box.max.y).toBeCloseTo(WATCHER_HEIGHT, 6);
    // Through the front window (between the posts, above the bottom rim): no stone until the far side's posts.
    const y = HEAD_Y + LANTERN_RIM_H + 0.05;
    expect(hits(r, [0, y, -10], [0, 0, 1])).toEqual([]);
    expect(hits(r, [-10, y, 0.08], [1, 0, 0])).toEqual([]); // the sides are open too (between two posts)
    expect(hits(r, [-10, y, 0], [1, 0, 0])).toEqual(['watcher-lantern', 'watcher-lantern']); // … the posts on ±X
    // The core: unlit, translucent, fogged, inside the cage around the lights' height.
    const m = r.core.material;
    expect(m).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBeLessThan(1);
    expect(m.fog).toBe(true);
    expect(CORE_R).toBeLessThan(LANTERN_R / 2);
    expect(CORE_Y).toBeLessThan(WATCHER_EYE_Y - HEAD_Y);
    expect(CORE_Y + CORE_H).toBeGreaterThan(WATCHER_EYE_Y - HEAD_Y);
    expect(r.core.parent).toBe(r.head);
    expect(r.lantern.parent).toBe(r.head);
    r.dispose();
  });

  it('two small cyan lights side by side inside its front, at WATCHER_EYE_Y: unlit and fog-free, with additive glows', () => {
    const scene = new THREE.Scene();
    const r = createWatcherRenderer(scene, null);
    expect(r.eyes).toHaveLength(2);
    expect(r.glows).toHaveLength(2);
    for (const e of r.eyes) {
      expect(e.material).toBeInstanceOf(THREE.MeshBasicMaterial); // unlit: bright in the dark
      expect(e.material.fog).toBe(false);
      expect(e.material.color.getHex()).toBe(EYE_COLOR);
      const c = e.material.color;
      expect(c.g).toBeGreaterThan(c.r + 0.2); // cyan
      expect(c.b).toBeGreaterThan(c.r + 0.2);
      expect(e.geometry.index.count).toBe(6 * 3); // a small hexagon: six triangles
    }
    for (const g of r.glows) {
      expect(g.material.fog).toBe(false);
      expect(g.material.blending).toBe(THREE.AdditiveBlending);
      expect(g.material.depthWrite).toBe(false);
    }
    // Everything else fades into the fog like the world does.
    for (const p of [...r.rings, r.lantern, r.core, r.smoke]) expect(p.material.fog).toBe(true);
    // At yaw 0 the figure faces −Z: the lights sit either side of the middle, inside the lantern's front window,
    // in front of the core.
    r.sync(figure(0, 10, 0), 0, 11.6, -40, 0);
    const [l, rr] = r.eyes.map(worldPos);
    expect(l.x).toBeCloseTo(-EYE_X, 6);
    expect(rr.x).toBeCloseTo(EYE_X, 6);
    expect(EYE_X + EYE_R).toBeLessThan((LANTERN_R - LANTERN_WALL / 2 / COS30) / 2 - POST_R); // clear of the front posts
    for (const p of [l, rr]) {
      expect(p.y).toBeCloseTo(10 + WATCHER_EYE_Y, 6);
      expect(p.z).toBeGreaterThan(-LANTERN_R * COS30);
      expect(p.z).toBeLessThan(-CORE_R * COS30);
    }
    r.dispose();
  });

  it('sync: hidden without a figure; placed and turned by yaw; the lantern turns on its own; the glow keeps a few pixels', () => {
    const scene = new THREE.Scene();
    const r = createWatcherRenderer(scene, null);
    r.sync(null, 0, 0, 0, 0);
    expect(r.visible()).toBe(false);
    expect(r.group.visible).toBe(false);
    // Facing +Z (yaw π), the head turned a quarter (headYaw 3π/2) and tilted up by headPitch.
    r.sync(figure(3, 40, 7, { yaw: Math.PI, headYaw: Math.PI * 1.5, headPitch: 0.2 }), 3, 41.6, 60, 1);
    expect(r.visible()).toBe(true);
    expect(worldPos(r.group).toArray()).toEqual([3, 40, 7]);
    r.group.updateWorldMatrix(true, true);
    const bodyFront = new THREE.Vector3(0, 0, -1).transformDirection(r.group.matrixWorld);
    expect(bodyFront.z).toBeGreaterThan(0.99);
    const face = new THREE.Vector3(0, 0, -1).transformDirection(r.lantern.matrixWorld);
    // The lantern's front follows yawToForward(headYaw) = (−sin, −cos)(3π/2) = (1, 0): it looks toward +X, tilted up.
    expect(face.x).toBeGreaterThan(0.95);
    expect(face.y).toBeCloseTo(Math.sin(0.2), 6);
    const near = r.glows[0].scale.x;
    r.sync(figure(3, 40, 7, { yaw: Math.PI, headYaw: Math.PI }), 3, 41.6, 7 + 80, 1);
    expect(r.glows[0].scale.x).toBeCloseTo(Math.max(GLOW_MIN, 80 * GLOW_PER_M), 2);
    expect(r.glows[0].scale.x).toBeGreaterThan(near);
    r.sync(figure(3, 40, 7), 3, 41.6, 8, 1);
    expect(r.glows[0].scale.x).toBe(GLOW_MIN);
    r.dispose();
  });

  it('the rings turn very slowly, each its own way, and bob a few centimetres; the gaps never close', () => {
    const scene = new THREE.Scene();
    const r = createWatcherRenderer(scene, null);
    for (const s of RING_SPIN) {
      expect(Math.abs(s)).toBeGreaterThan(0);
      expect(Math.abs(s)).toBeLessThanOrEqual(0.1); // a sixth of a turn takes 10 s or more: eerie, not busy
    }
    expect(new Set(RING_SPIN).size).toBe(RING_COUNT);
    expect(RING_BOB).toBeLessThanOrEqual(0.05);
    const f = figure(0, 0, 0);
    r.sync(f, 0, 1.6, -30, 0);
    const a0 = r.rings.map((m) => m.rotation.y);
    const smoke0 = r.smoke.rotation.y;
    r.sync(f, 0, 1.6, -30, 10);
    r.rings.forEach((m, i) => expect(m.rotation.y - a0[i]).toBeCloseTo(RING_SPIN[i] * 10, 9));
    expect(r.smoke.rotation.y).not.toBe(smoke0);
    for (let t = 0; t < 12; t += 0.37) {
      r.sync(f, 0, 1.6, -30, t);
      r.rings.forEach((m, i) => {
        expect(Math.abs(m.position.y - ringBaseY(i))).toBeLessThanOrEqual(RING_BOB + 1e-9);
        if (i > 0) expect(m.position.y - (r.rings[i - 1].position.y + RING_H)).toBeGreaterThan(RING_GAP / 2);
      });
      expect(r.rings[0].position.y).toBeGreaterThanOrEqual(SMOKE[0].y1 - 1e-9); // the smoke stays under the stack
      expect(r.rings[RING_COUNT - 1].position.y + RING_H).toBeLessThan(HEAD_Y);
    }
    r.dispose();
  });

  it('a thin wisp of smoke trails to the ground: stacked hex tubes, shrinking and fading downward', () => {
    const scene = new THREE.Scene();
    const r = createWatcherRenderer(scene, null);
    expect(SMOKE.length).toBeGreaterThanOrEqual(2);
    expect(SMOKE.length).toBeLessThanOrEqual(4);
    for (let i = 0; i < SMOKE.length; i++) {
      const s = SMOKE[i];
      expect(s.r0).toBeLessThan(s.r1);
      expect(s.a0).toBeLessThan(s.a1);
      if (i > 0) {
        expect(s.y1).toBeLessThanOrEqual(SMOKE[i - 1].y0);
        expect(s.r1).toBeLessThan(SMOKE[i - 1].r1);
        expect(s.a1).toBeLessThan(SMOKE[i - 1].a1);
      }
    }
    expect(SMOKE[0].r1).toBeLessThan(RING_R[0] - RING_WALL / COS30); // narrower than the lowest ring's opening
    expect(SMOKE[SMOKE.length - 1].y0).toBeLessThan(0.05);
    const m = r.smoke.material;
    expect(m.transparent).toBe(true);
    expect(m.vertexColors).toBe(true);
    expect(r.smoke.geometry.getAttribute('color').itemSize).toBe(4); // per-vertex alpha
    expect(m.depthWrite).toBe(false);
    r.dispose();
  });

  it('weathered ash-grey stone whose cracks glow cyan and pulse slowly: the emissive map is the tile one to the right', () => {
    const scene = new THREE.Scene();
    const atlas = new THREE.Texture();
    const r = createWatcherRenderer(scene, atlas);
    const mat = r.rings[0].material;
    expect(mat).toBeInstanceOf(THREE.MeshLambertMaterial);
    for (const p of [...r.rings, r.lantern]) expect(p.material).toBe(mat); // one stone material
    expect(mat.map).toBe(atlas);
    expect(mat.emissive.getHex()).toBe(0xffffff); // the mask carries the colours
    // The emissive map is the atlas itself (same Source: one GPU texture), read one tile to the right …
    expect(mat.emissiveMap).not.toBe(atlas);
    expect(mat.emissiveMap.source).toBe(atlas.source);
    expect(mat.emissiveMap.offset.toArray()).toEqual([TILE_UV, 0]);
    expect(TILE.WATCHER_CRACKS).toBe(TILE.WATCHER_STONE + 1);
    // … and every stone face samples watcher_stone (so its glow comes from watcher_cracks), the smoke watcher_smoke.
    const inside = (mesh, tile) => {
      const [u0, v0, u1, v1] = tileToUV(tile);
      const uv = mesh.geometry.getAttribute('uv');
      for (let k = 0; k < uv.count; k++) {
        expect(uv.getX(k)).toBeGreaterThanOrEqual(u0 - 1e-6);
        expect(uv.getX(k)).toBeLessThanOrEqual(u1 + 1e-6);
        expect(uv.getY(k)).toBeGreaterThanOrEqual(v0 - 1e-6);
        expect(uv.getY(k)).toBeLessThanOrEqual(v1 + 1e-6);
      }
    };
    for (const p of [...r.rings, r.lantern]) inside(p, TILE.WATCHER_STONE);
    inside(r.smoke, TILE.WATCHER_SMOKE);
    expect(r.smoke.material.map).toBe(atlas);
    // The inner walls are shaded darker than the outer ones: the hollow reads.
    const col = r.rings[2].geometry.getAttribute('color');
    const shades = new Set();
    for (let k = 0; k < col.count; k++) shades.add(col.getX(k));
    expect(Math.min(...shades)).toBeLessThan(0.6);
    expect(Math.max(...shades)).toBe(1);
    // The pulse: slow (CRACK_PULSE_S ≥ 4 s), within CRACK_GLOW · (1 ± CRACK_PULSE).
    expect(CRACK_PULSE_S).toBeGreaterThanOrEqual(4);
    const seen = new Set();
    for (let t = 0; t < CRACK_PULSE_S; t += CRACK_PULSE_S / 8) {
      r.sync(figure(0, 10, 0), 0, 11, 30, t);
      seen.add(Math.round(mat.emissiveIntensity * 100));
      expect(Math.abs(mat.emissiveIntensity - CRACK_GLOW)).toBeLessThanOrEqual(CRACK_GLOW * CRACK_PULSE + 1e-9);
    }
    expect(seen.size).toBeGreaterThan(3);
    r.dispose();
    expect(atlas.version).toBe(0); // the shared atlas is never disposed or re-flagged by the figure
  });

  it('dispose frees every geometry, material and texture of its own (never the shared atlas)', () => {
    const scene = new THREE.Scene();
    const atlas = new THREE.Texture();
    let atlasDisposed = false;
    atlas.addEventListener('dispose', () => { atlasDisposed = true; });
    const r = createWatcherRenderer(scene, atlas);
    const owned = new Set();
    for (const p of partsOf(r)) {
      owned.add(p.geometry);
      owned.add(p.material);
      for (const key of ['map', 'emissiveMap']) if (p.material[key] && p.material[key] !== atlas) owned.add(p.material[key]);
    }
    // Sprites share three's own sprite geometry: not the figure's to free.
    for (const g of r.glows) owned.delete(g.geometry);
    const freed = new Set();
    for (const o of owned) o.addEventListener('dispose', () => freed.add(o));
    r.dispose();
    expect(freed.size).toBe(owned.size);
    expect([...owned].filter((o) => o.isTexture)).toHaveLength(2); // the glow sprite's texture, the crack map clone
    expect(atlasDisposed).toBe(false);
    expect(scene.children).toHaveLength(0);
    expect(r.visible()).toBe(false);
  });
});

describe('pre-warm: no shader compile on the first sighting (§40.4)', () => {
  it('compiles the whole figure against the real scene (its lights and fog), then draws every part once, hidden', async () => {
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0, 1, 100);
    const r = createWatcherRenderer(scene, new THREE.Texture());
    const camera = new THREE.PerspectiveCamera();
    const calls = [];
    await r.prewarm({ compileAsync: (obj, cam, target) => { calls.push({ obj, cam, target }); return Promise.resolve(obj); } }, camera);
    expect(calls).toHaveLength(1);
    expect(calls[0].obj).toBe(r.group); // three's compile walks it: every part's material
    expect(calls[0].cam).toBe(camera);
    expect(calls[0].target).toBe(scene); // the scene's lights and fog are part of each program's key
    const parts = partsOf(r);
    expect(parts).toHaveLength(12);
    // The hidden draw: the whole figure as a micro-scaled speck far below the world, never frustum-culled.
    const speck = () => {
      expect(r.group.visible).toBe(true);
      expect(r.group.position.y).toBe(WARM_Y);
      expect(r.group.scale.x).toBeLessThan(1e-3);
      for (const p of parts) expect(p.frustumCulled).toBe(false);
      expect(r.warmPending()).toBe(parts.length);
      expect(r.visible()).toBe(false); // not a sighting
    };
    speck();
    r.sync(null, 0, 1.6, 0, 0); // main syncs null every frame from the start
    r.sync(null, 0, 1.6, 0, 0.016);
    speck();
    // three calls onAfterRender right after drawing an object: each part's warm-up draw happens once …
    for (const p of parts.slice(0, 5)) p.onAfterRender();
    expect(r.warmPending()).toBe(parts.length - 5);
    expect(r.group.visible).toBe(true); // the rest still owe theirs
    for (const p of parts.slice(5)) p.onAfterRender();
    // … and then it stops: hidden, full size, culled normally again.
    expect(r.warmPending()).toBe(0);
    expect(r.group.visible).toBe(false);
    expect(r.group.scale.x).toBe(1);
    for (const p of parts) expect(p.frustumCulled).toBe(true);
    r.sync(null, 0, 1.6, 0, 0.033);
    expect(r.group.visible).toBe(false);
    for (const p of parts) p.onAfterRender(); // later draws change nothing
    expect(r.group.visible).toBe(false);
    r.dispose();
  });

  it('a sighting before the first render replaces the speck, still drawing every part once even out of view', () => {
    const scene = new THREE.Scene();
    const r = createWatcherRenderer(scene, null);
    r.prewarm(null, new THREE.PerspectiveCamera());
    r.sync(figure(4, 30, -6), 0, 31.6, 0, 0);
    expect(r.visible()).toBe(true);
    expect(worldPos(r.group).toArray()).toEqual([4, 30, -6]);
    expect(r.group.scale.x).toBe(1);
    const parts = partsOf(r);
    for (const p of parts) expect(p.frustumCulled).toBe(false); // they still owe their first draw
    for (const p of parts) p.onAfterRender();
    expect(r.group.visible).toBe(true); // the figure stays
    for (const p of parts) expect(p.frustumCulled).toBe(true);
    r.sync(null, 0, 31.6, 0, 1);
    expect(r.group.visible).toBe(false);
    r.dispose();
  });

  it('falls back to compile and never throws (a failed compile still leaves the warm-up draw)', async () => {
    const camera = new THREE.PerspectiveCamera();
    const r = createWatcherRenderer(new THREE.Scene(), null);
    let compiled = 0;
    await r.prewarm({ compile: () => { compiled++; } }, camera);
    expect(compiled).toBe(1);
    await expect(r.prewarm({ compile: () => { throw new Error('lost context'); } }, camera)).resolves.toBeUndefined();
    await expect(r.prewarm({ compileAsync: () => Promise.reject(new Error('x')) }, camera)).resolves.toBeUndefined();
    await expect(r.prewarm(null, camera)).resolves.toBeUndefined();
    expect(r.warmPending()).toBe(12);
    expect(r.group.visible).toBe(true);
    r.dispose();
  });

  it('main pre-warms it only after everything that adds to the scene exists (a light changes every program key)', () => {
    // Regression: main called prewarm right after creating the figure, before the campfire and explosion PointLights
    // were added, so the compiled programs had the wrong light count and the first sighting compiled three more.
    const main = readFileSync(fileURLToPath(new URL('../../src/main.js', import.meta.url)), 'utf8');
    const prewarmAt = main.indexOf('watcherRenderer.prewarm(');
    expect(prewarmAt).toBeGreaterThan(0);
    const creators = [...main.matchAll(/create\w+\(renderer\.three\.scene/g)];
    expect(creators.map((m) => m[0].split('(')[0])).toEqual(expect.arrayContaining([
      'createWatcherRenderer', 'createCampfireRenderer', 'createFallingRenderer', 'createParticles',
    ]));
    for (const m of creators) expect(m.index).toBeLessThan(prewarmAt);
    // The same holds for every pre-warm (the campfires' compiled with 4 point lights instead of 5 and wasted 6 programs).
    for (const name of ['campfireRenderer', 'fallingRenderer', 'particles']) {
      const at = main.indexOf(`${name}.prewarm(`);
      expect(at, name).toBeGreaterThan(0);
      for (const m of creators) expect(m.index, `${name} after ${m[0]}`).toBeLessThan(at);
    }
    // Why it matters: the falling renderer adds its explosion PointLight when it is created.
    const scene = new THREE.Scene();
    const fr = createFallingRenderer(scene, new THREE.Texture());
    expect(scene.children.some((o) => o.isPointLight)).toBe(true);
    fr.dispose();
  });
});

describe('watcher tiles (§40)', () => {
  const px = (t, x, y) => [t[(y * 16 + x) * 4], t[(y * 16 + x) * 4 + 1], t[(y * 16 + x) * 4 + 2]];
  const lum = ([r, g, b]) => (r + g + b) / 3;
  const TILES = [TILE.WATCHER_STONE, TILE.WATCHER_CRACKS, TILE.WATCHER_SMOKE];
  /** The cracks: the bright pixels of the glow mask. */
  const crackSet = () => {
    const mask = paintTile(TILE.WATCHER_CRACKS);
    const out = new Set();
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (px(mask, x, y)[1] > 150) out.add(y * 16 + x);
    return out;
  };

  it('live in atlas row 15 (250–252), named, alpha 255; the glow mask sits right of the stone in the same row', () => {
    expect(TILES).toEqual([250, 251, 252]);
    expect(TILES.map((t) => TILE_NAMES[t])).toEqual(['watcher_stone', 'watcher_cracks', 'watcher_smoke']);
    expect(Math.floor(TILE.WATCHER_STONE / ATLAS_TILES_PER_ROW)).toBe(Math.floor(TILE.WATCHER_CRACKS / ATLAS_TILES_PER_ROW));
    for (const t of TILES) {
      const p = paintTile(t);
      for (let i = 3; i < p.length; i += 4) expect(p[i]).toBe(255);
    }
  });

  it('watcher_stone: weathered ash grey — light-to-mid, neutral (not black, not purple), mottled and porous', () => {
    const [r, g, b] = averageColor(TILE.WATCHER_STONE);
    for (const c of [r, g, b]) {
      expect(c).toBeGreaterThan(100);
      expect(c).toBeLessThan(170);
    }
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(8);
    expect(b).toBeLessThanOrEqual(r + 2); // no purple / blue cast
    const stone = paintTile(TILE.WATCHER_STONE);
    const cracks = crackSet();
    const values = [];
    let pores = 0;
    const mean = lum([r, g, b]);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (cracks.has(y * 16 + x)) continue;
      const l = lum(px(stone, x, y));
      values.push(l);
      if (l < mean - 20) pores++;
    }
    const avg = values.reduce((a, v) => a + v, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, v) => a + (v - avg) ** 2, 0) / values.length);
    expect(sd).toBeGreaterThan(6); // mottled
    expect(pores).toBeGreaterThanOrEqual(8); // porous
  });

  it('thin cracks: dark grooves in watcher_stone, bright cyan at the same pixels of watcher_cracks; the rest is dim stone', () => {
    const stone = paintTile(TILE.WATCHER_STONE);
    const mask = paintTile(TILE.WATCHER_CRACKS);
    const cracks = crackSet();
    expect(cracks.size).toBeGreaterThanOrEqual(12);
    expect(cracks.size).toBeLessThanOrEqual(40); // few and thin
    for (const i of cracks) {
      const x = i % 16;
      const y = Math.floor(i / 16);
      const [cr, cg, cb] = px(mask, x, y);
      expect(cg).toBeGreaterThan(cr + 60); // cyan
      expect(cb).toBeGreaterThan(cr + 60);
      const s = px(stone, x, y);
      expect(lum(s)).toBeLessThan(80); // a dark groove in the stone …
      expect(s[2]).toBeGreaterThan(s[0]); // … tinted teal
      // 1-px lines, not dots: every crack pixel touches another.
      let touches = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && cracks.has((y + dy) * 16 + x + dx)) touches++;
      expect(touches).toBeGreaterThan(0);
    }
    // Everywhere else the mask is the stone at 0.4 of its brightness (its faint night-time self-light).
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (cracks.has(y * 16 + x)) continue;
      const s = px(stone, x, y);
      const m = px(mask, x, y);
      for (let c = 0; c < 3; c++) expect(Math.abs(m[c] - s[c] * 0.4)).toBeLessThanOrEqual(1);
    }
  });

  it('watcher_smoke: dark neutral soot', () => {
    const [r, g, b] = averageColor(TILE.WATCHER_SMOKE);
    expect(Math.max(r, g, b)).toBeLessThan(70);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(8);
  });
});

function fakeContextClass(log) {
  const param = () => ({
    value: 0,
    setValueAtTime(v) {
      this.value = v;
    },
    exponentialRampToValueAtTime() {},
    linearRampToValueAtTime() {},
    setTargetAtTime() {},
    cancelScheduledValues() {},
  });
  const node = (kind) => {
    const n = { kind, connect() {}, disconnect() {}, gain: param(), frequency: param(), playbackRate: param(), type: '' };
    log.push(n);
    return n;
  };
  return class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 8000;
      this.currentTime = 0;
      this.destination = {};
    }
    createGain() {
      return node('gain');
    }
    createBiquadFilter() {
      return node('filter');
    }
    createOscillator() {
      const n = node('osc');
      n.start = () => {};
      n.stop = () => {};
      return n;
    }
    createBufferSource() {
      const n = node('noise');
      n.start = () => {};
      n.stop = () => {};
      return n;
    }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return { duration: length / rate, getChannelData: () => data };
    }
    resume() {
      return Promise.resolve();
    }
  };
}

describe('playWatcherVanish (§40)', () => {
  it('a faint low sound: low sine voices (≤ 72 Hz) and a noise breath, scaled by volume, silent when muted or at 0', () => {
    const log = [];
    const audio = createAudio({ AudioContextClass: fakeContextClass(log) });
    audio.playWatcherVanish(1);
    expect(log.length).toBe(0); // no context before resume()
    audio.resume();
    const base = log.length;
    audio.playWatcherVanish(1);
    const voices = log.slice(base);
    const oscs = voices.filter((n) => n.kind === 'osc');
    expect(oscs.length).toBeGreaterThanOrEqual(2);
    for (const o of oscs) expect(o.frequency.value).toBeLessThan(80); // low
    expect(voices.some((n) => n.kind === 'noise')).toBe(true);
    const loud = Math.max(...voices.filter((n) => n.kind === 'gain').map((g) => g.gain.value));
    expect(loud).toBeLessThan(0.3); // faint
    const n1 = log.length;
    audio.playWatcherVanish(0.5);
    const quiet = Math.max(...log.slice(n1).filter((n) => n.kind === 'gain').map((g) => g.gain.value));
    expect(quiet).toBeCloseTo(loud / 2, 6);
    const n2 = log.length;
    audio.playWatcherVanish(0);
    audio.setMuted(true);
    audio.playWatcherVanish(1);
    expect(log.length).toBe(n2);
  });
  it('never throws without WebAudio', () => {
    const audio = createAudio({ AudioContextClass: undefined });
    expect(() => audio.playWatcherVanish(1)).not.toThrow();
  });
});
