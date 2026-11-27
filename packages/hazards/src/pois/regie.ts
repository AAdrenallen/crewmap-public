import { z } from 'zod';
import type { BBox } from '@crewmap/shared/geo';
import { HealthTracker } from '../health';
import type { HttpGet } from '../types';
import type { FuelGrade, FuelPrice, Poi } from './types';

/**
 * Régie essence Québec (D64): the Régie de l'énergie's official station-level pump prices. Since 2026-04-01 every
 * Québec retailer must report each regular / super / diesel price change to the Régie (Loi sur les produits
 * pétroliers, art. 67.1), and the Régie publishes all ~2 500 stations as one GeoJSON file that its public map reads
 * (CORS open, ETag, regenerated every few minutes). No licence text is published; the Régie said third parties may
 * reuse the downloadable data. Fetched on the chore peer with a conditional GET, cached on the phone, shared with the
 * crew as a small subset around them. Records carry no per-station change time: the age shown is the feed's
 * `generated_at` ("as of").
 */
export const REGIE_URL = 'https://regieessencequebec.ca/stations.geojson.gz';
export const REGIE_ATTRIBUTION = 'Régie de l’énergie du Québec — Régie essence Québec';
/** Poll interval while someone drives or has the map open (the file is ~130 kB gzipped; a 304 costs ~nothing). */
export const REGIE_REFRESH_MS = 10 * 60_000;
/** Prices older than this are not shown. */
export const REGIE_MAX_AGE_MS = 48 * 3600_000;

const GRADE: Record<string, FuelGrade> = { 'Régulier': 'regular', Super: 'premium', Diesel: 'diesel' };

const PriceRow = z.object({ GasType: z.string(), Price: z.string().nullable(), IsAvailable: z.boolean() });
const Feature = z.object({
  geometry: z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) }),
  properties: z.object({
    Name: z.string().nullish(),
    brand: z.string().nullish(),
    Status: z.string().nullish(),
    Address: z.string().nullish(),
    PostalCode: z.string().nullish(),
    Prices: z.array(PriceRow).nullish(),
  }),
});
const FC = z.object({
  type: z.literal('FeatureCollection'),
  metadata: z.object({ generated_at: z.string() }).partial().optional(),
  features: z.array(z.unknown()),
});

/** "166.4¢" (optionally with spaces / comma) → 1664 tenths of a cent; null for junk or implausible values. */
export function parseCents(v: string | null): number | null {
  if (!v) return null;
  const m = /(\d{2,3})(?:[.,](\d))?/.exec(v.replace(/\s/g, ''));
  if (!m) return null;
  const c10 = Number(m[1]) * 10 + Number(m[2] ?? 0);
  return c10 >= 500 && c10 <= 5000 ? c10 : null;
}

export function normaliseRegie(raw: unknown, fallbackAt: number): { at: number; stations: Poi[] } | null {
  const fc = FC.safeParse(raw);
  if (!fc.success) return null;
  const gen = fc.data.metadata?.generated_at ? Date.parse(fc.data.metadata.generated_at) : NaN;
  const at = Number.isFinite(gen) ? gen : fallbackAt;
  const stations: Poi[] = [];
  for (const f of fc.data.features) {
    const p = Feature.safeParse(f);
    if (!p.success) continue;
    const pr = p.data.properties;
    if (pr.Status && pr.Status !== 'En opération') continue;
    const [lng, lat] = p.data.geometry.coordinates;
    const prices: Partial<Record<FuelGrade, FuelPrice>> = {};
    for (const row of pr.Prices ?? []) {
      const g = GRADE[row.GasType];
      const c10 = row.IsAvailable ? parseCents(row.Price) : null;
      if (g && c10 !== null) prices[g] = { c10, at, source: 'regie' };
    }
    const key = `${(pr.PostalCode ?? '').replace(/\s/g, '')}:${lat.toFixed(4)},${lng.toFixed(4)}`;
    stations.push({
      id: `regie:${key}`,
      kind: 'fuel',
      source: 'regie',
      lat,
      lng,
      name: pr.Name?.trim() || null,
      ...(pr.brand?.trim() ? { brand: pr.brand.trim() } : {}),
      ...(pr.Address?.trim() ? { address: pr.Address.trim() } : {}),
      prices,
      at,
    });
  }
  return { at, stations };
}

export interface RegieSnapshot {
  at: number;
  fetchedAt: number;
  etag: string | null;
  stations: Poi[];
}

export class RegieFuelSource {
  readonly id = 'regie' as const;
  readonly tracker = new HealthTracker('regie');
  private stations: Poi[] = [];
  private at = 0;
  private fetchedAt = 0;
  private etag: string | null = null;

  constructor(
    private readonly http: HttpGet,
    private readonly onRequest?: () => void,
    private readonly url: string = REGIE_URL,
  ) {}

  health() {
    return this.tracker.get();
  }

  /** Time of the prices held (feed generation time), 0 if none. */
  asOf(): number {
    return this.at;
  }

  due(now: number, maxAgeMs = REGIE_REFRESH_MS): boolean {
    return now - this.fetchedAt >= maxAgeMs;
  }

  snapshot(): RegieSnapshot {
    return { at: this.at, fetchedAt: this.fetchedAt, etag: this.etag, stations: this.stations };
  }

  restore(s: RegieSnapshot | null, now: number): void {
    if (!s || !Array.isArray(s.stations) || typeof s.at !== 'number' || now - s.at > REGIE_MAX_AGE_MS) return;
    this.stations = s.stations;
    this.at = s.at;
    this.fetchedAt = s.fetchedAt ?? 0;
    this.etag = s.etag ?? null;
  }

  /** Download the province file if due; returns true when new prices were stored. */
  async refresh(now: number, maxAgeMs = REGIE_REFRESH_MS): Promise<boolean> {
    if (!this.due(now, maxAgeMs)) return false;
    this.fetchedAt = now;
    this.tracker.attempt(now);
    this.onRequest?.();
    try {
      const res = await this.http(this.url, this.etag && this.stations.length ? { 'If-None-Match': this.etag } : undefined);
      if (res.status === 304) {
        this.tracker.ok(now);
        return false;
      }
      if (res.status !== 200) {
        this.tracker.fail(now, res.status === 403 ? 'blocked' : 'degraded', `HTTP ${res.status}`, res.status);
        return false;
      }
      const got = normaliseRegie(await res.json(), now);
      if (!got || got.stations.length === 0) {
        this.tracker.fail(now, 'shapeChanged', 'not a Régie stations FeatureCollection');
        return false;
      }
      this.stations = got.stations;
      this.at = got.at;
      this.etag = res.headers?.get('etag') ?? null;
      this.tracker.ok(now);
      return true;
    } catch (e) {
      this.tracker.fail(now, 'degraded', (e as Error).message);
      return false;
    }
  }

  /** Stations inside `b` (no network). */
  within(b: BBox, now: number): Poi[] {
    if (now - this.at > REGIE_MAX_AGE_MS) return [];
    return this.stations.filter((s) => s.lat >= b.south && s.lat <= b.north && s.lng >= b.west && s.lng <= b.east);
  }
}
