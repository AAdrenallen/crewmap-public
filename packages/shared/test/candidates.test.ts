import { describe, expect, it } from 'vitest';
import { cumulativeDistances, haversineM, type LatLng } from '../src/geo';
import {
  CANDIDATES,
  DISCOVERY,
  Footprint,
  directionsUrl,
  discoverRoutes,
  divergenceVia,
  isDistinct,
  labelCandidates,
  learnedRoutes,
  learnedVia,
  nextViaCache,
  noBacktrack,
  odKey,
  overlap,
  queryToRequest,
  selectCandidates,
  simplifyPolyline,
  siblingExitVias,
  traceOfTrip,
  splitPoint,
  type FoundRoute,
  type NavRoute,
  type NavStep,
  type RouteQuery,
} from '../src/navigation';

const LAT0 = 45.6;
const LNG0 = -74;
const KX = 111.195 * Math.cos((LAT0 * Math.PI) / 180);
/** Local km grid → LatLng. */
const P = (x: number, y: number): LatLng => ({ lat: LAT0 + y / 111.195, lng: LNG0 + x / KX });

let ids = 0;
/** Route through km-grid corners; one step per segment (named `names[i]`, "ref:" prefix = ref), speed in m/s. */
function route(corners: [number, number][], speed: number, names: string[] = []): NavRoute {
  const geometry = corners.map(([x, y]) => P(x, y));
  const cum = cumulativeDistances(geometry);
  const steps: NavStep[] = [];
  for (let i = 0; i < geometry.length - 1; i++) {
    const d = cum[i + 1]! - cum[i]!;
    const n = names[i] ?? `road ${i}`;
    const step: NavStep = {
      index: i,
      maneuver: { type: i === 0 ? 'depart' : 'turn', location: geometry[i]!, bearingAfter: 0, instruction: '' },
      name: n.startsWith('ref:') ? '' : n,
      distanceM: d,
      durationS: d / speed,
      startAlongM: cum[i]!,
      endAlongM: cum[i + 1]!,
      banners: [],
      voice: [],
      isRamp: false,
      structures: [],
    };
    if (n.startsWith('ref:')) step.ref = n.slice(4);
    steps.push(step);
  }
  const distanceM = cum[cum.length - 1]!;
  return {
    id: `r${ids++}`,
    geometry,
    cum,
    distanceM,
    durationS: distanceM / speed,
    steps,
    maxspeedKph: [],
    congestion: [],
    incidents: [],
    summary: '',
  };
}

const D = P(40, 0);
const A = () => route([[0, 0], [40, 0]], 25, ['ref:15']);
const B = () => route([[0, 0], [5, 6], [35, 6], [40, 0]], 25, ['Montée Nord', 'ref:148', 'Chemin Est']);
const C = () => route([[0, 0], [5, -6], [35, -6], [40, 0]], 25, ['Rue de la Gare', '25e Avenue', 'Chemin Sud']);

describe('route candidates — tunables', () => {
  it('keeps the agreed thresholds in one config', () => {
    expect(CANDIDATES.maxRoutes).toBe(5);
    expect(CANDIDATES.recommend).toMatchObject({ signalS: 12, stopS: 8, yieldS: 2, turnS: 4, tieMinS: 150, tieFrac: 0.04, priorN: 3 });
    expect(CANDIDATES.maxDurationRatio).toBe(1.45);
    expect(CANDIDATES.maxDistanceRatio).toBe(1.35);
    expect(CANDIDATES.learnedRatio).toBe(1.8);
    expect(CANDIDATES.backtrackM).toBe(1500);
    expect(CANDIDATES.gridM).toBe(25);
    expect(CANDIDATES.distinctOverlap).toBe(0.75);
    expect(CANDIDATES.intersectionClearM).toBe(300);
    expect(CANDIDATES.learned).toMatchObject({ simplifyM: 30, endpointM: 1500, endpointFrac: 0.05, clusterOverlap: 0.8, halfLifeDays: 60, minTrips: 2 });
    expect(DISCOVERY.callBudget).toBeLessThanOrEqual(10);
  });
});

