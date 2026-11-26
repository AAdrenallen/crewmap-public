import type { BBox } from '@crewmap/shared/geo';
import type { HealthLogEntry } from './health';
import { DEFAULT_HAZARD_CONFIG, type HazardConfig } from './killSwitch';
import { mergeHazards, type MergedHazard } from './merge';
import type { MontrealSource } from './sources/montreal';
import type { QuebecSource } from './sources/quebec';
import type { WazePaidSource } from './sources/wazePaid';
import type { FetchContext, Hazard, SourceHealth } from './types';

/** Official feeds refresh interval (MTMD WFS is near-real-time; Montréal is daily but cheap). */
export const OFFICIAL_REFRESH_MS = 15 * 60_000;
/** While someone drives, events are due every 5 min (per-layer intervals: qcLayerIntervalMs). */
export const OFFICIAL_REFRESH_DRIVING_MS = 5 * 60_000;

export interface HazardServiceDeps {
  paid: WazePaidSource;
  quebec: QuebecSource;
  /** Ville de Montréal entraves (optional: only useful when the circle drives on the island). */
  montreal?: MontrealSource;
}

/**
 * Orchestrates sources with graceful degradation: the paid Waze API only if the owner enabled it and it is under its
 * cap (the Waze Live Map is never requested: D40); Québec feeds on the chore peer; Mapbox incidents, crew reports and
 * the anonymous public network always. Shared hazards from friends' phones are mixed in via `ingestShared`.
 */
export class HazardService {
  private config: HazardConfig = { ...DEFAULT_HAZARD_CONFIG };
  private shared = new Map<string, Hazard>();
  private quebecCache: Hazard[] = [];
  private quebecAt = 0;
  readonly log: HealthLogEntry[] = [];

  constructor(private readonly d: HazardServiceDeps) {
    for (const t of [d.paid.tracker, d.quebec.tracker, ...(d.montreal ? [d.montreal.tracker] : [])]) {
      t.onTransition((e) => {
        this.log.push(e);
        if (this.log.length > 200) this.log.shift();
      });
    }
  }

  setConfig(c: HazardConfig, _now: number): void {
    this.config = c;
  }

  getConfig(): HazardConfig {
    return { ...this.config };
  }

  health(): SourceHealth[] {
    return [this.d.paid.health(), this.d.quebec.health(), ...(this.d.montreal ? [this.d.montreal.health()] : [])];
  }

  /** Fetch the paid Waze API for the route/viewport bbox when enabled. Returns what this phone fetched, to share. */
  async fetchWaze(ctx: FetchContext): Promise<Hazard[]> {
    if (this.config.paidEnabled && this.d.paid.enabled()) return this.d.paid.fetch(ctx);
    return [];
  }

  /**
   * Official feeds (MTMD + Ville de Montréal): run by the elected chore peer, at most every 15 min. A failed fetch
   * keeps the previous records, which still expire on their own TTL (feedExpiry), so nothing stale outlives 2 h.
   */
  async fetchOfficial(bbox: BBox, now: number, driving = false): Promise<Hazard[]> {
    if (now - this.quebecAt < (driving ? OFFICIAL_REFRESH_DRIVING_MS : OFFICIAL_REFRESH_MS)) return this.quebecCache.filter((h) => h.expiresAt > now);
    this.quebecAt = now;
    const ctx: FetchContext = { bbox, now, reason: driving ? 'driving' : 'chore' };
    const [qc, mtl] = await Promise.all([this.d.quebec.fetch(ctx), this.d.montreal ? this.d.montreal.fetch(ctx) : Promise.resolve([])]);
    const keep = (src: Hazard['source'], got: Hazard[], ok: boolean) => (ok ? got : this.quebecCache.filter((h) => h.source === src && h.expiresAt > now));
    this.quebecCache = [
      ...keep('quebec', qc, this.d.quebec.health().status === 'ok' || qc.length > 0),
      ...keep('montreal', mtl, !this.d.montreal || this.d.montreal.health().status === 'ok' || mtl.length > 0),
    ];
    return this.quebecCache;
  }
  /** Normalised hazards received from circle members (their paid-API fetches, Québec chore results). */
  ingestShared(hs: Hazard[], now: number): void {
    for (const h of hs) if (h.expiresAt > now) this.shared.set(h.id, h);
    for (const [id, h] of this.shared) if (h.expiresAt <= now) this.shared.delete(id);
  }

  merged(local: Hazard[], now: number): MergedHazard[] {
    return mergeHazards([...local, ...this.quebecCache, ...this.shared.values()], now);
  }
}
