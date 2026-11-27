import { angleDiffDeg, bearingDeg, destination, haversineM, pointAlong, projectOnPolyline, type LatLng } from '../geo';
import {
  CANDIDATES,
  Footprint,
  divergenceVia,
  durationToM,
  endZoneM,
  fastShare,
  isMidDistinct,
  labelCandidates,
  learnedVia,
  noBacktrack,
  pointInWindow,
  selectCandidates,
  siblingExitVias,
  splitPoint,
  type CandidateConfig,
  type CandidateSource,
  type FoundRoute,
  type LearnedRoute,
  type RouteCandidate,
  type Via,
} from './candidates';
import type { CrewBias } from './etaBias';
import { fillTypical, recommend, type DriveSample, type TimedTrace } from './recommend';
import type { DirectionsRequest, NavRoute, RouteExclude } from './route';
import type { DiscoveryMode } from './routeCache';

/** One Directions request. Middle coordinates are silent vias (`waypoints=0;n`): they shape the route, no stop. */
export interface RouteQuery {
  coordinates: LatLng[];
  alternatives: boolean;
  /** Per coordinate: { deg, range } or null (any). */
  bearings: ({ deg: number; range: number } | null)[];
  /** Per coordinate: snap radius in m, null = unlimited. */
  radiuses: (number | null)[];
  /** Road classes to avoid (user route options). */
  exclude?: RouteExclude[];
  /** Points to avoid (corridor probe). */
  excludePoints?: LatLng[];
}

export type DirectionsFetcher = (q: RouteQuery) => Promise<NavRoute[]>;

export interface Snapped {
  location: LatLng;
  name: string;
  distanceM: number;
}

/** Where each point snaps on the road network (one Matrix call); null = no road. */
export type SnapFetcher = (points: LatLng[]) => Promise<(Snapped | null)[]>;

export const DISCOVERY = {
  /** Total API calls per search (Directions + the one snap call); two of them go to the corridor probes. */
  callBudget: 10,
  /**
   * Corridor probes (run with the splits, from the plausible base routes):
   *  - avoid: the fastest base route again with `exclude=point(...)` on its longest mid-route step: the best route of
   *    another corridor, which Directions' own 1–2 alternatives often miss at peak hours;
   *  - stay: where a base route leaves a motorway/trunk with ≥ stayMinRemainFrac of the trip left, a silent via
   *    stayAheadM down the mainline (bearing-constrained): "keep to the highway", the route a local driver weighs.
   */
  avoidProbe: true,
  /** An avoided point counts as honoured when the returned route stays this far from it. */
  avoidClearM: 60,
  stayAheadM: 800,
  stayRadiusM: 150,
  stayBearingRange: 30,
  stayMinRemainFrac: 0.15,
  stayMinRemainM: 5000,
  /** Split fractions tried on the fastest route; the second route gets the first one only. */
  splitFractions: [0.5, 0.25],
  maxSplits: 3,
  /** Previously found vias re-tried first (the candidate set stays stable between searches). */
  maxCachedVias: 3,
  viaRadiusM: 25,
  bearingRange: 45,
  /** Sibling-exit probes: sub-routes examined, probes snapped, max snap distance. */
  siblingSubs: 2,
  maxProbes: 12,
  snapMaxM: 200,
};

export interface DiscoveryInput {
  from: LatLng;
  to: LatLng;
  /** Heading at the origin (deg) or null. */
  heading: number | null;
  learned: LearnedRoute[];
  cachedVias: Via[];
  /** Past drives (learned correction) and the clock (time-of-week bucket) for the recommendation. */
  samples?: DriveSample[];
  now?: number;
  /** Road classes to avoid, applied to every query. */
  exclude?: RouteExclude[];
  /** Hazard ranking cost per route (see `RecommendInput.hazardCostS`). */
  hazardCostS?: (route: NavRoute) => number;
  /** Past driver trips with start times, and crew road-group multipliers (ETA truth, D60). */
  traces?: TimedTrace[];
  crew?: CrewBias[];
  /** full (default): all waves; warm: base + cached / learned vias (+ one stay probe without a motorway route); lean: base only. */
  mode?: DiscoveryMode;
}

