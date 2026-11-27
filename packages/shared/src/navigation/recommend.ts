import { haversineM, type LatLng } from '../geo';
import { CANDIDATES, endpointsMatch, fastShare, overlap, polylineLengthM, simplifyPolyline, type CandidateConfig, type FoundRoute, type LearnedRoute, type RouteCandidate, type RouteTag, type RouteTrace } from './candidates';
import { ETA_BIAS, crewPrior, fitClassModels, periodOf, routeBias, routeParts, type BiasObs, type ClassModels, type CrewBias } from './etaBias';
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
  /** Predicted seconds per road group (etaBias `routeParts`, scaled to predictedS); absent on older samples. */
  parts?: number[];
  /** Trip it came from (a habit drive of the same trip is not counted twice). */
  tripId?: string;
}

/** A past drive weighed against a route: actual / predicted, with a weight (preview drives 1, habit drives less). */
export interface RouteObs {
  ratio: number;
  w: number;
}

/** Time-of-week bucket (local time): weekday/weekend × night, AM peak, midday, PM peak, evening. */
export function timeBucket(ms: number): number {
  const d = new Date(ms);
  const h = d.getHours();
  const slot = h < 6 ? 0 : h < 10 ? 1 : h < 15 ? 2 : h < 19 ? 3 : 4;
  return (d.getDay() === 0 || d.getDay() === 6 ? 5 : 0) + slot;
}

/** Weighted median (equal weights: the plain median). */
function wMedian(xs: RouteObs[]): number {
  const a = [...xs].sort((x, y) => x.ratio - y.ratio);
  const tot = a.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (let i = 0; i < a.length; i++) {
    acc += a[i]!.w;
    if (Math.abs(acc - tot / 2) < 1e-9 && i + 1 < a.length) return (a[i]!.ratio + a[i + 1]!.ratio) / 2;
    if (acc > tot / 2) return a[i]!.ratio;
  }
  return a[a.length - 1]?.ratio ?? 1;
}

/**
 * Correction for a route from past drives that followed it (≥ clusterOverlap): weighted median actual/predicted in
 * the same time-of-week bucket (all buckets when that one is empty), plus `extra` drives already matched (habit drives
 * of this period), shrunk toward `target` (1, or the road-group model's factor for the route) by n/(n + priorN).
 */
export function correctionFactor(
  route: NavRoute,
  samples: DriveSample[],
  bucket: number,
  cfg: CandidateConfig = CANDIDATES,
  target = 1,
  extra: RouteObs[] = [],
): { factor: number; n: number } {
  const rc = cfg.recommend;
  const clampF = (f: number) => Math.min(rc.maxFactor, Math.max(rc.minFactor, f));
  const mine = samples.filter((s) => s.predictedS > 0 && s.line.length >= 2 && overlap(s.line, route.geometry, cfg).ratio >= cfg.learned.clusterOverlap);
  const same = mine.filter((s) => s.bucket === bucket);
  const use: RouteObs[] = [...(same.length > 0 ? same : mine).map((s) => ({ ratio: s.actualS / s.predictedS, w: 1 })), ...extra];
  const n = use.reduce((a, o) => a + o.w, 0);
  if (n <= 0) return { factor: clampF(target), n: 0 };
  const w = n / (n + rc.priorN);
  return { factor: clampF(target + (wMedian(use) - target) * w), n: Math.round(n * 10) / 10 };
}

/** A completed driver trip with its start time (habit drives: no preview needed). */
export interface TimedTrace extends RouteTrace {
  startedAt?: number;
}

/**
 * Habit drives: past trips along `route` (same O/D, ≥ clusterOverlap, length within habitLengthFrac) in the same
 * period (weekday peak / other), not already a preview sample, compared with the router's TYPICAL time for now
 * (+ control allowance): zero API calls, and most drives are never previewed. Weight `habitWeight` each (half again
 * when the typical time was itself estimated).
 */
