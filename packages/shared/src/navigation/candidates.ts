import { angleDiffDeg, bearingDeg, cumulativeDistances, destination, haversineM, pointAlong, projectOnPolyline, slicePolyline, type LatLng } from '../geo';
import type { NavRoute } from './route';

/**
 * Route candidates: which of the routes we found are worth showing (plausible, no backtracking, geometrically
 * distinct), how to name them ("via Rue de la Gare"), and which routes the driver actually drives (learned
 * from past trips, on-device only). Pure — the network side lives in `discovery.ts`.
 */
export const CANDIDATES = {
  /** Five: near-sibling corridors (parallel side roads into one interchange) must not crowd out a motorway option. */
  maxRoutes: 5,
  /** Plausibility vs the fastest / shortest route found. */
  maxDurationRatio: 1.45,
  maxDistanceRatio: 1.35,
  /** Routes the driver has driven before may be slower. */
  learnedRatio: 1.8,
  /** Distance-to-destination may never rise this far above its running minimum. */
  backtrackM: 1500,
  /** … or this fraction of the route length on long routes (a 1.9 km northward hop to 25e Avenue on 72 km). */
  backtrackFrac: 0.03,
  backtrackSampleM: 100,
  /** Overlap grid cell; neighbours count as covered, so tolerance ≈ 1.5 cells. */
  gridM: 25,
  /** Two routes are distinct when they share less than this fraction of the shorter one … */
  distinctOverlap: 0.75,
  /** … or when each still has this much road of its own (long shared trunk, real alternative at the end). */
  minUniqueM: 1500,
  minUniqueFrac: 0.02,
  /** A sub-route counts as diverging only with this much uncovered road. */
  minDivergenceM: 1000,
  /** Via / split points keep this far from maneuvers (intersections) and from the route ends. */
  intersectionClearM: 300,
  endClearM: 1000,
  /** Labels: a road counts when driven for at least this long; differences below `labelDiffM` are noise. */
  labelRoadM: 500,
  labelDiffM: 1000,
  /** Among a route's distinctive roads (≥ this share of its most distinctive one), the first one driven names it. */
  labelFirstFrac: 0.33,
  /** Sibling exits: side roads within this distance before a discovered divergence, probed this far along. */
  junctionWindowM: 1500,
  junctionProbeM: 200,
  junctionRadiusM: 75,
  junctionMinTurnDeg: 30,
  learned: {
    simplifyM: 30,
    endpointM: 1500,
    endpointFrac: 0.05,
    clusterOverlap: 0.8,
    halfLifeDays: 60,
    minTrips: 2,
    maxRoutes: 2,
    viaFractions: [0.2, 0.4, 0.6, 0.8],
  },
  recommend: {
    /**
     * Control-delay allowance (s) per control on top of the router's duration. Mapbox/OSRM-style routers add only a
     * small fixed penalty per signal (OSRM default `traffic_signal_penalty` = 2 s) and a few seconds of turn cost.
     * HCM 6th ed. puts average control delay at LOS B–C signals at 10–35 s/veh and at two-way/all-way stops at
     * 10–15 s; we take the conservative low end minus what the router already counts. A turn costs ~4 s of extra
     * deceleration / gap acceptance (AASHTO speed-change model).
     */
    signalS: 12,
    stopS: 8,
    yieldS: 2,
    turnS: 4,
    /** Routes within max(tieMinS, tieFrac × best) of the best expected time are equivalent. */
    tieMinS: 150,
    tieFrac: 0.04,
    /** Tie-break penalty (lower wins): control allowance − motorway/trunk share × fastShareS − habit trips × habitS. */
    fastShareS: 120,
    habitS: 60,
    habitCap: 5,
    /** "+N min vs usual" when live exceeds typical by at least max(this, frac × typical). */
    overUsualMinS: 180,
    overUsualFrac: 0.08,
    /** Learned correction: median actual/predicted shrunk toward 1 by n/(n + priorN), clamped. */
    priorN: 3,
    minFactor: 0.75,
    maxFactor: 1.4,
    maxSamples: 200,
    /** A preview counts for a trip that started within this long of it. */
    previewWindowMs: 45 * 60_000,
  },
};

export type CandidateConfig = typeof CANDIDATES;
export type CandidateSource = 'base' | 'split' | 'learned' | 'cache';

export interface Via {
  lat: number;
  lng: number;
  /** Direction of travel at the via (deg), sent as a Directions `bearings` constraint. */
  bearing: number | null;
}

