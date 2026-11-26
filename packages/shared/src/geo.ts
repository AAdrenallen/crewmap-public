export interface LatLng {
  lat: number;
  lng: number;
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing a→b in degrees [0, 360). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const φ1 = a.lat * RAD;
  const φ2 = b.lat * RAD;
  const Δλ = (b.lng - a.lng) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDeg(Math.atan2(y, x) / RAD);
}

export function normalizeDeg(d: number): number {
  return ((d % 360) + 360) % 360;
}

/** Smallest signed difference b − a in degrees, in (−180, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  let d = normalizeDeg(b) - normalizeDeg(a);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function destination(from: LatLng, bearing: number, distanceM: number): LatLng {
  const δ = distanceM / EARTH_RADIUS_M;
  const θ = bearing * RAD;
  const φ1 = from.lat * RAD;
  const λ1 = from.lng * RAD;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: φ2 / RAD, lng: ((λ2 / RAD + 540) % 360) - 180 };
}

/** Local equirectangular projection around `origin`, metres. Accurate to <0.1% for spans < 50 km. */
export function toLocalXY(origin: LatLng, p: LatLng): { x: number; y: number } {
  const x = (p.lng - origin.lng) * RAD * EARTH_RADIUS_M * Math.cos(origin.lat * RAD);
  const y = (p.lat - origin.lat) * RAD * EARTH_RADIUS_M;
  return { x, y };
}

export interface SegmentProjection {
  /** Closest point on the segment. */
  point: LatLng;
  /** 0..1 along the segment. */
  t: number;
  distanceM: number;
}

export function projectOnSegment(p: LatLng, a: LatLng, b: LatLng): SegmentProjection {
  const bx = toLocalXY(a, b);
  const px = toLocalXY(a, p);
  const len2 = bx.x * bx.x + bx.y * bx.y;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px.x * bx.x + px.y * bx.y) / len2));
  const point = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  return { point, t, distanceM: haversineM(p, point) };
}

export interface PolylineProjection {
  point: LatLng;
  segmentIndex: number;
  t: number;
  distanceM: number;
  /** Distance from the polyline start to the projected point. */
  alongM: number;
}

/** Cumulative distances: cum[i] = distance from line[0] to line[i]. */
export function cumulativeDistances(line: LatLng[]): number[] {
  const cum = new Array<number>(line.length);
  let acc = 0;
  for (let i = 0; i < line.length; i++) {
    if (i > 0) acc += haversineM(line[i - 1]!, line[i]!);
    cum[i] = acc;
  }
  return cum;
}

/**
 * Project p onto the polyline. `fromIndex`/`toIndex` restrict the search window (used by route progress to
 * avoid snapping to a parallel part of the route further ahead).
 */
export function projectOnPolyline(
  p: LatLng,
  line: LatLng[],
  cum: number[] = cumulativeDistances(line),
  fromIndex = 0,
  toIndex = line.length - 1,
): PolylineProjection {
  if (line.length === 0) throw new Error('empty polyline');
  if (line.length === 1) {
    return { point: line[0]!, segmentIndex: 0, t: 0, distanceM: haversineM(p, line[0]!), alongM: 0 };
  }
  const lo = Math.max(0, Math.min(fromIndex, line.length - 2));
  const hi = Math.max(lo + 1, Math.min(toIndex, line.length - 1));
  let best: PolylineProjection | undefined;
  for (let i = lo; i < hi; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const pr = projectOnSegment(p, a, b);
    if (!best || pr.distanceM < best.distanceM) {
      const segLen = cum[i + 1]! - cum[i]!;
      best = { point: pr.point, segmentIndex: i, t: pr.t, distanceM: pr.distanceM, alongM: cum[i]! + segLen * pr.t };
    }
  }
  return best!;
}

/** Point at a given distance along the polyline. */
export function pointAlong(line: LatLng[], cum: number[], alongM: number): LatLng {
  if (line.length === 0) throw new Error('empty polyline');
  if (alongM <= 0) return line[0]!;
  const total = cum[cum.length - 1]!;
  if (alongM >= total) return line[line.length - 1]!;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= alongM) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi]! - cum[lo]!;
  const t = seg === 0 ? 0 : (alongM - cum[lo]!) / seg;
  const a = line[lo]!;
  const b = line[hi]!;
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** Sub-polyline between two along-distances. */
export function slicePolyline(line: LatLng[], cum: number[], startM: number, endM: number): LatLng[] {
  const out: LatLng[] = [pointAlong(line, cum, startM)];
  // Binary-search the first vertex past startM: called per fix on long routes, so no full scan.
  let lo = 0;
  let hi = cum.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! > startM) hi = mid;
    else lo = mid + 1;
  }
  for (let i = lo; i < line.length && cum[i]! < endM; i++) out.push(line[i]!);
  out.push(pointAlong(line, cum, endM));
  return out;
}

