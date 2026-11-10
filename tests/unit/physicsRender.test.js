// fallingRenderer.js and particles.js — Node only (Three core objects work without WebGL): instancing per block id
// and layer, capacity growth, the explosion light and its colour, and the one-Points particle system with its orbit
// particles (CONTRACTS §34.4–§34.5; DESIGN-circuits §6.2.10, §6.2.12).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PARTICLE_CAPACITY, BLACK_HOLE_FLASH_COLOR, VORTEX_EVENT_R } from '../../src/config.js';
import { BLOCK } from '../../src/blocks.js';
import { createFallingRenderer, PREWARM_IDS, FLASH_COLOR } from '../../src/fallingRenderer.js';
import { createParticles, PARTICLE_KINDS, blockParticleColor } from '../../src/particles.js';

const item = (id, x, y, z, extra = {}) => ({ id, x, y, z, rx: 0, ry: 0, rz: 0, scale: 1, ...extra });

describe('fallingRenderer', () => {
  it('one InstancedMesh per (block id, layer) on the atlas, frustumCulled off, counts follow sync', () => {
    const scene = new THREE.Scene();
    const atlas = new THREE.Texture();
    const fr = createFallingRenderer(scene, atlas);
    fr.sync([item(BLOCK.SAND, 0, 10, 0), item(BLOCK.SAND, 1, 10, 0), item(BLOCK.OAK_LEAVES, 2, 10, 0), item(BLOCK.WATER_FALL, 3, 10, 0)]);
    const meshes = scene.children.filter((o) => o.isInstancedMesh);
    expect(meshes.map((m) => m.name).sort()).toEqual(['falling:11:cutout', 'falling:74:translucent', 'falling:8:opaque']);
    for (const m of meshes) {
      expect(m.frustumCulled).toBe(false);
      expect(m.material.map).toBe(atlas);
      expect(m.material.vertexColors).toBe(true);
    }
    expect(meshes.find((m) => m.name === 'falling:8:opaque').count).toBe(2);
    expect(fr.count()).toBe(4);
    // Next frame without sand: its mesh draws nothing (kept for reuse).
    fr.sync([item(BLOCK.OAK_LEAVES, 2, 9, 0)]);
    const sand = scene.getObjectByName('falling:8:opaque');
    expect(sand.count).toBe(0);
    expect(sand.visible).toBe(false);
    // Campfires have no cell mesh (own model): skipped.
    fr.sync([item(BLOCK.CAMPFIRE, 0, 0, 0)]);
    expect(fr.count()).toBe(0);
    fr.dispose();
    expect(scene.children.filter((o) => o.isInstancedMesh).length).toBe(0);
  });

  it('places instances at the item centre with rotation (Euler YXZ) and scale; capacity doubles', () => {
    const scene = new THREE.Scene();
    const fr = createFallingRenderer(scene, new THREE.Texture());
    const items = [];
    for (let i = 0; i < 40; i++) items.push(item(BLOCK.STONE, i, 20, -i, { ry: 0.5, scale: 1.04 }));
    fr.sync(items, 40);
    const mesh = scene.getObjectByName('falling:1:opaque');
    expect(mesh.count).toBe(40);
    expect(mesh.instanceMatrix.count).toBeGreaterThanOrEqual(40);
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(39, m);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    m.decompose(p, q, s);
    expect([p.x, p.y, p.z]).toEqual([39, 20, -39]);
    expect(s.x).toBeCloseTo(1.04);
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    expect(e.y).toBeCloseTo(0.5);
    // `count` limits what is drawn.
    fr.sync(items, 3);
    expect(scene.getObjectByName('falling:1:opaque').count).toBe(3);
  });

  it('owns one explosion PointLight (off until setFlash)', () => {
    const scene = new THREE.Scene();
    const fr = createFallingRenderer(scene, new THREE.Texture());
    const light = scene.getObjectByName('explosion-flash');
    expect(light.isPointLight).toBe(true);
    expect(light.intensity).toBe(0);
    fr.setFlash(1, 2, 3, 40);
    expect(light.intensity).toBe(40);
    expect(light.position.toArray()).toEqual([1, 2, 3]);
    fr.setFlash(0, 0, 0, 0);
    expect(light.intensity).toBe(0);
  });

  it('setFlash takes a colour (default the blast’s 0xffd49a) and sets it on the one light only when it changes', () => {
    const scene = new THREE.Scene();
    const fr = createFallingRenderer(scene, new THREE.Texture());
    const lights = [];
    scene.traverse((o) => { if (o.isPointLight) lights.push(o); });
    expect(lights).toHaveLength(1);
    const light = lights[0];
    expect(FLASH_COLOR).toBe(0xffd49a);
    expect(light.color.getHex()).toBe(FLASH_COLOR);
    let sets = 0;
    const setHex = light.color.setHex.bind(light.color);
    light.color.setHex = (...a) => { sets++; return setHex(...a); };
    fr.setFlash(1, 2, 3, 220, BLACK_HOLE_FLASH_COLOR);
    expect(light.color.getHex()).toBe(0xfff4e6);
    expect(light.intensity).toBe(220);
    fr.setFlash(1, 2, 3, 120, BLACK_HOLE_FLASH_COLOR);
    fr.setFlash(1, 2, 3, 60, BLACK_HOLE_FLASH_COLOR);
    expect(sets).toBe(1); // unchanged colour: not set again
    fr.setFlash(1, 2, 3, 40); // a blast: back to the default
    expect(light.color.getHex()).toBe(FLASH_COLOR);
    expect(sets).toBe(2);
    fr.setFlash(1, 2, 3, 40, -5); // nonsense → the default
    expect(light.color.getHex()).toBe(FLASH_COLOR);
    fr.setFlash(0, 0, 0, 0, 0x00ff00); // off: the colour does not matter and is left alone
    expect(light.color.getHex()).toBe(FLASH_COLOR);
    let all = 0;
    scene.traverse((o) => { if (o.isLight) all++; });
    expect(all).toBe(1); // still one light
    fr.dispose();
  });
});

