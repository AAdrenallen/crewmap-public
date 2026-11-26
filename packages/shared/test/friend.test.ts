import { describe, expect, it } from 'vitest';
import {
  agoParts,
  appendLog,
  formatCountdown,
  nearestPlaceWithin,
  presenceKind,
  startOfDay,
  todayTimeline,
  type FriendEvent,
} from '../src/friend';

describe('friend helpers', () => {
  it('agoParts picks units', () => {
    const now = 10_000_000_000;
    expect(agoParts(now - 30_000, now)).toEqual({ unit: 'now', n: 0 });
    expect(agoParts(now - 120_000, now)).toEqual({ unit: 'min', n: 2 });
    expect(agoParts(now - 3 * 3600_000, now)).toEqual({ unit: 'h', n: 3 });
    expect(agoParts(now - 2 * 86_400_000, now)).toEqual({ unit: 'd', n: 2 });
  });
  it('presenceKind', () => {
    expect(presenceKind('automotive', 20)).toBe('driving');
    expect(presenceKind('walking', 1)).toBe('walking');
    expect(presenceKind('cycling', null)).toBe('moving');
    expect(presenceKind('unknown', 3)).toBe('moving');
    expect(presenceKind('unknown', 0.2)).toBe('still');
    expect(presenceKind('still', 5)).toBe('still');
  });
  it('nearestPlaceWithin respects radius and picks closest', () => {
    const a = { id: 'a', lat: 45.5, lng: -73.6, radiusM: 200 };
    const b = { id: 'b', lat: 45.5005, lng: -73.6, radiusM: 200 };
    expect(nearestPlaceWithin({ lat: 45.5004, lng: -73.6 }, [a, b])?.id).toBe('b');
    expect(nearestPlaceWithin({ lat: 45.6, lng: -73.6 }, [a, b])).toBeNull();
  });
  it('todayTimeline keeps today only, sorted, capped', () => {
    const now = new Date(2026, 5, 10, 15, 0).getTime();
    const mk = (t: number): FriendEvent => ({ placeId: 'p', placeName: 'P', kind: 'arrive', t });
    const yesterday = startOfDay(now) - 3600_000;
    const evs = [mk(now - 1000), mk(yesterday), mk(now - 5000)];
    const out = todayTimeline(evs, now);
    expect(out.map((e) => e.t)).toEqual([now - 5000, now - 1000]);
    expect(todayTimeline(evs, now, 1)).toHaveLength(1);
  });
  it('appendLog sorts, caps and dedupes', () => {
    const same = (a: { t: number }, b: { t: number }) => a.t === b.t;
    let l: { t: number }[] = [];
    for (const t of [3, 1, 2, 2]) l = appendLog(l, { t }, 2, same);
    expect(l.map((x) => x.t)).toEqual([2, 3]);
  });
  it('formatCountdown', () => {
    expect(formatCountdown(83_000)).toBe('1:23');
    expect(formatCountdown(500)).toBe('0:01');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

import { DRIVE_EST, driveTime, nearestWithin } from '../src/friend';

describe('drive time + proximity', () => {
  it('prefers routed time, else estimates from the straight line', () => {
    expect(driveTime(600, 5000)).toEqual({ s: 600, approx: false });
    expect(driveTime(null, 10_000)).toEqual({
      s: Math.round((10_000 * DRIVE_EST.roadFactor) / DRIVE_EST.avgMps),
      approx: true,
    });
    expect(driveTime(null, null)).toBeNull();
  });
  it('finds the closest other within range', () => {
    const me = { id: 'a', lat: 48.8584, lng: 2.2945 };
    const others = [me, { id: 'b', lat: 48.8594, lng: 2.2945 }, { id: 'c', lat: 48.87, lng: 2.3 }];
    const r = nearestWithin(me, others, 500);
    expect(r?.other.id).toBe('b');
    expect(r!.distanceM).toBeGreaterThan(100);
    expect(nearestWithin(me, others, 50)).toBeNull();
  });
});
