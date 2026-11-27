import type { LatLng } from '../geo';

/** Share card size (px): a 4:5 portrait that social apps show uncropped. */
export const CARD = { w: 1080, h: 1350, mapTop: 300, mapH: 640, pad: 80 } as const;

/**
 * Projects lines into a box (equirectangular scaled by cos(latitude): exact enough at outing scale), centred, aspect
 * kept, as SVG path strings. Lines with fewer than two points are skipped.
 */
export function projectLines(lines: readonly LatLng[][], box: { x: number; y: number; w: number; h: number }): string[] {
  const all = lines.flat();
  if (all.length < 2) return [];
  const lat0 = (all.reduce((n, p) => n + p.lat, 0) / all.length) * (Math.PI / 180);
  const k = Math.cos(lat0);
  const xs = all.map((p) => p.lng * k);
  const ys = all.map((p) => -p.lat);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(1e-9, Math.max(...xs) - minX);
  const spanY = Math.max(1e-9, Math.max(...ys) - minY);
  const s = Math.min(box.w / spanX, box.h / spanY);
  const ox = box.x + (box.w - spanX * s) / 2;
  const oy = box.y + (box.h - spanY * s) / 2;
  const f = (v: number) => (Math.round(v * 10) / 10).toString();
  return lines
    .filter((l) => l.length >= 2)
    .map((l) => l.map((p, i) => `${i ? 'L' : 'M'}${f(ox + (p.lng * k - minX) * s)} ${f(oy + (-p.lat - minY) * s)}`).join(''));
}
