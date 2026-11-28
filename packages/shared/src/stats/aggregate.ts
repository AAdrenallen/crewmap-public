import { periodStart, type Period, type StatsVisibility, type TripSummary, type Visit, type WalkSummary } from './core';

/**
 * Leaderboard aggregate (D56): counts and totals only, one per period. This is the whole payload of a 'stats-agg'
 * message, so it must never carry routes, places, coordinates or ids. Home leave/return is a bare number.
 */
export interface StatsAgg {
  /** Period start (sender's local calendar week/month start, ms; 0 for all-time) so receivers drop stale months. */
  k: number;
  drives?: number;
  drivenKm?: number;
  walks?: number;
  walkedKm?: number;
  longestKm?: number;
  /** Distance-weighted score over scored drives; null = no scored drive. */
  score?: number | null;
  /** Km of scored drives behind `score` (gates "best score"). */
  scoredKm?: number;
  /** Risky events per 100 km driven (lower = smoother). */
  eventsPer100?: number;
  nightTrips?: number;
  earlyTrips?: number;
  places?: number;
  homeLeaves?: number;
  homeReturns?: number;
  /** Most recent consecutive drives without a hard brake (all-time, like the clean streak). */
  noBrakeStreak?: number;
  /** Highest speed recorded in the period (km/h), gated by the opt-in `topSpeed` visibility toggle. */
  topKph?: number;
}

export type AggSet = Partial<Record<Period, StatsAgg>>;

/** Tunables for the leaderboard (one config, D56). */
export const LEADER = {
  /** Minimum km of (scored) driving before "best score" / "smoothest" rank someone. */
  minKmForQuality: 20,
  /** Local hours that count as a night-owl start: [22, 24) ∪ [0, 4). */
  nightFrom: 22,
  nightTo: 4,
  /** Early-bird starts: [4, 7). */
  earlyFrom: 4,
  earlyTo: 7,
  /** Sender: never re-send an unchanged aggregate sooner than this; send changed ones at most this often. */
  resendMs: 24 * 3600_000,
  minIntervalMs: 60_000,
  /** Receivers accept a period key within this distance of their own (time zones differ). */
  keySlackMs: 27 * 3600_000,
  /** Rows per category card besides me. */
  top: 3,
} as const;

const round1 = (x: number) => Math.round(x * 10) / 10;
const hourOf = (t: number, tz: number) => new Date(t + tz * 60_000).getUTCHours();

/**
 * Home departures and returns from time-ordered stays. Repeated stays at home (GPS drift re-anchoring the stay
 * detector) are one stay: only a change between home and elsewhere counts.
 */
export function homeTransitions(visits: Visit[], homeIds: ReadonlySet<string>, from = -Infinity): { leaves: number; returns: number } {
  let leaves = 0;
  let returns = 0;
  let prev: boolean | null = null;
  for (const v of [...visits].sort((a, b) => a.t - b.t)) {
    const home = homeIds.has(v.placeKey);
    if (prev !== null && home !== prev && v.t >= from) {
      if (home) returns++;
      else leaves++;
    }
    prev = home;
  }
  return { leaves, returns };
}

export function aggregateFor(
  input: { trips: TripSummary[]; walks: WalkSummary[]; visits: Visit[] },
  period: Period,
  now: number,
  tz: number,
  homeIds: ReadonlySet<string> = new Set(),
): StatsAgg {
  const from = periodStart(period, now, tz);
  const drives = input.trips.filter((t) => !t.passenger && t.startedAt >= from);
  const walks = input.walks.filter((w) => w.startedAt >= from);
  const km = drives.reduce((s, t) => s + t.distanceM, 0) / 1000;
  const scored = drives.filter((t) => t.score !== null);
  const skm = scored.reduce((s, t) => s + t.distanceM, 0) / 1000;
  const events = drives.reduce((s, t) => s + Object.values(t.events).reduce<number>((a, n) => a + (n ?? 0), 0), 0);
  const night = drives.filter((t) => {
    const h = hourOf(t.startedAt, tz);
    return h >= LEADER.nightFrom || h < LEADER.nightTo;
  }).length;
  const early = drives.filter((t) => {
    const h = hourOf(t.startedAt, tz);
    return h >= LEADER.earlyFrom && h < LEADER.earlyTo;
  }).length;
  let noBrake = 0;
  for (const t of input.trips.filter((x) => !x.passenger).sort((a, b) => b.startedAt - a.startedAt)) {
    if ((t.events.hardBrake ?? 0) > 0) break;
    noBrake++;
  }
  const home = homeTransitions(input.visits, homeIds, from);
  return {
    k: period === 'all' ? 0 : from,
    drives: drives.length,
    drivenKm: round1(km),
    walks: walks.length,
    walkedKm: round1(walks.reduce((s, w) => s + w.distanceM, 0) / 1000),
    longestKm: round1(drives.reduce((m, t) => Math.max(m, t.distanceM), 0) / 1000),
    score: skm > 0 ? Math.round(scored.reduce((s, t) => s + t.score! * t.distanceM, 0) / (skm * 1000)) : null,
    scoredKm: round1(skm),
    eventsPer100: km > 0 ? round1((events / km) * 100) : 0,
    nightTrips: night,
    earlyTrips: early,
    places: new Set(input.visits.filter((v) => v.t >= from).map((v) => v.placeKey)).size,
    homeLeaves: home.leaves,
    homeReturns: home.returns,
    noBrakeStreak: noBrake,
    topKph: drives.reduce((m, t) => Math.max(m, t.topSpeedKph), 0),
  };
}

