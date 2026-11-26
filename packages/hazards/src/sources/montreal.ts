import { z } from 'zod';
import type { BBox } from '@crewmap/shared/geo';
import { HealthTracker } from '../health';
import { easternClock } from '../time';
import { feedExpiry, type FetchContext, type Hazard, type HazardSource, type HazardType, type HttpGet } from '../types';

/**
 * Ville de Montréal open data "Entraves et travaux en cours" (dataset vmtl-info-travaux, CC-BY 4.0, refreshed daily),
 * read through the portal's CKAN datastore API (JSON; the CSV download refuses requests without a browser UA).
 *  - permits: one row per permit (dates, weekly schedule, reason, point).
 *  - impacts: one row per affected street segment (`id_request` → permit id), with the street impact type.
 * Only permits that obstruct a traffic lane or close the street become hazards; parking-only impacts are dropped.
 * Attribution: "Source : Ville de Montréal — Entraves et travaux en cours".
 */
export const MTL_DATASTORE = 'https://donnees.montreal.ca/api/3/action/datastore_search';
export const MTL_PERMITS_RESOURCE = 'cc41b532-f12d-40fb-9f55-eb58c9a2b12b';
export const MTL_IMPACTS_RESOURCE = 'a2bc8014-488c-495d-941b-e7ae1999d1bd';
export const MTL_ATTRIBUTION = 'Ville de Montréal, CC-BY 4.0';
/** Island of Montréal; skip the fetch when the circle's area doesn't touch it. */
export const MTL_BBOX: BBox = { south: 45.40, west: -73.98, north: 45.71, east: -73.47 };
/** Rows per page (≈ 1 900 rows exist; the API caps a page at 32 000). */
export const MTL_PAGE = 5000;
/** The portal reloads the dataset once a day (~07:00 UTC); re-download at most this often (~200 kB gzipped). */
export const MTL_REFRESH_MS = 6 * 3600_000;
/** Past this, a cached copy (failed refreshes) is too old to trust. */
export const MTL_MAX_CACHE_AGE_MS = 36 * 3600_000;

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const PERMIT_FIELDS = [
  'id',
  'currentstatus',
  'duration_start_date',
  'duration_end_date',
  'reason_category',
  'occupancy_name',
  'load_date',
  'longitude',
  'latitude',
  ...DAYS.flatMap((d) => [`duration_days_${d}_active`, `duration_days_${d}_all_day_round`, `duration_days_${d}_start_time`, `duration_days_${d}_end_time`]),
];
const IMPACT_FIELDS = ['id_request', 'streetimpacttype', 'name'];

export function mtlUrl(resource: string, fields: string[], offset = 0): string {
  return `${MTL_DATASTORE}?resource_id=${resource}&limit=${MTL_PAGE}&offset=${offset}&fields=${fields.join(',')}`;
}
export const mtlPermitsUrl = (offset = 0) => mtlUrl(MTL_PERMITS_RESOURCE, PERMIT_FIELDS, offset);
export const mtlImpactsUrl = (offset = 0) => mtlUrl(MTL_IMPACTS_RESOURCE, IMPACT_FIELDS, offset);

const Rec = z.record(z.string(), z.unknown());
const Resp = z.object({
  success: z.literal(true),
  result: z.object({ records: z.array(Rec), total: z.number().optional() }),
});

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Street impact → hazard type; null = no effect on traffic. Unknown future values count as a lane obstruction. */
export function mtlImpactType(impact: string | null): HazardType | null {
  const s = (impact ?? '').toLowerCase();
  if (!s || s.startsWith('aucun')) return null;
  if (s.includes('barrée') || s.includes('fermée')) return 'closure';
  if (s.includes('circulation')) return 'construction';
  if (s.includes('stationnement')) return null;
  return 'construction';
}

