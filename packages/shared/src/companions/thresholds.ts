/** Drive-along and friend-alert tunables (D31). One place, covered by tests. */
export const DRIVE_ALONG = {
  /** Live presence period while both ends are driving. */
  liveDrivingMs: 1500,
  /** Live presence period while joined but not driving (parked, waiting at a regroup point). */
  liveIdleMs: 10_000,
  /** An unanswered invite lapses after this. */
  inviteTtlMs: 15 * 60_000,
  /** Session ends when no companion has been heard from for this long. */
  silenceEndMs: 10 * 60_000,
  /** Session ends this long after my drive ended (gives time for a fuel stop). */
  parkedEndMs: 8 * 60_000,
  /** Group drive (D46): within this of the destination counts as arrived. */
  arriveM: 75,
  /** Group drive: my live presence stops this long after I arrived (battery). */
  arrivedLingerMs: 5 * 60_000,
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
