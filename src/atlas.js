// Caelancraft — texture atlas builder and the 2D assets derived from it (block icons, tiled
// backgrounds, title logo, sun/moon sprites). See src/CONTRACTS.md §16, docs/SPEC-gameplay.md
// §2.1 / §2.5 / §5.3 and docs/SPEC-engine.md (Three.js facts 2 and 5).
//
// DOM + three. Every DOM access happens inside a function so the module can be imported in Node.
// Imports: config, blocks, hex, tiles, three (per the CONTRACTS.md import graph).
import { DataTexture, NearestFilter, NearestMipmapLinearFilter, SRGBColorSpace, ClampToEdgeWrapping, RGBAFormat, UnsignedByteType } from 'three';
import { ATLAS_SLOT_PX, ATLAS_TILES_PER_ROW, ATLAS_SIZE_PX, ATLAS_MIP_LEVELS } from './config.js';
import { BLOCK, TILE, TILE_IDS, getBlockDef, getFaceTile, FACE_TOP } from './blocks.js';
import { HEX_CORNERS, HEX_SIZE } from './hex.js';
import { paintTile } from './tiles.js';
import { paintTileHD, upscale16 } from './tilesHD.js';
import { extraSlots } from './tileVariants.js';

/** Icon geometry is specified on a 32×32 canvas; other sizes scale uniformly from it. */
export const ICON_BASE_SIZE = 32;

// Hexagonal-prism icon (CONTRACTS §16): a pointy-top prism seen from the south-east-ish front, so the top
// hexagon and the two front side faces (SE = face 1 on the right, SW = face 2 on the left) are visible. The
// top hexagon's corners project to screen (16 + 26·dx, 9 + 8·dz/HEX_SIZE) on the 32×32 reference canvas:
//   k0 (29,5)  k1 (29,13)  k2 (16,17)  k3 (3,13)  k4 (3,5)  k5 (16,1)
// and the prism's visible height is ICON_SIDE_H px, so the lowest point (below k2) sits at y = 31.
const ICON_CENTRE_X = 16;
const ICON_TOP_CY = 9;
const ICON_TOP_HALF_H = 8;
const ICON_SCALE_X = 26;
const ICON_SIDE_H = 14;

/** Face shown on the LEFT front of the icon (south-west, face 2) and its shade. */
const ICON_LEFT_FACE = 2;
/** Face shown on the RIGHT front of the icon (south-east, face 1). */
const ICON_RIGHT_FACE = 1;
const ICON_LEFT_SHADE = 0.2;
const ICON_RIGHT_SHADE = 0.4;

/**
 * Screen position of top corner k on the 32×32 reference canvas.
 * @param {number} k
 * @returns {[number, number]}
 */
export function iconTopCorner(k) {
  const c = HEX_CORNERS[k];
  return [ICON_CENTRE_X + ICON_SCALE_X * c[0], ICON_TOP_CY + (ICON_TOP_HALF_H * c[1]) / HEX_SIZE];
}

/**
 * `setTransform(a, b, c, d, e, f)` mapping the 32×32 slot onto the side quad whose top edge runs from
 * corner `kLeft` to corner `kRight` (left → right on screen) and whose bottom edge is ICON_SIDE_H lower.
 * @returns {number[]}
 */
function sideTransform(kLeft, kRight) {
  const [lx, ly] = iconTopCorner(kLeft);
  const [rx, ry] = iconTopCorner(kRight);
  return [(rx - lx) / ATLAS_SLOT_PX, (ry - ly) / ATLAS_SLOT_PX, 0, ICON_SIDE_H / ATLAS_SLOT_PX, lx, ly];
}

