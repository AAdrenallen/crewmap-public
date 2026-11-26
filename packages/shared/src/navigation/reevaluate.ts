import type { LatLng } from '../geo';
import { CANDIDATES, overlap, polylineLengthM, resample, type CandidateConfig, type RouteCandidate } from './candidates';
import type { RouteQuery } from './discovery';
import { recommend, type RecommendInput } from './recommend';
import type { NavRoute, RouteExclude } from './route';

/**
 * Continuous "best route for the moment" while navigating (D43). Pure: the app supplies Directions responses and the
 * clock. A check costs one Directions call (alternatives from here) plus, only when none of the returned routes is
 * the one being driven, one silent-via call to get the current route's fresh remaining time.
 */
export const REEVAL = {
  /** Interval between checks with free-flowing traffic ahead, and with a jam / incident / closure ahead. */
  calmIntervalMs: 5 * 60_000,
  busyIntervalMs: 2 * 60_000,
  /** Event triggers (new incident or jam on the corridor) never check more often than this. */
  minGapMs: 90_000,
  /** No check right after starting (the preview just ran discovery). */
  startDelayMs: 2 * 60_000,
  /** Hard cap per trip (cost guard: 40 checks ≈ 80 calls at worst). */
  maxPerTrip: 40,
  /** Not worth it this close to the destination. */
  minRemainingS: 5 * 60,
  minRemainingM: 2000,
  /** An alternative must save more than max(saveMinS, saveFrac × current remaining). */
  saveMinS: 120,
  saveFrac: 0.08,
  /** A saving this many times the threshold is offered on the first check; smaller ones must hold for two checks. */
  strongFactor: 2,
  /** Offer auto-dismiss, and how long a dismissed alternative stays suppressed. */
  offerTtlMs: 20_000,
  dismissSuppressMs: 10 * 60_000,
  /** A returned route "is" the current route when this much of the remaining geometry is shared. */
  matchOverlap: 0.9,
  /** Same alternative across checks / dismissals. */
  sameAltOverlap: 0.8,
  /** Silent vias sampled along the remaining current route for the second call. */
  vias: 3,
  viaRadiusM: 30,
  /** Jam detection on the remaining route: look this far ahead; congestion_numeric ≥ jamNumeric (or heavy/severe). */
  lookAheadM: 8000,
  jamNumeric: 60,
  jamMinM: 300,
  /** Live speed below this share of the posted limit also counts as a jam (when there is no congestion value). */
  slowShare: 0.4,
};
export type ReevalConfig = typeof REEVAL;

/** Remaining geometry from an along-route position. */
export function remainingLine(route: NavRoute, alongM: number): LatLng[] {
  const g = route.geometry;
  let i = 0;
  while (i < route.cum.length - 1 && route.cum[i + 1]! <= alongM) i++;
  const a = g[i]!;
  const b = g[i + 1];
  if (!b) return [a];
  const seg = route.cum[i + 1]! - route.cum[i]!;
  const f = seg > 0 ? Math.min(1, Math.max(0, (alongM - route.cum[i]!) / seg)) : 0;
  return [{ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f }, ...g.slice(i + 1)];
}

export interface JamAhead {
  /** Congested length ahead within the look-ahead (m). */
  jamM: number;
  /** Distance to the first congested segment (m), null if none. */
  firstAtM: number | null;
  /** A closed or congesting incident ahead on the route. */
  incident: boolean;
}

/** Congestion and incidents ahead on a route (from its own annotations: only fresh right after a Directions call). */
export function jamAhead(route: NavRoute, alongM: number, cfg: ReevalConfig = REEVAL): JamAhead {
  let jamM = 0;
  let firstAtM: number | null = null;
  const end = alongM + cfg.lookAheadM;
  for (let i = 0; i < route.cum.length - 1; i++) {
    const s = route.cum[i]!;
    const e = route.cum[i + 1]!;
    if (e <= alongM) continue;
    if (s >= end) break;
    const n = route.congestionNumeric?.[i];
    const c = route.congestion[i];
    const v = route.segSpeedKph?.[i];
    const lim = route.maxspeedKph[i];
    const jam =
      n !== undefined && n !== null
        ? n >= cfg.jamNumeric
        : c === 'heavy' || c === 'severe' || (v !== undefined && v !== null && lim !== null && lim !== undefined && v < lim * cfg.slowShare);
    if (!jam) continue;
    jamM += Math.min(e, end) - Math.max(s, alongM);
    if (firstAtM === null) firstAtM = Math.max(0, s - alongM);
  }
  const incident = route.incidents.some((x) => x.endAlongM > alongM && x.startAlongM < end && (x.closed || (x.congestion ?? 0) >= cfg.jamNumeric));
  return { jamM, firstAtM: jamM >= cfg.jamMinM ? firstAtM : null, incident };
}

