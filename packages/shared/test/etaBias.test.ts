import { describe, expect, it } from 'vitest';
import { cumulativeDistances, type LatLng } from '../src/geo';
import {
  ETA_BIAS,
  crewBiasOf,
  crewPrior,
  driveSample,
  fitClassModel,
  groupOf,
  legTimeS,
  neutralModels,
  parseCrewBias,
  previewRecord,
  recommend,
  routeBias,
  routeParts,
  timeBucket,
  unknownLiveS,
  type BiasObs,
  type Congestion,
  type DriveSample,
  type NavRoute,
  type NavStep,
  type RouteCandidate,
  type TimedTrace,
} from '../src/navigation';

// Invented geometry around a generic origin; no real places.
const LAT0 = 45.6;
const KX = 111.195 * Math.cos((LAT0 * Math.PI) / 180);
const P = (x: number, y: number): LatLng => ({ lat: LAT0 + y / 111.195, lng: -74 + x / KX });
/** Weekday AM peak and weekday noon (local time). */
const PEAK = new Date(2026, 10, 25, 8, 0).getTime();
const NOON = new Date(2026, 10, 25, 12, 0).getTime();
const DAY = 86_400_000;

let ids = 0;
/** One step per segment: [Mapbox Streets class, router seconds, live data known?]. */
function route(corners: [number, number][], segs: [string, number, boolean?][], typical?: number): NavRoute {
  const geometry = corners.map(([x, y]) => P(x, y));
  const cum = cumulativeDistances(geometry);
  const steps: NavStep[] = segs.map(([cls, s], i) => ({
    index: i,
    maneuver: { type: i === 0 ? 'depart' : 'turn', location: geometry[i]!, bearingAfter: 0, instruction: '' },
    name: `Road ${i}`,
    distanceM: cum[i + 1]! - cum[i]!,
    durationS: s,
    startAlongM: cum[i]!,
    endAlongM: cum[i + 1]!,
    banners: [],
    voice: [],
    isRamp: false,
    structures: [],
    roadClass: cls,
  }));
  const lenOf = (want: (c: string) => boolean) => steps.filter((s) => want(s.roadClass!)).reduce((a, s) => a + s.distanceM, 0);
  const r: NavRoute = {
    id: `e${ids++}`,
    geometry,
    cum,
    distanceM: cum[cum.length - 1]!,
    durationS: segs.reduce((a, [, s]) => a + s, 0),
    steps,
    maxspeedKph: [],
    congestion: segs.map(([, , known]) => (known === false ? 'unknown' : 'low') as Congestion),
    segDurationS: segs.map(([, s]) => s),
    incidents: [],
    summary: '',
    controls: {
      signals: 0,
      stops: 0,
      yields: 0,
      turns: 0,
      fastRoadM: lenOf((c) => c === 'motorway'),
      minorRoadM: lenOf((c) => c === 'street'),
      tertiaryRoadM: lenOf((c) => c === 'tertiary'),
    },
  };
  if (typical !== undefined) r.typicalDurationS = typical;
  return r;
}
const cand = (r: NavRoute): RouteCandidate => ({ route: r, source: 'base', label: { kind: 'letter', letter: 'A' } });

/** Motorway corridor (south, live data everywhere) and a regional shortcut (north, collectors mostly without live data). */
const motorway = (s = 2700) =>
  route([[0, 0], [0.6, -0.8], [20, -6], [39.4, -0.8], [40, 0]], [['street', 60], ['motorway', (s - 120) / 2], ['motorway', (s - 120) / 2], ['street', 60]], s);
const shortcut = (s = 2370) =>
  route([[0, 0], [4, 4], [36, 4], [40, 0]], [['tertiary', s * 0.15, false], ['secondary', s * 0.7, true], ['tertiary', s * 0.15, false]], s);

const sample = (r: NavRoute, ratio: number, at: number, withParts = true): DriveSample => {
  const pr = previewRecord([cand(r)], r.geometry[0]!, r.geometry[r.geometry.length - 1]!, at);
  const s: DriveSample = { line: pr.routes[0]!.line, bucket: timeBucket(at), predictedS: pr.routes[0]!.predictedS, actualS: pr.routes[0]!.predictedS * ratio, at };
  if (withParts) s.parts = pr.routes[0]!.parts!;
  return s;
};
const pick = (rs: NavRoute[], input: Partial<Parameters<typeof recommend>[1]> = {}, now = PEAK) =>
  recommend(rs.map(cand), { learned: [], samples: [], now, ...input });

describe('road groups and parts', () => {
  it('maps Mapbox Streets classes to four groups and splits router time by group', () => {
    expect([groupOf('motorway'), groupOf('trunk_link'), groupOf('primary'), groupOf('secondary'), groupOf('tertiary'), groupOf('street'), groupOf(undefined)]).toEqual([0, 0, 1, 1, 2, 3, 1]);
    const parts = routeParts(shortcut(2000));
    expect(parts[1]).toBeCloseTo(1400, 6);
    expect(parts[2]).toBeCloseTo(600, 6);
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(2000, 6);
    expect(unknownLiveS(shortcut(2000))).toBeCloseTo(600, 6);
    expect(unknownLiveS(motorway())).toBe(0);
  });
});

