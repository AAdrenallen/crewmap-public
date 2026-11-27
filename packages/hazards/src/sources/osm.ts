import { z } from 'zod';
import type { BBox } from '@crewmap/shared/geo';
import { HealthTracker } from '../health';
import { OSM_OVERPASS_ENDPOINTS, OverpassCells, overpassUrl } from './overpass';
import { feedExpiry, type FetchContext, type Hazard, type HazardSource, type HttpGet } from '../types';

/**
 * OpenStreetMap fixed enforcement devices (ODbL 1.0, "© OpenStreetMap contributors"), read through the public Overpass
 * API (D61): nodes tagged `highway=speed_camera` plus `device` members of `type=enforcement` relations
 * (`enforcement=maxspeed | traffic_signals | average_speed | ...`). Covers places with no official camera feed
 * (Ontario, the rest of Canada, abroad); in Québec it overlaps MTMD photo radars and merges with them (60 m radius).
 *
 * Overpass is a shared volunteer service whose public instances say heavy automated use should self-host. So the
 * load is tiny: the area is cut into 0.5° cells, each cell is fetched at most once a week, at most a few cells per
 * cycle, only by the chore peer, and failures back off exponentially (15 min → 24 h). Cells are persisted on the
 * device (snapshot/restore) and the result is shared with the circle, so most phones never call Overpass.
 */
export { OSM_OVERPASS_ENDPOINTS, OSM_HEADERS, OSM_ATTRIBUTION, OSM_CELL_DEG, OSM_REFRESH_MS, OSM_MAX_CACHE_AGE_MS, OSM_MAX_CELLS_PER_FETCH, OSM_MAX_CELLS, OSM_BACKOFF_MIN_MS, OSM_BACKOFF_MAX_MS, osmCells, type OsmCell } from './overpass';

const ENFORCEMENT_KINDS = ['maxspeed', 'traffic_signals', 'average_speed', 'mindistance', 'red_light_camera'] as const;

const Tags = z.record(z.string(), z.string());
const Node = z.object({ type: z.literal('node'), id: z.number(), lat: z.number(), lon: z.number(), tags: Tags.optional() });
const Rel = z.object({
  type: z.literal('relation'),
  id: z.number(),
  tags: Tags.optional(),
  members: z.array(z.object({ type: z.string(), ref: z.number(), role: z.string() })).optional(),
});
export function osmQuery(b: BBox): string {
  const box = `${b.south},${b.west},${b.north},${b.east}`;
  const kinds = ENFORCEMENT_KINDS.join('|');
  return (
    `[out:json][timeout:25];rel["type"="enforcement"]["enforcement"~"^(${kinds})$"](${box})->.e;` +
    `node(r.e:"device")->.d;(node["highway"="speed_camera"](${box});.d;);out body;.e out body;`
  );
}

export const osmUrl = (endpoint: string, b: BBox) => overpassUrl(endpoint, osmQuery(b));

const CARDINAL = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** OSM `direction` (degrees or a cardinal point) → heading; null for ranges, forward/backward or junk. */
export function osmHeading(v: string | undefined): number | null {
  if (!v) return null;
  const s = v.trim().toUpperCase();
  const i = CARDINAL.indexOf(s);
  if (i >= 0) return i * 22.5;
  if (!/^\d{1,3}(\.\d+)?$/.test(s)) return null;
  const d = Number(s);
  return d >= 0 && d <= 360 ? d % 360 : null;
}

/** Subtype from the relation kind or the node's own tags. */
export function osmSubtype(tags: Record<string, string>, kind: string | null): string {
  if (kind === 'traffic_signals' || kind === 'red_light_camera') return 'red_light';
  if (kind === 'average_speed') return 'average_speed';
  const note = `${tags.note ?? ''} ${tags.description ?? ''} ${tags['camera:type'] ?? ''}`.toLowerCase();
  if (note.includes('red light') || note.includes('feu rouge')) return 'red_light';
  return 'speed_camera';
}

/** Overpass elements → camera hazards (bbox-filtered, de-duplicated by node id). */
export function normaliseOsm(elements: unknown[], bbox: BBox, now: number): Hazard[] {
  const kindOf = new Map<number, string>();
  const nodes = new Map<number, z.infer<typeof Node>>();
  for (const el of elements) {
    const r = Rel.safeParse(el);
    if (r.success) {
      const kind = r.data.tags?.enforcement ?? null;
      for (const m of r.data.members ?? []) if (m.type === 'node' && m.role === 'device' && kind) kindOf.set(m.ref, kind);
      continue;
    }
    const n = Node.safeParse(el);
    if (n.success) nodes.set(n.data.id, n.data);
  }
  const out: Hazard[] = [];
  for (const n of nodes.values()) {
    const tags = n.tags ?? {};
    const kind = kindOf.get(n.id) ?? null;
    if (tags.highway !== 'speed_camera' && !kind) continue;
    if (n.lat < bbox.south || n.lat > bbox.north || n.lon < bbox.west || n.lon > bbox.east) continue;
    out.push({
      id: `osm:${n.id}`,
      source: 'osm',
      type: 'camera',
      subtype: osmSubtype(tags, kind),
      lat: n.lat,
      lng: n.lon,
      heading: osmHeading(tags.direction ?? tags['camera:direction']),
      street: tags.name?.trim() || null,
      reportedAt: now,
      expiresAt: feedExpiry(now, null),
      reliability: 7,
      confirmations: 0,
    });
  }
  return out;
}

/** Persisted cell: raw camera points (small) and when they were fetched. */
export interface OsmCellRecord {
  at: number;
  cameras: Hazard[];
}

export interface OsmSnapshot {
  cells: Record<string, OsmCellRecord>;
}

export class OsmCameraSource implements HazardSource {
  readonly id = 'osm' as const;
  readonly tracker = new HealthTracker('osm');
  private readonly cells: OverpassCells<Hazard>;

  constructor(http: HttpGet, endpoints: readonly string[] = OSM_OVERPASS_ENDPOINTS, onRequest?: () => void) {
    this.cells = new OverpassCells<Hazard>(http, this.tracker, { query: osmQuery, normalise: normaliseOsm, ...(onRequest ? { onRequest } : {}) }, endpoints);
  }

  health() {
    return this.tracker.get();
  }

  snapshot(): OsmSnapshot {
    return { cells: Object.fromEntries(Object.entries(this.cells.snapshot()).map(([k, v]) => [k, { at: v.at, cameras: v.items }])) };
  }

  restore(s: OsmSnapshot | null, now: number): void {
    if (!s || typeof s !== 'object' || !s.cells) return;
    const cells: Record<string, { at: number; items: Hazard[] }> = {};
    for (const [k, v] of Object.entries(s.cells)) if (v && Array.isArray(v.cameras)) cells[k] = { at: v.at, items: v.cameras };
    this.cells.restore(cells, now);
  }

  /** Earliest time the next network attempt may run (backoff after failures). */
  nextAttemptAt(): number {
    return this.cells.nextAttemptAt();
  }

  async fetch(ctx: FetchContext): Promise<Hazard[]> {
    await this.cells.refresh(ctx.bbox, ctx.now);
    return this.cached(ctx.bbox, ctx.now);
  }

  /** Cameras already on this phone (no network): every phone shows them, not only the chore peer that fetched them. */
  cached(b: BBox, now: number): Hazard[] {
    return this.cells.cached(b, now).map(({ item, at }) => ({ ...item, reportedAt: at, expiresAt: feedExpiry(now, null) }));
  }
}
