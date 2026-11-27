import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cumulativeDistances, type LatLng } from '@crewmap/shared/geo';
import {
  alertIntervals,
  ecccCategory,
  EcccAlertSource,
  ecccUrl,
  inRings,
  isRoadConditionHazard,
  normaliseEccc,
  normaliseQc,
  ROAD_WEATHER,
  RoadWeatherAnnouncer,
  roadWeatherOnRoute,
  type Hazard,
  type HttpGet,
  type WeatherAlert,
} from '../src';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
/** Recording time of eccc-alerts.json (2026-11-27 02:00 UTC). */
const NOW = Date.UTC(2026, 10, 27, 2, 0);

const route = (pts: LatLng[]) => {
  const cum = cumulativeDistances(pts);
  return { geometry: pts, cum, distanceM: cum[cum.length - 1]! };
};
/** Straight line split into ~100 m steps so sampling and projection behave like a real route. */
const line = (a: LatLng, b: LatLng, n = 400) => route(Array.from({ length: n + 1 }, (_, i) => ({ lat: a.lat + ((b.lat - a.lat) * i) / n, lng: a.lng + ((b.lng - a.lng) * i) / n })));

const square = (s: number, w: number, n: number, e: number): WeatherAlert => ({
  key: 'eccc:FRW:t',
  category: 'freezing',
  nameEn: 'Freezing rain',
  nameFr: 'Pluie verglaçante',
  polygons: [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]],
  bbox: { south: s, west: w, north: n, east: e },
  issuedAt: NOW - 3600_000,
  expiresAt: NOW + 3600_000,
});

describe('ECCC alerts', () => {
  it('keeps active road-relevant alerts, groups regions by alert, drops ended and non-road ones', () => {
    const alerts = normaliseEccc(fx('eccc-alerts.json'), NOW)!;
    const codes = alerts.map((a) => a.key.split(':')[1]).sort();
    expect(codes).toEqual(['FRW', 'FRW', 'SPS']); // two FRW alerts, the icy SPS; ended SPS and storm surge out
    const sps = alerts.find((a) => a.key.includes(':SPS:'))!;
    expect(sps.category).toBe('slippery');
    expect(alerts.filter((a) => a.category === 'freezing')).toHaveLength(2);
    for (const a of alerts) expect(a.bbox.north).toBeGreaterThan(a.bbox.south);
  });

  it('drops everything once expired and rejects other shapes', () => {
    expect(normaliseEccc(fx('eccc-alerts.json'), NOW + 2 * 86_400_000)).toEqual([]);
    expect(normaliseEccc({ features: 'x' }, NOW)).toBeNull();
  });

  it('classifies by name; statements only when the text mentions the roads; watches never', () => {
    expect(ecccCategory('snowfall warning', 'warning', null)).toBe('snow');
    expect(ecccCategory('fog advisory', 'advisory', null)).toBe('fog');
    expect(ecccCategory('winter storm watch', 'watch', null)).toBeNull();
    expect(ecccCategory('special weather statement', 'statement', 'Roads may be icy.')).toBe('slippery');
    expect(ecccCategory('special weather statement', 'statement', 'Heat.')).toBeNull();
  });

  it('builds a bbox query and refreshes at most every refreshMs for a covered area', async () => {
    expect(ecccUrl({ south: 45, west: -74, north: 46, east: -73 })).toContain('bbox=-74.000,45.000,-73.000,46.000');
    let calls = 0;
    const http: HttpGet = async () => {
      calls++;
      return { status: 200, json: async () => fx('eccc-alerts.json'), text: async () => '' };
    };
    const src = new EcccAlertSource(http);
    const area = { south: 45, west: -78, north: 49, east: -70 };
    expect(await src.refresh(area, NOW)).toBe(true);
    expect(await src.refresh(area, NOW + 5 * 60_000)).toBe(false);
    expect(calls).toBe(1);
    expect(src.alerts(NOW).length).toBe(3);
    expect(src.health().status).toBe('ok');
    const bad = new EcccAlertSource(async () => ({ status: 503, json: async () => ({}), text: async () => '' }));
    await bad.refresh(area, NOW);
    expect(bad.health().status).toBe('degraded');
  });
});

