import { describe, expect, it } from 'vitest';
import { filterTrips, groupByDay, indexAtTime, replayAt, scoreBand, simplifyToCount, speedSeries, tripToGpx, NO_FILTER } from '../src/driving/tripView';
import { formatSpeed } from '../src/units';
import type { Trip, TripPoint } from '../src/driving/types';

const pt = (i: number): TripPoint => ({ t: 1000 + i * 1000, lat: 45 + i * 0.0005, lng: -73 + Math.sin(i / 5) * 0.001, speed: 10 + i, heading: null, limitKph: 50 });
const pts = Array.from({ length: 300 }, (_, i) => pt(i));

describe('tripView', () => {
  it('simplifies to at most 40 points keeping ends', () => {
    const s = simplifyToCount(pts);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.length).toBeGreaterThan(2);
    expect(s[0]).toEqual({ lat: pts[0]!.lat, lng: pts[0]!.lng });
    expect(s[s.length - 1]!.lat).toBe(pts[299]!.lat);
    expect(simplifyToCount(pts.slice(0, 5))).toHaveLength(5);
  });
  it('bands scores', () => {
    expect([95, 80, 65, 10, null].map(scoreBand)).toEqual(['great', 'good', 'fair', 'poor', 'none']);
  });
  it('filters by period, role and band', () => {
    const now = 100 * 86_400_000;
    const t = [
      { startedAt: now - 86_400_000, passenger: false, score: 95 },
      { startedAt: now - 20 * 86_400_000, passenger: true, score: null },
      { startedAt: now - 60 * 86_400_000, passenger: false, score: 50 },
    ];
    expect(filterTrips(t, NO_FILTER, now)).toHaveLength(3);
    expect(filterTrips(t, { ...NO_FILTER, period: 'week' }, now)).toHaveLength(1);
    expect(filterTrips(t, { ...NO_FILTER, period: 'month' }, now)).toHaveLength(2);
    expect(filterTrips(t, { ...NO_FILTER, role: 'passenger' }, now)).toHaveLength(1);
    expect(filterTrips(t, { ...NO_FILTER, band: 'poor' }, now)).toHaveLength(1);
  });
  it('groups by local day with totals', () => {
    const d = (day: number, h: number) => new Date(2026, 4, day, h).getTime();
    const g = groupByDay([
      { startedAt: d(3, 18), distanceM: 1000 },
      { startedAt: d(3, 8), distanceM: 2500 },
      { startedAt: d(2, 9), distanceM: 400 },
    ]);
    expect(g.map((x) => [x.key, x.distanceM, x.trips.length])).toEqual([['2026-05-03', 3500, 2], ['2026-05-02', 400, 1]]);
  });
  it('replays with interpolation and clamping', () => {
    const series = speedSeries(pts);
    expect(series[0]!.d).toBe(0);
    expect(series[299]!.d).toBeGreaterThan(series[1]!.d);
    expect(indexAtTime(pts, 0)).toBe(0);
    expect(indexAtTime(pts, 1e12)).toBe(299);
    const r = replayAt(pts, series, pts[10]!.t + 500)!;
    expect(r.index).toBe(10);
    expect(r.lat).toBeGreaterThan(pts[10]!.lat);
    expect(r.lat).toBeLessThan(pts[11]!.lat);
    expect(replayAt([], [], 0)).toBeNull();
  });
  it('writes escaped GPX', () => {
    const trip = { id: 'a', startedAt: 1000, endedAt: 2000, points: pts.slice(0, 2) } as Trip;
    const g = tripToGpx(trip, 'A & <B>');
    expect(g).toContain('A &amp; &lt;B&gt;');
    expect(g.match(/<trkpt /g)).toHaveLength(2);
    expect(g).toContain('<time>1970-01-01T00:00:02.000Z</time>');
  });
  it('formats speed', () => {
    expect(formatSpeed(86.6)).toBe('87 km/h');
    expect(formatSpeed(50, 'ru')).toBe('50 км/ч');
  });
});
