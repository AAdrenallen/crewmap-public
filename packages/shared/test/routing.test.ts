import { describe, expect, it } from 'vitest';
import { cumulativeDistances, encodePolyline, haversineM, type LatLng } from '../src/geo';
import { CAMERA_FIT, fitBounds, metresPerDp } from '../src/cameraFit';
import { fitZoom } from '../src/crewCluster';
import {
  CANDIDATES,
  DISCOVERY,
  corridorProbes,
  directionsUrl,
  discoverRoutes,
  displayRef,
  endpointsMatch,
  endZoneM,
  isDistinct,
  isMidDistinct,
  labelCandidates,
  learnedRoutes,
  normRef,
  parseMapboxRoute,
  plausibleOf,
  queryToRequest,
  recommend,
  refsByName,
  roadPenaltyS,
  roadsOf,
  selectCandidates,
  stayVia,
  type FoundRoute,
  type NavRoute,
  type NavStep,
  type RouteCandidate,
  type RouteControls,
  type RouteQuery,
} from '../src/navigation';

// Invented roads on a local km grid near a public landmark area (no real addresses).
const LAT0 = 45.6;
const LNG0 = -74;
const KX = 111.195 * Math.cos((LAT0 * Math.PI) / 180);
const P = (x: number, y: number): LatLng => ({ lat: LAT0 + y / 111.195, lng: LNG0 + x / KX });
const NOON = new Date(2026, 10, 24, 12, 0).getTime();

let ids = 0;
/** One step per segment: name (or "ref:N"), Mapbox Streets class, speed m/s. */
function route(corners: [number, number][], speed: number, roads: [string, string][] = [], controls?: Partial<RouteControls>): NavRoute {
  const geometry = corners.map(([x, y]) => P(x, y));
  const cum = cumulativeDistances(geometry);
  const steps: NavStep[] = [];
  for (let i = 0; i < geometry.length - 1; i++) {
    const d = cum[i + 1]! - cum[i]!;
    const [n, cls] = roads[i] ?? [`road ${i}`, 'street'];
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
      roadClass: cls,
    };
    if (n.startsWith('ref:')) step.ref = n.slice(4);
    steps.push(step);
  }
  const distanceM = cum[cum.length - 1]!;
  const r: NavRoute = { id: `t${ids++}`, geometry, cum, distanceM, durationS: distanceM / speed, steps, maxspeedKph: [], congestion: [], incidents: [], summary: '' };
  if (controls) r.controls = { signals: 0, stops: 0, yields: 0, turns: 0, fastRoadM: 0, ...controls };
  return r;
}
const cand = (r: NavRoute): RouteCandidate => ({ route: r, source: 'base', label: { kind: 'letter', letter: 'A' } });

// A motorway corridor (south), a numbered regional road (north), and a motorway twin that differs only at the end.
const MOTORWAY = (): NavRoute =>
  route([[0, 0], [2, 0], [20, -8], [50, -8], [56, -2], [58, 0], [60, 0]], 27, [
    ['Rue Alpha', 'street'],
    ['ref:77', 'motorway'],
    ['ref:88', 'motorway'],
    ['Boulevard Omega', 'primary'],
    ['Boulevard Omega', 'primary'],
    ['Rue Finale', 'street'],
  ]);
const REGIONAL = (): NavRoute =>
  route([[0, 0], [2, 0], [10, 8], [50, 8], [58, 0], [60, 0]], 22, [
    ['Rue Alpha', 'street'],
    ['ref:299', 'primary'],
    ['ref:299', 'primary'],
    ['Montée Bêta', 'tertiary'],
    ['Rue Finale', 'street'],
  ]);
const TWIN = (): NavRoute =>
  route([[0, 0], [2, 0], [20, -8], [50, -8], [56, -2], [60, -2], [60, 0]], 27, [
    ['Rue Alpha', 'street'],
    ['ref:77', 'motorway'],
    ['ref:88', 'motorway'],
    ['Boulevard Omega', 'primary'],
    ['Rue Gamma', 'street'],
    ['Rue Delta', 'street'],
  ]);