export interface DiscoveryResult {
  candidates: RouteCandidate[];
  calls: number;
  mode: DiscoveryMode;
  /** Vias that were tried, and those that produced a kept route (for the per-O/D cache). */
  triedVias: Via[];
  keptVias: Via[];
  /** Vias of plausible routes cut only by the candidate cap (cached so they are re-tried next time). */
  plausibleVias: Via[];
}

/**
 * Generic multi-route discovery, no road- or place-specific input:
 *  1. o→d with alternatives (+ cached vias, in parallel);
 *  2. learned-route vias + "recursive alternatives": p→d with alternatives from split points on the best routes;
 *  3. every sub-route that leaves the known routes yields (a) a via on its own road and (b) "sibling exits": side
 *     roads at the parent's intersections just before that divergence, heading the same way, snapped onto the
 *     road network in one call;
 *  4. o→via→d for the most promising vias.
 * ≤ `callBudget` calls in four parallel waves.
 */
export async function discoverRoutes(
  input: DiscoveryInput,
  rawFetch: DirectionsFetcher,
  snap: SnapFetcher | null,
  cfg: CandidateConfig = CANDIDATES,
  d: typeof DISCOVERY = DISCOVERY,
): Promise<DiscoveryResult> {
  const fetch: DirectionsFetcher = (q) => rawFetch(input.exclude?.length ? { ...q, exclude: input.exclude } : q);
  const mode: DiscoveryMode = input.mode ?? 'full';
  let calls = 0;
  const found: FoundRoute[] = [];
  const tried: Via[] = [];
  const originBearing = input.heading === null ? null : { deg: input.heading, range: d.bearingRange };

  const viaCall = (via: Via, source: CandidateSource, radiusM: number = d.viaRadiusM, range: number = d.bearingRange): Promise<void> => {
    calls++;
    tried.push(via);
    return fetch({
      coordinates: [input.from, via, input.to],
      alternatives: false,
      bearings: [originBearing, via.bearing === null ? null : { deg: via.bearing, range }, null],
      radiuses: [null, radiusM, null],
    }).then((rs) => {
      if (!rs[0]) return;
      // A probe via is approximate: cache the point where the route actually passed (it is re-tried with a tight radius).
      found.push({ route: rs[0], source, via: source === 'probe' ? onRouteVia(via, rs[0]) : via });
    });
  };
  const known = (): Footprint[] => found.map((f) => new Footprint(f.route.geometry, cfg.gridM));

  // Wave 1: base + cached vias.
  calls++;
  const basePromise = fetch({ coordinates: [input.from, input.to], alternatives: true, bearings: [originBearing, null], radiuses: [null, null] });
  const early = mode === 'lean' ? [] : input.cachedVias.slice(0, d.maxCachedVias).map((v) => viaCall(v, 'cache'));
  const [base] = await Promise.all([basePromise, Promise.allSettled(early)]);
  if (base.length === 0) return { candidates: [], calls, mode, triedVias: tried, keptVias: [], plausibleVias: [] };
  for (const r of base) found.push({ route: r, source: 'base' });

  // Wave 2: learned vias (where a learned route is not yet covered) + split calls.
  const wave2: Promise<void>[] = [];
  let k = known();
  for (const l of mode === 'lean' ? [] : input.learned) {
    if (calls >= d.callBudget - 2) break;
    const v = learnedVia(l, k, cfg);
    if (v) wave2.push(viaCall(v, 'learned'));
  }
  // Only plausible base routes seed splits and probes (a long out-of-the-way alternative would waste them).
  const plausibleBase = plausibleOf(base, input.to, cfg);
  const plausibleFound = plausibleOf(found.map((f) => f.route), input.to, cfg);
  const hasHighway = plausibleFound.some((r) => fastShare(r) >= cfg.highwaySlotShare);
  // Probes look for a corridor Directions did not offer. Not needed when a motorway route and another corridor are
  // already in the set (full), or at all once a previous search's corridors are re-asked (warm) — except the
  // "stay on the highway" probe when no route keeps to the highway yet.
  const otherCorridor = plausibleFound.some((r) => fastShare(r) < cfg.highwaySlotShare && plausibleFound.some((h) => h !== r && fastShare(h) >= cfg.highwaySlotShare && isMidDistinct(h.geometry, r.geometry, cfg)));
  const probes = mode === 'lean' ? [] : corridorProbes(plausibleBase, cfg, d).filter((p) => (p.kind === 'stay' ? !hasHighway || mode === 'full' : mode === 'full' && !otherCorridor));
  for (const pr of probes) {
    if (calls >= d.callBudget - 2) break;
    if (pr.kind === 'avoid') {
      calls++;
      wave2.push(
        fetch({ coordinates: [input.from, input.to], alternatives: true, bearings: [originBearing, null], radiuses: [null, null], excludePoints: [pr.point] }).then((rs) => {
          // Keep only routes that really avoid the point (an ignored exclusion just repeats the base route).
          for (const r of rs) if (projectOnPolyline(pr.point, r.geometry, r.cum).distanceM >= d.avoidClearM) found.push({ route: r, source: 'probe' });
        }),
      );
    } else wave2.push(viaCall(pr.via, 'probe', d.stayRadiusM, d.stayBearingRange));
  }
  const parents = plausibleBase.slice(0, 2);
  const plan: [NavRoute, number][] = [];
  for (const f of d.splitFractions) for (const [i, r] of parents.entries()) if (i === 0 || f === d.splitFractions[0]) plan.push([r, f]);
  const splitSlots = mode === 'full' ? Math.min(d.maxSplits, d.callBudget - calls - 2) : 0;
  const subs: { route: NavRoute; parent: NavRoute; prefixS: number }[] = [];
  let splits = 0;
  for (const [parent, f] of plan) {
    if (splits >= splitSlots) break;
    const sp = splitPoint(parent, f, cfg);
    if (!sp) continue;
    splits++;
    calls++;
    wave2.push(
      fetch({
        coordinates: [sp.point, input.to],
        alternatives: true,
        bearings: [{ deg: sp.bearing, range: d.bearingRange }, null],
        radiuses: [null, null],
      }).then((rs) => {
        const prefixS = durationToM(parent, sp.alongM);
        for (const r of rs) subs.push({ route: r, parent, prefixS });
      }),
    );
  }
  await Promise.allSettled(wave2);

  // Wave 3: divergence vias from sub-routes (most promising first) and sibling-exit probes, snapped in one call.
  k = known();
  const best = Math.min(...found.map((f) => f.route.durationS));
  const diverging: { via: Via; sub: (typeof subs)[number] }[] = [];
  for (const s of subs.sort((a, b) => a.prefixS + a.route.durationS - (b.prefixS + b.route.durationS))) {
    if (s.prefixS + s.route.durationS > best * cfg.maxDurationRatio) continue;
    const v = divergenceVia(s.route, k, cfg);
    if (!v) continue;
    diverging.push({ via: v, sub: s });
    k.push(new Footprint(s.route.geometry, cfg.gridM));
  }
  const siblings: Via[] = [];
  if (snap && diverging.length > 0 && calls < d.callBudget - 1) {
    const kBase = known();
    const probes: Via[] = [];
    for (const g of diverging.slice(0, d.siblingSubs)) {
      probes.push(...siblingExitVias(g.sub.parent, g.sub.route, kBase, cfg).slice(0, Math.ceil(d.maxProbes / d.siblingSubs)));
    }
    if (probes.length > 0) {
      calls++;
      const snapped = await snap(probes).catch((): (Snapped | null)[] => []);
      const names = new Set<string>();
      for (const s of snapped) {
        if (!s || !s.name || s.distanceM > d.snapMaxM || names.has(s.name)) continue;
        names.add(s.name);
        if (!kBase.some((f) => f.covers(s.location))) siblings.push({ lat: s.location.lat, lng: s.location.lng, bearing: null });
      }
    }
  }

  // Wave 4: o→via→d, alternating divergence vias and sibling exits.
  const queue: [Via, CandidateSource][] = [];
  for (let i = 0; i < Math.max(diverging.length, siblings.length); i++) {
    if (diverging[i]) queue.push([diverging[i]!.via, 'split']);
    if (siblings[i]) queue.push([siblings[i]!, 'split']);
  }
  await Promise.allSettled(queue.slice(0, Math.max(0, d.callBudget - calls)).map(([v, s]) => viaCall(v, s)));

  fillTypical(found, cfg);
  const kept = selectCandidates(found, input.to, cfg);
  const fastestS = Math.min(...found.map((f) => f.route.durationS));
  return {
    mode,
    candidates: recommend(
      labelCandidates(kept, cfg),
      {
        learned: input.learned,
        samples: input.samples ?? [],
        now: input.now ?? Date.now(),
        ...(input.hazardCostS ? { hazardCostS: input.hazardCostS } : {}),
        ...(input.traces ? { traces: input.traces } : {}),
        ...(input.crew ? { crew: input.crew } : {}),
      },
      cfg,
    ),
    calls,
    triedVias: tried,
    keptVias: kept.flatMap((f) => (f.via ? [f.via] : [])),
    plausibleVias: found
      .filter((f) => f.via && !kept.includes(f) && f.route.durationS <= fastestS * cfg.maxDurationRatio && noBacktrack(f.route, input.to, cfg))
      .sort((a, b) => a.route.durationS - b.route.durationS)
      .map((f) => f.via!),
  };
}

