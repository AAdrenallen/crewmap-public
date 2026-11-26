import { haversineM } from '../geo';
import type { RiskyEventKind } from '../driving/types';

export interface TripSummary {
  id: string;
  startedAt: number;
  endedAt: number;
  distanceM: number;
  durationS: number;
  topSpeedKph: number;
  avgSpeedKph: number;
  score: number | null;
  passenger: boolean;
  events: Partial<Record<RiskyEventKind, number>>;
}

export interface WalkSummary {
  startedAt: number;
  endedAt: number;
  distanceM: number;
  kind: 'walk' | 'run';
}

/** A stay of ≥ 10 min somewhere. `city` from reverse geocoding (cached), `placeKey` a ~150 m cell or saved place id. */
export interface Visit {
  t: number;
  placeKey: string;
  city: string | null;
}

export type Period = 'week' | 'month' | 'all';

export interface Stats {
  period: Period;
  drivenKm: number;
  walkedKm: number;
  movingMin: number;
  trips: number;
  avgScore: number | null;
  /** Distance-weighted score per ISO week (oldest → newest), for trend charts. */
  scoreTrend: { weekStart: number; score: number | null; km: number }[];
  events: Partial<Record<RiskyEventKind, number>>;
  longestTrip: { id: string; km: number } | null;
  topSpeedKph: number;
  places: number;
  cities: number;
  /** Consecutive days (ending today/yesterday) with any tracked movement. */
  activeStreakDays: number;
  /** Consecutive scored trips with score ≥ 90. */
  cleanTripStreak: number;
  badges: BadgeId[];
}

export const BADGES = [
  'smoothOperator',
  'nightOwl',
  'roadWarrior',
  'explorer',
  'earlyBird',
  'weekStreak',
  'featherFoot',
  'walker',
] as const;
export type BadgeId = (typeof BADGES)[number];

const DAY = 86_400_000;

/** Local-midnight-aligned day index using a fixed UTC offset (minutes), so tests are timezone-independent. */
export function dayOf(t: number, tzOffsetMin: number): number {
  return Math.floor((t + tzOffsetMin * 60_000) / DAY);
}

export function weekStart(t: number, tzOffsetMin: number): number {
  const d = dayOf(t, tzOffsetMin);
  const dow = (d + 3) % 7; // 1970-01-01 was a Thursday → Monday-based week
  return (d - dow) * DAY - tzOffsetMin * 60_000;
}