export type RouteLabel = { kind: 'road'; road: string } | { kind: 'letter'; letter: string };

export interface FoundRoute {
  route: NavRoute;
  source: CandidateSource;
  via?: Via;
}

export type RouteBadge = 'recommended' | 'fastestNow';

export interface RouteCandidate extends FoundRoute {
  label: RouteLabel;
  /** Expected time (s): (live + control allowance) × learned correction. Set by `recommend`. */
  expectedS?: number;
  badge?: RouteBadge | null;
  /** Minutes the live time is notably above typical (0 = not notable). */
  overUsualMin?: number;
  /** Past drives of this route behind `expectedS`. */
  samples?: number;
}

// --- geometry ---------------------------------------------------------------------------------------------------------

const M_PER_DEG = 111_195;

/** Points every `stepM` along a polyline (always includes both ends). */
export function resample(line: LatLng[], stepM: number): LatLng[] {
  if (line.length < 2) return line.slice();
  const cum = cumulativeDistances(line);
  const total = cum[cum.length - 1]!;
  const out: LatLng[] = [];
  for (let a = 0; a < total; a += stepM) out.push(pointAlong(line, cum, a));
  out.push(line[line.length - 1]!);
  return out;
}

function cellOf(p: LatLng, gridM: number): [number, number] {
  return [Math.floor((p.lat * M_PER_DEG) / gridM), Math.floor((p.lng * M_PER_DEG * Math.cos((p.lat * Math.PI) / 180)) / gridM)];
}

/** Grid footprint of a polyline, for fast "is this point on that route" tests. */
export class Footprint {
  private readonly cells = new Set<string>();
  constructor(line: LatLng[], readonly gridM: number = CANDIDATES.gridM) {
    for (const p of resample(line, gridM / 2)) {
      const [y, x] = cellOf(p, gridM);
      this.cells.add(`${y}:${x}`);
    }
  }
  covers(p: LatLng): boolean {
    const [y, x] = cellOf(p, this.gridM);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (this.cells.has(`${y + dy}:${x + dx}`)) return true;
    return false;
  }
}

/** Length (m) of `line` that lies on any of `others`. */
export function coveredLengthM(line: LatLng[], others: Footprint[], gridM: number = CANDIDATES.gridM): number {
  const step = gridM / 2;
  const pts = resample(line, step);
  let n = 0;
  for (const p of pts) if (others.some((f) => f.covers(p))) n++;
  return Math.min(n * step, polylineLengthM(line));
}

export function polylineLengthM(line: LatLng[]): number {
  return cumulativeDistances(line)[line.length - 1] ?? 0;
}

export interface Overlap {
  /** Shared length / shorter route length (0–1). */
  ratio: number;
  uniqueA: number;
  uniqueB: number;
}

export function overlap(a: LatLng[], b: LatLng[], cfg: CandidateConfig = CANDIDATES): Overlap {
  const la = polylineLengthM(a);
  const lb = polylineLengthM(b);
  const sa = coveredLengthM(a, [new Footprint(b, cfg.gridM)], cfg.gridM);
  const sb = coveredLengthM(b, [new Footprint(a, cfg.gridM)], cfg.gridM);
  const shared = Math.min(sa, sb);
  const shorter = Math.min(la, lb);
  return { ratio: shorter > 0 ? shared / shorter : 1, uniqueA: la - sa, uniqueB: lb - sb };
}

export function isDistinct(a: LatLng[], b: LatLng[], cfg: CandidateConfig = CANDIDATES): boolean {
  const o = overlap(a, b, cfg);
  if (o.ratio < cfg.distinctOverlap) return true;
  const need = Math.max(cfg.minUniqueM, cfg.minUniqueFrac * Math.min(polylineLengthM(a), polylineLengthM(b)));
  return o.uniqueA >= need && o.uniqueB >= need;
}

/** No mid-route U-turn and the destination never gets much further away than it already was. */
export function noBacktrack(route: NavRoute, dest: LatLng, cfg: CandidateConfig = CANDIDATES): boolean {
  const last = route.steps.length - 1;
  if (route.steps.some((s, i) => i > 0 && i < last && s.maneuver.modifier === 'uturn')) return false;
  let min = Infinity;
  const tol = Math.max(cfg.backtrackM, cfg.backtrackFrac * route.distanceM);
  for (const p of resample(route.geometry, cfg.backtrackSampleM)) {
    const d = haversineM(p, dest);
    if (d > min + tol) return false;
    min = Math.min(min, d);
  }
  return true;
}

