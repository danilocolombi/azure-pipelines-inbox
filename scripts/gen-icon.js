// Generates media/icon.png (128x128) — a Marketplace icon with no external deps.
// Pure Node: rasterizes a few shapes into an RGBA buffer with 4x supersampling,
// then encodes a PNG via zlib. Re-run with `node scripts/gen-icon.js` if the
// look needs tweaking.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 128;
const SS = 4; // supersample factor
const W = SIZE * SS;

// colors
const BG_TOP = [0x0e, 0x63, 0xc4];    // azure blue
const BG_BOT = [0x0a, 0x4d, 0x9e];    // slightly darker for a vertical gradient
const FG = [0xff, 0xff, 0xff];        // white glyph

const buf = new Float32Array(W * W * 4); // straight RGBA, 0..255

function mix(a, b, t) { return a + (b - a) * t; }

// background: rounded square with vertical gradient
const radius = 22 * SS;
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    // rounded-rect coverage
    let cov = roundedRectCoverage(x + 0.5, y + 0.5, 0, 0, W, W, radius);
    if (cov <= 0) continue;
    const t = y / W;
    const r = mix(BG_TOP[0], BG_BOT[0], t);
    const g = mix(BG_TOP[1], BG_BOT[1], t);
    const b = mix(BG_TOP[2], BG_BOT[2], t);
    const i = (y * W + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255 * cov;
  }
}

// glyph: three nodes forming a pipeline branch (A → B, B → C) + connectors.
const s = SS;
const A = [40 * s, 44 * s];
const B = [88 * s, 44 * s];
const C = [88 * s, 88 * s];
const nodeR = 12 * s;
const lineT = 8 * s;

// connectors first (under nodes)
drawThickLine(A, B, lineT);
drawThickLine(B, C, lineT);
// nodes
drawDisc(A, nodeR);
drawDisc(B, nodeR);
drawDisc(C, nodeR);

function plotFg(x, y, cov) {
  if (x < 0 || y < 0 || x >= W || y >= W || cov <= 0) return;
  const i = (y * W + x) * 4;
  const a = Math.min(1, cov);
  buf[i] = mix(buf[i], FG[0], a);
  buf[i + 1] = mix(buf[i + 1], FG[1], a);
  buf[i + 2] = mix(buf[i + 2], FG[2], a);
  buf[i + 3] = Math.max(buf[i + 3], 255 * a);
}

function drawDisc(c, r) {
  const x0 = Math.floor(c[0] - r - 1), x1 = Math.ceil(c[0] + r + 1);
  const y0 = Math.floor(c[1] - r - 1), y1 = Math.ceil(c[1] + r + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - c[0], y + 0.5 - c[1]);
      plotFg(x, y, clamp(r - d + 0.5));
    }
  }
}

function drawThickLine(p, q, thick) {
  const r = thick / 2;
  const x0 = Math.floor(Math.min(p[0], q[0]) - r - 1), x1 = Math.ceil(Math.max(p[0], q[0]) + r + 1);
  const y0 = Math.floor(Math.min(p[1], q[1]) - r - 1), y1 = Math.ceil(Math.max(p[1], q[1]) + r + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = distToSegment(x + 0.5, y + 0.5, p, q);
      plotFg(x, y, clamp(r - d + 0.5));
    }
  }
}

function distToSegment(px, py, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = px - a[0], wy = py - a[1];
  const len2 = vx * vx + vy * vy || 1;
  let t = (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
}

function roundedRectCoverage(px, py, rx, ry, rw, rh, rad) {
  // signed-distance based coverage for a rounded rect
  const cx = px - (rx + rw / 2);
  const cy = py - (ry + rh / 2);
  const qx = Math.abs(cx) - (rw / 2 - rad);
  const qy = Math.abs(cy) - (rh / 2 - rad);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
  return clamp(0.5 - d);
}

function clamp(v) { return Math.max(0, Math.min(1, v)); }

// downsample SS×SS → SIZE
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const i = ((y * SS + dy) * W + (x * SS + dx)) * 4;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
      }
    }
    const n = SS * SS;
    const o = (y * SIZE + x) * 4;
    out[o] = Math.round(r / n);
    out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n);
    out[o + 3] = Math.round(a / n);
  }
}

// encode PNG (truecolor + alpha, no filter)
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const crcTable = (() => {
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
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter type 0
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const dest = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(dest, png);
console.log(`wrote ${dest} (${png.length} bytes)`);
