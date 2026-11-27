import { describe, expect, it } from 'vitest';
import { cumulativeDistances, type LatLng } from '../src/geo';
import {
  CANDIDATES,
  addDriveSample,
  controlDelayS,
  correctionFactor,
  driveSample,
  fillTypical,
  nextViaCache,
  parseMapboxRoute,
  previewRecord,
  recommend,
  selectCandidates,
  timeBucket,
  type DriveSample,
  type NavRoute,
  type RouteCandidate,
  type RouteControls,
} from '../src/navigation';

const LAT0 = 45.6;
const KX = 111.195 * Math.cos((LAT0 * Math.PI) / 180);
const P = (x: number, y: number): LatLng => ({ lat: LAT0 + y / 111.195, lng: -74 + x / KX });

let ids = 0;
function route(corners: [number, number][], durationS: number, controls?: Partial<RouteControls>, typical?: number): NavRoute {
  const geometry = corners.map(([x, y]) => P(x, y));
  const cum = cumulativeDistances(geometry);
  const r: NavRoute = { id: `r${ids++}`, geometry, cum, distanceM: cum[cum.length - 1]!, durationS, steps: [], maxspeedKph: [], congestion: [], incidents: [], summary: '' };
  if (controls) r.controls = { signals: 0, stops: 0, yields: 0, turns: 0, fastRoadM: 0, ...controls };
  if (typical !== undefined) r.typicalDurationS = typical;
  return r;
}
const cand = (r: NavRoute, source: RouteCandidate['source'] = 'base'): RouteCandidate => ({ route: r, source, label: { kind: 'letter', letter: 'A' } });
const north = (s: number, c?: Partial<RouteControls>, typ?: number) => route([[0, 0], [5, 6], [35, 6], [40, 0]], s, c, typ);
const south = (s: number, c?: Partial<RouteControls>, typ?: number) => route([[0, 0], [5, -6], [35, -6], [40, 0]], s, c, typ);
const NOON = new Date(2026, 10, 24, 12, 0).getTime();

