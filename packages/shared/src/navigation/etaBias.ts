import type { NavRoute } from './route';

/**
 * ETA truth (D60): how far the router's time is off for THIS driver, by road group and time of week, learned from
 * completed drives (on-device; only the per-group multipliers may be shared with the crew). Pure.
 *
 * Why: Mapbox has live probe speeds on nearly all motorway length but not on minor roads (measured on public
 * landmark trips at a weekday evening: congestion "unknown" on 0 % of motorway, 4 % primary, 21 % secondary, 39 %
 * tertiary, 96 % local street length). A jam on the motorway is priced live; the same jam spilling onto the parallel
 * shortcut is not (historical speeds only), so a shortcut is optimistic exactly when it gets recommended.
 *
 * Model per period (weekday peak / other): actual / predicted = Σ_g share_g × m_g + noise, where share_g is the
 * predicted time share on road group g (motorway/trunk, primary/secondary, tertiary, local). The multipliers m_g are
 * fitted by ridge regression shrunk toward a prior (1, or the crew's multipliers), so one odd drive moves little and
 * a group nobody drove stays at the prior. Residuals give a per-group spread (reliability), priced at peak like
 * Google/Waze "risk": the steadier route wins unless the other saves clearly more.
 */
export const ETA_BIAS = {
  /** Weekday AM / PM peak `timeBucket`s. */
  peakBuckets: [1, 3] as readonly number[],
  /** Pseudo-drives pulling each multiplier toward its prior. */
  priorStrength: 4,
  minM: 0.8,
  maxM: 1.6,
  /**
   * Prior relative spread (1 σ of actual/predicted) per group [fast, arterial, collector, local], before any drive.
   * Peak: queues at signals / left turns, school zones, slow movers on single-lane roads; motorways steadier.
   */
  spread0: { peak: [0.06, 0.1, 0.13, 0.16], other: [0.04, 0.06, 0.08, 0.1] } as Record<EtaPeriod, number[]>,
  spreadStrength: 4,
  /** Ranking cost per second of route σ (mean + k σ), weekday peak only (off-peak ranking stays as in D59). Never an ETA. */
  riskK: { peak: 0.5, other: 0 } as Record<EtaPeriod, number>,
  /**
   * Ranking cost (share of their time) for segments the router has no live data for, at peak only: a jam there is
   * invisible to it. Kept small, and it fades as the route gets measured drives (they already contain that delay).
   */
  unknownLive: { peak: 0.08, other: 0 } as Record<EtaPeriod, number>,
  /**
   * Leaving the highway at peak: a route with this much less motorway share than the best motorway route wins only
   * when its cost is at least max(minS, frac × the motorway route's cost) lower; otherwise the motorway route is
   * recommended (the faster one still carries "fastest now").
   */
  leaveHighway: { minS: 240, frac: 0.08, shareGap: 0.3, minShare: 0.4 },
  /** Weight of a drive without a preview (actual vs the router's typical time for that slot), vs 1 for a preview. */
  habitWeight: 0.5,
  /** Habit drives count only when their length is within this share of the route's. */
  habitLengthFrac: 0.1,
  /** Crew multipliers: each friend's effective drives counted at most this many times, then × crewWeight. */
  crewCap: 8,
  crewWeight: 0.5,
  crewMaxStrength: 8,
  minCrewN: 2,
} as const;

export type EtaPeriod = 'peak' | 'other';
export const GROUPS = 4;
const FAST = new Set(['motorway', 'trunk']);
const ARTERIAL = new Set(['primary', 'secondary']);

/** Road group of a Mapbox Streets class: 0 motorway/trunk, 1 primary/secondary (or unknown), 2 tertiary, 3 local. */
export function groupOf(cls: string | undefined): number {
  if (!cls) return 1;
  const c = cls.replace(/_link$/, '');
  if (FAST.has(c)) return 0;
  if (ARTERIAL.has(c)) return 1;
  if (c === 'tertiary') return 2;
  return 3;
}

export function periodOf(bucket: number): EtaPeriod {
  return ETA_BIAS.peakBuckets.includes(bucket) ? 'peak' : 'other';
}