describe('particles', () => {
  it('one THREE.Points with PARTICLE_CAPACITY slots; the oldest particle is overwritten when full', () => {
    const scene = new THREE.Scene();
    const ps = createParticles(scene, { random: () => 0.5 });
    expect(scene.children.filter((o) => o.isPoints).length).toBe(1);
    expect(ps.points.geometry.getAttribute('position').count).toBe(PARTICLE_CAPACITY);
    expect(PARTICLE_KINDS).toEqual(['dust', 'leaves', 'smoke', 'sparks', 'steam', 'infall']);
    ps.emit('dust', 0, 10, 0, 10, { id: BLOCK.SAND });
    expect(ps.count()).toBe(10);
    ps.emit('sparks', 0, 10, 0, PARTICLE_CAPACITY + 50);
    expect(ps.count()).toBe(PARTICLE_CAPACITY);
    ps.emit('nonsense', 0, 0, 0, 5);
    ps.emit('dust', NaN, 0, 0, 5);
    expect(ps.count()).toBe(PARTICLE_CAPACITY);
    ps.clear();
    expect(ps.count()).toBe(0);
    ps.dispose();
  });

  it('particles move, fade and die; dt = 0 freezes them', () => {
    const ps = createParticles(new THREE.Scene(), { random: () => 0.5 });
    ps.emit('smoke', 0, 10, 0, 4);
    const pos = ps.points.geometry.getAttribute('position');
    const y0 = pos.getY(0);
    ps.update(0);
    expect(pos.getY(0)).toBe(y0);
    ps.update(0.1);
    expect(pos.getY(0)).toBeGreaterThan(y0); // smoke rises
    expect(ps.points.visible).toBe(true);
    for (let i = 0; i < 40; i++) ps.update(0.1);
    expect(ps.count()).toBe(0);
    ps.update(0.1);
    expect(ps.points.visible).toBe(false);
  });

  it('dust takes the block colour (sRGB 0..1), tinted like the mesher for tinted tops', () => {
    const sand = blockParticleColor(BLOCK.SAND);
    expect(sand[0]).toBeGreaterThan(sand[2]); // warm
    const grass = blockParticleColor(BLOCK.GRASS_BLOCK);
    expect(grass[1]).toBeGreaterThan(grass[0]);
    expect(blockParticleColor(999)).toEqual(blockParticleColor(BLOCK.AIR));
  });
});

