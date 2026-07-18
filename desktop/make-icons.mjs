// make-icons.mjs — generates the app + tray icons from code, so no opaque binary
// assets are checked in. Pure Node (zlib only): builds RGBA pixels, then encodes PNG.
//
//   node desktop/make-icons.mjs
//
// Produces:
//   build/icon.png            512²  app icon (electron-builder derives .ico/.icns)
//   desktop/assets/tray.png   32²   colour tray icon (Windows/Linux)
//   desktop/assets/tray@2x.png 64²
//   desktop/assets/trayTemplate.png / @2x   macOS template (black + alpha)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── PNG encoding ────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  // 10-12: compression, filter, interlace — all 0

  // one filter byte (0 = None) per scanline
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    const dst = y * (width * 4 + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── drawing ─────────────────────────────────────────────────────────────────
const SS = 4; // supersampling factor per axis, for antialiased edges

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

// Signed-distance helpers, all in normalised 0..1 space.
const inRoundedRect = (x, y, r) => {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return Math.hypot(dx, dy) <= r;
};
const inRing = (x, y, cx, cy, outer, inner) => {
  const d = Math.hypot(x - cx, y - cy);
  return d <= outer && d >= inner;
};
const inDisc = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) <= r;

// The mark: a lens ring with three graph nodes orbiting it — a "lens over a graph".
const NODES = [
  { a: -Math.PI / 2, r: 0.40 },
  { a: Math.PI / 6, r: 0.40 },
  { a: (5 * Math.PI) / 6, r: 0.40 },
];

function sample(x, y, opts) {
  // returns [r,g,b,a] 0..255 for a point in 0..1 space
  const { bg, fg, withBg } = opts;

  if (withBg && !inRoundedRect(x, y, 0.22)) return [0, 0, 0, 0];

  // graph nodes
  for (const n of NODES) {
    const cx = 0.5 + Math.cos(n.a) * n.r;
    const cy = 0.5 + Math.sin(n.a) * n.r;
    if (inDisc(x, y, cx, cy, 0.085)) return [...fg, 255];
    // spokes from centre to each node
    const vx = Math.cos(n.a), vy = Math.sin(n.a);
    const t = (x - 0.5) * vx + (y - 0.5) * vy;
    if (t > 0.16 && t < n.r) {
      const px = 0.5 + vx * t, py = 0.5 + vy * t;
      if (Math.hypot(x - px, y - py) <= 0.018) return [...fg, 200];
    }
  }

  // lens ring
  if (inRing(x, y, 0.5, 0.5, 0.30, 0.215)) return [...fg, 255];

  return withBg ? [...bg, 255] : [0, 0, 0, 0];
}

function render(size, opts) {
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const [sr, sg, sb, sa] = sample(x, y, opts);
          // premultiply so partially covered edges blend correctly
          r += sr * sa; g += sg * sa; b += sb * sa; a += sa;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      if (a > 0) {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(g / a);
        buf[i + 2] = Math.round(b / a);
      }
      buf[i + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, buf);
}

// ── outputs ─────────────────────────────────────────────────────────────────
const BG = hex('#0b1220');   // deep navy, matches the UI shell
const CYAN = hex('#22d3ee'); // accent used by the graph
const BLACK = [0, 0, 0];

const write = (rel, buf) => {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  console.log(`  ${rel}  (${buf.length.toLocaleString()} bytes)`);
};

console.log('generating icons…');
write('build/icon.png', render(512, { bg: BG, fg: CYAN, withBg: true }));
write('desktop/assets/tray.png', render(32, { bg: BG, fg: CYAN, withBg: false }));
write('desktop/assets/tray@2x.png', render(64, { bg: BG, fg: CYAN, withBg: false }));
// macOS template icons must be black + alpha; the OS recolours them per theme.
write('desktop/assets/trayTemplate.png', render(32, { bg: BG, fg: BLACK, withBg: false }));
write('desktop/assets/trayTemplate@2x.png', render(64, { bg: BG, fg: BLACK, withBg: false }));
console.log('done.');