describe('route candidates — geometry', () => {
  it('measures overlap on a 25 m grid', () => {
    expect(overlap(A().geometry, A().geometry).ratio).toBeCloseTo(1, 2);
    expect(overlap(A().geometry, route([[0, 0.5], [40, 0.5]], 25).geometry).ratio).toBe(0);
    const half = route([[0, 0], [20, 0], [20, 3], [40, 3]], 25);
    expect(overlap(A().geometry, half.geometry).ratio).toBeGreaterThan(0.45);
    expect(overlap(A().geometry, half.geometry).ratio).toBeLessThan(0.55);
  });

  it('treats a long shared trunk with real road of its own at each end as distinct', () => {
    const trunk = route([[0, 0], [60, 0], [64, 4], [70, 0]], 25);
    const other = route([[0, 0], [60, 0], [64, -4], [70, 0]], 25);
    expect(overlap(trunk.geometry, other.geometry).ratio).toBeGreaterThan(0.75);
    expect(isDistinct(trunk.geometry, other.geometry)).toBe(true);
    const wiggle = route([[0, 0], [30, 0], [30.5, 0.1], [31, 0], [60, 0], [64, 4], [70, 0]], 25);
    expect(isDistinct(trunk.geometry, wiggle.geometry)).toBe(false);
  });

  it('rejects mid-route U-turns and routes that run away from the destination', () => {
    expect(noBacktrack(A(), D)).toBe(true);
    const away = route([[0, 0], [-3, 0], [40, 0]], 25);
    expect(noBacktrack(away, D)).toBe(false);
    const u = route([[0, 0], [20, 0], [30, 0], [40, 0]], 25);
    u.steps[1]!.maneuver.modifier = 'uturn';
    expect(noBacktrack(u, D)).toBe(false);
  });
});

describe('route candidates — selection and labels', () => {
  it('keeps plausible distinct routes ranked by duration', () => {
    const slow = route([[0, 0], [5, 12], [35, 12], [40, 0]], 12);
    const dup = route([[0, 0], [40, 0.02]], 24);
    const extra = [4, 8, 10].map((y) => ({ route: route([[0, 0], [5, -y], [35, -y], [40, 0]], 22), source: 'split' as const }));
    const out = selectCandidates([{ route: B(), source: 'base' }, { route: A(), source: 'base' }, { route: slow, source: 'base' }, { route: dup, source: 'split' }, ...extra], D);
    expect(out.length).toBe(4);
    expect(out[0]!.route.distanceM).toBeCloseTo(40_000, -3);
    expect(out.map((f) => f.route.durationS)).toEqual([...out.map((f) => f.route.durationS)].sort((a, b) => a - b));
    expect(out.some((f) => f.route === slow)).toBe(false);
    expect(out.some((f) => f.route === dup)).toBe(false);
  });

  it('allows learned routes up to 1.8× and prefers them over a near-identical computed variant', () => {
    const learnedSlow = route([[0, 0], [5, 6], [35, 6], [40, 0]], 15);
    expect(selectCandidates([{ route: A(), source: 'base' }, { route: learnedSlow, source: 'learned' }], D).length).toBe(2);
    expect(selectCandidates([{ route: A(), source: 'base' }, { route: learnedSlow, source: 'split' }], D).length).toBe(1);
    const computed = route([[0, 0], [5, 6], [35, 6], [40, 0]], 24);
    const out = selectCandidates([{ route: A(), source: 'base' }, { route: computed, source: 'split' }, { route: learnedSlow, source: 'learned' }], D);
    expect(out.map((f) => f.source)).toEqual(['base', 'learned']);
  });

  it('names each route by its distinguishing road, refs first, letters as fallback', () => {
    const found: FoundRoute[] = [A(), B(), C()].map((r) => ({ route: r, source: 'base' }));
    const labels = labelCandidates(found).map((c) => c.label);
    expect(labels[0]).toEqual({ kind: 'road', road: 'A-15' });
    expect(labels[1]).toEqual({ kind: 'road', road: 'R-148' });
    expect(labels[2]).toEqual({ kind: 'road', road: '25e Avenue' });
    const twins = labelCandidates([{ route: A(), source: 'base' }, { route: A(), source: 'base' }]).map((c) => c.label);
    expect(twins).toEqual([{ kind: 'letter', letter: 'A' }, { kind: 'letter', letter: 'B' }]);
  });
});