export function periodStart(period: Period, now: number, tzOffsetMin: number): number {
  if (period === 'all') return -Infinity;
  if (period === 'week') return weekStart(now, tzOffsetMin);
  const local = new Date(now + tzOffsetMin * 60_000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - tzOffsetMin * 60_000;
}

export function computeStats(
  input: { trips: TripSummary[]; walks: WalkSummary[]; visits: Visit[]; lateNightTrips?: number },
  period: Period,
  now: number,
  tzOffsetMin: number,
): Stats {
  const from = periodStart(period, now, tzOffsetMin);
  const trips = input.trips.filter((t) => t.startedAt >= from && !t.passenger);
  const walks = input.walks.filter((w) => w.startedAt >= from);
  const visits = input.visits.filter((v) => v.t >= from);
  const scored = trips.filter((t) => t.score !== null);
  const wsum = scored.reduce((s, t) => s + t.distanceM, 0);
  const events: Partial<Record<RiskyEventKind, number>> = {};
  for (const t of trips) for (const [k, n] of Object.entries(t.events)) events[k as RiskyEventKind] = (events[k as RiskyEventKind] ?? 0) + (n ?? 0);
  const longest = trips.reduce<TripSummary | null>((m, t) => (!m || t.distanceM > m.distanceM ? t : m), null);

  // Weekly trend over the last 8 weeks (or the whole period for 'all', capped at 26).
  const weeks = period === 'week' ? 1 : period === 'month' ? 5 : 26;
  const trend: Stats['scoreTrend'] = [];
  const thisWeek = weekStart(now, tzOffsetMin);
  for (let i = weeks - 1; i >= 0; i--) {
    const ws = thisWeek - i * 7 * DAY;
    const wt = input.trips.filter((t) => !t.passenger && t.startedAt >= ws && t.startedAt < ws + 7 * DAY);
    const sc = wt.filter((t) => t.score !== null);
    const w = sc.reduce((s, t) => s + t.distanceM, 0);
    trend.push({
      weekStart: ws,
      score: w > 0 ? Math.round(sc.reduce((s, t) => s + t.score! * t.distanceM, 0) / w) : null,
      km: Math.round(wt.reduce((s, t) => s + t.distanceM, 0) / 100) / 10,
    });
  }

  // Active streak: consecutive days with a trip or walk, ending today or yesterday (all-time data).
  const days = new Set<number>();
  for (const t of input.trips) days.add(dayOf(t.startedAt, tzOffsetMin));
  for (const w of input.walks) days.add(dayOf(w.startedAt, tzOffsetMin));
  let streak = 0;
  let d = dayOf(now, tzOffsetMin);
  if (!days.has(d)) d--;
  while (days.has(d)) {
    streak++;
    d--;
  }

  // Clean-trip streak: most recent consecutive scored trips ≥ 90.
  let clean = 0;
  for (const t of [...input.trips].filter((x) => x.score !== null && !x.passenger).sort((a, b) => b.startedAt - a.startedAt)) {
    if (t.score! >= 90) clean++;
    else break;
  }

  const stats: Stats = {
    period,
    drivenKm: round1(trips.reduce((s, t) => s + t.distanceM, 0) / 1000),
    walkedKm: round1(walks.reduce((s, w) => s + w.distanceM, 0) / 1000),
    movingMin: Math.round((trips.reduce((s, t) => s + t.durationS, 0) + walks.reduce((s, w) => s + (w.endedAt - w.startedAt) / 1000, 0)) / 60),
    trips: trips.length,
    avgScore: wsum > 0 ? Math.round(scored.reduce((s, t) => s + t.score! * t.distanceM, 0) / wsum) : null,
    scoreTrend: trend,
    events,
    longestTrip: longest ? { id: longest.id, km: round1(longest.distanceM / 1000) } : null,
    topSpeedKph: trips.reduce((m, t) => Math.max(m, t.topSpeedKph), 0),
    places: new Set(visits.map((v) => v.placeKey)).size,
    cities: new Set(visits.map((v) => v.city).filter((c): c is string => !!c)).size,
    activeStreakDays: streak,
    cleanTripStreak: clean,
    badges: [],
  };
  stats.badges = badgesFor(input, stats, tzOffsetMin);
  return stats;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

export function badgesFor(input: { trips: TripSummary[]; walks: WalkSummary[]; visits: Visit[] }, s: Stats, tzOffsetMin: number): BadgeId[] {
  const out: BadgeId[] = [];
  const all = input.trips.filter((t) => !t.passenger);
  if (all.filter((t) => (t.score ?? 0) >= 95).length >= 5) out.push('smoothOperator');
  if (all.filter((t) => (t.events.lateNight ?? 0) > 0).length >= 3) out.push('nightOwl');
  if (s.drivenKm >= 500) out.push('roadWarrior');
  if (new Set(input.visits.map((v) => v.city).filter(Boolean)).size >= 10) out.push('explorer');
  if (all.some((t) => {
    const h = new Date(t.startedAt + tzOffsetMin * 60_000).getUTCHours();
    return h >= 4 && h < 6;
  })) out.push('earlyBird');
  if (s.activeStreakDays >= 7) out.push('weekStreak');
  const recent = [...all].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20);
  if (recent.length >= 20 && recent.every((t) => (t.events.hardBrake ?? 0) === 0)) out.push('featherFoot');
  if (s.walkedKm >= 50) out.push('walker');
  return out;
}

// --- Visibility (F1e) -------------------------------------------------------------------------------------------------

export interface StatsVisibility {
  score: boolean;
  distance: boolean;
  topSpeed: boolean;
  events: boolean;
  trips: boolean;
  places: boolean;
  streaks: boolean;
  badges: boolean;
}

export const DEFAULT_VISIBILITY: StatsVisibility = {
  score: true,
  distance: true,
  topSpeed: false,
  events: false,
  trips: true,
  places: false,
  streaks: true,
  badges: true,
};

/** The only stats that ever leave the phone: fields the owner allowed, nothing else. */
export type SharedStats = Partial<Omit<Stats, 'period'>> & { period: Period; updatedAt: number };

export function shareableStats(s: Stats, v: StatsVisibility, now: number): SharedStats {
  const out: SharedStats = { period: s.period, updatedAt: now };
  if (v.score) {
    out.avgScore = s.avgScore;
    out.scoreTrend = s.scoreTrend;
  }
  if (v.distance) {
    out.drivenKm = s.drivenKm;
    out.walkedKm = s.walkedKm;
    out.movingMin = s.movingMin;
    out.longestTrip = s.longestTrip ? { id: '', km: s.longestTrip.km } : null;
  }
  if (v.topSpeed) out.topSpeedKph = s.topSpeedKph;
  if (v.events) out.events = s.events;
  if (v.trips) out.trips = s.trips;
  if (v.places) {
    out.places = s.places;
    out.cities = s.cities;
  }
  if (v.streaks) {
    out.activeStreakDays = s.activeStreakDays;
    out.cleanTripStreak = s.cleanTripStreak;
  }
  if (v.badges) out.badges = s.badges;
  return out;
}

/** Which shared fields each visibility switch carries (kept in step with `shareableStats`). */
const VIS_FIELDS: Record<keyof StatsVisibility, (keyof SharedStats)[]> = {
  score: ['avgScore', 'scoreTrend'],
  distance: ['drivenKm', 'walkedKm', 'movingMin', 'longestTrip'],
  topSpeed: ['topSpeedKph'],
  events: ['events'],
  trips: ['trips'],
  places: ['places', 'cities'],
  streaks: ['activeStreakDays', 'cleanTripStreak'],
  badges: ['badges'],
};

/** Everything on: the full shareable summary, narrowed per crew afterwards with `restrictShared`. */
export const ALL_VISIBLE: StatsVisibility = { score: true, distance: true, topSpeed: true, events: true, trips: true, places: true, streaks: true, badges: true };

/** Drop the fields a visibility forbids from an already shareable summary. */
export function restrictShared(s: SharedStats, v: StatsVisibility): SharedStats {
  const out: SharedStats = { ...s };
  for (const [k, fields] of Object.entries(VIS_FIELDS) as [keyof StatsVisibility, (keyof SharedStats)[]][]) {
    if (!v[k]) for (const f of fields) delete out[f];
  }
  return out;
}

export type LeaderboardMetric = 'avgScore' | 'drivenKm' | 'walkedKm' | 'activeStreakDays' | 'cleanTripStreak' | 'cities';

/** Rank people by a metric, using only what each one shares (missing = not ranked). */
export function leaderboard(entries: { id: string; stats: SharedStats }[], metric: LeaderboardMetric): { id: string; value: number; rank: number }[] {
  const rows = entries
    .map((e) => ({ id: e.id, value: e.stats[metric] as number | null | undefined }))
    .filter((r): r is { id: string; value: number } => typeof r.value === 'number')
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  let rank = 0;
  let prev: number | null = null;
  return rows.map((r, i) => {
    if (r.value !== prev) rank = i + 1;
    prev = r.value;
    return { ...r, rank };
  });
}

// --- Walks and stays --------------------------------------------------------------------------------------------------

/** Detects walks/runs from fixes + activity: on-foot activity at 0.5–4.5 m/s for ≥ 3 min and ≥ 200 m. */
export class WalkTracker {
  private cur: { start: number; last: number; dist: number; prev: { lat: number; lng: number }; runS: number; totS: number; idleSince: number | null } | null = null;

  onFix(f: { t: number; lat: number; lng: number; speed: number | null }, onFoot: boolean): WalkSummary | null {
    const v = f.speed ?? 0;
    const moving = onFoot && v >= 0.5 && v <= 4.5;
    if (!this.cur) {
      if (moving) this.cur = { start: f.t, last: f.t, dist: 0, prev: f, runS: 0, totS: 0, idleSince: null };
      return null;
    }
    const dt = (f.t - this.cur.last) / 1000;
    if (moving) {
      this.cur.dist += haversineM(this.cur.prev, f);
      this.cur.totS += dt;
      if (v > 2.5) this.cur.runS += dt;
      this.cur.last = f.t;
      this.cur.prev = f;
      this.cur.idleSince = null;
      return null;
    }
    this.cur.idleSince ??= f.t;
    if (!onFoot || f.t - this.cur.idleSince > 120_000) return this.close();
    return null;
  }

  close(): WalkSummary | null {
    const c = this.cur;
    this.cur = null;
    if (!c || c.last - c.start < 180_000 || c.dist < 200) return null;
    return { startedAt: c.start, endedAt: c.last, distanceM: c.dist, kind: c.runS > c.totS / 2 ? 'run' : 'walk' };
  }
}

/** Detects stays (≥ 10 min within 120 m) → visits. */
export class StayDetector {
  private anchor: { lat: number; lng: number; t: number } | null = null;
  private emitted = false;

  onFix(f: { t: number; lat: number; lng: number }): { lat: number; lng: number; t: number } | null {
    if (!this.anchor || haversineM(this.anchor, f) > 120) {
      this.anchor = { lat: f.lat, lng: f.lng, t: f.t };
      this.emitted = false;
      return null;
    }
    if (!this.emitted && f.t - this.anchor.t >= 10 * 60_000) {
      this.emitted = true;
      return { ...this.anchor };
    }
    return null;
  }
}

/** ~150 m cell key for unnamed places. */
export function cellKey(lat: number, lng: number): string {
  return `${Math.round(lat / 0.00135)}:${Math.round(lng / 0.0019)}`;
}

