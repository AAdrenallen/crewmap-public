import { dayOf, weekStart, type BadgeId, type Stats, type TripSummary, type Visit, type WalkSummary } from './core';

const DAY = 86_400_000;

export type StatMetric = 'distance' | 'driveTime' | 'score' | 'topSpeed' | 'events' | 'walks';
export const STAT_METRICS: readonly StatMetric[] = ['distance', 'driveTime', 'score', 'topSpeed', 'events', 'walks'];
export type RangeKind = 'week' | 'month' | 'year' | 'custom';

export interface StatsInput {
  trips: TripSummary[];
  walks: WalkSummary[];
  visits: Visit[];
}

/** Half-open time range [from, to). */
export interface TimeRange {
  from: number;
  to: number;
}

export interface Bucket {
  start: number;
  end: number;
  /** null = nothing to show (no scored drive, or still in the future). */
  value: number | null;
  future: boolean;
}

export function higherIsBetter(metric: StatMetric): boolean {
  return metric !== 'events';
}

function localMidnight(day: number, tz: number): number {
  return day * DAY - tz * 60_000;
}

/** Calendar range for week (Monday-based), month or year, `offset` periods back (0 = current, -1 = previous, ...). */
export function calendarRange(kind: 'week' | 'month' | 'year', now: number, tz: number, offset = 0): TimeRange {
  if (kind === 'week') {
    const from = weekStart(now, tz) + offset * 7 * DAY;
    // Weeks are 7 local days; recompute the end from local midnights so DST-free fixed-offset maths stays exact.
    return { from, to: from + 7 * DAY };
  }
  const local = new Date(now + tz * 60_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  if (kind === 'month') {
    return { from: Date.UTC(y, m + offset, 1) - tz * 60_000, to: Date.UTC(y, m + offset + 1, 1) - tz * 60_000 };
  }
  return { from: Date.UTC(y + offset, 0, 1) - tz * 60_000, to: Date.UTC(y + offset + 1, 0, 1) - tz * 60_000 };
}

/** Custom range between two local day starts, inclusive of both days. Swapped/inverted input is normalised. */
export function customRange(fromT: number, toT: number, tz: number): TimeRange {
  const a = dayOf(Math.min(fromT, toT), tz);
  const b = dayOf(Math.max(fromT, toT), tz);
  return { from: localMidnight(a, tz), to: localMidnight(b + 1, tz) };
}

/**
 * The period to compare against. Calendar periods compare with the previous calendar period; a custom range with the
 * same-length range right before it. While the current period is still running, the previous one is truncated to the
 * same elapsed time so the comparison is like for like.
 */
export function previousRange(kind: RangeKind, range: TimeRange, now: number, tz: number): TimeRange {
  let prev: TimeRange;
  if (kind === 'custom') {
    const len = range.to - range.from;
    prev = { from: range.from - len, to: range.from };
  } else {
    const probe = range.from + (range.to - range.from) / 2;
    prev = calendarRange(kind, probe, tz, -1);
  }
  if (range.to > now && now >= range.from) {
    const elapsed = now - range.from;
    prev = { from: prev.from, to: Math.min(prev.to, prev.from + elapsed + 1) };
  }
  return prev;
}

/** One number for a metric over [from, to). Passenger drives are excluded everywhere. */
export function aggregate(input: Pick<StatsInput, 'trips' | 'walks'>, metric: StatMetric, range: TimeRange): number | null {
  if (metric === 'walks') {
    let m = 0;
    for (const w of input.walks) if (w.startedAt >= range.from && w.startedAt < range.to) m += w.distanceM;
    return Math.round(m / 100) / 10;
  }
  const trips = input.trips.filter((t) => !t.passenger && t.startedAt >= range.from && t.startedAt < range.to);
  switch (metric) {
    case 'distance':
      return Math.round(trips.reduce((s, t) => s + t.distanceM, 0) / 100) / 10;
    case 'driveTime':
      return Math.round(trips.reduce((s, t) => s + t.durationS, 0) / 60);
    case 'topSpeed':
      return trips.reduce((m, t) => Math.max(m, t.topSpeedKph), 0);
    case 'events':
      return trips.reduce((s, t) => s + Object.values(t.events).reduce<number>((a, n) => a + (n ?? 0), 0), 0);
    case 'score': {
      const sc = trips.filter((t) => t.score !== null);
      const w = sc.reduce((s, t) => s + t.distanceM, 0);
      return w > 0 ? Math.round(sc.reduce((s, t) => s + t.score! * t.distanceM, 0) / w) : null;
    }
  }
}

/** Day buckets for ranges up to ~2 months, Monday-aligned week buckets (clipped to the range) beyond. */
export function bucketize(input: Pick<StatsInput, 'trips' | 'walks'>, metric: StatMetric, range: TimeRange, now: number, tz: number): Bucket[] {
  const days = Math.round((range.to - range.from) / DAY);
  const out: Bucket[] = [];
  const push = (start: number, end: number) => {
    const future = start > now;
    out.push({ start, end, future, value: future ? null : aggregate(input, metric, { from: start, to: end }) });
  };
  if (days <= 62) {
    for (let t = range.from; t < range.to; t += DAY) push(t, Math.min(t + DAY, range.to));
  } else {
    let t = range.from;
    while (t < range.to) {
      const next = Math.min(weekStart(t, tz) + 7 * DAY, range.to);
      push(t, next);
      t = next;
    }
  }
  return out;
}

export interface Comparison {
  current: number | null;
  previous: number | null;
  delta: number | null;
  /** Relative change in %, null when the previous value is 0/missing. */
  pct: number | null;
  direction: 'up' | 'down' | 'flat';
  /** Whether the change is an improvement for this metric (events: fewer is better). */
  good: boolean | null;
}

export function compare(metric: StatMetric, current: number | null, previous: number | null): Comparison {
  if (current === null || previous === null) return { current, previous, delta: null, pct: null, direction: 'flat', good: null };
  const delta = Math.round((current - previous) * 10) / 10;
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const pct = previous !== 0 ? Math.round(((current - previous) / Math.abs(previous)) * 100) : null;
  const good = direction === 'flat' ? null : higherIsBetter(metric) === (direction === 'up');
  return { current, previous, delta, pct, direction, good };
}

export interface MetricReport {
  range: TimeRange;
  previousRange: TimeRange;
  buckets: Bucket[];
  previousBuckets: Bucket[];
  comparison: Comparison;
}

export function metricReport(input: Pick<StatsInput, 'trips' | 'walks'>, metric: StatMetric, kind: RangeKind, range: TimeRange, now: number, tz: number): MetricReport {
  const prev = previousRange(kind, range, now, tz);
  return {
    range,
    previousRange: prev,
    buckets: bucketize(input, metric, range, now, tz),
    previousBuckets: bucketize(input, metric, prev, now, tz),
    comparison: compare(metric, aggregate(input, metric, { from: range.from, to: Math.min(range.to, Math.max(now + 1, range.from)) }), aggregate(input, metric, prev)),
  };
}

// --- Badge progress ----------------------------------------------------------------------------------------------------

export interface BadgeProgress {
  id: BadgeId;
  current: number;
  target: number;
  done: boolean;
  unit: 'trips' | 'km' | 'cities' | 'days';
}

/** Progress towards each badge, using the same all-time rules as `badgesFor` (pass all-time stats). */
export function badgeProgress(id: BadgeId, input: StatsInput, all: Pick<Stats, 'drivenKm' | 'walkedKm' | 'activeStreakDays'>, tz: number): BadgeProgress {
  const trips = input.trips.filter((t) => !t.passenger);
  const mk = (current: number, target: number, unit: BadgeProgress['unit']): BadgeProgress => ({ id, current: Math.min(target, Math.round(current * 10) / 10), target, done: current >= target, unit });
  switch (id) {
    case 'smoothOperator':
      return mk(trips.filter((t) => (t.score ?? 0) >= 95).length, 5, 'trips');
    case 'nightOwl':
      return mk(trips.filter((t) => (t.events.lateNight ?? 0) > 0).length, 3, 'trips');
    case 'roadWarrior':
      return mk(all.drivenKm, 500, 'km');
    case 'explorer':
      return mk(new Set(input.visits.map((v) => v.city).filter(Boolean)).size, 10, 'cities');
    case 'earlyBird':
      return mk(
        trips.some((t) => {
          const h = new Date(t.startedAt + tz * 60_000).getUTCHours();
          return h >= 4 && h < 6;
        })
          ? 1
          : 0,
        1,
        'trips',
      );
    case 'weekStreak':
      return mk(all.activeStreakDays, 7, 'days');
    case 'featherFoot': {
      let n = 0;
      for (const t of [...trips].sort((a, b) => b.startedAt - a.startedAt)) {
        if ((t.events.hardBrake ?? 0) > 0) break;
        n++;
      }
      return mk(n, 20, 'trips');
    }
    case 'walker':
      return mk(all.walkedKm, 50, 'km');
  }
}
