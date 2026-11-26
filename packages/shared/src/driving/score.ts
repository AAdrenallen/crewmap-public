import { DRIVING_THRESHOLDS } from './thresholds';
import type { RiskyEvent } from './types';

type ScoreTh = (typeof DRIVING_THRESHOLDS)['score'];

export function eventPenalty(e: RiskyEvent, th: ScoreTh = DRIVING_THRESHOLDS.score): number {
  switch (e.kind) {
    case 'hardBrake':
      return th.hardBrake[e.severity];
    case 'rapidAccel':
      return th.rapidAccel[e.severity];
    case 'cornering':
      return th.cornering[e.severity];
    case 'speeding': {
      const dur = e.tEnd !== undefined ? (e.tEnd - e.t) / 1000 : 0;
      return th.speedingBase[e.severity] + th.speedingPerS[e.severity] * dur;
    }
    case 'phoneHandling':
      return th.phoneBase + th.phonePerS * e.value;
    case 'lateNight':
      return th.lateNight;
    case 'crash':
      // Crash-like spikes alert the owner only; they don't change the score.
      return 0;
  }
}

/**
 * 0–100 safety score. Penalties are normalised per `exposureKm` of driving so a long clean drive with one brake
 * scores higher than a 2 km drive with one brake. Passenger trips are excluded (null).
 */
export function tripScore(
  events: RiskyEvent[],
  distanceM: number,
  passenger: boolean,
  th: ScoreTh = DRIVING_THRESHOLDS.score,
): number | null {
  if (passenger) return null;
  const raw = events.reduce((sum, e) => sum + eventPenalty(e, th), 0);
  const exposure = Math.max(1, distanceM / 1000 / th.exposureKm);
  const p = raw / exposure;
  return Math.round(100 * Math.exp(-p / th.decay));
}

/** Distance-weighted average of trip scores, ignoring passenger trips. */
export function aggregateScore(trips: { score: number | null; distanceM: number }[]): number | null {
  let w = 0;
  let s = 0;
  for (const t of trips) {
    if (t.score === null) continue;
    w += t.distanceM;
    s += t.score * t.distanceM;
  }
  return w === 0 ? null : Math.round(s / w);
}