const TWIN2 = (): NavRoute =>
  route([[0, 0], [2, 0], [20, -8], [50, -8], [56, -2], [57, 1.5], [60, 0]], 27, [
    ['Rue Alpha', 'street'],
    ['ref:77', 'motorway'],
    ['ref:88', 'motorway'],
    ['Boulevard Omega', 'primary'],
    ['Rue Epsilon', 'street'],
    ['Rue Zeta', 'street'],
  ]);
const D = P(60, 0);

describe('road classes from Mapbox intersections', () => {
  it('measures class, toll and left-turn totals per intersection span, ramps counted with their road', () => {
    const pts = [0, 1, 2, 3, 4, 5].map((x) => P(x, 0));
    const step = (type: string, modifier: string | undefined, dist: number, ints: object[]) => ({
      distance: dist,
      duration: dist / 20,
      name: '',
      geometry: '',
      maneuver: { type, modifier, location: [-74, 45.6], bearing_after: 90, instruction: '' },
      intersections: ints,
    });
    const at = (i: number) => [pts[i]!.lng, pts[i]!.lat];
    const r = parseMapboxRoute(
      {
        geometry: encodePolyline(pts, 6),
        distance: 5000,
        duration: 250,
        legs: [
          {
            steps: [
              step('depart', undefined, 1000, [{ location: at(0), geometry_index: 0, mapbox_streets_v8: { class: 'street' } }]),
              step('on ramp', 'right', 1000, [{ location: at(1), geometry_index: 1, mapbox_streets_v8: { class: 'motorway_link' } }]),
              step('merge', 'slight left', 2000, [
                { location: at(2), geometry_index: 2, mapbox_streets_v8: { class: 'motorway' } },
                { location: at(3), geometry_index: 3, classes: ['toll', 'motorway'], mapbox_streets_v8: { class: 'motorway' } },
              ]),
              step('turn', 'left', 1000, [{ location: at(4), geometry_index: 4, mapbox_streets_v8: { class: 'tertiary' } }]),
              step('arrive', undefined, 0, [{ location: at(5), geometry_index: 5 }]),
            ] as never,
          },
        ],
      },
      'x',
    );
    const c = r.controls!;
    expect(c.fastRoadM).toBeCloseTo(3000, -2);
    expect(c.minorRoadM).toBeCloseTo(1000, -2);
    expect(c.tertiaryRoadM).toBeCloseTo(1000, -2);
    expect(c.tollM).toBeCloseTo(1000, -2);
    expect(c.leftTurns).toBe(1);
    expect(r.steps.map((s) => s.roadClass)).toEqual(['street', 'motorway', 'motorway', 'tertiary', undefined]);
  });
});

describe('route labels', () => {
  it('says numbered roads the local way and drops direction suffixes', () => {
    const qc = { lat: 45.5088, lng: -73.554 }; // Montréal city hall
    const on = { lat: 43.6426, lng: -79.3871 }; // Toronto, CN Tower
    expect(displayRef('77', qc)).toBe('A-77');
    expect(displayRef('420', qc)).toBe('A-420');
    expect(displayRef('299', qc)).toBe('R-299');
    expect(displayRef('77-O', qc)).toBe('A-77');
    expect(normRef('88 Est')).toBe('88');
    expect(displayRef('477', on)).toBe('477');
    expect(displayRef('CR 9', qc)).toBe('CR 9');
  });

  it('lets a ref-less step of a numbered highway inherit the ref another candidate carries', () => {
    const a = MOTORWAY();
    a.steps[2]!.name = 'Autoroute Test';
    const b = TWIN();
    b.steps[2]!.name = 'Autoroute Test';
    delete b.steps[2]!.ref;
    expect(roadsOf(b).some((r) => r.key === 'Autoroute Test')).toBe(true);
    const names = refsByName([a, b]);
    expect(roadsOf(b, names).find((r) => r.key === '88')?.isRef).toBe(true);
  });

  it('names a route by its corridor (numbered roads first, two at most), never by its first / last streets', () => {
    const [m, r] = labelCandidates([MOTORWAY(), REGIONAL()].map((route) => ({ route, source: 'base' as const })));
    expect(m!.label).toEqual({ kind: 'road', road: 'A-77, A-88' });
    expect(r!.label.kind).toBe('road');
    const text = r!.label.kind === 'road' ? r!.label.road : '';
    expect(text.startsWith('R-299')).toBe(true);
    expect(text).not.toContain('Rue Alpha');
    expect(text).not.toContain('Rue Finale');
  });

  it('keeps every label distinct, falling back to corridor roads before letters', () => {
    const out = labelCandidates([MOTORWAY(), REGIONAL(), TWIN()].map((route) => ({ route, source: 'base' as const })));
    const texts = out.map((c) => (c.label.kind === 'road' ? c.label.road : c.label.letter));
    expect(new Set(texts).size).toBe(3);
    expect(out.every((c) => c.label.kind === 'road')).toBe(true);
    expect(texts[2]).toMatch(/A-(77|88)/);
    expect(texts[2]).toContain('Rue Gamma');
    // The faster of two end-only twins is named by its corridor, never by its last streets.
    expect(texts[0]).toBe('A-77, A-88');
  });
});

