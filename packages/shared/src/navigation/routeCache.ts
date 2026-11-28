import { haversineM, type LatLng } from '../geo';
import type { BudgetLevel } from '../apiBudget';
import type { RouteExclude } from './route';

/**
 * Fewer Directions calls per route search (D60):
 *  - a short-lived result cache: re-opening the preview, toggling back route options or tapping the same
 *    destination again within a few minutes reuses the routes (traffic barely moves in that time);
 *  - search modes: a full discovery (≤ 10 calls) only the first time an origin/destination pair is searched in a
 *    week; afterwards the routes kept last time are re-asked through their cached vias (1 + ≤ 3 calls, plus one
 *    "stay on the highway" probe when none of them is a motorway route);
 *    short trips and a spent daily budget ask Directions once.
 */
export const ROUTE_CACHE = {
  /** Origin / destination quantisation for the result cache. */
  cellM: 200,
  ttlMs: 4 * 60_000,
  maxEntries: 8,
  /** A full discovery per O/D pair at most this often while its via cache is warm. */
  fullEveryMs: 7 * 86_400_000,
  /** Straight-line trips shorter than this get one Directions call (alternatives barely differ). */
  shortTripM: 1000,
};

const M_PER_DEG = 111_195;

function cell(p: LatLng, m: number): string {
  return `${Math.round((p.lat * M_PER_DEG) / m)},${Math.round((p.lng * M_PER_DEG * Math.cos((p.lat * Math.PI) / 180)) / m)}`;
}

/** Result-cache key: quantised origin and destination, avoided road classes, instruction language. */
export function routeCacheKey(from: LatLng, to: LatLng, exclude: readonly RouteExclude[], lang: string, cellM: number = ROUTE_CACHE.cellM): string {
  return `${cell(from, cellM)}>${cell(to, cellM)}|${[...exclude].sort().join('+')}|${lang}`;
}

export type DiscoveryMode = 'full' | 'warm' | 'lean';

export interface ModeInput {
  from: LatLng;
  to: LatLng;
  /** Last full discovery for this O/D (ms), null = never. */
  lastFullAt: number | null;
  now: number;
  budget: BudgetLevel;
}

export function discoveryMode(m: ModeInput, cfg = ROUTE_CACHE): DiscoveryMode {
  if (m.budget !== 'ok' || haversineM(m.from, m.to) < cfg.shortTripM) return 'lean';
  if (m.lastFullAt !== null && m.now - m.lastFullAt < cfg.fullEveryMs && m.now >= m.lastFullAt) return 'warm';
  return 'full';
}
