// Caelancraft — texture atlas builder and the 2D assets derived from it (block icons, tiled
// backgrounds, title logo, sun/moon sprites). See src/CONTRACTS.md §16, docs/SPEC-gameplay.md
// §2.1 / §2.5 / §5.3 and docs/SPEC-engine.md (Three.js facts 2 and 5).
//
// DOM + three. Every DOM access happens inside a function so the module can be imported in Node.
// Imports: config, blocks, tiles, three (per the CONTRACTS.md import graph — coords is deliberately
// not imported; the two side-face indices used by the icon are spelled out below).
import { CanvasTexture, NearestFilter, SRGBColorSpace, ClampToEdgeWrapping } from 'three';
import { ATLAS_TILE_PX, ATLAS_TILES_PER_ROW, ATLAS_SIZE_PX } from './config.js';
import { BLOCK, TILE, TILE_IDS, getBlockDef, getFaceTile, FACE_PY } from './blocks.js';
import { paintTile } from './tiles.js';

/** Icon geometry in §2.5 is specified on a 32×32 canvas; other sizes scale uniformly from it. */
export const ICON_BASE_SIZE = 32;

/** Face whose tile is shown on the LEFT side of the isometric icon: +Z (south). */
const ICON_LEFT_FACE = 4;
/** Face whose tile is shown on the RIGHT side of the isometric icon: +X (east). */
const ICON_RIGHT_FACE = 0;

/**
 * The three visible cube faces of a block icon, in paint order (top, left, right).
 * `m` is the exact `setTransform(a, b, c, d, e, f)` from SPEC-gameplay §2.5 for a 32×32 icon: it maps the
 * 16×16 tile onto the parallelogram of that face. `shade` is the black overlay alpha applied afterwards
 * with `source-atop` (so transparent tile pixels — leaves holes, glass interior — stay transparent).
 *   T(16,1) R(30,8) L(2,8) C(16,15) BL(2,22) BR(30,22) B(16,29)
 */
const ICON_FACES = Object.freeze([
  Object.freeze({ face: FACE_PY, m: Object.freeze([14 / 16, 7 / 16, -14 / 16, 7 / 16, 16, 1]), shade: 0 }),
  Object.freeze({ face: ICON_LEFT_FACE, m: Object.freeze([14 / 16, 7 / 16, 0, 14 / 16, 2, 8]), shade: 0.2 }),
  Object.freeze({ face: ICON_RIGHT_FACE, m: Object.freeze([14 / 16, -7 / 16, 0, 14 / 16, 16, 15]), shade: 0.4 }),
]);

const TILES_PER_ATLAS = ATLAS_TILES_PER_ROW * ATLAS_TILES_PER_ROW;
const LOGO_TEXT = 'Caelancraft';

/**
 * Pixel origin of a tile inside the atlas: `((t % 16) * 16, floor(t / 16) * 16)` (CONTRACTS §0).
 * Anything that is not a valid tile id (negative, fractional, >= 256, NaN) maps to TILE.MISSING so a
 * bad id shows the magenta/black checker instead of throwing or sampling garbage.
 * @param {number} tile
 * @returns {[number, number]} [sx, sy]
 */