// --- selection --------------------------------------------------------------------------------------------------------

/**
 * Plausible, non-backtracking, mutually distinct routes ranked by traffic duration (max `maxRoutes`).
 * The fastest route always survives.
 */
export function selectCandidates(found: FoundRoute[], dest: LatLng, cfg: CandidateConfig = CANDIDATES): FoundRoute[] {
  const ok = found.filter((f) => f.route.geometry.length >= 2 && noBacktrack(f.route, dest, cfg));
  if (ok.length === 0) return found.length > 0 ? [[...found].sort((a, b) => a.route.durationS - b.route.durationS)[0]!] : [];
  const best = Math.min(...ok.map((f) => f.route.durationS));
  const shortest = Math.min(...ok.map((f) => f.route.distanceM));
  const plausible = ok.filter((f) => {
    const k = f.source === 'learned' ? cfg.learnedRatio : 1;
    return f.route.durationS <= best * cfg.maxDurationRatio * k && f.route.distanceM <= shortest * cfg.maxDistanceRatio * k;
  });
  // Directions' own suggestions stay; routes the driver actually drives beat a near-identical computed variant.
  const byTime = (a: FoundRoute, b: FoundRoute) => a.route.durationS - b.route.durationS;
  const fastest = [...plausible].sort(byTime)[0]!;
  // … then routes found by a previous search (stable candidate set), then new computed ones.
  const rank: Record<CandidateSource, number> = { base: 0, learned: 1, cache: 2, split: 3 };
  const order = [fastest, ...plausible.filter((f) => f !== fastest).sort((a, b) => rank[a.source] - rank[b.source] || byTime(a, b))];
  const kept: FoundRoute[] = [];
  for (const f of order) {
    if (kept.length >= cfg.maxRoutes) break;
    if (kept.every((k) => isDistinct(k.route.geometry, f.route.geometry, cfg))) kept.push(f);
  }
  return kept.sort(byTime);
}

// --- labels -----------------------------------------------------------------------------------------------------------

interface RoadUse {
  key: string;
  lengthM: number;
}

/** Road keys of a step: its refs ("148", "15"; a concurrent "50;148" gives both), else its name. */
function stepKeys(route: NavRoute): string[][] {
  const refOfName = new Map<string, string[]>();
  for (const s of route.steps) if (s.name && s.ref) refOfName.set(s.name, refs(s.ref));
  return route.steps.map((s) => (s.ref ? refs(s.ref) : (refOfName.get(s.name) ?? (s.name ? [s.name] : []))));
}

/** Roads in driving order, merged across steps (a ref-less step of a named highway inherits its ref). */
export function roadsOf(route: NavRoute): RoadUse[] {
  const out: RoadUse[] = [];
  const byKey = new Map<string, RoadUse>();
  stepKeys(route).forEach((keys, i) => {
    for (const key of keys) {
      const u = byKey.get(key);
      if (u) u.lengthM += route.steps[i]!.distanceM;
      else {
        const n = { key, lengthM: route.steps[i]!.distanceM };
        byKey.set(key, n);
        out.push(n);
      }
    }
  });
  return out;
}

function refs(ref: string): string[] {
  return ref.split(';').map((r) => r.trim()).filter(Boolean);
}

/**
 * Names each candidate by the road that tells it apart: per (route, road), the length of that road not shared
 * with the *closest* other candidate (the minimum over the others, measured on the geometry). Pairs are assigned
 * best-first, one road per route and one route per road; a lone route gets its longest road; nothing distinctive
 * gives a letter.
 */
