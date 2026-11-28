import { describe, expect, it } from 'vitest';
import { cumulativeDistances, type LatLng } from '../src/geo';
import {
  REEVAL,
  currentRouteQuery,
  decideFaster,
  directionsUrl,
  dismiss,
  emptyMemory,
  isBusy,
  jamAhead,
  matchCurrent,
  monthlyDirectionsEstimate,
  parseMapboxRoute,
  remainingLine,
  remainingS,
  shouldCheck,
  type NavRoute,
} from '../src/navigation';

const LAT0 = 45.6;
const KX = 111.195 * Math.cos((LAT0 * Math.PI) / 180);
const P = (x: number, y: number): LatLng => ({ lat: LAT0 + y / 111.195, lng: -74 + x / KX });
let ids = 0;
function route(corners: [number, number][], durationS: number, over: Partial<NavRoute> = {}): NavRoute {
  const geometry = corners.map(([x, y]) => P(x, y));
  const cum = cumulativeDistances(geometry);
  return { id: `r${ids++}`, geometry, cum, distanceM: cum[cum.length - 1]!, durationS, steps: [], maxspeedKph: [], congestion: [], incidents: [], summary: '', ...over };
}
const NOW = new Date(2026, 10, 24, 17, 0).getTime();
const input = { learned: [], samples: [], now: NOW };
const north = (s: number) => route([[0, 0], [5, 6], [35, 6], [40, 0]], s);
const south = (s: number) => route([[0, 0], [5, -6], [35, -6], [40, 0]], s);

