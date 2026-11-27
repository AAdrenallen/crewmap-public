import { DEFAULT_VISIBILITY, type StatsVisibility } from '@crewmap/shared/stats';
import { checkInAllowed, cleanOverride, driveAlongAllowed, resolveShare, type LocationShare, type SharingPolicy, type UserOverride } from './sharing';

/** Per-friend sharing mode (D56): any override field set = custom, else the friend follows the crew policies. */
export type ShareUserMode = 'crew' | 'custom';

export const shareUserMode = (ov: UserOverride | null | undefined): ShareUserMode => (ov && cleanOverride(ov) ? 'custom' : 'crew');

/** A stats group (a StatsVisibility field). */
export type StatsGroup = keyof StatsVisibility;

/**
 * May this (resolved: override ?? crew) policy reveal one stats group (D56)? Stats off hides every group; `trips`
 * follows the policy's Trips switch. Call it before sealing anything stats-derived.
 */
export function statsAllowed(pol: SharingPolicy, group: StatsGroup): boolean {
  if (!pol.stats) return false;
  if (group === 'trips') return pol.trips;
  return pol.statsVis[group] ?? DEFAULT_VISIBILITY[group];
}

/** What one friend actually receives, every override-able field resolved. */
export interface ShareSummary {
  location: LocationShare;
  speed: boolean;
  battery: boolean;
  driveAlong: boolean;
  stats: boolean;
  trips: boolean;
  statsVis: StatsVisibility;
  /** Gets my safety check-in alerts (D66). */
  checkIn: boolean;
  /** Crew that grants the shown location (the most permissive one); null without a shared crew. */
  fromCrew: string | null;
}

const RANK: Record<LocationShare, number> = { exact: 3, approx: 2, city: 1, hidden: 0 };
const VIS_KEYS = Object.keys(DEFAULT_VISIBILITY) as StatsGroup[];

/**
 * Each crew sends its own (override ?? crew policy) data, so a friend in several crews sees the most permissive
 * of them. No shared crew = nothing is sent.
 */
export function shareSummary(crews: readonly { id: string; pol: SharingPolicy }[], ov: UserOverride | null | undefined): ShareSummary {
  const off = Object.fromEntries(VIS_KEYS.map((k) => [k, false])) as unknown as StatsVisibility;
  const out: ShareSummary = { location: 'hidden', speed: false, battery: false, driveAlong: false, stats: false, trips: false, statsVis: off, checkIn: false, fromCrew: null };
  for (const c of crews) {
    const p = resolveShare(c.pol, ov);
    if (out.fromCrew === null || RANK[p.location] > RANK[out.location]) {
      out.location = p.location;
      out.fromCrew = c.id;
    }
    out.speed ||= p.speed;
    out.battery ||= p.battery;
    out.driveAlong ||= driveAlongAllowed(p);
    out.stats ||= p.stats;
    out.trips ||= p.trips;
    out.checkIn ||= checkInAllowed(p, ov);
    for (const k of VIS_KEYS) out.statsVis[k] ||= p.statsVis[k] ?? DEFAULT_VISIBILITY[k];
  }
  return out;
}

/** Override that pins every field to what the friend sees now, so switching to Custom changes nothing by itself. */
export function customFromSummary(s: ShareSummary): UserOverride {
  return { location: s.location, speed: s.speed, battery: s.battery, driveAlong: s.driveAlong, stats: s.stats, trips: s.trips, statsVis: { ...s.statsVis }, checkIn: s.checkIn };
}