describe('fallingRenderer: capacity growth keeps this frame’s instances (FR-3)', () => {
  /** @returns {number} drawn instances of `mesh` not at their item's position */
  function wrongInstances(mesh, items) {
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let wrong = 0;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      if (Math.abs(p.x - items[i].x) + Math.abs(p.y - items[i].y) + Math.abs(p.z - items[i].z) > 1e-6) wrong++;
    }
    return wrong;
  }

  it('the sync that grows a mesh (16 → 32 → 64 → 128) draws every block where it is, not at the world origin', () => {
    const scene = new THREE.Scene();
    const fr = createFallingRenderer(scene, new THREE.Texture());
    const items = (n) => Array.from({ length: n }, (_, i) => item(BLOCK.SAND, 100 + i, 80.5, -50 - i, { ry: 0.25 * i }));
    for (const n of [16, 17, 33, 40, 65]) {
      const list = items(n);
      fr.sync(list, n); // the growing sync itself, not the one after it
      const mesh = scene.getObjectByName('falling:8:opaque');
      expect(mesh.count, `sync(${n})`).toBe(n);
      expect(mesh.instanceMatrix.count).toBeGreaterThanOrEqual(n);
      expect(wrongInstances(mesh, list), `sync(${n})`).toBe(0);
    }
    expect(scene.children.filter((o) => o.name === 'falling:8:opaque')).toHaveLength(1); // the outgrown meshes are gone
    const glass = Array.from({ length: 20 }, (_, i) => item(BLOCK.GLASS, i, 30, i));
    fr.sync(glass, 20);
    expect(wrongInstances(scene.getObjectByName('falling:12:cutout'), glass)).toBe(0);
    fr.dispose();
  });
});

