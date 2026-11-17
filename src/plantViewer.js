// Caelancraft — the plant viewer (three, DOM): a dev page (`npx vite`, then /plants.html) that shows the plant models
// (CONTRACTS §102) in a row on a strip of grass, meshed by the game's own chunk mesher and drawn by its own renderer and
// materials, so what it shows is what the game shows. The game never loads it (`npm run build` builds index.html only).
//
// ?ids=fern,thistle  block names, left to right (default: every kit model);  ?lod=0|1|2  near, far, card;
// ?time=0.42  the time of day;  ?dist=3  how far back the camera stands from the row (m);  ?height=1.4  its eye height
// above the grass;  ?yaw=0  its turn (degrees);  ?gap=2  cells between two plants;  ?pitch=-12  degrees.
import { createRenderer } from './renderer.js';
import { createAtlasCanvas, createAtlasTexture, createPlantAtlasTexture } from './atlas.js';
import { buildChunkMesh } from './mesher.js';
import { BLOCK, BLOCKS, BIOME } from './blocks.js';
import { CHUNK_SIZE, WORLD_HEIGHT } from './config.js';
import { localIndex } from './coords.js';
import { hexToWorld } from './hex.js';
import { computeSky, createSkyState } from './daynight.js';
import { KIT_MODEL_IDS, plantMesh } from './plantModels.js';

const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : d);
const names = (params.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ids = names.length ? names.map((n) => BLOCKS.findIndex((d) => d && d.name === n)).filter((id) => id > 0) : [...KIT_MODEL_IDS];
const lod = num('lod', 0);
const gap = num('gap', 2);
const FLOOR = 20;

/** A chunk of grass at FLOOR, the plants of `ids` along the row r = 8 from q = 1, `gap` apart (later chunks the rest). */
const chunks = new Map();
function chunkAt(cq, cr) {
  const key = `${cq},${cr}`;
  if (!chunks.has(key)) {
    const blocks = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
    for (let q = 0; q < CHUNK_SIZE; q++) {
      for (let r = 0; r < CHUNK_SIZE; r++) {
        for (let y = 0; y < FLOOR - 1; y++) blocks[localIndex(q, y, r)] = BLOCK.DIRT;
        blocks[localIndex(q, FLOOR - 1, r)] = BLOCK.GRASS_BLOCK;
      }
    }
    chunks.set(key, { blocks, biomes: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE).fill(BIOME.PLAINS), heights: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE).fill(FLOOR) });
  }
  return chunks.get(key);
}
const placed = [];
ids.forEach((id, i) => {
  const q = 1 + i * gap;
  const r = 8;
  const cq = Math.floor(q / CHUNK_SIZE);
  const c = chunkAt(cq, 0);
  c.blocks[localIndex(q - cq * CHUNK_SIZE, FLOOR, r)] = id;
  placed.push({ id, q, r });
});
const span = Math.max(1, Math.ceil((1 + ids.length * gap) / CHUNK_SIZE));
for (let cq = -1; cq <= span; cq++) for (let cr = -1; cr <= 1; cr++) chunkAt(cq, cr);

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('stage'));
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
const atlasTexture = createAtlasTexture(createAtlasCanvas());
const renderer = createRenderer(canvas, atlasTexture, { renderDistance: 6, plantAtlasTexture: createPlantAtlasTexture() });
renderer.resize(window.innerWidth, window.innerHeight);
const get = (cq, cr) => chunks.get(`${cq},${cr}`) ?? null;
let tris = 0;
for (const c of chunks.keys()) {
  const [cq, cr] = c.split(',').map(Number);
  const m = buildChunkMesh(cq, cr, get, { plantLod: lod });
  tris += m.plantTris ?? 0;
  renderer.setChunkMesh(c, cq, cr, m);
}
renderer.setSky(computeSky(num('time', 0.42), createSkyState()));
// the camera: in front of the middle of the row, looking at it
const mid = hexToWorld(1 + ((ids.length - 1) * gap) / 2, 8);
const yaw = (num('yaw', 0) * Math.PI) / 180;
const dist = num('dist', 3);
const camX = mid[0] - Math.sin(yaw) * -dist;
const camZ = mid[1] + Math.cos(yaw) * dist;
renderer.setCamera(camX, FLOOR + num('height', 1.4), camZ, yaw, (num('pitch', -12) * Math.PI) / 180);
renderer.render();
const info = document.getElementById('info');
if (info) {
  info.textContent = `${placed.map((p) => `${BLOCKS[p.id].name} ${plantMesh(p.id, lod, 0)?.tris ?? 0}`).join(' · ')} — lod ${lod}, ${tris} plant triangles`;
}