const hm = (v: unknown): number | null => {
  const m = /^(\d{2}):(\d{2})/.exec(str(v) ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * When the permit's weekly schedule stops being active (epoch ms; Infinity = all day), or null if it isn't active at
 * `now` (Montréal local time). Handles overnight windows ("20:00 → 05:00").
 */
export function mtlActiveUntil(p: Record<string, unknown>, now: number): number | null {
  const { weekday, minutes } = easternClock(now);
  const today = DAYS[weekday]!;
  const yesterday = DAYS[(weekday + 6) % 7]!;
  const window = (d: string) => {
    if (p[`duration_days_${d}_active`] !== 't') return null;
    if (p[`duration_days_${d}_all_day_round`] === 't') return { all: true as const };
    const s = hm(p[`duration_days_${d}_start_time`]);
    const e = hm(p[`duration_days_${d}_end_time`]);
    return s === null || e === null ? { all: true as const } : { all: false as const, s, e };
  };
  const at = (endMin: number) => now + (endMin - minutes) * 60_000;
  const w = window(today);
  if (w?.all) return Infinity;
  if (w && w.s <= w.e && minutes >= w.s && minutes < w.e) return at(w.e);
  if (w && w.s > w.e && minutes >= w.s) return at(w.e + 1440);
  // Yesterday's overnight window spilling past midnight.
  const y = window(yesterday);
  if (y && !y.all && y.s > y.e && minutes < y.e) return at(y.e);
  return null;
}

export interface MtlImpact {
  type: HazardType;
  streets: string[];
}

/** Worst traffic impact per permit id (closure > lane obstruction). */
export function mtlImpacts(rows: Record<string, unknown>[]): Map<string, MtlImpact> {
  const out = new Map<string, MtlImpact>();
  for (const r of rows) {
    const id = str(r.id_request);
    const type = mtlImpactType(str(r.streetimpacttype));
    if (!id || !type) continue;
    const cur = out.get(id) ?? { type, streets: [] };
    if (type === 'closure') cur.type = 'closure';
    const name = str(r.name);
    if (name && !cur.streets.includes(name)) cur.streets.push(name);
    out.set(id, cur);
  }
  return out;
}

export function normaliseMtl(p: Record<string, unknown>, impacts: Map<string, MtlImpact>, bbox: BBox, now: number): Hazard | null {
  const id = str(p.id);
  const lat = Number(p.latitude);
  const lng = Number(p.longitude);
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0) return null;
  if (lat < bbox.south || lat > bbox.north || lng < bbox.west || lng > bbox.east) return null;
  const impact = impacts.get(id);
  if (!impact) return null;
  const status = (str(p.currentstatus) ?? '').toLowerCase();
  if (status && !status.includes('émis') && !status.includes('emis')) return null;
  const start = Date.parse(str(p.duration_start_date) ?? '');
  const end = Date.parse(str(p.duration_end_date) ?? '');
  if (Number.isFinite(end) && end <= now) return null;
  if (Number.isFinite(start) && start > now) return null;
  const until = mtlActiveUntil(p, now);
  if (until === null) return null;
  const loaded = Date.parse(str(p.load_date) ?? '');
  const endsAt = Number.isFinite(end) ? end : null;
  const expiresAt = Math.min(feedExpiry(now, endsAt), until);
  return {
    id: `montreal:${id}`,
    source: 'montreal',
    type: impact.type,
    subtype: str(p.reason_category),
    lat,
    lng,
    heading: null,
    street: str(p.occupancy_name) ?? impact.streets[0] ?? null,
    reportedAt: Number.isFinite(loaded) ? loaded : Number.isFinite(start) ? start : now,
    expiresAt,
    ...(endsAt !== null ? { endsAt } : {}),
    reliability: 9,
    confirmations: 0,
    ...(impact.streets.length ? { description: impact.streets.join(' · ') } : {}),
  };
}

export class MontrealSource implements HazardSource {
  readonly id = 'montreal' as const;
  readonly tracker = new HealthTracker('montreal');
  private cache: { at: number; permits: Record<string, unknown>[]; impacts: Map<string, MtlImpact> } | null = null;

  constructor(private readonly http: HttpGet) {}

  health() {
    return this.tracker.get();
  }

  /** All pages of one datastore resource; null on failure (already recorded in health). */
  private async all(url: (offset: number) => string, now: number): Promise<Record<string, unknown>[] | null> {
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; offset < 100_000; offset += MTL_PAGE) {
      const res = await this.http(url(offset));
      if (res.status !== 200) {
        this.tracker.fail(now, res.status === 403 || res.status === 429 ? 'blocked' : 'degraded', `HTTP ${res.status}`, res.status);
        return null;
      }
      const r = Resp.safeParse(await res.json());
      if (!r.success) {
        this.tracker.fail(now, 'shapeChanged', 'not a datastore_search result');
        return null;
      }
      rows.push(...r.data.result.records);
      const total = r.data.result.total ?? 0;
      if (r.data.result.records.length < MTL_PAGE || rows.length >= total) break;
    }
    return rows;
  }

  async fetch(ctx: FetchContext): Promise<Hazard[]> {
    const b = ctx.bbox;
    if (b.north < MTL_BBOX.south || b.south > MTL_BBOX.north || b.east < MTL_BBOX.west || b.west > MTL_BBOX.east) return [];
    if (!this.cache || ctx.now - this.cache.at >= MTL_REFRESH_MS) {
      this.tracker.attempt(ctx.now);
      try {
        const impactRows = await this.all(mtlImpactsUrl, ctx.now);
        const permits = impactRows ? await this.all(mtlPermitsUrl, ctx.now) : null;
        if (permits && permits.length && !('latitude' in permits[0]! && 'duration_end_date' in permits[0]!)) {
          this.tracker.fail(ctx.now, 'shapeChanged', 'permit fields missing');
        } else if (impactRows && permits) {
          this.cache = { at: ctx.now, permits, impacts: mtlImpacts(impactRows) };
          this.tracker.ok(ctx.now);
        }
      } catch (e) {
        this.tracker.fail(ctx.now, 'degraded', (e as Error).message);
      }
    }
    // The dataset is daily: a cached copy is still valid for dates/schedules, re-evaluated at every call.
    if (!this.cache || ctx.now - this.cache.at > MTL_MAX_CACHE_AGE_MS) return [];
    const out: Hazard[] = [];
    for (const p of this.cache.permits) {
      const h = normaliseMtl(p, this.cache.impacts, b, ctx.now);
      if (h) out.push(h);
    }
    return out;
  }
}