export function habitObs(route: NavRoute, traces: TimedTrace[], ctlS: number, now: number, skipTrips: ReadonlySet<string>, cfg: CandidateConfig = CANDIDATES): { obs: RouteObs[]; bias: BiasObs[] } {
  const typical = route.typicalDurationS;
  const out: { obs: RouteObs[]; bias: BiasObs[] } = { obs: [], bias: [] };
  if (typical === undefined || typical <= 0 || route.geometry.length < 2) return out;
  const period = periodOf(timeBucket(now));
  const len = route.distanceM || polylineLengthM(route.geometry);
  const from = route.geometry[0]!;
  const to = route.geometry[route.geometry.length - 1]!;
  const predicted = typical + ctlS;
  const w = ETA_BIAS.habitWeight * (route.typicalEstimated ? 0.5 : 1);
  const parts = routeParts(route).map((p) => (p / Math.max(1, route.durationS)) * predicted);
  for (const t of traces) {
    if (t.startedAt === undefined || skipTrips.has(t.tripId) || t.line.length < 2) continue;
    if (Math.abs(t.distanceM - len) > ETA_BIAS.habitLengthFrac * len) continue;
    if (periodOf(timeBucket(t.startedAt)) !== period) continue;
    if (!endpointsMatch(t.line[0]!, t.line[t.line.length - 1]!, from, to, len, cfg)) continue;
    const actual = (t.endedAt - t.startedAt) / 1000;
    if (actual <= 0 || overlap(t.line, route.geometry, cfg).ratio < cfg.learned.clusterOverlap) continue;
    out.obs.push({ ratio: actual / predicted, w });
    out.bias.push({ parts, actualS: actual, period, w });
  }
  return out;
}

/** Road-group model observations from preview drive samples (those recorded with per-group parts). */
export function sampleObs(samples: DriveSample[]): BiasObs[] {
  return samples.flatMap((s) => (s.parts && s.parts.length === 4 && s.actualS > 0 ? [{ parts: s.parts, actualS: s.actualS, period: periodOf(s.bucket), w: 1 }] : []));
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
  /** Past driver trips with start times (habit drives vs the router's typical time); none = preview samples only. */
  traces?: TimedTrace[];
  /** Crewmates' road-group multipliers (shared aggregates): the prior my own drives refine. */
  crew?: CrewBias[];
  /** Precomputed road-group models (skips fitting them from samples / traces / crew). */
  models?: ClassModels;
  /**
   * Extra ranking cost (s) for hazards on a route (crashes, closures, works from the hazard feeds). Supplied by the app,
   * which owns the merged hazards (`packages/hazards` builds on this package, so it cannot be imported here).
   */
  hazardCostS?: (route: NavRoute) => number;
}

/** Ranking-only penalty (s): local / collector road length, left turns across traffic, signalised rights without right-on-red, closures. Never an ETA. */
export function roadPenaltyS(route: NavRoute, rc: RecommendConfig = CANDIDATES.recommend): number {
  const c = route.controls;
  const closed = route.incidents.some((x) => x.closed) ? rc.closedS : 0;
  if (!c) return closed;
  return ((c.minorRoadM ?? 0) / 1000) * rc.minorKmS + ((c.tertiaryRoadM ?? 0) / 1000) * rc.tertiaryKmS + (c.leftTurns ?? 0) * rc.leftTurnS + (c.noRedRightTurns ?? 0) * rc.noRedRightS + closed;
}

/** Road-group models for a recommendation: preview samples + habit drives of the candidates, crew multipliers as prior. */
export function classModelsFor(cands: RouteCandidate[], input: RecommendInput, cfg: CandidateConfig = CANDIDATES): ClassModels {
  if (input.models) return input.models;
  const obs = sampleObs(input.samples);
  const skip = new Set(input.samples.flatMap((s) => (s.tripId ? [s.tripId] : [])));
  const seen = new Set<string>();
  for (const c of cands) {
    if (seen.has(c.route.id)) continue;
    seen.add(c.route.id);
    obs.push(...habitObs(c.route, input.traces ?? [], controlDelayS(c.route, cfg.recommend), input.now, skip, cfg).bias);
  }
  const crew = input.crew ?? [];
  return fitClassModels(obs, crew.length ? { peak: crewPrior(crew, 'peak'), other: crewPrior(crew, 'other') } : undefined);
}

/**
 *  - expectedS = (live + control allowance) × learned correction (what the trip should take). The correction is the
 *    road-group model's factor for the route (1 without drives), refined by drives of this very route (preview
 *    samples + habit drives), so the shown ETA only moves on measured drives;
 *  - costS = expectedS + road-class / left-turn / closure penalty + hazard cost + no-live-data allowance (peak)
 *    + riskK × σ (what ranks the routes; never shown);
 *  - routes within max(tieMinS, tieFrac × best) + motorway share × fastBandS of the best cost are eligible; among
 *    them the lowest cost + predictability penalty wins, where the penalty is
 *    allowance + road penalty − motorway/trunk share × fastShareS − habit trips × habitS (habit only while the route
 *    has fewer than 2 measured drives: a measured slow habit must not keep winning);
 *  - at weekday peak a route with much less motorway than the best motorway route must save
 *    max(leaveHighway.minS, frac × its cost) over it, else the motorway route is recommended;
 *  - "recommended" on the pick; "fastestNow" on another route only if its live time beats the pick's by more than
 *    the tie band. Tags mark what sets a route apart. Output: the pick first, then by cost.
 */