describe('road-group model', () => {
  const obs = (parts: number[], ratio: number, period: 'peak' | 'other' = 'peak', w = 1): BiasObs => ({ parts, actualS: parts.reduce((a, b) => a + b, 0) * ratio, period, w });

  it('stays at the prior without drives and moves toward measured ratios with shrinkage', () => {
    expect(fitClassModel([], 'peak').m).toEqual([1, 1, 1, 1]);
    const few = fitClassModel([obs([0, 1000, 0, 0], 1.3)], 'peak');
    expect(few.m[1]).toBeCloseTo(1 + 0.3 / 5, 3);
    const many = fitClassModel(Array.from({ length: 40 }, () => obs([0, 1000, 0, 0], 1.3)), 'peak');
    expect(many.m[1]).toBeCloseTo(1 + (0.3 * 40) / 44, 3);
    expect(many.m[0]).toBe(1);
    // Other period untouched.
    expect(fitClassModel(Array.from({ length: 10 }, () => obs([0, 1000, 0, 0], 1.3)), 'other').m[1]).toBe(1);
  });

  it('separates groups from mixed drives (motorway on time, collectors slow)', () => {
    const o = [
      ...Array.from({ length: 12 }, () => obs([2000, 0, 0, 0], 1.0)),
      ...Array.from({ length: 12 }, () => obs([600, 0, 1400, 0], 1 + 0.25 * 0.7)),
    ];
    const m = fitClassModel(o, 'peak').m;
    expect(m[0]).toBeCloseTo(1, 1);
    expect(m[2]!).toBeGreaterThan(1.1);
  });

  it('learns spread from residuals and clamps multipliers', () => {
    const noisy = fitClassModel(Array.from({ length: 30 }, (_, i) => obs([0, 0, 0, 1000], i % 2 ? 1.5 : 0.7)), 'peak');
    expect(noisy.s[3]!).toBeGreaterThan(ETA_BIAS.spread0.peak[3]!);
    const steady = fitClassModel(Array.from({ length: 30 }, () => obs([0, 0, 0, 1000], 1.0)), 'peak');
    expect(steady.s[3]!).toBeLessThan(ETA_BIAS.spread0.peak[3]!);
    expect(fitClassModel(Array.from({ length: 100 }, () => obs([1000, 0, 0, 0], 5)), 'peak').m[0]).toBe(ETA_BIAS.maxM);
  });

  it('gives a route its factor, sigma and the no-live-data allowance at peak only', () => {
    const r = shortcut(2000);
    const b = routeBias(r, 2000, neutralModels(), 'peak');
    expect(b.factor).toBeCloseTo(1, 6);
    expect(b.sigmaS).toBeCloseTo(1400 * 0.1 + 600 * 0.13, 6);
    expect(b.unknownS).toBeCloseTo(600 * ETA_BIAS.unknownLive.peak, 6);
    expect(routeBias(r, 2000, neutralModels(), 'other').unknownS).toBe(0);
  });
});

describe('crew multipliers', () => {
  it('round-trips, validates and becomes a bounded prior', () => {
    const models = { ...neutralModels() };
    models.peak = { ...models.peak, m: [1, 1.2, 1.3, 1], n: [10, 10, 1, 0] };
    const cb = crewBiasOf(models);
    expect(parseCrewBias(JSON.parse(JSON.stringify(cb)))).toEqual(cb);
    expect(parseCrewBias({ peak: { m: [1, 1, 1], n: [0, 0, 0] }, other: cb.other })).toBeNull();
    expect(parseCrewBias({ ...cb, peak: { m: [9, 1, 1, 1], n: [0, 0, 0, 0] } })).toBeNull();
    const p = crewPrior([cb], 'peak');
    // Friend's 10 drives → min(8, 10) × 0.5 = 4 pseudo-drives next to the default 4.
    expect(p.m[1]).toBeCloseTo((4 + 4 * 1.2) / 8, 6);
    expect(p.m[2]).toBe(1); // 1 drive is below minCrewN
    const ten = crewPrior(Array.from({ length: 10 }, () => cb), 'peak');
    expect(ten.strength[1]).toBeCloseTo(ETA_BIAS.priorStrength + ETA_BIAS.crewMaxStrength, 6);
    expect(crewPrior([], 'other').m).toEqual([1, 1, 1, 1]);
  });
});

