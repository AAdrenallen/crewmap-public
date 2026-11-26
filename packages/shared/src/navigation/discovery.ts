import type { LatLng } from '../geo';
import {
  CANDIDATES,
  Footprint,
  divergenceVia,
  durationToM,
  labelCandidates,
  learnedVia,
  noBacktrack,
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
import { fillTypical, recommend, type DriveSample } from './recommend';
import type { DirectionsRequest, NavRoute, RouteExclude } from './route';

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
  /** Total API calls per search (Directions + the one snap call). */
  callBudget: 8,
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
}

export interface DiscoveryResult {
  candidates: RouteCandidate[];
  calls: number;
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
  let calls = 0;
  const found: FoundRoute[] = [];
  const tried: Via[] = [];
  const originBearing = input.heading === null ? null : { deg: input.heading, range: d.bearingRange };

  const viaCall = (via: Via, source: CandidateSource): Promise<void> => {
    calls++;
    tried.push(via);
    return fetch({
      coordinates: [input.from, via, input.to],
      alternatives: false,
      bearings: [originBearing, via.bearing === null ? null : { deg: via.bearing, range: d.bearingRange }, null],
      radiuses: [null, d.viaRadiusM, null],
    }).then((rs) => {
      if (rs[0]) found.push({ route: rs[0], source, via });
    });
  };
  const known = (): Footprint[] => found.map((f) => new Footprint(f.route.geometry, cfg.gridM));

  // Wave 1: base + cached vias.
  calls++;
  const basePromise = fetch({ coordinates: [input.from, input.to], alternatives: true, bearings: [originBearing, null], radiuses: [null, null] });
  const early = input.cachedVias.slice(0, d.maxCachedVias).map((v) => viaCall(v, 'cache'));
  const [base] = await Promise.all([basePromise, Promise.allSettled(early)]);
  if (base.length === 0) return { candidates: [], calls, triedVias: tried, keptVias: [], plausibleVias: [] };
  for (const r of base) found.push({ route: r, source: 'base' });

  // Wave 2: learned vias (where a learned route is not yet covered) + split calls.
  const wave2: Promise<void>[] = [];
  let k = known();
  for (const l of input.learned) {
    if (calls >= d.callBudget - 2) break;
    const v = learnedVia(l, k, cfg);
    if (v) wave2.push(viaCall(v, 'learned'));
  }
  const parents = base.slice(0, 2);
  const plan: [NavRoute, number][] = [];
  for (const f of d.splitFractions) for (const [i, r] of parents.entries()) if (i === 0 || f === d.splitFractions[0]) plan.push([r, f]);
  const splitSlots = Math.min(d.maxSplits, d.callBudget - calls - 2);
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
    candidates: recommend(labelCandidates(kept, cfg), { learned: input.learned, samples: input.samples ?? [], now: input.now ?? Date.now() }, cfg),
    calls,
    triedVias: tried,
    keptVias: kept.flatMap((f) => (f.via ? [f.via] : [])),
    plausibleVias: found
      .filter((f) => f.via && !kept.includes(f) && f.route.durationS <= fastestS * cfg.maxDurationRatio && noBacktrack(f.route, input.to, cfg))
      .sort((a, b) => a.route.durationS - b.route.durationS)
      .map((f) => f.via!),
  };
}

/** The Directions request for a discovery query (same URL builder as plain routing). */
export function queryToRequest(q: RouteQuery, language: 'en' | 'fr' | 'ru'): DirectionsRequest {
  return { coordinates: q.coordinates, alternatives: q.alternatives, bearings: q.bearings, radiuses: q.radiuses, silentVias: true, language, ...(q.exclude?.length ? { exclude: q.exclude } : {}) };
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
