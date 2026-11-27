import { INSIGHT } from './thresholds';

const L = INSIGHT.leaveBy;

export interface PastTrip {
  fromPlace: string;
  toPlace: string;
  /** Epoch ms. */
  startT: number;
  durationS: number;
}

export interface LeaveByAdvice {
  /** Epoch ms to leave. */
  leaveAt: number;
  /** Planned door-to-door duration (80th percentile of comparable trips), s. */
  plannedS: number;
  trips: number;
}

const minuteOfDay = (t: number) => {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
};
const weekend = (t: number) => {
  const g = new Date(t).getDay();
  return g === 0 || g === 6;
};

/**
 * When to leave to arrive by `arriveBy`, from the crew's own past trips between the two places on the same kind of
 * day near the same time. Null with too few comparable trips (the caller falls back to the router ETA).
 */
export function leaveBy(trips: PastTrip[], fromPlace: string, toPlace: string, arriveBy: number): LeaveByAdvice | null {
  const same = trips.filter((t) => t.fromPlace === fromPlace && t.toPlace === toPlace && t.durationS > 0);
  if (same.length < L.minTrips) return null;
  const typical = same.map((t) => t.durationS).sort((a, b) => a - b)[same.length >> 1]!;
  const plannedStart = arriveBy - typical * 1000;
  const target = minuteOfDay(plannedStart);
  const close = same.filter((t) => {
    if (weekend(t.startT) !== weekend(plannedStart)) return false;
    const d = Math.abs(minuteOfDay(t.startT) - target);
    return Math.min(d, 1440 - d) <= L.windowMin;
  });
  if (close.length < L.minTrips) return null;
  const durs = close.map((t) => t.durationS).sort((a, b) => a - b);
  const plannedS = durs[Math.min(durs.length - 1, Math.ceil(L.percentile * durs.length) - 1)]!;
  return { leaveAt: arriveBy - (plannedS + L.bufferS) * 1000, plannedS, trips: close.length };
}
