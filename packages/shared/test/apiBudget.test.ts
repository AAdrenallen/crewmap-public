import { describe, expect, it } from 'vitest';
import { API_BUDGET, ApiBudget, apiKindOf, apiUnitsOf, dayKey } from '../src/apiBudget';
import { TtlCache } from '../src/ttlCache';
import { LimitCache, LIMIT_CACHE, limitKey, parseMatchLimits } from '../src/speedLimits';
import { ROUTE_CACHE, discoveryMode, routeCacheKey } from '../src/navigation';
import type { LatLng } from '../src/geo';

const T0 = new Date(2026, 10, 25, 9, 0).getTime();
const P = (dx: number, dy: number): LatLng => ({ lat: 45.6 + dy / 111_195, lng: -74 + dx / (111_195 * Math.cos((45.6 * Math.PI) / 180)) });

describe('API budget', () => {
  it('counts per local day, degrades past the soft cap and stops past the hard cap', () => {
    const b = new ApiBudget();
    expect(b.level('directions', T0)).toBe('ok');
    b.use('directions', T0, API_BUDGET.softCap.directions);
    expect(b.level('directions', T0)).toBe('lean');
    b.use('directions', T0, API_BUDGET.hardCap.directions);
    expect(b.level('directions', T0)).toBe('off');
    expect(b.level('directions', T0 + 86_400_000)).toBe('ok');
    expect(b.level('routingEngine', T0)).toBe('ok');
    b.save('directions', T0, 7);
    const again = new ApiBudget(JSON.parse(JSON.stringify(b)));
    expect(again.used('directions', T0)).toBe(API_BUDGET.softCap.directions + API_BUDGET.hardCap.directions);
    expect(again.history()[0]).toMatchObject({ day: dayKey(T0), saved: { directions: 7 } });
  });

  it('keeps two weeks of history and ignores junk', () => {
    const b = new ApiBudget([{ nope: 1 }, null, 'x']);
    for (let i = 0; i < 20; i++) b.use('search', T0 + i * 86_400_000);
    expect(b.history()).toHaveLength(API_BUDGET.keepDays);
    expect(b.history()[0]!.day).toBe(dayKey(T0 + 19 * 86_400_000));
  });

  it('classifies Mapbox URLs and bills Matrix by elements', () => {
    expect(apiKindOf('https://api.mapbox.com/directions/v5/mapbox/driving-traffic/1,2;3,4?x=1')).toBe('directions');
    expect(apiKindOf('https://api.mapbox.com/directions-matrix/v1/mapbox/driving-traffic/1,2;3,4;5,6?sources=0')).toBe('matrix');
    expect(apiKindOf('https://api.mapbox.com/matching/v5/mapbox/driving/1,2;3,4')).toBe('mapMatching');
    expect(apiKindOf('https://api.mapbox.com/search/searchbox/v1/forward?q=x')).toBe('search');
    expect(apiKindOf('https://api.mapbox.com/search/geocode/v6/reverse?x')).toBe('geocode');
    expect(apiKindOf('https://relay.example/route/v1/driving/1,2;3,4')).toBeNull();
    expect(apiUnitsOf('https://api.mapbox.com/directions-matrix/v1/mapbox/driving-traffic/1,2;3,4;5,6?sources=0&annotations=duration')).toBe(3);
    expect(apiUnitsOf('https://api.mapbox.com/directions-matrix/v1/mapbox/driving/1,2;3,4;5,6?sources=0&destinations=1;2')).toBe(2);
    expect(apiUnitsOf('https://api.mapbox.com/directions/v5/mapbox/driving-traffic/1,2;3,4')).toBe(1);
  });
});

describe('TTL cache', () => {
  it('expires entries and evicts the least recently used', () => {
    const c = new TtlCache<number>(1000, 2);
    c.set('a', 1, 0);
    c.set('b', 2, 0);
    expect(c.get('a', 500)).toBe(1);
    c.set('c', 3, 600);
    expect(c.get('b', 700)).toBeUndefined(); // evicted (a was read more recently)
    expect(c.get('a', 1001)).toBeUndefined(); // expired: age counts from the fetch, not the last read
    expect(c.get('c', 1500)).toBe(3);
  });
});

describe('route result cache and discovery mode', () => {
  it('keys by quantised origin / destination, avoided classes and language', () => {
    const k = routeCacheKey(P(0, 0), P(20_000, 0), ['toll', 'ferry'], 'fr');
    expect(routeCacheKey(P(1, 1), P(20_001, -1), ['ferry', 'toll'], 'fr')).toBe(k);
    expect(routeCacheKey(P(400, 0), P(20_000, 0), ['ferry', 'toll'], 'fr')).not.toBe(k);
    expect(routeCacheKey(P(0, 0), P(20_000, 0), ['toll'], 'fr')).not.toBe(k);
    expect(routeCacheKey(P(0, 0), P(20_000, 0), ['toll', 'ferry'], 'en')).not.toBe(k);
  });

  it('full the first time, warm within a week, lean for short trips or a spent budget', () => {
    const from = P(0, 0);
    const to = P(20_000, 0);
    expect(discoveryMode({ from, to, lastFullAt: null, now: T0, budget: 'ok' })).toBe('full');
    expect(discoveryMode({ from, to, lastFullAt: T0 - 3600_000, now: T0, budget: 'ok' })).toBe('warm');
    expect(discoveryMode({ from, to, lastFullAt: T0 - ROUTE_CACHE.fullEveryMs - 1, now: T0, budget: 'ok' })).toBe('full');
    expect(discoveryMode({ from, to, lastFullAt: null, now: T0, budget: 'lean' })).toBe('lean');
    expect(discoveryMode({ from, to: P(800, 0), lastFullAt: null, now: T0, budget: 'ok' })).toBe('lean');
  });
});

describe('speed-limit cache', () => {
  it('remembers limits per cell and heading, falls back to direction-less entries, expires', () => {
    const c = new LimitCache();
    c.put(P(0, 0), 90, 70, T0);
    expect(c.get(P(1, 1), 92, T0)).toBe(70);
    expect(c.get(P(1, 1), 270, T0)).toBeNull();
    c.put(P(0, 0), null, 50, T0);
    expect(c.get(P(1, 1), 270, T0)).toBe(50);
    expect(c.get(P(0, 0), 90, T0 + LIMIT_CACHE.ttlMs + 1)).toBeNull();
    c.put(P(500, 0), 0, null, T0);
    c.put(P(500, 0), 0, 0, T0);
    expect(c.size).toBe(2);
    expect(new LimitCache(JSON.parse(JSON.stringify(c))).get(P(0, 0), 90, T0)).toBe(70);
    expect(limitKey(P(0, 0), 359)).toBe(limitKey(P(0, 0), 1));
  });

  it('reads each matched point limit from the leg that ends at it', () => {
    const res = {
      tracepoints: [{ matchings_index: 0, waypoint_index: 0 }, null, { matchings_index: 0, waypoint_index: 1 }, { matchings_index: 0, waypoint_index: 2 }],
      matchings: [
        {
          legs: [
            { annotation: { maxspeed: [{ unknown: true as const }, { speed: 50, unit: 'km/h' }] } },
            { annotation: { maxspeed: [{ speed: 50, unit: 'km/h' }, { speed: 45, unit: 'mph' }, { none: true as const }] } },
          ],
        },
      ],
    };
    expect(parseMatchLimits(res, 4)).toEqual([50, null, 50, 72]);
    expect(parseMatchLimits({}, 2)).toEqual([null, null]);
  });
});
