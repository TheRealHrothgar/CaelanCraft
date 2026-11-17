// animalModels.js (PURE) and the animals' poses in animalRenderer.js (three, Node only): every kind of animal and the pig
// built HEX-FACETED over one shared painted atlas (CONTRACTS §69.1) — valid geometry, within budget, its variants all
// there; and the heads that graze, stare (§100) and grow, the tame ones' tags and the snared ones' loops.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  animalModels, buildAnimalModels, variantTriangles, variantBounds, restModel, ANIMAL_RIGS, ANIMAL_ATLAS, MODEL_KINDS,
} from '../../src/animalModels.js';
import { createAnimalRenderer, headPitch, youthOf, MODELS, YOUNG_HEAD, HEAD_RATE } from '../../src/animalRenderer.js';
import { ANIMAL_KINDS, SPECIES } from '../../src/animals.js';
import { YOUNG_SCALE } from '../../src/populations.js';

/** The most triangles one whole animal may have in any variant (its trunk, head, legs; a bird's wings while it flies). */
const TRI_BUDGET = 800;

describe('animalModels — the parts', () => {
  const m = animalModels();

  it('paints every kind on ONE atlas, ANIMAL_ATLAS square, and builds once per page', () => {
    expect(m.atlas).toEqual([ANIMAL_ATLAS, ANIMAL_ATLAS]);
    expect(m.image.data.length).toBe(ANIMAL_ATLAS * ANIMAL_ATLAS * 4);
    expect(m.texels).toBeGreaterThan(0.3 * ANIMAL_ATLAS * ANIMAL_ATLAS); // richly painted: hundreds of thousands of texels
    expect(m.texels).toBeLessThanOrEqual(ANIMAL_ATLAS * ANIMAL_ATLAS);
    expect(animalModels()).toBe(m);
    expect(MODEL_KINDS).toEqual([...ANIMAL_KINDS, 'pig']);
  });

  it('every part: valid indices, unit normals, uvs on the atlas', () => {
    for (const kind of MODEL_KINDS) {
      for (const [name, g] of Object.entries(m.kinds[kind].parts)) {
        const where = `${kind} ${name}`;
        const n = g.positions.length / 3;
        expect(g.index.length % 3, where).toBe(0);
        expect(g.index.every((i) => i < n), where).toBe(true);
        expect(g.uvs.every((u) => u >= 0 && u <= 1), where).toBe(true);
        let bad = 0;
        for (let i = 0; i < g.normals.length; i += 3) if (Math.abs(Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2]) - 1) > 1e-4) bad++;
        expect(bad, where).toBe(0);
      }
    }
  });

  it('every variant names parts that exist, and stays within the triangle budget', () => {
    for (const kind of MODEL_KINDS) {
      const K = m.kinds[kind];
      expect(K.variants.body, kind).toBeDefined();
      for (const [v, [trunk, head, legs = 'legs']] of Object.entries(K.variants)) {
        expect(K.parts[/** @type {string} */ (trunk)], `${kind} ${v} trunk`).toBeDefined();
        if (head) expect(K.parts[head], `${kind} ${v} head`).toBeDefined();
        if (kind !== 'fish') expect(K.parts[legs], `${kind} ${v} legs`).toBeDefined();
        const tris = variantTriangles(m, kind, v);
        expect(tris, `${kind} ${v}`).toBeLessThanOrEqual(TRI_BUDGET);
        expect(tris, `${kind} ${v}`).toBeGreaterThan(100);
      }
    }
    // the variants the game draws: sex, shorn, tame, young
    expect(Object.keys(m.kinds.sheep.variants).sort()).toEqual(['alt', 'body', 'male', 'maleAlt']);
    expect(m.kinds.cow.variants.male[0]).toBe('male');
    expect(m.kinds.deer.variants.male[1]).toBe('head-male');
    expect(m.kinds.deer.variants.young[0]).toBe('young'); // the fawn's spotted coat
    expect(m.kinds.horse.variants.alt).toEqual(['alt', 'head-alt']); // a saddle and a bridle
    for (const k of ['cow', 'sheep', 'wolf', 'pig']) expect(m.kinds[k].parts.tag, k).toBeDefined(); // a collar, a bell, a ribbon
    expect(m.kinds.pig.parts.tusks).toBeDefined();
    for (const k of ['pheasant', 'turkey']) expect(m.kinds[k].parts.wings, k).toBeDefined();
  });

  it('legs hang from the hip to the ground; trunks and heads stand on it, as tall as the bodies they draw', () => {
    for (const kind of MODEL_KINDS) {
      const rig = /** @type {*} */ (ANIMAL_RIGS)[kind];
      const legs = m.kinds[kind].parts.legs;
      if (legs) {
        let lo = Infinity;
        for (let i = 1; i < legs.positions.length; i += 3) lo = Math.min(lo, legs.positions[i]);
        expect(lo, kind).toBeCloseTo(-rig.legH, 3);
      }
      const b = variantBounds(m, kind);
      expect(b.min[1], kind).toBeGreaterThanOrEqual(0);
      const h = kind === 'pig' ? 0.9 : SPECIES[/** @type {import('../../src/animals.js').AnimalKind} */ (kind)].height;
      expect(b.max[1], kind).toBeGreaterThan(h - 0.15);
      expect(b.max[1], kind).toBeLessThan(h + 0.65);
      expect(b.min[2], `${kind} faces −Z`).toBeLessThan(-0.1);
    }
  });

  it('paints the same atlas every time, and the coats in their own colours (a pink pig, a white ewe, a grey wolf)', () => {
    const again = buildAnimalModels();
    expect(Buffer.from(again.image.data).equals(Buffer.from(m.image.data))).toBe(true);
    const mean = (kind, part) => {
      const g = m.kinds[kind].parts[part];
      const s = [0, 0, 0];
      const n = g.uvs.length / 2;
      for (let v = 0; v < n; v++) {
        const x = Math.min(ANIMAL_ATLAS - 1, Math.floor(g.uvs[v * 2] * ANIMAL_ATLAS));
        const y = Math.min(ANIMAL_ATLAS - 1, Math.floor(g.uvs[v * 2 + 1] * ANIMAL_ATLAS));
        for (let c = 0; c < 3; c++) s[c] += m.image.data[(y * ANIMAL_ATLAS + x) * 4 + c] / n;
      }
      return s;
    };
    const [pr, pg, pb] = mean('pig', 'body');
    expect(pr).toBeGreaterThan(pg + 30); // pink
    expect(pr).toBeGreaterThan(pb + 10);
    const ewe = mean('sheep', 'body');
    expect(Math.min(...ewe)).toBeGreaterThan(170); // cream-white fleece
    const [wr, wg, wb] = mean('wolf', 'body');
    expect(Math.max(Math.abs(wr - wg), Math.abs(wg - wb))).toBeLessThan(25); // grey
  });

  it('restModel stands a kind on its legs as one geometry (the pilot\'s sheep and pig)', () => {
    const sheep = restModel('sheep');
    expect(sheep.tris).toBe(variantTriangles(m, 'sheep', 'body'));
    let lo = Infinity;
    for (let i = 1; i < sheep.geo.positions.length; i += 3) lo = Math.min(lo, sheep.geo.positions[i]);
    expect(lo).toBeCloseTo(0, 3);
    expect(restModel('pig').image).toBe(m.image);
  });
});