/** Spatial index over a polyline: consecutive segment runs with their bboxes padded by `padM`. */
export interface PolylineChunks {
  padM: number;
  chunks: { lo: number; hi: number; box: BBox }[];
}

/** Segments per chunk: small enough to prune most of a long route, large enough to keep the index tiny. */
const CHUNK_SEGMENTS = 32;

export function polylineChunks(line: LatLng[], padM: number): PolylineChunks {
  const chunks: PolylineChunks['chunks'] = [];
  for (let lo = 0; lo < line.length - 1; lo += CHUNK_SEGMENTS) {
    const hi = Math.min(line.length - 1, lo + CHUNK_SEGMENTS);
    // +50 m margin: the bbox is in degrees, distances are geodesic.
    chunks.push({ lo, hi, box: bboxOf(line.slice(lo, hi + 1), padM + 50) });
  }
  return { padM, chunks };
}

/**
 * Same result as `projectOnPolyline` whenever the nearest point is within `idx.padM` (null otherwise), but only
 * projects onto the chunks whose padded bbox contains `p`.
 */
export function projectNearPolyline(p: LatLng, line: LatLng[], cum: number[], idx: PolylineChunks): PolylineProjection | null {
  let best: PolylineProjection | null = null;
  for (const c of idx.chunks) {
    if (!bboxContains(c.box, p)) continue;
    const pr = projectOnPolyline(p, line, cum, c.lo, c.hi);
    if (!best || pr.distanceM < best.distanceM) best = pr;
  }
  return best && best.distanceM <= idx.padM ? best : null;
}

export function bboxOf(points: LatLng[], padM = 0): BBox {
  if (points.length === 0) throw new Error('bboxOf: no points');
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const p of points) {
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
  }
  if (padM > 0) {
    const dLat = padM / (EARTH_RADIUS_M * RAD);
    const dLng = padM / (EARTH_RADIUS_M * RAD * Math.cos(((south + north) / 2) * RAD));
    south -= dLat;
    north += dLat;
    west -= dLng;
    east += dLng;
  }
  return { south, west, north, east };
}

export function bboxContains(b: BBox, p: LatLng): boolean {
  return p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a.west <= b.east && b.west <= a.east && a.south <= b.north && b.south <= a.north;
}

/** Decode a Google/Mapbox encoded polyline (precision 5 or 6). */
export function decodePolyline(str: string, precision = 6): LatLng[] {
  const factor = 10 ** precision;
  const out: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < str.length) {
    for (const which of [0, 1] as const) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    out.push({ lat: lat / factor, lng: lng / factor });
  }
  return out;
}

export function encodePolyline(points: LatLng[], precision = 6): string {
  const factor = 10 ** precision;
  let out = '';
  let pLat = 0;
  let pLng = 0;
  const enc = (v: number) => {
    let s = v < 0 ? ~(v << 1) : v << 1;
    let r = '';
    while (s >= 0x20) {
      r += String.fromCharCode((0x20 | (s & 0x1f)) + 63);
      s >>= 5;
    }
    return r + String.fromCharCode(s + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * factor);
    const lng = Math.round(p.lng * factor);
    out += enc(lat - pLat) + enc(lng - pLng);
    pLat = lat;
    pLng = lng;
  }
  return out;
}

/** Round a coordinate to a grid of `cellM` metres — used for "approximate" sharing. */
export function coarsen(p: LatLng, cellM: number): LatLng {
  const dLat = cellM / (EARTH_RADIUS_M * RAD);
  const lat = Math.floor(p.lat / dLat) * dLat + dLat / 2;
  // Size longitude cells from the cell's centre latitude so every point in a latitude band shares one grid.
  const dLng = cellM / (EARTH_RADIUS_M * RAD * Math.cos(lat * RAD));
  return { lat, lng: Math.floor(p.lng / dLng) * dLng + dLng / 2 };
}

/** Drops search hits that repeat an earlier one (same accent/case-insensitive name within `radiusM`). Keeps order. */
export function dedupeNearby<T extends LatLng & { name: string }>(items: T[], radiusM = 150): T[] {
  const key = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const out: T[] = [];
  for (const it of items) {
    if (!out.some((o) => key(o.name) === key(it.name) && haversineM(o, it) <= radiusM)) out.push(it);
  }
  return out;
}
