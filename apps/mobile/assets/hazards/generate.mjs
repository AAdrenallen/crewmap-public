// Renders the map hazard pins (Waze-style coloured badge + white glyph) to PNG @3x. Run: node generate.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 96, H = 120, CX = 48, CY = 46, R = 38, BORDER = 5, SS = 4;
const TYPES = {
  police: ['#2F6BFF', star(5, 0.95, 0.42)],
  speedTrap: ['#7B4DFF', gauge],
  camera: ['#7B4DFF', camera],
  accident: ['#E5484D', star(8, 1, 0.55)],
  hazard: ['#F5A524', warning],
  closure: ['#C62828', (u, v) => Math.abs(v) < 0.22 && Math.abs(u) < 0.8],
  construction: ['#FF7A00', cone],
  jam: ['#B4232A', (u, v) => [-0.6, 0, 0.6].some((c) => (u - c) ** 2 + v * v < 0.07)],
  pothole: ['#A0522D', pothole],
};

function star(n, ro, ri) {
  return (u, v) => {
    const a = Math.atan2(u, -v), r = Math.hypot(u, v), seg = (2 * Math.PI) / n;
    const t = Math.abs((((a % seg) + seg) % seg) / seg - 0.5) * 2; // 1 at tips, 0 between
    return r < ri + (ro - ri) * t;
  };
}
function gauge(u, v) {
  const r = Math.hypot(u, v + 0.3);
  const ring = v < 0.3 && r > 0.65 && r < 0.9;
  const needle = v + 0.3 <= 0.05 && Math.abs(u * 0.7 + (v + 0.3) * 0.7) < 0.09 && r < 0.7 && u > -0.1;
  return ring || needle || r < 0.16;
}
function camera(u, v) {
  const body = Math.abs(u) < 0.85 && v > -0.45 && v < 0.6;
  const top = Math.abs(u + 0.25) < 0.3 && v > -0.65 && v <= -0.45;
  const lens = Math.hypot(u, v - 0.08) < 0.32;
  return (body || top) && !lens || Math.hypot(u, v - 0.08) < 0.16;
}
function warning(u, v) {
  const tri = v < 0.75 && v > -0.85 && Math.abs(u) < (v + 0.85) * 0.62;
  const bar = Math.abs(u) < 0.09 && v > -0.35 && v < 0.3;
  const dot = Math.hypot(u, v - 0.5) < 0.1;
  return tri && !bar && !dot;
}
function cone(u, v) {
  const body = v < 0.6 && v > -0.85 && Math.abs(u) < 0.12 + (v + 0.85) * 0.38;
  const base = v >= 0.6 && v < 0.82 && Math.abs(u) < 0.85;
  const stripe = (v > -0.3 && v < -0.1) || (v > 0.18 && v < 0.38);
  return (body && !stripe) || base;
}
function pothole(u, v) {
  const e = (u / 0.85) ** 2 + ((v - 0.15) / 0.5) ** 2;
  const crack = Math.abs(u - 0.15 * Math.sin(v * 9)) < 0.07 && v < -0.2 && v > -0.85;
  return (e < 1 && e > 0.45) || e < 0.12 || crack;
}

function hex(c) { return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); }
function inPin(x, y, grow) {
  if (Math.hypot(x - CX, y - CY) < R + grow) return true;
  const tipY = CY + R + 22 + grow, dy = tipY - y; // tail
  return y > CY && dy > 0 && Math.abs(x - CX) < dy * 0.55;
}

function render(colorHex, glyph) {
  const col = hex(colorHex), px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
      let c = null, al = 0;
      if (inPin(fx, fy, 0)) {
        const inner = Math.hypot(fx - CX, fy - CY) < R - BORDER || (fy > CY + R - BORDER && inPin(fx, fy, -BORDER));
        const u = (fx - CX) / (R * 0.58), v = (fy - CY) / (R * 0.58);
        c = inner && !glyph(u, v) ? col : [255, 255, 255];
        if (inner && Math.hypot(fx - CX, fy - CY) >= R - BORDER) c = col;
        al = 1;
      } else if (inPin(fx - 1, fy - 3, 2)) { c = [0, 0, 0]; al = 0.22; } // soft drop shadow
      if (c) { r += c[0] * al; g += c[1] * al; b += c[2] * al; a += al; }
    }
    const n = SS * SS, i = (y * W + x) * 4;
    px[i] = a ? r / a : 0; px[i + 1] = a ? g / a : 0; px[i + 2] = a ? b / a : 0; px[i + 3] = Math.round((a / n) * 255);
  }
  return png(px);
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(px) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const out = dirname(fileURLToPath(import.meta.url));
for (const [name, [color, glyph]] of Object.entries(TYPES)) writeFileSync(join(out, `${name}@3x.png`), render(color, glyph));
