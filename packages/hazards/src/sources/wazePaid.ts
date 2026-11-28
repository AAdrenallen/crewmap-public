import { z } from 'zod';
import type { BBox } from '@crewmap/shared/geo';
import { HealthTracker } from '../health';
import { DEFAULT_TTL_MS, type FetchContext, type Hazard, type HazardSource, type HttpGet } from '../types';
import { mapWazeType, areaKey, WAZE_MIN_INTERVAL_MS } from './waze';

/**
 * Paid fallback (OFF by default): OpenWeb Ninja's hosted Waze API, `GET /waze/alerts-and-jams`.
 * Cost per request is recorded in docs/DECISIONS.md D11. A hard monthly cap (USD) is enforced on-device; only the
 * circle's chore peer calls it, and results are shared with the circle.
 */
export const PAID_URL = 'https://api.openwebninja.com/waze/alerts-and-jams';
export const PAID_COST_USD_PER_REQUEST = 0.005;

const PaidAlert = z.object({
  alert_id: z.union([z.string(), z.number()]),
  type: z.string(),
  subtype: z.string().nullish(),
  latitude: z.number(),
  longitude: z.number(),
  street: z.string().nullish(),
  city: z.string().nullish(),
  publish_datetime_utc: z.string().nullish(),
  num_thumbs_up: z.number().nullish(),
  alert_reliability: z.number().nullish(),
});
const PaidResponse = z.object({ status: z.string(), data: z.object({ alerts: z.array(z.unknown()).default([]) }) });

export interface SpendLedger {
  /** USD spent in the calendar month of `now`. */
  spent(now: number): number;
  add(now: number, usd: number): void;
}

export function monthKey(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export class MemoryLedger implements SpendLedger {
  private readonly m = new Map<string, number>();
  spent(now: number): number {
    return this.m.get(monthKey(now)) ?? 0;
  }
  add(now: number, usd: number): void {
    this.m.set(monthKey(now), this.spent(now) + usd);
  }
}

export class WazePaidSource implements HazardSource {
  readonly id = 'waze-paid' as const;
  readonly tracker = new HealthTracker('waze-paid');
  private readonly cache = new Map<string, { at: number; hazards: Hazard[] }>();

  constructor(
    private readonly http: HttpGet,
    private readonly apiKey: string,
    private readonly monthlyCapUsd: number,
    private readonly ledger: SpendLedger,
  ) {
    if (!apiKey || monthlyCapUsd <= 0) this.tracker.set('disabled', 'no API key or cap = 0', 0);
  }

  enabled(): boolean {
    return this.apiKey !== '' && this.monthlyCapUsd > 0;
  }

  health() {
    return this.tracker.get();
  }

  url(b: BBox): string {
    const p = new URLSearchParams({
      bottom_left: `${b.south.toFixed(5)},${b.west.toFixed(5)}`,
      top_right: `${b.north.toFixed(5)},${b.east.toFixed(5)}`,
      max_alerts: '200',
      max_jams: '50',
    });
    return `${PAID_URL}?${p.toString()}`;
  }

  async fetch(ctx: FetchContext): Promise<Hazard[]> {
    if (!this.enabled()) return [];
    const key = areaKey(ctx.bbox);
    const c = this.cache.get(key);
    if (c && ctx.now - c.at < WAZE_MIN_INTERVAL_MS) return c.hazards;
    if (this.ledger.spent(ctx.now) + PAID_COST_USD_PER_REQUEST > this.monthlyCapUsd) {
      this.tracker.set('capReached', `monthly cap US$${this.monthlyCapUsd} reached`, ctx.now);
      return c?.hazards ?? [];
    }
    this.tracker.attempt(ctx.now);
    try {
      const res = await this.http(this.url(ctx.bbox), { 'X-API-Key': this.apiKey, Accept: 'application/json' });
      if (res.status !== 200) {
        this.tracker.fail(ctx.now, res.status === 401 || res.status === 403 ? 'blocked' : 'degraded', `HTTP ${res.status}`, res.status);
        return c?.hazards ?? [];
      }
      this.ledger.add(ctx.now, PAID_COST_USD_PER_REQUEST);
      const body = PaidResponse.safeParse(await res.json());
      if (!body.success) {
        this.tracker.fail(ctx.now, 'shapeChanged', body.error.issues[0]?.message ?? 'invalid');
        return [];
      }
      const hazards: Hazard[] = [];
      for (const raw of body.data.data.alerts) {
        const a = PaidAlert.safeParse(raw);
        if (!a.success) continue;
        const type = mapWazeType(a.data.type, a.data.subtype);
        if (!type) continue;
        const reportedAt = a.data.publish_datetime_utc ? Date.parse(a.data.publish_datetime_utc) || ctx.now : ctx.now;
        hazards.push({
          id: `waze:${a.data.alert_id}`,
          source: 'waze-paid',
          type,
          subtype: a.data.subtype || null,
          lat: a.data.latitude,
          lng: a.data.longitude,
          heading: null,
          street: a.data.street ?? a.data.city ?? null,
          reportedAt,
          expiresAt: Math.max(reportedAt, ctx.now) + Math.min(DEFAULT_TTL_MS[type], 60 * 60_000),
          reliability: Math.max(0, Math.min(10, a.data.alert_reliability ?? 5)),
          confirmations: a.data.num_thumbs_up ?? 0,
        });
      }
      this.tracker.ok(ctx.now);
      this.cache.set(key, { at: ctx.now, hazards });
      return hazards;
    } catch (e) {
      this.tracker.fail(ctx.now, 'degraded', (e as Error).message);
      return c?.hazards ?? [];
    }
  }
}
