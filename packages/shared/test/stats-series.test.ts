import { describe, expect, it } from 'vitest';
import { aggregate, badgeProgress, badgesFor, bestTrend, bucketize, buildBoard, calendarRange, compare, computeStats, customRange, metricReport, previousRange, type TripSummary } from '../src/stats';

const TZ = 0;
const D = 86_400_000;
// Wed 2025-01-15 12:00 UTC
const NOW = Date.UTC(2025, 0, 15, 12);
const trip = (id: string, at: number, o: Partial<TripSummary> = {}): TripSummary => ({
  id,
  startedAt: at,
  endedAt: at + 600_000,
  distanceM: 10_000,
  durationS: 600,
  topSpeedKph: 90,
  avgSpeedKph: 60,
  score: 90,
  passenger: false,
  events: {},
  ...o,
});

describe('ranges', () => {
  it('calendar week is Monday-based and previous week is the one before', () => {
    const w = calendarRange('week', NOW, TZ);
    expect(w.from).toBe(Date.UTC(2025, 0, 13));
    expect(w.to - w.from).toBe(7 * D);
    expect(calendarRange('week', NOW, TZ, -1).from).toBe(Date.UTC(2025, 0, 6));
  });
  it('month and year handle offsets and year rollover', () => {
    expect(calendarRange('month', NOW, TZ, -1)).toEqual({ from: Date.UTC(2024, 11, 1), to: Date.UTC(2025, 0, 1) });
    expect(calendarRange('year', NOW, TZ)).toEqual({ from: Date.UTC(2025, 0, 1), to: Date.UTC(2026, 0, 1) });
  });
  it('custom range is inclusive of both days and normalises order', () => {
    const r = customRange(Date.UTC(2025, 0, 10, 15), Date.UTC(2025, 0, 8, 3), TZ);
    expect(r).toEqual({ from: Date.UTC(2025, 0, 8), to: Date.UTC(2025, 0, 11) });
  });
  it('previous range of a running period is truncated to the same elapsed time', () => {
    const cur = calendarRange('week', NOW, TZ);
    const prev = previousRange('week', cur, NOW, TZ);
    expect(prev.from).toBe(Date.UTC(2025, 0, 6));
    expect(prev.to - prev.from).toBe(NOW - cur.from + 1);
  });
  it('previous range of a finished period is the whole previous one; custom uses same length', () => {
    const past = calendarRange('month', NOW, TZ, -1);
    expect(previousRange('month', past, NOW, TZ)).toEqual(calendarRange('month', NOW, TZ, -2));
    const c = customRange(Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 5), TZ);
    expect(previousRange('custom', c, NOW, TZ)).toEqual({ from: Date.UTC(2024, 11, 27), to: Date.UTC(2025, 0, 1) });
  });
});

describe('aggregate / bucketize', () => {
  const trips = [
    trip('a', Date.UTC(2025, 0, 13, 8), { distanceM: 20_000, score: 80, topSpeedKph: 110, events: { hardBrake: 2 } }),
    trip('b', Date.UTC(2025, 0, 13, 18), { distanceM: 10_000, score: 100, durationS: 1200, events: { speeding: 1 } }),
    trip('c', Date.UTC(2025, 0, 15, 9), { score: null, distanceM: 5000 }),
    trip('p', Date.UTC(2025, 0, 14, 9), { passenger: true, distanceM: 99_000 }),
  ];
  const walks = [{ startedAt: Date.UTC(2025, 0, 14, 7), endedAt: Date.UTC(2025, 0, 14, 8), distanceM: 2300, kind: 'walk' as const }];
  const week = calendarRange('week', NOW, TZ);
  it('computes each metric and ignores passenger drives', () => {
    expect(aggregate({ trips, walks }, 'distance', week)).toBe(35);
    expect(aggregate({ trips, walks }, 'driveTime', week)).toBe(Math.round((600 + 1200 + 600) / 60));
    expect(aggregate({ trips, walks }, 'topSpeed', week)).toBe(110);
    expect(aggregate({ trips, walks }, 'events', week)).toBe(3);
    expect(aggregate({ trips, walks }, 'walks', week)).toBe(2.3);
    // distance-weighted: (80*20 + 100*10) / 30
    expect(aggregate({ trips, walks }, 'score', week)).toBe(87);
    expect(aggregate({ trips: [], walks }, 'score', week)).toBeNull();
  });
  it('agrees with computeStats for the same week', () => {
    const s = computeStats({ trips, walks, visits: [] }, 'week', NOW, TZ);
    expect(aggregate({ trips, walks }, 'distance', week)).toBe(s.drivenKm);
    expect(aggregate({ trips, walks }, 'score', week)).toBe(s.avgScore);
  });
  it('buckets a week by day, marks the future, and sums to the total', () => {
    const b = bucketize({ trips, walks }, 'distance', week, NOW, TZ);
    expect(b).toHaveLength(7);
    expect(b[0]!.value).toBe(30);
    expect(b[1]!.value).toBe(0);
    expect(b[2]!.value).toBe(5);
    expect(b[3]!.future).toBe(true);
    expect(b[3]!.value).toBeNull();
    expect(b.reduce((s, x) => s + (x.value ?? 0), 0)).toBe(35);
  });
  it('uses week buckets for a year, clipped to the range', () => {
    const b = bucketize({ trips, walks }, 'distance', calendarRange('year', NOW, TZ), NOW, TZ);
    expect(b[0]!.end - b[0]!.start).toBeLessThanOrEqual(7 * D);
    expect(b.length).toBeGreaterThan(50);
    expect(b.reduce((s, x) => s + (x.value ?? 0), 0)).toBeCloseTo(35, 5);
  });
  it('builds a report with a like-for-like comparison', () => {
    const r = metricReport({ trips, walks }, 'distance', 'week', week, NOW, TZ);
    expect(r.comparison.current).toBe(35);
    expect(r.comparison.previous).toBe(0);
    expect(r.comparison.pct).toBeNull();
    expect(r.comparison.direction).toBe('up');
  });
});

