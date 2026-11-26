import { describe, expect, it } from 'vitest';
import { cumulativeDistances, type LatLng } from '../src/geo';
import type { NavRoute } from '../src/navigation/route';
import { externalNavUrl, googleMapsUrl, shapingWaypoints, wazeUrl } from '../src/navigation/externalNav';

const route = (id: string, geometry: LatLng[]): NavRoute => {
  const cum = cumulativeDistances(geometry);
  return {
    id,
    geometry,
    cum,
    distanceM: cum[cum.length - 1] ?? 0,
    durationS: 600,
    steps: [],
    maxspeedKph: [],
    congestion: [],
    incidents: [],
    summary: id,
  };
};

const dest = { lat: 45.5, lng: -73.6 };
// ~1.1 km per 0.01° latitude.
const straight = route('a', [{ lat: 45.4, lng: -73.6 }, dest]);
const detour = route('b', [{ lat: 45.4, lng: -73.6 }, { lat: 45.42, lng: -73.6 }, { lat: 45.43, lng: -73.56 }, { lat: 45.47, lng: -73.56 }, { lat: 45.48, lng: -73.6 }, dest]);

describe('external nav URLs', () => {
  it('builds a Waze navigate link without waypoints', () => {
    expect(wazeUrl(dest)).toBe('https://waze.com/ul?ll=45.500000,-73.600000&navigate=yes');
    expect(externalNavUrl('waze', dest, [{ lat: 1, lng: 2 }])).toBe(wazeUrl(dest));
  });

  it('uses google.navigation when there are no vias', () => {
    expect(googleMapsUrl(dest)).toBe('google.navigation:q=45.500000,-73.600000&mode=d');
  });

  it('uses the directions URL with at most 3 waypoints', () => {
    const vias = [1, 2, 3, 4].map((i) => ({ lat: 45 + i / 100, lng: -73 }));
    const u = new URL(googleMapsUrl(dest, vias));
    expect(u.origin + u.pathname).toBe('https://www.google.com/maps/dir/');
    expect(u.searchParams.get('api')).toBe('1');
    expect(u.searchParams.get('destination')).toBe('45.500000,-73.600000');
    expect(u.searchParams.get('waypoints')!.split('|')).toHaveLength(3);
    expect(u.searchParams.get('travelmode')).toBe('driving');
    expect(u.searchParams.get('dir_action')).toBe('navigate');
  });
});

describe('shapingWaypoints', () => {
  it('returns nothing without alternatives', () => {
    expect(shapingWaypoints(detour, [])).toEqual([]);
    expect(shapingWaypoints(detour, [detour])).toEqual([]);
  });

  it('pins the detour where it leaves the straight route', () => {
    const vias = shapingWaypoints(detour, [straight]);
    expect(vias).toHaveLength(1);
    expect(vias[0]!.lng).toBeGreaterThan(-73.59);
    expect(vias[0]!.lat).toBeGreaterThan(45.42);
    expect(vias[0]!.lat).toBeLessThan(45.48);
  });

  it('returns nothing when routes overlap', () => {
    expect(shapingWaypoints(straight, [route('c', straight.geometry)])).toEqual([]);
  });

  it('caps at 3 points in driving order', () => {
    const zig: LatLng[] = [];
    for (let i = 0; i <= 10; i++) zig.push({ lat: 45.4 + i * 0.01, lng: i % 2 ? -73.56 : -73.6 });
    const vias = shapingWaypoints(route('z', zig), [straight]);
    expect(vias.length).toBe(3);
    for (let i = 1; i < vias.length; i++) expect(vias[i]!.lat).toBeGreaterThan(vias[i - 1]!.lat);
  });
});