describe('road weather on the route', () => {
  it('point in polygon honours holes', () => {
    const rings: [number, number][][] = [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
    ];
    expect(inRings({ lat: 2, lng: 2 }, rings)).toBe(true);
    expect(inRings({ lat: 5, lng: 5 }, rings)).toBe(false);
    expect(inRings({ lat: 11, lng: 5 }, rings)).toBe(false);
  });

  it('finds where the route enters and leaves an alert polygon', () => {
    const r = line({ lat: 45.5, lng: -74 }, { lat: 45.5, lng: -73 }); // ~78 km west → east
    const iv = alertIntervals(r, square(45.4, -73.6, 45.6, -73.4));
    expect(iv).toHaveLength(1);
    const [s, e] = iv[0]!;
    expect(s).toBeGreaterThan(30_000);
    expect(s).toBeLessThan(32_000);
    expect(e - s).toBeGreaterThan(15_000);
    expect(e - s).toBeLessThan(16_500);
  });

  it('uses MTMD winter-condition segments on the route and merges nearby zones of one kind', () => {
    const r = line({ lat: 45.5, lng: -74 }, { lat: 45.5, lng: -73 });
    const cond = (id: string, w: number, e: number, subtype = 'PG'): Hazard => ({
      id: `quebec:cond:${id}`, source: 'quebec', type: 'hazard', subtype, lat: 45.5, lng: w, heading: null, street: 'A-40',
      reportedAt: NOW - 60_000, expiresAt: NOW + 3600_000, reliability: 10, confirmations: 0, line: [[w, 45.5], [e, 45.5]], description: 'Partiellement glacée',
    });
    const zones = roadWeatherOnRoute(r, [], [cond('1', -73.9, -73.85), cond('2', -73.84, -73.8), cond('3', -73.2, -73.1, 'R'), { ...cond('far', -73.5, -73.4), line: [[-73.5, 46], [-73.4, 46]] }], NOW);
    expect(zones.map((z) => z.category)).toEqual(['slippery', 'fog']);
    expect(zones[0]!.source).toBe('quebec');
    expect(zones[0]!.endM - zones[0]!.startM).toBeGreaterThan(7000);
    expect(isRoadConditionHazard({ id: 'm', memberIds: ['quebec:cond:1'] })).toBe(true);
    expect(isRoadConditionHazard({ id: 'quebec:radar:1' })).toBe(false);
  });

  it('ignores stale MTMD conditions and expired alerts', () => {
    const r = line({ lat: 45.5, lng: -74 }, { lat: 45.5, lng: -73 });
    const old = normaliseQc('ms:conditions_routieres', { type: 'Feature', properties: { NumeroSegment: 1, CodeEtatChaussee: 'PG', CodeVisibilite: 'B', EnVigueurDepuis: '2026-11-25T00:00:00' }, geometry: { type: 'LineString', coordinates: [[-73.9, 45.5], [-73.8, 45.5]] } }, NOW);
    expect(old).not.toBeNull();
    expect(roadWeatherOnRoute(r, [{ ...square(45.4, -73.6, 45.6, -73.4), expiresAt: NOW - 1 }], [old!], NOW)).toEqual([]);
  });

  it('announces each zone once, when within announceAheadM or already inside', () => {
    const r = line({ lat: 45.5, lng: -74 }, { lat: 45.5, lng: -73 });
    const zones = roadWeatherOnRoute(r, [square(45.4, -73.6, 45.6, -73.4)], [], NOW);
    const ann = new RoadWeatherAnnouncer();
    expect(ann.update(zones, 0)).toBeNull();
    const a = ann.update(zones, zones[0]!.startM - ROAD_WEATHER.announceAheadM + 100)!;
    expect(a.zone.category).toBe('freezing');
    expect(a.distanceM).toBeGreaterThan(4800);
    expect(ann.update(zones, zones[0]!.startM - 1000)).toBeNull();
    const inside = new RoadWeatherAnnouncer().update(zones, zones[0]!.startM + 2000)!;
    expect(inside.distanceM).toBe(0);
  });
});