/** Non-backtracking routes within the duration / distance ratios of the best of them. */
export function plausibleOf(routes: NavRoute[], dest: LatLng, cfg: CandidateConfig = CANDIDATES): NavRoute[] {
  const ok = routes.filter((r) => r.geometry.length >= 2 && noBacktrack(r, dest, cfg));
  if (ok.length === 0) return routes.slice(0, 1);
  const best = Math.min(...ok.map((r) => r.durationS));
  const shortest = Math.min(...ok.map((r) => r.distanceM));
  return ok.filter((r) => r.durationS <= best * cfg.maxDurationRatio && r.distanceM <= shortest * cfg.maxDistanceRatio).sort((a, b) => a.durationS - b.durationS);
}

export type CorridorProbe = { kind: 'avoid'; point: LatLng } | { kind: 'stay'; via: Via };

const FAST = new Set(['motorway', 'trunk']);

/**
 * Corridor probes for the plausible base routes (fastest first): one "avoid" point on the fastest route's longest
 * mid-route step (clear of maneuvers), and one "stay" via down the mainline at the first motorway/trunk exit that
 * still leaves a real part of the trip, skipped when another base route already stays on that road there.
 */
export function corridorProbes(base: NavRoute[], cfg: CandidateConfig = CANDIDATES, d: typeof DISCOVERY = DISCOVERY): CorridorProbe[] {
  const out: CorridorProbe[] = [];
  const fastest = base[0];
  if (!fastest) return out;
  const total = fastest.cum[fastest.cum.length - 1] ?? 0;
  const z = endZoneM(total, cfg);
  if (d.avoidProbe && total > 2 * z) {
    let bestStep: { from: number; to: number } | null = null;
    for (const s of fastest.steps) {
      const from = Math.max(s.startAlongM, z);
      const to = Math.min(s.endAlongM, total - z);
      if (to - from >= cfg.minDivergenceM && (!bestStep || to - from > bestStep.to - bestStep.from)) bestStep = { from, to };
    }
    const p = bestStep ? pointInWindow(fastest.geometry, bestStep.from, bestStep.to, fastest.steps.map((s) => s.maneuver.location), { ...cfg, endClearM: 0 }) : null;
    if (p) out.push({ kind: 'avoid', point: p.point });
  }
  const prints = base.map((r) => new Footprint(r.geometry, cfg.gridM));
  for (const r of base) {
    const via = stayVia(r, d);
    if (!via) continue;
    // Some base route already keeps to the highway past this exit: nothing to probe.
    if (prints.some((f, i) => base[i] !== r && f.covers(via))) continue;
    out.push({ kind: 'stay', via });
    break;
  }
  return out;
}

