import { describe, expect, it } from 'vitest';
import { ALL_VISIBLE, CATEGORIES, DEFAULT_VISIBILITY, LEADER, aggCurrent, aggregateFor, homeTransitions, rankCategory, restrictAgg, visAllows, type StatsAgg, type TripSummary, type Visit, type WalkSummary } from '../src/stats';

const H = 3600_000;
const D = 24 * H;
const NOW = Date.UTC(2025, 0, 15, 12); // Wed
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
const walk = (at: number, m: number): WalkSummary => ({ startedAt: at, endedAt: at + 1800_000, distanceM: m, kind: 'walk' });
const visit = (t: number, placeKey: string): Visit => ({ t, placeKey, city: null });
const cat = (id: string) => CATEGORIES.find((c) => c.id === id)!;

describe('aggregateFor', () => {
  it('month totals split drives from walks and skip passenger rides', () => {
    const a = aggregateFor(
      { trips: [trip('a', NOW - D), trip('b', NOW - 2 * D, { distanceM: 25_000 }), trip('p', NOW - D, { passenger: true })], walks: [walk(NOW - D, 3_400)], visits: [] },
      'month',
      NOW,
      0,
    );
    expect(a).toMatchObject({ drives: 2, drivenKm: 35, walks: 1, walkedKm: 3.4, longestKm: 25 });
    expect(a.k).toBe(Date.UTC(2025, 0, 1));
  });

  it('rolls over on the calendar month in local time', () => {
    const tz = -300; // UTC-5
    const lastDay = Date.UTC(2025, 1, 1, 3); // 31 Jan 22:00 local
    const input = { trips: [trip('a', lastDay)], walks: [], visits: [] };
    expect(aggregateFor(input, 'month', Date.UTC(2025, 1, 1, 4), tz).drives).toBe(1);
    expect(aggregateFor(input, 'month', Date.UTC(2025, 1, 1, 6), tz).drives).toBe(0);
    expect(aggregateFor(input, 'all', Date.UTC(2025, 1, 1, 6), tz)).toMatchObject({ drives: 1, k: 0 });
  });

  it('counts night / early starts, smoothness and the no-hard-brake streak', () => {
    const day = Date.UTC(2025, 0, 14);
    const a = aggregateFor(
      {
        trips: [
          trip('n', day + 23 * H, { events: { hardBrake: 1 } }),
          trip('e', day + 5 * H),
          trip('x', day + 12 * H, { events: { cornering: 1 } }),
          trip('y', day + 13 * H),
        ],
        walks: [],
        visits: [],
      },
      'week',
      NOW,
      0,
    );
    expect(a).toMatchObject({ nightTrips: 1, earlyTrips: 1, eventsPer100: 5, noBrakeStreak: 0 });
    // 'n' (23:00) is the newest and had a hard brake.
  });

  it('weighted score and scored km', () => {
    const a = aggregateFor({ trips: [trip('a', NOW - H, { score: 80, distanceM: 30_000 }), trip('b', NOW - H, { score: 100, distanceM: 10_000 }), trip('c', NOW - H, { score: null })], walks: [], visits: [] }, 'week', NOW, 0);
    expect(a.score).toBe(85);
    expect(a.scoredKm).toBe(40);
  });
});

describe('homeTransitions', () => {
  const home = new Set(['h']);
  it('counts changes only, so drift at home is one stay', () => {
    const v = [visit(1, 'h'), visit(2, 'h'), visit(3, 'h'), visit(4, 'w'), visit(5, 'h'), visit(6, 'h'), visit(7, 'x'), visit(8, 'y')];
    expect(homeTransitions(v, home)).toEqual({ leaves: 2, returns: 1 });
  });
  it('respects the period start but uses the stay before it as context', () => {
    expect(homeTransitions([visit(1, 'h'), visit(10, 'w'), visit(20, 'h')], home, 5)).toEqual({ leaves: 1, returns: 1 });
    expect(homeTransitions([visit(1, 'h'), visit(3, 'w'), visit(20, 'h')], home, 5)).toEqual({ leaves: 0, returns: 1 });
  });
});

describe('restrictAgg', () => {
  const full: StatsAgg = { k: 1, drives: 3, drivenKm: 9, walks: 1, walkedKm: 2, longestKm: 5, score: 90, scoredKm: 9, eventsPer100: 1, nightTrips: 1, earlyTrips: 0, places: 4, homeLeaves: 2, homeReturns: 2, noBrakeStreak: 3 };
  it('default visibility hides place-derived and event fields', () => {
    const r = restrictAgg(full, visAllows(DEFAULT_VISIBILITY, true));
    expect(r.places).toBeUndefined();
    expect(r.homeLeaves).toBeUndefined();
    expect(r.eventsPer100).toBeUndefined();
    expect(r).toMatchObject({ drivenKm: 9, drives: 3, score: 90, k: 1 });
  });
  it('trips off drops counts and the longest trip', () => {
    const r = restrictAgg(full, visAllows(ALL_VISIBLE, false));
    expect(r.drives).toBeUndefined();
    expect(r.longestKm).toBeUndefined();
    expect(r.drivenKm).toBe(9);
  });
});

describe('aggCurrent', () => {
  it('drops last month after rollover, tolerates time zones', () => {
    const jan = aggregateFor({ trips: [], walks: [], visits: [] }, 'month', NOW, 0);
    expect(aggCurrent(jan, 'month', NOW, 60)).toBe(true);
    expect(aggCurrent(jan, 'month', Date.UTC(2025, 1, 3), 0)).toBe(false);
    expect(aggCurrent(undefined, 'week', NOW, 0)).toBe(false);
  });
});

describe('rankCategory', () => {
  const e = (id: string, a: Partial<StatsAgg>) => ({ id, agg: { k: 0, ...a } });
  it('top 3 plus me with my true rank; ties share a rank and break by km then id', () => {
    const entries = [e('a', { drives: 5, drivenKm: 10 }), e('b', { drives: 5, drivenKm: 20 }), e('c', { drives: 3 }), e('d', { drives: 2 }), e('me', { drives: 1 })];
    const r = rankCategory(entries, cat('drives'), 'me');
    expect(r.top.map((x) => [x.id, x.rank])).toEqual([['b', 1], ['a', 1], ['c', 3]]);
    expect(r.me).toEqual({ id: 'me', rank: 5, value: 1 });
  });
  it('me in the top 3 is not repeated; zero and missing values do not rank', () => {
    const r = rankCategory([e('me', { drives: 4 }), e('x', { drives: 0 }), e('y', {})], cat('drives'), 'me');
    expect(r.top).toHaveLength(1);
    expect(r.me).toBeNull();
  });
  it('smoothest is lower-wins and gated on distance', () => {
    const m = LEADER.minKmForQuality;
    const r = rankCategory([e('a', { eventsPer100: 0, drivenKm: m - 1 }), e('b', { eventsPer100: 3, drivenKm: m }), e('c', { eventsPer100: 1, drivenKm: m + 5 })], cat('smooth'), 'a');
    expect(r.top.map((x) => x.id)).toEqual(['c', 'b']);
    expect(r.me).toBeNull();
  });
  it('has no top-speed category', () => {
    expect(CATEGORIES.map((c) => c.id)).not.toContain('topSpeed');
  });
});
