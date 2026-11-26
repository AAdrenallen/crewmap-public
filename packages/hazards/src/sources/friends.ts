import { DEFAULT_TTL_MS, type Hazard, type HazardType } from '../types';

/** Report types offered as one-tap buttons while driving. */
export const FRIEND_REPORT_TYPES = ['police', 'speedTrap', 'hazard', 'accident', 'construction', 'pothole'] as const;
export type FriendReportType = (typeof FRIEND_REPORT_TYPES)[number];

/** Shape stored in the circle's CRDT doc (map `reports`). Votes keyed by device id: +1 / −1. */
export interface FriendReport {
  id: string;
  by: string;
  type: FriendReportType;
  lat: number;
  lng: number;
  heading: number | null;
  street: string | null;
  at: number;
  votes: Record<string, 1 | -1>;
  /** Nostr event id of the anonymous public copy, when the reporter opted in (dedupe only; D41). */
  anonId?: string;
}

export function reportExpiresAt(r: FriendReport): number {
  // Each upvote extends police/hazard reports by half their base TTL (like Waze "still there").
  const ups = Object.values(r.votes).filter((v) => v === 1).length;
  const base = DEFAULT_TTL_MS[r.type as HazardType];
  const lastUp = r.at;
  return lastUp + base + ups * (base / 2);
}

export function reportScore(r: FriendReport): { up: number; down: number } {
  const v = Object.values(r.votes);
  return { up: v.filter((x) => x === 1).length, down: v.filter((x) => x === -1).length };
}

/** Removed when expired or when downvotes outnumber upvotes by 2 ("not there anymore"). */
export function reportAlive(r: FriendReport, now: number): boolean {
  const { up, down } = reportScore(r);
  return now < reportExpiresAt(r) && down < up + 2;
}

export function hazardsFromReports(reports: FriendReport[], now: number): Hazard[] {
  return reports
    .filter((r) => reportAlive(r, now))
    .map((r) => {
      const { up, down } = reportScore(r);
      return {
        id: `friends:${r.id}`,
        source: 'friends' as const,
        type: r.type,
        subtype: null,
        lat: r.lat,
        lng: r.lng,
        heading: r.heading,
        street: r.street,
        reportedAt: r.at,
        expiresAt: reportExpiresAt(r),
        reliability: Math.max(0, Math.min(10, 6 + up - 2 * down)),
        confirmations: up,
        by: r.by,
        ...(r.anonId ? { alsoAs: `anon:${r.anonId}` } : {}),
      };
    });
}
