// Caelancraft — the art-direction pilot's gallery (three, DOM). A dev page: `npx vite`, then /gallery.html; the game
// never loads it (`npm run build` builds index.html only).
//
// Three columns side by side on a sky-and-grass stage lit the way the game lights its mobs (the sun and the sky's
// hemisphere light of computeSky, Lambert materials): TODAY (the game's own renderers and skins), A: HEX-FACETED and
// B: SOFT-CHAMFER (pilotModels.js). Each row is one family, seen from a 3/4 front view, from the side and at game
// distance (a crop of a 900-pixel-tall view at the game's field of view, one pixel a pixel); the hand row is the
// first-person view at rest and mid-swing. `?row=avatar|zombie|animal|plant|hand` shows one row large, `?row=all` (the
// default) every row small. Every panel is one viewport of one canvas.
import * as THREE from 'three';
import { FOV } from './config.js';
import { computeSky, createSkyState } from './daynight.js';
import { createAvatarRenderer } from './avatarRenderer.js';
import { AvatarMotion } from './avatarMotion.js';
import { createZombieRenderer } from './zombieRenderer.js';
import { createAnimalRenderer } from './animalRenderer.js';
import { createPigRenderer } from './pigRenderer.js';
import { plantModel, PLANT_QUAD_STRIDE } from './plantModels.js';
import { paintSlot } from './atlas.js';
import { BLOCK, TILE, getFaceTile } from './blocks.js';
import { heldItemGeometry } from './heldItem.js';
import { HEX_SIZE, FACE_TOP } from './hex.js';
import { buildPilot, buildHand, STYLES } from './pilotModels.js';

/** @typedef {import('./pilotModels.js').PilotModel} PilotModel */

const params = new URLSearchParams(location.search);
const ROW = (params.get('row') || 'all').toLowerCase();
const COLUMNS = /** @type {const} */ (['today', 'hex', 'soft']);
const COLUMN_LABELS = { today: 'Today', hex: STYLES.hex.label, soft: STYLES.soft.label };
/** The game-distance view: a crop of a view this many pixels tall at the game's field of view. */
const GAME_VIEW_H = 900;

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('stage'));
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setScissorTest(true);
renderer.autoClear = false;

// ---- the light: the game's noon-ish sky (computeSky), the sun turned to come from the front-left of the 3/4 views
const sky = computeSky(0.42, createSkyState());
const SUN_DIR = new THREE.Vector3(-0.42, 0.7, -0.58).normalize();
const lin = (rgb) => new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
const HEMI_GROUND_FACTOR = 0.45;

/** A vertical sky gradient as a background texture. */
function skyTexture() {
  const n = 64;
  const data = new Uint8Array(4 * n);
  const z = sky.zenithColor;
  const h = sky.horizonColor;
  for (let i = 0; i < n; i++) {
    const t = Math.pow(i / (n - 1), 0.8);
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(255 * (z[c] + (h[c] - z[c]) * t));
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, 1, n);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = true;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
const SKY = skyTexture();

/** A game tile (32 px, nearest, sRGB) as a texture, repeated. */
function tileTexture(tile, repeat = 1) {
  const px = paintSlot(tile);
  const size = Math.round(Math.sqrt(px.length / 4));
  const tex = new THREE.DataTexture(new Uint8Array(px.buffer, px.byteOffset, px.byteLength), size, size);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.needsUpdate = true;
  return tex;
}
const GRASS_TOP = tileTexture(TILE.GRASS_TOP, 1);
const GRASS_SIDE = tileTexture(TILE.GRASS_SIDE, 1);
const STONE = tileTexture(TILE.STONE, 1);

/** A stage: sky, lights, grass underfoot (one tile a metre), a few hex blocks for scale. */
function stage({ blocks = [[-1.45, 1.5]], ground = 0, fpBlock = false } = {}) {
  const scene = new THREE.Scene();
  scene.background = SKY;
  scene.fog = new THREE.Fog(lin(sky.fogColor), 18, 70);
  const sun = new THREE.DirectionalLight(lin(sky.sunColor), sky.sunIntensity);
  sun.position.copy(SUN_DIR).multiplyScalar(50);
  scene.add(sun);
  const f = sky.fogColor;
  const hemi = new THREE.HemisphereLight(lin(sky.horizonColor), lin([f[0] * HEMI_GROUND_FACTOR, f[1] * HEMI_GROUND_FACTOR, f[2] * HEMI_GROUND_FACTOR]), sky.hemiIntensity);
  scene.add(hemi);
  const groundTex = GRASS_TOP.clone();
  groundTex.repeat.set(120, 120);
  groundTex.needsUpdate = true;
  const g = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshLambertMaterial({ map: groundTex }));
  g.rotation.x = -Math.PI / 2;
  g.position.y = ground;
  scene.add(g);
  const hexGeo = new THREE.CylinderGeometry(HEX_SIZE, HEX_SIZE, 1, 6, 1);
  for (const [x, z] of blocks) {
    const b = new THREE.Mesh(hexGeo, [
      new THREE.MeshLambertMaterial({ map: fpBlock ? STONE : GRASS_SIDE }),
      new THREE.MeshLambertMaterial({ map: fpBlock ? STONE : GRASS_TOP }),
      new THREE.MeshLambertMaterial({ map: STONE }),
    ]);
    b.position.set(x, ground + 0.5, z);
    scene.add(b);
  }
  return scene;
}

