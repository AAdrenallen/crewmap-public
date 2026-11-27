import { decodePolyline, haversineM, type LatLng } from '../geo';

export interface WalkRoute {
  line: LatLng[];
  distanceM: number;
  durationS: number;
}

/** Mapbox Directions `walking` (one route, overview geometry only: the map draws it, no turn-by-turn). */
export function walkingUrl(from: LatLng, to: LatLng, accessToken: string, language: 'en' | 'fr' | 'ru' = 'en'): string {
  const coords = `${from.lng.toFixed(6)},${from.lat.toFixed(6)};${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
  const p = new URLSearchParams({ access_token: accessToken, alternatives: 'false', geometries: 'polyline6', overview: 'full', steps: 'false', language });
  return `https://api.mapbox.com/directions/v5/mapbox/walking/${coords}?${p.toString()}`;
}

/** First route of a Directions response, or null. */
export function parseWalk(json: unknown): WalkRoute | null {
  const r = (json as { code?: unknown; routes?: { geometry?: unknown; distance?: unknown; duration?: unknown }[] } | null) ?? null;
  const first = r?.code === 'Ok' ? r.routes?.[0] : undefined;
  if (!first || typeof first.geometry !== 'string' || typeof first.distance !== 'number' || typeof first.duration !== 'number') return null;
  const line = decodePolyline(first.geometry, 6);
  return line.length >= 2 ? { line, distanceM: first.distance, durationS: first.duration } : null;
}

/** Offline / no token: a straight line at walking pace (1.3 m/s), so "Walk there" still points the way. */
export function straightWalk(from: LatLng, to: LatLng): WalkRoute {
  const d = haversineM(from, to);
  return { line: [from, to], distanceM: d, durationS: d / 1.3 };
}
