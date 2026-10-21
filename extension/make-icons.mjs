import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'icons');
const BG = [17, 24, 39, 255];
const FG = [255, 255, 255, 255];

function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc >>> 0;
}

function u32(n) {
  return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

function chunk(type, data) {
  const t = new TextEncoder().encode(type);
  const payload = new Uint8Array(t.length + data.length);
  payload.set(t, 0);
  payload.set(data, t.length);
  const out = new Uint8Array(4 + payload.length + 4);
  out.set(u32(data.length), 0);
  out.set(payload, 4);
  out.set(u32(crc32(payload)), 4 + payload.length);
  return out;
}

function writePng(path, width, height, rgba) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { png.set(p, o); o += p.length; }
  writeFileSync(path, png);
}

function roundedCoverage(px, py, size, radius) {
  const min = radius;
  const max = size - 1 - radius;
  const dx = px < min ? min - px : px > max ? px - max : 0;
  const dy = py < min ? min - py : py > max ? py - max : 0;
  const dist = Math.hypot(dx, dy);
  const aa = 0.65;
  if (dist <= radius - aa) return 1;
  if (dist >= radius + aa) return 0;
  return (radius + aa - dist) / (2 * aa);
}

const GLYPH_M = [
  '10001',
  '11011',
  '10101',
  '10001',
  '10001',
  '10001',
  '10001',
];
const GLYPH_D = [
  '11110',
  '10001',
  '10001',
  '10001',
  '10001',
  '10001',
  '11110',
];

function blit(rgba, size, glyph, ox, oy, scale) {
  for (let gy = 0; gy < glyph.length; gy++) {
    for (let gx = 0; gx < glyph[gy].length; gx++) {
      if (glyph[gy][gx] !== '1') continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const x = ox + gx * scale + sx;
          const y = oy + gy * scale + sy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const i = (y * size + x) * 4;
          rgba[i] = FG[0]; rgba[i + 1] = FG[1]; rgba[i + 2] = FG[2]; rgba[i + 3] = FG[3];
        }
      }
    }
  }
}

function draw(size) {
  const rgba = new Uint8Array(size * size * 4);
  const pad = Math.max(1, Math.round(size * 0.06));
  const inner = size - pad * 2;
  const radius = Math.max(2, Math.round(inner * 0.22));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cov = roundedCoverage(x - pad + 0.5, y - pad + 0.5, inner, radius);
      if (cov <= 0) continue;
      const i = (y * size + x) * 4;
      rgba[i] = BG[0]; rgba[i + 1] = BG[1]; rgba[i + 2] = BG[2]; rgba[i + 3] = Math.round(BG[3] * cov);
    }
  }
  const scale = Math.max(1, Math.floor(size / 16));
  const gw = 5 * scale;
  const gh = 7 * scale;
  const gap = Math.max(1, scale);
  const total = gw * 2 + gap;
  const ox = Math.floor((size - total) / 2);
  const oy = Math.floor((size - gh) / 2);
  blit(rgba, size, GLYPH_M, ox, oy, scale);
  blit(rgba, size, GLYPH_D, ox + gw + gap, oy, scale);
  return rgba;
}

mkdirSync(DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writePng(join(DIR, `${size}.png`), size, size, draw(size));
}