export function labelCandidates(found: FoundRoute[], cfg: CandidateConfig = CANDIDATES): RouteCandidate[] {
  const prints = found.map((f) => new Footprint(f.route.geometry, cfg.gridM));
  const pairs: { i: number; key: string; w: number }[] = [];
  found.forEach((f, i) => {
    const r = f.route;
    const unique = new Map<string, number>();
    const keys = stepKeys(r);
    r.steps.forEach((s, si) => {
      if (keys[si]!.length === 0 || s.endAlongM - s.startAlongM < 1) return;
      const line = slicePolyline(r.geometry, r.cum, s.startAlongM, s.endAlongM);
      const len = s.endAlongM - s.startAlongM;
      let u = len;
      prints.forEach((p, j) => {
        if (j !== i) u = Math.min(u, len - coveredLengthM(line, [p], cfg.gridM));
      });
      for (const k of keys[si]!) unique.set(k, (unique.get(k) ?? 0) + u);
    });
    const mine = roadsOf(r)
      .map((road) => ({ road, u: unique.get(road.key) ?? 0 }))
      .filter(({ road, u }) => road.lengthM >= cfg.labelRoadM && u >= Math.min(cfg.labelDiffM, road.lengthM));
    const maxU = Math.max(0, ...mine.map((m) => m.u));
    mine.forEach(({ road, u }, order) => pairs.push({ i, key: road.key, w: u >= maxU * cfg.labelFirstFrac ? maxU - order * 1e-3 : u }));
  });
  pairs.sort((a, b) => b.w - a.w);
  const byRoute = new Map<number, string>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (byRoute.has(p.i) || used.has(p.key)) continue;
    byRoute.set(p.i, p.key);
    used.add(p.key);
  }
  let letter = 0;
  return found.map((f, i) => {
    const road = byRoute.get(i);
    return road ? { ...f, label: { kind: 'road', road } } : { ...f, label: { kind: 'letter', letter: String.fromCharCode(65 + letter++) } };
  });
}

// --- via / split points -----------------------------------------------------------------------------------------------

/** Maneuver points of a route (where turns/intersections are). */
function maneuvers(route: NavRoute): LatLng[] {
  return route.steps.map((s) => s.maneuver.location);
}

function clearOf(p: LatLng, pts: LatLng[], m: number): boolean {
  return pts.every((q) => haversineM(p, q) >= m);
}

export interface PointOnRoute {
  point: LatLng;
  alongM: number;
  bearing: number;
}

function bearingAt(line: LatLng[], cum: number[], alongM: number): number {
  const total = cum[cum.length - 1] ?? 0;
  const a = pointAlong(line, cum, Math.max(0, alongM - 30));
  const b = pointAlong(line, cum, Math.min(total, alongM + 30));
  return bearingDeg(a, b);
}

/**
 * A point on the route near `fromM..toM`'s middle, at least `intersectionClearM` from any maneuver and
 * `endClearM` from both ends; searches outward in 100 m steps. Null if the window has no such point.
 */
export function pointInWindow(
  line: LatLng[],
  fromM: number,
  toM: number,
  avoid: LatLng[],
  cfg: CandidateConfig = CANDIDATES,
): PointOnRoute | null {
  const cum = cumulativeDistances(line);
  const total = cum[cum.length - 1] ?? 0;
  const lo = Math.max(fromM, cfg.endClearM);
  const hi = Math.min(toM, total - cfg.endClearM);
  if (hi < lo) return null;
  const mid = (lo + hi) / 2;
  for (let off = 0; off <= (hi - lo) / 2; off += 100) {
    for (const a of off === 0 ? [mid] : [mid + off, mid - off]) {
      if (a < lo || a > hi) continue;
      const p = pointAlong(line, cum, a);
      if (clearOf(p, avoid, cfg.intersectionClearM)) return { point: p, alongM: a, bearing: bearingAt(line, cum, a) };
    }
  }
  return null;
}

/** Split point at `fraction` of the route (± 15 % of its length to dodge intersections). */
export function splitPoint(route: NavRoute, fraction: number, cfg: CandidateConfig = CANDIDATES): PointOnRoute | null {
  const total = route.cum[route.cum.length - 1] ?? 0;
  const w = total * 0.15;
  return pointInWindow(route.geometry, total * fraction - w, total * fraction + w, maneuvers(route), cfg);
}

/** Runs [fromM, toM] of `line` not covered by any footprint, longest first. */
export function uncoveredRuns(line: LatLng[], known: Footprint[], cfg: CandidateConfig = CANDIDATES): { fromM: number; toM: number }[] {
  const step = cfg.gridM / 2;
  const pts = resample(line, step);
  const runs: { fromM: number; toM: number }[] = [];
  let start = -1;
  for (let i = 0; i <= pts.length; i++) {
    const free = i < pts.length && !known.some((f) => f.covers(pts[i]!));
    if (free && start < 0) start = i;
    if (!free && start >= 0) {
      runs.push({ fromM: start * step, toM: (i - 1) * step });
      start = -1;
    }
  }
  return runs.sort((a, b) => b.toM - b.fromM - (a.toM - a.fromM));
}

/**
 * Where a sub-route leaves the known routes: a via on its longest uncovered stretch (≥ `minDivergenceM`),
 * away from intersections. Null when it does not really diverge.
 */