export function tileOrigin(tile) {
  const t = Number.isInteger(tile) && tile >= 0 && tile < TILES_PER_ATLAS ? tile : TILE.MISSING;
  return [(t % ATLAS_TILES_PER_ROW) * ATLAS_TILE_PX, Math.floor(t / ATLAS_TILES_PER_ROW) * ATLAS_TILE_PX];
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {HTMLCanvasElement}
 */
function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {CanvasRenderingContext2D}
 */
function get2D(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('atlas: 2D canvas context unavailable');
  return ctx;
}

/**
 * Build the 256×256 texture atlas. Every id in TILE_IDS is painted with `paintTile` (pure RGBA pixels)
 * and blitted with `putImageData` at its tile origin, so alpha is written verbatim (water 178, glass
 * interior 0, leaf holes 0) rather than composited. Reserved tiles (27–254) stay transparent black.
 * @returns {HTMLCanvasElement}
 */
export function createAtlasCanvas() {
  const canvas = createCanvas(ATLAS_SIZE_PX, ATLAS_SIZE_PX);
  const ctx = get2D(canvas);
  const img = ctx.createImageData(ATLAS_TILE_PX, ATLAS_TILE_PX);
  for (const tile of TILE_IDS) {
    const pixels = paintTile(tile);
    if (pixels.length !== img.data.length) {
      throw new Error(`atlas: paintTile(${tile}) returned ${pixels.length} bytes, expected ${img.data.length}`);
    }
    img.data.set(pixels);
    const [sx, sy] = tileOrigin(tile);
    ctx.putImageData(img, sx, sy);
  }
  return canvas;
}

/**
 * Wrap the atlas canvas in a Three.js texture configured for pixel-art voxel sampling: nearest filtering
 * both ways, no mipmaps, `flipY = false` (so UV v grows down the image, matching `tileToUV`), sRGB colour
 * space (r186 textures default to NoColorSpace, which washes colours out), clamp wrapping.
 * @param {HTMLCanvasElement} canvas
 * @returns {CanvasTexture}
 */
export function createAtlasTexture(canvas) {
  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.anisotropy = 1;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Draw the isometric cube icon of `blockId` into the `size`×`size` square at (0,0) of `ctx`
 * (SPEC-gameplay §2.5, scaled by `size / 32`). The square is cleared first, so AIR (or an unknown id)
 * leaves it blank — which is exactly what an empty hotbar slot needs. The context state (transform,
 * composite op, smoothing, fill style) is saved and restored around the drawing.
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLCanvasElement} atlasCanvas  from createAtlasCanvas()
 * @param {number} blockId
 * @param {number} [size=32]
 */
export function drawBlockIcon(ctx, atlasCanvas, blockId, size = ICON_BASE_SIZE) {
  if (!(size > 0) || !Number.isFinite(size)) return;
  const s = size / ICON_BASE_SIZE;
  const def = getBlockDef(blockId);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, size, size);
  if (def.id !== BLOCK.AIR) {
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < ICON_FACES.length; i++) {
      const { face, m, shade } = ICON_FACES[i];
      const [sx, sy] = tileOrigin(getFaceTile(def.id, face));
      // Overall transform = Scale(s) ∘ FaceTransform: every coefficient scales by s.
      ctx.setTransform(m[0] * s, m[1] * s, m[2] * s, m[3] * s, m[4] * s, m[5] * s);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(atlasCanvas, sx, sy, ATLAS_TILE_PX, ATLAS_TILE_PX, 0, 0, ATLAS_TILE_PX, ATLAS_TILE_PX);
      if (shade > 0) {
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = `rgba(0,0,0,${shade})`;
        ctx.fillRect(0, 0, ATLAS_TILE_PX, ATLAS_TILE_PX);
      }
    }
  }
  ctx.restore();
}

/**
 * A fresh `size`×`size` canvas holding the icon of `blockId` (blank for AIR).
 * @param {HTMLCanvasElement} atlasCanvas
 * @param {number} blockId
 * @param {number} [size=32]
 * @returns {HTMLCanvasElement}
 */
export function makeBlockIconCanvas(atlasCanvas, blockId, size = ICON_BASE_SIZE) {
  const canvas = createCanvas(size, size);
  drawBlockIcon(get2D(canvas), atlasCanvas, blockId, size);
  return canvas;
}

/**
 * PNG data URL of `tile` repeated `repeats`×`repeats` times (16·repeats px square), for CSS backgrounds
 * (`background-size: 64px 64px` with the default 4 repeats). `repeats` is floored and clamped to >= 1.
 * @param {HTMLCanvasElement} atlasCanvas
 * @param {number} tile  atlas tile id (e.g. TILE.DIRT)
 * @param {number} [repeats=4]
 * @returns {string}
 */
