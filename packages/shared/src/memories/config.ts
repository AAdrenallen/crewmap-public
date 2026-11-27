/**
 * Trip memories tunables (D68): how drives group into outings, who counts as "there", what makes a solo drive
 * notable, playback pacing and photo rules. One place, covered by test/memories.test.ts.
 */
export const MEMORY = {
  /** Two of my drives belong to one outing when the stop between them is at most this long. */
  chainGapMs: 3 * 3600_000,
  /** A crewmate is "with me" within this distance (m) of my interpolated position at their fix time. */
  togetherM: 450,
  /** Fix pairs further apart than this do not add together-time (a missing stretch is not assumed shared). */
  maxFixGapMs: 4 * 60_000,
  /** A crewmate joined when together at least this long, or for this share of the outing. */
  minTogetherMs: 8 * 60_000,
  minTogetherShare: 0.35,
  /** Window slack around my drives when reading crewmates' tracks and matching remote memories. */
  windowSlackMs: 10 * 60_000,
  /** A remote memory matches a local one when the windows overlap this share of the shorter one. */
  matchOverlap: 0.3,
  /** Notable solo outings. */
  notable: {
    /** Total distance (m) that is always notable. */
    longDayM: 150_000,
    /** Driving time (s) that is always notable. */
    roadTripS: 3 * 3600,
    /** Longest outing of the last `recordDays`, when at least `recordMinM`. */
    recordDays: 30,
    recordMinM: 40_000,
    /** A stop in a city never visited before, when the outing is at least this long (m). */
    newCityMinM: 15_000,
  },
  /** Stops shorter than this are traffic, not places visited. */
  minStopMs: 4 * 60_000,
  /** Recorded crewmate track while I drive: a point when moved this far or this long since the last one. */
  track: { minMoveM: 60, minIntervalMs: 20_000, maxPointsPerFriend: 1500 },
  /** Highlights shown on a recap. */
  maxHighlights: 4,
  /** Playback length regardless of real duration; a stop collapses to `stopMs`. */
  playback: { targetMs: 24_000, minMs: 8_000, stopMs: 1_200, idleGapMs: 3 * 60_000 },
  /** Route points shared with a crewmate (thinned). */
  sharedRoutePoints: 120,
  /** The recap card after a group outing shows for this long after the outing ended. */
  recapCardMs: 6 * 3600_000,
  /** Photos are kept on each phone this long after the outing, unless the memory is kept. */
  photoKeepDays: 90,
  /** A season summary needs this many outings to show. */
  seasonMinOutings: 2,
} as const;

/** Reactions a crewmate can leave on a memory or a photo. */
export const MEMORY_REACTIONS = ['❤️', '😂', '🔥', '😮', '🙌', '🥹'] as const;
export type MemoryReaction = (typeof MEMORY_REACTIONS)[number];