/** A soft round shadow under a model (radius r). */
function blobShadow(r, x = 0, z = 0) {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x2 = 0; x2 < n; x2++) {
      const d = Math.hypot(x2 - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2);
      data[(y * n + x2) * 4 + 3] = Math.round(255 * 0.42 * Math.max(0, 1 - d) ** 1.4);
    }
  }
  const tex = new THREE.DataTexture(data, n, n);
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2 * r, 2 * r), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0.004, z);
  m.renderOrder = 1;
  return m;
}

// ---------------------------------------------------------------------------------------------------
// The pilot's models as three meshes
// ---------------------------------------------------------------------------------------------------

/** @param {import('./paintKit.js').Img} img */
function atlasTexture(img) {
  const tex = new THREE.DataTexture(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** @param {PilotModel} m */
function pilotMesh(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.geo.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.geo.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.geo.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(m.geo.index, 1));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: atlasTexture(m.image), alphaTest: 0.5 }));
  mesh.name = 'pilot';
  return mesh;
}

/** heldItem.js's slab of `key` (vertex colours), placed by a column-major matrix. */
function slabMesh(key, matrix) {
  const slab = /** @type {NonNullable<ReturnType<typeof heldItemGeometry>>} */ (heldItemGeometry(key));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(slab.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(slab.normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(slab.colors, 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.matrixAutoUpdate = false;
  mesh.matrix.fromArray(Array.from(matrix));
  return { mesh, tris: slab.positions.length / 9 };
}

/** Triangles drawn by every visible mesh under `root` (instances counted). */
function trianglesOf(root) {
  let n = 0;
  root.traverse((o) => {
    const m = /** @type {THREE.Mesh} */ (o);
    if (!m.isMesh || !m.visible || m.name === 'pilot-skip') return;
    let visible = true;
    for (let p = m.parent; p; p = p.parent) if (!p.visible) visible = false;
    if (!visible) return;
    const g = m.geometry;
    const t = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    const k = /** @type {THREE.InstancedMesh} */ (o).isInstancedMesh ? /** @type {THREE.InstancedMesh} */ (o).count : 1;
    n += t * k;
  });
  return n;
}

// ---------------------------------------------------------------------------------------------------
// The rows: what each column shows and from where
// ---------------------------------------------------------------------------------------------------

/**
 * @typedef {Object} Shown  one column's content in one row
 * @property {THREE.Scene} scene
 * @property {string} stats
 * @property {THREE.Object3D} [follow]  the camera's parent for the first-person row
 */

const fmt = (n) => n.toLocaleString('en-US');
const pilotStats = (m, extra = '') => `${fmt(m.tris)} tris${extra} · atlas ${m.atlas[0]}×${m.atlas[1]} (${fmt(m.texels)} px painted) · 1 draw`;

/** @type {Record<string, { title: string, note: string, target: number[], dist: number, far: number, today: () => Shown, pilot: (style: 'hex'|'soft') => Shown, fp?: boolean, az?: number, elev?: number }>} */
const ROWS = {
  avatar: {
    title: 'Avatar — Caelan',
    note: 'separate hands and shoes, a neck, a nose, real hair masses; sleeves pushed up to a cuff',
    target: [0, 0.86, 0], dist: 3.3, far: 9,
    today() {
      const scene = stage();
      const av = createAvatarRenderer(scene);
      av.setAvatar('caelan');
      const motion = new AvatarMotion();
      motion.reset(0);
      const pose = motion.step(1 / 60, { yaw: 0, pitch: 0, vx: 0, vz: 0, onGround: true });
      av.sync({ x: 0, y: 0, z: 0, pose, showModel: true, showArm: false });
      scene.add(blobShadow(0.42));
      return { scene, stats: `${fmt(trianglesOf(av.group))} tris · sheet page 128×128 (16,384 px), nearest · ~9 draws` };
    },
    pilot(style) {
      const scene = stage();
      const m = buildPilot('caelan', style);
      scene.add(pilotMesh(m));
      scene.add(blobShadow(0.42));
      return { scene, stats: pilotStats(m) };
    },
  },
  zombie: {
    title: 'Zombie — a walker after someone',
    note: 'people-like, stooped, narrow slits in sunken hollows, a torn flannel shirt, patched trousers; no gore, nothing red',
    target: [0, 0.9, -0.1], dist: 3.7, far: 9,
    today() {
      const scene = stage();
      const zr = createZombieRenderer(scene, null, 2);
      zr.sync([/** @type {*} */ ({ id: 3, x: 0, y: 0, z: 0, yaw: 0, kind: 'walker', walkPhase: 0.7, swing: 0, mode: 'chase', tilt: 0.12, hurt: 0, smoking: false, side: 1, shield: 0 })], 0, 0);
      scene.add(blobShadow(0.42));
      return { scene, stats: `${fmt(trianglesOf(zr.group))} tris · skin page 128×64 (8,192 px) + glow, nearest · 5 draws` };
    },
    pilot(style) {
      const scene = stage();
      const m = buildPilot('zombie', style);
      scene.add(pilotMesh(m));
      scene.add(blobShadow(0.42));
      return { scene, stats: pilotStats(m) };
    },
  },
  animal: {
    title: 'Animals — a ewe and a pig',
    note: 'fleece as curls with puffs, a long dark face with side eyes; a pig with bristles, a snout, floppy ears, a curled tail',
    target: [0.05, 0.5, 0], dist: 3.6, far: 7, az: 0.95,
    today() {
      const scene = stage({ blocks: [[-1.6, 1.4]] });
      const ar = createAnimalRenderer(scene, 2);
      ar.sync([/** @type {*} */ ({ kind: 'sheep', x: -0.45, y: 0, z: 0.1, yaw: 0, walkPhase: 0, hurt: 0, sex: 'f', size: 1, shorn: 0 })]);
      const pr = createPigRenderer(scene, 2);
      pr.sync([/** @type {*} */ ({ x: 0.6, y: 0, z: -0.15, yaw: 0, walkPhase: 0, hurt: 0 })]);
      scene.add(blobShadow(0.55, -0.45, 0.1), blobShadow(0.5, 0.6, -0.15));
      const t = trianglesOf(ar.group) + trianglesOf(pr.group);
      return { scene, stats: `${fmt(t)} tris (both) · no texture: colours per vertex · ~5 draws` };
    },
    pilot(style) {
      const scene = stage({ blocks: [[-1.6, 1.4]] });
      const sheep = buildPilot('sheep', style);
      const pig = buildPilot('pig', style);
      const a = pilotMesh(sheep);
      a.position.set(-0.45, 0, 0.1);
      const b = pilotMesh(pig);
      b.position.set(0.6, 0, -0.15);
      scene.add(a, b, blobShadow(0.55, -0.45, 0.1), blobShadow(0.5, 0.6, -0.15));
      return { scene, stats: `ewe ${fmt(sheep.tris)} + pig ${fmt(pig.tris)} tris · atlases ${fmt(sheep.texels)} + ${fmt(pig.texels)} px painted · 1 draw each` };
    },
  },
  plant: {
    title: 'Plants — the honeyberry bush (and, right, a crab apple bush today / a sapling in the pilot)',
    note: 'leaf masses as faceted gems painted with layered leaves and veins; bark; elongated berries with a bloom',
    target: [0.42, 0.36, 0.1], dist: 3.0, far: 5, az: 0.5, elev: 0.28,
    today() {
      const scene = stage({ blocks: [] });
      const a = todayPlant(BLOCK.HONEYBERRY_BUSH, TILE.HONEYBERRY_BUSH);
      const b = todayPlant(BLOCK.CRAB_APPLE_BUSH, null);
      b.mesh.position.set(0.85, 0, 0.2);
      scene.add(a.mesh, b.mesh);
      return { scene, stats: `${fmt(a.tris)} + ${fmt(b.tris)} tris · its 32-px tile (1,024 px), nearest · in the chunk mesh` };
    },
    pilot(style) {
      const scene = stage({ blocks: [] });
      const bush = buildPilot('honeyberry', style);
      const sap = buildPilot('sapling', style);
      const b = pilotMesh(sap);
      b.position.set(0.85, 0, 0.2);
      scene.add(pilotMesh(bush), b);
      return { scene, stats: `bush ${fmt(bush.tris)} + sapling ${fmt(sap.tris)} tris · one ${bush.atlas[0]}×${bush.atlas[1]} atlas (${fmt(bush.texels)} px painted)` };
    },
  },
  hand: {
    title: 'First person — the hand with an iron pick, at rest and mid-swing',
    note: 'smaller and lower; a sleeve cuff, a palm, four curled fingers and a thumb round the haft',
    target: [0, 0, 0], dist: 0, far: 0, fp: true,
    today: () => fpToday(0),
    pilot: (style) => fpPilot(style, 0),
  },
};

/** Close looks (not in the 'all' view): ?row=fist (the fist in its own frame), ?row=head (Caelan's head). */
const DEBUG_ROWS = {};
DEBUG_ROWS.head = {
  title: 'Caelan, close up', note: 'the head and the hair at a portrait distance',
  target: [0, 1.36, 0], dist: 1.25, far: 4, az: 0.5, elev: 0.08,
  today: () => ROWS.avatar.today(),
  pilot: (style) => ROWS.avatar.pilot(style),
};
DEBUG_ROWS.fist = {
  title: 'The fist, close up', note: 'its own frame: the haft along +y, the elbow toward +z',
  target: [0, 0.03, 0.04], dist: 0.5, far: 1.2, az: Math.PI - 0.7, elev: 0.55,
  today() {
    return { scene: stage({ blocks: [], ground: -0.6 }), stats: '' };
  },
  pilot(style) {
    const scene = stage({ blocks: [], ground: -0.6 });
    const m = buildHand(style, 0, { frame: 'hand' });
    scene.add(pilotMesh(m));
    scene.add(slabMesh('iron_pick', /** @type {Float64Array} */ (m.tool)).mesh);
    return { scene, stats: `${fmt(m.tris)} tris` };
  },
};

/**
 * Today's plant model of a block (plantModels.js quads on its own tile, shaded the way the mesher shades them), in a
 * mesh of its own.
 */
function todayPlant(blockId, tile) {
  const quads = /** @type {Float32Array} */ (plantModel(blockId));
  const n = quads.length / PLANT_QUAD_STRIDE;
  const pos = [];
  const nor = [];
  const uv = [];
  const col = [];
  const idx = [];
  for (let q = 0; q < n; q++) {
    const o = q * PLANT_QUAD_STRIDE;
    const [nx, ny, nz, sh] = [quads[o + 20], quads[o + 21], quads[o + 22], quads[o + 23]];
    const shade = sh * (0.58 + 0.42 * Math.min(1, Math.max(0, 0.5 + 0.5 * (nx * 0.35 + ny * 0.85 + nz * 0.4))));
    for (let v = 0; v < 4; v++) {
      const p = o + v * 5;
      pos.push(quads[p], quads[p + 1], quads[p + 2]);
      nor.push(nx, ny, nz);
      uv.push(quads[p + 3] / 16, quads[p + 4] / 16);
      col.push(shade, shade, shade);
    }
    const b = q * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const tex = tileTexture(tile ?? blockTopTile(blockId), 1);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide }));
  return { mesh, tris: n * 2 };
}

/** A block's top tile (blocks.js). */
function blockTopTile(id) {
  return getFaceTile(id, FACE_TOP);
}

/** The first-person stage: the player's eye 1.62 m over the grass, looking down a little at a stone block ahead. */
function fpScene() {
  const scene = stage({ blocks: [[0.1, -1.55], [-1.05, -2.1], [1.2, -2.4]], ground: -1.62, fpBlock: true });
  const cam = new THREE.PerspectiveCamera(FOV, 16 / 10, 0.05, 200);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(-0.38, 0.06, 0);
  scene.add(cam);
  return { scene, cam };
}

/** Today's arm (avatarRenderer) holding an iron pick: `swing` 0 rest, else that far through a swing. */
function fpToday(swing) {
  const { scene, cam } = fpScene();
  const av = createAvatarRenderer(scene);
  av.setAvatar('caelan');
  av.setHeld('iron_pick');
  const motion = new AvatarMotion();
  motion.reset(0);
  let pose = motion.step(1 / 60, { yaw: 0, pitch: -0.38, vx: 0, vz: 0, onGround: true });
  if (swing > 0) {
    motion.swing();
    pose = motion.step(0.3 * swing, { yaw: 0, pitch: -0.38, vx: 0, vz: 0, onGround: true });
  }
  cam.updateMatrixWorld(true);
  av.sync({ x: 0, y: -1.62, z: 0, pose, showModel: false, showArm: true, camera: cam });
  return { scene, cam, stats: `arm ${fmt(trianglesOf(av.armGroup))} tris (arm + slab) · 2 draws` };
}

/** The pilot's hand in style `style`: `swing` 0 rest .. 1 the bottom of the stroke. */
function fpPilot(style, swing) {
  const { scene, cam } = fpScene();
  const m = buildHand(style, swing);
  const mesh = pilotMesh(m);
  cam.add(mesh);
  const tool = slabMesh('iron_pick', /** @type {Float64Array} */ (m.tool));
  cam.add(tool.mesh);
  return { scene, cam, stats: `hand ${fmt(m.tris)} tris + slab ${fmt(tool.tris)} · same atlas as the avatar · 2 draws` };
}

// ---------------------------------------------------------------------------------------------------
// Layout and drawing
// ---------------------------------------------------------------------------------------------------

const labels = /** @type {HTMLElement} */ (document.getElementById('labels'));
function label(text, x, y, cls) {
  const d = document.createElement('div');
  d.className = `lab ${cls}`;
  d.textContent = text;
  d.style.left = `${Math.round(x)}px`;
  d.style.top = `${Math.round(y)}px`;
  labels.appendChild(d);
}

/** @type {{ scene: THREE.Scene, cam: THREE.Camera, rect: number[] }[]} */
const panels = [];
const W = window.innerWidth;
const H = window.innerHeight;

/** A camera at azimuth `az` (0: straight in front of a model facing −Z; positive toward its right, +x). */
function orbit(target, dist, az, elev, aspect, fov = 30) {
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.05, 300);
  cam.position.set(target[0] + Math.sin(az) * Math.cos(elev) * dist, target[1] + Math.sin(elev) * dist, target[2] - Math.cos(az) * Math.cos(elev) * dist);
  cam.lookAt(target[0], target[1], target[2]);
  return cam;
}