export const isBusy = (j: JamAhead, cfg: ReevalConfig = REEVAL): boolean => j.incident || j.jamM >= cfg.jamMinM;

/** Live remaining time on a route from its per-segment durations (falls back to a distance share). */
export function remainingS(route: NavRoute, alongM: number): number {
  const d = route.segDurationS;
  if (!d || d.length !== route.cum.length - 1) return route.distanceM > 0 ? route.durationS * Math.max(0, 1 - alongM / route.distanceM) : 0;
  let s = 0;
  for (let i = 0; i < d.length; i++) {
    const a = route.cum[i]!;
    const b = route.cum[i + 1]!;
    if (b <= alongM) continue;
    s += a >= alongM ? d[i]! : (d[i]! * (b - alongM)) / Math.max(1e-6, b - a);
  }
  return s;
}

export type ReevalTrigger = 'timer' | 'incident' | 'jam';

export interface ReevalClock {
  startedAt: number;
  lastCheckAt: number | null;
  checks: number;
  /** Traffic ahead at the last check (sets the next interval). */
  busy: boolean;
}

/** Whether to run a check now. */
export function shouldCheck(c: ReevalClock, now: number, trigger: ReevalTrigger, remaining: { s: number; m: number }, cfg: ReevalConfig = REEVAL): boolean {
  if (c.checks >= cfg.maxPerTrip) return false;
  if (now - c.startedAt < cfg.startDelayMs) return false;
  if (remaining.s < cfg.minRemainingS || remaining.m < cfg.minRemainingM) return false;
  if (c.lastCheckAt === null) return trigger !== 'timer' || now - c.startedAt >= cfg.startDelayMs;
  const since = now - c.lastCheckAt;
  if (trigger !== 'timer') return since >= cfg.minGapMs;
  return since >= (c.busy ? cfg.busyIntervalMs : cfg.calmIntervalMs);
}

/** The silent-via query that prices the remaining current route (second call, only when needed). */
export function currentRouteQuery(rest: LatLng[], heading: number | null, exclude: RouteExclude[], cfg: ReevalConfig = REEVAL): RouteQuery | null {
  if (rest.length < 2) return null;
  const len = polylineLengthM(rest);
  const pts = resample(rest, Math.max(200, len / (cfg.vias + 1)));
  const vias = pts.slice(1, -1).slice(0, cfg.vias);
  const coords = [rest[0]!, ...vias, rest[rest.length - 1]!];
  return {
    coordinates: coords,
    alternatives: false,
    bearings: coords.map((_, i) => (i === 0 && heading !== null ? { deg: heading, range: 45 } : null)),
    radiuses: coords.map((_, i) => (i === 0 || i === coords.length - 1 ? null : cfg.viaRadiusM)),
    ...(exclude.length ? { exclude } : {}),
  };
}

/** Of the fresh routes, the one that follows the remaining current route, if any. */
export function matchCurrent(fresh: NavRoute[], rest: LatLng[], cfg: ReevalConfig = REEVAL, cc: CandidateConfig = CANDIDATES): NavRoute | null {
  let best: NavRoute | null = null;
  let bestR = cfg.matchOverlap;
  for (const r of fresh) {
    const o = overlap(rest, r.geometry, cc);
    // Both ways: a fresh route that shares the remainder but adds a long detour is not the current route.
    const tol = Math.max(300, 0.05 * polylineLengthM(rest));
    if (o.ratio >= bestR && o.uniqueA <= tol && o.uniqueB <= tol) {
      bestR = o.ratio;
      best = r;
    }
  }
  return best;
}

