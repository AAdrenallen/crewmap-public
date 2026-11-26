import type { LatLng } from '../geo';
import { CANDIDATES, endpointsMatch, overlap, simplifyPolyline, type CandidateConfig, type FoundRoute, type LearnedRoute, type RouteCandidate, type RouteTrace } from './candidates';
import type { NavRoute } from './route';

/**
 * Which candidate to recommend (pure): expected time with a control-delay allowance, a tie band inside which the
 * most predictable route wins, and a per-route correction learned from the driver's own drives (on-device only).
 * Tunables: `CANDIDATES.recommend`.
 */
type RecommendConfig = CandidateConfig['recommend'];

/** Control-delay allowance (s) for a route's signals, stops, yields and turns. */
export function controlDelayS(route: NavRoute, rc: RecommendConfig = CANDIDATES.recommend): number {
  const c = route.controls;
  if (!c) return 0;
  return c.signals * rc.signalS + c.stops * rc.stopS + c.yields * rc.yieldS + c.turns * rc.turnS;
}

/**
 * Typical duration for routes without one (via-waypoint queries can come back with `duration_typical: null`): live × typical/live
 * of the most-overlapping route that has it. Zero extra API calls (the 8-call budget is already spent on discovery);
 * marked `typicalEstimated`.
 */
export function fillTypical(found: FoundRoute[], cfg: CandidateConfig = CANDIDATES): void {
  const refs = found.filter((f) => f.route.typicalDurationS !== undefined && !f.route.typicalEstimated && f.route.durationS > 0);
  if (refs.length === 0) return;
  for (const f of found) {
    if (f.route.typicalDurationS !== undefined) continue;
    let best = refs[0]!;
    let bestO = -1;
    for (const r of refs) {
      const o = overlap(f.route.geometry, r.route.geometry, cfg).ratio;
      if (o > bestO) {
        bestO = o;
        best = r;
      }
    }
    f.route.typicalDurationS = f.route.durationS * (best.route.typicalDurationS! / best.route.durationS);
    f.route.typicalEstimated = true;
  }
}

/** A completed drive of a previewed route: actual vs predicted (live + allowance, before correction). */
export interface DriveSample {
  line: LatLng[];
  bucket: number;
  predictedS: number;
  actualS: number;
  at: number;
}

/** Time-of-week bucket (local time): weekday/weekend × night, AM peak, midday, PM peak, evening. */
export function timeBucket(ms: number): number {
  const d = new Date(ms);
  const h = d.getHours();
  const slot = h < 6 ? 0 : h < 10 ? 1 : h < 15 ? 2 : h < 19 ? 3 : 4;
  return (d.getDay() === 0 || d.getDay() === 6 ? 5 : 0) + slot;
}

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

/**
 * Correction for a route from past drives that followed it (≥ clusterOverlap): median actual/predicted in the same
 * time-of-week bucket (all buckets when that one is empty), shrunk toward 1 by n/(n + priorN), clamped.
 */
export function correctionFactor(route: NavRoute, samples: DriveSample[], bucket: number, cfg: CandidateConfig = CANDIDATES): { factor: number; n: number } {
  const rc = cfg.recommend;
  const mine = samples.filter((s) => s.predictedS > 0 && s.line.length >= 2 && overlap(s.line, route.geometry, cfg).ratio >= cfg.learned.clusterOverlap);
  const same = mine.filter((s) => s.bucket === bucket);
  const use = same.length > 0 ? same : mine;
  if (use.length === 0) return { factor: 1, n: 0 };
  const m = median(use.map((s) => s.actualS / s.predictedS));
  const w = use.length / (use.length + rc.priorN);
  return { factor: Math.min(rc.maxFactor, Math.max(rc.minFactor, 1 + (m - 1) * w)), n: use.length };
}

function habitOf(route: NavRoute, learned: LearnedRoute[], cfg: CandidateConfig): number {
  let n = 0;
  for (const l of learned) if (overlap(l.line, route.geometry, cfg).ratio >= cfg.learned.clusterOverlap) n = Math.max(n, l.count);
  return n;
}

export interface RecommendInput {
  learned: LearnedRoute[];
  samples: DriveSample[];
  now: number;
}

