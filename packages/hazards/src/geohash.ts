import type { LatLng } from '@crewmap/shared/geo';

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohashEncode(p: LatLng, precision: number): string {
  const lat: [number, number] = [-90, 90];
  const lng: [number, number] = [-180, 180];
  let out = '';
  let bit = 0;
  let ch = 0;
  let even = true;
  while (out.length < precision) {
    const r = even ? lng : lat;
    const v = even ? p.lng : p.lat;
    const mid = (r[0] + r[1]) / 2;
    ch <<= 1;
    if (v >= mid) {
      ch |= 1;
      r[0] = mid;
    } else r[1] = mid;
    even = !even;
    if (++bit === 5) {
      out += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return out;
}

export interface GeohashCell {
  center: LatLng;
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Cell bounds and centre; null for an invalid geohash. */
export function geohashDecode(hash: string): GeohashCell | null {
  if (hash.length === 0 || hash.length > 12) return null;
  const lat: [number, number] = [-90, 90];
  const lng: [number, number] = [-180, 180];
  let even = true;
  for (const c of hash) {
    const v = BASE32.indexOf(c);
    if (v < 0) return null;
    for (let b = 4; b >= 0; b--) {
      const r = even ? lng : lat;
      const mid = (r[0] + r[1]) / 2;
      if ((v >> b) & 1) r[0] = mid;
      else r[1] = mid;
      even = !even;
    }
  }
  return { center: { lat: (lat[0] + lat[1]) / 2, lng: (lng[0] + lng[1]) / 2 }, south: lat[0], west: lng[0], north: lat[1], east: lng[1] };
}

/** Distinct cells of `precision` covering a polyline (sampled every ~half cell), in route order. */
export function geohashesAlong(line: LatLng[], precision: number, stepDeg = precision <= 4 ? 0.08 : 0.01): string[] {
  const out: string[] = [];
  const add = (p: LatLng) => {
    const h = geohashEncode(p, precision);
    if (!out.includes(h)) out.push(h);
  };
  for (let i = 0; i < line.length; i++) {
    const a = line[i]!;
    add(a);
    const b = line[i + 1];
    if (!b) break;
    const n = Math.ceil(Math.max(Math.abs(b.lat - a.lat), Math.abs(b.lng - a.lng)) / stepDeg);
    for (let k = 1; k < n; k++) add({ lat: a.lat + ((b.lat - a.lat) * k) / n, lng: a.lng + ((b.lng - a.lng) * k) / n });
  }
  return out;
}
