import type { Hazard, HazardSourceId, HazardType } from './types';

/**
 * Multi-source confidence (D42). Each independent report says "it is there" with a probability that depends on its
 * source; independent reports combine noisy-OR; the result decays with age (police leave, cameras do not).
 * Anonymous public reports alone are capped at "medium" unless at least two of them, spread in time, agree.
 */
export const CONFIDENCE = {
  /** Base probability per source. Waze uses its own 0–10 reliability; friends their vote-adjusted one. */
  prior: { quebec: 0.95, montreal: 0.95, osm: 0.85, mapbox: 0.85, waze: 0.8, 'waze-paid': 0.8, friends: 0.8, anon: 0.4 } as Record<HazardSourceId, number>,
  /** Full confidence for this long after the freshest report, then halves every `halfLifeMs` (per type family). */
  freshMs: { enforcement: 15 * 60_000, accident: 30 * 60_000, hazard: 30 * 60_000, jam: 10 * 60_000 } as Record<string, number>,
  halfLifeMs: { enforcement: 30 * 60_000, accident: 60 * 60_000, hazard: 60 * 60_000, jam: 15 * 60_000 } as Record<string, number>,
  high: 0.6,
  medium: 0.35,
  /** Ceiling for a cluster made only of anonymous reports without time-spread corroboration. */
  anonOnlyCap: 0.55,
  /** Two anonymous reports count as independent corroboration only if at least this far apart in time. */
  anonSpreadMs: 2 * 60_000,
  /** Markers never fade below this opacity while alive. */
  minFade: 0.3,
};

export type ConfidenceLevel = 'low' | 'medium' | 'high';

export const TYPE_FAMILY: Record<HazardType, string> = {
  police: 'enforcement',
  speedTrap: 'enforcement',
  camera: 'camera',
  accident: 'accident',
  hazard: 'hazard',
  pothole: 'hazard',
  closure: 'closure',
  construction: 'works',
  jam: 'jam',
};

/** Probability that one report is right, before age decay. */
export function reportProbability(h: Hazard): number {
  const base = CONFIDENCE.prior[h.source];
  if (h.source === 'waze' || h.source === 'waze-paid') return Math.min(0.9, 0.4 + 0.05 * h.reliability);
  if (h.source === 'friends') return Math.max(0.1, Math.min(0.95, base + 0.05 * (h.reliability - 6)));
  if (h.source === 'anon') return Math.max(0.05, Math.min(0.6, base + 0.05 * (h.reliability - 4)));
  return base;
}

/** Independence key: one per friend device, one per anonymous event, one per feed. */
function reporterKey(h: Hazard): string {
  if (h.source === 'friends') return `f:${h.by ?? h.id}`;
  if (h.source === 'anon') return `a:${h.id}`;
  return `s:${h.source}`;
}

export function ageFactor(type: HazardType, ageMs: number): number {
  const fam = TYPE_FAMILY[type];
  const fresh = CONFIDENCE.freshMs[fam];
  const half = CONFIDENCE.halfLifeMs[fam];
  if (fresh === undefined || half === undefined || ageMs <= fresh) return 1;
  return Math.pow(0.5, (ageMs - fresh) / half);
}

export interface Fused {
  confidence: number;
  level: ConfidenceLevel;
  /** Marker opacity 0.3–1 (police fade with age; long-lived types stay at 1). */
  fade: number;
  /** Distinct sources with the number of independent reports from each, e.g. [{anon, 2}, {friends, 1}]. */
  mix: { source: HazardSourceId; n: number }[];
  /** Independent reports. */
  independent: number;
}

export function levelOf(c: number): ConfidenceLevel {
  return c >= CONFIDENCE.high ? 'high' : c >= CONFIDENCE.medium ? 'medium' : 'low';
}

/** Fuses the members of one de-duplicated cluster. */
export function fuse(members: Hazard[], type: HazardType, latestReportAt: number, now: number): Fused {
  const best = new Map<string, { p: number; h: Hazard }>();
  for (const h of members) {
    const k = reporterKey(h);
    const p = reportProbability(h);
    const cur = best.get(k);
    if (!cur || p > cur.p) best.set(k, { p, h });
  }
  let miss = 1;
  for (const { p } of best.values()) miss *= 1 - p;
  let c = 1 - miss;
  const all = [...best.values()].map((x) => x.h);
  if (all.every((h) => h.source === 'anon')) {
    const times = all.map((h) => h.reportedAt);
    const spread = times.length >= 2 && Math.max(...times) - Math.min(...times) >= CONFIDENCE.anonSpreadMs;
    const confirmed = all.some((h) => h.confirmations >= 2);
    if (!spread && !confirmed) c = Math.min(c, CONFIDENCE.anonOnlyCap);
    else if (confirmed) c = Math.max(c, CONFIDENCE.high);
  }
  const af = ageFactor(type, Math.max(0, now - latestReportAt));
  c *= af;
  const counts = new Map<HazardSourceId, number>();
  for (const h of all) counts.set(h.source, (counts.get(h.source) ?? 0) + 1);
  return {
    confidence: Math.round(c * 100) / 100,
    level: levelOf(c),
    fade: Math.max(CONFIDENCE.minFade, af),
    mix: [...counts.entries()].map(([source, n]) => ({ source, n })),
    independent: best.size,
  };
}