describe('animalRenderer — heads, the young, tags and snares (§69.1, §100)', () => {
  const mk = (kind, more = {}) => ({ kind, x: 0, y: 10, z: 0, yaw: 0, walkPhase: 0, hurt: 0, shorn: 0, tamed: false, air: 0, rear: 0, swipe: 0, sex: 'f', size: 1, mode: 'walk', ...more });
  const by = (r, name) => r.group.children.find((x) => x.name === name);
  const mat = (mesh, i = 0) => {
    const out = new THREE.Matrix4();
    mesh.getMatrixAt(i, out);
    return out;
  };

  it('headPitch: down to graze while it stands idle, UP while it stares at a crouching player, level otherwise', () => {
    const rig = MODELS.deer;
    expect(headPitch(mk('deer', { mode: 'idle' }), rig)).toBe(rig.head.graze);
    expect(headPitch(mk('deer', { mode: 'watch' }), rig)).toBe(rig.head.alert);
    expect(rig.head.graze).toBeLessThan(-0.8);
    expect(rig.head.alert).toBeGreaterThan(0.1);
    for (const mode of ['walk', 'flee', 'lure', 'follow']) expect(headPitch(mk('deer', { mode }), rig), mode).toBe(0);
    // not while ridden, sitting, snared, swimming or flying
    for (const more of [{ ridden: true }, { sitting: true }, { trapped: 5 }, { inWater: true }, { air: 1 }]) {
      expect(headPitch(mk('deer', { mode: 'idle', ...more }), rig), JSON.stringify(more)).toBe(0);
    }
    expect(headPitch(mk('fish', { mode: 'idle' }), MODELS.fish)).toBe(0);
  });

  it('the stare: a watching deer\'s nose rises, a grazing one\'s drops near the grass; it eases between them', () => {
    const scene = new THREE.Scene();
    const r = createAnimalRenderer(scene);
    const head = by(r, 'deer-head');
    const nose = new THREE.Vector3(0, 1.4, -0.9);
    const noseY = () => nose.clone().applyMatrix4(mat(head)).y;
    const deer = mk('deer');
    r.sync([deer], 10);
    const level = noseY();
    deer.mode = 'watch';
    r.sync([deer], 10);
    expect(noseY()).toBeGreaterThan(level + 0.08);
    deer.mode = 'idle';
    r.sync([deer], 1 / HEAD_RATE / 4);
    const between = noseY();
    r.sync([deer], 10);
    const grazing = noseY();
    expect(grazing).toBeLessThan(10 + 0.6); // its nose down by the grass
    expect(between).toBeGreaterThan(grazing);
    expect(between).toBeLessThan(level + 0.3);
    r.dispose();
  });

  it('a young one: drawn at its size, its head larger, its body rounder; a fawn on its spotted coat', () => {
    expect(youthOf({ size: 1 })).toBe(0);
    expect(youthOf({ size: YOUNG_SCALE })).toBeCloseTo(1, 6);
    const scene = new THREE.Scene();
    const r = createAnimalRenderer(scene);
    r.sync([mk('deer', { size: YOUNG_SCALE }), mk('cow', { size: YOUNG_SCALE })], 10);
    expect(by(r, 'deer-young').count).toBe(1);
    expect(by(r, 'deer-body').count).toBe(0);
    const s = new THREE.Vector3().setFromMatrixScale(mat(by(r, 'cow-head'))).x;
    expect(s).toBeCloseTo(YOUNG_SCALE * (1 + YOUNG_HEAD), 5);
    expect(new THREE.Vector3().setFromMatrixScale(mat(by(r, 'cow-legs'))).x).toBeCloseTo(YOUNG_SCALE, 5);
    r.dispose();
  });

  it('a tame cow, ewe or wolf wears its tag on its neck (a saddled horse needs none); a snared one a loop of cord', () => {
    const scene = new THREE.Scene();
    const r = createAnimalRenderer(scene);
    r.sync([mk('cow', { tamed: true }), mk('sheep', { tamed: true, x: 2 }), mk('wolf', { tamed: true, x: 4 }), mk('horse', { tamed: true, x: 6 }), mk('cow', { x: 8 })], 10);
    expect([by(r, 'cow-tag').count, by(r, 'sheep-tag').count, by(r, 'wolf-tag').count, by(r, 'horse-tag')]).toEqual([1, 1, 1, undefined]);
    expect(by(r, 'animal-snare').count).toBe(0);
    r.sync([mk('deer', { trapped: 30, trapCell: [0, 10, 0] })], 10);
    const snare = by(r, 'animal-snare');
    expect(snare.count).toBe(1);
    const at = new THREE.Vector3().setFromMatrixPosition(mat(snare));
    expect(at.x).toBeCloseTo(-MODELS.deer.legX, 1); // the left hind leg
    expect(at.z).toBeGreaterThan(0.2);
    expect(at.y).toBeLessThan(10.15);
    r.dispose();
  });
});
