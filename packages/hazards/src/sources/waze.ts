import { z } from 'zod';
import { bboxContains, type BBox } from '@crewmap/shared/geo';
import { HealthTracker } from '../health';
import { DEFAULT_TTL_MS, type FetchContext, type Hazard, type HazardSource, type HazardType, type HttpGet } from '../types';

/**
 * Waze Live Map adapter. Reads the JSON that waze.com/live-map loads for a map area. The endpoint is
 * undocumented: responses are schema-validated, failures feed a health check, and a signed kill switch from the
 * circle owner can disable it. No block evasion (no proxies, spoofed tokens or captcha solving).
 */
export const WAZE_LIVE_MAP_URL = 'https://www.waze.com/live-map/api/georss';
export const WAZE_MIN_INTERVAL_MS = 2 * 60_000;

const WazeAlert = z.object({
  uuid: z.string(),
  type: z.string(),
  subtype: z.string().nullish(),
  location: z.object({ x: z.number(), y: z.number() }),
  street: z.string().nullish(),
  city: z.string().nullish(),
  pubMillis: z.number(),
  reliability: z.number().nullish(),
  confidence: z.number().nullish(),
  nThumbsUp: z.number().nullish(),
  magvar: z.number().nullish(),
  reportDescription: z.string().nullish(),
});

const WazeJam = z.object({
  uuid: z.union([z.string(), z.number()]),
  line: z.array(z.object({ x: z.number(), y: z.number() })).min(2),
  street: z.string().nullish(),
  level: z.number().nullish(),
  speedKMH: z.number().nullish(),
  pubMillis: z.number().nullish(),
});

export const WazeResponse = z.object({
  alerts: z.array(z.unknown()).default([]),
  jams: z.array(z.unknown()).default([]),
});

export type WazeAlertT = z.infer<typeof WazeAlert>;

/** Waze type/subtype → our type. */
export function mapWazeType(type: string, subtype: string | null | undefined): HazardType | null {
  const st = subtype ?? '';
  switch (type) {
    case 'POLICE':
      return st.includes('CAMERA') ? 'speedTrap' : 'police';
    case 'ACCIDENT':
      return 'accident';
    case 'ROAD_CLOSED':
      return st.includes('CONSTRUCTION') ? 'construction' : 'closure';
    case 'HAZARD':
      if (st.includes('POT_HOLE')) return 'pothole';
      if (st.includes('CONSTRUCTION')) return 'construction';
      return 'hazard';
    case 'JAM':
      return 'jam';
    case 'CONSTRUCTION':
      return 'construction';
    default:
      return null;
  }
}

export function normaliseWazeAlert(a: WazeAlertT, now: number): Hazard | null {
  const type = mapWazeType(a.type, a.subtype);
  if (!type) return null;
  const reportedAt = a.pubMillis;
  return {
    id: `waze:${a.uuid}`,
    source: 'waze',
    type,
    subtype: a.subtype || null,
    lat: a.location.y,
    lng: a.location.x,
    heading: a.magvar ?? null,
    street: a.street ?? a.city ?? null,
    reportedAt,
    // Waze alerts carry no expiry: keep for the type TTL after the later of report and fetch.
    expiresAt: Math.max(reportedAt, now) + Math.min(DEFAULT_TTL_MS[type], 60 * 60_000),
    reliability: Math.max(0, Math.min(10, a.reliability ?? 5)),
    confirmations: a.nThumbsUp ?? 0,
    ...(a.reportDescription ? { description: a.reportDescription } : {}),
  };
}

export interface ParsedWaze {
  hazards: Hazard[];
  /** Items that failed validation — many failures means the shape changed. */
  invalid: number;
  total: number;
}

