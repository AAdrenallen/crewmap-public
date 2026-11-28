import { z } from 'zod';
import type { BBox } from '@crewmap/shared/geo';
import { HealthTracker } from '../health';
import type { HttpGet } from '../types';
import type { Poi } from './types';

/**
 * Open Charge Map (D64), optional: only when a free API key is set in the app config (`extra.ocmKey`, from `.env`).
 * Terms (openchargemap.org/site/about/terms): user-contributed data is CC BY 4.0; third-party records keep their
 * provider's copyright, and apps must show the data-provider attribution and licence. We request `opendata=true` and
 * also drop any record whose provider licence is not a recognised open licence, then show the provider credit per
 * record. Fetched on the chore peer per 0.5° area, at most once a day.
 */
export const OCM_URL = 'https://api.openchargemap.io/v3/poi';
export const OCM_REFRESH_MS = 86_400_000;
export const OCM_MAX_AGE_MS = 30 * 86_400_000;
export const OCM_MAX_RESULTS = 500;

/** Provider licences accepted (case-insensitive substring of DataProvider.License). */
export const OCM_OPEN_LICENCES = ['CC BY', 'CC-BY', 'CC0', 'Open Database License', 'ODbL', 'Open Government Licence', 'Public Domain'] as const;

const Num = z.number().nullish();
const Rec = z.object({
  ID: z.number(),
  NumberOfPoints: Num,
  AddressInfo: z.object({ Title: z.string().nullish(), AddressLine1: z.string().nullish(), Town: z.string().nullish(), Latitude: z.number(), Longitude: z.number() }),
  OperatorInfo: z.object({ Title: z.string().nullish() }).nullish(),
  DataProvider: z.object({ Title: z.string().nullish(), License: z.string().nullish() }).nullish(),
  Connections: z.array(z.object({ PowerKW: Num })).nullish(),
  DateLastStatusUpdate: z.string().nullish(),
});

export function ocmUrl(b: BBox, key: string): string {
  const box = `(${b.north},${b.west}),(${b.south},${b.east})`;
  return `${OCM_URL}?output=json&opendata=true&compact=false&verbose=false&maxresults=${OCM_MAX_RESULTS}&boundingbox=${encodeURIComponent(box)}&key=${encodeURIComponent(key)}`;
}

export const ocmOpenLicence = (l: string | null | undefined) => !!l && OCM_OPEN_LICENCES.some((x) => l.toLowerCase().includes(x.toLowerCase()));

export function normaliseOcm(raw: unknown, now: number): Poi[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Poi[] = [];
  for (const r of raw) {
    const p = Rec.safeParse(r);
    if (!p.success) continue;
    const d = p.data;
    const lic = d.DataProvider?.License;
    if (!ocmOpenLicence(lic)) continue;
    const kws = (d.Connections ?? []).map((c) => c.PowerKW ?? 0).filter((k) => k > 0);
    const updated = d.DateLastStatusUpdate ? Date.parse(d.DateLastStatusUpdate) : NaN;
    const address = [d.AddressInfo.AddressLine1, d.AddressInfo.Town].filter(Boolean).join(', ');
    const brand = d.OperatorInfo?.Title?.trim();
    out.push({
      id: `ocm:${d.ID}`,
      kind: 'charging',
      source: 'ocm',
      lat: d.AddressInfo.Latitude,
      lng: d.AddressInfo.Longitude,
      name: d.AddressInfo.Title?.trim() || null,
      ...(brand && !/unknown/i.test(brand) ? { brand } : {}),
      ...(address ? { address } : {}),
      ...(d.NumberOfPoints ? { sockets: d.NumberOfPoints } : {}),
      ...(kws.length ? { maxKw: Math.max(...kws) } : {}),
      credit: `${d.DataProvider?.Title ?? 'Open Charge Map'} · ${lic}`,
      at: Number.isFinite(updated) ? Math.min(updated, now) : now,
    });
  }
  return out;
}

const AREA_DEG = 0.5;
const areaKey = (b: BBox) => `${Math.floor(b.south / AREA_DEG)}:${Math.floor(b.west / AREA_DEG)}:${Math.floor(b.north / AREA_DEG)}:${Math.floor(b.east / AREA_DEG)}`;

export interface OcmSnapshot {
  areas: Record<string, { at: number; items: Poi[] }>;
}

export class OcmSource {
  readonly id = 'ocm' as const;
  readonly tracker = new HealthTracker('ocm');
  private areas = new Map<string, { at: number; items: Poi[] }>();
  private retryAt = 0;

  constructor(
    private readonly http: HttpGet,
    private readonly key: string,
    private readonly onRequest?: () => void,
  ) {
    if (!key) this.tracker.set('disabled', 'no API key configured', 0);
  }

  get enabled(): boolean {
    return this.key.length > 0;
  }

  health() {
    return this.tracker.get();
  }

  snapshot(): OcmSnapshot {
    return { areas: Object.fromEntries(this.areas) };
  }

  restore(s: OcmSnapshot | null, now: number): void {
    if (!s?.areas) return;
    for (const [k, v] of Object.entries(s.areas)) if (v && Array.isArray(v.items) && now - v.at <= OCM_MAX_AGE_MS) this.areas.set(k, v);
  }

  async refresh(b: BBox, now: number): Promise<boolean> {
    if (!this.enabled || now < this.retryAt) return false;
    const k = areaKey(b);
    const rec = this.areas.get(k);
    if (rec && now - rec.at < OCM_REFRESH_MS) return false;
    this.tracker.attempt(now);
    this.onRequest?.();
    try {
      const res = await this.http(ocmUrl(b, this.key), { 'X-API-Key': this.key });
      if (res.status !== 200) {
        this.retryAt = now + 3600_000;
        this.tracker.fail(now, res.status === 401 || res.status === 403 ? 'blocked' : 'degraded', `HTTP ${res.status}`, res.status);
        return false;
      }
      const got = normaliseOcm(await res.json(), now);
      if (!got) {
        this.tracker.fail(now, 'shapeChanged', 'not an Open Charge Map POI array');
        return false;
      }
      this.areas.set(k, { at: now, items: got });
      if (this.areas.size > 40) {
        const oldest = this.areas.keys().next().value;
        if (oldest !== undefined) this.areas.delete(oldest);
      }
      this.tracker.ok(now);
      return true;
    } catch (e) {
      this.retryAt = now + 3600_000;
      this.tracker.fail(now, 'degraded', (e as Error).message);
      return false;
    }
  }

  within(b: BBox, now: number): Poi[] {
    const seen = new Set<string>();
    const out: Poi[] = [];
    for (const v of this.areas.values()) {
      if (now - v.at > OCM_MAX_AGE_MS) continue;
      for (const p of v.items) {
        if (seen.has(p.id) || p.lat < b.south || p.lat > b.north || p.lng < b.west || p.lng > b.east) continue;
        seen.add(p.id);
        out.push(p);
      }
    }
    return out;
  }
}
