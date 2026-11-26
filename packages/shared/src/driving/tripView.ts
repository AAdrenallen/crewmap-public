import { simplifyPolyline } from '../navigation/candidates';
import type { LatLng } from '../geo';
import type { Trip, TripPoint } from './types';

/** Pure helpers behind the drives list and the trip detail screen (thumbnails, filters, grouping, replay, GPX). */

export const THUMB_POINTS = 40;

/** Douglas-Peucker down to at most `n` points (tolerance found by bisection). */
export function simplifyToCount(points: LatLng[], n: number = THUMB_POINTS): LatLng[] {
  const pts = points.map((p) => ({ lat: p.lat, lng: p.lng }));
  if (pts.length <= n) return pts;
  let lo = 0;
  let hi = 50_000;
  let best = simplifyPolyline(pts, hi);
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const s = simplifyPolyline(pts, mid);
    if (s.length <= n) {
      best = s;
      hi = mid;
    } else lo = mid;
  }
  return best;
}

export type ScoreBand = 'great' | 'good' | 'fair' | 'poor' | 'none';
export function scoreBand(score: number | null): ScoreBand {
  if (score === null) return 'none';
  if (score >= 90) return 'great';
  if (score >= 75) return 'good';
  if (score >= 60) return 'fair';
  return 'poor';
}

export type TripPeriod = 'week' | 'month' | 'all';
export type TripRole = 'all' | 'driver' | 'passenger';
export interface TripFilter {
  period: TripPeriod;
  role: TripRole;
  /** null = every band. */
  band: ScoreBand | null;
}
export const NO_FILTER: TripFilter = { period: 'all', role: 'all', band: null };

interface Filterable {
  startedAt: number;
  passenger: boolean;
  score: number | null;
}

/** `week` = last 7 days, `month` = last 30 days (rolling, relative to `now`). */
export function filterTrips<T extends Filterable>(trips: T[], f: TripFilter, now: number): T[] {
  const from = f.period === 'week' ? now - 7 * 86_400_000 : f.period === 'month' ? now - 30 * 86_400_000 : 0;
  return trips.filter(
    (x) =>
      x.startedAt >= from &&
      (f.role === 'all' || (f.role === 'passenger') === x.passenger) &&
      (f.band === null || scoreBand(x.score) === f.band),
  );
}

export interface DayGroup<T> {
  /** Local-date key YYYY-MM-DD. */
  key: string;
  /** Local midnight of that day. */
  t: number;
  distanceM: number;
  trips: T[];
}

/** Groups (already newest-first) trips by local calendar day, preserving order. */
export function groupByDay<T extends { startedAt: number; distanceM: number }>(trips: T[]): DayGroup<T>[] {
  const out: DayGroup<T>[] = [];
  for (const x of trips) {
    const d = new Date(x.startedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let g = out[out.length - 1];
    if (!g || g.key !== key) {
      g = { key, t: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), distanceM: 0, trips: [] };
      out.push(g);
    }
    g.distanceM += x.distanceM;
    g.trips.push(x);
  }
  return out;
}

export interface SpeedSample {
  /** Metres from the start. */
  d: number;
  kph: number;
  limitKph: number | null;
  t: number;
}

function hav(a: LatLng, b: LatLng): number {
  const R = 6_371_008.8;
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function speedSeries(points: TripPoint[]): SpeedSample[] {
  let d = 0;
  return points.map((p, i) => {
    if (i > 0) d += hav(points[i - 1]!, p);
    return { d, kph: Math.round(p.speed * 3.6), limitKph: p.limitKph, t: p.t };
  });
}

/** Index of the last point with t <= time (binary search); clamps to the ends. */
export function indexAtTime(points: { t: number }[], time: number): number {
  if (points.length === 0 || time <= points[0]!.t) return 0;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid]!.t <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface ReplayState {
  lat: number;
  lng: number;
  kph: number;
  limitKph: number | null;
  /** Index of the segment start. */
  index: number;
  d: number;
}

/** Position, speed and distance at `time`, interpolated between fixes. */
export function replayAt(points: TripPoint[], series: SpeedSample[], time: number): ReplayState | null {
  if (points.length === 0) return null;
  const i = indexAtTime(points, time);
  const a = points[i]!;
  const b = points[i + 1];
  if (!b || b.t <= a.t) return { lat: a.lat, lng: a.lng, kph: series[i]!.kph, limitKph: a.limitKph, index: i, d: series[i]!.d };
  const f = Math.max(0, Math.min(1, (time - a.t) / (b.t - a.t)));
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lng: a.lng + (b.lng - a.lng) * f,
    kph: Math.round(series[i]!.kph + (series[i + 1]!.kph - series[i]!.kph) * f),
    limitKph: a.limitKph,
    index: i,
    d: series[i]!.d + (series[i + 1]!.d - series[i]!.d) * f,
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GPX 1.1 track of the trip (UTC timestamps, speed in m/s as an extension). */
export function tripToGpx(trip: Trip, name: string): string {
  const pts = trip.points
    .map(
      (p) =>
        `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"><time>${new Date(p.t).toISOString()}</time><extensions><speed>${p.speed.toFixed(2)}</speed></extensions></trkpt>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="CrewMap" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${esc(name)}</name><time>${new Date(trip.startedAt).toISOString()}</time></metadata><trk><name>${esc(name)}</name><trkseg>${pts}</trkseg></trk></gpx>`;
}
