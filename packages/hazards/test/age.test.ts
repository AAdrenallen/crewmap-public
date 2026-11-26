import { describe, expect, it } from 'vitest';
import { hazardAge, routeHazardRows, type MergedHazard } from '../src';

const NOW = 1781547600000;
const hz = (id: string, lat: number, lng: number, ago: number): MergedHazard => ({
  id, source: 'friends', type: 'pothole', subtype: null, lat, lng, heading: null, street: null, reportedAt: NOW - ago, expiresAt: NOW + 3600_000,
  reliability: 6, confirmations: 0, sources: ['friends'], memberIds: [id], latestReportAt: NOW - ago, reporters: [], confidence: 0.8, level: 'high', fade: 1, mix: [{ source: 'friends', n: 1 }], independent: 1,
});

describe('hazardAge', () => {
  it('buckets by unit', () => {
    expect(hazardAge(hz('a', 0, 0, 20_000), NOW)).toEqual({ unit: 'now', n: 0 });
    expect(hazardAge(hz('a', 0, 0, 5 * 60_000), NOW)).toEqual({ unit: 'min', n: 5 });
    expect(hazardAge(hz('a', 0, 0, 3 * 3600_000), NOW)).toEqual({ unit: 'h', n: 3 });
    expect(hazardAge(hz('a', 0, 0, 2 * 86_400_000), NOW)).toEqual({ unit: 'd', n: 2 });
  });
});

describe('routeHazardRows', () => {
  const geometry = [{ lat: 45.5, lng: -73.6 }, { lat: 45.5, lng: -73.59 }, { lat: 45.5, lng: -73.58 }];
  it('keeps hazards on the corridor, sorted along the route', () => {
    const rows = routeHazardRows(geometry, [hz('far', 45.51, -73.59, 0), hz('b', 45.5, -73.585, 60_000), hz('a', 45.5, -73.595, 0)], NOW);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[1]!.age).toEqual({ unit: 'min', n: 1 });
    expect(rows[0]!.alongM).toBeLessThan(rows[1]!.alongM);
  });
  it('is empty for an empty route', () => {
    expect(routeHazardRows([], [hz('a', 45.5, -73.6, 0)], NOW)).toEqual([]);
  });
});