/** "Keep to the highway" via for the first motorway/trunk exit of a route with enough trip left, else null. */
export function stayVia(r: NavRoute, d: typeof DISCOVERY = DISCOVERY): Via | null {
  const total = r.cum[r.cum.length - 1] ?? 0;
  for (let i = 1; i < r.steps.length; i++) {
    const prev = r.steps[i - 1]!;
    const s = r.steps[i]!;
    if (!FAST.has(prev.roadClass ?? '') || prev.isRamp) continue;
    if (s.maneuver.type === 'arrive') return null;
    // Ramps lead somewhere: onto another motorway (interchange, keep looking) or off the highway network (an exit).
    let k = i;
    while (k < r.steps.length - 1 && r.steps[k]!.isRamp) k++;
    const after = r.steps[k]!;
    if (FAST.has(after.roadClass ?? '') && after.maneuver.type !== 'arrive') continue;
    if (total - s.startAlongM < Math.max(d.stayMinRemainM, d.stayMinRemainFrac * total)) return null;
    const at = s.maneuver.location;
    const inBearing = bearingDeg(pointAlong(r.geometry, r.cum, Math.max(0, s.startAlongM - 80)), pointAlong(r.geometry, r.cum, s.startAlongM));
    // The mainline is the side road closest to straight on; without intersection data, straight on.
    const j = [...(prev.junctions ?? []), ...(s.junctions ?? [])].find((x) => haversineM(x.location, at) < 20);
    const side = (j?.side ?? []).map((b) => ({ b, dev: Math.abs(angleDiffDeg(b, inBearing)) })).sort((a, b) => a.dev - b.dev)[0];
    const bearing = side && side.dev < 30 ? side.b : inBearing;
    const p = destination(at, bearing, d.stayAheadM);
    return { lat: p.lat, lng: p.lng, bearing };
  }
  return null;
}