describe('continuous re-evaluation (D43)', () => {
  it('requests congestion_numeric + speed and parses per-segment annotations', () => {
    const url = directionsUrl({ coordinates: [P(0, 0), P(1, 0)] }, 'pk.x');
    expect(decodeURIComponent(url)).toContain('annotations=maxspeed,congestion,congestion_numeric,distance,duration,speed');
    const r = parseMapboxRoute(
      { geometry: '_c`|@_c`|@_ibE_ibE', distance: 100, duration: 20, legs: [{ steps: [], annotation: { congestion: ['heavy'], congestion_numeric: [80], duration: [20], speed: [5] } }] },
      'x',
    );
    expect(r.congestionNumeric).toEqual([80]);
    expect(r.segDurationS).toEqual([20]);
    expect(r.segSpeedKph).toEqual([18]);
  });

  it('detects a jam and a closure ahead, not behind', () => {
    const r = route([[0, 0], [1, 0], [2, 0], [3, 0]], 300, { congestion: ['low', 'heavy', 'low'], congestionNumeric: [10, 85, null] });
    expect(jamAhead(r, 0).jamM).toBeGreaterThan(900);
    expect(isBusy(jamAhead(r, 0))).toBe(true);
    expect(jamAhead(r, 2100).jamM).toBe(0);
    const c = route([[0, 0], [3, 0]], 300, { incidents: [{ id: 'i', type: 'accident', description: '', closed: true, startAlongM: 2000, endAlongM: 2100, location: P(2, 0) }] });
    expect(jamAhead(c, 0).incident).toBe(true);
    expect(jamAhead(c, 2500).incident).toBe(false);
  });

  it('remaining time uses per-segment durations', () => {
    const r = route([[0, 0], [1, 0], [2, 0]], 300, { segDurationS: [100, 200] });
    expect(remainingS(r, 0)).toBeCloseTo(300);
    expect(remainingS(r, r.cum[1]!)).toBeCloseTo(200);
    expect(remainingLine(r, r.cum[1]! / 2)[0]!.lng).toBeCloseTo(P(0.5, 0).lng, 5);
  });

  it('schedules adaptively and caps checks', () => {
    const c = { startedAt: NOW, lastCheckAt: null, checks: 0, busy: false };
    const far = { s: 1800, m: 30_000 };
    expect(shouldCheck(c, NOW + 60_000, 'timer', far)).toBe(false); // start delay
    expect(shouldCheck(c, NOW + REEVAL.startDelayMs, 'timer', far)).toBe(true);
    const after = { ...c, lastCheckAt: NOW + 3 * 60_000, checks: 1 };
    expect(shouldCheck(after, NOW + 6 * 60_000, 'timer', far)).toBe(false); // calm: 5 min
    expect(shouldCheck({ ...after, busy: true }, NOW + 5 * 60_000, 'timer', far)).toBe(true); // busy: 2 min
    expect(shouldCheck(after, NOW + 3 * 60_000 + 60_000, 'incident', far)).toBe(false); // floor
    expect(shouldCheck(after, NOW + 3 * 60_000 + REEVAL.minGapMs, 'incident', far)).toBe(true);
    expect(shouldCheck(after, NOW + 30 * 60_000, 'timer', { s: 200, m: 30_000 })).toBe(false); // nearly there
    expect(shouldCheck({ ...after, checks: REEVAL.maxPerTrip }, NOW + 60 * 60_000, 'timer', far)).toBe(false);
  });

  it('matches the driven route among fresh ones, and prices it with silent vias otherwise', () => {
    const cur = north(1800);
    expect(matchCurrent([south(1500), north(1700)], cur.geometry)).not.toBeNull();
    expect(matchCurrent([south(1500)], cur.geometry)).toBeNull();
    const q = currentRouteQuery(cur.geometry, 90, ['toll'])!;
    expect(q.coordinates.length).toBe(2 + REEVAL.vias);
    expect(q.exclude).toEqual(['toll']);
    expect(q.bearings[0]).toEqual({ deg: 90, range: 45 });
  });

  it('offers only a clear, stable gain; strong gains at once; dismissed alternatives stay quiet', () => {
    // 1 min on 30: under max(2 min, 8 %).
    expect(decideFaster(north(1800), [south(1740)], input, emptyMemory()).offer).toBeNull();
    // 2.8 min on 30 (> 2.4 min threshold, < 1.35×): needs to hold for two checks.
    const first = decideFaster(north(1800), [south(1630)], input, emptyMemory());
    expect(first.offer).toBeNull();
    expect(first.memory.pending).not.toBeNull();
    const second = decideFaster(north(1800), [south(1630)], input, first.memory);
    expect(second.offer!.savesS).toBe(170);
    // 10 min: offered right away, with auto-dismiss.
    const strong = decideFaster(north(1800), [south(1200)], input, emptyMemory()).offer!;
    expect(strong.expiresAt - strong.createdAt).toBe(REEVAL.offerTtlMs);
    const mem = dismiss(emptyMemory(), strong, NOW);
    expect(decideFaster(north(1800), [south(1200)], input, mem).offer).toBeNull();
    expect(decideFaster(north(1800), [south(1200)], { ...input, now: NOW + REEVAL.dismissSuppressMs + 1 }, mem).offer).not.toBeNull();
    // Never onto a closed road.
    const closed = south(1200);
    closed.incidents = [{ id: 'c', type: 'road_closure', description: '', closed: true, startAlongM: 100, endAlongM: 200, location: P(5, -6) }];
    expect(decideFaster(north(1800), [closed], input, emptyMemory()).offer).toBeNull();
  });

  it('offers a way around a closure ahead but announces only the real time saved', () => {
    const cur = north(1800);
    cur.incidents = [{ id: 'c', type: 'road_closure', description: '', closed: true, startAlongM: 5000, endAlongM: 5200, location: P(5, 6) }];
    const alt = south(1790);
    const { offer } = decideFaster(cur, [alt], input, emptyMemory());
    expect(offer?.route).toBe(alt);
    expect(offer!.savesS).toBe(10);
    expect(offer!.currentS).toBe(1800);
    expect(offer!.altS).toBe(1790);
  });

  it('stays inside the Mapbox Directions free tier for a small group', () => {
    const perDriver = monthlyDirectionsEstimate(1.5, 3.5, 0.5, 2, 1);
    expect(perDriver).toBeLessThan(3000);
    expect(Math.floor(100_000 / perDriver)).toBeGreaterThanOrEqual(30);
  });
});