export function recommend(cands: RouteCandidate[], input: RecommendInput, cfg: CandidateConfig = CANDIDATES): RouteCandidate[] {
  if (cands.length === 0) return [];
  const rc = cfg.recommend;
  const bucket = timeBucket(input.now);
  const period = periodOf(bucket);
  const models = classModelsFor(cands, input, cfg);
  const skip = new Set(input.samples.flatMap((s) => (s.tripId ? [s.tripId] : [])));
  const scored = cands.map((c) => {
    const r = c.route;
    const ctl = controlDelayS(r, rc);
    const predicted = r.durationS + ctl;
    const bias = routeBias(r, predicted, models, period);
    const habitDrives = input.traces?.length ? habitObs(r, input.traces, ctl, input.now, skip, cfg).obs : [];
    const { factor, n } = correctionFactor(r, input.samples, bucket, cfg, bias.factor, habitDrives);
    const habit = n >= 2 ? 0 : Math.min(rc.habitCap, habitOf(r, input.learned, cfg));
    const share = fastShare(r);
    const typical = r.typicalDurationS;
    const over = typical !== undefined && typical > r.durationS * 0.5 ? r.durationS - typical : 0;
    const overUsualMin = typical !== undefined && over >= Math.max(rc.overUsualMinS, rc.overUsualFrac * typical) ? Math.round(over / 60) : 0;
    const expectedS = predicted * factor;
    const risk = ETA_BIAS.riskK[period] * bias.sigmaS * factor;
    const unknownS = (bias.unknownS * rc.priorN) / (n + rc.priorN);
    const costS = expectedS + roadPenaltyS(r, rc) + Math.max(0, input.hazardCostS?.(r) ?? 0) + unknownS + risk;
    const out: RouteCandidate = { ...c, expectedS, costS, samples: n, overUsualMin, badge: null, tags: [], deltaS: 0 };
    return { c: out, e: costS, share, tie: ctl + roadPenaltyS(r, rc) - share * rc.fastShareS - habit * rc.habitS };
  });
  const best = Math.min(...scored.map((s) => s.e));
  const band = Math.max(rc.tieMinS, rc.tieFrac * best);
  // Inside the band, cost + predictability penalty decides: a route a few minutes slower never wins on 1–2 fewer lights.
  let pick = scored.filter((s) => s.e <= best + band + s.share * rc.fastBandS).sort((a, b) => a.e + a.tie - (b.e + b.tie) || a.e - b.e)[0]!;
  if (period === 'peak') {
    // Leaving the highway at peak must pay off clearly: the motorway route's time is measured live, the shortcut's
    // mostly is not (see etaBias).
    const lh = ETA_BIAS.leaveHighway;
    const hw = scored.filter((s) => s.share >= lh.minShare).sort((a, b) => a.e - b.e)[0];
    if (hw && hw !== pick && pick.share < hw.share - lh.shareGap && hw.e - pick.e < Math.max(lh.minS, lh.frac * hw.e)) pick = hw;
  }
  pick.c.badge = 'recommended';
  const fastest = [...scored].sort((a, b) => a.c.route.durationS - b.c.route.durationS)[0]!;
  if (fastest !== pick && fastest.c.route.durationS < pick.c.route.durationS - band) fastest.c.badge = 'fastestNow';
  tag(scored, fastest, rc);
  return [pick.c, ...scored.filter((s) => s !== pick).sort((a, b) => a.e - b.e).map((s) => s.c)];
}

