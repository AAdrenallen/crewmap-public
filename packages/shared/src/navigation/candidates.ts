import { angleDiffDeg, bearingDeg, cumulativeDistances, destination, haversineM, pointAlong, projectOnPolyline, slicePolyline, type LatLng } from '../geo';
import { inQuebec } from './nameLang';
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
  /**
   * End zones: the first/last max(endClearM, endZoneFrac × length) (≤ endZoneMaxM) of a route are the streets everyone
   * takes to leave the origin / reach the door. Road driven there weighs `endZoneWeight` when naming a route, and a
   * route that differs from the kept ones only there is kept only after every route that differs mid-route.
   */
  endZoneFrac: 0.1,
  endZoneMaxM: 8000,
  endZoneWeight: 0.2,
  /** Routes that differ from the kept ones only in an end zone: at most this many are shown. */
  maxEndVariants: 1,
  /** A second "corridor" road joins the label when it carries ≥ this share of the route and is a numbered / major road. */
  labelContextFrac: 0.15,
  /** Naming weight per Mapbox Streets class (numbered roads without a class weigh like primary). */
  classWeight: { motorway: 3, trunk: 2.5, primary: 2, secondary: 1.5, tertiary: 1, street: 0.6, street_limited: 0.5, service: 0.3, track: 0.3 } as Record<string, number>,
  /** A plausible route with at least this motorway/trunk share keeps a slot (siblings of one corridor never crowd it out). */
  highwaySlotShare: 0.4,
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
    /**
     * Ranking-only costs (s), never shown as ETA. Router speeds on local streets assume free flow between the few
     * controls it knows (driveways, parked cars, unmapped stops, pedestrians); collectors less so: s per km driven.
     * A left turn across traffic waits for a gap (HCM two-way-stop major-street left ≈ 5–10 s more than a right).
     */
    minorKmS: 10,
    tertiaryKmS: 4,
    leftTurnS: 5,
    /**
     * A right turn at a signal where right on red is banned (island of Montréal, D61) waits for the green: about half
     * a typical urban red (30–60 s cycles, HCM uniform delay) beyond what a router that allows RTOR assumes.
     */
    noRedRightS: 8,
    /** A closed incident on the route (Mapbox `incidents[].closed`): never recommended while another route exists. */
    closedS: 3600,
    /** Motorway-heavy routes stay eligible this much longer (× motorway share): steadier, fewer surprises. */
    fastBandS: 120,
    /** Tags: "fewer turns" needs this many fewer turns + controls than the next route; "shortest" ≥ this share shorter. */
    fewerTurnsMin: 4,
    shorterFrac: 0.05,
    /** "Highway" tag: motorway/trunk share at least this, and the most of all routes. */
    highwayTagShare: 0.5,
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
/** `probe`: a corridor probe (point exclusion on the fastest route, or "stay on the motorway" via). */
export type CandidateSource = 'base' | 'split' | 'learned' | 'cache' | 'probe';

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
/** Short facts shown on a route card (set by `recommend`, only where they tell the routes apart). */
export type RouteTag = 'fastest' | 'highway' | 'fewerTurns' | 'noTolls' | 'shortest';

export interface RouteCandidate extends FoundRoute {
  label: RouteLabel;
  /** Expected time (s): (live + control allowance) × learned correction. Set by `recommend`. */
  expectedS?: number;
  /** Ranking cost (s): expectedS + road-class, left-turn and hazard penalties. Set by `recommend`. */
  costS?: number;
  tags?: RouteTag[];
  /** Live time minus the fastest candidate's (s, ≥ 0). */
  deltaS?: number;
  badge?: RouteBadge | null;
  /** Minutes the live time is notably above typical (0 = not notable). */
  overUsualMin?: number;
  /** Past drives of this route behind `expectedS`. */
  samples?: number;
}

// --- geometry ---------------------------------------------------------------------------------------------------------

const M_PER_DEG = 111_195;

