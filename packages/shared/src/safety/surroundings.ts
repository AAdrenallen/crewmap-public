import type { LatLng } from '../geo';
import type { Surroundings } from './checkIn';
import { CHECK_IN } from './thresholds';

/**
 * One small Overpass `around` query per candidate stop (D66), counts only (`out count`, a few hundred bytes): buildings;
 * homes (residential landuse, residential streets, driveways); rest stops (rest / service areas, parking, fuel,
 * food, toilets, shops, tourism, signals and stop signs). Runs at most once per stop that lasted 90 s somewhere
 * unknown, so a crew makes a handful a month: far below the volunteer-service limits D61 follows.
 */
export function surroundingsQuery(p: LatLng, radiusM: number = CHECK_IN.surroundingsM): string {
  const a = `around:${Math.round(radiusM)},${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  return (
    `[out:json][timeout:15];` +
    `nwr(${a})[building];out count;` +
    `(nwr(${a})[landuse=residential];way(${a})[highway=residential];way(${a})[highway=service][service=driveway];);out count;` +
    `(nwr(${a})[highway~"^(rest_area|services|traffic_signals|stop)$"];` +
    `nwr(${a})[amenity~"^(parking|parking_space|fuel|charging_station|restaurant|fast_food|cafe|toilets|bar|pub|shelter)$"];` +
    `nwr(${a})[shop];nwr(${a})[tourism];);out count;`
  );
}

/** The three `out count` results, in query order. Null when the response is not that shape. */
export function parseSurroundings(json: unknown): Surroundings | null {
  const els = (json as { elements?: unknown })?.elements;
  if (!Array.isArray(els)) return null;
  const totals = els
    .filter((e): e is { type: string; tags: Record<string, unknown> } => !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'count')
    .map((e) => Number(e.tags?.total));
  if (totals.length !== 3 || totals.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return { buildings: totals[0]!, residential: totals[1]! > 0, restStop: totals[2]! > 0 };
}