export function makeTiledBackgroundDataURL(atlasCanvas, tile, repeats = 4) {
  const n = Number.isFinite(repeats) ? Math.max(1, Math.floor(repeats)) : 4;
  const px = ATLAS_TILE_PX;
  const canvas = createCanvas(px * n, px * n);
  const ctx = get2D(canvas);
  ctx.imageSmoothingEnabled = false;
  const [sx, sy] = tileOrigin(tile);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      ctx.drawImage(atlasCanvas, sx, sy, px, px, i * px, j * px, px, px);
    }
  }
  return canvas.toDataURL('image/png');
}

/**
 * Draw the "Caelancraft" title logo (SPEC-gameplay §5.3) onto `logoCanvas`: a dark drop shadow, the
 * text filled with a repeating stone-tile pattern, then a 1 px black outline. Coordinates are the spec's
 * for the 200×32 `#title-logo` canvas (font bold 22px, centre (100,16), shadow at (+2,+2)) and scale with
 * the canvas height for other sizes. The canvas is cleared first so repeated calls do not accumulate.
 * @param {HTMLCanvasElement} logoCanvas
 * @param {HTMLCanvasElement} atlasCanvas
 */
export function drawTitleLogo(logoCanvas, atlasCanvas) {
  const ctx = get2D(logoCanvas);
  const w = logoCanvas.width;
  const h = logoCanvas.height;
  const k = h / 32;
  const cx = w / 2;
  const cy = h / 2;
  const shadowOffset = 2 * k;

  // 16×16 stone swatch to use as the fill pattern.
  const swatch = createCanvas(ATLAS_TILE_PX, ATLAS_TILE_PX);
  const sctx = get2D(swatch);
  sctx.imageSmoothingEnabled = false;
  const [sx, sy] = tileOrigin(TILE.STONE);
  sctx.drawImage(atlasCanvas, sx, sy, ATLAS_TILE_PX, ATLAS_TILE_PX, 0, 0, ATLAS_TILE_PX, ATLAS_TILE_PX);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.font = `bold ${Math.round(22 * k)}px monospace`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  ctx.fillStyle = '#1a1a1a';
  ctx.fillText(LOGO_TEXT, cx + shadowOffset, cy + shadowOffset);

  const pattern = ctx.createPattern(swatch, 'repeat');
  ctx.fillStyle = pattern ?? '#7E7E7E';
  ctx.fillText(LOGO_TEXT, cx, cy);

  ctx.lineWidth = 1;
  ctx.strokeStyle = '#000';
  ctx.strokeText(LOGO_TEXT, cx, cy);
  ctx.restore();
}

/**
 * 32×32 sun sprite (§2.5): pale-yellow square with a lighter core.
 * @returns {HTMLCanvasElement}
 */
export function makeSunCanvas() {
  const canvas = createCanvas(32, 32);
  const ctx = get2D(canvas);
  ctx.fillStyle = '#FFF3A0';
  ctx.fillRect(4, 4, 24, 24);
  ctx.fillStyle = '#FFFBE0';
  ctx.fillRect(7, 7, 18, 18);
  return canvas;
}

/**
 * 32×32 moon sprite (§2.5): pale grey-blue square with three 2×2 craters.
 * @returns {HTMLCanvasElement}
 */
export function makeMoonCanvas() {
  const canvas = createCanvas(32, 32);
  const ctx = get2D(canvas);
  ctx.fillStyle = '#DDE2F0';
  ctx.fillRect(6, 6, 20, 20);
  ctx.fillStyle = '#B4BCD2';
  ctx.fillRect(9, 9, 2, 2);
  ctx.fillRect(17, 12, 2, 2);
  ctx.fillRect(12, 19, 2, 2);
  return canvas;
}