describe('route candidates — vias', () => {
  it('splits away from intersections and ends', () => {
    const b = B();
    const sp = splitPoint(b, 0.5)!;
    for (const s of b.steps) expect(haversineM(sp.point, s.maneuver.location)).toBeGreaterThanOrEqual(300);
    expect(sp.alongM / b.distanceM).toBeGreaterThan(0.35);
    expect(sp.alongM / b.distanceM).toBeLessThan(0.65);
  });

  it('puts a via on the stretch a sub-route does not share', () => {
    const known = [new Footprint(A().geometry)];
    expect(divergenceVia(A(), known)).toBeNull();
    const v = divergenceVia(C(), known)!;
    expect(v.lat).toBeLessThan(P(0, -5).lat);
    expect(Math.abs(v.bearing! - 90)).toBeLessThan(5);
  });
});

describe('route candidates — learned routes', () => {
  const now = Date.UTC(2026, 10, 24);
  const day = 86_400_000;
  const tr = (r: NavRoute, id: string, ago: number) => ({ tripId: id, endedAt: now - ago * day, line: simplifyPolyline(r.geometry), distanceM: r.distanceM });

  it('simplifies with Douglas–Peucker at ~30 m', () => {
    const noisy: LatLng[] = [];
    for (let i = 0; i <= 100; i++) noisy.push(P(i * 0.1, i % 2 === 0 ? 0.01 : -0.01));
    expect(simplifyPolyline(noisy, 30).length).toBe(2);
    expect(simplifyPolyline(B().geometry, 30).length).toBe(4);
  });

  it('clusters matching trips, ranks by count × recency, needs 2 trips unless only one', () => {
    const traces = [tr(B(), 'b1', 1), tr(B(), 'b2', 30), tr(C(), 'c1', 2), tr(C(), 'c2', 3), tr(C(), 'c3', 200), tr(A(), 'a1', 1)];
    const ls = learnedRoutes(traces, P(0.5, 0), P(40, 0.5), now);
    expect(ls.map((l) => l.count)).toEqual([3, 2]);
    expect(ls[0]!.line[1]!.lat).toBeLessThan(LAT0);
    expect(learnedRoutes([tr(B(), 'b', 5)], P(0, 0), D, now).length).toBe(1);
    expect(learnedRoutes(traces, P(10, 10), D, now).length).toBe(0);
  });

  it('asks for a via only where the learned route leaves the known routes', () => {
    const [l] = learnedRoutes([tr(C(), 'c1', 1), tr(C(), 'c2', 2)], P(0, 0), D, now);
    expect(learnedVia(l!, [new Footprint(C().geometry)])).toBeNull();
    const v = learnedVia(l!, [new Footprint(A().geometry), new Footprint(B().geometry)])!;
    expect(v.lat).toBeLessThan(P(0, -5).lat);
  });

  it('keeps vias that produced routes, drops tried ones that did not', () => {
    const v1 = { ...P(10, -6), bearing: 90 };
    const v2 = { ...P(20, 6), bearing: 90 };
    const v3 = { ...P(30, 6), bearing: 90 };
    expect(nextViaCache([v2, v3], [v1, v2], [v1])).toEqual([v1, v3]);
    expect(odKey(P(3, 3.2), D)).toBe(odKey(P(3.01, 3.21), P(40.01, 0)));
    expect(odKey(P(0, 0), D)).not.toBe(odKey(P(5, 0), D));
  });
});

