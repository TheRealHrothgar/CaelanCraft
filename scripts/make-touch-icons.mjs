// Caelancraft — draws the home-screen icons (CONTRACTS §95) into public/: one grass-topped hexagonal prism on the dark
// panel colour with a soft honey glow. Plain Node (zlib for the PNG), no dependencies, the same bytes every run:
//   node scripts/make-touch-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = [
  ['public/apple-touch-icon.png', 180],
  ['public/icons/icon-192.png', 192],
  ['public/icons/icon-512.png', 512],
];
const SS = 4; // supersamples per pixel, each way

const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG_TOP = hexRgb('#2c2738');
const BG_BOTTOM = hexRgb('#1c1a24');
const HONEY = hexRgb('#e8b04a');
const SHADOW = [0, 0, 0];

// The prism: a flat-top hexagon seen from above at a slant (squashed in y), three side faces showing.
const CX = 0.5;
const CY = 0.36;
const R = 0.33;
const SQUASH = 0.55;
const H = 0.3;
const SKIRT = 0.075;
const V = Array.from({ length: 6 }, (_, i) => {
  const a = (i * Math.PI) / 3;
  return [CX + R * Math.cos(a), CY + R * SQUASH * Math.sin(a)];
});
const down = (p, d) => [p[0], p[1] + d];
const quad = (a, b, d0, d1) => [down(a, d0), down(b, d0), down(b, d1), down(a, d1)];
/** Faces back to front: [polygon, colour]. */
const SHAPES = [
  [quad(V[0], V[1], 0, H), hexRgb('#74482a')], // right side (shade)
  [quad(V[0], V[1], 0, SKIRT), hexRgb('#4f8430')],
  [quad(V[2], V[3], 0, H), hexRgb('#9a6a3e')], // left side (lit)
  [quad(V[2], V[3], 0, SKIRT), hexRgb('#6aa840')],
  [quad(V[1], V[2], 0, H), hexRgb('#8a5a34')], // front
  [quad(V[1], V[2], 0, SKIRT), hexRgb('#5f9a38')],
  [V, hexRgb('#74b84a')], // the top
  [V.map(([x, y]) => [CX + (x - CX) * 0.72, CY + (y - CY) * 0.72]), hexRgb('#80c455')],
];

/** Inside a convex polygon (either winding). */
function inside(poly, x, y) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      const s = c > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The colour at (x, y) in the unit square (y down). */
function sample(x, y) {
  let c = mix(BG_TOP, BG_BOTTOM, y);
  const g = Math.hypot(x - 0.5, (y - 0.52) * 1.1) / 0.48;
  if (g < 1) c = mix(c, HONEY, 0.22 * (1 - g) * (1 - g));
  const s = Math.hypot((x - 0.5) / 0.36, (y - 0.835) / 0.07);
  if (s < 1) c = mix(c, SHADOW, 0.4 * (1 - s));
  for (const [poly, col] of SHAPES) if (inside(poly, x, y)) c = col;
  return c;
}

/** RGB bytes of a size × size icon. */
function render(size) {
  const px = Buffer.alloc(size * size * 3);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const c = sample((i + (si + 0.5) / SS) / size, (j + (sj + 0.5) / SS) / size);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = SS * SS;
      const o = (j * size + i) * 3;
      px[o] = Math.round(r / n);
      px[o + 1] = Math.round(g / n);
      px[o + 2] = Math.round(b / n);
    }
  }
  return px;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** An 8-bit RGB PNG. */
function png(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let j = 0; j < size; j++) {
    raw[j * (size * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, j * (size * 3 + 1) + 1, j * size * 3, (j + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const root = fileURLToPath(new URL('..', import.meta.url));
for (const [path, size] of OUT) {
  const file = root + path;
  mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  writeFileSync(file, png(size, render(size)));
  console.log(`${path} ${size}×${size}`);
}
