import { haversineM } from '../geo';
import { DRIVE_ALONG } from './thresholds';
import type { DriveAlongSession, GroupDest } from './session';

/** Group drive (D46) helpers: arrival, rough ETA, the member strip and the end-of-drive summary. All pure. */

export function atDestination(fix: { lat: number; lng: number }, dest: GroupDest): boolean {
  return haversineM(fix, dest) <= DRIVE_ALONG.arriveM;
}

/** Straight-line ETA guess (ms) for an invite card, before any route exists. */
export function roughEtaMs(from: { lat: number; lng: number }, dest: GroupDest): number {
  return Math.round(((haversineM(from, dest) * DRIVE_ALONG.roadFactor) / DRIVE_ALONG.avgSpeedMps) * 1000);
}

export interface GroupRow {
  id: string;
  name: string;
  status: 'arrived' | 'driving' | 'invited' | 'declined' | 'left';
  /** Absolute ETA (ms epoch) when known: their own nav ETA, else a rough guess from their last position. */
  etaAt: number | null;
  arrivedAt: number | null;
}

export interface LivePos {
  lat: number;
  lng: number;
  eta: number | null;
}

/** One row per member (me included): arrived first (in order of arrival), then driving by ETA, then the rest. */
export function groupRows(s: DriveAlongSession, me: string, myPos: LivePos | null, live: Record<string, LivePos | undefined>, now: number): GroupRow[] {
  const rows: GroupRow[] = Object.entries(s.members).map(([id, m]) => {
    const arrivedAt = s.arrived[id] ?? null;
    const pos = id === me ? myPos : live[id];
    const status: GroupRow['status'] = arrivedAt !== null ? 'arrived' : m.state === 'joined' ? 'driving' : m.state;
    let etaAt: number | null = null;
    if (status === 'driving' && pos) etaAt = pos.eta ?? (s.dest ? now + roughEtaMs(pos, s.dest) : null);
    return { id, name: m.name, status, etaAt, arrivedAt };
  });
  const rank = (r: GroupRow) => (r.status === 'arrived' ? 0 : r.status === 'driving' ? 1 : r.status === 'invited' ? 2 : 3);
  return rows.sort((a, b) => rank(a) - rank(b) || (a.arrivedAt ?? 0) - (b.arrivedAt ?? 0) || (a.etaAt ?? Infinity) - (b.etaAt ?? Infinity) || a.id.localeCompare(b.id));
}

/** Everyone still in the drive (joined, at least two) has arrived. */
export function allArrived(s: DriveAlongSession): boolean {
  if (!s.dest) return false;
  const joined = Object.entries(s.members).filter(([, m]) => m.state === 'joined');
  return joined.length > 1 && joined.every(([id]) => s.arrived[id] !== undefined);
}

export interface GroupSummary {
  dest: string;
  /** Arrivals in order, with the clock time (ms epoch, sender clock). */
  arrivals: { id: string; name: string; at: number }[];
  /** Joined members who had not arrived. */
  missing: { id: string; name: string }[];
}

export function groupSummary(s: DriveAlongSession): GroupSummary | null {
  if (!s.dest) return null;
  const arrivals = Object.entries(s.arrived)
    .filter(([id]) => s.members[id])
    .map(([id, at]) => ({ id, name: s.members[id]!.name, at }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  if (arrivals.length === 0) return null;
  const missing = Object.entries(s.members)
    .filter(([id, m]) => m.state === 'joined' && s.arrived[id] === undefined)
    .map(([id, m]) => ({ id, name: m.name }));
  return { dest: s.dest.name, arrivals, missing };
}