/** Points every `stepM` along a polyline (always includes both ends). Single-pass O(N) walk. */
export function resample(line: LatLng[], stepM: number): LatLng[] {
  if (line.length < 2) return line.slice();
  const cum = cumulativeDistances(line);
  const total = cum[cum.length - 1]!;
  const out: LatLng[] = [];
  let idx = 0;
  for (let a = 0; a < total; a += stepM) {
    while (idx + 1 < line.length - 1 && cum[idx + 1]! <= a) idx++;
    const seg = cum[idx + 1]! - cum[idx]!;
    const f = seg > 0 ? Math.min(1, Math.max(0, (a - cum[idx]!) / seg)) : 0;
    const p0 = line[idx]!;
    const p1 = line[idx + 1]!;
    out.push({ lat: p0.lat + (p1.lat - p0.lat) * f, lng: p0.lng + (p1.lng - p0.lng) * f });
  }
  out.push(line[line.length - 1]!);
  return out;
}

function cellOf(p: LatLng, gridM: number): [number, number] {
  return [Math.floor((p.lat * M_PER_DEG) / gridM), Math.floor((p.lng * M_PER_DEG * Math.cos((p.lat * Math.PI) / 180)) / gridM)];
}

/** Grid footprint of a polyline, for fast "is this point on that route" tests. */
export class Footprint {
  private readonly cells = new Set<string>();
  readonly pts: LatLng[];
  readonly lengthM: number;
  constructor(line: LatLng[], readonly gridM: number = CANDIDATES.gridM) {
    this.lengthM = polylineLengthM(line);
    this.pts = resample(line, gridM / 2);
    for (const p of this.pts) {
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

/** WeakMap-backed footprint cache per polyline array & grid size (GC-safe, avoids rebuilding footprints in O(N²) loops). */
const fpCache = new WeakMap<LatLng[], Map<number, Footprint>>();

function cachedFootprint(line: LatLng[], gridM: number): Footprint {
  let byGrid = fpCache.get(line);
  if (!byGrid) {
    byGrid = new Map();
    fpCache.set(line, byGrid);
  }
  let fp = byGrid.get(gridM);
  if (!fp) {
    fp = new Footprint(line, gridM);
    byGrid.set(gridM, fp);
  }
  return fp;
}

/** Length (m) of `line` that lies on any of `others`. */
export function coveredLengthM(line: LatLng[], others: Footprint[], gridM: number = CANDIDATES.gridM): number {
  const step = gridM / 2;
  const self = cachedFootprint(line, gridM);
  let n = 0;
  for (const p of self.pts) if (others.some((f) => f.covers(p))) n++;
  return Math.min(n * step, self.lengthM);
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
  const fa = cachedFootprint(a, cfg.gridM);
  const fb = cachedFootprint(b, cfg.gridM);
  const step = cfg.gridM / 2;
  let na = 0;
  for (const p of fa.pts) if (fb.covers(p)) na++;
  const sa = Math.min(na * step, fa.lengthM);
  let nb = 0;
  for (const p of fb.pts) if (fa.covers(p)) nb++;
  const sb = Math.min(nb * step, fb.lengthM);
  const shared = Math.min(sa, sb);
  const shorter = Math.min(fa.lengthM, fb.lengthM);
  return { ratio: shorter > 0 ? shared / shorter : 1, uniqueA: fa.lengthM - sa, uniqueB: fb.lengthM - sb };
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
  const rank: Record<CandidateSource, number> = { base: 0, learned: 1, probe: 1, cache: 2, split: 3 };
  const rest = plausible.filter((f) => f !== fastest).sort((a, b) => rank[a.source] - rank[b.source] || byTime(a, b));
  // The quickest motorway-heavy route keeps a slot right after the fastest (siblings of one corridor can't crowd it out).
  const highway = fastShare(fastest.route) >= cfg.highwaySlotShare ? undefined : [...rest].filter((f) => fastShare(f.route) >= cfg.highwaySlotShare).sort(byTime)[0];
  const order = [fastest, ...(highway ? [highway] : []), ...rest.filter((f) => f !== highway)];
  const kept: FoundRoute[] = [];
  // Pass 1: routes that differ mid-route (other corridors); pass 2: at most `maxEndVariants` that differ only near an end.
  for (const f of order) {
    if (kept.length >= cfg.maxRoutes) break;
    if (kept.every((k) => isDistinct(k.route.geometry, f.route.geometry, cfg) && isMidDistinct(k.route.geometry, f.route.geometry, cfg))) kept.push(f);
  }
  let endVariants = 0;
  for (const f of order) {
    if (kept.length >= cfg.maxRoutes || endVariants >= cfg.maxEndVariants) break;
    if (!kept.includes(f) && kept.every((k) => isDistinct(k.route.geometry, f.route.geometry, cfg))) {
      kept.push(f);
      endVariants++;
    }
  }
  return kept.sort(byTime);
}

/** Share of a route on motorway/trunk roads (0 without road-class data). */
export function fastShare(r: NavRoute): number {
  return r.controls && r.distanceM > 0 ? Math.min(1, r.controls.fastRoadM / r.distanceM) : 0;
}

/** Length of each end zone of a route (m). */
export function endZoneM(lengthM: number, cfg: CandidateConfig = CANDIDATES): number {
  return Math.min(cfg.endZoneMaxM, Math.max(cfg.endClearM, cfg.endZoneFrac * lengthM));
}

function midSlice(line: LatLng[], cfg: CandidateConfig): LatLng[] {
  const cum = cumulativeDistances(line);
  const total = cum[cum.length - 1] ?? 0;
  const z = endZoneM(total, cfg);
  return total > 2 * z ? slicePolyline(line, cum, z, total - z) : [];
}

/** Distinct on the middle of the routes (end zones ignored): another corridor, not just another last street. */
export function isMidDistinct(a: LatLng[], b: LatLng[], cfg: CandidateConfig = CANDIDATES): boolean {
  const ma = midSlice(a, cfg);
  const mb = midSlice(b, cfg);
  if (ma.length < 2 || mb.length < 2) return isDistinct(a, b, cfg);
  const la = polylineLengthM(ma);
  const lb = polylineLengthM(mb);
  const ua = la - coveredLengthM(ma, [new Footprint(b, cfg.gridM)], cfg.gridM);
  const ub = lb - coveredLengthM(mb, [new Footprint(a, cfg.gridM)], cfg.gridM);
  const shorter = Math.min(la, lb);
  const ratio = shorter > 0 ? Math.min(la - ua, lb - ub) / shorter : 1;
  const need = Math.max(cfg.minUniqueM, cfg.minUniqueFrac * Math.min(polylineLengthM(a), polylineLengthM(b)));
  return ratio < cfg.distinctOverlap || (ua >= need && ub >= need);
}

// --- labels -----------------------------------------------------------------------------------------------------------

export interface RoadUse {
  /** Normalised ref ("15", direction suffix dropped) or the road name. */
  key: string;
  lengthM: number;
  /** Length weighted for naming: mid-route road counts fully, end-zone road × `endZoneWeight`. */
  effM: number;
  isRef: boolean;
  /** Class of the longest step on this road (Mapbox Streets v8), if known. */
  cls?: string;
  firstAlongM: number;
  /** Where the road is first entered (for local ref styles). */
  at: LatLng;
}

/** Name → refs over a set of routes: a ref-less step of a numbered highway inherits the ref another step carries. */
export function refsByName(routes: NavRoute[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of routes) for (const s of r.steps) if (s.name && s.ref && !out.has(s.name)) out.set(s.name, refs(s.ref));
  return out;
}

/** Road keys of a step: its refs ("148", "15"; a concurrent "50;148" gives both), else its name. */
function stepKeys(route: NavRoute, refOfName: Map<string, string[]> = refsByName([route])): { keys: string[]; isRef: boolean }[] {
  return route.steps.map((s) => {
    if (s.ref) return { keys: refs(s.ref), isRef: true };
    const inherited = s.name ? refOfName.get(s.name) : undefined;
    if (inherited) return { keys: inherited, isRef: true };
    return { keys: s.name ? [s.name] : [], isRef: false };
  });
}

/** Mid-route share of [a, b] along a route of length `total` (end zones excluded). */
function midShare(a: number, b: number, total: number, cfg: CandidateConfig): number {
  const z = endZoneM(total, cfg);
  const len = b - a;
  if (len <= 0) return 0;
  return Math.max(0, Math.min(b, total - z) - Math.max(a, z)) / len;
}

/** Roads in driving order, merged across steps (a ref-less step of a named highway inherits its ref). */
export function roadsOf(route: NavRoute, refOfName?: Map<string, string[]>, cfg: CandidateConfig = CANDIDATES): RoadUse[] {
  const out: RoadUse[] = [];
  const byKey = new Map<string, RoadUse & { clsM: number }>();
  const total = route.cum[route.cum.length - 1] ?? route.distanceM;
  stepKeys(route, refOfName).forEach(({ keys, isRef }, i) => {
    const s = route.steps[i]!;
    const mid = midShare(s.startAlongM, s.endAlongM, total, cfg);
    const eff = s.distanceM * (mid + (1 - mid) * cfg.endZoneWeight);
    for (const key of keys) {
      let u = byKey.get(key);
      if (!u) {
        u = { key, lengthM: 0, effM: 0, isRef, firstAlongM: s.startAlongM, at: s.maneuver.location, clsM: -1 };
        byKey.set(key, u);
        out.push(u);
      }
      u.lengthM += s.distanceM;
      u.effM += eff;
      if (s.roadClass && s.distanceM > u.clsM) {
        u.cls = s.roadClass;
        u.clsM = s.distanceM;
      }
    }
  });
  return out.map((u) => {
    const { clsM: _c, ...rest } = byKey.get(u.key)!;
    return rest;
  });
}

function refs(ref: string): string[] {
  return ref.split(';').map(normRef).filter(Boolean);
}

/** "20-O", "40 E", "15 Nord" → the number; direction suffixes would split one highway into two roads. */
export function normRef(ref: string): string {
  return ref.trim().replace(/[\s-]+(N|S|E|O|W|NORD|SUD|EST|OUEST|NORTH|SOUTH|EAST|WEST)$/i, '');
}

/**
 * How a driver says a numbered road: in Québec "A-15" (autoroutes 1–99 and 400+) and "R-148" (routes 100–399);
 * elsewhere the ref as published (it is already local, e.g. "I 87", "417", "CR 17").
 */
export function displayRef(ref: string, at: LatLng | null): string {
  const r = normRef(ref);
  if (!/^\d{1,3}[A-Z]?$/.test(r) || !at || !inQuebec(at.lat, at.lng)) return r;
  const n = parseInt(r, 10);
  return n < 100 || n >= 400 ? `A-${r}` : `R-${r}`;
}

function roadWeight(road: RoadUse, cfg: CandidateConfig): number {
  if (road.cls && cfg.classWeight[road.cls] !== undefined) return cfg.classWeight[road.cls]!;
  return road.isRef ? cfg.classWeight.primary! : 1;
}

const MAJOR = new Set(['motorway', 'trunk', 'primary']);

/**
 * Names each candidate by the road(s) that tell it apart: per (route, road), the length of that road not shared
 * with the *closest* other candidate (the minimum over the others, measured on the geometry), weighted by road class
 * and by where it lies (end-zone streets weigh little). Pairs are assigned best-first, one road per route and one
 * route per road. A numbered / major road carrying ≥ `labelContextFrac` of the route joins as corridor context
 * ("A-15, Montée Nord"), in driving order. A lone route gets its main road; nothing distinctive gives a letter.
 */
export function labelCandidates(found: FoundRoute[], cfg: CandidateConfig = CANDIDATES): RouteCandidate[] {
  const prints = found.map((f) => new Footprint(f.route.geometry, cfg.gridM));
  const names = refsByName(found.map((f) => f.route));
  const pairs: { i: number; key: string; w: number }[] = [];
  const roads = found.map((f) => roadsOf(f.route, names, cfg));
  const distinct: RoadUse[][] = [];
  // End-only twins (same corridor, other last streets): the faster one is named by its corridor, so it ignores its
  // slower twins; only the slower twin is told apart by its end roads.
  const twin = found.map((a, i) =>
    found.map((b, j) => i !== j && isDistinct(a.route.geometry, b.route.geometry, cfg) && !isMidDistinct(a.route.geometry, b.route.geometry, cfg)),
  );
  const slowerTwin = (i: number, j: number) => {
    const di = found[i]!.route.durationS;
    const dj = found[j]!.route.durationS;
    return twin[i]![j]! && (dj > di || (dj === di && j > i));
  };
  found.forEach((f, i) => {
    const r = f.route;
    const total = r.cum[r.cum.length - 1] ?? r.distanceM;
    // Per road: unique length (raw, for the "is it distinctive" test) and weighted by where it lies (for scoring).
    const unique = new Map<string, { raw: number; eff: number }>();
    const keys = stepKeys(r, names);
    r.steps.forEach((s, si) => {
      if (keys[si]!.keys.length === 0 || s.endAlongM - s.startAlongM < 1) return;
      const line = slicePolyline(r.geometry, r.cum, s.startAlongM, s.endAlongM);
      const len = s.endAlongM - s.startAlongM;
      let u = len;
      prints.forEach((p, j) => {
        if (j !== i && !slowerTwin(i, j)) u = Math.min(u, len - coveredLengthM(line, [p], cfg.gridM));
      });
      const mid = midShare(s.startAlongM, s.endAlongM, total, cfg);
      for (const k of keys[si]!.keys) {
        const cur = unique.get(k) ?? { raw: 0, eff: 0 };
        unique.set(k, { raw: cur.raw + u, eff: cur.eff + u * (mid + (1 - mid) * cfg.endZoneWeight) });
      }
    });
    const mine = roads[i]!
      .map((road) => ({ road, u: unique.get(road.key) ?? { raw: 0, eff: 0 } }))
      .filter(({ road, u }) => road.lengthM >= cfg.labelRoadM && u.raw > 0 && u.raw >= Math.min(cfg.labelDiffM, road.lengthM))
      .map(({ road, u }) => ({ road, s: u.eff * roadWeight(road, cfg) }));
    const maxS = Math.max(0, ...mine.map((m) => m.s));
    distinct[i] = [...mine].sort((a, b) => b.s - a.s).map((m) => m.road);
    mine.forEach(({ road, s }, order) => pairs.push({ i, key: road.key, w: s >= maxS * cfg.labelFirstFrac ? maxS - order * 1e-3 : s }));
  });
  pairs.sort((a, b) => b.w - a.w);
  const byRoute = new Map<number, string>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (byRoute.has(p.i) || used.has(p.key)) continue;
    byRoute.set(p.i, p.key);
    used.add(p.key);
  }
  // Texts are unique: each route takes the first option nobody has, in assignment order (strongest first).
  const texts = new Set<string>();
  const text = (parts: RoadUse[]) => [...parts].sort((a, b) => a.firstAlongM - b.firstAlongM).map((p) => (p.isRef ? displayRef(p.key, p.at) : p.key)).join(', ');
  const score = (r: RoadUse) => r.effM * roadWeight(r, cfg);
  const corridor = (i: number, not: string) =>
    roads[i]!.filter((r) => r.key !== not && (r.isRef || MAJOR.has(r.cls ?? '')) && r.effM >= cfg.labelRoadM).sort((a, b) => score(b) - score(a));
  const labels = new Map<number, string>();
  const take = (i: number, options: RoadUse[][]) => {
    for (const o of options) {
      const t = text(o);
      if (!texts.has(t)) {
        texts.add(t);
        labels.set(i, t);
        return;
      }
    }
  };
  for (const [i, key] of byRoute) {
    const primary = roads[i]!.find((r) => r.key === key)!;
    const minCtx = Math.max(cfg.labelRoadM, cfg.labelContextFrac * found[i]!.route.distanceM);
    const ctx = corridor(i, key);
    const strong = ctx.filter((c) => c.effM >= minCtx);
    take(i, [...strong.map((c) => [primary, c]), [primary], ...ctx.filter((c) => !strong.includes(c)).map((c) => [primary, c])]);
  }
  // No road of its own (e.g. differs only by roads another label took): its distinctive roads with corridor context,
  // then its two main corridor roads.
  found.forEach((_, i) => {
    if (labels.has(i)) return;
    const opts: RoadUse[][] = [];
    for (const d of distinct[i] ?? []) for (const c of corridor(i, d.key)) opts.push([d, c]);
    const main = corridor(i, '');
    for (let a = 0; a < main.length; a++) for (let b = a + 1; b < main.length; b++) opts.push([main[a]!, main[b]!]);
    take(i, opts);
  });
  let letter = 0;
  return found.map((f, i) => {
    const road = labels.get(i);
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
  const directM = haversineM(from, to);
  const tol = Math.min(Math.max(cfg.learned.endpointM, cfg.learned.endpointFrac * lengthM), Math.max(150, directM * 0.4));
  const dStart = haversineM(a, from);
  const dEnd = haversineM(b, to);
  if (dStart > tol || dEnd > tol) return false;
  // Never match a trace driven in the opposite direction (B→A) for an A→B search on short local trips.
  return dStart + dEnd < haversineM(a, to) + haversineM(b, from);
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