/** Router time (s) per road group, from the steps (sums to the route's duration). */
export function routeParts(route: NavRoute): number[] {
  const parts = [0, 0, 0, 0];
  let sum = 0;
  for (const s of route.steps) {
    parts[groupOf(s.roadClass)]! += s.durationS;
    sum += s.durationS;
  }
  if (sum <= 0) return [0, route.durationS, 0, 0];
  const k = route.durationS / sum;
  return parts.map((p) => p * k);
}

/** Router time (s) on segments without live traffic data (`congestion` "unknown"); 0 when not annotated. */
export function unknownLiveS(route: NavRoute): number {
  const d = route.segDurationS;
  if (!d || d.length === 0 || route.congestion.length !== d.length) return 0;
  let s = 0;
  route.congestion.forEach((c, i) => {
    if (c === 'unknown') s += d[i] ?? 0;
  });
  return s;
}

/** A drive reduced for the class model: predicted seconds per group, actual seconds, weight. */
export interface BiasObs {
  parts: number[];
  actualS: number;
  period: EtaPeriod;
  w: number;
}

export interface ClassModel {
  /** Multiplier per road group. */
  m: number[];
  /** Relative spread per road group. */
  s: number[];
  /** Effective drives per group (Σ weight × share). */
  n: number[];
}

export type ClassModels = Record<EtaPeriod, ClassModel>;

/** Prior for one period: multipliers (1 or the crew's), and how many pseudo-drives each is worth. */
export interface ClassPrior {
  m: number[];
  strength: number[];
}

export function defaultPrior(): ClassPrior {
  return { m: [1, 1, 1, 1], strength: [ETA_BIAS.priorStrength, ETA_BIAS.priorStrength, ETA_BIAS.priorStrength, ETA_BIAS.priorStrength] };
}

/** Solves A x = b (small dense system, partial pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const piv = M[c]![c]!;
    if (Math.abs(piv) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / piv;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => (Math.abs(row[i]!) < 1e-12 ? 0 : row[n]! / row[i]!));
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Ridge fit of the multipliers for one period: minimise Σ w (y − x·m)² + Σ_g λ_g (m_g − μ_g)², y = actual/predicted,
 * x = predicted time shares. Spread per group: prior spread shrunk with the share-weighted squared residuals.
 */
export function fitClassModel(obs: BiasObs[], period: EtaPeriod, prior: ClassPrior = defaultPrior()): ClassModel {
  const use = obs.filter((o) => o.period === period && o.actualS > 0 && o.w > 0 && o.parts.reduce((a, b) => a + b, 0) > 0);
  const A = Array.from({ length: GROUPS }, (_, i) => Array.from({ length: GROUPS }, (_, j) => (i === j ? prior.strength[i]! : 0)));
  const b = prior.m.map((m, i) => m * prior.strength[i]!);
  const n = [0, 0, 0, 0];
  const xs = use.map((o) => {
    const tot = o.parts.reduce((a, c) => a + c, 0);
    return { x: o.parts.map((p) => p / tot), y: o.actualS / tot, w: o.w };
  });
  for (const { x, y, w } of xs) {
    for (let i = 0; i < GROUPS; i++) {
      n[i]! += w * x[i]!;
      b[i]! += w * x[i]! * y;
      for (let j = 0; j < GROUPS; j++) A[i]![j]! += w * x[i]! * x[j]!;
    }
  }
  const m = solve(A, b).map((v, i) => (prior.strength[i]! > 0 || n[i]! > 0 ? clamp(v, ETA_BIAS.minM, ETA_BIAS.maxM) : 1));
  const s0 = ETA_BIAS.spread0[period];
  const num = s0.map((s) => ETA_BIAS.spreadStrength * s * s);
  const den = s0.map(() => ETA_BIAS.spreadStrength as number);
  for (const { x, y, w } of xs) {
    const r = y - x.reduce((a, xi, i) => a + xi * m[i]!, 0);
    for (let i = 0; i < GROUPS; i++) {
      num[i]! += w * x[i]! * r * r;
      den[i]! += w * x[i]!;
    }
  }
  return { m, s: num.map((v, i) => Math.sqrt(v / den[i]!)), n };
}

export function fitClassModels(obs: BiasObs[], priors?: Partial<Record<EtaPeriod, ClassPrior>>): ClassModels {
  return { peak: fitClassModel(obs, 'peak', priors?.peak), other: fitClassModel(obs, 'other', priors?.other) };
}