describe('candidate selection', () => {
  it('treats routes that differ only in an end zone as one corridor and shows at most one such variant', () => {
    const m = MOTORWAY().geometry;
    const t = TWIN().geometry;
    expect(isDistinct(m, t)).toBe(true);
    expect(isMidDistinct(m, t)).toBe(false);
    expect(isMidDistinct(m, REGIONAL().geometry)).toBe(true);
    const found: FoundRoute[] = [MOTORWAY(), REGIONAL(), TWIN(), TWIN2()].map((route) => ({ route, source: 'base' }));
    const kept = selectCandidates(found, D);
    expect(kept.length).toBe(3);
    expect(kept.filter((f) => f.route.steps.some((s) => s.name === 'Rue Gamma' || s.name === 'Rue Epsilon')).length).toBe(CANDIDATES.maxEndVariants);
    expect(endZoneM(66_000)).toBeCloseTo(6600, 0);
    expect(endZoneM(5_000)).toBe(CANDIDATES.endClearM);
    expect(endZoneM(500_000)).toBe(CANDIDATES.endZoneMaxM);
  });

  it('keeps a slot for the motorway corridor when siblings of one corridor would fill the list', () => {
    const fast = route([[0, 0], [5, 8], [55, 8], [60, 0]], 25, [], { fastRoadM: 0 });
    const siblings = [9, 10, 11, 12, 13].map((y) => ({ route: route([[0, 0], [5, y], [55, y], [60, 0]], 24.5, [], { fastRoadM: 0 }), source: 'split' as const }));
    const mw = route([[0, 0], [5, -8], [55, -8], [60, 0]], 23, [], { fastRoadM: 55_000 });
    const out = selectCandidates([{ route: fast, source: 'base' }, ...siblings, { route: mw, source: 'split' }], P(60, 0));
    expect(out.length).toBe(CANDIDATES.maxRoutes);
    expect(out.some((f) => f.route === mw)).toBe(true);
  });
});

