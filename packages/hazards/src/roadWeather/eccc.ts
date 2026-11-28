import { z } from 'zod';
import type { BBox } from '@crewmap/shared/geo';
import { HealthTracker } from '../health';
import type { HttpGet } from '../types';
import { ECCC_NAME_RULES, ECCC_TEXT_SLIPPERY, ECCC_TYPES, ROAD_WEATHER, type RoadWeatherCategory } from './thresholds';

/**
 * Environment and Climate Change Canada public weather alerts (MSC GeoMet OGC API, `weather-alerts` collection; ECCC
 * Data Server End-use Licence: "Data Source: Environment and Climate Change Canada"). No key; one bbox query per
 * refresh. Each alert is published as one feature per forecast region; regions of the same alert share a key.
 */
export const ECCC_ALERTS_URL = 'https://api.weather.gc.ca/collections/weather-alerts/items';
export const ECCC_CREDIT = 'Data Source: Environment and Climate Change Canada';

export function ecccUrl(b: BBox): string {
  const bbox = [b.west, b.south, b.east, b.north].map((x) => x.toFixed(3)).join(',');
  return `${ECCC_ALERTS_URL}?f=json&limit=500&bbox=${bbox}`;
}

/** Polygon rings as [lng, lat] (first ring outer, others holes). */
export type Rings = [number, number][][];

export interface WeatherAlert {
  /** `eccc:<code>:<publication time>`: shared by every region of one alert, so it is announced once. */
  key: string;
  category: RoadWeatherCategory;
  nameEn: string;
  nameFr: string;
  polygons: Rings[];
  bbox: BBox;
  issuedAt: number;
  expiresAt: number;
}

const Pos = z.tuple([z.number(), z.number()]).rest(z.number());
const Ring = z.array(Pos).min(4);
const Geometry = z.union([
  z.object({ type: z.literal('Polygon'), coordinates: z.array(Ring).min(1) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(Ring).min(1)).min(1) }),
]);
const Props = z.object({
  alert_code: z.string(),
  alert_type: z.string(),
  alert_name_en: z.string(),
  alert_name_fr: z.string().nullish(),
  alert_short_name_en: z.string().nullish(),
  alert_short_name_fr: z.string().nullish(),
  alert_text_en: z.string().nullish(),
  status_en: z.string().nullish(),
  publication_datetime: z.string(),
  expiration_datetime: z.string().nullish(),
  event_end_datetime: z.string().nullish(),
});
const Feature = z.object({ properties: Props, geometry: Geometry });
const FC = z.object({ type: z.literal('FeatureCollection'), features: z.array(z.unknown()) });

export function ecccCategory(name: string, type: string, text: string | null | undefined): RoadWeatherCategory | null {
  if (!ECCC_TYPES.has(type)) return null;
  for (const r of ECCC_NAME_RULES) if (r.re.test(name)) return r.category;
  return text && ECCC_TEXT_SLIPPERY.test(text) ? 'slippery' : null;
}

const ms = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

function ringsBbox(polys: Rings[]): BBox {
  let south = 90, north = -90, west = 180, east = -180;
  for (const p of polys)
    for (const [lng, lat] of p[0] ?? []) {
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
    }
  return { south, north, west, east };
}