describe('peak recommendation: motorway vs regional shortcut', () => {
  it('without history: a 5.5 min shortcut wins off-peak but not at weekday peak (motorway, shortcut tagged fastest now)', () => {
    const mw = motorway();
    const sc = shortcut();
    expect(pick([mw, sc], {}, NOON)[0]!.route).toBe(sc);
    const out = pick([mw, sc]);
    expect(out[0]!.route).toBe(mw);
    expect(out.find((c) => c.route === sc)!.badge).toBe('fastestNow');
    // ETA shown is unchanged without drives (prior costs are ranking-only).
    expect(out.find((c) => c.route === sc)!.expectedS).toBeCloseTo(sc.durationS, 6);
  });

  it('a clearly faster shortcut still wins at peak without history', () => {
    const mw = motorway();
    const sc = shortcut(2100);
    expect(pick([mw, sc])[0]!.route).toBe(sc);
  });

  it('flips to the motorway once the shortcut is measured slower than predicted', () => {
    const mw = motorway();
    const sc = shortcut(2100);
    const slow = Array.from({ length: 5 }, (_, i) => sample(sc, 1.2, PEAK - (i + 1) * 7 * DAY));
    const onTime = Array.from({ length: 5 }, (_, i) => sample(mw, 1.0, PEAK - (i + 1) * 7 * DAY + 1800_000));
    const out = pick([mw, sc], { samples: [...slow, ...onTime] });
    expect(out[0]!.route).toBe(mw);
    const s = out.find((c) => c.route === sc)!;
    expect(s.expectedS!).toBeGreaterThan(sc.durationS * 1.12);
    expect(s.samples).toBe(5);
  });

  it('stays on the shortcut when the drives show it really saves time', () => {
    const mw = motorway();
    const sc = shortcut();
    const fast = Array.from({ length: 6 }, (_, i) => sample(sc, 0.95, PEAK - (i + 1) * 7 * DAY));
    const mwSlow = Array.from({ length: 4 }, (_, i) => sample(mw, 1.05, PEAK - (i + 1) * 7 * DAY + 1800_000));
    expect(pick([mw, sc], { samples: [...fast, ...mwSlow] })[0]!.route).toBe(sc);
  });

  it('learns from habit drives (no preview) against the router typical time, zero API calls', () => {
    const mw = motorway();
    const sc = shortcut(2100);
    const trace = (r: NavRoute, startedAt: number, s: number, id: string): TimedTrace => ({ tripId: id, startedAt, endedAt: startedAt + s * 1000, distanceM: r.distanceM, line: r.geometry });
    const traces = [
      ...Array.from({ length: 8 }, (_, i) => trace(sc, PEAK - (i + 1) * 7 * DAY, 2100 * 1.25, `s${i}`)),
      ...Array.from({ length: 8 }, (_, i) => trace(mw, PEAK - (i + 1) * 7 * DAY + 600_000, 2700, `m${i}`)),
      // Off-peak drives of the shortcut do not count at peak.
      ...Array.from({ length: 8 }, (_, i) => trace(sc, NOON - (i + 1) * DAY, 2100 * 0.8, `n${i}`)),
    ];
    expect(pick([mw, sc])[0]!.route).toBe(sc);
    const out = pick([mw, sc], { traces });
    expect(out[0]!.route).toBe(mw);
    expect(out.find((c) => c.route === sc)!.samples).toBe(4);
  });

  it('older samples without parts still drive the per-route correction', () => {
    const sc = shortcut(2100);
    const old = Array.from({ length: 6 }, (_, i) => sample(sc, 1.3, PEAK - (i + 1) * 7 * DAY, false));
    const out = pick([sc], { samples: old });
    expect(out[0]!.expectedS!).toBeGreaterThan(sc.durationS * 1.15);
  });
});

describe('drive samples', () => {
  it('records per-group parts and times the previewed origin → destination leg from the fixes', () => {
    const sc = shortcut(2000);
    const from = sc.geometry[0]!;
    const to = sc.geometry[sc.geometry.length - 1]!;
    const pr = previewRecord([cand(sc)], from, to, PEAK);
    expect(pr.routes[0]!.parts!.reduce((a, b) => a + b, 0)).toBeCloseTo(pr.routes[0]!.predictedS, -1);
    // Trip began 5 min earlier 1 km before the origin, and idled 3 min after arriving.
    const pts = [
      { ...P(-1, 0), t: PEAK - 300_000 },
      { ...from, t: PEAK },
      { ...P(20, 4), t: PEAK + 1000_000 },
      { ...to, t: PEAK + 2100_000 },
      { ...P(40.05, 0), t: PEAK + 2280_000 },
    ];
    expect(legTimeS(pts, from, to, 1500)).toBe(2100);
    const trace = { tripId: 'x', endedAt: PEAK + 2280_000, distanceM: sc.distanceM, line: sc.geometry };
    const s = driveSample(trace, PEAK - 300_000, pr, undefined, pts)!;
    expect(s.actualS).toBe(2100);
    expect(s.parts).toHaveLength(4);
    expect(s.tripId).toBe('x');
    expect(driveSample(trace, PEAK - 300_000, pr)!.actualS).toBe(2580);
  });
});