/**
 *  - expectedS = (live + control allowance) × learned correction;
 *  - routes within max(tieMinS, tieFrac × best) of the best expectedS are equivalent; among them the lowest
 *    predictability penalty wins: allowance − motorway/trunk share × fastShareS − habit trips × habitS;
 *  - "recommended" on the pick; "fastestNow" on another route only if its live time beats the pick's by more than
 *    the tie band. Output: the pick first, then by expectedS.
 */
export function recommend(cands: RouteCandidate[], input: RecommendInput, cfg: CandidateConfig = CANDIDATES): RouteCandidate[] {
  if (cands.length === 0) return [];
  const rc = cfg.recommend;
  const bucket = timeBucket(input.now);
  const scored = cands.map((c) => {
    const r = c.route;
    const ctl = controlDelayS(r, rc);
    const { factor, n } = correctionFactor(r, input.samples, bucket, cfg);
    const habit = Math.min(rc.habitCap, habitOf(r, input.learned, cfg));
    const fastShare = r.controls && r.distanceM > 0 ? r.controls.fastRoadM / r.distanceM : 0;
    const typical = r.typicalDurationS;
    const over = typical !== undefined && typical > r.durationS * 0.5 ? r.durationS - typical : 0;
    const overUsualMin = typical !== undefined && over >= Math.max(rc.overUsualMinS, rc.overUsualFrac * typical) ? Math.round(over / 60) : 0;
    const out: RouteCandidate = { ...c, expectedS: (r.durationS + ctl) * factor, samples: n, overUsualMin, badge: null };
    return { c: out, e: out.expectedS!, tie: ctl - fastShare * rc.fastShareS - habit * rc.habitS };
  });
  const best = Math.min(...scored.map((s) => s.e));
  const band = Math.max(rc.tieMinS, rc.tieFrac * best);
  const pick = scored.filter((s) => s.e <= best + band).sort((a, b) => a.tie - b.tie || a.e - b.e)[0]!;
  pick.c.badge = 'recommended';
  const fastest = [...scored].sort((a, b) => a.c.route.durationS - b.c.route.durationS)[0]!;
  if (fastest !== pick && fastest.c.route.durationS < pick.c.route.durationS - band) fastest.c.badge = 'fastestNow';
  return [pick.c, ...scored.filter((s) => s !== pick).sort((a, b) => a.e - b.e).map((s) => s.c)];
}

/** What a preview remembers so the trip that follows can be scored against it. */
export interface PreviewRecord {
  at: number;
  from: LatLng;
  to: LatLng;
  routes: { line: LatLng[]; predictedS: number }[];
}

export function previewRecord(cands: RouteCandidate[], from: LatLng, to: LatLng, at: number, cfg: CandidateConfig = CANDIDATES): PreviewRecord {
  return {
    at,
    from: { lat: from.lat, lng: from.lng },
    to: { lat: to.lat, lng: to.lng },
    routes: cands.map((c) => ({ line: simplifyPolyline(c.route.geometry, cfg.learned.simplifyM), predictedS: c.route.durationS + controlDelayS(c.route, cfg.recommend) })),
  };
}

/**
 * A drive sample when a driver trip started within `previewWindowMs` of a preview, went from its origin to its
 * destination and followed one of its routes (≥ clusterOverlap). Null otherwise.
 */
export function driveSample(trace: RouteTrace, startedAt: number, preview: PreviewRecord | null, cfg: CandidateConfig = CANDIDATES): DriveSample | null {
  if (!preview || Math.abs(startedAt - preview.at) > cfg.recommend.previewWindowMs || trace.line.length < 2) return null;
  if (!endpointsMatch(trace.line[0]!, trace.line[trace.line.length - 1]!, preview.from, preview.to, trace.distanceM, cfg)) return null;
  let best: PreviewRecord['routes'][number] | null = null;
  let bestO = cfg.learned.clusterOverlap;
  for (const r of preview.routes) {
    const o = overlap(trace.line, r.line, cfg).ratio;
    if (o >= bestO) {
      bestO = o;
      best = r;
    }
  }
  const actualS = (trace.endedAt - startedAt) / 1000;
  if (!best || actualS <= 0) return null;
  return { line: best.line, bucket: timeBucket(startedAt), predictedS: best.predictedS, actualS, at: trace.endedAt };
}

/** Appends a sample, keeping the newest `maxSamples`. */
export function addDriveSample(samples: DriveSample[], s: DriveSample, cfg: CandidateConfig = CANDIDATES): DriveSample[] {
  return [...samples, s].sort((a, b) => a.at - b.at).slice(-cfg.recommend.maxSamples);
}
