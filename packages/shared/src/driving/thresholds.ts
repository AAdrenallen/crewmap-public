/**
 * Every driving-detection tunable in one place. Units are SI unless the name says otherwise.
 * Documented in docs/DRIVING.md; covered by packages/shared/test/driving.*.test.ts.
 */
export const DRIVING_THRESHOLDS = {
  trip: {
    /** Speed that counts as "moving in a vehicle" for start detection (25 km/h). */
    startSpeedMps: 6.94,
    /** How long speed must stay above startSpeed (or activity = automotive) before a trip starts. */
    startSustainS: 20,
    /** Activity Recognition confidence (0–100) needed to trust "automotive". */
    automotiveConfidence: 60,
    /** With automotive activity, this lower speed is enough (10 km/h). */
    automotiveStartSpeedMps: 2.78,
    /** Below this speed the vehicle counts as stopped (5.4 km/h). */
    stopSpeedMps: 1.5,
    /** Stopped this long → trip ends (covers red lights and drive-thru queues). */
    stopDwellS: 180,
    /** Walking/still activity with low speed this long → trip ends sooner (parked and walked away). */
    walkAwayDwellS: 60,
    walkAwaySpeedMps: 2.5,
    /** GPS gap this long while in a trip ends it at the last known point. */
    maxGapS: 600,
    /** Trips shorter than this are discarded as noise. */
    minDistanceM: 500,
    minDurationS: 120,
    /** Ignore fixes with worse accuracy. */
    maxAccuracyM: 50,
  },
  events: {
    /** Minimum speed for brake/accel events to count (15 km/h). */
    minSpeedForLongitudinalMps: 4.17,
    hardBrakeMps2: -3.4,
    rapidAccelMps2: 3.0,
    /** Longitudinal acceleration is measured over this window (smooths GPS speed noise). */
    longitudinalWindowS: 2,
    /** Severity bands as multiples of the base threshold. */
    severityModerate: 1.25,
    severitySevere: 1.6,
    corneringLateralMps2: 3.0,
    minSpeedForCorneringMps: 5.56,
    corneringWindowS: 2,
    /** Lateral acceleration must stay above the threshold this long (rejects GPS heading jitter). */
    corneringSustainS: 1,
    /** After an event of a kind, suppress the same kind for this long. */
    cooldownS: 6,
    speeding: {
      /** km/h over the limit → grade. Below `minorKph` over the limit is ignored. */
      minorKph: 10,
      moderateKph: 20,
      severeKph: 30,
      /** Must be sustained this long to count. */
      minDurationS: 10,
      /** Short dips below the threshold inside an episode don't end it. */
      graceS: 4,
    },
    phone: {
      /** Phone handling counts only above this speed (15 km/h). */
      minSpeedMps: 4.17,
      /** Touches closer together than this merge into one episode. */
      mergeGapS: 10,
    },
    lateNight: {
      /** Local hour range [start, end) counted as late night. */
      startHour: 0,
      endHour: 5,
      /** Minimum minutes in the window to flag the trip. */
      minMinutes: 5,
    },
    crash: {
      /** Accelerometer magnitude spike (≈ 4 g). */
      spikeMps2: 39.2,
      /** Speed just before the spike must have been at least this (20 km/h). */
      minSpeedBeforeMps: 5.56,
      /** Vehicle must come to a stop within this time after the spike to confirm. */
      confirmWithinS: 15,
      stoppedSpeedMps: 2,
    },
  },
  score: {
    /** Penalty points per event by severity. */
    hardBrake: [4, 6, 9],
    rapidAccel: [3, 5, 7],
    cornering: [3, 5, 7],
    /** Speeding: base points + points per second, by grade. */
    speedingBase: [2, 4, 8],
    speedingPerS: [0.05, 0.12, 0.3],
    phoneBase: 6,
    phonePerS: 0.2,
    /** Late-night driving is still recorded for Night Owl stats without penalizing the safety score. */
    lateNight: 0,
    /** Penalties are normalised per this many km of driving (short trips aren't punished harder). */
    exposureKm: 20,
    /** score = 100·exp(−P / decay). P = 25 → ≈ 61. */
    decay: 50,
  },
} as const;

export type DrivingThresholds = typeof DRIVING_THRESHOLDS;