export interface FasterOffer {
  route: NavRoute;
  savesS: number;
  /** Expected remaining time (s) of the current route and of the alternative (recommend.ts scoring). */
  currentS: number;
  altS: number;
  createdAt: number;
  expiresAt: number;
}

export interface ReevalMemory {
  /** Alternative seen better than the threshold at the previous check (needs to hold twice unless strong). */
  pending: { line: LatLng[]; savesS: number } | null;
  dismissed: { line: LatLng[]; until: number }[];
}

export const emptyMemory = (): ReevalMemory => ({ pending: null, dismissed: [] });

/**
 * Scores the current route (fresh) against the alternatives with `recommend` (control-delay allowance, learned
 * corrections, habit tie-break) and decides whether to offer a switch. Returns the offer (or null) and the next memory.
 */
export function decideFaster(
  current: NavRoute,
  alternatives: NavRoute[],
  input: RecommendInput,
  mem: ReevalMemory,
  cfg: ReevalConfig = REEVAL,
  cc: CandidateConfig = CANDIDATES,
): { offer: FasterOffer | null; memory: ReevalMemory } {
  const now = input.now;
  const dismissed = mem.dismissed.filter((d) => d.until > now);
  const label = { kind: 'letter', letter: '' } as const;
  const cands: RouteCandidate[] = [current, ...alternatives].map((route) => ({ route, source: 'base' as const, label }));
  const ranked = recommend(cands, input, cc);
  const cur = ranked.find((c) => c.route === current)!;
  const curS = cur.expectedS!;
  const threshold = Math.max(cfg.saveMinS, cfg.saveFrac * curS);
  // Never offer a route with a closure on it, or one the driver just dismissed.
  const ok = ranked.filter(
    (c) =>
      c.route !== current &&
      !c.route.incidents.some((x) => x.closed) &&
      !dismissed.some((d) => overlap(d.line, c.route.geometry, cc).ratio >= cfg.sameAltOverlap),
  );
  const best = ok.sort((a, b) => a.expectedS! - b.expectedS!)[0];
  const saves = best ? curS - best.expectedS! : 0;
  // `recommend` keeps the current route when the gain is inside its tie band and the current one is more predictable.
  if (!best || saves <= threshold || ranked[0]!.route === current) return { offer: null, memory: { pending: null, dismissed } };
  const held = mem.pending !== null && overlap(mem.pending.line, best.route.geometry, cc).ratio >= cfg.sameAltOverlap;
  if (!held && saves < cfg.strongFactor * threshold) return { offer: null, memory: { pending: { line: best.route.geometry, savesS: saves }, dismissed } };
  return {
    offer: { route: best.route, savesS: Math.round(saves), currentS: Math.round(curS), altS: Math.round(best.expectedS!), createdAt: now, expiresAt: now + cfg.offerTtlMs },
    memory: { pending: null, dismissed },
  };
}

/** Remember a dismissed alternative so the same one is not offered again for a while. */
export function dismiss(mem: ReevalMemory, offer: FasterOffer, now: number, cfg: ReevalConfig = REEVAL): ReevalMemory {
  return { pending: null, dismissed: [...mem.dismissed.filter((d) => d.until > now), { line: offer.route.geometry, until: now + cfg.dismissSuppressMs }] };
}

/**
 * Directions usage per active driver per month (cost guard, D43): `checks/h × (1 + p2) × hours`, where p2 is the share
 * of checks needing the silent-via call. With 1.5 h/day of navigation, 30 days, one check every ~3.5 min and p2 = 0.5:
 * ≈ 26 checks/h → ≈ 1 750 calls, plus previews (≤ 8 calls each) and off-route reroutes.
 */
export function monthlyDirectionsEstimate(navHoursPerDay: number, checkEveryMin: number, secondCallShare: number, previewsPerDay: number, reroutesPerDay: number, days = 30): number {
  const checks = (navHoursPerDay * 60) / checkEveryMin;
  return Math.round(days * (checks * (1 + secondCallShare) + previewsPerDay * 8 + reroutesPerDay));
}