describe('prewarm: no shader compile on the first falling block / particle (FR-4)', () => {
  const posScale = (mesh, i) => {
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(i, m);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    m.decompose(p, new THREE.Quaternion(), s);
    return { p, s };
  };

  it('fallingRenderer.prewarm compiles one mesh per render layer against the real scene before anything falls', async () => {
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0, 1, 100);
    const fr = createFallingRenderer(scene, new THREE.Texture());
    const camera = new THREE.PerspectiveCamera();
    const calls = [];
    await fr.prewarm({ compileAsync: (obj, cam, target) => { calls.push({ obj, cam, target }); return Promise.resolve(obj); } }, camera);
    expect(PREWARM_IDS).toEqual([BLOCK.SAND, BLOCK.GLASS, BLOCK.ICE]);
    // three's compile walks each object: every layer's material, on an InstancedMesh (the variant sync draws).
    const layers = new Set();
    for (const c of calls) {
      expect(c.cam).toBe(camera);
      expect(c.target).toBe(scene);
      c.obj.traverse((o) => { if (o.isInstancedMesh) layers.add(o.name.split(':')[2]); });
    }
    expect([...layers].sort()).toEqual(['cutout', 'opaque', 'translucent']);
    const materials = new Set(calls.map((c) => c.obj.material));
    expect(materials.size).toBe(3); // the renderer's three materials, shared by every block id of that layer
    fr.sync([item(BLOCK.OAK_LEAVES, 0, 10, 0), item(BLOCK.STONE, 0, 11, 0)]);
    expect(materials.has(scene.getObjectByName('falling:11:cutout').material)).toBe(true);
    expect(materials.has(scene.getObjectByName('falling:1:opaque').material)).toBe(true);
    fr.dispose();
  });

  it('each warm mesh draws one hidden instance until it has been rendered once; sync([], 0) on load keeps it', () => {
    const scene = new THREE.Scene();
    const fr = createFallingRenderer(scene, new THREE.Texture());
    fr.prewarm(null, new THREE.PerspectiveCamera());
    const warm = scene.children.filter((o) => o.isInstancedMesh);
    expect(warm.map((m) => m.name).sort()).toEqual(['falling:12:cutout', 'falling:41:translucent', 'falling:8:opaque']);
    const check = () => {
      for (const m of warm) {
        expect(m.visible).toBe(true);
        expect(m.count).toBe(1);
        const { p, s } = posScale(m, 0);
        expect(p.y).toBeLessThan(-1000); // far below the world: clipped, nothing on screen
        expect(s.x).toBeLessThan(1e-3);
      }
    };
    check();
    fr.sync([], 0); // main, on world load
    fr.sync([], 0);
    check();
    expect(fr.count()).toBe(0); // not a falling block
    // three calls onAfterRender after drawing an object: back to drawing nothing.
    for (const m of warm) m.onAfterRender();
    for (const m of warm) {
      expect(m.count).toBe(0);
      expect(m.visible).toBe(false);
    }
    fr.sync([], 0);
    expect(warm.every((m) => !m.visible)).toBe(true);
    fr.dispose();
  });

  it('a block that falls before the first render replaces the warm instance (and keeps drawing after it)', () => {
    const scene = new THREE.Scene();
    const fr = createFallingRenderer(scene, new THREE.Texture());
    fr.prewarm(null, new THREE.PerspectiveCamera());
    fr.sync([item(BLOCK.SAND, 3, 40, 5)]);
    const sand = scene.getObjectByName('falling:8:opaque');
    sand.onAfterRender();
    expect(sand.count).toBe(1);
    expect(sand.visible).toBe(true);
    expect(posScale(sand, 0).p.toArray()).toEqual([3, 40, 5]);
    fr.sync([], 0);
    expect(sand.visible).toBe(false);
    fr.dispose();
  });

  it('fallingRenderer.prewarm falls back to compile and never throws', async () => {
    const camera = new THREE.PerspectiveCamera();
    const fr = createFallingRenderer(new THREE.Scene(), new THREE.Texture());
    let compiled = 0;
    await fr.prewarm({ compile: () => { compiled++; } }, camera);
    expect(compiled).toBe(3);
    await expect(fr.prewarm({ compile: () => { throw new Error('lost context'); } }, camera)).resolves.toBeUndefined();
    await expect(fr.prewarm({ compileAsync: () => Promise.reject(new Error('x')) }, camera)).resolves.toBeUndefined();
    await expect(fr.prewarm(null, camera)).resolves.toBeUndefined();
    fr.dispose();
  });

  it('particles.prewarm compiles the Points and draws one dead point (size 0) until the first render', async () => {
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0, 1, 100);
    const ps = createParticles(scene, { random: () => 0.5 });
    const camera = new THREE.PerspectiveCamera();
    const calls = [];
    await ps.prewarm({ compileAsync: (obj, cam, target) => { calls.push([obj, cam, target]); return Promise.resolve(obj); } }, camera);
    expect(calls).toEqual([[ps.points, camera, scene]]);
    const g = ps.points.geometry;
    const warm = () => {
      expect(ps.points.visible).toBe(true);
      expect(g.drawRange.count).toBe(1);
      expect(g.getAttribute('palpha').getX(0)).toBe(0); // the vertex shader gives it gl_PointSize 0
    };
    warm();
    ps.clear(); // main, on world load
    ps.update(1 / 60);
    ps.update(0);
    warm();
    expect(ps.count()).toBe(0);
    ps.points.onAfterRender();
    expect(ps.points.visible).toBe(false);
    expect(g.drawRange.count).toBe(0);
    ps.update(1 / 60);
    expect(ps.points.visible).toBe(false);
    ps.emit('dust', 0, 10, 0, 3); // emitting works as before
    ps.update(1 / 60);
    expect(ps.points.visible).toBe(true);
    expect(g.drawRange.count).toBe(3);
    ps.dispose();
  });

  it('particles.prewarm falls back to compile and never throws', async () => {
    const camera = new THREE.PerspectiveCamera();
    const ps = createParticles(new THREE.Scene());
    let compiled = 0;
    await ps.prewarm({ compile: () => { compiled++; } }, camera);
    expect(compiled).toBe(1);
    await expect(ps.prewarm({ compile: () => { throw new Error('lost context'); } }, camera)).resolves.toBeUndefined();
    await expect(ps.prewarm({ compileAsync: () => Promise.reject(new Error('x')) }, camera)).resolves.toBeUndefined();
    await expect(ps.prewarm(null, camera)).resolves.toBeUndefined();
    ps.dispose();
  });
});