/** The point of `route` nearest to `via`, with the route's bearing there. */
function onRouteVia(via: Via, route: NavRoute): Via {
  const q = projectOnPolyline(via, route.geometry, route.cum);
  const a = pointAlong(route.geometry, route.cum, Math.max(0, q.alongM - 30));
  const b = pointAlong(route.geometry, route.cum, Math.min(route.distanceM, q.alongM + 30));
  const p = pointAlong(route.geometry, route.cum, q.alongM);
  return { lat: p.lat, lng: p.lng, bearing: bearingDeg(a, b) };
}

/** The Directions request for a discovery query (same URL builder as plain routing). */
export function queryToRequest(q: RouteQuery, language: 'en' | 'fr' | 'ru'): DirectionsRequest {
  return {
    coordinates: q.coordinates,
    alternatives: q.alternatives,
    bearings: q.bearings,
    radiuses: q.radiuses,
    silentVias: true,
    language,
    ...(q.exclude?.length ? { exclude: q.exclude } : {}),
    ...(q.excludePoints?.length ? { excludePoints: q.excludePoints } : {}),
  };
}

/** Matrix API (driving) URL used as the snap call: `destinations[i]` carries each point's snapped road. */
export function snapUrl(points: LatLng[], accessToken: string): string {
  if (points.length === 1) points = [points[0]!, points[0]!];
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  return `https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${coords}?sources=0&annotations=distance&access_token=${accessToken}`;
}

/** Parses the snap call's response (Matrix `destinations`: location, name, snap distance). */
export function parseSnap(res: { destinations?: ({ location: [number, number]; name?: string; distance?: number } | null)[] }): (Snapped | null)[] {
  return (res.destinations ?? []).map((x) => (x ? { location: { lat: x.location[1], lng: x.location[0] }, name: x.name ?? '', distanceM: x.distance ?? 0 } : null));
}