describe('recommendation costs and tags', () => {
  it('prices local streets, collectors and left turns as ranking-only penalties', () => {
    const r = route([[0, 0], [10, 0]], 20, [], { minorRoadM: 2000, tertiaryRoadM: 5000, leftTurns: 3 });
    const rc = CANDIDATES.recommend;
    expect(roadPenaltyS(r)).toBeCloseTo(2 * rc.minorKmS + 5 * rc.tertiaryKmS + 3 * rc.leftTurnS, 6);
    r.incidents.push({ id: 'i', type: 'construction', description: '', closed: true, startAlongM: 100, endAlongM: 200, location: P(1, 0) });
    expect(roadPenaltyS(r)).toBeGreaterThanOrEqual(rc.closedS);
    const [x] = recommend([cand(r)], { learned: [], samples: [], now: NOON });
    expect(x!.expectedS).toBe(r.durationS); // the ETA never carries ranking penalties
  });

  it('prefers the main-road route over an equally fast back-street shortcut', () => {
    const back = route([[0, 0], [5, 6], [35, 6], [40, 0]], 25, [], { minorRoadM: 9000, leftTurns: 4, turns: 8 });
    const main = route([[0, 0], [5, -6], [35, -6], [40, 0]], 24.8, [], { fastRoadM: 30_000, turns: 4 });
    const out = recommend([cand(back), cand(main)], { learned: [], samples: [], now: NOON });
    expect(out[0]!.route).toBe(main);
  });

  it('never lets a route a few minutes slower win on one or two fewer lights', () => {
    const fast = route([[0, 0], [5, 6], [35, 6], [40, 0]], 1, [], { signals: 10 });
    fast.durationS = 3600;
    const slow = route([[0, 0], [5, -6], [35, -6], [40, 0]], 1, [], { signals: 8 });
    slow.durationS = 3700;
    expect(recommend([cand(fast), cand(slow)], { learned: [], samples: [], now: NOON })[0]!.route).toBe(fast);
  });

  it('adds the hazard cost the app supplies and never recommends a closed route', () => {
    const a = route([[0, 0], [5, 6], [35, 6], [40, 0]], 25);
    const b = route([[0, 0], [5, -6], [35, -6], [40, 0]], 24);
    expect(recommend([cand(a), cand(b)], { learned: [], samples: [], now: NOON })[0]!.route).toBe(a);
    const out = recommend([cand(a), cand(b)], { learned: [], samples: [], now: NOON, hazardCostS: (r) => (r === a ? 900 : 0) });
    expect(out[0]!.route).toBe(b);
    expect(out.find((c) => c.route === a)!.costS).toBeCloseTo(a.durationS + 900, 6);
  });

  it('tags what sets a route apart and gives each its delay vs the fastest', () => {
    const quick = route([[0, 0], [5, 6], [35, 6], [40, 0]], 26, [], { turns: 20, signals: 8, fastRoadM: 4000, tollM: 3000 });
    const hw = route([[0, 0], [5, -6], [35, -6], [40, 0]], 25, [], { turns: 6, signals: 2, fastRoadM: 40_000 });
    const short = route([[0, 0], [40, 0]], 18, [], { turns: 14, signals: 9 });
    const out = recommend([cand(quick), cand(hw), cand(short)], { learned: [], samples: [], now: NOON });
    const by = (r: NavRoute) => out.find((c) => c.route === r)!;
    expect(by(quick).tags).toContain('fastest');
    expect(by(hw).tags).toEqual(expect.arrayContaining(['highway', 'fewerTurns', 'noTolls']));
    expect(by(short).tags).toEqual(expect.arrayContaining(['shortest', 'noTolls']));
    expect(by(quick).deltaS).toBe(0);
    expect(by(short).deltaS).toBe(Math.round(short.durationS - quick.durationS));
    const [solo] = recommend([cand(quick)], { learned: [], samples: [], now: NOON });
    expect(solo!.tags).toEqual([]);
  });
});

