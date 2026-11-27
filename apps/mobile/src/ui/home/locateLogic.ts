/**
 * Locate a crewmate (pure parts): fly to them, then a compact action pill. Tunables live here, with tests in
 * locateLogic.test.ts.
 */

export const LOCATE_UX = {
  /** The pill hides itself after this long without a touch, unless pinned. */
  autoHideMs: 8000,
  /** Older positions are shown as last-known with their age. */
  staleMs: 5 * 60_000,
  zoom: 15,
  /** Gap kept between the pill and any HUD element. */
  gapDp: 8,
} as const;

export type LocateTarget = { kind: 'live' | 'stale'; lat: number; lng: number; t: number } | { kind: 'hidden' };

/** Where to fly: a fresh exact position, a last-known one, or nothing (paused / no position / approximate only). */
export function locateTarget(
  f: { paused: boolean; presence: { lat: number; lng: number; t: number; prec?: string } | null | undefined },
  now: number,
): LocateTarget {
  const p = f.presence;
  if (f.paused || !p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return { kind: 'hidden' };
  return { kind: now - p.t < LOCATE_UX.staleMs ? 'live' : 'stale', lat: p.lat, lng: p.lng, t: p.t };
}

export type LocateAction = 'directions' | 'along' | 'ask' | 'askOnce' | 'chat' | 'emote';

/** Pill actions: directions and drive together need a position; a hidden crewmate gets "ask to share once". */
export function locateActions(target: LocateTarget, opts: { chat: boolean; driving: boolean }): LocateAction[] {
  const out: LocateAction[] = [];
  if (target.kind === 'hidden') out.push('askOnce');
  else out.push('directions', 'along');
  // "Ask location" only stands in for locate when their location isn't visible to me.
  if (target.kind === 'hidden') out.push('ask');
  // While driving the pill stays short: no typing.
  if (opts.chat && !opts.driving) out.push('chat');
  out.push('emote');
  return out;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Bottom offset (from the screen bottom) for the pill: above every HUD box in the lower half that overlaps its column,
 * never below `min`. Boxes in the upper half (nav banners, search) are left alone because the pill sits low.
 */
export function pillBottom(boxes: Box[], screenH: number, min: number, column: { x: number; width: number }): number {
  let bottom = min;
  for (const b of boxes) {
    if (b.y + b.height <= screenH / 2) continue;
    if (b.x >= column.x + column.width || b.x + b.width <= column.x) continue;
    bottom = Math.max(bottom, screenH - b.y + LOCATE_UX.gapDp);
  }
  return bottom;
}