describe('recommendation', () => {
  it('adds a control-delay allowance per signal, stop, yield and turn', () => {
    expect(controlDelayS(north(100, { signals: 14, stops: 6, yields: 1, turns: 20 }))).toBe(14 * 12 + 6 * 8 + 2 + 20 * 4);
    expect(controlDelayS(north(100))).toBe(0);
  });

  it('parses signals, stops, yields, turns and motorway length from Mapbox intersections', () => {
    const step = (type: string, modifier: string | undefined, dist: number, ints: object[]) => ({ distance: dist, duration: dist / 20, name: '', geometry: '', maneuver: { type, modifier, location: [-74, 45.6], bearing_after: 0, instruction: '' }, intersections: ints });
    const r = parseMapboxRoute(
      {
        geometry: '_c`|@~bl_D??',
        distance: 3000,
        duration: 150,
        legs: [
          {
            steps: [
              step('depart', undefined, 1000, [{ location: [-74, 45.6], traffic_signal: true }, { location: [-74, 45.6], stop_sign: true }]),
              step('turn', 'left', 1500, [{ location: [-74, 45.6], classes: ['motorway'], yield_sign: true }]),
              step('continue', 'straight', 500, [{ location: [-74, 45.6], traffic_signal: true }]),
              step('arrive', undefined, 0, [{ location: [-74, 45.6] }]),
            ] as never,
          },
        ],
      },
      'x',
    );
    expect(r.controls).toEqual({ signals: 2, stops: 1, yields: 1, turns: 1, fastRoadM: 1500, leftTurns: 1, noRedRightTurns: 0, minorRoadM: 0, tertiaryRoadM: 0, tollM: 0 });
  });

  it('treats near-equal routes as a tie and prefers the predictable one', () => {
    // Back-roads variant 20 s faster live, but 14 signals / 20 turns; motorway variant with 7 signals.
    const back = north(3980, { signals: 14, stops: 6, turns: 20, fastRoadM: 8000 });
    const mw = south(4000, { signals: 7, turns: 10, fastRoadM: 30000 });
    const out = recommend([cand(back), cand(mw)], { learned: [], samples: [], now: NOON });
    expect(out[0]!.route).toBe(mw);
    expect(out[0]!.badge).toBe('recommended');
    expect(out[1]!.badge).toBeNull();
  });

  it('badges "fastest now" only when another route beats the pick by more than the tie band', () => {
    const habit = north(4000, { signals: 2 });
    const fast = south(3500, { signals: 4 });
    const learned = [{ line: habit.geometry, count: 6, lastAt: NOON, score: 6 }];
    const out = recommend([cand(fast), cand(habit)], { learned, samples: [], now: NOON });
    expect(out[0]!.route).toBe(fast); // 500 s is outside the band: habit cannot win
    const close = south(3900, { signals: 4 });
    const out2 = recommend([cand(close), cand(habit)], { learned, samples: [], now: NOON });
    expect(out2[0]!.route).toBe(habit);
    expect(out2.find((c) => c.route === close)!.badge).toBeNull();
    const out3 = recommend([cand(fast), cand(north(3000, { signals: 30, turns: 30 }))], { learned: [], samples: [], now: NOON });
    expect(out3.map((c) => c.badge).sort()).toEqual(['fastestNow', 'recommended']);
  });

  it('flags live time notably above typical', () => {
    const [a] = recommend([cand(north(4000, undefined, 3600))], { learned: [], samples: [], now: NOON });
    expect(a!.overUsualMin).toBe(7);
    const [b] = recommend([cand(north(3700, undefined, 3600))], { learned: [], samples: [], now: NOON });
    expect(b!.overUsualMin).toBe(0);
  });

  it('estimates typical for via routes from the most-overlapping route that has it', () => {
    const f = [{ route: north(4000, undefined, 3600), source: 'base' as const }, { route: north(3000), source: 'split' as const }];
    fillTypical(f);
    expect(f[1]!.route.typicalDurationS).toBeCloseTo(2700, 0);
    expect(f[1]!.route.typicalEstimated).toBe(true);
  });

  it('learns a shrunk per-route correction from real drives, per time-of-week bucket', () => {
    const r = north(3600);
    const b = timeBucket(NOON);
    const s = (ratio: number, bucket = b): DriveSample => ({ line: r.geometry, bucket, predictedS: 3600, actualS: 3600 * ratio, at: NOON });
    expect(correctionFactor(r, [], b)).toEqual({ factor: 1, n: 0 });
    expect(correctionFactor(r, [s(1.2)], b).factor).toBeCloseTo(1.05, 3);
    expect(correctionFactor(r, [s(1.2), s(1.2), s(1.2)], b).factor).toBeCloseTo(1.1, 3);
    expect(correctionFactor(r, [s(1.2, b + 1), s(0.9)], b).factor).toBeCloseTo(1 - 0.1 / 4, 3);
    expect(correctionFactor(south(3600), [s(1.2)], b).n).toBe(0);
    expect(correctionFactor(r, Array.from({ length: 40 }, () => s(3)), b).factor).toBe(CANDIDATES.recommend.maxFactor);
    // A route that is usually slower than predicted loses the recommendation.
    const fast = south(3600);
    const slowSamples = Array.from({ length: 5 }, () => ({ ...s(1.3), line: fast.geometry }));
    const out = recommend([cand(fast), cand(north(3650))], { learned: [], samples: slowSamples, now: NOON });
    expect(out[0]!.route).not.toBe(fast);
  });

  it('records a drive sample when a trip follows a previewed route', () => {
    const a = north(3600, { signals: 10 });
    const b = south(3500);
    const pr = previewRecord([cand(a), cand(b)], P(0, 0), P(40, 0), NOON);
    expect(pr.routes[0]!.predictedS).toBe(3600 + 120);
    const trace = { tripId: 't', endedAt: NOON + 600_000 + 3900_000, distanceM: a.distanceM, line: a.geometry };
    const smp = driveSample(trace, NOON + 600_000, pr)!;
    expect(smp.actualS).toBe(3900);
    expect(smp.predictedS).toBe(3720);
    expect(driveSample(trace, NOON + 3 * 3600_000, pr)).toBeNull();
    expect(driveSample({ ...trace, line: route([[0, 0], [40, 20]], 1).geometry }, NOON, pr)).toBeNull();
    const many = Array.from({ length: 250 }, (_, i) => ({ ...smp, at: i }));
    expect(addDriveSample(many, { ...smp, at: 999 }).length).toBe(CANDIDATES.recommend.maxSamples);
  });
});

describe('candidate stability', () => {
  it('keeps cached routes ahead of new computed ones and caches plausible vias cut by the cap', () => {
    const D = P(40, 0);
    const base = route([[0, 0], [40, 0]], 1600);
    const ys = [3, 6, 9, 12, 15];
    const split = ys.map((y) => ({ route: route([[0, 0], [5, y], [35, y], [40, 0]], 1700), source: 'split' as const }));
    const cached = { route: route([[0, 0], [5, -6], [35, -6], [40, 0]], 1800), source: 'cache' as const };
    const out = selectCandidates([{ route: base, source: 'base' }, ...split, cached], D);
    expect(out.length).toBe(CANDIDATES.maxRoutes);
    expect(out).toContain(cached);
    const v = (lat: number) => ({ lat, lng: -74, bearing: null });
    expect(nextViaCache([], [v(45), v(45.1)], [v(45)], [v(45.1)])).toEqual([v(45), v(45.1)]);
  });
});
