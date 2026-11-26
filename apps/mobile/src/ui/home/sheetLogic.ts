import { driveTime } from '@crewmap/shared/friend';
import { haversineM } from '@crewmap/shared/geo';

/** Pure decisions for the crewmates sheet: when it is needed, where it snaps, how rows are filtered and sorted. */

export type SnapName = 'collapsed' | 'half' | 'full';
export const SNAP_ORDER: readonly SnapName[] = ['collapsed', 'half', 'full'];

/** Tunables (one place, tested). */
export const SHEET = {
  /** More friends than this → bottom sheet; at most this many keep the card carousel. */
  carouselMaxPhone: 4,
  carouselMaxWide: 3,
  /** Header (~63) + deck viewport (two cards and a peek, deckLogic DECK_VIEW_H). */
  collapsedH: 250,
  halfFrac: 0.46,
  fullFrac: 0.88,
  /** A release is projected this far ahead along its velocity before picking the nearest snap. */
  flickS: 0.18,
  nearbyM: 5000,
  onlineMs: 5 * 60_000,
} as const;

export const needsSheet = (count: number, wide: boolean): boolean =>
  count > (wide ? SHEET.carouselMaxWide : SHEET.carouselMaxPhone);

export interface SnapHeights {
  collapsed: number;
  half: number;
  full: number;
}

/** Sheet heights for an available height (screen height minus top inset). Strictly increasing. */
export function snapHeights(avail: number): SnapHeights {
  const collapsed = Math.min(SHEET.collapsedH, Math.round(avail * 0.4));
  const half = Math.max(collapsed + 60, Math.round(avail * SHEET.halfFrac));
  const full = Math.max(half + 60, Math.round(avail * SHEET.fullFrac));
  return { collapsed, half, full };
}

/** Snap picked when a drag ends at height `h` moving with `vy` (dp/s, positive = downwards, i.e. shrinking). */
export function snapAfterDrag(h: number, vy: number, heights: SnapHeights): SnapName {
  'worklet';
  const projected = h - vy * SHEET.flickS;
  let best: SnapName = 'collapsed';
  let bd = Infinity;
  for (const k of SNAP_ORDER) {
    const d = Math.abs(heights[k] - projected);
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
}

/** Tap on the grab handle: expand step by step, wrap to collapsed from full. */
export function snapAfterTap(s: SnapName): SnapName {
  return s === 'collapsed' ? 'half' : s === 'half' ? 'full' : 'collapsed';
}

export type RowFilter = 'all' | 'driving' | 'nearby' | 'online';
export type RowSort = 'distance' | 'eta';
export const ROW_FILTERS: readonly RowFilter[] = ['all', 'driving', 'nearby', 'online'];

export interface RowInfo {
  id: string;
  name: string;
  act: string | null;
  paused: boolean;
  /** Last presence time (ms), null when never seen. */
  t: number | null;
  /** Metres from me (routed if known, else straight line), null when unknown. */
  distM: number | null;
  etaS: number | null;
}

export interface RowSource {
  profile: { deviceId: string; name: string };
  presence: { lat: number; lng: number; act: string; t: number } | null;
  paused: boolean;
  etaS: number | null;
  routeM: number | null;
}

export function toRow(f: RowSource, me: { lat: number; lng: number } | null): RowInfo {
  const p = f.presence;
  const straight = p && me ? haversineM(me, p) : null;
  return {
    id: f.profile.deviceId,
    name: f.profile.name,
    act: p?.act ?? null,
    paused: f.paused,
    t: p?.t ?? null,
    distM: f.routeM ?? straight, // Sort key matches the displayed drive time (routed, else the straight-line estimate).
    etaS: driveTime(f.etaS, straight)?.s ?? null,
  };
}

export const isOnline = (r: RowInfo, now: number): boolean =>
  !r.paused && r.t !== null && now - r.t < SHEET.onlineMs;
export const isDriving = (r: RowInfo): boolean => !r.paused && r.act === 'automotive';

export function filterRows(rows: RowInfo[], filter: RowFilter, query: string, now: number): RowInfo[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q)) return false;
    if (filter === 'driving') return isDriving(r);
    if (filter === 'nearby') return r.distM !== null && r.distM <= SHEET.nearbyM;
    if (filter === 'online') return isOnline(r, now);
    return true;
  });
}

/** Nulls last; ties by name so the order is stable between 1 Hz updates. */
export function sortRows(rows: RowInfo[], sort: RowSort): RowInfo[] {
  const key = (r: RowInfo): number | null => (sort === 'eta' ? r.etaS : r.distM);
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === null && kb === null) return a.name.localeCompare(b.name);
    if (ka === null) return 1;
    if (kb === null) return -1;
    return ka - kb || a.name.localeCompare(b.name);
  });
}

const CREW_COLORS = ['#4F5BFF', '#FF5A6A', '#14B8A6', '#F5A524', '#8B5CF6', '#22A06B'] as const;
/** Stable colour per crew id. */
export function crewColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CREW_COLORS[h % CREW_COLORS.length]!;
}
export const crewInitial = (name: string): string => (name.trim()[0] ?? '?').toUpperCase();
