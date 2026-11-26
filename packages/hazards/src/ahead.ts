import { polylineChunks, projectNearPolyline, projectOnPolyline, type LatLng, type PolylineChunks } from '@crewmap/shared/geo';
import type { ConfidenceLevel } from './confidence';
import type { NavRoute } from '@crewmap/shared/navigation';
import type { MergedHazard } from './merge';
import type { HazardType } from './types';

export const ALERT_THRESHOLDS = {
  /** Distances ahead at which to warn (m). */
  announceAtM: [800, 300] as const,
  /** A hazard counts as "on the route" within this lateral distance. */
  corridorM: 40,
  /** Never announce a hazard closer than this: too late to act on, and usually one we just reported. */
  minAnnounceM: 150,
  /** Stay quiet this long after the user reports anything themself. */
  quietAfterOwnReportMs: 60_000,
  /** Look this far ahead. */
  lookAheadM: 2000,
  /** "Still there?" asked once just after passing (within this distance behind). */
  confirmWindowM: [10, 120] as const,
  /** Never ask while the next maneuver is this close. */
  noPromptNearManeuverM: 200,
};

export const ANNOUNCED_TYPES: HazardType[] = ['police', 'speedTrap', 'camera', 'accident', 'hazard', 'closure', 'pothole'];
export const CONFIRMABLE: HazardType[] = ['police', 'speedTrap', 'accident', 'hazard', 'pothole'];

/** Minimum fused confidence to be spoken (D42): police and speed traps only when corroborated / trusted and fresh. */
export const ANNOUNCE_MIN_LEVEL: Record<HazardType, ConfidenceLevel> = {
  police: 'high',
  speedTrap: 'high',
  camera: 'medium',
  accident: 'medium',
  hazard: 'medium',
  closure: 'medium',
  construction: 'medium',
  jam: 'medium',
  pothole: 'medium',
};
const RANK: Record<ConfidenceLevel, number> = { low: 0, medium: 1, high: 2 };

export function announceable(h: Pick<MergedHazard, 'type' | 'level'>): boolean {
  return RANK[h.level] >= RANK[ANNOUNCE_MIN_LEVEL[h.type]];
}

export interface HazardOnRoute {
  hazard: MergedHazard;
  /** Along-route position of the hazard. */
  alongM: number;
}

/** Per-route spatial index (hazards change often while the route does not). */
const routeIndex = new WeakMap<LatLng[], PolylineChunks>();

/** Hazards on the active route corridor, sorted by along-route distance. Computed once per route/hazard set. */
export function hazardsOnRoute(route: NavRoute, hazards: MergedHazard[]): HazardOnRoute[] {
  const out: HazardOnRoute[] = [];
  let idx = routeIndex.get(route.geometry);
  if (!idx || idx.padM !== ALERT_THRESHOLDS.corridorM) {
    idx = polylineChunks(route.geometry, ALERT_THRESHOLDS.corridorM);
    routeIndex.set(route.geometry, idx);
  }
  for (const h of hazards) {
    if (!ANNOUNCED_TYPES.includes(h.type)) continue;
    let p = projectNearPolyline(h as LatLng, route.geometry, route.cum, idx);
    // Anonymous reports carry a grid-cell centre: accept them within the cell's radius of the route.
    if (!p && h.uncertaintyM) {
      const q = projectOnPolyline(h as LatLng, route.geometry, route.cum);
      if (q.distanceM <= ALERT_THRESHOLDS.corridorM + h.uncertaintyM) p = q;
    }
    if (!p) continue;
    out.push({ hazard: h, alongM: p.alongM });
  }
  return out.sort((a, b) => a.alongM - b.alongM);
}

export type AheadAction =
  | { kind: 'announce'; hazard: MergedHazard; distanceM: number; thresholdM: number }
  | { kind: 'confirm'; hazard: MergedHazard };

/**
 * Stateful announcer: emits each (hazard, threshold) announcement once, and one "still there?" prompt after passing
 * a confirmable hazard — never while the next maneuver is < 200 m away (deferred until it's clear, within the window).
 */
export interface AnnounceContext {
  /** This device: hazards it reported itself are never announced. */
  selfId?: string;
  now?: number;
  /** When this device last reported a hazard (epoch ms). */
  lastOwnReportAt?: number | null;
  /** Hazard ids this device published anonymously (they come back from the relays without a reporter). */
  ownIds?: ReadonlySet<string>;
}

export class HazardAnnouncer {
  private readonly done = new Set<string>();

  update(onRoute: HazardOnRoute[], myAlongM: number, nextManeuverM: number | null, ctx: AnnounceContext = {}): AheadAction[] {
    const out: AheadAction[] = [];
    const t = ALERT_THRESHOLDS;
    const quiet = ctx.now !== undefined && ctx.lastOwnReportAt != null && ctx.now - ctx.lastOwnReportAt < t.quietAfterOwnReportMs;
    for (const h of onRoute) {
      const d = h.alongM - myAlongM;
      if (d > t.lookAheadM) break;
      if (ctx.selfId && h.hazard.reporters.includes(ctx.selfId)) continue;
      if (ctx.ownIds && h.hazard.memberIds.some((m) => ctx.ownIds!.has(m))) continue;
      if (d > 0) {
        if (d < t.minAnnounceM) {
          // Too close to be useful: drop it for good rather than blurting "10 m ahead".
          for (const x of t.announceAtM) this.done.add(`${h.hazard.id}@${x}`);
          continue;
        }
        if (quiet || !announceable(h.hazard)) continue;
        // Announce the tightest threshold we've crossed, once (skips 800 m if we started inside 300 m).
        const crossed = t.announceAtM.filter((th) => d <= th);
        const th = crossed[crossed.length - 1];
        if (th !== undefined) {
          const key = `${h.hazard.id}@${th}`;
          if (!this.done.has(key)) {
            for (const x of crossed) this.done.add(`${h.hazard.id}@${x}`);
            out.push({ kind: 'announce', hazard: h.hazard, distanceM: Math.round(d), thresholdM: th });
          }
        }
      } else if (CONFIRMABLE.includes(h.hazard.type)) {
        const behind = -d;
        const key = `${h.hazard.id}@confirm`;
        if (behind >= t.confirmWindowM[0] && behind <= t.confirmWindowM[1] && !this.done.has(key)) {
          if (nextManeuverM === null || nextManeuverM >= t.noPromptNearManeuverM) {
            this.done.add(key);
            out.push({ kind: 'confirm', hazard: h.hazard });
          }
        }
      }
    }
    return out;
  }
}

/** Police density layer input: weighted points (recent police/speed-trap reports, incl. merged duplicates). */
export function policeDensity(hazards: MergedHazard[]): { lat: number; lng: number; weight: number }[] {
  return hazards
    .filter((h) => h.type === 'police' || h.type === 'speedTrap')
    .map((h) => ({ lat: h.lat, lng: h.lng, weight: Math.min(5, 1 + h.memberIds.length - 1 + h.confirmations * 0.25) }));
}