function tag(scored: { c: RouteCandidate; share: number }[], fastest: { c: RouteCandidate }, rc: RecommendConfig): void {
  const live = fastest.c.route.durationS;
  for (const s of scored) s.c.deltaS = Math.max(0, Math.round(s.c.route.durationS - live));
  if (scored.length < 2) return;
  const add = (s: { c: RouteCandidate }, t: RouteTag) => s.c.tags!.push(t);
  if (fastest.c.badge !== 'fastestNow') add(fastest, 'fastest');
  const hw = [...scored].sort((a, b) => b.share - a.share);
  if (hw[0]!.share >= rc.highwayTagShare && hw[0]!.share - hw[1]!.share >= 0.2) add(hw[0]!, 'highway');
  const turns = (c: RouteCandidate) => (c.route.controls ? c.route.controls.turns + c.route.controls.signals + c.route.controls.stops : Infinity);
  const byTurns = [...scored].sort((a, b) => turns(a.c) - turns(b.c));
  if (turns(byTurns[0]!.c) + rc.fewerTurnsMin <= turns(byTurns[1]!.c)) add(byTurns[0]!, 'fewerTurns');
  const byDist = [...scored].sort((a, b) => a.c.route.distanceM - b.c.route.distanceM);
  if (byDist[0]!.c.route.distanceM <= byDist[1]!.c.route.distanceM * (1 - rc.shorterFrac)) add(byDist[0]!, 'shortest');
  const tolled = (c: RouteCandidate) => (c.route.controls?.tollM ?? 0) > 0;
  if (scored.some((s) => tolled(s.c))) for (const s of scored) if (!tolled(s.c) && s.c.route.controls) add(s, 'noTolls');
}

/** What a preview remembers so the trip that follows can be scored against it. */
export interface PreviewRecord {
  at: number;
  from: LatLng;
  to: LatLng;
  routes: { line: LatLng[]; predictedS: number; parts?: number[] }[];
}

export function previewRecord(cands: RouteCandidate[], from: LatLng, to: LatLng, at: number, cfg: CandidateConfig = CANDIDATES): PreviewRecord {
  return {
    at,
    from: { lat: from.lat, lng: from.lng },
    to: { lat: to.lat, lng: to.lng },
    routes: cands.map((c) => {
      const predictedS = c.route.durationS + controlDelayS(c.route, cfg.recommend);
      const parts = routeParts(c.route).map((p) => Math.round((p / Math.max(1, c.route.durationS)) * predictedS));
      return { line: simplifyPolyline(c.route.geometry, cfg.learned.simplifyM), predictedS, parts };
    }),
  };
}

/**
 * Time (s) between the fix nearest the origin (first half of the trip) and the fix nearest the destination (second
 * half): drops time spent before reaching the previewed origin or after passing the destination. Null when either is
 * further than `tolM`.
 */
export function legTimeS(points: { lat: number; lng: number; t: number }[], from: LatLng, to: LatLng, tolM: number): number | null {
  if (points.length < 2) return null;
  const half = points.length >> 1;
  let a = -1;
  let da = Infinity;
  for (let i = 0; i <= half; i++) {
    const d = haversineM(points[i]!, from);
    if (d < da) [a, da] = [i, d];
  }
  let b = -1;
  let db = Infinity;
  for (let i = half; i < points.length; i++) {
    const d = haversineM(points[i]!, to);
    if (d < db) [b, db] = [i, d];
  }
  if (da > tolM || db > tolM || b <= a) return null;
  return (points[b]!.t - points[a]!.t) / 1000;
}

/**
 * A drive sample when a driver trip started within `previewWindowMs` of a preview, went from its origin to its
 * destination and followed one of its routes (≥ clusterOverlap). Null otherwise.
 */
export function driveSample(
  trace: RouteTrace,
  startedAt: number,
  preview: PreviewRecord | null,
  cfg: CandidateConfig = CANDIDATES,
  points?: { lat: number; lng: number; t: number }[],
): DriveSample | null {
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
  // Time from the previewed origin to the destination when the fixes show it (not from wherever the trip began).
  const leg = points ? legTimeS(points, preview.from, preview.to, Math.max(cfg.learned.endpointM, cfg.learned.endpointFrac * trace.distanceM)) : null;
  const actualS = leg ?? (trace.endedAt - startedAt) / 1000;
  if (!best || actualS <= 0) return null;
  const out: DriveSample = { line: best.line, bucket: timeBucket(startedAt), predictedS: best.predictedS, actualS, at: trace.endedAt, tripId: trace.tripId };
  if (best.parts?.length === 4) out.parts = best.parts;
  return out;
}

/** Appends a sample, keeping the newest `maxSamples`. */
export function addDriveSample(samples: DriveSample[], s: DriveSample, cfg: CandidateConfig = CANDIDATES): DriveSample[] {
  return [...samples, s].sort((a, b) => a.at - b.at).slice(-cfg.recommend.maxSamples);
}
