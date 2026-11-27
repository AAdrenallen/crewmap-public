import { haversineM, projectOnSegment, toLocalXY, type LatLng } from '../geo';
import { PARKING } from './thresholds';

/**
 * What OpenStreetMap says around a parked car (D67): nearby roads, parking areas and buildings with their distance
 * from the spot. Built from one small Overpass `around` query (`parkingQuery`) parsed by `parseParkingContext`.
 */
export interface ParkingContext {
  roads: { highway: string; service: string | null; access: string | null; name: string | null; distM: number }[];
  lots: { inside: boolean; distM: number; access: string | null; name: string | null }[];
  buildings: { building: string; distM: number; inside: boolean }[];
}

/** Overpass QL: roads, parking areas and buildings within `radiusM` of the spot, with geometry. */
export function parkingQuery(p: LatLng, radiusM: number = PARKING.lookupRadiusM): string {
  const a = `around:${Math.round(radiusM)},${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  return `[out:json][timeout:15];(way(${a})[highway];way(${a})[amenity=parking];node(${a})[amenity=parking];way(${a})[building];);out tags geom;`;
}

interface OsmEl {
  type?: unknown;
  lat?: unknown;
  lon?: unknown;
  tags?: Record<string, unknown>;
  geometry?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function geometryOf(el: OsmEl): LatLng[] {
  if (!Array.isArray(el.geometry)) return [];
  const out: LatLng[] = [];
  for (const g of el.geometry as { lat?: unknown; lon?: unknown }[]) {
    if (g && typeof g.lat === 'number' && typeof g.lon === 'number' && Number.isFinite(g.lat) && Number.isFinite(g.lon))
      out.push({ lat: g.lat, lng: g.lon });
  }
  return out;
}

function distToLine(p: LatLng, line: LatLng[]): number {
  if (line.length === 1) return haversineM(p, line[0]!);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, projectOnSegment(p, line[i - 1]!, line[i]!).distanceM);
  return best;
}

/** Ray casting in local metres around `p`. */
function inside(p: LatLng, ring: LatLng[]): boolean {
  if (ring.length < 4) return false;
  const pts = ring.map((q) => toLocalXY(p, q));
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > 0 !== b.y > 0 && 0 < ((b.x - a.x) * (0 - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

const closed = (g: LatLng[]) => g.length >= 4 && g[0]!.lat === g[g.length - 1]!.lat && g[0]!.lng === g[g.length - 1]!.lng;

/** Overpass JSON (`out tags geom`) → distances from `p`. Unknown or malformed elements are skipped. */
export function parseParkingContext(json: unknown, p: LatLng): ParkingContext {
  const ctx: ParkingContext = { roads: [], lots: [], buildings: [] };
  const els = (json as { elements?: unknown })?.elements;
  if (!Array.isArray(els)) return ctx;
  for (const raw of els as OsmEl[]) {
    if (!raw || typeof raw !== 'object') continue;
    const tags = raw.tags ?? {};
    if (raw.type === 'node') {
      if (tags.amenity !== 'parking' || typeof raw.lat !== 'number' || typeof raw.lon !== 'number') continue;
      ctx.lots.push({ inside: false, distM: haversineM(p, { lat: raw.lat, lng: raw.lon }), access: str(tags.access), name: str(tags.name) });
      continue;
    }
    if (raw.type !== 'way') continue;
    const g = geometryOf(raw);
    if (g.length === 0) continue;
    const isIn = closed(g) && inside(p, g);
    const distM = isIn ? 0 : distToLine(p, g);
    const highway = str(tags.highway);
    if (tags.amenity === 'parking') ctx.lots.push({ inside: isIn, distM, access: str(tags.access), name: str(tags.name) });
    else if (highway) ctx.roads.push({ highway, service: str(tags.service), access: str(tags.access), name: str(tags.name), distM });
    else if (str(tags.building)) ctx.buildings.push({ building: str(tags.building)!, distM, inside: isIn });
  }
  ctx.roads.sort((a, b) => a.distM - b.distM);
  ctx.lots.sort((a, b) => a.distM - b.distM);
  ctx.buildings.sort((a, b) => a.distM - b.distM);
  return ctx;
}
