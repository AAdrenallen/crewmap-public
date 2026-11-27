import { z } from 'zod';
import type { BBox } from '@crewmap/shared/geo';
import { HealthTracker } from '../health';
import { OSM_OVERPASS_ENDPOINTS, OverpassCells, type CellRecord } from '../sources/overpass';
import type { HttpGet } from '../types';
import type { FuelGrade, Poi } from './types';

/**
 * OpenStreetMap fuel stations and EV chargers (ODbL 1.0) through the same Overpass cell cache as the cameras (D61):
 * one combined query per 0.5° cell, refreshed at most every 30 days, chore peer only. In Québec the Régie feed has the
 * prices; OSM fills in station locations elsewhere and all chargers. OSM `fuel:*` price tags are not used: they are
 * rare, unstandardised and undated.
 */
export const OSM_POI_REFRESH_MS = 30 * 86_400_000;
export const OSM_POI_MAX_AGE_MS = 120 * 86_400_000;

export function osmPoiQuery(b: BBox): string {
  const box = `${b.south},${b.west},${b.north},${b.east}`;
  return `[out:json][timeout:25];nwr["amenity"~"^(fuel|charging_station)$"](${box});out center tags;`;
}

const El = z.object({
  type: z.enum(['node', 'way', 'relation']),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

const yes = (v: string | undefined) => v === 'yes';

/** Grades a station sells per OSM tags (fuel:octane_87 / 91 / diesel ...). */
export function osmGrades(tags: Record<string, string>): FuelGrade[] {
  const g: FuelGrade[] = [];
  if (yes(tags['fuel:octane_87']) || yes(tags['fuel:octane_95']) || yes(tags['fuel:e10'])) g.push('regular');
  if (yes(tags['fuel:octane_91']) || yes(tags['fuel:octane_93']) || yes(tags['fuel:octane_98'])) g.push('premium');
  if (yes(tags['fuel:diesel'])) g.push('diesel');
  return g;
}

/** Largest "50 kW" / "7.2 kW" in socket:*:output tags. */
export function osmMaxKw(tags: Record<string, string>): number | undefined {
  let best: number | undefined;
  for (const [k, v] of Object.entries(tags)) {
    if (!/^socket:[^:]+:output$/.test(k)) continue;
    const m = /(\d+(?:\.\d+)?)\s*kW/i.exec(v);
    if (m) best = Math.max(best ?? 0, Number(m[1]));
  }
  return best;
}

export function normaliseOsmPois(elements: unknown[], bbox: BBox, now: number): Poi[] {
  const out: Poi[] = [];
  for (const raw of elements) {
    const e = El.safeParse(raw);
    if (!e.success) continue;
    const lat = e.data.lat ?? e.data.center?.lat;
    const lng = e.data.lon ?? e.data.center?.lon;
    const tags = e.data.tags ?? {};
    if (lat === undefined || lng === undefined) continue;
    if (lat < bbox.south || lat > bbox.north || lng < bbox.west || lng > bbox.east) continue;
    if (tags.access === 'private' || tags.access === 'no') continue;
    const kind = tags.amenity === 'fuel' ? 'fuel' : tags.amenity === 'charging_station' ? 'charging' : null;
    if (!kind) continue;
    const brand = (tags.brand ?? tags.operator)?.trim();
    const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
    const address = [street, tags['addr:city']].filter(Boolean).join(', ');
    const grades = kind === 'fuel' ? osmGrades(tags) : [];
    const cap = Number(tags.capacity);
    const maxKw = kind === 'charging' ? osmMaxKw(tags) : undefined;
    out.push({
      id: `osm-poi:${e.data.type[0]}${e.data.id}`,
      kind,
      source: 'osm-poi',
      lat,
      lng,
      name: tags.name?.trim() || null,
      ...(brand ? { brand } : {}),
      ...(address ? { address } : {}),
      ...(grades.length ? { grades } : {}),
      ...(kind === 'charging' && Number.isFinite(cap) && cap > 0 ? { sockets: cap } : {}),
      ...(maxKw !== undefined ? { maxKw } : {}),
      at: now,
    });
  }
  return out;
}

export class OsmPoiSource {
  readonly id = 'osm-poi' as const;
  readonly tracker = new HealthTracker('osm-poi');
  private readonly cells: OverpassCells<Poi>;

  constructor(http: HttpGet, onRequest?: () => void, endpoints: readonly string[] = OSM_OVERPASS_ENDPOINTS) {
    this.cells = new OverpassCells<Poi>(
      http,
      this.tracker,
      { query: osmPoiQuery, normalise: normaliseOsmPois, refreshMs: OSM_POI_REFRESH_MS, maxAgeMs: OSM_POI_MAX_AGE_MS, ...(onRequest ? { onRequest } : {}) },
      endpoints,
    );
  }

  health() {
    return this.tracker.get();
  }

  snapshot(): Record<string, CellRecord<Poi>> {
    return this.cells.snapshot();
  }

  restore(s: Record<string, CellRecord<Poi>> | null, now: number): void {
    this.cells.restore(s, now);
  }

  refresh(b: BBox, now: number): Promise<boolean> {
    return this.cells.refresh(b, now);
  }

  within(b: BBox, now: number): Poi[] {
    return this.cells.cached(b, now).map(({ item, at }) => ({ ...item, at }));
  }
}
