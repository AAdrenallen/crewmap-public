import type { Activity } from './driving';
import { haversineM, type LatLng } from './geo';

export type AgoUnit = 'now' | 'min' | 'h' | 'd';

/** Splits an age into a unit and a count so the UI can pick the localized string. */
export function agoParts(t: number, now: number): { unit: AgoUnit; n: number } {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return { unit: 'now', n: 0 };
  if (s < 3600) return { unit: 'min', n: Math.round(s / 60) };
  if (s < 86_400) return { unit: 'h', n: Math.round(s / 3600) };
  return { unit: 'd', n: Math.round(s / 86_400) };
}

export type PresenceKind = 'driving' | 'walking' | 'moving' | 'still';

/** Moving threshold (m/s) when the activity is unknown. */
export const MOVING_MPS = 1.5;

export function presenceKind(act: Activity, spd: number | null): PresenceKind {
  if (act === 'automotive') return 'driving';
  if (act === 'walking') return 'walking';
  if (act === 'running' || act === 'cycling') return 'moving';
  if (act === 'still') return 'still';
  return spd !== null && spd >= MOVING_MPS ? 'moving' : 'still';
}

/** The closest place whose radius contains the position, or null. */
export function nearestPlaceWithin<P extends LatLng & { radiusM: number }>(
  pos: LatLng,
  places: readonly P[],
): P | null {
  let best: P | null = null;
  let bestD = Infinity;
  for (const p of places) {
    const d = haversineM(pos, p);
    if (d <= p.radiusM && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** Cache key for reverse geocoding: ~1 km cells so a friend wandering nearby does not re-query. */
export function cityCacheKey(p: LatLng): string {
  return `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
}

export interface FriendEvent {
  placeId: string;
  placeName: string;
  kind: 'arrive' | 'leave' | 'drivingHome';
  t: number;
}

/** Local midnight (device time zone) of the day containing `now`. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Today's events, oldest first, capped to the latest `max`. */
export function todayTimeline(events: readonly FriendEvent[], now: number, max = 8): FriendEvent[] {
  const from = startOfDay(now);
  return events
    .filter((e) => e.t >= from && e.t <= now + 60_000)
    .sort((a, b) => a.t - b.t)
    .slice(-max);
}

/** Appends and keeps the newest `max` entries by time; duplicates (same key) are ignored. */
export function appendLog<T extends { t: number }>(
  log: readonly T[],
  item: T,
  max: number,
  same: (a: T, b: T) => boolean = () => false,
): T[] {
  if (log.some((x) => same(x, item))) return [...log];
  return [...log, item].sort((a, b) => a.t - b.t).slice(-max);
}

/** "1:23" for a remaining duration. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const DRIVE_EST = {
  /** Straight line → road distance. */
  roadFactor: 1.35,
  /** Mean door-to-door driving speed for the fallback estimate. */
  avgMps: 40 / 3.6,
} as const;

/** Drive time to a friend: the routed value when known, else a straight-line estimate flagged `approx`. */
export function driveTime(
  routedS: number | null,
  straightM: number | null,
): { s: number; approx: boolean } | null {
  if (routedS !== null && Number.isFinite(routedS)) return { s: routedS, approx: false };
  if (straightM === null || !Number.isFinite(straightM)) return null;
  return { s: Math.round((straightM * DRIVE_EST.roadFactor) / DRIVE_EST.avgMps), approx: true };
}

/** The closest other position within `maxM` of `pos` (e.g. "with Sam, 120 m"), or null. */
export function nearestWithin<T extends LatLng & { id: string }>(
  pos: LatLng & { id: string },
  others: readonly T[],
  maxM: number,
): { other: T; distanceM: number } | null {
  let best: { other: T; distanceM: number } | null = null;
  for (const o of others) {
    if (o.id === pos.id) continue;
    const d = haversineM(pos, o);
    if (d <= maxM && (!best || d < best.distanceM)) best = { other: o, distanceM: Math.round(d) };
  }
  return best;
}