export function divergenceVia(sub: NavRoute, known: Footprint[], cfg: CandidateConfig = CANDIDATES): Via | null {
  const run = uncoveredRuns(sub.geometry, known, cfg)[0];
  if (!run || run.toM - run.fromM < cfg.minDivergenceM) return null;
  const p = pointInWindow(sub.geometry, run.fromM, run.toM, maneuvers(sub), { ...cfg, endClearM: 0 });
  return p ? { lat: p.point.lat, lng: p.point.lng, bearing: p.bearing } : null;
}

/** Duration (s) of the route up to `alongM`, from step durations. */
export function durationToM(route: NavRoute, alongM: number): number {
  let s = 0;
  for (const st of route.steps) {
    if (st.endAlongM <= alongM) s += st.durationS;
    else if (st.startAlongM < alongM) s += (st.durationS * (alongM - st.startAlongM)) / Math.max(1, st.endAlongM - st.startAlongM);
  }
  return s;
}

// --- learned routes ---------------------------------------------------------------------------------------------------

/** Douglas–Peucker simplification in metres (local projection). */
export function simplifyPolyline(points: LatLng[], toleranceM: number = CANDIDATES.learned.simplifyM): LatLng[] {
  if (points.length <= 2) return points.slice();
  const o = points[0]!;
  const k = Math.cos((o.lat * Math.PI) / 180);
  const xy = points.map((p) => ({ x: (p.lng - o.lng) * M_PER_DEG * k, y: (p.lat - o.lat) * M_PER_DEG }));
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const A = xy[a]!;
    const B = xy[b]!;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const P = xy[i]!;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2));
      const d = Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > toleranceM) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** A completed driver trip, reduced for route learning. Stays on the device. */
export interface RouteTrace {
  tripId: string;
  endedAt: number;
  line: LatLng[];
  distanceM: number;
}

export interface LearnedRoute {
  line: LatLng[];
  count: number;
  lastAt: number;
  score: number;
}

export function endpointsMatch(a: LatLng, b: LatLng, from: LatLng, to: LatLng, lengthM: number, cfg: CandidateConfig): boolean {
  const tol = Math.max(cfg.learned.endpointM, cfg.learned.endpointFrac * lengthM);
  return haversineM(a, from) <= tol && haversineM(b, to) <= tol;
}

/**
 * Routes the driver has driven from `from` to `to`: matching traces clustered at ≥ 80 % overlap, ranked by
 * count × recency (half-life 60 days). Clusters need ≥ 2 trips unless there is only one matching trip.
 */
export function learnedRoutes(traces: RouteTrace[], from: LatLng, to: LatLng, now: number, cfg: CandidateConfig = CANDIDATES): LearnedRoute[] {
  const match = traces.filter((t) => t.line.length >= 2 && endpointsMatch(t.line[0]!, t.line[t.line.length - 1]!, from, to, t.distanceM, cfg));
  match.sort((a, b) => b.endedAt - a.endedAt);
  const clusters: LearnedRoute[] = [];
  const halfLife = cfg.learned.halfLifeDays * 86_400_000;
  for (const t of match) {
    const w = Math.pow(0.5, Math.max(0, now - t.endedAt) / halfLife);
    const c = clusters.find((k) => overlap(k.line, t.line, cfg).ratio >= cfg.learned.clusterOverlap);
    if (c) {
      c.count++;
      c.score += w;
    } else clusters.push({ line: t.line, count: 1, lastAt: t.endedAt, score: w });
  }
  const eligible = match.length === 1 ? clusters : clusters.filter((c) => c.count >= cfg.learned.minTrips);
  return eligible.sort((a, b) => b.score - a.score).slice(0, cfg.learned.maxRoutes);
}

/**
 * Via that forces Directions onto a learned route: on its longest stretch not covered by `known` routes, else at
 * the first of 20/40/60/80 % that is uncovered. Null when the learned route is already among the known ones.
 */
export function learnedVia(l: LearnedRoute, known: Footprint[], cfg: CandidateConfig = CANDIDATES): Via | null {
  const run = uncoveredRuns(l.line, known, cfg)[0];
  if (run && run.toM - run.fromM >= cfg.minDivergenceM) {
    const p = pointInWindow(l.line, run.fromM, run.toM, [], cfg);
    if (p) return { lat: p.point.lat, lng: p.point.lng, bearing: p.bearing };
  }
  if (known.length > 0) return null;
  const cum = cumulativeDistances(l.line);
  const total = cum[cum.length - 1] ?? 0;
  for (const f of cfg.learned.viaFractions) {
    const a = total * f;
    if (a < cfg.endClearM || a > total - cfg.endClearM) continue;
    const p = pointAlong(l.line, cum, a);
    return { lat: p.lat, lng: p.lng, bearing: bearingAt(l.line, cum, a) };
  }
  return null;
}

