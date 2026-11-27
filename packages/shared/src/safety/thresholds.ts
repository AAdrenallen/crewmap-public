/** Safety check-in tunables (D66). Covered by test/checkIn.test.ts. Units are SI unless the name says otherwise. */
export const CHECK_IN = {
  /** Wait choices offered in Settings (min); the first is the default. */
  waitChoicesMin: [5, 10, 15] as readonly number[],
  defaultWaitMin: 5,
  /** Unanswered this long after the ask → the opted-in crewmates are told. */
  graceS: 180,
  /** Crash-like spike, then no movement: ask sooner and tell the crew sooner. */
  crash: {
    waitS: 45,
    graceS: 120,
    /** A stop beginning this long after the spike (or before it) still counts as that crash. */
    linkS: 60,
  },
  /** Below this speed the vehicle is stopped (5.4 km/h, as the trip detector). */
  stopSpeedMps: 1.5,
  /** GPS drift around a parked car. */
  stopRadiusM: 40,
  /** Further than this from where we stopped = moved on, whatever the speed reading. */
  leaveM: 150,
  /** Fixes worse than this are ignored. */
  maxAccuracyM: 100,
  /** "Travelling": a fix at least this fast (30 km/h) ... */
  travelSpeedMps: 8.3,
  /** ... within this long before the stop. */
  travelWithinS: 600,
  /** Stop age at which the app looks up the surroundings, so the answer is there by the ask. */
  contextAtS: 90,
  /** Ordinary stops near home. */
  homeM: 1000,
  /** Added to a saved place's radius. */
  placeMarginM: 100,
  /** Arrived near the navigation destination. */
  navDestM: 300,
  /** Answered "OK" here before: a known spot (trailhead, lookout, friend's farm). */
  okCellM: 250,
  /** Traffic jam: in the window before the stop the car crawled (mean below 15 km/h over at least 150 m). */
  jam: {
    windowS: 180,
    meanSpeedMps: 4.2,
    minMovedM: 150,
    /** Or it stopped and went again this many times. */
    stopGoCount: 3,
    /** A jam / closure / accident report this close also counts. */
    hazardM: 500,
  },
  /** Surroundings lookup radius: buildings, homes, rest stops, parking, food, fuel within it make a stop ordinary. */
  surroundingsM: 150,
} as const;

export type CheckInThresholds = typeof CHECK_IN;

/** Wait for a stop (s): the crash wait, else the chosen minutes clamped to the offered range. */
export function checkInWaitS(waitMin: number, crash: boolean, th: CheckInThresholds = CHECK_IN): number {
  if (crash) return th.crash.waitS;
  const lo = Math.min(...th.waitChoicesMin);
  const hi = Math.max(...th.waitChoicesMin);
  const m = Number.isFinite(waitMin) ? Math.min(hi, Math.max(lo, waitMin)) : th.defaultWaitMin;
  return m * 60;
}
