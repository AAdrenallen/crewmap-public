import type { LatLng } from './geo';

/**
 * Posted speed limits remembered per road cell and direction (D60). The not-navigating limit display used to call
 * Map Matching every 30 s of driving (≈ 120 requests per hour); limits barely ever change, and most drives repeat
 * the same roads, so each match result (and every limit a navigation route carries) is kept per ~60 m cell and
 * heading octant and looked up first. Pure; the app persists `toJSON()`.
 */
export const LIMIT_CACHE = {
  cellM: 60,
  ttlMs: 60 * 86_400_000,
  maxEntries: 4000,
};

const M_PER_DEG = 111_195;

/** Cell + heading octant ("x" without a heading: matches any direction on lookup only through `get`'s fallback). */
export function limitKey(p: LatLng, heading: number | null, cellM: number = LIMIT_CACHE.cellM): string {
  const y = Math.floor((p.lat * M_PER_DEG) / cellM);
  const x = Math.floor((p.lng * M_PER_DEG * Math.cos((p.lat * Math.PI) / 180)) / cellM);
  const o = heading === null || !Number.isFinite(heading) ? 'x' : String(Math.round((((heading % 360) + 360) % 360) / 45) % 8);
  return `${y}:${x}:${o}`;
}

export interface LimitEntry {
  k: string;
  kph: number;
  at: number;
}

export class LimitCache {
  private readonly map = new Map<string, LimitEntry>();

  constructor(stored: unknown = [], private readonly cfg = LIMIT_CACHE) {
    if (Array.isArray(stored))
      for (const e of stored as LimitEntry[]) if (e && typeof e.k === 'string' && typeof e.kph === 'number' && typeof e.at === 'number') this.map.set(e.k, e);
  }

  /** Limit for a position and heading: the same direction first, then a direction-less entry. */
  get(p: LatLng, heading: number | null, now: number): number | null {
    for (const k of [limitKey(p, heading, this.cfg.cellM), limitKey(p, null, this.cfg.cellM)]) {
      const e = this.map.get(k);
      if (e && now - e.at <= this.cfg.ttlMs) return e.kph;
    }
    return null;
  }

  put(p: LatLng, heading: number | null, kph: number | null, now: number): void {
    if (kph === null || !(kph > 0) || kph > 200) return;
    const k = limitKey(p, heading, this.cfg.cellM);
    this.map.delete(k);
    this.map.set(k, { k, kph, at: now });
    while (this.map.size > this.cfg.maxEntries) this.map.delete(this.map.keys().next().value as string);
  }

  get size(): number {
    return this.map.size;
  }

  toJSON(): LimitEntry[] {
    return [...this.map.values()];
  }
}

type MatchMaxspeed = { speed: number; unit: string } | { unknown: true } | { none: true };
export interface MatchResponse {
  tracepoints?: ({ matchings_index: number; waypoint_index: number } | null)[];
  matchings?: { legs: { annotation?: { maxspeed?: MatchMaxspeed[] } }[] }[];
}

const kphOf = (m: MatchMaxspeed | undefined): number | null => (m && 'speed' in m ? (m.unit === 'mph' ? Math.round(m.speed * 1.609344) : m.speed) : null);

/**
 * Per input point, the posted limit of the road it was matched to (Map Matching `annotations=maxspeed`): leg k joins
 * waypoints k and k+1 of a matching, so a point takes the last known value of the leg that ends at it (the first
 * point: the first value of the first leg). Null where unmatched or unknown.
 */
export function parseMatchLimits(res: MatchResponse, n: number): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: n }, () => null);
  (res.tracepoints ?? []).slice(0, n).forEach((tp, i) => {
    if (!tp) return;
    const legs = res.matchings?.[tp.matchings_index]?.legs ?? [];
    if (tp.waypoint_index === 0) {
      out[i] = (legs[0]?.annotation?.maxspeed ?? []).map(kphOf).find((v) => v !== null) ?? null;
      return;
    }
    const ms = legs[tp.waypoint_index - 1]?.annotation?.maxspeed ?? [];
    for (let j = ms.length - 1; j >= 0; j--) {
      const v = kphOf(ms[j]);
      if (v !== null) {
        out[i] = v;
        return;
      }
    }
  });
  return out;
}