// --- per-O/D via cache ------------------------------------------------------------------------------------------------

export const VIA_CACHE = { cellM: 1000, maxVias: 5 } as const;

/** Cache key for an origin/destination pair (≈ 1 km cells). */
export function odKey(from: LatLng, to: LatLng): string {
  const c = (p: LatLng) => `${Math.round((p.lat * M_PER_DEG) / VIA_CACHE.cellM)},${Math.round((p.lng * M_PER_DEG * Math.cos((p.lat * Math.PI) / 180)) / VIA_CACHE.cellM)}`;
  return `${c(from)}>${c(to)}`;
}

/**
 * Next cache content: vias that produced kept routes first, then plausible ones cut only by the cap, then the
 * previous ones that were not tried this time.
 */
export function nextViaCache(prev: Via[], tried: Via[], kept: Via[], plausible: Via[] = []): Via[] {
  const same = (a: Via, b: Via) => haversineM(a, b) < 50;
  const out: Via[] = [];
  for (const v of [...kept, ...plausible, ...prev.filter((p) => !tried.some((t) => same(t, p)))]) if (!out.some((o) => same(o, v))) out.push(v);
  return out.slice(0, VIA_CACHE.maxVias);
}

/** Route-learning trace of a completed driver trip (Douglas–Peucker ~30 m), or null if too short. */
export function traceOfTrip(trip: { id: string; endedAt: number; distanceM: number; points: LatLng[] }, cfg: CandidateConfig = CANDIDATES): RouteTrace | null {
  if (trip.points.length < 2 || trip.distanceM < cfg.endClearM) return null;
  return { tripId: trip.id, endedAt: trip.endedAt, distanceM: trip.distanceM, line: simplifyPolyline(trip.points.map((p) => ({ lat: p.lat, lng: p.lng })), cfg.learned.simplifyM) };
}

/**
 * Sibling exits: where a discovered sub-route leaves its parent, the neighbouring side roads (from the parent's
 * intersection bearings, within `junctionWindowM` before the divergence) heading the same way are often the
 * commonly-driven variant Directions never offers. Returns probe vias `junctionProbeM` down those side roads,
 * best first (closest heading to the sub-route's, then nearest).
 */
export function siblingExitVias(parent: NavRoute, sub: NavRoute, known: Footprint[], cfg: CandidateConfig = CANDIDATES): Via[] {
  const run = uncoveredRuns(sub.geometry, known, cfg)[0];
  if (!run || run.toM - run.fromM < cfg.minDivergenceM) return [];
  const q = pointAlong(sub.geometry, sub.cum, run.fromM);
  const subBearing = bearingDeg(q, pointAlong(sub.geometry, sub.cum, run.fromM + 150));
  const qAlong = projectOnPolyline(q, parent.geometry, parent.cum).alongM;
  const own = new Footprint(sub.geometry, cfg.gridM);
  const out: { via: Via; score: number }[] = [];
  for (const st of parent.steps) {
    if (st.endAlongM < qAlong - cfg.junctionWindowM || st.startAlongM > qAlong + 200) continue;
    for (const j of st.junctions ?? []) {
      const a = projectOnPolyline(j.location, parent.geometry, parent.cum).alongM;
      if (a < qAlong - cfg.junctionWindowM || a > qAlong + 200) continue;
      const dq = haversineM(j.location, q);
      for (const s of j.side) {
        if (Math.abs(angleDiffDeg(s, j.out)) < cfg.junctionMinTurnDeg) continue;
        const toSub = Math.abs(angleDiffDeg(s, subBearing));
        if (toSub > 90 || (dq < 60 && toSub < 25)) continue;
        const p = destination(j.location, s, cfg.junctionProbeM);
        if (own.covers(p) || known.some((f) => f.covers(p))) continue;
        out.push({ via: { lat: p.lat, lng: p.lng, bearing: s }, score: toSub + dq / 50 });
      }
    }
  }
  const vias: Via[] = [];
  for (const o of out.sort((a, b) => a.score - b.score)) if (!vias.some((v) => haversineM(v, o.via) < 40)) vias.push(o.via);
  return vias;
}
