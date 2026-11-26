#!/usr/bin/env node
/**
 * Personal-information guard. Blocks commits, pushes and public publishes that contain the owner's private terms
 * (names, addresses, device serials, local paths) or any coordinate near the owner's private places, including
 * coordinates hidden in encoded route polylines inside JSON fixtures.
 *
 * The lists live in `.secrets/` (git-ignored, never published):
 *   .secrets/private-terms.txt   one term per line (case/accent-insensitive)
 *   .secrets/private-places.txt  lat,lng,radius_m per line
 * Without them (CI, other machines) the check warns and passes: the lists are private by design.
 *
 * Usage: node tools/privacy/check.mjs [--staged | --tree <dir>]   (default: all git-tracked files)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const SECRETS = path.join(ROOT, '.secrets');
const BINARY = /\.(png|jpe?g|gif|webp|glb|gltf|wav|mp3|ogg|ttf|otf|woff2?|ico|apk|aab|jar|keystore|jks|zip|gz|pdf)$/i;

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘`]/g, "'").toLowerCase();

function readList(file) {
  const p = path.join(SECRETS, file);
  if (!fs.existsSync(p)) return null;
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

const terms = (readList('private-terms.txt') ?? []).map(norm);
const places = (readList('private-places.txt') ?? []).map((l) => {
  const [lat, lng, r] = l.split(',').map(Number);
  return { lat, lng, r: r || 400 };
});
if (terms.length === 0 && places.length === 0) {
  console.warn('privacy check: no .secrets lists on this machine; skipped');
  process.exit(0);
}

function distM(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const nearPrivate = (lat, lng) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && places.some((p) => distM(p, { lat, lng }) <= p.r);

function decodePolyline(str, precision) {
  const f = 10 ** precision;
  const out = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b;
      do {
        if (i >= str.length) return out;
        b = str.charCodeAt(i++) - 63;
        if (b < 0 || b > 63) return [];
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d;
      else lng += d;
    }
    out.push({ lat: lat / f, lng: lng / f });
  }
  return out;
}

const NUM_PAIR = /(-?\d{1,3}\.\d{3,})["'\s]*[,;\s]\s*["']?(-?\d{1,3}\.\d{3,})/g;
const POLY_FIELD = /"(?:geometry|polyline|poly|overview_polyline|points)"\s*:\s*"((?:[^"\\]|\\.){12,})"/g;

function scanText(name, text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const n = norm(line);
    for (const t of terms) if (n.includes(t)) findings.push(`${name}:${i + 1}: private term`);
    for (const m of line.matchAll(NUM_PAIR)) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (nearPrivate(a, b) || nearPrivate(b, a)) findings.push(`${name}:${i + 1}: coordinate near a private place`);
    }
  });
  if (places.length) {
    for (const m of text.matchAll(POLY_FIELD)) {
      const s = m[1].replace(/\\\\/g, '\\');
      // Only where a route starts or ends identifies someone; driving past on a public street does not.
      for (const prec of [6, 5]) {
        const pts = decodePolyline(s, prec);
        const ends = pts.length ? [pts[0], pts[pts.length - 1]] : [];
        if (ends.some((p) => nearPrivate(p.lat, p.lng))) {
          findings.push(`${name}: encoded polyline starts or ends near a private place`);
          break;
        }
      }
    }
  }
  return [...new Set(findings)];
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

const mode = process.argv[2];
let files = [];
if (mode === '--staged') {
  files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n').filter(Boolean).map((f) => ({ name: f, read: () => git(['show', `:${f}`]) }));
} else if (mode === '--tree') {
  const dir = path.resolve(process.argv[3] ?? '.');
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      if (e.name === '.git' || e.name === 'node_modules') return [];
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : [{ name: path.relative(dir, p), read: () => fs.readFileSync(p, 'utf8') }];
    });
  files = walk(dir);
} else {
  files = git(['ls-files']).split('\n').filter(Boolean).map((f) => ({ name: f, read: () => fs.readFileSync(path.join(ROOT, f), 'utf8') }));
}

const all = [];
for (const f of files) {
  if (BINARY.test(f.name)) continue;
  if (f.name.replace(/\\/g, '/').startsWith('.secrets/')) {
    all.push(`${f.name}: private list must never be committed`);
    continue;
  }
  let text;
  try {
    text = f.read();
  } catch {
    continue;
  }
  if (text.length > 20 * 1024 * 1024) continue;
  all.push(...scanText(f.name, text));
}

if (all.length) {
  console.error(`privacy check FAILED (${all.length}):\n  ${all.join('\n  ')}`);
  process.exit(1);
}
console.log(`privacy check: clean (${files.length} files)`);
