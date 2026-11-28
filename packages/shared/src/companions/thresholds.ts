/** Drive-along and friend-alert tunables (D31). One place, covered by tests. */
export const DRIVE_ALONG = {
  /** Live presence period while both ends are driving. */
  liveDrivingMs: 1500,
  /** Live presence period while joined but not driving (parked, waiting at a regroup point). */
  liveIdleMs: 10_000,
  /** An unanswered invite lapses after this. */
  inviteTtlMs: 15 * 60_000,
  /** Session ends when no companion has been heard from for this long. */
  silenceEndMs: 20 * 60_000,
  /** Session ends this long after my drive ended (gives time for a fuel/food stop). */
  parkedEndMs: 20 * 60_000,
  /** Group drive (D46): within this of the destination counts as arrived. */
  arriveM: 75,
  /** Group drive: my live presence stops this long after I arrived (battery). */
  arrivedLingerMs: 15 * 60_000,
  /** ETA guess before a route exists: road factor over the straight line, and an average speed (m/s). */
  roadFactor: 1.3,
  avgSpeedMps: 13.9,
  /** Hard cap on a session. */
  maxSessionMs: 12 * 3600_000,
  /** A companion this close to my route line counts as on my route. */
  onRouteM: 80,
  /** Off my route for this long before "took a different route" is announced. */
  offRouteHoldMs: 30_000,
  /** Gap buckets (m) whose crossing is announced. */
  gapBucketsM: [1000, 2000, 5000, 10_000, 20_000],
  /** At most one gap announcement per companion this often. */
  gapEveryMs: 3 * 60_000,
  /** Regroup candidates: within this of both routes, at least this far ahead of me. */
  regroupNearM: 150,
  regroupMinAheadM: 2000,
  /** Live position older than this is shown as stale. */
  staleMs: 15_000,
  /** Edge blips refresh at most this often (≤ 4 Hz). */
  blipEveryMs: 250,
} as const;

/** Convoy mode tunables (D65). */
export const CONVOY = {
  /** A member within this of the leader's line is on the convoy route. */
  onRouteM: 120,
  /**
   * Windowed projection: search this far back (GPS jitter; cars do not reverse along a route) and at least this far
   * ahead of the last position along the line; outside it (rejoined elsewhere) the whole line is searched.
   */
  windowBackM: 60,
  /** A leader's new route starting within this of the leader's place on the old line is a reroute (prefix kept). */
  rerouteJoinM: 500,
  windowAheadM: 1500,
  /** Per-member position history used for time gaps ("when did the car ahead pass here"). */
  historyMs: 30 * 60_000,
  historyMax: 600,
  /** Time gap fallback: distance over the follower's speed, never slower than this (m/s). */
  minSpeedMps: 8,
  /** Gaps below this count as "with you" (no callout). */
  togetherM: 150,
  /** "N lights back" only for this many signals or fewer, within this distance. */
  lightsMax: 3,
  lightsMaxM: 2000,
  /** Callout buckets: minutes and metres. A callout fires when the bucket changes and holds. */
  minuteBuckets: [1, 2, 3, 5, 10, 15],
  meterBuckets: [500, 1000, 2000, 5000, 10_000],
  /** A new bucket must hold this long, and callouts per member are at least this far apart. */
  calloutHoldMs: 10_000,
  calloutEveryMs: 90_000,
  /** Regroup alert defaults (user-configurable): gap to the car ahead over this distance or time. */
  regroupM: 2000,
  regroupMin: 3,
  /** Choices offered for the regroup thresholds. */
  regroupMChoices: [1000, 2000, 5000],
  regroupMinChoices: [2, 3, 5, 10],
  /** The gap must stay over the threshold this long, re-arms below this fraction, and repeats at most this often. */
  regroupHoldMs: 20_000,
  regroupRearm: 0.6,
  regroupEveryMs: 5 * 60_000,
  /** The non-interactive regroup banner stays this long. */
  bannerMs: 8000,
} as const;

export const FRIEND_ALERTS = {
  /** Battery below this (and not charging) alerts once per discharge. */
  batteryLowPct: 15,
  /** The alert re-arms once the friend charges or goes back above this. */
  batteryRearmPct: 30,
  /** "Ask for location": at most one answer per requester this often. */
  locateAnswerEveryMs: 60_000,
  /** Live ETA share: resend when the ETA moved by at least this, or this much time passed. */
  etaResendDeltaMs: 2 * 60_000,
  etaResendEveryMs: 5 * 60_000,
} as const;