export function parseWazeResponse(body: unknown, now: number): ParsedWaze {
  const top = WazeResponse.safeParse(body);
  if (!top.success) throw new ShapeError(`top-level: ${top.error.issues[0]?.message ?? 'invalid'}`);
  const hazards: Hazard[] = [];
  let invalid = 0;
  for (const raw of top.data.alerts) {
    const a = WazeAlert.safeParse(raw);
    if (!a.success) {
      invalid++;
      continue;
    }
    const h = normaliseWazeAlert(a.data, now);
    if (h) hazards.push(h);
  }
  for (const raw of top.data.jams) {
    const j = WazeJam.safeParse(raw);
    if (!j.success) {
      invalid++;
      continue;
    }
    if ((j.data.level ?? 0) < 3) continue; // only heavy/standstill jams
    const mid = j.data.line[Math.floor(j.data.line.length / 2)]!;
    const reportedAt = j.data.pubMillis ?? now;
    hazards.push({
      id: `waze:jam:${j.data.uuid}`,
      source: 'waze',
      type: 'jam',
      subtype: `LEVEL_${j.data.level ?? 0}`,
      lat: mid.y,
      lng: mid.x,
      heading: null,
      street: j.data.street ?? null,
      reportedAt,
      expiresAt: now + DEFAULT_TTL_MS.jam,
      reliability: 7,
      confirmations: 0,
      line: j.data.line.map((p) => [p.x, p.y]),
    });
  }
  const total = top.data.alerts.length + top.data.jams.length;
  if (total > 0 && invalid / total > 0.5) throw new ShapeError(`${invalid}/${total} items failed validation`);
  return { hazards, invalid, total };
}

export class ShapeError extends Error {}

export function wazeUrl(b: BBox): string {
  const f = (n: number) => n.toFixed(5);
  return `${WAZE_LIVE_MAP_URL}?top=${f(b.north)}&bottom=${f(b.south)}&left=${f(b.west)}&right=${f(b.east)}&env=na&types=alerts,traffic`;
}

/** Area key for throttling: bbox snapped to a ~5 km grid. */
export function areaKey(b: BBox): string {
  const g = 0.05;
  return [b.south, b.west, b.north, b.east].map((v) => Math.round(v / g)).join(',');
}

export class WazeLiveMapSource implements HazardSource {
  readonly id = 'waze' as const;
  readonly tracker = new HealthTracker('waze');
  private enabled = true;
  private readonly lastFetch = new Map<string, { at: number; hazards: Hazard[]; bbox: BBox }>();

  constructor(private readonly http: HttpGet) {}

  /** Kill switch (signed config from the circle owner). */
  setEnabled(on: boolean, now: number): void {
    this.enabled = on;
    if (!on) this.tracker.set('disabled', 'kill switch', now);
    else if (this.tracker.get().status === 'disabled') this.tracker.set('ok', 'kill switch lifted', now);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  health() {
    return this.tracker.get();
  }

  /** Usable unless killed, blocked or shape-changed (those stick until a retry window passes). */
  usable(now: number): boolean {
    if (!this.enabled) return false;
    const h = this.tracker.get();
    if (h.status === 'blocked' || h.status === 'shapeChanged') {
      // Retry at most every 30 minutes after a hard failure.
      return h.lastAttemptAt === null || now - h.lastAttemptAt > 30 * 60_000;
    }
    return true;
  }

  async fetch(ctx: FetchContext): Promise<Hazard[]> {
    if (!this.enabled) return [];
    const key = areaKey(ctx.bbox);
    const prev = this.lastFetch.get(key);
    // ≤ 1 request / 2 min / area: serve the cache in between.
    if (prev && ctx.now - prev.at < WAZE_MIN_INTERVAL_MS) {
      return prev.hazards.filter((h) => bboxContains(ctx.bbox, h) && h.expiresAt > ctx.now);
    }
    if (!this.usable(ctx.now)) return [];
    this.tracker.attempt(ctx.now);
    let res: Awaited<ReturnType<HttpGet>>;
    try {
      res = await this.http(wazeUrl(ctx.bbox), { Accept: 'application/json' });
    } catch (e) {
      this.tracker.fail(ctx.now, 'degraded', `network: ${(e as Error).message}`);
      return prev?.hazards ?? [];
    }
    if (res.status === 403 || res.status === 429 || res.status === 401) {
      this.tracker.fail(ctx.now, 'blocked', `HTTP ${res.status}`, res.status);
      return [];
    }
    if (res.status !== 200) {
      this.tracker.fail(ctx.now, 'degraded', `HTTP ${res.status}`, res.status);
      return prev?.hazards ?? [];
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // HTML challenge pages come back as 200 sometimes.
      this.tracker.fail(ctx.now, 'blocked', 'non-JSON response (challenge page?)', 200);
      return [];
    }
    try {
      const parsed = parseWazeResponse(body, ctx.now);
      this.tracker.ok(ctx.now);
      this.lastFetch.set(key, { at: ctx.now, hazards: parsed.hazards, bbox: ctx.bbox });
      return parsed.hazards;
    } catch (e) {
      this.tracker.fail(ctx.now, 'shapeChanged', (e as Error).message);
      return [];
    }
  }
}