describe('corridor probes', () => {
  it('seeds splits and probes only from plausible base routes', () => {
    const ok = MOTORWAY();
    const far = route([[0, 0], [0, 40], [60, 40], [60, 0]], 40);
    expect(plausibleOf([far, ok], D)).toEqual([ok]);
  });

  it('avoids a mid-route point of the fastest route, clear of maneuvers and end zones', () => {
    const r = MOTORWAY();
    const probes = corridorProbes([r]);
    const avoid = probes.find((p) => p.kind === 'avoid');
    expect(avoid).toBeDefined();
    const pt = avoid!.kind === 'avoid' ? avoid!.point : P(0, 0);
    for (const s of r.steps) expect(haversineM(pt, s.maneuver.location)).toBeGreaterThanOrEqual(CANDIDATES.intersectionClearM);
    const url = directionsUrl(queryToRequest({ coordinates: [P(0, 0), D], alternatives: true, bearings: [null, null], radiuses: [null, null], exclude: ['toll'], excludePoints: [pt] }, 'en'), 'pk.x');
    expect(decodeURIComponent(url.replace(/\+/g, ' '))).toContain(`exclude=toll,point(${pt.lng.toFixed(6)} ${pt.lat.toFixed(6)})`);
  });

  it('probes "stay on the highway" down the mainline where a route leaves the motorway with much of the trip left', () => {
    // Motorway east for 20 km, off-ramp, then a regional road north-east.
    const r = route([[0, 0], [20, 0], [21, 0.3], [40, 10], [60, 0]], 25, [
      ['ref:77', 'motorway'],
      ['Sortie 20', 'motorway'],
      ['ref:299', 'primary'],
      ['ref:299', 'primary'],
    ]);
    r.steps[1]!.isRamp = true;
    r.steps[1]!.maneuver.type = 'off ramp';
    const v = stayVia(r)!;
    expect(v).not.toBeNull();
    expect(haversineM(v, P(20 + DISCOVERY.stayAheadM / 1000, 0))).toBeLessThan(30);
    expect(Math.abs(v.bearing! - 90)).toBeLessThan(2);
    // No probe when another base route already keeps to the highway there.
    const stays = route([[0, 0], [60, 0]], 25, [['ref:77', 'motorway']]);
    expect(corridorProbes([r, stays]).some((p) => p.kind === 'stay')).toBe(false);
    // Nor when the exit is close to the destination.
    const late = route([[0, 0], [57, 0], [58, 0.3], [60, 0]], 25, [['ref:77', 'motorway'], ['Sortie 57', 'motorway'], ['Rue Finale', 'street']]);
    late.steps[1]!.isRamp = true;
    expect(stayVia(late)).toBeNull();
  });

  it('discovers the motorway corridor Directions left out, within the call budget', async () => {
    const regional = REGIONAL();
    regional.steps[0]!.roadClass = 'motorway'; // leaves a motorway early: a "stay" probe is worth it
    regional.steps[1]!.maneuver.type = 'off ramp';
    const queries: RouteQuery[] = [];
    const fetch = async (q: RouteQuery): Promise<NavRoute[]> => {
      queries.push(q);
      if (q.excludePoints?.length) return [MOTORWAY(), REGIONAL()]; // the second one ignores the exclusion
      if (q.coordinates.length === 3) return [MOTORWAY()];
      return [regional];
    };
    const res = await discoverRoutes({ from: P(0, 0), to: D, heading: null, learned: [], cachedVias: [] }, fetch, null);
    expect(res.calls).toBeLessThanOrEqual(DISCOVERY.callBudget);
    expect(queries.some((q) => q.excludePoints?.length === 1)).toBe(true);
    expect(res.candidates.some((c) => c.source === 'probe' && c.route.steps.some((s) => s.ref === '88'))).toBe(true);
  });
});

describe('camera fit', () => {
  const view = { width: 400, height: 800, padding: [90, 48, 464, 48] as const };

  it('never frames less than the minimum span, even for one point', () => {
    const p = P(1, 1);
    const b = fitBounds({ ne: [p.lng, p.lat], sw: [p.lng, p.lat] });
    expect(haversineM({ lat: b.ne[1], lng: b.sw[0] }, { lat: b.ne[1], lng: b.ne[0] })).toBeGreaterThanOrEqual(CAMERA_FIT.minSpanM - 1);
    expect(haversineM({ lat: b.sw[1], lng: b.sw[0] }, { lat: b.ne[1], lng: b.sw[0] })).toBeGreaterThanOrEqual(CAMERA_FIT.minSpanM - 1);
    expect((b.ne[1] + b.sw[1]) / 2).toBeCloseTo(p.lat, 9);
  });

  it('keeps the fit at or below the max zoom for a destination next door', () => {
    const a = P(0, 0);
    const c = P(0.04, 0.02);
    const b = fitBounds({ ne: [c.lng, c.lat], sw: [a.lng, a.lat] }, view);
    expect(fitZoom(b, view.width, view.height, view.padding)).toBeLessThanOrEqual(CAMERA_FIT.maxZoom + 1e-6);
    expect(metresPerDp(CAMERA_FIT.maxZoom, LAT0)).toBeGreaterThan(0.2);
  });

  it('leaves larger bounds untouched', () => {
    const b = { ne: [P(20, 10).lng, P(20, 10).lat] as [number, number], sw: [P(0, 0).lng, P(0, 0).lat] as [number, number] };
    expect(fitBounds(b, view)).toEqual(b);
  });
});

