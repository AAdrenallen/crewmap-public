// Renders the white place-type glyphs drawn on the coloured place discs (map pins), PNG @3x. Run: node generate.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 66, H = 66, SS = 4;

const house = (cx, cy, s) => (u, v) => {
  const x = (u - cx) / s, y = (v - cy) / s;
  const roof = y < -0.1 && y > -0.95 && Math.abs(x) < (y + 0.95) * 1.05;
  const body = Math.abs(x) < 0.7 && y >= -0.1 && y < 0.85;
  const door = Math.abs(x) < 0.2 && y > 0.3 && y < 0.85;
  return (roof || body) && !door;
};
const heart = (u, v) => {
  const x = u / 0.9, y = -(v + 0.05) / 0.9;
  return (x * x + y * y - 0.55) ** 3 - x * x * y * y * y < 0;
};
const star = (u, v) => {
  const a = Math.atan2(u, -v), r = Math.hypot(u, v), seg = (2 * Math.PI) / 5;
  const t = Math.abs((((a % seg) + seg) % seg) / seg - 0.5) * 2;
  return r < 0.42 + 0.53 * t;
};
const GLYPHS = {
  home: house(0, 0.05, 0.95),
  work: (u, v) => {
    const body = Math.abs(u) < 0.9 && v > -0.4 && v < 0.75;
    const handle = Math.abs(u) < 0.4 && v > -0.75 && v <= -0.4 && !(Math.abs(u) < 0.22 && v > -0.58);
    const seam = Math.abs(v - 0.1) < 0.06 && Math.abs(u) < 0.9;
    return (body && !seam) || handle;
  },
  home2: (u, v) => house(-0.4, 0.25, 0.6)(u, v) || house(0.45, -0.05, 0.6)(u, v),
  school: (u, v) => {
    const cap = Math.abs(u) / 1.0 + Math.abs(v + 0.25) / 0.45 < 1;
    const base = Math.abs(u) < 0.5 && v > 0 && v < 0.5;
    const tassel = Math.abs(u - 0.8) < 0.07 && v > -0.25 && v < 0.55;
    return cap || base || tassel;
  },
  gym: (u, v) => {
    const bar = Math.abs(v) < 0.1 && Math.abs(u) < 0.8;
    const inner = Math.abs(Math.abs(u) - 0.5) < 0.12 && Math.abs(v) < 0.6;
    const outer = Math.abs(Math.abs(u) - 0.78) < 0.1 && Math.abs(v) < 0.38;
    return bar || inner || outer;
  },
  family: (u, v) => {
    const head = (cx, cy, r) => Math.hypot(u - cx, v - cy) < r;
    const body = (cx, top, w) => v > top && v < 0.85 && Math.hypot((u - cx) / w, Math.max(0, top + w - v) / w) < 1;
    return head(-0.35, -0.5, 0.27) || body(-0.35, -0.15, 0.45) || head(0.45, -0.2, 0.2) || body(0.45, 0.1, 0.33);
  },
  friend: (u, v) => house(0, 0.05, 0.95)(u, v) && !heart(u / 0.36, (v - 0.3) / 0.36),
  shop: (u, v) => {
    const bag = v > -0.35 && v < 0.85 && Math.abs(u) < 0.62 + (v + 0.35) * 0.12;
    const r = Math.hypot(u, v + 0.35);
    const handle = v < -0.35 && r > 0.26 && r < 0.4;
    return bag || handle;
  },
  restaurant: (u, v) => {
    const fork = (Math.abs(u + 0.45) < 0.08 && v > -0.2 && v < 0.85) || (v > -0.85 && v < -0.15 && [-0.7, -0.45, -0.2].some((c) => Math.abs(u - c) < 0.06)) || (Math.abs(u + 0.45) < 0.3 && v > -0.3 && v < -0.15);
    const knife = (Math.abs(u - 0.45) < 0.08 && v > -0.1 && v < 0.85) || (u > 0.35 && u < 0.6 && v > -0.85 && v < 0 && (u - 0.35) < (v + 0.85) * 0.4 + 0.08);
    return fork || knife;
  },
  other: star,
};

function render(glyph) {
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = ((x + (sx + 0.5) / SS) / W) * 2 - 1, v = ((y + (sy + 0.5) / SS) / H) * 2 - 1;
      if (glyph(u, v)) a++;
    }
    const i = (y * W + x) * 4;
    px[i] = px[i + 1] = px[i + 2] = 255; px[i + 3] = Math.round((a / (SS * SS)) * 255);
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
for (const [name, glyph] of Object.entries(GLYPHS)) writeFileSync(join(out, `${name}@3x.png`), render(glyph));