describe('particles: orbit particles spiral into a vortex (DESIGN-circuits §6.2.10)', () => {
  /** Seeded [0, 1) generator. */
  function rng(seed = 7) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const C = [3, 20, -2];
  /** Live slots' (ρ, θ, height, 3D distance) about C. */
  function polar(ps) {
    const g = ps.points.geometry;
    const pos = g.getAttribute('position');
    const al = g.getAttribute('palpha');
    const sz = g.getAttribute('psize');
    const out = [];
    for (let i = 0; i < pos.count; i++) {
      if (sz.getX(i) <= 0) continue; // dead (or never used) slots have size 0
      const dx = pos.getX(i) - C[0];
      const dy = pos.getY(i) - C[1];
      const dz = pos.getZ(i) - C[2];
      out.push({ i, rho: Math.hypot(dx, dz), th: Math.atan2(dz, dx), h: dy, alpha: al.getX(i), r3: Math.hypot(dx, dy, dz) });
    }
    return out;
  }

  it('PARTICLE_KINDS includes infall, and a plain emit of it gives finite, ballistic positions', () => {
    const ps = createParticles(new THREE.Scene(), { random: rng() });
    expect(PARTICLE_KINDS).toContain('infall');
    ps.emit('infall', 0, 10, 0, 24, { speed: 3 });
    for (let k = 0; k < 10; k++) ps.update(1 / 60);
    const pos = ps.points.geometry.getAttribute('position');
    for (let i = 0; i < 24; i++) expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
    expect(ps.count()).toBe(24);
    ps.dispose();
  });

  it('they spiral in — ρ falls and θ rises every step — and reach ρ < 0.45 before their life ends, from every start radius', () => {
    for (const r0 of [0.8, 1.5, 2.5, 3.5, 4.5, 6]) {
      const ps = createParticles(new THREE.Scene(), { random: rng(Math.round(r0 * 10)) });
      ps.emitOrbit('infall', ...C, 12, { rMin: r0, rMax: r0, hMax: 0.6, color: [0.18, 0.15, 0.13], hot: [1, 0.78, 0.56] });
      expect(ps.count()).toBe(12);
      let prev = polar(ps);
      expect(prev.every((p) => Math.abs(p.rho - r0) < 1e-4)).toBe(true);
      let t = 0;
      const life = (r0 ** 1.5 - 0.45 ** 1.5) / 1.8 + 0.3;
      while (ps.count() > 0 && t < life + 1) {
        ps.update(1 / 60);
        t += 1 / 60;
        const now = polar(ps);
        for (const p of now) {
          const q = prev.find((o) => o.i === p.i);
          if (!q) continue;
          expect(p.rho).toBeLessThan(q.rho);
          let dth = p.th - q.th;
          if (dth < -Math.PI) dth += 2 * Math.PI;
          expect(dth).toBeGreaterThan(0); // +θ, the swirl's sense
          expect(p.rho).toBeGreaterThanOrEqual(VORTEX_EVENT_R - 1e-4); // dies below 0.45, never drawn there
          expect(Math.abs(p.h)).toBeLessThanOrEqual(0.6 + 1e-4); // flattening onto the disk plane
        }
        prev = now;
      }
      // Every one died at the core, before its life ran out (life = arrival + 0.3 s).
      expect(ps.count(), `ρ0 ${r0}`).toBe(0);
      expect(t, `ρ0 ${r0}`).toBeLessThan(life);
      ps.dispose();
    }
  });

  it('they warm from `color` to `hot` near the core and fade in; the height flattens onto the disk plane', () => {
    const ps = createParticles(new THREE.Scene(), { random: rng(3) });
    ps.emitOrbit('infall', ...C, 1, { rMin: 3, rMax: 3, hMax: 0.6, color: 0x2e2620, hot: 0xffc890 });
    const col = ps.points.geometry.getAttribute('pcolor');
    const red0 = col.getX(0);
    expect(ps.points.geometry.getAttribute('palpha').getX(0)).toBe(0);
    const h0 = Math.abs(polar(ps)[0].h);
    let last = null;
    for (let k = 0; k < 600 && ps.count() > 0; k++) {
      ps.update(1 / 120);
      const p = polar(ps)[0];
      if (p) last = { ...p, red: col.getX(0) };
    }
    expect(last.rho).toBeLessThan(0.7);
    expect(last.red).toBeGreaterThan(red0 + 0.3); // hot
    expect(last.alpha).toBeGreaterThan(0.6);
    expect(Math.abs(last.h)).toBeLessThan(h0 * 0.2 + 1e-4);
  });

  it('spherical: start on a sphere and move straight at the centre (height = h0·ρ/ρ0; θ fixed when radial)', () => {
    const ps = createParticles(new THREE.Scene(), { random: rng(11) });
    ps.emitOrbit('infall', ...C, 64, { rMin: 3.0, rMax: 3.6, hMax: 3.3, spherical: true, radial: true, inward: 2.8, color: [1, 1, 1], hot: [0.69, 0.23, 0.1] });
    const start = polar(ps);
    for (const p of start) {
      expect(p.r3).toBeGreaterThanOrEqual(3.0 - 1e-4);
      expect(p.r3).toBeLessThanOrEqual(3.6 + 1e-4);
    }
    expect(start.some((p) => Math.abs(p.h) > 2)).toBe(true); // a sphere, not a disk
    ps.update(1 / 60);
    ps.update(1 / 60);
    for (const p of polar(ps)) {
      const s0 = start.find((o) => o.i === p.i);
      if (s0.rho > 0.05) expect(p.th).toBeCloseTo(s0.th, 4); // radial: straight in
      expect(p.h / p.r3).toBeCloseTo(s0.h / s0.r3, 4); // the same direction from the centre: height = h0·ρ/ρ0
      expect(p.r3).toBeLessThan(s0.r3);
    }
  });

  it('the implosion burst (rMin 3, rMax 3.6, inward 2.8) arrives in 1.15 ± 0.1 s', () => {
    const ps = createParticles(new THREE.Scene(), { random: rng(5) });
    ps.emitOrbit('infall', ...C, 64, { rMin: 3.0, rMax: 3.6, hMax: 3.3, spherical: true, radial: true, inward: 2.8, color: [1, 1, 1], hot: [0.69, 0.23, 0.1] });
    let t = 0;
    let deaths = 0;
    let sum = 0;
    let last = 64;
    while (ps.count() > 0 && t < 3) {
      ps.update(1 / 120);
      t += 1 / 120;
      const n = ps.count();
      sum += (last - n) * t;
      deaths += last - n;
      last = n;
    }
    expect(deaths).toBe(64);
    expect(sum / deaths).toBeGreaterThan(1.05);
    expect(sum / deaths).toBeLessThan(1.25);
  });

  it('respects capacity: orbit particles share the ring and overwrite the oldest; bad calls emit nothing', () => {
    const ps = createParticles(new THREE.Scene(), { capacity: 64, random: rng(2) });
    ps.emit('smoke', 0, 10, 0, 40);
    ps.emitOrbit('infall', ...C, 50, { rMin: 2.5, rMax: 4.5 });
    expect(ps.count()).toBe(64);
    ps.emitOrbit('infall', ...C, 500, { rMin: 2.5, rMax: 4.5 });
    expect(ps.count()).toBe(64);
    ps.clear();
    ps.emitOrbit('nonsense', ...C, 5, { rMin: 2, rMax: 3 });
    ps.emitOrbit('infall', NaN, 0, 0, 5, { rMin: 2, rMax: 3 });
    ps.emitOrbit('infall', ...C, 5, { rMin: -1, rMax: 3 });
    ps.emitOrbit('infall', ...C, 5);
    expect(ps.count()).toBe(0);
    ps.emitOrbit('infall', ...C, 5, { rMin: 4, rMax: 2 }); // swapped radii are fine
    expect(ps.count()).toBe(5);
  });

  it('an orbit slot overwritten by emit moves ballistically (no stale centre)', () => {
    const ps = createParticles(new THREE.Scene(), { capacity: 4, random: () => 0.5 });
    ps.emitOrbit('infall', ...C, 4, { rMin: 3, rMax: 3 });
    ps.update(0.1);
    ps.emit('sparks', 50, 60, 70, 4, { spread: 0 });
    const pos = ps.points.geometry.getAttribute('position');
    expect([pos.getX(0), pos.getY(0), pos.getZ(0)]).toEqual([50, 60, 70]);
    ps.update(0.05);
    for (let i = 0; i < 4; i++) {
      expect(Math.hypot(pos.getX(i) - C[0], pos.getZ(i) - C[2])).toBeGreaterThan(40); // nowhere near the old centre
      expect(pos.getY(i)).toBeGreaterThan(60); // sparks fly up first
    }
  });

  it('emit is unchanged for ballistic particles: the v0.8 velocity, drag, gravity, growth and fade', () => {
    const ps = createParticles(new THREE.Scene(), { random: () => 0.5 });
    ps.emitOrbit('infall', ...C, 3, { rMin: 3, rMax: 3 }); // orbit particles alongside change nothing for the others
    ps.emit('smoke', 0, 10, 0, 1, { spread: 0 });
    const i = 3;
    const pos = ps.points.geometry.getAttribute('position');
    const size = ps.points.geometry.getAttribute('psize');
    const alpha = ps.points.geometry.getAttribute('palpha');
    // The v0.8 model for random() = 0.5: smoke speed 0.45·(0.4 + 0.3) at angle π, up 1.05, life 1.9, size 0.35.
    let vx = 0.45 * 0.7 * Math.cos(Math.PI);
    let vy = 1.05;
    let x = 0;
    let y = 10;
    const life = 1.9;
    let left = life;
    const dt = 1 / 30;
    for (let k = 0; k < 20; k++) {
      ps.update(dt);
      left -= dt;
      const f = Math.exp(-0.9 * dt);
      vx *= f;
      vy = vy * f + 0.5 * dt;
      x += vx * dt;
      y += vy * dt;
      const age = 1 - left / life;
      expect(pos.getX(i)).toBeCloseTo(x, 4);
      expect(pos.getY(i)).toBeCloseTo(y, 4);
      expect(size.getX(i)).toBeCloseTo(0.35 * (1 + 1.4 * age), 4);
      expect(alpha.getX(i)).toBeCloseTo(0.5 * Math.min(1, (1 - age) * 2.5), 4);
    }
  });
});