/** Neutral models (no drives, prior spreads): what everyone without history gets. */
export function neutralModels(): ClassModels {
  return fitClassModels([]);
}

export interface RouteBias {
  /** Learned multiplier for the route's router time (1 without drives). */
  factor: number;
  /** 1 σ of the expected time (s). */
  sigmaS: number;
  /** Ranking-only cost (s) for router time without live data, at peak. */
  unknownS: number;
}

/**
 * Bias of a route: factor = Σ share_g × m_g; σ = Σ_g time_g × m_g × s_g (groups fully correlated: one bad day is bad
 * everywhere on the route); `predictedS` is the time the factor applies to (router + control allowance).
 */
export function routeBias(route: NavRoute, predictedS: number, models: ClassModels, period: EtaPeriod): RouteBias {
  const parts = routeParts(route);
  const tot = parts.reduce((a, b) => a + b, 0) || 1;
  const md = models[period];
  let factor = 0;
  let sigma = 0;
  parts.forEach((p, i) => {
    const t = (p / tot) * predictedS;
    factor += (p / tot) * md.m[i]!;
    sigma += t * md.m[i]! * md.s[i]!;
  });
  return { factor, sigmaS: sigma, unknownS: unknownLiveS(route) * ETA_BIAS.unknownLive[period] };
}

// --- crew multipliers -------------------------------------------------------------------------------------------------

/** What a crewmate shares: per period, multipliers and effective drives per group (no places, no times). */
export interface CrewBias {
  peak: { m: number[]; n: number[] };
  other: { m: number[]; n: number[] };
}

export function crewBiasOf(models: ClassModels): CrewBias {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const one = (md: ClassModel) => ({ m: md.m.map(r), n: md.n.map((v) => Math.round(v * 10) / 10) });
  return { peak: one(models.peak), other: one(models.other) };
}

/** Validates a received crew bias (bounded numbers, 4 groups); null when malformed. */
export function parseCrewBias(v: unknown): CrewBias | null {
  const ok = (p: unknown): p is { m: number[]; n: number[] } => {
    if (!p || typeof p !== 'object') return false;
    const { m, n } = p as { m?: unknown; n?: unknown };
    return (
      Array.isArray(m) && Array.isArray(n) && m.length === GROUPS && n.length === GROUPS &&
      m.every((x) => typeof x === 'number' && x >= ETA_BIAS.minM && x <= ETA_BIAS.maxM) &&
      n.every((x) => typeof x === 'number' && x >= 0 && x <= 10_000)
    );
  };
  const o = v as { peak?: unknown; other?: unknown } | null;
  if (!o || !ok(o.peak) || !ok(o.other)) return null;
  return { peak: { m: [...o.peak.m], n: [...o.peak.n] }, other: { m: [...o.other.m], n: [...o.other.n] } };
}

/**
 * Prior from crewmates' multipliers: per group, the default prior (1 × priorStrength) plus each friend's multiplier
 * weighted by min(their effective drives, crewCap) × crewWeight. Friends with fewer than `minCrewN` drives on a
 * group are ignored there. My own drives then refine it.
 */
export function crewPrior(crew: CrewBias[], period: EtaPeriod): ClassPrior {
  const base = defaultPrior();
  const m = [...base.m];
  const strength = [...base.strength];
  for (let g = 0; g < GROUPS; g++) {
    let num = 0;
    let wsum = 0;
    for (const c of crew) {
      const n = c[period].n[g]!;
      if (n < ETA_BIAS.minCrewN) continue;
      const w = Math.min(ETA_BIAS.crewCap, n) * ETA_BIAS.crewWeight;
      num += w * c[period].m[g]!;
      wsum += w;
    }
    // The whole crew is worth at most `crewMaxStrength` pseudo-drives: my own drives must still be able to move it.
    const k = wsum > ETA_BIAS.crewMaxStrength ? ETA_BIAS.crewMaxStrength / wsum : 1;
    const den = base.strength[g]! + wsum * k;
    m[g] = (base.m[g]! * base.strength[g]! + num * k) / den;
    strength[g] = den;
  }
  return { m, strength };
}