describe('route discovery — recursive alternatives', () => {
  /** Fake Directions: o→d gives A and B; from a split point on A, a sub-route via the southern road; o→via→d follows the via. */
  function world() {
    const queries: RouteQuery[] = [];
    const fetch = async (q: RouteQuery): Promise<NavRoute[]> => {
      queries.push(q);
      const o = q.coordinates[0];
      if (q.coordinates.length === 3) {
        const via = q.coordinates[1]!;
        return via.lat < P(0, -3).lat ? [C()] : via.lat > P(0, 3).lat ? [B()] : [A()];
      }
      if (haversineM(o!, P(0, 0)) < 100) return [A(), B()];
      const x = (o!.lng - LNG0) * KX;
      const y = (o!.lat - LAT0) * 111.195;
      const straight = route([[x, y], [40, 0]], 25, ['ref:15']);
      return Math.abs(y) < 0.1 && x < 30 ? [straight, route([[x, y], [x + 2, -6], [35, -6], [40, 0]], 26, ['Rue de la Gare', '25e Avenue', 'Chemin Sud'])] : [straight];
    };
    return { fetch, queries };
  }

  it('finds the route Directions never offers as an alternative, within the call budget', async () => {
    const w = world();
    const res = await discoverRoutes({ from: P(0, 0), to: D, heading: 90, learned: [], cachedVias: [] }, w.fetch, null);
    expect(res.calls).toBeLessThanOrEqual(DISCOVERY.callBudget);
    expect(w.queries.length).toBe(res.calls);
    expect(res.candidates.length).toBe(3);
    expect(res.candidates.find((c) => c.source === 'split')?.route.geometry[1]!.lat).toBeLessThan(LAT0);
    expect(res.keptVias.length).toBe(1);
    const viaQ = w.queries.find((q) => q.coordinates.length === 3)!;
    expect(viaQ.radiuses).toEqual([null, 25, null]);
    expect(viaQ.bearings[0]).toEqual({ deg: 90, range: 45 });
    expect(viaQ.bearings[1]).not.toBeNull();
  });

  it('uses cached vias first and builds the Mapbox URL with silent waypoints', async () => {
    const w = world();
    const cached = { ...P(20, -6), bearing: 90 };
    const res = await discoverRoutes({ from: P(0, 0), to: D, heading: null, learned: [], cachedVias: [cached] }, w.fetch, null);
    expect(res.candidates.some((c) => c.source === 'cache')).toBe(true);
    expect(res.calls).toBeLessThanOrEqual(DISCOVERY.callBudget);
    const url = directionsUrl(queryToRequest(w.queries.find((q) => q.coordinates.length === 3)!, 'fr'), 'pk.x');
    expect(url).toContain('waypoints=0%3B2');
    expect(url).toContain('radiuses=unlimited%3B25%3Bunlimited');
    expect(url).toContain('bearings=%3B90%2C45%3B');
  });
});

describe('route discovery — sibling exits', () => {
  it('probes the side road just before a discovered divergence that heads the same way', () => {
    const parent = route([[0, 0], [20, 0], [40, 0]], 25, ['ref:148', 'ref:148']);
    parent.steps[1]!.junctions = [
      { location: P(20, 0), out: 90, side: [0, 180] },
      { location: P(10, 0), out: 90, side: [0] },
    ];
    const sub = route([[19, 0], [20.3, 0], [22, 5], [40, 5], [40, 0]], 25, ['ref:148', 'Chemin A', 'Chemin B', 'Chemin C']);
    const vias = siblingExitVias(parent, sub, [new Footprint(parent.geometry)]);
    expect(vias.length).toBe(1);
    expect(haversineM(vias[0]!, P(20, 0.2))).toBeLessThan(20);
  });

  it('snaps probes in one call and stays within the call budget', async () => {
    const parent = route([[0, 0], [20, 0], [40, 0]], 25, ['ref:15', 'ref:15']);
    parent.steps[1]!.junctions = [{ location: P(19.5, 0), out: 90, side: [0] }];
    let snaps = 0;
    const queries: RouteQuery[] = [];
    const fetch = async (q: RouteQuery): Promise<NavRoute[]> => {
      queries.push(q);
      if (q.coordinates.length === 3) {
        const v = q.coordinates[1]!;
        const y = (v.lat - LAT0) * 111.195;
        const x = (v.lng - LNG0) * KX;
        return y > 3 ? [route([[0, 0], [20.5, 0], [22, 5], [38, 5], [40, 0]], 25)] : [route([[0, 0], [x, 0], [x, 3], [38, 3], [40, 0]], 25)];
      }
      if (haversineM(q.coordinates[0]!, P(0, 0)) < 100) return [parent];
      const o = q.coordinates[0]!;
      const x = (o.lng - LNG0) * KX;
      return x < 20 ? [route([[x, 0], [20.5, 0], [22, 5], [38, 5], [40, 0]], 26)] : [route([[x, 0], [40, 0]], 25)];
    };
    const res = await discoverRoutes({ from: P(0, 0), to: D, heading: null, learned: [], cachedVias: [] }, fetch, async (pts) => {
      snaps++;
      return pts.map((p) => ({ location: p, name: 'Montée Test', distanceM: 10 }));
    });
    expect(snaps).toBe(1);
    expect(res.calls).toBe(queries.length + 1);
    expect(res.calls).toBeLessThanOrEqual(DISCOVERY.callBudget);
    expect(res.candidates.length).toBe(3);
  });

  it('turns a driver trip into a simplified trace', () => {
    const pts = B().geometry;
    expect(traceOfTrip({ id: 't', endedAt: 1, distanceM: 46_000, points: pts })!.line.length).toBe(4);
    expect(traceOfTrip({ id: 't', endedAt: 1, distanceM: 200, points: pts })).toBeNull();
  });
});