describe('discovery modes (D60: fewer Directions calls)', () => {
  const withShare = (r: NavRoute, share: number): NavRoute => ({ ...r, controls: { signals: 0, stops: 0, yields: 0, turns: 0, fastRoadM: share * r.distanceM } });
  const MW = () => withShare(MOTORWAY(), 0.8);
  const RG = () => withShare(REGIONAL(), 0);
  const leavesMotorway = () => {
    const r = withShare(REGIONAL(), 0.05);
    r.steps[0]!.roadClass = 'motorway';
    r.steps[1]!.maneuver.type = 'off ramp';
    return r;
  };
  const counting = (base: () => NavRoute[]) => {
    const queries: RouteQuery[] = [];
    const fetch = async (q: RouteQuery): Promise<NavRoute[]> => {
      queries.push(q);
      if (q.coordinates.length === 3 || q.excludePoints?.length) return [MW()];
      return base();
    };
    return { queries, fetch };
  };
  const input = (mode: 'full' | 'warm' | 'lean', cachedVias: { lat: number; lng: number; bearing: number | null }[] = []) => ({ from: P(0, 0), to: D, heading: null, learned: [], cachedVias, mode });

  it('lean asks Directions once', async () => {
    const w = counting(() => [leavesMotorway()]);
    const res = await discoverRoutes(input('lean', [{ ...P(30, -8), bearing: 90 }]), w.fetch, null);
    expect(res.calls).toBe(1);
    expect(w.queries).toHaveLength(1);
    expect(res.mode).toBe('lean');
  });

  it('warm re-asks cached vias only, plus the stay probe when no route keeps to the highway', async () => {
    const w = counting(() => [leavesMotorway()]);
    const res = await discoverRoutes(input('warm', [{ ...P(30, -8), bearing: 90 }]), w.fetch, null);
    expect(res.calls).toBe(2);
    expect(res.candidates.some((c) => c.route.steps.some((s) => s.ref === '88'))).toBe(true);
    const w2 = counting(() => [leavesMotorway()]);
    const res2 = await discoverRoutes(input('warm'), w2.fetch, null);
    // No cached via and no motorway route in the base answer: one stay probe, no avoid probe, no splits.
    expect(res2.calls).toBe(2);
    expect(w2.queries.filter((q) => q.excludePoints?.length)).toHaveLength(0);
  });

  it('full skips the avoid probe when a motorway route and another corridor are already there', async () => {
    const w = counting(() => [MW(), RG()]);
    const res = await discoverRoutes(input('full'), w.fetch, null);
    expect(w.queries.some((q) => q.excludePoints?.length)).toBe(false);
    expect(res.calls).toBeLessThan(DISCOVERY.callBudget);
  });

  it('never matches a short reverse B→A trace when routing A→B', () => {
    const startA = P(0, 0);
    const destB = P(0.85, 0); // ~850 m local trip
    const reverseLine = [destB, P(0.4, 0), startA];
    const forwardLine = [startA, P(0.4, 0), destB];
    expect(endpointsMatch(reverseLine[0]!, reverseLine[2]!, startA, destB, 850, CANDIDATES)).toBe(false);
    expect(endpointsMatch(forwardLine[0]!, forwardLine[2]!, startA, destB, 850, CANDIDATES)).toBe(true);
    const learned = learnedRoutes(
      [{ tripId: 'rev', endedAt: NOON, line: reverseLine, distanceM: 850 }],
      startA,
      destB,
      NOON,
    );
    expect(learned).toHaveLength(0);
  });
});
