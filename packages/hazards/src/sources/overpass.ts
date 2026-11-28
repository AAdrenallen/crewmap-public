import { z } from 'zod';
import type { BBox } from '@crewmap/shared/geo';
import type { HealthTracker } from '../health';
import type { HttpGet } from '../types';

/**
 * Shared Overpass cell cache (D61, reused by D64): the area is cut into 0.5° cells, each fetched at most once per
 * refresh window, a few cells per call, with exponential backoff (15 min → 24 h) and rotation between the public
 * instances. Cells persist on the device; `cached()` never touches the network.
 */
export const OSM_OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'] as const;
/** Overpass asks apps to identify themselves (User-Agent or Referer). */
export const OSM_HEADERS = { 'User-Agent': 'CrewMap/1 (private crew navigation app; cached weekly lookups)' };
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors, ODbL';
/** Cell size (deg). */
export const OSM_CELL_DEG = 0.5;
/** Re-download a cell at most this often. */
export const OSM_REFRESH_MS = 7 * 86_400_000;
/** A cached cell older than this (every refresh failed) is dropped. */
export const OSM_MAX_CACHE_AGE_MS = 60 * 86_400_000;
/** Cells fetched per call; the rest wait for later cycles. */
export const OSM_MAX_CELLS_PER_FETCH = 4;
/** Areas wider than this many cells are not fetched at all (a zoomed-out map is not a drive). */
export const OSM_MAX_CELLS = 36;
export const OSM_BACKOFF_MIN_MS = 15 * 60_000;
export const OSM_BACKOFF_MAX_MS = 24 * 3600_000;

export interface OsmCell {
  key: string;
  bbox: BBox;
}

/** 0.5° cells covering `b`, or null when the area is too large to be worth fetching. */
export function osmCells(b: BBox): OsmCell[] | null {
  const s = Math.floor(b.south / OSM_CELL_DEG);
  const w = Math.floor(b.west / OSM_CELL_DEG);
  const n = Math.floor(b.north / OSM_CELL_DEG);
  const e = Math.floor(b.east / OSM_CELL_DEG);
  if ((n - s + 1) * (e - w + 1) > OSM_MAX_CELLS) return null;
  const out: OsmCell[] = [];
  for (let y = s; y <= n; y++) {
    for (let x = w; x <= e; x++) {
      out.push({ key: `${y}:${x}`, bbox: { south: y * OSM_CELL_DEG, west: x * OSM_CELL_DEG, north: (y + 1) * OSM_CELL_DEG, east: (x + 1) * OSM_CELL_DEG } });
    }
  }
  return out;
}

export const overpassUrl = (endpoint: string, query: string) => `${endpoint}?data=${encodeURIComponent(query)}`;

const Resp = z.object({ elements: z.array(z.unknown()) });

export interface CellRecord<T> {
  at: number;
  items: T[];
}

export interface OverpassCellOptions<T> {
  query: (b: BBox) => string;
  normalise: (elements: unknown[], cell: BBox, now: number) => T[];
  refreshMs?: number;
  maxAgeMs?: number;
  /** Called once per network request (Diagnostics counters). */
  onRequest?: () => void;
}

export class OverpassCells<T extends { lat: number; lng: number }> {
  private cells = new Map<string, CellRecord<T>>();
  private failures = 0;
  private retryAt = 0;
  private endpoint = 0;
  private readonly refreshMs: number;
  private readonly maxAgeMs: number;

  constructor(
    private readonly http: HttpGet,
    private readonly tracker: HealthTracker,
    private readonly opts: OverpassCellOptions<T>,
    private readonly endpoints: readonly string[] = OSM_OVERPASS_ENDPOINTS,
  ) {
    this.refreshMs = opts.refreshMs ?? OSM_REFRESH_MS;
    this.maxAgeMs = opts.maxAgeMs ?? OSM_MAX_CACHE_AGE_MS;
  }

  snapshot(): Record<string, CellRecord<T>> {
    return Object.fromEntries(this.cells);
  }

  restore(cells: Record<string, CellRecord<T>> | null | undefined, now: number): void {
    if (!cells || typeof cells !== 'object') return;
    for (const [k, v] of Object.entries(cells)) {
      if (v && Array.isArray(v.items) && typeof v.at === 'number' && now - v.at <= this.maxAgeMs) this.cells.set(k, v);
    }
  }

  nextAttemptAt(): number {
    return this.retryAt;
  }

  private backoff(now: number): void {
    this.failures++;
    this.retryAt = now + Math.min(OSM_BACKOFF_MAX_MS, OSM_BACKOFF_MIN_MS * 2 ** (this.failures - 1));
    this.endpoint = (this.endpoint + 1) % this.endpoints.length;
  }

  private async fetchCell(cell: OsmCell, now: number): Promise<boolean> {
    this.opts.onRequest?.();
    const res = await this.http(overpassUrl(this.endpoints[this.endpoint]!, this.opts.query(cell.bbox)), OSM_HEADERS);
    if (res.status !== 200) {
      this.tracker.fail(now, res.status === 403 ? 'blocked' : 'degraded', `HTTP ${res.status}`, res.status);
      return false;
    }
    const r = Resp.safeParse(await res.json());
    if (!r.success) {
      this.tracker.fail(now, 'shapeChanged', 'not an Overpass JSON result');
      return false;
    }
    this.cells.set(cell.key, { at: now, items: this.opts.normalise(r.data.elements, cell.bbox, now) });
    if (this.cells.size > 64) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of this.cells) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldestKey = k;
        }
      }
      if (oldestKey) this.cells.delete(oldestKey);
    }
    return true;
  }

  /** Fetch the cells of `b` that are due (unless backing off). Returns true when something new was stored. */
  async refresh(b: BBox, now: number): Promise<boolean> {
    const cells = osmCells(b);
    if (!cells) return false;
    const due = cells.filter((c) => {
      const rec = this.cells.get(c.key);
      return !rec || now - rec.at >= this.refreshMs;
    });
    if (!due.length || now < this.retryAt) return false;
    this.tracker.attempt(now);
    let stored = false;
    for (const c of due.slice(0, OSM_MAX_CELLS_PER_FETCH)) {
      let ok = false;
      try {
        ok = await this.fetchCell(c, now);
      } catch (e) {
        this.tracker.fail(now, 'degraded', (e as Error).message);
      }
      if (!ok) {
        this.backoff(now);
        return stored;
      }
      stored = true;
    }
    this.failures = 0;
    this.retryAt = 0;
    this.tracker.ok(now);
    return stored;
  }

  /** Items already on this phone inside `b` (no network), with the time their cell was fetched. Works for any route size. */
  cached(b: BBox, now: number): { item: T; at: number }[] {
    const out: { item: T; at: number }[] = [];
    const s = Math.floor(b.south / OSM_CELL_DEG);
    const w = Math.floor(b.west / OSM_CELL_DEG);
    const n = Math.floor(b.north / OSM_CELL_DEG);
    const e = Math.floor(b.east / OSM_CELL_DEG);
    for (const [key, rec] of this.cells) {
      if (now - rec.at > this.maxAgeMs) continue;
      const [ys, xs] = key.split(':');
      const y = Number(ys);
      const x = Number(xs);
      if (y < s || y > n || x < w || x > e) continue;
      for (const it of rec.items) {
        if (it.lat < b.south || it.lat > b.north || it.lng < b.west || it.lng > b.east) continue;
        out.push({ item: it, at: rec.at });
      }
    }
    return out;
  }
}
