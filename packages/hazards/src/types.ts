import type { BBox } from '@crewmap/shared/geo';

export type HazardSourceId = 'waze' | 'waze-paid' | 'quebec' | 'montreal' | 'mapbox' | 'friends' | 'anon';

export type HazardType =
  | 'police'
  | 'speedTrap'
  | 'camera'
  | 'accident'
  | 'hazard'
  | 'closure'
  | 'construction'
  | 'jam'
  | 'pothole';

/** The one schema every source normalises into (prompt §F4). */
export interface Hazard {
  /** `${source}:${sourceId}` */
  id: string;
  source: HazardSourceId;
  type: HazardType;
  /** Source-specific detail, e.g. POLICE_HIDING, "Radar photo fixe", "Fermeture complète". */
  subtype: string | null;
  lat: number;
  lng: number;
  /** Direction of travel the report applies to (deg), null if unknown. */
  heading: number | null;
  street: string | null;
  /** Epoch ms. */
  reportedAt: number;
  /** Epoch ms. Hidden after this unless the source re-asserts it (NIP-40-like TTL). */
  expiresAt: number;
  /** Planned end of the works/closure as published by the source (detail screen), if any. */
  endsAt?: number;
  /** 0–10. */
  reliability: number;
  /** Thumbs-up / upvotes / confirmations. */
  confirmations: number;
  /** Optional line geometry (works, closures) as [lng, lat] pairs. */
  line?: [number, number][];
  description?: string;
  /** Position is a grid-cell centre: the report lies within this many metres (anonymous network). */
  uncertaintyM?: number;
  /** Id of the same report on the anonymous network (`anon:<event id>`), so it is not counted twice. */
  alsoAs?: string;
  /** Reporter device id (friend reports only). */
  by?: string;
}

export type HealthStatus = 'ok' | 'degraded' | 'blocked' | 'shapeChanged' | 'disabled' | 'capReached';

export interface SourceHealth {
  source: HazardSourceId;
  status: HealthStatus;
  lastOkAt: number | null;
  lastAttemptAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  /** HTTP status of the last failure, if any. */
  lastHttpStatus: number | null;
}

export interface FetchContext {
  bbox: BBox;
  now: number;
  /** Why we fetch: someone is driving or has the map open (Waze throttling rule). */
  reason: 'driving' | 'mapOpen' | 'chore';
}

export interface HazardSource {
  readonly id: HazardSourceId;
  fetch(ctx: FetchContext): Promise<Hazard[]>;
  health(): SourceHealth;
}

/** Injected HTTP client (fetch-compatible) so tests run against recorded fixtures. */
export type HttpGet = (url: string, headers?: Record<string, string>) => Promise<{
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  /** Response headers (ETag / Last-Modified for conditional GET); optional for test doubles. */
  headers?: { get(name: string): string | null };
}>;

export const DEFAULT_TTL_MS: Record<HazardType, number> = {
  police: 60 * 60_000,
  speedTrap: 60 * 60_000,
  camera: 30 * 86_400_000,
  accident: 2 * 3600_000,
  hazard: 2 * 3600_000,
  closure: 6 * 3600_000,
  construction: 7 * 86_400_000,
  jam: 30 * 60_000,
  pothole: 30 * 86_400_000,
};

/**
 * Official feeds are re-fetched every 15 min by the chore peer and shared with the circle. A record cleared early
 * (gone from the feed) must not linger on peers: each fetch re-asserts it for this long, never past its published end.
 */
export const OFFICIAL_FEED_TTL_MS = 2 * 3600_000;

export function feedExpiry(now: number, endsAt: number | null): number {
  return endsAt === null ? now + OFFICIAL_FEED_TTL_MS : Math.min(endsAt, now + OFFICIAL_FEED_TTL_MS);
}