/** Fields each stats visibility switch allows (home counts are place-derived, so they follow `places`). */
export type AggGroup = 'score' | 'distance' | 'events' | 'trips' | 'places' | 'home' | 'topSpeed';

/** Stat group of each aggregate field (`longestKm` needs both distance and trips). */
export const AGG_GROUPS: Record<AggGroup, (keyof StatsAgg)[]> = {
  score: ['score', 'scoredKm'],
  distance: ['drivenKm', 'walkedKm', 'longestKm'],
  events: ['eventsPer100', 'noBrakeStreak'],
  trips: ['drives', 'walks', 'nightTrips', 'earlyTrips', 'longestKm'],
  places: ['places'],
  home: ['homeLeaves', 'homeReturns'],
  topSpeed: ['topKph'],
};

/** What one recipient may see: drop every field of a group `allowed` refuses (call before sealing). */
export function restrictAgg(a: StatsAgg, allowed: (g: AggGroup) => boolean): StatsAgg {
  const out: StatsAgg = { ...a };
  for (const [g, fields] of Object.entries(AGG_GROUPS) as [AggGroup, (keyof StatsAgg)[]][]) if (!allowed(g)) for (const f of fields) delete out[f];
  return out;
}

/** Visibility-switch adapter (the app uses p2p `statsAllowed` on the resolved per-friend policy instead). */
export const visAllows = (vis: StatsVisibility, trips: boolean) => (g: AggGroup): boolean => (g === 'trips' ? trips && vis.trips : vis[g]);

/** Whether a received period key still describes the receiver's current period. */
export function aggCurrent(a: StatsAgg | undefined, period: Period, now: number, tz: number): boolean {
  if (!a) return false;
  if (period === 'all') return a.k === 0;
  return Math.abs(a.k - periodStart(period, now, tz)) <= LEADER.keySlackMs;
}

// --- Categories -------------------------------------------------------------------------------------------------------

export type CategoryId =
  | 'longest'
  | 'driven'
  | 'walked'
  | 'drives'
  | 'homeRuns'
  | 'score'
  | 'smooth'
  | 'nightOwl'
  | 'earlyBird'
  | 'places'
  | 'noBrake'
  | 'topSpeed';

export type CategoryUnit = 'km' | 'count' | 'score' | 'per100' | 'kph';

export interface Category {
  id: CategoryId;
  unit: CategoryUnit;
  /** 'low' = smaller wins. */
  dir: 'high' | 'low';
  value: (a: StatsAgg) => number | null;
}

const num = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const pos = (x: number | null | undefined) => {
  const v = num(x);
  return v !== null && v > 0 ? v : null;
};

/** Zero counts don't rank. `topSpeed` only ranks members who opted into sharing top speed. */
export const CATEGORIES: Category[] = [
  { id: 'driven', unit: 'km', dir: 'high', value: (a) => pos(a.drivenKm) },
  { id: 'walked', unit: 'km', dir: 'high', value: (a) => pos(a.walkedKm) },
  { id: 'longest', unit: 'km', dir: 'high', value: (a) => pos(a.longestKm) },
  { id: 'drives', unit: 'count', dir: 'high', value: (a) => pos(a.drives) },
  { id: 'score', unit: 'score', dir: 'high', value: (a) => ((a.scoredKm ?? 0) >= LEADER.minKmForQuality ? num(a.score) : null) },
  { id: 'smooth', unit: 'per100', dir: 'low', value: (a) => ((a.drivenKm ?? 0) >= LEADER.minKmForQuality ? num(a.eventsPer100) : null) },
  { id: 'noBrake', unit: 'count', dir: 'high', value: (a) => pos(a.noBrakeStreak) },
  { id: 'topSpeed', unit: 'kph', dir: 'high', value: (a) => pos(a.topKph) },
  { id: 'homeRuns', unit: 'count', dir: 'high', value: (a) => pos((a.homeLeaves ?? 0) + (a.homeReturns ?? 0)) },
  { id: 'nightOwl', unit: 'count', dir: 'high', value: (a) => pos(a.nightTrips) },
  { id: 'earlyBird', unit: 'count', dir: 'high', value: (a) => pos(a.earlyTrips) },
  { id: 'places', unit: 'count', dir: 'high', value: (a) => pos(a.places) },
];

export interface RankRow {
  id: string;
  rank: number;
  value: number;
}

/**
 * One category card: the top `LEADER.top` plus me (with my true rank) when I'm further down. Ties share a rank;
 * ties are ordered by distance driven (more first), then id, so the list is stable across phones.
 */
export function rankCategory(entries: { id: string; agg: StatsAgg }[], cat: Category, meId: string): { top: RankRow[]; me: RankRow | null } {
  const rows = entries
    .map((e) => ({ id: e.id, value: cat.value(e.agg), km: e.agg.drivenKm ?? 0 }))
    .filter((r): r is { id: string; value: number; km: number } => r.value !== null)
    .sort((a, b) => (cat.dir === 'high' ? b.value - a.value : a.value - b.value) || b.km - a.km || a.id.localeCompare(b.id));
  let rank = 0;
  let prev: number | null = null;
  const ranked = rows.map((r, i) => {
    if (r.value !== prev) rank = i + 1;
    prev = r.value;
    return { id: r.id, rank, value: r.value };
  });
  const top = ranked.slice(0, LEADER.top);
  const mine = ranked.find((r) => r.id === meId) ?? null;
  return { top, me: mine && !top.some((r) => r.id === meId) ? mine : null };
}
