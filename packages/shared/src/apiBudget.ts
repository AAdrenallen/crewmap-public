/**
 * Per-device daily request budget for billable map APIs (D60). Every Mapbox request goes through one counter; past
 * the soft cap the app degrades (lean route search, fewer refreshes, cached limits / local ETAs), past the hard cap
 * only requests the user explicitly asked for still run (one route search, a reroute). Pure; the app persists it.
 *
 * Caps: the free tier is per account and month (Directions / Map Matching 100 000 requests, Matrix 100 000
 * elements, Search Box 25 000 requests, temporary Geocoding 100 000), shared by every crew phone on the token.
 * For ~10 phones that is ≈ 330 Directions requests per phone and day; the soft cap keeps a heavy day well inside.
 */
/** Free open-data feeds (D64) are counted too, never capped: `overpass`, `regie`, `mtmd`, `ocm`. */
export type ApiKind = 'directions' | 'matrix' | 'mapMatching' | 'search' | 'geocode' | 'routingEngine' | 'overpass' | 'regie' | 'mtmd' | 'ocm' | 'eccc' | 'cbsa' | 'wiki';

export const API_KINDS: readonly ApiKind[] = ['directions', 'matrix', 'mapMatching', 'search', 'geocode', 'routingEngine', 'overpass', 'regie', 'mtmd', 'ocm', 'eccc', 'cbsa', 'wiki'];

export const API_BUDGET = {
  /** Units per local day (matrix: elements). `routingEngine` is the optional self-hosted router: free, never capped. */
  softCap: { directions: 150, matrix: 300, mapMatching: 150, search: 100, geocode: 100, routingEngine: Infinity, overpass: Infinity, regie: Infinity, mtmd: Infinity, ocm: Infinity, eccc: Infinity, cbsa: Infinity, wiki: Infinity } as Record<ApiKind, number>,
  hardCap: { directions: 300, matrix: 600, mapMatching: 300, search: 200, geocode: 200, routingEngine: Infinity, overpass: Infinity, regie: Infinity, mtmd: Infinity, ocm: Infinity, eccc: Infinity, cbsa: Infinity, wiki: Infinity } as Record<ApiKind, number>,
  /** Days of history kept (Diagnostics). */
  keepDays: 14,
};

export type BudgetLevel = 'ok' | 'lean' | 'off';

export interface ApiDay {
  /** Local date, YYYY-MM-DD. */
  day: string;
  used: Partial<Record<ApiKind, number>>;
  /** Requests avoided (cache hits, skipped probes) — for the Diagnostics counter. */
  saved: Partial<Record<ApiKind, number>>;
}

export function dayKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class ApiBudget {
  private days: ApiDay[];

  constructor(
    stored: unknown = [],
    private readonly caps = API_BUDGET,
  ) {
    this.days = Array.isArray(stored) ? stored.filter((d): d is ApiDay => !!d && typeof d === 'object' && typeof (d as ApiDay).day === 'string').map((d) => ({ day: d.day, used: { ...d.used }, saved: { ...d.saved } })) : [];
  }

  private today(now: number): ApiDay {
    const day = dayKey(now);
    let d = this.days.find((x) => x.day === day);
    if (!d) {
      d = { day, used: {}, saved: {} };
      this.days.push(d);
      this.days.sort((a, b) => (a.day < b.day ? -1 : 1));
      if (this.days.length > this.caps.keepDays) this.days = this.days.slice(-this.caps.keepDays);
    }
    return d;
  }

  use(kind: ApiKind, now: number, units = 1): void {
    const d = this.today(now);
    d.used[kind] = (d.used[kind] ?? 0) + units;
  }

  save(kind: ApiKind, now: number, units = 1): void {
    if (units <= 0) return;
    const d = this.today(now);
    d.saved[kind] = (d.saved[kind] ?? 0) + units;
  }

  used(kind: ApiKind, now: number): number {
    return this.days.find((x) => x.day === dayKey(now))?.used[kind] ?? 0;
  }

  level(kind: ApiKind, now: number): BudgetLevel {
    const u = this.used(kind, now);
    if (u >= this.caps.hardCap[kind]) return 'off';
    if (u >= this.caps.softCap[kind]) return 'lean';
    return 'ok';
  }

  /** Newest first. */
  history(): ApiDay[] {
    return [...this.days].reverse().map((d) => ({ day: d.day, used: { ...d.used }, saved: { ...d.saved } }));
  }

  toJSON(): ApiDay[] {
    return this.days.map((d) => ({ day: d.day, used: { ...d.used }, saved: { ...d.saved } }));
  }
}

/** Mapbox request kind from its URL (null: not a billable API call, e.g. our own relay). */
export function apiKindOf(url: string): ApiKind | null {
  if (!url.startsWith('https://api.mapbox.com/')) return null;
  if (url.includes('/directions-matrix/')) return 'matrix';
  if (url.includes('/directions/')) return 'directions';
  if (url.includes('/matching/')) return 'mapMatching';
  if (url.includes('/search/searchbox/')) return 'search';
  if (url.includes('/search/geocode/') || url.includes('/geocoding/')) return 'geocode';
  return null;
}

/** Billed units of a Mapbox request: Matrix bills elements (sources × destinations), the rest per request. */
export function apiUnitsOf(url: string): number {
  if (!url.includes('/directions-matrix/')) return 1;
  const path = url.split('?')[0]!;
  const coords = path.slice(path.lastIndexOf('/') + 1).split(';').length;
  const q = new URLSearchParams(url.split('?')[1] ?? '');
  const n = (v: string | null) => (v === null || v === 'all' ? coords : v.split(';').length);
  return n(q.get('sources')) * n(q.get('destinations'));
}