/** A crop of a GAME_VIEW_H-tall view at the game's field of view, centred on the target: one pixel a game pixel. */
function farCam(target, dist, aspect, w, h) {
  const cam = orbit(target, dist, 0.55, 0.12, (GAME_VIEW_H * 16) / 10 / GAME_VIEW_H, FOV);
  const fw = (GAME_VIEW_H * 16) / 10;
  cam.setViewOffset(fw, GAME_VIEW_H, fw / 2 - w / 2, GAME_VIEW_H / 2 - h / 2, w, h);
  return cam;
}

function layoutRow(key, top, height, compact) {
  const row = /** @type {*} */ (DEBUG_ROWS[key] ?? ROWS[key]);
  const az = row.az ?? 0.62;
  const elev = row.elev ?? 0.1;
  const colW = W / 3;
  label(`${row.title}${compact ? '' : ` — ${row.note}`}`, 10, top + 2, 'head');
  const head = 30;
  COLUMNS.forEach((col, ci) => {
    const x0 = ci * colW;
    const shown = col === 'today' ? row.today() : row.pilot(col);
    const y0 = top + head;
    const h = height - head;
    if (row.fp) {
      const views = compact ? [0] : [0, 1];
      const vh = compact ? h : h / 2;
      views.forEach((v, vi) => {
        const s = v === 0 ? shown : col === 'today' ? fpToday(0.42) : fpPilot(col, 0.7);
        const rect = [x0 + 3, y0 + vi * vh + 2, colW - 6, vh - 4];
        const cam = /** @type {THREE.PerspectiveCamera} */ (/** @type {*} */ (s).cam);
        cam.aspect = rect[2] / rect[3];
        cam.updateProjectionMatrix();
        panels.push({ scene: s.scene, cam, rect });
        if (!compact) label(v === 0 ? 'at rest' : 'mid-swing', rect[0] + 6, rect[1] + 6, 'view');
      });
    } else if (compact) {
      const rect = [x0 + 3, y0 + 2, colW - 6, h - 4];
      panels.push({ scene: shown.scene, cam: orbit(row.target, row.dist * 1.05, az, elev, rect[2] / rect[3]), rect });
    } else {
      const mainH = Math.round(h * 0.64);
      const main = [x0 + 3, y0 + 2, colW - 6, mainH - 4];
      panels.push({ scene: shown.scene, cam: orbit(row.target, row.dist, az, elev, main[2] / main[3]), rect: main });
      label('3/4 front', main[0] + 6, main[1] + 6, 'view');
      const sw = (colW - 6) / 2;
      const side = [x0 + 3, y0 + mainH, sw - 2, h - mainH - 2];
      panels.push({ scene: shown.scene, cam: orbit(row.target, row.dist * 1.1, Math.PI / 2, 0.06, side[2] / side[3]), rect: side });
      label('side', side[0] + 6, side[1] + 6, 'view');
      const far = [x0 + 3 + sw, y0 + mainH, sw, h - mainH - 2];
      panels.push({ scene: shown.scene, cam: farCam(row.target, row.far, 1, far[2], far[3]), rect: far });
      label(`at ${row.far} m, game scale`, far[0] + 6, far[1] + 6, 'view');
    }
    label(COLUMN_LABELS[col], x0 + 8, top + height - 22 - (compact ? 0 : 0), 'head');
    label(shown.stats, x0 + 8 + (col === 'today' ? 70 : 150), top + height - 20, 'stat');
  });
}

const titleEl = /** @type {HTMLElement} */ (document.getElementById('title'));
const keys = DEBUG_ROWS[ROW] ? [ROW] : ROW === 'all' || !ROWS[ROW] ? Object.keys(ROWS) : [ROW];
titleEl.innerHTML = 'Caelancraft art-direction pilot<span>Today · A: Hex-faceted · B: Soft-chamfer — same painted textures, two shape languages</span>';
const top0 = 34;
const rowH = (H - top0) / keys.length;
keys.forEach((k, i) => layoutRow(k, top0 + i * rowH, rowH, keys.length > 1));

function draw() {
  renderer.setScissor(0, 0, W, H);
  renderer.setViewport(0, 0, W, H);
  renderer.setClearColor(0xb9d2ea, 1);
  renderer.clear();
  for (const p of panels) {
    const [x, y, w, h] = p.rect;
    const gy = H - y - h;
    renderer.setViewport(x, gy, w, h);
    renderer.setScissor(x, gy, w, h);
    renderer.clear();
    renderer.render(p.scene, p.cam);
  }
}
draw();
document.title = `Caelancraft art pilot — ${keys.join(', ')}`;
/** @type {*} */ (window).__galleryReady = true;
