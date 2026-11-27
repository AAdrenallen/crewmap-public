import { describe, expect, it } from 'vitest';
import {
  detectStops,
  expectedStopS,
  INSIGHT,
  learnStopDelays,
  leaveBy,
  mergeRoughness,
  potholeCandidates,
  roughnessCells,
  type PastTrip,
} from '../src/insight';
import type { ImuSample, LocationSample } from '../src/driving/types';

// Olympic Stadium, Montréal (public landmark).
const ORIGIN = { lat: 45.558, lng: -73.552 };

function drive(speed: number, seconds: number, startT = 0): LocationSample[] {
  return Array.from({ length: seconds }, (_, i) => ({
    t: startT + i * 1000,
    lat: ORIGIN.lat,
    lng: ORIGIN.lng + (i * speed) / 78_000,
    speed,
    heading: 90,
    accuracy: 5,
  }));
}

const imu = (seconds: number, mag: (i: number) => number, hz = 10): ImuSample[] =>
  Array.from({ length: seconds * hz }, (_, i) => ({ t: (i * 1000) / hz, magnitude: mag(i) }));

describe('road roughness', () => {
  it('scores a shaky road above a smooth one and ignores slow driving', () => {
    const smooth = roughnessCells(drive(15, 20), imu(20, () => 0.5));
    const rough = roughnessCells(drive(15, 20), imu(20, () => 2.5));
    expect(smooth.length).toBeGreaterThan(0);
    expect(Math.max(...smooth.map((c) => c.index))).toBeLessThan(INSIGHT.roughness.roughIndex);
    expect(Math.min(...rough.map((c) => c.index))).toBeGreaterThan(INSIGHT.roughness.roughIndex);
    expect(roughnessCells(drive(3, 20), imu(20, () => 2.5))).toEqual([]);
  });

  it('normalises for speed: the same shaking at highway speed is a smoother road', () => {
    const slow = roughnessCells(drive(10, 30), imu(30, () => 2))[0]!;
    const fast = roughnessCells(drive(30, 30), imu(30, () => 2))[0]!;
    expect(fast.index).toBeLessThan(slow.index);
  });

  it('suggests a pothole only when two drivers hit a spike in the same cell', () => {
    const spike = (i: number) => (i === 5 ? 9 : 0.5);
    const a = roughnessCells(drive(15, 3), imu(3, spike));
    const b = roughnessCells(drive(15, 3), imu(3, spike));
    expect(potholeCandidates(mergeRoughness({ a }))).toEqual([]);
    const merged = potholeCandidates(mergeRoughness({ a, b }));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.spikeDrivers).toBe(2);
  });
});

describe('learned stop delays', () => {
  const stopAt = (startT: number, waitS: number): LocationSample[] => [
    ...drive(12, 5, startT),
    ...drive(0, waitS, startT + 5000),
    ...drive(12, 3, startT + 5000 + waitS * 1000),
  ];

  it('detects stops between 5 and 180 s and skips the final park', () => {
    const s = [...stopAt(0, 40), ...drive(0, 300, 100_000)];
    const stops = detectStops(s);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.waitS).toBeCloseTo(40, 0);
  });

  it('gives the median wait per spot and hour band once there are enough stops', () => {
    const hourOf = () => 8;
    const stops = [30, 45, 60].flatMap((w, k) => detectStops(stopAt(k * 1_000_000, w)));
    const model = learnStopDelays(stops.slice(0, 2), hourOf);
    expect(expectedStopS(model, ORIGIN, 0, hourOf)).toBeNull();
    const full = learnStopDelays(stops, hourOf);
    expect(expectedStopS(full, ORIGIN, 0, hourOf)).toBeCloseTo(45, 0);
    expect(expectedStopS(full, ORIGIN, 0, () => 17)).toBeNull();
  });
});

describe('leave by', () => {
  // Tuesday 2026-11-24 08:00 local, plus whole days.
  const at = (dayOffset: number, h: number, m = 0) => new Date(2026, 10, 24 + dayOffset, h, m).getTime();
  const trip = (dayOffset: number, h: number, min: number): PastTrip => ({
    fromPlace: 'home',
    toPlace: 'work',
    startT: at(dayOffset, h),
    durationS: min * 60,
  });

  it('plans for the slow 80th percentile of comparable weekday trips', () => {
    const trips = [trip(-7, 8, 30), trip(-6, 8, 32), trip(-5, 8, 35), trip(-4, 8, 50), trip(-1, 8, 31), trip(-2, 20, 15)];
    const r = leaveBy(trips, 'home', 'work', at(0, 9))!;
    expect(r.trips).toBe(5);
    expect(r.plannedS).toBe(35 * 60);
    expect(r.leaveAt).toBe(at(0, 9) - (35 * 60 + INSIGHT.leaveBy.bufferS) * 1000);
  });

  it('returns null without enough history', () => {
    expect(leaveBy([trip(-7, 8, 30), trip(-6, 8, 30)], 'home', 'work', at(0, 9))).toBeNull();
    expect(leaveBy([trip(-7, 8, 30), trip(-6, 8, 30), trip(-5, 8, 30)], 'home', 'gym', at(0, 9))).toBeNull();
  });
});