/** The two visible side faces, in paint order (left, right). */
const ICON_SIDES = Object.freeze([
  Object.freeze({ face: ICON_LEFT_FACE, m: Object.freeze(sideTransform(3, 2)), shade: ICON_LEFT_SHADE }),
  Object.freeze({ face: ICON_RIGHT_FACE, m: Object.freeze(sideTransform(2, 1)), shade: ICON_RIGHT_SHADE }),
]);
/** Transform mapping the tile onto the bounding box of the top hexagon (x 3..29, y 1..17); clipped to the hexagon. */
const ICON_TOP_TRANSFORM = Object.freeze([
  ICON_SCALE_X / ATLAS_SLOT_PX, 0, 0, (2 * ICON_TOP_HALF_H) / ATLAS_SLOT_PX,
  ICON_CENTRE_X - ICON_SCALE_X / 2, ICON_TOP_CY - ICON_TOP_HALF_H,
]);

const TILES_PER_ATLAS = ATLAS_TILES_PER_ROW * ATLAS_TILES_PER_ROW;
const LOGO_TEXT = 'Caelancraft';

/**
 * Pixel origin of a slot inside the atlas: `((t % 32) * 32, floor(t / 32) * 32)` (CONTRACTS §0, §90). Slot t is tile t
 * for t < 256; the extra pictures of the varied tiles sit above (tileVariants.variantSlot). Anything that is not a valid
 * slot (negative, fractional, >= 1024, NaN) maps to TILE.MISSING so a bad id shows the magenta/black checker instead of
 * throwing or sampling garbage.
 * @param {number} tile
 * @returns {[number, number]} [sx, sy]
 */
export function tileOrigin(tile) {
  const t = Number.isInteger(tile) && tile >= 0 && tile < TILES_PER_ATLAS ? tile : TILE.MISSING;
  return [(t % ATLAS_TILES_PER_ROW) * ATLAS_SLOT_PX, Math.floor(t / ATLAS_TILES_PER_ROW) * ATLAS_SLOT_PX];
}

/**
 * The 32×32 picture of slot content (tile, picture): tilesHD's painter when it has one, else the 16-px tile doubled.
 * @param {number} tile @param {number} picture
 * @returns {Uint8ClampedArray}
 */
export function paintSlot(tile, picture = 0) {
  return paintTileHD(tile, picture) ?? upscale16(paintTile(tile));
}

/** Copy a 32×32 picture into the atlas pixels at slot `slot`. */
function blit(atlas, slot, pic) {
  const [sx, sy] = tileOrigin(slot);
  const row = ATLAS_SLOT_PX * 4;
  for (let y = 0; y < ATLAS_SLOT_PX; y++) {
    atlas.set(pic.subarray(y * row, (y + 1) * row), ((sy + y) * ATLAS_SIZE_PX + sx) * 4);
  }
}

/**
 * The atlas as RGBA pixels (ATLAS_SIZE_PX square, idx = (y * ATLAS_SIZE_PX + x) * 4), PURE: every id in TILE_IDS in its
 * own slot, then every extra picture of the varied tiles (§90) in its slot. Slots nothing uses stay transparent black.
 * @returns {Uint8ClampedArray}
 */
export function createAtlasPixels() {
  const atlas = new Uint8ClampedArray(ATLAS_SIZE_PX * ATLAS_SIZE_PX * 4);
  for (const tile of TILE_IDS) blit(atlas, tile, paintSlot(tile, 0));
  for (const [slot, tile, picture] of extraSlots()) blit(atlas, slot, paintSlot(tile, picture));
  return atlas;
}

/**
 * The mip chain of the atlas, PURE: level 0 is `pixels`, each next level halves it, down to one texel per slot
 * (ATLAS_MIP_LEVELS levels). Slots are powers of two in size, so a 2×2 block never straddles two slots: no picture ever
 * bleeds into its neighbour, however far away a face is. Colour is the mean of the opaque children (so leaves' and plants'
 * cut-out edges keep their own colour), alpha the MOST opaque child's (so a leaf canopy, a glass frame or a plant's thin
 * parts stay solid far away instead of fading through the alpha test).
 * @param {Uint8ClampedArray} pixels
 * @param {number} [size=ATLAS_SIZE_PX]
 * @returns {Array<{ data: Uint8Array, width: number, height: number }>}
 */