describe('compare', () => {
  it('flags direction and whether it is good', () => {
    expect(compare('distance', 12, 10)).toMatchObject({ delta: 2, pct: 20, direction: 'up', good: true });
    expect(compare('events', 12, 10)).toMatchObject({ direction: 'up', good: false });
    expect(compare('events', 5, 10)).toMatchObject({ direction: 'down', good: true });
    expect(compare('score', 80, 80)).toMatchObject({ direction: 'flat', good: null });
    expect(compare('score', null, 80)).toMatchObject({ delta: null, good: null });
  });
});

describe('badgeProgress', () => {
  it('is done exactly when badgesFor awards the badge', () => {
    const trips = Array.from({ length: 24 }, (_, i) => trip(`t${i}`, Date.UTC(2025, 0, 1) + i * D + 5 * 3600_000, { score: i < 6 ? 97 : 80, events: i === 3 ? { lateNight: 1 } : {} }));
    const walks = [{ startedAt: NOW, endedAt: NOW + 1000, distanceM: 60_000, kind: 'walk' as const }];
    const visits = Array.from({ length: 10 }, (_, i) => ({ t: NOW, placeKey: `p${i}`, city: `c${i}` }));
    const input = { trips, walks, visits };
    const all = computeStats(input, 'all', NOW, TZ);
    const awarded = badgesFor(input, all, TZ);
    for (const id of ['smoothOperator', 'nightOwl', 'roadWarrior', 'explorer', 'earlyBird', 'weekStreak', 'featherFoot', 'walker'] as const) {
      expect(badgeProgress(id, input, all, TZ).done, id).toBe(awarded.includes(id));
    }
  });
  it('reports partial progress and caps at the target', () => {
    const input = { trips: [trip('a', NOW, { score: 99 }), trip('b', NOW - D, { score: 99, events: { hardBrake: 1 } })], walks: [], visits: [] };
    const all = { drivenKm: 700, walkedKm: 12.5, activeStreakDays: 2 };
    expect(badgeProgress('smoothOperator', input, all, TZ)).toMatchObject({ current: 2, target: 5, done: false });
    expect(badgeProgress('roadWarrior', input, all, TZ)).toMatchObject({ current: 500, done: true });
    expect(badgeProgress('walker', input, all, TZ)).toMatchObject({ current: 12.5, target: 50 });
    expect(badgeProgress('featherFoot', input, all, TZ).current).toBe(1);
  });
});

describe('buildBoard', () => {
  const s = (v: number, trend: { score: number | null; km: number }[]) => ({ id: '', stats: { period: 'week' as const, updatedAt: 1, drivenKm: v }, trend });
  it('ranks, derives week-over-week delta and rank change, keeps non-sharers last', () => {
    const rows = buildBoard(
      [
        { ...s(50, [{ score: 80, km: 60 }, { score: 80, km: 50 }]), id: 'a' },
        { ...s(70, [{ score: 80, km: 20 }, { score: 80, km: 70 }]), id: 'b' },
        { id: 'c', stats: null },
        { id: 'd', stats: { period: 'week', updatedAt: 1, trips: 3 } },
      ],
      'drivenKm',
      'week',
    );
    expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(rows[0]).toMatchObject({ rank: 1, delta: 50, rankChange: 1, shares: true });
    expect(rows[1]).toMatchObject({ rank: 2, delta: -10, rankChange: -1 });
    expect(rows[2]).toMatchObject({ rank: null, shares: false });
    expect(rows[3]).toMatchObject({ rank: null, shares: true });
  });
  it('omits rank change outside the weekly view and for metrics without history', () => {
    const e = [{ ...s(50, [{ score: 1, km: 1 }, { score: 1, km: 2 }]), id: 'a' }];
    expect(buildBoard(e, 'drivenKm', 'month')[0]!.rankChange).toBeNull();
    expect(buildBoard(e, 'cities', 'week')[0]).toMatchObject({ rank: null, delta: null });
  });
  it('picks the longest shared trend', () => {
    const t = bestTrend({ week: { period: 'week', updatedAt: 1, scoreTrend: [{ score: 1, km: 1, weekStart: 0 }] }, all: { period: 'all', updatedAt: 1, scoreTrend: [{ score: 1, km: 1, weekStart: 0 }, { score: 2, km: 2, weekStart: 1 }] } });
    expect(t).toHaveLength(2);
    expect(bestTrend(undefined)).toBeNull();
  });
});