/** Road-relevant, active alerts grouped by alert. Returns null when the payload is not the expected shape. */
export function normaliseEccc(raw: unknown, now: number): WeatherAlert[] | null {
  const fc = FC.safeParse(raw);
  if (!fc.success) return null;
  const byKey = new Map<string, WeatherAlert>();
  for (const f of fc.data.features) {
    const o = Feature.safeParse(f);
    if (!o.success) continue;
    const p = o.data.properties;
    if (p.status_en === 'ended') continue;
    const category = ecccCategory(p.alert_name_en, p.alert_type, p.alert_text_en);
    if (!category) continue;
    const issuedAt = ms(p.publication_datetime);
    const expiresAt = Math.min(ms(p.expiration_datetime) ?? Infinity, ms(p.event_end_datetime) ?? Infinity);
    if (issuedAt === null || !Number.isFinite(expiresAt) || expiresAt <= now) continue;
    const g = o.data.geometry;
    const polys: Rings[] = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((rs) => rs.map((r) => r.map((c) => [c[0], c[1]] as [number, number])));
    const pb = ringsBbox(polys);
    const key = `eccc:${p.alert_code}:${p.publication_datetime}`;
    const cur = byKey.get(key);
    if (cur) {
      cur.polygons.push(...polys);
      cur.expiresAt = Math.max(cur.expiresAt, expiresAt);
      cur.bbox = {
        south: Math.min(cur.bbox.south, pb.south),
        north: Math.max(cur.bbox.north, pb.north),
        west: Math.min(cur.bbox.west, pb.west),
        east: Math.max(cur.bbox.east, pb.east),
      };
    } else {
      byKey.set(key, {
        key,
        category,
        nameEn: p.alert_short_name_en ?? p.alert_name_en,
        nameFr: p.alert_short_name_fr ?? p.alert_name_fr ?? p.alert_name_en,
        polygons: polys,
        bbox: pb,
        issuedAt,
        expiresAt,
      });
    }
  }
  return [...byKey.values()];
}

export interface EcccSnapshot {
  at: number;
  bbox: BBox | null;
  alerts: WeatherAlert[];
}

const inside = (outer: BBox, inner: BBox) => inner.south >= outer.south && inner.north <= outer.north && inner.west >= outer.west && inner.east <= outer.east;

/** Fetches alerts for the active route's bbox on the navigating phone (polygons are too heavy to share over P2P). */
export class EcccAlertSource {
  readonly id = 'eccc' as const;
  readonly tracker = new HealthTracker('eccc');
  private snap: EcccSnapshot = { at: 0, bbox: null, alerts: [] };
  private triedAt = 0;

  constructor(
    private readonly http: HttpGet,
    private readonly onRequest?: () => void,
  ) {}

  health() {
    return this.tracker.get();
  }

  snapshot(): EcccSnapshot {
    return this.snap;
  }

  restore(s: EcccSnapshot | null, now: number): void {
    if (!s || !Array.isArray(s.alerts) || typeof s.at !== 'number' || now - s.at > ROAD_WEATHER.maxAgeMs) return;
    this.snap = s;
  }

  /** Active alerts (cached), whatever the area they were fetched for. */
  alerts(now: number): WeatherAlert[] {
    if (now - this.snap.at > ROAD_WEATHER.maxAgeMs) return [];
    return this.snap.alerts.filter((a) => a.expiresAt > now);
  }

  /** Fetches when the cache is older than `refreshMs` or does not cover `area`. True when new data arrived. */
  async refresh(area: BBox, now: number): Promise<boolean> {
    const fresh = now - this.snap.at < ROAD_WEATHER.refreshMs && this.snap.bbox && inside(this.snap.bbox, area);
    if (fresh || now - this.triedAt < 60_000) return false;
    this.triedAt = now;
    this.tracker.attempt(now);
    this.onRequest?.();
    try {
      const res = await this.http(ecccUrl(area), { Accept: 'application/geo+json' });
      if (res.status !== 200) {
        this.tracker.fail(now, res.status === 403 || res.status === 429 ? 'blocked' : 'degraded', `HTTP ${res.status}`, res.status);
        return false;
      }
      const alerts = normaliseEccc(await res.json(), now);
      if (!alerts) {
        this.tracker.fail(now, 'shapeChanged', 'unexpected payload');
        return false;
      }
      this.snap = { at: now, bbox: area, alerts };
      this.tracker.ok(now);
      return true;
    } catch (e) {
      this.tracker.fail(now, 'degraded', e instanceof Error ? e.message : String(e));
      return false;
    }
  }
}