export function buildAtlasMips(pixels, size = ATLAS_SIZE_PX) {
  const levels = [{ data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length), width: size, height: size }];
  for (let l = 1; l < ATLAS_MIP_LEVELS; l++) {
    const src = levels[l - 1];
    const w = src.width >> 1;
    const out = new Uint8Array(w * w * 4);
    const sw = src.width;
    const d = src.data;
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, aw = 0, amax = 0, rr = 0, gg = 0, bb = 0;
        for (let j = 0; j < 2; j++) {
          for (let i = 0; i < 2; i++) {
            const k = ((y * 2 + j) * sw + x * 2 + i) * 4;
            const a = d[k + 3];
            r += d[k] * a; g += d[k + 1] * a; b += d[k + 2] * a; aw += a;
            rr += d[k]; gg += d[k + 1]; bb += d[k + 2];
            if (a > amax) amax = a;
          }
        }
        const o = (y * w + x) * 4;
        if (aw > 0) {
          out[o] = Math.round(r / aw); out[o + 1] = Math.round(g / aw); out[o + 2] = Math.round(b / aw);
        } else {
          out[o] = rr >> 2; out[o + 1] = gg >> 2; out[o + 2] = bb >> 2;
        }
        out[o + 3] = amax;
      }
    }
    levels.push({ data: out, width: w, height: w });
  }
  return levels;
}

/** createAtlasCanvas → the pixels it was painted from, so createAtlasTexture never reads them back off the canvas. */
const ATLAS_PIXELS = new WeakMap();

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
 * Build the 1024×1024 texture atlas (§90): createAtlasPixels written with one `putImageData`, so alpha is written verbatim
 * (water 178, glass interior 0, leaf holes 0) rather than composited. 2D users (block icons, backgrounds, the logo) draw
 * from this canvas.
 * @returns {HTMLCanvasElement}
 */
export function createAtlasCanvas() {
  const pixels = createAtlasPixels();
  const canvas = createCanvas(ATLAS_SIZE_PX, ATLAS_SIZE_PX);
  const ctx = get2D(canvas);
  const img = ctx.createImageData(ATLAS_SIZE_PX, ATLAS_SIZE_PX);
  img.data.set(pixels);
  ctx.putImageData(img, 0, 0);
  ATLAS_PIXELS.set(canvas, pixels);
  return canvas;
}

/**
 * The chunk atlas as a Three.js texture for pixel-art voxel sampling: crisp up close (nearest magnification), and, since
 * §90, mipmapped far away from buildAtlasMips's own chain (nearest texel within a level, blended between levels), so
 * 32-px pictures do not shimmer in the distance and no slot ever bleeds into its neighbour. `flipY = false` (UV v grows
 * down the image, matching `tileToUV`), sRGB colour space (r186 textures default to NoColorSpace, which washes colours
 * out), clamp wrapping. The pixels come from createAtlasCanvas (or are read back from a canvas made elsewhere).
 * @param {HTMLCanvasElement} canvas
 * @returns {DataTexture}
 */
export function createAtlasTexture(canvas) {
  let pixels = ATLAS_PIXELS.get(canvas);
  if (!pixels) pixels = get2D(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
  const mips = buildAtlasMips(pixels, canvas.width);
  const texture = new DataTexture(mips[0].data, mips[0].width, mips[0].height, RGBAFormat, UnsignedByteType);
  texture.mipmaps = mips;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestMipmapLinearFilter;
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
 * Draw the icon of `blockId` into the `size`×`size` square at (0,0) of `ctx` (scaled by `size / 32`). A block whose
 * `icon` is 'prism' (the default) is drawn as a hexagonal prism: the top hexagon (top tile, clipped to the hexagon)
 * above the two front side faces (left shaded 20 %, right 40 %). A block whose `icon` is 'flat' (the circuit parts but the
 * keg: the thin fuse, torch and wires, whose prism with transparent sides would read as nothing — DESIGN-circuits §1.5 —
 * and the 14 devices, which are 3D models rather than prisms) is drawn as its TOP tile, an unskewed 2D picture fitted to
 * the square with nearest-neighbour scaling: one drawImage, no side faces and no hexagon. The square is cleared first, so AIR (or an unknown id) leaves it blank — which is exactly what an empty
 * hotbar slot needs. The context state (transform, clip, composite op, smoothing, fill style) is saved and restored
 * around the drawing.
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
  if (def.id !== BLOCK.AIR && def.icon === 'flat') {
    ctx.imageSmoothingEnabled = false;
    const [sx, sy] = tileOrigin(getFaceTile(def.id, FACE_TOP));
    ctx.drawImage(atlasCanvas, sx, sy, ATLAS_SLOT_PX, ATLAS_SLOT_PX, 0, 0, size, size);
  } else if (def.id !== BLOCK.AIR) {
    ctx.imageSmoothingEnabled = false;

    // Side faces first (the top overdraws their shared edge).
    for (let i = 0; i < ICON_SIDES.length; i++) {
      const { face, m, shade } = ICON_SIDES[i];
      const [sx, sy] = tileOrigin(getFaceTile(def.id, face));
      // Overall transform = Scale(s) ∘ FaceTransform: every coefficient scales by s.
      ctx.setTransform(m[0] * s, m[1] * s, m[2] * s, m[3] * s, m[4] * s, m[5] * s);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(atlasCanvas, sx, sy, ATLAS_SLOT_PX, ATLAS_SLOT_PX, 0, 0, ATLAS_SLOT_PX, ATLAS_SLOT_PX);
      if (shade > 0) {
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = `rgba(0,0,0,${shade})`;
        ctx.fillRect(0, 0, ATLAS_SLOT_PX, ATLAS_SLOT_PX);
      }
    }

    // Top hexagon: clip to the projected hexagon, then draw the top tile over its bounding box.
    ctx.save();
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    for (let k = 0; k < HEX_CORNERS.length; k++) {
      const [x, y] = iconTopCorner(k);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.clip();
    const m = ICON_TOP_TRANSFORM;
    const [sx, sy] = tileOrigin(getFaceTile(def.id, FACE_TOP));
    ctx.setTransform(m[0] * s, m[1] * s, m[2] * s, m[3] * s, m[4] * s, m[5] * s);
    ctx.drawImage(atlasCanvas, sx, sy, ATLAS_SLOT_PX, ATLAS_SLOT_PX, 0, 0, ATLAS_SLOT_PX, ATLAS_SLOT_PX);
    ctx.restore();
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
 * PNG data URL of `tile` repeated `repeats`×`repeats` times (32·repeats px square since §90), for CSS backgrounds
 * (`background-size: 64px 64px` with the default 4 repeats). `repeats` is floored and clamped to >= 1.
 * @param {HTMLCanvasElement} atlasCanvas
 * @param {number} tile  atlas tile id (e.g. TILE.DIRT)
 * @param {number} [repeats=4]
 * @returns {string}
 */
export function makeTiledBackgroundDataURL(atlasCanvas, tile, repeats = 4) {
  const n = Number.isFinite(repeats) ? Math.max(1, Math.floor(repeats)) : 4;
  const px = ATLAS_SLOT_PX;
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

  // The stone slot (32×32 since §90) as the fill pattern.
  const swatch = createCanvas(ATLAS_SLOT_PX, ATLAS_SLOT_PX);
  const sctx = get2D(swatch);
  sctx.imageSmoothingEnabled = false;
  const [sx, sy] = tileOrigin(TILE.STONE);
  sctx.drawImage(atlasCanvas, sx, sy, ATLAS_SLOT_PX, ATLAS_SLOT_PX, 0, 0, ATLAS_SLOT_PX, ATLAS_SLOT_PX);

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
